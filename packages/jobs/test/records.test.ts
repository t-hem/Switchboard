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
import { Records } from "../src/records.js";
import { healthOf, isReadOnly, readOnlyMarker, repairQueue } from "../src/health.js";
import { TaskQueue } from "../src/queue.js";

const NOW = 1_800_000_000_000;

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-records-"));
  const store = new SettingsStore(path.join(dir, "jobs.sqlite"));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const db = store.db;
  const artifacts = new ArtifactStore(db, dir);
  const postings = new Postings(db, artifacts, () => NOW);
  const library = new Library(db, () => NOW);
  const { jobId } = postings.ingest({ adapterId: "fixture", company: "Acme", title: "Engineer", originalUrl: "https://acme.example/1", descriptionText: "Body", provenance: "browser" });
  const snapshotId = postings.recordSnapshot({ jobId, purpose: "discovery", fetchedUrl: "u", finalUrl: "u", descriptionText: "Posting body",
    screenshot: Buffer.from("png"), captureVersion: "browser:1", capture: {}, completeness: "complete" }).snapshotId;
  const profile = library.addProfile({ profileId: "primary", data: { contact: { name: "Ada" }, facts: [], suggestions: [] } });
  const template = library.addTemplate({ templateId: "base", data: { name: "Base", sections: [{ id: "summary", title: "Summary", type: "facts", factKeys: ["summary"], optional: true }] } });
  const applicationId = String(db.prepare("SELECT id FROM applications WHERE job_id=?").get(jobId)!.id);

  // A task and a run, exactly as the tailoring runner would record them.
  const task = new TaskQueue(db).enqueue({ kind: "resume:tailor", input: { jobId }, settingsRevision: store.current().revision }, NOW);
  const runId = randomUUID();
  db.prepare(`INSERT INTO agent_runs(id,task_id,attempt,state,spawner_provider,spawner_instance,spawner_session_id,process_identity,parent_run_id,run_directory,deadline_at,created_at,finished_at,
    persona_text,skills_json,prompt_text,agent,model,tools_json,permissions_json,revision_hashes_json,settings_revision,outcome_json)
    VALUES(?,?,1,'exited','switchboard','inst-1','sess-1',NULL,NULL,?,?,?,?,'You are the resume assembler.','["bullet-selection"]','Tailor the resume.','claude','deepseek-v4.1-flash','["draft.write"]','{"mode":"restricted"}','{"persona":"abc"}',?,'{"pass":"build"}')`)
    .run(runId, task.id, path.join(dir, "runs", runId), NOW + 60_000, new Date(NOW).toISOString(), new Date(NOW + 1000).toISOString(), store.current().revision);
  db.prepare("INSERT INTO tool_events(run_id,sequence,call_id,tool_id,tool_version,request_json,result_json,state,occurred_at) VALUES(?,1,'c1','draft.write','1','{\"field\":\"summary\"}','{\"ok\":true}','succeeded',?)").run(runId, new Date(NOW).toISOString());
  db.prepare("INSERT INTO run_messages(run_id,sequence,role,content_json,occurred_at) VALUES(?,1,'assistant','{\"text\":\"done\"}',?)").run(runId, new Date(NOW).toISOString());

  // Both resume passes: the build, then the edit that links to it.
  const buildText = artifacts.put(Buffer.from("BUILD RESUME", "utf8"), "text/plain", "resume-text");
  const editText = artifacts.put(Buffer.from("EDITED RESUME", "utf8"), "text/plain", "resume-text");
  const insertResume = (id: string, phase: string, parent: string | null, hash: string) => db.prepare(`INSERT INTO resume_versions(id,job_snapshot_id,profile_revision_id,template_revision_id,parent_resume_id,agent_run_id,phase,source_json,selected_bullets_json,edits_json,text_artifact_hash,pdf_artifact_hash,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?)`).run(id, snapshotId, profile.id, template.id, parent, runId, phase, '{"source":"profile"}', '["b1"]', phase === "edit" ? '{"tightened":true}' : '{}', hash, new Date(NOW).toISOString());
  insertResume("resume-build", "build", null, buildText.hash);
  insertResume("resume-edit", "edit", "resume-build", editText.hash);
  db.prepare("UPDATE applications SET selected_resume_id='resume-edit' WHERE id=?").run(applicationId);

  // An approved attempt with an observed receipt.
  const receipt = artifacts.put(Buffer.from("Confirmation REF-9", "utf8"), "text/plain", "application-receipt");
  const policyId = String(db.prepare("INSERT INTO source_policies(id,scope_key,revision,adapter_id,site_url,terms_url,reviewed_at,capabilities_json,restrictions_json,created_at) VALUES(?,?,1,'fixture-form','https://forms.example',NULL,NULL,'{\"prepare\":true,\"fill\":true,\"upload\":true,\"submit\":true}','{}',?) RETURNING id").get(randomUUID(), "fixture-form:forms.example", new Date(NOW).toISOString())!.id);
  const attemptId = randomUUID();
  const manifest = { manifestHash: "a".repeat(64), formUrl: "https://forms.example/apply", snapshotId, resumeTextHash: editText.hash, answers: { name: "Ada" } };
  db.prepare(`INSERT INTO application_attempts(id,application_id,idempotency_key,adapter_id,state,snapshot_id,resume_id,settings_revision,policy_id,manifest_json,preflight_at,send_started_at,finished_at,outcome_json,receipt_hash,created_at)
    VALUES(?,?,?,?, 'submitted',?,?,?,?,?,?,?,?,?,?,?)`).run(attemptId, applicationId, randomUUID(), "fixture-form", snapshotId, "resume-edit",
    store.current().revision, policyId, JSON.stringify(manifest), new Date(NOW).toISOString(), new Date(NOW).toISOString(), new Date(NOW + 5000).toISOString(),
    JSON.stringify({ outcome: "submitted", observedBy: "service", externalId: "REF-9" }), receipt.hash, new Date(NOW).toISOString());
  db.prepare(`INSERT INTO review_decisions(id,subject_type,subject_id,subject_version,decision,reason,before_json,after_json,settings_revision,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), "application-attempt", attemptId, "a".repeat(64), "approve", "reviewed", "{}", "{}", store.current().revision, new Date(NOW).toISOString());
  const records = new Records({ db, artifacts, now: () => NOW });
  return { dir, store, db, artifacts, library, records, applicationId, snapshotId, runId, attemptId, receipt, profile };
}

test("a record carries both resume passes, the persona, tool results, decisions and the receipt", (t) => {
  const f = fixture(t);
  const record = f.records.recordOf(f.applicationId);
  const resumes = record["resumes"] as Record<string, unknown>[];
  assert.deepEqual(resumes.map(resume => resume["phase"]), ["build", "edit"]);
  assert.equal(resumes.find(resume => resume["phase"] === "edit")!["text"], "EDITED RESUME");
  assert.equal((resumes.find(resume => resume["phase"] === "edit")!["parent"] as Record<string, unknown>)["phase"], "build", "the edit pass links to the build pass");
  const runs = record["agentRuns"] as Record<string, unknown>[];
  assert.equal(runs[0]!["persona_text"], "You are the resume assembler.");
  assert.deepEqual(runs[0]!["skills"], ["bullet-selection"]);
  assert.equal(runs[0]!["model"], "deepseek-v4.1-flash");
  assert.equal((record["toolEvents"] as unknown[]).length, 1);
  assert.equal((record["runMessages"] as unknown[]).length, 1);
  const attempts = record["attempts"] as Record<string, unknown>[];
  assert.equal(attempts[0]!["state"], "submitted");
  assert.equal((attempts[0]!["manifest"] as Record<string, unknown>)["formUrl"], "https://forms.example/apply");
  assert.equal(attempts[0]!["receiptText"], "Confirmation REF-9");
  assert.equal((record["decisions"] as Record<string, unknown>[])[0]!["decision"], "approve");
  assert.equal((record["snapshots"] as Record<string, unknown>[])[0]!["description_text"], "Posting body");
  assert.equal((record["screening"] as unknown[]).length >= 0, true);
});

test("an export reconstructs offline, and later profile changes cannot rewrite it", (t) => {
  const f = fixture(t);
  const first = f.records.exportApplication(f.applicationId, path.join(f.dir, "exports", "first"));
  assert.ok(first.manifest.artifacts.length >= 3, "the export includes the resume, evidence and receipt artifacts");
  const reconstructed = Records.reconstruct(first.directory);
  assert.equal(reconstructed.verifiedArtifacts, first.manifest.artifacts.length);
  assert.equal(reconstructed.record["application"]!["id"], f.applicationId);

  // Editing the career library afterwards must not change the exported history.
  f.library.addProfile({ profileId: "primary", data: { contact: { name: "Ada Lovelace" }, facts: [], suggestions: [] } });
  const second = f.records.exportApplication(f.applicationId, path.join(f.dir, "exports", "second"));
  const before = f.records.recordOf(f.applicationId)["resumes"] as Record<string, unknown>[];
  const after = Records.reconstruct(second.directory).record["resumes"] as Record<string, unknown>[];
  assert.deepEqual(after.map(resume => resume["profile_revision_id"]), before.map(resume => resume["profile_revision_id"]));
  assert.notEqual(before[0]!["profile_revision_id"], String((f.db.prepare("SELECT id FROM profile_revisions ORDER BY revision DESC LIMIT 1").get() as Record<string, unknown>)["id"]), "the newer revision is not what history points at");

  // A tampered or missing artifact is detected, not silently accepted.
  const victim = first.manifest.artifacts[0]!.hash;
  fs.writeFileSync(path.join(first.directory, "artifacts", victim), "tampered");
  assert.throws(() => Records.reconstruct(first.directory), /missing, truncated or altered/);
  fs.rmSync(path.join(first.directory, "artifacts", victim));
  assert.throws(() => Records.reconstruct(first.directory), /ENOENT|no such file/);
});

test("an export refuses to produce an incomplete bundle", (t) => {
  const f = fixture(t);
  fs.rmSync(path.join(f.artifacts.directory, f.receipt.hash));
  assert.throws(() => f.records.exportApplication(f.applicationId, path.join(f.dir, "exports", "broken")), /Export incomplete/);
  assert.equal(fs.existsSync(path.join(f.dir, "exports", "broken")), false, "no partial directory is left at the destination");
});

test("health names missing artifacts, low disk, leftovers and a missing backup", (t) => {
  const f = fixture(t);
  const clean = healthOf(f.db, f.dir, { artifacts: f.artifacts, now: () => NOW });
  assert.equal(clean.status, "degraded", "no recorded backup is a named gap, not silence");
  assert.deepEqual(clean.problems.filter(problem => problem.severity === "error"), []);
  assert.ok(clean.problems.some(problem => problem.code === "backup_history_missing"));
  assert.equal(clean.retention.policy, "retain-all");
  assert.equal(clean.retention.pruned, 0);

  fs.rmSync(path.join(f.artifacts.directory, f.receipt.hash));
  const broken = healthOf(f.db, f.dir, { artifacts: f.artifacts, now: () => NOW, minimumFreeBytes: Number.MAX_SAFE_INTEGER });
  assert.equal(broken.status, "failed");
  assert.ok(broken.problems.some(problem => problem.code === "artifact_missing"));
  assert.ok(broken.problems.some(problem => problem.code === "disk_low"));
  fs.writeFileSync(path.join(f.artifacts.directory, "f".repeat(64)), "orphan");
  assert.ok(healthOf(f.db, f.dir, { artifacts: f.artifacts, now: () => NOW }).problems.some(problem => problem.code === "artifact_unreferenced"));
});

test("repair blocks expired leases for reconciliation and makes an interrupted submission explicitly unknown", (t) => {
  const f = fixture(t);
  const queue = new TaskQueue(f.db);
  const stale = queue.enqueue({ kind: "discovery:run", input: {}, settingsRevision: f.store.current().revision }, NOW);
  f.db.prepare("UPDATE tasks SET state='running', lease_owner='worker', lease_expires_at=? WHERE id=?").run(NOW - 1000, stale.id);
  const fresh = queue.enqueue({ kind: "discovery:run", input: {}, settingsRevision: f.store.current().revision }, NOW);
  f.db.prepare("UPDATE tasks SET state='submitting', lease_owner='worker', lease_expires_at=? WHERE id=?").run(NOW + 60_000, fresh.id);
  const veryStuck = queue.enqueue({ kind: "application:submit", effectClass: "submission", input: {}, settingsRevision: f.store.current().revision }, NOW);
  f.db.prepare("UPDATE tasks SET state='submitting', lease_owner='worker', updated_at=? WHERE id=?").run(new Date(NOW - 60 * 60 * 1000).toISOString(), veryStuck.id);

  const result = repairQueue(f.db, { now: () => NOW });
  assert.deepEqual(result.releasedLeases, [stale.id]);
  assert.deepEqual(result.unconfirmed, [veryStuck.id]);
  assert.equal(f.db.prepare("SELECT state FROM tasks WHERE id=?").get(stale.id)!.state, "blocked", "an expired lease is never re-queued: its child may still be running");
  assert.equal(JSON.parse(String(f.db.prepare("SELECT error_json FROM tasks WHERE id=?").get(stale.id)!.error_json)).code, "reconciliation_required");
  assert.equal(Number(f.db.prepare("SELECT fence FROM tasks WHERE id=?").get(stale.id)!.fence), stale.fence + 1);
  assert.equal(f.db.prepare("SELECT state FROM tasks WHERE id=?").get(veryStuck.id)!.state, "unknown", "an interrupted submission is never silently retried");
  assert.equal(f.db.prepare("SELECT state FROM tasks WHERE id=?").get(fresh.id)!.state, "submitting", "a live lease is left alone");
  assert.equal(result.left, 1);
});

test("a read-only marker is visible and creates a health note", (t) => {
  const f = fixture(t);
  assert.equal(isReadOnly(f.dir), false);
  fs.writeFileSync(readOnlyMarker(f.dir), JSON.stringify({ readOnly: true }));
  assert.equal(isReadOnly(f.dir), true);
  const report = healthOf(f.db, f.dir, { artifacts: f.artifacts, now: () => NOW });
  assert.equal(report.readOnly, true);
  assert.ok(report.problems.some(problem => problem.code === "read_only_archive"));
});