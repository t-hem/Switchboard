# Linux persistent sessions

Deployed and verified on this Linux machine, 2026-09-16. Windows stays unchanged.

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

The web client requests `display=snapshot` on its session WebSocket. Persistent
sessions send the pane's retained history and current screen from `capture-pane`,
with actual geometry, cursor position and keyboard modes. History joins soft wraps
and the browser reflows it at its current width; screen rows retain their geometry.
Captures made before a resize reaches the pane are not painted at the new width.
An unchanged history is omitted from subsequent frames on that connection.
Keyboard input bypasses the 100 ms bulk-output batching delay for subsequent
redraws. The browser repaints only the screen when history is unchanged, and only
updates cursor/modes when the screen text is unchanged.

Browser scrolling stays local and freezes the displayed snapshot while reading.
Incoming snapshots are coalesced until the reader scrolls to the bottom or selects
Latest. This keeps Pi-style history rebuilds from moving the text under the reader.
The pane's bounded tmux history is available after daemon restart too; already
discarded history cannot be recovered. Applications using their own alternate
screen still retain their usual alternate-screen semantics.

Raw WebSocket consumers and direct PTYs keep the byte-stream protocol below.

Normal direct PTYs retain their existing raw-byte behavior. tmux attachments stream
rendered terminal output, with Unicode/input/resize/alternate-screen fidelity checked
by the spike. After restart the old daemon byte ring is gone. The new attachment
redraws the current screen; tmux keeps bounded history in memory, but that history is
not automatically a raw client's old scrollback. Do not promise original byte replay
or history beyond what the pane retains. The web snapshot protocol above explicitly
retrieves that retained history.
No terminal history is written to disk by the host/owner configuration.

An attachment's terminal is the host pty, so tmux's attach-time queries (`ESC[>c`,
`ESC[>q`) are removed from the attachment stream and left unanswered. Otherwise they
enter the scrollback, every browser replay makes xterm.js answer them late, and tmux
types the answer (`0;276;0c`) into the agent. Unanswered and xterm.js-answered
attachments produce byte-identical rendering on tmux 3.2a.

## Remaining hardware checks

Physical phone and Windows hardware checks remain outstanding. The Linux rollout,
real coding-agent self-restart, Chromium desktop/mobile viewport, crash-window and
offline recovery checks passed; see the deployment record below.

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

## This machine: deployed and verified (step 1d, 2026-09-16)

The live daemon now uses tmux. Machine-local files are
`~/.config/systemd/user/switchboard-owner.service`, `~/.switchboard/tmux-owner.conf`,
`~/.switchboard/owner.sock` and the tmux block in `~/.switchboard/host.json`.
`~/.switchboard/host.pre-tmux.json` is the private configuration backup. These files
are deliberately not committed. The owner has no PartOf/BindsTo relationship with
`switchboard.service`; its foreground ExecStart runs tmux independently. Each workload
uses a separate transient scope. The owner is enabled at user-service startup.

```sh
systemctl --user status switchboard.service switchboard-owner.service
systemctl --user restart switchboard.service  # retains persistent workloads
node packages/host/dist/recovery-cli.js list
```

Never use owner restart as a normal deployment operation. If the socket is lost,
use `systemctl --user kill --kill-who=main --signal=SIGUSR1 switchboard-owner.service`
and restore its private permissions. The backend retries discovery when the owner
returns, including when the primary registry was absent during host startup.

The real coding-agent self-upgrade committed `6d38106`, restarted the live host and
continued with unchanged agent PID/session ID. Chromium reconnect/takeover/resize,
offline CLI attachment/cleanup, and crashes during spawn/deletion passed. Physical
phone/Windows checks remain outstanding. `switchboard-web.timer` is active again.
