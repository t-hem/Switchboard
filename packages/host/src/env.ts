import type { HostConfig } from "./types.js";

/**
 * Find the PATH key as it actually appears in an env object. Windows env var
 * names are case-insensitive and `process.env` there is usually spelled "Path",
 * so writing a fresh "PATH" key would leave two of them and silently lose.
 */
export function pathKey(env: NodeJS.ProcessEnv): string {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "PATH") return key;
  }
  return "PATH";
}

export function pathSeparator(): string {
  return process.platform === "win32" ? ";" : ":";
}

/**
 * The environment agents are probed and spawned with: the daemon's own env,
 * plus host.json's `env` overrides, plus `pathPrepend` directories in front of PATH.
 *
 * This is machine-local by design. `agents.json` is synced across the fleet, so it
 * must only ever name a bare command (`"cmd": "claude"`); anything machine-specific
 * — an nvm bin directory, a Windows drive path — belongs here, in host.json.
 */
export function agentEnv(config: HostConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...config.env };
  if (config.pathPrepend.length > 0) {
    const key = pathKey(env);
    env[key] = [...config.pathPrepend, env[key] ?? ""].filter(Boolean).join(pathSeparator());
  }
  return env;
}

export function envPath(env: NodeJS.ProcessEnv): string {
  return env[pathKey(env)] ?? "";
}
