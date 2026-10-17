import zlib from "node:zlib";
import * as CFB from "cfb";
import type { LiveFlowBlock, LiveFormat, LiveFormatPatch, LivePage, LiveTableCell } from "../../../shared/live-document";
import { blockChanged, flowBlocks, LiveDocumentCodecError, planFlowInsertions, spreadLines, type LiveDocumentCodec } from "./common";
import { formatDelta, isEmptyFormat } from "./format";

/*
 * HWP 5.0 binary (compound file). Each BodyText/SectionN stream is a (usually raw-deflated) record list; a paragraph
 * is a PARA_HEADER and the deeper records after it. Top-level paragraphs become blocks; a paragraph holding a table
 * control becomes a table block whose cells are LIST_HEADER + paragraph runs.
 *
 * A changed paragraph keeps its paragraph shape, its controls (section/column definitions, tables, pictures, fields)
 * in their original order, and the character shape that was in effect where its text began. Its text is replaced,
 * line breaks map to the line-break control, its range tags are dropped and its line-segment cache shrinks to one
 * segment so Hancom lays it out again. Every other record and stream is copied unchanged. Table cell edits spread
 * lines over the cell's existing paragraphs, so list headers never change. Password and distribution documents are
 * refused (their body is encrypted).
 */

const TAG_PARA_HEADER = 66;
const TAG_PARA_TEXT = 67;
const TAG_PARA_CHAR_SHAPE = 68;
const TAG_PARA_LINE_SEG = 69;
const TAG_PARA_RANGE_TAG = 70;
const TAG_CTRL_HEADER = 71;
const TAG_LIST_HEADER = 72;
const TAG_TABLE = 77;

const TAG_ID_MAPPINGS = 17;
const TAG_BORDER_FILL = 20;
const TAG_PAGE_DEF = 73;
const HWPUNIT_MM = 25.4 / 7200;
const TAG_CHAR_SHAPE = 21;
const TAG_PARA_SHAPE = 25;
/** ID_MAPPINGS slots (HWP 5.0 spec §4.2.2): character shapes and paragraph shapes. */
const MAP_CHAR_SHAPE = 9;
const MAP_PARA_SHAPE = 13;
/** PARA_SHAPE props1 bits 2-4. */
const ALIGN_IN: Record<number, LiveFormat["align"]> = { 0: "justify", 1: "left", 2: "right", 3: "center", 4: "justify", 5: "justify" };
const ALIGN_OUT: Record<NonNullable<LiveFormat["align"]>, number> = { justify: 0, left: 1, right: 2, center: 3 };

const LAST_IN_LIST = 0x80000000;
const EIGHT_UNIT = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
const OBJECT_CONTROLS = new Set(["gso ", "eqed", "form"]);
const DEFAULT_TAB = [9, 0x0fa0, 0, 0x0101, 0x20, 0x20, 0x20, 9];

export interface HwpRecord { tag: number; level: number; data: Buffer }

export function readRecords(data: Buffer): HwpRecord[] {
  const out: HwpRecord[] = [];
  let offset = 0;
  while (offset + 4 <= data.length) {
    const header = data.readUInt32LE(offset);
    const tag = header & 0x3ff;
    const level = (header >>> 10) & 0x3ff;
    let size = header >>> 20;
    let start = offset + 4;
    if (size === 0xfff) { size = data.readUInt32LE(start); start += 4; }
    if (start + size > data.length) throw new LiveDocumentCodecError("hwp_record_truncated", `at ${offset}`);
    out.push({ tag, level, data: Buffer.from(data.subarray(start, start + size)) });
    offset = start + size;
  }
  return out;
}

export function writeRecords(records: HwpRecord[]): Buffer {
  const chunks: Buffer[] = [];
  for (const record of records) {
    const size = record.data.length;
    if (size >= 0xfff) {
      const head = Buffer.alloc(8);
      head.writeUInt32LE((record.tag & 0x3ff) | ((record.level & 0x3ff) << 10) | (0xfff << 20) >>> 0, 0);
      head.writeUInt32LE(size, 4);
      chunks.push(head);
    } else {
      const head = Buffer.alloc(4);
      head.writeUInt32LE(((record.tag & 0x3ff) | ((record.level & 0x3ff) << 10) | (size << 20)) >>> 0, 0);
      chunks.push(head);
    }
    chunks.push(record.data);
  }
  return Buffer.concat(chunks);
}

