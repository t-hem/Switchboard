import type { Health, HostEntry, Orphan, OrphanKillResult, Session } from "../types.ts";

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
    body: { agent: string; cwd: string; cols?: number; rows?: number },
  ): Promise<Session> => request(entry, "/sessions", { method: "POST", body: JSON.stringify(body) }),

  killSession: (entry: HostEntry, id: string): Promise<void> =>
    request(entry, `/sessions/${id}`, { method: "DELETE" }),

  workspaces: (entry: HostEntry): Promise<string[]> => request(entry, "/workspaces", {}, 8000),

  orphans: (entry: HostEntry): Promise<Orphan[]> => request(entry, "/orphans"),

  killOrphans: (entry: HostEntry, ids?: string[]): Promise<OrphanKillResult[]> =>
    request(entry, "/orphans/kill", { method: "POST", body: JSON.stringify({ ids }) }, 15000),
};

/** The WebSocket URL for a session, with the token as a query param (browsers
 *  cannot set headers on a WebSocket). */
export function streamUrl(entry: HostEntry, sessionId: string): string {
  const base = normaliseBaseUrl(entry.baseUrl).replace(/^http/i, "ws");
  return `${base}/sessions/${sessionId}/stream?token=${encodeURIComponent(entry.token)}`;
}

export { normaliseBaseUrl };
