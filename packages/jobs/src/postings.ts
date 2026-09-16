import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./database.js";
import { event } from "./events.js";
import { AppError } from "./errors.js";
import { ArtifactStore } from "./artifacts.js";
import { textDigest } from "./html.js";

const TRACKING = [/^utm_/i, /^gclid$/i, /^fbclid$/i, /^msclkid$/i, /^mc_(cid|eid)$/i, /^_hsenc$/i, /^_hsmi$/i, /^gh_src$/i, /^ref$/i, /^source$/i];

/** Deterministic URL form used for dedup: no credentials, fragment or tracking params. */
export function canonicalizeUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError("invalid_url", "Posting URL must be absolute"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new AppError("invalid_url", "Only http(s) posting URLs are allowed");
  url.username = ""; url.password = ""; url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING.some(pattern => pattern.test(key))) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}
/** Dedup ignores the transport scheme so an http→https redirect does not fork a posting. */
const dedupKeyFor = (canonical: string): string => canonical.replace(/^http:/, "https:");

export type IngestInput = {
  sourceId?: string | null;
  adapterId: string;
  externalId?: string | null;
  originalUrl: string;
  canonicalUrl?: string | null;
  company: string;
  title: string;
  location?: string | null;
  descriptionText: string;
  descriptionHtml?: string | null;
  department?: string | null;
  employmentType?: string | null;
  postedAt?: string | null;
  provenance: "source" | "manual" | "browser";
  /** Digest of the archived raw source response(s); the payload itself lives in artifacts. */
  rawHash?: string | null;
};
export type IngestResult = { jobId: string; applicationId: string; created: boolean; dedupKey: string; canonicalUrl: string };

export type SnapshotInput = {
  jobId: string;
  purpose: "discovery" | "tailoring" | "application_preflight";
  fetchedUrl: string;
  finalUrl: string;
  descriptionText: string;
  screenshot?: Uint8Array | null;
  imageMimeType?: string;
  captureVersion: string;
  capture: unknown;
  completeness: "complete" | "partial" | "failed";
  failureDetail?: string | null;
};
export type SnapshotResult = { snapshotId: string; contentHash: string; screenshotHash: string | null; created: boolean };

const str = (row: Record<string, unknown>, key: string): string | null => (row[key] === null || row[key] === undefined ? null : String(row[key]));

/** One posting per canonical URL; one eligible application per posting. */
export class Postings {
  constructor(readonly db: DatabaseSync, readonly artifacts: ArtifactStore, readonly now: () => number = Date.now) {}

