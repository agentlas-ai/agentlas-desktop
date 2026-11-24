// One shared headless browser for web_search / web_read: the bundled Agentlas browser (Chrome for Testing) driven by
// Playwright, no window, no profile. Electron-free. Started by the first call, closed after an idle period, relaunched on
// the next call after a crash or a close; concurrent calls share it, each in its own page.
import { resolveAgentlasBrowserRuntimeExecutable } from "../browser/runtime";
import { hostResolvesPublic } from "./address";
import { regionFor } from "./contract";
import { WebToolError } from "./errors";

/** What a search or read needs from one open page. A fake of this drives the engine-fallback tests. */
export interface WebPage {
  goto(url: string, opts: { timeoutMs: number }): Promise<{ status: number | null }>;
  /** Wait for the selector; resolves false at the timeout (the page is then read as it is). */
  waitReady(selector: string, timeoutMs: number): Promise<boolean>;
  /** Wait for the page's own load event; resolves false at the timeout. */
  waitLoad(timeoutMs: number): Promise<boolean>;
  evaluate<T>(source: string): Promise<T>;
  url(): string;
  /** True when a request of this page was refused because its address is the person's own machine or network. */
  refusedAddress(): boolean;
  close(): Promise<void>;
}
export interface OpenPageOptions { locale?: string; guardAddresses?: boolean; signal?: AbortSignal }
export interface WebPageProvider { openPage(opts: OpenPageOptions): Promise<WebPage> }

/** One launched browser, as the pool sees it. */
export interface BrowserHandle {
  openPage(opts: OpenPageOptions): Promise<WebPage>;
  close(): Promise<void>;
  /** Called once when the browser goes away without the pool asking (a crash, a kill). */
  onGone(listener: () => void): void;
}

// basis: a chat turn runs its searches and reads within seconds of each other and follow-ups come within a minute or two; a minute
// keeps one turn warm and gives the browser's memory back soon after (a resident headless Chrome is a few hundred MB).
export const WEB_BROWSER_IDLE_CLOSE_MS = 60_000;

interface Entry { handle: BrowserHandle; active: number; idle: NodeJS.Timeout | null; gone: boolean }

export class SharedHeadlessBrowser implements WebPageProvider {
  private current: Promise<Entry> | null = null;

  constructor(private readonly launch: () => Promise<BrowserHandle>, private readonly idleMs = WEB_BROWSER_IDLE_CLOSE_MS) {}

  async openPage(opts: OpenPageOptions): Promise<WebPage> {
    opts.signal?.throwIfAborted();
    const entry = await this.entry();
    if (entry.idle) { clearTimeout(entry.idle); entry.idle = null; }
    entry.active += 1;
    let page: WebPage;
    try {
      page = await entry.handle.openPage(opts);
    } catch (error) {
      this.release(entry);
      throw error;
    }
    let released = false;
    return {
      goto: (url, o) => page.goto(url, o),
      waitReady: (selector, ms) => page.waitReady(selector, ms),
      waitLoad: (ms) => page.waitLoad(ms),
      evaluate: <T>(source: string) => page.evaluate<T>(source),
      url: () => page.url(),
      refusedAddress: () => page.refusedAddress(),
      close: async () => {
        try { await page.close(); } finally { if (!released) { released = true; this.release(entry); } }
      },
    };
  }

  /** Close the browser now (app quit, tests). The next call launches a new one. */
  async shutdown(): Promise<void> {
    const pending = this.current;
    this.current = null;
    if (pending) await pending.then((entry) => this.closeEntry(entry), () => undefined);
  }

  private entry(): Promise<Entry> {
    if (!this.current) {
      const launching: Promise<Entry> = this.launch().then((handle) => {
        const entry: Entry = { handle, active: 0, idle: null, gone: false };
        handle.onGone(() => { entry.gone = true; if (this.current === launching) this.current = null; });
        return entry;
      });
      this.current = launching;
      launching.catch(() => { if (this.current === launching) this.current = null; });
    }
    return this.current.then((entry) => {
      if (entry.gone) { this.current = null; return this.entry(); }
      return entry;
    });
  }

  private release(entry: Entry): void {
    entry.active = Math.max(0, entry.active - 1);
    if (entry.active > 0 || entry.gone) return;
    entry.idle = setTimeout(() => {
      if (entry.active > 0) return;
      void this.current?.then((live) => { if (live === entry) this.current = null; });
      void this.closeEntry(entry);
    }, this.idleMs);
    entry.idle.unref?.();
  }

  private async closeEntry(entry: Entry): Promise<void> {
    if (entry.idle) { clearTimeout(entry.idle); entry.idle = null; }
    if (!entry.gone) { entry.gone = true; await entry.handle.close().catch(() => undefined); }
  }
}

