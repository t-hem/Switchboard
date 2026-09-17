# Jobs add-on — install, operate, recover

Operating procedures for the optional jobs add-on (`packages/jobs` + `packages/jobs-ui`).
[README.md](./README.md) describes the product; [TESTING.md](./TESTING.md) lists what is
verified and what is not. This file is the runbook.

**Read the limitations section before trusting it with a real application.** The add-on
prepares and can send applications; the one thing that does not work yet is the model-driven
tailoring pass, because the tool bridge does not exist.

## What runs where

| Process | Port | Unit | Data | Notes |
| --- | --- | --- | --- | --- |
| Switchboard host daemon | 7777 | `switchboard.service` | `~/.switchboard/{host,agents}.json` | Spawns agents. Restarting it is safe. |
| tmux owner | unix socket | `switchboard-owner.service` | `~/.switchboard/owner.sock` | Owns persistent sessions. **Never restart it** during routine work. |
| Jobs service | 7780 | *none — started by hand* | `$JOBS_DIR` (default `~/.local/share/switchboard-jobs`) | Linux only, loopback only, its own token. |
| Jobs client | served by the jobs service | — | — | Static files from `packages/jobs-ui/dist`. |

The jobs service never imports the host's code and the host never imports jobs. They speak
HTTP. The jobs service reaches a browser only through its own supervised Chromium.

## Prerequisites

- Node **22.23.x** (`.nvmrc`; the jobs entry points refuse anything else with an actionable
  message). The shell default on this machine is Node 20, so prefix commands with
  `source ~/.nvm/nvm.sh && nvm use 22.23.2`.
- An installed Chrome/Chromium for capture and forms. On this machine:
  `/home/thomas/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome`.
- The host daemon running if you want agent runs (`systemctl --user status switchboard.service`).

## Install and first run

```sh
source ~/.nvm/nvm.sh && nvm use 22.23.2
npm run jobs:setup     # installs the jobs package's own dependencies (not a root workspace)
npm run jobs:build     # builds the service and the client into packages/jobs/dist, jobs-ui/dist
npm run jobs:test      # 117 tests
npm run jobs:start     # http://127.0.0.1:7780
```

The first start creates `$JOBS_DIR/service.json` (`0600`) with a random token. Open the
client, paste that token into the connection field, and press **Connect**. The token is
separate from the host token and is never logged.

`dist/` is not in git. Building the client is a deliberate step: the service serves
`packages/jobs-ui/dist`, and returns `ui_not_built` until you run `npm run jobs:build`.

### Bootstrap configuration (`$JOBS_DIR/service.json`, machine-local, `0600`)

| Key | Meaning |
| --- | --- |
| `port`, `token` | Loopback port and the bearer token every client must present. |
| `allowedOrigins` | Extra exact origins (e.g. a tailnet HTTPS origin for the phone). Same-origin is always allowed. |
| `browserExecutablePath` | Absolute path to Chrome. Without it, URL capture and all form work report unavailable instead of pretending. |
| `allowPrivateImport` | Permits loopback/private capture targets. Only for the local fixtures. |
| `spawnerToken` | The **host** token, so the jobs service may ask the host to spawn agents. Private; never returned by the API. |

Changing bootstrap values requires a jobs restart. `JOBS_DIR` moves the data directory at
startup; moving a live database through settings is not supported.

## Secrets and credentials

There is **no `.env` file and nothing reads one**. Two machine-local files hold secrets, both
outside git and both `0600`:

1. **`~/.switchboard/host.json` → `env`** — merged into the environment of every agent the
   host spawns (`agentEnv` = `process.env` + `host.json.env` + `pathPrepend`), and used for
   the availability probe as well, so the two cannot disagree. An API key that must arrive as
   an environment variable belongs here:

   ```json
   "env": { "OPENROUTER_API_KEY": "sk-or-v1-…" }
   ```

   `host.json` is read **at startup only** — restart `switchboard.service` after editing it.
   (`agents.json` does hot-reload; `host.json` does not.) Verified 2026-09-17: after a restart,
   a newly spawned child's environment contained the key.

2. **`$JOBS_DIR/service.json`** — the jobs token, and the `spawnerToken`/browser path above.
   Excluded from backups on purpose: a restored archive never carries bootstrap credentials.

**Never put secrets in `agents.json`.** It is synced verbatim across the fleet, so anything
machine-specific there becomes wrong on every other machine. It names bare commands only.

An agent CLI that holds its own login needs nothing here: children run as your user and read
the same credential store.

## First-run configuration

Everything below is editable from the client; the API equivalents are listed for scripting.

1. **Settings** — `/api/settings`. Jobs start `enabled: false, paused: true, mode: "draft"`,
   with every review gate on. Choose `mode` (`draft` | `review` | `automatic`) deliberately;
   nothing sends in `draft`. Save with the revision you read (`expectedRevision`), or you get
   a 409 rather than a lost update.
2. **Sources** — `/api/sources/:id`. `fixture` for local rehearsal, `greenhouse` for a real
   board (`config: {companyName, boardId}`, optional `schedule.intervalMinutes`,
   `requests.maxPostingsPerRun`). Disabled sources are never scheduled.
3. **Site policies** — `/api/policies`. Preparing a site creates revision 1 with
   `submit: false`. Permitting submission, enabling automatic sending and the daily cap are
   explicit, audited revisions; tightening one immediately blocks an already approved send.
