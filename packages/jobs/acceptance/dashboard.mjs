// Disposable services and two browser contexts; no live jobs or production daemon.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import puppeteer from 'puppeteer-core';
import {buildServer} from '../dist/server.js';
import {SettingsStore} from '../dist/store.js';
import {TaskQueue} from '../dist/queue.js';
import {Reviews} from '../dist/reviews.js';
import {ArtifactStore} from '../dist/artifacts.js';

if(!process.env.WEB_DIST || !process.env.JOBS_BROWSER_EXECUTABLE)throw Error('Set WEB_DIST to an isolated core build and JOBS_BROWSER_EXECUTABLE to installed Chrome');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jobs-dashboard-'));
const token='dashboard-fixture-token',hostToken='host-fixture-token';
const children=[];let browser,app;let logs='';
const web=createServer((req,res)=>{
 const pathname=new URL(req.url,'http://fixture').pathname;
 const file=path.resolve(process.env.WEB_DIST,'.'+(pathname==='/'?'/index.html':pathname));
 if(!file.startsWith(path.resolve(process.env.WEB_DIST)+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
 const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'};
 res.setHeader('Content-Type',mime[path.extname(file)]??'application/octet-stream');res.end(fs.readFileSync(file));
});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){for(let i=0;i<100;i++){if(await fn())return;await delay(100);}throw Error(`Timeout: ${label}`);}
async function stop(child){if(child.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}}
async function clickText(page,selector,text){await page.bringToFront();const found=await page.evaluate((selector,text)=>{
 const el=[...document.querySelectorAll(selector)].find(e=>e.textContent.includes(text));el?.click();return !!el;
},selector,text);assert.ok(found,`Control ${text}`);}
try{
 await new Promise(resolve=>web.listen(0,'127.0.0.1',resolve));
 const webUrl=`http://127.0.0.1:${web.address().port}`;
 const store=new SettingsStore(path.join(dir,'jobs.sqlite')),queue=new TaskQueue(store.db),reviews=new Reviews(store.db);
 const artifact=new ArtifactStore(store.db,dir).put(Buffer.from('Exact saved resume fixture'),'text/plain','resume');
 for(const id of ['approve','deny','request_changes']){
  queue.enqueue({id,kind:'assemble',input:{},settingsRevision:1});
  store.db.prepare("UPDATE tasks SET state='waiting_review' WHERE id=?").run(id);
  reviews.open({taskId:id,subjectType:'resume',subjectId:id,subjectVersion:'v1',title:`Review ${id}`,detail:'Compare saved facts',context:{text:'Exact draft'},artifactHash:artifact.hash,settingsRevision:1});
 }
 app=buildServer({port:0,token,allowedOrigins:[webUrl]},store,dir);
 await app.listen({port:0,host:'127.0.0.1'});
 const jobsUrl=`http://127.0.0.1:${app.server.address().port}`;
 const hosts=[];
 const install=path.join(dir,'bin');fs.mkdirSync(install);
 for(let i=0;i<3;i++){
  const root=path.join(dir,`host${i}`);fs.mkdirSync(root);
  const port=17911+i;
  fs.writeFileSync(path.join(root,'host.json'),JSON.stringify({port,token:hostToken,hostLabel:`fixture${i}`,scrollbackBytes:65536,workspaceRoots:[path.dirname(process.cwd())],pathPrepend:i===1?[install]:[],env:{}}));
  fs.writeFileSync(path.join(root,'agents.json'),JSON.stringify({updatedAt:0,agents:{bash:{cmd:'bash',args:['--norc','--noprofile','-i']}}}));
  const child=spawn(process.execPath,['packages/host/dist/index.js'],{env:{...process.env,SWITCHBOARD_DIR:root},stdio:['ignore','pipe','pipe']});
  children.push(child);child.stdout.on('data',s=>logs+=s);child.stderr.on('data',s=>logs+=s);
  const url=`http://127.0.0.1:${port}`;
  await until(async()=>{try{return(await fetch(url+'/health')).ok;}catch{return false;}},'host startup');
  hosts.push({id:`h${i}`,label:['alpha','bravo','charlie'][i],url,baseUrl:url,token:hostToken,pid:child.pid});
 }
 browser=await puppeteer.launch({headless:true,executablePath:process.env.JOBS_BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']});
 const errors=[];
 async function device(width){const context=await browser.createBrowserContext();const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width,height:844,isMobile:width<500,hasTouch:width<500});
  await page.goto(jobsUrl);await page.type('#token',token);await page.click('#connect button');await page.waitForSelector('#dashboard:not([hidden])');return page;}
 const desktop=await device(1200),phone=await device(390);
 await clickText(desktop,'#attention button','Review approve');await desktop.waitForSelector('#decision:not([hidden])');
 await clickText(phone,'#attention button','Review approve');await phone.waitForSelector('#decision:not([hidden])');
 assert.ok(await phone.$('#record-links button'));
 await clickText(desktop,'#decision button','Approve');
 await until(async()=> (await desktop.$eval('#message',e=>e.textContent)).includes('Decision recorded'),'approval');
 await clickText(phone,'#decision button','Deny');
 await until(async()=> (await phone.$eval('#message',e=>e.textContent)).includes('changed'),'stale review conflict');
 for(const [id,label] of [['deny','Deny'],['request_changes','Request changes']]){
  await clickText(phone,'#attention button',`Review ${id}`);await phone.waitForSelector('#decision:not([hidden])');
  await phone.type('#reason','Reviewed on phone');await clickText(phone,'#decision button',label);
  await until(async()=> (await phone.$eval('#message',e=>e.textContent)).includes('Decision recorded'),'decision');
 }
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM review_decisions').get().n,3);
 assert.equal(queue.get('approve').state,'waiting_review');
 const download=await fetch(`${jobsUrl}/api/artifacts/${artifact.hash}`,{headers:{Authorization:`Bearer ${token}`}});
 assert.equal(await download.text(),'Exact saved resume fixture');
 await phone.click('#diagnostics-details summary');await phone.click('#diagnostics');await until(async()=> (await phone.$eval('#diagnostics-data',e=>e.textContent)).includes('checkedAt'),'diagnostics');
 // A second device disables work against the same authoritative settings.
 await desktop.bringToFront();await desktop.$eval('#editor',e=>{const s=JSON.parse(e.value);s.enabled=true;s.paused=false;e.value=JSON.stringify(s);});
 await desktop.click('#save');await until(async()=>store.current().value.enabled,'enable preference');
 await phone.bringToFront();await phone.click('#reload');await until(async()=>JSON.parse(await phone.$eval('#editor',e=>e.value)).enabled,'shared settings');
 await phone.$eval('#editor',e=>{const s=JSON.parse(e.value);s.enabled=false;e.value=JSON.stringify(s);});await phone.click('#save');
 await until(async()=>!store.current().value.enabled,'disable preference');
 queue.enqueue({id:'blocked',kind:'prepare',input:{},settingsRevision:store.current().revision});
 const owner=queue.acquireScheduler('fixture',30000);assert.equal(queue.claim(owner),null);
 await phone.click('#disconnect');await phone.type('#token','wrong-token');await phone.click('#connect button');
 await until(async()=> (await phone.$eval('#message',e=>e.textContent)).includes('valid jobs service token'),'authentication failure');
 assert.equal(await phone.$eval('#dashboard',e=>e.hidden),true);
 // Core remains interactive across absent, online and failed Jobs connections.
 const core=await browser.newPage();core.on('pageerror',e=>errors.push(e.message));
 await core.evaluateOnNewDocument(host=>localStorage.setItem('switchboard.hosts',JSON.stringify([host])),hosts[0]);
 await core.goto(webUrl);await core.waitForSelector('button[aria-label="Settings"]');
 assert.equal(await core.$('a[href="'+jobsUrl+'"]'),null);
 await core.click('button[aria-label="Settings"]');
 await core.type('input[placeholder="https://jobs.example.ts.net"]',jobsUrl);
 await clickText(core,'button','Save Jobs connection');
 await until(async()=> (await core.evaluate(()=>document.body.innerText)).includes('Jobs online'),'online core integration');
 await clickText(core,'button','✕');assert.ok(await core.$('a[href="'+jobsUrl+'"]'));
 const link=await core.$eval('a[href="'+jobsUrl+'"]',e=>e.href);assert.ok(!link.includes(token));
 await app.close();app=null;
 await core.reload();await until(async()=> (await core.evaluate(()=>document.body.innerText)).includes('Jobs offline'),'offline entry');
 await clickText(core,'button','New session');await core.waitForSelector('select');
 console.log('PASS desktop/mobile durable reviews, stale decision conflict, verified artifact, shared disable gate, optional online/offline navigation');
 assert.deepEqual(errors,[]);
 await browser.close();browser=null;
 // Existing real-browser regressions against the same isolated build/hosts.
 const suites=process.env.CORE_SUITES?process.env.CORE_SUITES.split(','):['ui','claim','agent-sync'];
 assert.ok(suites.every(name=>['ui','claim','agent-sync'].includes(name)),'Known core suites only');
 for(const name of suites){
  // Each existing suite starts with a fresh claim; a closed browser still owns it.
  for(let i=0;i<children.length;i++){
   await stop(children[i]);
   const child=spawn(process.execPath,['packages/host/dist/index.js'],{env:{...process.env,SWITCHBOARD_DIR:path.join(dir,`host${i}`)},stdio:['ignore','pipe','pipe']});
   children[i]=child;hosts[i].pid=child.pid;
   child.stdout.on('data',s=>logs+=s);child.stderr.on('data',s=>logs+=s);
   await until(async()=>{try{return(await fetch(hosts[i].url+'/health')).ok;}catch{return false;}},'fresh host');
  }
  const child=spawn(process.execPath,[`packages/web/acceptance/${name}.mjs`],{env:{...process.env,
    APP_URL:webUrl,HOST_URL:hosts[0].url,HOST_TOKEN:hostToken,TEST_REPO:process.cwd(),OUT_DIR:dir,
    HOSTS:JSON.stringify(hosts),INSTALL_DIR:install},stdio:'inherit'});
  const [code]=await once(child,'exit');assert.equal(code,0,`${name} acceptance`);
 }
}catch(error){console.error(logs);throw error;}finally{
 await browser?.close();await app?.close();for(const child of children)await stop(child);
 await new Promise(resolve=>web.close(resolve));fs.rmSync(dir,{recursive:true,force:true});
}
