"use strict";

/**
 * Shared validation, numerics, and provenance helpers for the Agentlas Astronomy
 * analysis runtimes (periodicity depth, BLS, kinematics, CMD, cosmology, SED, RV).
 *
 * Every helper is deterministic and performs no I/O. Random numbers come only from
 * the caller-seeded mulberry32 generator so bootstrap results are reproducible and
 * can be replicated bit-for-bit by an independent oracle.
 */

const { AstronomyDataError, PLUGIN_ID, PLUGIN_VERSION, canonicalJson, measurementScale, sha256 } = require("./astronomy.cjs");

const ANALYSIS_RUNTIME_VERSION = "1.0.0";
const ANALYSIS_PROVENANCE_SCHEMA = "agentlas.astronomy.analysis-provenance/v1";
const FIGURE_PROVENANCE_SCHEMA = "agentlas.astronomy.figure-provenance/v1";
const PUBLICATION_TABLE_SCHEMA = "agentlas.astronomy.publication-table/v1";
const PUBLICATION_FIGURE_SCHEMA = "agentlas.astronomy.publication-figure/v1";
const VEGA_LITE_SCHEMA_URL = "https://vega.github.io/schema/vega-lite/v5.json";
const SHA256_RE = /^[a-f0-9]{64}$/;

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Input validation (fail closed, exact keys, declared units)
// ---------------------------------------------------------------------------

function exactObject(value, allowed, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AstronomyDataError(code, `${code}: expected an object`);
  const unknownFields = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknownFields.length) throw new AstronomyDataError(code, `${code}: unknown fields ${unknownFields.sort().join(", ")}`, { unknownFields: unknownFields.sort() });
}

function requiredOwn(value, fields, code) {
  const missingFields = fields.filter((field) => !Object.hasOwn(value, field));
  if (missingFields.length) throw new AstronomyDataError(code, `${code}: missing fields ${missingFields.join(", ")}`, { missingFields });
}

function sourceHash(value, code) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) throw new AstronomyDataError(code, `${code}: sourceContentSha256 must be a lowercase hex SHA-256`);
  return value;
}

function text(value, code, maximum = 500) {
  if (typeof value !== "string") throw new AstronomyDataError(code, `${code}: expected a string`);
  const normalized = value.normalize("NFC").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new AstronomyDataError(code, `${code}: string must be 1-${maximum} printable characters`);
  }
  return normalized;
}

function nullableText(value, code, maximum = 500) {
  return value === null ? null : text(value, code, maximum);
}

function number(value, code, minimum, maximum, options = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new AstronomyDataError(code, `${code}: expected a finite number`);
  const belowMinimum = options.minimumExclusive ? value <= minimum : value < minimum;
  const aboveMaximum = options.maximumExclusive ? value >= maximum : value > maximum;
  if (belowMinimum || aboveMaximum) {
    throw new AstronomyDataError(code, `${code}: ${value} is outside [${minimum}, ${maximum}]`, { minimum, maximum, value });
  }
  return Object.is(value, -0) ? 0 : value;
}

function nullableNumber(value, code, minimum, maximum, options = {}) {
  return value === null ? null : number(value, code, minimum, maximum, options);
}

function integer(value, code, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new AstronomyDataError(code, `${code}: expected an integer in [${minimum}, ${maximum}]`, { minimum, maximum, value });
  }
  return value;
}

function boolean(value, code) {
  if (typeof value !== "boolean") throw new AstronomyDataError(code, `${code}: expected a boolean`);
  return value;
}

function enumeration(value, allowed, code) {
  if (!allowed.includes(value)) throw new AstronomyDataError(code, `${code}: expected one of ${allowed.join(", ")}`, { allowed });
  return value;
}

function optional(value, fallback, normalizer) {
  return value === undefined ? fallback : normalizer(value);
}

