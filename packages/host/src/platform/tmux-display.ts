import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

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
  /**
   * The mouse-reporting DEC private modes the attachment announced on our side
   * of tmux (1000/1002/1003 press/drag/motion, 1005/1006/1015 encodings). The
   * client synthesizes its own SGR wheel and click reports from these — it
   * never replays them into its terminal, which would disable selection.
   */
  mouseModes: number[];
  /** The session's most recent copy, with a sequence number that advances per
   * OSC 52. Forwarded on frames so a copy made in the session (tmux
   * copy-mode, an application's yank) can reach the clipboard of the machine
   * viewing it. Null until the first copy. */
  clipboard?: { seq: number; text: string };
};

/**
 * The modes xterm.js implements for mouse reporting; anything else the
 * attachment announces is left alone rather than guessed at.
 */
const MOUSE_REPORTING_MODES = new Set([1000, 1002, 1003, 1005, 1006, 1015]);

/** OSC 52 — "manipulate selection data". tmux emits it when it (or a pane
 * application) copies and `set-clipboard` allows announcing the copy outward;
 * the payload is base64 text and Pc names the selection (tmux sends the empty
 * name). The payload class is base64 only, which excludes the query (`?`) and
 * empty (clear) forms on its own — neither carries text, and neither is
 * forwarded. */
const OSC_52 = /\x1b\]52;([^;\x07\x1b]*);([A-Za-z0-9+/=]+)(?:\x07|\x1b\\)/g;

/** tmux 3.2 has no bracketed-paste format variable. Its attachment still
 * announces this input mode; retain it even when the CSI crosses PTY chunks.
 * Mouse-reporting modes and clipboard copies are retained the same way: tmux
 * forwards them to this attachment because the pane application requested
 * them, and the client cannot learn them from a rendered frame.
 */
export class TmuxInputModes {
  bracketedPaste = false;
  readonly mouseModes = new Set<number>();
  #clipboard: { seq: number; text: string } | null = null;
  private partial = "";
  feed(bytes: Buffer): void {
    const text = this.partial + bytes.toString("latin1");
    for (const match of text.matchAll(/\x1b\[\?([\d;]+)([hl])/g)) {
      for (const raw of match[1]!.split(";")) {
        const mode = Number(raw);
        if (mode === 2004) this.bracketedPaste = match[2] === "h";
        else if (MOUSE_REPORTING_MODES.has(mode)) {
          if (match[2] === "h") this.mouseModes.add(mode);
          else this.mouseModes.delete(mode);
        }
      }
    }
    for (const match of text.matchAll(OSC_52)) {
      const decoded = Buffer.from(match[2]!, "base64").toString("utf8");
      this.#clipboard = { seq: (this.#clipboard?.seq ?? 0) + 1, text: decoded };
    }
    // Retain a trailing partial sequence of either kind: an unfinished CSI
    // (`ESC [ ? 2004`) or an unfinished OSC (`ESC ] 52 ; c ; QUJD`, whose
    // terminator may also split, leaving a lone trailing `ESC`). An OSC tail
    // is longer and starts earlier, so the longer tail wins when both match.
    const csi = /\x1b(?:\[(?:\?[\d;]*)?)?$/.exec(text)?.[0] ?? "";
    const osc = /\x1b\][^\x07\x1b]*(?:\x1b)?$/.exec(text)?.[0] ?? "";
    this.partial = csi.length >= osc.length ? csi : osc;
  }
  /** The latest copy, or null before the session ever copied. */
  clipboard(): { seq: number; text: string } | null {
    return this.#clipboard;
  }
}

/** Read the pane, not the attachment terminal (which has no browser scrollback).
 * Commands share one tmux command queue. History joins soft wraps so another
 * device can reflow it; the current screen keeps physical rows and cursor geometry.
 * No pane input, copy mode, or persistent capture buffer is involved.
 */
export async function captureTerminal(socket: string, target: string): Promise<TerminalSnapshot> {
  const separator = `SW-DISPLAY-${crypto.randomUUID()}`;
  const { stdout } = await exec("/usr/bin/tmux", [
    "-S", socket, "-N",
    "display-message", "-p", "-t", target,
    "#{pane_width},#{pane_height},#{cursor_x},#{cursor_y},#{cursor_flag},#{keypad_cursor_flag},#{keypad_flag},#{history_size},#{alternate_on}",
    ";", "capture-pane", "-p", "-e", "-J", "-t", target, "-S", "-", "-E", "-1",
    ";", "display-message", "-p", separator,
    ";", "capture-pane", "-p", "-e", "-t", target,
  ], { encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  const firstBreak = stdout.indexOf("\n");
  const metadata = stdout.slice(0, firstBreak).split(",");
  const [cols, rows, cursorX, cursorY] = metadata.slice(0, 4).map(Number);
  const boundary = stdout.indexOf(`${separator}\n`, firstBreak + 1);
  if (!cols || !rows || boundary < 0 || !Number.isFinite(cursorX) || !Number.isFinite(cursorY)) {
    throw new Error("Invalid tmux display capture");
  }
  return {
    type: "snapshot", cols, rows, cursorX: cursorX!, cursorY: cursorY!,
    // With no history, -E -1 may capture a screen line. Never duplicate it.
    history: Number(metadata[7]) > 0 && metadata[8] !== "1"
      ? stdout.slice(firstBreak + 1, boundary) : "",
    screen: stdout.slice(boundary + separator.length + 1).replace(/\n$/, ""),
    cursorVisible: metadata[4] === "1",
    applicationCursor: metadata[5] === "1",
    bracketedPaste: false,
    applicationKeypad: metadata[6] === "1",
    alternateScreen: metadata[8] === "1",
    // A capture cannot see input modes; the handle supplies the live ones.
    mouseModes: [],
  };
}
