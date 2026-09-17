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
import { TailoringRunner, lineDiff } from "../src/runner.js";
import { buildServer } from "../src/server.js";
import { createInvocationAdapter } from "../src/invocation.js";
import { registerSpawnerProvider, type AgentSpawner, type SpawnerCreateRequest, type SpawnerSession } from "../src/adapters/spawner.js";
import type { StructuredResume } from "../src/resume.js";

const personasDir = new URL("../personas/", import.meta.url).pathname;
type Behaviour = { state?: "running" | "exited" | "lost"; exitCode?: number | null; result?: unknown; raw?: string; write?: boolean };
class FakeSpawner implements AgentSpawner {
  readonly provider = "fake";
  readonly created: SpawnerCreateRequest[] = [];
  readonly stopped: string[] = [];
  private readonly sessions = new Map<string, SpawnerSession>();
  constructor(private readonly behaviour: (request: SpawnerCreateRequest, index: number) => Behaviour | Promise<Behaviour>) {}
  async health() { return { available: true }; }
  async list() { return [...this.sessions.values()]; }
  async inspect(id: string) { return this.sessions.get(id) ?? null; }
  async create(request: SpawnerCreateRequest) {
    this.created.push(request);
    const result = await this.behaviour(request, this.created.length);
    const id = `sess-${this.created.length}`;
    const state = result.state ?? "exited";
    if (result.write !== false && (result.result !== undefined || result.raw !== undefined)) {
      fs.writeFileSync(path.join(request.cwd, "result.json"), result.raw ?? JSON.stringify(result.result));
    }
    // A 'lost' session is created but never appears in inspect's inventory.
    const session: SpawnerSession = { id, label: request.label, state: state === "exited" ? "exited" : "running", exitCode: result.exitCode ?? (state === "exited" ? 0 : null) };
    if (state !== "lost") this.sessions.set(id, session);
    return session;
  }
  async stop(id: string) { this.stopped.push(id); }
}

function fixture(t: TestContext, behaviour: (request: SpawnerCreateRequest, index: number) => Behaviour | Promise<Behaviour>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-runner-"));
  const store = new SettingsStore(path.join(dir, "jobs.sqlite"));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const artifacts = new ArtifactStore(store.db, dir);
  const library = new Library(store.db, () => 1_800_000_000_000);
  const postings = new Postings(store.db, artifacts, () => 1_800_000_000_000);
  const { jobId } = postings.ingest({ adapterId: "fixture", company: "Acme", title: "Platform Engineer",
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
  const spawner = new FakeSpawner(behaviour);
  const queue = new TaskQueue(store.db);
  const reviews = new Reviews(store.db);
  const runner = new TailoringRunner({ db: store.db, artifacts, library, renderer: new ResumeRenderer(store.db, artifacts, library),
    queue, reviews, personasDir, spawner, invocation: createInvocationAdapter("pi"), dataDir: dir,
    spawnerProvider: "fake", spawnerInstance: "test", now: () => Date.now(), sleep: async () => { await new Promise(resolve => setTimeout(resolve, 1)); }, pollMs: 1, timeoutMs: 50 });
  const bullets = library.bullets(profile.id);
  return { store, artifacts, library, runner, spawner, profile, template, snapshotId, bullets, dir };
}
const structured = (snapshotId: string, profileId: string, templateId: string, lines: string[]): StructuredResume =>
  ({ jobSnapshotId: snapshotId, profileRevisionId: profileId, templateRevisionId: templateId,
    heading: { name: "Ada Lovelace", contact: ["ada@example.com"] },
    sections: [{ id: "experience", title: "Experience", lines }], missing: [] });

test("a valid assembly run saves a build version, evidence and a pending review", async (t) => {
  const { store, runner, spawner, profile, template, snapshotId, bullets } = fixture(t, request => ({
    result: { structured: structured(snapshotId, profile.id, template.id, [bullets[0]!.prose]),
      selectedBullets: [{ bulletId: bullets[0]!.bulletId, revisionId: bullets[0]!.id, prose: bullets[0]!.prose, tags: bullets[0]!.tags, matched: ["go"], score: 1 }],
      toolCalls: [{ toolId: "find_bullets", request: { tags: ["go"] }, result: [], state: "succeeded" }], messages: [{ role: "assistant", content: "done" }] },
  }));
  const outcome = await runner.runStage({ stage: "assemble", applicationId: "app-1", jobSnapshotId: snapshotId,
    profileRevisionId: profile.id, templateRevisionId: template.id, settingsRevision: 1, personaId: "resume-assembler" });
  assert.equal(outcome.state, "waiting_review", outcome.error);
  assert.ok(outcome.resumeVersionId);
  const version = store.db.prepare("SELECT * FROM resume_versions WHERE id=?").get(outcome.resumeVersionId!)!;
  assert.equal(version["phase"], "build");
  assert.equal(version["agent_run_id"], outcome.runId);
  assert.equal(store.db.prepare("SELECT state FROM tasks WHERE id=?").get(outcome.taskId)!.state, "waiting_review");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM tool_events WHERE run_id=?").get(outcome.runId)!.n, 1);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM run_messages WHERE run_id=?").get(outcome.runId)!.n, 1);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM attention_items WHERE state='open'").get()!.n, 1);
  assert.equal(store.db.prepare("SELECT state FROM agent_runs WHERE id=?").get(outcome.runId)!.state, "exited");
  // The configured model and the task file travel in argv; the fake spawner received them.
  const argv = spawner.created[0]!.extraArgs!;
  assert.equal(argv[argv.indexOf("--model") + 1], "openrouter/deepseek/deepseek-v4.1-flash");
  assert.ok(argv.some(argument => argument.startsWith("@") && argument.endsWith("task.md")));
  assert.match(spawner.created[0]!.label!, /^jobs:app-1:tailor:assemble:/);
});

