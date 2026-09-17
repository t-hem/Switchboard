import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./database.js";
import { event } from "./events.js";
import { AppError } from "./errors.js";
import { extractSalaryText, normalizeSalary, screenJob, type Decision, type Reason, type ScreeningResult, type Filters } from "./filtering.js";

export type ScreeningRow = {
  id: string; jobId: string; sourceId: string | null; decision: Decision; score: number;
  reasons: Reason[]; actor: string; createdAt: string;
};

/**
 * Append-only screening history plus the operator skip/requeue actions. A decision never
 * invents a value: `needs_review` and `excluded` are distinct, and only a definite
 * mismatch excludes.
 */
export class Screening {
  constructor(readonly db: DatabaseSync, readonly now: () => number = Date.now) {}

  /** The filters configured on the source that produced this job, if any. */
  filtersFor(jobId: string, explicitSourceId?: string | null): { sourceId: string | null; filters: Filters } {
    const row = (explicitSourceId
      ? this.db.prepare("SELECT id,config_json FROM sources WHERE id=?").get(explicitSourceId)
      : this.db.prepare("SELECT s.id,s.config_json FROM sources s JOIN job_aliases a ON a.source_id=s.id WHERE a.job_id=? LIMIT 1").get(jobId)) as Record<string, unknown> | undefined;
    if (!row) return { sourceId: explicitSourceId ?? null, filters: {} };
    const config = JSON.parse(String(row["config_json"])) as { filters?: Filters };
    return { sourceId: String(row["id"]), filters: config.filters ?? {} };
  }

  record(input: { jobId: string; sourceId?: string | null; settingsRevision: number; actor: string } & ScreeningResult): string {
    const decisionId = randomUUID();
    const time = new Date(this.now()).toISOString();
    return transaction(this.db, () => {
      const job = this.db.prepare("SELECT id FROM jobs WHERE id=?").get(input.jobId);
      if (!job) throw new AppError("job_missing", "Job not found", 404);
      this.db.prepare(`INSERT INTO screening_decisions(id,job_id,source_id,settings_revision,decision,score,reasons_json,actor,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(decisionId, input.jobId, input.sourceId ?? null, input.settingsRevision,
        input.decision, input.score, JSON.stringify(input.reasons), input.actor, time);
      this.#applyState(input.jobId, input.decision, input.reasons, time);
      event(this.db, "screening.decided", "job", input.jobId, { decision: input.decision, actor: input.actor, score: input.score }, this.now());
      return decisionId;
    });
  }

  #applyState(jobId: string, decision: Decision, reasons: Reason[], time: string): void {
    const state = decision === "eligible" ? "screened" : decision === "excluded" || decision === "skipped" ? "skipped" : null;
    const block = decision === "needs_review" ? (reasons.find(reason => reason.code.endsWith("unknown"))?.detail ?? "Needs review") : null;
    // `submitted`/`approved` applications are never reverted by a screening pass.
    this.db.prepare(`UPDATE applications SET state=COALESCE(?,state), block_reason=?, updated_at=?
      WHERE job_id=? AND state IN('discovered','captured','screened','skipped','needs_input')`).run(state, block, time, jobId);
  }

  /** Screen from stored data: latest snapshot text when present, else nothing invented. */
  screenStored(jobId: string, input: { sourceId?: string | null; settingsRevision: number; actor?: string }): ScreeningResult {
    const job = this.db.prepare(`SELECT j.title,j.location,j.normalized_json FROM jobs j WHERE j.id=?`).get(jobId) as Record<string, unknown> | undefined;
    if (!job) throw new AppError("job_missing", "Job not found", 404);
    const snapshot = this.db.prepare("SELECT description_text FROM job_snapshots WHERE job_id=? ORDER BY captured_at DESC LIMIT 1").get(jobId) as Record<string, unknown> | undefined;
    const descriptionText = snapshot ? String(snapshot["description_text"]) : "";
    const { sourceId, filters } = this.filtersFor(jobId, input.sourceId);
    const result = this.evaluate({ title: String(job["title"]), descriptionText, location: job["location"] === null ? null : String(job["location"]), filters });
    this.record({ jobId, sourceId, settingsRevision: input.settingsRevision, actor: input.actor ?? "filter", ...result });
    return result;
  }

  evaluate(input: { title: string; descriptionText: string; location: string | null; filters: Filters }): ScreeningResult {
    return screenJob({ ...input, salary: extractSalaryText(input.descriptionText) });
  }

  latest(jobId: string): ScreeningRow | null {
    const row = this.db.prepare("SELECT * FROM screening_decisions WHERE job_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(jobId) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : null;
  }

  list(limit = 100): (ScreeningRow & { title: string; company: string })[] {
    return (this.db.prepare(`SELECT d.*,j.title,j.company FROM screening_decisions d JOIN jobs j ON j.id=d.job_id
      ORDER BY d.created_at DESC, d.rowid DESC LIMIT ?`).all(Math.min(Math.max(limit, 1), 500)) as Record<string, unknown>[])
      .map(row => ({ ...mapRow(row), title: String(row["title"]), company: String(row["company"]) }));
  }

  /** Operator actions are audit events too, and are never silent. */
  skip(jobId: string, reason: string, settingsRevision: number): void {
    if (!reason.trim()) throw new AppError("invalid_screening", "A skip reason is required");
    this.record({ jobId, settingsRevision, actor: "operator", decision: "skipped", score: 0, family: null,
      reasons: [{ code: "operator_skip", detail: reason.trim().slice(0, 2000) }] });
  }
  requeue(jobId: string, settingsRevision: number): void {
    this.record({ jobId, settingsRevision, actor: "operator", decision: "eligible", score: 0, family: null,
      reasons: [{ code: "operator_requeue", detail: "Returned to the queue by the operator" }] });
  }
}

const mapRow = (row: Record<string, unknown>): ScreeningRow => ({
  id: String(row["id"]), jobId: String(row["job_id"]), sourceId: row["source_id"] === null ? null : String(row["source_id"]),
  decision: String(row["decision"]) as Decision, score: Number(row["score"]),
  reasons: JSON.parse(String(row["reasons_json"])) as Reason[], actor: String(row["actor"]), createdAt: String(row["created_at"]),
});

/** Convenience for normalization consumers that only have raw text. */
export { normalizeSalary };
