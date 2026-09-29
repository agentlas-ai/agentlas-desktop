/**
 * 표 자료(xlsx·csv·tsv)를 산출물 패널의 "데이터 보기"·빠른 차트·썸네일에 쓸 모양으로 — 순수 함수.
 *
 * ★openpyxl·pandas 가 쓴 xlsx 는 수식 칸에 계산값(<v>)을 저장하지 않는다. 뷰어는 그걸 0 으로 그렸다
 *   (실측 2026-09-29: 합계·증감률 열 전부 0). 가짜 0 은 틀린 숫자다 — 수식 그대로(=SUM(B2:D2)) 또는
 *   "값 없음(수식)" 으로 보인다. 여기서 재계산은 하지 않는다(엑셀 계산 엔진을 흉내 내면 또 틀린 숫자가 된다).
 */
import { entryText, readZip, writeZip, type ZipEntry } from "./zip-lite";

export type TableCell = string | number | boolean | null | { formula: string };
export interface TableSheet { name: string; rows: TableCell[][] }

export const TABLE_LIMITS = { maxRows: 20_000, maxColumns: 200, chartRows: 400 } as const;

export function uncachedFormulaLabel(ko: boolean): string {
  return ko ? "값 없음(수식)" : "No value (formula)";
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&");
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function attr(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`));
  return match ? decodeXml(match[1]) : undefined;
}

function columnIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? "A";
  let value = 0;
  for (const ch of letters) value = value * 26 + ch.charCodeAt(0) - 64;
  return value - 1;
}

function textRuns(xml: string): string {
  const parts: string[] = [];
  for (const match of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) parts.push(decodeXml(match[1]));
  return parts.join("");
}

const CELL_RE = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
const ROW_RE = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;

async function workbookSheets(entries: ZipEntry[]): Promise<Array<{ name: string; path: string }>> {
  const workbook = await entryText(entries, "xl/workbook.xml");
  const rels = await entryText(entries, "xl/_rels/workbook.xml.rels");
  if (!workbook || !rels) throw new Error("not an xlsx workbook");
  const targetById = new Map<string, string>();
  for (const match of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(match[1], "Id");
    const target = attr(match[1], "Target");
    if (!id || !target || /TargetMode\s*=\s*"External"/i.test(match[1])) continue;
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    if (!path.includes("..")) targetById.set(id, path);
  }
  const sheets: Array<{ name: string; path: string }> = [];
  for (const match of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = attr(match[1], "name");
    const id = attr(match[1], "r:id");
    const path = id ? targetById.get(id) : undefined;
    if (name && path) sheets.push({ name, path });
  }
  return sheets;
}

/** styles.xml → 칸 서식 번호(s)마다 날짜 서식인지. 날짜 칸은 일련번호가 아니라 yyyy-mm-dd 로 읽는다. */
async function dateStyleFlags(entries: ZipEntry[]): Promise<boolean[]> {
  const xml = await entryText(entries, "xl/styles.xml");
  if (!xml) return [];
  const custom = new Map<number, string>();
  for (const match of xml.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const id = Number(attr(match[1], "numFmtId"));
    const code = attr(match[1], "formatCode") ?? "";
    if (Number.isFinite(id)) custom.set(id, code);
  }
  const isDateCode = (code: string) => {
    const bare = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
    return /[ymd]/i.test(bare) && !/^[#0.,%\s+-]*$/.test(bare);
  };
  const cellXfs = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
  const flags: boolean[] = [];
  for (const match of cellXfs.matchAll(/<xf\b([^>]*)\/?>/g)) {
    const id = Number(attr(match[1], "numFmtId") ?? 0);
    flags.push((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || (custom.has(id) && isDateCode(custom.get(id) ?? "")));
  }
  return flags;
}

function excelSerialToDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000);
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return String(serial);
  const iso = date.toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** xlsx 를 표로 읽는다. 계산값이 없는 수식 칸은 { formula } 로 남긴다. */
export async function readXlsxTables(buffer: ArrayBuffer | Uint8Array, limits = TABLE_LIMITS): Promise<TableSheet[]> {
  const entries = readZip(buffer);
  const sharedXml = await entryText(entries, "xl/sharedStrings.xml");
  const shared: string[] = [];
  if (sharedXml) for (const match of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textRuns(match[1]));
  const dateStyles = await dateStyleFlags(entries);
  const sheets: TableSheet[] = [];
  for (const sheet of await workbookSheets(entries)) {
    const xml = await entryText(entries, sheet.path);
    if (!xml) continue;
    const rows: TableCell[][] = [];
    const sharedFormulas = new Map<string, string>();
    for (const rowMatch of xml.matchAll(ROW_RE)) {
      if (rows.length >= limits.maxRows) break;
      const rowNumber = Number(attr(rowMatch[1], "r") ?? rows.length + 1);
      const row: TableCell[] = [];
      for (const cellMatch of (rowMatch[2] ?? "").matchAll(CELL_RE)) {
        const attrs = cellMatch[1];
        const inner = cellMatch[2] ?? "";
        const col = columnIndex(attr(attrs, "r") ?? "A");
        if (col >= limits.maxColumns) continue;
        const type = attr(attrs, "t") ?? "n";
        const formulaMatch = inner.match(/<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/);
        const valueMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
        const raw = valueMatch ? decodeXml(valueMatch[1]) : undefined;
        let value: TableCell = null;
        if (formulaMatch && (raw === undefined || raw === "")) {
          const text = formulaMatch[2] ? decodeXml(formulaMatch[2]).trim() : "";
          const si = attr(formulaMatch[1], "si");
          if (text && si !== undefined) sharedFormulas.set(si, text);
          const formula = text || (si !== undefined ? sharedFormulas.get(si) ?? "" : "");
          value = { formula: formula ? (formula.startsWith("=") ? formula : `=${formula}`) : "" };
        } else if (type === "s") value = shared[Number(raw)] ?? "";
        else if (type === "inlineStr") value = textRuns(inner);
        else if (type === "str" || type === "e") value = raw ?? "";
        else if (type === "b") value = raw === "1";
        else if (raw !== undefined && raw !== "") {
          const numeric = Number(raw);
          const style = Number(attr(attrs, "s") ?? 0);
          value = Number.isFinite(numeric) ? (dateStyles[style] && numeric > 0 && numeric < 2_958_466 ? excelSerialToDate(numeric) : numeric) : raw;
        }
        while (row.length < col) row.push(null);
        row[col] = value;
      }
      while (rows.length < rowNumber - 1 && rows.length < limits.maxRows) rows.push([]);
      rows.push(row);
    }
    sheets.push({ name: sheet.name, rows });
  }
  return sheets;
}

/**
 * 격자 뷰어(@file-viewer)에 넘기기 전에 — 계산값 없는 수식 칸을 글자(=SUM(…) 또는 "값 없음(수식)")로 바꾼
 * 사본을 만든다. 바꿀 것이 없으면 null(원본 그대로 쓴다).
 */
export async function markUncachedFormulas(buffer: ArrayBuffer, ko: boolean): Promise<ArrayBuffer | null> {
  const entries = readZip(buffer);
  const replacements = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  for (const sheet of await workbookSheets(entries)) {
    const xml = await entryText(entries, sheet.path);
    if (!xml || !/<f\b/.test(xml)) continue;
    const sharedFormulas = new Map<string, string>();
    let changed = false;
    const next = xml.replace(CELL_RE, (whole, attrs: string, inner: string | undefined) => {
      if (!inner) return whole;
      const formulaMatch = inner.match(/<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/);
      if (!formulaMatch) return whole;
      const valueMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
      if (valueMatch && valueMatch[1] !== "") return whole;
      const text = formulaMatch[2] ? decodeXml(formulaMatch[2]).trim() : "";
      const si = attr(formulaMatch[1], "si");
      if (text && si !== undefined) sharedFormulas.set(si, text);
      const formula = text || (si !== undefined ? sharedFormulas.get(si) ?? "" : "");
      // 공유 수식의 따라 쓰는 칸은 주소가 달라 원문을 그대로 보이면 틀린 식이 된다 — 표식만.
      const shown = text ? (text.startsWith("=") ? text : `=${text}`) : uncachedFormulaLabel(ko);
      void formula;
      changed = true;
      const keptAttrs = attrs.replace(/\s+t\s*=\s*"[^"]*"/, "");
      return `<c${keptAttrs} t="inlineStr"><is><t>${escapeXml(shown)}</t></is></c>`;
    });
    if (changed) replacements.set(sheet.path, encoder.encode(next));
  }
  if (replacements.size === 0) return null;
  const out = writeZip(entries, replacements);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

/** CSV/TSV — 따옴표·줄바꿈 안 따옴표를 다룬다. */
export function parseDelimited(text: string, delimiter: "," | "\t" = ",", limits = TABLE_LIMITS): TableCell[][] {
  const rows: TableCell[][] = [];
  let row: TableCell[] = [];
  let field = "";
  let quoted = false;
  const push = () => {
    const trimmed = field.trim();
    const numeric = trimmed !== "" && /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(trimmed);
    row.push(trimmed === "" ? null : numeric ? Number(trimmed.replace(/,/g, "")) : field);
    field = "";
  };
  const source = text.replace(/^﻿/, "");
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === "\"" && source[i + 1] === "\"") { field += "\""; i += 1; }
      else if (ch === "\"") quoted = false;
      else field += ch;
      continue;
    }
    if (ch === "\"") quoted = true;
    else if (ch === delimiter) push();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && source[i + 1] === "\n") i += 1;
      push();
      rows.push(row.slice(0, limits.maxColumns));
      row = [];
      if (rows.length >= limits.maxRows) return rows;
    } else field += ch;
  }
  if (field !== "" || row.length > 0) { push(); rows.push(row.slice(0, limits.maxColumns)); }
  return rows;
}

export function isFormulaCell(cell: TableCell): cell is { formula: string } {
  return Boolean(cell) && typeof cell === "object";
}

export function cellText(cell: TableCell, ko: boolean): string {
  if (cell === null) return "";
  if (isFormulaCell(cell)) return cell.formula || uncachedFormulaLabel(ko);
  if (typeof cell === "number") return Number.isInteger(cell) ? cell.toLocaleString(ko ? "ko-KR" : "en-US") : cell.toLocaleString(ko ? "ko-KR" : "en-US", { maximumFractionDigits: 4 });
  if (typeof cell === "boolean") return cell ? "TRUE" : "FALSE";
  return String(cell);
}

/** 머리행 + 본문. 머리칸이 비면 A,B,C. 같은 이름은 뒤에 번호. */
export function splitHeader(rows: TableCell[][]): { columns: string[]; body: TableCell[][] } {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const head = rows[0] ?? [];
  const seen = new Map<string, number>();
  const columns = Array.from({ length: width }, (_, index) => {
    const raw = head[index];
    let name = raw === null || raw === undefined || isFormulaCell(raw) ? "" : String(raw).trim();
    if (!name) name = String.fromCharCode(65 + (index % 26)) + (index >= 26 ? String(Math.floor(index / 26)) : "");
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    return count ? `${name} ${count + 1}` : name;
  });
  const body = rows.slice(1).filter((row) => row.some((cell) => cell !== null && cell !== ""));
  return { columns, body: body.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? null)) };
}

export function isNumericColumn(body: TableCell[][], index: number): boolean {
  let numbers = 0;
  let others = 0;
  for (const row of body) {
    const cell = row[index];
    if (typeof cell === "number") numbers += 1;
    else if (cell !== null && !isFormulaCell(cell)) others += 1;
  }
  return numbers > 0 && numbers >= others * 4;
}

export type SortState = { column: number; direction: "asc" | "desc" } | null;

export function sortAndFilter(body: TableCell[][], sort: SortState, query: string, ko: boolean): TableCell[][] {
  const needle = query.trim().toLowerCase();
  const rows = needle ? body.filter((row) => row.some((cell) => cellText(cell, ko).toLowerCase().includes(needle))) : body.slice();
  if (!sort) return rows;
  const factor = sort.direction === "asc" ? 1 : -1;
  const rank = (cell: TableCell): [number, number | string] => {
    if (cell === null || isFormulaCell(cell)) return [2, 0]; // 빈 칸·값 없는 수식은 늘 맨 뒤
    if (typeof cell === "number") return [0, cell];
    return [1, String(cell)];
  };
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const [ga, va] = rank(a.row[sort.column]);
      const [gb, vb] = rank(b.row[sort.column]);
      if (ga !== gb) return ga - gb;
      if (ga === 2) return a.index - b.index;
      const diff = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), ko ? "ko" : "en", { numeric: true });
      return diff === 0 ? a.index - b.index : diff * factor;
    })
    .map((item) => item.row);
}

/**
 * 고른 열로 빠른 차트 — Vega-Lite 스펙(관문 sanitizeChartSpec 을 그대로 통과하는 모양: 인라인 data.values,
 * 식·URL 없음). 범주 열 1개 + 숫자 열 1~6개. 행이 많거나 범주가 날짜처럼 보이면 선, 아니면 묶음 막대.
 */
export function quickChartSpec(input: {
  title: string;
  columns: string[];
  body: TableCell[][];
  category: number;
  values: number[];
  ko: boolean;
}): Record<string, unknown> {
  const { columns, body, category, values, ko } = input;
  const picked = values.slice(0, 6);
  const rows = body.slice(0, TABLE_LIMITS.chartRows);
  const seriesField = ko ? "계열" : "Series";
  const valueField = ko ? "값" : "Value";
  const categoryField = columns[category] ?? "category";
  const data = rows.flatMap((row) => picked
    .filter((index) => typeof row[index] === "number")
    .map((index) => ({ [categoryField]: cellText(row[category], ko), [seriesField]: columns[index], [valueField]: row[index] as number })));
  const temporalLike = rows.length > 0 && rows.every((row) => /^\d{2,4}[-./]\d{1,2}([-./]\d{1,2})?$/.test(cellText(row[category], ko)));
  const asLine = temporalLike || rows.length > 24;
  const encoding: Record<string, unknown> = {
    x: { field: categoryField, type: "ordinal", sort: null },
    y: { field: valueField, type: "quantitative" },
    color: { field: seriesField, type: "nominal" },
  };
  if (!asLine && picked.length > 1) encoding.xOffset = { field: seriesField, sort: null };
  return {
    title: { text: input.title, subtitle: ko ? `${rows.length}행 · ${picked.map((index) => columns[index]).join(", ")}` : `${rows.length} rows · ${picked.map((index) => columns[index]).join(", ")}` },
    data: { values: data },
    mark: asLine ? { type: "line", point: rows.length <= 40 } : { type: "bar" },
    encoding,
  };
}

/** docx 본문 첫 몇 줄 — 썸네일용(서식 없음). */
export async function readDocxLines(buffer: ArrayBuffer | Uint8Array, maxLines = 14): Promise<string[]> {
  const entries = readZip(buffer);
  const xml = await entryText(entries, "word/document.xml");
  if (!xml) return [];
  const lines: string[] = [];
  for (const match of xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)) {
    const text = [...match[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((part) => decodeXml(part[1])).join("").trim();
    if (text) lines.push(text);
    if (lines.length >= maxLines) break;
  }
  return lines;
}

/* ── 엑셀 안에 든 차트(xl/charts/chartN.xml) ─────────────────────────────────────────────
 * Claude 의 xlsx 뷰어는 "Charts N" 탭에 통합문서가 가진 차트를 시트 이름과 함께 그린다(레퍼런스 f011).
 * 여기서는 차트 XML 을 읽어 계열·범주를 시트 칸에서 다시 찾아(openpyxl 은 캐시를 안 쓴다) Vega-Lite 로 옮긴다 —
 * 그림은 대화의 ```chart 와 같은 ChartBlock(같은 관문·같은 디자인)이 그린다. */

export interface XlsxChartSeries { name: string; categories: string[]; values: Array<number | null> }
export interface XlsxChart {
  sheetName: string;
  title: string;
  type: "bar" | "line" | "area" | "pie" | "doughnut" | "scatter";
  horizontal: boolean;
  stacked: boolean;
  series: XlsxChartSeries[];
}

function resolveRelative(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

async function relationTargets(entries: ZipEntry[], partPath: string, typeSuffix: string): Promise<string[]> {
  const slash = partPath.lastIndexOf("/");
  const relsPath = `${partPath.slice(0, slash)}/_rels/${partPath.slice(slash + 1)}.rels`;
  const xml = await entryText(entries, relsPath);
  if (!xml) return [];
  const out: string[] = [];
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const type = attr(match[1], "Type") ?? "";
    const target = attr(match[1], "Target");
    if (!target || !type.endsWith(typeSuffix) || /TargetMode\s*=\s*"External"/i.test(match[1])) continue;
    const resolved = resolveRelative(partPath, target);
    if (!resolved.includes("..")) out.push(resolved);
  }
  return out;
}

function parseRef(formula: string): { sheet: string | null; c1: number; r1: number; c2: number; r2: number } | null {
  const match = formula.trim().match(/^(?:(?:'((?:[^']|'')+)'|([^!]+))!)?\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/i);
  if (!match) return null;
  const sheet = match[1] ? match[1].replace(/''/g, "'") : match[2] ?? null;
  const c1 = columnIndex(match[3]);
  const r1 = Number(match[4]) - 1;
  const c2 = match[5] ? columnIndex(match[5]) : c1;
  const r2 = match[6] ? Number(match[6]) - 1 : r1;
  return { sheet, c1: Math.min(c1, c2), r1: Math.min(r1, r2), c2: Math.max(c1, c2), r2: Math.max(r1, r2) };
}

function refCells(formula: string | undefined, sheets: TableSheet[], fallbackSheet: string): TableCell[] | null {
  if (!formula) return null;
  const ref = parseRef(formula);
  if (!ref) return null;
  const sheet = sheets.find((item) => item.name === (ref.sheet ?? fallbackSheet));
  if (!sheet) return null;
  const out: TableCell[] = [];
  for (let r = ref.r1; r <= ref.r2 && out.length < 5_000; r += 1) {
    for (let c = ref.c1; c <= ref.c2 && out.length < 5_000; c += 1) out.push(sheet.rows[r]?.[c] ?? null);
  }
  return out;
}

function cachePoints(xml: string | undefined): string[] {
  if (!xml) return [];
  const points: Array<[number, string]> = [];
  for (const match of xml.matchAll(/<pt\b[^>]*idx="(\d+)"[^>]*>\s*<v>([\s\S]*?)<\/v>/g)) points.push([Number(match[1]), decodeXml(match[2])]);
  const out: string[] = [];
  for (const [idx, value] of points) out[idx] = value;
  return out;
}

function refPart(xml: string, tag: string): { formula?: string; cache: string[] } | null {
  const block = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1];
  if (!block) return null;
  const formula = block.match(/<f>([\s\S]*?)<\/f>/)?.[1];
  const literal = block.match(/<v>([\s\S]*?)<\/v>/)?.[1];
  const cache = cachePoints(block);
  return { formula: formula ? decodeXml(formula) : undefined, cache: cache.length ? cache : literal ? [decodeXml(literal)] : [] };
}

function textOfTitle(xml: string): string {
  const title = xml.match(/<title>([\s\S]*?)<\/title>/)?.[1];
  if (!title) return "";
  const runs = [...title.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) => decodeXml(match[1]));
  if (runs.length) return runs.join("").trim();
  return decodeXml(title.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "").trim();
}

