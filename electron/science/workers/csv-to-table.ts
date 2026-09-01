import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ScienceDatasetCell, ScienceDatasetTablePayload } from "../../../shared/science-contract";

const MAX_RAW_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 5_000;
const MAX_NORMALIZED_BYTES = 4 * 1024 * 1024;
const MAX_COLUMNS = 1_000;

type CsvToken = { value: string; quoted: boolean };

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex"); }

function parseCsv(text: string): CsvToken[][] {
  const rows: CsvToken[][] = [];
  let row: CsvToken[] = [];
  let value = "";
  let quoted = false;
  let inQuotes = false;
  let afterQuote = false;
  const pushCell = () => { row.push({ value, quoted }); value = ""; quoted = false; afterQuote = false; };
  const pushRow = () => { pushCell(); rows.push(row); row = []; };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') { value += '"'; index += 1; }
        else { inQuotes = false; afterQuote = true; }
      } else value += char;
      continue;
    }
    if (afterQuote) {
      if (char === ",") { pushCell(); continue; }
      if (char === "\n") { pushRow(); continue; }
      if (char === "\r" && text[index + 1] === "\n") { index += 1; pushRow(); continue; }
      throw new Error("science-dataset-csv-after-quote-invalid");
    }
    if (char === '"') {
      if (value.length !== 0) throw new Error("science-dataset-csv-quote-invalid");
      quoted = true;
      inQuotes = true;
    } else if (char === ",") pushCell();
    else if (char === "\n") pushRow();
    else if (char === "\r") {
      if (text[index + 1] !== "\n") throw new Error("science-dataset-csv-line-ending-invalid");
      index += 1;
      pushRow();
    } else value += char;
  }
  if (inQuotes) throw new Error("science-dataset-csv-unclosed-quote");
  if (afterQuote || value.length > 0 || row.length > 0) pushRow();
  return rows;
}

function formulaLooking(value: string): boolean {
  const trimmed = value.trimStart();
  return /^[=+@]/.test(trimmed) || /^-(?!\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$)/.test(trimmed);
}

function classify(token: CsvToken): { value: ScienceDatasetCell; type: "integer" | "number" | "boolean" | "string" | "null"; formula: boolean } {
  if (!token.quoted && token.value === "") return { value: null, type: "null", formula: false };
  const formula = formulaLooking(token.value);
  if (!token.quoted && !formula && /^(?:true|false)$/i.test(token.value)) return { value: token.value.toLowerCase() === "true", type: "boolean", formula: false };
  if (!token.quoted && !formula && /^-?(?:0|[1-9]\d*)$/.test(token.value)) {
    const numeric = Number(token.value);
    if (Number.isSafeInteger(numeric)) return { value: numeric, type: "integer", formula: false };
  }
  if (!token.quoted && !formula && /^-?(?:(?:0|[1-9]\d*)\.\d+|(?:0|[1-9]\d*)[eE][+-]?\d+)$/.test(token.value)) {
    const numeric = Number(token.value);
    if (Number.isFinite(numeric)) return { value: numeric, type: "number", formula: false };
  }
  return { value: token.value, type: "string", formula };
}

export function csvToTable(rawBytes: Buffer): ScienceDatasetTablePayload {
  if (!Buffer.isBuffer(rawBytes) || rawBytes.length < 1 || rawBytes.length > MAX_RAW_BYTES) throw new Error("science-dataset-raw-size-invalid");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes); }
  catch { throw new Error("science-dataset-utf8-invalid"); }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes("\u0000")) throw new Error("science-dataset-nul-invalid");
  const parsed = parseCsv(text);
  if (parsed.length < 2) throw new Error("science-dataset-rows-invalid");
  const headerTokens = parsed[0];
  if (headerTokens.length < 1 || headerTokens.length > MAX_COLUMNS) throw new Error("science-dataset-columns-invalid");
  const headers = headerTokens.map((token) => token.value.normalize("NFC").trim());
  const seen = new Set<string>();
  for (const header of headers) {
    const key = header.toLocaleLowerCase("en-US");
    if (!header || header.length > 240 || /[\u0000-\u001f]/.test(header)) throw new Error("science-dataset-header-invalid");
    if (seen.has(key)) throw new Error("science-dataset-duplicate-header");
    seen.add(key);
  }
  const dataRows = parsed.slice(1);
  if (dataRows.length > MAX_ROWS) throw new Error("science-dataset-row-limit");
  const classified = dataRows.map((tokens) => {
    if (tokens.length !== headers.length) throw new Error("science-dataset-column-count-mismatch");
    return tokens.map(classify);
  });
  const logicalTypes = headers.map((_, column) => {
    const types = new Set(classified.map((row) => row[column].type).filter((type) => type !== "null"));
    if (types.size === 0) return "string" as const;
    if ([...types].every((type) => type === "integer" || type === "number")) return types.has("number") ? "number" as const : "integer" as const;
    return types.size === 1 ? [...types][0] as "boolean" | "string" : "string" as const;
  });
  let nullCount = 0;
  let formulaLikeCellCount = 0;
  const rows = classified.map((cells) => Object.fromEntries(cells.map((cell, column) => {
    if (cell.value === null) nullCount += 1;
    if (cell.formula) formulaLikeCellCount += 1;
    const value = logicalTypes[column] === "string" && cell.value !== null ? String(cell.value) : cell.value;
    return [headers[column], value];
  })) as Record<string, ScienceDatasetCell>);
  const rawSha256 = sha256(rawBytes);
  const columns = headers.map((name, column) => ({
    name,
    logicalType: logicalTypes[column],
    nullable: classified.some((row) => row[column].value === null),
  }));
  const tableCore = {
    schema: "agentlas.science-table/v1" as const,
    columns,
    rows,
    profile: { rowCount: rows.length, columnCount: headers.length, nullCount, formulaLikeCellCount },
  };
  const tableSha256 = sha256(canonicalJson(tableCore));
  const result: ScienceDatasetTablePayload = {
    ...tableCore,
    receipts: {
      parserId: "agentlas.csv-to-table",
      parserVersion: "1.0.0",
      rawSha256,
      headerSha256: sha256(canonicalJson(headers)),
      rowsSha256: sha256(canonicalJson(rows)),
      tableSha256,
    },
  };
  if (Buffer.byteLength(canonicalJson(result), "utf8") > MAX_NORMALIZED_BYTES) throw new Error("science-dataset-normalized-size-limit");
  return result;
}

function main(): void {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath || !outputPath || path.basename(inputPath) !== "input.csv" || path.basename(outputPath) !== "output.json"
    || path.dirname(inputPath) !== process.cwd() || path.dirname(outputPath) !== process.cwd()) throw new Error("science-dataset-worker-path-invalid");
  for (const target of [inputPath, process.cwd()]) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || target === inputPath && !stat.isFile() || target === process.cwd() && !stat.isDirectory()) throw new Error("science-dataset-worker-path-invalid");
  }
  const result = csvToTable(fs.readFileSync(inputPath));
  fs.writeFileSync(outputPath, canonicalJson(result), { encoding: "utf8", flag: "wx", mode: 0o600 });
}

if (require.main === module) {
  try { main(); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "science-dataset-worker-failed"}\n`); process.exitCode = 1; }
}
