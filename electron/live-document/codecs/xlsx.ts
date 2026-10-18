import { cellAddress, parseCellAddress, parseCellRange, renameSheetInFormula, sheetRefName, splitSheetRange, type LiveCell, type LiveChart, type LiveFormat, type LiveSheet } from "../../../shared/live-document";
import { relsPathFor, resolvePartPath, ZipPackage } from "../zip";
import {
  attr, createElement, decodeXml, elements, escapeXmlAttr, escapeXmlText, localName, markDirty, parseXml,
  serializeNode, serializeXml, setAttr, textContent, type XmlDocument, type XmlElement,
} from "../xml-lite";
import { formatNumberCode, generalNumber, recalculateSheets } from "../../../shared/sheet-formula";
import { displayNumber, LiveDocumentCodecError, type LiveDocumentCodec } from "./common";
import { el, hex6, insertOrdered, isEmptyFormat, normColor, removeChildren } from "./format";

const FONT_ORDER = ["b", "i", "strike", "condense", "extend", "outline", "shadow", "u", "vertAlign", "sz", "color", "name", "family", "charset", "scheme"];
const XF_ORDER = ["alignment", "protection", "extLst"];

/*
 * XLSX: cells are patched inside each worksheet part. A changed cell keeps its style index; text is written as an
 * inline string so the shared-string table never has to be rewritten; a formula is written without a cached value and
 * the workbook is marked fullCalcOnLoad so Excel recomputes it. calcChain.xml is dropped on any change (Excel rebuilds
 * it; a stale chain is what makes Excel report a damaged file). A shared-formula master that gets overwritten hands
 * its formula to the next cell of its group first.
 */

const WORKBOOK = "xl/workbook.xml";
const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_WORKSHEET = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet";
const CT_WORKSHEET = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
const REL_DRAWING = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing";
const REL_CHART = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart";
const CT_DRAWING = "application/vnd.openxmlformats-officedocument.drawing+xml";
const CT_CHART = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const NS_XDR = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_C = "http://schemas.openxmlformats.org/drawingml/2006/chart";

/** `rid`: the workbook relationship of the sheet's <sheet> entry (rename and delete find the entry by it). */
interface SheetRef { id: string; name: string; part: string; rid?: string; }

interface WorkbookInfo {
  pkg: ZipPackage;
  workbook: XmlDocument;
  rels: XmlDocument | null;
  sheets: SheetRef[];
  shared: string[];
  formats: Array<{ id: number; code: string }>;
  styles: StyleInfo;
}

interface StyleInfo {
  fonts: LiveFormat[];
  fills: Array<string | undefined>;
  /** Per cellXfs index: font, fill and horizontal alignment. */
  xfs: Array<{ fontId: number; fillId: number; align?: LiveFormat["align"] }>;
}

function readWorkbook(bytes: Uint8Array): WorkbookInfo {
  const pkg = new ZipPackage(bytes);
  const xml = pkg.text(WORKBOOK);
  if (!xml) throw new LiveDocumentCodecError("xlsx_workbook_missing");
  const workbook = parseXml(xml);
  const relsXml = pkg.text(relsPathFor(WORKBOOK));
  const rels = relsXml ? parseXml(relsXml) : null;
  const targets = new Map<string, string>();
  for (const rel of rels ? elements(rels.root) : []) {
    const id = attr(rel, "Id"); const target = attr(rel, "Target");
    if (id && target) targets.set(id, resolvePartPath(WORKBOOK, target));
  }
  const sheetsEl = elements(workbook.root).find((el) => localName(el) === "sheets");
  const sheets: SheetRef[] = [];
  for (const [index, sheet] of (sheetsEl ? elements(sheetsEl) : []).entries()) {
    const rid = attr(sheet, "r:id") ?? Object.entries(parseAttrs(sheet.attrs)).find(([key]) => key.endsWith(":id"))?.[1];
    const part = rid ? targets.get(rid) : undefined;
    if (!part || !pkg.has(part)) continue;
    sheets.push({ id: `sheet${index + 1}`, name: attr(sheet, "name") ?? `Sheet${index + 1}`, part, ...(rid ? { rid } : {}) });
  }
  if (!sheets.length) throw new LiveDocumentCodecError("xlsx_no_sheets");
  return { pkg, workbook, rels, sheets, shared: readShared(pkg), formats: readFormats(pkg), styles: readStyleInfo(pkg) };
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of raw.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[match[1]] = decodeXml(match[3] ?? match[4] ?? "");
  return out;
}

function richText(element: XmlElement): string {
  let text = "";
  for (const child of elements(element)) {
    const name = localName(child);
    if (name === "t") text += child.children.map((node) => node.type === "text" ? decodeXml(node.src.slice(node.start, node.end)) : "").join("");
    else if (name === "r") text += richText(child);
  }
  return text;
}

function readShared(pkg: ZipPackage): string[] {
  const xml = pkg.text("xl/sharedStrings.xml");
  if (!xml) return [];
  return elements(parseXml(xml).root).filter((el) => localName(el) === "si").map(richText);
}

function readFormats(pkg: ZipPackage): Array<{ id: number; code: string }> {
  const xml = pkg.text("xl/styles.xml");
  if (!xml) return [];
  const root = parseXml(xml).root;
  const custom = new Map<number, string>();
  const numFmts = elements(root).find((el) => localName(el) === "numFmts");
  for (const fmt of numFmts ? elements(numFmts) : []) custom.set(Number(attr(fmt, "numFmtId")), attr(fmt, "formatCode") ?? "");
  const cellXfs = elements(root).find((el) => localName(el) === "cellXfs");
  return (cellXfs ? elements(cellXfs) : []).map((xf) => {
    const id = Number(attr(xf, "numFmtId") ?? 0);
    return { id, code: custom.get(id) ?? "" };
  });
}

const ALIGN_IN: Record<string, LiveFormat["align"]> = { left: "left", center: "center", centerContinuous: "center", right: "right", justify: "justify", distributed: "justify" };

function fontFormat(font: XmlElement): LiveFormat {
  const format: LiveFormat = {};
  const child = (name: string) => elements(font).find((node) => localName(node) === name);
  const on = (name: string) => { const node = child(name); return !!node && !["0", "false"].includes(attr(node, "val") ?? "1"); };
  if (on("b")) format.bold = true;
  if (on("i")) format.italic = true;
  const u = child("u");
  if (u && (attr(u, "val") ?? "single") !== "none") format.underline = true;
  const sz = Number(attr(child("sz") ?? font, "val"));
  if (Number.isFinite(sz) && sz > 0) format.size = sz;
  const color = normColor(attr(child("color") ?? font, "rgb"));
  if (color && color !== "#000000") format.color = color;
  return format;
}

