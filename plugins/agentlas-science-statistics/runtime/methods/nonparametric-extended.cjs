"use strict";

/**
 * Extended rank-based nonparametric methods.
 *
 * Pure deterministic JavaScript. Every numeric helper arrives through `H` (engine HELPERS).
 * Categorical trend tests (Cochran-Armitage, McNemar, ...) live in categorical-extended.cjs.
 */

const MODEL = Object.freeze({ families: ["nonparametric"], distributions: [null], links: [null] });
const ORACLE_FILE = "contracts/nonparametric-extended-scipy-crosscheck.py";
const MAX_PAIRWISE_PRODUCT = 2_000_000;
const MAX_JT_TOTAL = 5_000;

// ---------------------------------------------------------------------------------------------
// Shared numeric helpers (accurate normal tail via the regularized gamma function)
// ---------------------------------------------------------------------------------------------

function normalSf(H, x) {
  const tail = 0.5 * H.gammaQ(0.5, (x * x) / 2);
  return x >= 0 ? tail : 1 - tail;
}

function normalCdfAccurate(H, x) {
  return 1 - normalSf(H, x);
}

function normalPValue(H, z, alternative) {
  if (alternative === "less") return Math.min(1, Math.max(0, normalCdfAccurate(H, z)));
  if (alternative === "greater") return Math.min(1, Math.max(0, normalSf(H, z)));
  return Math.min(1, Math.max(0, 2 * normalSf(H, Math.abs(z))));
}

function zCritical(H, level) {
  return H.normalInv(1 - (1 - level) / 2);
}

function finiteOrFail(H, value, what) {
  if (!Number.isFinite(value)) H.fail("STAT_DEGENERATE", `${what} is not finite`);
  return Object.is(value, -0) ? 0 : value;
}

function binomialLogPmf(H, n, k) {
  return H.logChoose(n, k) - n * Math.LN2;
}

function binomialCdfHalf(H, n, k) {
  if (k < 0) return 0;
  if (k >= n) return 1;
  let total = 0;
  for (let i = 0; i <= k; i += 1) total += Math.exp(binomialLogPmf(H, n, i));
  return Math.min(1, total);
}

function toEstimates(object) {
  return Object.entries(object).map(([name, value]) => (value === null || ["number", "string", "boolean"].includes(typeof value) ? { name, estimate: value } : { name, value }));
}

function sortedCopy(values) {
  return values.slice().sort((a, b) => a - b);
}

function medianOf(values) {
  const ordered = sortedCopy(values);
  const n = ordered.length;
  return n % 2 === 1 ? ordered[(n - 1) / 2] : (ordered[n / 2 - 1] + ordered[n / 2]) / 2;
}

function hasDuplicates(values) {
  return new Set(values).size !== values.length;
}

function percent(level) {
  return Math.round(level * 100);
}

// ---------------------------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------------------------

function parseGroupData(data, H, minimum, exact) {
  H.assertKeys(data, ["groups"], "data");
  return { groups: H.parseGroups({ groups: data.groups }, minimum, exact) };
}

function parseBlockMatrix(data, H, method) {
  H.assertKeys(data, ["conditions"], "data");
  if (!Array.isArray(data.conditions) || data.conditions.length < 3 || data.conditions.length > H.LIMITS.maxGroups) {
    H.fail("STAT_INVALID_INPUT", `data.conditions length must be between 3 and ${H.LIMITS.maxGroups}`);
  }
  const names = new Set();
  let blockCount = null;
  const conditions = data.conditions.map((raw, index) => {
    const path = `data.conditions[${index}]`;
    const condition = H.assertObject(raw, path);
    H.assertKeys(condition, ["name", "values"], path);
    const name = H.label(condition.name, `Condition ${index + 1}`, `${path}.name`);
    if (names.has(name)) H.fail("STAT_INVALID_INPUT", `duplicate condition name: ${name}`);
    names.add(name);
    const values = H.numericVector(condition.values, `${path}.values`, 2);
    if (blockCount === null) blockCount = values.length;
    if (values.length !== blockCount) H.fail("STAT_INVALID_INPUT", `${method} requires a complete block matrix with equal condition lengths`);
    return { name, values };
  });
  if (conditions.length * blockCount > H.LIMITS.maxTotalValues) H.fail("STAT_LIMIT_EXCEEDED", `${method} block matrix exceeds ${H.LIMITS.maxTotalValues} values`);
  return { conditions, blockCount };
}

const groupSchema = {
  type: "object",
  additionalProperties: false,
  required: ["values"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 128 },
    values: { type: "array", minItems: 2, maxItems: 100000, items: { type: "number" } },
  },
};

function groupsDataSchema(minItems, maxItems = 64) {
  return { type: "object", additionalProperties: false, required: ["groups"], properties: { groups: { type: "array", minItems, maxItems, items: groupSchema } } };
}

const conditionsDataSchema = {
  type: "object",
  additionalProperties: false,
  required: ["conditions"],
  properties: { conditions: { type: "array", minItems: 3, maxItems: 64, items: groupSchema } },
};

// ---------------------------------------------------------------------------------------------
// Rank summaries shared by Kruskal-Wallis post hoc procedures
// ---------------------------------------------------------------------------------------------

function pooledRankSummary(groups, H, budget) {
  const combined = [];
  groups.forEach((group, groupIndex) => group.values.forEach((value) => combined.push({ value, groupIndex })));
  const ranked = H.averageRanks(combined.map((item) => item.value));
  const rankSums = Array(groups.length).fill(0);
  let sumSquaredRanks = 0;
  combined.forEach((item, index) => {
    budget.check();
    rankSums[item.groupIndex] += ranked.ranks[index];
    sumSquaredRanks += ranked.ranks[index] ** 2;
  });
  const n = combined.length;
  const tieTerm = ranked.tieSizes.reduce((total, size) => total + size ** 3 - size, 0);
  const meanRanks = rankSums.map((value, index) => value / groups[index].values.length);
  let h = 0;
  for (let i = 0; i < groups.length; i += 1) h += rankSums[i] ** 2 / groups[i].values.length;
  h = (12 / (n * (n + 1))) * h - 3 * (n + 1);
  const tieCorrection = 1 - tieTerm / (n ** 3 - n);
  if (!(tieCorrection > 0)) H.fail("STAT_DEGENERATE", "all pooled observations are tied; rank comparisons are undefined");
  h /= tieCorrection;
  return { n, rankSums, meanRanks, tieTerm, tieBlocks: ranked.tieSizes.length, sumSquaredRanks, kruskalWallis: h, tieCorrection };
}

function groupRankRows(groups, summary) {
  return groups.map((group, index) => ({ group: group.name, n: group.values.length, rankSum: summary.rankSums[index], meanRank: summary.meanRanks[index], median: medianOf(group.values) }));
}

const groupRankColumns = [
  { key: "group", label: "Group", type: "string" },
  { key: "n", label: "n", type: "number" },
  { key: "rankSum", label: "Rank sum", type: "number" },
  { key: "meanRank", label: "Mean rank", type: "number" },
  { key: "median", label: "Median", type: "number" },
];

function pairwiseColumns(statisticLabel, adjustmentLabel) {
  return [
    { key: "first", label: "Group A", type: "string" },
    { key: "second", label: "Group B", type: "string" },
    { key: "meanRankDifference", label: "Mean rank difference", type: "number" },
    { key: "standardError", label: "SE", type: "number" },
    { key: "statistic", label: statisticLabel, type: "number" },
    { key: "pValue", label: "Unadjusted p", type: "number" },
    { key: "adjustedPValue", label: `Adjusted p (${adjustmentLabel})`, type: "number" },
  ];
}

function pairwiseHeatmap(H, role, title, rows, adjustmentLabel) {
  return H.vegaArtifact(role, title, {
    data: { values: rows },
    layer: [
      { mark: { type: "rect", stroke: "white" }, encoding: { x: { field: "first", type: "nominal", title: "Group A", sort: null }, y: { field: "second", type: "nominal", title: "Group B", sort: null }, color: { field: "adjustedPValue", type: "quantitative", title: `Adjusted p (${adjustmentLabel})`, scale: { domain: [0, 1], scheme: "blues", reverse: true } }, tooltip: [{ field: "first" }, { field: "second" }, { field: "meanRankDifference", format: ".4g" }, { field: "statistic", format: ".4g" }, { field: "pValue", format: ".3g" }, { field: "adjustedPValue", format: ".3g" }] } },
      { mark: { type: "text", fontSize: 11 }, encoding: { x: { field: "first", type: "nominal", sort: null }, y: { field: "second", type: "nominal", sort: null }, text: { field: "adjustedPValue", type: "quantitative", format: ".3f" }, color: { condition: { test: "datum.adjustedPValue < 0.5", value: "white" }, value: "#1f2933" } } },
    ],
  });
}

