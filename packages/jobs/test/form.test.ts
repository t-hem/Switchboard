import assert from "node:assert/strict";
import test from "node:test";
import { createApplicationAdapter, type FormField, type FormInspection, type FormSession, type ObservedForm } from "../src/adapters/application.js";

const fields: FormField[] = [
  { name: "name", label: "Name", type: "text", required: true },
  { name: "resume", label: "Resume", type: "file", required: true },
  { name: "workAuth", label: "Work authorization", type: "select", required: true, options: ["yes", "no"] },
  { name: "remote", label: "Remote", type: "checkbox", required: false },
];

class FakeSession implements FormSession {
  opened: string | null = null;
  fills: [string, string][] = [];
  uploads: [string, string][] = [];
  previews = 0;
  closed = false;
  constructor(private readonly options: { captcha?: boolean; forbidden?: boolean; preview?: boolean } = {}) {}
  async open(url: string): Promise<FormInspection & { pageUrl: string }> {
    this.opened = url;
    return { formUrl: url, finalUrl: url, pageUrl: url, fields, captcha: this.options.captcha === true, automationForbidden: this.options.forbidden === true };
  }
  async fill(field: string, value: string): Promise<void> { this.fills.push([field, value]); }
  async uploadFile(field: string, filePath: string): Promise<void> { this.uploads.push([field, filePath]); }
  async observe(): Promise<ObservedForm> {
    return { finalUrl: "u", filled: this.fills.map(([field, value]) => ({ field, value })),
      uploads: this.uploads.map(([field]) => ({ field, fileName: "resume-1.txt", sizeBytes: 11 })) };
  }
  async clickPreview(): Promise<boolean> { this.previews++; return this.options.preview !== false; }
  async submitForm() { return { finalUrl: "u", confirmationText: "Submitted", externalId: "REF-1", result: "submitted" }; }
  async screenshot() { return new Uint8Array([1, 2, 3]); }
  async close(): Promise<void> { this.closed = true; }
}

const adapter = createApplicationAdapter("fixture-form");
const context = (session?: FormSession) => ({ http: { async get() { throw new Error("no network"); } }, allowPrivate: false, session });
const file = { field: "resume", artifactHash: "b".repeat(64), filename: "resume-1.txt", mimeType: "text/plain", localPath: "/tmp/resume-1.txt" };

test("the browser-backed adapter requires a session and honours the site's own flags", async () => {
  await assert.rejects(() => adapter.inspect("https://forms.example/apply", context()), /supervised browser session/);
  const session = new FakeSession({ captcha: true });
  const inspection = await adapter.inspect("https://forms.example/apply", context(session));
  assert.equal(session.opened, "https://forms.example/apply");
  assert.equal(inspection.captcha, true);
  assert.equal(inspection.fields.length, 4);
  assert.equal((await adapter.inspect("https://forms.example/apply", context(new FakeSession({ forbidden: true })))).automationForbidden, true);
});

test("preparing fills the form, uploads the exact file, and only previews", async () => {
  const session = new FakeSession();
  const inspection = await adapter.inspect("https://forms.example/apply", context(session));
  const prepared = await adapter.prepare({ inspection, answers: { name: "Ada", workAuth: "yes", remote: "true" }, resume: file }, context(session));
  assert.deepEqual(prepared.missing, []);
  assert.deepEqual(session.uploads, [["resume", "/tmp/resume-1.txt"]], "the real artifact path is handed to the browser");
  assert.deepEqual(session.fills, [["name", "Ada"], ["workAuth", "yes"], ["remote", "true"]]);
  assert.equal(session.previews, 1);
  // Evidence is what the page shows after filling, and it keeps the exact artifact hash.
  assert.deepEqual(prepared.filled.map(f => f.field).sort(), ["name", "remote", "workAuth"]);
  assert.equal(prepared.uploads[0]!.artifactHash, file.artifactHash);
});

test("an unfillable required field never triggers a preview", async () => {
  const session = new FakeSession();
  const inspection = await adapter.inspect("https://forms.example/apply", context(session));
  const prepared = await adapter.prepare({ inspection, answers: { name: "Ada", workAuth: "maybe" }, resume: file }, context(session));
  assert.deepEqual(prepared.missing, ["workAuth"], "a value outside the select options is a mismatch, not a guess");
  assert.equal(session.previews, 0, "a partial form must never be sent to the site");
});

test("a form without a preview control is still prepared, not submitted", async () => {
  const session = new FakeSession({ preview: false });
  const inspection = await adapter.inspect("https://forms.example/apply", context(session));
  const prepared = await adapter.prepare({ inspection, answers: { name: "Ada", workAuth: "yes" }, resume: file }, context(session));
  assert.deepEqual(prepared.missing, []);
  assert.equal(session.previews, 1);
});
