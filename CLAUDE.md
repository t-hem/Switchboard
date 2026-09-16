# Switchboard — notes for agents working on this repo

**Before doing anything on a new machine, read [TESTING.md](./TESTING.md).** All
phases are built. Linux is exercised by the suites. Windows has had two real runs: the
first found two bugs, the second confirmed those fixes and found a third, since fixed
but not re-verified. The phone has had one run, which found two of its own — fixed, not
re-verified. The real fleet, `tailscale serve` and the desktop browser have never been
exercised at all. That file is the ordered checklist, and
[WINDOWS-SETUP.md](./WINDOWS-SETUP.md) is the bring-up guide for a Windows box.

`switchboard-spec.md` is the authoritative specification. Read it before changing
anything.

Its §2 "Non-goals" list is binding **for the daemon and the web client**: do not add
those features here, no hooks, no TODOs. It is not a list of things that may never
exist — several are planned as separate programs that call this one's HTTP API, and §9
specifies them. When a need runs into a non-goal, the answer is a program calling the
API, never a feature in the daemon.

§9 also records three small things that are load-bearing for work that does not exist
yet — `POST /sessions` being claim-free, exited sessions not being auto-reaped, and
`label`/`extraArgs` on spawn. They look like oversights and are not. Do not tidy them
away.

Build in the phases in §7, one at a time. After each phase: verify the acceptance
criteria, then commit and push to `master` so the phase is reviewable as a diff.

## Approved next implementation

`JOB-APPLICATION-PLAN.md` is approved (2026-09-16). Start with Linux tmux
session recovery, retaining Windows shutdown behavior. Verify and commit each stage
before continuing; the operator authorized continued work without phase-review pauses.
Jobs and the later review loop are separate same-repository apps calling HTTP APIs;
Switchboard never imports their runtime dependencies or databases. These are narrow
revisions to the older spec's outside-repository and restart-kills-all assumptions.

## Invariants

### `agents.json` is fleet-wide and must stay portable

`agents.json` is synced verbatim between machines (spec §5.5, last-write-wins on
`updatedAt`). Anything machine-specific written into it will be propagated to every
other machine, where it is wrong.

```jsonc
// GOOD — a bare command, resolved against PATH on each machine
{ "claude": { "cmd": "claude" } }

// BAD — an absolute path from one machine, synced to all of them
{ "claude": { "cmd": "/home/thomas/.nvm/versions/node/v20.20.2/bin/claude" } }
```

Per-platform differences that are genuinely about the *platform* (not the machine)
belong in the `platform` override block — `{ "cmd": "pi", "platform": { "win32": { "cmd": "pi.cmd" } } }`.

### `host.json` owns everything machine-local

Port, token, label, workspace roots, and — the point above — **PATH resolution**:
`pathPrepend` and `env` in `host.json` are how a given machine is taught where its
agent binaries live. `src/env.ts#agentEnv` builds that environment once; it is used
both for the availability probe and for spawning PTYs, so the two can never disagree.

Concretely: agent CLIs installed via npm live under the active Node version's global
bin, so a daemon on Node 22 cannot see CLIs installed under Node 20. The fix is a
`pathPrepend` entry in that machine's `host.json` — never an absolute `cmd` in
`agents.json`.

The token in `host.json` must never be transmitted to another host or appear in any
sync payload.

### Availability is per-machine and is never synced

An agent that is configured but not installed is a normal state. Report it as
unavailable, surface its display-only `install` string, and never execute that string.

### Killing a PTY: always name the signal

`node-pty`'s `IPty.kill()` defaults to **SIGHUP**, not SIGTERM. A process that
deliberately survives a closing terminal will ignore it, and the daemon will then
report a session dead while the process keeps running. Always pass the signal
explicitly: SIGTERM, then SIGKILL after the grace period.

