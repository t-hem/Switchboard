import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { SettingsStore } from "../src/store.js";
import { ArtifactStore } from "../src/artifacts.js";
import { Library } from "../src/library.js";
import { Postings } from "../src/postings.js";
import { PreparationService } from "../src/preparation.js";
import { Applications } from "../src/applications.js";
import { SubmissionService } from "../src/submission.js";
import { Policies } from "../src/policies.js";
import { NothingSentError, SourceError } from "../src/errors.js";
import type { ApplicationAdapter, FormSession, SubmitOutcome } from "../src/adapters/application.js";
import type { HttpClient } from "../src/net.js";
import type { Settings } from "../src/settings.js";

const offline: HttpClient = { async get() { throw new Error("fixture adapter must not use the network"); } };
const NOW = 1_800_000_000_000;
const FORM = "https://forms.example/apply";
const ANSWERS = { name: "Ada Lovelace", email: "ada@example.test" };

/** A deterministic stand-in for a real site, so failure modes can be scripted exactly. */
class ScriptedAdapter implements ApplicationAdapter {
  readonly id = "fixture-form";
  readonly version = "1";
  readonly capabilities: ApplicationAdapter["capabilities"];
  calls = 0;
  constructor(private readonly behaviour: SubmitOutcome | (() => Promise<SubmitOutcome>), canSubmit = true) {
    this.capabilities = { prepare: true, fill: true, upload: true, submit: canSubmit, reconcile: false };
  }
  async inspect() { throw new Error("not used"); }
  async prepare() { throw new Error("not used"); }
  async submit(): Promise<SubmitOutcome> { this.calls++; return typeof this.behaviour === "function" ? await this.behaviour() : this.behaviour; }
}

function fixture(t: TestContext, options: { settings?: Partial<Settings>; adapter?: (adapter: ApplicationAdapter) => ApplicationAdapter; createSession?: () => FormSession } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-submit-"));
  const store = new SettingsStore(path.join(dir, "jobs.sqlite"));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const artifacts = new ArtifactStore(store.db, dir);
  const postings = new Postings(store.db, artifacts, () => NOW);
  const library = new Library(store.db, () => NOW);
  const { jobId } = postings.ingest({ adapterId: "fixture", company: "Acme", title: "Engineer", originalUrl: "https://acme.example/1", descriptionText: "Body", provenance: "browser" });
  const snapshotId = postings.recordSnapshot({ jobId, purpose: "discovery", fetchedUrl: "u", finalUrl: "u", descriptionText: "Body",
    screenshot: Buffer.from("png"), captureVersion: "browser:1", capture: {}, completeness: "complete" }).snapshotId;
  const profile = library.addProfile({ profileId: "primary", data: { contact: { name: "Ada" }, facts: [], suggestions: [] } });
  const template = library.addTemplate({ templateId: "base", data: { name: "Base", sections: [{ id: "summary", title: "Summary", type: "facts", factKeys: ["summary"], optional: true }] } });
  const hash = artifacts.put(Buffer.from("resume text", "utf8"), "text/plain", "resume-text").hash;
  store.db.prepare(`INSERT INTO resume_versions(id,job_snapshot_id,profile_revision_id,template_revision_id,parent_resume_id,agent_run_id,phase,source_json,selected_bullets_json,edits_json,text_artifact_hash,pdf_artifact_hash,created_at)
    VALUES('resume-1',?,?,?,NULL,NULL,'render','{}','[]','{}',?,NULL,?)`).run(snapshotId, profile.id, template.id, hash, new Date(NOW).toISOString());
  const applicationId = String(store.db.prepare("SELECT id FROM applications WHERE job_id=?").get(jobId)!.id);
  store.db.prepare("UPDATE applications SET selected_resume_id='resume-1' WHERE id=?").run(applicationId);
  const preparation = new PreparationService({ store, db: store.db, artifacts, http: offline, now: () => NOW });
  const applications = new Applications({ db: store.db, artifacts, now: () => NOW });
  const policies = new Policies(store.db, () => NOW);

  const settings = (patch: Partial<Settings> = {}, overrides?: Partial<Settings>): void => {
    const current = store.current();
    store.update(current.revision, { ...current.value, enabled: true, paused: false, mode: "review", ...overrides, ...patch });
  };
  settings(undefined, options.settings);
  // An explicit relaxation: the site now permits submission.
  policies.put({ adapterId: "fixture", siteUrl: FORM, capabilities: { prepare: true, fill: true, upload: true, submit: true },
    restrictions: {}, reviewedBy: "operator" });

  const holder: { adapter: ApplicationAdapter } = { adapter: new ScriptedAdapter({ outcome: "submitted", confirmationText: "Thank you", externalId: "REF-1" }) };
  let injected: ApplicationAdapter | null = null;
  const submission = new SubmissionService({ store, db: store.db, artifacts, http: offline, now: () => NOW, createSession: options.createSession,
    createAdapter: () => {
      if (!options.adapter) return holder.adapter;
      injected ??= options.adapter(holder.adapter);
      holder.adapter = injected;
      return injected;
    } });
  return { store, artifacts, postings, preparation, applications, policies, submission, applicationId, holder, settings };
}

