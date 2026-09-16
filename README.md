# Switchboard

A personal control plane for terminal coding agents running across several machines.

Each machine runs a **host daemon** (`packages/host`) that spawns and owns agent CLI
processes (Claude Code, Codex, pi, Gemini CLI, …) in real PTYs. A single static
**web client** (`packages/web`) talks to every daemon at once, shows one merged list of
live sessions across all machines, and lets you attach to any of them from any device
on the tailnet.

The agent processes always run on the machine that owns the repo. Switchboard is
transport and dispatch only.

See [`switchboard-spec.md`](./switchboard-spec.md) for the full specification.

Switchboard is deliberately small, and stays that way by pushing everything that
reasons about the *work* into separate programs that call its HTTP API. Two are
planned — a PR review loop and a job-application pipeline — and spec §9 records both,
along with the three API properties they depend on that look like oversights and are
not. Spec §2's exclusions ("no database", "no persistence", "no pipelines") scope the
**daemon and client**, not the programs built on top.

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Scaffold, config files, `/health` | done |
| 1 | Host daemon: PTY sessions, scrollback, REST, WS | done |
| 2 | Client against a single host | done |
| 3 | Multi-host fan-out | done |
| 3.5 | Agent config sync | done |
| 4 | Client lock / takeover | done |
| 5 | Mobile polish, PWA, `tailscale serve` | done |

**First pass complete, 2026-09-15.** All six phases are built, and the thing the spec
set out to do works: a session running on the Linux box can be driven from a phone on
the tailnet, and from a desktop browser, over HTTPS, with the daemon coming up by
itself at boot.