4. **Personas** — `settings.personaDirectory` (default `~/.switchboard/personas`). The
   committed placeholders install there; see [packages/jobs/PERSONAS.md](./packages/jobs/PERSONAS.md).
5. **Career library** — `/api/library` in the client: profile facts, bullets, one base
   template. Rendering is deterministic and explainable; PDF output is not implemented.

## Everyday operation

- **Capture evidence**: *Import a posting* with a real URL (stores exact text plus a
  full-page screenshot), or manual text import (records that there is no screenshot evidence).
- **Discovery**: enable a source and run it, or let the scheduler run it on its interval.
  Runs checkpoint after each page, so a cap or rate limit resumes instead of restarting.
- **Screen**: every posting gets a recorded decision with reasons. Unknown salary or location
  is *unknown*, never a mismatch, and currency is never converted.
- **Select a resume**: the package view lists every resume rendered for that posting and
  records your choice (`POST /api/applications/:id/resume`); a resume built for another posting
  is refused. Preparation blocks without one.
- **Prepare**: choose an application, adapter, form URL and answers. Preparation rechecks the
  evidence, fills the employer's own form with the supervised browser, uploads a named copy of
  the verified resume, and stops before submitting. Preview only — never the submit control.
- **Review and approve**: the package shows posting text, screenshot, source link, selected
  resume with its agent run, the answer set, what changed since the last review, and the
  approval state. Approving binds to that exact manifest hash.
- **Send** (review mode): the Sending section sends an approved attempt. Every gate and the
  effective policy are rechecked at that moment. A double click cannot send twice.
- **Reconcile**: an unconfirmable send is recorded `unknown` with an inbox item. Record what
  you actually found; that is stored as operator-reported, never as machine-observed, and
  nothing is retried automatically.
- **Pause/disable**: `/api/settings` or the client. Disabling stops new discovery, agent runs
  and submissions; read/history/downloads keep working. It never kills or claims unrelated
  Switchboard sessions.

## Backup, restore, export, health, repair

```sh
# Health (exit 1 on a failed store): database, artifacts, disk, queue, retention, backup gaps
JOBS_DIR=$DIR node packages/jobs/dist/data-cli.js health

# Consistent database + artifact backup; records an archive.backup event
JOBS_DIR=$DIR node packages/jobs/dist/data-cli.js backup /path/to/new-archive

# Restore into a NEW directory, disabled and paused; --read-only also refuses every write
node packages/jobs/dist/data-cli.js restore /path/to/archive /path/to/new-data-dir [--read-only]

# A self-contained application export, and offline verification with no database and no service
JOBS_DIR=$DIR node packages/jobs/dist/data-cli.js export-application <application-id> /path/to/new-export
node packages/jobs/dist/data-cli.js reconstruct /path/to/export
```

- A **read-only** restore writes a marker; the service then reports `readOnly`, refuses every
  write with `read_only_archive`, and dispatches nothing. Remove the marker deliberately to
  use it.
- Backups exclude bootstrap credentials, so a restored directory needs its own `service.json`.
- Retention is `retain-all` with no age-based pruning: submitted evidence and failed/rejected
  drafts stay. Health names the gaps it cannot close (for example no recorded backup).
- On startup, every application attempt still `submitting` belonged to a process that died,
  however recently, and becomes `unknown` with a reconciliation inbox item. Before each send,
  attempts stuck in `submitting` for more than ten minutes are swept the same way. Run one jobs
  service per data directory.
- Queue repair (`POST /api/queue/repair`) releases expired leases back to the queue but turns
  an interrupted submission into an explicit `unknown` — never a silent retry.

## Upgrades

```sh
git pull
npm run jobs:setup && npm run jobs:build && npm run jobs:test
systemctl --user restart switchboard.service     # only if the host code changed
npm run jobs:start                               # restart the jobs service by hand
```

**Never restart `switchboard-owner.service`** for a routine upgrade. Restarting the host daemon
is safe: on 2026-09-17 three live tmux sessions survived a `switchboard.service` restart and
remained attachable. The jobs service holds its own browser; on shutdown it reaps the Chromium
it owns, and an interrupted send becomes `unknown` at the next start rather than a retry.

## Publishing the client

`packages/jobs-ui/dist` is gitignored and must be built (`npm run jobs:build`) after the
isolated acceptances pass. The client is served only by the jobs service on loopback; exposing
it beyond that means a separate reverse proxy with an exact `allowedOrigins` entry.

## Machine-local paths that must not enter git

`~/.switchboard/host.json`, `~/.switchboard/agents.json` (portable, but no absolute paths),
`$JOBS_DIR/service.json`, `$JOBS_DIR` itself, `packages/*/dist`, and any browser profile under
the jobs data directory. `.gitignore` covers `dist/`, `.env`, `node_modules/`.

## Limitations to know before real use

- **The model-driven tailoring pass cannot run yet.** The runner invokes the agent with
  `[--extension <bridge>] [--tools …] @<taskfile>` and that bridge does not exist, so a live
  model cannot call the draft tools. The real `--mode json` envelope is also unverified. Every
  other stage works; see PERSONAS.md.
- Personas, prompts and resume content are placeholders until authored.
- No PDF output (structured text only), no notifications (the inbox is the notification).
- Only the fixture form adapter exists. On a real site, use the manual handoff and record the
  receipt — a real target needs its own adapter.
- Real boards, `tailscale serve`, the desktop browser and the phone have not been exercised;
  Windows has had three runs, the last two bugs fixed but not re-verified.
