import { htmlToText } from "../html.js";
import { SourceError } from "../errors.js";
import { retryAfterMs } from "../net.js";
import type { DiscoverResult, PostingInput, RawResponse, SourceAdapter, SourceCapabilities, SourceConfig, SourceContext } from "./source.js";
import { registerSourceAdapter } from "./source.js";

const BOARD_URL = "https://boards-api.greenhouse.io/v1/boards";

/** Public, unauthenticated board API. Submission needs an employer key and is not claimed. */
export const greenhouseCapabilities: SourceCapabilities = {
  discover: true, fetch: true, capture: true, fill: false, upload: false, submit: false, reconcile: false,
};

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? value as Record<string, unknown> : {});

export function normalizeGreenhouse(entry: unknown, config: SourceConfig): PostingInput {
  const job = record(entry);
  const id = job["id"];
  const externalId = typeof id === "number" || typeof id === "string" ? String(id) : "";
  const absoluteUrl = text(job["absolute_url"]);
  const title = text(job["title"]);
  if (!externalId || !absoluteUrl || !title) throw new SourceError("malformed_posting", "Greenhouse job is missing id, absolute_url or title", false);
  // Greenhouse escapes its HTML content once (`&lt;p&gt;`); decode, then derive display text.
  const decoded = text(job["content"]) ?? "";
  const contentHtml = decoded.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  const departments = Array.isArray(job["departments"]) ? job["departments"].map(item => text(record(item)["name"])).filter((name): name is string => Boolean(name)) : [];
  return {
    externalId,
    originalUrl: absoluteUrl,
    canonicalUrl: absoluteUrl,
    company: config.companyName,
    title,
    location: text(record(job["location"])["name"]),
    descriptionText: contentHtml ? htmlToText(contentHtml) : "",
    descriptionHtml: contentHtml || null,
    department: departments.length ? departments.join(", ") : null,
    employmentType: null,
    postedAt: text(job["first_published"]) ?? text(job["updated_at"]),
  };
}

export class GreenhouseAdapter implements SourceAdapter {
  readonly id = "greenhouse";
  readonly version = "1";
  readonly capabilities = greenhouseCapabilities;
  normalize(entry: unknown, config: SourceConfig): PostingInput { return normalizeGreenhouse(entry, config); }
  async discover(config: SourceConfig, context: SourceContext): Promise<DiscoverResult> {
    if (!config.boardId) throw new SourceError("invalid_source", "A Greenhouse board token is required", false);
    const url = `${BOARD_URL}/${encodeURIComponent(config.boardId)}/jobs?content=true`;
    const response = await context.http.get(url, { accept: "application/json" });
    const raw: RawResponse = { url: response.url, status: response.status, contentType: response.contentType, fetchedAt: response.fetchedAt, body: response.body };
    if (response.status === 429) {
      // Honour the server's own backoff instead of guessing one.
      throw new SourceError("rate_limited", "Greenhouse rate limited the request", true, retryAfterMs(response.headers));
    }
    if (response.status < 200 || response.status >= 300) {
      throw new SourceError("source_http", `Greenhouse returned HTTP ${response.status}`, response.status >= 500);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(response.body); }
    catch { throw new SourceError("malformed_response", "Greenhouse response was not JSON", false); }
    const jobs = record(parsed)["jobs"];
    if (!Array.isArray(jobs)) throw new SourceError("malformed_response", "Greenhouse response had no jobs array", false);
    const all = jobs.map(entry => normalizeGreenhouse(entry, config));
    // The board API returns the whole board; a cap turns one response into ordered pages.
    const checkpoint = record(context.checkpoint);
    const offset = typeof checkpoint["offset"] === "number" && checkpoint["offset"] >= 0 ? Math.floor(checkpoint["offset"]) : 0;
    const limit = context.cap && context.cap > 0 ? context.cap : all.length;
    const postings = all.slice(offset, offset + limit);
    const next = offset + postings.length;
    return { postings, responses: [raw], checkpoint: next < all.length ? { offset: next } : null, complete: next >= all.length };
  }
}

registerSourceAdapter("greenhouse", () => new GreenhouseAdapter());
