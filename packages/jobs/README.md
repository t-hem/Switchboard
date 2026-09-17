# Jobs service

Linux-only, optional, and independent of Switchboard. Discovery, evidence capture,
screening, resume rendering, application preparation and gated submission all run; the
model-driven tailoring pass does not yet, because its tool bridge is missing (see
[PERSONAS.md](./PERSONAS.md)). Operating procedures are in
[JOBS-OPERATIONS.md](../../JOBS-OPERATIONS.md). Initial settings are disabled/paused with
all review gates enabled. SQLite stores each settings revision; stale saves return 409.

## Install and run

Use Node **22.23.2** (`.nvmrc`; runtime currently accepts 22.23.x). From repo root:

```sh
npm run jobs:setup
npm run jobs:build
npm run jobs:test
npm run jobs:start
```

Open `http://127.0.0.1:7780`. Copy the jobs token from the private
`~/.local/share/switchboard-jobs/service.json` into the client connection field. It is
separate from the host token. Logs never print it. `JOBS_DIR` overrides the jobs data
location at startup; moving a live database through settings is not supported.
Service bootstrap (`port`, token, exact `allowedOrigins`, plus the optional
`browserExecutablePath` and `allowPrivateImport`) is machine-local and takes effect on
restart. Keep the file private. The server binds loopback; a phone requires a separate
tailnet HTTPS endpoint and its exact origin in `allowedOrigins`. No external endpoint
is provisioned by this scaffold. No applicant data goes into client storage; the
client stores only its connection token.

`browserExecutablePath` points at an already-installed Chrome/Chromium; without it URL
capture is reported unavailable (409) and manual text import still works. It is never
downloaded or started at install time. `allowPrivateImport` defaults to **false** and
refuses loopback/private/link-local targets for both fetching and browser navigation;
only an isolated local fixture should set it true.

`spawnerToken` is the **host** bearer token, kept only in this private file. It is
required for tailoring: `POST /api/tailoring` queues the stages whose agent sessions the
worker spawns through the host, and `GET /api/runs/:id` reads a run. Without it those routes return 409
`spawner_unconfigured`. The token is never returned to a client and never enters
settings or exports.

The jobs service works with Switchboard stopped. Its scheduler shell performs no
network calls and starts no processes. Spawner observation is an injected interface;
creation, durable attempt fencing and model invocation land with step 7's worker.
No provider/model fallback is implicit.

## Package boundary

These packages deliberately are **not root npm workspaces**: npm installs dependencies
of every root workspace by default, which would pull jobs/browser dependencies into
ordinary Switchboard installs and Windows setup. Jobs has its own package-lock.json,
installation, builds and tests; jobs-ui is separately buildable. Root `jobs:*` scripts
are conveniences only. `npm ci`, `npm run build` and `npm test` remain core-only.
There are no imports from host/web source into jobs, or from jobs into host/web.

The standalone client has dashboard lists, a durable review inbox, saved task/agent/
job/application details, decision history, authenticated artifact downloads and data
diagnostics. All current workflow settings can be edited/imported/exported in the
structured JSON editor. Worker/search/submission controls are visibly unavailable.
Machine bootstrap secrets remain private local files, not round-tripped through UI.

In Switchboard Settings, optionally save the Jobs service origin. The core client
stores only that origin and checks `/health`; add the Switchboard UI origin to Jobs'
`allowedOrigins` for cross-origin checks. An online service gets a Jobs link; an offline
one keeps a connection-settings entry without blocking sessions. The Jobs token is
entered in the standalone app, never placed in a link or copied from host settings.

## Dependency decisions

- Storage: built-in `node:sqlite`, verified on Node 22.23.2 / SQLite 3.51.3. This Node
  release labels it experimental; the jobs runtime is constrained to the tested minor
  line rather than assuming all Node 22 releases expose the same API. SQL uses prepared
  statements, transactions, foreign keys and a busy timeout. Schema 3 stores versioned settings, workflow evidence, task leases and durable attention items. The storage
  APIs are implemented; workflow execution remains disabled until its later stages.
- HTTP: Fastify **5.12.4**. Browser/PDF engine: `puppeteer-core` **25.11.0**, chosen for
  both page evidence and HTML-template PDF rendering. It does not install or start a
  browser. A compatible local Chrome/Chromium is explicitly configured when those
  adapters land. The browser revision used in acceptance was Chrome 153.0.8010.36.
- Typescript **5.9.3**, tsx **4.23.13**, Node types **22.18.1**. Exact direct versions
  and a separate lockfile pin dependencies. No Python runtime is installed here.

