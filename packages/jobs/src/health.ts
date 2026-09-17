import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ArtifactStore } from "./artifacts.js";

export type Problem = { code: string; severity: "info" | "warn" | "error"; detail: string };
export type Health = { status: "ok" | "degraded" | "failed"; checkedAt: string; dataDirectory: string; readOnly: boolean;
  database: { file: string; bytes: number; walBytes: number; integrity: string[]; foreignKeyViolations: number; schemaVersion: number };
  artifacts: { referenced: number; verifiedErrors: number; unreferencedFiles: number; stagingFiles: number };
  disk: { freeBytes: number; totalBytes: number; minimumFreeBytes: number };
  queue: { counts: Record<string, number>; staleLeases: number; unconfirmedSubmissions: number };
  retention: { policy: "retain-all"; pruned: 0; counts: Record<string, number>; oldestEventAt: string | null; newestEventAt: string | null };
  backup: { lastBackupAt: string | null; archiveEvents: number };
  problems: Problem[] };

/** A restored archive is marked read-only so nothing is dispatched from it by accident. */
export function readOnlyMarker(dir: string): string { return path.join(dir, "read-only.json"); }
export function isReadOnly(dir: string): boolean { return fs.existsSync(readOnlyMarker(dir)); }

const count = (db: DatabaseSync, sql: string, ...params: unknown[]): number => Number((db.prepare(sql).get(...params as never[]) as Record<string, unknown>)["n"]);

/**
 * Storage health and retention honesty. Every gap is named rather than averaged away, and a
 * missing artifact or a broken database is reported as an error, not a warning.
 */
export function healthOf(db: DatabaseSync, dir: string, options: { artifacts?: ArtifactStore; now?: () => number; minimumFreeBytes?: number } = {}): Health {
  const now = options.now ?? Date.now;
  const artifacts = options.artifacts ?? new ArtifactStore(db, dir, { readOnly: true });
  const minimumFreeBytes = options.minimumFreeBytes ?? 512 * 1024 * 1024;
  const problems: Problem[] = [];
  const databaseFile = path.join(dir, "jobs.sqlite");
  const sizeOf = (file: string): number => { try { return fs.statSync(file).size; } catch { return 0; } };
  const integrity = db.prepare("PRAGMA integrity_check").all().map(row => String((row as Record<string, unknown>)["integrity_check"]));
  const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
  if (integrity.some(value => value !== "ok")) problems.push({ code: "db_integrity", severity: "error", detail: `Database integrity check reported: ${integrity.join("; ")}` });
  if (foreignKeyViolations) problems.push({ code: "db_foreign_keys", severity: "error", detail: `${foreignKeyViolations} foreign key violation(s) present` });

  const artifactReport = artifacts.inspect();
  if (artifactReport.artifactErrors.length) problems.push({ code: "artifact_missing", severity: "error",
    detail: `${artifactReport.artifactErrors.length} referenced artifact(s) are missing or corrupt: ${artifactReport.artifactErrors.slice(0, 3).map(item => `${item.hash}(${item.code})`).join(", ")}` });
  if (artifactReport.unreferencedFiles.length) problems.push({ code: "artifact_unreferenced", severity: "warn",
    detail: `${artifactReport.unreferencedFiles.length} file(s) in the artifact store are not referenced by the database` });
  if (artifactReport.stagingFiles.length) problems.push({ code: "staging_leftover", severity: "warn",
    detail: `${artifactReport.stagingFiles.length} leftover file(s) in staging indicate an interrupted write` });

  let freeBytes = 0, totalBytes = 0;
  try { const stat = fs.statfsSync(dir); freeBytes = Number(stat.bavail) * Number(stat.bsize); totalBytes = Number(stat.blocks) * Number(stat.bsize); }
  catch { problems.push({ code: "disk_unavailable", severity: "warn", detail: "Free space could not be determined for the data directory" }); }
  if (freeBytes && freeBytes < minimumFreeBytes) problems.push({ code: "disk_low", severity: "error",
    detail: `Only ${(freeBytes / 1024 / 1024).toFixed(1)} MiB free; capture, export and backup will fail below ${(minimumFreeBytes / 1024 / 1024).toFixed(0)} MiB` });

  const queueCounts = Object.fromEntries(db.prepare("SELECT state, count(*) AS n FROM tasks GROUP BY state").all()
    .map(row => [String((row as Record<string, unknown>)["state"]), Number((row as Record<string, unknown>)["n"])]));
  const staleLeases = count(db, "SELECT count(*) AS n FROM tasks WHERE state='running' AND (lease_expires_at IS NULL OR lease_expires_at < ?)", now());
  if (staleLeases) problems.push({ code: "queue_stale_lease", severity: "warn",
    detail: `${staleLeases} task(s) hold an expired lease; run a repair to return them to the queue` });
  const unconfirmedSubmissions = count(db, "SELECT count(*) AS n FROM application_attempts WHERE state='unknown'");
  if (unconfirmedSubmissions) problems.push({ code: "submission_unconfirmed", severity: "warn",
    detail: `${unconfirmedSubmissions} submission(s) await operator reconciliation; nothing is retried automatically` });

  const archiveEvents = count(db, "SELECT count(*) AS n FROM events WHERE kind='archive.backup'");
  const lastBackup = db.prepare("SELECT occurred_at FROM events WHERE kind='archive.backup' ORDER BY id DESC LIMIT 1").get() as Record<string, unknown> | undefined;
  const lastBackupAt = lastBackup ? String(lastBackup["occurred_at"]) : null;
  const oldestEvent = db.prepare("SELECT occurred_at FROM events ORDER BY id LIMIT 1").get() as Record<string, unknown> | undefined;
  const newestEvent = db.prepare("SELECT occurred_at FROM events ORDER BY id DESC LIMIT 1").get() as Record<string, unknown> | undefined;
  const retentionCounts: Record<string, number> = {};
  for (const table of ["jobs", "job_snapshots", "applications", "application_attempts", "resume_versions", "agent_runs", "tool_events", "run_messages", "review_decisions", "attention_items", "events", "artifacts"])
    retentionCounts[table] = count(db, `SELECT count(*) AS n FROM ${table}`);
  if (!lastBackupAt) problems.push({ code: "backup_history_missing", severity: "warn",
    detail: "No backup has been recorded for this data directory; retention beyond local failure is a known gap" });

  const readOnly = isReadOnly(dir);
  if (readOnly) problems.push({ code: "read_only_archive", severity: "info",
    detail: "This directory is a read-only restore: dispatch is refused until the marker is removed deliberately" });

  const status: Health["status"] = problems.some(problem => problem.severity === "error") ? "failed"
    : problems.some(problem => problem.severity === "warn") ? "degraded" : "ok";
  return {
    status, checkedAt: new Date(now()).toISOString(), dataDirectory: path.resolve(dir), readOnly,
    database: { file: databaseFile, bytes: sizeOf(databaseFile), walBytes: sizeOf(`${databaseFile}-wal`) + sizeOf(`${databaseFile}-shm`),
      integrity, foreignKeyViolations, schemaVersion: Number((db.prepare("PRAGMA user_version").get() as Record<string, unknown>)["user_version"]) },
    artifacts: { referenced: count(db, "SELECT count(*) AS n FROM artifacts"), verifiedErrors: artifactReport.artifactErrors.length,
      unreferencedFiles: artifactReport.unreferencedFiles.length, stagingFiles: artifactReport.stagingFiles.length },
    disk: { freeBytes, totalBytes, minimumFreeBytes },
    queue: { counts: queueCounts, staleLeases, unconfirmedSubmissions },
    retention: { policy: "retain-all", pruned: 0, counts: retentionCounts,
      oldestEventAt: oldestEvent ? String(oldestEvent["occurred_at"]) : null, newestEventAt: newestEvent ? String(newestEvent["occurred_at"]) : null },
    backup: { lastBackupAt, archiveEvents },
    problems,
  };
}

