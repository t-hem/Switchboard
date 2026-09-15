import { execFileSync } from "node:child_process";
import fs from "node:fs";

import type { ProcessIdentity, ProcessOps } from "./types.js";

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

function psIdentity(pid: number): ProcessIdentity | null {
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
 * Linux, macOS and anything else with signals and a POSIX `ps`.
 *
 * The one internal branch is `processIdentity`: Linux reads /proc directly, which is
 * cheap and exact, and everything else shells out to `ps`. That stays inside this file
 * rather than becoming a third implementation — the *behaviour* is identical, only the
 * source of the timestamp differs, and there is no macOS machine in this fleet to
 * verify a separate one against.
 */
export const posixOps: ProcessOps = {
  name: "posix",

  // Nothing to shape: the kernel executes the file directly, shebang and all.
  spawnCommand(executable, args) {
    return { file: executable, args: [...args] };
  },

  // Name the signal. node-pty defaults to SIGHUP, which a process may legitimately
  // ignore — and agent CLIs that detach from a closing terminal do exactly that.
  killPty(pty, _pid, force) {
    pty.kill(force ? "SIGKILL" : "SIGTERM");
  },

  killByPid(pid, force) {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  },

  processIdentity(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return process.platform === "linux" ? linuxIdentity(pid) : psIdentity(pid);
  },
};