References: [Node SQLite API](https://nodejs.org/api/sqlite.html),
[Puppeteer PDF API](https://pptr.dev/api/puppeteer.page.pdf). API behavior is verified
against the pinned local runtime, not inferred from the latest Node documentation.

## API and verification

`GET /health` returns only service/version. All `/api/*` routes require the jobs bearer
token. `GET /api/settings` returns `{revision,updatedAt,value}`; `PUT /api/settings`
requires `{expectedRevision,value}` and validates the entire object without coercion
or dropping unknown fields. Errors use `{error:{code,message,fields}}`. No credentials
are returned in settings. `GET /api/status` reports actual capabilities and dispatch
state. Settings/source/integration exports never include secrets.

`GET /api/dashboard` returns up to 100 rows per list. Detail reads are
`/api/tasks/:id`, `/api/agents/:id`, `/api/jobs/:id`, `/api/applications/:id`, and
`/api/reviews/:id`. `POST /api/reviews/:id/decision` accepts `expectedVersion`,
`expectedSettingsRevision`, `decision` (`approve`, `deny`, `request_changes`) and
`reason`. Decisions require an open item, unchanged settings and a task still waiting
for review. Workflow code alone creates review items; recording approval does not
dispatch work. Saved decisions and reviewed inputs survive restart.

`GET /api/artifacts/:hash` verifies the stored bytes and forces an inert download.
`GET /api/diagnostics` caches full integrity inspection for 60 seconds and returns
`checkedAt` (UTC ISO) and `cacheTtlMs`. Cache misses still scan synchronously; this is
a repeated-request mitigation, not a background scanner for large stores.

```sh
npm run jobs:typecheck
node packages/jobs/acceptance/scaffold.mjs
# Optional real browser checks, using an already-installed matching browser:
JOBS_BROWSER_EXECUTABLE=/absolute/path/to/chrome node packages/jobs/acceptance/scaffold.mjs
# After building core web into a temporary directory:
WEB_DIST=/absolute/temporary/web-build JOBS_BROWSER_EXECUTABLE=/absolute/path/to/chrome node packages/jobs/acceptance/dashboard.mjs
```

Acceptance uses disposable data/port 17900 and checks auth, independent start/stop,
settings durability and zero calls to a configured network trap. Browser mode checks
mobile viewport, save/reload, invalid input and competing-tab revision conflicts.
Unknown database versions are refused without mutation. Physical phone/Windows tests
are separate; this service intentionally does not support Windows.

## Posting import and capture (step 5)

`GET /api/sources` lists registered adapters (with version and per-action
capabilities), configured sources and capture availability. `PUT /api/sources/:id`
validates and stores a source (`adapterId`, `sourceKey`, `config`, `enabled`); an
unknown adapter is rejected before any work exists, and `enabled` is operator intent —
saving config never silently enables a source. `POST /api/sources/:id/discover` runs one
discovery pass for an enabled source, archives each raw response as a
`source-response` artifact, and records the run. A partial/failed scan is stored as
`blocked`/`failed` and closes nothing.

Imports never create an application attempt and never submit anything:

- `POST /api/import/manual` records operator-pasted text as a `partial` snapshot with
  no screenshot and an explicit `manual` provenance note.
- `POST /api/import/url` renders the posting in the configured browser, stores the
  exact text plus a full-page PNG artifact, and records `complete` only when the text
  is substantive and no `data-capture-incomplete` marker is present. Missing browser →
  409 `browser_unavailable`; refused target → 400 `url_not_permitted`; exhausted
  retries → 503 `capture_failed`.

Dedup is on a canonicalized URL (host lowercased, query sorted, tracking parameters
and fragments stripped, trailing slash removed) and ignores the transport scheme, so a
redirect or the same canonical URL from two sources produces one posting and one
application. Evidence is write-once: `job_snapshots` cannot be updated or deleted, so a
posting that later changes or disappears stays archived. Snapshot text is rendered as
text only; captured markup is never executed.

```sh
# Real-browser import/capture acceptance against a deterministic local fixture site.
# It enables allowPrivateImport for that fixture only; the strict service asserts refusal.
JOBS_BROWSER_EXECUTABLE=/absolute/path/to/chrome node packages/jobs/acceptance/capture.mjs
```

## Discovery scheduling and screening (step 8)

`GET /api/scheduler` reports real scheduling state and recent runs; `POST /api/scheduler/run`
performs one cycle (`{force:true}` is "run now"). A background worker in the service ticks
the same gate, so the manual route can never overlap it. Due is derived from stored run
times and each source's `schedule.intervalMinutes` (default 360), so a restart never
stampedes. A cycle holds the shared scheduler lease, runs due sources one at a time, is
bounded (at most five sources, `requests.maxPostingsPerRun` per source), and records one
source's failure without stalling the others. Paging is checkpointed in
`search_runs.checkpoint_json`, so a cap or rate limit leaves a resumable `blocked` run; a
`Retry-After` from a source is honoured (capped at 30s) rather than inventing a delay.

Screening is deterministic and explainable. A source's `filters`
(`keywords`, `locations`, `remote`) are applied to each newly ingested posting:
`eligible`, `excluded` on a **definite** mismatch, or `needs_review` when the posting does
not state the field — never a mismatch for missing data. Salary is normalized in place and
**currency is never converted** (two currencies, or no currency, is `known:false` with the
raw text kept). Reasons are stored per decision in `screening_decisions`.

`GET /api/screening` lists decisions and counts; `POST /api/jobs/:id/skip` (requires a
reason), `/requeue` and `/screen` are audited operator actions. Notifications are
optional and not implemented.

```sh
node packages/jobs/acceptance/scheduling.mjs
```

## Application preparation (step 9a)

`ApplicationAdapter` is a registry contract like the others (`manual` and a deterministic
`fixture` are registered; `createApplicationAdapter(id, options)`). Capabilities are
explicit and **`submit` is separate** — the fixture reports `submit:false`, so preparation
cannot claim or perform submission. `manual` honestly declares it has no automation.

`PreparationService.prepare()` runs preflight before anything is filled: a complete posting
capture must exist and be fresh, a resume version must be selected and its artifact must
verify by size/hash, and required fields that cannot be filled block as
`unsupported_required_fields` (a partial form is never "ready"). CAPTCHA, forbidden
automation and a manual-only adapter become durable `application-handoff` inbox items
carrying the form URL, answers and resume — never a fill attempt. A successful preview
writes an immutable `application_attempts` draft row with the full manifest and a
`manifestHash`; the idempotency key is derived from the application, evidence, resume,
settings and form, so repeating a preparation reuses the same draft and creates no
duplicate. A `source_policy` revision is created with `submit:false`.

The supervised browser (`browser.ts`) is one owned Chromium with a profile under the jobs
data directory; ownership is proven by `--user-data-dir`, so a recycled PID is dropped
rather than killed, and a reaped orphan is only reported dead once observed. `form.ts`
provides the `FormSession` seam and a real Puppeteer session; `fixture-form` fills a real
form, uploads a named copy of the verified resume, and clicks only the site's own
non-submitting preview control (a `<button>`/`<input>` must be explicitly `type="button"`;
anything that could submit is never pressed while preparing). A send presses an explicitly
marked submit control, or else the submit control of the form that owns the fields — never
a search or newsletter form elsewhere on the page — and reads the confirmation from the page
the click navigated to. Routes: `GET /api/application-adapters`,
`POST /api/applications/:id/prepare`, `GET /api/applications/:id/package`,
`POST /api/applications/:id/resolve`, `POST /api/applications/:id/manual-completion`,
`POST /api/attempts/:id/approve`. Approving binds to one attempt's manifest hash;
preparing different evidence or answers cancels the prior approval. Sending is a separate, gated action: `POST /api/attempts/:id/submit` rechecks every gate
and the *effective* site policy revision at that moment, claims the intent atomically, and
records the site's own outcome (submitted, rejected or `unknown`). An unconfirmable send
becomes `unknown` with an inbox item, and so does any failure after the submit control was
pressed (a navigation, crash or timeout says nothing about what the site received); only a
failure proven to precede the press returns the attempt to `approved`; `POST /api/attempts/:id/reconcile` records the
operator's explicit outcome and never resends. `GET|PUT /api/policies` manages audited
per-site revisions (permit/forbid submission, automatic opt-in, daily cap).

`GET /api/health` reports storage health and every known gap (including "no backup has ever
been recorded"); `POST /api/queue/repair` blocks tasks whose lease expired for reconciliation (their agent
child may still be running) and never retries an interrupted submission. `GET /api/applications/:id/record` is the complete record and
`POST /api/applications/:id/export` writes a self-contained directory that
`node packages/jobs/dist/data-cli.js reconstruct <dir>` verifies with no database and no
service. `data-cli.js` also has `health`, `export-application` and
`restore <archive> <dir> --read-only`, and a read-only restore refuses every write.

The `jobs-ui` review screen (`Application preparation`) prepares, shows the package
(posting text, screenshot, source link, selected resume and its agent run, the answer set,
filled fields and uploads, what changed since the last review), approves one exact
manifest, resolves a handoff and records a manual completion. Nothing here transmits a
submission; there is deliberately no submission route yet.

```sh
npm run jobs:build
node packages/jobs-ui/build.mjs            # the service serves packages/jobs-ui/dist
node packages/jobs/acceptance/review.mjs   # routes, plus the screen with JOBS_BROWSER_EXECUTABLE
JOBS_BROWSER_EXECUTABLE=<chrome> node packages/jobs/acceptance/forms.mjs
JOBS_BROWSER_EXECUTABLE=<chrome> node packages/jobs/acceptance/submission.mjs
node packages/jobs/acceptance/records.mjs
JOBS_BROWSER_EXECUTABLE=<chrome> node packages/jobs/acceptance/rollout.mjs
```

```sh
node --test --import tsx packages/jobs/test/preparation.test.ts
```

## Career library and resume rendering (step 6)

Resumes are assembled from the operator's own bullets placed into base templates. All
library material is stored as immutable revisions:

- `GET /api/library` returns the latest revision of each profile and template, plus the
  bullets for the latest profile revision, and reports `pdfRendering: false`.
- `PUT /api/library/profile` stores a validated profile (`contact`, `summary`, confirmed
  `facts`, unverified `suggestions`). Facts and suggestions are kept separate; a
  suggestion is never rendered as a fact. Each profile revision owns its bullet set; a
  new revision carries the previous revision's current bullets forward unless the body
  sets `carryBullets: false` (which is how bullets are retired).
- `PUT /api/library/bullets` stores bullet revisions (`bulletId`, `prose`, `tags`,
  optional structured `filters`/`evidence`). Re-submitting a bullet id creates a new
  revision rather than overwriting one.
- `PUT /api/library/template` stores a base template whose sections are `facts`,
  `tags` (the profile's confirmed `skill`/`skills` facts; bullet tags are matching
  metadata and are never printed), or `bullets` with a slot `limit`. `GET /api/library/export` and
  `POST /api/library/import` move the current library (latest profiles and templates and
  each profile's current bullets) between databases and only ever append.
- `POST /api/resumes/render` (`jobSnapshotId`, optional profile/template revision)
  selects bullets deterministically by whole-term tag overlap with the job, fills the template's
  slots, stores a text artifact and writes a `resume_versions` row referencing the exact
  snapshot/profile/template revisions. Missing required facts and unfilled slots appear
  in `missing` and as an explicit omissions line. An identical re-render reuses the
  existing version; `GET /api/resumes/:id` reads one back.

**PDF is deliberately deferred.** `resume_versions.pdf_artifact_hash` exists but stays
`NULL`; `/api/status` reports `pdf: false`. Rendering produces structured source plus
exact text only, and the renderer accepts validated data — the model never writes
arbitrary markup. Persona-driven first-pass assembly and full tailoring are step 7.

```sh
node packages/jobs/acceptance/library.mjs
# Optional client check with an installed browser:
JOBS_BROWSER_EXECUTABLE=/absolute/path/to/chrome node packages/jobs/acceptance/library.mjs
```

## Personas and agent invocation (step 7a)

The shared, machine-local persona convention and the jobs-owned invocation/tool contract
are implemented, but **the personas and tools are placeholders**. `GET /api/personas`
reports the configured directory (`personaDirectory` in settings, default
`~/.switchboard/personas`), each persona's agent/model/tools/skills, per-persona errors,
the scoped tool catalogue and the invocation adapters. A malformed persona is reported
without taking the list or the service down. This route never spawns an agent.

**Read [PERSONAS.md](PERSONAS.md) for exactly what must be replaced or built for a real
run** — real persona prose, a verified model id per machine, and above all the **tool
bridge** that exposes `src/tools.ts` to an agent process. Until that bridge exists the
model cannot call the tools, and a prompt-only tool list is not an enforced restriction.
Placeholders ship in `packages/jobs/personas/`; the live copies are machine-local under
`~/.switchboard/personas/` and are never fleet-synced.

`src/worker.ts` is the service's single background worker. It holds the one scheduler
lease, runs discovery on its interval, and claims queued tasks one at a time — claims are
refused while jobs are disabled or paused. `POST /api/tailoring` queues the assembly stage;
an accepted assembly queues the edit stage. Each stage runs under a task lease that is
heartbeated while the agent runs and checked again before its result is accepted, so a
cancelled or recovered stage never takes a late result. Stopping the service never kills an
agent. On start, a new lease generation blocks everything the previous worker was running,
and each pass reconciles those stages: an unreachable host changes nothing, a live child is
waited on, a finished child's valid result is accepted without spawning again, and a dead or
unusable one is retried from the stage's saved inputs (a new run and session key, at most two
attempts).

`src/runner.ts` performs each stage: it snapshots the persona into `agent_runs`,
writes a `0700` run directory and task file, passes the invocation argv through the
host's literal `extraArgs`, polls retained exit state to a deadline, validates the
result against the run's exact snapshot/profile/template revisions (`src/agent-result.ts`:
heading, facts and skills must be what the profile renders, every bullet line must be the
stored prose of a selected revision, and the edit pass may change bullet prose only through
a declared edit whose `before` is the assembled line — the saved version is rebuilt from
stored data, never the model's copy), and saves the
build and edit resume versions with their tool events, messages and a durable review
item. A successful exit without a valid result artifact is a failed stage. Failure
modes (missing/malformed output, changed inputs, unsupported bullet, invented lines or
headings, undeclared edits, nonzero exit, lost
or hung session) are covered by fake-agent tests.

Each stage sends a generic `idempotencyKey` (`jobs:<taskId>:<stage>`) on create, so a
lost create *response* is rediscovered by key rather than spawning a second agent, and a
result whose run is no longer `running` is refused as `run_superseded`. The key is a
plain string on the host's `POST /sessions` — no jobs knowledge in the daemon.

```sh
node packages/jobs/acceptance/personas.mjs
```

## Adapter contracts and swapping providers

Every external dependency is an interface plus a registry factory. Implementations are
injected; business/workflow code never branches on a provider, and the host daemon is a
black box behind one contract.

| Contract | Registry | Selected by |
|---|---|---|
| `AgentSpawner` (`src/adapters/spawner.ts`) | `registerSpawnerProvider` / `createSpawner` | `settings.spawner.provider` |
| `AgentInvocationAdapter` (`src/invocation.ts`) | `registerInvocationAdapter` / `createInvocationAdapter` | `settings.spawner.invocationAdapter` |
| `JobSourceAdapter` (`src/adapters/source.ts`) | `registerSourceAdapter` / `createSourceAdapter` | a source's `adapterId` |
| `ApplicationAdapter`, `NotificationTransport` | — | planned (steps 9/10, 5) |

`GET /api/sources` lists source adapters; `GET /api/personas` lists invocation adapters.
Unknown provider ids are rejected when settings are saved
(`error.code: "unknown_provider"`), never silently ignored. Provider config is validated
before any work is scheduled, and secrets stay in private machine-local files, never in
settings, exports or responses.

### Add a different agent-spawning service (e.g. not Switchboard)

1. Implement `AgentSpawner` in one file: `provider`, `health`, `list`, `inspect`, and
   optionally `create`/`stop` (a spawner without control is reported as such, not faked).
2. Call `registerSpawnerProvider("<id>", options => new YourSpawner(options))`.
3. Set `spawner.provider` to `<id>` in settings.

That is the whole change. `src/runner.ts`, the API routes and the workflow need no edits,
and the same works in reverse: Switchboard does not import jobs, and jobs imports no host
source. If a different agent-spawning app replaced Switchboard tomorrow, the diff is one
adapter file. `AgentInvocationAdapter` follows the identical shape for a different CLI or
model API.

## Local data operations (schema 3)

Use the same Node 22 runtime and `JOBS_DIR` as the service:

```sh
node packages/jobs/dist/data-cli.js inspect
node packages/jobs/dist/data-cli.js backup /absolute/new/archive-directory
node packages/jobs/dist/data-cli.js restore /absolute/archive-directory /absolute/new/data-directory
node packages/jobs/scripts/document-schema.mjs # regenerate column reference after jobs:build
```

Inspection reports SQLite/FK errors, missing/corrupt artifacts, unfinished staging files
and unreferenced published files; errors return a nonzero exit status. It never cleans
up evidence automatically. Inspection/backup require an existing current-schema database and
do not generate credentials or migrate old data. Normal service startup performs tested
migrations. Backups can run while the service is open; do not copy a live SQLite file
alone. Restore verifies hashes and starts disabled/paused with pending work blocked or
unknown until explicit reconciliation. Credentials are excluded; never start both copies
as active schedulers against the same agents.

[DATABASE.md](DATABASE.md) documents every column, SQL constraint, JSON boundary,
relationship, publication order, task fence and recovery rule. Storage tests include
actual killed subprocesses and competing independent SQLite connections. No crawling,
model invocation or application delivery is enabled by this storage stage.
