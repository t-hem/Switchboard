# What still needs testing

The automated suites drive real daemons, real PTYs and a real browser, and they run
on Linux. Beyond them, as of 2026-09-15: the Linux daemon runs under systemd and
serves the fleet, the phone and desktop clients have both been used by hand and the
faults that found are fixed, and the Windows daemon has had two real runs. What has
*not* happened is a full multi-machine fleet under load, and the Windows box is out
of action with unrelated hardware faults.

This file is the handoff: what is proven, what is not, and exactly how to check the
rest. Work top to bottom — it is ordered so the most likely blocker comes first.

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
| PWA assets, service worker, phone layout, quick-key byte sequences, Ctrl-C, jump-to-latest, the drag scrollbar | `packages/web/acceptance/mobile.mjs` |

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

**Blocked as of 2026-09-15:** every item here needs a second real machine, and
`desktop-icu1edp` is throwing DPC watchdog errors. That box has to be healthy again
before any of this, and before the remaining two Windows items in §1.

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

## 3. `tailscale serve`

**Running on `tom-ai-machine` (Linux) since the first phone run, 2026-09-15.** The
phone reaches the client and the daemon over it, so the setup in the README is
confirmed on one machine. What is still open is the other machines' daemons.

- [x] **Each daemon is served over HTTPS**, not just the client:
      `tailscale serve --bg --https=8443 7777`. Verified on the Linux box;
      `tailscale serve status` shows `:8443 -> proxy http://127.0.0.1:7777`.
- [x] **The client is served** from one machine:
      `tailscale serve --bg --https=443 /abs/path/to/packages/web/dist`.
- [x] **Mixed content is the trap.** A page loaded over `https://` cannot fetch
      `http://` or open `ws://` — browsers block it with no useful error. Serving the
      client over TLS while leaving daemons on plain `http://…:7777` produces an app
      where *every host silently shows as offline*. Not hit, because the daemon is
      proxied on `:8443` rather than addressed directly. It remains the first thing to
      suspect if a host shows offline for no reason.
- [x] `tailscale serve status` shows what is exposed; `tailscale serve reset` undoes it.
      Nothing is on `funnel` — both entries read `(tailnet only)`.
- [ ] **The same, on the other machines' daemons.** Only the Linux daemon is served;
      a second host in the fleet needs its own `--https=8443` proxy before the phone
      can reach it.

Note that the client is served from `packages/web/dist`, so `npm run build -w
@switchboard/web` publishes to the live URL immediately. There is no separate deploy
step, and no staging copy.

---

## 4. The phone

**First real handset run, 2026-09-15.** A live Claude Code session, driven from the
phone, found three bugs that the emulated viewport in `mobile.mjs` could not. Both of
those fixes are now re-verified on the handset. The third — scrolling — has a fix
since **2026-09-15** that no handset has touched.

- **Send composed the line but never submitted it.** `MobileInputBar` sent
  `` `${line}\r` `` as one frame, so it reached the pty as a single read. A TUI that
  reads stdin in bursts treats a multi-character read as *pasted* text and inserts the
  CR as a newline rather than submitting — the line landed in Claude Code's composer
  and sat there until a separate Enter was tapped.

  **The first fix was racy and came back.** Sending the Enter on a fixed 20ms timer
  survived a whole handset session and then failed again the same day: the two writes
  only land in separate reads if the agent is scheduled in between, and a busy agent
  — mid-render, mid-turn — takes both out of the pty buffer at once. No delay can fix
  that, only make it rarer. `sendLine` in `useTerminal.ts` now waits for *evidence*
  instead: the agent producing output is proof it read the line, since that output is
  its redraw. A 40ms floor stops output already in flight from counting, and a 250ms
  cap covers an agent that redraws nothing. `mobile.mjs` asserts the two frames and
  the gap by wrapping `WebSocket.prototype.send`, so the client half is pinned from
  Linux — but whether it holds against a *busy* Claude Code is a handset question.
- **A multi-select prompt was a dead end.** The quick-key row had `↑` and `⏎` but no
  `↓`, no Space and no Tab. Space is what toggles a checkbox, so the options could not
  be changed at all — the prompt could only be escaped. All three keys are now in the
  row, and `mobile.mjs` asserts they are present.

