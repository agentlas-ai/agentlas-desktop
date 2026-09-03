/**
 * Projecting an uploaded Data Table into the shape a statistical method declares it needs.
 *
 * The product's rule is that data reaches an analysis by projection from an exact immutable table,
 * never by an agent or a screen retyping numbers into a request. Until now that rule was honoured
 * by writing one bespoke projection per method, by hand, in the tool gateway -- and six had been
 * written. The engine registers 178 methods. So a researcher who uploaded a CSV could run six of
 * them; for the other 172 the only route was to inline the numbers, which the same rule forbids.
 * The methods existed and the data had no way to reach them.
 *
 * The way out is that every method already DECLARES the shape it needs, in its own `dataSchema`,
 * and the registry validates that declaration. Measured across the registry, those declarations
 * are not 178 different shapes -- they are a handful:
 *
 *   - 37 methods take flat arrays only (`values`, `x`, `y`, `group`), one table column each;
 *   - 45 take `[{ name, values }]` under six different property names (`groups`, `variables`,
 *     `predictors`, `conditions`, `items`, `factors`);
 *   - 19 take that same shape with optional `type` / `reference` metadata alongside.
 *
 * This projects against the declaration rather than against a method name, so a method that is
 * added later is reachable the day it is registered, without anyone remembering to write it a
 * projection. What it cannot express, it refuses by name -- an unsupported shape is reported, never
 * approximated, because a projection that guesses is the retyping this exists to prevent.
 */

export interface ScienceDeclaredColumnMapping {
  /** One table column feeding a flat array property. */
  readonly column?: string;
  /**
   * Several table columns feeding a `[{ name, values }]` property, one entry per column, the entry
   * name taken from the column name. This is the WIDE layout a researcher's spreadsheet usually
   * has: one column per factor, per rater, per instrument.
   */
  readonly columns?: readonly string[];
  /**
   * A LONG layout feeding the same property: one column carries the entry name, another the value,
   * and rows sharing a name become one entry. Entry order follows first appearance in the table,
   * never the alphabet -- for a dose study that order is the only thing that puts low before high.
   */
  readonly nameColumn?: string;
  readonly valueColumn?: string;
  /**
   * A long layout whose entries carry SEVERAL parallel arrays rather than one `values`: survival
   * groups are `[{ name, time, event }]`, and a researcher's survival sheet is one row per subject
   * with a time column, an event column and an arm column. `nameColumn` splits the arms;
   * `valueColumns` says which column fills each declared field.
   */
  readonly valueColumns?: Readonly<Record<string, string>>;
  /**
   * One entry per table ROW, each declared field taken from a named column: `{ effect: "d",
   * standardError: "se", label: "study" }`. This is how a meta-analysis sheet, a Gage R&R log or a
   * panel of returns is actually laid out -- one row per study, per measurement, per period.
   */
  readonly rowColumns?: Readonly<Record<string, string>>;
  /**
   * A literal value for a declared property that is a PARAMETER rather than data -- a cutoff, a
   * confidence level, a label. It is carried in the projection receipt like everything else, so a
   * number the researcher chose is recorded as chosen and not mistaken for a measurement.
   */
  readonly value?: number | string | boolean;
  /**
   * A chosen LIST for a declared property that is a set of options rather than data -- which
   * distributions to fit, which corrections to apply. No column of a researcher's table holds it,
   * and without this the method could not be run from a table at all.
   */
  readonly choices?: readonly string[];
}

export type ScienceDeclaredProjectionAccepts = "column" | "columns-or-long" | "grouped-columns" | "matrix-columns" | "row-columns" | "value" | "choice-list" | null;

export interface ScienceDeclaredProjection {
  readonly data: Record<string, unknown>;
  /** What each declared property was built from, for the projection receipt. */
  readonly columns: Record<string, unknown>;
  /** Every table row that contributed, with its index, so the receipt can hash exactly what was used. */
  readonly includedRows: ReadonlyArray<Record<string, unknown>>;
}

interface TableColumn { readonly name: string; readonly logicalType: string }
interface TableLike {
  readonly columns: readonly TableColumn[];
  readonly rows: ReadonlyArray<Record<string, unknown>>;
}

export interface ScienceDeclaredSchemaNode {
  readonly type?: string;
  readonly items?: ScienceDeclaredSchemaNode;
  readonly properties?: Record<string, ScienceDeclaredSchemaNode>;
  readonly required?: readonly string[];
  readonly minItems?: number;
  readonly maxItems?: number;
  /** The options a choice-list property declares. */
  readonly enum?: readonly unknown[];
  /**
   * How many DISTINCT values a label column must carry: a random-intercept model needs at least
   * five groups, and "an array of strings with 12 entries" does not say that. Not enforced here --
   * the method enforces it -- but declared so the screen can say it and a generator can honour it.
   */
  readonly minDistinct?: number;
}

