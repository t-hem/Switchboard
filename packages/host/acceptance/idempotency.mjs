// Generic host idempotency acceptance: a caller that retries must not get two agents.
// Uses the default direct backend so it needs no tmux owner; the tmux restart path is
// covered separately by restart.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-idempotency-"));
const port = 17960;
const token = "idempotency-acceptance-token";
fs.writeFileSync(path.join(dir, "host.json"), JSON.stringify({
  port, token, hostLabel: "idempotency-test", scrollbackBytes: 65536,
  workspaceRoots: [path.dirname(process.cwd())], pathPrepend: [], env: {},
}));
fs.writeFileSync(path.join(dir, "agents.json"), JSON.stringify({ updatedAt: 0, agents: {
  bash: { cmd: "bash", args: ["--norc", "--noprofile", "-i"] },
} }));

let child;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 100; i++) { try { if (await fn()) return; } catch { /* retry */ } await delay(100); }
  throw new Error(`Timeout: ${label}`);
}
const base = `http://127.0.0.1:${port}`;
const post = (body) => fetch(`${base}/sessions`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const get = (route) => fetch(base + route, { headers: { Authorization: `Bearer ${token}` } });

try {
  child = spawn(process.execPath, ["packages/host/dist/index.js"], { env: { ...process.env, SWITCHBOARD_DIR: dir }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", () => {}); child.stderr.on("data", () => {});
  await until(async () => (await fetch(`${base}/health`)).ok, "daemon startup");

  const body = { agent: "bash", cwd: process.cwd(), idempotencyKey: "jobs:retry-test:assemble" };
  const first = await post(body);
  assert.equal(first.status, 201);
  const created = await first.json();
  assert.equal(created.idempotencyKey, "jobs:retry-test:assemble");

  const second = await post(body);
  assert.equal(second.status, 200, "a repeat is a reuse, not a new spawn");
  const reused = await second.json();
  assert.equal(reused.id, created.id);

  const inventory = await (await get("/sessions")).json();
  assert.equal(inventory.filter((session) => session.idempotencyKey === body.idempotencyKey).length, 1);
  assert.equal(inventory.length, 1, "the retry did not create a second process");

  const other = await post({ ...body, idempotencyKey: "jobs:retry-test:edit" });
  assert.equal(other.status, 201);
  assert.notEqual((await other.json()).id, created.id);

  const noKeyA = await post({ agent: "bash", cwd: process.cwd() });
  const noKeyB = await post({ agent: "bash", cwd: process.cwd() });
  assert.equal(noKeyA.status, 201); assert.equal(noKeyB.status, 201);
  assert.notEqual((await noKeyA.json()).id, (await noKeyB.json()).id, "no key keeps always-spawn behaviour");

  const invalid = await post({ ...body, idempotencyKey: "bad key!" });
  assert.equal(invalid.status, 400);

  // Clean up the spawned shells so the temp dir can be removed.
  for (const session of await (await get("/sessions")).json()) {
    await fetch(`${base}/sessions/${session.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  }
  console.log("PASS idempotent create: duplicate key reuses, distinct keys and absent keys spawn, invalid key rejected");
} catch (error) {
  console.error(error);
  throw error;
} finally {
  if (child && child.exitCode === null) { const done = once(child, "exit"); child.kill("SIGTERM"); await done; }
  fs.rmSync(dir, { recursive: true, force: true });
}
