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

  /**
   * The orphan sweeper's kill, which has no pty handle to fall back on.
   *
   * A Windows console process cannot be asked politely to exit: `taskkill /T` without
   * `/F` exits 255 with "This process can only be terminated forcefully (with /F
   * option)", and every agent here is a console process. That refusal is the *expected*
   * outcome of the graceful attempt, not a failure worth reporting — `killOrphan`
   * treats a throw from the soft kill as terminal and returns `failed` without ever
   * escalating, which made the whole graceful path unreachable on Windows: measured on
   * Windows 10, every non-forced orphan kill reported failed while `/F` would have
   * worked. Swallowing it lets the grace poll observe the process still alive and
   * escalate, which is what actually kills it.
   *
   * The forced attempt still throws, because at that point there is no further step to
   * try and its message is the only diagnostic the operator gets. Reporting `killed`
   * remains gated on *observing* the death either way, so a swallowed error can never
   * be mistaken for success.
   */
  killByPid(pid, force) {
    try {
      killTree(pid, force);
    } catch (err: unknown) {
      if (force) throw err;
    }
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
