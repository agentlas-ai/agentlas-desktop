/*
 * Live document contract (agentlas.live-document.v1).
 *
 * One editable model per open office file (xlsx, docx, pptx, hwpx, hwp). The AI (harness document.* ports) and the
 * person (Document rail tab) change it through the SAME typed operations; the host folds an append-only journal of
 * those operations over the parsed original, and the codec writes the result back into the original format by
 * patching only what changed (electron/live-document/codecs). The renderer replays each AI entry with a cursor that
 * types it, so the person watches the work happen instead of receiving a finished file.
 *
 * Pure: no node or DOM imports (Main, daemon and renderer all load it).
 */

import { recalculateSheets } from "./sheet-formula";

export const LIVE_DOCUMENT_VERSION = "agentlas.live-document.v1" as const;
export const LIVE_DOCUMENT_FORMATS = ["xlsx", "docx", "pptx", "hwpx", "hwp"] as const;
export type LiveDocumentFormat = (typeof LIVE_DOCUMENT_FORMATS)[number];

/** Character and paragraph formatting the ribbon and the AI can set on a whole paragraph, cell or shape. */
export interface LiveFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Points. */
  size?: number;
  /** #rrggbb */
  color?: string;
  align?: "left" | "center" | "right" | "justify";
  /** Background (#rrggbb): table cells, paragraphs, sheet cells, slide shapes. */
  fill?: string;
}

/** Paper of a flow document, in millimetres (A4 = 210 × 297). */
export interface LivePage {
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
}

/** A format change: a value sets it, null removes the explicit value (the paragraph/cell/shape inherits again). */
export type LiveFormatPatch = { [K in keyof LiveFormat]?: LiveFormat[K] | null };

export interface LiveCell {
  /** Displayed value (the computed result for formulas, shown with the cell's number format). */
  v: string;
  /** Formula without the leading "=". */
  f?: string;
  /** The number behind `v` when it is numeric (a date is its serial), so formulas compute on exact values. */
  n?: number;
  /** Excel number-format code of the cell ("0.0%", "#,##0", "yyyy-mm-dd"); absent for General. */
  nf?: string;
  format?: LiveFormat;
}

export interface LiveSheet {
  id: string;
  name: string;
  cells: Record<string, LiveCell>;
}

export interface LiveTableCell {
  id: string;
  text: string;
  format?: LiveFormat;
  colSpan?: number;
  rowSpan?: number;
}

export type LiveFlowBlock =
  /** `fixed`: carries the section definition (HWP/HWPX first paragraph); its text is editable, the block is not deletable. */
  /** `pageBreak`: the paragraph starts a new page ("before") or ends its page ("after"). */
  | { id: string; type: "paragraph"; text: string; heading?: number; fixed?: boolean; format?: LiveFormat; pageBreak?: "before" | "after" }
  /** `colWidths`: relative column widths (sum 1) read from the file or given at insert. */
  | { id: string; type: "table"; rows: Array<Array<LiveTableCell | null>>; fixed?: boolean; colWidths?: number[] }
  /** Images, charts, section breaks: kept byte-for-byte, shown as a labelled placeholder, never edited. */
  | { id: string; type: "object"; label: string };

export interface LiveShape {
  id: string;
  /** `object`: picture, chart, table frame or a decorative shape — drawn as a box, never edited. */
  role: "title" | "body" | "text" | "object";
  text: string;
  /** Fractions of the slide (0..1). */
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
  /** Shape fill read from the file (#rrggbb); display only. */
  fill?: string;
  format?: LiveFormat;
}

export interface LiveSlide {
  id: string;
  background?: string;
  shapes: LiveShape[];
}

export type LiveDocumentModel =
  | { kind: "sheet"; sheets: LiveSheet[] }
  | { kind: "flow"; blocks: LiveFlowBlock[]; page?: LivePage; defaultSize?: number }
  | { kind: "slides"; aspect: number; slides: LiveSlide[] };

/** A merged range in a new table: the anchor cell ("r2c1", 1-based like the outline ids) spans the given rows/columns. */
export interface LiveTableMerge { cell: string; rowSpan?: number; colSpan?: number }

