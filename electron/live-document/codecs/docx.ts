import type { LiveFlowBlock, LiveFormat, LiveFormatPatch, LiveTableCell } from "../../../shared/live-document";
import { ZipPackage } from "../zip";
import {
  attr, createElement, elements, escapeXmlText, firstElement, localName, markDirty, markPath, parseXml,
  serializeNode, serializeXml, type XmlDocument, type XmlElement, type XmlNode,
} from "../xml-lite";
import { blockChanged, flowBlocks, LiveDocumentCodecError, planFlowInsertions, type LiveDocumentCodec } from "./common";
import { el, formatDelta, hex6, insertOrdered, isEmptyFormat, normColor, removeChildren } from "./format";

// CT_RPr / CT_PPr child sequences (ECMA-376 §17.3.2.28 / §17.3.1.26): Word rejects children out of order.
const RPR_ORDER = ["rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline", "shadow", "emboss", "imprint", "noProof", "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern", "position", "sz", "szCs", "highlight", "u", "effect", "bdr", "shd", "fitText", "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout", "specVanish", "oMath"];
const PPR_ORDER = ["pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr", "widowControl", "numPr", "suppressLineNumbers", "pBdr", "shd", "tabs", "suppressAutoHyphens", "kinsoku", "wordWrap", "overflowPunct", "topLinePunct", "autoSpaceDE", "autoSpaceDN", "bidi", "adjustRightInd", "snapToGrid", "spacing", "ind", "contextualSpacing", "mirrorIndents", "suppressOverlap", "jc", "textDirection", "textAlignment", "textboxTightWrap", "outlineLvl", "divId", "cnfStyle", "rPr", "sectPr", "pPrChange"];
const JC_IN: Record<string, LiveFormat["align"]> = { left: "left", start: "left", center: "center", right: "right", end: "right", both: "justify", distribute: "justify" };
const JC_OUT: Record<NonNullable<LiveFormat["align"]>, string> = { left: "left", center: "center", right: "right", justify: "both" };

const onOff = (node: XmlElement | undefined): boolean | undefined => node ? !["0", "false", "off"].includes(attr(node, "w:val") ?? "true") : undefined;

/** Format of a paragraph: its first text run's character properties and its justification. */
export function docxParagraphFormat(paragraph: XmlElement): LiveFormat | undefined {
  const format: LiveFormat = {};
  const run = textRuns(paragraph)[0]?.run;
  const rPr = run ? firstElement(run, "w:rPr") : undefined;
  if (rPr) {
    if (onOff(firstElement(rPr, "w:b"))) format.bold = true;
    if (onOff(firstElement(rPr, "w:i"))) format.italic = true;
    const u = firstElement(rPr, "w:u");
    if (u && (attr(u, "w:val") ?? "single") !== "none") format.underline = true;
    const sz = Number(attr(firstElement(rPr, "w:sz") ?? rPr, "w:val"));
    if (Number.isFinite(sz) && sz > 0) format.size = sz / 2;
    const color = normColor(attr(firstElement(rPr, "w:color") ?? rPr, "w:val"));
    if (color) format.color = color;
  }
  const pPr = firstElement(paragraph, "w:pPr");
  const jc = pPr ? JC_IN[attr(firstElement(pPr, "w:jc") ?? pPr, "w:val") ?? ""] : undefined;
  if (jc && jc !== "left") format.align = jc;
  return isEmptyFormat(format) ? undefined : format;
}

function setRunFormat(run: XmlElement, delta: LiveFormatPatch): void {
  let rPr = firstElement(run, "w:rPr");
  if (!rPr) { rPr = el("<w:rPr/>"); run.children.unshift(rPr); markDirty(run); }
  const toggle = (name: string, value: boolean | null | undefined, cs?: string) => {
    if (value === undefined) return;
    removeChildren(rPr!, name, ...(cs ? [cs] : []));
    if (value) { insertOrdered(rPr!, el(`<w:${name}/>`), RPR_ORDER); if (cs) insertOrdered(rPr!, el(`<w:${cs}/>`), RPR_ORDER); }
  };
  toggle("b", delta.bold, "bCs");
  toggle("i", delta.italic, "iCs");
  if (delta.underline !== undefined) { removeChildren(rPr, "u"); if (delta.underline) insertOrdered(rPr, el('<w:u w:val="single"/>'), RPR_ORDER); }
  if (delta.size !== undefined) {
    removeChildren(rPr, "sz", "szCs");
    if (delta.size !== null) {
      const half = Math.round(delta.size * 2);
      insertOrdered(rPr, el(`<w:sz w:val="${half}"/>`), RPR_ORDER);
      insertOrdered(rPr, el(`<w:szCs w:val="${half}"/>`), RPR_ORDER);
    }
  }
  if (delta.color !== undefined) { removeChildren(rPr, "color"); if (delta.color !== null) insertOrdered(rPr, el(`<w:color w:val="${hex6(delta.color)}"/>`), RPR_ORDER); }
  markDirty(rPr, run);
}

