import fs from "node:fs";
import path from "node:path";

import { nanoid } from "nanoid";
import type { SessionBackend, SessionHandle } from "./backends/types.js";

import type { SessionLedger } from "./ledger.js";
import type { AgentRegistry } from "./registry.js";
import { createSessionBackend } from "./platform/index.js";
import { configDir } from "./config.js";
import { RingBuffer } from "./ringbuffer.js";
import type { HostConfig, Session } from "./types.js";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const KILL_GRACE_MS = 3000;
const KILL_ESCALATION_MS = 2000;

export type Subscriber = {
  onData: (chunk: Buffer) => void;
  onExit: (exitCode: number | null) => void;
};

export type CreateOptions = {
  agent: string;
  cwd: string;
  cols?: number;
  rows?: number;
  extraArgs?: string[];
  label?: string;
  idempotencyKey?: string;
};

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,200}$/;
/** Validated so an arbitrary caller string never becomes unbounded persisted metadata. */
export function validateIdempotencyKey(key: string): string {
  if (!IDEMPOTENCY_KEY.test(key)) throw new SessionError("idempotencyKey must be 1-200 characters of [A-Za-z0-9._:-]", 400);
  return key;
}

/** Thrown for conditions that map onto a specific HTTP status. */
export class SessionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SessionError";
  }
}

type SessionRuntime = {
  session: Session;
  pty: SessionHandle;
  scrollback: RingBuffer;
  subscribers: Set<Subscriber>;
  /** Resolved when the pty actually exits, so termination can be awaited. */
  exitWaiters: Set<() => void>;
};

function validateCwd(cwd: string): string {
  if (!cwd || typeof cwd !== "string") throw new SessionError("cwd is required", 400);
  // path.resolve keeps drive-letter paths intact on Windows and does not impose
  // POSIX separators anywhere.
  const resolved = path.resolve(cwd);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new SessionError(`cwd does not exist: ${resolved}`, 400);
  }
  if (!stat.isDirectory()) throw new SessionError(`cwd is not a directory: ${resolved}`, 400);
  return resolved;
}

function clampDimension(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(1000, Math.max(1, Math.floor(value)));
}

export class SessionManager {
  readonly #sessions = new Map<string, SessionRuntime>();
  #shuttingDown = false;

  constructor(
    private readonly hostConfig: HostConfig,
    private readonly registry: AgentRegistry,
    private readonly ledger: SessionLedger,
    private readonly backend: SessionBackend = createSessionBackend(hostConfig, configDir()),
  ) {
    for (const { session, handle } of backend.recover?.() ?? []) this.#register(session, handle);
  }

