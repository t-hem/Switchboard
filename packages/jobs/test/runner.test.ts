import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { SettingsStore } from "../src/store.js";
import { ArtifactStore } from "../src/artifacts.js";
import { Library } from "../src/library.js";
import { ResumeRenderer } from "../src/resume.js";
import { Postings } from "../src/postings.js";
import { TaskQueue } from "../src/queue.js";
import { Reviews } from "../src/reviews.js";
import { TailoringRunner, enqueueTailoring, lineDiff } from "../src/runner.js";
import { buildServer } from "../src/server.js";
import { createServices } from "../src/services.js";
import { JobsWorker } from "../src/worker.js";
import { createInvocationAdapter } from "../src/invocation.js";
import { registerSpawnerProvider, type AgentSpawner, type SpawnerCreateRequest, type SpawnerSession } from "../src/adapters/spawner.js";
import type { StructuredResume } from "../src/resume.js";

const personasDir = new URL("../personas/", import.meta.url).pathname;
type Behaviour = { state?: "running" | "exited" | "lost"; exitCode?: number | null; result?: unknown; raw?: string; write?: boolean; responseLost?: boolean };
class FakeSpawner implements AgentSpawner {
  readonly provider = "fake";
  readonly created: SpawnerCreateRequest[] = [];
  readonly stopped: string[] = [];
  private readonly sessions = new Map<string, SpawnerSession>();
  /** Test hook: run before inspect returns, to stage cancellation or a host restart mid-run. */
  onInspect?: (id: string) => void;
  /** Every call fails, as while the host restarts. */
  unreachable = false;
  finish(id: string, exitCode = 0): void { const session = this.sessions.get(id); if (session) this.sessions.set(id, { ...session, state: "exited", exitCode }); }
  forget(id: string): void { this.sessions.delete(id); }
  constructor(private readonly behaviour: (request: SpawnerCreateRequest, index: number) => Behaviour | Promise<Behaviour>) {}
  async health() { return { available: true }; }
  async list() { if (this.unreachable) throw new Error("ECONNREFUSED"); return [...this.sessions.values()]; }
  async inspect(id: string) { if (this.unreachable) throw new Error("ECONNREFUSED"); this.onInspect?.(id); return this.sessions.get(id) ?? null; }
  async create(request: SpawnerCreateRequest) {
    this.created.push(request);
    const result = await this.behaviour(request, this.created.length);
    const id = `sess-${this.created.length}`;
    const state = result.state ?? "exited";
    if (result.write !== false && (result.result !== undefined || result.raw !== undefined)) {
      fs.writeFileSync(path.join(request.cwd, "result.json"), result.raw ?? JSON.stringify(result.result));
    }
    // A 'lost' session is created but never appears in inspect's inventory.
    const session: SpawnerSession = { id, label: request.label, state: state === "exited" ? "exited" : "running",
      exitCode: result.exitCode ?? (state === "exited" ? 0 : null), idempotencyKey: request.idempotencyKey ?? null };
    if (state !== "lost") this.sessions.set(id, session);
    // Simulate a lost create *response* after the host already created the session.
    if (result.responseLost) throw new Error("socket hang up");
    return session;
  }
  async stop(id: string) { this.stopped.push(id); }
}

