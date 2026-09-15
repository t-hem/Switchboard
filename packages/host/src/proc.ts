import { execFileSync } from "node:child_process";
import fs from "node:fs";

/**
 * An opaque, comparable token identifying *this specific* process — its pid plus
 * something derived from its creation time.
 *
 * PIDs are recycled. A ledger entry saying "session abc was pid 4242" is not enough
 * to kill safely after a daemon crash: pid 4242 may since have been reassigned to
 * something unrelated and important. Recording the creation time at spawn and
 * requiring an exact match before killing closes that window.
 *
 * The token is deliberately opaque and compared with string equality only — no unit
 * conversion, no tolerance window, nothing to get subtly wrong.
 */
export type ProcessIdentity = string;

function linuxIdentity(pid: number): ProcessIdentity | null {
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  // Field 2 (comm) is parenthesised and may itself contain spaces and parens, so
  // fields are counted from after the final ')'. starttime is field 22, i.e. index 19
  // of what follows, since the remainder starts at field 3.
  const close = stat.lastIndexOf(")");
  if (close === -1) return null;
  const fields = stat.slice(close + 2).split(" ");
  const starttime = fields[19];
  if (starttime === undefined) return null;

  // starttime is measured in clock ticks since boot, so it is only meaningful
  // alongside the boot time — which also makes the token differ across reboots.
  let btime = "0";
  try {
    const match = /^btime (\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"));
    if (match?.[1]) btime = match[1];
  } catch {
    /* /proc/stat unreadable; starttime alone still distinguishes within a boot */
  }
  return `linux:${btime}:${starttime}`;
}

function windowsIdentity(pid: number): ProcessIdentity | null {
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
}

function posixIdentity(pid: number): ProcessIdentity | null {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    return out ? `posix:${out}` : null;
  } catch {
    return null;
  }
}

/**
 * The identity token for a live process, or null if no process with that pid exists.
 * Null is also returned when the creation time cannot be determined — callers must
 * treat "unknown" as "do not kill".
 */
export function processIdentity(pid: number): ProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") return linuxIdentity(pid);
  if (process.platform === "win32") return windowsIdentity(pid);
  return posixIdentity(pid);
}

/**
 * True only if a live process with this pid exists *and* its creation time matches
 * the recorded one. Anything else — process gone, pid recycled, creation time
 * unreadable — is false, which is the safe answer for a caller about to kill it.
 */
export function identityMatches(pid: number, recorded: ProcessIdentity): boolean {
  const current = processIdentity(pid);
  return current !== null && current === recorded;
}

/**
 * Terminate a Windows process *and its children*, which a bare kill leaves running.
 *
 * Exported unconditionally rather than hidden behind a platform check so the Windows
 * pty path can name it directly — see ptyplatform.ts. Calling it on a non-Windows
 * machine throws (there is no taskkill), which is the honest outcome and what its
 * callers there are written to expect.
 */
export function killProcessTreeWindows(pid: number, force: boolean): void {
  execFileSync("taskkill", force ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/T"], {
    timeout: 5000,
    windowsHide: true,
    stdio: "ignore",
  });
}

/**
 * Terminate a process we no longer hold a pty handle for, on whichever platform this
 * is. The orphan sweeper's case: a pid recovered from the ledger with no pty attached.
 */
export function killByPid(pid: number, force: boolean): void {
  if (process.platform === "win32") {
    killProcessTreeWindows(pid, force);
    return;
  }
  process.kill(pid, force ? "SIGKILL" : "SIGTERM");
}
