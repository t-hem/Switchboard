/** Offline operations: no HTTP daemon needed, no agent-protocol interpretation. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { configDir, loadHostConfig } from "./config.js";
import { AgentRegistry } from "./registry.js";
import { SessionLedger } from "./ledger.js";
import { SessionManager } from "./sessions.js";

async function main(): Promise<void> {
  if (process.platform !== "linux") throw new Error("Persistent session recovery is Linux-only");
  const { config } = loadHostConfig();
  if (config.sessionBackend !== "tmux" || !config.tmux) throw new Error("Select the recorded tmux backend/config first");
  const [operation, id] = process.argv.slice(2);
  if (operation === "list") {
    // Read-only inventory remains available even if registry JSON is damaged or host is live.
    const file = path.join(configDir(), "persistent-sessions.json");
    try { console.log(fs.readFileSync(file, "utf8")); }
    catch (err) { console.log(`Registry unreadable: ${err instanceof Error ? err.message : String(err)}`); }
    try {
      console.log(execFileSync("/usr/bin/tmux", ["-S", config.tmux.socketPath, "-N", "list-panes", "-a", "-F",
        "#{session_name} pid=#{pane_pid} dead=#{pane_dead} exit=#{pane_dead_status}"], {encoding:"utf8",timeout:5000}));
    } catch { console.log("Owner socket unavailable; registry retained. Inspect the owner service and workload scopes."); }
    console.log(execFileSync("/usr/bin/systemctl", ["--user", "list-units", "--all", "--no-pager", `sw-${config.tmux.ownerId}-*.scope`], {encoding:"utf8",timeout:5000}));
    return;
  }
  if (!["terminate", "attach"].includes(operation ?? "") || !id) {
    throw new Error("Usage: node dist/recovery-cli.js list | attach <id> | terminate <id> (stop HTTP daemon for attach/terminate)");
  }
  // Exclusive registry ownership refuses control while another daemon is active.
  const sessions = new SessionManager(config, AgentRegistry.load(config), SessionLedger.loadAndReconcile());
  try {
    const session = sessions.get(id);
    if (!session) throw new Error("Unknown session ID; list first");
    if (operation === "terminate") {
      await sessions.kill(id);
      console.log(`Termination confirmed: ${id}`);
    } else {
      if (!process.stdin.isTTY) throw new Error("attach requires an interactive terminal");
      const owner = execFileSync("/usr/bin/tmux", ["-S", config.tmux.socketPath, "-N", "show-options", "-gqv", "@switchboard-owner"], {encoding:"utf8",timeout:5000}).trim();
      if (owner !== config.tmux.ownerId) throw new Error("Owner identity mismatch; refusing attachment");
      const child = spawn("/usr/bin/tmux", ["-S", config.tmux.socketPath, "-N", "attach-session", "-t", `sw-${config.tmux.ownerId}-${id}`], {stdio:"inherit"});
      const detach = (): void => { child.kill("SIGTERM"); };
      process.on("SIGTERM", detach);
      process.on("SIGINT", detach);
      try { await once(child, "exit"); }
      finally {
        process.off("SIGTERM", detach);
        process.off("SIGINT", detach);
      }
    }
  } finally { await sessions.shutdown(); }
}
main().catch((err: unknown) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });
