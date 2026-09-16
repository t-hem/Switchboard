import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./database.js";
import { AppError } from "./errors.js";
import { type Settings } from "./settings.js";

export type SettingsRevision = {revision:number; updatedAt:string; value:Settings};
/** Jobs owns this database. No host imports, shared database, or terminal history. */
export class SettingsStore {
  readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = openDatabase(file);
  }

  current(): SettingsRevision {
    const row = this.db.prepare("SELECT revision,created_at,value_json FROM settings_revisions ORDER BY revision DESC LIMIT 1").get();
    if (!row) throw new Error("Missing settings revision");
    return {revision:Number(row["revision"]),updatedAt:String(row["created_at"]),value:JSON.parse(String(row["value_json"])) as Settings};
  }
  update(expectedRevision: number, value: Settings, actor = "operator"): SettingsRevision {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.current().revision !== expectedRevision) throw new AppError("revision_conflict", "Settings changed on another client; reload before saving", 409);
      this.db.prepare("INSERT INTO settings_revisions(created_at,actor,value_json) VALUES(?,?,?)")
        .run(new Date().toISOString(), actor, JSON.stringify(value));
      const result = this.current();
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close(): void { this.db.close(); }
}