/** Prepare and approve, which is the state every send starts from in review mode. */
async function prepared(t: TestContext, options: Parameters<typeof fixture>[1] = {}) {
  const f = fixture(t, options);
  const outcome = await f.preparation.prepare({ applicationId: f.applicationId, adapterId: "fixture", formUrl: FORM, answers: ANSWERS, settingsRevision: f.store.current().revision });
  assert.equal(outcome.state, "draft", outcome.detail);
  f.applications.approve(outcome.attemptId!, { expectedManifestHash: String((outcome.manifest as Record<string, unknown>)["manifestHash"]), reason: "reviewed", settingsRevision: f.store.current().revision });
  return { ...f, attemptId: outcome.attemptId! };
}
const adapterOf = (f: Awaited<ReturnType<typeof prepared>>) => f.holder.adapter as ScriptedAdapter;

/** Insert an attempt directly; immutability triggers forbid editing a real one to a bad state. */
function craftAttempt(f: Awaited<ReturnType<typeof prepared>>, state: string, manifest: Record<string, unknown>): string {
  const id = randomUUID(), time = new Date(NOW + 1000).toISOString();
  const policyId = String((f.store.db.prepare("SELECT id FROM source_policies WHERE scope_key=? ORDER BY revision DESC LIMIT 1").get("fixture:forms.example") as Record<string, unknown>)["id"]);
  f.store.db.prepare(`INSERT INTO application_attempts(id,application_id,idempotency_key,adapter_id,state,snapshot_id,resume_id,settings_revision,policy_id,manifest_json,preflight_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, f.applicationId, `crafted-${id}`, "fixture", state, String(manifest["snapshotId"]), "resume-1",
    f.store.current().revision, policyId, JSON.stringify(manifest), time, time);
  return id;
}
const automatic = { mode: "automatic" as const, reviewGates: { discovery: true, resumeBuild: true, resumeEdit: true, preparation: true, submission: false } };

test("a matching approval in review mode sends once and stores the observed receipt", async (t) => {
  const f = await prepared(t);
  const result = await f.submission.submit(f.attemptId, { actor: "operator" });
  assert.equal(result.state, "submitted");
  assert.equal(result.externalId, "REF-1");
  assert.equal(adapterOf(f).calls, 1);
  assert.ok(result.receiptHash, "the confirmation is stored as evidence");
  assert.equal(f.store.db.prepare("SELECT state FROM applications WHERE id=?").get(f.applicationId)!.state, "submitted");
  const attempt = f.store.db.prepare("SELECT * FROM application_attempts WHERE id=?").get(f.attemptId)!;
  assert.ok(attempt.send_started_at, "the intent was committed before the send");
  assert.equal(JSON.parse(String(attempt.outcome_json)).observedBy, "service");
});

test("a known rejection is recorded as a rejection, not a success", async (t) => {
  const f = await prepared(t, { adapter: () => new ScriptedAdapter({ outcome: "rejected", confirmationText: "You are not eligible in this region" }) });
  const result = await f.submission.submit(f.attemptId, { actor: "operator" });
  assert.equal(result.state, "rejected");
  assert.equal(f.store.db.prepare("SELECT state FROM applications WHERE id=?").get(f.applicationId)!.state, "rejected");
});

test("draft-only, disabled, paused, unapproved, manual-only and forbidden policies send nothing", async (t) => {
  const cases: { name: string; options: Parameters<typeof fixture>[1]; code: string; patch?: (f: Awaited<ReturnType<typeof prepared>>) => void }[] = [
    { name: "draft-only", options: { settings: { mode: "draft" } }, code: "mode_draft_only" },
    { name: "disabled", options: {}, code: "jobs_disabled", patch: f => { const c = f.store.current(); f.store.update(c.revision, { ...c.value, enabled: false }); } },
    { name: "paused during send", options: {}, code: "jobs_paused", patch: f => { const c = f.store.current(); f.store.update(c.revision, { ...c.value, paused: true }); } },
    { name: "manual-only adapter", options: { adapter: () => new ScriptedAdapter({ outcome: "submitted" }, false) }, code: "adapter_cannot_submit" },
    { name: "policy forbids submission", options: {}, code: "policy_forbids_submission",
      patch: f => f.policies.put({ adapterId: "fixture", siteUrl: FORM, capabilities: { prepare: true, fill: true, upload: true, submit: false }, reviewedBy: "operator" }) },
    { name: "review gate without approval", options: {}, code: "approval_required",
      patch: f => { f.store.db.prepare("UPDATE application_attempts SET state='draft' WHERE id=?").run(f.attemptId); } },
  ];
  for (const item of cases) {
    const f = await prepared(t, item.options);
    item.patch?.(f);
    const result = await f.submission.submit(f.attemptId, { actor: "operator" });
    assert.equal(result.blocked?.code, item.code, `${item.name} must be refused`);
    assert.equal(result.state, item.code === "policy_forbids_submission" || item.code === "jobs_disabled" || item.code === "jobs_paused" ? "approved" : result.state);
    assert.equal(adapterOf(f).calls, 0, `${item.name} must not contact the site`);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM application_attempts WHERE state IN('submitted','rejected','unknown')").get()!.n, 0, `${item.name} recorded no outcome`);
  }
});

test("automatic mode needs an explicit site opt-in even when the review gate is relaxed", async (t) => {
  const f = await prepared(t, { settings: { mode: "automatic", reviewGates: { discovery: true, resumeBuild: true, resumeEdit: true, preparation: true, submission: false } } });
  const refused = await f.submission.submit(f.attemptId, { actor: "scheduler" });
  // This attempt is approved, so it sends; a fresh unapproved attempt is what automatic must refuse.
  assert.equal(refused.state, "submitted");
  const g = await prepared(t, { settings: { mode: "automatic", reviewGates: { discovery: true, resumeBuild: true, resumeEdit: true, preparation: true, submission: false } } });
  g.store.db.prepare("UPDATE application_attempts SET state='draft' WHERE id=?").run(g.attemptId);
  assert.equal((await g.submission.submit(g.attemptId, { actor: "scheduler" })).blocked?.code, "automatic_not_enabled");
  g.policies.put({ adapterId: "fixture", siteUrl: FORM, capabilities: { prepare: true, fill: true, upload: true, submit: true }, restrictions: { autoSubmit: true }, reviewedBy: "operator" });
  const sent = await g.submission.submit(g.attemptId, { actor: "scheduler" });
  assert.equal(sent.state, "submitted", "an explicit opt-in permits an unapproved automatic send");
  assert.equal(adapterOf(g).calls, 1);
});

test("a double click or a second worker produces exactly one send", async (t) => {
  const f = await prepared(t);
  const [first, second] = await Promise.all([f.submission.submit(f.attemptId, { actor: "operator" }), f.submission.submit(f.attemptId, { actor: "operator" })]);
  assert.equal(adapterOf(f).calls, 1, "only one send reached the site");
  assert.equal([first, second].filter(r => r.blocked === null).length, 1);
  assert.ok([first, second].some(r => r.blocked?.code === "already_in_progress" || r.blocked?.code === "attempt_not_submittable"));
});

test("a pre-send failure returns the attempt to its previous state and can be retried", async (t) => {
  let fail = true;
  const f = await prepared(t, { adapter: () => new ScriptedAdapter(async () => {
    if (fail) { fail = false; throw new SourceError("timeout", "The form timed out before anything was sent", true); }
    return { outcome: "submitted", confirmationText: "Thank you" };
  }) });
  const failed = await f.submission.submit(f.attemptId, { actor: "operator" });
  assert.equal(failed.blocked?.code, "timeout");
  assert.equal(failed.state, "approved", "a known pre-send failure stays approved");
  const attempt = f.store.db.prepare("SELECT * FROM application_attempts WHERE id=?").get(f.attemptId)!;
  assert.equal(attempt.state, "approved");
  assert.equal(attempt.send_started_at, null, "no send was recorded");
  const retried = await f.submission.submit(f.attemptId, { actor: "operator" });
  assert.equal(retried.state, "submitted");
  assert.equal(adapterOf(f).calls, 2);
});

/** A browser-backed send whose session fails exactly as scripted. */
function sessionThatFails(onSubmit: () => never): FormSession {
  return {
    async open() { throw new Error("not used"); }, async fill() {}, async uploadFile() {}, async observe() { throw new Error("not used"); },
    async clickPreview() { return false; }, async submitForm() { onSubmit(); }, async screenshot() { return new Uint8Array(); }, async close() {},
  };
}
class SessionAdapter extends ScriptedAdapter {
  override async submit(_input: unknown, context?: { session?: FormSession }): Promise<SubmitOutcome> {
    this.calls++;
    await context!.session!.submitForm();
    return { outcome: "submitted", confirmationText: "Thank you" };
  }
}

test("pause changes during browser preparation prevent the actual submit press", async t => {
  let pressed = false;
  let pause!: () => void;
  class PausingAdapter extends SessionAdapter {
    override async submit(input: unknown, context?: { session?: FormSession }): Promise<SubmitOutcome> {
      pause();
      return super.submit(input, context);
    }
  }
  const f = await prepared(t, { adapter: () => new PausingAdapter({ outcome: "submitted" }),
    createSession: () => sessionThatFails(() => { pressed = true; throw new Error("should not press"); }) });
  pause = () => f.store.update(f.store.current().revision, { ...f.store.current().value, paused: true });
  const result = await f.submission.submit(f.attemptId, { actor: "operator" });
  assert.equal(result.blocked?.code, "jobs_paused");
  assert.equal(pressed, false);
  assert.equal(f.store.db.prepare("SELECT state FROM application_attempts WHERE id=?").get(f.attemptId)!.state, "approved");
});

test("failure to construct a form session releases an unsent claim", async t => {
  const f = await prepared(t, { createSession: () => { throw new Error("browser unavailable"); } });
  const result = await f.submission.submit(f.attemptId, { actor: "operator" });
  assert.equal(result.state, "approved");
  assert.match(result.blocked!.detail, /browser unavailable/);
  assert.equal(f.store.db.prepare("SELECT send_started_at FROM application_attempts WHERE id=?").get(f.attemptId)!.send_started_at, null);
});

test("a failure after submit was pressed is unknown, never a return to approved", async (t) => {
  const f = await prepared(t, { adapter: () => new SessionAdapter({ outcome: "submitted" }),
    createSession: () => sessionThatFails(() => { throw new Error("Execution context was destroyed, most likely because of a navigation"); }) });
  const result = await f.submission.submit(f.attemptId, { actor: "operator" });
  assert.equal(result.state, "unknown", "the site may have received it, so it must not be re-sendable");
  assert.equal(f.store.db.prepare("SELECT state FROM application_attempts WHERE id=?").get(f.attemptId)!.state, "unknown");
  assert.equal(f.store.db.prepare("SELECT state FROM applications WHERE id=?").get(f.applicationId)!.state, "submission_unknown");
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM attention_items WHERE subject_type='submission-reconcile' AND state='open'").get()!.n, 1);
  assert.equal((await f.submission.submit(f.attemptId, { actor: "operator" })).blocked?.code, "submission_unknown");
  assert.equal(adapterOf(f).calls, 1);
});

test("a failure the session proves happened before the press returns the attempt to approved", async (t) => {
  const f = await prepared(t, { adapter: () => new SessionAdapter({ outcome: "submitted" }),
    createSession: () => sessionThatFails(() => { throw new NothingSentError("submit_control_missing", "The form has no submit control; nothing was sent", false); }) });
  const result = await f.submission.submit(f.attemptId, { actor: "operator" });
  assert.equal(result.blocked?.code, "submit_control_missing");
  assert.equal(f.store.db.prepare("SELECT state FROM application_attempts WHERE id=?").get(f.attemptId)!.state, "approved");
});

test("an unconfirmable send is unknown and requires operator reconciliation", async (t) => {
  const f = await prepared(t, { adapter: () => new ScriptedAdapter({ outcome: "unknown", detail: "The request was accepted but no confirmation page loaded" }) });
  const result = await f.submission.submit(f.attemptId, { actor: "operator" });
  assert.equal(result.state, "unknown");
  assert.equal(f.store.db.prepare("SELECT state FROM applications WHERE id=?").get(f.applicationId)!.state, "submission_unknown");
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM attention_items WHERE subject_type='submission-reconcile' AND state='open'").get()!.n, 1);
  assert.equal(f.store.db.prepare("SELECT state FROM tasks WHERE kind='application:reconcile'").get()!.state, "waiting_review");
  // Another attempt must not be sent while the outcome is unconfirmed.
  assert.equal((await f.submission.submit(f.attemptId, { actor: "operator" })).blocked?.code, "submission_unknown");
  assert.equal(adapterOf(f).calls, 1);
  // Reconciliation needs an explicit outcome and records it as operator-observed.
  const reconciled = f.submission.reconcile(f.attemptId, { outcome: "submitted", detail: "Found the confirmation email", receiptText: "Confirmation 42", actor: "operator", settingsRevision: f.store.current().revision });
  assert.equal(reconciled.state, "submitted");
  assert.equal(reconciled.reconciledFrom, "unknown");
  const attempt = f.store.db.prepare("SELECT * FROM application_attempts WHERE id=?").get(f.attemptId)!;
  assert.equal(JSON.parse(String(attempt.outcome_json)).observedBy, "operator", "an operator's report is never presented as machine evidence");
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM attention_items WHERE subject_type='submission-reconcile' AND state='open'").get()!.n, 0);
  assert.throws(() => f.submission.reconcile(f.attemptId, { outcome: "submitted", detail: "again", actor: "operator", settingsRevision: f.store.current().revision }), /Only an unknown outcome/);
});

test("a crash after the intent becomes unknown at startup, never a silent retry", async (t) => {
  const f = await prepared(t);
  // Simulate a service that died between committing the intent and recording an outcome.
  f.store.db.prepare("UPDATE application_attempts SET state='submitting', send_started_at=? WHERE id=?").run(new Date(NOW - 60 * 60 * 1000).toISOString(), f.attemptId);
  const swept = f.submission.sweepStale();
  assert.equal(swept.swept, 1);
  assert.equal(f.store.db.prepare("SELECT state FROM application_attempts WHERE id=?").get(f.attemptId)!.state, "unknown");
  assert.equal(f.store.db.prepare("SELECT state FROM applications WHERE id=?").get(f.applicationId)!.state, "submission_unknown");
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM attention_items WHERE subject_type='submission-reconcile' AND state='open'").get()!.n, 1);
  assert.equal(adapterOf(f).calls, 0, "recovery never resends");
  assert.equal(f.submission.sweepStale().swept, 0, "a swept attempt is not swept twice");
});

test("a restart soon after a crash still sweeps the interrupted send, and a send sweeps old ones first", async (t) => {
  const f = await prepared(t);
  // The service died one minute after committing the intent and was restarted at once.
  f.store.db.prepare("UPDATE application_attempts SET state='submitting', send_started_at=? WHERE id=?").run(new Date(NOW - 60 * 1000).toISOString(), f.attemptId);
  assert.equal(f.submission.sweepStale().swept, 0, "within the grace period an ordinary sweep leaves a possibly live send alone");
  assert.equal(f.submission.sweepStale({ interrupted: true }).swept, 1, "at startup nothing is live, so it is interrupted however recent");
  assert.equal(f.store.db.prepare("SELECT state FROM application_attempts WHERE id=?").get(f.attemptId)!.state, "unknown");
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM attention_items WHERE subject_type='submission-reconcile' AND state='open'").get()!.n, 1);

  const g = await prepared(t);
  g.store.db.prepare("UPDATE application_attempts SET state='submitting', send_started_at=? WHERE id=?").run(new Date(NOW - 60 * 60 * 1000).toISOString(), g.attemptId);
  const result = await g.submission.submit(g.attemptId, { actor: "operator" });
  assert.equal(result.blocked?.code, "submission_unknown", "a stuck send is swept to unknown before the gates run, not left in progress");
  assert.equal(g.store.db.prepare("SELECT count(*) AS n FROM attention_items WHERE subject_type='submission-reconcile' AND state='open'").get()!.n, 1);
  assert.equal(adapterOf(g).calls, 0);
});

test("missing evidence, a corrupt resume and a superseded attempt block the send", async (t) => {
  const missing = await prepared(t, { settings: automatic });
  missing.policies.put({ adapterId: "fixture", siteUrl: FORM, capabilities: { prepare: true, fill: true, upload: true, submit: true }, restrictions: { autoSubmit: true }, reviewedBy: "operator" });
  // A capture that exists but is not complete is still missing evidence.
  const jobId = String((missing.store.db.prepare("SELECT job_id FROM applications WHERE id=?").get(missing.applicationId) as Record<string, unknown>)["job_id"]);
  const partial = missing.postings.recordSnapshot({ jobId, purpose: "discovery", fetchedUrl: "u", finalUrl: "u", descriptionText: "Body text with a partial capture",
    captureVersion: "browser:1", capture: {}, completeness: "partial", failureDetail: "no screenshot evidence" }).snapshotId;
  const incomplete = craftAttempt(missing, "draft", { manifestHash: "a".repeat(64), formUrl: FORM, snapshotId: partial, resumeTextHash: "b".repeat(64), answers: ANSWERS });
  assert.equal((await missing.submission.submit(incomplete, { actor: "scheduler" })).blocked?.code, "missing_evidence");
  assert.equal(adapterOf(missing).calls, 0);

  const corrupt = await prepared(t, { settings: automatic });
  corrupt.policies.put({ adapterId: "fixture", siteUrl: FORM, capabilities: { prepare: true, fill: true, upload: true, submit: true }, restrictions: { autoSubmit: true }, reviewedBy: "operator" });
  const snapshotId = String((corrupt.store.db.prepare("SELECT id FROM job_snapshots WHERE job_id=(SELECT job_id FROM applications WHERE id=?) LIMIT 1").get(corrupt.applicationId) as Record<string, unknown>)["id"]);
  const gone = craftAttempt(corrupt, "draft", { manifestHash: "a".repeat(64), formUrl: FORM, snapshotId, resumeTextHash: "c".repeat(64), answers: ANSWERS });
  assert.equal((await corrupt.submission.submit(gone, { actor: "scheduler" })).blocked?.code, "corrupt_resume");
  assert.equal(adapterOf(corrupt).calls, 0);

  const stale = fixture(t, {});
  const staleService = new SubmissionService({ store: stale.store, db: stale.store.db, artifacts: stale.artifacts, http: offline, now: () => NOW, captureAgeMs: -1, createAdapter: () => stale.holder.adapter });
  const staleOutcome = await stale.preparation.prepare({ applicationId: stale.applicationId, adapterId: "fixture", formUrl: FORM, answers: ANSWERS, settingsRevision: stale.store.current().revision });
  stale.applications.approve(staleOutcome.attemptId!, { expectedManifestHash: String((staleOutcome.manifest as Record<string, unknown>)["manifestHash"]), reason: "ok", settingsRevision: stale.store.current().revision });
  assert.equal((await staleService.submit(staleOutcome.attemptId!, { actor: "operator" })).blocked?.code, "stale_capture");

  const superseded = await prepared(t);
  await superseded.preparation.prepare({ applicationId: superseded.applicationId, adapterId: "fixture", formUrl: FORM, answers: { ...ANSWERS, phone: "555" }, settingsRevision: superseded.store.current().revision });
  assert.equal((await superseded.submission.submit(superseded.attemptId, { actor: "operator" })).blocked?.code, "attempt_not_submittable");
  assert.equal(adapterOf(superseded).calls, 0, "a cancelled approval never sends");
});

test("an approved state without a matching decision is refused, and the daily cap holds", async (t) => {
  const f = await prepared(t);
  // An approval row is required, not just an approved state.
  const undecided = craftAttempt(f, "approved", { manifestHash: "d".repeat(64), formUrl: FORM, snapshotId: String((f.store.db.prepare("SELECT snapshot_id FROM application_attempts WHERE id=?").get(f.attemptId) as Record<string, unknown>)["snapshot_id"]), resumeTextHash: "e".repeat(64), answers: ANSWERS });
  assert.equal((await f.submission.submit(undecided, { actor: "operator" })).blocked?.code, "approval_missing");
  assert.equal(adapterOf(f).calls, 0);

  const capped = await prepared(t);
  capped.policies.put({ adapterId: "fixture", siteUrl: FORM, capabilities: { prepare: true, fill: true, upload: true, submit: true }, restrictions: { maxPerDay: 1 }, reviewedBy: "operator" });
  assert.equal((await capped.submission.submit(capped.attemptId, { actor: "operator" })).state, "submitted");
  // The cap is across applications; a completed application itself cannot be reopened.
  await assert.rejects(() => capped.preparation.prepare({ applicationId: capped.applicationId, adapterId: "fixture", formUrl: FORM, answers: ANSWERS, settingsRevision: capped.store.current().revision }), /completed/);
  const postings = new Postings(capped.store.db, capped.artifacts, () => NOW);
  const next = postings.ingest({ adapterId: "fixture", company: "Acme", title: "Another Engineer", originalUrl: "https://acme.example/2", descriptionText: "Body", provenance: "browser" });
  const snapshot = postings.recordSnapshot({ jobId: next.jobId, purpose: "discovery", fetchedUrl: "u", finalUrl: "u", descriptionText: "Body", screenshot: Buffer.from("png"), captureVersion: "browser:1", capture: {}, completeness: "complete" });
  capped.store.db.prepare("INSERT INTO resume_versions SELECT 'resume-2',?,profile_revision_id,template_revision_id,NULL,NULL,phase,source_json,selected_bullets_json,edits_json,text_artifact_hash,pdf_artifact_hash,created_at FROM resume_versions WHERE id='resume-1'").run(snapshot.snapshotId);
  capped.applications.selectResume(next.applicationId, "resume-2");
  const second = await capped.preparation.prepare({ applicationId: next.applicationId, adapterId: "fixture", formUrl: FORM, answers: ANSWERS, settingsRevision: capped.store.current().revision });
  capped.applications.approve(second.attemptId!, { expectedManifestHash: String((second.manifest as Record<string, unknown>)["manifestHash"]), reason: "ok", settingsRevision: capped.store.current().revision });
  assert.equal((await capped.submission.submit(second.attemptId!, { actor: "operator" })).blocked?.code, "cap_reached");
});
