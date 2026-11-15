/**
 * Reads the SHAPE of a finished answer (a markdown table, a numbered list) and, when it is clearly one of a few shapes, returns the card blocks that draw it.
 * It looks at rows and columns, at whether a cell parses as a number (with a closed set of typed tokens: unit symbols and suffixes, K/M/B and 천·만·억
 * multipliers, month, quarter, week and year notations, a blank or n/a, the few header tokens that name an identifier: id, no, code, zip, 번호, 코드), at
 * whether a column counts up like an index, at whether a row or a column is the sum or the mean of the others, at how many items a list has and how long
 * they are. It does not read what a sentence means and has no word list of a language beyond those
 * tokens. The model is not asked and not called; the original text stays in the conversation (the card is only how the screen draws it). A shape that is
 * not clearly one of these returns a reason and the text is drawn as it was. No DOM, no electron (the renderer, the gates and the daemon can all load it).
 */
export type MdTable = { header: string[]; rows: string[][] };
export type MdListItem = { text: string; children?: unknown };
export type MdList = { ordered: boolean; items: MdListItem[]; /** the number the list starts at (markdown `3.`); steps are numbered from 1 */ start?: number };

export type CardBlock = Record<string, unknown> & { type: string };
export interface CardUpgrade {
  kind: 'table' | 'chart' | 'steps';
  /** Why this shape was taken (a short machine-readable reason, for the gate and the logs). */
  reason: string;
  /** What is drawn first. */
  blocks: CardBlock[];
  /** What the owner can switch to (a chart's table); absent when there is only one view. */
  alternate?: CardBlock[];
}

/** Table limits: under them the text stays a plain table. */
export const TABLE_MIN_ROWS = 3, TABLE_MIN_COLUMNS = 2, TABLE_MAX_ROWS = 24, TABLE_MAX_COLUMNS = 8, TABLE_MAX_AVG_CELL = 60;
export const STEPS_MIN = 3, STEPS_MAX = 7, STEP_MAX_CHARS = 160, STEP_TITLE_MAX = 40, STEP_TEXT_MAX = 120;
/** Columns of one axis whose largest values differ by more than this are not drawn together (a price beside a rating). */
export const SERIES_SCALE_RATIO_MAX = 10;
/** What the chart draws: at most this many lines (bars: one more), a donut only for shares that make exactly a whole, an axis label of at most this many characters. */
export const LINE_SERIES_MAX = 4, BAR_SERIES_MAX = 5, AXIS_LABEL_MAX = 8, WHOLE_TOLERANCE = 0.5;

/**
 * A cell without its markdown: links keep their text, emphasis markers come off only where they mark emphasis (`**a**`, `__a__`, `*a*`, `_a_` with the marker
 * against the word), so `user_id` stays `user_id` and `5 * 3` stays `5 * 3`.
 */
