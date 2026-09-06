import { createHash } from "node:crypto";
import type {
  ScienceAnalysisModelSpec,
  ScienceArtifact,
  ScienceDatasetCell,
  ScienceDatasetTablePayload,
  ScienceResearchRun,
} from "./science-contract";

export const SCIENCE_TABLE_SCHEMA = "agentlas.science-table/v1" as const;
export const SCIENCE_TABLE_RENDERER_ID = "agentlas.table" as const;
export const SCIENCE_TABLE_RENDERER_VERSION = "1.0.0" as const;
export const SCIENCE_TABLE_ARTIFACT_KIND = "table" as const;
export const SCIENCE_TABLE_LAB_ID = "data-table" as const;
export const SCIENCE_PAIRED_TABLE_ALIGNER_ID = "agentlas.paired-artifact-table-aligner" as const;
export const SCIENCE_PAIRED_TABLE_ALIGNER_VERSION = "1.0.0" as const;
export const SCIENCE_PAIRED_TABLE_ALIGNER_INPUT_SCHEMA = "agentlas.science.paired-table-alignment-input/v1" as const;
export const SCIENCE_PAIRED_TABLE_ALIGNER_OUTPUT_MIME = "application/vnd.agentlas.science.table+json" as const;
export const SCIENCE_PAIRED_TABLE_METHODS = [
  "pearson_correlation",
  "spearman_correlation",
  "kendall_correlation",
  "paired_t_test",
  "wilcoxon_signed_rank",
] as const;
export type SciencePairedTableMethod = typeof SCIENCE_PAIRED_TABLE_METHODS[number];

export interface SciencePairedTableSourceInput {
  artifactId: string;
  artifactVersion: number;
  contentSha256: string;
  keyColumn: string;
  valueColumn: string;
  outputColumn: string;
  label: string;
}

export interface PrepareSciencePairedStatisticsTableInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  title: string;
  outputKeyColumn: string;
  sources: [SciencePairedTableSourceInput, SciencePairedTableSourceInput];
  methods: SciencePairedTableMethod[];
  model: ScienceAnalysisModelSpec;
  minimumCompletePairs: number;
}

export interface PrepareSciencePairedStatisticsTableResult {
  run: ScienceResearchRun;
  artifact: ScienceArtifact;
  table: ScienceDatasetTablePayload;
  preparation: {
    dataInputs: Array<{ artifactId: string; artifactVersion: number; contentSha256: string }>;
    model: ScienceAnalysisModelSpec;
    modelSha256: string;
    requiredDiagnostics: string[];
    sourceTables: Array<Record<string, unknown>>;
    completePairCount: number;
    minimumCompletePairs: number;
    readyForStatistics: boolean;
  };
  replayed: boolean;
}

export interface SciencePairedSeriesAlignmentSource {
  outputColumn: string;
  values: ReadonlyArray<{ key: string; value: number | null }>;
}

export interface SciencePairedSeriesAlignment {
  rows: Array<Record<string, string | number | boolean | null>>;
  nullCount: number;
  completePairCount: number;
}

/** Full-outer exact-key alignment without imputation. Statistical sufficiency is a later gate. */
export function alignSciencePairedSeries(
  outputKeyColumn: string,
  sources: readonly [SciencePairedSeriesAlignmentSource, SciencePairedSeriesAlignmentSource],
): SciencePairedSeriesAlignment {
  const outputNames = [outputKeyColumn, "paired_eligible", ...sources.flatMap((source) => [source.outputColumn, `${source.outputColumn}_missing`])];
  if (new Set(outputNames.map((name) => name.toLocaleLowerCase("en-US"))).size !== outputNames.length) {
    throw new Error("science-paired-table-output-column-duplicate");
  }
  const maps = sources.map((source, sourceIndex) => {
    const values = new Map<string, number | null>();
    for (const entry of source.values) {
      if (typeof entry.key !== "string" || !entry.key.trim()
        || (entry.value !== null && (typeof entry.value !== "number" || !Number.isFinite(entry.value)))) {
        throw new Error(`science-paired-table-source-${sourceIndex + 1}-row-invalid`);
      }
      if (values.has(entry.key)) throw new Error(`science-paired-table-source-${sourceIndex + 1}-duplicate-key`);
      values.set(entry.key, entry.value);
    }
    return values;
  }) as [Map<string, number | null>, Map<string, number | null>];
  const keys = [...new Set(maps.flatMap((values) => [...values.keys()]))]
    .sort((left, right) => left.localeCompare(right, "en-US", { numeric: true, sensitivity: "variant" }));
  const completePairCount = keys.filter((key) => maps.every((values) => values.has(key) && values.get(key) !== null)).length;
  if (keys.length < 1) throw new Error("science-paired-table-no-keys");
  const rows = keys.map((key) => {
    const row: Record<string, string | number | boolean | null> = { [outputKeyColumn]: key, paired_eligible: true };
    sources.forEach((source, sourceIndex) => {
      const values = maps[sourceIndex]!;
      const value = values.has(key) ? values.get(key)! : null;
      row[source.outputColumn] = value;
      row[`${source.outputColumn}_missing`] = value === null;
      if (value === null) row.paired_eligible = false;
    });
    return row;
  });
  const nullCount = rows.reduce((count, row) => count + Object.values(row).filter((value) => value === null).length, 0);
  return { rows, nullCount, completePairCount };
}
export const SCIENCE_TABLE_LIMITS = {
  maxPayloadBytes: 4 * 1024 * 1024, maxColumns: 1_000, maxRows: 5_000,
  maxCells: 250_000, maxCellTextBytes: 16 * 1024, maxColumnNameBytes: 240,
} as const;

