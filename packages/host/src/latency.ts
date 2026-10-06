/**
 * Latency diagnostics for the typing-stall investigation (2026-10).
 *
 * Symptom: typing in the web client intermittently stalls, then catches up all
 * at once. The candidate causes have different signatures, and each leaves a
 * different line in this daemon's stdout:
 *
 *  - the tmux backend's reconciliation poll runs synchronous `execFileSync`
 *    tmux/systemctl calls on the main thread, so one slow subprocess freezes
 *    input and output on *every* session at once — and the same blockage shows
 *    here as a late timer;
 *  - a snapshot capture spawns a tmux subprocess per repaint, and a slow one
 *    adds directly to keystroke latency without blocking anything else;
 *  - a slow client link shows up as a growing socket backlog while the daemon
 *    itself stays quiet.
 *
 * Everything here is threshold-gated `console.log` (spec §2: no log files, no
 * logging library): silent in a healthy fleet, one line per stall otherwise.
 */

/** Blocking the main thread this long stalls typing on every session at once. */
const EVENT_LOOP_BLOCK_MS = 200;
const EVENT_LOOP_CHECK_MS = 500;

/**
 * Watch the event loop itself rather than any particular call site. A repeating
 * timer that fires late by more than the threshold proves the main thread was
 * busy — a synchronous subprocess, a synchronous registry write, GC — and
 * measures the wall-clock block even when no instrumented operation is guilty.
 */
export function startEventLoopLagMonitor(thresholdMs = EVENT_LOOP_BLOCK_MS): () => void {
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const late = now - last - EVENT_LOOP_CHECK_MS;
    last = now;
    if (late >= thresholdMs) {
      console.log(
        `[lag] event loop blocked for ${Math.round(late)}ms — input and output on every session stalled; a slow-op line around this timestamp names the culprit, its absence points at GC`,
      );
    }
  }, EVENT_LOOP_CHECK_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Log an asynchronous operation that took longer than it should. Unlike the
 * monitor above this does not block the daemon; it just adds latency a client
 * can feel, so the two message shapes are kept distinct on purpose.
 */
export function logSlowAsync(op: string, startedAt: number, thresholdMs: number, detail?: string): void {
  const ms = performance.now() - startedAt;
  if (ms >= thresholdMs) {
    console.log(`[lag] ${op} took ${Math.round(ms)}ms${detail ? ` (${detail})` : ""}`);
  }
}
