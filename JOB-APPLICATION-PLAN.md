# Job application add-on — implementation plan

Status: approved for implementation by Thomas on 2026-09-16. Proceed stage by stage,
verify, commit and update this log; no routine phase-boundary pause is required.
Prepared 2026-09-15; revised 2026-09-16 from operator clarification and reference review.
Implementation is underway, starting with Linux persistent sessions.

## Outcome and boundaries

First, let a Switchboard agent work on Switchboard itself on Linux: build, verify,
commit, restart the host daemon, reconnect to the same running agent, and continue.
Windows retains its current terminate-on-daemon-shutdown behavior.

Then build a single-machine job search and application add-on: discover postings,
filter and deduplicate them, tailor truthful resumes from a local facts/bullet library,
prepare and optionally submit applications, surface blocks, and preserve exactly what
was applied to and sent. SQLite owns structured state; immutable local files own large
artifacts. Job settings and workflow screens are accessible from the Switchboard UI.

The add-on lives in this repository but runs as a separate service. The host daemon
must not acquire a jobs database, browser automation, scheduling, resume generation,
or job-specific routes. Integration is HTTP plus a small, isolated client feature.
No fleet synchronization of applicant data, local paths, browser profiles or secrets.

This deliberately revises the existing spec's requirement that pipelines live outside
*this repo*, and its ban on job functionality in the client. Retain its architectural
intent: separate runtime, dependencies, persistence and business logic. Record these
narrow revisions in `switchboard-spec.md` and `CLAUDE.md` when implementation starts;
do not quietly ignore conflicting instructions. The review-loop add-on described in `LATER-review-loop.md` remains a future sibling
add-on in this same project; this plan must preserve its integration path without
implementing it now.

## Findings that shape the plan

- `packages/host/src/sessions.ts` directly owns `node-pty`, an in-memory session map
  and byte rings. `index.ts` kills and awaits sessions on SIGINT/SIGTERM. A PID alone
  cannot recover a lost PTY; removing shutdown kills is not a solution.
- `platform/` already isolates spawn, termination and identity behavior. Keep that
  seam; add a session-backend abstraction rather than tmux branches throughout shared code.
- `ledger.ts` records verified process identities but treats write failure as harmless,
  drops unidentifiable entries, and removes live metadata when the process exits.
  Those choices are insufficient as the only recovery registry for persistent sessions.
- The current delete path removes a session from the map before death is confirmed.
  Persistent-session work must keep failed/in-progress termination discoverable.
- `switchboard-spec.md` §9 already proposes Linux tmux support and a claim-free
  scrollback read endpoint. `POST /sessions`, `label`, `extraArgs` and retained exited
  sessions are existing integration contracts, not gaps to redesign.
- The WS terminal route is claim-gated. A background worker must never steal the
  browser claim or infer structured job results from ANSI terminal output.
- README documents a systemd user service and `KillMode=mixed`. A tmux server in the
  daemon's service cgroup is not adequate isolation; prove the actual service restart.
- The web UI is React/Vite with settings in `components/Settings.tsx`; fleet settings
  and agent config sync already have independent ownership. Keep job settings separate.
- Root workspace scripts enumerate only host/web, and root `npm test` only tests host.
  New package tests must be wired explicitly into the verification commands.
- `TESTING.md` records Linux automation and incomplete Windows/hardware checks.
  Do not present Linux fakes as proof of actual Windows execution.
- The inspected shell uses Node 20.20.2; this project requires Node 22+. No tmux was
  found on the current PATH. Resolve these prerequisites during step 1a.
- Building the default web output publishes to the currently served directory on this
  machine. Acceptance builds must use an isolated output directory until rollout.

Read before implementation: `CLAUDE.md`, `switchboard-spec.md`, `TESTING.md`,
`README.md`, both packages' `acceptance/README.md`, and the relevant source/tests.
Preserve strict TypeScript, ESM with host `.js` imports, npm workspaces, `node:test`
for real logic, browser acceptance scripts rather than UI unit tests, and stdout logging.

## Delivery discipline — applies to every step below

1. Start with a clean understanding of `git status`; preserve unrelated user changes.
2. Implement only the named slice. Add meaningful tests for its failure modes and
   update documentation alongside changed contracts. Use fake agents and local job
   fixtures by default, never real applications in unattended acceptance tests.
3. Run affected package tests, `npm run typecheck`, and relevant acceptance harnesses
   against throwaway directories/ports. Build host as needed; build web into a temporary
   output directory, not the live `packages/web/dist`. Record exact commands/results.
4. Check the step's acceptance criteria. A failing or skipped required criterion means
   the step is incomplete. Record hardware limitations separately rather than claiming
   an unperformed check passed.
5. Commit the verified slice **before beginning the next step**; record commit hash,
   verification and any remaining limitation in this document's implementation log.
   Follow the repo's commit/push convention when executing the approved plan. Do not
   combine several unverified steps into one commit. Stop at phase review boundaries
   specified by the repo; this does not require confirmation for every routine choice.
6. Each commit must leave the previous workflow usable. A failed experimental backend
   remains opt-in. Database upgrades require backup/restore, not blind code rollback.

Steps 1a–1d are the first priority and collectively complete the self-hosting requirement.
No job feature implementation starts until 1d passes. Each substep gets its own commit.

## Step 1a — prove Linux PTY ownership and choose the recovery contract

**Scope:** an isolated tmux feasibility/acceptance harness and a short architecture
record. No production session behavior changes yet.

Use a dedicated Switchboard tmux server, separate from the user's normal tmux server,
with a private socket and controlled config. Keep node-pty as the browser-facing PTY
by attaching a tmux client through it. Windows and other POSIX platforms keep direct
PTYs. Prefer tmux over writing a new long-lived PTY broker for this first implementation.

The tmux server must be supervised separately from the HTTP daemon: a Linux user
service with an independent cgroup and lifecycle, no stop/restart propagation from
`switchboard.service`. Document a machine-local setup recipe consistent with README;
do not hardcode this machine's paths in a committed unit. Do not depend on `nohup`,
`unref`, or a change to KillMode alone. Test clean environments and user-service lifetime.

Prove before committing to the backend: direct argv handling (spaces/metacharacters),
per-session environment rather than stale tmux server environment, resize, Ctrl-C,
Unicode, alternate-screen TUIs, disabled tmux prefix interception/status bar, output
while detached, and exit status retention with dead panes. Pin a tested minimum tmux
version and feature-detect it. Missing/unsupported tmux must be actionable, not a silent
fallback that claims restart survival.

**Acceptance/verification:** in a temporary socket/config, the same agent PID and
creation identity survive both HTTP daemon SIGTERM and SIGKILL; an actual isolated
systemd user-service restart preserves the session. Reattach, type a marker and see
its reply. Separate negative test: stopping the PTY owner ends the sessions and reports
loss honestly. Record whether replay restores rendered screen/history or raw bytes;
tmux redraws are not the original agent byte stream. If fidelity is unacceptable,
revise this decision before proceeding, not halfway through the pipeline.

**Commit:** `test(host): prove Linux persistent session lifecycle`.

## Step 1b — introduce the backend seam and persistent-session registry

**Scope:** `sessions.ts`, `platform/`, lifecycle types, ledger tests, architecture docs.

Define a small injected `SessionBackend` interface: create, list/recover, attach output,
write, resize, terminate and disconnect. Keep `ProcessOps` for process identity and
platform termination details. Select the backend once in the platform composition
layer: Linux direct or tmux; Windows direct only; other POSIX direct unchanged.
Preserve API compatibility where possible; make asynchronous creation explicit if needed.

Add machine-local `host.json` session-backend settings, initially defaulting to direct
until the migration in 1d. A backend change applies to new sessions only; never abandon
existing sessions by switching a setting. Keep each session's backend recorded.

For tmux sessions use versioned registry entries with stable Switchboard ID, backend,
private server identity/socket reference, tmux session/pane ID, agent identity, cwd,
label, geometry, timestamps, process identity including boot identity, lifecycle state
and eventual exit status. No prompts, conversation or terminal history on disk.
Store matching ownership metadata in tmux to reconcile both directions. A user tmux
session with a similar name is never sufficient evidence of ownership.

Create protocol: persist a spawn intent with a stable ID before creating the pane;
tag the resource, record verified identities, then publish it. If persistence or
identity verification fails, do not report success: roll back the new resource and
verify cleanup, or surface it as a tracked recovery error. Serialize registry writes,
use atomic replacement, restrict file/socket permissions and reject concurrent daemon
ownership. Support legacy `sessions.json` entries without inventing recoverability.

**Acceptance/verification:** existing direct-backend host/session/platform/escalation
checks pass. Fault injection covers write failures, crash before/after pane creation,
recycled PID, corrupt registry, unknown schema and duplicate host startup. Every created
resource is recovered, confirmed cleaned up, or retained as an actionable recovery
record; unrelated processes are never signalled. Windows fakes prove the same `.cmd`
spawn and `taskkill /T` behavior and no named signal passed to Windows node-pty.

**Commit:** `refactor(host): isolate session backends and recovery ownership`.

## Step 1c — implement Linux reattachment, exits and reliable cleanup

On Linux persistent mode, daemon shutdown closes streams and its attachment clients,
not tmux panes. On startup reconcile registry and owned tmux metadata before advertising
sessions. Reuse IDs/labels, recover geometry/status, rebuild terminal display from the
chosen replay contract, and resume live streaming. Distinguish attachment loss from
agent exit. Never report the tmux attachment client's exit code as the agent's code.
A pane that exits while the daemon is absent must return as an exited session with its
real outcome; retain it until explicit deletion. Unknown exit status stays unknown.

Keep terminal rings in memory. Document that daemon restart loses the old raw ring;
tmux can reconstruct display/history within its configured memory limit, not guarantee
byte-for-byte replay of past output. Bound tmux history. Test duplicate replay handling
in `useTerminal.ts` rather than displaying redraws on top of stale client screen state.

Provide a recovery view/API status for verified-but-unreachable sessions, reconcile
errors and failed kills. A retry reconnects; an explicit terminate operation verifies
ownership immediately before signalling. Do not automatically kill survivors at startup.
A lost socket or unavailable owner must not erase the registry. Inventory owned tmux
resources missing from the registry and surface them; preserve corrupt files for diagnosis.

Explicit session deletion terminates the underlying workload, not just its attachment.
Keep termination state until death is verified; escalate as today and retain failures.
Test descendant processes, not just the initial PID. Identify a tested workload-group
cleanup strategy in the backend; do not assume killing a shell or tmux pane eliminates
children that ignore HUP. Deliberately detached descendants must either be covered by
an owned process scope or remain tracked and operable, never silently forgotten.

**Acceptance/verification:** new `accept:restart` covers repeated restarts, crash during
spawn/delete/recovery, daemon unavailable while output or exit occurs, registry loss,
socket loss, owner failure, PID reuse, slow reconnect and failed termination. A child
that ignores TERM/HUP and a child that forks must be cleaned up or visibly retained.
No duplicate sessions after repeated recovery. Browser reconnect/takeover and manual
resize work. Existing direct-mode orphan tests remain, persistent-mode tests assert
the deliberately different shutdown behavior. No terminal history files are created.

**Commit:** `feat(host): reconnect Linux sessions after daemon restart`.

## Step 1d — verify self-hosted upgrades and document operator recovery

