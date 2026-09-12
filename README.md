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

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Scaffold, config files, `/health` | done |
| 1 | Host daemon: PTY sessions, scrollback, REST, WS | done |
| 2 | Client against a single host | done |
| 3 | Multi-host fan-out | done |
| 3.5 | Agent config sync | done |
| 4 | Client lock / takeover | not started |
| 5 | Mobile polish, PWA, `tailscale serve` | not started |

## Requirements

- **Node 22+.** `node-pty` is built from source on install, so a C++ toolchain is
  needed (`build-essential` + `python3` on Linux, Xcode CLT on macOS, VS Build Tools
  on Windows).
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
about the work. A clean shutdown kills its own sessions and leaves the ledger empty.

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

## Running the daemon from a clean shell

Spawned agents inherit the daemon's environment, so the daemon should be started from
an ordinary shell. Launching it from inside another agent's session leaks that
session's variables into every agent it spawns — a real example seen during testing:

```
⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker
```

Anything that needs adjusting per machine belongs in `host.json`'s `env` block.

## Testing

```bash
npm test          # ring buffer + the ledger's PID-reuse guard (node:test)
npm run typecheck
```

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
  src/ledger.ts       orphan bookkeeping with the PID-reuse guard
  src/proc.ts         process identity and liveness, per platform
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
