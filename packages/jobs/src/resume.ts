import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./database.js";
import { event } from "./events.js";
import { AppError } from "./errors.js";
import { ArtifactStore } from "./artifacts.js";
import { Library, type BulletRevision } from "./library.js";

/** Deterministic, explainable bullet selection. Model-driven tailoring is a later stage. */
export type SelectedBullet = { bulletId: string; revisionId: string; prose: string; tags: string[]; matched: string[]; score: number };

export type ResumeSection = { id: string; title: string; lines: string[] };
export type StructuredResume = {
  jobSnapshotId: string; profileRevisionId: string; templateRevisionId: string;
  heading: { name: string; contact: string[] };
  sections: ResumeSection[];
  /** Required facts or bullet slots the profile could not fill. Visible, never invented. */
  missing: string[];
};
export type RenderedResume = { resumeVersionId: string; textArtifactHash: string; text: string; structured: StructuredResume; selectedBullets: SelectedBullet[]; created: boolean };

export function selectBullets(bullets: BulletRevision[], job: { title: string; descriptionText: string }, limit: number, order: "most-relevant" | "as-listed" = "most-relevant"): SelectedBullet[] {
  const jobText = `${job.title}\n${job.descriptionText}`.toLowerCase();
  const scored = bullets.map(bullet => {
    const matched = bullet.tags.filter(tag => jobText.includes(tag.toLowerCase()));
    return { bulletId: bullet.bulletId, revisionId: bullet.id, prose: bullet.prose, tags: bullet.tags, matched, score: matched.length };
  });
  if (order === "as-listed") return scored.slice(0, limit);
  return scored.sort((a, b) => b.score - a.score || a.bulletId.localeCompare(b.bulletId)).slice(0, limit);
}

