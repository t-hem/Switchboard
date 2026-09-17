import type { FastifyInstance } from "fastify";
import type { SettingsStore } from "./store.js";
import type { ServiceConfig } from "./config.js";
import { ArtifactStore } from "./artifacts.js";
import { Postings } from "./postings.js";
import { Sources } from "./sources.js";
import { Discovery } from "./discovery.js";
import { FetchHttpClient } from "./net.js";
import { TaskQueue } from "./queue.js";
import { DiscoveryScheduler } from "./scheduler.js";

/**
 * Operator-facing scheduler surface. `GET` is read-only; `POST /api/scheduler/run` performs
 * one cycle under the shared lease, so it can never run alongside the background worker.
 */
export function schedulerRoutes(app: FastifyInstance, store: SettingsStore, dir: string, config: ServiceConfig): void {
  const db = store.db;
  const artifacts = new ArtifactStore(db, dir);
  const sources = new Sources(db);
  const discovery = new Discovery(db, sources, new Postings(db, artifacts), artifacts,
    new FetchHttpClient({ allowPrivate: config.allowPrivateImport === true }));
  const scheduler = new DiscoveryScheduler({ store, sources, discovery, queue: new TaskQueue(db), owner: `jobs-api-${process.pid}` });

  app.get("/api/scheduler", async () => ({
    status: scheduler.status(),
    runs: db.prepare(`SELECT r.id,r.source_id,s.source_key,s.adapter_id,r.state,r.checkpoint_json,r.created_at,r.finished_at,r.error_json
      FROM search_runs r JOIN sources s ON s.id=r.source_id ORDER BY r.created_at DESC LIMIT 50`).all(),
  }));
  app.post<{ Body: { force?: boolean } }>("/api/scheduler/run", {
    schema: { body: { type: "object", additionalProperties: false, properties: { force: { type: "boolean" } } } },
  }, async req => scheduler.runOnce({ force: req.body?.force === true }));
}
