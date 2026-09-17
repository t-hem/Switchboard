import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { SettingsStore } from "../src/store.js";
import { ArtifactStore } from "../src/artifacts.js";
import { Library } from "../src/library.js";
import { Postings } from "../src/postings.js";
import { PreparationService } from "../src/preparation.js";
import { Applications } from "../src/applications.js";
import type { HttpClient } from "../src/net.js";

const offline: HttpClient = { async get() { throw new Error("fixture adapter must not use the network"); } };
const NOW = 1_800_000_000_000;

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-apps-"));
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
  return { store, artifacts, preparation, applications, applicationId, snapshotId };
}
// The fixture form requires a name and an email; the resume is supplied automatically.
const run = (id: string, answers: Record<string, string> = {}) => ({ applicationId: id, adapterId: "fixture",
  formUrl: "https://forms.example/apply", answers: { name: "Ada", email: "ada@example.test", ...answers }, settingsRevision: 1 });
const hashOf = (manifest: unknown) => String((manifest as Record<string, unknown>)["manifestHash"]);

test("an approval is bound to one manifest hash and only a draft can be approved", async (t) => {
  const { applications, preparation, applicationId, store } = fixture(t);
  const prepared = await preparation.prepare(run(applicationId, { name: "Ada" }));
  const manifestHash = hashOf(prepared.manifest);
  assert.throws(() => applications.approve(prepared.attemptId!, { expectedManifestHash: "a".repeat(64), reason: "stale", settingsRevision: 1 }), /no longer matches/);
  const approved = applications.approve(prepared.attemptId!, { expectedManifestHash: manifestHash, reason: "looks right", settingsRevision: 1 });
  assert.equal(approved.state, "approved");
  assert.equal(store.db.prepare("SELECT state FROM applications WHERE id=?").get(applicationId)!.state, "approved");
  assert.throws(() => applications.approve(prepared.attemptId!, { expectedManifestHash: manifestHash, reason: "again", settingsRevision: 1 }), /only a draft/);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM review_decisions WHERE decision='approve'").get()!.n, 1);
});

test("different answers cancel a prior approval and are shown as changes", async (t) => {
  const { applications, preparation, applicationId, store } = fixture(t);
  const first = await preparation.prepare(run(applicationId, { workAuth: "yes" }));
  applications.approve(first.attemptId!, { expectedManifestHash: hashOf(first.manifest), reason: "ok", settingsRevision: 1 });
  const changed = await preparation.prepare(run(applicationId, { workAuth: "no" }));
  assert.equal(changed.created, true);
  assert.equal(store.db.prepare("SELECT state FROM application_attempts WHERE id=?").get(first.attemptId!)!.state, "cancelled", "the stale approval can never be sent");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='application.approval_invalidated'").get()!.n, 1);
  assert.equal(store.db.prepare("SELECT state FROM applications WHERE id=?").get(applicationId)!.state, "review_required", "the application is back for review");
  const pkg = applications.packageOf(applicationId);
  assert.equal((pkg.approval as Record<string, unknown>).current, false);
  const changes = pkg.changesSinceReview as { field: string }[];
  assert.deepEqual(changes.map(change => change.field), ["answers"], "exactly what changed since the review");
});

test("an operator-reported manual completion stores the receipt it was given", async (t) => {
  const { applications, applicationId, store } = fixture(t);
  const first = applications.manualCompletion(applicationId, { detail: "Submitted on the employer site", receiptText: "Reference: ABC-123", settingsRevision: 1 });
  assert.equal(first.created, true);
  assert.equal(store.db.prepare("SELECT state FROM applications WHERE id=?").get(applicationId)!.state, "submitted");
  const attempt = store.db.prepare("SELECT * FROM application_attempts WHERE id=?").get(first.attemptId)!;
  assert.equal(attempt.state, "submitted");
  assert.equal(attempt.adapter_id, "manual");
  assert.equal(String(store.db.prepare("SELECT purpose FROM artifacts WHERE hash=?").get(attempt.receipt_hash)!.purpose), "application-receipt");
  const receipt = JSON.parse(JSON.stringify(attempt));
  assert.ok(receipt.receipt_hash, "the receipt is recorded as evidence, not asserted");
  assert.equal(applications.manualCompletion(applicationId, { detail: "Submitted on the employer site", receiptText: "Reference: ABC-123", settingsRevision: 1 }).created, false, "the same report is never recorded twice");
});

test("a handoff block is resolved with the recorded context and can continue", async (t) => {
  const { applications, preparation, applicationId, store } = fixture(t);
  const blocked = await preparation.prepare({ ...run(applicationId, { name: "Ada" }), adapterOptions: { captcha: true } });
  assert.equal(blocked.code, "captcha");
  const handoff = applications.openHandoff(applicationId);
  assert.ok(handoff, "the block left a durable handoff");
  assert.equal(handoff.adapterId, "fixture");
  assert.ok(handoff.formUrl && handoff.answers && handoff.resumeVersionId, "the handoff carries URL, answers and resume");
  applications.resolveHandoff(applicationId, { code: "captcha", note: "Solved the challenge by hand" });
  assert.equal(applications.openHandoff(applicationId), null, "the resolved handoff is closed");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='application.handoff_resolved'").get()!.n, 1);
  assert.throws(() => applications.resolveHandoff(applicationId, { note: "again" }), /no open handoff/);
});