type Fixture = ReturnType<typeof fixture>;
function fixture(t: TestContext, behaviour: (request: SpawnerCreateRequest, index: number, f: Fixture) => Behaviour | Promise<Behaviour>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-runner-"));
  const store = new SettingsStore(path.join(dir, "jobs.sqlite"));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const artifacts = new ArtifactStore(store.db, dir);
  const library = new Library(store.db, () => 1_800_000_000_000);
  const postings = new Postings(store.db, artifacts, () => 1_800_000_000_000);
  const { jobId, applicationId } = postings.ingest({ adapterId: "fixture", company: "Acme", title: "Platform Engineer",
    originalUrl: "https://acme.example/1", descriptionText: "We need Go, Kubernetes and PostgreSQL.", provenance: "browser" });
  const snapshotId = postings.recordSnapshot({ jobId, purpose: "discovery", fetchedUrl: "u", finalUrl: "u",
    descriptionText: "We need Go, Kubernetes and PostgreSQL.", screenshot: Buffer.from("png"), captureVersion: "browser:1", capture: {}, completeness: "complete" }).snapshotId;
  const profile = library.addProfile({ profileId: "primary", data: { contact: { name: "Ada Lovelace", email: "ada@example.com" }, summary: "Platform engineer.", facts: [{ key: "skill", value: "Go, Kubernetes", verified: true }], suggestions: [] } });
  library.addBullets({ profileRevisionId: profile.id, bullets: [
    { bulletId: "b-go", prose: "Built Go services.", tags: ["go"] },
    { bulletId: "b-db", prose: "Tuned PostgreSQL.", tags: ["postgresql"] },
  ] });
  const template = library.addTemplate({ templateId: "base", data: { name: "Base", sections: [
    { id: "summary", title: "Summary", type: "facts", factKeys: ["summary"] },
    { id: "experience", title: "Experience", type: "bullets", limit: 2 },
  ] } });
  // Claims are refused while jobs are disabled or paused.
  store.update(store.current().revision, { ...store.current().value, enabled: true, paused: false, personaDirectory: personasDir });
  const holder: { f?: Fixture } = {};
  const spawner = new FakeSpawner((request, index) => behaviour(request, index, holder.f!));
  const queue = new TaskQueue(store.db);
  const reviews = new Reviews(store.db);
  const runner = new TailoringRunner({ db: store.db, artifacts, library, renderer: new ResumeRenderer(store.db, artifacts, library),
    queue, reviews, personasDir, spawner, invocation: createInvocationAdapter("pi"), dataDir: dir,
    spawnerProvider: "fake", spawnerInstance: "test", now: () => Date.now(), sleep: async () => { await new Promise(resolve => setTimeout(resolve, 1)); }, pollMs: 1, timeoutMs: 50 });
  const bullets = library.bullets(profile.id);
  const worker = queue.acquireScheduler("test-worker", 300_000)!;
  /** Claims the next queued stage as a worker would and runs it. */
  const next = (options: Parameters<TailoringRunner["runClaimed"]>[1] = {}) => runner.runClaimed(queue.claim(worker, 300_000)!, options);
  /** Queues tailoring for the fixture's application and runs the assembly stage. */
  const start = (options: Parameters<TailoringRunner["runClaimed"]>[1] = {}) => {
    enqueueTailoring(queue, { applicationId, jobSnapshotId: snapshotId, profileRevisionId: profile.id, templateRevisionId: template.id }, store.current().revision);
    return next(options);
  };
  const f = { dir, store, artifacts, library, runner, spawner, queue, profile, template, snapshotId, applicationId, bullets, worker, start, next };
  holder.f = f;
  return f;
}
/** What `finalize_resume` produces for this fixture's profile and template, with the given bullet lines. */
const structured = (snapshotId: string, profileId: string, templateId: string, lines: string[], summary = ["Platform engineer."]): StructuredResume =>
  ({ jobSnapshotId: snapshotId, profileRevisionId: profileId, templateRevisionId: templateId,
    heading: { name: "Ada Lovelace", contact: ["ada@example.com"] },
    sections: [{ id: "summary", title: "Summary", lines: summary }, { id: "experience", title: "Experience", lines }], missing: [] });
/** A valid assembly result selecting the fixture's first bullet (b-db, ordered by bullet id). */
const assembled = (f: Fixture) => ({ structured: structured(f.snapshotId, f.profile.id, f.template.id, [f.bullets[0]!.prose]),
  selectedBullets: [{ bulletId: f.bullets[0]!.bulletId, revisionId: f.bullets[0]!.id, prose: f.bullets[0]!.prose, tags: f.bullets[0]!.tags, matched: [], score: 0 }] });
const count = (f: Fixture, sql: string, ...params: string[]) => Number(f.store.db.prepare(sql).get(...params)!["n"]);

