import { AppError } from "./errors.js";
import { Library, type BulletRevision, type ProfileRevision, type TemplateRevision, type TemplateSection } from "./library.js";
import { buildStructured, rankBullets, renderText, type ResumeSection, type SelectedBullet, type StructuredResume } from "./resume.js";

type BulletSection = Extract<TemplateSection, { type: "bullets" }>;

/**
 * A run-scoped draft over validated library revisions. The model can only choose among
 * existing revisions and bounded layout options; it cannot invent bullets, prose or markup.
 */
export class DraftState {
  readonly profile: ProfileRevision;
  readonly template: TemplateRevision;
  readonly jobTitle: string;
  readonly descriptionText: string;
  private readonly bullets: BulletRevision[];

  private readonly selection = new Map<string, string[]>();
  private sectionOrder: string[];

  constructor(readonly library: Library, readonly jobSnapshotId: string, profileRevisionId: string, templateRevisionId: string) {
    const snapshot = library.db.prepare("SELECT s.description_text,j.title FROM job_snapshots s JOIN jobs j ON j.id=s.job_id WHERE s.id=?").get(jobSnapshotId) as Record<string, unknown> | undefined;
    if (!snapshot) throw new AppError("snapshot_missing", "Job snapshot not found", 404);
    this.jobTitle = String(snapshot["title"]);
    this.descriptionText = String(snapshot["description_text"]);
    const profile = library.profile(profileRevisionId);
    if (!profile) throw new AppError("profile_missing", "Profile revision not found", 404);
    const template = library.template(templateRevisionId);
    if (!template) throw new AppError("template_missing", "Template revision not found", 404);
    this.profile = profile;
    this.template = template;
    this.bullets = library.bullets(profile.id);
    this.sectionOrder = template.data.sections.map(section => section.id);
  }
  pool(): BulletRevision[] { return [...this.bullets]; }
  bulletSections(): BulletSection[] { return this.template.data.sections.filter((section): section is BulletSection => section.type === "bullets"); }
  section(id: string): TemplateSection {
    const found = this.template.data.sections.find(section => section.id === id);
    if (!found) throw new AppError("unknown_section", `No template section ${id}`);
    return found;
  }
  orderedSections(): TemplateSection[] {
    return this.sectionOrder.map(id => this.section(id));
  }
  selectionFor(sectionId: string): BulletRevision[] {
    const ids = this.selection.get(sectionId);
    if (!ids) return [];
    return ids.map(id => this.bullets.find(bullet => bullet.id === id)!);
  }
  select(sectionId: string, bulletId: string): BulletRevision[] {
    const section = this.section(sectionId);
    if (section.type !== "bullets") throw new AppError("unknown_section", `Section ${sectionId} does not accept bullets`);
    const bullet = this.bullets.find(entry => entry.bulletId === bulletId);
    if (!bullet) throw new AppError("unknown_bullet", `Bullet ${bulletId} is not part of this profile revision`);
    const ids = this.selection.get(sectionId) ?? [];
    if (ids.includes(bullet.id)) throw new AppError("duplicate_bullet", `Bullet ${bulletId} is already selected in ${sectionId}`);
    if (ids.length >= section.limit) throw new AppError("slot_limit", `Section ${sectionId} already has its ${section.limit} bullets`);
    this.selection.set(sectionId, [...ids, bullet.id]);
    return this.selectionFor(sectionId);
  }
  order(ids: string[]): string[] {
    const expected = this.template.data.sections.map(section => section.id).sort();
    const provided = [...ids].sort();
    if (expected.length !== provided.length || expected.some((id, index) => id !== provided[index])) {
      throw new AppError("invalid_order", "order_sections must list every template section exactly once");
    }
    this.sectionOrder = [...ids];
    return this.sectionOrder;
  }
  private pick(section: BulletSection): BulletRevision[] {
    const chosen = this.selection.get(section.id);
    if (chosen) return chosen.map(id => this.bullets.find(bullet => bullet.id === id)!);
    return rankBullets(this.bullets, { title: this.jobTitle, descriptionText: this.descriptionText })
      .sort((a, b) => b.score - a.score || a.bulletId.localeCompare(b.bulletId))
      .slice(0, section.limit)
      .map(entry => this.bullets.find(bullet => bullet.id === entry.revisionId)!);
  }
  build(): { structured: StructuredResume; selectedBullets: SelectedBullet[]; text: string; sections: ResumeSection[] } {
    const { structured, selectedBullets } = buildStructured({
      jobSnapshotId: this.jobSnapshotId, profile: this.profile, template: this.template, bullets: this.bullets,
      title: this.jobTitle, descriptionText: this.descriptionText, pick: section => this.pick(section),
    });
    // Re-apply any explicit section ordering chosen through order_sections.
    const byId = new Map(structured.sections.map(section => [section.id, section]));
    structured.sections = this.sectionOrder.map(id => byId.get(id)!).filter(Boolean);
    return { structured, selectedBullets, text: renderText(structured), sections: structured.sections };
  }
}

