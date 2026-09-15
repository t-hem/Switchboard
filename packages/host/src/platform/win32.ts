import { execFileSync } from "node:child_process";

import type { ProcessIdentity, ProcessOps } from "./types.js";

/**
 * Terminate a Windows process *and its children*, which a bare kill leaves running.
 * Throws if taskkill is unavailable — i.e. always, off Windows — which is the honest
 * outcome and what the callers here are written to expect.
 */
function killTree(pid: number, force: boolean): void {
  execFileSync("taskkill", force ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/T"], {
    timeout: 5000,
    windowsHide: true,
    stdio: "ignore",
  });
}

export const win32Ops: ProcessOps = {
  name: "win32",

  // node-pty hands `file` straight to CreateProcess, which cannot execute batch files.
  // npm installs CLIs on Windows as .cmd shims (claude.cmd, codex.cmd), so the
  // availability probe finds them and marks the agent available, and the spawn would
  // then fail with "CreateProcess failed". Run those through the command interpreter.
  spawnCommand(executable, args) {
    if (/\.(cmd|bat)$/i.test(executable)) {
      return { file: process.env["ComSpec"] ?? "cmd.exe", args: ["/c", executable, ...args] };
    }
    return { file: executable, args: [...args] };
  },

  /**
   * node-pty *throws* if given a signal here ("Signals not supported on windows"), so
   * one must never be passed. Its bare kill() is also not enough on its own: it kills
   * the pids ConPTY reports attached to the console, in a promise it never awaits, and
   * the cmd.exe -> node.exe -> agent.exe tree the shim above creates outlives it.
   * Measured on Windows 10: three killed sessions left nine live processes, with
   * DELETE having already answered 204.
   *
   * So the tree goes down by pid with taskkill /T, which also restores the
   * terminate-then-force escalation. pty.kill() still runs afterwards to release the
   * ConPTY handles and the conout socket worker; by then it is usually a no-op, hence
   * the catch.
   */
  killPty(pty, pid, force) {
    try {
      killTree(pid, force);
    } catch {
      /* gone already, or taskkill refused; the force escalation still follows */
    }
    try {
      pty.kill();
    } catch {
      /* the pty may already have torn itself down along with the process */
    }
  },

  killByPid(pid, force) {
    killTree(pid, force);
  },

  processIdentity(pid): ProcessIdentity | null {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      const out = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.Ticks`,
        ],
        { encoding: "utf8", timeout: 5000, windowsHide: true },
      ).trim();
      return /^\d+$/.test(out) ? `win32:${out}` : null;
    } catch {
      return null;
    }
  },
};
