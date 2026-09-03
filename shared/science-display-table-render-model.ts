import type { ScienceDatasetCell } from "./science-contract";
import {
  SCIENCE_PUBLICATION_EDITABLE_TABLE_DOCUMENT_SCHEMA,
  sciencePublicationTableSha256,
  verifySciencePublicationEditableTable,
  type SciencePublicationEditableTableColumnBinding,
  type SciencePublicationEditableTableDocument,
  type SciencePublicationEditableTableExport,
} from "./science-publication-table";
import {
  validateScienceDisplayTablePresentationV1,
  type ScienceDisplayTableCellRole,
  type ScienceDisplayTableLayout,
  type ScienceDisplayTableNote,
  type ScienceDisplayTableNumbering,
  type ScienceDisplayTablePresentationV1,
  type ScienceDisplayTableProvenanceReference,
  type ScienceDisplayTableStatisticalDisclosure,
} from "./science-display-table-presentation";

export const SCIENCE_DISPLAY_TABLE_RENDER_MODEL_SCHEMA = "agentlas.science.display-table-render-model/v1" as const;

const SHA256_RE = /^[a-f0-9]{64}$/u;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export type ScienceDisplayTableHeaderGridCellKind = "group" | "empty";

export interface ScienceDisplayTableHeaderGridCell {
  readonly kind: ScienceDisplayTableHeaderGridCellKind;
  readonly groupId: string | null;
  readonly label: string | null;
  readonly startColumnIndex: number;
  readonly endColumnIndex: number;
  readonly columnSpan: number;
}

export interface ScienceDisplayTableHeaderGridBand {
  readonly level: number;
  readonly cells: readonly ScienceDisplayTableHeaderGridCell[];
}

export interface ScienceDisplayTableLeafColumn {
  readonly columnIndex: number;
  readonly sourceOrdinal: number;
  readonly name: string;
  readonly logicalType: SciencePublicationEditableTableColumnBinding["logicalType"];
  readonly nullable: boolean;
}

export interface ScienceDisplayTableColumnGroupGrid {
  readonly depth: number;
  /** Highest presentation level first; each band covers every leaf column exactly once. */
  readonly bands: readonly ScienceDisplayTableHeaderGridBand[];
  readonly leafColumns: readonly ScienceDisplayTableLeafColumn[];
}

export interface ScienceDisplayTablePanelStart {
  readonly panelId: string;
  readonly label: string;
  readonly startRowIndex: number;
  readonly endRowIndex: number;
  readonly sourceRowIndex: number;
}

export type ScienceDisplayTableSemanticLineKind =
  | "label"
  | "title"
  | "caption"
  | "legend"
  | "column-group"
  | "column-header"
  | "panel"
  | "data-row"
  | "source-note"
  | "general-note"
  | "specific-note"
  | "probability-note"
  | "statistics-estimator"
  | "statistics-uncertainty"
  | "statistics-sample"
  | "statistics-test"
  | "statistics-repeats"
  | "statistics-error-bars"
  | "provenance";

export interface ScienceDisplayTableSemanticLine {
  readonly ordinal: number;
  readonly kind: ScienceDisplayTableSemanticLineKind;
  readonly text: string;
}

export interface ScienceDisplayTableRenderModelSource {
  readonly bindingSha256: string;
  readonly exportManifestSha256: string;
  readonly presentationSha256: string;
  readonly documentSha256: string;
  readonly rowCount: number;
  readonly columnCount: number;
}

export interface ScienceDisplayTableRenderModelV1 {
  readonly schema: typeof SCIENCE_DISPLAY_TABLE_RENDER_MODEL_SCHEMA;
  readonly source: ScienceDisplayTableRenderModelSource;
  /** Immutable validated inputs retained so read-time validation can rebuild every derived field. */
  readonly presentation: ScienceDisplayTablePresentationV1;
  readonly document: SciencePublicationEditableTableDocument;
  readonly label: string;
  readonly title: string;
  readonly caption: string;
  readonly legend: string;
  readonly numbering: ScienceDisplayTableNumbering;
  readonly layout: ScienceDisplayTableLayout;
  readonly columnGroupGrid: ScienceDisplayTableColumnGroupGrid;
  readonly panelStarts: readonly ScienceDisplayTablePanelStart[];
  /** Rectangular grid aligned to document rows and columns; every cell has one final role. */
  readonly cellRoleGrid: readonly (readonly ScienceDisplayTableCellRole[])[];
  readonly sourceNotes: readonly string[];
  readonly notes: readonly ScienceDisplayTableNote[];
  readonly statistics: ScienceDisplayTableStatisticalDisclosure;
  readonly provenanceRefs: readonly ScienceDisplayTableProvenanceReference[];
  /** Complete reader-visible order, including headers, panels, data rows, notes, disclosures, and provenance. */
  readonly semanticLines: readonly ScienceDisplayTableSemanticLine[];
  readonly displaySemanticSha256: string;
}

