"use strict";

/**
 * Distributions extension family: maximum-likelihood fits for fourteen continuous and discrete
 * families with Anderson-Darling / Cramer-von Mises / Kolmogorov statistics and a seeded parametric
 * bootstrap, a probability calculator, chi-square goodness of fit, kernel density estimation,
 * two-sample empirical CDF comparison, and extreme-value analysis (block-maxima GEV and
 * peaks-over-threshold GPD). Pure deterministic JavaScript; numeric kernels come from
 * ./extended-shared-numeric.cjs and the engine helper object `H`.
 */

const S = require("./extended-shared-numeric.cjs");

const FAMILY = "distributions-extended";
const ORACLE_FILE = "contracts/distributions-extended-scipy-crosscheck.py";
const LOG_2PI = Math.log(2 * Math.PI);
const BIG = 1e300;

// ---------------------------------------------------------------------------------------------
// Fixtures (deterministic literal generation from the seeded generator).
// ---------------------------------------------------------------------------------------------

function fixtureValues() {
  const rng = S.createRng(20260903);
  const gammaDraws = Array.from({ length: 60 }, () => S.round(rng.gamma(2.5) * 1.7, 3));
  const maxima = Array.from({ length: 30 }, () => {
    let best = -Infinity;
    for (let i = 0; i < 40; i += 1) best = Math.max(best, 10 + 2.5 * rng.normal());
    return S.round(best, 3);
  });
  const series = Array.from({ length: 400 }, () => S.round(Math.exp(0.6 * rng.normal()) * 4, 3));
  const sampleA = Array.from({ length: 25 }, () => S.round(50 + 6 * rng.normal(), 2));
  const sampleB = Array.from({ length: 30 }, () => S.round(53 + 8 * rng.normal(), 2));
  return { gammaDraws, maxima, series, sampleA, sampleB };
}

const FIXTURE = fixtureValues();

// ---------------------------------------------------------------------------------------------
// Numeric helpers.
// ---------------------------------------------------------------------------------------------

function mean(values) { let total = 0; for (const value of values) total += value; return total / values.length; }
function populationVariance(values) { const m = mean(values); let total = 0; for (const value of values) total += (value - m) * (value - m); return total / values.length; }
function sampleSd(values) { return Math.sqrt(populationVariance(values) * values.length / Math.max(1, values.length - 1)); }
function median(sortedValues) { const n = sortedValues.length; return n % 2 ? sortedValues[(n - 1) / 2] : 0.5 * (sortedValues[n / 2 - 1] + sortedValues[n / 2]); }
function clampProbability(p) { return Math.min(1 - 1e-15, Math.max(1e-15, p)); }
function isInteger(value) { return Number.isInteger(value); }

function newtonSafe(f, fprime, start, { lower = -Infinity, upper = Infinity, iterations = 200, tolerance = 1e-13 } = {}) {
  let x = start;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const value = f(x);
    const slope = fprime(x);
    if (!Number.isFinite(value) || !Number.isFinite(slope) || slope === 0) break;
    let next = x - value / slope;
    let halvings = 0;
    while ((next <= lower || next >= upper) && halvings < 60) { next = 0.5 * (x + next); halvings += 1; }
    if (Math.abs(next - x) <= tolerance * Math.max(1, Math.abs(x))) return next;
    x = next;
  }
  return x;
}

function numericHessian(logLik, theta, scale) {
  const p = theta.length;
  const hessian = S.zeros(p, p);
  const h = theta.map((value, index) => scale[index] * 1e-3);
  const at = (delta) => logLik(theta.map((value, index) => value + delta[index]));
  const f0 = at(new Array(p).fill(0));
  for (let i = 0; i < p; i += 1) {
    const ei = new Array(p).fill(0);
    ei[i] = h[i];
    const fp = at(ei);
    const fm = at(ei.map((value) => -value));
    hessian[i][i] = (fp - 2 * f0 + fm) / (h[i] * h[i]);
    for (let j = i + 1; j < p; j += 1) {
      const ej = new Array(p).fill(0);
      ej[j] = h[j];
      const pp = at(ei.map((value, index) => value + ej[index]));
      const pm = at(ei.map((value, index) => value - ej[index]));
      const mp = at(ei.map((value, index) => -value + ej[index]));
      const mm = at(ei.map((value, index) => -value - ej[index]));
      hessian[i][j] = (pp - pm - mp + mm) / (4 * h[i] * h[j]);
      hessian[j][i] = hessian[i][j];
    }
  }
  return hessian;
}

function numericGradient(fn, theta, scale) {
  return theta.map((value, index) => {
    const h = scale[index] * 1e-4;
    const plus = theta.slice();
    const minus = theta.slice();
    plus[index] = value + h;
    minus[index] = value - h;
    return (fn(plus) - fn(minus)) / (2 * h);
  });
}

function observedInformationCovariance(logLik, theta, scale) {
  const hessian = numericHessian(logLik, theta, scale);
  const negative = hessian.map((row) => row.map((value) => -value));
  const covariance = S.inverse(negative);
  if (!covariance || covariance.some((row, index) => !(row[index] > 0) || !Number.isFinite(row[index]))) return null;
  return covariance;
}

function discreteQuantile(p, logPmf, start, budget) {
  if (p <= 0) return start;
  let k = start;
  let cumulative = 0;
  for (let iteration = 0; iteration < 5_000_000; iteration += 1) {
    if (budget && iteration % 1000 === 0) budget.check(1000);
    cumulative += Math.exp(logPmf(k));
    if (cumulative >= p * (1 - 1e-12) || cumulative >= 1 - 1e-15) return k;
    k += 1;
  }
  return k;
}

// ---------------------------------------------------------------------------------------------
// Distribution family registry.
// ---------------------------------------------------------------------------------------------

function numericParameter(name, { positive = false, integer = false, minimum = null, maximum = null, exclusiveMinimum = null, exclusiveMaximum = null } = {}) {
  return { name, positive, integer, minimum, maximum, exclusiveMinimum, exclusiveMaximum };
}

