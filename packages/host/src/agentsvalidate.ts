import type { AgentDef, AgentsConfig } from "./types.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Validate an incoming agents map before it is written.
 *
 * agents.json is replicated across the fleet, so a malformed map does not just break
 * this daemon — it propagates. Rejecting at the door is cheaper than reasoning about
 * half-written config on three machines.
 */
export function parseAgentsPayload(body: unknown): { ok: true; value: AgentsConfig } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: "body must be an object" };
  if (!isRecord(body["agents"])) return { ok: false, error: "`agents` must be an object" };

  const updatedAtRaw = body["updatedAt"];
  if (updatedAtRaw !== undefined && typeof updatedAtRaw !== "number") {
    return { ok: false, error: "`updatedAt` must be a number of epoch milliseconds" };
  }

  const agents: Record<string, AgentDef> = {};
  for (const [name, raw] of Object.entries(body["agents"])) {
    if (!name.trim()) return { ok: false, error: "agent names cannot be empty" };
    if (!isRecord(raw)) return { ok: false, error: `agent "${name}" must be an object` };
    if (typeof raw["cmd"] !== "string" || !raw["cmd"].trim()) {
      return { ok: false, error: `agent "${name}" needs a non-empty "cmd"` };
    }
    if (raw["args"] !== undefined && !isStringArray(raw["args"])) {
      return { ok: false, error: `agent "${name}": "args" must be an array of strings` };
    }
    if (raw["install"] !== undefined && typeof raw["install"] !== "string") {
      return { ok: false, error: `agent "${name}": "install" must be a string` };
    }

    const def: AgentDef = { cmd: raw["cmd"] };
    if (raw["args"] !== undefined) def.args = raw["args"];
    if (raw["install"] !== undefined) def.install = raw["install"];

    if (raw["platform"] !== undefined) {
      if (!isRecord(raw["platform"])) {
        return { ok: false, error: `agent "${name}": "platform" must be an object` };
      }
      const platform: NonNullable<AgentDef["platform"]> = {};
      for (const [key, override] of Object.entries(raw["platform"])) {
        if (!isRecord(override)) {
          return { ok: false, error: `agent "${name}": platform.${key} must be an object` };
        }
        if (override["cmd"] !== undefined && typeof override["cmd"] !== "string") {
          return { ok: false, error: `agent "${name}": platform.${key}.cmd must be a string` };
        }
        if (override["args"] !== undefined && !isStringArray(override["args"])) {
          return { ok: false, error: `agent "${name}": platform.${key}.args must be an array of strings` };
        }
        platform[key] = {
          ...(override["cmd"] !== undefined ? { cmd: override["cmd"] } : {}),
          ...(override["args"] !== undefined ? { args: override["args"] } : {}),
        };
      }
      def.platform = platform;
    }

    agents[name] = def;
  }

  return { ok: true, value: { updatedAt: typeof updatedAtRaw === "number" ? updatedAtRaw : Date.now(), agents } };
}
