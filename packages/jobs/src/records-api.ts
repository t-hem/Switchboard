import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { SettingsStore } from "./store.js";
import { ArtifactStore } from "./artifacts.js";
import { Records } from "./records.js";
import { healthOf, isReadOnly, repairQueue } from "./health.js";
import { event } from "./events.js";
import { AppError } from "./errors.js";

/**
 * Records, exports and operating recovery. The export is a directory that can be verified and
 * read with no database and no service; health names every gap instead of hiding it; repair
 * returns expired leases to the queue but never guesses at an interrupted submission.
 */
export function recordsRoutes(app: FastifyInstance, store: SettingsStore, dir: string, options: { now?: () => number } = {}): void {
  const db = store.db;
  const artifacts = new ArtifactStore(db, dir);
  const records = new Records({ db, artifacts, now: options.now });

  app.get("/api/health", async () => healthOf(db, dir, { artifacts, now: options.now }));

  app.post<{ Body: { submissionGraceMs?: number } }>("/api/queue/repair", {
    schema: { body: { type: "object", additionalProperties: false, properties: { submissionGraceMs: { type: "integer", minimum: 1000, maximum: 86_400_000 } } } },
  }, async req => {
    const result = repairQueue(db, { now: options.now, submissionGraceMs: req.body?.submissionGraceMs });
    event(db, "queue.repaired", "database", "main", { ...result }, options.now?.() ?? Date.now());
    return result;
  });

  app.get<{ Params: { id: string } }>("/api/applications/:id/record", async req => records.recordOf(req.params.id));

  app.post<{ Params: { id: string }; Body: { directory?: string } }>("/api/applications/:id/export", {
    schema: { body: { type: "object", additionalProperties: false, properties: { directory: { type: "string", minLength: 1, maxLength: 1024 } } } },
  }, async req => {
    if (isReadOnly(dir)) throw new AppError("read_only_archive", "This data directory is a read-only restore; export it by copying it out instead", 409);
    const stamp = new Date(options.now?.() ?? Date.now()).toISOString().replace(/[:.]/g, "-");
    const target = req.body?.directory ? path.resolve(req.body.directory) : path.join(dir, "exports", `${req.params.id}-${stamp}`);
    const exported = records.exportApplication(req.params.id, target);
    event(db, "application.exported", "application", req.params.id, { directory: exported.directory, artifacts: exported.manifest.artifacts.length, recordHash: exported.manifest.recordHash }, options.now?.() ?? Date.now());
    return { directory: exported.directory, artifacts: exported.manifest.artifacts.length, recordHash: exported.manifest.recordHash, createdAt: exported.manifest.createdAt };
  });
}