Configure this Linux machine's independent PTY owner and persistent backend after the
isolated tests pass. Existing direct sessions cannot be converted in place: label them
as restart-unsafe and migrate by finishing/restarting them deliberately. Preserve a
CLI inventory/reconnect/verified-cleanup procedure usable when the HTTP daemon fails.
Distinguish restart/disconnect from explicit stop-all; stopping the HTTP service alone
leaves persistent sessions alive by design. Reboot/PTY-owner loss is not live-session
survival; reconcile resulting dead records at the next start.

**Acceptance/verification:** from an actual Switchboard-created coding agent, make a
small reviewable change, test against a throwaway daemon, commit, build the host,
restart the real HTTP service, reconnect to the same session/PID, and continue work.
Verify desktop and phone reconnect; prove all owned sessions appear in inventory and
can be terminated even after a failed deployment. Exercise direct Windows behavior
through fakes; run real Windows shutdown acceptance when hardware is available and
record its outstanding status explicitly. Linux success must not wait indefinitely
for unrelated Windows hardware repairs.

Update README, spec, CLAUDE and TESTING with the new Linux guarantee, exact recovery
commands and known boundaries. Upgrade/rollback keeps old backend support until all
sessions using it are gone; never revert to code that cannot inventory live resources.

**Commit:** `docs(host): validate Linux self-hosted upgrades and recovery`.

## Add-on design contract

### Packages and integration

- `packages/jobs`: separate TypeScript service, CLI, SQLite migrations, workers,
  connectors, browser automation, resume rendering, tests and acceptance fixtures.
- `packages/jobs-ui`: independently buildable React client owned by the jobs app,
  served by the jobs service. Switchboard links to/embeds this separate app under a
  Jobs tab. Keep terminal linking in a thin integration adapter. Switchboard must
  install/build/run without jobs dependencies; no host or web imports of jobs source.
- `packages/web`: optional Jobs link/tab and endpoint/health configuration only.
  Use an external page initially (least coupling); embedding is optional, with
  explicit frame/origin policy. Never put bearer tokens in navigation URLs.
  Failure or absence of the add-on must never block terminals or fleet polling.
- HTTP daemon changes after step 1 are limited to generic observation/idempotent spawn
  needs proved by a caller. No jobs tables or workflow knowledge in host code.

The job service runs only on this Linux machine. Its client works on desktop and phone.
Keep jobs-specific Node/native/browser dependencies and any Python environment optional
for a Switchboard-only install, including on Windows; verify this in step 2.
The job service runs independently of Switchboard. Start with loopback binding; expose
through a separate tailnet HTTPS endpoint for the phone. The jobs client calls
that endpoint directly (browser localhost would be the phone, not this machine).
Use its own bearer token and explicit allowed UI origins. Browser storage may hold
connection details, as it already does for hosts, but not applicant records or files.
The service holds the local host token in a private machine-local config/secret file;
never return it to clients or sync it through `agents.json`.

### Swappable external integrations — settled implementation convention

Use TypeScript interfaces as the equivalent of a small abstract base-class contract,
with explicit factories/registries selecting an implementation by configured provider ID.
Abstract classes are available, but use them only when implementations actually share
behavior; inheritance is not required just to express a contract. Inject implementations
into workers/services. No provider-specific branches scattered through business logic.
Keep previous adapters available when adding a replacement, selectable in settings.

Define narrow contracts as their first caller lands, not one giant integration class:

| Contract | Responsibility | First implementation |
|---|---|---|
| `AgentSpawner` | Create with idempotency, inspect/reconcile, attach link, stop | Switchboard HTTP adapter |
| `AgentInvocationAdapter` | Model/task/tool configuration and result handling for a runner | Selected local CLI or scoped jobs runner |
| `JobSourceAdapter` | Discovery/detail, pagination and source normalization | Greenhouse, followed by the other researched boards |
| `ApplicationAdapter` | Permitted preparation, submission and outcome reconciliation | Manual handoff, then individually supported target forms |
| `NotificationTransport` | Deliver a normalized notification and return delivery status | ntfy; replaceable later |

Application capabilities must be explicit; do not require a manual-only adapter to
pretend to implement automatic submission. Keep provider config validation, credential
lookup and error translation inside the adapter boundary. Factories reject unknown
providers and invalid config before scheduling work. Contracts include cancellation,
timeouts, normalized retryability and version/capability reporting where applicable.
Never silently switch provider/model or retry an ambiguous external action.

Keep these contracts inside the consuming app, with the cross-app HTTP/file contract
documented separately. Shared persona tool IDs map to registered implementations in
each app; a persona is not an executable plugin. No dynamic third-party code loader or
general plugin framework is needed. Dependency installation remains app-specific.

Acceptance in the introducing step: run the same contract tests against the real
adapter's fixture harness and a fake alternate; swapping the configured implementation
requires no workflow edits. Verify no provider-specific types leak into persisted
workflow state except a namespaced raw-metadata payload. Preserve provider/config
revision on historical runs when settings change. Notification delivery can be swapped
without changing the inbox or decision history.

### Compatibility with the future agent review-loop add-on

`LATER-review-loop.md` describes a separate reviewer model, human accept/reject,
fresh fix sessions on rejection, and the PR thread as history. Preserve those choices.
The future implementation can be another workspace/service with its own settings,
state and UI module, following the same boundaries as jobs. Do not build its code now.

- Job enable/pause/stop settings affect jobs only; they must not disable session APIs,
  stop another add-on, or kill review/fix sessions. Each add-on owns its run IDs,
  idempotency-key namespace, directories, process records and session labels.
- Generic host create/read/observe/recover contracts serve both callers. No global
  “current pipeline,” single background-consumer lock, job-only metadata requirement,
  or job worker ownership of the browser claim. Existing human claim semantics remain.
- Retain exited sessions until explicitly deleted by their owner/operator. Jobs only
  cleans up its own sessions after saving its results, never all exited sessions.
  Idempotency keys must be scoped so independent add-ons cannot collide accidentally.
- Keep model selection, reviewer/author separation, approvals and retry policies in
  each add-on. Do not hardcode jobs' submission states or daily caps into shared APIs.
- Keep jobs' database/schema, browser dependencies and applicant secrets private to
  jobs. A future review add-on does not depend on starting jobs or opening its database.
- The UI integration should permit a second isolated add-on entry/settings section;
  avoid making jobs the only possible optional service. Use small explicit integrations,
  not a speculative plugin framework or shared workflow engine.
- In steps 7 and 12, run two independent fake API callers (jobs plus a future-review
  stand-in): both can spawn/observe distinct sessions without evicting the human;
  disabling/restarting jobs leaves the other caller's session and result intact.
  This is a host compatibility check, not an implementation of the review loop.

When updating spec §9, describe both as same-repository sibling add-ons. Leave review-loop
workflow details and implementation timing in `LATER-review-loop.md`; do not expand this
plan into PR automation or require the review loop before jobs can ship.

### Shared conventions with no owner

Three components exist: the host daemon, this jobs add-on, and the future review-loop
add-on. Each service must start and expose its settings/history with the other two stopped.
Work requiring a spawner waits visibly while that dependency is unavailable; it does
not pretend to execute independently. None imports another's source or opens another's database.

Some things are genuinely shared. Shared things live in a shared **location** — files
on disk, or a documented HTTP contract — never as a library one component exports and
another imports. The design test: if a different agent-spawning service replaced the
host daemon, an add-on should need one adapter file changed, not a rewrite. Keep the
spawner interaction behind a single thin module in `packages/jobs` for exactly this
reason; do not scatter host HTTP calls through the workers.

**Personas and skills** are the first such shared convention, machine-local:

```
~/.switchboard/personas/<id>/
  manifest.md              frontmatter + system prompt body
  skills/<name>/SKILL.md   frontmatter + procedure body
```

Markdown frontmatter plus prompt body follows the supplied OpenWorker reference.
Do not assume its runtime exists in Switchboard. Reference inspection (2026-09-16):

- `openworker-main.zip`: `coworker/personas/manifest.py`, `loading.py` and built-in
  `manifest.md` files implement validated manifests, tools/skills, permission defaults
  and recommended models. These are reference patterns, not an installed integration.
- `aisuite-main.zip`: README describes a Python provider/tool runtime and points to
  OpenWorker's separate repository. `openworker-archive/` is explicitly historical;
  use the separate OpenWorker archive as the persona reference. `aisuite-js/` exists,
  but do not assume feature parity with the Python runtime or adopt it without a spike.
- Both supplied archives carry MIT licenses. Preserve notices for any reused code.
  Do not copy their whole applications/dependency trees into Switchboard.

Define a small documented manifest subset: `schemaVersion`, `id`, `name`, `description`,
`agent`, `model`, `tools`, `skills`, and default permission hints. Map OpenWorker names
explicitly if importing existing manifests; report unsupported capabilities. Validate
IDs/path containment and missing skills; one malformed persona blocks only its runs.
The host never reads this directory. Both future add-ons can read the same directory
without either owning a persona service or requiring the other app to be running.

The jobs invocation adapter composes persona, selected skill contents and task into an
immutable input file. It must implement the CLI's actual model selection and task-file/
tool connection mechanism through explicit argv or a jobs-owned runner. Current host
`args`/`extraArgs` are literal arrays, not an existing template engine. A model name in
prompt text is not model selection. Keep all CLI-specific translation in the jobs
adapter; generic spawner APIs only start/observe/attach/stop workloads. Any provider
library or new tool runner is a jobs dependency, never a Switchboard dependency.

At run creation, store the entire persona text, skill texts, composed prompt, selected
model/agent, effective tools/permissions and revision hashes in SQLite TEXT/JSON columns.
Small definitions do not need a separate artifact file. Save larger inputs/outputs as
immutable files referenced by the DB. The shared files are live configuration; DB
snapshots are historical evidence. Changing/deleting a persona must not change old runs.

Personas and tools are one execution contract: a persona declares tool IDs; the jobs
runtime resolves them to registered, versioned implementations and validates arguments.
A missing tool makes that persona unavailable with an explanation, never silently grants
a general shell fallback. Record tool schemas/versions with the run. Verify enforcement
in the selected agent runtime; a prompt-only allowlist is not an enforced restriction.
For CLIs unable to restrict tools, use a scoped jobs runner/tool bridge rather than
claiming their unrestricted shell is constrained. Renderer accepts only validated data.

Persona defaults never override operator approval requirements, disabled flags or site
restrictions. Jobs-owned tool endpoints enforce the effective permissions, not prompt
wording alone. Keep resume construction tools separate from website submission tools.

### Local storage and immutable evidence

Default root: `~/.switchboard/jobs/`, overridden by `SWITCHBOARD_JOBS_DIR` in tests.
Private directory permissions; runtime data ignored by git.
The Switchboard no-persistence rule does not apply to jobs: retain source responses,
posting HTML/text/images, prompts, persona/skills, visible model messages, tool calls
and results, intermediate/final resumes, approvals/denials/edits, errors and receipts.
Prefer retaining useful evidence over minimizing records; never silently truncate it.
Record what a runner cannot expose (for example output lost during a crash); do not
claim to capture unavailable model internals. Exclude access tokens, passwords and
session cookies from audit exports/log payloads; keep operational secrets separately.
A failed attempt retains its inputs and partial outputs, linked to subsequent attempts. SQLite with migrations,
foreign keys, transactions, busy timeout and a single scheduler/writer ownership rule.
Choose/pin the SQLite driver against the supported Node 22 baseline in step 2; do not
assume every Node 22 minor has an identical built-in SQLite API. Use explicit SQL,
not an ORM unless a demonstrated need changes that decision.

