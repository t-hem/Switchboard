import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { SettingsStore } from "../src/store.js";
import { ArtifactStore } from "../src/artifacts.js";
import { Library } from "../src/library.js";
import { ResumeRenderer, type SelectedBullet, type StructuredResume } from "../src/resume.js";
import { Postings } from "../src/postings.js";
import { DraftState, runTool, toolIds } from "../src/tools.js";
import { createInvocationAdapter, invocationAdapterIds } from "../src/invocation.js";
import { AppError } from "../src/errors.js";

const profileData = {
  contact: { name: "Ada Lovelace", email: "ada@example.com", location: "Remote" },
  summary: "Platform engineer focused on reliable distributed systems.",
  facts: [{ key: "skill", value: "Kubernetes, Go, PostgreSQL", verified: true }],
  suggestions: [{ key: "skill", value: "Rust", verified: false }],
};
const templateData = { name: "Base engineering", sections: [
  { id: "summary", title: "Summary", type: "facts", factKeys: ["summary"] },
  { id: "skills", title: "Skills", type: "tags" },
  { id: "experience", title: "Experience", type: "bullets", limit: 2 },
] };
const bullets = [
  { bulletId: "b-go", prose: "Built Go services handling 10k requests per second.", tags: ["go", "kubernetes"] },
  { bulletId: "b-support", prose: "Resolved customer escalations for enterprise accounts.", tags: ["support"] },
  { bulletId: "b-db", prose: "Tuned PostgreSQL and Kafka pipelines.", tags: ["postgresql", "kafka"] },
];

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-tools-"));
  const store = new SettingsStore(path.join(dir, "jobs.sqlite"));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const artifacts = new ArtifactStore(store.db, dir);
  const library = new Library(store.db, () => 1_800_000_000_000);
  const postings = new Postings(store.db, artifacts, () => 1_800_000_000_000);
  const { jobId } = postings.ingest({ adapterId: "fixture", company: "Acme", title: "Platform Engineer",
    originalUrl: "https://acme.example/1", descriptionText: "We need Go, Kubernetes and PostgreSQL experience.", provenance: "browser" });
  const snapshotId = postings.recordSnapshot({ jobId, purpose: "discovery", fetchedUrl: "u", finalUrl: "u",
    descriptionText: "We need Go, Kubernetes and PostgreSQL experience.", screenshot: Buffer.from("png"),
    captureVersion: "browser:1", capture: {}, completeness: "complete" }).snapshotId;
  const profile = library.addProfile({ profileId: "primary", data: profileData });
  library.addBullets({ profileRevisionId: profile.id, bullets });
  const template = library.addTemplate({ templateId: "base", data: templateData });
  const renderer = new ResumeRenderer(store.db, artifacts, library, () => 1_800_000_000_000);
  return { store, library, renderer, snapshotId, profile, template, dir, artifacts };
}

test("scoped tools only allow choosing among validated revisions and bounded layout", (t) => {
  const { library, snapshotId, profile, template } = fixture(t);
  const draft = new DraftState(library, snapshotId, profile.id, template.id);
  assert.deepEqual(toolIds(), ["finalize_resume", "find_bullets", "list_templates", "order_sections", "render_preview", "select_bullet"]);

  const templates = runTool(draft, "list_templates") as { templateId: string }[];
  assert.equal(templates.length, 1);
  assert.equal(templates[0]!.templateId, "base");
  const found = runTool(draft, "find_bullets", { tags: ["go"] }) as { bulletId: string }[];
  assert.deepEqual(found.map(entry => entry.bulletId), ["b-go"]);

  runTool(draft, "select_bullet", { sectionId: "experience", bulletId: "b-go" });
  runTool(draft, "select_bullet", { sectionId: "experience", bulletId: "b-db" });
  assert.throws(() => runTool(draft, "select_bullet", { sectionId: "experience", bulletId: "b-go" }), (error: unknown) => error instanceof AppError && error.code === "duplicate_bullet");
  assert.throws(() => runTool(draft, "select_bullet", { sectionId: "experience", bulletId: "b-support" }), (error: unknown) => error instanceof AppError && error.code === "slot_limit");
  assert.throws(() => runTool(draft, "select_bullet", { sectionId: "summary", bulletId: "b-go" }), (error: unknown) => error instanceof AppError && error.code === "unknown_section");
  assert.throws(() => runTool(draft, "select_bullet", { sectionId: "experience", bulletId: "invented" }), (error: unknown) => error instanceof AppError && error.code === "unknown_bullet");
  assert.throws(() => runTool(draft, "order_sections", { order: ["summary"] }), (error: unknown) => error instanceof AppError && error.code === "invalid_order");
  assert.throws(() => runTool(draft, "no_such_tool"), (error: unknown) => error instanceof AppError && error.code === "unknown_tool");

  runTool(draft, "order_sections", { order: ["experience", "skills", "summary"] });
  const preview = runTool(draft, "render_preview") as { text: string; selections: { sectionId: string; bullets: string[] }[] };
  assert.match(preview.text, /Built Go services/);
  assert.deepEqual(preview.selections.find(entry => entry.sectionId === "experience")!.bullets, ["b-go", "b-db"]);

  const finalized = runTool(draft, "finalize_resume") as { structured: { sections: { id: string }[] }; selectedBullets: { bulletId: string }[]; text: string };
  assert.deepEqual(finalized.structured.sections.map(section => section.id), ["experience", "skills", "summary"]);
  assert.deepEqual(finalized.selectedBullets.map(entry => entry.bulletId), ["b-go", "b-db"]);
  assert.doesNotMatch(finalized.text, /Rust/);
});

