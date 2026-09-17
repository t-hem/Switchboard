import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { SettingsStore } from "./store.js";
import { transaction } from "./database.js";
import { event } from "./events.js";
import { AppError } from "./errors.js";
import type { ArtifactStore } from "./artifacts.js";
import { Reviews } from "./reviews.js";
import { TaskQueue } from "./queue.js";
import type { HttpClient } from "./net.js";
import { createApplicationAdapter, type ApplicationAdapter, type FileUpload, type FormSession } from "./adapters/application.js";

export const MAX_CAPTURE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type PreparationOutcome = {
  attemptId: string | null;
  created: boolean;
  state: "draft" | "needs_input" | "blocked";
  code?: string;
  detail?: string;
  manifest?: Record<string, unknown>;
};

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const resumeFilename = (applicationId: string): string => `resume-${applicationId.slice(0, 8)}.txt`;

/**
 * Prepares an application up to (but never past) human review. It refreshes and verifies
 * the evidence, inspects the form, fills what policy and answers permit, and assembles an
 * immutable attempt manifest. Anything missing or ambiguous blocks or asks for input; it
 * never submits.
 */
export class PreparationService {
  private readonly now: () => number;
  constructor(private readonly deps: { store: SettingsStore; db: DatabaseSync; artifacts: ArtifactStore; http: HttpClient; now?: () => number; maxCaptureAgeMs?: number; /** Opened only when an adapter needs the supervised browser; always closed. */ createSession?: () => FormSession }) {
    this.now = deps.now ?? Date.now;
    this.captureAge = deps.maxCaptureAgeMs ?? MAX_CAPTURE_AGE_MS;
  }
  private readonly captureAge: number;

