// Resolves manuscript bindings into renderable assets.
//
// A binding says "figure <locator> is exactly artifact X version N, capture C,
// validation receipt R". This module turns that into bytes and rows without
// weakening the guarantees the store already enforces: figures come only from
// the verified capture (PNG) or the persisted vector export (SVG) of that exact
// version; tables come from the exact artifact payload so the numbers in the
// paper are the numbers the analysis produced; citations come from the exact
// source row. Nothing is re-rendered or re-computed here.

import type { ScienceManuscript, ScienceManuscriptBinding, ScienceSource } from "../../../shared/science-contract";
import {
  SCIENCE_STATISTICS_ARTIFACT_SCHEMA,
  SCIENCE_STATISTICS_FIGURE_ARTIFACT_SCHEMA,
  SCIENCE_STATISTICS_FIGURE_VECTOR_ARTIFACT_SCHEMA,
} from "../../../shared/science-statistics";
import type { ScienceStore } from "../store";
import { extractDoi, type BibliographyEntryInput } from "./bibliography";
import type { ManuscriptWarning } from "./document-model";

export type TableCell = string | number | boolean | null;

export interface ResolvedTableColumn { key: string; label: string; type: "integer" | "number" | "boolean" | "string" }

export interface ResolvedFigure {
  role: "figure";
  locator: string;
  ordinal: number;
  title: string;
  raster: RasterAsset | null;
  svg: { bytes: Uint8Array; sha256: string } | null;
  provenance: Record<string, string | number>;
}

export interface RasterAsset { bytes: Uint8Array; mimeType: "image/png" | "image/jpeg" | "image/webp"; width: number; height: number; sha256: string }

export interface ResolvedTable {
  role: "table";
  locator: string;
  ordinal: number;
  title: string;
  caption: string | null;
  columns: ResolvedTableColumn[];
  rows: Array<Record<string, TableCell>>;
  notes: string[];
  /** Verified capture of the artifact, used when the payload has no tabular data. */
  raster: RasterAsset | null;
  editable: boolean;
  provenance: Record<string, string | number>;
}

export interface ResolvedCitation {
  role: "citation";
  locator: string;
  ordinal: number;
  entry: BibliographyEntryInput;
  source: ScienceSource | null;
}

export interface ResolvedSupplement {
  role: "supplement";
  locator: string;
  ordinal: number;
  title: string;
  bytes: Uint8Array | null;
  mimeType: string | null;
  provenance: Record<string, string | number>;
}

export interface ResolvedManuscriptAssets {
  figures: Map<string, ResolvedFigure>;
  tables: Map<string, ResolvedTable>;
  citations: Map<string, ResolvedCitation>;
  supplements: ResolvedSupplement[];
  warnings: ManuscriptWarning[];
}

function warn(target: ManuscriptWarning[], code: string, message: string): void { target.push({ code, message, line: null }); }

function statisticsTable(payload: Record<string, unknown>, locator: string): { title: string; caption: string | null; columns: ResolvedTableColumn[]; rows: Array<Record<string, TableCell>>; notes: string[] } | null {
  const result = payload.result as Record<string, unknown> | undefined;
  const artifacts = Array.isArray(result?.artifacts) ? result!.artifacts as Array<Record<string, unknown>> : [];
  const tables = artifacts.filter((artifact) => artifact?.kind === "table");
  if (!tables.length) return null;
  const selector = /#(\d+)$/.exec(locator);
  const requested = selector ? Number(selector[1]) : null;
  let table: Record<string, unknown> | undefined;
  if (requested !== null) table = tables[requested];
  else {
    const selected = Number(payload.selectedTableIndex);
    table = artifacts[selected]?.kind === "table" ? artifacts[selected] : tables[0];
  }
  if (!table) return null;
  const tablePayload = table.payload as Record<string, unknown>;
  const columns = (Array.isArray(tablePayload.columns) ? tablePayload.columns as Array<Record<string, unknown>> : [])
    .map((column) => ({ key: String(column.key), label: String(column.label ?? column.key), type: (column.type === "number" || column.type === "integer" || column.type === "boolean" ? column.type : "string") as ResolvedTableColumn["type"] }));
  const rows = (Array.isArray(tablePayload.rows) ? tablePayload.rows as Array<Record<string, TableCell>> : []).map((row) => Object.fromEntries(columns.map((column) => [column.key, normalizeCell(row[column.key])])));
  return {
    title: String(tablePayload.title ?? table.role ?? "Table"),
    caption: typeof tablePayload.caption === "string" ? tablePayload.caption : null,
    columns,
    rows,
    notes: Array.isArray(tablePayload.notes) ? (tablePayload.notes as unknown[]).map(String) : [],
  };
}

