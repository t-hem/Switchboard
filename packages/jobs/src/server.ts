import fs from "node:fs";
import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyError } from "fastify";
import type { ServiceConfig } from "./config.js";
import { AppError } from "./errors.js";
import { SchedulerShell } from "./scheduler.js";
import { settingsUpdateSchema, type Settings } from "./settings.js";
import type { SettingsStore } from "./store.js";

export function buildServer(config:ServiceConfig, store:SettingsStore, dir:string,
  uiDir = new URL("../../jobs-ui/dist/", import.meta.url)) {
  const app = Fastify({logger:false,bodyLimit:256*1024,ajv:{customOptions:{coerceTypes:false,removeAdditional:false,useDefaults:false}}});
  const scheduler = new SchedulerShell(store);
  app.addHook("onRequest",async(req,reply)=>{
    reply.header("Cache-Control","no-store");
    reply.header("X-Content-Type-Options","nosniff");
    const origin = req.headers.origin;
    if (origin) {
      const sameOrigin = origin===`http://${req.headers.host}`;
      if (!sameOrigin && !config.allowedOrigins.includes(origin)) throw new AppError("origin_denied","UI origin is not allowed",403);
      reply.header("Access-Control-Allow-Origin",origin).header("Vary","Origin");
      reply.header("Access-Control-Allow-Headers","Authorization, Content-Type").header("Access-Control-Allow-Methods","GET, PUT, OPTIONS");
    }
    if(req.method==="OPTIONS")return reply.code(204).send();
    if (!req.url.startsWith("/api/")) return;
    const provided = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${config.token}`);
    if (provided.length!==expected.length || !timingSafeEqual(provided,expected)) throw new AppError("unauthorized","A valid jobs service token is required",401);
  });
  app.setErrorHandler<FastifyError>((error, _req, reply)=>{
    if (error instanceof AppError) return reply.code(error.status).send({error:{code:error.code,message:error.message,fields:error.fields}});
    if (error.validation) return reply.code(400).send({error:{code:"invalid_settings",message:"Settings validation failed",fields:error.validation.map(v=>({path:v.instancePath,message:v.message??"Invalid value"}))}});
    const status=error.statusCode && error.statusCode<500 ? error.statusCode : 500;
    return reply.code(status).send({error:{code:status===500?"internal_error":"invalid_request",message:status===500?"Operation failed; previous committed data is retained":"Invalid request",fields:[]}});
  });
  app.get("/health", async()=>({service:"switchboard-jobs",version:"0.1.0",apiVersion:1}));
  app.get("/api/status",async()=>({scheduler:scheduler.status(),dataDirectory:dir,capabilities:{settings:true,discovery:false,agents:false,applications:false},bootstrap:{port:config.port,allowedOrigins:config.allowedOrigins,tokenConfigured:true}}));
  app.get("/api/settings",async()=>store.current());
  app.put<{Body:{expectedRevision:number;value:Settings}}>("/api/settings",{schema:{body:settingsUpdateSchema}},async(req)=>{
    const url = new URL(req.body.value.spawner.baseUrl);
    if (url.username || url.password || url.search || url.hash) throw new AppError("invalid_settings","Use a base URL without credentials/query/fragment",400,[{path:"/spawner/baseUrl",message:"Credentials and query parameters are not allowed"}]);
    return store.update(req.body.expectedRevision,req.body.value);
  });
  for (const [route,name,type] of [["/","index.html","text/html"],["/app.js","app.js","text/javascript"],["/style.css","style.css","text/css"]] as const) {
    app.get(route,async(_req,reply)=>{
      const file=new URL(name,uiDir);
      if (!fs.existsSync(file)) return reply.code(503).send({error:{code:"ui_not_built",message:"Build packages/jobs-ui first"}});
      reply.header("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
      return reply.type(type).send(fs.readFileSync(file));
    });
  }
  app.addHook("onClose",async()=>{store.close();});
  return app;
}
