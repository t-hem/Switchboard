import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before } from "node:test";

import { SessionLedger } from "../src/ledger.ts";
import type { ProcessOps } from "../src/platform/index.ts";

// The kill escalation is where the damaging bugs have been: reporting `killed` for a
// process that is still running deletes the ledger entry and creates exactly the
// untracked stray the ledger exists to prevent. Those cases — a process that ignores
// the first kill, a pid recycled mid-poll, a kill call that throws the way node-pty
// does on Windows — cannot be staged with real processes on a single OS. A fake
// ProcessOps can stage all of them, on any OS.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-escalation-"));
before(() => {
  process.env["SWITCHBOARD_DIR"] = dir;
});

const TIMING = { graceMs: 120, escalationMs: 120 };

/** A process that dies after `diesAfter` kill attempts. 0 = dies on the first. */
function fakeOps(opts: {
  identity?: string | null;
  diesAfter?: number;
  throwOn?: "soft" | "hard" | "both";
  identityAfterKill?: string | null;
}): ProcessOps & { calls: { force: boolean }[] } {
  const calls: { force: boolean }[] = [];
  let alive = true;
  let kills = 0;
  const identity = opts.identity === undefined ? "fake:1" : opts.identity;
  return {
    calls,
    name: "posix",
    spawnCommand: (file, args) => ({ file, args: [...args] }),
    killPty: () => undefined,
    killByPid(_pid, force) {
      calls.push({ force });
      if (opts.throwOn === "both" || (opts.throwOn === "soft" && !force) || (opts.throwOn === "hard" && force)) {
        throw new Error("Signals not supported on windows");
      }
      kills += 1;
      if (kills > (opts.diesAfter ?? 0)) alive = false;
    },
    processIdentity() {
      if (!alive) return opts.identityAfterKill ?? null;
      return identity;
    },
  };
}

function ledgerWith(ops: ProcessOps, pid = 4242): SessionLedger {
  fs.rmSync(path.join(dir, "sessions.json"), { force: true });
  const seed = SessionLedger.loadAndReconcile(ops);
  seed.add({ id: "s1", pid, agent: "fake", cwd: dir, startedAt: Date.now() });
  // Reload so the entry comes back as an orphan rather than a live session.
  return SessionLedger.loadAndReconcile(ops);
}

test("a process that dies on the first kill is reported killed and forgotten", async () => {
  const ops = fakeOps({ diesAfter: 0 });
  const ledger = ledgerWith(ops);
  const [result] = await ledger.killOrphans(undefined, false, TIMING);
  assert.equal(result?.outcome, "killed");
  assert.deepEqual(ops.calls, [{ force: false }], "should not have escalated");
  assert.deepEqual(ledger.orphans, []);
});

test("a process that ignores the first kill is escalated, not assumed dead", async () => {
  const ops = fakeOps({ diesAfter: 1 });
  const ledger = ledgerWith(ops);
  const [result] = await ledger.killOrphans(undefined, false, TIMING);
  assert.equal(result?.outcome, "killed");
  assert.deepEqual(ops.calls, [{ force: false }, { force: true }], "expected escalation to force");
  assert.deepEqual(ledger.orphans, []);
});

test("a process that survives everything is reported failed and KEEPS its entry", async () => {
  // The invariant that matters: a kill that cannot be confirmed must not delete the
  // record. Otherwise the one process that refuses to die is also the one nothing
  // tracks any more.
  const ops = fakeOps({ diesAfter: 99 });
  const ledger = ledgerWith(ops);
  const [result] = await ledger.killOrphans(undefined, false, TIMING);
  assert.equal(result?.outcome, "failed");
  assert.match(result?.detail ?? "", /still running/);
  assert.equal(ledger.orphans.length, 1, "the surviving orphan must stay on record");
});

test("a kill that throws is reported failed and keeps the entry", async () => {
  // node-pty throws "Signals not supported on windows" if handed a signal. A throw
  // must never be mistaken for a successful kill.
  const ops = fakeOps({ throwOn: "both" });
  const ledger = ledgerWith(ops);
  const [result] = await ledger.killOrphans(undefined, false, TIMING);
  assert.equal(result?.outcome, "failed");
  assert.match(result?.detail ?? "", /Signals not supported/);
  assert.equal(ledger.orphans.length, 1);
});

test("a throw on escalation alone still fails rather than reporting killed", async () => {
  const ops = fakeOps({ diesAfter: 99, throwOn: "hard" });
  const ledger = ledgerWith(ops);
  const [result] = await ledger.killOrphans(undefined, false, TIMING);
  assert.equal(result?.outcome, "failed");
  assert.equal(ledger.orphans.length, 1);
});

test("a pid recycled before the kill is dropped, never signalled", async () => {
  const ops = fakeOps({ identity: "fake:1" });
  const ledger = ledgerWith(ops);
  // The pid now belongs to something else entirely.
  ops.processIdentity = () => "fake:SOMETHING-ELSE";
  const [result] = await ledger.killOrphans(undefined, false, TIMING);
  assert.equal(result?.outcome, "pid-reused");
  assert.deepEqual(ops.calls, [], "a recycled pid must never be killed");
  assert.deepEqual(ledger.orphans, []);
});

test("a pid that vanishes before the kill is already-gone, not killed", async () => {
  const ops = fakeOps({});
  const ledger = ledgerWith(ops);
  ops.processIdentity = () => null;
  const [result] = await ledger.killOrphans(undefined, false, TIMING);
  assert.equal(result?.outcome, "already-gone");
  assert.deepEqual(ops.calls, []);
  assert.deepEqual(ledger.orphans, []);
});

test("a pid recycled *during* the grace poll is treated as gone, not re-killed", async () => {
  // identityMatches is the guard: once the token stops matching, the process we cared
  // about is gone, whatever now holds the pid.
  const ops = fakeOps({ diesAfter: 0, identityAfterKill: "fake:A-DIFFERENT-PROCESS" });
  const ledger = ledgerWith(ops);
  const [result] = await ledger.killOrphans(undefined, false, TIMING);
  assert.equal(result?.outcome, "killed");
  assert.deepEqual(ops.calls, [{ force: false }], "must not escalate onto a recycled pid");
});

test("force skips the graceful attempt entirely", async () => {
  const ops = fakeOps({ diesAfter: 0 });
  const ledger = ledgerWith(ops);
  const [result] = await ledger.killOrphans(undefined, true, TIMING);
  assert.equal(result?.outcome, "killed");
  assert.deepEqual(ops.calls, [{ force: true }], "force should go straight to the hard kill");
});

test("an entry whose identity cannot be read is never recorded at all", async () => {
  // No identity means no way to verify the pid later, so acting on it could kill
  // something unrelated. It must not enter the ledger.
  const ops = fakeOps({ identity: null });
  fs.rmSync(path.join(dir, "sessions.json"), { force: true });
  const ledger = SessionLedger.loadAndReconcile(ops);
  assert.equal(ledger.add({ id: "x", pid: 5, agent: "fake", cwd: dir, startedAt: Date.now() }), null);
});
