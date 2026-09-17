import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { SettingsStore } from "../src/store.js";
import { ArtifactStore } from "../src/artifacts.js";
import { Postings } from "../src/postings.js";
import { Sources } from "../src/sources.js";
import { Screening } from "../src/screening.js";
import { classifyFamily, extractSalaryText, normalizeLocation, normalizeSalary, screenJob } from "../src/filtering.js";
import "../src/adapters/fixture.js";

test("location and salary normalize without inventing values or converting currency", () => {
  assert.deepEqual(normalizeLocation(""), { known: false, value: null });
  assert.deepEqual(normalizeLocation("N/A"), { known: false, value: null });
  assert.deepEqual(normalizeLocation("Austin, TX"), { known: true, value: "Austin, TX" });

  const annual = normalizeSalary("$120,000 - $150,000 a year");
  assert.deepEqual([annual.known, annual.currency, annual.period, annual.min, annual.max], [true, "USD", "year", 120000, 150000]);
  const hourly = normalizeSalary("£50k per annum");
  assert.deepEqual([hourly.currency, hourly.min, hourly.period], ["GBP", 50000, "year"]);
  const noCurrency = normalizeSalary("120,000 - 150,000");
  assert.equal(noCurrency.known, false, "an amount without a currency is not claimed as normalized");
  const mixed = normalizeSalary("$100,000 or €90,000");
  assert.equal(mixed.known, false, "two currencies are ambiguous, never converted");
  const bare = normalizeSalary("$70,000");
  assert.deepEqual([bare.known, bare.currency, bare.period], [true, "USD", null]);
  assert.equal(normalizeSalary("").known, false);

  assert.equal(extractSalaryText("We offer $95,000 - $130,000 per year plus equity."), "$95,000 - $130,000 per year");
  assert.equal(extractSalaryText("No compensation details here."), null);
});

test("keywords and locations match whole terms, not fragments of longer words", () => {
  const screen = (descriptionText: string, filters: { keywords?: string[]; locations?: string[] }, location = "Remote") =>
    screenJob({ title: "Software Engineer", descriptionText, location, filters });
  assert.equal(screen("We build in JavaScript.", { keywords: ["java"] }).decision, "excluded");
  assert.equal(screen("An international team.", { keywords: ["intern"] }).decision, "excluded");
  assert.equal(screen("Java and Spring services.", { keywords: ["java"] }).decision, "eligible");
  assert.equal(screen("Modern C++ and .NET.", { keywords: ["c++", ".net"] }).reasons.find(reason => reason.code === "keywords_matched")!.detail, "Matched: c++, .net");
  assert.equal(screen("Body", { locations: ["NY"] }, "Sunnyvale, CA").decision, "excluded");
  assert.equal(screen("Body", { locations: ["NY"] }, "New York, NY").decision, "eligible");
});

test("role families classify technical roles and leave ambiguous ones unset", () => {
  assert.equal(classifyFamily("Help Desk Technician", ""), "support");
  assert.equal(classifyFamily("Site Reliability Engineer", ""), "cloud");
  assert.equal(classifyFamily("Salesforce Administrator", ""), "enterprise-apps");
  assert.equal(classifyFamily("Sales Representative", "quota carrying"), null);
  assert.equal(classifyFamily("Happiness Officer", "make people smile"), null);
});

