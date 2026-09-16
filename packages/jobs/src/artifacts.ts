import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AppError } from "./errors.js";

export type Artifact = {hash:string;mimeType:string;sizeBytes:number;relativePath:string;createdAt:string;purpose:string};
export const digest=(bytes:Uint8Array):string=>createHash("sha256").update(bytes).digest("hex");
export function flushDirectory(dir:string):void {
  const fd=fs.openSync(dir,"r");try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
export class ArtifactStore {
  readonly directory:string;
  readonly staging:string;
  constructor(readonly db:DatabaseSync,readonly root:string,private readonly options:{readOnly?:boolean}={}) {
    this.directory=path.join(root,"artifacts");this.staging=path.join(root,"staging");
    if(!options.readOnly){fs.mkdirSync(this.directory,{recursive:true,mode:0o700});fs.mkdirSync(this.staging,{recursive:true,mode:0o700});}
  }
  /** Hooks exist only for deterministic crash-boundary tests, never operator configuration. */
  put(bytes:Uint8Array,mimeType:string,purpose:string,boundary?:(stage:"flushed"|"published")=>void):Artifact {
    if(this.options.readOnly)throw new Error("Read-only artifact store");
    if(!mimeType || !purpose)throw new AppError("artifact_metadata","Artifact MIME type and purpose are required");
    const hash=digest(bytes),target=path.join(this.directory,hash),temp=path.join(this.staging,randomUUID());
    const fd=fs.openSync(temp,"wx",0o600);
    try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    boundary?.("flushed");
    try{
      // Hard-link publication is atomic and never overwrites an existing digest.
      try{fs.linkSync(temp,target);}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
      const existing=fs.lstatSync(target);
      if(!existing.isFile() || existing.size!==bytes.byteLength || digest(fs.readFileSync(target))!==hash)throw new AppError("artifact_corrupt","Existing artifact does not match its digest; preserved for inspection",409);
      flushDirectory(this.directory);
      boundary?.("published");
      this.db.prepare("INSERT INTO artifacts(hash,mime_type,size_bytes,relative_path,created_at,purpose) VALUES(?,?,?,?,?,?) ON CONFLICT(hash) DO NOTHING")
        .run(hash,mimeType,bytes.byteLength,`artifacts/${hash}`,new Date().toISOString(),purpose);
      return this.get(hash)!;
    }finally{fs.rmSync(temp,{force:true});flushDirectory(this.staging);}
  }
  get(hash:string):Artifact|null {
    if(!/^[a-f0-9]{64}$/.test(hash))throw new AppError("invalid_artifact","Invalid artifact digest");
    const row=this.db.prepare("SELECT * FROM artifacts WHERE hash=?").get(hash);
    return row?{hash:String(row["hash"]),mimeType:String(row["mime_type"]),sizeBytes:Number(row["size_bytes"]),relativePath:String(row["relative_path"]),createdAt:String(row["created_at"]),purpose:String(row["purpose"])}:null;
  }
  read(hash:string):Buffer {
    const artifact=this.get(hash);if(!artifact)throw new AppError("artifact_missing","Unknown artifact",404);
    if(artifact.relativePath!==`artifacts/${hash}`)throw new AppError("artifact_corrupt","Invalid artifact path",409);
    const file=path.join(this.root,artifact.relativePath);
    let bytes:Buffer;
    try{if(!fs.lstatSync(file).isFile())throw Error();bytes=fs.readFileSync(file);}
    catch{throw new AppError("artifact_missing","Artifact file is unavailable; workflow must remain blocked",409);}
    if(bytes.length!==artifact.sizeBytes || digest(bytes)!==artifact.hash)throw new AppError("artifact_corrupt","Artifact integrity check failed; workflow must remain blocked",409);
    return bytes;
  }
  inspect():{sqlite:string[];foreignKeys:unknown[];artifactErrors:{hash:string;code:string}[];unreferencedFiles:string[];stagingFiles:string[]} {
    const rows=this.db.prepare("SELECT hash FROM artifacts").all();const known=new Set(rows.map(row=>String(row["hash"])));
    const artifactErrors:{hash:string;code:string}[]=[];
    for(const hash of known){try{this.read(hash);}catch(error){artifactErrors.push({hash,code:error instanceof AppError?error.code:"artifact_unreadable"});}}
    return {sqlite:this.db.prepare("PRAGMA integrity_check").all().map(row=>String(row["integrity_check"])),
      foreignKeys:this.db.prepare("PRAGMA foreign_key_check").all(),artifactErrors,
      unreferencedFiles:(fs.existsSync(this.directory)?fs.readdirSync(this.directory):[]).filter(name=>!known.has(name)),stagingFiles:fs.existsSync(this.staging)?fs.readdirSync(this.staging):[]};
  }
}
