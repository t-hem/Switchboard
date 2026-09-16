import assert from "node:assert/strict";
import test from "node:test";
import { CaptureService, type CaptureOutcome, type CaptureOptions, type PageCapture } from "../src/capture.js";
import { SourceError } from "../src/errors.js";

class FakePage implements PageCapture {
  calls = 0; closed = false;
  constructor(private readonly behaviour: (attempt: number) => CaptureOutcome) {}
  async capture(url: string, options: CaptureOptions): Promise<CaptureOutcome> {
    this.calls++;
    return this.behaviour(this.calls);
  }
  async close(): Promise<void> { this.closed = true; }
}
const outcome = (overrides: Partial<CaptureOutcome> = {}): CaptureOutcome => ({
  fetchedUrl: "https://example.com/j", finalUrl: "https://example.com/j", descriptionText: "A complete posting body with enough characters to pass the minimum threshold.",
  title: "Job", screenshot: new Uint8Array([1, 2, 3]), completeness: "complete", warning: null,
  captureJson: { method: "browser", captureVersion: "1", scrolls: 3, textLength: 82, screenshotBytes: 3 }, ...overrides,
});

test("capture retries transient failures within the configured bound", async () => {
  const page = new FakePage(attempt => { if (attempt < 3) throw new SourceError("capture_failed", "Posting page timed out", true); return outcome(); });
  const service = new CaptureService(page, 2);
  const result = await service.capture("https://example.com/j", { allowPrivate: false });
  assert.equal(result.completeness, "complete");
  assert.equal(page.calls, 3);
  await service.close();
  assert.equal(page.closed, true);
});

test("capture gives up after the retry limit and never fabricates a success", async () => {
  const page = new FakePage(() => { throw new SourceError("capture_failed", "Posting page timed out", true); });
  const service = new CaptureService(page, 2);
  await assert.rejects(service.capture("https://example.com/j", { allowPrivate: false }), /timed out/);
  assert.equal(page.calls, 3);
});

test("a non-retryable capture failure is reported immediately", async () => {
  const page = new FakePage(() => { throw new SourceError("url_not_permitted", "Refusing to fetch a private address", false); });
  const service = new CaptureService(page, 3);
  await assert.rejects(service.capture("https://example.com/j", { allowPrivate: false }), /private address/);
  assert.equal(page.calls, 1);
});
