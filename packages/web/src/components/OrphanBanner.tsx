import { useState } from "react";

import { api } from "../api/client.ts";
import type { HostState, OrphanKillResult } from "../types.ts";

/**
 * Surfaces processes that outlived a previous daemon run. Killing is always an
 * explicit action — the daemon re-verifies each pid's identity before signalling,
 * and reports anything it could not confirm rather than guessing.
 */
export function OrphanBanner({ states, onDone }: { states: HostState[]; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ host: string; result: OrphanKillResult }[] | null>(null);
  const [expanded, setExpanded] = useState(false);

  const withOrphans = states.filter((s) => s.orphans.length > 0);
  const total = withOrphans.reduce((n, s) => n + s.orphans.length, 0);
  if (total === 0 && !results) return null;

  const killAll = async (): Promise<void> => {
    setBusy(true);
    const collected: { host: string; result: OrphanKillResult }[] = [];
    for (const state of withOrphans) {
      try {
        for (const result of await api.killOrphans(state.entry)) {
          collected.push({ host: state.entry.label, result });
        }
      } catch (err: unknown) {
        collected.push({
          host: state.entry.label,
          result: { id: "—", outcome: "failed", detail: err instanceof Error ? err.message : "failed" },
        });
      }
    }
    setResults(collected);
    setBusy(false);
    onDone();
  };

  if (results) {
    const killed = results.filter((r) => r.result.outcome === "killed").length;
    const skipped = results.filter((r) => r.result.outcome !== "killed");
    return (
      <div className="border-b border-neutral-800 bg-neutral-900/60 px-4 py-2 text-sm">
        <span className="text-neutral-300">
          Killed {killed} orphaned {killed === 1 ? "process" : "processes"}.
        </span>
        {skipped.length > 0 && (
          <span className="ml-2 text-neutral-400">
            {skipped.length} skipped ({[...new Set(skipped.map((s) => s.result.outcome))].join(", ")}).
          </span>
        )}
        <button className="ml-3 text-neutral-400 underline hover:text-neutral-200" onClick={() => setResults(null)}>
          dismiss
        </button>
      </div>
    );
  }

  return (
    <div className="border-b border-amber-900/50 bg-amber-950/30 px-4 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-amber-200">
          {total} orphaned {total === 1 ? "session" : "sessions"} from a previous run
        </span>
        <button className="text-amber-300/80 underline hover:text-amber-200" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "hide" : "details"}
        </button>
        <button
          className="rounded border border-amber-700/60 px-2 py-0.5 text-amber-100 hover:bg-amber-900/40 disabled:opacity-50"
          onClick={() => void killAll()}
          disabled={busy}
        >
          {busy ? "killing…" : "Kill all"}
        </button>
      </div>
      {expanded && (
        <ul className="mt-2 space-y-1 font-mono text-xs text-amber-200/70">
          {withOrphans.flatMap((state) =>
            state.orphans.map((o) => (
              <li key={`${state.entry.id}:${o.id}`}>
                {state.entry.label} · pid {o.pid} · {o.agent} · {o.cwd}
              </li>
            )),
          )}
        </ul>
      )}
    </div>
  );
}
