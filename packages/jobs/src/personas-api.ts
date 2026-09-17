import type { FastifyInstance } from "fastify";
import type { Services } from "./services.js";
import { listPersonas } from "./personas.js";
import { TOOLS } from "./tools.js";
import { invocationAdapterIds, createInvocationAdapter } from "./invocation.js";

/**
 * Diagnostics for the machine-local persona directory. This is read-only: the host
 * daemon never reads personas, and jobs only ever snapshots them into a run.
 */
export function personasRoutes(app: FastifyInstance, { store }: Services): void {
  app.get("/api/personas", async () => {
    const directory = store.current().value.personaDirectory;
    const { personas, errors } = listPersonas(directory);
    return {
      directory,
      personas: personas.map(persona => ({ id: persona.id, name: persona.name, description: persona.description,
        agent: persona.agent, model: persona.model, tools: persona.tools, skills: persona.skills, permissions: persona.permissions })),
      errors,
      tools: Object.values(TOOLS).map(tool => ({ id: tool.id, version: tool.version, description: tool.description })).sort((a, b) => a.id.localeCompare(b.id)),
      adapters: invocationAdapterIds().map(id => { const adapter = createInvocationAdapter(id); return { id, version: adapter.version, capabilities: adapter.capabilities }; }),
    };
  });
}