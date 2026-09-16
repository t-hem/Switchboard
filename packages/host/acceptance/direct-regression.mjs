// Isolated runner for the existing direct-PTY HTTP/WS and orphan acceptance suites.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-direct-'));
const port = 17888;
const env = {...process.env, SWITCHBOARD_DIR: dir, TEST_REPO: process.cwd(), PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`};
fs.writeFileSync(path.join(dir, 'host.json'), JSON.stringify({port, token:'test-token',hostLabel:'isolated',scrollbackBytes:65536,workspaceRoots:[path.dirname(process.cwd())],pathPrepend:[],env:{}}));
fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify({updatedAt:0,agents:{bash:{cmd:'bash',args:['--norc','--noprofile','-i']},survivor:{cmd:'bash',args:['--norc','--noprofile','-c',"trap '' HUP; while :; do sleep 1; done"]}}}));
const daemon = spawn(process.execPath, ['packages/host/dist/index.js'], {env, stdio:['ignore','pipe','pipe']});
let logs = ''; daemon.stdout.on('data', c => logs+=c); daemon.stderr.on('data', c => logs+=c);
async function stop() { if (daemon.exitCode === null) { const done=once(daemon,'exit'); daemon.kill('SIGTERM'); await done; } }
try {
  let up=false;
  for(let i=0;i<100;i++) {try {if((await fetch(`http://127.0.0.1:${port}/health`)).ok){up=true;break;}}catch{} await new Promise(r=>setTimeout(r,50));}
  if(!up) throw new Error(logs);
  const suite=spawn(process.execPath,['packages/host/acceptance/sessions.mjs'],{env,stdio:'inherit'});
  const [code]=await once(suite,'exit'); if(code!==0) throw new Error('sessions acceptance failed');
  await stop();
  const orphan=spawn(process.execPath,['packages/host/acceptance/orphans.mjs'],{env,stdio:'inherit'});
  const [orphanCode]=await once(orphan,'exit'); if(orphanCode!==0) throw new Error('orphans acceptance failed');
} finally {await stop(); fs.rmSync(dir,{recursive:true,force:true});}
