# Linux persistent sessions

Implementation underway, 2026-09-16. Stage 1a is proven; production still uses direct
PTYs until the following backend/recovery stages ship. Windows stays unchanged.

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

## Remaining implementation gates

- Versioned durable ownership registry and bidirectional tmux reconciliation.
- Retain unreachable/failed-cleanup sessions, verified identity before termination.
- Workload descendant containment, not merely killing the pane PID. A shared tmux
  server cgroup alone cannot distinguish descendants of different sessions.
- Stable IDs, real agent exit codes, frontend reconnect/reset handling and recovery CLI.
- Production deployment and a real coding-agent self-restart demonstration.

The spike's owner-stop case proves simple workload death, not containment of hostile
or detached descendants; production cleanup must separately verify that boundary.

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
