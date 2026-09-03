"use strict";

/**
 * Extended survival family: weighted k-sample log-rank tests with trend, stratified Cox regression with
 * cluster-robust sandwich errors and a scaled-Schoenfeld proportional-hazards test, parametric AFT
 * regression, Aalen-Johansen cumulative incidence with a Gray-type k-sample test, restricted mean
 * survival time, Nelson-Aalen cumulative hazard, and landmark analysis.
 *
 * Pure deterministic JavaScript. Every numeric helper arrives through `H` (engine HELPERS); nothing here
 * requires engine.cjs. Estimator definitions follow the ones documented for the R survival / survRM2 /
 * cmprsk packages and for lifelines, but no equivalence with those packages is claimed beyond the
 * bounded oracle cross-check in contracts/survival-extended-scipy-crosscheck.py.
 */

const MODEL = Object.freeze({ families: ["survival"], distributions: [null], links: [null] });
const ORACLE_FILE = "contracts/survival-extended-scipy-crosscheck.py";
const MAX_COX_ROWS = 5000;
const MAX_STRATA = 200;
const MAX_CAUSES = 8;
const MAX_GRAY_ROWS = 2000;

// ---------------------------------------------------------------------------------------------
// Shared numerics
// ---------------------------------------------------------------------------------------------

function normalSf(H, x) {
  const tail = 0.5 * H.gammaQ(0.5, (x * x) / 2);
  return x >= 0 ? tail : 1 - tail;
}

function twoSidedNormalP(H, z) {
  return Math.min(1, 2 * normalSf(H, Math.abs(z)));
}

function zCritical(H, level) {
  return H.normalInv(1 - (1 - level) / 2);
}

function percent(level) {
  return Math.round(level * 100);
}

function finite(H, value, what, code = "STAT_NUMERIC_FAILURE") {
  if (!Number.isFinite(value)) H.fail(code, `${what} is not finite`);
  return Object.is(value, -0) ? 0 : value;
}

function zeros(n) {
  return Array(n).fill(0);
}

function zeroMatrix(n, m = n) {
  return Array.from({ length: n }, () => Array(m).fill(0));
}

function dot(a, b) {
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += a[i] * b[i];
  return total;
}

function matVec(matrix, vector) {
  return matrix.map((row) => dot(row, vector));
}

function quadratic(vector, matrix) {
  return dot(vector, matVec(matrix, vector));
}

function safeInvert(H, matrix, what) {
  try {
    return H.invert(matrix);
  } catch (error) {
    if (error && error.code === "STAT_SINGULAR_MATRIX") H.fail("STAT_SINGULAR_FIT", `${what} is singular or ill-conditioned`);
    throw error;
  }
}

function logLogInterval(estimate, standardError, z) {
  // complementary log-log interval for a probability in (0, 1)
  if (!(estimate > 0) || !(estimate < 1) || !(standardError > 0)) return { lower: estimate, upper: estimate };
  const seTransformed = standardError / (estimate * Math.abs(Math.log(estimate)));
  const center = Math.log(-Math.log(estimate));
  return { lower: Math.exp(-Math.exp(center + z * seTransformed)), upper: Math.exp(-Math.exp(center - z * seTransformed)) };
}

// ---------------------------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------------------------

const cohortSchema = {
  type: "object",
  additionalProperties: false,
  required: ["time", "event"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 128 },
    time: { type: "array", minItems: 2, maxItems: 10000, items: { type: "number", exclusiveMinimum: 0 } },
    event: { type: "array", minItems: 2, maxItems: 10000, items: { type: "integer", enum: [0, 1] } },
  },
};

function groupsSchema(minItems, maxItems = 64) {
  return { type: "object", additionalProperties: false, required: ["groups"], properties: { groups: { type: "array", minItems, maxItems, items: cohortSchema }, outcomeLabel: { type: "string", minLength: 1, maxLength: 128 } } };
}

function parseCohortGroups(data, H, minimum, maximum = H.LIMITS.maxGroups) {
  H.assertKeys(data, ["groups", "outcomeLabel"], "data");
  if (!Array.isArray(data.groups) || data.groups.length < minimum || data.groups.length > maximum) H.fail("STAT_INVALID_INPUT", `data.groups length must be between ${minimum} and ${maximum}`);
  const names = new Set();
  let total = 0;
  const groups = data.groups.map((raw, index) => {
    const cohort = H.survivalCohort(raw, `data.groups[${index}]`, `Group ${index + 1}`);
    if (names.has(cohort.name)) H.fail("STAT_INVALID_INPUT", `duplicate group name: ${cohort.name}`);
    names.add(cohort.name);
    total += cohort.time.length;
    return cohort;
  });
  if (total > H.LIMITS.maxSurvivalRows) H.fail("STAT_LIMIT_EXCEEDED", `survival rows exceed ${H.LIMITS.maxSurvivalRows}`);
  return { groups, outcomeLabel: H.label(data.outcomeLabel, "Survival", "data.outcomeLabel") };
}

function parseTimeEvent(data, H, maxRows, minRows = 5) {
  const time = H.numericVector(data.time, "data.time", minRows);
  if (time.length > maxRows) H.fail("STAT_LIMIT_EXCEEDED", `data.time exceeds ${maxRows} rows`);
  if (time.some((value) => value <= 0)) H.fail("STAT_INVALID_INPUT", "data.time must contain only positive durations");
  if (!Array.isArray(data.event) || data.event.length !== time.length) H.fail("STAT_INVALID_INPUT", "data.event must match data.time length");
  const event = data.event.map((value, index) => H.integer(value, 0, 1, `data.event[${index}]`));
  if (H.sum(event) === 0) H.fail("STAT_DEGENERATE", "data.event must contain at least one observed event");
  return { time, event };
}

function parseLabels(raw, n, path, H) {
  if (raw === undefined) return null;
  const values = H.categoryVector(raw, path, 2);
  if (values.length !== n) H.fail("STAT_INVALID_INPUT", `${path} length must match data.time`);
  return values;
}

function levelsOf(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, "en"));
}

// ---------------------------------------------------------------------------------------------
// Risk-set table and weighted log-rank core (k groups)
// ---------------------------------------------------------------------------------------------

function riskTable(groups, budget) {
  // groups: [{ name, time[], event[] }]; returns distinct pooled times with per-group at-risk / event / censor counts
  const k = groups.length;
  const sortedGroups = groups.map((group) => group.time.map((time, index) => ({ time, event: group.event[index] })).sort((a, b) => a.time - b.time || b.event - a.event));
  const allTimes = [...new Set(groups.flatMap((group) => group.time))].sort((a, b) => a - b);
  const cursors = zeros(k);
  const atRisk = sortedGroups.map((rows) => rows.length);
  const rows = [];
  for (const time of allTimes) {
    budget.check();
    const nij = atRisk.slice();
    const dij = zeros(k);
    const cij = zeros(k);
    for (let j = 0; j < k; j += 1) {
      while (cursors[j] < sortedGroups[j].length && sortedGroups[j][cursors[j]].time === time) {
        if (sortedGroups[j][cursors[j]].event === 1) dij[j] += 1;
        else cij[j] += 1;
        cursors[j] += 1;
      }
      atRisk[j] -= dij[j] + cij[j];
    }
    rows.push({ time, n: H_sum(nij), nij, d: H_sum(dij), dij, c: H_sum(cij), cij });
  }
  return rows;
}

