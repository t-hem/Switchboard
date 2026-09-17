import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { SettingsStore } from "../src/store.js";
import { ArtifactStore } from "../src/artifacts.js";
import { Library } from "../src/library.js";
import { ResumeRenderer, renderText, selectBullets } from "../src/resume.js";
import { Postings } from "../src/postings.js";
import { AppError } from "../src/errors.js";

const profileData = {
  contact: { name: "Ada Lovelace", email: "ada@example.com", location: "Remote", links: ["https://example.com/ada"] },
  summary: "Platform engineer focused on reliable distributed systems.",
  facts: [
    { key: "skill", value: "Kubernetes, Go, PostgreSQL", verified: true },
    { key: "certification", value: "CKA (2024)", verified: true },
  ],
  suggestions: [{ key: "skill", value: "Rust", verified: false }],
};
const templateData = {
  name: "Base engineering",
  sections: [
    { id: "summary", title: "Summary", type: "facts", factKeys: ["summary"] },
    { id: "skills", title: "Skills", type: "tags" },
    { id: "experience", title: "Experience", type: "bullets", limit: 2 },
    { id: "education", title: "Education", type: "facts", factKeys: ["education"] },
  ],
};
const bullets = [
  { bulletId: "b-go", prose: "Built Go services handling 10k requests per second.", tags: ["go", "kubernetes"] },
  { bulletId: "b-support", prose: "Resolved customer escalations for enterprise accounts.", tags: ["support"] },
  { bulletId: "b-db", prose: "Tuned PostgreSQL and Kafka pipelines.", tags: ["postgresql", "kafka"] },
];

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-library-"));
  const store = new SettingsStore(path.join(dir, "jobs.sqlite"));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const artifacts = new ArtifactStore(store.db, dir);
  const library = new Library(store.db, () => 1_800_000_000_000);
  const renderer = new ResumeRenderer(store.db, artifacts, library, () => 1_800_000_000_000);
  const postings = new Postings(store.db, artifacts, () => 1_800_000_000_000);
  const { jobId } = postings.ingest({ adapterId: "fixture", company: "Acme", title: "Platform Engineer",
    originalUrl: "https://acme.example/1", descriptionText: "We need Go, Kubernetes and PostgreSQL experience. Kafka is a plus.", provenance: "browser" });
  const snapshot = postings.recordSnapshot({ jobId, purpose: "discovery", fetchedUrl: "u", finalUrl: "u",
    descriptionText: "We need Go, Kubernetes and PostgreSQL experience. Kafka is a plus.", screenshot: Buffer.from("png"),
    captureVersion: "browser:1", capture: { method: "browser" }, completeness: "complete" });
  return { dir, store, artifacts, library, renderer, jobId, snapshotId: snapshot.snapshotId };
}

test("library versions facts, bullets and templates and rejects invalid material", (t) => {
  const { library, store } = fixture(t);
  assert.throws(() => library.addProfile({ profileId: "p", data: { contact: {} } }), (error: unknown) => error instanceof AppError && error.code === "invalid_profile");
  assert.throws(() => library.addTemplate({ templateId: "t", data: { name: "x", sections: [{ id: "a", title: "A", type: "bullets", limit: 0 }] } }), /limit/);
  assert.throws(() => library.addTemplate({ templateId: "t", data: { name: "x", sections: [{ id: "a", title: "A", type: "tags" }, { id: "a", title: "B", type: "tags" }] } }), /Duplicate section/);

  const profile = library.addProfile({ profileId: "primary", data: profileData });
  assert.equal(profile.revision, 1);
  const first = library.addBullets({ profileRevisionId: profile.id, bullets });
  assert.equal(first.length, 3);
  assert.throws(() => library.addBullets({ profileRevisionId: profile.id, bullets: [{ bulletId: "b-go", prose: "one" }, { bulletId: "b-go", prose: "two" }] }), /Duplicate bulletId/);
  // Re-submitting an existing bullet id is an edit: a new immutable revision, never an overwrite.
  const edited = library.addBullets({ profileRevisionId: profile.id, bullets: [{ bulletId: "b-go", prose: "Built Go services, now with Kafka.", tags: ["go"] }] });
  assert.equal(edited[0]!.revision, 2);
  assert.equal(library.bullets(profile.id).find(bullet => bullet.bulletId === "b-go")!.prose, "Built Go services, now with Kafka.");
  const second = library.addProfile({ profileId: "primary", data: profileData });
  assert.equal(second.revision, 2);
  assert.equal(library.profiles().length, 1, "latest revision per profile");
  assert.equal(library.bullets(profile.id).length, 3);
  // Immutable revisions: history cannot be rewritten.
  assert.throws(() => store.db.prepare("UPDATE bullet_revisions SET prose='tampered'").run(), /immutable/);
});

