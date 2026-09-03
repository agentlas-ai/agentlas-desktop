"use strict";

/**
 * Shared deterministic numerics for regression-extended.cjs and causal-inference.cjs.
 * This file is NOT a method module (it is not listed in MODULE_FILES); it only exports helpers.
 * Everything here is pure JavaScript: no engine require, no Math.random, no Date, no I/O.
 */

const TWO64 = 1n << 64n;
const MASK64 = TWO64 - 1n;

/** SplitMix64 uniform generator on BigInt state; same stream is reproduced by the python oracle. */
function seededGenerator(seed) {
  let state = BigInt.asUintN(64, BigInt(seed));
  return {
    nextUint64() {
      state = (state + 0x9E3779B97F4A7C15n) & MASK64;
      let z = state;
      z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & MASK64;
      z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & MASK64;
      return z ^ (z >> 31n);
    },
    /** Uniform in [0, 1) using the top 53 bits. */
    next() {
      return Number(this.nextUint64() >> 11n) / 9007199254740992;
    },
    /** Integer in [0, bound) without modulo bias beyond 53-bit truncation (bound <= 2^31). */
    below(bound) {
      return Math.floor(this.next() * bound);
    },
  };
}

/** Deterministic Fisher-Yates shuffle of 0..n-1. */
function shuffledIndices(n, generator) {
  const indices = Array.from({ length: n }, (_, index) => index);
  for (let index = n - 1; index > 0; index -= 1) {
    const swap = generator.below(index + 1);
    [indices[index], indices[swap]] = [indices[swap], indices[index]];
  }
  return indices;
}

/** fold[i] in 0..k-1: shuffled index j is assigned to fold j mod k. */
function seededFolds(n, k, seed) {
  const order = shuffledIndices(n, seededGenerator(seed));
  const folds = Array(n).fill(0);
  order.forEach((row, position) => { folds[row] = position % k; });
  return folds;
}

function dot(a, b) {
  let total = 0;
  for (let index = 0; index < a.length; index += 1) total += a[index] * b[index];
  return total;
}

function matVec(matrix, vector) {
  return matrix.map((row) => dot(row, vector));
}

function crossProduct(x, weights, budget) {
  const p = x[0].length;
  const out = Array.from({ length: p }, () => Array(p).fill(0));
  for (let row = 0; row < x.length; row += 1) {
    const weight = weights ? weights[row] : 1;
    if (weight === 0) continue;
    const xi = x[row];
    for (let j = 0; j < p; j += 1) {
      const scaled = weight * xi[j];
      for (let k = j; k < p; k += 1) out[j][k] += scaled * xi[k];
    }
    if (budget) budget.check(p);
  }
  for (let j = 0; j < p; j += 1) for (let k = 0; k < j; k += 1) out[j][k] = out[k][j];
  return out;
}

function crossVector(x, weights, y) {
  const p = x[0].length;
  const out = Array(p).fill(0);
  for (let row = 0; row < x.length; row += 1) {
    const weight = (weights ? weights[row] : 1) * y[row];
    if (weight === 0) continue;
    const xi = x[row];
    for (let j = 0; j < p; j += 1) out[j] += weight * xi[j];
  }
  return out;
}

/** Symmetric positive-definite inverse via Cholesky; throws the caller-provided failure on breakdown. */
function invertSymmetric(matrix, H, code, message) {
  try {
    return H.invert(matrix);
  } catch (error) {
    if (error instanceof H.StatisticsError && error.code === "STAT_SINGULAR_MATRIX") H.fail(code, message);
    throw error;
  }
}

/** Weighted least squares. Returns beta, bread (X'WX)^-1, fitted, residuals. */
function weightedLeastSquares(y, x, weights, H, budget, code = "STAT_SINGULAR_FIT", message = "weighted design matrix is singular") {
  const bread = invertSymmetric(crossProduct(x, weights, budget), H, code, message);
  const beta = matVec(bread, crossVector(x, weights, y));
  const fitted = x.map((row) => dot(row, beta));
  const residuals = y.map((value, index) => value - fitted[index]);
  return { beta, bread, fitted, residuals };
}

/**
 * Heteroskedasticity-consistent sandwich for (weighted) least squares.
 * scores[i] = w_i * e_i is the per-row score scale; leverage optional (needed for hc2/hc3).
 */