/** Applies a format change to every text run of a paragraph (and its justification); heading sets/removes the style. */
function setParagraphFormat(ctx: Pick<DocxContext, "styleForHeading" | "headingByStyle">, root: XmlElement | null, paragraph: XmlElement, delta: LiveFormatPatch, heading?: number): void {
  for (const { run } of textRuns(paragraph)) setRunFormat(run, delta);
  if (delta.align !== undefined || heading !== undefined) {
    let pPr = firstElement(paragraph, "w:pPr");
    if (!pPr) { pPr = el("<w:pPr/>"); paragraph.children.unshift(pPr); }
    if (delta.align !== undefined) { removeChildren(pPr, "jc"); if (delta.align !== null) insertOrdered(pPr, el(`<w:jc w:val="${JC_OUT[delta.align]}"/>`), PPR_ORDER); }
    if (heading !== undefined) {
      removeChildren(pPr, "pStyle");
      if (heading > 0) insertOrdered(pPr, el(`<w:pStyle w:val="${escapeXmlText(ctx.styleForHeading.get(heading) ?? `Heading${heading}`)}"/>`), PPR_ORDER);
    }
    markDirty(pPr);
  }
  markDirty(paragraph);
  if (root) markPath(root, paragraph);
}

/*
 * DOCX: word/document.xml body children become blocks (paragraph, table, object). A changed paragraph keeps its
 * paragraph properties, the first text run's formatting and every non-text run (drawings, fields, page breaks);
 * only the text runs are replaced. Untouched paragraphs, tables and the section properties are copied verbatim.
 */

const DOCUMENT_PART = "word/document.xml";
const SKIP_SUBTREES = new Set(["pPr", "rPr", "del", "moveFrom", "instrText", "fldData", "txbxContent", "drawing", "pict", "object", "AlternateContent", "tblPr", "tcPr", "trPr"]);
const OBJECT_MARKERS = new Set(["drawing", "pict", "object", "AlternateContent"]);
const SPECIAL_RUN_CHILDREN = new Set(["drawing", "pict", "object", "AlternateContent", "fldChar", "instrText", "footnoteReference", "endnoteReference", "commentReference", "sym", "ptab", "fldSimple"]);

interface DocxContext {
  pkg: ZipPackage;
  doc: XmlDocument;
  body: XmlElement;
  headingByStyle: Map<string, number>;
  styleForHeading: Map<number, string>;
  /** block id -> body child element */
  blocks: Map<string, XmlElement>;
  model: LiveFlowBlock[];
}

function hasDescendant(element: XmlElement, names: Set<string>, skip: Set<string> = new Set()): boolean {
  for (const child of element.children) {
    if (child.type !== "el") continue;
    const name = localName(child);
    if (names.has(name)) return true;
    if (skip.has(name)) continue;
    if (hasDescendant(child, names, skip)) return true;
  }
  return false;
}

export function docxParagraphText(paragraph: XmlElement): string {
  let text = "";
  const walk = (element: XmlElement) => {
    for (const child of element.children) {
      if (child.type !== "el") continue;
      const name = localName(child);
      if (SKIP_SUBTREES.has(name)) continue;
      if (name === "t") text += textOf(child);
      else if (name === "tab") text += "\t";
      else if ((name === "br" && !["page", "column"].includes(attr(child, "w:type") ?? "")) || name === "cr") text += "\n";
      else if (name === "noBreakHyphen") text += "-";
      else walk(child);
    }
  };
  walk(paragraph);
  return text;
}

function textOf(element: XmlElement): string {
  return element.children.map((node) => node.type === "text" ? decode(node.src.slice(node.start, node.end)) : "").join("");
}

