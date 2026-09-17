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
import { createApplicationAdapter, applicationAdapterIds, type FormField } from "../src/adapters/application.js";
import type { HttpClient } from "../src/net.js";

const offline: HttpClient = { async get() { throw new Error("fixture adapter must not use the network"); } };
const NOW = 1_800_000_000_000;
const uniFields: FormField[] = [
  { name: "name", label: "Name", type: "text", required: true },
  { name: "resume", label: "Resume", type: "file", required: true },
  { name: "workAuth", label: "Work authorization", type: "select", required: true, options: ["yes", "no"] },
];

function fixture(t: TestContext, options: { maxCaptureAgeMs?: number; withSnapshot?: boolean; withResume?: boolean; createSession?: () => import("../src/adapters/application.js").FormSession } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-prep-"));
  const store = new SettingsStore(path.join(dir, "jobs.sqlite"));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const artifacts = new ArtifactStore(store.db, dir);
  const postings = new Postings(store.db, artifacts, () => NOW);
  const library = new Library(store.db, () => NOW);
  const { jobId } = postings.ingest({ adapterId: "fixture", company: "Acme", title: "Engineer", originalUrl: "https://acme.example/1", descriptionText: "Body", provenance: "browser" });
  let snapshotId: string | null = null;
  if (options.withSnapshot !== false) snapshotId = postings.recordSnapshot({ jobId, purpose: "discovery", fetchedUrl: "u", finalUrl: "u",
    descriptionText: "Body", screenshot: Buffer.from("png"), captureVersion: "browser:1", capture: {}, completeness: "complete" }).snapshotId;
  const profile = library.addProfile({ profileId: "primary", data: { contact: { name: "Ada" }, facts: [], suggestions: [] } });
  const template = library.addTemplate({ templateId: "base", data: { name: "Base", sections: [{ id: "summary", title: "Summary", type: "facts", factKeys: ["summary"], optional: true }] } });
  const application = store.db.prepare("SELECT id FROM applications WHERE job_id=?").get(jobId) as { id: string };
  if (options.withResume !== false && snapshotId) {
    const hash = artifacts.put(Buffer.from("resume text", "utf8"), "text/plain", "resume-text").hash;
    const resumeId = "resume-1";
    store.db.prepare(`INSERT INTO resume_versions(id,job_snapshot_id,profile_revision_id,template_revision_id,parent_resume_id,agent_run_id,phase,source_json,selected_bullets_json,edits_json,text_artifact_hash,pdf_artifact_hash,created_at)
      VALUES(?,?,?,?,NULL,NULL,'render','{}','[]','{}',?,NULL,?)`).run(resumeId, snapshotId, profile.id, template.id, hash, new Date(NOW).toISOString());
    store.db.prepare("UPDATE applications SET selected_resume_id=? WHERE id=?").run(resumeId, application.id);
  }
  const preparation = new PreparationService({ store, db: store.db, artifacts, http: offline, now: () => NOW, maxCaptureAgeMs: options.maxCaptureAgeMs, createSession: options.createSession });
  return { store, artifacts, preparation, jobId, applicationId: application.id, snapshotId };
}
const run = (id: string, options: Record<string, unknown> = {}, answers: Record<string, string> = {}) =>
  ({ applicationId: id, adapterId: "fixture", adapterOptions: { fields: uniFields, ...options }, formUrl: "https://forms.example/apply", answers, settingsRevision: 1, allowPrivate: false });

test("application adapters are a registry with an honest manual default", () => {
  assert.deepEqual(applicationAdapterIds(), ["fixture", "fixture-form", "manual"]);
  assert.equal(createApplicationAdapter("fixture").capabilities.submit, false, "step 9 never claims submission");
  assert.equal(createApplicationAdapter("manual").capabilities.prepare, false);
  assert.throws(() => createApplicationAdapter("nope"), /No application adapter/);
});

test("a clean preparation records a draft manifest and reuses it on repeat", async (t) => {
  const { store, preparation, applicationId, snapshotId } = fixture(t);
  const first = await preparation.prepare(run(applicationId, {}, { name: "Ada", workAuth: "yes" }));
  assert.equal(first.state, "draft", first.detail);
  assert.ok(first.attemptId);
  const manifest = first.manifest as Record<string, unknown>;
  assert.equal(manifest["snapshotId"], snapshotId);
  assert.match(String(manifest["manifestHash"]), /^[a-f0-9]{64}$/);
  assert.equal(manifest["uploads"][0].artifactHash, store.db.prepare("SELECT text_artifact_hash FROM resume_versions WHERE id='resume-1'").get()!.text_artifact_hash);
  assert.equal(store.db.prepare("SELECT state FROM applications WHERE id=?").get(applicationId)!.state, "review_required");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM application_attempts").get()!.n, 1);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM source_policies").get()!.n, 1);

  const again = await preparation.prepare(run(applicationId, {}, { name: "Ada", workAuth: "yes" }));
  assert.equal(again.created, false);
  assert.equal(again.attemptId, first.attemptId, "the same inputs never create a duplicate attempt");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM application_attempts").get()!.n, 1);
});

