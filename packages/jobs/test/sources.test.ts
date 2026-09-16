import assert from "node:assert/strict";
import test from "node:test";
import { decodeEntities, htmlToText, textDigest } from "../src/html.js";
import { FetchHttpClient, isPrivateAddress, withRetries } from "../src/net.js";
import { SourceError } from "../src/errors.js";
import { createSourceAdapter, sourceAdapterIds, type SourceAdapter, type SourceConfig, type SourceContext } from "../src/adapters/source.js";
import "../src/adapters/greenhouse.js";
import "../src/adapters/fixture.js";
import type { HttpResponse } from "../src/net.js";

test("HTML is reduced to text without executing or leaking markup", () => {
  assert.equal(decodeEntities("A &amp; B &#65; &#x42; &unknown;"), "A & B A B &unknown;");
  assert.equal(htmlToText("<p>Hello <b>world</b></p><script>alert(1)</script><ul><li>One</li><li>Two</li></ul>"),
    "Hello world\n- One\n- Two");
  assert.match(htmlToText("&lt;script&gt;alert(1)&lt;/script&gt;Hi"), /script.*alert/s);
  assert.equal(textDigest("abc"), textDigest("abc"));
  assert.notEqual(textDigest("abc"), textDigest("abd"));
});

test("private address and redirect guards fail closed", () => {
  for (const address of ["127.0.0.1", "10.0.0.5", "192.168.1.2", "172.16.0.1", "169.254.1.1", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) {
    assert.equal(isPrivateAddress(address), false, address);
  }
  assert.equal(isPrivateAddress("not-an-address"), true);
});

test("withRetries honours retryability and bounded attempts", async () => {
  let calls = 0;
  await assert.rejects(withRetries(2, async () => { calls++; throw new SourceError("x", "boom", true); }, 1), /boom/);
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(withRetries(3, async () => { calls++; throw new SourceError("x", "fatal", false); }, 1), /fatal/);
  assert.equal(calls, 1);
});

const greenhousePayload = {
  jobs: [
    { id: 42, title: "Platform Engineer", absolute_url: "https://boards.example.com/acme/jobs/42?utm_source=x",
      location: { name: "Remote" }, content: "&lt;p&gt;Build &amp;amp; ship&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Go&lt;/li&gt;&lt;/ul&gt;",
      departments: [{ name: "Infrastructure" }], updated_at: "2026-09-01T00:00:00-04:00" },
    { id: "7", title: "Support Specialist", absolute_url: "https://boards.example.com/acme/jobs/7",
      location: { name: "Austin, TX" }, content: "", departments: [], updated_at: "2026-08-01T00:00:00-04:00" },
  ],
};
function jsonResponse(body: unknown, status = 200): HttpResponse {
  return { url: "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true", status,
    contentType: "application/json", body: JSON.stringify(body), fetchedAt: new Date(0).toISOString(), headers: {} };
}

/** The same contract runs against the real adapter's fixture harness and the fake alternate. */
async function assertAdapterContract(adapter: SourceAdapter, context: SourceContext, config: SourceConfig, expected: { firstTitle: string; firstLocation: string }) {
  assert.equal(typeof adapter.id, "string");
  assert.equal(typeof adapter.version, "string");
  for (const key of ["discover", "fetch", "capture", "fill", "upload", "submit", "reconcile"] as const) {
    assert.equal(typeof adapter.capabilities[key], "boolean", key);
  }
  const result = await adapter.discover(config, context);
  assert.ok(result.postings.length >= 1);
  assert.ok(result.responses.length >= 1);
  assert.equal(result.complete, true);
  const first = result.postings[0]!;
  assert.equal(first.title, expected.firstTitle);
  assert.equal(first.location, expected.firstLocation);
  assert.ok(first.externalId && first.originalUrl && first.company && first.descriptionText.length > 0);
  assert.equal(typeof result.responses[0]!.body, "string");
}

test("Greenhouse adapter satisfies the contract from a recorded fixture", async () => {
  const calls: string[] = [];
  const context: SourceContext = { http: { async get(url) { calls.push(url); return jsonResponse(greenhousePayload); } } };
  await assertAdapterContract(createSourceAdapter("greenhouse"), context,
    { sourceKey: "acme", companyName: "Acme", boardId: "acme" }, { firstTitle: "Platform Engineer", firstLocation: "Remote" });
  assert.match(calls[0]!, /boards\/acme\/jobs\?content=true$/);
  const adapter = createSourceAdapter("greenhouse");
  const posting = adapter.normalize(greenhousePayload.jobs[0], { sourceKey: "acme", companyName: "Acme", boardId: "acme" });
  assert.equal(posting.company, "Acme");
  assert.match(posting.descriptionText, /Build & ship/);
  assert.equal(posting.department, "Infrastructure");
  assert.equal(adapter.capabilities.submit, false);
});

test("the fixture adapter satisfies the same contract and is selectable by id", async () => {
  const adapter = createSourceAdapter("fixture");
  const context: SourceContext = { http: { async get() { throw new Error("fixture adapter must not use the network"); } } };
  await assertAdapterContract(adapter, context, { sourceKey: "local", companyName: "Fixture Co", boardId: "local",
    fixture: { postings: [{ id: "a", url: "https://example.com/a", title: "First", location: "Remote", body: "Deterministic body" }] } },
    { firstTitle: "First", firstLocation: "Remote" });
  assert.ok(sourceAdapterIds().includes("greenhouse") && sourceAdapterIds().includes("fixture"));
});

test("adapters translate rate limits and malformed payloads without silent retries", async () => {
  const adapter = createSourceAdapter("greenhouse");
  const config: SourceConfig = { sourceKey: "acme", companyName: "Acme", boardId: "acme" };
  await assert.rejects(adapter.discover(config, { http: { async get() { return { ...jsonResponse({}, 429) }; } } }),
    (error: unknown) => error instanceof SourceError && error.retryable === true);
  await assert.rejects(adapter.discover(config, { http: { async get() { return { ...jsonResponse({}, 200), body: "<html>" }; } } }),
    (error: unknown) => error instanceof SourceError && error.code === "malformed_response" && error.retryable === false);
  await assert.rejects(adapter.discover({ ...config, boardId: "" }, { http: { async get() { throw new Error("unused"); } } }),
    (error: unknown) => error instanceof SourceError && error.code === "invalid_source");
});

test("import URL validation refuses private targets unless the local fixture is explicitly allowed", async () => {
  const client = new FetchHttpClient({ allowPrivate: false });
  await assert.rejects(client.get("http://127.0.0.1:9/posting"), (error: unknown) => error instanceof SourceError && error.code === "url_not_permitted");
  await assert.rejects(client.get("http://localhost/posting"), (error: unknown) => error instanceof SourceError && error.code === "url_not_permitted");
  await assert.rejects(client.get("file:///etc/passwd"), (error: unknown) => error instanceof SourceError && error.code === "invalid_url");
  await assert.rejects(client.get("https://user:pass@example.com/x"), (error: unknown) => error instanceof SourceError && error.code === "invalid_url");
});
