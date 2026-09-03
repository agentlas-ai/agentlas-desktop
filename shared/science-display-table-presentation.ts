import { createHash } from "node:crypto";

export const SCIENCE_DISPLAY_TABLE_PRESENTATION_SCHEMA = "agentlas.science.display-table-presentation/v1" as const;

export const SCIENCE_DISPLAY_TABLE_PRESENTATION_LIMITS = {
  maxRows: 1_000,
  maxColumns: 64,
  maxColumnGroups: 256,
  maxColumnGroupLevels: 4,
  maxPanels: 1_000,
  maxCellRoles: 20_000,
  maxNotes: 32,
  maxTests: 100,
  maxProvenanceRefs: 256,
} as const;

const SHA256_RE = /^[a-f0-9]{64}$/u;
const TOKEN_RE = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const APPENDIX_LABEL_RE = /^[A-Z]{1,8}$/u;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export type ScienceDisplayTableNumberingStyle = "arabic" | "roman" | "appendix";
export type ScienceDisplayTableOrientation = "portrait" | "landscape";
export type ScienceDisplayTablePlacement = "inline" | "separate-page" | "appendix";
export type ScienceDisplayTablePageBreak = "auto" | "before" | "after" | "both";
export type ScienceDisplayTableCellRole = "estimate" | "standard-error" | "statistic" | "model-summary" | "text";
export type ScienceDisplayTableNoteKind = "general" | "specific" | "probability";
export type ScienceDisplayTableTestTails = "one" | "two" | "not-applicable";
export type ScienceDisplayTableUncertaintyKind = "standard-error" | "confidence-interval" | "credible-interval" | "other";
export type ScienceDisplayTableStandardErrorMethod = "classical" | "heteroskedasticity-consistent" | "clustered" | "bootstrap" | "other";
export type ScienceDisplayTableProvenanceKind = "artifact" | "dataset" | "run" | "analysis-plan" | "source";

export interface ScienceDisplayTableSourceBinding {
  readonly bindingSha256: string;
  readonly rowCount: number;
  readonly columnCount: number;
}

export interface ScienceDisplayTableNumbering {
  readonly style: ScienceDisplayTableNumberingStyle;
  readonly ordinal: number;
  /** Required only for appendix numbering, for example `A` in Table AI. */
  readonly appendixLabel: string | null;
}

export interface ScienceDisplayTableLayout {
  readonly orientation: ScienceDisplayTableOrientation;
  readonly placement: ScienceDisplayTablePlacement;
  readonly pageBreak: ScienceDisplayTablePageBreak;
}

export interface ScienceDisplayTableColumnGroup {
  readonly id: string;
  readonly label: string;
  readonly level: number;
  readonly startColumnIndex: number;
  readonly endColumnIndex: number;
}

export interface ScienceDisplayTablePanel {
  readonly id: string;
  readonly label: string;
  readonly startRowIndex: number;
  readonly endRowIndex: number;
}

export interface ScienceDisplayTableCellRoleAssignment {
  readonly role: ScienceDisplayTableCellRole;
  readonly rowStartIndex: number;
  readonly rowEndIndex: number;
  readonly columnStartIndex: number;
  readonly columnEndIndex: number;
}

export interface ScienceDisplayTableCellReference {
  readonly rowIndex: number;
  readonly columnIndex: number;
}

export interface ScienceDisplayTableNote {
  readonly id: string;
  readonly kind: ScienceDisplayTableNoteKind;
  readonly marker: string | null;
  readonly text: string;
  readonly cellRefs: readonly ScienceDisplayTableCellReference[];
}

export interface ScienceDisplayTableUncertaintyDisclosure {
  readonly kind: ScienceDisplayTableUncertaintyKind;
  readonly method: string;
  readonly standardError: ScienceDisplayTableStandardErrorMethod | null;
  /** Fraction in the open interval (0, 1), required for interval uncertainty. */
  readonly confidenceLevel: number | null;
  /** Variable names used for clustering; non-empty only for clustered standard errors. */
  readonly clusteredBy: readonly string[];
}

