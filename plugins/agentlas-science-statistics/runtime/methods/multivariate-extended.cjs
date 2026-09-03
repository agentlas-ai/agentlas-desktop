"use strict";

/**
 * Multivariate extension family: exploratory factor analysis, MANOVA, Hotelling T², linear /
 * quadratic discriminant analysis, canonical correlation, classical MDS, partial correlation,
 * and a Mahalanobis outlier screen. Pure deterministic JavaScript; numeric kernels come from
 * ./extended-shared-numeric.cjs and the engine helper object `H`.
 */

const S = require("./extended-shared-numeric.cjs");

const FAMILY = "multivariate-extended";
const ORACLE_FILE = "contracts/multivariate-extended-scipy-crosscheck.py";

function estimateEntries(object) {
  return Object.entries(object).map(([name, value]) => {
    if (Array.isArray(value)) return { name, kind: "rows", rows: value };
    if (value !== null && typeof value === "object") return { name, kind: "object", value };
    if (typeof value === "number") return { name, kind: "scalar", estimate: value };
    return { name, kind: "scalar", value };
  });
}

// ---------------------------------------------------------------------------------------------
// Fixtures (deterministic literals; iris subsets and a synthetic two-factor battery).
// ---------------------------------------------------------------------------------------------

const IRIS_ROWS = [
  [5.1, 3.5, 1.4, 0.2, "setosa"], [4.9, 3.0, 1.4, 0.2, "setosa"], [4.7, 3.2, 1.3, 0.2, "setosa"], [4.6, 3.1, 1.5, 0.2, "setosa"],
  [5.0, 3.6, 1.4, 0.2, "setosa"], [5.4, 3.9, 1.7, 0.4, "setosa"], [4.6, 3.4, 1.4, 0.3, "setosa"], [5.0, 3.4, 1.5, 0.2, "setosa"],
  [7.0, 3.2, 4.7, 1.4, "versicolor"], [6.4, 3.2, 4.5, 1.5, "versicolor"], [6.9, 3.1, 4.9, 1.5, "versicolor"], [5.5, 2.3, 4.0, 1.3, "versicolor"],
  [6.5, 2.8, 4.6, 1.5, "versicolor"], [5.7, 2.8, 4.5, 1.3, "versicolor"], [6.3, 3.3, 4.7, 1.6, "versicolor"], [4.9, 2.4, 3.3, 1.0, "versicolor"],
  [6.3, 3.3, 6.0, 2.5, "virginica"], [5.8, 2.7, 5.1, 1.9, "virginica"], [7.1, 3.0, 5.9, 2.1, "virginica"], [6.3, 2.9, 5.6, 1.8, "virginica"],
  [6.5, 3.0, 5.8, 2.2, "virginica"], [7.6, 3.0, 6.6, 2.1, "virginica"], [4.9, 2.5, 4.5, 1.7, "virginica"], [7.3, 2.9, 6.3, 1.8, "virginica"],
];
const IRIS_NAMES = ["sepal_length", "sepal_width", "petal_length", "petal_width"];
const IRIS_VARIABLES = IRIS_NAMES.map((name, column) => ({ name, values: IRIS_ROWS.map((row) => row[column]) }));
const IRIS_GROUPS = IRIS_ROWS.map((row) => row[4]);

function syntheticFactorBattery() {
  const n = 40;
  const names = ["verbal_1", "verbal_2", "verbal_3", "spatial_1", "spatial_2", "spatial_3"];
  const weights = [[0.85, 0.05], [0.75, 0.1], [0.65, 0.0], [0.05, 0.85], [0.1, 0.75], [0.0, 0.65]];
  const values = names.map(() => []);
  for (let i = 1; i <= n; i += 1) {
    const f1 = Math.sin(0.37 * i) + 0.5 * Math.cos(1.1 * i);
    const f2 = Math.cos(0.53 * i) - 0.4 * Math.sin(1.7 * i);
    for (let j = 0; j < names.length; j += 1) {
      const noise = 0.45 * Math.sin(2.3 * i * (j + 1) + 0.7 * j) + 0.2 * Math.cos(0.9 * i + 1.9 * j);
      values[j].push(Math.round((weights[j][0] * f1 + weights[j][1] * f2 + noise) * 1000) / 1000);
    }
  }
  return names.map((name, index) => ({ name, values: values[index] }));
}
const FACTOR_BATTERY = syntheticFactorBattery();

// ---------------------------------------------------------------------------------------------
// Shared parsing helpers.
// ---------------------------------------------------------------------------------------------

function parseGroupsVector(raw, n, H, { minLevels = 2, maxLevels = 32, minPerLevel = 2, path = "data.groups" } = {}) {
  const groups = H.categoryVector(raw, path, n);
  if (groups.length !== n) H.fail("STAT_INVALID_INPUT", `${path} length must match the variable rows`);
  const levels = [...new Set(groups)].sort((left, right) => left.localeCompare(right, "en"));
  if (levels.length < minLevels || levels.length > maxLevels) H.fail("STAT_INVALID_INPUT", `${path} must contain ${minLevels} to ${maxLevels} distinct levels`);
  const counts = Object.fromEntries(levels.map((level) => [level, 0]));
  for (const group of groups) counts[group] += 1;
  for (const level of levels) if (counts[level] < minPerLevel) H.fail("STAT_INSUFFICIENT_SAMPLE", `group ${level} requires at least ${minPerLevel} observations`);
  return { groups, levels, counts };
}

function variableColumns(parsed) {
  return parsed.variables.map((variable) => variable.values);
}

function correlationMatrix(columns, budget) {
  return S.correlationFromCovariance(S.sampleCovariance(columns, budget));
}

function matrixTable(H, title, caption, rowNames, columnNames, matrix, role, notes = [], rowKey = "variable") {
  const columns = [{ key: rowKey, label: rowKey === "variable" ? "Variable" : "Row", type: "string" }, ...columnNames.map((name) => ({ key: name, label: name, type: "number" }))];
  const rows = rowNames.map((name, index) => {
    const row = { [rowKey]: name };
    for (const [column, columnName] of columnNames.entries()) row[columnName] = matrix[index][column];
    return row;
  });
  return H.tableArtifact(title, caption, columns, rows, notes, role);
}

function sscp(columns, means) {
  const p = columns.length;
  const n = columns[0].length;
  const matrix = S.zeros(p, p);
  for (let i = 0; i < p; i += 1) {
    for (let j = i; j < p; j += 1) {
      let total = 0;
      for (let row = 0; row < n; row += 1) total += (columns[i][row] - means[i]) * (columns[j][row] - means[j]);
      matrix[i][j] = total;
      matrix[j][i] = total;
    }
  }
  return matrix;
}

function groupPartition(columns, groups, levels) {
  const p = columns.length;
  const n = columns[0].length;
  const rowsByLevel = Object.fromEntries(levels.map((level) => [level, []]));
  for (let row = 0; row < n; row += 1) rowsByLevel[groups[row]].push(row);
  const overallMean = columns.map((column) => column.reduce((total, value) => total + value, 0) / n);
  const groupMeans = {};
  const within = S.zeros(p, p);
  const between = S.zeros(p, p);
  const groupCovariance = {};
  for (const level of levels) {
    const rows = rowsByLevel[level];
    const mean = columns.map((column) => rows.reduce((total, row) => total + column[row], 0) / rows.length);
    groupMeans[level] = mean;
    const local = S.zeros(p, p);
    for (const row of rows) {
      for (let i = 0; i < p; i += 1) {
        for (let j = 0; j < p; j += 1) local[i][j] += (columns[i][row] - mean[i]) * (columns[j][row] - mean[j]);
      }
    }
    for (let i = 0; i < p; i += 1) for (let j = 0; j < p; j += 1) {
      within[i][j] += local[i][j];
      between[i][j] += rows.length * (mean[i] - overallMean[i]) * (mean[j] - overallMean[j]);
    }
    groupCovariance[level] = rows.length > 1 ? local.map((row) => row.map((value) => value / (rows.length - 1))) : null;
  }
  return { rowsByLevel, overallMean, groupMeans, within, between, groupCovariance };
}

/** Eigen-decomposition of E^{-1} H through the Cholesky factor of E (symmetric reformulation). */
function relativeEigen(H, within, between, budget) {
  const lower = S.cholesky(within);
  if (!lower) H.fail("STAT_SINGULAR_FIT", "within-group SSCP matrix is not positive definite; reduce variables or add observations");
  const p = within.length;
  const inverseLower = S.inverse(lower);
  const symmetric = S.multiply(S.multiply(inverseLower, between, budget), S.transpose(inverseLower), budget);
  for (let i = 0; i < p; i += 1) for (let j = i + 1; j < p; j += 1) {
    const average = 0.5 * (symmetric[i][j] + symmetric[j][i]);
    symmetric[i][j] = average;
    symmetric[j][i] = average;
  }
  const decomposition = S.symmetricEigen(symmetric, budget);
  const vectors = decomposition.vectors.map((u) => {
    const raw = S.multiplyVector(S.transpose(inverseLower), u);
    let anchor = 0;
    for (let index = 1; index < raw.length; index += 1) if (Math.abs(raw[index]) > Math.abs(raw[anchor])) anchor = index;
    return raw[anchor] < 0 ? raw.map((value) => -value) : raw;
  });
  return { values: decomposition.values.map((value) => Math.max(0, value)), rawVectors: vectors, withinLower: lower };
}

function multivariateTestStatistics(eigenvalues, q, dfResidual) {
  const p = eigenvalues.length;
  const s = Math.min(p, q);
  const m = 0.5 * (Math.abs(p - q) - 1);
  const nn = 0.5 * (dfResidual - p - 1);
  const pillai = eigenvalues.reduce((total, value) => total + value / (1 + value), 0);
  const wilks = eigenvalues.reduce((total, value) => total / (1 + value), 1);
  const hotelling = eigenvalues.reduce((total, value) => total + value, 0);
  const roy = Math.max(...eigenvalues);
  const rows = [];
  {
    const tmp1 = 2 * m + s + 1;
    const tmp2 = 2 * nn + s + 1;
    const f = (tmp2 / tmp1 * pillai) / (s - pillai);
    rows.push({ statistic: "Pillai trace", value: pillai, f, df1: s * tmp1, df2: s * tmp2 });
  }
  {
    const tmp1 = dfResidual - 0.5 * (p - q + 1);
    const tmp2 = (p * q - 2) / 4;
    const tmp3raw = p * p + q * q - 5;
    const tmp3 = tmp3raw > 0 ? Math.sqrt(((p * q) ** 2 - 4) / tmp3raw) : 1;
    const f = ((Math.pow(wilks, -1 / tmp3) - 1) * (tmp1 * tmp3 - 2 * tmp2)) / p / q;
    rows.push({ statistic: "Wilks lambda", value: wilks, f, df1: p * q, df2: tmp1 * tmp3 - 2 * tmp2 });
  }
  {
    // McKeon (1974) F approximation for the Hotelling-Lawley trace, the form used by SAS PROC GLM
    // and statsmodels. Its moment-matching constant b divides by (nn - 1) and (2 * nn + 1), so it is
    // only defined for nn > 0; when the residual degrees of freedom are too small for that,
    // the older Pillai (1955) large-sample form is used instead. Both branches are kept so the
    // reported F stays on the same convention across the whole df range.
    let df1;
    let df2;
    let f;
    if (nn > 0) {
      const b = ((p + 2 * nn) * (q + 2 * nn)) / 2 / (2 * nn + 1) / (nn - 1);
      df1 = p * q;
      df2 = 4 + (p * q + 2) / (b - 1);
      const c = (df2 - 2) / 2 / nn;
      f = (df2 / df1) * (hotelling / c);
    } else {
      df1 = s * (2 * m + s + 1);
      df2 = s * (s * nn + 1);
      f = (df2 / df1 / s) * hotelling;
    }
    rows.push({ statistic: "Hotelling-Lawley trace", value: hotelling, f, df1, df2 });
  }
  {
    const tmp1 = Math.max(p, q);
    const tmp2 = dfResidual - tmp1 + q;
    const f = (tmp2 * roy) / tmp1;
    rows.push({ statistic: "Roy largest root", value: roy, f, df1: tmp1, df2: tmp2 });
  }
  return rows.map((row) => ({ ...row, pValue: row.df1 > 0 && row.df2 > 0 && Number.isFinite(row.f) ? S.fSurvival(row.f, row.df1, row.df2) : null }));
}

function boxM(levels, counts, groupCovariance, pooledCovariance, p) {
  const g = levels.length;
  let m = 0;
  let inverseSum = 0;
  let dfPooled = 0;
  for (const level of levels) {
    const covariance = groupCovariance[level];
    if (!covariance || counts[level] <= p) return { name: "Box M covariance homogeneity", status: "not_evaluated", reason: `group ${level} has too few observations for a full-rank covariance` };
    const determinant = S.logAbsDeterminant(covariance);
    if (determinant.sign <= 0) return { name: "Box M covariance homogeneity", status: "not_evaluated", reason: `group ${level} covariance matrix is singular` };
    m -= (counts[level] - 1) * determinant.logAbs;
    inverseSum += 1 / (counts[level] - 1);
    dfPooled += counts[level] - 1;
  }
  const pooledDeterminant = S.logAbsDeterminant(pooledCovariance);
  if (pooledDeterminant.sign <= 0) return { name: "Box M covariance homogeneity", status: "not_evaluated", reason: "pooled covariance matrix is singular" };
  m += dfPooled * pooledDeterminant.logAbs;
  const c1 = (inverseSum - 1 / dfPooled) * (2 * p * p + 3 * p - 1) / (6 * (p + 1) * (g - 1));
  const statistic = m * (1 - c1);
  const df = p * (p + 1) * (g - 1) / 2;
  return { name: "Box M covariance homogeneity", status: "evaluated", boxM: m, statistic, df, pValue: S.chiSquareSurvival(statistic, df), method: "chi-square approximation (Box 1949); sensitive to non-normality", interpretation: "small p suggests unequal covariance matrices" };
}

function quadraticForm(vector, matrix) {
  let total = 0;
  for (let i = 0; i < vector.length; i += 1) for (let j = 0; j < vector.length; j += 1) total += vector[i] * matrix[i][j] * vector[j];
  return total;
}

function rendererContract(H, rows, extra = {}) {
  return { inlineRows: "all", sampling: "none", aggregation: "none", rowCount: rows.length, rowsHash: H.sha256(rows), ...extra };
}

// ---------------------------------------------------------------------------------------------
// Exploratory factor analysis.
// ---------------------------------------------------------------------------------------------

function ledermannBound(p) {
  let k = 1;
  while (k + 1 < p && (p - (k + 1)) ** 2 >= p + (k + 1)) k += 1;
  return k;
}

function parallelAnalysis(n, p, iterations, seed, budget) {
  const rng = S.createRng(seed);
  const collected = Array.from({ length: p }, () => []);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const columns = Array.from({ length: p }, () => Array.from({ length: n }, () => rng.normal()));
    const values = S.symmetricEigen(correlationMatrix(columns, budget), budget).values;
    for (let component = 0; component < p; component += 1) collected[component].push(values[component]);
  }
  return collected.map((values) => {
    const ordered = [...values].sort((a, b) => a - b);
    const h = (ordered.length - 1) * 0.95;
    const lower = Math.floor(h);
    const upper = Math.ceil(h);
    const quantile = ordered[lower] + (h - lower) * (ordered[upper] - ordered[lower]);
    return { mean: values.reduce((total, value) => total + value, 0) / values.length, quantile95: quantile };
  });
}

function loadingsFromEigen(decomposition, k) {
  const p = decomposition.vectors[0].length;
  return Array.from({ length: p }, (_, row) => Array.from({ length: k }, (_, factor) => {
    const value = decomposition.values[factor];
    return value > 0 ? decomposition.vectors[factor][row] * Math.sqrt(value) : 0;
  }));
}

function principalAxis(H, R, k, tolerance, maxIterations, budget) {
  const p = R.length;
  const inverse = S.inverse(R);
  if (!inverse) H.fail("STAT_SINGULAR_FIT", "correlation matrix is singular; squared multiple correlations are undefined");
  let communalities = inverse.map((row, index) => 1 - 1 / row[index]);
  let loadings = null;
  let eigenvalues = null;
  let iterations = 0;
  let converged = false;
  for (; iterations < maxIterations; iterations += 1) {
    const reduced = R.map((row, i) => row.map((value, j) => (i === j ? communalities[i] : value)));
    const decomposition = S.symmetricEigen(reduced, budget);
    eigenvalues = decomposition.values;
    loadings = loadingsFromEigen(decomposition, k);
    const next = loadings.map((row) => row.reduce((total, value) => total + value * value, 0));
    const change = Math.sqrt(next.reduce((total, value, index) => total + (value - communalities[index]) ** 2, 0));
    communalities = next;
    if (change < tolerance) {
      converged = true;
      iterations += 1;
      break;
    }
  }
  return { loadings, uniquenesses: communalities.map((value) => 1 - value), iterations, converged, reducedEigenvalues: eigenvalues, objective: null };
}

function boundedPsi(u, lower, upper) {
  const sigmoid = 1 / (1 + Math.exp(-u));
  return { psi: lower + (upper - lower) * sigmoid, derivative: (upper - lower) * sigmoid * (1 - sigmoid) };
}

