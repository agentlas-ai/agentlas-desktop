"use strict";

// Shared numerics, validation, and figure/table builders for the Physics
// analysis catalogue. Every analysis module in this directory depends on this
// file only (plus physics.cjs for the error class, hashing, and the incomplete
// gamma function that the chi-square tool already exposes).

const { PhysicsError, sha256, stableStringify, regularizedGammaQ, logGamma } = require("./physics.cjs");

const MAX_ANALYSIS_BYTES = 4 * 1024 * 1024;
const MAX_POINTS = 10_000;

// ---------------------------------------------------------------------------
// Validation helpers (fail closed; every error carries a machine-readable code)
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactObject(value, allowed, label) {
  if (!isPlainObject(value)) throw new PhysicsError(`${label}-invalid`, `${label} must be a plain object`);
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new PhysicsError(`${label}-unknown-field`, `${label}: unknown field ${extras[0]}`);
  return value;
}

function text(value, min, max, label) {
  if (typeof value !== "string") throw new PhysicsError(`${label}-invalid`, `${label} must be a string`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) throw new PhysicsError(`${label}-invalid`, `${label} length or characters are invalid`);
  return normalized;
}

function optionalText(value, max, label) {
  if (value === undefined || value === null || value === "") return null;
  return text(String(value), 1, max, label);
}

function enumText(value, allowed, label) {
  const normalized = text(value, 1, 64, label);
  if (!allowed.includes(normalized)) throw new PhysicsError(`${label}-invalid`, `${label} must be one of ${allowed.join(", ")}`);
  return normalized;
}

function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw new PhysicsError(`${label}-invalid`, `${label} must be an integer in [${min}, ${max}]`);
  return value;
}

function optionalInteger(value, min, max, label, fallback) {
  return value === undefined || value === null ? fallback : integer(value, min, max, label);
}

function finite(value, min, max, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new PhysicsError(`${label}-invalid`, `${label} must be a finite number in [${min}, ${max}]`);
  return Object.is(value, -0) ? 0 : value;
}

function optionalFinite(value, min, max, label, fallback) {
  return value === undefined || value === null ? fallback : finite(value, min, max, label);
}

function boolean(value, label, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new PhysicsError(`${label}-invalid`, `${label} must be boolean`);
  return value;
}

function finiteArray(value, minLength, maxLength, label, min = -Number.MAX_VALUE, max = Number.MAX_VALUE) {
  if (!Array.isArray(value) || value.length < minLength || value.length > maxLength) throw new PhysicsError(`${label}-invalid`, `${label} must be an array with ${minLength}..${maxLength} numbers`);
  return value.map((entry, index) => finite(entry, min, max, `${label}-${index}`));
}

function sameLength(label, ...arrays) {
  const length = arrays[0].length;
  if (arrays.some((entry) => entry.length !== length)) throw new PhysicsError(`${label}-length-mismatch`, `${label}: arrays must have equal length`);
  return length;
}

// ---------------------------------------------------------------------------
// Bounded science table input (the physics dataset artifact projection)
// ---------------------------------------------------------------------------

function verifiedScienceTable(value, label = "physics-analysis-table") {
  const table = exactObject(value, ["schema", "title", "columns", "rows"], label);
  if (table.schema !== "agentlas.science-table/v1") throw new PhysicsError(`${label}-schema-invalid`);
  if (!Array.isArray(table.columns) || table.columns.length < 1 || table.columns.length > 64) throw new PhysicsError(`${label}-columns-invalid`);
  const columns = table.columns.map((column, index) => {
    const item = exactObject(column, ["id", "name", "type", "unit"], `${label}-column`);
    const type = item.type;
    if (type !== "number" && type !== "string") throw new PhysicsError(`${label}-column-type-invalid`);
    return { id: text(item.id, 1, 32, `${label}-column-id`), name: text(item.name, 1, 160, `${label}-column-name`), type, unit: optionalText(item.unit, 120, `${label}-column-unit`), index };
  });
  if (new Set(columns.map((column) => column.name)).size !== columns.length) throw new PhysicsError(`${label}-column-name-duplicate`);
  if (!Array.isArray(table.rows) || table.rows.length > MAX_POINTS) throw new PhysicsError(`${label}-rows-invalid`);
  const rows = table.rows.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== columns.length) throw new PhysicsError(`${label}-row-width-invalid`, `row ${rowIndex} width mismatch`);
    return row.map((cell, columnIndex) => {
      if (cell === null) return null;
      if (columns[columnIndex].type === "number") return finite(cell, -Number.MAX_VALUE, Number.MAX_VALUE, `${label}-cell`);
      if (typeof cell !== "string" || cell.length > 2_000) throw new PhysicsError(`${label}-cell-invalid`);
      return cell;
    });
  });
  return { title: text(table.title, 1, 500, `${label}-title`), columns, rows };
}

