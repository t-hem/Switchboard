import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { parseAgentsPayload } from "./agentsvalidate.js";
import { bearerToken, tokenMatches } from "./auth.js";
import { ClaimRegistry, type EvictableSocket } from "./claim.js";
import type { SessionLedger } from "./ledger.js";
import type { AgentRegistry } from "./registry.js";
import { SessionError, type SessionManager } from "./sessions.js";
import type { AgentsConfigResponse, HealthResponse, HostConfig, Session } from "./types.js";
import { scanWorkspaces } from "./workspaces.js";

/**
 * Above this many bytes queued on a socket, output is dropped rather than buffered.
 * A phone on a bad link must not be able to grow the daemon's heap without bound.
 *
 * The drop is announced in the stream rather than done silently: a full-screen TUI
 * repaints and recovers, but scrolling output would just be quietly missing lines,
 * and a terminal that lies about what a command printed is worse than one that
 * admits a gap. The scrollback ring buffer is unaffected, so reconnecting replays
 * the real output.
 */
const MAX_SOCKET_BACKLOG_BYTES = 8 * 1024 * 1024;
const DROP_NOTICE = Buffer.from(
  "\r\n\u001b[33m[switchboard] output dropped — link too slow; reconnect to replay\u001b[0m\r\n",
  "utf8",
);
const RESUME_NOTICE = Buffer.from("\r\n\u001b[33m[switchboard] output resumed\u001b[0m\r\n", "utf8");

export type ServerDeps = {
  hostConfig: HostConfig;
  registry: AgentRegistry;
  sessions: SessionManager;
  ledger: SessionLedger;
  claims: ClaimRegistry;
  version: string;
};

type IdParams = { id: string };
type StreamQuery = { token?: string; clientId?: string; clientLabel?: string; display?: string };
type ClaimBody = { clientId?: unknown; clientLabel?: unknown };

type CreateSessionBody = {
  agent?: unknown;
  cwd?: unknown;
  cols?: unknown;
  rows?: unknown;
  extraArgs?: unknown;
  idempotencyKey?: unknown;
  label?: unknown;
};