function groupEnd(records: HwpRecord[], index: number): number {
  const level = records[index].level;
  let end = index + 1;
  while (end < records.length && records[end].level > level) end++;
  return end;
}

function ctrlId(record: HwpRecord): string {
  if (record.data.length < 4) return "";
  return Buffer.from(record.data.subarray(0, 4)).reverse().toString("latin1");
}

/** Units of a PARA_TEXT split into controls (8 units, kept verbatim) and text. */
interface ParsedText { controls: number[][]; tab: number[] | null; text: string; textStart: number }

function parseParaText(units: number[]): ParsedText {
  const controls: number[][] = [];
  let tab: number[] | null = null;
  let text = "";
  let textStart = -1;
  for (let i = 0; i < units.length;) {
    const code = units[i];
    if (code < 32 && EIGHT_UNIT.has(code)) {
      const token = units.slice(i, i + 8);
      if (code === 9) { tab ??= token; if (textStart < 0) textStart = i; text += "\t"; }
      else controls.push(token);
      i += 8;
      continue;
    }
    if (code === 13) { i++; continue; }
    if (textStart < 0) textStart = i;
    if (code === 10) text += "\n";
    else if (code === 24) text += "-";
    else if (code === 30 || code === 31) text += " ";
    else if (code >= 32) text += String.fromCharCode(code);
    i++;
  }
  return { controls, tab, text, textStart: Math.max(0, textStart) };
}

function unitsOf(record: HwpRecord | undefined): number[] {
  if (!record) return [13];
  const out: number[] = [];
  for (let i = 0; i + 1 < record.data.length; i += 2) out.push(record.data.readUInt16LE(i));
  return out;
}

function childOf(records: HwpRecord[], start: number, tag: number): number {
  const level = records[start].level;
  for (let i = start + 1; i < records.length && records[i].level > level; i++) {
    if (records[i].tag === tag && records[i].level === level + 1) return i;
  }
  return -1;
}

export function hwpParagraphText(records: HwpRecord[], index: number): string {
  const text = childOf(records, index, TAG_PARA_TEXT);
  return parseParaText(unitsOf(text >= 0 ? records[text] : undefined)).text;
}

function controlIds(records: HwpRecord[], index: number): string[] {
  const level = records[index].level;
  const out: string[] = [];
  for (let i = index + 1; i < records.length && records[i].level > level; i++) {
    if (records[i].tag === TAG_CTRL_HEADER && records[i].level === level + 1) out.push(ctrlId(records[i]));
  }
  return out;
}

interface CellRef { row: number; col: number; colSpan: number; rowSpan: number; paragraphs: number[]; width: number; borderFill: number }

function tableCells(records: HwpRecord[], ctrlIndex: number): { rows: number; cols: number; cells: CellRef[] } {
  const end = groupEnd(records, ctrlIndex);
  const childLevel = records[ctrlIndex].level + 1;
  let rows = 0, cols = 0;
  const cells: CellRef[] = [];
  let current: CellRef | null = null;
  for (let i = ctrlIndex + 1; i < end; i++) {
    const record = records[i];
    if (record.level !== childLevel) continue;
    if (record.tag === TAG_TABLE && record.data.length >= 8) { rows = record.data.readUInt16LE(4); cols = record.data.readUInt16LE(6); }
    else if (record.tag === TAG_LIST_HEADER && record.data.length >= 16) {
      let col = record.data.readUInt16LE(8), row = record.data.readUInt16LE(10), colSpan = record.data.readUInt16LE(12), rowSpan = record.data.readUInt16LE(14);
      if ((cols && col >= cols) || (rows && row >= rows)) {
        col = record.data.readUInt16LE(6); row = record.data.readUInt16LE(8); colSpan = record.data.readUInt16LE(10); rowSpan = record.data.readUInt16LE(12);
      }
      current = { row, col, colSpan: Math.max(1, colSpan), rowSpan: Math.max(1, rowSpan), paragraphs: [],
        width: record.data.length >= 20 ? record.data.readUInt32LE(16) : 0, borderFill: record.data.length >= 34 ? record.data.readUInt16LE(32) : 0 };
      cells.push(current);
    } else if (record.tag === TAG_PARA_HEADER && current) current.paragraphs.push(i);
  }
  return { rows, cols, cells };
}

