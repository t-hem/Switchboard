import fs from "node:fs";
import { dashboardRoutes } from "./dashboard.js";
import { postingsRoutes, type PostingsDeps } from "./postings-api.js";
import { libraryRoutes } from "./library-api.js";
import { personasRoutes } from "./personas-api.js";
import { runnerRoutes } from "./runner-api.js";
import { spawnerProviderRegistered } from "./adapters/spawner.js";
import { invocationAdapterIds } from "./invocation.js";
import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyError } from "fastify";
import type { ServiceConfig } from "./config.js";
import { AppError, SourceError } from "./errors.js";
import { applicationsRoutes } from "./applications-api.js";
import type { SupervisedBrowser } from "./browser.js";
import { schedulerStatus } from "./scheduler.js";
import { submissionRoutes } from "./submission-api.js";
import { recordsRoutes } from "./records-api.js";
import { isReadOnly } from "./health.js";
import { schedulerRoutes } from "./scheduler-api.js";
import { screeningRoutes } from "./screening-api.js";
import { settingsUpdateSchema, type Settings } from "./settings.js";
import type { SettingsStore } from "./store.js";

export function buildServer(config:ServiceConfig, store:SettingsStore, dir:string,
  options:{uiDir?:URL; deps?:PostingsDeps; browser?:SupervisedBrowser} = {}) {
  const uiDir = options.uiDir ?? new URL("../../jobs-ui/dist/", import.meta.url);
  const app = Fastify({logger:false,bodyLimit:256*1024,ajv:{customOptions:{coerceTypes:false,removeAdditional:false,useDefaults:false}}});

  app.addHook("onRequest",async(req,reply)=>{
    reply.header("Cache-Control","no-store");
    reply.header("X-Content-Type-Options","nosniff");
    const origin = req.headers.origin;
    if (origin) {
      const sameOrigin = origin===`http://${req.headers.host}`;
      if (!sameOrigin && !config.allowedOrigins.includes(origin)) throw new AppError("origin_denied","UI origin is not allowed",403);
      reply.header("Access-Control-Allow-Origin",origin).header("Vary","Origin");
      reply.header("Access-Control-Allow-Headers","Authorization, Content-Type").header("Access-Control-Allow-Methods","GET, PUT, POST, OPTIONS");
    }
    if(req.method==="OPTIONS")return reply.code(204).send();
    if (!req.url.startsWith("/api/")) return;
    // A restored archive is inspectable but never dispatches: every write is refused.
    if (isReadOnly(dir) && (req.method === "POST" || req.method === "PUT"))
      throw new AppError("read_only_archive", "This data directory is a read-only restore; no work is dispatched from it", 409);
    const provided = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${config.token}`);
    if (provided.length!==expected.length || !timingSafeEqual(provided,expected)) throw new AppError("unauthorized","A valid jobs service token is required",401);
  });
  app.setErrorHandler<FastifyError>((error, _req, reply)=>{
    if (error instanceof AppError) return reply.code(error.status).send({error:{code:error.code,message:error.message,fields:error.fields}});
    // Adapter-boundary failures keep their code; retryability decides the status, never a 500.
    if (error instanceof SourceError) return reply.code(error.retryable ? 503 : 400).send({error:{code:error.code,message:error.message,fields:[]}});
    if (error.validation) return reply.code(400).send({error:{code:"invalid_request",message:"Request validation failed",fields:error.validation.map(v=>({path:v.instancePath,message:v.message??"Invalid value"}))}});
    const status=error.statusCode && error.statusCode<500 ? error.statusCode : 500;
    return reply.code(status).send({error:{code:status===500?"internal_error":"invalid_request",message:status===500?"Operation failed; previous committed data is retained":"Invalid request",fields:[]}});
  });
  app.get("/health", async()=>({service:"switchboard-jobs",version:"0.1.0",apiVersion:1}));
  app.get("/api/status",async()=>({scheduler:schedulerStatus(store,store.db),dataDirectory:dir,
    capabilities:{settings:true,import:true,discovery:true,screening:true,capture:Boolean(config.browserExecutablePath),resumes:true,pdf:false,agents:false,applications:true,submissions:Boolean(config.browserExecutablePath),records:true},
    readOnly:isReadOnly(dir),
    bootstrap:{port:config.port,allowedOrigins:config.allowedOrigins,tokenConfigured:true,allowPrivateImport:config.allowPrivateImport===true}}));
  app.get("/api/settings",async()=>store.current());
  app.put<{Body:{expectedRevision:number;value:Settings}}>("/api/settings",{schema:{body:settingsUpdateSchema}},async(req)=>{
    const url = new URL(req.body.value.spawner.baseUrl);
    if (url.username || url.password || url.search || url.hash) throw new AppError("invalid_settings","Use a base URL without credentials/query/fragment",400,[{path:"/spawner/baseUrl",message:"Credentials and query parameters are not allowed"}]);
    // A provider is a registered adapter, not a free-form string: swapping it is a setting change.
    if (!spawnerProviderRegistered(req.body.value.spawner.provider))
      throw new AppError("unknown_provider","Spawner provider is not registered",400,[{path:"/spawner/provider",message:"No registered spawner provider by that id"}]);
    const invocation = req.body.value.spawner.invocationAdapter;
    if (invocation && !invocationAdapterIds().includes(invocation))
      throw new AppError("unknown_provider","Invocation adapter is not registered",400,[{path:"/spawner/invocationAdapter",message:"No registered invocation adapter by that id"}]);
    return store.update(req.body.expectedRevision,req.body.value);
  });
  dashboardRoutes(app,store,dir);
  postingsRoutes(app,store,dir,config,{...options.deps,browser:options.browser});
  applicationsRoutes(app,store,dir,config,{browser:options.browser,now:options.deps?.now});
  submissionRoutes(app,store,dir,config,{browser:options.browser,now:options.deps?.now});
  recordsRoutes(app,store,dir,{now:options.deps?.now});
  libraryRoutes(app,store,dir);
  personasRoutes(app,store);
  schedulerRoutes(app,store,dir,config);
  screeningRoutes(app,store);
  runnerRoutes(app,store,dir,config);
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