function uniqueIds(rows, field, code) {
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row[field])) throw new AstronomyDataError(code, `${code}: duplicate ${field} ${row[field]}`, { [field]: row[field] });
    seen.add(row[field]);
  }
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Deterministic pseudo-random numbers (mulberry32) and Fisher-Yates shuffle
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(array, random) {
  for (let index = array.length - 1; index >= 1; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const held = array[index];
    array[index] = array[swap];
    array[swap] = held;
  }
  return array;
}

function resampleIndices(length, random) {
  const indices = new Array(length);
  for (let index = 0; index < length; index += 1) indices[index] = Math.floor(random() * length);
  return indices;
}

// ---------------------------------------------------------------------------
// Linear algebra
// ---------------------------------------------------------------------------

function solveLinear(matrix, vector) {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  const scale = Math.max(1, ...augmented.flat().map(Math.abs));
  const tolerance = scale * Number.EPSILON * 1024;
  for (let column = 0; column < size; column += 1) {
    let pivotRow = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivotRow][column])) pivotRow = row;
    }
    if (Math.abs(augmented[pivotRow][column]) <= tolerance) return null;
    if (pivotRow !== column) [augmented[pivotRow], augmented[column]] = [augmented[column], augmented[pivotRow]];
    const pivot = augmented[column][column];
    for (let item = column; item <= size; item += 1) augmented[column][item] /= pivot;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      if (factor === 0) continue;
      for (let item = column; item <= size; item += 1) augmented[row][item] -= factor * augmented[column][item];
    }
  }
  const solution = augmented.map((row) => row[size]);
  return solution.every(Number.isFinite) ? solution : null;
}

function invertMatrix(matrix) {
  const size = matrix.length;
  const columns = [];
  for (let column = 0; column < size; column += 1) {
    const unit = new Array(size).fill(0);
    unit[column] = 1;
    const solved = solveLinear(matrix, unit);
    if (!solved) return null;
    columns.push(solved);
  }
  return Array.from({ length: size }, (_, row) => columns.map((column) => column[row]));
}

/** Weighted linear least squares y ≈ Σ β_k basis_k(x); returns coefficients, covariance, residual sum. */
function weightedLeastSquares(designRows, values, weights) {
  const size = designRows[0].length;
  const normal = Array.from({ length: size }, () => new Array(size).fill(0));
  const rhs = new Array(size).fill(0);
  for (let index = 0; index < designRows.length; index += 1) {
    const row = designRows[index];
    const weight = weights[index];
    for (let left = 0; left < size; left += 1) {
      rhs[left] += weight * row[left] * values[index];
      for (let right = 0; right < size; right += 1) normal[left][right] += weight * row[left] * row[right];
    }
  }
  const coefficients = solveLinear(normal, rhs);
  if (!coefficients) return null;
  let residualSum = 0;
  for (let index = 0; index < designRows.length; index += 1) {
    let fitted = 0;
    for (let k = 0; k < size; k += 1) fitted += coefficients[k] * designRows[index][k];
    residualSum += weights[index] * (values[index] - fitted) ** 2;
  }
  return { coefficients, normal, residualSum: Math.max(0, residualSum), covariance: invertMatrix(normal) };
}

// ---------------------------------------------------------------------------
// Levenberg–Marquardt (Nocedal & Wright 2006 §10.3; Marquardt 1963)
// ---------------------------------------------------------------------------

function numericalJacobian(residualFn, parameters, residuals, steps) {
  const jacobian = residuals.map(() => new Array(parameters.length).fill(0));
  for (let k = 0; k < parameters.length; k += 1) {
    const step = steps ? steps[k] : Math.max(1e-7, 1e-6 * Math.abs(parameters[k]));
    const forward = [...parameters];
    const backward = [...parameters];
    forward[k] += step;
    backward[k] -= step;
    const plus = residualFn(forward);
    const minus = residualFn(backward);
    for (let index = 0; index < residuals.length; index += 1) jacobian[index][k] = (plus[index] - minus[index]) / (2 * step);
  }
  return jacobian;
}