**Scrolling had no momentum. Three changes fixed it, confirmed on the handset on
2026-09-15 — "infinitely better".** A drag moved the scrollback one-to-one and stopped
dead — no fling, no acceleration — and scrolled up while output streamed there was no
practical way back to the live view.

The cause is in xterm, confirmed by reading `node_modules/@xterm/xterm/lib/xterm.js`
(5.5.0). `Viewport.handleTouchMove` sets `scrollTop += delta` by hand, and the
`touchmove` listener is registered `{passive: false}` and calls `preventDefault()`
whenever that handler does not bubble — which is everywhere except the very top and
bottom of the buffer. So the browser's own touch scrolling, momentum included, is
replaced by a 1:1 drag. There is no xterm option to turn this off.

An earlier note here said stopping touch events at `.xterm-viewport` would be enough.
**It is not, and on its own it does nothing:** xterm appends `.xterm-screen` *after*
the viewport and gives it `position: relative`, so the screen paints on top and is
what a finger actually lands on. Its scroll chain does not include the viewport, so a
native scroll never starts. What shipped instead:

- `.xterm-screen` is `pointer-events: none` under `@media (pointer: coarse)`, so a
  touch reaches the viewport — the element that actually scrolls. The cost is touch
  selection on the terminal, which does not work on a phone anyway.
- `useTerminal.ts` stops `touchstart`/`touchmove` at the viewport, so they never reach
  xterm's listener on the `.xterm` root and are never preventDefault()ed. The viewport
  also registers a plain `scroll` listener (`Viewport._handleScroll`) that syncs the
  buffer from `scrollTop`, so native scrolling already drives xterm correctly.
- `TerminalScrollbar.tsx` draws a 44px-minimum drag thumb over the terminal, as the
  fallback if momentum still does not hold. The viewport's own scrollbar could not be
  widened for this: phones use overlay scrollbars, which ignore `::-webkit-scrollbar`
  — measured at **0px** of layout width under mobile emulation, which is why that
  approach was dropped.

A **↓ Latest** button appears whenever the viewport is scrolled off the bottom and
withdraws once it is back. `mobile.mjs` asserts the button's appear/tap/withdraw cycle,
that the thumb is grabbable and that dragging it scrolls.

One further finding is **not** treated as a bug: typing directly into the terminal on a
phone produces jumbled input. The soft keyboard drives xterm's hidden textarea through
IME composition, and autocorrect rewrites characters already sent to the pty. The input
bar exists because that path does not work. If it is ever worth addressing, the fix is
to focus the input bar when the terminal is tapped, not to repair raw typing.

- [ ] **Send submits in one tap — regressed, re-fixed, unverified.** The 20ms-timer
      version survived a whole session on 2026-09-15 and then pasted instead of
      submitting, which is what exposed it as a race rather than a fix. The
      output-driven version that replaced it has not been near a handset. Use it
      hard, especially while the agent is mid-turn and busy — that is the case that
      broke the old one.
- [x] **Answer a multi-select prompt using the quick keys alone — re-verified on the
      handset, 2026-09-15.** A four-option checkbox prompt from Claude Code itself was
      answered from the phone with several options ticked, which takes `↓` to move and
      Space to toggle. The dead end the first run hit is gone.
- [x] **Scrolling — fixed and confirmed on the handset, 2026-09-15.** The fling
      carries instead of stopping dead. Handing touch scrolling back to the browser
      works; the 1:1 drag is gone.
- [ ] **↓ Latest.** Scroll up while output is streaming and confirm the button appears
      and returns you to the live view in one tap. Not separately reported on yet.
- [ ] **The drag thumb.** Confirm it is visible whenever there is scrollback, that a
      thumb can actually grab it, and — now that momentum works and it is no longer
      needed as the primary way to scroll — whether it is intrusive enough over the
      terminal's right-hand column to be worth fading in on first touch instead.
