"use strict";

/**
 * Numeric kernels for the time-series-extended method family.
 *
 * This file is NOT a method module (it is not listed in index.cjs MODULE_FILES); it is a
 * sibling helper required by time-series-extended.cjs. Everything here is pure, deterministic
 * JavaScript. All validation/failure helpers arrive through the engine `H` object so this
 * file never requires engine.cjs.
 */

// ---------------------------------------------------------------------------------------------
// Accurate normal tails (the engine normalCdf is an erf approximation, ~1.5e-7 absolute).
// ---------------------------------------------------------------------------------------------

function normalSf(H, z) {
  if (!Number.isFinite(z)) return z > 0 ? 0 : 1;
  const tail = 0.5 * H.gammaQ(0.5, z * z / 2);
  return z >= 0 ? tail : 1 - tail;
}

function normalCdfAccurate(H, z) {
  return 1 - normalSf(H, z);
}

function twoSidedNormalP(H, z) {
  return Math.min(1, 2 * normalSf(H, Math.abs(z)));
}

// ---------------------------------------------------------------------------------------------
// Series parsing shared by every method in the family.
// ---------------------------------------------------------------------------------------------

function parseSeries(data, H, { minLength = 8, allowIrregular = false, maxRows = null } = {}) {
  H.assertKeys(data, ["values", "time", "seriesLabel", "timeLabel"], "data");
  const values = H.numericVector(data.values, "data.values", minLength);
  const cap = maxRows === null ? H.LIMITS.maxTimeSeriesRows : maxRows;
  if (values.length > cap) H.fail("STAT_LIMIT_EXCEEDED", `time-series rows exceed ${cap}`);
  let time;
  let explicitTime = false;
  let interval = 1;
  let regular = true;
  if (data.time === undefined) time = values.map((_, index) => index + 1);
  else {
    time = H.numericVector(data.time, "data.time", minLength);
    if (time.length !== values.length) H.fail("STAT_INVALID_INPUT", "data.time length must match data.values");
    explicitTime = true;
    const deltas = time.slice(1).map((value, index) => value - time[index]);
    if (deltas.some((value) => !(value > 0))) H.fail("STAT_INVALID_INPUT", "data.time must be strictly increasing");
    interval = deltas[0];
    const spacingTolerance = Math.max(1e-12, Math.abs(interval) * 1e-9);
    regular = !deltas.some((value) => Math.abs(value - interval) > spacingTolerance);
    if (!regular && !allowIrregular) H.fail("STAT_INVALID_INPUT", "this method requires evenly spaced observations (data.time must have a constant step)");
    if (!regular) interval = (time[time.length - 1] - time[0]) / (time.length - 1);
  }
  return {
    values,
    time,
    explicitTime,
    regular,
    interval,
    seriesLabel: H.label(data.seriesLabel, "Value", "data.seriesLabel"),
    timeLabel: H.label(data.timeLabel, "Time", "data.timeLabel"),
  };
}

function sampleVariance(values) {
  const n = values.length;
  const center = values.reduce((a, b) => a + b, 0) / n;
  let total = 0;
  for (const value of values) total += (value - center) ** 2;
  return total / (n - 1);
}

function meanOf(values) {
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

// ---------------------------------------------------------------------------------------------
// OLS with Gaussian log-likelihood (matches statsmodels OLS llf/aic/bic conventions).
// ---------------------------------------------------------------------------------------------

function olsFit(H, y, x, budget) {
  const n = y.length;
  const k = x[0].length;
  if (n <= k) H.fail("STAT_INSUFFICIENT_SAMPLE", `regression needs more than ${k} observations, got ${n}`);
  const core = H.olsCore(y, x, budget);
  let rss = 0;
  for (const value of core.residuals) rss += value * value;
  const dfResid = n - k;
  const sigma2 = rss / dfResid;
  const se = core.beta.map((_, index) => Math.sqrt(Math.max(0, sigma2 * core.inverse[index][index])));
  const t = core.beta.map((value, index) => (se[index] > 0 ? value / se[index] : 0));
  const p = t.map((value) => H.pFromT(value, dfResid, "two-sided"));
  const llf = rss > 0 ? -n / 2 * (Math.log(2 * Math.PI) + Math.log(rss / n) + 1) : Infinity;
  return {
    beta: core.beta, se, t, p, fitted: core.fitted, residuals: core.residuals, inverse: core.inverse,
    rss, sigma2, dfResid, n, k, llf, aic: -2 * llf + 2 * k, bic: -2 * llf + Math.log(n) * k,
  };
}

// ---------------------------------------------------------------------------------------------
// Differencing
// ---------------------------------------------------------------------------------------------

function differenceOnce(values, lag) {
  const out = [];
  for (let index = lag; index < values.length; index += 1) out.push(values[index] - values[index - lag]);
  return out;
}

function applyDifferencing(values, d, D, s) {
  let work = [...values];
  for (let index = 0; index < D; index += 1) work = differenceOnce(work, s);
  for (let index = 0; index < d; index += 1) work = differenceOnce(work, 1);
  return work;
}

/**
 * Integrate h-step forecasts of the fully differenced series back to the original scale.
 * `history` is the original series; returns the reconstructed future values. When
 * `linearOnly` is true, the history is treated as all-zero so the result is the linear map
 * of the future differenced values (used to build the forecast covariance).
 */
function integrateForecasts(history, futureDiff, d, D, s, linearOnly = false) {
  const base = linearOnly ? history.map(() => 0) : history;
  // Reconstruct the chain of intermediate series: y -> after D seasonal diffs -> after d regular diffs.
  const chain = [base];
  let work = base;
  for (let index = 0; index < D; index += 1) { work = differenceOnce(work, s); chain.push(work); }
  for (let index = 0; index < d; index += 1) { work = differenceOnce(work, 1); chain.push(work); }
  // chain[last] is the differenced series; extend it with the forecasts and undo each step.
  let extended = [...chain[chain.length - 1], ...futureDiff];
  const h = futureDiff.length;
  for (let level = chain.length - 2; level >= 0; level -= 1) {
    const lag = level >= D ? 1 : s; // levels 0..D-1 were seasonal differences, D..D+d-1 regular
    const parent = [...chain[level]];
    const parentLength = parent.length;
    for (let step = 0; step < h; step += 1) {
      const index = parentLength + step;
      parent.push(parent[index - lag] + extended[extended.length - h + step]);
    }
    extended = parent;
  }
  return extended.slice(extended.length - h);
}

// ---------------------------------------------------------------------------------------------
// Unit-root tests
// ---------------------------------------------------------------------------------------------

// MacKinnon (1994) tau p-value response surfaces (N = 1), exactly as tabulated in
// statsmodels.tsa.adfvalues (small-p and large-p polynomials with scaling applied here).
const MACKINNON_1994 = Object.freeze({
  n: { max: Infinity, min: -19.04, star: -1.04, small: [0.6344, 1.2378, 3.2496e-2], large: [0.4797, 9.3557e-1, -0.6999e-1, 3.3066e-2] },
  c: { max: 2.74, min: -18.83, star: -1.61, small: [2.1659, 1.4412, 3.8269e-2], large: [1.7339, 9.3202e-1, -1.2745e-1, -1.0368e-2] },
  ct: { max: 0.7, min: -16.18, star: -2.89, small: [3.2512, 1.6047, 4.9588e-2], large: [2.5261, 6.1654e-1, -3.7956e-1, -6.0285e-2] },
});

// MacKinnon (2010) critical value response surfaces (N = 1), rows 1%, 5%, 10%; columns are the
// polynomial coefficients in 1/T: cv(T) = b0 + b1/T + b2/T^2 + b3/T^3. The "n" case is from 1996.
const MACKINNON_2010 = Object.freeze({
  n: [[-2.56574, -2.2358, -3.627, 0], [-1.94100, -0.2686, -3.365, 31.223], [-1.61682, 0.2656, -2.714, 25.364]],
  c: [[-3.43035, -6.5393, -16.786, -79.433], [-2.86154, -2.8903, -4.234, -40.040], [-2.56677, -1.5384, -2.809, 0]],
  ct: [[-3.95877, -9.0531, -28.428, -134.155], [-3.41049, -4.3904, -9.036, -45.374], [-3.12705, -2.5856, -3.925, -22.380]],
});

function polyval(coefficients, x) {
  // coefficients[0] + coefficients[1] x + ...
  let value = 0;
  for (let index = coefficients.length - 1; index >= 0; index -= 1) value = value * x + coefficients[index];
  return value;
}

function mackinnonP(H, statistic, regression) {
  const table = MACKINNON_1994[regression];
  if (statistic > table.max) return 1;
  if (statistic < table.min) return 0;
  const coefficients = statistic <= table.star ? table.small : table.large;
  return normalCdfAccurate(H, polyval(coefficients, statistic));
}

function mackinnonCritical(regression, nobs) {
  return MACKINNON_2010[regression].map((row) => polyval(row, 1 / nobs));
}

function deterministicColumns(regression, nobs, offset = 0) {
  // returns a function row -> deterministic terms (constant, trend) for regression n|c|ct
  return (index) => {
    if (regression === "n") return [];
    if (regression === "c") return [1];
    return [1, index + 1 + offset];
  };
}

/**
 * Augmented Dickey–Fuller regression following statsmodels.adfuller:
 * Δy_t = ρ y_{t-1} + Σ_{i=1..lag} δ_i Δy_{t-i} + deterministic + ε_t
 * With autolag the lag is chosen over 0..maxLag using the same trimmed sample, then refit.
 */
function adfRegression(H, values, regression, lag, budget) {
  const diff = differenceOnce(values, 1);
  const nobs = diff.length - lag;
  if (nobs < 3 + lag + (regression === "n" ? 0 : regression.length)) H.fail("STAT_INSUFFICIENT_SAMPLE", "ADF regression has too few observations for the requested lag");
  const y = [];
  const x = [];
  for (let t = lag; t < diff.length; t += 1) {
    y.push(diff[t]);
    const row = [];
    if (regression !== "n") row.push(1);
    if (regression === "ct") row.push(t - lag + 1);
    row.push(values[t]); // level y_{t} corresponds to Δy_{t+1}; values index t is the lagged level
    for (let i = 1; i <= lag; i += 1) row.push(diff[t - i]);
    x.push(row);
  }
  const fit = olsFit(H, y, x, budget);
  const levelIndex = regression === "n" ? 0 : regression === "c" ? 1 : 2;
  return { fit, nobs, levelIndex, lag };
}

function augmentedDickeyFuller(H, values, { regression, maxLag, autolag }, budget) {
  const n = values.length;
  const ntrend = regression === "n" ? 0 : regression.length;
  let chosenMax = maxLag;
  if (chosenMax === null) chosenMax = Math.min(Math.floor(n / 2) - ntrend - 1, Math.ceil(12 * (n / 100) ** 0.25));
  if (chosenMax < 0) H.fail("STAT_INSUFFICIENT_SAMPLE", "sample size is too short for the requested deterministic terms");
  if (chosenMax > Math.floor(n / 2) - ntrend - 1) H.fail("STAT_INVALID_INPUT", `options.maxLag must be at most ${Math.floor(n / 2) - ntrend - 1} for this series`);
  const searchRows = [];
  let usedLag = chosenMax;
  let icBest = null;
  if (autolag !== "none") {
    // Same sample for every candidate: trim to the maxLag sample, then vary the number of lag columns.
    const diff = differenceOnce(values, 1);
    const nobs = diff.length - chosenMax;
    const y = [];
    const full = [];
    for (let t = chosenMax; t < diff.length; t += 1) {
      y.push(diff[t]);
      const row = [];
      if (regression !== "n") row.push(1);
      if (regression === "ct") row.push(t - chosenMax + 1);
      row.push(values[t]);
      for (let i = 1; i <= chosenMax; i += 1) row.push(diff[t - i]);
      full.push(row);
    }
    let best = null;
    for (let lag = 0; lag <= chosenMax; lag += 1) {
      budget.check(nobs);
      const columns = ntrend + 1 + lag;
      const x = full.map((row) => row.slice(0, columns));
      const fit = olsFit(H, y, x, budget);
      const ic = autolag === "aic" ? fit.aic : fit.bic;
      searchRows.push({ lag, nobs, aic: fit.aic, bic: fit.bic, criterion: ic, tStatistic: fit.t[ntrend] });
      if (best === null || ic < best.ic) best = { ic, lag };
    }
    usedLag = best.lag;
    icBest = best.ic;
  }
  const { fit, nobs, levelIndex } = adfRegression(H, values, regression, usedLag, budget);
  const statistic = fit.t[levelIndex];
  const pValue = mackinnonP(H, statistic, regression);
  const critical = mackinnonCritical(regression, nobs);
  const coefficientRows = [];
  const names = [];
  if (regression !== "n") names.push("const");
  if (regression === "ct") names.push("trend");
  names.push("y.lag1");
  for (let i = 1; i <= usedLag; i += 1) names.push(`dy.lag${i}`);
  for (let index = 0; index < names.length; index += 1) {
    coefficientRows.push({ term: names[index], estimate: fit.beta[index], standardError: fit.se[index], tStatistic: fit.t[index], pValue: fit.p[index] });
  }
  return { statistic, pValue, usedLag, maxLag: chosenMax, nobs, critical: { "1%": critical[0], "5%": critical[1], "10%": critical[2] }, icBest, autolag, searchRows, coefficientRows, fit };
}

function kpssTest(H, values, { regression, nlags }, budget) {
  const n = values.length;
  let residuals;
  let critical;
  if (regression === "ct") {
    const x = values.map((_, index) => [1, index + 1]);
    residuals = olsFit(H, values, x, budget).residuals;
    critical = [0.119, 0.146, 0.176, 0.216];
  } else {
    const center = meanOf(values);
    residuals = values.map((value) => value - center);
    critical = [0.347, 0.463, 0.574, 0.739];
  }
  let lags;
  let lagRule;
  if (nlags === null) {
    // Hobijn et al. (1998) automatic bandwidth for the Bartlett kernel (statsmodels "auto").
    const covlags = Math.floor(n ** (2 / 9));
    let s0 = 0;
    for (const value of residuals) s0 += value * value;
    s0 /= n;
    let s1 = 0;
    for (let i = 1; i <= covlags; i += 1) {
      let product = 0;
      for (let t = i; t < n; t += 1) { budget.check(); product += residuals[t] * residuals[t - i]; }
      product /= n / 2;
      s0 += product;
      s1 += i * product;
    }
    const sHat = s1 / s0;
    const gammaHat = 1.1447 * (sHat * sHat) ** (1 / 3);
    lags = Math.min(Math.floor(gammaHat * n ** (1 / 3)), n - 1);
    lagRule = "hobijn-et-al-1998-automatic";
  } else {
    lags = Math.min(nlags, n - 1);
    lagRule = "user";
  }
  let eta = 0;
  let cumulative = 0;
  for (const value of residuals) { cumulative += value; eta += cumulative * cumulative; }
  eta /= n * n;
  let sHat = 0;
  for (const value of residuals) sHat += value * value;
  for (let i = 1; i <= lags; i += 1) {
    let product = 0;
    for (let t = i; t < n; t += 1) { budget.check(); product += residuals[t] * residuals[t - i]; }
    sHat += 2 * product * (1 - i / (lags + 1));
  }
  sHat /= n;
  if (!(sHat > 0)) H.fail("STAT_DEGENERATE", "KPSS long-run variance estimate is not positive");
  const statistic = eta / sHat;
  const pTable = [0.10, 0.05, 0.025, 0.01];
  let pValue;
  let pBoundary = "interpolated";
  if (statistic <= critical[0]) { pValue = 0.10; pBoundary = "above_table_upper_bound"; }
  else if (statistic >= critical[3]) { pValue = 0.01; pBoundary = "below_table_lower_bound"; }
  else {
    let index = 0;
    while (statistic > critical[index + 1]) index += 1;
    const fraction = (statistic - critical[index]) / (critical[index + 1] - critical[index]);
    pValue = pTable[index] + fraction * (pTable[index + 1] - pTable[index]);
  }
  return { statistic, pValue, pBoundary, lags, lagRule, longRunVariance: sHat, eta, critical: { "10%": critical[0], "5%": critical[1], "2.5%": critical[2], "1%": critical[3] }, residuals };
}

/**
 * Phillips–Perron Z_tau and Z_alpha with Bartlett/Newey–West long-run variance (Hamilton 1994 17.6.8/17.6.10).
 */
function phillipsPerron(H, values, { regression, lags }, budget) {
  const n = values.length - 1;
  const y = values.slice(1);
  const x = [];
  for (let t = 0; t < n; t += 1) {
    const row = [];
    if (regression !== "n") row.push(1);
    if (regression === "ct") row.push(t + 1);
    row.push(values[t]);
    x.push(row);
  }
  const fit = olsFit(H, y, x, budget);
  const levelIndex = regression === "n" ? 0 : regression === "c" ? 1 : 2;
  const rho = fit.beta[levelIndex];
  const seRho = fit.se[levelIndex];
  const tStatistic = (rho - 1) / seRho;
  const residuals = fit.residuals;
  const bandwidth = lags === null ? Math.floor(4 * (n / 100) ** 0.25) : lags;
  let gamma0 = 0;
  for (const value of residuals) gamma0 += value * value;
  gamma0 /= n;
  let longRun = gamma0;
  for (let i = 1; i <= bandwidth; i += 1) {
    let product = 0;
    for (let t = i; t < n; t += 1) { budget.check(); product += residuals[t] * residuals[t - i]; }
    longRun += 2 * (1 - i / (bandwidth + 1)) * product / n;
  }
  if (!(longRun > 0) || !(gamma0 > 0)) H.fail("STAT_DEGENERATE", "Phillips-Perron long-run variance estimate is not positive");
  const s2 = fit.sigma2; // OLS residual variance (n - k)
  const zTau = Math.sqrt(gamma0 / longRun) * tStatistic - 0.5 * (longRun - gamma0) / Math.sqrt(longRun) * (n * seRho / Math.sqrt(s2));
  const zAlpha = n * (rho - 1) - 0.5 * (longRun - gamma0) * (n * seRho) ** 2 / s2;
  return {
    zTau, zAlpha, rho, seRho, tStatistic, bandwidth, gamma0, longRunVariance: longRun, nobs: n,
    pValueTau: mackinnonP(H, zTau, regression), critical: mackinnonCritical(regression, n), fit,
  };
}

// ---------------------------------------------------------------------------------------------
// ARMA / ARIMA machinery
// ---------------------------------------------------------------------------------------------

/** Multiply two polynomials given as coefficient arrays [1, a1, a2, ...] (lag polynomials). */
function polyMultiply(a, b) {
  const out = Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i += 1) for (let j = 0; j < b.length; j += 1) out[i + j] += a[i] * b[j];
  return out;
}

