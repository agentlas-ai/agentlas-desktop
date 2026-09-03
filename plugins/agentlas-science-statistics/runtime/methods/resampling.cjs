"use strict";

/**
 * Resampling family: bootstrap confidence intervals (percentile / basic / BCa / studentized) over a
 * fixed statistic catalogue, permutation tests (exact enumeration for small designs, otherwise
 * Monte Carlo with a reported Monte Carlo standard error), delete-one jackknife, and K-fold
 * cross-validation of an OLS regression.
 *
 * All randomness comes from ./resampling-prng.cjs (xoshiro128**, SplitMix32 seeded), which the
 * Python oracle reproduces byte-for-byte, so every resample stream is deterministic in `seed`.
 */

const PRNG = require("./resampling-prng.cjs");
const SPD = require("./shared-precision-distributions.cjs");

const MAX_RESAMPLES = 20000;
const MAX_PERMUTATIONS = 100000;
const MAX_INNER_RESAMPLES = 200;
const MAX_RESAMPLE_VALUES = 5000;
const EXACT_COMBINATION_LIMIT = 200000;
const EXACT_SIGN_FLIP_EXPONENT = 17;
const EXACT_PAIRING_LIMIT = 9;
const HISTOGRAM_BINS = 30;

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

function integerOption(min, max, fallback) {
  return {
    schema: { type: "integer", minimum: min, maximum: max },
    default: fallback,
    parse(value, H, path) {
      return H.integer(value, min, max, path);
    },
  };
}

function booleanOption(fallback) {
  return {
    schema: { type: "boolean" },
    default: fallback,
    parse(value, H, path) {
      if (typeof value !== "boolean") H.fail("STAT_INVALID_INPUT", `${path} must be boolean`);
      return value;
    },
  };
}

const trimProportionOption = {
  schema: { type: "number", minimum: 0, maximum: 0.45 },
  default: 0.1,
  parse(value, H, path) {
    const number = H.finiteNumber(value, path);
    if (number < 0 || number > 0.45) H.fail("STAT_INVALID_INPUT", `${path} must be in [0, 0.45]`);
    return number;
  },
};

// ---------------------------------------------------------------------------------------------
// statistic catalogue
// ---------------------------------------------------------------------------------------------

function meanOf(values) {
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

function sampleVariance(values) {
  const center = meanOf(values);
  let ss = 0;
  for (const value of values) ss += (value - center) ** 2;
  return ss / (values.length - 1);
}

function medianOf(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const n = ordered.length;
  return n % 2 === 1 ? ordered[(n - 1) / 2] : 0.5 * (ordered[n / 2 - 1] + ordered[n / 2]);
}

function trimmedMeanOf(values, proportion) {
  const ordered = [...values].sort((a, b) => a - b);
  const cut = Math.floor(ordered.length * proportion);
  let total = 0;
  for (let i = cut; i < ordered.length - cut; i += 1) total += ordered[i];
  return total / (ordered.length - 2 * cut);
}

function pearsonOf(x, y) {
  const mx = meanOf(x);
  const my = meanOf(y);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < x.length; i += 1) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
}

/**
 * Catalogue entries: { arity: "one" | "two-independent" | "paired", compute(sample1, sample2, options) -> number | null }
 * `null` marks a degenerate replicate (e.g. zero-variance correlation); callers fail closed.
 */
const STATISTICS = Object.freeze({
  mean: { arity: "one", label: "mean", compute: (a) => meanOf(a) },
  median: { arity: "one", label: "median", compute: (a) => medianOf(a) },
  trimmedMean: { arity: "one", label: "trimmed mean", compute: (a, _b, o) => trimmedMeanOf(a, o.trimProportion) },
  standardDeviation: { arity: "one", label: "standard deviation (n - 1)", compute: (a) => Math.sqrt(sampleVariance(a)) },
  variance: { arity: "one", label: "variance (n - 1)", compute: (a) => sampleVariance(a) },
  meanDifference: { arity: "two-independent", label: "difference of means (first - second)", compute: (a, b) => meanOf(a) - meanOf(b) },
  medianDifference: { arity: "two-independent", label: "difference of medians (first - second)", compute: (a, b) => medianOf(a) - medianOf(b) },
  ratioOfMeans: { arity: "two-independent", label: "ratio of means (first / second)", compute: (a, b) => { const d = meanOf(b); return d === 0 ? null : meanOf(a) / d; } },
  correlation: { arity: "paired", label: "Pearson correlation", compute: (a, b) => pearsonOf(a, b) },
});

const STATISTIC_IDS = Object.freeze(Object.keys(STATISTICS));

function parseTwoVectorData(H, data, statistic, minLength) {
  H.assertKeys(data, ["values", "values2", "label", "label2"], "data");
  const spec = STATISTICS[statistic];
  const values = H.numericVector(data.values, "data.values", minLength);
  if (values.length > MAX_RESAMPLE_VALUES) H.fail("STAT_LIMIT_EXCEEDED", `data.values length must not exceed ${MAX_RESAMPLE_VALUES} for resampling`);
  let values2 = null;
  if (spec.arity === "one") {
    if (data.values2 !== undefined) H.fail("STAT_INVALID_INPUT", `data.values2 is not used by statistic ${statistic}`);
  } else {
    if (data.values2 === undefined) H.fail("STAT_INVALID_INPUT", `data.values2 is required for statistic ${statistic}`);
    values2 = H.numericVector(data.values2, "data.values2", minLength);
    if (values2.length > MAX_RESAMPLE_VALUES) H.fail("STAT_LIMIT_EXCEEDED", `data.values2 length must not exceed ${MAX_RESAMPLE_VALUES} for resampling`);
    if (spec.arity === "paired" && values2.length !== values.length) H.fail("STAT_INVALID_INPUT", "data.values and data.values2 must have equal length for a paired statistic");
  }
  return {
    values,
    values2,
    label: H.label(data.label, spec.arity === "one" ? "Sample" : "First sample", "data.label"),
    label2: H.label(data.label2, spec.arity === "paired" ? "Second variable" : "Second sample", "data.label2"),
  };
}

function evaluateStatistic(H, statistic, a, b, options, context) {
  const value = STATISTICS[statistic].compute(a, b, options);
  if (value === null || !Number.isFinite(value)) H.fail("STAT_DEGENERATE", `statistic ${statistic} is undefined ${context}`);
  return value;
}

function resampleWithReplacement(prng, source, out) {
  const n = source.length;
  for (let i = 0; i < n; i += 1) out[i] = source[prng.nextIndex(n)];
  return out;
}

/** One bootstrap replicate of the statistic following the arity of the catalogue entry. */
function bootstrapReplicate(H, prng, parsed, statistic, options, scratch) {
  const spec = STATISTICS[statistic];
  if (spec.arity === "one") {
    resampleWithReplacement(prng, parsed.values, scratch.a);
    return spec.compute(scratch.a, null, options);
  }
  if (spec.arity === "two-independent") {
    resampleWithReplacement(prng, parsed.values, scratch.a);
    resampleWithReplacement(prng, parsed.values2, scratch.b);
    return spec.compute(scratch.a, scratch.b, options);
  }
  const n = parsed.values.length;
  for (let i = 0; i < n; i += 1) {
    const index = prng.nextIndex(n);
    scratch.a[i] = parsed.values[index];
    scratch.b[i] = parsed.values2[index];
  }
  return spec.compute(scratch.a, scratch.b, options);
}

/** Delete-one jackknife replicates over every observation (both samples pooled for independent designs). */
function jackknifeReplicates(H, parsed, statistic, options, budget) {
  const spec = STATISTICS[statistic];
  const out = [];
  const leaveOut = (source, index) => {
    const copy = new Array(source.length - 1);
    let k = 0;
    for (let i = 0; i < source.length; i += 1) if (i !== index) copy[k++] = source[i];
    return copy;
  };
  if (spec.arity === "one") {
    for (let i = 0; i < parsed.values.length; i += 1) {
      budget.check(parsed.values.length);
      out.push({ sample: 1, index: i, value: spec.compute(leaveOut(parsed.values, i), null, options) });
    }
  } else if (spec.arity === "two-independent") {
    for (let i = 0; i < parsed.values.length; i += 1) {
      budget.check(parsed.values.length);
      out.push({ sample: 1, index: i, value: spec.compute(leaveOut(parsed.values, i), parsed.values2, options) });
    }
    for (let i = 0; i < parsed.values2.length; i += 1) {
      budget.check(parsed.values2.length);
      out.push({ sample: 2, index: i, value: spec.compute(parsed.values, leaveOut(parsed.values2, i), options) });
    }
  } else {
    for (let i = 0; i < parsed.values.length; i += 1) {
      budget.check(parsed.values.length);
      out.push({ sample: 1, index: i, value: spec.compute(leaveOut(parsed.values, i), leaveOut(parsed.values2, i), options) });
    }
  }
  for (const item of out) {
    if (item.value === null || !Number.isFinite(item.value)) H.fail("STAT_DEGENERATE", `statistic ${statistic} is undefined in a delete-one replicate`);
  }
  return out;
}

