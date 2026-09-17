import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";

import { probeStreamAccess, streamUrl } from "../api/client.ts";
import type { HostEntry } from "../types.ts";
import { TerminalSnapshots, type TerminalSnapshot } from "./terminalSnapshots.ts";

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
/**
 * A line's Enter is held back at least this long, and at most this long, after the
 * line itself — see `sendLine`.
 */
const ENTER_MIN_GAP_MS = 40;
const ENTER_MAX_WAIT_MS = 250;
const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 30_000;

export type TerminalHandle = {
  state: ConnectionState;
  exitCode: number | null;
  evictedBy: string | null;
  lockedBy: string | null;
  /** Send text to the pty — used by the mobile line-input bar and quick keys. */
  send: (data: string) => void;
  /** Send a composed line and submit it. See the implementation for why it is not
   *  simply `send(line + "\r")`. */
  sendLine: (line: string) => void;
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
  const snapshotsRef = useRef<TerminalSnapshots | null>(null);
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

  // Callbacks waiting for the next output frame. Only `sendLine` uses this, to learn
  // that the agent has actually read what it was sent.
  const outputWaitersRef = useRef<(() => void)[]>([]);

  const send = useCallback((data: string) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "input", data }));
    }
  }, []);

  /**
   * Send a composed line, then submit it.
   *
   * `send(line + "\r")` does not work: it reaches the pty as one read, and a TUI that
   * reads stdin in bursts — Ink-based prompts, Claude Code's composer among them —
   * treats a multi-character read as *pasted* text and inserts the CR as a newline
   * instead of submitting. The line lands in the composer and sits there.
   *
   * Sending the Enter on a fixed 20ms timer was the first fix, and it is racy: the
   * two writes only land in separate reads if the agent happens to be scheduled in
   * between. A busy agent — mid-render, mid-turn — reads both out of the pty buffer
   * at once, and the paste is back. It survived a whole session and then failed.
   *
   * So rather than guess, wait for evidence: the agent producing output is proof it
   * has read what it was sent, since that output *is* its redraw. The floor stops
   * output that was already in flight from being mistaken for that redraw, and the
   * cap covers an agent that redraws nothing at all.
   */
  const sendLine = useCallback(
    (line: string) => {
      if (!line) {
        send("\r");
        return;
      }
      send(line);
      let fired = false;
      const fire = (): void => {
        if (fired) return;
        fired = true;
        send("\r");
      };
      window.setTimeout(() => {
        if (!fired) outputWaitersRef.current.push(fire);
      }, ENTER_MIN_GAP_MS);
      window.setTimeout(fire, ENTER_MAX_WAIT_MS);
    },
    [send],
  );

  const scrollToBottom = useCallback(() => {
    snapshotsRef.current?.latest();
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
    let disposed = false;

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
      scrollback: 50000,
      allowProposedApi: true,
      theme: { background: "#0b0d10", foreground: "#e6e8eb", cursor: "#e6e8eb" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    /**
     * Clipboard keys, and one key that must never reach the pty.
     *
     * xterm sends every Ctrl chord straight through as a control byte, which is
     * correct for a terminal and wrong for the three chords that are muscle memory
     * everywhere else. Returning false tells xterm not to handle the event, so
     * nothing is written to the pty.
     *
     * Ctrl-C keeps both meanings, the way Windows Terminal and VS Code resolve it:
     * with a selection it copies, without one it is still an interrupt. That split
     * matters — interrupting an agent mid-turn is the single most used key here.
     *
     * Ctrl-A is deliberately NOT handled. Selecting the terminal buffer with
     * `selectAll()` does not match what the chord does everywhere else in a browser:
     * the handler only runs when the terminal has focus, so the same key selected
     * the whole page the rest of the time, which is worse than either behaviour
     * alone. Left alone it sends ^A — readline's beginning-of-line, the terminal's
     * own meaning — and still selects the page when focus is elsewhere. Tried and
     * reverted 2026-09-15; drag-select plus Ctrl-C is the path that works.
     *
     * Ctrl-Z is swallowed outright. A session runs the agent directly with no shell,
     * so SIGTSTP suspends it with no job control anywhere to resume it — `fg` goes
     * to a stopped process that is not reading. The session is simply lost, which is
     * exactly what happened on 2026-09-15. There is no useful meaning to give it.
     */
    term.attachCustomKeyEventHandler((event: KeyboardEvent): boolean => {
      if (event.type !== "keydown") return true;
      if (!event.ctrlKey && !event.metaKey) return true;
      const key = event.key.toLowerCase();

      if (key === "c" && term.hasSelection()) {
        void navigator.clipboard?.writeText(term.getSelection()).catch(() => {
          /* clipboard refused; the selection is still there to copy by hand */
        });
        event.preventDefault();
        return false;
      }
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        return false;
      }
      return true;
    });

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
    const snapshots = new TerminalSnapshots(term, syncAtBottom);
    snapshotsRef.current = snapshots;
    const scrollSub = term.onScroll(() => { snapshots.scrolled(); syncAtBottom(); });
    const renderSub = term.onRender(() => { snapshots.scrolled(); syncAtBottom(); });

    // The last size this client successfully measured. Kept because a fit can fail
    // (a container with no layout yet) at exactly the moment the size is needed.
    let lastSize: { cols: number; rows: number } | null = null;

    const safeFit = (): { cols: number; rows: number } | null => {
      if (!host.clientWidth || !host.clientHeight) return null;
      try {
        // Deliberately not `fit.fit()`. That is exactly the two lines below with a
        // `_renderService.clear()` in front, and the clear is the flash: it blanks
        // the screen before every resize that changes the geometry, so collapsing
        // the sidebar wipes the terminal on the way to being wider. The resize
        // repaints from the buffer either way, so the clear buys nothing here.
        const dims = fit.proposeDimensions();
        if (dims && Number.isFinite(dims.cols) && Number.isFinite(dims.rows)) {
          if (dims.cols !== term.cols || dims.rows !== term.rows) {
            // Changing the width rewraps every wrapped line in the buffer, which
            // changes how many rows the history occupies. xterm keeps the scroll
            // *offset*, so a view that was pinned to the newest output is left
            // however many rows the rewrap added above it — the bounce, and the
            // apparent extra line break, is the newest line being pushed out of
            // view and then arriving back when output next lands.
            //
            // Re-pin in the same turn as the resize, so the two are one paint
            // rather than a jump and a correction.
            const wasAtBottom = atBottomRef.current;
            term.resize(dims.cols, dims.rows);
            if (wasAtBottom) term.scrollToBottom();
          }
        }
        lastSize = { cols: term.cols, rows: term.rows };
        return lastSize;
      } catch {
        return null;
      }
    };
    safeFit();

    /**
     * Tell the daemon how big this client's terminal is.
     *
     * The pty has one size, and it is whatever the last attached client said. So a
     * session started on a phone keeps that phone's width until something tells it
     * otherwise — which is why this has to fire reliably on *attach*, not only when
     * a window is dragged.
     *
     * Falls back to the last good measurement: on a fresh mount the container often
     * has no layout yet, `fit()` measures nothing, and sending nothing at all would
     * leave the pty at the previous device's width for the life of the session.
     */
    const sendSize = (): void => {
      const socket = socketRef.current;
      if (socket?.readyState !== WebSocket.OPEN) return;
      const size = safeFit() ?? lastSize;
      if (size) socket.send(JSON.stringify({ type: "resize", ...size }));
    };

    let resizeTimer: number | null = null;
    let resizeFrame: number | null = null;
    // The box the terminal was last fitted to.
    //
    // FitAddon blanks the screen — `_renderService.clear()` — before any resize that
    // changes the computed rows or columns, so every avoidable fit is a visible
    // flash. Two in a row, with the rows briefly spread apart between them, is one
    // fit that measured the box mid-layout followed by the one that got it right.
    // Recording what was actually fitted avoids both: measure only on a frame the
    // browser has already laid out, and only when the box really moved.
    let fittedTo = { width: host.clientWidth, height: host.clientHeight };

    const observer = new ResizeObserver(() => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(() => {
          if (disposed) return;
          if (host.clientWidth === fittedTo.width && host.clientHeight === fittedTo.height) return;
          fittedTo = { width: host.clientWidth, height: host.clientHeight };
          sendSize();
        });
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
      let snapshotHistory = "";
      const socket = new WebSocket(streamUrl(entry, sessionId, clientId, clientLabel));
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;

      socket.onopen = () => {
        if (disposed || socket !== socketRef.current || closedRef.current) return;
        backoffRef.current = BACKOFF_START_MS;
        setState("connected");
        // The scrollback replay that follows is the full history; clear first so a
        // reconnect repaints rather than appends.
        term.reset();
        snapshots.reset();
        // Adopt this client's size immediately: the pty may still be sized for
        // whichever device attached last, and a TUI redrawing at the wrong width
        // writes over the lines below it rather than simply looking narrow.
        sendSize();
        // ...and again once the browser has laid the container out. On a fresh
        // mount the measurement above can happen before the element has any size,
        // and the ResizeObserver's own first callback may already have run and been
        // discarded while this socket was still connecting.
        requestAnimationFrame(() => {
          if (!closedRef.current) sendSize();
        });
      };

      socket.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
        if (disposed || socket !== socketRef.current) return;
        if (typeof event.data === "string") {
          try {
            const msg = JSON.parse(event.data) as Partial<Omit<TerminalSnapshot, "type">> & { type?: string; exitCode?: number; reason?: string };
            if (msg.type === "snapshot") {
              if (typeof msg.history === "string") snapshotHistory = msg.history;
              snapshots.receive({ ...msg, history: snapshotHistory } as TerminalSnapshot);
              const waiters = outputWaitersRef.current.splice(0);
              for (const waiter of waiters) waiter();
            } else if (msg.type === "exit") {
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
        // Output means the agent has read what it was last sent — which is what a
        // pending Enter is waiting for.
        const waiters = outputWaitersRef.current;
        if (waiters.length > 0) {
          outputWaitersRef.current = [];
          for (const waiter of waiters) waiter();
        }
      };

      socket.onclose = (event) => {
        if (disposed || socket !== socketRef.current || closedRef.current) return;
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
      disposed = true;
      closedRef.current = true;
      outputWaitersRef.current = [];
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      observer.disconnect();
      viewportElement?.removeEventListener("touchstart", stopTouch);
      viewportElement?.removeEventListener("touchmove", stopTouch);
      setViewport(null);
      scrollSub.dispose();
      renderSub.dispose();
      inputSub.dispose();
      snapshots.dispose();
      snapshotsRef.current = null;
      socketRef.current?.close();
      socketRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [entry, sessionId, container, clientId, clientLabel, reconnectNonce]);

  return { state, exitCode, evictedBy, lockedBy, send, sendLine, reconnect, atBottom, scrollToBottom, viewport };
}
