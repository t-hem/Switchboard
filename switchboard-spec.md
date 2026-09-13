# Switchboard — build spec

> Rename the project to whatever you want; "Switchboard" is a placeholder used consistently below.

This document is the complete specification for an agent to implement. Read the whole thing before writing code. Build in the phases given, in order, and stop at each phase boundary for review.

---

## 1. What this is

A personal control plane for terminal coding agents running across several machines.

Each machine runs a **host daemon** that can spawn and own agent CLI processes (Claude Code, Codex, pi, Gemini CLI, or anything else configured). A single **web client** talks to every host daemon at once, shows one merged list of all live sessions across all machines, and lets the operator attach to any of them from any device on the tailnet — desktop, laptop, or phone.

The agent processes always run on the machine that owns the repo. Nothing about how they run changes. Switchboard is transport and dispatch only.

### The one-line test of success

Sitting on the couch with a phone, the operator can see that a Claude Code session on the Windows desktop is blocked waiting for a permission prompt, tap it, type `y`, and watch it continue — without SSH, without a VPN beyond the existing tailnet, and without touching the desktop.

---

## 2. Non-goals — do not build these

These are deliberate exclusions. Do not add them, do not design "hooks for them later," do not leave TODOs about them.

- **No multi-user support.** Exactly one human uses this. No accounts, no roles, no user table.
- **No session history persistence.** When a session ends, it's gone. Git and PR threads are the record of work. Scrollback lives in memory only.
- **No database.** No SQLite, no Postgres, no ORM. In-memory state plus one JSON config file per host.
- **No PR automation, code review pipeline, or model routing.** Out of scope entirely.
- **No real-time sync between clients.** One client at a time (see §6). Refresh is an acceptable sync mechanism.
- **No agent-specific parsing or structured protocol adapters.** Sessions are raw PTYs. Do not parse Claude Code's JSON stream format or Codex's proto mode. Universal PTY handling is the whole point — it means a new agent CLI is a config line, not a code change.
- **No auth beyond a static bearer token per host.** The network boundary is Tailscale.
- **No Docker, no Kubernetes, no reverse proxy config.** `tailscale serve` handles TLS.

---

## 3. Architecture

```
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│  desktop1   │   │  desktop2   │   │   laptop    │
│  (Windows)  │   │  (Linux)    │   │  (Windows)  │
│             │   │             │   │             │
│ switchboard │   │ switchboard │   │ switchboard │
│   -host     │   │   -host     │   │   -host     │
│   :7777     │   │   :7777     │   │   :7777     │
│      │      │   │      │      │   │      │      │
│   PTYs:     │   │   PTYs:     │   │   PTYs:     │
│  claude x2  │   │  codex x1   │   │  claude x1  │
│  codex  x1  │   │  pi     x1  │   │             │
└──────┬──────┘   └──────┬──────┘   └──────┬──────┘
       │                 │                 │
       └────────── tailnet (HTTPS + WS) ───┘
                         │
                ┌────────┴────────┐
                │ switchboard-web │
                │  (static SPA,   │
                │  served by any  │
                │  one host)      │
                └─────────────────┘
```

The web client is a static bundle. Any host can serve it; it holds its own list of host daemons in browser local storage and fans out to all of them. It has no backend of its own.

### Stack

- **Host daemon:** Node 22+ / TypeScript. Fastify (or plain `node:http` + `ws`) for HTTP and WebSocket. `node-pty` for PTY management.
  - `node-pty` is non-negotiable: it is the only mature cross-platform PTY binding, and it wraps ConPTY on Windows. Two of the three machines are Windows. Do not substitute `child_process.spawn` with pipes — TUI agents need a real PTY or they degrade to non-interactive mode and line editing breaks.
- **Client:** React + Vite + TypeScript. `@xterm/xterm` with `@xterm/addon-fit` and `@xterm/addon-attach` (or a hand-rolled WS binding — `addon-attach` is fine and simpler). Tailwind for layout.
- **Package layout:** single repo, `packages/host` and `packages/web`, npm workspaces. No monorepo tooling beyond that.

---

## 4. Host daemon

### 4.1 Configuration

**Two files**, both in `~/.switchboard/`, created with defaults on first run if absent. The split is by ownership: one file describes *this machine* and never leaves it, the other describes *the fleet* and is synced across hosts (§5.5).

**`host.json`** — machine-local, never synced:

```json
{
  "port": 7777,
  "token": "<generated on first run, printed to stdout once>",
  "hostLabel": "desktop1",
  "scrollbackBytes": 262144,
  "workspaceRoots": ["C:\\dev", "C:\\projects"]
}
```

The token is per-host and must never be transmitted to another host or included in any sync payload. `workspaceRoots` is machine-specific by nature — Windows drive paths are meaningless on the Linux box.

