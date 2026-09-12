// Phase 3.5 acceptance: agent config sync across three hosts, end to end.
import puppeteer from "puppeteer";
import fs from "node:fs";
import path from "node:path";

const APP = process.env.APP_URL ?? "http://127.0.0.1:4173";
const OUT = process.env.OUT_DIR ?? "/tmp";
const HOSTS = JSON.parse(process.env.HOSTS);
const INSTALL_DIR = process.env.INSTALL_DIR; // on bravo's pathPrepend only

let failures = 0;
const ok = (n, c, x = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${n}${x ? `  ${x}` : ""}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const apiOf = (h) => (p, init = {}) =>
  fetch(h.url + p, { ...init, headers: { Authorization: `Bearer ${h.token}`, "Content-Type": "application/json", ...init.headers } });
const cfg = async (h) => (await apiOf(h)("/config/agents")).json();

console.log("\n=== daemon: GET /config/agents ===");
for (const h of HOSTS) {
  const c = await cfg(h);
  ok(`${h.label}: returns the map plus a per-host availability block`,
     typeof c.updatedAt === "number" && !!c.agents && !!c.availability, JSON.stringify(Object.keys(c)));
}

console.log("\n=== daemon: PUT rejects a stale write, unless forced ===");
{
  const h = HOSTS[0];
  const before = await cfg(h);
  const stale = { updatedAt: before.updatedAt - 1000, agents: { ...before.agents, sneaky: { cmd: "sneaky" } } };
  const r = await apiOf(h)("/config/agents", { method: "PUT", body: JSON.stringify(stale) });
  ok("older updatedAt -> 409", r.status === 409, `got ${r.status}`);
  ok("the stale write did not land", !(await cfg(h)).agents.sneaky);

  const forced = await apiOf(h)("/config/agents?force=1", { method: "PUT", body: JSON.stringify(stale) });
  ok("?force=1 overrides the guard", forced.status === 200, `got ${forced.status}`);
  ok("forced write landed", !!(await cfg(h)).agents.sneaky);

  // Put it back.
  await apiOf(h)("/config/agents", { method: "PUT", body: JSON.stringify({ updatedAt: Date.now(), agents: before.agents }) });
  ok("cleanup restored the original map", !(await cfg(h)).agents.sneaky);
}

console.log("\n=== daemon: a malformed map is refused ===");
{
  const h = HOSTS[0];
  for (const [name, body] of [
    ["agents not an object", { updatedAt: Date.now(), agents: [] }],
    ["agent missing cmd", { updatedAt: Date.now(), agents: { x: { args: [] } } }],
    ["args not strings", { updatedAt: Date.now(), agents: { x: { cmd: "x", args: [1, 2] } } }],
  ]) {
    const r = await apiOf(h)("/config/agents", { method: "PUT", body: JSON.stringify(body) });
    ok(`rejected: ${name}`, r.status === 400, `got ${r.status}`);
  }
}

console.log("\n=== browser: add an agent on alpha through the settings screen ===");
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 950 });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

const text = () => page.evaluate(() => document.body.innerText);
const has = (h, n) => h.toLowerCase().includes(n.toLowerCase());
const waitFor = async (needle, ms = 20000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (has(await text(), needle)) return true; await sleep(250); }
  return false;
};
const setInput = async (sel, v) => {
  await page.focus(sel);
  await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  if (v) await page.type(sel, v);
};
const clickText = async (sel, needle) => {
  const h = await page.evaluateHandle((s, n) =>
    [...document.querySelectorAll(s)].find((el) => el.innerText.trim().toLowerCase().includes(n.toLowerCase())) ?? null, sel, needle);
  const el = h.asElement();
  if (!el) return false;
  await el.click();
  return true;
};

await page.evaluateOnNewDocument((hosts) => {
  localStorage.setItem("switchboard.hosts", JSON.stringify(
    hosts.map((h, i) => ({ id: `h${i}`, label: h.label, baseUrl: h.url, token: h.token }))));
}, HOSTS);
await page.goto(APP, { waitUntil: "networkidle2" });
await sleep(3000);
ok("all three hosts listed", HOSTS.every((h) => has("" + "", "")) && (await text()).length > 0);

