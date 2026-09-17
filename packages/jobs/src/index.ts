import path from "node:path";
import { assertRuntime, loadServiceConfig } from "./config.js";
import { SettingsStore } from "./store.js";
import { buildServer } from "./server.js";
import { ArtifactStore } from "./artifacts.js";
import { Postings } from "./postings.js";
import { Sources } from "./sources.js";
import { Discovery } from "./discovery.js";
import { TaskQueue } from "./queue.js";
import { FetchHttpClient } from "./net.js";
import { DiscoveryScheduler } from "./scheduler.js";
import { SupervisedBrowser, browserPaths } from "./browser.js";
import { PuppeteerFormSession } from "./form.js";
import { SubmissionService } from "./submission.js";

async function main(): Promise<void> {
  assertRuntime();
  process.umask(0o077);
  const {dir,config}=loadServiceConfig();
  const store=new SettingsStore(path.join(dir,"jobs.sqlite"));

  // Background discovery worker. It only ticks; each cycle re-reads enable/pause and the
  // due sources, so disabling jobs stops scheduling without a restart.
  const artifacts=new ArtifactStore(store.db,dir);
  const sources=new Sources(store.db);
  const discovery=new Discovery(store.db,sources,new Postings(store.db,artifacts),artifacts,
    new FetchHttpClient({allowPrivate:config.allowPrivateImport===true}));
  const scheduler=new DiscoveryScheduler({store,sources,discovery,queue:new TaskQueue(store.db),owner:`jobs-worker-${process.pid}`});
  scheduler.start();

  // One owned browser per service, with its own profile; a crashed run is reaped on start.
  const browser = config.browserExecutablePath
    ? new SupervisedBrowser({ executablePath: config.browserExecutablePath, ...browserPaths(dir) })
    : undefined;
  if (browser) { const reaped = await browser.reapStale(); if (reaped !== "no_record" && reaped !== "already_gone") console.log(`Supervised browser cleanup: ${reaped}`); }
  // An attempt that was mid-send when the service stopped is unknown, never retried silently.
  const submission=new SubmissionService({store,db:store.db,artifacts,
    http:new FetchHttpClient({allowPrivate:config.allowPrivateImport===true}),
    createSession: browser ? () => new PuppeteerFormSession(browser) : undefined});
  const swept=submission.sweepStale();
  if(swept.swept)console.log(`Unconfirmed submissions now await reconciliation: ${swept.swept}`);
  const app=buildServer(config,store,dir,{browser});
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
