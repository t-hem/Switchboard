import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION } from "./database.js";
import { assertRuntime } from "./config.js";
import { ArtifactStore } from "./artifacts.js";
import { createBackup, restoreBackup } from "./backup.js";
import { healthOf, readOnlyMarker } from "./health.js";
import { Records } from "./records.js";
import { event } from "./events.js";

async function main():Promise<void>{
  assertRuntime();process.umask(0o077);
  const [command,arg,destination,flag]=process.argv.slice(2);
  if(command==="restore"&&arg&&destination){
    restoreBackup(arg,destination);
    if(flag==="--read-only"){
      // Inspect the archive without ever dispatching from it.
      fs.writeFileSync(readOnlyMarker(destination),JSON.stringify({restoredAt:new Date().toISOString(),source:path.resolve(arg),readOnly:true},null,2)+"\n",{mode:0o600});
      console.log("Restore verified read-only; a read-only marker was written, so no work can be dispatched from it.");
      return;
    }
    console.log("Restore verified; jobs disabled/paused and pending work requires reconciliation. Bootstrap credentials are not restored.");
    return;
  }
  if(!["inspect","health","backup","export-application","reconstruct"].includes(command??""))
    throw new Error("Usage: data-cli.js inspect | health | backup <new-archive-dir> | restore <archive-dir> <new-data-dir> [--read-only] | export-application <application-id> <new-export-dir> | reconstruct <export-dir>");
  if(command==="reconstruct"&&arg){const result=Records.reconstruct(arg!);console.log(JSON.stringify({verifiedArtifacts:result.verifiedArtifacts,createdAt:result.createdAt,application:result.record["application"],resumes:(result.record["resumes"] as unknown[]).length,attempts:(result.record["attempts"] as unknown[]).length,decisions:(result.record["decisions"] as unknown[]).length},null,2));return;}
  if(command==="export-application"&&(!arg||!destination))throw new Error("Usage: data-cli.js export-application <application-id> <new-export-dir>");
  const dir=path.resolve(process.env["JOBS_DIR"]??path.join(os.homedir(),".local","share","switchboard-jobs"));
  const file=path.join(dir,"jobs.sqlite");
  if(!fs.existsSync(file))throw new Error("Jobs database does not exist; data commands never initialize a new service");
  if(command==="export-application"){
    const artifacts=new ArtifactStore(new DatabaseSync(file),dir);
    const result=new Records({db:artifacts.db,artifacts}).exportApplication(arg!,destination!);
    console.log(JSON.stringify({directory:result.directory,artifacts:result.manifest.artifacts.length,recordHash:result.manifest.recordHash},null,2));
    artifacts.db.close();return;
  }
  if(command==="backup"&&arg){
    // Record the backup in the same archive, so health can state when it last happened.
    const writable=new DatabaseSync(file);
    try{event(writable,"archive.backup","database","main",{destination:path.resolve(arg)});}finally{writable.close();}
  }
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    if(Number(db.prepare("PRAGMA user_version").get()!["user_version"])!==SCHEMA_VERSION)throw new Error("Unsupported schema for data command; use the matching app version or migrate through normal startup");
    if(command==="inspect"){
      const report=new ArtifactStore(db,dir,{readOnly:true}).inspect();console.log(JSON.stringify(report,null,2));
      if(report.sqlite.some(x=>x!=="ok")||report.foreignKeys.length||report.artifactErrors.length)process.exitCode=1;
    }else if(command==="health"){const report=healthOf(db,dir);console.log(JSON.stringify(report,null,2));if(report.status==="failed")process.exitCode=1;}
    else{await createBackup(db,dir,arg!);console.log("Consistent database/artifact backup complete; bootstrap secrets excluded.");}
  }finally{db.close();}
}
main().catch(error=>{console.error(error instanceof Error?error.message:"Data operation failed");process.exitCode=1;});
