import { createHash } from "node:crypto";

/** Minimal, dependency-free HTML text extraction for untrusted posting content.
 * Never executes markup; the result is only ever stored and displayed as text. */

const named: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "\u2013", mdash: "\u2014", hellip: "\u2026", rsquo: "\u2019", lsquo: "\u2018",
  rdquo: "\u201d", ldquo: "\u201c", bull: "\u2022", middot: "\u00b7", deg: "\u00b0",
  eacute: "\u00e9", egrave: "\u00e8", uuml: "\u00fc", ouml: "\u00f6", auml: "\u00e4",
  copy: "\u00a9", reg: "\u00ae", trade: "\u2122", euro: "\u20ac", pound: "\u00a3",
};

/** Decode named and numeric HTML entities. Unknown entities are left literal. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const value = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return match;
      try { return String.fromCodePoint(value); } catch { return match; }
    }
    return named[body.toLowerCase()] ?? named[body] ?? match;
  });
}

/** Convert HTML to readable text: scripts/styles removed, block structure kept as newlines. */
export function htmlToText(html: string): string {
  const withoutCode = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const withBreaks = withoutCode
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|section|article|header|footer|blockquote|pre|ul|ol|table)\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(withBreaks)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    // A heading or paragraph directly above a list should not leave a blank gap.
    .replace(/\n\n(?=- )/g, "\n")
    .trim();
}

/** A stable digest of exact stored text; snapshots compare it to detect a changed posting. */
export function textDigest(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}