/**
 * Minimises Σ r_i(p)² where r_i are already weighted residuals (r = (y - model)/σ).
 * `jacobianFn` may be null, in which case central finite differences are used.
 * Returns the optimum, the covariance (JᵀJ)⁻¹, and convergence diagnostics.
 */
function levenbergMarquardt(residualFn, initial, options = {}) {
  const maxIterations = options.maxIterations ?? 200;
  const tolerance = options.tolerance ?? 1e-12;
  const jacobianFn = options.jacobianFn ?? null;
  const steps = options.steps ?? null;
  const constrain = options.constrain ?? ((candidate) => candidate);
  let parameters = constrain([...initial]);
  let residuals = residualFn(parameters);
  let chiSquare = residuals.reduce((sum, value) => sum + value * value, 0);
  if (!Number.isFinite(chiSquare)) throw new AstronomyDataError("astronomy-fit-initial-residual-invalid", "The initial model produced a non-finite residual");
  let lambda = options.initialLambda ?? 1e-3;
  let iterations = 0;
  let converged = false;
  let jacobian = null;
  while (iterations < maxIterations) {
    iterations += 1;
    jacobian = jacobianFn ? jacobianFn(parameters, residuals) : numericalJacobian(residualFn, parameters, residuals, steps);
    const size = parameters.length;
    const normal = Array.from({ length: size }, () => new Array(size).fill(0));
    const gradient = new Array(size).fill(0);
    for (let index = 0; index < residuals.length; index += 1) {
      for (let left = 0; left < size; left += 1) {
        gradient[left] += jacobian[index][left] * residuals[index];
        for (let right = 0; right < size; right += 1) normal[left][right] += jacobian[index][left] * jacobian[index][right];
      }
    }
    const gradientNorm = Math.sqrt(gradient.reduce((sum, value) => sum + value * value, 0));
    if (gradientNorm <= tolerance * Math.max(1, Math.sqrt(chiSquare))) { converged = true; break; }
    let improved = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const damped = normal.map((row, left) => row.map((value, right) => (left === right ? value * (1 + lambda) + 1e-300 : value)));
      const step = solveLinear(damped, gradient.map((value) => -value));
      if (!step) { lambda *= 10; continue; }
      const candidate = constrain(parameters.map((value, index) => value + step[index]));
      const candidateResiduals = residualFn(candidate);
      const candidateChiSquare = candidateResiduals.reduce((sum, value) => sum + value * value, 0);
      if (Number.isFinite(candidateChiSquare) && candidateChiSquare < chiSquare) {
        const relativeImprovement = (chiSquare - candidateChiSquare) / Math.max(chiSquare, 1e-300);
        parameters = candidate;
        residuals = candidateResiduals;
        chiSquare = candidateChiSquare;
        lambda = Math.max(1e-12, lambda / 10);
        improved = true;
        if (relativeImprovement < tolerance) converged = true;
        break;
      }
      lambda *= 10;
      if (lambda > 1e12) break;
    }
    if (!improved || converged) { if (!improved) converged = true; break; }
  }
  jacobian = jacobianFn ? jacobianFn(parameters, residuals) : numericalJacobian(residualFn, parameters, residuals, steps);
  const size = parameters.length;
  const normal = Array.from({ length: size }, () => new Array(size).fill(0));
  for (let index = 0; index < residuals.length; index += 1) {
    for (let left = 0; left < size; left += 1) {
      for (let right = 0; right < size; right += 1) normal[left][right] += jacobian[index][left] * jacobian[index][right];
    }
  }
  return { parameters, residuals, chiSquare, iterations, converged, covariance: invertMatrix(normal), jacobian };
}

// ---------------------------------------------------------------------------
// Special functions and quadrature
// ---------------------------------------------------------------------------

const LANCZOS_COEFFICIENTS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