function decode(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (whole, body: string) => {
    if (body === "amp") return "&"; if (body === "lt") return "<"; if (body === "gt") return ">"; if (body === "quot") return "\""; if (body === "apos") return "'";
    const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
  });
}

function readStyles(pkg: ZipPackage): { headingByStyle: Map<string, number>; styleForHeading: Map<number, string> } {
  const headingByStyle = new Map<string, number>();
  const styleForHeading = new Map<number, string>();
  const xml = pkg.text("word/styles.xml");
  if (!xml) return { headingByStyle, styleForHeading };
  const doc = parseXml(xml);
  for (const style of elements(doc.root, "w:style")) {
    if (attr(style, "w:type") !== "paragraph") continue;
    const id = attr(style, "w:styleId");
    const name = firstElement(style, "w:name");
    const value = name ? (attr(name, "w:val") ?? "") : "";
    const match = /^heading\s*([1-6])$/i.exec(value.trim());
    const level = match ? Number(match[1]) : value.trim().toLowerCase() === "title" ? 1 : 0;
    if (id && level) {
      headingByStyle.set(id, level);
      if (match && !styleForHeading.has(level)) styleForHeading.set(level, id);
    }
  }
  return { headingByStyle, styleForHeading };
}

function paragraphHeading(paragraph: XmlElement, headingByStyle: Map<string, number>): number | undefined {
  const pPr = firstElement(paragraph, "w:pPr");
  if (!pPr) return undefined;
  const style = firstElement(pPr, "w:pStyle");
  const styleId = style ? attr(style, "w:val") : undefined;
  if (styleId && headingByStyle.has(styleId)) return headingByStyle.get(styleId);
  if (styleId && /^heading([1-6])$/i.test(styleId)) return Number(styleId.slice(-1));
  const outline = firstElement(pPr, "w:outlineLvl");
  const level = outline ? Number(attr(outline, "w:val")) : Number.NaN;
  return Number.isInteger(level) && level >= 0 && level < 6 ? level + 1 : undefined;
}

interface TableLayout {
  cells: Array<{ cell: LiveTableCell; tc: XmlElement; row: number; col: number }>;
  rows: Array<Array<LiveTableCell | null>>;
}

function tableLayout(tbl: XmlElement, tableId: string): TableLayout {
  const rows: Array<Array<LiveTableCell | null>> = [];
  const cells: TableLayout["cells"] = [];
  const open = new Map<number, LiveTableCell>(); // grid col -> vertically merged origin
  elements(tbl, "w:tr").forEach((tr, rowIndex) => {
    const row: Array<LiveTableCell | null> = [];
    const trPr = firstElement(tr, "w:trPr");
    const gridBefore = trPr ? firstElement(trPr, "w:gridBefore") : undefined;
    const before = gridBefore ? Number(attr(gridBefore, "w:val") ?? 0) || 0 : 0;
    let col = 0;
    for (; col < before; col++) row.push(null);
    for (const tc of elements(tr, "w:tc")) {
      const tcPr = firstElement(tc, "w:tcPr");
      const span = Math.max(1, Number(tcPr && firstElement(tcPr, "w:gridSpan") ? attr(firstElement(tcPr, "w:gridSpan")!, "w:val") : 1) || 1);
      const vMerge = tcPr ? firstElement(tcPr, "w:vMerge") : undefined;
      const continuation = vMerge !== undefined && (attr(vMerge, "w:val") ?? "continue") === "continue";
      if (continuation && open.has(col)) {
        const origin = open.get(col)!;
        origin.rowSpan = (origin.rowSpan ?? 1) + 1;
        for (let k = 0; k < span; k++) row.push(null);
      } else {
        const text = elements(tc, "w:p").map(docxParagraphText).join("\n");
        const first = elements(tc, "w:p")[0];
        const format = first ? docxParagraphFormat(first) : undefined;
        const cell: LiveTableCell = { id: `${tableId}.r${rowIndex + 1}c${col + 1}`, text, ...(span > 1 ? { colSpan: span } : {}), ...(format ? { format } : {}) };
        if (vMerge) open.set(col, cell); else open.delete(col);
        cells.push({ cell, tc, row: rowIndex, col });
        row.push(cell);
        for (let k = 1; k < span; k++) row.push(null);
      }
      col += span;
    }
    rows.push(row);
  });
  const width = Math.max(0, ...rows.map((row) => row.length));
  for (const row of rows) while (row.length < width) row.push(null);
  return { cells, rows };
}

