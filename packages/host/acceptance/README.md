# Acceptance harnesses

The spec verifies the daemon by hand rather than with a test framework (§8). These
scripts automate those manual steps so a phase stays re-checkable later.

They drive a **running daemon** over exactly the HTTP + WebSocket surface the browser
client uses. Unit tests (`npm test`) cover the ring buffer and the ledger's
PID-reuse guard; these cover everything else.

| Script | Covers | Needs |
|---|---|---|
| `sessions.mjs` | Phase 1: auth, validation, spawn, input/output, resize, scrollback replay across a disconnect, multiple clients, exit codes, delete | a `bash` agent |
| `orphans.mjs` | Daemon crash → orphan reconciliation → verified kill, and that a clean shutdown leaves nothing behind | a `bash` and a `survivor` agent |
| `real-agent.mjs` | The spec's literal Phase 1 acceptance against a real Claude Code session, asserting on the *rendered screen* via a headless xterm | `claude` installed |

## Running them

`sessions.mjs` and `orphans.mjs` want a throwaway config directory so they never
touch `~/.switchboard`:

```bash
export SWITCHBOARD_DIR=/tmp/switchboard-accept
mkdir -p "$SWITCHBOARD_DIR"
cat > "$SWITCHBOARD_DIR/host.json" <<'JSON'
{ "port": 7788, "token": "test-token", "hostLabel": "accept-test",
  "scrollbackBytes": 65536, "workspaceRoots": ["/home/you"],
  "pathPrepend": [], "env": {} }
JSON
cat > "$SWITCHBOARD_DIR/agents.json" <<'JSON'
{ "updatedAt": 0, "agents": {
  "bash": { "cmd": "bash", "args": ["--norc", "--noprofile", "-i"] },
  "survivor": { "cmd": "bash", "args": ["--norc", "--noprofile", "-c",
    "trap '' HUP; while :; do sleep 1; done"] }
} }
JSON

# sessions.mjs needs the daemon already running; orphans.mjs starts its own.
npm run dev -w @switchboard/host &
TEST_REPO=$PWD node packages/host/acceptance/sessions.mjs
node packages/host/acceptance/orphans.mjs
```

`real-agent.mjs` runs against the **real** `~/.switchboard` config and a daemon
started normally. It only ever sends keystrokes — never Enter — so it makes no model
request.

```bash
npm run dev -w @switchboard/host &
TEST_REPO=$PWD node packages/host/acceptance/real-agent.mjs
```

Set `OUT_DIR` to keep the rendered screen dumps somewhere you can read them.

## Why assertions are made on the rendered screen

A TUI repaints with cursor addressing, so text you type never appears as a
contiguous run of bytes in the stream — and over a few KB of banner text almost any
lowercase string matches as a subsequence by chance. `real-agent.mjs` therefore feeds
the stream to a headless xterm and asserts on the resulting screen, which is both
honest and exactly what the browser will show.
