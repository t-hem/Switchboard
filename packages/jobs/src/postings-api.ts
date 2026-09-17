import type { FastifyInstance } from "fastify";
import { AppError } from "./errors.js";
import { createSourceAdapter, sourceAdapterIds } from "./adapters/source.js";
import type { ServiceDeps, Services } from "./services.js";

export type PostingsDeps = ServiceDeps;

/**
 * Import/capture surface for job postings. Every route is behind the jobs bearer token
 * (registered by the server's auth hook). An unavailable browser or disabled source is
 * reported as such; nothing falls back to an invisible or synthetic success.
 */
export function postingsRoutes(app: FastifyInstance, { store, config, postings, sources, discovery, capture }: Services): void {
  app.get("/api/sources", async () => ({
    adapters: sourceAdapterIds().map(id => { const adapter = createSourceAdapter(id); return { id, version: adapter.version, capabilities: adapter.capabilities }; }),
    sources: sources.list(),
    capture: { available: capture !== null, allowPrivateImport: config.allowPrivateImport === true },
  }));

  app.put<{ Params: { id: string }; Body: { adapterId: string; sourceKey: string; config: unknown; enabled?: boolean } }>("/api/sources/:id", {
    schema: { body: { type: "object", additionalProperties: false, required: ["adapterId", "sourceKey", "config"],
      properties: { adapterId: { type: "string", minLength: 1, maxLength: 64 }, sourceKey: { type: "string", minLength: 1, maxLength: 200 },
        config: { type: "object" }, enabled: { type: "boolean" } } } },
  }, async req => sources.upsert({ id: req.params.id, adapterId: req.body.adapterId, sourceKey: req.body.sourceKey, config: req.body.config, enabled: req.body.enabled }));

  app.post<{ Params: { id: string }; Body: { cap?: number; maxRetries?: number } }>("/api/sources/:id/discover", {
    schema: { body: { type: "object", additionalProperties: false, properties: { cap: { type: "integer", minimum: 1, maximum: 5000 }, maxRetries: { type: "integer", minimum: 0, maximum: 5 } } } },
  }, async req => discovery.run(req.params.id, { settingsRevision: store.current().revision, cap: req.body?.cap, maxRetries: req.body?.maxRetries }));

  app.post<{ Body: { url: string; company: string; title?: string; location?: string; descriptionText: string; externalId?: string } }>("/api/import/manual", {
    schema: { body: { type: "object", additionalProperties: false, required: ["url", "company", "descriptionText"],
      properties: { url: { type: "string", minLength: 8, maxLength: 2048 }, company: { type: "string", minLength: 1, maxLength: 200 },
        title: { type: "string", minLength: 1, maxLength: 300 }, location: { type: "string", maxLength: 200 },
        descriptionText: { type: "string", minLength: 1, maxLength: 200_000 }, externalId: { type: "string", maxLength: 200 } } } },
  }, async req => {
    const ingested = postings.ingest({
      adapterId: "manual", externalId: req.body.externalId ?? null, originalUrl: req.body.url,
      company: req.body.company, title: req.body.title ?? "Untitled posting", location: req.body.location ?? null,
      descriptionText: req.body.descriptionText, provenance: "manual",
    });
    const snapshot = postings.recordSnapshot({
      jobId: ingested.jobId, purpose: "discovery", fetchedUrl: req.body.url, finalUrl: req.body.url,
      descriptionText: req.body.descriptionText, captureVersion: "manual",
      capture: { method: "manual", note: "Operator-pasted text; no screenshot evidence" },
      completeness: "partial", failureDetail: "Manual text import has no screenshot evidence",
    });
    return { ...ingested, snapshotId: snapshot.snapshotId, screenshotHash: snapshot.screenshotHash, warning: "Manual import records text only; capture by URL for screenshot evidence." };
  });

  app.post<{ Body: { url: string; company: string; title?: string; purpose?: "discovery" | "application_preflight" } }>("/api/import/url", {
    schema: { body: { type: "object", additionalProperties: false, required: ["url", "company"],
      properties: { url: { type: "string", minLength: 8, maxLength: 2048 }, company: { type: "string", minLength: 1, maxLength: 200 },
        title: { type: "string", minLength: 1, maxLength: 300 }, purpose: { enum: ["discovery", "application_preflight"] } } } },
  }, async req => {
    if (!capture) throw new AppError("browser_unavailable", "No browser executable is configured for capture; use manual import", 409);
    const purpose = req.body.purpose ?? "discovery";
    const outcome = await capture.capture(req.body.url, { allowPrivate: config.allowPrivateImport === true });
    const ingested = postings.ingest({
      adapterId: "manual", externalId: null, originalUrl: req.body.url, canonicalUrl: outcome.finalUrl,
      company: req.body.company, title: req.body.title ?? outcome.title ?? "Untitled posting",
      descriptionText: outcome.descriptionText, provenance: "browser",
    });
    const snapshot = postings.recordSnapshot({
      jobId: ingested.jobId, purpose, fetchedUrl: outcome.fetchedUrl, finalUrl: outcome.finalUrl,
      descriptionText: outcome.descriptionText, screenshot: outcome.screenshot, imageMimeType: "image/png",
      captureVersion: `browser:${outcome.captureJson.captureVersion}`, capture: outcome.captureJson,
      completeness: outcome.completeness, failureDetail: outcome.warning,
    });
    return { ...ingested, snapshotId: snapshot.snapshotId, contentHash: snapshot.contentHash, screenshotHash: snapshot.screenshotHash,
      completeness: outcome.completeness, warning: outcome.warning };
  });
}