Keep metadata/text in `jobs.sqlite`; files under `artifacts/<sha256>` with DB records
for content hash, MIME type, size, relative path, timestamp and purpose. Write to a
temporary file, hash/flush/rename, then commit references. Recovery can remove unused
staging files; it must never delete an artifact referenced by a finalized application.
Disk-full, partial write and missing artifact produce a blocked workflow, not success.

Minimum entities (all IDs stable, times UTC, human displays localized):

| Entity | Required purpose/fields |
|---|---|
| `settings_revisions` | Validated versioned settings; effective revision per run |
| `sources`, `search_runs` | Adapter, query/filter revision, pagination checkpoint, last result/error |
| `jobs`, `job_aliases` | Source/external ID, original/canonical URL, company/title/location, discovery dates, normalized fields and dedup keys |
| `job_snapshots` | Job ID, capture purpose/time, fetched/final URL, complete text, screenshot artifact, content hash, capture version, completeness/failure detail |
| `profile_revisions`, `bullet_revisions`, `template_revisions` | Immutable applicant facts, evidence/source paths, tagged bullets and resume layouts |
| `resume_versions` | Job/snapshot, selected bullet revisions/order, edits, template/profile revision, agent/prompt version, structured source, exact PDF and text artifacts |
| `applications` | Job, state, selected resume, review/submission policy, timestamps and current block reason |
| `application_attempts` | Unique attempt ID, immutable pre-submit snapshot/resume/answers/settings manifest, preflight time, send-start time, outcome, confirmation/receipt evidence |
| `tasks`, `agent_runs` | Stage, inputs/outputs, parent/retry IDs, lease/heartbeat, retry budget, spawner/session/process identities, run directory, deadline, errors; full persona/skill/prompt/model/tool-policy snapshots in TEXT/JSON columns |
| `review_decisions` | Subject/stage/version, approve/deny/request-changes, optional reason, edits and before/after snapshots, time, policy revision, downstream invalidation |
| `tool_events`, `run_messages` | Ordered tool requests/results, validation failures, available model messages, timings/usage/errors, artifact references; capture gaps explicitly |
| `source_policies` | Site/company/adapter capabilities, terms URL/review date, operator restrictions and versioned effective policy |
| `events`, `artifacts` | Append-only workflow audit and artifact manifest; not raw secret-bearing terminal logs |

Keep discovery snapshots and application-time snapshots separately. Every submit
attempt references a fresh complete text **and full-page screenshot** of the job
posting captured in the final preflight, not merely its search card or application
form. Expand job details; verify lazy-loaded content and capture all required sections
(or multiple ordered images when a page is too long). Preserve URL/time/viewport and
capture errors. Optionally keep sanitized HTML as extra evidence.

If the description changes after tailoring/review, create a new snapshot and invalidate
stale approval/resume matching. Require preflight evidence within a configured freshness
window; after a long form/login delay capture again. A failed screenshot or incomplete
text blocks automatic submission. Manual exceptional records must visibly say what is
missing. Submission-time evidence cannot guarantee an employer will not change the
page a moment later; the archive records exactly what was observed and when.

The exact uploaded resume bytes are immutable and hashed. Preserve the structured
resume source, selected bullet IDs/revisions, generated text, template/version and
PDF; regenerate only as a new version. Store sent cover letter, answers, attachments,
submission confirmation text/screenshot and identifiers too. A future profile edit
must not change an old application's evidence.

### Workflow and external side effects

Discovery → captured → screened → tailoring → preparing → ready for final review
→ approved → submitting → submitted. Stage review gates pause selection, assembly,
editing and any external preparation before the next relevant action; they are not
all collapsed into that final-review state. Additional explicit states: rejected/skipped, needs input,
retryable failure, terminal failure, cancelled and submission unknown. Task state and
application state are separate. Specify allowed transitions and guards in code/tests.

Default `enabled=false`, scheduling off, automation stage `manual-review`.
Initially every material workflow decision is human-gated: candidate selection/skip,
assembled resume, edited resume and final application/answers. Routine reads, rendering
and approved tool calls within a stage do not each need a separate click. Store all
approvals, denials, corrections and optional reasons against exact versioned artifacts;
these are the evidence for improving prompts/filters and later relaxing review.
Do not auto-raise autonomy based on approval rate. Thomas explicitly removes gates
per stage/adapter over time; settings edits create new policy revisions and can restore
all gates immediately. Multiple gates can be reviewed in one screen without losing
which versions/decisions were approved. Rejecting a resume need not reject the job.

Modes: `draft-only` prepares local materials; `review` requires enabled stage approvals
and a final approval; `automatic` can submit without a final click only after the
operator explicitly enables it for that adapter and the required earlier gates pass.
A review approval binds to job/resume/answers versions; changes invalidate affected
approvals. Advisory wording/checker findings can be accepted; they are not perfect
truth detectors. Missing facts/attestations become questions, not invented answers.

Site capability policy is separate from human review. Each adapter/company can allow
or forbid discovery, fetch/capture, browser opening, filling, uploading and submission.
Operator settings may narrow supported/permitted actions, never turn an unsupported
or prohibited action into a supported one. Unknown/restricted behavior falls back to
manual handoff. An accessible API or absent CAPTCHA is not evidence of permission.
At CAPTCHA/login/anti-bot/terms boundaries, stop the prohibited action, preserve work
and show a task with the original form URL, exact resume download, prepared answers,
what was completed and what remains. Do not solve/bypass CAPTCHA or evade a restriction.
Where even filling/uploading is disallowed, hand over the empty form link and locally
prepared materials. A resume attached to a notification means attached in the jobs
inbox task by default, not sent to an external notification provider.

Before sending, commit an attempt/intent, recheck enabled/pause, effective site policy,
review gates, caps, required artifacts and current lease, then perform the external
action. Upload/autosave may already transmit personal data, so enforce their own gates
before those actions, not just before the final Submit click. A timeout or crash after
sending becomes `submission_unknown`; reconcile via evidence or human confirmation
before another attempt. Local idempotency cannot guarantee exactly-once website delivery.

Disabling is server-enforced: no new discovery, agent runs or submissions. Drain/cancel
safe work and retain results; do not kill unrelated Switchboard sessions. If sending
began, record its outcome or unknown state. Read/history/downloads remain available.
For manual submissions, record operator-confirmed outcome, time, selected materials and
available receipts; never present that as machine-observed confirmation.

### Child-agent recovery is a release gate

Persist run intent and child/session identity before considering a stage launched.
A jobs-server crash must leave Switchboard-owned children visible/attachable, including
when the Jobs page is unavailable. Use namespaced labels immediately; the host's regular
session list is the fallback. On restart reconcile every nonterminal run with the
spawner before retrying: unavailable host is not a dead child. A live child is reattached;
a dead child gets an exit/lost event, partial outputs and a retry from its saved inputs.
A retry has a new run ID, linked to the old attempt, with bounded retry count; explicit
operator cancellations stay cancelled. Restarting a failed preparation from zero is fine.
Never retry an ambiguous submission as an ordinary failed preparation.

Tools that need the jobs server must fail visibly while it is down; the agent waits or
exits as a recorded retryable run. Late output from an old attempt cannot overwrite a
new one: use attempt IDs and fenced leases for result acceptance. Prove recovery after
jobs crash, host crash, both crashing, child accidental death and intentional cancellation
in step 7 and again in final acceptance. Verify from the UI, not just by counting PIDs.

### Settings in the UI and persisted on this machine

| Group | Controls and default behavior |
|---|---|
| Main | Enabled off; paused; draft/review/automatic mode; per-stage review gates initially all on; effective policy and decision history |
| Discovery | Editable company/board registry and per-source identifiers/regions/queries/capabilities, plus role keywords, exclusions, locations, remote/hybrid, seniority, salary/currency/pay period, employment type and company allow/deny lists |
| Schedule | Manual initially; interval/time window/timezone, backoff, per-source request limits |
| Capacity | Worker concurrency 1 initially; daily submission cap, maximum agent runtime/retries and optional cost budget where measurable |
| Applicant | Explicit local import paths, profile/facts, contact details, eligibility answers, missing fields; no indiscriminate home-directory crawl |
| Resume | Template/default format, approved bullet library/tags, length limits, allowed rewrites, preview and review requirement |
| Automation | Adapter allowlist, final-submit policy, human-only questions, pause-on-error thresholds |
| Evidence/data | Data location display, capture freshness, storage usage, backup/export/restore, retention policy (submitted evidence retained by default) |
| Alerts (optional) | ntfy transport initially (replaceable), endpoint/secret, digest interval and event choices. Off by default; UI inbox is sufficient without alerts |
| Connections | Job-service URL/token, local Switchboard host/agent selection, persona directory path, browser-profile status; secret inputs masked and never round-tripped as plaintext |

Every operator-facing setting introduced in any step must have a Jobs settings control
or structured editor in that same step, including sources, personas/prompts/models,
skills, templates, bullet facts/tags/filters and review gates. Support config import/export
for bulk setup; SQLite owns jobs/source settings, not a second independently edited
JSON configuration. Shared persona files remain the persona source of truth: the UI
validates and atomically updates them with revision checks, then snapshots them for runs. Machine bootstrap secrets may be write-only UI values.

Settings changes are validated server-side, versioned and audited; reject invalid
values with field errors. Use revision conflict checks to avoid stale tabs overwriting
newer settings. Apply enable/pause immediately; describe restart-required settings.
Do not move a live DB by editing a text field; provide a controlled offline migration.

## Step 2 — scaffold isolated service, contracts and disabled settings

Add the jobs workspaces/scripts and the narrow spec revisions described above. Build
health/auth/settings endpoints, config validation and a disabled scheduler shell.
Choose storage/browser/rendering dependencies with pinned compatible versions and
keep their imports/dependencies out of host. Define API error and settings schemas.

**Acceptance/verification:** standalone jobs service starts/stops without host; wrong
or missing token is rejected; invalid settings do not replace last good settings;
disabled means no agent/browser/network jobs. Root typecheck and host tests still pass.
Fresh Switchboard-only install/build on Linux and Windows does not resolve or install
jobs browser/Python/native dependencies; optional jobs setup is separate and documented.
Without the jobs service, Switchboard remains usable. A fake alternative spawner can
exercise the thin jobs adapter contract without importing host code.

**Commit:** `feat(jobs): scaffold isolated optional service and settings`.

## Step 3 — SQLite, artifact store and recoverable task state

Implement migrations/entities above, transactions, content-addressed artifacts, durable
events, queue lease/heartbeat, startup reconciliation and a single active scheduler.
Provide integrity inspection and consistent backup/restore of DB plus referenced files
(use SQLite backup/checkpoint-aware procedure, not copying a live DB alone).

**Acceptance/verification:** temporary DB tests cover migrations from every shipped
version, rollback on failure, FK/dedup constraints, competing task claims and expired
leases. Restart during file write/DB commit leaves no finalized dangling reference.
Round-trip backup restores matching artifact hashes; corrupted/missing files are
reported. Unknown DB versions fail without mutation. Queue restart never resends an
attempt already submitting/unknown. No runtime files appear in git status.

**Commit:** `feat(jobs): persist workflow state and immutable artifacts`.

## Step 4 — job settings UI and basic dashboard