  list(): Session[] {
    for (const { session, handle } of this.backend.recover?.() ?? []) {
      if (!this.#sessions.has(session.id)) this.#register(session, handle);
    }
    return [...this.#sessions.values()].map((r) => r.session);
  }

  get(id: string): Session | null {
    return this.#sessions.get(id)?.session ?? null;
  }

  /**
   * Atomic creation lookup: refresh durable intents first, then search live sessions.
   * Synchronous on purpose — check-then-create has no await between it, so a duplicate
   * request in the same daemon cannot interleave a second spawn.
   */
  findByIdempotencyKey(key: string): Session | null {
    const wanted = validateIdempotencyKey(key);
    for (const { session, handle } of this.backend.recover?.() ?? []) {
      if (!this.#sessions.has(session.id)) this.#register(session, handle);
    }
    for (const runtime of this.#sessions.values()) {
      if (runtime.session.idempotencyKey === wanted) return runtime.session;
    }
    return null;
  }

  get count(): number {
    return this.#sessions.size;
  }

  supportsSnapshots(id: string): boolean { return !!this.#require(id).pty.snapshot; }

  snapshot(id: string) { return this.#require(id).pty.snapshot?.(); }

  create(opts: CreateOptions): Session {
    if (this.#shuttingDown) throw new SessionError("Host is shutting down", 503);
    const resolvedAgent = this.registry.resolved(opts.agent);
    if (!resolvedAgent) throw new SessionError(`unknown agent: ${opts.agent}`, 400);

    const executable = this.registry.executablePath(opts.agent);
    if (!executable) {
      throw new SessionError(`agent is not installed on this host: ${opts.agent}`, 400);
    }

    const cwd = validateCwd(opts.cwd);
    const cols = clampDimension(opts.cols, DEFAULT_COLS);
    const rows = clampDimension(opts.rows, DEFAULT_ROWS);
    const idempotencyKey = opts.idempotencyKey ? validateIdempotencyKey(opts.idempotencyKey) : null;
    // Defensive: the route checks first, but the guarantee lives here.
    if (idempotencyKey) {
      const existing = this.findByIdempotencyKey(idempotencyKey);
      if (existing) return existing;
    }

    const id = nanoid();
    const session: Session = {
      id,
      agent: opts.agent,
      cwd,
      label: opts.label?.trim() || `${path.basename(cwd)} · ${opts.agent}`,
      status: "running",
      exitCode: null,
      pid: 0,
      cols,
      rows,
      createdAt: Date.now(),
      lastOutputAt: Date.now(),
      idempotencyKey,
    };

    let child: SessionHandle;
    try {
      child = this.backend.create({
        session, executable, args: [...resolvedAgent.args, ...(opts.extraArgs ?? [])],
        env: this.registry.env as Record<string, string>,
      });
    } catch (err) {
      // A failed create can leave a durable interrupted intent. Surface it immediately.
      for (const recovered of this.backend.recover?.() ?? []) {
        if (!this.#sessions.has(recovered.session.id)) this.#register(recovered.session, recovered.handle);
      }
      throw err;
    }
    session.pid = child.pid;

    this.#register(session, child);
    console.log(`[session ${id}] spawned ${opts.agent} (pid ${child.pid}) in ${cwd}`);
    return session;
  }

  #register(session: Session, child: SessionHandle): void {
    const id = session.id;
    const runtime: SessionRuntime = {
      session,
      pty: child,
      scrollback: new RingBuffer(this.hostConfig.scrollbackBytes),
      subscribers: new Set(),
      exitWaiters: new Set(),
    };
    this.#sessions.set(id, runtime);
    if (!this.backend.persistent) this.ledger.add({ id, pid: child.pid, agent: session.agent, cwd: session.cwd, startedAt: session.createdAt });

    child.onData((data) => {
      const chunk = data;
      runtime.scrollback.append(chunk);
      session.lastOutputAt = Date.now();
      for (const sub of runtime.subscribers) {
        try {
          sub.onData(chunk);
        } catch {
          /* a broken subscriber must not stall the pty */
        }
      }
    });

    child.onExit((exitCode) => {
      session.status = "exited";
      session.exitCode = exitCode;
      session.lastOutputAt = Date.now();
      // The ledger entry is cleared here rather than when a kill is *requested*, so a
      // process that refuses to die stays on record and is reported as an orphan.
      if (!this.backend.persistent) this.ledger.remove(id);
      this.backend.save?.(session);
      for (const sub of runtime.subscribers) {
        try {
          sub.onExit(exitCode);
        } catch {
          /* ignore */
        }
      }
      for (const waiter of runtime.exitWaiters) waiter();
      runtime.exitWaiters.clear();
      console.log(`[session ${id}] ${session.agent} exited with code ${exitCode}`);
    });

  }

  write(id: string, data: string): void {
    const runtime = this.#require(id);
    if (runtime.session.status !== "running") return;
    runtime.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const runtime = this.#require(id);
    if (runtime.session.status !== "running" && !runtime.pty.snapshot) return;
    const c = clampDimension(cols, DEFAULT_COLS);
    const r = clampDimension(rows, DEFAULT_ROWS);
    if (c === runtime.session.cols && r === runtime.session.rows) return;
    try {
      runtime.pty.resize(c, r);
    } catch (err: unknown) {
      // Racing a process that is exiting; harmless.
      console.error(`[session ${id}] resize failed:`, err);
      return;
    }
    runtime.session.cols = c;
    runtime.session.rows = r;
    this.backend.save?.(runtime.session);
  }

  /**
   * Replay the scrollback to a new subscriber and then stream live. Returns an
   * unsubscribe function.
   *
   * The replay and the subscription are registered together, synchronously, so no
   * output can slip through the gap between them.
   */
  attach(id: string, sub: Subscriber): () => void {
    const runtime = this.#require(id);
    const replay = runtime.scrollback.read();
    runtime.subscribers.add(sub);
    if (replay.length > 0) sub.onData(replay);
    if (runtime.session.status === "exited") sub.onExit(runtime.session.exitCode);
    return () => {
      runtime.subscribers.delete(sub);
    };
  }

  /**
   * SIGTERM, then SIGKILL after a grace period if it is still alive.
   *
   * The returned promise settles when the process is actually gone. Callers that owe
   * an immediate HTTP response can ignore it; shutdown must await it, or the daemon
   * exits before the escalation runs and leaves the very orphans it meant to avoid.
   *
   * Throws synchronously for an unknown id, so routes can still answer 404.
   */
  kill(id: string): Promise<void> {
    const runtime = this.#require(id);
    if (runtime.session.status === "exited") {
      this.backend.forget?.(id);
      this.ledger.remove(id);
      this.#sessions.delete(id);
      return Promise.resolve();
    }
    return this.#terminate(runtime).then(() => {
      this.backend.forget?.(id);
      this.#sessions.delete(id);
    });
  }

  async #terminate(runtime: SessionRuntime): Promise<void> {
    const id = runtime.session.id;
    try {
      this.#signal(runtime, false);
    } catch (err: unknown) {
      console.error(`[session ${id}] terminate failed:`, err);
    }
    if (await this.#waitForExit(runtime, KILL_GRACE_MS)) return;

    console.log(`[session ${id}] still alive after first signal; escalating`);
    try {
      this.#signal(runtime, true);
    } catch {
      /* already gone */
    }
    if (!(await this.#waitForExit(runtime, KILL_ESCALATION_MS))) {
      runtime.session.recovery = "Termination not confirmed; session retained for retry";
      throw new Error(runtime.session.recovery);
    }
  }

  /**
   * Ask a pty to die, in the way the platform actually supports — which differs
   * enough between Windows and POSIX that it lives in platform/. `force` is the
   * escalation step, reached after the grace period when the first attempt did not
   * take.
   */
  #signal(runtime: SessionRuntime, force: boolean): void {
    runtime.pty.signal(force);
  }

  #waitForExit(runtime: SessionRuntime, ms: number): Promise<boolean> {
    if (runtime.session.status === "exited") return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        runtime.exitWaiters.delete(waiter);
        resolve(false);
      }, ms);
      const waiter = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      runtime.exitWaiters.add(waiter);
    });
  }

  /**
   * Direct backends terminate and await children. Persistent backends release only
   * attachments; the independently supervised owner retains the workload.
   */
  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    if (this.backend.persistent) {
      for (const runtime of this.#sessions.values()) runtime.pty.disconnect();
      this.backend.close?.();
      return;
    }
    await Promise.all(
      [...this.#sessions.keys()].map((id) =>
        this.kill(id).catch((err: unknown) => console.error(`[session ${id}] kill failed:`, err)),
      ),
    );
  }

  #require(id: string): SessionRuntime {
    const runtime = this.#sessions.get(id);
    if (!runtime) throw new SessionError(`unknown session: ${id}`, 404);
    return runtime;
  }
}
