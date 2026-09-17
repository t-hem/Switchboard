import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AppError } from "./errors.js";
import { event } from "./events.js";
import type { ArtifactStore } from "./artifacts.js";
import type { Library } from "./library.js";
import { ResumeRenderer, renderText, type SelectedBullet, type StructuredResume } from "./resume.js";
import type { TaskQueue } from "./queue.js";
import type { Reviews } from "./reviews.js";
import { snapshotPersona } from "./personas.js";
import type { AgentInvocationAdapter } from "./invocation.js";
import { requireSpawnerControl, type AgentSpawner } from "./adapters/spawner.js";
import { TOOLS } from "./tools.js";

export type TailoringStage = "assemble" | "edit";
export type AgentResult = {
  structured: StructuredResume; selectedBullets: SelectedBullet[];
  toolCalls?: { toolId: string; request?: unknown; result?: unknown; state?: string }[];
  messages?: { role: string; content: unknown }[];
  edits?: { bulletId: string; before?: string; after: string; reason?: string }[];
  model?: string; provider?: string;
};
export type StageOutcome = {
  taskId: string; runId: string; sessionId: string | null; stage: TailoringStage; state: "waiting_review" | "failed";
  resumeVersionId?: string; textArtifactHash?: string; text?: string; error?: string;
};