test("a valid assembly run saves a build version, evidence and a pending review, then queues the edit stage", async (t) => {
  const f = fixture(t, (_request, _index, g) => ({ result: { ...assembled(g),
    toolCalls: [{ toolId: "find_bullets", request: { tags: ["go"] }, result: [], state: "succeeded" }], messages: [{ role: "assistant", content: "done" }] } }));
  const outcome = await f.start();
  assert.equal(outcome.state, "waiting_review", outcome.error);
  assert.ok(outcome.resumeVersionId);
  const version = f.store.db.prepare("SELECT * FROM resume_versions WHERE id=?").get(outcome.resumeVersionId!)!;
  assert.equal(version["phase"], "build");
  assert.equal(version["agent_run_id"], outcome.runId);
  const task = f.queue.get(outcome.taskId)!;
  assert.equal(task.state, "waiting_review");
  assert.equal(task.leaseOwner, null, "the lease is released while the result waits on the operator");
  assert.equal(count(f, "SELECT count(*) AS n FROM tool_events WHERE run_id=?", outcome.runId), 1);
  assert.equal(count(f, "SELECT count(*) AS n FROM run_messages WHERE run_id=?", outcome.runId), 1);
  assert.equal(count(f, "SELECT count(*) AS n FROM attention_items WHERE state='open'"), 1);
  assert.equal(f.store.db.prepare("SELECT state FROM agent_runs WHERE id=?").get(outcome.runId)!.state, "exited");
  const edit = f.store.db.prepare("SELECT state,parent_task_id,input_json FROM tasks WHERE kind='resume:edit'").get()!;
  assert.equal(edit.state, "queued");
  assert.equal(edit.parent_task_id, outcome.taskId);
  assert.equal(JSON.parse(String(edit.input_json)).parentResumeId, outcome.resumeVersionId);
  // The configured model and the task file travel in argv; the fake spawner received them.
  const argv = f.spawner.created[0]!.extraArgs!;
  assert.equal(argv[argv.indexOf("--model") + 1], "openrouter/deepseek/deepseek-v4.1-flash");
  assert.ok(argv.some(argument => argument.startsWith("@") && argument.endsWith("task.md")));
  assert.match(f.spawner.created[0]!.label!, new RegExp(`^jobs:${f.applicationId}:tailor:assemble:`));
});

test("the two passes save both versions and diff the edit against assembly", async (t) => {
  const f = fixture(t, (_request, index, g) => {
    const line = index === 1 ? [g.bullets[0]!.prose] : ["Tuned PostgreSQL for high-throughput workloads."];
    return { result: { structured: structured(g.snapshotId, g.profile.id, g.template.id, line), selectedBullets: assembled(g).selectedBullets,
      edits: index === 2 ? [{ bulletId: g.bullets[0]!.bulletId, before: g.bullets[0]!.prose, after: line[0]!, reason: "align terminology" }] : [] } };
  });
  const assembly = await f.start();
  const edit = await f.next();
  assert.equal(assembly.state, "waiting_review", assembly.error);
  assert.equal(edit.state, "waiting_review", edit.error);
  assert.notEqual(assembly.resumeVersionId, edit.resumeVersionId);
  const edited = f.store.db.prepare("SELECT * FROM resume_versions WHERE id=?").get(edit.resumeVersionId!)!;
  assert.equal(edited["phase"], "edit");
  assert.equal(edited["parent_resume_id"], assembly.resumeVersionId);
  assert.equal(edited["agent_run_id"], edit.runId);
  const edits = JSON.parse(String(edited["edits_json"]));
  assert.equal(edits.edits[0].reason, "align terminology");
  assert.ok(edits.diff.some((line: { type: string }) => line.type === "add"));
  assert.match(Buffer.from(f.artifacts.read(String(edited["text_artifact_hash"]))).toString("utf8"), /high-throughput/);
  assert.match(fs.readFileSync(path.join(f.spawner.created[1]!.cwd, "task.md"), "utf8"), /Tuned PostgreSQL\./,
    "the edit task file carries the assembled resume");
  assert.equal(count(f, "SELECT count(*) AS n FROM attention_items WHERE state='open'"), 2);
  assert.equal(count(f, "SELECT count(*) AS n FROM tasks WHERE state='waiting_review'"), 2);
  assert.equal(count(f, "SELECT count(*) AS n FROM tasks WHERE kind='resume:edit'"), 1, "an accepted edit queues nothing further");
});

test("fake agents expose missing, malformed, unsupported, nonzero and lost failures", async (t) => {
  const cases: { name: string; behaviour: (f: Fixture) => Behaviour; error: string }[] = [
    { name: "missing output", behaviour: () => ({ write: false }), error: "without a result file" },
    { name: "malformed output", behaviour: () => ({ raw: "not json" }), error: "was not JSON" },
    { name: "changed inputs", behaviour: () => ({ result: { structured: structured("other", "other", "other", ["x"]), selectedBullets: [] } }), error: "changed the run's snapshot" },
    { name: "nonzero exit", behaviour: () => ({ exitCode: 3, write: false }), error: "exited with code 3" },
    { name: "lost session", behaviour: () => ({ state: "lost", write: false }), error: "disappeared" },
    { name: "unsupported bullet", error: "not part of this profile revision", behaviour: f => ({ result: { structured: structured(f.snapshotId, f.profile.id, f.template.id, ["Invented achievement."]),
      selectedBullets: [{ bulletId: "invented", revisionId: "not-a-real-revision", prose: "Invented achievement.", tags: [], matched: [], score: 0 }] } }) },
  ];
  for (const scenario of cases) {
    const f = fixture(t, (_request, _index, g) => scenario.behaviour(g));
    const outcome = await f.start();
    assert.equal(outcome.state, "failed", scenario.name);
    assert.match(outcome.error ?? "", new RegExp(scenario.error), scenario.name);
    assert.equal(f.queue.get(outcome.taskId)!.state, "failed", scenario.name);
    assert.equal(count(f, "SELECT count(*) AS n FROM tasks WHERE kind='resume:edit'"), 0, `${scenario.name}: a failed assembly queues no edit`);
  }
});