function readStyleInfo(pkg: ZipPackage): StyleInfo {
  const xml = pkg.text("xl/styles.xml");
  if (!xml) return { fonts: [], fills: [], xfs: [] };
  const root = parseXml(xml).root;
  const fontsEl = elements(root).find((node) => localName(node) === "fonts");
  const fonts = (fontsEl ? elements(fontsEl) : []).map(fontFormat);
  const fillsEl = elements(root).find((node) => localName(node) === "fills");
  const fills = (fillsEl ? elements(fillsEl) : []).map((fill) => {
    const pattern = elements(fill).find((node) => localName(node) === "patternFill");
    if (!pattern || attr(pattern, "patternType") !== "solid") return undefined;
    const fg = elements(pattern).find((node) => localName(node) === "fgColor");
    return normColor(fg ? attr(fg, "rgb") : undefined);
  });
  const cellXfs = elements(root).find((node) => localName(node) === "cellXfs");
  const xfs = (cellXfs ? elements(cellXfs) : []).map((xf) => {
    const alignment = elements(xf).find((node) => localName(node) === "alignment");
    const align = alignment ? ALIGN_IN[attr(alignment, "horizontal") ?? ""] : undefined;
    return { fontId: Number(attr(xf, "fontId") ?? 0) || 0, fillId: Number(attr(xf, "fillId") ?? 0) || 0, ...(align ? { align } : {}) };
  });
  return { fonts, fills, xfs };
}

/** A cell's visible format relative to the workbook default font (font 0), so plain cells carry no format. */
function cellFormat(styles: StyleInfo, styleIndex: number): LiveFormat | undefined {
  const xf = styles.xfs[styleIndex];
  if (!xf) return undefined;
  const base = styles.fonts[0] ?? {};
  const font = styles.fonts[xf.fontId] ?? {};
  const format: LiveFormat = { ...font };
  if (format.size === base.size) delete format.size;
  if (xf.align) format.align = xf.align;
  const fill = styles.fills[xf.fillId];
  if (fill) format.fill = fill;
  return isEmptyFormat(format) ? undefined : format;
}

const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/**
 * The cell's number format as a normalised code the shared formula engine formats with (percent, date, thousands,
 * fixed decimals); undefined for General. Reading and recalculating use the same code, so an unchanged value reads
 * back identical and is not rewritten.
 */
