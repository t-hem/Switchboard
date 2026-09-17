import os from "node:os";
import path from "node:path";

export type Settings = {
  schemaVersion: 1;
  enabled: boolean;
  paused: boolean;
  mode: "draft" | "review" | "automatic";
  reviewGates: { discovery: boolean; resumeBuild: boolean; resumeEdit: boolean; preparation: boolean; submission: boolean };
  /** `provider`/`invocationAdapter` name registered implementations; swap without code changes. */
  spawner: { provider: string; baseUrl: string; agent: string; invocationAdapter?: string };
  personaDirectory: string;
};
export const defaultSettings = (): Settings => ({
  schemaVersion: 1, enabled: false, paused: true, mode: "draft",
  reviewGates: {discovery:true, resumeBuild:true, resumeEdit:true, preparation:true, submission:true},
  spawner: {provider:"switchboard",baseUrl:"http://127.0.0.1:7777",agent:"claude",invocationAdapter:"pi"},
  personaDirectory: path.join(os.homedir(), ".switchboard", "personas"),
});
const object = (properties: Record<string, unknown>) => ({
  type:"object", additionalProperties:false, required:Object.keys(properties), properties,
});
export const settingsSchema = object({
  schemaVersion: {const:1}, enabled:{type:"boolean"}, paused:{type:"boolean"},
  mode:{enum:["draft","review","automatic"]},
  reviewGates:object(Object.fromEntries(["discovery","resumeBuild","resumeEdit","preparation","submission"].map(k=>[k,{type:"boolean"}]))),
  // Provider ids are validated against the registered adapters at save time in server.ts.
  spawner:{type:"object",additionalProperties:false,required:["provider","baseUrl","agent"],properties:{
    provider:{type:"string",pattern:"^[a-z0-9][a-z0-9-]{0,31}$"},
    baseUrl:{type:"string",format:"uri",pattern:"^https?://",maxLength:2048},
    agent:{type:"string",minLength:1,maxLength:100},
    invocationAdapter:{type:"string",pattern:"^[a-z0-9][a-z0-9-]{0,31}$"},
  }},
  personaDirectory:{type:"string",pattern:"^/",minLength:1,maxLength:4096},
});
export const settingsUpdateSchema = object({
  expectedRevision:{type:"integer",minimum:1}, value:settingsSchema,
});
