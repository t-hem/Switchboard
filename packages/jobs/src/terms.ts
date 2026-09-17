/**
 * Whole-term matching for tags, keywords and locations. A plain substring test reads "java"
 * inside "javascript" and "intern" inside "international"; here a term only matches when it
 * is not glued to further letters or digits, so "c++", ".net" and "node.js" still match.
 */
const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function containsTerm(haystack: string, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(needle)}(?![\\p{L}\\p{N}])`, "u").test(haystack.toLowerCase());
}