test("a lost create response is rediscovered by idempotency key instead of spawning twice", async (t) => {
  const f = fixture(t, (_request, _index, g) => ({ responseLost: true, exitCode: 0, result: assembled(g) }));
  const outcome = await f.start();
  assert.equal(outcome.state, "waiting_review", outcome.error);
  assert.equal(f.spawner.created.length, 1, "no second spawn after a lost response");
  assert.match(f.spawner.created[0]!.idempotencyKey!, /^jobs:[0-9a-f-]+:assemble:1$/, "the key names the attempt, so a retry is a new session");
});

test("a result from a superseded run is refused rather than saved", async (t) => {
  const f = fixture(t, (_request, _index, g) => ({ state: "running", result: assembled(g) }));
  // Cancel the run while the agent is still running, as a cancel path would.
  f.spawner.onInspect = id => { f.store.db.prepare("UPDATE agent_runs SET state='cancelled' WHERE state='running'").run(); f.spawner.finish(id); };
  const outcome = await f.start();
  assert.equal(outcome.state, "failed");
  assert.match(outcome.error ?? "", /late result/);
  assert.equal(count(f, "SELECT count(*) AS n FROM resume_versions"), 0);
});

test("a task cancelled while its agent runs never accepts the late result", async (t) => {
  const f = fixture(t, (_request, _index, g) => ({ state: "running", result: assembled(g) }));
  f.spawner.onInspect = id => { f.queue.cancel(String(f.store.db.prepare("SELECT id FROM tasks WHERE kind='resume:assemble'").get()!.id), "operator"); f.spawner.finish(id); };
  const outcome = await f.start();
  assert.equal(outcome.state, "failed");
  assert.match(outcome.error ?? "", /lease expired, was cancelled/);
  assert.equal(f.queue.get(outcome.taskId)!.state, "cancelled", "an operator cancellation stays cancelled");
  assert.equal(f.store.db.prepare("SELECT state FROM agent_runs WHERE id=?").get(outcome.runId)!.state, "cancelled");
  assert.equal(count(f, "SELECT count(*) AS n FROM resume_versions"), 0);
});

test("invented content is rejected even when it references a real bullet revision", async (t) => {
  const cases: { name: string; result: (f: Fixture) => unknown; error: RegExp }[] = [
    { name: "invented bullet line", error: /not the stored prose of a selected bullet/,
      result: f => ({ ...assembled(f), structured: structured(f.snapshotId, f.profile.id, f.template.id, ["Led a team of 40 engineers at Google."]) }) },
    { name: "invented summary", error: /only the profile's own facts/,
      result: f => ({ ...assembled(f), structured: structured(f.snapshotId, f.profile.id, f.template.id, [f.bullets[0]!.prose], ["Staff engineer with 15 years at Google."]) }) },
    { name: "invented heading", error: /heading must be the profile's own/,
      result: f => ({ ...assembled(f), structured: { ...structured(f.snapshotId, f.profile.id, f.template.id, [f.bullets[0]!.prose]), heading: { name: "Ada Lovelace, PhD", contact: ["ada@example.com"] } } }) },
    { name: "dropped section", error: /every template section exactly once/,
      result: f => ({ ...assembled(f), structured: { ...structured(f.snapshotId, f.profile.id, f.template.id, [f.bullets[0]!.prose]), sections: [] } }) },
  ];
  for (const scenario of cases) {
    const f = fixture(t, (_request, _index, g) => ({ result: scenario.result(g) }));
    const outcome = await f.start();
    assert.equal(outcome.state, "failed", scenario.name);
    assert.match(outcome.error ?? "", scenario.error, scenario.name);
  }

  // A valid result is persisted from stored data, not from the model's copy of it.
  const f = fixture(t, (_request, _index, g) => ({ result: { structured: { ...assembled(g).structured, missing: ["model-made omission"] },
    selectedBullets: [{ ...assembled(g).selectedBullets[0]!, prose: "Model's own prose", tags: ["invented"], score: 99 }] } }));
  const saved = await f.start();
  assert.equal(saved.state, "waiting_review", saved.error);
  const version = f.store.db.prepare("SELECT source_json,selected_bullets_json FROM resume_versions WHERE id=?").get(saved.resumeVersionId!)!;
  assert.deepEqual(JSON.parse(String(version.source_json)).missing, ["Experience: 1 of 2 bullet slots unfilled"]);
  assert.deepEqual(JSON.parse(String(version.selected_bullets_json)).map((bullet: { prose: string; score: number }) => [bullet.prose, bullet.score]), [[f.bullets[0]!.prose, 1]]);
});

