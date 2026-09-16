import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { loadPersona, loadSkill, listPersonas, snapshotPersona, composeTaskFile, parseFrontmatter } from "../src/personas.js";
import { AppError } from "../src/errors.js";

const personasDir = new URL("../personas/", import.meta.url).pathname;

function tempPersonas(t: TestContext, files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-personas-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

test("frontmatter parsing handles scalars, inline arrays and one nested mapping", () => {
  const parsed = parseFrontmatter("---\nid: x\nname: \"A name\"\ntools: [a, b]\npermissions:\n  canDo: true\n  canNot: false\n---\nBody here\n");
  assert.equal(parsed.attributes["name"], "A name");
  assert.deepEqual(parsed.attributes["tools"], ["a", "b"]);
  assert.deepEqual(parsed.attributes["permissions"], { canDo: true, canNot: false });
  assert.equal(parsed.body, "Body here");
  assert.throws(() => parseFrontmatter("no frontmatter"), /frontmatter/);
});

test("the placeholder personas load with the configured model and tools", () => {
  const assembler = loadPersona(personasDir, "resume-assembler");
  assert.equal(assembler.model, "openrouter/deepseek/deepseek-v4.1-flash");
  assert.equal(assembler.agent, "pi");
  assert.ok(assembler.tools.includes("finalize_resume"));
  assert.equal(assembler.permissions["canRewriteProse"], false);
  const skill = loadSkill(personasDir, "resume-assembler", "bullet-selection");
  assert.equal(skill.name, "Bullet selection");

  const editor = loadPersona(personasDir, "resume-editor");
  assert.equal(editor.model, assembler.model);
  assert.equal(editor.permissions["canRewriteProse"], true);
  assert.equal(editor.tools.includes("select_bullet"), false, "the edit pass cannot re-select bullets");

  const listed = listPersonas(personasDir);
  assert.deepEqual(listed.personas.map(persona => persona.id), ["resume-assembler", "resume-editor"]);
  assert.deepEqual(listed.errors, []);
});

test("a snapshot composes persona, skills and task into one immutable task file", (t) => {
  const snapshot = snapshotPersona(personasDir, "resume-assembler", "Tailor for Acme platform engineer.");
  assert.match(snapshot.taskFileText, /# Persona: Resume assembler/);
  assert.match(snapshot.taskFileText, /## Skill: Bullet selection/);
  assert.match(snapshot.taskFileText, /Tailor for Acme platform engineer\./);
  assert.match(snapshot.revisionHashes.manifest, /^[a-f0-9]{64}$/);
  assert.match(snapshot.revisionHashes.skills["bullet-selection"]!, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.revisionHashes.composed, snapshot.revisionHashes.composed);
  assert.equal(composeTaskFile(snapshot.persona, snapshot.skills, "Tailor for Acme platform engineer."), snapshot.taskFileText);

  // Changing a persona file changes its revision hash but not an old snapshot's text.
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-personas-copy-"));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  fs.cpSync(path.join(personasDir, "resume-assembler"), path.join(copy, "resume-assembler"), { recursive: true });
  const copyManifest = path.join(copy, "resume-assembler", "manifest.md");
  fs.writeFileSync(copyManifest, fs.readFileSync(copyManifest, "utf8").replace("ASSEMBLY pass", "ASSEMBLY pass v2"));
  const changed = snapshotPersona(copy, "resume-assembler", "Tailor for Acme platform engineer.");
  assert.notEqual(changed.revisionHashes.manifest, snapshot.revisionHashes.manifest);
  assert.match(snapshot.taskFileText, /ASSEMBLY pass/);
  assert.match(changed.taskFileText, /ASSEMBLY pass v2/);
});

test("persona ids are path-contained and a malformed persona blocks only itself", (t) => {
  assert.throws(() => loadPersona(personasDir, "../resume-assembler"), (error: unknown) => error instanceof AppError && error.code === "invalid_persona");
  assert.throws(() => loadPersona(personasDir, "no-such-persona"), (error: unknown) => error instanceof AppError && error.code === "persona_missing");

  const dir = tempPersonas(t, {
    "good/manifest.md": "---\nschemaVersion: 1\nid: good\nname: Good\ndescription: Fine\nagent: pi\nmodel: openrouter/deepseek/deepseek-v4.1-flash\ntools: []\nskills: []\n---\nBody\n",
    "broken/manifest.md": "---\nschemaVersion: 1\nid: broken\nname: Broken\n---\nBody\n",
    "bad-id/manifest.md": "---\nschemaVersion: 1\nid: not-the-directory\nname: X\ndescription: Y\nagent: pi\nmodel: m/n\ntools: []\nskills: []\n---\nBody\n",
  });
  const listed = listPersonas(dir);
  assert.deepEqual(listed.personas.map(persona => persona.id), ["good"]);
  assert.deepEqual(listed.errors.map(entry => entry.id).sort(), ["bad-id", "broken"]);

  const missing = tempPersonas(t, { "needs-skill/manifest.md": "---\nschemaVersion: 1\nid: needs-skill\nname: N\ndescription: D\nagent: pi\nmodel: openrouter/deepseek/deepseek-v4.1-flash\ntools: []\nskills: [absent]\n---\nBody\n" });
  assert.throws(() => snapshotPersona(missing, "needs-skill", "task"), (error: unknown) => error instanceof AppError && error.code === "skill_missing");
});