export interface ScienceDisplayTableSampleDisclosure {
  readonly n: number;
  readonly unit: string;
  readonly description: string | null;
}

export interface ScienceDisplayTableTestDisclosure {
  readonly id: string;
  readonly name: string;
  readonly tails: ScienceDisplayTableTestTails;
  readonly statistic: string;
  readonly value: number;
  readonly exactP: number;
  /** One value for t/chi-square tests, two or more when the test requires them. */
  readonly degreesOfFreedom: readonly number[];
}

export interface ScienceDisplayTableRepeatsDisclosure {
  readonly count: number;
  readonly unit: string;
  readonly description: string | null;
}

export interface ScienceDisplayTableErrorBarsDisclosure {
  readonly meaning: string;
  readonly center: string;
  readonly interval: string;
}

export interface ScienceDisplayTableStatisticalDisclosure {
  readonly estimator: string | null;
  readonly uncertainty: ScienceDisplayTableUncertaintyDisclosure | null;
  readonly sample: ScienceDisplayTableSampleDisclosure | null;
  readonly tests: readonly ScienceDisplayTableTestDisclosure[];
  readonly repeats: ScienceDisplayTableRepeatsDisclosure | null;
  readonly errorBars: ScienceDisplayTableErrorBarsDisclosure | null;
}

export interface ScienceDisplayTableProvenanceReference {
  readonly kind: ScienceDisplayTableProvenanceKind;
  readonly id: string;
  readonly sha256: string;
}

export interface ScienceDisplayTablePresentationV1 {
  readonly schema: typeof SCIENCE_DISPLAY_TABLE_PRESENTATION_SCHEMA;
  readonly source: ScienceDisplayTableSourceBinding;
  readonly title: string;
  readonly legend: string;
  readonly numbering: ScienceDisplayTableNumbering;
  readonly layout: ScienceDisplayTableLayout;
  readonly columnGroups: readonly ScienceDisplayTableColumnGroup[];
  readonly panels: readonly ScienceDisplayTablePanel[];
  readonly cellRoles: readonly ScienceDisplayTableCellRoleAssignment[];
  readonly notes: readonly ScienceDisplayTableNote[];
  readonly statistics: ScienceDisplayTableStatisticalDisclosure;
  readonly provenanceRefs: readonly ScienceDisplayTableProvenanceReference[];
  readonly presentationSha256: string;
}

export type BuildScienceDisplayTablePresentationV1Input = Omit<
  ScienceDisplayTablePresentationV1,
  "schema" | "presentationSha256"
>;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  const item = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(item).sort().flatMap((key) => (
    item[key] === undefined ? [] : [[key, canonicalValue(item[key])]]
  )));
}

export function scienceDisplayTablePresentationSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex");
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

function text(value: unknown, maximum: number, code: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > maximum || CONTROL_RE.test(value)) {
    throw new Error(code);
  }
  return value;
}

function nullableText(value: unknown, maximum: number, code: string): string | null {
  return value === null ? null : text(value, maximum, code);
}

function token(value: unknown, code: string): string {
  if (typeof value !== "string" || !TOKEN_RE.test(value)) throw new Error(code);
  return value;
}

function hash(value: unknown, code: string): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) throw new Error(code);
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(code);
  return Number(value);
}

function finite(value: unknown, minimum: number, maximum: number, code: string, open = false): number {
  if (typeof value !== "number" || !Number.isFinite(value)
    || (open ? value <= minimum || value >= maximum : value < minimum || value > maximum)) throw new Error(code);
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], code: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(code);
  return value as T;
}

function array(value: unknown, minimum: number, maximum: number, code: string): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(code);
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

function cellReference(
  value: unknown,
  rowCount: number,
  columnCount: number,
  code: string,
): ScienceDisplayTableCellReference {
  const item = record(value, code);
  exactKeys(item, ["rowIndex", "columnIndex"], code);
  return {
    rowIndex: integer(item.rowIndex, 0, rowCount - 1, code),
    columnIndex: integer(item.columnIndex, 0, columnCount - 1, code),
  };
}

