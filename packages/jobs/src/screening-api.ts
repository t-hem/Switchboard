import type { FastifyInstance } from "fastify";
import type { SettingsStore } from "./store.js";
import { Screening } from "./screening.js";

/** Screening history plus the operator skip/requeue actions (each an audit event). */
export function screeningRoutes(app: FastifyInstance, store: SettingsStore): void {
  const screening = new Screening(store.db);
  app.get("/api/screening", async () => {
    const decisions = screening.list(100);
    return { decisions, counts: Object.fromEntries(["eligible", "excluded", "needs_review", "skipped"].map(decision =>
      [decision, Number((store.db.prepare("SELECT count(*) AS n FROM screening_decisions WHERE decision=?").get(decision) as Record<string, unknown>)["n"])])) };
  });
  app.post<{ Params: { id: string }; Body: { reason: string } }>("/api/jobs/:id/skip", {
    schema: { body: { type: "object", additionalProperties: false, required: ["reason"],
      properties: { reason: { type: "string", minLength: 1, maxLength: 2000 } } } },
  }, async req => { screening.skip(req.params.id, req.body.reason, store.current().revision); return { skipped: true, jobId: req.params.id }; });
  app.post<{ Params: { id: string } }>("/api/jobs/:id/requeue", async req => {
    screening.requeue(req.params.id, store.current().revision);
    return { requeued: true, jobId: req.params.id };
  });
  app.post<{ Params: { id: string } }>("/api/jobs/:id/screen", async req =>
    screening.screenStored(req.params.id, { settingsRevision: store.current().revision, actor: "operator" }));
}
