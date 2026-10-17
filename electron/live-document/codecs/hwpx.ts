import type { LiveFlowBlock, LiveFormat, LiveFormatPatch, LivePage, LiveTableCell } from "../../../shared/live-document";
import { ZipPackage } from "../zip";
import {
  attr, createElement, elements, escapeXmlAttr, escapeXmlText, localName, markDirty, markPath, parseXml, serializeNode, serializeXml,
  setAttr, textContent, type XmlDocument, type XmlElement, type XmlNode,
} from "../xml-lite";
import { blockChanged, flowBlocks, LiveDocumentCodecError, planFlowInsertions, type LiveDocumentCodec } from "./common";
import { el, formatDelta, isEmptyFormat, normColor, removeChildren } from "./format";

const HWPUNIT_MM = 25.4 / 7200;

function findDeep(element: XmlElement, local: string): XmlElement | undefined {
  for (const child of elements(element)) {
    if (localName(child) === local) return child;
    const found = findDeep(child, local);
    if (found) return found;
  }
  return undefined;
}

/** Paper of the first section (secPr/pagePr); the body starts below the header area and ends above the footer. */
function pageOf(doc: XmlDocument): LivePage | undefined {
  const pagePr = findDeep(doc.root, "pagePr");
  if (!pagePr) return undefined;
  const margin = elements(pagePr).find((node) => localName(node) === "margin");
  const n = (node: XmlElement | undefined, key: string) => Number(node ? attr(node, key) : NaN) || 0;
  const mm = (value: number) => Math.round(value * HWPUNIT_MM * 10) / 10;
  return {
    width: mm(n(pagePr, "width") || 59528), height: mm(n(pagePr, "height") || 84188),
    margin: { top: mm(n(margin, "top") + n(margin, "header")), right: mm(n(margin, "right")), bottom: mm(n(margin, "bottom") + n(margin, "footer")), left: mm(n(margin, "left") + n(margin, "gutter")) },
  };
}

const ALIGN_IN: Record<string, LiveFormat["align"]> = { LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFY: "justify", DISTRIBUTE: "justify", DISTRIBUTE_SPACE: "justify" };
const ALIGN_OUT: Record<NonNullable<LiveFormat["align"]>, string> = { left: "LEFT", center: "CENTER", right: "RIGHT", justify: "JUSTIFY" };
/** OWPML charPr child sequence: italic and bold sit before underline. */
const CHARPR_ORDER = ["fontRef", "ratio", "spacing", "relSz", "offset", "italic", "bold", "underline", "strikeout", "outline", "shadow", "emboss", "engrave", "supscript", "subscript"];