function datasetTable(payload: Record<string, unknown>): { columns: ResolvedTableColumn[]; rows: Array<Record<string, TableCell>> } | null {
  const columns = Array.isArray(payload.columns) ? payload.columns as Array<Record<string, unknown>> : null;
  if (!columns?.length || columns.some((column) => typeof column.name !== "string" || !column.name.trim())) return null;
  const resolved = columns.map((column) => ({ key: String(column.name), label: String(column.name), type: (column.logicalType === "number" || column.logicalType === "integer" || column.logicalType === "boolean" ? column.logicalType : "string") as ResolvedTableColumn["type"] }));
  const rawRows = Array.isArray(payload.rows) ? payload.rows : null;
  if (!rawRows || rawRows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) return null;
  const rows = (rawRows as Array<Record<string, TableCell>>).map((row) => Object.fromEntries(resolved.map((column) => [column.key, normalizeCell(row[column.key])])));
  return { columns: resolved, rows };
}

function normalizeCell(value: unknown): TableCell {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return value;
  // A list-valued cell is ordinary in a domain table -- an astronomy row's exclusion reasons, a
  // sample's quality flags -- and JSON.stringify printed a literal `[]` or `["user-excluded"]` on
  // the page and in the delivered CSV. An empty list means nothing applied, which reads as an
  // empty cell; a list with entries reads as those entries.
  if (Array.isArray(value)) {
    const parts = value
      .filter((item) => item !== null && item !== undefined)
      .map((item) => (typeof item === "object" ? JSON.stringify(item) : String(item)))
      .filter((item) => item.length > 0);
    return parts.length === 0 ? null : parts.join("; ");
  }
  return JSON.stringify(value);
}

/**
 * A domain analysis publication table, which speaks its own dialect: columns carry `id`/`label`
 * and the rows are positional arrays rather than objects keyed by column name.
 *
 * The dataset-table converter next to this one reads `name`-keyed objects, so pointing it at a
 * domain table produced a table of the right size with every cell undefined -- a paper that looked
 * fine in the render report and printed an empty grid. Converting the dialect explicitly, and
 * returning null when it does not hold, keeps that from happening silently.
 */
export function domainPublicationTable(
  table: Record<string, unknown>,
  fallbackTitle: string,
): { title: string; caption: string | null; columns: ResolvedTableColumn[]; rows: Array<Record<string, TableCell>>; notes: string[]; editable: boolean } | null {
  const declared = Array.isArray(table.columns) ? table.columns as Array<Record<string, unknown>> : null;
  const rawRows = Array.isArray(table.rows) ? table.rows : null;
  if (!declared?.length || !rawRows) return null;
  const columns: ResolvedTableColumn[] = [];
  for (const column of declared) {
    const key = typeof column.id === "string" ? column.id : typeof column.key === "string" ? column.key : null;
    if (!key) return null;
    const unit = typeof column.unit === "string" && column.unit ? ` (${column.unit})` : "";
    const label = typeof column.label === "string" ? column.label : key;
    columns.push({
      key,
      label: `${label}${unit}`,
      type: /^(?:number|integer)\b/u.test(String(column.type ?? column.datatype ?? "")) ? "number" : "string",
    });
  }
  const rows = rawRows.map((row) => Object.fromEntries(columns.map((column, index) => [
    column.key,
    normalizeCell(Array.isArray(row) ? row[index] : (row as Record<string, unknown>)[column.key]),
  ])));
  // A table whose every cell is empty is not a table; say so rather than printing an empty grid.
  if (rows.length && rows.every((row) => Object.values(row).every((cell) => cell === null))) return null;
  const notes = Array.isArray(table.notes) ? table.notes.filter((note): note is string => typeof note === "string") : [];
  return {
    title: typeof table.title === "string" ? table.title : fallbackTitle,
    caption: typeof table.caption === "string" ? table.caption : null,
    columns, rows, notes, editable: true,
  };
}

