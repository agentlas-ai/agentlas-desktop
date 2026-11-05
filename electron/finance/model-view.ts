import type { FinanceDataResult } from '../../shared/finance';

/**
 * What the model reads of a finance.query result. The receipt, the native card and the chart reader keep the full result; this copy
 * stays in the runtime's conversation thread for every later call of the chat, so it carries what an answer is built from and no more.
 * - A daily price history is the date and close of each day for a year or less, and one close per week beyond that, with the exact
 *   figures an answer quotes (first, last, high, low, the largest drop from a high) computed here from every daily row.
 * - A provider entry keeps its id, label and status; its coverage and rights prose stays in the receipt.
 */
const DAY_MS = 864e5;
export function financeQueryModelView(data: FinanceDataResult): FinanceDataResult {
  const view: FinanceDataResult = data.providers ? { ...data, providers: data.providers.map(({ id, label, status, sourceUrls }) => ({ id, label, status, coverage: '', rights: '', sourceUrls })) } : data;
  const dateAt = data.columns.indexOf('Observation date'), closeAt = data.columns.indexOf('Close (raw)');
  if (dateAt < 0 || closeAt < 0 || data.rows.length < 2) return view;
  const series = data.rows.map(row => [row[dateAt], row[closeAt]] as const).filter((row): row is readonly [string, number] => typeof row[0] === 'string' && typeof row[1] === 'number' && Number.isFinite(row[1]));
  if (series.length < 2) return view;
  const [first, last] = [series[0], series.at(-1)!];
  let high = first, low = first, peak = first, drop = { from: first, to: first, pct: 0 };
  for (const point of series) {
    if (point[1] > high[1]) high = point;
    if (point[1] < low[1]) low = point;
    if (point[1] > peak[1]) peak = point;
    const pct = (point[1] / peak[1] - 1) * 100;
    if (pct < drop.pct) drop = { from: peak, to: point, pct };
  }
  const spanDays = (Date.parse(`${last[0]}T00:00:00Z`) - Date.parse(`${first[0]}T00:00:00Z`)) / DAY_MS;
  // Beyond a year, the last close of each 7-day step from the first date (and always the last day).
  const rows = spanDays <= 370 ? series : series.filter((point, i) => i === series.length - 1 || Math.floor((Date.parse(`${series[i + 1][0]}T00:00:00Z`) - Date.parse(`${first[0]}T00:00:00Z`)) / (7 * DAY_MS)) !== Math.floor((Date.parse(`${point[0]}T00:00:00Z`) - Date.parse(`${first[0]}T00:00:00Z`)) / (7 * DAY_MS)));
  const round = (value: number) => Math.round(value * 100) / 100;
  const symbolAt = data.columns.indexOf('Symbol'), currencyAt = data.columns.indexOf('Currency');
  return {
    ...view,
    columns: ['Observation date', spanDays <= 370 ? 'Close (raw)' : 'Close (raw), last of each week'],
    rows: rows.map(([day, close]) => [day, close]),
    summary: {
      ...(symbolAt >= 0 ? { symbol: data.rows[0][symbolAt] } : {}), ...(currencyAt >= 0 ? { currency: data.rows[0][currencyAt] } : {}),
      dailyRows: series.length, first: { date: first[0], close: first[1] }, last: { date: last[0], close: last[1] },
      changePct: round((last[1] / first[1] - 1) * 100), high: { date: high[0], close: high[1] }, low: { date: low[0], close: low[1] },
      maxDrawdown: { pct: round(drop.pct), peak: { date: drop.from[0], close: drop.from[1] }, trough: { date: drop.to[0], close: drop.to[1] } },
      omitted: 'open, high, low and volume of each day (in the receipt)',
    },
  } as FinanceDataResult;
}
