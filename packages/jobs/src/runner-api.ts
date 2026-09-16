import type { FastifyInstance } from "fastify";
import type { SettingsStore } from "./store.js";
import type { ServiceConfig } from "./config.js";
import { AppError } from "./errors.js";
import { ArtifactStore } from "./artifacts.js";
import { Library } from "./library.js";
import { ResumeRenderer } from "./resume.js";
import { TaskQueue } from "./queue.js";
import { Reviews } from "./reviews.js";
import { TailoringRunner } from "./runner.js";
import { createInvocationAdapter } from "./invocation.js";
import { SwitchboardSpawner } from "./adapters/spawner.js";

/**
 * Operator-triggered tailoring and run diagnostics. The runner is created lazily and only
 * when a private host token is configured; without it the route reports the missing
 * capability instead of attempting a spawn. A real worker/scheduler wires this in step 8.
 */
export function runnerRoutes(app: FastifyInstance, store: SettingsStore, dir: string, config: ServiceConfig): void {
  const db = store.db;
  let runner: TailoringRunner | null = null;
  const build = (): TailoringRunner => {
    if (!config.spawnerToken) throw new AppError("spawner_unconfigured", "A host token is not configured in service.json; tailoring cannot spawn", 409);
    if (runner) return runner;
    const settings = store.current().value;
    const artifacts = new ArtifactStore(db, dir);
    runner = new TailoringRunner({
      db, artifacts, library: new Library(db), renderer: new ResumeRenderer(db, artifacts, new Library(db)),
      queue: new TaskQueue(db), reviews: new Reviews(db), personasDir: settings.personaDirectory,
      spawner: new SwitchboardSpawner({ baseUrl: settings.spawner.baseUrl, token: config.spawnerToken }),
      invocation: createInvocationAdapter("pi"), dataDir: dir,
      spawnerProvider: settings.spawner.provider, spawnerInstance: settings.spawner.baseUrl,
    });
    return runner;
  };

  app.get<{ Params: { id: string } }>("/api/runs/:id", async req => {
    const run = db.prepare("SELECT * FROM agent_runs WHERE id=?").get(req.params.id);
    if (!run) throw new AppError("run_missing", "Agent run not found", 404);
    return { run,
      tools: db.prepare("SELECT * FROM tool_events WHERE run_id=? ORDER BY sequence").all(req.params.id),
      messages: db.prepare("SELECT * FROM run_messages WHERE run_id=? ORDER BY sequence").all(req.params.id),
      resumes: db.prepare("SELECT id,phase,parent_resume_id,text_artifact_hash,pdf_artifact_hash,created_at FROM resume_versions WHERE agent_run_id=?").all(req.params.id) };
  });

  app.post<{ Body: { applicationId: string; jobSnapshotId: string; profileRevisionId: string; templateRevisionId: string } }>("/api/tailoring", {
    schema: { body: { type: "object", additionalProperties: false, required: ["applicationId", "jobSnapshotId", "profileRevisionId", "templateRevisionId"],
      properties: { applicationId: { type: "string", minLength: 1 }, jobSnapshotId: { type: "string", minLength: 1 },
        profileRevisionId: { type: "string", minLength: 1 }, templateRevisionId: { type: "string", minLength: 1 } } } },
  }, async req => {
    const started = build();
    const settingsRevision = store.current().revision;
    // Fire-and-forget: the run is tracked in agent_runs and its outcome is a review item.
    void started.runTwoPass({ ...req.body, settingsRevision }).catch(() => undefined);
    return { started: true, ...req.body, settingsRevision };
  });
}