function histogramRows(values, bins, extra = {}) {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (min === max) return [{ binStart: min, binEnd: max, count: values.length, ...extra }];
  const width = (max - min) / bins;
  const counts = Array(bins).fill(0);
  for (const value of values) counts[Math.min(bins - 1, Math.floor((value - min) / width))] += 1;
  return counts.map((count, index) => ({ binStart: min + index * width, binEnd: min + (index + 1) * width, count, ...extra }));
}

function histogramFigure(H, role, title, rows, xTitle, rules) {
  const layers = [
    {
      mark: { type: "bar", color: "#4c78a8", opacity: 0.85 },
      encoding: {
        x: { field: "binStart", type: "quantitative", title: xTitle, bin: { binned: true } },
        x2: { field: "binEnd" },
        y: { field: "count", type: "quantitative", title: "Resamples" },
        tooltip: [{ field: "binStart", title: "Bin start", format: ".4g" }, { field: "binEnd", title: "Bin end", format: ".4g" }, { field: "count", title: "Count" }],
      },
    },
  ];
  for (const rule of rules) {
    layers.push({ mark: { type: "rule", color: rule.color, strokeWidth: rule.width || 2, strokeDash: rule.dash || [1, 0] }, encoding: { x: { datum: rule.value, type: "quantitative" } } });
  }
  return H.vegaArtifact(role, title, { data: { values: rows }, width: 520, height: 300, layer: layers });
}