function hcCovariance(x, bread, scores, type, H, budget, leverage = null, kParameters = null) {
  const n = x.length;
  const p = x[0].length;
  const k = kParameters === null ? p : kParameters;
  const meat = Array.from({ length: p }, () => Array(p).fill(0));
  for (let row = 0; row < n; row += 1) {
    let scale = scores[row] ** 2;
    if (type === "hc1") scale *= n / (n - k);
    if (type === "hc2") scale /= Math.max(1e-12, 1 - leverage[row]);
    if (type === "hc3") scale /= Math.max(1e-12, (1 - leverage[row]) ** 2);
    const xi = x[row];
    for (let j = 0; j < p; j += 1) {
      const scaled = scale * xi[j];
      for (let l = 0; l < p; l += 1) meat[j][l] += scaled * xi[l];
    }
    if (budget) budget.check(p);
  }
  return H.matMul(H.matMul(bread, meat, budget), bread, budget);
}

/**
 * Newey-West heteroskedasticity- and autocorrelation-consistent (HAC) sandwich meat.
 *
 * meat = G(0) + sum_{l=1..L} (1 - l/(L+1)) (G(l) + G(l)'), with G(l) = sum_t s_t s_{t-l}'
 * and s_t = x_t * u_t. The Bartlett weights guarantee a positive semi-definite estimate.
 *
 * Rows must be in time order: the estimator reads adjacency as lag, so shuffled rows give a
 * confident wrong answer rather than an error. Callers that cannot prove the order must say so
 * in their diagnostics.
 *
 * No small-sample correction is applied, which is what statsmodels reports for
 * `cov_type="HAC"` with `use_correction=False`, so the two agree to the last digits.
 */
function hacCovariance(x, bread, scores, lags, H, budget) {
  const n = x.length;
  const p = x[0].length;
  if (!Number.isInteger(lags) || lags < 0 || lags >= n) H.fail("STAT_INVALID_INPUT", "HAC lag length must be an integer in [0, n)");
  const meat = Array.from({ length: p }, () => Array(p).fill(0));
  const score = (row) => x[row].map((value) => value * scores[row]);
  const cached = Array.from({ length: n }, (_, row) => score(row));
  for (let row = 0; row < n; row += 1) {
    const s = cached[row];
    for (let j = 0; j < p; j += 1) for (let l = 0; l < p; l += 1) meat[j][l] += s[j] * s[l];
    if (budget) budget.check(p);
  }
  for (let lag = 1; lag <= lags; lag += 1) {
    const weight = 1 - lag / (lags + 1);
    for (let row = lag; row < n; row += 1) {
      const current = cached[row];
      const previous = cached[row - lag];
      for (let j = 0; j < p; j += 1) {
        for (let l = 0; l < p; l += 1) meat[j][l] += weight * (current[j] * previous[l] + previous[j] * current[l]);
      }
      if (budget) budget.check(p);
    }
  }
  return H.matMul(H.matMul(bread, meat, budget), bread, budget);
}

/**
 * The lag length to use when the analyst does not choose one: floor(4 (n/100)^(2/9)),
 * the rule of thumb from Newey & West (1994) as implemented by statsmodels' `maxlags=None`
 * path and by Stata's `newey`. Reported alongside the estimate so the choice is never silent.
 */
function automaticHacLags(n) {
  return Math.max(0, Math.floor(4 * Math.pow(n / 100, 2 / 9)));
}

/** Cluster-robust (CR1, Stata-style small-sample factor) sandwich; clusters are integer ids per row. */
function clusterCovariance(x, bread, scores, clusters, H, budget, kParameters) {
  const n = x.length;
  const p = x[0].length;
  const clusterScores = new Map();
  for (let row = 0; row < n; row += 1) {
    const id = clusters[row];
    let vector = clusterScores.get(id);
    if (!vector) { vector = Array(p).fill(0); clusterScores.set(id, vector); }
    const xi = x[row];
    for (let j = 0; j < p; j += 1) vector[j] += scores[row] * xi[j];
    if (budget) budget.check();
  }
  const g = clusterScores.size;
  const meat = Array.from({ length: p }, () => Array(p).fill(0));
  for (const vector of clusterScores.values()) {
    for (let j = 0; j < p; j += 1) for (let l = 0; l < p; l += 1) meat[j][l] += vector[j] * vector[l];
  }
  const factor = (g / (g - 1)) * ((n - 1) / (n - kParameters));
  const covariance = H.matMul(H.matMul(bread, meat, budget), bread, budget).map((row) => row.map((value) => value * factor));
  return { covariance, clusters: g, factor };
}

