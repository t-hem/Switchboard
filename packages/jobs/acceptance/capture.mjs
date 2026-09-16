// Step 5 acceptance: deterministic fixture site, a real jobs service and real Chromium.
// No external network, no live boards, no applicant data. Private targets are permitted
// only because this fixture explicitly enables the isolated development switch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import puppeteer from 'puppeteer-core';

if(!process.env.JOBS_BROWSER_EXECUTABLE)throw Error('Set JOBS_BROWSER_EXECUTABLE to installed Chrome');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'jobs-capture-'));
const token='capture-fixture-token-not-a-host-token';
let postingOne='Platform Engineer. Build reliable distributed systems with Go, Kubernetes and PostgreSQL every single day.';
let postingOneDeleted=false;
const fixture=createServer((req,res)=>{
 const url=new URL(req.url,'http://fixture');
 if(url.pathname==='/redirect/1'){res.writeHead(302,{Location:'/posting/1'});res.end();return;}
 if(url.pathname==='/posting/1'){
  if(postingOneDeleted){res.writeHead(404,{'Content-Type':'text/html'});res.end('<html><body>Gone</body></html>');return;}
  res.writeHead(200,{'Content-Type':'text/html'});
  res.end(`<html><head><title>Platform Engineer</title></head><body><h1>Platform Engineer</h1><p>${postingOne}</p><p>Escaped sample: &lt;script&gt;window.__pwned=1&lt;/script&gt;</p></body></html>`);
  return;
 }
 if(url.pathname==='/posting/2'){
  // Lazy content never resolves in the fixture: capture must report it as incomplete.
  res.writeHead(200,{'Content-Type':'text/html'});
  res.end('<html><head><title>Half</title></head><body><main data-capture-incomplete><p>Loading…</p></main></body></html>');
  return;
 }
 res.writeHead(404,{'Content-Type':'text/html'});res.end('<html><body>Not found</body></html>');
});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const fixturePort=fixture.address().port,fixtureUrl=`http://127.0.0.1:${fixturePort}`;
const children=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){for(let i=0;i<150;i++){try{if(await fn())return;}catch{}await delay(100);}throw Error(`Timeout: ${label}`);}
async function stop(child){if(child&&child.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}}
function writeService(dir,port,allowPrivate){
 fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'service.json'),JSON.stringify({port,token,allowedOrigins:[],browserExecutablePath:process.env.JOBS_BROWSER_EXECUTABLE,allowPrivateImport:allowPrivate}));
}
async function startService(dir,port){
 const child=spawn(process.execPath,[new URL('../dist/index.js',import.meta.url).pathname],{env:{...process.env,JOBS_DIR:dir},stdio:['ignore','pipe','pipe']});
 children.push(child);child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});
 await until(async()=>(await fetch(`http://127.0.0.1:${port}/health`)).ok,'jobs startup');
 return {child,url:`http://127.0.0.1:${port}`};
}
async function api(base,route,body,method){
 const response=await fetch(base+route,{method:method??(body?'POST':'GET'),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,body:await response.json()};
}
let browser;
try{
 const permissiveDir=path.join(root,'permissive');
 writeService(permissiveDir,17920,true);
 const permissive=await startService(permissiveDir,17920);
 const strictDir=path.join(root,'strict');
 writeService(strictDir,17921,false);
 const strict=await startService(strictDir,17921);

 const status=await api(permissive.url,'/api/status');
 assert.equal(status.body.capabilities.capture,true);
 assert.equal(status.body.bootstrap.allowPrivateImport,true);

 // 1. Browser capture stores exact text and a real full-page screenshot.
 const captured=await api(permissive.url,'/api/import/url',{url:`${fixtureUrl}/posting/1`,company:'Fixture Co'});
 assert.equal(captured.status,200,captured.body?.error?.message);
 assert.equal(captured.body.completeness,'complete');
 assert.ok(captured.body.screenshotHash);
 const jobId=captured.body.jobId;
 const job=await api(permissive.url,`/api/jobs/${encodeURIComponent(jobId)}`);
 assert.equal(job.body.snapshots.length,1);
 assert.match(job.body.snapshots[0].description_text,/Platform Engineer/);
 assert.match(job.body.snapshots[0].description_text,/__pwned/, 'escaped script text is archived as text');
 const image=await fetch(`${permissive.url}/api/artifacts/${captured.body.screenshotHash}`,{headers:{Authorization:`Bearer ${token}`}});
 assert.equal(image.headers.get('content-type'),'application/octet-stream');
 assert.match(image.headers.get('content-disposition'),/attachment/);
 const bytes=Buffer.from(await image.arrayBuffer());
 assert.ok(bytes.length>1000,'screenshot is a real image');
 assert.deepEqual([...bytes.subarray(0,4)],[0x89,0x50,0x4e,0x47],'PNG signature');

 // 2. A redirect and a tracking query resolve to the same posting, not a duplicate application.
 const redirected=await api(permissive.url,'/api/import/url',{url:`${fixtureUrl}/redirect/1?utm_source=mail`,company:'Fixture Co'});
 assert.equal(redirected.status,200);
 assert.equal(redirected.body.jobId,jobId);
 const dashboard=await api(permissive.url,'/api/dashboard');
 assert.equal(dashboard.body.jobs.length,1);
 assert.equal(dashboard.body.applications.length,1);

 // 3. Changing and then deleting the live posting leaves the archived version readable.
 postingOne='Platform Engineer. Build reliable distributed systems. Requirements changed: now Rust and Kafka.';
 const changed=await api(permissive.url,'/api/import/url',{url:`${fixtureUrl}/posting/1`,company:'Fixture Co'});
 assert.equal(changed.body.jobId,jobId);
 assert.notEqual(changed.body.contentHash,captured.body.contentHash);
 postingOneDeleted=true;
 const archived=await api(permissive.url,`/api/jobs/${encodeURIComponent(jobId)}`);
 assert.equal(archived.body.snapshots.length,2);
 assert.match(archived.body.snapshots.find(s=>s.content_hash===captured.body.contentHash).description_text,/PostgreSQL/);
 const archivedImage=await fetch(`${permissive.url}/api/artifacts/${captured.body.screenshotHash}`,{headers:{Authorization:`Bearer ${token}`}});
 assert.equal(archivedImage.status,200,'original screenshot survives the posting being deleted');

 // 4. Lazy/incomplete content is stored but never promoted or claimed complete.
 const partial=await api(permissive.url,'/api/import/url',{url:`${fixtureUrl}/posting/2`,company:'Fixture Co'});
 assert.equal(partial.body.completeness,'partial');
 assert.ok(partial.body.warning);
 const partialApp=await api(permissive.url,`/api/applications/${encodeURIComponent(partial.body.applicationId)}`);
 assert.equal(partialApp.body.application.state,'discovered');
 assert.equal(partialApp.body.attempts.length,0,'import never creates an application attempt');

 // 5. Manual import records text provenance without screenshot evidence; repeats dedup.
 const manual=await api(permissive.url,'/api/import/manual',{url:`${fixtureUrl}/posting/3`,company:'Fixture Co',title:'Support Engineer',descriptionText:'Help customers resolve platform issues.'});
 assert.equal(manual.status,200);
 assert.equal(manual.body.screenshotHash,null);
 const manualAgain=await api(permissive.url,'/api/import/manual',{url:`${fixtureUrl}/posting/3?ref=x`,company:'Fixture Co',title:'Support Engineer',descriptionText:'Help customers resolve platform issues.'});
 assert.equal(manualAgain.body.created,false);
 assert.equal(manualAgain.body.jobId,manual.body.jobId);

 // 6. An unreachable page fails visibly after bounded retries; nothing is invented.
 const unreachable=await api(permissive.url,'/api/import/url',{url:'http://127.0.0.1:9/posting',company:'Fixture Co'});
 assert.equal(unreachable.status,503);
 assert.equal(unreachable.body.error.code,'capture_failed');
 assert.equal(unreachable.body.error.message,'Posting page could not be loaded');

 // 7. Without the explicit fixture switch, a loopback import target is refused.
 const refused=await api(strict.url,'/api/import/url',{url:`${fixtureUrl}/posting/1`,company:'Fixture Co'});
 assert.equal(refused.status,400);
 assert.equal(refused.body.error.code,'url_not_permitted');

 // 8. Discovery through the adapter registry: dedup and a partial scan that closes nothing.
 await api(permissive.url,'/api/sources/acme',{adapterId:'fixture',sourceKey:'acme',enabled:true,config:{companyName:'Acme',boardId:'acme',fixture:{postings:[
  {id:'a1',url:'https://acme.example/jobs/a1',title:'Cloud Engineer',location:'Remote',body:'Operate Kubernetes'},
  {id:'a2',url:'https://acme.example/jobs/a2',title:'Support Engineer',location:'Austin',body:'Help customers'},
 ]}}},'PUT');
 const firstRun=await api(permissive.url,'/api/sources/acme/discover',{},'POST');
 assert.equal(firstRun.status,200);
 assert.equal(firstRun.body.created,2);
 const secondRun=await api(permissive.url,'/api/sources/acme/discover',{},'POST');
 assert.equal(secondRun.body.created,0);
 await api(permissive.url,'/api/sources/partial',{adapterId:'fixture',sourceKey:'partial',enabled:true,config:{companyName:'Partial Co',boardId:'partial',fixture:{partial:true,postings:[{id:'p1',url:'https://partial.example/1',title:'Ops',body:'Body'}]}}},'PUT');
 const partialRun=await api(permissive.url,'/api/sources/partial/discover',{},'POST');
 assert.equal(partialRun.body.complete,false);
 const afterPartial=await api(permissive.url,'/api/dashboard');
 assert.equal(afterPartial.body.jobs.length,6,'partial scan stored its posting and closed nothing');

 // 9. The dashboard renders captured text as text: archived markup never executes.
 browser=await puppeteer.launch({headless:true,executablePath:process.env.JOBS_BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']});
 const page=await browser.newPage();
 await page.goto(permissive.url);
 await page.type('#token',token);await page.click('#connect button');
 await page.waitForSelector('#dashboard:not([hidden])');
 await until(async()=> (await page.$eval('#capture-availability',e=>e.textContent))!=='','capture availability text');
 await page.$eval('#import-url-value',(element,value)=>{element.value=value;},`${fixtureUrl}/posting/1`);
 await page.type('#import-company','Fixture Co');
 await page.click('#capture-submit');
 try { await until(async()=> (await page.$eval('#message',e=>e.textContent)).includes('Captured'),'capture through UI'); }
 catch(error){ console.error('UI message:',await page.$eval('#message',e=>e.textContent),'disabled:',await page.$eval('#capture-submit',e=>e.disabled)); throw error; }
 await until(async()=>Boolean(await page.$('#record:not([hidden])')),'record shown');
 assert.equal(await page.evaluate(()=>window.__pwned),undefined,'archived markup did not execute');
 assert.ok(await page.$('#record-links button'),'artifact download controls are present');
 assert.notEqual(await page.$eval('#capture-availability',e=>e.textContent),'');

 assert.equal(Object.keys(dashboard.body).includes('searchRuns'),true);
 console.log('PASS fixture capture evidence, redirect/canonical dedup, changed+deleted postings, partial content, manual import, bounded failure, SSRF refusal, discovery dedup and inert rendering');
}catch(error){console.error(error);throw error;}finally{
 await browser?.close();for(const child of children)await stop(child);
 await new Promise(resolve=>fixture.close(resolve));fs.rmSync(root,{recursive:true,force:true});
}
