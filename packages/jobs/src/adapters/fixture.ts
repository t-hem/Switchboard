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
    const entries = config.fixture?.postings ?? [];
    if (!Array.isArray(entries)) throw new SourceError("invalid_source", "Fixture postings must be an array", false);
    const raw: RawResponse = { url: `fixture://${config.boardId}`, status: 200, contentType: "application/json", fetchedAt: new Date().toISOString(), body: JSON.stringify({ jobs: entries }) };
    const postings = entries.map(entry => normalizeFixture(entry, config));
    const cap = context.cap && context.cap > 0 ? context.cap : undefined;
    return { postings: cap ? postings.slice(0, cap) : postings, responses: [raw], complete: !(config.fixture?.partial ?? false) };
  }
}

registerSourceAdapter("fixture", () => new FixtureAdapter());
