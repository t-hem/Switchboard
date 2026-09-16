# Implementation handoff

Updated 2026-09-16. Continue the approved JOB-APPLICATION-PLAN.md stage by stage; verify,
update docs, commit and push before the next stage. The user is away and authorized
continued work. Current session permissions are unrestricted with approval policy never.
Do not wait for routine decisions. Do not commit the user's reference ZIP archives.

## Completed and deployed

Linux persistent sessions, steps 1a–1d:

- `951366f`: independent tmux feasibility test.
- `06d3193`: backend/registry foundation.
- `e3477b0`: Linux persistent backend and isolated acceptance.
- `6d38106`: actual Switchboard-created coding agent's README fix; it tested, committed,
  built and restarted the real daemon, then continued with the same agent PID/session ID.
- `dc0a5af`: rollout recovery fixes, browser/offline/crash acceptance and documentation.

These commits are pushed. `switchboard.service`, `switchboard-owner.service` and
`switchboard-web.timer` are active. Persistent backend is enabled in machine-local
host.json. No live agent was interrupted during migration. The real self-upgrade test
session was explicitly cleaned up. Never restart the tmux owner during routine upgrades.
See LINUX-SESSIONS.md for exact recovery commands and display/ownership limitations.

`node packages/host/acceptance/restart.mjs --browser` passed all cases including crashes
in spawn/delete, delayed owner inventory, offline CLI, real Chromium takeover/resize and
mobile viewport. Root typecheck and 69 host tests passed. Physical phone and real Windows
hardware remain outstanding; Windows retains direct shutdown behavior.

## Completed stage: 2, jobs scaffold

Created `packages/jobs` (independent Linux service) and `packages/jobs-ui` (standalone
structured settings editor). They intentionally are not root npm workspaces: root npm
installation must not pull optional jobs/browser/native dependencies onto Windows/core
installs. Jobs has a separate package-lock; root `jobs:*` scripts are conveniences.

Implemented: authenticated settings/status API; strict validation; SQLite immutable
settings revisions with stale-write conflict checks; disabled scheduler shell with no
background work; replaceable spawner observation contract/factory with Switchboard
HTTP adapter and fake-alternative contract tests; initial client edits every current
workflow setting. Port/token/allowed-origin bootstrap is still a private local file.
No job search, applicant import, persona execution, agent work or submission is enabled.

Database details, including every implemented column and settings JSON field:
`packages/jobs/DATABASE.md`. Runtime/package/API details: `packages/jobs/README.md`.
Node baseline 22.23.2 (accepts 22.23.x), built-in SQLite 3.51.3; Fastify 5.12.4;
puppeteer-core 25.11.0 for future capture/PDF rendering, with no browser download/start
at install. Jobs dependency installation has completed. Jobs build and seven scaffold
unit tests passed. Browser/HTTP acceptance and a fresh core-only Linux install/build plus Windows
dependency-resolution dry run all passed. The browser harness explicitly focuses
tabs before clicking; an earlier background-tab click stalled and was corrected.

Commands (Node 22 on PATH):

```sh
npm run jobs:build
npm run jobs:test
npm run jobs:typecheck
node packages/jobs/acceptance/scaffold.mjs
# For browser mode set JOBS_BROWSER_EXECUTABLE to the already-installed Chrome path.
npm run typecheck
npm test
```

The installed Puppeteer 25 executablePath() is asynchronous. A prior browser harness
attempt supplied the printed Promise instead of the path; fixed the invocation and
reran. No product fault was found in that failed attempt.

Stage 2 is committed as `6b00ea5`. Stage 3 is verified and ready for its separate commit:
schema 2, immutable artifacts, task/scheduler fencing, audit, data CLI and backup/restore.
All 19 jobs tests and standalone HTTP/Chromium acceptance passed. Generated DATABASE.md
lists every column/constraint/trigger and explains relationships/recovery/JSON boundaries.
The schema documentation generator requires a fresh jobs build and Node 22, like jobs.

Next is step 4: optional Switchboard navigation plus separate jobs dashboard/settings,
read-only workflow lists/details/diagnostics and durable attention/review actions. Future
execution controls must remain visibly unavailable until callers exist. The current
queue is a library, not a running worker: step 7 must inventory children before recovery
and dispatch, and step 10 must apply evidence/review/site policy before send intent.
No jobs live service or external crawling/notifications/applications has been enabled.

Storage implementation: `database.ts` migrates version 0/1 to 2 transactionally;
`schema.ts` owns SQL; `artifacts.ts` publishes/fsyncs before DB references;
`queue.ts` uses owner/generation/fence and refuses unresolved-child retries;
`backup.ts` uses SQLite online backup + hash manifest and disabled/paused restore;
`data-cli.ts` provides inspect/backup/restore without bootstrapping an empty service.
Tests in `test/storage.test.ts` include real killed subprocesses and competing processes.
Keep this handoff and DATABASE.md current as each stage changes the implementation.