/** DocInfo character/paragraph shapes: read for display; new formats append cloned shapes (ids never reused). */
class HwpDocInfo {
  records: HwpRecord[];
  changed = false;
  private readonly cache = new Map<string, number>();
  constructor(data: Buffer, readonly compressed: boolean) { this.records = readRecords(data); }
  private list(tag: number): number[] { return this.records.flatMap((record, index) => record.tag === tag ? [index] : []); }
  /** Solid background of a BORDER_FILL entry (ids are 1-based); undefined when it has no solid fill. */
  fillOf(id: number): string | undefined {
    const index = this.list(TAG_BORDER_FILL)[id - 1];
    const data = index === undefined ? undefined : this.records[index].data;
    if (!data || data.length < 40) return undefined;
    const type = data.readUInt32LE(32);
    if (!(type & 1)) return undefined;
    const color = data.readUInt32LE(36);
    if (color === 0xffffffff || (color >>> 24) !== 0) return undefined;
    const hex = `#${[color & 255, (color >>> 8) & 255, (color >>> 16) & 255].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    return hex === "#ffffff" ? undefined : hex;
  }
  charShape(id: number): Buffer | undefined { const index = this.list(TAG_CHAR_SHAPE)[id]; return index === undefined ? undefined : this.records[index].data; }
  paraShape(id: number): Buffer | undefined { const index = this.list(TAG_PARA_SHAPE)[id]; return index === undefined ? undefined : this.records[index].data; }
  format(charId: number | undefined, paraId: number | undefined): LiveFormat | undefined {
    const format: LiveFormat = {};
    const char = charId !== undefined ? this.charShape(charId) : undefined;
    if (char && char.length >= 56) {
      const size = char.readInt32LE(42);
      if (size > 0 && size !== 1000) format.size = size / 100;
      const props = char.readUInt32LE(46);
      if (props & 1) format.italic = true;
      if (props & 2) format.bold = true;
      if ((props >>> 2) & 3) format.underline = true;
      const color = char.readUInt32LE(52);
      if (color !== 0) format.color = `#${[color & 255, (color >>> 8) & 255, (color >>> 16) & 255].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    }
    const para = paraId !== undefined ? this.paraShape(paraId) : undefined;
    if (para && para.length >= 4) {
      const align = ALIGN_IN[(para.readUInt32LE(0) >>> 2) & 7];
      if (align && align !== "justify") format.align = align;
    }
    return isEmptyFormat(format) ? undefined : format;
  }
  private append(tag: number, slot: number, data: Buffer): number {
    const all = this.list(tag);
    const last = all[all.length - 1];
    if (last === undefined) throw new LiveDocumentCodecError("hwp_docinfo_invalid", "no shape to copy");
    this.records.splice(last + 1, 0, { tag, level: this.records[last].level, data });
    const mapIndex = this.records.findIndex((record) => record.tag === TAG_ID_MAPPINGS);
    const counts = Buffer.from(this.records[mapIndex].data);
    counts.writeInt32LE(all.length + 1, slot * 4);
    this.records[mapIndex] = { ...this.records[mapIndex], data: counts };
    this.changed = true;
    return all.length;
  }
  charFor(base: number, delta: LiveFormatPatch): number {
    const chars = { ...delta, align: undefined };
    if (isEmptyFormat(JSON.parse(JSON.stringify(chars)))) return base;
    const key = `c${base}|${JSON.stringify(chars)}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const source = this.charShape(base) ?? this.charShape(0);
    if (!source || source.length < 56) return base;
    const data = Buffer.from(source);
    if (delta.size !== undefined) data.writeInt32LE(Math.round((delta.size ?? 10) * 100), 42);
    let props = data.readUInt32LE(46);
    if (delta.italic !== undefined) props = delta.italic ? props | 1 : props & ~1;
    if (delta.bold !== undefined) props = delta.bold ? props | 2 : props & ~2;
    if (delta.underline !== undefined) props = (props & ~(3 << 2)) | (delta.underline ? 1 << 2 : 0);
    data.writeUInt32LE(props >>> 0, 46);
    if (delta.color !== undefined) {
      const hex = (delta.color ?? "#000000").slice(1);
      const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
      data.writeUInt32LE(((b << 16) | (g << 8) | r) >>> 0, 52);
    }
    const id = this.append(TAG_CHAR_SHAPE, MAP_CHAR_SHAPE, data);
    this.cache.set(key, id);
    return id;
  }
  paraFor(base: number, align: LiveFormat["align"] | null): number {
    if (align === undefined) return base;
    align = align ?? "justify";
    const key = `p${base}|${align}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const source = this.paraShape(base) ?? this.paraShape(0);
    if (!source || source.length < 4) return base;
    const data = Buffer.from(source);
    data.writeUInt32LE(((data.readUInt32LE(0) & ~(7 << 2)) | (ALIGN_OUT[align] << 2)) >>> 0, 0);
    const id = this.append(TAG_PARA_SHAPE, MAP_PARA_SHAPE, data);
    this.cache.set(key, id);
    return id;
  }
}

