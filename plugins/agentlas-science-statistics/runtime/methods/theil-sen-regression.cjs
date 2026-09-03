"use strict";

/**
 * Theil-Sen robust simple regression.
 *
 * The implementation is deliberately bounded and deterministic: it materializes all
 * non-vertical pairwise slopes, uses Sen's tie-corrected order-statistic interval, and
 * reports a tie-corrected asymptotic Kendall test for a zero monotone association.
 */

const ORACLE_FILE = "contracts/theil-sen-regression-scipy-crosscheck.py";
const MAX_PAIRWISE_SLOPES = 2_000_000;

function enumOption(values, fallback) {
  return {
    schema: { type: "string", enum: [...values] },
    default: fallback,
    parse(value, H, path) {
      if (!values.includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be one of ${values.join(", ")}`);
      return value;
    },
  };
}

function median(ordered) {
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function tieCounts(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.values()].filter((count) => count > 1);
}

function roundHalfToEven(value) {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

function kendallInference(x, y, H, budget) {
  let concordant = 0;
  let discordant = 0;
  let tiedXOnly = 0;
  let tiedYOnly = 0;
  let tiedBoth = 0;
  for (let i = 0; i < x.length - 1; i += 1) {
    for (let j = i + 1; j < x.length; j += 1) {
      budget.check();
      const dx = x[j] - x[i];
      const dy = y[j] - y[i];
      if (dx === 0 && dy === 0) tiedBoth += 1;
      else if (dx === 0) tiedXOnly += 1;
      else if (dy === 0) tiedYOnly += 1;
      else if (dx * dy > 0) concordant += 1;
      else discordant += 1;
    }
  }
  const s = concordant - discordant;
  const xTies = tieCounts(x);
  const yTies = tieCounts(y);
  const n = x.length;
  const x0 = xTies.reduce((sum, count) => sum + count * (count - 1), 0);
  const y0 = yTies.reduce((sum, count) => sum + count * (count - 1), 0);
  const x1 = xTies.reduce((sum, count) => sum + count * (count - 1) * (2 * count + 5), 0);
  const y1 = yTies.reduce((sum, count) => sum + count * (count - 1) * (2 * count + 5), 0);
  const x2 = xTies.reduce((sum, count) => sum + count * (count - 1) * (count - 2), 0);
  const y2 = yTies.reduce((sum, count) => sum + count * (count - 1) * (count - 2), 0);
  let varianceS = (n * (n - 1) * (2 * n + 5) - x1 - y1) / 18;
  varianceS += (x0 * y0) / (2 * n * (n - 1));
  if (n > 2) varianceS += (x2 * y2) / (9 * n * (n - 1) * (n - 2));
  if (!(varianceS > 0)) H.fail("STAT_DEGENERATE", "Kendall variance is zero; Theil-Sen inference is undefined");
  const comparableX = concordant + discordant + tiedYOnly;
  const comparableY = concordant + discordant + tiedXOnly;
  const tau = s / Math.sqrt(comparableX * comparableY);
  const z = s / Math.sqrt(varianceS);
  const pValue = Math.min(1, H.gammaQ(0.5, (z * z) / 2));
  return { concordant, discordant, tiedXOnly, tiedYOnly, tiedBoth, s, varianceS, tau, z, pValue };
}

const theilSenRegression = {
  method: "theil_sen_regression",
  family: "nonparametric-regression",
  analysisModel: { families: ["nonparametric"], distributions: [null], links: [null] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    interceptMethod: enumOption(["separate", "joint"], "separate"),
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["x", "y"],
    properties: {
      x: { type: "array", minItems: 3, maxItems: 2000, items: { type: "number" } },
      y: { type: "array", minItems: 3, maxItems: 2000, items: { type: "number" } },
      xLabel: { type: "string", minLength: 1, maxLength: 128 },
      yLabel: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["x", "y", "xLabel", "yLabel"], "data");
    const x = H.numericVector(data.x, "data.x", 3);
    const y = H.numericVector(data.y, "data.y", 3);
    if (x.length !== y.length) H.fail("STAT_INVALID_INPUT", "data.x and data.y must have equal lengths");
    const possiblePairs = x.length * (x.length - 1) / 2;
    if (possiblePairs > MAX_PAIRWISE_SLOPES) H.fail("STAT_LIMIT_EXCEEDED", `theil_sen_regression is limited to ${MAX_PAIRWISE_SLOPES} candidate pairs`);
    if (new Set(x).size < 2) H.fail("STAT_DEGENERATE", "theil_sen_regression requires at least two distinct x coordinates");
    if (new Set(y).size < 2) H.fail("STAT_DEGENERATE", "theil_sen_regression requires outcome variation");
    return {
      x,
      y,
      xLabel: H.label(data.xLabel, "Predictor", "data.xLabel"),
      yLabel: H.label(data.yLabel, "Outcome", "data.yLabel"),
    };
  },
  analyze(parsed, options, budget, H) {
    const { x, y, xLabel, yLabel } = parsed;
    const slopes = [];
    let verticalPairs = 0;
    for (let i = 0; i < x.length - 1; i += 1) {
      for (let j = i + 1; j < x.length; j += 1) {
        budget.check();
        const dx = x[j] - x[i];
        if (dx === 0) verticalPairs += 1;
        else slopes.push((y[j] - y[i]) / dx);
      }
    }
    slopes.sort((left, right) => left - right);
    if (!slopes.length) H.fail("STAT_DEGENERATE", "no finite non-vertical pairwise slopes are available");
    const slope = median(slopes);
    const orderedX = [...x].sort((left, right) => left - right);
    const orderedY = [...y].sort((left, right) => left - right);
    const residualIntercepts = y.map((value, index) => value - slope * x[index]).sort((left, right) => left - right);
    const intercept = options.interceptMethod === "joint"
      ? median(residualIntercepts)
      : median(orderedY) - slope * median(orderedX);
    const xTies = tieCounts(x);
    const yTies = tieCounts(y);
    const n = x.length;
    const tieTerm = (counts) => counts.reduce((sum, count) => sum + count * (count - 1) * (2 * count + 5), 0);
    const slopeVariance = (n * (n - 1) * (2 * n + 5) - tieTerm(xTies) - tieTerm(yTies)) / 18;
    if (!(slopeVariance > 0)) H.fail("STAT_DEGENERATE", "Sen slope interval variance is zero");
    const alpha = 1 - options.confidenceLevel;
    const zLowerTail = H.normalInv(alpha / 2);
    const sigma = Math.sqrt(slopeVariance);
    const upperIndex = Math.min(roundHalfToEven((slopes.length - zLowerTail * sigma) / 2), slopes.length - 1);
    const lowerIndex = Math.max(roundHalfToEven((slopes.length + zLowerTail * sigma) / 2) - 1, 0);
    const lower = slopes[lowerIndex];
    const upper = slopes[upperIndex];
    const kendall = kendallInference(x, y, H, budget);
    const rows = x.map((value, index) => ({
      x: value,
      observed: y[index],
      predicted: intercept + slope * value,
      residual: y[index] - intercept - slope * value,
      partition: "observed",
    }));
    const summaryRow = {
      predictor: xLabel,
      outcome: yLabel,
      n,
      slope,
      intercept,
      slopeLower: lower,
      slopeUpper: upper,
      confidenceLevel: options.confidenceLevel,
      interceptMethod: options.interceptMethod,
      kendallTauB: kendall.tau,
      kendallZ: kendall.z,
      pValue: kendall.pValue,
      candidateSlopes: slopes.length,
      verticalPairs,
    };
    return {
      sample: { n, candidateSlopes: slopes.length, verticalPairs, distinctX: new Set(x).size },
      estimates: [
        { parameter: "Theil-Sen slope", estimate: slope },
        { parameter: "intercept", estimate: intercept, method: options.interceptMethod },
      ],
      tests: [{ name: "Kendall monotone association test", statistic: kendall.z, distribution: "asymptotic standard normal with tie-corrected S variance", pValue: kendall.pValue, alternative: "two-sided", tauB: kendall.tau }],
      confidenceIntervals: [{ parameter: "Theil-Sen slope", level: options.confidenceLevel, lower, upper, method: "Sen tie-corrected order-statistic interval" }],
      effectSizes: [{ name: "Kendall tau-b", estimate: kendall.tau }, { name: "median pairwise slope", estimate: slope }],
      assumptions: [
        { name: "independent paired observations", status: "requires_design_review" },
        { name: "monotone linear trend for slope interpretation", status: "requires_shape_review" },
        { name: "no intercept confidence interval", status: "method_definition" },
      ],
      diagnostics: [
        { name: "pairwise slope enumeration", status: "complete", candidateSlopes: slopes.length, verticalPairs, cap: MAX_PAIRWISE_SLOPES },
        { name: "ties", status: xTies.length || yTies.length ? "present" : "absent", tiedXGroups: xTies.length, tiedYGroups: yTies.length, tiedBothPairs: kendall.tiedBoth },
        { name: "lineage hashes", status: "materialized", summaryRowsSha256: H.sha256([summaryRow]), figureRowsSha256: H.sha256(rows) },
      ],
      artifacts: [
        H.tableArtifact(
          "Theil-Sen robust regression",
          `${Math.round(options.confidenceLevel * 100)}% Sen order-statistic interval and tie-corrected Kendall test.`,
          [
            { key: "predictor", label: "Predictor", type: "string" }, { key: "outcome", label: "Outcome", type: "string" },
            { key: "n", label: "N", type: "number" }, { key: "slope", label: "Slope", type: "number" },
            { key: "intercept", label: "Intercept", type: "number" }, { key: "slopeLower", label: "Slope CI lower", type: "number" },
            { key: "slopeUpper", label: "Slope CI upper", type: "number" }, { key: "confidenceLevel", label: "Confidence level", type: "number" },
            { key: "interceptMethod", label: "Intercept method", type: "string" }, { key: "kendallTauB", label: "Kendall tau-b", type: "number" },
            { key: "kendallZ", label: "Kendall z", type: "number" }, { key: "pValue", label: "Two-sided p", type: "number" },
            { key: "candidateSlopes", label: "Candidate slopes", type: "number" }, { key: "verticalPairs", label: "Vertical pairs omitted", type: "number" },
          ],
          [summaryRow],
          ["The slope interval does not include intercept uncertainty; p is an asymptotic test of zero monotone association."],
          "theil-sen-regression-table",
        ),
        H.tableArtifact(
          "Theil-Sen observed and fitted values",
          "Observation-level values used by the bound observed-versus-fitted figure.",
          [
            { key: "x", label: xLabel, type: "number" }, { key: "observed", label: `Observed ${yLabel}`, type: "number" },
            { key: "predicted", label: `Fitted ${yLabel}`, type: "number" }, { key: "residual", label: "Residual", type: "number" },
            { key: "partition", label: "Partition", type: "string" },
          ],
          rows,
          ["Predictions use the reported Theil-Sen slope and selected intercept convention."],
          "theil-sen-observed-fitted-table",
        ),
        H.vegaArtifact("observed-fitted-plot", "Theil-Sen observed versus fitted outcome", {
          data: { values: rows },
          layer: [
            { mark: { type: "point", filled: true, opacity: 0.75, size: 65, color: "#2f6f9f" }, encoding: { x: { field: "observed", type: "quantitative", title: `Observed ${yLabel}` }, y: { field: "predicted", type: "quantitative", title: `Theil-Sen fitted ${yLabel}` }, tooltip: [{ field: "x", title: xLabel, format: ".6g" }, { field: "observed", format: ".6g" }, { field: "predicted", format: ".6g" }, { field: "residual", format: ".6g" }] } },
            { mark: { type: "line", strokeWidth: 2, color: "#9b2c2c" }, encoding: { x: { field: "observed", type: "quantitative" }, y: { field: "observed", type: "quantitative" }, order: { field: "observed", type: "quantitative" } } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "A simple linear trend must remain interpretable when response outliers make ordinary least squares slopes unstable.",
    decision: "Decide the direction and robust magnitude of a monotone linear trend while exposing its order-statistic uncertainty.",
    mustShow: "The median pairwise slope, its Sen interval, the selected intercept convention, the Kendall test, and omitted vertical-pair count.",
    userGoal: "Report a bounded deterministic robust regression result with a publication table and an observed-versus-fitted diagnostic figure.",
    nextActions: [
      { trigger: "slope-interval-excludes-zero", action: "report-robust-trend-with-interval", reason: "The order-statistic interval supports a nonzero monotone slope while conveying magnitude." },
      { trigger: "many-vertical-pairs", action: "review-predictor-resolution", reason: "Repeated predictor coordinates reduce the number of candidate pairwise slopes." },
      { trigger: "nonlinear-pattern-visible", action: "use-a-nonlinear-or-quantile-model", reason: "Theil-Sen is robust to response outliers but still summarizes one straight-line trend." },
    ],
  },
  fixture: {
    data: { x: [1, 2, 3, 4, 5, 6, 7, 8, 9], y: [2.1, 4.2, 6.0, 8.3, 10.1, 29.0, 14.1, 16.2, 18.0], xLabel: "Dose", yLabel: "Response" },
    options: { confidenceLevel: 0.95, interceptMethod: "separate" },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression", "matlab.stats.hypothesis.linear"] },
  coverage: {
    implementedBoundary: "Deterministic simple Theil-Sen regression with complete non-vertical pairwise-slope enumeration, separate or joint intercept, Sen tie-corrected slope interval, and asymptotic tie-corrected Kendall inference.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["slope", "intercept", "slope interval", "Kendall tau-b", "Kendall p value", "observed/fitted artifact row closure"], excludedOutputs: ["intercept interval", "multivariable Theil-Sen", "censored response"] },
    diagnostic: { level: "method-specific-partial", emitted: ["complete candidate-slope and vertical-pair counts", "x/y tie groups", "table and figure row hashes"], limitations: ["Kendall p value is asymptotic", "intercept has no confidence interval"] },
    knownGaps: ["simple regression only", "quadratic memory/time in sample size", "no measurement-error correction", "no confidence interval for the intercept"],
  },
};

module.exports = { methods: [theilSenRegression] };
