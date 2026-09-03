"use strict";

/**
 * Effect-size family: standardized effect sizes with noncentral-distribution intervals and
 * scale conversions with delta-method variance propagation. Pure deterministic JavaScript.
 */

const SCALES = Object.freeze(["d", "r", "odds-ratio", "log-odds-ratio", "eta-squared", "f"]);
const DESIGNS = Object.freeze(["independent", "paired", "one-sample", "anova"]);
const NCT_MAX_TERMS = 20000;
const BISECTION_ITERATIONS = 100;

function normalSf(H, x) {
  return x >= 0 ? 0.5 * H.gammaQ(0.5, x * x / 2) : 1 - 0.5 * H.gammaQ(0.5, x * x / 2);
}

function normalCdf(H, x) {
  return 1 - normalSf(H, x);
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function finiteOrFail(H, value, what) {
  if (!Number.isFinite(value)) H.fail("STAT_NUMERIC_FAILURE", `${what} is not finite`);
  return Object.is(value, -0) ? 0 : value;
}

/** Exact small-sample correction J(df) = Γ(df/2) / (√(df/2) Γ((df-1)/2)). */
function hedgesExactJ(H, df) {
  return Math.exp(H.logGamma(df / 2) - H.logGamma((df - 1) / 2)) / Math.sqrt(df / 2);
}

function hedgesApproximateJ(df) {
  return 1 - 3 / (4 * df - 1);
}

/**
 * Noncentral t cumulative distribution, AS 243 (Lenth 1989) series with the regularized
 * incomplete beta. Absolute accuracy is governed by the 1e-12 error bound plus the incomplete
 * beta tolerance; the term cap fails closed for extreme noncentrality.
 */
function noncentralTCdf(t, df, delta, H, budget) {
  if (!(df > 0)) H.fail("STAT_INTERNAL", "noncentral t requires positive degrees of freedom");
  if (t < 0) return 1 - noncentralTCdf(-t, df, -delta, H, budget);
  const baseline = normalCdf(H, -delta);
  const x = t * t / (t * t + df);
  if (!(x > 0)) return baseline;
  const lambda = delta * delta;
  let p = 0.5 * Math.exp(-0.5 * lambda);
  let q = Math.sqrt(2 / Math.PI) * p * delta;
  let s = 0.5 - p;
  let a = 0.5;
  const b = 0.5 * df;
  const rxb = Math.pow(1 - x, b);
  const albeta = 0.5 * Math.log(Math.PI) + H.logGamma(b) - H.logGamma(0.5 + b);
  let xodd = H.regularizedBeta(x, a, b);
  let godd = 2 * rxb * Math.exp(a * Math.log(x) - albeta);
  let xeven = 1 - rxb;
  let geven = b * x * rxb;
  let tnc = p * xodd + q * xeven;
  let en = 1;
  let converged = false;
  while (en <= NCT_MAX_TERMS) {
    budget.check();
    a += 1;
    xodd -= godd;
    xeven -= geven;
    godd *= x * (a + b - 1) / a;
    geven *= x * (a + b - 0.5) / (a + 0.5);
    p *= lambda / (2 * en);
    q *= lambda / (2 * en + 1);
    s -= p;
    en += 1;
    tnc += p * xodd + q * xeven;
    const errorBound = 2 * s * (xodd - godd);
    if (Math.abs(errorBound) < 1e-12 && en > 2) { converged = true; break; }
  }
  if (!converged) H.fail("STAT_NON_CONVERGENCE", "noncentral t series did not converge within the term cap");
  return clamp01(tnc + baseline);
}

/** Noncentral F cumulative distribution as a Poisson mixture of central beta distributions. */
function noncentralFCdf(f, df1, df2, lambda, H, budget) {
  if (!(f > 0)) return 0;
  const x = df1 * f / (df1 * f + df2);
  const half = lambda / 2;
  if (!(half > 0)) return H.regularizedBeta(x, df1 / 2, df2 / 2);
  const jMax = Math.ceil(half + 12 * Math.sqrt(half) + 80);
  let total = 0;
  let weightSum = 0;
  for (let j = 0; j <= jMax; j += 1) {
    budget.check();
    const logWeight = -half + j * Math.log(half) - H.logGamma(j + 1);
    if (logWeight < -745) {
      if (j > half) break;
      continue;
    }
    const weight = Math.exp(logWeight);
    weightSum += weight;
    total += weight * H.regularizedBeta(x, df1 / 2 + j, df2 / 2);
    if (weightSum > 1 - 1e-15 && j > half) break;
  }
  return clamp01(total);
}

/** Solve cdf(statistic | ncp) = target for the noncentrality parameter; cdf is decreasing in ncp. */
function solveNoncentrality(cdfAtNcp, target, start, H, budget, { floor = -Infinity } = {}) {
  let low = start;
  let high = start;
  let step = Math.max(1, Math.abs(start));
  let expansions = 0;
  while (cdfAtNcp(low) < target) {
    low -= step;
    step *= 2;
    expansions += 1;
    if (low < floor) { low = floor; break; }
    if (expansions > 200) H.fail("STAT_NON_CONVERGENCE", "noncentrality bracket search did not converge");
  }
  step = Math.max(1, Math.abs(start));
  expansions = 0;
  while (cdfAtNcp(high) > target) {
    high += step;
    step *= 2;
    expansions += 1;
    if (expansions > 200) H.fail("STAT_NON_CONVERGENCE", "noncentrality bracket search did not converge");
  }
  if (low >= high) return low;
  if (low === floor && cdfAtNcp(low) <= target) return floor;
  for (let iteration = 0; iteration < BISECTION_ITERATIONS; iteration += 1) {
    budget.check();
    const middle = (low + high) / 2;
    if (cdfAtNcp(middle) > target) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

function noncentralTInterval(t, df, level, H, budget) {
  const alpha = 1 - level;
  const cdf = (ncp) => noncentralTCdf(t, df, ncp, H, budget);
  const lower = solveNoncentrality(cdf, 1 - alpha / 2, t, H, budget);
  const upper = solveNoncentrality(cdf, alpha / 2, t, H, budget);
  return { lower, upper };
}

function noncentralFInterval(f, df1, df2, level, H, budget) {
  const alpha = 1 - level;
  const cdf = (ncp) => noncentralFCdf(f, df1, df2, Math.max(0, ncp), H, budget);
  const atZero = cdf(0);
  const lower = atZero <= 1 - alpha / 2 ? 0 : solveNoncentrality(cdf, 1 - alpha / 2, Math.max(0, f * df1 - df1), H, budget, { floor: 0 });
  const upper = atZero <= alpha / 2 ? 0 : solveNoncentrality(cdf, alpha / 2, Math.max(0, f * df1), H, budget, { floor: 0 });
  return { lower: Math.max(0, lower), upper: Math.max(0, upper), lowerAtBoundary: atZero <= 1 - alpha / 2 };
}

function sampleSd(H, values, budget) {
  return Math.sqrt(H.variance(values, true, budget));
}

function transformInterval(lower, upper, map) {
  return { lower: map(lower), upper: map(upper) };
}

function squaredInterval(lower, upper, map) {
  if (lower <= 0 && upper >= 0) return { lower: 0, upper: Math.max(map(lower), map(upper)) };
  const a = map(lower);
  const b = map(upper);
  return { lower: Math.min(a, b), upper: Math.max(a, b) };
}

function probabilityOfSuperiority(H, x, y, budget) {
  const ranked = H.averageRanks([...x, ...y]);
  let rankSum = 0;
  for (let index = 0; index < x.length; index += 1) { budget.check(); rankSum += ranked.ranks[index]; }
  const u = rankSum - x.length * (x.length + 1) / 2;
  return u / (x.length * y.length);
}

function effectRow(name, family, estimate, interval, method, level) {
  return {
    name,
    family,
    estimate,
    lower: interval ? interval.lower : null,
    upper: interval ? interval.upper : null,
    level: interval ? level : null,
    method,
  };
}

const EFFECT_COLUMNS = [
  { key: "name", label: "Effect size", type: "string" },
  { key: "family", label: "Family", type: "string" },
  { key: "estimate", label: "Estimate", type: "number" },
  { key: "lower", label: "CI lower", type: "number" },
  { key: "upper", label: "CI upper", type: "number" },
  { key: "level", label: "CI level", type: "number" },
  { key: "method", label: "Interval method", type: "string" },
];

function effectForest(rows, title) {
  return {
    data: { values: rows },
    facet: { row: { field: "family", type: "nominal", title: null, header: { labelAngle: 0, labelAlign: "left" } } },
    resolve: { scale: { x: "independent", y: "independent" } },
    spec: {
      width: 420,
      layer: [
        { mark: { type: "rule", strokeWidth: 2, color: "#285f8f" }, encoding: { y: { field: "name", type: "nominal", title: null, sort: null }, x: { field: "lower", type: "quantitative", title: "Estimate" }, x2: { field: "upper" } } },
        { mark: { type: "point", filled: true, size: 90, color: "#1f3f5f" }, encoding: { y: { field: "name", type: "nominal", sort: null }, x: { field: "estimate", type: "quantitative" }, tooltip: [{ field: "name" }, { field: "estimate", format: ".4g" }, { field: "lower", format: ".4g" }, { field: "upper", format: ".4g" }, { field: "method" }] } },
      ],
    },
    description: title,
  };
}

function analyzeIndependent(parsed, options, budget, H) {
  const [first, second] = parsed.groups;
  const n1 = first.values.length;
  const n2 = second.values.length;
  const n = n1 + n2;
  const df = n - 2;
  const m1 = H.mean(first.values, budget);
  const m2 = H.mean(second.values, budget);
  const v1 = H.variance(first.values, true, budget);
  const v2 = H.variance(second.values, true, budget);
  const pooledVariance = ((n1 - 1) * v1 + (n2 - 1) * v2) / df;
  if (!(pooledVariance > 0)) H.fail("STAT_DEGENERATE", "pooled within-group variance is zero; standardized effects are undefined");
  const pooledSd = Math.sqrt(pooledVariance);
  const difference = m1 - m2;
  const d = difference / pooledSd;
  const scale = Math.sqrt(n1 * n2 / n);
  const t = d * scale;
  const level = options.confidenceLevel;
  const ncp = noncentralTInterval(t, df, level, H, budget);
  const dInterval = { lower: ncp.lower / scale, upper: ncp.upper / scale };
  const jExact = hedgesExactJ(H, df);
  const jApprox = hedgesApproximateJ(df);
  const control = parsed.groups[options.controlGroup];
  const controlVariance = options.controlGroup === 0 ? v1 : v2;
  if (!(controlVariance > 0)) H.fail("STAT_DEGENERATE", `control group ${control.name} has zero variance; Glass delta is undefined`);
  const glass = difference / Math.sqrt(controlVariance);
  const glassSe = Math.sqrt(n / (n1 * n2) + glass * glass / (2 * (control.values.length - 1)));
  const z = H.normalInv(1 - (1 - level) / 2);
  const aExact = n * (n - 2) / (n1 * n2);
  const toR = (value) => value / Math.sqrt(value * value + aExact);
  const r = toR(d);
  const f = t * t;
  const etaSquared = f / (f + df);
  const omegaSquared = (f - 1) / (f + df + 1);
  const epsilonSquared = (f - 1) / (f + df);
  const toEta = (value) => value * value / (value * value + aExact);
  const cles = normalCdf(H, d / Math.SQRT2);
  const superiority = probabilityOfSuperiority(H, first.values, second.values, budget);
  const pValue = H.pFromT(t, df, "two-sided");
  const nctMethod = "noncentral t (AS 243 series) on the pooled standardized difference";
  const rows = [
    effectRow("Cohen d", "standardized mean difference", d, dInterval, nctMethod, level),
    effectRow("Hedges g (exact J)", "standardized mean difference", d * jExact, transformInterval(dInterval.lower, dInterval.upper, (v) => v * jExact), `${nctMethod}, scaled by exact J`, level),
    effectRow("Hedges g (approximate J)", "standardized mean difference", d * jApprox, transformInterval(dInterval.lower, dInterval.upper, (v) => v * jApprox), `${nctMethod}, scaled by 1 - 3/(4 df - 1)`, level),
    effectRow(`Glass delta (control: ${control.name})`, "standardized mean difference", glass, { lower: glass - z * glassSe, upper: glass + z * glassSe }, "large-sample normal approximation", level),
    effectRow("point-biserial r", "correlation and variance explained", r, transformInterval(dInterval.lower, dInterval.upper, toR), "monotone transform of the noncentral-t d interval", level),
    effectRow("eta squared", "correlation and variance explained", etaSquared, squaredInterval(dInterval.lower, dInterval.upper, toEta), "transform of the noncentral-t d interval", level),
    effectRow("omega squared", "correlation and variance explained", omegaSquared, null, "point estimate only", level),
    effectRow("epsilon squared", "correlation and variance explained", epsilonSquared, null, "point estimate only", level),
    effectRow("common language effect size (normal)", "probability", cles, transformInterval(dInterval.lower, dInterval.upper, (v) => normalCdf(H, v / Math.SQRT2)), "normal transform of the noncentral-t d interval", level),
    effectRow("probability of superiority (nonparametric)", "probability", superiority, null, "point estimate only", level),
  ].map((row) => ({ ...row, estimate: finiteOrFail(H, row.estimate, row.name), lower: row.lower === null ? null : finiteOrFail(H, row.lower, `${row.name} lower`), upper: row.upper === null ? null : finiteOrFail(H, row.upper, `${row.name} upper`) }));
  return {
    sample: { design: "independent", n, groupSizes: [n1, n2], groups: [first.name, second.name] },
    estimates: [{ name: "design summary", firstMean: m1, secondMean: m2, meanDifference: difference, pooledSd, t, df, noncentralityLower: ncp.lower, noncentralityUpper: ncp.upper, hedgesJExact: jExact, hedgesJApproximate: jApprox }, ...rows],
    tests: [{ name: "pooled independent t test", statistic: t, distribution: "t", df, pValue }],
    diagnostics: [
      { name: "normality within groups", ...H.jarqueBera(first.values, budget), group: first.name },
      { name: "normality within groups", ...H.jarqueBera(second.values, budget), group: second.name },
      H.leveneDiagnostic([first, second], budget),
    ],
    assumptions: [{ name: "independent observations", status: "requires_design_review" }, { name: "normality within groups", status: "diagnostic_attached" }, { name: "equal variances for the pooled standardizer", status: "diagnostic_attached" }],
    rows,
    title: `Standardized effect sizes: ${first.name} vs ${second.name}`,
  };
}

function analyzePaired(parsed, options, budget, H) {
  const { x, y } = parsed;
  const n = x.length;
  const df = n - 1;
  const differences = x.map((value, index) => value - y[index]);
  const meanDifference = H.mean(differences, budget);
  const sdDifference = sampleSd(H, differences, budget);
  if (!(sdDifference > 0)) H.fail("STAT_DEGENERATE", "paired differences have zero variance; dz is undefined");
  const sdX = sampleSd(H, x, budget);
  const sdY = sampleSd(H, y, budget);
  if (!(sdX > 0) || !(sdY > 0)) H.fail("STAT_DEGENERATE", "a paired series is constant; d_av and d_rm are undefined");
  const correlation = H.correlation(x, y, budget);
  const dz = meanDifference / sdDifference;
  const dav = meanDifference / Math.sqrt((sdX * sdX + sdY * sdY) / 2);
  const drmDenominator = Math.sqrt(sdX * sdX + sdY * sdY - 2 * correlation * sdX * sdY);
  const drm = drmDenominator > 0 ? meanDifference / drmDenominator * Math.sqrt(2 * (1 - correlation)) : null;
  const t = dz * Math.sqrt(n);
  const level = options.confidenceLevel;
  const ncp = noncentralTInterval(t, df, level, H, budget);
  const dzInterval = { lower: ncp.lower / Math.sqrt(n), upper: ncp.upper / Math.sqrt(n) };
  const jExact = hedgesExactJ(H, df);
  const jApprox = hedgesApproximateJ(df);
  let positive = 0;
  let ties = 0;
  for (const value of differences) { budget.check(); if (value > 0) positive += 1; else if (value === 0) ties += 1; }
  const superiority = (positive + 0.5 * ties) / n;
  const nctMethod = "noncentral t (AS 243 series) on the standardized mean difference of pairs";
  const rows = [
    effectRow("Cohen dz", "standardized mean difference", dz, dzInterval, nctMethod, level),
    effectRow("Hedges gz (exact J)", "standardized mean difference", dz * jExact, transformInterval(dzInterval.lower, dzInterval.upper, (v) => v * jExact), `${nctMethod}, scaled by exact J`, level),
    effectRow("Hedges gz (approximate J)", "standardized mean difference", dz * jApprox, transformInterval(dzInterval.lower, dzInterval.upper, (v) => v * jApprox), `${nctMethod}, scaled by 1 - 3/(4 df - 1)`, level),
    effectRow("Cohen d_av (Cumming 2012)", "standardized mean difference", dav, null, "point estimate only", level),
    ...(drm === null ? [] : [effectRow("Cohen d_rm (Lakens 2013)", "standardized mean difference", drm, null, "point estimate only", level)]),
    effectRow("common language effect size (paired, normal)", "probability", normalCdf(H, dz), transformInterval(dzInterval.lower, dzInterval.upper, (v) => normalCdf(H, v)), "normal transform of the noncentral-t dz interval", level),
    effectRow("probability of superiority (paired, nonparametric)", "probability", superiority, null, "point estimate only", level),
  ].map((row) => ({ ...row, estimate: finiteOrFail(H, row.estimate, row.name) }));
  return {
    sample: { design: "paired", n, pairs: n, zeroDifferences: ties },
    estimates: [{ name: "design summary", meanDifference, sdDifference, sdX, sdY, pairCorrelation: correlation, t, df, noncentralityLower: ncp.lower, noncentralityUpper: ncp.upper, hedgesJExact: jExact, hedgesJApproximate: jApprox }, ...rows],
    tests: [{ name: "paired t test", statistic: t, distribution: "t", df, pValue: H.pFromT(t, df, "two-sided") }],
    diagnostics: [{ name: "normality of paired differences", ...H.jarqueBera(differences, budget) }, { name: "pair correlation", estimate: correlation, status: "reported", note: "d_rm depends on this correlation; d_av and dz do not use it directly" }],
    assumptions: [{ name: "independent pairs", status: "requires_design_review" }, { name: "normal paired differences", status: "diagnostic_attached" }],
    rows,
    title: `Standardized paired effect sizes: ${parsed.xLabel} - ${parsed.yLabel}`,
  };
}

function analyzeOneSample(parsed, options, budget, H) {
  const { values } = parsed;
  const n = values.length;
  const df = n - 1;
  const meanValue = H.mean(values, budget);
  const sd = sampleSd(H, values, budget);
  if (!(sd > 0)) H.fail("STAT_DEGENERATE", "values have zero variance; the one-sample d is undefined");
  const d = (meanValue - options.mu) / sd;
  const t = d * Math.sqrt(n);
  const level = options.confidenceLevel;
  const ncp = noncentralTInterval(t, df, level, H, budget);
  const dInterval = { lower: ncp.lower / Math.sqrt(n), upper: ncp.upper / Math.sqrt(n) };
  const jExact = hedgesExactJ(H, df);
  const jApprox = hedgesApproximateJ(df);
  const nctMethod = "noncentral t (AS 243 series) on the one-sample standardized difference";
  const rows = [
    effectRow(`Cohen d (vs ${options.mu})`, "standardized mean difference", d, dInterval, nctMethod, level),
    effectRow("Hedges g (exact J)", "standardized mean difference", d * jExact, transformInterval(dInterval.lower, dInterval.upper, (v) => v * jExact), `${nctMethod}, scaled by exact J`, level),
    effectRow("Hedges g (approximate J)", "standardized mean difference", d * jApprox, transformInterval(dInterval.lower, dInterval.upper, (v) => v * jApprox), `${nctMethod}, scaled by 1 - 3/(4 df - 1)`, level),
    effectRow("common language effect size (normal)", "probability", normalCdf(H, d), transformInterval(dInterval.lower, dInterval.upper, (v) => normalCdf(H, v)), "normal transform of the noncentral-t d interval", level),
  ];
  return {
    sample: { design: "one-sample", n, referenceValue: options.mu },
    estimates: [{ name: "design summary", mean: meanValue, sd, t, df, noncentralityLower: ncp.lower, noncentralityUpper: ncp.upper, hedgesJExact: jExact, hedgesJApproximate: jApprox }, ...rows],
    tests: [{ name: "one-sample t test", statistic: t, distribution: "t", df, pValue: H.pFromT(t, df, "two-sided") }],
    diagnostics: [{ name: "normality", ...H.jarqueBera(values, budget) }],
    assumptions: [{ name: "independent observations", status: "requires_design_review" }, { name: "normality", status: "diagnostic_attached" }],
    rows,
    title: `One-sample standardized effect: ${parsed.label}`,
  };
}

function analyzeAnova(parsed, options, budget, H) {
  const core = H.anovaCore(parsed.groups, budget);
  const { ssBetween, ssTotal, dfBetween, dfWithin, msWithin, f, n } = core;
  const etaSquared = ssBetween / ssTotal;
  const omegaSquared = (ssBetween - dfBetween * msWithin) / (ssTotal + msWithin);
  const epsilonSquared = (ssBetween - dfBetween * msWithin) / ssTotal;
  const cohenF = Math.sqrt(etaSquared / (1 - etaSquared));
  const level = options.confidenceLevel;
  const ncp = noncentralFInterval(f, dfBetween, dfWithin, level, H, budget);
  const toEta = (lambda) => lambda / (lambda + n);
  const etaInterval = { lower: toEta(ncp.lower), upper: toEta(ncp.upper) };
  const toF = (eta) => Math.sqrt(eta / (1 - eta));
  const ncfMethod = "noncentral F (Poisson-beta mixture) inverted on the F statistic; eta squared = ncp / (ncp + N)";
  const rows = [
    effectRow("eta squared", "correlation and variance explained", etaSquared, etaInterval, ncfMethod, level),
    effectRow("partial eta squared", "correlation and variance explained", etaSquared, etaInterval, `${ncfMethod}; identical to eta squared in a one-way design`, level),
    effectRow("omega squared", "correlation and variance explained", omegaSquared, null, "point estimate only", level),
    effectRow("epsilon squared", "correlation and variance explained", epsilonSquared, null, "point estimate only", level),
    effectRow("Cohen f", "standardized mean difference", cohenF, transformInterval(etaInterval.lower, etaInterval.upper, toF), "monotone transform of the noncentral-F eta squared interval", level),
  ];
  return {
    sample: { design: "anova", n, groups: parsed.groups.length, groupSizes: parsed.groups.map((group) => group.values.length) },
    estimates: [{ name: "design summary", ssBetween, ssWithin: core.ssWithin, ssTotal, dfBetween, dfWithin, msBetween: core.msBetween, msWithin, f, noncentralityLower: ncp.lower, noncentralityUpper: ncp.upper }, ...rows],
    tests: [{ name: "one-way ANOVA F test", statistic: f, distribution: "F", df1: dfBetween, df2: dfWithin, pValue: H.pFromF(f, dfBetween, dfWithin) }],
    diagnostics: [
      H.leveneDiagnostic(parsed.groups, budget),
      { name: "noncentral F interval boundary", status: ncp.lowerAtBoundary ? "lower_bound_truncated_at_zero" : "interior", detail: "lower eta squared bound is 0 when the central F already exceeds the upper tail target" },
    ],
    assumptions: [{ name: "independent observations", status: "requires_design_review" }, { name: "normality within groups", status: "requires_design_review" }, { name: "equal variances", status: "diagnostic_attached" }],
    rows,
    title: `Variance-explained effect sizes across ${parsed.groups.length} groups`,
  };
}

const standardizedEffectSizes = {
  method: "standardized_effect_sizes",
  family: "effect-size",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    design: {
      schema: { type: "string", enum: [...DESIGNS] },
      default: "independent",
      parse(value, H, path) {
        if (!DESIGNS.includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be one of ${DESIGNS.join(", ")}`);
        return value;
      },
    },
    controlGroup: {
      schema: { type: "integer", enum: [0, 1] },
      default: 1,
      parse(value, H, path) { return H.integer(value, 0, 1, path); },
    },
    mu: {
      schema: { type: "number" },
      default: 0,
      parse(value, H, path) { return H.finiteNumber(value, path); },
    },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      groups: { type: "array", minItems: 2, maxItems: 64, items: { type: "object", additionalProperties: false, required: ["values"], properties: { name: { type: "string", minLength: 1, maxLength: 128 }, values: { type: "array", minItems: 2, maxItems: 100000, items: { type: "number" } } } } },
      x: { type: "array", minItems: 3, maxItems: 100000, items: { type: "number" } },
      y: { type: "array", minItems: 3, maxItems: 100000, items: { type: "number" } },
      xLabel: { type: "string", minLength: 1, maxLength: 128 },
      yLabel: { type: "string", minLength: 1, maxLength: 128 },
      values: { type: "array", minItems: 3, maxItems: 100000, items: { type: "number" } },
      label: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["groups", "x", "y", "xLabel", "yLabel", "values", "label"], "data");
    const design = options.design;
    const forbid = (keys) => {
      const present = keys.filter((key) => data[key] !== undefined);
      if (present.length) H.fail("STAT_INVALID_INPUT", `data.${present[0]} is not used by design ${design}`);
    };
    if (design === "independent" || design === "anova") {
      forbid(["x", "y", "xLabel", "yLabel", "values", "label"]);
      if (data.groups === undefined) H.fail("STAT_INVALID_INPUT", `design ${design} requires data.groups`);
      const groups = H.parseGroups({ groups: data.groups }, 2, design === "independent" ? 2 : undefined);
      const minimum = design === "independent" ? 3 : 2;
      for (const group of groups) {
        if (group.values.length < minimum) H.fail("STAT_INSUFFICIENT_SAMPLE", `group ${group.name} needs at least ${minimum} observations for design ${design}`);
      }
      return { design, groups };
    }
    if (design === "paired") {
      forbid(["groups", "values", "label"]);
      if (data.x === undefined || data.y === undefined) H.fail("STAT_INVALID_INPUT", "design paired requires data.x and data.y");
      const x = H.numericVector(data.x, "data.x", 3);
      const y = H.numericVector(data.y, "data.y", 3);
      if (x.length !== y.length) H.fail("STAT_INVALID_INPUT", "data.x and data.y must have the same length for a paired design");
      return { design, x, y, xLabel: H.label(data.xLabel, "X", "data.xLabel"), yLabel: H.label(data.yLabel, "Y", "data.yLabel") };
    }
    forbid(["groups", "x", "y", "xLabel", "yLabel"]);
    if (data.values === undefined) H.fail("STAT_INVALID_INPUT", "design one-sample requires data.values");
    return { design, values: H.numericVector(data.values, "data.values", 3), label: H.label(data.label, "Value", "data.label") };
  },
  analyze(parsed, options, budget, H) {
    const inner = parsed.design === "independent" ? analyzeIndependent(parsed, options, budget, H)
      : parsed.design === "paired" ? analyzePaired(parsed, options, budget, H)
        : parsed.design === "one-sample" ? analyzeOneSample(parsed, options, budget, H)
          : analyzeAnova(parsed, options, budget, H);
    const level = options.confidenceLevel;
    const withInterval = inner.rows.filter((row) => row.lower !== null && row.upper !== null);
    return {
      sample: inner.sample,
      estimates: inner.estimates,
      tests: inner.tests,
      confidenceIntervals: withInterval.map((row) => ({ parameter: row.name, level, lower: row.lower, upper: row.upper, method: row.method })),
      effectSizes: inner.rows.map((row) => ({ name: row.name, estimate: row.estimate, family: row.family, ...(row.lower === null ? {} : { lower: row.lower, upper: row.upper }) })),
      assumptions: inner.assumptions,
      diagnostics: [
        ...inner.diagnostics,
        { name: "interval boundary", status: "noncentral_parametric", detail: "noncentral t/F intervals assume normal data; Glass delta uses a large-sample normal approximation; omega, epsilon, and nonparametric superiority are reported without intervals" },
        { name: "small-sample correction", status: "reported", detail: "Hedges exact J uses the gamma-function ratio; the approximate J is 1 - 3/(4 df - 1)" },
      ],
      artifacts: [
        H.tableArtifact(inner.title, `${Math.round(level * 100)}% intervals where estimable; family labels group comparable scales.`, EFFECT_COLUMNS, inner.rows, ["Rows without intervals are point estimates only; do not treat absence of an interval as precision."], "effect-size-table"),
        H.vegaArtifact("effect-size-forest", inner.title, effectForest(inner.rows, `Effect sizes with ${Math.round(level * 100)}% intervals, faceted by scale family`)),
      ],
    };
  },
  linkage: {
    neededWhen: "A comparison of means or an ANOVA is significant or not and the researcher must report how large the difference is on a standardized scale.",
    decision: "Whether the observed difference is practically meaningful, which standardized metric to report, and how wide its uncertainty is.",
    mustShow: "The point estimate on each requested scale with a noncentral-distribution interval, the standardizer used, and the design assumptions.",
    userGoal: "Report a defensible standardized effect size with a confidence interval alongside the hypothesis test result.",
    nextActions: [
      { trigger: "interval-includes-zero", action: "report-as-inconclusive-magnitude", reason: "An interval spanning zero means the direction of the effect is not resolved by this sample." },
      { trigger: "unequal-variances", action: "prefer-glass-delta-or-welch", reason: "A pooled standardizer is misleading when the groups differ in spread; use the control standard deviation." },
      { trigger: "small-sample", action: "report-hedges-g-exact", reason: "Cohen d is biased upward in small samples and the exact J correction removes that bias." },
      { trigger: "non-normal-data", action: "report-probability-of-superiority", reason: "The nonparametric superiority probability does not rely on the normal model behind d." },
    ],
  },
  fixture: {
    data: { groups: [{ name: "Treatment", values: [5.1, 6.3, 4.8, 7.2, 6.9, 5.5, 6.1, 7.8, 5.9, 6.6] }, { name: "Control", values: [4.2, 5.0, 3.9, 5.6, 4.7, 4.4, 5.3, 4.1, 4.9, 5.2] }] },
    options: { confidenceLevel: 0.95, design: "independent", controlGroup: 1 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.location", "matlab.stats.anova"] },
  coverage: {
    implementedBoundary: "Cohen d, Hedges g (exact and approximate J), Glass delta, point-biserial r, eta/omega/epsilon squared, common-language effect size, and probability of superiority for independent, paired, one-sample, and one-way ANOVA designs with noncentral t or F intervals.",
    oracle: {
      level: "external-library-partial",
      evidence: ["contracts/effect-sizes-scipy-crosscheck.py"],
      verifiedOutputs: ["Cohen d", "Hedges g approximate", "Hedges g exact", "Glass delta", "point-biserial r", "eta squared", "omega squared", "epsilon squared", "common language effect size", "probability of superiority", "Cohen dz", "Cohen d_av", "one-sample d", "Cohen f", "noncentral t interval bounds", "noncentral F interval bounds"],
      excludedOutputs: ["Glass delta interval", "Cohen d_rm", "paired common language effect size", "transformed intervals for r, eta squared, and probability scales"],
    },
    diagnostic: { level: "method-specific-partial", emitted: ["Jarque-Bera normality", "Levene-type variance screen", "pair correlation", "noncentral F boundary flag"], limitations: ["no bootstrap intervals", "no multi-factor partial eta squared", "no robust standardizers"] },
    knownGaps: ["factorial designs and covariate-adjusted effect sizes are not covered", "intervals for omega and epsilon squared are not provided", "Glass delta interval is a large-sample normal approximation only"],
  },
};

const SCALE_LABELS = Object.freeze({ d: "Cohen d", r: "correlation r", "odds-ratio": "odds ratio", "log-odds-ratio": "log odds ratio", "eta-squared": "eta squared", f: "Cohen f" });

const effectSizeConversion = {
  method: "effect_size_conversion",
  family: "effect-size",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian", "binomial"], links: [null, "identity", "logit"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["value", "from"],
    properties: {
      value: { type: "number" },
      from: { type: "string", enum: [...SCALES] },
      to: { type: "string", enum: [...SCALES] },
      n1: { type: "integer", minimum: 2, maximum: 100000 },
      n2: { type: "integer", minimum: 2, maximum: 100000 },
      n: { type: "integer", minimum: 4, maximum: 200000 },
      standardError: { type: "number", exclusiveMinimum: 0 },
      label: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["value", "from", "to", "n1", "n2", "n", "standardError", "label"], "data");
    const value = H.finiteNumber(data.value, "data.value");
    if (!SCALES.includes(data.from)) H.fail("STAT_INVALID_INPUT", `data.from must be one of ${SCALES.join(", ")}`);
    if (data.to !== undefined && !SCALES.includes(data.to)) H.fail("STAT_INVALID_INPUT", `data.to must be one of ${SCALES.join(", ")}`);
    const hasN1 = data.n1 !== undefined;
    const hasN2 = data.n2 !== undefined;
    if (hasN1 !== hasN2) H.fail("STAT_INVALID_INPUT", "data.n1 and data.n2 must be supplied together");
    if (hasN1 && data.n !== undefined) H.fail("STAT_INVALID_INPUT", "supply either data.n or data.n1 with data.n2, not both");
    let n1 = null;
    let n2 = null;
    let sizeSource = "none";
    if (hasN1) {
      n1 = H.integer(data.n1, 2, 100000, "data.n1");
      n2 = H.integer(data.n2, 2, 100000, "data.n2");
      sizeSource = "supplied";
    } else if (data.n !== undefined) {
      const n = H.integer(data.n, 4, 200000, "data.n");
      n1 = Math.floor(n / 2);
      n2 = n - n1;
      sizeSource = "balanced-split";
    }
    const standardError = data.standardError === undefined ? null : H.finiteNumber(data.standardError, "data.standardError");
    if (standardError !== null && !(standardError > 0)) H.fail("STAT_INVALID_INPUT", "data.standardError must be positive");
    switch (data.from) {
      case "r": if (!(Math.abs(value) < 1)) H.fail("STAT_INVALID_INPUT", "a correlation must lie strictly inside (-1, 1)"); break;
      case "odds-ratio": if (!(value > 0)) H.fail("STAT_INVALID_INPUT", "an odds ratio must be positive"); break;
      case "eta-squared": if (!(value >= 0 && value < 1)) H.fail("STAT_INVALID_INPUT", "eta squared must lie in [0, 1)"); break;
      case "f": if (!(value >= 0)) H.fail("STAT_INVALID_INPUT", "Cohen f must be non-negative"); break;
      default: break;
    }
    return { value, from: data.from, to: data.to === undefined ? null : data.to, n1, n2, sizeSource, standardError, label: H.label(data.label, "Effect", "data.label") };
  },
  analyze(parsed, options, budget, H) {
    const { value, from, standardError } = parsed;
    const a = parsed.n1 === null ? 4 : (parsed.n1 + parsed.n2) ** 2 / (parsed.n1 * parsed.n2);
    const sqrtA = Math.sqrt(a);
    const piOverSqrt3 = Math.PI / Math.sqrt(3);
    let d;
    let derivativeDFromSource;
    let signRecoverable = true;
    switch (from) {
      case "d": d = value; derivativeDFromSource = 1; break;
      case "r": d = value * sqrtA / Math.sqrt(1 - value * value); derivativeDFromSource = sqrtA * Math.pow(1 - value * value, -1.5); break;
      case "odds-ratio": d = Math.log(value) / piOverSqrt3; derivativeDFromSource = 1 / (piOverSqrt3 * value); break;
      case "log-odds-ratio": d = value / piOverSqrt3; derivativeDFromSource = 1 / piOverSqrt3; break;
      case "eta-squared": d = Math.sqrt(a * value / (1 - value)); derivativeDFromSource = value > 0 ? sqrtA / (2 * Math.sqrt(value) * Math.pow(1 - value, 1.5)) : null; signRecoverable = false; break;
      case "f": d = value * sqrtA; derivativeDFromSource = sqrtA; signRecoverable = false; break;
      default: H.fail("STAT_INTERNAL", "unreachable conversion scale");
    }
    d = finiteOrFail(H, d, "Cohen d");
    const dVariance = standardError === null || derivativeDFromSource === null ? null : standardError * standardError * derivativeDFromSource * derivativeDFromSource;
    const z = H.normalInv(1 - (1 - options.confidenceLevel) / 2);
    const targets = [
      { scale: "d", estimate: d, derivative: 1, derivation: from === "d" ? "identity" : `d from ${SCALE_LABELS[from]}` },
      { scale: "r", estimate: d / Math.sqrt(d * d + a), derivative: a * Math.pow(d * d + a, -1.5), derivation: `r = d / sqrt(d^2 + a), a = ${parsed.n1 === null ? "4" : "(n1 + n2)^2 / (n1 n2)"}` },
      { scale: "log-odds-ratio", estimate: d * piOverSqrt3, derivative: piOverSqrt3, derivation: "log OR = d * pi / sqrt(3)" },
      { scale: "odds-ratio", estimate: Math.exp(d * piOverSqrt3), derivative: Math.exp(d * piOverSqrt3) * piOverSqrt3, derivation: "OR = exp(d * pi / sqrt(3)); interval on the log scale" },
      { scale: "eta-squared", estimate: d * d / (d * d + a), derivative: 2 * a * d * Math.pow(d * d + a, -2), derivation: "eta^2 = d^2 / (d^2 + a)" },
      { scale: "f", estimate: Math.abs(d) / sqrtA, derivative: 1 / sqrtA, derivation: "f = |d| / sqrt(a)" },
    ];
    const rows = targets.map((target) => {
      budget.check();
      const estimate = finiteOrFail(H, target.estimate, target.scale);
      const se = dVariance === null ? null : Math.sqrt(dVariance) * Math.abs(target.derivative);
      let lower = null;
      let upper = null;
      if (se !== null) {
        if (target.scale === "odds-ratio") {
          const logSe = Math.sqrt(dVariance) * piOverSqrt3;
          lower = Math.exp(d * piOverSqrt3 - z * logSe);
          upper = Math.exp(d * piOverSqrt3 + z * logSe);
        } else {
          lower = estimate - z * se;
          upper = estimate + z * se;
        }
        if (![lower, upper].every(Number.isFinite)) H.fail("STAT_NUMERIC_OVERFLOW", `${target.scale} interval exceeded the numeric boundary`);
      }
      return { scale: target.scale, scaleLabel: SCALE_LABELS[target.scale], estimate, standardError: se, lower, upper, derivation: target.derivation, isSource: target.scale === from, isTarget: parsed.to === target.scale };
    });
    const target = parsed.to === null ? null : rows.find((row) => row.scale === parsed.to);
    return {
      sample: { source: from, sourceValue: value, target: parsed.to, n1: parsed.n1, n2: parsed.n2, sampleSizeSource: parsed.sizeSource, standardErrorSupplied: standardError !== null },
      estimates: [{ name: "conversion hub", cohenD: d, cohenDVariance: dVariance, correlationConstant: a, targetScale: target ? target.scale : null, targetEstimate: target ? target.estimate : null, targetStandardError: target ? target.standardError : null, targetLower: target ? target.lower : null, targetUpper: target ? target.upper : null }, ...rows.map((row) => ({ name: row.scaleLabel, ...row }))],
      tests: [],
      confidenceIntervals: rows.filter((row) => row.lower !== null).map((row) => ({ parameter: row.scaleLabel, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: row.scale === "odds-ratio" ? "delta method on the log odds scale" : "delta method normal approximation" })),
      effectSizes: rows.map((row) => ({ name: row.scaleLabel, estimate: row.estimate, ...(row.standardError === null ? {} : { standardError: row.standardError }) })),
      assumptions: [
        { name: "logistic-normal link between d and log odds", status: "method_definition", detail: "log OR = d * pi / sqrt(3) assumes a logistic latent distribution" },
        { name: "two-group point-biserial link between d and r", status: parsed.n1 === null ? "balanced_groups_assumed" : "group_sizes_supplied", correlationConstant: a },
        { name: "one-way two-group variance explained", status: "method_definition", detail: "eta squared is interpreted as the two-group point-biserial r squared" },
      ],
      diagnostics: [
        { name: "sign recovery", status: signRecoverable ? "sign_preserved" : "sign_not_recoverable", detail: signRecoverable ? "the source scale carries direction" : `${SCALE_LABELS[from]} is unsigned, so d and its signed conversions are reported as non-negative` },
        { name: "variance propagation", status: dVariance === null ? (standardError === null ? "no_standard_error_supplied" : "derivative_undefined_at_zero") : "delta_method", detail: "first-order delta method through Cohen d; intervals are normal approximations and can exceed natural bounds for r or eta squared" },
        { name: "sample sizes", status: parsed.sizeSource === "none" ? "assumed_balanced_constant_4" : parsed.sizeSource === "balanced-split" ? "total_split_evenly" : "supplied", n1: parsed.n1, n2: parsed.n2 },
      ],
      artifacts: [
        H.tableArtifact(`Effect-size conversions from ${SCALE_LABELS[from]} = ${value}`, `Every reachable scale with delta-method ${Math.round(options.confidenceLevel * 100)}% intervals when a standard error was supplied.`, [
          { key: "scale", label: "Scale id", type: "string" }, { key: "scaleLabel", label: "Scale", type: "string" }, { key: "estimate", label: "Estimate", type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "lower", label: "CI lower", type: "number" }, { key: "upper", label: "CI upper", type: "number" }, { key: "derivation", label: "Derivation", type: "string" }, { key: "isSource", label: "Source", type: "boolean" }, { key: "isTarget", label: "Requested target", type: "boolean" },
        ], rows, ["Conversions pass through Cohen d; unsigned sources (eta squared, f) lose direction."], "effect-conversion-table"),
        H.vegaArtifact("effect-conversion-chart", `Converted effect sizes from ${SCALE_LABELS[from]}`, {
          data: { values: rows },
          facet: { row: { field: "scaleLabel", type: "nominal", title: null, sort: null, header: { labelAngle: 0, labelAlign: "left" } } },
          resolve: { scale: { x: "independent" } },
          spec: {
            width: 420,
            height: 28,
            layer: [
              { mark: { type: "rule", strokeWidth: 2, color: "#285f8f" }, encoding: { x: { field: "lower", type: "quantitative", title: "Estimate" }, x2: { field: "upper" } } },
              { mark: { type: "point", filled: true, size: 110 }, encoding: { x: { field: "estimate", type: "quantitative" }, color: { field: "isSource", type: "nominal", title: "Source scale", scale: { domain: [true, false], range: ["#a33c2f", "#1f3f5f"] } }, tooltip: [{ field: "scaleLabel" }, { field: "estimate", format: ".4g" }, { field: "standardError", format: ".4g" }, { field: "derivation" }] } },
            ],
          },
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "Studies or reports express the same effect on different scales and must be compared, pooled, or re-expressed for a target audience.",
    decision: "Which common scale to use for synthesis and how much uncertainty the conversion carries once the sampling error is propagated.",
    mustShow: "The source value, the assumed conversion constants, every converted value, and delta-method intervals when a standard error was given.",
    userGoal: "Translate an effect size into the scale required for a meta-analysis, a power calculation, or a plain-language summary.",
    nextActions: [
      { trigger: "no-standard-error", action: "recover-standard-error-from-source", reason: "Without a standard error the converted values carry no uncertainty and cannot enter a weighted synthesis." },
      { trigger: "unsigned-source-scale", action: "confirm-direction-from-primary-report", reason: "Eta squared and Cohen f do not carry direction, so the sign of d must come from the original study." },
      { trigger: "unbalanced-groups", action: "supply-group-sizes", reason: "The d to r conversion constant depends on group sizes; the default assumes balanced groups." },
      { trigger: "interval-exceeds-natural-bounds", action: "report-on-source-scale", reason: "Delta-method intervals can leave [-1, 1] or [0, 1); use the source scale or a transformed interval instead." },
    ],
  },
  fixture: { data: { value: 0.65, from: "d", to: "odds-ratio", n1: 24, n2: 26, standardError: 0.29, label: "Intervention effect" }, options: { confidenceLevel: 0.95 } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.location"] },
  coverage: {
    implementedBoundary: "Conversions among Cohen d, correlation r, odds ratio, log odds ratio, eta squared, and Cohen f through Cohen d with first-order delta-method variance propagation.",
    oracle: {
      level: "external-library-partial",
      evidence: ["contracts/effect-sizes-scipy-crosscheck.py"],
      verifiedOutputs: ["d to r (balanced constant)", "d to eta squared", "d to odds ratio", "r to d", "log odds ratio to d", "delta-method standard errors"],
      excludedOutputs: ["group-size-specific correlation constant beyond a first-principles recomputation", "eta squared and f sources beyond a first-principles recomputation"],
    },
    diagnostic: { level: "basic", emitted: ["sign recovery", "variance propagation status", "sample-size assumption"], limitations: ["no bounds-respecting transformed intervals", "no conversions for hazard ratios or standardized regression coefficients"] },
    knownGaps: ["conversions assume a two-group design; multi-group eta squared cannot be mapped to a single d", "no correction for dichotomization or measurement reliability"],
  },
};

module.exports = { methods: [standardizedEffectSizes, effectSizeConversion] };