/** Paper of the first section (PAGE_DEF under the section definition control). Landscape swaps width and height. */
function pageOf(records: HwpRecord[]): LivePage | undefined {
  const def = records.find((record) => record.tag === TAG_PAGE_DEF);
  if (!def || def.data.length < 36) return undefined;
  const u = (offset: number) => def.data.readUInt32LE(offset);
  const mm = (value: number) => Math.round(value * HWPUNIT_MM * 10) / 10;
  let width = u(0), height = u(4);
  if (def.data.length >= 40 && (u(36) & 1)) [width, height] = [height, width];
  return { width: mm(width), height: mm(height), margin: { left: mm(u(8) + u(32)), right: mm(u(12)), top: mm(u(16) + u(24)), bottom: mm(u(20) + u(28)) } };
}

/** Character shape at the start of a paragraph's text and its paragraph shape. */
function paragraphShapes(records: HwpRecord[], index: number): { char?: number; para: number } {
  const textIndex = childOf(records, index, TAG_PARA_TEXT);
  const parsed = parseParaText(unitsOf(textIndex >= 0 ? records[textIndex] : undefined));
  const shapeIndex = childOf(records, index, TAG_PARA_CHAR_SHAPE);
  let char: number | undefined;
  if (shapeIndex >= 0) {
    const data = records[shapeIndex].data;
    for (let i = 0; i + 8 <= data.length; i += 8) if (char === undefined || data.readUInt32LE(i) <= parsed.textStart) char = data.readUInt32LE(i + 4);
  }
  return { char, para: records[index].data.readUInt16LE(8) };
}

/** Maps every character shape of a paragraph through the derived shape, and its paragraph shape for alignment. */
function setParagraphFormat(docInfo: HwpDocInfo, records: HwpRecord[], index: number, delta: LiveFormatPatch): void {
  const shapeIndex = childOf(records, index, TAG_PARA_CHAR_SHAPE);
  if (shapeIndex >= 0) {
    const data = Buffer.from(records[shapeIndex].data);
    for (let i = 0; i + 8 <= data.length; i += 8) data.writeUInt32LE(docInfo.charFor(data.readUInt32LE(i + 4), delta), i + 4);
    records[shapeIndex] = { ...records[shapeIndex], data };
  }
  if (delta.align !== undefined) {
    const head = Buffer.from(records[index].data);
    head.writeUInt16LE(docInfo.paraFor(head.readUInt16LE(8), delta.align), 8);
    records[index] = { ...records[index], data: head };
  }
}

interface HwpSection { path: string; compressed: boolean; records: HwpRecord[]; paragraphs: number[] }

interface HwpContext {
  cfb: CFB.CFB$Container;
  docInfo: HwpDocInfo;
  page?: LivePage;
  compressed: boolean;
  sections: HwpSection[];
  blocks: Map<string, { section: number; record: number; table?: number }>;
  model: LiveFlowBlock[];
}

