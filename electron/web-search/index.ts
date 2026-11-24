// Host tools web_search / web_read for API and local-model runtimes. Electron-free (the background daemon loads this).
import { WebToolError } from "./errors";
import type { WebPageProvider } from "./browser";
import { readWebPage, searchWeb } from "./search";

export { WebToolError, type WebToolErrorCode } from "./errors";
export { searchWeb, readWebPage, WEB_READ_TEXT_MAX_CHARS, type WebSearchResult, type WebReadResult } from "./search";
export { sharedWebBrowser, SharedHeadlessBrowser, WEB_BROWSER_IDLE_CLOSE_MS } from "./browser";
export { checkWebAddress, isPrivateAddress } from "./address";

export type WebToolOutcome = { ok: true; content: string } | { ok: false; content: string };

function failure(error: unknown, signal: AbortSignal | undefined): WebToolOutcome {
  if (signal?.aborted) throw error;
  if (error instanceof WebToolError) return { ok: false, content: error.message };
  return { ok: false, content: `page_failed: ${error instanceof Error ? error.message.slice(0, 200) : "unexpected error"}` };
}

/** The exact JSON the model reads from web_search. */
export async function runWebSearchTool(input: { query: string; count?: number }, ctx: { locale?: string; signal?: AbortSignal; provider?: WebPageProvider }): Promise<WebToolOutcome> {
  try {
    const result = await searchWeb({ ...input, ...ctx });
    return { ok: true, content: JSON.stringify({ query: result.query, engine: result.engine, results: result.results }) };
  } catch (error) { return failure(error, ctx.signal); }
}

/** The exact JSON the model reads from web_read. */
export async function runWebReadTool(input: { url: string }, ctx: { locale?: string; signal?: AbortSignal; provider?: WebPageProvider }): Promise<WebToolOutcome> {
  try {
    const result = await readWebPage({ ...input, ...ctx });
    return { ok: true, content: JSON.stringify({ url: result.url, title: result.title, site: result.site, text: result.text, truncated: result.truncated }) };
  } catch (error) { return failure(error, ctx.signal); }
}
