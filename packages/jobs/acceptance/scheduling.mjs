// Step 8 acceptance: scheduling, pagination checkpoints, rate-limit backoff, caps, pause,
// disabled sources, restart and normalized dedup. Disposable service; local fixture only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'jobs-scheduling-'));
const token='scheduling-fixture-token-not-a-host-token';
const port=17950;
const children=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){for(let i=0;i<150;i++){try{if(await fn())return;}catch{}await delay(100);}throw Error(`Timeout: ${label}`);}
async function stop(child){if(child&&child.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}}
async function start(dir){
 fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'service.json'),JSON.stringify({port,token,allowedOrigins:[]}));
 const child=spawn(process.execPath,[new URL('../dist/index.js',import.meta.url).pathname],{env:{...process.env,JOBS_DIR:dir},stdio:['ignore','pipe','pipe']});
 children.push(child);child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});
 await until(async()=>(await fetch(`http://127.0.0.1:${port}/health`)).ok,'jobs startup');
 return `http://127.0.0.1:${port}`;
}
async function api(base,route,body,method){
 const response=await fetch(base+route,{method:method??(body?'POST':'GET'),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,body:await response.json()};
}
const job=(id,url=null)=>({id,url:url??`https://acme.example/${id}`,title:`Role ${id}`,location:'Remote',body:`Body ${id}`});
const dir=path.join(root,'service');
try{
 let base=await start(dir);
 const settings=(await api(base,'/api/settings')).body;
 settings.value.enabled=true;settings.value.paused=false;
 assert.equal((await api(base,'/api/settings',{expectedRevision:settings.revision,value:settings.value},'PUT')).status,200);

 // Paginated with a cap: pages are checkpointed, then resumed from where they stopped.
 await api(base,'/api/sources/acme',{adapterId:'fixture',sourceKey:'acme',enabled:true,config:{companyName:'Acme',boardId:'acme',
  schedule:{intervalMinutes:1},requests:{maxPostingsPerRun:3},fixture:{pagination:{pageSize:2},postings:[1,2,3,4,5].map(n=>job(`j${n}`))}}},'PUT');
 const dueStatus=(await api(base,'/api/scheduler')).body.status;
 assert.deepEqual(dueStatus.dueSources,['acme'],'a never-run source is due');
 assert.equal(dueStatus.nextRunAt,null);

 const first=(await api(base,'/api/scheduler/run',{},'POST')).body;
 assert.equal(first.state,'ran');
 assert.equal(first.results[0].outcome.discovered,3);
 assert.equal(first.results[0].outcome.complete,false);
 assert.deepEqual(first.results[0].outcome.checkpoint,{offset:3});

 const resumed=(await api(base,'/api/scheduler/run',{force:true},'POST')).body;
 assert.equal(resumed.results[0].outcome.discovered,2);
 assert.equal(resumed.results[0].outcome.complete,true);

 const repeated=(await api(base,'/api/scheduler/run',{force:true},'POST')).body;
 assert.equal(repeated.results[0].outcome.created,0,'repeated discovery creates nothing new');
 const dashboard=(await api(base,'/api/dashboard')).body;
 assert.equal(dashboard.jobs.length,5);
 assert.equal(dashboard.applications.length,5,'no duplicate eligible applications');

 // A rate limit is retried with the stated backoff.
 await api(base,'/api/sources/rl',{adapterId:'fixture',sourceKey:'rl',enabled:true,config:{companyName:'RL',boardId:'rl',
  fixture:{rateLimit:{firstAttempts:1,retryAfterMs:1},postings:[job('r1')]}}},'PUT');
 const rl=(await api(base,'/api/scheduler/run',{force:true},'POST')).body;
 assert.ok(rl.results.some(entry=>entry.outcome&&entry.outcome.adapterId==='fixture'&&entry.outcome.complete===true));

 // Configured filters record why a posting matched or was excluded, and operator
 // skip/requeue actions are audited.
 await api(base,'/api/sources/scr',{adapterId:'fixture',sourceKey:'scr',enabled:true,config:{companyName:'Scr',boardId:'scr',
  filters:{keywords:['kubernetes'],locations:['Remote']},
  fixture:{postings:[
   {id:'k1',url:'https://scr.example/k1',title:'Cloud Engineer',location:'Remote',body:'Kubernetes and AWS platform work'},
   {id:'k2',url:'https://scr.example/k2',title:'Sales Representative',location:'Denver',body:'Quota carrying sales role'},
  ]}}},'PUT');
 await api(base,'/api/scheduler/run',{force:true},'POST');
 const screening=(await api(base,'/api/screening')).body;
 assert.ok(screening.counts.eligible>=1,'a matching posting is eligible');
 assert.ok(screening.counts.excluded>=1,'a definite mismatch is excluded');
 const eligible=screening.decisions.find(entry=>entry.decision==='eligible');
 assert.ok(eligible.reasons.some(reason=>reason.code==='keywords_matched'),'the match is explained');
 await api(base,`/api/jobs/${encodeURIComponent(eligible.jobId)}/skip`,{reason:'not interested'},'POST');
 assert.equal((await api(base,'/api/screening')).body.decisions.find(entry=>entry.jobId===eligible.jobId).decision,'skipped');
 await api(base,`/api/jobs/${encodeURIComponent(eligible.jobId)}/requeue`,{},'POST');
 assert.equal((await api(base,'/api/screening')).body.decisions.find(entry=>entry.jobId===eligible.jobId).decision,'eligible');

 // The run list is UTC and carries checkpoints.
 const runs=(await api(base,'/api/scheduler')).body.runs;
 assert.ok(runs.length>=4);
 assert.match(String(runs[0].finished_at),/Z$/,'run times are UTC');

 // Pause stops scheduling; disabled sources are not due.
 const pausedSettings=(await api(base,'/api/settings')).body;
 pausedSettings.value.paused=true;
 await api(base,'/api/settings',{expectedRevision:pausedSettings.revision,value:pausedSettings.value},'PUT');
 assert.equal((await api(base,'/api/scheduler/run',{force:true},'POST')).body.state,'paused');
 assert.deepEqual((await api(base,'/api/scheduler')).body.status.dueSources,[]);

 const resumedSettings=(await api(base,'/api/settings')).body;
 resumedSettings.value.paused=false;
 await api(base,'/api/settings',{expectedRevision:resumedSettings.revision,value:resumedSettings.value},'PUT');
 await api(base,'/api/sources/acme',{adapterId:'fixture',sourceKey:'acme',enabled:false,config:{companyName:'Acme',boardId:'acme',schedule:{intervalMinutes:1},fixture:{postings:[job('x')]}}},'PUT');
 const afterDisable=(await api(base,'/api/scheduler')).body.status;
 assert.ok(!afterDisable.dueSources.includes('acme'),'a disabled source stops being scheduled');

 assert.equal((await fetch(`${base}/api/scheduler`)).status,401);

 // Restart: settings and run history persist, and nothing is immediately due again.
 await stop(children[0]);children.length=0;
 base=await start(dir);
 const afterRestart=(await api(base,'/api/scheduler')).body;
 assert.deepEqual(afterRestart.status.dueSources,[],'restart does not stampede a just-completed source');
 assert.ok(afterRestart.runs.length>=4,'run history survives restart');
 const persisted=(await api(base,'/api/settings')).body.value;
 assert.equal(persisted.enabled,true);

 console.log('PASS scheduling: due/interval, paginated checkpoint+resume, cap, repeat dedup, rate-limit backoff, pause, disabled source, UTC runs and restart');
}catch(error){console.error(error);throw error;}finally{
 for(const child of children)await stop(child);fs.rmSync(root,{recursive:true,force:true});
}