const FAMILIES = {
  normal: {
    kind: "continuous", label: "normal", scipy: "norm", estimatedParameters: 2,
    parameters: [numericParameter("mean"), numericParameter("sd", { positive: true })],
    support: () => true,
    logPdf: (x, t) => -0.5 * LOG_2PI - Math.log(t.sd) - ((x - t.mean) ** 2) / (2 * t.sd * t.sd),
    cdf: (x, t) => S.normalCdf((x - t.mean) / t.sd),
    quantile: (p, t) => t.mean + t.sd * S.normalQuantile(p),
    fit: (x) => ({ mean: mean(x), sd: Math.sqrt(populationVariance(x)) }),
    sample: (rng, t) => t.mean + t.sd * rng.normal(),
    plotRange: (t) => [t.mean - 4 * t.sd, t.mean + 4 * t.sd],
  },
  student_t: {
    kind: "continuous", label: "Student t (location-scale)", scipy: "t", estimatedParameters: 3,
    parameters: [numericParameter("df", { positive: true }), numericParameter("location"), numericParameter("scale", { positive: true })],
    support: () => true,
    logPdf: (x, t) => { const z = (x - t.location) / t.scale; return S.logGamma((t.df + 1) / 2) - S.logGamma(t.df / 2) - 0.5 * Math.log(t.df * Math.PI) - Math.log(t.scale) - ((t.df + 1) / 2) * Math.log1p(z * z / t.df); },
    cdf: (x, t) => S.tCdf((x - t.location) / t.scale, t.df),
    quantile: (p, t) => t.location + t.scale * S.tQuantile(p, t.df),
    fit(x, ctx) {
      const sorted = [...x].sort((a, b) => a - b);
      const med = median(sorted);
      const mad = median([...x.map((value) => Math.abs(value - med))].sort((a, b) => a - b)) * 1.4826;
      const scale0 = mad > 0 ? mad : Math.max(sampleSd(x), 1e-6);
      const objective = (theta) => {
        const location = theta[0];
        const scale = Math.exp(theta[1]);
        const df = Math.exp(theta[2]);
        if (!(scale > 0) || !(df > 0.05) || df > 1e6) return BIG;
        let total = 0;
        for (const value of x) total += FAMILIES.student_t.logPdf(value, { df, location, scale });
        return -total;
      };
      let best = null;
      for (const startDf of [3, 10]) {
        const result = S.nelderMead(objective, [med, Math.log(scale0), Math.log(startDf)], { step: [scale0 * 0.2, 0.2, 0.3], maxIterations: 4000, tolerance: 1e-13, budget: ctx.budget });
        if (!best || result.value < best.value) best = result;
      }
      return { df: Math.exp(best.x[2]), location: best.x[0], scale: Math.exp(best.x[1]), converged: best.converged };
    },
    sample: (rng, t) => t.location + t.scale * rng.normal() / Math.sqrt(2 * rng.gamma(t.df / 2) / t.df),
    plotRange: (t) => [t.location - 5 * t.scale, t.location + 5 * t.scale],
  },
  logistic: {
    kind: "continuous", label: "logistic", scipy: "logistic", estimatedParameters: 2,
    parameters: [numericParameter("location"), numericParameter("scale", { positive: true })],
    support: () => true,
    logPdf: (x, t) => { const z = (x - t.location) / t.scale; return -z - Math.log(t.scale) - 2 * Math.log1p(Math.exp(-z)); },
    cdf: (x, t) => 1 / (1 + Math.exp(-(x - t.location) / t.scale)),
    quantile: (p, t) => t.location + t.scale * Math.log(p / (1 - p)),
    fit(x, ctx) {
      const scale0 = Math.max(sampleSd(x) * Math.sqrt(3) / Math.PI, 1e-9);
      const objective = (theta) => { const scale = Math.exp(theta[1]); if (!(scale > 0)) return BIG; let total = 0; for (const value of x) total += FAMILIES.logistic.logPdf(value, { location: theta[0], scale }); return -total; };
      const result = S.nelderMead(objective, [mean(x), Math.log(scale0)], { step: [scale0 * 0.2, 0.2], maxIterations: 3000, tolerance: 1e-13, budget: ctx.budget });
      return { location: result.x[0], scale: Math.exp(result.x[1]), converged: result.converged };
    },
    sample: (rng, t) => FAMILIES.logistic.quantile(rng.uniformOpen(), t),
    plotRange: (t) => [t.location - 8 * t.scale, t.location + 8 * t.scale],
  },
  gumbel: {
    kind: "continuous", label: "Gumbel (maximum)", scipy: "gumbel_r", estimatedParameters: 2,
    parameters: [numericParameter("location"), numericParameter("scale", { positive: true })],
    support: () => true,
    logPdf: (x, t) => { const z = (x - t.location) / t.scale; return -Math.log(t.scale) - z - Math.exp(-z); },
    cdf: (x, t) => Math.exp(-Math.exp(-(x - t.location) / t.scale)),
    quantile: (p, t) => t.location - t.scale * Math.log(-Math.log(p)),
    fit(x, ctx) {
      const min = Math.min(...x);
      const avg = mean(x);
      const sd = Math.max(sampleSd(x), 1e-12);
      const g = (beta) => {
        let sw = 0;
        let swx = 0;
        for (const value of x) { const w = Math.exp(-(value - min) / beta); sw += w; swx += w * value; }
        return beta - avg + swx / sw;
      };
      let beta = S.bisectionRoot(g, sd * 1e-3, sd * 1e3, { tolerance: 1e-14 });
      if (beta === null) ctx.H.fail("STAT_NON_CONVERGENCE", "Gumbel scale equation has no root in the search bracket");
      beta = newtonSafe(g, (b) => (g(b + 1e-6 * b) - g(b - 1e-6 * b)) / (2e-6 * b), beta, { lower: sd * 1e-4, upper: sd * 1e4, iterations: 50 });
      let sw = 0;
      for (const value of x) sw += Math.exp(-(value - min) / beta);
      const location = min - beta * Math.log(sw / x.length);
      return { location, scale: beta };
    },
    sample: (rng, t) => FAMILIES.gumbel.quantile(rng.uniformOpen(), t),
    plotRange: (t) => [t.location - 3 * t.scale, t.location + 8 * t.scale],
  },
  gev: {
    kind: "continuous", label: "generalized extreme value", scipy: "genextreme", estimatedParameters: 3,
    parameters: [numericParameter("shape"), numericParameter("location"), numericParameter("scale", { positive: true })],
    support: (x, t) => Math.abs(t.shape) < 1e-10 || 1 + t.shape * (x - t.location) / t.scale > 0,
    logPdf(x, t) {
      const z = (x - t.location) / t.scale;
      if (Math.abs(t.shape) < 1e-10) return -Math.log(t.scale) - z - Math.exp(-z);
      const u = 1 + t.shape * z;
      if (u <= 0) return -Infinity;
      return -Math.log(t.scale) - (1 + 1 / t.shape) * Math.log(u) - Math.pow(u, -1 / t.shape);
    },
    cdf(x, t) {
      const z = (x - t.location) / t.scale;
      if (Math.abs(t.shape) < 1e-10) return Math.exp(-Math.exp(-z));
      const u = 1 + t.shape * z;
      if (u <= 0) return t.shape > 0 ? 0 : 1;
      return Math.exp(-Math.pow(u, -1 / t.shape));
    },
    quantile(p, t) {
      if (Math.abs(t.shape) < 1e-10) return t.location - t.scale * Math.log(-Math.log(p));
      return t.location + (t.scale / t.shape) * (Math.pow(-Math.log(p), -t.shape) - 1);
    },
    fit(x, ctx) {
      const gumbel = FAMILIES.gumbel.fit(x, ctx);
      const n = x.length;
      const objective = (theta) => {
        const t = { location: theta[0], scale: Math.exp(theta[1]), shape: theta[2] };
        if (!(t.scale > 0) || Math.abs(t.shape) > 5) return BIG;
        let total = 0;
        for (const value of x) { const lp = FAMILIES.gev.logPdf(value, t); if (!Number.isFinite(lp)) return BIG; total += lp; }
        return -total;
      };
      let best = null;
      for (const startShape of [0.1, -0.1, 0.3, -0.3]) {
        const result = S.nelderMead(objective, [gumbel.location, Math.log(gumbel.scale), startShape], { step: [gumbel.scale * 0.2, 0.2, 0.1], maxIterations: 5000, tolerance: 1e-13, budget: ctx.budget });
        if (result.value >= BIG) continue;
        if (!best || result.value < best.value) best = result;
      }
      if (!best) ctx.H.fail("STAT_NON_CONVERGENCE", "GEV likelihood could not be maximised from the Gumbel start (n = " + n + ")");
      return { shape: best.x[2], location: best.x[0], scale: Math.exp(best.x[1]), converged: best.converged };
    },
    sample: (rng, t) => FAMILIES.gev.quantile(rng.uniformOpen(), t),
    plotRange: (t) => [FAMILIES.gev.quantile(0.001, t), FAMILIES.gev.quantile(0.999, t)],
  },
  gamma: {
    kind: "continuous", label: "gamma", scipy: "gamma", estimatedParameters: 2,
    parameters: [numericParameter("shape", { positive: true }), numericParameter("scale", { positive: true })],
    support: (x) => x > 0,
    logPdf: (x, t) => (x <= 0 ? -Infinity : (t.shape - 1) * Math.log(x) - x / t.scale - t.shape * Math.log(t.scale) - S.logGamma(t.shape)),
    cdf: (x, t) => (x <= 0 ? 0 : S.gammaP(t.shape, x / t.scale)),
    quantile: (p, t) => S.gammaQuantile(p, t.shape, t.scale),
    fit(x, ctx) {
      if (x.some((value) => value <= 0)) ctx.H.fail("STAT_INVALID_INPUT", "gamma requires strictly positive values");
      const avg = mean(x);
      const s = Math.log(avg) - mean(x.map(Math.log));
      if (!(s > 0)) ctx.H.fail("STAT_DEGENERATE", "gamma shape is unbounded because the values are (nearly) identical");
      const start = (3 - s + Math.sqrt((s - 3) ** 2 + 24 * s)) / (12 * s);
      const shape = newtonSafe((a) => Math.log(a) - S.digamma(a) - s, (a) => 1 / a - S.trigamma(a), start, { lower: 1e-8, upper: 1e8 });
      return { shape, scale: avg / shape };
    },
    sample: (rng, t) => rng.gamma(t.shape) * t.scale,
    plotRange: (t) => [0, S.gammaQuantile(0.999, t.shape, t.scale)],
  },
  weibull: {
    kind: "continuous", label: "Weibull", scipy: "weibull_min", estimatedParameters: 2,
    parameters: [numericParameter("shape", { positive: true }), numericParameter("scale", { positive: true })],
    support: (x) => x >= 0,
    logPdf: (x, t) => (x < 0 ? -Infinity : Math.log(t.shape) - Math.log(t.scale) + (t.shape - 1) * Math.log(x / t.scale) - Math.pow(x / t.scale, t.shape)),
    cdf: (x, t) => (x <= 0 ? 0 : 1 - Math.exp(-Math.pow(x / t.scale, t.shape))),
    quantile: (p, t) => t.scale * Math.pow(-Math.log(1 - p), 1 / t.shape),
    fit(x, ctx) {
      if (x.some((value) => value <= 0)) ctx.H.fail("STAT_INVALID_INPUT", "Weibull fitting requires strictly positive values");
      const max = Math.max(...x);
      const z = x.map((value) => value / max);
      const logs = x.map(Math.log);
      const meanLog = mean(logs);
      const g = (c) => { let szc = 0; let szcl = 0; for (let i = 0; i < x.length; i += 1) { const zc = Math.pow(z[i], c); szc += zc; szcl += zc * logs[i]; } return szcl / szc - 1 / c - meanLog; };
      const shape = S.bisectionRoot(g, 1e-3, 1e3, { tolerance: 1e-14 });
      if (shape === null) ctx.H.fail("STAT_DEGENERATE", "Weibull shape equation has no root; the values may be identical");
      let szc = 0;
      for (const value of z) szc += Math.pow(value, shape);
      return { shape, scale: max * Math.pow(szc / x.length, 1 / shape) };
    },
    sample: (rng, t) => FAMILIES.weibull.quantile(rng.uniformOpen(), t),
    plotRange: (t) => [0, FAMILIES.weibull.quantile(0.999, t)],
  },
  beta: {
    kind: "continuous", label: "beta", scipy: "beta", estimatedParameters: 2,
    parameters: [numericParameter("alpha", { positive: true }), numericParameter("beta", { positive: true })],
    support: (x) => x > 0 && x < 1,
    logPdf: (x, t) => (x <= 0 || x >= 1 ? -Infinity : (t.alpha - 1) * Math.log(x) + (t.beta - 1) * Math.log1p(-x) - S.logBeta(t.alpha, t.beta)),
    cdf: (x, t) => (x <= 0 ? 0 : x >= 1 ? 1 : S.regularizedBeta(x, t.alpha, t.beta)),
    quantile: (p, t) => S.betaQuantile(p, t.alpha, t.beta),
    fit(x, ctx) {
      if (x.some((value) => value <= 0 || value >= 1)) ctx.H.fail("STAT_INVALID_INPUT", "beta requires values strictly inside (0, 1)");
      const m = mean(x);
      const v = populationVariance(x);
      if (!(v > 0)) ctx.H.fail("STAT_DEGENERATE", "beta parameters are unbounded because the values are identical");
      const common = m * (1 - m) / v - 1;
      let alpha = common > 0 ? m * common : 1;
      let beta = common > 0 ? (1 - m) * common : 1;
      const meanLog = mean(x.map(Math.log));
      const meanLog1 = mean(x.map((value) => Math.log1p(-value)));
      for (let iteration = 0; iteration < 500; iteration += 1) {
        const dab = S.digamma(alpha + beta);
        const g1 = S.digamma(alpha) - dab - meanLog;
        const g2 = S.digamma(beta) - dab - meanLog1;
        const tab = S.trigamma(alpha + beta);
        const h11 = S.trigamma(alpha) - tab;
        const h22 = S.trigamma(beta) - tab;
        const h12 = -tab;
        const det = h11 * h22 - h12 * h12;
        if (!(det > 0)) break;
        let da = -(h22 * g1 - h12 * g2) / det;
        let db = -(h11 * g2 - h12 * g1) / det;
        let halvings = 0;
        while ((alpha + da <= 0 || beta + db <= 0) && halvings < 60) { da *= 0.5; db *= 0.5; halvings += 1; }
        alpha += da;
        beta += db;
        if (Math.abs(da) <= 1e-13 * alpha && Math.abs(db) <= 1e-13 * beta) break;
      }
      return { alpha, beta };
    },
    sample: (rng, t) => { const a = rng.gamma(t.alpha); const b = rng.gamma(t.beta); return a / (a + b); },
    plotRange: () => [0, 1],
  },
  lognormal: {
    kind: "continuous", label: "lognormal (with location)", scipy: "lognorm", estimatedParameters: 2,
    parameters: [numericParameter("location"), numericParameter("meanLog"), numericParameter("sdLog", { positive: true })],
    support: (x, t) => x > t.location,
    logPdf: (x, t) => { if (x <= t.location) return -Infinity; const y = Math.log(x - t.location); return -Math.log(x - t.location) - Math.log(t.sdLog) - 0.5 * LOG_2PI - ((y - t.meanLog) ** 2) / (2 * t.sdLog * t.sdLog); },
    cdf: (x, t) => (x <= t.location ? 0 : S.normalCdf((Math.log(x - t.location) - t.meanLog) / t.sdLog)),
    quantile: (p, t) => t.location + Math.exp(t.meanLog + t.sdLog * S.normalQuantile(p)),
    fit(x, ctx) {
      const sorted = [...x].sort((a, b) => a - b);
      const min = sorted[0];
      const range = sorted[sorted.length - 1] - min;
      if (!(range > 0)) ctx.H.fail("STAT_DEGENERATE", "lognormal parameters are unbounded because the values are identical");
      const profile = (location) => {
        const y = x.map((value) => Math.log(value - location));
        const mu = mean(y);
        const sigma2 = populationVariance(y);
        if (!(sigma2 > 0)) return -BIG;
        let sumLog = 0;
        for (const value of y) sumLog += value;
        return -0.5 * x.length * Math.log(sigma2) - 0.5 * x.length * (1 + LOG_2PI) - sumLog;
      };
      let location;
      let boundary = false;
      if (ctx.options.location === "estimate") {
        const grid = 41;
        const logLo = Math.log(1e-6 * range);
        const logHi = Math.log(3 * range);
        const deltas = Array.from({ length: grid }, (_, index) => Math.exp(logLo + (logHi - logLo) * index / (grid - 1)));
        let bestIndex = 0;
        let bestValue = -Infinity;
        deltas.forEach((delta, index) => { const value = profile(min - delta); if (value > bestValue) { bestValue = value; bestIndex = index; } });
        boundary = bestIndex === 0 || bestIndex === grid - 1;
        const lo = Math.log(deltas[Math.max(0, bestIndex - 1)]);
        const hi = Math.log(deltas[Math.min(grid - 1, bestIndex + 1)]);
        const refined = S.brentMinimize((logDelta) => -profile(min - Math.exp(logDelta)), lo, hi, { tolerance: 1e-12, budget: ctx.budget });
        location = min - Math.exp(refined.x);
      } else {
        location = ctx.options.location;
        if (x.some((value) => value <= location)) ctx.H.fail("STAT_INVALID_INPUT", `lognormal with location ${location} requires every value to exceed the location`);
      }
      const y = x.map((value) => Math.log(value - location));
      return { location, meanLog: mean(y), sdLog: Math.sqrt(populationVariance(y)), locationAtBoundary: boundary };
    },
    sample: (rng, t) => t.location + Math.exp(t.meanLog + t.sdLog * rng.normal()),
    plotRange: (t) => [t.location, FAMILIES.lognormal.quantile(0.995, t)],
  },
  exponential: {
    kind: "continuous", label: "exponential (with location)", scipy: "expon", estimatedParameters: 1,
    parameters: [numericParameter("location"), numericParameter("scale", { positive: true })],
    support: (x, t) => x >= t.location,
    logPdf: (x, t) => (x < t.location ? -Infinity : -Math.log(t.scale) - (x - t.location) / t.scale),
    cdf: (x, t) => (x <= t.location ? 0 : 1 - Math.exp(-(x - t.location) / t.scale)),
    quantile: (p, t) => t.location - t.scale * Math.log(1 - p),
    fit(x, ctx) {
      const location = ctx.options.location === "estimate" ? Math.min(...x) : ctx.options.location;
      if (x.some((value) => value < location)) ctx.H.fail("STAT_INVALID_INPUT", `exponential with location ${location} requires every value to be at least the location`);
      const scale = mean(x) - location;
      if (!(scale > 0)) ctx.H.fail("STAT_DEGENERATE", "exponential scale is zero");
      return { location, scale };
    },
    sample: (rng, t) => FAMILIES.exponential.quantile(rng.uniformOpen(), t),
    plotRange: (t) => [t.location, t.location + 7 * t.scale],
  },
  uniform: {
    kind: "continuous", label: "uniform", scipy: "uniform", estimatedParameters: 2,
    parameters: [numericParameter("lower"), numericParameter("upper")],
    support: (x, t) => x >= t.lower && x <= t.upper,
    logPdf: (x, t) => (x < t.lower || x > t.upper ? -Infinity : -Math.log(t.upper - t.lower)),
    cdf: (x, t) => (x <= t.lower ? 0 : x >= t.upper ? 1 : (x - t.lower) / (t.upper - t.lower)),
    quantile: (p, t) => t.lower + p * (t.upper - t.lower),
    fit(x, ctx) {
      const lower = Math.min(...x);
      const upper = Math.max(...x);
      if (!(upper > lower)) ctx.H.fail("STAT_DEGENERATE", "uniform range is zero");
      return { lower, upper };
    },
    sample: (rng, t) => t.lower + rng.uniform() * (t.upper - t.lower),
    plotRange: (t) => [t.lower - 0.05 * (t.upper - t.lower), t.upper + 0.05 * (t.upper - t.lower)],
  },
  chi_square: {
    kind: "continuous", label: "chi-square", scipy: "chi2", estimatedParameters: 1, calculatorOnly: true,
    parameters: [numericParameter("df", { positive: true })],
    support: (x) => x >= 0,
    logPdf: (x, t) => (x < 0 ? -Infinity : x === 0 ? (t.df === 2 ? -Math.log(2) : t.df < 2 ? Infinity : -Infinity) : (t.df / 2 - 1) * Math.log(x) - x / 2 - (t.df / 2) * Math.log(2) - S.logGamma(t.df / 2)),
    cdf: (x, t) => (x <= 0 ? 0 : S.chiSquareCdf(x, t.df)),
    quantile: (p, t) => S.chiSquareQuantile(p, t.df),
    plotRange: (t) => [0, S.chiSquareQuantile(0.999, t.df)],
  },
  f: {
    kind: "continuous", label: "F", scipy: "f", estimatedParameters: 2, calculatorOnly: true,
    parameters: [numericParameter("df1", { positive: true }), numericParameter("df2", { positive: true })],
    support: (x) => x >= 0,
    logPdf: (x, t) => (x < 0 ? -Infinity : x === 0 ? (t.df1 === 2 ? 0 : t.df1 < 2 ? Infinity : -Infinity) : 0.5 * t.df1 * Math.log(t.df1 / t.df2) + (0.5 * t.df1 - 1) * Math.log(x) - 0.5 * (t.df1 + t.df2) * Math.log1p(t.df1 * x / t.df2) - S.logBeta(0.5 * t.df1, 0.5 * t.df2)),
    cdf: (x, t) => (x <= 0 ? 0 : S.fCdf(x, t.df1, t.df2)),
    quantile: (p, t) => S.fQuantile(p, t.df1, t.df2),
    plotRange: (t) => [0, S.fQuantile(0.995, t.df1, t.df2)],
  },
  poisson: {
    kind: "discrete", label: "Poisson", scipy: "poisson", estimatedParameters: 1, supportStart: 0,
    parameters: [numericParameter("rate", { positive: true })],
    support: (k) => isInteger(k) && k >= 0,
    logPmf: (k, t) => (!isInteger(k) || k < 0 ? -Infinity : k * Math.log(t.rate) - t.rate - S.logGamma(k + 1)),
    cdf: (k, t) => (k < 0 ? 0 : S.gammaQ(Math.floor(k) + 1, t.rate)),
    fit(x, ctx) {
      if (x.some((value) => !isInteger(value) || value < 0)) ctx.H.fail("STAT_INVALID_INPUT", "Poisson requires non-negative integer counts");
      const rate = mean(x);
      if (!(rate > 0)) ctx.H.fail("STAT_DEGENERATE", "Poisson rate is zero");
      return { rate };
    },
    sample: (rng, t) => rng.poisson(t.rate),
  },
  negative_binomial: {
    kind: "discrete", label: "negative binomial", scipy: "nbinom", estimatedParameters: 2, supportStart: 0,
    parameters: [numericParameter("size", { positive: true }), numericParameter("probability", { exclusiveMinimum: 0, maximum: 1 })],
    support: (k) => isInteger(k) && k >= 0,
    logPmf: (k, t) => (!isInteger(k) || k < 0 ? -Infinity : S.logGamma(k + t.size) - S.logGamma(t.size) - S.logGamma(k + 1) + t.size * Math.log(t.probability) + k * Math.log1p(-t.probability)),
    cdf: (k, t) => (k < 0 ? 0 : S.regularizedBeta(t.probability, t.size, Math.floor(k) + 1)),
    fit(x, ctx) {
      if (x.some((value) => !isInteger(value) || value < 0)) ctx.H.fail("STAT_INVALID_INPUT", "negative binomial requires non-negative integer counts");
      const m = mean(x);
      const v = populationVariance(x) * x.length / Math.max(1, x.length - 1);
      if (!(m > 0)) ctx.H.fail("STAT_DEGENERATE", "all counts are zero");
      if (v <= m) ctx.H.fail("STAT_DEGENERATE", "sample variance does not exceed the mean; the negative binomial size diverges (no overdispersion)");
      const profile = (logSize) => { const size = Math.exp(logSize); const probability = size / (size + m); let total = 0; for (const value of x) total += FAMILIES.negative_binomial.logPmf(value, { size, probability }); return -total; };
      const start = Math.log(Math.max(1e-6, m * m / (v - m)));
      const result = S.brentMinimize(profile, Math.min(start, Math.log(1e-4)) - 5, Math.max(start, Math.log(1e5)) + 5, { tolerance: 1e-13, budget: ctx.budget });
      const size = Math.exp(result.x);
      return { size, probability: size / (size + m) };
    },
    sample: (rng, t) => rng.poisson(rng.gamma(t.size) * (1 - t.probability) / t.probability),
  },
  binomial: {
    kind: "discrete", label: "binomial", scipy: "binom", estimatedParameters: 1, supportStart: 0,
    parameters: [numericParameter("trials", { integer: true, minimum: 1 }), numericParameter("probability", { minimum: 0, maximum: 1 })],
    support: (k, t) => isInteger(k) && k >= 0 && k <= t.trials,
    logPmf: (k, t) => (!isInteger(k) || k < 0 || k > t.trials ? -Infinity : (t.probability === 0 ? (k === 0 ? 0 : -Infinity) : t.probability === 1 ? (k === t.trials ? 0 : -Infinity) : logChoose(t.trials, k) + k * Math.log(t.probability) + (t.trials - k) * Math.log1p(-t.probability))),
    cdf: (k, t) => (k < 0 ? 0 : k >= t.trials ? 1 : S.regularizedBeta(1 - t.probability, t.trials - Math.floor(k), Math.floor(k) + 1)),
    fit(x, ctx) {
      const trials = ctx.options.trials;
      if (trials === null) ctx.H.fail("STAT_INVALID_INPUT", "options.trials is required for the binomial family");
      if (x.some((value) => !isInteger(value) || value < 0 || value > trials)) ctx.H.fail("STAT_INVALID_INPUT", "binomial requires integer counts between 0 and options.trials");
      const probability = mean(x) / trials;
      if (!(probability > 0) || !(probability < 1)) ctx.H.fail("STAT_DEGENERATE", "binomial success probability is on the boundary");
      return { trials, probability };
    },
    sample(rng, t) {
      const u = rng.uniform();
      let cumulative = 0;
      for (let k = 0; k < t.trials; k += 1) { cumulative += Math.exp(FAMILIES.binomial.logPmf(k, t)); if (u < cumulative) return k; }
      return t.trials;
    },
  },
  geometric: {
    kind: "discrete", label: "geometric (trials to first success)", scipy: "geom", estimatedParameters: 1, supportStart: 1,
    parameters: [numericParameter("probability", { exclusiveMinimum: 0, maximum: 1 })],
    support: (k) => isInteger(k) && k >= 1,
    logPmf: (k, t) => (!isInteger(k) || k < 1 ? -Infinity : (k - 1) * Math.log1p(-t.probability) + Math.log(t.probability)),
    cdf: (k, t) => (k < 1 ? 0 : 1 - Math.pow(1 - t.probability, Math.floor(k))),
    fit(x, ctx) {
      if (x.some((value) => !isInteger(value) || value < 1)) ctx.H.fail("STAT_INVALID_INPUT", "geometric requires integer values of at least 1 (trials to the first success)");
      return { probability: 1 / mean(x) };
    },
    sample: (rng, t) => Math.max(1, Math.ceil(Math.log(1 - rng.uniformOpen()) / Math.log1p(-t.probability))),
  },
};