export interface BuildScienceDisplayTableRenderModelV1Input {
  readonly presentation: ScienceDisplayTablePresentationV1;
  readonly tableExport: SciencePublicationEditableTableExport;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(code);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], code: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(code);
}

function text(value: unknown, maximum: number, code: string, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || CONTROL_RE.test(value) || (!allowEmpty && !value.trim())) throw new Error(code);
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(code);
  return Number(value);
}

function hash(value: unknown, code: string): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) throw new Error(code);
  return value;
}

function clonePlain<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => clonePlain(item)) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, clonePlain(item)])) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as Record<string, unknown>).forEach((item) => deepFreeze(item));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (!item || typeof item !== "object") return item;
    const valueRecord = item as Record<string, unknown>;
    return Object.fromEntries(Object.keys(valueRecord).sort().flatMap((key) => (
      valueRecord[key] === undefined ? [] : [[key, canonical(valueRecord[key])]]
    )));
  };
  return JSON.stringify(canonical(value));
}

export function scienceDisplayTableRenderModelSha256(value: unknown): string {
  return sciencePublicationTableSha256(value);
}

function validateCell(
  value: unknown,
  column: SciencePublicationEditableTableColumnBinding,
): ScienceDatasetCell {
  if (value === null) {
    if (!column.nullable) throw new Error("science-display-table-render-model-document-cell-invalid");
    return null;
  }
  if (column.logicalType === "integer" && (typeof value !== "number" || !Number.isSafeInteger(value))) {
    throw new Error("science-display-table-render-model-document-cell-invalid");
  }
  if (column.logicalType === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error("science-display-table-render-model-document-cell-invalid");
  }
  if (column.logicalType === "boolean" && typeof value !== "boolean") {
    throw new Error("science-display-table-render-model-document-cell-invalid");
  }
  if (column.logicalType === "string" && (typeof value !== "string" || CONTROL_RE.test(value) || Buffer.byteLength(value, "utf8") > 16 * 1024)) {
    throw new Error("science-display-table-render-model-document-cell-invalid");
  }
  return value as ScienceDatasetCell;
}

