import { AppError } from "./errors.js";
import type { BulletRevision, ProfileRevision, TemplateRevision } from "./library.js";
import { buildStructured, rankBullets, type ResumeSection, type SelectedBullet, type StructuredResume } from "./resume.js";

export type AgentEdit = { bulletId: string; before: string; after: string; reason?: string };
export type AgentResult = {
  structured: StructuredResume; selectedBullets: SelectedBullet[];
  toolCalls?: { toolId: string; request?: unknown; result?: unknown; state?: string }[];
  messages?: { role: string; content: unknown }[];
  edits?: AgentEdit[];
  model?: string; provider?: string;
};
export type AgentResultContext = {
  stage: "assemble" | "edit";
  jobSnapshotId: string; job: { title: string; descriptionText: string };
  profile: ProfileRevision; template: TemplateRevision; bullets: BulletRevision[];
  /** The assembled resume an edit pass works on; required for `edit`. */
  parent?: { structured: StructuredResume; selectedBullets: SelectedBullet[] };
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const invalid = (message: string): AppError => new AppError("invalid_agent_output", message);
const unsupported = (message: string): AppError => new AppError("unsupported_fact", message);

/**
 * The model's result is a claim, not content. Nothing it writes reaches the resume unless it
 * can be derived from the run's own inputs: every heading, fact and skill line must be what
 * the profile renders, and every bullet line must be the stored prose of a selected revision
 * of this profile. The edit pass may change bullet prose only through a declared edit whose
 * `before` is the assembled line it replaces; it cannot add, drop, move or reselect bullets.
 * The returned result is rebuilt from stored data, so persisted evidence never carries the
 * model's own copy of a fact.
 */
export function validateAgentResult(value: unknown, context: AgentResultContext): AgentResult {
  if (!isRecord(value)) throw invalid("Agent result must be a JSON object");
  const structured = value["structured"];
  if (!isRecord(structured)) throw invalid("Agent result needs a structured resume");
  if (String(structured["jobSnapshotId"]) !== context.jobSnapshotId || String(structured["profileRevisionId"]) !== context.profile.id ||
      String(structured["templateRevisionId"]) !== context.template.id) {
    throw invalid("Agent changed the run's snapshot, profile or template revision");
  }
  if (!isRecord(structured["heading"]) || !String((structured["heading"] as Record<string, unknown>)["name"] ?? "").trim()) {
    throw invalid("Agent result has no candidate name");
  }
  const rawSections = structured["sections"];
  if (!Array.isArray(rawSections) || !rawSections.every(section => isRecord(section) && typeof section["id"] === "string" &&
      Array.isArray(section["lines"]) && (section["lines"] as unknown[]).every(line => typeof line === "string"))) {
    throw invalid("Agent result sections are malformed");
  }
  const sections = rawSections as { id: string; lines: string[] }[];
  const templateIds = context.template.data.sections.map(section => section.id);
  if (sections.length !== templateIds.length || new Set(sections.map(section => section.id)).size !== sections.length ||
      sections.some(section => !templateIds.includes(section.id))) {
    throw invalid("Agent result must list every template section exactly once");
  }
  const byId = new Map(sections.map(section => [section.id, section]));

  // Selected bullets must be revisions of this profile; the model's copy of their prose is ignored.
  if (!Array.isArray(value["selectedBullets"])) throw invalid("Agent result needs selectedBullets");
  const pool = new Map(context.bullets.map(bullet => [bullet.id, bullet]));
  const selected: BulletRevision[] = [];
  for (const entry of value["selectedBullets"]) {
    if (!isRecord(entry) || typeof entry["revisionId"] !== "string" || typeof entry["bulletId"] !== "string") throw invalid("Agent selectedBullets are malformed");
    const revision = pool.get(entry["revisionId"]);
    if (!revision) throw unsupported(`Bullet revision ${entry["revisionId"]} is not part of this profile revision`);
    if (selected.includes(revision)) throw invalid(`Bullet revision ${revision.id} is selected twice`);
    selected.push(revision);
  }

  const bulletSections = context.template.data.sections.filter(section => section.type === "bullets");
  const placement = new Map<string, BulletRevision[]>();
  const lines = new Map<string, string[]>();
  let edits: AgentEdit[] = [];
  if (context.stage === "assemble") {
    const unplaced = new Set(selected);
    for (const section of bulletSections) {
      const chosen: BulletRevision[] = [];
      for (const line of byId.get(section.id)!.lines) {
        const revision = [...unplaced].find(candidate => candidate.prose === line);
        if (!revision) throw unsupported(`"${line.slice(0, 80)}" in ${section.id} is not the stored prose of a selected bullet`);
        unplaced.delete(revision);
        chosen.push(revision);
      }
      if (chosen.length > section.limit) throw invalid(`Section ${section.id} has more than its ${section.limit} bullet slots`);
      placement.set(section.id, chosen);
      lines.set(section.id, chosen.map(revision => revision.prose));
    }
    if (unplaced.size) throw invalid(`Selected bullets were never placed: ${[...unplaced].map(revision => revision.bulletId).join(", ")}`);
  } else {
    const parent = context.parent;
    if (!parent) throw invalid("An edit pass needs the assembled resume it edits");
    const parentIds = parent.selectedBullets.map(bullet => bullet.revisionId);
    if (selected.length !== parentIds.length || selected.some(revision => !parentIds.includes(revision.id))) {
      throw invalid("The edit pass must keep the assembled bullet selection unchanged");
    }
    if (sections.map(section => section.id).join("\n") !== parent.structured.sections.map(section => section.id).join("\n")) {
      throw invalid("The edit pass must keep the assembled section order");
    }
    edits = parseEdits(value["edits"]);
    const applied = new Set<AgentEdit>();
    for (const section of bulletSections) {
      const before = parent.structured.sections.find(entry => entry.id === section.id)?.lines ?? [];
      const after = byId.get(section.id)!.lines;
      if (after.length !== before.length) throw invalid(`The edit pass may not add or remove bullets in ${section.id}`);
      const chosen = before.map(line => {
        const revision = selected.find(candidate => candidate.prose === line);
        if (!revision) throw invalid(`The assembled resume line "${line.slice(0, 80)}" no longer matches a selected bullet`);
        return revision;
      });
      after.forEach((line, index) => {
        if (line === before[index]) return;
        const revision = chosen[index]!;
        const edit = edits.find(candidate => candidate.bulletId === revision.bulletId && candidate.before === before[index] && candidate.after === line);
        if (!edit) throw unsupported(`Changed line in ${section.id} has no declared edit of bullet ${revision.bulletId}`);
        applied.add(edit);
      });
      placement.set(section.id, chosen);
      lines.set(section.id, after);
    }
    const unapplied = edits.filter(edit => !applied.has(edit));
    if (unapplied.length) throw invalid(`Declared edits were not applied: ${unapplied.map(edit => edit.bulletId).join(", ")}`);
  }

  // Everything else is derived from the profile and template, never from the model.
  const baseline = buildStructured({
    jobSnapshotId: context.jobSnapshotId, profile: context.profile, template: context.template, bullets: context.bullets,
    title: context.job.title, descriptionText: context.job.descriptionText, pick: section => placement.get(section.id) ?? [],
  });
  const heading = structured["heading"] as Record<string, unknown>;
  if (String(heading["name"]) !== baseline.structured.heading.name ||
      JSON.stringify(heading["contact"] ?? []) !== JSON.stringify(baseline.structured.heading.contact)) {
    throw unsupported("The heading must be the profile's own name and contact details");
  }
  const rebuilt: ResumeSection[] = sections.map(section => {
    const expected = baseline.structured.sections.find(entry => entry.id === section.id)!;
    if (lines.has(section.id)) return { ...expected, lines: lines.get(section.id)! };
    if (JSON.stringify(section.lines) !== JSON.stringify(expected.lines)) throw unsupported(`Section ${section.id} must contain only the profile's own facts`);
    return expected;
  });
  const chosen = bulletSections.flatMap(section => placement.get(section.id) ?? []);
  return {
    structured: { ...baseline.structured, sections: rebuilt },
    selectedBullets: rankBullets(chosen, context.job),
    edits,
    toolCalls: (Array.isArray(value["toolCalls"]) ? value["toolCalls"] : []).filter((call): call is NonNullable<AgentResult["toolCalls"]>[number] => isRecord(call) && typeof call["toolId"] === "string"),
    messages: (Array.isArray(value["messages"]) ? value["messages"] : []).filter((message): message is NonNullable<AgentResult["messages"]>[number] => isRecord(message) && typeof message["role"] === "string"),
  };
}

function parseEdits(value: unknown): AgentEdit[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid("Agent edits must be a list");
  return value.map(entry => {
    if (!isRecord(entry) || typeof entry["bulletId"] !== "string" || typeof entry["before"] !== "string" || typeof entry["after"] !== "string" || !entry["after"].trim()) {
      throw invalid("Each edit needs bulletId, before and a non-empty after");
    }
    return { bulletId: entry["bulletId"], before: entry["before"], after: entry["after"],
      ...(typeof entry["reason"] === "string" ? { reason: entry["reason"] } : {}) };
  });
}
