import { cellAddress, parseCellAddress, type LiveCell, type LiveFormat, type LiveSheet } from "../../../shared/live-document";
import { relsPathFor, resolvePartPath, ZipPackage } from "../zip";
import {
  attr, createElement, decodeXml, elements, escapeXmlAttr, escapeXmlText, localName, markDirty, parseXml,
  serializeNode, serializeXml, setAttr, textContent, type XmlDocument, type XmlElement,
} from "../xml-lite";
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

interface SheetRef { id: string; name: string; part: string; }

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
    sheets.push({ id: `sheet${index + 1}`, name: attr(sheet, "name") ?? `Sheet${index + 1}`, part });
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

function formatNumber(raw: string, format: { id: number; code: string } | undefined): string {
  const value = Number(raw);
  if (!format || !Number.isFinite(value)) return displayNumber(raw);
  const code = format.code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
  if (format.id === 9 || format.id === 10 || code.includes("%")) {
    const decimals = format.id === 10 ? 2 : (/\.(0+)%/.exec(code)?.[1].length ?? 0);
    return `${(value * 100).toFixed(decimals)}%`;
  }
  if (DATE_IDS.has(format.id) || (/[yd]/i.test(code) && !/[#0]/.test(code))) {
    const ms = Math.round((value - 25569) * 86_400_000);
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return displayNumber(raw);
    const iso = date.toISOString();
    const timeShown = /h/i.test(code) || format.id === 22;
    return timeShown ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
  }
  if (format.id === 3 || format.id === 4 || code.includes("#,##0")) {
    const decimals = format.id === 4 ? 2 : (/#,##0\.(0+)/.exec(code)?.[1].length ?? 0);
    return value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }
  if (format.id === 2 || /^0\.(0+)$/.test(code.trim())) {
    const decimals = format.id === 2 ? 2 : code.trim().length - 2;
    return value.toFixed(decimals);
  }
  return displayNumber(raw);
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
      else if (rawV !== "") display = formatNumber(rawV, info.formats[Number(attr(c, "s") ?? 0)]);
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
      out.set(address, { cell: { v: display, ...(formula ? { f: formula } : {}), ...(format ? { format } : {}) }, element: c, row });
    }
  }
  return out;
}

function sheetModel(info: WorkbookInfo): LiveSheet[] {
  return info.sheets.map((sheet) => {
    const doc = parseXml(info.pkg.text(sheet.part)!);
    const cells: Record<string, LiveCell> = {};
    for (const [address, entry] of readCells(doc, info)) cells[address] = entry.cell;
    return { id: sheet.id, name: sheet.name, cells };
  });
}

const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function cellMarkup(address: string, style: string | undefined, cell: LiveCell): string {
  const s = style !== undefined ? ` s="${escapeXmlAttr(style)}"` : "";
  if (cell.f === undefined && cell.v === "") return `<c r="${address}"${s}/>`;
  if (cell.f !== undefined) return `<c r="${address}"${s}><f>${escapeXmlText(cell.f)}</f></c>`;
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
  styleFor(base: string | undefined, format: LiveFormat | undefined, removed: ReadonlySet<string> = new Set()): string | undefined {
    if ((!format || isEmptyFormat(format)) && removed.size && this.doc) format = {};
    if (!format || (isEmptyFormat(format) && !removed.size) || !this.doc) return base;
    const key = `${base ?? "0"}|${JSON.stringify(format)}|${[...removed].join(",")}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const root = this.doc.root;
    const fontsEl = elements(root).find((node) => localName(node) === "fonts");
    const xfsEl = elements(root).find((node) => localName(node) === "cellXfs");
    if (!fontsEl || !xfsEl) return base;
    const xfs = elements(xfsEl);
    const baseXf = xfs[Number(base ?? 0)] ?? xfs[0];
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
  flush(): void {
    if (this.doc && this.changed) this.pkg.setText("xl/styles.xml", serializeXml(this.doc));
  }
}

function patchSheet(doc: XmlDocument, changes: Map<string, LiveCell | null>, info: Pick<WorkbookInfo, "shared" | "formats"> & { styles?: StyleInfo }, styleWriter?: StyleWriter, priorFormats?: Map<string, LiveFormat | undefined>): void {
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
    if (formatChanged && styleWriter) {
      const prior = priorFormats?.get(address) ?? {};
      const removed = new Set(Object.keys(prior).filter((key) => (cell.format as Record<string, unknown> | undefined)?.[key] === undefined));
      styleIndex = styleWriter.styleFor(styleIndex, cell.format, removed);
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

export const xlsxCodec: LiveDocumentCodec = {
  parse(bytes) {
    return { kind: "sheet", sheets: sheetModel(readWorkbook(bytes)) };
  },
  write(bytes, original, final) {
    if (original.kind !== "sheet" || final.kind !== "sheet") throw new LiveDocumentCodecError("model_kind_mismatch");
    const info = readWorkbook(bytes);
    const before = new Map(original.sheets.map((sheet) => [sheet.id, sheet]));
    const styleWriter = new StyleWriter(info.pkg);
    let changed = false;
    for (const sheet of final.sheets) {
      let ref = info.sheets.find((item) => item.id === sheet.id);
      const prior = before.get(sheet.id);
      if (!ref) { ref = addSheet(info, sheet.name); changed = true; }
      const changes = new Map<string, LiveCell | null>();
      const priorCells = prior?.cells ?? {};
      for (const [address, cell] of Object.entries(sheet.cells)) {
        const old = priorCells[address];
        if (!old || old.v !== cell.v || old.f !== cell.f || JSON.stringify(old.format ?? null) !== JSON.stringify(cell.format ?? null)) changes.set(address, cell);
      }
      for (const address of Object.keys(priorCells)) if (!(address in sheet.cells)) changes.set(address, null);
      if (!changes.size) continue;
      const doc = parseXml(info.pkg.text(ref.part)!);
      patchSheet(doc, changes, info, styleWriter, new Map(Object.entries(priorCells).map(([address, cell]) => [address, cell.format])));
      info.pkg.setText(ref.part, serializeXml(doc));
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
