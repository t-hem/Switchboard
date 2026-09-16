import { useState } from "react";

import { setClientLabel } from "../state/hosts.ts";
import type { AgentsConfigResponse, HostEntry, HostState } from "../types.ts";
import { AgentsEditor } from "./AgentsEditor.tsx";
import { HostSetup } from "./HostSetup.tsx";
import { relativeTime } from "./StatusDot.tsx";
import { JobsConnection } from "./JobsConnection.tsx";

export function Settings({
  jobs,
  states,
  now,
  configs,
  onSave,
  onRemove,
  onMove,
  onAgentsSaved,
  clientLabel,
  onClientLabelChange,
  onClose,
}: {
  jobs: {url:string; status:string; save:(value:string)=>void};
  states: HostState[];
  now: number;
  configs: Map<string, AgentsConfigResponse>;
  onSave: (entry: HostEntry) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onAgentsSaved: () => void;
  clientLabel: string;
  onClientLabelChange: (label: string) => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<HostEntry | "new" | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-md flex-col border-l border-neutral-800 bg-neutral-950"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-neutral-800 px-4 py-3">
          <h2 className="flex-1 text-sm font-semibold">Settings</h2>
          <button className="rounded px-2 text-neutral-400 hover:text-neutral-100" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
          <section>
            <h3 className="mb-2 text-xs uppercase tracking-wide text-neutral-500">Hosts</h3>
            <ul className="space-y-2" aria-label="Configured hosts">
              {states.map((state, index) => (
                <li key={state.entry.id} className="rounded border border-neutral-800 bg-neutral-900/50 p-3">
                  {editing !== "new" && editing?.id === state.entry.id ? (
                    <HostSetup
                      existing={state.entry}
                      onSave={(entry) => {
                        onSave(entry);
                        setEditing(null);
                      }}
                      onCancel={() => setEditing(null)}
                    />
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-neutral-200">{state.entry.label}</span>
                          <span className="block truncate font-mono text-xs text-neutral-500">
                            {state.entry.baseUrl}
                          </span>
                        </span>
                        <StatusBadge state={state} now={now} />
                      </div>
                      <div className="mt-2 flex items-center gap-1 text-xs">
                        <IconButton
                          label="Move up"
                          disabled={index === 0}
                          onClick={() => onMove(state.entry.id, -1)}
                        >
                          ↑
                        </IconButton>
                        <IconButton
                          label="Move down"
                          disabled={index === states.length - 1}
                          onClick={() => onMove(state.entry.id, 1)}
                        >
                          ↓
                        </IconButton>
                        <span className="flex-1" />
                        <button
                          className="rounded px-2 py-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
                          onClick={() => setEditing(state.entry)}
                        >
                          Edit
                        </button>
                        {confirmRemove === state.entry.id ? (
                          <button
                            className="rounded bg-red-900/60 px-2 py-1 text-red-200 hover:bg-red-900"
                            onClick={() => {
                              onRemove(state.entry.id);
                              setConfirmRemove(null);
                            }}
                          >
                            Really remove?
                          </button>
                        ) : (
                          <button
                            className="rounded px-2 py-1 text-neutral-400 hover:bg-neutral-800 hover:text-red-400"
                            onClick={() => setConfirmRemove(state.entry.id)}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                      {state.status === "ok" && state.health && (
                        <p className="mt-2 text-xs text-neutral-600">
                          {state.health.hostLabel} · {state.health.platform} · v{state.health.version} ·{" "}
                          {state.health.sessionCount} session
                          {state.health.sessionCount === 1 ? "" : "s"}
                        </p>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>

            {editing === "new" ? (
              <div className="mt-2 rounded border border-neutral-800 bg-neutral-900/50 p-3">
                <HostSetup
                  onSave={(entry) => {
                    onSave(entry);
                    setEditing(null);
                  }}
                  onCancel={() => setEditing(null)}
                />
              </div>
            ) : (
              <button
                className="mt-2 w-full rounded border border-dashed border-neutral-700 py-2 text-sm text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
                onClick={() => setEditing("new")}
              >
                Add host
              </button>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-xs uppercase tracking-wide text-neutral-500">Agents</h3>
            <AgentsEditor states={states} configs={configs} onSaved={onAgentsSaved} />
          </section>

          <section>
            <h3 className="mb-2 text-xs uppercase tracking-wide text-neutral-500">This client</h3>
            <label className="block">
              <span className="mb-1 block text-xs text-neutral-500">
                Name shown to other clients when taking over a session
              </span>
              <input
                className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 outline-none focus:border-neutral-500"
                value={clientLabel}
                onChange={(e) => {
                  onClientLabelChange(e.target.value);
                  setClientLabel(e.target.value);
                }}
              />
            </label>
          </section>
          <JobsConnection url={jobs.url} status={jobs.status} onSave={jobs.save} />
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ state, now }: { state: HostState; now: number }) {
  if (state.status === "ok") return <span className="text-xs text-emerald-400">online</span>;
  if (state.status === "checking") return <span className="text-xs text-neutral-500">checking…</span>;
  if (state.status === "unauthorized") return <span className="text-xs text-red-400">token rejected</span>;
  return (
    <span className="text-xs text-neutral-500">
      offline{state.lastSeenAt !== null && ` · ${relativeTime(state.lastSeenAt, now)}`}
    </span>
  );
}

function IconButton({
  children,
  label,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded px-2 py-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
