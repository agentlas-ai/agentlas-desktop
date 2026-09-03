"use strict";

/**
 * Assumption tests: normality (Shapiro-Wilk, Anderson-Darling, D'Agostino K2), variance
 * homogeneity (Levene, Bartlett, Fligner-Killeen), two-sample Kolmogorov-Smirnov,
 * residual autocorrelation (Durbin-Watson), heteroscedasticity (Breusch-Pagan, White)
 * and multicollinearity (variance inflation factors).
 */

const { createSupport } = require("./shared-precision-distributions.cjs");

const ORACLE = "contracts/assumption-tests-scipy-crosscheck.py";
const LABEL_SCHEMA = { type: "string", minLength: 1, maxLength: 128 };
const GROUPS_SCHEMA = {
  type: "array",
  minItems: 2,
  maxItems: 64,
  items: { type: "object", additionalProperties: false, required: ["values"], properties: { name: LABEL_SCHEMA, values: { type: "array", minItems: 2, maxItems: 100000, items: { type: "number" } } } },
};
const PREDICTOR_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: 48,
  items: { type: "object", additionalProperties: false, required: ["values"], properties: { name: LABEL_SCHEMA, type: { type: "string", enum: ["numeric", "categorical"] }, values: { type: "array", minItems: 4, maxItems: 5000, items: { type: ["number", "string"] } }, reference: LABEL_SCHEMA } },
};
const QQ_COLUMNS = [
  { key: "order", label: "Order", type: "number" },
  { key: "probability", label: "Plotting position", type: "number" },
  { key: "theoreticalQuantile", label: "Theoretical quantile", type: "number" },
  { key: "sampleValue", label: "Sample value", type: "number" },
  { key: "standardizedValue", label: "Standardized value", type: "number" },
];
const DISPERSION_COLUMNS = [
  { key: "group", label: "Group", type: "string" },
  { key: "n", label: "N", type: "number" },
  { key: "center", label: "Center", type: "number" },
  { key: "variance", label: "Variance", type: "number" },
  { key: "sd", label: "SD", type: "number" },
  { key: "meanAbsoluteDeviation", label: "Mean |deviation from center|", type: "number" },
];
const RESIDUAL_COLUMNS = [
  { key: "row", label: "Row", type: "number" },
  { key: "fitted", label: "Fitted", type: "number" },
  { key: "residual", label: "Residual", type: "number" },
  { key: "squaredResidual", label: "Squared residual", type: "number" },
];

function parseValues(data, H, minimum, maximum) {
  H.assertKeys(data, ["values", "label"], "data");
  const values = H.numericVector(data.values, "data.values", minimum);
  if (values.length > maximum) H.fail("STAT_LIMIT_EXCEEDED", `data.values length must be at most ${maximum}`);
  if (H.minMax(values).min === H.minMax(values).max) H.fail("STAT_DEGENERATE", "data.values are constant");
  return { values, label: H.label(data.label, "Value", "data.label") };
}

function parseGroups(data, H) {
  H.assertKeys(data, ["groups", "outcomeLabel"], "data");
  const groups = H.parseGroups({ groups: data.groups }, 2);
  return { groups, outcomeLabel: H.label(data.outcomeLabel, "Outcome", "data.outcomeLabel") };
}

function parseRegression(data, H, extraKeys = []) {
  H.assertKeys(data, ["y", "predictors", "outcomeLabel", ...extraKeys], "data");
  const y = H.numericVector(data.y, "data.y", 8);
  if (y.length > 5000) H.fail("STAT_LIMIT_EXCEEDED", "data.y length must be at most 5000");
  const predictors = H.regressionPredictors(data.predictors, y.length);
  return { y, predictors, outcomeLabel: H.label(data.outcomeLabel, "Outcome", "data.outcomeLabel") };
}

function fitDesign(parsed, options, H, S, budget) {
  const design = H.designMatrix({ y: parsed.y, predictors: parsed.predictors }, options.intercept !== false);
  if (parsed.y.length <= design.x[0].length) H.fail("STAT_INSUFFICIENT_SAMPLE", "regression needs more observations than model columns");
  if (H.matrixRank(design.x) < design.x[0].length) H.fail("STAT_RANK_DEFICIENT", "regression design matrix is rank deficient");
  const fit = S.olsFit(parsed.y, design.x, budget);
  return { design, fit };
}

function residualRows(fit) {
  return fit.fitted.map((value, index) => ({ row: index + 1, fitted: value, residual: fit.residuals[index], squaredResidual: fit.residuals[index] ** 2 }));
}

function residualFigure(H, role, title, rows) {
  return H.vegaArtifact(role, title, {
    data: { values: rows },
    layer: [
      { mark: { type: "rule", strokeDash: [4, 4], color: "#888888" }, encoding: { y: { datum: 0 } } },
      { mark: { type: "point", filled: true, size: 40 }, encoding: { x: { field: "fitted", type: "quantitative", title: "Fitted value" }, y: { field: "residual", type: "quantitative", title: "Residual" }, tooltip: [{ field: "row" }, { field: "fitted", format: ".5g" }, { field: "residual", format: ".5g" }] } },
    ],
  });
}

function normalityCommon(H, S, parsed, budget) {
  const rows = S.qqRows(parsed.values, budget);
  const stats = H.descriptiveStats(parsed.values, budget);
  return { rows, stats };
}

function normalityArtifacts(H, S, parsed, rows, tableRole, figureRole, testTitle, testColumns, testRows, notes) {
  return [
    H.tableArtifact(testTitle, `${testTitle} for ${parsed.label}.`, testColumns, testRows, notes, tableRole),
    H.tableArtifact("Normal Q-Q rows", "Ordered sample values against Blom plotting-position normal quantiles.", QQ_COLUMNS, rows, [], "qq-table"),
    S.qqArtifact(figureRole, `Normal Q-Q plot of ${parsed.label}`, rows, parsed.label),
  ];
}

function normalityLinkage(name) {
  return {
    neededWhen: `Before relying on a t test, ANOVA, or Gaussian regression for a small or moderate sample, when the ${name} screen must document whether the normal-error assumption is defensible.`,
    decision: "Whether the normal model is adequate for the intended parametric method or whether a transformation, robust or rank-based alternative should be prespecified.",
    mustShow: "Sample size, the test statistic and p, the Q-Q plot with the ordered values, skewness and kurtosis, and the caution that large samples reject trivial departures while small samples miss real ones.",
    userGoal: "Justify or replace a normality-dependent analysis with visible evidence rather than a bare p-value.",
    nextActions: [
      { trigger: "normality-rejected-with-visible-tail-departure", action: "compare-transformation-or-rank-based-analysis", reason: "A rejected normality screen with heavy tails changes the calibration of mean-based inference." },
      { trigger: "large-sample-rejection-with-mild-qq-departure", action: "proceed-with-parametric-analysis-and-report-qq", reason: "With large samples the central limit theorem protects mean inference even when the screen rejects." },
      { trigger: "small-sample-non-rejection", action: "treat-as-inconclusive-and-report-qq", reason: "A non-significant screen in a small sample is weak evidence of normality." },
    ],
  };
}

// ---------------------------------------------------------------------------------
// Shapiro-Wilk (Royston 1995, AS R94)
// ---------------------------------------------------------------------------------

function polynomial(coefficients, x) {
  let result = coefficients[0];
  if (coefficients.length > 1) {
    let p = x * coefficients[coefficients.length - 1];
    for (let j = coefficients.length - 2; j > 0; j -= 1) p = (p + coefficients[j]) * x;
    result += p;
  }
  return result;
}

function shapiroWilkCore(sortedValues, S, budget) {
  const n = sortedValues.length;
  const nn2 = Math.floor(n / 2);
  const g = [-2.273, 0.459];
  const c1 = [0, 0.221157, -0.147981, -2.07119, 4.434685, -2.706056];
  const c2 = [0, 0.042981, -0.293762, -1.752461, 5.682633, -3.582633];
  const c3 = [0.544, -0.39978, 0.025054, -6.714e-4];
  const c4 = [1.3822, -0.77857, 0.062767, -0.0020322];
  const c5 = [-1.5861, -0.31082, -0.083751, 0.0038915];
  const c6 = [-0.4803, -0.082676, 0.0030302];
  const a = Array(nn2).fill(0);
  if (n === 3) a[0] = Math.SQRT1_2;
  else {
    const an25 = n + 0.25;
    let summ2 = 0;
    const m = [];
    for (let i = 1; i <= nn2; i += 1) {
      budget.check();
      m[i - 1] = S.qnorm((i - 0.375) / an25);
      summ2 += m[i - 1] * m[i - 1];
    }
    summ2 *= 2;
    const ssumm2 = Math.sqrt(summ2);
    const rsn = 1 / Math.sqrt(n);
    const a1 = polynomial(c1, rsn) - m[0] / ssumm2;
    let i1;
    let fac;
    if (n > 5) {
      i1 = 3;
      const a2 = -m[1] / ssumm2 + polynomial(c2, rsn);
      fac = Math.sqrt((summ2 - 2 * m[0] * m[0] - 2 * m[1] * m[1]) / (1 - 2 * a1 * a1 - 2 * a2 * a2));
      a[1] = a2;
    } else {
      i1 = 2;
      fac = Math.sqrt((summ2 - 2 * m[0] * m[0]) / (1 - 2 * a1 * a1));
    }
    a[0] = a1;
    for (let i = i1; i <= nn2; i += 1) a[i - 1] = -m[i - 1] / fac;
  }
  // Antisymmetric coefficient vector c_i (lower half -a, upper half +a, zero centre).
  const coefficients = Array(n).fill(0);
  for (let i = 0; i < nn2; i += 1) {
    coefficients[i] = -a[i];
    coefficients[n - 1 - i] = a[i];
  }
  let sumX = 0;
  for (const value of sortedValues) sumX += value;
  const meanX = sumX / n;
  let sax = 0;
  let ssa = 0;
  let ssx = 0;
  for (let i = 0; i < n; i += 1) {
    budget.check();
    const dx = sortedValues[i] - meanX;
    sax += coefficients[i] * dx;
    ssa += coefficients[i] * coefficients[i];
    ssx += dx * dx;
  }
  const w = (sax * sax) / (ssa * ssx);
  const w1 = 1 - w;
  let pValue;
  if (n === 3) {
    const pi6 = 1.90985931710274;
    const stqr = 1.04719755119660;
    pValue = Math.max(0, pi6 * (Math.asin(Math.sqrt(w)) - stqr));
  } else {
    let y = Math.log(w1);
    const logN = Math.log(n);
    let mu;
    let sigma;
    if (n <= 11) {
      const gamma = polynomial(g, n);
      if (y >= gamma) return { w, pValue: 1e-99, coefficients };
      y = -Math.log(gamma - y);
      mu = polynomial(c3, n);
      sigma = Math.exp(polynomial(c4, n));
    } else {
      mu = polynomial(c5, logN);
      sigma = Math.exp(polynomial(c6, logN));
    }
    pValue = S.pnormUpper((y - mu) / sigma);
  }
  return { w, pValue: Math.min(1, Math.max(0, pValue)), coefficients };
}

