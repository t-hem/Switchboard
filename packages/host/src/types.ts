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
};

export type HealthResponse = {
  hostLabel: string;
  platform: NodeJS.Platform;
  version: string;
  agents: { name: string; available: boolean }[];
  sessionCount: number;
};

export type AgentsConfigResponse = AgentsConfig & {
  availability: Record<string, boolean>;
};