**`agents.json`** — shared across all hosts, synced by the client:

```json
{
  "updatedAt": 1757635200000,
  "agents": {
    "claude": { "cmd": "claude", "args": [] },
    "codex":  { "cmd": "codex",  "args": [] },
    "pi":     { "cmd": "pi",     "args": [] },
    "gemini": { "cmd": "gemini", "args": [],
                "install": "npm i -g @google/gemini-cli" }
  }
}
```

- `agents` is an open map. Adding a new agent CLI is a config edit and a reload — never a code change.
- `cmd` may be overridden per-platform with an optional `platform` object: `{ "cmd": "pi", "platform": { "win32": { "cmd": "pi.cmd" } } }`. Merge the platform block over the base at load time.
- `install` is an optional display-only string: the command a human should run to install this agent. The daemon never executes it. See §5.5.
- `updatedAt` is epoch ms, set by the daemon on every write. It is the sole conflict-resolution input.
- On startup **and on every write to `agents.json`**, probe each agent with a `which`/`where` lookup and mark it `available: true|false`. Report this in `/health`. Do not fail startup if an agent is missing — an agent that's configured but not installed is a normal, expected state on some machines.
- Changes to `agents.json` take effect without a daemon restart. Reload the map in place; running sessions are unaffected.
- `workspaceRoots` is used only to populate a directory picker in the client. Scan one level deep for directories containing a `.git` folder, cache the result for 60s.

### 4.2 Session model

```ts
type Session = {
  id: string;              // nanoid
  agent: string;           // key from config.agents
  cwd: string;
  label: string;           // defaults to `${basename(cwd)} · ${agent}`
  status: "running" | "exited";
  exitCode: number | null;
  pid: number;
  cols: number;
  rows: number;
  createdAt: number;       // epoch ms
  lastOutputAt: number;    // epoch ms — drives the idle indicator
};
```

Sessions live in an in-memory `Map<string, SessionRuntime>` where `SessionRuntime` holds the `IPty`, the `Session` metadata, and a scrollback ring buffer.

**Scrollback:** a fixed-size byte ring buffer, default 256 KB, appended on every PTY data event. Never written to disk. On attach, the buffer is replayed to the client in one chunk before live streaming begins. This is what makes "open the laptop and hit refresh" work.

**Lifecycle:** PTYs are children of the daemon. A daemon restart kills all sessions. This is accepted — see §9 for the optional tmux variant if it turns out to be annoying in practice. Sessions must survive client disconnect, browser close, and network drops; only daemon exit ends them.

### 4.3 HTTP API

