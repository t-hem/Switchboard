// Step 11 acceptance: records, offline export/reconstruct, health, repair and read-only restore.
// Disposable service; no browser needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';

const here=new URL('.',import.meta.url).pathname;
const root=fs.mkdtempSync(path.join(os.tmpdir(),'jobs-records-'));
const token='records-fixture-token-not-a-host-token';
const port=17975;
const children=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){for(let i=0;i<200;i++){try{if(await fn())return;}catch{}await delay(100);}throw Error(`Timeout: ${label}`);}
async function stop(child){if(child&&child.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}}
async function api(base,route,body,method){
 const response=await fetch(base+route,{method:method??(body?'POST':'GET'),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,body:await response.json()};
}
const dir=path.join(root,'service');
const startService=(dataDir,port)=>spawn(process.execPath,[path.join(here,'../dist/index.js')],{env:{...process.env,JOBS_DIR:dataDir,PORT:String(port)},stdio:['ignore','pipe','pipe']});
try{
 fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'service.json'),JSON.stringify({port,token,allowedOrigins:[]}));
 // A fake Switchboard host: nothing in this step may touch unrelated sessions.
 const hostHits=[];
 const host=http.createServer((request,response)=>{hostHits.push(`${request.method} ${request.url}`);response.writeHead(200,{'Content-Type':'application/json'});response.end('{}');});
 await new Promise(resolve=>host.listen(0,'127.0.0.1',resolve));
 const hostUrl=`http://127.0.0.1:${host.address().port}`;

 // Seed an application with two resume passes, a persona run, tool results, a decision and a receipt.
 const {SettingsStore}=await import('../dist/store.js');
 const {ArtifactStore}=await import('../dist/artifacts.js');
 const {Postings}=await import('../dist/postings.js');
 const {Library}=await import('../dist/library.js');
 const {TaskQueue}=await import('../dist/queue.js');
 const {event}=await import('../dist/events.js');
 const store=new SettingsStore(path.join(dir,'jobs.sqlite'));
 const artifacts=new ArtifactStore(store.db,dir);
 const postings=new Postings(store.db,artifacts);
 const library=new Library(store.db);
 const {jobId}=postings.ingest({adapterId:'fixture',company:'Acme',title:'Engineer',originalUrl:'https://acme.example/1',descriptionText:'Posting body text',provenance:'browser'});
 const snapshotId=postings.recordSnapshot({jobId,purpose:'discovery',fetchedUrl:'u',finalUrl:'u',descriptionText:'Posting body text',screenshot:Buffer.from('png'),captureVersion:'browser:1',capture:{},completeness:'complete'}).snapshotId;
 const profile=library.addProfile({profileId:'primary',data:{contact:{name:'Ada'},facts:[],suggestions:[]}});
 const template=library.addTemplate({templateId:'base',data:{name:'Base',sections:[{id:'summary',title:'Summary',type:'facts',factKeys:['summary'],optional:true}]}});
 const applicationId=String(store.db.prepare('SELECT id FROM applications WHERE job_id=?').get(jobId).id);
 const task=new TaskQueue(store.db).enqueue({kind:'resume:tailor',input:{jobId},settingsRevision:store.current().revision});
 const runId=randomUUID();
 store.db.prepare(`INSERT INTO agent_runs(id,task_id,attempt,state,spawner_provider,spawner_instance,spawner_session_id,process_identity,parent_run_id,run_directory,deadline_at,created_at,finished_at,
  persona_text,skills_json,prompt_text,agent,model,tools_json,permissions_json,revision_hashes_json,settings_revision,outcome_json)
  VALUES(?,?,1,'exited','switchboard','inst-1','sess-1',NULL,NULL,?,?,?,?,'You are the resume assembler.','["bullet-selection"]','Tailor the resume.','claude','deepseek-v4.1-flash','["draft.write"]','{"mode":"restricted"}','{"persona":"abc"}',?,'{"pass":"build"}')`)
  .run(runId,task.id,path.join(dir,'runs',runId),Date.now()+60000,new Date().toISOString(),new Date().toISOString(),store.current().revision);
 store.db.prepare("INSERT INTO tool_events(run_id,sequence,call_id,tool_id,tool_version,request_json,result_json,state,occurred_at) VALUES(?,1,'c1','draft.write','1','{\"field\":\"summary\"}','{\"ok\":true}','succeeded',?)").run(runId,new Date().toISOString());
 const buildHash=artifacts.put(Buffer.from('BUILD RESUME','utf8'),'text/plain','resume-text').hash;
 const editHash=artifacts.put(Buffer.from('EDITED RESUME','utf8'),'text/plain','resume-text').hash;
 const receiptHash=artifacts.put(Buffer.from('Confirmation REF-9','utf8'),'text/plain','application-receipt').hash;
 const addResume=(id,phase,parent,hash)=>store.db.prepare(`INSERT INTO resume_versions(id,job_snapshot_id,profile_revision_id,template_revision_id,parent_resume_id,agent_run_id,phase,source_json,selected_bullets_json,edits_json,text_artifact_hash,pdf_artifact_hash,created_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?)`).run(id,snapshotId,profile.id,template.id,parent,runId,phase,'{"source":"profile"}','["b1"]',phase==='edit'?'{"tightened":true}':'{}',hash,new Date().toISOString());
 addResume('resume-build','build',null,buildHash);addResume('resume-edit','edit','resume-build',editHash);
 store.db.prepare('UPDATE applications SET selected_resume_id=? WHERE id=?').run('resume-edit',applicationId);
 const policyId=String(store.db.prepare(`INSERT INTO source_policies(id,scope_key,revision,adapter_id,site_url,terms_url,reviewed_at,capabilities_json,restrictions_json,created_at)
  VALUES(?,?,'1','fixture-form','https://forms.example',NULL,NULL,?,? ,?) RETURNING id`).get(randomUUID(),'fixture-form:forms.example','{"prepare":true,"fill":true,"upload":true,"submit":true}','{}',new Date().toISOString()).id);
 const attemptId=randomUUID();
 store.db.prepare(`INSERT INTO application_attempts(id,application_id,idempotency_key,adapter_id,state,snapshot_id,resume_id,settings_revision,policy_id,manifest_json,preflight_at,send_started_at,finished_at,outcome_json,receipt_hash,created_at)
  VALUES(?,?,?,'fixture-form','submitted',?,?,?,?,?,?,?,?,?,?,?)`).run(attemptId,applicationId,randomUUID(),snapshotId,'resume-edit',store.current().revision,policyId,
  JSON.stringify({manifestHash:'a'.repeat(64),formUrl:'https://forms.example/apply',snapshotId,resumeTextHash:editHash,answers:{name:'Ada'}}),
  new Date().toISOString(),new Date().toISOString(),new Date().toISOString(),JSON.stringify({outcome:'submitted',observedBy:'service',externalId:'REF-9'}),receiptHash,new Date().toISOString());
 store.db.prepare(`INSERT INTO review_decisions(id,subject_type,subject_id,subject_version,decision,reason,before_json,after_json,settings_revision,created_at)
  VALUES(?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),'application-attempt',attemptId,'a'.repeat(64),'approve','reviewed','{}','{}',store.current().revision,new Date().toISOString());
 // A stale lease and an interrupted submission, for the repair path.
 const stale= new TaskQueue(store.db).enqueue({kind:'discovery:run',input:{},settingsRevision:store.current().revision});
 store.db.prepare("UPDATE tasks SET state='running', lease_owner='worker', lease_expires_at=? WHERE id=?").run(Date.now()-1000,stale.id);
 const interrupted=new TaskQueue(store.db).enqueue({kind:'application:submit',effectClass:'submission',input:{},settingsRevision:store.current().revision});
 store.db.prepare("UPDATE tasks SET state='submitting', lease_owner='worker', lease_expires_at=?, updated_at=? WHERE id=?").run(Date.now()+60000,new Date(Date.now()-3600000).toISOString(),interrupted.id);
 event(store.db,'archive.backup','database','main',{destination:'fixture'});
 store.close();

 const child=startService(dir,port);
 children.push(child);child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});
 const base=`http://127.0.0.1:${port}`;
 await until(async()=>(await fetch(`${base}/health`)).ok,'jobs startup');
 const settings=(await api(base,'/api/settings')).body;
 await api(base,'/api/settings',{expectedRevision:settings.revision,value:{...settings.value,enabled:true,paused:false,mode:'review',spawner:{...settings.value.spawner,baseUrl:hostUrl}}},'PUT');

 // The record has both resume passes, the persona, tool results, the decision and the receipt.
 const record=(await api(base,`/api/applications/${applicationId}/record`)).body;
 assert.deepEqual(record.resumes.map(r=>r.phase),['build','edit']);
 assert.equal(record.resumes[1].parent.phase,'build');
 assert.equal(record.resumes[1].text,'EDITED RESUME');
 assert.equal(record.agentRuns[0].persona_text,'You are the resume assembler.');
 assert.equal(record.agentRuns[0].model,'deepseek-v4.1-flash');
 assert.equal(record.toolEvents.length,1);
 assert.equal(record.attempts[0].receiptText,'Confirmation REF-9');
 assert.equal(record.decisions[0].decision,'approve');
 assert.equal(record.snapshots[0].description_text,'Posting body text');

 // Export it, then reconstruct it offline with no service and no database.
 const exportDir=path.join(root,'export-1');
 const exported=await api(base,`/api/applications/${applicationId}/export`,{directory:exportDir});
 assert.equal(exported.status,200,JSON.stringify(exported.body));
 assert.ok(exported.body.artifacts>=4,'evidence, both resume passes, the receipt and the screenshot are included');
 const reconstructed=spawnSync(process.execPath,[path.join(here,'../dist/data-cli.js'),'reconstruct',exportDir],{encoding:'utf8'});
 assert.equal(reconstructed.status,0,reconstructed.stderr);
 const offline=JSON.parse(reconstructed.stdout);
 assert.equal(offline.application.id,applicationId);
 assert.equal(offline.resumes,2);
 assert.equal(offline.attempts,1);
 assert.equal(offline.decisions,1);
 assert.equal(offline.verifiedArtifacts,exported.body.artifacts);
 assert.equal(JSON.parse(fs.readFileSync(path.join(exportDir,'record.json'),'utf8')).resumes[1].text,'EDITED RESUME','the export is readable with plain tools');

 // A later profile change must not rewrite the exported history.
 libraryExportIndependence: {
  const store2=new SettingsStore(path.join(dir,'jobs.sqlite'));
  try{ new Library(store2.db).addProfile({profileId:'primary',data:{contact:{name:'Ada Lovelace'},facts:[],suggestions:[]}}); }
  finally{ store2.close(); }
 }
 const recordAfter=(await api(base,`/api/applications/${applicationId}/record`)).body;
 assert.deepEqual(recordAfter.resumes.map(r=>r.profile_revision_id),record.resumes.map(r=>r.profile_revision_id),'history stays pinned to the revision it was built from');
 const secondExport=path.join(root,'export-2');
 await api(base,`/api/applications/${applicationId}/export`,{directory:secondExport});
 assert.equal(JSON.parse(fs.readFileSync(path.join(secondExport,'record.json'),'utf8')).resumes[1].profile_revision_id,record.resumes[1].profile_revision_id);

 // Health reports the state plainly, and a missing artifact becomes an error.
 let health=(await api(base,'/api/health')).body;
 assert.equal(health.retention.policy,'retain-all');
 assert.equal(health.retention.pruned,0);
 assert.equal(health.backup.lastBackupAt!==null,true,'the recorded backup is surfaced');
 assert.deepEqual(health.problems.filter(p=>p.severity==='error'),[]);
 fs.rmSync(path.join(dir,'artifacts',receiptHash));
 health=(await api(base,'/api/health')).body;
 assert.equal(health.status,'failed');
 assert.ok(health.problems.some(p=>p.code==='artifact_missing'),'a missing artifact is surfaced, not hidden');
 // Restoring the exact bytes clears the error; a backup refuses to run while it is missing.
 fs.writeFileSync(path.join(dir,'artifacts',receiptHash),'Confirmation REF-9');
 health=(await api(base,'/api/health')).body;
 assert.deepEqual(health.problems.filter(p=>p.severity==='error'),[],'the store is healthy again once the artifact is restored');

 // Repair releases the stale lease and refuses to retry the interrupted submission.
 const repaired=await api(base,'/api/queue/repair',{});
 assert.deepEqual(repaired.body.releasedLeases,[stale.id]);
 assert.deepEqual(repaired.body.unconfirmed,[interrupted.id]);

 // A read-only restore in a clean directory never dispatches anything.
 const archive=path.join(root,'archive');
 const backup=spawnSync(process.execPath,[path.join(here,'../dist/data-cli.js'),'backup',archive],{encoding:'utf8',env:{...process.env,JOBS_DIR:dir}});
 assert.equal(backup.status,0,backup.stderr);
 const restored=path.join(root,'restored');
 const restore=spawnSync(process.execPath,[path.join(here,'../dist/data-cli.js'),'restore',archive,restored,'--read-only'],{encoding:'utf8'});
 assert.equal(restore.status,0,restore.stderr);
 assert.ok(fs.existsSync(path.join(restored,'read-only.json')));
 assert.equal(fs.existsSync(path.join(restored,'service.json')),false,'bootstrap credentials are deliberately not restored');
 // The operator supplies fresh bootstrap credentials before starting the restored copy.
 fs.writeFileSync(path.join(restored,'service.json'),JSON.stringify({port:port+1,token,allowedOrigins:[]}),{mode:0o600});
 const restoredChild=startService(restored,port+1);
 children.push(restoredChild);restoredChild.stdout.on('data',()=>{});restoredChild.stderr.on('data',()=>{});
 const restoredBase=`http://127.0.0.1:${port+1}`;
 await until(async()=>(await fetch(`${restoredBase}/health`)).ok,'restored service startup');
 const restoredStatus=(await api(restoredBase,'/api/status')).body;
 assert.equal(restoredStatus.readOnly,true);
 assert.equal(restoredStatus.scheduler.state,'disabled','restore lands disabled with no dispatch');
 assert.equal(restoredStatus.scheduler.dispatchAvailable,false);
 const refused=await api(restoredBase,'/api/queue/repair',{});
 assert.equal(refused.status,409);
 assert.equal(refused.body.error.code,'read_only_archive');
 const restoredSettings=(await api(restoredBase,'/api/settings')).body;
 assert.equal(restoredSettings.value.enabled,false);
 assert.equal(restoredSettings.value.paused,true);
 const restoredHealth=(await api(restoredBase,'/api/health')).body;
 assert.ok(restoredHealth.problems.some(p=>p.code==='read_only_archive'));
 assert.equal(restoredHealth.retention.counts.application_attempts,1,'the restored archive still holds the history');

 // Stopping jobs neither kills nor claims unrelated sessions: the host is never called.
 for(const child of children)await stop(child);
 children.length=0;
 await delay(500);
 assert.deepEqual(hostHits,[],'the jobs service never contacted the Switchboard host');
 console.log('records acceptance: ALL PASS');
}finally{
 for(const child of children)await stop(child);
 fs.rmSync(root,{recursive:true,force:true});
}