/** header.xml character/paragraph shapes: read for display, cloned (never edited in place) for new formats. */
class HwpxHeader {
  readonly doc: XmlDocument | null;
  private readonly charPr = new Map<string, XmlElement>();
  private readonly paraPr = new Map<string, XmlElement>();
  private charList: XmlElement | undefined;
  private paraList: XmlElement | undefined;
  private readonly borderFill = new Map<string, XmlElement>();
  private borderList: XmlElement | undefined;
  private readonly cache = new Map<string, string>();
  changed = false;
  constructor(xml: string | undefined) {
    this.doc = xml ? parseXml(xml) : null;
    if (!this.doc) return;
    const walk = (node: XmlElement) => {
      for (const child of elements(node)) {
        const name = localName(child);
        if (name === "charProperties") this.charList = child;
        else if (name === "paraProperties") this.paraList = child;
        else if (name === "borderFills") this.borderList = child;
        else if (name === "borderFill" && attr(child, "id") !== undefined) this.borderFill.set(attr(child, "id")!, child);
        else if (name === "charPr" && attr(child, "id") !== undefined) this.charPr.set(attr(child, "id")!, child);
        else if (name === "paraPr" && attr(child, "id") !== undefined) this.paraPr.set(attr(child, "id")!, child);
        if (!["charPr", "paraPr", "borderFill"].includes(name)) walk(child);
      }
    };
    walk(this.doc.root);
  }
  /** Face colour of a border/fill entry (cell or paragraph background); none/transparent is no fill. */
  fillOf(borderFillId: string | undefined): string | undefined {
    const entry = borderFillId !== undefined ? this.borderFill.get(borderFillId) : undefined;
    const brush = entry ? findDeep(entry, "winBrush") : undefined;
    const face = brush ? attr(brush, "faceColor") : undefined;
    const color = face && face !== "none" ? normColor(face) : undefined;
    return color === "#ffffff" ? undefined : color;
  }
  /** Body text size: the character shape of style 0 (바탕글/Normal). */
  defaultSize(styleCharPr: string | undefined): number | undefined {
    const char = this.charPr.get(styleCharPr ?? "0");
    const height = char ? Number(attr(char, "height")) : NaN;
    return Number.isFinite(height) && height > 0 ? height / 100 : undefined;
  }
  /** A border/fill like `base` with the given background (null removes it). */
  borderFillFor(base: string, fill: string | null): string {
    if (!this.borderList) return base;
    const key = `b${base}|${fill}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const source = this.borderFill.get(base) ?? [...this.borderFill.values()][0];
    if (!source) return base;
    const clone = el(serializeNode(source));
    const prefixOf = (name: string) => (name.includes(":") ? `${name.split(":")[0]}:` : "");
    removeChildren(clone, "fillBrush");
    if (fill) { clone.children.push(el(`<hc:fillBrush xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core"><hc:winBrush faceColor="${fill.toUpperCase()}" hatchColor="#000000" alpha="0"/></hc:fillBrush>`)); markDirty(clone); }
    void prefixOf;
    const id = this.append(this.borderList, this.borderFill, clone);
    this.cache.set(key, id);
    return id;
  }
  /** A border/fill with thin solid borders on all four sides and no fill, for new tables. */
  solidBorderFill(): string {
    for (const [id, entry] of this.borderFill) {
      const sides = ["leftBorder", "rightBorder", "topBorder", "bottomBorder"].map((side) => elements(entry).find((node) => localName(node) === side));
      if (sides.every((side) => side && attr(side, "type") === "SOLID") && !this.fillOf(id)) return id;
    }
    const source = [...this.borderFill.values()][0];
    if (!this.borderList || !source) return "1";
    const clone = el(serializeNode(source));
    for (const node of elements(clone)) {
      if (["leftBorder", "rightBorder", "topBorder", "bottomBorder"].includes(localName(node))) { setAttr(node, "type", "SOLID"); setAttr(node, "width", "0.12 mm"); setAttr(node, "color", "#000000"); }
    }
    removeChildren(clone, "fillBrush");
    markDirty(clone);
    return this.append(this.borderList, this.borderFill, clone);
  }
  /** Paragraph shape with a background (paraPr border → border/fill entry). */
  paraFillFor(base: string, fill: string | null): string {
    if (!this.paraList) return base;
    const key = `pf${base}|${fill}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const source = this.paraPr.get(base) ?? [...this.paraPr.values()][0];
    if (!source) return base;
    const clone = el(serializeNode(source));
    const border = findDeep(clone, "border");
    const fillId = this.borderFillFor(border ? attr(border, "borderFillIDRef") ?? "1" : "1", fill);
    if (border) setAttr(border, "borderFillIDRef", fillId);
    else { clone.children.push(el(`<hh:border xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" borderFillIDRef="${fillId}" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/>`)); markDirty(clone); }
    const id = this.append(this.paraList, this.paraPr, clone);
    this.cache.set(key, id);
    return id;
  }
  paraFillOf(paraPrId: string | undefined): string | undefined {
    const para = paraPrId !== undefined ? this.paraPr.get(paraPrId) : undefined;
    const border = para ? findDeep(para, "border") : undefined;
    return border ? this.fillOf(attr(border, "borderFillIDRef")) : undefined;
  }
  format(charPrId: string | undefined, paraPrId: string | undefined): LiveFormat | undefined {
    const format: LiveFormat = {};
    const char = charPrId !== undefined ? this.charPr.get(charPrId) : undefined;
    if (char) {
      const has = (name: string) => elements(char).some((node) => localName(node) === name);
      if (has("bold")) format.bold = true;
      if (has("italic")) format.italic = true;
      const underline = elements(char).find((node) => localName(node) === "underline");
      if (underline && (attr(underline, "type") ?? "NONE") !== "NONE") format.underline = true;
      const height = Number(attr(char, "height"));
      if (Number.isFinite(height) && height > 0 && height !== 1000) format.size = height / 100;
      const color = normColor(attr(char, "textColor"));
      if (color && color !== "#000000") format.color = color;
    }
    const para = paraPrId !== undefined ? this.paraPr.get(paraPrId) : undefined;
    const align = para ? elements(para).find((node) => localName(node) === "align") : undefined;
    const horizontal = align ? ALIGN_IN[attr(align, "horizontal") ?? ""] : undefined;
    if (horizontal && horizontal !== "justify") format.align = horizontal;
    const fill = this.paraFillOf(paraPrId);
    if (fill) format.fill = fill;
    return isEmptyFormat(format) ? undefined : format;
  }
  private append(list: XmlElement, map: Map<string, XmlElement>, clone: XmlElement): string {
    const id = String(Math.max(-1, ...[...map.keys()].map(Number).filter(Number.isFinite)) + 1);
    setAttr(clone, "id", id);
    list.children.push(clone);
    setAttr(list, "itemCnt", String(elements(list).length));
    map.set(id, clone);
    markPath(this.doc!.root, list);
    this.changed = true;
    return id;
  }
  charFor(base: string, delta: LiveFormatPatch): string {
    const chars = JSON.parse(JSON.stringify({ ...delta, align: undefined })) as LiveFormatPatch;
    if (!this.charList || isEmptyFormat(chars)) return base;
    const key = `c${base}|${JSON.stringify(chars)}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const source = this.charPr.get(base) ?? [...this.charPr.values()][0];
    if (!source) return base;
    const clone = el(serializeNode(source));
    const prefix = source.name.includes(":") ? `${source.name.split(":")[0]}:` : "";
    if (delta.size !== undefined) setAttr(clone, "height", String(Math.round((delta.size ?? 10) * 100)));
    if (delta.color !== undefined) setAttr(clone, "textColor", (delta.color ?? "#000000").toUpperCase());
    const toggle = (name: string, value: boolean | null | undefined) => {
      if (value === undefined) return;
      removeChildren(clone, name);
      if (value) {
        const node = el(`<${prefix}${name}/>`);
        const rank = CHARPR_ORDER.indexOf(name);
        const at = clone.children.findIndex((child) => child.type === "el" && CHARPR_ORDER.indexOf(localName(child)) > rank);
        if (at < 0) clone.children.push(node); else clone.children.splice(at, 0, node);
        markDirty(clone);
      }
    };
    toggle("italic", delta.italic);
    toggle("bold", delta.bold);
    if (delta.underline !== undefined) {
      const underline = elements(clone).find((node) => localName(node) === "underline");
      if (underline) setAttr(underline, "type", delta.underline ? "BOTTOM" : "NONE");
      else if (delta.underline) { clone.children.push(el(`<${prefix}underline type="BOTTOM" shape="SOLID" color="#000000"/>`)); markDirty(clone); }
    }
    const id = this.append(this.charList, this.charPr, clone);
    this.cache.set(key, id);
    return id;
  }
  paraFor(base: string, align: LiveFormat["align"] | null): string {
    if (!this.paraList || !align) return base;
    const key = `p${base}|${align}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const source = this.paraPr.get(base) ?? [...this.paraPr.values()][0];
    if (!source) return base;
    const clone = el(serializeNode(source));
    const node = elements(clone).find((child) => localName(child) === "align");
    if (node) setAttr(node, "horizontal", ALIGN_OUT[align]);
    else { const prefix = source.name.includes(":") ? `${source.name.split(":")[0]}:` : ""; clone.children.unshift(el(`<${prefix}align horizontal="${ALIGN_OUT[align]}" vertical="BASELINE"/>`)); markDirty(clone); }
    const id = this.append(this.paraList, this.paraPr, clone);
    this.cache.set(key, id);
    return id;
  }
}