const NUMERIC_LOGICAL_TYPES = new Set(["integer", "number"]);

function fail(code: string): never {
  throw new Error(code);
}

function column(table: TableLike, name: string): TableColumn {
  const found = table.columns.find((entry) => entry.name === name);
  if (!found) fail(`science-statistics-declared-column-missing-${sanitise(name)}`);
  return found;
}

/** Column names reach an error message, so they are reduced to a safe token first. */
function sanitise(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/gu, "-").slice(0, 60).toLowerCase() || "unnamed";
}

function numericValues(table: TableLike, name: string, into: Array<Record<string, unknown>>): number[] {
  if (!NUMERIC_LOGICAL_TYPES.has(column(table, name).logicalType)) fail(`science-statistics-declared-column-not-numeric-${sanitise(name)}`);
  return table.rows.map((row, rowIndex) => {
    const value = row[name];
    // A null is not a zero and not a skip. The bespoke projections refuse it by row, and so does
    // this one: silently dropping a row changes the sample the analysis reports on.
    if (typeof value !== "number" || !Number.isFinite(value)) fail(`science-statistics-declared-row-${rowIndex}-not-finite-${sanitise(name)}`);
    into.push({ rowIndex, column: name, value });
    return value;
  });
}

function textValues(table: TableLike, name: string, into: Array<Record<string, unknown>>): string[] {
  if (column(table, name).logicalType !== "string") fail(`science-statistics-declared-column-not-text-${sanitise(name)}`);
  return table.rows.map((row, rowIndex) => {
    const value = row[name];
    if (typeof value !== "string" || !value.length || value.length > 240) fail(`science-statistics-declared-row-${rowIndex}-not-text-${sanitise(name)}`);
    into.push({ rowIndex, column: name, value });
    return value;
  });
}

/**
 * A named series: an array of entries that each carry a label and an array of values.
 *
 * The label is NOT always called `name`. Rater agreement methods declare `[{ rater, values }]`,
 * which is the same shape wearing a different word, and hard-coding `name` left three methods
 * unreachable for a spelling. The label is whichever single string-typed property sits beside
 * `values`.
 */
function namedSeriesLabelField(node: ScienceDeclaredSchemaNode | undefined): string | null {
  if (!node || node.type !== "array" || node.items?.type !== "object") return null;
  const properties = node.items.properties ?? {};
  if (properties.values?.type !== "array") return null;
  // `name` when the shape uses it -- most do, and several of those carry other string fields
  // (`reference`, `type`) that are metadata rather than the label. Otherwise the single string
  // property beside `values` is the label, which is how the rater shapes spell it.
  if (properties.name?.type === "string") return "name";
  const labels = Object.entries(properties).filter(([key, child]) => key !== "values" && child.type === "string");
  return labels.length === 1 ? labels[0][0] : null;
}

function isNamedSeriesArray(node: ScienceDeclaredSchemaNode | undefined): boolean {
  return namedSeriesLabelField(node) !== null;
}

/**
 * A grouped series: entries carrying a label and SEVERAL parallel numeric arrays, e.g.
 * `[{ name, time, event }]`. Distinct from a named series, whose single array is called `values`;
 * that case is left to the named-series branch so existing shapes keep their behaviour.
 */
function groupedSeriesFields(node: ScienceDeclaredSchemaNode | undefined): { label: string; fields: string[] } | null {
  if (!node || node.type !== "array" || node.items?.type !== "object") return null;
  const properties = node.items.properties ?? {};
  if (properties.values?.type === "array") return null;
  const fields = Object.entries(properties).filter(([, child]) => child.type === "array"
    && ["number", "integer"].includes(String(Array.isArray(child.items?.type) ? child.items?.type[0] : child.items?.type)));
  const labels = Object.entries(properties).filter(([, child]) => child.type === "string");
  if (fields.length < 2 || labels.length !== 1) return null;
  return { label: labels[0][0], fields: fields.map(([key]) => key) };
}

function isFlatArray(node: ScienceDeclaredSchemaNode | undefined): "number" | "string" | null {
  if (!node || node.type !== "array" || !node.items) return null;
  // A union item type ( `["number", "string"]` ) is common for an identifier column that may be
  // either. Treat it by its first accepted primitive rather than refusing the whole property.
  const itemType = Array.isArray(node.items.type) ? node.items.type[0] : node.items.type;
  if (itemType === "number" || itemType === "integer") return "number";
  if (itemType === "string") return "string";
  return null;
}

