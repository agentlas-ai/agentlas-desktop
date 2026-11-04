/**
 * Analysis guides for Agentlas Finance: one per asset type and per situation, delivered by finance.guide.
 *
 * The model asks for a topic (an enum, never inferred from the owner's words by host code); the host answers with the same fixed
 * guide every time: which tools to call in which order with which metric and period, how to read what comes back, what the sources cannot
 * tell, and how to shape the written answer. Tool names, metrics and periods are checked against the real tool menu by
 * scripts/test-finance-guides.cjs, so a guide cannot send the model to a tool or a metric that does not exist.
 * A guide is a method, not advice: it never names a security to buy or sell.
 */
export type FinanceGuideTool = 'search' | 'query' | 'query.save' | 'load' | 'calculate' | 'portfolio.value' | 'portfolio.propose' | 'dashboard.feeds' | 'report.create' | 'report.read' | 'report.export' | 'apply' | 'monitor.create';
export interface FinanceGuideStep {
  tool: FinanceGuideTool;
  /** The metric for a `query`; one of the query tool's closed list. */
  metric?: string;
  period?: string;
  /** What to pass in `query` when it is not obvious, and what the step is for. */
  use: string;
}
export interface FinanceGuide {
  id: string;
  title: string;
  kind: 'asset' | 'situation';
  /** One line for the menu: the question this guide fits. */
  when: string;
  steps: readonly FinanceGuideStep[];
  /** How to read the returned rows; arithmetic the model may do from rows it was given, and what must stay "not available". */
  read: readonly string[];
  /** What the sources do not tell and the mistakes that follow. */
  pitfalls: readonly string[];
  /** The shape of the written answer or saved report. */
  report: readonly string[];
  related: readonly string[];
}
export const FINANCE_GUIDES_REVISION = 1;
const step = (tool: FinanceGuideTool, use: string, metric?: string, period?: string): FinanceGuideStep => ({ tool, ...(metric ? { metric } : {}), ...(period ? { period } : {}), use });

const COMMON_REPORT = ['Start with the answer in one or two sentences, then the two or three facts that carry it, each with its date.', 'Name the main uncertainty and what would change the view.', 'Say which parts came from a tool result and which are your own reading; keep an assumption visibly an assumption.'] as const;

