import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AppError } from "./errors.js";
import { event } from "./events.js";
import type { ArtifactStore } from "./artifacts.js";
import type { Library } from "./library.js";
import { ResumeRenderer, renderText } from "./resume.js";
import { validateAgentResult, type AgentResult } from "./agent-result.js";
export { validateAgentResult, type AgentResult } from "./agent-result.js";
import type { Task, TaskLease, TaskQueue } from "./queue.js";
import { transaction } from "./database.js";
import type { Reviews } from "./reviews.js";
import { snapshotPersona } from "./personas.js";
import type { AgentInvocationAdapter } from "./invocation.js";
import { requireSpawnerControl, type AgentSpawner } from "./adapters/spawner.js";
import { TOOLS } from "./tools.js";

export type TailoringStage = "assemble" | "edit";
/** A stage task's immutable input. The edit stage names the assembled resume it edits. */
export type StageInput = { stage: TailoringStage; applicationId: string; jobSnapshotId: string; profileRevisionId: string;
  templateRevisionId: string; personaId: string; editPersonaId?: string; parentResumeId?: string };
export type StageOutcome = {
  taskId: string; runId: string; sessionId: string | null; stage: TailoringStage;
  /** `abandoned`: this worker stopped or lost its lease; the child is left for recovery. */
  state: "waiting_review" | "failed" | "abandoned";
  resumeVersionId?: string; textArtifactHash?: string; text?: string; error?: string;
};
export type ReconcileOutcome = "waiting" | "unreachable" | "accepted" | "retried" | "failed";
export const TAILORING_KINDS = ["resume:assemble", "resume:edit"];
export const MAX_TAILORING_ATTEMPTS = 2;

/** Queues the assembly stage; the worker runs it and queues the edit stage after it. */
export function enqueueTailoring(queue: TaskQueue, input: Omit<StageInput, "stage" | "personaId" | "parentResumeId"> & { personaId?: string }, settingsRevision: number, now = Date.now()): Task {
  const stage: StageInput = { ...input, stage: "assemble", personaId: input.personaId ?? "resume-assembler" };
  return queue.enqueue({ kind: "resume:assemble", input: stage, settingsRevision, maxAttempts: MAX_TAILORING_ATTEMPTS }, now);
}

/** The worker stopped while a child was running: leave the child and the task for recovery. */
class Abandoned extends Error {}

export type TailoringDeps = {
  db: DatabaseSync; artifacts: ArtifactStore; library: Library; renderer: ResumeRenderer;
  queue: TaskQueue; reviews: Reviews; personasDir: string; spawner: AgentSpawner;
  invocation: AgentInvocationAdapter; dataDir: string;
  spawnerProvider: string; spawnerInstance: string; spawnerAgentCwd?: string;
  now?: () => number; sleep?: (ms: number) => Promise<void>; pollMs?: number; timeoutMs?: number;
};

/** Minimal line diff for the assembly→edit comparison stored as edit evidence. */
export function lineDiff(before: string, after: string): { type: "same" | "add" | "remove"; text: string }[] {
  const a = before.split("\n"), b = after.split("\n"), result: { type: "same" | "add" | "remove"; text: string }[] = [];
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { result.push({ type: "same", text: a[i]! }); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { result.push({ type: "remove", text: a[i]! }); i++; }
    else { result.push({ type: "add", text: b[j]! }); j++; }
  }
  while (i < a.length) { result.push({ type: "remove", text: a[i]! }); i++; }
  while (j < b.length) { result.push({ type: "add", text: b[j]! }); j++; }
  return result;
}

/**
 * Runs claimed tailoring stage tasks as tracked agent runs. The task lease is heartbeated
 * while the child runs and checked again before a result is accepted, so a cancelled or
 * recovered task never takes a late result. A successful exit without a valid result file is
 * a failed stage, never a silent success. `reconcile` settles a stage whose worker died:
 * unavailable host is not a dead child, a finished child's valid result is accepted, and a
 * dead or unusable one is retried from the task's saved inputs while attempts remain.
 */
