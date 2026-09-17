# Implementation handoff

Updated 2026-09-17 (third session). This is the document to read first in a new session.
[JOB-APPLICATION-PLAN.md](./JOB-APPLICATION-PLAN.md) is the authoritative staged plan and log;
[JOBS-OPERATIONS.md](./JOBS-OPERATIONS.md) is the runbook for running and recovering the add-on;
[TESTING.md](./TESTING.md) lists what is verified and what still needs hardware.

## Current state

- **Everything through step 11 is merged to `master`** (`b68bdc7`) and pushed. The merge was a
  fast-forward; **all 11 stage branches were deleted locally and on the remote**, because they
  are ancestors of `master`. There is no branch dance any more — commit to `master` again, or
  branch per change if another agent is working in the same checkout.
- The jobs add-on is complete through step 11 and **step 12 is partly done**: operating
  procedures are written (`JOBS-OPERATIONS.md`), `acceptance/rollout.mjs` verifies a fresh data
  directory end to end, the agent API-key path is verified, and the resume-selection gap that
  rehearsal exposed is fixed.
- **The one hard blocker for real, model-driven work is the tool bridge.** The runner invokes
  the agent with `[--extension <bridge>] [--tools …] @<taskfile>` and that bridge does not
  exist, so a live model cannot call the scoped draft tools and the two-pass tailored resume
  cannot run. The real `--mode json` envelope is also unverified. Everything else in the
  pipeline runs. See [packages/jobs/PERSONAS.md](./packages/jobs/PERSONAS.md).

## Next session, in order

1. **Tool bridge** (blocker above), then verify the CLI JSON envelope against a live `pi`.
2. **Finish step 12**: the full crash matrix (crash the host, crash jobs, crash both — surviving
   children stay attachable, dead children are recorded, preparation restarts from saved
   inputs), the affected host/platform/claim/browser regressions, a real posting captured in
   draft-only mode to judge page extraction and resume readability, and real phone results.
3. **Real data with the operator**: real resume/bullets/templates, real personas and prose, then
   a real two-pass tailoring smoke on a cheap model.