function rangesOverlap(
  left: ScienceDisplayTableCellRoleAssignment,
  right: ScienceDisplayTableCellRoleAssignment,
): boolean {
  return left.rowStartIndex <= right.rowEndIndex && right.rowStartIndex <= left.rowEndIndex
    && left.columnStartIndex <= right.columnEndIndex && right.columnStartIndex <= left.columnEndIndex;
}

function compareCellCoordinates(
  left: readonly number[],
  right: readonly number[],
): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function validateCore(value: unknown): Omit<ScienceDisplayTablePresentationV1, "presentationSha256"> {
  const candidate = record(value, "science-display-table-presentation-invalid");
  exactKeys(candidate, [
    "schema", "source", "title", "legend", "numbering", "layout", "columnGroups", "panels", "cellRoles", "notes", "statistics", "provenanceRefs",
  ], "science-display-table-presentation-invalid");
  if (candidate.schema !== SCIENCE_DISPLAY_TABLE_PRESENTATION_SCHEMA) throw new Error("science-display-table-presentation-schema-invalid");

  const sourceValue = record(candidate.source, "science-display-table-presentation-source-invalid");
  exactKeys(sourceValue, ["bindingSha256", "rowCount", "columnCount"], "science-display-table-presentation-source-invalid");
  const source: ScienceDisplayTableSourceBinding = {
    bindingSha256: hash(sourceValue.bindingSha256, "science-display-table-presentation-source-hash-invalid"),
    rowCount: integer(sourceValue.rowCount, 1, SCIENCE_DISPLAY_TABLE_PRESENTATION_LIMITS.maxRows, "science-display-table-presentation-source-rows-invalid"),
    columnCount: integer(sourceValue.columnCount, 1, SCIENCE_DISPLAY_TABLE_PRESENTATION_LIMITS.maxColumns, "science-display-table-presentation-source-columns-invalid"),
  };

  const numberingValue = record(candidate.numbering, "science-display-table-presentation-numbering-invalid");
  exactKeys(numberingValue, ["style", "ordinal", "appendixLabel"], "science-display-table-presentation-numbering-invalid");
  const numbering: ScienceDisplayTableNumbering = {
    style: enumValue(numberingValue.style, ["arabic", "roman", "appendix"], "science-display-table-presentation-numbering-invalid"),
    ordinal: integer(numberingValue.ordinal, 1, 9_999, "science-display-table-presentation-numbering-invalid"),
    appendixLabel: numberingValue.appendixLabel === null ? null : text(numberingValue.appendixLabel, 8, "science-display-table-presentation-numbering-invalid"),
  };
  if ((numbering.style === "appendix" && (numbering.appendixLabel === null || !APPENDIX_LABEL_RE.test(numbering.appendixLabel)))
    || (numbering.style !== "appendix" && numbering.appendixLabel !== null)) {
    throw new Error("science-display-table-presentation-numbering-invalid");
  }

  const layoutValue = record(candidate.layout, "science-display-table-presentation-layout-invalid");
  exactKeys(layoutValue, ["orientation", "placement", "pageBreak"], "science-display-table-presentation-layout-invalid");
  const layout: ScienceDisplayTableLayout = {
    orientation: enumValue(layoutValue.orientation, ["portrait", "landscape"], "science-display-table-presentation-layout-invalid"),
    placement: enumValue(layoutValue.placement, ["inline", "separate-page", "appendix"], "science-display-table-presentation-layout-invalid"),
    pageBreak: enumValue(layoutValue.pageBreak, ["auto", "before", "after", "both"], "science-display-table-presentation-layout-invalid"),
  };
  if ((layout.placement === "appendix") !== (numbering.style === "appendix")) {
    throw new Error("science-display-table-presentation-appendix-layout-invalid");
  }

  const columnGroups = array(candidate.columnGroups, 0, SCIENCE_DISPLAY_TABLE_PRESENTATION_LIMITS.maxColumnGroups, "science-display-table-presentation-column-groups-invalid")
    .map((entry): ScienceDisplayTableColumnGroup => {
      const item = record(entry, "science-display-table-presentation-column-group-invalid");
      exactKeys(item, ["id", "label", "level", "startColumnIndex", "endColumnIndex"], "science-display-table-presentation-column-group-invalid");
      const startColumnIndex = integer(item.startColumnIndex, 0, source.columnCount - 1, "science-display-table-presentation-column-group-invalid");
      const endColumnIndex = integer(item.endColumnIndex, startColumnIndex, source.columnCount - 1, "science-display-table-presentation-column-group-invalid");
      return {
        id: token(item.id, "science-display-table-presentation-column-group-invalid"),
        label: text(item.label, 500, "science-display-table-presentation-column-group-invalid"),
        level: integer(item.level, 1, SCIENCE_DISPLAY_TABLE_PRESENTATION_LIMITS.maxColumnGroupLevels, "science-display-table-presentation-column-group-invalid"),
        startColumnIndex,
        endColumnIndex,
      };
    });
  if (new Set(columnGroups.map((group) => group.id)).size !== columnGroups.length) throw new Error("science-display-table-presentation-column-group-duplicate");
  columnGroups.forEach((group, index) => {
    const previous = columnGroups[index - 1];
    if (previous && (previous.level > group.level
      || (previous.level === group.level && previous.startColumnIndex >= group.startColumnIndex))) {
      throw new Error("science-display-table-presentation-column-groups-order-invalid");
    }
    if (columnGroups.some((other, otherIndex) => otherIndex < index && other.level === group.level && other.endColumnIndex >= group.startColumnIndex)) {
      throw new Error("science-display-table-presentation-column-groups-overlap");
    }
  });

  const panels = array(candidate.panels, 0, SCIENCE_DISPLAY_TABLE_PRESENTATION_LIMITS.maxPanels, "science-display-table-presentation-panels-invalid")
    .map((entry): ScienceDisplayTablePanel => {
      const item = record(entry, "science-display-table-presentation-panel-invalid");
      exactKeys(item, ["id", "label", "startRowIndex", "endRowIndex"], "science-display-table-presentation-panel-invalid");
      const startRowIndex = integer(item.startRowIndex, 0, source.rowCount - 1, "science-display-table-presentation-panel-invalid");
      return {
        id: token(item.id, "science-display-table-presentation-panel-invalid"),
        label: text(item.label, 500, "science-display-table-presentation-panel-invalid"),
        startRowIndex,
        endRowIndex: integer(item.endRowIndex, startRowIndex, source.rowCount - 1, "science-display-table-presentation-panel-invalid"),
      };
    });
  if (new Set(panels.map((panel) => panel.id)).size !== panels.length) throw new Error("science-display-table-presentation-panel-duplicate");
  panels.forEach((panel, index) => {
    const previous = panels[index - 1];
    if (previous && previous.startRowIndex >= panel.startRowIndex) throw new Error("science-display-table-presentation-panels-order-invalid");
    if (previous && previous.endRowIndex >= panel.startRowIndex) throw new Error("science-display-table-presentation-panels-overlap");
  });

  const cellRoles = array(candidate.cellRoles, 0, SCIENCE_DISPLAY_TABLE_PRESENTATION_LIMITS.maxCellRoles, "science-display-table-presentation-cell-roles-invalid")
    .map((entry): ScienceDisplayTableCellRoleAssignment => {
      const item = record(entry, "science-display-table-presentation-cell-role-invalid");
      exactKeys(item, ["role", "rowStartIndex", "rowEndIndex", "columnStartIndex", "columnEndIndex"], "science-display-table-presentation-cell-role-invalid");
      const rowStartIndex = integer(item.rowStartIndex, 0, source.rowCount - 1, "science-display-table-presentation-cell-role-invalid");
      const columnStartIndex = integer(item.columnStartIndex, 0, source.columnCount - 1, "science-display-table-presentation-cell-role-invalid");
      return {
        role: enumValue(item.role, ["estimate", "standard-error", "statistic", "model-summary", "text"], "science-display-table-presentation-cell-role-invalid"),
        rowStartIndex,
        rowEndIndex: integer(item.rowEndIndex, rowStartIndex, source.rowCount - 1, "science-display-table-presentation-cell-role-invalid"),
        columnStartIndex,
        columnEndIndex: integer(item.columnEndIndex, columnStartIndex, source.columnCount - 1, "science-display-table-presentation-cell-role-invalid"),
      };
    });
  cellRoles.forEach((assignment, index) => {
    const previous = cellRoles[index - 1];
    if (previous && compareCellCoordinates(
      [assignment.rowStartIndex, assignment.columnStartIndex, assignment.rowEndIndex, assignment.columnEndIndex],
      [previous.rowStartIndex, previous.columnStartIndex, previous.rowEndIndex, previous.columnEndIndex],
    ) <= 0) {
      throw new Error("science-display-table-presentation-cell-roles-order-invalid");
    }
    if (cellRoles.some((other, otherIndex) => otherIndex < index && rangesOverlap(other, assignment))) {
      throw new Error("science-display-table-presentation-cell-roles-overlap");
    }
  });

  const notes = array(candidate.notes, 0, SCIENCE_DISPLAY_TABLE_PRESENTATION_LIMITS.maxNotes, "science-display-table-presentation-notes-invalid")
    .map((entry): ScienceDisplayTableNote => {
      const item = record(entry, "science-display-table-presentation-note-invalid");
      exactKeys(item, ["id", "kind", "marker", "text", "cellRefs"], "science-display-table-presentation-note-invalid");
      const kind = enumValue(item.kind, ["general", "specific", "probability"], "science-display-table-presentation-note-invalid");
      const marker = nullableText(item.marker, 16, "science-display-table-presentation-note-invalid");
      const cellRefs = array(item.cellRefs, 0, source.rowCount * source.columnCount, "science-display-table-presentation-note-invalid")
        .map((cell) => cellReference(cell, source.rowCount, source.columnCount, "science-display-table-presentation-note-cell-invalid"));
      const cellKeys = cellRefs.map((cell) => `${cell.rowIndex}:${cell.columnIndex}`);
      if (new Set(cellKeys).size !== cellKeys.length || cellRefs.some((cell, index) => index > 0
        && compareCellCoordinates([cell.rowIndex, cell.columnIndex], [cellRefs[index - 1].rowIndex, cellRefs[index - 1].columnIndex]) <= 0)) {
        throw new Error("science-display-table-presentation-note-cells-invalid");
      }
      if ((kind === "general" && (marker !== null || cellRefs.length !== 0))
        || (kind === "specific" && (marker === null || cellRefs.length === 0))
        || (kind === "probability" && (marker === null || cellRefs.length !== 0))) {
        throw new Error("science-display-table-presentation-note-semantics-invalid");
      }
      return {
        id: token(item.id, "science-display-table-presentation-note-invalid"),
        kind,
        marker,
        text: text(item.text, 4_000, "science-display-table-presentation-note-invalid"),
        cellRefs,
      };
    });
  if (new Set(notes.map((note) => note.id)).size !== notes.length) throw new Error("science-display-table-presentation-note-duplicate");

  const statisticsValue = record(candidate.statistics, "science-display-table-presentation-statistics-invalid");
  exactKeys(statisticsValue, ["estimator", "uncertainty", "sample", "tests", "repeats", "errorBars"], "science-display-table-presentation-statistics-invalid");

  let uncertainty: ScienceDisplayTableUncertaintyDisclosure | null = null;
  if (statisticsValue.uncertainty !== null) {
    const item = record(statisticsValue.uncertainty, "science-display-table-presentation-uncertainty-invalid");
    exactKeys(item, ["kind", "method", "standardError", "confidenceLevel", "clusteredBy"], "science-display-table-presentation-uncertainty-invalid");
    const kind = enumValue(item.kind, ["standard-error", "confidence-interval", "credible-interval", "other"], "science-display-table-presentation-uncertainty-invalid");
    const standardError = item.standardError === null ? null
      : enumValue(item.standardError, ["classical", "heteroskedasticity-consistent", "clustered", "bootstrap", "other"], "science-display-table-presentation-uncertainty-invalid");
    const confidenceLevel = item.confidenceLevel === null ? null
      : finite(item.confidenceLevel, 0, 1, "science-display-table-presentation-uncertainty-invalid", true);
    const clusteredBy = array(item.clusteredBy, 0, 16, "science-display-table-presentation-uncertainty-invalid")
      .map((entry) => text(entry, 240, "science-display-table-presentation-uncertainty-invalid"));
    if (new Set(clusteredBy).size !== clusteredBy.length
      || (kind === "standard-error" && (standardError === null || confidenceLevel !== null))
      || ((kind === "confidence-interval" || kind === "credible-interval") && confidenceLevel === null)
      || (standardError === "clustered" && clusteredBy.length === 0)
      || (standardError !== "clustered" && clusteredBy.length !== 0)) {
      throw new Error("science-display-table-presentation-uncertainty-semantics-invalid");
    }
    uncertainty = { kind, method: text(item.method, 1_000, "science-display-table-presentation-uncertainty-invalid"), standardError, confidenceLevel, clusteredBy };
  }

  let sample: ScienceDisplayTableSampleDisclosure | null = null;
  if (statisticsValue.sample !== null) {
    const item = record(statisticsValue.sample, "science-display-table-presentation-sample-invalid");
    exactKeys(item, ["n", "unit", "description"], "science-display-table-presentation-sample-invalid");
    sample = {
      n: integer(item.n, 1, Number.MAX_SAFE_INTEGER, "science-display-table-presentation-sample-invalid"),
      unit: text(item.unit, 240, "science-display-table-presentation-sample-invalid"),
      description: nullableText(item.description, 2_000, "science-display-table-presentation-sample-invalid"),
    };
  }

  const tests = array(statisticsValue.tests, 0, SCIENCE_DISPLAY_TABLE_PRESENTATION_LIMITS.maxTests, "science-display-table-presentation-tests-invalid")
    .map((entry): ScienceDisplayTableTestDisclosure => {
      const item = record(entry, "science-display-table-presentation-test-invalid");
      exactKeys(item, ["id", "name", "tails", "statistic", "value", "exactP", "degreesOfFreedom"], "science-display-table-presentation-test-invalid");
      const exactP = finite(item.exactP, 0, 1, "science-display-table-presentation-test-invalid");
      if (exactP === 0) throw new Error("science-display-table-presentation-test-invalid");
      return {
        id: token(item.id, "science-display-table-presentation-test-invalid"),
        name: text(item.name, 500, "science-display-table-presentation-test-invalid"),
        tails: enumValue(item.tails, ["one", "two", "not-applicable"], "science-display-table-presentation-test-invalid"),
        statistic: text(item.statistic, 80, "science-display-table-presentation-test-invalid"),
        value: finite(item.value, -Number.MAX_VALUE, Number.MAX_VALUE, "science-display-table-presentation-test-invalid"),
        exactP,
        degreesOfFreedom: array(item.degreesOfFreedom, 1, 4, "science-display-table-presentation-test-invalid")
          .map((degree) => finite(degree, 0, Number.MAX_VALUE, "science-display-table-presentation-test-invalid")),
      };
    });
  if (new Set(tests.map((test) => test.id)).size !== tests.length) throw new Error("science-display-table-presentation-test-duplicate");

  let repeats: ScienceDisplayTableRepeatsDisclosure | null = null;
  if (statisticsValue.repeats !== null) {
    const item = record(statisticsValue.repeats, "science-display-table-presentation-repeats-invalid");
    exactKeys(item, ["count", "unit", "description"], "science-display-table-presentation-repeats-invalid");
    repeats = {
      count: integer(item.count, 1, Number.MAX_SAFE_INTEGER, "science-display-table-presentation-repeats-invalid"),
      unit: text(item.unit, 240, "science-display-table-presentation-repeats-invalid"),
      description: nullableText(item.description, 2_000, "science-display-table-presentation-repeats-invalid"),
    };
  }

  let errorBars: ScienceDisplayTableErrorBarsDisclosure | null = null;
  if (statisticsValue.errorBars !== null) {
    const item = record(statisticsValue.errorBars, "science-display-table-presentation-error-bars-invalid");
    exactKeys(item, ["meaning", "center", "interval"], "science-display-table-presentation-error-bars-invalid");
    errorBars = {
      meaning: text(item.meaning, 1_000, "science-display-table-presentation-error-bars-invalid"),
      center: text(item.center, 500, "science-display-table-presentation-error-bars-invalid"),
      interval: text(item.interval, 500, "science-display-table-presentation-error-bars-invalid"),
    };
  }

  const statistics: ScienceDisplayTableStatisticalDisclosure = {
    estimator: nullableText(statisticsValue.estimator, 1_000, "science-display-table-presentation-estimator-invalid"),
    uncertainty,
    sample,
    tests,
    repeats,
    errorBars,
  };
  const roles = new Set(cellRoles.map((entry) => entry.role));
  if ((roles.has("estimate") && statistics.estimator === null)
    || (roles.has("standard-error") && (!statistics.uncertainty || statistics.uncertainty.standardError === null))
    || (roles.has("statistic") && statistics.tests.length === 0)
    || (roles.has("model-summary") && statistics.sample === null)
    || (notes.some((note) => note.kind === "probability") && statistics.tests.length === 0)) {
    throw new Error("science-display-table-presentation-statistics-semantics-invalid");
  }

  const provenanceRefs = array(candidate.provenanceRefs, 1, SCIENCE_DISPLAY_TABLE_PRESENTATION_LIMITS.maxProvenanceRefs, "science-display-table-presentation-provenance-invalid")
    .map((entry): ScienceDisplayTableProvenanceReference => {
      const item = record(entry, "science-display-table-presentation-provenance-invalid");
      exactKeys(item, ["kind", "id", "sha256"], "science-display-table-presentation-provenance-invalid");
      return {
        kind: enumValue(item.kind, ["artifact", "dataset", "run", "analysis-plan", "source"], "science-display-table-presentation-provenance-invalid"),
        id: text(item.id, 1_000, "science-display-table-presentation-provenance-invalid"),
        sha256: hash(item.sha256, "science-display-table-presentation-provenance-invalid"),
      };
    });
  const provenanceKeys = provenanceRefs.map((item) => `${item.kind}:${item.id}:${item.sha256}`);
  if (new Set(provenanceKeys).size !== provenanceKeys.length) throw new Error("science-display-table-presentation-provenance-duplicate");

  return {
    schema: SCIENCE_DISPLAY_TABLE_PRESENTATION_SCHEMA,
    source,
    title: text(candidate.title, 500, "science-display-table-presentation-title-invalid"),
    legend: text(candidate.legend, 8_000, "science-display-table-presentation-legend-invalid"),
    numbering,
    layout,
    columnGroups,
    panels,
    cellRoles,
    notes,
    statistics,
    provenanceRefs,
  };
}