test("the edit pass can only change bullet prose through declared edits", async (t) => {
  const edited = "Tuned PostgreSQL for high-throughput workloads.";
  const scenarios: { name: string; edit: (f: Fixture) => { lines: string[]; edits: unknown[] }; error: RegExp }[] = [
    { name: "undeclared rewrite", error: /no declared edit/, edit: () => ({ lines: [edited], edits: [] }) },
    { name: "added bullet", error: /may not add or remove bullets/, edit: f => ({ lines: [f.bullets[0]!.prose, f.bullets[1]!.prose], edits: [] }) },
    { name: "declared but unapplied", error: /were not applied/, edit: f => ({ lines: [f.bullets[0]!.prose], edits: [{ bulletId: f.bullets[0]!.bulletId, before: f.bullets[0]!.prose, after: edited }] }) },
    { name: "edit with a wrong before", error: /no declared edit/, edit: f => ({ lines: [edited], edits: [{ bulletId: f.bullets[0]!.bulletId, before: "Something else.", after: edited }] }) },
  ];
  for (const scenario of scenarios) {
    const f = fixture(t, (_request, index, g) => {
      if (index === 1) return { result: assembled(g) };
      const change = scenario.edit(g);
      return { result: { structured: structured(g.snapshotId, g.profile.id, g.template.id, change.lines), selectedBullets: assembled(g).selectedBullets, edits: change.edits } };
    });
    const assembly = await f.start();
    assert.equal(assembly.state, "waiting_review", assembly.error);
    const edit = await f.next();
    assert.equal(edit.state, "failed", scenario.name);
    assert.match(edit.error ?? "", scenario.error, scenario.name);
  }
});

test("a spawner restart while the agent runs is waited out, not reported as a failed run", async (t) => {
  const f = fixture(t, (_request, _index, g) => ({ state: "running", result: assembled(g) }));
  let calls = 0;
  f.spawner.onInspect = id => {
    calls++;
    if (calls <= 3) throw new Error("connect ECONNREFUSED 127.0.0.1:7777");
    f.spawner.finish(id);
  };
  const outcome = await f.start();
  assert.equal(outcome.state, "waiting_review", outcome.error);
  assert.deepEqual(f.spawner.stopped, [], "a live agent is never stopped because the host was briefly unreachable");
  assert.equal(count(f, "SELECT count(*) AS n FROM events WHERE kind='run.spawner_unreachable'"), 1);
});

test("a failure while the agent may still be running stops it", async (t) => {
  const f = fixture(t, () => ({ state: "running", write: false }));
  f.spawner.onInspect = () => { throw new Error("host unreachable"); };
  const outcome = await f.start();
  assert.equal(outcome.state, "failed");
  assert.match(outcome.error ?? "", /spawner was unreachable/);
  assert.ok(f.spawner.stopped.includes("sess-1"), "a stop is requested rather than abandoning the agent");
});

test("a hung run is stopped at its deadline instead of waiting forever", async (t) => {
  const f = fixture(t, () => ({ state: "running", write: false }));
  const outcome = await f.start();
  assert.equal(outcome.state, "failed");
  assert.match(outcome.error ?? "", /deadline/);
  assert.deepEqual(f.spawner.stopped, ["sess-1"]);
});

/** A worker that stopped mid-run, and a new lease generation that has recovered its task. */
async function abandonedRun(t: TestContext, behaviour: (f: Fixture) => Behaviour) {
  const f = fixture(t, (_request, _index, g) => behaviour(g));
  const stopping = new AbortController();
  f.spawner.onInspect = () => stopping.abort();
  const outcome = await f.start({ signal: stopping.signal });
  f.spawner.onInspect = undefined;
  assert.equal(outcome.state, "abandoned", outcome.error);
  assert.equal(f.queue.get(outcome.taskId)!.state, "running", "stopping never fails the task or its child");
  assert.deepEqual(f.spawner.stopped, [], "stopping the service never kills the agent");
  const later = Date.now() + 400_000;
  const successor = f.queue.acquireScheduler("next-worker", 300_000, later)!;
  assert.deepEqual(f.queue.recoverExpired(successor, later), [outcome.taskId]);
  assert.equal(f.queue.get(outcome.taskId)!.state, "blocked");
  return { f, outcome, successor };
}

