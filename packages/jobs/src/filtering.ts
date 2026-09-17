import { containsTerm } from "./terms.js";

/**
 * Deterministic, explainable candidate screening. It never invents a value: a filter that
 * cannot be evaluated because the posting omits the field yields `needs_review`, not a
 * mismatch. Salary is normalized in place — currency is never converted.
 */
export type Reason = { code: string; detail: string };
export type Decision = "eligible" | "excluded" | "needs_review" | "skipped";
export type ScreeningResult = { decision: Decision; score: number; reasons: Reason[]; family: string | null };

export type NormalizedSalary = {
  known: boolean;
  currency: string | null;
  period: "hour" | "day" | "week" | "month" | "year" | null;
  min: number | null;
  max: number | null;
  raw: string | null;
};
export type LocationValue = { known: boolean; value: string | null };

const CURRENCIES: Record<string, string> = { "$": "USD", "usd": "USD", "€": "EUR", "eur": "EUR", "£": "GBP", "gbp": "GBP", "c$": "CAD", "cad": "CAD", "aud": "AUD", "₹": "INR", "inr": "INR" };
const PERIODS: [RegExp, NormalizedSalary["period"]][] = [
  [/\b(per\s*hour|hourly|\/hr|\/hour|an hour)\b/i, "hour"],
  [/\b(per\s*day|daily|\/day)\b/i, "day"],
  [/\b(per\s*week|weekly|\/week)\b/i, "week"],
  [/\b(per\s*month|monthly|\/month|pcm)\b/i, "month"],
  [/\b(per\s*(year|annum)|annual(ly)?|yearly|\/yr|\/year|pa)\b/i, "year"],
  // Bare mentions are weaker but still explicit enough to record a period.
  [/\b(year|annum|annual|yr)\b/i, "year"],
  [/\b(month|monthly)\b/i, "month"],
  [/\b(week|weekly)\b/i, "week"],
  [/\b(hour|hourly|hr)\b/i, "hour"],
];

export function normalizeLocation(raw: string | null | undefined): LocationValue {
  const value = (raw ?? "").trim();
  if (!value) return { known: false, value: null };
  // Explicit "unknown" markers are treated as absent, not as a location.
  if (/^(unknown|n\/?a|not specified|remote unspecified|-+)$/i.test(value)) return { known: false, value: null };
  return { known: true, value };
}

/** Best-effort pull of a salary phrase out of posting text; absence stays absent. */
export function extractSalaryText(text: string): string | null {
  const match = text.match(/(?:[$\u20ac\u00a3\u20b9]|\b(?:usd|eur|gbp|cad|aud|inr)\b)\s?\d[\d,]*(?:\.\d+)?\s?k?(?:\s?(?:-|\u2013|to)\s?(?:[$\u20ac\u00a3\u20b9])?\s?\d[\d,]*(?:\.\d+)?\s?k?)?(?:\s?(?:per\s*(?:hour|day|week|month|year|annum)|hourly|annually|yearly|\/hr|\/year))?/i);
  return match ? match[0].trim() : null;
}

export function normalizeSalary(raw: string | null | undefined): NormalizedSalary {
  const text = (raw ?? "").trim();
  const empty: NormalizedSalary = { known: false, currency: null, period: null, min: null, max: null, raw: text || null };
  if (!text) return empty;
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const [token, code] of Object.entries(CURRENCIES)) if (lower.includes(token)) found.add(code);
  const period = PERIODS.find(([pattern]) => pattern.test(lower))?.[1] ?? null;
  const amounts: number[] = [];
  for (const match of lower.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/g)) {
    const base = Number(match[1]!.replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;
    amounts.push(match[2] ? base * 1000 : base);
  }
  // A single currency and at least one plausible amount are required to claim a value.
  if (found.size !== 1 || amounts.length === 0 || amounts.some(amount => amount <= 0)) return empty;
  const min = Math.min(...amounts), max = Math.max(...amounts);
  return { known: true, currency: [...found][0]!, period, min, max, raw: text };
}

