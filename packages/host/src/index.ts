import { createRequire } from "node:module";
import path from "node:path";

import { configDir, loadHostConfig } from "./config.js";
import { AgentRegistry } from "./registry.js";
import { buildServer } from "./server.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

async function main(): Promise<void> {
  const { config, created } = loadHostConfig();
  const registry = AgentRegistry.load(config);

  const app = await buildServer({
    hostConfig: config,
    registry,
    version: pkg.version,
    sessionCount: () => 0,
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

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void app.close().then(() => process.exit(0));
    });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
