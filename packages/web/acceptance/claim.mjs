// Phase 4 acceptance: two browsers, one host, and a session that must survive both.
import puppeteer from "puppeteer";

const APP = process.env.APP_URL ?? "http://127.0.0.1:4173";
const HOST_URL = process.env.HOST_URL ?? "http://127.0.0.1:7788";
const TOKEN = process.env.HOST_TOKEN;
const REPO = process.env.TEST_REPO;
const OUT = process.env.OUT_DIR ?? "/tmp";

let failures = 0;
const ok = (n, c, x = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${n}${x ? `  ${x}` : ""}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (p, init = {}) =>
  fetch(HOST_URL + p, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...init.headers } });

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

// Separate browser contexts = separate localStorage = genuinely different devices,
// each with its own clientId.
async function device(label, width, height) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width, height });
  await page.evaluateOnNewDocument((hostUrl, token, deviceLabel) => {
    localStorage.setItem("switchboard.hosts", JSON.stringify([
      { id: "h0", label: "testbox", baseUrl: hostUrl, token },
    ]));
    localStorage.setItem("switchboard.clientLabel", deviceLabel);
  }, HOST_URL, TOKEN, label);
  await page.goto(APP, { waitUntil: "networkidle2" });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  return {
    label, page, errs, context,
    text: () => page.evaluate(() => document.body.innerText),
    term: () => page.evaluate(() => document.querySelector(".xterm-rows")?.innerText ?? ""),
    async waitFor(needle, ms = 15000) {
      const t = Date.now();
      while (Date.now() - t < ms) {
        if ((await this.text()).toLowerCase().includes(needle.toLowerCase())) return true;
        await sleep(250);
      }
      return false;
    },
    async waitTerm(needle, ms = 20000) {
      const t = Date.now();
      while (Date.now() - t < ms) {
        if ((await this.term()).includes(needle)) return true;
        await sleep(250);
      }
      return false;
    },
    async openFirstSession() {
      await page.waitForSelector("aside section button");
      const rows = await page.$$("aside section button");
      for (const row of rows) {
        if ((await row.evaluate((el) => el.innerText)).includes("pid")) { await row.click(); return true; }
      }
      return false;
    },
  };
}

console.log("\n=== a session is running before either device connects ===");
const created = await (await api("/sessions", { method: "POST", body: JSON.stringify({ agent: "bash", cwd: REPO }) })).json();
ok("session created", created.status === "running", `pid ${created.pid}`);

console.log("\n=== desktop attaches and starts work ===");
const desktop = await device("desktop", 1280, 800);
await sleep(2500);
ok("desktop sees the session", await desktop.openFirstSession());
ok("desktop connected", await desktop.waitFor("connected"));
await desktop.page.click(".xterm-screen");
await desktop.page.keyboard.type("echo WORK_BEFORE_TAKEOVER");
await desktop.page.keyboard.press("Enter");
ok("desktop is driving the session", await desktop.waitTerm("WORK_BEFORE_TAKEOVER"));

const claimant1 = await (await api("/control/claim", { method: "POST", body: JSON.stringify({ clientId: "probe", clientLabel: "probe" }) })).json();
ok("claim endpoint reports the previous holder", claimant1.evicted !== null, JSON.stringify(claimant1));
// That probe stole the claim; give it back to the desktop by refocusing it.
await desktop.page.bringToFront();
await desktop.page.evaluate(() => window.dispatchEvent(new Event("focus")));
await sleep(1500);
await desktop.page.reload({ waitUntil: "networkidle2" });
await sleep(2500);
await desktop.openFirstSession();
ok("desktop reattached after reclaiming", await desktop.waitFor("connected"));

console.log("\n=== phone takes over ===");
const phone = await device("phone", 390, 780);
await sleep(3000);
ok("phone sees the same session", await phone.openFirstSession());
ok("phone connected", await phone.waitFor("connected"));

ok("desktop shows the takeover banner", await desktop.waitFor("Taken over by phone", 12000),
   (await desktop.text()).slice(0, 240));
ok("desktop stopped claiming to be connected", !(await desktop.text()).includes("connected"),
   (await desktop.text()).slice(0, 200));
await desktop.page.screenshot({ path: `${OUT}/claim-desktop-evicted.png` });
await phone.page.screenshot({ path: `${OUT}/claim-phone.png` });

console.log("\n=== the session kept running through the takeover ===");
const still = await (await api(`/sessions/${created.id}`)).json();
ok("session still running", still.status === "running");
await phone.page.click(".xterm-screen");
await phone.page.keyboard.type("echo WORK_FROM_PHONE");
await phone.page.keyboard.press("Enter");
ok("phone can drive it", await phone.waitTerm("WORK_FROM_PHONE"));
ok("phone's replay still shows the desktop's earlier work", (await phone.term()).includes("WORK_BEFORE_TAKEOVER"),
   (await phone.term()).slice(-200));

console.log("\n=== a non-claimant is refused at the upgrade ===");
{
  const ws = await import("ws");
  const url = `${HOST_URL.replace("http", "ws")}/sessions/${created.id}/stream?token=${TOKEN}&clientId=stranger&clientLabel=stranger`;
  const result = await new Promise((resolve) => {
    const socket = new ws.WebSocket(url);
    socket.on("open", () => { socket.close(); resolve("opened"); });
    socket.on("unexpected-response", (_req, res) => resolve(`http ${res.statusCode}`));
    socket.on("error", (e) => resolve(`error ${e.message}`));
  });
  ok("non-claimant rejected with 403", result === "http 403", String(result));
}

console.log("\n=== take back from the desktop ===");
ok("take back clicked", await (async () => {
  const h = await desktop.page.evaluateHandle(() =>
    [...document.querySelectorAll("button")].find((b) => b.innerText.includes("Take back")) ?? null);
  const el = h.asElement();
  if (!el) return false;
  await el.click();
  return true;
})());
ok("desktop reconnects", await desktop.waitFor("connected", 15000), (await desktop.text()).slice(0, 200));
ok("desktop banner cleared", !(await desktop.text()).includes("Taken over"));
ok("desktop replay includes the phone's work", await desktop.waitTerm("WORK_FROM_PHONE", 15000),
   (await desktop.term()).slice(-200));
ok("phone now shows the takeover banner", await phone.waitFor("Taken over by desktop", 12000),
   (await phone.text()).slice(0, 240));

console.log("\n=== the work survived all of it ===");
const final = await (await api(`/sessions/${created.id}`)).json();
ok("same session, same pid, still running", final.status === "running" && final.pid === created.pid,
   `pid ${final.pid} vs ${created.pid}`);
ok("scrollback retained both devices' output",
   (await desktop.term()).includes("WORK_BEFORE_TAKEOVER") && (await desktop.term()).includes("WORK_FROM_PHONE"));

ok("no uncaught exceptions on desktop", desktop.errs.length === 0, desktop.errs.slice(0, 2).join(" | "));
ok("no uncaught exceptions on phone", phone.errs.length === 0, phone.errs.slice(0, 2).join(" | "));

await api(`/sessions/${created.id}`, { method: "DELETE" });
await browser.close();
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