Wire the isolated jobs feature into navigation and Settings. Implement connection
status, all currently supported settings, paused/disabled state, list/detail skeletons
and data diagnostics. Use a Jobs page with child agents grouped together, a durable
attention inbox and approve/deny/request-changes actions. Every item links to its
run/artifacts, not just an ephemeral terminal. Online service exposes the Jobs page;
no configured service means no job UI. For a previously configured service now offline,
keep a small connection/settings status entry; regular Switchboard sessions remain
accessible. Jobs has its own usable client when Switchboard is stopped.
Future controls must be labeled unavailable until implemented,
not appear to work. Add server-backed reads/writes and settings revision conflicts.

**Acceptance/verification:** browser acceptance on desktop and phone saves/reloads
settings, reports validation/conflicts, persists pause through service restart and
shows offline/auth failures without disrupting the terminal. Two devices see the same
job settings. Disabling in one tab prevents a worker operation from another. Existing
claim, agent-sync and relevant UI acceptance still pass.

**Commit:** `feat(web): add isolated job settings and dashboard`.

## Step 5 — import and capture job postings with evidence

Start with explicit URL/manual text import and a deterministic local fixture website.
Implement browser capture and normalized posting data; add one real source adapter
using the registry and rollout order in [JOB-SOURCES-RESEARCH.md](./JOB-SOURCES-RESEARCH.md). Define adapters for discover/fetch/
normalize/capture, with versioned capabilities; do not implement arbitrary-site automation
as the first milestone. Manual text import is useful but cannot claim screenshot evidence.

**Acceptance/verification:** store exact text/full-page images and source metadata;
change/delete the fixture posting and verify the archived version stays available.
Cover redirect/canonical URL dedup, same role from two sources, incomplete/lazy-loaded
content, unavailable pages, screenshot errors and retry limits. Duplicate intake does
not create duplicate eligible applications. Rendered untrusted HTML is never executed
in the dashboard; import URLs cannot fetch arbitrary local files/private endpoints
unless explicitly permitted for an isolated development fixture.

**Commit:** `feat(jobs): capture versioned postings and screenshots`.

## Step 6 — local applicant facts, bullet library and resume templates

Import explicitly selected local files into editable, versioned facts/bullets. Preserve
provenance; separate verified facts from suggestions. Add deterministic selection by
skills/role tags and a template renderer producing PDF plus extracted text and structured
source. Start with 1–3 templates and a UI-editable facts/bullet library in SQLite
(JSON import/export supported). Include resume preview and selected-bullet explanation. Profile omissions are
visible rather than guessed. Original imported files are never modified.

**Acceptance/verification:** fixture profile + job yields a readable resume with
correct sections, contact details, bullet order and no unsupported claims. Extract text
from the PDF and compare expected content; visually inspect long/short cases for clipping,
page overflow and missing fonts. Repeated rendering records hashes/version inputs;
editing a bullet/template leaves previous resume files and application records unchanged.

**Commit:** `feat(jobs): version applicant facts and render tailored resumes`.

## Step 7 — Switchboard agent tailoring and structured results

Add a jobs-owned agent runner using authenticated, claim-free session creation,
labels such as `jobs:<application>:tailor:<run>`, and local per-run input/output files.
Pass a task-file path through configured CLI argv; validate structured output against
schemas and approved facts. Agent-specific invocation/result adapters belong in jobs,
not host. Treat page text as untrusted input, not instructions to operate the machine.
Record provider/model when available, persona id and revision, prompt version,
facts/snapshot hashes and result.

**Tailoring has two required model passes; save both complete resumes.**

- Assembly persona chooses one of the configured templates, approved bullet revisions,
  section ordering and bounded layout options through jobs-owned tools such as
  `list_templates`, `find_bullets`, `select_bullet`, `order_sections`, `render_preview`
  and `finalize_resume`. Tools validate IDs, employer associations, permitted fields,
  duplicates, lengths and renderability. They construct structured data; the model
  does not write arbitrary PDF/HTML or invent freeform bullets through assembly tools.
- Save assembly inputs, tool calls/results, structured resume, rendered PDF/text and
  human decision. Rejection/edits are stored, not overwritten.
- Edit persona receives the exact job description and assembled resume, and may change
  prose/terminology according to its prompt. Save every proposed patch and final edited
  resume as a new version, with a diff against assembly and a human decision initially.
  Tool validation still enforces shape/layout; it does not claim perfect factuality.
- Deterministic terminology flags are best-effort hints with a specified vocabulary,
  aliases and numeric checks, never a claim to exhaustive semantic verification.
  The previously proposed checker persona is optional/configurable and advisory, not
  a prerequisite or replacement for the two required passes. Save its output when used.

The review screen shows the diff, warnings and both downloadable full versions. Human
review starts enabled; later reduced review is an explicit policy choice. There is no
unconditional promise that every future automatically submitted resume was seen by a
human. Maximize traceability and useful tool constraints rather than blocking rewriting.

Implement step 7 as separately verified commits: (7a) persona snapshots/invocation and
scoped tool contract; (7b) two-pass resume workflow and decision logging; (7c) spawner
idempotency/recovery integration. Complete each checkpoint before the next. Fake tools
prove an invalid template/bullet/association is rejected; a fake model proves the
configured model is actually selected and both pass outputs/decisions are retained.

Close the spawn-response-loss window: add a generic optional idempotency key to host
session creation, persisted with recoverable session metadata, or prove an equivalent
atomic lookup contract before enabling retry. A label alone is not a uniqueness guarantee.
The add-on records intent before spawn and can rediscover the same session after timeout.
Poll retained exit state; successful exit without a valid output artifact is a failed
stage. Host restart reconnects existing work rather than spawning it again.

Only now add the §9 authenticated, claim-free `GET /sessions/:id/scrollback` endpoint
if the diagnostic UI uses it. It exposes bounded terminal bytes, not a completion API.
Background jobs never open a claim-taking interactive WS. The human can open the normal
terminal to answer a prompt. Timeout/cancel targets only the recorded owned run.

**Acceptance/verification:** fake agents cover valid/malformed/missing output, unsupported
facts, hung runs, nonzero exits and response loss. Browser claim is unchanged by spawn,
poll and observation. Restart jobs/host mid-tailoring and recover one run, one accepted
result and no inaccessible child sessions. One explicitly invoked real-agent smoke
produces a schema-valid two-pass draft; record actual limitations rather than relying
on fake AI. Change/delete persona files and prove the DB snapshots reconstruct the run.
Kill the jobs service while a child runs, then reconnect to the child via Switchboard;
restart and reconcile without duplicates. Kill a child and recover via a linked retry;
late old results are rejected. Cancel intentionally and verify no automatic resurrection.

**Commit:** `feat(jobs): orchestrate tracked resume-tailoring sessions`.

## Step 8 — search scheduling, filtering and explainable queueing

Implement discovery schedules for the first chosen source, pagination checkpoints,
retry/backoff, normalized dedup and scored filtering. Record why each posting matched
or was excluded. Distinguish unknown salary/location from a mismatch; normalize salary
currency/pay period without silently inventing conversions. Manual intake remains usable.

**Acceptance/verification:** fixture pagination/rate-limit tests, repeated discoveries,
clock/timezone boundaries, pause/restart, worker concurrency and caps produce bounded
work without duplicate applications. Disabled sources stop scheduling. UI can inspect,
skip and requeue with an audit event; automatic tailoring respects queue capacity.

The durable Jobs inbox/attention counts are required; phone alerts are optional.
If implemented here, use a small jobs-owned HTTP sender (ntfy selected initially,
behind `NotificationTransport` and its factory) with a persisted digest cursor, bounded delivery retries
and token-free deep links into the Jobs page. The phone must have the corresponding
app/subscription configured; an arbitrary webhook does not itself create phone push.
No external messages in acceptance: use a local fake receiver. Test batching, restart,
disabled alerts, failed delivery and no repeated flood. Delivery failure never blocks
jobs; a crashed jobs service cannot send its own crash alert. Independent monitoring is
later optional work. Scheduling remains valuable even without external notifications.

**Commit:** `feat(jobs): schedule discovery and explain candidate filtering`.

## Step 9 — application preparation and immutable review package

Implement one application-form adapter against fixtures, then the chosen real target.
Prepare answers and cover letter if needed. Upload/fill only after their initial
human gates and adapter policy allow it; preparing local materials does not itself
authorize transmitting them. Provide manual handoff even when no form can be filled. Keep a dedicated
local browser profile and supervised browser process; never take over the user's daily
browser. Persist browser ownership for crash cleanup/recovery; do not leave unmanaged
Chromium children. Login/CAPTCHA/unknown questions produce a resumable needs-input task.
A phone link does not transfer the Linux browser session: initial live-browser
intervention is on this machine; mobile can review files and complete the site manually.
Do not silently add remote-browser streaming to this release.

Build review UI showing original posting text/images, selected resume/PDF, answer set,
changes since review, source link and agent run. Final preflight refreshes posting
capture and assembles the immutable attempt manifest. In this step, stop before submit.

**Acceptance/verification:** fixture server sees correct form fields and exact uploaded
file hash but zero submissions. Changed posting or answers invalidates prior approval.
Missing evidence, stale capture, wrong file or unsupported required fields blocks
progress. Human resolves a block and continues the same application without duplication.
Restart browser/service during preparation recovers or safely repeats permitted
preparation only. CAPTCHA and forbidden automation fixtures produce inbox handoffs with
resume/answers/URL and no further prohibited requests. An empty-form handoff is a valid
completed preparation outcome; manual completion stores the operator-reported receipt.

**Commit:** `feat(jobs): prepare applications and review exact submission evidence`.

## Step 10 — controlled submission and duplicate prevention

Implement review-authorized and automatic submission modes using the intent protocol.
Serialize competing attempts per job/canonical identity. Recheck enabled/pause, review
hash or automatic policy, caps and complete artifacts immediately before sending.
Record receipts, confirmation text/images, external ID and time. UI supports truthful
manual reconciliation of unknown outcomes with evidence; no optimistic success.

**Acceptance/verification:** fixture tests cover successful send, known rejection,
timeout before send, timeout after accepted send, double click, two workers, service
crash at every boundary, settings disable during preparation and disable during send.
At most one fixture submission occurs without explicit reconciliation/override.
Initially all fixture transitions require the configured human gates; decisions and
corrections are queryable. After explicit policy relaxation, automatic mode sends an
eligible fixture without a final per-job approval. Tightening a site policy blocks a
previously approved queued send; a manual-only adapter never sends even in automatic mode.
Review mode requires matching approval; draft-only and disabled modes send nothing. Missing receipt becomes
unknown unless adapter has another reliable positive confirmation.

**Commit:** `feat(jobs): submit applications with durable attempt reconciliation`.

## Step 11 — essential records, export and operating recovery

Deliver per-application/run detail with all existing evidence, decision history,
resume downloads and outcome; this is necessary for review and diagnosis now. Complete
consistent backup/restore/export, storage health and queue repair controls. Retain
submitted evidence and failed/rejected drafts by default; no silent age-based pruning.
A full searchable company/recruiter dashboard, analytics and interview-prep agents are
**later work**, not gates for this release. Preserve company/job IDs and artifacts now
so those features can retrieve closed-session history entirely from the jobs DB later.

**Acceptance/verification:** export/reconstruct an application offline, including both
resume passes, persona/prompt/skills, tool results, approval/denial decisions and receipt.
Profile/persona changes do not alter historical data. Restore read-only into a clean
directory; no automatic jobs start. Surface disk-full, DB failures and missing artifacts.
Stopping jobs neither kills nor claims unrelated sessions. Record retention/backup gaps
explicitly; the full dashboard and interview workflow remain unimplemented.