test("recovery reattaches a child that finished while no worker was watching", async (t) => {
  const { f, outcome } = await abandonedRun(t, g => ({ state: "running", result: assembled(g) }));
  assert.equal(await f.runner.reconcile(outcome.taskId), "waiting", "a live child is waited on, never killed or duplicated");
  f.spawner.finish(outcome.sessionId!);
  assert.equal(await f.runner.reconcile(outcome.taskId), "accepted");
  assert.equal(f.queue.get(outcome.taskId)!.state, "waiting_review");
  assert.equal(count(f, "SELECT count(*) AS n FROM attention_items WHERE state='open'"), 1);
  assert.equal(count(f, "SELECT count(*) AS n FROM tasks WHERE kind='resume:edit' AND state='queued'"), 1, "the next stage is queued as usual");
  assert.equal(count(f, "SELECT count(*) AS n FROM events WHERE kind='run.reattached'"), 1);
  assert.equal(f.spawner.created.length, 1, "no second agent was started");
});

test("recovery rediscovers a finished child after a crash before the create response was recorded", async t => {
  const stopping = new AbortController();
  const f = fixture(t, (_request, _index, g) => {
    stopping.abort();
    g.spawner.unreachable = true;
    return { state: "exited", result: assembled(g), responseLost: true };
  });
  const outcome = await f.start({ signal: stopping.signal });
  assert.equal(outcome.state, "abandoned");
  assert.equal(f.store.db.prepare("SELECT spawner_session_id FROM agent_runs WHERE id=?").get(outcome.runId)!.spawner_session_id, null);
  const later = Date.now() + 400_000;
  const successor = f.queue.acquireScheduler("next-worker", 300_000, later)!;
  f.queue.recoverExpired(successor, later);
  f.spawner.unreachable = false;
  assert.equal(await f.runner.reconcile(outcome.taskId),"accepted");
  assert.equal(f.store.db.prepare("SELECT spawner_session_id FROM agent_runs WHERE id=?").get(outcome.runId)!.spawner_session_id,"sess-1");
  assert.equal(f.spawner.created.length,1);
});

test("changing the spawner does not classify the old host's child as dead", async t => {
  const { f, outcome } = await abandonedRun(t, g => ({state:"running",result:assembled(g)}));
  const other = new TailoringRunner({...f.runner.deps,spawnerInstance:"http://another-host:7777"});
  assert.equal(await other.reconcile(outcome.taskId),"unreachable");
  assert.equal(f.queue.get(outcome.taskId)!.state,"blocked");
  assert.equal(f.spawner.created.length,1);
});

test("recovery rechecks ownership after waiting for the spawner", async t => {
  const { f, outcome } = await abandonedRun(t, g => ({ state: "running", result: assembled(g) }));
  f.spawner.finish(outcome.sessionId!);
  let checks = 0;
  await assert.rejects(() => f.runner.reconcile(outcome.taskId, () => { if (++checks === 2) throw new Error("lease lost"); }), /lease lost/);
  assert.equal(f.queue.get(outcome.taskId)!.state, "blocked");
  assert.equal(count(f, "SELECT count(*) AS n FROM resume_versions"), 0);
});

test("recovery retries a dead child from its saved inputs, and fails once attempts are spent", async (t) => {
  const { f, outcome, successor } = await abandonedRun(t, () => ({ state: "running", write: false }));
  f.spawner.forget(outcome.sessionId!);
  assert.equal(await f.runner.reconcile(outcome.taskId), "retried");
  assert.equal(f.store.db.prepare("SELECT state FROM agent_runs WHERE id=?").get(outcome.runId)!.state, "exited");
  const retried = f.queue.claim(successor, 300_000, Date.now() + 400_001)!;
  assert.equal(retried.task.id, outcome.taskId);
  assert.equal(retried.task.attempt, 2);

  // The retry's worker dies too, and its child is gone: attempts are spent, so it fails.
  const later = Date.now() + 800_000;
  const third = f.queue.acquireScheduler("third-worker", 300_000, later)!;
  f.queue.recoverExpired(third, later);
  assert.equal(await f.runner.reconcile(outcome.taskId), "failed");
  assert.equal(f.queue.get(outcome.taskId)!.state, "failed");
});

