/*
 * Spreadsheet formula evaluation for live documents, so the Document tab, the outline the AI reads and the saved
 * workbook's cached values all show what a formula computes instead of its text. No dependency: a tokenizer, a
 * precedence parser and the functions office work uses most (SUMIFS, COUNTIFS, INDEX/MATCH, VLOOKUP/XLOOKUP, RANK,
 * DATE, TEXT, IF, ROUND …). A formula that calls a function outside this set is not evaluated: the cell keeps the
 * value the file carried, and Excel recalculates it on open (the workbook is saved with fullCalcOnLoad).
 */

export interface FormulaCell { v: string; f?: string; n?: number; nf?: string }
export interface FormulaSheet { name: string; cells: Record<string, FormulaCell> }

type Err = { error: string };
type Scalar = number | string | boolean | null | Err;
interface RangeValue { range: true; rows: Scalar[][] }
type Value = Scalar | RangeValue;

const UNSUPPORTED = Symbol("unsupported");
class Unsupported extends Error { readonly mark = UNSUPPORTED; }

const err = (code: string): Err => ({ error: code });
const isErr = (value: unknown): value is Err => typeof value === "object" && value !== null && "error" in value;
const isRange = (value: unknown): value is RangeValue => typeof value === "object" && value !== null && "range" in value;

// ── addresses ────────────────────────────────────────────────────────────────────────────────────────────────────

function colNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function colLetters(n: number): string {
  let out = "";
  while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
  return out;
}

// ── dates ────────────────────────────────────────────────────────────────────────────────────────────────────────

const EPOCH = Date.UTC(1899, 11, 30);
const DAY = 86_400_000;
export const dateSerial = (y: number, m: number, d: number): number => Math.round((Date.UTC(y, m - 1, d) - EPOCH) / DAY);
const serialDate = (serial: number): Date => new Date(EPOCH + Math.floor(serial) * DAY);

// ── coercion ─────────────────────────────────────────────────────────────────────────────────────────────────────