export function renderText(structured: StructuredResume): string {
  const lines: string[] = [structured.heading.name];
  if (structured.heading.contact.length) lines.push(structured.heading.contact.join(" · "));
  for (const section of structured.sections) {
    lines.push("", section.title.toUpperCase());
    for (const line of section.lines) lines.push(`- ${line}`);
  }
  lines.push("");
  if (structured.missing.length) lines.push(`[Omissions: ${structured.missing.join("; ")}]`);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** Renders validated library data into structured source plus a text artifact. PDF is deferred. */
export class ResumeRenderer {
  constructor(readonly db: DatabaseSync, readonly artifacts: ArtifactStore, readonly library: Library, readonly now: () => number = Date.now) {}

  render(input: { jobSnapshotId: string; profileRevisionId: string; templateRevisionId: string }): RenderedResume {
    const snapshot = this.db.prepare(`SELECT s.id,s.description_text,j.title,j.company FROM job_snapshots s JOIN jobs j ON j.id=s.job_id WHERE s.id=?`)
      .get(input.jobSnapshotId) as Record<string, unknown> | undefined;
    if (!snapshot) throw new AppError("snapshot_missing", "Job snapshot not found", 404);
    const profile = this.library.profile(input.profileRevisionId);
    if (!profile) throw new AppError("profile_missing", "Profile revision not found", 404);
    const template = this.library.template(input.templateRevisionId);
    if (!template) throw new AppError("template_missing", "Template revision not found", 404);
    const bullets = this.library.bullets(profile.id);

    const contact: string[] = [];
    const { email, phone, location, links } = profile.data.contact;
    for (const value of [email, phone, location]) if (value) contact.push(value);
    for (const link of links ?? []) contact.push(link);

    const missing: string[] = [];
    const sections: ResumeSection[] = [];
    const selectedBySection = new Map<string, SelectedBullet[]>();
    for (const section of template.data.sections) {
      if (section.type === "facts") {
        const lines: string[] = [];
        for (const key of section.factKeys) {
          // `summary` is prose held on the profile; other keys are repeated facts (education, certification…).
          if (key === "summary" && profile.data.summary) { lines.push(profile.data.summary); continue; }
          const values = profile.data.facts.filter(fact => fact.key === key).map(fact => fact.value);
          if (values.length) lines.push(...values);
          else if (!section.optional) missing.push(`${section.title}: ${key}`);
        }
        sections.push({ id: section.id, title: section.title, lines });
      } else if (section.type === "tags") {
        const tags = new Set<string>();
        for (const bullet of bullets) for (const tag of bullet.tags) tags.add(tag);
        for (const fact of profile.data.facts) if (/^skills?$/i.test(fact.key)) for (const value of fact.value.split(/[,;]/)) if (value.trim()) tags.add(value.trim());
        const sorted = [...tags].sort((a, b) => a.localeCompare(b));
        if (!sorted.length) missing.push(`${section.title}: skills`);
        sections.push({ id: section.id, title: section.title, lines: sorted });
      } else {
        const selected = selectBullets(bullets, { title: String(snapshot["title"]), descriptionText: String(snapshot["description_text"]) }, section.limit, section.order ?? "most-relevant");
        selectedBySection.set(section.id, selected);
        if (selected.length < section.limit) missing.push(`${section.title}: ${section.limit - selected.length} of ${section.limit} bullet slots unfilled`);
        sections.push({ id: section.id, title: section.title, lines: selected.map(bullet => bullet.prose) });
      }
    }
    const structured: StructuredResume = {
      jobSnapshotId: input.jobSnapshotId, profileRevisionId: profile.id, templateRevisionId: template.id,
      heading: { name: profile.data.contact.name, contact }, sections, missing,
    };
    const text = renderText(structured);
    const selectedBullets = [...selectedBySection.values()].flat();

    return transaction(this.db, () => {
      const sourceJson = JSON.stringify(structured), selectedJson = JSON.stringify(selectedBullets);
      const existing = this.db.prepare(`SELECT id,text_artifact_hash FROM resume_versions
        WHERE job_snapshot_id=? AND profile_revision_id=? AND template_revision_id=? AND phase='render' AND source_json=? AND selected_bullets_json=?`)
        .get(input.jobSnapshotId, profile.id, template.id, sourceJson, selectedJson) as Record<string, unknown> | undefined;
      if (existing) {
        const hash = String(existing["text_artifact_hash"]);
        return { resumeVersionId: String(existing["id"]), textArtifactHash: hash, text: Buffer.from(this.artifacts.read(hash)).toString("utf8"), structured, selectedBullets, created: false };
      }
      const textArtifactHash = this.artifacts.put(Buffer.from(text, "utf8"), "text/plain; charset=utf-8", "resume-text").hash;
      const id = randomUUID();
      this.db.prepare(`INSERT INTO resume_versions(id,job_snapshot_id,profile_revision_id,template_revision_id,parent_resume_id,agent_run_id,
        phase,source_json,selected_bullets_json,edits_json,text_artifact_hash,pdf_artifact_hash,created_at)
        VALUES(?,?,?,?,NULL,NULL,'render',?,?,'{}',?,NULL,?)`).run(id, input.jobSnapshotId, profile.id, template.id, sourceJson, selectedJson, textArtifactHash, new Date(this.now()).toISOString());
      event(this.db, "resume.rendered", "resume", id, { jobSnapshotId: input.jobSnapshotId, profileRevisionId: profile.id, templateRevisionId: template.id, missing }, this.now());
      return { resumeVersionId: id, textArtifactHash, text, structured, selectedBullets, created: true };
    });
  }

  get(id: string): RenderedResume | null {
    const row = this.db.prepare("SELECT * FROM resume_versions WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const hash = String(row["text_artifact_hash"]);
    return {
      resumeVersionId: id, textArtifactHash: hash, text: Buffer.from(this.artifacts.read(hash)).toString("utf8"),
      structured: JSON.parse(String(row["source_json"])) as StructuredResume,
      selectedBullets: JSON.parse(String(row["selected_bullets_json"])) as SelectedBullet[],
      created: false,
    };
  }
}