test("a new profile revision keeps the current bullets unless told to start empty", (t) => {
  const { library } = fixture(t);
  const first = library.addProfile({ profileId: "primary", data: profileData });
  library.addBullets({ profileRevisionId: first.id, bullets });
  library.addBullets({ profileRevisionId: first.id, bullets: [{ bulletId: "b-go", prose: "Built Go services, now with Kafka.", tags: ["go"] }] });
  const corrected = library.addProfile({ profileId: "primary", data: { ...profileData, contact: { ...profileData.contact, email: "new@example.com" } } });
  const carried = library.bullets(corrected.id);
  assert.equal(carried.length, 3, "correcting a contact detail must not empty the bullet library");
  assert.equal(carried.find(bullet => bullet.bulletId === "b-go")!.prose, "Built Go services, now with Kafka.", "the current revision is carried");
  assert.ok(carried.every(bullet => bullet.profileRevisionId === corrected.id));
  assert.equal(library.bullets(first.id).length, 3, "the earlier revision's set is unchanged");

  const fresh = library.addProfile({ profileId: "primary", data: profileData, carryBullets: false });
  assert.equal(library.bullets(fresh.id).length, 0);
});

test("a render produces structured source and a text artifact with no invented content", (t) => {
  const { library, renderer, artifacts, snapshotId, jobId } = fixture(t);
  const profile = library.addProfile({ profileId: "primary", data: profileData });
  library.addBullets({ profileRevisionId: profile.id, bullets });
  const template = library.addTemplate({ templateId: "base", data: templateData });

  const rendered = renderer.render({ jobSnapshotId: snapshotId, profileRevisionId: profile.id, templateRevisionId: template.id });
  assert.equal(rendered.created, true);
  assert.equal(rendered.structured.heading.name, "Ada Lovelace");
  assert.deepEqual(rendered.structured.heading.contact, ["ada@example.com", "Remote", "https://example.com/ada"]);
  const experience = rendered.structured.sections.find(section => section.id === "experience")!;
  assert.equal(experience.lines.length, 2);
  assert.match(experience.lines[0]!, /Go|PostgreSQL|Kafka/, "job-relevant bullets rank first");
  assert.ok(rendered.structured.missing.some(entry => /Education/.test(entry)), "omissions are visible");
  assert.equal(rendered.structured.sections.find(section => section.id === "skills")!.lines.includes("Rust"), false, "suggestions are never rendered as facts");

  const text = Buffer.from(artifacts.read(rendered.textArtifactHash)).toString("utf8");
  assert.match(text, /Ada Lovelace/);
  assert.match(text, /EXPERIENCE/);
  assert.match(text, /Omissions: Education: education/);
  assert.equal(text, rendered.text);
  assert.equal(renderText(rendered.structured), text);

  const again = renderer.render({ jobSnapshotId: snapshotId, profileRevisionId: profile.id, templateRevisionId: template.id });
  assert.equal(again.created, false);
  assert.equal(again.resumeVersionId, rendered.resumeVersionId);

  // Editing bullets creates new revisions and leaves the earlier resume untouched.
  const revised = library.addProfile({ profileId: "primary", data: { ...profileData, facts: [...profileData.facts, { key: "education", value: "BSc Mathematics", verified: true }] } });
  library.addBullets({ profileRevisionId: revised.id, bullets: [
    { bulletId: "b-go", prose: "Led Go platform migrations for Kubernetes clusters.", tags: ["go", "kubernetes"] },
    { bulletId: "b-db", prose: "Tuned PostgreSQL and Kafka pipelines.", tags: ["postgresql", "kafka"] },
  ] });
  const edited = renderer.render({ jobSnapshotId: snapshotId, profileRevisionId: revised.id, templateRevisionId: template.id });
  assert.notEqual(edited.resumeVersionId, rendered.resumeVersionId);
  assert.match(edited.text, /BSc Mathematics/);
  assert.doesNotMatch(edited.text, /Omissions:/);
  assert.match(renderer.get(rendered.resumeVersionId)!.text, /Built Go services/, "the earlier version still reads the same");
  assert.equal(renderer.get(edited.resumeVersionId)!.structured.profileRevisionId, revised.id);
  assert.equal(rendered.structured.profileRevisionId, profile.id);
  assert.equal(rendered.structured.jobSnapshotId, snapshotId);
  assert.equal(jobId.length > 0, true);
});

