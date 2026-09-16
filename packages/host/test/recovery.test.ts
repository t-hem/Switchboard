import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RecoveryRegistry, type RecoveryEntry } from "../src/backends/registry.ts";
import { posixOps } from "../src/platform/posix.ts";

const entry: RecoveryEntry = {
  backend: "tmux", ownerId: "owner", target: "sw-owner-example", scope: "sw-owner-example.scope",
  phase: "starting", processIdentity: null,
  session: {id: "example", agent: "bash", cwd: "/tmp", label: "test", status: "running", exitCode: null,
    pid: 0, cols: 80, rows: 24, createdAt: 1, lastOutputAt: 1},
};
function temporary(run: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-registry-test-"));
  try { run(dir); } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

test("spawn intent survives reload; writes are isolated from caller mutation", {skip: process.platform !== "linux"}, () => temporary(dir => {
  const registry = new RecoveryRegistry(dir, posixOps);
  registry.put(entry);
  const list = registry.list(); list[0]!.phase = "exited";
  assert.equal(registry.list()[0]!.phase, "starting");
  assert.throws(() => new RecoveryRegistry(dir, posixOps), /Another daemon/);
  registry.close();
  const recovered = new RecoveryRegistry(dir, posixOps);
  assert.deepEqual(recovered.list(), [entry]);
  recovered.remove("example"); recovered.close();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "persistent-sessions.json"), "utf8")).entries, []);
}));

test("corrupt/unknown schema preserved; ownership lock released on failed open", {skip: process.platform !== "linux"}, () => temporary(dir => {
  const file = path.join(dir, "persistent-sessions.json");
  for (const value of ['bad json', '{"version":2,"entries":[]}', '{"version":1,"entries":[{}]}']) {
    fs.writeFileSync(file, value);
    assert.throws(() => new RecoveryRegistry(dir, posixOps));
    assert.equal(fs.readFileSync(file, "utf8"), value);
    assert.equal(fs.existsSync(path.join(dir, "persistent-sessions.lock")), false);
  }
}));

test("failed write never publishes new metadata or forgets existing intent", {skip: process.platform !== "linux"}, () => temporary(dir => {
  const registry = new RecoveryRegistry(dir, posixOps); registry.put(entry);
  fs.mkdirSync(path.join(dir, "persistent-sessions.json.tmp"));
  assert.throws(() => registry.remove("example"));
  assert.equal(registry.list().length, 1);
  registry.close();
  const reloaded = new RecoveryRegistry(dir, posixOps);
  assert.equal(reloaded.list().length, 1); reloaded.close();
}));

test("invalid ownership target cannot be persisted", {skip: process.platform !== "linux"}, () => temporary(dir => {
  const registry = new RecoveryRegistry(dir, posixOps);
  assert.throws(() => registry.put({...entry, target: "user-session; kill-server"}));
  assert.throws(() => registry.put({...entry, session: {...entry.session, id: "../escape"}}));
  assert.throws(() => registry.put({...entry, scope: "sw-other.scope"}));
  registry.close();
}));

test("recycled owner identity is reclaimed once; interrupted reclaim fails closed", {skip: process.platform !== "linux"}, () => temporary(dir => {
  const lock = path.join(dir, "persistent-sessions.lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({pid:process.pid, identity:"linux:previous-boot:1"}));
  const registry = new RecoveryRegistry(dir, posixOps);
  assert.equal(registry.list().length, 0);
  registry.close();
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({pid:process.pid, identity:"linux:previous-boot:1"}));
  assert.throws(() => new RecoveryRegistry(dir, posixOps), /EEXIST/);
  assert.ok(fs.existsSync(path.join(lock, "owner.json")));
}));
