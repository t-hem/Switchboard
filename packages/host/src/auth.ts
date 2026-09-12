import { timingSafeEqual } from "node:crypto";

/** Constant-time token comparison; cheap enough to just always do. */
export function tokenMatches(expected: string, provided: string | undefined | null): boolean {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
