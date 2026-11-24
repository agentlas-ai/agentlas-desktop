/**
 * Web sources of an answer.
 *
 * ONE pure place that reads "which pages did this tool open or list" out of a tool event, for every runtime. The record shape,
 * the 20-per-answer cap, the order (pages read first, then search results) and the favicon rule are the `source` block of
 * web-search.json (agentlas.web-source.v1). An address enters here only from what a tool opened (its own arguments / the page URL
 * the browser reported) or what a search listed (the search tool's own result) — never from words the model wrote in its answer.
 *
 * No imports: the main process, the renderer and the contract test all load this file as is.
 *
 * Adapters (each says whether a real sample was seen; the test file holds the fixtures):
 *  - built-in `web_search` / `web_read` (D1; JSON text, format fixed by contract)            sample: contract text
 *  - Claude Code `WebSearch` (`Links: [{title,url}]`) and `WebFetch` (args.url)             sample: format of the CLI's tool_result
 *  - Codex `webSearch` item (results[] opaque JSON, action openPage/findInPage {url})       sample: protocol schema (codex app-server generate-json-schema); result item keys NOT seen
 *  - Antigravity `search_web` (`Sources:` list of `[host](url)`), `read_url_content` {Url}  sample: real agy transcript step output
 *  - ACP lanes (grok, kimi, cursor, copilot): kind fetch (rawInput.url) / search (JSON or links) sample: NONE for web tools (only grep/read seen)
 *  - Agentlas browser `browser_navigate`, any name prefix (Page URL / Page Title lines)     sample: Playwright MCP output format
 */

export interface WebSource {
  url: string;
  title: string;
  /** Host without a leading `www.` (or the site name a search listed). */
  site: string;
  snippet?: string;
  /** `page` = a page a tool opened and read; `search` = a result a search page listed. */
  kind: "search" | "page";
}

export const WEB_SOURCES_MAX_PER_ANSWER = 20;
const TITLE_MAX = 300;
const SNIPPET_MAX = 500;
const URL_MAX = 2048;
export const WEB_SOURCE_FAVICON_RULE = "https://icons.duckduckgo.com/ip3/{host}.ico";

export interface WebSourcesFromToolInput {
  toolName: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  /** Runner kind (claude-code, codex, antigravity, grok, kimi, cursor, github-copilot-cli, byok, ...). */
  runtimeKind?: string;
  /** Typed tool kind a runner reported (ACP: "search" | "fetch" | ...). */
  toolKind?: string;
}

const clean = (value: string, max: number): string => value.replace(/\s+/g, " ").trim().slice(0, max);

export function webSourceSiteOfUrl(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./i, ""); } catch { return ""; }
}

function publicHttpUrl(raw: unknown): URL | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > URL_MAX || !/^https?:\/\//i.test(text)) return null;
  let parsed: URL;
  try { parsed = new URL(text); } catch { return null; }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".invalid")
    || host.endsWith(".internal") || host === "::1" || host === "[::1]" || /^127\./.test(host) || host === "0.0.0.0") return null;
  return parsed;
}

function makeSource(input: { url: unknown; title?: unknown; site?: unknown; snippet?: unknown; kind: "search" | "page" }): WebSource | null {
  const parsed = publicHttpUrl(input.url);
  if (!parsed) return null;
  parsed.hash = "";
  const url = parsed.href;
  const urlSite = webSourceSiteOfUrl(url);
  const site = typeof input.site === "string" && clean(input.site, 120) ? clean(input.site, 120).replace(/^www\./i, "") : urlSite;
  const title = typeof input.title === "string" && clean(input.title, TITLE_MAX) ? clean(input.title, TITLE_MAX) : site;
  const snippet = typeof input.snippet === "string" && clean(input.snippet, SNIPPET_MAX) ? clean(input.snippet, SNIPPET_MAX) : undefined;
  return { url, title, site, ...(snippet ? { snippet } : {}), kind: input.kind };
}

/** Validate a persisted / received list (ledger payload, IPC): drops anything that is not a well-formed WebSource. */
export function parseWebSources(value: unknown): WebSource[] {
  if (!Array.isArray(value)) return [];
  const out: WebSource[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const source = makeSource({ url: record.url, title: record.title, site: record.site, snippet: record.snippet, kind: record.kind === "page" ? "page" : "search" });
    if (source) out.push(source);
    if (out.length >= WEB_SOURCES_MAX_PER_ANSWER * 2) break;
  }
  return out;
}

/**
 * Combine lists into one answer's sources: pages that were read first (in the order given), then search results (in the order given),
 * one entry per address (a page that was also listed by a search keeps the page's kind and takes the listing's snippet), at most 20.
 */