function firstTextRunCharPr(paragraph: XmlElement): string | undefined {
  const all = runs(paragraph);
  const run = all.find((item) => elements(item).some((node) => localName(node) === "t" && tText(node))) ?? all[0];
  return run ? attr(run, "charPrIDRef") : undefined;
}

function paragraphFormat(header: HwpxHeader, paragraph: XmlElement): LiveFormat | undefined {
  return header.format(firstTextRunCharPr(paragraph), attr(paragraph, "paraPrIDRef"));
}

/** Applies a format change: text runs get derived character shapes, the paragraph a derived paragraph shape. */
function setParagraphFormat(header: HwpxHeader, root: XmlElement | null, paragraph: XmlElement, delta: LiveFormatPatch): void {
  for (const run of runs(paragraph)) {
    if (!elements(run).some((node) => localName(node) === "t")) continue;
    const base = attr(run, "charPrIDRef") ?? "0";
    const next = header.charFor(base, delta);
    if (next !== base) setAttr(run, "charPrIDRef", next);
  }
  if (delta.align !== undefined) setAttr(paragraph, "paraPrIDRef", header.paraFor(attr(paragraph, "paraPrIDRef") ?? "0", delta.align ?? "justify"));
  if (delta.fill !== undefined) setAttr(paragraph, "paraPrIDRef", header.paraFillFor(attr(paragraph, "paraPrIDRef") ?? "0", delta.fill));
  dropLineSegments(paragraph);
  markDirty(paragraph);
  if (root) markPath(root, paragraph);
}

/*
 * HWPX (OWPML): every Contents/sectionN.xml paragraph (hp:p directly under hs:sec) becomes a block. A changed
 * paragraph keeps its paragraph shape, style and every control run (section definition, tables, pictures); its text
 * runs are replaced by one run in the first text run's character shape, and its line-segment cache is dropped so
 * Hancom lays the paragraph out again. Untouched paragraphs are copied byte-for-byte.
 */

const OBJECT_TAGS = new Set(["pic", "container", "equation", "ole", "rect", "ellipse", "line", "arc", "polygon", "curve", "connectLine", "chart", "textart", "video"]);

interface HwpxContext {
  pkg: ZipPackage;
  sections: Array<{ part: string; doc: XmlDocument }>;
  /** block id -> where it lives */
  blocks: Map<string, { section: number; element: XmlElement }>;
  model: LiveFlowBlock[];
  outline: Map<string, number>;
  outlineStyle: Map<number, { id: string; paraPr: string; charPr: string }>;
  header: HwpxHeader;
  page?: LivePage;
  defaultSize?: number;
}