/** Expand ARMA coefficients (arrays without the leading 1) with seasonal multiplicative factors. */
function expandSeasonal(coefficients, seasonalCoefficients, s) {
  const base = [1, ...coefficients.map((value) => -value)]; // φ(B) = 1 - φ1 B - ... for AR; for MA use +θ
  const seasonal = [1];
  for (let index = 0; index < seasonalCoefficients.length; index += 1) {
    for (let fill = 0; fill < s - 1; fill += 1) seasonal.push(0);
    seasonal.push(-seasonalCoefficients[index]);
  }
  return polyMultiply(base, seasonal);
}

function arPolynomialToCoefficients(polynomial) {
  // polynomial [1, -φ1, -φ2, ...] -> [φ1, φ2, ...]
  return polynomial.slice(1).map((value) => -value);
}

/** Partial autocorrelation parameterization (Jones 1980 / Monahan 1984) ensuring stationarity. */
function pacfToAr(pacf) {
  let previous = [];
  for (let order = 1; order <= pacf.length; order += 1) {
    const reflection = pacf[order - 1];
    const current = Array(order).fill(0);
    for (let index = 1; index < order; index += 1) current[index - 1] = previous[index - 1] - reflection * previous[order - index - 1];
    current[order - 1] = reflection;
    previous = current;
  }
  return previous;
}

function arToPacf(ar) {
  // inverse Durbin–Levinson; returns null if not stationary
  let current = [...ar];
  const pacf = Array(ar.length).fill(0);
  for (let order = ar.length; order >= 1; order -= 1) {
    const reflection = current[order - 1];
    if (!(Math.abs(reflection) < 1)) return null;
    pacf[order - 1] = reflection;
    const previous = Array(order - 1).fill(0);
    const scale = 1 - reflection * reflection;
    for (let index = 1; index < order; index += 1) previous[index - 1] = (current[index - 1] + reflection * current[order - index - 1]) / scale;
    current = previous;
  }
  return pacf;
}

function unconstrainedToPacf(values) {
  return values.map((value) => Math.tanh(value));
}

function pacfToUnconstrained(values) {
  return values.map((value) => {
    const clipped = Math.max(-0.999999, Math.min(0.999999, value));
    return 0.5 * Math.log((1 + clipped) / (1 - clipped));
  });
}

/**
 * Build the Harvey state-space form of an ARMA(p, q) with expanded AR polynomial φ and MA polynomial θ.
 * ar: [φ1..φp], ma: [θ1..θq]. State dimension r = max(p, q + 1).
 */
function armaStateSpace(ar, ma) {
  const r = Math.max(ar.length, ma.length + 1);
  const phi = Array(r).fill(0);
  for (let index = 0; index < ar.length; index += 1) phi[index] = ar[index];
  const theta = Array(r).fill(0);
  theta[0] = 1;
  for (let index = 0; index < ma.length; index += 1) theta[index + 1] = ma[index];
  const T = Array.from({ length: r }, (_, row) => Array.from({ length: r }, (__, column) => {
    if (column === 0) return phi[row];
    return column === row + 1 ? 1 : 0;
  }));
  return { r, T, R: theta };
}

/** Solve P = T P T' + R R' via the doubling algorithm (stationary AR polynomial required). */
function stationaryCovariance(H, T, R, budget) {
  const r = T.length;
  let A = T.map((row) => [...row]);
  let P = Array.from({ length: r }, (_, i) => Array.from({ length: r }, (__, j) => R[i] * R[j]));
  for (let iteration = 0; iteration < 200; iteration += 1) {
    budget.check(r * r * r);
    // P <- P + A P A'
    const AP = H.matMul(A, P);
    const APAt = H.matMul(AP, H.transpose(A));
    let delta = 0;
    for (let i = 0; i < r; i += 1) for (let j = 0; j < r; j += 1) { P[i][j] += APAt[i][j]; delta = Math.max(delta, Math.abs(APAt[i][j])); }
    A = H.matMul(A, A);
    let normA = 0;
    for (const row of A) for (const value of row) normA = Math.max(normA, Math.abs(value));
    if (!Number.isFinite(normA) || normA > 1e12) H.fail("STAT_NON_CONVERGENCE", "AR polynomial is not stationary; state covariance does not converge");
    if (delta < 1e-14 || normA < 1e-16) break;
  }
  return P;
}

/**
 * Exact Gaussian log-likelihood of a zero-mean ARMA via the Kalman filter with concentrated σ².
 * Returns { loglik (concentrated, with σ² = MLE), sigma2, innovations, scaledVariances, finalState, finalCov }.
 */