What that pass cost, beyond the phases themselves: four Windows bugs (two found by
reading node-pty's source, two by running it), a pty that kept the phone's width when
opened on a desktop, `Ctrl-Z` silently stranding sessions with no shell to resume
them, clipboard chords going to the pty as control bytes, and single-click kills with
no confirmation.

Still open: a full multi-machine fleet under load — the Windows box is out with
unrelated hardware faults — and one low-priority rendering defect. See
[TESTING.md](./TESTING.md), which is honest about what is proven and what is not.

## Requirements

- **Node 22+.** `node-pty` ships prebuilt binaries for Windows and macOS and falls
  back to compiling, so a C++ toolchain is needed on Linux (`build-essential` +
  `python3`) but **not** on Windows — verified on a bare Windows 10 machine, where
  `npm install` never invoked node-gyp. Only install VS Build Tools if an install
  actually falls through to a compile.
- Agent CLIs are installed per machine. A configured-but-missing agent is a normal
  state — it shows as unavailable rather than breaking startup.

## Quick start

```bash
npm install
npm run dev:host   # daemon on :7777, prints its token on first run
npm run dev:web    # client dev server on :5173
```

```bash
curl http://localhost:7777/health
```

```json
{
  "hostLabel": "thomas-ai-machine",
  "platform": "linux",
  "version": "0.1.0",
  "agents": [{ "name": "claude", "available": true }],
  "sessionCount": 0
}
```

`/health` is the only unauthenticated route — the client uses it to tell
"offline" apart from "reachable but the token is wrong".

## HTTP API

Every route except `/health` requires `Authorization: Bearer <token>` and answers 401
without it. CORS is permissive — the token is the gate, the tailnet is the boundary.

| Method | Path | Behaviour |
|---|---|---|
| `GET` | `/health` | Host label, platform, version, agent availability, session count. **No auth.** |
| `GET` | `/sessions` | Every session on this host. |
| `POST` | `/sessions` | `{ agent, cwd, cols?, rows?, extraArgs?, label? }` → spawns a PTY, returns the session. Validates that the agent exists *and is installed here*, and that `cwd` is an existing directory. |
| `GET` | `/sessions/:id` | One session, or 404. |
| `DELETE` | `/sessions/:id` | SIGTERM, then SIGKILL after 3s. Answers 204 immediately; escalation continues in the background. |
| `POST` | `/control/claim` | `{ clientId, clientLabel }` → takes the single-client lock, evicting the previous holder's streams. |
| `GET` | `/workspaces` | Directories one level under `workspaceRoots` that contain a `.git`, cached 60s. |
| `GET` | `/config/agents` | The agents map plus a per-host `availability` block. |
| `PUT` | `/config/agents` | `{ agents, updatedAt }` → validated, written verbatim, re-probed, reloaded in place. 409 if the submitted `updatedAt` is older than the stored one, unless `?force=1`. |
| `GET` | `/orphans` | Processes that outlived a previous daemon run (see below). |
| `POST` | `/orphans/kill` | `{ ids?, force? }` → kills orphans after re-verifying each one's identity. |

### WebSocket

`GET /sessions/:id/stream?token=<token>` — the token travels in the query string
because browsers cannot set headers on a `WebSocket`.

- **Server → client:** binary frames are raw PTY bytes, forwarded verbatim. Text
  frames are JSON control messages (`{ type: "exit", exitCode }`).
- **Client → server:** JSON text frames only — `{ type: "input", data }` and
  `{ type: "resize", cols, rows }`.

On connect the scrollback buffer is replayed as one binary frame before live
streaming begins, so reattaching from another device reconstructs the full screen.
There is no framing protocol on top of the PTY bytes: binary means terminal data,
text means control.

## Agent config sync

`agents.json` is fleet-wide state stored redundantly on every host, and the **client**
reconciles it — the daemon never talks to another daemon. On load and whenever
settings is opened, the client reads `/config/agents` everywhere and compares
`updatedAt`. A mismatch raises a banner naming the host holding the newest map, and
*Review* shows a per-host diff of added, removed and changed agents before anything
is applied. Last-write-wins on the whole map, decided purely by `updatedAt`.

The diff is shown rather than synced silently because a silent last-write-wins can
quietly discard an agent added on another machine.

`updatedAt` is written **verbatim**, never restamped by the receiving daemon — a
synced map has to be identical everywhere, and restamping would make every host
permanently disagree. The client stamps a fresh value when a human edits the map.

Availability is probed per machine and never synced, which is what makes this useful:
add an agent once, sync, and the machines missing the binary show it greyed out with
its `install` string as a copyable command. The gap between "configured" and
"installed" cannot be closed remotely, so it is made visible and one paste wide
instead. Installing the CLI flips it to available without a daemon restart.

## One client at a time

The multi-client problem is defined out of existence rather than solved. Each browser
keeps a stable `clientId` in localStorage and claims every configured host on load
and on window focus. A host has at most one claimant; when the claim moves, the
previous holder's session streams are sent `{ type: "evicted", reason }` and closed,
and a WebSocket upgrade from a non-claimant is refused with 403 before it upgrades.

The evicted device shows a full-width banner naming who took over, with a *Take back*
button that re-claims and reattaches.

**Eviction only severs the view.** Nothing in the claim path touches a pty: sessions
keep running, and the scrollback replayed to whoever attaches next contains
everything both devices did.

Claiming happens on load and on focus — deliberately never on a background
reconnect. A phone waking in a pocket and silently stealing the session from the
desktop you are working at would be worse than the problem the lock solves.

A daemon with no claimant yet lets the first stream in, which takes the claim
implicitly. Refusing until an explicit claim lands would make a freshly started
daemon briefly unusable, and it weakens nothing — a later claim still evicts.

## Orphaned sessions

PTY children generally *survive* a daemon crash, so an unclean exit would otherwise
leave agent processes that are tedious to find by hand. The daemon keeps a ledger at
`~/.switchboard/sessions.json` — `{ id, pid, agent, cwd, startedAt, processStartTime }`
per live session, added on spawn and removed when the process actually exits.

On startup it reads the ledger and reports survivors:

```
2 orphaned session(s) survived a previous run:
  16fWHpckO97tV7cdZqsQy  pid 147218  bash   /home/thomas/myrepo
Nothing was killed. Use the client, or POST /orphans/kill, to clean up.
```

**Nothing is ever killed automatically.** PIDs get recycled, and a stale ledger entry
pointing at a recycled PID would happily kill something unrelated — so every entry
records the process creation time at spawn (`/proc/<pid>/stat` field 22 plus the boot
time on Linux, `(Get-Process -Id X).StartTime.Ticks` on Windows) and that must match
exactly before anything is signalled. An entry that cannot be verified is dropped, not
killed.

This is process bookkeeping, not session history: it holds no scrollback and nothing
about the work. A clean direct-backend shutdown kills its sessions and leaves this
ledger empty. The opt-in Linux tmux backend uses a separate recovery registry and
retains workloads across HTTP shutdown; see LINUX-SESSIONS.md.

## Configuration

Two files in `~/.switchboard/`, both created with defaults on first run.
Set `SWITCHBOARD_DIR` to point somewhere else.

### `host.json` — machine-local, never synced

```json
{
  "port": 7777,
  "token": "<generated on first run, printed to stdout once>",
  "hostLabel": "desktop1",
  "scrollbackBytes": 262144,
  "workspaceRoots": ["C:\\dev", "C:\\projects"],
  "pathPrepend": [],
  "env": {}
}
```

The token is per-host and is never transmitted to another host or included in any
sync payload.

`pathPrepend` (directories put in front of `PATH`) and `env` (extra environment
variables) define the environment agents are both **probed** and **spawned** with, so
availability can never disagree with what actually launches. They live here, not in
`agents.json`, because they are machine-specific — see the note on `nvm` below.

### `agents.json` — fleet-wide, synced between hosts by the client

```json
{
  "updatedAt": 1757635200000,
  "agents": {
    "claude": { "cmd": "claude", "args": [] },
    "pi": { "cmd": "pi", "args": [], "platform": { "win32": { "cmd": "pi.cmd" } } },
    "gemini": { "cmd": "gemini", "args": [], "install": "npm i -g @google/gemini-cli" }
  }
}
```

- Adding an agent is a config edit, never a code change.
- `platform` overrides are merged over the base entry at load time, keyed on
  `process.platform`.
- `install` is display-only. The daemon never executes it.
- `updatedAt` (epoch ms) is the sole conflict-resolution input for sync.
- Availability is probed per machine by resolving `cmd` against `PATH` (a `which` /
  `where` lookup done in-process, honouring `PATHEXT` on Windows). It is never synced.

## Note on `nvm` and agent visibility

npm global installs live under the *active* Node version's `bin` directory. If the
agent CLIs were installed under Node 20 and the daemon runs under Node 22, the daemon
cannot see them and reports them unavailable. Fix it in that machine's `host.json`:

```json
{ "pathPrepend": ["/home/you/.nvm/versions/node/v20.20.2/bin"] }
```

**Do not fix it by putting an absolute path in `agents.json`.** That file is synced to
every machine in the fleet, so a path that is correct on one is wrong everywhere else.
`agents.json` names bare commands (`"cmd": "claude"`); `host.json` says where this
machine finds them.

## Serving it over the tailnet

The client is a static bundle; any host can serve it. `tailscale serve` supplies the
HTTPS origin, which is also what makes the app installable to a phone home screen.

**Every daemon needs to be served over HTTPS too, not just the client.** A page
loaded over `https://` cannot fetch `http://` or open `ws://` — browsers block it as
mixed content, with no useful error. Serving the client over TLS while leaving the
daemons on plain `http://…:7777` produces an app where every host silently shows as
offline.

On **each** machine, expose its daemon:

```bash
tailscale serve --bg --https=8443 7777
# -> https://<machine>.<tailnet>.ts.net:8443
```

On **one** machine, also serve the built client:

```bash
npm run build -w @switchboard/web
tailscale serve --bg --https=443 /absolute/path/to/packages/web/dist
# -> https://<machine>.<tailnet>.ts.net
```

Then open that URL, and add each host as `https://<machine>.<tailnet>.ts.net:8443`
with the token from that machine's `host.json`. WebSockets are proxied as `wss://`
automatically.

`tailscale serve status` shows what is exposed; `tailscale serve reset` removes it.
Nothing here is exposed to the public internet — that would be `tailscale funnel`,
which this does not use.

## Installing to a phone

Open the HTTPS URL and use *Add to Home Screen*. The app then launches standalone,
and the terminal view gets a line-input bar pinned above the keyboard plus quick-send
buttons for `y`, `n`, `Esc`, `Ctrl-C`, `↑`, `↓`, Space, Tab and `Enter` — permission
prompts and menu
selections are the overwhelming majority of phone interactions, and a raw terminal
against a soft keyboard is miserable for both.

The service worker only ever caches this app's own origin. Host responses are never
cached: a stale session list is worse than no session list.

## Status of testing

Everything so far was verified on **Linux only**, by suites that drive real daemons,
real PTYs and a real browser. Windows, the real multi-machine fleet, `tailscale serve`
and the phone are **not yet verified**.

**→ [TESTING.md](./TESTING.md)** is the checklist, ordered so the most likely blocker
comes first. Start there before trusting any of this on a new machine.

**→ [WINDOWS-SETUP.md](./WINDOWS-SETUP.md)** is the self-contained bring-up guide for
a Windows machine joining the fleet — prerequisites, config, `tailscale serve`, and
the Windows checklist with the known traps. Hand it to a session on that machine.

## Running the daemon from a clean shell

Spawned agents inherit the daemon's environment, so the daemon should be started from
an ordinary shell. Launching it from inside another agent's session leaks that
session's variables into every agent it spawns — a real example seen during testing:

```
⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker
```

Anything that needs adjusting per machine belongs in `host.json`'s `env` block.

### Running it as a service instead

Better than remembering: have the init system start it, so it comes up at boot with a
clean environment every time and nothing has to be launched by hand. On Linux that is a
**systemd user service**; on Windows, a startup `.bat`.

```bash
systemctl --user status switchboard     # is it up
systemctl --user restart switchboard    # after a git pull
journalctl --user -u switchboard -f     # follow the logs
```

The unit files are **deliberately not in this repo** — they are machine-local, like
`host.json`. Paths, Node version and notification mechanism differ per machine, and a
committed unit would be wrong on every other one. Three things are worth copying
whenever you set this up on a new Linux box:

- **Run the built output, not `npm run dev:host`.** `dev:host` is `tsx watch`, which
  restarts on source changes — on a long-running daemon that kills every live PTY
  session the moment a file is edited. Build first (about a second), then run
  `packages/host/dist/index.js`, so a `git pull` also cannot leave it quietly serving
  stale JavaScript.
- **`exec` the daemon** from any wrapper script, so the init system supervises `node`
  itself. Otherwise SIGTERM reaches the wrapper and the daemon's shutdown — which
  signals each PTY and *awaits* termination — never runs.
- **`KillMode=mixed`.** systemd's default signals the whole cgroup, which kills the
  agent processes out from under the daemon and strands their ledger entries. Only the
  daemon should get the signal; it cleans up its own children.

Starting it through systemd is also what lets an agent session restart the daemon
without contaminating it: systemd is the parent, so none of the calling session's
variables are inherited.

Pair it with an `OnFailure=` unit that writes the journal tail somewhere findable and
raises a desktop notification. A daemon that is simply absent shows up in the client as
a host that is offline, with no reason given.

## Testing

```bash
npm test          # node:test — 64 cases
npm run typecheck
```

`npm test` covers the places with real logic to pin: the scrollback ring buffer, the
claim state machine, the ledger's PID-reuse guard, the per-platform process ops, and
the kill escalation. The last two matter disproportionately, because the Windows code
paths cannot be executed by a Linux machine — they run against plain objects and a fake
`ProcessOps`, so both platforms are exercised from either OS.

Everything else is verified by acceptance harnesses that drive real software rather
than mocks:

- [`packages/host/acceptance/`](./packages/host/acceptance/README.md) — drives a
  running daemon over the same HTTP + WebSocket surface the browser uses, including
  one harness that runs a real Claude Code session and asserts on the rendered screen.
- [`packages/web/acceptance/`](./packages/web/acceptance/README.md) — drives the
  built client in a real Chromium against a real daemon.

## Layout

```
packages/host   Node 22 + TypeScript daemon (Fastify, node-pty)
  src/config.ts       host.json + agents.json loading
  src/env.ts          the one resolved agent environment (probe and spawn share it)
  src/availability.ts in-process which/where
  src/registry.ts     agents map + availability, reloadable in place
  src/ringbuffer.ts   fixed-size scrollback
  src/sessions.ts     PTY lifecycle, subscribers, kill escalation
  src/ledger.ts       orphan bookkeeping with the PID-reuse guard (takes a ProcessOps)
  src/ptybytes.ts     normalise an onData chunk to bytes (Windows hands over strings)
  src/platform/       ProcessOps: spawn argv, kill a pty, kill by pid, process identity
    posix.ts win32.ts   one implementation each, chosen once at load
  src/server.ts       REST + WebSocket
  acceptance/         harnesses for the manual acceptance steps

packages/web    React + Vite + Tailwind static client (xterm.js)
  src/api/client.ts       typed fetch wrappers, per-request timeouts
  src/state/hosts.ts      host registry in localStorage
  src/state/useFleet.ts   parallel polling, one host's failure isolated from the rest
  src/hooks/useTerminal.ts xterm <-> WebSocket binding, reconnect backoff, resize
  src/components/         session list, terminal, modals, banners
  acceptance/             browser-driven acceptance
```

## Linux session recovery

An opt-in tmux backend can retain Linux agents across HTTP daemon restarts. It requires
an independently supervised tmux owner and per-session systemd user scopes. See
[LINUX-SESSIONS.md](LINUX-SESSIONS.md) for configuration, display guarantees and offline
recovery, and [JOB-APPLICATION-PLAN.md](JOB-APPLICATION-PLAN.md) for rollout status.
The default/direct backend and Windows still terminate sessions during shutdown.
