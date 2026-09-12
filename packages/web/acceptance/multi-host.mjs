// Phase 3 acceptance: three daemons, one browser, and one of them powered off.
import puppeteer from "puppeteer";
import fs from "node:fs";
import path from "node:path";

const APP = process.env.APP_URL ?? "http://127.0.0.1:4173";
const REPO = process.env.TEST_REPO;
const OUT = process.env.OUT_DIR ?? "/tmp";
const HOSTS = JSON.parse(process.env.HOSTS); // [{label, url, token, dir}]

let failures = 0;
const ok = (n, c, x = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${n}${x ? `  ${x}` : ""}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const apiOf = (h) => (p, init = {}) =>
  fetch(h.url + p, { ...init, headers: { Authorization: `Bearer ${h.token}`, "Content-Type": "application/json", ...init.headers } });

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

const text = () => page.evaluate(() => document.body.innerText);
const termText = () => page.evaluate(() => document.querySelector(".xterm-rows")?.innerText ?? "");
const has = (h, n) => h.toLowerCase().includes(n.toLowerCase());
const waitFor = async (needle, ms = 15000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (has(await text(), needle)) return true; await sleep(200); }
  return false;
};
const waitTerm = async (needle, ms = 20000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (has(await termText(), needle)) return true; await sleep(250); }
  return false;
};
const setInput = async (sel, value) => {
  await page.focus(sel);
  await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  if (value) await page.type(sel, value);
};
const clickText = async (sel, needle) => {
  const h = await page.evaluateHandle((s, n) =>
    [...document.querySelectorAll(s)].find((el) => el.innerText.trim().toLowerCase().includes(n.toLowerCase())) ?? null, sel, needle);
  const el = h.asElement();
  if (!el) return false;
  await el.click();
  return true;
};
const addHost = async (h) => {
  await setInput('input[placeholder="desktop1"]', h.label);
  await setInput('input[placeholder="http://desktop1:7777"]', h.url);
  await setInput('input[type="password"]', h.token);
  return clickText("button", "Save");
};

console.log("\n=== one session already live on each of the three hosts ===");
for (const h of HOSTS) {
  const r = await apiOf(h)("/sessions", { method: "POST", body: JSON.stringify({ agent: "bash", cwd: REPO }) });
  ok(`${h.label}: session created`, r.status === 201, `got ${r.status}`);
}

console.log("\n=== add all three through the UI ===");
await page.goto(APP, { waitUntil: "networkidle2" });
ok("first host added from the setup screen", await addHost(HOSTS[0]));
ok("session list appeared", await waitFor(HOSTS[0].label));

for (const h of HOSTS.slice(1)) {
  await page.click('button[aria-label="Settings"]');
  await waitFor("Add host");
  await clickText("button", "Add host");
  await page.waitForSelector('input[placeholder="desktop1"]');
  ok(`${h.label}: added from settings`, await addHost(h));
  await sleep(600);
  await clickText("header button", "✕");
  await sleep(300);
}

await sleep(6000);
const listed = await text();
for (const h of HOSTS) ok(`${h.label}: shown in the merged list`, has(listed, h.label));
ok("all three sessions listed", (await page.$$eval("section button", (els) => els.length)) >= 3,
   `${await page.$$eval("section button", (els) => els.length)} rows`);
await page.screenshot({ path: `${OUT}/multi-three-hosts.png` });

console.log("\n=== drive a session on every host ===");
for (const h of HOSTS) {
  const rows = await page.$$('aside section button');
  let clicked = false;
  for (const row of rows) {
    const label = await row.evaluate((el) => el.innerText);
    if (!label.includes("pid")) continue;
    await row.click();
    await sleep(1200);
    const headerText = await page.evaluate(() => document.querySelector("main header")?.innerText ?? "");
    if (headerText.includes(h.label)) { clicked = true; break; }
  }
  if (!clicked) { ok(`${h.label}: could not open its session`, false); continue; }
  await page.waitForSelector(".xterm-screen");
  await page.click(".xterm-screen");
  await page.keyboard.type(`echo MARKER_${h.label}`);
  await page.keyboard.press("Enter");
  ok(`${h.label}: driven from the browser`, await waitTerm(`MARKER_${h.label}`), (await termText()).slice(-120));
}

