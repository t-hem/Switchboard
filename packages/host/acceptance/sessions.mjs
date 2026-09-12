// Phase 1 acceptance harness. Drives the daemon over HTTP + WS exactly as the
// browser client will, using a `bash` agent so output is deterministic.
import { WebSocket } from "ws";
import fs from "node:fs";
import path from "node:path";

const DIR = process.env.SWITCHBOARD_DIR;
const host = JSON.parse(fs.readFileSync(path.join(DIR, "host.json"), "utf8"));
const BASE = `http://127.0.0.1:${host.port}`;
const TOKEN = host.token;
const REPO = process.env.TEST_REPO ?? process.cwd();

let failures = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = (p, init = {}) =>
  fetch(BASE + p, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...init.headers },
  });

function connect(id, token = TOKEN) {
  const ws = new WebSocket(`ws://127.0.0.1:${host.port}/sessions/${id}/stream?token=${token}`);
  ws.binaryType = "nodebuffer";
  const state = { out: Buffer.alloc(0), control: [], ws, closed: null };
  ws.on("message", (d, isBinary) => {
    if (isBinary) state.out = Buffer.concat([state.out, d]);
    else state.control.push(JSON.parse(d.toString()));
  });
  ws.on("close", (code) => { state.closed = code; });
  state.open = new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
    ws.on("close", (c) => rej(new Error(`closed before open: ${c}`)));
  });
  state.send = (o) => ws.send(JSON.stringify(o));
  state.waitFor = async (needle, ms = 8000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (state.out.includes(needle)) return true;
      await sleep(50);
    }
    return false;
  };
  return state;
}

console.log("\n=== auth ===");
{
  const r = await fetch(`${BASE}/health`);
  ok("GET /health needs no token", r.status === 200);
  const n = await fetch(`${BASE}/sessions`);
  ok("GET /sessions without token -> 401", n.status === 401, `got ${n.status}`);
  const w = await fetch(`${BASE}/sessions`, { headers: { Authorization: "Bearer wrong-token-here" } });
  ok("GET /sessions with wrong token -> 401", w.status === 401, `got ${w.status}`);
  const g = await api("/sessions");
  ok("GET /sessions with token -> 200", g.status === 200, `got ${g.status}`);
}

console.log("\n=== validation ===");
{
  const a = await api("/sessions", { method: "POST", body: JSON.stringify({ agent: "nope", cwd: REPO }) });
  ok("unknown agent -> 400", a.status === 400, `got ${a.status}`);
  const c = await api("/sessions", { method: "POST", body: JSON.stringify({ agent: "bash", cwd: path.join(REPO, "does-not-exist") }) });
  ok("missing cwd -> 400", c.status === 400, `got ${c.status}`);
  const f = await api("/sessions", { method: "POST", body: JSON.stringify({ agent: "bash", cwd: path.join(REPO, "README.md") }) });
  ok("cwd that is a file -> 400", f.status === 400, `got ${f.status}`);
  const u = await api("/sessions/does-not-exist");
  ok("unknown session -> 404", u.status === 404, `got ${u.status}`);
  const ws = connect("anything", "wrong-token");
  await ws.open.then(() => ok("WS with wrong token rejected", false, "connected!")).catch(() => ok("WS with wrong token rejected", true));
}

console.log("\n=== spawn ===");
const created = await (await api("/sessions", {
  method: "POST",
  body: JSON.stringify({ agent: "bash", cwd: REPO, cols: 100, rows: 30 }),
})).json();
ok("POST /sessions returns a session", typeof created.id === "string", JSON.stringify(created));
ok("status is running", created.status === "running");
ok("pid is live", fs.existsSync(`/proc/${created.pid}`), `pid ${created.pid}`);
ok("label defaults to basename · agent", created.label === `${path.basename(REPO)} · bash`, created.label);
ok("cols/rows honoured", created.cols === 100 && created.rows === 30);

console.log("\n=== ledger written on spawn ===");
{
  const led = JSON.parse(fs.readFileSync(path.join(DIR, "sessions.json"), "utf8"));
  const e = led.find((x) => x.id === created.id);
  ok("sessions.json has the entry", !!e);
  ok("entry records pid", e?.pid === created.pid);
  ok("entry records processStartTime", typeof e?.processStartTime === "string" && e.processStartTime.length > 0, e?.processStartTime);
  ok("entry records agent/cwd/startedAt", e?.agent === "bash" && e?.cwd === REPO && typeof e?.startedAt === "number");
}

console.log("\n=== stream: input and output ===");
const s1 = connect(created.id);
await s1.open;
s1.send({ type: "input", data: "echo HELLO_FROM_SWITCHBOARD\r" });
ok("sees command output", await s1.waitFor("HELLO_FROM_SWITCHBOARD"));

console.log("\n=== resize reaches the process ===");
s1.send({ type: "resize", cols: 120, rows: 40 });
await sleep(300);
s1.out = Buffer.alloc(0);
s1.send({ type: "input", data: "echo COLS=$(tput cols)\r" });
ok("tput reports the new width", await s1.waitFor("COLS=120"), s1.out.toString().slice(-120).replace(/\s+/g, " "));
{
  const s = await (await api(`/sessions/${created.id}`)).json();
  ok("session metadata reflects resize", s.cols === 120 && s.rows === 40, `${s.cols}x${s.rows}`);
}

