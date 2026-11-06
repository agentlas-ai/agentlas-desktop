import { FinanceNativeResultSchema } from './finance-native-ui';
import { financeCanvasDocument, financeCanvasFromLegacy } from './finance-canvas';
import { canvasSummaryLines } from './canvas';
import './canvas/blocks/registry'; // the phone's card is drawn here, so every asset block must be known (only the host imports this file)
import { financePortfolioLineText } from './finance-portfolio';
import { financeDatedSeries } from './finance-data-visual';
import { financeReportCompositionSpec, financeReportComputeMetrics, financeReportLocale, financeReportProseBlocks, financeReportWarnings, selectFinanceReportSections } from './finance-report-presentation';
import { screenInlineVisualHtml, validateInlineUiPresentationContent, type InlineUiPresentationContent } from './inline-ui-presentation';
import { INTELLECT_UI_LIMITS, type IntellectUiNode } from './intellect-ui';

/** The largest drawn card (HTML bytes) one phone message carries: the message text cap in electron/mobile-bridge/sanitize.ts leaves room for the fence around it. */
export const MOBILE_VISUAL_HTML_BYTES = 180 * 1024;
const text = (value: string): IntellectUiNode => ({ type: 'text', text: value });
const native = (children: IntellectUiNode[], title?: string): InlineUiPresentationContent => ({ kind: 'native', document: { version: 1, ...(title ? { title } : {}), children } });
const unavailable = () => [native([text('This Finance result cannot be displayed here.')])];
/** A table cell on the phone is plain text: links keep their label, emphasis and code marks go. */
const plainCell = (value: string) => value.replace(/\[([^\]\n]{1,1000})\]\(([^\s)]+)\)/g, '$1').replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, '$1$2').replace(/`([^`\n]+)`/g, '$1').trim();

/** A literal daily price or Treasury series as the phone's chart: provider observations only, points never imply interpolation across missing days.
 *  `null` is "not a chart"; `empty` is a series with no numeric observation at all. The same series is drawn for a query result and for a saved report section. */
function seriesChart(columns: readonly string[], rows: readonly (string | number | null)[][], metric: string | undefined): { spec: Record<string, unknown> } | { empty: true } | null {
  // A FRED series or an ECB pair (macro_series, fx_rates): one label, one unit, the same literal points, titled with its own unit.
  if (metric === 'series') {
    const dated = rows.length <= 2000 ? financeDatedSeries({ columns: [...columns], rows: rows.map(row => [...row]) }) : null;
    return dated ? { spec: { data: { values: dated.points.map(point => ({ date: point.date, series: dated.label, value: point.value })) }, mark: { type: 'point', tooltip: true }, encoding: {
      x: { field: 'date', type: 'temporal', title: null }, y: { field: 'value', type: 'quantitative', title: dated.unit, scale: { zero: false } }, color: { field: 'series', type: 'nominal', title: null } } } } : null;
  }
  const series = metric === 'treasury_yields' ? 'Maturity' : metric === 'price_history' ? 'Symbol' : null;
  const amount = metric === 'treasury_yields' ? 'Par curve yield' : 'Close (raw)';
  const at = (name: string) => columns.indexOf(name);
  const currencies = new Set(rows.map(row => row[at('Currency')]));
  const chart = series && new Set(columns).size === columns.length && ['Observation date', series, amount].every(name => at(name) >= 0)
    && rows.length <= 2000 && (metric === 'treasury_yields'
      ? at('Unit') >= 0 && rows.every(row => row[at('Unit')] === '% per annum')
      : currencies.size === 1 && [...currencies].every(code => typeof code === 'string' && /^[A-Z]{3}$/.test(code) && code !== 'XXX'));
  if (!chart) return null;
  const values = rows.map(row => ({ date: row[at('Observation date')], series: row[at(series)], value: row[at(amount)] }));
  const dates = values.every(row => typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(Date.parse(row.date))
    && new Date(`${row.date}T00:00:00Z`).toISOString().slice(0, 10) === row.date && typeof row.series === 'string' && !!row.series.trim()
    && (row.value === null || typeof row.value === 'number' && Number.isFinite(row.value)));
  const keys = new Set(values.map(row => JSON.stringify([row.date, row.series])));
  if (dates && keys.size === values.length && !values.some(row => typeof row.value === 'number')) return { empty: true };
  if (!dates || keys.size !== values.length) return null;
  return { spec: { data: { values }, mark: { type: 'point', tooltip: true }, encoding: {
    x: { field: 'date', type: 'temporal', title: null }, y: { field: 'value', type: 'quantitative', title: metric === 'treasury_yields' ? '%' : [...currencies][0], scale: { zero: false } },
    color: { field: 'series', type: 'nominal', title: null },
  } } };
}

/** A query is a result the owner asked to see only when its rows draw as a series chart (the phone's rule); every other query (filings,
 *  news, company facts, keyword search, price rows) is what the model read to answer. The desktop host uses this to not present a card
 * for such a read at all (a Finance answer was preceded by Company facts, Form 4 and News cards). */
export function financeQueryDrawsSeries(request: { metrics: readonly string[] }, result: { status: string; columns: readonly string[]; rows: readonly (string | number | null)[][] }): boolean {
  if (result.status === 'error' || result.status === 'unconnected' || !result.rows.length) return false;
  const metric = request.metrics.length === 1 ? request.metrics[0] : undefined;
  const built = seriesChart(result.columns, result.rows, metric === 'macro_series' || metric === 'fx_rates' ? 'series' : metric);
  return !!built && 'spec' in built;
}

/** One clean line cut at `limit` characters, never through a surrogate pair: the phone's table widget cannot draw half of one. */
const clipText = (value: string, limit: number) => {
  const line = financePortfolioLineText(value);
  if (line.length <= limit) return line;
  const end = limit - 1;
  return `${line.slice(0, /[\uD800-\uDBFF]/.test(line[end - 1] ?? '') ? end - 1 : end)}…`;
};

/** Read-only display projection. No raw operation result, provenance dump or executable action enters the document. */
export function financeNativeTranscriptContents(value: unknown, options: { state?: string; maxVisualBytes?: number } = {}): readonly InlineUiPresentationContent[] {
  const checked = FinanceNativeResultSchema.safeParse(value);
  if (!checked.success) return [];
  const { view } = checked.data;
  const blocks: InlineUiPresentationContent[] = [];
  // Ticker candidates and the news, filings and price rows a query returned are what the model read to answer, not something
  // the owner asked to see: they stay out of the phone chat . A drawn series, a report and a holdings
  // proposal are results and stay.
  if (view.kind === 'search') return [];
  else if (view.kind === 'query') {
    const { result } = view;
    if (result.status === 'error' || result.status === 'unconnected' || !result.rows.length) return [];
    // Literal provider observations only. Points never imply interpolation across missing observations.
    const metric = view.request.metrics.length === 1 ? view.request.metrics[0] : undefined;
    const built = seriesChart(result.columns, result.rows, metric === 'macro_series' || metric === 'fx_rates' ? 'series' : metric);
    if (!built || 'empty' in built) return [];
    blocks.push({ kind: 'chart', spec: built.spec });
  } else if (view.kind === 'holdings') {
    // The phone shows the open proposal and where the decision is made; it cannot save. Once the owner has acted the table is dropped:
    // its rows are no longer what is saved. Cells stay inside the contract's text limits.
    const open = !options.state || options.state === 'awaiting-input';
    // One clean line (an older retained proposal may still hold breaks or half surrogate pairs), cut at the contract's length and never through a surrogate pair.
    const cell = (value: string | null, limit = 120) => value === null ? null : clipText(value, limit);
    const rows = view.draft.rows.map(row => [cell(row.name || row.symbol), cell(row.symbol, 40), cell(row.currency, 8), row.quantity, row.averageCost, row.price, cell(row.asOf, 40)]);
    const status = open ? 'Proposed from your photo or text. Nothing is saved until you review and confirm it.'
      : options.state === 'cancelled' ? 'Replaced by a newer proposal.'
      : options.state === 'ready' ? 'Reviewed and saved.'
      : 'This proposal is no longer open for review.';
    blocks.push(native([...(open ? [{ type: 'table' as const, columns: ['Name', 'Symbol', 'Currency', 'Quantity', 'Average cost', 'Price', 'As of'], rows }] : []), text(status)], 'Holdings to review'));
  } else if (view.kind === 'canvas' || view.kind === 'earnings' || view.kind === 'impact') {
    // The answer's own result card: the phone draws the very HTML the desktop draws (sandboxed visual), so both show the same card.
    const canvas = financeCanvasFromLegacy(view as { kind: string } & Record<string, unknown>);
    // A drawn card the phone's visual limits refuse is still shown, as the card's own plain-text lines, never as an empty "cannot be displayed".
    // A card past the phone's wire budget is shown the same way, so a big card is a readable summary and never a bare label.
    if (canvas) { const html = financeCanvasDocument(canvas); blocks.push(screenInlineVisualHtml(html).ok && new TextEncoder().encode(html).byteLength <= (options.maxVisualBytes ?? MOBILE_VISUAL_HTML_BYTES) ? { kind: 'visual', html } : native(canvasSummaryLines(canvas).map(line => text(clipText(line, INTELLECT_UI_LIMITS.textChars))), canvas.title)); }
  } else if (view.kind === 'report') {
    const locale = financeReportLocale(view.report, 'en');
    if (view.coverage?.missingPositions) blocks.push(native([text(`${view.coverage.pricedPositions}/${view.coverage.positions} priced holdings · ${view.coverage.missingPositions} unavailable`)]));
    for (const section of selectFinanceReportSections(view.report)) {
      const drawn = section.presentation !== 'narrative' && section.presentation !== 'comparison';
      // A saved price or Treasury series is drawn on the phone as it is in the desktop reader, from the same literal rows.
      const projection = section.projection, columns = projection?.columns ?? [];
      const series = drawn && projection && (projection.status === 'ready' || projection.status === 'partial') && projection.rows.length
        ? seriesChart(columns, projection.rows, columns.includes('Par curve yield') ? 'treasury_yields' : columns.includes('Close (raw)') ? 'price_history' : (columns.includes('Series') || columns.includes('Pair')) && columns.includes('Unit') ? 'series' : undefined) : null;
      // A chart the analysis supplied is already the common chart contract; the phone draws it as the desktop does.
      const chart = drawn ? section.chart ?? financeReportCompositionSpec(section, locale, 'legend') ?? (series && 'spec' in series ? series.spec : null) : null;
      const metrics = financeReportComputeMetrics(section, locale);
      if (chart) blocks.push({ kind: 'chart', spec: chart });
      const prose = financeReportProseBlocks(section.narrative).map((block): IntellectUiNode => block.kind === 'table' ? { type: 'table', columns: block.columns.map(plainCell), rows: block.rows.map(row => row.map(plainCell)) } : text(block.text));
      const children: IntellectUiNode[] = [...metrics.map(metric => ({ type: 'metric' as const, label: metric.label, value: metric.display, unit: metric.unit })), ...prose];
      if (!chart && !metrics.length && section.projection?.rows.length && section.presentation !== 'narrative') children.unshift(text('This chart is not supported in this view.'));
      if (children.length) blocks.push(native(children, section.title));
    }
    // A warning the host itself raised (a value left out, a price that did not match, currencies never added) travels as one more card; no source or as-of line does.
    // It never costs the report: with nothing else to show, no room left or a card the phone's limits refuse, the answer is as it was.
    const warnings = blocks.length && blocks.length < 16 ? financeReportWarnings(view.report, locale) : [];
    const card = warnings.length ? validateInlineUiPresentationContent(native(warnings.map(line => text(clipText(line, INTELLECT_UI_LIMITS.inputChars))))) : null;
    if (card?.ok) blocks.push(card.content);
  // A valuation with no saved report is what the model read to answer; its one line was a negative sentence even when the
  // holdings were priced . The answer says what it found.
  } else return [];
  if (!blocks.length || blocks.length > 16) return unavailable();
  const validated = blocks.map(block => validateInlineUiPresentationContent(block));
  return validated.every(block => block.ok) ? validated.map(block => block.ok ? block.content : native([])) : unavailable();
}
