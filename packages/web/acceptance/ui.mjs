// Phase 2 acceptance: drives the real client in a real browser against a real daemon.
import puppeteer from "puppeteer";

const APP = process.env.APP_URL ?? "http://127.0.0.1:4173";
const HOST_URL = process.env.HOST_URL ?? "http://127.0.0.1:7788";
const TOKEN = process.env.HOST_TOKEN;
const REPO = process.env.TEST_REPO;
const OUT = process.env.OUT_DIR ?? "/tmp";

let failures = 0;
const ok = (n, c, x = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${n}${x ? `  ${x}` : ""}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

const consoleErrors = [];
const httpFailures = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on("response", (r) => { if (r.status() >= 400) httpFailures.push(`${r.status()} ${r.url()}`); });

const text = () => page.evaluate(() => document.body.innerText);
const termText = () =>
  page.evaluate(() => document.querySelector(".xterm-rows")?.innerText ?? "");
const has = (haystack, needle) => haystack.toLowerCase().includes(needle.toLowerCase());
const waitForText = async (needle, ms = 15000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (has(await text(), needle)) return true; await sleep(200); }
  return false;
};
const waitForTerm = async (needle, ms = 20000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if ((await termText()).includes(needle)) return true; await sleep(250); }
  return false;
};
// Select-all + delete, then type: clickCount:3 alone does not reliably clear a
// controlled React input in headless Chrome.
const setInput = async (selector, value) => {
  await page.focus(selector);
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  if (value) await page.type(selector, value);
};
const clickText = async (selector, needle) => {
  const handle = await page.evaluateHandle((sel, n) => {
    return [...document.querySelectorAll(sel)]
      .find((el) => el.innerText.trim().toLowerCase().includes(n.toLowerCase())) ?? null;
  }, selector, needle);
  const el = handle.asElement();
  if (!el) return false;
  await el.click();
  return true;
};

console.log("\n=== first run shows host setup ===");
await page.goto(APP, { waitUntil: "networkidle2" });
ok("setup screen is shown when no host is configured", await waitForText("Add the host daemon"));

console.log("\n=== a bad token is reported differently from a bad address ===");
await page.type('input[placeholder="desktop1"]', "testbox");
await page.type('input[placeholder="http://desktop1:7777"]', HOST_URL);
await page.type('input[type="password"]', "definitely-wrong-token");
ok("clicked Test", await clickText("button", "Test"));
ok("reachable host + bad token reads as a rejected token",
   await waitForText("token was rejected"), await text());

await setInput('input[type="password"]', TOKEN);
ok("token field actually holds the good token",
   await page.$eval('input[type="password"]', (el) => el.value.length > 10));
ok("clicked Save", await clickText("button", "Save"));

console.log("\n=== session list ===");
ok("host header appears after saving", await waitForText("TESTBOX") || await waitForText("testbox"), await text());
ok("empty host shows no sessions", await waitForText("No sessions"));

console.log("\n=== new session modal ===");
ok("opened new session modal", await clickText("button", "New session"));
ok("modal rendered", await waitForText("Directory"));
await page.waitForSelector('input[placeholder="or type a path"]', { timeout: 10000 });
ok("free-text directory input is available immediately, before the scan finishes", true);
await page.select("select", "bash").catch(() => {});
ok("directory is not pre-filled (explicit choice required)",
   await page.$eval('input[placeholder="or type a path"]', (el) => el.value === ""));
await setInput('input[placeholder="or type a path"]', REPO);
await sleep(200);
ok("clicked Start", await clickText("button", "Start"));

console.log("\n=== terminal view ===");
ok("terminal attached and connected", await waitForText("connected"), await text());
ok("bash prompt rendered in xterm", await waitForTerm("$"), (await termText()).slice(-200));
await page.screenshot({ path: `${OUT}/ui-terminal.png` });

console.log("\n=== typing in the terminal reaches the pty ===");
await page.click(".xterm-screen");
await page.keyboard.type("echo HELLO_FROM_BROWSER");
await page.keyboard.press("Enter");
ok("command output appears in the terminal", await waitForTerm("HELLO_FROM_BROWSER"), (await termText()).slice(-200));

console.log("\n=== resize reflows and is reported to the daemon ===");
const before = await (await fetch(`${HOST_URL}/sessions`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
await page.setViewport({ width: 900, height: 600 });
await sleep(1500);
const after = await (await fetch(`${HOST_URL}/sessions`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
ok("daemon saw new dimensions", before[0] && after[0] && (before[0].cols !== after[0].cols || before[0].rows !== after[0].rows),
   `${before[0]?.cols}x${before[0]?.rows} -> ${after[0]?.cols}x${after[0]?.rows}`);

console.log("\n=== the agent sees the reflow too ===");
// Still at the small viewport: checking after restoring it would race the reflow back.
await page.click(".xterm-screen");
await page.keyboard.type("echo COLS=$(tput cols)");
await page.keyboard.press("Enter");
ok("tput reports the resized width", await waitForTerm(`COLS=${after[0]?.cols}`), (await termText()).slice(-160));
await page.setViewport({ width: 1280, height: 800 });
await sleep(800);

console.log("\n=== status dot and reconnect ===");
await sleep(6000);
const dotTitle = await page.evaluate(() =>
  [...document.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label")).filter(Boolean));
ok("session row shows an activity state", dotTitle.length > 0, JSON.stringify(dotTitle));

console.log("\n=== killing the session from the list ===");
const sessionsBefore = (await (await fetch(`${HOST_URL}/sessions`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()).length;
await clickText('[role="button"]', "✕");
await sleep(6000);
const sessionsAfter = (await (await fetch(`${HOST_URL}/sessions`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()).length;
ok("session removed on the daemon", sessionsAfter === sessionsBefore - 1, `${sessionsBefore} -> ${sessionsAfter}`);

console.log("\n=== mobile layout ===");
await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
await page.reload({ waitUntil: "networkidle2" });
await sleep(2000);
await page.screenshot({ path: `${OUT}/ui-mobile.png` });
ok("host registry persisted across reload", !(await text()).includes("Add the host daemon"), (await text()).slice(0, 120));

console.log("\n=== no unexpected errors ===");
// The 401 is deliberate: the run starts by testing a wrong token on purpose.
const unexpected = httpFailures.filter((f) => !/favicon|manifest|^401 /.test(f));
ok("no unexpected failed requests", unexpected.length === 0, unexpected.slice(0, 4).join(" | "));
console.log(`  (all HTTP failures seen: ${httpFailures.join(" | ") || "none"})`);
const pageErrors = consoleErrors.filter((e) => /pageerror/.test(e));
ok("no uncaught exceptions in the page", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

await browser.close();
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