/** A domain analysis chart payload that carries its own publication table one level in. */
const DOMAIN_TABLE_LOCATIONS: ReadonlyArray<ReadonlyArray<string>> = Object.freeze([
  ["analysis", "publicationTable"],
  ["publicationTable"],
  ["table"],
  ["publication", "observationsTable"],
  ["publication", "peaksTable"],
  ["publication", "periodogramTable"],
]);

function tableAt(payload: Record<string, unknown>, keyPath: ReadonlyArray<string>): Record<string, unknown> | null {
  let node: unknown = payload;
  for (const key of keyPath) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return null;
    node = (node as Record<string, unknown>)[key];
  }
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  const table = node as Record<string, unknown>;
  const columns = table.columns;
  return typeof table.schema === "string" && Array.isArray(columns) && columns.length > 0 && Array.isArray(table.rows) ? table : null;
}

/**
 * The publication table a domain analysis carries, wherever it keeps it.
 *
 * A binding names an artifact, not a path inside it, so when an artifact holds more than one table
 * the first location that has one wins. That ordering is deliberate: the analysis's own summary
 * comes before its raw observations.
 */
function domainPublicationTableIn(payload: Record<string, unknown>): Record<string, unknown> | null {
  for (const keyPath of DOMAIN_TABLE_LOCATIONS) {
    const table = tableAt(payload, keyPath);
    if (table) return table;
  }
  return null;
}