export type TailoringDeps = {
  db: DatabaseSync; artifacts: ArtifactStore; library: Library; renderer: ResumeRenderer;
  queue: TaskQueue; reviews: Reviews; personasDir: string; spawner: AgentSpawner;
  invocation: AgentInvocationAdapter; dataDir: string;
  spawnerProvider: string; spawnerInstance: string; spawnerAgentCwd?: string;
  now?: () => number; sleep?: (ms: number) => Promise<void>; pollMs?: number; timeoutMs?: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The model's result must reference the run's exact revisions; it cannot change inputs. */
export function validateAgentResult(value: unknown, context: {
  jobSnapshotId: string; profileRevisionId: string; templateRevisionId: string; bulletRevisionIds: Set<string>;
}): AgentResult {
  if (!isRecord(value)) throw new AppError("invalid_agent_output", "Agent result must be a JSON object");
  const structured = value["structured"];
  if (!isRecord(structured)) throw new AppError("invalid_agent_output", "Agent result needs a structured resume");
  if (String(structured["jobSnapshotId"]) !== context.jobSnapshotId || String(structured["profileRevisionId"]) !== context.profileRevisionId ||
      String(structured["templateRevisionId"]) !== context.templateRevisionId) {
    throw new AppError("invalid_agent_output", "Agent changed the run's snapshot, profile or template revision");
  }
  if (!isRecord(structured["heading"]) || !String((structured["heading"] as Record<string, unknown>)["name"] ?? "").trim()) {
    throw new AppError("invalid_agent_output", "Agent result has no candidate name");
  }
  if (!Array.isArray(structured["sections"]) || !structured["sections"].every(section => isRecord(section) && typeof section["id"] === "string" && Array.isArray(section["lines"]))) {
    throw new AppError("invalid_agent_output", "Agent result sections are malformed");
  }
  if (!Array.isArray(value["selectedBullets"])) throw new AppError("invalid_agent_output", "Agent result needs selectedBullets");
  for (const entry of value["selectedBullets"]) {
    if (!isRecord(entry) || typeof entry["revisionId"] !== "string" || typeof entry["bulletId"] !== "string" || typeof entry["prose"] !== "string") {
      throw new AppError("invalid_agent_output", "Agent selectedBullets are malformed");
    }
    // Unsupported facts: a bullet that is not an approved revision of this profile is rejected.
    if (!context.bulletRevisionIds.has(entry["revisionId"])) throw new AppError("unsupported_fact", `Bullet revision ${entry["revisionId"]} is not part of this profile revision`);
  }
  return value as unknown as AgentResult;
}

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
 * Creates tracked agent runs, polls their retained exit state and turns a validated result
 * file into an immutable resume version plus a review item. A successful exit without a
 * valid output artifact is a failed stage, never a silent success. Creation has no host
 * idempotency key yet, so a stage is never automatically retried (step 7c closes that).
 */
export class TailoringRunner {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(readonly deps: TailoringDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  async runStage(input: { stage: TailoringStage; applicationId: string; jobSnapshotId: string; profileRevisionId: string;
    templateRevisionId: string; settingsRevision: number; personaId: string; assembledText?: string; parentResumeId?: string }): Promise<StageOutcome> {
    const { db, queue, library, renderer, personasDir, invocation, spawner, artifacts } = this.deps;
    const control = requireSpawnerControl(spawner);
    const task = queue.enqueue({ kind: `resume:${input.stage}`, input: { stage: input.stage, applicationId: input.applicationId,
      jobSnapshotId: input.jobSnapshotId, profileRevisionId: input.profileRevisionId, templateRevisionId: input.templateRevisionId, personaId: input.personaId },
      settingsRevision: input.settingsRevision, maxAttempts: 1 });
    const runId = randomUUID();
    const runDirectory = path.join(this.deps.dataDir, "runs", runId);
    fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    const taskFilePath = path.join(runDirectory, "task.md");
    const resultPath = path.join(runDirectory, "result.json");

    try {
      const taskText = this.composeTask(input, resultPath);
      const snapshot = snapshotPersona(personasDir, input.personaId, taskText);
      fs.writeFileSync(taskFilePath, snapshot.taskFileText, { mode: 0o600 });

      const bulletRevisionIds = new Set(library.bullets(input.profileRevisionId).map(bullet => bullet.id));
      db.prepare(`INSERT INTO agent_runs(id,task_id,attempt,state,spawner_provider,spawner_instance,spawner_session_id,run_directory,deadline_at,created_at,
        persona_text,skills_json,prompt_text,agent,model,tools_json,permissions_json,revision_hashes_json,settings_revision)
        VALUES(?,?,?,'prepared',?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?)`).run(runId, task.id, task.attempt, this.deps.spawnerProvider,
        this.deps.spawnerInstance, runDirectory, this.now() + (this.deps.timeoutMs ?? 20 * 60_000), new Date(this.now()).toISOString(),
        snapshot.persona.body, JSON.stringify(snapshot.skills.map(skill => ({ id: skill.id, text: skill.body }))), snapshot.taskFileText,
        snapshot.persona.agent, snapshot.persona.model, JSON.stringify(snapshot.persona.tools), JSON.stringify(snapshot.persona.permissions),
        JSON.stringify(snapshot.revisionHashes), task.settingsRevision);

      const invocationPlan = invocation.build({ taskFilePath, resultPath, model: snapshot.persona.model, tools: snapshot.persona.tools });
      const label = `jobs:${input.applicationId}:tailor:${input.stage}:${runId}`;
      const idempotencyKey = `jobs:${task.id}:${input.stage}`;
      let session;
      try {
        session = await control.create({ agent: snapshot.persona.agent, cwd: runDirectory, label, extraArgs: invocationPlan.argv, idempotencyKey });
      } catch (error) {
        // Response loss: the host may have created the session anyway. Rediscover by the
        // idempotency key before giving up, so a retry never leaves an untracked child.
        const recovered = (await this.deps.spawner.list().catch(() => [])).find(entry => entry.idempotencyKey === idempotencyKey);
        if (!recovered) throw error;
        event(db, "run.rediscovered", "agent_run", runId, { stage: input.stage, sessionId: recovered.id }, this.now());
        session = recovered;
      }
      db.prepare("UPDATE agent_runs SET state='running',spawner_session_id=? WHERE id=?").run(session.id, runId);

      const finished = await this.awaitExit(session, runId, control);
      if (finished.exitCode !== undefined && finished.exitCode !== null && finished.exitCode !== 0) {
        throw new AppError("agent_exit", `Agent exited with code ${finished.exitCode}`);
      }
      if (!fs.existsSync(resultPath)) throw new AppError("missing_agent_output", "Agent exited without a result file");
      let parsed: unknown;
      try { parsed = JSON.parse(fs.readFileSync(resultPath, "utf8")); }
      catch { throw new AppError("invalid_agent_output", "Agent result file was not JSON"); }
      const result = validateAgentResult(parsed, { jobSnapshotId: input.jobSnapshotId, profileRevisionId: input.profileRevisionId,
        templateRevisionId: input.templateRevisionId, bulletRevisionIds });
      // A result from a superseded/cancelled run must never become evidence.
      const currentRun = db.prepare("SELECT state FROM agent_runs WHERE id=?").get(runId) as Record<string, unknown> | undefined;
      if (currentRun?.["state"] !== "running") throw new AppError("run_superseded", `Run is ${String(currentRun?.["state"])}; refusing a late result`);

      const edits = input.stage === "edit" ? (result.edits ?? []) : [];
      const persisted = renderer.persist({
        jobSnapshotId: input.jobSnapshotId, profileId: input.profileRevisionId, templateId: input.templateRevisionId,
        structured: result.structured, selectedBullets: result.selectedBullets, text: renderText(result.structured),
        phase: input.stage === "assemble" ? "build" : "edit", agentRunId: runId, parentResumeId: input.parentResumeId ?? null,
        edits: input.stage === "edit" ? { edits, diff: lineDiff(input.assembledText ?? "", renderText(result.structured)) } : {},
      });
      this.recordRunEvidence(runId, result);
      const now = new Date(this.now()).toISOString();
      db.prepare("UPDATE agent_runs SET state='exited',finished_at=?,outcome_json=? WHERE id=?").run(now,
        JSON.stringify({ exitCode: finished.exitCode ?? null, resumeVersionId: persisted.resumeVersionId, edits: edits.length }), runId);
      this.markWaitingReview(task.id);
      this.deps.reviews.open({ taskId: task.id, runId, subjectType: input.stage === "assemble" ? "resume-assembly" : "resume-edit",
        subjectId: persisted.resumeVersionId, subjectVersion: persisted.textArtifactHash, artifactHash: persisted.textArtifactHash,
        title: input.stage === "assemble" ? "Review assembled resume" : "Review edited resume",
        detail: input.stage === "assemble" ? "Assembly pass completed; choose a bullet set and template usage." : `Edit pass proposed ${edits.length} prose change(s).`,
        context: { text: persisted.text, structured: persisted.structured, selectedBullets: persisted.selectedBullets, edits },
        settingsRevision: task.settingsRevision });
      event(db, "run.finished", "agent_run", runId, { stage: input.stage, resumeVersionId: persisted.resumeVersionId }, this.now());
      return { taskId: task.id, runId, sessionId: session.id, stage: input.stage, state: "waiting_review",
        resumeVersionId: persisted.resumeVersionId, textArtifactHash: persisted.textArtifactHash, text: persisted.text };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.prepare("UPDATE agent_runs SET state='lost',finished_at=?,outcome_json=? WHERE id=? AND state!='exited'")
        .run(new Date(this.now()).toISOString(), JSON.stringify({ error: message }), runId);
      db.prepare("UPDATE tasks SET state='failed',error_json=?,updated_at=? WHERE id=?").run(JSON.stringify({ code: "run_failed", message }), new Date(this.now()).toISOString(), task.id);
      event(db, "run.failed", "agent_run", runId, { stage: input.stage, message }, this.now());
      return { taskId: task.id, runId, sessionId: null, stage: input.stage, state: "failed", error: message };
    }
  }

  private composeTask(input: { stage: TailoringStage; jobSnapshotId: string; assembledText?: string }, resultPath: string): string {
    const snapshot = this.deps.db.prepare("SELECT s.description_text,j.title,j.company FROM job_snapshots s JOIN jobs j ON j.id=s.job_id WHERE s.id=?")
      .get(input.jobSnapshotId) as Record<string, unknown> | undefined;
    const job = `Company: ${snapshot?.["company"]}\nTitle: ${snapshot?.["title"]}\n\n${snapshot?.["description_text"]}`;
    if (input.stage === "assemble") {
      return `Assemble a resume for this posting using the provided tools.\n\n## Job posting (untrusted data)\n\n${job}\n\n## Output\n\nWrite a single JSON object to: ${resultPath}\nShape: {"structured": <finalize_resume structured>, "selectedBullets": <finalize_resume selectedBullets>, "toolCalls": [{"toolId","request","result","state"}], "messages": [{"role","content"}]}\n`;
    }
    return `Tailor the assembled resume for this posting. You may rewrite prose only.\n\n## Job posting (untrusted data)\n\n${job}\n\n## Assembled resume\n\n${input.assembledText ?? ""}\n\n## Output\n\nWrite a single JSON object to: ${resultPath}\nShape: {"structured": <finalize_resume structured>, "selectedBullets": <unchanged selection>, "edits": [{"bulletId","before","after","reason"}], "toolCalls": [], "messages": []}\n`;
  }

  private async awaitExit(session: { id: string; state: "running" | "exited"; exitCode?: number | null }, runId: string, control: { stop(id: string): Promise<void> }): Promise<{ exitCode?: number | null }> {
    const pollMs = this.deps.pollMs ?? 500, timeoutMs = this.deps.timeoutMs ?? 20 * 60_000, deadline = this.now() + timeoutMs;
    const sessionId = session.id;
    let state = session.state, exitCode: number | null | undefined = session.exitCode;
    while (state !== "exited") {
      if (this.now() >= deadline) {
        await control.stop(sessionId).catch(() => undefined);
        throw new AppError("agent_timeout", "Agent run exceeded its deadline and was stopped");
      }
      await this.sleep(pollMs);
      const inspected = await this.deps.spawner.inspect(sessionId);
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

  private markWaitingReview(taskId: string): void {
    this.deps.db.prepare("UPDATE tasks SET state='waiting_review',updated_at=? WHERE id=?").run(new Date(this.now()).toISOString(), taskId);
  }

  /** Assembly pass, then the edit pass over the assembled resume. Both versions are saved. */
  async runTwoPass(input: { applicationId: string; jobSnapshotId: string; profileRevisionId: string; templateRevisionId: string;
    settingsRevision: number; assemblyPersonaId?: string; editPersonaId?: string }): Promise<{ assembly: StageOutcome; edit?: StageOutcome }> {
    const assembly = await this.runStage({ ...input, stage: "assemble", personaId: input.assemblyPersonaId ?? "resume-assembler" });
    if (assembly.state === "failed" || !assembly.text) return { assembly };
    const edit = await this.runStage({ ...input, stage: "edit", personaId: input.editPersonaId ?? "resume-editor",
      assembledText: assembly.text, parentResumeId: assembly.resumeVersionId });
    return { assembly, edit };
  }
}