export const FINANCE_GUIDES: readonly FinanceGuide[] = Object.freeze([
  {
    id: 'us-stock', title: 'U.S.-listed company', kind: 'asset', when: 'Understand a U.S.-listed company: business quality, growth, cash generation, recent filings.',
    steps: [
      step('search', 'The ticker (exact) or the English company name. Each listing is a separate security; pick the one on the owner\'s exchange and currency.'),
      step('query', 'Latest 40 filing records: what changed recently (10-K annual, 10-Q quarterly, 8-K events, proxy).', 'filings'),
      step('query', 'view "summary", concepts revenue, OperatingIncomeLoss, NetIncomeLoss, NetCashProvidedByUsedInOperatingActivities, PaymentsToAcquirePropertyPlantAndEquipment, EarningsPerShareDiluted.', 'company_facts'),
      step('query', 'Price path for context only.', 'price_history', '5Y'),
      step('query', 'Headlines to date the story; read them against the company before using them.', 'news'),
    ],
    read: [
      'Compare like with like: annual with annual (fiscal period FY), quarter with the same quarter a year earlier. A cash-flow figure in a 10-Q is year-to-date; never set a nine-month figure beside a three-month one.',
      'Margins and growth are arithmetic on rows you were given: operating margin = OperatingIncomeLoss / revenue for the same period; free cash flow is approximately operating cash flow minus capital expenditure for the same period; year-over-year growth needs both periods in the rows.',
      'Debt, share count, valuation multiples, analyst estimates and segment data are not in the tool results: say "not available here" rather than estimate. A trailing P/E is computable only from a price and four consecutive quarterly diluted EPS values you actually have, and must be labelled derived with its dates.',
    ],
    pitfalls: ['A restated figure appears under a later filing; use the newest filed value for a period and say so.', 'Price history is raw close, not total return.', 'A similar ticker or an ADR is another security.'],
    report: COMMON_REPORT, related: ['earnings-event', 'dividend-income', 'compare-assets'],
  },
  {
    id: 'kr-stock', title: 'Korea-listed company (KOSPI, KOSDAQ)', kind: 'asset', when: 'A Korean company or a KRW-priced listing.',
    steps: [
      step('search', 'Search with the ticker code and market suffix, for example 005930.KS (KOSPI) or 247540.KQ (KOSDAQ). The price provider matches Latin-script names and tickers only; a Hangul name finds nothing.'),
      step('query', 'Snapshot in KRW with the observation time.', 'price', 'current'),
      step('query', 'Daily history; currency stays KRW.', 'price_history', '1Y'),
      step('query', 'Korean headlines: pass the company name in Hangul (and the English name in a second call). Any language works.', 'news_search', '1W'),
      step('query', 'KRW per USD for the period when the owner compares with a U.S. holding; the series stays a separate series.', 'fx_rates', '1Y'),
    ],
    read: [
      'Korean filings (DART) and KRX disclosure are not connected, and the SEC sources do not cover Korean issuers: say that company financials and filings are unavailable here instead of filling them from memory.',
      'Headlines come from a news index and are claims by publishers; read the headline against the company asked. Use the ones that name it, and say how many results you set aside.',
      'Never convert KRW prices into USD or the reverse. Show each currency on its own; an FX series is context, not a conversion.',
    ],
    pitfalls: ['Ticker without the suffix may resolve to a different listing.', 'Dividend, foreign-ownership and short-selling data are not available from these sources.', 'The provider\'s timestamps are exchange-local; quote the date it returns.'],
    report: COMMON_REPORT, related: ['fx-commodity', 'thesis-check', 'compare-assets'],
  },
  {
    id: 'etf-fund', title: 'ETF or fund', kind: 'asset', when: 'What an ETF holds, what it costs to hold, and how it behaved.',
    steps: [
      step('search', 'The fund ticker. The result says whether issuer data is supported for it.'),
      step('query', 'Issuer NAV per share with its date. Supported only for the funds the search names (iShares IVV, IEF, TLT, IWM, IAU).', 'nav'),
      step('query', 'Issuer holdings file: top weights and concentration. Same supported funds only.', 'etf_holdings'),
      step('query', 'Market price path; compare with NAV only on the same date.', 'price_history', '5Y'),
    ],
    read: [
      'Concentration: add the top ten weights as printed; do not normalise weights that do not sum to 100%.',
      'Premium or discount to NAV is price minus NAV over NAV on one date, and only when both are in the results with that date.',
      'Fees, tracking error, distribution yield and securities lending are not in the sources: say they are not available here and point to the issuer\'s fact sheet instead of quoting numbers from memory.',
    ],
    pitfalls: ['A fund the catalog does not support has price history only; do not infer holdings from its name or a similar fund.', 'A gold trust is not a registered 1940 Act ETF and holds no securities to look through.', 'Price-only history excludes distributions.'],
    report: COMMON_REPORT, related: ['compare-assets', 'portfolio-review', 'risk-drawdown'],
  },
  {
    id: 'bond-rates', title: 'Bonds and interest rates', kind: 'asset', when: 'Where yields are, what the curve says, real versus nominal rates.',
    steps: [
      step('query', 'Official Treasury par curve for the month (period YYYYMM, for example 202611): every maturity.', 'treasury_yields', '202611'),
      step('query', 'query DGS10 (10-year), DGS2 (2-year), T10Y2Y (spread), DFII10 (real yield), T10YIE (breakeven inflation); one series per call.', 'macro_series', '1Y'),
      step('query', 'Policy rate: query FEDFUNDS (monthly) or DFF (daily).', 'macro_series', '5Y'),
      step('query', 'Official Federal Reserve announcements in date order.', 'macro_news'),
    ],
    read: [
      'Curve shape from the par curve rows: compare the 2-year and 10-year points on the same date; a negative T10Y2Y means the 2-year yield is above the 10-year.',
      'Real yield (DFII10) and breakeven (T10YIE) are separate published series; do not subtract them yourself and call it a forecast.',
      'Duration arithmetic is allowed as a labelled approximation: price change is about minus modified duration times the yield change; state the duration you assumed.',
    ],
    pitfalls: ['The par curve is a government curve, not an individual bond price or yield to maturity.', 'Credit spreads and corporate bond prices are not available here.', 'Yields are % per annum; spreads are percentage points.'],
    report: COMMON_REPORT, related: ['macro-regime', 'fx-commodity'],
  },
  {
    id: 'crypto', title: 'Crypto assets', kind: 'asset', when: 'A coin or crypto ETF price, trend and risk.',
    steps: [
      step('search', 'Yahoo-style pair ticker, for example BTC-USD or ETH-USD.'),
      step('query', 'Snapshot with its time.', 'price', 'current'),
      step('query', 'Daily history to describe the path and the range.', 'price_history', '1Y'),
      step('query', 'Headlines for the period; treat claims as claims.', 'news_search', '1W'),
    ],
    read: ['Crypto trades around the clock; the daily bar is the provider\'s, so quote its date and do not describe it as a closing price of a session.', 'Describe the range as high and low closes from the rows; do not state a volatility figure unless you computed it from rows you hold, and then label it.'],
    pitfalls: ['No filings, earnings or fundamentals exist for a coin; do not borrow stock vocabulary.', 'On-chain data, exchange order books and derivatives are not available here.', 'A crypto ETF is a fund: use the etf-fund guide for its holdings and NAV where supported.'],
    report: COMMON_REPORT, related: ['risk-drawdown', 'thesis-check'],
  },
  {
    id: 'fx-commodity', title: 'Currencies and commodities', kind: 'asset', when: 'An exchange rate, the dollar, oil, gold, or how they affect a holding.',
    steps: [
      step('query', 'query BASE/QUOTE, for example USD/KRW or EUR/JPY; daily ECB reference rates, one pair per call.', 'fx_rates', '1Y'),
      step('query', 'The U.S. broad dollar index (DTWEXBGS), oil (DCOILWTICO, DCOILBRENTEU) or the Fed\'s KRW rate (DEXKOUS); one series per call.', 'macro_series', '1Y'),
      step('search', 'Futures and spot tickers on the price provider: CL=F (crude), GC=F (gold), SI=F (silver), DX-Y.NYB (dollar index).'),
      step('query', 'Price path for the ticker you found.', 'price_history', '1Y'),
    ],
    read: ['ECB reference rates are published once a working day; they are not a bank or a tradable quote.', 'Two sources can disagree by a small amount (ECB reference versus the Fed\'s noon rate); when two sources differ, say which one each number is.', 'The effect on a holding is described in words from currency and revenue facts you have; the tools never convert a holding.'],
    pitfalls: ['Never convert a position or price from one currency to another with a rate from here; show each currency separately.', 'Gold and oil futures are contracts with expiries; their path is not the spot price.'],
    report: COMMON_REPORT, related: ['macro-regime', 'kr-stock', 'bond-rates'],
  },
  {
    id: 'macro-regime', title: 'Macro backdrop', kind: 'situation', when: 'Inflation, jobs, growth, rates and the dollar: where the economy stands and what has changed.',
    steps: [
      step('query', 'Prices: CPIAUCSL and CPILFESL (core), PCEPILFE (the Fed\'s measure); one series per call. Growth rates are computed from index levels you hold.', 'macro_series', '5Y'),
      step('query', 'Labor: UNRATE, PAYEMS, ICSA (weekly claims, a faster signal), JTSJOL.', 'macro_series', '5Y'),
      step('query', 'Activity: GDPC1 (quarterly), INDPRO, RSAFS, HOUST.', 'macro_series', '5Y'),
      step('query', 'Policy and market rates: FEDFUNDS, DGS2, DGS10, T10Y2Y.', 'macro_series', '5Y'),
      step('query', 'Official announcements for the same weeks.', 'macro_news'),
    ],
    read: [
      'Year-over-year inflation = latest index / index twelve months earlier minus one; both values must be in the rows; quote both dates.',
      'Group the reading: prices, labor, activity, policy. For each, say direction since the previous release and since a year ago, then the one number that matters.',
      'Releases differ in lag: weekly claims and daily yields are current, monthly series are a month old, GDP a quarter old. Say the lag next to the figure.',
    ],
    pitfalls: ['Published values are revised; a later release can change a past value.', 'The list of series is closed to U.S. agency data; other countries\' macro data are not available here.', 'A single indicator is not a regime call.'],
    report: COMMON_REPORT, related: ['bond-rates', 'fx-commodity'],
  },
  {
    id: 'earnings-event', title: 'Earnings or a filing event', kind: 'situation', when: 'A company just reported, filed an 8-K, or has an earnings date coming.',
    steps: [
      step('dashboard.feeds', 'The calendar and recent items for the watchlist when the company is saved there.'),
      step('query', 'The new filing records with dates and form types (10-Q, 10-K, 8-K).', 'filings'),
      step('query', 'view "summary": the newest quarter beside the same quarter a year earlier.', 'company_facts'),
      step('query', 'The days around the report date, to read the price move.', 'price_history', '3M'),
      step('query', 'What the press said, dated.', 'news'),
    ],
    read: ['Build the comparison from rows: revenue, operating income, net income and diluted EPS for the new quarter and the year-earlier quarter, each with its period end.', 'The price reaction is the close before and the close after the filing date in the rows; say the dates. Do not attribute the move to a cause the sources do not state.', 'Analyst consensus, guidance and the call transcript are not available here: say so and do not describe a beat or a miss.'],
    pitfalls: ['An 8-K can be unrelated to earnings.', 'A filing date is a day, not a time: intraday ordering is unknown.'],
    report: COMMON_REPORT, related: ['us-stock', 'thesis-check'],
  },
  {
    id: 'dividend-income', title: 'Dividends and income', kind: 'situation', when: 'Is a dividend safe, has it grown, what does a holding pay.',
    steps: [
      step('search', 'The listing; a dividend question is about one security.'),
      step('query', 'concepts ["dividends","NetCashProvidedByUsedInOperatingActivities","PaymentsToAcquirePropertyPlantAndEquipment","NetIncomeLoss"], view "summary": the dividend series is one observation per period.', 'company_facts'),
      step('query', 'Price for yield context.', 'price', 'current'),
      step('query', 'Recent filings for any change in policy.', 'filings'),
    ],
    read: ['Streak: count consecutive fiscal years in which the per-share dividend did not fall, from the annual rows only.', 'Coverage: dividends paid divided by operating cash flow minus capital expenditure for the same year; below 1 means the payout is covered by free cash flow. Show the inputs.', 'Yield = latest annual (or trailing four quarters\') dividend per share over the price you hold, with both dates.'],
    pitfalls: ['A special dividend is not a growth step.', 'Funds and REITs report distributions differently; use the etf-fund guide for funds.', 'Tax treatment is not covered by any source.'],
    report: COMMON_REPORT, related: ['us-stock', 'etf-fund'],
  },
  {
    id: 'portfolio-review', title: 'Review saved holdings', kind: 'situation', when: 'How the owner\'s saved positions are doing, where the concentration is, what is missing.',
    steps: [
      step('load', 'The saved holdings, watchlist and revision. A photo or pasted text is proposed with portfolio.propose and saved only by the owner.'),
      step('portfolio.value', 'Refresh prices and freeze complete per-currency values; positions without a verified price stay listed as unpriced.'),
      step('calculate', 'kind "allocation" over two or more held assets in one currency for volatility and risk share from aligned daily history; kind "forecast" over one asset for a bootstrap scenario range.'),
    ],
    read: ['Weights and totals exist per currency only. Report the largest positions and the share of the top three within each currency.', 'A position with no verified price is a gap in the review, never zero. Say how many positions were priced of how many.', 'Computed volatility and scenarios describe past price behaviour under stated assumptions; they are not forecasts of returns.'],
    pitfalls: ['The photo of an account is an unverified input.', 'Cost basis, taxes and fees are not covered.', 'No trade is proposed or placed from here.'],
    report: ['Open with the one finding the owner should act on or know (concentration, an unpriced position, a currency).', ...COMMON_REPORT.slice(1)], related: ['risk-drawdown', 'compare-assets', 'etf-fund'],
  },
  {
    id: 'risk-drawdown', title: 'Risk and drawdown', kind: 'situation', when: 'How bad has it been, how volatile is it, what range of outcomes is plausible.',
    steps: [
      step('query', 'Daily history, the longest the owner cares about.', 'price_history', '5Y'),
      step('calculate', 'kind "forecast" for one asset: horizon in trading days, bootstrapped from its own history; returns percentiles.'),
      step('calculate', 'kind "allocation" for several assets in one currency: annualised volatility and each asset\'s share of risk.'),
    ],
    read: ['Maximum drawdown: take the highest close and the lowest close after it from the rows, and quote both dates and values. Do not estimate it.', 'Scenario percentiles come from the calculate result; describe them as a range under the bootstrap assumption.', 'A 1Y window and a 5Y window can tell different stories: say which window each number comes from.'],
    pitfalls: ['Price history excludes dividends.', 'The bootstrap repeats the past; it cannot show a regime the history does not contain.', 'A short history (under about 31 daily points) cannot be computed on.'],
    report: COMMON_REPORT, related: ['portfolio-review', 'compare-assets'],
  },
  {
    id: 'compare-assets', title: 'Compare assets', kind: 'situation', when: 'A versus B: performance, risk, fundamentals.',
    steps: [
      step('search', 'Each candidate separately; confirm venue and currency of each.'),
      step('query', 'Same period for each, one asset per call.', 'price_history', '1Y'),
      step('query', 'For companies: the same concepts and view for each.', 'company_facts'),
      step('calculate', 'kind "allocation" when both are in one currency, for correlation-aware volatility and risk share.'),
    ],
    read: ['Compare only same-currency series, over the same dates; normalise both to 100 at the first common date from the rows you hold.', 'State the common period explicitly. If one asset has a shorter history, cut the comparison to it.', 'Fundamentals only when both have the same fiscal periods available.'],
    pitfalls: ['A ranking from two numbers is thin; say what is not compared.', 'Different currencies are shown side by side, never converted.'],
    report: COMMON_REPORT, related: ['risk-drawdown', 'us-stock', 'etf-fund'],
  },
  {
    id: 'thematic-research', title: 'Theme or sector research', kind: 'situation', when: 'Which companies are exposed to a theme; there is no list yet.',
    steps: [
      step('query', 'The theme in several phrasings, in the languages the theme is covered in; headlines name the companies involved.', 'news_search', '1M'),
      step('search', 'Verify each candidate you intend to discuss: one lookup per candidate, exact ticker.'),
      step('query', 'Revenue and operating income for each verified candidate.', 'company_facts'),
      step('dashboard.feeds', 'If candidates are saved to the watchlist, their calendar and filings in one call.'),
    ],
    read: ['There is no market-wide screener in these tools: say the list is what the sources surfaced, not the whole universe.', 'Separate "named in headlines" from "has the theme in its financials". Keep both groups.', 'Cap the discussion at the candidates you verified, and say how many you looked up.'],
    pitfalls: ['A ticker lookup is not an exhaustive screen.', 'Headlines mention many companies in passing.'],
    report: COMMON_REPORT, related: ['thesis-check', 'us-stock'],
  },
  {
    id: 'thesis-check', title: 'Check a claim or rumor', kind: 'situation', when: 'Is it true that ...? A post, a headline or a tip the owner saw.',
    steps: [
      step('query', 'The claim\'s subject in the language of the claim, newest first.', 'news_search', '1W'),
      step('query', 'Public discussion for attribution (an account\'s own posts or a topic search).', 'social_search', '1W'),
      step('query', 'The primary record: filings for a company claim; Fed announcements for a policy claim.', 'filings'),
    ],
    read: ['Sort what you found into: official record, publisher report, anonymous or social claim. Quote which one each statement comes from.', 'If the primary record does not mention it, say that no record was found in these sources, not that it is false.', 'Say what evidence would settle it and where the owner could look.'],
    pitfalls: ['A repeated claim is not independent confirmation.', 'Social posts are unverified.'],
    report: ['Verdict in plain words: confirmed by a primary record / reported but unconfirmed / no record found.', ...COMMON_REPORT.slice(1)], related: ['earnings-event', 'thematic-research'],
  },
  {
    id: 'report-structure', title: 'Write the finished report', kind: 'situation', when: 'The research is done and the owner wants a document to read or share.',
    steps: [
      step('query.save', 'Freeze the evidence the report rests on: mode "report" for the first dataset, then each further dataset with the same reportId and the current expectedRevision.'),
      step('report.read', 'Read the saved report before writing about it.'),
      step('apply', 'Write the summary into the report (title, language, sections) at the returned revision.'),
      step('report.export', 'Write the finished report as one HTML file the owner can open, print or send; it is listed in the conversation\'s outputs. Do this once the summary is written.'),
    ],
    read: [
      'Order: the answer, the evidence (a chart or a small table), then the risks and what would change the view.',
      'Write in the language the owner used. Plain sentences; numbers only where they carry the argument; each number is followed by the date it is for.',
      'The host keeps the records of where each value came from and draws no source list or retrieval line in a report: do not add one.',
      'Say what was not available (a metric with no source, a market not covered). A gap stated is part of the answer.',
    ],
    pitfalls: ['Do not put raw rows or tool names in the prose.', 'Do not call a scenario a forecast.', 'A report is research, not advice to trade.'],
    report: ['Verdict line first.', 'Then why: two or three drivers with numbers and the date each is for.', 'Then risks and what would change the view.', 'Then what was not available.'], related: [],
  },
]);

export const FINANCE_GUIDE_TOPICS = Object.freeze(FINANCE_GUIDES.map(guide => guide.id)) as readonly string[];
export interface FinanceGuideMenuEntry { topic: string; title: string; kind: FinanceGuide['kind']; when: string }
export function financeGuideMenu(): FinanceGuideMenuEntry[] { return FINANCE_GUIDES.map(({ id, title, kind, when }) => ({ topic: id, title, kind, when })); }
export function financeGuide(topic: string): FinanceGuide | undefined { return FINANCE_GUIDES.find(guide => guide.id === topic); }