export const stripInline = (cell: string): string => String(cell ?? '')
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\*\*([^\s*](?:[^*]*[^\s*])?)\*\*/g, '$1')
  .replace(/__([^\s_](?:[^_]*[^\s_])?)__/g, '$1')
  .replace(/(^|[^\w*])\*([^\s*](?:[^*]*[^\s*])?)\*(?![\w*])/g, '$1$2')
  .replace(/(^|[^\w])_([^\s_](?:[^_]*[^\s_])?)_(?!\w)/g, '$1$2')
  .replace(/~~([^~]+)~~/g, '$1')
  .replace(/`([^`]*)`/g, '$1')
  .replace(/\s+/g, ' ')
  .trim();

const MULTIPLIER: Record<string, number> = { 천: 1e3, 만: 1e4, 억: 1e8, 조: 1e12, K: 1e3, M: 1e6, B: 1e9 };
const CURRENCY_WORDS = /^(원|만원|억원|달러|USD|KRW|엔|유로|위안)$/i;
/** The multipliers a Korean answer writes after a figure (3억, 1.5조). */
const KOREAN_SCALE = /^[천만억조]$/;
/**
 * A cell as a number with the class of its unit ('' none, percent, krw, usd, eur, jpy, cny, x, or count for another written unit). `shown` is the figure as it is
 * written (3 in `3억`) and `scale` the Korean multiplier after it, so a chart can draw what the table says. Null when it is not ONE number: digits split by a
 * space or a break (`10<br>20`), a lower-case k, m or b without a currency (`10k`, `1.8m`: thousands, metres, minutes?), a figure with a leading zero or a
 * bare run of nine digits or more (a code, an id, a postcode).
 */
export function parseCellNumber(raw: string): { value: number; unit: string; shown: number; scale: string } | null {
  const text = stripInline(raw);
  if (!text || /\d\s+\d/.test(text)) return null;
  const s = text.replace(/\s/g, '');
  const m = s.match(/^[~≈약]?([-+−]?)([$₩€¥￥]?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(%|[천만억조KMBkmb])?(원|달러|엔|유로|위안|USD|KRW|배|점|명|개|건|회|위|등|ms|초|분|시간|일|주|달|개월|년)?$/i);
  if (!m) return null;
  const [, sign, symbol, whole, fraction = '', scale = '', word = ''] = m;
  if (!whole.includes(',') && whole.length > 1 && whole.startsWith('0')) return null;
  if (!whole.includes(',') && !fraction && !scale && !symbol && !word && whole.length >= 9) return null;
  const figure = Number(`${whole.replace(/,/g, '')}${fraction}`);
  if (!Number.isFinite(figure)) return null;
  // k, m and b are a multiplier only beside a currency (`$950k`, `950k원`); on their own they are not a figure. K, M and B and 천·만·억·조 always multiply.
  const currency = symbol !== '' || /^(원|달러|엔|유로|위안|USD|KRW)$/i.test(word);
  if (/^[kmb]$/.test(scale) && !currency) return null;
  const negative = sign === '-' || sign === '−';
  let value = figure;
  if (scale && scale !== '%') value *= MULTIPLIER[/[a-z]/i.test(scale) ? scale.toUpperCase() : scale] ?? 1;
  if (negative) value = -value;
  let unit = '';
  if (scale === '%') unit = 'percent';
  else if (symbol === '₩' || /^(원|KRW)$/i.test(word)) unit = 'krw';
  else if (symbol === '$' || /^(달러|USD)$/i.test(word)) unit = 'usd';
  else if (symbol === '€' || word === '유로') unit = 'eur';
  else if (symbol === '¥' || symbol === '￥' || word === '엔') unit = 'jpy';
  else if (word === '위안') unit = 'cny';
  else if (word === '배') unit = 'x';
  else if (word && !CURRENCY_WORDS.test(word)) unit = 'count';
  else if (!word && !scale) unit = '';
  else unit = 'count';
  return { value, unit, shown: negative ? -figure : figure, scale: KOREAN_SCALE.test(scale) ? scale : '' };
}

/** First-column labels that run in time: years, months, quarters, weeks, dates. A typed token check on the labels. */
const PERIOD = /^(?:\d{4}(?:[-./년]\s?\d{1,2}(?:월)?(?:[-./]\d{1,2}일?)?)?|\d{1,2}월|\d{1,2}\/\d{1,2}|Q[1-4](?:\s?'?\d{2,4})?|\d{4}\s?Q[1-4]|(?:\d{4}\s?)?[1-4]분기|FY\s?\d{2,4}|H[12](?:\s?\d{2,4})?|W\d{1,2}|\d{1,2}주차|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?(?:\s?\d{2,4})?)$/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const yearOf = (value: string | undefined): number => (value ? (value.length === 2 ? 2000 + Number(value) : Number(value)) : 0);

type PeriodKind = 'year' | 'month' | 'day' | 'quarter' | 'half' | 'week';
/**
 * A period label read by its calendar notation (2025, 2025-03, 3월, 3/15, Q3 2025, 3분기, FY25, H1, W12, 12주차, Mar 2025): the kind, where it sits
 * on the time line as one number (`key`, comparable between two labels of one table) and how many of its kind it is (`at`, for equal spacing). The notation is
 * digits and a closed calendar unit, read from a table cell the model already wrote. Null when it does not read as a period.
 */
function readPeriod(label: string): { kind: PeriodKind; key: number; at: number } | null {
  const s = stripInline(label).trim();
  let m = s.match(/^(\d{4})(?:\s?[-./년]\s?(\d{1,2})(?:월)?(?:\s?[-./]\s?(\d{1,2})일?)?)?$/);
  if (m) {
    const year = Number(m[1]), month = Number(m[2] ?? 0), day = Number(m[3] ?? 0), key = year * 10000 + month * 100 + day;
    if (m[3] !== undefined) return { kind: 'day', key, at: Date.UTC(year, month - 1, day) / 864e5 };
    return m[2] !== undefined ? { kind: 'month', key, at: year * 12 + month - 1 } : { kind: 'year', key, at: year };
  }
  m = s.match(/^(\d{1,2})월$/); if (m) return { kind: 'month', key: Number(m[1]) * 100, at: Number(m[1]) };
  m = s.match(/^(\d{1,2})\/(\d{1,2})$/); if (m) return { kind: 'day', key: Number(m[1]) * 100 + Number(m[2]), at: Date.UTC(2001, Number(m[1]) - 1, Number(m[2])) / 864e5 };
  m = s.match(/^(?:(\d{4})\s?)?Q([1-4])(?:\s?'?(\d{2,4}))?$/i) ?? s.match(/^(?:(\d{4})\s?)?([1-4])분기$/);
  if (m) return { kind: 'quarter', key: yearOf(m[1] ?? m[3]) * 10000 + Number(m[2]) * 300, at: yearOf(m[1] ?? m[3]) * 4 + Number(m[2]) - 1 };
  m = s.match(/^FY\s?(\d{2,4})$/i); if (m) return { kind: 'year', key: yearOf(m[1]) * 10000, at: yearOf(m[1]) };
  m = s.match(/^H([12])(?:\s?(\d{2,4}))?$/i); if (m) return { kind: 'half', key: yearOf(m[2]) * 10000 + Number(m[1]) * 600, at: yearOf(m[2]) * 2 + Number(m[1]) - 1 };
  m = s.match(/^W(\d{1,2})$/i) ?? s.match(/^(\d{1,2})주차$/); if (m) return { kind: 'week', key: Number(m[1]) * 100, at: Number(m[1]) };
  m = s.match(/^([A-Za-z]{3})[a-z]*\.?(?:\s?(\d{2,4}))?$/);
  if (m) { const at = MONTHS.indexOf(m[1].toLowerCase()); if (at >= 0) return { kind: 'month', key: yearOf(m[2]) * 10000 + (at + 1) * 100, at: yearOf(m[2]) * 12 + at }; }
  return null;
}
/** Where a period label sits on the time line, as one number; null when it does not read as a period. Two labels of one table are comparable. */
export const periodKey = (label: string): number | null => readPeriod(label)?.key ?? null;
/** A period label as a point on an evenly counted line: its kind and how many of that kind it is. */
const periodStep = (label: string): { kind: string; at: number } | null => { const p = readPeriod(label); return p ? { kind: p.kind, at: p.at } : null; };
/** Periods one step apart each (a month, a year): a line draws its points at equal distances, so periods that skip (2019, 2020, 2022) are not drawn as one. A day count may vary by a month's length. */
const evenlySpaced = (labels: string[]): boolean => {
  const steps = labels.map(periodStep);
  if (steps.some(step => step === null) || new Set(steps.map(step => step!.kind)).size !== 1) return false;
  const at = steps.map(step => step!.at), gaps = at.slice(1).map((value, i) => Math.abs(value - at[i]));
  const low = Math.min(...gaps), high = Math.max(...gaps);
  return low > 0 && high <= low * 1.15;
};

type Column = { values: (number | null)[]; unit: string; numeric: boolean; raw: string[]; /** the Korean multiplier every figure carries (억), drawn in the series name, not in the numbers */ scale: string };
function readColumn(cells: string[]): Column {
  const parsed = cells.map(parseCellNumber);
  const present = parsed.filter((p): p is NonNullable<typeof p> => p !== null);
  const blanks = cells.filter(c => /^(?:[-–—]|n\/?a)?$/i.test(stripInline(c))).length;
  const numeric = present.length >= 2 && present.length + blanks >= Math.ceil(cells.length * 0.8) && present.length >= Math.ceil(cells.length * 0.6);
  const units = new Set(present.map(p => p.unit).filter(u => u !== ''));
  const unit = units.size === 1 ? [...units][0] : units.size === 0 ? 'count' : 'mixed';
  // a column of 억 or 만 figures is drawn as it is written (3 and 12; the series name says 억); figures of two multipliers, or plain figures among them, are not one column of figures
  const scales = new Set(present.map(p => p.scale));
  const scale = scales.size === 1 ? [...scales][0] : '';
  return { values: parsed.map(p => (p ? (scale ? p.shown : p.value) : null)), unit, numeric: numeric && unit !== 'mixed' && scales.size <= 1, raw: cells.map(c => stripInline(c)), scale };
}

/** A column that counts up (or down) by one from 0 or 1: a number of the row, not a figure of it. */
const countsRows = (col: Column): boolean => {
  const v = col.values;
  if (v.length < 3 || v.some(x => x === null || !Number.isInteger(x))) return false;
  const n = v as number[];
  const up = n.every((x, i) => x === n[0] + i), down = n.every((x, i) => x === n[0] - i);
  return (up && (n[0] === 0 || n[0] === 1)) || (down && (n[n.length - 1] === 0 || n[n.length - 1] === 1));
};
/** A column of years (2019, 2019년, 2019.03, 2019-03): a date of the row, not a figure of it. */
const holdsYears = (col: Column): boolean => col.raw.length >= 2 && col.raw.every(c => /^(?:19|20)\d{2}(?:\s?년|[./-]\d{1,2}(?:[./-]\d{1,2})?)?$/.test(c));
/** A column whose name says it is an identifier (id, no, code, zip, 번호, 코드): its numbers name the rows, they are not figures of them. */
const IDENTIFIER_HEADER = /(?:^|[\s_./-])(?:id|no\.?|#|code|zip(?:code)?)$|(?:번호|코드)$/i;

/** The card writes a figure with `cmp` (bars and their tips) or `canvasFormat` (a donut's legend): a chart is offered only when that writing gives the table's own number back. */
const within = (x: number, decimals: number): boolean => Math.abs(x * 10 ** decimals - Math.round(x * 10 ** decimals)) < 1e-6;
const shownExactly = (v: number, percent: boolean, donut = false): boolean => {
  const a = Math.abs(v);
  if (percent) return donut ? within(a, a < 10 ? 1 : 0) : within(a, a < 10 ? 2 : a < 100 ? 1 : 0);
  if (a >= 1e12) return within(a / 1e12, a < 1e13 ? 2 : 1);
  if (a >= 1e9) return within(a / 1e9, a < 1e10 ? 2 : 1);
  if (a >= 1e6) return within(a / 1e6, a < 1e7 ? 2 : 1);
  if (a >= 1e4) return within(a / 1e3, a < 1e5 ? 1 : 0);
  if (a >= 1e3) return within(a, 0);
  return within(a, a < 10 ? 2 : a < 100 ? 1 : 0);
};

const sumOf = (values: number[], from: number, to: number): number => { let total = 0; for (let i = from; i < to; i++) total += values[i]; return total; };
const near = (a: number, b: number): boolean => a !== 0 && Math.abs(a - b) <= Math.abs(a) * 0.02;
/**
 * A row that adds up (or averages) the rows it stands beside: the total at the foot or at the head, a subtotal after a run of rows, an average at the foot or
 * at the head. Within 2% (a total of rounded figures); runs of rows that hold a zero are not read as sums. A line over periods is not checked at all (its rows
 * are periods, a steady series sits near its own mean). Percentages that make a whole (50, 20, 15, 15) are the shares, not a total and its parts.
 */
const hasSummaryRow = (values: number[], percent: boolean): boolean => {
  const n = values.length;
  if (n < 3) return false;
  if (percent && Math.abs(sumOf(values, 0, n) - 100) <= WHOLE_TOLERANCE) return false;
  const nonzero = (from: number, to: number) => values.slice(from, to).every(v => v !== 0);
  for (let at = 2; at < n; at++) for (let from = 0; from <= at - 2; from++) if (nonzero(from, at) && near(values[at], sumOf(values, from, at))) return true;
  if (nonzero(1, n) && near(values[0], sumOf(values, 1, n))) return true;
  if (n >= 4) {
    if (nonzero(0, n - 1) && near(values[n - 1], sumOf(values, 0, n - 1) / (n - 1))) return true;
    if (nonzero(1, n) && near(values[0], sumOf(values, 1, n) / (n - 1))) return true;
  }
  return false;
};
/** A column that is, in every row, the sum (or the mean) of the columns beside it: a total or an average column, a bar of another size. */
const derivesFromOthers = (column: number[], others: number[][]): boolean => {
  const same = (a: number, b: number) => (a === 0 && b === 0) || near(a, b);
  const sum = (row: number) => others.reduce((total, other) => total + other[row], 0);
  return column.every((v, row) => same(v, sum(row))) || column.every((v, row) => same(v, sum(row) / others.length));
};

/** A label of at most `max` characters, unique: when they do not fit as written, what every label shares up to its last separator is dropped (the year of dates of one year). Null when they cannot be shown whole: no label is cut at a length. */
function fitLabels(labels: string[], max: number): string[] | null {
  const fits = (list: string[]) => list.every(l => l.length >= 1 && l.length <= max) && new Set(list).size === list.length;
  if (fits(labels)) return labels;
  let prefix = labels[0];
  for (const l of labels) while (!l.startsWith(prefix)) prefix = prefix.slice(0, -1);
  const cut = Math.max(prefix.lastIndexOf('-'), prefix.lastIndexOf('.'), prefix.lastIndexOf('/'), prefix.lastIndexOf(' '), prefix.lastIndexOf('년'));
  const trimmed = cut >= 0 ? labels.map(l => l.slice(cut + 1)) : labels;
  return fits(trimmed) ? trimmed : null;
}

const tableBlock = (t: MdTable): CardBlock => ({ type: 'table', columns: t.header.map(h => ({ label: stripInline(h) || ' ' })), rows: t.rows.map(r => t.header.map((_, i) => stripInline(r[i] ?? ''))) });

/**
 * Chart of a table. The label column is the first column when its cells are periods, else the first that is not numbers. The series are the numeric columns of
 * the SAME unit class as the first figure column (a growth rate or a note beside the figures stays in the table, one switch away); a column that counts rows,
 * holds years or names the rows (id, code) is not a figure. A line over periods spaced evenly (in time order), a donut for shares of a whole, grouped bars for
 * the rest. Null when no chart is true to the table: blanks, columns of very different size on one axis, a row or a column that adds up the others, figures
 * the card would round, labels that repeat or do not fit, too many rows or columns.
 */
function chartOf(t: MdTable): { block: CardBlock; reason: string } | null {
  const columns = t.header.map((name, i) => ({ name: stripInline(name) || `#${i + 1}`, col: readColumn(t.rows.map(r => r[i] ?? '')) }));
  const periodLabels = (i: number): boolean => { const raw = columns[i].col.raw; return raw.length >= 3 && raw.filter(l => PERIOD.test(l)).length >= Math.ceil(raw.length * 0.8); };
  const labelAt = columns.findIndex(c => !c.col.numeric);
  // a table of numbers only has no names for its rows: its first column is a figure, not a label (unless it is a run of periods)
  if (labelAt === -1 && !periodLabels(0)) return null;
  const labelIndex = periodLabels(0) ? 0 : labelAt;
  const labels = t.rows.map((r, i) => stripInline(r[labelIndex] ?? '') || `#${i + 1}`);
  const figures = columns.filter((c, i) => i !== labelIndex && c.col.numeric && !countsRows(c.col) && !holdsYears(c.col) && !IDENTIFIER_HEADER.test(c.name));
  if (!figures.length) return null;
  const unitClass = figures[0].col.unit;
  const group = figures.filter(c => c.col.unit === unitClass);
  if (group.some(c => c.col.values.some(v => v === null))) return null;
  const columnValues = group.map(c => c.col.values as number[]);
  const percent = unitClass === 'percent';
  // the chart draws a number as the card's formatter writes it, and only as the table says it
  if (columnValues.some(values => values.some(v => !shownExactly(v, percent)))) return null;
  let order = labels.map((_, i) => i);
  let timeAxis = labels.length >= 3 && labels.length <= 24 && periodLabels(labelIndex);
  if (timeAxis) {
    const keys = labels.map(periodKey);
    if (keys.some(k => k === null)) timeAxis = false;
    else {
      const ks = keys as number[];
      if (ks.every((k, i) => i === 0 || k > ks[i - 1])) order = labels.map((_, i) => i);
      else if (ks.every((k, i) => i === 0 || k < ks[i - 1])) order = labels.map((_, i) => labels.length - 1 - i);
      else timeAxis = false;
    }
    // a line puts its points at equal distances: periods that skip (2019, 2020, 2022) are bars, in the order written
    if (timeAxis && !evenlySpaced(order.map(i => labels[i]))) timeAxis = false;
    if (!timeAxis) order = labels.map((_, i) => i);
  }
  // a total, a subtotal or an average drawn beside the rows it sums is a bar of another size; so is a total column beside its parts: the table keeps them.
  // A line over evenly spaced periods holds none: every one of its rows is a period, and a total row is not.
  if (!timeAxis && columnValues.some(values => hasSummaryRow(values, percent))) return null;
  if (columnValues.length >= 3 && columnValues.some((values, k) => derivesFromOthers(values, columnValues.filter((_, j) => j !== k)))) return null;
  if (group.length > 1) {
    const sizes = columnValues.map(values => Math.max(...values.map(Math.abs))).filter(size => size > 0);
    if (sizes.length > 1 && Math.max(...sizes) / Math.min(...sizes) >= SERIES_SCALE_RATIO_MAX) return null;
  }
  // no column is dropped without a word: a chart that cannot hold them all is not offered
  if (group.length > (timeAxis ? LINE_SERIES_MAX : BAR_SERIES_MAX)) return null;
  // an amount is drawn as a plain number (the card's currency formatter rounds to 만원 and K); the column's name says what it counts, and a 억 or 만 column's name says which
  const unit = percent ? 'percent' : 'count';
  const named = (c: (typeof group)[number]) => (c.col.scale ? `${c.name} (${c.col.scale})` : c.name);
  const pick = <T,>(items: T[]): T[] => order.map(i => items[i]);
  const caption = group.length === 1 ? { caption: named(group[0]).slice(0, 120) } : {};
  if (timeAxis) {
    const axis = fitLabels(pick(labels), AXIS_LABEL_MAX);
    if (!axis) return null;
    return { block: { type: 'line_chart', labels: axis, series: group.map((c, i) => ({ name: named(c), values: pick(columnValues[i]) })), unit, ...caption }, reason: 'chart_line_over_periods' };
  }
  if (group.length === 1 && percent && labels.length >= 2 && labels.length <= 8) {
    const values = columnValues[0];
    const total = values.reduce((acc, v) => acc + v, 0);
    const names = fitLabels(labels, 24);
    if (names && values.every(v => v > 0 && shownExactly(v, true, true)) && Math.abs(total - 100) <= WHOLE_TOLERANCE) return { block: { type: 'donut_chart', unit: 'percent', slices: names.map((label, i) => ({ label, value: values[i] })) }, reason: 'chart_donut_shares' };
  }
  if (labels.length >= 2 && labels.length <= 12) {
    const names = fitLabels(labels, 16);
    if (!names) return null;
    return { block: { type: 'bar_chart', labels: names, series: group.map((c, i) => ({ name: named(c), values: columnValues[i] })), unit, ...caption }, reason: 'chart_bars_by_category' };
  }
  return null;
}