function numericColumn(table, name, label, { allowMissing = false } = {}) {
  const columnName = text(name, 1, 160, label);
  const column = table.columns.find((entry) => entry.name === columnName);
  if (!column) throw new PhysicsError(`${label}-not-found`, `Column "${columnName}" does not exist in the dataset`);
  if (column.type !== "number") throw new PhysicsError(`${label}-not-numeric`, `Column "${columnName}" is not numeric`);
  const values = table.rows.map((row) => row[column.index]);
  if (!allowMissing && values.some((entry) => entry === null)) throw new PhysicsError(`${label}-missing-values`, `Column "${columnName}" contains missing cells; drop or fill them explicitly before analysis`);
  return { column, values };
}

// ---------------------------------------------------------------------------
// Special functions
// ---------------------------------------------------------------------------

function regularizedGammaP(shape, value) { return 1 - regularizedGammaQ(shape, value); }

// erfc(x) = Q(1/2, x^2) for x >= 0; the incomplete gamma routine converges to
// ~1e-14 relative precision, which the significance oracles verify.
function erfc(x) {
  if (!Number.isFinite(x)) throw new PhysicsError("physics-erfc-input-invalid");
  if (x === 0) return 1;
  const tail = regularizedGammaQ(0.5, x * x);
  return x > 0 ? tail : 2 - tail;
}

function erf(x) { return 1 - erfc(x); }
function normalCdf(z) { return 0.5 * erfc(-z / Math.SQRT2); }
function normalSurvival(z) { return 0.5 * erfc(z / Math.SQRT2); }
function normalPdf(z) { return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI); }

// Acklam's rational approximation refined by two Halley steps against the
// accurate CDF above; the refinement removes the 1e-9 residual of the seed.
function normalQuantile(p) {
  if (!(p > 0 && p < 1)) throw new PhysicsError("physics-normal-quantile-input-invalid", "probability must lie strictly inside (0, 1)");
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  let x;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - low) {
    const q = p - 0.5;
    const r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  for (let step = 0; step < 2; step += 1) {
    const error = normalCdf(x) - p;
    const density = normalPdf(x);
    if (density <= 0) break;
    const u = error / density;
    x -= u / (1 + x * u / 2);
  }
  return x;
}

function chiSquareSurvival(chiSquare, degreesOfFreedom) {
  if (degreesOfFreedom <= 0) throw new PhysicsError("physics-degrees-of-freedom-invalid");
  return regularizedGammaQ(degreesOfFreedom / 2, chiSquare / 2);
}

// Complete elliptic integral of the first kind via the arithmetic-geometric mean.
function completeEllipticK(k) {
  if (!(k >= 0 && k < 1)) throw new PhysicsError("physics-elliptic-modulus-invalid");
  let a = 1;
  let b = Math.sqrt(1 - k * k);
  for (let index = 0; index < 60 && Math.abs(a - b) > 1e-16 * a; index += 1) {
    const next = (a + b) / 2;
    b = Math.sqrt(a * b);
    a = next;
  }
  return Math.PI / (2 * a);
}

// ---------------------------------------------------------------------------
// Dense linear algebra for small systems (parameter counts <= 64)
// ---------------------------------------------------------------------------

function zeros(rows, columns) { return Array.from({ length: rows }, () => new Array(columns).fill(0)); }
function identity(size) { const out = zeros(size, size); for (let index = 0; index < size; index += 1) out[index][index] = 1; return out; }
function transpose(matrix) { return matrix.length === 0 ? [] : matrix[0].map((_, column) => matrix.map((row) => row[column])); }
function multiply(left, right) {
  const inner = right.length;
  const out = zeros(left.length, right[0]?.length ?? 0);
  for (let i = 0; i < left.length; i += 1) for (let k = 0; k < inner; k += 1) {
    const value = left[i][k];
    if (value === 0) continue;
    for (let j = 0; j < out[i].length; j += 1) out[i][j] += value * right[k][j];
  }
  return out;
}
function matVec(matrix, vector) { return matrix.map((row) => row.reduce((sum, value, index) => sum + value * vector[index], 0)); }
function dot(left, right) { return left.reduce((sum, value, index) => sum + value * right[index], 0); }

