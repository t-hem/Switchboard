import { AppError } from "../errors.js";
import type { HttpClient } from "../net.js";

/**
 * Source adapter contract. The first callers are the Greenhouse adapter and a
 * deterministic local fixture. Business/workflow code depends on this interface and
 * the registry factory only, never on a provider module directly.
 */
export type SourceCapabilities = {
  discover: boolean; fetch: boolean; capture: boolean;
  fill: boolean; upload: boolean; submit: boolean; reconcile: boolean;
};

export type SourceConfig = {
  sourceKey: string;
  companyName: string;
  boardId: string;
  region?: "global" | "eu";
  filters?: { keywords?: string[]; locations?: string[]; remote?: boolean | null };
  requests?: { concurrency?: number; maxRetries?: number };
  /** Only the deterministic fixture adapter reads this; real adapters ignore it. */
  fixture?: { postings?: unknown[]; partial?: boolean };
};

/** Provider-shaped data is preserved verbatim but never typed into workflow state. */
export type RawResponse = { url: string; status: number; contentType: string; fetchedAt: string; body: string };

export type PostingInput = {
  externalId: string;
  originalUrl: string;
  canonicalUrl?: string | null;
  company: string;
  title: string;
  location?: string | null;
  descriptionText: string;
  descriptionHtml?: string | null;
  department?: string | null;
  employmentType?: string | null;
  postedAt?: string | null;
};

export type DiscoverResult = {
  postings: PostingInput[];
  responses: RawResponse[];
  /** False when pagination stopped early (rate limit, cap or error); a partial scan closes nothing. */
  complete: boolean;
};

export type SourceContext = {
  http: HttpClient;
  maxRetries?: number;
  pageLimit?: number;
  /** At most this many postings are returned; a cap must be visible, never silent. */
  cap?: number;
};

export interface SourceAdapter {
  readonly id: string;
  readonly version: string;
  readonly capabilities: SourceCapabilities;
  discover(config: SourceConfig, context: SourceContext): Promise<DiscoverResult>;
  normalize(entry: unknown, config: SourceConfig): PostingInput;
}

const factories = new Map<string, () => SourceAdapter>();

/** Registering keeps prior adapters available; replacing one never edits workflow code. */
export function registerSourceAdapter(id: string, factory: () => SourceAdapter): void {
  factories.set(id, factory);
}
export function createSourceAdapter(id: string): SourceAdapter {
  const factory = factories.get(id);
  if (!factory) throw new AppError("unknown_adapter", `No source adapter is registered as ${id}`, 400);
  return factory();
}
export function sourceAdapterIds(): string[] {
  return [...factories.keys()].sort();
}
