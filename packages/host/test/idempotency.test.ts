import assert from "node:assert/strict";
import test from "node:test";

import { SessionManager } from "../src/sessions.ts";
import type { SessionBackend, SessionHandle, SpawnRequest } from "../src/backends/types.ts";
import type { Session } from "../src/types.ts";

// The spawn-response-loss window: a caller that records intent and retries must not get a
// second agent process. This is a generic host contract (any add-on can use the key), so
// it is pinned here rather than in an add-on's tests.

function fakeHandle(pid: number): SessionHandle {
  return { pid, onData: () => undefined, onExit: () => undefined, write: () => undefined, resize: () => undefined, signal: () => undefined, disconnect: () => undefined };
}
function fakeBackend(durable: Session[] = []) {
  const created: SpawnRequest[] = [];
  const api: SessionBackend = {
    name: "direct",
    persistent: false,
    create(request) {
      created.push(request);
      return fakeHandle(1000 + created.length);
    },
    recover: () => durable.map((session) => ({ session: structuredClone(session), handle: fakeHandle(session.pid) })),
  };
  return { api, created };
}
function manager(backend: SessionBackend): SessionManager {
  const hostConfig = { port: 1, token: "t", hostLabel: "test", scrollbackBytes: 4096, workspaceRoots: [] };
  const registry = { resolved: () => ({ args: [] as string[] }), executablePath: () => "/bin/true", env: {} };
  const ledger = { add: () => undefined, remove: () => undefined };
  return new SessionManager(hostConfig as never, registry as never, ledger as never, backend);
}
const launched = (idempotencyKey?: string) => ({ agent: "claude", cwd: process.cwd(), idempotencyKey });

test("a repeated idempotency key reuses the session instead of spawning again", () => {
  const { api, created } = fakeBackend();
  const sessions = manager(api);
  const first = sessions.create(launched("jobs:t1:assemble"));
  const second = sessions.create(launched("jobs:t1:assemble"));
  assert.equal(second.id, first.id);
  assert.equal(created.length, 1);
  assert.equal(first.idempotencyKey, "jobs:t1:assemble");
  // A different key is a different run and must spawn.
  const other = sessions.create(launched("jobs:t1:edit"));
  assert.notEqual(other.id, first.id);
  assert.equal(created.length, 2);
  // No key at all keeps the original behaviour: always a new session.
  sessions.create(launched());
  sessions.create(launched());
  assert.equal(created.length, 4);
});

test("a durable session carrying the key is rediscovered after restart, not respawned", () => {
  const durable: Session[] = [{
    id: "swRecovered", agent: "claude", cwd: process.cwd(), label: "recovered", status: "running", exitCode: null,
    pid: 4242, cols: 80, rows: 24, createdAt: 1, lastOutputAt: 1, idempotencyKey: "jobs:t3:assemble",
  }];
  const { api, created } = fakeBackend(durable);
  const sessions = manager(api);
  assert.equal(sessions.findByIdempotencyKey("jobs:t3:assemble")?.id, "swRecovered");
  const again = sessions.create(launched("jobs:t3:assemble"));
  assert.equal(again.id, "swRecovered");
  assert.equal(created.length, 0, "recovery must not spawn a duplicate agent");
});

test("an invalid idempotency key is rejected before any spawn", () => {
  const { api, created } = fakeBackend();
  const sessions = manager(api);
  assert.throws(() => sessions.create(launched("bad key!")), /idempotencyKey/);
  assert.throws(() => sessions.findByIdempotencyKey(""), /idempotencyKey/);
  assert.equal(created.length, 0);
});