// Gauss-Jordan with partial pivoting; throws when the matrix is singular to
// working precision (relative pivot below 1e-300).
function invertMatrix(matrix, label = "physics-matrix") {
  const size = matrix.length;
  const work = matrix.map((row, index) => [...row, ...identity(size)[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) if (Math.abs(work[row][column]) > Math.abs(work[pivot][column])) pivot = row;
    if (!(Math.abs(work[pivot][column]) > 1e-300)) throw new PhysicsError(`${label}-singular`, "matrix is singular to working precision");
    [work[column], work[pivot]] = [work[pivot], work[column]];
    const scale = work[column][column];
    for (let j = 0; j < 2 * size; j += 1) work[column][j] /= scale;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = work[row][column];
      if (factor === 0) continue;
      for (let j = 0; j < 2 * size; j += 1) work[row][j] -= factor * work[column][j];
    }
  }
  const inverse = work.map((row) => row.slice(size));
  if (inverse.some((row) => row.some((value) => !Number.isFinite(value)))) throw new PhysicsError(`${label}-singular`);
  return inverse;
}

function solveLinear(matrix, vector, label = "physics-linear-system") {
  const size = matrix.length;
  const work = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) if (Math.abs(work[row][column]) > Math.abs(work[pivot][column])) pivot = row;
    if (!(Math.abs(work[pivot][column]) > 1e-300)) throw new PhysicsError(`${label}-singular`, "linear system is singular to working precision");
    [work[column], work[pivot]] = [work[pivot], work[column]];
    for (let row = column + 1; row < size; row += 1) {
      const factor = work[row][column] / work[column][column];
      if (factor === 0) continue;
      for (let j = column; j <= size; j += 1) work[row][j] -= factor * work[column][j];
    }
  }
  const solution = new Array(size).fill(0);
  for (let row = size - 1; row >= 0; row -= 1) {
    let sum = work[row][size];
    for (let j = row + 1; j < size; j += 1) sum -= work[row][j] * solution[j];
    solution[row] = sum / work[row][row];
  }
  if (solution.some((value) => !Number.isFinite(value))) throw new PhysicsError(`${label}-singular`);
  return solution;
}

function cholesky(matrix, label = "physics-covariance") {
  const size = matrix.length;
  const lower = zeros(size, size);
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = matrix[i][j];
      for (let k = 0; k < j; k += 1) sum -= lower[i][k] * lower[j][k];
      if (i === j) {
        if (!(sum > 0)) throw new PhysicsError(`${label}-not-positive-definite`, "matrix is not positive definite");
        lower[i][i] = Math.sqrt(sum);
      } else lower[i][j] = sum / lower[j][j];
    }
  }
  return lower;
}

function correlationFromCovariance(covariance) {
  return covariance.map((row, i) => row.map((value, j) => {
    const denominator = Math.sqrt(covariance[i][i] * covariance[j][j]);
    return denominator > 0 ? value / denominator : (i === j ? 1 : 0);
  }));
}

// Weighted linear least squares y ~ design * beta with weights 1/sigma^2.
// Returns parameters, covariance (JᵀWJ)⁻¹, chi-square, and residuals.
function weightedLinearLeastSquares(design, y, sigma, label = "physics-linear-fit") {
  const n = y.length;
  const p = design[0].length;
  if (n <= p) throw new PhysicsError(`${label}-underdetermined`, `at least ${p + 1} points are required for ${p} parameters`);
  const weights = sigma.map((value) => {
    if (!(value > 0)) throw new PhysicsError(`${label}-sigma-invalid`, "uncertainties must be positive");
    return 1 / (value * value);
  });
  const normal = zeros(p, p);
  const rhs = new Array(p).fill(0);
  for (let row = 0; row < n; row += 1) {
    for (let i = 0; i < p; i += 1) {
      rhs[i] += weights[row] * design[row][i] * y[row];
      for (let j = 0; j < p; j += 1) normal[i][j] += weights[row] * design[row][i] * design[row][j];
    }
  }
  const covariance = invertMatrix(normal, label);
  const parameters = matVec(covariance, rhs);
  const fitted = design.map((row) => dot(row, parameters));
  const residuals = y.map((value, index) => value - fitted[index]);
  const chiSquare = residuals.reduce((sum, value, index) => sum + weights[index] * value * value, 0);
  return { parameters, covariance, fitted, residuals, chiSquare, degreesOfFreedom: n - p };
}

