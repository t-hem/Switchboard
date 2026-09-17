import type { SupervisedBrowser } from "./browser.js";
import { NothingSentError, SourceError } from "./errors.js";
import { assertImportableUrl } from "./net.js";
import { guardBrowserRequests } from "./browser-network.js";
import type { FormField, FormInspection, FormSession, ObservedForm, SubmitConfirmation } from "./adapters/application.js";

/** Narrow browser-side interop: these callbacks are serialized into the page, not run in Node. */
type ControlLike = {
  tagName: string; id: string; value: string; checked?: boolean; textContent: string | null;
  files?: { length: number; item(index: number): { name: string; size: number } | null } | null;
  getAttribute(name: string): string | null;
  closest(selector: string): ControlLike | null;
  querySelectorAll(selector: string): ArrayLike<unknown>;
  dispatchEvent(event: unknown): boolean;
};
type FormGlobals = {
  document: { querySelectorAll(selector: string): ArrayLike<unknown>; querySelector(selector: string): unknown };
  getComputedStyle(element: unknown): { display: string; visibility: string };
  Event: new (type: string, init?: { bubbles?: boolean }) => unknown;
};
type UploadHandle = { uploadFile(...paths: string[]): Promise<void> };
type ClickHandle = { click(): Promise<void>; dispose(): Promise<void> };
type NamedControl = ControlLike & { form: ControlLike | null };

/**
 * Candidates for a site's own non-submitting validation control. A candidate is clicked only
 * if it cannot submit a form: a `<button>` needs an explicit `type="button"` (a button with no
 * type submits its form) and an `<input>` must be `type="button"`.
 */
const PREVIEW_SELECTOR = "[data-apply-action='preview'], button[name='preview'], input[type='button'][name='preview']";
/** An explicitly marked submit control, anywhere on the page. */
const MARKED_SUBMIT_SELECTOR = "[data-apply-action='submit']";
/**
 * Otherwise, a generic submit control inside the application form (the form that owns most
 * of the named fields), never a search or newsletter form elsewhere on the page. Explicit
 * submit types win over a type-less button.
 */
const FORM_SUBMIT_SELECTORS = ["button[type='submit'], input[type='submit']", "button:not([type])"];
/** A confirmation the site actually rendered, plus any reference it printed. */
const CONFIRMATION_SELECTOR = "[data-apply-confirmation], #confirmation, [role='status'][data-apply-result]";
const REFERENCE_SELECTOR = "[data-apply-reference]";
const CAPTCHA_SELECTOR = "[data-apply-captcha], iframe[src*='recaptcha'], .g-recaptcha, [data-sitekey]";
const FORBIDDEN_SELECTOR = "[data-apply-automation-forbidden]";

/** Field names come from the page, so they are validated before use in a CSS selector. */
function nameSelector(name: string): string {
  if (!/^[A-Za-z0-9_.\-[\]]{1,200}$/.test(name)) throw new SourceError("unsupported_field", `Field name ${JSON.stringify(name)} cannot be targeted safely`, false);
  return `[name='${name.replace(/'/g, "\\'")}']`;
}

/** Real browser session over the supervised browser. It fills and previews; only `submitForm` presses submit. */
export class PuppeteerFormSession implements FormSession {
  private page: import("puppeteer-core").Page | null = null;
  constructor(private readonly browser: SupervisedBrowser, private readonly options: { timeoutMs?: number } = {}) {}