function load(bytes: Uint8Array): HwpContext {
  let cfb: CFB.CFB$Container;
  try { cfb = CFB.read(Buffer.from(bytes), { type: "buffer" }); } catch { throw new LiveDocumentCodecError("hwp_container_invalid"); }
  const header = CFB.find(cfb, "/FileHeader");
  const head = header?.content ? Buffer.from(header.content as Uint8Array) : null;
  if (!head || head.length < 40 || !head.subarray(0, 17).toString("latin1").startsWith("HWP Document File")) throw new LiveDocumentCodecError("hwp_header_invalid");
  const version = head.readUInt32LE(32);
  if (((version >>> 24) & 0xff) !== 5) throw new LiveDocumentCodecError("hwp_version_unsupported", `${(version >>> 24) & 0xff}`);
  const flags = head.readUInt32LE(36);
  if (flags & 0b110) throw new LiveDocumentCodecError("hwp_protected", "password or distribution document");
  const compressed = (flags & 1) === 1;
  const sections: HwpSection[] = [];
  for (let n = 0; ; n++) {
    const entry = CFB.find(cfb, `/BodyText/Section${n}`);
    if (!entry?.content) break;
    const raw = Buffer.from(entry.content as Uint8Array);
    let data: Buffer;
    try { data = compressed ? zlib.inflateRawSync(raw) : raw; } catch { throw new LiveDocumentCodecError("hwp_section_invalid", `Section${n}`); }
    const records = readRecords(data);
    const paragraphs = records.flatMap((record, index) => record.tag === TAG_PARA_HEADER && record.level === 0 ? [index] : []);
    sections.push({ path: `/BodyText/Section${n}`, compressed, records, paragraphs });
  }
  if (!sections.length) throw new LiveDocumentCodecError("hwp_sections_missing");
  const docInfoEntry = CFB.find(cfb, "/DocInfo");
  if (!docInfoEntry?.content) throw new LiveDocumentCodecError("hwp_docinfo_missing");
  const docInfoRaw = Buffer.from(docInfoEntry.content as Uint8Array);
  let docInfoData: Buffer;
  try { docInfoData = compressed ? zlib.inflateRawSync(docInfoRaw) : docInfoRaw; } catch { throw new LiveDocumentCodecError("hwp_docinfo_invalid"); }
  const docInfo = new HwpDocInfo(docInfoData, compressed);
  const formatOf = (records: HwpRecord[], index: number) => { const shapes = paragraphShapes(records, index); return docInfo.format(shapes.char, shapes.para); };
  const blocks = new Map<string, { section: number; record: number; table?: number }>();
  const model: LiveFlowBlock[] = [];
  let counter = 0;
  sections.forEach((section, sectionIndex) => {
    for (const index of section.paragraphs) {
      const id = `b${++counter}`;
      const records = section.records;
      const controls = controlIds(records, index);
      const text = hwpParagraphText(records, index);
      let tableCtrl = -1;
      for (let i = index + 1; i < groupEnd(records, index); i++) if (records[i].tag === TAG_CTRL_HEADER && ctrlId(records[i]) === "tbl ") { tableCtrl = i; break; }
      blocks.set(id, { section: sectionIndex, record: index, ...(tableCtrl >= 0 ? { table: tableCtrl } : {}) });
      if (tableCtrl >= 0) {
        const layout = tableCells(records, tableCtrl);
        const rowCount = Math.max(layout.rows, ...layout.cells.map((cell) => cell.row + cell.rowSpan));
        const colCount = Math.max(layout.cols, ...layout.cells.map((cell) => cell.col + cell.colSpan));
        const rows: Array<Array<LiveTableCell | null>> = Array.from({ length: rowCount }, () => Array(colCount).fill(null));
        for (const cell of layout.cells) {
          if (!rows[cell.row]) continue;
          const paragraphFmt = cell.paragraphs[0] !== undefined ? formatOf(records, cell.paragraphs[0]) : undefined;
          const cellFill = docInfo.fillOf(cell.borderFill);
          const format: LiveFormat = { ...(paragraphFmt ?? {}), ...(cellFill ? { fill: cellFill } : {}) };
          rows[cell.row][cell.col] = {
            id: `${id}.r${cell.row + 1}c${cell.col + 1}`,
            text: cell.paragraphs.map((p) => hwpParagraphText(records, p)).join("\n"),
            ...(isEmptyFormat(format) ? {} : { format }),
            ...(cell.colSpan > 1 ? { colSpan: cell.colSpan } : {}), ...(cell.rowSpan > 1 ? { rowSpan: cell.rowSpan } : {}),
          };
        }
        const widths = Array.from({ length: colCount }, (_, col) => layout.cells.find((cell) => cell.col === col && cell.colSpan === 1 && cell.width > 0)?.width ?? 0);
        const total = widths.reduce((sum, w) => sum + w, 0);
        const colWidths = widths.every((w) => w > 0) && total > 0 ? widths.map((w) => Math.round((w / total) * 10000) / 10000) : undefined;
        model.push({ id, type: "table", rows, ...(colWidths ? { colWidths } : {}), ...(controls.includes("secd") ? { fixed: true } : {}) });
      } else if (!text.trim() && controls.some((control) => OBJECT_CONTROLS.has(control))) {
        model.push({ id, type: "object", label: controls.includes("eqed") ? "equation" : "image" });
      } else {
        const format = formatOf(records, index);
        model.push({ id, type: "paragraph", text, ...(controls.includes("secd") ? { fixed: true } : {}), ...(format ? { format } : {}) });
      }
    }
  });
  return { cfb, compressed, sections, blocks, model, docInfo, page: pageOf(sections[0].records) };
}