function leverageFromBread(x, bread, weights = null) {
  return x.map((row, index) => {
    let value = 0;
    for (let j = 0; j < row.length; j += 1) {
      let partial = 0;
      for (let k = 0; k < row.length; k += 1) partial += bread[j][k] * row[k];
      value += row[j] * partial;
    }
    return Math.max(0, Math.min(1 - 1e-12, value * (weights ? weights[index] : 1)));
  });
}

/** Coefficient rows with typed columns; df === null means a normal (z) reference. */
function coefficientRows(names, beta, covariance, df, confidenceLevel, H, options = {}) {
  const critical = df === null ? H.normalInv(1 - (1 - confidenceLevel) / 2) : H.tCritical(confidenceLevel, df);
  return beta.map((estimate, index) => {
    const variance = covariance[index][index];
    if (!(variance > 0) || !Number.isFinite(variance)) H.fail("STAT_DEGENERATE", `standard error for ${names[index]} is not positive and finite`);
    const standardError = Math.sqrt(variance);
    const statistic = estimate / standardError;
    const pValue = df === null ? H.pFromNormal(statistic, "two-sided") : H.pFromT(statistic, df, "two-sided");
    const lower = estimate - critical * standardError;
    const upper = estimate + critical * standardError;
    const row = { term: names[index], estimate, standardError, statistic, df: df === null ? null : df, pValue, lower, upper };
    if (options.expKey) {
      row[options.expKey] = H.finiteExp(estimate, `${names[index]} ${options.expKey}`);
      row[`${options.expKey}Lower`] = H.finiteExp(lower, `${names[index]} ${options.expKey} lower`);
      row[`${options.expKey}Upper`] = H.finiteExp(upper, `${names[index]} ${options.expKey} upper`);
    }
    return row;
  });
}

const COEFFICIENT_COLUMNS = Object.freeze([
  { key: "term", label: "Term", type: "string" },
  { key: "estimate", label: "Estimate", type: "number" },
  { key: "standardError", label: "SE", type: "number" },
  { key: "statistic", label: "Statistic", type: "number" },
  { key: "df", label: "df", type: "number" },
  { key: "pValue", label: "p", type: "number" },
  { key: "lower", label: "CI lower", type: "number" },
  { key: "upper", label: "CI upper", type: "number" },
]);

function coefficientColumns(statisticLabel = "t", extra = []) {
  return COEFFICIENT_COLUMNS.map((column) => column.key === "statistic" ? { ...column, label: statisticLabel } : column).concat(extra);
}

/** Forest plot over coefficient rows (rows must be the exact table rows). */
function forestPlot(H, role, title, rows, { xTitle = "Estimate", estimateField = "estimate", lowerField = "lower", upperField = "upper", referenceValue = 0, logScale = false, colorField = null, yField = "term", rowFacet = null } = {}) {
  const scale = logScale ? { scale: { type: "log" } } : {};
  const colorEncoding = colorField ? { color: { field: colorField, type: "nominal", title: colorField } } : {};
  const yOffset = colorField ? { yOffset: { field: colorField } } : {};
  const layer = [
    { mark: { type: "rule", strokeWidth: 2 }, encoding: { y: { field: yField, type: "nominal", title: null }, ...yOffset, x: { field: lowerField, type: "quantitative", title: xTitle, ...scale }, x2: { field: upperField }, ...colorEncoding } },
    { mark: { type: "point", filled: true, size: 80 }, encoding: { y: { field: yField, type: "nominal" }, ...yOffset, x: { field: estimateField, type: "quantitative", ...scale }, ...colorEncoding, tooltip: [{ field: yField }, { field: estimateField, format: ".5g" }, { field: lowerField, format: ".5g" }, { field: upperField, format: ".5g" }] } },
    { mark: { type: "rule", strokeDash: [4, 4], color: "#777" }, encoding: { x: { datum: referenceValue, ...scale } } },
  ];
  if (rowFacet) {
    // Both scales resolve independently per row. Facets share their scales by default, which for a
    // forest means every panel lists every term -- an alpha panel with three empty factor rows
    // under it, and a loadings panel with an empty alpha row -- and puts an alpha of 0.004 on the
    // same x axis as a loading of 1.03, where the alpha's interval is a sliver. The whole reason to
    // facet these is that the two groups are on different scales.
    return H.vegaArtifact(role, title, {
      data: { values: rows },
      facet: { row: { field: rowFacet, type: "nominal", title: null } },
      spec: { layer },
      resolve: { scale: { x: "independent", y: "independent" } },
    });
  }
  return H.vegaArtifact(role, title, { data: { values: rows }, layer });
}