test("recovery leaves everything alone while the spawner is unreachable", async (t) => {
  const { f, outcome } = await abandonedRun(t, g => ({ state: "running", result: assembled(g) }));
  f.spawner.unreachable = true;
  assert.equal(await f.runner.reconcile(outcome.taskId), "unreachable", "an unavailable host is not a dead child");
  assert.equal(f.queue.get(outcome.taskId)!.state, "blocked");
  assert.equal(f.store.db.prepare("SELECT state FROM agent_runs WHERE id=?").get(outcome.runId)!.state, "running");
});

test("the worker claims only while enabled, runs both stages, and a successor recovers what it abandoned", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-worker-"));
  const store = new SettingsStore(path.join(dir, "jobs.sqlite"));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const services = createServices({ port: 7792, token: "worker-fixture-token", allowedOrigins: [], spawnerToken: "host-token-for-tests" }, store, dir,
    { tailoring: { pollMs: 1, timeoutMs: 60_000, sleep: async () => { await new Promise(resolve => setTimeout(resolve, 1)); } } });
  const { library, postings, queue } = services;
  const { jobId, applicationId } = postings.ingest({ adapterId: "fixture", company: "Acme", title: "Platform Engineer", originalUrl: "https://acme.example/w", descriptionText: "Go", provenance: "browser" });
  const snapshotId = postings.recordSnapshot({ jobId, purpose: "discovery", fetchedUrl: "u", finalUrl: "u", descriptionText: "We need Go.", screenshot: Buffer.from("png"), captureVersion: "browser:1", capture: {}, completeness: "complete" }).snapshotId;
  const profile = library.addProfile({ profileId: "primary", data: { contact: { name: "Ada Lovelace", email: "ada@example.com" }, summary: "Platform engineer.", facts: [], suggestions: [] } });
  const [bullet] = library.addBullets({ profileRevisionId: profile.id, bullets: [{ bulletId: "b-go", prose: "Built Go services.", tags: ["go"] }] });
  const template = library.addTemplate({ templateId: "base", data: { name: "Base", sections: [
    { id: "summary", title: "Summary", type: "facts", factKeys: ["summary"] }, { id: "experience", title: "Experience", type: "bullets", limit: 1 }] } });
  const result = { structured: structured(snapshotId, profile.id, template.id, [bullet!.prose]), selectedBullets: [{ bulletId: "b-go", revisionId: bullet!.id, prose: bullet!.prose, tags: [], matched: [], score: 0 }] };
  let hold = false;
  const spawner = new FakeSpawner(() => ({ state: hold ? "running" : "exited", result }));
  registerSpawnerProvider("worker-fake", () => spawner);
  const settings = (patch: Record<string, unknown>) => { const current = store.current(); store.update(current.revision, { ...current.value, personaDirectory: personasDir, spawner: { ...current.value.spawner, provider: "worker-fake" }, ...patch }); };
  settings({});
  enqueueTailoring(queue, { applicationId, jobSnapshotId: snapshotId, profileRevisionId: profile.id, templateRevisionId: template.id }, store.current().revision);

  const worker = new JobsWorker(services, { owner: "worker-a", discoveryIntervalMs: 3_600_000 });
  await worker.tick(); await worker.idle();
  assert.equal(spawner.created.length, 0, "a disabled service claims nothing");
  settings({ enabled: true, paused: false });
  await worker.tick(); await worker.idle();
  await worker.tick(); await worker.idle();
  assert.equal(spawner.created.length, 2, "assembly, then the edit stage it queued");
  assert.equal(Number(store.db.prepare("SELECT count(*) AS n FROM tasks WHERE state='waiting_review'").get()!["n"]), 2);

  // A third run is abandoned by a stopping worker and reattached by its successor.
  hold = true;
  enqueueTailoring(queue, { applicationId, jobSnapshotId: snapshotId, profileRevisionId: profile.id, templateRevisionId: template.id }, store.current().revision);
  await worker.tick();
  await new Promise(resolve => setTimeout(resolve, 20));
  await worker.stop();
  const abandoned = String(store.db.prepare("SELECT id FROM tasks WHERE kind='resume:assemble' ORDER BY created_at DESC, rowid DESC LIMIT 1").get()!["id"]);
  assert.equal(queue.get(abandoned)!.state, "running");
  assert.deepEqual(spawner.stopped, []);
  spawner.finish("sess-3");
  const successor = new JobsWorker(services, { owner: "worker-b", discoveryIntervalMs: 3_600_000 });
  await successor.tick(); await successor.idle();
  assert.equal(queue.get(abandoned)!.state, "waiting_review", "the finished child's result was accepted without a second spawn");
  assert.equal(spawner.created.filter(request => request.label.includes(":assemble:")).length, 2, "no second assembly agent was spawned");
  await successor.stop();
});

