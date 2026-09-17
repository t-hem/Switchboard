import type { FastifyInstance } from "fastify";
import type { Services } from "./services.js";

/**
 * Operator-facing scheduler surface. `GET` is read-only; `POST /api/scheduler/run` performs
 * one cycle under the shared lease, so it can never run alongside the background worker.
 */
export function schedulerRoutes(app: FastifyInstance, { db, scheduler }: Services): void {
  app.get("/api/scheduler", async () => ({
    status: scheduler.status(),
    runs: db.prepare(`SELECT r.id,r.source_id,s.source_key,s.adapter_id,r.state,r.checkpoint_json,r.created_at,r.finished_at,r.error_json
      FROM search_runs r JOIN sources s ON s.id=r.source_id ORDER BY r.created_at DESC LIMIT 50`).all(),
  }));
  app.post<{ Body: { force?: boolean } }>("/api/scheduler/run", {
    schema: { body: { type: "object", additionalProperties: false, properties: { force: { type: "boolean" } } } },
  }, async req => scheduler.runOnce({ force: req.body?.force === true }));
}
