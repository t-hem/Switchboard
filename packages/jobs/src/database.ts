import { DatabaseSync } from "node:sqlite";
import { defaultSettings } from "./settings.js";
import { workflowSchema, immutableTables } from "./schema.js";

export const SCHEMA_VERSION = 3;
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
        current=2;
      }
      if(current===2){
        db.exec(`CREATE TABLE attention_items (
          id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id),
          run_id TEXT REFERENCES agent_runs(id), artifact_hash TEXT REFERENCES artifacts(hash),
          subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, subject_version TEXT NOT NULL,
          title TEXT NOT NULL, detail TEXT NOT NULL, context_json TEXT NOT NULL CHECK(json_valid(context_json)),
          settings_revision INTEGER NOT NULL REFERENCES settings_revisions(revision),
          state TEXT NOT NULL DEFAULT 'open' CHECK(state IN('open','resolved','superseded')),
          version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
          decision_id TEXT REFERENCES review_decisions(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(task_id,subject_type,subject_id,subject_version,settings_revision)
        );
        CREATE TRIGGER attention_input_immutable BEFORE UPDATE OF id,task_id,run_id,artifact_hash,subject_type,subject_id,subject_version,title,detail,context_json,settings_revision,created_at ON attention_items
          BEGIN SELECT RAISE(ABORT,'immutable review input'); END;
        CREATE TRIGGER attention_no_delete BEFORE DELETE ON attention_items BEGIN SELECT RAISE(ABORT,'retain review history'); END;
        PRAGMA user_version=3;`);
      }
    });
    db.exec("PRAGMA journal_mode=WAL;");
    return db;
  } catch(error){db.close();throw error;}
}