export function resolveManuscriptAssets(store: ScienceStore, manuscript: ScienceManuscript): ResolvedManuscriptAssets {
  const warnings: ManuscriptWarning[] = [];
  const figures = new Map<string, ResolvedFigure>();
  const tables = new Map<string, ResolvedTable>();
  const citations = new Map<string, ResolvedCitation>();
  const supplements: ResolvedSupplement[] = [];
  const projectId = manuscript.projectId;
  const bindings: ScienceManuscriptBinding[] = [...manuscript.version.bindings].sort((left, right) => left.ordinal - right.ordinal);

  for (const binding of bindings) {
    const locator = binding.locator;
    if (binding.role === "claim") continue; // claim bindings are governed by the claim ledger, not rendered inline
    if (binding.role === "citation") {
      if (binding.target.kind !== "citation") { warn(warnings, "citation-target-invalid", `Citation binding "${locator}" does not point at a citation.`); continue; }
      const citation = store.getCitationForProject(projectId, binding.target.citationId);
      const source = citation ? store.getSourceForProject(projectId, citation.sourceId) : null;
      const entry: BibliographyEntryInput = source ? {
        locator, ordinal: 0, title: source.title, authors: source.authors, year: source.publicationYear, containerTitle: source.containerTitle, publisher: source.publisher,
        canonicalUri: source.canonicalUri, kind: source.kind, doi: extractDoi(source.canonicalUri),
      } : { locator, ordinal: 0, title: locator, authors: [], year: null, containerTitle: null, publisher: null, canonicalUri: "", kind: "unknown", doi: null, unresolved: true };
      if (!source) warn(warnings, "citation-source-missing", `Citation binding "${locator}" could not be resolved to a project source.`);
      citations.set(locator, { role: "citation", locator, ordinal: binding.ordinal, entry, source });
      continue;
    }
    if (binding.role === "supplement") {
      if (binding.target.kind === "artifact") {
        const context = store.getArtifactContextForProject(projectId, binding.target.artifactId, binding.target.artifactVersion);
        const preview = store.artifactVisualCaptureForBinding(projectId, binding.target.artifactId, binding.target.artifactVersion, binding.target.captureId, binding.target.validationReceiptId);
        supplements.push({ role: "supplement", locator, ordinal: binding.ordinal, title: context?.artifact.title ?? locator, bytes: preview?.bytes ?? null, mimeType: preview ? "image/png" : null,
          provenance: { artifactId: binding.target.artifactId, artifactVersion: binding.target.artifactVersion, contentSha256: context?.selectedVersion.contentSha256 ?? "" } });
      } else if (binding.target.kind === "source-figure") {
        const source = store.sourceFigureBytesForProject(projectId, binding.target.sourceFigureId);
        supplements.push({ role: "supplement", locator, ordinal: binding.ordinal, title: locator, bytes: source?.bytes ?? null, mimeType: source?.figure.mimeType ?? null, provenance: { sourceFigureId: binding.target.sourceFigureId } });
      }
      continue;
    }
    // figure / table
    if (binding.target.kind === "source-figure") {
      const source = store.sourceFigureBytesForProject(projectId, binding.target.sourceFigureId);
      if (!source) { warn(warnings, "source-figure-missing", `Source figure for "${locator}" is not available.`); continue; }
      const provenance = { sourceFigureId: binding.target.sourceFigureId, sha256: source.figure.assetSha256, mimeType: source.figure.mimeType, sourceId: source.figure.sourceId, figureLabel: source.figure.figureLabel };
      const raster: RasterAsset = { bytes: source.bytes, mimeType: source.figure.mimeType, width: source.figure.width, height: source.figure.height, sha256: source.figure.assetSha256 };
      if (binding.role === "figure") {
        figures.set(locator, { role: "figure", locator, ordinal: binding.ordinal, title: source.figure.caption || source.figure.figureLabel || locator, raster, svg: null, provenance });
      } else {
        tables.set(locator, { role: "table", locator, ordinal: binding.ordinal, title: source.figure.figureLabel || locator, caption: null, columns: [], rows: [], notes: [], editable: false, raster, provenance });
        warn(warnings, "table-not-editable", `Table "${locator}" is bound to a source figure image; it is embedded as an image, not an editable table.`);
      }
      continue;
    }
    if (binding.target.kind !== "artifact") continue;
    const { artifactId, artifactVersion, captureId, validationReceiptId } = binding.target;
    const context = store.getArtifactContextForProject(projectId, artifactId, artifactVersion);
    if (!context) { warn(warnings, "artifact-missing", `Bound artifact for "${locator}" (v${artifactVersion}) is not available.`); continue; }
    const preview = store.artifactVisualCaptureForBinding(projectId, artifactId, artifactVersion, captureId, validationReceiptId);
    const raster: RasterAsset | null = preview ? { bytes: preview.bytes, mimeType: "image/png", width: preview.width, height: preview.height, sha256: preview.sha256 } : null;
    const provenance = { artifactId, artifactVersion, contentSha256: context.selectedVersion.contentSha256, captureId, validationReceiptId, rendererId: context.selectedVersion.rendererId, rendererVersion: context.selectedVersion.rendererVersion };
    const payload = context.selectedVersion.payload;
    if (binding.role === "figure") {
      let svg: ResolvedFigure["svg"] = null;
      if (payload.schema === SCIENCE_STATISTICS_FIGURE_VECTOR_ARTIFACT_SCHEMA) {
        const asset = store.statisticsFigureSvgAssetForBinding(projectId, artifactId, artifactVersion);
        if (asset) svg = { bytes: asset.bytes, sha256: asset.sha256 };
      } else if (payload.schema === SCIENCE_STATISTICS_FIGURE_ARTIFACT_SCHEMA) {
        // The bound artifact is the figure itself. Its journal vector export is a child artifact,
        // so reach it through the recorded parent link rather than leaving the paper on a raster.
        const asset = store.statisticsFigureSvgAssetForFigure(
          projectId, artifactId, artifactVersion, context.selectedVersion.contentSha256,
        );
        if (asset) svg = { bytes: asset.bytes, sha256: asset.sha256 };
      }
      if (!raster && !svg) warn(warnings, "figure-capture-missing", `Figure "${locator}" has no verified capture or vector export for the bound version.`);
      figures.set(locator, { role: "figure", locator, ordinal: binding.ordinal, title: context.artifact.title, raster, svg, provenance });
      continue;
    }
    // table role
    let resolved: Omit<ResolvedTable, "role" | "locator" | "ordinal" | "raster" | "provenance"> | null = null;
    if (payload.schema === SCIENCE_STATISTICS_ARTIFACT_SCHEMA) {
      const table = statisticsTable(payload, locator);
      if (table) resolved = { title: table.title, caption: table.caption, columns: table.columns, rows: table.rows, notes: table.notes, editable: true };
    } else if (payload.schema === "agentlas.science-table/v1" || context.artifact.kind === "table") {
      const table = datasetTable(payload);
      if (table) resolved = { title: context.artifact.title, caption: null, columns: table.columns, rows: table.rows, notes: [], editable: true };
      else {
        const publicationTable = domainPublicationTable(payload, context.artifact.title);
        if (publicationTable) resolved = publicationTable;
      }
    } else if (domainPublicationTableIn(payload)) {
      const table = domainPublicationTable(domainPublicationTableIn(payload)!, context.artifact.title);
      if (table) resolved = table;
    } else if (payload.schema === "agentlas.science.statistics-table/v1" && Array.isArray(payload.columns)) {
      const columns = (payload.columns as Array<Record<string, unknown>>).map((column) => ({ key: String(column.key), label: String(column.label ?? column.key), type: (column.type === "number" || column.type === "integer" || column.type === "boolean" ? column.type : "string") as ResolvedTableColumn["type"] }));
      const rows = (Array.isArray(payload.rows) ? payload.rows as Array<Record<string, TableCell>> : []).map((row) => Object.fromEntries(columns.map((column) => [column.key, normalizeCell(row[column.key])])));
      resolved = { title: String(payload.title ?? context.artifact.title), caption: typeof payload.caption === "string" ? payload.caption : null, columns, rows, notes: Array.isArray(payload.notes) ? (payload.notes as unknown[]).map(String) : [], editable: true };
    }
    if (!resolved) {
      resolved = { title: context.artifact.title, caption: null, columns: [], rows: [], notes: [], editable: false };
      if (raster) warn(warnings, "table-not-editable", `Table "${locator}" artifact (${context.artifact.kind}) carries no tabular payload; its verified capture is embedded as an image.`);
      else warn(warnings, "table-unrenderable", `Table "${locator}" artifact carries no tabular payload and no verified capture.`);
    }
    if (resolved.rows.length > 5_000) {
      warn(warnings, "table-truncated", `Table "${locator}" has ${resolved.rows.length} rows; only the first 5,000 are embedded in the manuscript. The full table is exported as CSV.`);
    }
    tables.set(locator, { role: "table", locator, ordinal: binding.ordinal, raster, provenance, ...resolved });
  }
  return { figures, tables, citations, supplements, warnings };
}

export function tableToCsv(table: ResolvedTable): string {
  const escape = (value: TableCell) => {
    if (value === null) return "";
    const text = typeof value === "string" ? value : String(value);
    const neutral = /^[=+\-@\t\r]/.test(text) ? `\t${text}` : text;
    return /[",\n\r\t]/.test(neutral) ? `"${neutral.replace(/"/g, "\"\"")}"` : neutral;
  };
  const header = table.columns.map((column) => escape(column.label)).join(",");
  const rows = table.rows.map((row) => table.columns.map((column) => escape(row[column.key] ?? null)).join(","));
  return `${[header, ...rows].join("\r\n")}\r\n`;
}
