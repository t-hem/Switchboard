import { DatabaseSync } from "node:sqlite";
import { defaultSettings } from "./settings.js";
import { workflowSchema, immutableTables } from "./schema.js";

export const SCHEMA_VERSION = 2;
export function transaction<T>(db:DatabaseSync, action:()=>T): T {
  db.exec("BEGIN IMMEDIATE");
  try {const result=action();db.exec("COMMIT");return result;}
  catch(error){db.exec("ROLLBACK");throw error;}
}
export function openDatabase(file:string): DatabaseSync {
  const db=new DatabaseSync(file);
  try {
    const version=Number(db.prepare("PRAGMA user_version").get()!["user_version"]);
    if(version<0 || version>SCHEMA_VERSION)throw new Error(`Unsupported jobs schema ${version}; preserved without migration`);
    if(version===0 && db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get())throw new Error("Unversioned nonempty jobs database; inspect before migration");
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    transaction(db,()=>{
      // Re-read under the write lock: another process may have just migrated it.
      let current=Number(db.prepare("PRAGMA user_version").get()!["user_version"]);
      if(current>SCHEMA_VERSION)throw new Error("Database migrated by a newer app; refusing downgrade");
      if(current===0){
        db.exec(`CREATE TABLE settings_revisions (
          revision INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
          actor TEXT NOT NULL, value_json TEXT NOT NULL CHECK(json_valid(value_json))
        ); PRAGMA user_version=1;`);
        db.prepare("INSERT INTO settings_revisions(created_at,actor,value_json) VALUES(?,?,?)")
          .run(new Date().toISOString(),"bootstrap",JSON.stringify(defaultSettings()));
        current=1;
      }
      if(current===1){
        db.exec(workflowSchema);
        for(const table of immutableTables){
          // Identifiers are a compile-time allowlist, never request input.
          db.exec(`CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable record'); END;
            CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable record'); END;`);
        }
        db.exec("PRAGMA user_version=2;");
      }
    });
    db.exec("PRAGMA journal_mode=WAL;");
    return db;
  } catch(error){db.close();throw error;}
}
