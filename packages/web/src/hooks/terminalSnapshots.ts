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
   * has no mouse path — the same behavior it had before. */
  mouseModes?: number[];
};

/**
 * The DEC private sequences that move a terminal from `previous` to `next`
 * mouse-reporting modes: set what appeared, reset what disappeared. Extracted
 * from the renderer so the byte-exact replay can be pinned by tests.
 */
export function mouseModeTransitions(previous: number[], next: number[]): string {
  let data = "";
  for (const mode of next) if (!previous.includes(mode)) data += `\x1b[?${mode}h`;
  for (const mode of previous) if (!next.includes(mode)) data += `\x1b[?${mode}l`;
  return data;
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
  /** Mouse modes already fed into the terminal; frames move it incrementally. */
  private paintedMouseModes: number[] = [];
  active = false;

  constructor(private readonly term: Terminal, private readonly onPaint: () => void) {}

  receive(frame: TerminalSnapshot): void {
    this.active = true;
    this.pending = frame;
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
   * Clear every cached frame and return the terminal to a pre-session state,
   * including mouse-reporting modes replayed from an earlier connection: a
   * reconnect must not leave them on for a session that never asked, and the
   * first frame of the new stream will re-establish the ones that did.
   */
  reset(): void {
    this.pending = null;
    this.painted = null;
    this.following = true;
    this.active = false;
    if (this.paintedMouseModes.length > 0) {
      this.term.write(mouseModeTransitions(this.paintedMouseModes, []));
      this.paintedMouseModes = [];
    }
  }
  /** The mouse-reporting modes most recently replayed into the terminal. */
  get mouseModes(): number[] {
    return this.paintedMouseModes;
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
      // Replay the session's mouse-reporting modes so a mouse-aware TUI
      // receives wheel, click and drag through the normal input path: the
      // rendered frame cannot carry them, and without this the terminal never
      // learns the application is listening for the mouse.
      + mouseModeTransitions(this.paintedMouseModes, frame.mouseModes ?? [])
      + `\x1b[${frame.cursorY + 1};${frame.cursorX + 1}H`
      + `\x1b[?25${frame.cursorVisible ? "h" : "l"}`
      + `\x1b[?1${frame.applicationCursor ? "h" : "l"}`
      + (frame.applicationKeypad ? "\x1b=" : "\x1b>")
      + `\x1b[?2004${frame.bracketedPaste ? "h" : "l"}`;
    this.paintedMouseModes = frame.mouseModes ?? [];
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