const shapiroWilk = {
  method: "shapiro_wilk",
  family: "assumption-tests",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["timeoutMs"],
  dataSchema: { type: "object", additionalProperties: false, required: ["values"], properties: { values: { type: "array", minItems: 3, maxItems: 5000, items: { type: "number" } }, label: LABEL_SCHEMA } },
  parse(data, options, H) {
    const parsed = parseValues(data, H, 3, 5000);
    if (parsed.values.length < 3) H.fail("STAT_INSUFFICIENT_SAMPLE", "shapiro_wilk requires at least 3 observations");
    return parsed;
  },
  analyze(parsed, options, budget, H) {
    const S = createSupport(H);
    const { rows, stats } = normalityCommon(H, S, parsed, budget);
    const sortedValues = H.sorted(parsed.values);
    const { w, pValue } = shapiroWilkCore(sortedValues, S, budget);
    const n = parsed.values.length;
    const testRows = [{ n, statistic: w, pValue, skewness: stats.skewness, excessKurtosis: stats.excessKurtosis }];
    return {
      sample: { n },
      estimates: [{ name: "Shapiro-Wilk W", estimate: w }, { name: "skewness", estimate: stats.skewness }, { name: "excess kurtosis", estimate: stats.excessKurtosis }, { name: "renderer data contract", inlineRows: "all", sampling: "none", aggregation: "none", rowCount: rows.length, qqRowsHash: H.sha256(rows), tableRole: "qq-table", vegaRole: "qq-plot" }],
      tests: [{ name: "Shapiro-Wilk normality", statistic: w, distribution: "Royston (1995) normalizing transformation", df: null, pValue, method: n <= 11 ? "small-sample polynomial" : "log-n polynomial" }],
      confidenceIntervals: [],
      effectSizes: [],
      assumptions: [{ name: "independent identically distributed observations", status: "requires_design_review" }, { name: "no ties from coarse measurement", status: new Set(parsed.values).size === n ? "verified_by_input" : "warning_ties_present" }],
      diagnostics: [
        { name: "Jarque-Bera normality", ...H.jarqueBera(parsed.values, budget) },
        { name: "sample-size sensitivity", status: n >= 300 ? "high_power_warning" : n < 20 ? "low_power_warning" : "evaluated", interpretation: n >= 300 ? "large samples reject scientifically trivial departures; weigh the Q-Q plot" : n < 20 ? "small samples rarely reject; non-rejection is weak evidence" : "moderate sample; combine with the Q-Q plot" },
        { name: "algorithm boundary", status: "royston_as_r94", supported: "3 <= n <= 5000" },
      ],
      artifacts: normalityArtifacts(H, S, parsed, rows, "shapiro-wilk-table", "qq-plot", "Shapiro-Wilk test", [{ key: "n", label: "N", type: "number" }, { key: "statistic", label: "W", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "skewness", label: "Skewness", type: "number" }, { key: "excessKurtosis", label: "Excess kurtosis", type: "number" }], testRows, ["W near 1 indicates agreement with a normal distribution; p from Royston's approximation."]),
    };
  },
  linkage: normalityLinkage("Shapiro-Wilk"),
  fixture: { data: { values: [2.3, 3.1, 2.8, 3.6, 2.9, 3.3, 2.5, 3.8, 3.0, 2.7, 3.4, 3.2, 2.6, 3.5, 2.95, 3.15], label: "log concentration" } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.distribution"] },
  coverage: {
    implementedBoundary: "Shapiro-Wilk W with Royston (1995) AS R94 coefficients and p-value approximation for 3 <= n <= 5000, plus Blom-position Q-Q rows.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["W and p across n = 3, 5, 8, 16, 50, 300 (scipy.stats.shapiro)", "Q-Q theoretical quantiles (scipy.stats.norm.ppf on Blom positions)"], excludedOutputs: ["Jarque-Bera diagnostic"] },
    diagnostic: { level: "method-specific-partial", emitted: ["Jarque-Bera normality", "sample-size sensitivity", "ties"], limitations: ["no outlier identification"] },
    knownGaps: ["n > 5000", "censored or weighted data"],
  },
};

// ---------------------------------------------------------------------------------
// Anderson-Darling normality with Stephens' finite-sample adjustment
// ---------------------------------------------------------------------------------

const andersonDarlingNormal = {
  method: "anderson_darling_normal",
  family: "assumption-tests",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["timeoutMs"],
  dataSchema: { type: "object", additionalProperties: false, required: ["values"], properties: { values: { type: "array", minItems: 8, maxItems: 10000, items: { type: "number" } }, label: LABEL_SCHEMA } },
  parse(data, options, H) {
    return parseValues(data, H, 8, 10000);
  },
  analyze(parsed, options, budget, H) {
    const S = createSupport(H);
    const { rows, stats } = normalityCommon(H, S, parsed, budget);
    const n = parsed.values.length;
    const sortedValues = H.sorted(parsed.values);
    const mean = stats.mean;
    const sd = stats.sd;
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      budget.check();
      const zLow = (sortedValues[i] - mean) / sd;
      const zHigh = (sortedValues[n - 1 - i] - mean) / sd;
      const both = S.pnorm(zLow);
      const upper = S.pnormUpper(zHigh);
      sum += (2 * i + 1) * (Math.log(Math.max(both, 1e-300)) + Math.log(Math.max(upper, 1e-300)));
    }
    const statistic = -n - sum / n;
    const adjusted = statistic * (1 + 0.75 / n + 2.25 / (n * n));
    let pValue;
    if (adjusted >= 0.6) pValue = Math.exp(1.2937 - 5.709 * adjusted + 0.0186 * adjusted * adjusted);
    else if (adjusted >= 0.34) pValue = Math.exp(0.9177 - 4.279 * adjusted - 1.38 * adjusted * adjusted);
    else if (adjusted >= 0.2) pValue = 1 - Math.exp(-8.318 + 42.796 * adjusted - 59.938 * adjusted * adjusted);
    else pValue = 1 - Math.exp(-13.436 + 101.14 * adjusted - 223.73 * adjusted * adjusted);
    pValue = Math.min(1, Math.max(0, pValue));
    const criticalRows = [[0.15, 0.576], [0.1, 0.656], [0.05, 0.787], [0.025, 0.918], [0.01, 1.092]].map(([alpha, critical]) => ({ significanceLevel: alpha, criticalValue: critical, rejected: adjusted > critical }));
    const testRows = [{ n, statistic, adjustedStatistic: adjusted, pValue, skewness: stats.skewness, excessKurtosis: stats.excessKurtosis }];
    return {
      sample: { n },
      estimates: [{ name: "Anderson-Darling A squared", estimate: statistic }, { name: "adjusted A squared", estimate: adjusted }, { name: "skewness", estimate: stats.skewness }, { name: "excess kurtosis", estimate: stats.excessKurtosis }, { name: "renderer data contract", inlineRows: "all", sampling: "none", aggregation: "none", rowCount: rows.length, qqRowsHash: H.sha256(rows), tableRole: "qq-table", vegaRole: "qq-plot" }],
      tests: [{ name: "Anderson-Darling normality", statistic: adjusted, rawStatistic: statistic, distribution: "Stephens (1986) adjusted A squared", df: null, pValue, method: "D'Agostino-Stephens piecewise exponential approximation" }],
      confidenceIntervals: [],
      effectSizes: [],
      assumptions: [{ name: "independent identically distributed observations", status: "requires_design_review" }, { name: "location and scale estimated from the sample (composite hypothesis)", status: "verified_by_method" }],
      diagnostics: [
        { name: "critical values", status: "evaluated", rows: criticalRows, source: "Stephens (1986) adjusted-statistic table for the composite normal hypothesis" },
        { name: "Jarque-Bera normality", ...H.jarqueBera(parsed.values, budget) },
        { name: "sample-size sensitivity", status: n >= 300 ? "high_power_warning" : "evaluated", interpretation: "the statistic weights tails heavily; inspect the Q-Q tails before acting" },
      ],
      artifacts: [
        ...normalityArtifacts(H, S, parsed, rows, "anderson-darling-table", "qq-plot", "Anderson-Darling test", [{ key: "n", label: "N", type: "number" }, { key: "statistic", label: "A squared", type: "number" }, { key: "adjustedStatistic", label: "Adjusted A squared", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "skewness", label: "Skewness", type: "number" }, { key: "excessKurtosis", label: "Excess kurtosis", type: "number" }], testRows, ["Adjusted statistic multiplies A squared by (1 + 0.75/n + 2.25/n^2)."]),
        H.tableArtifact("Anderson-Darling critical values", "Composite-normal critical values for the adjusted statistic.", [{ key: "significanceLevel", label: "Alpha", type: "number" }, { key: "criticalValue", label: "Critical value", type: "number" }, { key: "rejected", label: "Rejected", type: "boolean" }], criticalRows, [], "anderson-darling-critical-table"),
      ],
    };
  },
  linkage: normalityLinkage("Anderson-Darling"),
  fixture: { data: { values: [12.1, 11.4, 13.2, 12.8, 11.9, 12.5, 13.6, 12.2, 11.7, 12.9, 13.1, 12.4, 11.6, 12.7, 13.4, 12.0, 12.3, 11.8], label: "weight" } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.distribution"] },
  coverage: {
    implementedBoundary: "Anderson-Darling A squared for a normal distribution with sample mean and SD, Stephens' finite-sample adjustment, piecewise p approximation and tabulated critical values, for n >= 8.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["A squared (scipy.stats.anderson)", "adjusted statistic and p (statsmodels normal_ad)", "critical values (scipy.stats.anderson table)"], excludedOutputs: ["Jarque-Bera diagnostic"] },
    diagnostic: { level: "method-specific-partial", emitted: ["critical values", "Jarque-Bera normality", "sample-size sensitivity"], limitations: ["no outlier identification"] },
    knownGaps: ["non-normal families", "known-parameter (simple hypothesis) variant"],
  },
};

// ---------------------------------------------------------------------------------
// D'Agostino K2 omnibus
// ---------------------------------------------------------------------------------

const dagostinoK2 = {
  method: "dagostino_k2",
  family: "assumption-tests",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["timeoutMs"],
  dataSchema: { type: "object", additionalProperties: false, required: ["values"], properties: { values: { type: "array", minItems: 8, maxItems: 100000, items: { type: "number" } }, label: LABEL_SCHEMA } },
  parse(data, options, H) {
    return parseValues(data, H, 8, H.LIMITS.maxVectorLength);
  },
  analyze(parsed, options, budget, H) {
    const S = createSupport(H);
    const n = parsed.values.length;
    const m = H.moments(parsed.values, budget);
    const m2 = m.m2 / n;
    let m3 = 0;
    let m4 = 0;
    for (const value of parsed.values) {
      budget.check();
      const d = value - m.mean;
      m3 += d * d * d;
      m4 += d * d * d * d;
    }
    m3 /= n;
    m4 /= n;
    const g1 = m3 / Math.pow(m2, 1.5);
    const b2 = m4 / (m2 * m2);
    // Skewness Z (D'Agostino 1970)
    let y = g1 * Math.sqrt(((n + 1) * (n + 3)) / (6 * (n - 2)));
    const beta2 = (3 * (n * n + 27 * n - 70) * (n + 1) * (n + 3)) / ((n - 2) * (n + 5) * (n + 7) * (n + 9));
    const w2 = -1 + Math.sqrt(2 * (beta2 - 1));
    const delta = 1 / Math.sqrt(0.5 * Math.log(w2));
    const alpha = Math.sqrt(2 / (w2 - 1));
    if (y === 0) y = 1;
    const zSkew = delta * Math.log(y / alpha + Math.sqrt((y / alpha) ** 2 + 1));
    // Kurtosis Z (Anscombe & Glynn 1983)
    const e = (3 * (n - 1)) / (n + 1);
    const varB2 = (24 * n * (n - 2) * (n - 3)) / ((n + 1) * (n + 1) * (n + 3) * (n + 5));
    const x = (b2 - e) / Math.sqrt(varB2);
    const sqrtBeta1 = (6 * (n * n - 5 * n + 2)) / ((n + 7) * (n + 9)) * Math.sqrt((6 * (n + 3) * (n + 5)) / (n * (n - 2) * (n - 3)));
    const a = 6 + (8 / sqrtBeta1) * (2 / sqrtBeta1 + Math.sqrt(1 + 4 / (sqrtBeta1 * sqrtBeta1)));
    const term1 = 1 - 2 / (9 * a);
    const denominator = 1 + x * Math.sqrt(2 / (a - 4));
    if (denominator === 0) H.fail("STAT_NUMERIC_FAILURE", "kurtosis transformation is undefined for this sample");
    const term2 = Math.sign(denominator) * Math.cbrt((1 - 2 / a) / Math.abs(denominator));
    const zKurt = (term1 - term2) / Math.sqrt(2 / (9 * a));
    const k2 = zSkew * zSkew + zKurt * zKurt;
    const pValue = H.pFromChiSquare(k2, 2);
    const pSkew = S.pnormUpper(Math.abs(zSkew)) * 2;
    const pKurt = S.pnormUpper(Math.abs(zKurt)) * 2;
    const rows = [
      { component: "skewness", estimate: g1, z: zSkew, pValue: Math.min(1, pSkew) },
      { component: "excess kurtosis", estimate: b2 - 3, z: zKurt, pValue: Math.min(1, pKurt) },
      { component: "K squared omnibus", estimate: k2, z: null, pValue },
    ];
    const bins = H.histogram(parsed.values, Math.min(30, Math.max(8, Math.round(Math.sqrt(n)))));
    const binRows = bins.map((bin, index) => ({ bin: index + 1, binStart: bin.binStart, binEnd: bin.binEnd, count: bin.count }));
    return {
      sample: { n },
      estimates: [{ name: "skewness g1", estimate: g1 }, { name: "kurtosis b2", estimate: b2 }, { name: "K squared", estimate: k2 }, { name: "renderer data contract", inlineRows: "all", sampling: "none", aggregation: "histogram-bins", rowCount: binRows.length, binRowsHash: H.sha256(binRows), tableRole: "histogram-table", vegaRole: "histogram" }],
      tests: [
        { name: "D'Agostino K squared omnibus", statistic: k2, distribution: "chi-square", df: 2, pValue },
        { name: "D'Agostino skewness", statistic: zSkew, distribution: "normal", df: null, pValue: Math.min(1, pSkew) },
        { name: "Anscombe-Glynn kurtosis", statistic: zKurt, distribution: "normal", df: null, pValue: Math.min(1, pKurt) },
      ],
      confidenceIntervals: [],
      effectSizes: [],
      assumptions: [{ name: "independent identically distributed observations", status: "requires_design_review" }, { name: "n >= 20 for the kurtosis normalizing approximation", status: n >= 20 ? "verified_by_input" : "asymptotic" }],
      diagnostics: [
        { name: "approximation boundary", status: n >= 20 ? "evaluated" : "asymptotic", interpretation: n >= 20 ? "moment transformations are calibrated for this sample size" : "kurtosis transformation is only approximate below n = 20" },
        { name: "shape summary", status: "evaluated", direction: g1 > 0 ? "right-skewed" : g1 < 0 ? "left-skewed" : "symmetric", tails: b2 - 3 > 0 ? "heavier than normal" : "lighter than normal" },
      ],
      artifacts: [
        H.tableArtifact("D'Agostino-Pearson omnibus test", `Skewness and kurtosis components with the K squared omnibus statistic for ${parsed.label}.`, [{ key: "component", label: "Component", type: "string" }, { key: "estimate", label: "Estimate", type: "number" }, { key: "z", label: "Z", type: "number" }, { key: "pValue", label: "p", type: "number" }], rows, ["Skewness uses the biased moment estimator g1; kurtosis b2 is the raw fourth standardized moment (3 under normality)."], "dagostino-k2-table"),
        H.tableArtifact("Histogram bins", `Equal-width bins of ${parsed.label}.`, [{ key: "bin", label: "Bin", type: "number" }, { key: "binStart", label: "Start", type: "number" }, { key: "binEnd", label: "End", type: "number" }, { key: "count", label: "Count", type: "number" }], binRows, [], "histogram-table"),
        H.vegaArtifact("histogram", `Distribution of ${parsed.label}`, { data: { values: binRows }, mark: { type: "bar" }, encoding: { x: { field: "binStart", type: "quantitative", title: parsed.label, bin: { binned: true } }, x2: { field: "binEnd" }, y: { field: "count", type: "quantitative", title: "Count" }, tooltip: [{ field: "binStart", format: ".4g" }, { field: "binEnd", format: ".4g" }, { field: "count" }] } }),
      ],
    };
  },
  linkage: normalityLinkage("D'Agostino K squared"),
  fixture: { data: { values: [5.2, 4.8, 6.1, 5.5, 4.9, 5.8, 6.4, 5.1, 4.7, 5.6, 6.0, 5.3, 4.6, 5.9, 6.3, 5.0, 5.4, 4.5, 6.6, 5.7, 5.25, 4.95, 6.2, 5.45], label: "reaction time" } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.distribution"] },
  coverage: {
    implementedBoundary: "D'Agostino skewness Z, Anscombe-Glynn kurtosis Z and the K squared omnibus with chi-square(2) p for n >= 8.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["K squared and p (scipy.stats.normaltest)", "skewness Z and p (scipy.stats.skewtest)", "kurtosis Z and p (scipy.stats.kurtosistest)"], excludedOutputs: ["histogram bins"] },
    diagnostic: { level: "method-specific-partial", emitted: ["approximation boundary", "shape summary"], limitations: ["no Q-Q rows in this method (see shapiro_wilk)"] },
    knownGaps: ["small-sample exact calibration below n = 20"],
  },
};

// ---------------------------------------------------------------------------------
// Variance homogeneity: Levene, Bartlett, Fligner-Killeen
// ---------------------------------------------------------------------------------

function dispersionRows(groups, centers, H, budget) {
  return groups.map((group, index) => {
    const variance = H.variance(group.values, true, budget);
    const deviations = group.values.map((value) => Math.abs(value - centers[index]));
    return { group: group.name, n: group.values.length, center: centers[index], variance, sd: Math.sqrt(variance), meanAbsoluteDeviation: H.mean(deviations, budget) };
  });
}

function dispersionArtifacts(H, parsed, rows, tableRole, title, caption, notes) {
  return [
    H.tableArtifact(title, caption, DISPERSION_COLUMNS, rows, notes, tableRole),
    H.vegaArtifact("group-dispersion-plot", `Spread of ${parsed.outcomeLabel} by group`, {
      data: { values: rows },
      layer: [
        { mark: { type: "bar", opacity: 0.35 }, encoding: { x: { field: "group", type: "nominal", title: "Group", sort: null }, y: { field: "sd", type: "quantitative", title: "Standard deviation" } } },
        { mark: { type: "point", filled: true, size: 80, color: "#c0392b" }, encoding: { x: { field: "group", type: "nominal", sort: null }, y: { field: "meanAbsoluteDeviation", type: "quantitative", title: "Standard deviation" }, tooltip: [{ field: "group" }, { field: "n" }, { field: "sd", format: ".4g" }, { field: "meanAbsoluteDeviation", format: ".4g" }, { field: "variance", format: ".4g" }] } },
      ],
    }),
  ];
}

function varianceLinkage(name, detail) {
  return {
    neededWhen: `Before pooling variances in a t test, ANOVA or Tukey procedure, when the ${name} screen must document whether the groups spread similarly. ${detail}`,
    decision: "Whether an equal-variance method is defensible or whether a Welch-type or heteroscedastic-robust alternative must be used instead.",
    mustShow: "Group sizes, per-group variance or scale summaries, the statistic with degrees of freedom and p, and the sensitivity of the chosen test to non-normality.",
    userGoal: "Choose between pooled and unequal-variance procedures on visible evidence and report the check reviewers expect.",
    nextActions: [
      { trigger: "variances-unequal", action: "switch-to-welch-or-games-howell-procedures", reason: "Pooled-variance inference is miscalibrated when spread differs, especially with unequal group sizes." },
      { trigger: "variances-similar-small-groups", action: "proceed-with-pooled-method-and-report-spread-table", reason: "A non-rejection in small groups is weak, so the spread table must accompany the decision." },
      { trigger: "non-normal-groups", action: "prefer-median-centered-levene-or-fligner-killeen", reason: "Bartlett and mean-centered Levene are sensitive to non-normality and can reject for the wrong reason." },
    ],
  };
}

const varianceFixtureGroups = [
  { name: "control", values: [4.2, 5.1, 6.7, 4.8, 5.9, 5.3, 4.5, 5.6] },
  { name: "treatment A", values: [8.3, 12.4, 9.7, 15.2, 10.5, 13.1, 9.9] },
  { name: "treatment B", values: [2.1, 2.9, 3.0, 2.8, 2.5, 3.2] },
];

const leveneTest = {
  method: "levene_test",
  family: "assumption-tests",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["timeoutMs"],
  customOptions: {
    center: {
      schema: { type: "string", enum: ["mean", "median", "trimmed"] },
      default: "median",
      parse(value, H, path) {
        if (!["mean", "median", "trimmed"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be mean, median, or trimmed`);
        return value;
      },
    },
  },
  dataSchema: { type: "object", additionalProperties: false, required: ["groups"], properties: { groups: GROUPS_SCHEMA, outcomeLabel: LABEL_SCHEMA } },
  parse(data, options, H) {
    return parseGroups(data, H);
  },
  analyze(parsed, options, budget, H) {
    const center = options.center;
    const proportionToCut = 0.05;
    // Brown-Forsythe (1974) W10 form: the trimmed mean only replaces the centre; every observation keeps its deviation.
    const working = parsed.groups;
    const trimmedCenterSamples = working.map((group) => {
      const ordered = H.sorted(group.values);
      const cut = Math.floor(proportionToCut * ordered.length);
      return ordered.slice(cut, ordered.length - cut);
    });
    const centers = working.map((group, index) => (center === "median" ? H.quantileR7(H.sorted(group.values), 0.5) : center === "trimmed" ? H.mean(trimmedCenterSamples[index], budget) : H.mean(group.values, budget)));
    const transformed = working.map((group, index) => ({ name: group.name, values: group.values.map((value) => Math.abs(value - centers[index])) }));
    let core;
    try {
      core = H.anovaCore(transformed, budget);
    } catch {
      H.fail("STAT_DEGENERATE", "Levene deviations have zero within-group variance");
    }
    const pValue = H.pFromF(core.f, core.dfBetween, core.dfWithin);
    const rows = dispersionRows(working, centers, H, budget);
    const testRows = [{ center, statistic: core.f, df1: core.dfBetween, df2: core.dfWithin, pValue }];
    return {
      sample: { n: core.n, groups: parsed.groups.length, groupSizes: parsed.groups.map((group) => group.values.length), trimmedCenterSampleSizes: center === "trimmed" ? trimmedCenterSamples.map((sample) => sample.length) : null },
      estimates: [...rows.map((row) => ({ name: `${row.group} variance`, estimate: row.variance, n: row.n })), { name: "renderer data contract", inlineRows: "all", sampling: "none", aggregation: "none", rowCount: rows.length, dispersionRowsHash: H.sha256(rows), tableRole: "levene-dispersion-table", vegaRole: "group-dispersion-plot" }],
      tests: [{ name: center === "median" ? "Brown-Forsythe (median-centered Levene)" : center === "mean" ? "Levene (mean-centered)" : "Levene (trimmed-mean-centered)", statistic: core.f, distribution: "F", df1: core.dfBetween, df2: core.dfWithin, pValue, center }],
      confidenceIntervals: [],
      effectSizes: [],
      assumptions: [{ name: "independent observations", status: "requires_design_review" }, { name: "robustness to non-normality", status: center === "median" ? "robust_choice" : "sensitive_to_skew" }],
      diagnostics: [
        { name: "centering", status: "evaluated", center, proportionToCut: center === "trimmed" ? proportionToCut : null },
        { name: "variance ratio", status: "evaluated", maxToMinVarianceRatio: Math.max(...rows.map((row) => row.variance)) / Math.min(...rows.map((row) => row.variance)) },
        ...parsed.groups.map((group) => ({ group: group.name, ...H.jarqueBera(group.values, budget) })),
      ],
      artifacts: [
        H.tableArtifact("Levene test", `Levene test of equal variances of ${parsed.outcomeLabel} across ${parsed.groups.length} groups (${center} centering).`, [{ key: "center", label: "Center", type: "string" }, { key: "statistic", label: "W", type: "number" }, { key: "df1", label: "df1", type: "number" }, { key: "df2", label: "df2", type: "number" }, { key: "pValue", label: "p", type: "number" }], testRows, ["One-way ANOVA on absolute deviations from the group center."], "levene-table"),
        ...dispersionArtifacts(H, parsed, rows, "levene-dispersion-table", "Group dispersion", "Per-group center, variance and mean absolute deviation used by the Levene statistic.", center === "trimmed" ? ["Centers are 5% symmetrically trimmed means; deviations use every observation (Brown-Forsythe W10 form)."] : []),
      ],
    };
  },
  linkage: varianceLinkage("Levene", "Median centering (Brown-Forsythe) is the robust default."),
  fixture: { data: { groups: varianceFixtureGroups, outcomeLabel: "response" }, options: { center: "median" } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.dispersion"] },
  coverage: {
    implementedBoundary: "Levene W with mean, median (Brown-Forsythe) or 5% symmetrically trimmed-mean centering for 2-64 independent groups.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["W and p for all three centers (scipy.stats.levene)"], excludedOutputs: ["Jarque-Bera diagnostics"] },
    diagnostic: { level: "method-specific-partial", emitted: ["centering", "variance ratio", "Jarque-Bera per group"], limitations: ["no outlier screen"] },
    knownGaps: ["custom trimming proportion", "two-way Levene"],
  },
};

const bartlettTest = {
  method: "bartlett_test",
  family: "assumption-tests",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["timeoutMs"],
  dataSchema: { type: "object", additionalProperties: false, required: ["groups"], properties: { groups: GROUPS_SCHEMA, outcomeLabel: LABEL_SCHEMA } },
  parse(data, options, H) {
    return parseGroups(data, H);
  },
  analyze(parsed, options, budget, H) {
    const groups = parsed.groups;
    const k = groups.length;
    const sizes = groups.map((group) => group.values.length);
    const variances = groups.map((group) => H.variance(group.values, true, budget));
    if (variances.some((variance) => !(variance > 0))) H.fail("STAT_DEGENERATE", "bartlett_test requires positive variance in every group");
    const total = sizes.reduce((acc, value) => acc + value, 0);
    const pooled = sizes.reduce((acc, size, index) => acc + (size - 1) * variances[index], 0) / (total - k);
    const numerator = (total - k) * Math.log(pooled) - sizes.reduce((acc, size, index) => acc + (size - 1) * Math.log(variances[index]), 0);
    const denominator = 1 + (1 / (3 * (k - 1))) * (sizes.reduce((acc, size) => acc + 1 / (size - 1), 0) - 1 / (total - k));
    const statistic = numerator / denominator;
    const pValue = H.pFromChiSquare(statistic, k - 1);
    const centers = groups.map((group) => H.mean(group.values, budget));
    const rows = dispersionRows(groups, centers, H, budget);
    const testRows = [{ statistic, df: k - 1, pValue, pooledVariance: pooled }];
    return {
      sample: { n: total, groups: k, groupSizes: sizes },
      estimates: [{ name: "pooled variance", estimate: pooled }, ...rows.map((row) => ({ name: `${row.group} variance`, estimate: row.variance, n: row.n })), { name: "renderer data contract", inlineRows: "all", sampling: "none", aggregation: "none", rowCount: rows.length, dispersionRowsHash: H.sha256(rows), tableRole: "bartlett-dispersion-table", vegaRole: "group-dispersion-plot" }],
      tests: [{ name: "Bartlett test of homogeneity of variances", statistic, distribution: "chi-square", df: k - 1, pValue }],
      confidenceIntervals: [],
      effectSizes: [],
      assumptions: [{ name: "independent observations", status: "requires_design_review" }, { name: "normality within groups", status: "diagnostic_attached" }, { name: "robustness to non-normality", status: "sensitive_to_kurtosis" }],
      diagnostics: [
        { name: "variance ratio", status: "evaluated", maxToMinVarianceRatio: Math.max(...variances) / Math.min(...variances) },
        ...groups.map((group) => ({ group: group.name, ...H.jarqueBera(group.values, budget) })),
        { name: "sensitivity boundary", status: "warning", interpretation: "Bartlett rejects for heavy-tailed data even when variances are equal; confirm with Levene or Fligner-Killeen when normality is doubtful" },
      ],
      artifacts: [
        H.tableArtifact("Bartlett test", `Bartlett test of equal variances of ${parsed.outcomeLabel} across ${k} groups.`, [{ key: "statistic", label: "T", type: "number" }, { key: "df", label: "df", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "pooledVariance", label: "Pooled variance", type: "number" }], testRows, ["Chi-square approximation with Bartlett's correction factor."], "bartlett-table"),
        ...dispersionArtifacts(H, parsed, rows, "bartlett-dispersion-table", "Group dispersion", "Per-group mean, variance and mean absolute deviation.", []),
      ],
    };
  },
  linkage: varianceLinkage("Bartlett", "Use it only when normality within groups is credible."),
  fixture: { data: { groups: varianceFixtureGroups, outcomeLabel: "response" } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.dispersion"] },
  coverage: {
    implementedBoundary: "Bartlett chi-square test of equal variances for 2-64 independent groups with positive variances.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["T statistic and p (scipy.stats.bartlett)"], excludedOutputs: ["Jarque-Bera diagnostics"] },
    diagnostic: { level: "method-specific-partial", emitted: ["variance ratio", "Jarque-Bera per group", "sensitivity boundary"], limitations: ["no outlier screen"] },
    knownGaps: ["Box's M for covariance matrices"],
  },
};

const flignerKilleen = {
  method: "fligner_killeen",
  family: "assumption-tests",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["timeoutMs"],
  dataSchema: { type: "object", additionalProperties: false, required: ["groups"], properties: { groups: GROUPS_SCHEMA, outcomeLabel: LABEL_SCHEMA } },
  parse(data, options, H) {
    return parseGroups(data, H);
  },
  analyze(parsed, options, budget, H) {
    const S = createSupport(H);
    const groups = parsed.groups;
    const k = groups.length;
    const centers = groups.map((group) => H.quantileR7(H.sorted(group.values), 0.5));
    const deviations = groups.flatMap((group, index) => group.values.map((value) => Math.abs(value - centers[index])));
    const total = deviations.length;
    const { ranks } = H.averageRanks(deviations);
    const scores = ranks.map((rank) => S.qnorm(rank / (2 * (total + 1)) + 0.5));
    const grandScore = H.mean(scores, budget);
    const scoreVariance = H.variance(scores, true, budget);
    if (!(scoreVariance > 0)) H.fail("STAT_DEGENERATE", "fligner_killeen scores have zero variance");
    let offset = 0;
    let statistic = 0;
    const rows = groups.map((group, index) => {
      const n = group.values.length;
      const groupScores = scores.slice(offset, offset + n);
      offset += n;
      const meanScore = H.mean(groupScores, budget);
      statistic += n * (meanScore - grandScore) ** 2;
      const variance = H.variance(group.values, true, budget);
      return { group: group.name, n, center: centers[index], variance, sd: Math.sqrt(variance), meanAbsoluteDeviation: H.mean(group.values.map((value) => Math.abs(value - centers[index])), budget), meanScore };
    });
    statistic /= scoreVariance;
    const pValue = H.pFromChiSquare(statistic, k - 1);
    const dispersion = rows.map(({ meanScore, ...rest }) => rest);
    const testRows = [{ statistic, df: k - 1, pValue }];
    const tieCount = total - new Set(deviations).size;
    return {
      sample: { n: total, groups: k, groupSizes: groups.map((group) => group.values.length) },
      estimates: [...rows.map((row) => ({ name: `${row.group} mean normal score`, estimate: row.meanScore, n: row.n })), { name: "renderer data contract", inlineRows: "all", sampling: "none", aggregation: "none", rowCount: dispersion.length, dispersionRowsHash: H.sha256(dispersion), tableRole: "fligner-dispersion-table", vegaRole: "group-dispersion-plot" }],
      tests: [{ name: "Fligner-Killeen test of homogeneity of variances", statistic, distribution: "chi-square", df: k - 1, pValue, center: "median" }],
      confidenceIntervals: [],
      effectSizes: [],
      assumptions: [{ name: "independent observations", status: "requires_design_review" }, { name: "robustness to non-normality", status: "rank_based_robust" }],
      diagnostics: [
        { name: "ties among absolute deviations", status: tieCount > 0 ? "average_ranks_applied" : "no_ties", tieCount },
        { name: "variance ratio", status: "evaluated", maxToMinVarianceRatio: Math.max(...rows.map((row) => row.variance)) / Math.min(...rows.map((row) => row.variance)) },
      ],
      artifacts: [
        H.tableArtifact("Fligner-Killeen test", `Rank-based (normal score) test of equal variances of ${parsed.outcomeLabel} across ${k} groups.`, [{ key: "statistic", label: "Chi-square", type: "number" }, { key: "df", label: "df", type: "number" }, { key: "pValue", label: "p", type: "number" }], testRows, ["Scores are normal quantiles of the ranks of |x - median|; chi-square approximation."], "fligner-killeen-table"),
        ...dispersionArtifacts(H, parsed, dispersion, "fligner-dispersion-table", "Group dispersion", "Per-group median, variance and mean absolute deviation from the median.", []),
      ],
    };
  },
  linkage: varianceLinkage("Fligner-Killeen", "It is the most robust choice for heavy-tailed data."),
  fixture: { data: { groups: varianceFixtureGroups, outcomeLabel: "response" } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.dispersion"] },
  coverage: {
    implementedBoundary: "Fligner-Killeen median-centered normal-score test for 2-64 independent groups with average ranks for ties and a chi-square approximation.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["chi-square statistic and p (scipy.stats.fligner)"], excludedOutputs: ["dispersion rows"] },
    diagnostic: { level: "method-specific-partial", emitted: ["ties among absolute deviations", "variance ratio"], limitations: ["no outlier screen"] },
    knownGaps: ["exact permutation p for tiny samples"],
  },
};

// ---------------------------------------------------------------------------------
// Two-sample Kolmogorov-Smirnov
// ---------------------------------------------------------------------------------

function ecdfRows(x, y, budget) {
  const sortedX = [...x].sort((a, b) => a - b);
  const sortedY = [...y].sort((a, b) => a - b);
  const pooled = [...new Set([...sortedX, ...sortedY])].sort((a, b) => a - b);
  const rows = [];
  let ix = 0;
  let iy = 0;
  for (const value of pooled) {
    budget.check();
    while (ix < sortedX.length && sortedX[ix] <= value) ix += 1;
    while (iy < sortedY.length && sortedY[iy] <= value) iy += 1;
    const fx = ix / sortedX.length;
    const fy = iy / sortedY.length;
    rows.push({ value, ecdfX: fx, ecdfY: fy, difference: fx - fy });
  }
  return rows;
}

function logChooseSum(n, m, H) {
  return H.logChoose(n + m, n);
}

/** Exact P(D >= observed) by lattice-path counting (no ties). predicate(i, j) => path point allowed. */
function exactPathProbability(n, m, allowed, H, budget) {
  const total = Math.exp(logChooseSum(n, m, H));
  if (!Number.isFinite(total)) return null;
  let previous = Array(m + 1).fill(0);
  previous[0] = 1;
  for (let j = 1; j <= m; j += 1) previous[j] = allowed(0, j) ? previous[j - 1] : 0;
  for (let i = 1; i <= n; i += 1) {
    const current = Array(m + 1).fill(0);
    current[0] = allowed(i, 0) ? previous[0] : 0;
    for (let j = 1; j <= m; j += 1) {
      budget.check();
      current[j] = allowed(i, j) ? current[j - 1] + previous[j] : 0;
    }
    previous = current;
  }
  return Math.min(1, Math.max(0, 1 - previous[m] / total));
}

function kolmogorovAsymptotic(z) {
  if (z <= 0) return 1;
  let sum = 0;
  for (let k = 1; k <= 200; k += 1) {
    const term = Math.exp(-2 * k * k * z * z);
    sum += (k % 2 === 1 ? 1 : -1) * term;
    if (term < 1e-17) break;
  }
  return Math.min(1, Math.max(0, 2 * sum));
}

const kolmogorovSmirnovTwoSample = {
  method: "kolmogorov_smirnov_two_sample",
  family: "assumption-tests",
  analysisModel: { families: ["lm"], distributions: [null], links: [null] },
  optionKeys: ["alternative", "pValueMethod", "timeoutMs"],
  dataSchema: { type: "object", additionalProperties: false, required: ["x", "y"], properties: { x: { type: "array", minItems: 2, maxItems: 5000, items: { type: "number" } }, y: { type: "array", minItems: 2, maxItems: 5000, items: { type: "number" } }, xLabel: LABEL_SCHEMA, yLabel: LABEL_SCHEMA } },
  parse(data, options, H) {
    H.assertKeys(data, ["x", "y", "xLabel", "yLabel"], "data");
    const x = H.numericVector(data.x, "data.x", 2);
    const y = H.numericVector(data.y, "data.y", 2);
    if (x.length > 5000 || y.length > 5000) H.fail("STAT_LIMIT_EXCEEDED", "kolmogorov_smirnov_two_sample samples must each have at most 5000 values");
    return { x, y, xLabel: H.label(data.xLabel, "Sample X", "data.xLabel"), yLabel: H.label(data.yLabel, "Sample Y", "data.yLabel") };
  },
  analyze(parsed, options, budget, H) {
    const { x, y } = parsed;
    const n = x.length;
    const m = y.length;
    const rows = ecdfRows(x, y, budget);
    let dPlus = 0;
    let dMinus = 0;
    let location = rows[0].value;
    let maxAbs = -1;
    for (const row of rows) {
      dPlus = Math.max(dPlus, row.difference);
      dMinus = Math.max(dMinus, -row.difference);
      if (Math.abs(row.difference) > maxAbs) {
        maxAbs = Math.abs(row.difference);
        location = row.value;
      }
    }
    const statistic = options.alternative === "greater" ? dPlus : options.alternative === "less" ? dMinus : Math.max(dPlus, dMinus);
    const ties = new Set([...x, ...y]).size < n + m;
    const exactFeasible = !ties && n + m <= 1000;
    let method = options.pValueMethod;
    if (method === "auto") method = exactFeasible ? "exact" : "asymptotic";
    if (method === "exact" && !exactFeasible) H.fail("STAT_INVALID_INPUT", ties ? "exact Kolmogorov-Smirnov p-values require samples without ties" : "exact Kolmogorov-Smirnov p-values are bounded to n + m <= 1000");
    let pValue;
    if (method === "exact") {
      // h = D * n * m as an exact integer lattice height.
      const h = Math.round(statistic * n * m);
      let allowed;
      if (options.alternative === "greater") allowed = (i, j) => i * m - j * n < h;
      else if (options.alternative === "less") allowed = (i, j) => j * n - i * m < h;
      else allowed = (i, j) => Math.abs(i * m - j * n) < h;
      pValue = h === 0 ? 1 : exactPathProbability(n, m, allowed, H, budget);
      if (pValue === null) H.fail("STAT_NUMERIC_FAILURE", "exact path count overflowed");
    } else {
      const z = statistic * Math.sqrt((n * m) / (n + m));
      pValue = options.alternative === "two-sided" ? kolmogorovAsymptotic(z) : Math.min(1, Math.exp(-2 * z * z));
    }
    const testRows = [{ alternative: options.alternative, statistic, dPlus, dMinus, location, pValue, method }];
    return {
      sample: { n: n + m, groupSizes: [n, m], ties },
      estimates: [{ name: "D+", estimate: dPlus }, { name: "D-", estimate: dMinus }, { name: "location of maximum difference", estimate: location }, { name: "renderer data contract", inlineRows: "all", sampling: "none", aggregation: "none", rowCount: rows.length, ecdfRowsHash: H.sha256(rows), tableRole: "ecdf-table", vegaRole: "ecdf-comparison" }],
      tests: [{ name: "Two-sample Kolmogorov-Smirnov", statistic, distribution: method === "exact" ? "exact lattice-path" : options.alternative === "two-sided" ? "Kolmogorov limit" : "Smirnov one-sided limit", df: null, pValue, alternative: options.alternative, pValueMethod: method }],
      confidenceIntervals: [],
      effectSizes: [],
      assumptions: [{ name: "independent samples of continuous measurements", status: ties ? "warning_ties_present" : "verified_by_input" }],
      diagnostics: [
        { name: "p-value method", status: method === "exact" ? "exact" : "asymptotic", requested: options.pValueMethod, reason: method === "exact" ? "no ties and n + m <= 1000" : ties ? "ties present; the exact distribution assumes continuity" : "n + m exceeds the exact path-counting bound" },
        { name: "alternative semantics", status: "evaluated", greater: `${parsed.xLabel} ECDF lies above ${parsed.yLabel} (X stochastically smaller)`, less: `${parsed.xLabel} ECDF lies below ${parsed.yLabel} (X stochastically larger)` },
      ],
      artifacts: [
        H.tableArtifact("Two-sample Kolmogorov-Smirnov test", `Maximum ECDF distance between ${parsed.xLabel} (n = ${n}) and ${parsed.yLabel} (n = ${m}).`, [{ key: "alternative", label: "Alternative", type: "string" }, { key: "statistic", label: "D", type: "number" }, { key: "dPlus", label: "D+", type: "number" }, { key: "dMinus", label: "D-", type: "number" }, { key: "location", label: "Location of max |difference|", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "method", label: "p method", type: "string" }], testRows, ["D+ = max(F_X - F_Y), D- = max(F_Y - F_X)."], "ks-two-sample-table"),
        H.tableArtifact("Empirical distribution functions", "Pooled sorted values with both ECDFs and their difference.", [{ key: "value", label: "Value", type: "number" }, { key: "ecdfX", label: `ECDF ${parsed.xLabel}`, type: "number" }, { key: "ecdfY", label: `ECDF ${parsed.yLabel}`, type: "number" }, { key: "difference", label: "Difference", type: "number" }], rows, [], "ecdf-table"),
        H.vegaArtifact("ecdf-comparison", `Empirical distribution functions of ${parsed.xLabel} and ${parsed.yLabel}`, {
          data: { values: rows },
          layer: [
            { mark: { type: "line", interpolate: "step-after", color: "#2c3e50" }, encoding: { x: { field: "value", type: "quantitative", title: "Value" }, y: { field: "ecdfX", type: "quantitative", title: "Cumulative proportion" }, tooltip: [{ field: "value", format: ".5g" }, { field: "ecdfX", format: ".3f" }, { field: "ecdfY", format: ".3f" }] } },
            { mark: { type: "line", interpolate: "step-after", color: "#c0392b" }, encoding: { x: { field: "value", type: "quantitative" }, y: { field: "ecdfY", type: "quantitative" } } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When two independent samples must be compared on their whole distribution (location, spread and shape together) rather than on a single mean or rank-location contrast.",
    decision: "Whether the two samples can be treated as draws from the same distribution, and where along the scale the distributions separate most.",
    mustShow: "Both sample sizes, the ECDF overlay, D with its location, D+ and D-, the p-value with the method actually used (exact or asymptotic), and whether ties were present.",
    userGoal: "Detect any distributional difference without committing to a parametric family and locate where it occurs.",
    nextActions: [
      { trigger: "distributions-differ", action: "inspect-ecdf-location-of-maximum-difference", reason: "The statistic alone does not say whether location, spread or tails drive the difference." },
      { trigger: "ties-present", action: "review-measurement-resolution-and-prefer-asymptotic-or-permutation-p", reason: "The exact distribution assumes continuous data; ties make it approximate." },
      { trigger: "location-shift-of-interest", action: "compare-with-mann-whitney-or-welch-t", reason: "Kolmogorov-Smirnov has low power for pure location shifts relative to targeted tests." },
    ],
  },
  fixture: { data: { x: [1.2, 2.4, 3.1, 3.9, 4.6, 5.3, 6.8, 7.2, 8.9, 9.4], y: [2.1, 3.5, 4.4, 5.9, 6.3, 7.7, 8.2, 9.8, 10.5, 11.1, 12.3], xLabel: "before", yLabel: "after" }, options: { alternative: "two-sided", pValueMethod: "auto" } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.distribution"] },
  coverage: {
    implementedBoundary: "Two-sample Kolmogorov-Smirnov D (two-sided, greater, less) with exact lattice-path p-values for tie-free samples up to n + m = 1000 and Kolmogorov / Smirnov limiting p-values otherwise.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["D and exact p for all three alternatives (scipy.stats.ks_2samp method='exact')", "two-sided asymptotic p (scipy.stats.kstwobign.sf)", "one-sided asymptotic p (numpy exp(-2 z^2))"], excludedOutputs: ["ECDF rows"] },
    diagnostic: { level: "method-specific-partial", emitted: ["p-value method", "alternative semantics"], limitations: ["no confidence band on the ECDF difference"] },
    knownGaps: ["exact p with ties", "finite-sample one-sided correction terms", "n + m > 1000 exact"],
  },
};

// ---------------------------------------------------------------------------------
// Durbin-Watson with Imhof exact p (when the design is available)
// ---------------------------------------------------------------------------------

function imhofProbability(lambdas, d, S, budget) {
  // P( sum (lambda_i - d) xi_i^2 < 0 ) with xi iid N(0,1)
  const shifted = lambdas.map((lambda) => lambda - d);
  const integrand = (u) => {
    if (u === 0) return 0.5 * shifted.reduce((acc, value) => acc + value, 0);
    let theta = 0;
    let logRho = 0;
    for (const value of shifted) {
      theta += Math.atan(value * u);
      logRho += 0.25 * Math.log1p(value * value * u * u);
    }
    return Math.sin(0.5 * theta) / (u * Math.exp(logRho));
  };
  let integral = 0;
  let upper = 0;
  const width = 0.5;
  for (let panel = 0; panel < 4000; panel += 1) {
    const contribution = S.integratePanels(integrand, upper, upper + width, 4, 16, budget);
    integral += contribution;
    upper += width;
    if (panel > 4 && Math.abs(contribution) < 1e-14) break;
  }
  return Math.min(1, Math.max(0, 0.5 - integral / Math.PI));
}

const durbinWatson = {
  method: "durbin_watson",
  family: "assumption-tests",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["alternative", "intercept", "timeoutMs"],
  dataSchema: { type: "object", additionalProperties: false, required: [], properties: { y: { type: "array", minItems: 8, maxItems: 5000, items: { type: "number" } }, predictors: PREDICTOR_SCHEMA, residuals: { type: "array", minItems: 8, maxItems: 5000, items: { type: "number" } }, outcomeLabel: LABEL_SCHEMA } },
  parse(data, options, H) {
    H.assertKeys(data, ["y", "predictors", "residuals", "outcomeLabel"], "data");
    if (data.residuals !== undefined) {
      if (data.y !== undefined || data.predictors !== undefined) H.fail("STAT_INVALID_INPUT", "durbin_watson accepts either data.residuals or data.y with data.predictors, not both");
      const residuals = H.numericVector(data.residuals, "data.residuals", 8);
      if (residuals.length > 5000) H.fail("STAT_LIMIT_EXCEEDED", "data.residuals length must be at most 5000");
      if (H.minMax(residuals).min === H.minMax(residuals).max) H.fail("STAT_DEGENERATE", "residuals are constant");
      return { residuals, outcomeLabel: H.label(data.outcomeLabel, "Outcome", "data.outcomeLabel") };
    }
    if (data.y === undefined || data.predictors === undefined) H.fail("STAT_INVALID_INPUT", "durbin_watson requires data.residuals or both data.y and data.predictors");
    return parseRegression(data, H);
  },
  analyze(parsed, options, budget, H) {
    const S = createSupport(H);
    let residuals;
    let fitted;
    let designX = null;
    if (parsed.residuals) {
      residuals = parsed.residuals;
      fitted = residuals.map(() => 0);
    } else {
      const { design, fit } = fitDesign(parsed, options, H, S, budget);
      residuals = fit.residuals;
      fitted = fit.fitted;
      designX = design.x;
    }
    const n = residuals.length;
    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < n; i += 1) {
      budget.check();
      denominator += residuals[i] * residuals[i];
      if (i > 0) numerator += (residuals[i] - residuals[i - 1]) ** 2;
    }
    if (!(denominator > 0)) H.fail("STAT_DEGENERATE", "residual sum of squares is zero");
    const statistic = numerator / denominator;
    const rho = 1 - statistic / 2;
    let pLower = null;
    let pValue = null;
    let pMethod = "bounds-only";
    let pReason;
    if (designX === null) pReason = "raw residuals were supplied without the design matrix, so the null distribution is not identified";
    else if (n > 200) pReason = "exact Imhof integration is bounded to n <= 200";
    else {
      // Eigenvalues of M A M where A is the first-difference Gram matrix and M the residual projector.
      const p = designX[0].length;
      const inverse = H.invert(H.matMul(H.transpose(designX), designX, budget));
      const hat = H.matMul(H.matMul(designX, inverse, budget), H.transpose(designX), budget);
      const mMatrix = hat.map((row, i) => row.map((value, j) => (i === j ? 1 : 0) - value));
      const aMatrix = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => {
        if (i === j) return i === 0 || i === n - 1 ? 1 : 2;
        return Math.abs(i - j) === 1 ? -1 : 0;
      }));
      const mam = H.matMul(H.matMul(mMatrix, aMatrix, budget), mMatrix, budget);
      const eigen = H.symmetricEigenJacobi(mam, budget);
      const eigenvalues = eigen.pairs.map((pair) => pair.value).sort((a, b) => b - a).slice(0, n - p);
      pLower = imhofProbability(eigenvalues, statistic, S, budget);
      pMethod = "imhof-exact";
      pReason = "Imhof (1961) numerical inversion using the eigenvalues of M A M";
    }
    if (pLower !== null) {
      if (options.alternative === "greater") pValue = pLower;
      else if (options.alternative === "less") pValue = 1 - pLower;
      else pValue = Math.min(1, 2 * Math.min(pLower, 1 - pLower));
    }
    const interpretation = statistic < 1.5 ? "suggests positive first-order autocorrelation" : statistic > 2.5 ? "suggests negative first-order autocorrelation" : "close to 2; no strong first-order autocorrelation";
    const rows = residuals.map((residual, index) => ({ row: index + 1, fitted: fitted[index], residual, squaredResidual: residual * residual }));
    const lagRows = residuals.slice(1).map((residual, index) => ({ row: index + 2, residual, laggedResidual: residuals[index] }));
    const testRows = [{ statistic, rho, alternative: options.alternative, pValue, pValueMethod: pMethod }];
    return {
      sample: { n, modelColumns: designX ? designX[0].length : null },
      estimates: [{ name: "Durbin-Watson d", estimate: statistic }, { name: "first-order autocorrelation estimate", estimate: rho }, { name: "renderer data contract", inlineRows: "all", sampling: "none", aggregation: "none", rowCount: lagRows.length, lagRowsHash: H.sha256(lagRows), tableRole: "residual-lag-table", vegaRole: "residual-lag-plot" }],
      tests: [{ name: "Durbin-Watson autocorrelation", statistic, distribution: pMethod === "imhof-exact" ? "exact ratio of quadratic forms (Imhof)" : "not evaluated", df: null, pValue, alternative: options.alternative, pValueMethod: pMethod }],
      confidenceIntervals: [],
      effectSizes: [],
      assumptions: [{ name: "observations ordered in time or sequence", status: "requires_design_review" }, { name: "regressors fixed (no lagged dependent variable)", status: "requires_design_review" }, { name: "normal errors", status: "diagnostic_attached" }],
      diagnostics: [
        { name: "p-value boundary", status: pMethod === "imhof-exact" ? "exact" : "bounds-only", reason: pReason, interpretation },
        { name: "scale interpretation", status: "evaluated", range: "0 to 4", neutral: 2, interpretation },
        { name: "Jarque-Bera normality of residuals", ...H.jarqueBera(residuals, budget) },
      ],
      artifacts: [
        H.tableArtifact("Durbin-Watson test", `First-order residual autocorrelation for ${parsed.outcomeLabel}.`, [{ key: "statistic", label: "d", type: "number" }, { key: "rho", label: "rho estimate", type: "number" }, { key: "alternative", label: "Alternative", type: "string" }, { key: "pValue", label: "p", type: "number" }, { key: "pValueMethod", label: "p method", type: "string" }], testRows, ["greater = positive autocorrelation (d < 2); p is null when only bounds-based interpretation is available."], "durbin-watson-table"),
        H.tableArtifact("Residual sequence", "Residuals in observation order with fitted values.", RESIDUAL_COLUMNS, rows, [], "residual-sequence-table"),
        H.tableArtifact("Lagged residual pairs", "Each residual against the previous residual.", [{ key: "row", label: "Row", type: "number" }, { key: "residual", label: "Residual t", type: "number" }, { key: "laggedResidual", label: "Residual t-1", type: "number" }], lagRows, [], "residual-lag-table"),
        H.vegaArtifact("residual-lag-plot", "Residual versus lagged residual", {
          data: { values: lagRows },
          layer: [
            { mark: { type: "rule", strokeDash: [4, 4], color: "#888888" }, encoding: { y: { datum: 0 } } },
            { mark: { type: "rule", strokeDash: [4, 4], color: "#888888" }, encoding: { x: { datum: 0 } } },
            { mark: { type: "point", filled: true, size: 40 }, encoding: { x: { field: "laggedResidual", type: "quantitative", title: "Residual t-1" }, y: { field: "residual", type: "quantitative", title: "Residual t" }, tooltip: [{ field: "row" }, { field: "residual", format: ".4g" }, { field: "laggedResidual", format: ".4g" }] } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "After fitting a regression to observations recorded in time or sequence order, when serially correlated errors would invalidate the standard errors and tests.",
    decision: "Whether first-order autocorrelation is present strongly enough to require Newey-West standard errors, an autoregressive error model, or a change of design.",
    mustShow: "The statistic on its 0-4 scale, the estimated first-order autocorrelation, the residual-versus-lag plot, the exact p when the design is available, and an honest statement when only bounds-based interpretation exists.",
    userGoal: "Confirm that the regression inference is not undermined by serial dependence before reporting coefficients.",
    nextActions: [
      { trigger: "positive-autocorrelation", action: "refit-with-hac-standard-errors-or-ar1-errors", reason: "Ordinary least squares standard errors are too small under positive serial correlation." },
      { trigger: "bounds-only-inconclusive", action: "supply-design-matrix-for-exact-p", reason: "The exact null distribution depends on the regressors, not only on the residuals." },
      { trigger: "no-autocorrelation", action: "bind-lag-plot-and-statistic-to-model-report", reason: "The check is a standard reviewer expectation for ordered data." },
    ],
  },
  fixture: {
    data: {
      y: [10.2, 11.1, 12.4, 12.9, 13.8, 15.1, 15.6, 16.9, 17.2, 18.8, 19.1, 20.3, 21.9, 22.2, 23.6, 24.1],
      predictors: [{ name: "time", values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] }],
      outcomeLabel: "sales",
    },
    options: { alternative: "greater" },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "Durbin-Watson d from OLS residuals (design supplied) or raw residuals, first-order rho estimate, and an exact Imhof p-value for designs with n <= 200; bounds-only interpretation otherwise.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["d statistic (statsmodels durbin_watson)", "exact p (numpy eigvalsh of M A M plus scipy.integrate Imhof inversion)"], excludedOutputs: ["bounds-only interpretation text", "Jarque-Bera diagnostic"] },
    diagnostic: { level: "method-specific-partial", emitted: ["p-value boundary", "scale interpretation", "Jarque-Bera normality of residuals"], limitations: ["no Savin-White tabulated bounds", "no higher-order autocorrelation test"] },
    knownGaps: ["exact p for n > 200", "Breusch-Godfrey higher-order test", "lagged dependent variable (Durbin h)"],
  },
};

// ---------------------------------------------------------------------------------
// Heteroscedasticity: Breusch-Pagan (Koenker and classic), White
// ---------------------------------------------------------------------------------

function auxiliaryRegression(target, auxiliaryX, S, H, budget) {
  const fit = S.olsFit(target, auxiliaryX, budget);
  const center = H.mean(target, budget);
  const sst = H.sum(target.map((value) => (value - center) ** 2), budget);
  const rSquared = sst > 0 ? Math.max(0, Math.min(1, 1 - fit.rss / sst)) : 0;
  return { fit, rSquared, sst };
}

function heteroscedasticityLinkage(name) {
  return {
    neededWhen: `After fitting a linear regression, when the ${name} screen must establish whether the error variance changes with the predictors before classical standard errors are reported.`,
    decision: "Whether heteroscedasticity is present strongly enough to require robust (HC) standard errors, weighted least squares, or a variance-stabilizing transformation.",
    mustShow: "The residual-versus-fitted plot, the LM statistic with degrees of freedom and p, the F form, the auxiliary regression R squared, and which residual specification was used.",
    userGoal: "Report regression coefficients with standard errors that are valid for the observed error structure.",
    nextActions: [
      { trigger: "heteroscedasticity-detected", action: "refit-with-hc3-robust-covariance-or-weighted-least-squares", reason: "Classical OLS standard errors are biased when the error variance depends on the predictors." },
      { trigger: "variance-pattern-suggests-nonlinearity", action: "inspect-residual-plot-and-revise-functional-form", reason: "Heteroscedasticity tests also reject when the mean model is misspecified." },
      { trigger: "homoscedastic", action: "bind-residual-plot-and-test-to-regression-report", reason: "The screen documents that classical standard errors are defensible." },
    ],
  };
}

const heteroscedasticityFixture = {
  data: {
    y: [3.2, 4.1, 5.9, 6.3, 8.8, 9.1, 12.4, 11.2, 15.9, 14.1, 19.8, 17.2, 24.5, 21.9, 30.1, 25.4, 33.8, 29.2, 40.6, 34.7],
    predictors: [{ name: "dose", values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20] }, { name: "age", values: [31, 45, 28, 52, 39, 60, 35, 48, 42, 57, 33, 50, 29, 62, 44, 38, 55, 47, 36, 59] }],
    outcomeLabel: "response",
  },
};

const breuschPagan = {
  method: "breusch_pagan",
  family: "assumption-tests",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["intercept", "timeoutMs"],
  dataSchema: { type: "object", additionalProperties: false, required: ["y", "predictors"], properties: { y: { type: "array", minItems: 8, maxItems: 5000, items: { type: "number" } }, predictors: PREDICTOR_SCHEMA, outcomeLabel: LABEL_SCHEMA } },
  parse(data, options, H) {
    return parseRegression(data, H);
  },
  analyze(parsed, options, budget, H) {
    const S = createSupport(H);
    const { design, fit } = fitDesign(parsed, options, H, S, budget);
    const n = parsed.y.length;
    const hasIntercept = design.x.every((row) => row[0] === 1);
    const auxiliaryX = hasIntercept ? design.x : design.x.map((row) => [1, ...row]);
    const df = auxiliaryX[0].length - 1;
    if (df < 1) H.fail("STAT_INVALID_INPUT", "breusch_pagan needs at least one non-constant predictor");
    const squared = fit.residuals.map((value) => value * value);
    if (H.minMax(squared).min === H.minMax(squared).max) H.fail("STAT_DEGENERATE", "squared residuals are constant");
    const koenker = auxiliaryRegression(squared, auxiliaryX, S, H, budget);
    const lm = n * koenker.rSquared;
    const lmP = H.pFromChiSquare(lm, df);
    const fStatistic = (koenker.rSquared / df) / ((1 - koenker.rSquared) / (n - df - 1));
    const fP = H.pFromF(fStatistic, df, n - df - 1);
    const sigma2 = fit.rss / n;
    const scaled = squared.map((value) => value / sigma2);
    const classic = auxiliaryRegression(scaled, auxiliaryX, S, H, budget);
    const classicStatistic = (classic.sst - classic.fit.rss) / 2;
    const classicP = H.pFromChiSquare(classicStatistic, df);
    const rows = residualRows(fit);
    const testRows = [
      { variant: "Koenker (studentized) LM", statistic: lm, df, pValue: lmP },
      { variant: "Koenker F", statistic: fStatistic, df: df, pValue: fP },
      { variant: "Classic Breusch-Pagan (normal errors)", statistic: classicStatistic, df, pValue: classicP },
    ];
    return {
      sample: { n, modelColumns: design.x[0].length, auxiliaryDf: df },
      estimates: [{ name: "auxiliary R squared", estimate: koenker.rSquared }, { name: "residual variance", estimate: fit.rss / (n - design.x[0].length) }, { name: "renderer data contract", inlineRows: "all", sampling: "none", aggregation: "none", rowCount: rows.length, residualRowsHash: H.sha256(rows), tableRole: "residual-table", vegaRole: "residual-vs-fitted" }],
      tests: [
        { name: "Breusch-Pagan (Koenker) LM", statistic: lm, distribution: "chi-square", df, pValue: lmP },
        { name: "Breusch-Pagan F", statistic: fStatistic, distribution: "F", df1: df, df2: n - df - 1, pValue: fP },
        { name: "Breusch-Pagan (classic)", statistic: classicStatistic, distribution: "chi-square", df, pValue: classicP },
      ],
      confidenceIntervals: [],
      effectSizes: [],
      assumptions: [{ name: "correctly specified mean model", status: "requires_design_review" }, { name: "normal errors (classic variant only)", status: "diagnostic_attached" }],
      diagnostics: [
        { name: "variant guidance", status: "evaluated", interpretation: "report the Koenker LM unless errors are credibly normal; the classic form is sensitive to kurtosis" },
        { name: "Jarque-Bera normality of residuals", ...H.jarqueBera(fit.residuals, budget) },
      ],
      artifacts: [
        H.tableArtifact("Breusch-Pagan heteroscedasticity test", `Auxiliary regression of squared OLS residuals on the model regressors for ${parsed.outcomeLabel}.`, [{ key: "variant", label: "Variant", type: "string" }, { key: "statistic", label: "Statistic", type: "number" }, { key: "df", label: "df", type: "number" }, { key: "pValue", label: "p", type: "number" }], testRows, ["Koenker LM = n R squared of the auxiliary regression; classic = explained SS / 2 of residuals scaled by RSS/n."], "breusch-pagan-table"),
        H.tableArtifact("Residuals and fitted values", "OLS fitted values and residuals used by the auxiliary regression.", RESIDUAL_COLUMNS, rows, [], "residual-table"),
        residualFigure(H, "residual-vs-fitted", `Residuals versus fitted values for ${parsed.outcomeLabel}`, rows),
      ],
    };
  },
  linkage: heteroscedasticityLinkage("Breusch-Pagan"),
  fixture: heteroscedasticityFixture,
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "Koenker studentized LM and F forms plus the classic Breusch-Pagan statistic from an auxiliary regression of squared OLS residuals on the model regressors (numeric and categorical predictors, up to 48 columns, n <= 5000).",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["Koenker LM, LM p, F and F p (statsmodels het_breuschpagan)", "classic statistic (numpy first principles)"], excludedOutputs: ["Jarque-Bera diagnostic"] },
    diagnostic: { level: "method-specific-partial", emitted: ["variant guidance", "Jarque-Bera normality of residuals"], limitations: ["no Goldfeld-Quandt split test"] },
    knownGaps: ["user-specified variance regressors different from the mean regressors"],
  },
};

const whiteTest = {
  method: "white_test",
  family: "assumption-tests",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["timeoutMs"],
  dataSchema: { type: "object", additionalProperties: false, required: ["y", "predictors"], properties: { y: { type: "array", minItems: 8, maxItems: 5000, items: { type: "number" } }, predictors: PREDICTOR_SCHEMA, outcomeLabel: LABEL_SCHEMA } },
  parse(data, options, H) {
    return parseRegression(data, H);
  },
  analyze(parsed, options, budget, H) {
    const S = createSupport(H);
    const { design, fit } = fitDesign(parsed, { intercept: true }, H, S, budget);
    const n = parsed.y.length;
    const terms = design.terms.slice(1);
    const base = design.x.map((row) => row.slice(1));
    const columns = base[0].map((_, j) => base.map((row) => row[j]));
    const augmented = columns.map((column) => column);
    const augmentedNames = terms.map((term) => term.name);
    for (let i = 0; i < columns.length; i += 1) {
      for (let j = i; j < columns.length; j += 1) {
        budget.check();
        const left = terms[i];
        const right = terms[j];
        if (i === j && left.kind === "categorical") continue; // dummy squared equals itself
        if (i !== j && left.kind === "categorical" && right.kind === "categorical" && left.predictor === right.predictor) continue; // same-factor dummies multiply to zero
        augmented.push(columns[i].map((value, row) => value * columns[j][row]));
        augmentedNames.push(i === j ? `${left.name}^2` : `${left.name}:${right.name}`);
      }
    }
    const auxiliaryX = parsed.y.map((_, row) => [1, ...augmented.map((column) => column[row])]);
    const df = auxiliaryX[0].length - 1;
    if (n <= df + 1) H.fail("STAT_INSUFFICIENT_SAMPLE", "white_test needs more observations than auxiliary regressors");
    if (H.matrixRank(auxiliaryX) < auxiliaryX[0].length) H.fail("STAT_RANK_DEFICIENT", "White auxiliary design (levels, squares and cross products) is rank deficient");
    const squared = fit.residuals.map((value) => value * value);
    if (H.minMax(squared).min === H.minMax(squared).max) H.fail("STAT_DEGENERATE", "squared residuals are constant");
    const auxiliary = auxiliaryRegression(squared, auxiliaryX, S, H, budget);
    const lm = n * auxiliary.rSquared;
    const lmP = H.pFromChiSquare(lm, df);
    const fStatistic = (auxiliary.rSquared / df) / ((1 - auxiliary.rSquared) / (n - df - 1));
    const fP = H.pFromF(fStatistic, df, n - df - 1);
    const rows = residualRows(fit);
    const testRows = [{ variant: "White LM", statistic: lm, df, pValue: lmP }, { variant: "White F", statistic: fStatistic, df, pValue: fP }];
    return {
      sample: { n, modelColumns: design.x[0].length, auxiliaryDf: df },
      estimates: [{ name: "auxiliary R squared", estimate: auxiliary.rSquared }, { name: "auxiliary regressors", terms: augmentedNames }, { name: "renderer data contract", inlineRows: "all", sampling: "none", aggregation: "none", rowCount: rows.length, residualRowsHash: H.sha256(rows), tableRole: "residual-table", vegaRole: "residual-vs-fitted" }],
      tests: [
        { name: "White heteroscedasticity LM", statistic: lm, distribution: "chi-square", df, pValue: lmP },
        { name: "White heteroscedasticity F", statistic: fStatistic, distribution: "F", df1: df, df2: n - df - 1, pValue: fP },
      ],
      confidenceIntervals: [],
      effectSizes: [],
      assumptions: [{ name: "correctly specified mean model", status: "requires_design_review" }, { name: "auxiliary design of full rank", status: "verified_by_method" }],
      diagnostics: [
        { name: "auxiliary design", status: "evaluated", regressors: df, note: "squares of dummy columns and same-factor cross products are omitted because they are redundant" },
        { name: "power boundary", status: n < 5 * df ? "warning" : "evaluated", interpretation: n < 5 * df ? "many auxiliary regressors relative to n; the chi-square approximation is fragile" : "adequate observations per auxiliary regressor" },
        { name: "Jarque-Bera normality of residuals", ...H.jarqueBera(fit.residuals, budget) },
      ],
      artifacts: [
        H.tableArtifact("White heteroscedasticity test", `Auxiliary regression of squared OLS residuals on regressors, squares and cross products for ${parsed.outcomeLabel}.`, [{ key: "variant", label: "Variant", type: "string" }, { key: "statistic", label: "Statistic", type: "number" }, { key: "df", label: "df", type: "number" }, { key: "pValue", label: "p", type: "number" }], testRows, ["LM = n R squared with df equal to the number of auxiliary regressors."], "white-test-table"),
        H.tableArtifact("Residuals and fitted values", "OLS fitted values and residuals used by the auxiliary regression.", RESIDUAL_COLUMNS, rows, [], "residual-table"),
        residualFigure(H, "residual-vs-fitted", `Residuals versus fitted values for ${parsed.outcomeLabel}`, rows),
      ],
    };
  },
  linkage: heteroscedasticityLinkage("White"),
  fixture: heteroscedasticityFixture,
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "White LM and F tests from the auxiliary regression of squared OLS residuals on regressors, their squares and pairwise cross products (intercept model, redundant dummy terms removed).",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["LM, LM p, F and F p (statsmodels het_white) for numeric predictors"], excludedOutputs: ["categorical redundancy removal", "Jarque-Bera diagnostic"] },
    diagnostic: { level: "method-specific-partial", emitted: ["auxiliary design", "power boundary", "Jarque-Bera normality of residuals"], limitations: ["no special-form White test with fewer regressors"] },
    knownGaps: ["special-form White test", "categorical predictor oracle"],
  },
};

// ---------------------------------------------------------------------------------
// Variance inflation factors
// ---------------------------------------------------------------------------------

const varianceInflationFactors = {
  method: "variance_inflation_factors",
  family: "assumption-tests",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["timeoutMs"],
  dataSchema: { type: "object", additionalProperties: false, required: ["predictors"], properties: { predictors: { ...PREDICTOR_SCHEMA, minItems: 2 } } },
  parse(data, options, H) {
    H.assertKeys(data, ["predictors"], "data");
    if (!Array.isArray(data.predictors) || data.predictors.length < 2) H.fail("STAT_INVALID_INPUT", "variance_inflation_factors requires at least two predictors");
    const first = H.assertObject(data.predictors[0], "data.predictors[0]");
    if (!Array.isArray(first.values)) H.fail("STAT_INVALID_INPUT", "data.predictors[0].values must be an array");
    const n = first.values.length;
    if (n < 8) H.fail("STAT_INSUFFICIENT_SAMPLE", "variance_inflation_factors requires at least 8 observations");
    if (n > 5000) H.fail("STAT_LIMIT_EXCEEDED", "predictor length must be at most 5000");
    const predictors = H.regressionPredictors(data.predictors, n);
    return { predictors, n };
  },
  analyze(parsed, options, budget, H) {
    const S = createSupport(H);
    const design = H.designMatrix({ y: Array(parsed.n).fill(0), predictors: parsed.predictors }, true);
    const columns = design.x[0].map((_, j) => design.x.map((row) => row[j]));
    const terms = design.terms.slice(1);
    if (parsed.n <= columns.length) H.fail("STAT_INSUFFICIENT_SAMPLE", "variance_inflation_factors needs more observations than design columns");
    if (H.matrixRank(design.x) < columns.length) H.fail("STAT_RANK_DEFICIENT", "predictors are perfectly collinear; VIF is infinite");
    const rows = terms.map((term, index) => {
      budget.check();
      const target = columns[index + 1];
      const others = design.x.map((row) => row.filter((_, j) => j !== index + 1));
      const aux = auxiliaryRegression(target, others, S, H, budget);
      const vif = 1 / (1 - aux.rSquared);
      return { term: term.name, rSquared: aux.rSquared, vif, tolerance: 1 - aux.rSquared, flag: vif >= 10 ? "severe" : vif >= 5 ? "moderate" : "acceptable" };
    });
    const maxVif = Math.max(...rows.map((row) => row.vif));
    return {
      sample: { n: parsed.n, terms: rows.length },
      estimates: [...rows.map((row) => ({ name: `${row.term} VIF`, estimate: row.vif, tolerance: row.tolerance })), { name: "renderer data contract", inlineRows: "all", sampling: "none", aggregation: "none", rowCount: rows.length, vifRowsHash: H.sha256(rows), tableRole: "vif-table", vegaRole: "vif-bar" }],
      tests: [],
      confidenceIntervals: [],
      effectSizes: [],
      assumptions: [{ name: "linear predictor relationships", status: "verified_by_method" }],
      diagnostics: [
        { name: "collinearity summary", status: maxVif >= 10 ? "severe" : maxVif >= 5 ? "moderate" : "acceptable", maxVif, thresholds: { moderate: 5, severe: 10 } },
        { name: "VIF boundary", status: "per_column", note: "categorical predictors are expanded to reference-coded dummies and reported per column, not as generalized VIF" },
      ],
      artifacts: [
        H.tableArtifact("Variance inflation factors", "Each design column regressed on the remaining columns (with intercept).", [{ key: "term", label: "Term", type: "string" }, { key: "rSquared", label: "R squared", type: "number" }, { key: "vif", label: "VIF", type: "number" }, { key: "tolerance", label: "Tolerance", type: "number" }, { key: "flag", label: "Flag", type: "string" }], rows, ["Flags use the common thresholds VIF >= 5 (moderate) and VIF >= 10 (severe)."], "vif-table"),
        H.vegaArtifact("vif-bar", "Variance inflation factors by term", {
          data: { values: rows },
          layer: [
            { mark: { type: "bar" }, encoding: { y: { field: "term", type: "nominal", title: "Term", sort: null }, x: { field: "vif", type: "quantitative", title: "VIF" }, color: { field: "flag", type: "nominal", title: "Flag", scale: { domain: ["acceptable", "moderate", "severe"], range: ["#2c3e50", "#e67e22", "#c0392b"] } }, tooltip: [{ field: "term" }, { field: "vif", format: ".3f" }, { field: "rSquared", format: ".3f" }] } },
            { mark: { type: "rule", strokeDash: [4, 4], color: "#e67e22" }, encoding: { x: { datum: 5 } } },
            { mark: { type: "rule", strokeDash: [4, 4], color: "#c0392b" }, encoding: { x: { datum: 10 } } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "Before interpreting individual regression coefficients, when predictors may be strongly correlated and coefficient signs or standard errors could be artifacts of collinearity.",
    decision: "Whether each predictor's coefficient can be interpreted on its own or whether predictors must be combined, dropped, centered or regularized first.",
    mustShow: "VIF and tolerance per term, the auxiliary R squared, the thresholds used, and which columns belong to the same categorical predictor.",
    userGoal: "Report coefficients whose uncertainty is not inflated by redundant predictors.",
    nextActions: [
      { trigger: "severe-collinearity", action: "combine-or-drop-redundant-predictors-or-use-ridge", reason: "Coefficients with VIF above 10 have inflated variance and unstable signs." },
      { trigger: "moderate-collinearity-with-interaction-terms", action: "center-predictors-before-forming-products", reason: "Interaction and polynomial terms create structural collinearity that centering removes." },
      { trigger: "acceptable-collinearity", action: "bind-vif-table-to-regression-report", reason: "The table is the standard evidence that coefficient interpretation is admissible." },
    ],
  },
  fixture: {
    data: { predictors: [
      { name: "height", values: [160, 172, 168, 181, 175, 158, 190, 166, 177, 169, 183, 162] },
      { name: "weight", values: [55, 70, 66, 88, 78, 52, 95, 61, 80, 64, 90, 58] },
      { name: "age", values: [23, 45, 31, 52, 38, 27, 60, 34, 41, 29, 48, 36] },
    ] },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "Per-column variance inflation factors and tolerances from auxiliary OLS regressions of each design column on the others (intercept included, categorical predictors expanded to dummies), 2-48 predictors, n <= 5000.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["VIF per column (statsmodels variance_inflation_factor)", "auxiliary R squared (numpy)"], excludedOutputs: ["flags"] },
    diagnostic: { level: "method-specific-partial", emitted: ["collinearity summary", "VIF boundary"], limitations: ["no condition-number or eigen-decomposition diagnostics"] },
    knownGaps: ["generalized VIF for multi-column categorical predictors", "condition indices"],
  },
};

module.exports = { methods: [shapiroWilk, andersonDarlingNormal, dagostinoK2, leveneTest, bartlettTest, flignerKilleen, kolmogorovSmirnovTwoSample, durbinWatson, breuschPagan, whiteTest, varianceInflationFactors] };