/** Rewrites one paragraph group in place (records array is mutated; returns the index delta). */
function setParagraphText(records: HwpRecord[], index: number, text: string): number {
  const header = records[index];
  const level = header.level;
  const textIndex = childOf(records, index, TAG_PARA_TEXT);
  const original = unitsOf(textIndex >= 0 ? records[textIndex] : undefined);
  const parsed = parseParaText(original);
  const units: number[] = parsed.controls.flat();
  for (const ch of text.replace(/\r/g, "")) {
    if (ch === "\n") units.push(10);
    else if (ch === "\t") units.push(...(parsed.tab ?? DEFAULT_TAB));
    else for (let k = 0; k < ch.length; k++) units.push(ch.charCodeAt(k));
  }
  units.push(13);
  let mask = 0;
  for (let i = 0; i < units.length;) {
    const code = units[i];
    if (code < 32 && code !== 13) mask |= 1 << code;
    i += code < 32 && EIGHT_UNIT.has(code) ? 8 : 1;
  }
  // Character shape in effect where the text started.
  const shapeIndex = childOf(records, index, TAG_PARA_CHAR_SHAPE);
  let shapeId = 0;
  if (shapeIndex >= 0) {
    const data = records[shapeIndex].data;
    shapeId = data.length >= 8 ? data.readUInt32LE(4) : 0;
    for (let i = 0; i + 8 <= data.length; i += 8) if (data.readUInt32LE(i) <= parsed.textStart) shapeId = data.readUInt32LE(i + 4);
  }
  const head = Buffer.from(header.data);
  const flag = head.readUInt32LE(0) & LAST_IN_LIST;
  head.writeUInt32LE((units.length | flag) >>> 0, 0);
  head.writeUInt32LE(mask >>> 0, 4);
  head.writeUInt16LE(1, 12);
  if (head.length >= 18) { head.writeUInt16LE(0, 14); head.writeUInt16LE(1, 16); }
  records[index] = { ...header, data: head };

  let delta = 0;
  const textData = Buffer.alloc(units.length * 2);
  units.forEach((unit, i) => textData.writeUInt16LE(unit, i * 2));
  if (units.length > 1) {
    if (textIndex >= 0) records[textIndex] = { ...records[textIndex], data: textData };
    else { records.splice(index + 1, 0, { tag: TAG_PARA_TEXT, level: level + 1, data: textData }); delta++; }
  } else if (textIndex >= 0) { records.splice(textIndex, 1); delta--; }

  const shape = Buffer.alloc(8);
  shape.writeUInt32LE(0, 0); shape.writeUInt32LE(shapeId, 4);
  const shapeAt = childOf(records, index, TAG_PARA_CHAR_SHAPE);
  if (shapeAt >= 0) records[shapeAt] = { ...records[shapeAt], data: shape };
  else {
    const after = childOf(records, index, TAG_PARA_TEXT);
    records.splice((after >= 0 ? after : index) + 1, 0, { tag: TAG_PARA_CHAR_SHAPE, level: level + 1, data: shape });
    delta++;
  }
  const segAt = childOf(records, index, TAG_PARA_LINE_SEG);
  if (segAt >= 0) {
    const seg = Buffer.from(records[segAt].data.subarray(0, 36));
    if (seg.length >= 4) seg.writeUInt32LE(0, 0);
    records[segAt] = { ...records[segAt], data: seg };
  } else if (head.length >= 18) head.writeUInt16LE(0, 16);
  const rangeAt = childOf(records, index, TAG_PARA_RANGE_TAG);
  if (rangeAt >= 0) { records.splice(rangeAt, 1); delta--; }
  return delta;
}

