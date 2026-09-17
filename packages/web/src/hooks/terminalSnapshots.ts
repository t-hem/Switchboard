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
};

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

  reset(): void { this.pending = null; this.painted = null; this.following = true; this.active = false; }
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