/** 통합문서의 모든 시트에 붙은 차트를 시트 순서대로. 계열 값은 시트 칸에서 다시 찾고, 없으면 캐시. */
export async function readXlsxCharts(buffer: ArrayBuffer | Uint8Array, sheetsIn?: TableSheet[]): Promise<XlsxChart[]> {
  const entries = readZip(buffer);
  const sheets = sheetsIn ?? await readXlsxTables(buffer);
  const charts: XlsxChart[] = [];
  for (const sheet of await workbookSheets(entries)) {
    for (const drawing of await relationTargets(entries, sheet.path, "/drawing")) {
      for (const chartPath of await relationTargets(entries, drawing, "/chart")) {
        const raw = await entryText(entries, chartPath);
        if (!raw) continue;
        // Excel 은 c: 접두사, openpyxl 은 기본 네임스페이스로 쓴다 — 차트 네임스페이스 접두사를 걷고 읽는다.
        const xml = raw.replace(/<(\/?)c:/g, "<$1");
        const chartBody = xml.match(/<chart>([\s\S]*)<\/chart>/)?.[1] ?? xml;
        const plotIndex = chartBody.indexOf("<plotArea");
        const title = textOfTitle(plotIndex > 0 ? chartBody.slice(0, plotIndex) : "") || sheet.name;
        const plot = chartBody.slice(Math.max(0, plotIndex));
        const kindMatch = plot.match(/<(bar3DChart|barChart|line3DChart|lineChart|area3DChart|areaChart|pie3DChart|pieChart|doughnutChart|scatterChart)>([\s\S]*?)<\/\1>/);
        if (!kindMatch) continue;
        const kind = kindMatch[1];
        const body = kindMatch[2];
        const type: XlsxChart["type"] = kind.startsWith("bar") ? "bar" : kind.startsWith("line") ? "line" : kind.startsWith("area") ? "area"
          : kind === "doughnutChart" ? "doughnut" : kind.startsWith("pie") ? "pie" : "scatter";
        const horizontal = /<barDir val="bar"\/>/.test(body);
        const stacked = /<grouping val="(?:stacked|percentStacked)"\/>/.test(body);
        const series: XlsxChartSeries[] = [];
        for (const ser of body.matchAll(/<ser>([\s\S]*?)<\/ser>/g)) {
          const s = ser[1];
          const nameRef = refPart(s, "tx");
          const nameCells = refCells(nameRef?.formula, sheets, sheet.name);
          const name = (nameCells && nameCells[0] !== null && !isFormulaCell(nameCells[0]) ? String(nameCells[0]) : nameRef?.cache[0]) || `${series.length + 1}`;
          const catRef = refPart(s, "cat") ?? refPart(s, "xVal");
          const valRef = refPart(s, "val") ?? refPart(s, "yVal");
          const valCells = refCells(valRef?.formula, sheets, sheet.name);
          const values = (valCells ?? (valRef?.cache ?? []).map((v) => (v === undefined ? null : Number(v))))
            .map((cell) => (typeof cell === "number" && Number.isFinite(cell) ? cell : null));
          const catCells = refCells(catRef?.formula, sheets, sheet.name);
          const categories = catCells ? catCells.map((cell) => cellText(cell, true)) : (catRef?.cache ?? []).map((v) => v ?? "");
          series.push({ name, categories: values.map((_, index) => categories[index] ?? String(index + 1)), values });
        }
        if (series.length) charts.push({ sheetName: sheet.name, title, type, horizontal, stacked, series });
      }
    }
  }
  return charts;
}

