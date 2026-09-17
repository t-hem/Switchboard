import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./database.js";
import { event } from "./events.js";
import { AppError } from "./errors.js";

export class Reviews {
  constructor(readonly db:DatabaseSync){}
  /** Workflow-only entry point. No public API lets a client invent an approvable subject. */
  open(input:{taskId:string;runId?:string;artifactHash?:string;subjectType:string;subjectId:string;subjectVersion:string;title:string;detail:string;context:unknown;settingsRevision:number}):string{
    return transaction(this.db,()=>{
      const task=this.db.prepare("SELECT state FROM tasks WHERE id=?").get(input.taskId);
      if(!task||task["state"]!=="waiting_review")throw new AppError("review_blocked","Task must be waiting for review",409);
      if(input.runId){
        const run=this.db.prepare("SELECT task_id FROM agent_runs WHERE id=?").get(input.runId);
        if(run?.["task_id"]!==input.taskId)throw new AppError("review_blocked","Agent run does not belong to this task",409);
      }
      const old=this.db.prepare("SELECT id FROM attention_items WHERE task_id=? AND subject_type=? AND subject_id=? AND subject_version=? AND settings_revision=?")
        .get(input.taskId,input.subjectType,input.subjectId,input.subjectVersion,input.settingsRevision);
      if(old)return String(old["id"]);
      const id=randomUUID(),now=new Date().toISOString();
      // One open item per subject, whichever task raised it: a newer request supersedes the
      // older one, and an older task that only existed to wait on it is cancelled with it.
      const stale=this.db.prepare("SELECT id,task_id FROM attention_items WHERE subject_type=? AND subject_id=? AND state='open'").all(input.subjectType,input.subjectId);
      for(const item of stale){
        this.db.prepare("UPDATE attention_items SET state='superseded',version=version+1,updated_at=? WHERE id=?").run(now,String(item["id"]));
        if(item["task_id"]!==input.taskId)this.db.prepare("UPDATE tasks SET state='cancelled',updated_at=? WHERE id=? AND state='waiting_review'").run(now,String(item["task_id"]));
      }
      this.db.prepare(`INSERT INTO attention_items(id,task_id,run_id,artifact_hash,subject_type,subject_id,subject_version,title,detail,context_json,settings_revision,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.taskId,input.runId??null,input.artifactHash??null,input.subjectType,input.subjectId,input.subjectVersion,input.title,input.detail,JSON.stringify(input.context),input.settingsRevision,now,now);
      event(this.db,"review.requested","attention",id,{taskId:input.taskId,subjectVersion:input.subjectVersion});return id;
    });
  }
  /** The open item for this exact subject version, so a workflow can avoid raising it twice. */
  openItem(subjectType:string,subjectId:string,subjectVersion:string):{id:string;taskId:string}|null{
    const row=this.db.prepare("SELECT id,task_id FROM attention_items WHERE subject_type=? AND subject_id=? AND subject_version=? AND state='open' LIMIT 1").get(subjectType,subjectId,subjectVersion);
    return row?{id:String(row["id"]),taskId:String(row["task_id"])}:null;
  }
  decide(id:string,input:{expectedVersion:number;expectedSettingsRevision:number;decision:"approve"|"deny"|"request_changes";reason:string}):{decisionId:string}{
    return transaction(this.db,()=>{
      const row=this.db.prepare("SELECT * FROM attention_items WHERE id=?").get(id);
      if(!row)throw new AppError("review_missing","Review item not found",404);
      const current=Number(this.db.prepare("SELECT max(revision) AS revision FROM settings_revisions").get()!["revision"]);
      const task=this.db.prepare("SELECT state FROM tasks WHERE id=?").get(String(row["task_id"]));
      if(row["state"]!=="open"||row["version"]!==input.expectedVersion||current!==input.expectedSettingsRevision||row["settings_revision"]!==current||task?.["state"]!=="waiting_review")
        throw new AppError("review_conflict","Review inputs, task or settings changed; refresh and request a current review",409);
      const decisionId=randomUUID(),now=new Date().toISOString();
      this.db.prepare(`INSERT INTO review_decisions(id,subject_type,subject_id,subject_version,decision,reason,before_json,after_json,settings_revision,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(decisionId,String(row["subject_type"]),String(row["subject_id"]),String(row["subject_version"]),input.decision,input.reason,
          String(row["context_json"]),JSON.stringify({decision:input.decision,reason:input.reason}),current,now);
      this.db.prepare("UPDATE attention_items SET state='resolved',version=version+1,decision_id=?,updated_at=? WHERE id=?").run(decisionId,now,id);
      event(this.db,"review.decided","attention",id,{decisionId,decision:input.decision,taskId:row["task_id"]});
      // Workflow-specific consumers apply decisions later; a generic approval never dispatches work.
      return {decisionId};
    });
  }
}