function validateEditableDocument(value: unknown): SciencePublicationEditableTableDocument {
  const candidate = record(value, "science-display-table-render-model-document-invalid");
  exactKeys(candidate, ["schema", "bindingSha256", "title", "caption", "notes", "nullDisplay", "columns", "rows"], "science-display-table-render-model-document-invalid");
  if (candidate.schema !== SCIENCE_PUBLICATION_EDITABLE_TABLE_DOCUMENT_SCHEMA) throw new Error("science-display-table-render-model-document-invalid");
  const columnsValue = Array.isArray(candidate.columns) ? candidate.columns : null;
  const rowsValue = Array.isArray(candidate.rows) ? candidate.rows : null;
  if (!columnsValue || columnsValue.length < 1 || columnsValue.length > 64 || !rowsValue || rowsValue.length < 1 || rowsValue.length > 1_000
    || columnsValue.length * rowsValue.length > 20_000) throw new Error("science-display-table-render-model-document-dimensions-invalid");

  const columns = columnsValue.map((entry): SciencePublicationEditableTableColumnBinding => {
    const item = record(entry, "science-display-table-render-model-document-column-invalid");
    exactKeys(item, ["sourceOrdinal", "name", "logicalType", "nullable"], "science-display-table-render-model-document-column-invalid");
    const logicalType = item.logicalType;
    if (logicalType !== "integer" && logicalType !== "number" && logicalType !== "boolean" && logicalType !== "string") {
      throw new Error("science-display-table-render-model-document-column-invalid");
    }
    if (typeof item.nullable !== "boolean") throw new Error("science-display-table-render-model-document-column-invalid");
    return {
      sourceOrdinal: integer(item.sourceOrdinal, 0, Number.MAX_SAFE_INTEGER, "science-display-table-render-model-document-column-invalid"),
      name: text(item.name, 240, "science-display-table-render-model-document-column-invalid"),
      logicalType,
      nullable: item.nullable,
    };
  });
  if (new Set(columns.map((column) => column.name)).size !== columns.length
    || new Set(columns.map((column) => column.sourceOrdinal)).size !== columns.length) {
    throw new Error("science-display-table-render-model-document-column-duplicate");
  }

  const rows = rowsValue.map((entry, rowIndex) => {
    const item = record(entry, "science-display-table-render-model-document-row-invalid");
    exactKeys(item, ["sourceRowIndex", "cells"], "science-display-table-render-model-document-row-invalid");
    const sourceRowIndex = integer(item.sourceRowIndex, 0, Number.MAX_SAFE_INTEGER, "science-display-table-render-model-document-row-invalid");
    const previous = rowIndex > 0 ? record(rowsValue[rowIndex - 1], "science-display-table-render-model-document-row-invalid").sourceRowIndex : null;
    if (previous !== null && (!Number.isSafeInteger(previous) || Number(previous) >= sourceRowIndex)) {
      throw new Error("science-display-table-render-model-document-row-order-invalid");
    }
    const cellsValue = record(item.cells, "science-display-table-render-model-document-cells-invalid");
    exactKeys(cellsValue, columns.map((column) => column.name), "science-display-table-render-model-document-cells-invalid");
    const cells = Object.fromEntries(columns.map((column) => [column.name, validateCell(cellsValue[column.name], column)])) as Record<string, ScienceDatasetCell>;
    return { sourceRowIndex, cells };
  });

  const notesValue = Array.isArray(candidate.notes) ? candidate.notes : null;
  if (!notesValue || notesValue.length > 32) throw new Error("science-display-table-render-model-document-notes-invalid");
  const notes = notesValue.map((note) => text(note, 2_000, "science-display-table-render-model-document-note-invalid"));
  return {
    schema: SCIENCE_PUBLICATION_EDITABLE_TABLE_DOCUMENT_SCHEMA,
    bindingSha256: hash(candidate.bindingSha256, "science-display-table-render-model-document-binding-invalid"),
    title: text(candidate.title, 500, "science-display-table-render-model-document-title-invalid"),
    caption: text(candidate.caption, 4_000, "science-display-table-render-model-document-caption-invalid"),
    notes,
    nullDisplay: text(candidate.nullDisplay, 40, "science-display-table-render-model-document-null-display-invalid", true),
    columns,
    rows,
  };
}

function containsRange(outerStart: number, outerEnd: number, innerStart: number, innerEnd: number): boolean {
  return outerStart <= innerStart && outerEnd >= innerEnd;
}

function rangesOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

function validateSpannerHierarchy(presentation: ScienceDisplayTablePresentationV1): void {
  const levels = [...new Set(presentation.columnGroups.map((group) => group.level))].sort((left, right) => left - right);
  levels.forEach((level, index) => {
    if (level !== index + 1) throw new Error("science-display-table-render-model-spanner-level-invalid");
  });
  presentation.columnGroups.forEach((higher) => {
    presentation.columnGroups.forEach((lower) => {
      if (higher.level <= lower.level || !rangesOverlap(higher.startColumnIndex, higher.endColumnIndex, lower.startColumnIndex, lower.endColumnIndex)) return;
      if (!containsRange(higher.startColumnIndex, higher.endColumnIndex, lower.startColumnIndex, lower.endColumnIndex)) {
        throw new Error("science-display-table-render-model-spanner-hierarchy-invalid");
      }
    });
  });
}