export type LiveDocumentOp =
  | { op: "set_cell"; sheet: string; cell: string; value: string }
  | { op: "set_text"; target: string; text: string }
  | { op: "insert_text"; target: string; text: string; at?: number }
  | { op: "insert_paragraph"; after?: string; text: string; heading?: number; pageBreak?: boolean; id?: string }
  | { op: "insert_table"; after?: string; rows: string[][]; widths?: number[]; merges?: LiveTableMerge[]; id?: string }
  | { op: "delete_block"; target: string }
  | { op: "add_slide"; after?: string; title?: string; body?: string; id?: string }
  | { op: "delete_slide"; target: string }
  | { op: "add_sheet"; name: string; id?: string }
  /** target: block, table-cell or shape id, or `<sheet>!A1`; heading (flow paragraphs) 0 = body text. */
  | { op: "set_format"; target: string; format: LiveFormatPatch; heading?: number };

export type LiveDocumentOpName = LiveDocumentOp["op"];

/** What each format's codec can write back. Anything else is refused before it reaches the journal. */
export const LIVE_DOCUMENT_OPS_BY_FORMAT: Record<LiveDocumentFormat, readonly LiveDocumentOpName[]> = {
  xlsx: ["set_cell", "add_sheet", "set_format"],
  docx: ["set_text", "insert_text", "insert_paragraph", "insert_table", "delete_block", "set_format"],
  hwpx: ["set_text", "insert_text", "insert_paragraph", "insert_table", "delete_block", "set_format"],
  hwp: ["set_text", "insert_text", "insert_paragraph", "delete_block", "set_format"],
  pptx: ["set_text", "insert_text", "add_slide", "delete_slide", "set_format"],
};

export interface LiveDocumentActor {
  kind: "ai" | "user";
  /** Display name: the agent or runtime for AI entries. */
  label?: string;
  runId?: string;
}

export interface LiveDocumentEntry {
  seq: number;
  at: string;
  actor: LiveDocumentActor;
  ops: LiveDocumentOp[];
}

export interface LiveDocumentMeta {
  schemaVersion: typeof LIVE_DOCUMENT_VERSION;
  sessionId: string;
  chatId: string;
  path: string;
  name: string;
  format: LiveDocumentFormat;
  openedAt: string;
  sourceSha256: string;
  /** Journal revision written to disk last, and the file's sha256 right after that write. */
  savedRevision: number;
  savedSha256: string;
  closed?: boolean;
}

export interface LiveDocumentSnapshot {
  meta: LiveDocumentMeta;
  revision: number;
  model: LiveDocumentModel;
  /** Most recent entries (oldest first), for the activity strip and replay. */
  entries: LiveDocumentEntry[];
  /** A just-opened session: the model as opened, so a tab that mounts after the first edits can still replay them. */
  replayFrom?: LiveDocumentModel;
}

export interface LiveDocumentDelta {
  sessionId: string;
  revision: number;
  /** Entries after the caller's revision; `reset` when the caller must reload the snapshot. */
  entries: LiveDocumentEntry[];
  reset?: boolean;
}

export type LiveDocumentApplyResult =
  | { ok: true; revision: number; created: string[] }
  | { ok: false; reason: string; detail?: string; revision?: number };

export interface LiveDocumentAPI {
  list: (chatId: string) => Promise<LiveDocumentMeta[]>;
  /** Owner picks a file in the native dialog; the session binds to chatId. */
  pickAndOpen: (chatId: string) => Promise<{ ok: true; sessionId: string } | { ok: false; reason: string }>;
  snapshot: (sessionId: string) => Promise<LiveDocumentSnapshot | null>;
  /** Journal entries after `sinceRevision` (reset when the caller must reload the snapshot). */
  entries: (sessionId: string, sinceRevision: number) => Promise<LiveDocumentDelta | null>;
  apply: (input: { sessionId: string; baseRevision: number; ops: LiveDocumentOp[] }) => Promise<LiveDocumentApplyResult>;
  save: (sessionId: string) => Promise<{ ok: true; revision: number; sha256: string } | { ok: false; reason: string }>;
  close: (sessionId: string) => Promise<boolean>;
  reveal: (sessionId: string) => Promise<boolean>;
  onChanged: (callback: (event: { sessionId: string; chatId: string }) => void) => () => void;
}