4. Non-plan items, unchanged: model scrape from scrollback (TODO #2), `model` on
   `POST /sessions` (#3), optional ntfy alerts (#5), `agents.json` watch/reload (#6), and the
   separate review-loop add-on ([LATER-review-loop.md](./LATER-review-loop.md)).

## Environment

- Node **22.23.2** is required (`.nvmrc`); the shell default is v20.20.2, so prefix commands
  with `source ~/.nvm/nvm.sh && nvm use 22.23.2`. Jobs entry points refuse another Node with an
  actionable message.
- Live services: `switchboard.service` and `switchboard-owner.service` active;
  `switchboard-web.timer` active. The **jobs service has no systemd unit** — start it by hand
  with `npm run jobs:start` (port 7780, its own token in `$JOBS_DIR/service.json`).
- **Never restart the tmux owner** during routine work. Restarting only `switchboard.service`
  is safe and preserves persistent sessions; three live sessions survived exactly such a
  restart on 2026-09-17 and remained attachable.
- The checkout is shared with a second agent (Claude/Codex are sometimes running here). Prefer
  non-disruptive operations; the tree is normally parked on `master`.
- The operator's two reference ZIPs (`aisuite-main.zip`, `openworker-main.zip`) must **not** be
  committed.
- Secrets: agent API keys go in `~/.switchboard/host.json` → `env` (machine-local, read **at
  startup only**; restart the host daemon after editing). `agents.json` is fleet-synced and must
  never hold secrets or machine-specific absolute paths. Details and the exact commands are in
  [JOBS-OPERATIONS.md](./JOBS-OPERATIONS.md).

## Verification status

Trust these; they were run on `master`.

- Jobs: `npm run jobs:typecheck`, **118 jobs tests**, and ten acceptances —
  `scaffold`, `scheduling`, `capture`, `library`, `personas`, `review`, `forms`, `submission`,
  `records`, `rollout` (the last four with real Chromium against loopback fixture sites).
- Host: `npm run typecheck`, **77 host tests**, plus `packages/host/acceptance/idempotency.mjs`
  and `restart.mjs` (real tmux owner, ALL PASS).
- Root: `npm test` (host), `npm run test:all` (host + jobs).

```sh
source ~/.nvm/nvm.sh && nvm use 22.23.2
npm run jobs:build && npm run jobs:typecheck && npm run jobs:test
node packages/jobs/acceptance/scaffold.mjs
node packages/jobs/acceptance/records.mjs
CHROME=/home/thomas/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome
for a in forms submission rollout review capture library personas; do
  JOBS_BROWSER_EXECUTABLE=$CHROME node packages/jobs/acceptance/$a.mjs
done
npm run typecheck && npm test
```

Not verified, and worth saying plainly: no real job board has been crawled, no real employer
form has been automated, no `tailscale serve` endpoint exists, the desktop browser has never
been opened by hand, Windows has had three runs (the last found a bug that is fixed but not
re-verified), and the phone has had one run. See TESTING.md.

## What is implemented, condensed

Linux persistent sessions (host), steps 1a–1d — all on `master`:

- `951366f` tmux feasibility; `06d3193` backend/registry foundation; `e3477b0` Linux persistent
  backend + isolated acceptance; `6d38106` real self-restart by a Switchboard-created agent;
  `dc0a5af` rollout recovery fixes and browser/offline/crash acceptance; `3cc5add` config-refresh
  and termination fixes, Node 22.23.2 pin, jobs runtime guard, `npm run test:all`. Later,
  `b3dc00f` (other agent) restored terminal scrollback and responsive input.

Jobs add-on stages 2–12 (all merged to `master`):

- **2** authenticated settings/status API, strict validation, settings revisions with
  stale-write conflicts, initial client.
- **3** schema 2: workflow entities, immutable historical inputs, foreign keys, audit events,
  task leases/generations/fences, content-addressed artifacts, online backup/restore, data CLI.
- **4** schema 3 `attention_items`, reviews and dashboard, optional core-client Jobs navigation.
- **5** `JobSourceAdapter` registry, Greenhouse + fixture adapters, SSRF-guarded HTTP client,
  canonical-URL dedup, write-once snapshot evidence, browser capture, source registry and
  discovery runs.
- **6** immutable career library (profile facts, bullets, base templates) and deterministic,
  explainable text resume rendering. **PDF deferred by operator decision.**
- **7a** machine-local personas with path containment and per-persona isolation, immutable
  persona/skill snapshots, the scoped draft tools, the `AgentInvocationAdapter` contract,
  placeholder personas. **The tool bridge is still missing — see above.**
- **7b** `TailoringRunner`: two passes, tracked `agent_runs`, persona snapshot before spawn,
  `0700` run dir + task file, argv through the host's literal `extraArgs`, deadline polling,
  strict result validation against the run's revisions, build+edit resume versions, review item.
- **7c** generic host `idempotencyKey` on `POST /sessions` (200 reuse / 201 create) persisted
  with tmux recovery metadata; jobs rediscovers a lost-response session instead of duplicating
  and refuses superseded results. No jobs knowledge in the daemon.
- **8** discovery scheduling: paginated checkpoints that resume after a cap or rate limit,
  `Retry-After`-aware backoff, restart-safe interval scheduler with a shared lease, schema-4
  append-only `screening_decisions`, and explainable filtering that never converts currency and
  never treats an unstated field as a mismatch.
- **9** application preparation: `ApplicationAdapter` registry (honest `manual`, deterministic
  `fixture`, browser-backed `fixture-form`), evidence preflight and blocking rules, immutable
  draft attempt manifests with idempotent repeat, one supervised Chromium (ownership proven by
  `--user-data-dir`, `killed` reported only after the death is observed, shared with capture),
  CAPTCHA/forbidden/manual handoffs as inbox items, manifest-hash approvals, review package,
  handoff resolution, operator-reported manual receipts, and the client review screen.
- **10** controlled submission: `policies.ts` audited per-site revisions (permit/forbid,
  automatic opt-in, daily cap), every gate and the evidence rechecked at send time, an
  atomically claimed intent so double clicks and two workers cannot both send, receipts as
  artifacts, `unknown` + explicit reconciliation for unconfirmable sends, and a startup sweep
  that turns an interrupted send into `unknown` rather than a retry.
- **11** `records.ts` (complete application record, self-contained export, offline
  `Records.reconstruct`), `health.ts` (health with named gaps, `repairQueue`), the
  health/repair/record/export routes, read-only-restore enforcement, and `data-cli` commands
  `health`, `export-application`, `reconstruct`, `restore --read-only`.
- **12 (partial)** `JOBS-OPERATIONS.md`, `acceptance/rollout.mjs` (fresh data directory end to
  end, including a jobs restart during submission ambiguity), the API-key verification, and the
  `POST /api/applications/:id/resume` fix.

## Adapter rule (operator, 2026-09-16)

Every external dependency is an interface + registry factory selected by a setting. Adding a
different agent-spawning service or CLI is **one adapter file plus a settings change** — never a
workflow/runner/route edit. The two apps stay black boxes: no host import of jobs, no jobs
import of host. Use `AgentSpawner`, `AgentInvocationAdapter`, `JobSourceAdapter` and
`ApplicationAdapter` with their registries; the recipe is in
[packages/jobs/README.md](./packages/jobs/README.md).

## Storage and implementation pointers

`database.ts` migrates version 0/1→2→3→4 transactionally; `schema.ts` owns all SQL;
`artifacts.ts` publishes and fsyncs before a database reference exists; `queue.ts` uses
owner/generation/fence and refuses unresolved-child retries; `backup.ts` uses SQLite online
backup plus a hash manifest and a disabled/paused restore; `data-cli.ts` inspects and recovers
without bootstrapping an empty service; `reviews.ts` enforces immutable review inputs and
version/settings conflicts; `screening.ts` and `policies.ts` own append-only decision history;
`submission.ts` owns the send gates and reconciliation; `records.ts`/`health.ts` own history,
export and recovery. `DATABASE.md` is generated by `packages/jobs/scripts/document-schema.mjs`,
which rewrites only the section after the `<!-- generated-schema -->` marker — the prose above
it is hand-maintained.

## Deliberate gaps (do not "tidy" these)

- No PDF output; no notifications (the durable inbox is the notification).
- No real-site application adapter: a real target needs its own adapter file. The manual
  handoff plus an operator-recorded receipt is the supported real-site path today.
- No searchable company/recruiter dashboard, analytics or interview-prep agents.
- `POST /sessions` stays claim-free; exited sessions are not auto-reaped; `label`/`extraArgs`
  exist on spawn — all three are load-bearing for callers that do not exist yet (spec §9).
- Retention is `retain-all`: no age-based pruning of submitted evidence or failed drafts.

## Historical notes (earlier sessions)

- A second agent joined on 2026-09-16, so stage work moved to branches; their terminal-display
  fixes (`b3dc00f`) were merged into the jobs stack with no conflicts, and on 2026-09-17 the
  whole stack was fast-forwarded onto `master` and the branches deleted.
- The combined acceptance runner once reused a host claim (fixed by restarting disposable hosts
  per suite) and once supplied fixture0/1/2 labels to agent-sync, which requires
  alpha/bravo/charlie (fixed).
- The storage subprocess-competition test can fail with empty stdout inside a sandbox; it passes
  outside one. Default Node 20 produces the intended actionable pretest error.
- No live agent was interrupted during the tmux migration; the self-upgrade test session was
  explicitly cleaned up.
