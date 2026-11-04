import type { FinanceReportSection } from './finance';
import { financeDataVisual, financeDatedSeries, financeMetricForColumns } from './finance-data-visual';

/**
 * The line chart and key figures of a saved report section whose rows are a dated series (price history, Treasury par curve, FRED series,
 * ECB reference rates), drawn without Vega: plain SVG text built here, so the Main process can write a report file with no renderer and no
 * dev-only chart package. Only literal rows of the saved projection are drawn; nothing is interpolated, converted or estimated. A section
 * that is not one clear single dated series gets no chart (the report shows its table instead).
 * The result passes financeReportChartImage (no style element, script, link or external reference).
 */
export interface FinanceSeriesFigure { label: string; display: string; unit?: string }
export interface FinanceSeriesChart { svg: string; figures: FinanceSeriesFigure[]; label: string; unit: string | null; points: number }
type Point = { date: string; value: number };
type Series = { label: string; unit: string | null; points: Point[] };

const LANGUAGES = ['en', 'ko', 'ja', 'zh', 'ar'] as const;
const COPY: Record<string, readonly string[]> = {
  latest: ['Latest', '최근 값', '直近値', '最新值', 'الأحدث'],
  change: ['Change over the period', '기간 변화율', '期間の変化率', '期间涨跌幅', 'التغير خلال الفترة'],
  high: ['Highest', '최고', '最高', '最高', 'الأعلى'],
  low: ['Lowest', '최저', '最低', '最低', 'الأدنى'],
  chart: ['Line chart of', '선 차트:', '折れ線グラフ:', '折线图:', 'رسم خطي:'],
};
const t = (key: string, language: string): string => {
  let code = 'en'; try { code = new Intl.Locale(language).language; } catch { /* default */ }
  const index = LANGUAGES.indexOf(code as typeof LANGUAGES[number]);
  return COPY[key][index < 0 ? 0 : index];
};
/** UTF-8 bytes to base64 with no Node-only API, so the module also loads in the renderer. */
function svgDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg); let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}
const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function number(value: number, language: string, digits?: number): string {
  if (!Number.isFinite(value)) return '—';
  const options: Intl.NumberFormatOptions = digits !== undefined ? { maximumFractionDigits: digits, minimumFractionDigits: digits }
    : Math.abs(value) >= 1e6 ? { notation: 'compact', maximumFractionDigits: 2 } : Math.abs(value) >= 100 ? { maximumFractionDigits: 2 } : Math.abs(value) >= 1 ? { maximumFractionDigits: 3 } : { maximumSignificantDigits: 3 };
  try { return new Intl.NumberFormat(language, options).format(value); } catch { return String(value); }
}

/** The one dated series a section holds, by its exact column contract; null when it holds anything else. */
export function financeReportSeries(section: FinanceReportSection): Series | null {
  const p = section.projection;
  if (!p || !['ready', 'partial'].includes(p.status) || !p.rows.length || p.rows.length > 5000 || new Set(p.columns).size !== p.columns.length) return null;
  const result = { status: 'ok' as const, columns: p.columns, rows: p.rows, warnings: p.warnings, asOf: p.asOf, retrievedAt: '', sourceUrls: [] as string[] };
  const metric = financeMetricForColumns(p.columns);
  if (metric === 'price_history' || metric === 'treasury_yields') {
    const visual = financeDataVisual(result, metric);
    if ((visual.kind !== 'history' && visual.kind !== 'treasury') || visual.points.length < 2) return null;
    return { label: visual.label, unit: visual.kind === 'treasury' ? '%' : visual.unit, points: visual.points };
  }
  const dated = financeDatedSeries(result);
  return dated ? { label: dated.label, unit: dated.unit, points: dated.points } : null;
}

/** About a few hundred points are enough for 860 pixels; the first and last observations are always kept. */
function thin(points: readonly Point[], limit = 400): Point[] {
  if (points.length <= limit) return [...points];
  const step = (points.length - 1) / (limit - 1), out: Point[] = [];
  for (let i = 0; i < limit; i++) out.push(points[Math.round(i * step)]);
  return out;
}
function ticks(low: number, high: number, count: number): number[] {
  const span = high - low || Math.abs(high) || 1, raw = span / count, magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(factor => factor * magnitude).find(candidate => candidate >= raw) ?? raw;
  const first = Math.ceil(low / step) * step, values: number[] = [];
  for (let value = first; value <= high + step * 1e-9 && values.length < 12; value += step) values.push(Math.abs(value) < step * 1e-9 ? 0 : Number(value.toPrecision(12)));
  return values;
}