All routes except `/health` require `Authorization: Bearer <token>`. Reject with 401 otherwise.

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/health` | `{ hostLabel, platform, version, agents: [{name, available}], sessionCount }`. **No auth** — used by the client to show a host as reachable-but-unauthorized vs offline. |
| `GET` | `/sessions` | `Session[]` for this host. |
| `POST` | `/sessions` | Body `{ agent, cwd, cols?, rows?, extraArgs?: string[] }`. Validates that `agent` exists and is available and that `cwd` is an existing directory. Spawns the PTY. Returns the `Session`. |
| `GET` | `/sessions/:id` | Single `Session`. 404 if unknown. |
| `DELETE` | `/sessions/:id` | SIGTERM the PTY, then SIGKILL after 3s if still alive. Removes from the map. Returns 204. |
| `GET` | `/workspaces` | `string[]` of candidate directories from `workspaceRoots`. |
| `GET` | `/config/agents` | Returns the full contents of `agents.json`, plus a parallel `availability: Record<string, boolean>` map for this machine. |
| `PUT` | `/config/agents` | Body `{ agents, updatedAt }`. Writes `agents.json` verbatim, re-probes availability, reloads in place. Returns the stored result. Rejects with 409 if the submitted `updatedAt` is *older* than the stored one, unless `?force=1`. |
| `POST` | `/control/claim` | Body `{ clientId, clientLabel }`. See §6. |

The daemon never reaches out to another daemon. All cross-host movement of `agents.json` is done by the client, which is the only component that knows the full host list and holds every token.

### 4.4 WebSocket

`GET /sessions/:id/stream?token=<token>` — upgrade to WS. (Token goes in the query string because browsers can't set headers on `WebSocket`. Acceptable inside the tailnet; the token never leaves it.)

**Server → client** — two frame kinds:
- Binary frames: raw PTY output bytes, forwarded as-is.
- Text frames: JSON control messages, `{ type: "exit", exitCode }` and `{ type: "evicted", reason }`.

On connect, immediately send the scrollback buffer as one binary frame, then stream live.

**Client → server** — JSON text frames only:
- `{ type: "input", data: string }` — written verbatim to the PTY.
- `{ type: "resize", cols: number, rows: number }` — calls `pty.resize()`.

Do not invent a framing protocol on top of the PTY bytes. Binary means terminal data, text means control. That's the whole protocol.

### 4.5 CORS

The client is served from one host but talks to three. Enable permissive CORS (`*`, all methods, `Authorization` header allowed) on every route. This is safe here because the token is the actual gate and the daemon is only reachable on the tailnet.

---

## 5. Web client

### 5.1 Host registry

Stored in `localStorage` under `switchboard.hosts`:

```ts
type HostEntry = { id: string; label: string; baseUrl: string; token: string };
```

A settings screen allows add / edit / remove / reorder. Adding a host should immediately hit `/health` and show whether it's reachable and whether the token works.

### 5.2 Session list (the primary view)

Poll `GET /sessions` on every configured host every 5 seconds, in parallel, with a 3s timeout each. A host that fails is shown as offline with a "last seen" timestamp — it must never block or error the rest of the list.

The merged list is sorted by `lastOutputAt` descending, so the session that just did something floats to the top. Each row shows:

- Host label and agent name
- Session label (repo directory)
- A status dot: green = output within the last 5s (working), amber = idle more than 20s while running (**probably waiting for input — this is the most important state in the whole app**), grey = exited
- Relative time since last output

Group headers by host, with a per-host "new session" button.

### 5.3 Terminal view

Clicking a session opens an xterm.js pane bound to that host's WS endpoint. Requirements:

- Fit addon plus a `ResizeObserver`; send `resize` on every change, debounced 150ms.
- Reconnect with exponential backoff on socket close, up to ~30s, unless the close was an `evicted` control message (then show the takeover banner and stop retrying).
- A visible connection state indicator: connected / reconnecting / evicted / session exited.

**Desktop layout:** session list in a left sidebar, terminal filling the rest. Keep the sidebar visible — switching between machines should be one click.

**Mobile layout:** full-screen list, tap into a full-screen terminal with a back button. Two things that are not optional on mobile:

1. **A line-input bar pinned above the keyboard.** A text field plus a send button that transmits the typed text followed by `\r`. Mobile soft keyboards against a raw terminal are miserable; this bar is how the phone case actually works.
2. **A row of quick-send buttons** next to it: `y`, `n`, `Esc`, `Ctrl-C`, `↑`, `Enter`. Permission prompts and menu selections are the overwhelming majority of phone interactions.

Register a PWA manifest and a minimal service worker so it installs to the home screen. `tailscale serve` supplies the HTTPS origin that installability requires.

### 5.4 New session flow

A modal: host (pre-filled if opened from a host header) → agent (only ones reporting `available`) → directory (dropdown from `GET /workspaces`, with a free-text fallback) → create. On success, navigate straight into the new session's terminal view.

---

### 5.5 Agent config sync

The agents map is fleet-wide state stored redundantly on every host. The client reconciles it.

**Detection.** On app load, and whenever the settings screen is opened, `GET /config/agents` from every reachable host. Compare `updatedAt`. If they don't all match, show a non-blocking banner on the session list:

> *Agent config differs across hosts — newest is on desktop2. [Review]*

**Reconciliation.** "Review" opens a diff view: the newest config on one side, each stale host's current config on the other, with added/removed/changed agent keys highlighted. One button — *Sync all to newest* — PUTs the winning payload to every out-of-date host. Last-write-wins on the whole map, decided purely by `updatedAt`.

Show the diff before applying rather than syncing silently. With one user this is nearly always trivial and one click, but silent last-write-wins can quietly discard an agent added on the other machine, and a two-second glance prevents it.

**Editing.** The settings screen edits the agents map directly. Saving PUTs to the host currently selected as the edit target and stamps a fresh `updatedAt`; the banner then immediately offers to propagate it to the rest. Never edit the map in `localStorage` — the daemons are the source of truth, so the config is correct for every browser and every device automatically.

**Offline hosts.** A host that's unreachable is skipped, not blocked on. It will show as stale the next time it's seen and get picked up by the same banner.

**Availability is per-host and is never synced.** A synced agents map plus per-host availability probing is what makes this useful: add `deepseek` once on the Linux box, sync, and both Windows machines now show it greyed out and labelled *not installed on desktop1*. The agent entry travels; the binary doesn't.

There is no way around installing the actual CLI on each machine — accept that. What the spec does instead is make the gap visible and actionable: when an agent is configured but unavailable on a host, surface its `install` string in the UI as a copyable command, so the remaining work is pasting one line into that machine's terminal rather than remembering what the install command was. The daemon must not execute `install` itself; keep it display-only.

Deliberately crude, because the multi-client problem is being defined out of existence rather than solved.

Each browser generates a stable `clientId` (nanoid in `localStorage`) and a `clientLabel` (editable in settings, e.g. "laptop", "phone").

- On app load and on window focus, the client POSTs `/control/claim` to **every** configured host.
- Each daemon stores the current claimant. When a new `clientId` claims, the daemon closes all open session WebSockets belonging to the previous claimant with a `{ type: "evicted", reason: "claimed by <label>" }` control frame first.
- WS upgrades from a non-claimant `clientId` are rejected with 403. The client passes its `clientId` as a query param alongside the token.
- The evicted client shows a full-width banner: *"Taken over by laptop — [Take back]"*, where the button re-claims.

Sessions keep running throughout. Eviction only severs the view, never the work.

---

## 7. Build phases

Stop after each phase. Do not begin the next until the acceptance criteria pass.

### Phase 0 — Scaffold
Workspace repo, both packages, TypeScript configs, `npm run dev` for each, config file creation with generated token, `/health` responding.

*Accept:* `curl http://localhost:7777/health` returns valid JSON listing which agents are installed on this machine.

