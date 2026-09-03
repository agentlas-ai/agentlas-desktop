"use strict";

/**
 * Equivalence and agreement family: two one-sided tests (TOST) for mean equivalence,
 * non-inferiority tests for means and proportions with an explicit margin, and
 * Bland-Altman limits-of-agreement analysis with proportional-bias regression.
 *
 * All numerics arrive through the engine helper surface `H` plus the sibling
 * shared-precision-distributions module (Cody normal CDF for the proportion z tests).
 */

const { createSupport } = require("./shared-precision-distributions.cjs");

const ORACLE = "contracts/equivalence-scipy-crosscheck.py";
const LABEL_SCHEMA = { type: "string", minLength: 1, maxLength: 128 };
const VECTOR_SCHEMA = (minItems) => ({ type: "array", minItems, maxItems: 100000, items: { type: "number" } });
const COUNT_SCHEMA = { type: "integer", minimum: 0, maximum: 100000000 };

const BOUND_OPTION = (description) => ({
  schema: { type: ["number", "null"], description },
  default: null,
  parse(value, H, path) {
    if (value === null) return null;
    return H.finiteNumber(value, path);
  },
});

const VARIANCE_OPTION = {
  schema: { type: "string", enum: ["welch", "pooled"] },
  default: "welch",
  parse(value, H, path) {
    if (!["welch", "pooled"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be welch or pooled`);
    return value;
  },
};

function rendererContract(rows, tableRole, vegaRole, hashKey, H) {
  return { name: "renderer data contract", inlineRows: "all", sampling: "none", aggregation: "none", rowCount: rows.length, [hashKey]: H.sha256(rows), tableRole, vegaRole };
}

function summary(values, H, budget) {
  const n = values.length;
  const mean = H.mean(values, budget);
  const variance = H.variance(values, true, budget);
  return { n, mean, variance, sd: Math.sqrt(variance) };
}

function normality(label, values, H, budget) {
  return { sample: label, ...H.jarqueBera(values, budget) };
}

/**
 * Mean-difference core shared by TOST and mean non-inferiority.
 * Returns { estimate, standardError, df, scale } where `scale` is the standardizer for Cohen d.
 */
function differenceCore(design, x, y, varianceAssumption, H, budget) {
  if (design === "one-sample") {
    const s = summary(x, H, budget);
    if (!(s.variance > 0)) H.fail("STAT_DEGENERATE", "data.x has zero variance");
    return { estimate: s.mean, standardError: s.sd / Math.sqrt(s.n), df: s.n - 1, scale: s.sd, summaries: [{ sample: "x", ...s }] };
  }
  if (design === "paired") {
    const differences = x.map((value, index) => value - y[index]);
    const s = summary(differences, H, budget);
    if (!(s.variance > 0)) H.fail("STAT_DEGENERATE", "paired differences have zero variance");
    const sx = summary(x, H, budget);
    const sy = summary(y, H, budget);
    return { estimate: s.mean, standardError: s.sd / Math.sqrt(s.n), df: s.n - 1, scale: s.sd, differences, summaries: [{ sample: "x", ...sx }, { sample: "y", ...sy }, { sample: "x - y", ...s }] };
  }
  const sx = summary(x, H, budget);
  const sy = summary(y, H, budget);
  if (!(sx.variance > 0) || !(sy.variance > 0)) H.fail("STAT_DEGENERATE", "both samples need positive variance");
  const pooledVariance = ((sx.n - 1) * sx.variance + (sy.n - 1) * sy.variance) / (sx.n + sy.n - 2);
  if (varianceAssumption === "pooled") {
    return { estimate: sx.mean - sy.mean, standardError: Math.sqrt(pooledVariance * (1 / sx.n + 1 / sy.n)), df: sx.n + sy.n - 2, scale: Math.sqrt(pooledVariance), summaries: [{ sample: "x", ...sx }, { sample: "y", ...sy }] };
  }
  const vx = sx.variance / sx.n;
  const vy = sy.variance / sy.n;
  const df = (vx + vy) ** 2 / (vx * vx / (sx.n - 1) + vy * vy / (sy.n - 1));
  return { estimate: sx.mean - sy.mean, standardError: Math.sqrt(vx + vy), df, scale: Math.sqrt(pooledVariance), summaries: [{ sample: "x", ...sx }, { sample: "y", ...sy }] };
}

function intervalBandSpec(title, xTitle, bandFields, ciFields, pointField, referenceField) {
  // Layered Vega-Lite: shaded acceptance band, reference rule, interval rule, point estimate.
  return {
    title,
    width: 480,
    height: 120,
    layer: [
      { mark: { type: "rect", opacity: 0.18, color: "#2a9d8f" }, encoding: { x: { field: bandFields[0], type: "quantitative", title: xTitle }, x2: { field: bandFields[1] } } },
      { mark: { type: "rule", strokeDash: [4, 4], color: "#6c757d" }, encoding: { x: { field: referenceField, type: "quantitative" } } },
      { mark: { type: "rule", color: "#1d3557", strokeWidth: 2.5 }, encoding: { x: { field: ciFields[0], type: "quantitative" }, x2: { field: ciFields[1] }, y: { field: "parameter", type: "nominal", title: null } } },
      { mark: { type: "point", filled: true, size: 120, color: "#1d3557" }, encoding: { x: { field: pointField, type: "quantitative" }, y: { field: "parameter", type: "nominal", title: null }, tooltip: [{ field: pointField, type: "quantitative" }, { field: ciFields[0], type: "quantitative" }, { field: ciFields[1], type: "quantitative" }] } },
    ],
  };
}

function parseDesignData(data, options, H) {
  H.assertKeys(data, ["x", "y", "xLabel", "yLabel", "outcomeLabel"], "data");
  const design = options.design;
  const x = H.numericVector(data.x, "data.x", 2);
  let y = null;
  if (design === "one-sample") {
    if (data.y !== undefined) H.fail("STAT_INVALID_INPUT", "data.y is not accepted for the one-sample design");
  } else {
    if (data.y === undefined) H.fail("STAT_INVALID_INPUT", `data.y is required for the ${design} design`);
    y = H.numericVector(data.y, "data.y", 2);
    if (design === "paired" && y.length !== x.length) H.fail("STAT_INVALID_INPUT", "paired design requires data.x and data.y of equal length");
  }
  if (x.length < 3 || (y !== null && y.length < 3)) H.fail("STAT_INSUFFICIENT_SAMPLE", "each sample needs at least three observations");
  return {
    design,
    x,
    y,
    xLabel: H.label(data.xLabel, design === "one-sample" ? "Sample" : "Test", "data.xLabel"),
    yLabel: H.label(data.yLabel, "Reference", "data.yLabel"),
    outcomeLabel: H.label(data.outcomeLabel, "Outcome", "data.outcomeLabel"),
  };
}

// ---------------------------------------------------------------------------------
// TOST equivalence
// ---------------------------------------------------------------------------------

const tostEquivalence = {
  method: "tost_equivalence",
  family: "equivalence",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    design: {
      schema: { type: "string", enum: ["independent", "paired", "one-sample"] },
      default: "independent",
      parse(value, H, path) {
        if (!["independent", "paired", "one-sample"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be independent, paired, or one-sample`);
        return value;
      },
    },
    lowerBound: BOUND_OPTION("Lower equivalence bound on the raw difference scale (required)."),
    upperBound: BOUND_OPTION("Upper equivalence bound on the raw difference scale (required)."),
    varianceAssumption: VARIANCE_OPTION,
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["x"],
    properties: { x: VECTOR_SCHEMA(3), y: VECTOR_SCHEMA(3), xLabel: LABEL_SCHEMA, yLabel: LABEL_SCHEMA, outcomeLabel: LABEL_SCHEMA },
  },
  parse(data, options, H) {
    const parsed = parseDesignData(data, options, H);
    if (options.lowerBound === null || options.upperBound === null) H.fail("STAT_INVALID_INPUT", "options.lowerBound and options.upperBound are required for TOST");
    if (!(options.lowerBound < options.upperBound)) H.fail("STAT_INVALID_INPUT", "options.lowerBound must be strictly below options.upperBound");
    return parsed;
  },
  analyze(parsed, options, budget, H) {
    const { design, x, y } = parsed;
    const alpha = 1 - options.confidenceLevel;
    const core = differenceCore(design, x, y, options.varianceAssumption, H, budget);
    const { estimate, standardError, df } = core;
    if (!(standardError > 0) || !(df > 0)) H.fail("STAT_DEGENERATE", "standard error or degrees of freedom are not positive");
    const lowerBound = options.lowerBound;
    const upperBound = options.upperBound;
    const tLower = (estimate - lowerBound) / standardError;
    const tUpper = (estimate - upperBound) / standardError;
    const pLower = H.pFromT(tLower, df, "greater");
    const pUpper = H.pFromT(tUpper, df, "less");
    const pTost = Math.max(pLower, pUpper);
    const tostCritical = H.tCritical(1 - 2 * alpha, df);
    const standardCritical = H.tCritical(options.confidenceLevel, df);
    const tostLower = estimate - tostCritical * standardError;
    const tostUpper = estimate + tostCritical * standardError;
    const equivalent = pTost < alpha;
    const differenceLabel = design === "one-sample" ? `${parsed.xLabel} mean` : `${parsed.xLabel} - ${parsed.yLabel}`;
    const cohenD = estimate / core.scale;
    const dLabel = design === "paired" ? "Cohen dz" : "Cohen d";
    const testRows = [
      { hypothesis: `H0: difference <= ${lowerBound}`, bound: lowerBound, statistic: tLower, df, pValue: pLower, alternative: "greater", rejected: pLower < alpha },
      { hypothesis: `H0: difference >= ${upperBound}`, bound: upperBound, statistic: tUpper, df, pValue: pUpper, alternative: "less", rejected: pUpper < alpha },
    ];
    const intervalRows = [{
      parameter: differenceLabel,
      estimate,
      standardError,
      df,
      lower: tostLower,
      upper: tostUpper,
      level: 1 - 2 * alpha,
      lowerBound,
      upperBound,
      reference: 0,
      tostPValue: pTost,
      equivalent,
    }];
    const testColumns = [
      { key: "hypothesis", label: "Null hypothesis", type: "string" },
      { key: "bound", label: "Bound", type: "number" },
      { key: "statistic", label: "t", type: "number" },
      { key: "df", label: "df", type: "number" },
      { key: "pValue", label: "One-sided p", type: "number" },
      { key: "alternative", label: "Alternative", type: "string" },
      { key: "rejected", label: "Rejected at alpha", type: "boolean" },
    ];
    const intervalColumns = [
      { key: "parameter", label: "Parameter", type: "string" },
      { key: "estimate", label: "Estimate", type: "number" },
      { key: "standardError", label: "SE", type: "number" },
      { key: "df", label: "df", type: "number" },
      { key: "lower", label: "TOST CI lower", type: "number" },
      { key: "upper", label: "TOST CI upper", type: "number" },
      { key: "level", label: "CI level", type: "number" },
      { key: "lowerBound", label: "Lower equivalence bound", type: "number" },
      { key: "upperBound", label: "Upper equivalence bound", type: "number" },
      { key: "reference", label: "Reference", type: "number" },
      { key: "tostPValue", label: "TOST p", type: "number" },
      { key: "equivalent", label: "Equivalent", type: "boolean" },
    ];
    const diagnostics = [];
    if (design === "paired") diagnostics.push(normality("x - y differences", core.differences, H, budget));
    else if (design === "one-sample") diagnostics.push(normality(parsed.xLabel, x, H, budget));
    else {
      diagnostics.push(normality(parsed.xLabel, x, H, budget), normality(parsed.yLabel, y, H, budget));
      diagnostics.push(H.leveneDiagnostic([{ name: parsed.xLabel, values: x }, { name: parsed.yLabel, values: y }], budget));
    }
    diagnostics.push(
      { name: "equivalence decision", status: equivalent ? "equivalent_within_bounds" : "not_established", alpha, tostPValue: pTost, intervalWithinBounds: tostLower > lowerBound && tostUpper < upperBound },
      { name: "interval boundary", status: "t_based", note: `The ${Math.round((1 - 2 * alpha) * 100)}% interval is the TOST-equivalent interval; equivalence holds exactly when it lies inside the bounds.` },
      { name: "bound scale", status: "raw_units", note: "Bounds are applied on the raw difference scale; the standardized bounds are reported only as descriptive effect sizes." },
    );
    const assumptions = [
      { name: design === "paired" ? "paired observations" : "independent observations", status: "requires_design_review" },
      { name: design === "paired" ? "normal paired differences" : "normal samples", status: "diagnostic_attached" },
    ];
    if (design === "independent") assumptions.push({ name: "equal variances", status: options.varianceAssumption === "pooled" ? "assumed_by_pooled_variance" : "not_required_by_welch" });
    return {
      sample: { n: design === "independent" ? x.length + y.length : x.length, design, sizes: design === "independent" ? [x.length, y.length] : [x.length] },
      estimates: [
        { name: differenceLabel, estimate, standardError, df, method: design === "independent" ? `${options.varianceAssumption} t` : "paired/one-sample t" },
        ...core.summaries.map((row) => ({ name: `${row.sample} summary`, n: row.n, mean: row.mean, sd: row.sd })),
        rendererContract(intervalRows, "tost-interval-table", "equivalence-interval-plot", "intervalRowsHash", H),
      ],
      tests: [
        { name: "TOST lower bound", statistic: tLower, distribution: "t", df, pValue: pLower, alternative: "greater", bound: lowerBound },
        { name: "TOST upper bound", statistic: tUpper, distribution: "t", df, pValue: pUpper, alternative: "less", bound: upperBound },
        { name: "TOST equivalence", statistic: pLower >= pUpper ? tLower : tUpper, distribution: "t", df, pValue: pTost, method: "maximum of the two one-sided p-values" },
      ],
      confidenceIntervals: [
        { parameter: differenceLabel, level: 1 - 2 * alpha, lower: tostLower, upper: tostUpper, method: "TOST (1 - 2 alpha) t interval" },
        { parameter: differenceLabel, level: options.confidenceLevel, lower: estimate - standardCritical * standardError, upper: estimate + standardCritical * standardError, method: "two-sided t interval" },
      ],
      effectSizes: [
        { name: dLabel, estimate: cohenD, lower: null, upper: null, standardizer: design === "independent" ? "pooled SD" : "SD of the analysed values" },
        { name: "standardized lower bound", estimate: lowerBound / core.scale },
        { name: "standardized upper bound", estimate: upperBound / core.scale },
      ],
      assumptions,
      diagnostics,
      artifacts: [
        H.tableArtifact("Two one-sided tests", `TOST for ${parsed.outcomeLabel}: each bound is tested at one-sided alpha = ${alpha}.`, testColumns, testRows, ["Equivalence is declared only when both null hypotheses are rejected."], "tost-table"),
        H.tableArtifact("Equivalence interval", `Mean difference with its (1 - 2 alpha) interval against the equivalence bounds.`, intervalColumns, intervalRows, [], "tost-interval-table"),
        H.vegaArtifact("equivalence-interval-plot", `${parsed.outcomeLabel}: TOST interval against equivalence bounds`, { data: { values: intervalRows }, ...intervalBandSpec(null, `Difference in ${parsed.outcomeLabel}`, ["lowerBound", "upperBound"], ["lower", "upper"], "estimate", "reference") }),
      ],
    };
  },
  linkage: {
    neededWhen: "When the research claim is that two conditions (or a mean and a target) do not differ by more than a prespecified, practically negligible amount.",
    decision: "Whether the mean difference can be declared equivalent within the stated bounds, rather than merely failing to reject a difference.",
    mustShow: "The bounds, the mean difference with its (1 - 2 alpha) interval, both one-sided t statistics with p-values, the standardized bounds, and the normality and variance diagnostics.",
    userGoal: "Report an equivalence conclusion that is falsifiable at a stated bound instead of misreading a non-significant test as no difference.",
    nextActions: [
      { trigger: "interval-crosses-a-bound", action: "report-not-established-and-consider-sample-size", reason: "Failure to establish equivalence is usually a precision problem, not evidence of a difference." },
      { trigger: "bounds-chosen-after-seeing-data", action: "flag-bound-justification-in-report", reason: "Post hoc bounds invalidate the error control of TOST." },
      { trigger: "normality-diagnostic-rejects", action: "consider-robust-or-bootstrap-equivalence-interval", reason: "The t interval can be miscalibrated for skewed small samples." },
    ],
  },
  fixture: {
    data: {
      x: [10.2, 9.8, 10.5, 10.1, 9.9, 10.4, 10.0, 9.7, 10.3, 10.1, 9.6, 10.2],
      y: [10.0, 10.3, 9.9, 10.2, 9.8, 10.1, 10.4, 9.7, 10.0, 10.2, 9.9, 10.1],
      xLabel: "generic",
      yLabel: "brand",
      outcomeLabel: "plasma concentration",
    },
    options: { confidenceLevel: 0.95, design: "independent", lowerBound: -0.5, upperBound: 0.5, varianceAssumption: "welch" },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.location"] },
  coverage: {
    implementedBoundary: "TOST for independent (Welch or pooled), paired and one-sample means with raw-scale asymmetric bounds, one-sided t p-values, the (1 - 2 alpha) t interval and descriptive standardized effect sizes.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["mean difference, Welch/pooled/paired/one-sample df, both one-sided t statistics and p-values (statsmodels ttost_ind / ttost_paired / DescrStatsW.ttost_mean)", "symmetric-bound TOST p (pingouin.tost)", "TOST interval bounds (scipy.stats.t)", "Cohen d / dz (pingouin.compute_effsize)"], excludedOutputs: ["diagnostics", "standardized bound descriptives"] },
    diagnostic: { level: "method-specific-partial", emitted: ["Jarque-Bera normality", "Brown-Forsythe variance homogeneity (independent design)", "equivalence decision", "interval boundary"], limitations: ["no bootstrap or robust alternative", "no standardized-bound inference"] },
    knownGaps: ["equivalence on ratio (log) scale", "equivalence of proportions or correlations", "noncentral intervals for the standardized difference"],
  },
};

