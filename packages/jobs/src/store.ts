import { DatabaseSync } from "node:sqlite";
import { AppError } from "./errors.js";
import { defaultSettings, type Settings } from "./settings.js";

export type SettingsRevision = {revision:number; updatedAt:string; value:Settings};
/** Jobs owns this database. No host imports, shared database, or terminal history. */
export class SettingsStore {
  readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    try {
      const version = Number(this.db.prepare("PRAGMA user_version").get()!["user_version"]);
      if (version !== 0 && version !== 1) throw new Error(`Unsupported jobs schema ${version}; preserved without migration`);
      if (version === 0) {
        if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get()) throw new Error("Unversioned nonempty jobs database; inspect before migration");
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db.exec(`CREATE TABLE settings_revisions (
            revision INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL, actor TEXT NOT NULL, value_json TEXT NOT NULL CHECK(json_valid(value_json))
          ); PRAGMA user_version=1;`);
          this.db.prepare("INSERT INTO settings_revisions(created_at,actor,value_json) VALUES(?,?,?)")
            .run(new Date().toISOString(), "bootstrap", JSON.stringify(defaultSettings()));
          this.db.exec("COMMIT");
        } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      }
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
    } catch (error) { this.db.close(); throw error; }
  }
  current(): SettingsRevision {
    const row = this.db.prepare("SELECT revision,created_at,value_json FROM settings_revisions ORDER BY revision DESC LIMIT 1").get();
    if (!row) throw new Error("Missing settings revision");
    return {revision:Number(row["revision"]),updatedAt:String(row["created_at"]),value:JSON.parse(String(row["value_json"])) as Settings};
  }
  update(expectedRevision: number, value: Settings): SettingsRevision {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.current().revision !== expectedRevision) throw new AppError("revision_conflict", "Settings changed on another client; reload before saving", 409);
      this.db.prepare("INSERT INTO settings_revisions(created_at,actor,value_json) VALUES(?,?,?)")
        .run(new Date().toISOString(), "operator", JSON.stringify(value));
      const result = this.current();
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close(): void { this.db.close(); }
}
