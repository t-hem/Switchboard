import assert from "node:assert/strict";
import test from "node:test";
import { FetchHttpClient, isPrivateAddress } from "../src/net.js";

test("IPv4-mapped IPv6 cannot bypass private-address checks", () => {
  for (const ip of ["::ffff:7f00:1", "::ffff:a00:1", "::ffff:c0a8:1", "0:0:0:0:0:ffff:7f00:1", "ff02::1", "::127.0.0.1"])
    assert.equal(isPrivateAddress(ip), true, ip);
  assert.equal(isPrivateAddress("::ffff:808:808"), false);
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
});

test("chunked response bodies are bounded even without Content-Length", async t => {
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(8)); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(() => new FetchHttpClient({ allowPrivate: true }).get("http://127.0.0.1/test", { maxBytes: 10 }), { code: "response_too_large" });
  assert.equal(cancelled, true);
});

test("the request timeout covers stalled bodies, not just response headers", async t => {
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => new Response(new ReadableStream({
    start(controller) { options.signal!.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true }); },
  })));
  await assert.rejects(() => new FetchHttpClient({ allowPrivate: true }).get("http://127.0.0.1/test", { timeoutMs: 20 }), /timed out/);
});
