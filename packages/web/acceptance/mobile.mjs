// Phase 5 acceptance: the phone case, driven at phone size.
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
const page = await browser.newPage();
// A phone, not a narrow desktop window.
await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1");
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

await page.evaluateOnNewDocument((hostUrl, token) => {
  try {
    localStorage.setItem("switchboard.hosts", JSON.stringify([{ id: "h0", label: "testbox", baseUrl: hostUrl, token }]));
    localStorage.setItem("switchboard.clientLabel", "phone");
  } catch {
    /* about:blank and friends have no accessible storage */
  }
}, HOST_URL, TOKEN);

const text = () => page.evaluate(() => document.body.innerText);
const term = () => page.evaluate(() => document.querySelector(".xterm-rows")?.innerText ?? "");
const waitTerm = async (needle, ms = 20000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if ((await term()).includes(needle)) return true; await sleep(250); }
  return false;
};
const waitFor = async (needle, ms = 15000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if ((await text()).toLowerCase().includes(needle.toLowerCase())) return true; await sleep(250); }
  return false;
};
const tapKey = async (aria) => {
  const h = await page.evaluateHandle((a) =>
    [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === a) ?? null, aria);
  const el = h.asElement();
  if (!el) return false;
  await el.click();
  return true;
};
const goBackToList = async () => {
  const back = await page.evaluateHandle(() =>
    [...document.querySelectorAll("button")].find((b) => b.innerText.includes("Back")) ?? null);
  const el = back.asElement();
  if (el) await el.click();
  await sleep(500);
};
const openSession = async () => {
  await page.waitForSelector("aside section button", { timeout: 15000 });
  const rows = await page.$$("aside section button");
  for (const row of rows) {
    if ((await row.evaluate((el) => el.innerText)).includes("pid")) { await row.click(); return true; }
  }
  return false;
};

console.log("\n=== PWA assets ===");
{
  const res = await fetch(`${APP}/manifest.webmanifest`);
  ok("manifest is served", res.ok, `${res.status}`);
  const m = await res.json();
  ok("manifest has the fields an install needs",
     m.name && m.start_url && m.display === "standalone" && Array.isArray(m.icons) && m.icons.length >= 2,
     JSON.stringify({ name: m.name, display: m.display, icons: m.icons?.length }));
  ok("manifest declares a maskable icon", m.icons.some((i) => i.purpose === "maskable"));
  for (const icon of m.icons) {
    const r = await fetch(APP + icon.src);
    ok(`icon ${icon.src} resolves`, r.ok && (r.headers.get("content-type") ?? "").includes("png"), `${r.status}`);
  }
  const sw = await fetch(`${APP}/sw.js`);
  ok("service worker is served", sw.ok, `${sw.status}`);
  const apple = await fetch(`${APP}/apple-touch-icon.png`);
  ok("apple-touch-icon is served", apple.ok, `${apple.status}`);
}

await page.goto(APP, { waitUntil: "networkidle2" });
await sleep(2500);

console.log("\n=== service worker registers ===");
{
  const registered = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return "unsupported";
    for (let i = 0; i < 40; i++) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) return reg.active ? "active" : "registered";
      await new Promise((r) => setTimeout(r, 250));
    }
    return "none";
  });
  ok("service worker registered", registered === "active" || registered === "registered", registered);
  ok("manifest is linked from the document",
     await page.$eval('link[rel="manifest"]', (el) => el.getAttribute("href")) === "/manifest.webmanifest");
  ok("viewport resizes content for the soft keyboard",
     (await page.$eval('meta[name="viewport"]', (el) => el.content)).includes("interactive-widget=resizes-content"));
}

console.log("\n=== mobile layout: full-screen list, tap into a full-screen terminal ===");
const promptSession = await (await api("/sessions", { method: "POST", body: JSON.stringify({ agent: "prompt", cwd: REPO }) })).json();
await sleep(6000);
ok("session list fills the screen", await waitFor("testbox"));
await page.screenshot({ path: `${OUT}/mobile-list.png` });
ok("tapped into the session", await openSession());
ok("terminal opened", await waitFor("connected", 15000));
ok("a back button is offered", (await text()).includes("Back"));
{
  const sidebarVisible = await page.evaluate(() => {
    const aside = document.querySelector("aside");
    return aside ? getComputedStyle(aside).display !== "none" : false;
  });
  ok("the list is hidden behind the terminal on a phone", !sidebarVisible);
}

console.log("\n=== the permission prompt, answered with quick-send buttons only ===");
ok("prompt is on screen", await waitTerm("Do you want to proceed?"), (await term()).slice(-200));
await page.screenshot({ path: `${OUT}/mobile-prompt.png` });
ok("quick keys are present", await page.$$eval("button", (els) =>
  ["Send y", "Send n", "Escape", "Ctrl-C (interrupt)", "Up arrow", "Down arrow",
   "Space (toggle)", "Tab", "Enter"]
    .every((a) => els.some((e) => e.getAttribute("aria-label") === a))));
ok("tapped y", await tapKey("Send y"));
ok("the agent received y", await waitTerm("ANSWERED:y"), (await term()).slice(-200));

console.log("\n=== the line-input bar ===");
ok("line input is present", await page.$('input[aria-label="Line input"]') !== null);
await page.click('input[aria-label="Line input"]');
await page.keyboard.type("hello from the couch");
const sendBtn = await page.evaluateHandle(() =>
  [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "Send") ?? null);