test("screening distinguishes a mismatch from an unstated field and explains itself", () => {
  const eligible = screenJob({ title: "Cloud Engineer", descriptionText: "Kubernetes and AWS", location: "Remote", filters: { keywords: ["kubernetes"], remote: true } });
  assert.equal(eligible.decision, "eligible");
  assert.ok(eligible.reasons.some(reason => reason.code === "keywords_matched"));

  const mismatch = screenJob({ title: "Cloud Engineer", descriptionText: "Kubernetes and AWS", location: "Remote", filters: { keywords: ["salesforce"] } });
  assert.equal(mismatch.decision, "excluded");
  assert.ok(mismatch.reasons.some(reason => reason.code === "keywords_mismatch"));

  const unknown = screenJob({ title: "Cloud Engineer", descriptionText: "", location: null, filters: { keywords: ["kubernetes"] } });
  assert.equal(unknown.decision, "needs_review", "an empty posting is not a keyword mismatch");
  assert.ok(unknown.reasons.some(reason => reason.code === "keywords_unknown"));

  const unknownLocation = screenJob({ title: "Cloud Engineer", descriptionText: "Kubernetes", location: null, filters: { locations: ["Austin"] } });
  assert.equal(unknownLocation.decision, "needs_review");
  const knownLocation = screenJob({ title: "Cloud Engineer", descriptionText: "Kubernetes", location: "Denver", filters: { locations: ["Austin"] } });
  assert.equal(knownLocation.decision, "excluded");

  const ambiguousRole = screenJob({ title: "Happiness Officer", descriptionText: "Smile", location: "Remote", filters: {} });
  assert.equal(ambiguousRole.decision, "needs_review");
});

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-filtering-"));
  const store = new SettingsStore(path.join(dir, "jobs.sqlite"));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const artifacts = new ArtifactStore(store.db, dir);
  const postings = new Postings(store.db, artifacts, () => 1_800_000_000_000);
  const sources = new Sources(store.db, () => 1_800_000_000_000);
  sources.upsert({ id: "acme", adapterId: "fixture", sourceKey: "acme", enabled: true,
    config: { companyName: "Acme", boardId: "acme", filters: { keywords: ["kubernetes"], locations: ["Remote"] } } });
  const { jobId } = postings.ingest({ sourceId: "acme", adapterId: "fixture", externalId: "1", company: "Acme", title: "Sales Representative",
    originalUrl: "https://acme.example/1", descriptionText: "Quota carrying role", provenance: "source" });
  const screening = new Screening(store.db, () => 1_800_000_000_000);
  return { store, screening, jobId };
}

test("screening decisions persist, drive application state, and are immutable", (t) => {
  const { store, screening, jobId } = fixture(t);
  // As discovery does it: evaluate the posting text it just captured.
  const result = screening.evaluate({ title: "Sales Representative", descriptionText: "Quota carrying role", location: null,
    filters: { keywords: ["kubernetes"], locations: ["Remote"] } });
  assert.equal(result.decision, "excluded");
  screening.record({ jobId, sourceId: "acme", settingsRevision: 1, actor: "filter", ...result });
  const row = screening.latest(jobId)!;
  assert.equal(row.actor, "filter");
  assert.ok(row.reasons.some(reason => reason.code === "keywords_mismatch"));
  assert.equal(store.db.prepare("SELECT state FROM applications WHERE job_id=?").get(jobId)!.state, "skipped");
  assert.throws(() => store.db.prepare("UPDATE screening_decisions SET decision='eligible'").run(), /immutable/);
  assert.throws(() => store.db.prepare("DELETE FROM screening_decisions").run(), /retain/);
  // Operator re-screening without captured text is honest: needs review, not a mismatch.
  assert.equal(screening.screenStored(jobId, { settingsRevision: 1 }).decision, "needs_review");
});

test("operator skip and requeue are audited and reversible", (t) => {
  const { store, screening, jobId } = fixture(t);
  assert.throws(() => screening.skip(jobId, "   ", 1), /reason is required/);
  screening.skip(jobId, "wrong seniority", 1);
  assert.equal(screening.latest(jobId)!.decision, "skipped");
  assert.equal(screening.latest(jobId)!.actor, "operator");
  assert.equal(store.db.prepare("SELECT state FROM applications WHERE job_id=?").get(jobId)!.state, "skipped");
  screening.requeue(jobId, 1);
  assert.equal(screening.latest(jobId)!.decision, "eligible");
  assert.equal(store.db.prepare("SELECT state FROM applications WHERE job_id=?").get(jobId)!.state, "screened");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='screening.decided'").get()!.n, 2, "every decision is an audit event");
  assert.equal(screening.list().length, 2);
});
