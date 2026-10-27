import { FinanceNativeResultSchema } from './finance-native-ui';
import { financeQueryScope } from './finance-query-scope';
import { financePortfolioLineText } from './finance-portfolio';
import { financeReportCompositionSpec, financeReportComputeMetrics, financeReportLocale, financeReportProseBlocks, financeReportWarnings, selectFinanceReportSections } from './finance-report-presentation';
import { validateInlineUiPresentationContent, type InlineUiPresentationContent } from './inline-ui-presentation';
import { INTELLECT_UI_LIMITS, type IntellectUiNode } from './intellect-ui';

const text = (value: string): IntellectUiNode => ({ type: 'text', text: value });
const native = (children: IntellectUiNode[], title?: string): InlineUiPresentationContent => ({ kind: 'native', document: { version: 1, ...(title ? { title } : {}), children } });
const unavailable = () => [native([text('This Finance result cannot be displayed here.')])];
const number = (value: number) => new Intl.NumberFormat('en', { maximumFractionDigits: 2, ...(value !== 0 && Math.abs(value) < .01 ? { maximumSignificantDigits: 3 } : {}) }).format(value);
/** A table cell on the phone is plain text: links keep their label, emphasis and code marks go. */
const plainCell = (value: string) => value.replace(/\[([^\]\n]{1,1000})\]\(([^\s)]+)\)/g, '$1').replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, '$1$2').replace(/`([^`\n]+)`/g, '$1').trim();
const hidden = new Set(['url', 'source', 'source id', 'source url', 'retrieved at', 'accession', 'document', 'original filing', 'original post']);
/** A price row on the phone, as on the desktop card, is the price and its currency: the time it was observed is not drawn (owner 2026-10-27). */
const priceTimes = new Set(['observed at', 'latest trading day']);

/** A literal daily price or Treasury series as the phone's chart: provider observations only, points never imply interpolation across missing days.
 *  `null` is "not a chart"; `empty` is a series with no numeric observation at all. The same series is drawn for a query result and for a saved report section. */
function seriesChart(columns: readonly string[], rows: readonly (string | number | null)[][], metric: string | undefined): { spec: Record<string, unknown> } | { empty: true } | null {
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

/** One clean line cut at `limit` characters, never through a surrogate pair: the phone's table widget cannot draw half of one. */
const clipText = (value: string, limit: number) => {
  const line = financePortfolioLineText(value);
  if (line.length <= limit) return line;
  const end = limit - 1;
  return `${line.slice(0, /[\uD800-\uDBFF]/.test(line[end - 1] ?? '') ? end - 1 : end)}…`;
};

/** Read-only display projection. No raw operation result, provenance dump or executable action enters the document. */
export function financeNativeTranscriptContents(value: unknown, options: { state?: string } = {}): readonly InlineUiPresentationContent[] {
  const checked = FinanceNativeResultSchema.safeParse(value);
  if (!checked.success) return [];
  const { view } = checked.data;
  const blocks: InlineUiPresentationContent[] = [];
  if (view.kind === 'search') {
    if (view.result.assets.length > 50) return unavailable();
    blocks.push(native(view.result.assets.length ? view.result.assets.map(asset => ({ type: 'card', title: asset.symbol, children: [text([asset.name, asset.exchange, asset.currency !== 'XXX' ? asset.currency : null].filter(Boolean).join(' · '))] })) : [text('No candidates returned.')], clipText(view.query, INTELLECT_UI_LIMITS.labelChars)));
  } else if (view.kind === 'query') {
    const { result } = view;
    if (result.status === 'error' || result.status === 'unconnected') return [native([text('Data could not be retrieved.')])];
    if (!result.rows.length) return [native([text('No results returned.')])];
    // Literal provider observations only. Points never imply interpolation across missing observations.
    const metric = view.request.metrics.length === 1 ? view.request.metrics[0] : undefined;
    const columns = result.columns;
    const built = seriesChart(columns, result.rows, metric);
    if (built && 'empty' in built) return [native([text('No verified numeric observations.')])];
    if (built) blocks.push({ kind: 'chart', spec: built.spec });
    if (!blocks.length) {
      if (result.rows.length > 50) return unavailable();
      const visible = columns.map((name, index) => ({ name, index })).filter(column => !hidden.has(column.name.toLowerCase()) && !(metric === 'price' && priceTimes.has(column.name.toLowerCase())));
      if (!visible.length || visible.length > 8) return unavailable();
      blocks.push(native(result.rows.map(row => ({ type: 'card', children: [text(visible.map(column => `${column.name}: ${row[column.index] === null ? '—' : typeof row[column.index] === 'number' ? number(row[column.index] as number) : row[column.index] ?? '—'}`).join('\n'))] })), clipText(financeQueryScope(view.request), INTELLECT_UI_LIMITS.labelChars)));
    }
  } else if (view.kind === 'holdings') {
    // The phone shows the open proposal and where the decision is made; it cannot save. Once the owner has acted the table is dropped:
    // its rows are no longer what is saved. Cells stay inside the contract's text limits.
    const open = !options.state || options.state === 'awaiting-input';
    // One clean line (an older retained proposal may still hold breaks or half surrogate pairs), cut at the contract's length and never through a surrogate pair.
    const cell = (value: string | null, limit = 120) => value === null ? null : clipText(value, limit);
    const rows = view.draft.rows.map(row => [cell(row.name || row.symbol), cell(row.symbol, 40), cell(row.currency, 8), row.quantity, row.averageCost, row.price, cell(row.asOf, 40)]);
    const status = open ? 'Proposed from your photo or text. Nothing is saved until you review and save it in the Agentlas desktop app.'
      : options.state === 'cancelled' ? 'Replaced by a newer proposal.'
      : options.state === 'ready' ? 'Reviewed and saved in the Agentlas desktop app.'
      : 'This proposal is no longer open for review.';
    blocks.push(native([...(open ? [{ type: 'table' as const, columns: ['Name', 'Symbol', 'Currency', 'Quantity', 'Average cost', 'Price', 'As of'], rows }] : []), text(status)], 'Holdings to review'));
  } else if (view.kind === 'report') {
    const locale = financeReportLocale(view.report, 'en');
    if (view.coverage?.missingPositions) blocks.push(native([text(`${view.coverage.pricedPositions}/${view.coverage.positions} priced holdings · ${view.coverage.missingPositions} unavailable`)]));
    for (const section of selectFinanceReportSections(view.report)) {
      const drawn = section.presentation !== 'narrative' && section.presentation !== 'comparison';
      // A saved price or Treasury series is drawn on the phone as it is in the desktop reader, from the same literal rows.
      const projection = section.projection, columns = projection?.columns ?? [];
      const series = drawn && projection && (projection.status === 'ready' || projection.status === 'partial') && projection.rows.length
        ? seriesChart(columns, projection.rows, columns.includes('Par curve yield') ? 'treasury_yields' : columns.includes('Close (raw)') ? 'price_history' : undefined) : null;
      const chart = drawn ? financeReportCompositionSpec(section, locale, 'legend') ?? (series && 'spec' in series ? series.spec : null) : null;
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
  } else blocks.push(native([text('A complete priced currency group is not available for an allocation chart.')]));
  if (!blocks.length || blocks.length > 16) return unavailable();
  const validated = blocks.map(block => validateInlineUiPresentationContent(block));
  return validated.every(block => block.ok) ? validated.map(block => block.ok ? block.content : native([])) : unavailable();
}