function columnGroupGrid(
  presentation: ScienceDisplayTablePresentationV1,
  document: SciencePublicationEditableTableDocument,
): ScienceDisplayTableColumnGroupGrid {
  validateSpannerHierarchy(presentation);
  const depth = presentation.columnGroups.reduce((maximum, group) => Math.max(maximum, group.level), 0);
  const bands: ScienceDisplayTableHeaderGridBand[] = [];
  for (let level = depth; level >= 1; level -= 1) {
    const groups = presentation.columnGroups.filter((group) => group.level === level);
    const cells: ScienceDisplayTableHeaderGridCell[] = [];
    let columnIndex = 0;
    while (columnIndex < document.columns.length) {
      const group = groups.find((candidate) => candidate.startColumnIndex === columnIndex);
      if (group) {
        cells.push({
          kind: "group",
          groupId: group.id,
          label: group.label,
          startColumnIndex: group.startColumnIndex,
          endColumnIndex: group.endColumnIndex,
          columnSpan: group.endColumnIndex - group.startColumnIndex + 1,
        });
        columnIndex = group.endColumnIndex + 1;
      } else {
        cells.push({
          kind: "empty",
          groupId: null,
          label: null,
          startColumnIndex: columnIndex,
          endColumnIndex: columnIndex,
          columnSpan: 1,
        });
        columnIndex += 1;
      }
    }
    if (cells.reduce((total, cell) => total + cell.columnSpan, 0) !== document.columns.length) {
      throw new Error("science-display-table-render-model-spanner-grid-invalid");
    }
    bands.push({ level, cells });
  }
  return {
    depth,
    bands,
    leafColumns: document.columns.map((column, columnIndex) => ({ columnIndex, ...column })),
  };
}

function panelStarts(
  presentation: ScienceDisplayTablePresentationV1,
  document: SciencePublicationEditableTableDocument,
): ScienceDisplayTablePanelStart[] {
  return presentation.panels.map((panel) => {
    const row = document.rows[panel.startRowIndex];
    if (!row || !document.rows[panel.endRowIndex]) throw new Error("science-display-table-render-model-panel-mapping-invalid");
    return {
      panelId: panel.id,
      label: panel.label,
      startRowIndex: panel.startRowIndex,
      endRowIndex: panel.endRowIndex,
      sourceRowIndex: row.sourceRowIndex,
    };
  });
}

function cellRoleGrid(
  presentation: ScienceDisplayTablePresentationV1,
  document: SciencePublicationEditableTableDocument,
): ScienceDisplayTableCellRole[][] {
  const grid = document.rows.map(() => document.columns.map((): ScienceDisplayTableCellRole => "text"));
  presentation.cellRoles.forEach((assignment) => {
    for (let rowIndex = assignment.rowStartIndex; rowIndex <= assignment.rowEndIndex; rowIndex += 1) {
      for (let columnIndex = assignment.columnStartIndex; columnIndex <= assignment.columnEndIndex; columnIndex += 1) {
        if (!grid[rowIndex]?.[columnIndex]) throw new Error("science-display-table-render-model-cell-role-mapping-invalid");
        grid[rowIndex][columnIndex] = assignment.role;
      }
    }
  });
  return grid;
}

