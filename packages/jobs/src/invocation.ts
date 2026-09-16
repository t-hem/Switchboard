import { AppError } from "./errors.js";

/**
 * Jobs-owned invocation adapter: the only place that knows a specific agent CLI's flags.
 * The host daemon receives a literal argv (via `extraArgs`); it never interprets a persona.
 * A real run must pass the task file through argv and read a structured result from a
 * jobs-owned output file — a model name written inside prompt text is not model selection.
 */
export type InvocationRequest = {
  taskFilePath: string;
  resultPath: string;
  model: string;
  tools: string[];
  /** Optional jobs-owned tool bridge loaded by the CLI (extension file or equivalent). */
  bridgePath?: string;
  thinking?: string;
};
export type Invocation = { argv: string[]; resultPath: string };
export type InvocationCapabilities = {
  nonInteractive: boolean; structuredOutput: boolean; taskFile: boolean; toolAllowlist: boolean; resultFile: boolean;
};
export interface AgentInvocationAdapter {
  readonly id: string;
  readonly version: string;
  readonly capabilities: InvocationCapabilities;
  build(request: InvocationRequest): Invocation;
  /** Last-resort stdout parse; a valid jobs-owned result file always takes precedence. */
  parse(stdout: string): unknown;
}

const MODEL_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:/-]+$/;

/**
 * `pi` one-shot invocation. Verified flag surface: `--model <provider/id>`, `--mode json`,
 * `--print`, `--no-session`, `--tools <allowlist>`, `--extension <path>`, `@<file>`, `--thinking`.
 * The exact JSON envelope of `--mode json` still needs a real smoke run (see docs).
 */
export class PiInvocationAdapter implements AgentInvocationAdapter {
  readonly id = "pi";
  readonly version = "1";
  readonly capabilities: InvocationCapabilities = { nonInteractive: true, structuredOutput: true, taskFile: true, toolAllowlist: true, resultFile: true };
  build(request: InvocationRequest): Invocation {
    if (!MODEL_PATTERN.test(request.model)) throw new AppError("invalid_model", "Model must be a provider/model id such as openrouter/deepseek/deepseek-v4.1-flash");
    if (!request.taskFilePath.startsWith("/")) throw new AppError("invalid_invocation", "Task file path must be absolute");
    if (request.tools.some(tool => !/^[a-z0-9_]+$/.test(tool))) throw new AppError("invalid_invocation", "Tool names must be simple identifiers");
    const argv = ["--model", request.model, "--mode", "json", "--no-session", "--print"];
    if (request.thinking) argv.push("--thinking", request.thinking);
    if (request.bridgePath) argv.push("--extension", request.bridgePath);
    if (request.tools.length) argv.push("--tools", request.tools.join(","));
    // The task file carries persona + skills + task; the result path is stated inside it.
    argv.push(`@${request.taskFilePath}`);
    return { argv, resultPath: request.resultPath };
  }
  parse(stdout: string): unknown {
    const trimmed = stdout.trim();
    if (!trimmed) throw new AppError("invalid_agent_output", "Agent produced no output");
    const candidates = [trimmed, ...[...trimmed.split(/\r?\n/)].reverse()];
    for (const candidate of candidates) {
      try { const value = JSON.parse(candidate); if (value && typeof value === "object") return value; }
      catch { /* try the next candidate */ }
    }
    throw new AppError("invalid_agent_output", "Agent output contained no JSON object");
  }
}

const factories = new Map<string, () => AgentInvocationAdapter>();
export function registerInvocationAdapter(id: string, factory: () => AgentInvocationAdapter): void { factories.set(id, factory); }
export function createInvocationAdapter(id: string): AgentInvocationAdapter {
  const factory = factories.get(id);
  if (!factory) throw new AppError("unknown_invocation_adapter", `No invocation adapter ${id}`);
  return factory();
}
export function invocationAdapterIds(): string[] { return [...factories.keys()].sort(); }
registerInvocationAdapter("pi", () => new PiInvocationAdapter());