function armaKalman(H, y, ar, ma, budget, keepFinal = false) {
  const { r, T, R } = armaStateSpace(ar, ma);
  const phi = T.map((row) => row[0]);
  const n = y.length;
  let a = Array(r).fill(0);
  let P = stationaryCovariance(H, T, R, budget);
  const RRt = Array.from({ length: r }, (_, i) => Array.from({ length: r }, (__, j) => R[i] * R[j]));
  let sumSquares = 0;
  let sumLogF = 0;
  const innovations = Array(n).fill(0);
  const scaledVariances = Array(n).fill(0);
  for (let t = 0; t < n; t += 1) {
    budget.check(r * r);
    const F = P[0][0];
    if (!(F > 0) || !Number.isFinite(F)) H.fail("STAT_NON_CONVERGENCE", "Kalman innovation variance is not positive");
    const v = y[t] - a[0];
    innovations[t] = v;
    scaledVariances[t] = F;
    sumSquares += v * v / F;
    sumLogF += Math.log(F);
    // Companion structure: (T x)_i = phi_i x_0 + x_{i+1}; exploit it for O(r^2) updates.
    const TPZ = Array(r);
    const nextA = Array(r);
    for (let i = 0; i < r; i += 1) {
      TPZ[i] = phi[i] * P[0][0] + (i + 1 < r ? P[i + 1][0] : 0);
      nextA[i] = phi[i] * a[0] + (i + 1 < r ? a[i + 1] : 0) + TPZ[i] * v / F;
    }
    const TP = Array.from({ length: r }, (_, i) => {
      const row = Array(r);
      for (let j = 0; j < r; j += 1) row[j] = phi[i] * P[0][j] + (i + 1 < r ? P[i + 1][j] : 0);
      return row;
    });
    const nextP = Array.from({ length: r }, (_, i) => {
      const row = Array(r);
      for (let j = 0; j < r; j += 1) row[j] = phi[j] * TP[i][0] + (j + 1 < r ? TP[i][j + 1] : 0) - TPZ[i] * TPZ[j] / F + RRt[i][j];
      return row;
    });
    a = nextA;
    P = nextP;
  }
  const sigma2 = sumSquares / n;
  const loglik = -0.5 * (n * Math.log(2 * Math.PI) + n * Math.log(sigma2) + sumLogF + n);
  const out = { loglik, sigma2, innovations, scaledVariances, sumLogF, n };
  if (keepFinal) { out.finalState = a; out.finalCov = P; out.T = T; out.R = R; out.RRt = RRt; }
  return out;
}

/** Conditional sum of squares (CSS) for ARMA with zero-mean series; residuals before max(p, q) are set to 0. */
function armaCss(y, ar, ma, budget) {
  const n = y.length;
  const p = ar.length;
  const q = ma.length;
  const residuals = Array(n).fill(0);
  let sum = 0;
  let count = 0;
  for (let t = p; t < n; t += 1) {
    budget.check(p + q);
    let value = y[t];
    for (let i = 0; i < p; i += 1) value -= ar[i] * y[t - i - 1];
    for (let j = 0; j < q; j += 1) if (t - j - 1 >= p) value -= ma[j] * residuals[t - j - 1];
    residuals[t] = value;
    sum += value * value;
    count += 1;
  }
  return { css: sum, count, residuals };
}

// ---------------------------------------------------------------------------------------------
// Generic optimizers (deterministic)
// ---------------------------------------------------------------------------------------------

function nelderMead(H, objective, start, budget, { maxIterations = 4000, tolerance = 1e-10, initialStep = 0.1 } = {}) {
  const dimension = start.length;
  if (dimension === 0) return { x: [], value: objective([]), iterations: 0, converged: true };
  const simplex = [start.map((value) => value)];
  for (let index = 0; index < dimension; index += 1) {
    const vertex = start.map((value) => value);
    vertex[index] += initialStep * (Math.abs(vertex[index]) > 1 ? Math.abs(vertex[index]) : 1);
    simplex.push(vertex);
  }
  let values = simplex.map((vertex) => objective(vertex));
  let iterations = 0;
  let converged = false;
  const alpha = 1;
  const gamma = 2;
  const rho = 0.5;
  const sigma = 0.5;
  for (; iterations < maxIterations; iterations += 1) {
    budget.check(dimension * dimension);
    const order = values.map((value, index) => index).sort((a, b) => values[a] - values[b]);
    const sortedSimplex = order.map((index) => simplex[index]);
    const sortedValues = order.map((index) => values[index]);
    for (let index = 0; index <= dimension; index += 1) { simplex[index] = sortedSimplex[index]; values[index] = sortedValues[index]; }
    const best = values[0];
    const worst = values[dimension];
    let spread = 0;
    for (let index = 1; index <= dimension; index += 1) for (let d = 0; d < dimension; d += 1) spread = Math.max(spread, Math.abs(simplex[index][d] - simplex[0][d]));
    if (Math.abs(worst - best) <= tolerance * (1 + Math.abs(best)) && spread <= Math.sqrt(tolerance)) { converged = true; break; }
    const centroid = Array(dimension).fill(0);
    for (let index = 0; index < dimension; index += 1) for (let d = 0; d < dimension; d += 1) centroid[d] += simplex[index][d] / dimension;
    const reflected = centroid.map((value, d) => value + alpha * (value - simplex[dimension][d]));
    const reflectedValue = objective(reflected);
    if (reflectedValue < values[0]) {
      const expanded = centroid.map((value, d) => value + gamma * (reflected[d] - value));
      const expandedValue = objective(expanded);
      if (expandedValue < reflectedValue) { simplex[dimension] = expanded; values[dimension] = expandedValue; }
      else { simplex[dimension] = reflected; values[dimension] = reflectedValue; }
      continue;
    }
    if (reflectedValue < values[dimension - 1]) { simplex[dimension] = reflected; values[dimension] = reflectedValue; continue; }
    const outside = reflectedValue < values[dimension];
    const contracted = centroid.map((value, d) => value + rho * ((outside ? reflected[d] : simplex[dimension][d]) - value));
    const contractedValue = objective(contracted);
    if (contractedValue < (outside ? reflectedValue : values[dimension])) { simplex[dimension] = contracted; values[dimension] = contractedValue; continue; }
    for (let index = 1; index <= dimension; index += 1) {
      simplex[index] = simplex[0].map((value, d) => value + sigma * (simplex[index][d] - value));
      values[index] = objective(simplex[index]);
    }
  }
  const bestIndex = values.indexOf(Math.min(...values));
  return { x: simplex[bestIndex], value: values[bestIndex], iterations, converged };
}

function numericGradient(objective, x, f0, step = 1e-6) {
  return x.map((_, index) => {
    const forward = [...x];
    const backward = [...x];
    const h = step * Math.max(1, Math.abs(x[index]));
    forward[index] += h;
    backward[index] -= h;
    return (objective(forward) - objective(backward)) / (2 * h);
  });
}

function bfgs(H, objective, start, budget, { maxIterations = 500, tolerance = 1e-10, maxStepNorm = 1 } = {}) {
  const dimension = start.length;
  let x = [...start];
  let value = objective(x);
  if (dimension === 0) return { x, value, iterations: 0, converged: true };
  let gradient = numericGradient(objective, x, value);
  let inverseHessian = Array.from({ length: dimension }, (_, i) => Array.from({ length: dimension }, (__, j) => (i === j ? 1 : 0)));
  let iterations = 0;
  let converged = false;
  for (; iterations < maxIterations; iterations += 1) {
    budget.check(dimension * dimension);
    const gradientNorm = Math.sqrt(gradient.reduce((acc, item) => acc + item * item, 0));
    if (gradientNorm < 1e-7) { converged = true; break; }
    const direction = inverseHessian.map((row) => -row.reduce((acc, item, index) => acc + item * gradient[index], 0));
    let slope = direction.reduce((acc, item, index) => acc + item * gradient[index], 0);
    if (slope >= 0) {
      // reset to steepest descent
      inverseHessian = Array.from({ length: dimension }, (_, i) => Array.from({ length: dimension }, (__, j) => (i === j ? 1 : 0)));
      for (let index = 0; index < dimension; index += 1) direction[index] = -gradient[index];
      slope = -gradientNorm * gradientNorm;
    }
    const directionNorm = Math.sqrt(direction.reduce((acc, item) => acc + item * item, 0));
    let step = directionNorm > maxStepNorm ? maxStepNorm / directionNorm : 1;
    let nextX = null;
    let nextValue = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const candidate = x.map((item, index) => item + step * direction[index]);
      const candidateValue = objective(candidate);
      if (Number.isFinite(candidateValue) && candidateValue <= value + 1e-4 * step * slope) { nextX = candidate; nextValue = candidateValue; break; }
      step *= 0.5;
    }
    if (nextX === null) break;
    const nextGradient = numericGradient(objective, nextX, nextValue);
    const s = nextX.map((item, index) => item - x[index]);
    const yv = nextGradient.map((item, index) => item - gradient[index]);
    const sy = s.reduce((acc, item, index) => acc + item * yv[index], 0);
    const valueChange = Math.abs(value - nextValue);
    x = nextX;
    value = nextValue;
    gradient = nextGradient;
    if (valueChange <= tolerance * (1 + Math.abs(value)) && Math.sqrt(s.reduce((acc, item) => acc + item * item, 0)) < 1e-9) { converged = true; break; }
    if (sy > 1e-12) {
      const rhoScalar = 1 / sy;
      const Hy = inverseHessian.map((row) => row.reduce((acc, item, index) => acc + item * yv[index], 0));
      const yHy = yv.reduce((acc, item, index) => acc + item * Hy[index], 0);
      const next = inverseHessian.map((row, i) => row.map((item, j) => item - rhoScalar * (Hy[i] * s[j] + s[i] * Hy[j]) + (rhoScalar * rhoScalar * yHy + rhoScalar) * s[i] * s[j]));
      inverseHessian = next;
    }
  }
  return { x, value, iterations, converged };
}

function numericHessian(objective, x, step = 1e-4) {
  const dimension = x.length;
  const f0 = objective(x);
  const hessian = Array.from({ length: dimension }, () => Array(dimension).fill(0));
  const steps = x.map((value) => step * Math.max(1, Math.abs(value)));
  for (let i = 0; i < dimension; i += 1) {
    for (let j = i; j < dimension; j += 1) {
      if (i === j) {
        const forward = [...x]; forward[i] += steps[i];
        const backward = [...x]; backward[i] -= steps[i];
        hessian[i][i] = (objective(forward) - 2 * f0 + objective(backward)) / (steps[i] * steps[i]);
      } else {
        const pp = [...x]; pp[i] += steps[i]; pp[j] += steps[j];
        const pm = [...x]; pm[i] += steps[i]; pm[j] -= steps[j];
        const mp = [...x]; mp[i] -= steps[i]; mp[j] += steps[j];
        const mm = [...x]; mm[i] -= steps[i]; mm[j] -= steps[j];
        const value = (objective(pp) - objective(pm) - objective(mp) + objective(mm)) / (4 * steps[i] * steps[j]);
        hessian[i][j] = value;
        hessian[j][i] = value;
      }
    }
  }
  return hessian;
}

// ---------------------------------------------------------------------------------------------
// Seeded random generator (SplitMix64 on BigInt) for simulated prediction intervals.
// ---------------------------------------------------------------------------------------------

function makeRandom(seed) {
  let state = BigInt.asUintN(64, BigInt(seed) * 0x9E3779B97F4A7C15n + 0x1234567n);
  const next = () => {
    state = BigInt.asUintN(64, state + 0x9E3779B97F4A7C15n);
    let z = state;
    z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n);
    z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94D049BB133111EBn);
    z ^= z >> 31n;
    return Number(z >> 11n) / 9007199254740992; // [0, 1)
  };
  const normal = () => {
    let u1 = next();
    while (u1 <= 1e-300) u1 = next();
    const u2 = next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  return { uniform: next, normal };
}


