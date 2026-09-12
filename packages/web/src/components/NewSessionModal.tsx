import { useEffect, useState } from "react";

import { api } from "../api/client.ts";
import type { HostState, Session } from "../types.ts";

export function NewSessionModal({
  hosts,
  initialHostId,
  onClose,
  onCreated,
}: {
  hosts: HostState[];
  initialHostId?: string;
  onClose: () => void;
  onCreated: (hostId: string, session: Session) => void;
}) {
  const usable = hosts.filter((h) => h.status === "ok");
  const [hostId, setHostId] = useState(initialHostId ?? usable[0]?.entry.id ?? "");
  const host = usable.find((h) => h.entry.id === hostId) ?? usable[0];

  const [agent, setAgent] = useState("");
  const [cwd, setCwd] = useState("");
  const [workspaces, setWorkspaces] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only agents actually installed on the chosen host can be started there.
  const agents = host?.health?.agents ?? [];
  const available = agents.filter((a) => a.available);
  const missing = agents.filter((a) => !a.available);

  useEffect(() => {
    if (!host) return;
    setAgent(available[0]?.name ?? "");
    setWorkspaces(null);
    let cancelled = false;
    void api
      .workspaces(host.entry)
      .then((list) => {
        if (cancelled) return;
        setWorkspaces(list);
        // Deliberately no default: the directory decides which repo an agent gets
        // loose in, so it is always an explicit choice. Start stays disabled until
        // one is picked.
      })
      .catch(() => {
        if (!cancelled) setWorkspaces([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.entry.id]);

  const submit = async (): Promise<void> => {
    if (!host || !agent || !cwd.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const session = await api.createSession(host.entry, { agent, cwd: cwd.trim() });
      onCreated(host.entry.id, session);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "could not start the session");
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-t-xl border border-neutral-800 bg-neutral-950 p-4 sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold">New session</h2>

        {usable.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-400">No reachable host to start a session on.</p>
        ) : (
          <div className="mt-3 space-y-3">
            {usable.length > 1 && (
              <Field label="Host">
                <select className={INPUT} value={hostId} onChange={(e) => setHostId(e.target.value)}>
                  {usable.map((h) => (
                    <option key={h.entry.id} value={h.entry.id}>
                      {h.entry.label}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            <Field label="Agent">
              <select className={INPUT} value={agent} onChange={(e) => setAgent(e.target.value)}>
                {available.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </select>
              {available.length === 0 && (
                <p className="mt-1 text-xs text-amber-400">No agents are installed on this host.</p>
              )}
              {missing.length > 0 && (
                <p className="mt-1 text-xs text-neutral-500">
                  Not installed here: {missing.map((a) => a.name).join(", ")}
                </p>
              )}
            </Field>

            <Field label="Directory">
              {workspaces !== null && workspaces.length > 0 && (
                <select
                  className={`${INPUT} mb-2`}
                  value={workspaces.includes(cwd) ? cwd : ""}
                  onChange={(e) => setCwd(e.target.value)}
                >
                  <option value="">— pick a repo —</option>
                  {workspaces.map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              )}
              {/* The free-text fallback is always available: gating it on the
                  workspace scan would make it useless exactly when the scan is slow
                  or the roots are misconfigured. */}
              <input
                className={INPUT}
                value={cwd}
                placeholder="or type a path"
                onChange={(e) => setCwd(e.target.value)}
                spellCheck={false}
                autoCapitalize="none"
              />
              {workspaces === null && (
                <p className="mt-1 text-xs text-neutral-500">Scanning workspace roots…</p>
              )}
              {workspaces?.length === 0 && (
                <p className="mt-1 text-xs text-neutral-500">
                  No git repos found under this host&apos;s workspaceRoots.
                </p>
              )}
            </Field>

            {error && <p className="text-sm text-red-400">{error}</p>}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button className="rounded px-3 py-1.5 text-sm text-neutral-400 hover:text-neutral-200" onClick={onClose}>
            Cancel
          </button>
          <button
            className="rounded bg-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-40"
            onClick={() => void submit()}
            disabled={busy || !host || !agent || !cwd.trim()}
          >
            {busy ? "Starting…" : "Start"}
          </button>
        </div>
      </div>
    </div>
  );
}

const INPUT =
  "w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 outline-none focus:border-neutral-500";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-wide text-neutral-500">{label}</span>
      {children}
    </label>
  );
}
