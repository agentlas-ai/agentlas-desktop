"use strict";

/**
 * Bayesian family: default-prior Bayes factors and posterior summaries computed by deterministic
 * quadrature (Gauss-Legendre panels, closed-form conjugacy, hypergeometric series, or dense grids).
 * No Monte Carlo and no MCMC: the same request always yields the same result.
 *
 *  - bayesian_t_test           JZS Cauchy-prior Bayes factor (Rouder et al. 2009) + posterior of delta
 *  - bayesian_proportion       Beta-Binomial posterior with a Savage-Dickey Bayes factor
 *  - bayesian_ab_test          two Beta posteriors: P(B > A), expected loss, posterior of the difference
 *  - bayesian_linear_regression Zellner g-prior or normal-inverse-gamma conjugate regression
 *  - bayesian_correlation      Ly et al. (2016) stretched-beta Bayes factor + exact posterior of rho
 *  - bayesian_anova            one-way JZS fixed-effects Bayes factor (Rouder et al. 2012), <= 8 groups
 *  - bayesian_meta_analysis    random-effects model on a 2-D (mu, tau) grid with a half-Cauchy tau prior
 */

const SPD = require("./shared-precision-distributions.cjs");
const NC = require("./power-noncentral.cjs");

const GL_ORDER = 16;
const LOG_2PI = Math.log(2 * Math.PI);
const DEFAULT_GRID = 401;
const MAX_META_STUDIES = 200;
const MAX_ANOVA_GROUPS = 8;

// ---------------------------------------------------------------------------------------------
// option helpers
// ---------------------------------------------------------------------------------------------