/** An array of row objects with named fields, none of which is a nested array. */
function isRowObjectArray(node: ScienceDeclaredSchemaNode | undefined): boolean {
  if (!node || node.type !== "array" || node.items?.type !== "object") return false;
  const properties = node.items.properties ?? {};
  const entries = Object.values(properties);
  return entries.length > 0 && entries.every((child) => child.type !== "array" && child.type !== "object");
}

/**
 * A count matrix: an array of arrays of numbers. Contingency methods declare their cross-tab this
 * way, and a researcher's sheet holds it as one column per matrix column, one row per matrix row --
 * which is exactly what a cross-tab looks like in a spreadsheet.
 */
function isNumericMatrix(node: ScienceDeclaredSchemaNode | undefined): boolean {
  if (!node || node.type !== "array" || node.items?.type !== "array") return false;
  const inner = Array.isArray(node.items.items?.type) ? node.items.items?.type[0] : node.items.items?.type;
  return inner === "number" || inner === "integer";
}

/**
 * A declared property that is a fixed set of options: an array of strings with a declared `enum`.
 * Checked BEFORE the flat-column test, which would otherwise offer a text column for it.
 */
function choiceOptions(node: ScienceDeclaredSchemaNode | undefined): string[] | null {
  if (!node || node.type !== "array" || node.items?.type !== "string") return null;
  const options = node.items.enum;
  return Array.isArray(options) && options.length > 0 && options.every((option) => typeof option === "string")
    ? options.map(String) : null;
}

/** A declared property that is a single parameter rather than a series. */
function isScalar(node: ScienceDeclaredSchemaNode | undefined): boolean {
  const type = Array.isArray(node?.type) ? node?.type[0] : node?.type;
  return type === "number" || type === "integer" || type === "string" || type === "boolean";
}

function assertCount(count: number, node: ScienceDeclaredSchemaNode | undefined, property: string, label: string): void {
  if (node?.minItems !== undefined && count < node.minItems) fail(`science-statistics-declared-${label}-too-few-${sanitise(property)}`);
  if (node?.maxItems !== undefined && count > node.maxItems) fail(`science-statistics-declared-${label}-too-many-${sanitise(property)}`);
}

/**
 * Builds the `data` object a method's `dataSchema` declares, from an exact table and a column
 * mapping. Refuses rather than approximates: an unmapped required property, an unknown property, a
 * column of the wrong type, a shape this cannot express -- each is a named error.
 */
