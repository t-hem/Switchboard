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
| 1 | Host daemon: PTY sessions, scrollback, REST, WS | not started |
| 2 | Client against a single host | not started |
| 3 | Multi-host fan-out | not started |
| 3.5 | Agent config sync | not started |
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

## Layout

```
packages/host   Node 22 + TypeScript daemon (Fastify, node-pty)
packages/web    React + Vite + Tailwind static client (xterm.js)
```