test("bullet selection is deterministic and explainable", () => {
  const revisions = bullets.map((bullet, index) => ({ id: `r${index}`, bulletId: bullet.bulletId, revision: 1, profileRevisionId: "p",
    prose: bullet.prose, tags: bullet.tags, filters: {}, evidence: {}, createdAt: "" }));
  const first = selectBullets(revisions, { title: "Platform Engineer", descriptionText: "Go and PostgreSQL" }, 2);
  const second = selectBullets(revisions, { title: "Platform Engineer", descriptionText: "Go and PostgreSQL" }, 2);
  assert.deepEqual(first.map(entry => entry.bulletId), second.map(entry => entry.bulletId));
  assert.ok(first[0]!.matched.length > 0);
  assert.equal(first.length, 2);
  const asListed = selectBullets(revisions, { title: "", descriptionText: "" }, 2, "as-listed");
  assert.deepEqual(asListed.map(entry => entry.bulletId), ["b-go", "b-support"]);
});

test("library export/import round-trips into a fresh database without rewriting history", (t) => {
  const { library, store } = fixture(t);
  const profile = library.addProfile({ profileId: "primary", data: profileData });
  library.addBullets({ profileRevisionId: profile.id, bullets });
  library.addBullets({ profileRevisionId: profile.id, bullets: [{ bulletId: "b-go", prose: "Built Go services, now with Kafka.", tags: ["go"] }] });
  library.addTemplate({ templateId: "base", data: templateData });
  const exported = library.exportAll();
  assert.equal(exported.profiles.length, 1);
  assert.equal(exported.bullets.length, 3);
  assert.equal(exported.templates.length, 1);

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-library2-"));
  const store2 = new SettingsStore(path.join(dir2, "jobs.sqlite"));
  t.after(() => { store2.close(); fs.rmSync(dir2, { recursive: true, force: true }); });
  const library2 = new Library(store2.db, () => 1_800_000_000_000);
  const imported = library2.importAll(exported);
  assert.deepEqual(imported, { profiles: 1, bullets: 3, templates: 1 });
  assert.equal(library2.profiles()[0]!.data.contact.name, "Ada Lovelace");
  assert.equal(library2.bullets(library2.profiles()[0]!.id).length, 3);
  assert.equal(library2.bullets(library2.profiles()[0]!.id).find(bullet => bullet.bulletId === "b-go")!.prose, "Built Go services, now with Kafka.");
  // An older export listing every revision imports only the highest revision of each bullet.
  const legacy = { ...exported, profiles: [{ ...exported.profiles[0]!, profileId: "legacy" }],
    bullets: [...exported.bullets, { ...exported.bullets.find(bullet => bullet.bulletId === "b-go")!, revision: 1, prose: "Old prose" }] };
  assert.deepEqual(library2.importAll(legacy), { profiles: 1, bullets: 3, templates: 1 });
  assert.throws(() => library2.importAll({ schemaVersion: 99 }), /Unsupported library export version/);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM profile_revisions").get()!.n, 1);
});
