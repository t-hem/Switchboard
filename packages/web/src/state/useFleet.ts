import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { HttpError, api } from "../api/client.ts";
import type { HostEntry, HostState, SessionRef } from "../types.ts";
import { POLL_INTERVAL_MS } from "./polling.ts";

function initialState(entry: HostEntry): HostState {
  return {
    entry,
    status: "checking",
    health: null,
    sessions: [],
    orphans: [],
    lastSeenAt: null,
    error: null,
  };
}

/**
 * Polls every configured host in parallel and merges the results.
 *
 * A host that fails is marked offline and keeps its last-seen timestamp; it must
 * never block or error the rest of the list, which is why each host is settled
 * independently rather than through a single Promise.all.
 */
export function useFleet(hosts: HostEntry[]): {
  states: Map<string, HostState>;
  merged: SessionRef[];
  refresh: () => void;
} {
  const [states, setStates] = useState<Map<string, HostState>>(new Map());
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;

  const pollHost = useCallback(async (entry: HostEntry): Promise<void> => {
    const [health, sessions, orphans] = await Promise.allSettled([
      api.health(entry),
      api.sessions(entry),
      api.orphans(entry),
    ]);

    setStates((prev) => {
      const next = new Map(prev);
      const current = prev.get(entry.id) ?? initialState(entry);

      if (health.status === "rejected") {
        next.set(entry.id, {
          ...current,
          entry,
          status: "offline",
          error: health.reason instanceof Error ? health.reason.message : "unreachable",
        });
        return next;
      }

      // Reachable. Whether the token works is a separate question, and the two are
      // shown differently: a wrong token is a fixable mistake, a dead host is not.
      const unauthorized =
        sessions.status === "rejected" &&
        sessions.reason instanceof HttpError &&
        sessions.reason.status === 401;

      next.set(entry.id, {
        entry,
        status: unauthorized ? "unauthorized" : "ok",
        health: health.value,
        sessions: sessions.status === "fulfilled" ? sessions.value : current.sessions,
        orphans: orphans.status === "fulfilled" ? orphans.value : [],
        lastSeenAt: Date.now(),
        error: unauthorized ? "token rejected" : null,
      });
      return next;
    });
  }, []);

  const refresh = useCallback(() => {
    for (const entry of hostsRef.current) void pollHost(entry);
  }, [pollHost]);

  useEffect(() => {
    // Drop state for hosts that have been removed.
    setStates((prev) => {
      const next = new Map<string, HostState>();
      for (const entry of hosts) next.set(entry.id, prev.get(entry.id) ?? initialState(entry));
      return next;
    });
    refresh();
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hosts, refresh]);

  // The session that just did something floats to the top.
  const merged = useMemo(() => {
    const rows: SessionRef[] = [];
    for (const state of states.values()) {
      for (const session of state.sessions) rows.push({ hostId: state.entry.id, session });
    }
    return rows.sort((a, b) => b.session.lastOutputAt - a.session.lastOutputAt);
  }, [states]);

  return { states, merged, refresh };
}
