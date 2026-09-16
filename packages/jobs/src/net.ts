import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { SourceError } from "./errors.js";

export type HttpResponse = {
  url: string; status: number; contentType: string; body: string;
  fetchedAt: string; headers: Record<string, string>;
};
export interface HttpClient {
  get(url: string, options?: { timeoutMs?: number; maxBytes?: number; accept?: string }): Promise<HttpResponse>;
}

const PRIVATE_V4 = [
  [/^0\./, "this-network"], [/^10\./, "private"], [/^127\./, "loopback"],
  [/^169\.254\./, "link-local"], [/^172\.(1[6-9]|2[0-9]|3[01])\./, "private"],
  [/^192\.168\./, "private"], [/^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./, "cgnat"],
  [/^198\.1[89]\./, "benchmark"], [/^22[4-9]\./, "multicast"], [/^2[3-5][0-9]\./, "reserved"],
];
/** True for addresses a posting import must never reach unless explicitly permitted. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return PRIVATE_V4.some(([pattern]) => (pattern as RegExp).test(address));
  if (version === 6) {
    const value = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    if (mapped) return isPrivateAddress(mapped[1]!);
    if (value === "::" || value === "::1") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(value)) return true;   // unique local fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(value)) return true;   // link local fe80::/10
    return false;
  }
  return true; // not an address at all: fail closed
}

/**
 * Validate an operator-supplied or adapter-supplied URL before any fetch or browser navigation.
 * `allowPrivate` exists only for the isolated local development fixture; production defaults false.
 */
export async function assertImportableUrl(value: string, options: { allowPrivate: boolean }): Promise<URL> {
  let url: URL;
  try { url = new URL(value); } catch { throw new SourceError("invalid_url", "Posting URL must be absolute", false); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SourceError("invalid_url", "Only http(s) posting URLs are allowed", false);
  if (url.username || url.password) throw new SourceError("invalid_url", "Posting URLs must not contain credentials", false);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (options.allowPrivate) return url;
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) {
    throw new SourceError("url_not_permitted", `Refusing to fetch private host ${host}`, false);
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new SourceError("url_not_permitted", "Refusing to fetch a private or local address", false);
    return url;
  }
  let addresses: { address: string }[];
  try { addresses = await lookup(host, { all: true }); }
  catch { throw new SourceError("url_unresolvable", `Cannot resolve ${host}`, true); }
  if (addresses.length === 0) throw new SourceError("url_unresolvable", `Cannot resolve ${host}`, true);
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      throw new SourceError("url_not_permitted", `Refusing to fetch ${host}: it resolves to a private address`, false);
    }
  }
  return url;
}

export const MAX_REDIRECTS = 5;

/**
 * Fetch text with an SSRF guard on every hop. Redirects are followed manually so the
 * private-address check cannot be bypassed by a redirect into the local network.
 */
export class FetchHttpClient implements HttpClient {
  constructor(private readonly options: { allowPrivate: boolean; timeoutMs?: number; maxBytes?: number; userAgent?: string }) {}
  async get(value: string, options: { timeoutMs?: number; maxBytes?: number; accept?: string } = {}): Promise<HttpResponse> {
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 15_000;
    const maxBytes = options.maxBytes ?? this.options.maxBytes ?? 8 * 1024 * 1024;
    let current = value;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const url = await assertImportableUrl(current, { allowPrivate: this.options.allowPrivate });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(url, {
          redirect: "manual", signal: controller.signal,
          headers: { accept: options.accept ?? "application/json, text/html;q=0.9, */*;q=0.5", "user-agent": this.options.userAgent ?? "switchboard-jobs/0.1 (local personal use)" },
        });
      } catch (error) {
        throw new SourceError("source_unreachable", error instanceof Error && error.name === "AbortError" ? "Posting request timed out" : "Posting request failed", true);
      } finally { clearTimeout(timer); }
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        if (hop === MAX_REDIRECTS) throw new SourceError("too_many_redirects", "Posting redirected too many times", false);
        current = new URL(location, url).toString();
        continue;
      }
      const contentType = response.headers.get("content-type") ?? "";
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > maxBytes) throw new SourceError("response_too_large", "Posting response exceeds the configured size limit", false);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > maxBytes) throw new SourceError("response_too_large", "Posting response exceeds the configured size limit", false);
      return {
        url: url.toString(), status: response.status, contentType,
        body: buffer.toString("utf8"), fetchedAt: new Date().toISOString(),
        headers: Object.fromEntries(response.headers.entries()),
      };
    }
    throw new SourceError("too_many_redirects", "Posting redirected too many times", false);
  }
}

/** Retry only explicitly retryable failures, with bounded attempts and linear backoff. */
export async function withRetries<T>(maxRetries: number, action: (attempt: number) => Promise<T>, sleepMs = 400): Promise<T> {
  const attempts = Math.max(0, Math.min(maxRetries, 5)) + 1;
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await action(attempt); }
    catch (error) {
      last = error;
      if (!(error instanceof SourceError) || !error.retryable || attempt === attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, sleepMs * attempt));
    }
  }
  throw last;
}