test("the two-pass workflow saves both versions and diffs the edit against assembly", async (t) => {
  const { store, artifacts, runner, profile, template, snapshotId, bullets } = fixture(t, (request, index) => {
    const bulletsLine = index === 1 ? [bullets[0]!.prose] : ["Architected Go services for Kubernetes platforms."];
    return { result: { structured: structured(snapshotId, profile.id, template.id, bulletsLine),
      selectedBullets: [{ bulletId: bullets[0]!.bulletId, revisionId: bullets[0]!.id, prose: bulletsLine[0]!, tags: bullets[0]!.tags, matched: [], score: 0 }],
      edits: index === 2 ? [{ bulletId: bullets[0]!.bulletId, before: bullets[0]!.prose, after: bulletsLine[0]!, reason: "align terminology" }] : [] } };
  });
  const { assembly, edit } = await runner.runTwoPass({ applicationId: "app-2", jobSnapshotId: snapshotId,
    profileRevisionId: profile.id, templateRevisionId: template.id, settingsRevision: 1 });
  assert.equal(assembly.state, "waiting_review");
  assert.equal(edit!.state, "waiting_review");
  assert.notEqual(assembly.resumeVersionId, edit!.resumeVersionId);
  const edited = store.db.prepare("SELECT * FROM resume_versions WHERE id=?").get(edit!.resumeVersionId!)!;
  assert.equal(edited["phase"], "edit");
  assert.equal(edited["parent_resume_id"], assembly.resumeVersionId);
  assert.equal(edited["agent_run_id"], edit!.runId);
  const edits = JSON.parse(String(edited["edits_json"]));
  assert.equal(edits.edits[0].reason, "align terminology");
  assert.ok(edits.diff.some((line: { type: string }) => line.type === "add"));
  const text = Buffer.from(artifacts.read(String(edited["text_artifact_hash"]))).toString("utf8");
  assert.match(text, /Architected Go services/);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM attention_items WHERE state='open'").get()!.n, 2);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM tasks WHERE state='waiting_review'").get()!.n, 2);
});

test("fake agents expose missing, malformed, unsupported, nonzero and lost failures", async (t) => {
  const cases: { name: string; behaviour: Behaviour; error: string }[] = [
    { name: "missing output", behaviour: { write: false }, error: "without a result file" },
    { name: "malformed output", behaviour: { raw: "not json" }, error: "was not JSON" },
    { name: "changed inputs", behaviour: { result: { structured: structured("other", "other", "other", ["x"]), selectedBullets: [] } }, error: "changed the run's snapshot" },
    { name: "nonzero exit", behaviour: { exitCode: 3, write: false }, error: "exited with code 3" },
    { name: "lost session", behaviour: { state: "lost", write: false }, error: "disappeared" },
  ];
  for (const scenario of cases) {
    const { runner, profile, template, snapshotId } = fixture(t, () => scenario.behaviour);
    const outcome = await runner.runStage({ stage: "assemble", applicationId: "app-x", jobSnapshotId: snapshotId,
      profileRevisionId: profile.id, templateRevisionId: template.id, settingsRevision: 1, personaId: "resume-assembler" });
    assert.equal(outcome.state, "failed", scenario.name);
    assert.match(outcome.error ?? "", new RegExp(scenario.error), scenario.name);
  }
});

test("an unsupported bullet revision is rejected as an invented fact", async (t) => {
  const { runner, profile, template, snapshotId, bullets } = fixture(t, () => ({
    result: { structured: structured(snapshotId, profile.id, template.id, ["Invented achievement."]),
      selectedBullets: [{ bulletId: "invented", revisionId: "not-a-real-revision", prose: "Invented achievement.", tags: [], matched: [], score: 0 }] },
  }));
  const outcome = await runner.runStage({ stage: "assemble", applicationId: "app-3", jobSnapshotId: snapshotId,
    profileRevisionId: profile.id, templateRevisionId: template.id, settingsRevision: 1, personaId: "resume-assembler" });
  assert.equal(outcome.state, "failed");
  assert.match(outcome.error ?? "", /not part of this profile revision/);
  assert.equal(bullets.length, 2);
});

test("a hung run is stopped at its deadline instead of waiting forever", async (t) => {
  const { runner, spawner, profile, template, snapshotId } = fixture(t, () => ({ state: "running", write: false }));
  const outcome = await runner.runStage({ stage: "assemble", applicationId: "app-4", jobSnapshotId: snapshotId,
    profileRevisionId: profile.id, templateRevisionId: template.id, settingsRevision: 1, personaId: "resume-assembler" });
  assert.equal(outcome.state, "failed");
  assert.match(outcome.error ?? "", /deadline|disappeared/);
});

test("tailoring routes report an unconfigured spawner and unknown runs", async (t) => {
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
});

test("line diff marks added and removed prose", () => {
  const diff = lineDiff("a\nb\nc", "a\nB\nc");
  assert.deepEqual(diff.filter(line => line.type !== "same").map(line => line.type).sort(), ["add", "remove"]);
});
