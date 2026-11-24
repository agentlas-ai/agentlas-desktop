// searchWeb / readWebPage: the two operations behind the web_search and web_read tools. Electron-free.
import fs from "node:fs";
import { checkWebAddress } from "./address";
import { sharedWebBrowser, type WebPage, type WebPageProvider } from "./browser";
import { WEB_SEARCH_CONTRACT, engineUrl, serpExtractorSource } from "./contract";
import { WebToolError } from "./errors";

export interface WebSearchHit { n: number; title: string; url: string; site: string; snippet: string }
export interface WebSearchResult { query: string; engine: "duckduckgo" | "bing" | "google"; results: WebSearchHit[] }
export interface WebReadResult { url: string; title: string; site: string; text: string; truncated: boolean }

// basis: the read_file built-in cuts a file at 20,000 characters (shared/builtin-tools.ts); one page read costs the model no more
// context than one file read, which keeps a search-then-read-three-pages turn inside the 8k-32k windows of local models.
export const WEB_READ_TEXT_MAX_CHARS = 20_000;

export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./u, ""); } catch { return ""; }
}

function aborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error("aborted"), { name: "AbortError" });
}

/** Resolve with the promise, or reject at once when the signal aborts (the caller's finally then closes the page). */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || /\bTimeout\b.*exceeded/iu.test(error.message));
}

type EngineOutcome = { kind: "ok"; result: WebSearchResult } | { kind: "blocked" } | { kind: "failed"; timedOut: boolean };

interface SerpReading {
  engine: string; blocked: boolean; relevant: boolean;
  results: Array<{ url: string; title: string; snippet?: string }>;
}

async function tryEngine(
  engineId: string, query: string, count: number, locale: string | undefined,
  provider: WebPageProvider, signal: AbortSignal | undefined,
): Promise<EngineOutcome> {
  let page: WebPage | null = null;
  try {
    page = await untilAborted(provider.openPage({ locale, signal }), signal);
    await untilAborted(page.goto(engineUrl(engineId, query, locale), { timeoutMs: WEB_SEARCH_CONTRACT.pageLoadTimeoutMs }), signal);
    await untilAborted(page.waitReady(WEB_SEARCH_CONTRACT.engines[engineId].ready, WEB_SEARCH_CONTRACT.readyWaitMs), signal);
    const reading = await untilAborted(page.evaluate<SerpReading>(`${serpExtractorSource()}(${JSON.stringify(query)}, ${count})`), signal);
    if (reading.blocked || !reading.relevant || !reading.results.length) return { kind: "blocked" };
    const engine = reading.engine === "bing" || reading.engine === "google" ? reading.engine : "duckduckgo";
    const results = reading.results.slice(0, count).map((hit, index) => ({
      n: index + 1, title: String(hit.title || hostOf(hit.url)), url: hit.url, site: hostOf(hit.url), snippet: String(hit.snippet ?? ""),
    }));
    return { kind: "ok", result: { query, engine, results } };
  } catch (error) {
    aborted(signal);
    if (error instanceof WebToolError) throw error; // no bundled browser: every engine would fail the same way
    return { kind: "failed", timedOut: isTimeout(error) };
  } finally {
    await page?.close().catch(() => undefined);
  }
}

/**
 * Search through the engines of the contract, in its desktop order. An engine that is blocked, answers off-topic or lists nothing
 * is skipped for the next; when none serves a result the call fails: `search_blocked` when at least one engine answered, otherwise
 * `timed_out` (every engine timed out) or `search_failed` (network or load errors).
 */
