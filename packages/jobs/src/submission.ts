import type { DatabaseSync } from "node:sqlite";
import type { SettingsStore } from "./store.js";
import { transaction } from "./database.js";
import { event } from "./events.js";
import { AppError, NothingSentError, SourceError } from "./errors.js";
import type { ArtifactStore } from "./artifacts.js";
import { Reviews } from "./reviews.js";
import { TaskQueue } from "./queue.js";
import type { HttpClient } from "./net.js";
import { Policies, type Policy } from "./policies.js";
import { createApplicationAdapter, type ApplicationAdapter, type FormSession, type SubmitOutcome } from "./adapters/application.js";
import { MAX_CAPTURE_AGE_MS, resumeUpload } from "./evidence.js";

/** How long a `submitting` attempt may stay unresolved before it is honestly called unknown. */
export const SUBMISSION_GRACE_MS = 10 * 60 * 1000;
export { MAX_CAPTURE_AGE_MS } from "./evidence.js";

export type Gate = { code: string; detail: string };
export type SubmitResult = { attemptId: string; state: string; outcome: string | null; receiptHash: string | null;
  externalId: string | null; blocked: Gate | null; reconciledFrom?: string };


/** Wraps a form session so the service knows whether the adapter pressed the submit control. */
function trackSubmit(inner: FormSession): { session: FormSession; pressed: () => boolean } {
  let pressed = false;
  const session: FormSession = {
    open: (url, options) => inner.open(url, options),
    fill: (field, value) => inner.fill(field, value),
    uploadFile: (field, filePath) => inner.uploadFile(field, filePath),
    observe: () => inner.observe(),
    clickPreview: () => inner.clickPreview(),
    submitForm: () => { pressed = true; return inner.submitForm(); },
    screenshot: () => inner.screenshot(),
    close: () => inner.close(),
  };
  return { session, pressed: () => pressed };
}

/**
 * The send path. Every material precondition is rechecked from stored state immediately
 * before the external action, the attempt is claimed atomically so two clicks or two
 * workers cannot both send, and the outcome recorded is only what the site showed. A
 * timeout or crash after sending becomes `unknown` and requires explicit reconciliation;
 * nothing here ever reports success it did not observe.
 */
export class SubmissionService {
  private readonly now: () => number;
  private readonly captureAge: number;
  private readonly createAdapter: (id: string) => ApplicationAdapter;
  private readonly createSession?: () => FormSession;
  constructor(private readonly deps: { store: SettingsStore; db: DatabaseSync; artifacts: ArtifactStore; http: HttpClient;
    now?: () => number; captureAgeMs?: number; createAdapter?: (id: string) => ApplicationAdapter; createSession?: () => FormSession; graceMs?: number }) {
    this.now = deps.now ?? Date.now;
    this.captureAge = deps.captureAgeMs ?? MAX_CAPTURE_AGE_MS;
    this.createAdapter = deps.createAdapter ?? (id => createApplicationAdapter(id));
    this.createSession = deps.createSession;
    this.graceMs = deps.graceMs ?? SUBMISSION_GRACE_MS;
  }
  private readonly graceMs: number;

