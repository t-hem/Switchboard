// Step 7a acceptance: machine-local persona diagnostics, failure isolation and adapters.
// Disposable service and data; no agent is spawned by this check.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'jobs-personas-'));
const token='personas-fixture-token-not-a-host-token';
const children=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){for(let i=0;i<150;i++){try{if(await fn())return;}catch{}await delay(100);}throw Error(`Timeout: ${label}`);}
async function stop(child){if(child&&child.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}}
async function startService(dir,port){
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
const personasDir=new URL('../personas/',import.meta.url).pathname;
try{
 const base=await startService(path.join(root,'service'),17940);
 assert.equal((await fetch(`${base}/api/personas`)).status,401);

 const settings=(await api(base,'/api/settings')).body;
 settings.value.personaDirectory=personasDir;
 await api(base,'/api/settings',{expectedRevision:settings.revision,value:settings.value},'PUT');

 const listed=await api(base,'/api/personas');
 assert.equal(listed.status,200);
 assert.deepEqual(listed.body.personas.map(p=>p.id),['resume-assembler','resume-editor']);
 assert.deepEqual(listed.body.errors,[]);
 assert.equal(listed.body.personas[0].model,'openrouter/deepseek/deepseek-v4.1-flash');
 assert.ok(listed.body.personas[0].tools.includes('finalize_resume'));
 assert.ok(!listed.body.personas[1].tools.includes('select_bullet'),'the edit pass cannot re-select bullets');
 assert.ok(listed.body.tools.some(t=>t.id==='select_bullet'&&t.version==='1'));
 assert.ok(listed.body.adapters.some(a=>a.id==='pi'&&a.capabilities.toolAllowlist===true));

 // A malformed persona is reported without taking the list or the service down.
 const broken=path.join(root,'broken-personas');
 fs.cpSync(personasDir,broken,{recursive:true});
 fs.writeFileSync(path.join(broken,'resume-editor','manifest.md'),'---\nschemaVersion: 1\nid: resume-editor\nname: Broken\n---\nBody\n');
 const current=(await api(base,'/api/settings')).body;
 current.value.personaDirectory=broken;
 await api(base,'/api/settings',{expectedRevision:current.revision,value:current.value},'PUT');
 const degraded=await api(base,'/api/personas');
 assert.equal(degraded.status,200);
 assert.deepEqual(degraded.body.personas.map(p=>p.id),['resume-assembler']);
 assert.deepEqual(degraded.body.errors.map(e=>e.id),['resume-editor']);
 assert.match(degraded.body.errors[0].message,/description/);

 // A missing directory is an empty state, not an error.
 const absent=(await api(base,'/api/settings')).body;
 absent.value.personaDirectory=path.join(root,'nothing-here');
 await api(base,'/api/settings',{expectedRevision:absent.revision,value:absent.value},'PUT');
 const empty=await api(base,'/api/personas');
 assert.deepEqual(empty.body.personas,[]);
 assert.deepEqual(empty.body.errors,[]);

 console.log('PASS persona diagnostics, model/tool exposure, malformed-persona isolation and empty state');
}catch(error){console.error(error);throw error;}finally{
 for(const child of children)await stop(child);fs.rmSync(root,{recursive:true,force:true});
}