export function projectScienceDeclaredColumns(
  dataSchema: ScienceDeclaredSchemaNode | undefined,
  table: TableLike,
  mapping: Readonly<Record<string, ScienceDeclaredColumnMapping>>,
): ScienceDeclaredProjection {
  const properties = dataSchema?.properties;
  if (!dataSchema || dataSchema.type !== "object" || !properties) fail("science-statistics-declared-schema-unsupported");
  const required = new Set(dataSchema.required ?? []);
  const mapped = Object.keys(mapping);
  if (!mapped.length || mapped.length > 48) fail("science-statistics-declared-mapping-invalid");
  for (const property of mapped) if (!properties[property]) fail(`science-statistics-declared-property-unknown-${sanitise(property)}`);
  for (const property of required) if (!mapped.includes(property)) fail(`science-statistics-declared-property-unmapped-${sanitise(property)}`);

  const includedRows: Array<Record<string, unknown>> = [];
  const data: Record<string, unknown> = {};
  const columns: Record<string, unknown> = {};

  for (const property of mapped) {
    const node = properties[property];
    const spec = mapping[property];
    const flat = isFlatArray(node);
    if (spec.column !== undefined) {
      if (!flat) fail(`science-statistics-declared-property-not-flat-${sanitise(property)}`);
      const values = flat === "number" ? numericValues(table, spec.column, includedRows) : textValues(table, spec.column, includedRows);
      assertCount(values.length, node, property, "rows");
      data[property] = values;
      columns[property] = { column: spec.column };
      continue;
    }
    if (spec.columns !== undefined && isNumericMatrix(node)) {
      if (!spec.columns.length || spec.columns.length > 64) fail(`science-statistics-declared-columns-invalid-${sanitise(property)}`);
      if (new Set(spec.columns).size !== spec.columns.length) fail(`science-statistics-declared-columns-duplicated-${sanitise(property)}`);
      const byColumn = spec.columns.map((name) => numericValues(table, name, includedRows));
      // Row-major: one matrix row per table row, one entry per chosen column, which is how the
      // cross-tab reads on the researcher's sheet.
      const matrix = table.rows.map((_row, rowIndex) => byColumn.map((values) => values[rowIndex]));
      assertCount(matrix.length, node, property, "rows");
      for (const row of matrix) assertCount(row.length, node.items, property, "entries");
      data[property] = matrix;
      columns[property] = { columns: [...spec.columns] };
      continue;
    }
    if (spec.columns !== undefined) {
      if (!isNamedSeriesArray(node)) fail(`science-statistics-declared-property-not-series-${sanitise(property)}`);
      if (!spec.columns.length || spec.columns.length > 64) fail(`science-statistics-declared-columns-invalid-${sanitise(property)}`);
      if (new Set(spec.columns).size !== spec.columns.length) fail(`science-statistics-declared-columns-duplicated-${sanitise(property)}`);
      const labelField = namedSeriesLabelField(node) ?? "name";
      const entries = spec.columns.map((name) => {
        const values = numericValues(table, name, includedRows);
        assertCount(values.length, node.items?.properties?.values, property, "rows");
        return { [labelField]: name, values };
      });
      assertCount(entries.length, node, property, "entries");
      data[property] = entries;
      columns[property] = { columns: [...spec.columns] };
      continue;
    }
    if (spec.nameColumn !== undefined && spec.valueColumn !== undefined) {
      if (!isNamedSeriesArray(node)) fail(`science-statistics-declared-property-not-series-${sanitise(property)}`);
      if (spec.nameColumn === spec.valueColumn) fail(`science-statistics-declared-long-columns-equal-${sanitise(property)}`);
      const names = textValues(table, spec.nameColumn, includedRows);
      const values = numericValues(table, spec.valueColumn, includedRows);
      // Insertion order, not sorted order: the table's own order is the researcher's ordering.
      const grouped = new Map<string, number[]>();
      names.forEach((name, index) => {
        const bucket = grouped.get(name) ?? [];
        bucket.push(values[index]);
        grouped.set(name, bucket);
      });
      const labelField = namedSeriesLabelField(node) ?? "name";
      const entries = [...grouped.entries()].map(([name, entryValues]) => {
        assertCount(entryValues.length, node.items?.properties?.values, property, "rows");
        return { [labelField]: name, values: entryValues };
      });
      assertCount(entries.length, node, property, "entries");
      data[property] = entries;
      columns[property] = { nameColumn: spec.nameColumn, valueColumn: spec.valueColumn };
      continue;
    }
    if (spec.valueColumns !== undefined) {
      const grouped = groupedSeriesFields(node);
      if (!grouped) fail(`science-statistics-declared-property-not-grouped-${sanitise(property)}`);
      if (spec.nameColumn === undefined) fail(`science-statistics-declared-grouped-name-missing-${sanitise(property)}`);
      const fields = Object.entries(spec.valueColumns);
      if (!fields.length || fields.length > 32) fail(`science-statistics-declared-grouped-columns-invalid-${sanitise(property)}`);
      for (const [field] of fields) if (!grouped.fields.includes(field)) fail(`science-statistics-declared-grouped-field-unknown-${sanitise(property)}-${sanitise(field)}`);
      for (const field of new Set(node.items?.required ?? [])) {
        if (field !== grouped.label && !spec.valueColumns[field]) fail(`science-statistics-declared-grouped-field-unmapped-${sanitise(property)}-${sanitise(field)}`);
      }
      const names = textValues(table, spec.nameColumn, includedRows);
      const perField = new Map(fields.map(([field, name]) => [field, numericValues(table, name, includedRows)]));
      // Insertion order again: the arm the researcher listed first stays first, which is what the
      // reference arm of a survival plot means.
      const order: string[] = [];
      const buckets = new Map<string, Record<string, number[]>>();
      names.forEach((name, index) => {
        let bucket = buckets.get(name);
        if (!bucket) { bucket = Object.fromEntries(fields.map(([field]) => [field, [] as number[]])); buckets.set(name, bucket); order.push(name); }
        for (const [field] of fields) bucket[field].push(perField.get(field)![index]);
      });
      const entries = order.map((name) => {
        const bucket = buckets.get(name)!;
        for (const [field] of fields) assertCount(bucket[field].length, node.items?.properties?.[field], property, "rows");
        return { [grouped.label]: name, ...bucket };
      });
      assertCount(entries.length, node, property, "entries");
      data[property] = entries;
      columns[property] = { nameColumn: spec.nameColumn, valueColumns: { ...spec.valueColumns } };
      continue;
    }
    if (spec.rowColumns !== undefined) {
      if (!isRowObjectArray(node)) fail(`science-statistics-declared-property-not-rows-${sanitise(property)}`);
      const fields = Object.entries(spec.rowColumns);
      if (!fields.length || fields.length > 32) fail(`science-statistics-declared-row-columns-invalid-${sanitise(property)}`);
      const itemProperties = node.items?.properties ?? {};
      const itemRequired = new Set(node.items?.required ?? []);
      for (const [field] of fields) if (!itemProperties[field]) fail(`science-statistics-declared-row-field-unknown-${sanitise(property)}-${sanitise(field)}`);
      for (const field of itemRequired) if (!spec.rowColumns[field]) fail(`science-statistics-declared-row-field-unmapped-${sanitise(property)}-${sanitise(field)}`);
      const projected = table.rows.map((row, rowIndex) => {
        const entry: Record<string, unknown> = {};
        for (const [field, name] of fields) {
          const declared = itemProperties[field];
          const declaredType = Array.isArray(declared.type) ? declared.type[0] : declared.type;
          const value = row[name];
          if (declaredType === "string") {
            if (typeof value !== "string" || !value.length || value.length > 240) fail(`science-statistics-declared-row-${rowIndex}-not-text-${sanitise(name)}`);
          } else if (typeof value !== "number" || !Number.isFinite(value)) {
            fail(`science-statistics-declared-row-${rowIndex}-not-finite-${sanitise(name)}`);
          }
          entry[field] = value;
          includedRows.push({ rowIndex, column: name, value });
        }
        return entry;
      });
      assertCount(projected.length, node, property, "entries");
      data[property] = projected;
      columns[property] = { rowColumns: { ...spec.rowColumns } };
      continue;
    }
    if (spec.choices !== undefined) {
      const options = choiceOptions(node);
      if (!options) fail(`science-statistics-declared-property-not-choices-${sanitise(property)}`);
      const chosen = [...spec.choices];
      if (!chosen.length || new Set(chosen).size !== chosen.length) fail(`science-statistics-declared-choices-invalid-${sanitise(property)}`);
      for (const choice of chosen) if (!options.includes(choice)) fail(`science-statistics-declared-choice-unknown-${sanitise(property)}`);
      assertCount(chosen.length, node, property, "entries");
      data[property] = chosen;
      columns[property] = { choices: chosen };
      continue;
    }
    if (spec.value !== undefined) {
      if (!isScalar(node)) fail(`science-statistics-declared-property-not-scalar-${sanitise(property)}`);
      const declaredType = Array.isArray(node.type) ? node.type[0] : node.type;
      const matches = declaredType === "string" ? typeof spec.value === "string"
        : declaredType === "boolean" ? typeof spec.value === "boolean"
          : typeof spec.value === "number" && Number.isFinite(spec.value);
      if (!matches) fail(`science-statistics-declared-value-type-${sanitise(property)}`);
      data[property] = spec.value;
      columns[property] = { value: spec.value };
      continue;
    }
    fail(`science-statistics-declared-mapping-incomplete-${sanitise(property)}`);
  }
  return { data, columns, includedRows };
}