export async function searchWeb(input: {
  query: string; count?: number; locale?: string; signal?: AbortSignal; provider?: WebPageProvider;
}): Promise<WebSearchResult> {
  const { query, signal } = input;
  const provider = input.provider ?? sharedWebBrowser();
  const max = WEB_SEARCH_CONTRACT.results.max;
  const count = Math.min(Math.max(Math.trunc(input.count ?? WEB_SEARCH_CONTRACT.results.default), 1), max);
  aborted(signal);
  const outcomes: EngineOutcome[] = [];
  for (const engineId of WEB_SEARCH_CONTRACT.order.desktop) {
    const outcome = await tryEngine(engineId, query, count, input.locale, provider, signal);
    if (outcome.kind === "ok") return outcome.result;
    outcomes.push(outcome);
  }
  if (outcomes.some((outcome) => outcome.kind === "blocked")) {
    throw new WebToolError("search_blocked", "every search engine refused or returned nothing usable; the person can search in the browser themself");
  }
  throw new WebToolError(outcomes.every((outcome) => outcome.kind === "failed" && outcome.timedOut) ? "timed_out" : "search_failed",
    "no search engine could be reached");
}

// ---- web_read ---------------------------------------------------------------------------------------------------------------

let readabilitySource: string | null = null;
/** Mozilla Readability.js (Apache-2.0), read from the package; inside app.asar fs reads it like any file. */
function readabilitySourceText(): string {
  return readabilitySource ??= fs.readFileSync(require.resolve("@mozilla/readability/Readability.js"), "utf8");
}

interface Extracted { title: string; siteName: string; text: string }

function extractionScript(): string {
  return `(function () {
  ${readabilitySourceText()}
  var clean = function (s) { return String(s || '').replace(/[ \\t\\u00a0]+/g, ' ').replace(/ ?\\n ?/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim(); };
  var article = null;
  try { article = new Readability(document.cloneNode(true)).parse(); } catch (e) { article = null; }
  var text = article && article.textContent ? clean(article.textContent) : '';
  if (!text) text = clean(document.body ? document.body.innerText : '');
  return { title: clean((article && article.title) || document.title || ''), siteName: clean((article && article.siteName) || ''), text: text };
})()`;
}

/** Open a public web page in the shared browser and return its readable text (Readability, or the body text when it finds no article). */
export async function readWebPage(input: {
  url: string; locale?: string; signal?: AbortSignal; provider?: WebPageProvider;
}): Promise<WebReadResult> {
  const { signal } = input;
  const target = checkWebAddress(input.url);
  const provider = input.provider ?? sharedWebBrowser();
  aborted(signal);
  let page: WebPage | null = null;
  try {
    try {
      page = await untilAborted(provider.openPage({ locale: input.locale, guardAddresses: true, signal }), signal);
    } catch (error) {
      aborted(signal);
      throw new WebToolError("page_failed", error instanceof WebToolError ? error.message.replace(/^\w+: /u, "") : "the browser could not start");
    }
    let status: number | null;
    try {
      ({ status } = await untilAborted(page.goto(target.href, { timeoutMs: WEB_SEARCH_CONTRACT.pageLoadTimeoutMs }), signal));
    } catch (error) {
      aborted(signal);
      if (page.refusedAddress()) throw new WebToolError("address_refused", "the page led to a local or private network address");
      throw new WebToolError(isTimeout(error) ? "timed_out" : "page_failed", isTimeout(error) ? "the page did not load in time" : "the page could not be opened");
    }
    if (page.refusedAddress()) throw new WebToolError("address_refused", "the page led to a local or private network address");
    if (status !== null && status >= 400) throw new WebToolError("page_failed", `the site answered HTTP ${status}`);
    await untilAborted(page.waitLoad(WEB_SEARCH_CONTRACT.readyWaitMs), signal);
    const finalUrl = checkWebAddress(page.url() || target.href).href;
    const got = await untilAborted(page.evaluate<Extracted>(extractionScript()), signal).catch((error: unknown) => {
      aborted(signal);
      throw new WebToolError("page_failed", "the page text could not be read");
    });
    if (page.refusedAddress()) throw new WebToolError("address_refused", "the page led to a local or private network address");
    const truncated = got.text.length > WEB_READ_TEXT_MAX_CHARS;
    return {
      url: finalUrl,
      title: got.title || hostOf(finalUrl),
      site: hostOf(finalUrl),
      text: truncated ? got.text.slice(0, WEB_READ_TEXT_MAX_CHARS) : got.text,
      truncated,
    };
  } finally {
    await page?.close().catch(() => undefined);
  }
}
