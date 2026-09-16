import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION } from "./database.js";
import { assertRuntime } from "./config.js";
import { ArtifactStore } from "./artifacts.js";
import { createBackup, restoreBackup } from "./backup.js";

async function main():Promise<void>{
  assertRuntime();process.umask(0o077);
  const [command,arg,destination]=process.argv.slice(2);
  if(command==="restore"&&arg&&destination){restoreBackup(arg,destination);console.log("Restore verified; jobs disabled/paused and pending work requires reconciliation. Bootstrap credentials are not restored.");return;}
  if(!["inspect","backup"].includes(command??"")||(command==="backup"&&!arg))throw new Error("Usage: data-cli.js inspect | backup <new-archive-dir> | restore <archive-dir> <new-data-dir>");
  const dir=path.resolve(process.env["JOBS_DIR"]??path.join(os.homedir(),".local","share","switchboard-jobs"));
  const file=path.join(dir,"jobs.sqlite");
  if(!fs.existsSync(file))throw new Error("Jobs database does not exist; data commands never initialize a new service");
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    if(Number(db.prepare("PRAGMA user_version").get()!["user_version"])!==SCHEMA_VERSION)throw new Error("Unsupported schema for data command; use the matching app version or migrate through normal startup");
    if(command==="inspect"){
      const report=new ArtifactStore(db,dir,{readOnly:true}).inspect();console.log(JSON.stringify(report,null,2));
      if(report.sqlite.some(x=>x!=="ok")||report.foreignKeys.length||report.artifactErrors.length)process.exitCode=1;
    }else{await createBackup(db,dir,arg!);console.log("Consistent database/artifact backup complete; bootstrap secrets excluded.");}
  }finally{db.close();}
}
main().catch(error=>{console.error(error instanceof Error?error.message:"Data operation failed");process.exitCode=1;});
