import type {
  AgentsConfig,
  ClaimResult,
  AgentsConfigResponse,
  Health,
  HostEntry,
  Orphan,
  OrphanKillResult,
  Session,
} from "../types.ts";

/** Requests that take longer than this are treated as a host being down. */
const REQUEST_TIMEOUT_MS = 3000;

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function normaliseBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

async function request<T>(
  entry: HostEntry,
  path: string,
  init: RequestInit & { auth?: boolean } = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const { auth = true, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(rest.headers);
    if (auth) headers.set("Authorization", `Bearer ${entry.token}`);
    if (rest.body !== undefined) headers.set("Content-Type", "application/json");

    const res = await fetch(`${normaliseBaseUrl(entry.baseUrl)}${path}`, {
      ...rest,
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      let message = res.statusText;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        /* non-JSON error body */
      }
      throw new HttpError(message, res.status);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  /** Unauthenticated on purpose: distinguishes "offline" from "token is wrong". */
  health: (entry: HostEntry): Promise<Health> => request(entry, "/health", { auth: false }),

  sessions: (entry: HostEntry): Promise<Session[]> => request(entry, "/sessions"),

  createSession: (
    entry: HostEntry,
    // The daemon also accepts label/extraArgs for programmatic callers (spec §9).
    body: { agent: string; cwd: string; cols?: number; rows?: number },
  ): Promise<Session> => request(entry, "/sessions", { method: "POST", body: JSON.stringify(body) }),

  killSession: (entry: HostEntry, id: string): Promise<void> =>
    request(entry, `/sessions/${id}`, { method: "DELETE" }),

  workspaces: (entry: HostEntry): Promise<string[]> => request(entry, "/workspaces", {}, 8000),

  orphans: (entry: HostEntry): Promise<Orphan[]> => request(entry, "/orphans"),

  claim: (entry: HostEntry, clientId: string, clientLabel: string): Promise<ClaimResult> =>
    request(entry, "/control/claim", { method: "POST", body: JSON.stringify({ clientId, clientLabel }) }),

  agentsConfig: (entry: HostEntry): Promise<AgentsConfigResponse> => request(entry, "/config/agents"),

  putAgentsConfig: (
    entry: HostEntry,
    config: AgentsConfig,
    force = false,
  ): Promise<AgentsConfigResponse> =>
    request(
      entry,
      `/config/agents${force ? "?force=1" : ""}`,
      { method: "PUT", body: JSON.stringify(config) },
      8000,
    ),

  killOrphans: (entry: HostEntry, ids?: string[]): Promise<OrphanKillResult[]> =>
    request(entry, "/orphans/kill", { method: "POST", body: JSON.stringify({ ids }) }, 15000),
};

/**
 * The WebSocket URL for a session. Both the token and the client identity travel as
 * query params because browsers cannot set headers on a WebSocket; the daemon uses
 * the identity to enforce the single-client lock before upgrading.
 */
export function streamUrl(
  entry: HostEntry,
  sessionId: string,
  clientId: string,
  clientLabel: string,
): string {
  const base = normaliseBaseUrl(entry.baseUrl).replace(/^http/i, "ws");
  const query = new URLSearchParams({ token: entry.token, clientId, clientLabel });
  return `${base}/sessions/${sessionId}/stream?${query.toString()}`;
}

/**
 * Why did a stream socket close?
 *
 * A failed WebSocket upgrade surfaces as a bare 1006 close with no status, so the
 * client cannot tell "another device holds the lock" from "the wifi dropped" — and
 * would otherwise retry forever with no explanation. The same route answers an
 * ordinary GET, and its pre-upgrade hook returns 403 for a non-claimant, so asking
 * over HTTP gives the answer the socket withheld.
 */
export async function probeStreamAccess(
  entry: HostEntry,
  sessionId: string,
  clientId: string,
): Promise<{ locked: boolean; claimedBy: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const query = new URLSearchParams({ token: entry.token, clientId });
    const res = await fetch(
      `${normaliseBaseUrl(entry.baseUrl)}/sessions/${sessionId}/stream?${query.toString()}`,
      { signal: controller.signal },
    );
    if (res.status !== 403) return { locked: false, claimedBy: null };
    let claimedBy: string | null = null;
    try {
      claimedBy = ((await res.json()) as { claimedBy?: string }).claimedBy ?? null;
    } catch {
      /* body is optional */
    }
    return { locked: true, claimedBy };
  } catch {
    // Unreachable: that is a network problem, not a lock. Keep retrying.
    return { locked: false, claimedBy: null };
  } finally {
    clearTimeout(timer);
  }
}

export { normaliseBaseUrl };