function scatterPlot(H, role, title, rows, xField, yField, { xTitle = xField, yTitle = yField, referenceY = null, colorField = null, tooltip = [] } = {}) {
  const colorEncoding = colorField ? { color: { field: colorField, type: "nominal" } } : {};
  const layer = [{ mark: { type: "point", filled: true, opacity: 0.75 }, encoding: { x: { field: xField, type: "quantitative", title: xTitle }, y: { field: yField, type: "quantitative", title: yTitle }, ...colorEncoding, tooltip: tooltip.map((field) => ({ field })) } }];
  if (referenceY !== null) layer.push({ mark: { type: "rule", strokeDash: [4, 4], color: "#777" }, encoding: { y: { datum: referenceY } } });
  return H.vegaArtifact(role, title, { data: { values: rows }, layer });
}

/** Digamma via recurrence + asymptotic series. */
function digamma(x) {
  let value = 0;
  let z = x;
  while (z < 6) { value -= 1 / z; z += 1; }
  const inv = 1 / z;
  const inv2 = inv * inv;
  value += Math.log(z) - 0.5 * inv - inv2 * (1 / 12 - inv2 * (1 / 120 - inv2 * (1 / 252 - inv2 * (1 / 240 - inv2 / 132))));
  return value;
}

/** Trigamma via recurrence + asymptotic series. */
function trigamma(x) {
  let value = 0;
  let z = x;
  while (z < 6) { value += 1 / (z * z); z += 1; }
  const inv = 1 / z;
  const inv2 = inv * inv;
  value += inv + 0.5 * inv2 + inv * inv2 * (1 / 6 - inv2 * (1 / 30 - inv2 * (1 / 42 - inv2 / 30)));
  return value;
}

/** Standardize columns with mean 0 and sample (n-1) standard deviation 1. */
function standardizeColumns(x, H) {
  const n = x.length;
  const p = x[0].length;
  const centers = Array(p).fill(0);
  const scales = Array(p).fill(0);
  for (let j = 0; j < p; j += 1) {
    let total = 0;
    for (let row = 0; row < n; row += 1) total += x[row][j];
    centers[j] = total / n;
    let squares = 0;
    for (let row = 0; row < n; row += 1) squares += (x[row][j] - centers[j]) ** 2;
    scales[j] = Math.sqrt(squares / (n - 1));
    if (!(scales[j] > 0)) H.fail("STAT_DEGENERATE", `design column ${j + 1} has zero variance after expansion`);
  }
  const z = x.map((row) => row.map((value, j) => (value - centers[j]) / scales[j]));
  return { z, centers, scales };
}

/** Binary logistic maximum likelihood by Newton-Raphson; returns null on divergence when soft=true. */
function logisticFit(y, x, H, budget, { maxIterations = 100, tolerance = 1e-10, soft = false } = {}) {
  const n = y.length;
  const p = x[0].length;
  let beta = Array(p).fill(0);
  let converged = false;
  let iterations = 0;
  const failure = (message) => {
    if (soft) return null;
    return H.fail("STAT_NON_CONVERGENCE", message);
  };
  for (iterations = 1; iterations <= maxIterations; iterations += 1) {
    budget.check(1024);
    const eta = x.map((row) => dot(row, beta));
    const probabilities = eta.map((value) => H.sigmoid(value));
    const weights = probabilities.map((probability) => Math.max(1e-10, probability * (1 - probability)));
    const information = crossProduct(x, weights, budget);
    let inverse;
    try { inverse = H.invert(information); } catch { return failure("logistic information matrix is singular"); }
    const score = crossVector(x, null, y.map((value, index) => value - probabilities[index]));
    const step = matVec(inverse, score);
    const next = beta.map((value, index) => value + step[index]);
    if (next.some((value) => !Number.isFinite(value) || Math.abs(value) > 30)) return failure("logistic fit shows complete or quasi-complete separation or numeric divergence");
    const delta = Math.max(...step.map(Math.abs));
    beta = next;
    if (delta < tolerance) { converged = true; break; }
  }
  if (!converged) return failure(`logistic fit did not converge in ${maxIterations} iterations`);
  const eta = x.map((row) => dot(row, beta));
  const probabilities = eta.map((value) => H.sigmoid(value));
  const weights = probabilities.map((probability) => Math.max(1e-10, probability * (1 - probability)));
  let covariance;
  try { covariance = H.invert(crossProduct(x, weights, budget)); } catch { return failure("logistic information matrix is singular at the optimum"); }
  const epsilon = 1e-15;
  const logLikelihood = y.reduce((total, value, index) => total + value * Math.log(Math.max(epsilon, probabilities[index])) + (1 - value) * Math.log(Math.max(epsilon, 1 - probabilities[index])), 0);
  return { beta, covariance, probabilities, weights, logLikelihood, iterations, eta, n };
}

