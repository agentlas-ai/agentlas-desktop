/**
 * Narrowing a Data Table before it is projected: keep some rows, add one derived label column.
 *
 * The product's rule is that data reaches an analysis by projection from an exact immutable table,
 * never by anyone retyping numbers. That rule was enforced so strictly that the projection could
 * only map columns that already existed, and a live research director wrote the consequence out in
 * full:
 *
 *   "run_statistical_analysis cannot filter rows or derive columns. Its source_table projections map
 *    existing columns onto a method's declared shape. There is no group column in this table and no
 *    way to create one, and no way to apply a completeness magnitude cut. So the literal 'early
 *    epoch vs late epoch b-value' comparison is not executable on this table as it stands."
 *
 * It was right, and that shape of question -- compare two windows of the same series, after cutting
 * the part of the series that is not complete -- is most of applied science. A catalogue has one
 * time column and one magnitude column; the grouping the study needs is not in the file, it is a
 * decision about the file.
 *
 * So this adds exactly two bounded operations and nothing more:
 *
 *   - a row filter: one column, one comparison, one literal
 *   - a derived label column: one numeric column cut at one threshold into two named groups
 *
 * Neither invents a measurement. Every value in the result is either a cell that was already in the
 * table or a label computed from one by a rule that travels in the projection receipt, so the
 * analysis can be re-derived from the exact table version and the recorded rule. There is no
 * expression language here on purpose: the moment a caller can write arbitrary arithmetic, the
 * receipt stops being a description of what happened and becomes a program someone has to read.
 */

export type ScienceTableFilterOperator = ">=" | ">" | "<=" | "<" | "==" | "!=";

export interface ScienceTableFilter {
  readonly column: string;
  readonly op: ScienceTableFilterOperator;
  readonly value: number | string;
}

export interface ScienceTableDerivedCut {
  /** The new column's name. Must not collide with an existing column. */
  readonly as: string;
  /** The numeric column being cut. */
  readonly from: string;
  readonly threshold: number;
  /** Label for rows strictly below the threshold, and for the rest. */
  readonly below: string;
  readonly atOrAbove: string;
}

export interface ScienceTablePreparation {
  readonly filter?: ScienceTableFilter;
  readonly derive?: ScienceTableDerivedCut;
}

interface TableColumn { readonly name: string; readonly logicalType: string }
interface TableLike {
  readonly columns: readonly TableColumn[];
  readonly rows: ReadonlyArray<Record<string, unknown>>;
}

export interface ScienceTablePreparationResult {
  readonly table: TableLike;
  /** Exactly what was done, for the projection receipt. Null when nothing was asked for. */
  readonly receipt: {
    readonly filter: ScienceTableFilter | null;
    readonly derive: ScienceTableDerivedCut | null;
    readonly rowsBefore: number;
    readonly rowsAfter: number;
  } | null;
}

const OPERATORS: ReadonlySet<string> = new Set([">=", ">", "<=", "<", "==", "!="]);
const NUMERIC = new Set(["integer", "number"]);
const MAX_NAME = 240;

function fail(code: string): never {
  throw new Error(code);
}

function sanitise(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/gu, "-").slice(0, 60).toLowerCase() || "unnamed";
}

function columnOf(table: TableLike, name: string): TableColumn {
  const found = table.columns.find((entry) => entry.name === name);
  if (!found) fail(`science-statistics-preparation-column-missing-${sanitise(name)}`);
  return found;
}

function compare(cell: unknown, filter: ScienceTableFilter): boolean {
  if (typeof filter.value === "number") {
    if (typeof cell !== "number" || !Number.isFinite(cell)) return false;
    switch (filter.op) {
      case ">=": return cell >= filter.value;
      case ">": return cell > filter.value;
      case "<=": return cell <= filter.value;
      case "<": return cell < filter.value;
      case "==": return cell === filter.value;
      default: return cell !== filter.value;
    }
  }
  // A text comparison is equality only: ordering strings by locale is a decision this has no
  // business making on a researcher's behalf, and silently using code-point order would be worse.
  if (filter.op !== "==" && filter.op !== "!=") fail("science-statistics-preparation-text-order-unsupported");
  const text = typeof cell === "string" ? cell : null;
  return filter.op === "==" ? text === filter.value : text !== filter.value;
}

/**
 * Applies the preparation and reports what it did. Refuses rather than approximates: an unknown
 * column, a text column cut as if it were numeric, a derived name that already exists, or a filter
 * that removes every row are each a named error, because each of them would otherwise produce an
 * analysis of something the researcher did not ask for.
 */
export function prepareScienceTable(table: TableLike, preparation: ScienceTablePreparation | null | undefined): ScienceTablePreparationResult {
  const filter = preparation?.filter ?? null;
  const derive = preparation?.derive ?? null;
  if (!filter && !derive) return { table, receipt: null };

  if (filter) {
    if (typeof filter.column !== "string" || filter.column.length > MAX_NAME) fail("science-statistics-preparation-filter-invalid");
    if (!OPERATORS.has(filter.op)) fail("science-statistics-preparation-filter-operator-invalid");
    const column = columnOf(table, filter.column);
    if (typeof filter.value === "number") {
      if (!Number.isFinite(filter.value)) fail("science-statistics-preparation-filter-invalid");
      if (!NUMERIC.has(column.logicalType)) fail(`science-statistics-preparation-filter-not-numeric-${sanitise(filter.column)}`);
    } else if (typeof filter.value !== "string" || filter.value.length > MAX_NAME) {
      fail("science-statistics-preparation-filter-invalid");
    }
  }

  if (derive) {
    if (typeof derive.as !== "string" || !derive.as.trim() || derive.as.length > MAX_NAME) fail("science-statistics-preparation-derive-invalid");
    if (table.columns.some((entry) => entry.name === derive.as)) fail(`science-statistics-preparation-derive-name-taken-${sanitise(derive.as)}`);
    const source = columnOf(table, derive.from);
    if (!NUMERIC.has(source.logicalType)) fail(`science-statistics-preparation-derive-not-numeric-${sanitise(derive.from)}`);
    if (!Number.isFinite(derive.threshold)) fail("science-statistics-preparation-derive-invalid");
    for (const label of [derive.below, derive.atOrAbove]) {
      if (typeof label !== "string" || !label.trim() || label.length > MAX_NAME) fail("science-statistics-preparation-derive-invalid");
    }
    if (derive.below === derive.atOrAbove) fail("science-statistics-preparation-derive-labels-equal");
  }

  const kept = filter ? table.rows.filter((row) => compare(row[filter.column], filter)) : [...table.rows];
  // An empty table is not a result. Left unchecked this would run an analysis on nothing and report
  // whatever a zero-length sample produces, which reads as an answer.
  if (!kept.length) fail("science-statistics-preparation-filter-empty");

  const rows = derive
    ? kept.map((row) => {
      const value = row[derive.from];
      if (typeof value !== "number" || !Number.isFinite(value)) fail(`science-statistics-preparation-derive-not-finite-${sanitise(derive.from)}`);
      return { ...row, [derive.as]: value < derive.threshold ? derive.below : derive.atOrAbove };
    })
    : kept;

  const columns = derive ? [...table.columns, { name: derive.as, logicalType: "string" }] : [...table.columns];
  return {
    table: { columns, rows },
    receipt: { filter, derive, rowsBefore: table.rows.length, rowsAfter: rows.length },
  };
}
