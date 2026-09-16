// Real tmux owner + real HTTP daemon, under separate disposable systemd user services.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sw-restart-'));
const prefix=`sw-restart-${process.pid}`;
const owner=`${prefix}-owner`, daemon=`${prefix}-host`, socket=path.join(dir,'tmux.sock');
const ownerId=`test${process.pid}`, port=17889;
const run=(file,args)=>execFileSync(file,args,{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']}).trim();
const ctlAsync=(...args)=>new Promise((resolve,reject)=>execFile('/usr/bin/systemctl',['--user',...args],{timeout:15000},(err,stdout)=>err?reject(err):resolve(stdout)));
const ctl=(...args)=>run('/usr/bin/systemctl',['--user',...args]);
const tmux=(...args)=>run('/usr/bin/tmux',['-S',socket,'-N',...args]);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let i=0;i<150;i++){try{if(await fn())return;}catch{}await delay(100);}throw Error(`Timeout: ${label}`);}
const api=async(url,body,method)=>{
 const r=await fetch(`http://127.0.0.1:${port}${url}`,{method:method??(body?'POST':'GET'),headers:{Authorization:'Bearer test-token','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 if(!r.ok)throw Error(`${r.status}: ${await r.text()}`);return r.status===204?null:r.json();
};
function stream(id){
 const ws=new WebSocket(`ws://127.0.0.1:${port}/sessions/${id}/stream?token=test-token&clientId=restart-test`);
 const state={ws,out:'',controls:[]};
 ws.on('message',(data,binary)=>{if(binary)state.out+=data.toString();else state.controls.push(JSON.parse(data.toString()));});
 ws.on('error',()=>{});
 state.open=new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
 state.write=data=>ws.send(JSON.stringify({type:'input',data}));return state;
}
const sockets=[];
function start(name,args){run('/usr/bin/systemd-run',['--user',`--unit=${name}`,'--property=Type=exec','--property=RemainAfterExit=yes','--property=KillMode=mixed','--property=TimeoutStopSec=8','--',...args]);}
const cfg={port,token:'test-token',hostLabel:'restart-test',scrollbackBytes:65536,workspaceRoots:[],pathPrepend:[],env:{},sessionBackend:'tmux',tmux:{socketPath:socket,ownerId}};
fs.writeFileSync(path.join(dir,'host.json'),JSON.stringify(cfg));
fs.writeFileSync(path.join(dir,'agents.json'),JSON.stringify({updatedAt:0,agents:{bash:{cmd:'/bin/bash',args:['--norc','--noprofile','-i']},fixture:{cmd:process.execPath,args:[path.resolve('packages/host/acceptance/fixtures/tmux-agent.mjs')]}}}));
fs.writeFileSync(path.join(dir,'tmux.conf'),`set -g exit-empty off\nset -g status off\nset -g prefix None\nset -g prefix2 None\nset -g update-environment ""\nset -g remain-on-exit on\nset -g history-limit 2000\nset -g @switchboard-owner ${ownerId}\n`);
async function remove(id){await api(`/sessions/${id}`,null,'DELETE');await until(async()=> !(await api('/sessions')).some(x=>x.id===id),'confirmed delete');}
async function pause(name){await ctlAsync('kill','--kill-who=main','--signal=SIGTERM',name);await until(()=>ctl('show',name,'-p','SubState','--value')==='exited','service paused');}
async function ready(){await until(()=>api('/health'),'host health');}
try{
 start(owner,['/usr/bin/tmux','-D','-S',socket,'-f',path.join(dir,'tmux.conf')]);
 await until(()=>fs.existsSync(socket),'owner socket');fs.chmodSync(socket,0o600);
 start(daemon,['/usr/bin/env',`SWITCHBOARD_DIR=${dir}`,`PATH=${path.dirname(process.execPath)}:/usr/bin:/bin`,process.execPath,path.resolve('packages/host/dist/index.js')]);
 await ready();
 const s=await api('/sessions',{agent:'fixture',cwd:dir,label:'persistent-fixture'});
 let view=stream(s.id);sockets.push(view.ws);await view.open;
 await until(()=>view.out.includes('READY'),'initial screen');
 view.ws.send(JSON.stringify({type:'resize',cols:103,rows:31}));
 await until(async()=> (await api(`/sessions/${s.id}`)).cols===103,'resize recorded');
 const pid=s.pid;
 for(const signal of ['SIGTERM','SIGKILL']){
  ctl('kill','--kill-who=main',`--signal=${signal}`,daemon);await delay(1200);
  assert.ok(fs.existsSync(`/proc/${pid}`),'pane survives host loss');
  await ctlAsync('restart',daemon);await ready();
  assert.equal((await api(`/sessions/${s.id}`)).pid,pid);
  assert.equal((await api(`/sessions/${s.id}`)).cols,103);
  view=stream(s.id);sockets.push(view.ws);await view.open;
  await until(()=>view.out.includes('tick'),'screen reconstructed');
  view.write('hello');await until(()=>view.out.includes('hello'),'input after restart');
  assert.equal((await api('/sessions')).length,1);
  console.log(`PASS ${signal}: stable ID/PID, reconstructed screen, live input, no duplicate`);
 }
 view.write('q');await until(async()=> (await api(`/sessions/${s.id}`)).status==='exited','exit');
 assert.equal((await api(`/sessions/${s.id}`)).exitCode,23);
 await ctlAsync('restart',daemon);await ready();assert.equal((await api(`/sessions/${s.id}`)).exitCode,23);
 await remove(s.id);
 console.log('PASS real exit 23 survives restart and explicit delete removes it');
 // Both registry and tmux metadata must be sufficient to inventory survivors.
 const next=await api('/sessions',{agent:'bash',cwd:dir,label:'recover-from-owner'});
 await delay(1200);ctl('kill','--kill-who=main','--signal=SIGKILL',daemon);await delay(300);
 fs.renameSync(path.join(dir,'persistent-sessions.json'),path.join(dir,'registry.backup'));
 await ctlAsync('restart',daemon);await ready();assert.equal((await api(`/sessions/${next.id}`)).label,'recover-from-owner');
 await remove(next.id);
 await until(async()=> !(await api('/sessions')).some(x=>x.id===next.id),'cleanup');
 console.log('PASS missing registry recovered from owned tmux metadata');
 // Detached children that ignore terminal loss and TERM stay within this session scope.
 const childFile=path.join(dir,'child.pid');
 const script=path.join(dir,'descendants.sh');
 fs.writeFileSync(script, `#!/bin/bash
trap '' TERM HUP
setsid /bin/bash -c 'trap "" TERM HUP; echo $$ > "${childFile}"; while :; do sleep 1; done' &
wait
`);
 const stubborn=await api('/sessions',{agent:'bash',cwd:dir,extraArgs:[script],label:'scoped descendants'});
 await until(()=>fs.existsSync(childFile),'detached descendant');
 const childPid=Number(fs.readFileSync(childFile,'utf8'));
 await delay(1200); // poll pins the scope invocation identity
 await remove(stubborn.id);
 await until(async()=> !(await api('/sessions')).some(x=>x.id===stubborn.id),'scoped TERM/KILL cleanup');
 const alive=pid=>{try{return !/\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`,'utf8'));}catch{return false;}};
 assert.equal(alive(childPid),false,'detached grandchild is not executing');
 console.log('PASS detached TERM/HUP-ignoring descendant killed with its own scope');
 const lost=await api('/sessions',{agent:'fixture',cwd:dir,label:'socket-loss'});
 await delay(1500);
 fs.unlinkSync(socket);
 await until(async()=>Boolean((await api(`/sessions/${lost.id}`)).recovery),'socket loss visible');
 assert.ok(fs.existsSync(`/proc/${lost.pid}`));
 ctl('kill','--kill-who=main','--signal=SIGUSR1',owner);
 await until(()=>fs.existsSync(socket),'socket recreated');fs.chmodSync(socket,0o600);
 await until(async()=>!(await api(`/sessions/${lost.id}`)).recovery,'socket recovery');
 const restored=stream(lost.id);sockets.push(restored.ws);await restored.open;
 await until(()=>restored.out.includes('tick'),'reattached after socket loss');
 ctl('kill','--kill-who=main','--signal=SIGKILL',daemon);await delay(400);
 tmux('send-keys','-t',`sw-${ownerId}-${lost.id}`,'q');await delay(500);
 await ctlAsync('restart',daemon);await ready();
 await until(async()=> (await api(`/sessions/${lost.id}`)).status==='exited','exit while daemon absent');
 assert.equal((await api(`/sessions/${lost.id}`)).exitCode,23);
 await remove(lost.id);
 console.log('PASS socket loss surfaced/recovered and exit while host absent retained');
 // Fast completion must retain the workload status, including nonzero statuses.
 for(let i=0;i<24;i++){
  const fast=await api('/sessions',{agent:'bash',cwd:dir,extraArgs:['-c','exit 23'],label:'fast exit'});
  await until(async()=> (await api(`/sessions/${fast.id}`)).status==='exited','fast exit');
  assert.equal((await api(`/sessions/${fast.id}`)).exitCode,23,`fast exit ${i}`);
  await remove(fast.id);
 }
 console.log('PASS 24 immediate exits preserve status 23');
 // Refuse a second controller before it can create resources or bind HTTP.
 let secondError='';
 try { execFileSync(process.execPath,[path.resolve('packages/host/dist/index.js')],
  {env:{...process.env,SWITCHBOARD_DIR:dir},timeout:5000,stdio:['ignore','pipe','pipe']}); }
 catch(err){ secondError=String(err.stderr); }
 assert.match(secondError,/Another daemon owns persistent sessions/);
 console.log('PASS concurrent controller refused');
 // Failed spawn remains visible; its held process is explicitly terminable.
 const gates=path.join(dir,'session-start-gates');
 fs.renameSync(gates,`${gates}.backup`);fs.writeFileSync(gates,'injected failure');
 await assert.rejects(()=>api('/sessions',{agent:'fixture',cwd:dir,label:'interrupted spawn'}));
 const interrupted=(await api('/sessions')).find(x=>x.label==='interrupted spawn');
 assert.ok(interrupted?.recovery);
 fs.unlinkSync(gates);fs.renameSync(`${gates}.backup`,gates);
 await remove(interrupted.id);
 console.log('PASS failed spawn stays inventoried and can be terminated');
 // Preserve corrupt input; recovering from alternate metadata is an explicit choice.
 const retained=await api('/sessions',{agent:'fixture',cwd:dir,label:'corruption recovery'});
 await pause(daemon);
 const registry=path.join(dir,'persistent-sessions.json');
 const saved=fs.readFileSync(registry,'utf8');fs.writeFileSync(registry,'corrupt input');
 await ctlAsync('restart',daemon);await delay(800);
 assert.equal(fs.readFileSync(registry,'utf8'),'corrupt input');
 assert.ok(fs.existsSync(`/proc/${retained.pid}`));
 fs.writeFileSync(registry,saved);await ctlAsync('restart',daemon);await ready();
 assert.equal((await api(`/sessions/${retained.id}`)).pid,retained.pid);
 await remove(retained.id);
 console.log('PASS corrupt registry is preserved and workload survives repair');
 // A scope name alone is insufficient authority: a different invocation is refused.
 const guarded=await api('/sessions',{agent:'fixture',cwd:dir,label:'generation guard'});
 await pause(daemon);
 const beforeGuard=fs.readFileSync(registry,'utf8');
 const changed=JSON.parse(beforeGuard);changed.entries[0].scopeIdentity='wrong-generation';
 fs.writeFileSync(registry,JSON.stringify(changed));await ctlAsync('restart',daemon);await ready();
 await until(async()=>Boolean((await api(`/sessions/${guarded.id}`)).recovery),'scope mismatch');
 await api(`/sessions/${guarded.id}`,null,'DELETE');
 await until(async()=> (await api(`/sessions/${guarded.id}`)).recovery?.includes('Termination not confirmed'),'failed termination visible');
 assert.ok(fs.existsSync(`/proc/${guarded.pid}`),'mismatched scope was not signalled');
 assert.ok((await api('/sessions')).some(x=>x.id===guarded.id),'failed cleanup retained');
 await pause(daemon);fs.writeFileSync(registry,beforeGuard);
 await ctlAsync('restart',daemon);await ready();await remove(guarded.id);
 console.log('PASS scope generation mismatch refuses signals and retains failed cleanup');
 fs.unlinkSync(childFile);
 const ownerLoss=await api('/sessions',{agent:'bash',cwd:dir,extraArgs:[script],label:'owner loss'});
 await until(()=>fs.existsSync(childFile),'owner-loss descendant');
 const survivorPid=Number(fs.readFileSync(childFile,'utf8'));
 await pause(owner);
 await until(async()=>Boolean((await api(`/sessions/${ownerLoss.id}`)).recovery),'owner loss visible');
 assert.ok(alive(survivorPid),'detached scope survived owner stop');
 await ctlAsync('restart',owner);await until(()=>fs.existsSync(socket),'replacement owner socket');fs.chmodSync(socket,0o600);
 await remove(ownerLoss.id);
 assert.equal(alive(survivorPid),false);
 console.log('PASS lost owner retains detached workload inventory and verified cleanup');
 console.log('ALL PASS');
}catch(err){
 try{for(const entry of JSON.parse(fs.readFileSync(path.join(dir,'persistent-sessions.json'),'utf8')).entries){
 console.error('Process:',run('/bin/ps',['-o','pid,ppid,state,comm','-p',String(entry.session.pid)]));
 console.error('Screen:',tmux('capture-pane','-p','-t',entry.target));
 console.error('API state:',JSON.stringify(await api(`/sessions/${entry.session.id}`)));
 }}catch{}
 console.error('Registry at failure:' ,fs.existsSync(path.join(dir,'persistent-sessions.json'))?fs.readFileSync(path.join(dir,'persistent-sessions.json'),'utf8'):'missing');
 try{console.error('Panes:',tmux('list-panes','-a','-F','#{session_name} pid=#{pane_pid} dead=#{pane_dead} status=#{pane_dead_status} signal=#{pane_dead_signal}'));}catch{}
 try{console.error(run('/usr/bin/journalctl',['--user','-u',daemon,'-u',owner,'--no-pager','-n','45']));}catch{}
 throw err;
}finally{
 for(const ws of sockets)ws.terminate();
 try{await ctlAsync('stop',daemon);}catch{}
 // Scopes intentionally outlive either service; stop only this test namespace.
 try{const scopes=ctl('list-units','--all','--plain','--no-legend',`sw-${ownerId}-*.scope`).split('\n').map(x=>x.trim().split(/\s+/)[0]).filter(Boolean);for(const scope of scopes){try{ctl('stop',scope);}catch{}}}catch{}
 try{ctl('stop',owner);}catch{}
 fs.rmSync(dir,{recursive:true,force:true});
}