function sampleVariance(values) {
  const n = values.length;
  const center = values.reduce((total, value) => total + value, 0) / n;
  return values.reduce((total, value) => total + (value - center) ** 2, 0) / (n - 1);
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** Unique sorted category levels from strings with deterministic en collation. */
function sortedLevels(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, "en"));
}

/** Integer cluster ids from string labels in first-appearance order. */
function clusterIds(labels) {
  const map = new Map();
  return labels.map((labelValue) => {
    if (!map.has(labelValue)) map.set(labelValue, map.size);
    return map.get(labelValue);
  });
}

function gaussianLogLikelihood(rss, n) {
  return -n / 2 * (Math.log(2 * Math.PI * rss / n) + 1);
}

/** Ordinary/weighted least squares with classical, HC0-HC3, or cluster-robust covariance. */
function olsFit(y, x, H, budget, { covariance = "classical", clusters = null, weights = null } = {}) {
  const n = y.length;
  const p = x[0].length;
  if (n <= p) H.fail("STAT_INSUFFICIENT_SAMPLE", `at least ${p + 1} observations are required for ${p} parameters`);
  const fit = weightedLeastSquares(y, x, weights, H, budget, "STAT_RANK_DEFICIENT", "design matrix is rank deficient or ill-conditioned");
  const scores = fit.residuals.map((value, index) => (weights ? weights[index] : 1) * value);
  let rss = 0;
  for (let index = 0; index < n; index += 1) rss += (weights ? weights[index] : 1) * fit.residuals[index] ** 2;
  const df = n - p;
  const sigma2 = rss / df;
  let covarianceMatrix;
  let dfReference = df;
  let clusterInfo = null;
  if (clusters) {
    const cluster = clusterCovariance(x, fit.bread, scores, clusters, H, budget, p);
    covarianceMatrix = cluster.covariance;
    clusterInfo = { clusters: cluster.clusters, factor: cluster.factor };
    dfReference = null;
  } else if (covariance === "classical") {
    covarianceMatrix = fit.bread.map((row) => row.map((value) => value * sigma2));
  } else {
    const leverage = (covariance === "hc2" || covariance === "hc3") ? leverageFromBread(x, fit.bread, weights) : null;
    covarianceMatrix = hcCovariance(x, fit.bread, scores, covariance, H, budget, leverage, p);
    dfReference = null;
  }
  const yMean = mean(y);
  let tss = 0;
  for (let index = 0; index < n; index += 1) tss += (weights ? weights[index] : 1) * (y[index] - yMean) ** 2;
  return { ...fit, rss, tss, sigma2, df, n, p, covariance: covarianceMatrix, dfReference, clusterInfo, rSquared: tss > 0 ? 1 - rss / tss : 0, logLikelihood: gaussianLogLikelihood(rss, n) };
}