function gammaLn(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - gammaLn(1 - x);
  const shifted = x - 1;
  let sum = LANCZOS_COEFFICIENTS[0];
  const t = shifted + 7.5;
  for (let index = 1; index < LANCZOS_COEFFICIENTS.length; index += 1) sum += LANCZOS_COEFFICIENTS[index] / (shifted + index);
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** Regularized lower incomplete gamma P(a, x) (Numerical Recipes series/continued fraction). */
function regularizedGammaP(a, x) {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let term = 1 / a;
    let sum = term;
    for (let n = 1; n < 500; n += 1) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-16) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - gammaLn(a));
  }
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let n = 1; n < 500; n += 1) {
    const an = -n * (n - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - gammaLn(a)) * h;
}

function chiSquareSurvival(chiSquare, degreesOfFreedom) {
  if (degreesOfFreedom <= 0) return null;
  return Math.min(1, Math.max(0, 1 - regularizedGammaP(degreesOfFreedom / 2, chiSquare / 2)));
}

function adaptiveSimpson(fn, a, b, tolerance = 1e-12, maxDepth = 60) {
  const simpson = (left, right, fl, fm, fr) => ((right - left) / 6) * (fl + 4 * fm + fr);
  const recurse = (left, right, fl, fm, fr, whole, epsilon, depth) => {
    const mid = (left + right) / 2;
    const leftMid = (left + mid) / 2;
    const rightMid = (mid + right) / 2;
    const flm = fn(leftMid);
    const frm = fn(rightMid);
    const leftArea = simpson(left, mid, fl, flm, fm);
    const rightArea = simpson(mid, right, fm, frm, fr);
    const delta = leftArea + rightArea - whole;
    if (depth <= 0 || Math.abs(delta) <= 15 * epsilon) return leftArea + rightArea + delta / 15;
    return recurse(left, mid, fl, flm, fm, leftArea, epsilon / 2, depth - 1)
      + recurse(mid, right, fm, frm, fr, rightArea, epsilon / 2, depth - 1);
  };
  const fa = fn(a);
  const fb = fn(b);
  const fm = fn((a + b) / 2);
  return recurse(a, b, fa, fm, fb, simpson(a, b, fa, fm, fb), tolerance, maxDepth);
}

/** Root of monotone fn on [lower, upper] by bisection (fn(lower) and fn(upper) must differ in sign). */
function bisect(fn, lower, upper, iterations = 200) {
  let fLower = fn(lower);
  if (fLower === 0) return lower;
  const fUpper = fn(upper);
  if (fUpper === 0) return upper;
  if (Math.sign(fLower) === Math.sign(fUpper)) return null;
  let low = lower;
  let high = upper;
  for (let index = 0; index < iterations; index += 1) {
    const mid = (low + high) / 2;
    const fMid = fn(mid);
    if (fMid === 0 || (high - low) / 2 < Number.EPSILON * Math.max(1, Math.abs(mid))) return mid;
    if (Math.sign(fMid) === Math.sign(fLower)) { low = mid; fLower = fMid; } else high = mid;
  }
  return (low + high) / 2;
}

/** Kepler's equation E - e sin E = M solved by Newton–Raphson (Danby 1988 starter). */
function solveKepler(meanAnomaly, eccentricity) {
  const twoPi = 2 * Math.PI;
  let M = meanAnomaly % twoPi;
  if (M < 0) M += twoPi;
  let E = eccentricity < 0.8 ? M : Math.PI;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const f = E - eccentricity * Math.sin(E) - M;
    const fPrime = 1 - eccentricity * Math.cos(E);
    const delta = f / fPrime;
    E -= delta;
    if (Math.abs(delta) < 1e-15) break;
  }
  return E;
}

function trueAnomaly(eccentricAnomaly, eccentricity) {
  return 2 * Math.atan2(Math.sqrt(1 + eccentricity) * Math.sin(eccentricAnomaly / 2), Math.sqrt(1 - eccentricity) * Math.cos(eccentricAnomaly / 2));
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values, ddof = 1) {
  if (values.length <= ddof) return null;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - ddof));
}

function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

