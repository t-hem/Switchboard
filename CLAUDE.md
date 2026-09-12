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

## Conventions

- TypeScript strict. No `any` outside narrow, commented interop points.
- ESM throughout; host imports use explicit `.js` extensions (`moduleResolution: nodenext`).
- Tests only where there is real logic to pin — the scrollback ring buffer and the
  claim state machine — using `node:test`. No UI tests.
- Log to stdout with `console.log`. No log files, no logging library.
- Windows paths are first-class: never assume `/` separators or a POSIX shell.
- Keep the whole implementation under roughly 3,000 lines. If a phase blows past that,
  stop and flag it rather than continuing.
