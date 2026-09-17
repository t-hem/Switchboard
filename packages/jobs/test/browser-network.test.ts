import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "puppeteer-core";
import { guardBrowserRequests } from "../src/browser-network.js";

test("browser interception blocks private redirects and subresources before they are sent", async () => {
  let handler!: (request: unknown) => void;
  let intercepted = false;
  const page = { async setRequestInterception(value: boolean) { intercepted = value; },
    on(_event: string, callback: typeof handler) { handler = callback; } } as unknown as Page;
  await guardBrowserRequests(page, false);
  assert.equal(intercepted, true);
  const outcome = (url: string) => new Promise<string>(resolve => handler({
    url: () => url, isInterceptResolutionHandled: () => false,
    async continue() { resolve("continued"); }, async abort() { resolve("blocked"); },
  }));
  for (const url of ["http://127.0.0.1/secrets", "http://[::ffff:7f00:1]/", "file:///etc/passwd", "http://169.254.169.254/"])
    assert.equal(await outcome(url), "blocked", url);
  assert.equal(await outcome("https://8.8.8.8/public"), "continued");
  assert.equal(await outcome("data:image/png;base64,AA=="), "continued");
});
