import { AppError } from "../errors.js";

export type SpawnerSession = {id:string; state:"running"|"exited"; label:string; recovery?:string};
/** Observation contract first. Creation/attempt fencing lands with its worker caller in step 7. */
export interface AgentSpawner {
  readonly provider: string;
  health(signal?: AbortSignal): Promise<{available:boolean}>;
  list(signal?: AbortSignal): Promise<SpawnerSession[]>;
  inspect(id:string, signal?:AbortSignal): Promise<SpawnerSession|null>;
}
export type SpawnerOptions = {baseUrl:string; token:string};
export type SpawnerConstructor = (options:SpawnerOptions) => AgentSpawner;

export class SwitchboardSpawner implements AgentSpawner {
  readonly provider = "switchboard";
  constructor(private readonly options: SpawnerOptions, private readonly request: typeof fetch = fetch) {
    const url = new URL(options.baseUrl);
    if (!["http:","https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new AppError("invalid_provider_config","Spawner URL must be an HTTP(S) base URL without credentials/query/fragment");
    if (!options.token) throw new AppError("missing_secret","Spawner credentials have not been configured");
  }
  async #get(route:string, signal?:AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(5000);
    let response: Response;
    try {
      response = await this.request(this.options.baseUrl.replace(/\/$/, "")+route, {
        headers:{Authorization:`Bearer ${this.options.token}`},
        signal:signal ? AbortSignal.any([signal,timeout]) : timeout,
        redirect:"error",
      });
    } catch { throw new AppError("spawner_unavailable","Spawner request failed or was cancelled",503); }
    if (response.status === 404) return null;
    if (!response.ok) throw new AppError(response.status===401?"spawner_auth":"spawner_unavailable","Spawner rejected the request",503);
    try { return await response.json(); } catch { throw new AppError("spawner_protocol","Invalid spawner response",502); }
  }
  async health(signal?:AbortSignal): Promise<{available:boolean}> {
    const value = await this.#get("/health", signal);
    if (!value || typeof value!=="object" || !("sessionCount" in value)) throw new AppError("spawner_protocol","Invalid spawner health response",502);
    return {available:true};
  }
  async list(signal?:AbortSignal): Promise<SpawnerSession[]> {
    const value = await this.#get("/sessions", signal);
    if (!Array.isArray(value)) throw new AppError("spawner_protocol","Invalid session inventory",502);
    return value.map(normalizeSession);
  }
  async inspect(id:string, signal?:AbortSignal): Promise<SpawnerSession|null> {
    const value = await this.#get(`/sessions/${encodeURIComponent(id)}`, signal);
    return value === null ? null : normalizeSession(value);
  }
}
function normalizeSession(value:unknown): SpawnerSession {
  if (!value || typeof value!=="object") throw new AppError("spawner_protocol","Invalid session",502);
  const row = value as Record<string,unknown>;
  if (typeof row["id"]!=="string" || typeof row["label"]!=="string" || !["running","exited"].includes(String(row["status"]))) throw new AppError("spawner_protocol","Invalid session",502);
  return {id:row["id"],label:row["label"],state:row["status"] as "running"|"exited",
    ...(typeof row["recovery"]==="string"?{recovery:row["recovery"]}:{})};
}
export function createSpawner(provider:string, options:SpawnerOptions,
  providers:Readonly<Record<string,SpawnerConstructor>> = {switchboard:opts=>new SwitchboardSpawner(opts)}): AgentSpawner {
  if (!Object.hasOwn(providers,provider)) throw new AppError("unknown_provider",`Unknown spawner provider: ${provider}`);
  return providers[provider]!(options);
}