const FAMILIES: [string, RegExp][] = [
  ["support", /\b(help\s?desk|service\s?desk|desktop support|technical support|support (engineer|specialist|technician)|it support)\b/i],
  ["systems", /\b(system|network|infrastructure|linux|windows server|vmware|datacenter|data centre)\b.*\b(admin|administrator|engineer|analyst)?/i],
  ["cloud", /\b(cloud|devops|sre|site reliability|platform engineer|kubernetes|terraform|aws|azure|gcp)\b/i],
  ["security", /\b(security|cyber|soc analyst|infosec|penetration|vulnerability)\b/i],
  ["software", /\b(software|developer|engineer|programmer|frontend|front-end|backend|back-end|full[\s-]?stack|web|mobile|ios|android)\b/i],
  ["qa", /\b(qa|quality assurance|test (engineer|automation|analyst)|sdet)\b/i],
  ["data", /\b(data (engineer|analyst|scientist|architect)|analytics|database|dba|etl|warehouse)\b/i],
  ["enterprise-apps", /\b(salesforce|workday|servicenow|sap|oracle (erp|hcm)|netsuite|dynamics 365|erp|crm administrator)\b/i],
  ["technical-management", /\b(engineering manager|technical lead|tech lead|head of engineering|director of engineering|it manager)\b/i],
];
const NON_TECHNICAL = /\b(sales|account executive|recruiter|talent acquisition|finance|accountant|marketing|civil engineer|mechanical engineer|attorney|nurse)\b/i;

/** Ambiguous roles are `null` → the caller records them as needs-review, never excluded. */
export function classifyFamily(title: string, descriptionText: string): string | null {
  const titleText = title.toLowerCase();
  for (const [family, pattern] of FAMILIES) if (pattern.test(titleText)) return family;
  if (NON_TECHNICAL.test(titleText)) return null;
  const body = `${title}\n${descriptionText}`;
  for (const [family, pattern] of FAMILIES) if (pattern.test(body)) return family;
  return null;
}

export type Filters = { keywords?: string[]; locations?: string[]; remote?: boolean | null };

/**
 * Score and explain. A configured filter that the posting satisfies adds score; a filter
 * that is definitely not satisfied excludes; a filter that cannot be evaluated because the
 * posting is silent marks needs-review.
 */
export function screenJob(input: {
  title: string; descriptionText: string; location: string | null | undefined; salary?: string | null; filters: Filters;
}): ScreeningResult {
  const reasons: Reason[] = [];
  const haystack = `${input.title}\n${input.descriptionText}`.toLowerCase();
  let score = 0;
  let excluded = false, unknown = false;

  const keywords = (input.filters.keywords ?? []).map(keyword => keyword.trim()).filter(Boolean);
  if (keywords.length) {
    if (!input.descriptionText.trim()) { unknown = true; reasons.push({ code: "keywords_unknown", detail: "Posting has no description text; cannot match keywords" }); }
    else {
      const matched = keywords.filter(keyword => containsTerm(haystack, keyword));
      score += matched.length * 2;
      if (matched.length) reasons.push({ code: "keywords_matched", detail: `Matched: ${matched.join(", ")}` });
      else { excluded = true; reasons.push({ code: "keywords_mismatch", detail: `No configured keyword (${keywords.join(", ")}) appears` }); }
    }
  }

  const locations = (input.filters.locations ?? []).map(value => value.trim()).filter(Boolean);
  if (locations.length) {
    const location = normalizeLocation(input.location);
    if (!location.known) { unknown = true; reasons.push({ code: "location_unknown", detail: "Location is not stated; not treated as a mismatch" }); }
    else {
      const matched = locations.some(wanted => containsTerm(location.value!, wanted));
      if (matched) { score += 2; reasons.push({ code: "location_matched", detail: location.value! }); }
      else { excluded = true; reasons.push({ code: "location_mismatch", detail: `${location.value} does not match ${locations.join(", ")}` }); }
    }
  }

  if (input.filters.remote === true) {
    if (/\bremote\b/i.test(`${input.location ?? ""} ${input.descriptionText}`)) { score += 1; reasons.push({ code: "remote_matched", detail: "Posting mentions remote" }); }
    else if (!normalizeLocation(input.location).known && !/remote/i.test(input.descriptionText)) { unknown = true; reasons.push({ code: "remote_unknown", detail: "No work arrangement stated" }); }
    else { excluded = true; reasons.push({ code: "remote_mismatch", detail: "Posting is not remote" }); }
  }

  const family = classifyFamily(input.title, input.descriptionText);
  if (!family) { unknown = true; reasons.push({ code: "family_unknown", detail: "Role family is ambiguous" }); }
  else reasons.push({ code: "family", detail: family });

  const salary = normalizeSalary(input.salary);
  if (salary.known) reasons.push({ code: "salary", detail: `${salary.currency} ${salary.min}–${salary.max}${salary.period ? ` per ${salary.period}` : " (period unstated)"}` });
  else if (salary.raw) reasons.push({ code: "salary_unknown", detail: "Salary text present but not safely normalized" });

  // Exclusion wins over needs-review: a definite mismatch is not made ambiguous by a
  // separate unknown field.
  const decision: Decision = excluded ? "excluded" : unknown ? "needs_review" : "eligible";
  return { decision, score, reasons, family };
}
