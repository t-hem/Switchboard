/**
 * Cosmetic facts read out of a session's rendered scrollback — the model it is using,
 * the title or summary it has given itself.
 *
 * Spec §2 allows exactly this and fences it precisely: the patterns live in
 * `agents.json` so a new agent stays a config line, and the result is decoration.
 * Everything here is therefore best-effort by construction — a miss returns nothing, a
 * malformed pattern is ignored, and no caller may branch on the outcome. Nothing in the
 * spawn, stream or kill path calls into this module, and it must stay that way: the
 * daemon does not learn to understand an agent, it only reads what is already on screen.
 *
 * The bounds below exist because `agents.json` is hand-edited and fleet-synced, so a
 * pattern written on one machine runs on all of them. Matching happens line by line
 * against a bounded tail of the buffer, which keeps any one regex execution short even
 * if the pattern backtracks badly.
 */

/** How much of the tail to consider. A status line lives near the end or not at all. */
export const SCAN_BYTES = 16_384;
const MAX_LINES = 200;
const MAX_LINE_CHARS = 512;
const MAX_PATTERN_CHARS = 200;
const MAX_VALUE_CHARS = 120;

export type DisplayPatterns = { model?: string; title?: string };
export type DisplayFields = { model?: string; title?: string };

/**
 * CSI, OSC and the single-character escapes, so patterns match what the operator sees
 * rather than the colour codes wrapped around it. OSC is terminated by BEL or ST.
 */
const ANSI = /\][^]*(?:|\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** OSC 0/1/2 — the standard "set the terminal title" sequences. */
const OSC_TITLE = /\]([012]);([^]*)(?:|\\)/g;

/**
 * The last title the workload set, if it set one.
 *
 * This is deliberately not pattern-driven: a terminal title is a property of terminals,
 * not of any particular agent, so reading it needs no `agents.json` entry and a new
 * agent that sets one is decorated for free. That is the §2 rule satisfied rather than
 * bent — nothing here knows what agent is running.
 */
export function oscTitle(text: string): string | undefined {
  let last: string | undefined;
  OSC_TITLE.lastIndex = 0;
  for (let m = OSC_TITLE.exec(text); m !== null; m = OSC_TITLE.exec(text)) last = m[2];
  return last === undefined ? undefined : clean(last);
}

/**
 * Drop leading decoration before the first letter or digit.
 *
 * Agents commonly prefix a spinner glyph that changes frame by frame; left alone it
 * would rewrite the row on every poll, which is the same churn a fixed display bucket
 * was meant to stop. A title that is *only* decoration is left alone rather than
 * emptied.
 */
export function tidyTitle(title: string): string {
  const trimmed = title.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  return trimmed.length > 0 ? trimmed : title.trim();
}

const compiled = new Map<string, RegExp | null>();

/** Compiled once per distinct pattern; an invalid one is remembered as unusable. */
function compile(pattern: string): RegExp | null {
  const cached = compiled.get(pattern);
  if (cached !== undefined) return cached;
  let regex: RegExp | null = null;
  if (pattern.length <= MAX_PATTERN_CHARS) {
    try {
      regex = new RegExp(pattern);
    } catch {
      regex = null;
    }
  }
  compiled.set(pattern, regex);
  return regex;
}

function clean(value: string): string | undefined {
  const trimmed = value.trim().slice(0, MAX_VALUE_CHARS).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Newest line first: a session that has switched model or retitled itself should read as
 * what it is now, not what it was when it started.
 */
function recentLines(text: string): string[] {
  const lines = stripAnsi(text).split(/\r?\n/);
  const tail = lines.slice(-MAX_LINES);
  tail.reverse();
  return tail.map((line) => line.slice(0, MAX_LINE_CHARS));
}

function firstMatch(lines: string[], pattern: string | undefined): string | undefined {
  if (pattern === undefined) return undefined;
  const regex = compile(pattern);
  if (regex === null) return undefined;
  for (const line of lines) {
    let match: RegExpExecArray | null = null;
    try {
      match = regex.exec(line);
    } catch {
      return undefined;
    }
    if (match === null) continue;
    // Group 1 when the pattern captures, else the whole match — so a trivial pattern
    // still does something useful without demanding the operator write a group.
    const value = clean(match[1] ?? match[0]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Read whatever can be found. Never throws: a caller decorating a session row must not
 * be able to fail because of what happens to be on screen.
 *
 * `terminalTitle` is what the backend already knows the workload called itself (tmux
 * tracks this per pane). Title precedence is explicit config, then that, then a title
 * sequence found in the bytes — an operator who wrote a pattern meant it, and the
 * generic mechanism is the fallback rather than the other way round.
 */
export function extractDisplay(
  text: string,
  patterns: DisplayPatterns | undefined,
  terminalTitle?: string,
): DisplayFields {
  try {
    const lines = patterns === undefined ? [] : recentLines(text);
    const fields: DisplayFields = {};

    const model = firstMatch(lines, patterns?.model);
    if (model !== undefined) fields.model = model;

    const title = firstMatch(lines, patterns?.title) ?? clean(terminalTitle ?? "") ?? oscTitle(text);
    if (title !== undefined) fields.title = tidyTitle(title);

    return fields;
  } catch {
    return {};
  }
}
