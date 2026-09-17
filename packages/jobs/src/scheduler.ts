import type { DatabaseSync } from "node:sqlite";
import type { SettingsStore } from "./store.js";
import type { SourceRow, Sources } from "./sources.js";
import type { SourceConfig } from "./adapters/source.js";
import type { Discovery, DiscoveryOutcome } from "./discovery.js";
import type { SchedulerLease, TaskQueue } from "./queue.js";

export const DEFAULT_INTERVAL_MINUTES = 360;
export const MAX_SOURCES_PER_RUN = 5;
export const DEFAULT_MAX_POSTINGS_PER_RUN = 200;
const LEASE_MS = 120_000;

export type SchedulerStatus = {
  state: "disabled" | "paused" | "running" | "idle";
  reason: string;
  dispatchAvailable: boolean;
  dueSources: string[];
  nextRunAt: string | null;
};

function finishedAt(db: DatabaseSync, sourceId: string): number | null {
  const row = db.prepare(`SELECT max(finished_at) AS finished FROM search_runs WHERE source_id=? AND state IN('completed','blocked','failed') AND finished_at IS NOT NULL`)
    .get(sourceId) as Record<string, unknown> | undefined;
  const value = row?.["finished"];
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
const intervalMs = (config: SourceConfig): number => {
  const minutes = config.schedule?.intervalMinutes;
  const safe = typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 1 ? minutes : DEFAULT_INTERVAL_MINUTES;
  return safe * 60_000;
};

/** Due calculation is derived from stored run times, so a restart never stampedes. */
export function schedulerStatus(store: SettingsStore, db: DatabaseSync, now: number = Date.now()): SchedulerStatus {
  const settings = store.current().value;
  const base = { dueSources: [] as string[], nextRunAt: null as string | null };
  if (!settings.enabled) return { state: "disabled", reason: "Jobs is disabled", dispatchAvailable: false, ...base };
  if (settings.paused) return { state: "paused", reason: "Jobs is paused", dispatchAvailable: false, ...base };
  const due: string[] = [];
  let next: number | null = null;
  const rows = db.prepare("SELECT id,config_json FROM sources WHERE enabled=1").all() as Record<string, unknown>[];
  for (const row of rows) {
    const id = String(row["id"]);
    const config = JSON.parse(String(row["config_json"])) as SourceConfig;
    const last = finishedAt(db, id);
    const at = last === null ? now : last + intervalMs(config);
    if (at <= now) due.push(id);
    else if (next === null || at < next) next = at;
  }
  return {
    state: "idle",
    reason: due.length ? `${due.length} source(s) due` : "No source is due",
    dispatchAvailable: true,
    dueSources: due.sort(),
    nextRunAt: next === null ? null : new Date(next).toISOString(),
  };
}

export type CycleSummary = {
  state: "disabled" | "paused" | "ran" | "locked";
  ranAt: string;
  results: { sourceId: string; outcome?: DiscoveryOutcome; error?: string }[];
};

/**
 * Runs due sources one at a time under the shared scheduler lease. One unreachable source
 * must not stall the others, and a capped or partial scan leaves a resume checkpoint.
 */
export class DiscoveryScheduler {
  private readonly now: () => number;
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private sharedLease: (() => SchedulerLease | null) | null = null;
  constructor(private readonly deps: { store: SettingsStore; sources: Sources; discovery: Discovery; queue: TaskQueue; owner: string; now?: () => number }) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Run under a lease the worker already holds and renews, instead of acquiring and releasing
   * one per cycle. Without it (tests, a service with no worker) each cycle takes its own lease.
   */
  useLease(provider: () => SchedulerLease | null): void { this.sharedLease = provider; }

  status(): SchedulerStatus { return schedulerStatus(this.deps.store, this.deps.sources.db, this.now()); }

  /** `force` is the operator "run now" action: interval is ignored, enable/pause is not. */
  due(force = false): SourceRow[] {
    const status = this.status();
    if (!status.dispatchAvailable) return [];
    const ids = force
      ? (this.deps.sources.db.prepare("SELECT id FROM sources WHERE enabled=1 ORDER BY source_key").all() as Record<string, unknown>[]).map(row => String(row["id"]))
      : status.dueSources;
    return ids.map(id => this.deps.sources.get(id)).filter((source): source is SourceRow => source !== null);
  }

  async runOnce(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<CycleSummary> {
    const now = this.now();
    const ranAt = new Date(now).toISOString();
    const settingsRevision = this.deps.store.current().revision;
    const settings = this.deps.store.current().value;
    if (!settings.enabled) return { state: "disabled", ranAt, results: [] };
    if (settings.paused) return { state: "paused", ranAt, results: [] };
    const shared = this.sharedLease;
    const lease = shared ? shared() : this.deps.queue.acquireScheduler(this.deps.owner, LEASE_MS, now);
    if (!lease) return { state: "locked", ranAt, results: [] };
    const results: CycleSummary["results"] = [];
    try {
      for (const source of this.due(options.force === true).slice(0, MAX_SOURCES_PER_RUN)) {
        if (options.signal?.aborted) break;
        if (!shared) this.deps.queue.renewScheduler(lease, LEASE_MS, this.now());
        try {
          const outcome = await this.deps.discovery.run(source.id, {
            settingsRevision,
            cap: source.config.requests?.maxPostingsPerRun ?? DEFAULT_MAX_POSTINGS_PER_RUN,
            maxRetries: source.config.requests?.maxRetries,
            resume: true, signal: options.signal,
          });
          results.push({ sourceId: source.id, outcome });
        } catch (error) {
          // One bad source never blocks the rest of the fleet.
          results.push({ sourceId: source.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
    } finally {
      if (!shared) this.deps.queue.releaseScheduler(lease, this.now());
    }
    return { state: "ran", ranAt, results };
  }

  /** Serialised tick: an overlapping timer never starts a second cycle. */
  async tick(): Promise<CycleSummary | null> {
    if (this.running) return null;
    this.running = true;
    try { return await this.runOnce(); }
    finally { this.running = false; }
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(error => console.error("[scheduler]", error)); }, intervalMs);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = undefined; } }
}