// ── addresses ───────────────────────────────────────────────────────────────────────────────────────────────────

const CELL_RE = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/;

export function parseCellAddress(address: string): { col: number; row: number } | null {
  const match = CELL_RE.exec(address.trim().toUpperCase());
  if (!match) return null;
  let col = 0;
  for (const ch of match[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col, row: Number(match[2]) };
}

export function columnName(col: number): string {
  let name = "";
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

export function cellAddress(col: number, row: number): string {
  return `${columnName(col)}${row}`;
}

export function inferLiveDocumentFormat(name: string): LiveDocumentFormat | null {
  const ext = name.trim().toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return (LIVE_DOCUMENT_FORMATS as readonly string[]).includes(ext ?? "") ? ext as LiveDocumentFormat : null;
}

// ── validation ──────────────────────────────────────────────────────────────────────────────────────────────────

const MAX_TEXT = 100_000;
const MAX_OPS = 400;
const str = (value: unknown, max = MAX_TEXT): value is string => typeof value === "string" && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(value);
const optionalId = (value: unknown) => value === undefined || id(value);

/** Normalised merges of a rows x cols table, or null when one is malformed, out of range or overlaps another. */
function validMerges(value: unknown, rows: number, cols: number): LiveTableMerge[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 400) return null;
  const taken = new Set<string>();
  const out: LiveTableMerge[] = [];
  for (const item of value) {
    const record = item as Record<string, unknown>;
    const match = typeof record?.cell === "string" ? /^r(\d+)c(\d+)$/.exec(record.cell) : null;
    const rowSpan = record?.rowSpan === undefined ? 1 : record.rowSpan;
    const colSpan = record?.colSpan === undefined ? 1 : record.colSpan;
    if (!match || !Number.isSafeInteger(rowSpan) || !Number.isSafeInteger(colSpan) || Number(rowSpan) < 1 || Number(colSpan) < 1) return null;
    const r = Number(match[1]) - 1, c = Number(match[2]) - 1;
    if (r < 0 || c < 0 || r + Number(rowSpan) > rows || c + Number(colSpan) > cols) return null;
    if (Number(rowSpan) === 1 && Number(colSpan) === 1) continue;
    for (let y = r; y < r + Number(rowSpan); y++) for (let x = c; x < c + Number(colSpan); x++) {
      if (taken.has(`${y}:${x}`)) return null;
      taken.add(`${y}:${x}`);
    }
    out.push({ cell: `r${r + 1}c${c + 1}`, ...(Number(rowSpan) > 1 ? { rowSpan: Number(rowSpan) } : {}), ...(Number(colSpan) > 1 ? { colSpan: Number(colSpan) } : {}) });
  }
  return out;
}

/** Shape check only; whether targets exist is decided against the model in applyLiveDocumentOps. */
export function validateLiveDocumentOps(value: unknown, format: LiveDocumentFormat): { ok: true; ops: LiveDocumentOp[] } | { ok: false; reason: string; detail?: string } {
  if (!Array.isArray(value) || value.length === 0) return { ok: false, reason: "ops_required" };
  if (value.length > MAX_OPS) return { ok: false, reason: "ops_too_many", detail: `max ${MAX_OPS}` };
  const allowed = LIVE_DOCUMENT_OPS_BY_FORMAT[format];
  const ops: LiveDocumentOp[] = [];
  for (const [index, raw] of value.entries()) {
    const bad = (detail: string) => ({ ok: false as const, reason: "op_invalid", detail: `ops[${index}]: ${detail}` });
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("object expected");
    const op = raw as Record<string, unknown>;
    if (typeof op.op !== "string") return bad("op missing");
    if (!(allowed as readonly string[]).includes(op.op)) return { ok: false, reason: "op_unsupported_for_format", detail: `ops[${index}]: ${op.op} on ${format}; supported: ${allowed.join(", ")}` };
    switch (op.op) {
      case "set_cell":
        if (!str(op.sheet, 200) || !op.sheet || typeof op.cell !== "string" || !parseCellAddress(op.cell) || !str(op.value, 32_767)) return bad("set_cell needs sheet, cell (A1) and value");
        ops.push({ op: "set_cell", sheet: op.sheet, cell: op.cell.trim().toUpperCase(), value: op.value });
        break;
      case "set_text":
        if (!id(op.target) || !str(op.text)) return bad("set_text needs target and text");
        ops.push({ op: "set_text", target: op.target, text: op.text });
        break;
      case "insert_text":
        if (!id(op.target) || !str(op.text) || !op.text || (op.at !== undefined && (!Number.isSafeInteger(op.at) || Number(op.at) < 0))) return bad("insert_text needs target, text and optional at >= 0");
        ops.push({ op: "insert_text", target: op.target, text: op.text, ...(op.at !== undefined ? { at: Number(op.at) } : {}) });
        break;
      case "insert_paragraph":
        if (!optionalId(op.after) || !str(op.text) || (op.heading !== undefined && (!Number.isSafeInteger(op.heading) || Number(op.heading) < 1 || Number(op.heading) > 6)) || !optionalId(op.id)
          || (op.pageBreak !== undefined && typeof op.pageBreak !== "boolean")) return bad("insert_paragraph needs text, optional after, heading 1-6 and pageBreak true/false");
        ops.push({ op: "insert_paragraph", text: op.text, ...(op.after !== undefined ? { after: op.after as string } : {}), ...(op.heading !== undefined ? { heading: Number(op.heading) } : {}), ...(op.pageBreak === true ? { pageBreak: true } : {}), ...(op.id !== undefined ? { id: op.id as string } : {}) });
        break;
      case "insert_table": {
        const rows = op.rows;
        if (!optionalId(op.after) || !Array.isArray(rows) || rows.length === 0 || rows.length > 200
          || !rows.every((row) => Array.isArray(row) && row.length > 0 && row.length <= 40 && row.every((cell) => str(cell, 10_000)))) return bad("insert_table needs rows: string[][] (<=200x40)");
        const width = Math.max(...rows.map((row) => (row as string[]).length));
        const widths = op.widths;
        if (widths !== undefined && (!Array.isArray(widths) || widths.length !== width || !widths.every((w) => typeof w === "number" && w > 0 && Number.isFinite(w)))) return bad("insert_table widths: one positive number per column");
        const total = Array.isArray(widths) ? (widths as number[]).reduce((sum, w) => sum + w, 0) : 0;
        const merges = validMerges(op.merges, rows.length, width);
        if (merges === null) return bad("insert_table merges: [{cell:\"r1c2\", rowSpan?, colSpan?}] inside the table, spans >= 1, not overlapping");
        ops.push({ op: "insert_table", rows: (rows as string[][]).map((row) => [...row, ...Array(width - row.length).fill("")]), ...(Array.isArray(widths) ? { widths: (widths as number[]).map((w) => Math.round((w / total) * 10000) / 10000) } : {}), ...(merges.length ? { merges } : {}), ...(op.after !== undefined ? { after: op.after as string } : {}), ...(op.id !== undefined && id(op.id) ? { id: op.id } : {}) });
        break;
      }
      case "delete_block":
      case "delete_slide":
        if (!id(op.target)) return bad(`${op.op} needs target`);
        ops.push({ op: op.op, target: op.target });
        break;
      case "add_slide":
        if (!optionalId(op.after) || (op.title !== undefined && !str(op.title, 10_000)) || (op.body !== undefined && !str(op.body))) return bad("add_slide takes optional after, title, body");
        ops.push({ op: "add_slide", ...(op.after !== undefined ? { after: op.after as string } : {}), ...(op.title !== undefined ? { title: op.title as string } : {}), ...(op.body !== undefined ? { body: op.body as string } : {}), ...(op.id !== undefined && id(op.id) ? { id: op.id } : {}) });
        break;
      case "set_format": {
        const format = validFormat(op.format);
        if (!str(op.target, 200) || !op.target || !format || (op.heading !== undefined && (!Number.isSafeInteger(op.heading) || Number(op.heading) < 0 || Number(op.heading) > 6))) {
          return bad("set_format needs target and format {bold, italic, underline: boolean; size: 1-400 pt; color: #rrggbb; align: left|center|right|justify}; optional heading 0-6");
        }
        if (!Object.keys(format).length && op.heading === undefined) return bad("set_format changes nothing");
        ops.push({ op: "set_format", target: op.target, format, ...(op.heading !== undefined ? { heading: Number(op.heading) } : {}) });
        break;
      }
      case "add_sheet":
        if (!str(op.name, 31) || !op.name.trim() || /[\\/?*[\]:]/.test(op.name)) return bad("add_sheet needs a name (<=31 chars, no \\ / ? * [ ] :)");
        ops.push({ op: "add_sheet", name: op.name.trim(), ...(op.id !== undefined && id(op.id) ? { id: op.id } : {}) });
        break;
      default:
        return bad("unknown op");
    }
  }
  return { ok: true, ops };
}

function validFormat(value: unknown): LiveFormatPatch | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const out: LiveFormatPatch = {};
  for (const [key, field] of Object.entries(raw)) {
    if (field === null && ["bold", "italic", "underline", "size", "color", "align", "fill"].includes(key)) { (out as Record<string, null>)[key] = null; continue; }
    if (key === "bold" || key === "italic" || key === "underline") { if (typeof field !== "boolean") return null; out[key] = field; }
    else if (key === "size") { if (typeof field !== "number" || !(field >= 1 && field <= 400)) return null; out.size = Math.round(field * 2) / 2; }
    else if (key === "color" || key === "fill") { if (typeof field !== "string" || !/^#[0-9a-fA-F]{6}$/.test(field)) return null; out[key] = field.toLowerCase(); }
    else if (key === "align") { if (!["left", "center", "right", "justify"].includes(String(field))) return null; out.align = field as LiveFormat["align"]; }
    else return null;
  }
  return out;
}

// ── fold ────────────────────────────────────────────────────────────────────────────────────────────────────────

export class LiveDocumentOpError extends Error {
  constructor(readonly reason: string, readonly detail?: string) { super(detail ? `${reason}: ${detail}` : reason); }
}

function cloneModel(model: LiveDocumentModel): LiveDocumentModel {
  return JSON.parse(JSON.stringify(model)) as LiveDocumentModel;
}

/** Locates a text target: a paragraph block, a table cell or a slide shape. */
export function findLiveTextTarget(model: LiveDocumentModel, target: string): { get(): string; set(text: string): void } | null {
  if (model.kind === "flow") {
    for (const block of model.blocks) {
      if (block.type === "paragraph" && block.id === target) return { get: () => block.text, set: (text) => { block.text = text; } };
      if (block.type === "table" && target.startsWith(`${block.id}.`)) {
        for (const row of block.rows) for (const cell of row) if (cell?.id === target) return { get: () => cell.text, set: (text) => { cell.text = text; } };
      }
    }
  } else if (model.kind === "slides") {
    for (const slide of model.slides) for (const shape of slide.shapes) {
      if (shape.id === target && shape.role !== "object") return { get: () => shape.text, set: (text) => { shape.text = text; } };
    }
  }
  return null;
}

/** Where a target keeps its format: paragraph, table cell, slide shape or sheet cell (`<sheet>!A1`). */
export function findFormatHolder(model: LiveDocumentModel, target: string): { get(): LiveFormat; set(format: LiveFormat): void; setHeading?: (level: number) => void } | null {
  if (model.kind === "sheet") {
    const bang = target.lastIndexOf("!");
    if (bang <= 0) return null;
    const sheet = findSheet(model, target.slice(0, bang));
    const address = target.slice(bang + 1).toUpperCase();
    if (!sheet || !parseCellAddress(address)) return null;
    return {
      get: () => sheet.cells[address]?.format ?? {},
      set: (format) => { sheet.cells[address] = { ...(sheet.cells[address] ?? { v: "" }), format }; },
    };
  }
  if (model.kind === "flow") {
    for (const block of model.blocks) {
      if (block.type === "paragraph" && block.id === target) {
        return {
          get: () => block.format ?? {},
          set: (format) => { block.format = format; },
          setHeading: (level) => { if (level > 0) block.heading = level; else delete block.heading; },
        };
      }
      if (block.type === "table" && target.startsWith(`${block.id}.`)) {
        for (const row of block.rows) for (const cell of row) if (cell?.id === target) return { get: () => cell.format ?? {}, set: (format) => { cell.format = format; } };
      }
    }
    return null;
  }
  for (const slide of model.slides) for (const shape of slide.shapes) {
    if (shape.id === target && shape.role !== "object") return { get: () => shape.format ?? {}, set: (format) => { shape.format = format; } };
  }
  return null;
}

function findSheet(model: Extract<LiveDocumentModel, { kind: "sheet" }>, ref: string): LiveSheet | undefined {
  return model.sheets.find((sheet) => sheet.id === ref) ?? model.sheets.find((sheet) => sheet.name === ref)
    ?? model.sheets.find((sheet) => sheet.name.toLowerCase() === ref.trim().toLowerCase());
}

function insertIndex(ids: string[], after: string | undefined): number {
  if (after === undefined) return ids.length;
  if (after === "start") return 0;
  const index = ids.indexOf(after);
  if (index < 0) throw new LiveDocumentOpError("target_unknown", `after ${after}`);
  return index + 1;
}

/**
 * Applies validated ops to a copy of the model. Insert ops must already carry the host-assigned `id`
 * (assignLiveDocumentIds) so that every process folding the journal derives the same ids.
 */
export function applyLiveDocumentOps(model: LiveDocumentModel, ops: LiveDocumentOp[]): LiveDocumentModel {
  const next = cloneModel(model);
  let recalc = false;
  for (const op of ops) {
    if (op.op === "set_cell" || op.op === "add_sheet") {
      if (next.kind !== "sheet") throw new LiveDocumentOpError("op_unsupported_for_format", op.op);
      if (op.op === "add_sheet") {
        if (next.sheets.some((sheet) => sheet.name.toLowerCase() === op.name.toLowerCase())) throw new LiveDocumentOpError("sheet_exists", op.name);
        next.sheets.push({ id: op.id ?? `sheet-${next.sheets.length + 1}`, name: op.name, cells: {} });
        continue;
      }
      const sheet = findSheet(next, op.sheet);
      if (!sheet) throw new LiveDocumentOpError("target_unknown", `sheet ${op.sheet}`);
      const value = op.value;
      // The cell keeps its format and number format when only its value changes.
      const prior = sheet.cells[op.cell];
      const keep = { ...(prior?.format ? { format: prior.format } : {}), ...(prior?.nf ? { nf: prior.nf } : {}) };
      if (value === "") delete sheet.cells[op.cell];
      else if (value.startsWith("=") && value.length > 1) sheet.cells[op.cell] = { v: "", f: value.slice(1), ...keep };
      else sheet.cells[op.cell] = { v: value, ...keep };
      recalc = true;
      continue;
    }
    if (op.op === "set_format") {
      const holder = findFormatHolder(next, op.target);
      if (!holder) throw new LiveDocumentOpError("target_unknown", op.target);
      const merged: Record<string, unknown> = { ...holder.get(), ...op.format };
      for (const key of Object.keys(merged)) if (merged[key] === null) delete merged[key];
      holder.set(merged as LiveFormat);
      if (op.heading !== undefined) {
        if (!holder.setHeading) throw new LiveDocumentOpError("op_invalid", "heading applies to paragraphs");
        holder.setHeading(op.heading);
      }
      continue;
    }
    if (op.op === "set_text" || op.op === "insert_text") {
      const target = findLiveTextTarget(next, op.target);
      if (!target) throw new LiveDocumentOpError("target_unknown", op.target);
      if (op.op === "set_text") target.set(op.text);
      else {
        const current = target.get();
        const at = op.at === undefined ? current.length : Math.min(op.at, current.length);
        target.set(current.slice(0, at) + op.text + current.slice(at));
      }
      continue;
    }
    if (op.op === "insert_paragraph" || op.op === "insert_table" || op.op === "delete_block") {
      if (next.kind !== "flow") throw new LiveDocumentOpError("op_unsupported_for_format", op.op);
      const ids = next.blocks.map((block) => block.id);
      if (op.op === "delete_block") {
        const index = ids.indexOf(op.target);
        if (index < 0) throw new LiveDocumentOpError("target_unknown", op.target);
        const block = next.blocks[index];
        if (block.type !== "object" && block.fixed) throw new LiveDocumentOpError("block_protected", `${op.target} holds the section definition; edit its text instead`);
        if (next.blocks.filter((item) => item.type !== "object").length <= 1) throw new LiveDocumentOpError("last_block", op.target);
        next.blocks.splice(index, 1);
        continue;
      }
      if (!op.id) throw new LiveDocumentOpError("id_unassigned", op.op);
      let index = insertIndex(ids, op.after);
      // Nothing goes before the paragraph that defines the section (HWP/HWPX): "start" means right after it.
      const first = next.blocks[0];
      if (index === 0 && first && first.type !== "object" && first.fixed) index = 1;
      if (op.op === "insert_paragraph") next.blocks.splice(index, 0, { id: op.id, type: "paragraph", text: op.text, ...(op.heading ? { heading: op.heading } : {}), ...(op.pageBreak ? { pageBreak: "before" as const } : {}) });
      else {
        const rows: Array<Array<LiveTableCell | null>> = op.rows.map((row, r) => row.map((text, c) => ({ id: `${op.id}.r${r + 1}c${c + 1}`, text })));
        // A merged range keeps its anchor cell (with the spans); the cells it covers are null, as when reading a file.
        for (const merge of op.merges ?? []) {
          const [, r, c] = /^r(\d+)c(\d+)$/.exec(merge.cell)!.map(Number);
          for (let y = r - 1; y < r - 1 + (merge.rowSpan ?? 1); y++) for (let x = c - 1; x < c - 1 + (merge.colSpan ?? 1); x++) if (y !== r - 1 || x !== c - 1) rows[y][x] = null;
          rows[r - 1][c - 1] = { ...rows[r - 1][c - 1]!, ...(merge.rowSpan ? { rowSpan: merge.rowSpan } : {}), ...(merge.colSpan ? { colSpan: merge.colSpan } : {}) };
        }
        next.blocks.splice(index, 0, { id: op.id, type: "table", rows, ...(op.widths ? { colWidths: op.widths } : {}) });
      }
      continue;
    }
    if (op.op === "add_slide" || op.op === "delete_slide") {
      if (next.kind !== "slides") throw new LiveDocumentOpError("op_unsupported_for_format", op.op);
      const ids = next.slides.map((slide) => slide.id);
      if (op.op === "delete_slide") {
        const index = ids.indexOf(op.target);
        if (index < 0) throw new LiveDocumentOpError("target_unknown", op.target);
        if (next.slides.length <= 1) throw new LiveDocumentOpError("last_slide", op.target);
        next.slides.splice(index, 1);
        continue;
      }
      if (!op.id) throw new LiveDocumentOpError("id_unassigned", op.op);
      const index = insertIndex(ids, op.after);
      next.slides.splice(index, 0, {
        id: op.id,
        shapes: [
          { id: `${op.id}.title`, role: "title", text: op.title ?? "", x: 0.06, y: 0.06, w: 0.88, h: 0.16 },
          { id: `${op.id}.body`, role: "body", text: op.body ?? "", x: 0.06, y: 0.26, w: 0.88, h: 0.66 },
        ],
      });
      continue;
    }
  }
  // Formulas show what they compute: every formula cell is re-evaluated after a cell changed.
  if (recalc && next.kind === "sheet") recalculateSheets(next.sheets);
  return next;
}

/** Host side: gives every insert op a deterministic id derived from the journal sequence. */
export function assignLiveDocumentIds(ops: LiveDocumentOp[], seq: number): { ops: LiveDocumentOp[]; created: string[] } {
  const created: string[] = [];
  const out = ops.map((op, index) => {
    if (op.op === "insert_paragraph" || op.op === "insert_table" || op.op === "add_slide" || op.op === "add_sheet") {
      const assigned = `n${seq}x${index + 1}`;
      created.push(assigned);
      return { ...op, id: assigned };
    }
    return op;
  });
  return { ops: out, created };
}

/** Ids an op touches; used for conflict checks against entries newer than the caller's base revision. */
export function liveDocumentOpTargets(op: LiveDocumentOp): string[] {
  if (op.op === "set_cell") return [`${op.sheet}!${op.cell}`];
  if (op.op === "set_text" || op.op === "insert_text" || op.op === "delete_block" || op.op === "delete_slide") return [op.target];
  if (op.op === "set_format") return [`format:${op.target}`];
  return [];
}

/** Compact format marker for the outline, e.g. ` {bold 14pt center #c00000}`; empty when unformatted. */
export function liveFormatTag(format: LiveFormat | undefined): string {
  if (!format) return "";
  const parts = [format.bold ? "bold" : "", format.italic ? "italic" : "", format.underline ? "underline" : "", format.size ? `${format.size}pt` : "", format.align && format.align !== "left" && format.align !== "justify" ? format.align : "", format.color && format.color !== "#000000" ? format.color : "", format.fill ? `fill ${format.fill}` : ""].filter(Boolean);
  return parts.length ? ` {${parts.join(" ")}}` : "";
}

/** Plain-text outline the AI reads (ids first, so it can address them). */
export function liveDocumentOutline(model: LiveDocumentModel, options: { maxChars?: number } = {}): { text: string; truncated: boolean } {
  const max = options.maxChars ?? 120_000;
  const lines: string[] = [];
  if (model.kind === "sheet") {
    for (const sheet of model.sheets) {
      lines.push(`# sheet ${sheet.name} (id ${sheet.id})`);
      const addresses = Object.keys(sheet.cells).sort((a, b) => {
        const pa = parseCellAddress(a)!; const pb = parseCellAddress(b)!;
        return pa.row - pb.row || pa.col - pb.col;
      });
      for (const address of addresses) {
        const cell = sheet.cells[address];
        lines.push(`${address}\t${cell.f ? `=${cell.f}\t(${cell.v})` : cell.v}${liveFormatTag(cell.format)}`);
      }
    }
  } else if (model.kind === "flow") {
    if (model.page) lines.push(`# page ${model.page.width}x${model.page.height}mm${model.defaultSize ? `, body ${model.defaultSize}pt` : ""}`);
    for (const block of model.blocks) {
      if (block.type === "paragraph") lines.push(`[${block.id}]${block.heading ? ` h${block.heading}` : ""}${block.pageBreak ? ` (page break ${block.pageBreak})` : ""}${liveFormatTag(block.format)} ${block.text.replace(/\n/g, "\\n")}`);
      else if (block.type === "object") lines.push(`[${block.id}] (${block.label})`);
      else {
        lines.push(`[${block.id}] table${block.colWidths ? ` widths ${block.colWidths.map((w) => Math.round(w * 100)).join("/")}` : ""}`);
        for (const row of block.rows) lines.push(`  | ${row.map((cell) => cell ? `${cell.id}${liveFormatTag(cell.format)}: ${cell.text.replace(/\n/g, "\\n")}` : "~").join(" | ")}`);
      }
    }
  } else {
    for (const [index, slide] of model.slides.entries()) {
      lines.push(`# slide ${index + 1} (id ${slide.id})`);
      for (const shape of slide.shapes) {
        if (shape.role === "object") { if (shape.label) lines.push(`  [${shape.id}] (${shape.label})`); continue; }
        lines.push(`  [${shape.id}] ${shape.role}${liveFormatTag(shape.format)}: ${shape.text.replace(/\n/g, "\\n")}`);
      }
    }
  }
  let text = "";
  for (const line of lines) {
    if (text.length + line.length + 1 > max) return { text, truncated: true };
    text += `${line}\n`;
  }
  return { text, truncated: false };
}
