import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentDef, AgentsConfig, HostConfig, ResolvedAgent } from "./types.js";

/** Config lives in ~/.switchboard unless SWITCHBOARD_DIR overrides it (used by tests). */
export function configDir(): string {
  return process.env.SWITCHBOARD_DIR ?? path.join(os.homedir(), ".switchboard");
}

export const HOST_CONFIG_FILE = "host.json";
export const AGENTS_CONFIG_FILE = "agents.json";

const DEFAULT_PORT = 7777;
const DEFAULT_SCROLLBACK_BYTES = 262144;

function defaultWorkspaceRoots(): string[] {
  if (process.platform === "win32") return ["C:\\dev", "C:\\projects"];
  const home = os.homedir();
  return [path.join(home, "dev"), path.join(home, "projects")];
}

function defaultAgents(): AgentsConfig {
  return {
    updatedAt: Date.now(),
    agents: {
      claude: { cmd: "claude", args: [] },
      codex: { cmd: "codex", args: [] },
      pi: { cmd: "pi", args: [], platform: { win32: { cmd: "pi.cmd" } } },
      gemini: { cmd: "gemini", args: [], install: "npm i -g @google/gemini-cli" },
    },
  };
}

/** Write JSON via a temp file + rename so a crash mid-write can't truncate the config. */
function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Load host.json, creating it with generated defaults on first run.
 * Returns the config plus whether the token was freshly generated, so the
 * caller can print it exactly once.
 */
export function loadHostConfig(): { config: HostConfig; created: boolean } {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, HOST_CONFIG_FILE);

  if (!fs.existsSync(file)) {
    const config: HostConfig = {
      port: DEFAULT_PORT,
      token: randomBytes(24).toString("base64url"),
      hostLabel: os.hostname(),
      scrollbackBytes: DEFAULT_SCROLLBACK_BYTES,
      workspaceRoots: defaultWorkspaceRoots(),
      pathPrepend: [],
      env: {},
    };
    writeJsonAtomic(file, config);
    return { config, created: true };
  }

  const raw = readJson(file);
  if (!isRecord(raw)) throw new Error(`${file} is not a JSON object`);

  const token = typeof raw["token"] === "string" && raw["token"] ? raw["token"] : null;
  if (!token) throw new Error(`${file} has no "token" — delete the file to regenerate it`);

  return {
    config: {
      port: typeof raw["port"] === "number" ? raw["port"] : DEFAULT_PORT,
      token,
      hostLabel: typeof raw["hostLabel"] === "string" ? raw["hostLabel"] : os.hostname(),
      scrollbackBytes:
        typeof raw["scrollbackBytes"] === "number" ? raw["scrollbackBytes"] : DEFAULT_SCROLLBACK_BYTES,
      workspaceRoots: Array.isArray(raw["workspaceRoots"])
        ? raw["workspaceRoots"].filter((r): r is string => typeof r === "string")
        : defaultWorkspaceRoots(),
      pathPrepend: Array.isArray(raw["pathPrepend"])
        ? raw["pathPrepend"].filter((r): r is string => typeof r === "string")
        : [],
      env: isRecord(raw["env"])
        ? Object.fromEntries(
            Object.entries(raw["env"]).filter((e): e is [string, string] => typeof e[1] === "string"),
          )
        : {},
    },
    created: false,
  };
}

/** Load agents.json, creating it with defaults on first run. */
export function loadAgentsConfig(): AgentsConfig {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, AGENTS_CONFIG_FILE);

  if (!fs.existsSync(file)) {
    const config = defaultAgents();
    writeJsonAtomic(file, config);
    return config;
  }

  const raw = readJson(file);
  if (!isRecord(raw)) throw new Error(`${file} is not a JSON object`);
  const agents = isRecord(raw["agents"]) ? (raw["agents"] as Record<string, AgentDef>) : {};
  return {
    updatedAt: typeof raw["updatedAt"] === "number" ? raw["updatedAt"] : 0,
    agents,
  };
}

/** Persist agents.json verbatim. `updatedAt` is stamped by the caller. */
export function writeAgentsConfig(config: AgentsConfig): void {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(path.join(dir, AGENTS_CONFIG_FILE), config);
}

/** Merge an agent's `platform[process.platform]` block over its base definition. */
export function resolveAgent(def: AgentDef, platform: NodeJS.Platform = process.platform): ResolvedAgent {
  const override = def.platform?.[platform];
  const resolved: ResolvedAgent = {
    cmd: override?.cmd ?? def.cmd,
    args: override?.args ?? def.args ?? [],
  };
  if (def.install !== undefined) resolved.install = def.install;
  return resolved;
}
