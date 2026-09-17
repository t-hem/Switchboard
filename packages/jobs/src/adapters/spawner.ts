import { AppError } from "../errors.js";

export type SpawnerSession = {id:string; state:"running"|"exited"; label:string; recovery?:string; exitCode?:number|null};
export type SpawnerCreateRequest = {agent:string; cwd:string; label:string; extraArgs?:string[]; cols?:number; rows?:number};
/**
 * Observation contract first, plus optional control. Control is optional and checked
 * explicitly, so a caller learns it cannot spawn rather than pretending it can. Creation
 * here has no host-side idempotency key yet; a duplicate retry is therefore not safe and
 * is refused at the caller (see the plan's step 7c).
 */
export interface AgentSpawner {
  readonly provider: string;
  health(signal?: AbortSignal): Promise<{available:boolean}>;
  list(signal?: AbortSignal): Promise<SpawnerSession[]>;
  inspect(id:string, signal?:AbortSignal): Promise<SpawnerSession|null>;
  create?(request:SpawnerCreateRequest, signal?:AbortSignal): Promise<SpawnerSession>;
  stop?(id:string, signal?:AbortSignal): Promise<void>;
}
export function requireSpawnerControl(spawner:AgentSpawner): {create(request:SpawnerCreateRequest, signal?:AbortSignal):Promise<SpawnerSession>; stop(id:string, signal?:AbortSignal):Promise<void>} {
  if(!spawner.create||!spawner.stop)throw new AppError("spawner_capability","Configured spawner cannot create or stop sessions",409);
  return {create:spawner.create.bind(spawner),stop:spawner.stop.bind(spawner)};
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
  async create(request:SpawnerCreateRequest, signal?:AbortSignal): Promise<SpawnerSession> {
    const value = await this.#send("/sessions", "POST", {
      agent:request.agent, cwd:request.cwd, label:request.label,
      ...(request.extraArgs?.length?{extraArgs:request.extraArgs}:{}),
      ...(request.cols?{cols:request.cols}:{}), ...(request.rows?{rows:request.rows}:{}),
    }, signal);
    return normalizeSession(value);
  }
  async stop(id:string, signal?:AbortSignal): Promise<void> {
    await this.#send(`/sessions/${encodeURIComponent(id)}`, "DELETE", undefined, signal);
  }
  async #send(route:string, method:string, body:unknown, signal?:AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(15000);
    let response: Response;
    try {
      response = await this.request(this.options.baseUrl.replace(/\/$/, "")+route, {
        method, headers:{Authorization:`Bearer ${this.options.token}`,"Content-Type":"application/json"},
        body:body===undefined?undefined:JSON.stringify(body),
        signal:signal ? AbortSignal.any([signal,timeout]) : timeout, redirect:"error",
      });
    } catch { throw new AppError("spawner_unavailable","Spawner request failed or was cancelled",503); }
    if (!response.ok) throw new AppError(response.status===401?"spawner_auth":"spawner_rejected",`Spawner rejected the request (${response.status})`,503);
    if (response.status === 204) return null;
    try { return await response.json(); } catch { throw new AppError("spawner_protocol","Invalid spawner response",502); }
  }
}
function normalizeSession(value:unknown): SpawnerSession {
  if (!value || typeof value!=="object") throw new AppError("spawner_protocol","Invalid session",502);
  const row = value as Record<string,unknown>;
  if (typeof row["id"]!=="string" || typeof row["label"]!=="string" || !["running","exited"].includes(String(row["status"]))) throw new AppError("spawner_protocol","Invalid session",502);
  return {id:String(row["id"]),label:String(row["label"]),state:row["status"] as "running"|"exited",
    ...(typeof row["recovery"]==="string"?{recovery:row["recovery"]}:{}),
    ...("exitCode" in row?{exitCode:row["exitCode"]===null||row["exitCode"]===undefined?null:Number(row["exitCode"])}:{})};
}
/**
 * Provider registry: a different agent-spawning service is one adapter file plus one
 * `registerSpawnerProvider` call, selected by the `spawner.provider` setting — no changes
 * to workflow, runner or API code. The host daemon is a black box behind this contract.
 */
const providerFactories = new Map<string, SpawnerConstructor>();
export function registerSpawnerProvider(id:string, factory:SpawnerConstructor): void { providerFactories.set(id, factory); }
export function spawnerProviderIds(): string[] { return [...providerFactories.keys()].sort(); }
export function spawnerProviderRegistered(id:string): boolean { return providerFactories.has(id); }
/** The optional `providers` map is for tests that need an inline fixture implementation. */
export function createSpawner(provider:string, options:SpawnerOptions,
  providers?:Readonly<Record<string,SpawnerConstructor>>): AgentSpawner {
  const factory = providers
    ? (Object.hasOwn(providers,provider) ? providers[provider] : undefined)
    : providerFactories.get(provider);
  if (!factory) throw new AppError("unknown_provider",`Unknown spawner provider: ${provider}`);
  return factory(options);
}
registerSpawnerProvider("switchboard", opts => new SwitchboardSpawner(opts));
