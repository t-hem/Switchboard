import { useCallback, useEffect, useMemo, useState } from "react";

import { HostSetup } from "./components/HostSetup.tsx";
import { NewSessionModal } from "./components/NewSessionModal.tsx";
import { DriftBanner, DriftReview } from "./components/AgentSync.tsx";
import { OrphanBanner } from "./components/OrphanBanner.tsx";
import { SessionList } from "./components/SessionList.tsx";
import { Settings } from "./components/Settings.tsx";
import { TerminalView } from "./components/TerminalView.tsx";
import {
  clientId as loadClientId,
  clientLabel as loadClientLabel,
  loadHosts,
  saveHosts,
  setSidebarCollapsed,
  sidebarCollapsed as loadSidebarCollapsed,
} from "./state/hosts.ts";
import { useAgentConfigs } from "./state/useAgentConfigs.ts";
import { useClaim } from "./state/useClaim.ts";
import { useFleet } from "./state/useFleet.ts";
import { useJobsConnection } from "./state/useJobsConnection.ts";
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
  const jobs = useJobsConnection();
  const [hosts, setHosts] = useState<HostEntry[]>(() => loadHosts());
  const clientId = useMemo(() => loadClientId(), []);
  const [clientLabel, setClientLabelState] = useState(() => loadClientLabel());
  const { claimAll } = useClaim(hosts, clientId, clientLabel);
  const [evicted, setEvicted] = useState<{ hostId: string; reason: string } | null>(null);
  const [takeBackNonce, setTakeBackNonce] = useState(0);
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(loadSidebarCollapsed);
  const [reviewOpen, setReviewOpen] = useState(false);

  /** Re-claim every host, then remount the terminal so it reattaches and replays. */
  const takeBack = useCallback(async () => {
    await claimAll();
    setEvicted(null);
    setTakeBackNonce((n) => n + 1);
  }, [claimAll]);

  const orderedStatesForConfig = useMemo(
    () => hosts.map((h) => states.get(h.id)).filter((s): s is NonNullable<typeof s> => s !== undefined),
    [hosts, states],
  );
  const { configs, drift, refresh: refreshConfigs } = useAgentConfigs(orderedStatesForConfig);

  const orderedStates = useMemo(
    () => hosts.map((h) => states.get(h.id)).filter((s): s is NonNullable<typeof s> => s !== undefined),
    [hosts, states],
  );

  const persist = useCallback((update: (prev: HostEntry[]) => HostEntry[]) => {
    setHosts((prev) => {
      const next = update(prev);
      saveHosts(next);
      return next;
    });
  }, []);

  /** Add a new host, or replace an existing one in place so its position is kept. */
  const saveHost = useCallback(
    (entry: HostEntry) =>
      persist((prev) =>
        prev.some((h) => h.id === entry.id)
          ? prev.map((h) => (h.id === entry.id ? entry : h))
          : [...prev, entry],
      ),
    [persist],
  );

  const removeHost = useCallback(
    (id: string) => {
      persist((prev) => prev.filter((h) => h.id !== id));
      setSelected((current) => (current?.hostId === id ? null : current));
    },
    [persist],
  );

  const moveHost = useCallback(
    (id: string, direction: -1 | 1) =>
      persist((prev) => {
        const index = prev.findIndex((h) => h.id === id);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= prev.length) return prev;
        const next = [...prev];
        const [moved] = next.splice(index, 1);
        if (moved) next.splice(target, 0, moved);
        return next;
      }),
    [persist],
  );

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
          <HostSetup onSave={saveHost} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {evicted && (
        <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-900/50 bg-amber-950/50 px-4 py-2 text-sm">
          <span className="flex-1 text-amber-100">
            Taken over by {evicted.reason.replace(/^claimed by /, "")}. Sessions are still running.
          </span>
          <button
            className="rounded border border-amber-700/60 px-2 py-0.5 text-amber-100 hover:bg-amber-900/40"
            onClick={() => void takeBack()}
          >
            Take back
          </button>
        </div>
      )}

      <OrphanBanner states={orderedStates} onDone={refresh} />
      {drift && !reviewOpen && (
        <DriftBanner drift={drift} states={orderedStates} onReview={() => setReviewOpen(true)} />
      )}

      <div className="flex min-h-0 flex-1">
        {/* Collapsed hides the sidebar outright at desktop width; `☰` in the terminal
            header brings it back. Below `md` this does nothing — there the sidebar and
            the terminal already swap on whether a session is selected. */}
        <aside
          className={`flex w-full min-w-0 flex-col border-neutral-800 md:w-80 md:shrink-0 md:border-r ${
            selected ? "hidden md:flex" : "flex"
          } ${collapsed ? "md:hidden" : ""}`}
        >
          <header className="flex items-center gap-2 px-4 py-3">
            <h1 className="flex-1 text-sm font-semibold tracking-tight">Switchboard</h1>
            <button
              className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
              onClick={() => setNewSessionFor(null)}
            >
              New session
            </button>
            <button
              aria-label="Settings"
              title="Settings"
              className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
              onClick={() => {
                // Spec §5.5: re-read the agents map whenever settings is opened.
                refreshConfigs();
                setSettingsOpen(true);
              }}
            >
              ⚙
            </button>
            <button
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
              className="hidden rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800 md:block"
              onClick={() => {
                setCollapsed(true);
                setSidebarCollapsed(true);
              }}
            >
              ☰
            </button>
          </header>
          {jobs.url && <div className="px-4 pb-2 text-xs">
            {jobs.status === "online"
              ? <a href={jobs.url} target="_blank" rel="noopener noreferrer" className="text-blue-300">Jobs ↗</a>
              : <button onClick={()=>setSettingsOpen(true)} className="text-neutral-400">Jobs {jobs.status} · connection settings</button>}
          </div>}
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
              key={`${selectedSession.id}:${takeBackNonce}`}
              entry={selectedEntry}
              session={selectedSession}
              clientId={clientId}
              clientLabel={clientLabel}
              onBack={() => setSelected(null)}
              sidebarCollapsed={collapsed}
              onExpandSidebar={() => {
                setCollapsed(false);
                setSidebarCollapsed(false);
              }}
              onEvicted={(reason) => setEvicted({ hostId: selectedEntry.id, reason })}
              onTakeOver={() => void takeBack()}
            />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              {/* Collapsing with nothing selected would otherwise leave no control
                  anywhere on screen to bring the list back. */}
              {collapsed && (
                <header className="hidden items-center border-b border-neutral-800 px-3 py-2 md:flex">
                  <button
                    aria-label="Show sessions"
                    title="Show sessions"
                    className="rounded px-1.5 py-0.5 text-sm text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
                    onClick={() => {
                      setCollapsed(false);
                      setSidebarCollapsed(false);
                    }}
                  >
                    ☰
                  </button>
                </header>
              )}
              <div className="flex flex-1 items-center justify-center text-sm text-neutral-600">
                Select a session.
              </div>
            </div>
          )}
        </main>
      </div>

      {settingsOpen && (
        <Settings
          jobs={jobs}
          states={orderedStates}
          now={now}
          configs={configs}
          onSave={saveHost}
          onRemove={removeHost}
          onMove={moveHost}
          onAgentsSaved={refreshConfigs}
          clientLabel={clientLabel}
          onClientLabelChange={setClientLabelState}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {reviewOpen && drift && (
        <DriftReview
          drift={drift}
          states={orderedStates}
          configs={configs}
          onClose={() => setReviewOpen(false)}
          onSynced={refreshConfigs}
        />
      )}

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