export type ScopedTool = {
  id: string; version: string; description: string;
  run(draft: DraftState, args: Record<string, unknown>): unknown;
};
const list = (value: unknown, field: string): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(entry => typeof entry !== "string")) throw new AppError("invalid_tool_input", `${field} must be a list of strings`);
  return value as string[];
};

/** Jobs-owned tools. Each validates ids, associations, duplicates, lengths and renderability. */
export const TOOLS: Record<string, ScopedTool> = {
  list_templates: {
    id: "list_templates", version: "1", description: "List available base templates and their sections.",
    run(draft) { return draft.library.templates().map(template => ({ revisionId: template.id, templateId: template.templateId, revision: template.revision, name: template.data.name, sections: template.data.sections })); },
  },
  find_bullets: {
    id: "find_bullets", version: "1", description: "Find profile bullets, optionally filtered by tags.",
    run(draft, args) {
      const tags = list(args["tags"], "tags").map(tag => tag.toLowerCase());
      const limit = args["limit"] === undefined ? 20 : Number(args["limit"]);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new AppError("invalid_tool_input", "limit must be 1–50");
      const ranked = rankBullets(draft.pool(), { title: draft.jobTitle, descriptionText: draft.descriptionText })
        .filter(entry => tags.length === 0 || entry.tags.some(tag => tags.includes(tag.toLowerCase())))
        .sort((a, b) => b.score - a.score || a.bulletId.localeCompare(b.bulletId));
      return ranked.slice(0, limit);
    },
  },
  select_bullet: {
    id: "select_bullet", version: "1", description: "Place one existing bullet revision into a template bullet section.",
    run(draft, args) {
      const sectionId = args["sectionId"], bulletId = args["bulletId"];
      if (typeof sectionId !== "string" || typeof bulletId !== "string") throw new AppError("invalid_tool_input", "sectionId and bulletId are required");
      return { sectionId, bullets: draft.select(sectionId, bulletId).map(bullet => ({ bulletId: bullet.bulletId, revisionId: bullet.id, prose: bullet.prose })) };
    },
  },
  order_sections: {
    id: "order_sections", version: "1", description: "Reorder the template's sections.",
    run(draft, args) { return { order: draft.order(list(args["order"], "order")) }; },
  },
  render_preview: {
    id: "render_preview", version: "1", description: "Render the current draft to structured text.",
    run(draft) { const built = draft.build(); return { text: built.text, missing: built.structured.missing, selections: draft.bulletSections().map(section => ({ sectionId: section.id, bullets: draft.selectionFor(section.id).map(bullet => bullet.bulletId) })) }; },
  },
  finalize_resume: {
    id: "finalize_resume", version: "1", description: "Finalize the draft into a structured resume for persistence.",
    run(draft) {
      const built = draft.build();
      if (!built.structured.heading.name) throw new AppError("unrenderable", "Resume has no candidate name");
      if (built.structured.sections.every(section => section.lines.length === 0)) throw new AppError("unrenderable", "Resume has no content");
      return { structured: built.structured, selectedBullets: built.selectedBullets, text: built.text };
    },
  },
};

export function runTool(draft: DraftState, id: string, args: Record<string, unknown> = {}): unknown {
  const tool = TOOLS[id];
  if (!tool) throw new AppError("unknown_tool", `No scoped tool ${id}`);
  return tool.run(draft, args);
}
export function toolIds(): string[] { return Object.keys(TOOLS).sort(); }
