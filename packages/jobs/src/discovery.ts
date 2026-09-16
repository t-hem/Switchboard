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

export type DiscoveryOutcome = {
  searchRunId: string; adapterId: string; discovered: number; created: number; complete: boolean; responseHashes: string[];
};

/**
 * One discovery run for one configured source. A partial or failed scan is recorded as
 * such and never closes postings: only a completed authoritative scan can supply that.
 */
export class Discovery {
  constructor(readonly db: DatabaseSync, readonly sources: Sources, readonly postings: Postings,
    readonly artifacts: ArtifactStore, readonly http: HttpClient, readonly now: () => number = Date.now) {}

  async run(sourceId: string, options: { settingsRevision: number; cap?: number; maxRetries?: number }): Promise<DiscoveryOutcome> {
    const source = this.sources.get(sourceId);
    if (!source) throw new AppError("source_missing", "Source not found", 404);
    if (!source.enabled) throw new AppError("source_disabled", "Enable this source before running discovery", 409);
    const adapter = createSourceAdapter(source.adapterId);
    const searchRunId = randomUUID();
    const startedAt = new Date(this.now()).toISOString();
    transaction(this.db, () => {
      this.db.prepare(`INSERT INTO search_runs(id,source_id,settings_revision,state,created_at) VALUES(?,?,?,'running',?)`)
        .run(searchRunId, source.id, options.settingsRevision, startedAt);
    });
    try {
      const result = await withRetries(options.maxRetries ?? 2, () => adapter.discover(source.config, { http: this.http, cap: options.cap }));
      const responseHashes = result.responses.map(response =>
        this.artifacts.put(Buffer.from(response.body, "utf8"), response.contentType || "application/octet-stream", "source-response").hash);
      let created = 0;
      for (const posting of result.postings) {
        const ingested = this.postings.ingest({
          sourceId: source.id, adapterId: adapter.id, externalId: posting.externalId,
          originalUrl: posting.originalUrl, canonicalUrl: posting.canonicalUrl ?? null,
          company: posting.company, title: posting.title, location: posting.location ?? null,
          descriptionText: posting.descriptionText, descriptionHtml: posting.descriptionHtml ?? null,
          department: posting.department ?? null, employmentType: posting.employmentType ?? null,
          postedAt: posting.postedAt ?? null, provenance: "source", rawHash: responseHashes[0] ?? null,
        });
        if (ingested.created) created++;
      }
      const complete = result.complete;
      transaction(this.db, () => {
        this.db.prepare("UPDATE search_runs SET state=?,checkpoint_json=?,finished_at=?,error_json=? WHERE id=?")
          .run(complete ? "completed" : "blocked",
            JSON.stringify({ responseHashes, discovered: result.postings.length, cap: options.cap ?? null }),
            new Date(this.now()).toISOString(),
            complete ? null : JSON.stringify({ code: "partial_scan", message: "Scan stopped before exhaustion; missing postings were not closed" }),
            searchRunId);
        event(this.db, "discovery.finished", "source", source.id, { searchRunId, complete, discovered: result.postings.length, created }, this.now());
      });
      return { searchRunId, adapterId: adapter.id, discovered: result.postings.length, created, complete, responseHashes };
    } catch (error) {
      const translated = error instanceof AppError || error instanceof SourceError ? error : new Error(String(error));
      transaction(this.db, () => {
        this.db.prepare("UPDATE search_runs SET state='failed',finished_at=?,error_json=? WHERE id=?")
          .run(new Date(this.now()).toISOString(),
            JSON.stringify({ code: translated instanceof SourceError ? translated.code : "discovery_failed", message: translated.message }), searchRunId);
        event(this.db, "discovery.failed", "source", source.id, { searchRunId, code: translated.name, retryable: translated instanceof SourceError ? translated.retryable : false }, this.now());
      });
      throw error;
    }
  }
}
