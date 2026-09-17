import type { FastifyInstance } from "fastify";
import { AppError } from "./errors.js";
import { createApplicationAdapter, applicationAdapterIds } from "./adapters/application.js";
import type { Services } from "./services.js";

/**
 * Preparation, review package, approval and manual reconciliation. Preparation is the only
 * route that touches a website, and it never submits: approval records a human decision
 * against one attempt's manifest hash, and a later prepare with different evidence or
 * answers cancels that approval.
 */
export function applicationsRoutes(app: FastifyInstance, { store, config, applications, preparation, createSession }: Services): void {
  app.get("/api/application-adapters", async () => ({
    adapters: applicationAdapterIds().map(id => { const adapter = createApplicationAdapter(id); return { id, version: adapter.version, capabilities: adapter.capabilities }; }),
    browser: { available: config.browserExecutablePath !== undefined, supervised: createSession !== undefined },
  }));

  app.post<{ Params: { id: string }; Body: { adapterId: string; formUrl: string; answers: Record<string, string>; adapterOptions?: Record<string, unknown> } }>("/api/applications/:id/prepare", {
    schema: { body: { type: "object", additionalProperties: false, required: ["adapterId"],
      properties: { adapterId: { type: "string", minLength: 1, maxLength: 64 }, formUrl: { type: "string", minLength: 8, maxLength: 2048 },
        answers: { type: "object", additionalProperties: { type: "string", maxLength: 5000 } }, adapterOptions: { type: "object" } } } },
  }, async req => preparation.prepare({
    applicationId: req.params.id, adapterId: req.body.adapterId, formUrl: req.body.formUrl ?? "",
    answers: req.body.answers ?? {}, adapterOptions: req.body.adapterOptions,
    settingsRevision: store.current().revision, allowPrivate: config.allowPrivateImport === true,
  }));

  app.get<{ Params: { id: string } }>("/api/applications/:id/package", async req => applications.packageOf(req.params.id));

  app.post<{ Params: { id: string }; Body: { resumeVersionId: string } }>("/api/applications/:id/resume", {
    schema: { body: { type: "object", additionalProperties: false, required: ["resumeVersionId"],
      properties: { resumeVersionId: { type: "string", minLength: 1, maxLength: 64 } } } },
  }, async req => applications.selectResume(req.params.id, req.body.resumeVersionId));

  app.post<{ Params: { id: string }; Body: { code?: string; note: string; answers?: Record<string, string>; adapterOptions?: Record<string, unknown> } }>("/api/applications/:id/resolve", {
    schema: { body: { type: "object", additionalProperties: false, required: ["note"],
      properties: { code: { type: "string", maxLength: 64 }, note: { type: "string", minLength: 1, maxLength: 2000 },
        answers: { type: "object", additionalProperties: { type: "string", maxLength: 5000 } }, adapterOptions: { type: "object" } } } },
  }, async req => {
    // The handoff carries the URL, answers and resume captured when the block was recorded.
    const handoff = applications.openHandoff(req.params.id, req.body.code);
    if (!handoff) throw new AppError("handoff_missing", "There is no open handoff matching that code", 404);
    if (!handoff.adapterId) throw new AppError("handoff_missing", "The handoff does not record an adapter; prepare directly instead", 409);
    applications.resolveHandoff(req.params.id, { code: req.body.code, note: req.body.note });
    // Continue the same application: the answers are merged and a new attempt is prepared.
    const outcome = await preparation.prepare({ applicationId: req.params.id, adapterId: handoff.adapterId, formUrl: handoff.formUrl,
      answers: { ...handoff.answers, ...(req.body.answers ?? {}) }, adapterOptions: req.body.adapterOptions,
      settingsRevision: store.current().revision, allowPrivate: config.allowPrivateImport === true });
    return { resolved: true, handoff, outcome };
  });

  app.post<{ Params: { id: string }; Body: { detail: string; receiptText?: string } }>("/api/applications/:id/manual-completion", {
    schema: { body: { type: "object", additionalProperties: false, required: ["detail"],
      properties: { detail: { type: "string", minLength: 1, maxLength: 2000 }, receiptText: { type: "string", maxLength: 200_000 } } } },
  }, async req => applications.manualCompletion(req.params.id, { detail: req.body.detail, receiptText: req.body.receiptText, settingsRevision: store.current().revision }));

  app.post<{ Params: { id: string }; Body: { expectedManifestHash: string; reason: string } }>("/api/attempts/:id/approve", {
    schema: { body: { type: "object", additionalProperties: false, required: ["expectedManifestHash", "reason"],
      properties: { expectedManifestHash: { type: "string", minLength: 64, maxLength: 64 }, reason: { type: "string", minLength: 1, maxLength: 2000 } } } },
  }, async req => applications.approve(req.params.id, { expectedManifestHash: req.body.expectedManifestHash, reason: req.body.reason, settingsRevision: store.current().revision }));
}
