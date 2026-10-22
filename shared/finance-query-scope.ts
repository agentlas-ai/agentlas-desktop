import type { FinanceDataRequest } from "./finance";

/**
 * Only these metrics hand `query` to a provider (an author handle or a search term). Every other metric ignores it: a filings request returns the issuer's
 * latest records whatever the sentence says. `query` is the model's own wording, so a card must not present it as what the data was asked.
 */
const SEARCHES_WITH_TEXT: ReadonlySet<string> = new Set(["social", "social_search", "macro_news"]);

/** The ticker an asset id carries, for every id the providers make (`sec:<cik>:<ticker>`, `av:<symbol>`, `yahoo:<symbol>`, `ishares:<symbol>`); a manual holding's id carries none. */
export function financeAssetIdSymbol(id: string): string | null {
  const sec = /^sec:\d{10}:([^:]+)$/.exec(id);
  if (sec) return sec[1];
  const plain = /^(?:av|ishares):([^:]+)$/.exec(id);
  if (plain) return plain[1];
  const yahoo = /^yahoo:([^:]+)$/.exec(id);
  if (!yahoo) return null;
  try { return decodeURIComponent(yahoo[1]); } catch { return null; }
}

/**
 * What a query card or phone document names as its subject, from the host's own data: the assets it was run on, else the tickers in the request's asset
 * ids, else (only where the provider searched with it) the search text. An empty string is "no subject line". The model's sentence about a metric that
 * ignores it (1008 F26: a filings card headed "Verify the former name … with the date of the name change" over the latest unrelated filings) is never shown.
 */
export function financeQueryScope(request: Pick<FinanceDataRequest, "query" | "assetIds" | "metrics"> | null, assets: readonly { symbol: string }[] = []): string {
  if (assets.length) return assets.map(asset => asset.symbol).join(" · ");
  if (!request) return "";
  if (request.metrics.some(metric => SEARCHES_WITH_TEXT.has(metric))) return request.query.trim();
  return [...new Set(request.assetIds.map(financeAssetIdSymbol).filter((symbol): symbol is string => !!symbol))].join(" · ");
}
