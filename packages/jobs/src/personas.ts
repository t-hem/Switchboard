import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { AppError } from "./errors.js";

/**
 * Shared, machine-local persona convention (`~/.switchboard/personas/<id>/`). Markdown
 * frontmatter plus a prompt body, following the OpenWorker reference. Jobs reads this
 * directory; the host daemon never does. One malformed persona fails only its own runs.
 */
export const PERSONA_SCHEMA_VERSION = 1;
export const DEFAULT_PERSONA_DIRECTORY = path.join(process.env["HOME"] ?? ".", ".switchboard", "personas");
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type PersonaPermissions = Record<string, boolean>;
export type Persona = {
  id: string; schemaVersion: number; name: string; description: string;
  agent: string; model: string; tools: string[]; skills: string[];
  permissions: PersonaPermissions; body: string; directory: string;
};
export type Skill = { id: string; name: string; description: string; body: string };

export type Frontmatter = { attributes: Record<string, unknown>; body: string };

/** Deliberately small YAML subset: scalars, inline arrays and one level of nesting. */
export function parseFrontmatter(text: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw new AppError("invalid_persona", "Manifest must start with a --- frontmatter block");
  const attributes: Record<string, unknown> = {};
  let nestedKey: string | null = null;
  for (const rawLine of match[1]!.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
    const nested = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(rawLine);
    if (nested && nestedKey) {
      (attributes[nestedKey] as Record<string, unknown>)[nested[1]!] = scalar(nested[2]!);
      continue;
    }
    const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(rawLine);
    if (!top) throw new AppError("invalid_persona", `Unreadable frontmatter line: ${rawLine.trim()}`);
    const [, key, value] = top as unknown as [string, string, string];
    if (value.trim() === "") { attributes[key] = {}; nestedKey = key; }
    else { attributes[key] = scalar(value); nestedKey = null; }
  }
  return { attributes, body: match[2]!.trim() };
}

