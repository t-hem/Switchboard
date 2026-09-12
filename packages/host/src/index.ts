import { createRequire } from "node:module";
import path from "node:path";

import { configDir, loadHostConfig } from "./config.js";
import { SessionLedger } from "./ledger.js";
import { ClaimRegistry } from "./claim.js";
import { AgentRegistry } from "./registry.js";
import { buildServer } from "./server.js";
import { SessionManager } from "./sessions.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

async function main(): Promise<void> {
  const { config, created } = loadHostConfig();
  const registry = AgentRegistry.load(config);
  const ledger = SessionLedger.loadAndReconcile();
  const sessions = new SessionManager(config, registry, ledger);
  const claims = new ClaimRegistry();

  const app = await buildServer({
    hostConfig: config,
    registry,
    sessions,
    ledger,
    claims,
    version: pkg.version,
  });

  await app.listen({ port: config.port, host: "0.0.0.0" });

  console.log(`switchboard-host ${pkg.version} — ${config.hostLabel} (${process.platform})`);
  console.log(`listening on http://0.0.0.0:${config.port}`);
  console.log(`config: ${path.join(configDir(), "host.json")}`);
  if (created) {
    console.log("");
    console.log(`  generated token: ${config.token}`);
    console.log("  (shown once — it is also stored in host.json)");
    console.log("");
  }

  const agents = registry.list();
  const available = agents.filter((a) => a.available).map((a) => a.name);
  const missing = agents.filter((a) => !a.available).map((a) => a.name);
  console.log(`agents available: ${available.join(", ") || "(none)"}`);
  if (missing.length > 0) console.log(`agents not installed: ${missing.join(", ")}`);

  const orphans = ledger.orphans;
  if (orphans.length > 0) {
    console.log("");
    console.log(`${orphans.length} orphaned session(s) survived a previous run:`);
    for (const o of orphans) console.log(`  ${o.id}  pid ${o.pid}  ${o.agent}  ${o.cwd}`);
    console.log("Nothing was killed. Use the client, or POST /orphans/kill, to clean up.");
    console.log("");
  }

  // A clean shutdown takes its own sessions with it, so the ledger is left empty and
  // the next start has no orphans to report. Only a crash leaves survivors.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} — killing ${sessions.count} session(s) and shutting down`);
    // Await the kills: exiting early would skip the SIGKILL escalation and strand the
    // very processes this is meant to clean up, with their ledger entries already gone.
    void (async () => {
      await sessions.shutdown();
      await app.close();
      console.log("shutdown complete");
      process.exit(0);
    })();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => shutdown(signal));
  }

  // A pty dying unexpectedly must never take the daemon down (spec §8).
  process.on("uncaughtException", (err) => console.error("[uncaught]", err));
  process.on("unhandledRejection", (err) => console.error("[unhandled]", err));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