await page.click('button[aria-label="Settings"]');
ok("agents editor is present in settings", await waitFor("Add agent"));
await clickText("button", "Add agent");
await sleep(400);

// The new row is the last one; fill in name, cmd and install hint.
await page.waitForSelector("section li input");
ok("new agent row appeared",
   (await page.$$eval("section li input", (els) => els.map((e) => e.value))).some((v) => v.startsWith("new-agent")),
   JSON.stringify(await page.$$eval("section li input", (els) => els.map((e) => e.value))));
await setInput("section li:last-child input", "deepseek");
await page.keyboard.press("Tab");
await sleep(300);
const cmdSel = 'section li:last-child input[value=""]';
const inputs = await page.$$("section li:last-child input");
// order: name, cmd, args, install
if (inputs[1]) { await inputs[1].focus(); await page.keyboard.type("deepseek"); }
if (inputs[3]) { await inputs[3].focus(); await page.keyboard.type("npm i -g deepseek-cli"); }
await sleep(300);
ok("saved to alpha", await clickText("section button", "Save to alpha"));
ok("save confirmed", await waitFor("Saved to alpha"), (await text()).slice(0, 200));

console.log("\n=== drift is detected and reviewable ===");
await clickText("header button", "✕");
await sleep(1500);
ok("drift banner appears", await waitFor("Agent config differs across hosts"), (await text()).slice(0, 200));
ok("banner names the newest host", has(await text(), "newest is on alpha"));
await page.screenshot({ path: `${OUT}/sync-banner.png` });

ok("review opens", await clickText("button", "Review"));
ok("diff lists the stale hosts", await waitFor("bravo") && has(await text(), "charlie"));
ok("diff marks the new agent as added", has(await text(), "added") && has(await text(), "deepseek"));
await page.screenshot({ path: `${OUT}/sync-diff.png` });

console.log("\n=== sync all to newest ===");
ok("sync clicked", await clickText("footer button", "Sync all to newest"));
await sleep(3000);
for (const h of HOSTS) {
  const c = await cfg(h);
  ok(`${h.label}: has the new agent`, !!c.agents.deepseek, JSON.stringify(Object.keys(c.agents)));
}
const stamps = await Promise.all(HOSTS.map(async (h) => (await cfg(h)).updatedAt));
ok("all hosts now carry the same updatedAt", new Set(stamps).size === 1, JSON.stringify(stamps));
ok("drift banner is gone", await (async () => { await sleep(2000); return !has(await text(), "differs across hosts"); })());

console.log("\n=== unavailable agents show a copyable install command ===");
for (const h of HOSTS) {
  const c = await cfg(h);
  ok(`${h.label}: deepseek probes as not installed`, c.availability.deepseek === false);
}
await page.click('button[aria-label="Settings"]');
await waitFor("Add agent");
await sleep(1500);
const editorText = await text();
fs.writeFileSync(`${OUT}/sync-editor-dump.txt`, editorText);
ok("editor shows it as missing on this host", has(editorText, "not on"), editorText.slice(0, 400));
ok("install hint is rendered", has(editorText, "npm i -g deepseek-cli"));
ok("install hint has a copy button", await clickText("li button", "copy"));
await page.screenshot({ path: `${OUT}/sync-install-hint.png` });

console.log("\n=== installing it on one host flips availability, no restart ===");
fs.mkdirSync(INSTALL_DIR, { recursive: true });
const fake = path.join(INSTALL_DIR, "deepseek");
fs.writeFileSync(fake, "#!/bin/sh\necho deepseek\n");
fs.chmodSync(fake, 0o755);
console.log(`  (created ${fake}, which is on bravo's pathPrepend only)`);

let flipped = false;
for (let i = 0; i < 30; i++) {
  const c = await cfg(HOSTS[1]);
  if (c.availability.deepseek === true) { flipped = true; break; }
  await sleep(1000);
}
ok("bravo flipped to available without a restart", flipped);
ok("alpha still reports it missing", (await cfg(HOSTS[0])).availability.deepseek === false);
ok("charlie still reports it missing", (await cfg(HOSTS[2])).availability.deepseek === false);
ok("availability was not synced (it is per-host)",
   (await cfg(HOSTS[1])).updatedAt === (await cfg(HOSTS[0])).updatedAt);

ok("no uncaught exceptions", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
await browser.close();
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
