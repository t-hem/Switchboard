import { setTimeout as delay } from "node:timers/promises";
import puppeteer, { type Browser } from "puppeteer-core";
import { SourceError } from "./errors.js";
import { assertImportableUrl, withRetries } from "./net.js";

export const CAPTURE_VERSION = "1";

/** Narrow browser-side interop: these callbacks are serialized into the page, not run in Node. */
type BrowserGlobals = {
  document: {
    body: { innerText: string } | null;
    title: string;
    documentElement: { scrollHeight: number };
    querySelector(selector: string): unknown;
  };
  window: { innerHeight: number; scrollBy(x: number, y: number): void; scrollTo(x: number, y: number): void };
};

export type CaptureOutcome = {
  fetchedUrl: string;
  finalUrl: string;
  descriptionText: string;
  title: string | null;
  screenshot: Uint8Array;
  completeness: "complete" | "partial";
  warning: string | null;
  captureJson: { method: "browser" | "manual"; captureVersion: string; scrolls: number; textLength: number; screenshotBytes: number };
};
export type CaptureOptions = { allowPrivate: boolean; timeoutMs: number; maxScrolls: number; minChars: number };

/** Backend seam: a real browser here, a deterministic fake in unit tests. */
export interface PageCapture {
  capture(url: string, options: CaptureOptions): Promise<CaptureOutcome>;
  close(): Promise<void>;
}

export class BrowserPageCapture implements PageCapture {
  private browser: Browser | null = null;
  constructor(private readonly executablePath: string) {}
  private async ensure(): Promise<Browser> {
    if (!this.browser || !this.browser.connected) {
      this.browser = await puppeteer.launch({
        executablePath: this.executablePath, headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
      });
    }
    return this.browser;
  }
  async capture(url: string, options: CaptureOptions): Promise<CaptureOutcome> {
    await assertImportableUrl(url, { allowPrivate: options.allowPrivate });
    const browser = await this.ensure();
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 1280, height: 900 });
      try {
        await page.goto(url, { waitUntil: "load", timeout: options.timeoutMs });
      } catch (error) {
        throw new SourceError("capture_failed", error instanceof Error && /timeout/i.test(error.message) ? "Posting page timed out" : "Posting page could not be loaded", true);
      }
      // A permitted URL may still redirect into the local network; re-check the final address.
      await assertImportableUrl(page.url(), { allowPrivate: options.allowPrivate });
      await page.waitForNetworkIdle({ idleTime: 400, timeout: Math.min(options.timeoutMs, 8000) }).catch(() => undefined);
      // Trigger lazy-loaded sections: scroll in bounded steps until the document stops growing.
      let scrolls = 0, previous = -1, stable = 0;
      for (; scrolls < options.maxScrolls && stable < 2; scrolls++) {
        const height = await page.evaluate(() => (globalThis as unknown as BrowserGlobals).document.documentElement.scrollHeight);
        if (height === previous) stable++; else stable = 0;
        previous = height;
        await page.evaluate(() => { const w = (globalThis as unknown as BrowserGlobals).window; w.scrollBy(0, Math.round(w.innerHeight * 0.9)); });
        await delay(200);
      }
      await page.evaluate(() => (globalThis as unknown as BrowserGlobals).window.scrollTo(0, 0));
      const { text, title } = await page.evaluate(() => {
        const g = globalThis as unknown as BrowserGlobals;
        return {
          text: (g.document.body?.innerText ?? "").replace(/\r\n?/g, "\n").replace(/[ \t\f\v\u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim(),
          title: g.document.title || null,
        };
      });
      const marker = await page.evaluate(() => Boolean((globalThis as unknown as BrowserGlobals).document.querySelector("[data-capture-incomplete]")));
      const screenshot = new Uint8Array(await page.screenshot({ fullPage: true, type: "png" }));
      if (screenshot.byteLength === 0) throw new SourceError("capture_failed", "Posting screenshot was empty", true);
      const short = text.length < options.minChars;
      const warning = marker ? "The page reports incomplete or lazy-loaded content" : short ? "Captured text is unusually short" : null;
      return {
        fetchedUrl: url, finalUrl: page.url(), descriptionText: text, title,
        screenshot, completeness: marker || short ? "partial" : "complete", warning,
        captureJson: { method: "browser", captureVersion: CAPTURE_VERSION, scrolls, textLength: text.length, screenshotBytes: screenshot.byteLength },
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  }
  async close(): Promise<void> {
    if (this.browser) { await this.browser.close().catch(() => undefined); this.browser = null; }
  }
}

/** Bounded retries for transient capture failures; a final failure is reported, never faked. */
export class CaptureService {
  constructor(private readonly page: PageCapture, private readonly maxRetries = 2) {}
  capture(url: string, options: Partial<CaptureOptions> & { allowPrivate: boolean }): Promise<CaptureOutcome> {
    const resolved: CaptureOptions = {
      allowPrivate: options.allowPrivate,
      timeoutMs: options.timeoutMs ?? 20_000,
      maxScrolls: options.maxScrolls ?? 12,
      minChars: options.minChars ?? 80,
    };
    return withRetries(this.maxRetries, () => this.page.capture(url, resolved));
  }
  close(): Promise<void> { return this.page.close(); }
}