function resamplingLinkage(kind, decision) {
  return {
    neededWhen: `When the sampling distribution of a ${kind} cannot be trusted to a textbook formula because the sample is small, skewed, or the statistic has no closed-form standard error.`,
    decision,
    mustShow: "The observed statistic, the resampling scheme with its seed and replicate count, the interval or p value with its Monte Carlo uncertainty, and the resampling distribution so the reader can see its shape.",
    userGoal: "Report an inference that depends on the data at hand rather than on a distributional assumption the design cannot defend.",
    nextActions: [
      { trigger: "monte-carlo-error-material", action: "increase-resamples-and-rerun-with-the-same-seed-family", reason: "A Monte Carlo standard error comparable to the decision margin means the verdict could flip on a different seed." },
      { trigger: "resampling-distribution-multimodal-or-discrete", action: "inspect-statistic-choice-and-sample-support", reason: "Bootstrap intervals for medians or small samples inherit the granularity of the data and can be badly calibrated." },
      { trigger: "interval-methods-disagree", action: "report-the-bca-or-studentized-interval-and-the-disagreement", reason: "Percentile and basic intervals diverge under skew and bias; the disagreement itself is evidence about the sampling distribution." },
      { trigger: "inference-committed", action: "bind-seed-replicates-and-figure-to-report", reason: "Resampling results are only reproducible when the generator, seed and replicate count travel with the numbers." },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// bootstrap_confidence_interval
// ---------------------------------------------------------------------------------------------

const bootstrapConfidenceInterval = {
  method: "bootstrap_confidence_interval",
  family: "resampling",
  analysisModel: { families: ["lm", "nonparametric"], distributions: [null, "normal", "gaussian", "unknown"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    statistic: enumOption(STATISTIC_IDS, "mean", "bootstrap_confidence_interval"),
    intervalMethod: enumOption(["percentile", "basic", "bca", "studentized"], "bca", "bootstrap_confidence_interval"),
    resamples: integerOption(200, MAX_RESAMPLES, 2000),
    innerResamples: integerOption(20, MAX_INNER_RESAMPLES, 50),
    trimProportion: trimProportionOption,
    seed: PRNG.seedOption,
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["values"],
    properties: {
      values: { type: "array", minItems: 3, maxItems: MAX_RESAMPLE_VALUES, items: { type: "number" } },
      values2: { type: "array", minItems: 3, maxItems: MAX_RESAMPLE_VALUES, items: { type: "number" }, description: "second sample (independent) or paired second variable, depending on the statistic" },
      label: { type: "string", minLength: 1, maxLength: 128 },
      label2: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    const parsed = parseTwoVectorData(H, data, options.statistic, 3);
    if (options.statistic === "trimmedMean" && Math.floor(parsed.values.length * options.trimProportion) * 2 >= parsed.values.length) {
      H.fail("STAT_INVALID_INPUT", "trimProportion removes every observation");
    }
    return parsed;
  },
  analyze(parsed, options, budget, H) {
    const statistic = options.statistic;
    const spec = STATISTICS[statistic];
    const observed = evaluateStatistic(H, statistic, parsed.values, parsed.values2, options, "for the observed sample");
    const prng = PRNG.createPrng(options.seed);
    const B = options.resamples;
    const scratch = { a: new Array(parsed.values.length), b: parsed.values2 ? new Array(parsed.values2.length) : null };
    const replicates = new Array(B);
    const studentized = options.intervalMethod === "studentized";
    const innerB = options.innerResamples;
    const tStatistics = studentized ? new Array(B) : null;
    let degenerate = 0;
    for (let b = 0; b < B; b += 1) {
      budget.check(parsed.values.length + (parsed.values2 ? parsed.values2.length : 0));
      const value = bootstrapReplicate(H, prng, parsed, statistic, options, scratch);
      if (value === null || !Number.isFinite(value)) {
        degenerate += 1;
        H.fail("STAT_DEGENERATE", `statistic ${statistic} is undefined in bootstrap replicate ${b + 1}`);
      }
      replicates[b] = value;
      if (studentized) {
        // inner bootstrap of the replicate sample to estimate its standard error
        const inner = { values: scratch.a.slice(), values2: scratch.b ? scratch.b.slice() : null };
        const innerScratch = { a: new Array(inner.values.length), b: inner.values2 ? new Array(inner.values2.length) : null };
        let sum = 0;
        let sumSq = 0;
        for (let k = 0; k < innerB; k += 1) {
          budget.check(inner.values.length);
          const innerValue = bootstrapReplicate(H, prng, inner, statistic, options, innerScratch);
          if (innerValue === null || !Number.isFinite(innerValue)) H.fail("STAT_DEGENERATE", `statistic ${statistic} is undefined in an inner bootstrap replicate`);
          sum += innerValue;
          sumSq += innerValue * innerValue;
        }
        const innerVariance = (sumSq - sum * sum / innerB) / (innerB - 1);
        if (!(innerVariance > 0)) H.fail("STAT_DEGENERATE", "inner bootstrap standard error is zero; the studentized interval is undefined");
        tStatistics[b] = (value - observed) / Math.sqrt(innerVariance);
      }
    }
    const sortedReplicates = [...replicates].sort((a, b) => a - b);
    const bootMean = meanOf(replicates);
    const bootSe = Math.sqrt(sampleVariance(replicates));
    const bias = bootMean - observed;
    const alpha = 1 - options.confidenceLevel;
    let lower;
    let upper;
    let z0 = null;
    let acceleration = null;
    let alphaLower = alpha / 2;
    let alphaUpper = 1 - alpha / 2;
    let jackknifeCount = null;
    if (options.intervalMethod === "percentile") {
      lower = H.quantileR7(sortedReplicates, alpha / 2);
      upper = H.quantileR7(sortedReplicates, 1 - alpha / 2);
    } else if (options.intervalMethod === "basic") {
      lower = 2 * observed - H.quantileR7(sortedReplicates, 1 - alpha / 2);
      upper = 2 * observed - H.quantileR7(sortedReplicates, alpha / 2);
    } else if (options.intervalMethod === "bca") {
      let below = 0;
      let belowOrEqual = 0;
      for (const value of replicates) {
        if (value < observed) below += 1;
        if (value <= observed) belowOrEqual += 1;
      }
      const proportion = (below + belowOrEqual) / (2 * B);
      if (proportion <= 0 || proportion >= 1) H.fail("STAT_DEGENERATE", "every bootstrap replicate lies on one side of the observed statistic; the BCa bias correction is undefined");
      z0 = SPD.qnorm(proportion);
      const jack = jackknifeReplicates(H, parsed, statistic, options, budget);
      jackknifeCount = jack.length;
      const jackMean = meanOf(jack.map((item) => item.value));
      let num = 0;
      let den = 0;
      for (const item of jack) {
        const d = jackMean - item.value;
        num += d * d * d;
        den += d * d;
      }
      if (!(den > 0)) H.fail("STAT_DEGENERATE", "jackknife replicates are constant; the BCa acceleration is undefined");
      acceleration = num / (6 * den ** 1.5);
      const zLow = SPD.qnorm(alpha / 2);
      const zHigh = SPD.qnorm(1 - alpha / 2);
      const n1 = z0 + zLow;
      const n2 = z0 + zHigh;
      alphaLower = SPD.pnorm(z0 + n1 / (1 - acceleration * n1));
      alphaUpper = SPD.pnorm(z0 + n2 / (1 - acceleration * n2));
      lower = H.quantileR7(sortedReplicates, alphaLower);
      upper = H.quantileR7(sortedReplicates, alphaUpper);
    } else {
      const sortedT = [...tStatistics].sort((a, b) => a - b);
      const tLow = H.quantileR7(sortedT, alpha / 2);
      const tHigh = H.quantileR7(sortedT, 1 - alpha / 2);
      lower = observed - tHigh * bootSe;
      upper = observed - tLow * bootSe;
    }
    if (!(lower <= upper)) H.fail("STAT_DEGENERATE", "bootstrap interval bounds are not ordered");
    const summaryRows = [
      { quantity: "observed statistic", value: observed, note: spec.label },
      { quantity: "bootstrap mean", value: bootMean, note: `${B} replicates` },
      { quantity: "bootstrap bias", value: bias, note: "bootstrap mean - observed" },
      { quantity: "bootstrap standard error", value: bootSe, note: "SD of replicates (n - 1)" },
      { quantity: "lower bound", value: lower, note: `${options.intervalMethod} ${Math.round(options.confidenceLevel * 100)}%` },
      { quantity: "upper bound", value: upper, note: `${options.intervalMethod} ${Math.round(options.confidenceLevel * 100)}%` },
      ...(z0 === null ? [] : [{ quantity: "bias-correction z0", value: z0, note: "Phi^-1 of the replicate proportion below the observed value" }, { quantity: "acceleration", value: acceleration, note: `delete-one jackknife over ${jackknifeCount} observations` }]),
      { quantity: "adjusted lower percentile", value: alphaLower, note: options.intervalMethod === "bca" ? "BCa-adjusted" : "nominal" },
      { quantity: "adjusted upper percentile", value: alphaUpper, note: options.intervalMethod === "bca" ? "BCa-adjusted" : "nominal" },
    ];
    const summary = H.tableArtifact("Bootstrap confidence interval", `${options.intervalMethod} interval for the ${spec.label} from ${B} seeded resamples (seed ${options.seed}).`, [
      { key: "quantity", label: "Quantity", type: "string" },
      { key: "value", label: "Value", type: "number" },
      { key: "note", label: "Note", type: "string" },
    ], summaryRows, [`generator ${prng.generator}`], "bootstrap-summary-table");
    const histRows = histogramRows(replicates, HISTOGRAM_BINS);
    const histTable = H.tableArtifact("Bootstrap distribution", "Histogram of the bootstrap replicates.", [
      { key: "binStart", label: "Bin start", type: "number" },
      { key: "binEnd", label: "Bin end", type: "number" },
      { key: "count", label: "Replicates", type: "number" },
    ], histRows, [], "bootstrap-histogram-table");
    const figure = histogramFigure(H, "bootstrap-histogram", `Bootstrap distribution of the ${spec.label} with ${Math.round(options.confidenceLevel * 100)}% ${options.intervalMethod} limits`, histRows, spec.label, [
      { value: observed, color: "#d62728", width: 2 },
      { value: lower, color: "#333333", width: 2, dash: [6, 4] },
      { value: upper, color: "#333333", width: 2, dash: [6, 4] },
    ]);
    const percentileLower = H.quantileR7(sortedReplicates, alpha / 2);
    const percentileUpper = H.quantileR7(sortedReplicates, 1 - alpha / 2);
    const monteCarloSe = bootSe / Math.sqrt(B);
    return {
      sample: { n: parsed.values.length, n2: parsed.values2 ? parsed.values2.length : null, resamples: B, innerResamples: studentized ? innerB : null, seed: options.seed, generator: prng.generator, draws: prng.drawCount() },
      estimates: [
        { parameter: statistic, estimate: observed, role: "observed" },
        { parameter: "bootstrapMean", estimate: bootMean, role: "derived" },
        { parameter: "bootstrapBias", estimate: bias, role: "derived" },
        { parameter: "bootstrapStandardError", estimate: bootSe, role: "derived" },
        { parameter: "monteCarloSeOfMean", estimate: monteCarloSe, role: "derived" },
        ...(z0 === null ? [] : [{ parameter: "z0", estimate: z0, role: "derived" }, { parameter: "acceleration", estimate: acceleration, role: "derived" }]),
        { parameter: "alphaLower", estimate: alphaLower, role: "derived" },
        { parameter: "alphaUpper", estimate: alphaUpper, role: "derived" },
        { parameter: "percentileLower", estimate: percentileLower, role: "derived" },
        { parameter: "percentileUpper", estimate: percentileUpper, role: "derived" },
      ],
      tests: [],
      confidenceIntervals: [{ parameter: statistic, level: options.confidenceLevel, lower, upper, method: `bootstrap ${options.intervalMethod}` }],
      effectSizes: [],
      assumptions: [
        { name: "independent identically distributed observations", status: "requires_design_review", detail: spec.arity === "paired" ? "pairs are resampled jointly" : spec.arity === "two-independent" ? "each sample is resampled within itself" : "observations are resampled with replacement" },
        { name: "sample is representative of the population", status: "requires_design_review" },
        { name: "statistic is smooth in the data", status: statistic === "median" || statistic === "medianDifference" ? "not_established" : "asymptotic", detail: statistic === "median" || statistic === "medianDifference" ? "the median bootstrap is discrete and can be badly calibrated for small n" : "bootstrap consistency holds for smooth functionals" },
      ],
      diagnostics: [
        { name: "resampling scheme", status: "evaluated", generator: prng.generator, seed: options.seed, resamples: B, innerResamples: studentized ? innerB : null, degenerateReplicates: degenerate },
        { name: "monte carlo error", status: "approximate", detail: "SE of the bootstrap mean; quantile endpoints have larger Monte Carlo error than the centre", monteCarloSeOfMean: monteCarloSe },
        { name: "interval method", status: options.intervalMethod === "bca" ? "second_order_accurate" : options.intervalMethod === "studentized" ? "second_order_accurate" : "first_order_accurate", method: options.intervalMethod },
        { name: "bias", status: Math.abs(bias) > 0.25 * bootSe ? "material" : "small", detail: "bias relative to the bootstrap standard error", ratio: bootSe > 0 ? bias / bootSe : 0 },
      ],
      artifacts: [summary, histTable, figure],
    };
  },
  linkage: resamplingLinkage("sample statistic", "Whether the interval for the statistic excludes the null or decision-relevant value, and how wide the plausible range is once the sampling distribution is estimated from the data."),
  fixture: { data: { values: [12.1, 14.3, 9.8, 15.2, 11.7, 13.9, 10.4, 16.8, 12.6, 14.1, 11.2, 13.3, 9.5, 15.9, 12.9, 13.7, 10.9, 14.6, 12.2, 11.8], label: "Response time" }, options: { statistic: "mean", intervalMethod: "bca", resamples: 2000, seed: 20240901, confidenceLevel: 0.95 } },
  matlabParity: { taxonomyIds: ["matlab.stats.descriptive-visualization", "matlab.stats.hypothesis.location"] },
  coverage: {
    implementedBoundary: "Non-parametric bootstrap of nine catalogue statistics (one-sample, two independent samples, paired) with percentile, basic, BCa (jackknife acceleration) and studentized (inner bootstrap) intervals from a seeded xoshiro128** stream.",
    oracle: { level: "external-library-partial", evidence: ["contracts/resampling-scipy-crosscheck.py"], verifiedOutputs: ["replicate stream against a Python port of the seeded generator", "percentile, basic, BCa and studentized limits against numpy on the identical replicates", "BCa z0 and acceleration against scipy.stats.bootstrap conventions", "percentile interval against scipy.stats.bootstrap under an independent generator within a Monte Carlo tolerance"], excludedOutputs: ["bootstrap of regression coefficients", "block or wild bootstrap"] },
    diagnostic: { level: "method-specific-partial", emitted: ["generator, seed and replicate count", "Monte Carlo error of the bootstrap mean", "bias relative to the bootstrap standard error", "interval accuracy order"], limitations: ["does not diagnose dependence between observations", "median bootstrap calibration is not corrected"] },
    knownGaps: ["no bootstrap for regression or time-series statistics", "no double bootstrap calibration"],
  },
};

// ---------------------------------------------------------------------------------------------
// permutation_test
// ---------------------------------------------------------------------------------------------

const PERMUTATION_STATISTICS = Object.freeze({
  independent: ["meanDifference", "medianDifference", "welchT"],
  paired: ["meanDifference", "medianDifference"],
  correlation: ["pearson"],
});

function welchT(a, b) {
  const va = sampleVariance(a) / a.length;
  const vb = sampleVariance(b) / b.length;
  const se = Math.sqrt(va + vb);
  return se === 0 ? null : (meanOf(a) - meanOf(b)) / se;
}

function permutationStatistic(design, statistic) {
  if (design === "independent") {
    if (statistic === "meanDifference") return (a, b) => meanOf(a) - meanOf(b);
    if (statistic === "medianDifference") return (a, b) => medianOf(a) - medianOf(b);
    return welchT;
  }
  if (design === "paired") {
    if (statistic === "meanDifference") return (d) => meanOf(d);
    return (d) => medianOf(d);
  }
  return (x, y) => pearsonOf(x, y);
}

function logChooseLocal(n, k) {
  let value = 0;
  for (let i = 1; i <= k; i += 1) value += Math.log(n - k + i) - Math.log(i);
  return value;
}

function countCombinations(n, k) {
  return Math.round(Math.exp(logChooseLocal(n, k)));
}

const permutationTest = {
  method: "permutation_test",
  family: "resampling",
  analysisModel: { families: ["lm", "nonparametric"], distributions: [null, "normal", "gaussian", "unknown"], links: [null, "identity"] },
  optionKeys: ["alternative", "timeoutMs"],
  customOptions: {
    design: enumOption(["independent", "paired", "correlation"], "independent", "permutation_test"),
    statistic: enumOption(["meanDifference", "medianDifference", "welchT", "pearson"], "meanDifference", "permutation_test"),
    permutations: integerOption(99, MAX_PERMUTATIONS, 9999),
    enumeration: enumOption(["auto", "exact", "monte-carlo"], "auto", "permutation_test"),
    seed: PRNG.seedOption,
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      groups: { type: "array", minItems: 2, maxItems: 2, items: { type: "object", additionalProperties: false, required: ["values"], properties: { name: { type: "string", minLength: 1, maxLength: 128 }, values: { type: "array", minItems: 2, maxItems: MAX_RESAMPLE_VALUES, items: { type: "number" } } } }, description: "two independent groups (design = independent)" },
      x: { type: "array", minItems: 3, maxItems: MAX_RESAMPLE_VALUES, items: { type: "number" }, description: "first member of each pair (design = paired or correlation)" },
      y: { type: "array", minItems: 3, maxItems: MAX_RESAMPLE_VALUES, items: { type: "number" } },
      label: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["groups", "x", "y", "label"], "data");
    if (!PERMUTATION_STATISTICS[options.design].includes(options.statistic)) {
      H.fail("STAT_INVALID_INPUT", `statistic ${options.statistic} is not defined for design ${options.design} (allowed: ${PERMUTATION_STATISTICS[options.design].join(", ")})`);
    }
    const label = H.label(data.label, "Outcome", "data.label");
    if (options.design === "independent") {
      if (data.x !== undefined || data.y !== undefined) H.fail("STAT_INVALID_INPUT", "data.x/data.y are not used by the independent design; supply data.groups");
      if (data.groups === undefined) H.fail("STAT_INVALID_INPUT", "data.groups is required for the independent design");
      const groups = H.parseGroups({ groups: data.groups }, 2, 2);
      const total = groups[0].values.length + groups[1].values.length;
      if (total > MAX_RESAMPLE_VALUES) H.fail("STAT_LIMIT_EXCEEDED", `pooled sample must not exceed ${MAX_RESAMPLE_VALUES} observations`);
      return { design: "independent", groups, label };
    }
    if (data.groups !== undefined) H.fail("STAT_INVALID_INPUT", `data.groups is not used by the ${options.design} design; supply data.x and data.y`);
    if (data.x === undefined || data.y === undefined) H.fail("STAT_INVALID_INPUT", `data.x and data.y are required for the ${options.design} design`);
    const x = H.numericVector(data.x, "data.x", 3);
    const y = H.numericVector(data.y, "data.y", 3);
    if (x.length !== y.length) H.fail("STAT_INVALID_INPUT", "data.x and data.y must have equal length");
    if (x.length > MAX_RESAMPLE_VALUES) H.fail("STAT_LIMIT_EXCEEDED", `paired sample must not exceed ${MAX_RESAMPLE_VALUES} observations`);
    return { design: options.design, x, y, label };
  },
  analyze(parsed, options, budget, H) {
    const compute = permutationStatistic(parsed.design, options.statistic);
    let observed;
    let exactCount;
    let exactKind;
    let pooled = null;
    let n1 = 0;
    let differences = null;
    if (parsed.design === "independent") {
      observed = compute(parsed.groups[0].values, parsed.groups[1].values);
      n1 = parsed.groups[0].values.length;
      pooled = [...parsed.groups[0].values, ...parsed.groups[1].values];
      exactCount = countCombinations(pooled.length, n1);
      exactKind = `C(${pooled.length}, ${n1}) group assignments`;
    } else if (parsed.design === "paired") {
      differences = parsed.x.map((value, index) => value - parsed.y[index]);
      observed = compute(differences);
      exactCount = parsed.x.length <= 40 ? 2 ** parsed.x.length : Infinity;
      exactKind = `2^${parsed.x.length} sign assignments`;
    } else {
      observed = compute(parsed.x, parsed.y);
      exactCount = parsed.x.length <= 20 ? Math.round(Math.exp(H.logGamma(parsed.x.length + 1))) : Infinity;
      exactKind = `${parsed.x.length}! pairings`;
    }
    if (observed === null || !Number.isFinite(observed)) H.fail("STAT_DEGENERATE", `observed ${options.statistic} is undefined (zero variance)`);
    const exactFeasible = parsed.design === "independent" ? exactCount <= EXACT_COMBINATION_LIMIT
      : parsed.design === "paired" ? parsed.x.length <= EXACT_SIGN_FLIP_EXPONENT
        : parsed.x.length <= EXACT_PAIRING_LIMIT;
    let exact;
    if (options.enumeration === "exact") {
      if (!exactFeasible) H.fail("STAT_LIMIT_EXCEEDED", `exact enumeration of ${exactKind} exceeds the deterministic limit; use enumeration=monte-carlo`);
      exact = true;
    } else if (options.enumeration === "monte-carlo") exact = false;
    else exact = exactFeasible;

    const gamma = 100 * Number.EPSILON * Math.abs(observed);
    let countLess = 0;
    let countGreater = 0;
    let total = 0;
    const nullValues = [];
    let degenerate = 0;
    const record = (value) => {
      if (value === null || !Number.isFinite(value)) { degenerate += 1; return; }
      total += 1;
      if (value <= observed + gamma) countLess += 1;
      if (value >= observed - gamma) countGreater += 1;
      nullValues.push(value);
    };
    let prng = null;
    if (exact) {
      if (parsed.design === "independent") {
        const n = pooled.length;
        const index = Array.from({ length: n1 }, (_, i) => i);
        const a = new Array(n1);
        const b = new Array(n - n1);
        for (;;) {
          budget.check(n);
          let ka = 0;
          let kb = 0;
          let pointer = 0;
          for (let i = 0; i < n; i += 1) {
            if (pointer < n1 && index[pointer] === i) { a[ka++] = pooled[i]; pointer += 1; } else b[kb++] = pooled[i];
          }
          record(compute(a, b));
          // next lexicographic combination
          let i = n1 - 1;
          while (i >= 0 && index[i] === n - n1 + i) i -= 1;
          if (i < 0) break;
          index[i] += 1;
          for (let j = i + 1; j < n1; j += 1) index[j] = index[j - 1] + 1;
        }
      } else if (parsed.design === "paired") {
        const n = differences.length;
        const signed = new Array(n);
        const limit = 2 ** n;
        for (let mask = 0; mask < limit; mask += 1) {
          budget.check(n);
          for (let i = 0; i < n; i += 1) signed[i] = (mask >> i) & 1 ? -differences[i] : differences[i];
          record(compute(signed));
        }
      } else {
        // Heap's algorithm over y
        const n = parsed.x.length;
        const y = [...parsed.y];
        const c = Array(n).fill(0);
        record(compute(parsed.x, y));
        let i = 0;
        while (i < n) {
          budget.check(n);
          if (c[i] < i) {
            if (i % 2 === 0) { const t = y[0]; y[0] = y[i]; y[i] = t; } else { const t = y[c[i]]; y[c[i]] = y[i]; y[i] = t; }
            record(compute(parsed.x, y));
            c[i] += 1;
            i = 0;
          } else {
            c[i] = 0;
            i += 1;
          }
        }
      }
    } else {
      prng = PRNG.createPrng(options.seed);
      const B = options.permutations;
      if (parsed.design === "independent") {
        const work = [...pooled];
        for (let b = 0; b < B; b += 1) {
          budget.check(work.length);
          prng.shuffle(work);
          record(compute(work.slice(0, n1), work.slice(n1)));
        }
      } else if (parsed.design === "paired") {
        const signed = new Array(differences.length);
        for (let b = 0; b < B; b += 1) {
          budget.check(signed.length);
          for (let i = 0; i < signed.length; i += 1) signed[i] = prng.nextDouble() < 0.5 ? -differences[i] : differences[i];
          record(compute(signed));
        }
      } else {
        const y = [...parsed.y];
        for (let b = 0; b < B; b += 1) {
          budget.check(y.length);
          prng.shuffle(y);
          record(compute(parsed.x, y));
        }
      }
    }
    if (total === 0) H.fail("STAT_DEGENERATE", "every permutation produced an undefined statistic");
    const adjustment = exact ? 0 : 1;
    const pLess = (countLess + adjustment) / (total + adjustment);
    const pGreater = (countGreater + adjustment) / (total + adjustment);
    let pValue;
    if (options.alternative === "less") pValue = pLess;
    else if (options.alternative === "greater") pValue = pGreater;
    else pValue = Math.min(1, 2 * Math.min(pLess, pGreater));
    const monteCarloSe = exact ? 0 : Math.sqrt(pValue * (1 - pValue) / total);
    const nullMean = meanOf(nullValues);
    const nullSd = nullValues.length > 1 ? Math.sqrt(sampleVariance(nullValues)) : 0;
    const summaryRows = [
      { quantity: "observed statistic", value: observed, note: `${options.statistic} (${parsed.design})` },
      { quantity: "permutations evaluated", value: total, note: exact ? `exact: ${exactKind}` : `Monte Carlo with seed ${options.seed}` },
      { quantity: "p value (less)", value: pLess, note: exact ? "count / total" : "(count + 1) / (B + 1)" },
      { quantity: "p value (greater)", value: pGreater, note: exact ? "count / total" : "(count + 1) / (B + 1)" },
      { quantity: `p value (${options.alternative})`, value: pValue, note: options.alternative === "two-sided" ? "2 x min(less, greater), capped at 1" : "one-sided" },
      { quantity: "Monte Carlo SE of p", value: monteCarloSe, note: exact ? "exact enumeration" : "binomial approximation" },
      { quantity: "null distribution mean", value: nullMean, note: "" },
      { quantity: "null distribution SD", value: nullSd, note: "" },
    ];
    const summary = H.tableArtifact("Permutation test", `${exact ? "Exact" : "Monte Carlo"} permutation test of the ${options.statistic} under the ${parsed.design} design.`, [
      { key: "quantity", label: "Quantity", type: "string" },
      { key: "value", label: "Value", type: "number" },
      { key: "note", label: "Note", type: "string" },
    ], summaryRows, [], "permutation-summary-table");
    const histRows = histogramRows(nullValues, HISTOGRAM_BINS);
    const histTable = H.tableArtifact("Permutation null distribution", "Histogram of the statistic under the permutation null.", [
      { key: "binStart", label: "Bin start", type: "number" },
      { key: "binEnd", label: "Bin end", type: "number" },
      { key: "count", label: "Permutations", type: "number" },
    ], histRows, [], "permutation-histogram-table");
    const figure = histogramFigure(H, "permutation-histogram", `Permutation null distribution of the ${options.statistic} (observed value marked)`, histRows, options.statistic, [
      { value: observed, color: "#d62728", width: 2 },
    ]);
    return {
      sample: parsed.design === "independent"
        ? { design: parsed.design, n1, n2: pooled.length - n1, permutations: total, exact, seed: exact ? null : options.seed, generator: exact ? null : prng.generator }
        : { design: parsed.design, n: parsed.x.length, permutations: total, exact, seed: exact ? null : options.seed, generator: exact ? null : prng.generator },
      estimates: [
        { parameter: options.statistic, estimate: observed, role: "observed" },
        { parameter: "nullMean", estimate: nullMean, role: "derived" },
        { parameter: "nullSd", estimate: nullSd, role: "derived" },
        { parameter: "pLess", estimate: pLess, role: "derived" },
        { parameter: "pGreater", estimate: pGreater, role: "derived" },
        { parameter: "monteCarloSe", estimate: monteCarloSe, role: "derived" },
      ],
      tests: [{ name: `permutation test (${parsed.design}, ${options.statistic})`, statistic: observed, pValue, alternative: options.alternative, method: exact ? "exact enumeration" : "Monte Carlo", permutations: total, monteCarloSe, countLess, countGreater }],
      confidenceIntervals: [],
      effectSizes: [],
      assumptions: [
        { name: "exchangeability under the null", status: "requires_design_review", detail: parsed.design === "independent" ? "group labels are exchangeable when the null is true" : parsed.design === "paired" ? "within-pair signs are exchangeable under the null of symmetric differences" : "pairings are exchangeable under independence" },
        { name: "independent observations", status: "requires_design_review" },
        ...(options.statistic === "meanDifference" && parsed.design === "independent" ? [{ name: "equal variances (for the mean-difference null to test location only)", status: "not_established", detail: "under unequal variances the permutation null tests distributional equality, not the mean difference alone" }] : []),
      ],
      diagnostics: [
        { name: "enumeration", status: exact ? "exact" : "monte_carlo", detail: exactKind, feasibleExact: exactFeasible, permutations: total, degenerateStatistics: degenerate },
        { name: "monte carlo error", status: exact ? "not_applicable" : "approximate", monteCarloSe, detail: exact ? "complete enumeration has no Monte Carlo error" : "binomial SE sqrt(p(1-p)/B)" },
        { name: "p value convention", status: "evaluated", detail: exact ? "proportion of permutations at least as extreme (no +1 adjustment)" : "(count + 1)/(B + 1) including the observed arrangement", tolerance: gamma },
      ],
      artifacts: [summary, histTable, figure],
    };
  },
  linkage: resamplingLinkage("group comparison or association", "Whether the observed statistic is unusual under the exchangeability null, judged against the permutation distribution rather than a parametric reference."),
  fixture: { data: { groups: [{ name: "control", values: [23.1, 25.4, 22.8, 26.7, 24.3, 21.9, 25.8, 23.6, 24.9, 22.4] }, { name: "treatment", values: [27.2, 29.5, 26.1, 30.4, 28.3, 25.7, 29.9, 27.6, 28.8, 31.2] }], label: "Score" }, options: { design: "independent", statistic: "meanDifference", enumeration: "auto", seed: 20240901 } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.location"] },
  coverage: {
    implementedBoundary: "Exact permutation enumeration (group assignments, sign flips, or pairings within deterministic limits) or seeded Monte Carlo permutation p values for mean/median differences, Welch t, and Pearson correlation.",
    oracle: { level: "external-library-partial", evidence: ["contracts/resampling-scipy-crosscheck.py"], verifiedOutputs: ["exact p values against scipy.stats.permutation_test with n_resamples=inf for all three designs", "Monte Carlo p values against a Python port of the seeded permutation stream", "observed statistics against numpy"], excludedOutputs: ["stratified or blocked permutations", "multivariate statistics"] },
    diagnostic: { level: "method-specific-partial", emitted: ["exact versus Monte Carlo status with the enumeration size", "Monte Carlo standard error of the p value", "p value convention and floating tolerance"], limitations: ["does not test exchangeability itself", "unequal-variance mean-difference permutations are flagged but not corrected"] },
    knownGaps: ["no stratified permutation", "no permutation confidence intervals"],
  },
};

// ---------------------------------------------------------------------------------------------
// jackknife
// ---------------------------------------------------------------------------------------------

const jackknife = {
  method: "jackknife",
  family: "resampling",
  analysisModel: { families: ["lm", "nonparametric"], distributions: [null, "normal", "gaussian", "unknown"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    statistic: enumOption(STATISTIC_IDS, "mean", "jackknife"),
    trimProportion: trimProportionOption,
  },
  dataSchema: bootstrapConfidenceInterval.dataSchema,
  parse(data, options, H) {
    const parsed = parseTwoVectorData(H, data, options.statistic, 3);
    if (options.statistic === "trimmedMean" && Math.floor((parsed.values.length - 1) * options.trimProportion) * 2 >= parsed.values.length - 1) {
      H.fail("STAT_INVALID_INPUT", "trimProportion removes every observation in a delete-one replicate");
    }
    return parsed;
  },
  analyze(parsed, options, budget, H) {
    const statistic = options.statistic;
    const spec = STATISTICS[statistic];
    const observed = evaluateStatistic(H, statistic, parsed.values, parsed.values2, options, "for the observed sample");
    const replicates = jackknifeReplicates(H, parsed, statistic, options, budget);
    const n = replicates.length;
    const jackMean = meanOf(replicates.map((item) => item.value));
    const bias = (n - 1) * (jackMean - observed);
    let ss = 0;
    for (const item of replicates) ss += (item.value - jackMean) ** 2;
    const se = Math.sqrt((n - 1) / n * ss);
    const corrected = observed - bias;
    const z = SPD.qnorm(1 - (1 - options.confidenceLevel) / 2);
    const rows = replicates.map((item, position) => {
      const pseudo = n * observed - (n - 1) * item.value;
      return { position: position + 1, sample: item.sample, index: item.index + 1, leaveOneOut: item.value, pseudoValue: pseudo, influence: (n - 1) * (jackMean - item.value) };
    });
    const table = H.tableArtifact("Jackknife replicates", `Delete-one replicates of the ${spec.label} with pseudo-values and empirical influence values.`, [
      { key: "position", label: "Replicate", type: "number" },
      { key: "sample", label: "Sample", type: "number" },
      { key: "index", label: "Omitted observation", type: "number" },
      { key: "leaveOneOut", label: "Statistic without observation", type: "number" },
      { key: "pseudoValue", label: "Pseudo-value", type: "number" },
      { key: "influence", label: "Influence (n-1)(mean - replicate)", type: "number" },
    ], rows, [], "jackknife-replicates-table");
    const summaryRows = [
      { quantity: "observed statistic", value: observed, note: spec.label },
      { quantity: "jackknife mean", value: jackMean, note: `${n} delete-one replicates` },
      { quantity: "jackknife bias", value: bias, note: "(n - 1)(mean of replicates - observed)" },
      { quantity: "bias-corrected estimate", value: corrected, note: "observed - bias" },
      { quantity: "jackknife standard error", value: se, note: "sqrt((n-1)/n sum (replicate - mean)^2)" },
      { quantity: "lower bound", value: observed - z * se, note: `normal approximation ${Math.round(options.confidenceLevel * 100)}%` },
      { quantity: "upper bound", value: observed + z * se, note: `normal approximation ${Math.round(options.confidenceLevel * 100)}%` },
    ];
    const summary = H.tableArtifact("Jackknife summary", "Bias, standard error and normal-approximation interval from the delete-one jackknife.", [
      { key: "quantity", label: "Quantity", type: "string" },
      { key: "value", label: "Value", type: "number" },
      { key: "note", label: "Note", type: "string" },
    ], summaryRows, [], "jackknife-summary-table");
    const figure = H.vegaArtifact("jackknife-influence", `Empirical influence of each observation on the ${spec.label}`, {
      data: { values: rows },
      width: 520,
      height: 300,
      layer: [
        { mark: { type: "bar", color: "#4c78a8" }, encoding: { x: { field: "position", type: "ordinal", title: "Omitted observation (replicate order)" }, y: { field: "influence", type: "quantitative", title: "Influence value" }, color: { field: "sample", type: "nominal", title: "Sample", scale: { range: ["#4c78a8", "#f58518"] } }, tooltip: [{ field: "index", title: "Observation" }, { field: "sample", title: "Sample" }, { field: "leaveOneOut", title: "Statistic without it", format: ".4g" }, { field: "influence", title: "Influence", format: ".4g" }] } },
        { mark: { type: "rule", color: "#333333" }, encoding: { y: { datum: 0, type: "quantitative" } } },
      ],
    });
    const maxAbs = rows.reduce((acc, row) => Math.max(acc, Math.abs(row.influence)), 0);
    const dominant = rows.filter((row) => Math.abs(row.influence) === maxAbs);
    return {
      sample: { n: parsed.values.length, n2: parsed.values2 ? parsed.values2.length : null, replicates: n },
      estimates: [
        { parameter: statistic, estimate: observed, role: "observed" },
        { parameter: "jackknifeMean", estimate: jackMean, role: "derived" },
        { parameter: "jackknifeBias", estimate: bias, role: "derived" },
        { parameter: "biasCorrectedEstimate", estimate: corrected, role: "derived" },
        { parameter: "jackknifeStandardError", estimate: se, role: "derived" },
      ],
      tests: [],
      confidenceIntervals: [{ parameter: statistic, level: options.confidenceLevel, lower: observed - z * se, upper: observed + z * se, method: "jackknife SE with normal quantile" }],
      effectSizes: [],
      assumptions: [
        { name: "independent identically distributed observations", status: "requires_design_review" },
        { name: "statistic is smooth in the data", status: statistic === "median" || statistic === "medianDifference" ? "not_established" : "asymptotic", detail: statistic === "median" || statistic === "medianDifference" ? "the delete-one jackknife is inconsistent for the median" : "delete-one jackknife variance is consistent for smooth functionals" },
        { name: "normal approximation for the interval", status: "asymptotic" },
      ],
      diagnostics: [
        { name: "influence", status: "evaluated", maxAbsoluteInfluence: maxAbs, dominantObservations: dominant.map((row) => ({ sample: row.sample, index: row.index })), detail: "observations with the largest empirical influence on the statistic" },
        { name: "bias", status: se > 0 && Math.abs(bias) > 0.25 * se ? "material" : "small", ratio: se > 0 ? bias / se : 0 },
      ],
      artifacts: [summary, table, figure],
    };
  },
  linkage: resamplingLinkage("plug-in statistic", "Whether the statistic is materially biased or dominated by a few observations, and what standard error to attach without a parametric formula."),
  fixture: { data: { values: [12.1, 14.3, 9.8, 15.2, 11.7, 13.9, 10.4, 16.8, 12.6, 14.1, 11.2, 13.3], label: "Response time" }, options: { statistic: "standardDeviation", confidenceLevel: 0.95 } },
  matlabParity: { taxonomyIds: ["matlab.stats.descriptive-visualization"] },
  coverage: {
    implementedBoundary: "Delete-one jackknife bias, standard error, pseudo-values and empirical influence values for the nine catalogue statistics, with a normal-approximation interval.",
    oracle: { level: "external-library-partial", evidence: ["contracts/resampling-scipy-crosscheck.py"], verifiedOutputs: ["delete-one replicates, bias and standard error against numpy first principles", "pseudo-values"], excludedOutputs: ["delete-d jackknife", "jackknife for regression coefficients"] },
    diagnostic: { level: "method-specific-partial", emitted: ["dominant observations by empirical influence", "bias relative to the standard error"], limitations: ["does not flag jackknife inconsistency beyond the median statistics"] },
    knownGaps: ["no delete-d or grouped jackknife"],
  },
};

// ---------------------------------------------------------------------------------------------
// cross_validation_regression
// ---------------------------------------------------------------------------------------------

function olsFit(H, x, y, budget) {
  const n = x.length;
  const p = x[0].length;
  if (n <= p) H.fail("STAT_INSUFFICIENT_SAMPLE", `at least ${p + 1} training rows are required for ${p} coefficients`);
  const xtx = Array.from({ length: p }, () => Array(p).fill(0));
  const xty = Array(p).fill(0);
  for (let r = 0; r < n; r += 1) {
    budget.check(p * p);
    const row = x[r];
    for (let i = 0; i < p; i += 1) {
      xty[i] += row[i] * y[r];
      for (let j = i; j < p; j += 1) xtx[i][j] += row[i] * row[j];
    }
  }
  for (let i = 0; i < p; i += 1) for (let j = 0; j < i; j += 1) xtx[i][j] = xtx[j][i];
  if (H.matrixRank(xtx) < p) H.fail("STAT_RANK_DEFICIENT", "design matrix is rank deficient in a training fold");
  const inverse = H.invert(xtx);
  const beta = inverse.map((row) => row.reduce((acc, value, index) => acc + value * xty[index], 0));
  return { beta, inverse };
}

function predictRow(row, beta) {
  let value = 0;
  for (let i = 0; i < row.length; i += 1) value += row[i] * beta[i];
  return value;
}

const crossValidationRegression = {
  method: "cross_validation_regression",
  family: "resampling",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["intercept", "timeoutMs"],
  customOptions: {
    folds: integerOption(2, 50, 5),
    shuffle: booleanOption(true),
    repeats: integerOption(1, 20, 1),
    seed: PRNG.seedOption,
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["y", "predictors"],
    properties: {
      y: { type: "array", minItems: 8, maxItems: MAX_RESAMPLE_VALUES, items: { type: "number" } },
      predictors: { type: "array", minItems: 1, maxItems: 48, items: { type: "object", additionalProperties: false, required: ["name", "values"], properties: { name: { type: "string", minLength: 1, maxLength: 128 }, values: { type: "array", minItems: 8, maxItems: MAX_RESAMPLE_VALUES, items: { type: "number" } } } } },
      outcomeLabel: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["y", "predictors", "outcomeLabel"], "data");
    const y = H.numericVector(data.y, "data.y", 8);
    if (y.length > MAX_RESAMPLE_VALUES) H.fail("STAT_LIMIT_EXCEEDED", `data.y length must not exceed ${MAX_RESAMPLE_VALUES}`);
    if (!Array.isArray(data.predictors) || data.predictors.length < 1 || data.predictors.length > 48) H.fail("STAT_INVALID_INPUT", "data.predictors must hold between 1 and 48 predictors");
    const names = new Set();
    const predictors = data.predictors.map((raw, index) => {
      const item = H.assertObject(raw, `data.predictors[${index}]`);
      H.assertKeys(item, ["name", "values"], `data.predictors[${index}]`);
      const name = H.label(item.name, `x${index + 1}`, `data.predictors[${index}].name`);
      if (names.has(name)) H.fail("STAT_INVALID_INPUT", `duplicate predictor name: ${name}`);
      names.add(name);
      const values = H.numericVector(item.values, `data.predictors[${index}].values`, 8);
      if (values.length !== y.length) H.fail("STAT_INVALID_INPUT", `data.predictors[${index}].values must match data.y length`);
      return { name, values };
    });
    if (options.folds > y.length) H.fail("STAT_INVALID_INPUT", `folds (${options.folds}) cannot exceed the number of observations (${y.length})`);
    const p = predictors.length + (options.intercept ? 1 : 0);
    if (y.length - Math.ceil(y.length / options.folds) <= p) H.fail("STAT_INSUFFICIENT_SAMPLE", "every training fold must contain more rows than coefficients");
    if (!options.shuffle && options.repeats > 1) H.fail("STAT_INVALID_INPUT", "repeats > 1 requires shuffle=true; unshuffled folds are identical across repeats");
    return { y, predictors, outcomeLabel: H.label(data.outcomeLabel, "Outcome", "data.outcomeLabel") };
  },
  analyze(parsed, options, budget, H) {
    const n = parsed.y.length;
    const x = parsed.y.map((_, row) => [...(options.intercept ? [1] : []), ...parsed.predictors.map((predictor) => predictor.values[row])]);
    const p = x[0].length;
    const full = olsFit(H, x, parsed.y, budget);
    const fitted = x.map((row) => predictRow(row, full.beta));
    const residuals = parsed.y.map((value, i) => value - fitted[i]);
    const yMean = meanOf(parsed.y);
    let ssTot = 0;
    for (const value of parsed.y) ssTot += (value - yMean) ** 2;
    if (!(ssTot > 0)) H.fail("STAT_DEGENERATE", "outcome has zero variance");
    const ssRes = residuals.reduce((acc, value) => acc + value * value, 0);
    const inSampleRmse = Math.sqrt(ssRes / n);
    const inSampleMae = residuals.reduce((acc, value) => acc + Math.abs(value), 0) / n;
    const inSampleR2 = 1 - ssRes / ssTot;
    // leave-one-out via the hat matrix (PRESS)
    let press = 0;
    let looAbs = 0;
    let maxLeverage = 0;
    for (let i = 0; i < n; i += 1) {
      budget.check(p * p);
      const h = H.quadraticForm(x[i], full.inverse);
      if (h >= 1 - 1e-12) H.fail("STAT_DEGENERATE", `observation ${i + 1} has leverage 1; leave-one-out prediction is undefined`);
      maxLeverage = Math.max(maxLeverage, h);
      const e = residuals[i] / (1 - h);
      press += e * e;
      looAbs += Math.abs(e);
    }
    const looRmse = Math.sqrt(press / n);
    const looMae = looAbs / n;
    const looR2 = 1 - press / ssTot;

    const prng = PRNG.createPrng(options.seed);
    const K = options.folds;
    const foldRows = [];
    const predictionRows = [];
    const repeatSummaries = [];
    for (let repeat = 0; repeat < options.repeats; repeat += 1) {
      const order = Array.from({ length: n }, (_, i) => i);
      if (options.shuffle) prng.shuffle(order);
      const foldSizes = Array.from({ length: K }, (_, k) => Math.floor(n / K) + (k < n % K ? 1 : 0));
      const outOfFold = new Array(n);
      let start = 0;
      for (let k = 0; k < K; k += 1) {
        const testIndex = order.slice(start, start + foldSizes[k]);
        const testSet = new Set(testIndex);
        start += foldSizes[k];
        const trainX = [];
        const trainY = [];
        for (let i = 0; i < n; i += 1) if (!testSet.has(i)) { trainX.push(x[i]); trainY.push(parsed.y[i]); }
        const fit = olsFit(H, trainX, trainY, budget);
        let sq = 0;
        let abs = 0;
        let sst = 0;
        const testMean = meanOf(testIndex.map((i) => parsed.y[i]));
        for (const i of testIndex) {
          const prediction = predictRow(x[i], fit.beta);
          outOfFold[i] = prediction;
          const error = parsed.y[i] - prediction;
          sq += error * error;
          abs += Math.abs(error);
          sst += (parsed.y[i] - testMean) ** 2;
        }
        foldRows.push({ repeat: repeat + 1, fold: k + 1, testSize: testIndex.length, trainSize: n - testIndex.length, rmse: Math.sqrt(sq / testIndex.length), mae: abs / testIndex.length, r2: sst > 0 ? 1 - sq / sst : null });
      }
      let cvSq = 0;
      let cvAbs = 0;
      for (let i = 0; i < n; i += 1) {
        const error = parsed.y[i] - outOfFold[i];
        cvSq += error * error;
        cvAbs += Math.abs(error);
        if (repeat === 0) predictionRows.push({ observation: i + 1, observed: parsed.y[i], outOfFoldPrediction: outOfFold[i], inSampleFitted: fitted[i], fold: 0 });
      }
      repeatSummaries.push({ repeat: repeat + 1, rmse: Math.sqrt(cvSq / n), mae: cvAbs / n, r2: 1 - cvSq / ssTot });
    }
    // assign fold ids to the prediction rows of the first repeat
    {
      const order = Array.from({ length: n }, (_, i) => i);
      const replay = PRNG.createPrng(options.seed);
      if (options.shuffle) replay.shuffle(order);
      const foldSizes = Array.from({ length: K }, (_, k) => Math.floor(n / K) + (k < n % K ? 1 : 0));
      let start = 0;
      for (let k = 0; k < K; k += 1) {
        for (const i of order.slice(start, start + foldSizes[k])) predictionRows[i].fold = k + 1;
        start += foldSizes[k];
      }
    }
    const cvRmse = meanOf(repeatSummaries.map((item) => item.rmse));
    const cvMae = meanOf(repeatSummaries.map((item) => item.mae));
    const cvR2 = meanOf(repeatSummaries.map((item) => item.r2));
    const foldRmseSd = foldRows.length > 1 ? Math.sqrt(sampleVariance(foldRows.map((row) => row.rmse))) : 0;
    const foldTable = H.tableArtifact("Cross-validation folds", `${K}-fold cross-validation of the OLS model (${options.repeats} repeat${options.repeats > 1 ? "s" : ""}, ${options.shuffle ? `shuffled with seed ${options.seed}` : "contiguous folds"}).`, [
      { key: "repeat", label: "Repeat", type: "number" },
      { key: "fold", label: "Fold", type: "number" },
      { key: "testSize", label: "Test rows", type: "number" },
      { key: "trainSize", label: "Training rows", type: "number" },
      { key: "rmse", label: "RMSE", type: "number" },
      { key: "mae", label: "MAE", type: "number" },
      { key: "r2", label: "R-squared (within fold)", type: "number" },
    ], foldRows, [], "cv-fold-table");
    const predictionTable = H.tableArtifact("Out-of-fold predictions", "Observed outcome, out-of-fold prediction (first repeat) and in-sample fitted value for every observation.", [
      { key: "observation", label: "Observation", type: "number" },
      { key: "fold", label: "Fold", type: "number" },
      { key: "observed", label: "Observed", type: "number" },
      { key: "outOfFoldPrediction", label: "Out-of-fold prediction", type: "number" },
      { key: "inSampleFitted", label: "In-sample fitted", type: "number" },
    ], predictionRows, [], "cv-prediction-table");
    const summaryRows = [
      { metric: "RMSE", inSample: inSampleRmse, crossValidated: cvRmse, leaveOneOut: looRmse },
      { metric: "MAE", inSample: inSampleMae, crossValidated: cvMae, leaveOneOut: looMae },
      { metric: "R-squared", inSample: inSampleR2, crossValidated: cvR2, leaveOneOut: looR2 },
    ];
    const summary = H.tableArtifact("Predictive performance", "In-sample, K-fold cross-validated (pooled out-of-fold, averaged over repeats) and leave-one-out (PRESS) performance.", [
      { key: "metric", label: "Metric", type: "string" },
      { key: "inSample", label: "In-sample", type: "number" },
      { key: "crossValidated", label: `${K}-fold CV`, type: "number" },
      { key: "leaveOneOut", label: "Leave-one-out", type: "number" },
    ], summaryRows, [], "cv-summary-table");
    const figure = H.vegaArtifact("cv-fold-rmse", `Out-of-fold RMSE by fold against the in-sample and cross-validated RMSE`, {
      data: { values: foldRows },
      width: 520,
      height: 300,
      layer: [
        { mark: { type: "bar", color: "#4c78a8" }, encoding: { x: { field: "fold", type: "ordinal", title: "Fold" }, y: { field: "rmse", type: "quantitative", title: "RMSE" }, xOffset: { field: "repeat", type: "nominal" }, color: { field: "repeat", type: "nominal", title: "Repeat" }, tooltip: [{ field: "repeat", title: "Repeat" }, { field: "fold", title: "Fold" }, { field: "rmse", title: "RMSE", format: ".4g" }, { field: "mae", title: "MAE", format: ".4g" }, { field: "testSize", title: "Test rows" }] } },
        { mark: { type: "rule", color: "#d62728", strokeWidth: 2 }, encoding: { y: { datum: cvRmse, type: "quantitative" } } },
        { mark: { type: "rule", color: "#333333", strokeWidth: 2, strokeDash: [6, 4] }, encoding: { y: { datum: inSampleRmse, type: "quantitative" } } },
      ],
    });
    const optimism = cvRmse - inSampleRmse;
    return {
      sample: { n, predictors: parsed.predictors.length, coefficients: p, folds: K, repeats: options.repeats, shuffle: options.shuffle, seed: options.shuffle ? options.seed : null, generator: options.shuffle ? prng.generator : null },
      estimates: [
        { parameter: "inSampleRmse", estimate: inSampleRmse, role: "derived" },
        { parameter: "crossValidatedRmse", estimate: cvRmse, role: "derived" },
        { parameter: "leaveOneOutRmse", estimate: looRmse, role: "derived" },
        { parameter: "inSampleMae", estimate: inSampleMae, role: "derived" },
        { parameter: "crossValidatedMae", estimate: cvMae, role: "derived" },
        { parameter: "leaveOneOutMae", estimate: looMae, role: "derived" },
        { parameter: "inSampleR2", estimate: inSampleR2, role: "derived" },
        { parameter: "crossValidatedR2", estimate: cvR2, role: "derived" },
        { parameter: "leaveOneOutR2", estimate: looR2, role: "derived" },
        { parameter: "rmseOptimism", estimate: optimism, role: "derived" },
        { parameter: "foldRmseSd", estimate: foldRmseSd, role: "derived" },
        { parameter: "press", estimate: press, role: "derived" },
        ...full.beta.map((value, index) => ({ parameter: `coefficient:${index === 0 && options.intercept ? "Intercept" : parsed.predictors[index - (options.intercept ? 1 : 0)].name}`, estimate: value, role: "full-model" })),
      ],
      tests: [],
      confidenceIntervals: [],
      effectSizes: [{ name: "cross-validated R-squared", estimate: cvR2 }, { name: "in-sample R-squared", estimate: inSampleR2 }],
      assumptions: [
        { name: "independent observations across folds", status: "requires_design_review", detail: "grouped or time-ordered data need grouped or rolling folds" },
        { name: "linear mean structure with constant error variance", status: "requires_design_review" },
        { name: "shuffled fold assignment", status: options.shuffle ? "applied" : "not_applied" },
      ],
      diagnostics: [
        { name: "optimism", status: optimism > 0.1 * inSampleRmse ? "material" : "small", detail: "cross-validated minus in-sample RMSE", rmseOptimism: optimism, relative: inSampleRmse > 0 ? optimism / inSampleRmse : 0 },
        { name: "fold stability", status: cvRmse > 0 && foldRmseSd > 0.5 * cvRmse ? "unstable" : "stable", foldRmseSd, coefficientOfVariation: cvRmse > 0 ? foldRmseSd / cvRmse : 0 },
        { name: "leverage", status: maxLeverage > 2 * p / n ? "high_leverage_present" : "moderate", maxLeverage, threshold: 2 * p / n },
        { name: "fold assignment", status: "evaluated", generator: options.shuffle ? prng.generator : null, seed: options.shuffle ? options.seed : null, foldSizes: Array.from({ length: K }, (_, k) => Math.floor(n / K) + (k < n % K ? 1 : 0)) },
      ],
      artifacts: [summary, foldTable, predictionTable, figure],
    };
  },
  linkage: {
    neededWhen: "When a regression model will be used to predict new cases and the in-sample fit is suspected of being optimistic because the same data chose and evaluated the model.",
    decision: "Whether the model's predictive error on unseen data is acceptable, and whether the in-sample fit overstates it enough to change the modelling choice.",
    mustShow: "In-sample, K-fold and leave-one-out error metrics side by side, the per-fold spread, the fold assignment scheme with its seed, and the out-of-fold predictions against the observed values.",
    userGoal: "Report predictive performance that a reader can trust for new observations, not just goodness of fit on the training data.",
    nextActions: [
      { trigger: "optimism-material", action: "simplify-model-or-add-regularization-and-recross-validate", reason: "A large gap between in-sample and out-of-fold error is direct evidence that the model is fitting noise." },
      { trigger: "fold-variance-large", action: "increase-repeats-or-use-leave-one-out", reason: "Unstable fold errors mean the reported average depends on the fold assignment, so the seed matters more than the model." },
      { trigger: "grouped-or-temporal-structure", action: "switch-to-grouped-or-rolling-folds", reason: "Random folds leak information across dependent observations and understate the true error." },
      { trigger: "performance-committed", action: "bind-cv-summary-and-fold-table-to-report", reason: "The reported error must travel with the exact fold scheme, seed and metric definitions." },
    ],
  },
  fixture: {
    data: {
      y: [10.2, 12.8, 15.1, 13.4, 17.9, 19.2, 21.5, 20.1, 24.3, 26.8, 25.2, 29.4, 31.1, 30.5, 34.2, 36.8],
      predictors: [
        { name: "dose", values: [1, 2, 3, 3, 5, 6, 7, 7, 9, 10, 10, 12, 13, 13, 15, 16] },
        { name: "age", values: [34, 41, 29, 52, 38, 45, 31, 60, 47, 36, 55, 42, 39, 58, 44, 50] },
      ],
      outcomeLabel: "Response",
    },
    options: { folds: 4, shuffle: true, repeats: 1, seed: 20240901 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression", "matlab.stats.machine-learning-pipelines"] },
  coverage: {
    implementedBoundary: "K-fold (optionally shuffled and repeated) and leave-one-out (PRESS via leverage) cross-validation of an OLS regression with numeric predictors, reporting RMSE, MAE and R-squared in-sample and out-of-fold.",
    oracle: { level: "external-library-partial", evidence: ["contracts/resampling-scipy-crosscheck.py"], verifiedOutputs: ["out-of-fold predictions and pooled metrics against sklearn KFold + LinearRegression for contiguous folds", "shuffled fold assignment against a Python port of the seeded generator", "leave-one-out RMSE against sklearn LeaveOneOut"], excludedOutputs: ["categorical predictors", "regularised or generalised linear models"] },
    diagnostic: { level: "method-specific-partial", emitted: ["optimism (CV minus in-sample RMSE)", "fold stability", "maximum leverage", "fold sizes and seed"], limitations: ["does not detect grouped or temporal dependence", "no nested cross-validation for model selection"] },
    knownGaps: ["no grouped, stratified or rolling folds", "no GLM cross-validation"],
  },
};

module.exports = {
  methods: [bootstrapConfidenceInterval, permutationTest, jackknife, crossValidationRegression],
  internals: { STATISTICS, meanOf, medianOf, trimmedMeanOf, sampleVariance, pearsonOf, histogramRows, olsFit, predictRow },
};
