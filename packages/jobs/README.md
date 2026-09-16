# Jobs service

Linux-only, optional, and independent of Switchboard. No discovery, agents, browser
work or application submission runs yet, even if enabled. The standalone dashboard
reports that limitation. Initial settings are disabled/paused with
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