function factorObjective(R, k, method, budget) {
  const p = R.length;
  const lower = 0.005;
  const upper = 1;
  const evaluate = (u) => {
    const mapped = u.map((value) => boundedPsi(value, lower, upper));
    const psi = mapped.map((item) => item.psi);
    if (method === "minres") {
      const reduced = R.map((row, i) => row.map((value, j) => (i === j ? 1 - psi[i] : value)));
      const decomposition = S.symmetricEigen(reduced, budget);
      const loadings = loadingsFromEigen(decomposition, k);
      let value = 0;
      for (let j = 0; j < p; j += 1) if (j >= k || decomposition.values[j] <= 0) value += 0.5 * decomposition.values[j] ** 2;
      const gradient = Array(p).fill(0);
      for (let i = 0; i < p; i += 1) {
        let modeled = 0;
        for (let factor = 0; factor < k; factor += 1) modeled += loadings[i][factor] ** 2;
        gradient[i] = -((1 - psi[i]) - modeled) * mapped[i].derivative;
      }
      return { value, gradient, loadings, psi };
    }
    const scale = psi.map((value) => 1 / Math.sqrt(value));
    const scaled = R.map((row, i) => row.map((value, j) => value * scale[i] * scale[j]));
    const decomposition = S.symmetricEigen(scaled, budget);
    const loadings = Array.from({ length: p }, (_, row) => Array.from({ length: k }, (_, factor) => {
      const theta = decomposition.values[factor];
      return theta > 1 ? decomposition.vectors[factor][row] * Math.sqrt(theta - 1) / scale[row] : 0;
    }));
    let value = 0;
    for (let j = 0; j < p; j += 1) {
      const theta = decomposition.values[j];
      if (j >= k || theta <= 1) value += theta - Math.log(Math.max(theta, 1e-300)) - 1;
    }
    const sigma = R.map((row, i) => row.map((_, j) => {
      let total = i === j ? psi[i] : 0;
      for (let factor = 0; factor < k; factor += 1) total += loadings[i][factor] * loadings[j][factor];
      return total;
    }));
    const sigmaInverse = S.inverse(sigma);
    const gradient = Array(p).fill(0);
    if (sigmaInverse) {
      const difference = sigma.map((row, i) => row.map((entry, j) => entry - R[i][j]));
      const product = S.multiply(S.multiply(sigmaInverse, difference, budget), sigmaInverse, budget);
      for (let i = 0; i < p; i += 1) gradient[i] = product[i][i] * mapped[i].derivative;
    }
    return { value, gradient, loadings, psi };
  };
  return evaluate;
}

function iterativeExtraction(H, R, k, method, options, budget) {
  const p = R.length;
  const inverse = S.inverse(R);
  if (!inverse) H.fail("STAT_SINGULAR_FIT", "correlation matrix is singular; squared multiple correlations are undefined");
  const start = inverse.map((row, index) => {
    const psi = Math.min(0.99, Math.max(0.01, 1 / row[index]));
    const fraction = (psi - 0.005) / (1 - 0.005);
    return Math.log(fraction / (1 - fraction));
  });
  const evaluate = factorObjective(R, k, method, budget);
  const result = S.lbfgs((u) => evaluate(u).value, (u) => evaluate(u).gradient, start, { maxIterations: 1000, tolerance: 1e-10, budget });
  const final = evaluate(result.x);
  const gradientNorm = Math.sqrt(final.gradient.reduce((total, value) => total + value * value, 0));
  if (!Number.isFinite(final.value)) H.fail("STAT_NON_CONVERGENCE", `${method} factor extraction produced a non-finite objective`);
  return { loadings: final.loadings, uniquenesses: final.psi, iterations: result.iterations, converged: result.converged || gradientNorm < 1e-6, objective: final.value, gradientNorm, reducedEigenvalues: null };
}

function varimaxRotation(loadings, normalize) {
  const p = loadings.length;
  const k = loadings[0].length;
  const rotation = S.identity(k);
  if (k === 1) return { loadings: loadings.map((row) => [...row]), rotation, sweeps: 0 };
  const norms = loadings.map((row) => (normalize ? Math.sqrt(row.reduce((total, value) => total + value * value, 0)) || 1 : 1));
  const x = loadings.map((row, index) => row.map((value) => value / norms[index]));
  let sweeps = 0;
  for (; sweeps < 1000; sweeps += 1) {
    let maximumAngle = 0;
    for (let i = 0; i < k - 1; i += 1) {
      for (let j = i + 1; j < k; j += 1) {
        let a = 0;
        let b = 0;
        let c = 0;
        let d = 0;
        for (let row = 0; row < p; row += 1) {
          const u = x[row][i] ** 2 - x[row][j] ** 2;
          const v = 2 * x[row][i] * x[row][j];
          a += u;
          b += v;
          c += u * u - v * v;
          d += 2 * u * v;
        }
        const numerator = d - 2 * a * b / p;
        const denominator = c - (a * a - b * b) / p;
        const angle = 0.25 * Math.atan2(numerator, denominator);
        maximumAngle = Math.max(maximumAngle, Math.abs(angle));
        if (Math.abs(angle) < 1e-14) continue;
        const cosine = Math.cos(angle);
        const sine = Math.sin(angle);
        for (let row = 0; row < p; row += 1) {
          const xi = x[row][i];
          const xj = x[row][j];
          x[row][i] = xi * cosine + xj * sine;
          x[row][j] = -xi * sine + xj * cosine;
        }
        for (let row = 0; row < k; row += 1) {
          const ti = rotation[row][i];
          const tj = rotation[row][j];
          rotation[row][i] = ti * cosine + tj * sine;
          rotation[row][j] = -ti * sine + tj * cosine;
        }
      }
    }
    if (maximumAngle < 1e-10) break;
  }
  return { loadings: x.map((row, index) => row.map((value) => value * norms[index])), rotation, sweeps };
}

function promaxRotation(H, loadings, power, normalize) {
  const varimax = varimaxRotation(loadings, normalize);
  const x = varimax.loadings;
  const k = x[0].length;
  if (k === 1) return { pattern: x, rotation: varimax.rotation, phi: [[1]], varimaxSweeps: varimax.sweeps };
  const target = x.map((row) => row.map((value) => value * Math.pow(Math.abs(value), power - 1)));
  const xt = S.transpose(x);
  const gram = S.multiply(xt, x);
  const gramInverse = S.inverse(gram);
  if (!gramInverse) H.fail("STAT_SINGULAR_FIT", "promax target regression is singular");
  let u = S.multiply(gramInverse, S.multiply(xt, target));
  const uu = S.inverse(S.multiply(S.transpose(u), u));
  if (!uu) H.fail("STAT_SINGULAR_FIT", "promax normalisation matrix is singular");
  const d = uu.map((row, index) => Math.sqrt(row[index]));
  u = u.map((row) => row.map((value, column) => value * d[column]));
  const pattern = S.multiply(x, u);
  const rotation = S.multiply(varimax.rotation, u);
  const phi = S.inverse(S.multiply(S.transpose(u), u));
  if (!phi) H.fail("STAT_SINGULAR_FIT", "promax factor correlation matrix is singular");
  return { pattern, rotation, phi, varimaxSweeps: varimax.sweeps };
}

function orderFactors(pattern, rotation, phi) {
  const k = pattern[0].length;
  const ss = Array.from({ length: k }, (_, factor) => pattern.reduce((total, row) => total + row[factor] ** 2, 0));
  const order = Array.from({ length: k }, (_, index) => index).sort((a, b) => ss[b] - ss[a] || a - b);
  const signs = order.map((factor) => (pattern.reduce((total, row) => total + row[factor], 0) < 0 ? -1 : 1));
  const reorder = (matrix) => matrix.map((row) => order.map((factor, position) => row[factor] * signs[position]));
  const newPhi = order.map((factorA, a) => order.map((factorB, b) => phi[factorA][factorB] * signs[a] * signs[b]));
  return { pattern: reorder(pattern), rotation: reorder(rotation), phi: newPhi };
}

