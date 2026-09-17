import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./database.js";
import { event } from "./events.js";
import { AppError, SourceError } from "./errors.js";
import type { ArtifactStore } from "./artifacts.js";
import type { Postings } from "./postings.js";
import type { Sources } from "./sources.js";
import { createSourceAdapter } from "./adapters/source.js";
import type { HttpClient } from "./net.js";
import { withRetries } from "./net.js";

/** Bounds a single run so a broken adapter paginating forever cannot spin the worker. */
export const MAX_PAGES_PER_RUN = 100;

export type DiscoveryOutcome = {
  searchRunId: string; adapterId: string; discovered: number; created: number;
  complete: boolean; responseHashes: string[]; pages: number; checkpoint: unknown | null;
};

/**
 * One discovery run for one configured source. Pages are checkpointed as they complete, so
 * a cap or rate limit pauses the scan and a later run resumes from the exact page. A
 * partial or failed scan is recorded as such and never closes postings.
 */
export class Discovery {
  constructor(readonly db: DatabaseSync, readonly sources: Sources, readonly postings: Postings,
    readonly artifacts: ArtifactStore, readonly http: HttpClient, readonly now: () => number = Date.now) {}

  /** The resume point left by the source's last blocked/partial run, if any. */
  resumeCheckpoint(sourceId: string): unknown | null {
    const row = this.db.prepare(`SELECT checkpoint_json FROM search_runs WHERE source_id=? AND state='blocked' AND checkpoint_json IS NOT NULL
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(sourceId) as Record<string, unknown> | undefined;
    if (!row) return null;
    try { return JSON.parse(String(row["checkpoint_json"])); } catch { return null; }
  }

  async run(sourceId: string, options: { settingsRevision: number; cap?: number; maxRetries?: number; resume?: boolean }): Promise<DiscoveryOutcome> {
    const source = this.sources.get(sourceId);
    if (!source) throw new AppError("source_missing", "Source not found", 404);
    if (!source.enabled) throw new AppError("source_disabled", "Enable this source before running discovery", 409);
    const adapter = createSourceAdapter(source.adapterId);
    const searchRunId = randomUUID();
    const startedAt = new Date(this.now()).toISOString();
    let checkpoint: unknown | null = options.resume ? this.resumeCheckpoint(sourceId) : null;
    const responseHashes: string[] = [];
    let discovered = 0, created = 0, pages = 0;
    transaction(this.db, () => {
      this.db.prepare(`INSERT INTO search_runs(id,source_id,settings_revision,state,checkpoint_json,created_at) VALUES(?,?,?,'running',?,?)`)
        .run(searchRunId, source.id, options.settingsRevision, checkpoint === null ? null : JSON.stringify(checkpoint), startedAt);
    });
    const maxRetries = options.maxRetries ?? source.config.requests?.maxRetries ?? 2;
    const cap = options.cap && options.cap > 0 ? options.cap : Infinity;
    try {
      let complete = false, stopReason: string | null = null;
      while (pages < MAX_PAGES_PER_RUN) {
        const remaining = cap === Infinity ? undefined : Math.max(0, cap - discovered);
        if (remaining === 0) { stopReason = "cap_reached"; break; }
        const result = await withRetries(maxRetries, attempt =>
          adapter.discover(source.config, { http: this.http, cap: remaining, checkpoint, attempt }));
        pages++;
        for (const response of result.responses) {
          responseHashes.push(this.artifacts.put(Buffer.from(response.body, "utf8"), response.contentType || "application/octet-stream", "source-response").hash);
        }
        for (const posting of result.postings) {
          if (discovered >= cap) { stopReason = "cap_reached"; break; }
          const ingested = this.postings.ingest({
            sourceId: source.id, adapterId: adapter.id, externalId: posting.externalId,
            originalUrl: posting.originalUrl, canonicalUrl: posting.canonicalUrl ?? null,
            company: posting.company, title: posting.title, location: posting.location ?? null,
            descriptionText: posting.descriptionText, descriptionHtml: posting.descriptionHtml ?? null,
            department: posting.department ?? null, employmentType: posting.employmentType ?? null,
            postedAt: posting.postedAt ?? null, provenance: "source", rawHash: responseHashes[responseHashes.length - 1] ?? null,
          });
          discovered++;
          if (ingested.created) created++;
        }
        checkpoint = result.checkpoint ?? null;
        // Persist progress before the next page: a crash mid-scan must not restart it.
        transaction(this.db, () => {
          this.db.prepare("UPDATE search_runs SET checkpoint_json=? WHERE id=?").run(checkpoint === null ? null : JSON.stringify(checkpoint), searchRunId);
        });
        if (stopReason === "cap_reached") break;
        if (checkpoint === null) { complete = result.complete; break; }
      }
      if (pages >= MAX_PAGES_PER_RUN && checkpoint !== null) stopReason = "page_limit";
      const state = complete ? "completed" : "blocked";
      transaction(this.db, () => {
        this.db.prepare("UPDATE search_runs SET state=?,checkpoint_json=?,finished_at=?,error_json=? WHERE id=?").run(
          state, checkpoint === null ? null : JSON.stringify(checkpoint), new Date(this.now()).toISOString(),
          complete ? null : JSON.stringify({ code: stopReason ?? "partial_scan", message: "Scan stopped before exhaustion; missing postings were not closed" }), searchRunId);
        event(this.db, "discovery.finished", "source", source.id, { searchRunId, complete, discovered, created, pages, stopReason }, this.now());
      });
      return { searchRunId, adapterId: adapter.id, discovered, created, complete, responseHashes, pages, checkpoint };
    } catch (error) {
      const translated = error instanceof AppError || error instanceof SourceError ? error : new Error(String(error));
      transaction(this.db, () => {
        this.db.prepare("UPDATE search_runs SET state='failed',checkpoint_json=?,finished_at=?,error_json=? WHERE id=?")
          .run(checkpoint === null ? null : JSON.stringify(checkpoint), new Date(this.now()).toISOString(),
            JSON.stringify({ code: translated instanceof SourceError ? translated.code : "discovery_failed", message: translated.message }), searchRunId);
        event(this.db, "discovery.failed", "source", source.id, { searchRunId, code: translated.name, retryable: translated instanceof SourceError ? translated.retryable : false }, this.now());
      });
      throw error;
    }
  }
}