const adjustmentOption = {
  schema: { type: "string", enum: ["holm", "benjamini-hochberg", "bonferroni", "none"] },
  default: "holm",
  parse(value, H, path) {
    if (!["holm", "benjamini-hochberg", "bonferroni", "none"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be holm, benjamini-hochberg, bonferroni, or none`);
    return value;
  },
};

function adjustPValues(H, values, adjustment) {
  if (adjustment === "none") return values.slice();
  return H.adjustedPValues(values, adjustment);
}

function postHocLinkage(name) {
  return {
    neededWhen: `A ${name} omnibus rank comparison across three or more independent groups was significant and the researcher must locate which specific pairs of groups differ.`,
    decision: "Decide which pairwise group contrasts remain credible after multiplicity adjustment and which apparent differences are consistent with rank noise.",
    mustShow: "Every pairwise contrast with mean rank difference, standard error, test statistic, unadjusted and adjusted p value, plus the omnibus statistic that licensed the follow-up.",
    userGoal: "Report defensible pairwise conclusions after a significant Kruskal-Wallis result without inflating the family-wise error rate.",
    nextActions: [
      { trigger: "omnibus-not-significant", action: "report-omnibus-only-and-avoid-pairwise-claims", reason: "Pairwise follow-ups without a significant omnibus test inflate false discovery and are not licensed by the design." },
      { trigger: "adjusted-pair-significant", action: "report-adjusted-pairwise-contrasts-with-effect-direction", reason: "Adjusted contrasts identify which groups differ while controlling the family-wise or false discovery rate." },
      { trigger: "heavy-ties-present", action: "review-measurement-resolution-and-consider-exact-permutation", reason: "Dense ties shrink the rank variance and make the normal approximation less trustworthy for small groups." },
      { trigger: "unbalanced-small-groups", action: "consider-conover-iman-or-permutation-follow-up", reason: "Small unbalanced groups reduce the accuracy of the large-sample pairwise approximation." },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// 1. Sign test
// ---------------------------------------------------------------------------------------------

function exactMedianInterval(H, sortedValues, level) {
  const n = sortedValues.length;
  const alphaHalf = (1 - level) / 2;
  let c = -1;
  for (let k = 0; k < n; k += 1) {
    if (binomialCdfHalf(H, n, k) <= alphaHalf) c = k;
    else break;
  }
  if (c < 0) return { lower: null, upper: null, achievedCoverage: null, status: "not_estimable", reason: "sample too small for the requested coverage" };
  const lowerIndex = c + 1;
  const upperIndex = n - c;
  if (lowerIndex > upperIndex) return { lower: null, upper: null, achievedCoverage: null, status: "not_estimable", reason: "order statistics cross" };
  return { lower: sortedValues[lowerIndex - 1], upper: sortedValues[upperIndex - 1], achievedCoverage: 1 - 2 * binomialCdfHalf(H, n, c), status: "exact_order_statistic", lowerOrder: lowerIndex, upperOrder: upperIndex };
}

const signTest = {
  method: "sign_test",
  family: "nonparametric",
  analysisModel: MODEL,
  optionKeys: ["confidenceLevel", "alternative", "timeoutMs"],
  customOptions: {
    mu: {
      schema: { type: "number" },
      default: 0,
      parse(value, H, path) { return H.finiteNumber(value, path); },
    },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["x"],
    properties: {
      x: { type: "array", minItems: 2, maxItems: 100000, items: { type: "number" } },
      y: { type: "array", minItems: 2, maxItems: 100000, items: { type: "number" } },
      xLabel: { type: "string", minLength: 1, maxLength: 128 },
      yLabel: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["x", "y", "xLabel", "yLabel"], "data");
    const x = H.numericVector(data.x, "data.x", 2);
    const paired = data.y !== undefined;
    const y = paired ? H.numericVector(data.y, "data.y", 2) : null;
    if (paired && y.length !== x.length) H.fail("STAT_INVALID_INPUT", "data.x and data.y must have equal length for a paired sign test");
    if (!paired && data.yLabel !== undefined) H.fail("STAT_INVALID_INPUT", "data.yLabel requires data.y");
    return { x, y, paired, xLabel: H.label(data.xLabel, paired ? "X" : "Value", "data.xLabel"), yLabel: H.label(data.yLabel, "Y", "data.yLabel") };
  },
  analyze(parsed, options, budget, H) {
    const differences = parsed.paired ? parsed.x.map((value, index) => value - parsed.y[index]) : parsed.x.map((value) => value - options.mu);
    let positive = 0;
    let negative = 0;
    let zeros = 0;
    for (const value of differences) {
      budget.check();
      if (value > 0) positive += 1;
      else if (value < 0) negative += 1;
      else zeros += 1;
    }
    const n = positive + negative;
    if (n < 1) H.fail("STAT_DEGENERATE", "sign test requires at least one non-zero difference");
    const pLess = binomialCdfHalf(H, n, positive);
    const pGreater = positive === 0 ? 1 : 1 - binomialCdfHalf(H, n, positive - 1);
    const pValue = options.alternative === "less" ? pLess : options.alternative === "greater" ? pGreater : Math.min(1, 2 * Math.min(pLess, pGreater));
    const observedProbability = Math.exp(binomialLogPmf(H, n, positive));
    const target = parsed.paired ? differences : parsed.x;
    const interval = exactMedianInterval(H, sortedCopy(target), options.confidenceLevel);
    const medianEstimate = medianOf(target);
    const targetLabel = parsed.paired ? `${parsed.xLabel} - ${parsed.yLabel}` : parsed.xLabel;
    const countRows = [
      { sign: "positive", count: positive, proportion: positive / differences.length },
      { sign: "negative", count: negative, proportion: negative / differences.length },
      { sign: "zero", count: zeros, proportion: zeros / differences.length },
    ];
    const summaryRow = { comparison: parsed.paired ? `${parsed.xLabel} vs ${parsed.yLabel}` : `${parsed.xLabel} vs ${options.mu}`, nonZero: n, positive, negative, zeros, pValue, alternative: options.alternative, median: medianEstimate, lower: interval.lower, upper: interval.upper };
    return {
      sample: { n: differences.length, nonZero: n, zeros, paired: parsed.paired },
      estimates: toEstimates({ positive, negative, zeros, proportionPositive: positive / n, median: medianEstimate, hypothesizedValue: parsed.paired ? 0 : options.mu, medianInterval: interval }),
      tests: [{ name: "Sign test", statistic: positive, distribution: "exact binomial(n, 0.5) on non-zero differences", pValue, alternative: options.alternative, pValueMethod: "exact", observedProbability }],
      confidenceIntervals: [{ parameter: `median of ${targetLabel}`, level: options.confidenceLevel, lower: interval.lower, upper: interval.upper, method: interval.status === "exact_order_statistic" ? `exact binomial order-statistic interval (achieved coverage ${interval.achievedCoverage})` : `not estimated: ${interval.reason}` }],
      effectSizes: [{ name: "proportion of positive non-zero differences", estimate: positive / n, interpretation: "0.5 under the null of a symmetric sign distribution" }],
      assumptions: [{ name: parsed.paired ? "independent pairs" : "independent observations", status: "requires_design_review" }, { name: "continuous or ordinal outcome so that exact zeros are rare", status: zeros > 0 ? "warning_zero_differences_dropped" : "acceptable" }],
      diagnostics: [
        { name: "zero differences", status: zeros > 0 ? "dropped_from_test" : "absent", count: zeros, policy: "zeros are excluded from the binomial test but retained in the median interval" },
        { name: "p-value method", status: "exact", detail: "exact binomial tail probabilities; no normal approximation" },
        { name: "median interval", status: interval.status, ...(interval.achievedCoverage === null ? {} : { achievedCoverage: interval.achievedCoverage, lowerOrder: interval.lowerOrder, upperOrder: interval.upperOrder }), boundary: "order-statistic interval is conservative (achieved coverage is at least the requested level)" },
      ],
      artifacts: [
        H.tableArtifact("Sign test", `Exact binomial sign test for ${targetLabel}.`, [{ key: "comparison", label: "Comparison", type: "string" }, { key: "nonZero", label: "Non-zero n", type: "number" }, { key: "positive", label: "Positive", type: "number" }, { key: "negative", label: "Negative", type: "number" }, { key: "zeros", label: "Zeros", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "alternative", label: "Alternative", type: "string" }, { key: "median", label: "Median", type: "number" }, { key: "lower", label: "CI lower", type: "number" }, { key: "upper", label: "CI upper", type: "number" }], [summaryRow], [`${percent(options.confidenceLevel)}% exact order-statistic median interval; zeros excluded from the test.`]),
        H.tableArtifact("Sign counts", "Counts of positive, negative, and zero differences.", [{ key: "sign", label: "Sign", type: "string" }, { key: "count", label: "Count", type: "number" }, { key: "proportion", label: "Proportion", type: "number" }], countRows, [], "sign-count-table"),
        H.vegaArtifact("sign-count-bars", `Sign of differences: ${targetLabel}`, { data: { values: countRows }, mark: { type: "bar" }, encoding: { x: { field: "sign", type: "nominal", title: "Sign", sort: null }, y: { field: "count", type: "quantitative", title: "Count" }, color: { field: "sign", type: "nominal", legend: null, scale: { domain: ["positive", "negative", "zero"], range: ["#2f6f9f", "#b5533c", "#8c8c8c"] } }, tooltip: [{ field: "sign" }, { field: "count" }, { field: "proportion", format: ".3f" }] } }),
      ],
    };
  },
  linkage: {
    neededWhen: "Paired or one-sample data are ordinal or badly skewed and the researcher only trusts the direction of each difference rather than its magnitude.",
    decision: "Decide whether the median difference (or the median relative to a hypothesized value) is credibly different from zero using only signs.",
    mustShow: "Counts of positive, negative, and dropped zero differences, the exact binomial p value, and the order-statistic median interval with achieved coverage.",
    userGoal: "Establish a distribution-free directional conclusion that survives ordinal measurement and heavy outliers in the paired differences.",
    nextActions: [
      { trigger: "many-zero-differences", action: "review-measurement-resolution-and-report-dropped-zeros", reason: "Dropping many zeros reduces power and may indicate a measurement floor that the design should address." },
      { trigger: "symmetric-differences-plausible", action: "consider-wilcoxon-signed-rank-for-more-power", reason: "When differences are symmetric the signed-rank test uses magnitudes and is usually more powerful." },
      { trigger: "interval-not-estimable", action: "increase-sample-size-or-lower-confidence-level", reason: "The exact order-statistic interval needs enough observations to reach the requested coverage." },
    ],
  },
  fixture: { data: { x: [12.1, 9.8, 11.4, 13.2, 10.9, 12.7, 9.5, 11.8, 12.3, 10.2], y: [10.4, 9.9, 10.1, 12.0, 10.8, 11.1, 9.9, 10.6, 11.2, 10.0], xLabel: "post", yLabel: "pre" }, options: { confidenceLevel: 0.95 } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.location"] },
  coverage: {
    implementedBoundary: "Exact binomial sign test for paired differences or a one-sample hypothesized value, with an exact order-statistic median interval; zeros are dropped from the test.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["positive/negative/zero counts", "exact p value (scipy.stats.binomtest)", "median interval bounds and achieved coverage (scipy.stats.binom)"], excludedOutputs: ["normal-approximation variant", "power"] },
    diagnostic: { level: "method-specific-partial", emitted: ["zero-difference accounting", "achieved interval coverage"], limitations: ["no symmetry diagnostic", "no clustering adjustment"] },
    knownGaps: ["no mid-p variant", "no stratified sign test"],
  },
};

// ---------------------------------------------------------------------------------------------
// 2. Mood's median test
// ---------------------------------------------------------------------------------------------

const moodMedianTest = {
  method: "mood_median_test",
  family: "nonparametric",
  analysisModel: MODEL,
  optionKeys: ["timeoutMs"],
  customOptions: {
    continuity: { schema: { type: "boolean" }, default: true, parse(value, H, path) { if (typeof value !== "boolean") H.fail("STAT_INVALID_INPUT", `${path} must be boolean`); return value; } },
    tieHandling: {
      schema: { type: "string", enum: ["below", "above", "ignore"] },
      default: "below",
      parse(value, H, path) { if (!["below", "above", "ignore"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be below, above, or ignore`); return value; },
    },
  },
  dataSchema: groupsDataSchema(2),
  parse(data, options, H) { return parseGroupData(data, H, 2); },
  analyze(parsed, options, budget, H) {
    const groups = parsed.groups;
    const all = groups.flatMap((group) => group.values);
    const grandMedian = medianOf(all);
    const counts = groups.map((group) => {
      let above = 0;
      let below = 0;
      let ties = 0;
      for (const value of group.values) {
        budget.check();
        if (value > grandMedian) above += 1;
        else if (value < grandMedian) below += 1;
        else ties += 1;
      }
      if (options.tieHandling === "below") below += ties;
      else if (options.tieHandling === "above") above += ties;
      return { above, below, ties };
    });
    const totalAbove = counts.reduce((total, row) => total + row.above, 0);
    const totalBelow = counts.reduce((total, row) => total + row.below, 0);
    const total = totalAbove + totalBelow;
    if (totalAbove === 0 || totalBelow === 0) H.fail("STAT_DEGENERATE", "every retained observation lies on one side of the grand median; the median test is undefined");
    const df = groups.length - 1;
    const applyContinuity = options.continuity && df === 1;
    let statistic = 0;
    const cellRows = [];
    counts.forEach((row, index) => {
      const columnTotal = row.above + row.below;
      if (columnTotal === 0) H.fail("STAT_DEGENERATE", `group ${groups[index].name} has no retained observations after tie handling`);
      for (const [side, observed] of [["above", row.above], ["below", row.below]]) {
        const expected = (columnTotal * (side === "above" ? totalAbove : totalBelow)) / total;
        let adjusted = observed;
        if (applyContinuity) {
          const diff = expected - observed;
          adjusted = observed + Math.sign(diff) * Math.min(0.5, Math.abs(diff));
        }
        statistic += (adjusted - expected) ** 2 / expected;
        cellRows.push({ group: groups[index].name, side, observed, expected, contribution: (adjusted - expected) ** 2 / expected });
      }
    });
    const pValue = H.pFromChiSquare(statistic, df);
    const groupRows = groups.map((group, index) => ({ group: group.name, n: group.values.length, above: counts[index].above, below: counts[index].below, tiedWithMedian: counts[index].ties, proportionAbove: counts[index].above / (counts[index].above + counts[index].below), median: medianOf(group.values) }));
    const minimumExpected = Math.min(...cellRows.map((row) => row.expected));
    return {
      sample: { n: all.length, groups: groups.length, retained: total },
      estimates: toEstimates({ grandMedian, table: groupRows.map((row) => ({ group: row.group, above: row.above, below: row.below })) }),
      tests: [{ name: "Mood median test", statistic, distribution: applyContinuity ? "chi-square with Yates continuity correction" : "chi-square", df, pValue }],
      confidenceIntervals: [],
      effectSizes: [{ name: "Cramer's V of the above/below table", estimate: Math.sqrt(statistic / (total * 1)) }],
      assumptions: [{ name: "independent observations across and within groups", status: "requires_design_review" }, { name: "expected counts adequate for the chi-square approximation", status: minimumExpected < 5 ? "warning_small_expected_counts" : "acceptable", minimumExpected }],
      diagnostics: [
        { name: "tie handling", status: options.tieHandling, tiedWithGrandMedian: counts.reduce((sum, row) => sum + row.ties, 0), policy: `values equal to the grand median are counted as ${options.tieHandling === "ignore" ? "excluded" : options.tieHandling}` },
        { name: "continuity correction", status: applyContinuity ? "applied" : options.continuity ? "not_applicable_for_df_above_one" : "disabled" },
        { name: "approximation boundary", status: "asymptotic", detail: "chi-square approximation to the 2 x k table; no exact conditional test" },
      ],
      artifacts: [
        H.tableArtifact("Mood median test", `Grand median ${grandMedian}; counts above/below by group.`, [{ key: "group", label: "Group", type: "string" }, { key: "n", label: "n", type: "number" }, { key: "above", label: "Above", type: "number" }, { key: "below", label: "Below or equal", type: "number" }, { key: "tiedWithMedian", label: "Tied", type: "number" }, { key: "proportionAbove", label: "Proportion above", type: "number" }, { key: "median", label: "Group median", type: "number" }], groupRows, [`χ²(${df}) = ${statistic}, p = ${pValue}; tie handling: ${options.tieHandling}.`]),
        H.tableArtifact("Mood median cells", "Observed and expected counts per cell.", [{ key: "group", label: "Group", type: "string" }, { key: "side", label: "Side", type: "string" }, { key: "observed", label: "Observed", type: "number" }, { key: "expected", label: "Expected", type: "number" }, { key: "contribution", label: "Chi-square contribution", type: "number" }], cellRows, [], "mood-median-cell-table"),
        H.vegaArtifact("median-split-bars", "Proportion above the grand median by group", { data: { values: groupRows }, layer: [{ mark: { type: "bar" }, encoding: { x: { field: "group", type: "nominal", title: "Group", sort: null }, y: { field: "proportionAbove", type: "quantitative", title: "Proportion above grand median", scale: { domain: [0, 1] } }, tooltip: [{ field: "group" }, { field: "above" }, { field: "below" }, { field: "proportionAbove", format: ".3f" }] } }, { mark: { type: "rule", strokeDash: [4, 4], color: "#777" }, encoding: { y: { datum: 0.5 } } }] }),
      ],
    };
  },
  linkage: {
    neededWhen: "Two or more independent groups must be compared on location when only the sign relative to a common median is trustworthy, such as censored or coarse data.",
    decision: "Decide whether the groups share a common median or whether at least one group sits systematically above or below the pooled median.",
    mustShow: "The grand median, the above/below counts per group, the chi-square statistic with its continuity policy, and the expected-count adequacy warning.",
    userGoal: "Obtain a robust omnibus location comparison that tolerates outliers and censoring at the cost of some power.",
    nextActions: [
      { trigger: "median-test-significant", action: "follow-up-with-pairwise-rank-tests-and-adjust", reason: "The omnibus result does not say which groups differ; pairwise follow-ups need multiplicity control." },
      { trigger: "small-expected-counts", action: "use-fisher-exact-on-the-median-split-table", reason: "The chi-square approximation is unreliable when expected counts fall below five." },
      { trigger: "distribution-shapes-similar", action: "prefer-kruskal-wallis-for-power", reason: "When groups share a shape, rank-based omnibus tests are considerably more powerful than the median test." },
    ],
  },
  fixture: { data: { groups: [{ name: "control", values: [4.1, 5.2, 3.9, 6.0, 4.8, 5.5, 4.4, 5.1] }, { name: "dose1", values: [5.9, 6.3, 5.4, 7.1, 6.8, 5.7, 6.1, 7.4] }, { name: "dose2", values: [7.2, 6.9, 8.1, 7.6, 6.4, 8.3, 7.0, 7.8] }] } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.location"] },
  coverage: {
    implementedBoundary: "Mood median test on a 2 x k above/below split at the grand median with configurable tie handling and Yates correction for two groups.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["grand median", "chi-square statistic", "p value", "above/below table (scipy.stats.median_test)"], excludedOutputs: ["exact conditional p value"] },
    diagnostic: { level: "method-specific-partial", emitted: ["tie handling", "continuity policy", "minimum expected count"], limitations: ["no exact test", "no pairwise follow-up"] },
    knownGaps: ["no exact multinomial variant", "no stratification"],
  },
};

