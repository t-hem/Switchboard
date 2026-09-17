/** Shapes shared by the daemon and (by copy) the web client. */

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
  /**
   * Read out of the rendered scrollback with the agent's own `display` patterns and
   * attached per response — never persisted, never acted on. Absent when nothing
   * matched, which is the normal case for an agent with no patterns configured.
   */
  model?: string;
  title?: string;
  /**
   * Generic, caller-supplied creation key. A second POST /sessions with the same key
   * returns this session instead of spawning another one. Persisted with the session
   * metadata so it survives a daemon restart on persistent backends.
   */
  idempotencyKey?: string | null;
};

/** Per-platform override block, keyed by `process.platform`. */
export type AgentPlatformOverride = {
  cmd?: string;
  args?: string[];
};

export type AgentDef = {
  cmd: string;
  args?: string[];
  /** Display-only install hint. The daemon never executes this. */
  install?: string;
  platform?: Record<string, AgentPlatformOverride>;
  /**
   * Cosmetic patterns matched against rendered scrollback (spec §2). Capture group 1
   * wins if present, else the whole match. Keeping these here is what lets a new agent
   * remain a config line; they are about the agent, not the machine, so they sync.
   */
  display?: { model?: string; title?: string };
};

/** An AgentDef with its `platform` block already merged in for this machine. */
export type ResolvedAgent = {
  cmd: string;
  args: string[];
  install?: string;
};

export type AgentsConfig = {
  updatedAt: number;
  agents: Record<string, AgentDef>;
};

export type HostConfig = {
  port: number;
  token: string;
  hostLabel: string;
  scrollbackBytes: number;
  workspaceRoots: string[];
  /** Directories prepended to PATH when probing and spawning agents. Machine-local. */
  pathPrepend: string[];
  /** Extra environment variables for spawned agents. Machine-local. */
  env: Record<string, string>;
  sessionBackend?: "direct" | "tmux";
  tmux?: { socketPath: string; ownerId: string };
};

export type HealthResponse = {
  hostLabel: string;
  platform: NodeJS.Platform;
  version: string;
  agents: { name: string; available: boolean }[];
  sessionCount: number;
  /** Which backend this host spawns into. A display fact about the host, so the
   *  client can say it once per host instead of inferring it from each session. */
  sessionBackend: "direct" | "tmux";
};

export type AgentsConfigResponse = AgentsConfig & {
  availability: Record<string, boolean>;
};