// ---------------------------------------------------------------------------------------------
// ARIMA(p,d,q)(P,D,Q)s estimation
// ---------------------------------------------------------------------------------------------

function maToInvertibleCheck(ma) {
  // MA polynomial 1 + θ1 B + ... is invertible iff the AR polynomial with coefficients -θ is stationary.
  return arToPacf(ma.map((value) => -value)) !== null;
}

/** Map the unconstrained vector to model coefficients. layout: { hasMean, p, q, P, Q } */
function unpackParameters(vector, layout) {
  let cursor = 0;
  const mean = layout.hasMean ? vector[cursor++] : 0;
  const take = (count) => { const slice = vector.slice(cursor, cursor + count); cursor += count; return slice; };
  const ar = pacfToAr(unconstrainedToPacf(take(layout.p)));
  const ma = pacfToAr(unconstrainedToPacf(take(layout.q))).map((value) => -value);
  const sar = pacfToAr(unconstrainedToPacf(take(layout.P)));
  const sma = pacfToAr(unconstrainedToPacf(take(layout.Q))).map((value) => -value);
  return { mean, ar, ma, sar, sma };
}

function packParameters(H, coefficients, layout) {
  const vector = [];
  if (layout.hasMean) vector.push(coefficients.mean);
  const push = (values, negate) => {
    const pacf = arToPacf(negate ? values.map((value) => -value) : values);
    if (pacf === null) H.fail("STAT_NON_CONVERGENCE", "ARIMA starting values are outside the stationary/invertible region");
    for (const value of pacfToUnconstrained(pacf)) vector.push(value);
  };
  push(coefficients.ar, false);
  push(coefficients.ma, true);
  push(coefficients.sar, false);
  push(coefficients.sma, true);
  return vector;
}

function expandedPolynomials(coefficients, s) {
  const arPoly = expandSeasonal(coefficients.ar, coefficients.sar, s);
  // MA: (1 + θ(B))(1 + Θ(B^s)); expandSeasonal negates, so pass negated coefficients
  const maPoly = expandSeasonal(coefficients.ma.map((value) => -value), coefficients.sma.map((value) => -value), s);
  return { ar: arPolynomialToCoefficients(arPoly), ma: maPoly.slice(1) };
}

function trimTrailingZeros(values) {
  let end = values.length;
  while (end > 0 && values[end - 1] === 0) end -= 1;
  return values.slice(0, end);
}

/**
 * Fit an ARIMA by CSS start then exact Gaussian ML (Kalman filter, concentrated σ²).
 * `series` is the ORIGINAL series; differencing (d, D, s) is applied here.
 */
function fitArima(H, series, { p, d, q, P, D, Q, s, includeConstant }, budget, { maxIterations = 500, tolerance = 1e-10, computeHessian = true, multiStart = true } = {}) {
  const w = applyDifferencing(series, d, D, s);
  const n = w.length;
  const nonSeasonal = P === 0 && Q === 0;
  const layout = { hasMean: includeConstant, p, q, P, Q };
  const parameterCount = (includeConstant ? 1 : 0) + p + q + P + Q;
  if (n < parameterCount + 3 || n < 8) H.fail("STAT_INSUFFICIENT_SAMPLE", `ARIMA needs more differenced observations than parameters (differenced n = ${n})`);
  if (sampleVariance(w) <= 0) H.fail("STAT_DEGENERATE", "differenced series is constant");
  const polynomials = (coefficients) => expandedPolynomials(coefficients, nonSeasonal ? 1 : s);
  const centered = (mean) => w.map((value) => value - mean);
  const saturated = (vector) => vector.some((value, index) => (layout.hasMean && index === 0 ? false : Math.abs(value) > 7));
  const cssObjective = (vector) => {
    if (saturated(vector)) return Infinity;
    const coefficients = unpackParameters(vector, layout);
    const { ar, ma } = polynomials(coefficients);
    const result = armaCss(centered(coefficients.mean), trimTrailingZeros(ar), trimTrailingZeros(ma), budget);
    return result.count > 0 ? result.count * Math.log(result.css / result.count) : Infinity;
  };
  const kalmanFor = (coefficients, keepFinal = false) => {
    const { ar, ma } = polynomials(coefficients);
    return armaKalman(H, centered(coefficients.mean), trimTrailingZeros(ar), trimTrailingZeros(ma), budget, keepFinal);
  };
  const mlObjective = (vector) => {
    if (saturated(vector)) return Infinity;
    try {
      const coefficients = unpackParameters(vector, layout);
      return -kalmanFor(coefficients).loglik;
    } catch (error) {
      if (error instanceof H.StatisticsError) return Infinity;
      throw error;
    }
  };
  // Starting values: mean from the differenced series, all ARMA coefficients at zero (unconstrained 0 -> pacf 0).
  let start = Array(parameterCount).fill(0);
  if (includeConstant) start[0] = meanOf(w);
  let cssResult = { x: start, value: cssObjective(start), iterations: 0, converged: true };
  if (parameterCount > 0) {
    cssResult = bfgs(H, cssObjective, start, budget, { maxIterations, tolerance });
    if (!cssResult.converged) {
      const nm = nelderMead(H, cssObjective, cssResult.x, budget, { maxIterations: 2000, tolerance: 1e-9 });
      if (nm.value <= cssResult.value) cssResult = nm;
    }
  }
  let mlResult = { x: cssResult.x, value: mlObjective(cssResult.x), iterations: 0, converged: true };
  if (parameterCount > 0) {
    const starts = [cssResult.x, start];
    if (multiStart && parameterCount >= 4) {
      // Bounded deterministic multi-start for richer models whose likelihood can be multimodal.
      for (const pattern of [[0.4, -0.4], [-0.4, 0.4], [0.7, 0.2], [0.2, -0.7]]) {
        const extra = start.map((value, index) => (layout.hasMean && index === 0 ? value : pattern[index % 2]));
        starts.push(extra);
      }
    }
    let best = null;
    for (const candidateStart of starts) {
      const candidate = bfgs(H, mlObjective, candidateStart, budget, { maxIterations, tolerance });
      if (best === null || candidate.value < best.value) best = candidate;
    }
    mlResult = best;
    const polish = nelderMead(H, mlObjective, mlResult.x, budget, { maxIterations: 300 * parameterCount, tolerance: 1e-12, initialStep: 0.02 });
    if (polish.value < mlResult.value) mlResult = { ...polish, converged: polish.converged || mlResult.converged };
    if (!Number.isFinite(mlResult.value)) H.fail("STAT_NON_CONVERGENCE", "ARIMA maximum-likelihood optimization did not produce a finite log-likelihood");
  }
  const coefficients = unpackParameters(mlResult.x, layout);
  const kalman = kalmanFor(coefficients, true);
  const sigma2 = kalman.sigma2;
  const loglik = kalman.loglik;
  const k = parameterCount + 1; // σ² counted as a parameter (statsmodels / R convention)
  const aic = -2 * loglik + 2 * k;
  const aicc = n - k - 1 > 0 ? aic + 2 * k * (k + 1) / (n - k - 1) : Infinity;
  const bic = -2 * loglik + k * Math.log(n);
  // Standard errors from the numeric Hessian of the negative profile log-likelihood in coefficient space.
  const names = [];
  const flat = [];
  // "intercept" is the mean level when d + D = 0 and the per-period drift when d + D = 1; the
  // differenced-scale value pushed here is rescaled to that quantity below (see driftScale).
  if (includeConstant) { names.push("intercept"); flat.push(coefficients.mean); }
  for (let index = 0; index < p; index += 1) { names.push(`ar${index + 1}`); flat.push(coefficients.ar[index]); }
  for (let index = 0; index < q; index += 1) { names.push(`ma${index + 1}`); flat.push(coefficients.ma[index]); }
  for (let index = 0; index < P; index += 1) { names.push(`sar${index + 1}`); flat.push(coefficients.sar[index]); }
  for (let index = 0; index < Q; index += 1) { names.push(`sma${index + 1}`); flat.push(coefficients.sma[index]); }
  let standardErrors = flat.map(() => null);
  let hessianStatus = "not_requested";
  if (computeHessian && parameterCount > 0) {
    const fromFlat = (vector) => {
      let cursor = 0;
      const mean = includeConstant ? vector[cursor++] : 0;
      const take = (count) => { const slice = vector.slice(cursor, cursor + count); cursor += count; return slice; };
      return { mean, ar: take(p), ma: take(q), sar: take(P), sma: take(Q) };
    };
    const objective = (vector) => {
      try { return -kalmanFor(fromFlat(vector)).loglik; } catch (error) { if (error instanceof H.StatisticsError) return Infinity; throw error; }
    };
    try {
      const hessian = numericHessian(objective, flat, 1e-4);
      if (hessian.flat().every((value) => Number.isFinite(value))) {
        const covariance = H.invert(hessian);
        if (covariance.every((row, index) => row[index] > 0)) {
          standardErrors = covariance.map((row, index) => Math.sqrt(row[index]));
          hessianStatus = "observed_information_numeric";
        } else hessianStatus = "hessian_not_positive_definite";
      } else hessianStatus = "hessian_not_finite_at_boundary";
    } catch (error) {
      if (!(error instanceof H.StatisticsError)) throw error;
      hessianStatus = "hessian_singular";
    }
  }
  // Which quantity the reported "intercept" row carries. `coefficients.mean` is estimated on the
  // DIFFERENCED series w = (1-B)^d (1-B^s)^D y, so it is the constant of the differenced equation.
  // The reference convention (statsmodels ARIMA trend terms, and R/forecast "drift") states the
  // deterministic part on the ORIGINAL series instead:
  //   d + D = 0 -> trend "c": y_t = a + eta_t. Differencing is a no-op, so the differenced constant
  //                IS the mean level a. Report it unchanged.
  //   d + D = 1 -> trend "t": y_t = b*t + eta_t, i.e. b is the DRIFT (change in level per one time
  //                step). Differencing that trend gives (1-B)(b*t) = b when d = 1, but
  //                (1-B^s)(b*t) = b*s when D = 1: a seasonal difference spans s periods and so
  //                accumulates s steps of drift. The differenced constant must therefore be divided
  //                by s to be reported as a drift; reporting it raw overstates the drift by exactly
  //                the seasonal period (the non-seasonal d = 1 path is right only because s^0 = 1).
  //   d + D > 1 -> no drift counterpart is defined (statsmodels declines a trend there and the
  //                search never proposes a constant), so the differenced constant is reported as is.
  // Only the reported estimate and its standard error are rescaled; `coefficients.mean` stays on the
  // differenced scale because the Kalman filter, the likelihood, and forecastArima all live there.
  const driftScale = d + D === 1 ? Math.pow(s, D) : 1;
  if (includeConstant && driftScale !== 1) {
    flat[0] /= driftScale;
    if (standardErrors[0] !== null) standardErrors[0] /= driftScale;
  }
  const { ar: fullAr, ma: fullMa } = polynomials(coefficients);
  const stationary = arToPacf(trimTrailingZeros(fullAr)) !== null;
  const invertible = maToInvertibleCheck(trimTrailingZeros(fullMa));
  return {
    order: { p, d, q, P, D, Q, s: nonSeasonal ? null : s }, includeConstant, n, nOriginal: series.length,
    coefficients, names, flat, standardErrors, hessianStatus, sigma2, loglik, aic, aicc, bic, k,
    residuals: kalman.innovations, scaledVariances: kalman.scaledVariances,
    kalman, differenced: w, css: cssResult, ml: mlResult, stationary, invertible,
    expandedAr: trimTrailingZeros(fullAr), expandedMa: trimTrailingZeros(fullMa),
  };
}

