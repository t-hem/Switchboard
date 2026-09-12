import { useCallback, useEffect, useMemo, useState } from "react";

import { HostSetup } from "./components/HostSetup.tsx";
import { NewSessionModal } from "./components/NewSessionModal.tsx";
import { OrphanBanner } from "./components/OrphanBanner.tsx";
import { SessionList } from "./components/SessionList.tsx";
import { TerminalView } from "./components/TerminalView.tsx";
import { loadHosts, saveHosts } from "./state/hosts.ts";
import { useFleet } from "./state/useFleet.ts";
import type { HostEntry } from "./types.ts";

/** Relative timestamps and the idle indicator need to re-render on their own. */
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function App() {
  const [hosts, setHosts] = useState<HostEntry[]>(() => loadHosts());
  const { states, merged, refresh } = useFleet(hosts);
  const now = useNow();

  // `at` is when the selection was made. A session is only treated as gone once its
  // host has completed a poll *after* that moment — otherwise a freshly created
  // session, which no poll has returned yet, would be deselected immediately.
  const [selected, setSelected] = useState<{ hostId: string; sessionId: string; at: number } | null>(null);
  const select = useCallback((hostId: string, sessionId: string) => {
    setSelected({ hostId, sessionId, at: Date.now() });
  }, []);
  const [newSessionFor, setNewSessionFor] = useState<string | null | undefined>(undefined);

  const orderedStates = useMemo(
    () => hosts.map((h) => states.get(h.id)).filter((s): s is NonNullable<typeof s> => s !== undefined),
    [hosts, states],
  );

  const addHost = useCallback((entry: HostEntry) => {
    setHosts((prev) => {
      const next = [...prev.filter((h) => h.id !== entry.id), entry];
      saveHosts(next);
      return next;
    });
  }, []);

  const selectedEntry = hosts.find((h) => h.id === selected?.hostId) ?? null;
  const selectedSession =
    merged.find((r) => r.session.id === selected?.sessionId && r.hostId === selected.hostId)?.session ?? null;

  // A session that disappears (killed elsewhere, daemon restarted) must not leave a
  // dangling terminal pane.
  useEffect(() => {
    if (!selected || selectedSession) return;
    const host = orderedStates.find((s) => s.entry.id === selected.hostId);
    if (host?.status !== "ok") return;
    if (host.lastSeenAt !== null && host.lastSeenAt > selected.at) setSelected(null);
  }, [selected, selectedSession, orderedStates]);

  if (hosts.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <h1 className="text-lg font-semibold">Switchboard</h1>
          <p className="mb-4 mt-1 text-sm text-neutral-400">
            Add the host daemon to connect to. Its address and token are printed when it starts.
          </p>
          <HostSetup onSave={addHost} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <OrphanBanner states={orderedStates} onDone={refresh} />

      <div className="flex min-h-0 flex-1">
        <aside
          className={`flex w-full min-w-0 flex-col border-neutral-800 md:w-80 md:shrink-0 md:border-r ${
            selected ? "hidden md:flex" : "flex"
          }`}
        >
          <header className="flex items-center gap-2 px-4 py-3">
            <h1 className="flex-1 text-sm font-semibold tracking-tight">Switchboard</h1>
            <button
              className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
              onClick={() => setNewSessionFor(null)}
            >
              New session
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SessionList
              states={orderedStates}
              merged={merged}
              now={now}
              selectedId={selected?.sessionId ?? null}
              onSelect={select}
              onNewSession={(hostId) => setNewSessionFor(hostId)}
              onChanged={refresh}
            />
          </div>
        </aside>

        <main className={`min-w-0 flex-1 ${selected ? "flex" : "hidden md:flex"} flex-col`}>
          {selectedEntry && selectedSession ? (
            <TerminalView
              key={selectedSession.id}
              entry={selectedEntry}
              session={selectedSession}
              onBack={() => setSelected(null)}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-neutral-600">
              Select a session.
            </div>
          )}
        </main>
      </div>

      {newSessionFor !== undefined && (
        <NewSessionModal
          hosts={orderedStates}
          {...(newSessionFor ? { initialHostId: newSessionFor } : {})}
          onClose={() => setNewSessionFor(undefined)}
          onCreated={(hostId, session) => {
            setNewSessionFor(undefined);
            refresh();
            select(hostId, session.id);
          }}
        />
      )}
    </div>
  );
}