  async submit(attemptId: string, input: { actor: string }): Promise<SubmitResult> {
    const db = this.deps.db;
    this.sweepStale();
    const attempt = db.prepare("SELECT * FROM application_attempts WHERE id=?").get(attemptId) as Record<string, unknown> | undefined;
    if (!attempt) throw new AppError("attempt_missing", "Application attempt not found", 404);
    const applicationId = String(attempt["application_id"]);
    const application = db.prepare("SELECT * FROM applications WHERE id=?").get(applicationId) as Record<string, unknown>;
    const manifest = JSON.parse(String(attempt["manifest_json"])) as Record<string, unknown>;
    const formUrl = String(manifest["formUrl"] ?? "");
    const adapter = this.createAdapter(String(attempt["adapter_id"]));

    // 1. Every gate is rechecked now, not when the attempt was prepared or approved.
    const blocked = this.#gates(attempt, applicationId, formUrl, adapter, db);
    if (blocked) { this.#recordRefusal(attemptId, applicationId, blocked, input.actor); return { attemptId, state: String(attempt["state"]), outcome: null, receiptHash: null, externalId: null, blocked }; }

    // 2. The evidence is re-verified, including freshness.
    const evidence = this.#evidence(manifest, db);
    if (evidence) { this.#recordRefusal(attemptId, applicationId, evidence, input.actor); return { attemptId, state: String(attempt["state"]), outcome: null, receiptHash: null, externalId: null, blocked: evidence }; }

    // 3. Commit the intent durably before anything leaves this machine: one winner only.
    const previousState = String(attempt["state"]);
    const time = new Date(this.now()).toISOString();
    const claimed = transaction(db, () => db.prepare("UPDATE application_attempts SET state='submitting', send_started_at=? WHERE id=? AND state IN('approved','draft')").run(time, attemptId));
    if (Number(claimed.changes) !== 1) {
      const gate: Gate = { code: "already_in_progress", detail: "This attempt is already being sent or has finished; nothing was sent twice" };
      return { attemptId, state: String((db.prepare("SELECT state FROM application_attempts WHERE id=?").get(attemptId) as Record<string, unknown>)["state"]), outcome: null, receiptHash: null, externalId: null, blocked: gate };
    }
    event(db, "application.send_started", "application", applicationId, { attemptId, actor: input.actor, idempotencyKey: attempt["idempotency_key"] }, this.now());

    // 4. Send, then record exactly what came back.
    let result: SubmitOutcome;
    const tracked = this.createSession ? trackSubmit(this.createSession()) : undefined;
    try {
      const resume = resumeUpload(this.deps.artifacts, applicationId, String(manifest["resumeTextHash"]));
      result = await adapter.submit({ attemptId, formUrl, idempotencyKey: String(attempt["idempotency_key"]),
        answers: (manifest["answers"] ?? {}) as Record<string, string>, resume }, { http: this.deps.http, allowPrivate: true, session: tracked?.session });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const code = error instanceof SourceError ? error.code : "submit_failed";
      // Once the submit control was pressed, a failure (a navigation tearing down the page, a
      // crash, a timeout reading the result) says nothing about whether the site received it.
      if (tracked?.pressed() && !(error instanceof NothingSentError)) {
        return this.#recordOutcome(attemptId, applicationId, { outcome: "unknown", detail: `The send failed after submit was pressed (${code}: ${detail})` });
      }
      // Nothing was sent, so the attempt returns to where it was, not to unknown.
      transaction(db, () => {
        db.prepare("UPDATE application_attempts SET state=?, send_started_at=NULL WHERE id=?").run(previousState, attemptId);
        db.prepare("UPDATE applications SET state=?, block_reason=?, updated_at=? WHERE id=?").run(previousState === "approved" ? "approved" : "review_required", `${code}: ${detail}`.slice(0, 500), new Date(this.now()).toISOString(), applicationId);
      });
      event(db, "application.send_failed", "application", applicationId, { attemptId, code, detail }, this.now());
      return { attemptId, state: previousState, outcome: null, receiptHash: null, externalId: null, blocked: { code, detail } };
    } finally {
      await tracked?.session.close().catch(() => undefined);
    }
    return this.#recordOutcome(attemptId, applicationId, result);
  }

  /** Records exactly what the send produced; an unconfirmed outcome opens reconciliation. */
  #recordOutcome(attemptId: string, applicationId: string, result: SubmitOutcome): SubmitResult {
    const db = this.deps.db;
    const state = result.outcome === "submitted" ? "submitted" : result.outcome === "rejected" ? "rejected" : "unknown";
    const textHash = result.confirmationText ? this.deps.artifacts.put(Buffer.from(result.confirmationText, "utf8"), "text/plain", "application-receipt").hash : null;
    const imageHash = result.confirmationImage && result.confirmationImage.byteLength > 0
      ? this.deps.artifacts.put(result.confirmationImage, "image/png", "application-receipt").hash : null;
    const receiptHash = imageHash ?? textHash;
    const finishedAt = new Date(this.now()).toISOString();
    transaction(db, () => {
      db.prepare("UPDATE application_attempts SET state=?, finished_at=?, outcome_json=?, receipt_hash=? WHERE id=?").run(state, finishedAt,
        JSON.stringify({ outcome: result.outcome, externalId: result.externalId ?? null, detail: result.detail ?? null,
          receiptTextHash: textHash, receiptImageHash: imageHash, observedAt: finishedAt, observedBy: "service" }), receiptHash, attemptId);
      db.prepare("UPDATE applications SET state=?, block_reason=NULL, updated_at=? WHERE id=?")
        .run(state === "submitted" ? "submitted" : state === "rejected" ? "rejected" : "submission_unknown", finishedAt, applicationId);
    });
    event(db, state === "submitted" ? "application.submitted" : state === "rejected" ? "application.rejected" : "application.submission_unknown",
      "application", applicationId, { attemptId, externalId: result.externalId ?? null, receiptHash }, this.now());
    if (state === "unknown") this.#openReconciliation(applicationId, attemptId, result.detail ?? "The send outcome could not be confirmed", this.deps.store.current().revision);
    return { attemptId, state, outcome: result.outcome, receiptHash, externalId: result.externalId ?? null, blocked: null };
  }

  /**
   * Operator reconciliation of an unknown outcome. It requires an explicit outcome and the
   * operator's own evidence; it is recorded as operator-reported, never as machine-observed.
   */
  reconcile(attemptId: string, input: { outcome: "submitted" | "rejected"; detail: string; externalId?: string | null; receiptText?: string; actor: string; settingsRevision: number }): SubmitResult {
    const db = this.deps.db;
    const attempt = db.prepare("SELECT * FROM application_attempts WHERE id=?").get(attemptId) as Record<string, unknown> | undefined;
    if (!attempt) throw new AppError("attempt_missing", "Application attempt not found", 404);
    if (attempt["state"] !== "unknown") throw new AppError("not_unknown", `Only an unknown outcome can be reconciled; this attempt is ${String(attempt["state"])}`, 409);
    const applicationId = String(attempt["application_id"]);
    const previous = attempt["outcome_json"] === null ? {} : JSON.parse(String(attempt["outcome_json"])) as Record<string, unknown>;
    const textHash = input.receiptText ? this.deps.artifacts.put(Buffer.from(input.receiptText, "utf8"), "text/plain", "application-receipt").hash : null;
    const receiptHash = textHash ?? (attempt["receipt_hash"] === null ? null : String(attempt["receipt_hash"]));
    const time = new Date(this.now()).toISOString();
    transaction(db, () => {
      db.prepare("UPDATE application_attempts SET state=?, finished_at=?, outcome_json=?, receipt_hash=? WHERE id=? AND state='unknown'").run(input.outcome, time,
        JSON.stringify({ ...previous, outcome: input.outcome, reconciledBy: input.actor, reconciledAt: time, detail: input.detail,
          externalId: input.externalId ?? previous["externalId"] ?? null, receiptTextHash: textHash, observedBy: "operator" }), receiptHash, attemptId);
      db.prepare("UPDATE applications SET state=?, updated_at=? WHERE id=?").run(input.outcome, time, applicationId);
      // The reconciliation item is closed by this decision, not by the passage of time.
      db.prepare("UPDATE attention_items SET state='resolved', version=version+1, updated_at=? WHERE subject_type='submission-reconcile' AND subject_id=? AND state='open'").run(time, applicationId);
      event(db, "application.reconciled", "application", applicationId, { attemptId, outcome: input.outcome, actor: input.actor, receiptHash }, this.now());
    });
    this.#resolveReconcileTask(applicationId);
    return { attemptId, state: input.outcome, outcome: input.outcome, receiptHash, externalId: input.externalId ?? null, blocked: null, reconciledFrom: "unknown" };
  }

  /**
   * A crash or timeout after the intent becomes an honest `unknown`, never a retry and never
   * a success. Before each send, only attempts older than the grace period are swept (a live
   * send in this process is younger). At startup `interrupted: true` sweeps every `submitting`
   * attempt: this process has sent nothing yet, so any of them belongs to a process that died,
   * however recently. One jobs service per data directory is assumed.
   */
  sweepStale(options: { interrupted?: boolean } = {}): { swept: number } {
    const db = this.deps.db;
    const stale = (options.interrupted
      ? db.prepare("SELECT id,application_id,send_started_at FROM application_attempts WHERE state='submitting'").all()
      : db.prepare("SELECT id,application_id,send_started_at FROM application_attempts WHERE state='submitting' AND (send_started_at IS NULL OR send_started_at < ?)")
        .all(new Date(this.now() - this.graceMs).toISOString())) as Record<string, unknown>[];
    const revision = this.deps.store.current().revision;
    for (const row of stale) {
      const attemptId = String(row["id"]), applicationId = String(row["application_id"]);
      const time = new Date(this.now()).toISOString();
      transaction(db, () => {
        db.prepare("UPDATE application_attempts SET state='unknown', finished_at=?, outcome_json=? WHERE id=? AND state='submitting'").run(time,
          JSON.stringify({ outcome: "unknown", detail: "The service stopped after the send began; the outcome is unconfirmed", interruptedAt: row["send_started_at"], observedBy: "service" }), attemptId);
        db.prepare("UPDATE applications SET state='submission_unknown', updated_at=? WHERE id=?").run(time, applicationId);
      });
      event(db, "application.submission_unknown", "application", applicationId, { attemptId, swept: true }, this.now());
      this.#openReconciliation(applicationId, attemptId, "The service stopped after the send began; confirm the outcome before another attempt", revision);
    }
    return { swept: stale.length };
  }

  #gates(attempt: Record<string, unknown>, applicationId: string, formUrl: string, adapter: ApplicationAdapter, db: DatabaseSync): Gate | null {
    const settings = this.deps.store.current().value;
    if (!settings.enabled) return { code: "jobs_disabled", detail: "Jobs are disabled; no submission is sent" };
    if (settings.paused) return { code: "jobs_paused", detail: "Jobs are paused; no submission is sent" };
    if (settings.mode === "draft") return { code: "mode_draft_only", detail: "Draft-only mode never sends; switch to review or automatic explicitly" };
    if (!adapter.capabilities.submit) return { code: "adapter_cannot_submit", detail: `The ${adapter.id} adapter never sends; use a manual completion instead` };
    const policy: Policy | null = new Policies(db, this.now).effective(String(attempt["adapter_id"]), formUrl);
    if (!policy) return { code: "policy_missing", detail: "No site policy governs this target; review one before sending" };
    if (policy.capabilities.submit !== true) return { code: "policy_forbids_submission", detail: `Site policy revision ${policy.revision} does not permit submission` };

    const state = String(attempt["state"]);
    if (state === "unknown") return { code: "submission_unknown", detail: "Reconcile the previous unknown outcome before another attempt" };
    if (state === "submitting") return { code: "already_in_progress", detail: "This attempt is already being sent" };
    if (state !== "approved" && state !== "draft") return { code: "attempt_not_submittable", detail: `An attempt in ${state} cannot be sent` };
    // The gate that first sends must be an explicit approval, unless automatic sending is on.
    const requiresApproval = settings.mode === "review" || settings.reviewGates.submission === true;
    if (state === "approved") {
      const decision = db.prepare(`SELECT subject_version FROM review_decisions WHERE subject_type='application-attempt' AND subject_id=? AND decision='approve'
        ORDER BY created_at DESC LIMIT 1`).get(String(attempt["id"])) as Record<string, unknown> | undefined;
      const manifestHash = String((JSON.parse(String(attempt["manifest_json"])) as Record<string, unknown>)["manifestHash"]);
      if (!decision || String(decision["subject_version"]) !== manifestHash) return { code: "approval_missing", detail: "The recorded approval does not match this manifest" };
    } else if (requiresApproval) {
      return { code: "approval_required", detail: "The submission review gate is on: approve this exact manifest before sending" };
    } else if (policy.restrictions.autoSubmit !== true) {
      return { code: "automatic_not_enabled", detail: "Automatic submission is not enabled for this site; approve or enable it explicitly" };
    }
    // Nothing newer may have been prepared, and no other attempt may be in flight.
    const latest = db.prepare("SELECT id FROM application_attempts WHERE application_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(applicationId) as Record<string, unknown>;
    if (String(latest["id"]) !== String(attempt["id"])) return { code: "superseded_attempt", detail: "A newer attempt exists for this application; review and send that one" };
    const inFlight = db.prepare("SELECT count(*) AS n FROM application_attempts WHERE application_id=? AND id<>? AND state IN('submitting','unknown')").get(applicationId, String(attempt["id"])) as Record<string, unknown>;
    if (Number(inFlight["n"]) > 0) return { code: "attempt_in_progress", detail: "Another attempt for this application is sending or unconfirmed; resolve it first" };
    const cap = policy.restrictions.maxPerDay;
    if (cap !== undefined) {
      const since = new Date(this.now() - 24 * 60 * 60 * 1000).toISOString();
      const used = db.prepare(`SELECT count(*) AS n FROM application_attempts a JOIN source_policies p ON p.id=a.policy_id
        WHERE p.scope_key=? AND a.send_started_at IS NOT NULL AND a.send_started_at >= ? AND a.state IN('submitting','submitted','unknown')`).get(policy.scopeKey, since) as Record<string, unknown>;
      if (Number(used["n"]) >= cap) return { code: "cap_reached", detail: `The site policy allows ${cap} submission(s) per day and that is already used` };
    }
    return null;
  }

  #evidence(manifest: Record<string, unknown>, db: DatabaseSync): Gate | null {
    const snapshot = db.prepare("SELECT captured_at,completeness FROM job_snapshots WHERE id=?").get(String(manifest["snapshotId"])) as Record<string, unknown> | undefined;
    if (!snapshot) return { code: "missing_evidence", detail: "The posting capture for this attempt no longer exists" };
    if (String(snapshot["completeness"]) !== "complete") return { code: "missing_evidence", detail: "The posting capture is not complete" };
    const capturedAt = Date.parse(String(snapshot["captured_at"]));
    if (!Number.isFinite(capturedAt) || this.now() - capturedAt > this.captureAge) return { code: "stale_capture", detail: "The posting capture is older than the freshness window" };
    try { this.deps.artifacts.read(String(manifest["resumeTextHash"])); }
    catch { return { code: "corrupt_resume", detail: "The resume artifact is missing or corrupt; nothing was sent" }; }
    return null;
  }