function sectionParts(pkg: ZipPackage): string[] {
  return pkg.names().filter((name) => /^Contents\/section\d+\.xml$/i.test(name))
    .sort((a, b) => Number(/(\d+)\.xml$/i.exec(a)![1]) - Number(/(\d+)\.xml$/i.exec(b)![1]));
}

function readStyles(pkg: ZipPackage): Pick<HwpxContext, "outline" | "outlineStyle"> {
  const outline = new Map<string, number>();
  const outlineStyle = new Map<number, { id: string; paraPr: string; charPr: string }>();
  const xml = pkg.text("Contents/header.xml");
  if (!xml) return { outline, outlineStyle };
  for (const match of xml.matchAll(/<(?:\w+:)?style\s([^>]*)\/?>/g)) {
    const attrs = match[1];
    const get = (key: string) => new RegExp(`\\b${key}="([^"]*)"`).exec(attrs)?.[1];
    const level = /^Outline\s*([1-6])$/i.exec(get("engName") ?? "")?.[1] ?? /^개요\s*([1-6])$/.exec(get("name") ?? "")?.[1];
    const id = get("id");
    if (!level || id === undefined) continue;
    outline.set(id, Number(level));
    if (!outlineStyle.has(Number(level))) outlineStyle.set(Number(level), { id, paraPr: get("paraPrIDRef") ?? "0", charPr: get("charPrIDRef") ?? "0" });
  }
  return { outline, outlineStyle };
}

function runs(paragraph: XmlElement): XmlElement[] {
  return elements(paragraph).filter((el) => localName(el) === "run");
}

function tText(t: XmlElement): string {
  let out = "";
  for (const node of t.children) {
    if (node.type === "text") out += textContent(node);
    else if (node.type === "el") {
      const name = localName(node);
      if (name === "lineBreak") out += "\n";
      else if (name === "tab") out += "\t";
      else if (name === "fwSpace" || name === "nbSpace") out += " ";
      else if (name === "hyphen") out += "-";
    }
  }
  return out;
}

export function hwpxParagraphText(paragraph: XmlElement): string {
  return runs(paragraph).map((run) => elements(run).filter((el) => localName(el) === "t").map(tText).join("")).join("");
}

function firstTable(paragraph: XmlElement): XmlElement | undefined {
  for (const run of runs(paragraph)) { const tbl = elements(run).find((el) => localName(el) === "tbl"); if (tbl) return tbl; }
  return undefined;
}

function hasObject(paragraph: XmlElement): boolean {
  return runs(paragraph).some((run) => elements(run).some((el) => OBJECT_TAGS.has(localName(el))));
}

function hasSection(paragraph: XmlElement): boolean {
  return runs(paragraph).some((run) => elements(run).some((el) => localName(el) === "secPr"));
}

function cellParagraphs(tc: XmlElement): { subList: XmlElement | undefined; paragraphs: XmlElement[] } {
  const subList = elements(tc).find((el) => localName(el) === "subList");
  return { subList, paragraphs: subList ? elements(subList).filter((el) => localName(el) === "p") : [] };
}

interface TableLayout { rows: Array<Array<LiveTableCell | null>>; cells: Map<string, XmlElement>; colWidths?: number[] }

function tableLayout(tbl: XmlElement, tableId: string, header?: HwpxHeader): TableLayout {
  const cellsByPos: Array<{ row: number; col: number; colSpan: number; rowSpan: number; tc: XmlElement; width: number }> = [];
  for (const tr of elements(tbl).filter((el) => localName(el) === "tr")) {
    for (const tc of elements(tr).filter((el) => localName(el) === "tc")) {
      const address = elements(tc).find((el) => localName(el) === "cellAddr");
      const span = elements(tc).find((el) => localName(el) === "cellSpan");
      cellsByPos.push({
        row: Number(address ? attr(address, "rowAddr") : 0) || 0,
        col: Number(address ? attr(address, "colAddr") : 0) || 0,
        colSpan: Math.max(1, Number(span ? attr(span, "colSpan") : 1) || 1),
        rowSpan: Math.max(1, Number(span ? attr(span, "rowSpan") : 1) || 1),
        tc,
        width: Number(attr(elements(tc).find((el) => localName(el) === "cellSz") ?? tc, "width")) || 0,
      });
    }
  }
  const rowCount = Math.max(Number(attr(tbl, "rowCnt") ?? 0) || 0, ...cellsByPos.map((cell) => cell.row + cell.rowSpan));
  const colCount = Math.max(Number(attr(tbl, "colCnt") ?? 0) || 0, ...cellsByPos.map((cell) => cell.col + cell.colSpan));
  const rows: Array<Array<LiveTableCell | null>> = Array.from({ length: rowCount }, () => Array(colCount).fill(null));
  const cells = new Map<string, XmlElement>();
  for (const item of cellsByPos) {
    const id = `${tableId}.r${item.row + 1}c${item.col + 1}`;
    const paragraphs = cellParagraphs(item.tc).paragraphs;
    const text = paragraphs.map(hwpxParagraphText).join("\n");
    const paragraphFmt = header && paragraphs[0] ? paragraphFormat(header, paragraphs[0]) : undefined;
    const cellFill = header?.fillOf(attr(item.tc, "borderFillIDRef"));
    const merged: LiveFormat = { ...(paragraphFmt ?? {}) };
    delete merged.fill;
    if (cellFill) merged.fill = cellFill;
    const format = isEmptyFormat(merged) ? undefined : merged;
    if (rows[item.row]) rows[item.row][item.col] = { id, text, ...(item.colSpan > 1 ? { colSpan: item.colSpan } : {}), ...(item.rowSpan > 1 ? { rowSpan: item.rowSpan } : {}), ...(format ? { format } : {}) };
    cells.set(id, item.tc);
  }
  const widths = Array.from({ length: colCount }, (_, col) => cellsByPos.find((cell) => cell.col === col && cell.colSpan === 1 && cell.width > 0)?.width ?? 0);
  const total = widths.reduce((sum, w) => sum + w, 0);
  const colWidths = widths.every((w) => w > 0) && total > 0 ? widths.map((w) => Math.round((w / total) * 10000) / 10000) : undefined;
  return { rows, cells, colWidths };
}

