import { api } from "../api/client.ts";
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
  return (
    <div className="flex flex-col">
      {states.map((state) => {
        const rows = merged.filter((r) => r.hostId === state.entry.id);
        return (
          <section key={state.entry.id}>
            <HostHeader state={state} now={now} onNewSession={() => onNewSession(state.entry.id)} />
            {state.status === "ok" && rows.length === 0 && (
              <p className="px-4 py-3 text-sm text-neutral-600">No sessions.</p>
            )}
            {rows.map(({ session }) => (
              <button
                key={session.id}
                onClick={() => onSelect(state.entry.id, session.id)}
                className={`flex w-full items-center gap-3 border-l-2 px-4 py-2.5 text-left transition-colors ${
                  selectedId === session.id
                    ? "border-l-neutral-300 bg-neutral-800/60"
                    : "border-l-transparent hover:bg-neutral-900"
                }`}
              >
                <StatusDot activity={activityOf(session, now)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-neutral-200">{session.label}</span>
                  <span className="block truncate text-xs text-neutral-500">
                    {session.status === "exited"
                      ? `exited${session.exitCode !== null ? ` (${session.exitCode})` : ""}`
                      : relativeTime(session.lastOutputAt, now)}
                    {" · pid "}
                    {session.pid}
                  </span>
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  title="Kill session"
                  className="shrink-0 rounded px-1.5 py-0.5 text-xs text-neutral-600 hover:bg-neutral-800 hover:text-red-400"
                  onClick={(e) => {
                    e.stopPropagation();
                    void api.killSession(state.entry, session.id).finally(onChanged);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.stopPropagation();
                    void api.killSession(state.entry, session.id).finally(onChanged);
                  }}
                >
                  ✕
                </span>
              </button>
            ))}
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