### Phase 1 — Host daemon, single session
PTY spawn, session map, scrollback ring buffer, full REST surface, WS streaming with replay-then-live, kill and exit handling, token auth.

*Accept:* using a scratch WS client (a small Node script is fine), spawn `claude` in a real repo, send input, see output, disconnect, reconnect, and confirm the replayed scrollback shows everything that happened while disconnected. Then `DELETE` the session and confirm the process is gone from the OS process list.

### Phase 2 — Client, single host
Hardcode one host. Session list with polling, terminal view, new-session modal, resize handling.

*Accept:* create, attach to, interact with, and kill a session entirely from the browser. Resizing the window reflows the agent's TUI correctly.

### Phase 3 — Multi-host
Host registry UI, parallel fan-out polling, merged and grouped list, per-host offline handling.

*Accept:* with daemons running on all three machines and a session live on each, one browser shows all three and can drive any of them. Powering off one machine leaves the other two fully usable, with the third marked offline.

### Phase 3.5 — Agent config sync
Config file split, `GET`/`PUT /config/agents`, in-place reload, drift banner, diff view, sync-all, install-hint display for unavailable agents.

*Accept:* add a new agent entry on the Linux host through the settings screen. The banner appears within one page load. Syncing propagates it to both Windows machines, where it appears greyed out with a copyable install command. Install the CLI on one of them and confirm it flips to available without a daemon restart.

### Phase 4 — Client lock
Claim protocol, eviction frames, takeover banner, take-back button.

*Accept:* attach on desktop, then open the client on the phone. The desktop shows the takeover banner within a second or two and its sockets close. Tapping take-back on the desktop reverses it. A session that was mid-task on either device is still running and its output is intact.

### Phase 5 — Mobile polish
Responsive layout, line-input bar, quick-send button row, PWA manifest and service worker, `tailscale serve` setup documented in the README.

*Accept:* installed to the phone home screen. Answer a real Claude Code permission prompt from the couch, using only the quick-send buttons.

---

## 8. Engineering constraints

- TypeScript strict mode on. No `any` outside of narrow, commented interop points.
- No test framework beyond `node:test` for the ring buffer and the claim-state machine — those two have real logic worth pinning. Everything else is verified by the manual acceptance steps above. Do not write UI tests.
- Windows paths are first-class. Never assume `/` separators, never assume a POSIX shell, and test `cwd` validation with drive-letter paths.
- The daemon must start fine when zero agents are installed and must not crash when a PTY dies unexpectedly.
- Log to stdout only. No log files, no log rotation, no structured logging library.

---

## 9. Deferred, with notes (do not implement)

- **tmux-backed sessions.** If daemon restarts killing sessions becomes irritating, wrap each PTY in `tmux new-session -d -s sw-<id>` on Linux and attach to it, so the daemon can re-discover and reattach on boot. Windows has no equivalent, so this would make the two platforms diverge. Revisit only if the pain is real.
- **Idle push notifications.** The amber "waiting for input" state is exactly the signal worth pushing. An `ntfy` or Telegram POST when a session crosses the idle threshold would mean not having to check at all. Small addition once §5.2 exists.
- **PR review pipeline.** Separate project. It consumes this one's ability to launch a session on a chosen host, so keep `POST /sessions` clean enough to be called by a script.

---

## 10. Reference

`codeg` (github.com/xintaofei/codeg) solves the single-host version of this and its client/server split is the same shape: mobile clients point at one server with a URL and a token, and files, agent CLIs, and conversations all stay on the host. It is a reasonable UI reference. Do not fork it — the repo is large, fast-moving, and a Tauri app, and a thin client against a small purpose-built daemon will age far better than a deep fork.