  async open(url: string, options: { allowPrivate: boolean; timeoutMs: number }): Promise<FormInspection & { pageUrl: string }> {
    await assertImportableUrl(url, { allowPrivate: options.allowPrivate });
    const browser = await this.browser.ensure();
    const page = await browser.newPage();
    this.page = page;
    await guardBrowserRequests(page, options.allowPrivate);
    await page.setViewport({ width: 1280, height: 900 });
    try { await page.goto(url, { waitUntil: "load", timeout: options.timeoutMs }); }
    catch (error) { throw new SourceError("form_unavailable", error instanceof Error && /timeout/i.test(error.message) ? "The application form timed out" : "The application form could not be loaded", true); }
    // A permitted URL may redirect into the local network; re-check the address we reached.
    await assertImportableUrl(page.url(), { allowPrivate: options.allowPrivate });
    const found = await page.evaluate((selectors: { captcha: string; forbidden: string }) => {
      const g = globalThis as unknown as FormGlobals;
      const reader = (element: unknown): ControlLike => element as ControlLike;
      const labelOf = (el: ControlLike): string => {
        const aria = el.getAttribute("aria-label"); if (aria) return aria;
        if (el.id) { const explicit = g.document.querySelector(`label[for='${el.id}']`); if (explicit) return reader(explicit).textContent?.trim() ?? el.id; }
        const wrapped = el.closest("label"); if (wrapped) return wrapped.textContent?.trim() ?? "";
        return el.getAttribute("name") ?? "";
      };
      const fields = Array.from(g.document.querySelectorAll("input[name], select[name], textarea[name]")).map(reader)
        .filter(el => { const style = g.getComputedStyle(el); return style.display !== "none" && style.visibility !== "hidden"; })
        .map(el => {
          const tagName = el.tagName.toLowerCase(), declared = (el.getAttribute("type") ?? "text").toLowerCase();
          const type = tagName === "select" ? "select" : tagName === "textarea" ? "textarea" : declared;
          const options = tagName === "select" ? Array.from(el.querySelectorAll("option")).map(o => reader(o).getAttribute("value") ?? "").filter(Boolean) : [];
          const accept = type === "file" ? (el.getAttribute("accept") ?? "").split(",").map(v => v.trim()).filter(Boolean) : [];
          return { name: el.getAttribute("name") ?? "", label: labelOf(el), type,
            required: el.getAttribute("required") !== null || el.getAttribute("aria-required") === "true",
            options: options.length ? options : undefined, accept: accept.length ? accept : undefined };
        }).filter(field => field.name);
      return { fields, captcha: g.document.querySelector(selectors.captcha) !== null, automationForbidden: g.document.querySelector(selectors.forbidden) !== null };
    }, { captcha: CAPTCHA_SELECTOR, forbidden: FORBIDDEN_SELECTOR });
    return { formUrl: url, finalUrl: page.url(), pageUrl: page.url(), fields: found.fields as FormField[], captcha: found.captcha, automationForbidden: found.automationForbidden };
  }

  async fill(field: string, value: string): Promise<void> {
    const page = this.requirePage();
    const ok = await page.evaluate((selector: string, val: string) => {
      const g = globalThis as unknown as FormGlobals;
      const el = g.document.querySelector(selector) as unknown as ControlLike | null;
      if (!el) return false;
      const tagName = el.tagName.toLowerCase(), type = (el.getAttribute("type") ?? "").toLowerCase();
      if (tagName === "input" && (type === "checkbox" || type === "radio")) el.checked = val === "true"; // the adapter normalizes checkbox answers to "true"/"false"
      else el.value = val;
      // Frameworks listen for these events; setting `.value` alone is invisible to them.
      el.dispatchEvent(new g.Event("input", { bubbles: true }));
      el.dispatchEvent(new g.Event("change", { bubbles: true }));
      return true;
    }, nameSelector(field), value);
    if (!ok) throw new SourceError("field_missing", `The form no longer has a field named ${field}`, true);
  }

  async uploadFile(field: string, filePath: string): Promise<void> {
    const input: UploadHandle | null = await this.requirePage().$(`${nameSelector(field)}[type='file']`);
    if (!input) throw new SourceError("field_missing", `The form has no file input named ${field}`, true);
    await input.uploadFile(filePath);
  }

  async observe(): Promise<ObservedForm> {
    const page = this.requirePage();
    const observed = await page.evaluate(() => {
      const g = globalThis as unknown as FormGlobals;
      const reader = (element: unknown): ControlLike => element as ControlLike;
      const filled: { field: string; value: string }[] = [], uploads: { field: string; fileName: string; sizeBytes: number }[] = [];
      for (const el of Array.from(g.document.querySelectorAll("input[name], select[name], textarea[name]")).map(reader)) {
        const name = el.getAttribute("name") ?? ""; if (!name) continue;
        const tagName = el.tagName.toLowerCase(), type = (el.getAttribute("type") ?? "").toLowerCase();
        if (tagName === "input" && type === "file") {
          const file = el.files && el.files.length ? el.files.item(0) : null;
          if (file) uploads.push({ field: name, fileName: file.name, sizeBytes: file.size });
          continue;
        }
        if (tagName === "input" && type === "hidden") continue;
        const value = tagName === "input" && (type === "checkbox" || type === "radio") ? (el.checked ? "true" : "false") : el.value;
        if (value !== "" || type === "checkbox") filled.push({ field: name, value });
      }
      return { filled, uploads };
    });
    return { finalUrl: page.url(), filled: observed.filled, uploads: observed.uploads };
  }