/** Poisson log-linear regression by Newton-Raphson with optional log offset. Returns null on divergence when soft=true. */
function poissonFit(y, x, H, budget, { offset = null, maxIterations = 100, tolerance = 1e-10, soft = false } = {}) {
  const n = y.length;
  const p = x[0].length;
  const failure = (message) => (soft ? null : H.fail("STAT_NON_CONVERGENCE", message));
  const meanY = Math.max(1e-8, mean(y));
  let beta = Array(p).fill(0);
  if (x.every((row) => row[0] === 1)) beta[0] = Math.log(meanY) - (offset ? mean(offset) : 0);
  let converged = false;
  let iterations = 0;
  let mu = null;
  for (iterations = 1; iterations <= maxIterations; iterations += 1) {
    budget.check(1024);
    const eta = x.map((row, index) => dot(row, beta) + (offset ? offset[index] : 0));
    mu = eta.map((value) => Math.exp(Math.min(700, value)));
    if (mu.some((value) => !Number.isFinite(value))) return failure("Poisson fit diverged");
    let inverse;
    try { inverse = H.invert(crossProduct(x, mu, budget)); } catch { return failure("Poisson information matrix is singular"); }
    const score = crossVector(x, null, y.map((value, index) => value - mu[index]));
    const step = matVec(inverse, score);
    let scale = 1;
    let next = beta.map((value, index) => value + step[index]);
    for (let halving = 0; halving < 30 && next.some((value) => !Number.isFinite(value) || Math.abs(value) > 50); halving += 1) {
      scale /= 2;
      next = beta.map((value, index) => value + scale * step[index]);
    }
    const delta = Math.max(...step.map((value) => Math.abs(scale * value)));
    beta = next;
    if (delta < tolerance) { converged = true; break; }
  }
  if (!converged) return failure(`Poisson fit did not converge in ${maxIterations} iterations`);
  const eta = x.map((row, index) => dot(row, beta) + (offset ? offset[index] : 0));
  mu = eta.map((value) => Math.exp(value));
  let covariance;
  try { covariance = H.invert(crossProduct(x, mu, budget)); } catch { return failure("Poisson information matrix is singular at the optimum"); }
  let logLikelihood = 0;
  let deviance = 0;
  let pearson = 0;
  for (let index = 0; index < n; index += 1) {
    const yi = y[index];
    logLikelihood += yi * Math.log(mu[index]) - mu[index] - H.logGamma(yi + 1);
    deviance += 2 * ((yi > 0 ? yi * Math.log(yi / mu[index]) : 0) - (yi - mu[index]));
    pearson += (yi - mu[index]) ** 2 / mu[index];
  }
  return { beta, covariance, mu, eta, logLikelihood, deviance, pearson, iterations, n, p };
}

/** Wald chi-square for a subset of coefficients: b' V^-1 b. */
function waldChiSquare(estimates, covariance, indices, H) {
  const sub = indices.map((row) => indices.map((column) => covariance[row][column]));
  const inverse = invertSymmetric(sub, H, "STAT_SINGULAR_FIT", "Wald covariance block is singular");
  const vector = indices.map((index) => estimates[index]);
  const statistic = dot(vector, matVec(inverse, vector));
  return { statistic, df: indices.length, pValue: H.pFromChiSquare(statistic, indices.length) };
}

/** Weighted mean and reliability-weight variance (sum w (x - m)^2 / (sum w - sum w^2 / sum w)). */
function weightedMoments(values, weights) {
  let sumW = 0;
  let sumW2 = 0;
  let sumWX = 0;
  for (let index = 0; index < values.length; index += 1) { sumW += weights[index]; sumW2 += weights[index] ** 2; sumWX += weights[index] * values[index]; }
  const center = sumWX / sumW;
  let squares = 0;
  for (let index = 0; index < values.length; index += 1) squares += weights[index] * (values[index] - center) ** 2;
  const denominator = sumW - sumW2 / sumW;
  return { mean: center, variance: denominator > 0 ? squares / denominator : 0, sumWeights: sumW, effectiveSampleSize: sumW * sumW / sumW2 };
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const n = ordered.length;
  return n % 2 === 1 ? ordered[(n - 1) / 2] : (ordered[n / 2 - 1] + ordered[n / 2]) / 2;
}

/** Column-major design description shared by the regression and causal modules. */
function buildDesign(y, predictors, H, intercept = true) {
  const design = H.designMatrix({ y, predictors }, intercept);
  const p = design.x[0].length;
  if (y.length <= p + 1) H.fail("STAT_INSUFFICIENT_SAMPLE", `at least ${p + 2} observations are required for ${p} design columns`);
  if (H.matrixRank(design.x) < p) H.fail("STAT_RANK_DEFICIENT", "design matrix is rank deficient after categorical expansion");
  return design;
}

function logSpacedGrid(maximum, ratio, count) {
  const minimum = maximum * ratio;
  const logMax = Math.log(maximum);
  const logMin = Math.log(minimum);
  return Array.from({ length: count }, (_, index) => Math.exp(logMax - (logMax - logMin) * index / (count - 1)));
}

module.exports = {
  seededGenerator, shuffledIndices, seededFolds,
  dot, matVec, crossProduct, crossVector, invertSymmetric, weightedLeastSquares, hcCovariance, hacCovariance, automaticHacLags, clusterCovariance, leverageFromBread,
  coefficientRows, coefficientColumns, forestPlot, scatterPlot,
  digamma, trigamma, standardizeColumns, logisticFit, sampleVariance, mean, sortedLevels, clusterIds, gaussianLogLikelihood,
  olsFit, poissonFit, waldChiSquare, weightedMoments, median, buildDesign, logSpacedGrid,
};
