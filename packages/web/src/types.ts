/** Mirrors packages/host/src/types.ts. Kept as a copy rather than a shared package:
 *  the client is a static bundle with no build-time link to any particular host. */

export type SessionStatus = "running" | "exited";

export type Session = {
  id: string;
  agent: string;
  cwd: string;
  label: string;
  status: SessionStatus;
  exitCode: number | null;
  pid: number;
  cols: number;
  rows: number;
  createdAt: number;
  lastOutputAt: number;
  backend?: "direct" | "tmux";
  recovery?: string;
  /** Best-effort, read from scrollback by the host's agents.json patterns. Often absent. */
  model?: string;
  title?: string;
};

export type AgentInfo = { name: string; available: boolean };

export type Health = {
  hostLabel: string;
  platform: string;
  version: string;
  agents: AgentInfo[];
  sessionCount: number;
  /** Optional: this bundle may be talking to a daemon older than the field. */
  sessionBackend?: "direct" | "tmux";
};

export type Orphan = {
  id: string;
  pid: number;
  agent: string;
  cwd: string;
  startedAt: number;
  processStartTime: string;
};

export type OrphanKillResult = {
  id: string;
  outcome: "killed" | "already-gone" | "pid-reused" | "unknown-session" | "failed";
  detail?: string;
};

export type AgentPlatformOverride = { cmd?: string; args?: string[] };

export type AgentDef = {
  cmd: string;
  args?: string[];
  /** Display-only. The daemon never runs this. */
  install?: string;
  platform?: Record<string, AgentPlatformOverride>;
  /** Cosmetic scrollback patterns; capture group 1 wins if present. */
  display?: { model?: string; title?: string };
};

export type AgentsConfig = {
  updatedAt: number;
  agents: Record<string, AgentDef>;
};

export type AgentsConfigResponse = AgentsConfig & {
  /** Per-host and never synced: the entry travels, the binary does not. */
  availability: Record<string, boolean>;
};

export type HostEntry = {
  id: string;
  label: string;
  baseUrl: string;
  token: string;
};

export type Claimant = { clientId: string; clientLabel: string; claimedAt: number };
export type ClaimResult = { claimant: Claimant; evicted: Claimant | null };

/** Why a host is not usable right now — the client must tell these apart. */
export type HostStatus = "ok" | "unauthorized" | "offline" | "checking";

export type HostState = {
  entry: HostEntry;
  status: HostStatus;
  health: Health | null;
  sessions: Session[];
  orphans: Orphan[];
  lastSeenAt: number | null;
  error: string | null;
};

/** A session paired with the host it lives on, for the merged cross-host list. */
export type SessionRef = { hostId: string; session: Session };
