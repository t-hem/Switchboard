import path from "node:path";
import { assertRuntime, loadServiceConfig } from "./config.js";
import { SettingsStore } from "./store.js";
import { buildServer } from "./server.js";
import { SupervisedBrowser, browserPaths } from "./browser.js";
import { createServices } from "./services.js";
import { JobsWorker } from "./worker.js";

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

  // The background worker: discovery on its interval, queued tailoring stages, and
  // reconciliation of agent children a previous process left running. Each pass re-reads
  // enable/pause, so disabling jobs stops new work without a restart.
  const worker=new JobsWorker(services,{owner:`jobs-worker-${process.pid}`});
  const app=buildServer(config,store,dir,{services});
  try { await app.listen({host:"127.0.0.1",port:config.port}); }
  catch(error) { await app.close(); throw error; }
  worker.start();
  console.log(`Jobs service: http://127.0.0.1:${config.port} (worker active; enable jobs and a source to run)`);
  console.log(`Private bootstrap configuration: ${path.join(dir,"service.json")}`);
  let closing=false;
  for(const signal of ["SIGTERM","SIGINT"] as const)process.on(signal,()=>{
    if(closing)return;closing=true;
    // Order matters: the worker settles (agents are left running for the next start) while the
    // database is still open; the server then drains requests and closes the database; the
    // browser goes last because a draining request may still be using it.
    void (async()=>{
      try { await worker.stop(); await app.close(); }
      catch(error) { console.error("Jobs shutdown failed:",error instanceof Error?error.message:error); process.exitCode=1; }
      finally { await browser?.close().catch(()=>undefined); }
    })();
  });
}
main().catch(error=>{console.error(error instanceof Error?(error.stack??error.message):"Jobs startup failed");process.exitCode=1;});