function numberFormatCode(format: { id: number; code: string } | undefined): string | undefined {
  if (!format) return undefined;
  const code = format.code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
  if (format.id === 9 || format.id === 10 || code.includes("%")) {
    const decimals = format.id === 10 ? 2 : (/\.(0+)%/.exec(code)?.[1].length ?? 0);
    return `0${decimals ? `.${"0".repeat(decimals)}` : ""}%`;
  }
  if (DATE_IDS.has(format.id) || (/[yd]/i.test(code) && !/[#0]/.test(code))) return /h/i.test(code) || format.id === 22 ? "yyyy-mm-dd hh:mm" : "yyyy-mm-dd";
  if (format.id === 3 || format.id === 4 || code.includes("#,##0")) {
    const decimals = format.id === 4 ? 2 : (/#,##0\.(0+)/.exec(code)?.[1].length ?? 0);
    return `#,##0${decimals ? `.${"0".repeat(decimals)}` : ""}`;
  }
  if (format.id === 2 || /^0\.(0+)$/.test(code.trim())) return format.id === 2 ? "0.00" : code.trim();
  return undefined;
}

function formatNumber(raw: string, nf: string | undefined): string {
  const value = Number(raw);
  if (!Number.isFinite(value)) return displayNumber(raw);
  return nf ? formatNumberCode(value, nf) : generalNumber(value);
}

/** Cells of a worksheet, keyed by address, with their element (for patching). */
function readCells(doc: XmlDocument, info: Pick<WorkbookInfo, "shared" | "formats"> & { styles?: StyleInfo }): Map<string, { cell: LiveCell; element: XmlElement; row: XmlElement }> {
  const out = new Map<string, { cell: LiveCell; element: XmlElement; row: XmlElement }>();
  const sheetData = elements(doc.root).find((el) => localName(el) === "sheetData");
  if (!sheetData) return out;
  let rowNumber = 0;
  // Shared formulas: followers carry only `si`; their formula is the master's shifted by the offset.
  const masters = new Map<string, { formula: string; row: number; col: number }>();
  for (const row of elements(sheetData).filter((el) => localName(el) === "row")) {
    rowNumber = Number(attr(row, "r") ?? rowNumber + 1) || rowNumber + 1;
    let col = 0;
    for (const c of elements(row).filter((el) => localName(el) === "c")) {
      const ref = attr(c, "r");
      const parsed = ref ? parseCellAddress(ref) : null;
      col = parsed ? parsed.col : col + 1;
      const address = cellAddress(col, rowNumber);
      const type = attr(c, "t") ?? "n";
      const f = elements(c).find((el) => localName(el) === "f");
      const v = elements(c).find((el) => localName(el) === "v");
      const is = elements(c).find((el) => localName(el) === "is");
      const rawV = v ? textContent(v) : "";
      let display = "";
      if (type === "s") display = info.shared[Number(rawV)] ?? "";
      else if (type === "inlineStr") display = is ? richText(is) : "";
      else if (type === "b") display = rawV === "1" ? "TRUE" : rawV === "0" ? "FALSE" : rawV;
      else if (type === "str" || type === "e") display = rawV;
      const nf = numberFormatCode(info.formats[Number(attr(c, "s") ?? 0)]);
      const numeric = (type === "n" || type === "d") && rawV !== "" && Number.isFinite(Number(rawV)) ? Number(rawV) : undefined;
      if (type !== "s" && type !== "inlineStr" && type !== "b" && type !== "str" && type !== "e" && rawV !== "") display = type === "n" ? formatNumber(rawV, nf) : rawV;
      let formula = f ? textContent(f) : "";
      if (f && attr(f, "t") === "shared") {
        const si = attr(f, "si") ?? "";
        if (formula) masters.set(si, { formula, row: rowNumber, col });
        else {
          const master = masters.get(si);
          if (master) formula = shiftFormula(master.formula, rowNumber - master.row, col - master.col);
        }
      }
      if (display === "" && !formula) continue;
      const format = info.styles ? cellFormat(info.styles, Number(attr(c, "s") ?? 0) || 0) : undefined;
      out.set(address, { cell: { v: display, ...(formula ? { f: formula } : {}), ...(numeric !== undefined ? { n: numeric } : {}), ...(nf ? { nf } : {}), ...(format ? { format } : {}) }, element: c, row });
    }
  }
  return out;
}

function sheetModel(info: WorkbookInfo): LiveSheet[] {
  let chartNo = 0;
  return info.sheets.map((sheet) => {
    const doc = parseXml(info.pkg.text(sheet.part)!);
    const cells: Record<string, LiveCell> = {};
    for (const [address, entry] of readCells(doc, info)) cells[address] = entry.cell;
    const charts = readFileCharts(info.pkg, sheet.part, doc).map((chart) => ({ ...chart, id: `file-chart-${++chartNo}` }));
    return { id: sheet.id, name: sheet.name, cells, ...(charts.length ? { charts } : {}) };
  });
}

/** Elements under `parent` (any depth) whose local name is `name`, prefix-agnostic. */
function deep(parent: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of elements(parent)) {
    if (localName(child) === name) out.push(child);
    out.push(...deep(child, name));
  }
  return out;
}

function idAttr(element: XmlElement): string | undefined {
  return attr(element, "r:id") ?? Object.entries(parseAttrs(element.attrs)).find(([key]) => key.endsWith(":id"))?.[1];
}

function relTargets(pkg: ZipPackage, part: string): Map<string, string> {
  const out = new Map<string, string>();
  const xml = pkg.text(relsPathFor(part));
  for (const rel of xml ? elements(parseXml(xml).root) : []) {
    const id = attr(rel, "Id"); const target = attr(rel, "Target");
    if (id && target && attr(rel, "TargetMode") !== "External") out.set(id, resolvePartPath(part, target));
  }
  return out;
}

/** Charts already in the file, listed (kind, title, ranges, frame) so a re-opened workbook can be checked. */
function readFileCharts(pkg: ZipPackage, sheetPart: string, doc: XmlDocument): Omit<LiveChart, "id">[] {
  const drawing = elements(doc.root).find((el) => localName(el) === "drawing");
  const drawingPart = drawing ? relTargets(pkg, sheetPart).get(idAttr(drawing) ?? "") : undefined;
  if (!drawingPart || !pkg.has(drawingPart)) return [];
  const out: Omit<LiveChart, "id">[] = [];
  try {
    const drawingDoc = parseXml(pkg.text(drawingPart)!);
    const targets = relTargets(pkg, drawingPart);
    for (const anchor of elements(drawingDoc.root)) {
      const chartRef = deep(anchor, "chart").find((el) => idAttr(el));
      const chartPart = chartRef ? targets.get(idAttr(chartRef)!) : undefined;
      if (!chartPart || !pkg.has(chartPart)) continue;
      const from = elements(anchor).find((el) => localName(el) === "from");
      const at = (name: string) => Number(textContent(elements(from ?? anchor).find((el) => localName(el) === name) ?? anchor)) || 0;
      const chartDoc = parseXml(pkg.text(chartPart)!);
      const plot = deep(chartDoc.root, "plotArea")[0];
      const kind = plot ? elements(plot).find((el) => /Chart$/.test(localName(el))) : undefined;
      const family = kind ? localName(kind) : "";
      const type: LiveChart["type"] = /^bar/.test(family) ? "bar" : /^line/.test(family) ? "line" : /^(pie|doughnut|ofPie)/.test(family) ? "pie" : "other";
      const chartEl = elements(chartDoc.root).find((el) => localName(el) === "chart");
      const titleEl = chartEl ? elements(chartEl).find((el) => localName(el) === "title") : undefined;
      const title = titleEl ? deep(titleEl, "t").map((t) => textContent(t)).join("").trim() : "";
      const series = kind ? elements(kind).filter((el) => localName(el) === "ser") : [];
      const ref = (ser: XmlElement | undefined, part: string) => {
        const holder = ser ? elements(ser).find((el) => localName(el) === part) : undefined;
        const f = holder ? deep(holder, "f")[0] : undefined;
        return f ? textContent(f).replace(/\$/g, "") : "";
      };
      out.push({ type, ...(title ? { title } : {}), categories: ref(series[0], "cat"), values: series.map((ser) => ref(ser, "val")).filter(Boolean),
        anchor: cellAddress(at("col") + 1, at("row") + 1), fromFile: true });
    }
  } catch { return out; }
  return out;
}

const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function cellMarkup(address: string, style: string | undefined, cell: LiveCell): string {
  const s = style !== undefined ? ` s="${escapeXmlAttr(style)}"` : "";
  if (cell.f === undefined && cell.v === "") return `<c r="${address}"${s}/>`;
  if (cell.f !== undefined) {
    // The computed result is written as the cached value, so viewers that do not recalculate still show it.
    const f = `<f>${escapeXmlText(cell.f)}</f>`;
    if (cell.n !== undefined && Number.isFinite(cell.n)) return `<c r="${address}"${s}>${f}<v>${cell.n}</v></c>`;
    if (cell.v === "") return `<c r="${address}"${s}>${f}</c>`;
    if (cell.v === "TRUE" || cell.v === "FALSE") return `<c r="${address}"${s} t="b">${f}<v>${cell.v === "TRUE" ? 1 : 0}</v></c>`;
    if (/^#(?:DIV\/0!|N\/A|VALUE!|REF!|NAME\?|NUM!|NULL!)$/.test(cell.v)) return `<c r="${address}"${s} t="e">${f}<v>${escapeXmlText(cell.v)}</v></c>`;
    return `<c r="${address}"${s} t="str">${f}<v>${escapeXmlText(cell.v)}</v></c>`;
  }
  // A formatted number or date (45,000 / 2026-07-09) keeps the number behind it; writing the display would make it text.
  if (cell.n !== undefined && Number.isFinite(cell.n) && !NUMBER_RE.test(cell.v.trim())) return `<c r="${address}"${s}><v>${cell.n}</v></c>`;
  if (NUMBER_RE.test(cell.v.trim())) return `<c r="${address}"${s}><v>${cell.v.trim()}</v></c>`;
  if (cell.v === "TRUE" || cell.v === "FALSE") return `<c r="${address}"${s} t="b"><v>${cell.v === "TRUE" ? 1 : 0}</v></c>`;
  return `<c r="${address}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXmlText(cell.v)}</t></is></c>`;
}

/** Shifts relative A1 references of a formula by (rows, cols); used to hand a shared formula to another cell. */
export function shiftFormula(formula: string, rows: number, cols: number): string {
  let out = "";
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i];
    if (ch === "\"") {
      const end = formula.indexOf("\"", i + 1);
      const stop = end < 0 ? formula.length : end + 1;
      out += formula.slice(i, stop);
      i = stop;
      continue;
    }
    const prev = i > 0 ? formula[i - 1] : "";
    const boundary = !/[A-Za-z0-9_.$]/.test(prev);
    const rest = formula.slice(i);
    const colOf = (name: string) => parseCellAddress(`${name}1`)!.col;
    const colName = (col: number) => cellAddress(col, 1).replace(/\d+$/, "");
    const cell = boundary ? /^(\$?)([A-Z]{1,3})(\$?)([1-9][0-9]{0,6})(?![A-Za-z0-9_(])/.exec(rest) : null;
    if (cell) {
      const [, colAbs, name, rowAbs, rowNum] = cell;
      const col = colAbs ? colOf(name) : colOf(name) + cols;
      const row = rowAbs ? Number(rowNum) : Number(rowNum) + rows;
      out += col >= 1 && row >= 1 ? `${colAbs}${colName(col)}${rowAbs}${row}` : "#REF!";
      i += cell[0].length;
      continue;
    }
    const colRange = boundary ? /^(\$?)([A-Z]{1,3}):(\$?)([A-Z]{1,3})(?![A-Za-z0-9_(])/.exec(rest) : null;
    if (colRange) {
      const [, a1, n1, a2, n2] = colRange;
      const c1 = a1 ? colOf(n1) : colOf(n1) + cols; const c2 = a2 ? colOf(n2) : colOf(n2) + cols;
      out += c1 >= 1 && c2 >= 1 ? `${a1}${colName(c1)}:${a2}${colName(c2)}` : "#REF!";
      i += colRange[0].length;
      continue;
    }
    const rowRange = boundary ? /^(\$?)([1-9][0-9]{0,6}):(\$?)([1-9][0-9]{0,6})(?![0-9.])/.exec(rest) : null;
    if (rowRange) {
      const [, a1, r1, a2, r2] = rowRange;
      const n1 = a1 ? Number(r1) : Number(r1) + rows; const n2 = a2 ? Number(r2) : Number(r2) + rows;
      out += n1 >= 1 && n2 >= 1 ? `${a1}${n1}:${a2}${n2}` : "#REF!";
      i += rowRange[0].length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function handOffSharedMaster(doc: XmlDocument, master: XmlElement, masterAddress: string): void {
  const f = elements(master).find((el) => localName(el) === "f");
  if (!f || attr(f, "t") !== "shared" || !attr(f, "ref")) return;
  const si = attr(f, "si");
  const formula = textContent(f);
  const sheetData = elements(doc.root).find((el) => localName(el) === "sheetData")!;
  const from = parseCellAddress(masterAddress)!;
  for (const row of elements(sheetData)) {
    for (const c of elements(row)) {
      if (c === master) continue;
      const follower = elements(c).find((el) => localName(el) === "f");
      if (!follower || attr(follower, "t") !== "shared" || attr(follower, "si") !== si) continue;
      const address = attr(c, "r");
      const to = address ? parseCellAddress(address) : null;
      if (!to) continue;
      const end = (attr(f, "ref") ?? "").split(":")[1] ?? address!;
      const replacement = createElement(`<f t="shared" ref="${address}:${end}" si="${si}">${escapeXmlText(shiftFormula(formula, to.row - from.row, to.col - from.col))}</f>`);
      c.children.splice(c.children.indexOf(follower), 1, replacement);
      markDirty(c, row, sheetData, doc.root);
      return;
    }
  }
}

/** Derives cellXfs entries (and fonts) for formats, appending to styles.xml; one entry per (base style, format). */
class StyleWriter {
  private doc: XmlDocument | null;
  private readonly cache = new Map<string, string>();
  changed = false;
  constructor(private readonly pkg: ZipPackage) {
    const xml = pkg.text("xl/styles.xml");
    this.doc = xml ? parseXml(xml) : null;
  }
  /** `numberFormat`: a code sets the cell's number format, null returns it to General, undefined leaves it. */
  styleFor(base: string | undefined, format: LiveFormat | undefined, removed: ReadonlySet<string> = new Set(), numberFormat?: string | null): string | undefined {
    if ((!format || isEmptyFormat(format)) && removed.size && this.doc) format = {};
    const formatChange = !!format && (!isEmptyFormat(format) || removed.size > 0);
    if ((!formatChange && numberFormat === undefined) || !this.doc) return base;
    const key = `${base ?? "0"}|${JSON.stringify(format ?? null)}|${[...removed].join(",")}|${numberFormat === undefined ? "" : numberFormat ?? "General"}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const root = this.doc.root;
    const fontsEl = elements(root).find((node) => localName(node) === "fonts");
    const xfsEl = elements(root).find((node) => localName(node) === "cellXfs");
    if (!fontsEl || !xfsEl) return base;
    const xfs = elements(xfsEl);
    const baseXf = xfs[Number(base ?? 0)] ?? xfs[0];
    if (!formatChange || !format) {
      // Number format only: the cell keeps its font, fill and alignment.
      const xf = el(serializeNode(baseXf));
      setAttr(xf, "numFmtId", String(numberFormat ? this.numFmtId(numberFormat) : 0));
      setAttr(xf, "applyNumberFormat", "1");
      xfsEl.children.push(xf);
      setAttr(xfsEl, "count", String(elements(xfsEl).length));
      markDirty(xfsEl, root);
      const index = String(elements(xfsEl).length - 1);
      this.cache.set(key, index);
      this.changed = true;
      return index;
    }
    const fonts = elements(fontsEl);
    const font = el(serializeNode(fonts[Number(attr(baseXf, "fontId") ?? 0)] ?? fonts[0]));
    const toggle = (name: string, value: boolean | undefined, markup: string) => {
      if (value === undefined) return;
      removeChildren(font, name);
      if (value) insertOrdered(font, el(markup), FONT_ORDER);
    };
    toggle("b", format.bold ?? (removed.has("bold") ? false : undefined), "<b/>");
    toggle("i", format.italic ?? (removed.has("italic") ? false : undefined), "<i/>");
    toggle("u", format.underline ?? (removed.has("underline") ? false : undefined), "<u/>");
    if (removed.has("color")) removeChildren(font, "color");
    if (format.size !== undefined) { removeChildren(font, "sz"); insertOrdered(font, el(`<sz val="${format.size}"/>`), FONT_ORDER); }
    if (format.color !== undefined) { removeChildren(font, "color"); insertOrdered(font, el(`<color rgb="FF${hex6(format.color)}"/>`), FONT_ORDER); }
    fontsEl.children.push(font);
    setAttr(fontsEl, "count", String(elements(fontsEl).length));
    const xf = el(serializeNode(baseXf));
    setAttr(xf, "fontId", String(elements(fontsEl).length - 1));
    setAttr(xf, "applyFont", "1");
    if (numberFormat !== undefined) {
      setAttr(xf, "numFmtId", String(numberFormat ? this.numFmtId(numberFormat) : 0));
      setAttr(xf, "applyNumberFormat", "1");
    }
    if (removed.has("align")) { const existing = elements(xf).find((node) => localName(node) === "alignment"); if (existing) setAttr(existing, "horizontal", null); }
    if (format.align !== undefined) {
      const existing = elements(xf).find((node) => localName(node) === "alignment");
      if (existing) setAttr(existing, "horizontal", format.align);
      else insertOrdered(xf, el(`<alignment horizontal="${format.align}"/>`), XF_ORDER);
      setAttr(xf, "applyAlignment", "1");
    }
    if (format.fill !== undefined || removed.has("fill")) {
      let fillsEl = elements(root).find((node) => localName(node) === "fills");
      if (format.fill) {
        if (!fillsEl) { fillsEl = el('<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'); root.children.splice(root.children.indexOf(fontsEl) + 1, 0, fillsEl); }
        fillsEl.children.push(el(`<fill><patternFill patternType="solid"><fgColor rgb="FF${hex6(format.fill)}"/><bgColor indexed="64"/></patternFill></fill>`));
        setAttr(fillsEl, "count", String(elements(fillsEl).length));
        markDirty(fillsEl);
        setAttr(xf, "fillId", String(elements(fillsEl).length - 1));
      } else setAttr(xf, "fillId", "0");
      setAttr(xf, "applyFill", "1");
    }
    xfsEl.children.push(xf);
    setAttr(xfsEl, "count", String(elements(xfsEl).length));
    markDirty(fontsEl, xfsEl, root);
    const index = String(elements(xfsEl).length - 1);
    this.cache.set(key, index);
    this.changed = true;
    return index;
  }
  /** Built-in id for a standard code, else the custom <numFmt> with that code (added from 164 when new). */
  private numFmtId(code: string): number {
    const builtin: Record<string, number> = { "0": 1, "0.00": 2, "#,##0": 3, "#,##0.00": 4, "0%": 9, "0.00%": 10, "0.00E+00": 11, "@": 49 };
    if (builtin[code] !== undefined) return builtin[code];
    const root = this.doc!.root;
    let numFmts = elements(root).find((node) => localName(node) === "numFmts");
    if (!numFmts) {
      const prefix = root.name.includes(":") ? `${root.name.split(":")[0]}:` : "";
      numFmts = createElement(`<${prefix}numFmts count="0"></${prefix}numFmts>`);
      // numFmts is the first child of styleSheet.
      const first = root.children.findIndex((node) => node.type === "el");
      root.children.splice(first < 0 ? root.children.length : first, 0, numFmts);
    }
    const existing = elements(numFmts).find((fmt) => attr(fmt, "formatCode") === code);
    if (existing) return Number(attr(existing, "numFmtId"));
    const id = Math.max(163, ...elements(numFmts).map((fmt) => Number(attr(fmt, "numFmtId")) || 0)) + 1;
    const prefix = numFmts.name.includes(":") ? `${numFmts.name.split(":")[0]}:` : "";
    numFmts.children.push(createElement(`<${prefix}numFmt numFmtId="${id}" formatCode="${escapeXmlAttr(code)}"/>`));
    setAttr(numFmts, "count", String(elements(numFmts).length));
    markDirty(numFmts, root);
    return id;
  }
  flush(): void {
    if (this.doc && this.changed) this.pkg.setText("xl/styles.xml", serializeXml(this.doc));
  }
}

function patchSheet(doc: XmlDocument, changes: Map<string, LiveCell | null>, info: Pick<WorkbookInfo, "shared" | "formats"> & { styles?: StyleInfo }, styleWriter?: StyleWriter, priorFormats?: Map<string, LiveFormat | undefined>, priorNumberFormats?: Map<string, string | undefined>): void {
  const root = doc.root;
  let sheetData = elements(root).find((el) => localName(el) === "sheetData");
  if (!sheetData) {
    sheetData = createElement("<sheetData/>");
    root.children.push(sheetData);
  }
  const existing = readCells(doc, info);
  for (const [address, cell] of changes) {
    const { row: rowNumber, col } = parseCellAddress(address)!;
    const current = existing.get(address);
    let styleIndex: string | undefined;
    let rowEl: XmlElement | undefined;
    let cellEl: XmlElement | undefined;
    for (const row of elements(sheetData).filter((el) => localName(el) === "row")) {
      if (Number(attr(row, "r")) === rowNumber) { rowEl = row; break; }
    }
    if (rowEl) {
      for (const c of elements(rowEl).filter((el) => localName(el) === "c")) {
        if ((attr(c, "r") ?? "").toUpperCase() === address) { cellEl = c; break; }
      }
    }
    if (current && !cellEl) cellEl = current.element;
    if (cellEl) {
      styleIndex = attr(cellEl, "s");
      handOffSharedMaster(doc, cellEl, address);
    }
    if (!cell) {
      if (cellEl && rowEl) { rowEl.children.splice(rowEl.children.indexOf(cellEl), 1); markDirty(rowEl); }
      continue;
    }
    if (!rowEl) {
      rowEl = createElement(`<row r="${rowNumber}"/>`);
      const rows = elements(sheetData).filter((el) => localName(el) === "row");
      const after = rows.find((row) => Number(attr(row, "r")) > rowNumber);
      sheetData.children.splice(after ? sheetData.children.indexOf(after) : sheetData.children.length, 0, rowEl);
    }
    // A format change derives a new style from the cell's current one; an unchanged format keeps the style index.
    const formatChanged = JSON.stringify(priorFormats?.get(address) ?? null) !== JSON.stringify(cell.format ?? null);
    const numberFormatChanged = !!priorNumberFormats && (priorNumberFormats.get(address) ?? null) !== (cell.nf ?? null);
    if ((formatChanged || numberFormatChanged) && styleWriter) {
      const prior = priorFormats?.get(address) ?? {};
      const removed = formatChanged ? new Set(Object.keys(prior).filter((key) => (cell.format as Record<string, unknown> | undefined)?.[key] === undefined)) : new Set<string>();
      styleIndex = styleWriter.styleFor(styleIndex, formatChanged ? cell.format : undefined, removed, numberFormatChanged ? cell.nf ?? null : undefined);
    }
    const fresh = createElement(cellMarkup(address, styleIndex, cell));
    if (cellEl && rowEl.children.includes(cellEl)) rowEl.children.splice(rowEl.children.indexOf(cellEl), 1, fresh);
    else {
      const cells = elements(rowEl).filter((el) => localName(el) === "c");
      const after = cells.find((c) => (parseCellAddress(attr(c, "r") ?? "")?.col ?? 0) > col);
      rowEl.children.splice(after ? rowEl.children.indexOf(after) : rowEl.children.length, 0, fresh);
    }
    if (attr(rowEl, "spans") !== undefined) setAttr(rowEl, "spans", null);
    markDirty(rowEl);
  }
  markDirty(sheetData, root);
}

function dropCalcChain(info: WorkbookInfo): void {
  if (!info.pkg.has("xl/calcChain.xml")) return;
  info.pkg.remove("xl/calcChain.xml");
  if (info.rels) {
    info.rels.root.children = info.rels.root.children.filter((node) => node.type !== "el" || !(attr(node, "Type") ?? "").endsWith("/calcChain"));
    markDirty(info.rels.root);
  }
  const ct = info.pkg.text("[Content_Types].xml");
  if (ct) info.pkg.setText("[Content_Types].xml", ct.replace(/<Override[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/g, ""));
}

function ensureFullCalc(workbook: XmlDocument): void {
  const root = workbook.root;
  const calcPr = elements(root).find((el) => localName(el) === "calcPr");
  if (calcPr) setAttr(calcPr, "fullCalcOnLoad", "1");
  else {
    // calcPr belongs after sheets/definedNames and before oleSize/customWorkbookViews/... — insert after the last of those.
    const order = ["fileVersion", "fileSharing", "workbookPr", "workbookProtection", "bookViews", "sheets", "functionGroups", "externalReferences", "definedNames"];
    const kids = elements(root);
    const anchor = [...kids].reverse().find((el) => order.includes(localName(el)));
    const prefix = root.name.includes(":") ? `${root.name.split(":")[0]}:` : "";
    const node = createElement(`<${prefix}calcPr fullCalcOnLoad="1"/>`);
    root.children.splice(anchor ? root.children.indexOf(anchor) + 1 : root.children.length, 0, node);
  }
  markDirty(root);
}

function addSheet(info: WorkbookInfo, name: string): SheetRef {
  const used = new Set(info.pkg.names());
  let n = info.sheets.length + 1;
  while (used.has(`xl/worksheets/sheet${n}.xml`)) n++;
  const part = `xl/worksheets/sheet${n}.xml`;
  info.pkg.setText(part, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheetData/></worksheet>`);
  if (!info.rels) throw new LiveDocumentCodecError("xlsx_rels_missing");
  const relIds = new Set(elements(info.rels.root).map((rel) => attr(rel, "Id")));
  let r = 1;
  while (relIds.has(`rId${r}`)) r++;
  info.rels.root.children.push(createElement(`<Relationship Id="rId${r}" Type="${REL_WORKSHEET}" Target="worksheets/sheet${n}.xml"/>`));
  markDirty(info.rels.root);
  const sheetsEl = elements(info.workbook.root).find((el) => localName(el) === "sheets")!;
  const sheetIds = elements(sheetsEl).map((sheet) => Number(attr(sheet, "sheetId") ?? 0));
  const prefix = sheetsEl.name.includes(":") ? `${sheetsEl.name.split(":")[0]}:` : "";
  // Some writers (openpyxl) declare xmlns:r on each <sheet>, not on the root: never rely on an inherited prefix.
  const declareR = /\sxmlns:r=/.test(info.workbook.root.attrs) ? "" : ` xmlns:r="${NS_REL}"`;
  sheetsEl.children.push(createElement(`<${prefix}sheet${declareR} name="${escapeXmlAttr(name)}" sheetId="${Math.max(0, ...sheetIds) + 1}" r:id="rId${r}"/>`));
  markDirty(sheetsEl, info.workbook.root);
  const ct = info.pkg.text("[Content_Types].xml") ?? "";
  info.pkg.setText("[Content_Types].xml", ct.replace("</Types>", `<Override PartName="/${part}" ContentType="${CT_WORKSHEET}"/></Types>`));
  const ref: SheetRef = { id: "", name, part };
  info.sheets.push(ref);
  return ref;
}

function sheetEntry(info: WorkbookInfo, ref: SheetRef): XmlElement | undefined {
  const sheetsEl = elements(info.workbook.root).find((el) => localName(el) === "sheets");
  return sheetsEl && ref.rid ? elements(sheetsEl).find((entry) => idAttr(entry) === ref.rid) : undefined;
}

function renameSheetEntry(info: WorkbookInfo, ref: SheetRef, name: string): void {
  const sheetsEl = elements(info.workbook.root).find((el) => localName(el) === "sheets")!;
  const entry = sheetEntry(info, ref);
  if (entry) { setAttr(entry, "name", name); markDirty(entry, sheetsEl, info.workbook.root); }
  const defined = elements(info.workbook.root).find((el) => localName(el) === "definedNames");
  for (const definedName of defined ? elements(defined) : []) {
    const text = textContent(definedName);
    const renamed = renameSheetInFormula(text, ref.name, name);
    if (renamed === text) continue;
    const fresh = createElement(serializeNode(definedName).replace(/>[\s\S]*<\//, `>${escapeXmlText(renamed)}</`));
    defined!.children.splice(defined!.children.indexOf(definedName), 1, fresh);
    markDirty(defined!, info.workbook.root);
  }
  ref.name = name;
}

function removeSheet(info: WorkbookInfo, ref: SheetRef): void {
  const root = info.workbook.root;
  const sheetsEl = elements(root).find((el) => localName(el) === "sheets")!;
  const entry = sheetEntry(info, ref);
  const position = entry ? elements(sheetsEl).indexOf(entry) : -1;
  if (entry) { sheetsEl.children.splice(sheetsEl.children.indexOf(entry), 1); markDirty(sheetsEl, root); }
  if (info.rels && ref.rid) {
    info.rels.root.children = info.rels.root.children.filter((node) => node.type !== "el" || attr(node, "Id") !== ref.rid);
    markDirty(info.rels.root);
  }
  // Sheet-scoped names belong to a sheet position: the deleted sheet's go, later ones move up one.
  const defined = elements(root).find((el) => localName(el) === "definedNames");
  if (defined && position >= 0) {
    for (const definedName of [...elements(defined)]) {
      const local = attr(definedName, "localSheetId");
      if (local === undefined) continue;
      if (Number(local) === position) defined.children.splice(defined.children.indexOf(definedName), 1);
      else if (Number(local) > position) setAttr(definedName, "localSheetId", String(Number(local) - 1));
    }
    if (!elements(defined).length) root.children.splice(root.children.indexOf(defined), 1);
    markDirty(defined, root);
  }
  const remaining = elements(sheetsEl).length;
  const views = elements(root).find((el) => localName(el) === "bookViews");
  for (const view of views ? elements(views) : []) {
    for (const key of ["activeTab", "firstSheet"]) {
      const value = attr(view, key);
      if (value !== undefined && Number(value) >= remaining) setAttr(view, key, "0");
    }
    markDirty(view, views!, root);
  }
  info.pkg.remove(ref.part);
  if (info.pkg.has(relsPathFor(ref.part))) info.pkg.remove(relsPathFor(ref.part));
  const ct = info.pkg.text("[Content_Types].xml");
  if (ct) info.pkg.setText("[Content_Types].xml", ct.replace(new RegExp(`<Override[^>]*PartName="/${ref.part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*/>`), ""));
  info.sheets.splice(info.sheets.indexOf(ref), 1);
}

/** The rels document of a part, created empty when the part has none yet; `save` writes it back. */
function relsDoc(pkg: ZipPackage, part: string): { doc: XmlDocument; add(type: string, target: string): string; save(): void } {
  const path = relsPathFor(part);
  const doc = parseXml(pkg.text(path) ?? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_PKG_REL}"></Relationships>`);
  return {
    doc,
    add(type, target) {
      const ids = new Set(elements(doc.root).map((rel) => attr(rel, "Id")));
      let n = 1;
      while (ids.has(`rId${n}`)) n++;
      doc.root.children.push(createElement(`<Relationship Id="rId${n}" Type="${type}" Target="${escapeXmlAttr(target)}"/>`));
      markDirty(doc.root);
      return `rId${n}`;
    },
    save() { pkg.setText(path, serializeXml(doc)); },
  };
}

function freePart(pkg: ZipPackage, pattern: (n: number) => string): string {
  let n = 1;
  while (pkg.has(pattern(n))) n++;
  return pattern(n);
}

function addContentType(pkg: ZipPackage, part: string, type: string): void {
  const ct = pkg.text("[Content_Types].xml") ?? "";
  if (ct.includes(`PartName="/${part}"`)) return;
  pkg.setText("[Content_Types].xml", ct.replace("</Types>", `<Override PartName="/${part}" ContentType="${type}"/></Types>`));
}

/** Worksheet children that come before <drawing> (CT_Worksheet order); it goes right after the last one present. */
const BEFORE_DRAWING = ["sheetPr", "dimension", "sheetViews", "sheetFormatPr", "cols", "sheetData", "sheetCalcPr", "sheetProtection", "protectedRanges",
  "scenarios", "autoFilter", "sortState", "dataConsolidate", "customSheetViews", "mergeCells", "phoneticPr", "conditionalFormatting",
  "dataValidations", "hyperlinks", "printOptions", "pageMargins", "pageSetup", "headerFooter", "rowBreaks", "colBreaks", "customProperties",
  "cellWatches", "ignoredErrors", "smartTags"];

/** Cells of a one-row or one-column range on a sheet of the final model, with the reference written into the chart. */
function chartRange(ref: string, chartSheet: LiveSheet, sheets: LiveSheet[]): { formula: string; labels: string[]; numbers: Array<number | null> } {
  const split = splitSheetRange(ref)!;
  const sheet = split.sheet === undefined ? chartSheet
    : sheets.find((item) => item.name === split.sheet) ?? sheets.find((item) => item.name.toLowerCase() === split.sheet!.toLowerCase()) ?? chartSheet;
  const bounds = parseCellRange(split.range)!;
  const labels: string[] = []; const numbers: Array<number | null> = [];
  for (let row = bounds.from.row; row <= bounds.to.row; row++) for (let col = bounds.from.col; col <= bounds.to.col; col++) {
    const cell = sheet.cells[cellAddress(col, row)];
    labels.push(cell?.v ?? "");
    const n = cell?.n ?? (cell && /^-?[\d,]+(?:\.\d+)?$/.test(cell.v.trim()) ? Number(cell.v.replace(/,/g, "")) : NaN);
    numbers.push(Number.isFinite(n) ? n : null);
  }
  const abs = (address: string) => address.replace(/^([A-Z]+)(\d+)$/, "$$$1$$$2");
  const [a, b] = split.range.split(":");
  return { formula: `${sheetRefName(sheet.name)}!${abs(a)}${b ? `:${abs(b)}` : ""}`, labels, numbers };
}

function chartXml(chart: LiveChart, sheet: LiveSheet, sheets: LiveSheet[]): string {
  const categories = chartRange(chart.categories, sheet, sheets);
  const strCache = `<c:strCache><c:ptCount val="${categories.labels.length}"/>${categories.labels.map((label, i) => `<c:pt idx="${i}"><c:v>${escapeXmlText(label)}</c:v></c:pt>`).join("")}</c:strCache>`;
  const series = chart.values.map((ref, index) => {
    const values = chartRange(ref, sheet, sheets);
    const numCache = `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.numbers.length}"/>${values.numbers.map((n, i) => n === null ? "" : `<c:pt idx="${i}"><c:v>${n}</c:v></c:pt>`).join("")}</c:numCache>`;
    return `<c:ser><c:idx val="${index}"/><c:order val="${index}"/>${chart.type === "line" ? '<c:marker><c:symbol val="circle"/><c:size val="5"/></c:marker>' : ""}`
      + `<c:cat><c:strRef><c:f>${escapeXmlText(categories.formula)}</c:f>${strCache}</c:strRef></c:cat>`
      + `<c:val><c:numRef><c:f>${escapeXmlText(values.formula)}</c:f>${numCache}</c:numRef></c:val>${chart.type === "line" ? '<c:smooth val="0"/>' : ""}</c:ser>`;
  }).join("");
  const axes = '<c:axId val="500000001"/><c:axId val="500000002"/>';
  const plot = chart.type === "bar"
    ? `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}<c:gapWidth val="150"/>${axes}</c:barChart>`
    : chart.type === "line"
      ? `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:marker val="1"/>${axes}</c:lineChart>`
      : `<c:pieChart><c:varyColors val="1"/>${series}<c:firstSliceAng val="0"/></c:pieChart>`;
  const axisXml = chart.type === "pie" ? "" : '<c:catAx><c:axId val="500000001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/><c:tickLblPos val="nextTo"/><c:crossAx val="500000002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx>'
    + '<c:valAx><c:axId val="500000002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:tickLblPos val="nextTo"/><c:crossAx val="500000001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>';
  const title = chart.title
    ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${escapeXmlText(chart.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`
    : '<c:autoTitleDeleted val="1"/>';
  const legend = chart.type === "pie" || chart.values.length > 1 ? '<c:legend><c:legendPos val="r"/><c:overlay val="0"/></c:legend>' : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_REL}"><c:roundedCorners val="0"/>`
    + `<c:chart>${title}<c:plotArea><c:layout/>${plot}${axisXml}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

/** Writes new charts onto a sheet: one drawing per sheet (reused when the sheet has one), one chart part per chart. */
function addCharts(info: WorkbookInfo, ref: SheetRef, sheet: LiveSheet, charts: LiveChart[], sheets: LiveSheet[]): void {
  const pkg = info.pkg;
  const doc = parseXml(pkg.text(ref.part)!);
  const sheetRels = relsDoc(pkg, ref.part);
  const existing = elements(doc.root).find((el) => localName(el) === "drawing");
  let drawingPart = existing ? relTargets(pkg, ref.part).get(idAttr(existing) ?? "") : undefined;
  if (!drawingPart || !pkg.has(drawingPart)) {
    drawingPart = freePart(pkg, (n) => `xl/drawings/drawing${n}.xml`);
    pkg.setText(drawingPart, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}"></xdr:wsDr>`);
    addContentType(pkg, drawingPart, CT_DRAWING);
    const rid = sheetRels.add(REL_DRAWING, `../drawings/${drawingPart.split("/").pop()}`);
    sheetRels.save();
    const prefix = doc.root.name.includes(":") ? `${doc.root.name.split(":")[0]}:` : "";
    const declareR = /\sxmlns:r=/.test(doc.root.attrs) ? "" : ` xmlns:r="${NS_REL}"`;
    const drawing = createElement(`<${prefix}drawing${declareR} r:id="${rid}"/>`);
    const kids = elements(doc.root);
    const anchor = [...kids].reverse().find((child) => BEFORE_DRAWING.includes(localName(child)));
    doc.root.children.splice(anchor ? doc.root.children.indexOf(anchor) + 1 : doc.root.children.length, 0, drawing);
    markDirty(doc.root);
    pkg.setText(ref.part, serializeXml(doc));
  }
  const drawingDoc = parseXml(pkg.text(drawingPart)!);
  const drawingRels = relsDoc(pkg, drawingPart);
  let shapeId = Math.max(1, ...deep(drawingDoc.root, "cNvPr").map((node) => Number(attr(node, "id")) || 0));
  for (const chart of charts) {
    const chartPart = freePart(pkg, (n) => `xl/charts/chart${n}.xml`);
    pkg.setText(chartPart, chartXml(chart, sheet, sheets));
    addContentType(pkg, chartPart, CT_CHART);
    const rid = drawingRels.add(REL_CHART, `../charts/${chartPart.split("/").pop()}`);
    const at = parseCellAddress(chart.anchor) ?? { col: 1, row: 1 };
    shapeId += 1;
    drawingDoc.root.children.push(createElement(`<xdr:twoCellAnchor xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}">`
      + `<xdr:from><xdr:col>${at.col - 1}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${at.row - 1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`
      + `<xdr:to><xdr:col>${at.col + 7}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${at.row + 14}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>`
      + `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${shapeId}" name="Chart ${shapeId}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>`
      + `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${NS_C}">`
      + `<c:chart xmlns:c="${NS_C}" xmlns:r="${NS_REL}" r:id="${rid}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`));
  }
  drawingDoc.root.selfClosing = false;
  markDirty(drawingDoc.root);
  pkg.setText(drawingPart, serializeXml(drawingDoc));
  drawingRels.save();
}

export const xlsxCodec: LiveDocumentCodec = {
  parse(bytes) {
    const sheets = sheetModel(readWorkbook(bytes));
    // Formulas saved without cached values (openpyxl, scripts, earlier saves) show their result, not their text.
    recalculateSheets(sheets);
    return { kind: "sheet", sheets };
  },
  write(bytes, original, final) {
    if (original.kind !== "sheet" || final.kind !== "sheet") throw new LiveDocumentCodecError("model_kind_mismatch");
    const info = readWorkbook(bytes);
    const before = new Map(original.sheets.map((sheet) => [sheet.id, sheet]));
    const styleWriter = new StyleWriter(info.pkg);
    let changed = false;
    const plans = final.sheets.map((sheet) => {
      let ref = info.sheets.find((item) => item.id === sheet.id);
      if (!ref) { ref = addSheet(info, sheet.name); changed = true; }
      const changes = new Map<string, LiveCell | null>();
      const priorCells = before.get(sheet.id)?.cells ?? {};
      for (const [address, cell] of Object.entries(sheet.cells)) {
        const old = priorCells[address];
        if (!old || old.v !== cell.v || old.f !== cell.f || (old.nf ?? null) !== (cell.nf ?? null) || JSON.stringify(old.format ?? null) !== JSON.stringify(cell.format ?? null)) changes.set(address, cell);
      }
      for (const address of Object.keys(priorCells)) if (!(address in sheet.cells)) changes.set(address, null);
      if (changes.size) changed = true;
      return { sheet, ref, changes, priorCells };
    });
    for (const { sheet, ref, changes, priorCells } of plans) {
      const doc = parseXml(info.pkg.text(ref.part)!);
      // A workbook being written anyway also gets cached values for formulas the file stored without one.
      if (changed) {
        for (const [address, entry] of readCells(doc, info)) {
          const cell = sheet.cells[address];
          if (cell?.f !== undefined && cell.v !== "" && !changes.has(address) && !elements(entry.element).some((el) => localName(el) === "v")) changes.set(address, cell);
        }
      }
      if (!changes.size) continue;
      patchSheet(doc, changes, info, styleWriter, new Map(Object.entries(priorCells).map(([address, cell]) => [address, cell.format])),
        new Map(Object.entries(priorCells).map(([address, cell]) => [address, cell.nf])));
      info.pkg.setText(ref.part, serializeXml(doc));
    }
    // A renamed sheet's workbook entry (and its sheet-scoped names) follow; a deleted sheet leaves with its part.
    for (const { sheet, ref } of plans) {
      if (!before.has(sheet.id) || ref.name === sheet.name) continue;
      renameSheetEntry(info, ref, sheet.name);
      changed = true;
    }
    const kept = new Set(final.sheets.map((sheet) => sheet.id));
    for (const ref of info.sheets.filter((item) => before.has(item.id) && !kept.has(item.id))) {
      removeSheet(info, ref);
      changed = true;
    }
    for (const { sheet, ref } of plans) {
      const known = new Set((before.get(sheet.id)?.charts ?? []).map((chart) => chart.id));
      const fresh = (sheet.charts ?? []).filter((chart) => !chart.fromFile && !known.has(chart.id));
      if (!fresh.length) continue;
      addCharts(info, ref, sheet, fresh, final.sheets);
      changed = true;
    }
    if (!changed) return bytes;
    styleWriter.flush();
    dropCalcChain(info);
    ensureFullCalc(info.workbook);
    info.pkg.setText(WORKBOOK, serializeXml(info.workbook));
    if (info.rels) info.pkg.setText(relsPathFor(WORKBOOK), serializeXml(info.rels));
    return info.pkg.toBytes();
  },
};