function roman(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3_999) throw new Error("science-display-table-render-model-numbering-invalid");
  const numerals: Array<[number, string]> = [
    [1_000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"],
    [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];
  let remaining = value;
  let output = "";
  numerals.forEach(([amount, symbol]) => {
    while (remaining >= amount) {
      output += symbol;
      remaining -= amount;
    }
  });
  return output;
}

function tableLabel(numbering: ScienceDisplayTableNumbering): string {
  if (numbering.style === "arabic") return `Table ${numbering.ordinal}`;
  if (numbering.style === "roman") return `Table ${roman(numbering.ordinal)}`;
  return `Table ${numbering.appendixLabel}${roman(numbering.ordinal)}`;
}

function displayCell(value: ScienceDatasetCell, nullDisplay: string): string {
  const output = value === null ? nullDisplay : typeof value === "boolean" ? (value ? "true" : "false") : String(value);
  return output.replace(/\r?\n/gu, " ↵ ");
}

function semanticLines(
  label: string,
  presentation: ScienceDisplayTablePresentationV1,
  document: SciencePublicationEditableTableDocument,
  grid: ScienceDisplayTableColumnGroupGrid,
  starts: ScienceDisplayTablePanelStart[],
): ScienceDisplayTableSemanticLine[] {
  const lines: Array<Omit<ScienceDisplayTableSemanticLine, "ordinal">> = [
    { kind: "label", text: label },
    { kind: "title", text: presentation.title },
    { kind: "caption", text: document.caption },
    { kind: "legend", text: presentation.legend },
  ];
  grid.bands.forEach((band) => {
    lines.push({
      kind: "column-group",
      text: band.cells.map((cell) => cell.label ?? "").join(" | "),
    });
  });
  lines.push({ kind: "column-header", text: document.columns.map((column) => column.name).join(" | ") });
  const panelByStart = new Map(starts.map((panel) => [panel.startRowIndex, panel]));
  document.rows.forEach((row, rowIndex) => {
    const panel = panelByStart.get(rowIndex);
    if (panel) lines.push({ kind: "panel", text: panel.label });
    lines.push({
      kind: "data-row",
      text: document.columns.map((column) => displayCell(row.cells[column.name], document.nullDisplay)).join(" | "),
    });
  });
  document.notes.forEach((note) => lines.push({ kind: "source-note", text: note }));
  (["general", "specific", "probability"] as const).forEach((kind) => {
    presentation.notes.filter((note) => note.kind === kind).forEach((note) => {
      const marked = note.marker && !note.text.startsWith(note.marker) ? `${note.marker} ${note.text}` : note.text;
      lines.push({ kind: `${kind}-note`, text: marked });
    });
  });
  const statistics = presentation.statistics;
  if (statistics.estimator) lines.push({ kind: "statistics-estimator", text: `Estimator: ${statistics.estimator}` });
  if (statistics.uncertainty) {
    const uncertainty = statistics.uncertainty;
    lines.push({
      kind: "statistics-uncertainty",
      text: [
        `Uncertainty: ${uncertainty.kind}`,
        `method=${uncertainty.method}`,
        uncertainty.standardError ? `standard error=${uncertainty.standardError}` : null,
        uncertainty.confidenceLevel === null ? null : `level=${uncertainty.confidenceLevel}`,
        uncertainty.clusteredBy.length ? `clustered by=${uncertainty.clusteredBy.join(", ")}` : null,
      ].filter((part): part is string => part !== null).join("; "),
    });
  }
  if (statistics.sample) {
    lines.push({
      kind: "statistics-sample",
      text: `Sample: N=${statistics.sample.n} ${statistics.sample.unit}${statistics.sample.description ? `; ${statistics.sample.description}` : ""}`,
    });
  }
  statistics.tests.forEach((test) => {
    lines.push({
      kind: "statistics-test",
      text: `Test: ${test.name}; tails=${test.tails}; ${test.statistic}=${test.value}; df=${test.degreesOfFreedom.join(", ")}; exact p=${test.exactP}`,
    });
  });
  if (statistics.repeats) {
    lines.push({
      kind: "statistics-repeats",
      text: `Repeats: ${statistics.repeats.count} ${statistics.repeats.unit}${statistics.repeats.description ? `; ${statistics.repeats.description}` : ""}`,
    });
  }
  if (statistics.errorBars) {
    lines.push({
      kind: "statistics-error-bars",
      text: `Error bars: ${statistics.errorBars.meaning}; center=${statistics.errorBars.center}; interval=${statistics.errorBars.interval}`,
    });
  }
  presentation.provenanceRefs.forEach((reference) => {
    lines.push({ kind: "provenance", text: `Provenance: ${reference.kind}; ${reference.id}; sha256:${reference.sha256}` });
  });
  return lines.map((line, ordinal) => ({ ordinal: ordinal + 1, ...line }));
}

function buildTrustedCore(
  presentationValue: ScienceDisplayTablePresentationV1,
  documentValue: SciencePublicationEditableTableDocument,
  exportManifestSha256Value: string,
): Omit<ScienceDisplayTableRenderModelV1, "displaySemanticSha256"> {
  const presentation = validateScienceDisplayTablePresentationV1(presentationValue);
  const document = validateEditableDocument(documentValue);
  const exportManifestSha256 = hash(exportManifestSha256Value, "science-display-table-render-model-export-manifest-invalid");
  if (presentation.source.bindingSha256 !== document.bindingSha256) {
    throw new Error("science-display-table-render-model-source-binding-mismatch");
  }
  if (presentation.source.rowCount !== document.rows.length || presentation.source.columnCount !== document.columns.length) {
    throw new Error("science-display-table-render-model-source-dimensions-mismatch");
  }
  const columnGrid = columnGroupGrid(presentation, document);
  const starts = panelStarts(presentation, document);
  const roles = cellRoleGrid(presentation, document);
  const label = tableLabel(presentation.numbering);
  return {
    schema: SCIENCE_DISPLAY_TABLE_RENDER_MODEL_SCHEMA,
    source: {
      bindingSha256: document.bindingSha256,
      exportManifestSha256,
      presentationSha256: presentation.presentationSha256,
      documentSha256: sciencePublicationTableSha256(document),
      rowCount: document.rows.length,
      columnCount: document.columns.length,
    },
    presentation: clonePlain(presentation),
    document: clonePlain(document),
    label,
    title: presentation.title,
    caption: document.caption,
    legend: presentation.legend,
    numbering: clonePlain(presentation.numbering),
    layout: clonePlain(presentation.layout),
    columnGroupGrid: columnGrid,
    panelStarts: starts,
    cellRoleGrid: roles,
    sourceNotes: [...document.notes],
    notes: clonePlain(presentation.notes),
    statistics: clonePlain(presentation.statistics),
    provenanceRefs: clonePlain(presentation.provenanceRefs),
    semanticLines: semanticLines(label, presentation, document, columnGrid, starts),
  };
}

function buildTrusted(
  presentation: ScienceDisplayTablePresentationV1,
  document: SciencePublicationEditableTableDocument,
  exportManifestSha256: string,
): ScienceDisplayTableRenderModelV1 {
  const core = buildTrustedCore(presentation, document, exportManifestSha256);
  const displaySemanticSha256 = scienceDisplayTableRenderModelSha256(core);
  return deepFreeze(clonePlain({ ...core, displaySemanticSha256 }));
}

export function buildScienceDisplayTableRenderModelV1(
  input: BuildScienceDisplayTableRenderModelV1Input,
): ScienceDisplayTableRenderModelV1 {
  const verifiedExport = verifySciencePublicationEditableTable(input.tableExport);
  return buildTrusted(input.presentation, verifiedExport.document, verifiedExport.manifestSha256);
}

export function validateScienceDisplayTableRenderModelV1(value: unknown): ScienceDisplayTableRenderModelV1 {
  const candidate = record(value, "science-display-table-render-model-invalid");
  exactKeys(candidate, [
    "schema", "source", "presentation", "document", "label", "title", "caption", "legend", "numbering", "layout", "columnGroupGrid", "panelStarts", "cellRoleGrid", "sourceNotes", "notes", "statistics", "provenanceRefs", "semanticLines", "displaySemanticSha256",
  ], "science-display-table-render-model-invalid");
  if (candidate.schema !== SCIENCE_DISPLAY_TABLE_RENDER_MODEL_SCHEMA) throw new Error("science-display-table-render-model-schema-invalid");
  const source = record(candidate.source, "science-display-table-render-model-source-invalid");
  exactKeys(source, ["bindingSha256", "exportManifestSha256", "presentationSha256", "documentSha256", "rowCount", "columnCount"], "science-display-table-render-model-source-invalid");
  const exportManifestSha256 = hash(source.exportManifestSha256, "science-display-table-render-model-export-manifest-invalid");
  const { displaySemanticSha256, ...unsigned } = candidate;
  const claimedHash = hash(displaySemanticSha256, "science-display-table-render-model-hash-invalid");
  if (scienceDisplayTableRenderModelSha256(unsigned) !== claimedHash) throw new Error("science-display-table-render-model-hash-mismatch");
  const expected = buildTrusted(
    candidate.presentation as ScienceDisplayTablePresentationV1,
    candidate.document as SciencePublicationEditableTableDocument,
    exportManifestSha256,
  );
  if (expected.displaySemanticSha256 !== claimedHash || canonicalJson(expected) !== canonicalJson(candidate)) {
    throw new Error("science-display-table-render-model-integrity-invalid");
  }
  return expected;
}