// ---- the real browser -------------------------------------------------------------------------------------------------------

type PwBrowser = import("playwright").Browser;
type PwContext = import("playwright").BrowserContext;
type PwPage = import("playwright").Page;

function appVersion(): string {
  try { return String((require("../../../package.json") as { version?: string }).version || "0"); } catch { return "0"; }
}

/** The engine's own user agent with `HeadlessChrome` written `Chrome` and ` Agentlas/<version>` appended (contract `userAgent`). */
export function agentlasUserAgent(engineUserAgent: string, version = appVersion()): string {
  return `${engineUserAgent.replace("HeadlessChrome", "Chrome")} Agentlas/${version}`;
}

function bcp47(locale: string | undefined): string {
  return regionFor(locale).lang === "ko" ? "ko-KR" : "en-US";
}

class PlaywrightPage implements WebPage {
  private refused = false;
  constructor(private readonly page: PwPage) {}

  static async create(context: PwContext, opts: OpenPageOptions): Promise<PlaywrightPage> {
    const page = await context.newPage();
    const wrapped = new PlaywrightPage(page);
    if (opts.guardAddresses) {
      // Every request of the page, redirects and sub-resources included, must stay on public hosts; heavy media is not needed to read text.
      const verdicts = new Map<string, Promise<boolean>>();
      await page.route("**/*", async (route) => {
        const request = route.request();
        const type = request.resourceType();
        if (type === "image" || type === "media" || type === "font") return route.abort().catch(() => undefined);
        let host: string;
        try { host = new URL(request.url()).hostname; } catch { return route.continue().catch(() => undefined); }
        if (!/^https?:/u.test(request.url())) return route.continue().catch(() => undefined);
        let verdict = verdicts.get(host);
        if (!verdict) { verdict = hostResolvesPublic(host); verdicts.set(host, verdict); }
        if (await verdict) return route.continue().catch(() => undefined);
        wrapped.refused = true;
        return route.abort("blockedbyclient").catch(() => undefined);
      });
    }
    return wrapped;
  }

  async goto(url: string, opts: { timeoutMs: number }): Promise<{ status: number | null }> {
    const response = await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs });
    return { status: response ? response.status() : null };
  }
  async waitReady(selector: string, timeoutMs: number): Promise<boolean> {
    return this.page.waitForSelector(selector, { timeout: timeoutMs, state: "attached" }).then(() => true, () => false);
  }
  async waitLoad(timeoutMs: number): Promise<boolean> {
    return this.page.waitForLoadState("load", { timeout: timeoutMs }).then(() => true, () => false);
  }
  evaluate<T>(source: string): Promise<T> { return this.page.evaluate(source) as Promise<T>; }
  url(): string { return this.page.url(); }
  refusedAddress(): boolean { return this.refused; }
  async close(): Promise<void> { await this.page.close({ runBeforeUnload: false }).catch(() => undefined); }
}

/** Launch the bundled Agentlas browser headless and wrap it. Throws WebToolError(search_failed) when no bundled browser exists. */
export async function launchAgentlasHeadlessBrowser(): Promise<BrowserHandle> {
  const executablePath = resolveAgentlasBrowserRuntimeExecutable();
  if (!executablePath) throw new WebToolError("search_failed", "the bundled Agentlas browser is not installed");
  const { chromium } = require("playwright") as typeof import("playwright");
  // Playwright's default signal handlers would close the browser and then exit the host process on SIGINT/SIGTERM/SIGHUP.
  const browser: PwBrowser = await chromium.launch({
    executablePath, headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
  });
  let userAgent: string;
  try {
    const probe = await browser.newContext();
    const page = await probe.newPage();
    userAgent = agentlasUserAgent(await page.evaluate(() => navigator.userAgent));
    await probe.close();
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
  // One isolated, non-persistent context per language: no user profile, no cookies from the person's browsers.
  const contexts = new Map<string, Promise<PwContext>>();
  const gone: Array<() => void> = [];
  browser.on("disconnected", () => { for (const listener of gone) listener(); });
  return {
    onGone: (listener) => { gone.push(listener); },
    close: () => browser.close(),
    async openPage(opts) {
      const locale = bcp47(opts.locale);
      let context = contexts.get(locale);
      if (!context) { context = browser.newContext({ userAgent, locale, acceptDownloads: false, serviceWorkers: "block" }); contexts.set(locale, context); }
      return PlaywrightPage.create(await context, opts);
    },
  };
}

let shared: SharedHeadlessBrowser | null = null;
/** The process-wide provider the tools use. */
export function sharedWebBrowser(): SharedHeadlessBrowser {
  return shared ??= new SharedHeadlessBrowser(() => launchAgentlasHeadlessBrowser());
}
