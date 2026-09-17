import { SourceError } from "../errors.js";
import type { DiscoverResult, PostingInput, RawResponse, SourceAdapter, SourceCapabilities, SourceConfig, SourceContext } from "./source.js";
import { registerSourceAdapter } from "./source.js";

/**
 * Deterministic local adapter. It exercises the same contract as a real board without
 * network access, so swapping the configured implementation needs no workflow edits.
 */
export const fixtureCapabilities: SourceCapabilities = {
  discover: true, fetch: true, capture: true, fill: false, upload: false, submit: false, reconcile: false,
};

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? value as Record<string, unknown> : {});

export function normalizeFixture(entry: unknown, config: SourceConfig): PostingInput {
  const item = record(entry);
  const externalId = text(item["id"]);
  const url = text(item["url"]);
  const title = text(item["title"]);
  if (!externalId || !url || !title) throw new SourceError("malformed_posting", "Fixture posting is missing id, url or title", false);
  const body = text(item["body"]) ?? "";
  return {
    externalId, originalUrl: url, canonicalUrl: text(item["canonicalUrl"]) ?? url,
    company: text(item["company"]) ?? config.companyName, title,
    location: text(item["location"]), descriptionText: body, descriptionHtml: null,
    department: text(item["department"]), employmentType: null, postedAt: text(item["postedAt"]),
  };
}

export class FixtureAdapter implements SourceAdapter {
  readonly id = "fixture";
  readonly version = "1";
  readonly capabilities = fixtureCapabilities;
  normalize(entry: unknown, config: SourceConfig): PostingInput { return normalizeFixture(entry, config); }
  async discover(config: SourceConfig, context: SourceContext): Promise<DiscoverResult> {
    const rateLimit = config.fixture?.rateLimit;
    if (rateLimit && (context.attempt ?? 1) <= (rateLimit.firstAttempts ?? 1)) {
      throw new SourceError("rate_limited", "Fixture rate limit", true, rateLimit.retryAfterMs ?? 1000);
    }
    const entries = config.fixture?.postings ?? [];
    if (!Array.isArray(entries)) throw new SourceError("invalid_source", "Fixture postings must be an array", false);
    const raw: RawResponse = { url: `fixture://${config.boardId}`, status: 200, contentType: "application/json", fetchedAt: new Date().toISOString(), body: JSON.stringify({ jobs: entries }) };
    const all = entries.map(entry => normalizeFixture(entry, config));
    const checkpoint = record(context.checkpoint);
    const offset = typeof checkpoint["offset"] === "number" && checkpoint["offset"] >= 0 ? Math.floor(checkpoint["offset"]) : 0;
    const pageSize = config.fixture?.pagination?.pageSize;
    const cap = context.cap && context.cap > 0 ? context.cap : all.length;
    const limit = Math.max(0, Math.min(pageSize ?? all.length, cap));
    const postings = all.slice(offset, offset + limit);
    const next = offset + postings.length;
    const exhausted = next >= all.length;
    return { postings, responses: [raw], checkpoint: exhausted ? null : { offset: next }, complete: exhausted && !(config.fixture?.partial ?? false) };
  }
}

registerSourceAdapter("fixture", () => new FixtureAdapter());
