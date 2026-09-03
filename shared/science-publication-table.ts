import { createHash } from "node:crypto";
import { escapeLatex as latex } from "./science-latex-text";
import { strToU8, unzipSync, zipSync } from "fflate";
import type {
  ScienceArtifactContext,
  ScienceDatasetCell,
  ScienceDatasetTablePayload,
  ScienceResearchRun,
  ScienceResearchRunResource,
  ScienceRunArtifactBinding,
} from "./science-contract";
import { SCIENCE_TABLE_RENDERER_ID, SCIENCE_TABLE_SCHEMA, scienceTableSha256, validateScienceTablePayload } from "./science-table";

export const SCIENCE_PUBLICATION_EDITABLE_TABLE_SCHEMA = "agentlas.science.publication-editable-table/v1" as const;
export const SCIENCE_PUBLICATION_EDITABLE_TABLE_DOCUMENT_SCHEMA = "agentlas.science.publication-editable-table-document/v1" as const;
export const SCIENCE_PUBLICATION_EDITABLE_TABLE_LIMITS = {
  maxColumns: 64,
  maxRows: 1_000,
  maxCells: 20_000,
  maxNotes: 32,
  maxDocxBytes: 16 * 1024 * 1024,
} as const;

const SHA256_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  const item = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(item).sort().flatMap((key) => item[key] === undefined ? [] : [[key, canonicalValue(item[key])]]));
}

export function sciencePublicationTableSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex");
}

function safeText(value: unknown, maximum: number, code: string, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || CONTROL_RE.test(value) || (!allowEmpty && !value.trim())) throw new Error(code);
  return allowEmpty ? value : value.trim();
}

function safeSha256(value: unknown, code: string): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) throw new Error(code);
  return value;
}

function safeUuid(value: unknown, code: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new Error(code);
  return value;
}

function manifestResource(resource: ScienceResearchRunResource): Record<string, unknown> {
  const core: Record<string, unknown> = {
    role: resource.role,
    mimeType: resource.mimeType,
    byteSize: resource.byteSize,
    sha256: resource.sha256,
    blobRef: resource.blobRef,
  };
  if (resource.artifactId !== null) core.artifactId = resource.artifactId;
  if (resource.artifactVersion !== null) core.artifactVersion = resource.artifactVersion;
  return core;
}

function manifestResourceWithNulls(resource: ScienceResearchRunResource): Record<string, unknown> {
  return { ...manifestResource(resource), artifactId: resource.artifactId, artifactVersion: resource.artifactVersion };
}

function storedManifestMatches(resources: ScienceResearchRunResource[], expectedSha256: string): boolean {
  return sciencePublicationTableSha256(resources.map(manifestResource)) === expectedSha256
    || sciencePublicationTableSha256(resources.map(manifestResourceWithNulls)) === expectedSha256;
}

function cellText(value: ScienceDatasetCell, nullDisplay: string): string {
  if (value === null) return nullDisplay;
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
}



export interface SciencePublicationEditableTableSelectionInput {
  title: string;
  caption: string;
  notes?: string[];
  columns: string[];
  rowIndices: number[];
  nullDisplay?: string;
}

export interface SciencePublicationEditableTableColumnBinding {
  sourceOrdinal: number;
  name: string;
  logicalType: "integer" | "number" | "boolean" | "string";
  nullable: boolean;
}

export interface SciencePublicationEditableTableBinding {
  schema: typeof SCIENCE_PUBLICATION_EDITABLE_TABLE_SCHEMA;
  projectId: string;
  artifact: {
    id: string;
    versionId: string;
    version: number;
    contentSha256: string;
    linkageSha256: string;
    rendererId: string;
    rendererVersion: string;
  };
  dataset: {
    schema: typeof SCIENCE_TABLE_SCHEMA;
    rawSha256: string;
    headerSha256: string;
    rowsSha256: string;
    tableSha256: string;
  };
  run: {
    id: string;
    toolId: string;
    toolVersion: string;
    inputManifestSha256: string;
    outputManifestSha256: string;
    environmentSha256: string;
    outputId: string;
    outputSha256: string;
  };
  selection: {
    title: string;
    caption: string;
    notes: string[];
    nullDisplay: string;
    columns: SciencePublicationEditableTableColumnBinding[];
    rowIndices: number[];
    rowCount: number;
    columnCount: number;
    cellCount: number;
    cellSchemaSha256: string;
    selectedRowsSha256: string;
    selectionSha256: string;
  };
  bindingSha256: string;
}

