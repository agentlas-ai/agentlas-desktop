"use strict";

/**
 * Categorical-data extension family.
 *
 * Paired/stratified/trend tests for counts, exact tests, 2×2 effect measures, residual
 * decompositions, exact binomial and Poisson rate inference, and hierarchical log-linear
 * models fitted by iterative proportional fitting. Pure deterministic JavaScript; every
 * numeric helper arrives through the engine helper object `H`.
 */

const FAMILY = "categorical";
const ORACLE = "contracts/categorical-extended-scipy-crosscheck.py";
const MODEL = { families: ["categorical"], distributions: [null, "binomial", "poisson", "multinomial"], links: [null, "logit", "log"] };
const LABEL_SCHEMA = { type: "string", minLength: 1, maxLength: 128 };
const COUNT_SCHEMA = { type: "integer", minimum: 0 };
const TABLE_2X2_SCHEMA = { type: "array", minItems: 2, maxItems: 2, items: { type: "array", minItems: 2, maxItems: 2, items: COUNT_SCHEMA } };
const TABLE_RXC_SCHEMA = { type: "array", minItems: 2, maxItems: 64, items: { type: "array", minItems: 2, maxItems: 64, items: COUNT_SCHEMA } };
const LABELS_2_SCHEMA = { type: "array", minItems: 2, maxItems: 2, items: LABEL_SCHEMA };
const LABELS_SCHEMA = { type: "array", minItems: 2, maxItems: 64, items: LABEL_SCHEMA };
const MAX_FISHER_DIMENSION = 5;
const MAX_FISHER_TOTAL = 200;
const MAX_FISHER_WORK = 20_000_000;
const MAX_BINOMIAL_TRIALS = 5_000;
const MAX_LOGLINEAR_LEVELS = 12;

// ---------------------------------------------------------------------------------------------
// Numeric helpers (precise tails; the engine's normalCdf is only ~1e-7 accurate)
// ---------------------------------------------------------------------------------------------

function normalSf(x, H) {
  if (!Number.isFinite(x)) return x > 0 ? 0 : 1;
  const tail = 0.5 * H.gammaQ(0.5, x * x / 2);
  return x >= 0 ? tail : 1 - tail;
}

function pFromZ(z, alternative, H) {
  if (alternative === "less") return Math.min(1, Math.max(0, normalSf(-z, H)));
  if (alternative === "greater") return Math.min(1, Math.max(0, normalSf(z, H)));
  return Math.min(1, Math.max(0, 2 * normalSf(Math.abs(z), H)));
}

function gammaP(a, x, H) {
  if (x <= 0) return 0;
  return x < a + 1 ? H.gammaSeries(a, x) : 1 - H.gammaContinuedFraction(a, x);
}

function poissonCdf(k, lambda, H) {
  if (k < 0) return 0;
  if (lambda === 0) return 1;
  return Math.min(1, Math.max(0, H.gammaQ(k + 1, lambda)));
}

function poissonSf(k, lambda, H) {
  // P(X >= k)
  if (k <= 0) return 1;
  if (lambda === 0) return 0;
  return Math.min(1, Math.max(0, gammaP(k, lambda, H)));
}

const LOG_FACTORIAL = [0];
function logFactorial(n, H) {
  if (n > 200_000) return H.logGamma(n + 1);
  while (LOG_FACTORIAL.length <= n) LOG_FACTORIAL.push(LOG_FACTORIAL[LOG_FACTORIAL.length - 1] + Math.log(LOG_FACTORIAL.length));
  return LOG_FACTORIAL[n];
}

function binomialLogPmf(k, n, p, H) {
  if (p === 0) return k === 0 ? 0 : -Infinity;
  if (p === 1) return k === n ? 0 : -Infinity;
  return H.logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log1p(-p);
}

function binomialPmfVector(n, p, budget, H) {
  const out = new Array(n + 1);
  for (let k = 0; k <= n; k += 1) {
    budget.check();
    out[k] = Math.exp(binomialLogPmf(k, n, p, H));
  }
  return out;
}

/** scipy.stats.binomtest conventions: two-sided = mass of outcomes no more likely than observed. */
function binomialExactP(k, n, p, alternative, budget, H) {
  const pmf = binomialPmfVector(n, p, budget, H);
  let less = 0;
  let greater = 0;
  let twoSided = 0;
  const observed = pmf[k];
  for (let i = 0; i <= n; i += 1) {
    budget.check();
    if (i <= k) less += pmf[i];
    if (i >= k) greater += pmf[i];
    if (pmf[i] <= observed * (1 + 1e-7)) twoSided += pmf[i];
  }
  const pValue = alternative === "less" ? less : alternative === "greater" ? greater : twoSided;
  return { pValue: Math.min(1, Math.max(0, pValue)), less: Math.min(1, less), greater: Math.min(1, greater), twoSided: Math.min(1, twoSided), pmf };
}

function bisectQuantile(target, cdf, low, high, iterations = 200) {
  let lo = low;
  let hi = high;
  for (let i = 0; i < iterations; i += 1) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) < target) lo = mid;
    else hi = mid;
    if (hi - lo <= 1e-15 * Math.max(1, Math.abs(hi))) break;
  }
  return (lo + hi) / 2;
}

function chiSquareQuantile(p, df, H) {
  if (p <= 0) return 0;
  if (p >= 1) H.fail("STAT_INTERNAL", "chi-square quantile probability out of range");
  let high = Math.max(1, df);
  while (1 - H.pFromChiSquare(high, df) < p) {
    high *= 2;
    if (high > 1e12) H.fail("STAT_NUMERIC_FAILURE", "chi-square quantile search exceeded its bracket");
  }
  return bisectQuantile(p, (x) => 1 - H.pFromChiSquare(x, df), 0, high);
}

function betaQuantile(p, a, b, H) {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  return bisectQuantile(p, (x) => H.regularizedBeta(x, a, b), 0, 1);
}

function wilsonInterval(x, n, z) {
  const p = x / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / denominator;
  return { lower: Math.max(0, center - half), upper: Math.min(1, center + half) };
}

function clopperPearson(x, n, confidenceLevel, H) {
  const alpha = 1 - confidenceLevel;
  return {
    lower: x === 0 ? 0 : betaQuantile(alpha / 2, x, n - x + 1, H),
    upper: x === n ? 1 : betaQuantile(1 - alpha / 2, x + 1, n - x, H),
  };
}

function zCritical(confidenceLevel, H) {
  return H.normalInv(1 - (1 - confidenceLevel) / 2);
}

function toEstimates(object) {
  return Object.entries(object).map(([name, value]) => (value === null || ["number", "string", "boolean"].includes(typeof value) ? { name, estimate: value } : { name, value }));
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------------------------
// Input parsing helpers
// ---------------------------------------------------------------------------------------------

function parseCountTable(raw, path, H, { minRows = 2, minColumns = 2, maxRows = 64, maxColumns = 64, exactRows, exactColumns } = {}) {
  if (!Array.isArray(raw)) H.fail("STAT_INVALID_INPUT", `${path} must be an array of integer rows`);
  if (exactRows !== undefined && raw.length !== exactRows) H.fail("STAT_INVALID_INPUT", `${path} must have exactly ${exactRows} rows`);
  if (raw.length < minRows || raw.length > maxRows) H.fail("STAT_INVALID_INPUT", `${path} must have between ${minRows} and ${maxRows} rows`);
  const width = Array.isArray(raw[0]) ? raw[0].length : 0;
  if (exactColumns !== undefined && width !== exactColumns) H.fail("STAT_INVALID_INPUT", `${path} must have exactly ${exactColumns} columns`);
  if (width < minColumns || width > maxColumns) H.fail("STAT_INVALID_INPUT", `${path} must have between ${minColumns} and ${maxColumns} columns`);
  if (raw.length * width > H.LIMITS.maxContingencyCells) H.fail("STAT_LIMIT_EXCEEDED", `${path} exceeds ${H.LIMITS.maxContingencyCells} cells`);
  const table = raw.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== width) H.fail("STAT_INVALID_INPUT", `${path} rows must have equal length`);
    return row.map((cell, columnIndex) => H.integer(cell, 0, Number.MAX_SAFE_INTEGER, `${path}[${rowIndex}][${columnIndex}]`));
  });
  const total = table.flat().reduce((sum, value) => sum + value, 0);
  if (total === 0) H.fail("STAT_INVALID_INPUT", `${path} total must be positive`);
  return table;
}

function parseLabels(values, count, path, prefix, H) {
  if (values === undefined) return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);
  if (!Array.isArray(values) || values.length !== count) H.fail("STAT_INVALID_INPUT", `${path} length must match its table dimension`);
  const parsed = values.map((item, index) => H.label(item, `${prefix} ${index + 1}`, `${path}[${index}]`));
  if (new Set(parsed).size !== parsed.length) H.fail("STAT_INVALID_INPUT", `${path} must be unique`);
  return parsed;
}

function marginals(table) {
  const rowTotals = table.map((row) => row.reduce((sum, value) => sum + value, 0));
  const columnTotals = table[0].map((_, column) => table.reduce((sum, row) => sum + row[column], 0));
  const total = rowTotals.reduce((sum, value) => sum + value, 0);
  return { rowTotals, columnTotals, total };
}

function pearsonChiSquare(table, budget) {
  const { rowTotals, columnTotals, total } = marginals(table);
  let statistic = 0;
  let zeroExpected = 0;
  for (let row = 0; row < table.length; row += 1) {
    for (let column = 0; column < table[0].length; column += 1) {
      budget.check();
      const expected = rowTotals[row] * columnTotals[column] / total;
      if (expected === 0) zeroExpected += 1;
      else statistic += (table[row][column] - expected) ** 2 / expected;
    }
  }
  return { statistic, df: (table.length - 1) * (table[0].length - 1), zeroExpected };
}

function booleanOption(defaultValue) {
  return {
    schema: { type: "boolean" },
    default: defaultValue,
    parse(value, H, path) {
      if (typeof value !== "boolean") H.fail("STAT_INVALID_INPUT", `${path} must be boolean`);
      return value;
    },
  };
}

