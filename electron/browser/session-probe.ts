import { chromium, type Browser, type Page } from "playwright";
import type { BrowserSessionProbeResult } from "../../shared/browser-session-probe";
import { listBrowserSites, normalizeSite } from "../store/browser-vault";
import { dedicatedGoogleSessionsQuarantined } from "./google-session-boundary";
import {
  acquireBrowserCdpLease, browserCdpPort, browserCdpPortReady, browserCdpProfilePath,
  reconcileBrowserCdpOwnerWithRetry, releaseBrowserCdpLease,
} from "../mcp-tools/browser-cdp-launcher";

const flights = new Map<string, Promise<BrowserSessionProbeResult>>();
const policies: Record<string, { url: string; hosts: string[]; signedIn: string; signedOut: RegExp }> = {
  "x.com": {
    url: "https://x.com/home", hosts: ["x.com"],
    signedIn: '[data-testid="SideNav_AccountSwitcher_Button"]',
    signedOut: /\/i\/flow\/login|\/login(?:[/?#]|$)/i,
  },
  "github.com": {
    url: "https://github.com/settings/profile", hosts: ["github.com"],
    signedIn: 'form input#user_profile_name[name="user[name]"]',
    signedOut: /\/login(?:[/?#]|$)/i,
  },
};

/** No browser launch, profile import, credential reads, or owner-tab mutation. */
export function probeBrowserSession(input: string): Promise<BrowserSessionProbeResult> {
  const started = Date.now();
  const result = (state: BrowserSessionProbeResult["state"], evidence: string, reasonCode?: string): BrowserSessionProbeResult => ({
    state, evidence, reasonCode, checkedAt: new Date().toISOString(), latencyMs: Date.now() - started,
  });
  if (typeof input !== "string" || !/^[a-z0-9.-]{1,253}$/i.test(input)) {
    return Promise.resolve(result("unverified", "invalid-request", "invalid-site"));
  }
  const site = normalizeSite(input);
  if (!listBrowserSites().some((entry) => entry.site === site)) {
    return Promise.resolve(result("unverified", "site-not-registered", "site-not-registered"));
  }
  const policy = policies[site];
  if (!policy) return Promise.resolve(result("unverified", "no-authentication-detector", "unsupported-site"));
  const isolated = () => {
    try { return dedicatedGoogleSessionsQuarantined(browserCdpProfilePath()); }
    catch { return false; }
  };
  const pending = flights.get(site);
  if (pending) return pending;
  const flight = (async () => {
    let browser: Browser | undefined;
    let page: Page | undefined;
    let lease: Awaited<ReturnType<typeof acquireBrowserCdpLease>> | undefined;
    try {
      if (!(await browserCdpPortReady())) return result("unverified", "dedicated-browser-unavailable", "browser-unavailable");
      lease = await acquireBrowserCdpLease("session-probe");
      if ((await reconcileBrowserCdpOwnerWithRetry()).state !== "owned") {
        return result("unverified", "dedicated-browser-ownership-unconfirmed", "browser-not-owned");
      }
      if (!isolated()) {
        return result("unverified", "google-session-isolation-unconfirmed", "google-session-relogin-required");
      }
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${browserCdpPort()}`, { timeout: 3_000 });
      if ((await reconcileBrowserCdpOwnerWithRetry()).state !== "owned") {
        return result("unverified", "dedicated-browser-ownership-changed", "browser-not-owned");
      }
      const context = browser.contexts()[0];
      if (!context) return result("unverified", "dedicated-browser-context-unavailable", "browser-unavailable");
      if (!isolated()) {
        return result("unverified", "google-session-isolation-changed", "google-session-relogin-required");
      }
      page = await context.newPage();
      await page.goto(policy.url, { waitUntil: "domcontentloaded", timeout: 6_000 });
      await page.locator(policy.signedIn).first().waitFor({ state: "visible", timeout: 2_000 }).catch(() => undefined);
      const finalUrl = new URL(page.url());
      if (finalUrl.protocol !== "https:" || !policy.hosts.includes(finalUrl.hostname)) {
        return result("unverified", "authentication-page-redirected", "unexpected-origin");
      }
      if (policy.signedOut.test(finalUrl.pathname)) return result("signed-out", "provider-login-redirect", "login-required");
      // A public home page or stored cookie is never sufficient proof.
      if (await page.evaluate(({ hosts, selector }) => {
        const element = document.querySelector(selector);
        return location.protocol === "https:" && hosts.includes(location.hostname)
          && Boolean(element?.getClientRects().length);
      }, { hosts: policy.hosts, selector: policy.signedIn })) {
        return result("signed-in", "authenticated-account-control");
      }
      return result("unverified", "authenticated-account-control-not-found", "authentication-unconfirmed");
    } catch {
      // Do not surface provider URLs, cookies, account names, or raw exception text.
      return result("unverified", "authentication-check-unavailable", "probe-unavailable");
    } finally {
      await page?.close().catch(() => undefined);
      // Disconnect this CDP client; Playwright leaves the attached browser running.
      await browser?.close().catch(() => undefined);
      releaseBrowserCdpLease(lease, { scheduleShutdown: false });
    }
  })();
  flights.set(site, flight);
  void flight.finally(() => { if (flights.get(site) === flight) flights.delete(site); });
  return flight;
}