type KillOrphansBody = { ids?: unknown; force?: unknown };
type ForceQuery = { force?: string };

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // The token is the gate and the tailnet is the network boundary, so the browser
  // origin is not a meaningful restriction here. See spec §4.5.
  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
  });
  await app.register(websocket);

  // Clients routinely send `Content-Type: application/json` on bodyless requests
  // (DELETE, in particular). Fastify's default parser rejects that as an empty JSON
  // body; treat it as "no body" instead of returning a baffling 400.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body.trim() : "";
    if (text === "") {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(text) as unknown);
    } catch {
      done(new SessionError("invalid JSON body", 400), undefined);
    }
  });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof SessionError) {
      void reply.code(err.status).send({ error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : "internal error";
    // Fastify surfaces malformed JSON bodies and bad params through here too.
    const status =
      typeof err === "object" && err !== null && typeof (err as { statusCode?: unknown }).statusCode === "number"
        ? (err as { statusCode: number }).statusCode
        : 500;
    if (status >= 500) console.error("[http]", err);
    void reply.code(status).send({ error: message });
  });

  // --- unauthenticated ------------------------------------------------------
  // /health is deliberately open: it is how the client tells "host offline" apart
  // from "host reachable, token wrong".
  app.get("/health", async (): Promise<HealthResponse> => ({
    hostLabel: deps.hostConfig.hostLabel,
    platform: process.platform,
    version: deps.version,
    agents: deps.registry.list(),
    sessionCount: deps.sessions.count,
    sessionBackend: deps.hostConfig.sessionBackend ?? "direct",
  }));

  // --- websocket stream -----------------------------------------------------
  // Registered outside the authenticated scope because browsers cannot set headers
  // on a WebSocket; the token arrives as a query parameter instead.
  app.get<{ Params: IdParams; Querystring: StreamQuery }>(
    "/sessions/:id/stream",
    {
      websocket: true,
      onRequest: async (req: FastifyRequest<{ Querystring: StreamQuery }>, reply: FastifyReply) => {
        if (!tokenMatches(deps.hostConfig.token, req.query.token)) {
          return reply.code(401).send({ error: "unauthorized" });
        }
        // The lock is checked before the upgrade, so a non-claimant gets a plain
        // 403 rather than a socket that opens and is immediately severed.
        const clientId = req.query.clientId ?? "";
        if (!deps.claims.mayAttach(clientId)) {
          return reply.code(403).send({
            error: "another client holds this host",
            claimedBy: deps.claims.current?.clientLabel ?? null,
          });
        }
      },
    },
    (socket, req) => {
      const { id } = req.params;
      const clientId = req.query.clientId ?? "";
      const clientLabel = req.query.clientLabel ?? "a client";

      // Registering may implicitly claim an unclaimed host — see ClaimRegistry.
      const evictable: EvictableSocket = {
        evict: (reason: string) => {
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: "evicted", reason }));
            socket.close(4003, reason);
          }
        },
      };
      deps.claims.register(clientId, clientLabel, evictable);

      let dropping = false;
      let detach: (() => void) | null = null;
      let snapshotMode = false;
      let snapshotTimer: NodeJS.Timeout | undefined;
      let capturing = false;
      let dirty = false;
      let previousSnapshot = "";
      let previousHistory: string | undefined;
      let disposed = false;
      let pendingExit: number | null | undefined;
      let interactiveUntil = 0;
      const scheduleSnapshot = (): void => {
        dirty = true;
        if (disposed || capturing || snapshotTimer) return;
        snapshotTimer = setTimeout(() => {
          snapshotTimer = undefined;
          void sendSnapshot();
        }, Date.now() < interactiveUntil ? 0 : 100);
      };
      const sendSnapshot = async (): Promise<void> => {
        if (disposed || socket.readyState !== socket.OPEN) return;
        if (socket.bufferedAmount > MAX_SOCKET_BACKLOG_BYTES) {
          scheduleSnapshot();
          return;
        }
        capturing = true;
        dirty = false;
        try {
          const frame = await deps.sessions.snapshot(id);
          if (disposed || socket.readyState !== socket.OPEN) return;
          const data = JSON.stringify(frame);
          if (data !== previousSnapshot) {
            // Most token updates only change the screen. Do not resend thousands
            // of identical history lines on every keystroke or cursor update.
            socket.send(frame && frame.history === previousHistory
              ? JSON.stringify({ ...frame, history: undefined }) : data);
            previousHistory = frame?.history;
            previousSnapshot = data;
          }
          if (pendingExit !== undefined) {
            socket.send(JSON.stringify({ type: "exit", exitCode: pendingExit }));
            pendingExit = undefined;
          }
        } catch {
          // Never silently strand the browser on stale output. Reconnect retries
          // capture and the access probe distinguishes a deleted session.
          if (!disposed) socket.close(1011, "terminal capture unavailable");
        } finally {
          capturing = false;
          if (dirty && !disposed) scheduleSnapshot();
        }
      };
      try {
        snapshotMode = req.query.display === "snapshot" && deps.sessions.supportsSnapshots(id);
        detach = deps.sessions.attach(id, {
          onData: (chunk) => {
            if (socket.readyState !== socket.OPEN) return;
            if (snapshotMode) { scheduleSnapshot(); return; }
            if (socket.bufferedAmount > MAX_SOCKET_BACKLOG_BYTES) {
              if (!dropping) {
                dropping = true;
                socket.send(DROP_NOTICE);
                console.error(`[ws ${id}] backlog over ${MAX_SOCKET_BACKLOG_BYTES} bytes; dropping output`);
              }
              return;
            }
            if (dropping) {
              dropping = false;
              socket.send(RESUME_NOTICE);
            }
            socket.send(chunk);
          },
          onExit: (exitCode) => {
            if (socket.readyState !== socket.OPEN) return;
            if (snapshotMode) { pendingExit = exitCode; scheduleSnapshot(); return; }
            socket.send(JSON.stringify({ type: "exit", exitCode }));
          },
        });
        if (snapshotMode) scheduleSnapshot();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "attach failed";
        socket.send(JSON.stringify({ type: "error", message }));
        socket.close(4404, message);
        return;
      }

      socket.on("message", (raw: Buffer, isBinary: boolean) => {
        // Client -> server is JSON text frames only; binary from the client is not
        // part of the protocol and is ignored rather than written to the pty.
        if (isBinary) return;
        let msg: unknown;
        try {
          msg = JSON.parse(raw.toString("utf8"));
        } catch {
          return;
        }
        if (typeof msg !== "object" || msg === null) return;
        const m = msg as Record<string, unknown>;
        try {
          if (m["type"] === "input" && typeof m["data"] === "string") {
            // Echo and cursor movement should not wait behind the bulk-output
            // batching timer. Keep this lane open for delayed application redraws.
            interactiveUntil = Date.now() + 500;
            if (snapshotMode && snapshotTimer) {
              clearTimeout(snapshotTimer);
              snapshotTimer = undefined;
              scheduleSnapshot();
            }
            deps.sessions.write(id, m["data"]);
          } else if (m["type"] === "resize") {
            const cols = asNumber(m["cols"]);
            const rows = asNumber(m["rows"]);
            if (cols !== undefined && rows !== undefined) {
              deps.sessions.resize(id, cols, rows);
              if (snapshotMode) scheduleSnapshot();
            }
          }
        } catch (err: unknown) {
          // The session may have been killed between frames.
          if (!(err instanceof SessionError)) console.error(`[ws ${id}]`, err);
        }
      });

      const cleanup = (): void => {
        disposed = true;
        if (snapshotTimer) clearTimeout(snapshotTimer);
        detach?.();
        detach = null;
        deps.claims.unregister(clientId, evictable);
      };
      socket.on("close", cleanup);
      socket.on("error", cleanup);
    },
  );

  // --- authenticated --------------------------------------------------------
  await app.register(async (api) => {
    api.addHook("onRequest", async (req, reply) => {
      if (!tokenMatches(deps.hostConfig.token, bearerToken(req.headers.authorization))) {
        return reply.code(401).send({ error: "unauthorized" });
      }
    });

    api.get("/sessions", async (): Promise<Session[]> => deps.sessions.list());

    api.post<{ Body: CreateSessionBody }>("/sessions", async (req, reply): Promise<Session> => {
      const body = req.body ?? {};
      const agent = asString(body.agent);
      const cwd = asString(body.cwd);
      if (!agent) throw new SessionError("agent is required", 400);
      if (!cwd) throw new SessionError("cwd is required", 400);

      // Optional idempotency: the same key returns the same session instead of a second
      // spawn, including a durable intent recovered after a daemon restart. 200 = reused.
      const idempotencyKey = asString(body.idempotencyKey);
      const existing = idempotencyKey ? deps.sessions.findByIdempotencyKey(idempotencyKey) : null;
      if (existing) {
        void reply.code(200);
        return existing;
      }
      const session = deps.sessions.create({
        agent,
        cwd,
        cols: asNumber(body.cols),
        rows: asNumber(body.rows),
        extraArgs: asStringArray(body.extraArgs),
        label: asString(body.label),
        idempotencyKey,
      });
      void reply.code(201);
      return session;
    });

    api.get<{ Params: IdParams }>("/sessions/:id", async (req): Promise<Session> => {
      const session = deps.sessions.get(req.params.id);
      if (!session) throw new SessionError(`unknown session: ${req.params.id}`, 404);
      return session;
    });

    api.delete<{ Params: IdParams }>("/sessions/:id", async (req, reply) => {
      // Throws synchronously for an unknown id (404). Otherwise answer straight away
      // and let SIGTERM -> SIGKILL play out in the background.
      const terminated = deps.sessions.kill(req.params.id);
      terminated.catch((err: unknown) => console.error(`[session ${req.params.id}]`, err));
      return reply.code(204).send();
    });

    api.post<{ Body: ClaimBody }>("/control/claim", async (req) => {
      const body = req.body ?? {};
      const clientId = asString(body.clientId);
      if (!clientId) throw new SessionError("clientId is required", 400);
      const clientLabel = asString(body.clientLabel) ?? "a client";

      const result = deps.claims.claim(clientId, clientLabel);
      if (result.evicted) {
        console.log(`[claim] ${clientLabel} took over from ${result.evicted.clientLabel}`);
      }
      return result;
    });

    api.get("/workspaces", async (): Promise<string[]> =>
      scanWorkspaces(deps.hostConfig.workspaceRoots),
    );

    const agentsResponse = (): AgentsConfigResponse => ({
      ...deps.registry.config,
      availability: deps.registry.availability,
    });

    api.get("/config/agents", async (): Promise<AgentsConfigResponse> => agentsResponse());

    api.put<{ Body: unknown; Querystring: ForceQuery }>("/config/agents", async (req, reply) => {
      const parsed = parseAgentsPayload(req.body);
      if (!parsed.ok) throw new SessionError(parsed.error, 400);

      const stored = deps.registry.config.updatedAt;
      if (parsed.value.updatedAt < stored && req.query.force !== "1") {
        return reply.code(409).send({
          error: "stored config is newer",
          storedUpdatedAt: stored,
          submittedUpdatedAt: parsed.value.updatedAt,
        });
      }

      // Written verbatim, including updatedAt: a synced map must be byte-identical
      // across the fleet, so the daemon must not restamp it. The client stamps a
      // fresh updatedAt when a human edits the map (spec §5.5); a payload arriving
      // without one is treated as such an edit and stamped here.
      deps.registry.replace(parsed.value);
      console.log(`[config] agents.json updated (${Object.keys(parsed.value.agents).length} agents), reloaded in place`);
      return agentsResponse();
    });

    // Process bookkeeping (not session history): pids this daemon spawned that
    // outlived a previous, unclean shutdown.
    api.get("/orphans", async () => deps.ledger.orphans);

    api.post<{ Body: KillOrphansBody }>("/orphans/kill", async (req) => {
      const body = req.body ?? {};
      return await deps.ledger.killOrphans(asStringArray(body.ids), body.force === true);
    });
  });

  return app;
}