/** A plain paragraph group cloned from a template paragraph (no controls), with new text. */
function newParagraphGroup(records: HwpRecord[], template: number, text: string): HwpRecord[] {
  const end = groupEnd(records, template);
  const group = records.slice(template, end).filter((record) => record.level === records[template].level || (record.level === records[template].level + 1 && [TAG_PARA_TEXT, TAG_PARA_CHAR_SHAPE, TAG_PARA_LINE_SEG].includes(record.tag)))
    .map((record) => ({ ...record, data: Buffer.from(record.data) }));
  const head = group[0].data;
  head.writeUInt32LE(head.readUInt32LE(0) & ~LAST_IN_LIST & 0x7fffffff, 0);
  if (head.length >= 22) head.writeUInt32LE(0, 18);
  const scratch = [...group];
  setParagraphText(scratch, 0, text);
  return scratch;
}

function isPlain(records: HwpRecord[], index: number): boolean {
  return controlIds(records, index).length === 0;
}

function normalizeLastFlags(records: HwpRecord[]): void {
  const top = records.flatMap((record, index) => record.tag === TAG_PARA_HEADER && record.level === 0 ? [index] : []);
  top.forEach((index, n) => {
    const data = Buffer.from(records[index].data);
    const value = data.readUInt32LE(0) & 0x7fffffff;
    data.writeUInt32LE((n === top.length - 1 ? value | LAST_IN_LIST : value) >>> 0, 0);
    records[index] = { ...records[index], data };
  });
}

function previewText(blocks: LiveFlowBlock[]): Buffer {
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.type === "paragraph") lines.push(block.text);
    else if (block.type === "table") lines.push(block.rows.map((row) => row.map((cell) => cell ? `<${cell.text}>` : "").join("")).join("\r\n"));
    if (lines.join("\r\n").length > 1024) break;
  }
  return Buffer.from(`${lines.join("\r\n").slice(0, 1024)}\0`, "utf16le");
}

