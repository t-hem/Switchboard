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