/** 엑셀 차트 → Vega-Lite(관문 통과 모양: 인라인 값, 식·URL 없음). */
export function xlsxChartSpec(chart: XlsxChart, ko: boolean): Record<string, unknown> {
  const catField = ko ? "항목" : "Category";
  const seriesField = ko ? "계열" : "Series";
  const valueField = ko ? "값" : "Value";
  const values = chart.series.flatMap((ser) => ser.values.map((value, index) => (value === null ? null : {
    [catField]: ser.categories[index] ?? String(index + 1), [seriesField]: ser.name, [valueField]: value,
  }))).filter(Boolean).slice(0, 5_000) as Array<Record<string, unknown>>;
  const title = { text: chart.title, subtitle: chart.sheetName };
  if (chart.type === "pie" || chart.type === "doughnut") {
    return {
      title, data: { values: values.filter((row) => row[seriesField] === chart.series[0].name) },
      mark: { type: "arc", ...(chart.type === "doughnut" ? { innerRadius: 60 } : {}) },
      encoding: { theta: { field: valueField, type: "quantitative" }, color: { field: catField, type: "nominal" } },
    };
  }
  if (chart.type === "scatter") {
    const numericX = values.every((row) => Number.isFinite(Number(row[catField])));
    return {
      title, data: { values: numericX ? values.map((row) => ({ ...row, [catField]: Number(row[catField]) })) : values },
      mark: { type: "point", filled: true },
      encoding: {
        x: { field: catField, type: numericX ? "quantitative" : "ordinal", ...(numericX ? { scale: { zero: false } } : { sort: null }) },
        y: { field: valueField, type: "quantitative", scale: { zero: false } },
        color: { field: seriesField, type: "nominal" },
      },
    };
  }
  const cat = { field: catField, type: "ordinal", sort: null };
  const val = { field: valueField, type: "quantitative", ...(chart.type === "line" ? { scale: { zero: false } } : {}) };
  const encoding: Record<string, unknown> = chart.horizontal ? { y: cat, x: val } : { x: cat, y: val };
  encoding.color = { field: seriesField, type: "nominal" };
  if (chart.type === "bar" && !chart.stacked && chart.series.length > 1) encoding[chart.horizontal ? "yOffset" : "xOffset"] = { field: seriesField, sort: null };
  return {
    title, data: { values },
    mark: chart.type === "bar" ? { type: "bar" } : chart.type === "area" ? { type: "area" } : { type: "line", point: values.length <= 60 },
    encoding,
  };
}
