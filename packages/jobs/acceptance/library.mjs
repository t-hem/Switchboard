// Step 6 acceptance: career-library revisions and structured resume rendering.
// Disposable service and data; no external network, no agents, no PDF (deferred).
// An optional real-Chromium pass checks the library editor and preview in the client.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import puppeteer from 'puppeteer-core';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'jobs-library-'));
const token='library-fixture-token-not-a-host-token';
const children=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,attempts=150){for(let i=0;i<attempts;i++){try{if(await fn())return;}catch{}await delay(100);}throw Error(`Timeout: ${label}`);}
async function stop(child){if(child&&child.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}}
async function startService(dir,port){
 fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'service.json'),JSON.stringify({port,token,allowedOrigins:[]}));
 const child=spawn(process.execPath,[new URL('../dist/index.js',import.meta.url).pathname],{env:{...process.env,JOBS_DIR:dir},stdio:['ignore','pipe','pipe']});
 children.push(child);child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});
 await until(async()=>(await fetch(`http://127.0.0.1:${port}/health`)).ok,'jobs startup');
 return {child,url:`http://127.0.0.1:${port}`};
}
async function api(base,route,body,method){
 const response=await fetch(base+route,{method:method??(body?'POST':'GET'),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,body:await response.json()};
}
const profile=(education=false)=>({contact:{name:'Ada Lovelace',email:'ada@example.com',location:'Remote',links:['https://example.com/ada']},
 summary:'Platform engineer focused on reliable distributed systems.',
 facts:[{key:'skill',value:'Kubernetes, Go, PostgreSQL',verified:true},...(education?[{key:'education',value:'BSc Mathematics',verified:true}]:[])],
 suggestions:[{key:'skill',value:'Rust',verified:false}]});
const template={name:'Base engineering',sections:[
 {id:'summary',title:'Summary',type:'facts',factKeys:['summary']},
 {id:'skills',title:'Skills',type:'tags'},
 {id:'experience',title:'Experience',type:'bullets',limit:2},
 {id:'education',title:'Education',type:'facts',factKeys:['education']},
]};
const bullets=[{bulletId:'b-go',prose:'Built Go services handling 10k requests per second.',tags:['go','kubernetes']},
 {bulletId:'b-support',prose:'Resolved customer escalations for enterprise accounts.',tags:['support']},
 {bulletId:'b-db',prose:'Tuned PostgreSQL and Kafka pipelines.',tags:['postgresql','kafka']}];
let browser;
try{
 const first=await startService(path.join(root,'first'),17930);
 const second=await startService(path.join(root,'second'),17931);

 const status=await api(first.url,'/api/status');
 assert.equal(status.body.capabilities.resumes,true);
 assert.equal(status.body.capabilities.pdf,false,'PDF rendering is deliberately not implemented yet');

 // A posting + snapshot is the render input; manual import is enough here.
 const imported=await api(first.url,'/api/import/manual',{url:'https://acme.example/1',company:'Acme',title:'Platform Engineer',
  descriptionText:'We need Go, Kubernetes and PostgreSQL experience. Kafka is a plus.'});
 const job=await api(first.url,`/api/jobs/${encodeURIComponent(imported.body.jobId)}`);
 const snapshotId=job.body.snapshots[0].id;

 assert.equal((await api(first.url,'/api/library/profile',{profileId:'primary',data:{contact:{}}},'PUT')).status,400);
 const profileRevision=(await api(first.url,'/api/library/profile',{profileId:'primary',data:profile()},'PUT')).body;
 assert.equal(profileRevision.revision,1);
 const bulletRevisions=(await api(first.url,'/api/library/bullets',{profileRevisionId:profileRevision.id,bullets},'PUT')).body;
 assert.equal(bulletRevisions.length,3);
 assert.equal((await api(first.url,'/api/library/template',{templateId:'base',data:template},'PUT')).status,200);

 const rendered=(await api(first.url,'/api/resumes/render',{jobSnapshotId:snapshotId},'POST')).body;
 assert.equal(rendered.created,true);
 assert.match(rendered.text,/Ada Lovelace/);
 assert.match(rendered.text,/ada@example\.com/);
 assert.match(rendered.text,/EXPERIENCE/);
 assert.match(rendered.text,/Omissions: Education: education/,'omissions are visible, not invented');
 assert.doesNotMatch(rendered.text,/Rust/,'unverified suggestions are never rendered as facts');
 assert.equal(rendered.structured.sections.find(s=>s.id==='experience').lines.length,2);
 assert.ok(rendered.selectedBullets.some(b=>b.matched.length>0),'selection explains matched tags');

 const reused=(await api(first.url,'/api/resumes/render',{jobSnapshotId:snapshotId},'POST')).body;
 assert.equal(reused.created,false);
 assert.equal(reused.resumeVersionId,rendered.resumeVersionId);

 // Editing bullets creates new revisions; the earlier resume version is unchanged.
 const profile2=(await api(first.url,'/api/library/profile',{profileId:'primary',data:profile(true)},'PUT')).body;
 assert.equal(profile2.revision,2);
 await api(first.url,'/api/library/bullets',{profileRevisionId:profile2.id,bullets:[
  {bulletId:'b-go',prose:'Led Go platform migrations for Kubernetes clusters.',tags:['go','kubernetes']},
  {bulletId:'b-db',prose:'Tuned PostgreSQL and Kafka pipelines.',tags:['postgresql','kafka']},
 ]},'PUT');
 const edited=(await api(first.url,'/api/resumes/render',{jobSnapshotId:snapshotId},'POST')).body;
 assert.notEqual(edited.resumeVersionId,rendered.resumeVersionId);
 assert.match(edited.text,/BSc Mathematics/);
 assert.doesNotMatch(edited.text,/Omissions:/);
 const original=await api(first.url,`/api/resumes/${encodeURIComponent(rendered.resumeVersionId)}`);
 assert.match(original.body.text,/Built Go services/,'the earlier version still reads the same');

 // Library JSON round-trips into a fresh service as new revisions.
 const exported=await api(first.url,'/api/library/export');
 assert.equal(exported.body.profiles.length,1);
 const imported2=await api(second.url,'/api/library/import',{payload:exported.body});
 assert.deepEqual(imported2.body,{profiles:1,bullets:2,templates:1});
 const secondLibrary=await api(second.url,'/api/library');
 assert.equal(secondLibrary.body.profiles[0].data.contact.name,'Ada Lovelace');
 assert.equal(secondLibrary.body.bullets.length,2);
 assert.equal((await api(second.url,'/api/library/import',{payload:{schemaVersion:9}})).status,400);

 const dashboard=await api(first.url,'/api/dashboard');
 assert.ok(Array.isArray(dashboard.body.resumes)&&dashboard.body.resumes.length>=1);
 assert.ok(Array.isArray(dashboard.body.snapshots)&&dashboard.body.snapshots.length>=1);
 assert.equal(dashboard.body.counts.resume_versions>=1,true);
 assert.equal(dashboard.body.resumes.find(r=>r.id===rendered.resumeVersionId).pdf_artifact_hash,null,'PDF output is deferred');

 if(process.env.JOBS_BROWSER_EXECUTABLE){
  browser=await puppeteer.launch({headless:true,executablePath:process.env.JOBS_BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']});
  const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(first.url);await page.type('#token',token);await page.click('#connect button');
  await page.waitForSelector('#dashboard:not([hidden])');
  await until(async()=> (await page.$eval('#library-summary',e=>e.textContent)).includes('profile(s)'),'library summary');
  await until(async()=> (await page.$$eval('#render-snapshot option',options=>options.length))>0,'snapshot options');
  await page.select('#render-profile',profile2.id);
  await page.click('#render-form button');
  await until(async()=> (await page.$eval('#render-text',e=>e.textContent)).includes('Ada Lovelace'),'rendered preview');
  assert.match(await page.$eval('#render-note',e=>e.textContent),/Resume version/);
  assert.ok((await page.$$eval('#render-bullets p',rows=>rows.length))>=2,'selected bullets are explained');
  assert.deepEqual(errors,[]);
  console.log('PASS career-library revisions, deterministic render, preserved history and client preview (Chromium)');
 }
 if(!process.env.JOBS_BROWSER_EXECUTABLE)console.log('PASS career-library revisions, deterministic render, preserved history and JSON round-trip (HTTP)');
}catch(error){console.error(error);throw error;}finally{
 await browser?.close();for(const child of children)await stop(child);fs.rmSync(root,{recursive:true,force:true});
}
