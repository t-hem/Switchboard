import fs from "node:fs";
import path from "node:path";

import { nanoid } from "nanoid";
import * as pty from "node-pty";

import type { SessionLedger } from "./ledger.js";
import type { AgentRegistry } from "./registry.js";
import { RingBuffer } from "./ringbuffer.js";
import type { HostConfig, Session } from "./types.js";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const KILL_GRACE_MS = 3000;
const KILL_ESCALATION_MS = 2000;

export type Subscriber = {
  onData: (chunk: Buffer) => void;
  onExit: (exitCode: number) => void;
};

export type CreateOptions = {
  agent: string;
  cwd: string;
  cols?: number;
  rows?: number;
  extraArgs?: string[];
  label?: string;
};

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
  pty: pty.IPty;
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

  constructor(
    private readonly hostConfig: HostConfig,
    private readonly registry: AgentRegistry,
    private readonly ledger: SessionLedger,
  ) {}

  list(): Session[] {
    return [...this.#sessions.values()].map((r) => r.session);
  }

  get(id: string): Session | null {
    return this.#sessions.get(id)?.session ?? null;
  }

  get count(): number {
    return this.#sessions.size;
  }

  create(opts: CreateOptions): Session {
    const resolvedAgent = this.registry.resolved(opts.agent);
    if (!resolvedAgent) throw new SessionError(`unknown agent: ${opts.agent}`, 400);

    const executable = this.registry.executablePath(opts.agent);
    if (!executable) {
      throw new SessionError(`agent is not installed on this host: ${opts.agent}`, 400);
    }

    const cwd = validateCwd(opts.cwd);
    const cols = clampDimension(opts.cols, DEFAULT_COLS);
    const rows = clampDimension(opts.rows, DEFAULT_ROWS);
    const args = [...resolvedAgent.args, ...(opts.extraArgs ?? [])];

    // The same environment object the availability probe used, so an agent can never
    // report available and then fail to launch (or the reverse).
    const child = pty.spawn(executable, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: this.registry.env as Record<string, string>,
      // Unset the encoding so onData delivers raw Buffers; PTY bytes are forwarded
      // to the client verbatim and must not be decoded and re-encoded on the way.
      encoding: null,
    });

    const id = nanoid();
    const session: Session = {
      id,
      agent: opts.agent,
      cwd,
      label: opts.label?.trim() || `${path.basename(cwd)} · ${opts.agent}`,
      status: "running",
      exitCode: null,
      pid: child.pid,
      cols,
      rows,
      createdAt: Date.now(),
      lastOutputAt: Date.now(),
    };

    const runtime: SessionRuntime = {
      session,
      pty: child,
      scrollback: new RingBuffer(this.hostConfig.scrollbackBytes),
      subscribers: new Set(),
      exitWaiters: new Set(),
    };
    this.#sessions.set(id, runtime);
    this.ledger.add({ id, pid: child.pid, agent: opts.agent, cwd, startedAt: session.createdAt });

    child.onData((data) => {
      // Typed as string by node-pty, but `encoding: null` makes it a Buffer at
      // runtime. This cast is the one place that interop wart is handled.
      const chunk = data as unknown as Buffer;
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

    child.onExit(({ exitCode }) => {
      session.status = "exited";
      session.exitCode = exitCode;
      session.lastOutputAt = Date.now();
      // The ledger entry is cleared here rather than when a kill is *requested*, so a
      // process that refuses to die stays on record and is reported as an orphan.
      this.ledger.remove(id);
      for (const sub of runtime.subscribers) {
        try {
          sub.onExit(exitCode);
        } catch {
          /* ignore */
        }
      }
      for (const waiter of runtime.exitWaiters) waiter();
      runtime.exitWaiters.clear();
      console.log(`[session ${id}] ${opts.agent} exited with code ${exitCode}`);
    });

    console.log(`[session ${id}] spawned ${opts.agent} (pid ${child.pid}) in ${cwd}`);
    return session;
  }

  write(id: string, data: string): void {
    const runtime = this.#require(id);
    if (runtime.session.status !== "running") return;
    runtime.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const runtime = this.#require(id);
    if (runtime.session.status !== "running") return;
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
    if (runtime.session.status === "exited") sub.onExit(runtime.session.exitCode ?? 0);
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
    this.#sessions.delete(id);

    if (runtime.session.status === "exited") {
      this.ledger.remove(id);
      return Promise.resolve();
    }
    return this.#terminate(runtime);
  }

  async #terminate(runtime: SessionRuntime): Promise<void> {
    const id = runtime.session.id;
    // node-pty's kill() defaults to SIGHUP, which a process can legitimately ignore
    // (and agent CLIs that detach from a closing terminal do). The signal is always
    // named explicitly here.
    try {
      runtime.pty.kill("SIGTERM");
    } catch (err: unknown) {
      console.error(`[session ${id}] SIGTERM failed:`, err);
    }
    if (await this.#waitForExit(runtime, KILL_GRACE_MS)) return;

    console.log(`[session ${id}] still alive after SIGTERM; escalating to SIGKILL`);
    try {
      runtime.pty.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    if (!(await this.#waitForExit(runtime, KILL_ESCALATION_MS))) {
      console.error(`[session ${id}] pid ${runtime.session.pid} survived SIGKILL; left in the ledger`);
    }
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
   * Kill every session and wait for them to go. A daemon restart kills its sessions
   * (spec §4.2); doing it properly is what keeps a clean shutdown from leaving
   * untracked strays behind.
   */
  async shutdown(): Promise<void> {
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
