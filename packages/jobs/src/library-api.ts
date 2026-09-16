import type { FastifyInstance } from "fastify";
import type { SettingsStore } from "./store.js";
import { AppError } from "./errors.js";
import { ArtifactStore } from "./artifacts.js";
import { Library } from "./library.js";
import { ResumeRenderer } from "./resume.js";

/**
 * Career-library and resume-render surface. Facts, bullets and templates are versioned
 * revisions of operator material; rendering produces a structured source plus a text
 * artifact. PDF output is deliberately deferred (a later stage may add it).
 */
export function libraryRoutes(app: FastifyInstance, store: SettingsStore, dir: string, now?: () => number): void {
  const db = store.db;
  const artifacts = new ArtifactStore(db, dir);
  const library = new Library(db, now);
  const renderer = new ResumeRenderer(db, artifacts, library, now);

  app.get("/api/library", async () => {
    const profiles = library.profiles(), templates = library.templates();
    const latest = profiles.length ? profiles[profiles.length - 1]! : null;
    return { profiles, templates, bullets: latest ? library.bullets(latest.id) : [], pdfRendering: false };
  });
  app.put<{ Body: { profileId: string; data: unknown; evidence?: unknown } }>("/api/library/profile", {
    schema: { body: { type: "object", additionalProperties: false, required: ["profileId", "data"],
      properties: { profileId: { type: "string", minLength: 1, maxLength: 100 }, data: { type: "object" }, evidence: {} } } },
  }, async req => library.addProfile(req.body));
  app.put<{ Body: { profileRevisionId: string; bullets: unknown } }>("/api/library/bullets", {
    schema: { body: { type: "object", additionalProperties: false, required: ["profileRevisionId", "bullets"],
      properties: { profileRevisionId: { type: "string", minLength: 1 }, bullets: { type: "array", minItems: 1 } } } },
  }, async req => library.addBullets(req.body));
  app.put<{ Body: { templateId: string; data: unknown } }>("/api/library/template", {
    schema: { body: { type: "object", additionalProperties: false, required: ["templateId", "data"],
      properties: { templateId: { type: "string", minLength: 1, maxLength: 100 }, data: { type: "object" } } } },
  }, async req => library.addTemplate(req.body));
  app.get("/api/library/export", async () => library.exportAll());
  app.post<{ Body: { payload: unknown } }>("/api/library/import", {
    schema: { body: { type: "object", additionalProperties: false, required: ["payload"], properties: { payload: { type: "object" } } } },
  }, async req => library.importAll(req.body.payload));

  app.post<{ Body: { jobSnapshotId: string; profileRevisionId?: string; templateRevisionId?: string } }>("/api/resumes/render", {
    schema: { body: { type: "object", additionalProperties: false, required: ["jobSnapshotId"],
      properties: { jobSnapshotId: { type: "string", minLength: 1 }, profileRevisionId: { type: "string", minLength: 1 }, templateRevisionId: { type: "string", minLength: 1 } } } },
  }, async req => {
    const profileRevisionId = req.body.profileRevisionId ?? library.latestProfile()?.id;
    const templateRevisionId = req.body.templateRevisionId ?? library.templates()[0]?.id;
    if (!profileRevisionId) throw new AppError("profile_missing", "Import a profile before rendering", 409);
    if (!templateRevisionId) throw new AppError("template_missing", "Import a template before rendering", 409);
    return renderer.render({ jobSnapshotId: req.body.jobSnapshotId, profileRevisionId, templateRevisionId });
  });
  app.get<{ Params: { id: string } }>("/api/resumes/:id", async req => {
    const rendered = renderer.get(req.params.id);
    if (!rendered) throw new AppError("resume_missing", "Resume version not found", 404);
    return rendered;
  });
}