const NUMERIC_TEXT = /^\s*[-+]?\$?\s*(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?\s*%?\s*$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/;

/** A cell's text as the value a formula sees: numbers, dates (ISO) and TRUE/FALSE are typed, the rest stays text. */
export function cellTextValue(text: string): Scalar {
  const t = text.trim();
  if (t === "") return null;
  if (t === "TRUE") return true;
  if (t === "FALSE") return false;
  if (/^#(?:DIV\/0!|N\/A|VALUE!|REF!|NAME\?|NUM!|NULL!)$/.test(t)) return err(t);
  const iso = ISO_DATE.exec(t);
  if (iso) return dateSerial(Number(iso[1]), Number(iso[2]), Number(iso[3])) + (iso[4] ? (Number(iso[4]) * 60 + Number(iso[5])) / 1440 : 0);
  if (/\d/.test(t) && NUMERIC_TEXT.test(t)) {
    const pct = t.endsWith("%");
    const n = Number(t.replace(/[$,%\s]/g, ""));
    if (Number.isFinite(n)) return pct ? n / 100 : n;
  }
  return text;
}

function toNumber(value: Scalar): number | Err {
  if (isErr(value)) return value;
  if (value === null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const typed = cellTextValue(value);
  return typeof typed === "number" ? typed : err("#VALUE!");
}
function toText(value: Scalar): string | Err {
  if (isErr(value)) return value;
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return generalNumber(value);
  return value;
}
function toBool(value: Scalar): boolean | Err {
  if (isErr(value)) return value;
  if (typeof value === "boolean") return value;
  if (value === null) return false;
  if (typeof value === "number") return value !== 0;
  const upper = value.trim().toUpperCase();
  if (upper === "TRUE") return true;
  if (upper === "FALSE") return false;
  return err("#VALUE!");
}

// ── number formats ───────────────────────────────────────────────────────────────────────────────────────────────

export function generalNumber(value: number): string {
  if (!Number.isFinite(value)) return "#NUM!";
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  const fixed = Number(value.toPrecision(10));
  return Math.abs(fixed) >= 1e15 || (Math.abs(fixed) < 1e-9 && fixed !== 0) ? fixed.toExponential(5) : String(fixed);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatDate(serial: number, code: string): string {
  const date = serialDate(serial);
  const y = date.getUTCFullYear(), m = date.getUTCMonth(), d = date.getUTCDate(), wd = date.getUTCDay();
  const minutes = Math.round((serial - Math.floor(serial)) * 1440);
  const hh = Math.floor(minutes / 60), mi = minutes % 60;
  const hasTime = /h/i.test(code);
  return code.replace(/yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|AM\/PM/gi, (token, offset: number, whole: string) => {
    const lower = token.toLowerCase();
    // "mm" right after an hour is minutes.
    if ((lower === "mm" || lower === "m") && hasTime && /h+[^a-z]*$/i.test(whole.slice(0, offset))) return lower === "mm" ? String(mi).padStart(2, "0") : String(mi);
    switch (lower) {
      case "yyyy": return String(y);
      case "yy": return String(y).slice(-2);
      case "mmmm": return MONTHS[m];
      case "mmm": return MONTHS[m].slice(0, 3);
      case "mm": return String(m + 1).padStart(2, "0");
      case "m": return String(m + 1);
      case "dddd": return DAYS[wd];
      case "ddd": return DAYS[wd].slice(0, 3);
      case "dd": return String(d).padStart(2, "0");
      case "d": return String(d);
      case "hh": return String(hh).padStart(2, "0");
      case "h": return String(hh);
      case "ss": return "00";
      default: return token;
    }
  });
}

/** Formats a number with an Excel number-format code (the common subset: dates, %, thousands, fixed decimals). */
export function formatNumberCode(value: number, rawCode: string): string {
  const code = rawCode.split(";")[value < 0 && rawCode.includes(";") ? 1 : 0] ?? rawCode;
  const bare = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
  if (/^general$/i.test(bare.trim()) || bare.trim() === "") return generalNumber(value);
  if (/[yd]/i.test(bare) || (/m/i.test(bare) && !/[#0]/.test(bare))) return formatDate(value, code.replace(/\[[^\]]*\]/g, "").replace(/"([^"]*)"/g, "$1").replace(/\\(.)/g, "$1"));
  const percent = bare.includes("%");
  const n = percent ? value * 100 : value;
  const decimals = /\.([0#]+)/.exec(bare)?.[1].length ?? 0;
  const grouped = bare.includes(",");
  const abs = Math.abs(n);
  let body = grouped
    ? abs.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    : abs.toFixed(decimals);
  const prefix = /^[^#0]*/.exec(code.replace(/"([^"]*)"/g, "$1").replace(/\\(.)/g, "$1"))?.[0].replace(/[_*].?/g, "").replace(/[()]/g, "") ?? "";
  if (value < 0 && !rawCode.includes(";")) body = `-${body}`;
  return `${prefix}${body}${percent ? "%" : ""}`;
}

function displayOf(result: Scalar, nf: string | undefined): string {
  if (result === null) return "";
  if (isErr(result)) return result.error;
  if (typeof result === "boolean") return result ? "TRUE" : "FALSE";
  if (typeof result === "number") return nf ? formatNumberCode(result, nf) : generalNumber(result);
  return result;
}

// ── tokenizer ────────────────────────────────────────────────────────────────────────────────────────────────────

type Token =
  | { t: "num"; v: number } | { t: "str"; v: string } | { t: "bool"; v: boolean } | { t: "err"; v: string }
  | { t: "ref"; sheet?: string; a: string; b?: string } | { t: "fn"; v: string } | { t: "op"; v: string } | { t: "name"; v: string };

const CELL = "\\$?[A-Za-z]{1,3}\\$?\\d+";
const COL = "\\$?[A-Za-z]{1,3}";
const ROW = "\\$?\\d+";
const SHEET = "(?:'((?:[^']|'')+)'|([A-Za-z_\\u0080-\\uffff][\\w.\\u0080-\\uffff]*))!";
const REF_RE = new RegExp(`^(?:${SHEET})?(?:(${CELL})(?::(${CELL}))?|(${COL}):(${COL})|(${ROW}):(${ROW}))(?![\\w(])`);

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    const rest = src.slice(i);
    if (ch === '"') {
      let j = i + 1, s = "";
      while (j < src.length) { if (src[j] === '"') { if (src[j + 1] === '"') { s += '"'; j += 2; continue; } break; } s += src[j++]; }
      out.push({ t: "str", v: s }); i = j + 1; continue;
    }
    const errMatch = /^#(?:DIV\/0!|N\/A|VALUE!|REF!|NAME\?|NUM!|NULL!)/.exec(rest);
    if (errMatch) { out.push({ t: "err", v: errMatch[0] }); i += errMatch[0].length; continue; }
    // References first: a row range such as 1:3 must not read as the number 1.
    const ref = REF_RE.exec(rest);
    if (ref) {
      const sheet = ref[1] !== undefined ? ref[1].replace(/''/g, "'") : ref[2];
      const [a, b] = ref[3] ? [ref[3], ref[4]] : ref[5] ? [ref[5], ref[6]] : [ref[7], ref[8]];
      out.push({ t: "ref", sheet, a, b });
      i += ref[0].length; continue;
    }
    const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(rest);
    if (num) { out.push({ t: "num", v: Number(num[0]) }); i += num[0].length; continue; }
    const word = /^[A-Za-z_][\w.]*/.exec(rest);
    if (word) {
      const after = src.slice(i + word[0].length).trimStart();
      if (after.startsWith("(")) { out.push({ t: "fn", v: word[0].toUpperCase().replace(/^_XLFN\./, "") }); i += word[0].length; continue; }
      const upper = word[0].toUpperCase();
      if (upper === "TRUE" || upper === "FALSE") { out.push({ t: "bool", v: upper === "TRUE" }); i += word[0].length; continue; }
      out.push({ t: "name", v: word[0] }); i += word[0].length; continue;
    }
    const op = /^(?:<=|>=|<>|[-+*/^&=<>%(),;:])/.exec(rest);
    if (op) { out.push({ t: "op", v: op[0] === ";" ? "," : op[0] }); i += op[0].length; continue; }
    throw new Unsupported(`token ${ch}`);
  }
  return out;
}

// ── parser ───────────────────────────────────────────────────────────────────────────────────────────────────────

type Node =
  | { k: "lit"; v: Scalar } | { k: "ref"; sheet?: string; a: string; b?: string }
  | { k: "un"; op: string; x: Node } | { k: "bin"; op: string; l: Node; r: Node } | { k: "pct"; x: Node }
  | { k: "call"; name: string; args: Node[] };

function parse(src: string): Node {
  const tokens = tokenize(src);
  let p = 0;
  const peek = () => tokens[p];
  const isOp = (v: string) => peek()?.t === "op" && (peek() as { v: string }).v === v;
  const expect = (v: string) => { if (!isOp(v)) throw new Unsupported(`expected ${v}`); p++; };
  const binary = (next: () => Node, ops: string[]) => () => {
    let left = next();
    while (peek()?.t === "op" && ops.includes((peek() as { v: string }).v)) { const op = (tokens[p++] as { v: string }).v; left = { k: "bin", op, l: left, r: next() }; }
    return left;
  };
  const primary = (): Node => {
    const tok = tokens[p++];
    if (!tok) throw new Unsupported("unexpected end");
    switch (tok.t) {
      case "num": return { k: "lit", v: tok.v };
      case "str": return { k: "lit", v: tok.v };
      case "bool": return { k: "lit", v: tok.v };
      case "err": return { k: "lit", v: err(tok.v) };
      case "ref": return { k: "ref", sheet: tok.sheet, a: tok.a, b: tok.b };
      case "name": throw new Unsupported(`name ${tok.v}`);
      case "fn": {
        expect("(");
        const args: Node[] = [];
        if (!isOp(")")) {
          for (;;) {
            if (isOp(",") || isOp(")")) args.push({ k: "lit", v: null }); else args.push(comparison());
            if (isOp(",")) { p++; continue; }
            break;
          }
        }
        expect(")");
        return { k: "call", name: tok.v, args };
      }
      case "op":
        if (tok.v === "(") { const inner = comparison(); expect(")"); return inner; }
        if (tok.v === "-" || tok.v === "+") return { k: "un", op: tok.v, x: postfix() };
        throw new Unsupported(`operator ${tok.v}`);
    }
  };
  const postfix = (): Node => { let x = primary(); while (isOp("%")) { p++; x = { k: "pct", x }; } return x; };
  const power = binary(postfix, ["^"]);
  const mult = binary(power, ["*", "/"]);
  const additive = binary(mult, ["+", "-"]);
  const concat = binary(additive, ["&"]);
  const comparison: () => Node = binary(concat, ["=", "<>", "<", ">", "<=", ">="]);
  const root = comparison();
  if (p < tokens.length) throw new Unsupported("trailing tokens");
  return root;
}

// ── evaluation ───────────────────────────────────────────────────────────────────────────────────────────────────

interface Ctx { sheet: string }

class Workbook {
  private readonly sheets = new Map<string, FormulaSheet>();
  private readonly memo = new Map<string, Scalar>();
  private readonly active = new Set<string>();
  private readonly parsed = new Map<string, Node | null>();
  private readonly extents = new Map<string, { rows: number; cols: number }>();

  constructor(sheets: FormulaSheet[]) {
    for (const sheet of sheets) this.sheets.set(sheet.name.toLowerCase(), sheet);
  }

  private sheetOf(name: string): FormulaSheet | undefined { return this.sheets.get(name.toLowerCase()); }

  private extent(sheet: FormulaSheet): { rows: number; cols: number } {
    let hit = this.extents.get(sheet.name);
    if (!hit) {
      let rows = 0, cols = 0;
      for (const address of Object.keys(sheet.cells)) {
        const m = /^([A-Z]+)(\d+)$/.exec(address);
        if (m) { rows = Math.max(rows, Number(m[2])); cols = Math.max(cols, colNumber(m[1])); }
      }
      hit = { rows, cols };
      this.extents.set(sheet.name, hit);
    }
    return hit;
  }

  node(formula: string): Node | null {
    if (!this.parsed.has(formula)) {
      try { this.parsed.set(formula, parse(formula)); } catch { this.parsed.set(formula, null); }
    }
    return this.parsed.get(formula) ?? null;
  }

  /** The value of a cell; formula cells are evaluated once (cycles are #REF!). Throws Unsupported upward. */
  cell(sheetName: string, address: string): Scalar {
    const sheet = this.sheetOf(sheetName);
    if (!sheet) return err("#REF!");
    const cell = sheet.cells[address];
    if (!cell) return null;
    if (cell.f === undefined) return cell.n !== undefined ? cell.n : cellTextValue(cell.v);
    const key = `${sheet.name.toLowerCase()}!${address}`;
    if (this.memo.has(key)) return this.memo.get(key)!;
    if (this.active.has(key)) return err("#REF!");
    this.active.add(key);
    try {
      const node = this.node(cell.f);
      if (!node) throw new Unsupported(cell.f);
      const value = this.scalar(this.eval(node, { sheet: sheet.name }));
      this.memo.set(key, value);
      return value;
    } finally {
      this.active.delete(key);
    }
  }

  /** Evaluates a formula cell for display; undefined when it uses something this engine does not support. */
  result(sheetName: string, address: string): Scalar | undefined {
    try { return this.cell(sheetName, address); } catch (error) { if ((error as Unsupported).mark === UNSUPPORTED) return undefined; throw error; }
  }

  private range(node: Extract<Node, { k: "ref" }>, ctx: Ctx): RangeValue | Err {
    const sheetName = node.sheet ?? ctx.sheet;
    const sheet = this.sheetOf(sheetName);
    if (!sheet) return err("#REF!");
    const parse1 = (part: string) => {
      const clean = part.replace(/\$/g, "").toUpperCase();
      const m = /^([A-Z]*)(\d*)$/.exec(clean)!;
      return { col: m[1] ? colNumber(m[1]) : 0, row: m[2] ? Number(m[2]) : 0 };
    };
    const a = parse1(node.a), b = parse1(node.b ?? node.a);
    const ext = this.extent(sheet);
    const c1 = Math.min(a.col || 1, b.col || 1), c2 = Math.max(a.col || ext.cols, b.col || ext.cols);
    const r1 = Math.min(a.row || 1, b.row || 1), r2 = Math.max(a.row || ext.rows, b.row || ext.rows);
    if ((r2 - r1 + 1) * (c2 - c1 + 1) > 2_000_000) throw new Unsupported("range too large");
    const rows: Scalar[][] = [];
    for (let r = r1; r <= r2; r++) {
      const row: Scalar[] = [];
      for (let c = c1; c <= c2; c++) row.push(this.cell(sheet.name, `${colLetters(c)}${r}`));
      rows.push(row);
    }
    return { range: true, rows };
  }

  scalar(value: Value): Scalar {
    if (!isRange(value)) return value;
    if (value.rows.length === 1 && value.rows[0].length === 1) return value.rows[0][0];
    return err("#VALUE!");
  }

  eval(node: Node, ctx: Ctx): Value {
    switch (node.k) {
      case "lit": return node.v;
      case "ref": return this.range(node, ctx);
      case "pct": { const n = toNumber(this.scalar(this.eval(node.x, ctx))); return isErr(n) ? n : n / 100; }
      case "un": { const n = toNumber(this.scalar(this.eval(node.x, ctx))); return isErr(n) ? n : node.op === "-" ? -n : n; }
      case "bin": return this.binary(node.op, this.scalar(this.eval(node.l, ctx)), this.scalar(this.eval(node.r, ctx)));
      case "call": return this.call(node.name, node.args, ctx);
    }
  }

  private binary(op: string, l: Scalar, r: Scalar): Scalar {
    if (isErr(l)) return l;
    if (isErr(r)) return r;
    if (op === "&") { const a = toText(l), b = toText(r); return isErr(a) ? a : isErr(b) ? b : a + b; }
    if (["=", "<>", "<", ">", "<=", ">="].includes(op)) {
      const c = compare(l, r);
      return op === "=" ? c === 0 : op === "<>" ? c !== 0 : op === "<" ? c < 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : c >= 0;
    }
    const a = toNumber(l), b = toNumber(r);
    if (isErr(a)) return a;
    if (isErr(b)) return b;
    switch (op) {
      case "+": return a + b;
      case "-": return a - b;
      case "*": return a * b;
      case "/": return b === 0 ? err("#DIV/0!") : a / b;
      case "^": return Math.pow(a, b);
    }
    return err("#VALUE!");
  }

  private values(args: Node[], ctx: Ctx): Scalar[] {
    const out: Scalar[] = [];
    for (const arg of args) {
      const value = this.eval(arg, ctx);
      if (isRange(value)) for (const row of value.rows) out.push(...row); else out.push(value);
    }
    return out;
  }

  private numbers(args: Node[], ctx: Ctx): number[] | Err {
    const out: number[] = [];
    for (const arg of args) {
      const value = this.eval(arg, ctx);
      if (isRange(value)) {
        for (const row of value.rows) for (const cell of row) { if (isErr(cell)) return cell; if (typeof cell === "number") out.push(cell); }
      } else {
        const n = toNumber(value);
        if (isErr(n)) return n;
        out.push(n);
      }
    }
    return out;
  }

  private rangeArg(node: Node | undefined, ctx: Ctx): RangeValue | Err {
    if (!node) return err("#VALUE!");
    const value = this.eval(node, ctx);
    if (isErr(value)) return value;
    return isRange(value) ? value : { range: true, rows: [[value]] };
  }

  private scalarArg(node: Node | undefined, ctx: Ctx, fallback: Scalar = null): Scalar {
    return node ? this.scalar(this.eval(node, ctx)) : fallback;
  }

  private num(node: Node | undefined, ctx: Ctx, fallback?: number): number | Err {
    if (!node) return fallback !== undefined ? fallback : err("#VALUE!");
    return toNumber(this.scalarArg(node, ctx));
  }

  /** Cells matching every (range, criterion) pair; returns the flat indexes into the first range. */
  private matches(pairs: Array<[Node, Node]>, ctx: Ctx): { indexes: number[]; width: number } | Err {
    let indexes: number[] | null = null;
    let width = 0, size = -1;
    for (const [rangeNode, critNode] of pairs) {
      const range = this.rangeArg(rangeNode, ctx);
      if (isErr(range)) return range;
      const flat = range.rows.flat();
      if (size >= 0 && flat.length !== size) return err("#VALUE!");
      size = flat.length; width = range.rows[0]?.length ?? 0;
      const test = criterion(this.scalarArg(critNode, ctx));
      const hit: number[] = [];
      flat.forEach((cell, i) => { if ((indexes === null || indexes.includes(i)) && test(cell)) hit.push(i); });
      indexes = hit;
    }
    return { indexes: indexes ?? [], width };
  }

  private call(name: string, args: Node[], ctx: Ctx): Value {
    const s = (i: number, fallback: Scalar = null) => this.scalarArg(args[i], ctx, fallback);
    const n = (i: number, fallback?: number) => this.num(args[i], ctx, fallback);
    switch (name) {
      case "SUM": { const xs = this.numbers(args, ctx); return isErr(xs) ? xs : xs.reduce((a, b) => a + b, 0); }
      case "PRODUCT": { const xs = this.numbers(args, ctx); return isErr(xs) ? xs : xs.reduce((a, b) => a * b, 1); }
      case "AVERAGE": { const xs = this.numbers(args, ctx); return isErr(xs) ? xs : xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : err("#DIV/0!"); }
      case "MIN": { const xs = this.numbers(args, ctx); return isErr(xs) ? xs : xs.length ? Math.min(...xs) : 0; }
      case "MAX": { const xs = this.numbers(args, ctx); return isErr(xs) ? xs : xs.length ? Math.max(...xs) : 0; }
      case "MEDIAN": {
        const xs = this.numbers(args, ctx); if (isErr(xs)) return xs; if (!xs.length) return err("#NUM!");
        const sorted = [...xs].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      }
      case "COUNT": return this.values(args, ctx).filter((v) => typeof v === "number").length;
      case "COUNTA": return this.values(args, ctx).filter((v) => v !== null && v !== "").length;
      case "COUNTBLANK": return this.values(args, ctx).filter((v) => v === null || v === "").length;
      case "SUMIF": case "AVERAGEIF": case "COUNTIF": {
        const m = this.matches([[args[0], args[1]]], ctx); if (isErr(m)) return m;
        if (name === "COUNTIF") return m.indexes.length;
        const target = this.rangeArg(args[2] ?? args[0], ctx); if (isErr(target)) return target;
        return aggregate(name === "SUMIF" ? "sum" : "avg", target.rows.flat(), m.indexes);
      }
      case "SUMIFS": case "AVERAGEIFS": case "MINIFS": case "MAXIFS": case "COUNTIFS": {
        const first = name === "COUNTIFS" ? 0 : 1;
        if ((args.length - first) % 2 !== 0 || args.length - first < 2) return err("#VALUE!");
        const pairs: Array<[Node, Node]> = [];
        for (let i = first; i < args.length; i += 2) pairs.push([args[i], args[i + 1]]);
        const m = this.matches(pairs, ctx); if (isErr(m)) return m;
        if (name === "COUNTIFS") return m.indexes.length;
        const target = this.rangeArg(args[0], ctx); if (isErr(target)) return target;
        const kind = name === "SUMIFS" ? "sum" : name === "AVERAGEIFS" ? "avg" : name === "MINIFS" ? "min" : "max";
        return aggregate(kind, target.rows.flat(), m.indexes);
      }
      case "SUMPRODUCT": {
        const ranges = args.map((arg) => this.rangeArg(arg, ctx));
        const bad = ranges.find(isErr); if (bad) return bad as Err;
        const flats = (ranges as RangeValue[]).map((r) => r.rows.flat());
        if (flats.some((f) => f.length !== flats[0].length)) return err("#VALUE!");
        let total = 0;
        for (let i = 0; i < flats[0].length; i++) total += flats.reduce((acc, f) => acc * (typeof f[i] === "number" ? f[i] as number : 0), 1);
        return total;
      }
      case "ROUND": case "ROUNDUP": case "ROUNDDOWN": {
        const x = n(0), d = n(1, 0); if (isErr(x)) return x; if (isErr(d)) return d;
        const f = Math.pow(10, Math.trunc(d));
        const scaled = x * f;
        const rounded = name === "ROUND" ? Math.sign(scaled) * Math.round(Math.abs(scaled) + 1e-9)
          : name === "ROUNDUP" ? Math.sign(scaled) * Math.ceil(Math.abs(scaled) - 1e-9) : Math.trunc(scaled);
        return rounded / f;
      }
      case "INT": { const x = n(0); return isErr(x) ? x : Math.floor(x); }
      case "ABS": { const x = n(0); return isErr(x) ? x : Math.abs(x); }
      case "SQRT": { const x = n(0); return isErr(x) ? x : x < 0 ? err("#NUM!") : Math.sqrt(x); }
      case "POWER": { const a = n(0), b = n(1); return isErr(a) ? a : isErr(b) ? b : Math.pow(a, b); }
      case "MOD": { const a = n(0), b = n(1); if (isErr(a)) return a; if (isErr(b)) return b; return b === 0 ? err("#DIV/0!") : a - b * Math.floor(a / b); }
      case "PI": return Math.PI;
      case "IF": {
        const c = toBool(s(0)); if (isErr(c)) return c;
        return c ? (args[1] ? this.eval(args[1], ctx) : true) : (args[2] ? this.eval(args[2], ctx) : false);
      }
      case "IFS": {
        for (let i = 0; i + 1 < args.length; i += 2) { const c = toBool(s(i)); if (isErr(c)) return c; if (c) return this.eval(args[i + 1], ctx); }
        return err("#N/A");
      }
      case "IFERROR": { const v = s(0); return isErr(v) ? s(1) : v; }
      case "IFNA": { const v = s(0); return isErr(v) && v.error === "#N/A" ? s(1) : v; }
      case "AND": case "OR": {
        const xs = this.values(args, ctx).filter((v) => v !== null);
        let acc = name === "AND";
        for (const x of xs) { const b = toBool(x); if (isErr(b)) return b; acc = name === "AND" ? acc && b : acc || b; }
        return acc;
      }
      case "NOT": { const b = toBool(s(0)); return isErr(b) ? b : !b; }
      case "CHOOSE": { const i = n(0); if (isErr(i)) return i; const pick = args[Math.trunc(i)]; return pick && i >= 1 ? this.eval(pick, ctx) : err("#VALUE!"); }
      case "ISBLANK": return s(0) === null;
      case "ISNUMBER": return typeof s(0) === "number";
      case "ISTEXT": return typeof s(0) === "string";
      case "ISERROR": return isErr(s(0));
      case "N": { const v = s(0); return typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : 0; }
      case "VALUE": { const v = s(0); if (typeof v === "number") return v; const t = toText(v); if (isErr(t)) return t; const typed = cellTextValue(t); return typeof typed === "number" ? typed : err("#VALUE!"); }
      case "INDEX": {
        const range = this.rangeArg(args[0], ctx); if (isErr(range)) return range;
        let r = n(1, 0), c = n(2, 0); if (isErr(r)) return r; if (isErr(c)) return c;
        if (range.rows.length === 1 && args.length === 2) { c = r; r = 1; }
        const rows = range.rows;
        if (r === 0 && c === 0) return range;
        if (r === 0) return { range: true, rows: rows.map((row) => [row[c - 1] ?? err("#REF!")]) };
        if (c === 0) return rows[r - 1] ? { range: true, rows: [rows[r - 1]] } : err("#REF!");
        return rows[r - 1]?.[c - 1] ?? err("#REF!");
      }
      case "MATCH": {
        const needle = s(0); if (isErr(needle)) return needle;
        const range = this.rangeArg(args[1], ctx); if (isErr(range)) return range;
        const type = n(2, 1); if (isErr(type)) return type;
        const flat = range.rows.length === 1 ? range.rows[0] : range.rows.map((row) => row[0]);
        const i = lookupIndex(needle, flat, type);
        return i < 0 ? err("#N/A") : i + 1;
      }
      case "VLOOKUP": case "HLOOKUP": {
        const needle = s(0); if (isErr(needle)) return needle;
        const range = this.rangeArg(args[1], ctx); if (isErr(range)) return range;
        const idx = n(2); if (isErr(idx)) return idx;
        const approx = args[3] ? toBool(s(3)) : true; if (isErr(approx)) return approx;
        const keys = name === "VLOOKUP" ? range.rows.map((row) => row[0]) : range.rows[0] ?? [];
        const i = lookupIndex(needle, keys, approx ? 1 : 0);
        if (i < 0) return err("#N/A");
        const value = name === "VLOOKUP" ? range.rows[i]?.[idx - 1] : range.rows[idx - 1]?.[i];
        return value === undefined ? err("#REF!") : value;
      }
      case "XLOOKUP": {
        const needle = s(0); if (isErr(needle)) return needle;
        const look = this.rangeArg(args[1], ctx); if (isErr(look)) return look;
        const ret = this.rangeArg(args[2], ctx); if (isErr(ret)) return ret;
        const flat = look.rows.length === 1 ? look.rows[0] : look.rows.map((row) => row[0]);
        const i = lookupIndex(needle, flat, 0);
        if (i < 0) return args[3] ? s(3) : err("#N/A");
        return look.rows.length === 1 ? (ret.rows.length === 1 ? ret.rows[0][i] : { range: true, rows: ret.rows.map((row) => [row[i]]) }) : (ret.rows[i]?.length === 1 ? ret.rows[i][0] : { range: true, rows: [ret.rows[i]] });
      }
      case "RANK": case "RANK.EQ": {
        const x = n(0); if (isErr(x)) return x;
        const xs = this.numbers([args[1]], ctx); if (isErr(xs)) return xs;
        const asc = args[2] ? toNumber(s(2)) : 0; if (isErr(asc)) return asc;
        if (!xs.includes(x)) return err("#N/A");
        return 1 + xs.filter((y) => (asc ? y < x : y > x)).length;
      }
      case "LARGE": case "SMALL": {
        const xs = this.numbers([args[0]], ctx); if (isErr(xs)) return xs; const k = n(1); if (isErr(k)) return k;
        const sorted = [...xs].sort((a, b) => (name === "LARGE" ? b - a : a - b));
        return sorted[Math.trunc(k) - 1] ?? err("#NUM!");
      }
      case "DATE": {
        const y = n(0), m = n(1), d = n(2); if (isErr(y)) return y; if (isErr(m)) return m; if (isErr(d)) return d;
        return dateSerial(Math.trunc(y), Math.trunc(m), Math.trunc(d));
      }
      case "YEAR": case "MONTH": case "DAY": case "WEEKDAY": {
        const x = n(0); if (isErr(x)) return x; const date = serialDate(x);
        return name === "YEAR" ? date.getUTCFullYear() : name === "MONTH" ? date.getUTCMonth() + 1 : name === "DAY" ? date.getUTCDate() : date.getUTCDay() + 1;
      }
      case "EOMONTH": {
        const x = n(0), months = n(1, 0); if (isErr(x)) return x; if (isErr(months)) return months;
        const date = serialDate(x);
        return dateSerial(date.getUTCFullYear(), date.getUTCMonth() + 1 + Math.trunc(months) + 1, 0);
      }
      case "TODAY": { const now = new Date(); return dateSerial(now.getFullYear(), now.getMonth() + 1, now.getDate()); }
      case "TEXT": {
        const v = s(0); const code = toText(s(1)); if (isErr(code)) return code;
        if (isErr(v)) return v;
        const num = typeof v === "string" ? cellTextValue(v) : v;
        return typeof num === "number" ? formatNumberCode(num, code) : toText(v);
      }
      case "CONCAT": case "CONCATENATE": {
        let out = "";
        for (const v of this.values(args, ctx)) { const t = toText(v); if (isErr(t)) return t; out += t; }
        return out;
      }
      case "TEXTJOIN": {
        const sep = toText(s(0)); if (isErr(sep)) return sep;
        const skip = toBool(s(1)); if (isErr(skip)) return skip;
        const parts: string[] = [];
        for (const v of this.values(args.slice(2), ctx)) { const t = toText(v); if (isErr(t)) return t; if (!skip || t !== "") parts.push(t); }
        return parts.join(sep);
      }
      case "LEN": { const t = toText(s(0)); return isErr(t) ? t : t.length; }
      case "LEFT": case "RIGHT": {
        const t = toText(s(0)); const k = n(1, 1); if (isErr(t)) return t; if (isErr(k)) return k;
        return name === "LEFT" ? t.slice(0, k) : k <= 0 ? "" : t.slice(-k);
      }
      case "MID": { const t = toText(s(0)); const a = n(1), k = n(2); if (isErr(t)) return t; if (isErr(a)) return a; if (isErr(k)) return k; return t.substr(a - 1, k); }
      case "UPPER": { const t = toText(s(0)); return isErr(t) ? t : t.toUpperCase(); }
      case "LOWER": { const t = toText(s(0)); return isErr(t) ? t : t.toLowerCase(); }
      case "TRIM": { const t = toText(s(0)); return isErr(t) ? t : t.trim().replace(/\s+/g, " "); }
    }
    throw new Unsupported(`function ${name}`);
  }
}

function compare(a: Scalar, b: Scalar): number {
  const rank = (v: Scalar) => (typeof v === "number" || v === null ? 0 : typeof v === "string" ? 1 : 2);
  const av = a === null ? (typeof b === "string" ? "" : 0) : a, bv = b === null ? (typeof a === "string" ? "" : 0) : b;
  if (rank(av as Scalar) !== rank(bv as Scalar)) return rank(av as Scalar) - rank(bv as Scalar);
  if (typeof av === "string" && typeof bv === "string") { const x = av.toLowerCase(), y = bv.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
  const x = Number(av), y = Number(bv);
  return x < y ? -1 : x > y ? 1 : 0;
}

function wildcard(pattern: string): RegExp {
  const body = pattern.replace(/~([*?~])|([*?])|([.+^${}()|[\]\\])/g, (_m, esc, wild, special) => esc ? `\\${esc}` : wild ? (wild === "*" ? ".*" : ".") : `\\${special}`);
  return new RegExp(`^${body}$`, "i");
}

/** Excel criteria: ">=10", "<>East", "East", "Sens*", 5. */
function criterion(raw: Scalar): (cell: Scalar) => boolean {
  if (typeof raw === "number" || typeof raw === "boolean") return (cell) => compare(typeof cell === "string" ? cellTextValue(cell) : cell, raw) === 0 && cell !== null;
  const text = raw === null ? "" : isErr(raw) ? raw.error : raw;
  const m = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(text)!;
  const op = m[1] ?? "=";
  const operand = m[2];
  const typed = cellTextValue(operand);
  if (typeof typed === "number") {
    return (cell) => {
      const value = typeof cell === "string" ? cellTextValue(cell) : cell;
      if (typeof value !== "number") return op === "<>";
      const c = value - typed;
      return op === "=" ? c === 0 : op === "<>" ? c !== 0 : op === "<" ? c < 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : c >= 0;
    };
  }
  if (op === "=" || op === "<>") {
    const re = /[*?]/.test(operand) ? wildcard(operand) : null;
    const want = operand.toLowerCase();
    return (cell) => {
      const t = (cell === null ? "" : typeof cell === "boolean" ? (cell ? "TRUE" : "FALSE") : isErr(cell) ? cell.error : typeof cell === "number" ? generalNumber(cell) : cell).toLowerCase();
      const hit = re ? re.test(t) : t === want;
      return op === "=" ? hit : !hit;
    };
  }
  return (cell) => {
    if (typeof cell !== "string") return false;
    const c = cell.toLowerCase() < operand.toLowerCase() ? -1 : cell.toLowerCase() > operand.toLowerCase() ? 1 : 0;
    return op === "<" ? c < 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : c >= 0;
  };
}

function aggregate(kind: "sum" | "avg" | "min" | "max", values: Scalar[], indexes: number[]): Scalar {
  const xs: number[] = [];
  for (const i of indexes) { const v = values[i]; if (isErr(v)) return v; if (typeof v === "number") xs.push(v); }
  if (kind === "sum") return xs.reduce((a, b) => a + b, 0);
  if (kind === "avg") return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : err("#DIV/0!");
  if (!xs.length) return 0;
  return kind === "min" ? Math.min(...xs) : Math.max(...xs);
}

function lookupIndex(needle: Scalar, keys: Scalar[], type: number): number {
  if (type === 0) {
    const test = typeof needle === "string" && /[*?]/.test(needle) ? wildcard(needle) : null;
    return keys.findIndex((key) => (test ? typeof key === "string" && test.test(key) : compare(typeof key === "string" && typeof needle === "number" ? cellTextValue(key) : key, needle) === 0 && key !== null));
  }
  let best = -1;
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] === null) continue;
    const c = compare(keys[i], needle);
    if (type > 0 ? c <= 0 : c >= 0) best = i; else break;
  }
  return best;
}

/**
 * Recomputes every formula cell of the workbook in place: `v` becomes the formatted result (using the cell's number
 * format `nf`) and `n` the numeric result. A formula this engine cannot evaluate keeps its current `v`. Cells whose
 * shown value did not change are left untouched, so a save rewrites only what actually moved.
 */
export function recalculateSheets(sheets: FormulaSheet[]): void {
  if (!sheets.some((sheet) => Object.values(sheet.cells).some((cell) => cell.f !== undefined))) return;
  const book = new Workbook(sheets);
  for (const sheet of sheets) {
    for (const [address, cell] of Object.entries(sheet.cells)) {
      if (cell.f === undefined) continue;
      const result = book.result(sheet.name, address);
      if (result === undefined) continue;
      const shown = displayOf(result, cell.nf);
      if (shown !== cell.v) cell.v = shown;
      if (typeof result === "number") { if (cell.n !== result) cell.n = result; } else if (cell.n !== undefined) delete cell.n;
    }
  }
}

/** Evaluates one formula against a workbook (tests and tools); undefined when unsupported. */
export function evaluateFormula(sheets: FormulaSheet[], sheetName: string, formula: string): string | undefined {
  const book = new Workbook(sheets);
  const node = book.node(formula.replace(/^=/, ""));
  if (!node) return undefined;
  try { return displayOf(book.scalar(book.eval(node, { sheet: sheetName })), undefined); }
  catch (error) { if ((error as Unsupported).mark === UNSUPPORTED) return undefined; throw error; }
}
