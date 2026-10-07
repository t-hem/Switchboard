import type { Terminal } from "@xterm/xterm";

export type TerminalSnapshot = {
  type: "snapshot";
  cols: number;
  rows: number;
  history: string;
  screen: string;
  cursorX: number;
  cursorY: number;
  cursorVisible: boolean;
  applicationCursor: boolean;
  bracketedPaste: boolean;
  alternateScreen: boolean;
  applicationKeypad: boolean;
  /** Mouse-reporting modes the session's application asked for. Optional: a
   * daemon older than this field never sends it, and the client then simply
   * has no mouse path — the same behavior it had before.
   *
   * These are deliberately NOT replayed into the terminal: entering mouse
   * reporting is what makes xterm.js switch off its selection service
   * entirely, which is how drag-to-copy to the viewing machine's clipboard
   * was lost. The mouse-aware TUIs instead get wheel and click as synthetic
   * SGR reports from the renderer's callers, which leaves selection alone. */
  mouseModes?: number[];
  /** The session's clipboard as of its most recent copy (OSC 52 forwarded by
   * the host). Metadata only — the renderer never paints it. `seq` advances
   * with each new copy so a client can tell a new copy from a resent one. */
  clipboard?: { seq: number; text: string };
};

/** SGR wheel reports for `count` signed notches at a position: 64 is wheel
 * up, 65 wheel down. Extracted so the byte-exact report can be pinned by
 * tests, and shared by the touch and wheel bridges. */
export function sgrWheelReports(count: number, col: number, row: number): string {
  const button = count > 0 ? 65 : 64;
  let report = "";
  for (let i = 0; i < Math.abs(count); i++) report += `\x1b[<${button};${col};${row}M`;
  return report;
}

/** Wheel notches from a pixel delta: three rows per notch, the step a local
 * terminal takes, and never zero — a wheel that scrolled must scroll
 * something. */
export function wheelNotches(deltaY: number, rowHeight: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0 || !(rowHeight > 0)) return 0;
  const step = Math.max(1, rowHeight * 3);
  const count = Math.max(1, Math.trunc(Math.abs(deltaY) / step));
  return deltaY > 0 ? count : -count;
}

/** A complete display can replace an older pending display; raw PTY commands cannot.
 * Keep a reader's buffer unchanged until they return to the bottom. This also
 * protects selection and touch momentum from agents that rebuild their history.
 */
export class TerminalSnapshots {
  private pending: TerminalSnapshot | null = null;
  private writing = false;
  private disposed = false;
  private following = true;
  private painted: TerminalSnapshot | null = null;
  /** The mouse modes of the most recently received frame. Read by the input
   * bridges to decide whether an event belongs to the application. */
  private modes: number[] = [];
  active = false;

  constructor(private readonly term: Terminal, private readonly onPaint: () => void) {}

  receive(frame: TerminalSnapshot): void {
    this.active = true;
    this.pending = frame;
    this.modes = frame.mouseModes ?? [];
    // Native viewport scrolling suppresses xterm's onScroll notification.
    // Read the buffer here too, before an incoming frame can overwrite it.
    if (!this.writing) this.following = this.term.buffer.active.viewportY >= this.term.buffer.active.baseY;
    this.paint();
  }

  scrolled(): void {
    if (this.writing) return;
    this.following = this.term.buffer.active.viewportY >= this.term.buffer.active.baseY;
    if (this.following) this.paint();
  }

  latest(): void {
    this.following = true;
    this.term.clearSelection();
    this.term.scrollToBottom();
    this.paint();
  }

  /**
   * Clear every cached frame and return the terminal to a pre-session state.
   * Nothing has to be unwritten here: mouse-reporting modes are never fed
   * into the terminal in the first place, so a reconnect starts from the
   * same plain-selection terminal this one leaves behind.
   */
  reset(): void {
    this.pending = null;
    this.painted = null;
    this.following = true;
    this.active = false;
    this.modes = [];
  }
  /** The mouse-reporting modes of the most recently received frame. */
  get mouseModes(): number[] {
    return this.modes;
  }
  dispose(): void { this.disposed = true; this.pending = null; }

  private paint(): void {
    if (this.disposed || this.writing || !this.following || !this.pending || this.term.hasSelection()) return;
    const frame = this.pending;
    // A capture made before SIGWINCH belongs to the previous screen geometry.
    // Wait for the host's subsequent redraw instead of replaying it at a new width.
    if (frame.cols !== this.term.cols || frame.rows !== this.term.rows) return;
    this.pending = null;
    this.writing = true;
    const previous = this.painted;
    const sameHistory = previous && previous.cols === frame.cols && previous.rows === frame.rows
      && previous.alternateScreen === frame.alternateScreen && previous.history === frame.history;
    // Keyboard echo usually changes only the screen; arrows may change only the
    // cursor. Keep history cells in place instead of reparsing them on each key.
    let display = "";
    if (!sameHistory) {
      display = `\x1b[?1049${frame.alternateScreen ? "h" : "l"}\x1b[0m\x1b[2J\x1b[H\x1b[3J`
        + frame.history.replace(/\n/g, "\r\n")
        + "\x1b[0m" + frame.screen.replace(/\n/g, "\r\n");
    } else if (previous.screen !== frame.screen) {
      display = "\x1b[0m\x1b[2J\x1b[H" + frame.screen.replace(/\n/g, "\r\n");
    }
    const data = display
      + `\x1b[${frame.cursorY + 1};${frame.cursorX + 1}H`
      + `\x1b[?25${frame.cursorVisible ? "h" : "l"}`
      + `\x1b[?1${frame.applicationCursor ? "h" : "l"}`
      + (frame.applicationKeypad ? "\x1b=" : "\x1b>")
      + `\x1b[?2004${frame.bracketedPaste ? "h" : "l"}`;
    this.term.write(data, () => {
      if (this.disposed) return;
      this.painted = frame;
      this.term.scrollToBottom();
      this.writing = false;
      this.onPaint();
      this.paint();
    });
  }
}