Direct-backend shutdown must *await* termination. Linux opt-in tmux shutdown instead
releases attachments and retains independently owned workloads; explicit deletion still
requires verified termination (see LINUX-SESSIONS.md). Exiting as soon as the signals are sent skips the
escalation and strands exactly the processes the shutdown was meant to clean up —
with their ledger entries already removed, so nothing even records them.

### The orphan ledger never kills anything on its own

`sessions.json` exists so a crashed daemon does not leave agent processes that are
tedious to hunt down. Two rules:

1. **Verify before signalling.** PIDs are recycled. Every entry records the process
   creation time at spawn, and it must match exactly before anything is killed. An
   entry that cannot be verified is dropped, never killed.
2. **Surface, do not act.** Survivors are reported to the operator, who decides.
   Nothing is killed automatically at startup.

Ledger entries are removed when a process *actually exits*, not when a kill is
requested — so something that refuses to die stays on record as an orphan.

### node-pty behaves differently on Windows, and the seam for that is `src/platform/`

Four bugs so far, all the same shape: an API correct on POSIX and wrong on Windows.
Two were found by reading node-pty's source, two by the first real Windows run.

- `IPty.kill(signal)` **throws** on Windows ("Signals not supported on windows"), so a
  signal must never be passed there. Its bare `kill()` is also not sufficient: it kills
  the pids ConPTY reports attached to the console, in a promise it never awaits, and
  the `cmd.exe -> node.exe -> agent.exe` tree outlives it. The tree goes down with
  `taskkill /T`.
- `pty.spawn(file)` goes straight to `CreateProcess`, which **cannot execute `.cmd` or
  `.bat`**. npm-installed CLIs on Windows are `.cmd` shims, so they run through
  `cmd.exe /c`.
- **`encoding: null` is ignored on Windows.** The ConPTY agent calls
  `setEncoding("utf8")` on the conout socket unconditionally, so `onData` delivers
  strings, not Buffers. Assuming otherwise threw in the ring buffer on the first chunk
  and the daemon streamed nothing while looking healthy.
- Consequently, **byte fidelity is POSIX-only.** Invalid UTF-8 is replaced with U+FFFD
  inside node-pty before we see it. The ring buffer's "preserves arbitrary binary
  bytes" guarantee cannot hold on Windows.

Process lifecycle — spawn argv, killing a live pty, killing by pid, process identity —
lives behind `ProcessOps` in `src/platform/`, one implementation per platform, chosen
once at load. Put Windows quirks there, not in an inline `process.platform` branch, and
keep *value* differences (path separator, `PATHEXT`, default workspace roots) where
they are used. Both objects are plain values and `SessionLedger` takes a `ProcessOps`,
so `test/platform.test.ts` and `test/escalation.test.ts` exercise the Windows paths
from Linux — add a case there for anything new rather than relying on the Windows box
to catch it.

Before changing the spawn or kill path, check what node-pty actually does on both
platforms; `node_modules/node-pty/lib/` is readable and worth reading. See TESTING.md
for what is still unverified on real hardware.

### Reporting a kill as successful requires observing the death

`killOrphan` signals, then polls `identityMatches` until the process is gone, and only
then reports `killed` and drops the ledger entry. An earlier version signalled and
assumed success, which meant pressing *Kill all* on an agent that traps SIGTERM
deleted its ledger entry while it kept running — creating exactly the untracked stray
the ledger exists to prevent. If a kill cannot be confirmed, report `failed` and
**keep the entry**.

## Conventions

- TypeScript strict. No `any` outside narrow, commented interop points.
- ESM throughout; host imports use explicit `.js` extensions (`moduleResolution: nodenext`).
- Tests only where there is real logic to pin, using `node:test`. No UI tests. Today
  that is the ring buffer, the claim state machine, the ledger's PID-reuse guard, the
  per-platform process ops, and the kill escalation. The last two are written against
  plain objects and fake `ProcessOps` precisely so the Windows paths are exercised from
  Linux — see the platform note below.
- Log to stdout with `console.log`. No log files, no logging library.
- Windows paths are first-class: never assume `/` separators or a POSIX shell.