function load(bytes: Uint8Array): HwpxContext {
  const pkg = new ZipPackage(bytes);
  const parts = sectionParts(pkg);
  if (!parts.length) throw new LiveDocumentCodecError("hwpx_sections_missing");
  const styles = readStyles(pkg);
  const header = new HwpxHeader(pkg.text("Contents/header.xml"));
  const sections = parts.map((part) => ({ part, doc: parseXml(pkg.text(part)!) }));
  const blocks = new Map<string, { section: number; element: XmlElement }>();
  const model: LiveFlowBlock[] = [];
  let counter = 0;
  sections.forEach(({ doc }, section) => {
    for (const paragraph of elements(doc.root).filter((el) => localName(el) === "p")) {
      const id = `b${++counter}`;
      blocks.set(id, { section, element: paragraph });
      const table = firstTable(paragraph);
      const text = hwpxParagraphText(paragraph);
      if (table) {
        const layout = tableLayout(table, id, header);
        model.push({ id, type: "table", rows: layout.rows, ...(layout.colWidths ? { colWidths: layout.colWidths } : {}), ...(hasSection(paragraph) ? { fixed: true } : {}) });
      }
      else if (!text.trim() && hasObject(paragraph)) model.push({ id, type: "object", label: "image" });
      else {
        const heading = styles.outline.get(attr(paragraph, "styleIDRef") ?? "");
        const format = paragraphFormat(header, paragraph);
        const pageBreak = attr(paragraph, "pageBreak") === "1" ? "before" as const : undefined;
        model.push({ id, type: "paragraph", text, ...(heading ? { heading } : {}), ...(hasSection(paragraph) ? { fixed: true } : {}), ...(format ? { format } : {}), ...(pageBreak ? { pageBreak } : {}) });
      }
    }
  });
  const normal = /<(?:\w+:)?style\s[^>]*\bid="0"[^>]*\bcharPrIDRef="(\d+)"/.exec(pkg.text("Contents/header.xml") ?? "")?.[1];
  return { pkg, sections, blocks, model, ...styles, header, page: pageOf(sections[0].doc), defaultSize: header.defaultSize(normal) };
}

function prefixOf(element: XmlElement): string {
  return element.name.includes(":") ? `${element.name.split(":")[0]}:` : "";
}

function textMarkup(prefix: string, text: string): string {
  let inner = "";
  for (const part of text.replace(/\r/g, "").split(/(\n|\t)/)) {
    if (part === "\n") inner += `<${prefix}lineBreak/>`;
    else if (part === "\t") inner += `<${prefix}tab width="4000" leader="0" type="1"/>`;
    else if (part) inner += escapeXmlText(part);
  }
  return inner ? `<${prefix}t>${inner}</${prefix}t>` : `<${prefix}t/>`;
}

function dropLineSegments(paragraph: XmlElement): void {
  paragraph.children = paragraph.children.filter((node) => node.type !== "el" || localName(node) !== "linesegarray");
}