  async prepare(input: { applicationId: string; adapterId: string; adapterOptions?: Record<string, unknown>; formUrl: string;
    answers: Record<string, string>; settingsRevision: number; allowPrivate?: boolean }): Promise<PreparationOutcome> {
    const { db } = this.deps;
    const application = db.prepare("SELECT id,job_id,selected_resume_id,state FROM applications WHERE id=?").get(input.applicationId) as Record<string, unknown> | undefined;
    if (!application) throw new AppError("application_missing", "Application not found", 404);

    const blocked = (code: string, detail: string): PreparationOutcome => this.#block(input, code, detail);

    // 1. Evidence must exist, be complete, be fresh, and verify.
    const snapshot = db.prepare(`SELECT id,purpose,completeness,content_hash,screenshot_hash,captured_at FROM job_snapshots
      WHERE job_id=? AND completeness='complete' ORDER BY captured_at DESC, rowid DESC LIMIT 1`).get(String(application["job_id"])) as Record<string, unknown> | undefined;
    if (!snapshot) return blocked("missing_evidence", "No complete posting capture exists for this job");
    const capturedAt = Date.parse(String(snapshot["captured_at"]));
    if (!Number.isFinite(capturedAt) || this.now() - capturedAt > this.captureAge) return blocked("stale_capture", "The posting capture is older than the freshness window; recapture before preparing");
    const resumeId = application["selected_resume_id"] === null ? null : String(application["selected_resume_id"]);
    if (!resumeId) return blocked("missing_resume", "Select a resume version before preparing");
    const resume = db.prepare("SELECT id,text_artifact_hash FROM resume_versions WHERE id=?").get(resumeId) as Record<string, unknown> | undefined;
    if (!resume) return blocked("missing_resume", "The selected resume version no longer exists");
    let resumeBytes: Buffer;
    try { resumeBytes = this.deps.artifacts.read(String(resume["text_artifact_hash"])); } // verifies size + hash
    catch { return blocked("corrupt_resume", "The selected resume artifact is missing or corrupt; workflow remains blocked"); }

    const adapter = createApplicationAdapter(input.adapterId, input.adapterOptions);
    if (!adapter.capabilities.prepare) return this.#handoff(input, adapter, "manual_handoff", "This adapter has no form automation; complete the form manually", snapshot, resumeId);

    // Identical inputs reuse the same draft and never touch the browser twice. Answers are
    // part of the key, so changing them invalidates a prior review rather than silently reusing it.
    const idempotencyKey = this.#idempotencyKey(input, snapshot, resume);
    const existing = db.prepare("SELECT id,manifest_json FROM application_attempts WHERE idempotency_key=?").get(idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) return { attemptId: String(existing["id"]), created: false, state: "draft", manifest: JSON.parse(String(existing["manifest_json"])) as Record<string, unknown> };

    const session = this.deps.createSession?.() ?? undefined;
    const context = { http: this.deps.http, allowPrivate: input.allowPrivate === true, session };
    try {
      let inspection;
      try { inspection = await adapter.inspect(input.formUrl, context); }
      catch (error) { return blocked("form_unavailable", error instanceof Error ? error.message : String(error)); }
      if (inspection.captcha) return this.#handoff(input, adapter, "captcha", "The form presents a CAPTCHA; complete it manually", snapshot, resumeId, inspection.formUrl);
      if (inspection.automationForbidden) return this.#handoff(input, adapter, "forbidden_automation", "Automation is not permitted for this target", snapshot, resumeId, inspection.formUrl);

      const resumeUpload: FileUpload = { field: "resume", artifactHash: String(resume["text_artifact_hash"]), filename: resumeFilename(String(application["id"])),
        mimeType: "text/plain", localPath: this.#stageResume(String(application["id"]), resumeBytes) };
      const prepared = await adapter.prepare({ inspection, answers: input.answers, resume: resumeUpload }, context);
      if (prepared.missing.length) return blocked("unsupported_required_fields", `Required fields could not be filled: ${prepared.missing.join(", ")}`);

      const manifest: Record<string, unknown> = {
        applicationId: application["id"], jobId: application["job_id"],
        snapshotId: snapshot["id"], snapshotContentHash: snapshot["content_hash"], snapshotCapturedAt: snapshot["captured_at"],
        resumeVersionId: resumeId, resumeTextHash: resume["text_artifact_hash"], resumeBytes: resumeBytes.byteLength,
        settingsRevision: input.settingsRevision, adapterId: adapter.id, adapterVersion: adapter.version,
        formUrl: inspection.formUrl, finalUrl: inspection.finalUrl, fields: inspection.fields,
        filled: prepared.filled, uploads: prepared.uploads, answers: input.answers,
        preparedAt: new Date(this.now()).toISOString(), status: "draft",
      };
      const manifestHash = digest(manifest);

      return transaction(this.deps.db, () => {
        const policyId = this.#policy(adapter.id, inspection.formUrl);
        const attemptId = randomUUID();
        const time = new Date(this.now()).toISOString();
        db.prepare(`INSERT INTO application_attempts(id,application_id,idempotency_key,adapter_id,state,snapshot_id,resume_id,settings_revision,policy_id,manifest_json,preflight_at,created_at)
          VALUES(?,?,?,?,'draft',?,?,?,?,?,?,?)`).run(attemptId, String(application["id"]), idempotencyKey, adapter.id, String(snapshot["id"]), resumeId,
          input.settingsRevision, policyId, JSON.stringify({ ...manifest, manifestHash }), time, time);
        // Different evidence or answers supersede a prior approval; it can never carry over to a send.
        const superseded = db.prepare("UPDATE application_attempts SET state='cancelled' WHERE application_id=? AND state='approved'").run(String(application["id"]));
        if (Number(superseded.changes) > 0) event(db, "application.approval_invalidated", "application", String(application["id"]), { byAttemptId: attemptId, manifestHash }, this.now());
        db.prepare("UPDATE applications SET state='review_required',block_reason=NULL,updated_at=? WHERE id=? AND state IN('discovered','captured','screened','preparing','needs_input','review_required','approved')")
          .run(time, String(application["id"]));
        event(db, "application.prepared", "application", String(application["id"]), { attemptId, manifestHash, adapterId: adapter.id }, this.now());
        return { attemptId, created: true, state: "draft", manifest: { ...manifest, manifestHash } };
      });
    } finally {
      // The supervised browser session never outlives one preparation.
      await session?.close().catch(() => undefined);
    }
  }

  /**
   * The artifact store is content-addressed, so a raw artifact path would present the site
   * a file named after its digest. Stage a verified copy under the application's own name
   * and upload that; the manifest still records the artifact hash the bytes must match.
   */
  #stageResume(applicationId: string, bytes: Buffer): string {
    const directory = path.join(this.deps.artifacts.root, "uploads");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, resumeFilename(applicationId));
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    return file;
  }

  #idempotencyKey(input: { applicationId: string; adapterId: string; formUrl: string; answers: Record<string, string>; settingsRevision: number },
    snapshot: Record<string, unknown>, resume: Record<string, unknown>): string {
    const answersHash = digest(Object.keys(input.answers).sort().map(key => [key, input.answers[key]]));
    return digest({ applicationId: input.applicationId, snapshot: snapshot["content_hash"], resume: resume["text_artifact_hash"],
      settingsRevision: input.settingsRevision, adapterId: input.adapterId, formUrl: input.formUrl, answersHash });
  }

  /** A handoff is a durable inbox item, not an alert: resume, answers and URL included. */
  #handoff(input: { applicationId: string; formUrl: string; answers: Record<string, string>; settingsRevision: number },
    adapter: ApplicationAdapter, code: string, detail: string, snapshot: Record<string, unknown>, resumeId: string, formUrl = input.formUrl): PreparationOutcome {
    return this.#recordNeedsInput(input, adapter, code, detail, { snapshotId: snapshot["id"], resumeVersionId: resumeId, formUrl });
  }

  #block(input: { applicationId: string; settingsRevision: number }, code: string, detail: string): PreparationOutcome {
    const time = new Date(this.now()).toISOString();
    transaction(this.deps.db, () => {
      this.deps.db.prepare("UPDATE applications SET state='needs_input',block_reason=?,updated_at=? WHERE id=? AND state IN('discovered','captured','screened','preparing','needs_input','review_required')")
        .run(`${code}: ${detail}`.slice(0, 500), time, input.applicationId);
      event(this.deps.db, "application.blocked", "application", input.applicationId, { code, detail }, this.now());
    });
    return { attemptId: null, created: false, state: "blocked", code, detail };
  }

  #recordNeedsInput(input: { applicationId: string; formUrl: string; answers: Record<string, string>; settingsRevision: number },
    adapter: ApplicationAdapter, code: string, detail: string, context: Record<string, unknown>): PreparationOutcome {
    const db = this.deps.db;
    const queue = new TaskQueue(db), reviews = new Reviews(db);
    const task = queue.enqueue({ kind: "application:needs-input", input: { applicationId: input.applicationId, code, ...context }, settingsRevision: input.settingsRevision, maxAttempts: 1 });
    const time = new Date(this.now()).toISOString();
    transaction(db, () => {
      db.prepare("UPDATE tasks SET state='waiting_review',updated_at=? WHERE id=?").run(time, task.id);
      db.prepare("UPDATE applications SET state='needs_input',block_reason=?,updated_at=? WHERE id=? AND state IN('discovered','captured','screened','preparing','needs_input','review_required')")
        .run(`${code}: ${detail}`.slice(0, 500), time, input.applicationId);
    });
    reviews.open({ taskId: task.id, subjectType: "application-handoff", subjectId: input.applicationId, subjectVersion: `${code}:${context["snapshotId"]}`,
      title: `${adapter.id}: ${code}`, detail,
      context: { ...context, formUrl: context["formUrl"] ?? input.formUrl, answers: input.answers, adapterId: adapter.id, adapterVersion: adapter.version },
      settingsRevision: input.settingsRevision });
    event(db, "application.needs_input", "application", input.applicationId, { code, taskId: task.id }, this.now());
    return { attemptId: null, created: true, state: "needs_input", code, detail };
  }

  #policy(adapterId: string, formUrl: string): string {
    const scopeKey = `${adapterId}:${(() => { try { return new URL(formUrl).host; } catch { return formUrl; } })()}`;
    const existing = this.deps.db.prepare("SELECT id FROM source_policies WHERE scope_key=? ORDER BY revision DESC LIMIT 1").get(scopeKey) as Record<string, unknown> | undefined;
    if (existing) return String(existing["id"]);
    const id = randomUUID();
    this.deps.db.prepare(`INSERT INTO source_policies(id,scope_key,revision,adapter_id,site_url,terms_url,reviewed_at,capabilities_json,restrictions_json,created_at)
      VALUES(?,?,1,?,?,NULL,NULL,?,?,?)`).run(id, scopeKey, adapterId, formUrl,
      JSON.stringify({ prepare: true, fill: true, upload: true, submit: false }),
      JSON.stringify({ submit: "requires explicit operator approval (step 10)" }), new Date(this.now()).toISOString());
    return id;
  }
}
