import { useRef } from "react";

import { useTerminal, type ConnectionState } from "../hooks/useTerminal.ts";
import { MobileInputBar } from "./MobileInputBar.tsx";
import type { HostEntry, Session } from "../types.ts";

const CONNECTION_LABEL: Record<ConnectionState, { text: string; className: string }> = {
  connecting: { text: "connecting", className: "text-neutral-400" },
  connected: { text: "connected", className: "text-emerald-400" },
  reconnecting: { text: "reconnecting…", className: "text-amber-400" },
  exited: { text: "session exited", className: "text-neutral-500" },
  evicted: { text: "taken over", className: "text-amber-400" },
  locked: { text: "locked by another client", className: "text-amber-400" },
  gone: { text: "session gone", className: "text-neutral-500" },
};

export function TerminalView({
  entry,
  session,
  clientId,
  clientLabel,
  onBack,
  onEvicted,
  onTakeOver,
}: {
  entry: HostEntry;
  session: Session;
  clientId: string;
  clientLabel: string;
  onBack: () => void;
  onEvicted: (reason: string) => void;
  onTakeOver: () => void;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const term = useTerminal({ entry, sessionId: session.id, container, clientId, clientLabel, onEvicted });
  const status = CONNECTION_LABEL[term.state];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <button
          onClick={onBack}
          className="rounded px-1.5 py-0.5 text-sm text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 md:hidden"
        >
          ‹ Back
        </button>
        <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">{session.label}</span>
        <span className="hidden shrink-0 text-xs text-neutral-600 sm:inline">
          {entry.label} · {session.cols}×{session.rows}
        </span>
        <span className={`shrink-0 text-xs ${status.className}`}>{status.text}</span>
      </header>

      {term.state === "locked" && (
        <div className="flex items-center gap-3 border-b border-amber-900/50 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
          <span className="flex-1">
            {term.lockedBy ? `${term.lockedBy} holds this host.` : "Another client holds this host."} Reconnecting
            cannot help until you take it back.
          </span>
          <button
            className="shrink-0 rounded border border-amber-700/60 px-2 py-0.5 hover:bg-amber-900/40"
            onClick={onTakeOver}
          >
            Take over
          </button>
        </div>
      )}

      {term.state === "exited" && (
        <div className="border-b border-neutral-800 bg-neutral-900/60 px-3 py-2 text-sm text-neutral-400">
          Session exited{term.exitCode !== null ? ` with code ${term.exitCode}` : ""}. Scrollback below is
          the last thing it printed.
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden bg-[#0b0d10] p-1">
        <div ref={container} className="h-full w-full" />
      </div>

      {/* Phone only: on a desktop the real keyboard is already the better input. */}
      <div className="md:hidden">
        <MobileInputBar send={term.send} disabled={term.state !== "connected"} />
      </div>
    </div>
  );
}