function setParagraphText(root: XmlElement, paragraph: XmlElement, text: string): void {
  const prefix = prefixOf(paragraph);
  const all = runs(paragraph);
  const isTextRun = (run: XmlElement) => elements(run).every((el) => localName(el) === "t");
  const textRuns = all.filter(isTextRun);
  const charPr = [...all].find((run) => elements(run).some((el) => localName(el) === "t" && tText(el).length > 0))?.attrs
    ?? all[0]?.attrs ?? "";
  const charPrId = /charPrIDRef="([^"]*)"/.exec(charPr)?.[1] ?? "0";
  // Control runs keep their controls; their text moves into the new text run.
  for (const run of all) {
    if (isTextRun(run)) continue;
    const before = run.children.length;
    run.children = run.children.filter((node) => node.type !== "el" || localName(node) !== "t" || (localName(node) === "t" && !tText(node)));
    if (run.children.length !== before) markDirty(run);
  }
  const fresh = createElement(`<${prefix}run charPrIDRef="${escapeXmlAttr(charPrId)}">${textMarkup(prefix, text)}</${prefix}run>`);
  const anchor = textRuns[0];
  let index: number;
  if (anchor) index = paragraph.children.indexOf(anchor);
  else {
    const lastRun = all[all.length - 1];
    index = lastRun ? paragraph.children.indexOf(lastRun) + 1 : 0;
  }
  paragraph.children.splice(index, 0, fresh);
  paragraph.children = paragraph.children.filter((node) => !(node.type === "el" && textRuns.includes(node)));
  dropLineSegments(paragraph);
  markPath(root, paragraph);
  markDirty(paragraph);
}

function newParagraph(ctx: HwpxContext, template: XmlElement | undefined, prefix: string, text: string, heading: number | undefined): XmlElement {
  const style = heading ? ctx.outlineStyle.get(heading) : undefined;
  const paraPr = style?.paraPr ?? (template ? attr(template, "paraPrIDRef") : undefined) ?? "0";
  const styleId = style?.id ?? (template ? attr(template, "styleIDRef") : undefined) ?? "0";
  const templateRun = template ? runs(template).find((run) => elements(run).some((el) => localName(el) === "t" && tText(el))) ?? runs(template)[0] : undefined;
  const charPr = style?.charPr ?? (templateRun ? attr(templateRun, "charPrIDRef") : undefined) ?? "0";
  return createElement(`<${prefix}p id="0" paraPrIDRef="${escapeXmlAttr(paraPr)}" styleIDRef="${escapeXmlAttr(styleId)}" pageBreak="0" columnBreak="0" merged="0"><${prefix}run charPrIDRef="${escapeXmlAttr(charPr)}">${textMarkup(prefix, text)}</${prefix}run></${prefix}p>`);
}

let tableSerial = 0;

/** A new table paragraph: thin solid borders, column widths across the text width, one paragraph per cell. */
function newTable(ctx: HwpxContext, template: XmlElement | undefined, prefix: string, block: Extract<LiveFlowBlock, { type: "table" }>): XmlElement {
  const page = ctx.page ?? { width: 210, height: 297, margin: { top: 20, right: 20, bottom: 15, left: 20 } };
  const textWidth = Math.round((page.width - page.margin.left - page.margin.right) / HWPUNIT_MM);
  const rows = block.rows.length;
  const cols = Math.max(...block.rows.map((row) => row.length));
  const widths = Array.from({ length: cols }, (_, c) => Math.round(textWidth * (block.colWidths?.[c] ?? 1 / cols)));
  const rowHeight = 1800;
  const border = ctx.header.solidBorderFill();
  const paraPr = template ? attr(template, "paraPrIDRef") ?? "0" : "0";
  const styleId = template ? attr(template, "styleIDRef") ?? "0" : "0";
  const templateRun = template ? runs(template)[0] : undefined;
  const charPr = templateRun ? attr(templateRun, "charPrIDRef") ?? "0" : "0";
  // A merged range is one tc at its anchor with cellSpan; the positions it covers have no tc (null in the model).
  const cells = block.rows.map((row, r) => `<${prefix}tr>${Array.from({ length: cols }, (_, c) => {
    const cell = row[c];
    if (!cell) return "";
    const text = cell.text;
    const colSpan = cell.colSpan ?? 1, rowSpan = cell.rowSpan ?? 1;
    const width = widths.slice(c, c + colSpan).reduce((sum, w) => sum + w, 0);
    const fill = cell.format?.fill ? ctx.header.borderFillFor(border, cell.format.fill) : border;
    return `<${prefix}tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${fill}">`
      + `<${prefix}subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">`
      + `<${prefix}p id="0" paraPrIDRef="${escapeXmlAttr(paraPr)}" styleIDRef="${escapeXmlAttr(styleId)}" pageBreak="0" columnBreak="0" merged="0"><${prefix}run charPrIDRef="${escapeXmlAttr(charPr)}">${textMarkup(prefix, text)}</${prefix}run></${prefix}p>`
      + `</${prefix}subList><${prefix}cellAddr colAddr="${c}" rowAddr="${r}"/><${prefix}cellSpan colSpan="${colSpan}" rowSpan="${rowSpan}"/><${prefix}cellSz width="${width}" height="${rowHeight * rowSpan}"/><${prefix}cellMargin left="510" right="510" top="141" bottom="141"/></${prefix}tc>`;
  }).join("")}</${prefix}tr>`).join("");
  const id = 1_900_000_000 + (++tableSerial);
  const markup = `<${prefix}p id="0" paraPrIDRef="${escapeXmlAttr(paraPr)}" styleIDRef="${escapeXmlAttr(styleId)}" pageBreak="0" columnBreak="0" merged="0"><${prefix}run charPrIDRef="${escapeXmlAttr(charPr)}">`
    + `<${prefix}tbl id="${id}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="${rows}" colCnt="${cols}" cellSpacing="0" borderFillIDRef="${border}" noAdjust="0">`
    + `<${prefix}sz width="${widths.reduce((a, b) => a + b, 0)}" widthRelTo="ABSOLUTE" height="${rowHeight * rows}" heightRelTo="ABSOLUTE" protect="0"/>`
    + `<${prefix}pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>`
    + `<${prefix}outMargin left="0" right="0" top="0" bottom="0"/><${prefix}inMargin left="510" right="510" top="141" bottom="141"/>${cells}</${prefix}tbl><${prefix}t/></${prefix}run></${prefix}p>`;
  const built = createElement(markup);
  // Character/paragraph formats of the new cells (bold header row etc.): each cell reads back with exactly its model
  // format, not the template paragraph's.
  const table = firstTable(built)!;
  const trs = elements(table).filter((node) => localName(node) === "tr");
  block.rows.forEach((row, r) => row.forEach((cell, c) => {
    if (!cell) return;
    const { fill: _fill, ...wanted } = cell.format ?? {};
    // Index among this row's tcs: covered positions before c have no tc.
    const tc = elements(trs[r]).filter((node) => localName(node) === "tc")[row.slice(0, c).filter(Boolean).length];
    for (const p of cellParagraphs(tc).paragraphs) {
      const { fill: _has, ...current } = paragraphFormat(ctx.header, p) ?? {};
      const delta = formatDelta(current, wanted);
      if (isEmptyFormat(delta)) continue;
      setParagraphFormat(ctx.header, null, p, delta);
      markPath(built, p);
    }
  }));
  return built;
}

