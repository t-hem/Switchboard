import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { SettingsStore } from "../src/store.js";
import { ArtifactStore } from "../src/artifacts.js";
import { Library } from "../src/library.js";
import { Postings } from "../src/postings.js";
import { Sources } from "../src/sources.js";
import { Discovery } from "../src/discovery.js";
import type { HttpClient } from "../src/net.js";
import type { SourceConfig } from "../src/adapters/source.js";
import "../src/adapters/fixture.js";

const offline: HttpClient = { async get() { throw new Error("discovery fixture must not use the network"); } };
function fixture(t: TestContext, configs: Record<string, SourceConfig>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-discovery-"));
  const store = new SettingsStore(path.join(dir, "jobs.sqlite"));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const artifacts = new ArtifactStore(store.db, dir);
  const postings = new Postings(store.db, artifacts, () => 1_800_000_000_000);
  const sources = new Sources(store.db, () => 1_800_000_000_000);
  for (const [id, config] of Object.entries(configs)) sources.upsert({ id, adapterId: "fixture", sourceKey: id, config, enabled: true });
  const discovery = new Discovery(store.db, sources, postings, artifacts, offline, () => 1_800_000_000_000);
  return { store, sources, postings, discovery };
}
const job = (id: string) => ({ id, url: `https://acme.example/${id}`, title: `Role ${id}`, location: "Remote", body: `Body ${id}` });

test("a paginated source is checkpointed, resumed and never duplicated", async (t) => {
  const { store, discovery } = fixture(t, { acme: { companyName: "Acme", boardId: "acme", requests: { maxPostingsPerRun: 10 },
    fixture: { pagination: { pageSize: 2 }, postings: [1, 2, 3, 4, 5].map(n => job(`j${n}`)) } } });

  const first = await discovery.run("acme", { settingsRevision: 1, cap: 3 });
  assert.equal(first.discovered, 3);
  assert.equal(first.pages, 2);
  assert.equal(first.complete, false, "a cap is not exhaustion");
  assert.deepEqual(first.checkpoint, { offset: 3 });
  assert.equal(store.db.prepare("SELECT state FROM search_runs WHERE id=?").get(first.searchRunId)!.state, "blocked");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM jobs").get()!.n, 3);

  // Resume from the stored checkpoint rather than restarting the scan.
  const resumed = await discovery.run("acme", { settingsRevision: 1, cap: 10, resume: true });
  assert.equal(resumed.discovered, 2);
  assert.equal(resumed.complete, true);
  assert.equal(resumed.checkpoint, null);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM jobs").get()!.n, 5);

  // A completed scan supersedes the old partial one: the next resumable run starts over.
  assert.equal(discovery.resumeCheckpoint("acme"), null);
  const rescan = await discovery.run("acme", { settingsRevision: 1, cap: 10, resume: true });
  assert.equal(rescan.discovered, 5, "a stale checkpoint must not skip the start of the board forever");

  // Repeating a full discovery creates no duplicates and no duplicate applications.
  const repeat = await discovery.run("acme", { settingsRevision: 1, cap: 10 });
  assert.equal(repeat.created, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM applications").get()!.n, 5);
});

test("a rate limit is retried with the stated backoff and then succeeds", async (t) => {
  const { discovery } = fixture(t, { acme: { companyName: "Acme", boardId: "acme",
    fixture: { rateLimit: { firstAttempts: 1, retryAfterMs: 1 }, postings: [job("a"), job("b")] } } });
  const result = await discovery.run("acme", { settingsRevision: 1, maxRetries: 2 });
  assert.equal(result.complete, true);
  assert.equal(result.discovered, 2);
});

test("exhausted retries fail the run visibly and create nothing", async (t) => {
  const { store, discovery } = fixture(t, { acme: { companyName: "Acme", boardId: "acme",
    fixture: { rateLimit: { firstAttempts: 9, retryAfterMs: 1 }, postings: [job("a")] } } });
  await assert.rejects(discovery.run("acme", { settingsRevision: 1, maxRetries: 1 }), /Fixture rate limit/);
  const run = store.db.prepare("SELECT state,error_json FROM search_runs ORDER BY rowid DESC LIMIT 1").get()!;
  assert.equal(run["state"], "failed");
  assert.equal(JSON.parse(String(run["error_json"]))["code"], "rate_limited");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM jobs").get()!.n, 0);
});

test("a partial scan is blocked, not complete, and closes nothing", async (t) => {
  const { store, discovery } = fixture(t, { acme: { companyName: "Acme", boardId: "acme",
    fixture: { partial: true, postings: [job("a"), job("b")] } } });
  const result = await discovery.run("acme", { settingsRevision: 1 });
  assert.equal(result.complete, false);
  assert.equal(result.discovered, 2, "what was seen is still stored");
  assert.equal(store.db.prepare("SELECT state FROM search_runs WHERE id=?").get(result.searchRunId)!.state, "blocked");
});

test("a disabled source refuses discovery", async (t) => {
  const { sources, discovery } = fixture(t, { acme: { companyName: "Acme", boardId: "acme", fixture: { postings: [job("a")] } } });
  sources.upsert({ id: "acme", adapterId: "fixture", sourceKey: "acme", enabled: false, config: { companyName: "Acme", boardId: "acme" } });
  await assert.rejects(discovery.run("acme", { settingsRevision: 1 }), (error: unknown) => (error as { code?: string }).code === "source_disabled");
});