export const hwpCodec: LiveDocumentCodec = {
  parse(bytes) {
    const ctx = load(bytes);
    const base = ctx.docInfo.charShape(0);
    const defaultSize = base && base.length >= 46 && base.readInt32LE(42) > 0 ? base.readInt32LE(42) / 100 : undefined;
    return { kind: "flow", blocks: ctx.model, ...(ctx.page ? { page: ctx.page } : {}), ...(defaultSize ? { defaultSize } : {}) };
  },
  write(bytes, original, final) {
    const ctx = load(bytes);
    const before = new Map(flowBlocks(original).map((block) => [block.id, block]));
    const finalBlocks = flowBlocks(final);
    const finalById = new Map(finalBlocks.map((block) => [block.id, block]));
    const plan = planFlowInsertions(new Set(ctx.blocks.keys()), finalBlocks);
    const ids = [...ctx.blocks.keys()];
    const touched = new Set<number>();

    // 1) Text edits, deepest-last so record indices of earlier paragraphs stay valid: work on a per-section copy and
    //    re-resolve each paragraph by its ordinal among top-level paragraphs.
    for (const [sectionIndex, section] of ctx.sections.entries()) {
      const records = [...section.records];
      const sectionIds = ids.filter((id) => ctx.blocks.get(id)!.section === sectionIndex);
      const topLevel = () => records.flatMap((record, index) => record.tag === TAG_PARA_HEADER && record.level === 0 ? [index] : []);
      sectionIds.forEach((id, ordinal) => {
        const after = finalById.get(id);
        const prior = before.get(id);
        if (!after || !prior || !blockChanged(prior, after)) return;
        const index = topLevel()[ordinal];
        if (after.type === "paragraph" && prior.type === "paragraph") {
          if (prior.text !== after.text) setParagraphText(records, index, after.text);
          const delta = formatDelta(prior.format, after.format);
          if (!isEmptyFormat(delta)) setParagraphFormat(ctx.docInfo, records, topLevel()[ordinal], delta);
          touched.add(sectionIndex);
        }
        if (after.type === "table" && prior.type === "table") {
          const priorCells = new Map(prior.rows.flat().filter((cell): cell is LiveTableCell => !!cell).map((cell) => [cell.id, cell]));
          for (const cell of after.rows.flat()) {
            if (!cell) continue;
            const old = priorCells.get(cell.id);
            const delta = formatDelta(old?.format, cell.format);
            if (old?.text === cell.text && isEmptyFormat(delta)) continue;
            let tableCtrl = -1;
            const end = groupEnd(records, topLevel()[ordinal]);
            for (let i = topLevel()[ordinal] + 1; i < end; i++) if (records[i].tag === TAG_CTRL_HEADER && ctrlId(records[i]) === "tbl ") { tableCtrl = i; break; }
            if (tableCtrl < 0) continue;
            const match = /\.r(\d+)c(\d+)$/.exec(cell.id);
            const ref = match ? tableCells(records, tableCtrl).cells.find((item) => item.row === Number(match[1]) - 1 && item.col === Number(match[2]) - 1) : undefined;
            if (!ref) continue;
            const lines = spreadLines(cell.text, ref.paragraphs.length);
            // Rewrite from the last paragraph backwards so earlier indices do not move.
            for (let k = ref.paragraphs.length - 1; k >= 0; k--) {
              if (old?.text !== cell.text) setParagraphText(records, ref.paragraphs[k], lines[k]);
              if (!isEmptyFormat(delta)) setParagraphFormat(ctx.docInfo, records, ref.paragraphs[k], delta);
            }
            touched.add(sectionIndex);
          }
        }
      });

      // 2) Structure: rebuild the top-level paragraph sequence of this section.
      const groups = topLevel().map((index) => ({ start: index, end: groupEnd(records, index) }));
      const prefixEnd = groups.length ? groups[0].start : records.length;
      const rebuilt: HwpRecord[] = records.slice(0, prefixEnd);
      let structural = false;
      const templateIndex = (anchorOrdinal: number): number | undefined => {
        for (let k = anchorOrdinal; k >= 0; k--) if (groups[k] && isPlain(records, groups[k].start)) return groups[k].start;
        const any = groups.find((group) => isPlain(records, group.start));
        return any?.start;
      };
      const emitNew = (blocksToAdd: LiveFlowBlock[], anchorOrdinal: number) => {
        for (const block of blocksToAdd) {
          if (block.type !== "paragraph") continue;
          const template = templateIndex(anchorOrdinal);
          if (template === undefined) throw new LiveDocumentCodecError("hwp_no_plain_paragraph", "no paragraph to copy the shape from");
          const group = newParagraphGroup(records, template, block.text);
          // The new paragraph reads back with exactly its model format, not the template's (HWP writes no fill).
          const shapes = paragraphShapes(group, 0);
          const { fill: _fill, ...delta } = formatDelta(ctx.docInfo.format(shapes.char, shapes.para), block.format);
          if (!isEmptyFormat(delta)) setParagraphFormat(ctx.docInfo, group, 0, delta);
          rebuilt.push(...group);
          structural = true;
        }
      };
      sectionIds.forEach((id, ordinal) => {
        const group = groups[ordinal];
        if (ordinal === 0 && sectionIndex === 0 && !(before.get(id) as { fixed?: boolean } | undefined)?.fixed) emitNew(plan.get("^") ?? [], 0);
        if (finalById.has(id)) rebuilt.push(...records.slice(group.start, group.end));
        else structural = true;
        if (ordinal === 0 && sectionIndex === 0 && (before.get(id) as { fixed?: boolean } | undefined)?.fixed) emitNew(plan.get("^") ?? [], 0);
        emitNew(plan.get(id) ?? [], ordinal);
      });
      if (groups.length) rebuilt.push(...records.slice(groups[groups.length - 1].end));
      if (structural) { normalizeLastFlags(rebuilt); touched.add(sectionIndex); }
      section.records = structural ? rebuilt : records;
    }
    if (!touched.size) return bytes;

    for (const index of touched) {
      const section = ctx.sections[index];
      const data = writeRecords(section.records);
      const entry = CFB.find(ctx.cfb, section.path)!;
      const content = section.compressed ? zlib.deflateRawSync(data) : data;
      entry.content = content as unknown as CFB.CFB$Blob;
      entry.size = content.length;
    }
    if (ctx.docInfo.changed) {
      const entry = CFB.find(ctx.cfb, "/DocInfo")!;
      const data = writeRecords(ctx.docInfo.records);
      const content = ctx.docInfo.compressed ? zlib.deflateRawSync(data) : data;
      entry.content = content as unknown as CFB.CFB$Blob;
      entry.size = content.length;
    }
    const preview = CFB.find(ctx.cfb, "/PrvText");
    if (preview) { const text = previewText(finalBlocks); preview.content = text as unknown as CFB.CFB$Blob; preview.size = text.length; }
    const out = CFB.write(ctx.cfb, { type: "buffer", fileType: "cfb" }) as Buffer;
    return new Uint8Array(out);
  },
};
