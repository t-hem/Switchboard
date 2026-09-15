import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { LEDGER_FILE, SessionLedger } from "../src/ledger.ts";
import { platform } from "../src/platform/index.ts";

// Real processes, no mocking: the whole point of the guard is that it reads the
// operating system's idea of when a pid was created.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-ledger-"));
const ledgerFile = path.join(dir, LEDGER_FILE);
const children: ChildProcess[] = [];

before(() => {
  process.env["SWITCHBOARD_DIR"] = dir;
});

after(() => {
  for (const c of children) {
    try {
      if (c.pid) process.kill(c.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function spawnSleeper(): number {
  // detached so killing it never cascades, but deliberately NOT unref()'d: the
  // handle is what keeps the event loop alive while a test awaits its exit.
  // The after() hook kills anything still running.
  const child = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
  children.push(child);
  assert.ok(child.pid, "child should have a pid");
  return child.pid;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a child to be gone *and reaped*. A killed child of this process sits as a
 * zombie until the event loop turns, and a zombie still has a /proc entry with an
 * unchanged start time — so this must be awaited, never spun on.
 */
async function reap(pid: number): Promise<void> {
  const child = children.find((c) => c.pid === pid);
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
  for (let i = 0; i < 100 && alive(pid); i++) await sleep(20);
}

const readLedger = (): Record<string, unknown>[] =>
  JSON.parse(fs.readFileSync(ledgerFile, "utf8")) as Record<string, unknown>[];

const writeLedger = (entries: unknown[]): void => {
  fs.writeFileSync(ledgerFile, JSON.stringify(entries, null, 2), "utf8");
};

test("a missing ledger file reconciles to no orphans", () => {
  fs.rmSync(ledgerFile, { force: true });
  assert.deepEqual(SessionLedger.loadAndReconcile().orphans, []);
});

test("a corrupt ledger file is ignored rather than throwing", () => {
  fs.writeFileSync(ledgerFile, "{not json", "utf8");
  assert.deepEqual(SessionLedger.loadAndReconcile().orphans, []);
});

test("add records the pid's creation time and remove clears it", () => {
  fs.rmSync(ledgerFile, { force: true });
  const ledger = SessionLedger.loadAndReconcile();
  const pid = spawnSleeper();

  const entry = ledger.add({ id: "s1", pid, agent: "bash", cwd: dir, startedAt: Date.now() });
  assert.ok(entry);
  assert.equal(entry.processStartTime, platform.processIdentity(pid));
  assert.equal(readLedger().length, 1);

  ledger.remove("s1");
  assert.equal(readLedger().length, 0);
});

test("a live pid whose creation time still matches is reported as an orphan", () => {
  fs.rmSync(ledgerFile, { force: true });
  const pid = spawnSleeper();
  SessionLedger.loadAndReconcile().add({ id: "s2", pid, agent: "bash", cwd: dir, startedAt: Date.now() });

  // A fresh daemon start, as if the previous one had crashed.
  const orphans = SessionLedger.loadAndReconcile().orphans;
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0]?.pid, pid);
});

test("a dead pid is dropped, not reported", async () => {
  fs.rmSync(ledgerFile, { force: true });
  const pid = spawnSleeper();
  SessionLedger.loadAndReconcile().add({ id: "s3", pid, agent: "bash", cwd: dir, startedAt: Date.now() });
  process.kill(pid, "SIGKILL");
  await reap(pid);

  assert.deepEqual(SessionLedger.loadAndReconcile().orphans, []);
});

test("a recycled pid is dropped without being killed", () => {
  fs.rmSync(ledgerFile, { force: true });
  const pid = spawnSleeper();
  SessionLedger.loadAndReconcile().add({ id: "s4", pid, agent: "bash", cwd: dir, startedAt: Date.now() });

  // Stand in for pid reuse: the pid is alive, but it is not the process we recorded.
  const tampered = readLedger();
  tampered[0]!["processStartTime"] = "linux:0:1";
  writeLedger(tampered);

  const ledger = SessionLedger.loadAndReconcile();
  assert.deepEqual(ledger.orphans, [], "must not offer to kill a process it cannot identify");
  assert.ok(alive(pid), "the unrelated process must be left running");
  process.kill(pid, "SIGKILL");
});

test("killOrphan refuses a pid it cannot verify and kills nothing", async () => {
  fs.rmSync(ledgerFile, { force: true });
  const pid = spawnSleeper();
  const ledger = SessionLedger.loadAndReconcile();
  ledger.add({ id: "s5", pid, agent: "bash", cwd: dir, startedAt: Date.now() });

  // Reach past the ledger's own bookkeeping to simulate the pid being reused after
  // the daemon started but before the operator pressed the button.
  const reloaded = SessionLedger.loadAndReconcile();
  assert.equal(reloaded.orphans.length, 1);
  const tampered = readLedger();
  tampered[0]!["processStartTime"] = "linux:0:1";
  writeLedger(tampered);
  const afterTamper = SessionLedger.loadAndReconcile();

  assert.deepEqual(await afterTamper.killOrphans(), []);
  assert.ok(alive(pid), "nothing should have been killed");
  process.kill(pid, "SIGKILL");
});

test("killOrphan terminates a verified survivor", async () => {
  fs.rmSync(ledgerFile, { force: true });
  const pid = spawnSleeper();
  SessionLedger.loadAndReconcile().add({ id: "s6", pid, agent: "bash", cwd: dir, startedAt: Date.now() });

  const ledger = SessionLedger.loadAndReconcile();
  const results = await ledger.killOrphans(undefined, true);
  assert.deepEqual(results, [{ id: "s6", outcome: "killed" }]);

  await reap(pid);
  assert.ok(!alive(pid), "the verified process should be gone");
  assert.deepEqual(ledger.orphans, []);
  assert.equal(readLedger().length, 0);
});

test("killOrphan reports a survivor that exited on its own", async () => {
  fs.rmSync(ledgerFile, { force: true });
  const pid = spawnSleeper();
  SessionLedger.loadAndReconcile().add({ id: "s7", pid, agent: "bash", cwd: dir, startedAt: Date.now() });
  const ledger = SessionLedger.loadAndReconcile();
  assert.equal(ledger.orphans.length, 1);

  process.kill(pid, "SIGKILL");
  await reap(pid);

  assert.deepEqual(await ledger.killOrphans(), [{ id: "s7", outcome: "already-gone" }]);
  assert.deepEqual(ledger.orphans, []);
});

test("killing an unknown id is reported, not thrown", async () => {
  fs.rmSync(ledgerFile, { force: true });
  const ledger = SessionLedger.loadAndReconcile();
  assert.deepEqual(await ledger.killOrphans(["nope"]), [{ id: "nope", outcome: "unknown-session" }]);
});

test("a process that traps SIGTERM is escalated to SIGKILL, not assumed dead", async () => {
  fs.rmSync(ledgerFile, { force: true });
  // Agent CLIs that trap signals to clean up are exactly the population that broke
  // this: the kill was reported as succeeding while the process kept running.
  const child = spawn("bash", ["--norc", "--noprofile", "-c", "trap '' TERM; sleep 30"], {
    stdio: "ignore",
    detached: true,
  });
  children.push(child);
  await sleep(300);
  const pid = child.pid!;
  SessionLedger.loadAndReconcile().add({ id: "t1", pid, agent: "trapper", cwd: dir, startedAt: Date.now() });

  const ledger = SessionLedger.loadAndReconcile();
  const [result] = await ledger.killOrphans(undefined, false, { graceMs: 400, escalationMs: 2000 });

  assert.equal(result?.outcome, "killed");
  await reap(pid);
  assert.ok(!alive(pid), "reporting killed must mean the process is actually gone");
  assert.deepEqual(ledger.orphans, []);
});

test("an unkillable process is reported as failed and keeps its ledger entry", async () => {
  fs.rmSync(ledgerFile, { force: true });
  // A zombie is the one thing signals cannot clear: it still has a /proc entry with
  // an unchanged start time, so it is indistinguishable from a survivor.
  const parent = spawn("bash", ["--norc", "--noprofile", "-c", "sleep 0.2 & echo $!; sleep 30"], {
    stdio: ["ignore", "pipe", "ignore"],
    detached: true,
  });
  children.push(parent);
  const zombiePid = Number(
    (await new Promise<string>((resolve) => parent.stdout!.once("data", (d: Buffer) => resolve(d.toString())))).trim(),
  );
  await sleep(800); // let the child exit and become a zombie
  assert.ok(alive(zombiePid), "test setup: the zombie should still be in the process table");

  SessionLedger.loadAndReconcile().add({
    id: "z1", pid: zombiePid, agent: "zombie", cwd: dir, startedAt: Date.now(),
  });
  const ledger = SessionLedger.loadAndReconcile();
  const [result] = await ledger.killOrphans(undefined, false, { graceMs: 200, escalationMs: 200 });

  assert.equal(result?.outcome, "failed");
  assert.match(result?.detail ?? "", /still running/);
  assert.equal(ledger.orphans.length, 1, "a kill that could not be confirmed must keep the entry");
  assert.equal(readLedger().length, 1, "and must keep it on disk, or it becomes untrackable");
});