function scalar(value: string): unknown {
  const trimmed = value.trim().replace(/\s+#.*$/, "");
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(",").map(entry => unquote(entry.trim())).filter(entry => entry.length > 0);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  return unquote(trimmed);
}
const unquote = (value: string): string => value.replace(/^["']|["']$/g, "");

function readIfInside(root: string, ...parts: string[]): string | null {
  const file = path.resolve(root, ...parts);
  const prefix = path.resolve(root) + path.sep;
  if (!file.startsWith(prefix)) return null; // path containment: never escape the persona root
  return fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file, "utf8") : null;
}

function validatePersona(directory: string, id: string, frontmatter: Frontmatter): Persona {
  const attributes = frontmatter.attributes;
  const stringList = (value: unknown, field: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some(entry => typeof entry !== "string" || !entry.trim())) {
      throw new AppError("invalid_persona", `${id}: ${field} must be a list of names`);
    }
    return value.map(entry => String(entry).trim());
  };
  const required = (field: string): string => {
    const value = attributes[field];
    if (typeof value !== "string" || !value.trim()) throw new AppError("invalid_persona", `${id}: ${field} is required`);
    return value.trim();
  };
  if (attributes["schemaVersion"] !== PERSONA_SCHEMA_VERSION) throw new AppError("invalid_persona", `${id}: unsupported schemaVersion`);
  const declaredId = required("id");
  if (declaredId !== id) throw new AppError("invalid_persona", `${id}: frontmatter id must match its directory`);
  const permissions: PersonaPermissions = {};
  if (attributes["permissions"] !== undefined) {
    if (!attributes["permissions"] || typeof attributes["permissions"] !== "object" || Array.isArray(attributes["permissions"])) {
      throw new AppError("invalid_persona", `${id}: permissions must be a mapping of booleans`);
    }
    for (const [key, value] of Object.entries(attributes["permissions"] as Record<string, unknown>)) {
      if (typeof value !== "boolean") throw new AppError("invalid_persona", `${id}: permission ${key} must be true or false`);
      permissions[key] = value;
    }
  }
  const skills = stringList(attributes["skills"], "skills");
  for (const skill of skills) if (!ID_PATTERN.test(skill)) throw new AppError("invalid_persona", `${id}: skill name ${skill} is not a safe identifier`);
  if (!frontmatter.body) throw new AppError("invalid_persona", `${id}: a system-prompt body is required`);
  return {
    id, schemaVersion: PERSONA_SCHEMA_VERSION, name: required("name"), description: required("description"),
    agent: required("agent"), model: required("model"), tools: stringList(attributes["tools"], "tools"),
    skills, permissions, body: frontmatter.body, directory,
  };
}

export function loadPersona(directory: string, id: string): Persona {
  if (!ID_PATTERN.test(id)) throw new AppError("invalid_persona", `Unsafe persona id ${id}`);
  const text = readIfInside(directory, id, "manifest.md");
  if (text === null) throw new AppError("persona_missing", `No persona ${id} in ${directory}`, 404);
  return validatePersona(directory, id, parseFrontmatter(text));
}

export function loadSkill(directory: string, personaId: string, name: string): Skill {
  const text = readIfInside(directory, personaId, "skills", name, "SKILL.md");
  if (text === null) throw new AppError("skill_missing", `Persona ${personaId} references missing skill ${name}`, 404);
  const frontmatter = parseFrontmatter(text);
  const attributes = frontmatter.attributes;
  const id = typeof attributes["id"] === "string" ? attributes["id"] : name;
  if (id !== name) throw new AppError("invalid_skill", `${personaId}/${name}: skill id must match its directory`);
  if (typeof attributes["name"] !== "string" || !String(attributes["name"]).trim()) throw new AppError("invalid_skill", `${personaId}/${name}: name is required`);
  if (!frontmatter.body) throw new AppError("invalid_skill", `${personaId}/${name}: a procedure body is required`);
  return { id, name: String(attributes["name"]).trim(), description: typeof attributes["description"] === "string" ? String(attributes["description"]) : "", body: frontmatter.body };
}

/** Directory listing isolates failures: a bad persona never takes the list down with it. */
export function listPersonas(directory: string): { personas: Persona[]; errors: { id: string; message: string }[] } {
  if (!fs.existsSync(directory)) return { personas: [], errors: [] };
  const personas: Persona[] = [], errors: { id: string; message: string }[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
    try { personas.push(loadPersona(directory, entry.name)); }
    catch (error) { errors.push({ id: entry.name, message: error instanceof Error ? error.message : String(error) }); }
  }
  return { personas: personas.sort((a, b) => a.id.localeCompare(b.id)), errors };
}

const digest = (value: string): string => createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");

export type PersonaSnapshot = {
  persona: Persona; skills: Skill[];
  revisionHashes: { manifest: string; skills: Record<string, string>; composed: string };
  taskFileText: string;
};

/** Historical evidence: the DB snapshot, not the live files, reconstructs an old run. */
export function snapshotPersona(directory: string, id: string, task: string): PersonaSnapshot {
  const persona = loadPersona(directory, id);
  const skills = persona.skills.map(name => loadSkill(directory, persona.id, name));
  const manifestText = readIfInside(directory, persona.id, "manifest.md") ?? "";
  const skillHashes: Record<string, string> = {};
  for (const skill of skills) skillHashes[skill.id] = digest(readIfInside(directory, persona.id, "skills", skill.id, "SKILL.md") ?? "");
  const taskFileText = composeTaskFile(persona, skills, task);
  return {
    persona, skills,
    revisionHashes: { manifest: digest(manifestText), skills: skillHashes, composed: digest(taskFileText) },
    taskFileText,
  };
}

/** One immutable task file: persona body + selected skill bodies + the stage's task. */
export function composeTaskFile(persona: Persona, skills: Skill[], task: string): string {
  const parts = [
    `# Persona: ${persona.name} (${persona.id})`,
    persona.body,
  ];
  for (const skill of skills) parts.push(`\n## Skill: ${skill.name} (${skill.id})\n\n${skill.body}`);
  parts.push(`\n## Task\n\n${task}`);
  return parts.join("\n").trim() + "\n";
}
