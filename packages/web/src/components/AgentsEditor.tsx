import { useEffect, useMemo, useState } from "react";

import { api } from "../api/client.ts";
import type { AgentDef, AgentsConfigResponse, HostState } from "../types.ts";

const INPUT =
  "w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 outline-none focus:border-neutral-500";

/**
 * Edits the fleet-wide agents map. The daemons are the source of truth, so this
 * never writes to localStorage: saving PUTs to the chosen host with a fresh
 * updatedAt, and the drift banner then offers to propagate it to the rest.
 */
export function AgentsEditor({
  states,
  configs,
  onSaved,
}: {
  states: HostState[];
  configs: Map<string, AgentsConfigResponse>;
  onSaved: () => void;
}) {
  const reachable = states.filter((s) => s.status === "ok");
  const [targetId, setTargetId] = useState(reachable[0]?.entry.id ?? "");
  const target = reachable.find((s) => s.entry.id === targetId) ?? reachable[0];
  const config = target ? configs.get(target.entry.id) : undefined;

  const [draft, setDraft] = useState<Record<string, AgentDef>>({});
  const [raw, setRaw] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reload the draft whenever the fetched config changes...
  useEffect(() => {
    if (config) setDraft(structuredClone(config.agents));
  }, [config]);

  // ...but only clear the result message when the edit target changes. Saving
  // triggers a refetch, so clearing on every config change would wipe the
  // "Saved to X" confirmation the instant it appeared.
  useEffect(() => {
    setRaw(null);
    setError(null);
    setStatus(null);
  }, [target?.entry.id]);

  const dirty = useMemo(
    () => config !== undefined && JSON.stringify(draft) !== JSON.stringify(config.agents),
    [draft, config],
  );

  const update = (name: string, patch: Partial<AgentDef>): void =>
    setDraft((prev) => ({ ...prev, [name]: { ...prev[name], ...patch } as AgentDef }));

  const rename = (from: string, to: string): void =>
    setDraft((prev) => {
      if (!to.trim() || to === from || prev[to]) return prev;
      const next: Record<string, AgentDef> = {};
      for (const [k, v] of Object.entries(prev)) next[k === from ? to : k] = v;
      return next;
    });

  const remove = (name: string): void =>
    setDraft((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== name)));

  const add = (): void =>
    setDraft((prev) => {
      let name = "new-agent";
      let n = 1;
      while (prev[name]) name = `new-agent-${++n}`;
      return { ...prev, [name]: { cmd: "", args: [] } };
    });

  const save = async (): Promise<void> => {
    if (!target) return;
    setError(null);
    let agents = draft;
    if (raw !== null) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("expected a JSON object of agent name → definition");
        }
        agents = parsed as Record<string, AgentDef>;
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "invalid JSON");
        return;
      }
    }
    try {
      // A fresh stamp is what makes this map win last-write-wins on the other hosts.
      await api.putAgentsConfig(target.entry, { updatedAt: Date.now(), agents });
      setStatus(`Saved to ${target.entry.label}.`);
      setRaw(null);
      onSaved();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "could not save");
    }
  };

  if (!target) return <p className="text-sm text-neutral-500">No reachable host to read the agent config from.</p>;
  if (!config) return <p className="text-sm text-neutral-500">Loading agent config…</p>;

  return (
    <div className="space-y-3">
      {reachable.length > 1 && (
        <label className="block">
          <span className="mb-1 block text-xs text-neutral-500">Edit against</span>
          <select className={INPUT} value={target.entry.id} onChange={(e) => setTargetId(e.target.value)}>
            {reachable.map((s) => (
              <option key={s.entry.id} value={s.entry.id}>
                {s.entry.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {raw === null ? (
        <ul className="space-y-2" aria-label="Configured agents">
          {Object.entries(draft).map(([name, def]) => (
            <AgentRow
              key={name}
              name={name}
              def={def}
              available={config.availability[name] ?? false}
              hostLabel={target.entry.label}
              onRename={(to) => rename(name, to)}
              onChange={(patch) => update(name, patch)}
              onRemove={() => remove(name)}
            />
          ))}
        </ul>
      ) : (
        <textarea
          className={`${INPUT} h-72 font-mono text-xs`}
          value={raw}
          spellCheck={false}
          onChange={(e) => setRaw(e.target.value)}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        {raw === null && (
          <button
            className="rounded border border-dashed border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
            onClick={add}
          >
            Add agent
          </button>
        )}
        <button
          className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200"
          onClick={() => setRaw(raw === null ? JSON.stringify(draft, null, 2) : null)}
        >
          {raw === null ? "Edit as JSON" : "Back to form"}
        </button>
        <span className="flex-1" />
        <button
          className="rounded bg-neutral-200 px-3 py-1 text-xs font-medium text-neutral-900 hover:bg-white disabled:opacity-40"
          onClick={() => void save()}
          disabled={raw === null && !dirty}
        >
          Save to {target.entry.label}
        </button>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {status && <p className="text-sm text-emerald-400">{status}</p>}
      <p className="text-xs text-neutral-600">
        Availability is probed per machine and never synced — an agent can exist here and be
        missing elsewhere. Keep <code className="text-neutral-500">cmd</code> a bare command; a
        machine-specific path belongs in that host&apos;s <code className="text-neutral-500">host.json</code>.
      </p>
    </div>
  );
}

function AgentRow({
  name,
  def,
  available,
  hostLabel,
  onRename,
  onChange,
  onRemove,
}: {
  name: string;
  def: AgentDef;
  available: boolean;
  hostLabel: string;
  onRename: (to: string) => void;
  onChange: (patch: Partial<AgentDef>) => void;
  onRemove: () => void;
}) {
  const [localName, setLocalName] = useState(name);
  useEffect(() => setLocalName(name), [name]);

  return (
    <li className="rounded border border-neutral-800 bg-neutral-900/50 p-2">
      <div className="flex items-center gap-2">
        <input
          className={`${INPUT} font-medium`}
          value={localName}
          onChange={(e) => setLocalName(e.target.value)}
          onBlur={() => onRename(localName.trim())}
        />
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${
            available ? "bg-emerald-900/50 text-emerald-300" : "bg-neutral-800 text-neutral-400"
          }`}
        >
          {available ? "installed" : `not on ${hostLabel}`}
        </span>
        <button
          className="shrink-0 rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-red-400"
          onClick={onRemove}
        >
          ✕
        </button>
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <LabelledSmall label="cmd">
          <input className={INPUT} value={def.cmd} spellCheck={false} onChange={(e) => onChange({ cmd: e.target.value })} />
        </LabelledSmall>
        <LabelledSmall label="args (JSON array)">
          <ArgsInput args={def.args ?? []} onChange={(args) => onChange({ args })} />
        </LabelledSmall>
      </div>

      <LabelledSmall label="install hint (shown, never run)">
        <input
          className={INPUT}
          value={def.install ?? ""}
          spellCheck={false}
          placeholder="npm i -g …"
          onChange={(e) => onChange({ install: e.target.value || undefined })}
        />
      </LabelledSmall>

      {!available && def.install && <InstallHint command={def.install} hostLabel={hostLabel} />}

      {def.platform && (
        <p className="mt-1 text-[11px] text-neutral-600">
          Has platform overrides ({Object.keys(def.platform).join(", ")}) — preserved on save; use
          JSON mode to edit them.
        </p>
      )}
    </li>
  );
}

/** Args are edited as JSON so a value containing spaces survives a round trip. */
function ArgsInput({ args, onChange }: { args: string[]; onChange: (args: string[]) => void }) {
  const [text, setText] = useState(() => JSON.stringify(args));
  const [bad, setBad] = useState(false);
  useEffect(() => setText(JSON.stringify(args)), [args]);
  return (
    <>
      <input
        className={`${INPUT} font-mono ${bad ? "border-red-600" : ""}`}
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const parsed: unknown = JSON.parse(e.target.value);
            if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
              setBad(false);
              onChange(parsed as string[]);
            } else setBad(true);
          } catch {
            setBad(true);
          }
        }}
      />
      {bad && <span className="text-[11px] text-red-400">must be a JSON array of strings</span>}
    </>
  );
}

/** The gap between "configured" and "installed" is unavoidable; make it one paste. */
function InstallHint({ command, hostLabel }: { command: string; hostLabel: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex items-center gap-2 rounded bg-neutral-950 p-2">
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-300">{command}</code>
      <button
        className="shrink-0 rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800"
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => setCopied(false),
          );
        }}
        title={`Run this on ${hostLabel}`}
      >
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}

function LabelledSmall({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mt-2 block">
      <span className="mb-0.5 block text-[11px] text-neutral-500">{label}</span>
      {children}
    </label>
  );
}