/** h-step forecasts with covariance for the fitted ARIMA on the ORIGINAL scale. */
function forecastArima(H, fit, series, horizon, budget) {
  const { T, R, finalState, finalCov } = fit.kalman;
  const r = T.length;
  const sigma2 = fit.sigma2;
  // ψ-weights and u_i = e1' T^{i-1}
  const psi = [];
  const rows = [];
  let vector = Array(r).fill(0);
  vector[0] = 1; // e1'
  for (let step = 0; step < horizon; step += 1) {
    budget.check(r * r);
    rows.push([...vector]);
    psi.push(vector.reduce((acc, value, index) => acc + value * R[index], 0));
    // vector <- vector T
    const next = Array(r).fill(0);
    for (let j = 0; j < r; j += 1) for (let i = 0; i < r; i += 1) next[j] += vector[i] * T[i][j];
    vector = next;
  }
  const meanDiff = rows.map((row) => row.reduce((acc, value, index) => acc + value * finalState[index], 0) + fit.coefficients.mean);
  const covDiff = Array.from({ length: horizon }, () => Array(horizon).fill(0));
  for (let i = 0; i < horizon; i += 1) {
    for (let j = i; j < horizon; j += 1) {
      let value = H.quadraticFormPair ? 0 : 0;
      // u_i P u_j'
      let term = 0;
      for (let a = 0; a < r; a += 1) for (let b = 0; b < r; b += 1) term += rows[i][a] * finalCov[a][b] * rows[j][b];
      value = term;
      for (let m = 0; m <= i - 1; m += 1) value += psi[m] * psi[m + (j - i)];
      covDiff[i][j] = sigma2 * value;
      covDiff[j][i] = sigma2 * value;
    }
  }
  const { d, D } = fit.order;
  const s = fit.order.s === null ? 1 : fit.order.s;
  const mean = integrateForecasts(series, meanDiff, d, D, s, false);
  // Linear map L from future differenced values to future original values
  const L = Array.from({ length: horizon }, () => Array(horizon).fill(0));
  for (let column = 0; column < horizon; column += 1) {
    const unit = Array(horizon).fill(0);
    unit[column] = 1;
    const mapped = integrateForecasts(series, unit, d, D, s, true);
    for (let row = 0; row < horizon; row += 1) L[row][column] = mapped[row];
  }
  const LS = H.matMul(L, covDiff, budget);
  const cov = H.matMul(LS, H.transpose(L), budget);
  const variance = cov.map((row, index) => Math.max(0, row[index]));
  return { mean, variance, meanDiff, covDiff, psi };
}

function ljungBox(H, residuals, lags, modelDf, budget) {
  const n = residuals.length;
  const center = meanOf(residuals);
  const deviations = residuals.map((value) => value - center);
  let denominator = 0;
  for (const value of deviations) denominator += value * value;
  if (!(denominator > 0)) H.fail("STAT_DEGENERATE", "residual variance must be positive for Ljung-Box");
  let q = 0;
  const rows = [];
  for (let lag = 1; lag <= lags; lag += 1) {
    let numerator = 0;
    for (let index = lag; index < n; index += 1) { budget.check(); numerator += deviations[index] * deviations[index - lag]; }
    const acf = numerator / denominator;
    q += n * (n + 2) * acf * acf / (n - lag);
    const df = Math.max(1, lag - modelDf);
    rows.push({ lag, autocorrelation: acf, statistic: q, df, pValue: lag > modelDf ? H.pFromChiSquare(q, df) : null });
  }
  const df = Math.max(1, lags - modelDf);
  return { statistic: q, df, pValue: H.pFromChiSquare(q, df), rows };
}


// ---------------------------------------------------------------------------------------------
// Exponential smoothing (SES, Holt, Holt–Winters additive/multiplicative, optional damping)
// ---------------------------------------------------------------------------------------------

function sigmoid(value) {
  if (value >= 0) { const e = Math.exp(-value); return 1 / (1 + e); }
  const e = Math.exp(value);
  return e / (1 + e);
}

function logit(value) {
  const clipped = Math.max(1e-9, Math.min(1 - 1e-9, value));
  return Math.log(clipped / (1 - clipped));
}

/** Heuristic initial states following Hyndman et al. (2008) §2.6 as implemented by statsmodels. */
function etsHeuristicInitialization(H, y, { trend, seasonal, period }) {
  const n = y.length;
  if (n < 10) H.fail("STAT_INSUFFICIENT_SAMPLE", "heuristic initialization needs at least 10 observations");
  let working = [...y];
  let initialSeasonal = null;
  if (seasonal) {
    if (n < 2 * period) H.fail("STAT_INSUFFICIENT_SAMPLE", "seasonal exponential smoothing needs at least two full seasonal cycles");
    const minObs = 10 + 2 * Math.floor(period / 2);
    if (n < minObs) H.fail("STAT_INSUFFICIENT_SAMPLE", `seasonal exponential smoothing needs at least ${minObs} observations for the heuristic initialization`);
    let kCycles = Math.min(5, Math.floor(n / period));
    kCycles = Math.max(kCycles, Math.ceil(minObs / period));
    const series = y.slice(0, period * kCycles);
    const length = series.length;
    // centered moving average (pandas rolling(center=True); for even period a 2xMA)
    const half = Math.floor(period / 2);
    const trendMa = Array(length).fill(null);
    if (period % 2 === 1) {
      for (let index = half; index < length - half; index += 1) {
        let total = 0;
        for (let offset = -half; offset <= half; offset += 1) total += series[index + offset];
        trendMa[index] = total / period;
      }
    } else {
      // rolling(period, center=True) with even window: window covers [i - period/2, i + period/2 - 1]
      const first = Array(length).fill(null);
      for (let index = half; index < length - half + 1; index += 1) {
        let total = 0;
        for (let offset = -half; offset <= half - 1; offset += 1) total += series[index + offset];
        first[index] = total / period;
      }
      // shift(-1).rolling(2).mean(): value at i = (first[i] + first[i + 1]) / 2 when both defined
      for (let index = 0; index < length; index += 1) {
        if (index + 1 < length && first[index] !== null && first[index + 1] !== null) trendMa[index] = (first[index] + first[index + 1]) / 2;
      }
    }
    const detrended = series.map((value, index) => (trendMa[index] === null ? null : seasonal === "additive" ? value - trendMa[index] : value / trendMa[index]));
    initialSeasonal = Array(period).fill(0);
    for (let season = 0; season < period; season += 1) {
      let total = 0;
      let count = 0;
      for (let cycle = 0; cycle < kCycles; cycle += 1) {
        const value = detrended[cycle * period + season];
        if (value !== null && value !== undefined) { total += value; count += 1; }
      }
      if (count === 0) H.fail("STAT_DEGENERATE", "heuristic seasonal initialization has an empty season");
      initialSeasonal[season] = total / count;
    }
    const seasonalMean = meanOf(initialSeasonal);
    if (seasonal === "additive") initialSeasonal = initialSeasonal.map((value) => value - seasonalMean);
    else {
      if (!(seasonalMean !== 0)) H.fail("STAT_DEGENERATE", "multiplicative seasonal initialization has zero mean");
      initialSeasonal = initialSeasonal.map((value) => value / seasonalMean);
    }
    working = trendMa.filter((value) => value !== null);
  }
  if (working.length < 10) H.fail("STAT_INSUFFICIENT_SAMPLE", "heuristic level/trend initialization needs 10 trend observations");
  // OLS of first 10 values on (1, t)
  const x = Array.from({ length: 10 }, (_, index) => [1, index + 1]);
  const fit = olsFit(H, working.slice(0, 10), x, null);
  const level = fit.beta[0];
  const trendValue = trend ? fit.beta[1] : null;
  return { level, trend: trendValue, seasonal: initialSeasonal };
}

/** One pass of the smoothing recursions. Returns fitted (one-step ahead), residuals, final states, and SSE. */
function etsRecursion(y, model, params, initial, period) {
  const { alpha, beta, gamma, phi } = params;
  const n = y.length;
  const hasTrend = model !== "simple";
  const seasonal = model === "holt_winters_additive" ? "additive" : model === "holt_winters_multiplicative" ? "multiplicative" : null;
  let level = initial.level;
  let trend = hasTrend ? initial.trend : 0;
  const seasonals = seasonal ? [...initial.seasonal] : null; // seasonals[t] = s_{t - m} style ring buffer stored by absolute index
  const fitted = Array(n);
  const residuals = Array(n);
  let sse = 0;
  const levels = Array(n);
  const trends = Array(n);
  const seasonalStates = seasonal ? Array(n) : null;
  for (let t = 0; t < n; t += 1) {
    const damped = phi * trend;
    const seasonIndex = seasonal ? t : 0;
    const s = seasonal ? seasonals[seasonIndex] : null;
    let forecast;
    if (!seasonal) forecast = level + damped;
    else if (seasonal === "additive") forecast = level + damped + s;
    else forecast = (level + damped) * s;
    fitted[t] = forecast;
    const error = y[t] - forecast;
    residuals[t] = error;
    sse += error * error;
    const previousLevel = level;
    if (!seasonal) level = alpha * y[t] + (1 - alpha) * (previousLevel + damped);
    else if (seasonal === "additive") level = alpha * (y[t] - s) + (1 - alpha) * (previousLevel + damped);
    else level = alpha * (y[t] / s) + (1 - alpha) * (previousLevel + damped);
    if (hasTrend) trend = beta * (level - previousLevel) + (1 - beta) * damped;
    if (seasonal) {
      const newSeason = seasonal === "additive" ? gamma * (y[t] - previousLevel - damped) + (1 - gamma) * s : gamma * (y[t] / (previousLevel + damped)) + (1 - gamma) * s;
      seasonals.push(newSeason); // index t + m
      seasonalStates[t] = newSeason;
    }
    levels[t] = level;
    trends[t] = trend;
  }
  return { fitted, residuals, sse, level, trend, seasonals, levels, trends, seasonalStates };
}

function fitExponentialSmoothing(H, y, { model, period, damped }, budget) {
  const hasTrend = model !== "simple";
  const seasonal = model === "holt_winters_additive" ? "additive" : model === "holt_winters_multiplicative" ? "multiplicative" : null;
  if (seasonal === "multiplicative" && y.some((value) => !(value > 0))) H.fail("STAT_INVALID_INPUT", "multiplicative seasonality requires strictly positive observations");
  const initial = etsHeuristicInitialization(H, y, { trend: hasTrend, seasonal, period });
  if (seasonal === "multiplicative" && initial.seasonal.some((value) => !(value > 0))) H.fail("STAT_DEGENERATE", "multiplicative initial seasonal indices must be positive");
  const useDamping = hasTrend && damped;
  // Unconstrained parameterization: alpha in (0,1); beta = alpha * sigmoid; gamma = (1 - alpha) * sigmoid; phi in [0.8, 0.995].
  const unpack = (vector) => {
    let cursor = 0;
    const alpha = sigmoid(vector[cursor++]);
    const beta = hasTrend ? alpha * sigmoid(vector[cursor++]) : 0;
    const gamma = seasonal ? (1 - alpha) * sigmoid(vector[cursor++]) : 0;
    const phi = useDamping ? 0.8 + 0.195 * sigmoid(vector[cursor++]) : 1;
    return { alpha, beta, gamma, phi };
  };
  const objective = (vector) => {
    budget.check(y.length);
    const params = unpack(vector);
    const result = etsRecursion(y, model, params, initial, period);
    return Number.isFinite(result.sse) ? result.sse : Infinity;
  };
  // Grid start (statsmodels-style brute look) over alpha, beta, gamma fractions.
  const grid = [0.1, 0.3, 0.5, 0.7, 0.9];
  let bestStart = null;
  const dimension = 1 + (hasTrend ? 1 : 0) + (seasonal ? 1 : 0) + (useDamping ? 1 : 0);
  const alphaGrid = grid;
  const betaGrid = hasTrend ? grid : [null];
  const gammaGrid = seasonal ? grid : [null];
  for (const alpha of alphaGrid) {
    for (const betaFraction of betaGrid) {
      for (const gammaFraction of gammaGrid) {
        const vector = [logit(alpha)];
        if (hasTrend) vector.push(logit(betaFraction));
        if (seasonal) vector.push(logit(gammaFraction));
        if (useDamping) vector.push(logit(0.9));
        const value = objective(vector);
        if (bestStart === null || value < bestStart.value) bestStart = { vector, value };
      }
    }
  }
  let best = nelderMead(H, objective, bestStart.vector, budget, { maxIterations: 800 * dimension, tolerance: 1e-13, initialStep: 0.5 });
  const refined = nelderMead(H, objective, best.x, budget, { maxIterations: 800 * dimension, tolerance: 1e-13, initialStep: 0.1 });
  if (refined.value <= best.value) best = refined;
  const params = unpack(best.x);
  const result = etsRecursion(y, model, params, initial, period);
  const parameterCount = dimension;
  const n = y.length;
  const sigma2 = result.sse / Math.max(1, n - parameterCount);
  const loglik = -n / 2 * (Math.log(2 * Math.PI * result.sse / n) + 1);
  const k = parameterCount + 1 + (hasTrend ? 1 : 0) + (seasonal ? period : 0); // smoothing params + initial states
  return {
    model, period: seasonal ? period : null, damped: useDamping, params, initial, parameterCount, sigma2, loglik,
    aic: -2 * loglik + 2 * k, bic: -2 * loglik + k * Math.log(n), aicc: n - k - 1 > 0 ? -2 * loglik + 2 * k + 2 * k * (k + 1) / (n - k - 1) : Infinity,
    sse: result.sse, fitted: result.fitted, residuals: result.residuals, finalLevel: result.level, finalTrend: result.trend,
    finalSeasonals: seasonal ? result.seasonals.slice(result.seasonals.length - period) : null, converged: best.converged, iterations: best.iterations,
    k, seasonalType: seasonal, hasTrend,
  };
}

