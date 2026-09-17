import { useCallback, useState } from "react";

import { api } from "../api/client.ts";
import { lockedSessions, saveLockedSessions } from "../state/hosts.ts";
import type { HostState, SessionRef } from "../types.ts";
import { StatusDot, activityOf, relativeTime } from "./StatusDot.tsx";

export function SessionList({
  states,
  merged,
  now,
  selectedId,
  onSelect,
  onNewSession,
  onChanged,
}: {
  states: HostState[];
  merged: SessionRef[];
  now: number;
  selectedId: string | null;
  onSelect: (hostId: string, sessionId: string) => void;
  onNewSession: (hostId: string) => void;
  onChanged: () => void;
}) {
  // Two-step confirm, matching Settings' host removal: the first click arms, the
  // second acts. Both destinations here are irreversible enough to deserve it —
  // killing a live agent throws away however long it has been working, and once a
  // session is removed from the map nothing in the daemon remembers it.
  const [arming, setArming] = useState<string | null>(null);
  // A confirm step only helps someone who reads it. A lock is the deliberate act
  // that a reflexive click cannot perform, so it survives a reload and has to be
  // undone on purpose before the row can be closed at all.
  const [locked, setLocked] = useState<Set<string>>(lockedSessions);

  const toggleLock = useCallback((id: string) => {
    setLocked((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      saveLockedSessions(next);
      return next;
    });
    setArming((prev) => (prev === id ? null : prev));
  }, []);

  return (
    <div className="flex flex-col">
      {states.map((state) => {
        const rows = merged.filter((r) => r.hostId === state.entry.id);
        const reachable = state.status === "ok";
        return (
          <section key={state.entry.id}>
            <HostHeader state={state} now={now} onNewSession={() => onNewSession(state.entry.id)} />
            {state.status === "ok" && rows.length === 0 && (
              <p className="px-4 py-3 text-sm text-neutral-600">No sessions.</p>
            )}
            {rows.map(({ session }) => {
              const isLocked = locked.has(session.id);
              const armed = arming === session.id;
              const act = () => {
                setArming(null);
                void api.killSession(state.entry, session.id).finally(onChanged);
              };
              return (
                <button
                  key={session.id}
                  onClick={() => onSelect(state.entry.id, session.id)}
                  className={`flex w-full items-center gap-3 border-l-2 px-4 py-2.5 text-left transition-colors ${
                    selectedId === session.id
                      ? "border-l-neutral-300 bg-neutral-800/60"
                      : "border-l-transparent hover:bg-neutral-900"
                  } ${reachable ? "" : "opacity-50"}`}
                >
                  <StatusDot activity={reachable ? activityOf(session, now) : "unknown"} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-neutral-200">{session.label}</span>
                    <span className="block truncate text-xs text-neutral-500">
                      {!reachable
                        ? "host unreachable — state unknown"
                        : session.status === "exited"
                          ? `exited${session.exitCode !== null ? ` (${session.exitCode})` : ""}`
                          : relativeTime(session.lastOutputAt, now)}
                      {/* An exited session has no pid worth reporting — the process is
                          already gone. The space it occupied is the natural home for
                          the control that clears the row. */}
                      {reachable && session.status === "exited" ? null : (
                        <>
                          {" · pid "}
                          {session.pid}
                        </>
                      )}
                    </span>
                    {session.recovery && <span className="block text-xs text-amber-400">{session.recovery}</span>}
                  </span>
                  {reachable && (
                    <>
                      <span
                        role="button"
                        tabIndex={0}
                        aria-pressed={isLocked}
                        title={isLocked ? "Unlock to allow closing" : "Lock against an accidental close"}
                        className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                          isLocked
                            ? "text-amber-400 hover:bg-neutral-800"
                            : "text-neutral-700 hover:bg-neutral-800 hover:text-neutral-300"
                        }`}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleLock(session.id);
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.stopPropagation();
                          toggleLock(session.id);
                        }}
                      >
                        {isLocked ? "🔒" : "🔓"}
                      </span>
                      <span
                        role="button"
                        tabIndex={isLocked ? -1 : 0}
                        aria-disabled={isLocked}
                        title={
                          isLocked
                            ? "Locked — unlock first"
                            : session.status === "exited"
                              ? "Remove from the list"
                              : "Kill this session"
                        }
                        className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                          isLocked
                            ? "cursor-not-allowed text-neutral-800"
                            : armed
                              ? "bg-red-900/60 text-red-200 hover:bg-red-900"
                              : "text-neutral-600 hover:bg-neutral-800 hover:text-red-400"
                        }`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isLocked) return;
                          if (!armed) {
                            setArming(session.id);
                            return;
                          }
                          act();
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.stopPropagation();
                          if (isLocked) return;
                          if (!armed) {
                            setArming(session.id);
                            return;
                          }
                          act();
                        }}
                      >
                        {isLocked
                          ? "✕"
                          : armed
                            ? session.status === "exited"
                              ? "Really delete?"
                              : "Really kill?"
                            : session.status === "exited"
                              ? "Delete"
                              : "✕"}
                      </span>
                    </>
                  )}
                </button>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

function HostHeader({
  state,
  now,
  onNewSession,
}: {
  state: HostState;
  now: number;
  onNewSession: () => void;
}) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 border-y border-neutral-800/70 bg-neutral-950/95 px-4 py-1.5 backdrop-blur">
      <span className="truncate text-xs font-medium uppercase tracking-wide text-neutral-400">
        {state.entry.label}
      </span>
      <HostBadge state={state} now={now} />
      {/* The backend is a property of the host, not of any one session, so it is
          stated once here rather than repeated on every row. It buys survival of a
          daemon restart; a reboot takes the tmux server with it (LINUX-SESSIONS.md). */}
      {state.status === "ok" && state.health?.sessionBackend === "tmux" && (
        <span
          className="shrink-0 text-[11px] text-neutral-600"
          title="Sessions run under tmux and outlive the daemon process. A host reboot still ends them."
        >
          persists across daemon restarts
        </span>
      )}
      <span className="flex-1" />
      {state.status === "ok" && (
        <button
          onClick={onNewSession}
          title="New session on this host"
          className="rounded px-1.5 text-sm text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
        >
          +
        </button>
      )}
    </div>
  );
}

function HostBadge({ state, now }: { state: HostState; now: number }) {
  if (state.status === "ok") {
    return <span className="text-[11px] text-neutral-600">{state.health?.platform}</span>;
  }
  if (state.status === "checking") {
    return <span className="text-[11px] text-neutral-600">checking…</span>;
  }
  if (state.status === "unauthorized") {
    return <span className="text-[11px] text-red-400">token rejected</span>;
  }
  return (
    <span className="text-[11px] text-neutral-500" title={state.error ?? undefined}>
      offline
      {state.lastSeenAt !== null && ` · last seen ${relativeTime(state.lastSeenAt, now)}`}
    </span>
  );
}
