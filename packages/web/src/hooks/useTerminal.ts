import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";

import { probeStreamAccess, streamUrl } from "../api/client.ts";
import type { HostEntry } from "../types.ts";

export type ConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "exited"
  | "evicted"
  /** Another client holds this host's lock; retrying cannot help. */
  | "locked"
  | "gone";

const RESIZE_DEBOUNCE_MS = 150;
const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 30_000;

export type TerminalHandle = {
  state: ConnectionState;
  exitCode: number | null;
  evictedBy: string | null;
  lockedBy: string | null;
  /** Send text to the pty — used by the mobile line-input bar and quick keys. */
  send: (data: string) => void;
  reconnect: () => void;
  /** False while the viewport is scrolled up, so the live view can be offered back. */
  atBottom: boolean;
  scrollToBottom: () => void;
  /** xterm's scrollable element, once it exists — what TerminalScrollbar drives. */
  viewport: HTMLElement | null;
};

/**
 * Binds an xterm instance to a session's WebSocket.
 *
 * On every (re)connect the daemon replays the scrollback buffer, so the terminal is
 * reset first: without that, a reconnect would paint the history a second time
 * underneath the previous copy.
 */
export type TerminalOptions = {
  entry: HostEntry | null;
  sessionId: string | null;
  container: React.RefObject<HTMLDivElement | null>;
  clientId: string;
  clientLabel: string;
  onEvicted?: (reason: string) => void;
};