function etsForecast(H, fit, horizon, confidenceLevel, seed, budget) {
  const { params, finalLevel, finalTrend, finalSeasonals, model, hasTrend, seasonalType, period, sigma2, damped } = fit;
  const { alpha, beta, gamma, phi } = params;
  const mean = [];
  let phiSum = 0;
  for (let h = 1; h <= horizon; h += 1) {
    phiSum += damped ? phi ** h : 1;
    const trendPart = hasTrend ? phiSum * finalTrend : 0;
    if (!seasonalType) mean.push(finalLevel + trendPart);
    else {
      const s = finalSeasonals[(h - 1) % period];
      mean.push(seasonalType === "additive" ? finalLevel + trendPart + s : (finalLevel + trendPart) * s);
    }
  }
  const z = H.normalInv(0.5 + confidenceLevel / 2);
  let variance;
  let intervalMethod;
  if (seasonalType !== "multiplicative") {
    // Hyndman et al. (2008) class-1 analytic variances with beta* = beta (statsmodels convention) and gamma* = gamma.
    variance = [];
    intervalMethod = "analytic (Hyndman, Koehler, Ord & Snyder 2008 class-1 additive-error formulas)";
    for (let h = 1; h <= horizon; h += 1) {
      let total = 1;
      let phiJ = 0;
      for (let j = 1; j <= h - 1; j += 1) {
        phiJ += damped ? phi ** j : 1;
        let c = alpha;
        if (hasTrend) c += alpha * beta * phiJ;
        if (seasonalType === "additive" && j % period === 0) c += gamma * (1 - alpha);
        total += c * c;
      }
      variance.push(sigma2 * total);
    }
  } else {
    intervalMethod = "simulated (seeded Gaussian additive-error paths, 2000 replicates)";
    const random = makeRandom(seed);
    const replicates = 2000;
    const sigma = Math.sqrt(sigma2);
    const sums = Array(horizon).fill(0);
    const sumSquares = Array(horizon).fill(0);
    for (let replicate = 0; replicate < replicates; replicate += 1) {
      budget.check(horizon);
      let level = finalLevel;
      let trend = finalTrend;
      const seasonals = [...finalSeasonals];
      for (let h = 0; h < horizon; h += 1) {
        const dampedTrend = (damped ? phi : 1) * trend;
        const s = seasonals[h];
        const forecast = (level + dampedTrend) * s;
        const value = forecast + sigma * random.normal();
        sums[h] += value;
        sumSquares[h] += value * value;
        const previousLevel = level;
        level = alpha * (value / s) + (1 - alpha) * (previousLevel + dampedTrend);
        if (hasTrend) trend = beta * (level - previousLevel) + (1 - beta) * dampedTrend;
        seasonals.push(gamma * (value / (previousLevel + dampedTrend)) + (1 - gamma) * s);
      }
    }
    variance = sums.map((total, index) => Math.max(0, (sumSquares[index] - total * total / replicates) / (replicates - 1)));
  }
  return { mean, variance, lower: mean.map((value, index) => value - z * Math.sqrt(variance[index])), upper: mean.map((value, index) => value + z * Math.sqrt(variance[index])), intervalMethod, z };
}

// ---------------------------------------------------------------------------------------------
// Seasonal decomposition: classical moving-average and STL (Cleveland et al. 1990)
// ---------------------------------------------------------------------------------------------

function classicalDecomposition(H, y, period, model, budget) {
  const n = y.length;
  if (n < 2 * period) H.fail("STAT_INSUFFICIENT_SAMPLE", `classical decomposition needs at least two full cycles (${2 * period} observations)`);
  if (model === "multiplicative" && y.some((value) => !(value > 0))) H.fail("STAT_INVALID_INPUT", "multiplicative decomposition requires strictly positive observations");
  const filter = period % 2 === 0 ? [0.5, ...Array(period - 1).fill(1), 0.5].map((value) => value / period) : Array(period).fill(1 / period);
  const length = filter.length;
  const trimHead = Math.ceil(length / 2) - 1;
  const trend = Array(n).fill(null);
  for (let index = 0; index + length <= n; index += 1) {
    budget.check(length);
    let total = 0;
    for (let offset = 0; offset < length; offset += 1) total += y[index + offset] * filter[length - 1 - offset];
    trend[index + trimHead] = total;
  }
  const detrended = y.map((value, index) => (trend[index] === null ? null : model === "additive" ? value - trend[index] : value / trend[index]));
  const averages = Array(period).fill(0);
  for (let season = 0; season < period; season += 1) {
    let total = 0;
    let count = 0;
    for (let index = season; index < n; index += period) if (detrended[index] !== null) { total += detrended[index]; count += 1; }
    averages[season] = count > 0 ? total / count : 0;
  }
  const center = meanOf(averages);
  const seasonalFactors = model === "additive" ? averages.map((value) => value - center) : averages.map((value) => value / center);
  const seasonal = y.map((_, index) => seasonalFactors[index % period]);
  const residual = y.map((value, index) => (trend[index] === null ? null : model === "additive" ? value - trend[index] - seasonal[index] : value / (trend[index] * seasonal[index])));
  return { trend, seasonal, residual, seasonalFactors };
}

/** Local weighted regression estimate at xs over indices [nleft, nright] (1-based as in the original STL). */
function stlEst(y, n, len, ideg, xs, nleft, nright, weights, userw, rw) {
  const range = n - 1;
  let h = Math.max(xs - nleft, nright - xs);
  if (len > n) h += Math.floor((len - n) / 2);
  const h9 = 0.999 * h;
  const h1 = 0.001 * h;
  let a = 0;
  for (let j = nleft; j <= nright; j += 1) {
    const r = Math.abs(j - xs);
    let w = 0;
    if (r <= h9) {
      if (r <= h1) w = 1;
      else w = (1 - (r / h) ** 3) ** 3;
      if (userw) w *= rw[j - 1];
    }
    weights[j - 1] = w;
    a += w;
  }
  if (a <= 0) return { ok: false, value: 0 };
  for (let j = nleft; j <= nright; j += 1) weights[j - 1] /= a;
  if (h > 0 && ideg > 0) {
    let aa = 0;
    for (let j = nleft; j <= nright; j += 1) aa += weights[j - 1] * j;
    let b = xs - aa;
    let c = 0;
    for (let j = nleft; j <= nright; j += 1) c += weights[j - 1] * (j - aa) * (j - aa);
    if (Math.sqrt(c) > 0.001 * range) {
      b /= c;
      for (let j = nleft; j <= nright; j += 1) weights[j - 1] *= b * (j - aa) + 1;
    }
  }
  let value = 0;
  for (let j = nleft; j <= nright; j += 1) value += weights[j - 1] * y[j - 1];
  return { ok: true, value };
}

/** Loess smoother of the STL family (ess). Returns smoothed array of length n. */
function stlEss(y, n, len, ideg, njump, userw, rw, budget) {
  const ys = Array(n).fill(0);
  if (n < 2) { ys[0] = y[0]; return ys; }
  const weights = Array(n).fill(0);
  const newnj = Math.min(njump, n - 1);
  let nleft = 1;
  let nright = n;
  const evaluate = (i) => {
    budget.check(nright - nleft + 1);
    const result = stlEst(y, n, len, ideg, i, nleft, nright, weights, userw, rw);
    ys[i - 1] = result.ok ? result.value : y[i - 1];
  };
  if (len >= n) {
    nleft = 1; nright = n;
    for (let i = 1; i <= n; i += newnj) evaluate(i);
  } else if (newnj === 1) {
    const nsh = Math.floor((len + 1) / 2);
    nleft = 1; nright = len;
    for (let i = 1; i <= n; i += 1) {
      if (i > nsh && nright !== n) { nleft += 1; nright += 1; }
      evaluate(i);
    }
  } else {
    const nsh = Math.floor((len + 1) / 2);
    for (let i = 1; i <= n; i += newnj) {
      if (i < nsh) { nleft = 1; nright = len; }
      else if (i >= n - nsh + 1) { nleft = n - len + 1; nright = n; }
      else { nleft = i - nsh + 1; nright = len + i - nsh; }
      evaluate(i);
    }
  }
  if (newnj !== 1) {
    for (let i = 1; i <= n - newnj; i += newnj) {
      const delta = (ys[i + newnj - 1] - ys[i - 1]) / newnj;
      for (let j = i + 1; j <= i + newnj - 1; j += 1) ys[j - 1] = ys[i - 1] + delta * (j - i);
    }
    const k = Math.floor((n - 1) / newnj) * newnj + 1;
    if (k !== n) {
      const result = stlEst(y, n, len, ideg, n, nleft, nright, weights, userw, rw);
      ys[n - 1] = result.ok ? result.value : y[n - 1];
      if (k !== n - 1) {
        const delta = (ys[n - 1] - ys[k - 1]) / (n - k);
        for (let j = k + 1; j <= n - 1; j += 1) ys[j - 1] = ys[k - 1] + delta * (j - k);
      }
    }
  }
  return ys;
}

function stlMovingAverage(x, len) {
  const newn = x.length - len + 1;
  const out = Array(newn).fill(0);
  let v = 0;
  for (let i = 0; i < len; i += 1) v += x[i];
  out[0] = v / len;
  for (let j = 1; j < newn; j += 1) {
    v = v - x[j - 1] + x[j + len - 1];
    out[j] = v / len;
  }
  return out;
}

function stlLowPass(x, np) {
  const first = stlMovingAverage(x, np);
  const second = stlMovingAverage(first, np);
  return stlMovingAverage(second, 3);
}