// ---------------------------------------------------------------------------
// Deterministic pseudo-random numbers (xoshiro128** seeded by splitmix32)
// ---------------------------------------------------------------------------

function createRandom(seed) {
  let state = seed >>> 0;
  const splitmix = () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
  let s0 = splitmix(); let s1 = splitmix(); let s2 = splitmix(); let s3 = splitmix();
  if ((s0 | s1 | s2 | s3) === 0) s0 = 1;
  const rotl = (value, k) => ((value << k) | (value >>> (32 - k))) >>> 0;
  const nextUint32 = () => {
    const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3; s2 ^= t; s3 = rotl(s3, 11);
    return result;
  };
  // 53-bit uniform in (0, 1).
  const uniform = () => {
    const high = nextUint32() >>> 5;
    const low = nextUint32() >>> 6;
    const value = (high * 67108864 + low) / 9007199254740992;
    return value === 0 ? 5e-324 : value;
  };
  let spare = null;
  const normal = () => {
    if (spare !== null) { const value = spare; spare = null; return value; }
    const u1 = uniform();
    const u2 = uniform();
    const radius = Math.sqrt(-2 * Math.log(u1));
    spare = radius * Math.sin(2 * Math.PI * u2);
    return radius * Math.cos(2 * Math.PI * u2);
  };
  return { uniform, normal, nextUint32 };
}

// ---------------------------------------------------------------------------
// Descriptive statistics
// ---------------------------------------------------------------------------