/**
 * Whether a method's declared shape can be projected from a table at all, and what each property
 * would need. Used to report reachability honestly -- a method this cannot serve is named, not
 * quietly counted as covered.
 */
export function scienceDeclaredProjectionSupport(dataSchema: ScienceDeclaredSchemaNode | undefined): {
  supported: boolean;
  properties: Array<{ property: string; required: boolean; accepts: ScienceDeclaredProjectionAccepts }>;
} {
  const properties = dataSchema?.properties;
  if (!dataSchema || dataSchema.type !== "object" || !properties) return { supported: false, properties: [] };
  const required = new Set(dataSchema.required ?? []);
  const described = Object.entries(properties).map(([property, node]) => ({
    property,
    required: required.has(property),
    accepts: (choiceOptions(node) ? "choice-list"
      : isFlatArray(node) ? "column"
      : isNumericMatrix(node) ? "matrix-columns"
        : isNamedSeriesArray(node) ? "columns-or-long"
        : groupedSeriesFields(node) ? "grouped-columns"
          : isRowObjectArray(node) ? "row-columns"
            : isScalar(node) ? "value" : null) as ScienceDeclaredProjectionAccepts,
  }));
  // A method is reachable when every REQUIRED property can be projected. Optional properties this
  // cannot express are simply left unmapped, which is what "optional" means.
  const supported = described.filter((entry) => entry.required).every((entry) => entry.accepts !== null)
    && described.some((entry) => entry.accepts !== null);
  return { supported, properties: described };
}
