import fs from "node:fs";
import path from "node:path";

import { resolveAgent } from "./config.js";
import { envPath, pathSeparator } from "./env.js";
import type { AgentsConfig } from "./types.js";

function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
  } catch {
    return false;
  }
  if (process.platform === "win32") return true;
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  return (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
}

/**
 * A `which` / `where` lookup done in-process: resolve `cmd` against the PATH of the
 * given agent environment and return its absolute path, or null if it isn't installed
 * on this machine. Resolving inline rather than shelling out keeps it fast (it reruns
 * on every agents.json write) and gives identical semantics on Windows and POSIX.
 */
export function lookupExecutable(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!cmd) return null;

  const candidateNames =
    process.platform === "win32" && !path.extname(cmd)
      ? windowsExtensions(env).map((ext) => cmd + ext)
      : [cmd];

  // An explicit path (relative or absolute) is never resolved against PATH.
  if (cmd.includes("/") || cmd.includes("\\")) {
    for (const name of candidateNames) {
      const abs = path.resolve(name);
      if (isExecutableFile(abs)) return abs;
    }
    return null;
  }

  const dirs = envPath(env).split(pathSeparator()).filter(Boolean);
  if (process.platform === "win32") dirs.unshift(process.cwd());

  for (const dir of dirs) {
    for (const name of candidateNames) {
      if (isExecutableFile(path.join(dir.replace(/^"|"$/g, ""), name))) {
        return path.join(dir.replace(/^"|"$/g, ""), name);
      }
    }
  }
  return null;
}

/** Resolve every configured agent to its binary path on this machine. */
export function probeAgents(config: AgentsConfig, env: NodeJS.ProcessEnv): Map<string, string | null> {
  const result = new Map<string, string | null>();
  for (const [name, def] of Object.entries(config.agents)) {
    result.set(name, lookupExecutable(resolveAgent(def).cmd, env));
  }
  return result;
}

export function availabilityMap(probe: Map<string, string | null>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [name, resolvedPath] of probe) out[name] = resolvedPath !== null;
  return out;
}