test("a finalized tool result persists as an explicit-selection render version", (t) => {
  const { library, renderer, snapshotId, profile, template } = fixture(t);
  const draft = new DraftState(library, snapshotId, profile.id, template.id);
  runTool(draft, "select_bullet", { sectionId: "experience", bulletId: "b-db" });
  const finalized = runTool(draft, "finalize_resume") as { structured: StructuredResume; selectedBullets: SelectedBullet[]; text: string };
  const persisted = renderer.persist({ jobSnapshotId: snapshotId, profileId: profile.id, templateId: template.id,
    structured: finalized.structured, selectedBullets: finalized.selectedBullets, text: finalized.text });
  assert.equal(persisted.created, true);
  assert.match(persisted.text, /Tuned PostgreSQL/);
  assert.doesNotMatch(persisted.text, /Built Go services/, "only the model-selected bullets are rendered");
  assert.deepEqual(renderer.get(persisted.resumeVersionId)!.selectedBullets.map(entry => entry.bulletId), ["b-db"]);
});

test("the invocation adapter selects the configured model and passes the task file", () => {
  const adapter = createInvocationAdapter("pi");
  assert.deepEqual(invocationAdapterIds(), ["pi"]);
  assert.equal(adapter.capabilities.nonInteractive, true);
  assert.equal(adapter.capabilities.toolAllowlist, true);
  const invocation = adapter.build({ taskFilePath: "/tmp/run/task.md", resultPath: "/tmp/run/result.json",
    model: "openrouter/deepseek/deepseek-v4.1-flash", tools: ["finalize_resume", "render_preview"] });
  assert.equal(invocation.argv[invocation.argv.indexOf("--model") + 1], "openrouter/deepseek/deepseek-v4.1-flash");
  assert.ok(invocation.argv.includes("--mode") && invocation.argv.includes("json"));
  assert.ok(invocation.argv.includes("@/tmp/run/task.md"));
  assert.equal(invocation.argv[invocation.argv.indexOf("--tools") + 1], "finalize_resume,render_preview");
  assert.equal(invocation.resultPath, "/tmp/run/result.json");
  assert.throws(() => adapter.build({ taskFilePath: "/tmp/t.md", resultPath: "/tmp/r.json", model: "deepseek-v4.1-flash", tools: [] }), (error: unknown) => error instanceof AppError && error.code === "invalid_model");
  assert.throws(() => createInvocationAdapter("nope"), (error: unknown) => error instanceof AppError && error.code === "unknown_invocation_adapter");

  assert.deepEqual(adapter.parse('{"ok":true}'), { ok: true });
  assert.deepEqual(adapter.parse('starting…\n{"structured":{"a":1}}\n'), { structured: { a: 1 } });
  assert.throws(() => adapter.parse("   "), /no output/);
  assert.throws(() => adapter.parse("only prose"), /no JSON object/);
});
