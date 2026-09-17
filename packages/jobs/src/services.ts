import type { ServiceConfig } from "./config.js";
import type { SettingsStore } from "./store.js";
import { ArtifactStore } from "./artifacts.js";
import { FetchHttpClient, type HttpClient } from "./net.js";
import type { SupervisedBrowser } from "./browser.js";
import type { FormSession } from "./adapters/application.js";
import { PuppeteerFormSession } from "./form.js";
import { BrowserPageCapture, CaptureService } from "./capture.js";
import { Postings } from "./postings.js";
import { Sources } from "./sources.js";
import { Discovery } from "./discovery.js";
import { TaskQueue } from "./queue.js";
import { Reviews } from "./reviews.js";
import { Library } from "./library.js";
import { ResumeRenderer } from "./resume.js";
import { Applications } from "./applications.js";
import { PreparationService } from "./preparation.js";
import { SubmissionService } from "./submission.js";
import { Records } from "./records.js";
import { Screening } from "./screening.js";
import { DiscoveryScheduler } from "./scheduler.js";
import "./adapters/greenhouse.js";
import "./adapters/fixture.js";

/** Test and wiring seams; anything absent is built from the service configuration. */
export type ServiceDeps = { http?: HttpClient; capture?: CaptureService | null; now?: () => number; browser?: SupervisedBrowser; createSession?: () => FormSession };

/**
 * One instance of each service per jobs process, shared by the HTTP routes and the
 * background worker, so both see the same browser, clock, HTTP client and scheduler.
 */
export function createServices(config: ServiceConfig, store: SettingsStore, dir: string, deps: ServiceDeps = {}) {
  const db = store.db, now = deps.now, browser = deps.browser;
  const artifacts = new ArtifactStore(db, dir);
  const http = deps.http ?? new FetchHttpClient({ allowPrivate: config.allowPrivateImport === true });
  const createSession = deps.createSession ?? (browser ? () => new PuppeteerFormSession(browser) : undefined);
  const capture = deps.capture !== undefined ? deps.capture
    : config.browserExecutablePath ? new CaptureService(new BrowserPageCapture(config.browserExecutablePath, browser)) : null;
  const postings = new Postings(db, artifacts, now);
  const sources = new Sources(db, now);
  const discovery = new Discovery(db, sources, postings, artifacts, http, now);
  const queue = new TaskQueue(db);
  const library = new Library(db, now);
  return {
    config, store, db, dir, now, browser, artifacts, http, createSession, capture, postings, sources, discovery, queue, library,
    reviews: new Reviews(db),
    renderer: new ResumeRenderer(db, artifacts, library, now),
    applications: new Applications({ db, artifacts, now }),
    preparation: new PreparationService({ store, db, artifacts, http, now, createSession }),
    submission: new SubmissionService({ store, db, artifacts, http, now, createSession }),
    records: new Records({ db, artifacts, now }),
    screening: new Screening(db, now),
    scheduler: new DiscoveryScheduler({ store, sources, discovery, queue, owner: `jobs-${process.pid}`, now }),
  };
}
export type Services = ReturnType<typeof createServices>;