/** Heading: the Outline N style with its paragraph/character shapes; 0 returns to the body style (id 0). */
function setHeading(ctx: HwpxContext, root: XmlElement, paragraph: XmlElement, level: number): void {
  const style = level > 0 ? ctx.outlineStyle.get(level) : undefined;
  setAttr(paragraph, "styleIDRef", style?.id ?? "0");
  if (style) {
    setAttr(paragraph, "paraPrIDRef", style.paraPr);
    for (const run of runs(paragraph)) if (elements(run).some((node) => localName(node) === "t")) setAttr(run, "charPrIDRef", style.charPr);
  }
  dropLineSegments(paragraph);
  markPath(root, paragraph);
}

function setCellText(root: XmlElement, tc: XmlElement, text: string): void {
  const { subList, paragraphs } = cellParagraphs(tc);
  if (!subList) return;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (paragraphs[i]) { setParagraphText(root, paragraphs[i], lines[i]); continue; }
    const template = paragraphs[paragraphs.length - 1];
    const prefix = template ? prefixOf(template) : prefixOf(subList);
    const charPr = template ? (runs(template)[0] ? attr(runs(template)[0], "charPrIDRef") : "0") ?? "0" : "0";
    const fresh = createElement(`<${prefix}p id="0" paraPrIDRef="${escapeXmlAttr(template ? attr(template, "paraPrIDRef") ?? "0" : "0")}" styleIDRef="${escapeXmlAttr(template ? attr(template, "styleIDRef") ?? "0" : "0")}" pageBreak="0" columnBreak="0" merged="0"><${prefix}run charPrIDRef="${escapeXmlAttr(charPr)}">${textMarkup(prefix, lines[i])}</${prefix}run></${prefix}p>`);
    subList.children.splice(template ? subList.children.indexOf(template) + 1 : subList.children.length, 0, fresh);
    paragraphs.push(fresh);
  }
  for (const extra of paragraphs.slice(lines.length)) subList.children.splice(subList.children.indexOf(extra), 1);
  markDirty(subList);
  markPath(root, subList);
}

function previewText(blocks: LiveFlowBlock[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.type === "paragraph") lines.push(block.text);
    else if (block.type === "table") lines.push(block.rows.map((row) => row.map((cell) => cell ? `<${cell.text}>` : "").join("")).join("\r\n"));
    if (lines.join("\r\n").length > 1024) break;
  }
  return lines.join("\r\n").slice(0, 1024);
}

