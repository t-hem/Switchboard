import { useState } from "react";

import { api } from "../api/client.ts";
import { diffAgents, type Drift } from "../state/useAgentConfigs.ts";
import type { AgentsConfigResponse, HostState } from "../types.ts";

export function DriftBanner({ drift, states, onReview }: { drift: Drift; states: HostState[]; onReview: () => void }) {
  const newestLabel = states.find((s) => s.entry.id === drift.newestHostId)?.entry.label ?? "another host";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-sky-900/50 bg-sky-950/30 px-4 py-2 text-sm">
      <span className="text-sky-200">
        Agent config differs across hosts — newest is on {newestLabel}.
      </span>
      <button
        className="rounded border border-sky-700/60 px-2 py-0.5 text-sky-100 hover:bg-sky-900/40"
        onClick={onReview}
      >
        Review
      </button>
    </div>
  );
}

/**
 * Shows the diff before applying it. With one operator this is nearly always
 * trivial and one click, but silent last-write-wins can quietly discard an agent
 * added on the other machine, and a two-second glance prevents that.
 */
export function DriftReview({
  drift,
  states,
  configs,
  onClose,
  onSynced,
}: {
  drift: Drift;
  states: HostState[];
  configs: Map<string, AgentsConfigResponse>;
  onClose: () => void;
  onSynced: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const labelOf = (id: string): string => states.find((s) => s.entry.id === id)?.entry.label ?? id;

  const syncAll = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const payload = { updatedAt: drift.newest.updatedAt, agents: drift.newest.agents };
    const failures: string[] = [];
    for (const hostId of drift.staleHostIds) {
      const state = states.find((s) => s.entry.id === hostId);
      if (!state) continue;
      try {
        // force: the winning map is intentionally being pushed over a host whose
        // stored copy may carry a newer timestamp than the payload it is replacing.
        await api.putAgentsConfig(state.entry, payload, true);
      } catch (err: unknown) {
        failures.push(`${state.entry.label}: ${err instanceof Error ? err.message : "failed"}`);
      }
    }
    setBusy(false);
    if (failures.length > 0) {
      setError(failures.join("; "));
      return;
    }
    onSynced();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-0 sm:p-4" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-3xl flex-col border border-neutral-800 bg-neutral-950 sm:h-auto sm:max-h-[85vh] sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-neutral-800 px-4 py-3">
          <h2 className="flex-1 text-sm font-semibold">
            Agent config drift — newest is on {labelOf(drift.newestHostId)}
          </h2>
          <button className="rounded px-2 text-neutral-400 hover:text-neutral-100" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {drift.timestampConflict && (
            <p className="rounded border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
              Two hosts carry the same timestamp but different agents. Last-write-wins cannot
              choose between them, so syncing will discard one side. Check the diff below, and if
              the losing side has something worth keeping, add it on the winning host first.
            </p>
          )}
          {drift.staleHostIds.map((hostId) => {
            const theirs = configs.get(hostId);
            if (!theirs) return null;
            const rows = diffAgents(drift.newest, theirs).filter((r) => r.change !== "same");
            return (
              <section key={hostId} className="rounded border border-neutral-800">
                <h3 className="border-b border-neutral-800 px-3 py-2 text-xs uppercase tracking-wide text-neutral-400">
                  {labelOf(hostId)}
                  <span className="ml-2 normal-case text-neutral-600">
                    {new Date(theirs.updatedAt).toLocaleString()} → {new Date(drift.newest.updatedAt).toLocaleString()}
                  </span>
                </h3>
                {rows.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-neutral-500">
                    Same agents, older timestamp. Syncing only aligns the stamp.
                  </p>
                ) : (
                  <ul className="divide-y divide-neutral-900">
                    {rows.map((row) => (
                      <li key={row.name} className="px-3 py-2 text-sm">
                        <span className="flex items-center gap-2">
                          <ChangeTag change={row.change} />
                          <span className="font-medium text-neutral-200">{row.name}</span>
                        </span>
                        <div className="mt-1 space-y-0.5 font-mono text-xs">
                          {row.theirs && (
                            <div className="text-red-400/80">
                              − {labelOf(hostId)}: {row.theirs}
                            </div>
                          )}
                          {row.newest && <div className="text-emerald-400/80">+ newest: {row.newest}</div>}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-neutral-800 px-4 py-3">
          <button className="rounded px-3 py-1.5 text-sm text-neutral-400 hover:text-neutral-200" onClick={onClose}>
            Not now
          </button>
          <button
            className="rounded bg-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-40"
            onClick={() => void syncAll()}
            disabled={busy}
          >
            {busy ? "Syncing…" : `Sync all to newest (${drift.staleHostIds.length})`}
          </button>
        </footer>
      </div>
    </div>
  );
}

function ChangeTag({ change }: { change: "added" | "removed" | "changed" | "same" }) {
  const styles = {
    added: "bg-emerald-900/50 text-emerald-300",
    removed: "bg-red-900/50 text-red-300",
    changed: "bg-amber-900/50 text-amber-300",
    same: "bg-neutral-800 text-neutral-400",
  } as const;
  return <span className={`rounded px-1.5 py-0.5 text-[11px] uppercase ${styles[change]}`}>{change}</span>;
}
