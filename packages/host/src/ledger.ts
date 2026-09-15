import fs from "node:fs";
import path from "node:path";

import { configDir } from "./config.js";
import { identityMatches, platform, type ProcessIdentity, type ProcessOps } from "./platform/index.js";

export const LEDGER_FILE = "sessions.json";

export type LedgerEntry = {
  id: string;
  pid: number;
  agent: string;
  cwd: string;
  startedAt: number;
  processStartTime: ProcessIdentity;
};

export type OrphanKillResult = {
  id: string;
  outcome: "killed" | "already-gone" | "pid-reused" | "unknown-session" | "failed";
  detail?: string;
};

/** How long to wait for a signal to take effect before escalating or giving up. */
export type KillTiming = { graceMs: number; escalationMs: number };
export const DEFAULT_KILL_TIMING: KillTiming = { graceMs: 3000, escalationMs: 2000 };

function isEntry(v: unknown): v is LedgerEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e["id"] === "string" &&
    typeof e["pid"] === "number" &&
    typeof e["agent"] === "string" &&
    typeof e["cwd"] === "string" &&
    typeof e["startedAt"] === "number" &&
    typeof e["processStartTime"] === "string"
  );
}

/**
 * A bookkeeping record of which pids this daemon spawned, so a crashed daemon does
 * not leave agent processes that are tedious to hunt down by hand.
 *
 * This is process bookkeeping, not session history (spec §2): it holds no scrollback,
 * no conversation, nothing about the work. Entries are added on spawn and removed the
 * moment a session exits or is killed, so in steady state the file mirrors the live
 * pty set. Only an unclean exit leaves anything behind.
 *
 * Nothing here is ever killed automatically. Survivors are surfaced to the operator,
 * who decides.
 */
export class SessionLedger {
  readonly #file: string;
  /**
   * Injected rather than imported so the escalation below can be driven against a
   * fake — one that ignores the first kill, reports a changed identity mid-poll, or
   * throws the way node-pty does on Windows. Those are the cases this code exists to
   * handle and none of them can be staged with real processes on one OS.
   */
  readonly #ops: ProcessOps;
  /** Sessions this daemon currently owns. */
  readonly #live = new Map<string, LedgerEntry>();
  /** Survivors of a previous daemon run, still running and unowned. */
  readonly #orphans = new Map<string, LedgerEntry>();

  private constructor(file: string, ops: ProcessOps) {
    this.#file = file;
    this.#ops = ops;
  }

  /**
   * Read the ledger left by the previous run and work out which of its pids are
   * genuinely still the processes we spawned. Entries that are dead — or whose pid
   * has been recycled by something else — are dropped without being touched.
   */
  static loadAndReconcile(ops: ProcessOps = platform): SessionLedger {
    const dir = configDir();
    fs.mkdirSync(dir, { recursive: true });
    const ledger = new SessionLedger(path.join(dir, LEDGER_FILE), ops);

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(ledger.#file, "utf8"));
    } catch {
      return ledger; // absent or corrupt: nothing to reconcile
    }
    if (!Array.isArray(parsed)) return ledger;

    for (const raw of parsed) {
      if (!isEntry(raw)) continue;
      if (identityMatches(ops, raw.pid, raw.processStartTime)) ledger.#orphans.set(raw.id, raw);
    }
    ledger.#persist();
    return ledger;
  }

  get orphans(): LedgerEntry[] {
    return [...this.#orphans.values()];
  }

  /** Record a freshly spawned pty. Returns the entry actually stored. */
  add(entry: Omit<LedgerEntry, "processStartTime">): LedgerEntry | null {
    const identity = this.#ops.processIdentity(entry.pid);
    // No identity means no safe way to verify this pid later, so recording it would
    // create an entry we could never act on. Better to leave it out.
    if (identity === null) return null;
    const stored: LedgerEntry = { ...entry, processStartTime: identity };
    this.#live.set(entry.id, stored);
    this.#persist();
    return stored;
  }

  remove(id: string): void {
    if (this.#live.delete(id) || this.#orphans.delete(id)) this.#persist();
  }

  /**
   * Kill an orphan, but only after re-verifying that the pid is still the same
   * process we recorded. Between daemon startup and the operator pressing the button
   * the process may have exited and its pid been reused.
   *
   * Reports "killed" only once the process is *observed* to be gone. Signalling and
   * assuming success is how the cleanup button ends up deleting the ledger entry for
   * a process that is still running — leaving exactly the untracked stray the ledger
   * exists to prevent. Agent CLIs that trap SIGTERM to clean up are precisely the
   * population this applies to, so the entry is kept whenever the kill cannot be
   * confirmed.
   */
  async killOrphan(
    id: string,
    force = false,
    timing: KillTiming = DEFAULT_KILL_TIMING,
  ): Promise<OrphanKillResult> {
    const entry = this.#orphans.get(id);
    if (!entry) return { id, outcome: "unknown-session" };

    const current = this.#ops.processIdentity(entry.pid);
    if (current === null) {
      this.#forget(id);
      return { id, outcome: "already-gone" };
    }
    if (current !== entry.processStartTime) {
      // pid recycled: whatever holds it now is not ours. Drop the entry, kill nothing.
      this.#forget(id);
      return { id, outcome: "pid-reused", detail: `pid ${entry.pid} belongs to another process` };
    }

    if (!force) {
      try {
        this.#ops.killByPid(entry.pid, false);
      } catch (err: unknown) {
        return { id, outcome: "failed", detail: err instanceof Error ? err.message : String(err) };
      }
      if (await this.#waitUntilGone(entry, timing.graceMs)) {
        this.#forget(id);
        return { id, outcome: "killed" };
      }
      console.log(`[ledger] pid ${entry.pid} ignored SIGTERM; escalating to SIGKILL`);
    }

    try {
      this.#ops.killByPid(entry.pid, true);
    } catch (err: unknown) {
      return { id, outcome: "failed", detail: err instanceof Error ? err.message : String(err) };
    }
    if (await this.#waitUntilGone(entry, timing.escalationMs)) {
      this.#forget(id);
      return { id, outcome: "killed" };
    }

    // Still there. Keep the entry: an orphan we failed to kill is exactly what this
    // file is for, and forgetting it would make it untrackable.
    console.error(`[ledger] pid ${entry.pid} survived SIGKILL; keeping its ledger entry`);
    return { id, outcome: "failed", detail: `pid ${entry.pid} is still running after SIGKILL` };
  }

  /** Poll until the pid stops being the process we recorded, or the timeout expires. */
  async #waitUntilGone(entry: LedgerEntry, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.#ops.processIdentity(entry.pid) !== entry.processStartTime) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  #forget(id: string): void {
    this.#orphans.delete(id);
    this.#persist();
  }

  async killOrphans(
    ids?: string[],
    force = false,
    timing: KillTiming = DEFAULT_KILL_TIMING,
  ): Promise<OrphanKillResult[]> {
    const targets = ids ?? [...this.#orphans.keys()];
    return Promise.all(targets.map((id) => this.killOrphan(id, force, timing)));
  }

  #persist(): void {
    const all = [...this.#orphans.values(), ...this.#live.values()];
    const tmp = `${this.#file}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, "utf8");
      fs.renameSync(tmp, this.#file);
    } catch (err: unknown) {
      // The ledger is a convenience, never a correctness requirement. A failure to
      // write it must not take a session down with it.
      console.error(`[ledger] could not write ${this.#file}:`, err);
    }
  }
}