console.log("\n=== scrollback replay across a disconnect ===");
s1.send({ type: "input", data: "(for i in 1 2 3; do sleep 1; echo WHILE_GONE_$i; done) &\r" });
await sleep(300);
s1.ws.close();
await sleep(4500);
const s2 = connect(created.id);
await s2.open;
await sleep(600);
ok("replay includes output from before the disconnect", s2.out.includes("HELLO_FROM_SWITCHBOARD"));
ok("replay includes WHILE_GONE_1", s2.out.includes("WHILE_GONE_1"));
ok("replay includes WHILE_GONE_2", s2.out.includes("WHILE_GONE_2"));
ok("replay includes WHILE_GONE_3", s2.out.includes("WHILE_GONE_3"));
ok("session survived client disconnect", (await (await api(`/sessions/${created.id}`)).json()).status === "running");

console.log("\n=== live streaming resumes after replay ===");
s2.out = Buffer.alloc(0);
s2.send({ type: "input", data: "echo BACK_LIVE\r" });
ok("new output arrives on the new socket", await s2.waitFor("BACK_LIVE"));

console.log("\n=== two clients on one session ===");
{
  const s3 = connect(created.id);
  await s3.open;
  await sleep(400);
  ok("second client gets the same replay", s3.out.includes("BACK_LIVE"));
  s2.out = Buffer.alloc(0);
  s3.out = Buffer.alloc(0);
  s3.send({ type: "input", data: "echo FROM_THIRD\r" });
  ok("both sockets see it", (await s3.waitFor("FROM_THIRD")) && (await s2.waitFor("FROM_THIRD")));
  s3.ws.close();
}

console.log("\n=== scrollback is capped at scrollbackBytes ===");
{
  const big = await (await api("/sessions", { method: "POST", body: JSON.stringify({ agent: "bash", cwd: REPO }) })).json();
  const b1 = connect(big.id);
  await b1.open;
  b1.send({ type: "input", data: "head -c 200000 /dev/zero | tr '\\0' 'x'; echo; echo TAIL_MARKER\r" });
  ok("burst finished", await b1.waitFor("TAIL_MARKER", 20000));
  await sleep(500);
  b1.ws.close();
  const b2 = connect(big.id);
  await b2.open;
  await sleep(800);
  ok(`replay capped at ${host.scrollbackBytes}B`, b2.out.length <= host.scrollbackBytes, `got ${b2.out.length}B`);
  ok("replay keeps the newest bytes", b2.out.includes("TAIL_MARKER"));
  b2.ws.close();
  await api(`/sessions/${big.id}`, { method: "DELETE" });
}

console.log("\n=== exit handling ===");
{
  const ex = await (await api("/sessions", { method: "POST", body: JSON.stringify({ agent: "bash", cwd: REPO }) })).json();
  const e1 = connect(ex.id);
  await e1.open;
  e1.send({ type: "input", data: "exit 7\r" });
  await sleep(1200);
  ok("exit control frame delivered", e1.control.some((c) => c.type === "exit" && c.exitCode === 7), JSON.stringify(e1.control));
  const after = await (await api(`/sessions/${ex.id}`)).json();
  ok("session marked exited with code", after.status === "exited" && after.exitCode === 7, JSON.stringify(after));
  ok("exited session left the ledger", !JSON.parse(fs.readFileSync(path.join(DIR, "sessions.json"), "utf8")).some((x) => x.id === ex.id));
  ok("process is gone from the OS", !fs.existsSync(`/proc/${ex.pid}`));
  e1.ws.close();
  await api(`/sessions/${ex.id}`, { method: "DELETE" });
  ok("DELETE of an exited session removes it", (await api(`/sessions/${ex.id}`)).status === 404);
}

console.log("\n=== workspaces ===");
{
  const r = await api("/workspaces");
  const list = await r.json();
  ok("GET /workspaces returns an array", Array.isArray(list), JSON.stringify(list));
  ok("finds the git repo under the configured root", list.includes(REPO), JSON.stringify(list));
}

console.log("\n=== delete kills the process ===");
{
  const pid = created.pid;
  s2.ws.close();
  const d = await api(`/sessions/${created.id}`, { method: "DELETE" });
  ok("DELETE -> 204", d.status === 204, `got ${d.status}`);
  // Interactive bash ignores SIGTERM; it dies at the 3s SIGKILL escalation.
  for (let i = 0; i < 60 && fs.existsSync(`/proc/${pid}`); i++) await sleep(200);
  ok("process gone from OS process list", !fs.existsSync(`/proc/${pid}`), `pid ${pid}`);
  ok("session gone from /sessions", (await api(`/sessions/${created.id}`)).status === 404);
  ok("session gone from ledger", !JSON.parse(fs.readFileSync(path.join(DIR, "sessions.json"), "utf8")).some((x) => x.id === created.id));
  ok("sessionCount back to 0", (await (await fetch(`${BASE}/health`)).json()).sessionCount === 0);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