export function financeReportSeriesChart(section: FinanceReportSection, language = 'en', title = ''): FinanceSeriesChart | null {
  const series = financeReportSeries(section);
  if (!series) return null;
  const all = series.points, drawn = thin(all), values = all.map(point => point.value);
  const high = Math.max(...values), low = Math.min(...values), padding = (high - low) * 0.08 || Math.abs(high) * 0.02 || 1;
  const yMin = low - padding, yMax = high + padding;
  const W = 860, H = 300, left = 64, right = 20, top = 18, bottom = 34, plotW = W - left - right, plotH = H - top - bottom;
  const x = (index: number) => left + (drawn.length === 1 ? plotW / 2 : (index / (drawn.length - 1)) * plotW);
  const y = (value: number) => top + (1 - (value - yMin) / (yMax - yMin)) * plotH;
  const line = drawn.map((point, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)} ${y(point.value).toFixed(1)}`).join('');
  const area = `${line}L${x(drawn.length - 1).toFixed(1)} ${(top + plotH).toFixed(1)}L${x(0).toFixed(1)} ${(top + plotH).toFixed(1)}Z`;
  const grid = ticks(yMin, yMax, 4).map(value => `<line x1="${left}" y1="${y(value).toFixed(1)}" x2="${W - right}" y2="${y(value).toFixed(1)}" stroke="#e4e8ed" stroke-width="1"/><text x="${left - 8}" y="${(y(value) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#66717b">${escape(number(value, language))}</text>`).join('');
  const marks = [...new Set([0, Math.floor((drawn.length - 1) / 2), drawn.length - 1])].map((index, order, list) => `<text x="${x(index).toFixed(1)}" y="${H - 10}" text-anchor="${order === 0 ? 'start' : order === list.length - 1 ? 'end' : 'middle'}" font-size="11" fill="#66717b">${escape(drawn[index].date)}</text>`).join('');
  const lastX = x(drawn.length - 1), lastY = y(drawn[drawn.length - 1].value);
  const label = `${t('chart', language)} ${title || series.label}${series.unit ? ` (${series.unit})` : ''}, ${all[0].date} – ${all[all.length - 1].date}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${escape(label)}" font-family="system-ui,-apple-system,Segoe UI,sans-serif"><title>${escape(label)}</title>`
    + `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>${grid}<path d="${area}" fill="#3965cb" fill-opacity="0.08" stroke="none"/><path d="${line}" fill="none" stroke="#3965cb" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
    + `<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="3.5" fill="#3965cb"/>${marks}${series.unit ? `<text x="${left}" y="11" font-size="11" fill="#66717b">${escape(series.unit)}</text>` : ''}</svg>`;
  const first = all[0], last = all[all.length - 1], change = first.value !== 0 ? (last.value / first.value - 1) : null;
  const highPoint = all.reduce((best, point) => point.value > best.value ? point : best), lowPoint = all.reduce((best, point) => point.value < best.value ? point : best);
  // A long unit ("index 1982-1984=100") is written on the chart's axis, not inside a card; a short one (KRW, %) stays beside the figure.
  const unit = series.unit && series.unit.length <= 8 ? series.unit : undefined;
  const figures: FinanceSeriesFigure[] = [
    { label: `${t('latest', language)} · ${last.date}`, display: number(last.value, language), ...(unit ? { unit } : {}) },
    ...(change === null ? [] : [{ label: `${t('change', language)} · ${first.date}`, display: `${change >= 0 ? '+' : ''}${number(change * 100, language, 2)}`, unit: '%' }]),
    { label: `${t('high', language)} · ${highPoint.date}`, display: number(highPoint.value, language), ...(unit ? { unit } : {}) },
    { label: `${t('low', language)} · ${lowPoint.date}`, display: number(lowPoint.value, language), ...(unit ? { unit } : {}) },
  ];
  return { svg: svgDataUrl(svg), figures, label: series.label, unit: series.unit, points: all.length };
}