function stlSeasonalSmoothing(y, n, np, ns, isdeg, nsjump, userw, rw, budget) {
  const season = Array(n + 2 * np).fill(0);
  for (let j = 1; j <= np; j += 1) {
    const k = Math.floor((n - j) / np) + 1;
    const series = Array(k);
    const weights = Array(k);
    for (let i = 1; i <= k; i += 1) { series[i - 1] = y[(i - 1) * np + j - 1]; if (userw) weights[i - 1] = rw[(i - 1) * np + j - 1]; }
    const smoothed = stlEss(series, k, ns, isdeg, nsjump, userw, weights, budget);
    const work = Array(k + 2);
    for (let i = 0; i < k; i += 1) work[i + 1] = smoothed[i];
    const scratch = Array(k).fill(0);
    const nright = Math.min(ns, k);
    const before = stlEst(series, k, ns, isdeg, 0, 1, nright, scratch, userw, weights);
    work[0] = before.ok ? before.value : work[1];
    const nleft = Math.max(1, k - ns + 1);
    const after = stlEst(series, k, ns, isdeg, k + 1, nleft, k, scratch, userw, weights);
    work[k + 1] = after.ok ? after.value : work[k];
    for (let m = 1; m <= k + 2; m += 1) season[(m - 1) * np + j - 1] = work[m - 1];
  }
  return season;
}

function stlRobustnessWeights(y, fit) {
  const n = y.length;
  const r = y.map((value, index) => Math.abs(value - fit[index]));
  const sortedR = [...r].sort((a, b) => a - b);
  const median = n % 2 === 1 ? sortedR[(n - 1) / 2] : (sortedR[n / 2 - 1] + sortedR[n / 2]) / 2;
  const cmad = 6 * median;
  const c9 = 0.999 * cmad;
  const c1 = 0.001 * cmad;
  return r.map((value) => {
    if (value <= c1) return 1;
    if (value <= c9) return (1 - (value / cmad) ** 2) ** 2;
    return 0;
  });
}

function stlDecomposition(H, y, { period, seasonalLength = 7, trendLength = null, lowPassLength = null, robust = false, innerIterations = null, outerIterations = null }, budget) {
  const n = y.length;
  const np = period;
  if (n < 2 * np) H.fail("STAT_INSUFFICIENT_SAMPLE", `STL needs at least two full cycles (${2 * np} observations)`);
  let ns = Math.max(3, seasonalLength);
  if (ns % 2 === 0) ns += 1;
  let nt = trendLength;
  if (nt === null) nt = Math.ceil(1.5 * np / (1 - 1.5 / ns));
  nt = Math.max(3, nt);
  if (nt % 2 === 0) nt += 1;
  let nl = lowPassLength;
  if (nl === null) nl = np + (np % 2 === 0 ? 1 : 2);
  nl = Math.max(3, nl);
  if (nl % 2 === 0) nl += 1;
  const ni = innerIterations === null ? (robust ? 2 : 5) : innerIterations;
  const no = outerIterations === null ? (robust ? 15 : 0) : outerIterations;
  const isdeg = 1;
  const itdeg = 1;
  const ildeg = 1;
  let trend = Array(n).fill(0);
  let season = Array(n).fill(0);
  let rw = Array(n).fill(1);
  let userw = false;
  for (let outer = 0; outer <= no; outer += 1) {
    for (let inner = 0; inner < ni; inner += 1) {
      budget.check(n);
      const detrended = y.map((value, index) => value - trend[index]);
      const cycle = stlSeasonalSmoothing(detrended, n, np, ns, isdeg, 1, userw, rw, budget);
      const low = stlLowPass(cycle, np);
      const lowSmoothed = stlEss(low, n, nl, ildeg, 1, false, rw, budget);
      season = cycle.slice(np, np + n).map((value, index) => value - lowSmoothed[index]);
      const deseasonalized = y.map((value, index) => value - season[index]);
      trend = stlEss(deseasonalized, n, nt, itdeg, 1, userw, rw, budget);
    }
    if (outer === no) break;
    const fit = trend.map((value, index) => value + season[index]);
    rw = stlRobustnessWeights(y, fit);
    userw = true;
  }
  if (no <= 0) rw = Array(n).fill(1);
  const residual = y.map((value, index) => value - trend[index] - season[index]);
  return { trend, seasonal: season, residual, weights: rw, seasonalLength: ns, trendLength: nt, lowPassLength: nl, innerIterations: ni, outerIterations: no };
}

// ---------------------------------------------------------------------------------------------
// Spectral analysis
// ---------------------------------------------------------------------------------------------

function fftRadix2(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = -2 * Math.PI / size;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < size / 2; k += 1) {
        const a = start + k;
        const b = a + size / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** Discrete Fourier transform of a real sequence via Bluestein's chirp-z (arbitrary n). */
function dft(values, budget) {
  const n = values.length;
  if (n === 1) return { re: [values[0]], im: [0] };
  let m = 1;
  while (m < 2 * n - 1) m <<= 1;
  const chirpRe = Array(n);
  const chirpIm = Array(n);
  for (let k = 0; k < n; k += 1) {
    const angle = -Math.PI * ((k * k) % (2 * n)) / n;
    chirpRe[k] = Math.cos(angle);
    chirpIm[k] = Math.sin(angle);
  }
  const aRe = Array(m).fill(0);
  const aIm = Array(m).fill(0);
  for (let k = 0; k < n; k += 1) { aRe[k] = values[k] * chirpRe[k]; aIm[k] = values[k] * chirpIm[k]; }
  const bRe = Array(m).fill(0);
  const bIm = Array(m).fill(0);
  bRe[0] = chirpRe[0]; bIm[0] = -chirpIm[0];
  for (let k = 1; k < n; k += 1) { bRe[k] = chirpRe[k]; bIm[k] = -chirpIm[k]; bRe[m - k] = chirpRe[k]; bIm[m - k] = -chirpIm[k]; }
  if (budget) budget.check(m * Math.log2(m));
  fftRadix2(aRe, aIm);
  fftRadix2(bRe, bIm);
  for (let k = 0; k < m; k += 1) {
    const r = aRe[k] * bRe[k] - aIm[k] * bIm[k];
    const i = aRe[k] * bIm[k] + aIm[k] * bRe[k];
    aRe[k] = r; aIm[k] = -i; // conjugate for inverse
  }
  fftRadix2(aRe, aIm);
  const re = Array(n);
  const im = Array(n);
  for (let k = 0; k < n; k += 1) {
    const r = aRe[k] / m;
    const i = -aIm[k] / m;
    re[k] = r * chirpRe[k] - i * chirpIm[k];
    im[k] = r * chirpIm[k] + i * chirpRe[k];
  }
  return { re, im };
}

/** One-sided periodogram (density scaling, fs = 1/interval), constant detrend, boxcar window. */
function periodogram(values, interval, budget) {
  const n = values.length;
  const fs = 1 / interval;
  const center = meanOf(values);
  const centered = values.map((value) => value - center);
  const { re, im } = dft(centered, budget);
  const count = Math.floor(n / 2) + 1;
  const frequencies = [];
  const power = [];
  for (let k = 0; k < count; k += 1) {
    let value = (re[k] * re[k] + im[k] * im[k]) / (fs * n);
    if (k !== 0 && !(n % 2 === 0 && k === n / 2)) value *= 2;
    frequencies.push(k * fs / n);
    power.push(value);
  }
  return { frequencies, power };
}

/** Welch averaged periodogram with periodic Hann window, 50% overlap, per-segment constant detrend. */
function welch(values, interval, segmentLength, budget) {
  const n = values.length;
  const fs = 1 / interval;
  const nperseg = Math.min(segmentLength, n);
  const noverlap = Math.floor(nperseg / 2);
  const step = nperseg - noverlap;
  const window = Array.from({ length: nperseg }, (_, index) => 0.5 - 0.5 * Math.cos(2 * Math.PI * index / nperseg));
  let windowPower = 0;
  for (const value of window) windowPower += value * value;
  const scale = 1 / (fs * windowPower);
  const segments = Math.floor((n - noverlap) / step);
  const count = Math.floor(nperseg / 2) + 1;
  const power = Array(count).fill(0);
  for (let segment = 0; segment < segments; segment += 1) {
    const start = segment * step;
    const slice = values.slice(start, start + nperseg);
    const center = meanOf(slice);
    const windowed = slice.map((value, index) => (value - center) * window[index]);
    const { re, im } = dft(windowed, budget);
    for (let k = 0; k < count; k += 1) {
      let value = (re[k] * re[k] + im[k] * im[k]) * scale;
      if (k !== 0 && !(nperseg % 2 === 0 && k === nperseg / 2)) value *= 2;
      power[k] += value / segments;
    }
  }
  const frequencies = Array.from({ length: count }, (_, k) => k * fs / nperseg);
  return { frequencies, power, segments, nperseg, noverlap };
}

/** Fisher's g test for the largest periodogram ordinate among the m interior Fourier frequencies. */
function fisherG(H, ordinates) {
  const m = ordinates.length;
  if (m < 2) H.fail("STAT_INSUFFICIENT_SAMPLE", "Fisher g test needs at least two interior Fourier frequencies");
  let total = 0;
  let maxIndex = 0;
  for (let index = 0; index < m; index += 1) { total += ordinates[index]; if (ordinates[index] > ordinates[maxIndex]) maxIndex = index; }
  if (!(total > 0)) H.fail("STAT_DEGENERATE", "periodogram has no power to test");
  const g = ordinates[maxIndex] / total;
  const upper = Math.floor(1 / g);
  let pValue = 0;
  for (let j = 1; j <= upper; j += 1) {
    const base = 1 - j * g;
    if (base <= 0) break;
    const term = Math.exp(H.logChoose(m, j) + (m - 1) * Math.log(base));
    pValue += (j % 2 === 1 ? 1 : -1) * term;
  }
  return { g, pValue: Math.min(1, Math.max(0, pValue)), maxIndex, m };
}

/** Classical Lomb–Scargle periodogram (Scargle 1982) at the given ordinary frequencies. */
function lombScargle(times, values, frequencies, budget) {
  const n = values.length;
  const center = meanOf(values);
  const centered = values.map((value) => value - center);
  return frequencies.map((frequency) => {
    budget.check(n);
    const omega = 2 * Math.PI * frequency;
    let sin2 = 0;
    let cos2 = 0;
    for (const t of times) { sin2 += Math.sin(2 * omega * t); cos2 += Math.cos(2 * omega * t); }
    const tau = Math.atan2(sin2, cos2) / (2 * omega);
    let yc = 0;
    let ys = 0;
    let cc = 0;
    let ss = 0;
    for (let index = 0; index < n; index += 1) {
      const angle = omega * (times[index] - tau);
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      yc += centered[index] * c;
      ys += centered[index] * s;
      cc += c * c;
      ss += s * s;
    }
    return 0.5 * ((cc > 0 ? yc * yc / cc : 0) + (ss > 0 ? ys * ys / ss : 0));
  });
}

// ---------------------------------------------------------------------------------------------
// Change-point detection (L2 cost)
// ---------------------------------------------------------------------------------------------

function segmentCostFactory(values) {
  const n = values.length;
  const cumulative = [0];
  const cumulativeSquares = [0];
  for (let index = 0; index < n; index += 1) {
    cumulative.push(cumulative[index] + values[index]);
    cumulativeSquares.push(cumulativeSquares[index] + values[index] * values[index]);
  }
  return (start, end) => {
    // cost of segment values[start..end-1]
    const length = end - start;
    const total = cumulative[end] - cumulative[start];
    return cumulativeSquares[end] - cumulativeSquares[start] - total * total / length;
  };
}

function pelt(H, values, penalty, minSegmentLength, budget) {
  const n = values.length;
  const cost = segmentCostFactory(values);
  const F = Array(n + 1).fill(Infinity);
  const previous = Array(n + 1).fill(-1);
  F[0] = -penalty;
  let candidates = [0];
  for (let t = minSegmentLength; t <= n; t += 1) {
    let best = Infinity;
    let bestTau = -1;
    const costs = new Map();
    for (const tau of candidates) {
      if (t - tau < minSegmentLength) continue;
      budget.check();
      const value = F[tau] + cost(tau, t) + penalty;
      costs.set(tau, value);
      if (value < best) { best = value; bestTau = tau; }
    }
    F[t] = best;
    previous[t] = bestTau;
    const kept = candidates.filter((tau) => !costs.has(tau) || costs.get(tau) - penalty <= best);
    kept.push(t);
    candidates = kept;
  }
  const changePoints = [];
  let cursor = n;
  while (cursor > 0) {
    const tau = previous[cursor];
    if (tau > 0) changePoints.push(tau);
    cursor = tau;
  }
  changePoints.reverse();
  // F[n] is the PENALIZED objective: with F[0] = -penalty it equals sum(segment costs) + penalty
  // per change point. `totalCost` must be the unpenalized within-segment squared error, so it is
  // summed over the recovered segments exactly as binarySegmentation does rather than read off F.
  let totalCost = 0;
  const bounds = [0, ...changePoints, n];
  for (let index = 0; index + 1 < bounds.length; index += 1) totalCost += cost(bounds[index], bounds[index + 1]);
  return { changePoints, totalCost, penalizedObjective: totalCost + penalty * changePoints.length };
}

function binarySegmentation(H, values, penalty, minSegmentLength, maxChanges, budget) {
  const n = values.length;
  const cost = segmentCostFactory(values);
  const changePoints = [];
  const segments = [[0, n]];
  const order = [];
  while (changePoints.length < maxChanges) {
    let best = null;
    for (const [start, end] of segments) {
      const base = cost(start, end);
      for (let split = start + minSegmentLength; split <= end - minSegmentLength; split += 1) {
        budget.check();
        const gain = base - cost(start, split) - cost(split, end);
        if (best === null || gain > best.gain) best = { gain, split, start, end };
      }
    }
    if (best === null || best.gain <= penalty) break;
    changePoints.push(best.split);
    order.push({ changePoint: best.split, gain: best.gain });
    const index = segments.findIndex(([start, end]) => start === best.start && end === best.end);
    segments.splice(index, 1, [best.start, best.split], [best.split, best.end]);
  }
  changePoints.sort((a, b) => a - b);
  let totalCost = 0;
  const bounds = [0, ...changePoints, n];
  for (let index = 0; index + 1 < bounds.length; index += 1) totalCost += cost(bounds[index], bounds[index + 1]);
  return { changePoints, totalCost, penalizedObjective: totalCost + penalty * changePoints.length, order };
}

function robustNoiseScale(values) {
  const differences = differenceOnce(values, 1).map((value) => Math.abs(value)).sort((a, b) => a - b);
  const m = differences.length;
  const median = m % 2 === 1 ? differences[(m - 1) / 2] : (differences[m / 2 - 1] + differences[m / 2]) / 2;
  return 1.4826 * median / Math.SQRT2;
}

// ---------------------------------------------------------------------------------------------
// Vector autoregression, Granger causality, cross-correlation
// ---------------------------------------------------------------------------------------------

function logDeterminantSymmetric(H, matrix) {
  return H.positiveDefiniteLogDeterminant(matrix);
}

/** VAR(p) with constant by equation-by-equation OLS on the same design (statsmodels conventions). */
function fitVar(H, series, lags, offset, budget) {
  const k = series.length;
  const total = series[0].length;
  const nobs = total - lags - offset;
  if (nobs <= k * lags + 1) H.fail("STAT_INSUFFICIENT_SAMPLE", `VAR(${lags}) needs more than ${k * lags + 1} usable observations`);
  const z = [];
  const y = [];
  for (let t = offset + lags; t < total; t += 1) {
    const row = [1];
    for (let lag = 1; lag <= lags; lag += 1) for (let variable = 0; variable < k; variable += 1) row.push(series[variable][t - lag]);
    z.push(row);
    y.push(series.map((values) => values[t]));
  }
  const zt = H.transpose(z);
  const ztz = H.matMul(zt, z, budget);
  const inverse = H.invert(ztz);
  const columns = z[0].length;
  const params = Array.from({ length: columns }, () => Array(k).fill(0));
  const residuals = Array.from({ length: nobs }, () => Array(k).fill(0));
  for (let variable = 0; variable < k; variable += 1) {
    const target = y.map((row) => row[variable]);
    const core = H.olsCore(target, z, budget);
    for (let column = 0; column < columns; column += 1) params[column][variable] = core.beta[column];
    for (let t = 0; t < nobs; t += 1) residuals[t][variable] = core.residuals[t];
  }
  const sse = Array.from({ length: k }, () => Array(k).fill(0));
  for (let t = 0; t < nobs; t += 1) for (let i = 0; i < k; i += 1) for (let j = 0; j < k; j += 1) sse[i][j] += residuals[t][i] * residuals[t][j];
  const dfResid = nobs - (k * lags + 1);
  const sigmaU = sse.map((row) => row.map((value) => value / dfResid));
  const sigmaUMle = sse.map((row) => row.map((value) => value / nobs));
  const stderr = Array.from({ length: columns }, (_, column) => Array.from({ length: k }, (__, variable) => Math.sqrt(Math.max(0, inverse[column][column] * sigmaU[variable][variable]))));
  const logDet = logDeterminantSymmetric(H, sigmaUMle);
  const freeParams = lags * k * k + k;
  const aic = logDet + 2 / nobs * freeParams;
  const bic = logDet + Math.log(nobs) / nobs * freeParams;
  const hqic = logDet + 2 * Math.log(Math.log(nobs)) / nobs * freeParams;
  const llf = -(nobs * k / 2) * Math.log(2 * Math.PI) - nobs / 2 * logDet - nobs * k / 2;
  const coefficientMatrices = Array.from({ length: lags }, (_, lag) => Array.from({ length: k }, (__, i) => Array.from({ length: k }, (___, j) => params[1 + lag * k + j][i])));
  return { k, lags, nobs, params, stderr, residuals, sigmaU, sigmaUMle, dfResid, aic, bic, hqic, llf, coefficientMatrices, intercept: params[0] };
}

function choleskyLower(H, matrix) {
  const n = matrix.length;
  const lower = Array.from({ length: n }, () => Array(n).fill(0));
  for (let row = 0; row < n; row += 1) {
    for (let column = 0; column <= row; column += 1) {
      let value = matrix[row][column];
      for (let index = 0; index < column; index += 1) value -= lower[row][index] * lower[column][index];
      if (row === column) {
        if (!(value > 0)) H.fail("STAT_SINGULAR_FIT", "residual covariance is not positive definite");
        lower[row][column] = Math.sqrt(value);
      } else lower[row][column] = value / lower[column][column];
    }
  }
  return lower;
}

/** MA(∞) coefficient matrices Ψ_0..Ψ_h and orthogonalized responses Ψ_i P (P = Cholesky of Σ_u). */
function impulseResponses(H, fit, horizon, budget) {
  const { k, lags, coefficientMatrices, sigmaU } = fit;
  const identity = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (__, j) => (i === j ? 1 : 0)));
  const psi = [identity];
  for (let step = 1; step <= horizon; step += 1) {
    budget.check(k * k * lags);
    const next = Array.from({ length: k }, () => Array(k).fill(0));
    for (let lag = 1; lag <= Math.min(lags, step); lag += 1) {
      const product = H.matMul(psi[step - lag], coefficientMatrices[lag - 1], budget);
      for (let i = 0; i < k; i += 1) for (let j = 0; j < k; j += 1) next[i][j] += product[i][j];
    }
    psi.push(next);
  }
  const P = choleskyLower(H, sigmaU);
  const orthogonal = psi.map((matrix) => H.matMul(matrix, P, budget));
  return { psi, orthogonal, P };
}

