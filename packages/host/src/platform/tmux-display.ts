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
};

/** tmux 3.2 has no bracketed-paste format variable. Its attachment still
 * announces this input mode; retain it even when the CSI crosses PTY chunks. */
export class TmuxInputModes {
  bracketedPaste = false;
  private partial = "";
  feed(bytes: Buffer): void {
    const text = this.partial + bytes.toString("latin1");
    for (const match of text.matchAll(/\x1b\[\?([\d;]+)([hl])/g)) {
      if (match[1]!.split(";").includes("2004")) this.bracketedPaste = match[2] === "h";
    }
    this.partial = /\x1b(?:\[(?:\?[\d;]*)?)?$/.exec(text)?.[0] ?? "";
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
  };
}