test("missing evidence, a stale capture and a missing resume block before any fill", async (t) => {
  const noSnapshot = fixture(t, { withSnapshot: false });
  const missing = await noSnapshot.preparation.prepare(run(noSnapshot.applicationId, {}, { name: "Ada", workAuth: "yes" }));
  assert.equal(missing.code, "missing_evidence");

  const stale = fixture(t, { maxCaptureAgeMs: -1 });
  const old = await stale.preparation.prepare(run(stale.applicationId, {}, { name: "Ada", workAuth: "yes" }));
  assert.equal(old.code, "stale_capture");
  assert.equal(stale.store.db.prepare("SELECT count(*) AS n FROM application_attempts").get()!.n, 0);

  // No selected resume: blocked, and still no attempt row.
  const { store, preparation, applicationId } = fixture(t);
  store.db.prepare("UPDATE applications SET selected_resume_id=NULL WHERE id=?").run(applicationId);
  assert.equal((await preparation.prepare(run(applicationId, {}, { name: "Ada", workAuth: "yes" }))).code, "missing_resume");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM application_attempts").get()!.n, 0);
});

test("an unsupported required field blocks and never presents a partial form as ready", async (t) => {
  const { store, preparation, applicationId } = fixture(t);
  const outcome = await preparation.prepare(run(applicationId, {}, { name: "Ada" }));
  assert.equal(outcome.state, "blocked");
  assert.equal(outcome.code, "unsupported_required_fields");
  assert.match(outcome.detail ?? "", /workAuth/);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM application_attempts").get()!.n, 0, "a blocked preparation writes no attempt");
});

test("changed answers create a new attempt instead of reusing a reviewed one", async (t) => {
  const { store, preparation, applicationId } = fixture(t);
  const first = await preparation.prepare(run(applicationId, {}, { name: "Ada", workAuth: "yes" }));
  const changed = await preparation.prepare(run(applicationId, {}, { name: "Ada", workAuth: "no" }));
  assert.equal(changed.created, true);
  assert.notEqual(changed.attemptId, first.attemptId);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM application_attempts").get()!.n, 2);
  assert.match(String((changed.manifest as Record<string, unknown>)["manifestHash"]), /^[a-f0-9]{64}$/);
});

test("a browser session is opened for the browser adapter and always closed", async (t) => {
  const sessions: { closed: boolean }[] = [];
  const { preparation, applicationId } = fixture(t, { createSession: () => {
    const session: import("../src/adapters/application.js").FormSession = {
      async open(url) { return { formUrl: url, finalUrl: url, pageUrl: url, captcha: false, automationForbidden: false,
        fields: [{ name: "name", label: "Name", type: "text", required: true }, { name: "resume", label: "Resume", type: "file", required: true }] }; },
      async fill() {}, async uploadFile() {}, async observe() { return { finalUrl: "u", filled: [], uploads: [] }; },
      async clickPreview() { return true; },
      async close() { (session as unknown as { closed: boolean }).closed = true; },
    } as unknown as import("../src/adapters/application.js").FormSession;
    sessions.push(session as unknown as { closed: boolean });
    return session;
  } });
  const outcome = await preparation.prepare({ ...run(applicationId, {}, { name: "Ada" }), adapterId: "fixture-form" });
  assert.equal(outcome.state, "draft", outcome.detail);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.closed, true, "the browser session never outlives one preparation");
});

test("CAPTCHA, forbidden automation and a manual adapter produce durable inbox handoffs", async (t) => {
  for (const [options, code] of [[{ captcha: true }, "captcha"], [{ automationForbidden: true }, "forbidden_automation"]] as const) {
    const { store, preparation, applicationId } = fixture(t);
    const outcome = await preparation.prepare(run(applicationId, options, { name: "Ada", workAuth: "yes" }));
    assert.equal(outcome.state, "needs_input", code);
    assert.equal(outcome.code, code);
    assert.equal(store.db.prepare("SELECT state FROM applications WHERE id=?").get(applicationId)!.state, "needs_input");
    const item = store.db.prepare("SELECT * FROM attention_items WHERE subject_type='application-handoff' AND state='open'").get()!;
    const context = JSON.parse(String(item["context_json"]));
    assert.ok(context.formUrl && context.answers && context.resumeVersionId, "the handoff carries URL, answers and resume");
  }
  const { preparation, applicationId } = fixture(t);
  const manual = await preparation.prepare({ ...run(applicationId, {}, { name: "Ada" }), adapterId: "manual" });
  assert.equal(manual.code, "manual_handoff");
  assert.equal(manual.state, "needs_input");
});