export const hwpxCodec: LiveDocumentCodec = {
  parse(bytes) {
    const ctx = load(bytes);
    return { kind: "flow", blocks: ctx.model, ...(ctx.page ? { page: ctx.page } : {}), ...(ctx.defaultSize ? { defaultSize: ctx.defaultSize } : {}) };
  },
  write(bytes, original, final) {
    const ctx = load(bytes);
    const before = new Map(flowBlocks(original).map((block) => [block.id, block]));
    const finalBlocks = flowBlocks(final);
    const finalById = new Map(finalBlocks.map((block) => [block.id, block]));
    const touched = new Set<number>();

    for (const [id, where] of ctx.blocks) {
      const after = finalById.get(id);
      const prior = before.get(id);
      const root = ctx.sections[where.section].doc.root;
      if (!after) { touched.add(where.section); continue; }
      if (!blockChanged(prior, after)) continue;
      if (after.type === "paragraph" && prior?.type === "paragraph") {
        if (prior.text !== after.text) setParagraphText(root, where.element, after.text);
        if ((prior.heading ?? 0) !== (after.heading ?? 0)) setHeading(ctx, root, where.element, after.heading ?? 0);
        const delta = formatDelta(prior.format, after.format);
        if (!isEmptyFormat(delta)) setParagraphFormat(ctx.header, root, where.element, delta);
        touched.add(where.section);
      }
      if (after.type === "table" && prior?.type === "table") {
        const table = firstTable(where.element);
        if (!table) continue;
        const layout = tableLayout(table, id);
        const priorCells = new Map(prior.rows.flat().filter((cell): cell is LiveTableCell => !!cell).map((cell) => [cell.id, cell]));
        for (const cell of after.rows.flat()) {
          if (!cell) continue;
          const old = priorCells.get(cell.id);
          const tc = layout.cells.get(cell.id);
          if (!tc) continue;
          if (old?.text !== cell.text) { setCellText(root, tc, cell.text); touched.add(where.section); }
          const { fill, ...delta } = formatDelta(old?.format, cell.format);
          if (fill !== undefined) { setAttr(tc, "borderFillIDRef", ctx.header.borderFillFor(attr(tc, "borderFillIDRef") ?? "1", fill)); markPath(root, tc); touched.add(where.section); }
          if (!isEmptyFormat(delta)) { for (const p of cellParagraphs(tc).paragraphs) setParagraphFormat(ctx.header, root, p, delta); touched.add(where.section); }
        }
      }
    }

    const plan = planFlowInsertions(new Set(ctx.blocks.keys()), finalBlocks);
    if (plan.size) {
      for (const [anchor] of plan) touched.add(anchor === "^" ? 0 : ctx.blocks.get(anchor)!.section);
    }
    const ids = [...ctx.blocks.keys()];
    const templateFor = (anchorId: string): XmlElement | undefined => {
      const start = anchorId === "^" ? -1 : ids.indexOf(anchorId);
      const plain = (id: string) => { const block = before.get(id); return block?.type === "paragraph" && !block.heading && !block.fixed; };
      // The template is the paragraph as it was in the file, not as this save already rewrote it.
      const pristine = (id: string) => { const element = ctx.blocks.get(id)!.element; return createElement(element.src.slice(element.start, element.end)); };
      for (let i = start; i >= 0; i--) if (plain(ids[i])) return pristine(ids[i]);
      const any = ids.find(plain);
      return any ? pristine(any) : undefined;
    };
    const elementToId = new Map([...ctx.blocks].map(([id, where]) => [where.element, id]));
    for (const index of touched) {
      const { doc } = ctx.sections[index];
      const root = doc.root;
      const prefix = prefixOf(elements(root).find((el) => localName(el) === "p") ?? root).replace(/^hs:/, "hp:");
      const children: XmlNode[] = [];
      let leading = index === 0 ? plan.get("^") ?? [] : [];
      const build = (block: LiveFlowBlock, anchor: string): XmlElement | null => {
        if (block.type === "table") return newTable(ctx, templateFor(anchor), prefix, block);
        if (block.type !== "paragraph") return null;
        const built = newParagraph(ctx, templateFor(anchor), prefix, block.text, block.heading);
        if (block.pageBreak === "before") setAttr(built, "pageBreak", "1");
        // A body paragraph reads back with exactly its model format, not the template's; a heading keeps its style.
        const delta = block.heading ? block.format ?? {} : formatDelta(paragraphFormat(ctx.header, built), block.format);
        if (!isEmptyFormat(delta)) setParagraphFormat(ctx.header, null, built, delta);
        return built;
      };
      for (const node of root.children) {
        const id = node.type === "el" ? elementToId.get(node) : undefined;
        if (!id) { children.push(node); continue; }
        if (leading.length && !(before.get(id) as { fixed?: boolean } | undefined)?.fixed) {
          for (const block of leading) { const built = build(block, "^"); if (built) children.push(built); }
          leading = [];
        }
        if (finalById.has(id)) children.push(node);
        if (leading.length) { for (const block of leading) { const built = build(block, "^"); if (built) children.push(built); } leading = []; }
        for (const block of plan.get(id) ?? []) { const built = build(block, id); if (built) children.push(built); }
      }
      for (const block of leading) { const built = build(block, "^"); if (built) children.push(built); }
      root.children = children;
      markDirty(root);
      ctx.pkg.setText(ctx.sections[index].part, serializeXml(doc));
    }
    if (!touched.size) return bytes;
    if (ctx.header.changed && ctx.header.doc) ctx.pkg.setText("Contents/header.xml", serializeXml(ctx.header.doc));
    if (ctx.pkg.has("Preview/PrvText.txt")) ctx.pkg.setText("Preview/PrvText.txt", previewText(finalBlocks));
    return ctx.pkg.toBytes();
  },
};