export function mergeWebSources(...lists: ReadonlyArray<ReadonlyArray<WebSource> | undefined>): WebSource[] {
  const byUrl = new Map<string, WebSource>();
  const pageOrder: string[] = [];
  const searchOrder: string[] = [];
  for (const list of lists) {
    for (const source of list ?? []) {
      const key = source.url.replace(/#.*$/, "");
      const existing = byUrl.get(key);
      if (!existing) {
        byUrl.set(key, source);
        (source.kind === "page" ? pageOrder : searchOrder).push(key);
        continue;
      }
      if (existing.kind === "search" && source.kind === "page") {
        searchOrder.splice(searchOrder.indexOf(key), 1);
        pageOrder.push(key);
        byUrl.set(key, { ...source, ...(source.snippet || existing.snippet ? { snippet: source.snippet ?? existing.snippet } : {}) });
      } else if (existing.kind === "page" && source.kind === "search" && !existing.snippet && source.snippet) {
        byUrl.set(key, { ...existing, snippet: source.snippet });
      }
    }
  }
  return [...pageOrder, ...searchOrder].slice(0, WEB_SOURCES_MAX_PER_ANSWER).map((key) => byUrl.get(key)!);
}

/** Favicon address for a source (the rule is web-search.json `favicon`); null when there is no host. */
export function webSourceFaviconUrl(source: Pick<WebSource, "url" | "site">): string | null {
  const siteHost = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(source.site) ? source.site.toLowerCase() : "";
  const host = siteHost || webSourceSiteOfUrl(source.url);
  return host ? WEB_SOURCE_FAVICON_RULE.replace("{host}", host) : null;
}

// ---------------------------------------------------------------------------------------------------------------- tool naming

/** `mcp__agentlas-browser__browser_navigate`, `agentlas-browser.browser_navigate`, comparable key `browsernavigate`. */
function toolKey(toolName: string): string {
  const name = toolName.trim();
  const last = name.split(/__|\./).filter(Boolean).pop() ?? name;
  return last.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const SEARCH_KEYS = new Set(["websearch", "searchweb", "googlesearch", "googlesearchretrieval", "websearchcall", "searchtheweb", "internetsearch"]);
const FETCH_KEYS = new Set(["webfetch", "fetchurl", "fetchwebpage", "readurlcontent", "readurl", "webread", "openurl"]);
const NAVIGATE_KEYS = new Set(["browsernavigate"]);

function argsRecord(args: unknown): Record<string, unknown> | null {
  let value = args;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text.startsWith("{")) return null;
    try { value = JSON.parse(text); } catch { return null; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function argsUrl(args: unknown): string | null {
  const record = argsRecord(args);
  if (!record) return null;
  for (const key of ["url", "Url", "URL", "uri", "Uri", "href", "link"]) if (typeof record[key] === "string") return record[key] as string;
  return null;
}

function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result == null) return "";
  try { return JSON.stringify(result); } catch { return ""; }
}

/** An MCP result is `{content:[{type:"text",text}]}` once the runner stringified it; unwrap to the text the tool printed. */
function unwrapMcpText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const content = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" ? (parsed as { content?: unknown }).content : undefined);
    if (Array.isArray(content)) {
      const texts = content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).filter(Boolean);
      if (texts.length) return texts.join("\n");
    }
  } catch { /* not an MCP envelope */ }
  return text;
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
}

const URL_KEYS = ["url", "link", "href", "uri", "page_url", "pageUrl", "source_url", "sourceUrl"];
const TITLE_KEYS = ["title", "name", "page_title", "pageTitle", "headline"];
const SNIPPET_KEYS = ["snippet", "description", "summary", "text", "content", "excerpt"];

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) if (typeof record[key] === "string" && (record[key] as string).trim()) return record[key] as string;
  return undefined;
}

function listedEntries(items: unknown, kind: "search" | "page"): WebSource[] {
  if (!Array.isArray(items)) return [];
  const out: WebSource[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    // One level of nesting some providers use: {web:{url,title}} / {source:{url,title}}.
    const inner = (["web", "source", "page"] as const).map((key) => record[key]).find((value) => value && typeof value === "object") as Record<string, unknown> | undefined;
    const flat = inner ? { ...inner, ...record } : record;
    const url = firstString(flat, URL_KEYS);
    if (!url) continue;
    const source = makeSource({ url, title: firstString(flat, TITLE_KEYS), site: typeof flat.site === "string" ? flat.site : undefined, snippet: firstString(flat, SNIPPET_KEYS), kind });
    if (source) out.push(source);
  }
  return out;
}

/** Walk a parsed JSON value for the arrays a search tool uses for its listing. */
function listingFromJson(value: unknown): WebSource[] {
  if (Array.isArray(value)) return listedEntries(value, "search");
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of ["results", "links", "items", "sources", "citations", "organic", "organic_results", "web_results", "webResults", "data"]) {
    const direct = listedEntries(record[key], "search");
    if (direct.length) return direct;
    const nested = record[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const deeper = listingFromJson(nested);
      if (deeper.length) return deeper;
    }
  }
  return [];
}