/** A markdown table as a card: always a table; when its columns are numbers also a chart the owner can switch to. */
export function upgradeTable(t: MdTable): CardUpgrade | { skip: string } {
  const columns = t.header.length, rows = t.rows.length;
  if (columns < TABLE_MIN_COLUMNS) return { skip: 'table_too_narrow' };
  if (columns > TABLE_MAX_COLUMNS) return { skip: 'table_too_wide' };
  if (rows < TABLE_MIN_ROWS) return { skip: 'table_too_short' };
  if (rows > TABLE_MAX_ROWS) return { skip: 'table_too_long' };
  if (t.header.concat(...t.rows).some(c => /`/.test(c))) return { skip: 'table_has_code' };
  const cells = t.rows.flatMap(r => r.map(stripInline));
  if (!cells.length) return { skip: 'table_empty' };
  if (cells.reduce((a, c) => a + c.length, 0) / cells.length > TABLE_MAX_AVG_CELL) return { skip: 'table_cells_are_prose' };
  if (t.rows.some(r => r.length !== columns)) return { skip: 'table_ragged' };
  const table = tableBlock(t);
  const chart = chartOf(t);
  return chart ? { kind: 'chart', reason: chart.reason, blocks: [chart.block], alternate: [table] } : { kind: 'table', reason: 'table', blocks: [table] };
}

/** The title is cut at a word and the rest of what the item said goes under it, never dropped. */
const fitStep = (title: string, rest: string): { title: string; text?: string } => {
  if (title.length > STEP_TITLE_MAX) {
    const at = title.lastIndexOf(' ', STEP_TITLE_MAX);
    const head = at >= 12 ? title.slice(0, at) : title.slice(0, STEP_TITLE_MAX);
    rest = `${title.slice(head.length).trim()} ${rest}`.trim();
    title = head;
  }
  return rest ? { title, text: rest.slice(0, STEP_TEXT_MAX) } : { title };
};
/** The item's own title and the line under it: a bold lead (`**Title**: text`) or a short title and a colon (`Title: text`). An item without one is not a titled step (a dash is as often a name and a note as a title). */
const splitStep = (text: string): { title: string; text?: string } | null => {
  const plain = stripInline(text);
  const lead = String(text).match(/^\s*(?:\*\*|__)([^*_]{1,60})(?:\*\*|__)\s*[:：\-–—.]?\s*(.*)$/s);
  if (lead) return fitStep(stripInline(lead[1]), stripInline(lead[2]));
  const cut = plain.match(/^(.{1,40}?)\s*[:：]\s+(.+)$/s);
  return cut ? fitStep(cut[1].trim(), cut[2].trim()) : null;
};

/** A numbered list as steps. Only a list that is plainly a short run of titled items; whether the items are a SEQUENCE is not something its shape can tell (a list of tips has the same shape), so this is for a button. */
export function upgradeSteps(list: MdList): CardUpgrade | { skip: string } {
  if (!list.ordered) return { skip: 'list_not_numbered' };
  if (list.start !== undefined && list.start !== 1) return { skip: 'steps_do_not_start_at_one' };
  const n = list.items.length;
  if (n < STEPS_MIN) return { skip: 'steps_too_few' };
  if (n > STEPS_MAX) return { skip: 'steps_too_many' };
  if (list.items.some(i => i.children)) return { skip: 'steps_have_children' };
  if (list.items.some(i => /`/.test(i.text))) return { skip: 'steps_have_code' };
  if (list.items.some(i => /\]\(|https?:\/\/|www\./i.test(i.text))) return { skip: 'steps_have_links' };
  if (list.items.some(i => stripInline(i.text).length > STEP_MAX_CHARS)) return { skip: 'steps_too_long' };
  const parts = list.items.map(i => splitStep(i.text));
  if (parts.some(part => part === null)) return { skip: 'steps_not_titled' };
  const steps = parts as { title: string; text?: string }[];
  if (steps.some(s => !s.title)) return { skip: 'steps_empty_title' };
  // a step holds a title and a line of text: what an item says past that is not cut off silently, the list is not offered
  if (list.items.some((i, k) => stripInline(i.text).length > (steps[k].title.length + (steps[k].text?.length ?? 0) + 6))) return { skip: 'steps_text_too_long' };
  return { kind: 'steps', reason: 'steps', blocks: [{ type: 'process_steps', steps }] };
}

export const isUpgrade = (value: CardUpgrade | { skip: string }): value is CardUpgrade => 'blocks' in value;