**Commit:** `feat(jobs): expose complete records and operating recovery`.

## Step 12 — end-to-end rollout on this machine

Document install, service setup, first-run profile/source configuration, secrets/browser
login, evidence capture, pause/disable, backup/restore and upgrades. Keep machine-local
unit paths out of git. Publish the web bundle only after isolated acceptance passes.

**Acceptance/verification:** fresh data directory, imported profile, discovery → tailored
resume → review → fixture submission → history/export works end to end. Repeat with host
restart during agent work and jobs restart during submission ambiguity. Additionally
crash each service separately and both together; verify surviving children can be
attached to from Switchboard, dead children are recorded and preparation can restart
from saved inputs. Verify unavailable host is not misclassified as child death, explicit
cancellation stays cancelled and ambiguous submission is never blindly retried. Run affected host,
platform, claim and browser regressions; record real phone results separately. Then use
a real posting in draft-only mode to validate page extraction and resume readability.
A real submission is a distinct, explicit rollout action on a selected application after
review, not an acceptance-test side effect. Enable schedules/automatic mode only through
the configured UI after this initial validation; leave defaults disabled in code.

**Commit:** `docs(jobs): validate local rollout and operating procedures`.

## Starter defaults and inputs needed only at rollout

The operator delegated initial companies, IT filters and generic personas/tools. Use
the 10-company starter set and all named board types in JOB-SOURCES-RESEARCH.md. These
are development coverage choices, not recommendations about employment suitability.
No company-selection question blocks implementation. Keep everything UI-editable.

Start with broad IT families: support/help desk, systems/network administration,
cloud/infrastructure, DevOps/SRE, security, software/web/mobile, QA/test automation,
data/DB/analytics and enterprise applications. Do not mistake every mention of “IT”
or generic “engineer” for an IT role. No salary/seniority/remote-only exclusions yet;
use all locations for company-feed test coverage and a configurable United States
query for aggregator smoke tests. Unknown eligibility remains unknown.

Initial personas: `resume-assembler` (choose valid template/bullet IDs through tools),
`resume-editor` (job-aware prose edits with patch/diff tools), and optional advisory
`resume-checker`. Use generic editable prompts describing inputs, allowed tools,
output schema and stopping conditions. Supply one basic single-column resume template
initially, designed to expand to 1–3. Test fixtures use clearly fictional applicant
facts. Never substitute fixture facts into a real application.

Choose an installed tool-capable runner during step 7's spike; expose agent/model in
settings, record actual selection, and show unavailable configuration rather than
silently switching. Real applicant files, provider credentials/budget and ntfy topic/
phone subscription are setup inputs before live use, not prerequisites to fixture work.
ntfy is the agreed initial alert transport; replacing it later is expected to be easy.

## Operator decisions already made — do not relitigate

- **Linux tmux work runs first.** It makes Switchboard usable for building the remaining
  apps. Windows session behavior stays as-is; this is a deliberate ordering choice.
- **Three standalone-ish apps.** Switchboard has no jobs/review runtime dependencies.
  Jobs is its own Linux-only server/client; future review pipeline is a sibling. Shared
  persona files and documented contracts are fine; changing spawners is a thin adapter task.
- **External integrations use interfaces and factories.** Keep adapters replaceable
  without workflow rewrites; preserve previous implementations as selectable options.
- **Discovery/scheduling is valuable; phone alerts are optional.** ntfy is selected
  initially, behind a replaceable transport contract. The Jobs UI is the
  primary place to see agents, completed work and needed decisions. Alerts are useful,
  not a prerequisite or reason to overbuild notification infrastructure.
- **Start human-gated; relax deliberately.** Log approval, denial and edits at each
  material stage. Thomas later removes selected reviews based on observed quality.
  No automatic confidence threshold grants greater autonomy.
- **Two model passes, both saved.** Tool-constrained template/bullet assembly, then a
  prose-edit pass guided by persona/prompt. Rewriting is allowed; perfect automated
  factual checking is not a release condition. Extra checker/flags are advisory.
- **Per-site restrictions govern all website actions.** No auto-submit where disallowed;
  fill what is permitted and hand over the rest, including an empty form link plus
  locally attached resume when necessary. CAPTCHA is a handoff, not a bypass challenge.
- **Persist generously in jobs.** Snapshot full personas in DB columns and retain
  prompts, inputs, tool outputs, both resumes and decisions. Switchboard's own
  no-history rule does not limit jobs persistence.
- **Recover children, or record death and retry.** Service crashes must not create
  inaccessible live agents. A failed child can restart preparation from scratch with
  linked history. Verify this at step 1 and final end-to-end acceptance.
- **All introduced settings are editable in the Jobs UI.** Include company sources,
  bullets/facts, templates, personas and stage/site policies. Full searchable history
  dashboard and interview-prep agents come later; save their required data now.

## Technical references and verification limits

- Repository authority: `switchboard-spec.md` §§2, 4.2, 6, 8–9; `CLAUDE.md` platform
  and ledger invariants; README service setup; TESTING and acceptance harness docs.