/** Claude Code's WebSearch prints `Links: [{"title":"...","url":"..."}, ...]` on one line before the summary. */
function claudeLinks(text: string): WebSource[] | null {
  const at = text.search(/(?:^|\n)\s*Links:\s*\[/);
  if (at < 0) return null;
  const start = text.indexOf("[", at);
  const lineEnd = text.indexOf("\n", start);
  const line = text.slice(start, lineEnd < 0 ? undefined : lineEnd).trim();
  const parsed = parseJson(line);
  if (Array.isArray(parsed)) return listedEntries(parsed, "search");
  // The preview a run keeps can cut the array: read the complete {"title":..,"url":..} objects that are there.
  const out: WebSource[] = [];
  for (const match of line.matchAll(/\{\s*"title"\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*"url"\s*:\s*("(?:[^"\\]|\\.)*")\s*\}/g)) {
    try {
      const source = makeSource({ url: JSON.parse(match[2]), title: JSON.parse(match[1]), kind: "search" });
      if (source) out.push(source);
    } catch { /* skip the broken object */ }
  }
  return out;
}

const MARKDOWN_LINK = /\[([^\]\n]{1,300})\]\((https?:\/\/[^)\s]+)\)/g;
const HOST_LABEL = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i;

function markdownLinks(text: string, kind: "search" | "page"): WebSource[] {
  const out: WebSource[] = [];
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const label = match[1].trim();
    const hostLabel = HOST_LABEL.test(label);
    const source = makeSource({ url: match[2], title: label, ...(hostLabel ? { site: label } : {}), kind });
    if (source) out.push(source);
  }
  return out;
}

/** Antigravity `search_web` ends with `Sources:\n[1] [host](redirect-url)`; only that list counts, not links inside the summary. */
function sourcesBlock(text: string): WebSource[] | null {
  const at = text.search(/(?:^|\n)\s*Sources:\s*\n/);
  if (at < 0) return null;
  return markdownLinks(text.slice(at), "search");
}

const ACP_LIKE = new Set(["grok", "kimi", "cursor", "github-copilot-cli", "copilot", "acp"]);

// ---------------------------------------------------------------------------------------------------------------- entry point

export function webSourcesFromTool(input: WebSourcesFromToolInput): WebSource[] {
  if (input.isError === true || input.result === undefined || input.result === null) return [];
  const key = toolKey(input.toolName ?? "");
  const kind = (input.toolKind ?? "").toLowerCase();
  const runtime = (input.runtimeKind ?? "").toLowerCase();
  const isSearch = SEARCH_KEYS.has(key);
  const isFetch = FETCH_KEYS.has(key);
  const isNavigate = NAVIGATE_KEYS.has(key);
  const acpSearch = !isSearch && !isFetch && !isNavigate && kind === "search" && ACP_LIKE.has(runtime) && webQueryArgs(input.args);
  const acpFetch = !isSearch && !isFetch && !isNavigate && kind === "fetch" && argsUrl(input.args) !== null;
  if (!isSearch && !isFetch && !isNavigate && !acpSearch && !acpFetch) return [];

  const raw = resultText(input.result);
  const text = unwrapMcpText(raw);

  if (isNavigate) {
    const pageUrl = /Page URL:\s*(\S+)/.exec(text)?.[1]?.replace(/[\\",]+$/, "");
    if (pageUrl && !publicHttpUrl(pageUrl)) return []; // about:blank, chrome-error://, a non-public host: not a source
    const titleLine = /Page Title:\s*([^\n\r]*)/.exec(text)?.[1]?.replace(/\\n.*$/s, "").trim();
    const source = makeSource({ url: pageUrl ?? argsUrl(input.args), title: titleLine || undefined, kind: "page" });
    return source ? [source] : [];
  }

  if (isFetch || acpFetch) {
    // A reader that echoes its page (built-in web_read) names the FINAL address; otherwise the address it was asked to open.
    const json = parseJson(text);
    const record = json && typeof json === "object" && !Array.isArray(json) ? json as Record<string, unknown> : null;
    const source = makeSource({
      url: (record && typeof record.url === "string" ? record.url : null) ?? argsUrl(input.args),
      title: record && typeof record.title === "string" ? record.title : undefined,
      site: record && typeof record.site === "string" ? record.site : undefined,
      kind: "page",
    });
    return source ? [source] : [];
  }

  // Search.
  const fromJson = listingFromJson(parseJson(text));
  if (fromJson.length) return fromJson;
  const links = claudeLinks(text);
  if (links) return links;
  const block = sourcesBlock(text);
  if (block?.length) return block;
  if (runtime === "claude-code" || runtime === "codex" || runtime === "antigravity") return codexActionPages(text);
  return markdownLinks(text, "search");
}

function webQueryArgs(args: unknown): boolean {
  const record = argsRecord(args);
  if (!record) return false;
  // A local grep/glob is also kind "search" on ACP: only a web query (a `query` and no file pattern/path) is a web search.
  return typeof record.query === "string" && !("pattern" in record) && !("path" in record) && !("glob" in record);
}

/** Codex's webSearch result is `{query, action?, results?}`; an openPage / findInPage action names a page the search tool opened. */
function codexActionPages(text: string): WebSource[] {
  const json = parseJson(text);
  if (!json || typeof json !== "object" || Array.isArray(json)) return [];
  const action = (json as { action?: unknown }).action;
  if (!action || typeof action !== "object") return [];
  const record = action as Record<string, unknown>;
  if (record.type !== "openPage" && record.type !== "findInPage") return [];
  const source = makeSource({ url: record.url, kind: "page" });
  return source ? [source] : [];
}
