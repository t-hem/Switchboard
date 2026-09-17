import { randomUUID } from "node:crypto";
import { jsonDigest as digest } from "./evidence.js";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./database.js";
import { TaskQueue } from "./queue.js";
import { event } from "./events.js";
import { AppError } from "./errors.js";
import { type ArtifactStore } from "./artifacts.js";

/** Stable hash of any JSON value; used to detect a changed manifest or reviewed field. */

/** The fields whose change invalidates a prior review; anything here must be re-reviewed. */
const REVIEWED_FIELDS = ["snapshotContentHash", "resumeTextHash", "settingsRevision", "adapterId", "adapterVersion", "formUrl", "answers", "filled", "uploads"] as const;
export type HandoffContext = { applicationId: string; adapterId?: string; formUrl: string; answers: Record<string, string>; snapshotId?: string; resumeVersionId?: string; code?: string };

/**
 * Approval, review packages and operator reconciliation. An approval is bound to one
 * attempt's manifest hash, and preparing anything with different evidence or answers
 * cancels it, so a stale approval can never carry over to a send.
 */
export class Applications {
  private readonly now: () => number;
  constructor(private readonly deps: { db: DatabaseSync; artifacts: ArtifactStore; now?: () => number }) { this.now = deps.now ?? Date.now; }

