// Simulates a daemon crash and verifies orphan reconciliation end to end.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST_PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.OUT_DIR ?? os.tmpdir();

const DIR = process.env.SWITCHBOARD_DIR;
const REPO = process.env.TEST_REPO ?? process.cwd();
const host = JSON.parse(fs.readFileSync(path.join(DIR, "host.json"), "utf8"));
const BASE = `http://127.0.0.1:${host.port}`;
const api = (p, init = {}) =>
  fetch(BASE + p, { ...init, headers: { Authorization: `Bearer ${host.token}`, "Content-Type": "application/json", ...init.headers } });

let failures = 0;
const ok = (n, c, x = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${n}${x ? `  ${x}` : ""}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => fs.existsSync(`/proc/${pid}`);

async function startDaemon(logSuffix) {
  const log = fs.openSync(`${OUT}/orphan-host-${logSuffix}.log`, "w");
  const d = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: HOST_PKG,
    env: { ...process.env, SWITCHBOARD_DIR: DIR },
    stdio: ["ignore", log, log],
    detached: true,
  });
  d.unref();
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return d; } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("daemon did not start");
}

// The daemon is its own process group leader (detached), so the whole group must go
// down together to mimic a hard crash rather than a tidy shutdown.
const hardKill = (d) => { try { process.kill(-d.pid, "SIGKILL"); } catch { /* gone */ } };

console.log("\n=== spawn two sessions, then hard-kill the daemon ===");
const d1 = await startDaemon("1");
const plain = await (await api("/sessions", { method: "POST", body: JSON.stringify({ agent: "bash", cwd: REPO }) })).json();
const surv = await (await api("/sessions", { method: "POST", body: JSON.stringify({ agent: "survivor", cwd: REPO }) })).json();
await sleep(1000);
ok("both sessions running", alive(plain.pid) && alive(surv.pid), `${plain.pid}, ${surv.pid}`);
ok("ledger has both", JSON.parse(fs.readFileSync(path.join(DIR, "sessions.json"), "utf8")).length === 2);

hardKill(d1);
await sleep(2500);
console.log(`  (after crash: plain bash pid ${plain.pid} alive=${alive(plain.pid)}, survivor pid ${surv.pid} alive=${alive(surv.pid)})`);
ok("ledger file survived the crash", JSON.parse(fs.readFileSync(path.join(DIR, "sessions.json"), "utf8")).length === 2);
ok("the HUP-ignoring session outlived the daemon", alive(surv.pid), `pid ${surv.pid}`);

console.log("\n=== restart: reconcile ===");
const d2 = await startDaemon("2");
const orphans = await (await api("/orphans")).json();
console.log(`  reported orphans: ${JSON.stringify(orphans.map((o) => ({ id: o.id, pid: o.pid, agent: o.agent })))}`);
ok("survivor is reported as an orphan", orphans.some((o) => o.pid === surv.pid));
ok("dead session is not reported", !orphans.some((o) => o.pid === plain.pid) || alive(plain.pid));
ok("orphan entries carry a verifiable start time", orphans.every((o) => typeof o.processStartTime === "string" && o.processStartTime.length > 0));
ok("orphans are NOT killed automatically", alive(surv.pid), "still running after restart");
ok("startup logged the survivors", fs.readFileSync(`${OUT}/orphan-host-2.log`, "utf8").includes("orphaned session(s) survived"));

console.log("\n=== kill all orphans ===");
const results = await (await api("/orphans/kill", { method: "POST", body: JSON.stringify({}) })).json();
console.log(`  results: ${JSON.stringify(results)}`);
ok("survivor reported killed", results.some((r) => r.outcome === "killed"));
await sleep(1500);
ok("survivor process is gone", !alive(surv.pid), `pid ${surv.pid}`);
ok("orphan list is now empty", (await (await api("/orphans")).json()).length === 0);
ok("ledger file is empty", JSON.parse(fs.readFileSync(path.join(DIR, "sessions.json"), "utf8")).length === 0);

console.log("\n=== clean shutdown leaves nothing behind ===");
const s = await (await api("/sessions", { method: "POST", body: JSON.stringify({ agent: "survivor", cwd: REPO }) })).json();
await sleep(800);
process.kill(-d2.pid, "SIGTERM");
await sleep(3000);
ok("clean shutdown killed its session", !alive(s.pid), `pid ${s.pid}`);
ok("clean shutdown left an empty ledger", JSON.parse(fs.readFileSync(path.join(DIR, "sessions.json"), "utf8")).length === 0);
const d3 = await startDaemon("3");
ok("next start reports no orphans", (await (await api("/orphans")).json()).length === 0);
process.kill(-d3.pid, "SIGKILL");

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