console.log("\n=== power off the middle host ===");
const victim = HOSTS[1];
process.kill(victim.pid, "SIGKILL");
await sleep(9000);
const afterKill = await text();
ok(`${victim.label}: marked offline`, has(afterKill, "offline"), afterKill.split("\n").slice(0, 12).join(" / "));
ok(`${victim.label}: shows a last-seen time`, /last seen/i.test(afterKill));
ok(`${victim.label}: its sessions stop claiming a known state`,
   has(afterKill, "host unreachable — state unknown"),
   "a green 'working' dot for a host we cannot reach would be a lie");
{
  const labels = await page.$$eval("[aria-label]", (els) => els.map((e) => e.getAttribute("aria-label")));
  ok(`${victim.label}: its session dot reads as unknown`,
     labels.some((l) => l?.includes("unknown")), JSON.stringify(labels.filter(Boolean).slice(0, 8)));
}
for (const h of [HOSTS[0], HOSTS[2]]) {
  ok(`${h.label}: still listed`, has(afterKill, h.label));
  const r = await apiOf(h)("/sessions");
  ok(`${h.label}: daemon still answering`, r.status === 200);
}
await page.screenshot({ path: `${OUT}/multi-one-offline.png` });

console.log("\n=== the survivors are still fully usable ===");
const survivor = HOSTS[2];
const rows = await page.$$('aside section button');
for (const row of rows) {
  const label = await row.evaluate((el) => el.innerText);
  if (!label.includes("pid")) continue;
  await row.click();
  await sleep(1000);
  const headerText = await page.evaluate(() => document.querySelector("main header")?.innerText ?? "");
  if (headerText.includes(survivor.label)) break;
}
await page.click(".xterm-screen");
await page.keyboard.type("echo STILL_WORKS_AFTER_OUTAGE");
await page.keyboard.press("Enter");
ok("a surviving host is still drivable", await waitTerm("STILL_WORKS_AFTER_OUTAGE"), (await termText()).slice(-120));

{
  // Scope this to the modal's own host picker: body.innerText would also match the
  // sidebar behind the modal, where the offline host is legitimately still listed.
  await clickText("aside header button", "New session");
  await waitFor("Directory");
  const options = await page.$$eval("select option", (els) => els.map((e) => e.textContent?.trim() ?? ""));
  ok("offline host is not offered as a target", !options.includes(victim.label), JSON.stringify(options));
  ok("reachable hosts are offered", options.includes(HOSTS[0].label) && options.includes(HOSTS[2].label),
     JSON.stringify(options));
  await clickText("button", "Cancel");
}

console.log("\n=== reorder and remove ===");
await page.click('button[aria-label="Settings"]');
await waitFor("Add host");
const orderBefore = await page.$$eval("section li", (els) => els.map((e) => e.innerText.split("\n")[0]));
await page.click('button[aria-label="Move down"]');
await sleep(400);
const orderAfter = await page.$$eval("section li", (els) => els.map((e) => e.innerText.split("\n")[0]));
ok("reorder changes the order", JSON.stringify(orderBefore) !== JSON.stringify(orderAfter),
   `${orderBefore.join(",")} -> ${orderAfter.join(",")}`);

await page.reload({ waitUntil: "networkidle2" });
await sleep(1500);
await page.click('button[aria-label="Settings"]');
await waitFor("Add host");
const orderReloaded = await page.$$eval("section li", (els) => els.map((e) => e.innerText.split("\n")[0]));
ok("order survives a reload", JSON.stringify(orderReloaded) === JSON.stringify(orderAfter),
   `${orderReloaded.join(",")}`);

ok("remove asks for confirmation first", await clickText("section li button", "Remove"));
await sleep(300);
ok("confirm prompt shown", has(await text(), "Really remove"));
await clickText("section li button", "Really remove");
await sleep(500);
const remaining = await page.$$eval("section li", (els) => els.length);
ok("host removed", remaining === HOSTS.length - 1, `${remaining} left`);

ok("no uncaught exceptions", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
await browser.close();
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