const exploratoryFactorAnalysis = {
  method: "exploratory_factor_analysis",
  family: FAMILY,
  analysisModel: { families: ["pca"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["timeoutMs", "maxIterations", "tolerance"],
  customOptions: {
    factors: { schema: { type: ["integer", "null"], minimum: 1, maximum: 31 }, default: null, parse(value, H, path) { return value === null ? null : H.integer(value, 1, 31, path); } },
    extraction: { schema: { type: "string", enum: ["principal_axis", "minres", "ml"] }, default: "minres", parse(value, H, path) { if (!["principal_axis", "minres", "ml"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be principal_axis, minres, or ml`); return value; } },
    rotation: { schema: { type: "string", enum: ["none", "varimax", "promax"] }, default: "varimax", parse(value, H, path) { if (!["none", "varimax", "promax"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be none, varimax, or promax`); return value; } },
    seed: S.seedOption(),
    parallelIterations: { schema: { type: "integer", minimum: 10, maximum: 500 }, default: 50, parse(value, H, path) { return H.integer(value, 10, 500, path); } },
    promaxPower: { schema: { type: "integer", minimum: 2, maximum: 6 }, default: 4, parse(value, H, path) { return H.integer(value, 2, 6, path); } },
    kaiserNormalize: { schema: { type: "boolean" }, default: true, parse(value, H, path) { if (typeof value !== "boolean") H.fail("STAT_INVALID_INPUT", `${path} must be boolean`); return value; } },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["variables"],
    properties: {
      variables: { type: "array", minItems: 3, maxItems: 32, items: { type: "object", additionalProperties: false, required: ["values"], properties: { name: { type: "string", minLength: 1, maxLength: 128 }, values: { type: "array", minItems: 10, maxItems: 10000, items: { type: "number" } } } } },
      rowLabels: { type: "array", minItems: 10, maxItems: 10000, items: { type: "string", minLength: 1, maxLength: 128 } },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["variables", "rowLabels"], "data");
    const matrix = S.parseVariableMatrix(data, H, { minRows: 10, minVariables: 3, maxVariables: 32 });
    const p = matrix.variables.length;
    const bound = ledermannBound(p);
    if (options.factors !== null && options.factors > bound) H.fail("STAT_INVALID_INPUT", `options.factors must not exceed the identifiability bound ${bound} for ${p} variables`);
    if (matrix.rowCount <= p) H.fail("STAT_INSUFFICIENT_SAMPLE", "factor analysis requires more observations than variables");
    return { ...matrix, ledermannBound: bound };
  },
  analyze(parsed, options, budget, H) {
    const columns = variableColumns(parsed);
    const n = parsed.rowCount;
    const p = columns.length;
    const R = correlationMatrix(columns, budget);
    const observed = S.symmetricEigen(R, budget).values;
    const parallel = parallelAnalysis(n, p, options.parallelIterations, options.seed, budget);
    const suggested = Math.min(parsed.ledermannBound, Math.max(1, observed.filter((value, index) => value > parallel[index].quantile95).length));
    const k = options.factors === null ? suggested : options.factors;
    const extraction = options.extraction === "principal_axis"
      ? principalAxis(H, R, k, options.tolerance, options.maxIterations, budget)
      : iterativeExtraction(H, R, k, options.extraction, options, budget);
    if (!extraction.converged) H.fail("STAT_NON_CONVERGENCE", `${options.extraction} extraction did not converge within ${options.extraction === "principal_axis" ? options.maxIterations : 1000} iterations`);
    const unrotated = extraction.loadings;
    let pattern = unrotated.map((row) => [...row]);
    let rotationMatrix = S.identity(k);
    let phi = S.identity(k);
    let varimaxSweeps = 0;
    if (options.rotation === "varimax" && k > 1) {
      const rotated = varimaxRotation(unrotated, options.kaiserNormalize);
      pattern = rotated.loadings;
      rotationMatrix = rotated.rotation;
      varimaxSweeps = rotated.sweeps;
    } else if (options.rotation === "promax" && k > 1) {
      const rotated = promaxRotation(H, unrotated, options.promaxPower, options.kaiserNormalize);
      pattern = rotated.pattern;
      rotationMatrix = rotated.rotation;
      phi = rotated.phi;
      varimaxSweeps = rotated.varimaxSweeps;
    }
    if (k > 1) {
      const ordered = orderFactors(pattern, rotationMatrix, phi);
      pattern = ordered.pattern;
      rotationMatrix = ordered.rotation;
      phi = ordered.phi;
    } else if (pattern.reduce((total, row) => total + row[0], 0) < 0) {
      pattern = pattern.map((row) => [-row[0]]);
      rotationMatrix = [[-1]];
    }
    const structure = S.multiply(pattern, phi);
    const communalities = unrotated.map((row) => row.reduce((total, value) => total + value * value, 0));
    const model = S.multiply(S.multiply(pattern, phi), S.transpose(pattern));
    let residualSquares = 0;
    let correlationSquares = 0;
    let pairs = 0;
    for (let i = 0; i < p; i += 1) for (let j = i + 1; j < p; j += 1) {
      residualSquares += (R[i][j] - model[i][j]) ** 2;
      correlationSquares += R[i][j] ** 2;
      pairs += 1;
    }
    const rmsr = Math.sqrt(residualSquares / pairs);
    const factorNames = Array.from({ length: k }, (_, index) => `F${index + 1}`);
    const loadingRows = [];
    for (let row = 0; row < p; row += 1) {
      for (let factor = 0; factor < k; factor += 1) {
        loadingRows.push({ variable: parsed.variables[row].name, factor: factorNames[factor], loading: pattern[row][factor], structure: structure[row][factor], unrotated: unrotated[row][factor] });
      }
    }
    const communalityRows = parsed.variables.map((variable, row) => ({ variable: variable.name, communality: communalities[row], uniqueness: extraction.uniquenesses[row], complexity: (() => {
      const squares = pattern[row].map((value) => value * value);
      const sum = squares.reduce((total, value) => total + value, 0);
      const sumSquares = squares.reduce((total, value) => total + value * value, 0);
      return sumSquares > 0 ? sum * sum / sumSquares : null;
    })() }));
    const ssLoadings = factorNames.map((_, factor) => (options.rotation === "promax" ? structure : pattern).reduce((total, row) => total + row[factor] * (options.rotation === "promax" ? pattern[loadingRowIndexPlaceholder(row, structure)] : row)[factor], 0));
    let cumulative = 0;
    const varianceRows = factorNames.map((name, factor) => {
      const ss = ssLoadings[factor];
      cumulative += ss / p;
      return { factor: name, ssLoadings: ss, proportionVariance: ss / p, cumulativeVariance: cumulative };
    });
    const eigenRows = observed.map((value, index) => ({ component: index + 1, observedEigenvalue: value, parallelMean: parallel[index].mean, parallelThreshold95: parallel[index].quantile95, exceedsParallel: value > parallel[index].quantile95, retainedFactor: index < k }));
    const phiRows = factorNames.map((name, a) => { const row = { factor: name }; factorNames.forEach((other, b) => { row[other] = phi[a][b]; }); return row; });
    const adequacy = S.samplingAdequacy(R, n);
    const dfModel = ((p - k) ** 2 - (p + k)) / 2;
    const tests = [];
    if (adequacy.bartlett.status === "evaluated") tests.push({ name: "Bartlett test of sphericity", statistic: adequacy.bartlett.statistic, distribution: "chi-square", df: adequacy.bartlett.df, pValue: adequacy.bartlett.pValue });
    let likelihoodRatio = { name: "maximum-likelihood factor model fit", status: "not_applicable", reason: `${options.extraction} extraction has no likelihood-ratio statistic` };
    if (options.extraction === "ml") {
      if (dfModel > 0) {
        const statistic = Math.max(0, (n - 1 - (2 * p + 5) / 6 - 2 * k / 3) * extraction.objective);
        likelihoodRatio = { name: "maximum-likelihood factor model fit", status: "asymptotic", statistic, df: dfModel, pValue: S.chiSquareSurvival(statistic, dfModel), method: "Bartlett-corrected likelihood ratio chi-square (large-sample, multivariate normality)" };
        tests.push({ name: "likelihood-ratio test of k-factor sufficiency", statistic, distribution: "chi-square", df: dfModel, pValue: likelihoodRatio.pValue });
      } else likelihoodRatio = { name: "maximum-likelihood factor model fit", status: "not_evaluated", reason: "model degrees of freedom are not positive" };
    }
    const heywood = extraction.uniquenesses.some((value) => value <= 0.005 + 1e-9);
    const columnsLoading = [{ key: "variable", label: "Variable", type: "string" }, { key: "factor", label: "Factor", type: "string" }, { key: "loading", label: options.rotation === "promax" ? "Pattern loading" : "Loading", type: "number" }, { key: "structure", label: "Structure", type: "number" }, { key: "unrotated", label: "Unrotated", type: "number" }];
    return {
      sample: { n, variables: p, factors: k, factorSelection: options.factors === null ? "parallel-analysis" : "user", identifiabilityBound: parsed.ledermannBound },
      estimates: estimateEntries({
        extraction: options.extraction,
        rotation: options.rotation,
        factors: k,
        suggestedFactors: suggested,
        loadings: loadingRows,
        communalities: communalityRows,
        varianceExplained: varianceRows,
        factorCorrelations: phiRows,
        rotationMatrix,
        eigenvalues: eigenRows,
        rmsr,
        fitOffDiagonal: correlationSquares > 0 ? 1 - residualSquares / correlationSquares : null,
        objective: extraction.objective,
        rendererDataContract: rendererContract(H, loadingRows, { eigenRowsHash: H.sha256(eigenRows) }),
      }),
      tests,
      confidenceIntervals: [],
      effectSizes: [{ name: "cumulative proportion of variance (retained factors)", estimate: varianceRows[k - 1].cumulativeVariance }, { name: "root mean square off-diagonal residual", estimate: rmsr }],
      assumptions: [
        { name: "interval-scaled continuous indicators", status: "requires_design_review" },
        { name: "linear common-factor structure", status: "requires_residual_review", rmsr },
        { name: "multivariate normality", status: options.extraction === "ml" ? "required_for_likelihood_ratio_test" : "not_required_for_extraction" },
        { name: "sampling adequacy", status: adequacy.kmo.status === "evaluated" ? (adequacy.kmo.overall >= 0.6 ? "adequate_screen" : "weak_screen") : "not_evaluated", ...(adequacy.kmo.status === "evaluated" ? { kmo: adequacy.kmo.overall } : {}) },
      ],
      diagnostics: [
        adequacy.kmo, adequacy.bartlett, likelihoodRatio,
        { name: "parallel analysis", status: "evaluated", method: "Horn parallel analysis on correlation eigenvalues of seeded standard-normal data; 95th percentile threshold", iterations: options.parallelIterations, seed: options.seed, suggestedFactors: suggested, boundary: "screen for the number of factors, not a test of model adequacy" },
        { name: "extraction convergence", status: extraction.converged ? "converged" : "not_converged", iterations: extraction.iterations, ...(extraction.gradientNorm === undefined ? {} : { gradientNorm: extraction.gradientNorm }), objective: extraction.objective },
        { name: "Heywood case screen", status: heywood ? "boundary" : "clear", detail: heywood ? "at least one uniqueness sits at the 0.005 lower bound; the solution is improper and loadings should not be interpreted" : "all uniquenesses are inside (0.005, 1)" },
        { name: "rotation", status: "evaluated", rotation: options.rotation, kaiserNormalize: options.kaiserNormalize, ...(options.rotation === "promax" ? { promaxPower: options.promaxPower } : {}), varimaxSweeps, boundary: "rotated solutions are ordered by sum of squared loadings with column sums made positive" },
        { name: "renderer exact-data contract", status: "verified", loadingRows: loadingRows.length, loadingRowsHash: H.sha256(loadingRows), eigenRowsHash: H.sha256(eigenRows) },
      ],
      artifacts: [
        H.tableArtifact("Factor loadings", `${options.extraction} extraction with ${options.rotation} rotation (${k} factor${k > 1 ? "s" : ""}).`, columnsLoading, loadingRows, [options.rotation === "promax" ? "Pattern loadings are regression weights; structure loadings are variable-factor correlations (pattern times factor correlation matrix)." : "For orthogonal solutions pattern and structure loadings coincide."], "efa-loading-table"),
        H.tableArtifact("Communalities and uniquenesses", "Communality is the sum of squared unrotated loadings; uniqueness is the extraction's residual variance.", [{ key: "variable", label: "Variable", type: "string" }, { key: "communality", label: "Communality", type: "number" }, { key: "uniqueness", label: "Uniqueness", type: "number" }, { key: "complexity", label: "Hoffman complexity", type: "number" }], communalityRows, [], "efa-communality-table"),
        H.tableArtifact("Variance explained", "Sum of squared loadings per factor.", [{ key: "factor", label: "Factor", type: "string" }, { key: "ssLoadings", label: "SS loadings", type: "number" }, { key: "proportionVariance", label: "Proportion", type: "number" }, { key: "cumulativeVariance", label: "Cumulative", type: "number" }], varianceRows, [options.rotation === "promax" ? "Oblique SS loadings use structure times pattern weights and are not additive across correlated factors." : ""].filter(Boolean), "efa-variance-table"),
        H.tableArtifact("Factor correlation matrix", "Identity for orthogonal rotations.", [{ key: "factor", label: "Factor", type: "string" }, ...factorNames.map((name) => ({ key: name, label: name, type: "number" }))], phiRows, [], "efa-factor-correlation-table"),
        H.tableArtifact("Eigenvalues and parallel analysis", "Observed correlation eigenvalues against seeded random-data thresholds.", [{ key: "component", label: "Component", type: "number" }, { key: "observedEigenvalue", label: "Observed", type: "number" }, { key: "parallelMean", label: "Random mean", type: "number" }, { key: "parallelThreshold95", label: "Random 95th", type: "number" }, { key: "exceedsParallel", label: "Exceeds", type: "boolean" }, { key: "retainedFactor", label: "Retained", type: "boolean" }], eigenRows, [], "efa-eigenvalue-table"),
        H.vegaArtifact("efa-scree-parallel", "Scree plot with parallel-analysis threshold", {
          data: { values: eigenRows },
          layer: [
            { mark: { type: "line", point: true, color: "#285F8F" }, encoding: { x: { field: "component", type: "ordinal", title: "Component" }, y: { field: "observedEigenvalue", type: "quantitative", title: "Eigenvalue" }, tooltip: [{ field: "component" }, { field: "observedEigenvalue", format: ".4f" }, { field: "parallelThreshold95", format: ".4f" }] } },
            { mark: { type: "line", point: true, color: "#A36D47", strokeDash: [6, 4] }, encoding: { x: { field: "component", type: "ordinal" }, y: { field: "parallelThreshold95", type: "quantitative" } } },
          ],
        }),
        H.vegaArtifact("efa-loading-heatmap", "Factor loading heatmap", { data: { values: loadingRows }, mark: "rect", encoding: { x: { field: "factor", type: "ordinal", title: "Factor" }, y: { field: "variable", type: "nominal", title: null }, color: { field: "loading", type: "quantitative", scale: { scheme: "redblue", domainMid: 0, domain: [-1, 1] }, title: "Loading" }, tooltip: [{ field: "variable" }, { field: "factor" }, { field: "loading", format: ".3f" }] } }),
      ],
    };
  },
  linkage: {
    neededWhen: "When a battery of observed indicators is believed to reflect a smaller number of latent constructs and the researcher must decide how many factors to retain and how to interpret them before building scales or structural models.",
    decision: "How many common factors are defensible, which rotation yields interpretable simple structure, and whether any indicator should be dropped because of low communality or cross-loading.",
    mustShow: "Observed versus parallel-analysis eigenvalues, the rotated loading matrix, communalities and uniquenesses, factor correlations for oblique solutions, residual fit, and the sampling-adequacy screens.",
    userGoal: "Reduce the indicator set to interpretable latent dimensions without over- or under-extracting, and document the evidence for the chosen solution.",
    nextActions: [
      { trigger: "kmo-below-0-6-or-bartlett-not-significant", action: "review-indicator-correlations-before-factoring", reason: "Weak shared variance makes any factor solution unstable and the loadings uninterpretable." },
      { trigger: "heywood-case-or-non-convergence", action: "reduce-factors-or-switch-extraction", reason: "An improper solution signals over-extraction or a misspecified factor count that must be corrected before interpretation." },
      { trigger: "cross-loadings-above-0-3", action: "compare-oblique-and-orthogonal-rotations", reason: "Correlated factors are often the reason indicators load on several orthogonal factors; the oblique solution should be inspected." },
      { trigger: "solution-accepted", action: "freeze-factor-model-for-confirmatory-analysis", reason: "Exploratory results should be confirmed on independent data before being used as measurement models." },
    ],
  },
  fixture: { data: { variables: FACTOR_BATTERY }, options: { extraction: "minres", rotation: "varimax", factors: 2, seed: 7 } },
  matlabParity: { taxonomyIds: ["matlab.stats.dimensionality-reduction-feature-extraction"] },
  coverage: {
    implementedBoundary: "Pearson-correlation exploratory factor analysis with principal-axis, minres (ULS), and maximum-likelihood extraction; varimax (Kaiser-normalised) and promax rotation; seeded Horn parallel analysis for factor count; KMO, Bartlett, RMSR, and (ML only) a Bartlett-corrected likelihood-ratio test.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["principal-axis loadings and uniquenesses against statsmodels Factor(method=pa)", "ML uniquenesses and objective against statsmodels Factor(method=ml)", "varimax loadings against statsmodels rotate_factors with Kaiser normalisation applied in the oracle", "promax pattern and factor correlations against an independent numpy transcription of R stats::promax", "KMO and Bartlett sphericity against numpy"], excludedOutputs: ["minres loadings are checked only against the converged principal-axis solution (same ULS fixed point) and gradient stationarity", "parallel-analysis thresholds (seeded generator specific; only the retained count is verified)", "factor scores (not emitted)"] },
    diagnostic: { level: "method-specific-partial", emitted: ["Kaiser-Meyer-Olkin", "Bartlett sphericity", "parallel analysis", "extraction convergence", "Heywood case screen", "maximum-likelihood factor model fit"], limitations: ["no factor scores", "no oblimin/geomin rotations", "no polychoric or robust correlation inputs", "likelihood-ratio test is asymptotic and assumes multivariate normality"] },
    knownGaps: ["oblimin, geomin, and target rotations", "factor score estimation (regression, Bartlett)", "polychoric correlations for ordinal indicators", "bootstrap or analytic standard errors for loadings"],
  },
};

function loadingRowIndexPlaceholder(row, structure) {
  return structure.indexOf(row);
}

// ---------------------------------------------------------------------------------------------
// MANOVA (one factor).
// ---------------------------------------------------------------------------------------------

function canonicalScores(columns, overallMean, rawVectors, withinScale, count) {
  const n = columns[0].length;
  const scale = Math.sqrt(withinScale);
  const vectors = rawVectors.slice(0, count).map((vector) => vector.map((value) => value * scale));
  const rows = Array.from({ length: n }, (_, row) => vectors.map((vector) => vector.reduce((total, value, index) => total + value * (columns[index][row] - overallMean[index]), 0)));
  return { vectors, rows };
}

const manova = {
  method: "manova",
  family: FAMILY,
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["timeoutMs"],
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["variables", "groups"],
    properties: {
      variables: { type: "array", minItems: 2, maxItems: 32, items: { type: "object", additionalProperties: false, required: ["values"], properties: { name: { type: "string", minLength: 1, maxLength: 128 }, values: { type: "array", minItems: 6, maxItems: 10000, items: { type: "number" } } } } },
      groups: { type: "array", minItems: 6, maxItems: 10000, items: { type: "string", minLength: 1, maxLength: 128 } },
      groupLabel: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["variables", "groups", "groupLabel"], "data");
    const matrix = S.parseVariableMatrix(data, H, { minRows: 6, minVariables: 2, maxVariables: 32 });
    const grouping = parseGroupsVector(data.groups, matrix.rowCount, H, { minLevels: 2, minPerLevel: 2 });
    if (matrix.rowCount - grouping.levels.length < matrix.variables.length) H.fail("STAT_INSUFFICIENT_SAMPLE", "MANOVA requires residual degrees of freedom of at least the number of response variables");
    return { ...matrix, ...grouping, groupLabel: H.label(data.groupLabel, "Group", "data.groupLabel") };
  },
  analyze(parsed, options, budget, H) {
    const columns = variableColumns(parsed);
    const n = parsed.rowCount;
    const p = columns.length;
    const g = parsed.levels.length;
    const partition = groupPartition(columns, parsed.groups, parsed.levels);
    const dfHypothesis = g - 1;
    const dfResidual = n - g;
    const relative = relativeEigen(H, partition.within, partition.between, budget);
    const statistics = multivariateTestStatistics(relative.values, dfHypothesis, dfResidual);
    const s = Math.min(p, dfHypothesis);
    const pooledCovariance = partition.within.map((row) => row.map((value) => value / dfResidual));
    const box = boxM(parsed.levels, parsed.counts, partition.groupCovariance, pooledCovariance, p);
    const testRows = statistics.map((row) => ({ statistic: row.statistic, value: row.value, approximateF: row.f, df1: row.df1, df2: row.df2, pValue: row.pValue }));
    const meanRows = [];
    for (const level of parsed.levels) {
      for (let variable = 0; variable < p; variable += 1) {
        meanRows.push({ group: level, variable: parsed.variables[variable].name, n: parsed.counts[level], mean: partition.groupMeans[level][variable], sd: partition.groupCovariance[level] ? Math.sqrt(partition.groupCovariance[level][variable][variable]) : null });
      }
    }
    const canonical = canonicalScores(columns, partition.overallMean, relative.rawVectors, dfResidual, Math.max(1, s));
    const scoreRows = Array.from({ length: n }, (_, row) => ({ row: row + 1, label: parsed.rowLabels[row], group: parsed.groups[row], axis1: canonical.rows[row][0], axis2: s >= 2 ? canonical.rows[row][1] : 0 }));
    const wilks = statistics[1];
    const pillai = statistics[0];
    const etaWilks = 1 - Math.pow(wilks.value, 1 / s);
    const univariate = parsed.variables.map((variable, index) => {
      const ssBetween = partition.between[index][index];
      const ssWithin = partition.within[index][index];
      const f = (ssBetween / dfHypothesis) / (ssWithin / dfResidual);
      return { variable: variable.name, ssBetween, ssWithin, f, df1: dfHypothesis, df2: dfResidual, pValue: S.fSurvival(f, dfHypothesis, dfResidual) };
    });
    const figure = s >= 2
      ? H.vegaArtifact("manova-canonical-plot", "Group separation on canonical discriminant axes", { data: { values: scoreRows }, mark: { type: "point", filled: true, size: 70, opacity: 0.85 }, encoding: { x: { field: "axis1", type: "quantitative", title: "Canonical axis 1" }, y: { field: "axis2", type: "quantitative", title: "Canonical axis 2" }, color: { field: "group", type: "nominal", title: parsed.groupLabel }, tooltip: [{ field: "label" }, { field: "group" }, { field: "axis1", format: ".3f" }, { field: "axis2", format: ".3f" }] } })
      : H.vegaArtifact("manova-canonical-plot", "Group separation on the canonical discriminant axis", { data: { values: scoreRows }, mark: { type: "tick", thickness: 2 }, encoding: { x: { field: "axis1", type: "quantitative", title: "Canonical axis 1" }, y: { field: "group", type: "nominal", title: parsed.groupLabel }, color: { field: "group", type: "nominal", legend: null }, tooltip: [{ field: "label" }, { field: "axis1", format: ".3f" }] } });
    return {
      sample: { n, variables: p, groups: g, groupCounts: parsed.counts, dfHypothesis, dfResidual },
      estimates: estimateEntries({
        eigenvalues: relative.values.slice(0, s),
        statistics: testRows,
        groupMeans: meanRows,
        univariateFollowUp: univariate,
        canonicalCoefficients: canonical.vectors.map((vector, index) => ({ axis: `axis${index + 1}`, coefficients: Object.fromEntries(vector.map((value, variable) => [parsed.variables[variable].name, value])) })),
        rendererDataContract: rendererContract(H, scoreRows),
      }),
      tests: testRows.map((row) => ({ name: row.statistic, statistic: row.value, distribution: "F approximation", f: row.approximateF, df1: row.df1, df2: row.df2, pValue: row.pValue })),
      confidenceIntervals: [],
      effectSizes: [{ name: "partial eta squared (Pillai V / s)", estimate: pillai.value / s }, { name: "multivariate eta squared (1 - Wilks lambda^(1/s))", estimate: etaWilks }],
      assumptions: [
        { name: "independent observations", status: "requires_design_review" },
        { name: "multivariate normality within groups", status: "not_tested", detail: "no multivariate normality test is emitted; inspect residuals" },
        { name: "homogeneity of covariance matrices", status: box.status === "evaluated" ? (box.pValue < 0.05 ? "questionable" : "consistent") : "not_evaluated", ...(box.status === "evaluated" ? { boxMPValue: box.pValue } : {}) },
        { name: "no multicollinearity among responses", status: "verified_by_full_rank_within_sscp" },
      ],
      diagnostics: [
        box,
        { name: "F approximation boundary", status: "asymptotic", detail: "Pillai and Wilks use the Pillai and Rao F approximations, Hotelling-Lawley uses the McKeon (1974) approximation of SAS PROC GLM and statsmodels, and Roy's largest root is an upper bound rather than an exact F." },
        { name: "canonical axes", status: "descriptive", axes: Math.max(1, s), detail: "canonical scores are centred at the grand mean and scaled to unit pooled within-group variance" },
        { name: "renderer exact-data contract", status: "verified", rows: scoreRows.length, rowsHash: H.sha256(scoreRows) },
      ],
      artifacts: [
        H.tableArtifact("Multivariate tests", `One-way MANOVA of ${p} responses across ${g} ${parsed.groupLabel} levels.`, [{ key: "statistic", label: "Statistic", type: "string" }, { key: "value", label: "Value", type: "number" }, { key: "approximateF", label: "Approx. F", type: "number" }, { key: "df1", label: "df1", type: "number" }, { key: "df2", label: "df2", type: "number" }, { key: "pValue", label: "p", type: "number" }], testRows, ["Roy's largest root F is an upper bound on significance."], "manova-test-table"),
        H.tableArtifact("Group means", "Per-group means and standard deviations of each response.", [{ key: "group", label: parsed.groupLabel, type: "string" }, { key: "variable", label: "Variable", type: "string" }, { key: "n", label: "n", type: "number" }, { key: "mean", label: "Mean", type: "number" }, { key: "sd", label: "SD", type: "number" }], meanRows, [], "manova-group-means-table"),
        H.tableArtifact("Univariate follow-up ANOVAs", "Unadjusted per-response one-way F tests.", [{ key: "variable", label: "Variable", type: "string" }, { key: "ssBetween", label: "SS between", type: "number" }, { key: "ssWithin", label: "SS within", type: "number" }, { key: "f", label: "F", type: "number" }, { key: "df1", label: "df1", type: "number" }, { key: "df2", label: "df2", type: "number" }, { key: "pValue", label: "p", type: "number" }], univariate, ["p values are not adjusted for multiple responses."], "manova-univariate-table"),
        H.tableArtifact("Canonical scores", "Observation scores on the discriminant axes used by the figure.", [{ key: "row", label: "Row", type: "number" }, { key: "label", label: "Label", type: "string" }, { key: "group", label: parsed.groupLabel, type: "string" }, { key: "axis1", label: "Axis 1", type: "number" }, { key: "axis2", label: "Axis 2", type: "number" }], scoreRows, [s >= 2 ? "" : "Only one canonical axis exists; axis2 is reported as zero."].filter(Boolean), "manova-canonical-score-table"),
        figure,
      ],
    };
  },
  linkage: {
    neededWhen: "When several correlated response variables are compared across the levels of one factor and separate ANOVAs would inflate error rates or miss a joint difference.",
    decision: "Whether the group centroids differ on the joint response profile, and which multivariate criterion and follow-up analyses are defensible given covariance homogeneity.",
    mustShow: "All four multivariate statistics with their F approximations, group means, Box's M covariance screen, univariate follow-ups, and the canonical-axis separation of groups.",
    userGoal: "Establish a joint group effect before interpreting per-response differences, and choose the criterion that matches the covariance structure.",
    nextActions: [
      { trigger: "box-m-rejects-and-unequal-group-sizes", action: "prefer-pillai-and-review-covariance-heterogeneity", reason: "Pillai's trace is the most robust criterion when covariance matrices differ and cell sizes are unequal." },
      { trigger: "joint-effect-significant", action: "run-protected-univariate-or-discriminant-follow-up", reason: "A joint difference must be decomposed to learn which responses separate the groups." },
      { trigger: "joint-effect-not-significant", action: "stop-univariate-follow-up-and-report-multivariate-null", reason: "Follow-up tests after a null multivariate result inflate false-positive claims." },
    ],
  },
  fixture: { data: { variables: IRIS_VARIABLES, groups: IRIS_GROUPS, groupLabel: "species" } },
  matlabParity: { taxonomyIds: ["matlab.stats.anova"] },
  coverage: {
    implementedBoundary: "One-factor MANOVA with Pillai, Wilks (Rao F), Hotelling-Lawley (McKeon F), and Roy statistics using the SAS PROC GLM / statsmodels F approximations, Box's M covariance-homogeneity screen, univariate follow-up ANOVAs, and canonical discriminant scores.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["Pillai, Wilks, Hotelling-Lawley, and Roy statistic values against statsmodels MANOVA", "Pillai, Wilks, and Hotelling-Lawley F, df, and p against statsmodels MANOVA", "Box's M against a numpy transcription of the Box (1949) statistic"], excludedOutputs: ["Roy largest root F approximation (upper bound only)", "canonical scores (sign and scale conventions)"] },
    diagnostic: { level: "method-specific-partial", emitted: ["Box M covariance homogeneity", "F approximation boundary", "canonical axes"], limitations: ["no multivariate normality test", "one factor only", "no covariates (MANCOVA)"] },
    knownGaps: ["factorial and repeated-measures MANOVA", "MANCOVA", "multivariate normality tests", "post hoc contrasts on canonical variates"],
  },
};

// ---------------------------------------------------------------------------------------------
// Hotelling T².
// ---------------------------------------------------------------------------------------------

const hotellingT2 = {
  method: "hotelling_t2",
  family: FAMILY,
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["variables"],
    properties: {
      variables: { type: "array", minItems: 2, maxItems: 32, items: { type: "object", additionalProperties: false, required: ["values"], properties: { name: { type: "string", minLength: 1, maxLength: 128 }, values: { type: "array", minItems: 4, maxItems: 10000, items: { type: "number" } } } } },
      groups: { type: "array", minItems: 4, maxItems: 10000, items: { type: "string", minLength: 1, maxLength: 128 } },
      mu0: { type: "array", minItems: 2, maxItems: 32, items: { type: "number" } },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["variables", "groups", "mu0"], "data");
    const matrix = S.parseVariableMatrix(data, H, { minRows: 4, minVariables: 2, maxVariables: 32 });
    const p = matrix.variables.length;
    if (data.groups !== undefined && data.mu0 !== undefined) H.fail("STAT_INVALID_INPUT", "supply either data.groups (two-sample) or data.mu0 (one-sample), not both");
    if (data.groups !== undefined) {
      const grouping = parseGroupsVector(data.groups, matrix.rowCount, H, { minLevels: 2, maxLevels: 2, minPerLevel: 2 });
      if (matrix.rowCount - 2 < p) H.fail("STAT_INSUFFICIENT_SAMPLE", "two-sample Hotelling T2 requires n1 + n2 - 2 >= number of variables");
      return { ...matrix, design: "two-sample", ...grouping, mu0: null };
    }
    const mu0 = data.mu0 === undefined ? Array(p).fill(0) : H.numericVector(data.mu0, "data.mu0", 2);
    if (mu0.length !== p) H.fail("STAT_INVALID_INPUT", "data.mu0 length must match the number of variables");
    if (matrix.rowCount - 1 < p) H.fail("STAT_INSUFFICIENT_SAMPLE", "one-sample Hotelling T2 requires n - 1 >= number of variables");
    return { ...matrix, design: "one-sample", mu0, groups: null, levels: null, counts: null };
  },
  analyze(parsed, options, budget, H) {
    const columns = variableColumns(parsed);
    const n = parsed.rowCount;
    const p = columns.length;
    const names = parsed.variables.map((variable) => variable.name);
    let difference;
    let covariance;
    let scale;
    let dfResidual;
    let sampleSummary;
    let box = { name: "Box M covariance homogeneity", status: "not_applicable", reason: "one-sample design" };
    let groupMeans = null;
    if (parsed.design === "one-sample") {
      const means = S.columnMeans(columns);
      difference = means.map((value, index) => value - parsed.mu0[index]);
      covariance = S.sampleCovariance(columns, budget);
      scale = n;
      dfResidual = n - 1;
      sampleSummary = { n, variables: p, design: "one-sample", mu0: Object.fromEntries(names.map((name, index) => [name, parsed.mu0[index]])) };
      groupMeans = [{ group: "sample", means }];
    } else {
      const partition = groupPartition(columns, parsed.groups, parsed.levels);
      const [a, b] = parsed.levels;
      const na = parsed.counts[a];
      const nb = parsed.counts[b];
      difference = partition.groupMeans[a].map((value, index) => value - partition.groupMeans[b][index]);
      dfResidual = n - 2;
      covariance = partition.within.map((row) => row.map((value) => value / dfResidual));
      scale = (na * nb) / (na + nb);
      sampleSummary = { n, variables: p, design: "two-sample", groups: parsed.counts, contrast: `${a} - ${b}` };
      box = boxM(parsed.levels, parsed.counts, partition.groupCovariance, covariance, p);
      groupMeans = parsed.levels.map((level) => ({ group: level, means: partition.groupMeans[level] }));
    }
    const lower = S.cholesky(covariance);
    if (!lower) H.fail("STAT_SINGULAR_FIT", "covariance matrix is not positive definite");
    const solved = S.choleskySolve(lower, difference);
    const t2 = scale * difference.reduce((total, value, index) => total + value * solved[index], 0);
    const dfF2 = dfResidual - p + 1;
    if (dfF2 < 1) H.fail("STAT_INSUFFICIENT_SAMPLE", "Hotelling T2 F transformation requires more residual degrees of freedom than variables");
    const f = (dfF2 / (p * dfResidual)) * t2;
    const pValue = S.fSurvival(f, p, dfF2);
    const fCritical = S.fQuantile(options.confidenceLevel, p, dfF2);
    const t2Critical = (p * dfResidual / dfF2) * fCritical;
    const bonferroniT = S.tQuantile(1 - (1 - options.confidenceLevel) / (2 * p), dfResidual);
    const intervalRows = names.map((name, index) => {
      const se = Math.sqrt(covariance[index][index] / scale);
      return { variable: name, difference: difference[index], standardError: se, simultaneousLower: difference[index] - Math.sqrt(t2Critical) * se, simultaneousUpper: difference[index] + Math.sqrt(t2Critical) * se, bonferroniLower: difference[index] - bonferroniT * se, bonferroniUpper: difference[index] + bonferroniT * se };
    });
    const mahalanobis = t2 / scale;
    return {
      sample: sampleSummary,
      estimates: estimateEntries({
        design: parsed.design,
        meanDifference: Object.fromEntries(names.map((name, index) => [name, difference[index]])),
        groupMeans: groupMeans.map((entry) => ({ group: entry.group, ...Object.fromEntries(names.map((name, index) => [name, entry.means[index]])) })),
        covariance: covariance.map((row, index) => ({ variable: names[index], ...Object.fromEntries(names.map((name, column) => [name, row[column]])) })),
        t2, f, df1: p, df2: dfF2, pValue, t2Critical, intervals: intervalRows,
        rendererDataContract: rendererContract(H, intervalRows),
      }),
      tests: [{ name: `Hotelling T2 (${parsed.design})`, statistic: t2, distribution: "F transformation", f, df1: p, df2: dfF2, pValue }],
      confidenceIntervals: intervalRows.map((row) => ({ parameter: `${row.variable} mean difference`, estimate: row.difference, lower: row.simultaneousLower, upper: row.simultaneousUpper, level: options.confidenceLevel, method: "T2 simultaneous (Scheffe-type)" })),
      effectSizes: [{ name: "Mahalanobis D squared", estimate: mahalanobis }, { name: "Mahalanobis D", estimate: Math.sqrt(Math.max(0, mahalanobis)) }],
      assumptions: [
        { name: "independent observations", status: "requires_design_review" },
        { name: "multivariate normality", status: "not_tested" },
        { name: "equal covariance matrices", status: parsed.design === "two-sample" ? (box.status === "evaluated" ? (box.pValue < 0.05 ? "questionable" : "consistent") : "not_evaluated") : "not_applicable" },
      ],
      diagnostics: [
        box,
        { name: "interval construction", status: "evaluated", detail: "simultaneous intervals use the T2 critical value; Bonferroni intervals divide alpha across variables", level: options.confidenceLevel },
        { name: "renderer exact-data contract", status: "verified", rows: intervalRows.length, rowsHash: H.sha256(intervalRows) },
      ],
      artifacts: [
        H.tableArtifact("Hotelling T2 test", parsed.design === "one-sample" ? "One-sample test of the mean vector against mu0." : "Two-sample test of mean-vector equality with pooled covariance.", [{ key: "statistic", label: "Statistic", type: "string" }, { key: "value", label: "Value", type: "number" }, { key: "df1", label: "df1", type: "number" }, { key: "df2", label: "df2", type: "number" }, { key: "pValue", label: "p", type: "number" }], [{ statistic: "T2", value: t2, df1: p, df2: dfF2, pValue }, { statistic: "F", value: f, df1: p, df2: dfF2, pValue }], [], "hotelling-test-table"),
        H.tableArtifact("Mean differences with simultaneous intervals", `${Math.round(options.confidenceLevel * 100)}% T2 simultaneous and Bonferroni intervals per variable.`, [{ key: "variable", label: "Variable", type: "string" }, { key: "difference", label: "Difference", type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "simultaneousLower", label: "Simultaneous lower", type: "number" }, { key: "simultaneousUpper", label: "Simultaneous upper", type: "number" }, { key: "bonferroniLower", label: "Bonferroni lower", type: "number" }, { key: "bonferroniUpper", label: "Bonferroni upper", type: "number" }], intervalRows, [], "hotelling-interval-table"),
        H.vegaArtifact("hotelling-difference-plot", "Mean differences with T2 simultaneous intervals", {
          data: { values: intervalRows },
          layer: [
            { mark: { type: "rule", strokeWidth: 2, color: "#285F8F" }, encoding: { y: { field: "variable", type: "nominal", title: null }, x: { field: "simultaneousLower", type: "quantitative", title: "Mean difference" }, x2: { field: "simultaneousUpper" } } },
            { mark: { type: "point", filled: true, size: 80, color: "#1F1D1B" }, encoding: { y: { field: "variable", type: "nominal" }, x: { field: "difference", type: "quantitative" }, tooltip: [{ field: "variable" }, { field: "difference", format: ".4g" }, { field: "simultaneousLower", format: ".4g" }, { field: "simultaneousUpper", format: ".4g" }] } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When a vector of correlated measurements must be compared to a hypothesised profile or between two groups and separate t tests would ignore the correlation and inflate error.",
    decision: "Whether the mean vector differs jointly, and which individual variables carry the difference once simultaneous coverage is enforced.",
    mustShow: "The T2 statistic with its F transformation, the mean-difference vector, simultaneous and Bonferroni intervals per variable, and the covariance-equality screen for two-sample designs.",
    userGoal: "Test a multivariate mean hypothesis with controlled overall error and identify the responsible variables.",
    nextActions: [
      { trigger: "joint-difference-significant", action: "inspect-simultaneous-intervals-for-responsible-variables", reason: "The joint rejection must be attributed to specific variables with intervals that preserve overall coverage." },
      { trigger: "box-m-rejects-covariance-equality", action: "consider-james-or-yao-approximate-test", reason: "The pooled-covariance T2 is not valid under strongly unequal covariance matrices." },
      { trigger: "sample-size-close-to-variable-count", action: "reduce-variables-or-collect-more-observations", reason: "With few residual degrees of freedom the covariance estimate is unstable and power collapses." },
    ],
  },
  fixture: { data: { variables: IRIS_VARIABLES.map((variable) => ({ name: variable.name, values: variable.values.slice(0, 16) })), groups: IRIS_GROUPS.slice(0, 16) } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.location"] },
  coverage: {
    implementedBoundary: "One-sample and two-sample (pooled covariance) Hotelling T2 with the exact F transformation, T2 simultaneous and Bonferroni intervals, Mahalanobis distance, and Box's M for the two-sample design.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["T2, F, df, and p against numpy/scipy transcriptions for both designs", "simultaneous and Bonferroni interval bounds against scipy critical values", "Box's M against numpy"], excludedOutputs: ["James/Yao unequal-covariance tests (not implemented)"] },
    diagnostic: { level: "method-specific-partial", emitted: ["Box M covariance homogeneity", "interval construction"], limitations: ["no multivariate normality test", "paired design must be entered as differences"] },
    knownGaps: ["unequal-covariance two-sample tests", "robust or permutation T2", "paired multivariate design helper"],
  },
};

// ---------------------------------------------------------------------------------------------
// Linear / quadratic discriminant analysis.
// ---------------------------------------------------------------------------------------------

function classifyLinear(x, means, precision, logPriors, levels) {
  let best = null;
  const scores = levels.map((level, index) => {
    const mean = means[level];
    const projected = S.multiplyVector(precision, mean);
    const score = x.reduce((total, value, axis) => total + value * projected[axis], 0) - 0.5 * mean.reduce((total, value, axis) => total + value * projected[axis], 0) + logPriors[index];
    if (best === null || score > best.score) best = { level, score };
    return score;
  });
  const maximum = Math.max(...scores);
  const weights = scores.map((score) => Math.exp(score - maximum));
  const total = weights.reduce((sum, value) => sum + value, 0);
  return { predicted: best.level, posterior: weights.map((value) => value / total) };
}

function classifyQuadratic(x, means, precisions, logDeterminants, logPriors, levels) {
  let best = null;
  const scores = levels.map((level, index) => {
    const centered = x.map((value, axis) => value - means[level][axis]);
    const score = logPriors[index] - 0.5 * logDeterminants[level] - 0.5 * quadraticForm(centered, precisions[level]);
    if (best === null || score > best.score) best = { level, score };
    return score;
  });
  const maximum = Math.max(...scores);
  const weights = scores.map((score) => Math.exp(score - maximum));
  const total = weights.reduce((sum, value) => sum + value, 0);
  return { predicted: best.level, posterior: weights.map((value) => value / total) };
}

function downdateSscp(sscpMatrix, mean, x, count) {
  const factor = count / (count - 1);
  return sscpMatrix.map((row, i) => row.map((value, j) => value - factor * (x[i] - mean[i]) * (x[j] - mean[j])));
}

const linearDiscriminantAnalysis = {
  method: "linear_discriminant_analysis",
  family: FAMILY,
  analysisModel: { families: ["classification-evaluation"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["timeoutMs"],
  customOptions: {
    discriminant: { schema: { type: "string", enum: ["linear", "quadratic"] }, default: "linear", parse(value, H, path) { if (!["linear", "quadratic"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be linear or quadratic`); return value; } },
    priors: { schema: { type: "string", enum: ["proportional", "equal"] }, default: "proportional", parse(value, H, path) { if (!["proportional", "equal"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be proportional or equal`); return value; } },
    crossValidation: { schema: { type: "boolean" }, default: true, parse(value, H, path) { if (typeof value !== "boolean") H.fail("STAT_INVALID_INPUT", `${path} must be boolean`); return value; } },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["variables", "groups"],
    properties: {
      variables: { type: "array", minItems: 2, maxItems: 32, items: { type: "object", additionalProperties: false, required: ["values"], properties: { name: { type: "string", minLength: 1, maxLength: 128 }, values: { type: "array", minItems: 6, maxItems: 10000, items: { type: "number" } } } } },
      groups: { type: "array", minItems: 6, maxItems: 10000, items: { type: "string", minLength: 1, maxLength: 128 } },
      rowLabels: { type: "array", minItems: 6, maxItems: 10000, items: { type: "string", minLength: 1, maxLength: 128 } },
      groupLabel: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["variables", "groups", "rowLabels", "groupLabel"], "data");
    const matrix = S.parseVariableMatrix(data, H, { minRows: 6, minVariables: 2, maxVariables: 32 });
    const p = matrix.variables.length;
    const grouping = parseGroupsVector(data.groups, matrix.rowCount, H, { minLevels: 2, minPerLevel: options.discriminant === "quadratic" ? p + 2 : 2 });
    if (matrix.rowCount - grouping.levels.length < p) H.fail("STAT_INSUFFICIENT_SAMPLE", "discriminant analysis requires residual degrees of freedom of at least the number of variables");
    return { ...matrix, ...grouping, groupLabel: H.label(data.groupLabel, "Group", "data.groupLabel") };
  },
  analyze(parsed, options, budget, H) {
    const columns = variableColumns(parsed);
    const rows = S.columnsToRows(columns);
    const n = parsed.rowCount;
    const p = columns.length;
    const g = parsed.levels.length;
    const names = parsed.variables.map((variable) => variable.name);
    const partition = groupPartition(columns, parsed.groups, parsed.levels);
    const dfResidual = n - g;
    const priors = parsed.levels.map((level) => (options.priors === "equal" ? 1 / g : parsed.counts[level] / n));
    const logPriors = priors.map((value) => Math.log(value));
    const relative = relativeEigen(H, partition.within, partition.between, budget);
    const functions = Math.min(p, g - 1);
    const eigenvalues = relative.values.slice(0, functions);
    const totalEigen = eigenvalues.reduce((total, value) => total + value, 0);
    const canonical = canonicalScores(columns, Array(p).fill(0), relative.rawVectors, dfResidual, functions);
    const center = names.map((_, axis) => parsed.levels.reduce((total, level, index) => total + priors[index] * partition.groupMeans[level][axis], 0));
    const scoreOf = (x) => canonical.vectors.map((vector) => vector.reduce((total, value, axis) => total + value * (x[axis] - center[axis]), 0));
    const wilksRows = eigenvalues.map((_, k) => {
      let lambda = 1;
      for (let j = k; j < functions; j += 1) lambda /= 1 + eigenvalues[j];
      const statistic = -(n - 1 - (p + g) / 2) * Math.log(lambda);
      const df = (p - k) * (g - k - 1);
      return { functionName: `LD${k + 1}`, eigenvalue: eigenvalues[k], proportionOfTrace: totalEigen > 0 ? eigenvalues[k] / totalEigen : null, canonicalCorrelation: Math.sqrt(eigenvalues[k] / (1 + eigenvalues[k])), wilksLambda: lambda, chiSquare: statistic, df, pValue: df > 0 ? S.chiSquareSurvival(statistic, df) : null };
    });
    const pooledCovariance = partition.within.map((row) => row.map((value) => value / dfResidual));
    const pooledPrecision = S.inverse(pooledCovariance);
    if (!pooledPrecision) H.fail("STAT_SINGULAR_FIT", "pooled within-group covariance is singular");
    let groupPrecision = null;
    let groupLogDeterminant = null;
    if (options.discriminant === "quadratic") {
      groupPrecision = {};
      groupLogDeterminant = {};
      for (const level of parsed.levels) {
        const determinant = S.logAbsDeterminant(partition.groupCovariance[level]);
        const precision = S.inverse(partition.groupCovariance[level]);
        if (!precision || determinant.sign <= 0) H.fail("STAT_SINGULAR_FIT", `covariance matrix of group ${level} is singular`);
        groupPrecision[level] = precision;
        groupLogDeterminant[level] = determinant.logAbs;
      }
    }
    const classify = (x, means, precision, precisions, logDeterminants) => (options.discriminant === "linear"
      ? classifyLinear(x, means, precision, logPriors, parsed.levels)
      : classifyQuadratic(x, means, precisions, logDeterminants, logPriors, parsed.levels));
    const predictionRows = [];
    const resubstitution = Object.fromEntries(parsed.levels.map((actual) => [actual, Object.fromEntries(parsed.levels.map((predicted) => [predicted, 0]))]));
    const leaveOneOut = Object.fromEntries(parsed.levels.map((actual) => [actual, Object.fromEntries(parsed.levels.map((predicted) => [predicted, 0]))]));
    const looEnabled = options.crossValidation && n <= 2000;
    let looCorrect = 0;
    let resubCorrect = 0;
    for (let row = 0; row < n; row += 1) {
      budget.check(p * p);
      const x = rows[row];
      const actual = parsed.groups[row];
      const fit = classify(x, partition.groupMeans, pooledPrecision, groupPrecision, groupLogDeterminant);
      resubstitution[actual][fit.predicted] += 1;
      if (fit.predicted === actual) resubCorrect += 1;
      let looPredicted = null;
      if (looEnabled) {
        const count = parsed.counts[actual];
        const mean = partition.groupMeans[actual];
        const looMeans = { ...partition.groupMeans, [actual]: mean.map((value, axis) => (count * value - x[axis]) / (count - 1)) };
        let looFit;
        if (options.discriminant === "linear") {
          const within = downdateSscp(partition.within, mean, x, count);
          const covariance = within.map((line) => line.map((value) => value / (dfResidual - 1)));
          const precision = S.inverse(covariance);
          if (!precision) H.fail("STAT_SINGULAR_FIT", "leave-one-out pooled covariance became singular");
          looFit = classifyLinear(x, looMeans, precision, logPriors, parsed.levels);
        } else {
          const local = partition.groupCovariance[actual].map((line) => line.map((value) => value * (count - 1)));
          const downdated = downdateSscp(local, mean, x, count).map((line) => line.map((value) => value / (count - 2)));
          const precision = S.inverse(downdated);
          const determinant = S.logAbsDeterminant(downdated);
          if (!precision || determinant.sign <= 0) H.fail("STAT_SINGULAR_FIT", `leave-one-out covariance of group ${actual} became singular`);
          looFit = classifyQuadratic(x, looMeans, { ...groupPrecision, [actual]: precision }, { ...groupLogDeterminant, [actual]: determinant.logAbs }, logPriors, parsed.levels);
        }
        looPredicted = looFit.predicted;
        leaveOneOut[actual][looPredicted] += 1;
        if (looPredicted === actual) looCorrect += 1;
      }
      const scores = scoreOf(x);
      predictionRows.push({ row: row + 1, label: parsed.rowLabels[row], kind: "observation", group: actual, predicted: fit.predicted, leaveOneOutPredicted: looPredicted, maxPosterior: Math.max(...fit.posterior), LD1: scores[0], LD2: functions >= 2 ? scores[1] : 0 });
    }
    const centroidRows = parsed.levels.map((level) => {
      const scores = scoreOf(partition.groupMeans[level]);
      return { row: 0, label: `${level} centroid`, kind: "centroid", group: level, predicted: level, leaveOneOutPredicted: null, maxPosterior: 1, LD1: scores[0], LD2: functions >= 2 ? scores[1] : 0 };
    });
    const scoreRows = [...predictionRows, ...centroidRows];
    const confusionRows = [];
    for (const actual of parsed.levels) for (const predicted of parsed.levels) {
      confusionRows.push({ evaluation: "resubstitution", actual, predicted, count: resubstitution[actual][predicted] });
      if (looEnabled) confusionRows.push({ evaluation: "leave-one-out", actual, predicted, count: leaveOneOut[actual][predicted] });
    }
    const coefficientRows = [];
    for (let axis = 0; axis < p; axis += 1) for (let fn = 0; fn < functions; fn += 1) coefficientRows.push({ variable: names[axis], functionName: `LD${fn + 1}`, coefficient: canonical.vectors[fn][axis] });
    const meanRows = parsed.levels.map((level) => ({ group: level, n: parsed.counts[level], prior: priors[parsed.levels.indexOf(level)], ...Object.fromEntries(names.map((name, axis) => [name, partition.groupMeans[level][axis]])) }));
    const box = boxM(parsed.levels, parsed.counts, partition.groupCovariance, pooledCovariance, p);
    const figure = functions >= 2
      ? H.vegaArtifact("lda-territorial-plot", "Discriminant scores with group centroids", {
        data: { values: scoreRows },
        layer: [
          { mark: { type: "point", filled: true, size: 60, opacity: 0.8 }, encoding: { x: { field: "LD1", type: "quantitative", title: `LD1 (${wilksRows[0].proportionOfTrace === null ? "" : `${(wilksRows[0].proportionOfTrace * 100).toFixed(1)}%`})` }, y: { field: "LD2", type: "quantitative", title: `LD2 (${wilksRows[1].proportionOfTrace === null ? "" : `${(wilksRows[1].proportionOfTrace * 100).toFixed(1)}%`})` }, color: { field: "group", type: "nominal", title: parsed.groupLabel }, shape: { field: "kind", type: "nominal", title: null }, size: { field: "kind", type: "nominal", scale: { domain: ["observation", "centroid"], range: [60, 260] }, legend: null }, tooltip: [{ field: "label" }, { field: "group" }, { field: "predicted" }, { field: "LD1", format: ".3f" }, { field: "LD2", format: ".3f" }] } },
        ],
      })
      : H.vegaArtifact("lda-territorial-plot", "Discriminant scores on the single discriminant function", { data: { values: scoreRows }, mark: { type: "tick", thickness: 2 }, encoding: { x: { field: "LD1", type: "quantitative", title: "LD1" }, y: { field: "group", type: "nominal", title: parsed.groupLabel }, color: { field: "predicted", type: "nominal", title: "Predicted" }, tooltip: [{ field: "label" }, { field: "group" }, { field: "predicted" }, { field: "LD1", format: ".3f" }] } });
    return {
      sample: { n, variables: p, groups: g, groupCounts: parsed.counts, discriminantFunctions: functions, discriminant: options.discriminant },
      estimates: estimateEntries({
        discriminant: options.discriminant,
        priors: Object.fromEntries(parsed.levels.map((level, index) => [level, priors[index]])),
        groupMeans: meanRows,
        coefficients: coefficientRows,
        functions: wilksRows,
        confusion: confusionRows,
        resubstitutionAccuracy: resubCorrect / n,
        leaveOneOutAccuracy: looEnabled ? looCorrect / n : null,
        rendererDataContract: rendererContract(H, scoreRows),
      }),
      tests: wilksRows.filter((row) => row.pValue !== null).map((row) => ({ name: `Wilks lambda through ${row.functionName}`, statistic: row.chiSquare, distribution: "chi-square", df: row.df, pValue: row.pValue, wilksLambda: row.wilksLambda })),
      confidenceIntervals: [],
      effectSizes: [{ name: "resubstitution accuracy", estimate: resubCorrect / n }, ...(looEnabled ? [{ name: "leave-one-out accuracy", estimate: looCorrect / n }] : []), ...(functions ? [{ name: "canonical correlation of LD1", estimate: wilksRows[0].canonicalCorrelation }] : [])],
      assumptions: [
        { name: "multivariate normality within groups", status: "not_tested" },
        { name: "equal covariance matrices", status: options.discriminant === "linear" ? (box.status === "evaluated" ? (box.pValue < 0.05 ? "questionable" : "consistent") : "not_evaluated") : "relaxed_by_quadratic_rule" },
        { name: "priors", status: "explicit", priors: options.priors },
        { name: "independent observations", status: "requires_design_review" },
      ],
      diagnostics: [
        box,
        { name: "cross-validation", status: looEnabled ? "leave-one-out" : (options.crossValidation ? "skipped_row_cap" : "disabled"), detail: looEnabled ? "each observation is classified from a model refit without it (priors fixed from the full sample)" : "leave-one-out is limited to 2000 rows; resubstitution accuracy is optimistic" },
        { name: "discriminant functions", status: "evaluated", detail: "coefficients are scaled so the pooled within-group variance of each function is one (MASS convention); scores are centred at the prior-weighted mean of group means", signConvention: "largest-absolute coefficient positive" },
        { name: "Wilks lambda tests", status: "asymptotic", detail: "sequential Bartlett chi-square approximation for the functions remaining after removing the first k-1" },
        { name: "renderer exact-data contract", status: "verified", rows: scoreRows.length, rowsHash: H.sha256(scoreRows) },
      ],
      artifacts: [
        H.tableArtifact("Discriminant function coefficients", "Raw canonical discriminant coefficients scaled to unit pooled within-group variance.", [{ key: "variable", label: "Variable", type: "string" }, { key: "functionName", label: "Function", type: "string" }, { key: "coefficient", label: "Coefficient", type: "number" }], coefficientRows, [options.discriminant === "quadratic" ? "Quadratic classification uses group-specific covariance matrices; the canonical functions are descriptive axes only." : ""].filter(Boolean), "lda-coefficient-table"),
        H.tableArtifact("Discriminant function summary", "Eigenvalues, proportion of trace, canonical correlations, and sequential Wilks lambda tests.", [{ key: "functionName", label: "Function", type: "string" }, { key: "eigenvalue", label: "Eigenvalue", type: "number" }, { key: "proportionOfTrace", label: "Proportion of trace", type: "number" }, { key: "canonicalCorrelation", label: "Canonical r", type: "number" }, { key: "wilksLambda", label: "Wilks lambda", type: "number" }, { key: "chiSquare", label: "Chi-square", type: "number" }, { key: "df", label: "df", type: "number" }, { key: "pValue", label: "p", type: "number" }], wilksRows, [], "lda-function-table"),
        H.tableArtifact("Group means and priors", "Group centroids in the original variable space.", [{ key: "group", label: parsed.groupLabel, type: "string" }, { key: "n", label: "n", type: "number" }, { key: "prior", label: "Prior", type: "number" }, ...names.map((name) => ({ key: name, label: name, type: "number" }))], meanRows, [], "lda-group-means-table"),
        H.tableArtifact("Confusion matrices", "Resubstitution and leave-one-out classification counts.", [{ key: "evaluation", label: "Evaluation", type: "string" }, { key: "actual", label: "Actual", type: "string" }, { key: "predicted", label: "Predicted", type: "string" }, { key: "count", label: "Count", type: "number" }], confusionRows, [], "lda-confusion-table"),
        H.tableArtifact("Discriminant scores", "Observation and centroid scores used by the territorial figure.", [{ key: "row", label: "Row", type: "number" }, { key: "label", label: "Label", type: "string" }, { key: "kind", label: "Kind", type: "string" }, { key: "group", label: parsed.groupLabel, type: "string" }, { key: "predicted", label: "Predicted", type: "string" }, { key: "leaveOneOutPredicted", label: "LOO predicted", type: "string" }, { key: "maxPosterior", label: "Max posterior", type: "number" }, { key: "LD1", label: "LD1", type: "number" }, { key: "LD2", label: "LD2", type: "number" }], scoreRows, [functions >= 2 ? "" : "Only one discriminant function exists; LD2 is reported as zero."].filter(Boolean), "lda-score-table"),
        figure,
      ],
    };
  },
  linkage: {
    neededWhen: "When labelled groups must be separated by a linear or quadratic rule on several measurements, and the researcher needs both interpretable discriminant axes and an honest classification error estimate.",
    decision: "Whether the groups are separable, which variables drive the separation, and whether a shared-covariance linear rule suffices or a quadratic rule is warranted.",
    mustShow: "Discriminant coefficients, eigenvalues with Wilks lambda tests, group centroids, the territorial score plot, and resubstitution versus leave-one-out confusion matrices.",
    userGoal: "Build and validate a classification rule whose reported accuracy is not inflated by resubstitution.",
    nextActions: [
      { trigger: "leave-one-out-accuracy-far-below-resubstitution", action: "reduce-variables-or-regularise-covariance", reason: "A large optimism gap indicates overfitting of the covariance structure to the training rows." },
      { trigger: "box-m-rejects-and-linear-rule-used", action: "compare-quadratic-discriminant-rule", reason: "Unequal covariance matrices violate the linear rule and can be captured by group-specific covariances." },
      { trigger: "first-function-carries-most-trace", action: "interpret-first-function-and-simplify-model", reason: "When later functions add little separation the model can be reported and validated more simply." },
    ],
  },
  fixture: { data: { variables: IRIS_VARIABLES, groups: IRIS_GROUPS, groupLabel: "species" }, options: { discriminant: "linear", priors: "proportional" } },
  matlabParity: { taxonomyIds: ["matlab.stats.classification"] },
  coverage: {
    implementedBoundary: "Gaussian linear discriminant analysis with pooled covariance and proportional or equal priors, canonical discriminant functions with sequential Wilks lambda tests, resubstitution and leave-one-out confusion matrices, and an optional quadratic (group covariance) classification rule.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["resubstitution and leave-one-out predictions against sklearn LinearDiscriminantAnalysis with explicit priors", "eigenvalue proportions against sklearn solver=eigen explained_variance_ratio_", "quadratic-rule predictions against sklearn QuadraticDiscriminantAnalysis", "Wilks lambda per function against numpy"], excludedOutputs: ["coefficient scaling (MASS convention differs from sklearn scalings_)", "posterior probabilities beyond the argmax"] },
    diagnostic: { level: "method-specific-partial", emitted: ["Box M covariance homogeneity", "cross-validation", "discriminant functions", "Wilks lambda tests"], limitations: ["leave-one-out capped at 2000 rows", "no regularised or shrinkage discriminant", "no stepwise variable selection"] },
    knownGaps: ["regularised discriminant analysis", "k-fold cross-validation and ROC by class", "standardised coefficients and structure matrix"],
  },
};

// ---------------------------------------------------------------------------------------------
// Canonical correlation analysis.
// ---------------------------------------------------------------------------------------------

function parseNamedSet(raw, H, path, minRows) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 16) H.fail("STAT_INVALID_INPUT", `${path} must contain 1 to 16 variables`);
  const names = new Set();
  let rowCount = null;
  const variables = raw.map((rawVariable, index) => {
    const variable = H.assertObject(rawVariable, `${path}[${index}]`);
    H.assertKeys(variable, ["name", "values"], `${path}[${index}]`);
    const name = H.label(variable.name, `${path === "data.x" ? "X" : "Y"}${index + 1}`, `${path}[${index}].name`);
    if (names.has(name)) H.fail("STAT_INVALID_INPUT", `duplicate variable name in ${path}: ${name}`);
    names.add(name);
    const values = H.numericVector(variable.values, `${path}[${index}].values`, minRows);
    if (values.length > 10_000) H.fail("STAT_LIMIT_EXCEEDED", `${path} exceeds 10000 rows`);
    if (rowCount === null) rowCount = values.length;
    if (values.length !== rowCount) H.fail("STAT_INVALID_INPUT", `${path} variables must have equal row counts`);
    if (H.minMax(values).min === H.minMax(values).max) H.fail("STAT_DEGENERATE", `variable ${name} is constant`);
    return { name, values };
  });
  return { variables, rowCount };
}

const canonicalCorrelationAnalysis = {
  method: "canonical_correlation_analysis",
  family: FAMILY,
  analysisModel: { families: ["pca", "lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["timeoutMs"],
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["x", "y"],
    properties: {
      x: { type: "array", minItems: 1, maxItems: 16, items: { type: "object", additionalProperties: false, required: ["values"], properties: { name: { type: "string", minLength: 1, maxLength: 128 }, values: { type: "array", minItems: 6, maxItems: 10000, items: { type: "number" } } } } },
      y: { type: "array", minItems: 1, maxItems: 16, items: { type: "object", additionalProperties: false, required: ["values"], properties: { name: { type: "string", minLength: 1, maxLength: 128 }, values: { type: "array", minItems: 6, maxItems: 10000, items: { type: "number" } } } } },
      rowLabels: { type: "array", minItems: 6, maxItems: 10000, items: { type: "string", minLength: 1, maxLength: 128 } },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["x", "y", "rowLabels"], "data");
    const x = parseNamedSet(data.x, H, "data.x", 6);
    const y = parseNamedSet(data.y, H, "data.y", 6);
    if (x.rowCount !== y.rowCount) H.fail("STAT_INVALID_INPUT", "data.x and data.y must have the same number of rows");
    const all = new Set([...x.variables.map((variable) => variable.name), ...y.variables.map((variable) => variable.name)]);
    if (all.size !== x.variables.length + y.variables.length) H.fail("STAT_INVALID_INPUT", "variable names must be unique across data.x and data.y");
    const n = x.rowCount;
    if (n <= x.variables.length + y.variables.length + 1) H.fail("STAT_INSUFFICIENT_SAMPLE", "canonical correlation requires more observations than x plus y variables plus one");
    let rowLabels;
    if (data.rowLabels === undefined) rowLabels = Array.from({ length: n }, (_, index) => `Row ${index + 1}`);
    else {
      if (!Array.isArray(data.rowLabels) || data.rowLabels.length !== n) H.fail("STAT_INVALID_INPUT", "data.rowLabels length must match the rows");
      rowLabels = data.rowLabels.map((item, index) => H.label(item, `Row ${index + 1}`, `data.rowLabels[${index}]`));
      if (new Set(rowLabels).size !== rowLabels.length) H.fail("STAT_INVALID_INPUT", "data.rowLabels must be unique");
    }
    return { x: x.variables, y: y.variables, rowCount: n, rowLabels };
  },
  analyze(parsed, options, budget, H) {
    const n = parsed.rowCount;
    const p = parsed.x.length;
    const q = parsed.y.length;
    const xColumns = parsed.x.map((variable) => variable.values);
    const yColumns = parsed.y.map((variable) => variable.values);
    const xStandard = S.standardizeColumns(xColumns);
    const yStandard = S.standardizeColumns(yColumns);
    const all = correlationMatrix([...xStandard, ...yStandard], budget);
    const rxx = all.slice(0, p).map((row) => row.slice(0, p));
    const ryy = all.slice(p).map((row) => row.slice(p));
    const rxy = all.slice(0, p).map((row) => row.slice(p));
    const ryx = S.transpose(rxy);
    const rxxHalf = S.symmetricPower(rxx, -0.5, budget);
    const ryyInverse = S.inverse(ryy);
    if (!rxxHalf || !ryyInverse) H.fail("STAT_SINGULAR_FIT", "x or y correlation matrix is singular");
    const kernel = S.multiply(S.multiply(S.multiply(S.multiply(rxxHalf, rxy, budget), ryyInverse, budget), ryx, budget), rxxHalf, budget);
    for (let i = 0; i < p; i += 1) for (let j = i + 1; j < p; j += 1) {
      const average = 0.5 * (kernel[i][j] + kernel[j][i]);
      kernel[i][j] = average;
      kernel[j][i] = average;
    }
    const decomposition = S.symmetricEigen(kernel, budget);
    const s = Math.min(p, q);
    const correlations = decomposition.values.slice(0, s).map((value) => Math.sqrt(Math.min(1, Math.max(0, value))));
    if (correlations.some((value) => !(value < 1 - 1e-10))) H.fail("STAT_DEGENERATE", "a canonical correlation equals one; the sets are linearly dependent");
    const xWeights = [];
    const yWeights = [];
    for (let k = 0; k < s; k += 1) {
      let a = S.multiplyVector(rxxHalf, decomposition.vectors[k]);
      let b = S.multiplyVector(ryyInverse, S.multiplyVector(ryx, a)).map((value) => value / Math.max(correlations[k], 1e-300));
      let anchor = 0;
      for (let index = 1; index < a.length; index += 1) if (Math.abs(a[index]) > Math.abs(a[anchor])) anchor = index;
      if (a[anchor] < 0) {
        a = a.map((value) => -value);
        b = b.map((value) => -value);
      }
      xWeights.push(a);
      yWeights.push(b);
    }
    const xSd = xColumns.map((column) => Math.sqrt(column.reduce((total, value) => total + (value - column.reduce((sum, item) => sum + item, 0) / n) ** 2, 0) / (n - 1)));
    const ySd = yColumns.map((column) => Math.sqrt(column.reduce((total, value) => total + (value - column.reduce((sum, item) => sum + item, 0) / n) ** 2, 0) / (n - 1)));
    const weightRows = [];
    const loadingRows = [];
    const redundancyRows = [];
    for (let k = 0; k < s; k += 1) {
      const xLoad = S.multiplyVector(rxx, xWeights[k]);
      const yLoad = S.multiplyVector(ryy, yWeights[k]);
      for (let j = 0; j < p; j += 1) {
        weightRows.push({ set: "x", variable: parsed.x[j].name, variate: k + 1, standardizedCoefficient: xWeights[k][j], rawCoefficient: xWeights[k][j] / xSd[j] });
        loadingRows.push({ set: "x", variable: parsed.x[j].name, variate: k + 1, loading: xLoad[j], crossLoading: correlations[k] * xLoad[j] });
      }
      for (let j = 0; j < q; j += 1) {
        weightRows.push({ set: "y", variable: parsed.y[j].name, variate: k + 1, standardizedCoefficient: yWeights[k][j], rawCoefficient: yWeights[k][j] / ySd[j] });
        loadingRows.push({ set: "y", variable: parsed.y[j].name, variate: k + 1, loading: yLoad[j], crossLoading: correlations[k] * yLoad[j] });
      }
      const xExtracted = xLoad.reduce((total, value) => total + value * value, 0) / p;
      const yExtracted = yLoad.reduce((total, value) => total + value * value, 0) / q;
      redundancyRows.push({ variate: k + 1, canonicalCorrelation: correlations[k], squaredCorrelation: correlations[k] ** 2, xVarianceExtracted: xExtracted, yVarianceExtracted: yExtracted, xRedundancyGivenY: xExtracted * correlations[k] ** 2, yRedundancyGivenX: yExtracted * correlations[k] ** 2 });
    }
    const testRows = [];
    for (let k = 0; k < s; k += 1) {
      let lambda = 1;
      for (let j = k; j < s; j += 1) lambda *= 1 - correlations[j] ** 2;
      const bartlett = -(n - 1 - (p + q + 1) / 2) * Math.log(lambda);
      const dfChi = (p - k) * (q - k);
      const pk = p - k;
      const qk = q - k;
      // Match statsmodels CanCorr.corr_test exactly. The finite-sample Rao term uses the
      // original Y-set dimensionality, not n - 1 - k; substituting the latter inflates F.
      const tmp1 = n - q - 1 - 0.5 * (qk - pk + 1);
      const tmp2 = (pk * qk - 2) / 4;
      const tmp3raw = pk * pk + qk * qk - 5;
      const tmp3 = tmp3raw > 0 ? Math.sqrt(((pk * qk) ** 2 - 4) / tmp3raw) : 1;
      const df2 = tmp1 * tmp3 - 2 * tmp2;
      const f = ((Math.pow(lambda, -1 / tmp3) - 1) * df2) / pk / qk;
      testRows.push({ startingVariate: k + 1, wilksLambda: lambda, bartlettChiSquare: bartlett, chiSquareDf: dfChi, chiSquarePValue: S.chiSquareSurvival(bartlett, dfChi), raoF: f, fDf1: pk * qk, fDf2: df2, fPValue: df2 > 0 ? S.fSurvival(f, pk * qk, df2) : null });
    }
    const scoreRows = Array.from({ length: n }, (_, row) => {
      const entry = { row: row + 1, label: parsed.rowLabels[row] };
      for (let k = 0; k < Math.min(s, 2); k += 1) {
        entry[`U${k + 1}`] = xWeights[k].reduce((total, value, j) => total + value * xStandard[j][row], 0);
        entry[`V${k + 1}`] = yWeights[k].reduce((total, value, j) => total + value * yStandard[j][row], 0);
      }
      if (s < 2) {
        entry.U2 = 0;
        entry.V2 = 0;
      }
      return entry;
    });
    return {
      sample: { n, xVariables: p, yVariables: q, canonicalPairs: s },
      estimates: estimateEntries({ canonicalCorrelations: correlations, weights: weightRows, loadings: loadingRows, redundancy: redundancyRows, tests: testRows, rendererDataContract: rendererContract(H, scoreRows) }),
      tests: testRows.map((row) => ({ name: `Wilks lambda from variate ${row.startingVariate}`, statistic: row.bartlettChiSquare, distribution: "chi-square (Bartlett)", df: row.chiSquareDf, pValue: row.chiSquarePValue, wilksLambda: row.wilksLambda, raoF: row.raoF, fDf1: row.fDf1, fDf2: row.fDf2, fPValue: row.fPValue })),
      confidenceIntervals: [],
      effectSizes: redundancyRows.map((row) => ({ name: `squared canonical correlation ${row.variate}`, estimate: row.squaredCorrelation })),
      assumptions: [
        { name: "linear relations between sets", status: "requires_scatter_review" },
        { name: "multivariate normality", status: "required_for_sequential_tests_only" },
        { name: "no multicollinearity within sets", status: "verified_by_invertible_correlation_matrices" },
        { name: "independent observations", status: "requires_design_review" },
      ],
      diagnostics: [
        { name: "sequential test boundary", status: "asymptotic", detail: "Bartlett chi-square and Rao F approximations test whether the correlations from variate k onward are all zero; they assume multivariate normality and large n" },
        { name: "weight scaling", status: "evaluated", detail: "standardised weights give unit-variance variates; raw weights divide by the variable standard deviation", signConvention: "largest-absolute x weight positive" },
        { name: "renderer exact-data contract", status: "verified", rows: scoreRows.length, rowsHash: H.sha256(scoreRows) },
      ],
      artifacts: [
        H.tableArtifact("Canonical correlations and sequential tests", "Wilks lambda for the correlations from each variate onward.", [{ key: "startingVariate", label: "From variate", type: "number" }, { key: "wilksLambda", label: "Wilks lambda", type: "number" }, { key: "bartlettChiSquare", label: "Bartlett chi-square", type: "number" }, { key: "chiSquareDf", label: "df", type: "number" }, { key: "chiSquarePValue", label: "p (chi-square)", type: "number" }, { key: "raoF", label: "Rao F", type: "number" }, { key: "fDf1", label: "F df1", type: "number" }, { key: "fDf2", label: "F df2", type: "number" }, { key: "fPValue", label: "p (F)", type: "number" }], testRows, [], "cca-test-table"),
        H.tableArtifact("Canonical weights", "Standardised and raw canonical coefficients.", [{ key: "set", label: "Set", type: "string" }, { key: "variable", label: "Variable", type: "string" }, { key: "variate", label: "Variate", type: "number" }, { key: "standardizedCoefficient", label: "Standardised", type: "number" }, { key: "rawCoefficient", label: "Raw", type: "number" }], weightRows, [], "cca-weight-table"),
        H.tableArtifact("Canonical loadings", "Structure correlations of variables with their own and the opposite variate.", [{ key: "set", label: "Set", type: "string" }, { key: "variable", label: "Variable", type: "string" }, { key: "variate", label: "Variate", type: "number" }, { key: "loading", label: "Loading", type: "number" }, { key: "crossLoading", label: "Cross loading", type: "number" }], loadingRows, [], "cca-loading-table"),
        H.tableArtifact("Redundancy", "Variance extracted by each variate and redundancy given the other set.", [{ key: "variate", label: "Variate", type: "number" }, { key: "canonicalCorrelation", label: "Canonical r", type: "number" }, { key: "squaredCorrelation", label: "r squared", type: "number" }, { key: "xVarianceExtracted", label: "X variance extracted", type: "number" }, { key: "yVarianceExtracted", label: "Y variance extracted", type: "number" }, { key: "xRedundancyGivenY", label: "X redundancy | Y", type: "number" }, { key: "yRedundancyGivenX", label: "Y redundancy | X", type: "number" }], redundancyRows, [], "cca-redundancy-table"),
        H.tableArtifact("Canonical variate scores", "Scores on the first two canonical pairs.", [{ key: "row", label: "Row", type: "number" }, { key: "label", label: "Label", type: "string" }, { key: "U1", label: "U1", type: "number" }, { key: "V1", label: "V1", type: "number" }, { key: "U2", label: "U2", type: "number" }, { key: "V2", label: "V2", type: "number" }], scoreRows, [s < 2 ? "Only one canonical pair exists; U2 and V2 are reported as zero." : ""].filter(Boolean), "cca-score-table"),
        H.vegaArtifact("cca-variate-plot", `First canonical pair (r = ${correlations[0].toFixed(3)})`, { data: { values: scoreRows }, mark: { type: "point", filled: true, size: 65, color: "#285F8F", opacity: 0.85 }, encoding: { x: { field: "U1", type: "quantitative", title: "X canonical variate 1" }, y: { field: "V1", type: "quantitative", title: "Y canonical variate 1" }, tooltip: [{ field: "label" }, { field: "U1", format: ".3f" }, { field: "V1", format: ".3f" }] } }),
      ],
    };
  },
  linkage: {
    neededWhen: "When two sets of variables are measured on the same units and the question is how the sets relate as wholes rather than variable by variable.",
    decision: "How many canonical pairs carry real shared variance, and which variables define the relation between the sets.",
    mustShow: "Canonical correlations with sequential tests, canonical weights and loadings, redundancy indices, and the scatter of the first canonical pair.",
    userGoal: "Summarise the multivariate association between two measurement domains with interpretable variates.",
    nextActions: [
      { trigger: "only-first-pair-significant", action: "interpret-first-pair-and-report-redundancy", reason: "Later pairs without evidence of association should not be interpreted as structure." },
      { trigger: "low-redundancy-despite-high-correlation", action: "review-variate-composition-before-claiming-shared-variance", reason: "A canonical correlation can be high while explaining little variance of either set." },
      { trigger: "weights-and-loadings-disagree", action: "prefer-loadings-for-interpretation", reason: "Weights are unstable under collinearity; structure correlations show what each variate measures." },
    ],
  },
  fixture: { data: { x: IRIS_VARIABLES.slice(0, 2), y: IRIS_VARIABLES.slice(2), rowLabels: IRIS_ROWS.map((_, index) => `iris-${index + 1}`) } },
  matlabParity: { taxonomyIds: ["matlab.stats.dimensionality-reduction-feature-extraction"] },
  coverage: {
    implementedBoundary: "Canonical correlation analysis on Pearson correlations with standardised and raw weights, structure and cross loadings, redundancy indices, Bartlett chi-square and Rao F sequential tests, and first-pair variate scores.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["canonical correlations against statsmodels CanCorr", "Wilks lambda, F, and df against statsmodels CanCorr.corr_test", "loadings and redundancy against numpy", "Bartlett chi-square against numpy"], excludedOutputs: ["weight signs (aligned in the oracle)", "variate score scaling beyond unit sample variance"] },
    diagnostic: { level: "method-specific-partial", emitted: ["sequential test boundary", "weight scaling"], limitations: ["no regularised or sparse CCA", "no bootstrap intervals"] },
    knownGaps: ["regularised and kernel CCA", "bootstrap confidence intervals for canonical correlations", "partial CCA with covariates"],
  },
};

// ---------------------------------------------------------------------------------------------
// Classical multidimensional scaling.
// ---------------------------------------------------------------------------------------------

const multidimensionalScaling = {
  method: "multidimensional_scaling",
  family: FAMILY,
  analysisModel: { families: ["pca"], distributions: [null], links: [null] },
  optionKeys: ["timeoutMs"],
  customOptions: {
    dimensions: { schema: { type: "integer", minimum: 1, maximum: 10 }, default: 2, parse(value, H, path) { return H.integer(value, 1, 10, path); } },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      variables: { type: "array", minItems: 1, maxItems: 32, items: { type: "object", additionalProperties: false, required: ["values"], properties: { name: { type: "string", minLength: 1, maxLength: 128 }, values: { type: "array", minItems: 4, maxItems: 2000, items: { type: "number" } } } } },
      distances: { type: "array", minItems: 4, maxItems: 600, items: { type: "array", minItems: 4, maxItems: 600, items: { type: "number" } } },
      rowLabels: { type: "array", minItems: 4, maxItems: 2000, items: { type: "string", minLength: 1, maxLength: 128 } },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["variables", "distances", "rowLabels"], "data");
    if ((data.variables === undefined) === (data.distances === undefined)) H.fail("STAT_INVALID_INPUT", "supply exactly one of data.variables or data.distances");
    let distances;
    let n;
    let rowLabels;
    let source;
    if (data.variables !== undefined) {
      const matrix = S.parseVariableMatrix(data, H, { minRows: 4, minVariables: 1, maxVariables: 32, maxRows: 2000 });
      n = matrix.rowCount;
      if (n > 600) H.fail("STAT_LIMIT_EXCEEDED", "classical MDS is limited to 600 objects");
      rowLabels = matrix.rowLabels;
      distances = S.distanceMatrix(S.columnsToRows(matrix.variables.map((variable) => variable.values)), "euclidean");
      source = "euclidean-from-variables";
    } else {
      if (!Array.isArray(data.distances) || data.distances.length < 4 || data.distances.length > 600) H.fail("STAT_INVALID_INPUT", "data.distances must be a square matrix with 4 to 600 rows");
      n = data.distances.length;
      distances = data.distances.map((row, i) => {
        const values = H.numericVector(row, `data.distances[${i}]`, n);
        if (values.length !== n) H.fail("STAT_INVALID_INPUT", "data.distances must be square");
        return values;
      });
      for (let i = 0; i < n; i += 1) {
        if (distances[i][i] !== 0) H.fail("STAT_INVALID_INPUT", "data.distances diagonal must be zero");
        for (let j = i + 1; j < n; j += 1) {
          if (distances[i][j] < 0 || Math.abs(distances[i][j] - distances[j][i]) > 1e-9 * Math.max(1, Math.abs(distances[i][j]))) H.fail("STAT_INVALID_INPUT", "data.distances must be symmetric and non-negative");
        }
      }
      if (data.rowLabels === undefined) rowLabels = Array.from({ length: n }, (_, index) => `Object ${index + 1}`);
      else {
        if (!Array.isArray(data.rowLabels) || data.rowLabels.length !== n) H.fail("STAT_INVALID_INPUT", "data.rowLabels length must match data.distances");
        rowLabels = data.rowLabels.map((item, index) => H.label(item, `Object ${index + 1}`, `data.rowLabels[${index}]`));
        if (new Set(rowLabels).size !== rowLabels.length) H.fail("STAT_INVALID_INPUT", "data.rowLabels must be unique");
      }
      source = "supplied-distances";
    }
    if (options.dimensions > n - 1) H.fail("STAT_INVALID_INPUT", `options.dimensions must not exceed ${n - 1} for ${n} objects`);
    let anyPositive = false;
    for (let i = 0; i < n && !anyPositive; i += 1) for (let j = i + 1; j < n; j += 1) if (distances[i][j] > 0) { anyPositive = true; break; }
    if (!anyPositive) H.fail("STAT_DEGENERATE", "all distances are zero");
    return { distances, n, rowLabels, source };
  },
  analyze(parsed, options, budget, H) {
    const n = parsed.n;
    const d = parsed.distances;
    const squared = d.map((row) => row.map((value) => value * value));
    const rowMeans = squared.map((row) => row.reduce((total, value) => total + value, 0) / n);
    const grandMean = rowMeans.reduce((total, value) => total + value, 0) / n;
    const b = squared.map((row, i) => row.map((value, j) => -0.5 * (value - rowMeans[i] - rowMeans[j] + grandMean)));
    const decomposition = S.symmetricEigen(b, budget);
    const k = options.dimensions;
    const positive = decomposition.values.filter((value) => value > 1e-12);
    if (positive.length < k) H.fail("STAT_DEGENERATE", `only ${positive.length} positive eigenvalues are available for ${k} requested dimensions`);
    const coordinates = Array.from({ length: n }, (_, row) => Array.from({ length: k }, (_, axis) => decomposition.vectors[axis][row] * Math.sqrt(decomposition.values[axis])));
    const sumPositive = positive.reduce((total, value) => total + value, 0);
    const sumAbsolute = decomposition.values.reduce((total, value) => total + Math.abs(value), 0);
    const retained = decomposition.values.slice(0, k).reduce((total, value) => total + value, 0);
    let numerator = 0;
    let denominator = 0;
    const shepardRows = [];
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        budget.check();
        const fitted = S.euclideanDistance(coordinates[i], coordinates[j]);
        numerator += (d[i][j] - fitted) ** 2;
        denominator += d[i][j] ** 2;
        if (shepardRows.length < H.LIMITS.maxArtifactRows) shepardRows.push({ from: parsed.rowLabels[i], to: parsed.rowLabels[j], distance: d[i][j], fittedDistance: fitted });
      }
    }
    const stress = Math.sqrt(numerator / denominator);
    const coordinateRows = Array.from({ length: n }, (_, row) => {
      const entry = { row: row + 1, label: parsed.rowLabels[row] };
      for (let axis = 0; axis < k; axis += 1) entry[`dim${axis + 1}`] = coordinates[row][axis];
      if (k < 2) entry.dim2 = 0;
      return entry;
    });
    const eigenRows = decomposition.values.map((value, index) => ({ axis: index + 1, eigenvalue: value, proportionOfPositive: value > 0 ? value / sumPositive : 0, retained: index < k }));
    const negativeMagnitude = decomposition.values.filter((value) => value < 0).reduce((total, value) => total + Math.abs(value), 0);
    return {
      sample: { objects: n, dimensions: k, distanceSource: parsed.source },
      estimates: estimateEntries({ coordinates: coordinateRows, eigenvalues: eigenRows, goodnessOfFit: { mardiaPositive: retained / sumPositive, mardiaAbsolute: retained / sumAbsolute }, stress1: stress, rendererDataContract: rendererContract(H, coordinateRows, { shepardRowsHash: H.sha256(shepardRows) }) }),
      tests: [],
      confidenceIntervals: [],
      effectSizes: [{ name: "Kruskal stress-1 of the classical configuration", estimate: stress }, { name: "proportion of positive eigenvalue mass retained", estimate: retained / sumPositive }],
      assumptions: [
        { name: "distances are Euclidean-embeddable", status: negativeMagnitude > 1e-8 * sumAbsolute ? "violated_negative_eigenvalues" : "consistent", negativeEigenvalueMass: negativeMagnitude },
        { name: "metric (ratio) dissimilarities", status: "requires_design_review" },
      ],
      diagnostics: [
        { name: "classical scaling boundary", status: "descriptive", detail: "Torgerson double-centring solution; no SMACOF stress optimisation or non-metric scaling is performed, so stress-1 describes the classical configuration only" },
        { name: "eigenvalue sign", status: negativeMagnitude > 1e-8 * sumAbsolute ? "warning" : "clear", detail: negativeMagnitude > 1e-8 * sumAbsolute ? "negative eigenvalues indicate non-Euclidean dissimilarities; low-dimensional fit may be misleading" : "no material negative eigenvalues" },
        { name: "renderer exact-data contract", status: "verified", rows: coordinateRows.length, rowsHash: H.sha256(coordinateRows), shepardRows: shepardRows.length },
      ],
      artifacts: [
        H.tableArtifact("MDS coordinates", `Classical (Torgerson) coordinates in ${k} dimension${k > 1 ? "s" : ""}.`, [{ key: "row", label: "Row", type: "number" }, { key: "label", label: "Object", type: "string" }, ...Array.from({ length: Math.max(k, 2) }, (_, axis) => ({ key: `dim${axis + 1}`, label: `Dimension ${axis + 1}`, type: "number" }))], coordinateRows, [k < 2 ? "Only one dimension was requested; dim2 is reported as zero." : ""].filter(Boolean), "mds-coordinate-table"),
        H.tableArtifact("MDS eigenvalues", "Eigenvalues of the double-centred squared-distance matrix.", [{ key: "axis", label: "Axis", type: "number" }, { key: "eigenvalue", label: "Eigenvalue", type: "number" }, { key: "proportionOfPositive", label: "Proportion of positive", type: "number" }, { key: "retained", label: "Retained", type: "boolean" }], eigenRows, [], "mds-eigenvalue-table"),
        H.tableArtifact("Shepard diagram rows", "Original versus configuration distances for every object pair.", [{ key: "from", label: "From", type: "string" }, { key: "to", label: "To", type: "string" }, { key: "distance", label: "Distance", type: "number" }, { key: "fittedDistance", label: "Configuration distance", type: "number" }], shepardRows, [], "mds-shepard-table"),
        H.vegaArtifact("mds-configuration-plot", `Classical MDS configuration (stress-1 = ${stress.toFixed(3)})`, {
          data: { values: coordinateRows },
          layer: [
            { mark: { type: "point", filled: true, size: 70, color: "#285F8F" }, encoding: { x: { field: "dim1", type: "quantitative", title: "Dimension 1" }, y: { field: "dim2", type: "quantitative", title: "Dimension 2" }, tooltip: [{ field: "label" }, { field: "dim1", format: ".3f" }, { field: "dim2", format: ".3f" }] } },
            { mark: { type: "text", dy: -9, fontSize: 10, color: "#1F1D1B" }, encoding: { x: { field: "dim1", type: "quantitative" }, y: { field: "dim2", type: "quantitative" }, text: { field: "label" } } },
          ],
        }),
        H.vegaArtifact("mds-shepard-plot", "Shepard diagram", { data: { values: shepardRows }, mark: { type: "point", filled: true, size: 30, opacity: 0.6, color: "#A36D47" }, encoding: { x: { field: "distance", type: "quantitative", title: "Original distance" }, y: { field: "fittedDistance", type: "quantitative", title: "Configuration distance" }, tooltip: [{ field: "from" }, { field: "to" }, { field: "distance", format: ".3f" }, { field: "fittedDistance", format: ".3f" }] } }),
      ],
    };
  },
  linkage: {
    neededWhen: "When objects are described by pairwise distances or dissimilarities and a low-dimensional map is needed to see structure, clusters, or gradients.",
    decision: "How many dimensions reproduce the distances adequately and whether the configuration is trustworthy enough to interpret proximities.",
    mustShow: "The configuration plot, eigenvalue spectrum with negative-eigenvalue warnings, stress, and the Shepard diagram of original versus fitted distances.",
    userGoal: "Visualise and summarise a distance structure without over-interpreting a poor low-dimensional fit.",
    nextActions: [
      { trigger: "stress-above-0-2", action: "increase-dimensions-or-use-non-metric-scaling", reason: "High stress means the two-dimensional map distorts many distances and proximities should not be read literally." },
      { trigger: "material-negative-eigenvalues", action: "review-dissimilarity-definition-or-add-constant", reason: "Non-Euclidean dissimilarities cannot be embedded exactly and can produce misleading axes." },
      { trigger: "configuration-accepted", action: "overlay-external-variables-or-groups-for-interpretation", reason: "Axes of a classical solution are arbitrary until anchored to known covariates or groupings." },
    ],
  },
  fixture: { data: { variables: IRIS_VARIABLES.map((variable) => ({ name: variable.name, values: variable.values.slice(0, 12) })), rowLabels: IRIS_ROWS.slice(0, 12).map((_, index) => `iris-${index + 1}`) }, options: { dimensions: 2 } },
  matlabParity: { taxonomyIds: ["matlab.stats.dimensionality-reduction-feature-extraction"] },
  coverage: {
    implementedBoundary: "Classical (Torgerson) metric MDS by double centring of squared distances with eigenvalue spectrum, Mardia goodness-of-fit, Kruskal stress-1 of the classical configuration, and Shepard rows; distances may be supplied or derived as Euclidean distances from variables.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["coordinates (sign-aligned) and eigenvalues against a numpy double-centring eigendecomposition", "stress-1 against numpy", "Euclidean distances against scipy pdist"], excludedOutputs: ["SMACOF or non-metric solutions (not implemented)", "sklearn MDS stress (raw stress definition differs and SMACOF optimises a different objective)"] },
    diagnostic: { level: "method-specific-partial", emitted: ["classical scaling boundary", "eigenvalue sign"], limitations: ["no iterative stress minimisation", "objects capped at 600"] },
    knownGaps: ["SMACOF metric MDS", "non-metric (ordinal) MDS", "additive-constant correction for non-Euclidean input", "Procrustes comparison of configurations"],
  },
};

// ---------------------------------------------------------------------------------------------
// Partial correlation.
// ---------------------------------------------------------------------------------------------

const partialCorrelation = {
  method: "partial_correlation",
  family: FAMILY,
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["variables", "controls"],
    properties: {
      variables: { type: "array", minItems: 3, maxItems: 32, items: { type: "object", additionalProperties: false, required: ["values"], properties: { name: { type: "string", minLength: 1, maxLength: 128 }, values: { type: "array", minItems: 6, maxItems: 10000, items: { type: "number" } } } } },
      controls: { type: "array", minItems: 1, maxItems: 30, items: { type: "string", minLength: 1, maxLength: 128 } },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["variables", "controls"], "data");
    const matrix = S.parseVariableMatrix(data, H, { minRows: 6, minVariables: 3, maxVariables: 32 });
    if (!Array.isArray(data.controls) || data.controls.length < 1) H.fail("STAT_INVALID_INPUT", "data.controls must name at least one variable");
    const names = matrix.variables.map((variable) => variable.name);
    const controls = data.controls.map((item, index) => {
      const name = H.label(item, "", `data.controls[${index}]`);
      if (!names.includes(name)) H.fail("STAT_INVALID_INPUT", `data.controls[${index}] does not name a variable`);
      return name;
    });
    if (new Set(controls).size !== controls.length) H.fail("STAT_INVALID_INPUT", "data.controls must be unique");
    const targets = names.filter((name) => !controls.includes(name));
    if (targets.length < 2) H.fail("STAT_INVALID_INPUT", "at least two variables must remain after removing the controls");
    if (matrix.rowCount - 2 - controls.length < 1) H.fail("STAT_INSUFFICIENT_SAMPLE", "partial correlation requires n - 2 - (number of controls) >= 1");
    return { ...matrix, controls, targets };
  },
  analyze(parsed, options, budget, H) {
    const n = parsed.rowCount;
    const byName = Object.fromEntries(parsed.variables.map((variable) => [variable.name, variable.values]));
    const g = parsed.controls.length;
    const design = Array.from({ length: n }, (_, row) => [1, ...parsed.controls.map((name) => byName[name][row])]);
    const xt = S.transpose(design);
    const gram = S.multiply(xt, design, budget);
    const gramInverse = S.inverse(gram);
    if (!gramInverse) H.fail("STAT_SINGULAR_FIT", "control variables are collinear");
    const residuals = {};
    for (const target of parsed.targets) {
      const y = byName[target];
      const beta = S.multiplyVector(gramInverse, S.multiplyVector(xt, y));
      residuals[target] = y.map((value, row) => value - design[row].reduce((total, item, index) => total + item * beta[index], 0));
    }
    const full = correlationMatrix(parsed.targets.map((name) => byName[name]), budget);
    const df = n - 2 - g;
    const z = S.normalQuantile(1 - (1 - options.confidenceLevel) / 2);
    const pairRows = [];
    const cellRows = [];
    const matrix = S.identity(parsed.targets.length);
    for (let i = 0; i < parsed.targets.length; i += 1) {
      for (let j = i + 1; j < parsed.targets.length; j += 1) {
        budget.check(n);
        const a = residuals[parsed.targets[i]];
        const b = residuals[parsed.targets[j]];
        let sab = 0;
        let saa = 0;
        let sbb = 0;
        for (let row = 0; row < n; row += 1) {
          sab += a[row] * b[row];
          saa += a[row] * a[row];
          sbb += b[row] * b[row];
        }
        if (!(saa > 0) || !(sbb > 0)) H.fail("STAT_DEGENERATE", `variable ${saa > 0 ? parsed.targets[j] : parsed.targets[i]} is fully explained by the controls`);
        const r = Math.max(-1, Math.min(1, sab / Math.sqrt(saa * sbb)));
        matrix[i][j] = r;
        matrix[j][i] = r;
        const t = Math.abs(r) < 1 ? r * Math.sqrt(df / (1 - r * r)) : (r > 0 ? Infinity : -Infinity);
        const pValue = Number.isFinite(t) ? 2 * (1 - S.tCdf(Math.abs(t), df)) : 0;
        const fisher = Math.abs(r) < 1 ? Math.atanh(r) : null;
        const se = 1 / Math.sqrt(n - 3 - g);
        const lower = fisher === null || !(n - 3 - g > 0) ? null : Math.tanh(fisher - z * se);
        const upper = fisher === null || !(n - 3 - g > 0) ? null : Math.tanh(fisher + z * se);
        pairRows.push({ x: parsed.targets[i], y: parsed.targets[j], partialCorrelation: r, zeroOrderCorrelation: full[i][j], t: Number.isFinite(t) ? t : null, df, pValue, lower, upper });
      }
    }
    for (let i = 0; i < parsed.targets.length; i += 1) for (let j = 0; j < parsed.targets.length; j += 1) cellRows.push({ x: parsed.targets[i], y: parsed.targets[j], partialCorrelation: matrix[i][j] });
    return {
      sample: { n, targets: parsed.targets.length, controls: g, df },
      estimates: estimateEntries({ controls: parsed.controls, pairs: pairRows, matrix: cellRows, rendererDataContract: rendererContract(H, cellRows, { pairRowsHash: H.sha256(pairRows) }) }),
      tests: pairRows.map((row) => ({ name: `partial correlation ${row.x} ~ ${row.y} | ${parsed.controls.join(", ")}`, statistic: row.t, distribution: "t", df: row.df, pValue: row.pValue })),
      confidenceIntervals: pairRows.filter((row) => row.lower !== null).map((row) => ({ parameter: `partial correlation ${row.x} ~ ${row.y}`, estimate: row.partialCorrelation, lower: row.lower, upper: row.upper, level: options.confidenceLevel, method: "Fisher z with n - 3 - controls" })),
      effectSizes: pairRows.map((row) => ({ name: `partial r squared ${row.x} ~ ${row.y}`, estimate: row.partialCorrelation ** 2 })),
      assumptions: [
        { name: "linear relations with the controls", status: "requires_residual_review" },
        { name: "bivariate normality of residuals for the t test", status: "not_tested" },
        { name: "independent observations", status: "requires_design_review" },
      ],
      diagnostics: [
        { name: "partialling method", status: "evaluated", detail: "each target is regressed on the controls with an intercept; partial correlations are the correlations of the residuals", controls: parsed.controls },
        { name: "inference boundary", status: "asymptotic", detail: "t tests and Fisher z intervals assume approximately normal residuals; no multiplicity adjustment is applied across pairs" },
        { name: "renderer exact-data contract", status: "verified", rows: cellRows.length, rowsHash: H.sha256(cellRows), pairRows: pairRows.length },
      ],
      artifacts: [
        H.tableArtifact("Partial correlations", `Pairwise partial correlations controlling for ${parsed.controls.join(", ")}.`, [{ key: "x", label: "Variable", type: "string" }, { key: "y", label: "With", type: "string" }, { key: "partialCorrelation", label: "Partial r", type: "number" }, { key: "zeroOrderCorrelation", label: "Zero-order r", type: "number" }, { key: "t", label: "t", type: "number" }, { key: "df", label: "df", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "lower", label: "Lower", type: "number" }, { key: "upper", label: "Upper", type: "number" }], pairRows, ["p values are unadjusted for multiple pairs."], "partial-correlation-table"),
        H.tableArtifact("Partial correlation matrix cells", "Symmetric matrix cells used by the heatmap.", [{ key: "x", label: "Variable", type: "string" }, { key: "y", label: "With", type: "string" }, { key: "partialCorrelation", label: "Partial r", type: "number" }], cellRows, [], "partial-correlation-matrix-table"),
        H.vegaArtifact("partial-correlation-heatmap", `Partial correlations | ${parsed.controls.join(", ")}`, { data: { values: cellRows }, mark: "rect", encoding: { x: { field: "x", type: "nominal", title: null }, y: { field: "y", type: "nominal", title: null }, color: { field: "partialCorrelation", type: "quantitative", scale: { scheme: "redblue", domain: [-1, 1], domainMid: 0 }, title: "Partial r" }, tooltip: [{ field: "x" }, { field: "y" }, { field: "partialCorrelation", format: ".3f" }] } }),
      ],
    };
  },
  linkage: {
    neededWhen: "When the association between two variables may be induced or masked by other measured variables and the researcher needs the relation net of those controls.",
    decision: "Whether an observed correlation survives adjustment for the named controls, and therefore whether it deserves a causal or mechanistic follow-up.",
    mustShow: "Partial and zero-order correlations side by side, t tests with the reduced degrees of freedom, confidence intervals, and the control set that was partialled out.",
    userGoal: "Separate direct association from association routed through measured third variables.",
    nextActions: [
      { trigger: "partial-much-smaller-than-zero-order", action: "treat-association-as-mediated-or-confounded", reason: "A correlation that vanishes after adjustment is explained by the controls and should not be reported as direct." },
      { trigger: "partial-larger-than-zero-order", action: "check-for-suppression-and-collider-adjustment", reason: "Adjustment that strengthens an association can indicate suppression or conditioning on a collider." },
      { trigger: "many-pairs-tested", action: "apply-multiplicity-correction-before-claims", reason: "Unadjusted pairwise tests across a matrix inflate the family-wise error rate." },
    ],
  },
  fixture: { data: { variables: IRIS_VARIABLES, controls: ["sepal_width"] } },
  matlabParity: { taxonomyIds: ["matlab.stats.descriptive-visualization"] },
  coverage: {
    implementedBoundary: "Pairwise partial correlations among the non-control variables given a fixed control set (residualisation with intercept), t tests with n - 2 - controls degrees of freedom, and Fisher z confidence intervals.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["partial correlations against a numpy residualisation and the inverse-correlation formula", "t statistics and p values against scipy", "Fisher z intervals against scipy"], excludedOutputs: ["semi-partial correlations (not emitted)", "rank-based partial correlations (not implemented)"] },
    diagnostic: { level: "basic", emitted: ["partialling method", "inference boundary"], limitations: ["no multiplicity adjustment", "no Spearman or Kendall partial correlations"] },
    knownGaps: ["semi-partial correlations", "rank-based partial correlations", "multiplicity-adjusted matrix inference"],
  },
};

// ---------------------------------------------------------------------------------------------
// Mahalanobis outlier screen.
// ---------------------------------------------------------------------------------------------

const mahalanobisOutliers = {
  method: "mahalanobis_outliers",
  family: FAMILY,
  analysisModel: { families: ["pca"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["timeoutMs"],
  customOptions: {
    cutoffProbability: { schema: { type: "number", minimum: 0.5, maximum: 0.9999 }, default: 0.975, parse(value, H, path) { const number = H.finiteNumber(value, path); if (number < 0.5 || number > 0.9999) H.fail("STAT_INVALID_INPUT", `${path} must be in [0.5, 0.9999]`); return number; } },
    reweight: { schema: { type: "boolean" }, default: true, parse(value, H, path) { if (typeof value !== "boolean") H.fail("STAT_INVALID_INPUT", `${path} must be boolean`); return value; } },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["variables"],
    properties: {
      variables: { type: "array", minItems: 2, maxItems: 32, items: { type: "object", additionalProperties: false, required: ["values"], properties: { name: { type: "string", minLength: 1, maxLength: 128 }, values: { type: "array", minItems: 8, maxItems: 10000, items: { type: "number" } } } } },
      rowLabels: { type: "array", minItems: 8, maxItems: 10000, items: { type: "string", minLength: 1, maxLength: 128 } },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["variables", "rowLabels"], "data");
    const matrix = S.parseVariableMatrix(data, H, { minRows: 8, minVariables: 2, maxVariables: 32 });
    if (matrix.rowCount <= matrix.variables.length + 1) H.fail("STAT_INSUFFICIENT_SAMPLE", "the outlier screen requires at least p + 2 observations");
    return matrix;
  },
  analyze(parsed, options, budget, H) {
    const columns = variableColumns(parsed);
    const rows = S.columnsToRows(columns);
    const n = parsed.rowCount;
    const p = columns.length;
    const cutoff = S.chiSquareQuantile(options.cutoffProbability, p);
    const distancesFor = (subset) => {
      const subColumns = columns.map((column) => subset.map((row) => column[row]));
      const means = S.columnMeans(subColumns);
      const covariance = S.sampleCovariance(subColumns, budget);
      const precision = S.inverse(covariance);
      if (!precision) H.fail("STAT_SINGULAR_FIT", "covariance matrix is singular; remove collinear variables");
      const distances = rows.map((row) => {
        budget.check(p * p);
        const centered = row.map((value, axis) => value - means[axis]);
        return quadraticForm(centered, precision);
      });
      return { means, covariance, distances };
    };
    const classical = distancesFor(Array.from({ length: n }, (_, index) => index));
    const classicalFlags = classical.distances.map((value) => value > cutoff);
    let reweighted = null;
    let reweightedFlags = null;
    let reweightStatus = { name: "one-step reweighting", status: options.reweight ? "evaluated" : "disabled" };
    if (options.reweight) {
      const kept = classicalFlags.map((flag, index) => (flag ? -1 : index)).filter((index) => index >= 0);
      if (kept.length > p + 1) {
        reweighted = distancesFor(kept);
        reweightedFlags = reweighted.distances.map((value) => value > cutoff);
        reweightStatus = { ...reweightStatus, detail: `mean and covariance re-estimated from the ${kept.length} rows not flagged by the classical screen`, retainedRows: kept.length };
      } else reweightStatus = { name: "one-step reweighting", status: "not_evaluated", reason: "too few unflagged rows remain for a reweighted covariance" };
    }
    const distanceRows = rows.map((_, row) => ({ row: row + 1, label: parsed.rowLabels[row], classicalDistance: classical.distances[row], classicalPValue: S.chiSquareSurvival(classical.distances[row], p), classicalFlag: classicalFlags[row], reweightedDistance: reweighted ? reweighted.distances[row] : null, reweightedFlag: reweightedFlags ? reweightedFlags[row] : null, cutoff }));
    const finalFlags = reweightedFlags || classicalFlags;
    const flaggedCount = finalFlags.filter(Boolean).length;
    const names = parsed.variables.map((variable) => variable.name);
    return {
      sample: { n, variables: p, cutoffProbability: options.cutoffProbability, cutoff, flagged: flaggedCount },
      estimates: estimateEntries({ cutoff, classicalCenter: Object.fromEntries(names.map((name, axis) => [name, classical.means[axis]])), reweightedCenter: reweighted ? Object.fromEntries(names.map((name, axis) => [name, reweighted.means[axis]])) : null, distances: distanceRows, flaggedLabels: distanceRows.filter((row, index) => finalFlags[index]).map((row) => row.label), rendererDataContract: rendererContract(H, distanceRows) }),
      tests: [],
      confidenceIntervals: [],
      effectSizes: [{ name: "proportion flagged", estimate: flaggedCount / n }],
      assumptions: [
        { name: "approximate multivariate normality for the chi-square cutoff", status: "requires_design_review" },
        { name: "classical estimates are not high-breakdown", status: "acknowledged", detail: "masking by multiple outliers can hide extreme rows; the one-step reweighting reduces but does not remove masking" },
      ],
      diagnostics: [
        reweightStatus,
        { name: "robustness boundary", status: "not_established", detail: "minimum covariance determinant (MCD) and other high-breakdown estimators are out of scope; this is a classical screen with optional one-step reweighting" },
        { name: "cutoff", status: "evaluated", distribution: "chi-square", df: p, probability: options.cutoffProbability, cutoff },
        { name: "renderer exact-data contract", status: "verified", rows: distanceRows.length, rowsHash: H.sha256(distanceRows) },
      ],
      artifacts: [
        H.tableArtifact("Mahalanobis distances", `Squared distances with the chi-square(${p}) cutoff at probability ${options.cutoffProbability}.`, [{ key: "row", label: "Row", type: "number" }, { key: "label", label: "Label", type: "string" }, { key: "classicalDistance", label: "D2 classical", type: "number" }, { key: "classicalPValue", label: "Upper-tail p", type: "number" }, { key: "classicalFlag", label: "Flag classical", type: "boolean" }, { key: "reweightedDistance", label: "D2 reweighted", type: "number" }, { key: "reweightedFlag", label: "Flag reweighted", type: "boolean" }, { key: "cutoff", label: "Cutoff", type: "number" }], distanceRows, ["Reweighted columns are null when reweighting is disabled or not evaluable."], "mahalanobis-distance-table"),
        H.vegaArtifact("mahalanobis-distance-plot", "Squared Mahalanobis distance by observation", {
          data: { values: distanceRows },
          layer: [
            { mark: { type: "rule", color: "#A36D47", strokeDash: [6, 4] }, encoding: { y: { field: "cutoff", type: "quantitative" } } },
            { mark: { type: "point", filled: true, size: 60 }, encoding: { x: { field: "row", type: "quantitative", title: "Observation" }, y: { field: "classicalDistance", type: "quantitative", title: "Squared Mahalanobis distance" }, color: { field: "classicalFlag", type: "nominal", title: "Flagged", scale: { domain: [false, true], range: ["#285F8F", "#B3261E"] } }, tooltip: [{ field: "label" }, { field: "classicalDistance", format: ".3f" }, { field: "classicalPValue", format: ".4f" }] } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "Before multivariate modelling, when single rows may exert undue influence on covariance-based estimates and a documented, reproducible screen for multivariate outliers is required.",
    decision: "Which observations are multivariate outliers relative to the bulk, and whether they should be inspected, down-weighted, or excluded under a prespecified rule.",
    mustShow: "Each row's squared distance, the chi-square cutoff, flags from the classical and reweighted screens, and the estimated centre used for the distances.",
    userGoal: "Find suspicious multivariate rows transparently without silently altering the analysis set.",
    nextActions: [
      { trigger: "rows-flagged", action: "open-flagged-rows-and-verify-measurement", reason: "Flags are screening evidence; exclusion requires a documented substantive or measurement justification." },
      { trigger: "many-rows-flagged-or-masking-suspected", action: "use-high-breakdown-estimator-outside-this-plugin", reason: "Classical distances are masked by clusters of outliers; a high-breakdown method is needed for reliable detection." },
      { trigger: "no-rows-flagged", action: "proceed-with-planned-multivariate-analysis", reason: "The screen found no influential multivariate deviations under the stated cutoff." },
    ],
  },
  fixture: { data: { variables: IRIS_VARIABLES, rowLabels: IRIS_ROWS.map((_, index) => `iris-${index + 1}`) }, options: { cutoffProbability: 0.975 } },
  matlabParity: { taxonomyIds: ["matlab.stats.cluster-anomaly"] },
  coverage: {
    implementedBoundary: "Classical squared Mahalanobis distances with a chi-square cutoff at a stated probability, upper-tail p values, and an optional one-step reweighted re-estimation from unflagged rows; no high-breakdown (MCD) estimator.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["classical distances against numpy", "chi-square cutoff and p values against scipy", "reweighted distances against numpy"], excludedOutputs: ["MCD-based distances (out of scope)"] },
    diagnostic: { level: "method-specific-partial", emitted: ["one-step reweighting", "robustness boundary", "cutoff"], limitations: ["not a high-breakdown estimator", "chi-square cutoff assumes approximate normality"] },
    knownGaps: ["minimum covariance determinant and other high-breakdown estimators", "adjusted quantile cutoffs for small samples", "influence measures on downstream models"],
  },
};

module.exports = { methods: [exploratoryFactorAnalysis, manova, hotellingT2, linearDiscriminantAnalysis, canonicalCorrelationAnalysis, multidimensionalScaling, partialCorrelation, mahalanobisOutliers] };
