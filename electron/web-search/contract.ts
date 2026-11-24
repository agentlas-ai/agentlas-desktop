// The shared web-search contract (shared/web-search/*, copied byte for byte from the phone app's contract; never edited here). Electron-free: the background daemon loads this too.
import fs from "node:fs";
import path from "node:path";

export interface EngineSpec { url: string; ready: string }
export interface WebSearchContract {
  engines: Record<string, EngineSpec>;
  order: { desktop: string[]; phone: string[] };
  region: Record<string, { region: string; lang: string }>;
  readyWaitMs: number;
  pageLoadTimeoutMs: number;
  results: { default: number; max: number };
  /** Icon address of a source's site, `{host}` filled in (shared/web-search/web-search.json `favicon`). */
  favicon: string;
}

/**
 * The two contract files, read where this build put them: `dist/shared/web-search/` (build:electron copies them there; tsc emits no
 * .js copy of a plain script) or, for a build path that only compiles TypeScript (the pre-commit snapshot, the dev harness), the
 * repository's own `shared/web-search/`. One reader for both, so a build step that forgets the copy cannot turn search off.
 */
function contractFile(name: string): string {
  const candidates = [path.resolve(__dirname, "../../shared/web-search", name), path.resolve(__dirname, "../../../shared/web-search", name)];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return fs.readFileSync(candidate, "utf8");
  throw new Error(`web_search_contract_missing:${name}`);
}

export const WEB_SEARCH_CONTRACT = JSON.parse(contractFile("web-search.json")) as WebSearchContract;

let serpSource: string | null = null;
/** web-search-serp.js: a function expression (see contractFile for where it is read). */
export function serpExtractorSource(): string {
  if (serpSource === null) serpSource = contractFile("web-search-serp.js").trim();
  return serpSource;
}

/** Region and language codes for the person's UI language; `default` when the contract names none. */
export function regionFor(locale: string | undefined): { region: string; lang: string } {
  const primary = String(locale ?? "").toLowerCase().split(/[-_]/u)[0];
  return WEB_SEARCH_CONTRACT.region[primary] ?? WEB_SEARCH_CONTRACT.region.default;
}

export function engineUrl(engineId: string, query: string, locale: string | undefined): string {
  const spec = WEB_SEARCH_CONTRACT.engines[engineId];
  if (!spec) throw new Error(`web_search_unknown_engine:${engineId}`);
  const { region, lang } = regionFor(locale);
  return spec.url.replace("{q}", encodeURIComponent(query)).replace("{region}", region).replace("{lang}", lang);
}
