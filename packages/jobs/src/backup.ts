import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import { ArtifactStore, digest, flushDirectory } from "./artifacts.js";
import { SettingsStore } from "./store.js";
import { SCHEMA_VERSION, transaction } from "./database.js";
import { event } from "./events.js";

type Manifest={formatVersion:1;schemaVersion:number;createdAt:string;databaseHash:string;artifacts:{hash:string;sizeBytes:number}[]};
function writeFlushed(file:string,bytes:Uint8Array|string):void{
  const fd=fs.openSync(file,"wx",0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
function verifySqlite(db:DatabaseSync):void{
  const result=db.prepare("PRAGMA integrity_check").all();
  if(result.length!==1||result[0]!["integrity_check"]!=="ok"||db.prepare("PRAGMA foreign_key_check").all().length)throw new Error("Database integrity check failed");
}
/** SQLite's online backup captures a consistent DB; copy only its immutable artifact set. */
export async function createBackup(db:DatabaseSync,root:string,destination:string):Promise<void>{
  const target=path.resolve(destination);
  for(const reserved of ["artifacts","staging"]){const dir=path.join(path.resolve(root),reserved);if(target===dir||target.startsWith(dir+path.sep))throw new Error("Backup cannot be inside the artifact/staging store");}
  if(fs.existsSync(target))throw new Error("Backup destination already exists; never overwrite an archive");
  const staging=`${target}.partial-${randomUUID()}`;
  fs.mkdirSync(staging,{mode:0o700});
  try{
    const database=path.join(staging,"jobs.sqlite");await backup(db,database);
    fs.chmodSync(database,0o600);
    const fd=fs.openSync(database,"r");try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    const snapshot=new DatabaseSync(database,{readOnly:true});
    let hashes:{hash:string;sizeBytes:number}[],schemaVersion:number;
    try{
      verifySqlite(snapshot);schemaVersion=Number(snapshot.prepare("PRAGMA user_version").get()!["user_version"]);
      hashes=snapshot.prepare("SELECT hash,size_bytes FROM artifacts ORDER BY hash").all().map(r=>({hash:String(r["hash"]),sizeBytes:Number(r["size_bytes"])}));
      const source=new ArtifactStore(snapshot,root,{readOnly:true});
      fs.mkdirSync(path.join(staging,"artifacts"),{mode:0o700});
      for(const row of hashes)writeFlushed(path.join(staging,"artifacts",row.hash),source.read(row.hash));
    }finally{snapshot.close();}
    const manifest:Manifest={formatVersion:1,schemaVersion,createdAt:new Date().toISOString(),databaseHash:digest(fs.readFileSync(database)),artifacts:hashes};
    writeFlushed(path.join(staging,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
    flushDirectory(path.join(staging,"artifacts"));flushDirectory(staging);
    // No other process should choose the same unique destination; mkdir below reserves it.
    fs.mkdirSync(target,{mode:0o700});
    fs.renameSync(staging,target); // atomically replace our reserved empty directory
    flushDirectory(target);flushDirectory(path.dirname(target));
  }catch(error){
    // Keep partial output for diagnosis; absence/inconsistency of manifest rejects restore.
    throw new Error(`Backup incomplete; source data unchanged. Inspect ${staging}: ${error instanceof Error?error.message:"unknown error"}`);
  }
}
export function restoreBackup(source:string,destination:string):void{
  const target=path.resolve(destination);if(fs.existsSync(target))throw new Error("Restore requires a new, nonexistent data directory");
  const archive=path.resolve(source),database=path.join(archive,"jobs.sqlite");
  const raw=JSON.parse(fs.readFileSync(path.join(archive,"manifest.json"),"utf8")) as Partial<Manifest>;
  if(raw.formatVersion!==1||raw.schemaVersion!==SCHEMA_VERSION||!Array.isArray(raw.artifacts)||
      typeof raw.databaseHash!=="string"||digest(fs.readFileSync(database))!==raw.databaseHash)throw new Error("Unsupported or corrupt backup manifest/database");
  const snapshot=new DatabaseSync(database,{readOnly:true});
  let expected:{hash:string;sizeBytes:number}[];
  try{
    verifySqlite(snapshot);
    if(Number(snapshot.prepare("PRAGMA user_version").get()!["user_version"])!==raw.schemaVersion)throw new Error("Backup schema mismatch");
    expected=snapshot.prepare("SELECT hash,size_bytes FROM artifacts ORDER BY hash").all().map(r=>({hash:String(r["hash"]),sizeBytes:Number(r["size_bytes"])}));
    if(JSON.stringify(raw.artifacts)!==JSON.stringify(expected))throw new Error("Backup artifact manifest differs from its database");
    const artifacts=new ArtifactStore(snapshot,archive,{readOnly:true});
    for(const row of expected)artifacts.read(row.hash);
  }finally{snapshot.close();}
  const staging=`${target}.restore-${randomUUID()}`;fs.mkdirSync(staging,{mode:0o700});
  try{
    writeFlushed(path.join(staging,"jobs.sqlite"),fs.readFileSync(database));
    fs.mkdirSync(path.join(staging,"artifacts"),{mode:0o700});
    for(const row of expected)writeFlushed(path.join(staging,"artifacts",row.hash),fs.readFileSync(path.join(archive,"artifacts",row.hash)));
    const store=new SettingsStore(path.join(staging,"jobs.sqlite"));
    try{
      const settings=store.current();store.update(settings.revision,{...settings.value,enabled:false,paused:true},"restore");
      transaction(store.db,()=>{
        store.db.prepare(`UPDATE tasks SET state=CASE WHEN effect_class='submission' THEN 'unknown' ELSE 'blocked' END,
          fence=fence+1,lease_owner=NULL,scheduler_generation=NULL,lease_expires_at=NULL,
          error_json=?,updated_at=? WHERE state IN('queued','running','waiting_review','submitting')`)
          .run(JSON.stringify({code:"restored_archive",message:"Explicit reconciliation/review required before any resumed work"}),new Date().toISOString());
        store.db.exec("DELETE FROM scheduler_lock");
        event(store.db,"archive.restored","database","main",{databaseHash:raw.databaseHash,dispatch:"disabled",tasks:"reconciliation_required"});
      });
    }finally{store.close();}
    flushDirectory(path.join(staging,"artifacts"));flushDirectory(staging);
    fs.mkdirSync(target,{mode:0o700});
    fs.renameSync(staging,target); // atomically replace our reserved empty directory
    flushDirectory(target);flushDirectory(path.dirname(target));
  }catch(error){throw new Error(`Restore incomplete; do not start this directory. Inspect ${staging}: ${error instanceof Error?error.message:"unknown error"}`);}
}
