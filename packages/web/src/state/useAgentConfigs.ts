import { useCallback, useEffect, useState } from "react";

import { api } from "../api/client.ts";
import type { AgentsConfigResponse, HostEntry, HostState } from "../types.ts";

export type AgentConfigState = Map<string, AgentsConfigResponse>;

export type Drift = {
  /** The host holding the newest map, which wins under last-write-wins. */
  newestHostId: string;
  newest: AgentsConfigResponse;
  /** Reachable hosts whose map is not the newest one. */
  staleHostIds: string[];
};

/**
 * Fetches the agents map from every reachable host, on load and on demand.
 *
 * Deliberately not part of the 5s session poll: the map changes when a human edits
 * it, not continuously, and polling it would be three extra requests per host every
 * five seconds for nothing.
 */
export function useAgentConfigs(states: HostState[]): {
  configs: AgentConfigState;
  drift: Drift | null;
  refresh: () => void;
  loading: boolean;
} {
  const [configs, setConfigs] = useState<AgentConfigState>(new Map());
  const [loading, setLoading] = useState(false);

  const reachable = states.filter((s) => s.status === "ok").map((s) => s.entry);
  const key = reachable.map((e) => e.id).join(",");

  const fetchAll = useCallback(async (entries: HostEntry[]): Promise<void> => {
    if (entries.length === 0) return;
    setLoading(true);
    const results = await Promise.allSettled(entries.map((e) => api.agentsConfig(e)));
    setConfigs((prev) => {
      const next = new Map(prev);
      entries.forEach((entry, i) => {
        const result = results[i];
        if (result?.status === "fulfilled") next.set(entry.id, result.value);
        else next.delete(entry.id);
      });
      return next;
    });
    setLoading(false);
  }, []);

  const refresh = useCallback(() => void fetchAll(reachable), [fetchAll, key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void fetchAll(reachable);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const drift = computeDrift(configs, reachable);
  return { configs, drift, refresh, loading };
}

export function computeDrift(configs: AgentConfigState, reachable: HostEntry[]): Drift | null {
  const present = reachable
    .map((e) => ({ hostId: e.id, config: configs.get(e.id) }))
    .filter((x): x is { hostId: string; config: AgentsConfigResponse } => x.config !== undefined);
  if (present.length < 2) return null;

  const stamps = new Set(present.map((p) => p.config.updatedAt));
  if (stamps.size === 1) return null;

  // Last write wins on the whole map, decided purely by updatedAt.
  const newest = present.reduce((a, b) => (b.config.updatedAt > a.config.updatedAt ? b : a));
  return {
    newestHostId: newest.hostId,
    newest: newest.config,
    staleHostIds: present.filter((p) => p.config.updatedAt !== newest.config.updatedAt).map((p) => p.hostId),
  };
}

export type AgentDiffRow = {
  name: string;
  change: "added" | "removed" | "changed" | "same";
  newest?: string;
  theirs?: string;
};

const describe = (def: unknown): string => JSON.stringify(def);

/** Per-agent diff between the winning map and one stale host's map. */
export function diffAgents(
  newest: AgentsConfigResponse,
  theirs: AgentsConfigResponse,
): AgentDiffRow[] {
  const names = [...new Set([...Object.keys(newest.agents), ...Object.keys(theirs.agents)])].sort();
  return names.map((name) => {
    const a = newest.agents[name];
    const b = theirs.agents[name];
    if (a && !b) return { name, change: "added", newest: describe(a) };
    if (!a && b) return { name, change: "removed", theirs: describe(b) };
    const an = describe(a);
    const bn = describe(b);
    return an === bn
      ? { name, change: "same", newest: an, theirs: bn }
      : { name, change: "changed", newest: an, theirs: bn };
  });
}
