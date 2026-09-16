import type { FastifyInstance } from "fastify";
import type { SettingsStore } from "./store.js";
import { ArtifactStore } from "./artifacts.js";
import { Reviews } from "./reviews.js";
import { AppError } from "./errors.js";
import { SCHEMA_VERSION } from "./database.js";

export function dashboardRoutes(app:FastifyInstance,store:SettingsStore,dir:string):void{
  const db=store.db,artifacts=new ArtifactStore(db,dir,{readOnly:true}),reviews=new Reviews(db);
  app.get("/api/dashboard",async()=>({schemaVersion:SCHEMA_VERSION,limit:100,
    counts:Object.fromEntries(["jobs","applications","tasks","agent_runs","artifacts","resume_versions"].map(table=>[table,Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!["n"])])),
    attention:db.prepare("SELECT id,title,detail,state,version,settings_revision,task_id,run_id,artifact_hash,created_at FROM attention_items WHERE state='open' ORDER BY created_at LIMIT 100").all(),
    decisions:db.prepare("SELECT a.id AS attention_id,d.id,d.subject_type,d.subject_id,d.decision,d.reason,d.created_at FROM review_decisions d LEFT JOIN attention_items a ON a.decision_id=d.id ORDER BY d.created_at DESC LIMIT 100").all(),
    tasks:db.prepare("SELECT id,kind,state,attempt,max_attempts,updated_at FROM tasks ORDER BY updated_at DESC LIMIT 100").all(),
    agents:db.prepare("SELECT id,task_id,state,agent,model,spawner_provider,spawner_instance,spawner_session_id,created_at,finished_at FROM agent_runs ORDER BY created_at DESC LIMIT 100").all(),
    jobs:db.prepare("SELECT id,company,title,location,canonical_url,last_seen_at FROM jobs ORDER BY last_seen_at DESC LIMIT 100").all(),
    searchRuns:db.prepare("SELECT r.id,r.source_id,s.source_key,s.adapter_id,r.state,r.created_at,r.finished_at,r.error_json FROM search_runs r JOIN sources s ON s.id=r.source_id ORDER BY r.created_at DESC LIMIT 100").all(),
    resumes:db.prepare("SELECT id,job_snapshot_id,profile_revision_id,template_revision_id,phase,text_artifact_hash,pdf_artifact_hash,created_at FROM resume_versions ORDER BY created_at DESC LIMIT 100").all(),
    snapshots:db.prepare("SELECT s.id,s.job_id,s.purpose,s.completeness,s.captured_at,j.title,j.company FROM job_snapshots s JOIN jobs j ON j.id=s.job_id ORDER BY s.captured_at DESC LIMIT 100").all(),
    applications:db.prepare("SELECT a.id,a.job_id,a.state,a.block_reason,j.company,j.title,a.updated_at FROM applications a JOIN jobs j ON j.id=a.job_id ORDER BY a.updated_at DESC LIMIT 100").all()
  }));
  // Full verification is expensive; repeated HTTP requests share one snapshot.
  // Explicit offline inspection remains uncached for repair/backup verification.
  let diagnostics: ReturnType<ArtifactStore["inspect"]> | undefined;
  let checkedAt = 0;
  app.get("/api/diagnostics",async()=>{
    if (!diagnostics || Date.now() - checkedAt >= 60_000) {
      diagnostics = artifacts.inspect();
      checkedAt = Date.now();
    }
    return {...diagnostics, checkedAt:new Date(checkedAt).toISOString(), cacheTtlMs:60_000};
  });
  app.get<{Params:{id:string}}>("/api/tasks/:id",async(req)=>{
    const task=db.prepare("SELECT * FROM tasks WHERE id=?").get(req.params.id);
    if(!task)throw new AppError("task_missing","Task not found",404);
    return {task,runs:db.prepare("SELECT * FROM agent_runs WHERE task_id=? ORDER BY attempt").all(req.params.id),
      events:db.prepare("SELECT * FROM events WHERE subject_type='task' AND subject_id=? ORDER BY id DESC LIMIT 100").all(req.params.id),
      reviews:db.prepare("SELECT * FROM attention_items WHERE task_id=? ORDER BY created_at DESC").all(req.params.id)};
  });
  app.get<{Params:{id:string}}>("/api/reviews/:id",async(req)=>{
    const row=db.prepare("SELECT * FROM attention_items WHERE id=?").get(req.params.id);
    if(!row)throw new AppError("review_missing","Review item not found",404);
    return {item:row,decision:row["decision_id"]?db.prepare("SELECT * FROM review_decisions WHERE id=?").get(String(row["decision_id"])):null};
  });
  app.get<{Params:{id:string}}>("/api/agents/:id",async(req)=>{
    const run=db.prepare("SELECT * FROM agent_runs WHERE id=?").get(req.params.id);
    if(!run)throw new AppError("run_missing","Agent run not found",404);
    return {run,tools:db.prepare("SELECT * FROM tool_events WHERE run_id=? ORDER BY sequence DESC LIMIT 100").all(req.params.id),
      messages:db.prepare("SELECT * FROM run_messages WHERE run_id=? ORDER BY sequence DESC LIMIT 100").all(req.params.id)};
  });
  app.get<{Params:{id:string}}>("/api/jobs/:id",async(req)=>{
    const job=db.prepare("SELECT * FROM jobs WHERE id=?").get(req.params.id);
    if(!job)throw new AppError("job_missing","Job not found",404);
    return {job,snapshots:db.prepare("SELECT * FROM job_snapshots WHERE job_id=? ORDER BY captured_at DESC LIMIT 100").all(req.params.id),
      aliases:db.prepare("SELECT a.source_id,a.external_id,a.original_url,s.adapter_id,s.source_key FROM job_aliases a JOIN sources s ON s.id=a.source_id WHERE a.job_id=?").all(req.params.id)};
  });
  app.get<{Params:{id:string}}>("/api/applications/:id",async(req)=>{
    const application=db.prepare("SELECT * FROM applications WHERE id=?").get(req.params.id);
    if(!application)throw new AppError("application_missing","Application not found",404);
    return {application,attempts:db.prepare("SELECT * FROM application_attempts WHERE application_id=? ORDER BY created_at DESC LIMIT 100").all(req.params.id),
      resume:application["selected_resume_id"]?db.prepare("SELECT * FROM resume_versions WHERE id=?").get(String(application["selected_resume_id"])):null};
  });
  app.post<{Params:{id:string};Body:{expectedVersion:number;expectedSettingsRevision:number;decision:"approve"|"deny"|"request_changes";reason:string}}>("/api/reviews/:id/decision",{schema:{body:{type:"object",additionalProperties:false,required:["expectedVersion","expectedSettingsRevision","decision","reason"],properties:{expectedVersion:{type:"integer",minimum:1},expectedSettingsRevision:{type:"integer",minimum:1},decision:{enum:["approve","deny","request_changes"]},reason:{type:"string",maxLength:10000}}}}},async(req)=>reviews.decide(req.params.id,req.body));
  app.get<{Params:{hash:string}}>("/api/artifacts/:hash",async(req,reply)=>{
    const bytes=artifacts.read(req.params.hash);
    // Archived HTML and other untrusted bytes must download, never execute in the app origin.
    return reply.type("application/octet-stream").header("Content-Disposition",`attachment; filename="${req.params.hash}"`).send(bytes);
  });
}
