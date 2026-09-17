import type { FastifyInstance } from "fastify";
import type { SettingsStore } from "./store.js";
import type { ServiceConfig } from "./config.js";
import { AppError } from "./errors.js";
import { ArtifactStore } from "./artifacts.js";
import { Policies } from "./policies.js";
import { SubmissionService } from "./submission.js";
import { FetchHttpClient, type HttpClient } from "./net.js";
import type { FormSession } from "./adapters/application.js";
import { PuppeteerFormSession } from "./form.js";
import type { SupervisedBrowser } from "./browser.js";

export type SubmissionDeps = { browser?: SupervisedBrowser; http?: HttpClient; now?: () => number; createSession?: () => FormSession };

/**
 * Sending, reconciliation and site policy. `POST /api/attempts/:id/submit` is the only route
 * in the service that performs an external write, and it refuses unless every gate, the
 * effective policy and the evidence all pass at that moment.
 */
export function submissionRoutes(app: FastifyInstance, store: SettingsStore, dir: string, config: ServiceConfig, deps: SubmissionDeps = {}): void {
  const db = store.db;
  const artifacts = new ArtifactStore(db, dir);
  const http = deps.http ?? new FetchHttpClient({ allowPrivate: config.allowPrivateImport === true });
  const createSession = deps.createSession ?? (deps.browser ? () => new PuppeteerFormSession(deps.browser!) : undefined);
  const submission = new SubmissionService({ store, db, artifacts, http, now: deps.now, createSession });

  app.get("/api/policies", async () => ({ policies: new Policies(db, deps.now).list(), scopes: db.prepare("SELECT DISTINCT scope_key FROM source_policies ORDER BY scope_key").all().map(row => String((row as Record<string, unknown>)["scope_key"])) }));

  app.put<{ Body: { adapterId: string; siteUrl: string; capabilities: { prepare: boolean; fill: boolean; upload: boolean; submit: boolean }; restrictions?: { autoSubmit?: boolean; maxPerDay?: number; notes?: string }; termsUrl?: string } }>("/api/policies", {
    schema: { body: { type: "object", additionalProperties: false, required: ["adapterId", "siteUrl", "capabilities"],
      properties: { adapterId: { type: "string", minLength: 1, maxLength: 64 }, siteUrl: { type: "string", minLength: 8, maxLength: 2048 },
        capabilities: { type: "object", additionalProperties: false, required: ["prepare", "fill", "upload", "submit"],
          properties: { prepare: { type: "boolean" }, fill: { type: "boolean" }, upload: { type: "boolean" }, submit: { type: "boolean" } } },
        restrictions: { type: "object", additionalProperties: false, properties: { autoSubmit: { type: "boolean" }, maxPerDay: { type: "integer", minimum: 0, maximum: 1000 }, notes: { type: "string", maxLength: 2000 } } },
        termsUrl: { type: "string", maxLength: 2048 } } } },
  }, async req => new Policies(db, deps.now).put({ ...req.body, reviewedBy: "operator" }));

  app.get("/api/submissions", async () => ({
    submissions: db.prepare(`SELECT a.id,a.application_id,a.adapter_id,a.state,a.send_started_at,a.finished_at,a.outcome_json,a.receipt_hash,
      j.company,j.title FROM application_attempts a JOIN applications ap ON ap.id=a.application_id JOIN jobs j ON j.id=ap.job_id
      WHERE a.send_started_at IS NOT NULL ORDER BY a.send_started_at DESC LIMIT 100`).all(),
    awaitingReconciliation: db.prepare(`SELECT a.id,a.application_id,a.send_started_at,a.outcome_json,j.company,j.title FROM application_attempts a
      JOIN applications ap ON ap.id=a.application_id JOIN jobs j ON j.id=ap.job_id WHERE a.state='unknown' ORDER BY a.send_started_at DESC LIMIT 100`).all(),
  }));

  app.post<{ Params: { id: string } }>("/api/attempts/:id/submit", async req => {
    if (!createSession) throw new AppError("browser_unavailable", "No supervised browser is configured; submissions cannot be sent", 409);
    return submission.submit(req.params.id, { actor: "operator" });
  });

  app.post<{ Params: { id: string }; Body: { outcome: "submitted" | "rejected"; detail: string; externalId?: string | null; receiptText?: string } }>("/api/attempts/:id/reconcile", {
    schema: { body: { type: "object", additionalProperties: false, required: ["outcome", "detail"],
      properties: { outcome: { enum: ["submitted", "rejected"] }, detail: { type: "string", minLength: 1, maxLength: 2000 },
        externalId: { type: ["string", "null"], maxLength: 200 }, receiptText: { type: "string", maxLength: 200_000 } } } },
  }, async req => submission.reconcile(req.params.id, { ...req.body, actor: "operator", settingsRevision: store.current().revision }));
}