function enumOption(values, defaultValue) {
  return {
    schema: { type: "string", enum: values },
    default: defaultValue,
    parse(value, H, path) {
      if (!values.includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be one of ${values.join(", ")}`);
      return value;
    },
  };
}

const COLUMN = (key, label, type = "number") => ({ key, label, type });
const CONFIDENCE_NOTE = (options) => `${Math.round(options.confidenceLevel * 100)}% confidence intervals.`;

// ---------------------------------------------------------------------------------------------
// mcnemar_test
// ---------------------------------------------------------------------------------------------

const mcnemarTest = {
  method: "mcnemar_test",
  family: FAMILY,
  analysisModel: MODEL,
  optionKeys: ["confidenceLevel", "pValueMethod", "timeoutMs"],
  customOptions: { continuityCorrection: booleanOption(true) },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["table"],
    properties: { table: TABLE_2X2_SCHEMA, rowLabels: LABELS_2_SCHEMA, columnLabels: LABELS_2_SCHEMA },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["table", "rowLabels", "columnLabels"], "data");
    const table = parseCountTable(data.table, "data.table", H, { exactRows: 2, exactColumns: 2 });
    return {
      table,
      rowLabels: parseLabels(data.rowLabels, 2, "data.rowLabels", "Before", H),
      columnLabels: parseLabels(data.columnLabels, 2, "data.columnLabels", "After", H),
    };
  },
  analyze(parsed, options, budget, H) {
    const [[a, b], [c, d]] = parsed.table;
    const n = a + b + c + d;
    const discordant = b + c;
    if (discordant === 0) H.fail("STAT_DEGENERATE", "McNemar test requires at least one discordant pair");
    const smaller = Math.min(b, c);
    const pmf = binomialPmfVector(discordant, 0.5, budget, H);
    let cdfSmaller = 0;
    for (let k = 0; k <= smaller; k += 1) cdfSmaller += pmf[k];
    const exactP = Math.min(1, 2 * cdfSmaller);
    const midP = Math.min(1, 2 * (cdfSmaller - 0.5 * pmf[smaller]));
    const correctedStatistic = (Math.abs(b - c) - (options.continuityCorrection ? 1 : 0)) ** 2 / discordant;
    const uncorrectedStatistic = (b - c) ** 2 / discordant;
    const chiP = H.pFromChiSquare(correctedStatistic, 1);
    const useExact = options.pValueMethod === "exact" || (options.pValueMethod === "auto" && discordant < 25);
    const primary = useExact ? { method: "exact binomial", statistic: smaller, df: null, pValue: exactP } : { method: options.continuityCorrection ? "continuity-corrected chi-square" : "chi-square", statistic: correctedStatistic, df: 1, pValue: chiP };
    const z = zCritical(options.confidenceLevel, H);
    const p1 = (a + b) / n;
    const p2 = (a + c) / n;
    const difference = p1 - p2;
    const differenceSe = Math.sqrt(Math.max(0, (b + c) - (b - c) ** 2 / n)) / n;
    const discordantOddsRatio = b > 0 && c > 0 ? b / c : null;
    const orSe = discordantOddsRatio === null ? null : Math.sqrt(1 / b + 1 / c);
    const testRows = [
      { method: "exact binomial", statistic: smaller, df: null, pValue: exactP, primary: useExact },
      { method: "exact mid-p", statistic: smaller, df: null, pValue: midP, primary: false },
      { method: options.continuityCorrection ? "continuity-corrected chi-square" : "chi-square", statistic: correctedStatistic, df: 1, pValue: chiP, primary: !useExact },
      ...(options.continuityCorrection ? [{ method: "chi-square (uncorrected)", statistic: uncorrectedStatistic, df: 1, pValue: H.pFromChiSquare(uncorrectedStatistic, 1), primary: false }] : []),
    ];
    const discordantRows = [
      { cell: `${parsed.rowLabels[0]} / ${parsed.columnLabels[1]}`, role: "b (row 1, column 2)", count: b },
      { cell: `${parsed.rowLabels[1]} / ${parsed.columnLabels[0]}`, role: "c (row 2, column 1)", count: c },
    ];
    return {
      sample: { n, discordantPairs: discordant, concordantPairs: a + d },
      estimates: toEstimates({ marginalProportionFirst: p1, marginalProportionSecond: p2, marginalDifference: difference, discordantOddsRatio, exactPValue: exactP, midPValue: midP, chiSquare: correctedStatistic }),
      tests: [{ name: "McNemar test", statistic: primary.statistic, distribution: useExact ? "exact binomial(b+c, 1/2)" : "chi-square", df: primary.df, pValue: primary.pValue, pValueMethod: useExact ? "exact" : "asymptotic", alternative: "two-sided" }],
      confidenceIntervals: [
        { parameter: "marginal proportion difference", level: options.confidenceLevel, lower: difference - z * differenceSe, upper: difference + z * differenceSe, method: "Wald" },
        { parameter: "discordant odds ratio b/c", level: options.confidenceLevel, lower: discordantOddsRatio === null ? null : Math.exp(Math.log(discordantOddsRatio) - z * orSe), upper: discordantOddsRatio === null ? null : Math.exp(Math.log(discordantOddsRatio) + z * orSe), method: discordantOddsRatio === null ? "not estimated because a discordant cell is zero" : "Wald log-odds" },
      ],
      effectSizes: [{ name: "marginal proportion difference", estimate: difference }, { name: "discordant odds ratio", estimate: discordantOddsRatio, ...(discordantOddsRatio === null ? { boundary: "undefined_zero_discordant_cell" } : {}) }],
      assumptions: [{ name: "paired binary observations", status: "verified_by_input_contract" }, { name: "independent pairs", status: "requires_design_review" }, { name: "chi-square approximation", status: discordant < 25 ? "small_discordant_count_prefer_exact" : "acceptable" }],
      diagnostics: [
        { name: "p-value method", status: useExact ? "exact" : "asymptotic", requested: options.pValueMethod, discordantPairs: discordant, rule: "auto selects the exact binomial test when b + c < 25" },
        { name: "continuity correction", status: options.continuityCorrection ? "applied" : "not_applied" },
      ],
      artifacts: [
        H.tableArtifact("McNemar test", `Paired ${parsed.rowLabels.join("/")} versus ${parsed.columnLabels.join("/")} comparison of marginal proportions.`, [COLUMN("method", "Method", "string"), COLUMN("statistic", "Statistic"), COLUMN("df", "df"), COLUMN("pValue", "p"), COLUMN("primary", "Primary", "boolean")], testRows, ["Exact test uses binomial(b + c, 1/2); mid-p subtracts half the observed point mass."]),
        H.tableArtifact("Discordant pairs", "The two discordant cells driving the McNemar statistic.", [COLUMN("cell", "Cell", "string"), COLUMN("role", "Role", "string"), COLUMN("count", "Count")], discordantRows, [], "mcnemar-discordant-table"),
        H.vegaArtifact("mcnemar-discordant-plot", "Discordant pair counts", { data: { values: discordantRows }, mark: { type: "bar" }, encoding: { x: { field: "cell", type: "nominal", title: "Discordant cell" }, y: { field: "count", type: "quantitative", title: "Pairs" }, color: { field: "role", type: "nominal", legend: null }, tooltip: [{ field: "cell" }, { field: "role" }, { field: "count" }] } }),
      ],
    };
  },
  linkage: {
    neededWhen: "Two binary measurements were taken on the same units (before/after, two raters, two tests) and the question is whether the marginal proportions differ.",
    decision: "Decide whether the paired proportion changed, using the discordant pairs only, before interpreting any marginal percentages as evidence of change.",
    mustShow: "Discordant cell counts b and c, the exact and chi-square p-values with the primary method flagged, and the marginal difference with its interval.",
    userGoal: "Report whether a within-subject binary outcome shifted between two conditions without treating the paired samples as independent groups.",
    nextActions: [
      { trigger: "discordant-pairs-below-25", action: "prefer-exact-binomial-result", reason: "The chi-square approximation is unreliable when few pairs change state; the exact binomial p-value is the defensible one." },
      { trigger: "marginal-difference-interval-excludes-zero", action: "report-paired-proportion-change", reason: "A shift in the marginal proportion with an interval that excludes zero supports a change claim on the paired scale." },
      { trigger: "more-than-two-conditions", action: "run-cochran-q-test", reason: "McNemar handles two paired conditions; three or more repeated binary conditions require Cochran's Q." },
    ],
  },
  fixture: { data: { table: [[59, 6], [16, 80]], rowLabels: ["Positive before", "Negative before"], columnLabels: ["Positive after", "Negative after"] }, options: { pValueMethod: "auto" } },
  matlabParity: { taxonomyIds: ["matlab.stats.probability-hypothesis"] },
  coverage: {
    implementedBoundary: "2×2 paired table only: exact binomial, mid-p, and (continuity-corrected) chi-square McNemar tests with Wald intervals for the marginal difference and discordant odds ratio.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["exact p-value", "continuity-corrected chi-square statistic and p-value", "uncorrected chi-square statistic"], excludedOutputs: ["mid-p value", "marginal difference Wald interval", "discordant odds ratio interval"] },
    diagnostic: { level: "method-specific-partial", emitted: ["p-value method selection", "continuity correction flag", "discordant pair count"], limitations: ["no Bowker generalization to k×k tables", "no cluster-adjusted variant"] },
    knownGaps: ["Bowker symmetry test for larger square tables", "exact confidence interval for the marginal difference"],
  },
};

// ---------------------------------------------------------------------------------------------
// cochran_q_test
// ---------------------------------------------------------------------------------------------

const cochranQTest = {
  method: "cochran_q_test",
  family: FAMILY,
  analysisModel: MODEL,
  optionKeys: ["confidenceLevel", "timeoutMs"],
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["responses"],
    properties: {
      responses: { type: "array", minItems: 4, maxItems: 10000, items: { type: "array", minItems: 2, maxItems: 64, items: { type: "integer", enum: [0, 1] } } },
      conditionLabels: LABELS_SCHEMA,
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["responses", "conditionLabels"], "data");
    if (!Array.isArray(data.responses) || data.responses.length < 4 || data.responses.length > 10000) H.fail("STAT_INVALID_INPUT", "data.responses must contain between 4 and 10000 subject rows");
    const k = Array.isArray(data.responses[0]) ? data.responses[0].length : 0;
    if (k < 2 || k > H.LIMITS.maxGroups) H.fail("STAT_INVALID_INPUT", `data.responses rows must contain between 2 and ${H.LIMITS.maxGroups} conditions`);
    const responses = data.responses.map((row, subject) => {
      if (!Array.isArray(row) || row.length !== k) H.fail("STAT_INVALID_INPUT", "data.responses rows must have equal length");
      return row.map((value, condition) => H.integer(value, 0, 1, `data.responses[${subject}][${condition}]`));
    });
    return { responses, conditionLabels: parseLabels(data.conditionLabels, k, "data.conditionLabels", "Condition", H) };
  },
  analyze(parsed, options, budget, H) {
    const k = parsed.conditionLabels.length;
    const n = parsed.responses.length;
    const columnTotals = Array(k).fill(0);
    let rowSquareSum = 0;
    let total = 0;
    let uninformative = 0;
    for (const row of parsed.responses) {
      budget.check();
      let rowSum = 0;
      row.forEach((value, index) => { columnTotals[index] += value; rowSum += value; });
      rowSquareSum += rowSum * rowSum;
      total += rowSum;
      if (rowSum === 0 || rowSum === k) uninformative += 1;
    }
    const denominator = k * total - rowSquareSum;
    if (!(denominator > 0)) H.fail("STAT_DEGENERATE", "Cochran Q is undefined because every subject responded identically across conditions");
    const columnSquareSum = columnTotals.reduce((sum, value) => sum + value * value, 0);
    const statistic = (k - 1) * (k * columnSquareSum - total * total) / denominator;
    const df = k - 1;
    const pValue = H.pFromChiSquare(statistic, df);
    const z = zCritical(options.confidenceLevel, H);
    const conditionRows = parsed.conditionLabels.map((condition, index) => {
      const ci = wilsonInterval(columnTotals[index], n, z);
      return { condition, successes: columnTotals[index], subjects: n, proportion: columnTotals[index] / n, lower: ci.lower, upper: ci.upper };
    });
    const proportions = conditionRows.map((row) => row.proportion);
    return {
      sample: { subjects: n, conditions: k, informativeSubjects: n - uninformative },
      estimates: toEstimates({ columnTotals, proportions, statistic, df }),
      tests: [{ name: "Cochran Q test", statistic, distribution: "chi-square approximation", df, pValue }],
      confidenceIntervals: conditionRows.map((row) => ({ parameter: `proportion ${row.condition}`, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: "Wilson score" })),
      effectSizes: [{ name: "proportion range across conditions", estimate: Math.max(...proportions) - Math.min(...proportions) }],
      assumptions: [{ name: "complete binary matrix", status: "verified_by_input_contract" }, { name: "independent subjects", status: "requires_design_review" }, { name: "chi-square approximation", status: n - uninformative < 24 ? "small_informative_sample_asymptotic_only" : "asymptotic" }],
      diagnostics: [{ name: "uninformative subjects", status: "reported", count: uninformative, detail: "subjects with identical responses across every condition contribute nothing to Q but are retained in the marginal proportions" }, { name: "post hoc boundary", status: "not_established", detail: "no pairwise McNemar follow-ups are computed here" }],
      artifacts: [
        H.tableArtifact("Cochran Q test", "Omnibus test that binary success proportions are equal across matched conditions.", [COLUMN("statistic", "Q"), COLUMN("df", "df"), COLUMN("pValue", "p"), COLUMN("subjects", "Subjects"), COLUMN("conditions", "Conditions")], [{ statistic, df, pValue, subjects: n, conditions: k }]),
        H.tableArtifact("Condition success proportions", CONFIDENCE_NOTE(options), [COLUMN("condition", "Condition", "string"), COLUMN("successes", "Successes"), COLUMN("subjects", "Subjects"), COLUMN("proportion", "Proportion"), COLUMN("lower", "CI lower"), COLUMN("upper", "CI upper")], conditionRows, ["Wilson score intervals per condition; they ignore the within-subject pairing."], "cochran-q-proportion-table"),
        H.vegaArtifact("cochran-q-proportion-plot", "Success proportion by condition", { data: { values: conditionRows }, layer: [{ mark: { type: "rule", strokeWidth: 2 }, encoding: { x: { field: "condition", type: "nominal", title: "Condition" }, y: { field: "lower", type: "quantitative", title: "Success proportion", scale: { domain: [0, 1] } }, y2: { field: "upper" } } }, { mark: { type: "point", filled: true, size: 90 }, encoding: { x: { field: "condition", type: "nominal" }, y: { field: "proportion", type: "quantitative" }, tooltip: [{ field: "condition" }, { field: "proportion", format: ".4f" }, { field: "lower", format: ".4f" }, { field: "upper", format: ".4f" }] } }] }),
      ],
    };
  },
  linkage: {
    neededWhen: "The same subjects produced a binary outcome under three or more conditions and you need one omnibus test of whether the success rates differ.",
    decision: "Decide whether any condition differs in success probability before running paired follow-ups, avoiding inflated error from many McNemar tests.",
    mustShow: "The Q statistic with its degrees of freedom and p-value, per-condition proportions with intervals, and the number of subjects that were uninformative.",
    userGoal: "Establish an omnibus difference in repeated binary outcomes on matched subjects before locating which conditions differ.",
    nextActions: [
      { trigger: "omnibus-significant", action: "run-pairwise-mcnemar-with-correction", reason: "A significant Q only says some conditions differ; paired McNemar tests with multiplicity control locate the differences." },
      { trigger: "many-uninformative-subjects", action: "review-ceiling-or-floor-effects", reason: "Subjects with identical responses everywhere suggest the measure is saturated and the effective sample is smaller than reported." },
      { trigger: "informative-subjects-below-24", action: "treat-p-value-as-approximate", reason: "The chi-square approximation to Q is unreliable with few informative subjects; an exact permutation version would be needed." },
    ],
  },
  fixture: { data: { responses: [[1, 1, 0], [1, 0, 0], [1, 1, 1], [0, 0, 0], [1, 1, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [1, 0, 0], [1, 1, 1], [1, 0, 0], [1, 1, 0]], conditionLabels: ["Drug A", "Drug B", "Placebo"] } },
  matlabParity: { taxonomyIds: ["matlab.stats.probability-hypothesis"] },
  coverage: {
    implementedBoundary: "Complete subjects × conditions binary matrix; asymptotic chi-square Cochran Q with Wilson intervals per condition and no post hoc contrasts.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["Q statistic", "degrees of freedom", "p-value"], excludedOutputs: ["Wilson intervals", "uninformative subject count"] },
    diagnostic: { level: "method-specific-partial", emitted: ["uninformative subject count", "post hoc boundary"], limitations: ["no exact permutation p-value", "no pairwise follow-up tests"] },
    knownGaps: ["exact Cochran Q for small samples", "pairwise McNemar post hoc with multiplicity control"],
  },
};

// ---------------------------------------------------------------------------------------------
// cochran_armitage_trend_test
// ---------------------------------------------------------------------------------------------

const cochranArmitageTrendTest = {
  method: "cochran_armitage_trend_test",
  family: FAMILY,
  analysisModel: MODEL,
  optionKeys: ["confidenceLevel", "alternative", "timeoutMs"],
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["groups"],
    properties: {
      groups: { type: "array", minItems: 3, maxItems: 64, items: { type: "object", additionalProperties: false, required: ["events", "total"], properties: { name: LABEL_SCHEMA, events: COUNT_SCHEMA, total: { type: "integer", minimum: 1 }, score: { type: "number" } } } },
      outcomeLabel: LABEL_SCHEMA,
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["groups", "outcomeLabel"], "data");
    if (!Array.isArray(data.groups) || data.groups.length < 3 || data.groups.length > H.LIMITS.maxGroups) H.fail("STAT_INVALID_INPUT", `data.groups must contain between 3 and ${H.LIMITS.maxGroups} ordered groups`);
    const names = new Set();
    const groups = data.groups.map((raw, index) => {
      const path = `data.groups[${index}]`;
      const group = H.assertObject(raw, path);
      H.assertKeys(group, ["name", "events", "total", "score"], path);
      const name = H.label(group.name, `Level ${index + 1}`, `${path}.name`);
      if (names.has(name)) H.fail("STAT_INVALID_INPUT", `duplicate group name: ${name}`);
      names.add(name);
      const total = H.integer(group.total, 1, Number.MAX_SAFE_INTEGER, `${path}.total`);
      const events = H.integer(group.events, 0, total, `${path}.events`);
      const score = group.score === undefined ? index : H.finiteNumber(group.score, `${path}.score`);
      return { name, events, total, score };
    });
    if (new Set(groups.map((group) => group.score)).size < 2) H.fail("STAT_INVALID_INPUT", "data.groups scores must not all be equal");
    return { groups, outcomeLabel: H.label(data.outcomeLabel, "Event", "data.outcomeLabel") };
  },
  analyze(parsed, options, budget, H) {
    const groups = parsed.groups;
    const N = groups.reduce((sum, group) => sum + group.total, 0);
    const R = groups.reduce((sum, group) => sum + group.events, 0);
    const pBar = R / N;
    if (pBar === 0 || pBar === 1) H.fail("STAT_DEGENERATE", "trend test is undefined when every observation shares the same outcome");
    let weightedScore = 0;
    let weightedScoreSquare = 0;
    let t = 0;
    for (const group of groups) {
      budget.check();
      weightedScore += group.total * group.score;
      weightedScoreSquare += group.total * group.score * group.score;
      t += group.score * (group.events - group.total * pBar);
    }
    const scoreSpread = weightedScoreSquare - weightedScore * weightedScore / N;
    const variance = pBar * (1 - pBar) * scoreSpread;
    if (!(variance > 0)) H.fail("STAT_DEGENERATE", "trend test variance is zero");
    const z = t / Math.sqrt(variance);
    const trendChiSquare = z * z;
    const pValue = pFromZ(z, options.alternative, H);
    const table = groups.map((group) => [group.events, group.total - group.events]);
    const overall = pearsonChiSquare(table, budget);
    const departure = Math.max(0, overall.statistic - trendChiSquare);
    const departureDf = groups.length - 2;
    const slope = t / scoreSpread;
    const meanScore = weightedScore / N;
    const zc = zCritical(options.confidenceLevel, H);
    const rows = groups.map((group) => {
      const ci = wilsonInterval(group.events, group.total, zc);
      return { group: group.name, score: group.score, events: group.events, total: group.total, proportion: group.events / group.total, lower: ci.lower, upper: ci.upper, fittedProportion: pBar + slope * (group.score - meanScore) };
    });
    return {
      sample: { groups: groups.length, n: N, events: R },
      estimates: toEstimates({ statisticT: t, variance, z, trendChiSquare, slopePerScoreUnit: slope, pooledProportion: pBar, overallChiSquare: overall.statistic, departureChiSquare: departure }),
      tests: [
        { name: "Cochran-Armitage trend test", statistic: z, distribution: "normal", pValue, alternative: options.alternative, chiSquare: trendChiSquare },
        { name: "Pearson chi-square (overall association)", statistic: overall.statistic, distribution: "chi-square", df: overall.df, pValue: H.pFromChiSquare(overall.statistic, overall.df) },
        { name: "Departure from linear trend", statistic: departure, distribution: "chi-square", df: departureDf, pValue: departureDf > 0 ? H.pFromChiSquare(departure, departureDf) : null },
      ],
      confidenceIntervals: rows.map((row) => ({ parameter: `proportion ${row.group}`, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: "Wilson score" })),
      effectSizes: [{ name: "proportion change per score unit", estimate: slope }],
      assumptions: [{ name: "independent binomial groups", status: "requires_design_review" }, { name: "ordinal scores reflect the hypothesized ordering", status: "requires_domain_review" }, { name: "normal approximation", status: Math.min(R, N - R) < 10 ? "small_event_count_asymptotic_only" : "asymptotic" }],
      diagnostics: [{ name: "scores", status: "reported", values: groups.map((group) => group.score), source: groups.every((group, index) => group.score === index) ? "default equally spaced" : "supplied" }, { name: "linearity", status: departureDf > 0 ? "screened_by_departure_test" : "not_testable_with_three_or_fewer_groups", departureChiSquare: departure, df: departureDf }],
      artifacts: [
        H.tableArtifact("Cochran-Armitage trend test", `Linear trend in the proportion of ${parsed.outcomeLabel} across ordered groups.`, [COLUMN("test", "Test", "string"), COLUMN("statistic", "Statistic"), COLUMN("df", "df"), COLUMN("pValue", "p")], [{ test: "trend z", statistic: z, df: null, pValue }, { test: "trend chi-square", statistic: trendChiSquare, df: 1, pValue: H.pFromChiSquare(trendChiSquare, 1) }, { test: "overall chi-square", statistic: overall.statistic, df: overall.df, pValue: H.pFromChiSquare(overall.statistic, overall.df) }, { test: "departure from trend", statistic: departure, df: departureDf, pValue: departureDf > 0 ? H.pFromChiSquare(departure, departureDf) : null }], ["Trend variance uses the pooled proportion (no continuity correction)."]),
        H.tableArtifact("Group proportions", CONFIDENCE_NOTE(options), [COLUMN("group", "Group", "string"), COLUMN("score", "Score"), COLUMN("events", "Events"), COLUMN("total", "Total"), COLUMN("proportion", "Proportion"), COLUMN("lower", "CI lower"), COLUMN("upper", "CI upper"), COLUMN("fittedProportion", "Fitted trend")], rows, [], "trend-proportion-table"),
        H.vegaArtifact("trend-proportion-plot", `Proportion of ${parsed.outcomeLabel} by ordered score`, { data: { values: rows }, layer: [{ mark: { type: "line", color: "#A36D47", strokeDash: [5, 4] }, encoding: { x: { field: "score", type: "quantitative", title: "Score" }, y: { field: "fittedProportion", type: "quantitative", title: "Proportion" } } }, { mark: { type: "rule", strokeWidth: 2 }, encoding: { x: { field: "score", type: "quantitative" }, y: { field: "lower", type: "quantitative", scale: { domain: [0, 1] } }, y2: { field: "upper" } } }, { mark: { type: "point", filled: true, size: 90 }, encoding: { x: { field: "score", type: "quantitative" }, y: { field: "proportion", type: "quantitative" }, tooltip: [{ field: "group" }, { field: "score" }, { field: "proportion", format: ".4f" }, { field: "events" }, { field: "total" }] } }] }),
      ],
    };
  },
  linkage: {
    neededWhen: "Binary outcomes are recorded across ordered exposure levels (dose, grade, age band) and the question is whether the event proportion rises or falls monotonically.",
    decision: "Decide whether an ordered trend in proportions exists, and whether a linear-trend summary is adequate or the pattern departs from linearity.",
    mustShow: "The trend z statistic with direction, per-level proportions with intervals, the chosen scores, and the departure-from-trend test.",
    userGoal: "Support a dose-response or ordered-risk claim with a single trend statistic rather than many pairwise comparisons.",
    nextActions: [
      { trigger: "departure-from-trend-significant", action: "model-proportions-nonlinearly", reason: "A significant departure means one slope misdescribes the levels; logistic regression with flexible terms or per-level contrasts is needed." },
      { trigger: "trend-significant-with-adequate-linearity", action: "report-slope-per-score-unit", reason: "When the linear trend is adequate the slope per score unit is the interpretable dose-response summary." },
      { trigger: "scores-defaulted", action: "confirm-score-spacing-with-domain", reason: "Equally spaced default scores encode an assumption about the exposure scale that should be checked against the design." },
    ],
  },
  fixture: { data: { groups: [{ name: "0 mg", events: 4, total: 40, score: 0 }, { name: "10 mg", events: 7, total: 40, score: 10 }, { name: "20 mg", events: 12, total: 40, score: 20 }, { name: "40 mg", events: 19, total: 40, score: 40 }], outcomeLabel: "tumor" } },
  matlabParity: { taxonomyIds: ["matlab.stats.probability-hypothesis"] },
  coverage: {
    implementedBoundary: "2×k counts with numeric scores; asymptotic Armitage trend z, overall Pearson chi-square, departure-from-trend chi-square, and a weighted linear slope.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["trend z statistic", "trend p-value", "overall chi-square", "departure chi-square"], excludedOutputs: ["Wilson intervals", "fitted trend proportions"] },
    diagnostic: { level: "method-specific-partial", emitted: ["score provenance", "linearity screen"], limitations: ["no exact permutation trend test", "no continuity correction variant"] },
    knownGaps: ["exact conditional trend test", "stratified (adjusted) trend test"],
  },
};

// ---------------------------------------------------------------------------------------------
// mantel_haenszel_test
// ---------------------------------------------------------------------------------------------

const mantelHaenszelTest = {
  method: "mantel_haenszel_test",
  family: FAMILY,
  analysisModel: MODEL,
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: { continuityCorrection: booleanOption(true) },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["strata"],
    properties: {
      strata: { type: "array", minItems: 2, maxItems: 500, items: { type: "object", additionalProperties: false, required: ["table"], properties: { name: LABEL_SCHEMA, table: TABLE_2X2_SCHEMA } } },
      rowLabels: LABELS_2_SCHEMA,
      columnLabels: LABELS_2_SCHEMA,
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["strata", "rowLabels", "columnLabels"], "data");
    if (!Array.isArray(data.strata) || data.strata.length < 2 || data.strata.length > 500) H.fail("STAT_INVALID_INPUT", "data.strata must contain between 2 and 500 strata");
    const names = new Set();
    const strata = data.strata.map((raw, index) => {
      const path = `data.strata[${index}]`;
      const stratum = H.assertObject(raw, path);
      H.assertKeys(stratum, ["name", "table"], path);
      const name = H.label(stratum.name, `Stratum ${index + 1}`, `${path}.name`);
      if (names.has(name)) H.fail("STAT_INVALID_INPUT", `duplicate stratum name: ${name}`);
      names.add(name);
      return { name, table: parseCountTable(stratum.table, `${path}.table`, H, { exactRows: 2, exactColumns: 2 }) };
    });
    return { strata, rowLabels: parseLabels(data.rowLabels, 2, "data.rowLabels", "Exposure", H), columnLabels: parseLabels(data.columnLabels, 2, "data.columnLabels", "Outcome", H) };
  },
  analyze(parsed, options, budget, H) {
    const z = zCritical(options.confidenceLevel, H);
    let sumA = 0;
    let sumE = 0;
    let sumV = 0;
    let R = 0;
    let S = 0;
    let sumPR = 0;
    let sumPSQR = 0;
    let sumQS = 0;
    let rrNumerator = 0;
    let rrDenominator = 0;
    let rrVarianceNumerator = 0;
    const strataRows = parsed.strata.map((stratum) => {
      budget.check();
      const [[a, b], [c, d]] = stratum.table;
      const n = a + b + c + d;
      const r1 = a + b;
      const r2 = c + d;
      const c1 = a + c;
      const c2 = b + d;
      const expected = r1 * c1 / n;
      const variance = n > 1 ? r1 * r2 * c1 * c2 / (n * n * (n - 1)) : 0;
      const Ri = a * d / n;
      const Si = b * c / n;
      const Pi = (a + d) / n;
      const Qi = (b + c) / n;
      sumA += a;
      sumE += expected;
      sumV += variance;
      R += Ri;
      S += Si;
      sumPR += Pi * Ri;
      sumPSQR += Pi * Si + Qi * Ri;
      sumQS += Qi * Si;
      rrNumerator += a * r2 / n;
      rrDenominator += c * r1 / n;
      rrVarianceNumerator += (r1 * r2 * c1 - a * c * n) / (n * n);
      const oddsRatio = b * c > 0 ? a * d / (b * c) : null;
      const orSe = a > 0 && b > 0 && c > 0 && d > 0 ? Math.sqrt(1 / a + 1 / b + 1 / c + 1 / d) : null;
      return { stratum: stratum.name, a, b, c, d, n, expectedA: expected, varianceA: variance, oddsRatio, orLower: orSe === null ? null : Math.exp(Math.log(oddsRatio) - z * orSe), orUpper: orSe === null ? null : Math.exp(Math.log(oddsRatio) + z * orSe), riskRatio: c > 0 && r1 > 0 && r2 > 0 ? (a / r1) / (c / r2) : null, weightPercent: 0 };
    });
    if (!(sumV > 0)) H.fail("STAT_DEGENERATE", "Mantel-Haenszel variance is zero; no stratum carries information about the association");
    const deviation = Math.abs(sumA - sumE);
    const correctedStatistic = Math.max(0, deviation - (options.continuityCorrection ? 0.5 : 0)) ** 2 / sumV;
    const uncorrectedStatistic = deviation ** 2 / sumV;
    const primaryStatistic = options.continuityCorrection ? correctedStatistic : uncorrectedStatistic;
    const pValue = H.pFromChiSquare(primaryStatistic, 1);
    const pooledOddsRatio = S > 0 && R > 0 ? R / S : null;
    const pooledLogOrSe = pooledOddsRatio === null ? null : Math.sqrt(sumPR / (2 * R * R) + sumPSQR / (2 * R * S) + sumQS / (2 * S * S));
    const pooledLower = pooledOddsRatio === null ? null : Math.exp(Math.log(pooledOddsRatio) - z * pooledLogOrSe);
    const pooledUpper = pooledOddsRatio === null ? null : Math.exp(Math.log(pooledOddsRatio) + z * pooledLogOrSe);
    const pooledRiskRatio = rrDenominator > 0 && rrNumerator > 0 ? rrNumerator / rrDenominator : null;
    const pooledLogRrSe = pooledRiskRatio === null ? null : Math.sqrt(rrVarianceNumerator / (rrNumerator * rrDenominator));
    for (const row of strataRows) row.weightPercent = S > 0 ? 100 * (row.b * row.c / row.n) / S : 0;
    // Breslow-Day homogeneity (statsmodels parameterization) with Tarone adjustment
    let breslowDay = null;
    if (pooledOddsRatio !== null) {
      let statistic = 0;
      let adjustNumerator = 0;
      let adjustDenominator = 0;
      let evaluated = 0;
      for (const row of strataRows) {
        budget.check();
        const r1 = row.a + row.b;
        const c1 = row.a + row.c;
        const dma = row.d - row.a;
        const qa = 1 - pooledOddsRatio;
        const qb = pooledOddsRatio * (r1 + c1) + dma;
        const qc = -pooledOddsRatio * r1 * c1;
        let fitted;
        if (Math.abs(qa) < 1e-12) fitted = -qc / qb;
        else fitted = (-qb + Math.sqrt(Math.max(0, qb * qb - 4 * qa * qc))) / (2 * qa);
        const cells = [fitted, r1 - fitted, c1 - fitted, dma + fitted];
        if (!cells.every((value) => Number.isFinite(value) && value > 0)) continue;
        const fittedVariance = 1 / (1 / cells[0] + 1 / cells[1] + 1 / cells[2] + 1 / cells[3]);
        statistic += (row.a - fitted) ** 2 / fittedVariance;
        adjustNumerator += row.a - fitted;
        adjustDenominator += fittedVariance;
        evaluated += 1;
      }
      if (evaluated >= 2) {
        const tarone = Math.max(0, statistic - adjustNumerator ** 2 / adjustDenominator);
        const df = evaluated - 1;
        breslowDay = { status: "evaluated", statistic, taroneStatistic: tarone, df, pValue: H.pFromChiSquare(statistic, df), taronePValue: H.pFromChiSquare(tarone, df), strataEvaluated: evaluated, strataSkipped: strataRows.length - evaluated };
      } else breslowDay = { status: "not_evaluated", reason: "fewer than two strata have positive fitted cells under the pooled odds ratio" };
    } else breslowDay = { status: "not_evaluated", reason: "pooled odds ratio is zero or infinite" };
    const forestRows = [
      ...strataRows.filter((row) => row.oddsRatio !== null && row.orLower !== null).map((row) => ({ label: row.stratum, rowType: "stratum", oddsRatio: row.oddsRatio, lower: row.orLower, upper: row.orUpper, weightPercent: row.weightPercent })),
      ...(pooledOddsRatio === null ? [] : [{ label: "Mantel-Haenszel pooled", rowType: "pooled", oddsRatio: pooledOddsRatio, lower: pooledLower, upper: pooledUpper, weightPercent: 100 }]),
    ];
    return {
      sample: { strata: parsed.strata.length, n: strataRows.reduce((sum, row) => sum + row.n, 0), eventsInFirstRow: sumA },
      estimates: toEstimates({ pooledOddsRatio, pooledLogOddsRatioSe: pooledLogOrSe, pooledRiskRatio, pooledLogRiskRatioSe: pooledLogRrSe, observedA: sumA, expectedA: sumE, varianceA: sumV, correctedStatistic, uncorrectedStatistic, breslowDay, strata: strataRows }),
      tests: [
        { name: "Mantel-Haenszel chi-square", statistic: primaryStatistic, distribution: "chi-square", df: 1, pValue, continuityCorrection: options.continuityCorrection },
        ...(breslowDay.status === "evaluated" ? [{ name: "Breslow-Day homogeneity of odds ratios", statistic: breslowDay.statistic, distribution: "chi-square", df: breslowDay.df, pValue: breslowDay.pValue }, { name: "Breslow-Day with Tarone adjustment", statistic: breslowDay.taroneStatistic, distribution: "chi-square", df: breslowDay.df, pValue: breslowDay.taronePValue }] : []),
      ],
      confidenceIntervals: [
        { parameter: "Mantel-Haenszel pooled odds ratio", level: options.confidenceLevel, lower: pooledLower, upper: pooledUpper, method: pooledOddsRatio === null ? "not estimated because the pooled odds ratio is zero or infinite" : "Robins-Breslow-Greenland log-odds" },
        { parameter: "Mantel-Haenszel pooled risk ratio", level: options.confidenceLevel, lower: pooledRiskRatio === null ? null : Math.exp(Math.log(pooledRiskRatio) - z * pooledLogRrSe), upper: pooledRiskRatio === null ? null : Math.exp(Math.log(pooledRiskRatio) + z * pooledLogRrSe), method: pooledRiskRatio === null ? "not estimated because a pooled risk is zero" : "Greenland-Robins log-risk" },
      ],
      effectSizes: [{ name: "pooled odds ratio", estimate: pooledOddsRatio, ...(pooledOddsRatio === null ? { boundary: "zero_or_infinite" } : {}) }, { name: "pooled risk ratio", estimate: pooledRiskRatio, ...(pooledRiskRatio === null ? { boundary: "zero_or_infinite" } : {}) }],
      assumptions: [{ name: "independent 2×2 strata", status: "requires_design_review" }, { name: "common odds ratio across strata", status: breslowDay.status === "evaluated" ? "diagnostic_attached" : "not_established" }, { name: "chi-square approximation", status: sumV < 5 ? "small_total_variance_asymptotic_only" : "asymptotic" }],
      diagnostics: [
        { name: "continuity correction", status: options.continuityCorrection ? "applied" : "not_applied", corrected: correctedStatistic, uncorrected: uncorrectedStatistic },
        { name: "homogeneity", ...breslowDay, method: "Breslow-Day expected first cell under the pooled odds ratio; Tarone adjustment reported alongside" },
        { name: "sparse strata", status: strataRows.some((row) => row.oddsRatio === null) ? "present" : "absent", count: strataRows.filter((row) => row.oddsRatio === null).length, detail: "strata with a zero discordant product still contribute to the pooled estimate but have no stratum-specific odds ratio" },
      ],
      artifacts: [
        H.tableArtifact("Mantel-Haenszel stratified analysis", `Pooled association between ${parsed.rowLabels.join("/")} and ${parsed.columnLabels.join("/")} across ${parsed.strata.length} strata.`, [COLUMN("quantity", "Quantity", "string"), COLUMN("estimate", "Estimate"), COLUMN("lower", "CI lower"), COLUMN("upper", "CI upper"), COLUMN("statistic", "Statistic"), COLUMN("df", "df"), COLUMN("pValue", "p")], [
          { quantity: "MH chi-square", estimate: null, lower: null, upper: null, statistic: primaryStatistic, df: 1, pValue },
          { quantity: "pooled odds ratio", estimate: pooledOddsRatio, lower: pooledLower, upper: pooledUpper, statistic: null, df: null, pValue: null },
          { quantity: "pooled risk ratio", estimate: pooledRiskRatio, lower: pooledRiskRatio === null ? null : Math.exp(Math.log(pooledRiskRatio) - z * pooledLogRrSe), upper: pooledRiskRatio === null ? null : Math.exp(Math.log(pooledRiskRatio) + z * pooledLogRrSe), statistic: null, df: null, pValue: null },
          ...(breslowDay.status === "evaluated" ? [{ quantity: "Breslow-Day homogeneity", estimate: null, lower: null, upper: null, statistic: breslowDay.statistic, df: breslowDay.df, pValue: breslowDay.pValue }, { quantity: "Breslow-Day (Tarone)", estimate: null, lower: null, upper: null, statistic: breslowDay.taroneStatistic, df: breslowDay.df, pValue: breslowDay.taronePValue }] : []),
        ], [`${Math.round(options.confidenceLevel * 100)}% Robins-Breslow-Greenland interval for the odds ratio; ${options.continuityCorrection ? "continuity-corrected" : "uncorrected"} chi-square.`]),
        H.tableArtifact("Stratum-specific tables", "Cell counts, expected first cell, stratum odds ratios with Woolf intervals, and Mantel-Haenszel weights.", [COLUMN("stratum", "Stratum", "string"), COLUMN("a", "a"), COLUMN("b", "b"), COLUMN("c", "c"), COLUMN("d", "d"), COLUMN("n", "n"), COLUMN("expectedA", "E[a]"), COLUMN("varianceA", "Var[a]"), COLUMN("oddsRatio", "OR"), COLUMN("orLower", "OR lower"), COLUMN("orUpper", "OR upper"), COLUMN("riskRatio", "RR"), COLUMN("weightPercent", "MH weight (%)")], strataRows, [], "mantel-haenszel-strata-table"),
        H.tableArtifact("Odds ratio forest rows", "Estimable stratum odds ratios plus the pooled Mantel-Haenszel estimate.", [COLUMN("label", "Stratum", "string"), COLUMN("rowType", "Row type", "string"), COLUMN("oddsRatio", "OR"), COLUMN("lower", "CI lower"), COLUMN("upper", "CI upper"), COLUMN("weightPercent", "Weight (%)")], forestRows, [], "mantel-haenszel-forest-table"),
        H.vegaArtifact("mantel-haenszel-forest", "Stratum and pooled odds ratios", { data: { values: forestRows }, layer: [{ mark: { type: "rule", strokeWidth: 2 }, encoding: { y: { field: "label", type: "ordinal", sort: null, title: null }, x: { field: "lower", type: "quantitative", scale: { type: "log" }, title: "Odds ratio" }, x2: { field: "upper" }, color: { field: "rowType", type: "nominal", legend: null } } }, { mark: { type: "point", filled: true, size: 90 }, encoding: { y: { field: "label", type: "ordinal", sort: null }, x: { field: "oddsRatio", type: "quantitative", scale: { type: "log" } }, color: { field: "rowType", type: "nominal", legend: null }, tooltip: [{ field: "label" }, { field: "oddsRatio", format: ".4g" }, { field: "lower", format: ".4g" }, { field: "upper", format: ".4g" }, { field: "weightPercent", format: ".3g" }] } }, { mark: { type: "rule", strokeDash: [4, 4], color: "#777" }, encoding: { x: { datum: 1, scale: { type: "log" } } } }] }),
      ],
    };
  },
  linkage: {
    neededWhen: "A 2×2 exposure-outcome association must be summarized across strata of a confounder (site, age band, matched set) with a single adjusted estimate.",
    decision: "Decide whether an adjusted association exists and whether one pooled odds ratio is a fair summary or the strata disagree.",
    mustShow: "The pooled Mantel-Haenszel odds ratio with interval, the chi-square test, the Breslow-Day homogeneity result, and stratum-level tables.",
    userGoal: "Report a confounder-adjusted association from stratified 2×2 tables and justify pooling with a homogeneity check.",
    nextActions: [
      { trigger: "breslow-day-significant", action: "report-stratum-specific-odds-ratios", reason: "Heterogeneous odds ratios mean a pooled estimate hides effect modification; the stratum estimates are the honest summary." },
      { trigger: "pooled-interval-excludes-one", action: "report-adjusted-association", reason: "A pooled interval excluding one supports an association after adjusting for the stratifying variable." },
      { trigger: "sparse-strata-present", action: "consider-conditional-logistic-model", reason: "Many strata with zero cells make Woolf intervals unavailable and favor a conditional likelihood model." },
    ],
  },
  fixture: { data: { strata: [{ name: "Site A", table: [[12, 18], [6, 24]] }, { name: "Site B", table: [[20, 15], [9, 26]] }, { name: "Site C", table: [[8, 22], [5, 25]] }], rowLabels: ["Exposed", "Unexposed"], columnLabels: ["Case", "Control"] } },
  matlabParity: { taxonomyIds: ["matlab.stats.probability-hypothesis"] },
  coverage: {
    implementedBoundary: "Stratified 2×2 tables: Mantel-Haenszel chi-square, pooled odds ratio with Robins-Breslow-Greenland interval, pooled risk ratio with Greenland-Robins interval, and Breslow-Day homogeneity with Tarone adjustment.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["pooled odds ratio", "pooled log-odds interval", "Mantel-Haenszel chi-square with and without correction", "Breslow-Day and Tarone statistics", "pooled risk ratio"], excludedOutputs: ["pooled risk ratio interval", "stratum Woolf intervals"] },
    diagnostic: { level: "method-specific-partial", emitted: ["homogeneity test", "sparse strata count", "continuity correction"], limitations: ["no exact conditional pooled odds ratio", "no Mantel-Haenszel for r×c strata"] },
    knownGaps: ["exact stratified inference", "generalized Cochran-Mantel-Haenszel for larger tables"],
  },
};

// ---------------------------------------------------------------------------------------------
// fisher_exact_rxc (Freeman-Halton)
// ---------------------------------------------------------------------------------------------

function freemanHalton(table, budget, H) {
  const { rowTotals, columnTotals, total } = marginals(table);
  const r = table.length;
  const c = table[0].length;
  const SCALE = 1e10;
  const logConstant = rowTotals.reduce((sum, value) => sum + logFactorial(value, H), 0) + columnTotals.reduce((sum, value) => sum + logFactorial(value, H), 0) - logFactorial(total, H);
  let observedScaled = 0;
  for (const row of table) for (const cell of row) observedScaled += Math.round(logFactorial(cell, H) * SCALE);
  let states = new Map([[rowTotals.join(","), { remaining: rowTotals, values: new Map([[0, 1]]) }]]);
  let work = 0;
  const tick = () => {
    work += 1;
    budget.check();
    if (work > MAX_FISHER_WORK) H.fail("STAT_LIMIT_EXCEEDED", `Freeman-Halton enumeration exceeded ${MAX_FISHER_WORK} operations for this margin configuration`);
  };
  for (let column = 0; column < c; column += 1) {
    const next = new Map();
    const columnTotal = columnTotals[column];
    const isLast = column === c - 1;
    for (const state of states.values()) {
      const remaining = state.remaining;
      const allocation = Array(r).fill(0);
      const recurse = (rowIndex, left, scaled) => {
        tick();
        if (rowIndex === r - 1) {
          if (left > remaining[rowIndex]) return;
          allocation[rowIndex] = left;
          const columnScaled = scaled + Math.round(logFactorial(left, H) * SCALE);
          const newRemaining = remaining.map((value, index) => value - allocation[index]);
          const key = newRemaining.join(",");
          let target = next.get(key);
          if (!target) {
            target = { remaining: newRemaining, values: new Map() };
            next.set(key, target);
          }
          for (const [value, count] of state.values) {
            tick();
            const merged = value + columnScaled;
            target.values.set(merged, (target.values.get(merged) || 0) + count);
          }
          return;
        }
        const upper = Math.min(left, remaining[rowIndex]);
        const laterCapacity = remaining.slice(rowIndex + 1).reduce((sum, value) => sum + value, 0);
        const lower = Math.max(0, left - laterCapacity);
        for (let x = lower; x <= upper; x += 1) {
          allocation[rowIndex] = x;
          recurse(rowIndex + 1, left - x, scaled + Math.round(logFactorial(x, H) * SCALE));
        }
      };
      if (isLast) {
        const remainingSum = remaining.reduce((sum, value) => sum + value, 0);
        if (remainingSum !== columnTotal) continue;
      }
      recurse(0, columnTotal, 0);
    }
    states = next;
    if (states.size > 250_000) H.fail("STAT_LIMIT_EXCEEDED", "Freeman-Halton enumeration state space exceeded the supported bound");
  }
  const terminal = states.get(Array(r).fill(0).join(","));
  if (!terminal) H.fail("STAT_INTERNAL", "Freeman-Halton enumeration lost its terminal state");
  let pValue = 0;
  let totalMass = 0;
  let tables = 0;
  let extremeTables = 0;
  const tolerance = Math.round(1e-7 * SCALE);
  for (const [value, count] of terminal.values) {
    budget.check();
    const probability = Math.exp(logConstant - value / SCALE);
    totalMass += count * probability;
    tables += count;
    if (value >= observedScaled - tolerance) {
      pValue += count * probability;
      extremeTables += count;
    }
  }
  return { pValue: Math.min(1, pValue), observedProbability: Math.exp(logConstant - observedScaled / SCALE), totalMass, tables, extremeTables, operations: work };
}

const fisherExactRxc = {
  method: "fisher_exact_rxc",
  family: FAMILY,
  analysisModel: MODEL,
  optionKeys: ["timeoutMs"],
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["table"],
    properties: { table: { type: "array", minItems: 2, maxItems: MAX_FISHER_DIMENSION, items: { type: "array", minItems: 2, maxItems: MAX_FISHER_DIMENSION, items: COUNT_SCHEMA } }, rowLabels: LABELS_SCHEMA, columnLabels: LABELS_SCHEMA },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["table", "rowLabels", "columnLabels"], "data");
    if (!Array.isArray(data.table) || !Array.isArray(data.table[0])) H.fail("STAT_INVALID_INPUT", "data.table must be an array of integer rows");
    if (data.table.length > MAX_FISHER_DIMENSION || data.table[0].length > MAX_FISHER_DIMENSION) H.fail("STAT_LIMIT_EXCEEDED", `fisher_exact_rxc supports at most ${MAX_FISHER_DIMENSION}×${MAX_FISHER_DIMENSION} tables`);
    const table = parseCountTable(data.table, "data.table", H, { maxRows: MAX_FISHER_DIMENSION, maxColumns: MAX_FISHER_DIMENSION });
    const { rowTotals, columnTotals, total } = marginals(table);
    if (total > MAX_FISHER_TOTAL) H.fail("STAT_LIMIT_EXCEEDED", `fisher_exact_rxc supports at most ${MAX_FISHER_TOTAL} observations`);
    if (rowTotals.some((value) => value === 0) || columnTotals.some((value) => value === 0)) H.fail("STAT_DEGENERATE", "fisher_exact_rxc requires every row and column margin to be positive");
    return { table, rowLabels: parseLabels(data.rowLabels, table.length, "data.rowLabels", "Row", H), columnLabels: parseLabels(data.columnLabels, table[0].length, "data.columnLabels", "Column", H) };
  },
  analyze(parsed, options, budget, H) {
    const exact = freemanHalton(parsed.table, budget, H);
    const pearson = pearsonChiSquare(parsed.table, budget);
    const { rowTotals, columnTotals, total } = marginals(parsed.table);
    const cells = [];
    parsed.table.forEach((row, rowIndex) => row.forEach((count, columnIndex) => {
      const expected = rowTotals[rowIndex] * columnTotals[columnIndex] / total;
      cells.push({ row: parsed.rowLabels[rowIndex], column: parsed.columnLabels[columnIndex], observed: count, expected, pearsonResidual: (count - expected) / Math.sqrt(expected) });
    }));
    const lowExpected = cells.filter((cell) => cell.expected < 5).length;
    return {
      sample: { n: total, rows: parsed.table.length, columns: parsed.table[0].length },
      estimates: toEstimates({ observedProbability: exact.observedProbability, tablesEnumerated: exact.tables, extremeTables: exact.extremeTables, enumeratedMass: exact.totalMass, pearsonChiSquare: pearson.statistic }),
      tests: [
        { name: "Freeman-Halton exact test", statistic: exact.observedProbability, distribution: "conditional multivariate hypergeometric", pValue: exact.pValue, alternative: "two-sided", pValueMethod: "exact" },
        { name: "Pearson chi-square (reference)", statistic: pearson.statistic, distribution: "chi-square", df: pearson.df, pValue: H.pFromChiSquare(pearson.statistic, pearson.df) },
      ],
      confidenceIntervals: [],
      effectSizes: [{ name: "Cramer's V", estimate: Math.sqrt(pearson.statistic / (total * Math.min(parsed.table.length - 1, parsed.table[0].length - 1))) }],
      assumptions: [{ name: "fixed margins / conditional test", status: "method_definition" }, { name: "independent counts", status: "requires_design_review" }],
      diagnostics: [
        { name: "enumeration", status: "exact", tables: exact.tables, extremeTables: exact.extremeTables, probabilityMass: exact.totalMass, operations: exact.operations, boundary: `at most ${MAX_FISHER_DIMENSION}×${MAX_FISHER_DIMENSION} and n ≤ ${MAX_FISHER_TOTAL}; larger tables fail closed` },
        { name: "expected counts", status: lowExpected > 0 ? "sparse_cells_present" : "adequate", cellsBelowFive: lowExpected, detail: "the exact test does not rely on expected counts; the Pearson reference does" },
      ],
      artifacts: [
        H.tableArtifact("Freeman-Halton exact test", "Exact conditional test of independence for an r×c table.", [COLUMN("test", "Test", "string"), COLUMN("statistic", "Statistic"), COLUMN("df", "df"), COLUMN("pValue", "p"), COLUMN("method", "Method", "string")], [{ test: "Freeman-Halton", statistic: exact.observedProbability, df: null, pValue: exact.pValue, method: "exact enumeration" }, { test: "Pearson chi-square", statistic: pearson.statistic, df: pearson.df, pValue: H.pFromChiSquare(pearson.statistic, pearson.df), method: "asymptotic reference" }], ["Two-sided exact p sums every table with fixed margins whose probability does not exceed the observed table's."]),
        H.tableArtifact("Observed and expected cells", "Observed counts with expected counts under independence.", [COLUMN("row", "Row", "string"), COLUMN("column", "Column", "string"), COLUMN("observed", "Observed"), COLUMN("expected", "Expected"), COLUMN("pearsonResidual", "Pearson residual")], cells, [], "exact-table-cells"),
        H.vegaArtifact("exact-table-heatmap", "Observed counts", { data: { values: cells }, mark: "rect", encoding: { x: { field: "column", type: "nominal", title: null }, y: { field: "row", type: "nominal", title: null }, color: { field: "observed", type: "quantitative", title: "Observed" }, tooltip: [{ field: "row" }, { field: "column" }, { field: "observed" }, { field: "expected", format: ".3f" }, { field: "pearsonResidual", format: ".3f" }] } }),
      ],
    };
  },
  linkage: {
    neededWhen: "An r×c contingency table has sparse cells or a small total so the chi-square approximation is untrustworthy and an exact independence test is needed.",
    decision: "Decide whether two categorical variables are associated using an exact conditional p-value rather than an asymptotic one.",
    mustShow: "The exact two-sided p-value, the number of tables enumerated, the observed table probability, and the chi-square reference for comparison.",
    userGoal: "Defend an association claim in a small or sparse table where reviewers will reject a chi-square approximation.",
    nextActions: [
      { trigger: "exact-and-chi-square-disagree", action: "report-exact-result-only", reason: "Disagreement signals the asymptotic approximation failed; the exact p-value is the one to report." },
      { trigger: "association-significant", action: "inspect-standardized-residuals", reason: "An exact omnibus result does not say which cells drive the association; residuals locate them." },
      { trigger: "table-exceeds-exact-bound", action: "use-chi-square-or-monte-carlo", reason: "Beyond the enumeration bound the exact test fails closed; a larger table needs asymptotic or simulated inference." },
    ],
  },
  fixture: { data: { table: [[3, 1, 2], [1, 4, 2], [2, 2, 5]], rowLabels: ["Low", "Medium", "High"], columnLabels: ["Type I", "Type II", "Type III"] } },
  matlabParity: { taxonomyIds: ["matlab.stats.probability-hypothesis"] },
  coverage: {
    implementedBoundary: "Exact Freeman-Halton p-value by column-wise enumeration with merged probability classes; bounded to 5×5 tables with n ≤ 200 and a deterministic operation cap.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["exact two-sided p-value", "observed table probability", "table count", "Pearson reference chi-square"], excludedOutputs: ["Cramer's V"] },
    diagnostic: { level: "method-specific-partial", emitted: ["enumeration size and mass", "sparse cell count"], limitations: ["no one-sided or ordered alternatives", "no Monte Carlo fallback above the bound"] },
    knownGaps: ["network algorithm pruning for larger tables", "mid-p variant"],
  },
};

// ---------------------------------------------------------------------------------------------
// g_test
// ---------------------------------------------------------------------------------------------

const gTest = {
  method: "g_test",
  family: FAMILY,
  analysisModel: MODEL,
  optionKeys: ["timeoutMs"],
  customOptions: { williamsCorrection: booleanOption(false) },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["table"],
    properties: { table: TABLE_RXC_SCHEMA, rowLabels: LABELS_SCHEMA, columnLabels: LABELS_SCHEMA },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["table", "rowLabels", "columnLabels"], "data");
    const table = parseCountTable(data.table, "data.table", H);
    return { table, rowLabels: parseLabels(data.rowLabels, table.length, "data.rowLabels", "Row", H), columnLabels: parseLabels(data.columnLabels, table[0].length, "data.columnLabels", "Column", H) };
  },
  analyze(parsed, options, budget, H) {
    const { rowTotals, columnTotals, total } = marginals(parsed.table);
    if (rowTotals.some((value) => value === 0) || columnTotals.some((value) => value === 0)) H.fail("STAT_DEGENERATE", "G test expected counts contain structural zero(s)");
    let g = 0;
    let pearson = 0;
    let lowExpected = 0;
    const cells = [];
    parsed.table.forEach((row, rowIndex) => row.forEach((observed, columnIndex) => {
      budget.check();
      const expected = rowTotals[rowIndex] * columnTotals[columnIndex] / total;
      const contribution = observed > 0 ? 2 * observed * Math.log(observed / expected) : 0;
      g += contribution;
      pearson += (observed - expected) ** 2 / expected;
      if (expected < 5) lowExpected += 1;
      cells.push({ row: parsed.rowLabels[rowIndex], column: parsed.columnLabels[columnIndex], observed, expected, gContribution: contribution });
    }));
    const df = (parsed.table.length - 1) * (parsed.table[0].length - 1);
    const q = 1 + ((total * rowTotals.reduce((sum, value) => sum + 1 / value, 0) - 1) * (total * columnTotals.reduce((sum, value) => sum + 1 / value, 0) - 1)) / (6 * total * df);
    const gWilliams = g / q;
    const primary = options.williamsCorrection ? gWilliams : g;
    const pValue = H.pFromChiSquare(primary, df);
    const cramerV = Math.sqrt(pearson / (total * Math.min(parsed.table.length - 1, parsed.table[0].length - 1)));
    return {
      sample: { n: total, rows: parsed.table.length, columns: parsed.table[0].length },
      estimates: toEstimates({ g, gWilliams, williamsQ: q, pearsonChiSquare: pearson, cells }),
      tests: [{ name: options.williamsCorrection ? "G test (Williams corrected)" : "G test", statistic: primary, distribution: "chi-square", df, pValue, williamsCorrection: options.williamsCorrection }, { name: "Pearson chi-square (reference)", statistic: pearson, distribution: "chi-square", df, pValue: H.pFromChiSquare(pearson, df) }],
      confidenceIntervals: [],
      effectSizes: [{ name: "Cramer's V", estimate: cramerV }],
      assumptions: [{ name: "independent counts", status: "requires_design_review" }, { name: "expected cell counts", status: lowExpected / cells.length > 0.2 ? "warning" : "acceptable", cellsBelowFive: lowExpected }],
      diagnostics: [{ name: "Williams correction", status: options.williamsCorrection ? "applied" : "available_not_applied", q, uncorrectedG: g, correctedG: gWilliams }, { name: "zero observed cells", status: "reported", count: cells.filter((cell) => cell.observed === 0).length, detail: "zero cells contribute nothing to G but still count toward degrees of freedom" }],
      artifacts: [
        H.tableArtifact("G test of independence", "Log-likelihood ratio test with the Pearson chi-square as a reference.", [COLUMN("test", "Test", "string"), COLUMN("statistic", "Statistic"), COLUMN("df", "df"), COLUMN("pValue", "p")], [{ test: "G", statistic: g, df, pValue: H.pFromChiSquare(g, df) }, { test: "G (Williams)", statistic: gWilliams, df, pValue: H.pFromChiSquare(gWilliams, df) }, { test: "Pearson chi-square", statistic: pearson, df, pValue: H.pFromChiSquare(pearson, df) }], [`Primary statistic: ${options.williamsCorrection ? "Williams-corrected G" : "uncorrected G"}.`]),
        H.tableArtifact("Cell contributions to G", "Observed, expected, and 2·O·ln(O/E) per cell.", [COLUMN("row", "Row", "string"), COLUMN("column", "Column", "string"), COLUMN("observed", "Observed"), COLUMN("expected", "Expected"), COLUMN("gContribution", "G contribution")], cells, [], "g-test-cell-table"),
        H.vegaArtifact("g-test-contribution-heatmap", "Cell contributions to G", { data: { values: cells }, mark: "rect", encoding: { x: { field: "column", type: "nominal", title: null }, y: { field: "row", type: "nominal", title: null }, color: { field: "gContribution", type: "quantitative", title: "2·O·ln(O/E)", scale: { scheme: "redblue", domainMid: 0 } }, tooltip: [{ field: "row" }, { field: "column" }, { field: "observed" }, { field: "expected", format: ".3f" }, { field: "gContribution", format: ".3f" }] } }),
      ],
    };
  },
  linkage: {
    neededWhen: "A contingency table needs a likelihood-ratio test of independence, typically because the analysis will be extended to log-linear models where G is additive.",
    decision: "Decide whether rows and columns are independent using the G statistic, with the Williams correction when the table is small.",
    mustShow: "G with its degrees of freedom and p-value, the Williams factor, the Pearson reference, and per-cell contributions.",
    userGoal: "Test association with a statistic that decomposes cleanly across nested log-linear models.",
    nextActions: [
      { trigger: "small-sample-uncorrected", action: "apply-williams-correction", reason: "G is anti-conservative in small tables; the Williams factor shrinks it toward the chi-square reference." },
      { trigger: "association-significant", action: "fit-log-linear-model", reason: "G partitions across hierarchical models, so the natural follow-up is a log-linear decomposition of the association." },
      { trigger: "many-zero-cells", action: "prefer-exact-test", reason: "Zero cells inflate G's approximation error; the exact Freeman-Halton test is safer." },
    ],
  },
  fixture: { data: { table: [[20, 15, 10], [8, 18, 22], [12, 9, 16]], rowLabels: ["Urban", "Suburban", "Rural"], columnLabels: ["Bus", "Car", "Bike"] }, options: { williamsCorrection: true } },
  matlabParity: { taxonomyIds: ["matlab.stats.probability-hypothesis"] },
  coverage: {
    implementedBoundary: "r×c independence G test with optional Williams correction and Pearson reference; no goodness-of-fit variant against external expected frequencies.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["G statistic", "G p-value", "Williams q", "Pearson chi-square"], excludedOutputs: ["Cramer's V"] },
    diagnostic: { level: "method-specific-partial", emitted: ["Williams factor", "zero cell count", "expected count warning"], limitations: ["no goodness-of-fit mode", "no ordinal alternatives"] },
    knownGaps: ["one-way goodness-of-fit G test", "exact conditional G distribution"],
  },
};

// ---------------------------------------------------------------------------------------------
// two_by_two_effect_measures
// ---------------------------------------------------------------------------------------------

const twoByTwoEffectMeasures = {
  method: "two_by_two_effect_measures",
  family: FAMILY,
  analysisModel: MODEL,
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: { framing: enumOption(["exposure", "diagnostic"], "exposure") },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["table"],
    properties: { table: TABLE_2X2_SCHEMA, rowLabels: LABELS_2_SCHEMA, columnLabels: LABELS_2_SCHEMA },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["table", "rowLabels", "columnLabels"], "data");
    const table = parseCountTable(data.table, "data.table", H, { exactRows: 2, exactColumns: 2 });
    const diagnostic = options.framing === "diagnostic";
    return {
      table,
      rowLabels: parseLabels(data.rowLabels, 2, "data.rowLabels", diagnostic ? "Test" : "Exposure", H),
      columnLabels: parseLabels(data.columnLabels, 2, "data.columnLabels", diagnostic ? "Disease" : "Outcome", H),
    };
  },
  analyze(parsed, options, budget, H) {
    const [[a0, b0], [c0, d0]] = parsed.table;
    const n = a0 + b0 + c0 + d0;
    const z = zCritical(options.confidenceLevel, H);
    const hasZero = [a0, b0, c0, d0].some((value) => value === 0);
    const shift = hasZero ? 0.5 : 0;
    const [a, b, c, d] = [a0 + shift, b0 + shift, c0 + shift, d0 + shift];
    const r1 = a0 + b0;
    const r2 = c0 + d0;
    if (r1 === 0 || r2 === 0) H.fail("STAT_DEGENERATE", "both rows of the 2×2 table must contain observations");
    const risk1 = a0 / r1;
    const risk2 = c0 / r2;
    const oddsRatio = a * d / (b * c);
    const orSe = Math.sqrt(1 / a + 1 / b + 1 / c + 1 / d);
    const riskRatio = (a / (a + b)) / (c / (c + d));
    const rrSe = Math.sqrt(1 / a - 1 / (a + b) + 1 / c - 1 / (c + d));
    const riskDifference = risk1 - risk2;
    const rdSe = Math.sqrt(risk1 * (1 - risk1) / r1 + risk2 * (1 - risk2) / r2);
    const wilson1 = wilsonInterval(a0, r1, z);
    const wilson2 = wilsonInterval(c0, r2, z);
    const newcombeLower = riskDifference - Math.sqrt((risk1 - wilson1.lower) ** 2 + (wilson2.upper - risk2) ** 2);
    const newcombeUpper = riskDifference + Math.sqrt((wilson1.upper - risk1) ** 2 + (risk2 - wilson2.lower) ** 2);
    const nnt = riskDifference === 0 ? null : 1 / Math.abs(riskDifference);
    const nntSpansInfinity = newcombeLower <= 0 && newcombeUpper >= 0;
    const nntLower = nnt === null || nntSpansInfinity ? null : 1 / Math.max(Math.abs(newcombeLower), Math.abs(newcombeUpper));
    const nntUpper = nnt === null || nntSpansInfinity ? null : 1 / Math.min(Math.abs(newcombeLower), Math.abs(newcombeUpper));
    const measureRows = [
      { measure: "odds ratio", estimate: oddsRatio, lower: Math.exp(Math.log(oddsRatio) - z * orSe), upper: Math.exp(Math.log(oddsRatio) + z * orSe), method: hasZero ? "Wald log-odds after 0.5 Haldane-Anscombe adjustment" : "Wald log-odds" },
      { measure: "risk ratio", estimate: riskRatio, lower: Math.exp(Math.log(riskRatio) - z * rrSe), upper: Math.exp(Math.log(riskRatio) + z * rrSe), method: hasZero ? "Katz log-risk after 0.5 adjustment" : "Katz log-risk" },
      { measure: "risk difference", estimate: riskDifference, lower: riskDifference - z * rdSe, upper: riskDifference + z * rdSe, method: "Wald" },
      { measure: "risk difference", estimate: riskDifference, lower: newcombeLower, upper: newcombeUpper, method: "Newcombe hybrid score" },
      { measure: nnt === null ? "number needed to treat" : riskDifference > 0 ? "number needed to treat (benefit)" : "number needed to treat (harm)", estimate: nnt, lower: nntLower, upper: nntUpper, method: nnt === null ? "undefined at zero risk difference" : nntSpansInfinity ? "interval spans infinity; not reported" : "reciprocal of Newcombe limits" },
    ];
    const riskRows = [
      { group: parsed.rowLabels[0], events: a0, total: r1, risk: risk1, lower: wilson1.lower, upper: wilson1.upper },
      { group: parsed.rowLabels[1], events: c0, total: r2, risk: risk2, lower: wilson2.lower, upper: wilson2.upper },
    ];
    let diagnosticRows = [];
    let diagnosticSummary = null;
    if (options.framing === "diagnostic") {
      const c1 = a0 + c0;
      const c2 = b0 + d0;
      if (c1 === 0 || c2 === 0) H.fail("STAT_DEGENERATE", "diagnostic framing requires both disease-present and disease-absent columns to contain observations");
      const sensitivity = a0 / c1;
      const specificity = d0 / c2;
      const ppv = r1 > 0 ? a0 / r1 : null;
      const npv = r2 > 0 ? d0 / r2 : null;
      const sensWilson = wilsonInterval(a0, c1, z);
      const specWilson = wilsonInterval(d0, c2, z);
      const ppvWilson = wilsonInterval(a0, r1, z);
      const npvWilson = wilsonInterval(d0, r2, z);
      const sensAdj = a / (a + c);
      const specAdj = d / (b + d);
      const lrPositive = sensAdj / (1 - specAdj);
      const lrPositiveSe = Math.sqrt((1 - sensAdj) / a + specAdj / b);
      const lrNegative = (1 - sensAdj) / specAdj;
      const lrNegativeSe = Math.sqrt(sensAdj / c + (1 - specAdj) / d);
      const accuracy = (a0 + d0) / n;
      const accuracyWilson = wilsonInterval(a0 + d0, n, z);
      diagnosticRows = [
        { measure: "sensitivity", estimate: sensitivity, lower: sensWilson.lower, upper: sensWilson.upper, method: "Wilson score" },
        { measure: "specificity", estimate: specificity, lower: specWilson.lower, upper: specWilson.upper, method: "Wilson score" },
        { measure: "positive predictive value", estimate: ppv, lower: ppvWilson.lower, upper: ppvWilson.upper, method: "Wilson score (sample prevalence)" },
        { measure: "negative predictive value", estimate: npv, lower: npvWilson.lower, upper: npvWilson.upper, method: "Wilson score (sample prevalence)" },
        { measure: "positive likelihood ratio", estimate: lrPositive, lower: Math.exp(Math.log(lrPositive) - z * lrPositiveSe), upper: Math.exp(Math.log(lrPositive) + z * lrPositiveSe), method: hasZero ? "log-scale Wald after 0.5 adjustment" : "log-scale Wald" },
        { measure: "negative likelihood ratio", estimate: lrNegative, lower: Math.exp(Math.log(lrNegative) - z * lrNegativeSe), upper: Math.exp(Math.log(lrNegative) + z * lrNegativeSe), method: hasZero ? "log-scale Wald after 0.5 adjustment" : "log-scale Wald" },
        { measure: "diagnostic odds ratio", estimate: oddsRatio, lower: measureRows[0].lower, upper: measureRows[0].upper, method: measureRows[0].method },
        { measure: "accuracy", estimate: accuracy, lower: accuracyWilson.lower, upper: accuracyWilson.upper, method: "Wilson score" },
        { measure: "prevalence", estimate: c1 / n, lower: wilsonInterval(c1, n, z).lower, upper: wilsonInterval(c1, n, z).upper, method: "Wilson score" },
      ];
      diagnosticSummary = { sensitivity, specificity, ppv, npv, lrPositive, lrNegative, accuracy, prevalence: c1 / n, youdenIndex: sensitivity + specificity - 1 };
    }
    const measureColumns = [COLUMN("measure", "Measure", "string"), COLUMN("estimate", "Estimate"), COLUMN("lower", "CI lower"), COLUMN("upper", "CI upper"), COLUMN("method", "Interval method", "string")];
    return {
      sample: { n, framing: options.framing, rowTotals: [r1, r2], zeroCells: hasZero },
      estimates: toEstimates({ oddsRatio, riskRatio, riskDifference, numberNeededToTreat: nnt, risks: [risk1, risk2], ...(diagnosticSummary ? { diagnostic: diagnosticSummary } : {}) }),
      tests: [],
      confidenceIntervals: [...measureRows, ...diagnosticRows].map((row) => ({ parameter: row.measure, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: row.method })),
      effectSizes: [{ name: "odds ratio", estimate: oddsRatio }, { name: "risk ratio", estimate: riskRatio }, { name: "risk difference", estimate: riskDifference }, { name: "number needed to treat", estimate: nnt, ...(nnt === null ? { boundary: "undefined_zero_risk_difference" } : nntSpansInfinity ? { boundary: "interval_spans_infinity" } : {}) }],
      assumptions: [{ name: "independent counts from a cohort or trial design", status: options.framing === "exposure" ? "requires_design_review" : "not_applicable" }, { name: "risk-based measures require cohort sampling", status: "requires_design_review", detail: "odds ratios are valid under case-control sampling; risk ratios and differences are not" }, ...(options.framing === "diagnostic" ? [{ name: "predictive values depend on sample prevalence", status: "requires_design_review" }] : [])],
      diagnostics: [{ name: "zero-cell handling", status: hasZero ? "haldane_anscombe_adjusted" : "not_needed", shift }, { name: "number needed to treat", status: nnt === null ? "undefined" : nntSpansInfinity ? "interval_spans_infinity" : "reported" }],
      artifacts: [
        H.tableArtifact(options.framing === "diagnostic" ? "2×2 effect measures (diagnostic framing)" : "2×2 effect measures", CONFIDENCE_NOTE(options), measureColumns, measureRows, ["Ratio intervals are on the log scale; the Newcombe interval is the recommended risk-difference interval."]),
        ...(diagnosticRows.length ? [H.tableArtifact("Diagnostic accuracy measures", `Rows are ${parsed.rowLabels[0]}/${parsed.rowLabels[1]} test results; columns are ${parsed.columnLabels[0]}/${parsed.columnLabels[1]} reference status.`, measureColumns, diagnosticRows, ["Predictive values use the sample prevalence."], "diagnostic-accuracy-table")] : []),
        H.tableArtifact("Group risks", "Row-wise event proportions with Wilson score intervals.", [COLUMN("group", "Group", "string"), COLUMN("events", "Events"), COLUMN("total", "Total"), COLUMN("risk", "Risk"), COLUMN("lower", "CI lower"), COLUMN("upper", "CI upper")], riskRows, [], "two-by-two-risk-table"),
        H.vegaArtifact("two-by-two-risk-plot", `Event proportion by ${parsed.rowLabels.join(" versus ")}`, { data: { values: riskRows }, layer: [{ mark: { type: "rule", strokeWidth: 2 }, encoding: { x: { field: "group", type: "nominal", title: null }, y: { field: "lower", type: "quantitative", title: "Proportion", scale: { domain: [0, 1] } }, y2: { field: "upper" } } }, { mark: { type: "point", filled: true, size: 100 }, encoding: { x: { field: "group", type: "nominal" }, y: { field: "risk", type: "quantitative" }, tooltip: [{ field: "group" }, { field: "risk", format: ".4f" }, { field: "lower", format: ".4f" }, { field: "upper", format: ".4f" }, { field: "events" }, { field: "total" }] } }] }),
      ],
    };
  },
  linkage: {
    neededWhen: "A 2×2 table from a cohort, trial, case-control, or diagnostic study must be summarized as effect measures with intervals rather than a bare p-value.",
    decision: "Decide which measure (odds ratio, risk ratio, risk difference, or diagnostic accuracy) matches the sampling design and whether its interval supports a claim.",
    mustShow: "Every applicable measure with its interval and interval method, the row risks, the NNT boundary, and any zero-cell adjustment.",
    userGoal: "Report an interpretable effect magnitude from a 2×2 table with the interval that reviewers expect for the design.",
    nextActions: [
      { trigger: "case-control-sampling", action: "report-odds-ratio-only", reason: "Risk ratios and differences are not estimable when sampling is on outcome status; only the odds ratio is valid." },
      { trigger: "nnt-interval-spans-infinity", action: "report-risk-difference-instead", reason: "When the risk-difference interval covers zero the NNT interval is disjoint and misleading; report the difference." },
      { trigger: "zero-cell-adjusted", action: "consider-exact-interval", reason: "The 0.5 adjustment stabilizes ratios but an exact conditional interval is preferable for sparse tables." },
    ],
  },
  fixture: { data: { table: [[45, 55], [25, 75]], rowLabels: ["Treated", "Control"], columnLabels: ["Event", "No event"] }, options: { framing: "exposure" } },
  matlabParity: { taxonomyIds: ["matlab.stats.probability-hypothesis"] },
  coverage: {
    implementedBoundary: "Single 2×2 table: odds ratio (Wald), risk ratio (Katz), risk difference (Wald and Newcombe hybrid score), NNT, and diagnostic accuracy measures with Wilson or log-scale intervals; 0.5 adjustment when any cell is zero.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["odds ratio and Wald interval", "risk ratio and Katz interval", "risk difference", "Wilson intervals for risks, sensitivity, specificity, predictive values", "Newcombe risk-difference interval", "likelihood ratios"], excludedOutputs: ["likelihood ratio intervals", "NNT interval"] },
    diagnostic: { level: "method-specific-partial", emitted: ["zero-cell handling", "NNT boundary"], limitations: ["no exact conditional odds-ratio interval", "no prevalence-adjusted predictive values"] },
    knownGaps: ["exact (conditional) odds ratio interval", "predictive values at user-specified prevalence"],
  },
};

// ---------------------------------------------------------------------------------------------
// chi_square_independence_residuals
// ---------------------------------------------------------------------------------------------

const chiSquareIndependenceResiduals = {
  method: "chi_square_independence_residuals",
  family: FAMILY,
  analysisModel: MODEL,
  optionKeys: ["timeoutMs"],
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["table"],
    properties: { table: TABLE_RXC_SCHEMA, rowLabels: LABELS_SCHEMA, columnLabels: LABELS_SCHEMA },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["table", "rowLabels", "columnLabels"], "data");
    const table = parseCountTable(data.table, "data.table", H);
    return { table, rowLabels: parseLabels(data.rowLabels, table.length, "data.rowLabels", "Row", H), columnLabels: parseLabels(data.columnLabels, table[0].length, "data.columnLabels", "Column", H) };
  },
  analyze(parsed, options, budget, H) {
    const { rowTotals, columnTotals, total } = marginals(parsed.table);
    if (rowTotals.some((value) => value === 0) || columnTotals.some((value) => value === 0)) H.fail("STAT_DEGENERATE", "chi-square residuals require positive row and column margins");
    const rows = parsed.table.length;
    const columns = parsed.table[0].length;
    let statistic = 0;
    let lowExpected = 0;
    const cells = [];
    let xCursor = 0;
    for (let row = 0; row < rows; row += 1) {
      const rowShare = rowTotals[row] / total;
      let yCursor = 0;
      for (let column = 0; column < columns; column += 1) {
        budget.check();
        const observed = parsed.table[row][column];
        const expected = rowTotals[row] * columnTotals[column] / total;
        const contribution = (observed - expected) ** 2 / expected;
        statistic += contribution;
        if (expected < 5) lowExpected += 1;
        const pearsonResidual = (observed - expected) / Math.sqrt(expected);
        const adjustedResidual = (observed - expected) / Math.sqrt(expected * (1 - rowTotals[row] / total) * (1 - columnTotals[column] / total));
        const columnShare = observed / rowTotals[row];
        cells.push({ row: parsed.rowLabels[row], column: parsed.columnLabels[column], observed, expected, pearsonResidual, adjustedResidual, contribution, x0: xCursor, x1: xCursor + rowShare, y0: yCursor, y1: yCursor + columnShare });
        yCursor += columnShare;
      }
      xCursor += rowShare;
    }
    const df = (rows - 1) * (columns - 1);
    const pValue = H.pFromChiSquare(statistic, df);
    const cramerV = Math.sqrt(statistic / (total * Math.min(rows - 1, columns - 1)));
    const notable = cells.filter((cell) => Math.abs(cell.adjustedResidual) > 1.96).length;
    return {
      sample: { n: total, rows, columns },
      estimates: toEstimates({ statistic, df, cramerV, cells }),
      tests: [{ name: "Pearson chi-square", statistic, distribution: "chi-square", df, pValue }],
      confidenceIntervals: [],
      effectSizes: [{ name: "Cramer's V", estimate: cramerV }],
      assumptions: [{ name: "independent counts", status: "requires_design_review" }, { name: "expected cell counts", status: lowExpected / cells.length > 0.2 ? "warning" : "acceptable", cellsBelowFive: lowExpected }],
      diagnostics: [{ name: "residual screen", status: "reported", cellsWithAbsAdjustedResidualAbove196: notable, detail: "adjusted residuals are approximately standard normal under independence; the 1.96 screen is not multiplicity-controlled" }, { name: "mosaic geometry", status: "reported", detail: "x extent is proportional to the row margin and y extent to the within-row column proportion" }],
      artifacts: [
        H.tableArtifact("Chi-square independence test", "Omnibus test with effect size.", [COLUMN("statistic", "Chi-square"), COLUMN("df", "df"), COLUMN("pValue", "p"), COLUMN("cramerV", "Cramer's V"), COLUMN("n", "N")], [{ statistic, df, pValue, cramerV, n: total }]),
        H.tableArtifact("Cell residuals", "Observed, expected, Pearson and adjusted (standardized) residuals, chi-square contributions, and mosaic rectangle coordinates.", [COLUMN("row", "Row", "string"), COLUMN("column", "Column", "string"), COLUMN("observed", "Observed"), COLUMN("expected", "Expected"), COLUMN("pearsonResidual", "Pearson residual"), COLUMN("adjustedResidual", "Adjusted residual"), COLUMN("contribution", "Contribution"), COLUMN("x0", "x0"), COLUMN("x1", "x1"), COLUMN("y0", "y0"), COLUMN("y1", "y1")], cells, ["Adjusted residual = (O − E) / sqrt(E (1 − row share)(1 − column share))."], "chi-square-residual-table"),
        H.vegaArtifact("mosaic-residual-plot", "Mosaic plot shaded by adjusted residual", { data: { values: cells }, mark: { type: "rect", stroke: "white", strokeWidth: 1.5 }, encoding: { x: { field: "x0", type: "quantitative", title: `${parsed.rowLabels.join(" | ")} (row share)`, axis: { format: ".0%" }, scale: { domain: [0, 1] } }, x2: { field: "x1" }, y: { field: "y0", type: "quantitative", title: "Within-row column share", axis: { format: ".0%" }, scale: { domain: [0, 1] } }, y2: { field: "y1" }, color: { field: "adjustedResidual", type: "quantitative", title: "Adjusted residual", scale: { scheme: "redblue", domainMid: 0 } }, tooltip: [{ field: "row" }, { field: "column" }, { field: "observed" }, { field: "expected", format: ".3f" }, { field: "adjustedResidual", format: ".3f" }] } }),
      ],
    };
  },
  linkage: {
    neededWhen: "A chi-square test found association in a contingency table and you must show which cells are over- or under-represented.",
    decision: "Decide which specific row-column combinations drive the association using adjusted residuals rather than the omnibus statistic.",
    mustShow: "The omnibus chi-square with Cramer's V, the adjusted-residual table, and a mosaic display shaded by residual.",
    userGoal: "Turn an omnibus association into cell-level statements about which categories co-occur more or less than expected.",
    nextActions: [
      { trigger: "large-adjusted-residuals", action: "report-cells-with-direction", reason: "Adjusted residuals beyond about two identify the cells responsible for the association and their direction." },
      { trigger: "many-cells-screened", action: "apply-multiplicity-control", reason: "Screening every cell at 1.96 inflates false positives; adjust the cell-level thresholds when the table is large." },
      { trigger: "sparse-expected-counts", action: "run-exact-test", reason: "Residual normality and the omnibus approximation both fail with small expected counts; an exact test is safer." },
    ],
  },
  fixture: { data: { table: [[30, 10, 5], [12, 25, 8], [6, 9, 28]], rowLabels: ["North", "Central", "South"], columnLabels: ["Product A", "Product B", "Product C"] } },
  matlabParity: { taxonomyIds: ["matlab.stats.probability-hypothesis", "matlab.stats.descriptive-visualization"] },
  coverage: {
    implementedBoundary: "r×c table: Pearson chi-square with Pearson and adjusted (Haberman) residuals, cell contributions, and precomputed mosaic rectangle coordinates.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["chi-square statistic and p-value", "Pearson residuals", "adjusted residuals", "expected counts"], excludedOutputs: ["mosaic coordinates", "Cramer's V"] },
    diagnostic: { level: "method-specific-partial", emitted: ["residual screen count", "expected count warning", "mosaic geometry"], limitations: ["no multiplicity control on residual screens", "no ordinal association measures"] },
    knownGaps: ["Bonferroni-adjusted residual thresholds", "gamma or Kendall tau-b for ordered tables"],
  },
};

// ---------------------------------------------------------------------------------------------
// binomial_test
// ---------------------------------------------------------------------------------------------

const binomialTest = {
  method: "binomial_test",
  family: FAMILY,
  analysisModel: MODEL,
  optionKeys: ["confidenceLevel", "alternative", "timeoutMs"],
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["successes", "trials"],
    properties: { successes: COUNT_SCHEMA, trials: { type: "integer", minimum: 1, maximum: MAX_BINOMIAL_TRIALS }, probability: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 }, label: LABEL_SCHEMA },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["successes", "trials", "probability", "label"], "data");
    if (Number.isSafeInteger(data.trials) && data.trials > MAX_BINOMIAL_TRIALS) H.fail("STAT_LIMIT_EXCEEDED", `binomial_test supports at most ${MAX_BINOMIAL_TRIALS} trials`);
    const trials = H.integer(data.trials, 1, MAX_BINOMIAL_TRIALS, "data.trials");
    const successes = H.integer(data.successes, 0, trials, "data.successes");
    const probability = data.probability === undefined ? 0.5 : H.finiteNumber(data.probability, "data.probability");
    if (!(probability > 0 && probability < 1)) H.fail("STAT_INVALID_INPUT", "data.probability must lie strictly between 0 and 1");
    return { successes, trials, probability, label: H.label(data.label, "Success", "data.label") };
  },
  analyze(parsed, options, budget, H) {
    const { successes: k, trials: n, probability: p0 } = parsed;
    const exact = binomialExactP(k, n, p0, options.alternative, budget, H);
    const estimate = k / n;
    const z = zCritical(options.confidenceLevel, H);
    const clopper = clopperPearson(k, n, options.confidenceLevel, H);
    const wilson = wilsonInterval(k, n, z);
    const waldSe = Math.sqrt(estimate * (1 - estimate) / n);
    const cohenH = 2 * Math.asin(Math.sqrt(estimate)) - 2 * Math.asin(Math.sqrt(p0));
    const normalZ = (k - n * p0) / Math.sqrt(n * p0 * (1 - p0));
    const pmfRows = exact.pmf.map((probability, successesValue) => ({ successes: successesValue, probability, observed: successesValue === k, inRejectionMass: probability <= exact.pmf[k] * (1 + 1e-7) }));
    return {
      sample: { trials: n, successes: k, failures: n - k },
      estimates: toEstimates({ proportion: estimate, hypothesizedProbability: p0, expectedSuccesses: n * p0, standardError: waldSe }),
      tests: [{ name: "Exact binomial test", statistic: k, distribution: `binomial(${n}, ${p0})`, pValue: exact.pValue, alternative: options.alternative, pValueMethod: "exact" }, { name: "Normal approximation (reference)", statistic: normalZ, distribution: "normal", pValue: pFromZ(normalZ, options.alternative, H) }],
      confidenceIntervals: [
        { parameter: "proportion", level: options.confidenceLevel, lower: clopper.lower, upper: clopper.upper, method: "Clopper-Pearson exact" },
        { parameter: "proportion", level: options.confidenceLevel, lower: wilson.lower, upper: wilson.upper, method: "Wilson score" },
        { parameter: "proportion", level: options.confidenceLevel, lower: Math.max(0, estimate - z * waldSe), upper: Math.min(1, estimate + z * waldSe), method: "Wald" },
      ],
      effectSizes: [{ name: "Cohen h versus hypothesized probability", estimate: cohenH }, { name: "proportion difference", estimate: estimate - p0 }],
      assumptions: [{ name: "independent Bernoulli trials with constant probability", status: "requires_design_review" }],
      diagnostics: [{ name: "two-sided convention", status: "exact", detail: "two-sided p sums every outcome whose probability does not exceed the observed outcome's (minimum-likelihood ordering)" }, { name: "tail probabilities", status: "reported", less: exact.less, greater: exact.greater, twoSided: exact.twoSided }, { name: "normal approximation adequacy", status: Math.min(n * p0, n * (1 - p0)) < 5 ? "inadequate_use_exact" : "adequate" }],
      artifacts: [
        H.tableArtifact(`Exact binomial test: ${parsed.label}`, `${k} of ${n} versus hypothesized probability ${p0}.`, [COLUMN("successes", "Successes"), COLUMN("trials", "Trials"), COLUMN("proportion", "Proportion"), COLUMN("hypothesized", "Hypothesized p"), COLUMN("pValue", "Exact p"), COLUMN("alternative", "Alternative", "string"), COLUMN("lower", "Clopper-Pearson lower"), COLUMN("upper", "Clopper-Pearson upper")], [{ successes: k, trials: n, proportion: estimate, hypothesized: p0, pValue: exact.pValue, alternative: options.alternative, lower: clopper.lower, upper: clopper.upper }], [CONFIDENCE_NOTE(options)]),
        H.tableArtifact("Binomial probability mass", "Null probability of every possible success count; rows flagged in the two-sided rejection mass.", [COLUMN("successes", "Successes"), COLUMN("probability", "Null probability"), COLUMN("observed", "Observed", "boolean"), COLUMN("inRejectionMass", "In two-sided mass", "boolean")], pmfRows, [], "binomial-pmf-table"),
        H.vegaArtifact("binomial-pmf-plot", `Null binomial(${n}, ${p0}) distribution with observed count`, { data: { values: pmfRows }, mark: { type: "bar" }, encoding: { x: { field: "successes", type: "ordinal", title: "Successes" }, y: { field: "probability", type: "quantitative", title: "Null probability" }, color: { field: "inRejectionMass", type: "nominal", title: "In two-sided mass", scale: { domain: [false, true], range: ["#B8B2AC", "#285f8f"] } }, opacity: { field: "observed", type: "nominal", scale: { domain: [false, true], range: [0.55, 1] }, legend: null }, tooltip: [{ field: "successes" }, { field: "probability", format: ".4g" }, { field: "observed" }] } }),
      ],
    };
  },
  linkage: {
    neededWhen: "A single success count out of a fixed number of independent trials must be compared against a hypothesized probability.",
    decision: "Decide whether the observed proportion is compatible with the hypothesized probability using exact binomial inference.",
    mustShow: "The exact p-value with its alternative, the observed proportion with Clopper-Pearson and Wilson intervals, and the null distribution.",
    userGoal: "Report an exact one-proportion result that does not depend on a normal approximation.",
    nextActions: [
      { trigger: "normal-approximation-inadequate", action: "report-exact-and-clopper-pearson", reason: "When expected successes or failures are under five only the exact test and exact interval are defensible." },
      { trigger: "interval-excludes-hypothesized-probability", action: "report-proportion-difference-with-cohen-h", reason: "An interval excluding the null probability supports a difference; Cohen h conveys its magnitude on a stable scale." },
      { trigger: "trials-exceed-bound", action: "use-normal-or-wilson-inference", reason: "Above the exact enumeration bound a score-based interval and z test are adequate and cheaper." },
    ],
  },
  fixture: { data: { successes: 14, trials: 40, probability: 0.25, label: "Responder" } },
  matlabParity: { taxonomyIds: ["matlab.stats.probability-hypothesis"] },
  coverage: {
    implementedBoundary: "One proportion with at most 5000 trials: exact binomial test (minimum-likelihood two-sided ordering), Clopper-Pearson, Wilson, and Wald intervals, Cohen h.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["exact p-value for every alternative", "Clopper-Pearson interval", "Wilson interval", "probability mass rows"], excludedOutputs: ["Cohen h", "Wald interval"] },
    diagnostic: { level: "method-specific-partial", emitted: ["two-sided convention", "tail probabilities", "normal adequacy"], limitations: ["no mid-p", "no Blaker or Agresti-Coull intervals"] },
    knownGaps: ["mid-p exact test", "Agresti-Coull and Blaker intervals"],
  },
};

// ---------------------------------------------------------------------------------------------
// poisson_rate_test
// ---------------------------------------------------------------------------------------------

const poissonRateTest = {
  method: "poisson_rate_test",
  family: FAMILY,
  analysisModel: MODEL,
  optionKeys: ["confidenceLevel", "alternative", "timeoutMs"],
  customOptions: { design: enumOption(["one-sample", "two-sample"], "one-sample") },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      count: COUNT_SCHEMA,
      exposure: { type: "number", exclusiveMinimum: 0 },
      hypothesizedRate: { type: "number", exclusiveMinimum: 0 },
      counts: { type: "array", minItems: 2, maxItems: 2, items: COUNT_SCHEMA },
      exposures: { type: "array", minItems: 2, maxItems: 2, items: { type: "number", exclusiveMinimum: 0 } },
      hypothesizedRatio: { type: "number", exclusiveMinimum: 0 },
      groupLabels: LABELS_2_SCHEMA,
      label: LABEL_SCHEMA,
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["count", "exposure", "hypothesizedRate", "counts", "exposures", "hypothesizedRatio", "groupLabels", "label"], "data");
    if (options.design === "one-sample") {
      for (const key of ["counts", "exposures", "hypothesizedRatio", "groupLabels"]) if (data[key] !== undefined) H.fail("STAT_INVALID_INPUT", `data.${key} is only valid for the two-sample design`);
      if (data.count === undefined || data.exposure === undefined || data.hypothesizedRate === undefined) H.fail("STAT_INVALID_INPUT", "one-sample design requires data.count, data.exposure, and data.hypothesizedRate");
      const count = H.integer(data.count, 0, 1_000_000_000, "data.count");
      const exposure = H.finiteNumber(data.exposure, "data.exposure");
      const hypothesizedRate = H.finiteNumber(data.hypothesizedRate, "data.hypothesizedRate");
      if (!(exposure > 0) || !(hypothesizedRate > 0)) H.fail("STAT_INVALID_INPUT", "data.exposure and data.hypothesizedRate must be positive");
      return { design: "one-sample", count, exposure, hypothesizedRate, label: H.label(data.label, "Event", "data.label") };
    }
    for (const key of ["count", "exposure", "hypothesizedRate"]) if (data[key] !== undefined) H.fail("STAT_INVALID_INPUT", `data.${key} is only valid for the one-sample design`);
    if (!Array.isArray(data.counts) || data.counts.length !== 2 || !Array.isArray(data.exposures) || data.exposures.length !== 2) H.fail("STAT_INVALID_INPUT", "two-sample design requires data.counts and data.exposures with exactly two entries");
    const counts = data.counts.map((value, index) => H.integer(value, 0, 1_000_000_000, `data.counts[${index}]`));
    const exposures = data.exposures.map((value, index) => H.finiteNumber(value, `data.exposures[${index}]`));
    if (exposures.some((value) => !(value > 0))) H.fail("STAT_INVALID_INPUT", "data.exposures must be positive");
    const hypothesizedRatio = data.hypothesizedRatio === undefined ? 1 : H.finiteNumber(data.hypothesizedRatio, "data.hypothesizedRatio");
    if (!(hypothesizedRatio > 0)) H.fail("STAT_INVALID_INPUT", "data.hypothesizedRatio must be positive");
    return { design: "two-sample", counts, exposures, hypothesizedRatio, groupLabels: parseLabels(data.groupLabels, 2, "data.groupLabels", "Group", H), label: H.label(data.label, "Event", "data.label") };
  },
  analyze(parsed, options, budget, H) {
    const z = zCritical(options.confidenceLevel, H);
    const alpha = 1 - options.confidenceLevel;
    const exactRateInterval = (count, exposure) => ({
      lower: count === 0 ? 0 : chiSquareQuantile(alpha / 2, 2 * count, H) / (2 * exposure),
      upper: chiSquareQuantile(1 - alpha / 2, 2 * count + 2, H) / (2 * exposure),
    });
    if (parsed.design === "one-sample") {
      const { count: k, exposure: t, hypothesizedRate } = parsed;
      const lambda = hypothesizedRate * t;
      const less = poissonCdf(k, lambda, H);
      const greater = poissonSf(k, lambda, H);
      const twoSided = Math.min(1, 2 * Math.min(less, greater));
      const pValue = options.alternative === "less" ? less : options.alternative === "greater" ? greater : twoSided;
      const rate = k / t;
      const exactCi = exactRateInterval(k, t);
      const waldSe = Math.sqrt(k) / t;
      const scoreZ = (k - lambda) / Math.sqrt(lambda);
      const rows = [
        { group: parsed.label, count: k, exposure: t, rate, lower: exactCi.lower, upper: exactCi.upper, rowType: "observed" },
        { group: "hypothesized", count: lambda, exposure: t, rate: hypothesizedRate, lower: hypothesizedRate, upper: hypothesizedRate, rowType: "null" },
      ];
      return {
        sample: { design: "one-sample", count: k, exposure: t, expectedCount: lambda },
        estimates: toEstimates({ rate, hypothesizedRate, rateRatioToNull: rate / hypothesizedRate, expectedCount: lambda }),
        tests: [{ name: "Exact Poisson rate test", statistic: k, distribution: `Poisson(${lambda})`, pValue, alternative: options.alternative, pValueMethod: "exact" }, { name: "Score z (reference)", statistic: scoreZ, distribution: "normal", pValue: pFromZ(scoreZ, options.alternative, H) }],
        confidenceIntervals: [{ parameter: "rate", level: options.confidenceLevel, lower: exactCi.lower, upper: exactCi.upper, method: "exact chi-square (Garwood)" }, { parameter: "rate", level: options.confidenceLevel, lower: Math.max(0, rate - z * waldSe), upper: rate + z * waldSe, method: "Wald" }],
        effectSizes: [{ name: "rate ratio versus hypothesized rate", estimate: rate / hypothesizedRate }],
        assumptions: [{ name: "Poisson counts with constant rate over the exposure", status: "requires_design_review" }, { name: "no overdispersion", status: "not_established" }],
        diagnostics: [{ name: "two-sided convention", status: "exact", detail: "central two-sided p = 2 × min(lower tail, upper tail), capped at one" }, { name: "tail probabilities", status: "reported", less, greater }],
        artifacts: [
          H.tableArtifact(`Exact Poisson rate test: ${parsed.label}`, `Observed ${k} events over exposure ${t} versus rate ${hypothesizedRate}.`, [COLUMN("count", "Count"), COLUMN("exposure", "Exposure"), COLUMN("rate", "Rate"), COLUMN("hypothesizedRate", "Hypothesized rate"), COLUMN("pValue", "Exact p"), COLUMN("alternative", "Alternative", "string"), COLUMN("lower", "Exact lower"), COLUMN("upper", "Exact upper")], [{ count: k, exposure: t, rate, hypothesizedRate, pValue, alternative: options.alternative, lower: exactCi.lower, upper: exactCi.upper }], [CONFIDENCE_NOTE(options)]),
          H.tableArtifact("Rate comparison rows", "Observed rate with exact interval and the hypothesized rate.", [COLUMN("group", "Group", "string"), COLUMN("count", "Count"), COLUMN("exposure", "Exposure"), COLUMN("rate", "Rate"), COLUMN("lower", "CI lower"), COLUMN("upper", "CI upper"), COLUMN("rowType", "Row type", "string")], rows, [], "poisson-rate-table"),
          H.vegaArtifact("poisson-rate-plot", "Observed rate with exact interval versus hypothesized rate", { data: { values: rows }, layer: [{ mark: { type: "rule", strokeWidth: 2 }, encoding: { x: { field: "group", type: "nominal", title: null }, y: { field: "lower", type: "quantitative", title: "Rate" }, y2: { field: "upper" }, color: { field: "rowType", type: "nominal", legend: null } } }, { mark: { type: "point", filled: true, size: 100 }, encoding: { x: { field: "group", type: "nominal" }, y: { field: "rate", type: "quantitative" }, color: { field: "rowType", type: "nominal", legend: null }, tooltip: [{ field: "group" }, { field: "rate", format: ".4g" }, { field: "lower", format: ".4g" }, { field: "upper", format: ".4g" }] } }] }),
        ],
      };
    }
    const [k1, k2] = parsed.counts;
    const [t1, t2] = parsed.exposures;
    const total = k1 + k2;
    if (total === 0) H.fail("STAT_DEGENERATE", "two-sample Poisson comparison requires at least one event");
    const p0 = parsed.hypothesizedRatio * t1 / (parsed.hypothesizedRatio * t1 + t2);
    const exact = binomialExactP(k1, total, p0, options.alternative, budget, H);
    const rate1 = k1 / t1;
    const rate2 = k2 / t2;
    const rateRatio = k2 > 0 && k1 > 0 ? rate1 / rate2 : null;
    const conditional = clopperPearson(k1, total, options.confidenceLevel, H);
    const ratioLower = conditional.lower === 0 ? 0 : (conditional.lower / (1 - conditional.lower)) * (t2 / t1);
    const ratioUpper = conditional.upper === 1 ? null : (conditional.upper / (1 - conditional.upper)) * (t2 / t1);
    const difference = rate1 - rate2;
    const differenceSe = Math.sqrt(k1 / (t1 * t1) + k2 / (t2 * t2));
    const ci1 = exactRateInterval(k1, t1);
    const ci2 = exactRateInterval(k2, t2);
    const rows = [
      { group: parsed.groupLabels[0], count: k1, exposure: t1, rate: rate1, lower: ci1.lower, upper: ci1.upper, rowType: "observed" },
      { group: parsed.groupLabels[1], count: k2, exposure: t2, rate: rate2, lower: ci2.lower, upper: ci2.upper, rowType: "observed" },
    ];
    return {
      sample: { design: "two-sample", counts: parsed.counts, exposures: parsed.exposures, totalEvents: total },
      estimates: toEstimates({ rates: [rate1, rate2], rateRatio, rateDifference: difference, hypothesizedRatio: parsed.hypothesizedRatio, conditionalBinomialProbability: p0 }),
      tests: [{ name: "Exact conditional Poisson rate ratio test", statistic: k1, distribution: `binomial(${total}, ${p0})`, pValue: exact.pValue, alternative: options.alternative, pValueMethod: "exact" }],
      confidenceIntervals: [
        { parameter: "rate ratio", level: options.confidenceLevel, lower: ratioLower, upper: ratioUpper, method: ratioUpper === null ? "conditional Clopper-Pearson (upper limit infinite)" : "conditional Clopper-Pearson" },
        { parameter: "rate difference", level: options.confidenceLevel, lower: difference - z * differenceSe, upper: difference + z * differenceSe, method: "Wald" },
        ...rows.map((row) => ({ parameter: `rate ${row.group}`, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: "exact chi-square (Garwood)" })),
      ],
      effectSizes: [{ name: "rate ratio", estimate: rateRatio, ...(rateRatio === null ? { boundary: "zero_or_infinite" } : {}) }, { name: "rate difference", estimate: difference }],
      assumptions: [{ name: "independent Poisson processes with constant rates", status: "requires_design_review" }, { name: "no overdispersion", status: "not_established" }],
      diagnostics: [{ name: "conditioning", status: "exact", detail: "given the total event count, the first count is binomial with probability ratio·t1/(ratio·t1 + t2) under the null" }, { name: "two-sided convention", status: "exact", detail: "minimum-likelihood ordering as in the exact binomial test" }, { name: "tail probabilities", status: "reported", less: exact.less, greater: exact.greater }],
      artifacts: [
        H.tableArtifact(`Two-sample Poisson rate comparison: ${parsed.label}`, `${parsed.groupLabels[0]} versus ${parsed.groupLabels[1]}; hypothesized ratio ${parsed.hypothesizedRatio}.`, [COLUMN("rateRatio", "Rate ratio"), COLUMN("ratioLower", "Ratio lower"), COLUMN("ratioUpper", "Ratio upper"), COLUMN("rateDifference", "Rate difference"), COLUMN("pValue", "Exact p"), COLUMN("alternative", "Alternative", "string")], [{ rateRatio, ratioLower, ratioUpper, rateDifference: difference, pValue: exact.pValue, alternative: options.alternative }], [CONFIDENCE_NOTE(options), "Rate-ratio interval inverts the conditional binomial Clopper-Pearson interval."]),
        H.tableArtifact("Group rates", "Counts, exposures, and exact rate intervals per group.", [COLUMN("group", "Group", "string"), COLUMN("count", "Count"), COLUMN("exposure", "Exposure"), COLUMN("rate", "Rate"), COLUMN("lower", "CI lower"), COLUMN("upper", "CI upper"), COLUMN("rowType", "Row type", "string")], rows, [], "poisson-rate-table"),
        H.vegaArtifact("poisson-rate-plot", "Event rates with exact intervals", { data: { values: rows }, layer: [{ mark: { type: "rule", strokeWidth: 2 }, encoding: { x: { field: "group", type: "nominal", title: null }, y: { field: "lower", type: "quantitative", title: "Rate" }, y2: { field: "upper" } } }, { mark: { type: "point", filled: true, size: 100 }, encoding: { x: { field: "group", type: "nominal" }, y: { field: "rate", type: "quantitative" }, tooltip: [{ field: "group" }, { field: "count" }, { field: "exposure" }, { field: "rate", format: ".4g" }, { field: "lower", format: ".4g" }, { field: "upper", format: ".4g" }] } }] }),
      ],
    };
  },
  linkage: {
    neededWhen: "Event counts over known exposure (person-time, area, duration) must be tested against a reference rate or compared between two groups.",
    decision: "Decide whether an incidence rate differs from a benchmark or between two groups using exact Poisson inference.",
    mustShow: "Observed rates with exact intervals, the exact p-value and its alternative, and the rate ratio with its conditional interval when two groups are compared.",
    userGoal: "Report incidence-rate comparisons that remain valid with few events where normal approximations fail.",
    nextActions: [
      { trigger: "few-events", action: "report-exact-intervals-only", reason: "With a handful of events the Wald interval can cross zero or be far too narrow; the Garwood interval is exact." },
      { trigger: "rate-ratio-interval-excludes-one", action: "report-rate-ratio-with-exposure-basis", reason: "A conditional interval excluding one supports a rate difference; readers need the exposure units to interpret it." },
      { trigger: "overdispersion-suspected", action: "fit-negative-binomial-or-quasi-poisson", reason: "Exact Poisson inference assumes equidispersion; clustered or heterogeneous counts require an overdispersed model." },
    ],
  },
  fixture: { data: { counts: [18, 9], exposures: [1200, 1350], groupLabels: ["Exposed", "Unexposed"], label: "Infection" }, options: { design: "two-sample" } },
  matlabParity: { taxonomyIds: ["matlab.stats.probability-hypothesis"] },
  coverage: {
    implementedBoundary: "One-sample exact Poisson test with central two-sided p and Garwood interval; two-sample exact conditional binomial comparison with conditional Clopper-Pearson rate-ratio interval and Wald rate difference.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["one-sample tail and two-sided p-values", "Garwood exact rate interval", "two-sample exact conditional p-value", "rate ratio", "conditional rate-ratio interval"], excludedOutputs: ["Wald rate difference interval", "score z reference"] },
    diagnostic: { level: "method-specific-partial", emitted: ["two-sided convention", "tail probabilities", "conditioning statement"], limitations: ["no overdispersion check", "no mid-p"] },
    knownGaps: ["unconditional exact rate-ratio test", "overdispersion diagnostics"],
  },
};

// ---------------------------------------------------------------------------------------------
// log_linear_model
// ---------------------------------------------------------------------------------------------

const FACTOR_LETTERS = ["A", "B", "C"];

function parseGeneratorModel(model, dimensions, H) {
  if (typeof model !== "string" || !/^(\[[ABC]{1,3}\])+$/u.test(model)) H.fail("STAT_INVALID_INPUT", "options.model must be a bracket generator string such as [AB][C]");
  const generators = [...model.matchAll(/\[([ABC]+)\]/gu)].map((match) => {
    const letters = [...match[1]];
    if (new Set(letters).size !== letters.length) H.fail("STAT_INVALID_INPUT", `options.model generator [${match[1]}] repeats a factor`);
    const indices = letters.map((letter) => FACTOR_LETTERS.indexOf(letter)).sort((a, b) => a - b);
    if (indices.some((index) => index >= dimensions)) H.fail("STAT_INVALID_INPUT", `options.model references factor ${match[1]} beyond the ${dimensions}-way table`);
    return indices;
  });
  const covered = new Set(generators.flat());
  for (let factor = 0; factor < dimensions; factor += 1) {
    if (!covered.has(factor)) H.fail("STAT_INVALID_INPUT", `options.model must include factor ${FACTOR_LETTERS[factor]} in at least one generator`);
  }
  const canonical = generators.map((indices) => indices.map((index) => FACTOR_LETTERS[index]).join(""));
  if (new Set(canonical).size !== canonical.length) H.fail("STAT_INVALID_INPUT", "options.model repeats a generator");
  for (const [outer, indices] of generators.entries()) {
    for (const [inner, other] of generators.entries()) {
      if (outer !== inner && indices.every((index) => other.includes(index))) H.fail("STAT_INVALID_INPUT", `options.model generator [${canonical[outer]}] is redundant inside [${canonical[inner]}]`);
    }
  }
  return { generators, canonical: canonical.map((term) => `[${term}]`).join("") };
}

function flattenTable(raw, path, H) {
  if (!Array.isArray(raw) || raw.length < 2) H.fail("STAT_INVALID_INPUT", `${path} must be a nested array with at least two levels per factor`);
  const dims = [];
  let probe = raw;
  while (Array.isArray(probe)) {
    if (probe.length < 2 || probe.length > MAX_LOGLINEAR_LEVELS) H.fail("STAT_INVALID_INPUT", `${path} factors must have between 2 and ${MAX_LOGLINEAR_LEVELS} levels`);
    dims.push(probe.length);
    probe = probe[0];
  }
  if (dims.length < 2 || dims.length > 3) H.fail("STAT_INVALID_INPUT", `${path} must be a two-way or three-way table`);
  const cells = [];
  const walk = (node, depth, index) => {
    if (depth === dims.length) {
      cells.push({ index: [...index], count: H.integer(node, 0, Number.MAX_SAFE_INTEGER, `${path}[${index.join("][")}]`) });
      return;
    }
    if (!Array.isArray(node) || node.length !== dims[depth]) H.fail("STAT_INVALID_INPUT", `${path} must be rectangular`);
    node.forEach((child, position) => walk(child, depth + 1, [...index, position]));
  };
  walk(raw, 0, []);
  if (cells.reduce((sum, cell) => sum + cell.count, 0) === 0) H.fail("STAT_INVALID_INPUT", `${path} total must be positive`);
  return { dims, cells };
}

const logLinearModel = {
  method: "log_linear_model",
  family: FAMILY,
  analysisModel: { families: ["categorical", "glm"], distributions: [null, "poisson", "multinomial"], links: [null, "log"] },
  optionKeys: ["timeoutMs", "maxIterations", "tolerance"],
  customOptions: {
    model: {
      schema: { type: "string", pattern: "^(\\[[ABC]{1,3}\\])+$", maxLength: 24 },
      default: null,
      parse(value, H, path) {
        if (typeof value !== "string" || value.length > 24 || !/^(\[[ABC]{1,3}\])+$/u.test(value)) H.fail("STAT_INVALID_INPUT", `${path} must be a bracket generator string such as [AB][C]`);
        return value;
      },
    },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["table"],
    properties: {
      table: { type: "array", minItems: 2, maxItems: MAX_LOGLINEAR_LEVELS, items: { type: "array", minItems: 2, maxItems: MAX_LOGLINEAR_LEVELS } },
      factorLabels: { type: "array", minItems: 2, maxItems: 3, items: LABEL_SCHEMA },
      levelLabels: { type: "array", minItems: 2, maxItems: 3, items: { type: "array", minItems: 2, maxItems: MAX_LOGLINEAR_LEVELS, items: LABEL_SCHEMA } },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["table", "factorLabels", "levelLabels"], "data");
    const { dims, cells } = flattenTable(data.table, "data.table", H);
    const factorLabels = parseLabels(data.factorLabels, dims.length, "data.factorLabels", "Factor", H);
    let levelLabels;
    if (data.levelLabels === undefined) levelLabels = dims.map((size, factor) => Array.from({ length: size }, (_, level) => `${factorLabels[factor]} ${level + 1}`));
    else {
      if (!Array.isArray(data.levelLabels) || data.levelLabels.length !== dims.length) H.fail("STAT_INVALID_INPUT", "data.levelLabels must supply one label array per factor");
      levelLabels = data.levelLabels.map((labels, factor) => parseLabels(labels, dims[factor], `data.levelLabels[${factor}]`, factorLabels[factor], H));
    }
    const modelString = options.model === null ? (dims.length === 2 ? "[A][B]" : "[AB][AC][BC]") : options.model;
    const model = parseGeneratorModel(modelString, dims.length, H);
    if (model.generators.some((indices) => indices.length === dims.length)) H.fail("STAT_INVALID_INPUT", "options.model is saturated and leaves no residual degrees of freedom");
    return { dims, cells, factorLabels, levelLabels, model, modelSource: options.model === null ? "default" : "supplied" };
  },
  analyze(parsed, options, budget, H) {
    const { dims, cells, model } = parsed;
    const total = cells.reduce((sum, cell) => sum + cell.count, 0);
    const marginKey = (index, factors) => factors.map((factor) => index[factor]).join(",");
    const observedMargins = model.generators.map((factors) => {
      const map = new Map();
      for (const cell of cells) {
        const key = marginKey(cell.index, factors);
        map.set(key, (map.get(key) || 0) + cell.count);
      }
      return map;
    });
    let fitted = cells.map(() => 1);
    let iterations = 0;
    let converged = false;
    let maxChange = Infinity;
    while (iterations < options.maxIterations) {
      budget.check(64);
      iterations += 1;
      const previous = fitted.slice();
      for (const [generatorIndex, factors] of model.generators.entries()) {
        const fittedMargins = new Map();
        for (const [position, cell] of cells.entries()) {
          budget.check();
          const key = marginKey(cell.index, factors);
          fittedMargins.set(key, (fittedMargins.get(key) || 0) + fitted[position]);
        }
        for (const [position, cell] of cells.entries()) {
          const key = marginKey(cell.index, factors);
          const observed = observedMargins[generatorIndex].get(key);
          const current = fittedMargins.get(key);
          fitted[position] = current > 0 ? fitted[position] * observed / current : 0;
        }
      }
      maxChange = Math.max(...fitted.map((value, position) => Math.abs(value - previous[position])));
      if (maxChange <= options.tolerance * Math.max(1, total)) { converged = true; break; }
    }
    if (!converged) H.fail("STAT_NON_CONVERGENCE", `iterative proportional fitting did not converge in ${options.maxIterations} cycles`);
    if (fitted.some((value) => !Number.isFinite(value))) H.fail("STAT_NUMERIC_FAILURE", "iterative proportional fitting produced non-finite expected counts");
    const allowedSubsets = new Set();
    for (const factors of model.generators) {
      const size = factors.length;
      for (let mask = 1; mask < (1 << size); mask += 1) allowedSubsets.add(factors.filter((_, bit) => mask & (1 << bit)).join(","));
    }
    let parameters = 1;
    for (const subset of allowedSubsets) parameters += subset.split(",").map(Number).reduce((product, factor) => product * (dims[factor] - 1), 1);
    const df = cells.length - parameters;
    if (df <= 0) H.fail("STAT_DEGENERATE", "log-linear model leaves no residual degrees of freedom");
    let g2 = 0;
    let x2 = 0;
    let zeroFitted = 0;
    const cellRows = cells.map((cell, position) => {
      const expected = fitted[position];
      const observed = cell.count;
      if (expected <= 0) {
        zeroFitted += 1;
        return { cell: cell.index.map((level, factor) => parsed.levelLabels[factor][level]).join(" | "), ...Object.fromEntries(cell.index.map((level, factor) => [`factor${FACTOR_LETTERS[factor]}`, parsed.levelLabels[factor][level]])), observed, expected: 0, pearsonResidual: 0, devianceResidual: 0 };
      }
      const gTerm = observed > 0 ? 2 * observed * Math.log(observed / expected) : 0;
      g2 += gTerm;
      x2 += (observed - expected) ** 2 / expected;
      const devianceSquared = Math.max(0, 2 * ((observed > 0 ? observed * Math.log(observed / expected) : 0) - (observed - expected)));
      return { cell: cell.index.map((level, factor) => parsed.levelLabels[factor][level]).join(" | "), ...Object.fromEntries(cell.index.map((level, factor) => [`factor${FACTOR_LETTERS[factor]}`, parsed.levelLabels[factor][level]])), observed, expected, pearsonResidual: (observed - expected) / Math.sqrt(expected), devianceResidual: Math.sign(observed - expected) * Math.sqrt(devianceSquared) };
    });
    const g2P = H.pFromChiSquare(g2, df);
    const x2P = H.pFromChiSquare(x2, df);
    const aic = g2 - 2 * df;
    const bic = g2 - df * Math.log(total);
    const dissimilarity = cellRows.reduce((sum, row) => sum + Math.abs(row.observed - row.expected), 0) / (2 * total);
    const factorColumns = dims.map((_, factor) => COLUMN(`factor${FACTOR_LETTERS[factor]}`, parsed.factorLabels[factor], "string"));
    return {
      sample: { n: total, cells: cells.length, dimensions: dims, factors: parsed.factorLabels },
      estimates: toEstimates({ model: model.canonical, generators: model.canonical, parameters, df, g2, x2, aicDelta: aic, bicDelta: bic, dissimilarityIndex: dissimilarity, expected: fitted }),
      tests: [{ name: "Likelihood-ratio goodness of fit (G²)", statistic: g2, distribution: "chi-square", df, pValue: g2P }, { name: "Pearson goodness of fit (X²)", statistic: x2, distribution: "chi-square", df, pValue: x2P }],
      confidenceIntervals: [],
      effectSizes: [{ name: "index of dissimilarity", estimate: dissimilarity }],
      assumptions: [{ name: "Poisson or multinomial sampling of cell counts", status: "requires_design_review" }, { name: "hierarchical model specification", status: "verified_by_input_contract" }, { name: "chi-square approximation", status: cellRows.filter((row) => row.expected < 5).length / cellRows.length > 0.2 ? "sparse_table_warning" : "asymptotic" }],
      diagnostics: [
        { name: "iterative proportional fitting", status: "converged", iterations, maxChange, tolerance: options.tolerance, modelSource: parsed.modelSource },
        { name: "zero fitted cells", status: zeroFitted > 0 ? "present" : "absent", count: zeroFitted, detail: "cells with zero fitted margins are excluded from residuals and the degrees of freedom are not reduced" },
        { name: "model comparison boundary", status: "not_established", detail: "AIC/BIC deltas are relative to the saturated model; nested-model G² differences require separate fits" },
      ],
      artifacts: [
        H.tableArtifact(`Log-linear model ${model.canonical}`, `Goodness of fit for the hierarchical model on a ${dims.join("×")} table.`, [COLUMN("model", "Model", "string"), COLUMN("parameters", "Parameters"), COLUMN("df", "df"), COLUMN("g2", "G²"), COLUMN("g2PValue", "G² p"), COLUMN("x2", "X²"), COLUMN("x2PValue", "X² p"), COLUMN("dissimilarity", "Dissimilarity")], [{ model: model.canonical, parameters, df, g2, g2PValue: g2P, x2, x2PValue: x2P, dissimilarity }], ["Expected counts fitted by iterative proportional fitting to the generator margins."]),
        H.tableArtifact("Cell fit and residuals", "Observed and fitted counts with Pearson and deviance residuals.", [COLUMN("cell", "Cell", "string"), ...factorColumns, COLUMN("observed", "Observed"), COLUMN("expected", "Expected"), COLUMN("pearsonResidual", "Pearson residual"), COLUMN("devianceResidual", "Deviance residual")], cellRows, [], "loglinear-cell-table"),
        H.vegaArtifact("loglinear-residual-plot", `Deviance residuals under ${model.canonical}`, { data: { values: cellRows }, layer: [{ mark: { type: "bar" }, encoding: { x: { field: "cell", type: "nominal", sort: null, title: "Cell" }, y: { field: "devianceResidual", type: "quantitative", title: "Deviance residual" }, color: { field: "factorA", type: "nominal", title: parsed.factorLabels[0] }, tooltip: [{ field: "cell" }, { field: "observed" }, { field: "expected", format: ".3f" }, { field: "pearsonResidual", format: ".3f" }, { field: "devianceResidual", format: ".3f" }] } }, { mark: { type: "rule", color: "#7A7672" }, encoding: { y: { datum: 0 } } }] }),
      ],
    };
  },
  linkage: {
    neededWhen: "A two- or three-way count table must be modelled to test conditional independence or homogeneous association rather than a single omnibus association.",
    decision: "Decide which hierarchical association structure fits the table by checking the goodness of fit of a stated generator model.",
    mustShow: "The generator model, G² and X² with degrees of freedom, fitted counts with deviance residuals, and the convergence record.",
    userGoal: "Explain multi-way categorical structure with an explicit model instead of pairwise chi-square tests.",
    nextActions: [
      { trigger: "model-fits-poorly", action: "add-higher-order-generator", reason: "A large G² relative to df means an omitted interaction; move up the hierarchy and compare nested G² differences." },
      { trigger: "model-fits-adequately", action: "interpret-omitted-associations-as-absent", reason: "An adequate fit supports the conditional independences implied by the omitted generators." },
      { trigger: "sparse-fitted-cells", action: "collapse-levels-or-use-exact-methods", reason: "Small expected counts undermine the chi-square approximation for both fit statistics." },
    ],
  },
  fixture: { data: { table: [[[20, 15], [12, 25]], [[18, 22], [9, 10]]], factorLabels: ["Treatment", "Sex", "Outcome"], levelLabels: [["Drug", "Placebo"], ["Female", "Male"], ["Improved", "Not improved"]] }, options: { model: "[AB][AC][BC]" } },
  matlabParity: { taxonomyIds: ["matlab.stats.regression", "matlab.stats.probability-hypothesis"] },
  coverage: {
    implementedBoundary: "Hierarchical log-linear models for 2-way and 3-way tables (≤ 12 levels per factor) fitted by iterative proportional fitting; G², X², residual df, Pearson and deviance residuals; saturated models rejected.",
    oracle: { level: "external-library-partial", evidence: [ORACLE], verifiedOutputs: ["fitted counts", "G² deviance", "Pearson X²", "residual degrees of freedom", "deviance residuals"], excludedOutputs: ["AIC/BIC deltas", "dissimilarity index"] },
    diagnostic: { level: "method-specific-partial", emitted: ["convergence record", "zero fitted cells", "model comparison boundary"], limitations: ["no parameter estimates or standard errors", "no automatic model search"] },
    knownGaps: ["lambda parameter estimates with standard errors", "four-way and higher tables", "structural zeros"],
  },
};

module.exports = {
  methods: [
    mcnemarTest,
    cochranQTest,
    cochranArmitageTrendTest,
    mantelHaenszelTest,
    fisherExactRxc,
    gTest,
    twoByTwoEffectMeasures,
    chiSquareIndependenceResiduals,
    binomialTest,
    poissonRateTest,
    logLinearModel,
  ],
};
