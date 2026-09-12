import { availabilityMap, probeAgents } from "./availability.js";
import { loadAgentsConfig, resolveAgent, writeAgentsConfig } from "./config.js";
import { agentEnv } from "./env.js";
import type { AgentsConfig, HostConfig, ResolvedAgent } from "./types.js";

/**
 * The in-memory view of agents.json plus this machine's availability probe.
 * Reloadable in place: changing agents.json never requires a daemon restart
 * and never touches running sessions.
 */
/**
 * How stale an availability probe may get before the next read refreshes it.
 *
 * The spec probes on startup and on every agents.json write, but that alone cannot
 * satisfy its own acceptance criterion: installing a missing CLI should flip the
 * agent to available *without a daemon restart*, and installing writes no config.
 * A short TTL makes an install visible on its own while bounding the cost to one
 * PATH scan per interval however often availability is read.
 */
const PROBE_TTL_MS = 10_000;

export class AgentRegistry {
  #config: AgentsConfig;
  #probe: Map<string, string | null>;
  #probedAt = 0;
  /** Snapshot of the agent env (host.json `env` + `pathPrepend` over process.env). */
  readonly #env: NodeJS.ProcessEnv;

  private constructor(config: AgentsConfig, env: NodeJS.ProcessEnv) {
    this.#config = config;
    this.#env = env;
    this.#probe = probeAgents(config, env);
    this.#probedAt = Date.now();
  }

  static load(hostConfig: HostConfig): AgentRegistry {
    return new AgentRegistry(loadAgentsConfig(), agentEnv(hostConfig));
  }

  /** The environment agent PTYs are spawned with. */
  get env(): NodeJS.ProcessEnv {
    return this.#env;
  }

  get config(): AgentsConfig {
    return this.#config;
  }

  get availability(): Record<string, boolean> {
    this.#refreshIfStale();
    return availabilityMap(this.#probe);
  }

  list(): { name: string; available: boolean }[] {
    this.#refreshIfStale();
    return [...this.#probe.entries()].map(([name, resolvedPath]) => ({
      name,
      available: resolvedPath !== null,
    }));
  }

  /** The absolute path to an agent's binary, or null if it isn't installed here. */
  executablePath(name: string): string | null {
    this.#refreshIfStale();
    return this.#probe.get(name) ?? null;
  }

  #refreshIfStale(): void {
    if (Date.now() - this.#probedAt > PROBE_TTL_MS) this.reprobe();
  }

  resolved(name: string): ResolvedAgent | null {
    const def = this.#config.agents[name];
    return def ? resolveAgent(def) : null;
  }

  /** Re-run the PATH probe without re-reading the file. */
  reprobe(): void {
    this.#probe = probeAgents(this.#config, this.#env);
    this.#probedAt = Date.now();
  }

  /** Replace the map from a PUT /config/agents, persist it, and re-probe. */
  replace(config: AgentsConfig): void {
    this.#config = config;
    writeAgentsConfig(config);
    this.reprobe();
  }
}
