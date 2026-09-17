// Step 12 acceptance: a fresh data directory, end to end, then restart and ambiguity recovery.
// Real Chromium for capture and form work; loopback fixture site. Build first, then:
//   JOBS_BROWSER_EXECUTABLE=<chrome> node packages/jobs/acceptance/rollout.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';

const chrome=process.env.JOBS_BROWSER_EXECUTABLE;
if(!chrome){console.log('SKIP: set JOBS_BROWSER_EXECUTABLE to run the rollout acceptance');process.exit(0);}
const here=new URL('.',import.meta.url).pathname;
const root=fs.mkdtempSync(path.join(os.tmpdir(),'jobs-rollout-'));
const token='rollout-fixture-token-not-a-host-token';
const port=17981;
const children=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){for(let i=0;i<250;i++){try{if(await fn())return;}catch{}await delay(100);}throw Error(`Timeout: ${label}`);}
async function stop(child){if(child&&child.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}}
async function api(base,route,body,method){
 const response=await fetch(base+route,{method:method??(body?'POST':'GET'),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,body:await response.json()};
}

// --- A fixture employer site: a posting to capture and a form to prepare and submit -----
const counts={submissions:0};
const POSTING='<!doctype html><html><body><h1>Senior Support Engineer</h1><p>Acme is hiring a support engineer for its platform team.</p></body></html>';
const FORM=`<!doctype html><html><body><h1>Apply</h1><form id="apply">
<label for="name">Name</label><input id="name" name="name" required>
<label for="email">Email</label><input id="email" name="email" type="email" required>
<label for="resume">Resume</label><input id="resume" name="resume" type="file" required accept=".txt">
<button type="button" data-apply-action="submit">Submit application</button></form>
<script>
document.querySelector("[data-apply-action='submit']").addEventListener('click',async()=>{
 const form=document.getElementById('apply');const fields={};for(const [k,v] of new FormData(form))if(typeof v==='string')fields[k]=v;
 const file=form.querySelector("input[type=file]").files[0]??null;
 const response=await fetch('/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fields,file:file?{name:file.name}:null})});
 const result=await response.json();
 document.body.insertAdjacentHTML('beforeend','<p id="confirmation" data-apply-result="'+result.result+'">'+result.message+'</p><span data-apply-reference>'+result.reference+'</span>');
});</script></body></html>`;
const site=http.createServer((request,response)=>{
 const url=new URL(request.url,'http://127.0.0.1');
 if(url.pathname==='/posting'){response.writeHead(200,{'Content-Type':'text/html'});return response.end(POSTING);}
 if(url.pathname==='/apply'){response.writeHead(200,{'Content-Type':'text/html'});return response.end(FORM);}
 if(url.pathname==='/__counts'){response.writeHead(200,{'Content-Type':'application/json'});return response.end(JSON.stringify(counts));}
 if(request.method==='POST'&&url.pathname==='/submit'){counts.submissions++;response.writeHead(200,{'Content-Type':'application/json'});
  return response.end(JSON.stringify({result:'submitted',message:'Application submitted',reference:`REF-${counts.submissions}`}));}
 response.writeHead(404);response.end('not found');
});
await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${site.address().port}`;
const dir=path.join(root,'fresh-data');
const start=()=>{const child=spawn(process.execPath,[path.join(here,'../dist/index.js')],{env:{...process.env,JOBS_DIR:dir},stdio:['ignore','pipe','pipe']});
 children.push(child);child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});return child;};
const base=`http://127.0.0.1:${port}`;
try{
 // A genuinely fresh data directory: only bootstrap configuration exists.
 fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'service.json'),JSON.stringify({port,token,allowedOrigins:[],browserExecutablePath:chrome,allowPrivateImport:true}));
 start();
 await until(async()=>(await fetch(`${base}/health`)).ok,'jobs startup on a fresh directory');

 // First run lands disabled and paused with every gate on.
 let status=(await api(base,'/api/status')).body;
 assert.equal(status.capabilities.applications,true);
 assert.equal(status.capabilities.submissions,true);
 const initial=(await api(base,'/api/settings')).body;
 assert.equal(initial.value.enabled,false,'defaults stay disabled in code');
 assert.equal(initial.value.paused,true);
 assert.equal(initial.value.mode,'draft');
 assert.equal(Object.values(initial.value.reviewGates).every(Boolean),true);

 // Configure, then capture real evidence for a real page with real Chromium.
 const settings=await api(base,'/api/settings',{expectedRevision:initial.revision,value:{...initial.value,enabled:true,paused:false,mode:'review'}},'PUT');
 assert.equal(settings.status,200,JSON.stringify(settings.body));
 await api(base,'/api/sources/acme',{adapterId:'fixture',sourceKey:'acme',enabled:true,config:{companyName:'Acme',boardId:'acme',
  schedule:{intervalMinutes:1},fixture:{postings:[{id:'p1',url:'https://acme.example/p1',title:'Support Engineer',location:'Remote',body:'Body'}]}}},'PUT');
 const discovery=await api(base,'/api/sources/acme/discover',{},'POST');
 assert.equal(discovery.body.discovered>=1,true,'discovery works on a fresh directory');

 const captured=await api(base,'/api/import/url',{url:`${origin}/posting`,company:'Acme',title:'Senior Support Engineer'});
 assert.equal(captured.status,200,JSON.stringify(captured.body));
 assert.equal(captured.body.completeness,'complete','a real capture is complete evidence');
 const jobId=captured.body.jobId, snapshotId=captured.body.snapshotId;

 // Career library, then a deterministic resume render for that capture.
 const library=await api(base,'/api/library/profile',{profileId:'primary',data:{contact:{name:'Ada Lovelace',email:'ada@example.test'},
  facts:[{key:'summary',value:'Support engineer with a decade of platform experience.'}],suggestions:[]}},'PUT');
 assert.equal(library.status,200,JSON.stringify(library.body));
 const profile=((await api(base,'/api/library')).body.profiles??[]).at(-1);
 await api(base,'/api/library/template',{templateId:'base',data:{name:'Base',sections:[{id:'summary',title:'Summary',type:'facts',factKeys:['summary'],optional:false}]}},'PUT');
 const template=((await api(base,'/api/library')).body.templates??[]).at(-1);
 const rendered=await api(base,'/api/resumes/render',{jobSnapshotId:snapshotId,profileRevisionId:profile.id,templateRevisionId:template.id});
 assert.equal(rendered.status,200,JSON.stringify(rendered.body));
 assert.match(rendered.body.text,/Support engineer with a decade/,'the resume renders the real profile facts');
 assert.equal(rendered.body.structured.missing.length,0);

 // Select it for the application (the gap this rehearsal found), then prepare.
 const applicationId=(await api(base,'/api/dashboard')).body.applications.find(row=>row.job_id===jobId).id;
 const selected=await api(base,`/api/applications/${applicationId}/resume`,{resumeVersionId:rendered.body.resumeVersionId});
 assert.equal(selected.status,200,JSON.stringify(selected.body));
 await api(base,'/api/policies',{adapterId:'fixture-form',siteUrl:`${origin}/apply`,capabilities:{prepare:true,fill:true,upload:true,submit:true},restrictions:{maxPerDay:5}},'PUT');
 const prepared=await api(base,`/api/applications/${applicationId}/prepare`,{adapterId:'fixture-form',formUrl:`${origin}/apply`,
  answers:{name:'Ada Lovelace',email:'ada@example.test'}});
 assert.equal(prepared.body.state,'draft',JSON.stringify(prepared.body));

 // Review, approve, and send exactly once.
 const pkg=(await api(base,`/api/applications/${applicationId}/package`)).body;
 assert.equal(pkg.resume.id,rendered.body.resumeVersionId);
 assert.equal(pkg.snapshot.completeness,'complete');
 await api(base,`/api/attempts/${prepared.body.attemptId}/approve`,{expectedManifestHash:pkg.attempt.manifest.manifestHash,reason:'Reviewed the package'});
 const sent=await api(base,`/api/attempts/${prepared.body.attemptId}/submit`,{});
 assert.equal(sent.body.state,'submitted',JSON.stringify(sent.body));
 assert.equal((await (await fetch(`${origin}/__counts`)).json()).submissions,1);

 // Records and an offline export of what actually happened.
 const record=(await api(base,`/api/applications/${applicationId}/record`)).body;
 assert.equal(record.resumes.length>=1,true);
 assert.equal(record.attempts[0].outcome_json===null?null:JSON.parse(record.attempts[0].outcome_json).outcome,'submitted');
 const exportDir=path.join(root,'export');
 const exported=await api(base,`/api/applications/${applicationId}/export`,{directory:exportDir});
 assert.equal(exported.status,200,JSON.stringify(exported.body));
 const offline=spawnSync(process.execPath,[path.join(here,'../dist/data-cli.js'),'reconstruct',exportDir],{encoding:'utf8'});
 assert.equal(offline.status,0,offline.stderr);
 assert.equal(JSON.parse(offline.stdout).attempts,1,'the export reconstructs with no database');
 const health=(await api(base,'/api/health')).body;
 assert.deepEqual(health.problems.filter(problem=>problem.severity==='error'),[],'a healthy store after a full run');
 assert.equal(health.retention.policy,'retain-all');

 // Jobs restart during submission ambiguity: the interrupted send becomes unknown, not a retry.
 const second=await api(base,`/api/applications/${applicationId}/prepare`,{adapterId:'fixture-form',formUrl:`${origin}/apply`,
  answers:{name:'Ada Lovelace',email:'ada@example.test',cover:'second run'}});
 assert.equal(second.body.state,'draft',JSON.stringify(second.body));
 const secondPkg=(await api(base,`/api/applications/${applicationId}/package`)).body;
 await api(base,`/api/attempts/${second.body.attemptId}/approve`,{expectedManifestHash:secondPkg.attempt.manifest.manifestHash,reason:'ok'});
 for(const child of children)await stop(child);
 children.length=0;
 const interrupted=new DatabaseSync(path.join(dir,'jobs.sqlite'));
 interrupted.prepare("UPDATE application_attempts SET state='submitting', send_started_at=? WHERE id=?").run(new Date(Date.now()-3600000).toISOString(),second.body.attemptId);
 interrupted.close();
 start();
 await until(async()=>(await fetch(`${base}/health`)).ok,'jobs restart');
 const afterRestart=(await api(base,`/api/applications/${applicationId}/package`)).body;
 assert.equal(afterRestart.attempt.state,'unknown','a crash after the intent is unknown, never a silent retry');
 assert.equal(afterRestart.application.state,'submission_unknown');
 assert.equal((await (await fetch(`${origin}/__counts`)).json()).submissions,1,'recovery never resent');
 const reconciled=await api(base,`/api/attempts/${second.body.attemptId}/reconcile`,{outcome:'submitted',detail:'Found the confirmation email',receiptText:'REF-2'});
 assert.equal(reconciled.body.reconciledFrom,'unknown');

 // Everything survived the restart, and the earlier history is intact.
 const finalRecord=(await api(base,`/api/applications/${applicationId}/record`)).body;
 assert.equal(finalRecord.attempts.length,2,'history persists across a restart');
 assert.equal(finalRecord.decisions.length>=1,true);
 const health2=(await api(base,'/api/health')).body;
 assert.equal(health2.retention.counts.application_attempts,2);
 console.log('rollout acceptance: ALL PASS');
}finally{
 for(const child of children)await stop(child);
 site.close();
 fs.rmSync(root,{recursive:true,force:true});
}