/**
 * Queue repair. It releases expired leases back to the queue, and refuses to guess at an
 * interrupted submission: those become explicitly unknown and wait for a human.
 */
export function repairQueue(db: DatabaseSync, options: { now?: () => number; submissionGraceMs?: number } = {}): { releasedLeases: string[]; unconfirmed: string[]; left: number } {
  const now = options.now ?? Date.now;
  const graceMs = options.submissionGraceMs ?? 10 * 60 * 1000;
  const time = new Date(now()).toISOString();
  const stale = db.prepare("SELECT id,effect_class FROM tasks WHERE state='running' AND (lease_expires_at IS NULL OR lease_expires_at < ?)").all(now()) as Record<string, unknown>[];
  const releasedLeases: string[] = [];
  for (const task of stale) {
    const id = String(task["id"]);
    db.prepare(`UPDATE tasks SET state='queued', fence=fence+1, lease_owner=NULL, scheduler_generation=NULL, lease_expires_at=NULL,
      error_json=?, updated_at=? WHERE id=? AND state='running'`).run(JSON.stringify({ code: "lease_expired", message: "Released by operator repair; the task will be claimed again" }), time, id);
    releasedLeases.push(id);
  }
  const cutoff = new Date(now() - graceMs).toISOString();
  const stuck = db.prepare("SELECT id FROM tasks WHERE state='submitting' AND updated_at < ?").all(cutoff) as Record<string, unknown>[];
  const unconfirmed: string[] = [];
  for (const task of stuck) {
    const id = String(task["id"]);
    // A submission that may have been sent is never silently retried.
    db.prepare("UPDATE tasks SET state='unknown', fence=fence+1, lease_owner=NULL, lease_expires_at=NULL, error_json=?, updated_at=? WHERE id=? AND state='submitting'")
      .run(JSON.stringify({ code: "submission_unconfirmed", message: "The outcome must be reconciled before this task can run again" }), time, id);
    unconfirmed.push(id);
  }
  const left = count(db, "SELECT count(*) AS n FROM tasks WHERE state IN('running','submitting')");
  return { releasedLeases, unconfirmed, left };
}