await sendBtn.asElement().click();
ok("the line arrived with a trailing return", await waitTerm("LINE:hello from the couch"), (await term()).slice(-200));
ok("the field cleared after sending",
   await page.$eval('input[aria-label="Line input"]', (el) => el.value) === "");

console.log("\n=== quick keys send the exact bytes ===");
{
  const raw = await (await api("/sessions", { method: "POST", body: JSON.stringify({ agent: "raw", cwd: REPO }) })).json();
  // Back to the list, then into the new session.
  await goBackToList();
  await sleep(6000);
  const rows = await page.$$("aside section button");
  for (const row of rows) {
    const label = await row.evaluate((el) => el.innerText);
    if (label.includes(`pid ${raw.pid}`)) { await row.click(); break; }
  }
  await waitFor("connected", 15000);
  await sleep(1000);
  await tapKey("Escape");
  ok("Esc sends 0x1b", await waitTerm("^["), (await term()).slice(-80));
  await tapKey("Up arrow");
  ok("↑ sends the CSI A sequence", await waitTerm("^[[A"), (await term()).slice(-80));
  await tapKey("Down arrow");
  ok("↓ sends the CSI B sequence", await waitTerm("^[[B"), (await term()).slice(-80));
  await api(`/sessions/${raw.id}`, { method: "DELETE" });
}

console.log("\n=== Ctrl-C interrupts ===");
{
  const s = await (await api("/sessions", { method: "POST", body: JSON.stringify({ agent: "interruptible", cwd: REPO }) })).json();
  await goBackToList();
  await sleep(6000);
  const rows = await page.$$("aside section button");
  for (const row of rows) {
    if ((await row.evaluate((el) => el.innerText)).includes(`pid ${s.pid}`)) { await row.click(); break; }
  }
  await waitFor("connected", 15000);
  ok("agent is running", await waitTerm("READY"), (await term()).slice(-120));
  await tapKey("Ctrl-C (interrupt)");
  ok("Ctrl-C reached the process group", await waitTerm("INTERRUPTED"), (await term()).slice(-160));
  await api(`/sessions/${s.id}`, { method: "DELETE" });
}

console.log("\n=== scrolled up, the live view is one tap away ===");
{
  // `cat -v` echoes, so each Enter costs two lines. Enough of them and the buffer
  // is taller than the viewport, which is the only state the button exists for.
  const raw = await (await api("/sessions", { method: "POST", body: JSON.stringify({ agent: "raw", cwd: REPO }) })).json();
  await goBackToList();
  await sleep(6000);
  const rows = await page.$$("aside section button");
  for (const row of rows) {
    if ((await row.evaluate((el) => el.innerText)).includes(`pid ${raw.pid}`)) { await row.click(); break; }
  }
  await waitFor("connected", 15000);
  await sleep(1000);
  for (let i = 0; i < 40; i++) await tapKey("Enter");
  await sleep(1000);

  const jumpVisible = () => page.evaluate(() =>
    [...document.querySelectorAll("button")].some((b) => b.getAttribute("aria-label") === "Jump to latest output"));

  ok("no jump button while the live view is on screen", !(await jumpVisible()));
  ok("the terminal scrolled past a screenful",
     await page.$eval(".xterm-viewport", (el) => el.scrollHeight > el.clientHeight + 10));

  // Scroll the viewport itself — that is the path a finger takes now that
  // `.xterm-screen` is transparent to pointers, and xterm syncs its buffer from it.
  await page.$eval(".xterm-viewport", (el) => { el.scrollTop = 0; });
  await sleep(500);
  ok("scrolling up offers the live view back", await jumpVisible());
  await page.screenshot({ path: `${OUT}/mobile-jump-to-latest.png` });

  ok("tapped it", await tapKey("Jump to latest output"));
  await sleep(500);
  ok("the viewport is back at the bottom",
     await page.$eval(".xterm-viewport", (el) => el.scrollTop >= el.scrollHeight - el.clientHeight - 2));
  ok("the button withdraws once there", !(await jumpVisible()));

  // The other half of the scrolling fix: a touch has to reach the scrollable
  // element at all. xterm paints `.xterm-screen` over the viewport, so it is made
  // transparent to pointers on a coarse pointer — see index.css. The momentum
  // itself is a real-handset check; this only pins the precondition.
  ok("the screen is transparent to touch, so the viewport is what scrolls",
     await page.$eval(".xterm-screen", (el) => getComputedStyle(el).pointerEvents === "none"));

  // And the fallback if momentum does not hold: a thumb big enough to drag.
  {
    const thumb = await page.$('[data-testid="terminal-scrollbar-thumb"]');
    ok("a drag thumb is drawn over the terminal", thumb !== null);
    const box = await thumb.boundingBox();
    ok("the thumb is big enough to grab", box.height >= 40 && box.width >= 10,
       `${Math.round(box.width)}x${Math.round(box.height)}`);

    const before = await page.$eval(".xterm-viewport", (el) => el.scrollTop);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 120, { steps: 10 });
    await page.mouse.up();
    await sleep(300);
    const after = await page.$eval(".xterm-viewport", (el) => el.scrollTop);
    ok("dragging the thumb scrolls the terminal", after < before, `${before} -> ${after}`);
    await page.screenshot({ path: `${OUT}/mobile-scrollbar.png` });
  }

  await api(`/sessions/${raw.id}`, { method: "DELETE" });
  await goBackToList();
}

console.log("\n=== no horizontal overflow at phone width ===");
{
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("page does not scroll sideways", overflow <= 1, `${overflow}px`);
}

ok("no uncaught exceptions", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
await api(`/sessions/${promptSession.id}`, { method: "DELETE" });
await browser.close();
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
