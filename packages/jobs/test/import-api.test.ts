import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { buildServer } from "../src/server.js";
import { SettingsStore } from "../src/store.js";
import { CaptureService, type CaptureOutcome, type PageCapture } from "../src/capture.js";
import type { PostingsDeps } from "../src/postings-api.js";

const token = "import-fixture-token";
const headers = { authorization: `Bearer ${token}` };

class StubPage implements PageCapture {
  constructor(private readonly result: CaptureOutcome) {}
  async capture(): Promise<CaptureOutcome> { return this.result; }
  async close(): Promise<void> { /* nothing to release */ }
}
const captureResult = (overrides: Partial<CaptureOutcome> = {}): CaptureOutcome => ({
  fetchedUrl: "https://jobs.example/post/1", finalUrl: "https://jobs.example/post/1",
  descriptionText: "Platform Engineer. Build reliable systems with Go and Kubernetes every day.",
  title: "Platform Engineer", screenshot: new Uint8Array([137, 80, 78, 71]), completeness: "complete", warning: null,
  captureJson: { method: "browser", captureVersion: "1", scrolls: 2, textLength: 71, screenshotBytes: 4 }, ...overrides,
});

function fixture(t: TestContext, deps: PostingsDeps = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-import-"));
  const store = new SettingsStore(path.join(dir, "jobs.sqlite"));
  let closed = false;
  const close = store.close.bind(store);
  store.close = () => { if (!closed) { closed = true; close(); } };
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const app = buildServer({ port: 7780, token, allowedOrigins: [] }, store, dir, { deps });
  t.after(() => app.close());
  return { dir, store, app };
}

test("manual import records text provenance and duplicate intake stays a single application", async t => {
  const { store, app } = fixture(t);
  const payload = { url: "https://jobs.example/post/2", company: "Acme", title: "Support Engineer", descriptionText: "Provide support for the platform." };
  assert.equal((await app.inject({ url: "/api/import/manual" })).statusCode, 401);
  const first = await app.inject({ url: "/api/import/manual", method: "POST", headers, payload });
  assert.equal(first.statusCode, 200);
  const body = first.json();
  assert.equal(body.created, true);
  const again = await app.inject({ url: "/api/import/manual", method: "POST", headers, payload: { ...payload, url: "https://jobs.example/post/2?utm_source=mail" } });
  assert.equal(again.json().created, false);
  assert.equal(again.json().jobId, body.jobId);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM applications").get()!.n, 1);
  const snapshot = store.db.prepare("SELECT * FROM job_snapshots WHERE job_id=?").get(body.jobId)!;
  assert.equal(snapshot["completeness"], "partial");
  assert.equal(snapshot["screenshot_hash"], null);
  assert.equal(JSON.parse(String(snapshot["capture_json"]))["method"], "manual");
  assert.equal(store.db.prepare("SELECT state FROM applications").get()!.state, "discovered");
});

test("URL import stores verified text and screenshot evidence and marks the posting captured", async t => {
  const { store, app } = fixture(t, { capture: new CaptureService(new StubPage(captureResult()), 0) });
  const response = await app.inject({ url: "/api/import/url", method: "POST", headers, payload: { url: "https://jobs.example/post/1", company: "Acme" } });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.completeness, "complete");
  assert.ok(body.screenshotHash);
  assert.equal(store.db.prepare("SELECT state FROM applications WHERE job_id=?").get(body.jobId)!.state, "captured");
  const download = await app.inject({ url: `/api/artifacts/${body.screenshotHash}`, headers });
  assert.equal(download.statusCode, 200);
  assert.match(String(download.headers["content-disposition"]), /attachment/);
  assert.deepEqual([...download.rawPayload], [137, 80, 78, 71]);
});

test("URL import reports an unavailable browser instead of pretending to capture", async t => {
  const { app } = fixture(t, { capture: null });
  const response = await app.inject({ url: "/api/import/url", method: "POST", headers, payload: { url: "https://jobs.example/post/1", company: "Acme" } });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "browser_unavailable");
});