function H_sum(values) {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function pooledKaplanMeier(table) {
  // left-continuous S(t-) and right-continuous S(t) at each table row
  const before = [];
  const after = [];
  let survival = 1;
  for (const row of table) {
    before.push(survival);
    if (row.d > 0 && row.n > 0) survival *= 1 - row.d / row.n;
    after.push(survival);
  }
  return { before, after };
}

function logRankWeights(table, weighting, p, q) {
  const km = pooledKaplanMeier(table);
  let peto = 1;
  return table.map((row, index) => {
    switch (weighting) {
      case "gehan": return row.n;
      case "tarone-ware": return Math.sqrt(row.n);
      case "peto": {
        peto *= 1 - row.d / (row.n + 1);
        return peto;
      }
      case "fleming-harrington": {
        const s = km.before[index];
        const first = p === 0 ? 1 : Math.pow(s, p);
        const second = q === 0 ? 1 : Math.pow(1 - s, q);
        return first * second;
      }
      default: return 1;
    }
  });
}

function weightedLogRankCore(groups, weighting, p, q, budget, H) {
  const k = groups.length;
  const table = riskTable(groups, budget);
  const weights = logRankWeights(table, weighting, p, q);
  const observed = zeros(k);
  const expected = zeros(k);
  const weightedObserved = zeros(k);
  const weightedExpected = zeros(k);
  const covariance = zeroMatrix(k);
  const timeRows = [];
  let informativeTimes = 0;
  let tiedEventTimes = 0;
  table.forEach((row, index) => {
    budget.check();
    if (row.d === 0 || row.n === 0) return;
    informativeTimes += 1;
    if (row.d > 1) tiedEventTimes += 1;
    const w = weights[index];
    const factor = row.n > 1 ? (row.d * (row.n - row.d)) / (row.n * row.n * (row.n - 1)) : 0;
    for (let j = 0; j < k; j += 1) {
      const e = (row.d * row.nij[j]) / row.n;
      observed[j] += row.dij[j];
      expected[j] += e;
      weightedObserved[j] += w * row.dij[j];
      weightedExpected[j] += w * e;
      for (let l = 0; l < k; l += 1) {
        const kronecker = j === l ? 1 : 0;
        covariance[j][l] += w * w * row.nij[j] * (kronecker * row.n - row.nij[l]) * factor;
      }
    }
    timeRows.push({ time: row.time, atRisk: row.n, events: row.d, weight: w, ...Object.fromEntries(row.nij.flatMap((n, j) => [[`atRisk_${j}`, n], [`events_${j}`, row.dij[j]], [`expected_${j}`, (row.d * n) / row.n]])) });
  });
  const z = weightedObserved.map((value, j) => value - weightedExpected[j]);
  const reduced = z.slice(0, k - 1);
  const reducedCovariance = covariance.slice(0, k - 1).map((row) => row.slice(0, k - 1));
  if (k > 1 && reducedCovariance.some((row) => row.some((value) => !Number.isFinite(value)))) H.fail("STAT_NUMERIC_FAILURE", "log-rank covariance is not finite");
  let statistic = 0;
  if (k > 1) {
    if (reducedCovariance.every((row) => row.every((value) => value === 0))) H.fail("STAT_DEGENERATE", "log-rank covariance is zero; groups cannot be compared");
    const inverse = safeInvert(H, reducedCovariance, "log-rank covariance");
    statistic = Math.max(0, quadratic(reduced, inverse));
  }
  return { table, weights, observed, expected, weightedObserved, weightedExpected, z, covariance, statistic, df: k - 1, pValue: k > 1 ? H.pFromChiSquare(statistic, k - 1) : null, informativeTimes, tiedEventTimes, timeRows };
}

function trendTest(core, scores, H) {
  const k = core.z.length;
  const numerator = dot(scores, core.z);
  const varianceValue = quadratic(scores, core.covariance);
  if (!(varianceValue > 0)) H.fail("STAT_DEGENERATE", "trend-test variance is zero; the supplied scores do not separate the groups");
  const z = numerator / Math.sqrt(varianceValue);
  return { statistic: z * z, z, pValue: H.pFromChiSquare(z * z, 1), scores, weightedContrast: numerator, variance: varianceValue, groups: k };
}

const kmColumns = [
  { key: "group", label: "Group", type: "string" },
  { key: "time", label: "Time", type: "number" },
  { key: "nAtRisk", label: "At risk", type: "number" },
  { key: "events", label: "Events", type: "number" },
  { key: "censored", label: "Censored", type: "number" },
  { key: "survival", label: "Survival", type: "number" },
  { key: "standardError", label: "SE", type: "number" },
  { key: "lower", label: "CI lower", type: "number" },
  { key: "upper", label: "CI upper", type: "number" },
];

function kmRows(groups, level, budget, H) {
  return groups.map((group) => H.kaplanMeierCore(group.time, group.event, group.name, level, budget));
}

function kmCurveFigure(H, role, title, rows, description, extraLayers = []) {
  const color = { field: "group", type: "nominal", title: "Group" };
  return H.vegaArtifact(role, title, {
    data: { values: rows },
    layer: [
      { mark: { type: "area", opacity: 0.14, interpolate: "step-after" }, encoding: { x: { field: "time", type: "quantitative", title: "Time" }, y: { field: "lower", type: "quantitative", scale: { domain: [0, 1] }, title: "Survival probability" }, y2: { field: "upper" }, color } },
      { mark: { type: "line", interpolate: "step-after", strokeWidth: 2.5 }, encoding: { x: { field: "time", type: "quantitative" }, y: { field: "survival", type: "quantitative" }, color, tooltip: [{ field: "group" }, { field: "time", format: ".4g" }, { field: "nAtRisk" }, { field: "survival", format: ".4f" }, { field: "lower", format: ".4f" }, { field: "upper", format: ".4f" }] } },
      { transform: [{ filter: "datum.censored > 0" }], mark: { type: "point", shape: "cross", size: 55 }, encoding: { x: { field: "time", type: "quantitative" }, y: { field: "survival", type: "quantitative" }, color } },
      ...extraLayers,
    ],
    config: { axis: { grid: true } },
    description,
  });
}

// ---------------------------------------------------------------------------------------------
// 1. Weighted log-rank family
// ---------------------------------------------------------------------------------------------

const WEIGHTINGS = ["log-rank", "gehan", "tarone-ware", "peto", "fleming-harrington"];

const weightedLogRank = {
  method: "weighted_log_rank",
  family: "survival",
  analysisModel: MODEL,
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    weighting: {
      schema: { type: "string", enum: WEIGHTINGS },
      default: "log-rank",
      parse(value, H, path) { if (!WEIGHTINGS.includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be one of ${WEIGHTINGS.join(", ")}`); return value; },
    },
    flemingP: { schema: { type: "number", minimum: 0, maximum: 10 }, default: 1, parse(value, H, path) { const v = H.finiteNumber(value, path); if (v < 0 || v > 10) H.fail("STAT_INVALID_INPUT", `${path} must lie in [0, 10]`); return v; } },
    flemingQ: { schema: { type: "number", minimum: 0, maximum: 10 }, default: 0, parse(value, H, path) { const v = H.finiteNumber(value, path); if (v < 0 || v > 10) H.fail("STAT_INVALID_INPUT", `${path} must lie in [0, 10]`); return v; } },
    trendScores: {
      schema: { type: ["array", "null"], minItems: 2, maxItems: 64, items: { type: "number" } },
      default: null,
      parse(value, H, path) {
        if (value === null) return null;
        if (!Array.isArray(value)) H.fail("STAT_INVALID_INPUT", `${path} must be an array of numeric scores or null`);
        return value.map((item, index) => H.finiteNumber(item, `${path}[${index}]`));
      },
    },
  },
  dataSchema: groupsSchema(2),
  parse(data, options, H) {
    const parsed = parseCohortGroups(data, H, 2);
    if (options.trendScores !== null) {
      if (options.trendScores.length !== parsed.groups.length) H.fail("STAT_INVALID_INPUT", "options.trendScores length must equal the number of groups");
      if (new Set(options.trendScores).size < 2) H.fail("STAT_INVALID_INPUT", "options.trendScores must not all be equal");
    }
    return parsed;
  },
  analyze(parsed, options, budget, H) {
    const groups = parsed.groups;
    const k = groups.length;
    const core = weightedLogRankCore(groups, options.weighting, options.flemingP, options.flemingQ, budget, H);
    const scores = options.trendScores === null ? groups.map((_, index) => index) : options.trendScores;
    const trend = trendTest(core, scores, H);
    const curves = kmRows(groups, options.confidenceLevel, budget, H);
    const curveRows = curves.flatMap((curve) => curve.curve.slice(1).map(({ greenwoodVariance, ...row }) => row));
    const weightLabel = options.weighting === "fleming-harrington" ? `Fleming-Harrington(p=${options.flemingP}, q=${options.flemingQ})` : options.weighting;
    const groupRows = groups.map((group, j) => ({ group: group.name, n: group.time.length, events: core.observed[j], expected: core.expected[j], weightedObserved: core.weightedObserved[j], weightedExpected: core.weightedExpected[j], weightedObservedMinusExpected: core.z[j], score: scores[j], medianSurvival: curves[j].medianSurvival }));
    const timeColumns = [
      { key: "time", label: "Time", type: "number" }, { key: "atRisk", label: "At risk (all)", type: "number" }, { key: "events", label: "Events (all)", type: "number" }, { key: "weight", label: "Weight", type: "number" },
      ...groups.flatMap((group, j) => [{ key: `atRisk_${j}`, label: `At risk: ${group.name}`, type: "number" }, { key: `events_${j}`, label: `Events: ${group.name}`, type: "number" }, { key: `expected_${j}`, label: `Expected: ${group.name}`, type: "number" }]),
    ];
    return {
      sample: { groups: groups.map((group, j) => ({ name: group.name, n: group.time.length, events: core.observed[j], censored: group.time.length - core.observed[j] })), totalN: groups.reduce((total, group) => total + group.time.length, 0), informativeTimes: core.informativeTimes },
      estimates: groupRows.map((row) => ({ name: `${row.group} weighted observed minus expected`, estimate: row.weightedObservedMinusExpected, observed: row.events, expected: row.expected, medianSurvival: row.medianSurvival })),
      tests: [
        { name: `${weightLabel} ${k}-sample test`, statistic: core.statistic, distribution: "chi-square", df: core.df, pValue: core.pValue, weighting: options.weighting },
        { name: `${weightLabel} trend test across ordered groups`, statistic: trend.statistic, distribution: "chi-square", df: 1, pValue: trend.pValue, z: trend.z, scores },
      ],
      confidenceIntervals: [],
      effectSizes: groupRows.map((row) => ({ name: `${row.group} observed / expected events`, estimate: row.expected > 0 ? row.events / row.expected : null, interpretation: "unweighted O/E ratio; not a hazard ratio" })),
      assumptions: [{ name: "independent groups and observations", status: "requires_design_review" }, { name: "non-informative right censoring", status: "requires_design_review" }, { name: "weight function chosen a priori", status: "requires_design_review", detail: "early-weighted tests (Gehan, Tarone-Ware, Peto) and late-weighted tests (Fleming-Harrington q > 0) answer different alternatives" }, { name: "group order for the trend test fixed a priori", status: options.trendScores === null ? "default_scores_follow_input_order" : "scores_supplied" }],
      diagnostics: [
        { name: "event-time accounting", informativeTimes: core.informativeTimes, tiedEventTimes: core.tiedEventTimes, tieVariance: "hypergeometric", policy: "events precede censor removals at a shared time" },
        { name: "weight function", status: "method_definition", weighting: options.weighting, detail: options.weighting === "peto" ? "Peto-Prentice modified survival estimate prod(1 - d/(n + 1)) evaluated at each event time" : options.weighting === "fleming-harrington" ? "pooled left-continuous Kaplan-Meier S(t-)^p (1 - S(t-))^q" : options.weighting === "gehan" ? "number at risk" : options.weighting === "tarone-ware" ? "square root of the number at risk" : "unit weights" },
        { name: "effect boundary", status: "no_hazard_ratio_estimated", reason: "weighted log-rank tests do not identify a constant hazard ratio; fit a Cox model for effect estimation" },
        { name: "trend test", status: "asymptotic", contrast: trend.weightedContrast, variance: trend.variance, scores },
      ],
      artifacts: [
        H.tableArtifact(`${weightLabel} test: ${parsed.outcomeLabel}`, `Weighted k-sample comparison of ${k} groups.`, [{ key: "group", label: "Group", type: "string" }, { key: "n", label: "n", type: "number" }, { key: "events", label: "Observed", type: "number" }, { key: "expected", label: "Expected", type: "number" }, { key: "weightedObserved", label: "Weighted observed", type: "number" }, { key: "weightedExpected", label: "Weighted expected", type: "number" }, { key: "weightedObservedMinusExpected", label: "Weighted O-E", type: "number" }, { key: "score", label: "Trend score", type: "number" }, { key: "medianSurvival", label: "Median survival", type: "number" }], groupRows, [`Chi-square(${core.df}) = ${core.statistic}, p = ${core.pValue}; trend chi-square(1) = ${trend.statistic}, p = ${trend.pValue}.`]),
        H.tableArtifact("Risk table at event times", "Pooled at-risk counts, events, expected events, and the weight applied at each event time.", timeColumns, core.timeRows, [], "weighted-log-rank-risk-table"),
        H.tableArtifact("Kaplan-Meier estimates by group", `${percent(options.confidenceLevel)}% pointwise Greenwood log-log confidence intervals.`, kmColumns, curveRows, [], "weighted-log-rank-km-table"),
        kmCurveFigure(H, "weighted-log-rank-km-curves", `Kaplan-Meier survival by group (${weightLabel} test)`, curveRows, `Kaplan-Meier estimates with ${percent(options.confidenceLevel)}% log-log Greenwood intervals; the ${weightLabel} test weights differences by ${options.weighting === "log-rank" ? "unit weights" : "a time-varying weight function"}.`),
      ],
    };
  },
  linkage: {
    neededWhen: "Two or more survival curves must be compared and the researcher expects the difference to concentrate early (crossing risk sets, early toxicity) or late (delayed treatment effects), or the groups are ordered and a trend is the question.",
    decision: "Decide whether the survival distributions differ under the chosen weighting, and whether survival changes monotonically across ordered groups.",
    mustShow: "Observed and expected events per group, the weighted O-E vector, the k-sample chi-square with its weighting, the trend statistic with the scores used, and the Kaplan-Meier curves.",
    userGoal: "Report a defensible k-sample survival comparison whose weight function matches the pre-specified alternative rather than defaulting to the plain log-rank test.",
    nextActions: [
      { trigger: "curves-cross", action: "report-weighted-and-unweighted-tests-and-avoid-hazard-ratio-summary", reason: "Crossing curves violate proportional hazards; a single hazard ratio misrepresents the difference." },
      { trigger: "test-significant", action: "fit-cox-or-aft-model-for-effect-size", reason: "Weighted log-rank tests deliver a p value, not an effect estimate with an interval." },
      { trigger: "ordered-groups", action: "report-trend-test-with-scores", reason: "A monotone dose or stage effect is better summarized by the one-degree-of-freedom trend contrast." },
      { trigger: "heavy-early-censoring", action: "prefer-peto-or-fleming-harrington-over-gehan", reason: "Gehan weights depend on the censoring pattern and can be misleading when censoring differs between groups." },
    ],
  },
  fixture: {
    data: { groups: [
      { name: "control", time: [3, 5, 6, 8, 9, 11, 12, 14, 15, 18, 20, 22], event: [1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1] },
      { name: "low dose", time: [4, 7, 9, 10, 13, 14, 16, 19, 21, 24, 26, 28], event: [1, 1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 0] },
      { name: "high dose", time: [6, 10, 12, 15, 17, 19, 22, 25, 27, 30, 32, 35], event: [0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0] },
    ], outcomeLabel: "Progression-free survival" },
    options: { weighting: "fleming-harrington", flemingP: 1, flemingQ: 0, confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.distribution"] },
  coverage: {
    implementedBoundary: "k-sample (2-64 groups) weighted log-rank tests with log-rank, Gehan (Wilcoxon), Tarone-Ware, Peto-Prentice, and Fleming-Harrington(p, q) weights, hypergeometric covariance, and a one-degree-of-freedom trend contrast over supplied or default ordered scores.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["k-sample chi-square and p value for every weighting (lifelines multivariate_logrank_test)", "weighted O-E vector", "trend chi-square (numpy first principles on the same covariance)", "Kaplan-Meier curves (engine core)"], excludedOutputs: ["stratified log-rank", "permutation p values"] },
    diagnostic: { level: "method-specific-partial", emitted: ["tie accounting", "weight function definition", "trend contrast variance"], limitations: ["no proportional-hazards diagnostic", "no stratification"] },
    knownGaps: ["no stratified weighted log-rank", "no Renyi supremum test for crossing curves"],
  },
};

// ---------------------------------------------------------------------------------------------
// 2. Stratified Cox regression with robust errors and PH test
// ---------------------------------------------------------------------------------------------

function coxStratumState(beta, rows, ties, budget, H, wantResiduals) {
  // rows sorted by time ascending within one stratum; each row { time, event, x[], index, weight }
  const p = beta.length;
  const n = rows.length;
  const eta = rows.map((row) => dot(row.x, beta));
  if (eta.some((value) => !Number.isFinite(value) || Math.abs(value) > 700)) H.fail("STAT_NON_CONVERGENCE", "Cox linear predictor diverged");
  const shift = Math.max(...eta);
  const weight = eta.map((value) => Math.exp(value - shift));
  let logLikelihood = 0;
  const score = zeros(p);
  const information = zeroMatrix(p);
  const schoenfeld = [];
  const blocks = [];
  let tiedEventTimes = 0;
  // sweep from the largest time downwards to accumulate risk-set sums
  let s0 = 0;
  const s1 = zeros(p);
  const s2 = zeroMatrix(p);
  let end = n;
  while (end > 0) {
    budget.check();
    let start = end - 1;
    while (start > 0 && rows[start - 1].time === rows[end - 1].time) start -= 1;
    const block = [];
    for (let i = start; i < end; i += 1) {
      budget.check();
      block.push(i);
      s0 += weight[i];
      for (let j = 0; j < p; j += 1) {
        s1[j] += weight[i] * rows[i].x[j];
        for (let l = 0; l < p; l += 1) s2[j][l] += weight[i] * rows[i].x[j] * rows[i].x[l];
      }
    }
    const deaths = block.filter((i) => rows[i].event === 1);
    const d = deaths.length;
    if (d > 0) {
      if (d > 1) tiedEventTimes += 1;
      let e0 = 0;
      const e1 = zeros(p);
      const e2 = zeroMatrix(p);
      for (const i of deaths) {
        logLikelihood += eta[i];
        e0 += weight[i];
        for (let j = 0; j < p; j += 1) {
          score[j] += rows[i].x[j];
          e1[j] += weight[i] * rows[i].x[j];
          for (let l = 0; l < p; l += 1) e2[j][l] += weight[i] * rows[i].x[j] * rows[i].x[l];
        }
      }
      const repeats = ties === "efron" ? d : 1;
      const multiplicity = ties === "efron" ? 1 : d;
      const means = [];
      let inverseDenominatorSum = 0;
      const meanOverDenominatorSum = zeros(p);
      let efronInverseSum = 0;
      const efronMeanSum = zeros(p);
      for (let r = 0; r < repeats; r += 1) {
        const fraction = ties === "efron" ? r / d : 0;
        const denominator = s0 - fraction * e0;
        if (!(denominator > 1e-300)) H.fail("STAT_NUMERIC_FAILURE", "Cox risk-set denominator is non-positive");
        logLikelihood -= multiplicity * (Math.log(denominator) + shift);
        const expected = zeros(p);
        for (let j = 0; j < p; j += 1) expected[j] = (s1[j] - fraction * e1[j]) / denominator;
        for (let j = 0; j < p; j += 1) {
          score[j] -= multiplicity * expected[j];
          for (let l = 0; l < p; l += 1) {
            information[j][l] += multiplicity * ((s2[j][l] - fraction * e2[j][l]) / denominator - expected[j] * expected[l]);
          }
        }
        means.push(expected);
        inverseDenominatorSum += multiplicity / denominator;
        for (let j = 0; j < p; j += 1) meanOverDenominatorSum[j] += multiplicity * expected[j] / denominator;
        efronInverseSum += fraction / denominator;
        for (let j = 0; j < p; j += 1) efronMeanSum[j] += fraction * expected[j] / denominator;
      }
      const averageMean = zeros(p);
      for (const expected of means) for (let j = 0; j < p; j += 1) averageMean[j] += expected[j] / means.length;
      if (wantResiduals) {
        for (const i of deaths) schoenfeld.push({ index: rows[i].index, time: rows[i].time, values: rows[i].x.map((value, j) => value - averageMean[j]) });
      }
      blocks.push({ time: rows[start].time, start, end, deaths, averageMean, inverseDenominatorSum, meanOverDenominatorSum, efronInverseSum, efronMeanSum, shiftFactor: Math.exp(-shift) });
    }
    end = start;
  }
  let scoreResiduals = null;
  if (wantResiduals) {
    // Efron/Breslow score residuals: L_i = delta_i (x_i - mean_l xbar_l) - w_i sum_{t_j <= t_i} sum_l c_il (x_i - xbar_l) / S0_l
    blocks.sort((a, b) => a.time - b.time);
    scoreResiduals = Array(n);
    let cumulativeInverse = 0;
    const cumulativeMean = zeros(p);
    let blockCursor = 0;
    const deathBlock = new Map();
    for (const block of blocks) for (const i of block.deaths) deathBlock.set(i, block);
    // rows ascending; walk rows and blocks together
    const rowOrder = rows.map((_, i) => i);
    for (const i of rowOrder) {
      budget.check();
      while (blockCursor < blocks.length && blocks[blockCursor].time <= rows[i].time) {
        cumulativeInverse += blocks[blockCursor].inverseDenominatorSum;
        for (let j = 0; j < p; j += 1) cumulativeMean[j] += blocks[blockCursor].meanOverDenominatorSum[j];
        blockCursor += 1;
      }
      const residual = zeros(p);
      for (let j = 0; j < p; j += 1) residual[j] = -weight[i] * (rows[i].x[j] * cumulativeInverse - cumulativeMean[j]);
      if (rows[i].event === 1) {
        const block = deathBlock.get(i);
        for (let j = 0; j < p; j += 1) {
          residual[j] += rows[i].x[j] - block.averageMean[j];
          residual[j] += weight[i] * (rows[i].x[j] * block.efronInverseSum - block.efronMeanSum[j]);
        }
      }
      scoreResiduals[i] = { index: rows[i].index, values: residual };
    }
  }
  return { logLikelihood, score, information, schoenfeld, scoreResiduals, tiedEventTimes };
}

function coxState(beta, strata, ties, budget, H, wantResiduals = false) {
  const p = beta.length;
  let logLikelihood = 0;
  const score = zeros(p);
  const information = zeroMatrix(p);
  const schoenfeld = [];
  const scoreResiduals = [];
  let tiedEventTimes = 0;
  for (const rows of strata) {
    const state = coxStratumState(beta, rows, ties, budget, H, wantResiduals);
    logLikelihood += state.logLikelihood;
    for (let j = 0; j < p; j += 1) {
      score[j] += state.score[j];
      for (let l = 0; l < p; l += 1) information[j][l] += state.information[j][l];
    }
    tiedEventTimes += state.tiedEventTimes;
    if (wantResiduals) {
      schoenfeld.push(...state.schoenfeld);
      scoreResiduals.push(...state.scoreResiduals);
    }
  }
  return { logLikelihood, score, information, schoenfeld, scoreResiduals, tiedEventTimes };
}

function fitCox(strata, p, options, budget, H) {
  let beta = zeros(p);
  const nullState = coxState(beta, strata, options.ties, budget, H);
  let current = nullState;
  let converged = false;
  let iterations = 0;
  for (iterations = 1; iterations <= options.maxIterations; iterations += 1) {
    budget.check(2048);
    const inverse = safeInvert(H, current.information, "Cox information matrix");
    const direction = matVec(inverse, current.score);
    let factor = 1;
    let next = null;
    let candidate = null;
    while (factor >= 1 / 1024) {
      candidate = beta.map((value, index) => value + factor * direction[index]);
      if (candidate.some((value) => !Number.isFinite(value) || Math.abs(value) > 30)) { factor /= 2; continue; }
      next = coxState(candidate, strata, options.ties, budget, H);
      if (next.logLikelihood >= current.logLikelihood - 1e-10) break;
      next = null;
      factor /= 2;
    }
    if (!next) H.fail("STAT_NON_CONVERGENCE", "Cox partial-likelihood line search failed");
    const delta = Math.max(...candidate.map((value, index) => Math.abs(value - beta[index])));
    beta = candidate;
    current = next;
    if (delta < options.tolerance && Math.max(...current.score.map(Math.abs)) < Math.sqrt(options.tolerance)) { converged = true; break; }
  }
  if (!converged) H.fail("STAT_NON_CONVERGENCE", `Cox regression did not converge in ${options.maxIterations} iterations`);
  const finalState = coxState(beta, strata, options.ties, budget, H, true);
  return { beta, nullState, finalState, iterations };
}

function pooledKmAtTimes(time, event, budget) {
  // right-continuous pooled Kaplan-Meier evaluated at each supplied time (map time -> S(t))
  const rows = time.map((value, index) => ({ time: value, event: event[index] })).sort((a, b) => a.time - b.time);
  const survivalAt = new Map();
  let survival = 1;
  for (let start = 0; start < rows.length;) {
    budget.check();
    let end = start + 1;
    while (end < rows.length && rows[end].time === rows[start].time) end += 1;
    let deaths = 0;
    for (let i = start; i < end; i += 1) deaths += rows[i].event;
    const atRisk = rows.length - start;
    if (deaths > 0) survival *= 1 - deaths / atRisk;
    survivalAt.set(rows[start].time, survival);
    start = end;
  }
  return survivalAt;
}

const TIME_TRANSFORMS = ["km", "rank", "log", "identity"];

function proportionalHazardsTest(schoenfeld, variance, transform, pooledKm, H) {
  const d = schoenfeld.length;
  const p = variance.length;
  if (d < 3) return { status: "not_evaluated", reason: "requires at least three events" };
  const sorted = schoenfeld.slice().sort((a, b) => a.time - b.time);
  let g;
  if (transform === "km") g = sorted.map((row) => 1 - pooledKm.get(row.time));
  else if (transform === "log") g = sorted.map((row) => Math.log(row.time));
  else if (transform === "identity") g = sorted.map((row) => row.time);
  else g = H.averageRanks(sorted.map((row) => row.time)).ranks;
  const gMean = g.reduce((total, value) => total + value, 0) / d;
  const centered = g.map((value) => value - gMean);
  const spread = centered.reduce((total, value) => total + value * value, 0);
  if (!(spread > 0)) return { status: "not_evaluated", reason: "transformed event times are constant" };
  const u = zeros(p);
  sorted.forEach((row, i) => { for (let j = 0; j < p; j += 1) u[j] += centered[i] * row.values[j]; });
  const scaled = sorted.map((row, i) => ({ time: row.time, transformedTime: g[i], index: row.index, raw: row.values, scaled: matVec(variance, row.values).map((value) => d * value) }));
  const vu = matVec(variance, u);
  const perTerm = u.map((_, j) => {
    const numerator = Math.pow(d * vu[j], 2);
    const denominator = d * variance[j][j] * spread;
    const statistic = denominator > 0 ? numerator / denominator : 0;
    return { statistic, df: 1, pValue: H.pFromChiSquare(statistic, 1), correlation: null };
  });
  // correlation between transformed time and scaled residual (diagnostic only)
  for (let j = 0; j < p; j += 1) {
    const values = scaled.map((row) => row.scaled[j]);
    const meanValue = values.reduce((total, value) => total + value, 0) / d;
    let sxy = 0;
    let syy = 0;
    values.forEach((value, i) => { sxy += centered[i] * (value - meanValue); syy += (value - meanValue) ** 2; });
    perTerm[j].correlation = syy > 0 ? sxy / Math.sqrt(spread * syy) : 0;
  }
  const global = d * dot(u, vu) / spread;
  return { status: "evaluated", transform, events: d, perTerm, global: { statistic: global, df: p, pValue: H.pFromChiSquare(global, p) }, scaled };
}

const stratifiedCox = {
  method: "stratified_cox",
  family: "survival",
  analysisModel: MODEL,
  optionKeys: ["confidenceLevel", "ties", "maxIterations", "tolerance", "timeoutMs"],
  customOptions: {
    robust: { schema: { type: "boolean" }, default: false, parse(value, H, path) { if (typeof value !== "boolean") H.fail("STAT_INVALID_INPUT", `${path} must be boolean`); return value; } },
    timeTransform: { schema: { type: "string", enum: TIME_TRANSFORMS }, default: "km", parse(value, H, path) { if (!TIME_TRANSFORMS.includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be one of ${TIME_TRANSFORMS.join(", ")}`); return value; } },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["time", "event", "predictors"],
    properties: {
      time: { type: "array", minItems: 8, maxItems: 5000, items: { type: "number", exclusiveMinimum: 0 } },
      event: { type: "array", minItems: 8, maxItems: 5000, items: { type: "integer", enum: [0, 1] } },
      predictors: { type: "array", minItems: 1, maxItems: 16, items: { type: "object", additionalProperties: false, required: ["values"], properties: { name: { type: "string", minLength: 1, maxLength: 128 }, values: { type: "array", minItems: 8, maxItems: 5000, items: { type: "number" } } } } },
      strata: { type: "array", minItems: 8, maxItems: 5000, items: { type: "string", minLength: 1, maxLength: 128 } },
      cluster: { type: "array", minItems: 8, maxItems: 5000, items: { type: "string", minLength: 1, maxLength: 128 } },
      outcomeLabel: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["time", "event", "predictors", "strata", "cluster", "outcomeLabel"], "data");
    const { time, event } = parseTimeEvent(data, H, MAX_COX_ROWS, 8);
    const predictors = H.survivalPredictors(data.predictors, time.length);
    const strata = parseLabels(data.strata, time.length, "data.strata", H);
    const cluster = parseLabels(data.cluster, time.length, "data.cluster", H);
    if (strata && levelsOf(strata).length > MAX_STRATA) H.fail("STAT_LIMIT_EXCEEDED", `data.strata supports at most ${MAX_STRATA} levels`);
    const x = time.map((_, row) => predictors.map((predictor) => predictor.values[row]));
    for (const predictor of predictors) {
      const values = predictor.values;
      if (values.every((value) => value === values[0])) H.fail("STAT_DEGENERATE", `predictor ${predictor.name} is constant and carries no contrast`);
    }
    const columnMeans = predictors.map((_, column) => x.reduce((total, row) => total + row[column], 0) / x.length);
    const centered = x.map((row) => row.map((value, column) => value - columnMeans[column]));
    if (H.matrixRank(centered) < predictors.length) H.fail("STAT_RANK_DEFICIENT", "predictors are collinear after centering; the Cox partial likelihood cannot separate them");
    return { time, event, predictors, strata, cluster, outcomeLabel: H.label(data.outcomeLabel, "Survival", "data.outcomeLabel") };
  },
  analyze(parsed, options, budget, H) {
    const n = parsed.time.length;
    const p = parsed.predictors.length;
    const centers = parsed.predictors.map((predictor) => H.mean(predictor.values, budget));
    const scales = parsed.predictors.map((predictor) => Math.sqrt(H.variance(predictor.values, true, budget)));
    if (scales.some((scale) => !(scale > 0))) H.fail("STAT_DEGENERATE", "a predictor has zero variance");
    const strataLevels = parsed.strata ? levelsOf(parsed.strata) : ["(all)"];
    const strataRows = strataLevels.map(() => []);
    for (let i = 0; i < n; i += 1) {
      const s = parsed.strata ? strataLevels.indexOf(parsed.strata[i]) : 0;
      strataRows[s].push({ time: parsed.time[i], event: parsed.event[i], x: parsed.predictors.map((predictor, j) => (predictor.values[i] - centers[j]) / scales[j]), index: i });
    }
    for (const rows of strataRows) rows.sort((a, b) => a.time - b.time || b.event - a.event || a.index - b.index);
    const strataSummary = strataLevels.map((level, s) => ({ stratum: level, n: strataRows[s].length, events: strataRows[s].reduce((total, row) => total + row.event, 0) }));
    if (strataSummary.every((row) => row.events === 0)) H.fail("STAT_DEGENERATE", "no stratum contains an observed event");
    const fit = fitCox(strataRows, p, options, budget, H);
    const naiveScaled = safeInvert(H, fit.finalState.information, "Cox information matrix");
    // back-transform to original predictor units
    const beta = fit.beta.map((value, j) => value / scales[j]);
    const naive = naiveScaled.map((row, j) => row.map((value, l) => value / (scales[j] * scales[l])));
    const useRobust = options.robust || parsed.cluster !== null;
    let robust = null;
    let clusterCount = null;
    if (useRobust) {
      const clusterLevels = parsed.cluster ? levelsOf(parsed.cluster) : null;
      clusterCount = clusterLevels ? clusterLevels.length : n;
      const sums = new Map();
      for (const residual of fit.finalState.scoreResiduals) {
        budget.check();
        const key = clusterLevels ? parsed.cluster[residual.index] : residual.index;
        const scaledResidual = residual.values.map((value, j) => value * scales[j]);
        const delta = matVec(naive, scaledResidual);
        const existing = sums.get(key) || zeros(p);
        for (let j = 0; j < p; j += 1) existing[j] += delta[j];
        sums.set(key, existing);
      }
      robust = zeroMatrix(p);
      for (const delta of sums.values()) for (let j = 0; j < p; j += 1) for (let l = 0; l < p; l += 1) robust[j][l] += delta[j] * delta[l];
    }
    const reported = useRobust ? robust : naive;
    const critical = zCritical(H, options.confidenceLevel);
    const coefficients = parsed.predictors.map((predictor, j) => {
      const estimate = beta[j];
      const naiveSe = Math.sqrt(Math.max(0, naive[j][j]));
      const robustSe = useRobust ? Math.sqrt(Math.max(0, robust[j][j])) : null;
      const standardError = useRobust ? robustSe : naiveSe;
      if (!(standardError > 0)) H.fail("STAT_DEGENERATE", `Cox standard error is zero for ${predictor.name}`);
      const statistic = estimate / standardError;
      const lower = estimate - critical * standardError;
      const upper = estimate + critical * standardError;
      if ([estimate, lower, upper].some((value) => Math.abs(value) > 700)) H.fail("STAT_NON_CONVERGENCE", `Cox hazard ratio scale diverged for ${predictor.name}`);
      return { term: predictor.name, estimate, standardError, naiveStandardError: naiveSe, robustStandardError: robustSe, statistic, pValue: twoSidedNormalP(H, statistic), lower, upper, hazardRatio: Math.exp(estimate), hazardRatioLower: Math.exp(lower), hazardRatioUpper: Math.exp(upper) };
    });
    const likelihoodRatio = Math.max(0, 2 * (fit.finalState.logLikelihood - fit.nullState.logLikelihood));
    const waldGlobal = quadratic(beta, safeInvert(H, reported, "Cox covariance"));
    const scoreGlobal = quadratic(fit.nullState.score, safeInvert(H, fit.nullState.information, "null Cox information"));
    // PH test on original-unit Schoenfeld residuals with the naive covariance (Grambsch-Therneau scaled residuals)
    const schoenfeld = fit.finalState.schoenfeld.map((row) => ({ index: row.index, time: row.time, values: row.values.map((value, j) => value * scales[j]) }));
    const pooledKm = pooledKmAtTimes(parsed.time, parsed.event, budget);
    const ph = proportionalHazardsTest(schoenfeld, naive, options.timeTransform, pooledKm, H);
    const events = H.sum(parsed.event);
    const residualRows = ph.status === "evaluated" ? ph.scaled.flatMap((row) => parsed.predictors.map((predictor, j) => ({ term: predictor.name, time: row.time, transformedTime: row.transformedTime, observation: row.index + 1, schoenfeldResidual: row.raw[j], scaledSchoenfeldResidual: row.scaled[j] }))) : [];
    const phRows = ph.status === "evaluated" ? [...parsed.predictors.map((predictor, j) => ({ term: predictor.name, statistic: ph.perTerm[j].statistic, df: 1, pValue: ph.perTerm[j].pValue, correlation: ph.perTerm[j].correlation })), { term: "GLOBAL", statistic: ph.global.statistic, df: p, pValue: ph.global.pValue, correlation: null }] : [];
    const coefficientColumns = [{ key: "term", label: "Term", type: "string" }, { key: "estimate", label: "Log HR", type: "number" }, { key: "standardError", label: useRobust ? "Robust SE" : "SE", type: "number" }, { key: "naiveStandardError", label: "Model-based SE", type: "number" }, { key: "robustStandardError", label: "Robust SE", type: "number" }, { key: "statistic", label: "z", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "hazardRatio", label: "Hazard ratio", type: "number" }, { key: "hazardRatioLower", label: "HR CI lower", type: "number" }, { key: "hazardRatioUpper", label: "HR CI upper", type: "number" }];
    return {
      sample: { n, events, censored: n - events, predictors: p, strata: strataLevels.length, clusters: clusterCount },
      estimates: [
        ...coefficients.map((row) => ({ name: `${row.term} log hazard ratio`, estimate: row.estimate, standardError: row.standardError, hazardRatio: row.hazardRatio })),
        { name: "log partial likelihood", estimate: fit.finalState.logLikelihood, nullLogPartialLikelihood: fit.nullState.logLikelihood },
        { name: "strata summary", value: strataSummary },
      ],
      tests: [
        { name: "Cox partial-likelihood ratio test", statistic: likelihoodRatio, distribution: "chi-square", df: p, pValue: H.pFromChiSquare(likelihoodRatio, p) },
        { name: useRobust ? "Wald test (robust covariance)" : "Wald test", statistic: waldGlobal, distribution: "chi-square", df: p, pValue: H.pFromChiSquare(waldGlobal, p) },
        { name: "Score (log-rank) test", statistic: scoreGlobal, distribution: "chi-square", df: p, pValue: H.pFromChiSquare(scoreGlobal, p) },
        ...coefficients.map((row) => ({ name: `Wald z: ${row.term}`, statistic: row.statistic, distribution: "normal", pValue: row.pValue })),
        ...phRows.map((row) => ({ name: `Proportional-hazards test (${options.timeTransform}): ${row.term}`, statistic: row.statistic, distribution: "chi-square", df: row.df, pValue: row.pValue })),
      ],
      confidenceIntervals: coefficients.map((row) => ({ parameter: `${row.term} log hazard ratio`, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: useRobust ? "Wald normal with cluster-robust sandwich SE" : "Wald normal" })),
      effectSizes: coefficients.map((row) => ({ name: `${row.term} hazard ratio`, estimate: row.hazardRatio, lower: row.hazardRatioLower, upper: row.hazardRatioUpper })),
      assumptions: [
        { name: "right censoring", status: "verified_by_input_contract" },
        { name: "non-informative censoring within strata", status: "requires_design_review" },
        { name: "proportional hazards within strata", status: ph.status === "evaluated" ? (ph.global.pValue < 0.05 ? "global_test_rejects_at_0.05" : "global_test_does_not_reject_at_0.05") : "not_evaluated" },
        { name: "independent observations", status: useRobust ? "relaxed_by_cluster_robust_variance" : "requires_design_review" },
        { name: "linear time-independent covariate effects on the log hazard", status: "requires_model_review" },
      ],
      diagnostics: [
        { name: "partial-likelihood convergence", status: "converged", iterations: fit.iterations, tolerance: options.tolerance, tieMethod: options.ties, tiedEventTimes: fit.finalState.tiedEventTimes },
        { name: "stratification", status: parsed.strata ? "stratified_baseline_hazards" : "single_stratum", strata: strataSummary },
        { name: "variance estimator", status: useRobust ? "cluster_robust_sandwich" : "model_based", clusters: clusterCount, detail: useRobust ? "sandwich V (sum over clusters of summed score-residual deltas) V with no small-sample correction, as in coxph(robust = TRUE)" : "inverse observed information" },
        { name: "proportional-hazards test", status: ph.status, ...(ph.status === "evaluated" ? { transform: options.timeTransform, events: ph.events, global: ph.global, terms: phRows, method: "Grambsch-Therneau scaled Schoenfeld residuals against transformed event time; per-term and global chi-square (survival::cox.zph pre-3.0 form, model-based covariance)" } : { reason: ph.reason }) },
        { name: "predictor standardization", status: "internal_only", centers, scales, outputScale: "original predictor units" },
      ],
      artifacts: [
        H.tableArtifact(`Stratified Cox proportional hazards: ${parsed.outcomeLabel}`, `Partial-likelihood Cox model (${options.ties} ties${parsed.strata ? `, ${strataLevels.length} strata` : ""}${useRobust ? ", cluster-robust SE" : ""}).`, coefficientColumns, coefficients.map(({ lower, upper, ...row }) => row), [`${percent(options.confidenceLevel)}% Wald intervals; LR chi-square(${p}) = ${likelihoodRatio}.`]),
        H.tableArtifact("Proportional-hazards test", `Scaled Schoenfeld residuals against ${options.timeTransform}-transformed event time.`, [{ key: "term", label: "Term", type: "string" }, { key: "statistic", label: "Chi-square", type: "number" }, { key: "df", label: "df", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "correlation", label: "Correlation with time", type: "number" }], phRows, ["A small p value indicates that the log hazard ratio drifts with time."], "cox-ph-test-table"),
        H.tableArtifact("Scaled Schoenfeld residuals", "One row per event and term.", [{ key: "term", label: "Term", type: "string" }, { key: "time", label: "Event time", type: "number" }, { key: "transformedTime", label: `Transformed time (${options.timeTransform})`, type: "number" }, { key: "observation", label: "Observation", type: "number" }, { key: "schoenfeldResidual", label: "Schoenfeld residual", type: "number" }, { key: "scaledSchoenfeldResidual", label: "Scaled residual", type: "number" }], residualRows, [], "cox-schoenfeld-residual-table"),
        H.vegaArtifact("cox-schoenfeld-residual-plot", "Scaled Schoenfeld residuals by term", {
          data: { values: residualRows },
          facet: { row: { field: "term", type: "nominal", title: null } },
          spec: { width: 420, height: 130, layer: [
            { mark: { type: "point", filled: true, opacity: 0.75, size: 50 }, encoding: { x: { field: "transformedTime", type: "quantitative", title: `Transformed event time (${options.timeTransform})` }, y: { field: "scaledSchoenfeldResidual", type: "quantitative", title: "Scaled Schoenfeld residual" }, tooltip: [{ field: "term" }, { field: "time", format: ".4g" }, { field: "scaledSchoenfeldResidual", format: ".4g" }] } },
            { mark: { type: "rule", strokeDash: [4, 4], color: "#777" }, encoding: { y: { datum: 0 } } },
          ] },
          resolve: { scale: { y: "independent" } },
          description: "Systematic trend of scaled residuals with time indicates non-proportional hazards for that term.",
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "A hazard ratio must be estimated while baseline hazards differ across sites or strata, observations are clustered (centres, matched sets, repeated subjects), or the proportional-hazards assumption itself must be tested formally.",
    decision: "Decide whether covariates change the hazard within strata, how precise the estimate is once clustering is respected, and whether the proportional-hazards assumption holds for each term.",
    mustShow: "Log hazard ratios with model-based and robust standard errors, hazard ratios with intervals, likelihood-ratio, Wald, and score tests, the stratum event summary, and the per-term and global proportional-hazards test with the Schoenfeld residual plot.",
    userGoal: "Report a Cox model whose baseline flexibility, variance estimator, and proportionality check match the study design.",
    nextActions: [
      { trigger: "ph-test-rejects", action: "add-time-varying-coefficient-or-stratify-on-that-term", reason: "A drifting log hazard ratio means the single reported hazard ratio is a time-average that may hide the effect." },
      { trigger: "robust-and-model-se-diverge", action: "report-robust-intervals-and-review-misspecification", reason: "Large differences between sandwich and model-based errors indicate correlation or misspecification that the model-based error ignores." },
      { trigger: "few-events-per-parameter", action: "reduce-model-or-use-penalized-fit", reason: "Below roughly ten events per parameter the Wald inference becomes unreliable." },
      { trigger: "effect-supported", action: "report-adjusted-survival-curves-by-stratum", reason: "Hazard ratios are relative; absolute survival differences require baseline estimates within strata." },
    ],
  },
  fixture: {
    data: {
      time: [5, 8, 12, 15, 18, 20, 22, 25, 27, 30, 33, 36, 40, 42, 45, 48, 52, 55, 58, 60, 63, 66, 70, 75],
      event: [1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 0, 1],
      predictors: [
        { name: "treatment", values: [0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1] },
        { name: "age", values: [62, 55, 70, 48, 66, 59, 51, 64, 72, 45, 58, 69, 50, 61, 47, 56, 73, 44, 65, 53, 49, 68, 52, 46] },
      ],
      strata: ["site A", "site A", "site B", "site A", "site B", "site B", "site A", "site B", "site A", "site B", "site A", "site B", "site A", "site B", "site A", "site B", "site A", "site B", "site A", "site B", "site A", "site B", "site A", "site B"],
      outcomeLabel: "Overall survival",
    },
    options: { ties: "efron", robust: true, timeTransform: "km", confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "Right-censored Cox partial likelihood with up to 16 numeric predictors, up to 200 strata with separate baseline hazards, Efron or Breslow ties, optional cluster-robust sandwich covariance (no small-sample correction), and a Grambsch-Therneau scaled-Schoenfeld proportional-hazards test with km, rank, log, or identity time transforms.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["stratified Efron coefficients, model-based SE, hazard ratios, log partial likelihood (lifelines CoxPHFitter strata)", "cluster-robust SE on untied data (lifelines robust=True cluster_col)", "per-term proportional-hazards chi-square for km/log/identity transforms (lifelines proportional_hazard_test)"], excludedOutputs: ["robust SE with tied event times (Efron score residuals; lifelines uses Breslow-form residuals)", "global PH chi-square (numpy first principles only)", "rank transform with tied event times"] },
    diagnostic: { level: "method-specific-partial", emitted: ["convergence", "stratum event counts", "variance estimator", "PH test per term and global", "scaled Schoenfeld residuals"], limitations: ["no martingale or deviance residuals", "no time-varying covariates"] },
    knownGaps: ["no time-dependent covariates or coefficients", "no Firth penalization for monotone likelihood", "no baseline hazard export"],
  },
};

// ---------------------------------------------------------------------------------------------
// 3. Parametric AFT regression
// ---------------------------------------------------------------------------------------------

const AFT_DISTRIBUTIONS = ["weibull", "exponential", "lognormal", "loglogistic"];

function normalHazardRatio(H, z) {
  // phi(z) / (1 - Phi(z)) with a stable tail
  const sf = normalSf(H, z);
  const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  if (sf < 1e-300) return z + 1 / z;
  return pdf / sf;
}

function aftKernels(distribution, H) {
  // returns { logF(z), logS(z), g = d logF/dz, h = d2 logF/dz2, gS, hS }
  if (distribution === "weibull" || distribution === "exponential") {
    return {
      logF: (z) => z - Math.exp(z), logS: (z) => -Math.exp(z),
      g: (z) => 1 - Math.exp(z), h: (z) => -Math.exp(z), gS: (z) => -Math.exp(z), hS: (z) => -Math.exp(z),
      residualLabel: "standard minimum extreme value",
    };
  }
  if (distribution === "loglogistic") {
    const p = (z) => 1 / (1 + Math.exp(-z));
    return {
      logF: (z) => z - 2 * Math.log1p(Math.exp(z)), logS: (z) => -Math.log1p(Math.exp(z)),
      g: (z) => 1 - 2 * p(z), h: (z) => -2 * p(z) * (1 - p(z)), gS: (z) => -p(z), hS: (z) => -p(z) * (1 - p(z)),
      residualLabel: "standard logistic",
    };
  }
  return {
    logF: (z) => -0.5 * z * z - 0.5 * Math.log(2 * Math.PI), logS: (z) => Math.log(normalSf(H, z)),
    g: (z) => -z, h: () => -1, gS: (z) => -normalHazardRatio(H, z), hS: (z) => { const lambda = normalHazardRatio(H, z); return lambda * (z - lambda); },
    residualLabel: "standard normal",
  };
}

function aftObjective(theta, y, event, x, kernel, fixedScale, budget, H) {
  const p = x[0].length;
  const beta = theta.slice(0, p);
  const tau = fixedScale ? 0 : theta[p];
  const sigma = Math.exp(tau);
  if (!Number.isFinite(sigma) || sigma <= 0) H.fail("STAT_NON_CONVERGENCE", "AFT scale diverged");
  const dim = fixedScale ? p : p + 1;
  let logLikelihood = 0;
  const gradient = zeros(dim);
  const hessian = zeroMatrix(dim);
  const residuals = [];
  for (let i = 0; i < y.length; i += 1) {
    budget.check();
    const mu = dot(x[i], beta);
    const z = (y[i] - mu) / sigma;
    if (!Number.isFinite(z) || Math.abs(z) > 700) H.fail("STAT_NON_CONVERGENCE", "AFT standardized residual diverged");
    residuals.push(z);
    const a = event[i] === 1 ? kernel.g(z) : kernel.gS(z);
    const b = event[i] === 1 ? kernel.h(z) : kernel.hS(z);
    logLikelihood += event[i] === 1 ? kernel.logF(z) - tau - y[i] : kernel.logS(z);
    for (let j = 0; j < p; j += 1) {
      gradient[j] -= a * x[i][j] / sigma;
      for (let l = 0; l < p; l += 1) hessian[j][l] += b * x[i][j] * x[i][l] / (sigma * sigma);
    }
    if (!fixedScale) {
      gradient[p] -= a * z + event[i];
      for (let j = 0; j < p; j += 1) {
        const cross = (a + b * z) * x[i][j] / sigma;
        hessian[j][p] += cross;
        hessian[p][j] += cross;
      }
      hessian[p][p] += b * z * z + a * z;
    }
  }
  if (!Number.isFinite(logLikelihood)) H.fail("STAT_NUMERIC_FAILURE", "AFT log-likelihood is not finite");
  return { logLikelihood, gradient, hessian, residuals, sigma };
}

function fitAft(y, event, x, kernel, fixedScale, options, budget, H, start) {
  const p = x[0].length;
  let theta = start.slice();
  let current = aftObjective(theta, y, event, x, kernel, fixedScale, budget, H);
  let converged = false;
  let iterations = 0;
  for (iterations = 1; iterations <= options.maxIterations; iterations += 1) {
    budget.check(1024);
    const negativeHessian = current.hessian.map((row) => row.map((value) => -value));
    let direction;
    try {
      direction = matVec(H.invert(negativeHessian), current.gradient);
    } catch (error) {
      if (error && error.code === "STAT_SINGULAR_MATRIX") direction = current.gradient.map((value) => value * 0.1);
      else throw error;
    }
    if (direction.some((value) => !Number.isFinite(value))) H.fail("STAT_NON_CONVERGENCE", "AFT Newton direction is not finite");
    let factor = 1;
    let next = null;
    let candidate = null;
    while (factor >= 1 / 4096) {
      candidate = theta.map((value, index) => value + factor * direction[index]);
      if (candidate.some((value) => !Number.isFinite(value) || Math.abs(value) > 50)) { factor /= 2; continue; }
      let trial = null;
      try { trial = aftObjective(candidate, y, event, x, kernel, fixedScale, budget, H); } catch (error) { if (!error || !["STAT_NON_CONVERGENCE", "STAT_NUMERIC_FAILURE"].includes(error.code)) throw error; }
      if (trial && trial.logLikelihood >= current.logLikelihood - 1e-10) { next = trial; break; }
      factor /= 2;
    }
    if (!next) H.fail("STAT_NON_CONVERGENCE", "AFT line search failed");
    const delta = Math.max(...candidate.map((value, index) => Math.abs(value - theta[index])));
    theta = candidate;
    current = next;
    if (delta < options.tolerance && Math.max(...current.gradient.map(Math.abs)) < Math.sqrt(options.tolerance) * 10) { converged = true; break; }
  }
  if (!converged) H.fail("STAT_NON_CONVERGENCE", `AFT regression did not converge in ${options.maxIterations} iterations`);
  const negativeHessian = current.hessian.map((row) => row.map((value) => -value));
  const covariance = safeInvert(H, negativeHessian, "AFT observed information");
  return { theta, state: current, covariance, iterations, p };
}

const parametricSurvivalRegression = {
  method: "parametric_survival_regression",
  family: "survival",
  analysisModel: MODEL,
  optionKeys: ["confidenceLevel", "maxIterations", "tolerance", "timeoutMs"],
  customOptions: {
    distribution: { schema: { type: "string", enum: AFT_DISTRIBUTIONS }, default: "weibull", parse(value, H, path) { if (!AFT_DISTRIBUTIONS.includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be one of ${AFT_DISTRIBUTIONS.join(", ")}`); return value; } },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["time", "event", "predictors"],
    properties: {
      time: { type: "array", minItems: 8, maxItems: 5000, items: { type: "number", exclusiveMinimum: 0 } },
      event: { type: "array", minItems: 8, maxItems: 5000, items: { type: "integer", enum: [0, 1] } },
      predictors: { type: "array", minItems: 1, maxItems: 16, items: { type: "object", additionalProperties: false, required: ["values"], properties: { name: { type: "string", minLength: 1, maxLength: 128 }, values: { type: "array", minItems: 8, maxItems: 5000, items: { type: "number" } } } } },
      outcomeLabel: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["time", "event", "predictors", "outcomeLabel"], "data");
    const { time, event } = parseTimeEvent(data, H, MAX_COX_ROWS, 8);
    const predictors = H.survivalPredictors(data.predictors, time.length);
    const design = time.map((_, row) => [1, ...predictors.map((predictor) => predictor.values[row])]);
    if (H.matrixRank(design) < predictors.length + 1) H.fail("STAT_RANK_DEFICIENT", "predictors are collinear");
    if (H.sum(event) < predictors.length + 2) H.fail("STAT_INSUFFICIENT_SAMPLE", "AFT regression needs more observed events than parameters");
    return { time, event, predictors, outcomeLabel: H.label(data.outcomeLabel, "Survival", "data.outcomeLabel") };
  },
  analyze(parsed, options, budget, H) {
    const n = parsed.time.length;
    const p = parsed.predictors.length + 1;
    const y = parsed.time.map((value) => Math.log(value));
    const x = parsed.time.map((_, row) => [1, ...parsed.predictors.map((predictor) => predictor.values[row])]);
    const kernel = aftKernels(options.distribution, H);
    const fixedScale = options.distribution === "exponential";
    // OLS start on log time
    const ols = H.olsCore(y, x, budget);
    const olsResiduals = ols.residuals;
    const startScale = Math.max(0.05, Math.sqrt(H.variance(olsResiduals, true, budget)) || 1);
    const start = fixedScale ? ols.beta.slice() : [...ols.beta, Math.log(startScale)];
    const fit = fitAft(y, parsed.event, x, kernel, fixedScale, options, budget, H, start);
    const nullX = parsed.time.map(() => [1]);
    const nullStart = fixedScale ? [H.mean(y, budget)] : [H.mean(y, budget), Math.log(Math.max(0.05, Math.sqrt(H.variance(y, true, budget))))];
    const nullFit = fitAft(y, parsed.event, nullX, kernel, fixedScale, options, budget, H, nullStart);
    const critical = zCritical(H, options.confidenceLevel);
    const names = ["intercept", ...parsed.predictors.map((predictor) => predictor.name)];
    const coefficients = names.map((term, j) => {
      const estimate = fit.theta[j];
      const standardError = Math.sqrt(Math.max(0, fit.covariance[j][j]));
      if (!(standardError > 0)) H.fail("STAT_DEGENERATE", `AFT standard error is zero for ${term}`);
      const statistic = estimate / standardError;
      const lower = estimate - critical * standardError;
      const upper = estimate + critical * standardError;
      return { term, estimate, standardError, statistic, pValue: twoSidedNormalP(H, statistic), lower, upper, timeRatio: Math.exp(estimate), timeRatioLower: Math.exp(lower), timeRatioUpper: Math.exp(upper) };
    });
    const logScale = fixedScale ? 0 : fit.theta[p];
    const logScaleSe = fixedScale ? 0 : Math.sqrt(Math.max(0, fit.covariance[p][p]));
    const scale = Math.exp(logScale);
    const shape = 1 / scale;
    const logLikelihood = fit.state.logLikelihood;
    const parameters = fixedScale ? p : p + 1;
    const likelihoodRatio = Math.max(0, 2 * (logLikelihood - nullFit.state.logLikelihood));
    const events = H.sum(parsed.event);
    const aic = -2 * logLikelihood + 2 * parameters;
    const bic = -2 * logLikelihood + parameters * Math.log(n);
    const coxSnell = fit.state.residuals.map((z, i) => ({ observation: i + 1, time: parsed.time[i], event: parsed.event[i], standardizedResidual: z, coxSnellResidual: -kernel.logS(z) }));
    const distributionLabel = { weibull: "Weibull", exponential: "exponential", lognormal: "log-normal", loglogistic: "log-logistic" }[options.distribution];
    const scaleRows = [
      { parameter: "log(scale)", estimate: logScale, standardError: fixedScale ? null : logScaleSe, lower: fixedScale ? null : logScale - critical * logScaleSe, upper: fixedScale ? null : logScale + critical * logScaleSe },
      { parameter: "scale (sigma)", estimate: scale, standardError: fixedScale ? null : scale * logScaleSe, lower: fixedScale ? null : Math.exp(logScale - critical * logScaleSe), upper: fixedScale ? null : Math.exp(logScale + critical * logScaleSe) },
      { parameter: options.distribution === "lognormal" ? "sigma (log-time SD)" : "shape (1 / sigma)", estimate: options.distribution === "lognormal" ? scale : shape, standardError: fixedScale ? null : (options.distribution === "lognormal" ? scale : shape) * logScaleSe, lower: fixedScale ? null : (options.distribution === "lognormal" ? Math.exp(logScale - critical * logScaleSe) : Math.exp(-logScale - critical * logScaleSe)), upper: fixedScale ? null : (options.distribution === "lognormal" ? Math.exp(logScale + critical * logScaleSe) : Math.exp(-logScale + critical * logScaleSe)) },
    ];
    const forestRows = coefficients.slice(1);
    return {
      sample: { n, events, censored: n - events, predictors: p - 1, parameters },
      estimates: [
        ...coefficients.map((row) => ({ name: `${row.term} (log time)`, estimate: row.estimate, standardError: row.standardError, timeRatio: row.timeRatio })),
        { name: "log(scale)", estimate: logScale, standardError: fixedScale ? 0 : logScaleSe, fixed: fixedScale },
        { name: "scale", estimate: scale }, { name: "shape", estimate: shape },
        { name: "log-likelihood", estimate: logLikelihood, nullLogLikelihood: nullFit.state.logLikelihood, aic, bic },
      ],
      tests: [
        { name: `${distributionLabel} AFT likelihood-ratio test (all predictors)`, statistic: likelihoodRatio, distribution: "chi-square", df: p - 1, pValue: H.pFromChiSquare(likelihoodRatio, p - 1) },
        ...coefficients.slice(1).map((row) => ({ name: `Wald z: ${row.term}`, statistic: row.statistic, distribution: "normal", pValue: row.pValue })),
      ],
      confidenceIntervals: [
        ...coefficients.map((row) => ({ parameter: `${row.term} (log time)`, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: "Wald normal" })),
        ...(fixedScale ? [] : [{ parameter: "log(scale)", level: options.confidenceLevel, lower: logScale - critical * logScaleSe, upper: logScale + critical * logScaleSe, method: "Wald normal" }]),
      ],
      effectSizes: coefficients.slice(1).map((row) => ({ name: `${row.term} time ratio`, estimate: row.timeRatio, lower: row.timeRatioLower, upper: row.timeRatioUpper, interpretation: "multiplicative change in event time per unit increase" })),
      assumptions: [
        { name: "right censoring", status: "verified_by_input_contract" },
        { name: `log event time follows a ${kernel.residualLabel} distribution with constant scale`, status: "requires_distribution_review" },
        { name: "covariates act multiplicatively on time (accelerated failure time)", status: "requires_model_review" },
        { name: "non-informative censoring and independent observations", status: "requires_design_review" },
      ],
      diagnostics: [
        { name: "maximum-likelihood convergence", status: "converged", iterations: fit.iterations, tolerance: options.tolerance, method: "Newton-Raphson with analytic Hessian and step halving" },
        { name: "model fit", logLikelihood, nullLogLikelihood: nullFit.state.logLikelihood, aic, bic, parameters },
        { name: "scale parameter", status: fixedScale ? "fixed_at_one" : "estimated", logScale, standardError: logScaleSe, shape, detail: options.distribution === "lognormal" ? "sigma is the standard deviation of log time" : "shape = 1 / sigma; Weibull rho or log-logistic beta" },
        { name: "Cox-Snell residuals", status: "reported", detail: "if the model fits, the Cox-Snell residuals behave like a censored unit-exponential sample", summary: { mean: H.mean(coxSnell.map((row) => row.coxSnellResidual), budget), events } },
      ],
      artifacts: [
        H.tableArtifact(`${distributionLabel} accelerated failure time regression: ${parsed.outcomeLabel}`, "Coefficients on log time; time ratio = exp(coefficient).", [{ key: "term", label: "Term", type: "string" }, { key: "estimate", label: "Coefficient", type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "statistic", label: "z", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "timeRatio", label: "Time ratio", type: "number" }, { key: "timeRatioLower", label: "TR CI lower", type: "number" }, { key: "timeRatioUpper", label: "TR CI upper", type: "number" }], coefficients.map(({ lower, upper, ...row }) => row), [`${percent(options.confidenceLevel)}% Wald intervals; log-likelihood ${logLikelihood}; AIC ${aic}.`]),
        H.tableArtifact("Scale and shape", `${distributionLabel} ancillary parameters.`, [{ key: "parameter", label: "Parameter", type: "string" }, { key: "estimate", label: "Estimate", type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "lower", label: "CI lower", type: "number" }, { key: "upper", label: "CI upper", type: "number" }], scaleRows, [], "aft-scale-table"),
        H.tableArtifact("Cox-Snell residuals", "Standardized log-time residuals and Cox-Snell residuals per observation.", [{ key: "observation", label: "Observation", type: "number" }, { key: "time", label: "Time", type: "number" }, { key: "event", label: "Event", type: "number" }, { key: "standardizedResidual", label: "Standardized residual", type: "number" }, { key: "coxSnellResidual", label: "Cox-Snell residual", type: "number" }], coxSnell, [], "aft-residual-table"),
        H.tableArtifact("Time ratios", "Predictor time ratios with intervals (intercept excluded).", [{ key: "term", label: "Term", type: "string" }, { key: "timeRatio", label: "Time ratio", type: "number" }, { key: "timeRatioLower", label: "CI lower", type: "number" }, { key: "timeRatioUpper", label: "CI upper", type: "number" }, { key: "pValue", label: "p", type: "number" }], forestRows.map((row) => ({ term: row.term, timeRatio: row.timeRatio, timeRatioLower: row.timeRatioLower, timeRatioUpper: row.timeRatioUpper, pValue: row.pValue })), [], "aft-time-ratio-table"),
        H.vegaArtifact("aft-time-ratio-forest", `${distributionLabel} AFT time ratios with ${percent(options.confidenceLevel)}% intervals`, {
          data: { values: forestRows.map((row) => ({ term: row.term, timeRatio: row.timeRatio, timeRatioLower: row.timeRatioLower, timeRatioUpper: row.timeRatioUpper, pValue: row.pValue })) },
          layer: [
            { mark: { type: "rule", strokeWidth: 2 }, encoding: { y: { field: "term", type: "nominal", title: null }, x: { field: "timeRatioLower", type: "quantitative", scale: { type: "log" }, title: "Time ratio (log scale)" }, x2: { field: "timeRatioUpper" } } },
            { mark: { type: "point", filled: true, size: 90 }, encoding: { y: { field: "term", type: "nominal" }, x: { field: "timeRatio", type: "quantitative", scale: { type: "log" } }, tooltip: [{ field: "term" }, { field: "timeRatio", format: ".4g" }, { field: "timeRatioLower", format: ".4g" }, { field: "timeRatioUpper", format: ".4g" }, { field: "pValue", format: ".3g" }] } },
            { mark: { type: "rule", strokeDash: [4, 4], color: "#777" }, encoding: { x: { datum: 1, scale: { type: "log" } } } },
          ],
          description: "Time ratios above one lengthen survival time.",
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "Survival times must be modelled parametrically, either because extrapolation beyond follow-up, absolute time predictions, or a time-ratio interpretation is required, or because proportional hazards fails but an accelerated-failure-time structure is plausible.",
    decision: "Decide which distribution describes the log survival times, how much each covariate accelerates or decelerates event time, and whether the parametric fit is adequate.",
    mustShow: "Coefficients on log time with standard errors, time ratios with intervals, the scale and shape parameters, the likelihood-ratio test, information criteria, and the Cox-Snell residual summary.",
    userGoal: "Report an interpretable time-ratio model with a stated distributional assumption that can be compared across candidate distributions.",
    nextActions: [
      { trigger: "distribution-uncertain", action: "compare-aic-across-weibull-lognormal-loglogistic", reason: "Information criteria discriminate between AFT families that imply very different tails." },
      { trigger: "cox-snell-departs-from-unit-exponential", action: "revise-distribution-or-add-covariates", reason: "Poorly behaved Cox-Snell residuals indicate that the assumed error distribution or the linear predictor is misspecified." },
      { trigger: "effect-supported", action: "report-time-ratio-with-interval-and-predicted-median-times", reason: "Time ratios are directly interpretable as multiplicative changes in survival time." },
      { trigger: "proportional-hazards-also-plausible", action: "report-cox-hazard-ratio-alongside", reason: "For the Weibull family both interpretations hold and readers may expect the hazard-ratio scale." },
    ],
  },
  fixture: {
    data: {
      time: [6, 9, 12, 14, 17, 20, 23, 26, 28, 31, 35, 38, 42, 46, 50, 54, 58, 63, 68, 74, 80, 88, 95, 104],
      event: [1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0],
      predictors: [
        { name: "treatment", values: [0, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1] },
        { name: "age", values: [70, 66, 61, 72, 65, 58, 68, 63, 71, 55, 69, 57, 54, 67, 52, 56, 64, 50, 53, 62, 49, 51, 48, 47] },
      ],
      outcomeLabel: "Time to relapse",
    },
    options: { distribution: "weibull", confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "Right-censored accelerated failure time regression with Weibull, exponential (scale fixed at one), log-normal, or log-logistic errors, up to 16 numeric predictors, Newton-Raphson maximum likelihood with analytic Hessian, Wald inference, and a likelihood-ratio test against the intercept-only model.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["Weibull, log-normal, and log-logistic coefficients, log(scale), standard errors, and log-likelihood (lifelines WeibullAFTFitter / LogNormalAFTFitter / LogLogisticAFTFitter)", "exponential coefficients and log-likelihood (scipy.optimize first-principles MLE)"], excludedOutputs: ["Cox-Snell residual distribution test", "predicted survival curves"] },
    diagnostic: { level: "method-specific-partial", emitted: ["convergence", "AIC/BIC", "scale parameter", "Cox-Snell residuals"], limitations: ["no goodness-of-fit test", "no left or interval censoring"] },
    knownGaps: ["no generalized gamma family", "no ancillary (heteroscedastic scale) regression", "no interval censoring"],
  },
};

// ---------------------------------------------------------------------------------------------
// 4. Competing risks: Aalen-Johansen cumulative incidence with Gray-type test
// ---------------------------------------------------------------------------------------------

function competingRiskTable(time, event, indices, causes) {
  // rows sorted by time; returns per distinct time { time, n, d (all-cause), dk[cause], c }
  const rows = indices.map((index) => ({ time: time[index], event: event[index] })).sort((a, b) => a.time - b.time);
  const table = [];
  let atRisk = rows.length;
  for (let start = 0; start < rows.length;) {
    let end = start + 1;
    while (end < rows.length && rows[end].time === rows[start].time) end += 1;
    const dk = zeros(causes + 1);
    for (let i = start; i < end; i += 1) dk[rows[i].event] += 1;
    const d = dk.slice(1).reduce((total, value) => total + value, 0);
    table.push({ time: rows[start].time, n: atRisk, d, dk, c: dk[0] });
    atRisk -= end - start;
    start = end;
  }
  return table;
}

function aalenJohansen(table, causes, z, budget) {
  // returns rows per time and cause with CIF, variance (Collett / lifelines formula), log-log intervals
  const rows = [];
  let survivalBefore = 1;
  const cif = zeros(causes + 1);
  const history = [];
  for (const row of table) {
    budget.check();
    const lagS = survivalBefore;
    for (let k = 1; k <= causes; k += 1) cif[k] += lagS * row.dk[k] / row.n;
    if (row.d > 0) survivalBefore *= 1 - row.d / row.n;
    history.push({ time: row.time, n: row.n, d: row.d, dk: row.dk.slice(), lagS, cif: cif.slice(), survival: survivalBefore });
    for (let k = 1; k <= causes; k += 1) {
      const f = cif[k];
      let variance = 0;
      for (const past of history) {
        budget.check();
        const gap = f - past.cif[k];
        const first = past.n > past.d ? gap * gap * past.d / (past.n * (past.n - past.d)) : 0;
        const second = past.lagS * past.lagS * past.dk[k] * (past.n - past.dk[k]) / Math.pow(past.n, 3);
        const third = gap * past.lagS * past.dk[k] / (past.n * past.n);
        variance += first + second - 2 * third;
      }
      variance = Math.max(0, variance);
      const standardError = Math.sqrt(variance);
      const interval = logLogInterval(f, standardError, z);
      rows.push({ cause: k, time: row.time, atRisk: row.n, events: row.dk[k], allCauseEvents: row.d, censored: row.c, survival: survivalBefore, cumulativeIncidence: f, standardError, lower: interval.lower, upper: interval.upper });
    }
  }
  return rows;
}

function grayScore(groupTables, cause, rho, budget) {
  // Gray-type k-sample score for cause `cause`: z_j = sum_t K(t) [ d_1j(t) - R_j(t) d_1.(t) / R.(t) ],
  // with modified risk set R_j = Y_j (1 - F_1j(t-)) / S_j(t-) and K(t) = (1 - F_pooled(t-))^rho.
  const k = groupTables.length;
  const times = [...new Set(groupTables.flatMap((table) => table.map((row) => row.time)))].sort((a, b) => a - b);
  const cursors = zeros(k);
  const survivalBefore = Array(k).fill(1);
  const cifBefore = zeros(k);
  let pooledSurvival = 1;
  let pooledCif = 0;
  const z = zeros(k);
  for (const time of times) {
    budget.check();
    const d1 = zeros(k);
    const r = zeros(k);
    let pooledN = 0;
    let pooledD = 0;
    let pooledD1 = 0;
    const updates = [];
    for (let j = 0; j < k; j += 1) {
      const table = groupTables[j];
      const row = cursors[j] < table.length && table[cursors[j]].time === time ? table[cursors[j]] : null;
      const y = row ? row.n : (cursors[j] < table.length ? table[cursors[j]].n : 0);
      r[j] = survivalBefore[j] > 0 ? y * (1 - cifBefore[j]) / survivalBefore[j] : 0;
      if (row) {
        d1[j] = row.dk[cause];
        pooledN += row.n;
        pooledD += row.d;
        pooledD1 += row.dk[cause];
        updates.push({ j, row });
        cursors[j] += 1;
      } else {
        pooledN += y;
      }
    }
    const weight = rho === 0 ? 1 : Math.pow(1 - pooledCif, rho);
    const rTotal = r.reduce((total, value) => total + value, 0);
    const dTotal = d1.reduce((total, value) => total + value, 0);
    if (dTotal > 0 && rTotal > 0) for (let j = 0; j < k; j += 1) z[j] += weight * (d1[j] - r[j] * dTotal / rTotal);
    for (const { j, row } of updates) {
      cifBefore[j] += survivalBefore[j] * row.dk[cause] / row.n;
      if (row.d > 0) survivalBefore[j] *= 1 - row.d / row.n;
    }
    if (pooledN > 0) {
      pooledCif += pooledSurvival * pooledD1 / pooledN;
      if (pooledD > 0) pooledSurvival *= 1 - pooledD / pooledN;
    }
  }
  return z;
}

const competingRisksCumulativeIncidence = {
  method: "competing_risks_cumulative_incidence",
  family: "survival",
  analysisModel: MODEL,
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    causeOfInterest: { schema: { type: "integer", minimum: 1, maximum: MAX_CAUSES }, default: 1, parse(value, H, path) { return H.integer(value, 1, MAX_CAUSES, path); } },
    grayRho: { schema: { type: "number", minimum: 0, maximum: 5 }, default: 0, parse(value, H, path) { const v = H.finiteNumber(value, path); if (v < 0 || v > 5) H.fail("STAT_INVALID_INPUT", `${path} must lie in [0, 5]`); return v; } },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["time", "event"],
    properties: {
      time: { type: "array", minItems: 8, maxItems: 10000, items: { type: "number", exclusiveMinimum: 0 } },
      event: { type: "array", minItems: 8, maxItems: 10000, items: { type: "integer", minimum: 0, maximum: MAX_CAUSES } },
      group: { type: "array", minItems: 8, maxItems: 10000, items: { type: "string", minLength: 1, maxLength: 128 } },
      causeLabels: { type: "array", minItems: 1, maxItems: MAX_CAUSES, items: { type: "string", minLength: 1, maxLength: 128 } },
      outcomeLabel: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["time", "event", "group", "causeLabels", "outcomeLabel"], "data");
    const time = H.numericVector(data.time, "data.time", 8);
    if (time.length > H.LIMITS.maxSurvivalRows) H.fail("STAT_LIMIT_EXCEEDED", `data.time exceeds ${H.LIMITS.maxSurvivalRows} rows`);
    if (time.some((value) => value <= 0)) H.fail("STAT_INVALID_INPUT", "data.time must contain only positive durations");
    if (!Array.isArray(data.event) || data.event.length !== time.length) H.fail("STAT_INVALID_INPUT", "data.event must match data.time length");
    const event = data.event.map((value, index) => H.integer(value, 0, MAX_CAUSES, `data.event[${index}]`));
    const causes = Math.max(...event);
    if (causes < 2) H.fail("STAT_INVALID_INPUT", "competing risks require at least two event causes coded 1..K (0 = censored)");
    for (let k = 1; k <= causes; k += 1) if (!event.includes(k)) H.fail("STAT_DEGENERATE", `cause ${k} has no observed events; recode causes consecutively`);
    if (options.causeOfInterest > causes) H.fail("STAT_INVALID_INPUT", `options.causeOfInterest exceeds the ${causes} coded causes`);
    const group = parseLabels(data.group, time.length, "data.group", H);
    if (group && levelsOf(group).length < 2) H.fail("STAT_INVALID_INPUT", "data.group must contain at least two groups");
    if (group && time.length > MAX_GRAY_ROWS) H.fail("STAT_LIMIT_EXCEEDED", `grouped competing-risks comparison supports at most ${MAX_GRAY_ROWS} rows`);
    let causeLabels = null;
    if (data.causeLabels !== undefined) {
      causeLabels = H.categoryVector(data.causeLabels, "data.causeLabels", 1);
      if (causeLabels.length !== causes) H.fail("STAT_INVALID_INPUT", `data.causeLabels must contain exactly ${causes} labels`);
      if (new Set(causeLabels).size !== causes) H.fail("STAT_INVALID_INPUT", "data.causeLabels must be unique");
    }
    return { time, event, causes, group, causeLabels: causeLabels || Array.from({ length: causes }, (_, index) => `cause ${index + 1}`), outcomeLabel: H.label(data.outcomeLabel, "Event", "data.outcomeLabel") };
  },
  analyze(parsed, options, budget, H) {
    const n = parsed.time.length;
    const z = zCritical(H, options.confidenceLevel);
    const groupLevels = parsed.group ? levelsOf(parsed.group) : ["(all)"];
    const groupIndices = groupLevels.map((level) => parsed.time.map((_, index) => index).filter((index) => (parsed.group ? parsed.group[index] === level : true)));
    const tables = groupIndices.map((indices) => competingRiskTable(parsed.time, parsed.event, indices, parsed.causes));
    const cifRows = groupLevels.flatMap((level, g) => aalenJohansen(tables[g], parsed.causes, z, budget).map((row) => ({ group: level, causeLabel: parsed.causeLabels[row.cause - 1], ...row })));
    const eventCounts = groupLevels.map((level, g) => ({ group: level, n: groupIndices[g].length, censored: groupIndices[g].filter((index) => parsed.event[index] === 0).length, ...Object.fromEntries(parsed.causeLabels.map((label, k) => [`events_${k + 1}`, groupIndices[g].filter((index) => parsed.event[index] === k + 1).length])) }));
    const finalRows = groupLevels.flatMap((level, g) => parsed.causeLabels.map((label, k) => {
      const matching = cifRows.filter((row) => row.group === level && row.cause === k + 1);
      const last = matching[matching.length - 1];
      return { group: level, cause: k + 1, causeLabel: label, time: last.time, cumulativeIncidence: last.cumulativeIncidence, standardError: last.standardError, lower: last.lower, upper: last.upper };
    }));
    let gray = null;
    if (parsed.group) {
      const k = groupLevels.length;
      const full = grayScore(tables, options.causeOfInterest, options.grayRho, budget);
      // delete-one jackknife covariance of the first k-1 score components
      const replicates = [];
      for (let drop = 0; drop < n; drop += 1) {
        budget.check(16);
        const reducedTables = groupIndices.map((indices) => competingRiskTable(parsed.time, parsed.event, indices.filter((index) => index !== drop), parsed.causes));
        replicates.push(grayScore(reducedTables, options.causeOfInterest, options.grayRho, budget).slice(0, k - 1));
      }
      const meanReplicate = zeros(k - 1);
      for (const replicate of replicates) for (let j = 0; j < k - 1; j += 1) meanReplicate[j] += replicate[j] / n;
      const covariance = zeroMatrix(k - 1);
      for (const replicate of replicates) for (let j = 0; j < k - 1; j += 1) for (let l = 0; l < k - 1; l += 1) covariance[j][l] += (replicate[j] - meanReplicate[j]) * (replicate[l] - meanReplicate[l]) * (n - 1) / n;
      if (covariance.every((row) => row.every((value) => value === 0))) H.fail("STAT_DEGENERATE", "Gray-type score variance is zero; the cause of interest does not vary across groups");
      const statistic = Math.max(0, quadratic(full.slice(0, k - 1), safeInvert(H, covariance, "Gray-type score covariance")));
      gray = { statistic, df: k - 1, pValue: H.pFromChiSquare(statistic, k - 1), scores: full, covariance, cause: options.causeOfInterest, rho: options.grayRho };
    }
    const causeLabel = parsed.causeLabels[options.causeOfInterest - 1];
    const cifColumns = [{ key: "group", label: "Group", type: "string" }, { key: "cause", label: "Cause", type: "number" }, { key: "causeLabel", label: "Cause label", type: "string" }, { key: "time", label: "Time", type: "number" }, { key: "atRisk", label: "At risk", type: "number" }, { key: "events", label: "Cause events", type: "number" }, { key: "allCauseEvents", label: "All events", type: "number" }, { key: "censored", label: "Censored", type: "number" }, { key: "survival", label: "Event-free survival", type: "number" }, { key: "cumulativeIncidence", label: "Cumulative incidence", type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "lower", label: "CI lower", type: "number" }, { key: "upper", label: "CI upper", type: "number" }];
    return {
      sample: { n, groups: groupLevels.length, causes: parsed.causes, counts: eventCounts },
      estimates: finalRows.map((row) => ({ name: `${row.group}: ${row.causeLabel} cumulative incidence at ${row.time}`, estimate: row.cumulativeIncidence, standardError: row.standardError, lower: row.lower, upper: row.upper })),
      tests: gray ? [{ name: `Gray-type ${groupLevels.length}-sample test for ${causeLabel} (rho = ${options.grayRho})`, statistic: gray.statistic, distribution: "chi-square", df: gray.df, pValue: gray.pValue, varianceEstimator: "delete-one jackknife" }] : [],
      confidenceIntervals: finalRows.map((row) => ({ parameter: `${row.group}: ${row.causeLabel} cumulative incidence at ${row.time}`, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: "complementary log-log with Aalen-Johansen variance" })),
      effectSizes: finalRows.filter((row) => row.cause === options.causeOfInterest).map((row) => ({ name: `${row.group}: final ${causeLabel} cumulative incidence`, estimate: row.cumulativeIncidence })),
      assumptions: [
        { name: "competing events are terminal and mutually exclusive", status: "verified_by_input_contract" },
        { name: "non-informative censoring for all causes", status: "requires_design_review" },
        { name: "independent observations", status: "requires_design_review" },
        { name: "1 - Kaplan-Meier would overstate incidence in the presence of competing events", status: "method_definition" },
      ],
      diagnostics: [
        { name: "event accounting", counts: eventCounts, causeOfInterest: options.causeOfInterest, causeLabel },
        { name: "variance estimator", status: "asymptotic", detail: "Aalen-Johansen cumulative incidence with the Greenwood-type variance of Marubini and Valsecchi / Collett (three-term form) and complementary log-log pointwise intervals" },
        ...(gray ? [{ name: "group comparison", status: "jackknife_variance", detail: "Gray (1988) k-sample score for the subdistribution hazard with modified risk sets; the covariance is a delete-one jackknife rather than the closed-form Gray covariance", scores: gray.scores, covariance: gray.covariance, rho: options.grayRho }] : [{ name: "group comparison", status: "not_requested", reason: "supply data.group to compare cumulative incidence across groups" }]),
      ],
      artifacts: [
        H.tableArtifact(`Cumulative incidence at last event time: ${parsed.outcomeLabel}`, `Aalen-Johansen estimates with ${percent(options.confidenceLevel)}% log-log intervals.`, [{ key: "group", label: "Group", type: "string" }, { key: "cause", label: "Cause", type: "number" }, { key: "causeLabel", label: "Cause label", type: "string" }, { key: "time", label: "Time", type: "number" }, { key: "cumulativeIncidence", label: "Cumulative incidence", type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "lower", label: "CI lower", type: "number" }, { key: "upper", label: "CI upper", type: "number" }], finalRows, gray ? [`Gray-type chi-square(${gray.df}) = ${gray.statistic}, p = ${gray.pValue} for ${causeLabel}.`] : []),
        H.tableArtifact("Cumulative incidence functions", "One row per group, cause, and distinct time.", cifColumns, cifRows, [], "cumulative-incidence-table"),
        H.vegaArtifact("cumulative-incidence-stacked", `Stacked cumulative incidence by cause${parsed.group ? " and group" : ""}`, {
          data: { values: cifRows },
          mark: { type: "area", interpolate: "step-after", opacity: 0.85 },
          encoding: {
            x: { field: "time", type: "quantitative", title: "Time" },
            y: { field: "cumulativeIncidence", type: "quantitative", stack: "zero", scale: { domain: [0, 1] }, title: "Cumulative incidence" },
            color: { field: "causeLabel", type: "nominal", title: "Cause" },
            ...(parsed.group ? { column: { field: "group", type: "nominal", title: null } } : {}),
            tooltip: [{ field: "group" }, { field: "causeLabel" }, { field: "time", format: ".4g" }, { field: "cumulativeIncidence", format: ".4f" }, { field: "lower", format: ".4f" }, { field: "upper", format: ".4f" }],
          },
          description: "Stacked Aalen-Johansen cumulative incidence; the top edge equals 1 minus event-free survival.",
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "Subjects can experience one of several mutually exclusive event types (relapse versus death, device failure modes) and the probability of a specific event type over time is the quantity of interest.",
    decision: "Decide how likely each event type is by a given time while accounting for the competing events, and whether that probability differs between groups.",
    mustShow: "Cumulative incidence per cause with intervals at each time and at the end of follow-up, the event accounting per group, and the Gray-type group comparison with its variance estimator stated.",
    userGoal: "Report absolute risks of a specific event type that do not overstate incidence the way one minus Kaplan-Meier would.",
    nextActions: [
      { trigger: "groups-differ", action: "fit-fine-gray-or-cause-specific-cox-model", reason: "The k-sample test does not quantify the size of the group effect on the subdistribution hazard." },
      { trigger: "competing-event-dominates", action: "report-cause-specific-hazards-alongside-cumulative-incidence", reason: "Differences in cumulative incidence can arise from differences in the competing event rather than the cause of interest." },
      { trigger: "few-events-of-interest", action: "widen-interpretation-and-report-interval-width", reason: "Log-log intervals become very wide with few cause-specific events." },
    ],
  },
  fixture: {
    data: {
      time: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31],
      event: [1, 2, 1, 0, 1, 2, 1, 1, 0, 2, 1, 1, 2, 0, 1, 2, 1, 0, 1, 2, 0, 1, 1, 2, 1, 0, 2, 1, 0, 1],
      group: ["A", "B", "A", "B", "A", "B", "A", "B", "A", "B", "A", "B", "A", "B", "A", "B", "A", "B", "A", "B", "A", "B", "A", "B", "A", "B", "A", "B", "A", "B"],
      causeLabels: ["relapse", "death without relapse"],
      outcomeLabel: "Relapse",
    },
    options: { causeOfInterest: 1, confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.distribution"] },
  coverage: {
    implementedBoundary: "Aalen-Johansen cumulative incidence for up to 8 competing causes, optionally by group, with the three-term Greenwood-type variance and log-log intervals, and a Gray (1988) k-sample score with rho weighting whose covariance is a delete-one jackknife (at most 2000 rows when grouped).",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["cumulative incidence per cause and time on untied data (lifelines AalenJohansenFitter)", "cumulative incidence variance and log-log bounds on untied data (lifelines AalenJohansenFitter calculate_variance)", "Gray-type score vector (numpy first-principles re-implementation)"], excludedOutputs: ["Gray closed-form covariance (cmprsk not available; jackknife variance is used and only re-implemented in numpy)", "tied event times (lifelines jitters ties)"] },
    diagnostic: { level: "method-specific-partial", emitted: ["event accounting", "variance estimator", "group comparison scores and covariance"], limitations: ["no Fine-Gray regression", "jackknife covariance is not the Gray closed form"] },
    knownGaps: ["no Fine-Gray subdistribution regression", "no closed-form Gray covariance", "no cause-specific hazard ratios"],
  },
};

// ---------------------------------------------------------------------------------------------
// 5. Restricted mean survival time
// ---------------------------------------------------------------------------------------------

function restrictedMean(curve, tau, budget) {
  // curve: rows from H.kaplanMeierCore (index 0 is time 0); returns { rmst, variance, rows }
  const steps = curve.filter((row) => row.time <= tau);
  const rows = [];
  let rmst = 0;
  let previousTime = 0;
  let previousSurvival = 1;
  for (let i = 1; i < steps.length; i += 1) {
    budget.check();
    const row = steps[i];
    const area = (row.time - previousTime) * previousSurvival;
    rmst += area;
    rows.push({ ...row, areaSegment: area });
    previousTime = row.time;
    previousSurvival = row.survival;
  }
  const tailArea = (tau - previousTime) * previousSurvival;
  rmst += tailArea;
  // Greenwood-type variance: sum over event times of (area from t_j to tau)^2 d_j / (n_j (n_j - d_j))
  let variance = 0;
  for (let i = 1; i < steps.length; i += 1) {
    const row = steps[i];
    if (row.events === 0 || row.nAtRisk === row.events) continue;
    let areaAfter = tailArea;
    for (let j = i + 1; j < steps.length; j += 1) { budget.check(); areaAfter += rows[j - 1].areaSegment; }
    variance += areaAfter * areaAfter * row.events / (row.nAtRisk * (row.nAtRisk - row.events));
  }
  return { rmst, variance, rows, tailArea, lastTime: previousTime, lastSurvival: previousSurvival };
}

const restrictedMeanSurvivalTime = {
  method: "restricted_mean_survival_time",
  family: "survival",
  analysisModel: MODEL,
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    tau: { schema: { type: ["number", "null"], exclusiveMinimum: 0 }, default: null, parse(value, H, path) { if (value === null) return null; const v = H.finiteNumber(value, path); if (!(v > 0)) H.fail("STAT_INVALID_INPUT", `${path} must be positive`); return v; } },
  },
  dataSchema: groupsSchema(1),
  parse(data, options, H) { return parseCohortGroups(data, H, 1); },
  analyze(parsed, options, budget, H) {
    const groups = parsed.groups;
    const maxFollowUp = groups.map((group) => Math.max(...group.time));
    const tau = options.tau === null ? Math.min(...maxFollowUp) : options.tau;
    if (options.tau !== null && maxFollowUp.some((value) => value < tau)) H.fail("STAT_INVALID_INPUT", `options.tau (${tau}) exceeds the follow-up of at least one group (${Math.min(...maxFollowUp)})`);
    const z = zCritical(H, options.confidenceLevel);
    const curves = kmRows(groups, options.confidenceLevel, budget, H);
    const results = curves.map((curve) => restrictedMean(curve.curve, tau, budget));
    const summary = groups.map((group, g) => {
      const se = Math.sqrt(results[g].variance);
      return { group: group.name, n: group.time.length, events: curves[g].events, tau, rmst: results[g].rmst, standardError: se, lower: results[g].rmst - z * se, upper: results[g].rmst + z * se, rmtl: tau - results[g].rmst, survivalAtTau: results[g].lastSurvival };
    });
    const contrasts = summary.slice(1).map((row) => {
      const reference = summary[0];
      const difference = row.rmst - reference.rmst;
      const se = Math.sqrt(row.standardError ** 2 + reference.standardError ** 2);
      const statistic = se > 0 ? difference / se : 0;
      const ratio = reference.rmst > 0 ? row.rmst / reference.rmst : null;
      const logRatioSe = ratio ? Math.sqrt((row.standardError / row.rmst) ** 2 + (reference.standardError / reference.rmst) ** 2) : null;
      return { contrast: `${row.group} - ${reference.group}`, difference, standardError: se, lower: difference - z * se, upper: difference + z * se, statistic, pValue: twoSidedNormalP(H, statistic), ratio, ratioLower: ratio ? Math.exp(Math.log(ratio) - z * logRatioSe) : null, ratioUpper: ratio ? Math.exp(Math.log(ratio) + z * logRatioSe) : null };
    });
    const curveRows = groups.flatMap((group, g) => [
      ...results[g].rows.map(({ greenwoodVariance, areaSegment, ...row }) => ({ ...row, areaSegment })),
      { group: group.name, time: tau, nAtRisk: 0, events: 0, censored: 0, survival: results[g].lastSurvival, standardError: 0, lower: results[g].lastSurvival, upper: results[g].lastSurvival, areaSegment: results[g].tailArea },
    ]);
    const curveColumns = [...kmColumns, { key: "areaSegment", label: "Area of preceding step", type: "number" }];
    return {
      sample: { groups: summary.map((row) => ({ name: row.group, n: row.n, events: row.events })), tau, tauSource: options.tau === null ? "minimum of the per-group maximum follow-up" : "supplied" },
      estimates: [
        ...summary.map((row) => ({ name: `${row.group} RMST(${tau})`, estimate: row.rmst, standardError: row.standardError, rmtl: row.rmtl })),
        ...contrasts.map((row) => ({ name: `RMST difference ${row.contrast}`, estimate: row.difference, standardError: row.standardError, ratio: row.ratio })),
      ],
      tests: contrasts.map((row) => ({ name: `RMST difference ${row.contrast}`, statistic: row.statistic, distribution: "normal", pValue: row.pValue })),
      confidenceIntervals: [
        ...summary.map((row) => ({ parameter: `${row.group} RMST(${tau})`, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: "Wald normal with Greenwood-type variance" })),
        ...contrasts.flatMap((row) => [{ parameter: `RMST difference ${row.contrast}`, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: "Wald normal, independent groups" }, ...(row.ratio ? [{ parameter: `RMST ratio ${row.contrast}`, level: options.confidenceLevel, lower: row.ratioLower, upper: row.ratioUpper, method: "Wald on log ratio (delta method)" }] : [])]),
      ],
      effectSizes: contrasts.map((row) => ({ name: `RMST difference ${row.contrast}`, estimate: row.difference, lower: row.lower, upper: row.upper, interpretation: `mean extra event-free time up to ${tau}` })),
      assumptions: [{ name: "right censoring", status: "verified_by_input_contract" }, { name: "non-informative censoring", status: "requires_design_review" }, { name: "tau chosen before inspecting the curves and within follow-up of every group", status: options.tau === null ? "default_tau_from_follow_up" : "supplied_tau" }, { name: "independent groups", status: "requires_design_review" }],
      diagnostics: [
        { name: "truncation time", tau, groupMaximumFollowUp: groups.map((group, g) => ({ group: group.name, maximumFollowUp: maxFollowUp[g], survivalAtTau: results[g].lastSurvival, lastEventOrCensorBeforeTau: results[g].lastTime })) },
        { name: "variance estimator", status: "asymptotic", detail: "Greenwood-type variance sum_j A_j^2 d_j / (n_j (n_j - d_j)) with A_j the area under the curve from t_j to tau (survRM2 form)" },
        { name: "contrast reference", status: "first_group", reference: groups[0].name },
      ],
      artifacts: [
        H.tableArtifact(`Restricted mean survival time to ${tau}: ${parsed.outcomeLabel}`, `RMST with ${percent(options.confidenceLevel)}% Wald intervals; RMTL = tau - RMST.`, [{ key: "group", label: "Group", type: "string" }, { key: "n", label: "n", type: "number" }, { key: "events", label: "Events", type: "number" }, { key: "tau", label: "tau", type: "number" }, { key: "rmst", label: "RMST", type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "lower", label: "CI lower", type: "number" }, { key: "upper", label: "CI upper", type: "number" }, { key: "rmtl", label: "RMTL", type: "number" }, { key: "survivalAtTau", label: "S(tau)", type: "number" }], summary, []),
        H.tableArtifact("RMST contrasts", `Differences and ratios versus ${groups[0].name}.`, [{ key: "contrast", label: "Contrast", type: "string" }, { key: "difference", label: "Difference", type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "lower", label: "CI lower", type: "number" }, { key: "upper", label: "CI upper", type: "number" }, { key: "statistic", label: "z", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "ratio", label: "Ratio", type: "number" }, { key: "ratioLower", label: "Ratio CI lower", type: "number" }, { key: "ratioUpper", label: "Ratio CI upper", type: "number" }], contrasts, [], "rmst-contrast-table"),
        H.tableArtifact("Restricted Kaplan-Meier curves", `Kaplan-Meier steps up to tau = ${tau} with the area of each step.`, curveColumns, curveRows, [], "rmst-curve-table"),
        kmCurveFigure(H, "rmst-area-curves", `Kaplan-Meier curves with area to tau = ${tau}`, curveRows, "The restricted mean survival time is the area under each curve up to tau.", [
          { mark: { type: "area", opacity: 0.22, interpolate: "step-after" }, encoding: { x: { field: "time", type: "quantitative" }, y: { field: "survival", type: "quantitative" }, color: { field: "group", type: "nominal" } } },
          { mark: { type: "rule", strokeDash: [6, 3], color: "#333" }, encoding: { x: { datum: tau } } },
        ]),
      ],
    };
  },
  linkage: {
    neededWhen: "A survival contrast is needed on the time scale rather than as a hazard ratio, especially when proportional hazards fails, curves cross, or the audience needs an absolute mean-time difference over a fixed horizon.",
    decision: "Decide how much event-free time each group accumulates up to a pre-specified horizon and whether the difference between groups is precise enough to act on.",
    mustShow: "The truncation time and how it was chosen, the RMST per group with intervals, differences and ratios versus the reference group, and the restricted curves with the area shaded.",
    userGoal: "Report a model-free absolute effect in units of time that remains valid when hazards are not proportional.",
    nextActions: [
      { trigger: "difference-interval-excludes-zero", action: "report-rmst-difference-with-interval-and-tau", reason: "The RMST difference is interpretable as extra mean event-free time up to tau." },
      { trigger: "tau-near-end-of-follow-up", action: "shorten-tau-or-report-sensitivity-across-tau", reason: "Few subjects at risk near tau inflate the variance and make the estimate fragile." },
      { trigger: "proportional-hazards-plausible", action: "report-hazard-ratio-alongside-rmst", reason: "When hazards are proportional, the Cox model gives a more powerful summary that complements the time-scale estimate." },
    ],
  },
  fixture: {
    data: { groups: [
      { name: "control", time: [4, 6, 8, 10, 12, 14, 15, 18, 20, 22, 25, 28, 30, 33, 36], event: [1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0] },
      { name: "treatment", time: [5, 9, 11, 14, 17, 19, 21, 24, 27, 29, 32, 34, 35, 38, 40], event: [1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 0] },
    ], outcomeLabel: "Overall survival" },
    options: { tau: 30, confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.descriptive-visualization"] },
  coverage: {
    implementedBoundary: "Kaplan-Meier based restricted mean survival time up to tau for 1-64 groups with Greenwood-type variance (survRM2 form), Wald intervals, and difference and ratio contrasts versus the first group.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["RMST point estimate per group (lifelines restricted_mean_survival_time on KaplanMeierFitter)", "variance, difference, and ratio (numpy first principles of the survRM2 formulas)"], excludedOutputs: ["adjusted RMST regression", "bootstrap intervals"] },
    diagnostic: { level: "method-specific-partial", emitted: ["truncation-time provenance", "variance estimator", "contrast reference"], limitations: ["no covariate adjustment"] },
    knownGaps: ["no covariate-adjusted (pseudo-value or IPCW) RMST regression", "no simultaneous bands"],
  },
};

// ---------------------------------------------------------------------------------------------
// 6. Nelson-Aalen cumulative hazard
// ---------------------------------------------------------------------------------------------

const nelsonAalen = {
  method: "nelson_aalen",
  family: "survival",
  analysisModel: MODEL,
  optionKeys: ["confidenceLevel", "timeoutMs"],
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["time", "event"],
    properties: {
      time: { type: "array", minItems: 5, maxItems: 10000, items: { type: "number", exclusiveMinimum: 0 } },
      event: { type: "array", minItems: 5, maxItems: 10000, items: { type: "integer", enum: [0, 1] } },
      label: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["time", "event", "label"], "data");
    const { time, event } = parseTimeEvent(data, H, H.LIMITS.maxSurvivalRows, 5);
    return { time, event, label: H.label(data.label, "Survival", "data.label") };
  },
  analyze(parsed, options, budget, H) {
    const z = zCritical(H, options.confidenceLevel);
    const table = riskTable([{ name: parsed.label, time: parsed.time, event: parsed.event }], budget);
    let cumulativeHazard = 0;
    let varianceValue = 0;
    let kmSurvival = 1;
    const rows = [];
    for (const row of table) {
      budget.check();
      const increment = row.d / row.n;
      cumulativeHazard += increment;
      varianceValue += row.d * (row.n - row.d) / Math.pow(row.n, 3);
      if (row.d > 0) kmSurvival *= 1 - row.d / row.n;
      const standardError = Math.sqrt(varianceValue);
      const lower = cumulativeHazard > 0 ? cumulativeHazard * Math.exp(-z * standardError / cumulativeHazard) : 0;
      const upper = cumulativeHazard > 0 ? cumulativeHazard * Math.exp(z * standardError / cumulativeHazard) : 0;
      rows.push({ time: row.time, nAtRisk: row.n, events: row.d, censored: row.c, hazardIncrement: increment, cumulativeHazard, standardError, lower, upper, flemingHarringtonSurvival: Math.exp(-cumulativeHazard), kaplanMeierSurvival: kmSurvival });
    }
    const events = H.sum(parsed.event);
    const last = rows[rows.length - 1];
    const eventRows = rows.filter((row) => row.events > 0);
    const maxGap = Math.max(...rows.map((row) => Math.abs(row.flemingHarringtonSurvival - row.kaplanMeierSurvival)));
    return {
      sample: { n: parsed.time.length, events, censored: parsed.time.length - events, distinctTimes: rows.length },
      estimates: [
        { name: `cumulative hazard at ${last.time}`, estimate: last.cumulativeHazard, standardError: last.standardError },
        { name: `Fleming-Harrington survival at ${last.time}`, estimate: last.flemingHarringtonSurvival },
        { name: "mean hazard increment per event time", estimate: H.mean(eventRows.map((row) => row.hazardIncrement), budget) },
      ],
      tests: [],
      confidenceIntervals: eventRows.map((row) => ({ parameter: `H(${row.time})`, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: "log-transformed Wald with Klein tie-corrected variance" })),
      effectSizes: [{ name: "maximum absolute gap between exp(-H) and Kaplan-Meier", estimate: maxGap, interpretation: "large gaps arise from heavy ties or small risk sets" }],
      assumptions: [{ name: "right censoring", status: "verified_by_input_contract" }, { name: "non-informative censoring and independent observations", status: "requires_design_review" }],
      diagnostics: [
        { name: "variance estimator", status: "asymptotic", detail: "Klein (1991) tie-corrected variance sum d (n - d) / n^3; intervals on the log scale" },
        { name: "ties", tiedEventTimes: eventRows.filter((row) => row.events > 1).length, policy: "tied events share the risk set; censor removals follow events at a shared time" },
        { name: "survival comparison", status: "reported", maximumGap: maxGap, detail: "exp(-H) is the Fleming-Harrington (Breslow) survival estimate; it is never below the Kaplan-Meier estimate" },
      ],
      artifacts: [
        H.tableArtifact(`Nelson-Aalen cumulative hazard: ${parsed.label}`, `${percent(options.confidenceLevel)}% log-transformed pointwise intervals.`, [{ key: "time", label: "Time", type: "number" }, { key: "nAtRisk", label: "At risk", type: "number" }, { key: "events", label: "Events", type: "number" }, { key: "censored", label: "Censored", type: "number" }, { key: "hazardIncrement", label: "d/n", type: "number" }, { key: "cumulativeHazard", label: "H(t)", type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "lower", label: "CI lower", type: "number" }, { key: "upper", label: "CI upper", type: "number" }, { key: "flemingHarringtonSurvival", label: "exp(-H)", type: "number" }, { key: "kaplanMeierSurvival", label: "Kaplan-Meier", type: "number" }], rows, []),
        H.vegaArtifact("cumulative-hazard-curve", `Nelson-Aalen cumulative hazard: ${parsed.label}`, {
          data: { values: rows },
          layer: [
            { mark: { type: "area", opacity: 0.18, interpolate: "step-after", color: "#285f8f" }, encoding: { x: { field: "time", type: "quantitative", title: "Time" }, y: { field: "lower", type: "quantitative", title: "Cumulative hazard H(t)" }, y2: { field: "upper" } } },
            { mark: { type: "line", interpolate: "step-after", strokeWidth: 2.5, color: "#285f8f" }, encoding: { x: { field: "time", type: "quantitative" }, y: { field: "cumulativeHazard", type: "quantitative" }, tooltip: [{ field: "time", format: ".4g" }, { field: "nAtRisk" }, { field: "events" }, { field: "cumulativeHazard", format: ".4f" }, { field: "lower", format: ".4f" }, { field: "upper", format: ".4f" }] } },
            { transform: [{ filter: "datum.censored > 0" }], mark: { type: "point", shape: "cross", size: 55, color: "#285f8f" }, encoding: { x: { field: "time", type: "quantitative" }, y: { field: "cumulativeHazard", type: "quantitative" } } },
          ],
          config: { axis: { grid: true } },
          description: "A straight line indicates a constant hazard; convexity indicates an increasing hazard.",
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "The shape of the hazard over time (constant, increasing, decreasing) must be assessed, a parametric family must be screened, or a cumulative hazard is needed for a Cox-Snell residual check.",
    decision: "Decide whether the hazard is constant, monotone, or changes shape, and which parametric family a later model should use.",
    mustShow: "The cumulative hazard with pointwise intervals at every time, the at-risk and event counts, and the comparison with the Kaplan-Meier survival.",
    userGoal: "Read the hazard shape directly from data before committing to a survival model.",
    nextActions: [
      { trigger: "cumulative-hazard-linear", action: "consider-exponential-model", reason: "A linear cumulative hazard implies a constant hazard rate." },
      { trigger: "log-cumulative-hazard-linear-in-log-time", action: "consider-weibull-model", reason: "Linearity of log H(t) against log t is the Weibull signature." },
      { trigger: "hazard-shape-non-monotone", action: "prefer-cox-or-flexible-parametric-model", reason: "Non-monotone hazards are not captured by the standard AFT families." },
    ],
  },
  fixture: { data: { time: [3, 5, 6, 6, 8, 10, 12, 12, 15, 18, 20, 23, 26, 30, 34], event: [1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 0], label: "Time to failure" } },
  matlabParity: { taxonomyIds: ["matlab.stats.descriptive-visualization"] },
  coverage: {
    implementedBoundary: "Nelson-Aalen cumulative hazard for one right-censored sample with the Klein tie-corrected variance, log-transformed pointwise intervals, and the Fleming-Harrington survival exp(-H) beside Kaplan-Meier.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["cumulative hazard at every time (lifelines NelsonAalenFitter, nelson_aalen_smoothing=False)", "variance and log-transformed bounds (numpy first principles)"], excludedOutputs: ["kernel-smoothed hazard rate"] },
    diagnostic: { level: "method-specific-partial", emitted: ["variance estimator", "tie accounting", "survival comparison"], limitations: ["no smoothed hazard estimate", "no simultaneous bands"] },
    knownGaps: ["no kernel-smoothed hazard", "no Hall-Wellner or equal-precision bands"],
  },
};

// ---------------------------------------------------------------------------------------------
// 7. Landmark analysis
// ---------------------------------------------------------------------------------------------

const survivalLandmarkAnalysis = {
  method: "survival_landmark_analysis",
  family: "survival",
  analysisModel: MODEL,
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    landmarkTime: { schema: { type: ["number", "null"], exclusiveMinimum: 0 }, default: null, parse(value, H, path) { if (value === null) return null; const v = H.finiteNumber(value, path); if (!(v > 0)) H.fail("STAT_INVALID_INPUT", `${path} must be positive`); return v; } },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["time", "event", "group"],
    properties: {
      time: { type: "array", minItems: 8, maxItems: 10000, items: { type: "number", exclusiveMinimum: 0 } },
      event: { type: "array", minItems: 8, maxItems: 10000, items: { type: "integer", enum: [0, 1] } },
      group: { type: "array", minItems: 8, maxItems: 10000, items: { type: "string", minLength: 1, maxLength: 128 } },
      outcomeLabel: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["time", "event", "group", "outcomeLabel"], "data");
    if (options.landmarkTime === null) H.fail("STAT_INVALID_INPUT", "options.landmarkTime is required and must be chosen before inspecting the outcome");
    const { time, event } = parseTimeEvent(data, H, H.LIMITS.maxSurvivalRows, 8);
    const group = parseLabels(data.group, time.length, "data.group", H);
    if (group === null || levelsOf(group).length < 2) H.fail("STAT_INVALID_INPUT", "data.group must contain at least two groups");
    if (levelsOf(group).length > H.LIMITS.maxGroups) H.fail("STAT_LIMIT_EXCEEDED", `data.group supports at most ${H.LIMITS.maxGroups} groups`);
    return { time, event, group, outcomeLabel: H.label(data.outcomeLabel, "Survival", "data.outcomeLabel") };
  },
  analyze(parsed, options, budget, H) {
    const landmark = options.landmarkTime;
    const levels = levelsOf(parsed.group);
    const accounting = levels.map((level) => {
      const indices = parsed.time.map((_, index) => index).filter((index) => parsed.group[index] === level);
      const atLandmark = indices.filter((index) => parsed.time[index] > landmark);
      return { group: level, n: indices.length, eventsBeforeLandmark: indices.filter((index) => parsed.time[index] <= landmark && parsed.event[index] === 1).length, censoredBeforeLandmark: indices.filter((index) => parsed.time[index] <= landmark && parsed.event[index] === 0).length, atRiskAtLandmark: atLandmark.length, eventsAfterLandmark: atLandmark.filter((index) => parsed.event[index] === 1).length, time: atLandmark.map((index) => parsed.time[index] - landmark), event: atLandmark.map((index) => parsed.event[index]) };
    });
    const retained = accounting.filter((row) => row.atRiskAtLandmark >= 2);
    if (retained.length < 2) H.fail("STAT_INSUFFICIENT_SAMPLE", "fewer than two groups have at least two subjects at risk at the landmark time");
    if (retained.every((row) => row.eventsAfterLandmark === 0)) H.fail("STAT_DEGENERATE", "no events occur after the landmark time");
    const groups = retained.map((row) => ({ name: row.group, time: row.time, event: row.event }));
    const core = weightedLogRankCore(groups, "log-rank", 0, 0, budget, H);
    const curves = groups.map((group) => group.event.some((value) => value === 1) ? H.kaplanMeierCore(group.time, group.event, group.name, options.confidenceLevel, budget) : null);
    const curveRows = curves.flatMap((curve, g) => curve ? curve.curve.slice(1).map(({ greenwoodVariance, ...row }) => ({ ...row, time: row.time + landmark, timeSinceLandmark: row.time })) : [{ group: groups[g].name, time: landmark + Math.max(...groups[g].time), timeSinceLandmark: Math.max(...groups[g].time), nAtRisk: groups[g].time.length, events: 0, censored: groups[g].time.length, survival: 1, standardError: 0, lower: 1, upper: 1 }]);
    const summaryRows = accounting.map((row) => ({ group: row.group, n: row.n, eventsBeforeLandmark: row.eventsBeforeLandmark, censoredBeforeLandmark: row.censoredBeforeLandmark, atRiskAtLandmark: row.atRiskAtLandmark, eventsAfterLandmark: row.eventsAfterLandmark, included: row.atRiskAtLandmark >= 2, conditionalMedian: (() => { const index = retained.findIndex((item) => item.group === row.group); return index >= 0 && curves[index] ? curves[index].medianSurvival : null; })() }));
    const excludedTotal = accounting.reduce((total, row) => total + row.eventsBeforeLandmark + row.censoredBeforeLandmark, 0);
    return {
      sample: { n: parsed.time.length, landmarkTime: landmark, atRiskAtLandmark: accounting.reduce((total, row) => total + row.atRiskAtLandmark, 0), excludedBeforeLandmark: excludedTotal, groupsCompared: groups.length },
      estimates: [
        ...summaryRows.map((row) => ({ name: `${row.group} at risk at landmark`, estimate: row.atRiskAtLandmark, eventsAfterLandmark: row.eventsAfterLandmark, conditionalMedian: row.conditionalMedian })),
        ...groups.map((group, g) => ({ name: `${group.name} weighted observed minus expected after landmark`, estimate: core.z[g] })),
      ],
      tests: [{ name: `Landmark log-rank test (time > ${landmark})`, statistic: core.statistic, distribution: "chi-square", df: core.df, pValue: core.pValue }],
      confidenceIntervals: [],
      effectSizes: groups.map((group, g) => ({ name: `${group.name} observed / expected events after landmark`, estimate: core.expected[g] > 0 ? core.observed[g] / core.expected[g] : null })),
      assumptions: [
        { name: "landmark time fixed before inspecting outcomes", status: "requires_design_review" },
        { name: "group membership is known at the landmark and does not change afterwards", status: "requires_design_review" },
        { name: "non-informative censoring after the landmark", status: "requires_design_review" },
        { name: "subjects with events or censoring at or before the landmark are excluded (no immortal time)", status: "verified_by_method_definition" },
      ],
      diagnostics: [
        { name: "landmark accounting", landmarkTime: landmark, rows: summaryRows.map(({ conditionalMedian, ...row }) => row), excludedTotal },
        { name: "conditional survival", status: "reported", detail: "curves are Kaplan-Meier estimates conditional on being event-free and under follow-up at the landmark; time is reset to zero at the landmark" },
        { name: "event-time accounting", informativeTimes: core.informativeTimes, tiedEventTimes: core.tiedEventTimes, droppedGroups: accounting.filter((row) => row.atRiskAtLandmark < 2).map((row) => row.group) },
      ],
      artifacts: [
        H.tableArtifact(`Landmark analysis at ${landmark}: ${parsed.outcomeLabel}`, "Subjects at risk at the landmark and events afterwards by group.", [{ key: "group", label: "Group", type: "string" }, { key: "n", label: "n", type: "number" }, { key: "eventsBeforeLandmark", label: "Events before landmark", type: "number" }, { key: "censoredBeforeLandmark", label: "Censored before landmark", type: "number" }, { key: "atRiskAtLandmark", label: "At risk at landmark", type: "number" }, { key: "eventsAfterLandmark", label: "Events after landmark", type: "number" }, { key: "included", label: "Included", type: "boolean" }, { key: "conditionalMedian", label: "Conditional median (from landmark)", type: "number" }], summaryRows, [`Log-rank chi-square(${core.df}) = ${core.statistic}, p = ${core.pValue}.`]),
        H.tableArtifact("Conditional Kaplan-Meier curves", `Survival conditional on being at risk at ${landmark}; time column is absolute, timeSinceLandmark is reset.`, [...kmColumns, { key: "timeSinceLandmark", label: "Time since landmark", type: "number" }], curveRows, [], "landmark-km-table"),
        kmCurveFigure(H, "landmark-km-curves", `Conditional survival after landmark ${landmark}`, curveRows, "Kaplan-Meier curves for subjects at risk at the landmark; the dashed rule marks the landmark.", [
          { mark: { type: "rule", strokeDash: [6, 3], color: "#333" }, encoding: { x: { datum: landmark } } },
        ]),
      ],
    };
  },
  linkage: {
    neededWhen: "Group membership is defined by something that happens during follow-up (response by month three, treatment switch, adherence) and naive comparison would credit the responders with the time they had to survive to be classified.",
    decision: "Decide whether survival differs between groups among subjects who were still at risk at a fixed landmark, without immortal-time bias.",
    mustShow: "The landmark time, subjects excluded before it, at-risk and event counts after it, the conditional survival curves, and the landmark log-rank test.",
    userGoal: "Compare time-dependent groups fairly by conditioning on survival to a pre-specified landmark.",
    nextActions: [
      { trigger: "many-subjects-excluded", action: "report-sensitivity-across-earlier-landmarks", reason: "A late landmark discards events and power; the conclusion should be stable across reasonable landmarks." },
      { trigger: "groups-differ-after-landmark", action: "fit-landmark-cox-model-for-adjusted-hazard-ratio", reason: "The log-rank test does not adjust for baseline covariates measured at the landmark." },
      { trigger: "membership-changes-after-landmark", action: "use-time-dependent-covariate-model-instead", reason: "Landmark analysis freezes group membership; later changes require a time-dependent model." },
    ],
  },
  fixture: {
    data: {
      time: [1, 2, 2.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 24, 26, 28],
      event: [1, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 0, 1, 0],
      group: ["non-responder", "non-responder", "responder", "non-responder", "responder", "non-responder", "non-responder", "responder", "non-responder", "responder", "non-responder", "responder", "responder", "non-responder", "responder", "non-responder", "responder", "responder", "non-responder", "responder", "responder", "responder", "non-responder", "responder"],
      outcomeLabel: "Overall survival",
    },
    options: { landmarkTime: 3, confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.distribution"] },
  coverage: {
    implementedBoundary: "Fixed-landmark analysis: subjects with time greater than the landmark are retained, time is reset, and groups (2-64) are compared with conditional Kaplan-Meier curves and a k-sample log-rank test.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["conditional Kaplan-Meier survival per group (lifelines KaplanMeierFitter on the landmark subset)", "landmark log-rank chi-square and p value (lifelines multivariate_logrank_test)", "at-risk and exclusion counts (numpy)"], excludedOutputs: ["landmark Cox model", "dynamic (super) landmark models"] },
    diagnostic: { level: "method-specific-partial", emitted: ["landmark accounting", "conditional survival boundary", "event-time accounting"], limitations: ["no covariate adjustment", "single landmark only"] },
    knownGaps: ["no landmark Cox regression", "no super-landmark model over multiple landmarks"],
  },
};

module.exports = { methods: [weightedLogRank, stratifiedCox, parametricSurvivalRegression, competingRisksCumulativeIncidence, restrictedMeanSurvivalTime, nelsonAalen, survivalLandmarkAnalysis] };
