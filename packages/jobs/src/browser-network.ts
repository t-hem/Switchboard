import type { Page } from "puppeteer-core";
import { assertImportableUrl } from "./net.js";

/** Check redirects and subresources before sending them, not after navigation.
 * Private fixture access is controlled solely by the service's bootstrap setting.
 */
export async function guardBrowserRequests(page: Page, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) return;
  await page.setRequestInterception(true);
  page.on("request", request => {
    void (async () => {
      try {
        if (!/^(data|blob|about):/.test(request.url())) await assertImportableUrl(request.url(), { allowPrivate: false });
        if (!request.isInterceptResolutionHandled()) await request.continue();
      } catch {
        if (!request.isInterceptResolutionHandled()) await request.abort("blockedbyclient").catch(() => undefined);
      }
    })();
  });
}
