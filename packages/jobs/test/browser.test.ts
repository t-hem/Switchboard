import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ownsProcess, reapOwned, readOwnership, SupervisedBrowser, type BrowserOwnership, type ProcessOps } from "../src/browser.js";

const PROFILE = "/var/lib/switchboard-jobs/browser-profile";
const entry: BrowserOwnership = { pid: 4242, startedAt: "2026-09-16T00:00:00.000Z", profileDir: PROFILE, executablePath: "/usr/bin/chrome" };

// A fake process table: ownership is proven by the profile directory, exactly as in production.
function fakeOps(options: { alive: boolean; commandLine: string | null; survivesSigterm?: boolean; survivesSigkill?: boolean }) {
  const signals: { pid: number; signal: NodeJS.Signals }[] = [];
  let alive = options.alive;
  const ops: ProcessOps = {
    isAlive: () => alive,
    commandLine: () => options.commandLine,
    signal(pid, signal) {
      signals.push({ pid, signal });
      if (signal === "SIGTERM" && !options.survivesSigterm) alive = false;
      if (signal === "SIGKILL" && !options.survivesSigkill) alive = false;
    },
  };
  return { ops, signals };
}

test("ownership is proven by the profile directory, never by the PID alone", () => {
  assert.equal(ownsProcess(entry, fakeOps({ alive: true, commandLine: `/usr/bin/chrome --user-data-dir=${PROFILE} --headless` }).ops), true);
  // A recycled PID running an unrelated process must not be treated as ours.
  assert.equal(ownsProcess(entry, fakeOps({ alive: true, commandLine: "/usr/bin/chrome" }).ops), false);
  assert.equal(ownsProcess(entry, fakeOps({ alive: true, commandLine: null }).ops), false, "an unreadable command line fails closed");
  assert.equal(ownsProcess(entry, fakeOps({ alive: false, commandLine: null }).ops), false);
  assert.equal(ownsProcess(entry, fakeOps({ alive: true, commandLine: `/chrome --user-data-dir=${PROFILE}-other` }).ops), false);
  assert.equal(ownsProcess(entry, fakeOps({ alive: true, commandLine: `/chrome\0--user-data-dir=${PROFILE}\0--headless\0` }).ops), true);
});

test("an unverifiable live PID is dropped, and nothing is signalled", async () => {
  const { ops, signals } = fakeOps({ alive: true, commandLine: "/usr/bin/some-daemon" });
  assert.equal(await reapOwned(entry, ops, { wait: async () => undefined }), "unverified");
  assert.deepEqual(signals, [], "a foreign process is never killed");
});

test("reaping reports killed only after observing the death", async () => {
  const gone = fakeOps({ alive: false, commandLine: null });
  assert.equal(await reapOwned(entry, gone.ops, { wait: async () => undefined }), "already_gone");

  const obeys = fakeOps({ alive: true, commandLine: `/chrome --user-data-dir=${PROFILE}` });
  assert.equal(await reapOwned(entry, obeys.ops, { wait: async () => undefined }), "killed");
  assert.deepEqual(obeys.signals.map(s => s.signal), ["SIGTERM"], "no escalation when SIGTERM works");

  const stubborn = fakeOps({ alive: true, commandLine: `/chrome --user-data-dir=${PROFILE}`, survivesSigterm: true });
  assert.equal(await reapOwned(entry, stubborn.ops, { wait: async () => undefined }), "killed");
  assert.deepEqual(stubborn.signals.map(s => s.signal), ["SIGTERM", "SIGKILL"]);

  const immortal = fakeOps({ alive: true, commandLine: `/chrome --user-data-dir=${PROFILE}`, survivesSigterm: true, survivesSigkill: true });
  assert.equal(await reapOwned(entry, immortal.ops, { wait: async () => undefined }), "failed", "a survivor is reported, never assumed dead");
  assert.equal(await reapOwned(null, immortal.ops), "no_record");
});

test("reapStale removes the record it acted on and keeps a survivor's record", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-browser-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ownershipFile = path.join(dir, "browser-ownership.json");
  fs.writeFileSync(ownershipFile, JSON.stringify({ ...entry, pid: 5252, profileDir: dir }));

  // Verified orphan: reaped and the record is cleared.
  const reaped = new SupervisedBrowser({ executablePath: "/nope", profileDir: dir, ownershipFile,
    ops: fakeOps({ alive: true, commandLine: `/chrome --user-data-dir=${dir}` }).ops, graceMs: 1 });
  assert.equal(await reaped.reapStale(), "killed");
  assert.equal(fs.existsSync(ownershipFile), false);

  // Survivor: the record stays so the operator can still find the process.
  fs.writeFileSync(ownershipFile, JSON.stringify({ ...entry, pid: 5353, profileDir: dir }));
  const stuck = new SupervisedBrowser({ executablePath: "/nope", profileDir: dir, ownershipFile,
    ops: fakeOps({ alive: true, commandLine: `/chrome --user-data-dir=${dir}`, survivesSigterm: true, survivesSigkill: true }).ops, graceMs: 1 });
  assert.equal(await stuck.reapStale(), "failed");
  assert.equal(fs.existsSync(ownershipFile), true);

  // A corrupt or partial record is treated as absent, not acted on.
  fs.writeFileSync(ownershipFile, "{not json");
  assert.equal(readOwnership(ownershipFile), null);
  const missing = new SupervisedBrowser({ executablePath: "/nope", profileDir: dir, ownershipFile, ops: fakeOps({ alive: false, commandLine: null }).ops });
  assert.equal(await missing.reapStale(), "no_record");
  assert.equal(fs.existsSync(ownershipFile), false);
});

test("concurrent callers share one launch instead of starting a second browser on the same profile", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-browser-launch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executablePath = path.join(dir, "chrome");
  fs.writeFileSync(executablePath, "");
  let launches = 0, closed = 0;
  const fake = { connected: true, process: () => null, close: async () => { closed++; } };
  const browser = new SupervisedBrowser({ executablePath, profileDir: path.join(dir, "profile"), ownershipFile: path.join(dir, "owner.json"),
    ops: fakeOps({ alive: false, commandLine: null }).ops,
    launch: async () => { launches++; await new Promise(resolve => setTimeout(resolve, 20)); return fake as never; } });
  const [first, second] = await Promise.all([browser.ensure(), browser.ensure()]);
  assert.equal(launches, 1, "one Chromium per profile");
  assert.equal(first, second);
  assert.equal(await browser.ensure(), first, "a connected browser is reused");

  const racing = new SupervisedBrowser({ executablePath, profileDir: path.join(dir, "profile2"), ownershipFile: path.join(dir, "owner2.json"),
    ops: fakeOps({ alive: false, commandLine: null }).ops,
    launch: async () => { await new Promise(resolve => setTimeout(resolve, 20)); return fake as never; } });
  const pending = racing.ensure();
  await racing.close();
  await pending;
  assert.equal(closed, 1, "closing during a launch still closes the browser it produced");
});
