import os from "node:os";
import path from "node:path";

export type Settings = {
  schemaVersion: 1;
  enabled: boolean;
  paused: boolean;
  mode: "draft" | "review" | "automatic";
  reviewGates: { discovery: boolean; resumeBuild: boolean; resumeEdit: boolean; preparation: boolean; submission: boolean };
  spawner: { provider: "switchboard"; baseUrl: string; agent: string };
  personaDirectory: string;
};
export const defaultSettings = (): Settings => ({
  schemaVersion: 1, enabled: false, paused: true, mode: "draft",
  reviewGates: {discovery:true, resumeBuild:true, resumeEdit:true, preparation:true, submission:true},
  spawner: {provider:"switchboard",baseUrl:"http://127.0.0.1:7777",agent:"claude"},
  personaDirectory: path.join(os.homedir(), ".switchboard", "personas"),
});
const object = (properties: Record<string, unknown>) => ({
  type:"object", additionalProperties:false, required:Object.keys(properties), properties,
});
export const settingsSchema = object({
  schemaVersion: {const:1}, enabled:{type:"boolean"}, paused:{type:"boolean"},
  mode:{enum:["draft","review","automatic"]},
  reviewGates:object(Object.fromEntries(["discovery","resumeBuild","resumeEdit","preparation","submission"].map(k=>[k,{type:"boolean"}]))),
  spawner:object({provider:{const:"switchboard"},baseUrl:{type:"string",format:"uri",pattern:"^https?://",maxLength:2048},agent:{type:"string",minLength:1,maxLength:100}}),
  personaDirectory:{type:"string",pattern:"^/",minLength:1,maxLength:4096},
});
export const settingsUpdateSchema = object({
  expectedRevision:{type:"integer",minimum:1}, value:settingsSchema,
});