function load(bytes: Uint8Array): DocxContext {
  const pkg = new ZipPackage(bytes);
  const xml = pkg.text(DOCUMENT_PART);
  if (!xml) throw new LiveDocumentCodecError("docx_document_missing");
  const doc = parseXml(xml);
  if (doc.root.name !== "w:document") throw new LiveDocumentCodecError("docx_namespace_unsupported", doc.root.name);
  const body = firstElement(doc.root, "w:body");
  if (!body) throw new LiveDocumentCodecError("docx_body_missing");
  const { headingByStyle, styleForHeading } = readStyles(pkg);
  const blocks = new Map<string, XmlElement>();
  const model: LiveFlowBlock[] = [];
  let counter = 0;
  for (const child of elements(body)) {
    const name = localName(child);
    if (name === "sectPr" || name === "bookmarkStart" || name === "bookmarkEnd" || name === "proofErr" || name === "permStart" || name === "permEnd") continue;
    const id = `b${++counter}`;
    if (name === "p") {
      const text = docxParagraphText(child);
      if (!text.trim() && hasDescendant(child, OBJECT_MARKERS)) model.push({ id, type: "object", label: "image" });
      else {
        const heading = paragraphHeading(child, headingByStyle);
        const format = docxParagraphFormat(child);
        model.push({ id, type: "paragraph", text, ...(heading ? { heading } : {}), ...(format ? { format } : {}) });
      }
    } else if (name === "tbl") {
      model.push({ id, type: "table", rows: tableLayout(child, id).rows });
    } else {
      const preview = elements(child).length ? collectText(child).slice(0, 80) : "";
      model.push({ id, type: "object", label: preview ? `${name}: ${preview}` : name });
    }
    blocks.set(id, child);
  }
  return { pkg, doc, body, headingByStyle, styleForHeading, blocks, model };
}

function collectText(element: XmlElement): string {
  return descendantsOf(element, "w:p").map(docxParagraphText).join(" ").replace(/\s+/g, " ").trim();
}

function descendantsOf(element: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (node: XmlElement) => { for (const child of elements(node)) { if (child.name === name) out.push(child); else walk(child); } };
  walk(element);
  return out;
}

/** Text runs (with the element that holds each) — the runs a text edit may replace. */
function textRuns(paragraph: XmlElement): Array<{ run: XmlElement; parent: XmlElement }> {
  const out: Array<{ run: XmlElement; parent: XmlElement }> = [];
  const walk = (element: XmlElement) => {
    for (const child of elements(element)) {
      const name = localName(child);
      if (name === "r") {
        const kids = elements(child).map(localName);
        const special = kids.some((kid) => SPECIAL_RUN_CHILDREN.has(kid))
          || elements(child).some((kid) => localName(kid) === "br" && ["page", "column"].includes(attr(kid, "w:type") ?? ""));
        if (!special && kids.some((kid) => kid === "t" || kid === "tab" || kid === "br" || kid === "cr" || kid === "noBreakHyphen")) out.push({ run: child, parent: element });
      } else if (name === "hyperlink" || name === "smartTag" || name === "ins" || name === "customXml" || name === "sdtContent" || name === "sdt") walk(child);
    }
  };
  walk(paragraph);
  return out;
}

function runMarkup(text: string, rPr: string): string {
  if (!text) return "";
  let content = "";
  const parts = text.replace(/\r/g, "").split(/(\n|\t)/);
  for (const part of parts) {
    if (part === "\n") content += "<w:br/>";
    else if (part === "\t") content += "<w:tab/>";
    else if (part) content += `<w:t xml:space="preserve">${escapeXmlText(part)}</w:t>`;
  }
  return `<w:r>${rPr}${content}</w:r>`;
}