function enumOption(values, fallback, name) {
  return {
    schema: { type: "string", enum: [...values] },
    default: fallback,
    parse(value, H, path) {
      if (!values.includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be one of ${values.join(", ")} for ${name}`);
      return value;
    },
  };
}

function positiveOption(fallback, max = 1e6) {
  return {
    schema: { type: "number", exclusiveMinimum: 0, maximum: max },
    default: fallback,
    parse(value, H, path) {
      const number = H.finiteNumber(value, path);
      if (number <= 0 || number > max) H.fail("STAT_INVALID_INPUT", `${path} must be in (0, ${max}]`);
      return number;
    },
  };
}

const gridOption = {
  schema: { type: "integer", minimum: 101, maximum: 2001 },
  default: DEFAULT_GRID,
  parse(value, H, path) {
    return H.integer(value, 101, 2001, path);
  },
};

const rscaleOption = positiveOption(Math.SQRT1_2, 10);

// ---------------------------------------------------------------------------------------------
// numeric helpers
// ---------------------------------------------------------------------------------------------

function logBeta(H, a, b) {
  return H.logGamma(a) + H.logGamma(b) - H.logGamma(a + b);
}

function logBetaPdf(H, x, a, b) {
  if (x <= 0 || x >= 1) return -Infinity;
  return (a - 1) * Math.log(x) + (b - 1) * Math.log1p(-x) - logBeta(H, a, b);
}

function betaCdf(H, x, a, b) {
  return H.regularizedBeta(x, a, b);
}

function betaQuantile(H, p, a, b) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i += 1) {
    const mid = 0.5 * (lo + hi);
    if (mid === lo || mid === hi) break;
    if (betaCdf(H, mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

function cauchyPdf(x, scale) {
  return 1 / (Math.PI * scale * (1 + (x / scale) ** 2));
}

/**
 * log ∫_0^∞ exp(logF(g)) dg via the substitution g = e^u on u ∈ [-40, 40] with Gauss-Legendre panels.
 * Returns the log of the integral (max-shifted for stability).
 */
function logIntegrateOverG(logF, budget, panels = 800) {
  const rule = SPD.gaussLegendre(GL_ORDER);
  const a = -40;
  const b = 40;
  const width = (b - a) / panels;
  const logs = [];
  const weights = [];
  for (let panel = 0; panel < panels; panel += 1) {
    const lo = a + panel * width;
    const center = lo + width / 2;
    const half = width / 2;
    for (let i = 0; i < GL_ORDER; i += 1) {
      if (budget) budget.check();
      const u = center + half * rule.nodes[i];
      const g = Math.exp(u);
      const value = logF(g) + u;
      if (Number.isFinite(value)) {
        logs.push(value);
        weights.push(rule.weights[i] * half);
      }
    }
  }
  let max = -Infinity;
  for (const value of logs) if (value > max) max = value;
  if (!Number.isFinite(max)) return -Infinity;
  let total = 0;
  for (let i = 0; i < logs.length; i += 1) total += weights[i] * Math.exp(logs[i] - max);
  return max + Math.log(total);
}

/** ∫_a^b f(x) dx with Gauss-Legendre panels. */
function integrate(f, a, b, panels, budget) {
  return SPD.integratePanels(f, a, b, panels, GL_ORDER, budget);
}

/** JZS Bayes factor for a t statistic (Rouder et al. 2009, eq. 1), n = effective sample size. */
function jzsLogBf10(t, n, df, r, budget) {
  const logIntegrand = (g) => {
    const k = 1 + n * g * r * r;
    return -0.5 * Math.log(k) - (df + 1) / 2 * Math.log1p(t * t / (k * df)) - 0.5 * LOG_2PI - 1.5 * Math.log(g) - 1 / (2 * g);
  };
  const logNumerator = logIntegrateOverG(logIntegrand, budget);
  const logNull = -(df + 1) / 2 * Math.log1p(t * t / df);
  return logNumerator - logNull;
}

/**
 * Summaries of a density evaluated on a uniform grid: trapezoid normalisation, mean, median, HDI
 * (highest-density set on the grid), and the mass above a threshold.
 */
function gridSummary(H, x, density, level, threshold) {
  const G = x.length;
  const h = x[1] - x[0];
  const weights = x.map((_, i) => (i === 0 || i === G - 1 ? h / 2 : h));
  let mass = 0;
  for (let i = 0; i < G; i += 1) mass += weights[i] * density[i];
  if (!(mass > 0) || !Number.isFinite(mass)) H.fail("STAT_DEGENERATE", "posterior density has no mass on the grid");
  const normalized = density.map((value) => value / mass);
  let mean = 0;
  let second = 0;
  for (let i = 0; i < G; i += 1) {
    mean += weights[i] * normalized[i] * x[i];
    second += weights[i] * normalized[i] * x[i] * x[i];
  }
  const variance = Math.max(0, second - mean * mean);
  const cumulative = new Array(G);
  let running = 0;
  for (let i = 0; i < G; i += 1) {
    running += weights[i] * normalized[i];
    cumulative[i] = running;
  }
  const quantile = (p) => {
    if (p <= cumulative[0]) return x[0];
    for (let i = 1; i < G; i += 1) {
      if (cumulative[i] >= p) {
        const span = cumulative[i] - cumulative[i - 1];
        const fraction = span > 0 ? (p - cumulative[i - 1]) / span : 0;
        return x[i - 1] + fraction * (x[i] - x[i - 1]);
      }
    }
    return x[G - 1];
  };
  const order = normalized.map((value, index) => index).sort((p, q) => normalized[q] - normalized[p] || p - q);
  const included = new Array(G).fill(false);
  let accumulated = 0;
  let lower = Infinity;
  let upper = -Infinity;
  for (const index of order) {
    included[index] = true;
    accumulated += weights[index] * normalized[index];
    if (x[index] < lower) lower = x[index];
    if (x[index] > upper) upper = x[index];
    if (accumulated >= level) break;
  }
  let contiguous = true;
  let seen = false;
  let ended = false;
  for (let i = 0; i < G; i += 1) {
    if (included[i]) {
      if (ended) { contiguous = false; break; }
      seen = true;
    } else if (seen) ended = true;
  }
  let massAbove = 0;
  if (threshold !== null && threshold !== undefined) {
    for (let i = 0; i < G; i += 1) {
      if (x[i] > threshold) massAbove += weights[i] * normalized[i];
      else if (i < G - 1 && x[i + 1] > threshold) {
        // partial cell containing the threshold: linear interpolation of the density
        const fraction = (x[i + 1] - threshold) / h;
        const dAt = normalized[i] + (normalized[i + 1] - normalized[i]) * (1 - fraction);
        massAbove += 0.5 * (dAt + normalized[i + 1]) * (x[i + 1] - threshold) - (i + 1 === G - 1 ? 0 : 0);
        massAbove -= weights[i + 1] * normalized[i + 1] * 0; // keep explicit for readability
        massAbove -= 0; // the next loop iteration adds the full weight of x[i+1]; remove its lower half
        massAbove -= 0.5 * h * normalized[i + 1] * (i + 1 === G - 1 ? 0 : 1) + (i + 1 === G - 1 ? 0.5 * h * normalized[i + 1] : 0) - 0.5 * h * normalized[i + 1];
      }
    }
  }
  return { normalized, weights, mass, mean, sd: Math.sqrt(variance), median: quantile(0.5), quantile, hdiLower: lower, hdiUpper: upper, hdiContiguous: contiguous, included, massAbove: Math.min(1, Math.max(0, massAbove)), massAtEdges: weights[0] * normalized[0] + weights[G - 1] * normalized[G - 1] };
}

function uniformGrid(lo, hi, points) {
  const h = (hi - lo) / (points - 1);
  return Array.from({ length: points }, (_, i) => lo + i * h);
}

/** Uniform grid that contains `anchor` exactly as a grid point. */
function anchoredGrid(lo, hi, points, anchor) {
  const h = (hi - lo) / (points - 1);
  const start = anchor - Math.ceil((anchor - lo) / h) * h;
  const count = Math.ceil((hi - start) / h) + 1;
  return Array.from({ length: count }, (_, i) => start + i * h);
}

/** Gauss hypergeometric 2F1(a, b; c; z) for 0 <= z < 1 by direct series (requires convergence). */
function log2F1Series(H, a, b, c, z, budget) {
  if (z === 0) return 0;
  let term = 1;
  let sum = 1;
  for (let k = 0; k < 200000; k += 1) {
    if (budget) budget.check();
    term *= (a + k) * (b + k) / ((c + k) * (k + 1)) * z;
    sum += term;
    if (Math.abs(term) <= 1e-16 * Math.abs(sum)) return Math.log(sum);
  }
  H.fail("STAT_NON_CONVERGENCE", "hypergeometric series did not converge");
  return NaN;
}

/** log 2F1 with an Euler transformation when c - a - b < 0 so the series converges near z = 1. */
function log2F1(H, a, b, c, z, budget) {
  if (z < 0 || z >= 1) H.fail("STAT_INVALID_INPUT", "hypergeometric argument must lie in [0, 1)");
  if (c - a - b > 0) return log2F1Series(H, a, b, c, z, budget);
  return (c - a - b) * Math.log1p(-z) + log2F1Series(H, c - a, c - b, c, z, budget);
}

function posteriorFigure(H, role, title, rows, xKey, xTitle, nullValue) {
  const layers = [
    { mark: { type: "area", color: "#4c78a8", opacity: 0.35, interpolate: "monotone" }, encoding: { x: { field: xKey, type: "quantitative", title: xTitle }, y: { field: "hdiDensity", type: "quantitative", title: "Density" } } },
    { mark: { type: "line", color: "#4c78a8", strokeWidth: 2, interpolate: "monotone" }, encoding: { x: { field: xKey, type: "quantitative" }, y: { field: "posterior", type: "quantitative" }, tooltip: [{ field: xKey, title: xTitle, format: ".4g" }, { field: "posterior", title: "Posterior density", format: ".4g" }, { field: "prior", title: "Prior density", format: ".4g" }] } },
    { mark: { type: "line", color: "#999999", strokeWidth: 1.5, strokeDash: [4, 3], interpolate: "monotone" }, encoding: { x: { field: xKey, type: "quantitative" }, y: { field: "prior", type: "quantitative" } } },
  ];
  if (nullValue !== null && nullValue !== undefined) {
    layers.push({ mark: { type: "rule", color: "#d62728", strokeWidth: 1.5 }, encoding: { x: { datum: nullValue, type: "quantitative" } } });
  }
  return H.vegaArtifact(role, title, { data: { values: rows }, width: 520, height: 300, layer: layers });
}

function posteriorTable(H, title, caption, rows, xKey, xLabel, role) {
  return H.tableArtifact(title, caption, [
    { key: xKey, label: xLabel, type: "number" },
    { key: "posterior", label: "Posterior density", type: "number" },
    { key: "prior", label: "Prior density", type: "number" },
    { key: "inHdi", label: "Inside HDI", type: "boolean" },
    { key: "hdiDensity", label: "Posterior density inside HDI (0 outside)", type: "number" },
  ], rows, [], role);
}

function densityRows(x, summary, prior, xKey) {
  return x.map((value, i) => ({ [xKey]: value, posterior: summary.normalized[i], prior: prior[i], inHdi: summary.included[i], hdiDensity: summary.included[i] ? summary.normalized[i] : 0 }));
}

function bfInterpretation(bf10) {
  const value = bf10 >= 1 ? bf10 : 1 / bf10;
  const direction = bf10 >= 1 ? "H1" : "H0";
  let strength;
  if (value < 3) strength = "anecdotal";
  else if (value < 10) strength = "moderate";
  else if (value < 30) strength = "strong";
  else if (value < 100) strength = "very strong";
  else strength = "extreme";
  return { favours: direction, strength, scale: "Jeffreys (1961) / Lee & Wagenmakers (2013) thresholds" };
}

function bayesLinkage(kind) {
  return {
    neededWhen: `When the research question about a ${kind} needs graded evidence for or against a null model, or a posterior distribution for the effect rather than a single significance decision.`,
    decision: "Whether the data favour the null or the alternative and by how much, and what range of effect values remains credible after seeing the data under a stated prior.",
    mustShow: "The prior with its scale, the Bayes factor in both directions, the posterior summaries with the highest-density interval, and a prior-versus-posterior figure so the influence of the prior is visible.",
    userGoal: "Report evidence that can support the null as well as the alternative, and document the prior sensitivity of that evidence.",
    nextActions: [
      { trigger: "bayes-factor-anecdotal", action: "collect-more-data-or-report-inconclusive-evidence", reason: "A Bayes factor near 1 means the data barely discriminate the hypotheses; sequential collection is legitimate under Bayesian updating." },
      { trigger: "prior-scale-changes-verdict", action: "report-prior-sensitivity-across-plausible-scales", reason: "When the direction of evidence depends on the prior width the conclusion is a statement about the prior, not the data." },
      { trigger: "posterior-mass-at-grid-edge", action: "widen-the-posterior-grid-and-rerun", reason: "Grid-based posteriors truncate mass beyond the grid; visible edge mass means the summaries are biased." },
      { trigger: "inference-committed", action: "bind-prior-bayes-factor-and-posterior-figure-to-report", reason: "A Bayes factor is uninterpretable without the prior that defines the alternative." },
    ],
  };
}

function coverageTemplate(boundary, verified, excluded, emitted, limitations, gaps) {
  return {
    implementedBoundary: boundary,
    oracle: { level: "external-library-partial", evidence: ["contracts/bayesian-scipy-crosscheck.py"], verifiedOutputs: verified, excludedOutputs: excluded },
    diagnostic: { level: "method-specific-partial", emitted, limitations },
    knownGaps: gaps,
  };
}

function bfEstimates(logBf10) {
  const bf10 = Math.exp(logBf10);
  return [
    { parameter: "bf10", estimate: bf10, role: "derived" },
    { parameter: "bf01", estimate: Math.exp(-logBf10), role: "derived" },
    { parameter: "logBf10", estimate: logBf10, role: "derived" },
    { parameter: "log10Bf10", estimate: logBf10 / Math.LN10, role: "derived" },
    { parameter: "posteriorProbabilityH1", estimate: bf10 / (1 + bf10), role: "derived" },
  ];
}

// ---------------------------------------------------------------------------------------------
// bayesian_t_test
// ---------------------------------------------------------------------------------------------

const bayesianTTest = {
  method: "bayesian_t_test",
  family: "bayesian",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    design: enumOption(["one-sample", "paired", "two-sample"], "two-sample", "bayesian_t_test"),
    rscale: rscaleOption,
    gridPoints: gridOption,
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      groups: { type: "array", minItems: 2, maxItems: 2, items: { type: "object", additionalProperties: false, required: ["values"], properties: { name: { type: "string", minLength: 1, maxLength: 128 }, values: { type: "array", minItems: 2, maxItems: 100000, items: { type: "number" } } } }, description: "two independent groups (design = two-sample)" },
      values: { type: "array", minItems: 2, maxItems: 100000, items: { type: "number" }, description: "single sample (design = one-sample)" },
      x: { type: "array", minItems: 2, maxItems: 100000, items: { type: "number" }, description: "first member of each pair (design = paired)" },
      y: { type: "array", minItems: 2, maxItems: 100000, items: { type: "number" } },
      nullValue: { type: "number", description: "hypothesised mean (one-sample) or mean difference (paired); default 0" },
      outcomeLabel: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["groups", "values", "x", "y", "nullValue", "outcomeLabel"], "data");
    const outcomeLabel = H.label(data.outcomeLabel, "Outcome", "data.outcomeLabel");
    const nullValue = data.nullValue === undefined ? 0 : H.finiteNumber(data.nullValue, "data.nullValue");
    if (options.design === "two-sample") {
      if (data.values !== undefined || data.x !== undefined || data.y !== undefined) H.fail("STAT_INVALID_INPUT", "two-sample design takes data.groups only");
      if (data.nullValue !== undefined && nullValue !== 0) H.fail("STAT_INVALID_INPUT", "data.nullValue must be 0 for the two-sample design");
      if (data.groups === undefined) H.fail("STAT_INVALID_INPUT", "data.groups is required for the two-sample design");
      const groups = H.parseGroups({ groups: data.groups }, 2, 2);
      return { design: "two-sample", groups, nullValue: 0, outcomeLabel };
    }
    if (data.groups !== undefined) H.fail("STAT_INVALID_INPUT", `data.groups is not used by the ${options.design} design`);
    if (options.design === "one-sample") {
      if (data.x !== undefined || data.y !== undefined) H.fail("STAT_INVALID_INPUT", "one-sample design takes data.values only");
      if (data.values === undefined) H.fail("STAT_INVALID_INPUT", "data.values is required for the one-sample design");
      return { design: "one-sample", values: H.numericVector(data.values, "data.values", 2), nullValue, outcomeLabel };
    }
    if (data.values !== undefined) H.fail("STAT_INVALID_INPUT", "paired design takes data.x and data.y");
    if (data.x === undefined || data.y === undefined) H.fail("STAT_INVALID_INPUT", "data.x and data.y are required for the paired design");
    const x = H.numericVector(data.x, "data.x", 2);
    const y = H.numericVector(data.y, "data.y", 2);
    if (x.length !== y.length) H.fail("STAT_INVALID_INPUT", "data.x and data.y must have equal length");
    return { design: "paired", values: x.map((value, i) => value - y[i]), nullValue, outcomeLabel };
  },
  analyze(parsed, options, budget, H) {
    let t;
    let df;
    let nEff;
    let dHat;
    let sampleInfo;
    if (parsed.design === "two-sample") {
      const [a, b] = parsed.groups;
      const n1 = a.values.length;
      const n2 = b.values.length;
      const m1 = H.mean(a.values, budget);
      const m2 = H.mean(b.values, budget);
      const v1 = H.variance(a.values, true, budget);
      const v2 = H.variance(b.values, true, budget);
      const pooled = ((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2);
      if (!(pooled > 0)) H.fail("STAT_DEGENERATE", "pooled variance is zero");
      df = n1 + n2 - 2;
      nEff = n1 * n2 / (n1 + n2);
      t = (m1 - m2) / Math.sqrt(pooled * (1 / n1 + 1 / n2));
      dHat = (m1 - m2) / Math.sqrt(pooled);
      sampleInfo = { design: parsed.design, n1, n2, mean1: m1, mean2: m2, pooledSd: Math.sqrt(pooled) };
    } else {
      const n = parsed.values.length;
      const m = H.mean(parsed.values, budget);
      const v = H.variance(parsed.values, true, budget);
      if (!(v > 0)) H.fail("STAT_DEGENERATE", "sample variance is zero");
      df = n - 1;
      nEff = n;
      t = (m - parsed.nullValue) / Math.sqrt(v / n);
      dHat = (m - parsed.nullValue) / Math.sqrt(v);
      sampleInfo = { design: parsed.design, n, mean: m, sd: Math.sqrt(v), nullValue: parsed.nullValue };
    }
    if (df < 1) H.fail("STAT_INSUFFICIENT_SAMPLE", "at least two observations per sample are required");
    const r = options.rscale;
    const logBf10 = jzsLogBf10(t, nEff, df, r, budget);
    // posterior of delta: p(delta | t) ∝ nct(t; df, delta sqrt(nEff)) x Cauchy(delta; 0, r)
    const seD = Math.sqrt(1 / nEff + dHat * dHat / (2 * df));
    const halfWidth = Math.max(8 * seD, 0.5);
    const grid = anchoredGrid(dHat - halfWidth, dHat + halfWidth, options.gridPoints, 0);
    const logDensity = grid.map((delta) => {
      budget.check(8);
      const pdf = NC.nctPdf(H, t, df, delta * Math.sqrt(nEff));
      return (pdf > 0 ? Math.log(pdf) : -Infinity) + Math.log(cauchyPdf(delta, r));
    });
    const maxLog = Math.max(...logDensity);
    if (!Number.isFinite(maxLog)) H.fail("STAT_DEGENERATE", "posterior of delta underflowed on the grid");
    const density = logDensity.map((value) => Math.exp(value - maxLog));
    const summary = gridSummary(H, grid, density, options.confidenceLevel, 0);
    const prior = grid.map((delta) => cauchyPdf(delta, r));
    const rows = densityRows(grid, summary, prior, "delta");
    const sensitivityScales = [0.5, Math.SQRT1_2, 1, Math.SQRT2].filter((scale) => Math.abs(scale - r) > 1e-9);
    const sensitivity = [{ rscale: r, bf10: Math.exp(logBf10), selected: true }, ...sensitivityScales.map((scale) => ({ rscale: scale, bf10: Math.exp(jzsLogBf10(t, nEff, df, scale, budget)), selected: false }))].sort((p, q) => p.rscale - q.rscale);
    const interpretation = bfInterpretation(Math.exp(logBf10));
    const summaryRows = [
      { quantity: "t statistic", value: t, note: `df = ${df}` },
      { quantity: "effective n", value: nEff, note: parsed.design === "two-sample" ? "n1 n2 / (n1 + n2)" : "n" },
      { quantity: "Cauchy prior scale r", value: r, note: "JZS prior on the standardised effect" },
      { quantity: "BF10", value: Math.exp(logBf10), note: `${interpretation.strength} evidence for ${interpretation.favours}` },
      { quantity: "BF01", value: Math.exp(-logBf10), note: "1 / BF10" },
      { quantity: "posterior mean of delta", value: summary.mean, note: "grid posterior under the Cauchy prior" },
      { quantity: "posterior median of delta", value: summary.median, note: "" },
      { quantity: `${Math.round(options.confidenceLevel * 100)}% HDI lower`, value: summary.hdiLower, note: summary.hdiContiguous ? "highest-density interval" : "non-contiguous highest-density set" },
      { quantity: `${Math.round(options.confidenceLevel * 100)}% HDI upper`, value: summary.hdiUpper, note: "" },
      { quantity: "P(delta > 0 | data)", value: summary.massAbove, note: "" },
      { quantity: "observed Cohen d", value: dHat, note: parsed.design === "two-sample" ? "pooled SD" : "sample SD" },
    ];
    const table = H.tableArtifact("Bayesian t test (JZS prior)", `Bayes factor and posterior of the standardised effect for the ${parsed.design} design.`, [
      { key: "quantity", label: "Quantity", type: "string" },
      { key: "value", label: "Value", type: "number" },
      { key: "note", label: "Note", type: "string" },
    ], summaryRows, ["Bayes factor by Gauss-Legendre quadrature over g = exp(u), u in [-40, 40], 800 panels x 16 nodes"], "bayes-t-summary-table");
    const sensitivityTable = H.tableArtifact("Prior sensitivity", "BF10 across Cauchy prior scales.", [
      { key: "rscale", label: "Prior scale r", type: "number" },
      { key: "bf10", label: "BF10", type: "number" },
      { key: "selected", label: "Selected", type: "boolean" },
    ], sensitivity, [], "bayes-t-sensitivity-table");
    const gridTable = posteriorTable(H, "Posterior of delta", "Prior and posterior density of the standardised effect on the evaluation grid.", rows, "delta", "delta", "bayes-t-posterior-table");
    const figure = posteriorFigure(H, "bayes-t-posterior", `Posterior of the standardised effect (${Math.round(options.confidenceLevel * 100)}% HDI shaded) against the Cauchy(0, ${r.toPrecision(3)}) prior`, rows, "delta", "delta (standardised effect)", 0);
    return {
      sample: { ...sampleInfo, df, effectiveN: nEff, gridPoints: grid.length },
      estimates: [
        { parameter: "t", estimate: t, role: "observed" },
        { parameter: "cohenD", estimate: dHat, role: "observed" },
        ...bfEstimates(logBf10),
        { parameter: "posteriorMeanDelta", estimate: summary.mean, role: "derived" },
        { parameter: "posteriorMedianDelta", estimate: summary.median, role: "derived" },
        { parameter: "posteriorSdDelta", estimate: summary.sd, role: "derived" },
        { parameter: "probabilityDeltaPositive", estimate: summary.massAbove, role: "derived" },
      ],
      tests: [{ name: "JZS Bayes factor t test", statistic: t, df, bf10: Math.exp(logBf10), bf01: Math.exp(-logBf10), priorScale: r, interpretation }],
      confidenceIntervals: [{ parameter: "delta", level: options.confidenceLevel, lower: summary.hdiLower, upper: summary.hdiUpper, method: "highest-density interval on the posterior grid" }],
      effectSizes: [{ name: "Cohen d (observed)", estimate: dHat }, { name: "posterior mean delta", estimate: summary.mean }],
      assumptions: [
        { name: "normal populations with equal variance", status: "requires_design_review", detail: parsed.design === "two-sample" ? "the JZS two-sample model uses a pooled variance" : "the JZS model assumes normal observations" },
        { name: "independent observations", status: "requires_design_review" },
        { name: "Cauchy prior on the standardised effect", status: "stated", scale: r },
      ],
      diagnostics: [
        { name: "quadrature", status: "deterministic", detail: "Gauss-Legendre panels on g = exp(u); no Monte Carlo error", panels: 800, order: GL_ORDER },
        { name: "posterior grid", status: summary.massAtEdges > 1e-4 ? "mass_at_grid_edge" : "contained", gridPoints: grid.length, edgeMass: summary.massAtEdges, hdiContiguous: summary.hdiContiguous },
        { name: "prior sensitivity", status: sensitivity.every((row) => (row.bf10 >= 1) === (Math.exp(logBf10) >= 1)) ? "direction_stable" : "direction_depends_on_prior", scales: sensitivity.map((row) => row.rscale) },
      ],
      artifacts: [table, sensitivityTable, gridTable, figure],
    };
  },
  linkage: bayesLinkage("mean or mean difference"),
  fixture: { data: { groups: [{ name: "control", values: [23.1, 25.4, 22.8, 26.7, 24.3, 21.9, 25.8, 23.6, 24.9, 22.4] }, { name: "treatment", values: [27.2, 29.5, 26.1, 30.4, 28.3, 25.7, 29.9, 27.6, 28.8, 31.2] }], outcomeLabel: "Score" }, options: { design: "two-sample", rscale: 0.7071067811865476, confidenceLevel: 0.95 } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.location"] },
  coverage: coverageTemplate(
    "JZS (Cauchy-prior) Bayes factor for one-sample, paired and pooled-variance two-sample t tests by deterministic quadrature, with a grid posterior of the standardised effect under the same prior.",
    ["BF10 against pingouin.bayesfactor_ttest (scipy quad) for all three designs and several prior scales", "posterior mean, median and HDI against a scipy nct x cauchy grid posterior"],
    ["one-sided (directional) Bayes factors", "unequal-variance (Welch-type) Bayesian t test"],
    ["quadrature scheme", "posterior grid containment and HDI contiguity", "prior-scale sensitivity direction"],
    ["does not test normality or variance homogeneity"],
    ["no directional or interval-null Bayes factors", "no informed (non-Cauchy) priors"],
  ),
};

// ---------------------------------------------------------------------------------------------
// bayesian_proportion
// ---------------------------------------------------------------------------------------------

function betaHdi(H, a, b, level) {
  if (a <= 1 && b <= 1) return { lower: betaQuantile(H, (1 - level) / 2, a, b), upper: betaQuantile(H, 1 - (1 - level) / 2, a, b), status: "equal_tailed_fallback" };
  if (a <= 1) return { lower: 0, upper: betaQuantile(H, level, a, b), status: "one_sided_at_zero" };
  if (b <= 1) return { lower: betaQuantile(H, 1 - level, a, b), upper: 1, status: "one_sided_at_one" };
  const mode = (a - 1) / (a + b - 2);
  const upperFor = (lower) => {
    const target = betaCdf(H, lower, a, b) + level;
    if (target >= 1) return 1;
    let lo = mode;
    let hi = 1;
    for (let i = 0; i < 100; i += 1) {
      const mid = 0.5 * (lo + hi);
      if (betaCdf(H, mid, a, b) < target) lo = mid;
      else hi = mid;
    }
    return 0.5 * (lo + hi);
  };
  let lo = 0;
  let hi = mode;
  for (let i = 0; i < 100; i += 1) {
    const mid = 0.5 * (lo + hi);
    const upper = upperFor(mid);
    const fl = logBetaPdf(H, mid, a, b);
    const fu = logBetaPdf(H, upper, a, b);
    if (upper >= 1 || fl < fu) lo = mid;
    else hi = mid;
  }
  const lower = 0.5 * (lo + hi);
  return { lower, upper: upperFor(lower), status: "exact_unimodal" };
}

const priorAlphaOption = positiveOption(1, 1e6);
const priorBetaOption = positiveOption(1, 1e6);

const bayesianProportion = {
  method: "bayesian_proportion",
  family: "bayesian",
  analysisModel: { families: ["glm"], distributions: [null, "binomial", "bernoulli"], links: [null, "logit", "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    priorAlpha: priorAlphaOption,
    priorBeta: priorBetaOption,
    gridPoints: gridOption,
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["successes", "trials"],
    properties: {
      successes: { type: "integer", minimum: 0, maximum: 100000000 },
      trials: { type: "integer", minimum: 1, maximum: 100000000 },
      nullValue: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1, description: "point null for the Savage-Dickey Bayes factor; default 0.5" },
      label: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["successes", "trials", "nullValue", "label"], "data");
    const trials = H.integer(data.trials, 1, 100000000, "data.trials");
    const successes = H.integer(data.successes, 0, trials, "data.successes");
    const nullValue = data.nullValue === undefined ? 0.5 : H.finiteNumber(data.nullValue, "data.nullValue");
    if (nullValue <= 0 || nullValue >= 1) H.fail("STAT_INVALID_INPUT", "data.nullValue must be strictly inside (0, 1)");
    return { successes, trials, nullValue, label: H.label(data.label, "Proportion", "data.label") };
  },
  analyze(parsed, options, budget, H) {
    const a0 = options.priorAlpha;
    const b0 = options.priorBeta;
    const a = a0 + parsed.successes;
    const b = b0 + parsed.trials - parsed.successes;
    const level = options.confidenceLevel;
    const mean = a / (a + b);
    const variance = a * b / ((a + b) ** 2 * (a + b + 1));
    const mode = a > 1 && b > 1 ? (a - 1) / (a + b - 2) : null;
    const median = betaQuantile(H, 0.5, a, b);
    const etLower = betaQuantile(H, (1 - level) / 2, a, b);
    const etUpper = betaQuantile(H, 1 - (1 - level) / 2, a, b);
    const hdi = betaHdi(H, a, b, level);
    const logPosteriorAtNull = logBetaPdf(H, parsed.nullValue, a, b);
    const logPriorAtNull = logBetaPdf(H, parsed.nullValue, a0, b0);
    const logBf01 = logPosteriorAtNull - logPriorAtNull;
    const logBf10 = -logBf01;
    const pAbove = 1 - betaCdf(H, parsed.nullValue, a, b);
    const grid = uniformGrid(0, 1, options.gridPoints);
    const posteriorDensity = grid.map((p) => { const v = logBetaPdf(H, p, a, b); return Number.isFinite(v) ? Math.exp(v) : 0; });
    const priorDensity = grid.map((p) => { const v = logBetaPdf(H, p, a0, b0); return Number.isFinite(v) ? Math.exp(v) : 0; });
    const rows = grid.map((p, i) => {
      const inHdi = p >= hdi.lower && p <= hdi.upper;
      return { p, posterior: posteriorDensity[i], prior: priorDensity[i], inHdi, hdiDensity: inHdi ? posteriorDensity[i] : 0 };
    });
    const interpretation = bfInterpretation(Math.exp(logBf10));
    const summaryRows = [
      { quantity: "successes", value: parsed.successes, note: `of ${parsed.trials} trials` },
      { quantity: "prior Beta alpha", value: a0, note: "" },
      { quantity: "prior Beta beta", value: b0, note: "" },
      { quantity: "posterior Beta alpha", value: a, note: "alpha + successes" },
      { quantity: "posterior Beta beta", value: b, note: "beta + failures" },
      { quantity: "posterior mean", value: mean, note: "" },
      { quantity: "posterior median", value: median, note: "" },
      { quantity: "posterior SD", value: Math.sqrt(variance), note: "" },
      { quantity: `${Math.round(level * 100)}% HDI lower`, value: hdi.lower, note: hdi.status },
      { quantity: `${Math.round(level * 100)}% HDI upper`, value: hdi.upper, note: hdi.status },
      { quantity: `${Math.round(level * 100)}% equal-tailed lower`, value: etLower, note: "" },
      { quantity: `${Math.round(level * 100)}% equal-tailed upper`, value: etUpper, note: "" },
      { quantity: `P(p > ${parsed.nullValue})`, value: pAbove, note: "" },
      { quantity: "BF10 (Savage-Dickey)", value: Math.exp(logBf10), note: `${interpretation.strength} evidence for ${interpretation.favours}; prior density / posterior density at the null` },
      { quantity: "BF01 (Savage-Dickey)", value: Math.exp(logBf01), note: "" },
    ];
    const table = H.tableArtifact("Bayesian proportion (Beta-Binomial)", `Posterior for ${parsed.label} with a Beta(${a0}, ${b0}) prior and a Savage-Dickey Bayes factor at p = ${parsed.nullValue}.`, [
      { key: "quantity", label: "Quantity", type: "string" },
      { key: "value", label: "Value", type: "number" },
      { key: "note", label: "Note", type: "string" },
    ], summaryRows, [], "bayes-proportion-summary-table");
    const gridTable = posteriorTable(H, "Posterior of p", "Prior and posterior density on the evaluation grid.", rows, "p", "p", "bayes-proportion-posterior-table");
    const figure = posteriorFigure(H, "bayes-proportion-posterior", `Beta(${a.toPrecision(4)}, ${b.toPrecision(4)}) posterior for ${parsed.label} (${Math.round(level * 100)}% HDI shaded)`, rows, "p", "p", parsed.nullValue);
    return {
      sample: { successes: parsed.successes, trials: parsed.trials, observedProportion: parsed.successes / parsed.trials, nullValue: parsed.nullValue },
      estimates: [
        { parameter: "posteriorAlpha", estimate: a, role: "derived" },
        { parameter: "posteriorBeta", estimate: b, role: "derived" },
        { parameter: "posteriorMean", estimate: mean, role: "derived" },
        { parameter: "posteriorMedian", estimate: median, role: "derived" },
        { parameter: "posteriorMode", estimate: mode === null ? null : mode, role: mode === null ? "undefined" : "derived" },
        { parameter: "posteriorSd", estimate: Math.sqrt(variance), role: "derived" },
        { parameter: "probabilityAboveNull", estimate: pAbove, role: "derived" },
        ...bfEstimates(logBf10),
      ].filter((row) => row.estimate !== null),
      tests: [{ name: "Savage-Dickey Bayes factor for p = null", nullValue: parsed.nullValue, bf10: Math.exp(logBf10), bf01: Math.exp(logBf01), interpretation }],
      confidenceIntervals: [
        { parameter: "p", level, lower: hdi.lower, upper: hdi.upper, method: `highest-density interval (${hdi.status})` },
        { parameter: "p", level, lower: etLower, upper: etUpper, method: "equal-tailed credible interval" },
      ],
      effectSizes: [{ name: "posterior mean minus null", estimate: mean - parsed.nullValue }],
      assumptions: [
        { name: "independent Bernoulli trials with a common p", status: "requires_design_review" },
        { name: "Beta prior", status: "stated", alpha: a0, beta: b0 },
      ],
      diagnostics: [
        { name: "Savage-Dickey ratio", status: "exact_under_conjugacy", detail: "posterior and prior densities evaluated in closed form at the null" },
        { name: "HDI", status: hdi.status, detail: hdi.status === "exact_unimodal" ? "nested bisection on equal density heights" : "density is not unimodal on the interior; bound taken at the support edge or equal-tailed" },
        { name: "prior influence", status: a0 + b0 > parsed.trials ? "prior_dominates" : "data_dominate", priorWeight: (a0 + b0) / (a0 + b0 + parsed.trials) },
      ],
      artifacts: [table, gridTable, figure],
    };
  },
  linkage: bayesLinkage("single proportion"),
  fixture: { data: { successes: 27, trials: 40, nullValue: 0.5, label: "Success rate" }, options: { priorAlpha: 1, priorBeta: 1, confidenceLevel: 0.95 } },
  matlabParity: { taxonomyIds: ["matlab.stats.probability-hypothesis"] },
  coverage: coverageTemplate(
    "Conjugate Beta-Binomial posterior with equal-tailed and highest-density intervals, posterior tail probability at a point null, and the Savage-Dickey density-ratio Bayes factor.",
    ["posterior mean, median, quantiles and tail probability against scipy.stats.beta", "Savage-Dickey BF against scipy.stats.beta densities", "HDI against a scipy.optimize root search on equal density heights"],
    ["Bayes factors with interval nulls", "hierarchical or overdispersed binomials"],
    ["HDI construction status", "prior weight relative to the data"],
    ["does not diagnose overdispersion or trial dependence"],
    ["no interval-null Bayes factor", "no informed non-Beta priors"],
  ),
};

// ---------------------------------------------------------------------------------------------
// bayesian_ab_test
// ---------------------------------------------------------------------------------------------

const bayesianAbTest = {
  method: "bayesian_ab_test",
  family: "bayesian",
  analysisModel: { families: ["glm"], distributions: [null, "binomial", "bernoulli"], links: [null, "logit", "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    priorAlpha: priorAlphaOption,
    priorBeta: priorBetaOption,
    gridPoints: gridOption,
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["variants"],
    properties: {
      variants: { type: "array", minItems: 2, maxItems: 2, items: { type: "object", additionalProperties: false, required: ["successes", "trials"], properties: { name: { type: "string", minLength: 1, maxLength: 128 }, successes: { type: "integer", minimum: 0, maximum: 100000000 }, trials: { type: "integer", minimum: 1, maximum: 100000000 } } } },
      label: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["variants", "label"], "data");
    if (!Array.isArray(data.variants) || data.variants.length !== 2) H.fail("STAT_INVALID_INPUT", "data.variants must contain exactly two variants");
    const names = new Set();
    const variants = data.variants.map((raw, index) => {
      const item = H.assertObject(raw, `data.variants[${index}]`);
      H.assertKeys(item, ["name", "successes", "trials"], `data.variants[${index}]`);
      const name = H.label(item.name, index === 0 ? "A" : "B", `data.variants[${index}].name`);
      if (names.has(name)) H.fail("STAT_INVALID_INPUT", `duplicate variant name: ${name}`);
      names.add(name);
      const trials = H.integer(item.trials, 1, 100000000, `data.variants[${index}].trials`);
      const successes = H.integer(item.successes, 0, trials, `data.variants[${index}].successes`);
      return { name, successes, trials };
    });
    return { variants, label: H.label(data.label, "Conversion", "data.label") };
  },
  analyze(parsed, options, budget, H) {
    const [A, B] = parsed.variants;
    const aA = options.priorAlpha + A.successes;
    const bA = options.priorBeta + A.trials - A.successes;
    const aB = options.priorAlpha + B.successes;
    const bB = options.priorBeta + B.trials - B.successes;
    const pdfA = (x) => { const v = logBetaPdf(H, x, aA, bA); return Number.isFinite(v) ? Math.exp(v) : 0; };
    const pdfB = (x) => { const v = logBetaPdf(H, x, aB, bB); return Number.isFinite(v) ? Math.exp(v) : 0; };
    const panels = 400;
    // P(B > A) = ∫ f_B(y) F_A(y) dy
    const probBGreater = integrate((y) => pdfB(y) * betaCdf(H, y, aA, bA), 0, 1, panels, budget);
    const probAGreater = 1 - probBGreater;
    // expected loss of choosing B = E[max(pA - pB, 0)] = ∫ f_B(y) [ m_A (1 - F_{A+}(y)) - y (1 - F_A(y)) ] dy
    const meanA = aA / (aA + bA);
    const meanB = aB / (aB + bB);
    const lossB = integrate((y) => pdfB(y) * (meanA * (1 - betaCdf(H, y, aA + 1, bA)) - y * (1 - betaCdf(H, y, aA, bA))), 0, 1, panels, budget);
    const lossA = integrate((x) => pdfA(x) * (meanB * (1 - betaCdf(H, x, aB + 1, bB)) - x * (1 - betaCdf(H, x, aB, bB))), 0, 1, panels, budget);
    // posterior of the difference d = pB - pA on a grid: f_D(d) = ∫ f_B(x) f_A(x - d) dx
    const varA = aA * bA / ((aA + bA) ** 2 * (aA + bA + 1));
    const varB = aB * bB / ((aB + bB) ** 2 * (aB + bB + 1));
    const sdD = Math.sqrt(varA + varB);
    const meanD = meanB - meanA;
    const lo = Math.max(-1, meanD - 8 * sdD);
    const hi = Math.min(1, meanD + 8 * sdD);
    const grid = anchoredGrid(lo, hi, options.gridPoints, 0).filter((d) => d > -1 && d < 1);
    const density = grid.map((d) => {
      budget.check(GL_ORDER * 64);
      const xLo = Math.max(0, d);
      const xHi = Math.min(1, 1 + d);
      if (xHi <= xLo) return 0;
      return integrate((x) => pdfB(x) * pdfA(x - d), xLo, xHi, 64, null);
    });
    const summary = gridSummary(H, grid, density, options.confidenceLevel, 0);
    const rows = grid.map((d, i) => ({ difference: d, posterior: summary.normalized[i], prior: 0, inHdi: summary.included[i], hdiDensity: summary.included[i] ? summary.normalized[i] : 0 }));
    const relativeLift = meanA > 0 ? meanD / meanA : null;
    const summaryRows = [
      { quantity: `${A.name} successes / trials`, value: A.successes / A.trials, note: `${A.successes} / ${A.trials}` },
      { quantity: `${B.name} successes / trials`, value: B.successes / B.trials, note: `${B.successes} / ${B.trials}` },
      { quantity: `${A.name} posterior mean`, value: meanA, note: `Beta(${aA}, ${bA})` },
      { quantity: `${B.name} posterior mean`, value: meanB, note: `Beta(${aB}, ${bB})` },
      { quantity: `P(${B.name} > ${A.name})`, value: probBGreater, note: "Gauss-Legendre quadrature of f_B F_A" },
      { quantity: `P(${A.name} > ${B.name})`, value: probAGreater, note: "" },
      { quantity: `expected loss if ${B.name} chosen`, value: lossB, note: "E[max(pA - pB, 0)]" },
      { quantity: `expected loss if ${A.name} chosen`, value: lossA, note: "E[max(pB - pA, 0)]" },
      { quantity: "posterior mean difference (B - A)", value: summary.mean, note: "grid posterior" },
      { quantity: "posterior median difference", value: summary.median, note: "" },
      { quantity: `${Math.round(options.confidenceLevel * 100)}% HDI lower`, value: summary.hdiLower, note: summary.hdiContiguous ? "" : "non-contiguous" },
      { quantity: `${Math.round(options.confidenceLevel * 100)}% HDI upper`, value: summary.hdiUpper, note: "" },
      ...(relativeLift === null ? [] : [{ quantity: "relative lift of posterior means", value: relativeLift, note: "(mean_B - mean_A) / mean_A" }]),
    ];
    const table = H.tableArtifact("Bayesian A/B test", `Beta-Binomial comparison of ${B.name} against ${A.name} for ${parsed.label} with Beta(${options.priorAlpha}, ${options.priorBeta}) priors.`, [
      { key: "quantity", label: "Quantity", type: "string" },
      { key: "value", label: "Value", type: "number" },
      { key: "note", label: "Note", type: "string" },
    ], summaryRows, [], "bayes-ab-summary-table");
    const gridTable = posteriorTable(H, "Posterior of the difference", "Posterior density of p_B - p_A on the evaluation grid (prior column is 0: the implied prior of the difference is not tabulated).", rows, "difference", "p_B - p_A", "bayes-ab-posterior-table");
    const figure = H.vegaArtifact("bayes-ab-posterior", `Posterior of ${B.name} - ${A.name} (${Math.round(options.confidenceLevel * 100)}% HDI shaded)`, {
      data: { values: rows },
      width: 520,
      height: 300,
      layer: [
        { mark: { type: "area", color: "#4c78a8", opacity: 0.35, interpolate: "monotone" }, encoding: { x: { field: "difference", type: "quantitative", title: "p_B - p_A" }, y: { field: "hdiDensity", type: "quantitative", title: "Density" } } },
        { mark: { type: "line", color: "#4c78a8", strokeWidth: 2, interpolate: "monotone" }, encoding: { x: { field: "difference", type: "quantitative" }, y: { field: "posterior", type: "quantitative" }, tooltip: [{ field: "difference", title: "Difference", format: ".4g" }, { field: "posterior", title: "Density", format: ".4g" }] } },
        { mark: { type: "rule", color: "#d62728", strokeWidth: 1.5 }, encoding: { x: { datum: 0, type: "quantitative" } } },
      ],
    });
    return {
      sample: { variants: parsed.variants.map((v) => ({ name: v.name, successes: v.successes, trials: v.trials })), gridPoints: grid.length },
      estimates: [
        { parameter: `posteriorMean:${A.name}`, estimate: meanA, role: "derived" },
        { parameter: `posteriorMean:${B.name}`, estimate: meanB, role: "derived" },
        { parameter: "probabilityBGreater", estimate: probBGreater, role: "derived" },
        { parameter: "probabilityAGreater", estimate: probAGreater, role: "derived" },
        { parameter: "expectedLossChoosingB", estimate: lossB, role: "derived" },
        { parameter: "expectedLossChoosingA", estimate: lossA, role: "derived" },
        { parameter: "posteriorMeanDifference", estimate: summary.mean, role: "derived" },
        { parameter: "posteriorMedianDifference", estimate: summary.median, role: "derived" },
        { parameter: "posteriorSdDifference", estimate: summary.sd, role: "derived" },
        { parameter: "gridProbabilityBGreater", estimate: summary.massAbove, role: "derived" },
        ...(relativeLift === null ? [] : [{ parameter: "relativeLift", estimate: relativeLift, role: "derived" }]),
      ],
      tests: [{ name: "posterior probability that B beats A", probability: probBGreater, expectedLossB: lossB, expectedLossA: lossA, method: "Gauss-Legendre quadrature over Beta posteriors" }],
      confidenceIntervals: [{ parameter: "difference", level: options.confidenceLevel, lower: summary.hdiLower, upper: summary.hdiUpper, method: "highest-density interval on the posterior grid" }],
      effectSizes: [{ name: "posterior mean difference (B - A)", estimate: summary.mean }, ...(relativeLift === null ? [] : [{ name: "relative lift", estimate: relativeLift }])],
      assumptions: [
        { name: "independent Bernoulli trials within each variant", status: "requires_design_review" },
        { name: "independent variants", status: "requires_design_review" },
        { name: "Beta priors", status: "stated", alpha: options.priorAlpha, beta: options.priorBeta },
      ],
      diagnostics: [
        { name: "quadrature", status: "deterministic", detail: "P(B > A) and expected losses by 400 Gauss-Legendre panels; difference density by 64 panels per grid point", panels },
        { name: "grid consistency", status: Math.abs(summary.massAbove - probBGreater) < 1e-3 ? "consistent" : "grid_mass_deviates", detail: "P(B > A) from the difference grid versus the direct quadrature", gridProbability: summary.massAbove, directProbability: probBGreater },
        { name: "posterior grid", status: summary.massAtEdges > 1e-4 ? "mass_at_grid_edge" : "contained", gridPoints: grid.length, edgeMass: summary.massAtEdges },
      ],
      artifacts: [table, gridTable, figure],
    };
  },
  linkage: bayesLinkage("two-variant conversion comparison"),
  fixture: { data: { variants: [{ name: "A", successes: 48, trials: 500 }, { name: "B", successes: 63, trials: 500 }], label: "Conversion" }, options: { priorAlpha: 1, priorBeta: 1, confidenceLevel: 0.95 } },
  matlabParity: { taxonomyIds: ["matlab.stats.probability-hypothesis"] },
  coverage: coverageTemplate(
    "Two independent Beta-Binomial posteriors with the probability that one variant beats the other, expected loss of each choice, and a grid posterior of the difference with a highest-density interval.",
    ["P(B > A) and expected losses against scipy.integrate.quad over scipy.stats.beta", "difference-grid density against numpy quadrature on the identical grid", "HDI bounds against the identical grid algorithm in numpy"],
    ["more than two variants", "continuous outcomes"],
    ["quadrature scheme", "grid-versus-direct consistency of P(B > A)", "posterior grid containment"],
    ["does not model traffic allocation or sequential peeking"],
    ["no multi-armed comparison", "no revenue or continuous-outcome A/B model"],
  ),
};

// ---------------------------------------------------------------------------------------------
// bayesian_linear_regression
// ---------------------------------------------------------------------------------------------

function parseNumericRegression(H, data, minRows) {
  H.assertKeys(data, ["y", "predictors", "outcomeLabel"], "data");
  const y = H.numericVector(data.y, "data.y", minRows);
  if (!Array.isArray(data.predictors) || data.predictors.length < 1 || data.predictors.length > 48) H.fail("STAT_INVALID_INPUT", "data.predictors must hold between 1 and 48 predictors");
  const names = new Set();
  const predictors = data.predictors.map((raw, index) => {
    const item = H.assertObject(raw, `data.predictors[${index}]`);
    H.assertKeys(item, ["name", "values"], `data.predictors[${index}]`);
    const name = H.label(item.name, `x${index + 1}`, `data.predictors[${index}].name`);
    if (names.has(name)) H.fail("STAT_INVALID_INPUT", `duplicate predictor name: ${name}`);
    names.add(name);
    const values = H.numericVector(item.values, `data.predictors[${index}].values`, minRows);
    if (values.length !== y.length) H.fail("STAT_INVALID_INPUT", `data.predictors[${index}].values must match data.y length`);
    return { name, values };
  });
  if (y.length <= predictors.length + 2) H.fail("STAT_INSUFFICIENT_SAMPLE", "at least p + 3 observations are required");
  return { y, predictors, outcomeLabel: H.label(data.outcomeLabel, "Outcome", "data.outcomeLabel") };
}

function crossProducts(H, x, budget) {
  const p = x[0].length;
  const xtx = Array.from({ length: p }, () => Array(p).fill(0));
  for (const row of x) {
    budget.check(p * p);
    for (let i = 0; i < p; i += 1) for (let j = i; j < p; j += 1) xtx[i][j] += row[i] * row[j];
  }
  for (let i = 0; i < p; i += 1) for (let j = 0; j < i; j += 1) xtx[i][j] = xtx[j][i];
  return xtx;
}

function xty(x, y) {
  const p = x[0].length;
  const out = Array(p).fill(0);
  for (let r = 0; r < x.length; r += 1) for (let i = 0; i < p; i += 1) out[i] += x[r][i] * y[r];
  return out;
}

function logDeterminant(H, matrix) {
  return H.positiveDefiniteLogDeterminant(matrix);
}

const bayesianLinearRegression = {
  method: "bayesian_linear_regression",
  family: "bayesian",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    prior: enumOption(["zellner-g", "normal-inverse-gamma"], "zellner-g", "bayesian_linear_regression"),
    gValue: { schema: { type: "number", exclusiveMinimum: 0, maximum: 1e9 }, default: null, parse(value, H, path) { const n = H.finiteNumber(value, path); if (n <= 0 || n > 1e9) H.fail("STAT_INVALID_INPUT", `${path} must be in (0, 1e9]`); return n; } },
    priorPrecision: positiveOption(0.01, 1e6),
    priorShape: positiveOption(0.001, 1e6),
    priorScale: positiveOption(0.001, 1e6),
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["y", "predictors"],
    properties: {
      y: { type: "array", minItems: 5, maxItems: 100000, items: { type: "number" } },
      predictors: { type: "array", minItems: 1, maxItems: 48, items: { type: "object", additionalProperties: false, required: ["name", "values"], properties: { name: { type: "string", minLength: 1, maxLength: 128 }, values: { type: "array", minItems: 5, maxItems: 100000, items: { type: "number" } } } } },
      outcomeLabel: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    return parseNumericRegression(H, data, 5);
  },
  analyze(parsed, options, budget, H) {
    const n = parsed.y.length;
    const p = parsed.predictors.length;
    const level = options.confidenceLevel;
    const yMean = H.mean(parsed.y, budget);
    const yc = parsed.y.map((v) => v - yMean);
    let tss = 0;
    for (const v of yc) tss += v * v;
    if (!(tss > 0)) H.fail("STAT_DEGENERATE", "outcome has zero variance");
    const centers = parsed.predictors.map((pred) => H.mean(pred.values, budget));
    const xc = parsed.y.map((_, r) => parsed.predictors.map((pred, j) => pred.values[r] - centers[j]));
    const xtxC = crossProducts(H, xc, budget);
    if (H.matrixRank(xtxC) < p) H.fail("STAT_RANK_DEFICIENT", "predictors are collinear (rank-deficient centred design)");
    const invC = H.invert(xtxC);
    const xtyC = xty(xc, yc);
    const betaHat = invC.map((row) => row.reduce((acc, v, j) => acc + v * xtyC[j], 0));
    let explained = 0;
    for (let j = 0; j < p; j += 1) explained += betaHat[j] * xtyC[j];
    const rss = tss - explained;
    if (!(rss > 0)) H.fail("STAT_DEGENERATE", "residual sum of squares is zero; the posterior variance is degenerate");
    const r2 = explained / tss;
    const coefficientRows = [];
    let logBf10;
    let sigmaMean;
    let dfPosterior;
    let priorDescription;
    let sigmaScale;
    if (options.prior === "zellner-g") {
      const g = options.gValue === null ? n : options.gValue;
      const shrink = g / (1 + g);
      const sG = tss / (1 + g) + shrink * rss;
      dfPosterior = n - 1;
      logBf10 = (n - 1 - p) / 2 * Math.log1p(g) - (n - 1) / 2 * Math.log1p(g * (1 - r2));
      const tq = NC.tQuantile(H, 1 - (1 - level) / 2, dfPosterior);
      const interceptScale = Math.sqrt(sG / (dfPosterior * n));
      coefficientRows.push({ term: "Intercept", olsEstimate: yMean, posteriorMean: yMean, posteriorScale: interceptScale, lower: yMean - tq * interceptScale, upper: yMean + tq * interceptScale, probabilityPositive: NC.tQuantile === null ? null : H.tCdf(yMean / interceptScale, dfPosterior), shrinkage: 1 });
      for (let j = 0; j < p; j += 1) {
        const scale = Math.sqrt(shrink * sG / dfPosterior * invC[j][j]);
        const mean = shrink * betaHat[j];
        coefficientRows.push({ term: parsed.predictors[j].name, olsEstimate: betaHat[j], posteriorMean: mean, posteriorScale: scale, lower: mean - tq * scale, upper: mean + tq * scale, probabilityPositive: H.tCdf(mean / scale, dfPosterior), shrinkage: shrink });
      }
      sigmaMean = dfPosterior > 2 ? sG / (dfPosterior - 2) : null;
      sigmaScale = sG;
      priorDescription = `Zellner g-prior with g = ${g} (${options.gValue === null ? "unit information, g = n" : "user supplied"}), flat intercept, sigma^2 ∝ 1/sigma^2`;
    } else {
      const lambda = options.priorPrecision;
      const a0 = options.priorShape;
      const b0 = options.priorScale;
      const interceptPrecision = 1e-8;
      const x = parsed.y.map((_, r) => [1, ...parsed.predictors.map((pred) => pred.values[r])]);
      const xtxFull = crossProducts(H, x, budget);
      const lambdaN = xtxFull.map((row, i) => row.map((v, j) => v + (i === j ? (i === 0 ? interceptPrecision : lambda) : 0)));
      const xtyFull = xty(x, parsed.y);
      const invN = H.invert(lambdaN);
      const betaN = invN.map((row) => row.reduce((acc, v, j) => acc + v * xtyFull[j], 0));
      let yty = 0;
      for (const v of parsed.y) yty += v * v;
      let quad = 0;
      for (let i = 0; i <= p; i += 1) for (let j = 0; j <= p; j += 1) quad += betaN[i] * lambdaN[i][j] * betaN[j];
      const aN = a0 + n / 2;
      const bN = b0 + 0.5 * (yty - quad);
      if (!(bN > 0)) H.fail("STAT_DEGENERATE", "posterior scale is not positive");
      dfPosterior = 2 * aN;
      const logDet0 = Math.log(interceptPrecision) + p * Math.log(lambda);
      const logDetN = logDeterminant(H, lambdaN);
      const logMarginalFull = 0.5 * logDet0 - 0.5 * logDetN + a0 * Math.log(b0) - aN * Math.log(bN) + H.logGamma(aN) - H.logGamma(a0) - n / 2 * LOG_2PI;
      // intercept-only model under the same prior structure
      const lambdaNull = n + interceptPrecision;
      const betaNull = parsed.y.reduce((acc, v) => acc + v, 0) / lambdaNull;
      const bNull = b0 + 0.5 * (yty - betaNull * betaNull * lambdaNull);
      const logMarginalNull = 0.5 * Math.log(interceptPrecision) - 0.5 * Math.log(lambdaNull) + a0 * Math.log(b0) - aN * Math.log(bNull) + H.logGamma(aN) - H.logGamma(a0) - n / 2 * LOG_2PI;
      logBf10 = logMarginalFull - logMarginalNull;
      const tq = NC.tQuantile(H, 1 - (1 - level) / 2, dfPosterior);
      const olsFull = H.olsCore(parsed.y, x, budget).beta;
      for (let j = 0; j <= p; j += 1) {
        const scale = Math.sqrt(bN / aN * invN[j][j]);
        coefficientRows.push({ term: j === 0 ? "Intercept" : parsed.predictors[j - 1].name, olsEstimate: olsFull[j], posteriorMean: betaN[j], posteriorScale: scale, lower: betaN[j] - tq * scale, upper: betaN[j] + tq * scale, probabilityPositive: H.tCdf(betaN[j] / scale, dfPosterior), shrinkage: olsFull[j] !== 0 ? betaN[j] / olsFull[j] : null });
      }
      sigmaMean = aN > 1 ? bN / (aN - 1) : null;
      sigmaScale = bN;
      priorDescription = `normal-inverse-gamma: beta ~ N(0, sigma^2 / ${lambda}) on slopes (intercept precision 1e-8), sigma^2 ~ InvGamma(${a0}, ${b0})`;
    }
    const interpretation = bfInterpretation(Math.exp(logBf10));
    const table = H.tableArtifact("Bayesian linear regression coefficients", `${priorDescription}. Posterior marginals are Student t with ${dfPosterior} degrees of freedom; intervals are ${Math.round(level * 100)}% equal-tailed credible intervals.`, [
      { key: "term", label: "Term", type: "string" },
      { key: "olsEstimate", label: "OLS estimate", type: "number" },
      { key: "posteriorMean", label: "Posterior mean", type: "number" },
      { key: "posteriorScale", label: "Posterior scale", type: "number" },
      { key: "lower", label: "Lower", type: "number" },
      { key: "upper", label: "Upper", type: "number" },
      { key: "probabilityPositive", label: "P(coefficient > 0)", type: "number" },
      { key: "shrinkage", label: "Shrinkage factor", type: "number" },
    ], coefficientRows, [], "bayes-regression-coefficient-table");
    const modelRows = [
      { quantity: "n", value: n, note: "" },
      { quantity: "predictors", value: p, note: "" },
      { quantity: "R-squared (OLS)", value: r2, note: "" },
      { quantity: "BF10 versus intercept-only", value: Math.exp(logBf10), note: `${interpretation.strength} evidence for ${interpretation.favours}` },
      { quantity: "log10 BF10", value: logBf10 / Math.LN10, note: "" },
      { quantity: "posterior df", value: dfPosterior, note: "Student t marginals" },
      { quantity: "posterior mean of sigma^2", value: sigmaMean === null ? 0 : sigmaMean, note: sigmaMean === null ? "undefined (df <= 2)" : "" },
    ];
    const modelTable = H.tableArtifact("Bayesian regression model summary", "Model-level Bayes factor against the intercept-only model.", [
      { key: "quantity", label: "Quantity", type: "string" },
      { key: "value", label: "Value", type: "number" },
      { key: "note", label: "Note", type: "string" },
    ], modelRows, [], "bayes-regression-model-table");
    const figure = H.vegaArtifact("bayes-regression-coefficients", `Posterior means with ${Math.round(level * 100)}% credible intervals (${options.prior})`, {
      data: { values: coefficientRows },
      width: 520,
      height: 40 + 34 * coefficientRows.length,
      layer: [
        { mark: { type: "rule", color: "#4c78a8", strokeWidth: 2 }, encoding: { y: { field: "term", type: "nominal", title: "Term", sort: null }, x: { field: "lower", type: "quantitative", title: "Coefficient" }, x2: { field: "upper" } } },
        { mark: { type: "point", filled: true, size: 110, color: "#4c78a8" }, encoding: { y: { field: "term", type: "nominal", sort: null }, x: { field: "posteriorMean", type: "quantitative" }, tooltip: [{ field: "term", title: "Term" }, { field: "posteriorMean", title: "Posterior mean", format: ".4g" }, { field: "lower", title: "Lower", format: ".4g" }, { field: "upper", title: "Upper", format: ".4g" }, { field: "probabilityPositive", title: "P(> 0)", format: ".3f" }] } },
        { mark: { type: "point", filled: false, size: 70, color: "#999999", shape: "diamond" }, encoding: { y: { field: "term", type: "nominal", sort: null }, x: { field: "olsEstimate", type: "quantitative" } } },
        { mark: { type: "rule", color: "#d62728", strokeDash: [4, 3] }, encoding: { x: { datum: 0, type: "quantitative" } } },
      ],
    });
    return {
      sample: { n, predictors: p, prior: options.prior, posteriorDf: dfPosterior },
      estimates: [
        ...coefficientRows.map((row) => ({ parameter: `coefficient:${row.term}`, estimate: row.posteriorMean, role: "posterior-mean" })),
        ...coefficientRows.map((row) => ({ parameter: `ols:${row.term}`, estimate: row.olsEstimate, role: "ols" })),
        { parameter: "rSquared", estimate: r2, role: "derived" },
        { parameter: "posteriorSigmaScale", estimate: sigmaScale, role: "derived" },
        ...(sigmaMean === null ? [] : [{ parameter: "posteriorMeanSigma2", estimate: sigmaMean, role: "derived" }]),
        ...bfEstimates(logBf10),
      ],
      tests: [{ name: "Bayes factor: full model versus intercept-only", bf10: Math.exp(logBf10), bf01: Math.exp(-logBf10), prior: options.prior, interpretation }],
      confidenceIntervals: coefficientRows.map((row) => ({ parameter: row.term, level, lower: row.lower, upper: row.upper, method: `Student t(${dfPosterior}) equal-tailed credible interval` })),
      effectSizes: [{ name: "R-squared (OLS)", estimate: r2 }],
      assumptions: [
        { name: "linear mean with normal homoscedastic errors", status: "requires_design_review" },
        { name: "independent observations", status: "requires_design_review" },
        { name: "prior", status: "stated", detail: priorDescription },
      ],
      diagnostics: [
        { name: "conjugacy", status: "exact", detail: "posterior in closed form; no quadrature or sampling" },
        { name: "shrinkage", status: "evaluated", factors: coefficientRows.map((row) => ({ term: row.term, shrinkage: row.shrinkage })) },
        { name: "coefficient signs", status: coefficientRows.slice(1).every((row) => row.probabilityPositive > 0.975 || row.probabilityPositive < 0.025) ? "all_slopes_decisive" : "some_slopes_uncertain", detail: "P(coefficient > 0) outside [0.025, 0.975]" },
      ],
      artifacts: [modelTable, table, figure],
    };
  },
  linkage: bayesLinkage("linear regression model"),
  fixture: {
    data: {
      y: [10.2, 12.8, 15.1, 13.4, 17.9, 19.2, 21.5, 20.1, 24.3, 26.8, 25.2, 29.4, 31.1, 30.5, 34.2, 36.8],
      predictors: [
        { name: "dose", values: [1, 2, 3, 3, 5, 6, 7, 7, 9, 10, 10, 12, 13, 13, 15, 16] },
        { name: "age", values: [34, 41, 29, 52, 38, 45, 31, 60, 47, 36, 55, 42, 39, 58, 44, 50] },
      ],
      outcomeLabel: "Response",
    },
    options: { prior: "zellner-g", confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: coverageTemplate(
    "Conjugate Bayesian linear regression with numeric predictors under a Zellner g-prior (unit-information or user g, flat intercept) or a normal-inverse-gamma prior, with Student t marginals, credible intervals, and a Bayes factor against the intercept-only model.",
    ["posterior means, scales and credible intervals against numpy closed forms", "g-prior BF10 against the Liang et al. (2008) closed form in numpy", "normal-inverse-gamma marginal likelihoods against numpy first principles"],
    ["categorical predictors", "mixtures of g-priors (hyper-g) or spike-and-slab variable selection"],
    ["shrinkage factors", "decisiveness of slope signs"],
    ["does not diagnose residual structure or influential points"],
    ["no hyper-g or model averaging", "no heteroscedastic or robust likelihood"],
  ),
};

// ---------------------------------------------------------------------------------------------
// bayesian_correlation
// ---------------------------------------------------------------------------------------------

function pearsonPair(H, x, y, budget) {
  return H.correlation(x, y, budget);
}

/** log of the Ly et al. (2016) two-sided Bayes factor for a Pearson r with a stretched-beta(1/kappa) prior. */
function lyLogBf10(H, r, n, kappa, budget) {
  const k = kappa;
  const lbeta = logBeta(H, 1 / k, 1 / k);
  const logHyper = log2F1(H, (n - 1) / 2, (n - 1) / 2, (n + 2 / k) / 2, r * r, budget);
  return (1 - 2 / k) * Math.log(2) + 0.5 * Math.log(Math.PI) - lbeta + H.logGamma((n + 2 / k - 1) / 2) - H.logGamma((n + 2 / k) / 2) + logHyper;
}

/** log-likelihood ratio f(r | rho) / f(r | 0) from Fisher's exact sampling density of r. */
function logLikelihoodRatioRho(H, r, n, rho, logHyperAtZero, budget) {
  const z = (1 + rho * r) / 2;
  return (n - 1) / 2 * Math.log1p(-rho * rho) - (n - 1.5) * Math.log1p(-rho * r) + log2F1Series(H, 0.5, 0.5, n - 0.5, z, budget) - logHyperAtZero;
}

const bayesianCorrelation = {
  method: "bayesian_correlation",
  family: "bayesian",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    kappa: positiveOption(1, 10),
    gridPoints: gridOption,
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["x", "y"],
    properties: {
      x: { type: "array", minItems: 4, maxItems: 100000, items: { type: "number" } },
      y: { type: "array", minItems: 4, maxItems: 100000, items: { type: "number" } },
      xLabel: { type: "string", minLength: 1, maxLength: 128 },
      yLabel: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["x", "y", "xLabel", "yLabel"], "data");
    const x = H.numericVector(data.x, "data.x", 4);
    const y = H.numericVector(data.y, "data.y", 4);
    if (x.length !== y.length) H.fail("STAT_INVALID_INPUT", "data.x and data.y must have equal length");
    return { x, y, xLabel: H.label(data.xLabel, "X", "data.xLabel"), yLabel: H.label(data.yLabel, "Y", "data.yLabel") };
  },
  analyze(parsed, options, budget, H) {
    const n = parsed.x.length;
    const r = pearsonPair(H, parsed.x, parsed.y, budget);
    const kappa = options.kappa;
    if (Math.abs(r) >= 1 - 1e-12) H.fail("STAT_DEGENERATE", "observed correlation is +/-1; the exact sampling density is degenerate");
    const logBfLy = lyLogBf10(H, r, n, kappa, budget);
    // Wetzels & Wagenmakers (2012) JZS-style integral (two-sided, kappa-independent)
    const logBfWetzels = logIntegrateOverG((g) => (n - 2) / 2 * Math.log1p(g) - (n - 1) / 2 * Math.log1p((1 - r * r) * g) - 1.5 * Math.log(g) - n / (2 * g), budget) + 0.5 * Math.log(n / 2) - H.logGamma(0.5);
    // exact posterior of rho on a grid under the stretched-beta prior
    const logHyperAtZero = log2F1Series(H, 0.5, 0.5, n - 0.5, 0.5, budget);
    const priorExponent = 1 / kappa - 1;
    const logPriorNorm = -logBeta(H, 0.5, 1 / kappa);
    const gridRaw = uniformGrid(-1, 1, options.gridPoints + 2);
    const grid = gridRaw.slice(1, -1);
    const logPost = grid.map((rho) => {
      budget.check(16);
      return logLikelihoodRatioRho(H, r, n, rho, logHyperAtZero, budget) + priorExponent * Math.log1p(-rho * rho) + logPriorNorm;
    });
    const maxLog = Math.max(...logPost);
    const density = logPost.map((v) => Math.exp(v - maxLog));
    const summary = gridSummary(H, grid, density, options.confidenceLevel, 0);
    const prior = grid.map((rho) => Math.exp(priorExponent * Math.log1p(-rho * rho) + logPriorNorm));
    // BF by quadrature of the same likelihood ratio against the prior (consistency check of the grid posterior)
    const logBfQuadrature = (() => {
      const rule = SPD.gaussLegendre(GL_ORDER);
      const panels = 200;
      const width = 2 / panels;
      const logs = [];
      const weights = [];
      for (let panel = 0; panel < panels; panel += 1) {
        const lo = -1 + panel * width;
        const center = lo + width / 2;
        for (let i = 0; i < GL_ORDER; i += 1) {
          budget.check(16);
          const rho = center + width / 2 * rule.nodes[i];
          logs.push(logLikelihoodRatioRho(H, r, n, rho, logHyperAtZero, budget) + priorExponent * Math.log1p(-rho * rho) + logPriorNorm);
          weights.push(rule.weights[i] * width / 2);
        }
      }
      const m = Math.max(...logs);
      let total = 0;
      for (let i = 0; i < logs.length; i += 1) total += weights[i] * Math.exp(logs[i] - m);
      return m + Math.log(total);
    })();
    const rows = densityRows(grid, summary, prior, "rho");
    const interpretation = bfInterpretation(Math.exp(logBfLy));
    const fisherZ = Math.atanh(r);
    const summaryRows = [
      { quantity: "Pearson r", value: r, note: `n = ${n}` },
      { quantity: "prior kappa", value: kappa, note: "stretched beta (1/kappa, 1/kappa) on rho; kappa = 1 is uniform" },
      { quantity: "BF10 (Ly et al. 2016)", value: Math.exp(logBfLy), note: `${interpretation.strength} evidence for ${interpretation.favours}` },
      { quantity: "BF01 (Ly et al. 2016)", value: Math.exp(-logBfLy), note: "" },
      { quantity: "BF10 (Wetzels & Wagenmakers 2012)", value: Math.exp(logBfWetzels), note: "JZS regression-based integral; does not depend on kappa" },
      { quantity: "BF10 (quadrature of the exact likelihood)", value: Math.exp(logBfQuadrature), note: "consistency check of the grid posterior" },
      { quantity: "posterior mean of rho", value: summary.mean, note: "" },
      { quantity: "posterior median of rho", value: summary.median, note: "" },
      { quantity: `${Math.round(options.confidenceLevel * 100)}% HDI lower`, value: summary.hdiLower, note: summary.hdiContiguous ? "" : "non-contiguous" },
      { quantity: `${Math.round(options.confidenceLevel * 100)}% HDI upper`, value: summary.hdiUpper, note: "" },
      { quantity: "P(rho > 0 | data)", value: summary.massAbove, note: "" },
      { quantity: "Fisher z", value: fisherZ, note: "atanh(r), for reference" },
    ];
    const table = H.tableArtifact("Bayesian Pearson correlation", `Bayes factors and posterior of rho between ${parsed.xLabel} and ${parsed.yLabel}.`, [
      { key: "quantity", label: "Quantity", type: "string" },
      { key: "value", label: "Value", type: "number" },
      { key: "note", label: "Note", type: "string" },
    ], summaryRows, ["posterior uses Fisher's exact sampling density of r with the stretched-beta prior"], "bayes-correlation-summary-table");
    const gridTable = posteriorTable(H, "Posterior of rho", "Prior and posterior density of the correlation on the evaluation grid.", rows, "rho", "rho", "bayes-correlation-posterior-table");
    const figure = posteriorFigure(H, "bayes-correlation-posterior", `Posterior of rho (${Math.round(options.confidenceLevel * 100)}% HDI shaded) against the stretched-beta prior (kappa = ${kappa})`, rows, "rho", "rho", 0);
    return {
      sample: { n, gridPoints: grid.length },
      estimates: [
        { parameter: "r", estimate: r, role: "observed" },
        ...bfEstimates(logBfLy),
        { parameter: "bf10Wetzels", estimate: Math.exp(logBfWetzels), role: "derived" },
        { parameter: "bf10Quadrature", estimate: Math.exp(logBfQuadrature), role: "derived" },
        { parameter: "posteriorMeanRho", estimate: summary.mean, role: "derived" },
        { parameter: "posteriorMedianRho", estimate: summary.median, role: "derived" },
        { parameter: "posteriorSdRho", estimate: summary.sd, role: "derived" },
        { parameter: "probabilityRhoPositive", estimate: summary.massAbove, role: "derived" },
      ],
      tests: [{ name: "Bayes factor for rho = 0 (Ly et al. 2016)", statistic: r, bf10: Math.exp(logBfLy), bf01: Math.exp(-logBfLy), kappa, interpretation }],
      confidenceIntervals: [{ parameter: "rho", level: options.confidenceLevel, lower: summary.hdiLower, upper: summary.hdiUpper, method: "highest-density interval on the posterior grid" }],
      effectSizes: [{ name: "Pearson r", estimate: r }, { name: "posterior mean rho", estimate: summary.mean }],
      assumptions: [
        { name: "bivariate normal population", status: "requires_design_review", detail: "the exact sampling density of r assumes bivariate normality" },
        { name: "independent pairs", status: "requires_design_review" },
        { name: "stretched-beta prior on rho", status: "stated", kappa },
      ],
      diagnostics: [
        { name: "analytic versus quadrature BF", status: Math.abs(logBfLy - logBfQuadrature) < 1e-6 ? "consistent" : "inconsistent", difference: logBfLy - logBfQuadrature, detail: "closed-form hypergeometric BF against Gauss-Legendre quadrature of the exact likelihood" },
        { name: "posterior grid", status: summary.massAtEdges > 1e-4 ? "mass_at_grid_edge" : "contained", gridPoints: grid.length, edgeMass: summary.massAtEdges, hdiContiguous: summary.hdiContiguous },
        { name: "method agreement", status: (logBfLy >= 0) === (logBfWetzels >= 0) ? "direction_consistent" : "direction_depends_on_method", detail: "Ly (stretched beta) versus Wetzels (JZS) Bayes factors" },
      ],
      artifacts: [table, gridTable, figure],
    };
  },
  linkage: bayesLinkage("correlation between two variables"),
  fixture: { data: { x: [1.2, 2.4, 3.1, 4.8, 5.0, 6.3, 7.7, 8.1, 9.4, 10.2, 11.5, 12.9, 13.3, 14.8, 15.1, 16.7], y: [2.0, 2.9, 4.4, 4.1, 6.2, 6.0, 8.3, 7.9, 10.1, 9.8, 12.4, 12.0, 13.9, 13.5, 15.8, 16.1], xLabel: "Dose", yLabel: "Response" }, options: { kappa: 1, confidenceLevel: 0.95 } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.linear"] },
  coverage: coverageTemplate(
    "Two-sided Bayes factor for a Pearson correlation with the Ly et al. (2016) stretched-beta prior (closed-form hypergeometric) and the Wetzels & Wagenmakers (2012) JZS integral, plus an exact grid posterior of rho from Fisher's sampling density.",
    ["Ly BF10 against pingouin.bayesfactor_pearson(method='ly') for several kappa", "Wetzels BF10 against pingouin.bayesfactor_pearson(method='wetzels')", "posterior mean and HDI against a scipy.special.hyp2f1 grid posterior"],
    ["one-sided Bayes factors", "Spearman or Kendall Bayesian correlations"],
    ["analytic-versus-quadrature BF consistency", "posterior grid containment", "direction agreement between the two Bayes factors"],
    ["does not test bivariate normality"],
    ["no directional Bayes factor", "no rank-based Bayesian correlation"],
  ),
};

// ---------------------------------------------------------------------------------------------
// bayesian_anova
// ---------------------------------------------------------------------------------------------

/** Orthonormal sum-to-zero basis (Helmert-type) for k levels: k x (k-1). */
function orthonormalContrasts(k) {
  const q = Array.from({ length: k }, () => Array(k - 1).fill(0));
  for (let j = 1; j < k; j += 1) {
    const scale = 1 / Math.sqrt(j * (j + 1));
    for (let i = 0; i < j; i += 1) q[i][j - 1] = scale;
    q[j][j - 1] = -j * scale;
  }
  return q;
}

function anovaLogBfGiven(H, xtx, xtyVec, yy, N, p, g) {
  // log BF(g) = -0.5 log|I + g X'X| - (N-1)/2 [log S1(g) - log S0]
  const m = xtx.map((row, i) => row.map((v, j) => v + (i === j ? 1 / g : 0)));
  const inv = H.invert(m);
  let quad = 0;
  for (let i = 0; i < p; i += 1) for (let j = 0; j < p; j += 1) quad += xtyVec[i] * inv[i][j] * xtyVec[j];
  const s1 = yy - quad;
  const igx = xtx.map((row, i) => row.map((v, j) => (i === j ? 1 : 0) + g * v));
  const logDet = H.positiveDefiniteLogDeterminant(igx);
  return -0.5 * logDet - (N - 1) / 2 * (Math.log(s1) - Math.log(yy));
}

function anovaLogBf10(H, xtx, xtyVec, yy, N, p, rscale, budget) {
  return logIntegrateOverG((g) => anovaLogBfGiven(H, xtx, xtyVec, yy, N, p, g) + Math.log(rscale) - 0.5 * LOG_2PI - 1.5 * Math.log(g) - rscale * rscale / (2 * g), budget, 400);
}

const bayesianAnova = {
  method: "bayesian_anova",
  family: "bayesian",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["timeoutMs"],
  customOptions: {
    rscale: positiveOption(0.5, 10),
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["groups"],
    properties: {
      groups: { type: "array", minItems: 2, maxItems: MAX_ANOVA_GROUPS, items: { type: "object", additionalProperties: false, required: ["values"], properties: { name: { type: "string", minLength: 1, maxLength: 128 }, values: { type: "array", minItems: 2, maxItems: 100000, items: { type: "number" } } } } },
      outcomeLabel: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["groups", "outcomeLabel"], "data");
    if (Array.isArray(data.groups) && data.groups.length > MAX_ANOVA_GROUPS) H.fail("STAT_INVALID_INPUT", `bayesian_anova supports at most ${MAX_ANOVA_GROUPS} groups`);
    const groups = H.parseGroups({ groups: data.groups }, 2);
    return { groups, outcomeLabel: H.label(data.outcomeLabel, "Outcome", "data.outcomeLabel") };
  },
  analyze(parsed, options, budget, H) {
    const k = parsed.groups.length;
    const p = k - 1;
    const y = [];
    const membership = [];
    parsed.groups.forEach((group, index) => { for (const v of group.values) { y.push(v); membership.push(index); } });
    const N = y.length;
    const grand = H.mean(y, budget);
    const yc = y.map((v) => v - grand);
    let yy = 0;
    for (const v of yc) yy += v * v;
    if (!(yy > 0)) H.fail("STAT_DEGENERATE", "outcome has zero variance");
    const q = orthonormalContrasts(k);
    const xRaw = membership.map((g) => q[g]);
    const colMeans = Array(p).fill(0);
    for (const row of xRaw) for (let j = 0; j < p; j += 1) colMeans[j] += row[j] / N;
    const x = xRaw.map((row) => row.map((v, j) => v - colMeans[j]));
    const xtx = crossProducts(H, x, budget);
    const xtyVec = xty(x, yc);
    const rscale = options.rscale;
    const logBf10 = anovaLogBf10(H, xtx, xtyVec, yy, N, p, rscale, budget);
    // classical summaries for reference
    const inv = H.invert(xtx);
    let explained = 0;
    for (let i = 0; i < p; i += 1) for (let j = 0; j < p; j += 1) explained += xtyVec[i] * inv[i][j] * xtyVec[j];
    const rss = yy - explained;
    const f = (explained / p) / (rss / (N - k));
    const r2 = explained / yy;
    const pValue = H.pFromF(f, p, N - k);
    const groupRows = parsed.groups.map((group) => ({ group: group.name, n: group.values.length, mean: H.mean(group.values, budget), sd: Math.sqrt(H.variance(group.values, true, budget)) }));
    const scales = [0.25, 0.5, 0.75, 1, Math.SQRT2].filter((s) => Math.abs(s - rscale) > 1e-9);
    const sensitivity = [{ rscale, bf10: Math.exp(logBf10), selected: true }, ...scales.map((s) => ({ rscale: s, bf10: Math.exp(anovaLogBf10(H, xtx, xtyVec, yy, N, p, s, budget)), selected: false }))].sort((a, b) => a.rscale - b.rscale);
    const interpretation = bfInterpretation(Math.exp(logBf10));
    const summaryRows = [
      { quantity: "groups", value: k, note: "" },
      { quantity: "N", value: N, note: "" },
      { quantity: "fixed-effect prior scale r", value: rscale, note: "Cauchy scale on standardised group effects (Rouder et al. 2012)" },
      { quantity: "BF10", value: Math.exp(logBf10), note: `${interpretation.strength} evidence for ${interpretation.favours}` },
      { quantity: "BF01", value: Math.exp(-logBf10), note: "" },
      { quantity: "log10 BF10", value: logBf10 / Math.LN10, note: "" },
      { quantity: "F statistic", value: f, note: `df ${p}, ${N - k} (classical reference)` },
      { quantity: "classical p value", value: pValue, note: "reference only" },
      { quantity: "R-squared", value: r2, note: "" },
    ];
    const table = H.tableArtifact("Bayesian one-way ANOVA (JZS)", `Bayes factor for a group effect on ${parsed.outcomeLabel} with an orthonormal sum-to-zero effect basis.`, [
      { key: "quantity", label: "Quantity", type: "string" },
      { key: "value", label: "Value", type: "number" },
      { key: "note", label: "Note", type: "string" },
    ], summaryRows, ["g integrated over an inverse-gamma(1/2, r^2/2) prior by Gauss-Legendre quadrature on log g"], "bayes-anova-summary-table");
    const groupTable = H.tableArtifact("Group summaries", "Observed group sizes, means and standard deviations.", [
      { key: "group", label: "Group", type: "string" },
      { key: "n", label: "n", type: "number" },
      { key: "mean", label: "Mean", type: "number" },
      { key: "sd", label: "SD", type: "number" },
    ], groupRows, [], "bayes-anova-group-table");
    const sensitivityTable = H.tableArtifact("Bayes factor robustness", "BF10 across fixed-effect prior scales.", [
      { key: "rscale", label: "Prior scale r", type: "number" },
      { key: "bf10", label: "BF10", type: "number" },
      { key: "selected", label: "Selected", type: "boolean" },
    ], sensitivity, [], "bayes-anova-sensitivity-table");
    const figure = H.vegaArtifact("bayes-anova-robustness", "Bayes factor robustness to the fixed-effect prior scale", {
      data: { values: sensitivity },
      width: 480,
      height: 300,
      layer: [
        { mark: { type: "line", strokeWidth: 2, point: true }, encoding: { x: { field: "rscale", type: "quantitative", title: "Prior scale r" }, y: { field: "bf10", type: "quantitative", title: "BF10", scale: { type: "log" } }, tooltip: [{ field: "rscale", title: "r" }, { field: "bf10", title: "BF10", format: ".4g" }] } },
        { mark: { type: "point", filled: true, size: 160, color: "#d62728" }, encoding: { x: { field: "rscale", type: "quantitative" }, y: { field: "bf10", type: "quantitative" }, opacity: { condition: { test: "datum.selected === true", value: 1 }, value: 0 } } },
        { mark: { type: "rule", color: "#555555", strokeDash: [6, 4] }, encoding: { y: { datum: 1, type: "quantitative" } } },
      ],
    });
    return {
      sample: { groups: k, n: N, groupSizes: parsed.groups.map((g) => g.values.length) },
      estimates: [
        ...bfEstimates(logBf10),
        { parameter: "F", estimate: f, role: "observed" },
        { parameter: "rSquared", estimate: r2, role: "observed" },
        ...groupRows.map((row) => ({ parameter: `mean:${row.group}`, estimate: row.mean, role: "observed" })),
      ],
      tests: [{ name: "JZS Bayes factor one-way ANOVA", bf10: Math.exp(logBf10), bf01: Math.exp(-logBf10), priorScale: rscale, referenceF: f, referenceDf1: p, referenceDf2: N - k, referencePValue: pValue, interpretation }],
      confidenceIntervals: [],
      effectSizes: [{ name: "R-squared", estimate: r2 }],
      assumptions: [
        { name: "normal errors with equal group variance", status: "requires_design_review" },
        { name: "independent observations", status: "requires_design_review" },
        { name: "fixed-effect Cauchy prior on standardised effects", status: "stated", scale: rscale, detail: "effects coded on an orthonormal sum-to-zero basis; the intercept has a flat prior" },
      ],
      diagnostics: [
        { name: "quadrature", status: "deterministic", detail: "Gauss-Legendre panels on g = exp(u); no Monte Carlo error", panels: 400, order: GL_ORDER },
        { name: "prior sensitivity", status: sensitivity.every((row) => (row.bf10 >= 1) === (Math.exp(logBf10) >= 1)) ? "direction_stable" : "direction_depends_on_prior", scales: sensitivity.map((row) => row.rscale) },
        { name: "balance", status: new Set(parsed.groups.map((g) => g.values.length)).size === 1 ? "balanced" : "unbalanced", detail: "unbalanced designs centre the effect columns; the fixed-effect prior then depends on group sizes" },
      ],
      artifacts: [table, groupTable, sensitivityTable, figure],
    };
  },
  linkage: bayesLinkage("difference among several group means"),
  fixture: { data: { groups: [{ name: "A", values: [23.1, 25.4, 22.8, 26.7, 24.3, 21.9, 25.8, 23.6] }, { name: "B", values: [27.2, 29.5, 26.1, 30.4, 28.3, 25.7, 29.9, 27.6] }, { name: "C", values: [24.9, 26.8, 25.5, 27.9, 26.1, 24.2, 27.3, 25.8] }], outcomeLabel: "Score" }, options: { rscale: 0.5 } },
  matlabParity: { taxonomyIds: ["matlab.stats.anova"] },
  coverage: coverageTemplate(
    "One-way fixed-effects JZS Bayes factor (Rouder et al. 2012) for two to eight groups with an orthonormal sum-to-zero effect basis, integrating g by deterministic quadrature, with a prior-scale robustness table.",
    ["BF10 against scipy.integrate.quad of the same closed-form conditional Bayes factor in numpy", "two-group reduction against pingouin.bayesfactor_ttest with r = sqrt(2) x rscale"],
    ["random-effect or multi-factor designs", "post hoc pairwise Bayes factors"],
    ["prior-scale sensitivity direction", "balance status"],
    ["does not check variance homogeneity or normality"],
    ["no multi-factor or repeated-measures ANOVA", "no posterior estimates of group effects"],
  ),
};

// ---------------------------------------------------------------------------------------------
// bayesian_meta_analysis
// ---------------------------------------------------------------------------------------------

const bayesianMetaAnalysis = {
  method: "bayesian_meta_analysis",
  family: "bayesian",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    tauScale: positiveOption(0.5, 100),
    muPriorScale: positiveOption(1, 1000),
    gridPoints: { schema: { type: "integer", minimum: 51, maximum: 401 }, default: 201, parse(value, H, path) { return H.integer(value, 51, 401, path); } },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["studies"],
    properties: {
      studies: { type: "array", minItems: 2, maxItems: MAX_META_STUDIES, items: { type: "object", additionalProperties: false, required: ["effect", "standardError"], properties: { name: { type: "string", minLength: 1, maxLength: 128 }, effect: { type: "number" }, standardError: { type: "number", exclusiveMinimum: 0 } } } },
      nullValue: { type: "number", description: "point null for the Savage-Dickey Bayes factor on the pooled effect; default 0" },
      effectLabel: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["studies", "nullValue", "effectLabel"], "data");
    if (!Array.isArray(data.studies) || data.studies.length < 2 || data.studies.length > MAX_META_STUDIES) H.fail("STAT_INVALID_INPUT", `data.studies must hold between 2 and ${MAX_META_STUDIES} studies`);
    const names = new Set();
    const studies = data.studies.map((raw, index) => {
      const item = H.assertObject(raw, `data.studies[${index}]`);
      H.assertKeys(item, ["name", "effect", "standardError"], `data.studies[${index}]`);
      const name = H.label(item.name, `Study ${index + 1}`, `data.studies[${index}].name`);
      if (names.has(name)) H.fail("STAT_INVALID_INPUT", `duplicate study name: ${name}`);
      names.add(name);
      const effect = H.finiteNumber(item.effect, `data.studies[${index}].effect`);
      const standardError = H.finiteNumber(item.standardError, `data.studies[${index}].standardError`);
      if (standardError <= 0) H.fail("STAT_INVALID_INPUT", `data.studies[${index}].standardError must be positive`);
      return { name, effect, standardError };
    });
    const nullValue = data.nullValue === undefined ? 0 : H.finiteNumber(data.nullValue, "data.nullValue");
    return { studies, nullValue, effectLabel: H.label(data.effectLabel, "Effect", "data.effectLabel") };
  },
  analyze(parsed, options, budget, H) {
    const studies = parsed.studies;
    const K = studies.length;
    const level = options.confidenceLevel;
    const tauScale = options.tauScale;
    const muScale = options.muPriorScale;
    const y = studies.map((s) => s.effect);
    const se = studies.map((s) => s.standardError);
    const lo = Math.min(...y.map((v, i) => v - 4 * se[i]), parsed.nullValue - 0.5 * Math.max(...se));
    const hi = Math.max(...y.map((v, i) => v + 4 * se[i]), parsed.nullValue + 0.5 * Math.max(...se));
    const muGrid = anchoredGrid(lo, hi, options.gridPoints, parsed.nullValue);
    const spread = Math.sqrt(H.variance(y, true, budget));
    const tauMax = Math.max(4 * spread, 3 * Math.max(...se), 4 * tauScale);
    const tauGrid = uniformGrid(0, tauMax, options.gridPoints);
    const G = muGrid.length;
    const T = tauGrid.length;
    const hMu = muGrid[1] - muGrid[0];
    const hTau = tauGrid[1] - tauGrid[0];
    const wMu = muGrid.map((_, i) => (i === 0 || i === G - 1 ? hMu / 2 : hMu));
    const wTau = tauGrid.map((_, j) => (j === 0 || j === T - 1 ? hTau / 2 : hTau));
    const logJoint = Array.from({ length: G }, () => new Array(T));
    let maxLog = -Infinity;
    for (let j = 0; j < T; j += 1) {
      const tau2 = tauGrid[j] * tauGrid[j];
      const logPriorTau = Math.log(2 / (Math.PI * tauScale)) - Math.log1p((tauGrid[j] / tauScale) ** 2);
      const variances = se.map((s) => s * s + tau2);
      const logNorm = variances.reduce((acc, v) => acc - 0.5 * Math.log(2 * Math.PI * v), 0);
      for (let i = 0; i < G; i += 1) {
        budget.check(K);
        const mu = muGrid[i];
        let ll = logNorm;
        for (let k = 0; k < K; k += 1) ll -= (y[k] - mu) ** 2 / (2 * variances[k]);
        const logPriorMu = -0.5 * LOG_2PI - Math.log(muScale) - mu * mu / (2 * muScale * muScale);
        const value = ll + logPriorMu + logPriorTau;
        logJoint[i][j] = value;
        if (value > maxLog) maxLog = value;
      }
    }
    if (!Number.isFinite(maxLog)) H.fail("STAT_DEGENERATE", "joint posterior underflowed on the grid");
    let mass = 0;
    const joint = logJoint.map((row, i) => row.map((v, j) => { const d = Math.exp(v - maxLog); mass += wMu[i] * wTau[j] * d; return d; }));
    const muMarginal = muGrid.map((_, i) => { let s = 0; for (let j = 0; j < T; j += 1) s += wTau[j] * joint[i][j]; return s / mass; });
    const tauMarginal = tauGrid.map((_, j) => { let s = 0; for (let i = 0; i < G; i += 1) s += wMu[i] * joint[i][j]; return s / mass; });
    const muSummary = gridSummary(H, muGrid, muMarginal, level, parsed.nullValue);
    const tauSummary = gridSummary(H, tauGrid, tauMarginal, level, null);
    // Savage-Dickey at the null (grid point by construction)
    const nullIndex = muGrid.findIndex((v) => Math.abs(v - parsed.nullValue) < 1e-9 * Math.max(1, Math.abs(parsed.nullValue)));
    if (nullIndex < 0) H.fail("STAT_INTERNAL", "null value is not on the mu grid");
    const posteriorAtNull = muSummary.normalized[nullIndex];
    const priorAtNull = Math.exp(-0.5 * LOG_2PI - Math.log(muScale) - parsed.nullValue ** 2 / (2 * muScale * muScale));
    const logBf01 = Math.log(posteriorAtNull) - Math.log(priorAtNull);
    const logBf10 = -logBf01;
    // posterior of tau^2 mean for the prediction interval, study-specific shrinkage
    let tau2Mean = 0;
    for (let j = 0; j < T; j += 1) tau2Mean += wTau[j] * tauSummary.normalized[j] * tauGrid[j] * tauGrid[j];
    const studyRows = studies.map((study, k) => {
      let m = 0;
      let m2 = 0;
      let condVar = 0;
      for (let i = 0; i < G; i += 1) {
        for (let j = 0; j < T; j += 1) {
          const w = wMu[i] * wTau[j] * joint[i][j] / mass;
          const tau2 = tauGrid[j] * tauGrid[j];
          const s2 = se[k] * se[k];
          const shrunk = (tau2 * y[k] + s2 * muGrid[i]) / (tau2 + s2);
          m += w * shrunk;
          m2 += w * shrunk * shrunk;
          condVar += w * (tau2 * s2 / (tau2 + s2));
        }
      }
      budget.check(G * T);
      const sd = Math.sqrt(Math.max(0, condVar + m2 - m * m));
      return { study: study.name, kind: "posterior", estimate: m, lower: m - SPD.qnorm(1 - (1 - level) / 2) * sd, upper: m + SPD.qnorm(1 - (1 - level) / 2) * sd, standardError: sd, weight: 1 / (se[k] * se[k] + tau2Mean) };
    });
    const z = SPD.qnorm(1 - (1 - level) / 2);
    const observedRows = studies.map((study, k) => ({ study: study.name, kind: "observed", estimate: y[k], lower: y[k] - z * se[k], upper: y[k] + z * se[k], standardError: se[k], weight: 1 / (se[k] * se[k] + tau2Mean) }));
    const totalWeight = observedRows.reduce((acc, row) => acc + row.weight, 0);
    const forestRows = [];
    for (let k = 0; k < K; k += 1) {
      forestRows.push({ ...observedRows[k], weight: observedRows[k].weight / totalWeight });
      forestRows.push({ ...studyRows[k], weight: studyRows[k].weight / totalWeight });
    }
    forestRows.push({ study: "Pooled (mu)", kind: "posterior", estimate: muSummary.mean, lower: muSummary.hdiLower, upper: muSummary.hdiUpper, standardError: muSummary.sd, weight: 1 });
    const predictionSd = Math.sqrt(tau2Mean + muSummary.sd ** 2);
    const forestTable = H.tableArtifact("Forest table", `Observed study effects with ${Math.round(level * 100)}% intervals, posterior (shrunken) study effects, and the pooled posterior mean with its HDI.`, [
      { key: "study", label: "Study", type: "string" },
      { key: "kind", label: "Kind", type: "string" },
      { key: "estimate", label: "Estimate", type: "number" },
      { key: "lower", label: "Lower", type: "number" },
      { key: "upper", label: "Upper", type: "number" },
      { key: "standardError", label: "SE / posterior SD", type: "number" },
      { key: "weight", label: "Relative weight", type: "number" },
    ], forestRows, ["posterior study intervals are moment-based normal approximations of the grid posterior"], "bayes-meta-forest-table");
    const interpretation = bfInterpretation(Math.exp(logBf10));
    const summaryRows = [
      { quantity: "studies", value: K, note: "" },
      { quantity: "posterior mean of mu", value: muSummary.mean, note: "" },
      { quantity: "posterior median of mu", value: muSummary.median, note: "" },
      { quantity: "posterior SD of mu", value: muSummary.sd, note: "" },
      { quantity: `${Math.round(level * 100)}% HDI lower (mu)`, value: muSummary.hdiLower, note: muSummary.hdiContiguous ? "" : "non-contiguous" },
      { quantity: `${Math.round(level * 100)}% HDI upper (mu)`, value: muSummary.hdiUpper, note: "" },
      { quantity: `P(mu > ${parsed.nullValue})`, value: muSummary.massAbove, note: "" },
      { quantity: "posterior mean of tau", value: tauSummary.mean, note: "" },
      { quantity: "posterior median of tau", value: tauSummary.median, note: "" },
      { quantity: `${Math.round(level * 100)}% HDI upper (tau)`, value: tauSummary.hdiUpper, note: `HDI lower ${tauSummary.hdiLower.toPrecision(4)}` },
      { quantity: "BF10 (Savage-Dickey at the null)", value: Math.exp(logBf10), note: `${interpretation.strength} evidence for ${interpretation.favours}` },
      { quantity: "BF01 (Savage-Dickey at the null)", value: Math.exp(logBf01), note: "" },
      { quantity: "prediction SD for a new study", value: predictionSd, note: "sqrt(E[tau^2] + Var(mu)); moment-based" },
      { quantity: "half-Cauchy tau scale", value: tauScale, note: "" },
      { quantity: "normal prior SD on mu", value: muScale, note: "" },
    ];
    const table = H.tableArtifact("Bayesian random-effects meta-analysis", `Grid posterior (${G} x ${T}) for the pooled ${parsed.effectLabel} and the between-study SD.`, [
      { key: "quantity", label: "Quantity", type: "string" },
      { key: "value", label: "Value", type: "number" },
      { key: "note", label: "Note", type: "string" },
    ], summaryRows, [], "bayes-meta-summary-table");
    const muRows = muGrid.map((mu, i) => ({ mu, posterior: muSummary.normalized[i], prior: Math.exp(-0.5 * LOG_2PI - Math.log(muScale) - mu * mu / (2 * muScale * muScale)), inHdi: muSummary.included[i], hdiDensity: muSummary.included[i] ? muSummary.normalized[i] : 0 }));
    const muTable = posteriorTable(H, "Posterior of mu", "Marginal posterior of the pooled effect on the mu grid.", muRows, "mu", "mu", "bayes-meta-mu-posterior-table");
    const figure = H.vegaArtifact("bayes-meta-forest", `Forest plot: observed and posterior (shrunken) study effects with the pooled ${parsed.effectLabel}`, {
      data: { values: forestRows },
      width: 520,
      height: 40 + 26 * forestRows.length,
      layer: [
        { mark: { type: "rule", strokeWidth: 2 }, encoding: { y: { field: "study", type: "nominal", title: "Study", sort: null }, x: { field: "lower", type: "quantitative", title: parsed.effectLabel }, x2: { field: "upper" }, color: { field: "kind", type: "nominal", title: "Estimate", scale: { domain: ["observed", "posterior"], range: ["#999999", "#4c78a8"] } } } },
        { mark: { type: "point", filled: true }, encoding: { y: { field: "study", type: "nominal", sort: null }, x: { field: "estimate", type: "quantitative" }, color: { field: "kind", type: "nominal", scale: { domain: ["observed", "posterior"], range: ["#999999", "#4c78a8"] } }, shape: { field: "kind", type: "nominal", scale: { domain: ["observed", "posterior"], range: ["square", "circle"] } }, size: { field: "weight", type: "quantitative", legend: null, scale: { range: [40, 400] } }, tooltip: [{ field: "study", title: "Study" }, { field: "kind", title: "Kind" }, { field: "estimate", title: "Estimate", format: ".4g" }, { field: "lower", title: "Lower", format: ".4g" }, { field: "upper", title: "Upper", format: ".4g" }] } },
        { mark: { type: "rule", color: "#d62728", strokeDash: [4, 3] }, encoding: { x: { datum: parsed.nullValue, type: "quantitative" } } },
      ],
    });
    return {
      sample: { studies: K, muGridPoints: G, tauGridPoints: T, tauMax, nullValue: parsed.nullValue },
      estimates: [
        { parameter: "mu", estimate: muSummary.mean, role: "posterior-mean" },
        { parameter: "muMedian", estimate: muSummary.median, role: "derived" },
        { parameter: "muSd", estimate: muSummary.sd, role: "derived" },
        { parameter: "tau", estimate: tauSummary.mean, role: "posterior-mean" },
        { parameter: "tauMedian", estimate: tauSummary.median, role: "derived" },
        { parameter: "tau2Mean", estimate: tau2Mean, role: "derived" },
        { parameter: "probabilityMuAboveNull", estimate: muSummary.massAbove, role: "derived" },
        { parameter: "predictionSd", estimate: predictionSd, role: "derived" },
        ...bfEstimates(logBf10),
        ...studyRows.map((row) => ({ parameter: `shrunken:${row.study}`, estimate: row.estimate, role: "posterior-mean" })),
      ],
      tests: [{ name: "Savage-Dickey Bayes factor for mu = null", nullValue: parsed.nullValue, bf10: Math.exp(logBf10), bf01: Math.exp(logBf01), interpretation }],
      confidenceIntervals: [
        { parameter: "mu", level, lower: muSummary.hdiLower, upper: muSummary.hdiUpper, method: "highest-density interval on the mu grid" },
        { parameter: "tau", level, lower: tauSummary.hdiLower, upper: tauSummary.hdiUpper, method: "highest-density interval on the tau grid" },
      ],
      effectSizes: [{ name: "pooled effect (posterior mean)", estimate: muSummary.mean }, { name: "between-study SD (posterior mean)", estimate: tauSummary.mean }],
      assumptions: [
        { name: "normal within-study sampling with known standard errors", status: "requires_design_review" },
        { name: "normal between-study distribution of true effects", status: "requires_design_review" },
        { name: "priors", status: "stated", detail: `mu ~ N(0, ${muScale}^2); tau ~ half-Cauchy(${tauScale})` },
      ],
      diagnostics: [
        { name: "grid", status: "deterministic", detail: "dense 2-D grid with trapezoid weights; no sampling", muGridPoints: G, tauGridPoints: T, muRange: [muGrid[0], muGrid[G - 1]], tauMax },
        { name: "mu grid containment", status: muSummary.massAtEdges > 1e-4 ? "mass_at_grid_edge" : "contained", edgeMass: muSummary.massAtEdges },
        { name: "tau grid containment", status: tauSummary.weights[T - 1] * tauSummary.normalized[T - 1] > 1e-4 ? "mass_at_grid_edge" : "contained", upperEdgeMass: tauSummary.weights[T - 1] * tauSummary.normalized[T - 1] },
        { name: "Savage-Dickey", status: "grid_approximation", detail: "posterior density at the null read from the mu grid; resolution limited by grid spacing", gridSpacing: hMu },
        { name: "heterogeneity", status: tauSummary.median > Math.min(...se) ? "material" : "small", detail: "posterior median tau relative to the smallest study SE" },
      ],
      artifacts: [table, forestTable, muTable, figure],
    };
  },
  linkage: bayesLinkage("pooled effect across studies"),
  fixture: {
    data: {
      studies: [
        { name: "Alpha", effect: 0.42, standardError: 0.18 },
        { name: "Bravo", effect: 0.25, standardError: 0.12 },
        { name: "Charlie", effect: 0.61, standardError: 0.22 },
        { name: "Delta", effect: 0.08, standardError: 0.15 },
        { name: "Echo", effect: 0.37, standardError: 0.10 },
        { name: "Foxtrot", effect: 0.55, standardError: 0.25 },
        { name: "Golf", effect: 0.19, standardError: 0.14 },
        { name: "Hotel", effect: 0.33, standardError: 0.11 },
      ],
      nullValue: 0,
      effectLabel: "Standardised mean difference",
    },
    options: { tauScale: 0.5, muPriorScale: 1, gridPoints: 201, confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.location"] },
  coverage: coverageTemplate(
    "Bayesian normal-normal random-effects meta-analysis with a normal prior on the pooled effect and a half-Cauchy prior on the between-study SD, evaluated on a dense two-dimensional grid with trapezoid normalisation; study-specific shrinkage, HDIs, a Savage-Dickey Bayes factor and a moment-based prediction SD.",
    ["mu and tau marginal summaries against a numpy evaluation of the identical grid", "discretisation error bounded against a finer numpy grid", "Savage-Dickey BF against the numpy grid density"],
    ["MCMC-based posteriors", "meta-regression or multilevel designs"],
    ["grid containment for mu and tau", "Savage-Dickey grid resolution", "heterogeneity magnitude"],
    ["does not assess publication bias"],
    ["no meta-regression", "no non-normal random-effects distributions"],
  ),
};

module.exports = {
  methods: [bayesianTTest, bayesianProportion, bayesianAbTest, bayesianLinearRegression, bayesianCorrelation, bayesianAnova, bayesianMetaAnalysis],
  internals: { jzsLogBf10, lyLogBf10, log2F1, gridSummary, betaHdi, betaQuantile, orthonormalContrasts, anovaLogBf10, logIntegrateOverG },
};
