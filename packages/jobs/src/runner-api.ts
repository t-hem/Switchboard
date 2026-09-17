import type { FastifyInstance } from "fastify";
import type { Services } from "./services.js";
import { AppError } from "./errors.js";
import { enqueueTailoring } from "./runner.js";

/**
 * Operator-triggered tailoring and run diagnostics. `POST /api/tailoring` queues the assembly
 * stage; the service's worker claims it (only while jobs are enabled and unpaused), runs it
 * under a fenced lease, and queues the edit stage after it. Without a private host token the
 * route reports the missing capability instead of queueing work that could never spawn.
 */
export function runnerRoutes(app: FastifyInstance, { store, db, config, now, queue }: Services): void {
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
    if (!config.spawnerToken) throw new AppError("spawner_unconfigured", "A host token is not configured in service.json; tailoring cannot spawn", 409);
    const { revision, value: settings } = store.current();
    const task = enqueueTailoring(queue, req.body, revision, now?.());
    const dispatch = !settings.enabled ? "waits until jobs are enabled" : settings.paused ? "waits until jobs are unpaused" : "the worker will start it shortly";
    return { queued: true, taskId: task.id, state: task.state, dispatch, ...req.body, settingsRevision: revision };
  });
}
