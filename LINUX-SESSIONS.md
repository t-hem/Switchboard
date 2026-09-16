# Linux persistent sessions

Implementation underway, 2026-09-16. The persistent backend is under acceptance test;
production stays direct until step 1d migration is recorded. Windows stays unchanged.

## Ownership decision

A dedicated tmux 3.2a+ server owns agent PTYs. The host owns only node-pty attachment
clients. Run the tmux server under its own systemd user service/cgroup, with a private
socket and controlled config. No restart/stop dependency connects it to the HTTP service.
Run foreground `tmux -D`, disable exit-empty, keep dead panes for real exit status,
disable prefix keys/status bar and bound history. Production must never auto-create
an owner server inside the HTTP daemon's cgroup; if unavailable, report recovery error.

The isolated `accept:tmux-spike` proved this on systemd/tmux 3.2a: agent PID/start identity
survives attachment SIGTERM and SIGKILL, actual user-service restart and terminal reattach.
Exact argv uses multiple command arguments, not shell concatenation. Per-session
`env -i` avoids stale owner environment and preserves host availability/spawn agreement.

## Display contract

Normal direct PTYs retain their existing raw-byte behavior. tmux attachments stream
rendered terminal output, with Unicode/input/resize/alternate-screen fidelity checked
by the spike. After restart the old daemon byte ring is gone. The new attachment
redraws the current screen; tmux keeps bounded history in memory, but that history is
not automatically the browser's old scrollback. Do not promise byte replay or full
browser history reconstruction. Explicit historical display can be added separately.
No terminal history is written to disk by the host/owner configuration.

## Rollout gates (step 1d)

- Production deployment and a real coding-agent self-restart demonstration.
- Browser reconnect/takeover/resize; phone check when operator hardware is available.
- Fault interruption during spawn/delete/recovery under actual upgrade conditions.
- Verified offline CLI inventory/attachment/cleanup after a failed deployment.

## Backend/registry foundation (step 1b)

`SessionBackend`/`SessionHandle` isolate create/input/resize/termination and transport
ownership. The default remains direct; `ProcessOps` still handles Windows behavior.
`RecoveryRegistry` stores versioned spawn intents/metadata with flushed atomic writes,
exclusive process-identity ownership and preserved corrupt/unknown files. It is not
yet wired to production sessions in this stage. A failed write never publishes new
in-memory state or silently forgets existing records.

Stale lock reclamation uses a per-owner-generation exclusive retirement marker to
prevent two restarting daemons from deleting each other's replacement lock. An
interrupted lock creation/reclamation fails closed: inspect the owner PID/identity and
registry before manually removing the stale lock/retirement marker. No agent is killed
or forgotten in that case. Retired generation markers contain no terminal data.

## Persistent backend (step 1c)

Linux configuration is opt-in in machine-local `host.json`:

```json
{
  "sessionBackend": "tmux",
  "tmux": {
    "socketPath": "/absolute/private/directory/owner.sock",
    "ownerId": "stable-machine-owner-id"
  }
}
```

Keep existing host settings and token. The configured owner ID must match the tmux
server's global `@switchboard-owner`. The socket must belong to the current user and
have no group/other permissions. The backend never starts an owner automatically.
Windows rejects tmux mode and keeps its original direct backend. Direct is still the
default. Switching to direct with persistent registry entries is refused; finish and
explicitly remove those sessions first. Never roll back to a host version that cannot
inventory existing persistent resources.

Each session has a separate transient systemd user scope with a recorded InvocationID.
The workload waits at a file gate until its process/scope identities are durable. Ordinary
forked and `setsid` descendants remain in that scope; TERM then KILL targets only the
verified scope. This is lifecycle containment, not a security boundary against same-user
code deliberately creating other systemd units or moving itself out of its cgroup.

`persistent-sessions.json` contains metadata, not terminal output, prompts or environment
values. Alternate metadata on owned tmux sessions reconstructs missing registry entries.
An incomplete spawn is shown for inspection/termination, never automatically rerun.
Socket/owner loss and failed cleanup remain visible in `/sessions` and the session list.
The process exit status comes from tmux, never the attachment client's status. tmux can
close a PTY before collecting its child's status; reconciliation waits for reaping and
reads a fresh status. tmux 3.2a's observed unreaped-zombie case receives a SIGCHLD nudge
only when the pane's verified parent is the configured server. Signal deaths remain
`null`, not an invented successful result.

The one-second reconciliation currently uses bounded synchronous local commands. This
is intended for a personal host, not a high-session-count service; bus/owner stalls can
delay HTTP responses. Browser reconnect already resets xterm before replay; old browser
scrollback is not reconstructed. Real browser/hardware rollout checks belong to 1d.

## Offline recovery

Run from the repository root using Node 22 after building the host:

```sh
node packages/host/dist/recovery-cli.js list
systemctl --user stop switchboard.service
node packages/host/dist/recovery-cli.js attach SESSION_ID
node packages/host/dist/recovery-cli.js terminate SESSION_ID
systemctl --user start switchboard.service
```

`list` is read-only and works while the host runs, including with malformed registry
JSON. Attach/terminate take exclusive ownership and refuse a live daemon lock. Attach
requires an interactive terminal; exit the local tmux client without killing the pane
by sending TERM to that client from another terminal (prefix keys are disabled).
Terminate confirms workload death before removing its record. If the owner socket is
unavailable, preserve the record and restore the owner/socket before retrying cleanup.

If only the socket was unlinked while the owner still runs, signal the **owner service**
with `systemctl --user kill --kill-who=main --signal=SIGUSR1 OWNER.service`, then restore
private socket permissions. Do not restart the owner to fix a missing socket: restarting
it loses terminal state. Stopping/restarting the HTTP daemon is different and preserves
persistent workloads. Owner loss/reboot is not live-session survival; independently
surviving scopes remain inventoried and terminable after the owner is restored.

For corrupt registry data, stop the host, inventory tmux/scopes, and preserve the damaged
file with a new name before starting recovery from tmux metadata. Do not delete scopes,
gate files or lock directories blindly. If a lock is incomplete, verify its PID/start
identity is no longer live before preserving/renaming it for manual recovery. A failed
recovery does not justify abandoning a potentially running process.