- [ ] **Installs to the home screen** from the HTTPS origin and launches standalone.
- [ ] **The couch test** (spec §1, the one-line test of success): from the phone,
      see that a Claude Code session on the Windows desktop is blocked on a permission
      prompt, tap it, answer with the quick-send buttons, and watch it continue —
      without SSH and without touching the desktop.

      *Half-done, 2026-09-15.* A full working session — this checklist's own edits
      among them — was driven from the phone against the **Linux** daemon over
      `tailscale serve`, including answering prompts with the quick keys. What that
      does not cover is the cross-machine half, which is the actual point. The Windows
      box is throwing DPC watchdog errors and needs troubleshooting before it can host
      the other end.

That last one is the whole point of the project. Everything else is scaffolding for it.

---

## 5. The desktop browser — never opened by hand

`ui.mjs` drives the desktop layout in headless Chromium and passes, but no human has
used it. The phone is fine with the input bar standing between the keyboard and the
pty; the desktop has no such buffer, so anything wrong with focus or pointer handling
lands directly on the primary way the client is meant to be used.

- [x] **Click the terminal and type — verified 2026-09-15.** Typed at full speed
      (~100 wpm) against streaming output with no duplication, dropped characters or
      jumbling. The phone's IME finding does not have a hardware-keyboard equivalent.
- [x] **Selection and copy/paste — verified 2026-09-15.** Drag-select works, Ctrl-C
      copies when there is a selection and interrupts when there is not, Ctrl-V
      pastes. All three needed `attachCustomKeyEventHandler`; xterm sends every Ctrl
      chord to the pty as a control byte by default, so none of them worked before.
- [ ] **Clicking works in general** — selecting a session in the list, the
      new-session modal, the kill button. **Click-to-focus on the terminal does not
      focus it**, and that is left alone deliberately: it matches the behaviour of the
      terminal this is being compared against, and a focus-follows-click change would
      be a change for its own sake. Revisit only if it actually gets in the way.
- [x] **The drag thumb and ↓ Latest at desktop width — verified 2026-09-15.** The
      thumb is always present and scrolls the buffer; ↓ Latest appears whenever the
      view is not at the bottom. Note it keys off "not at the bottom" rather than off
      scrolling past a threshold, which is indistinguishable in use. Both were
      previously phone-only, and with a dead scroll wheel there was no way to move
      through the buffer on the desktop at all.
- [x] **Killing and deleting, with confirmation — verified 2026-09-15.** `✕` →
      *Really kill?* on a running session, and Ctrl-C twice to exit followed by
      *Delete* → *Really delete?* on the exited row. Both arm on the first click and
      act on the second.
- [ ] **The sidebar collapse** (`☰`, desktop only) works, but see the known defect
      below — resizing the terminal is what exposes it. Not covered by `ui.mjs`.

---

## Known defects — recorded, not being worked on

Real, reproduced, and judged not worth more time than they have already had. Written
down so they are not rediscovered from scratch, and so nobody re-runs the eliminations.

### Resize flashes, and wrapped text bounces · low priority

Resizing the terminal — collapsing or expanding the sidebar is the usual way —
sometimes flashes, and wrapped lines visibly bounce and briefly gain an extra line
break before settling.

**Only happens when something on screen is wrapped.** Widen the window until nothing
wraps and both the flash and the bounce go away entirely. That is the strongest clue
about where it lives.

Three causes were found and fixed, and none of them was this one:

- `FitAddon.fit()` calls `_renderService.clear()` before any resize that changes the
  geometry, blanking the screen first. Replaced with `proposeDimensions()` plus
  `terminal.resize()`, which is the same work without the clear (`8b1c014`).
- A second fit was running against a mid-layout box, producing one wrong result and
  then a correct one — two flashes, and the spread-apart rows in between. The fit now
  runs on a laid-out frame and is skipped when the box has not moved (`51fefa3`).
- Nothing re-pinned the view after a rewrap, so a terminal pinned to the newest output
  was left sitting above it. Now re-pinned in the same turn as the resize (`1f10d88`).

What remains is xterm rewrapping the buffer and painting an intermediate state, which
is not something this client drives. The remaining levers are all worse than the
defect: shrink the scrollback, swap in the canvas or WebGL renderer addon, or cover
the terminal during a resize. Leave it unless it starts costing something real.

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
