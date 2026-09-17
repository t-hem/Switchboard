import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { digest, flushDirectory, type ArtifactStore } from "./artifacts.js";
import { AppError } from "./errors.js";

export type ExportManifest = { formatVersion: 1; createdAt: string; applicationId: string; recordHash: string;
  artifacts: { hash: string; sizeBytes: number; purpose: string }[] };
const HASH = /^[a-f0-9]{64}$/;

/** Every artifact referenced anywhere in a record, so an export is self-contained. */
function referencedHashes(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === "string") { if (HASH.test(value)) found.add(value); return found; }
  if (Array.isArray(value)) { for (const item of value) referencedHashes(item, found); return found; }
  if (value && typeof value === "object") { for (const item of Object.values(value)) referencedHashes(item, found); return found; }
  return found;
}

/**
 * Complete records for review and diagnosis, and a portable export that can be verified and
 * read offline without this service or its database. Both resume passes, the persona and
 * prompt that produced them, tool results and the approval/denial history and receipt are
 * included, and immutable revisions mean later profile or persona edits cannot rewrite them.
 */
export class Records {
  private readonly now: () => number;
  constructor(private readonly deps: { db: DatabaseSync; artifacts: ArtifactStore; now?: () => number }) { this.now = deps.now ?? Date.now; }

