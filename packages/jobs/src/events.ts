import type { DatabaseSync } from "node:sqlite";
export function event(db:DatabaseSync,kind:string,subjectType:string,subjectId:string,payload:unknown,now=Date.now()): void {
  db.prepare("INSERT INTO events(occurred_at,kind,subject_type,subject_id,payload_json) VALUES(?,?,?,?,?)")
    .run(new Date(now).toISOString(),kind,subjectType,subjectId,JSON.stringify(payload));
}