function grangerCausality(H, effect, cause, maxLag, budget) {
  const n = effect.length;
  const rows = [];
  for (let lag = 1; lag <= maxLag; lag += 1) {
    const y = [];
    const own = [];
    const joint = [];
    for (let t = lag; t < n; t += 1) {
      y.push(effect[t]);
      const ownRow = [];
      const jointRow = [];
      for (let i = 1; i <= lag; i += 1) { ownRow.push(effect[t - i]); jointRow.push(effect[t - i]); }
      for (let i = 1; i <= lag; i += 1) jointRow.push(cause[t - i]);
      ownRow.push(1);
      jointRow.push(1);
      own.push(ownRow);
      joint.push(jointRow);
    }
    const restricted = olsFit(H, y, own, budget);
    const unrestricted = olsFit(H, y, joint, budget);
    if (!(unrestricted.rss > 0)) H.fail("STAT_DEGENERATE", "Granger regression has a perfect fit; the test statistic is undefined");
    const nobs = y.length;
    const dfResid = unrestricted.dfResid;
    const f = (restricted.rss - unrestricted.rss) / unrestricted.rss / lag * dfResid;
    const chi2 = nobs * (restricted.rss - unrestricted.rss) / unrestricted.rss;
    const lr = -2 * (restricted.llf - unrestricted.llf);
    rows.push({ lag, nobs, dfDenominator: dfResid, rssRestricted: restricted.rss, rssUnrestricted: unrestricted.rss, fStatistic: f, fPValue: H.pFromF(f, lag, dfResid), chiSquare: chi2, chiSquarePValue: H.pFromChiSquare(chi2, lag), likelihoodRatio: lr, likelihoodRatioPValue: H.pFromChiSquare(lr, lag) });
  }
  return rows;
}

function crossCorrelation(H, x, y, maxLag, budget, adjusted = true) {
  const n = x.length;
  const mx = meanOf(x);
  const my = meanOf(y);
  let sx = 0;
  let sy = 0;
  for (let index = 0; index < n; index += 1) { sx += (x[index] - mx) ** 2; sy += (y[index] - my) ** 2; }
  sx = Math.sqrt(sx / n);
  sy = Math.sqrt(sy / n);
  if (!(sx > 0) || !(sy > 0)) H.fail("STAT_DEGENERATE", "both series need positive variance for cross-correlation");
  const at = (lag) => {
    // correlation between x_{t+lag} and y_t (lag >= 0); for negative lag, between y_{t-lag} and x_t
    let total = 0;
    const absLag = Math.abs(lag);
    for (let t = 0; t + absLag < n; t += 1) {
      budget.check();
      total += lag >= 0 ? (x[t + absLag] - mx) * (y[t] - my) : (y[t + absLag] - my) * (x[t] - mx);
    }
    return total / (adjusted ? n - absLag : n) / (sx * sy);
  };
  const rows = [];
  for (let lag = -maxLag; lag <= maxLag; lag += 1) rows.push({ lag, correlation: at(lag) });
  return rows;
}

module.exports = {
  normalSf, normalCdfAccurate, twoSidedNormalP,
  parseSeries, sampleVariance, meanOf, olsFit,
  differenceOnce, applyDifferencing, integrateForecasts,
  MACKINNON_1994, MACKINNON_2010, mackinnonP, mackinnonCritical, augmentedDickeyFuller, kpssTest, phillipsPerron,
  polyMultiply, expandSeasonal, arPolynomialToCoefficients, pacfToAr, arToPacf, unconstrainedToPacf, pacfToUnconstrained,
  armaStateSpace, stationaryCovariance, armaKalman, armaCss,
  nelderMead, bfgs, numericGradient, numericHessian, makeRandom,
  unpackParameters, packParameters, expandedPolynomials, trimTrailingZeros, fitArima, forecastArima, ljungBox, maToInvertibleCheck,
  sigmoid, logit, etsHeuristicInitialization, etsRecursion, fitExponentialSmoothing, etsForecast,
  classicalDecomposition, stlDecomposition, stlEss,
  dft, periodogram, welch, fisherG, lombScargle,
  segmentCostFactory, pelt, binarySegmentation, robustNoiseScale,
  fitVar, impulseResponses, choleskyLower, grangerCausality, crossCorrelation,
};
