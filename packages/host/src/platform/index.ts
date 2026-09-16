import fs from "node:fs";
import path from "node:path";
import type { HostConfig } from "../types.js";
import type { SessionBackend } from "../backends/types.js";
import { LinuxTmuxBackend } from "./linux-tmux.js";
import { directBackend } from "../backends/direct.js";
import { posixOps } from "./posix.js";
import type { ProcessOps } from "./types.js";
import { win32Ops } from "./win32.js";

export { posixOps } from "./posix.js";
export { win32Ops } from "./win32.js";
export type { ProcessIdentity, ProcessOps } from "./types.js";

/**
 * The implementation for the machine this daemon is running on, chosen once at load
 * rather than at each call site.
 */
export const platform: ProcessOps = process.platform === "win32" ? win32Ops : posixOps;

/**
 * True only if a live process with this pid exists *and* its creation time matches the
 * recorded one. Anything else — process gone, pid recycled, creation time unreadable —
 * is false, which is the safe answer for a caller about to kill it.
 */
export function identityMatches(ops: ProcessOps, pid: number, recorded: string): boolean {
  const current = ops.processIdentity(pid);
  return current !== null && current === recorded;
}

/** Backend composition stays next to platform selection; callers have no OS branches. */
export function createSessionBackend(config: HostConfig, dir: string): SessionBackend {
  if (config.sessionBackend === "tmux") {
    if (process.platform !== "linux") throw new Error("tmux session backend is Linux-only; use direct on this platform");
    return new LinuxTmuxBackend(config, dir);
  }
  const file = path.join(dir, "persistent-sessions.json");
  if (process.platform === "linux" && fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { entries?: unknown[] };
    if (!Array.isArray(raw.entries) || raw.entries.length) {
      throw new Error("Persistent sessions exist; restore tmux config and explicitly remove them before selecting direct");
    }
  }
  return directBackend(platform);
}
