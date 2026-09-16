import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./database.js";
import { event } from "./events.js";
import { AppError } from "./errors.js";
import type { Settings } from "./settings.js";

export type SchedulerLease={owner:string;generation:number;expiresAt:number};
export type TaskLease={taskId:string;owner:string;schedulerGeneration:number;fence:number};
export type TaskState="queued"|"running"|"waiting_review"|"blocked"|"succeeded"|"failed"|"cancelled"|"submitting"|"unknown";
export type Task={id:string;kind:string;effectClass:"preparation"|"submission";state:TaskState;input:unknown;result:unknown;error:unknown;attempt:number;maxAttempts:number;fence:number;leaseOwner:string|null;schedulerGeneration:number|null;leaseExpiresAt:number|null;settingsRevision:number};
function ttl(value:number):void{if(!Number.isSafeInteger(value)||value<1||value>300000)throw new AppError("invalid_lease","Lease duration must be 1–300000 milliseconds");}
export class TaskQueue {
  constructor(readonly db:DatabaseSync){}
  enqueue(input:{id?:string;kind:string;effectClass?:"preparation"|"submission";input:unknown;settingsRevision:number;parentTaskId?:string;maxAttempts?:number},now=Date.now()):Task{
    const id=input.id??randomUUID(),data=JSON.stringify(input.input),effect=input.effectClass??"preparation",max=input.maxAttempts??2;
    if(!input.kind||!Number.isSafeInteger(max)||max<1||max>20||data===undefined)throw new AppError("invalid_task","Task kind, JSON input, and a retry budget of 1–20 are required");
    return transaction(this.db,()=>{
      const existing=this.get(id);
      if(existing){
        const row=this.db.prepare("SELECT parent_task_id FROM tasks WHERE id=?").get(id)!;
        if(existing.maxAttempts!==max||row["parent_task_id"]!==(input.parentTaskId??null)||existing.kind!==input.kind||existing.effectClass!==effect||JSON.stringify(existing.input)!==data||existing.settingsRevision!==input.settingsRevision)throw new AppError("task_conflict","Task ID already belongs to different inputs",409);
        return existing;
      }
      const time=new Date(now).toISOString();
      this.db.prepare(`INSERT INTO tasks(id,kind,effect_class,state,parent_task_id,settings_revision,input_json,max_attempts,available_at,created_at,updated_at)
        VALUES(?,?,?,'queued',?,?,?,?,?,?,?)`).run(id,input.kind,effect,input.parentTaskId??null,input.settingsRevision,data,max,now,time,time);
      event(this.db,"task.queued","task",id,{effectClass:effect,settingsRevision:input.settingsRevision},now);
      return this.get(id)!;
    });
  }
  get(id:string):Task|null{
    const r=this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id);if(!r)return null;
    return {id:String(r["id"]),kind:String(r["kind"]),effectClass:r["effect_class"] as Task["effectClass"],state:r["state"] as TaskState,
      input:JSON.parse(String(r["input_json"])),result:r["result_json"]===null?null:JSON.parse(String(r["result_json"])),
      error:r["error_json"]===null?null:JSON.parse(String(r["error_json"])),attempt:Number(r["attempt"]),maxAttempts:Number(r["max_attempts"]),
      fence:Number(r["fence"]),leaseOwner:r["lease_owner"]===null?null:String(r["lease_owner"]),
      schedulerGeneration:r["scheduler_generation"]===null?null:Number(r["scheduler_generation"]),
      leaseExpiresAt:r["lease_expires_at"]===null?null:Number(r["lease_expires_at"]),settingsRevision:Number(r["settings_revision"])};
  }
  acquireScheduler(owner:string,duration=30000,now=Date.now()):SchedulerLease|null{
    ttl(duration);if(!owner)throw new AppError("invalid_lease","Scheduler owner is required");
    return transaction(this.db,()=>{
      const old=this.db.prepare("SELECT * FROM scheduler_lock WHERE name='main'").get();
      if(old&&Number(old["lease_expires_at"])>now)return null;
      const generation=old?Number(old["generation"])+1:1;
      const lease={owner,generation,expiresAt:now+duration};
      this.db.prepare("INSERT INTO scheduler_lock VALUES('main',?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,generation=excluded.generation,lease_expires_at=excluded.lease_expires_at")
        .run(owner,generation,lease.expiresAt);
      return lease;
    });
  }
  #scheduler(lease:{owner:string;generation:number},now:number):void{
    if(!this.db.prepare("SELECT 1 FROM scheduler_lock WHERE name='main' AND owner=? AND generation=? AND lease_expires_at>?").get(lease.owner,lease.generation,now))throw new AppError("stale_scheduler","Scheduler ownership expired or changed",409);
  }
  renewScheduler(lease:SchedulerLease,duration=30000,now=Date.now()):SchedulerLease{
    ttl(duration);return transaction(this.db,()=>{this.#scheduler(lease,now);this.db.prepare("UPDATE scheduler_lock SET lease_expires_at=? WHERE name='main'").run(now+duration);return {...lease,expiresAt:now+duration};});
  }
  #enabled():boolean{
    const row=this.db.prepare("SELECT value_json FROM settings_revisions ORDER BY revision DESC LIMIT 1").get();
    const settings=JSON.parse(String(row?.["value_json"])) as Settings;
    return settings.enabled===true&&settings.paused===false;
  }
  claim(scheduler:SchedulerLease,duration=30000,now=Date.now()):{task:Task;lease:TaskLease}|null{
    ttl(duration);return transaction(this.db,()=>{
      this.#scheduler(scheduler,now);if(!this.#enabled())return null;
      const row=this.db.prepare("SELECT id FROM tasks WHERE state='queued' AND available_at<=? AND attempt<max_attempts ORDER BY available_at,created_at,id LIMIT 1").get(now);
      if(!row)return null;
      const id=String(row["id"]);
      this.db.prepare("UPDATE tasks SET state='running',attempt=attempt+1,fence=fence+1,lease_owner=?,scheduler_generation=?,lease_expires_at=?,updated_at=? WHERE id=?")
        .run(scheduler.owner,scheduler.generation,now+duration,new Date(now).toISOString(),id);
      const task=this.get(id)!;
      event(this.db,"task.claimed","task",id,{owner:scheduler.owner,generation:scheduler.generation,fence:task.fence,attempt:task.attempt},now);
      return {task,lease:{taskId:id,owner:scheduler.owner,schedulerGeneration:scheduler.generation,fence:task.fence}};
    });
  }
  #leased(lease:TaskLease,now:number):Task{
    this.#scheduler({owner:lease.owner,generation:lease.schedulerGeneration},now);
    const task=this.get(lease.taskId);
    if(!task||task.leaseOwner!==lease.owner||task.schedulerGeneration!==lease.schedulerGeneration||task.fence!==lease.fence||
        task.leaseExpiresAt===null||task.leaseExpiresAt<=now||!["running","submitting"].includes(task.state))throw new AppError("stale_task","Task lease expired, was cancelled, or was replaced",409);
    return task;
  }
  heartbeat(lease:TaskLease,duration=30000,now=Date.now()):void{
    ttl(duration);transaction(this.db,()=>{this.#leased(lease,now);this.db.prepare("UPDATE tasks SET lease_expires_at=?,updated_at=? WHERE id=?").run(now+duration,new Date(now).toISOString(),lease.taskId);});
  }
  markSubmitting(lease:TaskLease,now=Date.now()):void{
    transaction(this.db,()=>{
      const task=this.#leased(lease,now);
      if(task.effectClass!=="submission"||task.state!=="running"||!this.#enabled())throw new AppError("submission_blocked","Submission task is not eligible for a send intent",409);
      // This durable state is necessary, not sufficient: adapter policy, evidence,
      // reviews and caps must also pass in the submitting workflow (step 10).
      this.db.prepare("UPDATE tasks SET state='submitting',updated_at=? WHERE id=?").run(new Date(now).toISOString(),task.id);
      event(this.db,"task.send_intent","task",task.id,{fence:lease.fence},now);
    });
  }
  #finish(lease:TaskLease,state:TaskState,result:unknown,error:unknown,now:number):void{
    this.db.prepare("UPDATE tasks SET state=?,result_json=?,error_json=?,lease_owner=NULL,scheduler_generation=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?")
      .run(state,result===null?null:JSON.stringify(result),error===null?null:JSON.stringify(error),new Date(now).toISOString(),lease.taskId);
    event(this.db,`task.${state}`,"task",lease.taskId,{fence:lease.fence,error},now);
  }
  complete(lease:TaskLease,result:unknown,now=Date.now()):void{
    transaction(this.db,()=>{const task=this.#leased(lease,now);if(task.state!=="running"||task.effectClass==="submission")throw new AppError("submission_requires_resolution","Use explicit submission outcome reconciliation",409);this.#finish(lease,"succeeded",result,null,now);});
  }
  resolveSubmission(lease:TaskLease,outcome:"submitted"|"rejected"|"unknown",evidence:unknown,now=Date.now()):void{
    transaction(this.db,()=>{const task=this.#leased(lease,now);if(task.state!=="submitting")throw new AppError("invalid_transition","No active send intent",409);this.#finish(lease,outcome==="submitted"?"succeeded":outcome==="rejected"?"failed":"unknown",evidence,null,now);});
  }
  fail(lease:TaskLease,error:{code:string;message:string},now=Date.now()):void{
    transaction(this.db,()=>{const task=this.#leased(lease,now);this.#finish(lease,task.state==="submitting"?"unknown":"failed",null,error,now);});
  }
  recoverExpired(scheduler:SchedulerLease,now=Date.now()):string[]{
    return transaction(this.db,()=>{
      this.#scheduler(scheduler,now);
      const rows=this.db.prepare("SELECT id,effect_class FROM tasks WHERE state IN('running','submitting') AND (lease_expires_at<=? OR scheduler_generation!=? OR lease_owner!=?)").all(now,scheduler.generation,scheduler.owner);
      for(const row of rows){
        const state=row["effect_class"]==="submission"?"unknown":"blocked";
        this.db.prepare("UPDATE tasks SET state=?,fence=fence+1,lease_owner=NULL,scheduler_generation=NULL,lease_expires_at=NULL,error_json=?,updated_at=? WHERE id=?")
          .run(state,JSON.stringify({code:"reconciliation_required",message:"Previous worker lost ownership; reconcile child and external effects before retry"}),new Date(now).toISOString(),String(row["id"]));
        event(this.db,"task.recovery_required","task",String(row["id"]),{state},now);
      }
      return rows.map(row=>String(row["id"]));
    });
  }
  retry(id:string,reason:string,now=Date.now()):void{
    transaction(this.db,()=>{
      const task=this.get(id);
      if(!task||task.effectClass!=="preparation"||!["blocked","failed"].includes(task.state)||task.attempt>=task.maxAttempts||!reason.trim())throw new AppError("retry_blocked","Task is not an eligible preparation retry",409);
      if(this.db.prepare("SELECT 1 FROM agent_runs WHERE task_id=? AND state NOT IN('exited','cancelled') LIMIT 1").get(id))throw new AppError("child_unreconciled","A child run is still active or unresolved",409);
      this.db.prepare("UPDATE tasks SET state='queued',available_at=?,updated_at=? WHERE id=?").run(now,new Date(now).toISOString(),id);
      event(this.db,"task.retry_requested","task",id,{reason},now);
    });
  }
  cancel(id:string,reason:string,now=Date.now()):void{
    transaction(this.db,()=>{
      const task=this.get(id);if(!task)throw new AppError("task_missing","Unknown task",404);
      if(["succeeded","cancelled","unknown"].includes(task.state))throw new AppError("invalid_transition","Task is already terminal or needs submission reconciliation",409);
      const state=task.state==="submitting"?"unknown":"cancelled";
      this.db.prepare("UPDATE tasks SET state=?,fence=fence+1,lease_owner=NULL,scheduler_generation=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?").run(state,new Date(now).toISOString(),id);
      event(this.db,"task.cancel_requested","task",id,{reason,state,childCleanup:"must be reconciled by the spawner worker"},now);
    });
  }
}
