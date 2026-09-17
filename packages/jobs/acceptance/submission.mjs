// Step 10 acceptance: sending is gated, singular and honestly recorded.
// Real supervised browser, loopback fixture site that counts submissions.
// Build first, then: JOBS_BROWSER_EXECUTABLE=<chrome> node packages/jobs/acceptance/submission.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';

const chrome=process.env.JOBS_BROWSER_EXECUTABLE;
if(!chrome){console.log('SKIP: set JOBS_BROWSER_EXECUTABLE to run the submission acceptance');process.exit(0);}
const here=new URL('.',import.meta.url).pathname;
const root=fs.mkdtempSync(path.join(os.tmpdir(),'jobs-submit-'));
const token='submission-fixture-token-not-a-host-token';
const port=17973;
const children=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){for(let i=0;i<200;i++){try{if(await fn())return;}catch{}await delay(100);}throw Error(`Timeout: ${label}`);}
async function stop(child){if(child&&child.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}}
async function api(base,route,body,method){
 const response=await fetch(base+route,{method:method??(body?'POST':'GET'),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,body:await response.json()};
}
const sha256=value=>createHash('sha256').update(value).digest('hex');
const resumeText='Ada Lovelace\nEngineer\n- Shipped fixtures\n';

// --- Fixture site that counts what actually arrives --------------------------------------
const record={prepareCalls:0,submissions:0,lastSubmit:null,rejected:0,native:0,lastNative:null,searches:0};
// A conventional server-rendered form: native POST and a full page navigation on submit, a
// search form elsewhere on the page, a type-less "Preview" button (which really submits) and a
// submit input labelled "Review and submit". None of them may be pressed while preparing.
const NATIVE=`<!doctype html><html><body><header><form action="/search" method="get"><input name="q" aria-label="Search"><button type="submit">Search</button></form></header>
<h1>Apply</h1><form method="post" action="/native-submit" enctype="multipart/form-data">
 <label for="name">Name</label><input id="name" name="name" required>
 <label for="email">Email</label><input id="email" name="email" type="email" required>
 <label for="resume">Resume</label><input id="resume" name="resume" type="file" required accept=".txt">
 <button name="preview">Preview</button>
 <input type="submit" value="Review and submit">
</form></body></html>`;
const page=(mode,verdict='submitted')=>`<!doctype html><html><body><h1>Apply</h1><form id="apply">
 <label for="name">Name</label><input id="name" name="name" required>
 <label for="email">Email</label><input id="email" name="email" type="email" required>
 <label for="coverLetter">Cover letter</label><textarea id="coverLetter" name="coverLetter"></textarea>
 <label for="resume">Resume</label><input id="resume" name="resume" type="file" required accept=".txt">
 <button type="button" data-apply-action="preview">Review application</button>
 <button type="button" data-apply-action="submit">Submit application</button></form>
<script>
const hex=buffer=>Array.from(new Uint8Array(buffer)).map(b=>b.toString(16).padStart(2,'0')).join('');
const form=document.getElementById('apply');
const payload=async()=>{const fields={};for(const [key,value] of new FormData(form))if(typeof value==='string')fields[key]=value;
 const file=form.querySelector("input[type=file]").files[0]??null;
 return {fields,file:file?{name:file.name,size:file.size,sha256:hex(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))}:null};};
const send=async(verdict)=>{const response=await fetch('/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...(await payload()),verdict})});return response.json();};
document.querySelector("[data-apply-action='preview']").addEventListener('click',async()=>{const response=await fetch('/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(await payload())});await response.text();document.body.insertAdjacentHTML('beforeend','<p id="prepared">Preview recorded</p>');});
document.querySelector("[data-apply-action='submit']").addEventListener('click',async()=>{const result=await send('${verdict}');
 ${mode==='silent'?`/* the site accepted it but shows nothing readable */`:``}
 ${mode==='silent'?'':`document.body.insertAdjacentHTML('beforeend','<p id="confirmation" data-apply-result="'+result.result+'">'+result.message+'</p><span data-apply-reference>'+result.reference+'</span>');`}});
</script></body></html>`;
function body(request){return new Promise(resolve=>{let data='';request.on('data',chunk=>{data+=chunk;});request.on('end',()=>resolve(data));});}
const server=http.createServer(async(request,response)=>{
 const url=new URL(request.url,'http://127.0.0.1');
 if(request.method==='GET'&&url.pathname==='/apply'){response.writeHead(200,{'Content-Type':'text/html'});return response.end(page('confirm'));}
 if(request.method==='GET'&&url.pathname==='/apply-silent'){response.writeHead(200,{'Content-Type':'text/html'});return response.end(page('silent'));}
 if(request.method==='GET'&&url.pathname==='/apply-reject'){response.writeHead(200,{'Content-Type':'text/html'});return response.end(page('confirm','rejected'));}
 if(request.method==='GET'&&url.pathname==='/native'){response.writeHead(200,{'Content-Type':'text/html'});return response.end(NATIVE);}
 if(request.method==='GET'&&url.pathname==='/search'){record.searches++;response.writeHead(200,{'Content-Type':'text/html'});return response.end('<p>No results</p>');}
 if(request.method==='POST'&&url.pathname==='/native-submit'){
  const raw=await body(request);record.native++;record.lastNative=raw;
  response.writeHead(200,{'Content-Type':'text/html'});
  return response.end(`<!doctype html><html><body><p id="confirmation" data-apply-result="submitted">Application received</p><span data-apply-reference>NATIVE-${record.native}</span></body></html>`);}
 if(request.method==='GET'&&url.pathname==='/__record'){response.writeHead(200,{'Content-Type':'application/json'});return response.end(JSON.stringify(record));}
 if(request.method==='POST'&&url.pathname==='/prepare'){const parsed=JSON.parse(await body(request));record.prepareCalls++;response.writeHead(200,{'Content-Type':'text/plain'});return response.end('ok');}
 if(request.method==='POST'&&url.pathname==='/submit'){
  const parsed=JSON.parse(await body(request));record.submissions++;record.lastSubmit=parsed;
  const rejecting=parsed.verdict==='rejected';
  if(rejecting)record.rejected++;
  response.writeHead(200,{'Content-Type':'application/json'});
  return response.end(JSON.stringify(rejecting?{result:'rejected',message:'Not eligible in this region',reference:'REF-REJECT'}:{result:'submitted',message:'Application submitted',reference:`REF-${record.submissions}`}));}
 response.writeHead(404);response.end('not found');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;

const dir=path.join(root,'service');
try{
 fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'service.json'),JSON.stringify({port,token,allowedOrigins:[],browserExecutablePath:chrome,allowPrivateImport:true}));
 // Seed a job, a complete capture, a resume and a selected application.
 const {SettingsStore}=await import('../dist/store.js');
 const {ArtifactStore}=await import('../dist/artifacts.js');
 const {Postings}=await import('../dist/postings.js');
 const {Library}=await import('../dist/library.js');
 const store=new SettingsStore(path.join(dir,'jobs.sqlite'));
 const artifacts=new ArtifactStore(store.db,dir);
 const postings=new Postings(store.db,artifacts);
 const library=new Library(store.db);
 const {jobId}=postings.ingest({adapterId:'fixture',company:'Acme',title:'Engineer',originalUrl:'https://acme.example/1',descriptionText:'Body',provenance:'browser'});
 const snapshotId=postings.recordSnapshot({jobId,purpose:'discovery',fetchedUrl:'u',finalUrl:'u',descriptionText:'Body text',screenshot:Buffer.from('png'),captureVersion:'browser:1',capture:{},completeness:'complete'}).snapshotId;
 const profile=library.addProfile({profileId:'primary',data:{contact:{name:'Ada'},facts:[],suggestions:[]}});
 const template=library.addTemplate({templateId:'base',data:{name:'Base',sections:[{id:'summary',title:'Summary',type:'facts',factKeys:['summary'],optional:true}]}});
 const resumeHash=artifacts.put(Buffer.from(resumeText,'utf8'),'text/plain','resume-text').hash;
 store.db.prepare(`INSERT INTO resume_versions(id,job_snapshot_id,profile_revision_id,template_revision_id,parent_resume_id,agent_run_id,phase,source_json,selected_bullets_json,edits_json,text_artifact_hash,pdf_artifact_hash,created_at)
  VALUES('resume-1',?,?,?,NULL,NULL,'render','{}','[]','{}',?,NULL,?)`).run(snapshotId,profile.id,template.id,resumeHash,new Date().toISOString());
 const applicationId=String(store.db.prepare('SELECT id FROM applications WHERE job_id=?').get(jobId).id);
 store.db.prepare('UPDATE applications SET selected_resume_id=? WHERE id=?').run('resume-1',applicationId);
 store.close();

 const child=spawn(process.execPath,[path.join(here,'../dist/index.js')],{env:{...process.env,JOBS_DIR:dir},stdio:['ignore','pipe','pipe']});
 children.push(child);child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});
 const base=`http://127.0.0.1:${port}`;
 await until(async()=>(await fetch(`${base}/health`)).ok,'jobs startup');

 const settings=(await api(base,'/api/settings')).body;
 const save=async patch=>{const current=(await api(base,'/api/settings')).body;
  return api(base,'/api/settings',{expectedRevision:current.revision,value:{...current.value,...patch}},'PUT');};
 await save({enabled:true,paused:false,mode:'review'});
 const policy=async(capabilities,restrictions={})=>api(base,'/api/policies',{adapterId:'fixture-form',siteUrl:`${origin}/apply`,capabilities,restrictions},'PUT');
 const allow=()=>policy({prepare:true,fill:true,upload:true,submit:true},{maxPerDay:10});
 await allow();

 let letter=0;
 const prepare=async(formUrl=`${origin}/apply`)=>{
  letter++;
  const outcome=await api(base,`/api/applications/${applicationId}/prepare`,{adapterId:'fixture-form',formUrl,answers:{name:'Ada Lovelace',email:'ada@example.test',coverLetter:`Letter ${letter}`}});
  assert.equal(outcome.body.state,'draft',JSON.stringify(outcome.body));
  return outcome.body;
 };
 const approve=async attemptId=>{const pkg=(await api(base,`/api/applications/${applicationId}/package`)).body;
  const result=await api(base,`/api/attempts/${attemptId}/approve`,{expectedManifestHash:pkg.attempt.manifest.manifestHash,reason:'Reviewed the package'});
  assert.equal(result.status,200,JSON.stringify(result.body));return pkg.attempt.manifest.manifestHash;};
 const submit=attemptId=>api(base,`/api/attempts/${attemptId}/submit`,{});
 const seen=async()=>await (await fetch(`${origin}/__record`)).json();

 // An approved attempt sends exactly once, re-filling the live form with the saved answers.
 const first=await prepare();
 assert.equal((await submit(first.attemptId)).body.blocked.code,'approval_required','an unapproved attempt is never sent');
 assert.equal((await seen()).submissions,0);
 await approve(first.attemptId);
 const sent=await submit(first.attemptId);
 assert.equal(sent.body.state,'submitted',JSON.stringify(sent.body));
 assert.ok(sent.body.receiptHash,'the observed confirmation is stored as the receipt');
 let server1=await seen();
 assert.equal(server1.submissions,1);
 assert.equal(server1.lastSubmit.fields.name,'Ada Lovelace','the send re-filled the live form from the saved answers');
 assert.equal(server1.lastSubmit.fields.coverLetter,'Letter 1');
 assert.equal(server1.lastSubmit.file.sha256,resumeHash,'the exact resume bytes were uploaded again for the send');
 assert.equal(server1.lastSubmit.file.name,`resume-${applicationId.slice(0,8)}.txt`);

 // A double click cannot send twice.
 const again=await submit(first.attemptId);
 assert.ok(again.body.blocked,'a second send of the same attempt is refused');
 assert.equal((await seen()).submissions,1,'exactly one submission reached the site');

 // Tightening the site policy blocks a newly approved send.
 await policy({prepare:true,fill:true,upload:true,submit:false});
 const tightened=await prepare();
 await approve(tightened.attemptId);
 const refused=await submit(tightened.attemptId);
 assert.equal(refused.body.blocked.code,'policy_forbids_submission');
 assert.equal((await seen()).submissions,1);

 // Draft-only mode sends nothing even with an approval and a permissive policy.
 await allow();
 const draftOnly=await prepare();
 await approve(draftOnly.attemptId);
 await save({mode:'draft'});
 assert.equal((await submit(draftOnly.attemptId)).body.blocked.code,'mode_draft_only');
 await save({mode:'review'});
 assert.equal((await seen()).submissions,1);

 // A page that shows no confirmation is not a success: the send happened, the outcome is unknown.
 const silent=await prepare(`${origin}/apply-silent`);
 await approve(silent.attemptId);
 const unknown=await submit(silent.attemptId);
 assert.equal(unknown.body.state,'unknown',JSON.stringify(unknown.body));
 assert.equal((await seen()).submissions,2,'the site did receive it; only the receipt is missing');
 const submissions=(await api(base,'/api/submissions')).body;
 assert.equal(submissions.awaitingReconciliation.length,1,'it awaits explicit reconciliation');
 const reconciled=await api(base,`/api/attempts/${silent.attemptId}/reconcile`,{outcome:'submitted',detail:'Found the confirmation in my email',externalId:'REF-2',receiptText:'Confirmation REF-2'});
 assert.equal(reconciled.body.state,'submitted');
 assert.equal(reconciled.body.reconciledFrom,'unknown');
 assert.equal((await seen()).submissions,2,'reconciliation never resends');
 assert.equal((await api(base,'/api/submissions')).body.awaitingReconciliation.length,0);

 // An adapter that cannot send is refused even in review mode with permission granted.
 const inProcess=await api(base,`/api/applications/${applicationId}/prepare`,{adapterId:'fixture',formUrl:`${origin}/apply`,answers:{name:'Ada',email:'ada@example.test'}});
 assert.equal(inProcess.body.state,'draft');
 const inProcessPkg=(await api(base,`/api/applications/${applicationId}/package`)).body;
 await api(base,`/api/attempts/${inProcess.body.attemptId}/approve`,{expectedManifestHash:inProcessPkg.attempt.manifest.manifestHash,reason:'ok'});
 assert.equal((await submit(inProcess.body.attemptId)).body.blocked.code,'adapter_cannot_submit');
 assert.equal((await seen()).submissions,2);

 // A site that rejects the submission is recorded as a rejection, not a success.
 const rejected=await prepare(`${origin}/apply-reject`);
 await approve(rejected.attemptId);
 const rejectedResult=await submit(rejected.attemptId);
 assert.equal(rejectedResult.body.state,'rejected',JSON.stringify(rejectedResult.body));
 assert.equal((await seen()).submissions,3);

 // A native form: preparing never presses a control that could submit, the send presses the
 // application form's own submit control (not the search form), and the confirmation is read
 // from the page the click navigated to.
 const native=await prepare(`${origin}/native`);
 let nativeSeen=await seen();
 assert.equal(nativeSeen.native,0,'preparation must not submit a native form through a submit-typed preview control');
 assert.equal(nativeSeen.searches,0);
 await approve(native.attemptId);
 const nativeSent=await submit(native.attemptId);
 assert.equal(nativeSent.body.state,'submitted',JSON.stringify(nativeSent.body));
 assert.equal(nativeSent.body.externalId,'NATIVE-1','the confirmation came from the page the submit navigated to');
 nativeSeen=await seen();
 assert.equal(nativeSeen.native,1);
 assert.equal(nativeSeen.searches,0,'the search form elsewhere on the page was never submitted');
 assert.match(nativeSeen.lastNative,/Ada Lovelace/);
 assert.match(nativeSeen.lastNative,new RegExp(`filename="resume-${applicationId.slice(0,8)}\\.txt"`));

 console.log('submission acceptance: ALL PASS');
}finally{
 for(const child of children)await stop(child);
 server.close();
 fs.rmSync(root,{recursive:true,force:true});
}
