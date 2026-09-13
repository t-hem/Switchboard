# Switchboard — notes for agents working on this repo

`switchboard-spec.md` is the authoritative specification. Read it before changing
anything. Its §2 "Non-goals" list is binding: do not add those features, do not add
hooks or TODOs for them.

Build in the phases in §7, one at a time. After each phase: verify the acceptance
criteria, then commit and push to `master` so the phase is reviewable as a diff.

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

Shutdown must *await* termination. Exiting as soon as the signals are sent skips the
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

### Windows is untested, and node-pty behaves differently there

Two bugs have already been found by reading node-pty's source rather than running it.
Both are the same shape: an API that is correct on POSIX and wrong on Windows.

- `IPty.kill(signal)` **throws** on Windows ("Signals not supported on windows").
  Passing a signal there means the kill never happens. Its bare `kill()` terminates
  every process attached to the ConPTY console, i.e. the whole tree.
- `pty.spawn(file)` goes straight to `CreateProcess`, which **cannot execute `.cmd`
  or `.bat`**. npm-installed CLIs on Windows are `.cmd` shims, so they are run
  through `cmd.exe /c`.

Before changing anything in the spawn or kill path, check what node-pty actually does
on both platforms — `node_modules/node-pty/src/` is readable and worth reading.
See the Windows checklist in README.md for what has yet to be verified on real hardware.

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
- Tests only where there is real logic to pin — the scrollback ring buffer and the
  claim state machine — using `node:test`. No UI tests.
- Log to stdout with `console.log`. No log files, no logging library.
- Windows paths are first-class: never assume `/` separators or a POSIX shell.