export function buildScienceDisplayTablePresentationV1(
  input: BuildScienceDisplayTablePresentationV1Input,
): ScienceDisplayTablePresentationV1 {
  const core = validateCore({ schema: SCIENCE_DISPLAY_TABLE_PRESENTATION_SCHEMA, ...input });
  const presentationSha256 = scienceDisplayTablePresentationSha256(core);
  return deepFreeze(clonePlain({ ...core, presentationSha256 }));
}

export function validateScienceDisplayTablePresentationV1(value: unknown): ScienceDisplayTablePresentationV1 {
  const candidate = record(value, "science-display-table-presentation-invalid");
  exactKeys(candidate, [
    "schema", "source", "title", "legend", "numbering", "layout", "columnGroups", "panels", "cellRoles", "notes", "statistics", "provenanceRefs", "presentationSha256",
  ], "science-display-table-presentation-invalid");
  const { presentationSha256, ...unsigned } = candidate;
  const core = validateCore(unsigned);
  const expected = scienceDisplayTablePresentationSha256(core);
  if (hash(presentationSha256, "science-display-table-presentation-hash-invalid") !== expected) {
    throw new Error("science-display-table-presentation-hash-mismatch");
  }
  return deepFreeze(clonePlain({ ...core, presentationSha256: expected }));
}