// ---------------------------------------------------------------------------------
// Non-inferiority (means and proportions)
// ---------------------------------------------------------------------------------

const nonInferiorityTest = {
  method: "non_inferiority_test",
  family: "equivalence",
  analysisModel: { families: ["lm", "glm"], distributions: [null, "normal", "gaussian", "binomial"], links: [null, "identity", "logit"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    margin: {
      schema: { type: ["number", "null"], exclusiveMinimum: 0, description: "Non-inferiority margin on the raw difference scale (required, > 0)." },
      default: null,
      parse(value, H, path) {
        if (value === null) return null;
        const margin = H.finiteNumber(value, path);
        if (!(margin > 0)) H.fail("STAT_INVALID_INPUT", `${path} must be strictly positive`);
        return margin;
      },
    },
    direction: {
      schema: { type: "string", enum: ["higher-is-better", "lower-is-better"] },
      default: "higher-is-better",
      parse(value, H, path) {
        if (!["higher-is-better", "lower-is-better"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be higher-is-better or lower-is-better`);
        return value;
      },
    },
    varianceAssumption: VARIANCE_OPTION,
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      testValues: VECTOR_SCHEMA(3),
      referenceValues: VECTOR_SCHEMA(3),
      testSuccesses: COUNT_SCHEMA,
      testTrials: { type: "integer", minimum: 1, maximum: 100000000 },
      referenceSuccesses: COUNT_SCHEMA,
      referenceTrials: { type: "integer", minimum: 1, maximum: 100000000 },
      testLabel: LABEL_SCHEMA,
      referenceLabel: LABEL_SCHEMA,
      outcomeLabel: LABEL_SCHEMA,
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["testValues", "referenceValues", "testSuccesses", "testTrials", "referenceSuccesses", "referenceTrials", "testLabel", "referenceLabel", "outcomeLabel"], "data");
    if (options.margin === null) H.fail("STAT_INVALID_INPUT", "options.margin is required for a non-inferiority test");
    const hasMeans = data.testValues !== undefined || data.referenceValues !== undefined;
    const hasCounts = ["testSuccesses", "testTrials", "referenceSuccesses", "referenceTrials"].some((key) => data[key] !== undefined);
    if (hasMeans === hasCounts) H.fail("STAT_INVALID_INPUT", "supply either testValues/referenceValues (means) or testSuccesses/testTrials/referenceSuccesses/referenceTrials (proportions), not both");
    const labels = {
      testLabel: H.label(data.testLabel, "Test", "data.testLabel"),
      referenceLabel: H.label(data.referenceLabel, "Reference", "data.referenceLabel"),
      outcomeLabel: H.label(data.outcomeLabel, "Outcome", "data.outcomeLabel"),
    };
    if (hasMeans) {
      const test = H.numericVector(data.testValues, "data.testValues", 3);
      const reference = H.numericVector(data.referenceValues, "data.referenceValues", 3);
      return { outcome: "means", test, reference, ...labels };
    }
    const counts = {};
    for (const key of ["testSuccesses", "testTrials", "referenceSuccesses", "referenceTrials"]) counts[key] = H.integer(data[key], 0, 100000000, `data.${key}`);
    if (counts.testTrials < 1 || counts.referenceTrials < 1) H.fail("STAT_INVALID_INPUT", "trial counts must be at least 1");
    if (counts.testSuccesses > counts.testTrials || counts.referenceSuccesses > counts.referenceTrials) H.fail("STAT_INVALID_INPUT", "successes cannot exceed trials");
    return { outcome: "proportions", ...counts, ...labels };
  },
  analyze(parsed, options, budget, H) {
    const alpha = 1 - options.confidenceLevel;
    const margin = options.margin;
    const higher = options.direction === "higher-is-better";
    const differenceLabel = `${parsed.testLabel} - ${parsed.referenceLabel}`;
    let estimate;
    let standardError;
    let df = null;
    let distribution;
    let summaries;
    let effectSizes;
    const diagnostics = [];
    const assumptions = [{ name: "independent samples", status: "requires_design_review" }];
    if (parsed.outcome === "means") {
      const core = differenceCore("independent", parsed.test, parsed.reference, options.varianceAssumption, H, budget);
      estimate = core.estimate;
      standardError = core.standardError;
      df = core.df;
      distribution = "t";
      summaries = [{ name: `${parsed.testLabel} summary`, n: core.summaries[0].n, mean: core.summaries[0].mean, sd: core.summaries[0].sd }, { name: `${parsed.referenceLabel} summary`, n: core.summaries[1].n, mean: core.summaries[1].mean, sd: core.summaries[1].sd }];
      effectSizes = [{ name: "Cohen d", estimate: estimate / core.scale, standardizer: "pooled SD" }, { name: "standardized margin", estimate: margin / core.scale }];
      diagnostics.push(normality(parsed.testLabel, parsed.test, H, budget), normality(parsed.referenceLabel, parsed.reference, H, budget));
      diagnostics.push(H.leveneDiagnostic([{ name: parsed.testLabel, values: parsed.test }, { name: parsed.referenceLabel, values: parsed.reference }], budget));
      assumptions.push({ name: "normal samples", status: "diagnostic_attached" }, { name: "equal variances", status: options.varianceAssumption === "pooled" ? "assumed_by_pooled_variance" : "not_required_by_welch" });
    } else {
      const pTest = parsed.testSuccesses / parsed.testTrials;
      const pReference = parsed.referenceSuccesses / parsed.referenceTrials;
      estimate = pTest - pReference;
      const variance = pTest * (1 - pTest) / parsed.testTrials + pReference * (1 - pReference) / parsed.referenceTrials;
      if (!(variance > 0)) H.fail("STAT_DEGENERATE", "both proportions are 0 or 1, so the Wald standard error is zero");
      standardError = Math.sqrt(variance);
      distribution = "normal";
      summaries = [
        { name: `${parsed.testLabel} proportion`, estimate: pTest, successes: parsed.testSuccesses, trials: parsed.testTrials },
        { name: `${parsed.referenceLabel} proportion`, estimate: pReference, successes: parsed.referenceSuccesses, trials: parsed.referenceTrials },
      ];
      effectSizes = [
        { name: "risk difference", estimate },
        { name: "relative risk", estimate: pReference > 0 ? pTest / pReference : null },
      ];
      const minExpected = Math.min(parsed.testSuccesses, parsed.testTrials - parsed.testSuccesses, parsed.referenceSuccesses, parsed.referenceTrials - parsed.referenceSuccesses);
      diagnostics.push({ name: "normal approximation boundary", status: minExpected >= 5 ? "asymptotic" : "small_count_warning", minimumCellCount: minExpected, note: "Wald standard error uses the unpooled sample proportions; counts below 5 make it unreliable." });
      assumptions.push({ name: "binomial counts", status: "requires_design_review" }, { name: "large-sample normal approximation", status: minExpected >= 5 ? "asymptotic" : "not_established" });
    }
    const S = createSupport(H);
    const pTail = (statistic, alternative) => (distribution === "t" ? H.pFromT(statistic, df, alternative) : alternative === "greater" ? S.pnormUpper(statistic) : S.pnorm(statistic));
    const critical = distribution === "t" ? H.tCritical(1 - 2 * alpha, df) : S.qnorm(1 - alpha);
    const twoSidedCritical = distribution === "t" ? H.tCritical(options.confidenceLevel, df) : S.qnorm(1 - alpha / 2);
    // Non-inferiority: higher-is-better tests H0: effect <= -margin; lower-is-better tests H0: effect >= +margin.
    const niStatistic = higher ? (estimate + margin) / standardError : (estimate - margin) / standardError;
    const niAlternative = higher ? "greater" : "less";
    const niP = pTail(niStatistic, niAlternative);
    const superiorityStatistic = estimate / standardError;
    const superiorityP = pTail(superiorityStatistic, niAlternative);
    const oneSidedBound = higher ? estimate - critical * standardError : estimate + critical * standardError;
    const nonInferior = niP < alpha;
    const superior = superiorityP < alpha;
    const marginBoundary = higher ? -margin : margin;
    const testRows = [
      { hypothesis: higher ? `H0: difference <= ${-margin} (inferior)` : `H0: difference >= ${margin} (inferior)`, statistic: niStatistic, df, pValue: niP, alternative: niAlternative, conclusion: nonInferior ? "non-inferior" : "not established" },
      { hypothesis: higher ? "H0: difference <= 0 (not superior)" : "H0: difference >= 0 (not superior)", statistic: superiorityStatistic, df, pValue: superiorityP, alternative: niAlternative, conclusion: superior ? "superior" : "not established" },
    ];
    const intervalRows = [{
      parameter: differenceLabel,
      estimate,
      standardError,
      df,
      oneSidedBound,
      lower: estimate - critical * standardError,
      upper: estimate + critical * standardError,
      level: 1 - 2 * alpha,
      marginBoundary,
      reference: 0,
      pValue: niP,
      nonInferior,
    }];
    const testColumns = [
      { key: "hypothesis", label: "Null hypothesis", type: "string" },
      { key: "statistic", label: distribution === "t" ? "t" : "z", type: "number" },
      { key: "df", label: "df", type: "number" },
      { key: "pValue", label: "One-sided p", type: "number" },
      { key: "alternative", label: "Alternative", type: "string" },
      { key: "conclusion", label: "Conclusion", type: "string" },
    ];
    const intervalColumns = [
      { key: "parameter", label: "Parameter", type: "string" },
      { key: "estimate", label: "Estimate", type: "number" },
      { key: "standardError", label: "SE", type: "number" },
      { key: "df", label: "df", type: "number" },
      { key: "oneSidedBound", label: higher ? "One-sided lower bound" : "One-sided upper bound", type: "number" },
      { key: "lower", label: "(1 - 2 alpha) CI lower", type: "number" },
      { key: "upper", label: "(1 - 2 alpha) CI upper", type: "number" },
      { key: "level", label: "CI level", type: "number" },
      { key: "marginBoundary", label: "Margin boundary", type: "number" },
      { key: "reference", label: "Reference", type: "number" },
      { key: "pValue", label: "Non-inferiority p", type: "number" },
      { key: "nonInferior", label: "Non-inferior", type: "boolean" },
    ];
    diagnostics.push(
      { name: "non-inferiority decision", status: nonInferior ? "non_inferior" : "not_established", alpha, pValue: niP, boundInsideMargin: higher ? oneSidedBound > -margin : oneSidedBound < margin },
      { name: "superiority", status: superior ? "superior" : "not_established", pValue: superiorityP, note: "Superiority is a secondary, hierarchical claim after non-inferiority." },
      { name: "margin scale", status: "raw_units", note: "The margin applies to the raw difference; the standardized margin (means) is descriptive only." },
    );
    const bandFields = higher ? ["marginBoundary", "upper"] : ["lower", "marginBoundary"];
    return {
      sample: parsed.outcome === "means" ? { n: parsed.test.length + parsed.reference.length, outcome: "means", sizes: [parsed.test.length, parsed.reference.length] } : { n: parsed.testTrials + parsed.referenceTrials, outcome: "proportions", sizes: [parsed.testTrials, parsed.referenceTrials] },
      estimates: [
        { name: differenceLabel, estimate, standardError, df, distribution, direction: options.direction, margin },
        ...summaries,
        rendererContract(intervalRows, "non-inferiority-interval-table", "non-inferiority-interval-plot", "intervalRowsHash", H),
      ],
      tests: [
        { name: "non-inferiority", statistic: niStatistic, distribution, df, pValue: niP, alternative: niAlternative, margin: marginBoundary },
        { name: "superiority", statistic: superiorityStatistic, distribution, df, pValue: superiorityP, alternative: niAlternative },
      ],
      confidenceIntervals: [
        { parameter: differenceLabel, level: options.confidenceLevel, lower: higher ? oneSidedBound : null, upper: higher ? null : oneSidedBound, method: `one-sided ${distribution} bound` },
        { parameter: differenceLabel, level: 1 - 2 * alpha, lower: estimate - critical * standardError, upper: estimate + critical * standardError, method: `two-sided ${distribution} interval at 1 - 2 alpha` },
        { parameter: differenceLabel, level: options.confidenceLevel, lower: estimate - twoSidedCritical * standardError, upper: estimate + twoSidedCritical * standardError, method: `two-sided ${distribution} interval` },
      ],
      effectSizes,
      assumptions,
      diagnostics,
      artifacts: [
        H.tableArtifact("Non-inferiority and superiority tests", `${parsed.outcomeLabel}: ${options.direction}, margin ${margin}, one-sided alpha = ${alpha}.`, testColumns, testRows, ["Non-inferiority must be established before the superiority row is interpreted."], "non-inferiority-table"),
        H.tableArtifact("Non-inferiority interval", "Difference with its one-sided bound and the matching (1 - 2 alpha) two-sided interval.", intervalColumns, intervalRows, [], "non-inferiority-interval-table"),
        H.vegaArtifact("non-inferiority-interval-plot", `${parsed.outcomeLabel}: non-inferiority interval against the margin`, { data: { values: intervalRows }, ...intervalBandSpec(null, `Difference in ${parsed.outcomeLabel} (${differenceLabel})`, bandFields, ["lower", "upper"], "estimate", "reference") }),
      ],
    };
  },
  linkage: {
    neededWhen: "When a new treatment or process must be shown to be not unacceptably worse than an established reference by more than a prespecified margin.",
    decision: "Whether non-inferiority (and, secondarily, superiority) can be claimed at the stated margin and one-sided alpha.",
    mustShow: "The margin and its direction, the difference with its one-sided bound and (1 - 2 alpha) interval, both one-sided tests, and the approximation or normality diagnostics.",
    userGoal: "Support a non-inferiority claim that is anchored to a justified margin rather than to a non-significant two-sided test.",
    nextActions: [
      { trigger: "bound-crosses-margin", action: "report-not-established-and-revisit-precision", reason: "Failing to establish non-inferiority is usually a sample-size problem; it is not evidence of inferiority." },
      { trigger: "small-proportion-counts", action: "use-exact-or-score-interval-before-claiming", reason: "The Wald bound is unreliable when any cell count is below five." },
      { trigger: "non-inferior-and-superior", action: "report-hierarchically", reason: "Superiority is only interpretable after non-inferiority is secured." },
    ],
  },
  fixture: {
    data: {
      testValues: [72.1, 68.4, 75.3, 70.8, 69.9, 73.6, 71.2, 74.0, 67.8, 72.9, 70.1, 73.3],
      referenceValues: [73.0, 70.2, 74.8, 71.9, 69.5, 75.1, 72.4, 73.7, 70.6, 74.2, 71.0, 72.8],
      testLabel: "new regimen",
      referenceLabel: "standard regimen",
      outcomeLabel: "response score",
    },
    options: { confidenceLevel: 0.95, margin: 3, direction: "higher-is-better", varianceAssumption: "welch" },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.location", "matlab.stats.probability-hypothesis"] },
  coverage: {
    implementedBoundary: "One-sided non-inferiority and superiority tests for two independent means (Welch or pooled t) or two independent proportions (unpooled Wald z) with a raw-scale margin in either direction.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["mean difference, df, non-inferiority t and p (statsmodels ttest_ind with value=-margin)", "one-sided and (1 - 2 alpha) t bounds (scipy.stats.t)", "risk difference, Wald z and p (statsmodels test_proportions_2indep, numpy)", "Wald interval (statsmodels confint_proportions_2indep)"], excludedOutputs: ["diagnostics", "relative risk"] },
    diagnostic: { level: "method-specific-partial", emitted: ["Jarque-Bera normality", "Brown-Forsythe variance homogeneity", "normal approximation boundary", "non-inferiority decision", "superiority"], limitations: ["no score or exact interval for proportions", "no Farrington-Manning restricted-MLE test"] },
    knownGaps: ["ratio-scale margins", "Farrington-Manning and Miettinen-Nurminen methods", "stratified or adjusted non-inferiority"],
  },
};

// ---------------------------------------------------------------------------------
// Bland-Altman agreement
// ---------------------------------------------------------------------------------

const blandAltmanAgreement = {
  method: "bland_altman_agreement",
  family: "equivalence",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    limitCoverage: {
      schema: { type: "number", exclusiveMinimum: 0.5, exclusiveMaximum: 1, description: "Coverage of the limits of agreement (default 0.95 gives the classic 1.96 SD limits)." },
      default: 0.95,
      parse(value, H, path) {
        const coverage = H.finiteNumber(value, path);
        if (!(coverage > 0.5 && coverage < 1)) H.fail("STAT_INVALID_INPUT", `${path} must lie strictly between 0.5 and 1`);
        return coverage;
      },
    },
    acceptableDifference: {
      schema: { type: ["number", "null"], exclusiveMinimum: 0, description: "Clinically acceptable absolute difference; when given, the limits are judged against +/- this value." },
      default: null,
      parse(value, H, path) {
        if (value === null) return null;
        const limit = H.finiteNumber(value, path);
        if (!(limit > 0)) H.fail("STAT_INVALID_INPUT", `${path} must be strictly positive`);
        return limit;
      },
    },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["x", "y"],
    properties: { x: VECTOR_SCHEMA(4), y: VECTOR_SCHEMA(4), xLabel: LABEL_SCHEMA, yLabel: LABEL_SCHEMA, outcomeLabel: LABEL_SCHEMA },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["x", "y", "xLabel", "yLabel", "outcomeLabel"], "data");
    const x = H.numericVector(data.x, "data.x", 4);
    const y = H.numericVector(data.y, "data.y", 4);
    if (x.length !== y.length) H.fail("STAT_INVALID_INPUT", "data.x and data.y must be paired measurements of equal length");
    if (x.length > 10000) H.fail("STAT_LIMIT_EXCEEDED", "bland_altman_agreement is bounded to 10000 pairs");
    return { x, y, xLabel: H.label(data.xLabel, "Method A", "data.xLabel"), yLabel: H.label(data.yLabel, "Method B", "data.yLabel"), outcomeLabel: H.label(data.outcomeLabel, "Measurement", "data.outcomeLabel") };
  },
  analyze(parsed, options, budget, H) {
    const { x, y } = parsed;
    const n = x.length;
    const differences = x.map((value, index) => value - y[index]);
    const means = x.map((value, index) => (value + y[index]) / 2);
    const bias = H.mean(differences, budget);
    const variance = H.variance(differences, true, budget);
    if (!(variance > 0)) H.fail("STAT_DEGENERATE", "paired differences have zero variance; limits of agreement are undefined");
    const sd = Math.sqrt(variance);
    const z = createSupport(H).qnorm(1 - (1 - options.limitCoverage) / 2);
    const lowerLimit = bias - z * sd;
    const upperLimit = bias + z * sd;
    const tCrit = H.tCritical(options.confidenceLevel, n - 1);
    const biasSe = sd / Math.sqrt(n);
    // Bland & Altman (1999): Var(LoA) = (1/n + z^2 / (2 (n - 1))) s^2.
    const limitSe = sd * Math.sqrt(1 / n + z * z / (2 * (n - 1)));
    const biasT = bias / biasSe;
    const biasP = H.pFromT(biasT, n - 1, "two-sided");
    // Proportional bias: OLS of difference on pair mean.
    const meanSpread = H.variance(means, true, budget);
    if (!(meanSpread > 0)) H.fail("STAT_DEGENERATE", "pair means are constant; proportional bias regression is undefined");
    const ols = H.olsCore(differences, means.map((value) => [1, value]), budget);
    const residualDf = n - 2;
    const rss = ols.residuals.reduce((acc, value) => acc + value * value, 0);
    const mse = rss / residualDf;
    const slope = ols.beta[1];
    const intercept = ols.beta[0];
    const slopeSe = Math.sqrt(mse * ols.inverse[1][1]);
    const interceptSe = Math.sqrt(mse * ols.inverse[0][0]);
    const slopeT = slope / slopeSe;
    const slopeP = residualDf > 0 ? H.pFromT(slopeT, residualDf, "two-sided") : null;
    const slopeCrit = residualDf > 0 ? H.tCritical(options.confidenceLevel, residualDf) : null;
    const correlation = H.correlation(differences, means, budget);
    const pairRows = x.map((value, index) => {
      budget.check();
      const inside = differences[index] >= lowerLimit && differences[index] <= upperLimit;
      return { pair: index + 1, x: value, y: y[index], mean: means[index], difference: differences[index], withinLimits: inside, bias, lowerLimit, upperLimit };
    });
    const withinCount = pairRows.filter((row) => row.withinLimits).length;
    const summaryRows = [
      { quantity: "bias (mean difference)", estimate: bias, standardError: biasSe, lower: bias - tCrit * biasSe, upper: bias + tCrit * biasSe },
      { quantity: "lower limit of agreement", estimate: lowerLimit, standardError: limitSe, lower: lowerLimit - tCrit * limitSe, upper: lowerLimit + tCrit * limitSe },
      { quantity: "upper limit of agreement", estimate: upperLimit, standardError: limitSe, lower: upperLimit - tCrit * limitSe, upper: upperLimit + tCrit * limitSe },
    ];
    const regressionRows = [
      { term: "intercept", estimate: intercept, standardError: interceptSe, statistic: intercept / interceptSe, df: residualDf, pValue: residualDf > 0 ? H.pFromT(intercept / interceptSe, residualDf, "two-sided") : null },
      { term: "slope on pair mean", estimate: slope, standardError: slopeSe, statistic: slopeT, df: residualDf, pValue: slopeP },
    ];
    const pairColumns = [
      { key: "pair", label: "Pair", type: "number" },
      { key: "x", label: parsed.xLabel, type: "number" },
      { key: "y", label: parsed.yLabel, type: "number" },
      { key: "mean", label: "Pair mean", type: "number" },
      { key: "difference", label: `${parsed.xLabel} - ${parsed.yLabel}`, type: "number" },
      { key: "withinLimits", label: "Within limits", type: "boolean" },
      { key: "bias", label: "Bias", type: "number" },
      { key: "lowerLimit", label: "Lower limit", type: "number" },
      { key: "upperLimit", label: "Upper limit", type: "number" },
    ];
    const summaryColumns = [
      { key: "quantity", label: "Quantity", type: "string" },
      { key: "estimate", label: "Estimate", type: "number" },
      { key: "standardError", label: "SE", type: "number" },
      { key: "lower", label: `${Math.round(options.confidenceLevel * 100)}% CI lower`, type: "number" },
      { key: "upper", label: `${Math.round(options.confidenceLevel * 100)}% CI upper`, type: "number" },
    ];
    const regressionColumns = [
      { key: "term", label: "Term", type: "string" },
      { key: "estimate", label: "Estimate", type: "number" },
      { key: "standardError", label: "SE", type: "number" },
      { key: "statistic", label: "t", type: "number" },
      { key: "df", label: "df", type: "number" },
      { key: "pValue", label: "p", type: "number" },
    ];
    const acceptable = options.acceptableDifference;
    const agreementStatus = acceptable === null
      ? "no_acceptable_difference_supplied"
      : (summaryRows[1].lower > -acceptable && summaryRows[2].upper < acceptable) ? "limits_within_acceptable_difference"
        : (lowerLimit > -acceptable && upperLimit < acceptable) ? "point_limits_within_but_interval_not" : "limits_exceed_acceptable_difference";
    const differenceLabel = `${parsed.xLabel} - ${parsed.yLabel}`;
    const plotSpec = {
      width: 480,
      height: 320,
      layer: [
        { mark: { type: "rule", color: "#e63946", strokeWidth: 2 }, encoding: { y: { field: "bias", type: "quantitative", aggregate: "mean" } } },
        { mark: { type: "rule", color: "#457b9d", strokeDash: [6, 4] }, encoding: { y: { field: "lowerLimit", type: "quantitative", aggregate: "mean" } } },
        { mark: { type: "rule", color: "#457b9d", strokeDash: [6, 4] }, encoding: { y: { field: "upperLimit", type: "quantitative", aggregate: "mean" } } },
        { mark: { type: "point", filled: true, size: 70, opacity: 0.85 }, encoding: {
          x: { field: "mean", type: "quantitative", title: `Mean of ${parsed.xLabel} and ${parsed.yLabel}`, scale: { zero: false } },
          y: { field: "difference", type: "quantitative", title: `Difference (${differenceLabel})` },
          color: { field: "withinLimits", type: "nominal", title: "Within limits", scale: { domain: [true, false], range: ["#1d3557", "#e76f51"] } },
          tooltip: [{ field: "pair", type: "quantitative" }, { field: "mean", type: "quantitative" }, { field: "difference", type: "quantitative" }],
        } },
      ],
    };
    return {
      sample: { n, pairs: n, withinLimits: withinCount },
      estimates: [
        { name: "bias", estimate: bias, standardError: biasSe, df: n - 1 },
        { name: "SD of differences", estimate: sd },
        { name: "lower limit of agreement", estimate: lowerLimit, standardError: limitSe, coverage: options.limitCoverage, multiplier: z },
        { name: "upper limit of agreement", estimate: upperLimit, standardError: limitSe, coverage: options.limitCoverage, multiplier: z },
        { name: "proportional bias slope", estimate: slope, standardError: slopeSe, df: residualDf, intercept },
        { name: "difference-mean correlation", estimate: correlation },
        rendererContract(pairRows, "bland-altman-pairs-table", "bland-altman-plot", "pairRowsHash", H),
      ],
      tests: [
        { name: "bias differs from zero (paired t)", statistic: biasT, distribution: "t", df: n - 1, pValue: biasP },
        { name: "proportional bias (slope of difference on mean)", statistic: slopeT, distribution: "t", df: residualDf, pValue: slopeP },
      ],
      confidenceIntervals: [
        { parameter: "bias", level: options.confidenceLevel, lower: summaryRows[0].lower, upper: summaryRows[0].upper, method: "t interval, SD/sqrt(n)" },
        { parameter: "lower limit of agreement", level: options.confidenceLevel, lower: summaryRows[1].lower, upper: summaryRows[1].upper, method: "t interval, Bland-Altman (1999) SE" },
        { parameter: "upper limit of agreement", level: options.confidenceLevel, lower: summaryRows[2].lower, upper: summaryRows[2].upper, method: "t interval, Bland-Altman (1999) SE" },
        { parameter: "proportional bias slope", level: options.confidenceLevel, lower: slopeCrit === null ? null : slope - slopeCrit * slopeSe, upper: slopeCrit === null ? null : slope + slopeCrit * slopeSe, method: "OLS t interval" },
      ],
      effectSizes: [
        { name: "limits width", estimate: upperLimit - lowerLimit, unit: parsed.outcomeLabel },
        { name: "bias in SD units", estimate: bias / sd },
      ],
      assumptions: [
        { name: "differences approximately normal", status: "diagnostic_attached" },
        { name: "constant bias across the measurement range", status: "diagnostic_attached" },
        { name: "independent pairs (one pair per subject)", status: "requires_design_review" },
      ],
      diagnostics: [
        normality(`${differenceLabel} differences`, differences, H, budget),
        { name: "proportional bias", status: slopeP === null ? "not_evaluated" : slopeP < 1 - options.confidenceLevel ? "detected" : "not_detected", slope, pValue: slopeP, correlation, note: "A non-zero slope means the bias changes with the magnitude; consider regression-based limits or a log transform." },
        { name: "empirical coverage", status: "evaluated", withinLimits: withinCount, expectedCoverage: options.limitCoverage, observedCoverage: withinCount / n },
        { name: "acceptable difference", status: agreementStatus, acceptableDifference: acceptable },
        { name: "limit interval boundary", status: "t_based_approximate", note: "Limit SE uses the Bland-Altman (1999) large-sample approximation s * sqrt(1/n + z^2 / (2(n - 1)))." },
      ],
      artifacts: [
        H.tableArtifact("Bland-Altman summary", `Bias and ${Math.round(options.limitCoverage * 100)}% limits of agreement for ${differenceLabel} with ${Math.round(options.confidenceLevel * 100)}% confidence intervals.`, summaryColumns, summaryRows, [`Limits are bias +/- ${z.toFixed(4)} SD.`], "bland-altman-summary-table"),
        H.tableArtifact("Proportional bias regression", "Ordinary least squares of the paired difference on the pair mean.", regressionColumns, regressionRows, [], "bland-altman-regression-table"),
        H.tableArtifact("Bland-Altman pairs", "Every pair with its mean, difference and limit membership; these rows are the plotted points.", pairColumns, pairRows, [], "bland-altman-pairs-table"),
        H.vegaArtifact("bland-altman-plot", `${parsed.outcomeLabel}: Bland-Altman plot (${differenceLabel})`, { data: { values: pairRows }, ...plotSpec }),
      ],
    };
  },
  linkage: {
    neededWhen: "When two measurement methods or raters are compared on the same subjects and the question is agreement, not correlation.",
    decision: "Whether the two methods can be used interchangeably given the bias, the limits of agreement and a clinically acceptable difference.",
    mustShow: "Bias with its interval, both limits of agreement with intervals, the proportional-bias regression, the empirical coverage, and the paired scatter of difference against mean.",
    userGoal: "Report agreement on the measurement scale with limits that can be judged against a prespecified acceptable difference.",
    nextActions: [
      { trigger: "proportional-bias-detected", action: "consider-log-scale-or-regression-based-limits", reason: "Constant limits misrepresent agreement when the difference grows with magnitude." },
      { trigger: "limits-exceed-acceptable-difference", action: "report-methods-not-interchangeable", reason: "Wide limits mean individual readings can disagree by clinically important amounts." },
      { trigger: "repeated-measurements-per-subject", action: "use-repeated-measures-agreement-variant", reason: "Standard limits assume one pair per subject." },
    ],
  },
  fixture: {
    data: {
      x: [128, 134, 141, 119, 152, 137, 145, 123, 131, 148, 126, 139, 156, 117, 133],
      y: [125, 136, 138, 121, 149, 140, 142, 120, 134, 145, 129, 136, 151, 119, 130],
      xLabel: "device",
      yLabel: "manual cuff",
      outcomeLabel: "systolic blood pressure (mmHg)",
    },
    options: { confidenceLevel: 0.95, limitCoverage: 0.95, acceptableDifference: 10 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.descriptive-visualization", "matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "Single-pair-per-subject Bland-Altman analysis: bias, normal-quantile limits of agreement, t intervals for bias and limits (Bland-Altman 1999 SE), paired t test for bias, OLS proportional-bias regression and empirical coverage.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["bias, SD, limits, limit SE and intervals (numpy + scipy.stats.norm/t)", "paired t statistic and p (scipy.stats.ttest_rel)", "proportional-bias slope, SE, t and p (statsmodels OLS)", "difference-mean correlation (scipy.stats.pearsonr)"], excludedOutputs: ["diagnostics", "acceptable-difference judgement"] },
    diagnostic: { level: "method-specific-partial", emitted: ["Jarque-Bera normality of differences", "proportional bias", "empirical coverage", "acceptable difference", "limit interval boundary"], limitations: ["no repeated-measures or heteroscedastic limits", "no percentage-difference scale"] },
    knownGaps: ["repeated measurements per subject", "regression-based (V-shaped) limits", "log or percentage difference scales"],
  },
};

module.exports = { methods: [tostEquivalence, nonInferiorityTest, blandAltmanAgreement] };
