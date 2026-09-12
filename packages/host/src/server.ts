import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";

import type { AgentRegistry } from "./registry.js";
import type { HealthResponse, HostConfig } from "./types.js";

export type ServerDeps = {
  hostConfig: HostConfig;
  registry: AgentRegistry;
  version: string;
  sessionCount: () => number;
};

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // The token is the gate; the tailnet is the network boundary. See spec §4.5.
  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
  });

  app.get("/health", async (): Promise<HealthResponse> => {
    return {
      hostLabel: deps.hostConfig.hostLabel,
      platform: process.platform,
      version: deps.version,
      agents: deps.registry.list(),
      sessionCount: deps.sessionCount(),
    };
  });

  return app;
}