  ingest(input: IngestInput): IngestResult {
    const canonicalUrl = canonicalizeUrl(input.canonicalUrl ?? input.originalUrl);
    const dedupKey = dedupKeyFor(canonicalUrl);
    if (!input.company.trim() || !input.title.trim()) throw new AppError("invalid_posting", "Company and title are required");
    return transaction(this.db, () => {
      const existing = this.db.prepare("SELECT id FROM jobs WHERE dedup_key=?").get(dedupKey);
      let jobId = existing ? String(existing["id"]) : "";
      let created = false;
      const time = new Date(this.now()).toISOString();
      if (!jobId && input.sourceId && input.externalId) {
        const alias = this.db.prepare("SELECT job_id FROM job_aliases WHERE source_id=? AND external_id=?").get(input.sourceId, input.externalId);
        if (alias) jobId = String(alias["job_id"]);
      }
      if (!jobId) {
        jobId = randomUUID();
        const normalized = {
          location: input.location ?? null, department: input.department ?? null,
          employmentType: input.employmentType ?? null, postedAt: input.postedAt ?? null,
          provenance: input.provenance, descriptionHtml: input.descriptionHtml ?? null,
          source: { adapterId: input.adapterId, externalId: input.externalId ?? null, rawHash: input.rawHash ?? null },
        };
        this.db.prepare(`INSERT INTO jobs(id,canonical_url,dedup_key,company,title,location,normalized_json,discovered_at,last_seen_at)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(jobId, canonicalUrl, dedupKey, input.company.trim(), input.title.trim(),
          input.location ?? null, JSON.stringify(normalized), time, time);
        created = true;
        event(this.db, "posting.ingested", "job", jobId, { adapterId: input.adapterId, provenance: input.provenance, canonicalUrl }, this.now());
      } else {
        this.db.prepare("UPDATE jobs SET last_seen_at=? WHERE id=?").run(time, jobId);
      }
      if (input.sourceId && input.externalId) {
        this.db.prepare(`INSERT INTO job_aliases(id,job_id,source_id,external_id,original_url,discovered_at) VALUES(?,?,?,?,?,?)
          ON CONFLICT(source_id,external_id) DO NOTHING`).run(randomUUID(), jobId, input.sourceId, input.externalId, input.originalUrl, time);
      }
      this.db.prepare(`INSERT INTO applications(id,job_id,state,settings_revision,created_at,updated_at)
        VALUES(?,?,'discovered',(SELECT max(revision) FROM settings_revisions),?,?) ON CONFLICT(job_id) DO NOTHING`)
        .run(randomUUID(), jobId, time, time);
      const application = this.db.prepare("SELECT id FROM applications WHERE job_id=?").get(jobId);
      return { jobId, applicationId: String(application!["id"]), created, dedupKey, canonicalUrl };
    });
  }

  /** Snapshot evidence is write-once. Re-capturing unchanged text does not duplicate it. */
  recordSnapshot(input: SnapshotInput): SnapshotResult {
    if (input.completeness === "complete" && !input.descriptionText.trim()) {
      throw new AppError("incomplete_capture", "A complete snapshot requires captured text");
    }
    if (input.purpose === "application_preflight" && input.completeness === "complete" && !input.screenshot) {
      throw new AppError("incomplete_capture", "A complete application preflight requires a screenshot");
    }
    const contentHash = textDigest(input.descriptionText);
    return transaction(this.db, () => {
      // Dedup within one capture method/version: a manual paste never masks a browser capture.
      const existing = this.db.prepare("SELECT id,screenshot_hash FROM job_snapshots WHERE job_id=? AND purpose=? AND content_hash=? AND capture_version=?")
        .get(input.jobId, input.purpose, contentHash, input.captureVersion);
      if (existing) {
        return { snapshotId: String(existing["id"]), contentHash, screenshotHash: str(existing, "screenshot_hash"), created: false };
      }
      const screenshotHash = input.screenshot ? this.artifacts.put(input.screenshot, input.imageMimeType ?? "image/png", "screenshot", undefined).hash : null;
      const snapshotId = randomUUID();
      this.db.prepare(`INSERT INTO job_snapshots(id,job_id,purpose,captured_at,fetched_url,final_url,description_text,screenshot_hash,content_hash,capture_version,capture_json,completeness,failure_detail)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(snapshotId, input.jobId, input.purpose, new Date(this.now()).toISOString(),
        input.fetchedUrl, input.finalUrl, input.descriptionText, screenshotHash, contentHash, input.captureVersion,
        JSON.stringify(input.capture), input.completeness, input.failureDetail ?? null);
      if (input.completeness === "complete" && input.purpose === "discovery") {
        // Ready for review; never advances further than captured without an explicit operator action.
        this.db.prepare("UPDATE applications SET state='captured',updated_at=? WHERE job_id=? AND state='discovered'")
          .run(new Date(this.now()).toISOString(), input.jobId);
      }
      event(this.db, "snapshot.recorded", "job", input.jobId, { snapshotId, purpose: input.purpose, completeness: input.completeness, contentHash }, this.now());
      return { snapshotId, contentHash, screenshotHash, created: true };
    });
  }

  latestSnapshot(jobId: string, purpose?: string): Record<string, unknown> | null {
    const row = purpose
      ? this.db.prepare("SELECT * FROM job_snapshots WHERE job_id=? AND purpose=? ORDER BY captured_at DESC LIMIT 1").get(jobId, purpose)
      : this.db.prepare("SELECT * FROM job_snapshots WHERE job_id=? ORDER BY captured_at DESC LIMIT 1").get(jobId);
    return row ? row as Record<string, unknown> : null;
  }
}