// ---------------------------------------------------------------------------------------------
// 3. Runs test (Wald-Wolfowitz)
// ---------------------------------------------------------------------------------------------

function runsExactDistribution(H, n1, n2) {
  const n = n1 + n2;
  const total = H.logChoose(n, n1);
  const probabilities = new Map();
  for (let r = 2; r <= n; r += 1) {
    let logP;
    if (r % 2 === 0) {
      const k = r / 2;
      logP = Math.LN2 + H.logChoose(n1 - 1, k - 1) + H.logChoose(n2 - 1, k - 1) - total;
    } else {
      const k = (r - 1) / 2;
      const a = H.logChoose(n1 - 1, k) + H.logChoose(n2 - 1, k - 1);
      const b = H.logChoose(n1 - 1, k - 1) + H.logChoose(n2 - 1, k);
      const parts = [a, b].filter((value) => Number.isFinite(value));
      if (!parts.length) continue;
      const max = Math.max(...parts);
      logP = max + Math.log(parts.reduce((sum, value) => sum + Math.exp(value - max), 0)) - total;
    }
    if (Number.isFinite(logP)) probabilities.set(r, Math.exp(logP));
  }
  return probabilities;
}

const runsTest = {
  method: "runs_test",
  family: "nonparametric",
  analysisModel: MODEL,
  optionKeys: ["alternative", "pValueMethod", "timeoutMs"],
  customOptions: {
    cutpoint: {
      schema: { type: ["number", "null"] },
      default: null,
      parse(value, H, path) { if (value === null) return null; return H.finiteNumber(value, path); },
    },
    continuity: { schema: { type: "boolean" }, default: true, parse(value, H, path) { if (typeof value !== "boolean") H.fail("STAT_INVALID_INPUT", `${path} must be boolean`); return value; } },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      values: { type: "array", minItems: 4, maxItems: 100000, items: { type: "number" } },
      sequence: { type: "array", minItems: 4, maxItems: 100000, items: { type: "integer", enum: [0, 1] } },
      label: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["values", "sequence", "label"], "data");
    const hasValues = data.values !== undefined;
    const hasSequence = data.sequence !== undefined;
    if (hasValues === hasSequence) H.fail("STAT_INVALID_INPUT", "data must contain exactly one of values or sequence");
    const label = H.label(data.label, hasValues ? "Value" : "Sequence", "data.label");
    if (hasValues) return { mode: "values", values: H.numericVector(data.values, "data.values", 4), label };
    if (!Array.isArray(data.sequence) || data.sequence.length < 4 || data.sequence.length > H.LIMITS.maxVectorLength) H.fail("STAT_INVALID_INPUT", `data.sequence length must be between 4 and ${H.LIMITS.maxVectorLength}`);
    return { mode: "sequence", sequence: data.sequence.map((item, index) => H.integer(item, 0, 1, `data.sequence[${index}]`)), label };
  },
  analyze(parsed, options, budget, H) {
    let cutpoint = null;
    let dropped = 0;
    let indicators;
    let sourceValues;
    if (parsed.mode === "values") {
      cutpoint = options.cutpoint === null ? medianOf(parsed.values) : options.cutpoint;
      indicators = [];
      sourceValues = [];
      parsed.values.forEach((value, index) => {
        budget.check();
        if (value === cutpoint) { dropped += 1; return; }
        indicators.push(value > cutpoint ? 1 : 0);
        sourceValues.push({ index, value });
      });
    } else {
      if (options.cutpoint !== null) H.fail("STAT_INVALID_INPUT", "options.cutpoint applies only to numeric values, not a binary sequence");
      indicators = parsed.sequence.slice();
      sourceValues = parsed.sequence.map((value, index) => ({ index, value }));
    }
    const n = indicators.length;
    const n1 = indicators.reduce((sum, value) => sum + value, 0);
    const n2 = n - n1;
    if (n < 4) H.fail("STAT_INSUFFICIENT_SAMPLE", "runs test requires at least four retained observations");
    if (n1 === 0 || n2 === 0) H.fail("STAT_DEGENERATE", "runs test requires both categories to be present after dichotomization");
    let runs = 1;
    const sequenceRows = [];
    let runId = 1;
    for (let i = 0; i < n; i += 1) {
      budget.check();
      if (i > 0 && indicators[i] !== indicators[i - 1]) { runs += 1; runId += 1; }
      sequenceRows.push({ position: i + 1, sourceIndex: sourceValues[i].index + 1, value: sourceValues[i].value, category: indicators[i] === 1 ? "above" : "below", run: runId });
    }
    const meanRuns = (2 * n1 * n2) / n + 1;
    const varianceRuns = (2 * n1 * n2 * (2 * n1 * n2 - n)) / (n * n * (n - 1));
    if (!(varianceRuns > 0)) H.fail("STAT_DEGENERATE", "runs variance is zero");
    const centered = runs - meanRuns;
    let correctionApplied = 0;
    if (options.continuity && n < 50) {
      if (Math.abs(centered) > 0.5) correctionApplied = -0.5 * Math.sign(centered);
      else correctionApplied = -centered;
    }
    const z = (centered + correctionApplied) / Math.sqrt(varianceRuns);
    const exactEligible = n <= 200;
    if (options.pValueMethod === "exact" && !exactEligible) H.fail("STAT_EXACT_UNAVAILABLE", "exact runs inference requires at most 200 retained observations");
    const useExact = options.pValueMethod === "exact" || (options.pValueMethod === "auto" && n <= 50);
    let pValue;
    let exactDetail = null;
    if (useExact) {
      const distribution = runsExactDistribution(H, n1, n2);
      let less = 0;
      let greater = 0;
      let mass = 0;
      for (const [r, probability] of distribution) {
        mass += probability;
        if (r <= runs) less += probability;
        if (r >= runs) greater += probability;
      }
      less = Math.min(1, less / mass);
      greater = Math.min(1, greater / mass);
      pValue = options.alternative === "less" ? less : options.alternative === "greater" ? greater : Math.min(1, 2 * Math.min(less, greater));
      exactDetail = { support: [2, n], totalMass: mass, pLess: less, pGreater: greater };
    } else {
      pValue = normalPValue(H, z, options.alternative);
    }
    const summaryRow = { label: parsed.label, n, above: n1, below: n2, runs, expectedRuns: meanRuns, varianceRuns, z, pValue, method: useExact ? "exact" : "asymptotic", alternative: options.alternative };
    return {
      sample: { n, above: n1, below: n2, dropped, mode: parsed.mode },
      estimates: toEstimates({ runs, expectedRuns: meanRuns, varianceRuns, cutpoint, standardizedRuns: z }),
      tests: [{ name: "Wald-Wolfowitz runs test", statistic: runs, standardizedStatistic: z, distribution: useExact ? "exact runs distribution" : `normal approximation${correctionApplied !== 0 ? " with continuity correction" : ""}`, pValue, alternative: options.alternative, pValueMethod: useExact ? "exact" : "asymptotic" }],
      confidenceIntervals: [],
      effectSizes: [{ name: "runs ratio (observed / expected)", estimate: runs / meanRuns, interpretation: "below 1 suggests clustering, above 1 suggests alternation" }],
      assumptions: [{ name: "fixed dichotomization rule chosen before seeing the outcome", status: "requires_design_review" }, { name: "exchangeability under the null", status: "method_definition" }],
      diagnostics: [
        { name: "dichotomization", status: parsed.mode === "values" ? "median_or_cutpoint" : "supplied_binary", cutpoint, droppedEqualToCutpoint: dropped },
        { name: "p-value method", status: useExact ? "exact" : "asymptotic", requested: options.pValueMethod, exactEligibility: "retained n <= 200; auto uses exact when n <= 50", continuityCorrection: correctionApplied !== 0 ? "applied_to_z" : "not_applied", ...(exactDetail ? exactDetail : {}) },
        { name: "alternative interpretation", status: "method_definition", detail: "less = fewer runs than expected (clustering); greater = more runs than expected (alternation)" },
      ],
      artifacts: [
        H.tableArtifact("Wald-Wolfowitz runs test", `Runs above and below ${cutpoint === null ? "the supplied binary coding" : `cutpoint ${cutpoint}`}.`, [{ key: "label", label: "Series", type: "string" }, { key: "n", label: "n", type: "number" }, { key: "above", label: "Above (1)", type: "number" }, { key: "below", label: "Below (0)", type: "number" }, { key: "runs", label: "Runs", type: "number" }, { key: "expectedRuns", label: "Expected runs", type: "number" }, { key: "varianceRuns", label: "Variance", type: "number" }, { key: "z", label: "z", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "method", label: "Method", type: "string" }, { key: "alternative", label: "Alternative", type: "string" }], [summaryRow], ["Values equal to the cutpoint are dropped before counting runs."]),
        H.tableArtifact("Run membership", "Retained observations in sequence order with run identifiers.", [{ key: "position", label: "Position", type: "number" }, { key: "sourceIndex", label: "Source index", type: "number" }, { key: "value", label: "Value", type: "number" }, { key: "category", label: "Category", type: "string" }, { key: "run", label: "Run", type: "number" }], sequenceRows, [], "runs-sequence-table"),
        H.vegaArtifact("runs-sequence-plot", `Run structure: ${parsed.label}`, { data: { values: sequenceRows }, layer: [{ mark: { type: "line", color: "#9aa5b1", strokeWidth: 1 }, encoding: { x: { field: "position", type: "quantitative", title: "Position" }, y: { field: "value", type: "quantitative", title: "Value" } } }, { mark: { type: "point", filled: true, size: 70 }, encoding: { x: { field: "position", type: "quantitative" }, y: { field: "value", type: "quantitative" }, color: { field: "category", type: "nominal", title: "Category", scale: { domain: ["above", "below"], range: ["#2f6f9f", "#b5533c"] } }, tooltip: [{ field: "position" }, { field: "value", format: ".4g" }, { field: "category" }, { field: "run" }] } }, ...(cutpoint === null ? [] : [{ mark: { type: "rule", strokeDash: [4, 4], color: "#555" }, encoding: { y: { datum: cutpoint } } }])] }),
      ],
    };
  },
  linkage: {
    neededWhen: "A single ordered sequence of observations or residuals must be checked for randomness, clustering, or alternation relative to a fixed threshold.",
    decision: "Decide whether the sequence shows fewer runs (clustering or trend) or more runs (alternation) than a random ordering would produce.",
    mustShow: "Counts above and below the threshold, observed versus expected runs, the standardized statistic, and whether exact or asymptotic inference was used.",
    userGoal: "Diagnose non-random ordering in a data series before trusting analyses that assume independent observations.",
    nextActions: [
      { trigger: "too-few-runs", action: "investigate-trend-or-serial-correlation", reason: "Clustering of like values indicates trend or autocorrelation that violates independence assumptions." },
      { trigger: "too-many-runs", action: "investigate-negative-autocorrelation-or-periodicity", reason: "Excess alternation suggests oscillation or overcorrection that a periodic component may explain." },
      { trigger: "many-values-at-cutpoint", action: "choose-a-different-cutpoint-or-report-dropped-values", reason: "Dropping many tied values changes the effective sample and can bias the runs count." },
    ],
  },
  fixture: { data: { values: [2.1, 3.4, 1.8, 4.2, 3.9, 1.2, 4.8, 2.6, 3.1, 4.5, 1.9, 2.8], label: "residuals" } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.distribution"] },
  coverage: {
    implementedBoundary: "Wald-Wolfowitz runs test around the median, a supplied cutpoint, or a binary sequence, with exact closed-form runs distribution for n <= 200 and a continuity-corrected normal approximation otherwise.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["runs count", "expected runs", "variance", "z statistic", "exact and asymptotic p values (numpy first principles)"], excludedOutputs: ["runs-up-and-down variant", "multi-category runs"] },
    diagnostic: { level: "method-specific-partial", emitted: ["dichotomization accounting", "p-value method"], limitations: ["no serial-correlation estimate", "no runs-up-and-down test"] },
    knownGaps: ["no two-sample Wald-Wolfowitz variant", "no runs-up-and-down test"],
  },
};

// ---------------------------------------------------------------------------------------------
// 4. Jonckheere-Terpstra
// ---------------------------------------------------------------------------------------------

