import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { SettingsStore } from '../src/store.js';
import { ArtifactStore } from '../src/artifacts.js';
import { TaskQueue } from '../src/queue.js';
import { createBackup, restoreBackup } from '../src/backup.js';
import { defaultSettings } from '../src/settings.js';

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-storage-'));
  const file = path.join(root, 'jobs.sqlite');
  const store = new SettingsStore(file);
  t.after(() => { store.close(); fs.rmSync(root, { recursive:true, force:true }); });
  return {root,file,store,queue:new TaskQueue(store.db),artifacts:new ArtifactStore(store.db,root)};
}
function enable(store:SettingsStore) { const s=store.current(); return store.update(s.revision,{...s.value,enabled:true,paused:false}).revision; }
function legacy(file:string,conflict=false) {
  const db=new DatabaseSync(file);
  db.exec("CREATE TABLE settings_revisions(revision INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT NOT NULL,actor TEXT NOT NULL,value_json TEXT NOT NULL CHECK(json_valid(value_json))); PRAGMA user_version=1");
  db.prepare('INSERT INTO settings_revisions(created_at,actor,value_json) VALUES(?,?,?)').run('original','operator',JSON.stringify(defaultSettings()));
  if(conflict) db.exec('CREATE TABLE jobs(id TEXT)');
  db.close();
}
test('schema upgrades preserve shipped settings; failed migration rolls back all DDL', t => {
  const {root,store}=fixture(t);
  assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version,3);
  const old=path.join(root,'old.sqlite');legacy(old);
  const upgraded=new SettingsStore(old);
  assert.equal(upgraded.current().updatedAt,'original');
  assert.equal(upgraded.current().revision,1);
  assert.throws(()=>upgraded.db.exec("UPDATE settings_revisions SET actor='changed'"),/immutable/);
  upgraded.close();
  const broken=path.join(root,'broken.sqlite');legacy(broken,true);
  assert.throws(()=>new SettingsStore(broken),/already exists/);
  const db=new DatabaseSync(broken);
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,1);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='artifacts'").get(),undefined);
  db.close();
});
test('foreign keys, deduplication, immutable evidence, and complete preflight constraints', t => {
  const {store,queue}=fixture(t); const db=store.db;
  assert.throws(()=>queue.enqueue({kind:'test',input:{},settingsRevision:99}),/FOREIGN KEY/);
  db.exec("INSERT INTO jobs VALUES('job','https://example.test','dedup','Company','Role',NULL,'{}','now','now')");
  assert.throws(()=>db.exec("INSERT INTO jobs VALUES('other','https://example.test','dedup','Company','Role',NULL,'{}','now','now')"),/UNIQUE/);
  assert.throws(()=>db.exec("INSERT INTO job_snapshots VALUES('snap','job','application_preflight','now','url','url','description',NULL,'hash','1','{}','complete',NULL)"),/CHECK/);
  db.exec("INSERT INTO job_snapshots VALUES('snap','job','discovery','now','url','url','description',NULL,'hash','1','{}','partial',NULL)");
  assert.throws(()=>db.exec("DELETE FROM job_snapshots"),/immutable/);
});
test('artifacts verify bytes, deduplicate, retain failed-write evidence, and block corrupt references', t => {
  const {store,artifacts}=fixture(t);
  const a=artifacts.put(Buffer.from('original'),'text/plain','description');
  assert.equal(artifacts.put(Buffer.from('original'),'text/plain','another use').hash,a.hash);
  assert.equal(artifacts.read(a.hash).toString(),'original');
  assert.throws(()=>store.db.exec('DELETE FROM artifacts'),/immutable/);
  store.db.exec("CREATE TRIGGER reject_artifact BEFORE INSERT ON artifacts BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  assert.throws(()=>artifacts.put(Buffer.from('orphan'),'text/plain','test'),/injected failure/);
  assert.equal(artifacts.inspect().unreferencedFiles.length,1);
  fs.writeFileSync(path.join(artifacts.directory,a.hash),'tampered');
  assert.throws(()=>artifacts.read(a.hash),/integrity/);
  assert.equal(artifacts.inspect().artifactErrors[0]?.code,'artifact_corrupt');
  fs.unlinkSync(path.join(artifacts.directory,a.hash));
  assert.equal(artifacts.inspect().artifactErrors[0]?.code,'artifact_missing');
});
for(const boundary of ['flushed','published']) test(`SIGKILL after artifact ${boundary} never commits a dangling reference`,t=>{
  const {file,root,store,artifacts}=fixture(t);
  const child=spawnSync(process.execPath,['--import','tsx','test/fixtures/storage-child.ts','crash',file,root,boundary],{cwd:path.resolve(import.meta.dirname,'..'),encoding:'utf8'});
  assert.equal(child.signal,'SIGKILL',child.stderr);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n,0);
  const report=artifacts.inspect();
  assert.equal(report.stagingFiles.length,1);
  assert.equal(report.unreferencedFiles.length,boundary==='published'?1:0);
  assert.deepEqual(report.sqlite,['ok']);
});
test('scheduler ownership, pause, fencing, bounded retry, cancellation and uncertain submissions',t=>{
  const {store,queue}=fixture(t);const revision=enable(store);
  const first=queue.acquireScheduler('first',100,1000)!;
  assert.equal(queue.acquireScheduler('second',100,1001),null);
  queue.enqueue({id:'prep',kind:'prepare',input:{},settingsRevision:revision},1000);
  const claimed=queue.claim(first,100,1001)!;
  queue.heartbeat(claimed.lease,100,1002);
  const second=queue.acquireScheduler('second',1000,1101)!;
  assert.deepEqual(queue.recoverExpired(second,1101),['prep']);
  assert.throws(()=>queue.complete(claimed.lease,{},1102),/ownership/);
  queue.retry('prep','child inventory confirmed empty',1102);
  const retry=queue.claim(second,100,1103)!;
  assert.equal(retry.task.attempt,2);
  queue.fail(retry.lease,{code:'test',message:'failed'},1104);
  assert.throws(()=>queue.retry('prep','again',1105),/eligible/);
  queue.enqueue({id:'cancel',kind:'prepare',input:{},settingsRevision:revision},1105);
  const cancelled=queue.claim(second,100,1106)!;queue.cancel('cancel','operator',1107);
  assert.throws(()=>queue.complete(cancelled.lease,{},1108),/lease/);
  assert.throws(()=>queue.retry('cancel','again',1108),/eligible/);
  queue.enqueue({id:'send',kind:'send',effectClass:'submission',input:{},settingsRevision:revision},1109);
  const s=store.current();store.update(s.revision,{...s.value,paused:true});
  assert.equal(queue.claim(second,100,1110),null);
  enable(store);const send=queue.claim(second,10,1111)!;
  queue.markSubmitting(send.lease,1112);
  queue.recoverExpired(second,1122);
  assert.equal(queue.get('send')!.state,'unknown');
  assert.throws(()=>queue.retry('send','do not resend',1123),/eligible/);
  assert.equal(queue.claim(second,100,1124),null);
});
test('independent processes compete for a single scheduler and task',async t=>{
  const {store,file,queue}=fixture(t);const revision=enable(store);
  queue.enqueue({id:'only',kind:'prepare',input:{},settingsRevision:revision});
  const run=(owner:string)=>new Promise<{acquired:boolean;task?:string}>((resolve,reject)=>{
    const child=spawn(process.execPath,['--import','tsx','test/fixtures/storage-child.ts','claim',file,owner],{cwd:path.resolve(import.meta.dirname,'..')});
    let out='',err='';child.stdout.on('data',data=>out+=data);child.stderr.on('data',data=>err+=data);child.on('error',reject);
    child.on('exit',code=>{if(code!==0)reject(new Error(err));else resolve(JSON.parse(out));});
  });
  const results=await Promise.all([run('a'),run('b'),run('c')]);
  assert.equal(results.filter(r=>r.acquired).length,1);
  assert.equal(results.filter(r=>r.task==='only').length,1);
  assert.equal(queue.get('only')!.attempt,1);
});
test('consistent backup roundtrip verifies artifacts and restores disabled with pending work blocked',async t=>{
  const {root,store,artifacts,queue}=fixture(t);const revision=enable(store);
  const a=artifacts.put(Buffer.from('exact resume PDF bytes'),'application/pdf','resume');
  queue.enqueue({id:'pending',kind:'prepare',input:{},settingsRevision:revision});
  queue.enqueue({id:'send',kind:'send',effectClass:'submission',input:{},settingsRevision:revision});
  const archive=path.join(root,'archive'), restored=path.join(root,'restored');
  await createBackup(store.db,root,archive);
  restoreBackup(archive,restored);
  const copy=new SettingsStore(path.join(restored,'jobs.sqlite'));
  try {
    assert.equal(copy.current().value.enabled,false);assert.equal(copy.current().value.paused,true);
    assert.equal(new ArtifactStore(copy.db,restored).read(a.hash).toString(),'exact resume PDF bytes');
    const q=new TaskQueue(copy.db);assert.equal(q.get('pending')!.state,'blocked');assert.equal(q.get('send')!.state,'unknown');
    assert.equal(copy.db.prepare('SELECT count(*) AS n FROM scheduler_lock').get()!.n,0);
  } finally {copy.close();}
  assert.equal(store.current().value.enabled,true);
  assert.throws(()=>restoreBackup(archive,restored),/nonexistent/);
  await assert.rejects(createBackup(store.db,root,archive),/already exists/);
  fs.writeFileSync(path.join(archive,'artifacts',a.hash),'corruption');
  assert.throws(()=>restoreBackup(archive,path.join(root,'bad')),/integrity/);
  assert.equal(fs.existsSync(path.join(root,'bad')),false);
});
for(const boundary of ['uncommitted','committed']) test(`SIGKILL with ${boundary} artifact transaction preserves file-before-reference ordering`,t=>{
  const {file,root,store,artifacts}=fixture(t);
  const child=spawnSync(process.execPath,['--import','tsx','test/fixtures/storage-child.ts','transaction',file,root,boundary],{cwd:path.resolve(import.meta.dirname,'..'),encoding:'utf8'});
  assert.equal(child.signal,'SIGKILL',child.stderr);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n,boundary==='committed'?1:0);
  const report=artifacts.inspect();assert.deepEqual(report.artifactErrors,[]);
  assert.equal(report.unreferencedFiles.length,boundary==='committed'?0:1);
});
test('unresolved children prevent retry and immutable run context survives state changes',t=>{
  const {store,queue}=fixture(t);const revision=enable(store);
  queue.enqueue({id:'child-task',kind:'prepare',input:{},settingsRevision:revision},1000);
  const owner=queue.acquireScheduler('owner',1000,1000)!;
  queue.claim(owner,10,1001);
  store.db.prepare(`INSERT INTO agent_runs(id,task_id,attempt,state,spawner_provider,spawner_instance,
    run_directory,deadline_at,created_at,persona_text,skills_json,prompt_text,agent,model,tools_json,
    permissions_json,revision_hashes_json,settings_revision)
    VALUES('run','child-task',1,'unknown','fake','local','/tmp/test',2000,'now','exact persona','[]','exact prompt','fake','fake','[]','{}','{}',?)`).run(revision);
  queue.recoverExpired(owner,1012);
  assert.throws(()=>queue.retry('child-task','retry',1013),/child run/);
  assert.throws(()=>store.db.exec("UPDATE agent_runs SET persona_text='changed'"),/immutable/);
  store.db.exec("UPDATE agent_runs SET spawner_session_id='session'; UPDATE agent_runs SET state='exited'");
  assert.throws(()=>store.db.exec("UPDATE agent_runs SET spawner_session_id='replacement'"),/identity/);
  queue.retry('child-task','confirmed child exited',1014);
  assert.equal(queue.claim(owner,100,1015)!.task.attempt,2);
  assert.throws(()=>queue.enqueue({id:'child-task',kind:'prepare',input:{},settingsRevision:revision,maxAttempts:3},1016),/different inputs/);
  assert.throws(()=>store.db.exec('DELETE FROM tasks'),/retain task/);
});
test('failed completion rolls back task state and audit together',t=>{
  const {store,queue}=fixture(t);const revision=enable(store);
  queue.enqueue({id:'rollback',kind:'prepare',input:{},settingsRevision:revision},1000);
  const owner=queue.acquireScheduler('owner',1000,1000)!;const work=queue.claim(owner,100,1001)!;
  store.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON events WHEN NEW.kind='task.succeeded' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
  assert.throws(()=>queue.complete(work.lease,{result:'ok'},1002),/audit unavailable/);
  assert.equal(queue.get('rollback')!.state,'running');
  assert.equal(queue.get('rollback')!.result,null);
});
