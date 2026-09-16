import path from "node:path";
import { assertRuntime, loadServiceConfig } from "./config.js";
import { SettingsStore } from "./store.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  assertRuntime();
  process.umask(0o077);
  const {dir,config}=loadServiceConfig();
  const store=new SettingsStore(path.join(dir,"jobs.sqlite"));
  const app=buildServer(config,store,dir);
  try { await app.listen({host:"127.0.0.1",port:config.port}); }
  catch(error) { await app.close(); throw error; }
  console.log(`Jobs service: http://127.0.0.1:${config.port} (independent, no workers enabled)`);
  console.log(`Private bootstrap configuration: ${path.join(dir,"service.json")}`);
  let closing=false;
  for(const signal of ["SIGTERM","SIGINT"] as const)process.on(signal,()=>{
    if(closing)return;closing=true;
    void app.close().catch(()=>{process.exitCode=1;});
  });
}
main().catch(error=>{console.error(error instanceof Error?error.message:"Jobs startup failed");process.exitCode=1;});