export interface SciencePublicationEditableTableDocument {
  schema: typeof SCIENCE_PUBLICATION_EDITABLE_TABLE_DOCUMENT_SCHEMA;
  bindingSha256: string;
  title: string;
  caption: string;
  notes: string[];
  nullDisplay: string;
  columns: SciencePublicationEditableTableColumnBinding[];
  rows: Array<{ sourceRowIndex: number; cells: Record<string, ScienceDatasetCell> }>;
}

export interface SciencePublicationEditableTableExport {
  schema: typeof SCIENCE_PUBLICATION_EDITABLE_TABLE_SCHEMA;
  binding: SciencePublicationEditableTableBinding;
  document: SciencePublicationEditableTableDocument;
  assets: {
    docx: { fileName: string; mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"; byteSize: number; sha256: string; bytes: Uint8Array };
    tex: { fileName: string; mimeType: "application/x-tex"; byteSize: number; sha256: string; text: string };
    json: { fileName: string; mimeType: "application/json"; byteSize: number; sha256: string; text: string };
  };
  manifestSha256: string;
}

export interface BuildSciencePublicationEditableTableInput {
  context: ScienceArtifactContext;
  run: ScienceResearchRun;
  runArtifactBinding: ScienceRunArtifactBinding;
  selection: SciencePublicationEditableTableSelectionInput;
}

export interface BuildSciencePublicationEditableDomainTableInput {
  context: ScienceArtifactContext;
  run: ScienceResearchRun;
  runArtifactBinding: ScienceRunArtifactBinding;
  selection: Omit<SciencePublicationEditableTableSelectionInput, "columns" | "rowIndices">;
}

interface SciencePublicationTableData {
  columns: ScienceDatasetTablePayload["columns"];
  rows: ScienceDatasetTablePayload["rows"];
}

function selectionDocument(table: SciencePublicationTableData, selection: SciencePublicationEditableTableSelectionInput): {
  document: Omit<SciencePublicationEditableTableDocument, "bindingSha256">;
  selection: Omit<SciencePublicationEditableTableBinding["selection"], "selectionSha256">;
} {
  const title = safeText(selection.title, 500, "science-publication-table-title-invalid");
  const caption = safeText(selection.caption, 4_000, "science-publication-table-caption-invalid");
  const notes = Array.isArray(selection.notes) ? selection.notes.map((note) => safeText(note, 2_000, "science-publication-table-note-invalid")) : [];
  if (notes.length > SCIENCE_PUBLICATION_EDITABLE_TABLE_LIMITS.maxNotes) throw new Error("science-publication-table-notes-limit");
  const nullDisplay = selection.nullDisplay === undefined ? "—" : safeText(selection.nullDisplay, 40, "science-publication-table-null-display-invalid", true);
  if (!Array.isArray(selection.columns) || selection.columns.length < 1 || selection.columns.length > SCIENCE_PUBLICATION_EDITABLE_TABLE_LIMITS.maxColumns
    || new Set(selection.columns).size !== selection.columns.length) throw new Error("science-publication-table-column-selection-invalid");
  const columns = selection.columns.map((name) => {
    const sourceOrdinal = table.columns.findIndex((column) => column.name === name);
    if (sourceOrdinal < 0) throw new Error("science-publication-table-column-selection-invalid");
    return { sourceOrdinal, ...table.columns[sourceOrdinal] };
  });
  if (!Array.isArray(selection.rowIndices) || selection.rowIndices.length < 1 || selection.rowIndices.length > SCIENCE_PUBLICATION_EDITABLE_TABLE_LIMITS.maxRows
    || selection.rowIndices.some((index, ordinal) => !Number.isSafeInteger(index) || index < 0 || index >= table.rows.length || (ordinal > 0 && index <= selection.rowIndices[ordinal - 1]))) {
    throw new Error("science-publication-table-row-selection-invalid");
  }
  const cellCount = columns.length * selection.rowIndices.length;
  if (cellCount > SCIENCE_PUBLICATION_EDITABLE_TABLE_LIMITS.maxCells) throw new Error("science-publication-table-cell-limit");
  const rows = selection.rowIndices.map((sourceRowIndex) => ({
    sourceRowIndex,
    cells: Object.fromEntries(columns.map((column) => [column.name, table.rows[sourceRowIndex][column.name]])) as Record<string, ScienceDatasetCell>,
  }));
  const cellSchemaSha256 = sciencePublicationTableSha256(columns);
  const selectedRowsSha256 = sciencePublicationTableSha256(rows);
  const selected = {
    title, caption, notes, nullDisplay, columns, rowIndices: [...selection.rowIndices],
    rowCount: rows.length, columnCount: columns.length, cellCount, cellSchemaSha256, selectedRowsSha256,
  };
  return {
    document: { schema: SCIENCE_PUBLICATION_EDITABLE_TABLE_DOCUMENT_SCHEMA, title, caption, notes, nullDisplay, columns, rows },
    selection: selected,
  };
}

function domainPublicationTableProjection(value: unknown): {
  sourceSha256: string;
  table: SciencePublicationTableData;
  notes: string[];
} {
  const source = record(value);
  if (!source || source.schema !== SCIENCE_TABLE_SCHEMA || !Array.isArray(source.columns) || !Array.isArray(source.rows)
    || source.columns.length < 1 || source.columns.length > SCIENCE_PUBLICATION_EDITABLE_TABLE_LIMITS.maxColumns
    || source.rows.length < 1 || source.rows.length > SCIENCE_PUBLICATION_EDITABLE_TABLE_LIMITS.maxRows
    || source.columns.length * source.rows.length > SCIENCE_PUBLICATION_EDITABLE_TABLE_LIMITS.maxCells) {
    throw new Error("science-publication-domain-table-invalid");
  }
  const declared = source.columns.map((entry, ordinal) => {
    const column = record(entry);
    if (!column) throw new Error("science-publication-domain-table-column-invalid");
    const id = safeText(typeof column.id === "string" ? column.id : column.key, 240, "science-publication-domain-table-column-invalid");
    const label = safeText(typeof column.label === "string" ? column.label : id, 240, "science-publication-domain-table-column-invalid");
    const unit = column.unit === null || column.unit === undefined || column.unit === "" ? null
      : safeText(column.unit, 120, "science-publication-domain-table-column-invalid");
    const declaredType = String(column.type ?? column.datatype ?? "string").toLowerCase();
    const logicalType: ScienceDatasetTablePayload["columns"][number]["logicalType"] = declaredType === "integer" ? "integer"
      : declaredType === "number" ? "number" : declaredType === "boolean" ? "boolean" : "string";
    return { id, ordinal, baseName: `${label}${unit ? ` (${unit})` : ""}`, logicalType };
  });
  if (new Set(declared.map((column) => column.id.toLocaleLowerCase("en-US"))).size !== declared.length) {
    throw new Error("science-publication-domain-table-column-duplicate");
  }
  const baseNameCounts = new Map<string, number>();
  const columns = declared.map((column) => {
    const key = column.baseName.toLocaleLowerCase("en-US");
    const count = (baseNameCounts.get(key) ?? 0) + 1;
    baseNameCounts.set(key, count);
    const name = count === 1 ? column.baseName : `${column.baseName} [${column.id}]`;
    return { name, logicalType: column.logicalType, nullable: false };
  });
  const rows = source.rows.map((entry) => {
    if (!Array.isArray(entry) && !record(entry)) throw new Error("science-publication-domain-table-row-invalid");
    if (Array.isArray(entry) && entry.length !== declared.length) throw new Error("science-publication-domain-table-row-invalid");
    const rowRecord = record(entry);
    const normalized: Record<string, ScienceDatasetCell> = {};
    declared.forEach((column, ordinal) => {
      const cell = Array.isArray(entry) ? entry[ordinal] : rowRecord![column.id];
      if (cell === null || cell === undefined) {
        columns[ordinal].nullable = true;
        normalized[columns[ordinal].name] = null;
        return;
      }
      if (column.logicalType === "integer" && (typeof cell !== "number" || !Number.isSafeInteger(cell))) {
        throw new Error("science-publication-domain-table-cell-invalid");
      }
      if (column.logicalType === "number" && (typeof cell !== "number" || !Number.isFinite(cell))) {
        throw new Error("science-publication-domain-table-cell-invalid");
      }
      if (column.logicalType === "boolean" && typeof cell !== "boolean") {
        throw new Error("science-publication-domain-table-cell-invalid");
      }
      if (column.logicalType === "string" && (typeof cell !== "string" || CONTROL_RE.test(cell) || Buffer.byteLength(cell, "utf8") > 16 * 1024)) {
        throw new Error("science-publication-domain-table-cell-invalid");
      }
      normalized[columns[ordinal].name] = cell as ScienceDatasetCell;
    });
    return normalized;
  });
  const notes = Array.isArray(source.notes)
    ? source.notes.map((note) => safeText(note, 2_000, "science-publication-domain-table-note-invalid"))
    : [];
  if (notes.length > SCIENCE_PUBLICATION_EDITABLE_TABLE_LIMITS.maxNotes) throw new Error("science-publication-table-notes-limit");
  return { sourceSha256: sciencePublicationTableSha256(source), table: { columns, rows }, notes };
}

function bindingCore(input: BuildSciencePublicationEditableTableInput): { binding: SciencePublicationEditableTableBinding; document: SciencePublicationEditableTableDocument } {
  const { context, run, runArtifactBinding } = input;
  const projectId = safeUuid(context?.artifact?.projectId, "science-publication-table-project-invalid");
  const artifactId = safeUuid(context?.artifact?.id, "science-publication-table-artifact-invalid");
  const artifactVersion = context?.selectedVersion?.version;
  if (context.artifact.status !== "ready" || context.artifact.kind !== "table" || !Number.isSafeInteger(artifactVersion) || artifactVersion < 1
    || context.selectedVersion.artifactId !== artifactId || context.selectedVersion.rendererId !== SCIENCE_TABLE_RENDERER_ID
    || context.linkage.schema !== "agentlas.science-artifact-linkage/v1" || context.linkage.projectId !== projectId
    || context.linkage.artifactId !== artifactId || context.linkage.artifactVersion !== artifactVersion || context.linkage.rendererId !== SCIENCE_TABLE_RENDERER_ID) {
    throw new Error("science-publication-table-artifact-invalid");
  }
  const artifactContentSha256 = safeSha256(context.selectedVersion.contentSha256, "science-publication-table-artifact-hash-invalid");
  const table = validateScienceTablePayload(context.selectedVersion.payload);
  const runId = safeUuid(run?.id, "science-publication-table-run-invalid");
  if (run.projectId !== projectId || run.status !== "succeeded" || !run.finishedAt || context.artifact.sourceRunId !== runId
    || context.selectedVersion.provenance.sourceRunId !== runId || context.linkage.origin.runId !== runId
    || context.selectedVersion.provenance.environmentSha256 !== run.environmentSha256 || !run.outputManifestSha256) {
    throw new Error("science-publication-table-run-invalid");
  }
  const inputManifestSha256 = safeSha256(run.inputManifestSha256, "science-publication-table-run-input-hash-invalid");
  const outputManifestSha256 = safeSha256(run.outputManifestSha256, "science-publication-table-run-output-hash-invalid");
  const environmentSha256 = safeSha256(run.environmentSha256, "science-publication-table-run-environment-hash-invalid");
  if (!storedManifestMatches(run.inputs, inputManifestSha256)
    || !storedManifestMatches(run.outputs, outputManifestSha256)) throw new Error("science-publication-table-run-manifest-invalid");
  if (runArtifactBinding.projectId !== projectId || runArtifactBinding.runId !== runId || runArtifactBinding.artifactId !== artifactId
    || runArtifactBinding.artifactVersion !== artifactVersion || runArtifactBinding.artifactContentSha256 !== artifactContentSha256) {
    throw new Error("science-publication-table-run-artifact-binding-invalid");
  }
  const output = run.outputs.find((item) => item.id === runArtifactBinding.outputId);
  if (!output || output.sha256 !== runArtifactBinding.outputSha256 || output.role !== "normalized-table"
    || output.mimeType !== "application/vnd.agentlas.science.table+json") throw new Error("science-publication-table-run-output-invalid");
  if (context.selectedVersion.provenance.datasetSha256.length !== 1
    || context.selectedVersion.provenance.datasetSha256[0] !== table.receipts.rawSha256) throw new Error("science-publication-table-dataset-binding-invalid");
  const { document: documentWithoutBinding, selection } = selectionDocument(table, input.selection);
  const selectionSha256 = sciencePublicationTableSha256(selection);
  const core = {
    schema: SCIENCE_PUBLICATION_EDITABLE_TABLE_SCHEMA,
    projectId,
    artifact: {
      id: artifactId,
      versionId: safeUuid(context.selectedVersion.id, "science-publication-table-artifact-version-id-invalid"),
      version: artifactVersion,
      contentSha256: artifactContentSha256,
      linkageSha256: safeSha256(context.linkage.linkageSha256, "science-publication-table-linkage-hash-invalid"),
      rendererId: SCIENCE_TABLE_RENDERER_ID,
      rendererVersion: safeText(context.selectedVersion.rendererVersion, 120, "science-publication-table-renderer-version-invalid"),
    },
    dataset: {
      schema: SCIENCE_TABLE_SCHEMA,
      rawSha256: table.receipts.rawSha256,
      headerSha256: table.receipts.headerSha256,
      rowsSha256: table.receipts.rowsSha256,
      tableSha256: table.receipts.tableSha256,
    },
    run: {
      id: runId,
      toolId: safeText(run.toolId, 240, "science-publication-table-run-tool-invalid"),
      toolVersion: safeText(run.toolVersion, 120, "science-publication-table-run-tool-version-invalid"),
      inputManifestSha256,
      outputManifestSha256,
      environmentSha256,
      outputId: safeUuid(output.id, "science-publication-table-run-output-id-invalid"),
      outputSha256: safeSha256(output.sha256, "science-publication-table-run-output-hash-invalid"),
    },
    selection: { ...selection, selectionSha256 },
  };
  const bindingSha256 = sciencePublicationTableSha256(core);
  return {
    binding: { ...core, bindingSha256 },
    document: { ...documentWithoutBinding, bindingSha256 },
  };
}

function domainBindingCore(input: BuildSciencePublicationEditableDomainTableInput): { binding: SciencePublicationEditableTableBinding; document: SciencePublicationEditableTableDocument } {
  const { context, run, runArtifactBinding } = input;
  const projectId = safeUuid(context?.artifact?.projectId, "science-publication-domain-table-project-invalid");
  const artifactId = safeUuid(context?.artifact?.id, "science-publication-domain-table-artifact-invalid");
  const artifactVersion = context?.selectedVersion?.version;
  if (context.artifact.status !== "ready" || context.artifact.kind !== "chart.vega" || !Number.isSafeInteger(artifactVersion) || artifactVersion < 1
    || context.selectedVersion.artifactId !== artifactId || context.selectedVersion.rendererId !== "agentlas.vega"
    || context.linkage.schema !== "agentlas.science-artifact-linkage/v1" || context.linkage.projectId !== projectId
    || context.linkage.artifactId !== artifactId || context.linkage.artifactVersion !== artifactVersion || context.linkage.rendererId !== "agentlas.vega") {
    throw new Error("science-publication-domain-table-artifact-invalid");
  }
  const artifactContentSha256 = safeSha256(context.selectedVersion.contentSha256, "science-publication-domain-table-artifact-hash-invalid");
  const payload = record(context.selectedVersion.payload);
  const analysis = record(payload?.analysis);
  const projection = domainPublicationTableProjection(analysis?.publicationTable);
  const receipt = record(record(analysis?.contentReceipts)?.publicationTable);
  if (!receipt || safeSha256(receipt.sha256, "science-publication-domain-table-receipt-invalid") !== projection.sourceSha256
    || !context.selectedVersion.provenance.datasetSha256.includes(projection.sourceSha256)) {
    throw new Error("science-publication-domain-table-receipt-invalid");
  }
  const runId = safeUuid(run?.id, "science-publication-domain-table-run-invalid");
  if (run.projectId !== projectId || run.status !== "succeeded" || !run.finishedAt || context.artifact.sourceRunId !== runId
    || context.selectedVersion.provenance.sourceRunId !== runId || context.linkage.origin.runId !== runId
    || context.selectedVersion.provenance.environmentSha256 !== run.environmentSha256 || !run.outputManifestSha256) {
    throw new Error("science-publication-domain-table-run-invalid");
  }
  const inputManifestSha256 = safeSha256(run.inputManifestSha256, "science-publication-domain-table-run-input-hash-invalid");
  const outputManifestSha256 = safeSha256(run.outputManifestSha256, "science-publication-domain-table-run-output-hash-invalid");
  const environmentSha256 = safeSha256(run.environmentSha256, "science-publication-domain-table-run-environment-hash-invalid");
  if (!storedManifestMatches(run.inputs, inputManifestSha256) || !storedManifestMatches(run.outputs, outputManifestSha256)) {
    throw new Error("science-publication-domain-table-run-manifest-invalid");
  }
  if (runArtifactBinding.projectId !== projectId || runArtifactBinding.runId !== runId || runArtifactBinding.artifactId !== artifactId
    || runArtifactBinding.artifactVersion !== artifactVersion || runArtifactBinding.artifactContentSha256 !== artifactContentSha256) {
    throw new Error("science-publication-domain-table-run-artifact-binding-invalid");
  }
  const output = run.outputs.find((item) => item.id === runArtifactBinding.outputId);
  if (!output || output.sha256 !== runArtifactBinding.outputSha256 || !/analysis/u.test(output.role)
    || !/^application\/(?:vnd\.agentlas\.)?.*json$/u.test(output.mimeType)) throw new Error("science-publication-domain-table-run-output-invalid");
  const selectionInput: SciencePublicationEditableTableSelectionInput = {
    ...input.selection,
    notes: input.selection.notes ?? projection.notes,
    columns: projection.table.columns.map((column) => column.name),
    rowIndices: projection.table.rows.map((_row, index) => index),
  };
  const { document: documentWithoutBinding, selection } = selectionDocument(projection.table, selectionInput);
  const selectionSha256 = sciencePublicationTableSha256(selection);
  const normalizedTableSha256 = sciencePublicationTableSha256({ schema: SCIENCE_TABLE_SCHEMA, columns: projection.table.columns, rows: projection.table.rows });
  const core = {
    schema: SCIENCE_PUBLICATION_EDITABLE_TABLE_SCHEMA,
    projectId,
    artifact: {
      id: artifactId,
      versionId: safeUuid(context.selectedVersion.id, "science-publication-domain-table-artifact-version-id-invalid"),
      version: artifactVersion,
      contentSha256: artifactContentSha256,
      linkageSha256: safeSha256(context.linkage.linkageSha256, "science-publication-domain-table-linkage-hash-invalid"),
      rendererId: context.selectedVersion.rendererId,
      rendererVersion: safeText(context.selectedVersion.rendererVersion, 120, "science-publication-domain-table-renderer-version-invalid"),
    },
    dataset: {
      schema: SCIENCE_TABLE_SCHEMA,
      rawSha256: projection.sourceSha256,
      headerSha256: sciencePublicationTableSha256(projection.table.columns.map((column) => column.name)),
      rowsSha256: sciencePublicationTableSha256(projection.table.rows),
      tableSha256: normalizedTableSha256,
    },
    run: {
      id: runId,
      toolId: safeText(run.toolId, 240, "science-publication-domain-table-run-tool-invalid"),
      toolVersion: safeText(run.toolVersion, 120, "science-publication-domain-table-run-tool-version-invalid"),
      inputManifestSha256,
      outputManifestSha256,
      environmentSha256,
      outputId: safeUuid(output.id, "science-publication-domain-table-run-output-id-invalid"),
      outputSha256: safeSha256(output.sha256, "science-publication-domain-table-run-output-hash-invalid"),
    },
    selection: { ...selection, selectionSha256 },
  };
  const bindingSha256 = sciencePublicationTableSha256(core);
  return {
    binding: { ...core, bindingSha256 },
    document: { ...documentWithoutBinding, bindingSha256 },
  };
}

function documentXml(document: SciencePublicationEditableTableDocument): string {
  const cell = (value: string, bold = false) => `<w:tc><w:tcPr><w:tcMar><w:top w:w="80" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tcMar></w:tcPr><w:p><w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${xml(value)}</w:t></w:r></w:p></w:tc>`;
  const header = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${document.columns.map((column) => cell(column.name, true)).join("")}</w:tr>`;
  const rows = document.rows.map((row) => `<w:tr>${document.columns.map((column) => cell(cellText(row.cells[column.name], document.nullDisplay))).join("")}</w:tr>`).join("");
  const notes = document.notes.map((note) => `<w:p><w:r><w:t xml:space="preserve">${xml(note)}</w:t></w:r></w:p>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t xml:space="preserve">${xml(document.title)}</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">${xml(document.caption)}</w:t></w:r></w:p><w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>${header}${rows}</w:tbl>${notes}<w:sectPr><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
}

function docxBytes(xmlDocument: string): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/document.xml": strToU8(xmlDocument),
  }, { level: 6, mtime: new Date("2000-01-01T00:00:00Z") });
}

