import { event } from "./events.js";
import { isReadOnly } from "./health.js";
import type { SchedulerLease } from "./queue.js";
import { TAILORING_KINDS } from "./runner.js";
import type { Services } from "./services.js";

/**
 * The service's single background worker. It holds the one scheduler lease and renews it,
 * so discovery and task execution run under one owner. On acquiring a new lease generation it
 * blocks every task a previous worker was running; each tick it reconciles those tasks' agent
 * children, claims one queued task at a time (claims are refused while jobs are disabled or
 * paused), and runs discovery on its own interval.
 *
 * Stopping never kills an agent: a running child is left for the next start to reattach.
 */
export class JobsWorker {
  private lease: SchedulerLease | null = null;
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private tickSettled: Promise<void> = Promise.resolve();
  private active: Promise<unknown> | null = null;
  private discovery: Promise<unknown> | null = null;
  private lastDiscovery = 0;
  private readonly stopping = new AbortController();
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly taskLeaseMs: number;
  private readonly discoveryMs: number;

  constructor(private readonly services: Services, private readonly options: { owner: string; leaseMs?: number; taskLeaseMs?: number; discoveryIntervalMs?: number }) {
    this.now = services.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.taskLeaseMs = options.taskLeaseMs ?? 60_000;
    this.discoveryMs = options.discoveryIntervalMs ?? 60_000;
    services.scheduler.useLease(() => this.currentLease());
  }

  /** The scheduler lease this worker holds, if it is still unexpired. */
  currentLease(): SchedulerLease | null {
    return this.lease && this.lease.expiresAt > this.now() ? this.lease : null;
  }

  start(intervalMs = 2000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(error => console.error("[worker]", error)); }, intervalMs);
    this.timer.unref?.();
    void this.tick().catch(error => console.error("[worker]", error));
  }

  /** One pass. Serialized: an overlapping timer never starts a second pass. */
  async tick(): Promise<void> {
    if (this.ticking || this.stopping.signal.aborted) return;
    this.ticking = true;
    let settleTick!: () => void;
    this.tickSettled = new Promise(resolve => { settleTick = resolve; });
    try {
      // A restored archive is inspectable only: no lease is taken and nothing is recovered,
      // reconciled, retried or dispatched.
      if (isReadOnly(this.services.dir)) return;
      if (!this.#holdLease()) return;
      await this.#reconcile();
      if (this.stopping.signal.aborted || !this.#holdLease()) return;
      if (!this.active) {
        const claimed = this.services.queue.claim(this.lease!, this.taskLeaseMs, this.now());
        if (claimed) this.active = this.#run(claimed).finally(() => { this.active = null; });
      }
      if (!this.discovery && this.now() - this.lastDiscovery >= this.discoveryMs) {
        this.lastDiscovery = this.now();
        this.discovery = this.services.scheduler.runOnce({ signal: this.stopping.signal })
          .catch(error => console.error("[discovery]", error))
          .finally(() => { this.discovery = null; });
      }
    } finally { this.ticking = false; settleTick(); }
  }

  /** Test seam: resolves once the task and discovery cycle in flight have settled. */
  async idle(): Promise<void> { await Promise.all([this.active, this.discovery]); }

  /**
   * Stops ticking, lets the task in flight abandon its child to recovery and the discovery
   * cycle stop between pages, then releases the lease. The database stays open until then.
   */
  async stop(): Promise<void> {
    this.stopping.abort();
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    await this.tickSettled;
    await this.idle();
    if (this.lease) {
      try { this.services.queue.releaseScheduler(this.lease, this.now()); } catch { /* already expired or taken */ }
      this.lease = null;
    }
  }

  #holdLease(): boolean {
    const { queue, db } = this.services;
    if (this.lease) {
      try { this.lease = queue.renewScheduler(this.lease, this.leaseMs, this.now()); return true; }
      catch { this.lease = null; } // stalled past expiry; try to take it again below
    }
    const acquired = queue.acquireScheduler(this.options.owner, this.leaseMs, this.now());
    if (!acquired) return false;
    this.lease = acquired;
    // Everything a previous owner was running is now blocked, never silently resumed.
    const recovered = queue.recoverExpired(acquired, this.now());
    if (recovered.length) event(db, "worker.recovered", "worker", this.options.owner, { generation: acquired.generation, tasks: recovered }, this.now());
    return true;
  }

  /** Reconciles tailoring tasks that recovery blocked; other blocked work waits for the operator. */
  async #reconcile(): Promise<void> {
    const runner = this.services.tailoring();
    if (!runner) return;
    const rows = this.services.db.prepare(`SELECT id FROM tasks WHERE state='blocked' AND kind IN (${TAILORING_KINDS.map(() => "?").join(",")})
      AND json_extract(error_json,'$.code')='reconciliation_required' ORDER BY updated_at LIMIT 10`).all(...TAILORING_KINDS) as Record<string, unknown>[];
    for (const row of rows) {
      if (this.stopping.signal.aborted) return;
      try { await runner.reconcile(String(row["id"]), () => {
        this.stopping.signal.throwIfAborted();
        this.lease = this.services.queue.renewScheduler(this.lease!, this.leaseMs, this.now());
      }); }
      catch (error) { console.error("[worker] reconcile", error); }
    }
  }

  async #run(claimed: NonNullable<ReturnType<Services["queue"]["claim"]>>): Promise<void> {
    const { queue, db } = this.services;
    const lease = claimed.lease;
    if (!TAILORING_KINDS.includes(claimed.task.kind)) {
      queue.fail(lease, { code: "unknown_task_kind", message: `No worker handles ${claimed.task.kind}` }, this.now());
      return;
    }
    const runner = this.services.tailoring();
    if (!runner) {
      queue.fail(lease, { code: "spawner_unconfigured", message: "A host token is not configured in service.json; tailoring cannot spawn" }, this.now());
      return;
    }
    const outcome = await runner.runClaimed(claimed, {
      signal: this.stopping.signal,
      heartbeat: () => queue.heartbeat(lease, this.taskLeaseMs, this.now()),
    });
    if (outcome.state === "failed") event(db, "worker.task_failed", "task", claimed.task.id, { error: outcome.error ?? null }, this.now());
  }
}
