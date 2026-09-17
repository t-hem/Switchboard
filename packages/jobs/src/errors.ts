export class AppError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400,
    readonly fields: {path: string; message: string}[] = []) {
    super(message);
  }
}

/** Adapter-boundary failure with an explicit retryability decision. Never silently retried. */
export class SourceError extends Error {
  /** `retryAfterMs` carries a server-provided backoff (e.g. HTTP 429) without inventing one. */
  constructor(readonly code: string, message: string, readonly retryable: boolean, readonly retryAfterMs?: number) {
    super(message);
  }
}