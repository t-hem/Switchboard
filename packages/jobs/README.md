# Jobs service

Linux-only, optional, and independent of Switchboard. No discovery, agents, browser
work or application submission runs in the scaffold, even if enabled. The standalone
settings editor reports that limitation. Initial settings are disabled/paused with
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
Service bootstrap (`port`, token, exact `allowedOrigins`) is machine-local and takes
effect on restart. Keep the file private. The server binds loopback; a phone requires
a separate tailnet HTTPS endpoint and its exact origin in `allowedOrigins`. No
external endpoint is provisioned by this scaffold. No applicant data goes into client
storage; the client stores only its connection token.

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

The initial client is a small static structured-settings editor. Step 4 expands it
into the planned separate dashboard and optional Switchboard navigation integration.
All current workflow settings can be edited/imported/exported now. Future controls
are not presented as functioning features. Machine bootstrap is currently edited
locally; the richer connections UI is part of step 4.

## Dependency decisions

- Storage: built-in `node:sqlite`, verified on Node 22.23.2 / SQLite 3.51.3. This Node
  release labels it experimental; the jobs runtime is constrained to the tested minor
  line rather than assuming all Node 22 releases expose the same API. SQL uses prepared
  statements, transactions, foreign keys and a busy timeout. Schema 1 stores settings;
  step 3 extends durable workflow data/artifacts/leases/backup.
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

```sh
npm run jobs:typecheck
node packages/jobs/acceptance/scaffold.mjs
# Optional real browser checks, using an already-installed matching browser:
JOBS_BROWSER_EXECUTABLE=/absolute/path/to/chrome node packages/jobs/acceptance/scaffold.mjs
```

Acceptance uses disposable data/port 17900 and checks auth, independent start/stop,
settings durability and zero calls to a configured network trap. Browser mode checks
mobile viewport, save/reload, invalid input and competing-tab revision conflicts.
Unknown database versions are refused without mutation. Physical phone/Windows tests
are separate; this service intentionally does not support Windows.
