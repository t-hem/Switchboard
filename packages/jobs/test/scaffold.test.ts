import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { buildServer } from "../src/server.js";
import { SettingsStore } from "../src/store.js";
import { ArtifactStore } from "../src/artifacts.js";
import { assertRuntime } from "../src/config.js";
import { createSpawner, SwitchboardSpawner, type AgentSpawner } from "../src/adapters/spawner.js";

const token="test-jobs-token-never-for-host";
const headers={authorization:`Bearer ${token}`};
test("diagnostics reuse a timestamped snapshot until its TTL expires",async(t)=>{
 let now=1_800_000_000_000;
 t.mock.method(Date,"now",()=>now);
 const inspect=t.mock.method(ArtifactStore.prototype,"inspect",()=>({sqlite:["ok"],foreignKeys:[],artifactErrors:[],unreferencedFiles:[],stagingFiles:[]}));
 await fixture(async(app)=>{
  assert.equal((await app.inject({url:"/api/diagnostics"})).statusCode,401);
  assert.equal(inspect.mock.callCount(),0);
  const first=(await app.inject({url:"/api/diagnostics",headers})).json();
  now+=59_999;
  assert.deepEqual((await app.inject({url:"/api/diagnostics",headers})).json(),first);
  assert.equal(inspect.mock.callCount(),1);
  now++;
  const next=(await app.inject({url:"/api/diagnostics",headers})).json();
  assert.notEqual(next.checkedAt,first.checkedAt);
  assert.equal(inspect.mock.callCount(),2);
 });
});
async function fixture(run:(app:ReturnType<typeof buildServer>,dir:string)=>Promise<void>){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"jobs-scaffold-"));
 const app=buildServer({port:7780,token,allowedOrigins:["https://jobs.example.test"]},new SettingsStore(path.join(dir,"jobs.sqlite")),dir);
 try{await run(app,dir);}finally{await app.close();fs.rmSync(dir,{recursive:true,force:true});}
}
test("standalone settings are authenticated, versioned, durable and fail closed",async()=>fixture(async(app,dir)=>{
 assert.equal((await app.inject({url:"/health"})).statusCode,200);
 for(const auth of [undefined,"Bearer wrong"]){
  assert.equal((await app.inject({url:"/api/settings",headers:auth?{authorization:auth}:{}})).statusCode,401);
 }
 const initial=(await app.inject({url:"/api/settings",headers})).json();
 assert.equal(initial.value.enabled,false);assert.equal(initial.value.paused,true);
 assert.ok(Object.values(initial.value.reviewGates).every(Boolean));
 for(const mutate of [(s:Record<string,unknown>)=>{s["enabled"]="yes";},(s:Record<string,unknown>)=>{s["secret"]="never accept";},(s:Record<string,unknown>)=>{s["schemaVersion"]=2;}]){
  const value=structuredClone(initial.value);mutate(value);
  const result=await app.inject({method:"PUT",url:"/api/settings",headers,payload:{expectedRevision:1,value}});
  assert.equal(result.statusCode,400);assert.ok(result.json().error.fields.length);
  assert.equal((await app.inject({url:"/api/settings",headers})).json().revision,1);
 }
 const next={...initial.value,enabled:true,paused:false};
 const saved=await app.inject({method:"PUT",url:"/api/settings",headers,payload:{expectedRevision:1,value:next}});
 assert.equal(saved.statusCode,200);assert.equal(saved.json().revision,2);
 assert.equal((await app.inject({method:"PUT",url:"/api/settings",headers,payload:{expectedRevision:1,value:initial.value}})).statusCode,409);
 const status=(await app.inject({url:"/api/status",headers})).json();
 // Enabling jobs makes discovery available; with no enabled source there is nothing due.
 assert.equal(status.scheduler.state,"idle");assert.equal(status.scheduler.dispatchAvailable,true);
 assert.deepEqual(status.scheduler.dueSources,[]);
 assert.equal(status.capabilities.agents,false);
 // Reopen with another connection: no host process or settings cache is required.
 const reopened=new SettingsStore(path.join(dir,"jobs.sqlite"));
 assert.deepEqual(reopened.current().value,next);reopened.close();
}));
test("origins are explicit and credentials never appear in settings/status",async()=>fixture(async(app)=>{
 assert.equal((await app.inject({url:"/api/settings",headers:{...headers,origin:"https://untrusted.example"}})).statusCode,403);
 const allowed=await app.inject({url:"/api/settings",headers:{...headers,origin:"https://jobs.example.test"}});
 assert.equal(allowed.headers["access-control-allow-origin"],"https://jobs.example.test");
 assert.ok(!allowed.body.includes(token));
 const saved=allowed.json();saved.value.spawner.baseUrl="https://user:secret@example.test";
 assert.equal((await app.inject({method:"PUT",url:"/api/settings",headers,payload:{expectedRevision:1,value:saved.value}})).statusCode,400);
}));
test("unknown database versions are refused without changing schema",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"jobs-future-"));const file=path.join(dir,"future.sqlite");
 try{
  const db=new DatabaseSync(file);db.exec("PRAGMA user_version=99");db.close();
  const before=fs.readFileSync(file);assert.throws(()=>new SettingsStore(file),/Unsupported/);assert.deepEqual(fs.readFileSync(file),before);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test("jobs platform/runtime guard leaves the host's platform support independent",()=>{
 assert.throws(()=>assertRuntime("win32","22.23.2"),/Linux-only/);
 assert.throws(()=>assertRuntime("linux","22.10.0"),/22.23/);
 assertRuntime("linux","22.23.2");
});
const session={id:"one",state:"running" as const,label:"fixture"};
const fake:AgentSpawner={provider:"alternative",health:async()=>({available:true}),list:async()=>[session],inspect:async id=>id==="one"?session:null};
for(const provider of ["switchboard","alternative"]){
 test(`${provider} satisfies the same spawner observation contract`,async()=>{
  let calls=0;
  const options={baseUrl:"http://fixture.invalid",token:"private"};
  const fixtureFetch:typeof fetch=async(url,init)=>{
   calls++;assert.equal((init?.headers as Record<string,string>)["Authorization"],"Bearer private");
   const route=new URL(String(url)).pathname;
   if(route==="/health")return Response.json({sessionCount:1});
   if(route==="/sessions")return Response.json([{id:"one",status:"running",label:"fixture"}]);
   return route.endsWith("/one")?Response.json({id:"one",status:"running",label:"fixture"}):new Response("",{status:404});
  };
  const adapter=createSpawner(provider,options,{switchboard:opts=>new SwitchboardSpawner(opts,fixtureFetch),alternative:()=>fake});
  assert.equal(calls,0,"constructing an integration performs no background request");
  assert.deepEqual(await adapter.health(),{available:true});assert.deepEqual(await adapter.list(),[session]);
  assert.deepEqual(await adapter.inspect("one"),session);assert.equal(await adapter.inspect("missing"),null);
 });
}
test("unknown providers and aborted external requests fail visibly",async()=>{
 assert.throws(()=>createSpawner("missing",{baseUrl:"http://localhost",token:"secret"}),/Unknown/);
 const adapter=new SwitchboardSpawner({baseUrl:"http://localhost",token:"secret"},async()=>{throw Error("do not expose request credentials");});
 await assert.rejects(adapter.list(),/failed or was cancelled/);
});
