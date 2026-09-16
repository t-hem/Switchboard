import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import puppeteer from 'puppeteer-core';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jobs-acceptance-'));
const token='acceptance-private-token-not-a-host-token';
const port=17900,base=`http://127.0.0.1:${port}`;
fs.writeFileSync(path.join(dir,'service.json'),JSON.stringify({port,token,allowedOrigins:[]}));
let child,browser;
let log='';let requests=0;
const trap=createServer((_req,res)=>{requests++;res.end('{}');});
await new Promise(resolve=>trap.listen(0,'127.0.0.1',resolve));
const trapUrl=`http://127.0.0.1:${trap.address().port}`;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){for(let i=0;i<100;i++){try{if(await fn())return;}catch{}await delay(100);}throw Error(`Timeout: ${label}`);}
const api=async(route,body)=>{const r=await fetch(base+route,{method:body?'PUT':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});assert.equal(r.status,200);return r.json();};
async function start(){child=spawn(process.execPath,[new URL('../dist/index.js',import.meta.url).pathname],{env:{...process.env,JOBS_DIR:dir},stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>{log+=x;});child.stderr.on('data',x=>{log+=x;});await until(async()=> (await fetch(base+'/health')).ok,'independent service startup');}
async function stop(){if(!child||child.exitCode!==null)return;const done=once(child,'exit');child.kill('SIGTERM');const [code]=await done;assert.equal(code,0);}
try{
 await start();
 assert.equal((await fetch(base+'/api/settings')).status,401);
 let saved=await api('/api/settings');
 assert.equal(saved.value.enabled,false);assert.equal(saved.value.paused,true);
 saved.value.spawner.baseUrl=trapUrl;
 saved=await api('/api/settings',{expectedRevision:saved.revision,value:saved.value});
 await delay(1200);assert.equal(requests,0,'disabled startup never contacts the configured spawner');
 if(process.env.JOBS_BROWSER_EXECUTABLE){
  browser=await puppeteer.launch({protocolTimeout:15000,headless:true,executablePath:process.env.JOBS_BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']});
  const page=await browser.newPage();await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
  await page.goto(base);await page.type('#token',token);await page.click('#connect button');
  await until(async()=>await page.$eval('#settings',e=>!e.hidden),'first settings page');
  const other=await browser.newPage();await other.goto(base);await until(async()=>await other.$eval('#settings',e=>!e.hidden),'second settings page');
  await page.bringToFront();
  await page.$eval('#editor',e=>{const s=JSON.parse(e.value);s.paused=false;s.enabled=true;e.value=JSON.stringify(s);});
  await page.click('#save');await until(async()=> (await page.$eval('#message',e=>e.textContent)).includes('saved'),'browser save');
  await other.bringToFront();await other.click('#save');await until(async()=> (await other.$eval('#message',e=>e.textContent)).includes('another client'),'stale tab conflict');
  await page.bringToFront();await page.$eval('#editor',e=>{const s=JSON.parse(e.value);s.enabled='invalid';e.value=JSON.stringify(s);});
  await page.click('#save');await until(async()=> (await page.$eval('#message',e=>e.textContent)).includes('validation failed'),'invalid settings rejection');
  assert.equal((await api('/api/settings')).value.enabled,true);
  await page.click('#reload');await until(async()=> !(await page.$eval('#editor',e=>e.value)).includes('invalid'),'reload valid settings');
  await delay(1000);assert.equal(requests,0,'enabling unavailable workers performs no external work');
  await page.screenshot({path:path.join(dir,'settings-mobile.png')});
  console.log('PASS standalone mobile-viewport settings editor, validation, stale-tab conflict and no external work');
 }
 const before=await api('/api/settings');await stop();await start();assert.deepEqual(await api('/api/settings'),before);
 assert.equal(requests,0);assert.ok(!log.includes(token));
 console.log('PASS independent HTTP lifecycle, auth, disabled dispatch and SQLite settings across restart');
} catch(error){console.error(log);throw error;} finally{await browser?.close();await stop();await new Promise(resolve=>trap.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