  /** Clicks only the site's own preview/validation control; returns false if there is none. */
  async clickPreview(): Promise<boolean> {
    const page = this.requirePage();
    const handle = await page.evaluateHandle((selector: string) => {
      const g = globalThis as unknown as FormGlobals;
      return Array.from(g.document.querySelectorAll(selector)).map(element => element as ControlLike).find(el => {
        const tagName = el.tagName.toLowerCase(), type = (el.getAttribute("type") ?? "").toLowerCase();
        // Anything that could submit or reset the form is never a preview, whatever it is named.
        if (tagName === "button" || tagName === "input") return type === "button";
        return true;
      }) ?? null;
    }, PREVIEW_SELECTOR);
    const control = handle.asElement() as unknown as ClickHandle | null;
    if (!control) { await handle.dispose(); return false; }
    try { await control.click(); } finally { await control.dispose().catch(() => undefined); }
    await page.waitForNetworkIdle({ idleTime: 400, timeout: Math.min(this.options.timeoutMs ?? 20_000, 8000) }).catch(() => undefined);
    return true;
  }

  async close(): Promise<void> {
    if (this.page) { await this.page.close().catch(() => undefined); this.page = null; }
  }
  /**
   * Presses the site's real submit control and reads whatever confirmation it renders.
   * Nothing is inferred: if the site shows no readable confirmation, both fields are null
   * and the caller must treat the send as unknown.
   */
  async submitForm(): Promise<SubmitConfirmation> {
    const page = this.requirePage();
    const handle = await page.evaluateHandle((marked: string, generic: string[]) => {
      const g = globalThis as unknown as FormGlobals;
      const explicit = g.document.querySelector(marked);
      if (explicit) return explicit;
      const owners = new Map<unknown, number>();
      for (const element of Array.from(g.document.querySelectorAll("input[name], select[name], textarea[name]"))) {
        const form = (element as NamedControl).form;
        if (form) owners.set(form, (owners.get(form) ?? 0) + 1);
      }
      let best: ControlLike | null = null, most = 0;
      for (const [form, count] of owners) if (count > most) { best = form as ControlLike; most = count; }
      if (!best) return null;
      for (const selector of generic) { const found = best.querySelectorAll(selector); if (found.length) return found[0]; }
      return null;
    }, MARKED_SUBMIT_SELECTOR, FORM_SUBMIT_SELECTORS);
    const control = handle.asElement() as unknown as ClickHandle | null;
    if (!control) { await handle.dispose(); throw new NothingSentError("submit_control_missing", "The form has no submit control; nothing was sent", false); }
    const timeout = Math.min(this.options.timeoutMs ?? 20_000, 15_000);
    // A native form navigates after the click, while a script-driven one updates in place.
    // Listen for navigation before clicking so a fast one is not missed.
    const navigated = page.waitForNavigation({ waitUntil: "load", timeout }).then(() => true, () => false);
    try { await control.click(); } finally { await control.dispose().catch(() => undefined); }
    await Promise.race([navigated, page.waitForNetworkIdle({ idleTime: 600, timeout }).catch(() => undefined)]);
    const read = () => page.evaluate((selectors: { confirmation: string; reference: string }) => {
      const g = globalThis as unknown as FormGlobals;
      const read = (selector: string): { text: string | null; result: string | null } => {
        const element = g.document.querySelector(selector) as unknown as { textContent: string | null; getAttribute(name: string): string | null } | null;
        return { text: element?.textContent?.trim() ?? null, result: element?.getAttribute("data-apply-result") ?? null };
      };
      const confirmation = read(selectors.confirmation);
      return { confirmationText: confirmation.text, result: confirmation.result, externalId: read(selectors.reference).text };
    }, { confirmation: CONFIRMATION_SELECTOR, reference: REFERENCE_SELECTOR });
    let found: { confirmationText: string | null; result: string | null; externalId: string | null };
    try { found = await read(); }
    catch {
      // The page was replaced mid-read by the navigation the click started: read the new one.
      await navigated;
      try { found = await read(); }
      catch { found = { confirmationText: null, result: null, externalId: null }; } // unreadable, so the outcome is unknown
    }
    return { finalUrl: page.url(), confirmationText: found.confirmationText, externalId: found.externalId, result: found.result };
  }

  /** Evidence for whatever happened on the page, used as the submission receipt. */
  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array(await this.requirePage().screenshot({ fullPage: true, type: "png" }));
  }
  private requirePage(): import("puppeteer-core").Page {
    if (!this.page) throw new SourceError("session_closed", "The browser session is not open", false);
    return this.page;
  }
}