  #attempt(attemptId: string): Record<string, unknown> {
    const attempt = this.deps.db.prepare("SELECT * FROM application_attempts WHERE id=?").get(attemptId) as Record<string, unknown> | undefined;
    if (!attempt) throw new AppError("attempt_missing", "Application attempt not found", 404);
    return attempt;
  }

  approve(attemptId: string, input: { expectedManifestHash: string; reason: string; settingsRevision: number }): { attemptId: string; state: string; manifestHash: string } {
    const db = this.deps.db, attempt = this.#attempt(attemptId);
    const manifest = JSON.parse(String(attempt["manifest_json"])) as Record<string, unknown>;
    const manifestHash = String(manifest["manifestHash"] ?? "");
    if (input.expectedManifestHash !== manifestHash)
      throw new AppError("manifest_changed", "The prepared manifest no longer matches the reviewed one; review the current package before approving", 409);
    if (attempt["state"] !== "draft")
      throw new AppError("attempt_not_reviewable", `Attempt is ${String(attempt["state"])}; only a draft can be approved`, 409);
    const time = new Date(this.now()).toISOString();
    return transaction(db, () => {
      db.prepare("UPDATE application_attempts SET state='approved' WHERE id=? AND state='draft'").run(attemptId);
      db.prepare("UPDATE applications SET state='approved', block_reason=NULL, updated_at=? WHERE id=?").run(time, String(attempt["application_id"]));
      db.prepare(`INSERT INTO review_decisions(id,subject_type,subject_id,subject_version,decision,reason,before_json,after_json,settings_revision,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), "application-attempt", attemptId, manifestHash, "approve", input.reason,
        JSON.stringify({ state: "draft" }), JSON.stringify({ state: "approved" }), input.settingsRevision, time);
      event(db, "application.approved", "application", String(attempt["application_id"]), { attemptId, manifestHash }, this.now());
      return { attemptId, state: "approved", manifestHash };
    });
  }

  /**
   * Choosing which resume an application uses is an ordinary operator act. The resume must
   * have been built for a capture of this same job, so a resume can never be crossed over
   * between postings by mistake.
   */
  selectResume(applicationId: string, resumeVersionId: string): { applicationId: string; resumeVersionId: string } {
    const db = this.deps.db;
    const application = db.prepare("SELECT id,job_id FROM applications WHERE id=?").get(applicationId) as Record<string, unknown> | undefined;
    if (!application) throw new AppError("application_missing", "Application not found", 404);
    const resume = db.prepare("SELECT id,job_snapshot_id FROM resume_versions WHERE id=?").get(resumeVersionId) as Record<string, unknown> | undefined;
    if (!resume) throw new AppError("resume_missing", "Resume version not found", 404);
    const snapshot = db.prepare("SELECT job_id FROM job_snapshots WHERE id=?").get(String(resume["job_snapshot_id"])) as Record<string, unknown> | undefined;
    if (!snapshot || String(snapshot["job_id"]) !== String(application["job_id"]))
      throw new AppError("resume_mismatch", "That resume was built for a different posting", 409);
    const time = new Date(this.now()).toISOString();
    transaction(db, () => {
      db.prepare("UPDATE applications SET selected_resume_id=?, updated_at=? WHERE id=?").run(resumeVersionId, time, applicationId);
      event(db, "application.resume_selected", "application", applicationId, { resumeVersionId }, this.now());
    });
    return { applicationId, resumeVersionId };
  }

  /** An operator-reported completion is evidence, not an inference: the receipt is stored verbatim. */
  manualCompletion(applicationId: string, input: { detail: string; receiptText?: string; settingsRevision: number }): { attemptId: string; created: boolean } {
    const db = this.deps.db;
    const application = db.prepare("SELECT * FROM applications WHERE id=?").get(applicationId) as Record<string, unknown> | undefined;
    if (!application) throw new AppError("application_missing", "Application not found", 404);
    const snapshot = db.prepare("SELECT id FROM job_snapshots WHERE job_id=? AND completeness='complete' ORDER BY captured_at DESC, rowid DESC LIMIT 1").get(String(application["job_id"])) as Record<string, unknown> | undefined;
    if (!snapshot) throw new AppError("missing_evidence", "Record a complete posting capture before reporting a manual completion", 409);
    const resumeId = application["selected_resume_id"] === null ? null : String(application["selected_resume_id"]);
    if (!resumeId) throw new AppError("missing_resume", "Select a resume version before reporting a manual completion", 409);
    const idempotencyKey = digest({ manual: applicationId, detail: input.detail });
    const existing = db.prepare("SELECT id FROM application_attempts WHERE idempotency_key=?").get(idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) return { attemptId: String(existing["id"]), created: false };
    const receipt = input.receiptText ? this.deps.artifacts.put(Buffer.from(input.receiptText, "utf8"), "text/plain", "application-receipt") : null;
    const policyId = this.#manualPolicy();
    const time = new Date(this.now()).toISOString(), attemptId = randomUUID();
    const manifest = { method: "manual", applicationId, detail: input.detail, receiptHash: receipt?.hash ?? null, reportedAt: time, status: "submitted" };
    return transaction(db, () => {
      db.prepare(`INSERT INTO application_attempts(id,application_id,idempotency_key,adapter_id,state,snapshot_id,resume_id,settings_revision,policy_id,manifest_json,preflight_at,send_started_at,finished_at,outcome_json,receipt_hash,created_at)
        VALUES(?,?,?,'manual','submitted',?,?,?,?,?,?,?,?,?,?,?)`).run(attemptId, applicationId, idempotencyKey, String(snapshot["id"]), resumeId, input.settingsRevision, policyId,
        JSON.stringify(manifest), time, time, time, JSON.stringify({ outcome: "submitted", method: "manual", detail: input.detail }), receipt?.hash ?? null, time);
      db.prepare("UPDATE applications SET state='submitted', block_reason=NULL, updated_at=? WHERE id=?").run(time, applicationId);
      event(db, "application.manual_completion", "application", applicationId, { attemptId, receiptHash: receipt?.hash ?? null }, this.now());
      return { attemptId, created: true };
    });
  }

  /** Everything the operator needs to review: posting evidence, resume, answers, and what changed. */
  packageOf(applicationId: string): Record<string, unknown> {
    const db = this.deps.db;
    const application = db.prepare("SELECT * FROM applications WHERE id=?").get(applicationId) as Record<string, unknown> | undefined;
    if (!application) throw new AppError("application_missing", "Application not found", 404);
    // The posting link and its source come from the job's alias, not the jobs row.
    const job = db.prepare(`SELECT j.id,j.company,j.title,j.location,j.canonical_url,j.last_seen_at,
      (SELECT a.original_url FROM job_aliases a WHERE a.job_id=j.id ORDER BY a.rowid LIMIT 1) AS original_url,
      (SELECT a.source_id FROM job_aliases a WHERE a.job_id=j.id ORDER BY a.rowid LIMIT 1) AS source_id
      FROM jobs j WHERE j.id=?`).get(String(application["job_id"]));
    const snapshot = db.prepare("SELECT id,purpose,completeness,content_hash,screenshot_hash,description_text,fetched_url,final_url,captured_at,failure_detail FROM job_snapshots WHERE job_id=? ORDER BY captured_at DESC, rowid DESC LIMIT 1").get(String(application["job_id"]));
    const resume = application["selected_resume_id"] === null ? null : db.prepare("SELECT * FROM resume_versions WHERE id=?").get(String(application["selected_resume_id"]));
    const agentRun = resume ? db.prepare("SELECT id,state,agent,model,spawner_provider,spawner_session_id,created_at,finished_at FROM agent_runs WHERE id=?").get(String((resume as Record<string, unknown>)["agent_run_id"] ?? "")) ?? null : null;
    const attemptRow = db.prepare("SELECT * FROM application_attempts WHERE application_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(applicationId) as Record<string, unknown> | undefined;
    const attempt = attemptRow ? { ...attemptRow, manifest: JSON.parse(String(attemptRow["manifest_json"])) as Record<string, unknown> } : null;
    const current = attemptRow?.["manifest_json"] ? JSON.parse(String(attemptRow["manifest_json"])) as Record<string, unknown> : null;
    // The approval record lives in review_decisions, so an invalidated approval is still
    // visible and queryable after its attempt is superseded.
    const decision = db.prepare(`SELECT subject_id,subject_version,created_at FROM review_decisions WHERE subject_type='application-attempt'
      AND subject_id IN (SELECT id FROM application_attempts WHERE application_id=?) ORDER BY created_at DESC LIMIT 1`).get(applicationId) as Record<string, unknown> | undefined;
    const approvedRow = decision ? db.prepare("SELECT * FROM application_attempts WHERE id=?").get(String(decision["subject_id"])) as Record<string, unknown> | undefined : undefined;
    const approvedManifest = approvedRow ? JSON.parse(String(approvedRow["manifest_json"])) as Record<string, unknown> : null;
    const approval = decision && approvedManifest
      ? { attemptId: decision["subject_id"], manifestHash: decision["subject_version"], approvedAt: decision["created_at"], reason: "recorded approval",
        current: String(decision["subject_id"]) === String(attemptRow?.["id"]) && attemptRow?.["state"] === "approved" }
      : null;
    // Every resume built for this job's captures, so the operator can choose one.
    const availableResumes = db.prepare(`SELECT r.id,r.phase,r.created_at,r.parent_resume_id,r.agent_run_id,r.text_artifact_hash,r.pdf_artifact_hash
      FROM resume_versions r JOIN job_snapshots s ON s.id=r.job_snapshot_id WHERE s.job_id=? ORDER BY r.created_at DESC, r.rowid DESC LIMIT 50`).all(String(application["job_id"]));
    return {
      application, job: job ?? null, snapshot: snapshot ?? null, resume: resume ?? null, availableResumes, agentRun, attempt, approval,
      changesSinceReview: approvedManifest && current ? this.#changes(approvedManifest, current) : null,
      handoff: this.openHandoff(applicationId),
    };
  }

  openHandoff(applicationId: string, code?: string): HandoffContext | null {
    const row = this.deps.db.prepare(`SELECT id,context_json,title FROM attention_items WHERE subject_type='application-handoff' AND subject_id=? AND state='open'
      ORDER BY created_at DESC LIMIT 1`).get(applicationId) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (code && !String(row["title"]).includes(code)) return null;
    return { ...(JSON.parse(String(row["context_json"])) as HandoffContext), applicationId };
  }

  /** Resolving a block is an operator decision recorded as an event; the caller re-prepares. */
  resolveHandoff(applicationId: string, input: { code?: string; note: string }): { handoffId: string } {
    const db = this.deps.db;
    const row = db.prepare(`SELECT id,task_id,context_json FROM attention_items WHERE subject_type='application-handoff' AND subject_id=? AND state='open'
      ORDER BY created_at DESC LIMIT 1`).get(applicationId) as Record<string, unknown> | undefined;
    if (!row) throw new AppError("handoff_missing", "There is no open handoff for this application", 404);
    const time = new Date(this.now()).toISOString();
    const handoffId = String(row["id"]);
    transaction(db, () => {
      db.prepare("UPDATE attention_items SET state='resolved', version=version+1, updated_at=? WHERE id=? AND state='open'").run(time, handoffId);
      // The task existed only to wait on this handoff, so resolving it finishes the task.
      new TaskQueue(db).settleReview(String(row["task_id"]), "succeeded", this.now());
      event(db, "application.handoff_resolved", "application", applicationId, { handoffId, code: input.code ?? null, note: input.note }, this.now());
    });
    return { handoffId };
  }

  #changes(reviewed: Record<string, unknown>, current: Record<string, unknown>): { field: string; before: unknown; after: unknown }[] {
    return REVIEWED_FIELDS.filter(field => digest(reviewed[field] ?? null) !== digest(current[field] ?? null))
      .map(field => ({ field, before: reviewed[field] ?? null, after: current[field] ?? null }));
  }

  #manualPolicy(): string {
    const db = this.deps.db;
    const existing = db.prepare("SELECT id FROM source_policies WHERE scope_key='manual:operator' ORDER BY revision DESC LIMIT 1").get() as Record<string, unknown> | undefined;
    if (existing) return String(existing["id"]);
    const id = randomUUID();
    db.prepare(`INSERT INTO source_policies(id,scope_key,revision,adapter_id,site_url,terms_url,reviewed_at,capabilities_json,restrictions_json,created_at)
      VALUES(?,?,1,'manual','manual://operator',NULL,NULL,?,?,?)`).run(id, "manual:operator",
      JSON.stringify({ prepare: false, fill: false, upload: false, submit: false, reconcile: false }),
      JSON.stringify({ submission: "operator-reported only; the service never sends" }), new Date(this.now()).toISOString());
    return id;
  }
}
