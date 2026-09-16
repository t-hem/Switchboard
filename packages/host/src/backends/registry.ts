import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ProcessOps } from "../platform/types.js";
import type { Session } from "../types.js";

export type RecoveryEntry = {
  session: Session;
  backend: "tmux";
  ownerId: string;
  target: string;
  scope: string;
  phase: "starting" | "running" | "exited" | "terminating" | "unavailable";
  processIdentity: string | null;
  scopeIdentity?: string;
  error?: string;
};

type Document = { version: 1; entries: RecoveryEntry[] };

function finite(v: unknown): v is number { return typeof v === "number" && Number.isFinite(v); }
export function isRecoveryEntry(value: unknown): value is RecoveryEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  const s = e["session"] as Record<string, unknown> | undefined;
  return e["backend"] === "tmux" && typeof e["ownerId"] === "string" &&
    typeof e["target"] === "string" && /^sw-[a-zA-Z0-9_-]+$/.test(e["target"]) &&
    typeof e["scope"] === "string" && /^sw-[a-zA-Z0-9_-]+\.scope$/.test(e["scope"]) &&
    ["starting", "running", "exited", "terminating", "unavailable"].includes(String(e["phase"])) &&
    (e["processIdentity"] === null || typeof e["processIdentity"] === "string") &&
    (e["scopeIdentity"] === undefined || typeof e["scopeIdentity"] === "string") &&
    !!s && typeof s === "object" && typeof s["id"] === "string" && /^[a-zA-Z0-9_-]+$/.test(s["id"]) &&
    e["target"] === `sw-${e["ownerId"]}-${s["id"]}` && e["scope"] === `${e["target"]}.scope` &&
    typeof s["agent"] === "string" && typeof s["cwd"] === "string" && typeof s["label"] === "string" &&
    ["running", "exited"].includes(String(s["status"])) && finite(s["pid"]) &&
    finite(s["cols"]) && finite(s["rows"]) && finite(s["createdAt"]) && finite(s["lastOutputAt"]) &&
    (s["exitCode"] === null || finite(s["exitCode"]));
}

/** Ownership bookkeeping, never terminal history. Fail closed rather than forget a child. */
export class RecoveryRegistry {
  readonly #file: string;
  readonly #lock: string;
  #entries = new Map<string, RecoveryEntry>();
  #closed = false;

  constructor(dir: string, ops: ProcessOps) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.#file = path.join(dir, "persistent-sessions.json");
    this.#lock = path.join(dir, "persistent-sessions.lock");
    const identity = ops.processIdentity(process.pid);
    if (!identity) throw new Error("Cannot verify daemon identity; refusing recovery ownership");
    // A stale lock is reclaimed only when its recorded process identity is definitely different.
    // Unknown/unreadable identity requires operator inspection, never guessing.
    try { fs.mkdirSync(this.#lock, { mode: 0o700 }); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const old = JSON.parse(fs.readFileSync(path.join(this.#lock, "owner.json"), "utf8")) as { pid: number; identity: string };
      if (!Number.isInteger(old.pid) || old.pid <= 0 || typeof old.identity !== "string") throw new Error("Invalid recovery lock; inspect it manually");
      const current = ops.processIdentity(old.pid);
      if (current === old.identity) throw new Error("Another daemon owns persistent sessions");
      // On Linux /proc absence can distinguish dead from identity-read failure.
      if (current === null && fs.existsSync(`/proc/${old.pid}`)) throw new Error("Cannot verify recovery lock owner");
      // Exactly one process may retire this owner generation. A second contender
      // must not unlink a replacement lock acquired after it read the old owner.
      // Keep retirement markers: a crash during reclamation fails closed for manual
      // inspection instead of letting another contender act on stale evidence.
      const generation = createHash("sha256").update(JSON.stringify(old)).digest("hex");
      const retired = path.join(dir, "persistent-session-reclaims");
      fs.mkdirSync(retired, { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(retired, generation), { mode: 0o700 });
      fs.unlinkSync(path.join(this.#lock, "owner.json"));
      fs.rmdirSync(this.#lock);
      fs.mkdirSync(this.#lock, { mode: 0o700 }); // races fail closed
    }
    try {
      fs.writeFileSync(path.join(this.#lock, "owner.json"), JSON.stringify({ pid: process.pid, identity }), { mode: 0o600 });
      if (fs.existsSync(this.#file)) {
        const raw = JSON.parse(fs.readFileSync(this.#file, "utf8")) as Document;
        if (raw.version !== 1 || !Array.isArray(raw.entries) || !raw.entries.every(isRecoveryEntry)) {
          throw new Error("Invalid/unsupported persistent registry; preserved for operator recovery");
        }
        for (const entry of raw.entries) {
          if (this.#entries.has(entry.session.id)) throw new Error("Duplicate persistent session ID");
          this.#entries.set(entry.session.id, entry);
        }
      }
    } catch (err) { this.close(); throw err; }
  }

  list(): RecoveryEntry[] { return structuredClone([...this.#entries.values()]); }
  put(entry: RecoveryEntry): void {
    if (!isRecoveryEntry(entry)) throw new Error("Invalid persistent session metadata");
    const next = new Map(this.#entries);
    next.set(entry.session.id, structuredClone(entry));
    this.#persist(next);
  }
  remove(id: string): void {
    const next = new Map(this.#entries);
    next.delete(id);
    this.#persist(next);
  }
  #persist(next: Map<string, RecoveryEntry>): void {
    if (this.#closed) throw new Error("Registry closed");
    const tmp = `${this.#file}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ version: 1, entries: [...next.values()] }, null, 2) + "\n"); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.#file);
    const dir = fs.openSync(path.dirname(this.#file), "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    this.#entries = next;
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    fs.rmSync(path.join(this.#lock, "owner.json"), { force: true });
    fs.rmdirSync(this.#lock);
  }
}