function logChoose(n, k) { return S.logGamma(n + 1) - S.logGamma(k + 1) - S.logGamma(n - k + 1); }

const FIT_FAMILIES = Object.keys(FAMILIES).filter((name) => !FAMILIES[name].calculatorOnly);
const CALCULATOR_FAMILIES = Object.keys(FAMILIES);

function densityAt(family, x, theta) {
  const def = FAMILIES[family];
  const value = def.kind === "discrete" ? def.logPmf(x, theta) : def.logPdf(x, theta);
  return Number.isFinite(value) ? Math.exp(value) : value === -Infinity ? 0 : null;
}

function logLikelihood(family, values, theta) {
  const def = FAMILIES[family];
  let total = 0;
  for (const value of values) {
    const term = def.kind === "discrete" ? def.logPmf(value, theta) : def.logPdf(value, theta);
    if (!Number.isFinite(term)) return -Infinity;
    total += term;
  }
  return total;
}

function quantileOf(family, p, theta, budget) {
  const def = FAMILIES[family];
  if (def.kind === "discrete") return discreteQuantile(p, (k) => def.logPmf(k, theta), def.supportStart, budget);
  return def.quantile(p, theta);
}

function parameterList(family, theta) {
  return FAMILIES[family].parameters.map((parameter) => ({ parameter: parameter.name, estimate: theta[parameter.name] }));
}

function validateParameters(family, raw, H, path) {
  const def = FAMILIES[family];
  H.assertObject(raw, path);
  H.assertKeys(raw, def.parameters.map((parameter) => parameter.name), path);
  const theta = {};
  for (const parameter of def.parameters) {
    const value = raw[parameter.name];
    if (value === undefined) H.fail("STAT_INVALID_INPUT", `${path}.${parameter.name} is required for the ${family} family`);
    const number = H.finiteNumber(value, `${path}.${parameter.name}`);
    if (parameter.positive && !(number > 0)) H.fail("STAT_INVALID_INPUT", `${path}.${parameter.name} must be positive`);
    if (parameter.integer && !isInteger(number)) H.fail("STAT_INVALID_INPUT", `${path}.${parameter.name} must be an integer`);
    if (parameter.minimum !== null && number < parameter.minimum) H.fail("STAT_INVALID_INPUT", `${path}.${parameter.name} must be at least ${parameter.minimum}`);
    if (parameter.maximum !== null && number > parameter.maximum) H.fail("STAT_INVALID_INPUT", `${path}.${parameter.name} must be at most ${parameter.maximum}`);
    if (parameter.exclusiveMinimum !== null && number <= parameter.exclusiveMinimum) H.fail("STAT_INVALID_INPUT", `${path}.${parameter.name} must exceed ${parameter.exclusiveMinimum}`);
    if (parameter.exclusiveMaximum !== null && number >= parameter.exclusiveMaximum) H.fail("STAT_INVALID_INPUT", `${path}.${parameter.name} must be below ${parameter.exclusiveMaximum}`);
    theta[parameter.name] = number;
  }
  if (family === "uniform" && !(theta.upper > theta.lower)) H.fail("STAT_INVALID_INPUT", `${path}.upper must exceed ${path}.lower`);
  return theta;
}

// ---------------------------------------------------------------------------------------------
// Goodness-of-fit statistics.
// ---------------------------------------------------------------------------------------------

function continuousGofStatistics(sortedValues, cdf) {
  const n = sortedValues.length;
  const u = sortedValues.map((value) => clampProbability(cdf(value)));
  let ad = 0;
  let cvm = 1 / (12 * n);
  let ks = 0;
  for (let i = 0; i < n; i += 1) {
    ad += (2 * i + 1) * (Math.log(u[i]) + Math.log(1 - u[n - 1 - i]));
    const center = (2 * i + 1) / (2 * n);
    cvm += (u[i] - center) ** 2;
    ks = Math.max(ks, (i + 1) / n - u[i], u[i] - i / n);
  }
  return { andersonDarling: -n - ad / n, cramerVonMises: cvm, kolmogorovSmirnov: ks };
}

function discreteCells(values, family, theta) {
  const def = FAMILIES[family];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const n = values.length;
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  const raw = [];
  for (let k = min; k <= max; k += 1) {
    let probability = Math.exp(def.logPmf(k, theta));
    if (k === min) probability += def.cdf(min - 1, theta);
    if (k === max) probability += 1 - def.cdf(max, theta);
    raw.push({ from: k, to: k, observed: counts.get(k) || 0, expected: n * probability });
  }
  // pool adjacent cells until every expected count is at least 5
  const cells = [];
  let current = null;
  for (const cell of raw) {
    if (!current) { current = { ...cell }; continue; }
    if (current.expected < 5) { current.to = cell.to; current.observed += cell.observed; current.expected += cell.expected; } else { cells.push(current); current = { ...cell }; }
  }
  if (current) {
    if (current.expected < 5 && cells.length) { const last = cells.pop(); last.to = current.to; last.observed += current.observed; last.expected += current.expected; cells.push(last); } else cells.push(current);
  }
  return cells;
}

function discreteChiSquare(cells) {
  let statistic = 0;
  for (const cell of cells) if (cell.expected > 0) statistic += ((cell.observed - cell.expected) ** 2) / cell.expected;
  return statistic;
}

function discreteChiSquareForFit(values, family, theta, cellsTemplate) {
  const def = FAMILIES[family];
  const n = values.length;
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  let statistic = 0;
  cellsTemplate.forEach((cell, index) => {
    let observed = 0;
    for (const [value, count] of counts) {
      if ((value >= cell.from || index === 0) && (value <= cell.to || index === cellsTemplate.length - 1)) observed += count;
    }
    let probability = 0;
    if (index === 0) probability = def.cdf(cell.to, theta);
    else if (index === cellsTemplate.length - 1) probability = 1 - def.cdf(cell.from - 1, theta);
    else probability = def.cdf(cell.to, theta) - def.cdf(cell.from - 1, theta);
    const expected = n * probability;
    if (expected > 0) statistic += ((observed - expected) ** 2) / expected;
  });
  return statistic;
}

// ---------------------------------------------------------------------------------------------
// distribution_fit_extended
// ---------------------------------------------------------------------------------------------

function locationOption() {
  return {
    schema: { anyOf: [{ type: "number" }, { type: "string", enum: ["estimate"] }] },
    default: 0,
    parse(value, H, path) {
      if (value === "estimate") return value;
      return H.finiteNumber(value, path);
    },
  };
}

function fitFamily(family, values, ctx) {
  const def = FAMILIES[family];
  const theta = def.fit(values, ctx);
  const clean = {};
  for (const parameter of def.parameters) clean[parameter.name] = theta[parameter.name];
  return { theta: clean, converged: theta.converged === undefined ? true : theta.converged, locationAtBoundary: theta.locationAtBoundary === true };
}

function gofForFit(family, values, sortedValues, theta, cellsTemplate) {
  const def = FAMILIES[family];
  if (def.kind === "discrete") {
    return { chiSquare: discreteChiSquareForFit(values, family, theta, cellsTemplate) };
  }
  return continuousGofStatistics(sortedValues, (x) => def.cdf(x, theta));
}