function mannWhitneyCounts(m, n, budget) {
  // counts[u] = number of arrangements of m X's and n Y's with exactly u pairs (x < y)
  let previous = Array.from({ length: n + 1 }, () => [1]); // m = 0 row: for each n, only u = 0
  for (let i = 1; i <= m; i += 1) {
    const current = Array(n + 1);
    current[0] = [1];
    for (let j = 1; j <= n; j += 1) {
      budget.check();
      const size = i * j + 1;
      const row = Array(size).fill(0);
      const fromFewerY = current[j - 1]; // largest is a Y: contributes i
      const fromFewerX = previous[j]; // largest is an X: contributes 0
      for (let u = 0; u < fromFewerY.length; u += 1) row[u + i] += fromFewerY[u];
      for (let u = 0; u < fromFewerX.length; u += 1) row[u] += fromFewerX[u];
      current[j] = row;
    }
    previous = current;
  }
  return previous[n];
}

function convolve(a, b, budget) {
  const out = Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === 0) continue;
    for (let j = 0; j < b.length; j += 1) {
      budget.check();
      out[i + j] += a[i] * b[j];
    }
  }
  return out;
}

const jonckheereTerpstra = {
  method: "jonckheere_terpstra",
  family: "nonparametric",
  analysisModel: MODEL,
  optionKeys: ["alternative", "pValueMethod", "timeoutMs"],
  dataSchema: groupsDataSchema(2),
  parse(data, options, H) {
    const parsed = parseGroupData(data, H, 2);
    const total = parsed.groups.reduce((sum, group) => sum + group.values.length, 0);
    if (total > MAX_JT_TOTAL) H.fail("STAT_LIMIT_EXCEEDED", `jonckheere_terpstra supports at most ${MAX_JT_TOTAL} pooled observations`);
    return parsed;
  },
  analyze(parsed, options, budget, H) {
    const groups = parsed.groups;
    const k = groups.length;
    const sizes = groups.map((group) => group.values.length);
    const total = sizes.reduce((sum, value) => sum + value, 0);
    let j = 0;
    const pairRows = [];
    for (let a = 0; a < k; a += 1) {
      for (let b = a + 1; b < k; b += 1) {
        let u = 0;
        for (const x of groups[a].values) {
          for (const y of groups[b].values) {
            budget.check();
            if (x < y) u += 1;
            else if (x === y) u += 0.5;
          }
        }
        j += u;
        pairRows.push({ first: groups[a].name, second: groups[b].name, mannWhitneyU: u, pairs: sizes[a] * sizes[b] });
      }
    }
    const pooled = H.averageRanks(groups.flatMap((group) => group.values));
    const tieSizes = pooled.tieSizes;
    const mean = (total ** 2 - sizes.reduce((sum, n) => sum + n * n, 0)) / 4;
    const sumN = (fn) => sizes.reduce((sum, n) => sum + fn(n), 0);
    const sumT = (fn) => tieSizes.reduce((sum, t) => sum + fn(t), 0);
    let variance = (total * (total - 1) * (2 * total + 5) - sumN((n) => n * (n - 1) * (2 * n + 5)) - sumT((t) => t * (t - 1) * (2 * t + 5))) / 72;
    if (tieSizes.length) {
      variance += (sumN((n) => n * (n - 1) * (n - 2)) * sumT((t) => t * (t - 1) * (t - 2))) / (36 * total * (total - 1) * (total - 2));
      variance += (sumN((n) => n * (n - 1)) * sumT((t) => t * (t - 1))) / (8 * total * (total - 1));
    }
    if (!(variance > 0)) H.fail("STAT_DEGENERATE", "Jonckheere-Terpstra variance is zero");
    const z = (j - mean) / Math.sqrt(variance);
    const exactEligible = tieSizes.length === 0 && total <= 20;
    if (options.pValueMethod === "exact" && !exactEligible) H.fail("STAT_EXACT_UNAVAILABLE", "exact Jonckheere-Terpstra inference requires no ties and at most 20 pooled observations");
    const useExact = options.pValueMethod !== "asymptotic" && exactEligible;
    let pValue;
    let exactDetail = null;
    if (useExact) {
      let distribution = [1];
      let cumulative = sizes[0];
      for (let g = 1; g < k; g += 1) {
        distribution = convolve(distribution, mannWhitneyCounts(cumulative, sizes[g], budget), budget);
        cumulative += sizes[g];
      }
      const mass = distribution.reduce((sum, value) => sum + value, 0);
      let less = 0;
      let greater = 0;
      for (let value = 0; value < distribution.length; value += 1) {
        if (value <= j + 1e-9) less += distribution[value];
        if (value >= j - 1e-9) greater += distribution[value];
      }
      less /= mass;
      greater /= mass;
      pValue = options.alternative === "less" ? less : options.alternative === "greater" ? greater : Math.min(1, 2 * Math.min(less, greater));
      exactDetail = { arrangements: mass, pLess: less, pGreater: greater };
    } else {
      pValue = normalPValue(H, z, options.alternative);
    }
    const groupRows = groups.map((group, index) => ({ order: index + 1, group: group.name, n: sizes[index], median: medianOf(group.values), meanRank: 0 }));
    // mean pooled ranks
    let cursor = 0;
    groups.forEach((group, index) => {
      let sum = 0;
      for (let i = 0; i < group.values.length; i += 1) sum += pooled.ranks[cursor + i];
      cursor += group.values.length;
      groupRows[index].meanRank = sum / group.values.length;
    });
    const summaryRow = { statistic: j, expected: mean, variance, z, pValue, method: useExact ? "exact" : "asymptotic", alternative: options.alternative, groups: k, n: total };
    return {
      sample: { n: total, groups: k, groupSizes: sizes },
      estimates: toEstimates({ jt: j, expected: mean, variance, pairwiseU: pairRows }),
      tests: [{ name: "Jonckheere-Terpstra trend test", statistic: j, standardizedStatistic: z, distribution: useExact ? "exact convolution of Mann-Whitney null distributions" : "normal approximation with tie-corrected variance", pValue, alternative: options.alternative, pValueMethod: useExact ? "exact" : "asymptotic" }],
      confidenceIntervals: [],
      effectSizes: [{ name: "standardized JT statistic", estimate: z }, { name: "JT proportion (J / total cross-group pairs)", estimate: j / pairRows.reduce((sum, row) => sum + row.pairs, 0), interpretation: "0.5 under no ordered trend; above 0.5 favours the supplied increasing order" }],
      assumptions: [{ name: "group order fixed a priori", status: "requires_design_review" }, { name: "independent observations", status: "requires_design_review" }],
      diagnostics: [
        { name: "ties", status: tieSizes.length ? "present" : "absent", tieBlocks: tieSizes.length, varianceCorrection: tieSizes.length ? "Hollander-Wolfe tie-corrected variance" : "none needed" },
        { name: "p-value method", status: useExact ? "exact" : "asymptotic", requested: options.pValueMethod, exactEligibility: "no ties and pooled n <= 20", ...(exactDetail ? exactDetail : {}) },
        { name: "alternative interpretation", status: "method_definition", detail: "greater = values increase with the supplied group order; less = values decrease" },
      ],
      artifacts: [
        H.tableArtifact("Jonckheere-Terpstra trend test", "Ordered-alternative test across the supplied group order.", [{ key: "statistic", label: "JT", type: "number" }, { key: "expected", label: "Expected JT", type: "number" }, { key: "variance", label: "Variance", type: "number" }, { key: "z", label: "z", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "method", label: "Method", type: "string" }, { key: "alternative", label: "Alternative", type: "string" }, { key: "groups", label: "Groups", type: "number" }, { key: "n", label: "N", type: "number" }], [summaryRow], ["Group order is the hypothesized order; ties contribute one half to each pairwise count."]),
        H.tableArtifact("Group order summary", "Medians and pooled mean ranks in the hypothesized order.", [{ key: "order", label: "Order", type: "number" }, { key: "group", label: "Group", type: "string" }, { key: "n", label: "n", type: "number" }, { key: "median", label: "Median", type: "number" }, { key: "meanRank", label: "Mean pooled rank", type: "number" }], groupRows, [], "jt-group-order-table"),
        H.vegaArtifact("ordered-group-trend", "Group medians and mean ranks along the hypothesized order", { data: { values: groupRows }, layer: [{ mark: { type: "line", point: true, strokeWidth: 2 }, encoding: { x: { field: "group", type: "nominal", sort: null, title: "Group (hypothesized order)" }, y: { field: "meanRank", type: "quantitative", title: "Mean pooled rank" }, tooltip: [{ field: "group" }, { field: "n" }, { field: "median", format: ".4g" }, { field: "meanRank", format: ".4g" }] } }] }),
      ],
    };
  },
  linkage: {
    neededWhen: "Three or more independent groups have a natural ordering such as dose levels and the researcher expects a monotone shift rather than any difference.",
    decision: "Decide whether the outcome increases or decreases monotonically with the ordered factor, using more power than an unordered omnibus test.",
    mustShow: "The JT statistic with its expectation and variance, the standardized value, the p value with exact or asymptotic labelling, and the group-order summary.",
    userGoal: "Support a dose-response or ordered-trend claim with a distribution-free test that respects the pre-specified ordering.",
    nextActions: [
      { trigger: "trend-significant", action: "estimate-ordered-effect-sizes-and-pairwise-directions", reason: "A significant trend does not quantify the per-step shift; pairwise summaries make it interpretable." },
      { trigger: "non-monotone-pattern", action: "replace-trend-test-with-kruskal-wallis-and-post-hoc", reason: "The JT test can miss or misrepresent non-monotone dose-response patterns." },
      { trigger: "exact-not-available", action: "report-asymptotic-inference-with-tie-correction", reason: "Large or tied samples fall back to the normal approximation and this must be stated." },
    ],
  },
  fixture: { data: { groups: [{ name: "dose0", values: [10.2, 11.5, 9.8, 12.1] }, { name: "dose1", values: [12.4, 13.1, 11.9, 14.0] }, { name: "dose2", values: [14.2, 15.8, 13.6, 16.1] }] } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.location"] },
  coverage: {
    implementedBoundary: "Jonckheere-Terpstra ordered-alternative test with exact null distribution (convolution of Mann-Whitney distributions) for untied pooled n <= 20 and a tie-corrected normal approximation otherwise.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["JT statistic", "expectation", "tie-corrected variance", "asymptotic p value", "exact p value via brute-force enumeration (numpy/itertools)"], excludedOutputs: ["permutation p value with ties"] },
    diagnostic: { level: "method-specific-partial", emitted: ["tie accounting", "p-value method"], limitations: ["no exact inference with ties", "no continuity correction"] },
    knownGaps: ["no Monte Carlo p value for tied large samples"],
  },
};

// ---------------------------------------------------------------------------------------------
// 5. Page trend test
// ---------------------------------------------------------------------------------------------

function withinBlockRanks(matrix, H, budget) {
  // matrix: conditions x blocks; returns { rankSums[condition], meanRanks, tieTerm, tieBlocks }
  const k = matrix.conditions.length;
  const b = matrix.blockCount;
  const rankSums = Array(k).fill(0);
  const blockRanks = [];
  let tieTerm = 0;
  let tiedBlocks = 0;
  for (let block = 0; block < b; block += 1) {
    budget.check();
    const ranked = H.averageRanks(matrix.conditions.map((condition) => condition.values[block]));
    blockRanks.push(ranked.ranks);
    for (let c = 0; c < k; c += 1) rankSums[c] += ranked.ranks[c];
    if (ranked.tieSizes.length) tiedBlocks += 1;
    tieTerm += ranked.tieSizes.reduce((total, size) => total + size ** 3 - size, 0);
  }
  return { rankSums, meanRanks: rankSums.map((value) => value / b), tieTerm, tiedBlocks, blockRanks };
}

const pageTrendTest = {
  method: "page_trend_test",
  family: "nonparametric",
  analysisModel: MODEL,
  optionKeys: ["timeoutMs"],
  customOptions: {
    direction: {
      schema: { type: "string", enum: ["increasing", "decreasing"] },
      default: "increasing",
      parse(value, H, path) { if (!["increasing", "decreasing"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be increasing or decreasing`); return value; },
    },
  },
  dataSchema: conditionsDataSchema,
  parse(data, options, H) { return parseBlockMatrix(data, H, "page_trend_test"); },
  analyze(parsed, options, budget, H) {
    const k = parsed.conditions.length;
    const b = parsed.blockCount;
    const ranks = withinBlockRanks(parsed, H, budget);
    const predicted = parsed.conditions.map((_, index) => (options.direction === "increasing" ? index + 1 : k - index));
    const l = ranks.rankSums.reduce((sum, value, index) => sum + predicted[index] * value, 0);
    const expected = (b * k * (k + 1) ** 2) / 4;
    const variance = (b * k * k * (k + 1) * (k * k - 1)) / 144;
    const z = (l - expected) / Math.sqrt(variance);
    const pValue = normalSf(H, z);
    const conditionRows = parsed.conditions.map((condition, index) => ({ order: index + 1, condition: condition.name, predictedRank: predicted[index], rankSum: ranks.rankSums[index], meanRank: ranks.meanRanks[index], blocks: b }));
    const summaryRow = { statistic: l, expected, variance, z, pValue, direction: options.direction, blocks: b, conditions: k };
    const spearmanLike = ranks.meanRanks.map((value, index) => (value - (k + 1) / 2) * (predicted[index] - (k + 1) / 2)).reduce((sum, value) => sum + value, 0) / ((k * (k * k - 1)) / 12);
    return {
      sample: { n: b * k, blocks: b, conditions: k },
      estimates: toEstimates({ l, expected, variance, conditionRanks: conditionRows }),
      tests: [{ name: "Page trend test", statistic: l, standardizedStatistic: z, distribution: "normal approximation (one-sided, upper tail)", pValue, alternative: options.direction, pValueMethod: "asymptotic" }],
      confidenceIntervals: [],
      effectSizes: [{ name: "mean-rank trend correlation with predicted order", estimate: spearmanLike, interpretation: "Spearman-type correlation between mean within-block ranks and the hypothesized order" }],
      assumptions: [{ name: "complete blocks with independent blocks", status: "verified_by_input_contract" }, { name: "condition order fixed a priori", status: "requires_design_review" }],
      diagnostics: [
        { name: "within-block ties", status: ranks.tiedBlocks ? "present" : "absent", tiedBlocks: ranks.tiedBlocks, boundary: "the asymptotic variance is not tie-corrected; ties make the test slightly conservative" },
        { name: "p-value method", status: "asymptotic", detail: "one-sided normal approximation; exact small-sample tables are not implemented", boundary: b < 12 && k < 4 ? "small design; the normal approximation is coarse" : "adequate for the normal approximation" },
      ],
      artifacts: [
        H.tableArtifact("Page trend test", `Ordered alternative (${options.direction}) across matched conditions.`, [{ key: "statistic", label: "L", type: "number" }, { key: "expected", label: "Expected L", type: "number" }, { key: "variance", label: "Variance", type: "number" }, { key: "z", label: "z", type: "number" }, { key: "pValue", label: "p (one-sided)", type: "number" }, { key: "direction", label: "Direction", type: "string" }, { key: "blocks", label: "Blocks", type: "number" }, { key: "conditions", label: "Conditions", type: "number" }], [summaryRow], ["Ranks are computed within each block; predicted ranks follow the supplied condition order."]),
        H.tableArtifact("Page condition ranks", "Rank sums and mean within-block ranks against the predicted order.", [{ key: "order", label: "Order", type: "number" }, { key: "condition", label: "Condition", type: "string" }, { key: "predictedRank", label: "Predicted rank", type: "number" }, { key: "rankSum", label: "Rank sum", type: "number" }, { key: "meanRank", label: "Mean rank", type: "number" }, { key: "blocks", label: "Blocks", type: "number" }], conditionRows, [], "page-rank-table"),
        H.vegaArtifact("page-rank-trend", "Mean within-block ranks along the predicted order", { data: { values: conditionRows }, layer: [{ mark: { type: "line", point: true, strokeWidth: 2 }, encoding: { x: { field: "condition", type: "nominal", sort: null, title: "Condition (hypothesized order)" }, y: { field: "meanRank", type: "quantitative", title: "Mean within-block rank", scale: { domain: [1, k] } }, tooltip: [{ field: "condition" }, { field: "predictedRank" }, { field: "rankSum", format: ".4g" }, { field: "meanRank", format: ".4g" }] } }, { mark: { type: "line", strokeDash: [4, 4], color: "#888" }, encoding: { x: { field: "condition", type: "nominal", sort: null }, y: { field: "predictedRank", type: "quantitative" } } }] }),
      ],
    };
  },
  linkage: {
    neededWhen: "Matched blocks are measured under three or more conditions that have an a priori ordering and the researcher expects a monotone trend across conditions.",
    decision: "Decide whether within-block ranks increase (or decrease) monotonically with the hypothesized condition order rather than differing arbitrarily.",
    mustShow: "The L statistic with expectation and variance, the standardized statistic, the one-sided p value, and mean ranks against predicted ranks.",
    userGoal: "Demonstrate an ordered within-subject effect such as dose or time trend with a rank-based test that respects blocking.",
    nextActions: [
      { trigger: "trend-significant", action: "report-mean-rank-profile-and-effect-direction", reason: "The trend statistic alone does not convey the size or shape of the ordered effect." },
      { trigger: "non-monotone-profile", action: "use-friedman-and-nemenyi-instead", reason: "Page's test is designed for monotone alternatives and can misrepresent peaked profiles." },
      { trigger: "many-tied-blocks", action: "state-conservative-inference-or-use-permutation", reason: "The asymptotic variance ignores ties, so tied designs need caution or an exact approach." },
    ],
  },
  fixture: { data: { conditions: [{ name: "week1", values: [3.1, 2.8, 3.5, 2.9, 3.3, 3.0, 2.7, 3.4] }, { name: "week2", values: [3.6, 3.2, 3.9, 3.1, 3.8, 3.5, 3.0, 3.7] }, { name: "week3", values: [4.0, 3.9, 4.4, 3.6, 4.1, 4.2, 3.4, 4.3] }, { name: "week4", values: [4.5, 4.1, 4.8, 4.0, 4.6, 4.7, 3.9, 4.9] }] } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.location"] },
  coverage: {
    implementedBoundary: "Page's L trend test for complete block designs with one-sided normal approximation; predicted ranks follow the supplied condition order or its reverse.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["L statistic", "asymptotic p value (scipy.stats.page_trend_test method=asymptotic)", "condition rank sums"], excludedOutputs: ["exact small-sample p value"] },
    diagnostic: { level: "method-specific-partial", emitted: ["tie accounting", "asymptotic boundary"], limitations: ["no exact tables", "no tie correction"] },
    knownGaps: ["no exact p value for small designs"],
  },
};

// ---------------------------------------------------------------------------------------------
// 6. Dunn test
// ---------------------------------------------------------------------------------------------

function buildPairwise(groups, summary, H, statisticFn) {
  const rows = [];
  for (let a = 0; a < groups.length; a += 1) {
    for (let b = a + 1; b < groups.length; b += 1) {
      const meanRankDifference = summary.meanRanks[a] - summary.meanRanks[b];
      const { standardError, statistic, pValue } = statisticFn(a, b, meanRankDifference);
      rows.push({ first: groups[a].name, second: groups[b].name, meanRankDifference, standardError, statistic, pValue, adjustedPValue: 0 });
    }
  }
  return rows;
}

const dunnTest = {
  method: "dunn_test",
  family: "nonparametric",
  analysisModel: MODEL,
  optionKeys: ["timeoutMs"],
  customOptions: { adjustment: adjustmentOption },
  dataSchema: groupsDataSchema(3),
  parse(data, options, H) { return parseGroupData(data, H, 3); },
  analyze(parsed, options, budget, H) {
    const groups = parsed.groups;
    const summary = pooledRankSummary(groups, H, budget);
    const n = summary.n;
    const k = groups.length;
    const varianceFactor = (n * (n + 1)) / 12 - summary.tieTerm / (12 * (n - 1));
    if (!(varianceFactor > 0)) H.fail("STAT_DEGENERATE", "Dunn variance factor is not positive after tie correction");
    const pairwise = buildPairwise(groups, summary, H, (a, b, difference) => {
      const standardError = Math.sqrt(varianceFactor * (1 / groups[a].values.length + 1 / groups[b].values.length));
      const statistic = difference / standardError;
      return { standardError, statistic, pValue: Math.min(1, 2 * normalSf(H, Math.abs(statistic))) };
    });
    const adjusted = adjustPValues(H, pairwise.map((row) => row.pValue), options.adjustment);
    pairwise.forEach((row, index) => { row.adjustedPValue = adjusted[index]; });
    const omnibusP = H.pFromChiSquare(summary.kruskalWallis, k - 1);
    const groupRows = groupRankRows(groups, summary);
    return {
      sample: { n, groups: k, groupSizes: groups.map((group) => group.values.length), comparisons: pairwise.length },
      estimates: toEstimates({ omnibus: { statistic: summary.kruskalWallis, df: k - 1, pValue: omnibusP }, meanRanks: summary.meanRanks, pairwise }),
      tests: [{ name: "Kruskal-Wallis omnibus", statistic: summary.kruskalWallis, distribution: "chi-square approximation with tie correction", df: k - 1, pValue: omnibusP }, ...pairwise.map((row) => ({ name: `Dunn z: ${row.first} vs ${row.second}`, statistic: row.statistic, distribution: "normal", pValue: row.pValue, adjustedPValue: row.adjustedPValue, adjustment: options.adjustment }))],
      confidenceIntervals: [],
      effectSizes: pairwise.map((row) => ({ name: `${row.first} vs ${row.second} standardized mean rank difference`, estimate: row.statistic / Math.sqrt(n) })),
      assumptions: [{ name: "independent observations", status: "requires_design_review" }, { name: "post hoc licensed by a significant omnibus test", status: omnibusP < 0.05 ? "omnibus_significant_at_0.05" : "omnibus_not_significant_at_0.05" }],
      diagnostics: [
        { name: "ties", status: summary.tieBlocks ? "present" : "absent", tieBlocks: summary.tieBlocks, tieCorrection: "Dunn tie-corrected variance" },
        { name: "multiplicity adjustment", status: options.adjustment, comparisons: pairwise.length },
        { name: "approximation boundary", status: "asymptotic", detail: "normal approximation to the pairwise mean-rank difference; small groups reduce accuracy" },
      ],
      artifacts: [
        H.tableArtifact("Dunn pairwise comparisons", `Post hoc mean-rank contrasts after Kruskal-Wallis with ${options.adjustment} adjustment.`, pairwiseColumns("z", options.adjustment), pairwise, [`Omnibus H(${k - 1}) = ${summary.kruskalWallis}, p = ${omnibusP}.`]),
        H.tableArtifact("Group rank summary", "Pooled rank sums and mean ranks by group.", groupRankColumns, groupRows, [], "dunn-group-rank-table"),
        pairwiseHeatmap(H, "dunn-pairwise-heatmap", "Dunn adjusted p values by pair", pairwise, options.adjustment),
      ],
    };
  },
  linkage: postHocLinkage("Kruskal-Wallis"),
  fixture: { data: { groups: [{ name: "A", values: [2.1, 3.4, 2.8, 3.9, 2.5, 3.1] }, { name: "B", values: [4.2, 5.1, 4.8, 5.6, 4.4, 5.0] }, { name: "C", values: [6.3, 7.1, 6.8, 7.5, 6.0, 6.9] }, { name: "D", values: [3.0, 4.1, 3.6, 4.5, 3.3, 3.8] }] }, options: { adjustment: "holm" } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.location"] },
  coverage: {
    implementedBoundary: "Dunn (1964) pairwise z tests on pooled mean ranks after Kruskal-Wallis with tie-corrected variance and Holm, Benjamini-Hochberg, Bonferroni, or no adjustment.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["mean ranks", "pairwise z statistics", "unadjusted p values", "Holm-adjusted p values (statsmodels multipletests)", "omnibus H (scipy.stats.kruskal)"], excludedOutputs: ["confidence intervals for rank differences"] },
    diagnostic: { level: "method-specific-partial", emitted: ["tie accounting", "omnibus licensing", "adjustment"], limitations: ["no exact permutation reference"] },
    knownGaps: ["no simultaneous confidence intervals", "no one-sided pairwise alternatives"],
  },
};

// ---------------------------------------------------------------------------------------------
// 7. Conover-Iman test
// ---------------------------------------------------------------------------------------------

const conoverImanTest = {
  method: "conover_iman_test",
  family: "nonparametric",
  analysisModel: MODEL,
  optionKeys: ["timeoutMs"],
  customOptions: { adjustment: adjustmentOption },
  dataSchema: groupsDataSchema(3),
  parse(data, options, H) { return parseGroupData(data, H, 3); },
  analyze(parsed, options, budget, H) {
    const groups = parsed.groups;
    const summary = pooledRankSummary(groups, H, budget);
    const n = summary.n;
    const k = groups.length;
    const sSquared = (summary.sumSquaredRanks - (n * (n + 1) ** 2) / 4) / (n - 1);
    if (!(sSquared > 0)) H.fail("STAT_DEGENERATE", "Conover-Iman rank variance is zero");
    const h = summary.kruskalWallis;
    const df = n - k;
    if (df < 1) H.fail("STAT_INSUFFICIENT_SAMPLE", "Conover-Iman requires more observations than groups");
    const shrink = (n - 1 - h) / df;
    if (!(shrink > 0)) H.fail("STAT_DEGENERATE", "groups are perfectly separated in rank; the Conover-Iman denominator collapses to zero");
    const pairwise = buildPairwise(groups, summary, H, (a, b, difference) => {
      const standardError = Math.sqrt(sSquared * shrink * (1 / groups[a].values.length + 1 / groups[b].values.length));
      const statistic = difference / standardError;
      return { standardError, statistic, pValue: H.pFromT(statistic, df, "two-sided") };
    });
    const adjusted = adjustPValues(H, pairwise.map((row) => row.pValue), options.adjustment);
    pairwise.forEach((row, index) => { row.adjustedPValue = adjusted[index]; });
    const omnibusP = H.pFromChiSquare(h, k - 1);
    const groupRows = groupRankRows(groups, summary);
    return {
      sample: { n, groups: k, groupSizes: groups.map((group) => group.values.length), comparisons: pairwise.length },
      estimates: toEstimates({ omnibus: { statistic: h, df: k - 1, pValue: omnibusP }, rankVariance: sSquared, residualDf: df, meanRanks: summary.meanRanks, pairwise }),
      tests: [{ name: "Kruskal-Wallis omnibus", statistic: h, distribution: "chi-square approximation with tie correction", df: k - 1, pValue: omnibusP }, ...pairwise.map((row) => ({ name: `Conover-Iman t: ${row.first} vs ${row.second}`, statistic: row.statistic, distribution: "t", df, pValue: row.pValue, adjustedPValue: row.adjustedPValue, adjustment: options.adjustment }))],
      confidenceIntervals: [],
      effectSizes: pairwise.map((row) => ({ name: `${row.first} vs ${row.second} mean rank difference`, estimate: row.meanRankDifference })),
      assumptions: [{ name: "independent observations", status: "requires_design_review" }, { name: "post hoc licensed by a significant omnibus test", status: omnibusP < 0.05 ? "omnibus_significant_at_0.05" : "omnibus_not_significant_at_0.05", boundary: "Conover-Iman is only valid conditional on a significant Kruskal-Wallis result" }],
      diagnostics: [
        { name: "ties", status: summary.tieBlocks ? "present" : "absent", tieBlocks: summary.tieBlocks, rankVariance: sSquared },
        { name: "multiplicity adjustment", status: options.adjustment, comparisons: pairwise.length },
        { name: "approximation boundary", status: "asymptotic", detail: `t reference with ${df} degrees of freedom on rank-transformed data` },
      ],
      artifacts: [
        H.tableArtifact("Conover-Iman pairwise comparisons", `Rank-based t contrasts after Kruskal-Wallis with ${options.adjustment} adjustment (df = ${df}).`, pairwiseColumns("t", options.adjustment), pairwise, [`Omnibus H(${k - 1}) = ${h}, p = ${omnibusP}; S² = ${sSquared}.`]),
        H.tableArtifact("Group rank summary", "Pooled rank sums and mean ranks by group.", groupRankColumns, groupRows, [], "conover-group-rank-table"),
        pairwiseHeatmap(H, "conover-pairwise-heatmap", "Conover-Iman adjusted p values by pair", pairwise, options.adjustment),
      ],
    };
  },
  linkage: postHocLinkage("Kruskal-Wallis"),
  fixture: { data: { groups: [{ name: "A", values: [2.1, 3.4, 2.8, 3.9, 2.5, 3.1] }, { name: "B", values: [4.2, 5.1, 4.8, 5.6, 4.4, 5.0] }, { name: "C", values: [6.3, 7.1, 6.8, 7.5, 6.0, 6.9] }, { name: "D", values: [3.0, 4.1, 3.6, 4.5, 3.3, 3.8] }] }, options: { adjustment: "holm" } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.location"] },
  coverage: {
    implementedBoundary: "Conover-Iman (1979) pairwise t tests on pooled ranks after Kruskal-Wallis, with the (N-1-H)/(N-k) shrinkage and configurable multiplicity adjustment.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["rank variance S²", "pairwise t statistics", "unadjusted p values (scipy.stats.t)", "Holm-adjusted p values (statsmodels multipletests)"], excludedOutputs: ["confidence intervals"] },
    diagnostic: { level: "method-specific-partial", emitted: ["tie accounting", "omnibus licensing", "adjustment"], limitations: ["validity depends on a significant omnibus test"] },
    knownGaps: ["no simultaneous confidence intervals"],
  },
};

// ---------------------------------------------------------------------------------------------
// 8. Nemenyi test (after Friedman) with studentized range (df = infinity)
// ---------------------------------------------------------------------------------------------

function studentizedRangeCdfInfinity(H, q, k, budget) {
  if (q <= 0) return 0;
  const lower = -9;
  const upper = 9;
  const panels = 2000;
  const step = (upper - lower) / panels;
  const integrand = (z) => {
    const phi = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
    const inner = normalCdfAccurate(H, z) - normalCdfAccurate(H, z - q);
    return phi * Math.pow(Math.max(0, inner), k - 1);
  };
  let total = integrand(lower) + integrand(upper);
  for (let i = 1; i < panels; i += 1) {
    budget.check();
    total += (i % 2 === 0 ? 2 : 4) * integrand(lower + i * step);
  }
  return Math.min(1, Math.max(0, (k * step * total) / 3));
}

const nemenyiTest = {
  method: "nemenyi_test",
  family: "nonparametric",
  analysisModel: MODEL,
  optionKeys: ["timeoutMs"],
  dataSchema: conditionsDataSchema,
  parse(data, options, H) { return parseBlockMatrix(data, H, "nemenyi_test"); },
  analyze(parsed, options, budget, H) {
    const k = parsed.conditions.length;
    const b = parsed.blockCount;
    const ranks = withinBlockRanks(parsed, H, budget);
    const tieCorrection = 1 - ranks.tieTerm / (b * k * (k * k - 1));
    if (!(tieCorrection > 0)) H.fail("STAT_DEGENERATE", "every block is fully tied; Friedman ranks carry no information");
    const friedman = Math.max(0, ((12 / (b * k * (k + 1))) * ranks.rankSums.reduce((sum, value) => sum + value * value, 0) - 3 * b * (k + 1)) / tieCorrection);
    const friedmanP = H.pFromChiSquare(friedman, k - 1);
    const standardError = Math.sqrt((k * (k + 1)) / (12 * b));
    const pairwise = [];
    for (let a = 0; a < k; a += 1) {
      for (let c = a + 1; c < k; c += 1) {
        const meanRankDifference = ranks.meanRanks[a] - ranks.meanRanks[c];
        const statistic = Math.abs(meanRankDifference) / standardError;
        const pValue = 1 - studentizedRangeCdfInfinity(H, statistic, k, budget);
        pairwise.push({ first: parsed.conditions[a].name, second: parsed.conditions[c].name, meanRankDifference, standardError, statistic, pValue: Math.min(1, Math.max(0, pValue)), adjustedPValue: Math.min(1, Math.max(0, pValue)) });
      }
    }
    const conditionRows = parsed.conditions.map((condition, index) => ({ condition: condition.name, rankSum: ranks.rankSums[index], meanRank: ranks.meanRanks[index], blocks: b }));
    return {
      sample: { n: b * k, blocks: b, conditions: k, comparisons: pairwise.length },
      estimates: toEstimates({ omnibus: { statistic: friedman, df: k - 1, pValue: friedmanP }, meanRanks: ranks.meanRanks, criticalDifferenceScale: standardError, pairwise }),
      tests: [{ name: "Friedman omnibus", statistic: friedman, distribution: "chi-square approximation with within-block tie correction", df: k - 1, pValue: friedmanP }, ...pairwise.map((row) => ({ name: `Nemenyi q: ${row.first} vs ${row.second}`, statistic: row.statistic, distribution: "studentized range (df = infinity) via numerical integration", pValue: row.pValue }))],
      confidenceIntervals: [],
      effectSizes: pairwise.map((row) => ({ name: `${row.first} vs ${row.second} mean rank difference`, estimate: row.meanRankDifference })),
      assumptions: [{ name: "complete matched blocks", status: "verified_by_input_contract" }, { name: "post hoc licensed by a significant omnibus test", status: friedmanP < 0.05 ? "omnibus_significant_at_0.05" : "omnibus_not_significant_at_0.05" }],
      diagnostics: [
        { name: "within-block ties", status: ranks.tiedBlocks ? "present" : "absent", tiedBlocks: ranks.tiedBlocks, boundary: "the Nemenyi standard error is not tie-corrected" },
        { name: "reference distribution", status: "asymptotic", detail: "studentized range with infinite degrees of freedom evaluated by Simpson integration (2000 panels on [-9, 9]); family-wise control is built into the studentized range so no further adjustment is applied" },
      ],
      artifacts: [
        H.tableArtifact("Nemenyi pairwise comparisons", "All-pairs mean-rank contrasts after Friedman using the studentized range.", [{ key: "first", label: "Condition A", type: "string" }, { key: "second", label: "Condition B", type: "string" }, { key: "meanRankDifference", label: "Mean rank difference", type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "statistic", label: "q", type: "number" }, { key: "pValue", label: "p (studentized range)", type: "number" }, { key: "adjustedPValue", label: "Family-wise p", type: "number" }], pairwise, [`Friedman χ²(${k - 1}) = ${friedman}, p = ${friedmanP}.`]),
        H.tableArtifact("Condition rank summary", "Within-block rank sums and mean ranks.", [{ key: "condition", label: "Condition", type: "string" }, { key: "rankSum", label: "Rank sum", type: "number" }, { key: "meanRank", label: "Mean rank", type: "number" }, { key: "blocks", label: "Blocks", type: "number" }], conditionRows, [], "nemenyi-rank-table"),
        pairwiseHeatmap(H, "nemenyi-pairwise-heatmap", "Nemenyi family-wise p values by pair", pairwise, "studentized range"),
      ],
    };
  },
  linkage: {
    neededWhen: "A Friedman test over three or more matched conditions was significant and the researcher must identify which conditions differ while controlling the family-wise error rate.",
    decision: "Decide which pairs of matched conditions have credibly different mean within-block ranks after simultaneous inference.",
    mustShow: "Every pairwise mean-rank difference with its studentized-range statistic and family-wise p value, plus the Friedman omnibus that licensed the follow-up.",
    userGoal: "Report which repeated-measures conditions differ without inflating error across all pairwise comparisons.",
    nextActions: [
      { trigger: "omnibus-not-significant", action: "report-omnibus-only-and-avoid-pairwise-claims", reason: "Pairwise follow-ups without a significant Friedman test are not licensed by the design." },
      { trigger: "pair-significant", action: "report-mean-rank-differences-with-direction", reason: "The studentized-range statistic is unsigned; the direction comes from the mean-rank difference." },
      { trigger: "few-blocks", action: "consider-exact-permutation-or-conover-friedman-follow-up", reason: "With few blocks the infinite-df studentized range is coarse and alternative follow-ups may be more accurate." },
    ],
  },
  fixture: { data: { conditions: [{ name: "baseline", values: [5.1, 4.8, 5.6, 4.9, 5.3, 5.0, 4.7, 5.4] }, { name: "drugA", values: [6.2, 5.9, 6.8, 5.7, 6.4, 6.1, 5.5, 6.6] }, { name: "drugB", values: [7.0, 6.6, 7.4, 6.3, 7.1, 6.9, 6.2, 7.3] }, { name: "placebo", values: [5.3, 4.9, 5.8, 5.0, 5.2, 5.1, 4.6, 5.6] }] } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.location"] },
  coverage: {
    implementedBoundary: "Nemenyi all-pairs test after Friedman on complete blocks using the studentized range with infinite degrees of freedom computed by numerical integration; no tie correction.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["mean ranks", "pairwise q statistics", "studentized-range p values (scipy.stats.studentized_range with df = infinity)", "Friedman omnibus (scipy.stats.friedmanchisquare)"], excludedOutputs: ["chi-square approximation variant"] },
    diagnostic: { level: "method-specific-partial", emitted: ["tie accounting", "reference distribution"], limitations: ["no tie-corrected standard error"] },
    knownGaps: ["no Conover-Friedman t variant", "no exact permutation reference"],
  },
};

// ---------------------------------------------------------------------------------------------
// 9. Hodges-Lehmann estimate
// ---------------------------------------------------------------------------------------------

function signedRankCounts(n, budget) {
  const total = (n * (n + 1)) / 2;
  const counts = Array(total + 1).fill(0n);
  counts[0] = 1n;
  let reached = 0;
  for (let rank = 1; rank <= n; rank += 1) {
    reached += rank;
    for (let s = reached; s >= rank; s -= 1) {
      budget.check();
      counts[s] += counts[s - rank];
    }
  }
  return counts;
}

function mannWhitneyCountsBig(m, n, budget) {
  let previous = Array.from({ length: n + 1 }, () => [1n]);
  for (let i = 1; i <= m; i += 1) {
    const current = Array(n + 1);
    current[0] = [1n];
    for (let j = 1; j <= n; j += 1) {
      budget.check();
      const row = Array(i * j + 1).fill(0n);
      const fromFewerY = current[j - 1];
      const fromFewerX = previous[j];
      for (let u = 0; u < fromFewerY.length; u += 1) row[u + i] += fromFewerY[u];
      for (let u = 0; u < fromFewerX.length; u += 1) row[u] += fromFewerX[u];
      current[j] = row;
    }
    previous = current;
  }
  return previous[n];
}

function lowerQuantileIndex(counts, alphaHalf) {
  // smallest q with P(S <= q) >= alphaHalf, computed on BigInt counts
  const total = counts.reduce((sum, value) => sum + value, 0n);
  const scale = 1e15;
  const threshold = BigInt(Math.ceil(alphaHalf * scale));
  let cumulative = 0n;
  for (let q = 0; q < counts.length; q += 1) {
    cumulative += counts[q];
    if (cumulative * BigInt(scale) >= threshold * total) return { index: q, cumulativeBelow: Number(cumulative - counts[q]) / Number(total) };
  }
  return { index: counts.length - 1, cumulativeBelow: 1 };
}

const hodgesLehmannEstimate = {
  method: "hodges_lehmann_estimate",
  family: "nonparametric",
  analysisModel: MODEL,
  optionKeys: ["confidenceLevel", "pValueMethod", "timeoutMs"],
  customOptions: {
    design: {
      schema: { type: "string", enum: ["one-sample", "two-sample"] },
      default: "two-sample",
      parse(value, H, path) { if (!["one-sample", "two-sample"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be one-sample or two-sample`); return value; },
    },
    mu: { schema: { type: "number" }, default: 0, parse(value, H, path) { return H.finiteNumber(value, path); } },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      x: { type: "array", minItems: 2, maxItems: 100000, items: { type: "number" } },
      y: { type: "array", minItems: 2, maxItems: 100000, items: { type: "number" } },
      groups: { type: "array", minItems: 2, maxItems: 2, items: groupSchema },
      label: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["x", "y", "groups", "label"], "data");
    const label = H.label(data.label, "Value", "data.label");
    if (options.design === "one-sample") {
      if (data.groups !== undefined) H.fail("STAT_INVALID_INPUT", "data.groups is only valid for the two-sample design");
      if (data.x === undefined) H.fail("STAT_INVALID_INPUT", "one-sample design requires data.x");
      const x = H.numericVector(data.x, "data.x", 2);
      const y = data.y === undefined ? null : H.numericVector(data.y, "data.y", 2);
      if (y && y.length !== x.length) H.fail("STAT_INVALID_INPUT", "data.x and data.y must have equal length for paired differences");
      const target = y ? x.map((value, index) => value - y[index]) : x;
      if ((target.length * (target.length + 1)) / 2 > MAX_PAIRWISE_PRODUCT) H.fail("STAT_LIMIT_EXCEEDED", "one-sample Hodges-Lehmann supports at most 2000 observations");
      return { design: "one-sample", target, paired: Boolean(y), label };
    }
    if (data.x !== undefined || data.y !== undefined) H.fail("STAT_INVALID_INPUT", "two-sample design uses data.groups, not data.x/data.y");
    if (data.groups === undefined) H.fail("STAT_INVALID_INPUT", "two-sample design requires data.groups");
    const groups = H.parseGroups({ groups: data.groups }, 2, 2);
    if (groups[0].values.length * groups[1].values.length > MAX_PAIRWISE_PRODUCT) H.fail("STAT_LIMIT_EXCEEDED", `two-sample Hodges-Lehmann supports at most ${MAX_PAIRWISE_PRODUCT} pairwise differences`);
    return { design: "two-sample", groups, label };
  },
  analyze(parsed, options, budget, H) {
    const alphaHalf = (1 - options.confidenceLevel) / 2;
    const z = zCritical(H, options.confidenceLevel);
    let candidates;
    let count;
    let exactEligible;
    let quantile;
    let method;
    let ties;
    let description;
    let n;
    let m;
    if (parsed.design === "one-sample") {
      const shifted = parsed.target.map((value) => value - options.mu);
      n = shifted.length;
      candidates = [];
      for (let i = 0; i < n; i += 1) {
        for (let j = i; j < n; j += 1) {
          budget.check();
          candidates.push((shifted[i] + shifted[j]) / 2);
        }
      }
      count = candidates.length;
      ties = shifted.some((value) => value === 0) || hasDuplicates(shifted.map(Math.abs));
      exactEligible = n <= 50 && !ties;
      if (options.pValueMethod === "exact" && !exactEligible) H.fail("STAT_EXACT_UNAVAILABLE", "exact Hodges-Lehmann interval requires n <= 50 with no zero or tied absolute values");
      const useExact = options.pValueMethod !== "asymptotic" && exactEligible;
      if (useExact) {
        quantile = lowerQuantileIndex(signedRankCounts(n, budget), alphaHalf);
        method = "exact";
      } else {
        quantile = { index: Math.round((n * (n + 1)) / 4 - z * Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24)), cumulativeBelow: null };
        method = "asymptotic";
      }
      description = parsed.paired ? `median of paired differences (${parsed.label})` : `pseudo-median of ${parsed.label}`;
    } else {
      const [first, second] = parsed.groups;
      m = first.values.length;
      n = second.values.length;
      candidates = [];
      for (const x of first.values) {
        for (const y of second.values) {
          budget.check();
          candidates.push(x - y);
        }
      }
      count = candidates.length;
      ties = hasDuplicates([...first.values, ...second.values]);
      exactEligible = m + n <= 60 && m * n <= 2500 && !ties;
      if (options.pValueMethod === "exact" && !exactEligible) H.fail("STAT_EXACT_UNAVAILABLE", "exact Hodges-Lehmann interval requires m + n <= 60, m * n <= 2500, and no ties");
      const useExact = options.pValueMethod !== "asymptotic" && exactEligible;
      if (useExact) {
        quantile = lowerQuantileIndex(mannWhitneyCountsBig(m, n, budget), alphaHalf);
        method = "exact";
      } else {
        quantile = { index: Math.round((m * n) / 2 - z * Math.sqrt((m * n * (m + n + 1)) / 12)), cumulativeBelow: null };
        method = "asymptotic";
      }
      description = `location shift ${first.name} - ${second.name}`;
    }
    candidates.sort((a, b) => a - b);
    const estimate = medianOf(candidates);
    let qu = quantile.index;
    if (qu < 1) qu = 1;
    if (qu > count) qu = count;
    const lowerIndex = qu;
    const upperIndex = count - qu + 1;
    let lower = null;
    let upper = null;
    let intervalStatus = "not_estimable";
    if (lowerIndex <= upperIndex) {
      lower = candidates[lowerIndex - 1];
      upper = candidates[upperIndex - 1];
      intervalStatus = method;
    }
    const achievedCoverage = method === "exact" && quantile.cumulativeBelow !== null ? 1 - 2 * quantile.cumulativeBelow : null;
    const shiftForReport = parsed.design === "one-sample" ? options.mu : 0;
    const row = { parameter: description, estimate: estimate + shiftForReport, lower: lower === null ? null : lower + shiftForReport, upper: upper === null ? null : upper + shiftForReport, level: options.confidenceLevel, method, candidates: count, lowerOrder: lowerIndex, upperOrder: upperIndex };
    return {
      sample: parsed.design === "one-sample" ? { n, candidates: count, design: parsed.design, paired: parsed.paired } : { n: m + n, groupSizes: [m, n], candidates: count, design: parsed.design },
      estimates: toEstimates({ estimate: row.estimate, lower: row.lower, upper: row.upper, candidateCount: count, hypothesizedValue: shiftForReport }),
      tests: [],
      confidenceIntervals: [{ parameter: description, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: intervalStatus === "not_estimable" ? "not estimable at this sample size" : `${method} order-statistic interval on ${parsed.design === "one-sample" ? "Walsh averages" : "pairwise differences"}${achievedCoverage === null ? "" : ` (achieved coverage ${achievedCoverage})`}` }],
      effectSizes: [{ name: "Hodges-Lehmann location estimate", estimate: row.estimate }],
      assumptions: [{ name: parsed.design === "one-sample" ? "symmetric distribution around the location" : "location-shift model (equal shapes)", status: "requires_distribution_review" }, { name: "independent observations", status: "requires_design_review" }],
      diagnostics: [
        { name: "ties", status: ties ? "present" : "absent", boundary: ties ? "ties disable the exact interval; the normal-approximation order-statistic bound is used" : "none" },
        { name: "interval method", status: intervalStatus, requested: options.pValueMethod, ...(achievedCoverage === null ? {} : { achievedCoverage }), lowerOrder: lowerIndex, upperOrder: upperIndex, exactEligibility: parsed.design === "one-sample" ? "n <= 50 and no zero or tied absolute values" : "m + n <= 60, m * n <= 2500, and no ties" },
      ],
      artifacts: [
        H.tableArtifact("Hodges-Lehmann estimate", `${percent(options.confidenceLevel)}% ${method} order-statistic interval.`, [{ key: "parameter", label: "Parameter", type: "string" }, { key: "estimate", label: "Estimate", type: "number" }, { key: "lower", label: "CI lower", type: "number" }, { key: "upper", label: "CI upper", type: "number" }, { key: "level", label: "Level", type: "number" }, { key: "method", label: "Method", type: "string" }, { key: "candidates", label: "Candidates", type: "number" }, { key: "lowerOrder", label: "Lower order", type: "number" }, { key: "upperOrder", label: "Upper order", type: "number" }], [row], ["Estimate is the median of Walsh averages (one-sample) or pairwise differences (two-sample)."]),
        H.vegaArtifact("location-estimate-interval", `Hodges-Lehmann ${description}`, { data: { values: [row] }, layer: [{ mark: { type: "rule", strokeWidth: 3, color: "#2f6f9f" }, encoding: { x: { field: "lower", type: "quantitative", title: description }, x2: { field: "upper" }, y: { field: "parameter", type: "nominal", title: null } } }, { mark: { type: "point", filled: true, size: 120, color: "#1f2933" }, encoding: { x: { field: "estimate", type: "quantitative" }, y: { field: "parameter", type: "nominal" }, tooltip: [{ field: "estimate", format: ".4g" }, { field: "lower", format: ".4g" }, { field: "upper", format: ".4g" }, { field: "method" }] } }, { mark: { type: "rule", strokeDash: [4, 4], color: "#888" }, encoding: { x: { datum: shiftForReport } } }] }),
      ],
    };
  },
  linkage: {
    neededWhen: "A robust point estimate of a location or location shift is needed alongside a rank-based test so the result can be reported as an interval rather than only a p value.",
    decision: "Decide the magnitude and plausible range of the shift between two samples, or of a one-sample location, without assuming normality.",
    mustShow: "The Hodges-Lehmann estimate, the order-statistic interval bounds with their achieved coverage, and whether exact or asymptotic quantiles were used.",
    userGoal: "Report an interpretable, distribution-free effect magnitude that complements Wilcoxon or Mann-Whitney inference.",
    nextActions: [
      { trigger: "interval-excludes-null", action: "report-shift-magnitude-with-interval", reason: "An interval excluding the null value conveys both significance and practical size." },
      { trigger: "unequal-shapes-suspected", action: "review-location-shift-assumption-and-consider-brunner-munzel", reason: "The two-sample estimate assumes a pure shift; differing shapes call for a relative-effect approach." },
      { trigger: "asymptotic-interval-used", action: "state-normal-approximation-boundary", reason: "Large or tied samples use approximate quantiles and the reported coverage is nominal." },
    ],
  },
  fixture: { data: { groups: [{ name: "treatment", values: [8.4, 9.1, 7.6, 10.2, 8.9, 9.7, 8.1] }, { name: "control", values: [6.3, 7.2, 5.8, 6.9, 7.5, 6.1, 6.6] }] }, options: { design: "two-sample", confidenceLevel: 0.95 } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.location"] },
  coverage: {
    implementedBoundary: "Hodges-Lehmann one-sample (Walsh averages) and two-sample (pairwise differences) estimates with exact signed-rank or Mann-Whitney order-statistic intervals for untied small samples and normal-approximation quantiles otherwise.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["point estimate", "exact interval bounds via brute-force null distributions (numpy/itertools)", "asymptotic interval bounds (first principles)"], excludedOutputs: ["tie-adjusted exact intervals"] },
    diagnostic: { level: "method-specific-partial", emitted: ["tie accounting", "interval method and achieved coverage"], limitations: ["no tie-adjusted exact quantiles"] },
    knownGaps: ["no accompanying hypothesis test (use wilcoxon_signed_rank or mann_whitney_u)"],
  },
};

// ---------------------------------------------------------------------------------------------
// 10. Brunner-Munzel test
// ---------------------------------------------------------------------------------------------

const brunnerMunzelTest = {
  method: "brunner_munzel_test",
  family: "nonparametric",
  analysisModel: MODEL,
  optionKeys: ["confidenceLevel", "alternative", "timeoutMs"],
  dataSchema: groupsDataSchema(2, 2),
  parse(data, options, H) { return parseGroupData(data, H, 2, 2); },
  analyze(parsed, options, budget, H) {
    const [first, second] = parsed.groups;
    const nx = first.values.length;
    const ny = second.values.length;
    if (nx < 2 || ny < 2) H.fail("STAT_INSUFFICIENT_SAMPLE", "Brunner-Munzel requires at least two observations per group");
    const pooled = H.averageRanks([...first.values, ...second.values]).ranks;
    const withinX = H.averageRanks(first.values).ranks;
    const withinY = H.averageRanks(second.values).ranks;
    const pooledX = pooled.slice(0, nx);
    const pooledY = pooled.slice(nx);
    const meanPooledX = H.mean(pooledX, budget);
    const meanPooledY = H.mean(pooledY, budget);
    const meanWithinX = (nx + 1) / 2;
    const meanWithinY = (ny + 1) / 2;
    let sx = 0;
    for (let i = 0; i < nx; i += 1) { budget.check(); sx += (pooledX[i] - withinX[i] - meanPooledX + meanWithinX) ** 2; }
    sx /= nx - 1;
    let sy = 0;
    for (let i = 0; i < ny; i += 1) { budget.check(); sy += (pooledY[i] - withinY[i] - meanPooledY + meanWithinY) ** 2; }
    sy /= ny - 1;
    const relativeEffect = (meanPooledY - meanPooledX) / (nx + ny) + 0.5;
    const varianceSum = nx * sx + ny * sy;
    if (!(varianceSum > 0)) H.fail("STAT_DEGENERATE", "Brunner-Munzel variance is zero (no overlap variability between the groups)");
    const standardError = Math.sqrt(varianceSum) / (nx * ny);
    const statistic = (relativeEffect - 0.5) / standardError;
    const dfNumerator = varianceSum ** 2;
    const dfDenominator = (nx * sx) ** 2 / (nx - 1) + (ny * sy) ** 2 / (ny - 1);
    if (!(dfDenominator > 0)) H.fail("STAT_DEGENERATE", "Brunner-Munzel degrees of freedom are undefined");
    const df = dfNumerator / dfDenominator;
    // alternative refers to the first group relative to the second (greater = first group tends to be larger, i.e. relative effect < 0.5)
    const cdf = H.tCdf(statistic, df);
    const pValue = options.alternative === "greater" ? Math.min(1, Math.max(0, cdf)) : options.alternative === "less" ? Math.min(1, Math.max(0, 1 - cdf)) : Math.min(1, 2 * Math.min(cdf, 1 - cdf));
    const critical = H.tCritical(options.confidenceLevel, df);
    const lower = Math.max(0, relativeEffect - critical * standardError);
    const upper = Math.min(1, relativeEffect + critical * standardError);
    const groupRows = [
      { group: first.name, n: nx, meanPooledRank: meanPooledX, rankVariance: sx, median: medianOf(first.values) },
      { group: second.name, n: ny, meanPooledRank: meanPooledY, rankVariance: sy, median: medianOf(second.values) },
    ];
    const summaryRow = { contrast: `${first.name} vs ${second.name}`, relativeEffect, lower, upper, standardError, statistic, df, pValue, alternative: options.alternative };
    return {
      sample: { n: nx + ny, groupSizes: [nx, ny] },
      estimates: toEstimates({ relativeEffect, standardError, df, meanPooledRanks: [meanPooledX, meanPooledY], rankVariances: [sx, sy] }),
      tests: [{ name: "Brunner-Munzel test", statistic, distribution: "t approximation with Satterthwaite-type degrees of freedom", df, pValue, alternative: options.alternative }],
      confidenceIntervals: [{ parameter: `relative effect P(${first.name} < ${second.name}) + 0.5 P(ties)`, level: options.confidenceLevel, lower, upper, method: "t-based Wald interval, truncated to [0, 1]" }],
      effectSizes: [{ name: "relative effect (probability of superiority of the second group)", estimate: relativeEffect, interpretation: "0.5 under stochastic equality; above 0.5 means the second group tends to be larger" }],
      assumptions: [{ name: "independent observations", status: "requires_design_review" }, { name: "no equal-variance or equal-shape requirement", status: "method_definition" }],
      diagnostics: [
        { name: "degrees of freedom", status: "satterthwaite_approximation", df, boundary: nx < 10 || ny < 10 ? "small groups; the t approximation may be liberal below ten per group" : "adequate" },
        { name: "alternative interpretation", status: "method_definition", detail: "greater = first group tends to be larger than the second (relative effect below 0.5)" },
      ],
      artifacts: [
        H.tableArtifact("Brunner-Munzel test", `Relative-effect comparison of ${first.name} and ${second.name}.`, [{ key: "contrast", label: "Contrast", type: "string" }, { key: "relativeEffect", label: "Relative effect", type: "number" }, { key: "lower", label: "CI lower", type: "number" }, { key: "upper", label: "CI upper", type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "statistic", label: "t", type: "number" }, { key: "df", label: "df", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "alternative", label: "Alternative", type: "string" }], [summaryRow], [`${percent(options.confidenceLevel)}% t-based interval for the relative effect.`]),
        H.tableArtifact("Brunner-Munzel rank summary", "Pooled mean ranks and rank variances by group.", [{ key: "group", label: "Group", type: "string" }, { key: "n", label: "n", type: "number" }, { key: "meanPooledRank", label: "Mean pooled rank", type: "number" }, { key: "rankVariance", label: "Rank variance", type: "number" }, { key: "median", label: "Median", type: "number" }], groupRows, [], "brunner-munzel-rank-table"),
        H.vegaArtifact("relative-effect-interval", "Relative effect with confidence interval", { data: { values: [summaryRow] }, layer: [{ mark: { type: "rule", strokeWidth: 3, color: "#2f6f9f" }, encoding: { x: { field: "lower", type: "quantitative", title: "Relative effect", scale: { domain: [0, 1] } }, x2: { field: "upper" }, y: { field: "contrast", type: "nominal", title: null } } }, { mark: { type: "point", filled: true, size: 120, color: "#1f2933" }, encoding: { x: { field: "relativeEffect", type: "quantitative" }, y: { field: "contrast", type: "nominal" }, tooltip: [{ field: "relativeEffect", format: ".4f" }, { field: "lower", format: ".4f" }, { field: "upper", format: ".4f" }, { field: "pValue", format: ".3g" }] } }, { mark: { type: "rule", strokeDash: [4, 4], color: "#888" }, encoding: { x: { datum: 0.5 } } }] }),
      ],
    };
  },
  linkage: {
    neededWhen: "Two independent groups differ in shape or spread so that Mann-Whitney's location-shift interpretation is unsafe and a stochastic-superiority comparison is wanted.",
    decision: "Decide whether one group tends to produce larger values than the other, quantified by the relative effect with an interval.",
    mustShow: "The relative effect with its interval, the t statistic with approximate degrees of freedom, and the small-sample boundary warning.",
    userGoal: "Compare two groups robustly under heteroscedasticity and report an interpretable probability-of-superiority effect size.",
    nextActions: [
      { trigger: "relative-effect-interval-excludes-half", action: "report-probability-of-superiority-with-interval", reason: "The relative effect is directly interpretable as the chance that one group exceeds the other." },
      { trigger: "very-small-groups", action: "use-permutation-brunner-munzel-or-exact-alternative", reason: "Below about ten per group the t approximation can be liberal and a permutation version is safer." },
      { trigger: "equal-shapes-plausible", action: "report-mann-whitney-and-hodges-lehmann-shift", reason: "When shapes match, a location-shift estimate is more informative than a probability statement." },
    ],
  },
  fixture: { data: { groups: [{ name: "treatment", values: [12.4, 15.1, 13.8, 18.2, 14.6, 16.9, 13.1, 17.5] }, { name: "control", values: [10.2, 11.9, 12.5, 9.8, 13.4, 11.1, 12.0, 10.7] }] }, options: { confidenceLevel: 0.95 } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.location"] },
  coverage: {
    implementedBoundary: "Brunner-Munzel heteroscedastic rank test with relative-effect estimate, t approximation with Satterthwaite-type degrees of freedom, and a truncated Wald interval.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["statistic", "degrees of freedom", "p value for all alternatives (scipy.stats.brunnermunzel)", "relative effect"], excludedOutputs: ["permutation p value", "normal-distribution variant"] },
    diagnostic: { level: "method-specific-partial", emitted: ["degrees of freedom boundary"], limitations: ["no permutation reference"] },
    knownGaps: ["no permutation variant for tiny samples"],
  },
};

// ---------------------------------------------------------------------------------------------
// 11. Quade test
// ---------------------------------------------------------------------------------------------

const quadeTest = {
  method: "quade_test",
  family: "nonparametric",
  analysisModel: MODEL,
  optionKeys: ["timeoutMs"],
  dataSchema: conditionsDataSchema,
  parse(data, options, H) { return parseBlockMatrix(data, H, "quade_test"); },
  analyze(parsed, options, budget, H) {
    const k = parsed.conditions.length;
    const b = parsed.blockCount;
    if (b < 2) H.fail("STAT_INSUFFICIENT_SAMPLE", "quade_test requires at least two blocks");
    const ranks = withinBlockRanks(parsed, H, budget);
    const ranges = [];
    for (let block = 0; block < b; block += 1) {
      const values = parsed.conditions.map((condition) => condition.values[block]);
      const range = H.minMax(values);
      ranges.push(range.max - range.min);
    }
    const blockRankInfo = H.averageRanks(ranges);
    const blockWeights = blockRankInfo.ranks;
    const s = Array(k).fill(0);
    let a = 0;
    for (let block = 0; block < b; block += 1) {
      for (let c = 0; c < k; c += 1) {
        budget.check();
        const value = blockWeights[block] * (ranks.blockRanks[block][c] - (k + 1) / 2);
        s[c] += value;
        a += value * value;
      }
    }
    const bStat = s.reduce((sum, value) => sum + value * value, 0) / b;
    if (!(a > 0)) H.fail("STAT_DEGENERATE", "every block is constant across conditions; the Quade statistic is undefined");
    if (a - bStat <= 1e-12 * a) H.fail("STAT_DEGENERATE", "conditions are perfectly ordered in every block; the Quade F statistic is unbounded");
    const statistic = ((b - 1) * bStat) / (a - bStat);
    const df1 = k - 1;
    const df2 = (b - 1) * (k - 1);
    const pValue = H.pFromF(statistic, df1, df2);
    const conditionRows = parsed.conditions.map((condition, index) => ({ condition: condition.name, weightedRankSum: s[index], meanRank: ranks.meanRanks[index], blocks: b }));
    const blockRows = ranges.map((range, block) => ({ block: block + 1, range, rangeRank: blockWeights[block] }));
    const summaryRow = { statistic, df1, df2, pValue, a, b: bStat, blocks: b, conditions: k };
    return {
      sample: { n: b * k, blocks: b, conditions: k },
      estimates: toEstimates({ weightedRankSums: s, a, b: bStat, blockRangeRanks: blockWeights }),
      tests: [{ name: "Quade test", statistic, distribution: "F", df: [df1, df2], pValue }],
      confidenceIntervals: [],
      effectSizes: [{ name: "Quade B / A (proportion of weighted rank variation between conditions)", estimate: bStat / a }],
      assumptions: [{ name: "complete matched blocks", status: "verified_by_input_contract" }, { name: "block ranges are meaningful (interval-scale outcome)", status: "requires_measurement_review" }],
      diagnostics: [
        { name: "within-block ties", status: ranks.tiedBlocks ? "present" : "absent", tiedBlocks: ranks.tiedBlocks },
        { name: "block range ties", status: blockRankInfo.tieSizes.length ? "present" : "absent", tieBlocks: blockRankInfo.tieSizes.length, policy: "average ranks for tied block ranges" },
        { name: "reference distribution", status: "asymptotic", detail: `F(${df1}, ${df2}) approximation as in Quade (1979)` },
      ],
      artifacts: [
        H.tableArtifact("Quade test", "Weighted rank analysis of a complete block design.", [{ key: "statistic", label: "F", type: "number" }, { key: "df1", label: "df1", type: "number" }, { key: "df2", label: "df2", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "a", label: "A", type: "number" }, { key: "b", label: "B", type: "number" }, { key: "blocks", label: "Blocks", type: "number" }, { key: "conditions", label: "Conditions", type: "number" }], [summaryRow], ["Blocks are weighted by the rank of their range; F = (b-1)B/(A-B)."]),
        H.tableArtifact("Quade condition summary", "Weighted rank sums and mean within-block ranks.", [{ key: "condition", label: "Condition", type: "string" }, { key: "weightedRankSum", label: "Weighted rank sum S", type: "number" }, { key: "meanRank", label: "Mean rank", type: "number" }, { key: "blocks", label: "Blocks", type: "number" }], conditionRows, [], "quade-condition-table"),
        H.tableArtifact("Quade block weights", "Block ranges and their ranks used as weights.", [{ key: "block", label: "Block", type: "number" }, { key: "range", label: "Range", type: "number" }, { key: "rangeRank", label: "Range rank", type: "number" }], blockRows, [], "quade-block-table"),
        H.vegaArtifact("weighted-rank-sums", "Quade weighted rank sums by condition", { data: { values: conditionRows }, layer: [{ mark: { type: "bar" }, encoding: { x: { field: "condition", type: "nominal", sort: null, title: "Condition" }, y: { field: "weightedRankSum", type: "quantitative", title: "Weighted rank sum S" }, tooltip: [{ field: "condition" }, { field: "weightedRankSum", format: ".4g" }, { field: "meanRank", format: ".4g" }] } }, { mark: { type: "rule", color: "#777" }, encoding: { y: { datum: 0 } } }] }),
      ],
    };
  },
  linkage: {
    neededWhen: "A complete block design has an interval-scale outcome where blocks with larger spread carry more information, so a Friedman test would discard useful magnitude information.",
    decision: "Decide whether conditions differ within blocks when block-to-block range differences should weight the evidence.",
    mustShow: "The F statistic with both degrees of freedom, the A and B components, the weighted rank sums per condition, and the block range weights.",
    userGoal: "Run a more powerful alternative to Friedman for few conditions when block ranges are meaningful.",
    nextActions: [
      { trigger: "quade-significant", action: "follow-up-with-pairwise-weighted-rank-contrasts", reason: "The omnibus F does not identify which conditions differ." },
      { trigger: "many-conditions", action: "prefer-friedman-and-nemenyi", reason: "Quade's advantage shrinks as the number of conditions grows beyond about five." },
      { trigger: "ordinal-outcome", action: "use-friedman-instead-of-quade", reason: "Block ranges are not meaningful for ordinal data, so range weighting is inappropriate." },
    ],
  },
  fixture: { data: { conditions: [{ name: "method1", values: [31, 28, 35, 29, 33, 30, 27, 34] }, { name: "method2", values: [36, 32, 39, 31, 38, 35, 30, 37] }, { name: "method3", values: [40, 39, 44, 36, 41, 42, 34, 43] }] } },
  matlabParity: { taxonomyIds: ["matlab.stats.anova"] },
  coverage: {
    implementedBoundary: "Quade (1979) weighted-rank F test for complete block designs with average ranks for tied block ranges; omnibus only.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["F statistic", "A and B components", "p value (numpy first principles with scipy.stats.rankdata and scipy.stats.f)"], excludedOutputs: ["pairwise follow-ups"] },
    diagnostic: { level: "method-specific-partial", emitted: ["tie accounting", "reference distribution"], limitations: ["no post hoc contrasts"] },
    knownGaps: ["no Quade all-pairs follow-up"],
  },
};

module.exports = {
  methods: [signTest, moodMedianTest, runsTest, jonckheereTerpstra, pageTrendTest, dunnTest, conoverImanTest, nemenyiTest, hodgesLehmannEstimate, brunnerMunzelTest, quadeTest],
};
