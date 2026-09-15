import type { IPty } from "node-pty";

/**
 * An opaque, comparable token identifying *this specific* process — its pid plus
 * something derived from its creation time.
 *
 * PIDs are recycled. A ledger entry saying "session abc was pid 4242" is not enough to
 * kill safely after a daemon crash: pid 4242 may since have been reassigned to
 * something unrelated and important. Recording the creation time at spawn and
 * requiring an exact match before killing closes that window.
 *
 * Deliberately opaque and compared with string equality only — no unit conversion, no
 * tolerance window, nothing to get subtly wrong.
 */
export type ProcessIdentity = string;

/**
 * Process lifecycle, which is the only thing that genuinely diverges between Windows
 * and POSIX: how a command is launched, how it is killed, and how "is this still the
 * process I spawned" is answered.
 *
 * The seam is here and nowhere else. Value differences — a path separator, a default
 * workspace root — stay where they are used; extracting those would trade an obvious
 * line for a file and an indirection and gain nothing. Both bugs found on Windows so
 * far were in this category, and both were invisible from Linux.
 *
 * Two properties this exists for:
 *
 * 1. **The Windows path is testable from Linux.** These are plain objects, so a test
 *    can import `win32Ops` on any OS, and `SessionLedger` takes a `ProcessOps` so its
 *    escalation state machine can be driven against a fake that ignores a kill,
 *    reports a changed identity, or throws the way node-pty does.
 * 2. **The quirks have one obvious home.** "node-pty throws if you name a signal on
 *    Windows" slipped through as an inline branch in a private method. In `win32.ts`
 *    it sits next to the comment explaining it, where someone will look for it.
 *
 * When extending this, describe the *goal* rather than the mechanism — "ensure
 * spawned children do not outlive the daemon", not "assign to a job object" — so each
 * platform can meet it its own way and no Windows concept leaks into a file with no
 * use for it. And do not let the abstraction smooth the quirks into invisibility: an
 * interface so clean that a reader cannot tell Windows needs a `cmd.exe` shim has made
 * things worse.
 */
export interface ProcessOps {
  readonly name: "posix" | "win32";

  /** The file and argv to hand node-pty for a given agent executable. */
  spawnCommand(executable: string, args: readonly string[]): { file: string; args: string[] };

  /**
   * Ask a running pty to die. `force` is the escalation step, reached after the grace
   * period when the first attempt did not take.
   */
  killPty(pty: Pick<IPty, "kill">, pid: number, force: boolean): void;

  /**
   * Terminate a process we no longer hold a pty handle for — the orphan sweeper's
   * case, a pid recovered from the ledger after a daemon crash.
   */
  killByPid(pid: number, force: boolean): void;

  /**
   * The identity token for a live process, or null if no process with that pid exists.
   * Null is also returned when the creation time cannot be determined — callers must
   * treat "unknown" as "do not kill".
   */
  processIdentity(pid: number): ProcessIdentity | null;
}
