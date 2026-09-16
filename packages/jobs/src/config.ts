import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

export type ServiceConfig = {port:number; token:string; allowedOrigins:string[]};
export function assertRuntime(platform = process.platform, version = process.versions.node): void {
  if (platform !== "linux") throw new Error("The jobs service is Linux-only; Switchboard itself remains cross-platform");
  if (!/^22\.23\./.test(version)) throw new Error("Jobs currently requires the verified Node 22.23.x SQLite runtime (baseline 22.23.2)");
}
export function loadServiceConfig(): {dir:string; config:ServiceConfig} {
  const dir = path.resolve(process.env["JOBS_DIR"] ?? path.join(os.homedir(), ".local", "share", "switchboard-jobs"));
  fs.mkdirSync(dir, {recursive:true,mode:0o700});
  const file = path.join(dir, "service.json");
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({port:7780,token:randomBytes(32).toString("base64url"),allowedOrigins:[]},null,2)+"\n", {mode:0o600,flag:"wx"});
  const value = JSON.parse(fs.readFileSync(file,"utf8")) as ServiceConfig;
  if (!Number.isInteger(value.port) || value.port<1 || value.port>65535 || typeof value.token!=="string" || value.token.length<24 ||
      !Array.isArray(value.allowedOrigins) || value.allowedOrigins.some(origin=>{
        try { const url=new URL(origin); return !["http:","https:"].includes(url.protocol)||url.origin!==origin; } catch { return true; }
      })) throw new Error("Invalid service.json: expected port, private token (24+ characters), and exact HTTP(S) allowedOrigins");
  return {dir,config:value};
}