test("tailoring routes report an unconfigured spawner, queue work when configured, and 404 unknown runs", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-runner-api-"));
  const store = new SettingsStore(path.join(dir, "jobs.sqlite"));
  // buildServer's onClose closes the store; only clean the directory here.
  const app = buildServer({ port: 7790, token: "runner-fixture-token", allowedOrigins: [] }, store, dir);
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const headers = { authorization: "Bearer runner-fixture-token" };
  const body = { applicationId: "a", jobSnapshotId: "s", profileRevisionId: "p", templateRevisionId: "t" };
  assert.equal((await app.inject({ url: "/api/tailoring", method: "POST", payload: body })).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/runs/missing" })).statusCode, 401);
  const unconfigured = await app.inject({ url: "/api/tailoring", method: "POST", headers, payload: body });
  assert.equal(unconfigured.statusCode, 409);
  assert.equal(unconfigured.json().error.code, "spawner_unconfigured");
  assert.equal((await app.inject({ url: "/api/runs/missing", headers })).statusCode, 404);
  assert.equal((await app.inject({ url: "/api/tailoring", method: "POST", headers, payload: { applicationId: "a" } })).statusCode, 400);

  // Swapping the spawner provider is a settings change validated against the registry.
  const current = (await app.inject({ url: "/api/settings", headers })).json();
  const bad = structuredClone(current.value); bad.spawner.provider = "nonexistent";
  assert.equal((await app.inject({ url: "/api/settings", method: "PUT", headers, payload: { expectedRevision: current.revision, value: bad } })).statusCode, 400);
  const fake: AgentSpawner = { provider: "test-provider", health: async () => ({ available: true }), list: async () => [], inspect: async () => null };
  registerSpawnerProvider("test-provider", () => fake);
  const good = structuredClone(current.value); good.spawner.provider = "test-provider";
  assert.equal((await app.inject({ url: "/api/settings", method: "PUT", headers, payload: { expectedRevision: current.revision, value: good } })).statusCode, 200);

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-runner-api2-"));
  const store2 = new SettingsStore(path.join(dir2, "jobs.sqlite"));
  const configured = buildServer({ port: 7791, token: "runner-fixture-token", allowedOrigins: [], spawnerToken: "host-token-for-tests" }, store2, dir2);
  t.after(async () => { await configured.close(); fs.rmSync(dir2, { recursive: true, force: true }); });
  const queued = await configured.inject({ url: "/api/tailoring", method: "POST", headers, payload: body });
  assert.equal(queued.statusCode, 200);
  assert.equal(queued.json().state, "queued");
  assert.match(queued.json().dispatch, /enabled/, "a disabled service says the work waits rather than pretending it started");
});

test("a settings change reaches the next tailoring run without a restart", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-runner-settings-"));
  const store = new SettingsStore(path.join(dir, "jobs.sqlite"));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const services = createServices({ port: 7793, token: "runner-fixture-token", allowedOrigins: [], spawnerToken: "host-token-for-tests" }, store, dir);
  const seen: string[] = [];
  registerSpawnerProvider("settings-probe", options => { seen.push(options.baseUrl); return { provider: "settings-probe", health: async () => ({ available: true }), list: async () => [], inspect: async () => null }; });
  const save = (baseUrl: string) => { const current = store.current(); store.update(current.revision, { ...current.value, spawner: { ...current.value.spawner, provider: "settings-probe", baseUrl } }); };
  save("http://127.0.0.1:7777");
  const first = services.tailoring();
  assert.equal(services.tailoring(), first, "built once per settings revision");
  save("http://127.0.0.1:8888");
  assert.notEqual(services.tailoring(), first);
  assert.deepEqual(seen, ["http://127.0.0.1:7777", "http://127.0.0.1:8888"]);
});

test("line diff marks added and removed prose", () => {
  const diff = lineDiff("a\nb\nc", "a\nB\nc");
  assert.deepEqual(diff.filter(line => line.type !== "same").map(line => line.type).sort(), ["add", "remove"]);
});
