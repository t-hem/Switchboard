import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./database.js";
import { AppError } from "./errors.js";
import { createSourceAdapter, type SourceConfig } from "./adapters/source.js";

export type SourceRow = {
  id: string; adapterId: string; sourceKey: string; config: SourceConfig;
  enabled: boolean; policyId: string | null; createdAt: string; updatedAt: string;
};

const parse = (row: Record<string, unknown>): SourceRow => ({
  id: String(row["id"]), adapterId: String(row["adapter_id"]), sourceKey: String(row["source_key"]),
  config: JSON.parse(String(row["config_json"])) as SourceConfig, enabled: Number(row["enabled"]) === 1,
  policyId: row["policy_id"] === null ? null : String(row["policy_id"]),
  createdAt: String(row["created_at"]), updatedAt: String(row["updated_at"]),
});

/** Registry of configured sources. Validation happens here, before any work is queued. */
export class Sources {
  constructor(readonly db: DatabaseSync, readonly now: () => number = Date.now) {}
  list(): SourceRow[] {
    return (this.db.prepare("SELECT * FROM sources ORDER BY source_key").all() as Record<string, unknown>[]).map(parse);
  }
  get(id: string): SourceRow | null {
    const row = this.db.prepare("SELECT * FROM sources WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? parse(row) : null;
  }
  upsert(input: { id: string; adapterId: string; sourceKey: string; config: unknown; enabled?: boolean }): SourceRow {
    // Rejects an unknown provider before any network or scheduling work exists.
    createSourceAdapter(input.adapterId);
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.id)) throw new AppError("invalid_source", "Source id must be a short lowercase identifier");
    if (!input.sourceKey.trim()) throw new AppError("invalid_source", "A source key is required");
    const config = input.config as SourceConfig;
    if (!config || typeof config !== "object" || typeof config.companyName !== "string" || !config.companyName.trim() ||
        typeof config.boardId !== "string" || !config.boardId.trim()) {
      throw new AppError("invalid_source", "Source config requires companyName and boardId");
    }
    const time = new Date(this.now()).toISOString();
    return transaction(this.db, () => {
      const existing = this.db.prepare("SELECT enabled FROM sources WHERE id=?").get(input.id) as Record<string, unknown> | undefined;
      if (existing) {
        // Enabled is operator intent: a config-only update never silently enables or disables a source.
        const enabled = input.enabled === undefined ? Number(existing["enabled"]) === 1 : input.enabled === true;
        this.db.prepare("UPDATE sources SET adapter_id=?,source_key=?,config_json=?,enabled=?,updated_at=? WHERE id=?")
          .run(input.adapterId, input.sourceKey, JSON.stringify(config), enabled ? 1 : 0, time, input.id);
      } else {
        this.db.prepare("INSERT INTO sources(id,adapter_id,source_key,config_json,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
          .run(input.id, input.adapterId, input.sourceKey, JSON.stringify(config), input.enabled === true ? 1 : 0, time, time);
      }
      return this.get(input.id)!;
    });
  }
  /** Only used by tests and first-run seeding; never enables a source implicitly. */
  seed(input: { id: string; adapterId: string; sourceKey: string; config: unknown; enabled?: boolean }): SourceRow {
    if (this.get(input.id)) return this.get(input.id)!;
    return this.upsert({ ...input, enabled: input.enabled === true });
  }
  static newId(): string { return randomUUID(); }
}