export function useTerminal({
  entry,
  sessionId,
  container,
  clientId,
  clientLabel,
  onEvicted,
}: TerminalOptions): TerminalHandle {
  const [state, setState] = useState<ConnectionState>("connecting");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [evictedBy, setEvictedBy] = useState<string | null>(null);
  const [lockedBy, setLockedBy] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  // State, not a ref: the scrollbar renders nothing until this exists, and xterm
  // only creates it inside the effect below — after any child has already mounted.
  const [viewport, setViewport] = useState<HTMLElement | null>(null);

  // Mirrors `atBottom` so the per-render check can bail without touching state.
  const atBottomRef = useRef(true);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(BACKOFF_START_MS);
  const retryTimerRef = useRef<number | null>(null);
  const closedRef = useRef(false);
  // A ref in a dependency array never re-triggers the effect, so the manual
  // reconnect has to be real state.
  const [reconnectNonce, setReconnectNonce] = useState(0);
  // Held in a ref so the connection effect never re-runs just because the parent
  // passed a fresh callback.
  const onEvictedRef = useRef(onEvicted);
  onEvictedRef.current = onEvicted;

  const send = useCallback((data: string) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "input", data }));
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    termRef.current?.scrollToBottom();
  }, []);

  const reconnect = useCallback(() => {
    backoffRef.current = BACKOFF_START_MS;
    setEvictedBy(null);
    setLockedBy(null);
    setReconnectNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    const host = container.current;
    if (!host || !entry || !sessionId) return;

    closedRef.current = false;
    setState("connecting");
    setExitCode(null);
    setLockedBy(null);
    atBottomRef.current = true;
    setAtBottom(true);

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      scrollback: 5000,
      allowProposedApi: true,
      theme: { background: "#0b0d10", foreground: "#e6e8eb", cursor: "#e6e8eb" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    /**
     * Give touch scrolling back to the browser.
     *
     * xterm binds `touchstart`/`touchmove` to the `.xterm` root — an *ancestor* of
     * the viewport — with `{passive: false}`, and preventDefault()s any move its own
     * 1:1 drag handled. Stopping the events at `.xterm-viewport`, which is where
     * they now land (see the `pointer-events` rule in index.css), means they never
     * reach that listener, so the browser scrolls the element itself with the
     * momentum and fling it would give any other scrollable div.
     *
     * Nothing else is needed to keep xterm in step: the viewport also registers a
     * plain `scroll` listener that syncs the buffer from `scrollTop`, so native
     * scrolling already drives it correctly.
     */
    const viewportElement = host.querySelector<HTMLElement>(".xterm-viewport");
    const stopTouch = (event: Event): void => event.stopPropagation();
    viewportElement?.addEventListener("touchstart", stopTouch);
    viewportElement?.addEventListener("touchmove", stopTouch);
    setViewport(viewportElement);

    // Scrolled up, there is no way back to the live view on a phone — no End key,
    // and output keeps arriving below. `onRender` covers new output pushing the
    // baseline down; `onScroll` covers the user moving the viewport.
    const syncAtBottom = (): void => {
      const buffer = term.buffer.active;
      const next = buffer.viewportY >= buffer.baseY;
      if (next === atBottomRef.current) return;
      atBottomRef.current = next;
      setAtBottom(next);
    };
    const scrollSub = term.onScroll(syncAtBottom);
    const renderSub = term.onRender(syncAtBottom);

    const safeFit = (): { cols: number; rows: number } | null => {
      if (!host.clientWidth || !host.clientHeight) return null;
      try {
        fit.fit();
        return { cols: term.cols, rows: term.rows };
      } catch {
        return null;
      }
    };
    safeFit();

    let resizeTimer: number | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        const size = safeFit();
        const socket = socketRef.current;
        if (size && socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "resize", ...size }));
        }
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(host);

    const inputSub = term.onData((data) => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });

    const connect = (): void => {
      if (closedRef.current) return;
      const socket = new WebSocket(streamUrl(entry, sessionId, clientId, clientLabel));
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;

      socket.onopen = () => {
        if (closedRef.current) return;
        backoffRef.current = BACKOFF_START_MS;
        setState("connected");
        // The scrollback replay that follows is the full history; clear first so a
        // reconnect repaints rather than appends.
        term.reset();
        const size = safeFit();
        if (size) socket.send(JSON.stringify({ type: "resize", ...size }));
      };

      socket.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
        if (typeof event.data === "string") {
          try {
            const msg = JSON.parse(event.data) as { type?: string; exitCode?: number; reason?: string };
            if (msg.type === "exit") {
              setExitCode(msg.exitCode ?? null);
              setState("exited");
              closedRef.current = true;
            } else if (msg.type === "evicted") {
              const reason = msg.reason ?? "another client";
              setEvictedBy(reason);
              setState("evicted");
              closedRef.current = true;
              onEvictedRef.current?.(reason);
            }
          } catch {
            /* not a control frame we understand */
          }
          return;
        }
        term.write(new Uint8Array(event.data));
      };

      socket.onclose = (event) => {
        if (closedRef.current) return;
        // 4404: the daemon no longer has this session.
        if (event.code === 4404) {
          setState("gone");
          closedRef.current = true;
          return;
        }
        setState("reconnecting");
        // Ask why, since the socket itself cannot say. Being locked out is not
        // something backing off will ever fix.
        void probeStreamAccess(entry, sessionId, clientId).then(({ locked, claimedBy }) => {
          if (closedRef.current) return;
          if (locked) {
            setLockedBy(claimedBy);
            setState("locked");
            closedRef.current = true;
            if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
            return;
          }
        });
        const delay = backoffRef.current;
        backoffRef.current = Math.min(delay * 2, BACKOFF_MAX_MS);
        retryTimerRef.current = window.setTimeout(connect, delay);
      };

      socket.onerror = () => {
        // onclose always follows; the backoff is handled there.
      };
    };

    connect();

    return () => {
      closedRef.current = true;
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      observer.disconnect();
      viewportElement?.removeEventListener("touchstart", stopTouch);
      viewportElement?.removeEventListener("touchmove", stopTouch);
      setViewport(null);
      scrollSub.dispose();
      renderSub.dispose();
      inputSub.dispose();
      socketRef.current?.close();
      socketRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [entry, sessionId, container, clientId, clientLabel, reconnectNonce]);

  return { state, exitCode, evictedBy, lockedBy, send, reconnect, atBottom, scrollToBottom, viewport };
}