  #recordRefusal(attemptId: string, applicationId: string, gate: Gate, actor: string): void {
    const db = this.deps.db, time = new Date(this.now()).toISOString();
    transaction(db, () => {
      db.prepare("UPDATE applications SET block_reason=?, updated_at=? WHERE id=? AND state NOT IN('submitted','rejected')")
        .run(`${gate.code}: ${gate.detail}`.slice(0, 500), time, applicationId);
      event(db, "application.send_refused", "application", applicationId, { attemptId, code: gate.code, detail: gate.detail, actor }, this.now());
    });
  }

  #openReconciliation(applicationId: string, attemptId: string, detail: string, settingsRevision: number): void {
    const db = this.deps.db;
    const queue = new TaskQueue(db), reviews = new Reviews(db);
    if (reviews.openItem("submission-reconcile", applicationId, attemptId)) return;
    const task = queue.enqueue({ kind: "application:reconcile", input: { applicationId, attemptId }, settingsRevision, maxAttempts: 1 });
    const time = new Date(this.now()).toISOString();
    transaction(db, () => db.prepare("UPDATE tasks SET state='waiting_review', updated_at=? WHERE id=?").run(time, task.id));
    reviews.open({ taskId: task.id, subjectType: "submission-reconcile", subjectId: applicationId, subjectVersion: attemptId,
      title: "Confirm the submission outcome", detail,
      context: { applicationId, attemptId, hint: "Check the site or your email, then record what you found. Nothing is retried automatically." }, settingsRevision });
  }

  #resolveReconcileTask(applicationId: string): void {
    const db = this.deps.db;
    const item = db.prepare("SELECT task_id FROM attention_items WHERE subject_type='submission-reconcile' AND subject_id=? ORDER BY created_at DESC LIMIT 1").get(applicationId) as Record<string, unknown> | undefined;
    if (!item) return;
    transaction(db, () => db.prepare("UPDATE tasks SET state='succeeded', updated_at=? WHERE id=? AND state='waiting_review'").run(new Date(this.now()).toISOString(), String(item["task_id"])));
  }
}