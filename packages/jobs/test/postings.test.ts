import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { SettingsStore } from "../src/store.js";
import { ArtifactStore } from "../src/artifacts.js";
import { Postings, canonicalizeUrl } from "../src/postings.js";
import { AppError } from "../src/errors.js";

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-postings-"));
  const store = new SettingsStore(path.join(dir, "jobs.sqlite"));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const artifacts = new ArtifactStore(store.db, dir);
  const postings = new Postings(store.db, artifacts, () => 1_800_000_000_000);
  return { dir, store, artifacts, postings };
}

test("canonical URLs strip tracking and fragments and ignore the transport scheme", () => {
  assert.equal(canonicalizeUrl("HTTP://Example.COM/jobs/1/?utm_source=x&b=2#apply"), "http://example.com/jobs/1?b=2");
  assert.equal(canonicalizeUrl("https://example.com/jobs/1/?ref=homepage"), "https://example.com/jobs/1");
  assert.throws(() => canonicalizeUrl("/relative"), (error: unknown) => error instanceof AppError && error.code === "invalid_url");
  assert.throws(() => canonicalizeUrl("file:///etc/passwd"), (error: unknown) => error instanceof AppError);
});

test("duplicate intake keeps one posting and one eligible application", (t) => {
  const { postings } = fixture(t);
  const base = { adapterId: "fixture", company: "Acme", title: "Support Engineer", descriptionText: "Body", provenance: "source" as const };
  const first = postings.ingest({ ...base, originalUrl: "https://example.com/jobs/1/?utm_source=news#top" });
  assert.equal(first.created, true);
  const second = postings.ingest({ ...base, originalUrl: "https://example.com/jobs/1?utm_medium=mail" });
  assert.equal(second.created, false);
  assert.equal(second.jobId, first.jobId);
  assert.equal(second.applicationId, first.applicationId);
  assert.equal(postings.db.prepare("SELECT count(*) AS n FROM jobs").get()!.n, 1);
  assert.equal(postings.db.prepare("SELECT count(*) AS n FROM applications").get()!.n, 1);
  assert.equal(postings.db.prepare("SELECT state FROM applications").get()!.state, "discovered");
});

test("a redirect or shared canonical URL merges two sources into one posting", (t) => {
  const { store, postings } = fixture(t);
  const now = new Date().toISOString();
  for (const id of ["s-greenhouse", "s-aggregator"]) {
    store.db.prepare(`INSERT INTO sources(id,adapter_id,source_key,config_json,enabled,created_at,updated_at) VALUES(?,?,?,?,0,?,?)`)
      .run(id, "fixture", id, "{}", now, now);
  }
  const base = { adapterId: "fixture", company: "Acme", title: "SRE", descriptionText: "Body", provenance: "source" as const };
  const a = postings.ingest({ ...base, sourceId: "s-greenhouse", externalId: "42", originalUrl: "http://example.com/apply/42",
    canonicalUrl: "https://example.com/jobs/42" });
  const b = postings.ingest({ ...base, sourceId: "s-aggregator", externalId: "agg-9", originalUrl: "https://aggregator.example/9",
    canonicalUrl: "https://example.com/jobs/42" });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.jobId, b.jobId);
  assert.equal(postings.db.prepare("SELECT count(*) AS n FROM job_aliases").get()!.n, 2);
  assert.equal(postings.db.prepare("SELECT count(*) AS n FROM applications").get()!.n, 1);
});

test("snapshots are write-once, gated by completeness, and archive changed postings separately", (t) => {
  const { postings } = fixture(t);
  const { jobId } = postings.ingest({ adapterId: "fixture", company: "Acme", title: "Analyst", descriptionText: "v1", provenance: "browser", originalUrl: "https://example.com/jobs/9" });
  assert.throws(() => postings.recordSnapshot({ jobId, purpose: "discovery", fetchedUrl: "u", finalUrl: "u", descriptionText: "",
    captureVersion: "1", capture: {}, completeness: "complete" }), /captured text/);
  assert.throws(() => postings.recordSnapshot({ jobId, purpose: "application_preflight", fetchedUrl: "u", finalUrl: "u", descriptionText: "x",
    captureVersion: "1", capture: {}, completeness: "complete" }), /screenshot/);

  const failed = postings.recordSnapshot({ jobId, purpose: "discovery", fetchedUrl: "u", finalUrl: "u", descriptionText: "",
    captureVersion: "1", capture: { error: "timeout" }, completeness: "failed", failureDetail: "navigation timeout" });
  assert.equal(failed.created, true);
  assert.equal(postings.db.prepare("SELECT state FROM applications WHERE job_id=?").get(jobId)!.state, "discovered");

  const image = Buffer.from("png-bytes");
  const first = postings.recordSnapshot({ jobId, purpose: "discovery", fetchedUrl: "u1", finalUrl: "u2", descriptionText: "v1",
    screenshot: image, captureVersion: "1", capture: { method: "browser" }, completeness: "complete" });
  assert.equal(first.created, true);
  assert.ok(first.screenshotHash);
  assert.equal(postings.db.prepare("SELECT state FROM applications WHERE job_id=?").get(jobId)!.state, "captured");

  const repeat = postings.recordSnapshot({ jobId, purpose: "discovery", fetchedUrl: "u1", finalUrl: "u2", descriptionText: "v1",
    captureVersion: "1", capture: {}, completeness: "complete" });
  assert.equal(repeat.created, false);
  assert.equal(repeat.snapshotId, first.snapshotId);
  assert.equal(postings.db.prepare("SELECT count(*) AS n FROM job_snapshots WHERE job_id=?").get(jobId)!.n, 2);

  const changed = postings.recordSnapshot({ jobId, purpose: "discovery", fetchedUrl: "u1", finalUrl: "u2", descriptionText: "v2 with a new requirement",
    captureVersion: "1", capture: {}, completeness: "complete" });
  assert.equal(changed.created, true);
  assert.notEqual(changed.snapshotId, first.snapshotId);
  assert.equal(postings.db.prepare("SELECT count(*) AS n FROM job_snapshots WHERE job_id=?").get(jobId)!.n, 3);
  // The archived screenshot for the first capture is still readable after the posting changed.
  assert.equal(Buffer.from(postings.artifacts.read(first.screenshotHash!)).toString(), "png-bytes");
});

test("snapshot evidence cannot be edited or deleted after the fact", (t) => {
  const { store, postings } = fixture(t);
  const { jobId } = postings.ingest({ adapterId: "fixture", company: "Acme", title: "Ops", descriptionText: "v1", provenance: "browser", originalUrl: "https://example.com/jobs/10" });
  const snap = postings.recordSnapshot({ jobId, purpose: "discovery", fetchedUrl: "u", finalUrl: "u", descriptionText: "v1",
    screenshot: Buffer.from("x"), captureVersion: "1", capture: {}, completeness: "complete" });
  assert.throws(() => store.db.prepare("UPDATE job_snapshots SET description_text='tampered' WHERE id=?").run(snap.snapshotId), /immutable/);
  assert.throws(() => store.db.prepare("DELETE FROM job_snapshots WHERE id=?").run(snap.snapshotId), /immutable/);
});
