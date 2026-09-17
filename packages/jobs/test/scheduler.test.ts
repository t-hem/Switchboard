import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { SettingsStore } from "../src/store.js";
import { ArtifactStore } from "../src/artifacts.js";
import { Postings } from "../src/postings.js";
import { Sources } from "../src/sources.js";
import { Discovery } from "../src/discovery.js";
import { TaskQueue } from "../src/queue.js";
import { DiscoveryScheduler, schedulerStatus } from "../src/scheduler.js";
import type { HttpClient } from "../src/net.js";
import type { SourceConfig } from "../src/adapters/source.js";
import "../src/adapters/fixture.js";

const offline: HttpClient = { async get() { throw new Error("scheduler fixture must not use the network"); } };
const job = (id: string) => ({ id, url: `https://acme.example/${id}`, title: `Role ${id}`, body: `Body ${id}` });

function fixture(t: TestContext, configs: Record<string, SourceConfig>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-scheduler-"));
  const store = new SettingsStore(path.join(dir, "jobs.sqlite"));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const artifacts = new ArtifactStore(store.db, dir);
  const postings = new Postings(store.db, artifacts, () => clock);
  const sources = new Sources(store.db, () => clock);
  for (const [id, config] of Object.entries(configs)) sources.upsert({ id, adapterId: "fixture", sourceKey: id, config, enabled: true });
  const discovery = new Discovery(store.db, sources, postings, artifacts, offline, () => clock);
  const queue = new TaskQueue(store.db);
  const scheduler = new DiscoveryScheduler({ store, sources, discovery, queue, owner: "test-worker", now: () => clock });
  const setSettings = (patch: Partial<{ enabled: boolean; paused: boolean }>) => {
    const current = store.current();
    store.update(current.revision, { ...current.value, ...patch });
  };
  return { store, sources, postings, scheduler, queue, setSettings, status: () => schedulerStatus(store, store.db, clock) };
}
let clock = 1_800_000_000_000;

test("scheduling is off until jobs are enabled and not paused", async (t) => {
  const { scheduler, setSettings, status } = fixture(t, { acme: { companyName: "Acme", boardId: "acme", fixture: { postings: [job("a")] } } });
  assert.equal(status().state, "disabled");
  assert.equal(status().dispatchAvailable, false);
  assert.deepEqual((await scheduler.runOnce()).results, []);

  setSettings({ enabled: true, paused: true });
  assert.equal(status().state, "paused");
  assert.equal((await scheduler.runOnce()).state, "paused");

  setSettings({ enabled: true, paused: false });
  assert.equal(status().state, "idle");
  assert.equal(status().dispatchAvailable, true);
});

test("a source is due by interval and never stampedes after restart", async (t) => {
  const { scheduler, status, setSettings } = fixture(t, { acme: { companyName: "Acme", boardId: "acme",
    schedule: { intervalMinutes: 1 }, fixture: { postings: [job("a")] } } });
  setSettings({ enabled: true, paused: false });
  // Never run: due immediately (or a restart would leave it unscheduled forever).
  assert.deepEqual(status().dueSources, ["acme"]);
  const cycle = await scheduler.runOnce();
  assert.equal(cycle.state, "ran");
  assert.equal(cycle.results[0]!.outcome!.complete, true);
  assert.deepEqual(status().dueSources, [], "a completed run is not immediately due again");
  assert.match(String(status().nextRunAt), /^20\d\d-/, "the next run time is reported");

  clock += 61_000;
  assert.deepEqual(status().dueSources, ["acme"]);
  assert.equal(status().nextRunAt, null, "nothing is scheduled ahead while a source is due");
});

test("a cap bounds one cycle and leaves a resumable checkpoint", async (t) => {
  const { scheduler, postings, setSettings } = fixture(t, { acme: { companyName: "Acme", boardId: "acme",
    requests: { maxPostingsPerRun: 2 }, fixture: { pagination: { pageSize: 2 }, postings: [1, 2, 3, 4].map(n => job(`j${n}`)) } } });
  setSettings({ enabled: true, paused: false });
  const cycle = await scheduler.runOnce();
  assert.equal(cycle.state, "ran");
  const outcome = cycle.results[0]!.outcome!;
  assert.equal(outcome.discovered, 2);
  assert.equal(outcome.complete, false);
  assert.deepEqual(outcome.checkpoint, { offset: 2 });
  assert.equal(postings.db.prepare("SELECT count(*) AS n FROM jobs").get()!.n, 2);
});

test("a second scheduler cannot run alongside the owner", async (t) => {
  const { scheduler, queue, setSettings } = fixture(t, { acme: { companyName: "Acme", boardId: "acme", fixture: { postings: [job("a")] } } });
  setSettings({ enabled: true, paused: false });
  const lease = queue.acquireScheduler("other-worker", 60_000, clock);
  assert.ok(lease);
  assert.equal((await scheduler.runOnce()).state, "locked");
  queue.releaseScheduler(lease, clock);
  assert.equal((await scheduler.runOnce()).state, "ran");
});

test("manual run-now cannot overlap a cycle using the worker's shared lease", async t => {
  const f = fixture(t, { acme: { companyName: "Acme", boardId: "acme", fixture: { postings: [job("a")] } } });
  f.setSettings({ enabled: true, paused: false });
  const lease = f.queue.acquireScheduler("shared-worker", 60_000, clock)!;
  f.scheduler.useLease(() => lease);
  const first = f.scheduler.runOnce();
  assert.equal((await f.scheduler.runOnce({ force: true })).state, "locked");
  assert.equal((await first).state, "ran");
  f.queue.releaseScheduler(lease, clock);
  const successor = f.queue.acquireScheduler("shared-worker", 60_000, clock)!;
  assert.ok(successor.generation > lease.generation);
  assert.throws(() => f.queue.renewScheduler(lease, 60_000, clock), /expired or changed/);
});

test("a broken source does not stall the others, and one cycle is bounded", async (t) => {
  const configs: Record<string, SourceConfig> = {};
  for (let n = 1; n <= 6; n++) configs[`s${n}`] = { companyName: `Co ${n}`, boardId: `s${n}`, fixture: { postings: [job(`s${n}-a`)] } };
  configs["broken"] = { companyName: "Broken", boardId: "broken", fixture: { rateLimit: { firstAttempts: 9 }, postings: [job("never")] } };
  const { scheduler, setSettings } = fixture(t, configs);
  setSettings({ enabled: true, paused: false });
  const cycle = await scheduler.runOnce();
  assert.equal(cycle.state, "ran");
  assert.ok(cycle.results.length <= 5, "one cycle processes at most the configured number of sources");
  assert.ok(cycle.results.every(entry => entry.outcome || entry.error), "each source reports an outcome or an error");
});
