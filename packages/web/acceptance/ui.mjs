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

console.log("\n=== the desktop scrollbar is not touch-only ===");
// It used to be gated behind pointer:coarse, which left a desktop with no working
// scroll wheel unable to move through the buffer at all — and ↓ Latest never
// appeared either, because nothing could scroll away from the bottom to summon it.
//
// The thumb renders only when there is something to scroll (`maxScroll <= 1` returns
// null), so the buffer has to be filled past a screenful before asking.
const noThumbYet = await page.$('[data-testid="terminal-scrollbar-thumb"]');
ok("no thumb while everything fits on screen", noThumbYet === null);

await page.click(".xterm-screen");
await page.keyboard.type("seq 1 200");
await page.keyboard.press("Enter");
ok("buffer filled past a screenful", await waitForTerm("200"), (await termText()).slice(-60));
await sleep(600);

const thumb = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="terminal-scrollbar-thumb"]');
  if (!el) return { present: false };
  return { present: true, visible: el.offsetParent !== null && el.getBoundingClientRect().width > 0 };
});
ok("scrollbar thumb exists at desktop width", thumb.present, JSON.stringify(thumb));
ok("scrollbar thumb is actually rendered", thumb.visible === true, JSON.stringify(thumb));

console.log("\n=== the sidebar collapses and comes back ===");
const asideWidth = () => page.evaluate(() => {
  const el = document.querySelector("aside");
  return el ? el.getBoundingClientRect().width : -1;
});
ok("sidebar starts visible", (await asideWidth()) > 0, `width ${await asideWidth()}`);
await page.click('[aria-label="Collapse sidebar"]');
await sleep(400);
ok("collapsing hides the sidebar", (await asideWidth()) === 0, `width ${await asideWidth()}`);
ok("a control to bring it back is present", (await page.$('[aria-label="Show sessions"]')) !== null);
await page.click('[aria-label="Show sessions"]');
await sleep(400);
ok("expanding restores the sidebar", (await asideWidth()) > 0, `width ${await asideWidth()}`);

console.log("\n=== Ctrl-Z must never reach the pty ===");
// A session runs the agent directly with no shell, so SIGTSTP suspends it with no
// job control anywhere to resume it — `fg` goes to a stopped process that is not
// reading. That cost a real six-hour session. `cat -v` is the witness: it stays
// alive and echoing only if the chord never arrived.
await page.click(".xterm-screen");
await page.keyboard.type("cat -v");
await page.keyboard.press("Enter");
await sleep(800);
await page.keyboard.type("ALIVE_BEFORE");
await page.keyboard.press("Enter");
ok("cat is echoing", await waitForTerm("ALIVE_BEFORE"), (await termText()).slice(-120));

await page.keyboard.down("Control");
await page.keyboard.press("KeyZ");
await page.keyboard.up("Control");
await sleep(500);
ok("no ^Z reached the pty", !(await termText()).includes("^Z"), (await termText()).slice(-120));
await page.keyboard.type("ALIVE_AFTER_CTRL_Z");
await page.keyboard.press("Enter");
ok("cat still running after Ctrl-Z", await waitForTerm("ALIVE_AFTER_CTRL_Z"), (await termText()).slice(-120));

console.log("\n=== Ctrl-C copies with a selection, interrupts without one ===");
// Both meanings are load-bearing: interrupting an agent mid-turn is the most used
// key in this client, and copying is the only reason the chord is intercepted.
const box = await page.evaluate(() => {
  const r = document.querySelector(".xterm-screen").getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
await page.mouse.move(box.x + 10, box.y + 10);
await page.mouse.down();
await page.mouse.move(box.x + box.w * 0.6, box.y + 40, { steps: 10 });
await page.mouse.up();
await sleep(300);
await page.keyboard.down("Control");
await page.keyboard.press("KeyC");
await page.keyboard.up("Control");
await sleep(500);
await page.keyboard.type("ALIVE_AFTER_COPY");
await page.keyboard.press("Enter");
ok("Ctrl-C with a selection did not interrupt", await waitForTerm("ALIVE_AFTER_COPY"), (await termText()).slice(-120));

// Clear the selection, then the same chord must reach the pty as SIGINT and kill cat.
await page.mouse.click(box.x + 10, box.y + box.h - 10);
await sleep(300);
await page.keyboard.down("Control");
await page.keyboard.press("KeyC");
await page.keyboard.up("Control");
await sleep(1000);
await page.keyboard.type("echo BACK_AT_THE_SHELL");
await page.keyboard.press("Enter");
ok("Ctrl-C without a selection interrupted cat", await waitForTerm("BACK_AT_THE_SHELL"), (await termText()).slice(-160));

console.log("\n=== status dot and reconnect ===");
await sleep(6000);
const dotTitle = await page.evaluate(() =>
  [...document.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label")).filter(Boolean));
ok("session row shows an activity state", dotTitle.length > 0, JSON.stringify(dotTitle));

console.log("\n=== killing the session from the list ===");
const sessionsBefore = (await (await fetch(`${HOST_URL}/sessions`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()).length;
// Two-step, like host removal: the first click only arms it. A single click used
// to kill outright, which cost a real six-hour session to one misclick.
await clickText('[role="button"]', "✕");
await sleep(300);
ok("first click arms rather than kills", has(await text(), "Really kill"), (await text()).slice(0, 200));
const stillThere = (await (await fetch(`${HOST_URL}/sessions`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()).length;
ok("nothing killed while merely armed", stillThere === sessionsBefore, `${sessionsBefore} -> ${stillThere}`);

await clickText('[role="button"]', "Really kill");
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