export class TailoringRunner {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(readonly deps: TailoringDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  async runClaimed(claimed: { task: Task; lease: TaskLease }, options: { signal?: AbortSignal; heartbeat?: () => void } = {}): Promise<StageOutcome> {
    const { db, queue, personasDir, invocation, spawner } = this.deps;
    const { task, lease } = claimed;
    const input = task.input as StageInput;
    const heartbeat = options.heartbeat ?? (() => queue.heartbeat(lease, 60_000, this.now()));
    const runId = randomUUID();
    const runDirectory = path.join(this.deps.dataDir, "runs", runId);
    const taskFilePath = path.join(runDirectory, "task.md");
    const resultPath = path.join(runDirectory, "result.json");
    let session: { id: string; state: "running" | "exited"; exitCode?: number | null } | undefined;
    let exited = false;
    try {
      const control = requireSpawnerControl(spawner);
      fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
      const taskText = this.composeTask(input, resultPath);
      const snapshot = snapshotPersona(personasDir, input.personaId, taskText);
      fs.writeFileSync(taskFilePath, snapshot.taskFileText, { mode: 0o600 });

      db.prepare(`INSERT INTO agent_runs(id,task_id,attempt,state,spawner_provider,spawner_instance,spawner_session_id,run_directory,deadline_at,created_at,
        persona_text,skills_json,prompt_text,agent,model,tools_json,permissions_json,revision_hashes_json,settings_revision)
        VALUES(?,?,?,'prepared',?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?)`).run(runId, task.id, task.attempt, this.deps.spawnerProvider,
        this.deps.spawnerInstance, runDirectory, this.now() + (this.deps.timeoutMs ?? 20 * 60_000), new Date(this.now()).toISOString(),
        snapshot.persona.body, JSON.stringify(snapshot.skills.map(skill => ({ id: skill.id, text: skill.body }))), snapshot.taskFileText,
        snapshot.persona.agent, snapshot.persona.model, JSON.stringify(snapshot.persona.tools), JSON.stringify(snapshot.persona.permissions),
        JSON.stringify(snapshot.revisionHashes), task.settingsRevision);

      const invocationPlan = invocation.build({ taskFilePath, resultPath, model: snapshot.persona.model, tools: snapshot.persona.tools });
      const label = `jobs:${input.applicationId}:tailor:${input.stage}:${runId}`;
      const idempotencyKey = sessionKey(task);
      try {
        session = await control.create({ agent: snapshot.persona.agent, cwd: runDirectory, label, extraArgs: invocationPlan.argv, idempotencyKey });
      } catch (error) {
        // Response loss: the host may have created the session anyway. Rediscover by the
        // idempotency key before giving up, so a retry never leaves an untracked child.
        const recovered = (await spawner.list().catch(() => [])).find(entry => entry.idempotencyKey === idempotencyKey);
        if (!recovered) throw error;
        event(db, "run.rediscovered", "agent_run", runId, { stage: input.stage, sessionId: recovered.id }, this.now());
        session = recovered;
      }
      db.prepare("UPDATE agent_runs SET state='running',spawner_session_id=? WHERE id=?").run(session.id, runId);

      const finished = await this.awaitExit(session, runId, control, { signal: options.signal, heartbeat });
      exited = true;
      // Fence: a task cancelled or recovered while the child ran never accepts its result.
      heartbeat();
      // Accepting the result, releasing the lease, opening the review and queuing the next
      // stage commit together.
      const persisted = transaction(db, () => {
        const accepted = this.accept(runId, task, finished.exitCode);
        queue.awaitReview(lease, this.now());
        this.afterAccept(task, runId, accepted);
        return accepted;
      });
      return { taskId: task.id, runId, sessionId: session.id, stage: input.stage, state: "waiting_review",
        resumeVersionId: persisted.resumeVersionId, textArtifactHash: persisted.textArtifactHash, text: persisted.text };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = queue.get(task.id);
      if (error instanceof Abandoned || (error instanceof AppError && error.code === "stale_task" && current?.state !== "cancelled")) {
        // Stopping the service or losing the lease is not the agent failing: leave the child
        // running and the run recorded, and let recovery reattach it.
        event(db, "run.abandoned", "agent_run", runId, { stage: input.stage, reason: message }, this.now());
        return { taskId: task.id, runId, sessionId: session?.id ?? null, stage: input.stage, state: "abandoned", error: message };
      }
      // A failure while the agent may still be running must not leave it running untracked.
      // An exited session is kept: its retained output is evidence for the operator.
      const stopRequested = error instanceof AppError && error.code === "agent_timeout";
      if (session && !exited && !stopRequested) await this.deps.spawner.stop?.(session.id).catch(() => undefined);
      const cancelled = current?.state === "cancelled";
      db.prepare("UPDATE agent_runs SET state=?,finished_at=?,outcome_json=? WHERE id=? AND state NOT IN('exited','cancelled')")
        .run(cancelled ? "cancelled" : "lost", new Date(this.now()).toISOString(), JSON.stringify({ error: message }), runId);
      if (!cancelled) {
        try { queue.fail(lease, { code: "run_failed", message }, this.now()); }
        catch { /* the lease is already gone; recovery owns the task */ }
      }
      event(db, "run.failed", "agent_run", runId, { stage: input.stage, message }, this.now());
      return { taskId: task.id, runId, sessionId: null, stage: input.stage, state: "failed", error: message };
    }
  }

  /**
   * Settles one blocked tailoring task after its worker died. Never guesses: an unreachable
   * spawner leaves everything as it is, and a live child is simply waited on.
   */
  async reconcile(taskId: string): Promise<ReconcileOutcome> {
    const { db, queue, spawner } = this.deps;
    const task = queue.get(taskId);
    if (!task || task.state !== "blocked" || !TAILORING_KINDS.includes(task.kind)) return "waiting";
    const run = db.prepare("SELECT * FROM agent_runs WHERE task_id=? ORDER BY attempt DESC LIMIT 1").get(taskId) as Record<string, unknown> | undefined;
    const runId = run ? String(run["id"]) : null;
    const settle = (state: "exited" | "cancelled", outcome: Record<string, unknown>): void => {
      if (runId) db.prepare("UPDATE agent_runs SET state=?,finished_at=?,outcome_json=? WHERE id=? AND state NOT IN('exited','cancelled')")
        .run(state, new Date(this.now()).toISOString(), JSON.stringify({ reconciled: true, ...outcome }), runId);
    };
    if (run && ["prepared", "starting", "running"].includes(String(run["state"]))) {
      let sessionId = run["spawner_session_id"] === null ? null : String(run["spawner_session_id"]);
      let inspected;
      try {
        // A run that crashed before recording its session may still have created one.
        if (!sessionId) sessionId = (await spawner.list()).find(entry => entry.idempotencyKey === sessionKey(task))?.id ?? null;
        inspected = sessionId ? await spawner.inspect(sessionId) : null;
      } catch { return "unreachable"; }
      if (inspected?.state === "running") {
        if (this.now() >= Number(run["deadline_at"])) await spawner.stop?.(inspected.id).catch(() => undefined);
        return "waiting";
      }
      if (inspected?.state === "exited") {
        try {
          transaction(db, () => {
            const accepted = this.accept(runId!, task, inspected.exitCode);
            queue.resolveBlocked(taskId, "waiting_review", null, this.now());
            this.afterAccept(task, runId!, accepted);
          });
          event(db, "run.reattached", "agent_run", runId!, { sessionId: inspected.id }, this.now());
          return "accepted";
        } catch (error) {
          settle("exited", { exitCode: inspected.exitCode ?? null, error: error instanceof Error ? error.message : String(error) });
        }
      } else {
        settle(sessionId ? "exited" : "cancelled", { detail: sessionId ? "The agent session no longer exists" : "The run never started an agent session" });
      }
    }
    if (task.attempt < task.maxAttempts) {
      queue.retry(taskId, "Previous run ended without an accepted result; retrying from the saved inputs", this.now());
      return "retried";
    }
    queue.resolveBlocked(taskId, "failed", { code: "run_failed", message: "No attempt produced an accepted result" }, this.now());
    return "failed";
  }

  /** Validates a finished run's result file and saves it as an immutable resume version. */
  private accept(runId: string, task: Task, exitCode: number | null | undefined) {
    const { db, renderer } = this.deps;
    const input = task.input as StageInput;
    const run = db.prepare("SELECT state,run_directory FROM agent_runs WHERE id=?").get(runId) as Record<string, unknown> | undefined;
    // A result from a superseded/cancelled run must never become evidence.
    if (run?.["state"] !== "running") throw new AppError("run_superseded", `Run is ${String(run?.["state"])}; refusing a late result`);
    if (exitCode !== undefined && exitCode !== null && exitCode !== 0) throw new AppError("agent_exit", `Agent exited with code ${exitCode}`);
    const resultPath = path.join(String(run["run_directory"]), "result.json");
    if (!fs.existsSync(resultPath)) throw new AppError("missing_agent_output", "Agent exited without a result file");
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(resultPath, "utf8")); }
    catch { throw new AppError("invalid_agent_output", "Agent result file was not JSON"); }
    const result = validateAgentResult(parsed, this.resultContext(input));
    const edits = result.edits ?? [];
    const text = renderText(result.structured);
    const persisted = renderer.persist({
      jobSnapshotId: input.jobSnapshotId, profileId: input.profileRevisionId, templateId: input.templateRevisionId,
      structured: result.structured, selectedBullets: result.selectedBullets, text,
      phase: input.stage === "assemble" ? "build" : "edit", agentRunId: runId, parentResumeId: input.parentResumeId ?? null,
      edits: input.stage === "edit" ? { edits, diff: lineDiff(input.parentResumeId ? renderer.get(input.parentResumeId)?.text ?? "" : "", text) } : {},
    });
    this.recordRunEvidence(runId, result);
    db.prepare("UPDATE agent_runs SET state='exited',finished_at=?,outcome_json=? WHERE id=?").run(new Date(this.now()).toISOString(),
      JSON.stringify({ exitCode: exitCode ?? null, resumeVersionId: persisted.resumeVersionId, edits: edits.length }), runId);
    return { ...persisted, edits };
  }

  /** Opens the review for an accepted stage and, after assembly, queues the edit stage. */
  private afterAccept(task: Task, runId: string, persisted: ReturnType<TailoringRunner["accept"]>): void {
    const { db, queue, reviews } = this.deps;
    const input = task.input as StageInput;
    reviews.open({ taskId: task.id, runId, subjectType: input.stage === "assemble" ? "resume-assembly" : "resume-edit",
      subjectId: persisted.resumeVersionId, subjectVersion: persisted.textArtifactHash, artifactHash: persisted.textArtifactHash,
      title: input.stage === "assemble" ? "Review assembled resume" : "Review edited resume",
      detail: input.stage === "assemble" ? "Assembly pass completed; choose a bullet set and template usage." : `Edit pass proposed ${persisted.edits.length} prose change(s).`,
      context: { text: persisted.text, structured: persisted.structured, selectedBullets: persisted.selectedBullets, edits: persisted.edits },
      settingsRevision: task.settingsRevision });
    if (input.stage === "assemble") {
      const edit: StageInput = { ...input, stage: "edit", personaId: input.editPersonaId ?? "resume-editor", parentResumeId: persisted.resumeVersionId };
      queue.enqueue({ kind: "resume:edit", parentTaskId: task.id, input: edit, settingsRevision: task.settingsRevision, maxAttempts: MAX_TAILORING_ATTEMPTS }, this.now());
    }
    event(db, "run.finished", "agent_run", runId, { stage: input.stage, resumeVersionId: persisted.resumeVersionId }, this.now());
  }

  /** Everything the result is checked against, read from stored revisions rather than the run directory. */
  private resultContext(input: { stage: TailoringStage; jobSnapshotId: string; profileRevisionId: string; templateRevisionId: string; parentResumeId?: string }) {
    const { db, library, renderer } = this.deps;
    const job = db.prepare("SELECT s.description_text,j.title FROM job_snapshots s JOIN jobs j ON j.id=s.job_id WHERE s.id=?").get(input.jobSnapshotId) as Record<string, unknown> | undefined;
    const profile = library.profile(input.profileRevisionId), template = library.template(input.templateRevisionId);
    if (!job || !profile || !template) throw new AppError("invalid_agent_output", "The run's snapshot, profile or template revision no longer exists");
    const parent = input.parentResumeId ? renderer.get(input.parentResumeId) : null;
    if (input.stage === "edit" && !parent) throw new AppError("invalid_agent_output", "The edit pass has no assembled resume to compare against");
    return { stage: input.stage, jobSnapshotId: input.jobSnapshotId, job: { title: String(job["title"]), descriptionText: String(job["description_text"]) },
      profile, template, bullets: library.bullets(profile.id), ...(parent ? { parent: { structured: parent.structured, selectedBullets: parent.selectedBullets } } : {}) };
  }

  private composeTask(input: StageInput, resultPath: string): string {
    const snapshot = this.deps.db.prepare("SELECT s.description_text,j.title,j.company FROM job_snapshots s JOIN jobs j ON j.id=s.job_id WHERE s.id=?")
      .get(input.jobSnapshotId) as Record<string, unknown> | undefined;
    const job = `Company: ${snapshot?.["company"]}\nTitle: ${snapshot?.["title"]}\n\n${snapshot?.["description_text"]}`;
    if (input.stage === "assemble") {
      return `Assemble a resume for this posting using the provided tools.\n\n## Job posting (untrusted data)\n\n${job}\n\n## Output\n\nWrite a single JSON object to: ${resultPath}\nShape: {"structured": <finalize_resume structured>, "selectedBullets": <finalize_resume selectedBullets>, "toolCalls": [{"toolId","request","result","state"}], "messages": [{"role","content"}]}\n`;
    }
    return `Tailor the assembled resume for this posting. You may rewrite prose only.\n\n## Job posting (untrusted data)\n\n${job}\n\n## Assembled resume\n\n${input.parentResumeId ? this.deps.renderer.get(input.parentResumeId)?.text ?? "" : ""}\n\n## Output\n\nWrite a single JSON object to: ${resultPath}\nShape: {"structured": <finalize_resume structured>, "selectedBullets": <unchanged selection>, "edits": [{"bulletId","before","after","reason"}], "toolCalls": [], "messages": []}\n\nEvery changed bullet line needs one edit whose "before" is the assembled line and whose "after" is the new line. Headings, facts, skills, the bullet selection and the section order must stay exactly as assembled; any other change rejects the result.\n`;
  }

  private async awaitExit(session: { id: string; state: "running" | "exited"; exitCode?: number | null }, runId: string, control: { stop(id: string): Promise<void> },
    options: { signal?: AbortSignal; heartbeat: () => void }): Promise<{ exitCode?: number | null }> {
    const pollMs = this.deps.pollMs ?? 500;
    const deadline = Number((this.deps.db.prepare("SELECT deadline_at FROM agent_runs WHERE id=?").get(runId) as Record<string, unknown>)["deadline_at"]);
    const sessionId = session.id;
    let state = session.state, exitCode: number | null | undefined = session.exitCode;
    let unreachable = 0, beat = this.now();
    while (state !== "exited") {
      if (options.signal?.aborted) throw new Abandoned("The worker stopped while the agent was running");
      if (this.now() >= deadline) {
        await control.stop(sessionId).catch(() => undefined);
        throw new AppError("agent_timeout", unreachable
          ? "Agent run exceeded its deadline while the spawner was unreachable; a stop was requested"
          : "Agent run exceeded its deadline and was stopped");
      }
      await this.sleep(pollMs);
      // Keep the task lease alive (and learn of a cancellation) without writing on every poll.
      if (this.now() - beat >= 10_000) { options.heartbeat(); beat = this.now(); }
      let inspected;
      try { inspected = await this.deps.spawner.inspect(sessionId); }
      catch {
        // The host restarting (which keeps persistent sessions) is not the agent failing:
        // keep polling until the deadline instead of abandoning a live run.
        if (unreachable++ === 0) event(this.deps.db, "run.spawner_unreachable", "agent_run", runId, { sessionId }, this.now());
        continue;
      }
      unreachable = 0;
      if (!inspected) { this.deps.db.prepare("UPDATE agent_runs SET state='lost' WHERE id=?").run(runId); throw new AppError("agent_lost", "Agent session disappeared before completing"); }
      state = inspected.state; exitCode = inspected.exitCode;
    }
    return { exitCode };
  }

  private recordRunEvidence(runId: string, result: AgentResult): void {
    const now = new Date(this.now()).toISOString();
    (result.toolCalls ?? []).forEach((call, index) => {
      this.deps.db.prepare(`INSERT INTO tool_events(run_id,sequence,call_id,tool_id,tool_version,request_json,result_json,state,occurred_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(runId, index + 1, `call-${index + 1}`, call.toolId, TOOLS[call.toolId]?.version ?? "unknown",
        JSON.stringify(call.request ?? {}), JSON.stringify(call.result ?? null), call.state ?? "succeeded", now);
    });
    (result.messages ?? []).forEach((message, index) => {
      this.deps.db.prepare("INSERT INTO run_messages(run_id,sequence,role,content_json,occurred_at) VALUES(?,?,?,?,?)")
        .run(runId, index + 1, message.role, JSON.stringify(message.content), now);
    });
  }

}

/** The spawner idempotency key for one attempt of a stage; a retry is a different key. */
const sessionKey = (task: Task): string => `jobs:${task.id}:${(task.input as StageInput).stage}:${task.attempt}`;