function latexText(document: SciencePublicationEditableTableDocument): string {
  const alignment = document.columns.map((column) => column.logicalType === "number" || column.logicalType === "integer" ? "r" : column.logicalType === "boolean" ? "c" : "l").join("");
  const header = `${document.columns.map((column) => latex(column.name)).join(" & ")} \\\\`;
  const rows = document.rows.map((row) => `${document.columns.map((column) => latex(cellText(row.cells[column.name], document.nullDisplay))).join(" & ")} \\\\`).join("\n");
  const notes = document.notes.length ? `\n\\par\\small ${document.notes.map(latex).join("; ")}` : "";
  return `\\begin{table}[htbp]\n\\centering\n\\caption{${latex(document.caption)}}\n\\begin{tabular}{${alignment}}\n\\toprule\n${header}\n\\midrule\n${rows}\n\\bottomrule\n\\end{tabular}${notes}\n\\end{table}\n`;
}

function assembleExport(binding: SciencePublicationEditableTableBinding, document: SciencePublicationEditableTableDocument): SciencePublicationEditableTableExport {
  const xmlDocument = documentXml(document);
  const docx = docxBytes(xmlDocument);
  if (docx.byteLength > SCIENCE_PUBLICATION_EDITABLE_TABLE_LIMITS.maxDocxBytes) throw new Error("science-publication-table-docx-size-limit");
  const tex = latexText(document);
  const json = `${JSON.stringify(canonicalValue(document), null, 2)}\n`;
  const assets = {
    docx: { fileName: "editable-table.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const, byteSize: docx.byteLength, sha256: sciencePublicationTableSha256Bytes(docx), bytes: docx },
    tex: { fileName: "editable-table.tex", mimeType: "application/x-tex" as const, byteSize: Buffer.byteLength(tex, "utf8"), sha256: sciencePublicationTableSha256Bytes(Buffer.from(tex, "utf8")), text: tex },
    json: { fileName: "editable-table.json", mimeType: "application/json" as const, byteSize: Buffer.byteLength(json, "utf8"), sha256: sciencePublicationTableSha256Bytes(Buffer.from(json, "utf8")), text: json },
  };
  const manifestSha256 = sciencePublicationTableSha256({
    schema: SCIENCE_PUBLICATION_EDITABLE_TABLE_SCHEMA,
    bindingSha256: binding.bindingSha256,
    documentSha256: sciencePublicationTableSha256(document),
    assets: Object.fromEntries(Object.entries(assets).map(([key, asset]) => [key, { fileName: asset.fileName, mimeType: asset.mimeType, byteSize: asset.byteSize, sha256: asset.sha256 }])),
  });
  return { schema: SCIENCE_PUBLICATION_EDITABLE_TABLE_SCHEMA, binding, document, assets, manifestSha256 };
}

function sciencePublicationTableSha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function buildSciencePublicationEditableTable(input: BuildSciencePublicationEditableTableInput): SciencePublicationEditableTableExport {
  const { binding, document } = bindingCore(input);
  return assembleExport(binding, document);
}

export function buildSciencePublicationEditableDomainTable(input: BuildSciencePublicationEditableDomainTableInput): SciencePublicationEditableTableExport {
  const { binding, document } = domainBindingCore(input);
  return assembleExport(binding, document);
}

export function verifySciencePublicationEditableTable(value: SciencePublicationEditableTableExport): SciencePublicationEditableTableExport {
  const candidate = record(value);
  if (!candidate || !exactKeys(candidate, ["schema", "binding", "document", "assets", "manifestSha256"])
    || candidate.schema !== SCIENCE_PUBLICATION_EDITABLE_TABLE_SCHEMA) throw new Error("science-publication-table-export-invalid");
  const binding = value.binding;
  const document = value.document;
  const bindingRecord = record(binding);
  const documentRecord = record(document);
  if (!bindingRecord || !documentRecord || binding.schema !== SCIENCE_PUBLICATION_EDITABLE_TABLE_SCHEMA
    || document.schema !== SCIENCE_PUBLICATION_EDITABLE_TABLE_DOCUMENT_SCHEMA || document.bindingSha256 !== binding.bindingSha256
    || !SHA256_RE.test(binding.bindingSha256) || !SHA256_RE.test(value.manifestSha256)) throw new Error("science-publication-table-export-invalid");
  const { bindingSha256, ...unsignedBinding } = binding;
  if (sciencePublicationTableSha256(unsignedBinding) !== bindingSha256) throw new Error("science-publication-table-binding-hash-invalid");
  if (sciencePublicationTableSha256(document.columns) !== binding.selection.cellSchemaSha256
    || sciencePublicationTableSha256(document.rows) !== binding.selection.selectedRowsSha256
    || document.title !== binding.selection.title || document.caption !== binding.selection.caption || document.nullDisplay !== binding.selection.nullDisplay
    || sciencePublicationTableSha256(document.notes) !== sciencePublicationTableSha256(binding.selection.notes)
    || document.rows.length !== binding.selection.rowCount || document.columns.length !== binding.selection.columnCount
    || document.rows.length * document.columns.length !== binding.selection.cellCount
    || sciencePublicationTableSha256({ ...binding.selection, selectionSha256: undefined }) !== binding.selection.selectionSha256) {
    throw new Error("science-publication-table-document-binding-invalid");
  }
  if (document.rows.some((row, index) => row.sourceRowIndex !== binding.selection.rowIndices[index])) throw new Error("science-publication-table-document-binding-invalid");
  const expected = assembleExport(binding, document);
  if (expected.manifestSha256 !== value.manifestSha256
    || expected.assets.docx.sha256 !== value.assets.docx.sha256 || expected.assets.docx.byteSize !== value.assets.docx.byteSize
    || expected.assets.tex.sha256 !== value.assets.tex.sha256 || expected.assets.tex.text !== value.assets.tex.text
    || expected.assets.json.sha256 !== value.assets.json.sha256 || expected.assets.json.text !== value.assets.json.text
    || Buffer.compare(Buffer.from(expected.assets.docx.bytes), Buffer.from(value.assets.docx.bytes)) !== 0) throw new Error("science-publication-table-asset-integrity-invalid");
  const files = unzipSync(value.assets.docx.bytes);
  if (!files["word/document.xml"] || Buffer.from(files["word/document.xml"]).toString("utf8") !== documentXml(document)) throw new Error("science-publication-table-docx-integrity-invalid");
  return expected;
}