- [tmux manual](https://man7.org/linux/man-pages/man1/tmux.1.html): server/client
  separation, private sockets, attachment and configuration. The backend choice above
  is a proposed engineering decision; the local service/terminal experiments in 1a
  must establish suitability, not documentation alone.
- Check the installed `systemd.kill(5)` and `systemd.service(5)` manuals and actual unit
  configuration in 1a. This planning pass did not inspect/change the live service,
  install tmux, launch agents, run application tests or submit any applications.

## Implementation log

For each step append: date; commit hash; files/contracts changed; exact verification
commands and results; manual/hardware checks; rollback/recovery notes; unresolved issues.

Planning pass: repository/docs reviewed; plan created only.
2026-09-16: incorporated operator clarifications, inspected supplied reference archives
without executing them, and researched source APIs/JobSpy; see JOB-SOURCES-RESEARCH.md.
No implementation, live source scraping, external notifications or applications run.
Approved to proceed; see implementation entries below.

### 2026-09-16 — step 1a complete

- Baseline/approval commit: `c24aa4c`. Installed tmux 3.2a on this Linux machine.
- Added `accept:tmux-spike`: disposable independent systemd owner/attachment services,
  node-pty frontend, real alternate-screen fixture, SIGTERM/SIGKILL restart, same PID
  identity, input, Unicode, resize, literal argv/environment, retained exit 23 and
  negative owner-stop check. Passed outside sandbox (user bus/PTY access required).
- Baseline `npm test` passed; `npm run typecheck` passed using Node 22.23.2.
- Architecture contract: LINUX-SESSIONS.md. Live daemon/config unchanged.
- This proves feasibility, not production recovery. Next: backend seam/registry (1b).
- Stage commit is the commit containing this entry; subsequent entries record its hash.

### 2026-09-16 — step 1b foundation

- Step 1a committed/pushed as `951366f`.
- Added injected backend contracts and direct implementation; platform behavior stays
  behind ProcessOps. Added durable recovery registry, live-owner exclusion, stale-owner
  generation guard, validation and write/corruption tests. Production remains direct.
- Sequencing clarification: backend settings and actual tmux spawn/recovery fault
  injection move to 1c, where they have a real backend caller. This commit is the
  verified foundation, not a claim that persistent production sessions already work.
- Verification: Node 22 `npm test`, `npm run typecheck`, host build; isolated existing
  sessions/orphans HTTP+WS acceptance via `direct-regression.mjs` (results below).
- Both existing sessions and orphans acceptance suites passed, including explicit
  termination, crash reconciliation and clean direct shutdown. A runner fixture initially
  omitted workspaceRoots; corrected fixture and reran successfully. No production restart.

### 2026-09-16 — step 1c backend and isolated acceptance complete

- Step 1b committed/pushed as `06d3193`. This stage's commit contains this entry.
- Added Linux-only tmux backend, opt-in machine-local settings, scoped workloads with
  durable start gates and scope incarnation guards, registry/tmux reconciliation,
  retained failure inventory, nullable real exit status, offline recovery CLI, and UI
  persistence/recovery indicators. Windows/direct behavior remains behind ProcessOps.
- Verification with Node 22.23.2: `npm test`, `npm run typecheck`, host build, web build
  into `/tmp/switchboard-web-recovery-check`, `direct-regression.mjs`, and the expanded
  `restart.mjs` all passed. Restart acceptance covers SIGTERM/SIGKILL, stable ID/PID,
  geometry, input/redraw, exit while offline, registry loss/corruption, socket loss,
  24 immediate nonzero exits, controller exclusion, interrupted spawn, scope generation
  mismatch/retained failed cleanup, detached descendants and replacement owner cleanup.
- Stress testing found an actual tmux 3.2a unreaped-zombie/exit-status race. The backend
  waits for reaping, nudges only the verified tmux parent with SIGCHLD when needed,
  and reads fresh status. It never converts unknown status into success. Also fixed
  the empty-owner `list-panes` error that initially blocked cleanup after owner loss.
- `DELETE` retains its asynchronous API contract; tests now wait for inventory removal.
  Recovery instructions and limitations are in LINUX-SESSIONS.md and TESTING.md.
- Sequencing clarification: actual browser/phone reconnect, real coding-agent upgrade,
  offline interactive CLI and deployment crash-window checks remain explicit 1d gates.
  The spawn gate is fault-injected here; this does not claim exhaustive kill-at-every-
  instruction crash testing. Synchronous local reconciliation is bounded but not a
  high-session-count performance design.
- Production remains direct, with no live sessions observed during the preflight check.
  No production restart yet. The machine's automatic web rebuild timer was paused
  while editing UI and must be restored during verified rollout. User reference zip
  archives remain untracked and untouched. No jobs/review-loop implementation yet.

### 2026-09-16 — step 1d Linux rollout complete

- Step 1c committed/pushed as `e3477b0`. Installed machine-local independent
  `switchboard-owner.service`, private owner configuration/socket, and enabled tmux
  mode. Preflight found no live sessions or orphans. Private pre-migration host config
  backup is retained outside the repository. The web rebuild timer is restored.
- Actual Switchboard-created Claude session `VSnLPMnJ0jbytuNYAxZB3` (PID 468578)
  corrected README, passed typecheck/direct regression, committed `6d38106`, built the
  host, restarted the real daemon from inside its own session and continued afterward.
  The outside harness independently observed changed daemon PID and unchanged agent
  session ID/PID. The completed test session was explicitly removed and cleanup verified.
- Added real Chromium acceptance for reconnect/redraw/input/resize, second-client
  takeover/take-back and mobile viewport. Added offline CLI inventory, real PTY attach/
  detach and confirmed termination; crashes during spawn and deletion; delayed owner
  discovery after startup with missing registry. All passed in `restart.mjs --browser`.
- These tests found two additional recovery gaps, fixed here: retry alternate inventory
  when the owner returns after startup, and recover the gated pane PID before verifying
  its scope after an interrupted spawn. Offline CLI signals now detach cleanly and
  release ownership. Existing root typecheck and all 69 host unit tests pass.
- Physical phone and real Windows hardware are still unverified; Chromium's mobile
  viewport is not a physical phone test. Windows direct behavior is exercised by fakes
  and the Linux direct regression. Hardware checks remain follow-ups, not a gate on
  the independent jobs scaffold. No jobs or review-loop logic added to the daemon.

### 2026-09-16 — step 2 complete

- Step 1d committed/pushed as `dc0a5af`; final recovery changes deployed to the host.
- Added independent packages/jobs and packages/jobs-ui, strict authenticated settings/
  status API, disabled scheduler shell, SQLite settings revision/conflict handling and
  standalone mobile-friendly structured settings editor with import/export.
- Packaging clarification: optional apps have their own installs/lockfiles, not root
  npm workspaces. Root workspaces would install jobs dependencies for every normal
  Switchboard/Windows install, contradicting the isolation requirement. Root jobs:*
  scripts provide explicit opt-in setup/build/test/start. No host/web imports changed.
- Persistence clarification: settings use SQLite immediately (schema 1), avoiding a
  second JSON settings authority before step 3. Bootstrap port/token/allowed origins
  remain private machine-local service configuration; richer connections controls are
  step 4. Every current workflow setting is editable in the structured client now.
- Contracts grow with callers: the step-2 AgentSpawner covers health/list/inspect and
  is tested identically against a fixture-backed Switchboard adapter and a fake alternate.
  Creation, ambiguous outcomes and attempt fencing are explicitly deferred to step 7;
  no claim of idempotent host POST /sessions is made by this scaffold.
- Dependencies pinned separately: Node 22.23.2 baseline (runtime 22.23.x), built-in
  SQLite 3.51.3, Fastify 5.12.4 and puppeteer-core 25.11.0 (future capture/PDF; no browser
  installation/start). Full implemented column/settings documentation: packages/jobs/
  DATABASE.md. Runtime/contracts: packages/jobs/README.md. Checkpoint: IMPLEMENTATION-HANDOFF.md.
- Verification passed: jobs build/typecheck, seven scaffold tests, standalone HTTP and
  Chromium mobile-viewport acceptance, root typecheck, fresh isolated core-only Linux
  npm install/build and Windows dependency-resolution dry run. Existing 69 host tests
  passed after the last host changes. No claim of actual Windows hardware validation.
- Browser harness fixes: executablePath is asynchronous in pinned Puppeteer; background
  tabs needed explicit focus for clicks. Both corrected and acceptance rerun successfully.
- No live source crawling, applicant imports, notifications, browser jobs, child agents
  or applications were dispatched. Jobs service not yet installed as a live service.

### 2026-09-16 — step 3 complete

- Schema 2 adds workflow entities, immutable historical inputs, foreign keys, dedup keys,
  audit events, task leases/generations/fences and full agent context snapshot columns.
  Migrations from fresh and shipped schema 1 are transactional; future versions fail
  unchanged. DATABASE.md contains generated columns, exact constraints/triggers, and
  hand-written relationships, JSON validation boundaries and operational semantics.
- Content-addressed artifacts flush bytes and publish without replacement before their
  DB manifest can commit. Reads verify size/hash. Inspection reports corrupt/missing,
  unreferenced and unfinished files; nothing is automatically garbage-collected.
- Queue operations enforce one scheduler, current pause/enable settings, stale-result
  fencing, bounded explicit preparation retries and unresolved-child blocks. Interrupted
  submission work becomes unknown and cannot retry. Task changes/audit commit together.
- Scope clarification: these are tested storage primitives. No timer or workflow worker
  runs yet. Step 7 must wire startup child inventory, lease recovery and execution in that
  order; step 10 adds full policy/evidence/review checks before the send-intent primitive.
  A lease expiration or cancellation never proves a child has stopped.
- Online SQLite backup plus immutable artifact set restores into a new directory after
  integrity/hash verification. Restore disables/pauses jobs, fences pending work, clears
  scheduler ownership and retains run identities for reconciliation. Credentials excluded.
  Data CLI inspection/backup are read-only and never create/migrate a service database.
- Verification: jobs build and all 19 tests passed, including actual SIGKILL at four
  file/transaction boundaries, three competing processes, failed migration/audit rollback,
  unresolved child/retry guards and backup round-trip/corruption refusal. Standalone HTTP
  and Chromium mobile-viewport/revision-conflict acceptance passed again on schema 2.
  No host code changed and no external work was dispatched.

### 2026-09-16 — step 4 complete

- Step 3 committed/pushed as `857c103`. Earlier uncommitted step-4 starting point:
  schema-3 `attention_items` migration, `reviews.ts`, `dashboard.ts`, server
  registration and the storage version assertion.
- Core integration is deliberately narrow: an optional machine-local
  `switchboard.jobsUrl` origin stored in browser localStorage, an unauthenticated
  `/health` identity probe (timeout, 15s interval), and a sidebar link when online or
  a connection-settings entry when offline. No host/daemon or jobs token crosses the
  boundary; the jobs bearer token is entered only in the standalone jobs client.
- Jobs client (`packages/jobs-ui`) gained bounded dashboard lists (100 rows: jobs,
  applications, tasks, child agents, attention, recent decisions), saved
  task/agent/job/application details, authenticated artifact downloads forced inert
  (`application/octet-stream` + `Content-Disposition: attachment`), review decisions
  with version and settings-revision conflict checks, and 60s-cached data diagnostics.
  Search/start-agent/submit controls render disabled and stay unavailable.
- Review storage ties a decision to exact saved inputs: `attention_items` is immutable
  in its subject/version/context/task/run/artifact/settings columns, supersedes older
  open items for the same subject, and refuses decisions when settings or
  waiting-review task state changed. Approving records a decision only; a generic
  approval never dispatches work.
- Diagnostics cache is a repeated-request mitigation (60s, `checkedAt`/`cacheTtlMs`);
  cache misses still scan synchronously, and offline `data-cli inspect` remains uncached
  for repair/backup verification.
- Migration `schema 2 → 3` is transactional; a shipped schema-2 database retains its
  settings, tasks and artifacts, and future versions still fail unchanged.
- Verification (Node 22.23.2, Linux): `npm run jobs:build`, `npm run jobs:typecheck`
  and `npm run jobs:test` (24 tests, including the diagnostics-cache regression and
  four review-guard tests) passed; `npm run typecheck` and `npm test` (74 host tests)
  passed. `node packages/jobs/acceptance/scaffold.mjs` passed (independent lifecycle,
  auth, disabled dispatch, validation, stale-tab conflict, settings across restart,
  zero calls to the network trap). With an isolated core build,
  `WEB_DIST=… JOBS_BROWSER_EXECUTABLE=… node packages/jobs/acceptance/dashboard.mjs`
  reported ALL PASS: desktop+mobile durable reviews, stale-decision conflict, verified
  inert artifact download, cross-tab disable gate, online/offline core navigation, and
  the existing `ui`, `claim` and `agent-sync` core suites. `document-schema.mjs`
  regenerated DATABASE.md identically (docs current).
- The machine's web rebuild timer was stopped during client editing and restored after
  this verification; production core bundle then rebuilt from the committed source.
- No live jobs service, source crawl, child agent, notification or application was
  enabled or dispatched. No host/runtime behavior changed beyond optional navigation.

### 2026-09-16 — step 5 complete (posting import and evidence capture)

- Step 4 committed/pushed on branch `step4-jobs-dashboard` as `3cb8811`
  (`feat(web): add isolated job settings and dashboard`). This stage's commit is the
  branch head of `step5-posting-capture`; `master` was intentionally left at `3cc5add`
  because a second agent joined and stage work now happens on branches.
- `adapters/source.ts` defines the `JobSourceAdapter` contract (discover/normalize plus
  versioned per-action capabilities) and a registry factory that rejects unknown
  providers before any work exists. First implementations: `greenhouse` (public board
  API, HTML→text normalization) and `fixture` (deterministic local alternate). The same
  contract assertions run against both; no provider type leaks into workflow state
  beyond the preserved raw payload.
- `net.ts` adds an SSRF guard for every operator/adapter URL: http(s) only, no
  credentials, private/loopback/link-local/ULA/mapped-v4 addresses refused, DNS results
  checked, and each redirect re-checked (`redirect: manual`, five hops). `allowPrivate`
  exists only for the isolated local fixture and defaults false. `withRetries` retries
  only explicitly retryable failures with bounded attempts.
- `postings.ts` canonicalizes URLs (lowercased host, sorted query, tracking params and
  fragments stripped, trailing slash removed) and dedups on the scheme-insensitive
  canonical form, so an http→https redirect or a shared canonical URL from two sources
  yields one posting and one application. Snapshots are write-once, dedup within the
  same capture method/version, gate "complete" on non-empty text (and a screenshot for
  application preflight), and promote an application only from `discovered` to
  `captured`. `job_snapshots` immutability keeps changed/deleted postings archived.
- `capture.ts` captures through a real browser via an injected page backend: bounded
  lazy-load scrolling, `data-capture-incomplete`/short-text detection, full-page PNG,
  final-URL redirect re-check, and bounded retries. Nothing fabricates a success when
  capture fails.
- `sources.ts`/`discovery.ts` store the live source registry in SQLite and run
  discovery per enabled source, archiving complete raw responses as artifacts. A partial
  or failed scan is recorded as `blocked`/`failed` and never closes postings; a cap is
  visible, never silent.
- `postings-api.ts` exposes authenticated `GET/PUT /api/sources`,
  `POST /api/sources/:id/discover`, `POST /api/import/manual` (text only, explicitly no
  screenshot evidence) and `POST /api/import/url` (browser capture). An unavailable
  browser (409 `browser_unavailable`) or a refused/disabled source is reported with its
  code; adapter `SourceError`s map to 400/503 by retryability rather than a generic 500.
- `packages/jobs-ui` adds the import forms, source enable/disable and Discover actions,
  discovery-run status, and shows snapshot/screenshot evidence. Untrusted text renders
  through `textContent` only; captured markup never executes.
- Machine bootstrap (`service.json`) gains optional `browserExecutablePath` and
  `allowPrivateImport`; both are validated and private. `/api/status` reports the real
  `capture` capability, and `/api/dashboard` now includes recent discovery runs.
- Verification (Node 22.23.2, Linux): jobs build/typecheck, 45 jobs tests (9 new across
  HTML/net/HTTP, adapters, postings and capture), root typecheck and 74 host tests.
  `node packages/jobs/acceptance/capture.mjs` with real Chromium passed: exact text +
  PNG screenshot stored, redirect/tracking-param dedup, changed-then-deleted posting
  still archived, lazy/partial content stored but not promoted, manual import with no
  screenshot, unreachable page → 503 `capture_failed` after bounded retries, loopback
  target refused (400 `url_not_permitted`) without the fixture switch, registry
  discovery dedup, a partial scan that closed nothing, and archived markup not
  executing in the dashboard. `scaffold.mjs` and `dashboard.mjs` (dashboard + `ui`,
  `claim`, `agent-sync`) still pass. `DATABASE.md` regenerates identically (no schema
  change in this step).
- Not done here: no live board smoke test was run, no browser automation of employer
  forms, no applicant facts/resumes, no notifications and no application submission.
  The scheduled-search worker and classification/filtering remain step 8; submission
  policy remains steps 9–10.

### 2026-09-16 — step 6 complete (bullet-based resume library and render), PDF deferred

- Step 5 committed/pushed on branch `step5-posting-capture` as `ab8e2da`
  (`feat(jobs): capture versioned postings and screenshots`). This stage's commit is the
  branch head of `step6-resume-library`, stacked on step 5.
- **Operator decision (2026-09-16):** resumes are assembled from **bullet points** placed
  into 1–3 **base resume templates** that contain bullet slots. The first pass is built
  by a persona and then fully tailored by a second persona — that two-pass model work
  remains step 7. **PDF output is deferred** until a real need appears; this stage
  produces a structured source plus an exact text artifact, and `resume_versions`
  already carries a nullable `pdf_artifact_hash` for when it lands. No PDF/text-parsing
  dependency was added.
- `library.ts` stores immutable revisions of the operator's own material — profile facts
  (contact, summary, `facts` separated from unverified `suggestions`), bullets
  (`bulletId`, prose, tags, structured filters, evidence) and base templates — with
  strict validation before storage and JSON export/import that only ever appends new
  revisions. A malformed entry is rejected; existing history is never rewritten.
- `resume.ts` selects bullets deterministically and explainably (tag overlap with the
  job title/description, stable tie-break, `as-listed` alternative) and renders a
  `StructuredResume`: heading plus template-ordered sections (`facts`, `tags`,
  `bullets` with a slot limit). Missing required facts and unfilled slots are recorded in
  `missing` and printed as an explicit omissions line — omissions are visible, never
  guessed, and unverified suggestions are excluded. The render stores the text artifact
  and a `resume_versions` row (`phase='render'`, `pdf_artifact_hash=NULL`) referencing
  the exact snapshot/profile/template revisions; an identical re-render reuses the
  existing version instead of duplicating evidence.
- `library-api.ts` exposes authenticated `GET /api/library`,
  `PUT /api/library/profile|bullets|template`, `GET /api/library/export`,
  `POST /api/library/import`, `POST /api/resumes/render` (latest profile/template by
  default) and `GET /api/resumes/:id`. `/api/status` reports `resumes:true`, `pdf:false`;
  `/api/dashboard` now lists recent resume versions and job snapshots.
- `packages/jobs-ui` adds JSON editors for profile/bullets/templates, library
  export/import, a render form (snapshot/profile/template) and a preview showing the
  rendered text, the omissions line and each selected bullet's matched tags. Untrusted
  values still render as text only.
- Verification (Node 22.23.2, Linux): jobs build/typecheck; 50 jobs tests (4 new library/
  render tests) and 74 host tests; root typecheck. `node
  packages/jobs/acceptance/library.mjs` passed both HTTP-only and with real Chromium
  (revisions, deterministic render, visible omissions, suggestion exclusion, reused
  render, preserved earlier version after an edit, JSON round-trip into a fresh service,
  deferred PDF, client preview). `capture.mjs`, `scaffold.mjs` and `dashboard.mjs`
  (dashboard + `ui`/`claim`/`agent-sync`) still pass. `DATABASE.md` regenerates
  identically (no schema change).
- Not done here: no PDF, no persona/model call (step 7), no resume review/approval gate
  wiring, no application submission. Template rendering accepts only validated data; the
  model never writes arbitrary markup.

### 2026-09-16 — step 7a complete (persona snapshots, invocation and scoped tools)

- Step 6 committed/pushed on branch `step6-resume-library` as `6ba9806`
  (`feat(jobs): version bullet-based resumes and render structured text`). This
  checkpoint's commit is the branch head of `step7a-personas-tools`, stacked on step 6.
- **Operator decision (2026-09-16):** use placeholder personas and tools for now, model
  `openrouter/deepseek/deepseek-v4.1-flash` via OpenRouter (verified present with
  `pi --list-models`). Real persona/tool/bridge work is documented in
  [packages/jobs/PERSONAS.md](./packages/jobs/PERSONAS.md).
- `personas.ts` implements the shared machine-local convention: `manifest.md` frontmatter
  plus prompt body, `skills/<name>/SKILL.md`, strict subset validation, path containment,
  per-persona failure isolation and directory-absence as an empty state. `snapshotPersona`
  composes persona + selected skills + task into one immutable task file and records
  manifest/skill/composed revision hashes; the DB snapshot is the historical evidence, so
  editing or deleting the files never changes an old run.
- `tools.ts` implements the scoped assembly tool contract against validated library
  revisions (`list_templates`, `find_bullets`, `select_bullet`, `order_sections`,
  `render_preview`, `finalize_resume`) over a run-scoped `DraftState`. It rejects unknown
  templates/sections/bullets, duplicates, slot-limit overflow, invalid orders and
  unrenderable drafts. The model cannot invent bullets, prose or markup.
- `resume.ts` was refactored so the deterministic renderer and the tool-driven draft share
  one validated section builder; a finalized tool result persists through
  `ResumeRenderer.persist` as an explicit-selection render version.
- `invocation.ts` defines `AgentInvocationAdapter` with capabilities and a registry.
  `PiInvocationAdapter` builds the one-shot argv (`--model`, `--mode json`, `--no-session`,
  `--print`, `--tools`, optional `--thinking`/`--extension`, `@<task file>`), returns the
  jobs-owned result path and parses JSON stdout as a fallback only. The real `--mode json`
  envelope and the tool bridge remain explicitly unverified.
- Committed placeholder personas for the two required passes:
  `resume-assembler` (selects approved bullets; may not rewrite) and `resume-editor`
  (rewrites prose only; may not re-select). No `resume-checker` yet; it is optional.
- `personas-api.ts` adds read-only `GET /api/personas`: the configured directory, each
  persona's agent/model/tools/skills, per-persona errors, the tool catalogue and the
  invocation adapters. No agent is spawned by this route.
- Verification (Node 22.23.2, Linux): jobs build/typecheck; 57 jobs tests (7 new across
  personas, tools and invocation) and 74 host tests; root typecheck.
  `node packages/jobs/acceptance/personas.mjs` passed (auth, two valid personas with the
  configured model and tool exposure, malformed-persona isolation, empty state).
  `library.mjs`, `capture.mjs`, `scaffold.mjs` and `dashboard.mjs` still pass.
- Not done here (tracked in PERSONAS.md and the plan): the tool bridge that exposes
  `tools.ts` to a real agent process; confirming the CLI JSON envelope; any real model
  run; the two-pass workflow and decision logging (7b); spawner idempotency/host
  recovery (7c). A prompt-only tool list is **not** claimed as an enforced restriction.

### 2026-09-16 — step 7b complete (two-pass workflow and decision logging)

- Step 7a committed/pushed on branch `step7a-personas-tools` as `05ac552`
  (`feat(jobs): load personas and expose scoped tailoring tools`). This checkpoint's
  commit is the branch head of `step7b-tailoring-runner`, stacked on 7a.
- `adapters/spawner.ts` grows an optional control surface (`create`, `stop`) with an
  explicit `requireSpawnerControl` check, so a caller learns a spawner cannot create
  rather than pretending. `SwitchboardSpawner.create` posts literal argv as `extraArgs`
  with a `jobs:<application>:tailor:<stage>:<run>` label; `stop` issues `DELETE`.
  Creation has **no host idempotency key yet**, so a stage is never automatically
  retried — that window is closed in 7c.
- `runner.ts` implements `TailoringRunner`. Each stage:
  1. enqueues a task (audit + retry budget), creates a `0700` run directory and writes
     an immutable task file (persona + skills + task, including the jobs-owned result
     path and the untrusted posting text);
  2. snapshots the persona into `agent_runs` (persona text, skills, composed prompt,
     agent, model, tools, permissions, revision hashes) before any spawn;
  3. builds argv through the invocation adapter and creates a labelled session;
  4. polls retained exit state to a deadline, stopping the owned session on timeout;
  5. reads and validates the result file, then persists a resume version
     (`phase='build'` for assembly, `'edit'` for the edit pass, linked by
     `agent_run_id`/`parent_resume_id` with the edit diff and proposed patches in
     `edits_json`), records `tool_events`/`run_messages`, and opens a durable review item.
  A successful exit with no valid output artifact is a **failed** stage. Failures
  (missing output, malformed JSON, changed inputs, unsupported bullet revision, nonzero
  exit, lost session, hung run) mark the run `lost` and the task `failed`; no resume
  version is written.
- Validation is strict: the model may not change the run's snapshot/profile/template
  revisions, must name a candidate, and every `selectedBullet.revisionId` must be an
  approved revision of the run's profile — an invented bullet is rejected as
  `unsupported_fact`.
- `resume.persist` now takes `phase`, `agentRunId`, `parentResumeId` and `edits`, and
  de-duplicates per phase, so deterministic renders, model builds and model edits are
  distinct immutable versions.
- `runner-api.ts` adds operator-triggered `POST /api/tailoring` (fire-and-forget
  two-pass; status via `agent_runs`/review items) and read-only `GET /api/runs/:id`
  (run, tool events, messages, resume versions). The runner is built lazily and only
  when a private `spawnerToken` is present in `service.json`; without it the route
  returns 409 `spawner_unconfigured` instead of attempting a spawn.
- Verification (Node 22.23.2, Linux): jobs build/typecheck; 64 jobs tests (7 new runner
  tests with fake agents covering a valid assembly, the full two-pass with diff, and
  missing/malformed/changed-input/nonzero/lost/hung failures) and 74 host tests; root
  typecheck. `personas.mjs`, `library.mjs`, `capture.mjs`, `scaffold.mjs` and
  `dashboard.mjs` all still pass.
- Not done here: the host-side idempotency/reconnect contract and restart recovery
  (7c), the tool bridge and a real-agent smoke (see PERSONAS.md), and any scheduling or
  UI trigger for tailoring (step 8).

### 2026-09-16 — adapter provider registry (swappability hardening)

- Operator note (2026-09-16): connectors and bridges must be reusable contracts —
  interface/ABC plus a registry implementation — so another agent-spawning service or
  another CLI is one adapter file plus a setting, and the two apps stay black boxes.
- Fixed the one place that violated it. `spawner.provider` was a JSON-schema `const`
  pinned to `"switchboard"`, and `runner-api.ts` constructed `SwitchboardSpawner` and
  `createInvocationAdapter("pi")` directly. Now:
  - `adapters/spawner.ts` gains a provider registry (`registerSpawnerProvider`,
    `spawnerProviderIds`, `spawnerProviderRegistered`, `createSpawner(id, options)`),
    with `switchboard` registered by default.
  - `settings.spawner.provider` and the new `settings.spawner.invocationAdapter` are
    validated ids (optional for the latter, so existing settings stay valid); the
    settings PUT rejects unregistered ids with `unknown_provider`.
  - `runner-api.ts` builds the spawner and invocation adapter from settings through the
    factories; no provider name appears in workflow, runner or route code.
- Documented the recipe in `packages/jobs/README.md`: implement the contract, register
  it, change one setting. No host import, no jobs import of host — the daemon remains a
  black box behind `AgentSpawner`.
- Verification: jobs build/typecheck; 65 jobs tests (one new spawner-registry test, plus
  settings-route coverage that rejects an unregistered provider and accepts a registered
  custom one); root typecheck and host tests unaffected.

### 2026-09-16 — step 7c complete (spawner idempotency and restart recovery)

- Adapter-swappability checkpoint committed/pushed on `step7c-provider-registry` as
  `bec7491`. This stage's commit is the branch head of `step7c-spawner-recovery`.
- **First host change since step 1, and deliberately generic.** `Session` gains an
  optional `idempotencyKey`; `POST /sessions` accepts it, and a repeat returns the
  existing session (HTTP 200) instead of spawning a second PTY. `SessionManager`
  validates the key (`[A-Za-z0-9._:-]{1,200}`), refreshes durable intents first, then
  searches live sessions synchronously, so check-then-create cannot interleave a
  duplicate. The key rides on the `Session` object, so the tmux recovery registry
  persists and recovers it with no schema-version change; the ledger/direct backend
  keeps in-process idempotency only, which is all it can promise.
- Jobs side: `SpawnerCreateRequest`/`SpawnerSession` carry the key through the
  `AgentSpawner` contract; `SwitchboardSpawner` sends and reads it. `TailoringRunner`
  passes `jobs:<taskId>:<stage>`, and on a lost create *response* rediscovers the same
  session by key (`spawner.list()`), records `run.rediscovered` and adopts it instead of
  spawning again. A result is refused if the run is no longer `running`
  (`run_superseded`), so a late result from a cancelled/superseded attempt cannot become
  evidence.
- No jobs-specific knowledge entered the daemon, and no host import of jobs exists: the
  key is a plain string any caller may send.
- Verification (Node 22.23.2, Linux): host typecheck and 77 host tests (3 new
  idempotency tests with fake backends: duplicate key reuse, durable recovery without
  respawn, invalid key rejection). New `packages/host/acceptance/idempotency.mjs` passed
  against a real daemon (201 then 200, one process, distinct/absent keys spawn, invalid
  key 400). `packages/host/acceptance/restart.mjs` (real tmux owner) still reports
  **ALL PASS**, so the change does not disturb persistent recovery. Jobs typecheck and
  67 jobs tests (2 new: lost-response rediscovery, superseded-result refusal). All jobs
  acceptances (`personas`, `library`, `scaffold`, `capture`, `dashboard` + `ui`/`claim`/
  `agent-sync`) pass.
- Not done here: a real-agent smoke (needs the tool bridge, PERSONAS.md), the live-host
  restart confirmation (run when convenient: `git checkout <7c>`, build, restart only
  `switchboard.service`), and the step-8 worker that will drive tailoring on a schedule.

### 2026-09-16 — step 8a complete (discovery scheduling, pagination and backoff)

- Branch `step8-search-filtering` from `step7c-spawner-recovery` (which carries the merged
  master display fixes). This checkpoint covers scheduling/pagination/backoff; scored
  filtering, screening decisions and UI inspect/skip/requeue follow in 8b.
- Adapters grew an opaque, adapter-defined `checkpoint`: `DiscoveryResult.checkpoint` is
  persisted in `search_runs.checkpoint_json`, and `SourceContext.checkpoint`/`attempt`
  let a source resume mid-scan. Greenhouse turns a capped board response into ordered
  pages by offset; the fixture adapter gained `pagination.pageSize` and a
  `rateLimit.firstAttempts` fault. `SourceError` carries an optional `retryAfterMs`, and
  `withRetries` honours a server `Retry-After` (capped at 30s) instead of inventing a
  delay.
- `Discovery.run` loops pages: it archives each response, ingests what it sees, **persists
  the checkpoint after every page**, and marks a run `completed` only when the source is
  exhausted. A cap or rate limit leaves the run `blocked` with its resume point, so a
  later run continues where it stopped. `MAX_PAGES_PER_RUN` bounds a runaway adapter.
- `scheduler.ts` replaces the disabled shell with a real `DiscoveryScheduler` plus a pure
  `schedulerStatus`. Due is derived from stored run times and per-source
  `schedule.intervalMinutes` (default 360), so a **restart never stampedes**. A cycle runs
  due sources one at a time under the shared `scheduler_lock` lease (added
  `TaskQueue.releaseScheduler`), renews it between sources, bounds a cycle to
  `MAX_SOURCES_PER_RUN`, uses `requests.maxPostingsPerRun` as the cap, and records one
  source's failure without stalling the rest. Enable/pause is re-read every cycle.
  `runOnce({force:true})` is the operator "run now" action.
- `scheduler-api.ts` exposes read-only `GET /api/scheduler` (status + recent runs) and
  `POST /api/scheduler/run` (`{force?}`; refuses to overlap the background worker). The
  worker starts in `index.ts` and stops on SIGTERM. `/api/status` now reports real
  scheduling state.
- Verification (Node 22.23.2, Linux): jobs build/typecheck; 77 jobs tests (10 new across
  discovery pagination/checkpoint/resume/dedup/rate-limit/partial/disabled and scheduler
  due/pause/restart/cap/lock/bounded-cycle/fault-isolation); root typecheck. New
  `packages/jobs/acceptance/scheduling.mjs` passed against the real service (due, paginate
  → checkpoint → resume, cap, repeat dedup, rate-limit retry, pause, disabled source, UTC
  run times, restart without stampede). `scaffold`, `personas`, `library` and `capture`
  acceptances still pass, including the scaffold's "no external work while disabled"
  check with the worker running.
- Not in 8a: scored filtering, unknown-vs-mismatch, salary normalization, screening
  decisions and inspect/skip/requeue (8b); notifications deliberately deferred.

### 2026-09-16 — step 8 complete (explainable screening)

- Schema 4 adds append-only `screening_decisions` (job, source, settings revision,
  decision, score, reasons, actor, time) with immutable/delete triggers. Migrations
  v3→v4 are transactional; DATABASE.md regenerated.
- `filtering.ts` is deterministic and never invents a value:
  - `normalizeLocation` treats empty/"N/A"/"unknown" as **unknown**, not as a value.
  - `normalizeSalary` parses currency + amounts + period, and **never converts
    currency**: two currencies, no currency, or no plausible amount yields `known:false`
    with the raw text preserved. `extractSalaryText` pulls a phrase from posting text.
  - `classifyFamily` maps technical roles to the researched families and returns `null`
    for non-technical or ambiguous titles.
  - `screenJob` scores and explains: a satisfied filter matches (with the matched terms),
    a definite mismatch **excludes**, and a field the posting does not state is
    `needs_review`. Exclusion wins over an unrelated unknown, so a real mismatch is not
    hidden as ambiguous.
- `screening.ts` records every decision as an audit event, drives the application state
  (`eligible`→screened, `excluded`/`skipped`→skipped, `needs_review`→block reason), and
  never reverts an approved/submitted application. Operator `skip` (requires a reason)
  and `requeue` are recorded decisions with `actor='operator'`. Re-screening a job with no
  captured text is honestly `needs_review`.
- Discovery screens each newly ingested posting against the source's `filters`, so the
  reason is captured while the text is available. `GET /api/screening` lists decisions and
  counts; `POST /api/jobs/:id/skip|requeue|screen` perform the operator actions. The
  dashboard and standalone client show the decisions with reasons and skip/requeue.
- Verification (Node 22.23.2, Linux): jobs build/typecheck; 82 jobs tests (5 new filtering
  and screening tests, plus the schema-2 upgrade fixture updated for schema 4); root
  typecheck; `DATABASE.md` regenerated. `scheduling.mjs` now also covers eligible/excluded
  decisions, reason recording and audited skip/requeue. `scaffold`, `library`, `capture`
  and `dashboard` (dashboard + ui/claim/agent-sync) all pass.
- Notifications remain **optional and deferred** (the durable inbox/attention counts are
  the required part and already exist): no ntfy transport, no digest cursor, no external
  messages. Automatic tailoring currently starts from the operator, not the queue; wiring
  queue-capacity-aware auto-tailoring belongs with the step-9/10 workflow.

### 2026-09-16 — step 9a complete (application adapter contract and preparation/preflight)

- Branch `step9-application-prep` from `step8-search-filtering`. This checkpoint covers the
  adapter contract and the preparation/preflight core. Browser automation (dedicated
  supervised profile, real form filling), the HTTP surface, the review UI and the fixture
  form server are **9b**, which finishes step 9.
- `adapters/application.ts` adds `ApplicationAdapter` on the same registry pattern as
  spawners/sources/invocation (`registerApplicationAdapter` / `createApplicationAdapter` /
  `applicationAdapterIds`). Capabilities are explicit — `submit` is separate and the
  fixture reports `submit:false`, so step 9 can never claim submission. A `manual` adapter
  honestly declares it has no automation rather than pretending; a deterministic `fixture`
  adapter supplies fields and fault flags from options.
- `preparation.ts` performs preflight before anything is filled:
  1. a **complete** posting capture must exist (else `missing_evidence`), be within the
     freshness window (else `stale_capture`), a resume version must be selected
     (`missing_resume`), and its text artifact must verify by size/hash (`corrupt_resume`);
  2. the adapter inspects the form; CAPTCHA or forbidden automation becomes a durable
     inbox handoff (`captcha` / `forbidden_automation`), never a fill attempt;
  3. required fields that cannot be filled block as `unsupported_required_fields` with the
     field names — a partial form is never presented as ready.
  A successful preparation writes an immutable `application_attempts` draft row with the
  full manifest (evidence hashes, resume hash/bytes, adapter + version, form URL, fields,
  filled values, uploads, answers, settings revision) plus a `manifestHash`. The
  idempotency key is derived from the application, evidence, resume, settings and form, so
  repeating a preparation reuses the same draft and **creates no duplicate**. A
  `source_policy` revision is created with `submit:false` when none exists. Blocked and
  needs-input outcomes drive application state and open an `application-handoff` review
  item carrying the form URL, answers and resume.
- Verification (Node 22.23.2, Linux): jobs build/typecheck; 87 jobs tests (5 new:
  registry honesty, clean draft + idempotent repeat, missing/stale/corrupt evidence blocks,
  unsupported-required-field block, CAPTCHA/forbidden/manual handoffs). No schema change
  (the attempt and policy tables already existed); DATABASE.md unchanged.
- Not in 9a: the dedicated supervised browser + profile and real filling, the HTTP routes,
  the review screen (posting text/images, resume, answers, diff since review), the fixture
  form server acceptance, and manual-completion receipts. Those are 9b. Nothing in 9a
  transmits or submits anything.

### 2026-09-16 — step 9b complete except the review screen

- Branch `step9-application-prep`. `browser.ts` supervises exactly one Chromium with a
  profile under the jobs data directory and an ownership record; ownership is proven by
  `--user-data-dir`, so a recycled PID is dropped rather than killed, and a reap reports
  `killed` only after observing the death (a survivor is reported `failed` and kept on
  record). The service reaps its own orphan at startup and shares that one browser with
  posting capture, so there are never two Chromium instances.
- `form.ts` adds the `FormSession` seam and a real `PuppeteerFormSession`: fields read from
  standard DOM semantics, name validation before any CSS selector, input/change dispatch,
  an SSRF re-check after redirect, and CAPTCHA/forbidden markers surfaced instead of
  bypassed. `fixture-form` fills text/select/checkbox, uploads a named copy of the verified
  resume, records what the page actually shows as evidence, and clicks only the site's own
  non-submitting preview control — never submit.
- `applications.ts` / `applications-api.ts`: approval bound to one attempt's manifest hash
  (a mismatched or non-draft approval is refused), automatic cancellation of a prior
  approval when different evidence or answers are prepared, `changesSinceReview`, the review
  package (posting evidence, resume, answers, agent run, source link), handoff resolution
  and operator-reported manual completion with the receipt stored as an artifact.
- `acceptance/forms.mjs` (real Chromium, loopback fixture site): the site receives the exact
  fields and the exact resume sha256 with **zero submissions**; an identical repeat contacts
  the site zero times; changed answers create a new attempt; CAPTCHA and forbidden pages
  become handoffs carrying URL/answers/resume with no further request; a page with no form
  is a valid reviewable outcome; a second supervisor reaps the left-behind browser and no
  unmanaged Chromium child survives.
- Verified: jobs typecheck, 101 jobs tests (4 new), `scaffold`, `scheduling` and `forms`
  acceptances all pass. Still outstanding for step 9: the review screen in `jobs-ui`
  (posting text/images, selected resume, answers, changes since review, approve, handoff
  resolution, manual completion). Nothing in this stage submits an application.
