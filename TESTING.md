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
| Ring buffer, claim state machine, orphan ledger incl. PID-reuse guard | `npm test` — 41 cases |
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

**First real Windows run happened on `desktop-icu1edp` (Windows 10).** Spawn, the
`.cmd` shim path, `PATHEXT` probing, drive-letter paths and `processStartTime` all
pass. It found two further bugs, both since fixed but **neither yet re-verified on
Windows**: no terminal output reached clients at all, and `DELETE` answered 204
without killing anything. Both are the reason to re-run this section rather than
trust it.

[`WINDOWS-SETUP.md`](./WINDOWS-SETUP.md) is the self-contained bring-up guide for the
machine itself — prerequisites, `host.json`, `tailscale serve`, and this list with the
known traps attached. Hand it to a session running on that machine.

- [x] **`npm install` installs `node-pty`.** Verified on Windows 10: 1.1.0 ships
      prebuilt Windows binaries and never invoked node-gyp, so VS Build Tools and
      Python are **not** prerequisites.
- [ ] **Daemon starts.** `npm run dev:host`, then `curl http://localhost:7777/health`.
      Should list agents and not crash when some are missing.
- [ ] **Availability probe finds `.cmd` shims.** An npm-installed `claude` is
      `claude.cmd`, resolved via `PATHEXT`. `/health` should say `available: true`.
- [ ] **Spawning a `.cmd` agent — the likely blocker.** `CreateProcess` cannot execute
      batch files and node-pty passes the path straight to it, so `.cmd`/`.bat` are
      launched through `cmd.exe /c`.
      *If it fails with "Unable to start terminal process: CreateProcess failed",*
      look at the `win32` branch in `packages/host/src/sessions.ts#create`.
      Claude Code's **native Windows installer** gives a real `claude.exe` and skips
      this path entirely — prefer it if this fights back.
- [ ] **Killing a session actually kills it.** `DELETE /sessions/:id`, then confirm in
      Task Manager. node-pty *throws* on Windows if given a signal, so the daemon
      calls bare `kill()` there; if that regresses, every kill silently does nothing.
- [ ] **Ctrl-C reaches the agent** through the `cmd.exe` layer — use the quick-send
      button and confirm the agent interrupts rather than `cmd.exe` swallowing it.
- [ ] **Orphan recovery.** End the daemon from Task Manager (*not* Ctrl-C), restart,
      confirm it reports survivors, then *Kill all* and confirm they are really gone.
      **Hard to stage on Windows, and the reason is interesting:** killing the daemon
      closes its ConPTY handles and the console teardown takes the agents with it, so
      survivors mostly do not happen — the opposite of Linux, and the opposite of what
      this file previously assumed. Note the tension with the kill bug below: console
      teardown on daemon exit reaches the tree, an explicit `pty.kill()` does not.
      Not yet explained; worth understanding before trusting either.
- [ ] **`processStartTime` is populated.** `%USERPROFILE%\.switchboard\sessions.json`
      should hold `win32:<ticks>` per entry. Missing means the PowerShell `StartTime`
      probe failed, and orphan killing will refuse to act — safe, but cleanup never
      works.
- [ ] **Drive-letter paths.** Start a session in `C:\dev\somerepo`, and confirm
      `workspaceRoots` with backslashes populates the directory picker.
- [ ] **`pathPrepend` if needed.** If agents were installed under a different Node
      version, add that `bin` directory to `host.json`'s `pathPrepend` — never an
      absolute path in `agents.json`, which is synced fleet-wide.

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

- [ ] **Installs to the home screen** from the HTTPS origin and launches standalone.
- [ ] **The couch test** (spec §1, the one-line test of success): from the phone,
      see that a Claude Code session on the Windows desktop is blocked on a permission
      prompt, tap it, answer with the quick-send buttons, and watch it continue —
      without SSH and without touching the desktop.

That last one is the whole point of the project. Everything else is scaffolding for it.

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