test("a partial browser capture is recorded but does not promote the application", async t => {
  const { store, app } = fixture(t, { capture: new CaptureService(new StubPage(captureResult({ completeness: "partial", warning: "Captured text is unusually short", descriptionText: "Loading" })), 0) });
  const body = (await app.inject({ url: "/api/import/url", method: "POST", headers, payload: { url: "https://jobs.example/post/3", company: "Acme" } })).json();
  assert.equal(body.completeness, "partial");
  assert.match(body.warning, /short/);
  assert.equal(store.db.prepare("SELECT state FROM applications WHERE job_id=?").get(body.jobId)!.state, "discovered");
});

test("source config rejects unknown adapters and disabled sources cannot be discovered", async t => {
  const { app } = fixture(t);
  const unknown = await app.inject({ url: "/api/sources/nope", method: "PUT", headers, payload: { adapterId: "does-not-exist", sourceKey: "nope", config: { companyName: "X", boardId: "x" } } });
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.json().error.code, "unknown_adapter");
  const created = await app.inject({ url: "/api/sources/acme", method: "PUT", headers, payload: { adapterId: "fixture", sourceKey: "acme", config: { companyName: "Acme", boardId: "acme" } } });
  assert.equal(created.statusCode, 200);
  assert.equal(created.json().enabled, false);
  const blocked = await app.inject({ url: "/api/sources/acme/discover", method: "POST", headers, payload: {} });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().error.code, "source_disabled");
});

test("a config-only source update preserves operator enabled state", async t => {
  const { app } = fixture(t);
  await app.inject({ url: "/api/sources/acme", method: "PUT", headers, payload: { adapterId: "fixture", sourceKey: "acme", enabled: true, config: { companyName: "Acme", boardId: "acme" } } });
  const updated = await app.inject({ url: "/api/sources/acme", method: "PUT", headers, payload: { adapterId: "fixture", sourceKey: "acme", config: { companyName: "Acme", boardId: "acme-2" } } });
  assert.equal(updated.json().enabled, true);
  assert.equal(updated.json().config.boardId, "acme-2");
});

test("enabled discovery ingests postings once and records partial scans as blocked", async t => {
  const { store, app } = fixture(t);
  const config = { companyName: "Acme", boardId: "acme", fixture: { postings: [
    { id: "1", url: "https://acme.example/1", title: "Cloud Engineer", location: "Remote", body: "Operate Kubernetes" },
    { id: "2", url: "https://acme.example/2", title: "Support Engineer", location: "Austin", body: "Help customers" },
  ] } };
  await app.inject({ url: "/api/sources/acme", method: "PUT", headers, payload: { adapterId: "fixture", sourceKey: "acme", config, enabled: true } });
  const first = await app.inject({ url: "/api/sources/acme/discover", method: "POST", headers, payload: {} });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().created, 2);
  assert.equal(first.json().complete, true);
  const second = await app.inject({ url: "/api/sources/acme/discover", method: "POST", headers, payload: {} });
  assert.equal(second.json().created, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM jobs").get()!.n, 2);
  assert.equal(store.db.prepare("SELECT state FROM search_runs ORDER BY created_at DESC LIMIT 1").get()!.state, "completed");
  assert.ok(store.db.prepare("SELECT count(*) AS n FROM artifacts WHERE purpose='source-response'").get()!.n >= 1);

  await app.inject({ url: "/api/sources/partial", method: "PUT", headers, payload: { adapterId: "fixture", sourceKey: "partial", enabled: true,
    config: { companyName: "Partial Co", boardId: "partial", fixture: { partial: true, postings: [{ id: "p1", url: "https://partial.example/1", title: "Ops", body: "Body" }] } } } });
  const partial = await app.inject({ url: "/api/sources/partial/discover", method: "POST", headers, payload: {} });
  assert.equal(partial.statusCode, 200);
  assert.equal(partial.json().complete, false);
  assert.equal(store.db.prepare("SELECT state FROM search_runs WHERE source_id='partial'").get()!.state, "blocked");
  // A partial scan still stores what it saw, and closes nothing.
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM jobs").get()!.n, 3);
});
