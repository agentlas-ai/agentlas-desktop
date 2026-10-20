import { FinanceNativeResultSchema } from './finance-native-ui';
import { financeReportCompositionSpec, financeReportComputeMetrics, financeReportLocale, financeReportProseBlocks, selectFinanceReportSections } from './finance-report-presentation';
import { validateInlineUiPresentationContent, type InlineUiPresentationContent } from './inline-ui-presentation';
import type { IntellectUiNode } from './intellect-ui';

const text = (value: string): IntellectUiNode => ({ type: 'text', text: value });
const native = (children: IntellectUiNode[], title?: string): InlineUiPresentationContent => ({ kind: 'native', document: { version: 1, ...(title ? { title } : {}), children } });
const unavailable = () => [native([text('This Finance result cannot be displayed here.')])];
const number = (value: number) => new Intl.NumberFormat('en', { maximumFractionDigits: 2, ...(value !== 0 && Math.abs(value) < .01 ? { maximumSignificantDigits: 3 } : {}) }).format(value);
const hidden = new Set(['url', 'source', 'source id', 'source url', 'retrieved at', 'accession', 'document', 'original filing', 'original post']);

/** Read-only display projection. No raw operation result, provenance dump or executable action enters the document. */
export function financeNativeTranscriptContents(value: unknown, options: { state?: string } = {}): readonly InlineUiPresentationContent[] {
  const checked = FinanceNativeResultSchema.safeParse(value);
  if (!checked.success) return [];
  const { view } = checked.data;
  const blocks: InlineUiPresentationContent[] = [];
  if (view.kind === 'search') {
    if (view.result.assets.length > 50) return unavailable();
    blocks.push(native(view.result.assets.length ? view.result.assets.map(asset => ({ type: 'card', title: asset.symbol, children: [text([asset.name, asset.exchange, asset.currency !== 'XXX' ? asset.currency : null].filter(Boolean).join(' · '))] })) : [text('No candidates returned.')], view.query));
  } else if (view.kind === 'query') {
    const { result } = view;
    if (result.status === 'error' || result.status === 'unconnected') return [native([text('Data could not be retrieved.')])];
    if (!result.rows.length) return [native([text('No results returned.')])];
    // Literal provider observations only. Points never imply interpolation across missing observations.
    const metric = view.request.metrics.length === 1 ? view.request.metrics[0] : undefined;
    const series = metric === 'treasury_yields' ? 'Maturity' : metric === 'price_history' ? 'Symbol' : null;
    const amount = metric === 'treasury_yields' ? 'Par curve yield' : 'Close (raw)';
    const columns = result.columns;
    const at = (name: string) => columns.indexOf(name);
    const currencies = new Set(result.rows.map(row => row[at('Currency')]));
    const chart = series && new Set(columns).size === columns.length && ['Observation date', series, amount].every(name => at(name) >= 0)
      && result.rows.length <= 2000 && (metric === 'treasury_yields'
        ? at('Unit') >= 0 && result.rows.every(row => row[at('Unit')] === '% per annum')
        : currencies.size === 1 && [...currencies].every(code => typeof code === 'string' && /^[A-Z]{3}$/.test(code) && code !== 'XXX'));
    if (chart) {
      const values = result.rows.map(row => ({ date: row[at('Observation date')], series: row[at(series)], value: row[at(amount)] }));
      const dates = values.every(row => typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(Date.parse(row.date))
        && new Date(`${row.date}T00:00:00Z`).toISOString().slice(0, 10) === row.date && typeof row.series === 'string' && !!row.series.trim()
        && (row.value === null || typeof row.value === 'number' && Number.isFinite(row.value)));
      const keys = new Set(values.map(row => JSON.stringify([row.date, row.series])));
      if (dates && keys.size === values.length && !values.some(row => typeof row.value === 'number')) return [native([text('No verified numeric observations.')])];
      if (dates && keys.size === values.length) blocks.push({ kind: 'chart', spec: { data: { values }, mark: { type: 'point', tooltip: true }, encoding: {
        x: { field: 'date', type: 'temporal', title: null }, y: { field: 'value', type: 'quantitative', title: metric === 'treasury_yields' ? '%' : [...currencies][0], scale: { zero: false } },
        color: { field: 'series', type: 'nominal', title: null },
      } } });
    }
    if (!blocks.length) {
      if (result.rows.length > 50) return unavailable();
      const visible = columns.map((name, index) => ({ name, index })).filter(column => !hidden.has(column.name.toLowerCase()));
      if (!visible.length || visible.length > 8) return unavailable();
      blocks.push(native(result.rows.map(row => ({ type: 'card', children: [text(visible.map(column => `${column.name}: ${row[column.index] === null ? '—' : typeof row[column.index] === 'number' ? number(row[column.index] as number) : row[column.index] ?? '—'}`).join('\n'))] })), view.request.query));
    }
  } else if (view.kind === 'holdings') {
    // The phone shows the open proposal and where the decision is made; it cannot save. Once the owner has acted the table is dropped:
    // its rows are no longer what is saved. Cells stay inside the contract's text limits.
    const open = !options.state || options.state === 'awaiting-input';
    const cell = (text: string | null, limit = 120) => text === null ? null : text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
    const rows = view.draft.rows.map(row => [cell(row.name || row.symbol), cell(row.symbol, 40), cell(row.currency, 8), row.quantity, row.averageCost, row.price, cell(row.asOf, 40)]);
    const status = open ? 'Proposed from your photo or text. Nothing is saved until you review and save it in the Agentlas desktop app.'
      : options.state === 'cancelled' ? 'Replaced by a newer proposal.'
      : 'Reviewed and saved in the Agentlas desktop app.';
    blocks.push(native([...(open ? [{ type: 'table' as const, columns: ['Name', 'Symbol', 'Currency', 'Quantity', 'Average cost', 'Price', 'As of'], rows }] : []), text(status)], 'Holdings to review'));
  } else if (view.kind === 'report') {
    const locale = financeReportLocale(view.report, 'en');
    if (view.coverage?.missingPositions) blocks.push(native([text(`${view.coverage.pricedPositions}/${view.coverage.positions} priced holdings · ${view.coverage.missingPositions} unavailable`)]));
    for (const section of selectFinanceReportSections(view.report)) {
      const chart = section.presentation !== 'narrative' && section.presentation !== 'comparison' ? financeReportCompositionSpec(section, locale) : null;
      const metrics = financeReportComputeMetrics(section, locale);
      if (chart) blocks.push({ kind: 'chart', spec: chart });
      const prose = financeReportProseBlocks(section.narrative).map(block => text(block.text));
      const children: IntellectUiNode[] = [...metrics.map(metric => ({ type: 'metric' as const, label: metric.label, value: metric.display, unit: metric.unit })), ...prose];
      if (!chart && !metrics.length && section.projection?.rows.length && section.presentation !== 'narrative') children.unshift(text('This chart is not supported in this view.'));
      if (children.length) blocks.push(native(children, section.title));
    }
  } else blocks.push(native([text('A complete priced currency group is not available for an allocation chart.')]));
  if (!blocks.length || blocks.length > 16) return unavailable();
  const validated = blocks.map(block => validateInlineUiPresentationContent(block));
  return validated.every(block => block.ok) ? validated.map(block => block.ok ? block.content : native([])) : unavailable();
}
