import { useState } from "react";

import { api, normaliseBaseUrl } from "../api/client.ts";
import { newHostEntry } from "../state/hosts.ts";
import type { HostEntry } from "../types.ts";

type Probe = { kind: "idle" | "checking" | "ok" | "unauthorized" | "offline"; detail?: string };

/**
 * Add or edit one host. Adding immediately probes /health so the difference between
 * "wrong address" and "wrong token" is visible before saving.
 */
export function HostSetup({
  existing,
  onSave,
  onCancel,
}: {
  existing?: HostEntry;
  onSave: (entry: HostEntry) => void;
  onCancel?: () => void;
}) {
  const [label, setLabel] = useState(existing?.label ?? "");
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? "");
  const [token, setToken] = useState(existing?.token ?? "");
  const [probe, setProbe] = useState<Probe>({ kind: "idle" });

  const candidate: HostEntry = existing
    ? { ...existing, label: label.trim(), baseUrl: baseUrl.trim(), token: token.trim() }
    : newHostEntry({ label: label.trim(), baseUrl: baseUrl.trim(), token: token.trim() });

  const test = async (): Promise<Probe> => {
    setProbe({ kind: "checking" });
    try {
      const health = await api.health(candidate);
      try {
        await api.sessions(candidate);
        const result: Probe = { kind: "ok", detail: `${health.hostLabel} · ${health.platform}` };
        setProbe(result);
        return result;
      } catch {
        const result: Probe = { kind: "unauthorized", detail: `reached ${health.hostLabel}` };
        setProbe(result);
        return result;
      }
    } catch (err: unknown) {
      const result: Probe = {
        kind: "offline",
        detail: err instanceof Error ? err.message : "unreachable",
      };
      setProbe(result);
      return result;
    }
  };

  const save = async (): Promise<void> => {
    const result = await test();
    // A rejected token is a definite, fixable mistake and must not be saved — it
    // would leave a permanently broken host entry. Being unreachable is not a
    // mistake: the machine may simply be asleep, so that entry is allowed through
    // and shows as offline until it comes back.
    if (result.kind === "unauthorized") return;
    onSave({
      ...candidate,
      label: candidate.label || new URL(normaliseBaseUrl(candidate.baseUrl)).hostname,
    });
  };

  const canSubmit = baseUrl.trim().length > 0 && token.trim().length > 0;

  return (
    <div className="space-y-3">
      <Labelled label="Label">
        <input
          className={INPUT}
          value={label}
          placeholder="desktop1"
          onChange={(e) => setLabel(e.target.value)}
        />
      </Labelled>
      <Labelled label="Address">
        <input
          className={INPUT}
          value={baseUrl}
          placeholder="http://desktop1:7777"
          spellCheck={false}
          autoCapitalize="none"
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </Labelled>
      <Labelled label="Token">
        <input
          className={`${INPUT} font-mono`}
          value={token}
          type="password"
          spellCheck={false}
          placeholder="from host.json"
          onChange={(e) => setToken(e.target.value)}
        />
      </Labelled>

      {probe.kind !== "idle" && <ProbeResult probe={probe} />}

      <div className="flex justify-end gap-2 pt-1">
        {onCancel && (
          <button className="rounded px-3 py-1.5 text-sm text-neutral-400 hover:text-neutral-200" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button
          className="rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
          onClick={() => void test()}
          disabled={!canSubmit || probe.kind === "checking"}
        >
          Test
        </button>
        <button
          className="rounded bg-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-40"
          onClick={() => void save()}
          disabled={!canSubmit || probe.kind === "checking"}
        >
          Save
        </button>
      </div>
    </div>
  );
}

function ProbeResult({ probe }: { probe: Probe }) {
  const map = {
    checking: ["text-neutral-400", "Checking…"],
    ok: ["text-emerald-400", "Reachable, token accepted"],
    unauthorized: ["text-red-400", "Reachable, but the token was rejected"],
    offline: ["text-red-400", "Could not reach this host"],
    idle: ["", ""],
  } as const;
  const [className, text] = map[probe.kind];
  return (
    <p className={`text-sm ${className}`}>
      {text}
      {probe.detail && <span className="text-neutral-500"> — {probe.detail}</span>}
    </p>
  );
}

const INPUT =
  "w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 outline-none focus:border-neutral-500";

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-wide text-neutral-500">{label}</span>
      {children}
    </label>
  );
}