const distributionFitExtended = {
  method: "distribution_fit_extended",
  family: FAMILY,
  analysisModel: { families: ["lm"], distributions: [null, ...FIT_FAMILIES, "gaussian", "student-t"], links: [null, "identity", "log"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    distribution: { schema: { type: "string", enum: FIT_FAMILIES }, default: "gamma", parse(value, H, path) { if (!FIT_FAMILIES.includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be one of ${FIT_FAMILIES.join(", ")}`); return value; } },
    bootstrapResamples: { schema: { type: "integer", minimum: 0, maximum: 2000 }, default: 200, parse(value, H, path) { return H.integer(value, 0, 2000, path); } },
    seed: S.seedOption(),
    location: locationOption(),
    trials: { schema: { type: ["integer", "null"], minimum: 1, maximum: 1000000 }, default: null, parse(value, H, path) { return value === null ? null : H.integer(value, 1, 1_000_000, path); } },
    compareFamilies: { schema: { type: "boolean" }, default: true, parse(value, H, path) { if (typeof value !== "boolean") H.fail("STAT_INVALID_INPUT", `${path} must be boolean`); return value; } },
    histogramBins: { schema: { type: "integer", minimum: 4, maximum: 100 }, default: 12, parse(value, H, path) { return H.integer(value, 4, 100, path); } },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["values"],
    properties: {
      values: { type: "array", minItems: 8, maxItems: 20000, items: { type: "number" } },
      label: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["values", "label"], "data");
    const values = H.numericVector(data.values, "data.values", 8);
    if (values.length > 20000) H.fail("STAT_LIMIT_EXCEEDED", "distribution fitting is limited to 20000 values");
    const def = FAMILIES[options.distribution];
    if (def.kind === "discrete" && values.some((value) => !isInteger(value))) H.fail("STAT_INVALID_INPUT", `${options.distribution} requires integer values`);
    if (H.minMax(values).min === H.minMax(values).max) H.fail("STAT_DEGENERATE", "all values are identical");
    return { values, label: H.label(data.label, "Value", "data.label") };
  },
  analyze(parsed, options, budget, H) {
    const { values, label } = parsed;
    const n = values.length;
    const family = options.distribution;
    const def = FAMILIES[family];
    const ctx = { H, budget, options };
    const sorted = [...values].sort((a, b) => a - b);
    const fit = fitFamily(family, values, ctx);
    const theta = fit.theta;
    const logLik = logLikelihood(family, values, theta);
    if (!Number.isFinite(logLik)) H.fail("STAT_NUMERIC_FAILURE", "log-likelihood is not finite at the fitted parameters");
    const parameterCount = def.estimatedParameters + (family === "lognormal" || family === "exponential" ? (options.location === "estimate" ? 1 : 0) : 0);
    const aic = -2 * logLik + 2 * parameterCount;
    const bic = -2 * logLik + parameterCount * Math.log(n);
    const cellsTemplate = def.kind === "discrete" ? discreteCells(values, family, theta) : null;
    const observedGof = gofForFit(family, values, sorted, theta, cellsTemplate);
    // seeded parametric bootstrap: GOF p-values and percentile parameter intervals
    const B = options.bootstrapResamples;
    const rng = S.createRng(options.seed);
    const statKeys = Object.keys(observedGof);
    const exceed = Object.fromEntries(statKeys.map((key) => [key, 0]));
    const bootParameters = Object.fromEntries(Object.keys(theta).map((key) => [key, []]));
    let failures = 0;
    let completed = 0;
    for (let b = 0; b < B; b += 1) {
      budget.check(n * 20);
      const replicate = Array.from({ length: n }, () => def.sample(rng, theta));
      let refit;
      try {
        refit = fitFamily(family, replicate, ctx);
      } catch (error) {
        if (error instanceof H.StatisticsError && error.code !== "STAT_TIMEOUT") { failures += 1; continue; }
        throw error;
      }
      const replicateSorted = [...replicate].sort((a, b) => a - b);
      const gof = gofForFit(family, replicate, replicateSorted, refit.theta, cellsTemplate);
      for (const key of statKeys) if (Number.isFinite(gof[key]) && gof[key] >= observedGof[key]) exceed[key] += 1;
      for (const key of Object.keys(theta)) bootParameters[key].push(refit.theta[key]);
      completed += 1;
    }
    const alpha = 1 - options.confidenceLevel;
    const intervalRows = Object.keys(theta).map((key) => {
      const draws = [...bootParameters[key]].sort((a, b) => a - b);
      const usable = completed >= 20;
      return { parameter: key, estimate: theta[key], lower: usable ? H.quantileR7(draws, alpha / 2) : null, upper: usable ? H.quantileR7(draws, 1 - alpha / 2) : null, bootstrapSd: usable ? sampleSd(draws) : null, method: usable ? "parametric bootstrap percentile" : "not_available" };
    });
    const gofRows = statKeys.map((key) => ({
      statistic: key === "andersonDarling" ? "Anderson-Darling A2" : key === "cramerVonMises" ? "Cramer-von Mises W2" : key === "kolmogorovSmirnov" ? "Kolmogorov-Smirnov D" : "Pearson chi-square (pooled cells)",
      value: observedGof[key],
      bootstrapPValue: completed > 0 ? (1 + exceed[key]) / (completed + 1) : null,
      resamples: completed,
      ...(key === "chiSquare" ? { df: Math.max(1, cellsTemplate.length - 1 - def.estimatedParameters), asymptoticPValue: cellsTemplate.length - 1 - def.estimatedParameters >= 1 ? S.chiSquareSurvival(observedGof[key], cellsTemplate.length - 1 - def.estimatedParameters) : null } : { df: null, asymptoticPValue: null }),
    }));
    // quantile / probability rows
    const qqRows = sorted.map((value, index) => {
      const p = (index + 0.5) / n;
      return { order: index + 1, observed: value, plottingPosition: p, theoreticalQuantile: quantileOf(family, p, theta, budget), fittedCdf: def.cdf(value, theta) };
    });
    // density rows
    let densityRows;
    if (def.kind === "discrete") {
      const counts = new Map();
      for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
      const min = sorted[0];
      const max = sorted[n - 1];
      densityRows = [];
      for (let k = min; k <= max; k += 1) densityRows.push({ x: k, binStart: k - 0.5, binEnd: k + 0.5, observedDensity: (counts.get(k) || 0) / n, fittedDensity: Math.exp(def.logPmf(k, theta)) });
    } else {
      const bins = H.histogram(values, options.histogramBins);
      densityRows = bins.map((bin) => {
        const width = bin.binEnd - bin.binStart;
        const x = 0.5 * (bin.binStart + bin.binEnd);
        return { x, binStart: bin.binStart, binEnd: bin.binEnd, observedDensity: width > 0 ? bin.count / (n * width) : 0, fittedDensity: densityAt(family, x, theta) ?? 0 };
      });
      const [lo, hi] = def.plotRange(theta);
      const gridLo = Math.min(lo, sorted[0]);
      const gridHi = Math.max(hi, sorted[n - 1]);
      const curve = [];
      for (let index = 0; index <= 100; index += 1) {
        const x = gridLo + (gridHi - gridLo) * index / 100;
        const density = densityAt(family, x, theta);
        curve.push({ x, fittedDensity: density === null || !Number.isFinite(density) ? 0 : density });
      }
      densityRows.curve = curve;
    }
    const curveRows = def.kind === "discrete" ? densityRows.map((row) => ({ x: row.x, fittedDensity: row.fittedDensity })) : densityRows.curve;
    // candidate comparison
    const candidateRows = [];
    if (options.compareFamilies) {
      const candidates = FIT_FAMILIES.filter((name) => FAMILIES[name].kind === def.kind);
      for (const candidate of candidates) {
        budget.check(n * 50);
        try {
          const candidateCtx = { H, budget, options: { ...options, location: candidate === family ? options.location : 0 } };
          const candidateFit = candidate === family ? fit : fitFamily(candidate, values, candidateCtx);
          const candidateLogLik = logLikelihood(candidate, values, candidateFit.theta);
          if (!Number.isFinite(candidateLogLik)) throw new H.StatisticsError("STAT_NUMERIC_FAILURE", "non-finite log-likelihood");
          const count = FAMILIES[candidate].estimatedParameters + (candidate === family ? parameterCount - def.estimatedParameters : 0);
          const gof = candidate === family ? observedGof : gofForFit(candidate, values, sorted, candidateFit.theta, FAMILIES[candidate].kind === "discrete" ? discreteCells(values, candidate, candidateFit.theta) : null);
          candidateRows.push({ family: candidate, status: "fitted", parameters: count, logLikelihood: candidateLogLik, aic: -2 * candidateLogLik + 2 * count, bic: -2 * candidateLogLik + count * Math.log(n), andersonDarling: gof.andersonDarling ?? null, kolmogorovSmirnov: gof.kolmogorovSmirnov ?? null, chiSquare: gof.chiSquare ?? null, selected: candidate === family, reason: null });
        } catch (error) {
          if (!(error instanceof H.StatisticsError) || error.code === "STAT_TIMEOUT") throw error;
          candidateRows.push({ family: candidate, status: "not_fitted", parameters: null, logLikelihood: null, aic: null, bic: null, andersonDarling: null, kolmogorovSmirnov: null, chiSquare: null, selected: candidate === family, reason: error.message });
        }
      }
      candidateRows.sort((a, b) => (a.aic === null) - (b.aic === null) || (a.aic ?? 0) - (b.aic ?? 0) || (a.family < b.family ? -1 : 1));
      candidateRows.forEach((row, index) => { row.rank = row.aic === null ? null : index + 1; });
    }
    const parameterRows = parameterList(family, theta);
    const summaryRows = [{ family, kind: def.kind, n, logLikelihood: logLik, parameters: parameterCount, aic, bic, converged: fit.converged }];
    const bootstrapStatus = B === 0 ? "disabled" : completed >= 20 ? "evaluated" : "insufficient";
    return {
      sample: { n, label, family, kind: def.kind, bootstrapResamples: B, bootstrapCompleted: completed },
      estimates: [
        { name: "log-likelihood", kind: "scalar", estimate: logLik },
        { name: "AIC", kind: "scalar", estimate: aic },
        { name: "BIC", kind: "scalar", estimate: bic },
        { name: "parameters", kind: "rows", rows: parameterRows },
        { name: "parameterIntervals", kind: "rows", rows: intervalRows },
        { name: "goodnessOfFit", kind: "rows", rows: gofRows },
        { name: "candidates", kind: "rows", rows: candidateRows },
        { name: "quantiles", kind: "rows", rows: qqRows },
        { name: "density", kind: "rows", rows: densityRows.map((row) => ({ x: row.x, binStart: row.binStart, binEnd: row.binEnd, observedDensity: row.observedDensity, fittedDensity: row.fittedDensity })) },
        { name: "fittedCurve", kind: "rows", rows: curveRows },
        ...(cellsTemplate ? [{ name: "chiSquareCells", kind: "rows", rows: cellsTemplate.map((cell) => ({ from: cell.from, to: cell.to, observed: cell.observed, expected: cell.expected })) }] : []),
      ],
      tests: gofRows.map((row) => ({ name: `${row.statistic} (${family})`, statistic: row.value, distribution: "parametric bootstrap", df: row.df, pValue: row.bootstrapPValue, asymptoticPValue: row.asymptoticPValue })),
      confidenceIntervals: intervalRows.filter((row) => row.lower !== null).map((row) => ({ parameter: row.parameter, estimate: row.estimate, lower: row.lower, upper: row.upper, level: options.confidenceLevel, method: row.method })),
      effectSizes: [{ name: "AIC", estimate: aic }, { name: "BIC", estimate: bic }],
      assumptions: [
        { name: "independent identically distributed observations", status: "requires_design_review" },
        { name: `${family} support`, status: "verified", detail: def.kind === "discrete" ? "integer counts on the family support" : "all values lie inside the fitted support" },
        ...(family === "lognormal" || family === "exponential" ? [{ name: "location handling", status: options.location === "estimate" ? "estimated_by_profile_likelihood" : "fixed", value: theta.location, detail: fit.locationAtBoundary ? "the profile optimum sits at the search boundary; treat the location as unreliable" : options.location === "estimate" ? "location found by a grid plus Brent search of the profile log-likelihood" : "location fixed by options.location" }] : []),
      ],
      diagnostics: [
        { name: "maximum likelihood", status: fit.converged ? "converged" : "iteration_limit", detail: def.kind === "discrete" || ["normal", "gamma", "weibull", "beta", "gumbel", "exponential", "uniform", "lognormal"].includes(family) ? "closed form or one-dimensional root / Newton iteration" : "Nelder-Mead on transformed parameters" },
        { name: "goodness-of-fit p-values", status: bootstrapStatus, resamples: B, completed, refitFailures: failures, seed: options.seed, detail: "parametric bootstrap with parameters re-estimated in every replicate (accounts for estimation); the asymptotic chi-square p, when shown, treats the pooled cells as fixed" },
        { name: "parameter intervals", status: bootstrapStatus === "evaluated" ? "bootstrap_percentile" : "not_available", detail: "percentile intervals from the same bootstrap replicates; no bias correction" },
        { name: "candidate comparison", status: options.compareFamilies ? "evaluated" : "disabled", detail: "AIC/BIC across families of the same kind fitted to the same values; families with location options use location 0 unless selected" },
        { name: "renderer exact-data contract", status: "verified", rows: densityRows.length, rowsHash: H.sha256(densityRows.map((row) => ({ x: row.x, binStart: row.binStart, binEnd: row.binEnd, observedDensity: row.observedDensity, fittedDensity: row.fittedDensity }))), quantileRowsHash: H.sha256(qqRows) },
      ],
      artifacts: [
        H.tableArtifact("Fitted distribution", `Maximum-likelihood ${def.label} fit to ${label}.`, [{ key: "family", label: "Family", type: "string" }, { key: "kind", label: "Kind", type: "string" }, { key: "n", label: "n", type: "number" }, { key: "logLikelihood", label: "Log-likelihood", type: "number" }, { key: "parameters", label: "Parameters", type: "number" }, { key: "aic", label: "AIC", type: "number" }, { key: "bic", label: "BIC", type: "number" }, { key: "converged", label: "Converged", type: "boolean" }], summaryRows, [], "distribution-fit-summary-table"),
        H.tableArtifact("Parameter estimates", `${Math.round(options.confidenceLevel * 100)}% parametric-bootstrap percentile intervals (${completed} usable replicates).`, [{ key: "parameter", label: "Parameter", type: "string" }, { key: "estimate", label: "Estimate", type: "number" }, { key: "lower", label: "Lower", type: "number" }, { key: "upper", label: "Upper", type: "number" }, { key: "bootstrapSd", label: "Bootstrap SD", type: "number" }, { key: "method", label: "Method", type: "string" }], intervalRows, [], "distribution-fit-parameter-table"),
        H.tableArtifact("Goodness of fit", "Statistics computed with the fitted parameters; p-values from the seeded parametric bootstrap.", [{ key: "statistic", label: "Statistic", type: "string" }, { key: "value", label: "Value", type: "number" }, { key: "df", label: "df", type: "number" }, { key: "asymptoticPValue", label: "Asymptotic p", type: "number" }, { key: "bootstrapPValue", label: "Bootstrap p", type: "number" }, { key: "resamples", label: "Resamples", type: "number" }], gofRows, ["Bootstrap p = (1 + number of replicate statistics at least as large) / (replicates + 1)."], "distribution-fit-gof-table"),
        H.tableArtifact("Candidate families", "Same-kind families fitted to the same values, ranked by AIC.", [{ key: "rank", label: "Rank", type: "number" }, { key: "family", label: "Family", type: "string" }, { key: "status", label: "Status", type: "string" }, { key: "parameters", label: "Parameters", type: "number" }, { key: "logLikelihood", label: "Log-likelihood", type: "number" }, { key: "aic", label: "AIC", type: "number" }, { key: "bic", label: "BIC", type: "number" }, { key: "andersonDarling", label: "A2", type: "number" }, { key: "kolmogorovSmirnov", label: "KS D", type: "number" }, { key: "chiSquare", label: "Chi-square", type: "number" }, { key: "selected", label: "Selected", type: "boolean" }, { key: "reason", label: "Reason", type: "string" }], candidateRows, [], "distribution-fit-candidate-table"),
        H.tableArtifact("Quantile and probability rows", "Sorted observations with plotting positions (i - 0.5) / n, fitted theoretical quantiles, and fitted CDF values.", [{ key: "order", label: "i", type: "number" }, { key: "observed", label: "Observed", type: "number" }, { key: "plottingPosition", label: "(i - 0.5)/n", type: "number" }, { key: "theoreticalQuantile", label: "Fitted quantile", type: "number" }, { key: "fittedCdf", label: "Fitted CDF", type: "number" }], qqRows, [], "distribution-fit-quantile-table"),
        H.tableArtifact("Density rows", def.kind === "discrete" ? "Observed proportions and fitted probabilities on the observed support." : "Histogram density (count / (n x width)) and fitted density at the bin midpoint.", [{ key: "x", label: "x", type: "number" }, { key: "binStart", label: "Bin start", type: "number" }, { key: "binEnd", label: "Bin end", type: "number" }, { key: "observedDensity", label: "Observed density", type: "number" }, { key: "fittedDensity", label: "Fitted density", type: "number" }], densityRows.map((row) => ({ x: row.x, binStart: row.binStart, binEnd: row.binEnd, observedDensity: row.observedDensity, fittedDensity: row.fittedDensity })), [], "distribution-fit-density-table"),
        H.tableArtifact("Fitted density curve", "Fitted density evaluated on a grid spanning the data and the fitted support.", [{ key: "x", label: "x", type: "number" }, { key: "fittedDensity", label: "Fitted density", type: "number" }], curveRows, [], "distribution-fit-curve-table"),
        H.vegaArtifact("distribution-fit-density-plot", `${def.label} fit over the histogram of ${label}`, {
          layer: [
            { data: { values: densityRows.map((row) => ({ x: row.x, binStart: row.binStart, binEnd: row.binEnd, observedDensity: row.observedDensity, fittedDensity: row.fittedDensity })) }, mark: { type: "bar", color: "#9DB8D2", opacity: 0.8 }, encoding: { x: { field: "binStart", type: "quantitative", title: label }, x2: { field: "binEnd" }, y: { field: "observedDensity", type: "quantitative", title: "Density" }, tooltip: [{ field: "binStart", format: ".4g" }, { field: "binEnd", format: ".4g" }, { field: "observedDensity", format: ".4g" }] } },
            { data: { values: curveRows }, mark: { type: "line", color: "#B3261E", strokeWidth: 2 }, encoding: { x: { field: "x", type: "quantitative" }, y: { field: "fittedDensity", type: "quantitative" } } },
          ],
        }),
        H.vegaArtifact("distribution-fit-qq-plot", `Q-Q plot against the fitted ${def.label}`, {
          data: { values: qqRows },
          layer: [
            { mark: { type: "point", filled: true, size: 45, color: "#285F8F" }, encoding: { x: { field: "theoreticalQuantile", type: "quantitative", title: "Fitted quantile" }, y: { field: "observed", type: "quantitative", title: "Observed" }, tooltip: [{ field: "order" }, { field: "observed", format: ".4g" }, { field: "theoreticalQuantile", format: ".4g" }] } },
            { mark: { type: "line", color: "#7A7672", strokeDash: [5, 4] }, encoding: { x: { field: "theoreticalQuantile", type: "quantitative" }, y: { field: "theoreticalQuantile", type: "quantitative" } } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When a parametric distribution beyond the normal must be justified for a variable before it feeds a simulation, a capability index, a reliability model, or a likelihood-based analysis.",
    decision: "Which family fits, whether the fit is adequate under bootstrap-calibrated goodness-of-fit tests, and how uncertain the parameters are.",
    mustShow: "Parameter estimates with bootstrap intervals, AD/CvM/KS (or chi-square) statistics with bootstrap p-values, the AIC ranking of candidate families, and the density-over-histogram and Q-Q displays.",
    userGoal: "Choose and defend a distributional model for downstream use.",
    nextActions: [
      { trigger: "bootstrap-gof-p-below-alpha", action: "inspect-qq-tails-and-try-the-next-aic-candidate", reason: "The chosen family is rejected; the Q-Q plot shows where it fails." },
      { trigger: "candidates-within-2-aic", action: "prefer-the-simpler-or-substantively-motivated-family", reason: "The data do not discriminate between the families." },
      { trigger: "location-at-boundary", action: "fix-the-location-from-subject-knowledge", reason: "A threshold at the search boundary is not identified by the data." },
    ],
  },
  fixture: { data: { values: FIXTURE.gammaDraws, label: "repair time (h)" }, options: { distribution: "gamma", bootstrapResamples: 200, seed: 5, compareFamilies: true } },
  matlabParity: { taxonomyIds: ["matlab.stats.probability-hypothesis", "matlab.stats.hypothesis.distribution"] },
  coverage: {
    implementedBoundary: "Maximum-likelihood fits for normal, Student t, logistic, Gumbel, GEV, gamma, Weibull, beta, lognormal and exponential (fixed or profile-estimated location), uniform, Poisson, negative binomial, binomial (known trials), and geometric families; Anderson-Darling, Cramer-von Mises, and Kolmogorov-Smirnov statistics (pooled-cell chi-square for discrete families) with seeded parametric-bootstrap p-values and percentile parameter intervals; AIC/BIC candidate ranking.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["parameter estimates against scipy.stats fits (closed-form families exactly; optimiser families by log-likelihood comparison)", "log-likelihood at the emitted parameters against scipy", "Anderson-Darling, Cramer-von Mises, and KS statistics against scipy / numpy formulas at the emitted parameters", "fitted quantiles and CDF values against scipy"], excludedOutputs: ["bootstrap p-values and percentile intervals (seeded resampling; only a Monte Carlo agreement band is checked against scipy goodness_of_fit)", "candidate rows for families other than the selected one"] },
    diagnostic: { level: "method-specific-partial", emitted: ["maximum likelihood", "goodness-of-fit p-values", "parameter intervals", "candidate comparison"], limitations: ["percentile bootstrap intervals are not bias-corrected", "the discrete chi-square uses a data-driven pooling of cells"] },
    knownGaps: ["censored or truncated data", "mixtures and multimodal families", "profile-likelihood intervals"],
  },
};

// ---------------------------------------------------------------------------------------------
// probability_calculator
// ---------------------------------------------------------------------------------------------

const probabilityCalculator = {
  method: "probability_calculator",
  family: FAMILY,
  analysisModel: { families: ["lm"], distributions: [null, ...CALCULATOR_FAMILIES, "gaussian", "student-t"], links: [null, "identity"] },
  optionKeys: ["timeoutMs"],
  customOptions: {
    curvePoints: { schema: { type: "integer", minimum: 11, maximum: 401 }, default: 101, parse(value, H, path) { return H.integer(value, 11, 401, path); } },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["distribution", "parameters"],
    properties: {
      distribution: { type: "string", enum: CALCULATOR_FAMILIES },
      parameters: { type: "object", additionalProperties: { type: "number" } },
      values: { type: "array", minItems: 1, maxItems: 1000, items: { type: "number" } },
      probabilities: { type: "array", minItems: 1, maxItems: 1000, items: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 } },
      label: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["distribution", "parameters", "values", "probabilities", "label"], "data");
    if (!CALCULATOR_FAMILIES.includes(data.distribution)) H.fail("STAT_INVALID_INPUT", `data.distribution must be one of ${CALCULATOR_FAMILIES.join(", ")}`);
    const family = data.distribution;
    const theta = validateParameters(family, data.parameters, H, "data.parameters");
    if (data.values === undefined && data.probabilities === undefined) H.fail("STAT_INVALID_INPUT", "supply data.values, data.probabilities, or both");
    const values = data.values === undefined ? [] : H.numericVector(data.values, "data.values", 1);
    if (values.length > 1000) H.fail("STAT_LIMIT_EXCEEDED", "data.values is limited to 1000 entries");
    const probabilities = data.probabilities === undefined ? [] : H.numericVector(data.probabilities, "data.probabilities", 1);
    if (probabilities.length > 1000) H.fail("STAT_LIMIT_EXCEEDED", "data.probabilities is limited to 1000 entries");
    for (const p of probabilities) if (!(p > 0 && p < 1)) H.fail("STAT_INVALID_INPUT", "data.probabilities must lie strictly inside (0, 1)");
    return { family, theta, values, probabilities, label: H.label(data.label, "x", "data.label") };
  },
  analyze(parsed, options, budget, H) {
    const { family, theta, values, probabilities, label } = parsed;
    const def = FAMILIES[family];
    const valueRows = values.map((x) => {
      budget.check(10);
      const density = densityAt(family, x, theta);
      const cdf = def.cdf(x, theta);
      return { x, density: density === null || !Number.isFinite(density) ? null : density, cdf, survival: 1 - cdf, inSupport: def.support(x, theta) };
    });
    const probabilityRows = probabilities.map((p) => { budget.check(50); return { probability: p, quantile: quantileOf(family, p, theta, budget) }; });
    let curveRows;
    if (def.kind === "discrete") {
      const lower = def.supportStart;
      const upper = family === "binomial" ? theta.trials : quantileOf(family, 0.9995, theta, budget);
      const step = Math.max(1, Math.ceil((upper - lower + 1) / options.curvePoints));
      curveRows = [];
      for (let k = lower; k <= upper; k += step) curveRows.push({ x: k, density: Math.exp(def.logPmf(k, theta)), cdf: def.cdf(k, theta) });
    } else {
      const [lo, hi] = def.plotRange(theta);
      curveRows = Array.from({ length: options.curvePoints }, (_, index) => {
        const x = lo + (hi - lo) * index / (options.curvePoints - 1);
        const density = densityAt(family, x, theta);
        return { x, density: density === null || !Number.isFinite(density) ? 0 : density, cdf: def.cdf(x, theta) };
      });
    }
    const momentRows = parameterList(family, theta);
    const meanEstimate = def.kind === "discrete" ? curveRows.reduce((total, row) => total + row.x * row.density, 0) : null;
    return {
      sample: { family, kind: def.kind, values: values.length, probabilities: probabilities.length, label },
      estimates: [
        { name: "parameters", kind: "rows", rows: momentRows },
        { name: "values", kind: "rows", rows: valueRows },
        { name: "probabilities", kind: "rows", rows: probabilityRows },
        { name: "curve", kind: "rows", rows: curveRows },
        ...(meanEstimate === null ? [] : [{ name: "mean over the displayed support", kind: "scalar", estimate: meanEstimate }]),
      ],
      tests: [],
      confidenceIntervals: [],
      effectSizes: [],
      assumptions: [{ name: "parameters are known constants", status: "assumed_from_request", detail: "no estimation uncertainty is propagated" }],
      diagnostics: [
        { name: "parameterization", status: "documented", detail: `${def.label}: ${def.parameters.map((parameter) => parameter.name).join(", ")}${family === "gev" ? " (shape > 0 heavy upper tail, equal to minus the scipy genextreme c)" : family === "negative_binomial" ? " (size and success probability; support counts failures before size successes, as scipy nbinom)" : family === "geometric" ? " (support starts at 1, as scipy geom)" : family === "weibull" ? " (shape c and scale, as scipy weibull_min)" : ""}` },
        { name: "support check", status: valueRows.every((row) => row.inSupport) ? "all_in_support" : "values_outside_support", outside: valueRows.filter((row) => !row.inSupport).length },
        { name: "renderer exact-data contract", status: "verified", rows: curveRows.length, rowsHash: H.sha256(curveRows), valueRowsHash: H.sha256(valueRows) },
      ],
      artifacts: [
        H.tableArtifact("Probabilities at requested values", `${def.label} density / mass, CDF, and survival at each requested ${label}.`, [{ key: "x", label: label, type: "number" }, { key: "density", label: def.kind === "discrete" ? "P(X = x)" : "Density", type: "number" }, { key: "cdf", label: "P(X <= x)", type: "number" }, { key: "survival", label: "P(X > x)", type: "number" }, { key: "inSupport", label: "In support", type: "boolean" }], valueRows, [], "probability-value-table"),
        H.tableArtifact("Quantiles at requested probabilities", `${def.label} quantiles${def.kind === "discrete" ? " (smallest k with CDF at least p)" : ""}.`, [{ key: "probability", label: "p", type: "number" }, { key: "quantile", label: "Quantile", type: "number" }], probabilityRows, [], "probability-quantile-table"),
        H.tableArtifact("Distribution parameters", "Parameters as supplied.", [{ key: "parameter", label: "Parameter", type: "string" }, { key: "estimate", label: "Value", type: "number" }], momentRows, [], "probability-parameter-table"),
        H.tableArtifact("Density and CDF curve", "Grid used for the density and CDF display.", [{ key: "x", label: label, type: "number" }, { key: "density", label: def.kind === "discrete" ? "P(X = x)" : "Density", type: "number" }, { key: "cdf", label: "CDF", type: "number" }], curveRows, [], "probability-curve-table"),
        H.vegaArtifact("probability-density-plot", `${def.label} density with requested values`, {
          layer: [
            { data: { values: curveRows }, mark: def.kind === "discrete" ? { type: "bar", color: "#9DB8D2" } : { type: "area", color: "#9DB8D2", opacity: 0.5, line: { color: "#285F8F" } }, encoding: { x: { field: "x", type: "quantitative", title: label }, y: { field: "density", type: "quantitative", title: def.kind === "discrete" ? "Probability" : "Density" } } },
            { data: { values: valueRows }, mark: { type: "rule", color: "#B3261E", strokeDash: [5, 3] }, encoding: { x: { field: "x", type: "quantitative" }, tooltip: [{ field: "x" }, { field: "cdf", format: ".5f" }, { field: "survival", format: ".5f" }] } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When a probability, tail area, or quantile of a fully specified distribution is needed for a design threshold, a critical value, or a risk statement.",
    decision: "What probability mass lies below, above, or between stated values, and which values correspond to stated probabilities.",
    mustShow: "The parameterization, the requested values with density, CDF, and survival, the requested quantiles, and the density curve.",
    userGoal: "Read exact probabilities and quantiles without ambiguity about the parameterization.",
    nextActions: [
      { trigger: "value-outside-support", action: "check-the-parameterization-and-units", reason: "A requested value outside the support usually means a scale or location mismatch." },
      { trigger: "parameters-were-estimated", action: "use-distribution-fit-extended-for-uncertainty", reason: "Plugging in estimates ignores parameter uncertainty." },
      { trigger: "tail-probability-drives-a-decision", action: "report-both-cdf-and-survival-with-the-parameters", reason: "Tail statements must be reproducible from the stated parameters." },
    ],
  },
  fixture: { data: { distribution: "weibull", parameters: { shape: 1.8, scale: 1200 }, values: [500, 1000, 2000], probabilities: [0.1, 0.5, 0.9], label: "time to failure (h)" } },
  matlabParity: { taxonomyIds: ["matlab.stats.probability-hypothesis"] },
  coverage: {
    implementedBoundary: "Density / mass, CDF, survival, and quantile evaluation for the fit families plus normal, Student t, chi-square, and F with documented parameterizations; no truncation, mixtures, or multivariate distributions.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["density, CDF, survival at requested values against scipy.stats", "quantiles at requested probabilities against scipy.stats ppf"], excludedOutputs: ["curve grid rows (display only)"] },
    diagnostic: { level: "basic", emitted: ["parameterization", "support check"], limitations: ["no uncertainty propagation"] },
    knownGaps: ["truncated and censored distributions", "multivariate distributions", "random variate generation as an output"],
  },
};

// ---------------------------------------------------------------------------------------------
// chi_square_goodness_of_fit
// ---------------------------------------------------------------------------------------------

const chiSquareGoodnessOfFit = {
  method: "chi_square_goodness_of_fit",
  family: FAMILY,
  analysisModel: { families: ["glm"], distributions: [null, "multinomial", "poisson"], links: [null, "identity", "log"] },
  optionKeys: ["timeoutMs"],
  customOptions: {
    estimatedParameters: { schema: { type: "integer", minimum: 0, maximum: 32 }, default: 0, parse(value, H, path) { return H.integer(value, 0, 32, path); } },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["categories", "observed"],
    properties: {
      categories: { type: "array", minItems: 2, maxItems: 500, items: { type: "string", minLength: 1, maxLength: 128 } },
      observed: { type: "array", minItems: 2, maxItems: 500, items: { type: "number", minimum: 0 } },
      expectedProbabilities: { type: "array", minItems: 2, maxItems: 500, items: { type: "number", minimum: 0 } },
      label: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["categories", "observed", "expectedProbabilities", "label"], "data");
    const categories = H.categoryVector(data.categories, "data.categories", 2);
    if (categories.length > 500) H.fail("STAT_LIMIT_EXCEEDED", "at most 500 categories are supported");
    if (new Set(categories).size !== categories.length) H.fail("STAT_INVALID_INPUT", "data.categories must be unique");
    const observed = H.numericVector(data.observed, "data.observed", 2);
    if (observed.length !== categories.length) H.fail("STAT_INVALID_INPUT", "data.observed length must match data.categories");
    if (observed.some((value) => value < 0 || !isInteger(value))) H.fail("STAT_INVALID_INPUT", "data.observed must be non-negative integer counts");
    const total = observed.reduce((sum, value) => sum + value, 0);
    if (total < 1) H.fail("STAT_DEGENERATE", "all observed counts are zero");
    let probabilities;
    if (data.expectedProbabilities === undefined) probabilities = categories.map(() => 1 / categories.length);
    else {
      probabilities = H.numericVector(data.expectedProbabilities, "data.expectedProbabilities", 2);
      if (probabilities.length !== categories.length) H.fail("STAT_INVALID_INPUT", "data.expectedProbabilities length must match data.categories");
      if (probabilities.some((value) => value < 0)) H.fail("STAT_INVALID_INPUT", "data.expectedProbabilities must be non-negative");
      const sum = probabilities.reduce((acc, value) => acc + value, 0);
      if (!(sum > 0)) H.fail("STAT_DEGENERATE", "expected probabilities sum to zero");
      if (Math.abs(sum - 1) > 1e-6) H.fail("STAT_INVALID_INPUT", "data.expectedProbabilities must sum to 1");
      probabilities = probabilities.map((value) => value / sum);
      if (probabilities.some((value) => value === 0)) H.fail("STAT_DEGENERATE", "an expected probability of zero makes the chi-square statistic undefined");
    }
    if (categories.length - 1 - options.estimatedParameters < 1) H.fail("STAT_INVALID_INPUT", "options.estimatedParameters leaves no degrees of freedom");
    return { categories, observed, probabilities, total, label: H.label(data.label, "Category", "data.label") };
  },
  analyze(parsed, options, budget, H) {
    const { categories, observed, probabilities, total, label } = parsed;
    const expected = probabilities.map((p) => p * total);
    let chiSquare = 0;
    let g = 0;
    const rows = categories.map((category, index) => {
      budget.check(1);
      const residual = observed[index] - expected[index];
      const pearson = residual / Math.sqrt(expected[index]);
      const standardized = residual / Math.sqrt(expected[index] * (1 - probabilities[index]));
      chiSquare += pearson * pearson;
      if (observed[index] > 0) g += 2 * observed[index] * Math.log(observed[index] / expected[index]);
      return { category, observed: observed[index], expectedProbability: probabilities[index], expected: expected[index], observedProportion: observed[index] / total, pearsonResidual: pearson, standardizedResidual: standardized, contribution: pearson * pearson };
    });
    const df = categories.length - 1 - options.estimatedParameters;
    const pChi = S.chiSquareSurvival(chiSquare, df);
    const pG = S.chiSquareSurvival(g, df);
    const cramerV = Math.sqrt(chiSquare / (total * (categories.length - 1)));
    const smallExpected = expected.filter((value) => value < 5).length;
    const testRows = [
      { test: "Pearson chi-square", statistic: chiSquare, df, pValue: pChi },
      { test: "G (likelihood ratio)", statistic: g, df, pValue: pG },
    ];
    return {
      sample: { categories: categories.length, n: total, df, estimatedParameters: options.estimatedParameters },
      estimates: [
        { name: "Pearson chi-square", kind: "scalar", estimate: chiSquare },
        { name: "G statistic", kind: "scalar", estimate: g },
        { name: "Cramer V (goodness-of-fit form)", kind: "scalar", estimate: cramerV },
        { name: "cells", kind: "rows", rows },
        { name: "tests", kind: "rows", rows: testRows },
      ],
      tests: testRows.map((row) => ({ name: row.test, statistic: row.statistic, distribution: "chi-square", df: row.df, pValue: row.pValue })),
      confidenceIntervals: [],
      effectSizes: [{ name: "Cramer V (goodness-of-fit form)", estimate: cramerV }],
      assumptions: [
        { name: "independent multinomial counts", status: "requires_design_review" },
        { name: "expected counts adequate for the chi-square approximation", status: smallExpected === 0 ? "met" : "not_established", smallExpectedCells: smallExpected, detail: "expected counts below 5 weaken the asymptotic approximation; consider exact multinomial or bootstrap methods" },
        { name: "expected probabilities specified before seeing the data", status: options.estimatedParameters > 0 ? "parameters_estimated_from_data" : "requires_design_review" },
      ],
      diagnostics: [
        { name: "degrees of freedom", status: "evaluated", df, detail: `categories - 1 - estimatedParameters = ${categories.length} - 1 - ${options.estimatedParameters}` },
        { name: "small expected counts", status: smallExpected === 0 ? "none" : "present", count: smallExpected },
        { name: "residual boundary", status: "asymptotic", detail: "standardized residuals divide by sqrt(E (1 - p)); values beyond about 2 in absolute value indicate the cells driving the statistic" },
        { name: "renderer exact-data contract", status: "verified", rows: rows.length, rowsHash: H.sha256(rows) },
      ],
      artifacts: [
        H.tableArtifact("Goodness-of-fit tests", `Pearson and likelihood-ratio tests of the specified probabilities on ${df} df.`, [{ key: "test", label: "Test", type: "string" }, { key: "statistic", label: "Statistic", type: "number" }, { key: "df", label: "df", type: "number" }, { key: "pValue", label: "p", type: "number" }], testRows, [], "chi-square-gof-test-table"),
        H.tableArtifact("Observed and expected counts", "Per-category counts, proportions, residuals, and contributions to the Pearson statistic.", [{ key: "category", label: label, type: "string" }, { key: "observed", label: "Observed", type: "number" }, { key: "expectedProbability", label: "Expected p", type: "number" }, { key: "expected", label: "Expected", type: "number" }, { key: "observedProportion", label: "Observed p", type: "number" }, { key: "pearsonResidual", label: "Pearson residual", type: "number" }, { key: "standardizedResidual", label: "Standardized residual", type: "number" }, { key: "contribution", label: "Contribution", type: "number" }], rows, [], "chi-square-gof-cell-table"),
        H.vegaArtifact("chi-square-gof-plot", "Observed versus expected counts by category", {
          data: { values: rows },
          layer: [
            { mark: { type: "bar", color: "#9DB8D2" }, encoding: { x: { field: "category", type: "nominal", title: label, sort: null }, y: { field: "observed", type: "quantitative", title: "Count" }, tooltip: [{ field: "category" }, { field: "observed" }, { field: "expected", format: ".3f" }, { field: "standardizedResidual", format: ".3f" }] } },
            { mark: { type: "point", filled: true, shape: "diamond", size: 120, color: "#B3261E" }, encoding: { x: { field: "category", type: "nominal", sort: null }, y: { field: "expected", type: "quantitative" } } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When observed category counts must be compared with probabilities fixed by theory, a prior model, or a fitted distribution with a known number of estimated parameters.",
    decision: "Whether the counts depart from the specified probabilities and which categories drive the departure.",
    mustShow: "Pearson and G statistics with df and p, per-category expected counts and standardized residuals, and the observed-versus-expected display.",
    userGoal: "Test a categorical model against counts with the residuals that explain any rejection.",
    nextActions: [
      { trigger: "small-expected-counts", action: "pool-categories-or-use-an-exact-multinomial-test", reason: "The chi-square approximation is unreliable with sparse expected counts." },
      { trigger: "rejected-with-one-dominant-residual", action: "inspect-that-category-before-revising-the-model", reason: "A single category often reflects a coding or measurement issue rather than model failure." },
      { trigger: "probabilities-came-from-a-fitted-distribution", action: "set-estimated-parameters-to-the-number-fitted", reason: "Degrees of freedom must be reduced for parameters estimated from the same counts." },
    ],
  },
  fixture: { data: { categories: ["Mon", "Tue", "Wed", "Thu", "Fri"], observed: [42, 38, 55, 47, 68], label: "weekday" } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.distribution"] },
  coverage: {
    implementedBoundary: "Pearson chi-square and likelihood-ratio G goodness-of-fit tests for one categorical variable against specified probabilities with a degrees-of-freedom correction for estimated parameters; no exact multinomial test.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["Pearson statistic and p against scipy.stats.chisquare", "G statistic and p against scipy.stats.power_divergence", "expected counts and residuals against numpy"], excludedOutputs: ["Cramer V goodness-of-fit form (no scipy reference)"] },
    diagnostic: { level: "method-specific-partial", emitted: ["degrees of freedom", "small expected counts", "residual boundary"], limitations: ["asymptotic p-values only"] },
    knownGaps: ["exact multinomial test", "Monte Carlo p-values", "ordered-category trend alternatives"],
  },
};

// ---------------------------------------------------------------------------------------------
// kernel_density_estimate
// ---------------------------------------------------------------------------------------------

const KERNELS = {
  gaussian: { fn: (u) => Math.exp(-0.5 * u * u) / Math.sqrt(2 * Math.PI), supportRadius: Infinity },
  epanechnikov: { fn: (u) => (Math.abs(u) <= 1 ? 0.75 * (1 - u * u) : 0), supportRadius: 1 },
};

const kernelDensityEstimate = {
  method: "kernel_density_estimate",
  family: FAMILY,
  analysisModel: { families: ["lm"], distributions: [null, "nonparametric"], links: [null, "identity"] },
  optionKeys: ["gridSize", "timeoutMs"],
  customOptions: {
    bandwidth: { schema: { anyOf: [{ type: "number", exclusiveMinimum: 0 }, { type: "string", enum: ["scott", "silverman"] }] }, default: "silverman", parse(value, H, path) { if (value === "scott" || value === "silverman") return value; const number = H.finiteNumber(value, path); if (!(number > 0)) H.fail("STAT_INVALID_INPUT", `${path} must be positive or scott / silverman`); return number; } },
    kernel: { schema: { type: "string", enum: ["gaussian", "epanechnikov"] }, default: "gaussian", parse(value, H, path) { if (!KERNELS[value]) H.fail("STAT_INVALID_INPUT", `${path} must be gaussian or epanechnikov`); return value; } },
    gridPadding: { schema: { type: "number", minimum: 0, maximum: 10 }, default: 3, parse(value, H, path) { const number = H.finiteNumber(value, path); if (number < 0 || number > 10) H.fail("STAT_INVALID_INPUT", `${path} must be in [0, 10]`); return number; } },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["values"],
    properties: {
      values: { type: "array", minItems: 5, maxItems: 20000, items: { type: "number" } },
      evaluationPoints: { type: "array", minItems: 1, maxItems: 1000, items: { type: "number" } },
      label: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["values", "evaluationPoints", "label"], "data");
    const values = H.numericVector(data.values, "data.values", 5);
    if (values.length > 20000) H.fail("STAT_LIMIT_EXCEEDED", "kernel density estimation is limited to 20000 values");
    if (H.minMax(values).min === H.minMax(values).max) H.fail("STAT_DEGENERATE", "all values are identical; the bandwidth is zero");
    const evaluationPoints = data.evaluationPoints === undefined ? [] : H.numericVector(data.evaluationPoints, "data.evaluationPoints", 1);
    if (evaluationPoints.length > 1000) H.fail("STAT_LIMIT_EXCEEDED", "data.evaluationPoints is limited to 1000 entries");
    return { values, evaluationPoints, label: H.label(data.label, "Value", "data.label") };
  },
  analyze(parsed, options, budget, H) {
    const { values, evaluationPoints, label } = parsed;
    const n = values.length;
    const sd = sampleSd(values);
    const sorted = [...values].sort((a, b) => a - b);
    const iqr = H.quantileR7(sorted, 0.75) - H.quantileR7(sorted, 0.25);
    let bandwidth;
    let rule;
    if (options.bandwidth === "scott") { bandwidth = Math.pow(n, -1 / 5) * sd; rule = "Scott: n^(-1/5) x sample SD"; } else if (options.bandwidth === "silverman") { bandwidth = Math.pow(3 * n / 4, -1 / 5) * sd; rule = "Silverman: (3n/4)^(-1/5) x sample SD"; } else { bandwidth = options.bandwidth; rule = "fixed by options.bandwidth"; }
    const robustSilverman = 0.9 * Math.min(sd, iqr / 1.34) * Math.pow(n, -1 / 5);
    const kernel = KERNELS[options.kernel];
    const density = (x) => { let total = 0; for (const value of values) total += kernel.fn((x - value) / bandwidth); return total / (n * bandwidth); };
    const lo = sorted[0] - options.gridPadding * bandwidth;
    const hi = sorted[n - 1] + options.gridPadding * bandwidth;
    const gridRows = Array.from({ length: options.gridSize }, (_, index) => { budget.check(n); const x = lo + (hi - lo) * index / (options.gridSize - 1); return { x, density: density(x) }; });
    let integral = 0;
    for (let index = 1; index < gridRows.length; index += 1) integral += 0.5 * (gridRows[index].density + gridRows[index - 1].density) * (gridRows[index].x - gridRows[index - 1].x);
    const pointRows = evaluationPoints.map((x) => { budget.check(n); return { x, density: density(x) }; });
    const modeRow = gridRows.reduce((best, row) => (best === null || row.density > best.density ? row : best), null);
    const summaryRows = [{ n, kernel: options.kernel, bandwidth, rule, sampleSd: sd, iqr, robustSilvermanBandwidth: robustSilverman, gridSize: options.gridSize, gridLower: lo, gridUpper: hi, integralOverGrid: integral, mode: modeRow.x }];
    return {
      sample: { n, label, kernel: options.kernel, bandwidth, gridSize: options.gridSize },
      estimates: [
        { name: "bandwidth", kind: "scalar", estimate: bandwidth },
        { name: "robust Silverman bandwidth (reference)", kind: "scalar", estimate: robustSilverman },
        { name: "grid mode", kind: "scalar", estimate: modeRow.x },
        { name: "integral over grid", kind: "scalar", estimate: integral },
        { name: "summary", kind: "rows", rows: summaryRows },
        { name: "grid", kind: "rows", rows: gridRows },
        { name: "evaluationPoints", kind: "rows", rows: pointRows },
      ],
      tests: [],
      confidenceIntervals: [],
      effectSizes: [],
      assumptions: [
        { name: "independent identically distributed observations", status: "requires_design_review" },
        { name: "bandwidth rule suits the shape", status: options.bandwidth === "scott" || options.bandwidth === "silverman" ? "normal_reference_rule" : "user_supplied", detail: "normal-reference rules oversmooth multimodal or skewed data; the robust Silverman value is reported for comparison" },
      ],
      diagnostics: [
        { name: "bandwidth", status: "evaluated", rule, bandwidth, detail: "sample SD uses n - 1; the scipy gaussian_kde factor convention is followed for scott / silverman" },
        { name: "grid coverage", status: integral > 0.98 ? "adequate" : "truncated", integralOverGrid: integral, detail: "trapezoid integral of the estimate over the grid; values well below 1 mean the grid padding truncates the tails" },
        { name: "boundary bias", status: "not_corrected", detail: "no reflection or boundary kernel; densities near a hard support edge are biased downward" },
        { name: "renderer exact-data contract", status: "verified", rows: gridRows.length, rowsHash: H.sha256(gridRows) },
      ],
      artifacts: [
        H.tableArtifact("Kernel density summary", `${options.kernel} kernel with ${rule}.`, [{ key: "n", label: "n", type: "number" }, { key: "kernel", label: "Kernel", type: "string" }, { key: "bandwidth", label: "Bandwidth", type: "number" }, { key: "rule", label: "Rule", type: "string" }, { key: "sampleSd", label: "SD", type: "number" }, { key: "iqr", label: "IQR", type: "number" }, { key: "robustSilvermanBandwidth", label: "Robust Silverman", type: "number" }, { key: "gridSize", label: "Grid", type: "number" }, { key: "gridLower", label: "Grid lower", type: "number" }, { key: "gridUpper", label: "Grid upper", type: "number" }, { key: "integralOverGrid", label: "Integral", type: "number" }, { key: "mode", label: "Mode", type: "number" }], summaryRows, [], "kde-summary-table"),
        H.tableArtifact("Kernel density grid", "Density estimate on the evaluation grid.", [{ key: "x", label: label, type: "number" }, { key: "density", label: "Density", type: "number" }], gridRows, [], "kde-grid-table"),
        H.tableArtifact("Density at requested points", "Density estimate at the supplied evaluation points.", [{ key: "x", label: label, type: "number" }, { key: "density", label: "Density", type: "number" }], pointRows, [], "kde-point-table"),
        H.vegaArtifact("kde-density-plot", `Kernel density estimate of ${label} (${options.kernel}, h = ${S.round(bandwidth, 6)})`, {
          data: { values: gridRows },
          mark: { type: "area", color: "#9DB8D2", opacity: 0.6, line: { color: "#285F8F", strokeWidth: 2 } },
          encoding: { x: { field: "x", type: "quantitative", title: label }, y: { field: "density", type: "quantitative", title: "Density" }, tooltip: [{ field: "x", format: ".4g" }, { field: "density", format: ".4g" }] },
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When the shape of a distribution (modes, skew, tails) must be seen without committing to a parametric family, or a smooth density is needed as input to a downstream estimate.",
    decision: "Whether the variable is unimodal or multimodal, how skewed it is, and which bandwidth gives a defensible picture.",
    mustShow: "The bandwidth and the rule that produced it, the density on a grid with its integral, and any requested point evaluations.",
    userGoal: "See the distribution honestly before choosing a model, so the parametric family is picked from the observed shape rather than from convenience.",
    nextActions: [
      { trigger: "multiple-modes", action: "consider-mixture-or-subgroup-analysis", reason: "Multimodality usually signals heterogeneous subpopulations." },
      { trigger: "bandwidth-sensitivity", action: "rerun-with-the-robust-silverman-and-a-fixed-bandwidth", reason: "Features that vanish under modest bandwidth changes are not robust." },
      { trigger: "hard-support-boundary", action: "transform-or-use-boundary-corrected-density-outside-this-plugin", reason: "Uncorrected kernels leak mass across a hard boundary." },
    ],
  },
  fixture: { data: { values: FIXTURE.gammaDraws, evaluationPoints: [2, 4, 8], label: "repair time (h)" }, options: { bandwidth: "silverman", kernel: "gaussian", gridSize: 51 } },
  matlabParity: { taxonomyIds: ["matlab.stats.descriptive-visualization", "matlab.stats.probability-hypothesis"] },
  coverage: {
    implementedBoundary: "Univariate kernel density estimation with Gaussian or Epanechnikov kernels, Scott / Silverman normal-reference or fixed bandwidth, an evaluation grid with trapezoid integral, and point evaluations; no bandwidth cross-validation, no boundary correction.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["bandwidth factor against scipy gaussian_kde (scott and silverman)", "Gaussian-kernel grid densities against scipy gaussian_kde", "Epanechnikov-kernel densities against a numpy formula"], excludedOutputs: ["grid integral (display diagnostic)"] },
    diagnostic: { level: "method-specific-partial", emitted: ["bandwidth", "grid coverage", "boundary bias"], limitations: ["no confidence bands", "normal-reference bandwidths oversmooth multimodal data"] },
    knownGaps: ["cross-validated and plug-in bandwidths", "boundary correction", "bivariate kernel density"],
  },
};

// ---------------------------------------------------------------------------------------------
// empirical_cdf_comparison
// ---------------------------------------------------------------------------------------------

function ecdfStatistics(x, y) {
  const n = x.length;
  const m = y.length;
  const N = n + m;
  const pooled = [...x.map((value) => ({ value, sample: 0 })), ...y.map((value) => ({ value, sample: 1 }))].sort((a, b) => a.value - b.value || a.sample - b.sample);
  // distinct values with per-sample counts
  const distinct = [];
  for (const item of pooled) {
    const last = distinct[distinct.length - 1];
    if (last && last.value === item.value) { last.counts[item.sample] += 1; } else distinct.push({ value: item.value, counts: item.sample === 0 ? [1, 0] : [0, 1] });
  }
  let ks = 0;
  let ksLocation = distinct[0].value;
  let cx = 0;
  let cy = 0;
  const ecdfRows = [];
  for (const point of distinct) {
    cx += point.counts[0];
    cy += point.counts[1];
    const fx = cx / n;
    const fy = cy / m;
    const difference = fx - fy;
    if (Math.abs(difference) > ks) { ks = Math.abs(difference); ksLocation = point.value; }
    ecdfRows.push({ value: point.value, ecdfX: fx, ecdfY: fy, difference });
  }
  // Cramer-von Mises two-sample (Anderson 1962), ranks with ties averaged
  const ranks = new Array(N);
  let position = 0;
  for (const point of distinct) {
    const count = point.counts[0] + point.counts[1];
    const averageRank = position + (count + 1) / 2;
    for (let i = 0; i < count; i += 1) ranks[position + i] = averageRank;
    position += count;
  }
  let sumX = 0;
  let sumY = 0;
  let ix = 0;
  let iy = 0;
  position = 0;
  for (const item of pooled) {
    if (item.sample === 0) { ix += 1; sumX += (ranks[position] - ix) ** 2; } else { iy += 1; sumY += (ranks[position] - iy) ** 2; }
    position += 1;
  }
  const U = n * sumX + m * sumY;
  const cvm = U / (n * m * N) - (4 * n * m - 1) / (6 * N);
  // Anderson-Darling two-sample, Scholz-Stephens midrank version
  let ad = 0;
  let before = 0;
  let belowX = 0;
  let belowY = 0;
  for (const point of distinct) {
    const l = point.counts[0] + point.counts[1];
    const B = before + l / 2;
    const denominator = B * (N - B) - N * l / 4;
    if (denominator > 0) {
      const mx = belowX + point.counts[0] / 2;
      const my = belowY + point.counts[1] / 2;
      ad += l * ((N * mx - n * B) ** 2 / n + (N * my - m * B) ** 2 / m) / denominator;
    }
    before += l;
    belowX += point.counts[0];
    belowY += point.counts[1];
  }
  ad *= (N - 1) / (N * N);
  return { ks, ksLocation, cvm, ad, ecdfRows, ties: distinct.length < N };
}

const empiricalCdfComparison = {
  method: "empirical_cdf_comparison",
  family: FAMILY,
  analysisModel: { families: ["lm"], distributions: [null, "nonparametric"], links: [null, "identity"] },
  optionKeys: ["timeoutMs"],
  customOptions: {
    permutations: { schema: { type: "integer", minimum: 0, maximum: 5000 }, default: 499, parse(value, H, path) { return H.integer(value, 0, 5000, path); } },
    seed: S.seedOption(),
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["x", "y"],
    properties: {
      x: { type: "array", minItems: 4, maxItems: 5000, items: { type: "number" } },
      y: { type: "array", minItems: 4, maxItems: 5000, items: { type: "number" } },
      xLabel: { type: "string", minLength: 1, maxLength: 128 },
      yLabel: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["x", "y", "xLabel", "yLabel"], "data");
    const x = H.numericVector(data.x, "data.x", 4);
    const y = H.numericVector(data.y, "data.y", 4);
    if (x.length > 5000 || y.length > 5000) H.fail("STAT_LIMIT_EXCEEDED", "each sample is limited to 5000 values");
    if (H.minMax([...x, ...y]).min === H.minMax([...x, ...y]).max) H.fail("STAT_DEGENERATE", "all values are identical");
    return { x, y, xLabel: H.label(data.xLabel, "Sample X", "data.xLabel"), yLabel: H.label(data.yLabel, "Sample Y", "data.yLabel") };
  },
  analyze(parsed, options, budget, H) {
    const { x, y, xLabel, yLabel } = parsed;
    const n = x.length;
    const m = y.length;
    const observed = ecdfStatistics(x, y);
    const ksAsymptotic = S.kolmogorovSurvival(observed.ks * Math.sqrt(n * m / (n + m)));
    const rng = S.createRng(options.seed);
    const pooled = [...x, ...y];
    let exceedKs = 0;
    let exceedCvm = 0;
    let exceedAd = 0;
    for (let b = 0; b < options.permutations; b += 1) {
      budget.check((n + m) * 8);
      rng.shuffle(pooled);
      const stats = ecdfStatistics(pooled.slice(0, n), pooled.slice(n));
      if (stats.ks >= observed.ks - 1e-12) exceedKs += 1;
      if (stats.cvm >= observed.cvm - 1e-12) exceedCvm += 1;
      if (stats.ad >= observed.ad - 1e-12) exceedAd += 1;
    }
    const permP = (count) => (options.permutations > 0 ? (1 + count) / (options.permutations + 1) : null);
    const testRows = [
      { test: "Kolmogorov-Smirnov D", statistic: observed.ks, asymptoticPValue: ksAsymptotic, permutationPValue: permP(exceedKs), location: observed.ksLocation },
      { test: "Cramer-von Mises T", statistic: observed.cvm, asymptoticPValue: null, permutationPValue: permP(exceedCvm), location: null },
      { test: "Anderson-Darling A2 (two-sample, midrank)", statistic: observed.ad, asymptoticPValue: null, permutationPValue: permP(exceedAd), location: null },
    ];
    const longRows = [];
    for (const row of observed.ecdfRows) { longRows.push({ value: row.value, sample: xLabel, ecdf: row.ecdfX }); longRows.push({ value: row.value, sample: yLabel, ecdf: row.ecdfY }); }
    const sortedX = [...x].sort((a, b) => a - b);
    const sortedY = [...y].sort((a, b) => a - b);
    const quantileRows = [0.1, 0.25, 0.5, 0.75, 0.9].map((p) => ({ probability: p, quantileX: H.quantileR7(sortedX, p), quantileY: H.quantileR7(sortedY, p), difference: H.quantileR7(sortedY, p) - H.quantileR7(sortedX, p) }));
    return {
      sample: { nX: n, nY: m, xLabel, yLabel, permutations: options.permutations, ties: observed.ties },
      estimates: [
        { name: "KS D", kind: "scalar", estimate: observed.ks },
        { name: "KS location", kind: "scalar", estimate: observed.ksLocation },
        { name: "Cramer-von Mises T", kind: "scalar", estimate: observed.cvm },
        { name: "Anderson-Darling A2", kind: "scalar", estimate: observed.ad },
        { name: "tests", kind: "rows", rows: testRows },
        { name: "ecdf", kind: "rows", rows: observed.ecdfRows },
        { name: "ecdfLong", kind: "rows", rows: longRows },
        { name: "quantiles", kind: "rows", rows: quantileRows },
      ],
      tests: testRows.map((row) => ({ name: row.test, statistic: row.statistic, distribution: row.asymptoticPValue === null ? "permutation" : "Kolmogorov (asymptotic) and permutation", df: null, pValue: row.permutationPValue ?? row.asymptoticPValue, asymptoticPValue: row.asymptoticPValue, permutationPValue: row.permutationPValue })),
      confidenceIntervals: [],
      effectSizes: [{ name: "KS D (maximum ECDF gap)", estimate: observed.ks }, { name: "median difference (Y - X)", estimate: quantileRows[2].difference }],
      assumptions: [
        { name: "independent samples of independent observations", status: "requires_design_review" },
        { name: "continuous distributions (ties)", status: observed.ties ? "ties_present" : "no_ties", detail: observed.ties ? "ties are handled by midranks; the asymptotic KS p is conservative and the permutation p-values remain valid" : "no tied values" },
      ],
      diagnostics: [
        { name: "permutation p-values", status: options.permutations > 0 ? "evaluated" : "disabled", permutations: options.permutations, seed: options.seed, detail: "p = (1 + number of permuted statistics at least as large) / (permutations + 1)" },
        { name: "asymptotic KS boundary", status: "asymptotic", detail: "Kolmogorov limit distribution with the effective sample size n m / (n + m); no exact small-sample distribution" },
        { name: "renderer exact-data contract", status: "verified", rows: longRows.length, rowsHash: H.sha256(longRows), ecdfRowsHash: H.sha256(observed.ecdfRows) },
      ],
      artifacts: [
        H.tableArtifact("Two-sample distribution tests", `Distribution-free comparisons of ${xLabel} (n = ${n}) and ${yLabel} (n = ${m}).`, [{ key: "test", label: "Test", type: "string" }, { key: "statistic", label: "Statistic", type: "number" }, { key: "asymptoticPValue", label: "Asymptotic p", type: "number" }, { key: "permutationPValue", label: "Permutation p", type: "number" }, { key: "location", label: "Location of max gap", type: "number" }], testRows, [], "ecdf-test-table"),
        H.tableArtifact("Empirical CDFs", "Pooled distinct values with the ECDF of each sample and the difference.", [{ key: "value", label: "Value", type: "number" }, { key: "ecdfX", label: `ECDF ${xLabel}`, type: "number" }, { key: "ecdfY", label: `ECDF ${yLabel}`, type: "number" }, { key: "difference", label: "Difference", type: "number" }], observed.ecdfRows, [], "ecdf-table"),
        H.tableArtifact("Empirical CDFs (long format)", "One row per sample per pooled value for the step plot.", [{ key: "value", label: "Value", type: "number" }, { key: "sample", label: "Sample", type: "string" }, { key: "ecdf", label: "ECDF", type: "number" }], longRows, [], "ecdf-long-table"),
        H.tableArtifact("Quantile comparison", "Type-7 sample quantiles of each sample and their difference.", [{ key: "probability", label: "p", type: "number" }, { key: "quantileX", label: xLabel, type: "number" }, { key: "quantileY", label: yLabel, type: "number" }, { key: "difference", label: "Y - X", type: "number" }], quantileRows, [], "ecdf-quantile-table"),
        H.vegaArtifact("ecdf-step-plot", `Empirical CDFs of ${xLabel} and ${yLabel}`, {
          data: { values: longRows },
          mark: { type: "line", interpolate: "step-after", strokeWidth: 2 },
          encoding: { x: { field: "value", type: "quantitative", title: "Value" }, y: { field: "ecdf", type: "quantitative", title: "Empirical CDF" }, color: { field: "sample", type: "nominal", title: "Sample" }, tooltip: [{ field: "sample" }, { field: "value", format: ".4g" }, { field: "ecdf", format: ".3f" }] },
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When two independent samples must be compared as whole distributions rather than by a single location parameter, or when a location test's assumptions are doubtful.",
    decision: "Whether the two distributions differ anywhere (KS, CvM, AD), where the largest ECDF gap sits, and how the quantiles differ.",
    mustShow: "The three statistics with permutation p-values, the ECDF step plot, and the quantile comparison.",
    userGoal: "Compare distributions without assuming normality or equal variance.",
    nextActions: [
      { trigger: "difference-in-tails-only", action: "report-quantile-differences-not-a-location-shift", reason: "A tail difference is not a mean shift and needs a different summary." },
      { trigger: "ties-present", action: "rely-on-permutation-p-values", reason: "Asymptotic KS p-values are conservative with ties." },
      { trigger: "no-difference-detected", action: "check-power-with-the-sample-sizes-before-concluding-equivalence", reason: "Distribution-free tests can have low power for small samples." },
    ],
  },
  fixture: { data: { x: FIXTURE.sampleA, y: FIXTURE.sampleB, xLabel: "control", yLabel: "treatment" }, options: { permutations: 499, seed: 17 } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.distribution"] },
  coverage: {
    implementedBoundary: "Two-sample Kolmogorov-Smirnov (asymptotic and permutation), Cramer-von Mises (Anderson 1962 rank form), and Anderson-Darling (Scholz-Stephens midrank form) statistics with seeded permutation p-values, ECDF rows, and type-7 quantile differences; no k-sample extension.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["KS D and asymptotic p against scipy ks_2samp", "Cramer-von Mises T against scipy cramervonmises_2samp", "Anderson-Darling A2 against scipy anderson_ksamp (un-normalized) and a numpy formula", "ECDF rows against numpy"], excludedOutputs: ["permutation p-values (seeded resampling)", "scipy exact/asymptotic CvM and AD p-values (not implemented here)"] },
    diagnostic: { level: "method-specific-partial", emitted: ["permutation p-values", "asymptotic KS boundary"], limitations: ["no exact small-sample KS distribution", "no confidence band for the ECDF difference"] },
    knownGaps: ["k-sample Anderson-Darling", "exact CvM / AD reference distributions", "ECDF confidence bands"],
  },
};

// ---------------------------------------------------------------------------------------------
// extreme_value_analysis
// ---------------------------------------------------------------------------------------------

function fitGpd(excess, ctx) {
  const n = excess.length;
  const m = mean(excess);
  const v = populationVariance(excess) * n / Math.max(1, n - 1);
  let shape0 = 0;
  let scale0 = m;
  if (v > 0) { shape0 = 0.5 * (1 - m * m / v); scale0 = 0.5 * m * (1 + m * m / v); }
  const logLik = (theta) => {
    const scale = theta[0];
    const shape = theta[1];
    if (!(scale > 0)) return -Infinity;
    let total = 0;
    for (const y of excess) {
      if (Math.abs(shape) < 1e-10) total += -Math.log(scale) - y / scale;
      else {
        const u = 1 + shape * y / scale;
        if (u <= 0) return -Infinity;
        total += -Math.log(scale) - (1 + 1 / shape) * Math.log(u);
      }
    }
    return total;
  };
  const objective = (theta) => { const value = logLik([Math.exp(theta[0]), theta[1]]); return Number.isFinite(value) && Math.abs(theta[1]) <= 5 ? -value : BIG; };
  let best = null;
  for (const startShape of [shape0, 0.1, -0.1]) {
    const result = S.nelderMead(objective, [Math.log(Math.max(scale0, 1e-9)), startShape], { step: [0.2, 0.1], maxIterations: 4000, tolerance: 1e-13, budget: ctx.budget });
    if (result.value >= BIG) continue;
    if (!best || result.value < best.value) best = result;
  }
  if (!best) ctx.H.fail("STAT_NON_CONVERGENCE", "GPD likelihood could not be maximised");
  return { scale: Math.exp(best.x[0]), shape: best.x[1], converged: best.converged, logLikelihood: -best.value, logLik };
}

function gumbelVariate(T) { return -Math.log(-Math.log(1 - 1 / T)); }

const extremeValueAnalysis = {
  method: "extreme_value_analysis",
  family: FAMILY,
  analysisModel: { families: ["lm"], distributions: [null, "gev", "gpd", "gumbel"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    returnPeriods: { schema: { type: "array", minItems: 1, maxItems: 20, items: { type: "number", exclusiveMinimum: 1 } }, default: [2, 5, 10, 20, 50, 100], parse(value, H, path) { if (!Array.isArray(value) || value.length < 1 || value.length > 20) H.fail("STAT_INVALID_INPUT", `${path} must list 1 to 20 return periods`); return value.map((item, index) => { const number = H.finiteNumber(item, `${path}[${index}]`); if (!(number > 1)) H.fail("STAT_INVALID_INPUT", `${path}[${index}] must exceed 1`); return number; }); } },
    threshold: { schema: { type: ["number", "null"] }, default: null, parse(value, H, path) { return value === null ? null : H.finiteNumber(value, path); } },
    observationsPerBlock: { schema: { type: "integer", minimum: 1, maximum: 100000 }, default: 1, parse(value, H, path) { return H.integer(value, 1, 100_000, path); } },
    meanExcessQuantiles: { schema: { type: "integer", minimum: 3, maximum: 40 }, default: 10, parse(value, H, path) { return H.integer(value, 3, 40, path); } },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      blockMaxima: { type: "array", minItems: 8, maxItems: 5000, items: { type: "number" } },
      series: { type: "array", minItems: 20, maxItems: 100000, items: { type: "number" } },
      label: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["blockMaxima", "series", "label"], "data");
    if (data.blockMaxima === undefined && data.series === undefined) H.fail("STAT_INVALID_INPUT", "supply data.blockMaxima, data.series, or both");
    const blockMaxima = data.blockMaxima === undefined ? null : H.numericVector(data.blockMaxima, "data.blockMaxima", 8);
    if (blockMaxima && blockMaxima.length > 5000) H.fail("STAT_LIMIT_EXCEEDED", "data.blockMaxima is limited to 5000 blocks");
    if (blockMaxima && H.minMax(blockMaxima).min === H.minMax(blockMaxima).max) H.fail("STAT_DEGENERATE", "all block maxima are identical");
    const series = data.series === undefined ? null : H.numericVector(data.series, "data.series", 20);
    if (series && H.minMax(series).min === H.minMax(series).max) H.fail("STAT_DEGENERATE", "all series values are identical");
    let threshold = null;
    let thresholdSource = null;
    if (series) {
      const sorted = [...series].sort((a, b) => a - b);
      if (options.threshold === null) { threshold = H.quantileR7(sorted, 0.9); thresholdSource = "default 90th percentile"; } else { threshold = options.threshold; thresholdSource = "options.threshold"; }
      const excess = series.filter((value) => value > threshold);
      if (excess.length < 10) H.fail("STAT_INSUFFICIENT_SAMPLE", "fewer than 10 exceedances above the threshold; lower the threshold or supply more data");
    }
    return { blockMaxima, series, threshold, thresholdSource, label: H.label(data.label, "Value", "data.label") };
  },
  analyze(parsed, options, budget, H) {
    const { blockMaxima, series, threshold, thresholdSource, label } = parsed;
    const ctx = { H, budget, options };
    const z = S.normalQuantile(1 - (1 - options.confidenceLevel) / 2);
    const estimates = [];
    const tests = [];
    const intervals = [];
    const assumptions = [{ name: "independent identically distributed extremes", status: "requires_design_review", detail: "block maxima must come from equal-length independent blocks; exceedances must be declustered" }];
    const diagnostics = [];
    const artifacts = [];
    const effectSizes = [];
    let gevRows = [];
    let empiricalRows = [];
    let gevParameterRows = [];
    if (blockMaxima) {
      const fit = FAMILIES.gev.fit(blockMaxima, ctx);
      const theta = { shape: fit.shape, location: fit.location, scale: fit.scale };
      const logLik = logLikelihood("gev", blockMaxima, theta);
      const gumbel = FAMILIES.gumbel.fit(blockMaxima, ctx);
      const gumbelLogLik = logLikelihood("gumbel", blockMaxima, gumbel);
      const lrt = 2 * (logLik - gumbelLogLik);
      const lrtP = S.chiSquareSurvival(Math.max(0, lrt), 1);
      const ll = (vector) => logLikelihood("gev", blockMaxima, { location: vector[0], scale: vector[1], shape: vector[2] });
      const covariance = observedInformationCovariance(ll, [theta.location, theta.scale, theta.shape], [Math.max(theta.scale, 1e-6), Math.max(theta.scale, 1e-6), 0.1]);
      const seOf = (index) => (covariance ? Math.sqrt(covariance[index][index]) : null);
      gevParameterRows = [
        { parameter: "location", estimate: theta.location, standardError: seOf(0), lower: covariance ? theta.location - z * seOf(0) : null, upper: covariance ? theta.location + z * seOf(0) : null },
        { parameter: "scale", estimate: theta.scale, standardError: seOf(1), lower: covariance ? theta.scale - z * seOf(1) : null, upper: covariance ? theta.scale + z * seOf(1) : null },
        { parameter: "shape", estimate: theta.shape, standardError: seOf(2), lower: covariance ? theta.shape - z * seOf(2) : null, upper: covariance ? theta.shape + z * seOf(2) : null },
      ];
      gevRows = options.returnPeriods.map((T) => {
        budget.check(50);
        const p = 1 - 1 / T;
        const level = FAMILIES.gev.quantile(p, theta);
        let se = null;
        if (covariance) {
          const gradient = numericGradient((vector) => FAMILIES.gev.quantile(p, { location: vector[0], scale: vector[1], shape: vector[2] }), [theta.location, theta.scale, theta.shape], [Math.max(theta.scale, 1e-6), Math.max(theta.scale, 1e-6), 0.1]);
          let variance = 0;
          for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) variance += gradient[i] * covariance[i][j] * gradient[j];
          se = variance > 0 ? Math.sqrt(variance) : null;
        }
        return { returnPeriod: T, exceedanceProbability: 1 / T, gumbelVariate: gumbelVariate(T), returnLevel: level, standardError: se, lower: se === null ? null : level - z * se, upper: se === null ? null : level + z * se };
      });
      const sortedMaxima = [...blockMaxima].sort((a, b) => a - b);
      empiricalRows = sortedMaxima.map((value, index) => { const p = (index + 1) / (sortedMaxima.length + 1); return { rank: index + 1, value, plottingPosition: p, returnPeriod: 1 / (1 - p), gumbelVariate: -Math.log(-Math.log(p)) }; });
      const tailType = theta.shape > 0.05 ? "heavy_upper_tail_frechet" : theta.shape < -0.05 ? "bounded_upper_tail_weibull" : "gumbel_like";
      estimates.push(
        { name: "GEV log-likelihood", kind: "scalar", estimate: logLik },
        { name: "GEV shape", kind: "scalar", estimate: theta.shape },
        { name: "GEV upper endpoint", kind: "scalar", estimate: theta.shape < 0 ? theta.location - theta.scale / theta.shape : null },
        { name: "gevParameters", kind: "rows", rows: gevParameterRows },
        { name: "gevReturnLevels", kind: "rows", rows: gevRows },
        { name: "empiricalReturnPeriods", kind: "rows", rows: empiricalRows },
      );
      tests.push({ name: "likelihood ratio: Gumbel (shape = 0) versus GEV", statistic: lrt, distribution: "chi-square", df: 1, pValue: lrtP });
      intervals.push(...gevParameterRows.filter((row) => row.lower !== null).map((row) => ({ parameter: `GEV ${row.parameter}`, estimate: row.estimate, lower: row.lower, upper: row.upper, level: options.confidenceLevel, method: "Wald from observed information" })));
      intervals.push(...gevRows.filter((row) => row.lower !== null).map((row) => ({ parameter: `${row.returnPeriod}-block return level`, estimate: row.returnLevel, lower: row.lower, upper: row.upper, level: options.confidenceLevel, method: "delta method" })));
      effectSizes.push({ name: "GEV shape", estimate: theta.shape });
      diagnostics.push(
        { name: "GEV maximum likelihood", status: fit.converged ? "converged" : "iteration_limit", blocks: blockMaxima.length, detail: "Nelder-Mead from the Gumbel fit with four shape starts; the best finite optimum is reported" },
        { name: "GEV tail type", status: tailType, shape: theta.shape },
        { name: "GEV uncertainty", status: covariance ? "asymptotic_observed_information" : "not_available", detail: covariance ? "Wald parameter intervals and delta-method return-level intervals; both are symmetric approximations that understate upper uncertainty for long return periods" : "the observed information matrix was not positive definite" },
        { name: "GEV regularity", status: theta.shape > -0.5 ? "regular" : "non_regular", detail: "maximum-likelihood asymptotics require shape > -0.5" },
      );
      artifacts.push(
        H.tableArtifact("GEV parameters (block maxima)", `${Math.round(options.confidenceLevel * 100)}% Wald intervals from the observed information.`, [{ key: "parameter", label: "Parameter", type: "string" }, { key: "estimate", label: "Estimate", type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "lower", label: "Lower", type: "number" }, { key: "upper", label: "Upper", type: "number" }], gevParameterRows, ["Shape > 0: heavy (Frechet) tail; shape < 0: bounded (Weibull) tail; shape = 0: Gumbel."], "evt-gev-parameter-table"),
        H.tableArtifact("GEV return levels", "Return levels per return period (in blocks) with delta-method intervals.", [{ key: "returnPeriod", label: "Return period", type: "number" }, { key: "exceedanceProbability", label: "P(exceed)", type: "number" }, { key: "gumbelVariate", label: "Gumbel variate", type: "number" }, { key: "returnLevel", label: "Return level", type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "lower", label: "Lower", type: "number" }, { key: "upper", label: "Upper", type: "number" }], gevRows, [], "evt-gev-return-level-table"),
        H.tableArtifact("Empirical return periods", "Sorted block maxima with plotting positions i / (n + 1).", [{ key: "rank", label: "Rank", type: "number" }, { key: "value", label: label, type: "number" }, { key: "plottingPosition", label: "Plotting position", type: "number" }, { key: "returnPeriod", label: "Return period", type: "number" }, { key: "gumbelVariate", label: "Gumbel variate", type: "number" }], empiricalRows, [], "evt-empirical-table"),
        H.vegaArtifact("evt-return-level-plot", `Return-level plot (GEV) for ${label}`, {
          layer: [
            { data: { values: gevRows }, mark: { type: "area", color: "#9DB8D2", opacity: 0.35 }, encoding: { x: { field: "gumbelVariate", type: "quantitative", title: "Gumbel variate -log(-log(1 - 1/T))" }, y: { field: "lower", type: "quantitative", title: label }, y2: { field: "upper" } } },
            { data: { values: gevRows }, mark: { type: "line", point: true, color: "#B3261E", strokeWidth: 2 }, encoding: { x: { field: "gumbelVariate", type: "quantitative" }, y: { field: "returnLevel", type: "quantitative" }, tooltip: [{ field: "returnPeriod" }, { field: "returnLevel", format: ".4g" }, { field: "lower", format: ".4g" }, { field: "upper", format: ".4g" }] } },
            { data: { values: empiricalRows }, mark: { type: "point", filled: true, size: 40, color: "#285F8F" }, encoding: { x: { field: "gumbelVariate", type: "quantitative" }, y: { field: "value", type: "quantitative" }, tooltip: [{ field: "rank" }, { field: "value", format: ".4g" }, { field: "returnPeriod", format: ".3g" }] } },
          ],
        }),
      );
    }
    if (series) {
      const excess = series.filter((value) => value > threshold).map((value) => value - threshold);
      const rate = excess.length / series.length;
      const gpd = fitGpd(excess, ctx);
      const gpdCovariance = observedInformationCovariance((vector) => gpd.logLik(vector), [gpd.scale, gpd.shape], [Math.max(gpd.scale, 1e-6), 0.1]);
      const rateVariance = rate * (1 - rate) / series.length;
      const m = options.observationsPerBlock;
      const potLevel = (T, params) => {
        const N = T * m * params[0];
        if (N <= 1) return null;
        return Math.abs(params[2]) < 1e-10 ? threshold + params[1] * Math.log(N) : threshold + (params[1] / params[2]) * (Math.pow(N, params[2]) - 1);
      };
      const potRows = options.returnPeriods.map((T) => {
        budget.check(50);
        const level = potLevel(T, [rate, gpd.scale, gpd.shape]);
        let se = null;
        if (level !== null && gpdCovariance) {
          const gradient = numericGradient((vector) => potLevel(T, vector) ?? level, [rate, gpd.scale, gpd.shape], [Math.max(rate, 1e-4), Math.max(gpd.scale, 1e-6), 0.1]);
          const full = [[rateVariance, 0, 0], [0, gpdCovariance[0][0], gpdCovariance[0][1]], [0, gpdCovariance[1][0], gpdCovariance[1][1]]];
          let variance = 0;
          for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) variance += gradient[i] * full[i][j] * gradient[j];
          se = variance > 0 ? Math.sqrt(variance) : null;
        }
        return { returnPeriod: T, observations: T * m, expectedExceedances: T * m * rate, returnLevel: level, standardError: se, lower: se === null ? null : level - z * se, upper: se === null ? null : level + z * se };
      });
      const sortedSeries = [...series].sort((a, b) => a - b);
      const meanExcessRows = [];
      const quantileGrid = Array.from({ length: options.meanExcessQuantiles }, (_, index) => 0.5 + 0.45 * index / (options.meanExcessQuantiles - 1));
      const candidates = [...new Set([...quantileGrid.map((q) => H.quantileR7(sortedSeries, q)), threshold])].sort((a, b) => a - b);
      for (const u of candidates) {
        budget.check(series.length);
        const above = series.filter((value) => value > u);
        if (above.length < 2) continue;
        const excesses = above.map((value) => value - u);
        meanExcessRows.push({ threshold: u, exceedances: above.length, meanExcess: mean(excesses), standardError: sampleSd(excesses) / Math.sqrt(excesses.length), selected: u === threshold });
      }
      const gpdParameterRows = [
        { parameter: "threshold", estimate: threshold, standardError: null, lower: null, upper: null },
        { parameter: "scale", estimate: gpd.scale, standardError: gpdCovariance ? Math.sqrt(gpdCovariance[0][0]) : null, lower: gpdCovariance ? gpd.scale - z * Math.sqrt(gpdCovariance[0][0]) : null, upper: gpdCovariance ? gpd.scale + z * Math.sqrt(gpdCovariance[0][0]) : null },
        { parameter: "shape", estimate: gpd.shape, standardError: gpdCovariance ? Math.sqrt(gpdCovariance[1][1]) : null, lower: gpdCovariance ? gpd.shape - z * Math.sqrt(gpdCovariance[1][1]) : null, upper: gpdCovariance ? gpd.shape + z * Math.sqrt(gpdCovariance[1][1]) : null },
        { parameter: "exceedance rate", estimate: rate, standardError: Math.sqrt(rateVariance), lower: rate - z * Math.sqrt(rateVariance), upper: rate + z * Math.sqrt(rateVariance) },
      ];
      const exponentialLogLik = excess.reduce((total, y) => total - Math.log(mean(excess)) - y / mean(excess), 0);
      const lrt = 2 * (gpd.logLikelihood - exponentialLogLik);
      estimates.push(
        { name: "GPD log-likelihood", kind: "scalar", estimate: gpd.logLikelihood },
        { name: "GPD shape", kind: "scalar", estimate: gpd.shape },
        { name: "exceedance rate", kind: "scalar", estimate: rate },
        { name: "gpdParameters", kind: "rows", rows: gpdParameterRows },
        { name: "potReturnLevels", kind: "rows", rows: potRows },
        { name: "meanExcess", kind: "rows", rows: meanExcessRows },
      );
      tests.push({ name: "likelihood ratio: exponential (shape = 0) versus GPD", statistic: lrt, distribution: "chi-square", df: 1, pValue: S.chiSquareSurvival(Math.max(0, lrt), 1) });
      intervals.push(...gpdParameterRows.filter((row) => row.lower !== null).map((row) => ({ parameter: `GPD ${row.parameter}`, estimate: row.estimate, lower: row.lower, upper: row.upper, level: options.confidenceLevel, method: row.parameter === "exceedance rate" ? "binomial normal approximation" : "Wald from observed information" })));
      intervals.push(...potRows.filter((row) => row.lower !== null).map((row) => ({ parameter: `${row.returnPeriod}-block POT return level`, estimate: row.returnLevel, lower: row.lower, upper: row.upper, level: options.confidenceLevel, method: "delta method (rate, scale, shape)" })));
      effectSizes.push({ name: "GPD shape", estimate: gpd.shape });
      assumptions.push({ name: "threshold high enough for the GPD limit", status: "requires_design_review", detail: "the mean-excess plot should be approximately linear above the chosen threshold" });
      diagnostics.push(
        { name: "threshold", status: "evaluated", threshold, source: thresholdSource, exceedances: excess.length, rate },
        { name: "GPD maximum likelihood", status: gpd.converged ? "converged" : "iteration_limit", detail: "Nelder-Mead on (log scale, shape) from a moment start" },
        { name: "GPD uncertainty", status: gpdCovariance ? "asymptotic_observed_information" : "not_available", detail: "delta-method return-level intervals treat the exceedance rate as binomial and ignore clustering" },
        { name: "declustering", status: "not_applied", detail: "exceedances are used as supplied; dependent clusters inflate the effective rate" },
      );
      artifacts.push(
        H.tableArtifact("GPD parameters (peaks over threshold)", `${Math.round(options.confidenceLevel * 100)}% Wald intervals; threshold from ${thresholdSource}.`, [{ key: "parameter", label: "Parameter", type: "string" }, { key: "estimate", label: "Estimate", type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "lower", label: "Lower", type: "number" }, { key: "upper", label: "Upper", type: "number" }], gpdParameterRows, [], "evt-gpd-parameter-table"),
        H.tableArtifact("POT return levels", `Return levels per return period of ${m} observation(s) per block using the exceedance rate.`, [{ key: "returnPeriod", label: "Return period", type: "number" }, { key: "observations", label: "Observations", type: "number" }, { key: "expectedExceedances", label: "Expected exceedances", type: "number" }, { key: "returnLevel", label: "Return level", type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "lower", label: "Lower", type: "number" }, { key: "upper", label: "Upper", type: "number" }], potRows, ["Return levels are null when the expected number of exceedances does not exceed one."], "evt-pot-return-level-table"),
        H.tableArtifact("Mean excess", "Mean excess over candidate thresholds (quantile grid plus the selected threshold).", [{ key: "threshold", label: "Threshold", type: "number" }, { key: "exceedances", label: "Exceedances", type: "number" }, { key: "meanExcess", label: "Mean excess", type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "selected", label: "Selected", type: "boolean" }], meanExcessRows, [], "evt-mean-excess-table"),
        H.vegaArtifact("evt-mean-excess-plot", `Mean-excess plot for ${label}`, {
          data: { values: meanExcessRows },
          layer: [
            { mark: { type: "line", point: true, color: "#285F8F" }, encoding: { x: { field: "threshold", type: "quantitative", title: "Threshold" }, y: { field: "meanExcess", type: "quantitative", title: "Mean excess" }, tooltip: [{ field: "threshold", format: ".4g" }, { field: "exceedances" }, { field: "meanExcess", format: ".4g" }] } },
            { mark: { type: "point", filled: true, size: 160, color: "#B3261E" }, encoding: { x: { field: "threshold", type: "quantitative" }, y: { field: "meanExcess", type: "quantitative" }, opacity: { field: "selected", type: "nominal", scale: { domain: [false, true], range: [0, 1] }, legend: null } } },
          ],
        }),
      );
    }
    const primaryRows = blockMaxima ? gevRows : estimates.find((item) => item.name === "potReturnLevels").rows;
    diagnostics.push({ name: "renderer exact-data contract", status: "verified", rows: primaryRows.length, rowsHash: H.sha256(primaryRows) });
    return {
      sample: { blocks: blockMaxima ? blockMaxima.length : 0, seriesLength: series ? series.length : 0, threshold, returnPeriods: options.returnPeriods, label },
      estimates,
      tests,
      confidenceIntervals: intervals,
      effectSizes,
      assumptions,
      diagnostics,
      artifacts,
    };
  },
  linkage: {
    neededWhen: "When design values for rare events (floods, loads, losses, peak demand) must be extrapolated beyond the observed record from block maxima or threshold exceedances.",
    decision: "Which tail type the extremes follow, what return levels correspond to stated return periods, and how uncertain those levels are.",
    mustShow: "GEV or GPD parameters with intervals, the return-level table and plot, the empirical return periods, and the mean-excess plot supporting the threshold.",
    userGoal: "Produce defensible return levels with their uncertainty, so a design value carries the extrapolation risk it actually has.",
    nextActions: [
      { trigger: "shape-interval-includes-zero", action: "report-gumbel-and-gev-levels-side-by-side", reason: "The tail type is not identified; both extrapolations should be shown." },
      { trigger: "mean-excess-nonlinear-above-threshold", action: "raise-the-threshold-and-refit", reason: "The GPD limit is not reached at the current threshold." },
      { trigger: "long-return-periods-relative-to-record", action: "state-the-extrapolation-ratio-and-use-profile-intervals-outside-this-plugin", reason: "Delta-method intervals understate uncertainty far beyond the record length." },
    ],
  },
  fixture: { data: { blockMaxima: FIXTURE.maxima, series: FIXTURE.series, label: "annual peak" }, options: { returnPeriods: [2, 5, 10, 20, 50, 100], observationsPerBlock: 40, confidenceLevel: 0.95 } },
  matlabParity: { taxonomyIds: ["matlab.stats.probability-hypothesis", "matlab.stats.industrial-statistics"] },
  coverage: {
    implementedBoundary: "GEV maximum likelihood on block maxima with Wald / delta-method intervals, a Gumbel likelihood-ratio screen, return levels and empirical return periods; peaks-over-threshold GPD maximum likelihood with a fixed threshold, exceedance-rate return levels, an exponential likelihood-ratio screen, and a mean-excess table; no profile-likelihood intervals, no declustering, no non-stationary models.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["GEV log-likelihood against scipy genextreme fit (objective comparison, shape sign documented)", "GEV return levels at the emitted parameters against scipy genextreme ppf", "GPD log-likelihood against scipy genpareto fit with fixed location (objective comparison)", "mean excess against numpy"], excludedOutputs: ["Wald and delta-method standard errors (no scipy reference)", "likelihood-ratio screens"] },
    diagnostic: { level: "method-specific-partial", emitted: ["GEV maximum likelihood", "GEV tail type", "GEV uncertainty", "GEV regularity", "threshold", "GPD maximum likelihood", "GPD uncertainty", "declustering"], limitations: ["symmetric asymptotic intervals", "threshold choice is not automated"] },
    knownGaps: ["profile-likelihood intervals", "declustering and extremal index", "non-stationary (covariate) extreme-value models", "L-moment estimators"],
  },
};

module.exports = { methods: [distributionFitExtended, probabilityCalculator, chiSquareGoodnessOfFit, kernelDensityEstimate, empiricalCdfComparison, extremeValueAnalysis], FAMILIES };
