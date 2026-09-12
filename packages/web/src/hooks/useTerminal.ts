import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";

import { streamUrl } from "../api/client.ts";
import type { HostEntry } from "../types.ts";

export type ConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "exited"
  | "evicted"
  | "gone";

const RESIZE_DEBOUNCE_MS = 150;
const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 30_000;

export type TerminalHandle = {
  state: ConnectionState;
  exitCode: number | null;
  evictedBy: string | null;
  /** Send text to the pty — used by the mobile line-input bar and quick keys. */
  send: (data: string) => void;
  reconnect: () => void;
};

/**
 * Binds an xterm instance to a session's WebSocket.
 *
 * On every (re)connect the daemon replays the scrollback buffer, so the terminal is
 * reset first: without that, a reconnect would paint the history a second time
 * underneath the previous copy.
 */
export function useTerminal(
  entry: HostEntry | null,
  sessionId: string | null,
  container: React.RefObject<HTMLDivElement | null>,
): TerminalHandle {
  const [state, setState] = useState<ConnectionState>("connecting");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [evictedBy, setEvictedBy] = useState<string | null>(null);

  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(BACKOFF_START_MS);
  const retryTimerRef = useRef<number | null>(null);
  const closedRef = useRef(false);
  // A ref in a dependency array never re-triggers the effect, so the manual
  // reconnect has to be real state.
  const [reconnectNonce, setReconnectNonce] = useState(0);

  const send = useCallback((data: string) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "input", data }));
    }
  }, []);

  const reconnect = useCallback(() => {
    backoffRef.current = BACKOFF_START_MS;
    setEvictedBy(null);
    setReconnectNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    const host = container.current;
    if (!host || !entry || !sessionId) return;

    closedRef.current = false;
    setState("connecting");
    setExitCode(null);

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
      const socket = new WebSocket(streamUrl(entry, sessionId));
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
              setEvictedBy(msg.reason ?? "another client");
              setState("evicted");
              closedRef.current = true;
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
      inputSub.dispose();
      socketRef.current?.close();
      socketRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [entry, sessionId, container, reconnectNonce]);

  return { state, exitCode, evictedBy, send, reconnect };
}
