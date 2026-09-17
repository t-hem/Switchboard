import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./database.js";
import { event } from "./events.js";
import { AppError } from "./errors.js";

/**
 * Per-site policy. Every change is a new immutable revision recorded with who reviewed it,
 * so tightening a site (for example withdrawing permission to submit) is an explicit,
 * queryable operator act that immediately governs a previously approved attempt.
 */
export type PolicyCapabilities = { prepare: boolean; fill: boolean; upload: boolean; submit: boolean };
export type PolicyRestrictions = { autoSubmit?: boolean; maxPerDay?: number; notes?: string };
export type Policy = { id: string; scopeKey: string; revision: number; adapterId: string; siteUrl: string | null; termsUrl: string | null;
  reviewedAt: string | null; reviewedBy: string; capabilities: PolicyCapabilities; restrictions: PolicyRestrictions; createdAt: string };

export function policyScope(adapterId: string, siteUrl: string): string {
  let host = siteUrl;
  try { host = new URL(siteUrl).host || siteUrl; } catch { /* keep the raw value */ }
  return `${adapterId}:${host}`;
}

export class Policies {
  private readonly now: () => number;
  constructor(private readonly db: DatabaseSync, now: () => number = Date.now) { this.now = now; }

  #map(row: Record<string, unknown>): Policy {
    return { id: String(row["id"]), scopeKey: String(row["scope_key"]), revision: Number(row["revision"]), adapterId: String(row["adapter_id"]),
      siteUrl: row["site_url"] === null ? null : String(row["site_url"]), termsUrl: row["terms_url"] === null ? null : String(row["terms_url"]),
      reviewedAt: row["reviewed_at"] === null ? null : String(row["reviewed_at"]), reviewedBy: "", capabilities: JSON.parse(String(row["capabilities_json"])) as PolicyCapabilities,
      restrictions: JSON.parse(String(row["restrictions_json"])) as PolicyRestrictions, createdAt: String(row["created_at"]) };
  }

  list(): Policy[] {
    return this.db.prepare("SELECT * FROM source_policies ORDER BY scope_key, revision DESC LIMIT 200").all().map(row => this.#map(row as Record<string, unknown>));
  }

  /** The latest revision for the adapter and site an attempt is aimed at, or null if none. */
  effective(adapterId: string, siteUrl: string): Policy | null {
    const row = this.db.prepare("SELECT * FROM source_policies WHERE scope_key=? ORDER BY revision DESC LIMIT 1").get(policyScope(adapterId, siteUrl));
    return row ? this.#map(row as Record<string, unknown>) : null;
  }

  put(input: { adapterId: string; siteUrl: string; capabilities: PolicyCapabilities; restrictions?: PolicyRestrictions; termsUrl?: string | null; reviewedBy: string }): Policy {
    const db = this.db;
    if (!input.adapterId) throw new AppError("invalid_policy", "A policy needs an adapter id");
    const restrictions = { ...(input.restrictions ?? {}) };
    // Automatic sending is a property of submission; a policy that forbids sending cannot allow it.
    if (restrictions.autoSubmit === true && !input.capabilities.submit) throw new AppError("invalid_policy", "Automatic submission requires permitting submission", 409);
    if (restrictions.maxPerDay !== undefined && (!Number.isSafeInteger(restrictions.maxPerDay) || restrictions.maxPerDay < 0 || restrictions.maxPerDay > 1000))
      throw new AppError("invalid_policy", "maxPerDay must be a whole number between 0 and 1000");
    const scopeKey = policyScope(input.adapterId, input.siteUrl);
    const time = new Date(this.now()).toISOString();
    return transaction(db, () => {
      const previous = db.prepare("SELECT * FROM source_policies WHERE scope_key=? ORDER BY revision DESC LIMIT 1").get(scopeKey) as Record<string, unknown> | undefined;
      const revision = previous ? Number(previous["revision"]) + 1 : 1;
      const id = randomUUID();
      db.prepare(`INSERT INTO source_policies(id,scope_key,revision,adapter_id,site_url,terms_url,reviewed_at,capabilities_json,restrictions_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, scopeKey, revision, input.adapterId, input.siteUrl, input.termsUrl ?? null, time,
        JSON.stringify(input.capabilities), JSON.stringify(restrictions), time);
      event(db, "policy.revised", "policy", id, { scopeKey, revision, reviewedBy: input.reviewedBy,
        capabilities: input.capabilities, restrictions,
        previous: previous ? { revision: Number(previous["revision"]), capabilities: JSON.parse(String(previous["capabilities_json"])) } : null }, this.now());
      return this.#map(db.prepare("SELECT * FROM source_policies WHERE id=?").get(id) as Record<string, unknown>);
    });
  }
}