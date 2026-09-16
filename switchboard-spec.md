# Switchboard — build spec

> Rename the project to whatever you want; "Switchboard" is a placeholder used consistently below.

This document is the complete specification for an agent to implement. Read the whole thing before writing code. Build in the phases given, in order, and stop at each phase boundary for review.

---

## Approved extension (2026-09-16)

See `JOB-APPLICATION-PLAN.md` for the approved next stages and current implementation
status. Linux gains an opt-in tmux session backend; Windows retains direct PTYs and
terminate-on-restart. Jobs and the future review loop are separate same-repository
applications, accessed through optional UI links and generic HTTP contracts. They own
their persistence and dependencies; the host never loads their business logic. This
overrides older wording below requiring pipelines to live outside this repository.
The opt-in backend is implemented and verified in isolated tests; production migration
is tracked separately as step 1d. See LINUX-SESSIONS.md for configuration/recovery.
Persistent streams contain tmux-rendered output; reconnect reconstructs the current
screen, not the previous daemon's raw byte ring or full browser scrollback.

## 1. What this is

A personal control plane for terminal coding agents running across several machines.

Each machine runs a **host daemon** that can spawn and own agent CLI processes (Claude Code, Codex, pi, Gemini CLI, or anything else configured). A single **web client** talks to every host daemon at once, shows one merged list of all live sessions across all machines, and lets the operator attach to any of them from any device on the tailnet — desktop, laptop, or phone.

The agent processes always run on the machine that owns the repo. Nothing about how they run changes. Switchboard is transport and dispatch only.

### The one-line test of success

Sitting on the couch with a phone, the operator can see that a Claude Code session on the Windows desktop is blocked waiting for a permission prompt, tap it, type `y`, and watch it continue — without SSH, without a VPN beyond the existing tailnet, and without touching the desktop.

---

## 2. Non-goals — do not build these into Switchboard

These are deliberate exclusions **from the daemon and the web client**, and within those two things they are absolute: do not add them, do not design "hooks for them later," do not leave TODOs about them.

They are *not* a list of things that may never exist. Several are planned as separate programs that call this one's HTTP API — see §9. The distinction is what keeps this project small: Switchboard is transport and dispatch, and everything that reasons about the *work* lives outside it. When you need one of these, the answer is a program calling the API, never a feature in the daemon.

