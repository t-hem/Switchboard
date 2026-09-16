import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { SettingsStore } from "../src/store.js";
import { Reviews } from "../src/reviews.js";
import { TaskQueue } from "../src/queue.js";
import { ArtifactStore } from "../src/artifacts.js";
import { buildServer } from "../src/server.js";
import { DatabaseSync } from "node:sqlite";

function fixture(t: TestContext) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"jobs-reviews-"));
  const store=new SettingsStore(path.join(dir,"jobs.sqlite"));
  let closed=false;
  const close=store.close.bind(store);
  store.close=()=>{if(!closed){closed=true;close();}};
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const queue=new TaskQueue(store.db),reviews=new Reviews(store.db);
  queue.enqueue({id:"task",kind:"assemble",input:{},settingsRevision:1});
  const input={taskId:"task",subjectType:"resume",subjectId:"resume",subjectVersion:"one",title:"Review resume",detail:"Check facts",context:{text:"exact draft"},settingsRevision:1};
  return {dir,store,reviews,input};
}

test("reviews bind immutable inputs, reject repeats and do not dispatch approved work",t=>{
  const {store,reviews,input}=fixture(t);
  assert.throws(()=>reviews.open(input),/waiting for review/);
  store.db.prepare("UPDATE tasks SET state='waiting_review' WHERE id='task'").run();
  assert.throws(()=>reviews.open({...input,runId:"unrelated"}),/does not belong/);
  const id=reviews.open(input);assert.equal(reviews.open(input),id);
  assert.throws(()=>store.db.prepare("UPDATE attention_items SET context_json='{}' WHERE id=?").run(id),/immutable/);
  assert.throws(()=>reviews.decide(id,{expectedVersion:2,expectedSettingsRevision:1,decision:"approve",reason:"wrong version"}),/changed/);
  const result=reviews.decide(id,{expectedVersion:1,expectedSettingsRevision:1,decision:"approve",reason:"checked"});
  assert.equal(store.db.prepare("SELECT before_json FROM review_decisions WHERE id=?").get(result.decisionId)!["before_json"],JSON.stringify(input.context));
  assert.equal(store.db.prepare("SELECT state FROM tasks WHERE id='task'").get()!["state"],"waiting_review");
  assert.throws(()=>reviews.decide(id,{expectedVersion:1,expectedSettingsRevision:1,decision:"deny",reason:"duplicate"}),/changed/);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM review_decisions").get()!["n"],1);
});

test("changed subject, settings and task state invalidate stale reviews; failed audit rolls back",t=>{
  const {store,reviews,input}=fixture(t);
  store.db.prepare("UPDATE tasks SET state='waiting_review' WHERE id='task'").run();
  const old=reviews.open(input),current=reviews.open({...input,subjectVersion:"two"});
  const decision={expectedVersion:1,expectedSettingsRevision:1,decision:"request_changes" as const,reason:"revise"};
  assert.throws(()=>reviews.decide(old,decision),/changed/);
  store.db.exec("CREATE TRIGGER reject_decision_event BEFORE INSERT ON events WHEN NEW.kind='review.decided' BEGIN SELECT RAISE(ABORT,'audit failure'); END");
  assert.throws(()=>reviews.decide(current,decision),/audit failure/);
  assert.equal(store.db.prepare("SELECT state FROM attention_items WHERE id=?").get(current)!["state"],"open");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM review_decisions").get()!["n"],0);
  store.db.exec("DROP TRIGGER reject_decision_event");
  store.db.prepare("UPDATE tasks SET state='cancelled' WHERE id='task'").run();
  assert.throws(()=>reviews.decide(current,decision),/changed/);
  store.db.prepare("UPDATE tasks SET state='waiting_review' WHERE id='task'").run();
  store.update(1,store.current().value);
  assert.throws(()=>reviews.decide(current,{...decision,expectedSettingsRevision:2}),/changed/);
  const fresh=reviews.open({...input,subjectVersion:"two",settingsRevision:2});
  reviews.decide(fresh,{...decision,expectedSettingsRevision:2});
});

test("dashboard APIs authenticate, validate decisions and download inert verified artifacts",async t=>{
  const {dir,store,reviews,input}=fixture(t);
  store.db.prepare("UPDATE tasks SET state='waiting_review' WHERE id='task'").run();
  const artifact=new ArtifactStore(store.db,dir).put(Buffer.from('<script>alert(1)</script>'),"text/html","review");
  const id=reviews.open({...input,artifactHash:artifact.hash});
  const app=buildServer({port:7780,token:"test",allowedOrigins:[]},store,dir);
  const headers={authorization:"Bearer test"};
  for(const url of ["/api/dashboard","/api/diagnostics",`/api/reviews/${id}`,"/api/tasks/task",`/api/artifacts/${artifact.hash}`]){
    assert.equal((await app.inject({url})).statusCode,401);
    assert.equal((await app.inject({url,headers})).statusCode,200);
  }
  const download=await app.inject({url:`/api/artifacts/${artifact.hash}`,headers});
  assert.match(download.headers["content-type"]!,/octet-stream/);
  assert.match(String(download.headers["content-disposition"]),/attachment/);
  assert.equal(download.body,'<script>alert(1)</script>');
  assert.equal((await app.inject({url:`/api/reviews/${id}/decision`,method:"POST",headers,payload:{decision:"approve"}})).statusCode,400);
  const payload={expectedVersion:1,expectedSettingsRevision:1,decision:"deny",reason:"not ready"};
  assert.equal((await app.inject({url:`/api/reviews/${id}/decision`,method:"POST",headers,payload})).statusCode,200);
  assert.equal((await app.inject({url:`/api/reviews/${id}/decision`,method:"POST",headers,payload})).statusCode,409);
  const dashboard=(await app.inject({url:"/api/dashboard",headers})).json();
  assert.equal(dashboard.attention.length,0);assert.equal(dashboard.decisions[0].attention_id,id);
  for(const route of ["agents","jobs","applications","tasks","reviews"]){
    assert.equal((await app.inject({url:`/api/${route}/missing`,headers})).statusCode,404);
  }
  await app.close();
});

test("shipped schema 2 upgrades with existing settings and tasks intact",t=>{
  const {dir,store}=fixture(t);const saved=store.current();store.close();
  const db=new DatabaseSync(path.join(dir,"jobs.sqlite"));
  db.exec("DROP TABLE attention_items; PRAGMA user_version=2");db.close();
  const upgraded=new SettingsStore(path.join(dir,"jobs.sqlite"));
  try{
    assert.deepEqual(upgraded.current(),saved);
    assert.equal(upgraded.db.prepare("PRAGMA user_version").get()!["user_version"],3);
    assert.equal(upgraded.db.prepare("SELECT id FROM tasks").get()!["id"],"task");
    assert.equal(upgraded.db.prepare("SELECT count(*) AS n FROM attention_items").get()!["n"],0);
  }finally{upgraded.close();}
});