/** Linear-interpolation percentile (numpy default, "linear" method). */
function percentile(values, q) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const position = (q / 100) * (ordered.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(ordered.length - 1, lower + 1);
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
}

function unitPhase(value) {
  const remainder = value % 1;
  return remainder < 0 ? remainder + 1 : remainder;
}

// ---------------------------------------------------------------------------
// Publication payload helpers
// ---------------------------------------------------------------------------

const FIGURE_CONFIG = deepFreeze({
  background: "#FFFFFF",
  axis: { labelColor: "#1F2937", titleColor: "#111827", gridColor: "#E5E7EB", domainColor: "#6B7280" },
  view: { stroke: null },
});

function publicationTable(title, columns, rows, notes, missingValueToken = "NA") {
  return { schema: PUBLICATION_TABLE_SCHEMA, title, missingValueToken, columns, rows, notes };
}

function publicationFigure(title, altText, spec, provenance, exportRecommendation = { widthMm: 178, dpi: 600, colorSpace: "sRGB" }) {
  return {
    schema: PUBLICATION_FIGURE_SCHEMA,
    rendererId: "vega-lite",
    rendererRequirement: ">=5.0.0 <7.0.0",
    title,
    altText,
    exportRecommendation,
    spec: { ...spec, config: FIGURE_CONFIG, usermeta: provenance },
  };
}

/**
 * Binds a completed analysis to its receipts: input, algorithm, table, figure, and
 * whole-result hashes. `core` must already contain `publication.table` and a figure
 * builder is invoked with the figure provenance so the figure hash covers its own lineage.
 */
function finalizeAnalysis({ schema, algorithm, normalizedInput, sourceContentSha256, sections, table, buildFigure }) {
  const inputSha256 = sha256(canonicalJson(normalizedInput));
  const algorithmSha256 = sha256(canonicalJson(algorithm));
  const tableSha256 = sha256(canonicalJson(table));
  const figureProvenance = { schema: FIGURE_PROVENANCE_SCHEMA, sourceContentSha256, inputSha256, algorithmSha256, tableSha256 };
  const figure = buildFigure(figureProvenance);
  const figureSha256 = sha256(canonicalJson(figure));
  const core = { schema, algorithm, ...sections, publication: { table, figure } };
  const resultSha256 = sha256(canonicalJson(core));
  return {
    ...core,
    provenance: {
      schema: ANALYSIS_PROVENANCE_SCHEMA,
      pluginId: PLUGIN_ID,
      pluginVersion: PLUGIN_VERSION,
      analysisRuntimeVersion: ANALYSIS_RUNTIME_VERSION,
      sourceContentSha256,
      inputSha256,
      algorithmSha256,
      tableSha256,
      figureSha256,
      resultSha256,
    },
  };
}

module.exports = {
  ANALYSIS_PROVENANCE_SCHEMA,
  ANALYSIS_RUNTIME_VERSION,
  FIGURE_PROVENANCE_SCHEMA,
  PUBLICATION_FIGURE_SCHEMA,
  PUBLICATION_TABLE_SCHEMA,
  VEGA_LITE_SCHEMA_URL,
  AstronomyDataError,
  adaptiveSimpson,
  bisect,
  boolean,
  canonicalJson,
  chiSquareSurvival,
  compareText,
  deepFreeze,
  enumeration,
  exactObject,
  finalizeAnalysis,
  gammaLn,
  integer,
  invertMatrix,
  levenbergMarquardt,
  mean,
  measurementScale,
  median,
  mulberry32,
  nullableNumber,
  nullableText,
  number,
  numericalJacobian,
  optional,
  percentile,
  publicationFigure,
  publicationTable,
  regularizedGammaP,
  requiredOwn,
  resampleIndices,
  sha256,
  shuffleInPlace,
  solveKepler,
  solveLinear,
  sourceHash,
  standardDeviation,
  text,
  trueAnomaly,
  uniqueIds,
  unitPhase,
  weightedLeastSquares,
};