- **No multi-user support.** Exactly one human uses this. No accounts, no roles, no user table.
- **No session history persistence _in the daemon_.** Scrollback is an in-memory ring buffer, never written to disk; when the daemon exits it is gone. A caller that needs a durable record of what an agent did keeps its own (§9).
- **No database _in the daemon_.** No SQLite, no Postgres, no ORM here. In-memory state plus one JSON config file per host. A program built on top may use whatever storage it likes; that storage does not live in this repo and the daemon never reads it.
- **No pipelines in the daemon** — no PR automation, no code review loop, no application automation, no model routing. Each is a separate program (§9). Switchboard owes them exactly one thing: starting and observing an agent session on a chosen machine from something that is not a browser. "No model routing" means the *daemon* never chooses a model or a provider; passing `--model` through to a CLI is just argv and is already supported by `extraArgs`.
- **No real-time sync between clients.** One client at a time (see §6). Refresh is an acceptable sync mechanism.
- **No agent-specific parsing or structured protocol adapters.** Sessions are raw PTYs. Do not parse Claude Code's JSON stream format or Codex's proto mode, and never make the transport depend on which agent is running. Universal PTY handling is the whole point — it means a new agent CLI is a config line, not a code change.

  The test is that last sentence, not the word "parsing". Reading something out of the *rendered* scrollback for display — the model a session is currently using, say — is allowed **provided the patterns live in `agents.json` and a new agent is still a config line**. It must be best-effort and cosmetic: a miss shows nothing, a bad pattern never breaks a row or a session, and nothing in the spawn, stream or kill path may depend on a match. Anything that makes the daemon *understand* an agent's protocol is the thing being excluded here.
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
  "workspaceRoots": ["C:\\dev", "C:\\projects"],
  "pathPrepend": [],
  "env": {}
}
```

The token is per-host and must never be transmitted to another host or included in any sync payload. `workspaceRoots` is machine-specific by nature — Windows drive paths are meaningless on the Linux box.

`pathPrepend` (directories put in front of `PATH`) and `env` (extra variables) define the environment agents are both **probed** and **spawned** with, so availability can never disagree with what actually launches. They are here rather than in `agents.json` because they are machine-specific: npm global installs live under the *active* Node version's bin directory, so a daemon on Node 22 cannot see CLIs installed under Node 20. The fix is a `pathPrepend` entry on that machine — never an absolute `cmd` in `agents.json`, which is synced to every host and would then be wrong on all the others.

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
| `POST` | `/sessions` | Body `{ agent, cwd, cols?, rows?, extraArgs?: string[], label? }`. Validates that `agent` exists and is available and that `cwd` is an existing directory. Spawns the PTY. Returns the `Session`. |
| `GET` | `/sessions/:id` | Single `Session`. 404 if unknown. |
| `DELETE` | `/sessions/:id` | SIGTERM the PTY, then SIGKILL after 3s if still alive. Removes from the map. Returns 204. |
| `GET` | `/workspaces` | `string[]` of candidate directories from `workspaceRoots`. |
| `GET` | `/config/agents` | Returns the full contents of `agents.json`, plus a parallel `availability: Record<string, boolean>` map for this machine. |
| `PUT` | `/config/agents` | Body `{ agents, updatedAt }`. Writes `agents.json` verbatim, re-probes availability, reloads in place. Returns the stored result. Rejects with 409 if the submitted `updatedAt` is *older* than the stored one, unless `?force=1`. |
| `POST` | `/control/claim` | Body `{ clientId, clientLabel }`. See §6. |

The daemon never reaches out to another daemon. All cross-host movement of `agents.json` is done by the client, which is the only component that knows the full host list and holds every token.

**`POST /sessions` is authenticated but deliberately _not_ claim-gated (§6).** A program that spawns a session is not a browser and must not evict whoever is sitting in front of one. This looks like an oversight and is not; do not "fix" it. The same reasoning governs any future read-only observation route (§9).

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

**Desktop layout:** session list in a left sidebar, terminal filling the rest. The sidebar is visible by default — switching between machines should be one click. It can be collapsed with a `☰`, which persists per device; the requirement is that nothing *forces* the list out of view, not that it can never be dismissed.

**Mobile layout:** full-screen list, tap into a full-screen terminal with a back button. Two things that are not optional on mobile:

1. **A line-input bar pinned above the keyboard.** A text field plus a send button that transmits the typed text and then its `\r`. Mobile soft keyboards against a raw terminal are miserable; this bar is how the phone case actually works.

   The line and the return must not arrive in one read. A TUI that reads stdin in bursts treats a multi-character read as *pasted* text, so the `\r` is inserted into the composer as a newline instead of submitting — the line lands and simply sits there. Sending the return only once the agent has produced output, which is proof it read the line, is what makes it register as a keypress. A fixed delay is not enough: it is a race that a busy agent loses.
2. **A row of quick-send buttons** next to it: `y`, `n`, `Esc`, `Ctrl-C`, `↑`, `↓`, Space, Tab, `Enter`. Permission prompts and menu selections are the overwhelming majority of phone interactions. Both arrows, Space and Tab are needed together for a multi-select prompt — arrows move, Space toggles, Tab moves between questions, Enter commits — and without them such a prompt cannot be answered from a phone at all.

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

## 6. Single client at a time

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
- No test framework beyond `node:test`, and only where there is real logic to pin: the scrollback ring buffer, the claim state machine, the orphan ledger's PID-reuse guard, the per-platform process ops, and the kill escalation. The last two matter disproportionately because the Windows half cannot be executed by the machine that reviews it — they are written against plain objects and fakes so both platforms are exercised from either OS. Everything else is verified by the acceptance harnesses. Do not write UI tests.
- Windows paths are first-class. Never assume `/` separators, never assume a POSIX shell, and test `cwd` validation with drive-letter paths.
- The daemon must start fine when zero agents are installed and must not crash when a PTY dies unexpectedly.
- Log to stdout only. No log files, no log rotation, no structured logging library.

---

## 9. Deferred, with notes (do not implement yet)

Unlike §2, these are not exclusions. They are the next things, written down so they get built deliberately rather than improvised into the daemon under pressure. Nothing here is started without a decision to start it.

- **tmux-backed sessions.** Wrap each PTY in `tmux new-session -d -s sw-<id>` on Linux and attach to it, so the daemon can re-discover and reattach rather than owning the processes. This was deferred with "revisit only if the pain is real," and as of 2026-09-15 two of the three conditions behind that have changed:

  **The pain is real, and it is specific.** An agent session can edit the daemon, test it against a throwaway daemon on another port, and commit — but it cannot make *the daemon it is running inside* become the new code, because the restart that would load it is the thing that kills it. That is tolerable for a tool used a few times a month and much less so once a pipeline is spawning sessions that work on this repo.

  **The platform divergence is cheaper than it was.** Process lifecycle already lives behind `ProcessOps` with one implementation per platform (see the engineering constraints), so a Linux-only session backend has somewhere to go that is not an `if` in the middle of shared code. Windows would keep today's behaviour: a restart ends its sessions.

  What has *not* changed is that this is the largest single increase in moving parts the daemon could take on — session discovery, reattachment, tmux's own failure modes, and a second source of truth about what is running alongside the ledger. Treat "restart between tasks" as the baseline it is competing against, not as a problem that obviously needs solving.

- **Idle push notifications.** The amber "waiting for input" state is exactly the signal worth pushing. An `ntfy` or Telegram POST when a session crosses the idle threshold would mean not having to check at all. Small addition once §5.2 exists. Note that this is the same need as a pipeline's "tell me where it got stuck" — one mechanism should serve both.

- **Reading a session's output without attaching to it.** Today the scrollback buffer is reachable only by opening the WebSocket, and that upgrade is claim-gated (§6). So a program that wants to know *what an agent actually did* must either take the claim — evicting whoever is at a browser — or not look. Both pipelines below need to look.

  The shape that fits: `GET /sessions/:id/scrollback` returning the ring buffer's current bytes as `application/octet-stream`. Authenticated, and **not** claim-gated, for exactly the reason `POST /sessions` is not (§4.3): a non-browser caller must be able to observe a session without evicting a human from it. It reads in-memory state and writes nothing, so it does not touch the no-persistence rule.

  Do not build it until a caller exists.

- **Programs built on Switchboard.** Two are planned. Both live outside this repo and talk to it over the HTTP API. Neither adds anything to the daemon.

  - **The review loop.** An agent does work and opens a PR; a *different* model reviews it; Thomas accepts or rejects; a rejection opens a fresh session seeded with the review notes and his own. See `LATER-review-loop.md`.
  - **The application pipeline.** Scrape job postings, spawn an agent to tailor a résumé to each posting, automate as much of the application as it can, report back where it got stuck, and keep a durable record of every posting, artefact and outcome so it can be pulled back later.

  The second one needs real storage, and that storage belongs to the pipeline. §2's "no database" keeps *this* codebase small and the fleet portable; it is not a claim that the work these programs do is unworthy of a database. Resist the pull to put it here — a daemon that knows about job applications is no longer transport and dispatch.

  What Switchboard owes both, and must not regress:

  - `POST /sessions` stays authenticated but **claim-free**, so a pipeline can spawn a session without evicting a browser (§4.3).
  - Exited sessions stay in the map with their exit code until something removes them, so a caller can poll `GET /sessions` for completion. **Do not add auto-reaping.**
  - `label` and `extraArgs` on `POST /sessions`, so many concurrent pipeline sessions are tellable apart in one merged list.

  These three are load-bearing for work that does not exist yet, which makes them exactly the kind of thing a later tidy-up deletes. They are recorded here so that does not happen.

---

## 10. Reference

`codeg` (github.com/xintaofei/codeg) solves the single-host version of this and its client/server split is the same shape: mobile clients point at one server with a URL and a token, and files, agent CLIs, and conversations all stay on the host. It is a reasonable UI reference. Do not fork it — the repo is large, fast-moving, and a Tauri app, and a thin client against a small purpose-built daemon will age far better than a deep fork.