function setParagraphText(root: XmlElement, paragraph: XmlElement, text: string): void {
  const runs = textRuns(paragraph);
  const rPrSource = runs.length ? firstElement(runs[0].run, "w:rPr") : undefined;
  const rPr = rPrSource ? serializeNode(rPrSource) : "";
  const markup = runMarkup(text, rPr);
  const replacement = markup ? createElement(markup) : null;
  if (runs.length) {
    const { parent, run } = runs[0];
    if (replacement) parent.children.splice(parent.children.indexOf(run), 0, replacement);
    for (const item of runs) item.parent.children.splice(item.parent.children.indexOf(item.run), 1);
    for (const item of runs) markPath(root, item.parent);
  } else if (replacement) {
    paragraph.children.push(replacement);
  }
  markPath(root, paragraph);
}

/** A fresh paragraph carrying the template's paragraph properties (minus section breaks) and run formatting. */
function newParagraph(ctx: DocxContext, template: XmlElement | undefined, text: string, heading: number | undefined): XmlElement {
  const templatePPr = template ? firstElement(template, "w:pPr") : undefined;
  const kept = (templatePPr ? elements(templatePPr) : []).filter((node) => {
    const name = localName(node);
    if (name === "sectPr") return false;
    if (name === "pStyle") return !heading && !isHeadingStyle(ctx, node);
    if (name === "numPr") return !heading;
    return true;
  }).map(serializeNode);
  if (heading) kept.unshift(`<w:pStyle w:val="${escapeXmlText(ctx.styleForHeading.get(heading) ?? `Heading${heading}`)}"/>`);
  const pPr = kept.length ? `<w:pPr>${kept.join("")}</w:pPr>` : "";
  const runs = template && !heading ? textRuns(template) : [];
  const rPrSource = runs.length ? firstElement(runs[0].run, "w:rPr") : undefined;
  return createElement(`<w:p>${pPr}${runMarkup(text, rPrSource ? serializeNode(rPrSource) : "")}</w:p>`);
}

function isHeadingStyle(ctx: DocxContext, pStyle: XmlNode): boolean {
  if (pStyle.type !== "el") return false;
  const value = attr(pStyle, "w:val") ?? "";
  return ctx.headingByStyle.has(value) || /^heading[1-6]$/i.test(value);
}