const SHA256_RE = /^[a-f0-9]{64}$/;
const UNSAFE_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort(); const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]));
}
export function scienceTableSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex");
}
function formulaLooking(value: string): boolean {
  const trimmed = value.trimStart();
  return /^[=+@]/.test(trimmed) || /^-(?!\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$)/.test(trimmed);
}

/** Strings remain inert data. The core renderer must use textContent only. */
export function validateScienceTablePayload(value: unknown): ScienceDatasetTablePayload {
  const payload = record(value);
  if (!payload || Buffer.byteLength(JSON.stringify(value), "utf8") > SCIENCE_TABLE_LIMITS.maxPayloadBytes
    || !exactKeys(payload, ["schema", "columns", "rows", "profile", "receipts"])
    || payload.schema !== SCIENCE_TABLE_SCHEMA || !Array.isArray(payload.columns) || !Array.isArray(payload.rows)) throw new Error("science-table-payload-invalid");
  if (payload.columns.length < 1 || payload.columns.length > SCIENCE_TABLE_LIMITS.maxColumns
    || payload.rows.length < 1 || payload.rows.length > SCIENCE_TABLE_LIMITS.maxRows
    || payload.rows.length * payload.columns.length > SCIENCE_TABLE_LIMITS.maxCells) throw new Error("science-table-size-limit-exceeded");
  const columns = payload.columns.map((entry) => {
    const column = record(entry);
    if (!column || !exactKeys(column, ["name", "logicalType", "nullable"])
      || typeof column.name !== "string" || !column.name.trim() || Buffer.byteLength(column.name, "utf8") > SCIENCE_TABLE_LIMITS.maxColumnNameBytes
      || UNSAFE_CONTROL_RE.test(column.name) || !["integer", "number", "boolean", "string"].includes(String(column.logicalType))
      || typeof column.nullable !== "boolean") throw new Error("science-table-column-invalid");
    return { name: column.name, logicalType: column.logicalType, nullable: column.nullable } as ScienceDatasetTablePayload["columns"][number];
  });
  if (new Set(columns.map((column) => column.name.toLocaleLowerCase("en-US"))).size !== columns.length) throw new Error("science-table-column-duplicate");
  const names = columns.map((column) => column.name);
  let nullCount = 0; let formulaLikeCellCount = 0;
  const rows = payload.rows.map((entry) => {
    const row = record(entry); if (!row || !exactKeys(row, names)) throw new Error("science-table-row-invalid");
    const normalized: Record<string, ScienceDatasetCell> = {};
    columns.forEach((column) => {
      const cell = row[column.name];
      if (cell === null) { if (!column.nullable) throw new Error("science-table-cell-invalid"); nullCount += 1; }
      else if (column.logicalType === "integer") { if (typeof cell !== "number" || !Number.isSafeInteger(cell)) throw new Error("science-table-cell-invalid"); }
      else if (column.logicalType === "number") { if (typeof cell !== "number" || !Number.isFinite(cell)) throw new Error("science-table-cell-invalid"); }
      else if (column.logicalType === "boolean") { if (typeof cell !== "boolean") throw new Error("science-table-cell-invalid"); }
      else {
        if (typeof cell !== "string" || Buffer.byteLength(cell, "utf8") > SCIENCE_TABLE_LIMITS.maxCellTextBytes || UNSAFE_CONTROL_RE.test(cell)) throw new Error("science-table-cell-invalid");
        if (formulaLooking(cell)) formulaLikeCellCount += 1;
      }
      normalized[column.name] = cell as ScienceDatasetCell;
    });
    return normalized;
  });
  const profile = record(payload.profile);
  if (!profile || !exactKeys(profile, ["rowCount", "columnCount", "nullCount", "formulaLikeCellCount"])
    || profile.rowCount !== rows.length || profile.columnCount !== columns.length || profile.nullCount !== nullCount
    || profile.formulaLikeCellCount !== formulaLikeCellCount) throw new Error("science-table-counts-invalid");
  const receipts = record(payload.receipts);
  if (!receipts || !exactKeys(receipts, ["parserId", "parserVersion", "rawSha256", "headerSha256", "rowsSha256", "tableSha256"])
    || !["agentlas.csv-to-table", "agentlas.comparative-genomics-publication-table", SCIENCE_PAIRED_TABLE_ALIGNER_ID].includes(String(receipts.parserId))
    || receipts.parserVersion !== "1.0.0"
    || ![receipts.rawSha256, receipts.headerSha256, receipts.rowsSha256, receipts.tableSha256].every((entry) => typeof entry === "string" && SHA256_RE.test(entry))) throw new Error("science-table-hashes-invalid");
  if (receipts.headerSha256 !== scienceTableSha256(names) || receipts.rowsSha256 !== scienceTableSha256(rows)
    || receipts.tableSha256 !== scienceTableSha256({ schema: SCIENCE_TABLE_SCHEMA, columns, rows, profile })) throw new Error("science-table-content-integrity-failed");
  return { schema: SCIENCE_TABLE_SCHEMA, columns, rows, profile: profile as unknown as ScienceDatasetTablePayload["profile"], receipts: receipts as unknown as ScienceDatasetTablePayload["receipts"] };
}
