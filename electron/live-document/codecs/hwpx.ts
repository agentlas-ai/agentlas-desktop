import type { LiveFlowBlock, LiveFormat, LiveFormatPatch, LiveTableCell } from "../../../shared/live-document";
import { ZipPackage } from "../zip";
import {
  attr, createElement, elements, escapeXmlAttr, escapeXmlText, localName, markDirty, markPath, parseXml, serializeNode, serializeXml,
  setAttr, textContent, type XmlDocument, type XmlElement, type XmlNode,
} from "../xml-lite";
import { blockChanged, flowBlocks, LiveDocumentCodecError, planFlowInsertions, type LiveDocumentCodec } from "./common";
import { el, formatDelta, isEmptyFormat, normColor, removeChildren } from "./format";

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
        else if (name === "charPr" && attr(child, "id") !== undefined) this.charPr.set(attr(child, "id")!, child);
        else if (name === "paraPr" && attr(child, "id") !== undefined) this.paraPr.set(attr(child, "id")!, child);
        if (!["charPr", "paraPr"].includes(name)) walk(child);
      }
    };
    walk(this.doc.root);
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

interface TableLayout { rows: Array<Array<LiveTableCell | null>>; cells: Map<string, XmlElement> }

function tableLayout(tbl: XmlElement, tableId: string, header?: HwpxHeader): TableLayout {
  const cellsByPos: Array<{ row: number; col: number; colSpan: number; rowSpan: number; tc: XmlElement }> = [];
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
    const format = header && paragraphs[0] ? paragraphFormat(header, paragraphs[0]) : undefined;
    if (rows[item.row]) rows[item.row][item.col] = { id, text, ...(item.colSpan > 1 ? { colSpan: item.colSpan } : {}), ...(item.rowSpan > 1 ? { rowSpan: item.rowSpan } : {}), ...(format ? { format } : {}) };
    cells.set(id, item.tc);
  }
  return { rows, cells };
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
      if (table) model.push({ id, type: "table", rows: tableLayout(table, id, header).rows, ...(hasSection(paragraph) ? { fixed: true } : {}) });
      else if (!text.trim() && hasObject(paragraph)) model.push({ id, type: "object", label: "image" });
      else {
        const heading = styles.outline.get(attr(paragraph, "styleIDRef") ?? "");
        const format = paragraphFormat(header, paragraph);
        model.push({ id, type: "paragraph", text, ...(heading ? { heading } : {}), ...(hasSection(paragraph) ? { fixed: true } : {}), ...(format ? { format } : {}) });
      }
    }
  });
  return { pkg, sections, blocks, model, ...styles, header };
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
    return { kind: "flow", blocks: load(bytes).model };
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
          const delta = formatDelta(old?.format, cell.format);
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
      for (let i = start; i >= 0; i--) if (plain(ids[i])) return ctx.blocks.get(ids[i])!.element;
      const any = ids.find(plain);
      return any ? ctx.blocks.get(any)!.element : undefined;
    };
    const elementToId = new Map([...ctx.blocks].map(([id, where]) => [where.element, id]));
    for (const index of touched) {
      const { doc } = ctx.sections[index];
      const root = doc.root;
      const prefix = prefixOf(elements(root).find((el) => localName(el) === "p") ?? root).replace(/^hs:/, "hp:");
      const children: XmlNode[] = [];
      let leading = index === 0 ? plan.get("^") ?? [] : [];
      const build = (block: LiveFlowBlock, anchor: string): XmlElement | null => {
        if (block.type !== "paragraph") return null;
        const built = newParagraph(ctx, templateFor(anchor), prefix, block.text, block.heading);
        if (block.format) setParagraphFormat(ctx.header, null, built, block.format);
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