  recordOf(applicationId: string): Record<string, unknown> {
    const db = this.deps.db;
    const application = db.prepare("SELECT * FROM applications WHERE id=?").get(applicationId) as Record<string, unknown> | undefined;
    if (!application) throw new AppError("application_missing", "Application not found", 404);
    const jobId = String(application["job_id"]);
    const snapshots = db.prepare("SELECT * FROM job_snapshots WHERE job_id=? ORDER BY captured_at, rowid").all(jobId) as Record<string, unknown>[];
    const tryRows = (sql: string, ...params: unknown[]): Record<string, unknown>[] => db.prepare(sql).all(...params as never[]) as Record<string, unknown>[];
    const resumes = tryRows(`SELECT r.* FROM resume_versions r JOIN job_snapshots s ON s.id=r.job_snapshot_id WHERE s.job_id=? ORDER BY r.created_at, r.rowid`, jobId);
    const attemptRows = tryRows("SELECT * FROM application_attempts WHERE application_id=? ORDER BY created_at, rowid", applicationId);
    const attemptIds = attemptRows.map(row => String(row["id"]));
    const runIds = [...new Set(resumes.map(row => row["agent_run_id"]).filter((id): id is string => typeof id === "string"))];
    const subjects = [applicationId, ...attemptIds];
    const decisions = tryRows(`SELECT * FROM review_decisions WHERE subject_id IN (${subjects.map(() => "?").join(",")}) ORDER BY created_at, rowid`, ...subjects);
    return {
      recordVersion: 1, generatedAt: new Date(this.now()).toISOString(),
      application, job: db.prepare("SELECT * FROM jobs WHERE id=?").get(jobId) ?? null,
      aliases: tryRows("SELECT a.*, s.adapter_id, s.source_key FROM job_aliases a LEFT JOIN sources s ON s.id=a.source_id WHERE a.job_id=?", jobId),
      policy: application["policy_id"] ? db.prepare("SELECT * FROM source_policies WHERE id=?").get(String(application["policy_id"])) ?? null : null,
      screening: tryRows("SELECT * FROM screening_decisions WHERE job_id=? ORDER BY created_at, rowid", jobId),
      // Evidence: the posting text and image hashes exactly as captured.
      snapshots: snapshots.map(snapshot => ({ ...snapshot })),
      // Both tailoring passes: build then edit, each with its selected bullets and edits.
      resumes: resumes.map(resume => ({
        ...resume,
        text: this.#text(String(resume["text_artifact_hash"])),
        parent: resume["parent_resume_id"] ? db.prepare("SELECT id,phase,text_artifact_hash FROM resume_versions WHERE id=?").get(String(resume["parent_resume_id"])) ?? null : null,
      })),
      // The persona/prompt/skills/model that produced them, plus tool results and messages.
      agentRuns: runIds.map(id => db.prepare("SELECT * FROM agent_runs WHERE id=?").get(id) as Record<string, unknown> | undefined).filter(Boolean).map(run => ({
        ...run, skills: JSON.parse(String(run!["skills_json"])), tools: JSON.parse(String(run!["tools_json"])),
        permissions: JSON.parse(String(run!["permissions_json"])), revisionHashes: JSON.parse(String(run!["revision_hashes_json"])),
        outcome: run!["outcome_json"] === null ? null : JSON.parse(String(run!["outcome_json"])),
      })),
      toolEvents: runIds.length ? tryRows(`SELECT * FROM tool_events WHERE run_id IN (${runIds.map(() => "?").join(",")}) ORDER BY run_id, sequence`, ...runIds) : [],
      runMessages: runIds.length ? tryRows(`SELECT * FROM run_messages WHERE run_id IN (${runIds.map(() => "?").join(",")}) ORDER BY run_id, sequence`, ...runIds) : [],
      attempts: attemptRows.map(attempt => ({ ...attempt, manifest: JSON.parse(String(attempt["manifest_json"])) as unknown,
        outcome: attempt["outcome_json"] === null ? null : JSON.parse(String(attempt["outcome_json"])),
        receiptText: attempt["receipt_hash"] === null ? null : this.#text(String(attempt["receipt_hash"])) })),
      decisions,
      attention: tryRows(`SELECT * FROM attention_items WHERE subject_id IN (${subjects.map(() => "?").join(",")}) ORDER BY created_at, rowid`, ...subjects),
      tasks: tryRows(`SELECT t.* FROM tasks t JOIN agent_runs r ON r.task_id=t.id WHERE r.id IN (${runIds.length ? runIds.map(() => "?").join(",") : "''"}) ORDER BY t.created_at`, ...runIds),
      events: [...tryRows("SELECT * FROM events WHERE subject_type='application' AND subject_id=? ORDER BY id, rowid", applicationId),
        ...attemptIds.flatMap(id => tryRows("SELECT * FROM events WHERE subject_type='attempt' AND subject_id=? ORDER BY id, rowid", id))],
    };
  }

  /** A self-contained directory: the record, every artifact it references, and a hash manifest. */
  exportApplication(applicationId: string, directory: string): { directory: string; manifest: ExportManifest } {
    const target = path.resolve(directory);
    if (fs.existsSync(target)) throw new AppError("export_exists", "Refusing to overwrite an existing export directory", 409);
    const record = this.recordOf(applicationId);
    // The database decides what is an artifact: a manifest or approval hash is not one.
    const artifacts = [...referencedHashes(record)].sort().map(hash => this.deps.artifacts.get(hash))
      .filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== null);
    const staging = `${target}.partial-${randomUUID()}`;
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    try {
      fs.mkdirSync(path.join(staging, "artifacts"), { mode: 0o700 });
      for (const artifact of artifacts) {
        const bytes = this.deps.artifacts.read(artifact.hash); // verifies size and digest
        fs.writeFileSync(path.join(staging, "artifacts", artifact.hash), bytes, { mode: 0o600 });
      }
      const recordJson = JSON.stringify(record, null, 2) + "\n";
      fs.writeFileSync(path.join(staging, "record.json"), recordJson, { mode: 0o600 });
      const manifest: ExportManifest = { formatVersion: 1, createdAt: new Date(this.now()).toISOString(), applicationId,
        recordHash: digest(Buffer.from(recordJson, "utf8")),
        artifacts: artifacts.map(artifact => ({ hash: artifact.hash, sizeBytes: artifact.sizeBytes, purpose: artifact.purpose })) };
      fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
      flushDirectory(path.join(staging, "artifacts")); flushDirectory(staging);
      fs.mkdirSync(target, { mode: 0o700 });
      fs.renameSync(staging, target);
      flushDirectory(target);
      return { directory: target, manifest };
    } catch (error) {
      throw new AppError("export_incomplete", `Export incomplete; inspect ${staging}: ${error instanceof Error ? error.message : "unknown error"}`, 500);
    }
  }

  /** Offline verification: no database and no service, only hashes and files. */
  static reconstruct(directory: string): { record: Record<string, unknown>; verifiedArtifacts: number; createdAt: string } {
    const archive = path.resolve(directory);
    const manifest = JSON.parse(fs.readFileSync(path.join(archive, "manifest.json"), "utf8")) as Partial<ExportManifest>;
    if (manifest.formatVersion !== 1 || !Array.isArray(manifest.artifacts) || typeof manifest.recordHash !== "string")
      throw new Error("Unsupported or corrupt export manifest");
    const recordJson = fs.readFileSync(path.join(archive, "record.json"));
    if (digest(recordJson) !== manifest.recordHash) throw new Error("The exported record does not match its manifest hash");
    const record = JSON.parse(recordJson.toString("utf8")) as Record<string, unknown>;
    for (const artifact of manifest.artifacts) {
      if (!artifact || typeof artifact.hash !== "string") throw new Error("Malformed artifact entry in the export manifest");
      const file = path.join(archive, "artifacts", artifact.hash);
      const bytes = fs.readFileSync(file);
      if (bytes.byteLength !== artifact.sizeBytes || digest(bytes) !== artifact.hash) throw new Error(`Artifact ${artifact.hash} is missing, truncated or altered`);
    }
    // Every artifact the export declared has now been read back and hash-verified.
    return { record, verifiedArtifacts: (manifest.artifacts ?? []).length, createdAt: String(manifest.createdAt ?? "") };
  }

  #text(hash: string): string | null {
    const artifact = this.deps.artifacts.get(hash);
    if (!artifact) return null;
    if (!artifact.mimeType.startsWith("text/")) return null; // images stay as hashes, never faked as text
    try { return this.deps.artifacts.read(hash).toString("utf8"); } catch { return null; }
  }
}