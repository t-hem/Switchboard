// Step 9 acceptance: the preparation/review/approval routes over HTTP, and the served UI.
// Disposable service; no browser needed (the in-process fixture adapter is used).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

const here=new URL('.',import.meta.url).pathname;
const root=fs.mkdtempSync(path.join(os.tmpdir(),'jobs-review-'));
const token='review-fixture-token-not-a-host-token';
const port=17971;
const children=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){for(let i=0;i<150;i++){try{if(await fn())return;}catch{}await delay(100);}throw Error(`Timeout: ${label}`);}
async function stop(child){if(child&&child.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}}
async function api(base,route,body,method){
 const response=await fetch(base+route,{method:method??(body?'POST':'GET'),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,body:await response.json()};
}
const dir=path.join(root,'service');
try{
 // Seed a job, a complete capture, a rendered resume and a selected application.
 fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'service.json'),JSON.stringify({port,token,allowedOrigins:[]}));
 const {SettingsStore}=await import('../dist/store.js');
 const {ArtifactStore}=await import('../dist/artifacts.js');
 const {Postings}=await import('../dist/postings.js');
 const {Library}=await import('../dist/library.js');
 const store=new SettingsStore(path.join(dir,'jobs.sqlite'));
 const artifacts=new ArtifactStore(store.db,dir);
 const postings=new Postings(store.db,artifacts);
 const library=new Library(store.db);
 const {jobId}=postings.ingest({adapterId:'fixture',company:'Acme',title:'Engineer',originalUrl:'https://acme.example/1',descriptionText:'Body',provenance:'browser'});
 const snapshotId=postings.recordSnapshot({jobId,purpose:'discovery',fetchedUrl:'u',finalUrl:'u',descriptionText:'Body text',
  screenshot:Buffer.from('png'),captureVersion:'browser:1',capture:{},completeness:'complete'}).snapshotId;
 const profile=library.addProfile({profileId:'primary',data:{contact:{name:'Ada'},facts:[],suggestions:[]}});
 const template=library.addTemplate({templateId:'base',data:{name:'Base',sections:[{id:'summary',title:'Summary',type:'facts',factKeys:['summary'],optional:true}]}});
 const hash=artifacts.put(Buffer.from('resume text','utf8'),'text/plain','resume-text').hash;
 store.db.prepare(`INSERT INTO resume_versions(id,job_snapshot_id,profile_revision_id,template_revision_id,parent_resume_id,agent_run_id,phase,source_json,selected_bullets_json,edits_json,text_artifact_hash,pdf_artifact_hash,created_at)
  VALUES('resume-1',?,?,?,NULL,NULL,'render','{}','[]','{}',?,NULL,?)`).run(snapshotId,profile.id,template.id,hash,new Date().toISOString());
 const applicationId=String(store.db.prepare('SELECT id FROM applications WHERE job_id=?').get(jobId).id);
 store.db.prepare('UPDATE applications SET selected_resume_id=? WHERE id=?').run('resume-1',applicationId);
 store.close();

 const child=spawn(process.execPath,[path.join(here,'../dist/index.js')],{env:{...process.env,JOBS_DIR:dir},stdio:['ignore','pipe','pipe']});
 children.push(child);child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});
 const base=`http://127.0.0.1:${port}`;
 await until(async()=>(await fetch(`${base}/health`)).ok,'jobs startup');

 // The adapter registry is a contract, and it never claims submission here.
 const adapters=(await api(base,'/api/application-adapters')).body;
 assert.deepEqual(adapters.adapters.map(a=>a.id).sort(),['fixture','fixture-form','manual']);
 assert.equal(adapters.adapters.find(a=>a.id==='fixture-form').capabilities.submit,false);
 assert.equal(adapters.browser.available,false,'no browser is configured in this run');

 // Prepare, review, approve against the exact manifest.
 const prepared=await api(base,`/api/applications/${applicationId}/prepare`,{adapterId:'fixture',formUrl:'https://forms.example/apply',answers:{name:'Ada Lovelace',email:'ada@example.test'}});
 assert.equal(prepared.body.state,'draft',JSON.stringify(prepared.body));
 const attemptId=prepared.body.attemptId;
 const manifestHash=prepared.body.manifest.manifestHash;
 let pkg=(await api(base,`/api/applications/${applicationId}/package`)).body;
 assert.equal(pkg.snapshot.completeness,'complete','the package carries the posting evidence');
 assert.equal(pkg.resume.id,'resume-1');
 assert.equal(pkg.attempt.manifest.answers.name,'Ada Lovelace');
 assert.equal(pkg.approval,null,'nothing is approved before the operator decides');

 const wrong=await api(base,`/api/attempts/${attemptId}/approve`,{expectedManifestHash:'a'.repeat(64),reason:'stale'});
 assert.equal(wrong.status,409);
 assert.equal(wrong.body.error.code,'manifest_changed');
 const approved=await api(base,`/api/attempts/${attemptId}/approve`,{expectedManifestHash:manifestHash,reason:'Looks right'});
 assert.equal(approved.body.state,'approved');

 // Changed answers cancel the approval and show up as the reason.
 const changed=await api(base,`/api/applications/${applicationId}/prepare`,{adapterId:'fixture',formUrl:'https://forms.example/apply',answers:{name:'Ada Lovelace',email:'ada@example.test',phone:'555'}});
 assert.equal(changed.body.created,true);
 pkg=(await api(base,`/api/applications/${applicationId}/package`)).body;
 assert.equal(pkg.approval.current,false,'the stale approval can never be sent');
 assert.ok(pkg.changesSinceReview.some(change=>change.field==='answers'));
 const oldAttempt=(await api(base,`/api/applications/${applicationId}/package`)).body;
 assert.ok(oldAttempt.approval.attemptId!==changed.body.attemptId);

 // A blocking question becomes a handoff; resolving it continues the same application.
 const blocked=await api(base,`/api/applications/${applicationId}/prepare`,{adapterId:'fixture',formUrl:'https://forms.example/apply',answers:{name:'Ada Lovelace',email:'ada@example.test'},adapterOptions:{captcha:true}});
 assert.equal(blocked.body.state,'needs_input');
 assert.equal(blocked.body.code,'captcha');
 pkg=(await api(base,`/api/applications/${applicationId}/package`)).body;
 assert.equal(pkg.handoff.code,'captcha');
 assert.ok(pkg.handoff.formUrl&&pkg.handoff.answers&&pkg.handoff.resumeVersionId,'the handoff carries URL, answers and resume');
 const resolved=await api(base,`/api/applications/${applicationId}/resolve`,{code:'captcha',note:'Solved the challenge by hand',answers:{name:'Ada Lovelace',email:'ada@example.test'}});
 assert.equal(resolved.body.resolved,true);
 assert.equal(resolved.body.outcome.state,'draft','resolution continues preparation on the same application');
 assert.equal((await api(base,`/api/applications/${applicationId}/package`)).body.handoff,null);

 // An operator-reported manual completion stores exactly what it was told.
 const manual=await api(base,`/api/applications/${applicationId}/manual-completion`,{detail:'Submitted on the employer site',receiptText:'Reference ABC-123'});
 assert.equal(manual.body.created,true);
 const manualAttempt=(await api(base,`/api/applications/${applicationId}/package`)).body.attempt;
 assert.equal(manualAttempt.adapter_id,'manual');
 assert.equal(manualAttempt.state,'submitted');
 assert.ok(manualAttempt.receipt_hash,'the receipt is stored as evidence');
 assert.equal((await api(base,`/api/applications/${applicationId}/manual-completion`,{detail:'Submitted on the employer site',receiptText:'Reference ABC-123'})).body.created,false);

 // Nothing is sent without an explicit operator action; a submission route does not exist yet.
 const noSubmit=await api(base,`/api/applications/${applicationId}/submit`,{});
 assert.equal(noSubmit.status,404,'the service exposes no submission route in this step');

 // The served client ships the review screen.
 const page=await (await fetch(`${base}/`)).text();
 assert.ok(page.includes('Application preparation'),'the UI ships the preparation section');
 const script=await (await fetch(`${base}/app.js`)).text();
 for(const marker of ['showPackage','manual-completion','expectedManifestHash'])assert.ok(script.includes(marker),`app.js ships ${marker}`);

 // With a browser available, prove the screen actually works: it connects, fills the
 // application list and offers the preparation controls without a script error.
 if(process.env.JOBS_BROWSER_EXECUTABLE){
  const {SupervisedBrowser,browserPaths}=await import('../dist/browser.js');
  const browser=new SupervisedBrowser({executablePath:process.env.JOBS_BROWSER_EXECUTABLE,...browserPaths(root)});
  try{
   const pageHandle=await (await browser.ensure()).newPage();
   const errors=[];pageHandle.on('pageerror',error=>errors.push(String(error.message)));
   await pageHandle.goto(base,{waitUntil:'load'});
   await pageHandle.evaluate(tokenValue=>localStorage.setItem('jobs.token',tokenValue),token);
   await pageHandle.goto(base,{waitUntil:'load'});
   await until(async()=>await pageHandle.evaluate(()=>document.querySelector('#prepare-application')?.options.length>0),'the review screen connects and lists the application');
   const state=await pageHandle.evaluate(()=>({hidden:document.getElementById('dashboard').hidden,
    options:[...document.querySelectorAll('#prepare-application option')].map(o=>o.textContent),
    adapters:[...document.querySelectorAll('#prepare-adapter option')].map(o=>o.value),
    message:document.getElementById('message').textContent}));
   assert.equal(state.hidden,false,`the dashboard opened (message: ${state.message})`);
   assert.ok(state.options.some(label=>label.includes('Engineer')),'the application is listed for preparation');
   assert.ok(state.adapters.includes('fixture'),'the adapter registry is offered');
   assert.deepEqual(errors,[],'the review screen runs without a script error');
   await pageHandle.close();
  }finally{await browser.close();}
 }
 console.log('review acceptance: ALL PASS');
}finally{
 for(const child of children)await stop(child);
 fs.rmSync(root,{recursive:true,force:true});
}
