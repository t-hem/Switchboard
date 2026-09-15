# What still needs testing

Everything built so far was verified on **Linux only**, by automated suites that
drive real daemons, real PTYs and a real browser. This file is the handoff: what is
already proven, what is not, and exactly how to check the rest.

Work top to bottom — it is ordered so the most likely blocker comes first.

---

## Already verified (don't redo by hand)

Re-runnable at any time; see [Re-running the suites](#re-running-the-suites).

| Area | Covered by |
|---|---|
| Ring buffer, claim state machine, orphan ledger incl. PID-reuse guard, kill escalation against fakes, both platforms' `ProcessOps` | `npm test` — 64 cases (one skipped on Windows) |
| Spawn, input/output, resize, scrollback replay across a disconnect, exit codes, delete | `packages/host/acceptance/sessions.mjs` |
| Daemon crash → orphan reconciliation → verified kill; clean shutdown leaves nothing | `packages/host/acceptance/orphans.mjs` |
| A real Claude Code session, asserted on the rendered screen | `packages/host/acceptance/real-agent.mjs` |
| Setup screen, session list, new-session modal, terminal, resize, kill | `packages/web/acceptance/ui.mjs` |
| Three daemons, one killed mid-run, offline isolation, reorder, remove | `packages/web/acceptance/multi-host.mjs` |
| `/config/agents` contract, drift → diff → sync, install hints, availability flip | `packages/web/acceptance/agent-sync.mjs` |
| Takeover, 403 for a non-claimant, lockout banner, take-back | `packages/web/acceptance/claim.mjs` |
| PWA assets, service worker, phone layout, quick-key byte sequences, Ctrl-C | `packages/web/acceptance/mobile.mjs` |

---

## 1. Windows daemon — highest risk

**Second Windows run on `desktop-icu1edp` (Windows 10) re-verified the fixes.** The two
bugs the first run found — no terminal output reaching clients, and `DELETE` answering
204 without killing anything — are confirmed fixed against real hardware: a `codex`
session streamed 1451 bytes as binary frames with no `TypeError` in the log, and
`DELETE` took down the whole three-process `cmd.exe` → `node.exe` → `codex.exe` tree,
leaving the ledger empty.

That run found a third bug of the same shape, since fixed: a refused graceful
`taskkill /T` propagated out of `killByPid`, and because `killOrphan` treats a throw
from the soft kill as terminal, every non-forced orphan kill reported `failed` without
ever escalating. Only `force: true` worked. Windows console processes — which every
agent is — can only be terminated with `/F`, so that refusal is the normal case, not an
error.

Everything below is ticked from that run unless noted. Two items remain genuinely
unverified: Ctrl-C through the `cmd.exe` layer, and orphan recovery by the
Task-Manager route.

[`WINDOWS-SETUP.md`](./WINDOWS-SETUP.md) is the self-contained bring-up guide for the
machine itself — prerequisites, `host.json`, `tailscale serve`, and this list with the
known traps attached. Hand it to a session running on that machine.

- [x] **`npm install` installs `node-pty`.** Verified on Windows 10: 1.1.0 ships
      prebuilt Windows binaries and never invoked node-gyp, so VS Build Tools and
      Python are **not** prerequisites.
- [x] **Daemon starts.** Reports `TOM-DESKTOP (win32)`, lists all four agents and does
      not crash on the two that are missing.
- [x] **Availability probe finds `.cmd` shims.** npm-installed `claude.cmd` and
      `codex.cmd` both resolve via `PATHEXT` and report `available: true` — and flip
      from unavailable **without a daemon restart**, as documented.
- [x] **Spawning a `.cmd` agent — the likely blocker.** `codex.cmd` launches through
      `cmd.exe /c` and produces the expected three-deep process tree.
      *If it regresses with "Unable to start terminal process: CreateProcess failed",*
      look at `spawnCommand` in `packages/host/src/platform/win32.ts`.
      Claude Code's **native Windows installer** gives a real `claude.exe` and skips
      this path entirely — so test with npm-installed `codex`, which does not.
- [x] **Terminal output actually reaches a client.** The regression that made the daemon
      look healthy and stream nothing. Attach a WebSocket and assert **binary** frames
      arrive: `encoding: null` is ignored on Windows, so a string reaching
      `RingBuffer.append` throws before any subscriber runs. `src/ptybytes.ts` normalises
      it.
- [x] **Killing a session actually kills it.** `DELETE /sessions/:id` took the whole
      tree down, confirmed by pid. A bare `pty.kill()` is not enough — the `cmd.exe`
      layer outlives it — so the tree goes down with `taskkill /T`.
- [ ] **Ctrl-C reaches the agent** through the `cmd.exe` layer — use the quick-send
      button and confirm the agent interrupts rather than `cmd.exe` swallowing it.
- [x] **Orphan recovery — verified by hand-staging, not by crashing the daemon.** A
      detached process plus a matching `sessions.json` entry is reported as a survivor
      on startup, nothing is killed automatically, `GET /orphans` lists it, and
      `POST /orphans/kill` with `force: false` escalates and kills it (`[ledger] pid …
      ignored SIGTERM; escalating`). The **Task-Manager route is still unverified**, and
      may be unstageable: killing the daemon closes its ConPTY handles and the console
      teardown takes the agents with it, so survivors mostly do not happen — the
      opposite of Linux.
      The tension with the kill bug is still not fully explained, but there is now a
      clue: after `taskkill` tears the console down, `pty.kill()` spawns node-pty's
      `conpty_console_list_agent`, which fails with `AttachConsole failed`. If
      `pty.kill()` depends on enumerating the console to find pids, that is consistent
      with console teardown reaching the tree while an explicit `pty.kill()` does not.
      Worth confirming in node-pty's source before relying on it.
- [x] **`processStartTime` is populated.** Entries hold `win32:<ticks>` — e.g.
      `win32:639250192389941815`. The PowerShell `StartTime` probe works here.
- [x] **Drive-letter paths.** `workspaceRoots: ["C:\\Apps"]` populates the picker with
      `C:\Apps\Switchboard`, and sessions start in it.
- [x] **`pathPrepend` was not needed.** npm's global prefix on this machine already sits
      on `PATH`, so the probe finds the agents with an empty `pathPrepend`. Still the
      right fix if a future machine disagrees — never an absolute path in `agents.json`,
      which is synced fleet-wide.

---

## 2. The real fleet

The three-host behaviour was proven with three daemons on one Linux box. What that
*cannot* cover:

- [ ] **A mixed-platform fleet.** Windows + Windows + Linux in one merged list.
- [ ] **A genuinely powered-off machine.** This is a different code path from the
      simulated `SIGKILL`: a dead daemon refuses the connection instantly, while an
      *off machine* makes requests hang until the client's 3s timeout. Confirm the
      host flips to "offline · last seen …" within a few seconds and the other two
      stay fully usable.
- [ ] **The real install-hint case.** Add an agent on the Linux box, sync, and confirm
      it appears greyed out on both Windows machines with a copyable install command.
      Then install the CLI on one and confirm it flips to available with **no daemon
      restart** (availability re-probes lazily, 10s TTL).
- [ ] **Cross-machine takeover.** Attach from the desktop, then open the phone; the
      desktop should show the takeover banner within a second or two, and *Take back*
      should reverse it, with the session still running either way.

---

## 3. `tailscale serve` — documented, never run

Setup instructions are in the README. Untested on your tailnet.

- [ ] **Each daemon is served over HTTPS**, not just the client:
      `tailscale serve --bg --https=8443 7777`
- [ ] **The client is served** from one machine:
      `tailscale serve --bg --https=443 /abs/path/to/packages/web/dist`
- [ ] **Mixed content is the trap.** A page loaded over `https://` cannot fetch
      `http://` or open `ws://` — browsers block it with no useful error. Serving the
      client over TLS while leaving daemons on plain `http://…:7777` produces an app
      where *every host silently shows as offline*. If that is what you see, this is
      why.
- [ ] `tailscale serve status` shows what is exposed; `tailscale serve reset` undoes it.
      Nothing should be on `funnel` — this is tailnet-only.

---

## 4. The phone

**First real handset run, 2026-09-15.** A live Claude Code session, driven from the
phone, found two bugs that the emulated viewport in `mobile.mjs` could not — both since
fixed, neither re-verified on the handset yet.

- **Send composed the line but never submitted it.** `MobileInputBar` sent
  `` `${line}\r` `` as one frame, so it reached the pty as a single read. A TUI that
  reads stdin in bursts treats a multi-character read as *pasted* text and inserts the
  CR as a newline rather than submitting — the line landed in Claude Code's composer
  and sat there until a separate Enter was tapped. The line and its return now go as
  two writes a frame apart.
- **A multi-select prompt was a dead end.** The quick-key row had `↑` and `⏎` but no
  `↓`, no Space and no Tab. Space is what toggles a checkbox, so the options could not
  be changed at all — the prompt could only be escaped. All three keys are now in the
  row, and `mobile.mjs` asserts they are present.

A third finding is **not** treated as a bug: typing directly into the terminal on a
phone produces jumbled input. The soft keyboard drives xterm's hidden textarea through
IME composition, and autocorrect rewrites characters already sent to the pty. The input
bar exists because that path does not work. If it is ever worth addressing, the fix is
to focus the input bar when the terminal is tapped, not to repair raw typing.

- [ ] **Re-verify both fixes on the handset** — compose a line, tap Send once, and see
      it submit; then answer a multi-select prompt using the quick keys alone.
- [ ] **Installs to the home screen** from the HTTPS origin and launches standalone.
- [ ] **The couch test** (spec §1, the one-line test of success): from the phone,
      see that a Claude Code session on the Windows desktop is blocked on a permission
      prompt, tap it, answer with the quick-send buttons, and watch it continue —
      without SSH and without touching the desktop.

That last one is the whole point of the project. Everything else is scaffolding for it.

---

## 5. The desktop browser — never opened by hand

`ui.mjs` drives the desktop layout in headless Chromium and passes, but no human has
used it. The phone is fine with the input bar standing between the keyboard and the
pty; the desktop has no such buffer, so anything wrong with focus or pointer handling
lands directly on the primary way the client is meant to be used.

- [ ] **Click the terminal and type.** Keystrokes reach the pty in order, with no
      duplication, no dropped characters and no jumbling. This is the desktop
      equivalent of the phone finding above, and the one most likely to hurt: there is
      no input bar to fall back on.
- [ ] **Clicking works in general** — selecting a session in the list, the
      new-session modal, the kill button, and click-to-focus on the terminal itself.
- [ ] **Selection and copy/paste.** Dragging selects, and Ctrl/Cmd-V pastes into the
      pty rather than being swallowed as a keystroke.

---

## Re-running the suites

Node 22 is required and is not the default here:

```bash
nvm use 22
npm test          # unit tests
npm run typecheck
```

The acceptance harnesses need a running daemon and, for the browser ones, a served
client. Each package's `acceptance/README.md` has the exact setup. Two things that
will otherwise waste time:

- **Puppeteer is deliberately not a dependency** (it downloads its own Chromium).
  Install it on demand: `npm install --no-save --no-package-lock puppeteer`
- **Kill test daemons by listening port, not `pkill -f`.** A pattern like
  `pkill -f "tsx src/index.ts"` also matches the shell running it, so it kills itself:

  ```bash
  pid=$(ss -lptnH "sport = :7788" | grep -oP 'pid=\K[0-9]+' | head -1); [ -n "$pid" ] && kill "$pid"
  ```

Use a throwaway `SWITCHBOARD_DIR` for anything automated so it never touches
`~/.switchboard`.
