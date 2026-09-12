// Spec §7 Phase 1 acceptance against a real Claude Code session.
//
// Assertions are made against the *rendered screen*, reconstructed by feeding the
// stream to a headless xterm — exactly what the browser client will do. Matching raw
// bytes does not work for a TUI: it repaints with cursor addressing, so typed text
// never appears as a contiguous run.
//
// All interactions are local (keystrokes only, never Enter), so no model request is made.
import { WebSocket } from "ws";
import xterm from "@xterm/headless";
const { Terminal } = xterm;
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = path.join(os.homedir(), ".switchboard");
const host = JSON.parse(fs.readFileSync(path.join(DIR, "host.json"), "utf8"));
const BASE = `http://127.0.0.1:${host.port}`;
const REPO = process.env.TEST_REPO ?? process.cwd();
const OUT = process.env.OUT_DIR ?? os.tmpdir();

let failures = 0;
const ok = (n, c, x = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${n}${x ? `  ${x}` : ""}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (p, init = {}) =>
  fetch(BASE + p, { ...init, headers: { Authorization: `Bearer ${host.token}`, "Content-Type": "application/json", ...init.headers } });

async function render(bytes, cols = 100, rows = 30) {
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 });
  await new Promise((res) => term.write(bytes, res));
  const buf = term.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  term.dispose();
  return lines.join("\n");
}

const CLIENT_ID = "acceptance-harness";

function connect(id) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${host.port}/sessions/${id}/stream?token=${host.token}` +
      `&clientId=${CLIENT_ID}&clientLabel=acceptance`,
  );
  ws.binaryType = "nodebuffer";
  const st = { out: Buffer.alloc(0), control: [], ws };
  ws.on("message", (d, bin) => { if (bin) st.out = Buffer.concat([st.out, d]); else st.control.push(JSON.parse(d.toString())); });
  st.open = new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  st.send = (o) => ws.send(JSON.stringify(o));
  st.screen = () => render(st.out);
  st.waitForScreen = async (needle, ms = 30000) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      if ((await st.screen()).includes(needle)) return true;
      await sleep(250);
    }
    return false;
  };
  st.type = async (text) => { for (const ch of text) { st.send({ type: "input", data: ch }); await sleep(50); } };
  return st;
}

console.log("\n=== agent availability ===");
const health = await (await fetch(`${BASE}/health`)).json();
ok("claude reports available", health.agents.find((a) => a.name === "claude")?.available === true);

console.log("\n=== spawn a real claude session ===");
const r = await api("/sessions", { method: "POST", body: JSON.stringify({ agent: "claude", cwd: REPO, cols: 100, rows: 30 }) });
const s = await r.json();
ok("POST /sessions -> 201", r.status === 201, `got ${r.status}`);
ok("session is running", s.status === "running");
ok("pid is live", fs.existsSync(`/proc/${s.pid}`), `pid ${s.pid}`);

const c1 = connect(s.id);
await c1.open;
ok("TUI rendered in the pty", await c1.waitForScreen("Claude Code"), `${c1.out.length} bytes`);
ok("stream carries ANSI escapes (real TUI, not degraded pipe mode)", c1.out.includes("\x1b["));

console.log("\n=== keystrokes reach the agent ===");
await sleep(2000);
const TYPED = "hello from switchboard";
await c1.type(TYPED);
ok("typed text appears on the agent's rendered screen", await c1.waitForScreen(TYPED, 15000));
fs.writeFileSync(`${OUT}/claude-screen-1.txt`, await c1.screen());

console.log("\n=== disconnect, keep running, reconnect ===");
c1.ws.close();
await sleep(3000);
ok("session survived the client disconnect", (await (await api(`/sessions/${s.id}`)).json()).status === "running");

const c2 = connect(s.id);
await c2.open;
await sleep(2000);
fs.writeFileSync(`${OUT}/claude-replay.bin`, c2.out);
const replayScreen = await c2.screen();
fs.writeFileSync(`${OUT}/claude-screen-2.txt`, replayScreen);
ok("replayed scrollback is non-empty", c2.out.length > 0, `${c2.out.length} bytes`);
ok("replay reconstructs the TUI", replayScreen.includes("Claude Code"));
ok("replay reconstructs what was typed before the disconnect", replayScreen.includes(TYPED));
ok("replay fits the configured scrollback", c2.out.length <= host.scrollbackBytes, `${c2.out.length} <= ${host.scrollbackBytes}`);

console.log("\n=== live streaming resumes after replay ===");
const TYPED2 = " and again after reconnecting";
await c2.type(TYPED2);
ok("new keystrokes render on the reconnected socket", await c2.waitForScreen(TYPED + TYPED2, 15000));

console.log("\n=== resize reflows the TUI ===");
const before = c2.out.length;
c2.send({ type: "resize", cols: 140, rows: 45 });
await sleep(2000);
ok("agent redrew after resize", c2.out.length > before, `${c2.out.length - before} bytes of redraw`);
ok("metadata reflects the resize", (await (await api(`/sessions/${s.id}`)).json()).cols === 140);
ok("typed text survived the reflow", (await render(c2.out, 140, 45)).includes(TYPED));

console.log("\n=== ledger ===");
ok("ledger records the claude session", JSON.parse(fs.readFileSync(path.join(DIR, "sessions.json"), "utf8")).some((e) => e.id === s.id));

console.log("\n=== delete removes the process ===");
c2.ws.close();
const d = await api(`/sessions/${s.id}`, { method: "DELETE" });
ok("DELETE -> 204", d.status === 204, `got ${d.status}`);
for (let i = 0; i < 60 && fs.existsSync(`/proc/${s.pid}`); i++) await sleep(200);
ok("claude process gone from the OS process list", !fs.existsSync(`/proc/${s.pid}`), `pid ${s.pid}`);
ok("session gone from /sessions", (await api(`/sessions/${s.id}`)).status === 404);
ok("ledger entry removed", !JSON.parse(fs.readFileSync(path.join(DIR, "sessions.json"), "utf8")).some((e) => e.id === s.id));

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