function newTable(rows: string[][]): XmlElement {
  const columns = Math.max(...rows.map((row) => row.length));
  const width = Math.floor(9000 / columns);
  const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`;
  const grid = Array.from({ length: columns }, () => `<w:gridCol w:w="${width}"/>`).join("");
  const body = rows.map((row) => `<w:tr>${row.map((text) => `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr><w:p>${runMarkup(text, "")}</w:p></w:tc>`).join("")}</w:tr>`).join("");
  return createElement(`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("")}</w:tblBorders><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`);
}

function setCellText(root: XmlElement, tc: XmlElement, text: string): void {
  const lines = text.split("\n");
  const paragraphs = elements(tc, "w:p");
  for (let i = 0; i < lines.length; i++) {
    if (paragraphs[i]) { setParagraphText(root, paragraphs[i], lines[i]); continue; }
    const template = paragraphs[paragraphs.length - 1];
    const pPr = template ? firstElement(template, "w:pPr") : undefined;
    const runs = template ? textRuns(template) : [];
    const rPr = runs.length ? firstElement(runs[0].run, "w:rPr") : undefined;
    const fresh = createElement(`<w:p>${pPr ? serializeNode(pPr) : ""}${runMarkup(lines[i], rPr ? serializeNode(rPr) : "")}</w:p>`);
    const anchor = paragraphs[paragraphs.length - 1];
    tc.children.splice(anchor ? tc.children.indexOf(anchor) + 1 : tc.children.length, 0, fresh);
    paragraphs.push(fresh);
  }
  for (const extra of paragraphs.slice(lines.length)) tc.children.splice(tc.children.indexOf(extra), 1);
  // A cell must end with a paragraph.
  if (elements(tc).at(-1)?.name !== "w:p") tc.children.push(createElement("<w:p/>"));
  markPath(root, tc);
}

export const docxCodec: LiveDocumentCodec = {
  parse(bytes) {
    return { kind: "flow", blocks: load(bytes).model };
  },
  write(bytes, original, final) {
    const ctx = load(bytes);
    const before = new Map(flowBlocks(original).map((block) => [block.id, block]));
    const finalBlocks = flowBlocks(final);
    const finalById = new Map(finalBlocks.map((block) => [block.id, block]));
    const root = ctx.doc.root;

    for (const [id, element] of ctx.blocks) {
      const after = finalById.get(id);
      if (!after || !blockChanged(before.get(id), after)) continue;
      const prior = before.get(id);
      if (after.type === "paragraph" && prior?.type === "paragraph") {
        if (prior.text !== after.text) setParagraphText(root, element, after.text);
        const delta = formatDelta(prior.format, after.format);
        const heading = (prior.heading ?? 0) !== (after.heading ?? 0) ? after.heading ?? 0 : undefined;
        if (!isEmptyFormat(delta) || heading !== undefined) setParagraphFormat(ctx, root, element, delta, heading);
      }
      if (after.type === "table" && prior?.type === "table") {
        const layout = tableLayout(element, id);
        const priorCells = new Map(prior.rows.flat().filter((cell): cell is LiveTableCell => !!cell).map((cell) => [cell.id, cell]));
        for (const cell of after.rows.flat()) {
          if (!cell) continue;
          const old = priorCells.get(cell.id);
          const target = layout.cells.find((item) => item.cell.id === cell.id);
          if (!target) continue;
          if (old?.text !== cell.text) setCellText(root, target.tc, cell.text);
          const delta = formatDelta(old?.format, cell.format);
          if (!isEmptyFormat(delta)) { for (const p of elements(target.tc, "w:p")) setParagraphFormat(ctx, null, p, delta); markPath(root, target.tc); }
        }
      }
    }

    const plan = planFlowInsertions(new Set(ctx.blocks.keys()), finalBlocks);
    const elementToId = new Map([...ctx.blocks].map(([id, element]) => [element, id]));
    const templateFor = (anchorId: string): XmlElement | undefined => {
      const ids = [...ctx.blocks.keys()];
      const start = anchorId === "^" ? -1 : ids.indexOf(anchorId);
      for (let i = start; i >= 0; i--) { const block = before.get(ids[i]); if (block?.type === "paragraph" && !block.heading) return ctx.blocks.get(ids[i]); }
      for (const id of ids) { const block = before.get(id); if (block?.type === "paragraph" && !block.heading) return ctx.blocks.get(id); }
      return undefined;
    };
    const build = (block: LiveFlowBlock, anchorId: string): XmlElement | null => {
      if (block.type === "paragraph") {
        const built = newParagraph(ctx, templateFor(anchorId), block.text, block.heading);
        if (block.format) setParagraphFormat(ctx, null, built, block.format);
        return built;
      }
      if (block.type === "table") {
        const built = newTable(block.rows.map((row) => row.map((cell) => cell?.text ?? "")));
        const cells = elements(built, "w:tr").flatMap((tr) => elements(tr, "w:tc"));
        block.rows.flat().forEach((cell, index) => { if (cell?.format && cells[index]) for (const p of elements(cells[index], "w:p")) setParagraphFormat(ctx, null, p, cell.format); });
        return built;
      }
      return null;
    };
    const children: XmlNode[] = [];
    let leadingDone = false;
    const emitLeading = () => {
      if (leadingDone) return;
      leadingDone = true;
      for (const block of plan.get("^") ?? []) { const built = build(block, "^"); if (built) children.push(built); }
    };
    for (const node of ctx.body.children) {
      const id = node.type === "el" ? elementToId.get(node) : undefined;
      if (node.type === "el" && (id || localName(node) === "sectPr")) emitLeading();
      if (!id) { children.push(node); continue; }
      if (finalById.has(id)) children.push(node);
      for (const block of plan.get(id) ?? []) { const built = build(block, id); if (built) children.push(built); }
    }
    emitLeading();
    // Word expects a paragraph after a table that ends the body.
    const sectIndex = children.findIndex((node) => node.type === "el" && localName(node) === "sectPr");
    const blockElements = children.filter((node, index): node is XmlElement => node.type === "el" && (sectIndex < 0 || index < sectIndex) && ["p", "tbl", "sdt"].includes(localName(node)));
    if (blockElements.at(-1) && localName(blockElements.at(-1)!) === "tbl") {
      const at = sectIndex < 0 ? children.length : sectIndex;
      children.splice(at, 0, createElement("<w:p/>"));
    }
    ctx.body.children = children;
    markDirty(ctx.body, root);
    ctx.pkg.setText(DOCUMENT_PART, serializeXml(ctx.doc));
    return ctx.pkg.toBytes();
  },
};
