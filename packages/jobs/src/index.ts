import path from "node:path";
import { assertRuntime, loadServiceConfig } from "./config.js";
import { SettingsStore } from "./store.js";
import { buildServer } from "./server.js";
import { SupervisedBrowser, browserPaths } from "./browser.js";
import { createServices } from "./services.js";

async function main(): Promise<void> {
  assertRuntime();
  process.umask(0o077);
  const {dir,config}=loadServiceConfig();
  const store=new SettingsStore(path.join(dir,"jobs.sqlite"));

  // One owned browser per service, with its own profile; a crashed run is reaped on start.
  const browser = config.browserExecutablePath
    ? new SupervisedBrowser({ executablePath: config.browserExecutablePath, ...browserPaths(dir) })
    : undefined;
  if (browser) { const reaped = await browser.reapStale(); if (reaped !== "no_record" && reaped !== "already_gone") console.log(`Supervised browser cleanup: ${reaped}`); }
  const services=createServices(config,store,dir,{browser});
  // Nothing has been sent by this process yet, so every in-flight attempt was interrupted:
  // it becomes unknown, never retried silently.
  const swept=services.submission.sweepStale({interrupted:true});
  if(swept.swept)console.log(`Unconfirmed submissions now await reconciliation: ${swept.swept}`);

  // Background discovery. It only ticks; each cycle re-reads enable/pause and the due
  // sources, so disabling jobs stops scheduling without a restart.
  const scheduler=services.scheduler;
  scheduler.start();
  const app=buildServer(config,store,dir,{services});
  try { await app.listen({host:"127.0.0.1",port:config.port}); }
  catch(error) { scheduler.stop(); await app.close(); throw error; }
  console.log(`Jobs service: http://127.0.0.1:${config.port} (discovery scheduler active; enable jobs and a source to run)`);
  console.log(`Private bootstrap configuration: ${path.join(dir,"service.json")}`);
  let closing=false;
  for(const signal of ["SIGTERM","SIGINT"] as const)process.on(signal,()=>{
    if(closing)return;closing=true;
    scheduler.stop();
    void browser?.close().catch(()=>undefined);
    void app.close().catch(()=>{process.exitCode=1;});
  });
}
main().catch(error=>{console.error(error instanceof Error?error.message:"Jobs startup failed");process.exitCode=1;});