function mean(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function sampleStandardDeviation(values, center = mean(values)) {
  if (values.length < 2) return 0;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1));
}
function quantile(sorted, probability) {
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.min(sorted.length - 1, lower + 1);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

// ---------------------------------------------------------------------------
// Numerical integration (composite Simpson on a uniform grid)
// ---------------------------------------------------------------------------

function simpson(fn, a, b, intervals = 2000) {
  const n = intervals % 2 === 0 ? intervals : intervals + 1;
  const h = (b - a) / n;
  let sum = fn(a) + fn(b);
  for (let index = 1; index < n; index += 1) sum += (index % 2 === 0 ? 2 : 4) * fn(a + index * h);
  return sum * h / 3;
}

function linspace(start, stop, count) {
  if (count < 2) return [start];
  return Array.from({ length: count }, (_, index) => start + (stop - start) * index / (count - 1));
}

// ---------------------------------------------------------------------------
// Publication tables and Vega v5 figures
// ---------------------------------------------------------------------------

function scienceTable(title, columns, rows) {
  const seen = new Set();
  const normalizedColumns = columns.map((column) => {
    if (seen.has(column.id)) throw new PhysicsError("physics-table-column-duplicate", column.id);
    seen.add(column.id);
    return { id: column.id, label: column.label, type: column.type ?? "number", unit: column.unit ?? null };
  });
  if (rows.some((row) => row.length !== normalizedColumns.length)) throw new PhysicsError("physics-table-row-width-invalid");
  if (rows.length > MAX_POINTS) throw new PhysicsError("physics-table-too-many-rows");
  return { schema: "agentlas.science-table/v1", title, columns: normalizedColumns, rows };
}

/**
 * Series colours as a LUMINANCE ladder, not a hue wheel.
 *
 * A paper figure is read in print, in a photocopy, and by readers who cannot separate two of its
 * hues, at least as often as it is read in full colour. Series separated only by hue merge in all
 * three cases. The original eight-colour categorical palette measured 1.24:1 between the second and
 * third series in greyscale and 1.06:1 beyond that -- three curves on one axis were, on paper, the
 * same curve drawn three times.
 *
 * Three constraints had to hold at once, and the first attempt at this ladder only held one of them:
 *
 *   1. every pair at least 1.4:1 apart in relative luminance, so they survive greyscale;
 *   2. the same under protanopia, deuteranopia and tritanopia -- and this is the one that was
 *      missed. Colour-vision simulation does NOT preserve luminance: it mixes the red and green
 *      channels and reshuffles which colour is lighter. A saturated teal and a saturated tan that
 *      sit 1.6:1 apart in greyscale close to 1.35:1 under protanopia. Low saturation is what fixes
 *      it, because a desaturated colour has less red and green to redistribute;
 *   3. every colour at least 2:1 against the white page, or a "light" series is a line nobody can
 *      see. That constraint rules out the top of the ladder and is easy to forget, because a colour
 *      picked for contrast against its neighbours can still vanish into the paper.
 *
 * Searched under all three: these five hold 1.66:1 at worst across normal vision and all three
 * colour-vision conditions, sit at least 2.03:1 against the page, and keep their hues 55 degrees
 * apart so colour still carries information for the readers who can use it.
 *
 * Five is the ceiling, from both ends: a sixth colour drops the worst pair below 1.4 no matter how
 * it is chosen. So a sixth series does not get a sixth colour -- it reuses the ladder and separates
 * by dash pattern, which survives every one of these conditions by construction.
 */
const PALETTE = Object.freeze({
  data: "#2E6F62",
  fit: "#B85C38",
  component: ["#240F0F", "#363E4E", "#72587E", "#708F7A", "#BBBB58"],
  componentDash: [[], [7, 3], [2, 2], [8, 3, 2, 3], [1, 3]],
  neutral: "#6D6A66",
  band: "#D8D3CB",
});

/**
 * Builds the colour and dash scales for a categorical series field.
 *
 * The two scales are produced together because they are one decision: the dash pattern is what
 * carries the sixth series and beyond once the luminance ladder runs out, so a figure that takes
 * the colours without the dashes is separated only down to the fifth series.
 */
function componentScales(colorName, dashName, dataName, field) {
  return [
    { name: colorName, type: "ordinal", domain: { data: dataName, field }, range: PALETTE.component },
    { name: dashName, type: "ordinal", domain: { data: dataName, field }, range: PALETTE.componentDash },
  ];
}

// Scale types whose "height" range runs top-to-bottom. Continuous scales invert
// it so larger values sit higher; discrete ones do not.
const DISCRETE_SCALE_TYPES = new Set(["band", "point", "ordinal"]);

// Resolves the "width"/"height" range keywords against ONE PANEL rather than the
// whole figure.
//
// This is not a nicety. Vega resolves those keywords against the root `width`
// and `height` signals, and a group mark does not shadow them -- so every panel
// of a stacked figure drew its data across the full figure height while its own
// axis stayed at the panel height. Two panels 260px tall, 296px apart, each drew
// 556px of data: the Lorenz phase portrait was painted straight through the time
// series above it. The axes looked right, which is why reading the spec did not
// show it and rendering the figure did.
function panelScaleRange(scale, width, height) {
  if (scale.range === "width") return [0, width];
  if (scale.range !== "height") return scale.range;
  return DISCRETE_SCALE_TYPES.has(scale.type) ? [0, height] : [height, 0];
}

// Builds one Vega v5 specification with vertically stacked panels that share
// the horizontal extent. Each panel declares its own scales, axes, and marks
// against the global inline datasets; the store validator only accepts inline
// data and forbids signals/expressions, so every value is materialized here --
// including the panel-local pixel ranges, since the keywords cannot express them.
// Room for a panel heading, which Vega draws ABOVE the group box. Without it the heading lands on
// top of the previous panel's axis title -- the default gap only budgets for the axis.
const PANEL_TITLE_ALLOWANCE = 24;

function stackedVegaFigure({ description, width = 680, data, panels, gap = 36 }) {
  let offset = 0;
  const marks = panels.map((panel, index) => {
    if (index > 0 && panel.title) offset += PANEL_TITLE_ALLOWANCE;
    const group = {
      type: "group",
      name: panel.name,
      encode: { enter: { x: { value: 0 }, y: { value: offset }, width: { value: width }, height: { value: panel.height } } },
      scales: (panel.scales ?? []).map((scale) => ({ ...scale, range: panelScaleRange(scale, width, panel.height) })),
      axes: panel.axes,
      marks: panel.marks,
      ...(panel.legends ? { legends: panel.legends } : {}),
      ...(panel.title ? { title: { text: panel.title, anchor: "start", fontSize: 12 } } : {}),
    };
    offset += panel.height + gap;
    return group;
  });
  const spec = {
    $schema: "https://vega.github.io/schema/vega/v5.json",
    description,
    width,
    height: Math.max(0, offset - gap),
    padding: 16,
    autosize: "pad",
    background: "white",
    data: data.map((entry) => ({ name: entry.name, values: entry.values })),
    marks,
  };
  return spec;
}

function linearScale(name, dataName, field, range, options = {}) {
  return { name, type: "linear", domain: Array.isArray(field) ? { data: dataName, fields: field } : { data: dataName, field }, range, nice: options.nice ?? true, zero: options.zero ?? false, ...(options.domainRaw ? { domainRaw: options.domainRaw } : {}) };
}

function axis(orient, scale, title, options = {}) {
  return { orient, scale, title, grid: options.grid ?? (orient === "left"), ...(options.tickCount ? { tickCount: options.tickCount } : {}) };
}

function lineMark(dataName, xField, yField, color, options = {}) {
  return {
    type: "line",
    from: { data: dataName },
    ...(options.sortField ? { sort: { field: options.sortField } } : {}),
    encode: { enter: { x: { scale: options.xScale ?? "x", field: xField }, y: { scale: options.yScale ?? "y", field: yField }, stroke: { value: color }, strokeWidth: { value: options.strokeWidth ?? 2 }, ...(options.dash ? { strokeDash: { value: options.dash } } : {}), ...(options.interpolate ? { interpolate: { value: options.interpolate } } : {}) } },
  };
}

function symbolMark(dataName, xField, yField, color, options = {}) {
  return {
    type: "symbol",
    from: { data: dataName },
    encode: { enter: { x: { scale: options.xScale ?? "x", field: xField }, y: { scale: options.yScale ?? "y", field: yField }, fill: { value: color }, size: { value: options.size ?? 42 }, ...(options.tooltip ? { tooltip: { field: options.tooltip } } : {}) } },
  };
}

function errorBarMark(dataName, xField, lowField, highField, color, options = {}) {
  return {
    type: "rule",
    from: { data: dataName },
    encode: { enter: { x: { scale: options.xScale ?? "x", field: xField }, y: { scale: options.yScale ?? "y", field: lowField }, y2: { scale: options.yScale ?? "y", field: highField }, stroke: { value: color }, strokeWidth: { value: 1.2 } } },
  };
}

function horizontalRule(dataName, yValue, color, options = {}) {
  return {
    type: "rule",
    from: { data: dataName },
    encode: { enter: { x: { value: 0 }, x2: { value: options.width ?? 680 }, y: { scale: options.yScale ?? "y", value: yValue }, stroke: { value: color }, strokeWidth: { value: options.strokeWidth ?? 1 }, ...(options.dash ? { strokeDash: { value: options.dash } } : {}) } },
  };
}

function barMark(dataName, xField, yField, color, options = {}) {
  return {
    type: "rect",
    from: { data: dataName },
    encode: { enter: { x: { scale: options.xScale ?? "x", field: xField, offset: -(options.halfWidth ?? 2) }, width: { value: 2 * (options.halfWidth ?? 2) }, y: { scale: options.yScale ?? "y", field: yField }, y2: { scale: options.yScale ?? "y", value: 0 }, fill: { value: color } } },
  };
}

// ---------------------------------------------------------------------------
// Result finalization
// ---------------------------------------------------------------------------

function finalizeAnalysis(normalized) {
  const serialized = stableStringify(normalized);
  const analysisBytes = Buffer.byteLength(serialized);
  if (analysisBytes > MAX_ANALYSIS_BYTES) throw new PhysicsError("physics-analysis-too-large", `analysis output ${analysisBytes} bytes exceeds ${MAX_ANALYSIS_BYTES}`);
  return { ...normalized, analysisBytes, analysisSha256: sha256(serialized) };
}

function figureReceipt(spec) {
  return { schema: "agentlas.physics.analysis-figure/v1", rendererId: "agentlas.vega", specKind: "vega-v5", spec, figureSha256: sha256(stableStringify(spec)) };
}

module.exports = {
  MAX_ANALYSIS_BYTES,
  MAX_POINTS,
  PALETTE,
  PhysicsError,
  axis,
  barMark,
  boolean,
  chiSquareSurvival,
  cholesky,
  completeEllipticK,
  correlationFromCovariance,
  createRandom,
  dot,
  enumText,
  erf,
  erfc,
  errorBarMark,
  exactObject,
  figureReceipt,
  finalizeAnalysis,
  finite,
  finiteArray,
  horizontalRule,
  identity,
  integer,
  invertMatrix,
  isPlainObject,
  lineMark,
  linearScale,
  linspace,
  logGamma,
  matVec,
  mean,
  multiply,
  normalCdf,
  normalPdf,
  normalQuantile,
  normalSurvival,
  numericColumn,
  optionalFinite,
  optionalInteger,
  optionalText,
  quantile,
  regularizedGammaP,
  regularizedGammaQ,
  sameLength,
  sampleStandardDeviation,
  scienceTable,
  sha256,
  simpson,
  solveLinear,
  stableStringify,
  componentScales,
  stackedVegaFigure,
  symbolMark,
  text,
  transpose,
  verifiedScienceTable,
  weightedLinearLeastSquares,
  zeros,
};
