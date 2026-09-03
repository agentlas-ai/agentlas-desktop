"use strict";

/**
 * Causal-inference family: difference-in-differences (2x2 and two-way fixed effects with event
 * study), propensity-score analysis (IPW and nearest-neighbour matching), two-stage least squares,
 * sharp regression discontinuity with the Imbens-Kalyanaraman bandwidth, and mediation analysis
 * with a seeded bootstrap. Pure deterministic JavaScript; numerics via H and the regression kit.
 */

const K = require("./regression-kit.cjs");

const MAX_ROWS = 5000;
const NUMBER_COLUMN = (key, label) => ({ key, label, type: "number" });
const STRING_COLUMN = (key, label) => ({ key, label, type: "string" });
const BOOLEAN_COLUMN = (key, label) => ({ key, label, type: "boolean" });
const LABEL_SCHEMA = { type: "string", minLength: 1, maxLength: 128 };
const NUMERIC_SCHEMA = (minItems) => ({ type: "array", minItems, maxItems: MAX_ROWS, items: { type: "number" } });
const BINARY_SCHEMA = (minItems) => ({ type: "array", minItems, maxItems: MAX_ROWS, items: { type: "integer", enum: [0, 1] } });
const CATEGORY_SCHEMA = (minItems) => ({ type: "array", minItems, maxItems: MAX_ROWS, items: { type: "string", minLength: 1, maxLength: 128 } });
const PREDICTORS_SCHEMA = (minItems) => ({
  type: "array",
  minItems,
  maxItems: 48,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["values"],
    properties: {
      name: LABEL_SCHEMA,
      type: { type: "string", enum: ["numeric", "categorical"] },
      values: { type: "array", minItems: 4, maxItems: MAX_ROWS, items: { type: ["number", "string"] } },
      reference: LABEL_SCHEMA,
    },
  },
});

function percent(level) {
  return `${Math.round(level * 1000) / 10}%`;
}

function limitRows(n, H, method) {
  if (n > MAX_ROWS) H.fail("STAT_LIMIT_EXCEEDED", `${method} supports at most ${MAX_ROWS} observations`);
}

function binaryVector(value, path, n, H) {
  const vector = H.numericVector(value, path, n);
  if (vector.length !== n) H.fail("STAT_INVALID_INPUT", `${path} length must match data.y`);
  vector.forEach((item, index) => { if (item !== 0 && item !== 1) H.fail("STAT_INVALID_INPUT", `${path}[${index}] must be 0 or 1`); });
  if (!vector.some((item) => item === 1) || !vector.some((item) => item === 0)) H.fail("STAT_DEGENERATE", `${path} must contain both 0 and 1`);
  return vector;
}

function optionalPredictors(raw, n, H) {
  if (raw === undefined) return [];
  return H.regressionPredictors(raw, n, { allowEmpty: true });
}

/** Append covariate design columns (no intercept) to a base design. */
function appendCovariates(x, terms, covariates, n, H) {
  if (!covariates.length) return { x, terms };
  const design = H.designMatrix({ y: Array(n).fill(0), predictors: covariates }, false);
  return { x: x.map((row, index) => [...row, ...design.x[index]]), terms: [...terms, ...design.terms.map((term) => term.name)] };
}

function assertRank(x, H, message) {
  if (H.matrixRank(x) < x[0].length) H.fail("STAT_RANK_DEFICIENT", message);
}

function coefficientTable(fit, names, level, H) {
  return K.coefficientRows(names, fit.beta, fit.covariance, fit.dfReference, level, H);
}

/* ------------------------------------------------------------------------------------------ */
/* Difference-in-differences                                                                   */
/* ------------------------------------------------------------------------------------------ */

const differenceInDifferences = {
  method: "difference_in_differences",
  family: "causal-inference",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "covariance", "timeoutMs"],
  customOptions: {
    design: { schema: { type: "string", enum: ["two-by-two", "twfe"] }, default: "two-by-two", parse(value, H, path) { if (!["two-by-two", "twfe"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be two-by-two or twfe`); return value; } },
    cluster: { schema: { type: "string", enum: ["none", "unit"] }, default: "none", parse(value, H, path) { if (!["none", "unit"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be none or unit`); return value; } },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["y", "treated", "post"],
    properties: {
      y: NUMERIC_SCHEMA(8),
      treated: BINARY_SCHEMA(8),
      post: BINARY_SCHEMA(8),
      unit: CATEGORY_SCHEMA(8),
      time: NUMERIC_SCHEMA(8),
      covariates: PREDICTORS_SCHEMA(1),
      outcomeLabel: LABEL_SCHEMA,
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["y", "treated", "post", "unit", "time", "covariates", "outcomeLabel"], "data");
    const y = H.numericVector(data.y, "data.y", 8);
    const n = y.length;
    limitRows(n, H, "difference_in_differences");
    const treated = binaryVector(data.treated, "data.treated", n, H);
    const post = binaryVector(data.post, "data.post", n, H);
    const cells = [0, 0, 0, 0];
    treated.forEach((value, index) => { cells[value * 2 + post[index]] += 1; });
    if (cells.some((count) => count < 2)) H.fail("STAT_INSUFFICIENT_SAMPLE", "each treated x period cell needs at least two observations");
    let unit = null;
    if (data.unit !== undefined) {
      unit = H.categoryVector(data.unit, "data.unit", 8);
      if (unit.length !== n) H.fail("STAT_INVALID_INPUT", "data.unit length must match data.y");
    }
    let time = null;
    if (data.time !== undefined) {
      time = H.numericVector(data.time, "data.time", 8);
      if (time.length !== n) H.fail("STAT_INVALID_INPUT", "data.time length must match data.y");
    }
    if (options.cluster === "unit" && !unit) H.fail("STAT_INVALID_INPUT", "options.cluster = unit requires data.unit");
    if (options.design === "twfe") {
      if (!unit || !time) H.fail("STAT_INVALID_INPUT", "options.design = twfe requires data.unit and data.time");
      const treatedByUnit = new Map();
      unit.forEach((id, index) => {
        if (treatedByUnit.has(id) && treatedByUnit.get(id) !== treated[index]) H.fail("STAT_INVALID_INPUT", `unit ${id} changes treated status; treated must be a unit-level indicator`);
        treatedByUnit.set(id, treated[index]);
      });
      const postByTime = new Map();
      time.forEach((value, index) => {
        if (postByTime.has(value) && postByTime.get(value) !== post[index]) H.fail("STAT_INVALID_INPUT", `time ${value} mixes pre and post rows; post must be a period-level indicator`);
        postByTime.set(value, post[index]);
      });
      if (treatedByUnit.size > 300) H.fail("STAT_LIMIT_EXCEEDED", "twfe design supports at most 300 units");
      if (postByTime.size > 60) H.fail("STAT_LIMIT_EXCEEDED", "twfe design supports at most 60 periods");
    }
    const covariates = optionalPredictors(data.covariates, n, H);
    return { y, treated, post, unit, time, covariates, cells, outcomeLabel: H.label(data.outcomeLabel, "Outcome", "data.outcomeLabel") };
  },
  analyze(parsed, options, budget, H) {
    const { y, treated, post, unit, time, covariates } = parsed;
    const n = y.length;
    const level = options.confidenceLevel;
    const clusters = options.cluster === "unit" ? K.clusterIds(unit) : null;
    const covariance = options.covariance;
    // Group means (2x2 cells).
    const cellRows = [];
    for (const t of [0, 1]) for (const p of [0, 1]) {
      const values = y.filter((_, index) => treated[index] === t && post[index] === p);
      cellRows.push({ group: t ? "Treated" : "Control", period: p ? "Post" : "Pre", n: values.length, mean: K.mean(values), sd: values.length > 1 ? Math.sqrt(K.sampleVariance(values)) : null });
    }
    const meanOf = (t, p) => cellRows.find((row) => row.group === (t ? "Treated" : "Control") && row.period === (p ? "Post" : "Pre")).mean;
    const rawDid = (meanOf(1, 1) - meanOf(1, 0)) - (meanOf(0, 1) - meanOf(0, 0));
    // Static model.
    let x;
    let names;
    let didIndex;
    if (options.design === "two-by-two") {
      x = y.map((_, index) => [1, treated[index], post[index], treated[index] * post[index]]);
      names = ["Intercept", "treated", "post", "treated x post"];
      didIndex = 3;
    } else {
      const units = K.sortedLevels(unit);
      const times = [...new Set(time)].sort((a, b) => a - b);
      x = y.map((_, index) => [1, ...units.slice(1).map((id) => (unit[index] === id ? 1 : 0)), ...times.slice(1).map((value) => (time[index] === value ? 1 : 0)), treated[index] * post[index]]);
      names = ["Intercept", ...units.slice(1).map((id) => `unit[${id}]`), ...times.slice(1).map((value) => `time[${value}]`), "treated x post"];
      didIndex = x[0].length - 1;
    }
    const withCovariates = appendCovariates(x, names, covariates, n, H);
    x = withCovariates.x;
    names = withCovariates.terms;
    if (n <= x[0].length) H.fail("STAT_INSUFFICIENT_SAMPLE", `at least ${x[0].length + 1} observations are required for ${x[0].length} parameters`);
    assertRank(x, H, "difference-in-differences design is rank deficient (check unit/time coding and covariates)");
    const fit = K.olsFit(y, x, H, budget, { covariance, clusters });
    const rows = coefficientTable(fit, names, level, H);
    const didRow = rows[didIndex];
    const reportedRows = rows.filter((row, index) => index === didIndex || !/^(unit|time)\[/u.test(row.term));
    // Event study (twfe with >= 3 periods).
    let eventRows = [];
    let preTrend = { status: "not_established", reason: options.design === "twfe" ? "fewer than two pre-treatment periods" : "two-by-two design has a single pre period; parallel trends cannot be tested from the data" };
    if (options.design === "twfe") {
      const units = K.sortedLevels(unit);
      const times = [...new Set(time)].sort((a, b) => a - b);
      const preTimes = times.filter((value) => post[time.indexOf(value)] === 0);
      const base = preTimes[preTimes.length - 1];
      const eventTimes = times.filter((value) => value !== base);
      if (times.length >= 3) {
        let ex = y.map((_, index) => [1, ...units.slice(1).map((id) => (unit[index] === id ? 1 : 0)), ...times.slice(1).map((value) => (time[index] === value ? 1 : 0)), ...eventTimes.map((value) => (treated[index] === 1 && time[index] === value ? 1 : 0))]);
        let eventNames = ["Intercept", ...units.slice(1).map((id) => `unit[${id}]`), ...times.slice(1).map((value) => `time[${value}]`), ...eventTimes.map((value) => `treated x time[${value}]`)];
        const appended = appendCovariates(ex, eventNames, covariates, n, H);
        ex = appended.x;
        eventNames = appended.terms;
        if (n > ex[0].length && H.matrixRank(ex) === ex[0].length) {
          const eventFit = K.olsFit(y, ex, H, budget, { covariance, clusters });
          const eventCoefficients = coefficientTable(eventFit, eventNames, level, H);
          const offset = 1 + (units.length - 1) + (times.length - 1);
          eventRows = eventTimes.map((value, index) => ({ time: value, relativeToBase: value - base, period: post[time.indexOf(value)] ? "post" : "pre", ...eventCoefficients[offset + index] }));
          eventRows.push({ time: base, relativeToBase: 0, period: "pre", term: `treated x time[${base}] (base)`, estimate: 0, standardError: 0, statistic: null, df: null, pValue: null, lower: 0, upper: 0 });
          eventRows.sort((a, b) => a.time - b.time);
          const leadIndices = eventTimes.map((value, index) => ({ value, index })).filter((item) => post[time.indexOf(item.value)] === 0).map((item) => offset + item.index);
          if (leadIndices.length >= 1) {
            const wald = K.waldChiSquare(eventFit.beta, eventFit.covariance, leadIndices, H);
            preTrend = { status: wald.pValue < 0.05 ? "pre_trend_detected" : "no_pre_trend_detected", statistic: wald.statistic, df: wald.df, pValue: wald.pValue, leads: leadIndices.length, detail: "joint Wald test that all pre-treatment treated x period leads are zero (base = last pre period)" };
          }
        } else {
          preTrend = { status: "not_established", reason: "event-study design is rank deficient or underdetermined" };
        }
      }
    }
    const seLabel = clusters ? `cluster-robust (CR1, ${fit.clusterInfo.clusters} clusters)` : covariance === "classical" ? "classical" : covariance.toUpperCase();
    // Cell means carry their own sampling error, and the trajectory plot is where a reader decides
    // whether the jump is bigger than the noise. Without the interval the figure asserts four exact
    // points, which is a stronger claim than the analysis makes.
    const trajectoryRows = cellRows.map((row) => {
      const half = row.sd !== null && row.n > 1 ? H.tCritical(level, row.n - 1) * row.sd / Math.sqrt(row.n) : null;
      return {
        ...row,
        counterfactual: row.group === "Treated" && row.period === "Post" ? meanOf(1, 0) + (meanOf(0, 1) - meanOf(0, 0)) : row.mean,
        standardErrorOfMean: half === null ? null : row.sd / Math.sqrt(row.n),
        lower: half === null ? null : row.mean - half,
        upper: half === null ? null : row.mean + half,
      };
    });
    const artifacts = [
      H.tableArtifact("Difference-in-differences estimate", `${options.design === "twfe" ? "Two-way fixed effects" : "2x2 interaction"} model for ${parsed.outcomeLabel}; ${seLabel} standard errors, ${percent(level)} intervals.`, K.coefficientColumns(fit.dfReference === null ? "z" : "t"), reportedRows, options.design === "twfe" ? ["Unit and period fixed-effect coefficients are omitted from this table but included in the fit."] : [], "did-coefficients-table"),
      H.tableArtifact("Group-by-period means", "Cell means with the parallel-trends counterfactual for the treated post-period cell.", [STRING_COLUMN("group", "Group"), STRING_COLUMN("period", "Period"), NUMBER_COLUMN("n", "n"), NUMBER_COLUMN("mean", "Mean"), NUMBER_COLUMN("sd", "SD"), NUMBER_COLUMN("standardErrorOfMean", "SE of mean"), NUMBER_COLUMN("lower", "CI lower"), NUMBER_COLUMN("upper", "CI upper"), NUMBER_COLUMN("counterfactual", "Counterfactual mean")], trajectoryRows, [`Raw 2x2 difference-in-differences from means: ${rawDid.toPrecision(6)}.`], "did-cell-means-table"),
      H.vegaArtifact("did-trajectory-plot", `${parsed.outcomeLabel}: observed group means and parallel-trends counterfactual`, {
        data: { values: trajectoryRows },
        layer: [
          { mark: { type: "rule", strokeWidth: 1.4, opacity: 0.75 }, encoding: { x: { field: "period", type: "ordinal", sort: ["Pre", "Post"], title: "Period" }, y: { field: "lower", type: "quantitative", scale: { zero: false }, title: parsed.outcomeLabel }, y2: { field: "upper" }, color: { field: "group", type: "nominal", title: "Group" }, tooltip: [{ field: "group" }, { field: "period" }, { field: "lower", format: ".4g" }, { field: "upper", format: ".4g" }] } },
          { mark: { type: "line", point: true, strokeWidth: 2 }, encoding: { x: { field: "period", type: "ordinal", sort: ["Pre", "Post"], title: "Period" }, y: { field: "mean", type: "quantitative", scale: { zero: false }, title: parsed.outcomeLabel }, color: { field: "group", type: "nominal", title: "Group" }, tooltip: [{ field: "group" }, { field: "period" }, { field: "mean", format: ".4g" }, { field: "n" }] } },
          { mark: { type: "line", strokeDash: [6, 4], color: "#888" }, encoding: { x: { field: "period", type: "ordinal", sort: ["Pre", "Post"] }, y: { field: "counterfactual", type: "quantitative", scale: { zero: false } }, detail: { field: "group" } } },
        ],
      }),
    ];
    if (eventRows.length) {
      artifacts.push(H.tableArtifact("Event-study coefficients", `Treated x period interactions relative to the last pre-treatment period (${eventRows.find((row) => row.relativeToBase === 0).time}); ${seLabel} standard errors.`, [NUMBER_COLUMN("time", "Period"), NUMBER_COLUMN("relativeToBase", "Relative period"), STRING_COLUMN("period", "Phase"), ...K.coefficientColumns(fit.dfReference === null ? "z" : "t")], eventRows, ["Pre-period leads near zero support parallel trends; the base period is fixed at zero by construction."], "did-event-study-table"));
      artifacts.push(H.vegaArtifact("did-event-study-plot", `Event-study coefficients with ${percent(level)} intervals`, {
        data: { values: eventRows },
        layer: [
          { mark: { type: "rule", strokeWidth: 2 }, encoding: { x: { field: "relativeToBase", type: "quantitative", title: "Periods relative to treatment base" }, y: { field: "lower", type: "quantitative", title: "Treated x period effect" }, y2: { field: "upper" }, color: { field: "period", type: "nominal", title: "Phase" } } },
          { mark: { type: "point", filled: true, size: 80 }, encoding: { x: { field: "relativeToBase", type: "quantitative" }, y: { field: "estimate", type: "quantitative" }, color: { field: "period", type: "nominal" }, tooltip: [{ field: "time" }, { field: "estimate", format: ".4g" }, { field: "lower", format: ".4g" }, { field: "upper", format: ".4g" }] } },
          { mark: { type: "rule", strokeDash: [4, 4], color: "#777" }, encoding: { y: { datum: 0 } } },
          { mark: { type: "rule", strokeDash: [2, 2], color: "#bbb" }, encoding: { x: { datum: 0 } } },
        ],
      }));
    }
    return {
      sample: { n, cells: { controlPre: parsed.cells[0], controlPost: parsed.cells[1], treatedPre: parsed.cells[2], treatedPost: parsed.cells[3] }, design: options.design, units: unit ? new Set(unit).size : null, periods: time ? new Set(time).size : 2, clusters: clusters ? fit.clusterInfo.clusters : null },
      estimates: [
        { term: "difference-in-differences (ATT under parallel trends)", estimate: didRow.estimate, standardError: didRow.standardError, statistic: didRow.statistic, df: didRow.df, pValue: didRow.pValue, lower: didRow.lower, upper: didRow.upper, kind: "effect" },
        { term: "raw 2x2 difference of mean changes", estimate: rawDid, kind: "descriptive" },
        ...reportedRows.filter((row) => row !== didRow).map((row) => ({ ...row, kind: "coefficient" })),
        ...eventRows.map((row) => ({ term: row.term, estimate: row.estimate, standardError: row.standardError, lower: row.lower, upper: row.upper, time: row.time, kind: "event-study" })),
      ],
      tests: [
        { name: "treated x post = 0", statistic: didRow.statistic, df: didRow.df, pValue: didRow.pValue, distribution: fit.dfReference === null ? "normal" : "t", covariance: seLabel },
        ...(preTrend.statistic !== undefined ? [{ name: "pre-trend joint Wald test (leads = 0)", statistic: preTrend.statistic, df: preTrend.df, pValue: preTrend.pValue, distribution: "chi-square" }] : []),
      ],
      confidenceIntervals: [{ parameter: "difference-in-differences", level, lower: didRow.lower, upper: didRow.upper, method: `${fit.dfReference === null ? "normal" : "t"} with ${seLabel} standard error` }],
      effectSizes: [
        { name: "difference-in-differences", estimate: didRow.estimate, lower: didRow.lower, upper: didRow.upper },
        { name: "effect relative to treated pre-period mean", estimate: meanOf(1, 0) !== 0 ? didRow.estimate / Math.abs(meanOf(1, 0)) : null },
      ],
      assumptions: [
        { name: "parallel trends", status: preTrend.status, ...(preTrend.reason ? { detail: preTrend.reason } : { statistic: preTrend.statistic, df: preTrend.df, pValue: preTrend.pValue }) },
        { name: "no anticipation", status: "requires_design_review" },
        { name: "stable composition of treated and control groups", status: unit ? "verified_by_unit_level_treatment_indicator" : "requires_design_review" },
        { name: "no spillover between groups", status: "requires_design_review" },
        { name: "serial correlation within units", status: clusters ? "handled_by_cluster_robust_covariance" : (unit ? "not_handled_consider_options_cluster_unit" : "not_established") },
      ],
      diagnostics: [
        { name: "covariance", status: seLabel, ...(clusters ? { clusters: fit.clusterInfo.clusters, smallSampleFactor: fit.clusterInfo.factor, fewClusters: fit.clusterInfo.clusters < 30 } : {}) },
        { name: "pre-trend diagnostic", ...preTrend },
        { name: "staggered adoption", status: "not_supported", detail: "a single treatment timing is assumed; staggered designs need heterogeneity-robust estimators" },
        { name: "model fit", rSquared: fit.rSquared, residualDf: fit.df },
      ],
      artifacts,
    };
  },
  linkage: {
    neededWhen: "A policy or intervention reaches one group but not another, outcomes are observed before and after, and randomization was not possible.",
    decision: "Whether the treated group's change in outcome exceeded the control group's change, and whether the parallel-trends assumption behind that interpretation is credible.",
    mustShow: "Cell means and counts, the difference-in-differences estimate with the covariance choice stated, event-study leads and lags when several periods exist, the pre-trend test, and the counterfactual trajectory.",
    userGoal: "Estimate a policy effect from observational panel or repeated cross-section data with explicit assumptions.",
    nextActions: [
      { trigger: "pre-trend-detected", action: "revise-comparison-group-or-add-group-specific-trends", reason: "Diverging pre-treatment trends contradict the identifying assumption and bias the effect estimate." },
      { trigger: "few-clusters-or-serial-correlation", action: "use-cluster-robust-or-wild-bootstrap-inference", reason: "Serially correlated panel errors make naive standard errors far too small." },
      { trigger: "staggered-treatment-timing", action: "switch-to-heterogeneity-robust-event-study-estimator", reason: "Two-way fixed effects with staggered adoption can weight some comparisons negatively." },
      { trigger: "credible-estimate", action: "bind-trajectory-plot-event-study-and-estimate-table", reason: "Readers need the trends, the leads, and the effect together to judge the causal claim." },
    ],
  },
  fixture: {
    data: {
      y: [10.1, 10.8, 11.2, 14.9, 9.6, 10.2, 10.9, 14.1, 10.4, 11.0, 11.6, 15.3, 9.9, 10.5, 11.1, 14.6, 10.0, 10.7, 11.4, 11.9, 9.5, 10.1, 10.8, 11.3, 10.3, 10.9, 11.5, 12.0, 9.8, 10.4, 11.0, 11.6],
      treated: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      post: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      unit: ["T1", "T1", "T1", "T1", "T2", "T2", "T2", "T2", "T3", "T3", "T3", "T3", "T4", "T4", "T4", "T4", "C1", "C1", "C1", "C1", "C2", "C2", "C2", "C2", "C3", "C3", "C3", "C3", "C4", "C4", "C4", "C4"],
      time: [1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4],
      outcomeLabel: "Sales",
    },
    options: { design: "twfe", cluster: "unit", confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "Two-by-two and two-way fixed-effects difference-in-differences by least squares with classical, HC0-HC3, or CR1 cluster-robust covariance, optional covariates, an event-study specification relative to the last pre-period, and a joint Wald pre-trend test.",
    oracle: {
      level: "external-library-partial",
      evidence: ["contracts/causal-inference-scipy-crosscheck.py"],
      verifiedOutputs: ["difference-in-differences coefficient (statsmodels OLS)", "classical, HC, and cluster-robust standard errors", "event-study coefficients", "pre-trend Wald statistic", "cell means"],
      excludedOutputs: ["counterfactual trajectory", "relative effect size"],
    },
    diagnostic: { level: "method-specific-partial", emitted: ["pre-trend diagnostic", "covariance", "staggered adoption boundary", "model fit"], limitations: ["no staggered-adoption estimators", "no wild-cluster bootstrap", "no synthetic control"] },
    knownGaps: ["staggered treatment timing is not supported", "no wild-cluster bootstrap for few clusters", "no group-specific linear trends"],
  },
};

/* ------------------------------------------------------------------------------------------ */
/* Propensity-score analysis                                                                   */
/* ------------------------------------------------------------------------------------------ */

function standardizedMeanDifference(treatedValues, controlValues) {
  const meanT = K.mean(treatedValues);
  const meanC = K.mean(controlValues);
  const varT = K.sampleVariance(treatedValues);
  const varC = K.sampleVariance(controlValues);
  const pooled = Math.sqrt((varT + varC) / 2);
  return { meanT, meanC, varT, varC, pooled, smd: pooled > 0 ? (meanT - meanC) / pooled : 0 };
}

function greedyMatching(logit, treatment, caliperWidth) {
  const treatedOrder = treatment.map((value, index) => ({ value, index })).filter((item) => item.value === 1).map((item) => item.index)
    .sort((a, b) => (logit[b] - logit[a]) || (a - b));
  const available = new Set(treatment.map((value, index) => ({ value, index })).filter((item) => item.value === 0).map((item) => item.index));
  const pairs = [];
  const unmatched = [];
  for (const treatedIndex of treatedOrder) {
    let best = null;
    let bestDistance = Infinity;
    for (const controlIndex of available) {
      const distance = Math.abs(logit[treatedIndex] - logit[controlIndex]);
      if (distance < bestDistance || (distance === bestDistance && controlIndex < best)) { best = controlIndex; bestDistance = distance; }
    }
    if (best !== null && (caliperWidth === null || bestDistance <= caliperWidth)) {
      pairs.push({ treated: treatedIndex, control: best, distance: bestDistance });
      available.delete(best);
    } else unmatched.push(treatedIndex);
  }
  return { pairs, unmatched };
}

const propensityScoreAnalysis = {
  method: "propensity_score_analysis",
  family: "causal-inference",
  analysisModel: { families: ["lm", "glm"], distributions: [null, "normal", "gaussian", "binomial"], links: [null, "identity", "logit"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    estimand: { schema: { type: "string", enum: ["ate", "att"] }, default: "ate", parse(value, H, path) { if (!["ate", "att"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be ate or att`); return value; } },
    caliper: { schema: { type: "number", minimum: 0, maximum: 5 }, default: 0.2, parse(value, H, path) { const number = H.finiteNumber(value, path); if (number < 0 || number > 5) H.fail("STAT_INVALID_INPUT", `${path} must be between 0 (no caliper) and 5 standard deviations of the logit`); return number; } },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["treatment", "outcome", "covariates"],
    properties: { treatment: BINARY_SCHEMA(12), outcome: NUMERIC_SCHEMA(12), covariates: PREDICTORS_SCHEMA(1), outcomeLabel: LABEL_SCHEMA },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["treatment", "outcome", "covariates", "outcomeLabel"], "data");
    const outcome = H.numericVector(data.outcome, "data.outcome", 12);
    const n = outcome.length;
    limitRows(n, H, "propensity_score_analysis");
    const treatment = binaryVector(data.treatment, "data.treatment", n, H);
    const covariates = H.regressionPredictors(data.covariates, n);
    const treatedCount = treatment.filter((value) => value === 1).length;
    if (treatedCount < 4 || n - treatedCount < 4) H.fail("STAT_INSUFFICIENT_SAMPLE", "at least four treated and four control units are required");
    return { treatment, outcome, covariates, outcomeLabel: H.label(data.outcomeLabel, "Outcome", "data.outcomeLabel") };
  },
  analyze(parsed, options, budget, H) {
    const { treatment, outcome, covariates } = parsed;
    const n = outcome.length;
    const level = options.confidenceLevel;
    const design = H.designMatrix({ y: outcome, predictors: covariates }, true);
    assertRank(design.x, H, "propensity-score design is rank deficient");
    const ps = K.logisticFit(treatment, design.x, H, budget, { maxIterations: 100, tolerance: 1e-10 });
    const scores = ps.probabilities;
    const logit = scores.map((value) => Math.log(value / (1 - value)));
    const treatedShare = K.mean(treatment);
    // Weights.
    const weights = treatment.map((value, index) => {
      if (options.estimand === "ate") return value === 1 ? treatedShare / scores[index] : (1 - treatedShare) / (1 - scores[index]);
      return value === 1 ? 1 : scores[index] / (1 - scores[index]);
    });
    if (weights.some((value) => !Number.isFinite(value))) H.fail("STAT_DEGENERATE", "propensity scores at 0 or 1 produce infinite weights (positivity violation)");
    const xt = treatment.map((value) => [1, value]);
    const weightedFit = K.olsFit(outcome, xt, H, budget, { covariance: "hc0", weights });
    const naiveFit = K.olsFit(outcome, xt, H, budget, { covariance: "hc0" });
    const z = H.normalInv(1 - (1 - level) / 2);
    const ipwRow = { estimator: `IPW (${options.estimand.toUpperCase()}, ${options.estimand === "ate" ? "stabilized" : "odds"} weights)`, estimate: weightedFit.beta[1], standardError: Math.sqrt(weightedFit.covariance[1][1]) };
    ipwRow.lower = ipwRow.estimate - z * ipwRow.standardError;
    ipwRow.upper = ipwRow.estimate + z * ipwRow.standardError;
    ipwRow.pValue = H.pFromNormal(ipwRow.estimate / ipwRow.standardError, "two-sided");
    const naiveRow = { estimator: "Unadjusted difference in means", estimate: naiveFit.beta[1], standardError: Math.sqrt(naiveFit.covariance[1][1]) };
    naiveRow.lower = naiveRow.estimate - z * naiveRow.standardError;
    naiveRow.upper = naiveRow.estimate + z * naiveRow.standardError;
    naiveRow.pValue = H.pFromNormal(naiveRow.estimate / naiveRow.standardError, "two-sided");
    // Matching.
    const logitSd = Math.sqrt(K.sampleVariance(logit));
    const caliperWidth = options.caliper > 0 ? options.caliper * logitSd : null;
    const matching = greedyMatching(logit, treatment, caliperWidth);
    let matchedRow = null;
    if (matching.pairs.length >= 2) {
      const differences = matching.pairs.map((pair) => outcome[pair.treated] - outcome[pair.control]);
      const meanDifference = K.mean(differences);
      const se = Math.sqrt(K.sampleVariance(differences) / differences.length);
      const df = differences.length - 1;
      const t = H.tCritical(level, df);
      matchedRow = { estimator: `1:1 nearest-neighbour matching (${matching.pairs.length} pairs${caliperWidth === null ? "" : `, caliper ${options.caliper} SD`})`, estimate: meanDifference, standardError: se, lower: meanDifference - t * se, upper: meanDifference + t * se, pValue: se > 0 ? H.pFromT(meanDifference / se, df, "two-sided") : null };
    }
    const effectRows = [naiveRow, ipwRow, ...(matchedRow ? [matchedRow] : [])];
    // Balance.
    const covariateColumns = design.terms.slice(1);
    const treatedIndices = treatment.map((value, index) => (value === 1 ? index : -1)).filter((index) => index >= 0);
    const controlIndices = treatment.map((value, index) => (value === 0 ? index : -1)).filter((index) => index >= 0);
    const balanceRows = [];
    const loveRows = [];
    covariateColumns.forEach((term, columnIndex) => {
      const column = columnIndex + 1;
      const values = design.x.map((row) => row[column]);
      const unadjusted = standardizedMeanDifference(treatedIndices.map((index) => values[index]), controlIndices.map((index) => values[index]));
      const wT = K.weightedMoments(treatedIndices.map((index) => values[index]), treatedIndices.map((index) => weights[index]));
      const wC = K.weightedMoments(controlIndices.map((index) => values[index]), controlIndices.map((index) => weights[index]));
      const smdIpw = unadjusted.pooled > 0 ? (wT.mean - wC.mean) / unadjusted.pooled : 0;
      let smdMatched = null;
      let matchedVarianceRatio = null;
      if (matching.pairs.length >= 2) {
        const mt = matching.pairs.map((pair) => values[pair.treated]);
        const mc = matching.pairs.map((pair) => values[pair.control]);
        smdMatched = unadjusted.pooled > 0 ? (K.mean(mt) - K.mean(mc)) / unadjusted.pooled : 0;
        const vc = K.sampleVariance(mc);
        matchedVarianceRatio = vc > 0 ? K.sampleVariance(mt) / vc : null;
      }
      balanceRows.push({ covariate: term.name, meanTreated: unadjusted.meanT, meanControl: unadjusted.meanC, smdUnadjusted: unadjusted.smd, varianceRatioUnadjusted: unadjusted.varC > 0 ? unadjusted.varT / unadjusted.varC : null, weightedMeanTreated: wT.mean, weightedMeanControl: wC.mean, smdIpw, varianceRatioIpw: wC.variance > 0 ? wT.variance / wC.variance : null, smdMatched, varianceRatioMatched: matchedVarianceRatio });
      loveRows.push({ covariate: term.name, sample: "Unadjusted", smd: unadjusted.smd, absoluteSmd: Math.abs(unadjusted.smd) });
      loveRows.push({ covariate: term.name, sample: "IPW", smd: smdIpw, absoluteSmd: Math.abs(smdIpw) });
      if (smdMatched !== null) loveRows.push({ covariate: term.name, sample: "Matched", smd: smdMatched, absoluteSmd: Math.abs(smdMatched) });
    });
    // Overlap and weight diagnostics.
    const treatedScores = treatedIndices.map((index) => scores[index]);
    const controlScores = controlIndices.map((index) => scores[index]);
    const supportLow = Math.max(Math.min(...treatedScores), Math.min(...controlScores));
    const supportHigh = Math.min(Math.max(...treatedScores), Math.max(...controlScores));
    const outsideSupport = scores.filter((value) => value < supportLow || value > supportHigh).length;
    const essTreated = K.weightedMoments(treatedIndices.map((index) => outcome[index]), treatedIndices.map((index) => weights[index])).effectiveSampleSize;
    const essControl = K.weightedMoments(controlIndices.map((index) => outcome[index]), controlIndices.map((index) => weights[index])).effectiveSampleSize;
    const psRows = K.coefficientRows(design.terms.map((term) => term.name), ps.beta, ps.covariance, null, level, H, { expKey: "oddsRatio" });
    const maxAbsSmdIpw = Math.max(...balanceRows.map((row) => Math.abs(row.smdIpw)));
    const maxAbsSmdUnadjusted = Math.max(...balanceRows.map((row) => Math.abs(row.smdUnadjusted)));
    const maxAbsSmdMatched = matchedRow ? Math.max(...balanceRows.map((row) => Math.abs(row.smdMatched))) : null;
    const scoreRows = scores.map((value, index) => ({ unit: index + 1, group: treatment[index] ? "Treated" : "Control", propensityScore: value, logit: logit[index], weight: weights[index], matched: matching.pairs.some((pair) => pair.treated === index || pair.control === index) }));
    return {
      sample: { n, treated: treatedIndices.length, control: controlIndices.length, covariateColumns: covariateColumns.length, matchedPairs: matching.pairs.length, unmatchedTreated: matching.unmatched.length, estimand: options.estimand },
      estimates: [
        ...effectRows.map((row) => ({ ...row, kind: "effect" })),
        ...psRows.map((row) => ({ ...row, kind: "propensity-model" })),
        { estimator: "propensity model AUC", estimate: H.auc(scores, treatment), kind: "propensity-model-fit" },
      ],
      tests: effectRows.map((row) => ({ name: `${row.estimator}: effect = 0`, statistic: row.standardError > 0 ? row.estimate / row.standardError : null, pValue: row.pValue, distribution: row === matchedRow ? "paired t" : "normal (HC0 sandwich, weights treated as known)" })),
      confidenceIntervals: effectRows.map((row) => ({ parameter: row.estimator, level, lower: row.lower, upper: row.upper, method: row === matchedRow ? "paired t over matched pairs" : "normal with HC0 sandwich" })),
      effectSizes: [
        { name: `IPW ${options.estimand.toUpperCase()}`, estimate: ipwRow.estimate, lower: ipwRow.lower, upper: ipwRow.upper },
        { name: "maximum absolute SMD after IPW", estimate: maxAbsSmdIpw },
        ...(maxAbsSmdMatched === null ? [] : [{ name: "maximum absolute SMD after matching", estimate: maxAbsSmdMatched }]),
      ],
      assumptions: [
        { name: "no unmeasured confounding (conditional exchangeability)", status: "requires_design_review" },
        { name: "positivity / overlap", status: outsideSupport > 0.1 * n ? "weak_overlap_many_units_outside_common_support" : "diagnostic_attached", unitsOutsideCommonSupport: outsideSupport, commonSupport: [supportLow, supportHigh] },
        { name: "propensity model correctly specified", status: maxAbsSmdIpw > 0.1 ? "covariate_imbalance_remains_after_weighting" : "balance_achieved_by_smd_rule", maximumAbsoluteSmd: maxAbsSmdIpw },
        { name: "stable unit treatment value (no interference)", status: "requires_design_review" },
      ],
      diagnostics: [
        { name: "propensity model", status: "logistic_maximum_likelihood", iterations: ps.iterations, auc: H.auc(scores, treatment), logLikelihood: ps.logLikelihood },
        { name: "weights", status: Math.max(...weights) > 10 ? "extreme_weights_present" : "acceptable", maximumWeight: Math.max(...weights), effectiveSampleSizeTreated: essTreated, effectiveSampleSizeControl: essControl },
        { name: "matching", status: matching.pairs.length >= 2 ? (matching.unmatched.length ? "treated_units_dropped_by_caliper" : "all_treated_matched") : "insufficient_pairs", pairs: matching.pairs.length, unmatchedTreated: matching.unmatched.length, caliperLogitWidth: caliperWidth, algorithm: "greedy nearest neighbour on the logit, treated ordered by descending score, without replacement" },
        { name: "balance", unadjustedMaxAbsoluteSmd: maxAbsSmdUnadjusted, ipwMaxAbsoluteSmd: maxAbsSmdIpw, matchedMaxAbsoluteSmd: maxAbsSmdMatched, rule: "absolute SMD below 0.1 is conventionally acceptable" },
        { name: "inference boundary", status: "weights_treated_as_fixed", detail: "HC0 sandwich ignores propensity-score estimation uncertainty; bootstrap the whole pipeline for a fully honest interval" },
      ],
      artifacts: [
        H.tableArtifact("Treatment effect estimates", `${parsed.outcomeLabel}: unadjusted, inverse-probability-weighted, and matched estimates with ${percent(level)} intervals.`, [STRING_COLUMN("estimator", "Estimator"), NUMBER_COLUMN("estimate", "Estimate"), NUMBER_COLUMN("standardError", "SE"), NUMBER_COLUMN("lower", "CI lower"), NUMBER_COLUMN("upper", "CI upper"), NUMBER_COLUMN("pValue", "p")], effectRows, ["The matched estimate targets the treated population regardless of the requested estimand."], "ps-effects-table"),
        H.tableArtifact("Covariate balance", "Standardized mean differences before adjustment, after IPW, and after matching; denominator is the unadjusted pooled SD (cobalt convention).", [STRING_COLUMN("covariate", "Covariate"), NUMBER_COLUMN("meanTreated", "Mean treated"), NUMBER_COLUMN("meanControl", "Mean control"), NUMBER_COLUMN("smdUnadjusted", "SMD unadjusted"), NUMBER_COLUMN("varianceRatioUnadjusted", "VR unadjusted"), NUMBER_COLUMN("weightedMeanTreated", "Weighted mean treated"), NUMBER_COLUMN("weightedMeanControl", "Weighted mean control"), NUMBER_COLUMN("smdIpw", "SMD IPW"), NUMBER_COLUMN("varianceRatioIpw", "VR IPW"), NUMBER_COLUMN("smdMatched", "SMD matched"), NUMBER_COLUMN("varianceRatioMatched", "VR matched")], balanceRows, [], "ps-balance-table"),
        H.tableArtifact("Love plot rows", "Absolute standardized mean differences per covariate and sample.", [STRING_COLUMN("covariate", "Covariate"), STRING_COLUMN("sample", "Sample"), NUMBER_COLUMN("smd", "SMD"), NUMBER_COLUMN("absoluteSmd", "|SMD|")], loveRows, [], "ps-love-table"),
        H.tableArtifact("Propensity model", `Logistic regression of treatment on covariates with ${percent(level)} Wald intervals.`, K.coefficientColumns("z", [NUMBER_COLUMN("oddsRatio", "Odds ratio"), NUMBER_COLUMN("oddsRatioLower", "OR lower"), NUMBER_COLUMN("oddsRatioUpper", "OR upper")]), psRows, [], "ps-model-table"),
        H.tableArtifact("Unit propensity scores and weights", "Estimated score, logit, analysis weight, and matching status for every unit.", [NUMBER_COLUMN("unit", "Unit"), STRING_COLUMN("group", "Group"), NUMBER_COLUMN("propensityScore", "Propensity score"), NUMBER_COLUMN("logit", "Logit"), NUMBER_COLUMN("weight", "Weight"), BOOLEAN_COLUMN("matched", "Matched")], scoreRows, [], "ps-scores-table"),
        H.vegaArtifact("ps-love-plot", "Covariate balance (Love plot): absolute standardized mean differences", {
          data: { values: loveRows },
          layer: [
            { mark: { type: "point", filled: true, size: 90 }, encoding: { y: { field: "covariate", type: "nominal", title: null }, x: { field: "absoluteSmd", type: "quantitative", title: "|Standardized mean difference|" }, color: { field: "sample", type: "nominal", title: "Sample" }, shape: { field: "sample", type: "nominal" }, tooltip: [{ field: "covariate" }, { field: "sample" }, { field: "smd", format: ".3f" }] } },
            { mark: { type: "rule", strokeDash: [4, 4], color: "#c0392b" }, encoding: { x: { datum: 0.1 } } },
          ],
        }),
        H.vegaArtifact("ps-overlap-plot", "Propensity-score overlap by treatment group", {
          data: { values: scoreRows },
          mark: { type: "tick", thickness: 2, opacity: 0.7 },
          encoding: { x: { field: "propensityScore", type: "quantitative", title: "Propensity score", scale: { domain: [0, 1] } }, y: { field: "group", type: "nominal", title: null }, color: { field: "group", type: "nominal", legend: null }, tooltip: [{ field: "unit" }, { field: "propensityScore", format: ".3f" }, { field: "weight", format: ".3f" }] },
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "Treatment was not randomized, measured covariates predict who received it, and the researcher wants an adjusted effect that makes the covariate balance explicit.",
    decision: "Whether weighting or matching achieves acceptable balance and overlap, and what the adjusted treatment effect is for the chosen estimand.",
    mustShow: "The propensity model, overlap of scores, the weight distribution and effective sample size, the balance table with a Love plot, the number of matched and dropped units, and the effect estimates with intervals.",
    userGoal: "Report an observational treatment effect whose adjustment is transparent and whose remaining imbalance is visible.",
    nextActions: [
      { trigger: "imbalance-remains-after-adjustment", action: "respecify-propensity-model-with-interactions-or-splines", reason: "Residual standardized differences above 0.1 mean the adjustment did not remove the measured confounding." },
      { trigger: "weak-overlap-or-extreme-weights", action: "trim-or-restrict-to-common-support-and-restate-estimand", reason: "Units without comparable counterparts make the effect an extrapolation and inflate variance." },
      { trigger: "many-treated-units-dropped-by-caliper", action: "report-att-for-the-matched-subpopulation-only", reason: "Dropping treated units changes the population the estimate describes." },
      { trigger: "balance-achieved", action: "bind-love-plot-overlap-plot-and-effect-table", reason: "Readers need the balance evidence next to the adjusted estimate." },
    ],
  },
  fixture: {
    data: {
      treatment: [1, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0],
      outcome: [14.2, 10.1, 15.8, 11.9, 13.1, 9.4, 12.2, 16.9, 10.8, 14.7, 11.2, 15.1, 9.9, 12.6, 13.9, 10.4, 16.2, 11.5, 14.4, 9.7, 12.9, 15.6, 10.6, 13.5, 11.1, 14.9, 9.2, 12.4, 15.3, 10.9],
      covariates: [
        { name: "age", values: [45, 42, 38, 51, 47, 29, 44, 55, 35, 36, 49, 52, 31, 41, 33, 46, 57, 39, 34, 28, 40, 53, 48, 30, 37, 50, 27, 43, 54, 32] },
        { name: "severity", values: [2.1, 2.4, 1.5, 2.8, 2.3, 0.9, 2.0, 3.1, 1.4, 1.3, 2.5, 2.9, 1.1, 2.2, 1.2, 1.9, 3.3, 1.7, 1.0, 0.8, 1.6, 3.0, 2.6, 1.5, 1.8, 2.7, 0.7, 2.1, 3.2, 1.2] },
      ],
      outcomeLabel: "Recovery score",
    },
    options: { estimand: "ate", caliper: 0.2, confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression", "matlab.stats.classification"] },
  coverage: {
    implementedBoundary: "Logistic propensity scores, stabilized ATE or ATT inverse-probability weighting with an HC0 sandwich treating weights as fixed, greedy 1:1 nearest-neighbour matching on the logit with a caliper, standardized-mean-difference balance tables, and overlap and weight diagnostics.",
    oracle: {
      level: "external-library-partial",
      evidence: ["contracts/causal-inference-scipy-crosscheck.py"],
      verifiedOutputs: ["propensity scores and model coefficients (statsmodels Logit)", "IPW estimate and HC0 standard error (statsmodels WLS)", "unadjusted difference and HC0 standard error", "matched pairs and matched estimate (first-principles re-implementation of the same greedy rule)", "standardized mean differences (numpy first-principles)"],
      excludedOutputs: ["effective sample size", "AUC", "common-support bounds"],
    },
    diagnostic: { level: "method-specific-partial", emitted: ["propensity model fit", "weights", "matching", "balance", "inference boundary"], limitations: ["propensity uncertainty is not propagated", "no doubly robust estimator", "no matching with replacement or optimal matching"] },
    knownGaps: ["doubly robust and TMLE estimators are not implemented", "matching is greedy without replacement only", "no bootstrap of the full pipeline"],
  },
};

/* ------------------------------------------------------------------------------------------ */
/* Instrumental variables: two-stage least squares                                             */
/* ------------------------------------------------------------------------------------------ */

function numericPredictors(raw, n, path, H, minimum) {
  if (!Array.isArray(raw) || raw.length < minimum) H.fail("STAT_INVALID_INPUT", `${path} must list at least ${minimum} numeric variable(s)`);
  const predictors = H.regressionPredictors(raw, n);
  for (const predictor of predictors) if (predictor.type !== "numeric") H.fail("STAT_INVALID_INPUT", `${path} must contain numeric variables only`);
  return predictors;
}

const instrumentalVariables2sls = {
  method: "instrumental_variables_2sls",
  family: "causal-inference",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "covariance", "timeoutMs"],
  customOptions: {},
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["y", "endogenous", "instruments"],
    properties: { y: NUMERIC_SCHEMA(10), endogenous: PREDICTORS_SCHEMA(1), instruments: PREDICTORS_SCHEMA(1), exogenous: PREDICTORS_SCHEMA(1), outcomeLabel: LABEL_SCHEMA },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["y", "endogenous", "instruments", "exogenous", "outcomeLabel"], "data");
    const y = H.numericVector(data.y, "data.y", 10);
    const n = y.length;
    limitRows(n, H, "instrumental_variables_2sls");
    const endogenous = numericPredictors(data.endogenous, n, "data.endogenous", H, 1);
    const instruments = numericPredictors(data.instruments, n, "data.instruments", H, 1);
    const exogenous = optionalPredictors(data.exogenous, n, H);
    const names = [...endogenous, ...instruments, ...exogenous].map((predictor) => predictor.name);
    if (new Set(names).size !== names.length) H.fail("STAT_INVALID_INPUT", "variable names must be unique across endogenous, instruments, and exogenous");
    if (instruments.length < endogenous.length) H.fail("STAT_INVALID_INPUT", "at least as many instruments as endogenous regressors are required (order condition)");
    return { y, endogenous, instruments, exogenous, outcomeLabel: H.label(data.outcomeLabel, "Outcome", "data.outcomeLabel") };
  },
  analyze(parsed, options, budget, H) {
    const { y, endogenous, instruments, exogenous } = parsed;
    const n = y.length;
    const level = options.confidenceLevel;
    const exogenousDesign = exogenous.length ? H.designMatrix({ y, predictors: exogenous }, false) : { x: y.map(() => []), terms: [] };
    const exogenousNames = exogenousDesign.terms.map((term) => term.name);
    const endogenousMatrix = y.map((_, index) => endogenous.map((predictor) => predictor.values[index]));
    const instrumentMatrix = y.map((_, index) => instruments.map((predictor) => predictor.values[index]));
    const X = y.map((_, index) => [1, ...exogenousDesign.x[index], ...endogenousMatrix[index]]);
    const Z = y.map((_, index) => [1, ...exogenousDesign.x[index], ...instrumentMatrix[index]]);
    const xNames = ["Intercept", ...exogenousNames, ...endogenous.map((predictor) => predictor.name)];
    const k = X[0].length;
    const l = Z[0].length;
    if (n <= l + 1) H.fail("STAT_INSUFFICIENT_SAMPLE", `at least ${l + 2} observations are required for ${l} instrument columns`);
    assertRank(Z, H, "instrument matrix is rank deficient");
    assertRank(X, H, "regressor matrix is rank deficient");
    // First stage: each endogenous regressor on Z.
    const firstStageRows = [];
    const firstStageResiduals = [];
    const xHat = X.map((row) => [...row]);
    const baseZ = y.map((_, index) => [1, ...exogenousDesign.x[index]]);
    endogenous.forEach((predictor, endoIndex) => {
      const full = K.olsFit(predictor.values, Z, H, budget);
      const restricted = K.olsFit(predictor.values, baseZ, H, budget);
      const df1 = instruments.length;
      const df2 = n - l;
      const f = ((restricted.rss - full.rss) / df1) / (full.rss / df2);
      const partialR2 = restricted.rss > 0 ? (restricted.rss - full.rss) / restricted.rss : 0;
      firstStageRows.push({ endogenous: predictor.name, excludedInstruments: instruments.map((item) => item.name).join(" + "), fStatistic: f, df1, df2, pValue: H.pFromF(Math.max(0, f), df1, df2), partialRSquared: partialR2, rSquared: full.rSquared, weak: f < 10 });
      firstStageResiduals.push(full.residuals);
      const column = 1 + exogenousNames.length + endoIndex;
      for (let index = 0; index < n; index += 1) xHat[index][column] = full.fitted[index];
    });
    // Second stage.
    const bread = K.invertSymmetric(K.crossProduct(xHat, null, budget), H, "STAT_SINGULAR_FIT", "fitted regressor matrix is singular (instruments do not identify the endogenous regressors)");
    const beta = K.matVec(bread, K.crossVector(xHat, null, y));
    const residuals = y.map((value, index) => value - K.dot(X[index], beta));
    const rss = residuals.reduce((total, value) => total + value * value, 0);
    const sigma2 = rss / (n - k);
    let covariance;
    let dfReference;
    if (options.covariance === "classical") {
      covariance = bread.map((row) => row.map((value) => value * sigma2));
      dfReference = n - k;
    } else {
      const leverage = (options.covariance === "hc2" || options.covariance === "hc3") ? K.leverageFromBread(xHat, bread) : null;
      covariance = K.hcCovariance(xHat, bread, residuals, options.covariance, H, budget, leverage, k);
      dfReference = null;
    }
    const rows = K.coefficientRows(xNames, beta, covariance, dfReference, level, H);
    const ols = K.olsFit(y, X, H, budget, { covariance: options.covariance });
    const olsRows = K.coefficientRows(xNames, ols.beta, ols.covariance, ols.dfReference, level, H);
    const comparisonRows = [
      ...rows.map((row) => ({ estimator: "2SLS", term: row.term, estimate: row.estimate, standardError: row.standardError, lower: row.lower, upper: row.upper })),
      ...olsRows.map((row) => ({ estimator: "OLS", term: row.term, estimate: row.estimate, standardError: row.standardError, lower: row.lower, upper: row.upper })),
    ];
    // Wu-Hausman: augmented regression with first-stage residuals.
    const augmented = X.map((row, index) => [...row, ...firstStageResiduals.map((column) => column[index])]);
    const augmentedFit = K.olsFit(y, augmented, H, budget);
    const df1 = endogenous.length;
    const df2 = n - k - df1;
    const wuHausmanF = ((ols.rss - augmentedFit.rss) / df1) / (augmentedFit.rss / df2);
    const wuHausman = { statistic: wuHausmanF, df1, df2, pValue: H.pFromF(Math.max(0, wuHausmanF), df1, df2) };
    // Sargan overidentification.
    const overId = instruments.length - endogenous.length;
    let sargan = null;
    if (overId > 0) {
      const auxiliary = K.olsFit(residuals, Z, H, budget);
      const statistic = n * auxiliary.rSquared;
      sargan = { statistic, df: overId, pValue: H.pFromChiSquare(statistic, overId) };
    }
    const yMean = K.mean(y);
    const tss = y.reduce((total, value) => total + (value - yMean) ** 2, 0);
    const seLabel = options.covariance === "classical" ? "classical" : options.covariance.toUpperCase();
    const weakAny = firstStageRows.some((row) => row.weak);
    return {
      sample: { n, endogenous: endogenous.length, instruments: instruments.length, exogenousColumns: exogenousNames.length, overidentifyingRestrictions: overId },
      estimates: [
        ...rows.map((row) => ({ ...row, kind: "2sls-coefficient" })),
        ...olsRows.map((row) => ({ ...row, kind: "ols-coefficient" })),
        { term: "residual standard error (2SLS)", estimate: Math.sqrt(sigma2), kind: "fit" },
        { term: "R-squared (2SLS, structural residuals)", estimate: tss > 0 ? 1 - rss / tss : 0, kind: "fit" },
      ],
      tests: [
        ...firstStageRows.map((row) => ({ name: `first-stage F for ${row.endogenous} (excluded instruments)`, statistic: row.fStatistic, df1: row.df1, df2: row.df2, pValue: row.pValue, distribution: "F" })),
        { name: "Wu-Hausman endogeneity test", statistic: wuHausman.statistic, df1: wuHausman.df1, df2: wuHausman.df2, pValue: wuHausman.pValue, distribution: "F (control-function augmented regression)" },
        ...(sargan ? [{ name: "Sargan overidentification test", statistic: sargan.statistic, df: sargan.df, pValue: sargan.pValue, distribution: "chi-square" }] : []),
      ],
      confidenceIntervals: rows.map((row) => ({ parameter: `2SLS ${row.term}`, level, lower: row.lower, upper: row.upper, method: `${dfReference === null ? "normal" : "t"} with ${seLabel} standard error` })),
      effectSizes: endogenous.map((predictor) => { const row = rows.find((item) => item.term === predictor.name); return { name: `2SLS effect of ${predictor.name}`, estimate: row.estimate, lower: row.lower, upper: row.upper }; }),
      assumptions: [
        { name: "instrument relevance", status: weakAny ? "weak_instrument_first_stage_f_below_10" : "first_stage_f_at_least_10", minimumFirstStageF: Math.min(...firstStageRows.map((row) => row.fStatistic)) },
        { name: "instrument exogeneity (exclusion restriction)", status: sargan ? (sargan.pValue < 0.05 ? "sargan_rejects_joint_validity" : "sargan_not_rejected") : "exactly_identified_not_testable", detail: "the exclusion restriction itself is untestable; Sargan checks only the overidentifying restrictions" },
        { name: "endogeneity of the instrumented regressors", status: wuHausman.pValue < 0.05 ? "wu_hausman_rejects_exogeneity_iv_preferred" : "wu_hausman_not_rejected_ols_consistent" },
        { name: "homoscedastic errors", status: options.covariance === "classical" ? "assumed_by_classical_covariance" : "relaxed_by_hc_covariance" },
      ],
      diagnostics: [
        { name: "identification", status: overId > 0 ? "overidentified" : "exactly_identified", overidentifyingRestrictions: overId },
        { name: "weak instruments", status: weakAny ? "flagged" : "not_flagged", rule: "first-stage F below 10 (Staiger-Stock rule of thumb)", firstStageF: firstStageRows.map((row) => row.fStatistic) },
        { name: "covariance", status: seLabel, detail: "sandwich uses structural residuals with fitted-regressor bread" },
        { name: "inference boundary", status: "asymptotic", detail: "2SLS is consistent but biased in finite samples, especially with many or weak instruments" },
      ],
      artifacts: [
        H.tableArtifact("Two-stage least squares estimates", `Structural equation for ${parsed.outcomeLabel} with ${endogenous.map((item) => item.name).join(", ")} instrumented by ${instruments.map((item) => item.name).join(", ")}; ${seLabel} standard errors, ${percent(level)} intervals.`, K.coefficientColumns(dfReference === null ? "z" : "t"), rows, [], "iv-coefficients-table"),
        H.tableArtifact("First-stage diagnostics", "Strength of the excluded instruments for each endogenous regressor.", [STRING_COLUMN("endogenous", "Endogenous regressor"), STRING_COLUMN("excludedInstruments", "Excluded instruments"), NUMBER_COLUMN("fStatistic", "F"), NUMBER_COLUMN("df1", "df1"), NUMBER_COLUMN("df2", "df2"), NUMBER_COLUMN("pValue", "p"), NUMBER_COLUMN("partialRSquared", "Partial R-squared"), NUMBER_COLUMN("rSquared", "First-stage R-squared"), BOOLEAN_COLUMN("weak", "Weak (F < 10)")], firstStageRows, [], "iv-first-stage-table"),
        H.tableArtifact("2SLS versus OLS", "Structural coefficients under both estimators; large differences on the endogenous regressor indicate endogeneity bias in OLS.", [STRING_COLUMN("estimator", "Estimator"), STRING_COLUMN("term", "Term"), NUMBER_COLUMN("estimate", "Estimate"), NUMBER_COLUMN("standardError", "SE"), NUMBER_COLUMN("lower", "CI lower"), NUMBER_COLUMN("upper", "CI upper")], comparisonRows, [`Wu-Hausman F = ${wuHausman.statistic.toPrecision(6)} (p = ${wuHausman.pValue.toPrecision(4)})${sargan ? `; Sargan chi-square = ${sargan.statistic.toPrecision(6)} (p = ${sargan.pValue.toPrecision(4)})` : "; exactly identified, no Sargan test"}.`], "iv-comparison-table"),
        K.forestPlot(H, "iv-vs-ols-forest", `2SLS and OLS coefficients with ${percent(level)} intervals`, comparisonRows, { xTitle: "Estimate", colorField: "estimator" }),
      ],
    };
  },
  linkage: {
    neededWhen: "A regressor of interest is endogenous (reverse causality, omitted confounding, measurement error) and an instrument exists that shifts it without directly affecting the outcome.",
    decision: "Whether the instruments are strong and plausibly valid, whether OLS is biased, and what the instrumented causal effect is.",
    mustShow: "First-stage strength per endogenous regressor, the 2SLS estimate with its covariance choice, the OLS comparison, the Wu-Hausman test, and the Sargan test when overidentified.",
    userGoal: "Estimate a causal effect from observational data using an explicit, testable-where-possible identification strategy.",
    nextActions: [
      { trigger: "weak-instruments", action: "report-weak-iv-robust-inference-or-find-stronger-instruments", reason: "With a weak first stage, 2SLS is biased toward OLS and conventional intervals undercover." },
      { trigger: "sargan-rejects", action: "reexamine-exclusion-restrictions-instrument-by-instrument", reason: "Rejection means at least one instrument affects the outcome directly, invalidating the joint identification." },
      { trigger: "wu-hausman-not-rejected", action: "report-ols-as-primary-with-iv-sensitivity", reason: "If endogeneity is not detected, OLS is more efficient and 2SLS adds variance without removing bias." },
      { trigger: "identified-effect", action: "bind-first-stage-table-and-iv-vs-ols-forest", reason: "Readers must see instrument strength alongside the instrumented estimate." },
    ],
  },
  fixture: {
    data: {
      y: [5.2, 6.9, 7.8, 9.4, 10.1, 12.3, 13.0, 14.9, 15.7, 17.6, 18.2, 20.4, 21.1, 22.8, 23.9, 25.6, 26.4, 28.1, 29.3, 30.8],
      endogenous: [{ name: "education", values: [10, 11, 12, 12, 13, 14, 14, 15, 16, 16, 17, 18, 18, 19, 20, 20, 21, 22, 22, 23] }],
      instruments: [
        { name: "distanceToCollege", values: [30, 26, 24, 25, 20, 17, 18, 14, 12, 13, 9, 7, 8, 5, 4, 6, 3, 2, 3, 1] },
        { name: "quarterOfBirth", values: [1, 3, 2, 4, 1, 3, 2, 4, 1, 3, 2, 4, 1, 3, 2, 4, 1, 3, 2, 4] },
      ],
      exogenous: [{ name: "experience", values: [5, 4, 6, 5, 7, 6, 8, 7, 9, 8, 10, 9, 11, 10, 12, 11, 13, 12, 14, 13] }],
      outcomeLabel: "Log wage x10",
    },
    options: { covariance: "classical", confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "Two-stage least squares with one or more endogenous regressors, excluded instruments, and exogenous controls; classical or HC0-HC3 covariance on fitted-regressor bread, first-stage F and partial R-squared, Wu-Hausman control-function test, and Sargan overidentification test.",
    oracle: {
      level: "external-library-partial",
      evidence: ["contracts/causal-inference-scipy-crosscheck.py"],
      verifiedOutputs: ["2SLS coefficients (numpy first-principles projection)", "classical and HC standard errors", "first-stage F (statsmodels compare_f_test)", "Wu-Hausman F (statsmodels augmented OLS)", "Sargan statistic", "OLS comparison"],
      excludedOutputs: ["partial R-squared", "weak-instrument flag"],
    },
    diagnostic: { level: "method-specific-partial", emitted: ["identification", "weak instruments", "covariance", "inference boundary"], limitations: ["no weak-IV-robust (Anderson-Rubin) intervals", "no LIML or GMM", "no clustered covariance"] },
    knownGaps: ["Anderson-Rubin and conditional likelihood-ratio inference are not implemented", "LIML, GMM, and clustered standard errors are not offered", "Hansen J with HC weighting is not computed"],
  },
};

/* ------------------------------------------------------------------------------------------ */
/* Sharp regression discontinuity                                                              */
/* ------------------------------------------------------------------------------------------ */

function localLinearSide(x, y, cutoff, bandwidth, side, H, budget) {
  const rows = [];
  for (let index = 0; index < x.length; index += 1) {
    const centered = x[index] - cutoff;
    const onSide = side === "right" ? centered >= 0 : centered < 0;
    if (!onSide) continue;
    const u = centered / bandwidth;
    const weight = Math.abs(u) < 1 ? 1 - Math.abs(u) : 0;
    if (weight > 0) rows.push({ centered, y: y[index], weight });
  }
  if (rows.length < 3 || new Set(rows.map((row) => row.centered)).size < 2) return null;
  const design = rows.map((row) => [1, row.centered]);
  const weights = rows.map((row) => row.weight);
  const fit = K.weightedLeastSquares(rows.map((row) => row.y), design, weights, H, budget);
  const scores = fit.residuals.map((value, index) => weights[index] * value);
  const covariance = K.hcCovariance(design, fit.bread, scores, "hc1", H, budget, null, 2);
  return { intercept: fit.beta[0], slope: fit.beta[1], interceptVariance: covariance[0][0], slopeVariance: covariance[1][1], n: rows.length, effectiveN: weights.reduce((total, value) => total + value, 0) };
}

function rdEstimate(x, y, cutoff, bandwidth, sign, H, budget) {
  const left = localLinearSide(x, y, cutoff, bandwidth, "left", H, budget);
  const right = localLinearSide(x, y, cutoff, bandwidth, "right", H, budget);
  if (!left || !right) return null;
  const estimate = sign * (right.intercept - left.intercept);
  const standardError = Math.sqrt(left.interceptVariance + right.interceptVariance);
  return { estimate, standardError, left, right };
}

/** Imbens-Kalyanaraman (2012) optimal bandwidth for the triangular kernel, sharp design. */
function imbensKalyanaramanBandwidth(x, y, cutoff, H, budget) {
  const n = x.length;
  const sdX = Math.sqrt(K.sampleVariance(x));
  const h1 = 1.84 * sdX * n ** (-1 / 5);
  const leftPilot = [];
  const rightPilot = [];
  for (let index = 0; index < n; index += 1) {
    const centered = x[index] - cutoff;
    if (centered >= 0 && centered <= h1) rightPilot.push(y[index]);
    else if (centered < 0 && centered >= -h1) leftPilot.push(y[index]);
  }
  if (leftPilot.length < 2 || rightPilot.length < 2) H.fail("STAT_INSUFFICIENT_SAMPLE", "too few observations near the cutoff for the Imbens-Kalyanaraman pilot bandwidth");
  const density = (leftPilot.length + rightPilot.length) / (2 * n * h1);
  const variance = (K.sampleVariance(leftPilot) * (leftPilot.length - 1) + K.sampleVariance(rightPilot) * (rightPilot.length - 1)) / (leftPilot.length + rightPilot.length);
  // Global cubic with a jump at the cutoff.
  const cubic = K.olsFit(y, x.map((value) => { const c = value - cutoff; return [1, c >= 0 ? 1 : 0, c, c * c, c * c * c]; }), H, budget);
  const thirdDerivative = 6 * cubic.beta[4];
  const nLeft = x.filter((value) => value < cutoff).length;
  const nRight = n - nLeft;
  const h2Right = 3.56 * (variance / (density * Math.max(thirdDerivative ** 2, 0.01))) ** (1 / 7) * nRight ** (-1 / 7);
  const h2Left = 3.56 * (variance / (density * Math.max(thirdDerivative ** 2, 0.01))) ** (1 / 7) * nLeft ** (-1 / 7);
  const quadratic = (side, h2) => {
    const rows = [];
    for (let index = 0; index < n; index += 1) {
      const c = x[index] - cutoff;
      if (side === "right" ? (c >= 0 && c <= h2) : (c < 0 && c >= -h2)) rows.push({ c, y: y[index] });
    }
    if (rows.length < 4) H.fail("STAT_INSUFFICIENT_SAMPLE", "too few observations for the Imbens-Kalyanaraman local quadratic step");
    const fit = K.olsFit(rows.map((row) => row.y), rows.map((row) => [1, row.c, row.c * row.c]), H, budget);
    return { secondDerivative: 2 * fit.beta[2], n: rows.length };
  };
  const right = quadratic("right", h2Right);
  const left = quadratic("left", h2Left);
  const regularizationRight = 2160 * variance / (right.n * h2Right ** 4);
  const regularizationLeft = 2160 * variance / (left.n * h2Left ** 4);
  const ck = 3.4375;
  const bandwidth = ck * ((2 * variance) / (density * ((right.secondDerivative - left.secondDerivative) ** 2 + regularizationRight + regularizationLeft))) ** (1 / 5) * n ** (-1 / 5);
  return { bandwidth, pilot: h1, density, variance, thirdDerivative, h2Left, h2Right, secondDerivativeLeft: left.secondDerivative, secondDerivativeRight: right.secondDerivative, regularizationLeft, regularizationRight };
}

function exactBinomialTwoSided(count, n, H) {
  const logHalf = n * Math.log(0.5);
  const observed = Math.abs(count - n / 2);
  let total = 0;
  for (let k = 0; k <= n; k += 1) if (Math.abs(k - n / 2) >= observed - 1e-12) total += Math.exp(H.logChoose(n, k) + logHalf);
  return Math.min(1, total);
}

const regressionDiscontinuity = {
  method: "regression_discontinuity",
  family: "causal-inference",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    bandwidth: { schema: { type: "number", exclusiveMinimum: 0 }, default: null, parse(value, H, path) { const number = H.finiteNumber(value, path); if (!(number > 0)) H.fail("STAT_INVALID_INPUT", `${path} must be positive`); return number; } },
    binsPerSide: { schema: { type: "integer", minimum: 3, maximum: 50 }, default: 10, parse(value, H, path) { return H.integer(value, 3, 50, path); } },
    treatmentSide: { schema: { type: "string", enum: ["above", "below"] }, default: "above", parse(value, H, path) { if (!["above", "below"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be above or below`); return value; } },
  },
  dataSchema: { type: "object", additionalProperties: false, required: ["x", "y", "cutoff"], properties: { x: NUMERIC_SCHEMA(20), y: NUMERIC_SCHEMA(20), cutoff: { type: "number" }, xLabel: LABEL_SCHEMA, yLabel: LABEL_SCHEMA } },
  parse(data, options, H) {
    H.assertKeys(data, ["x", "y", "cutoff", "xLabel", "yLabel"], "data");
    const x = H.numericVector(data.x, "data.x", 20);
    const y = H.numericVector(data.y, "data.y", 20);
    if (x.length !== y.length) H.fail("STAT_INVALID_INPUT", "data.x and data.y must have the same length");
    limitRows(x.length, H, "regression_discontinuity");
    const cutoff = H.finiteNumber(data.cutoff, "data.cutoff");
    const left = x.filter((value) => value < cutoff).length;
    if (left < 5 || x.length - left < 5) H.fail("STAT_INSUFFICIENT_SAMPLE", "at least five observations are required on each side of the cutoff");
    if (new Set(x).size < 6) H.fail("STAT_DEGENERATE", "the running variable needs at least six distinct values");
    return { x, y, cutoff, xLabel: H.label(data.xLabel, "Running variable", "data.xLabel"), yLabel: H.label(data.yLabel, "Outcome", "data.yLabel") };
  },
  analyze(parsed, options, budget, H) {
    const { x, y, cutoff } = parsed;
    const n = x.length;
    const level = options.confidenceLevel;
    const sign = options.treatmentSide === "above" ? 1 : -1;
    const ik = options.bandwidth === null ? imbensKalyanaramanBandwidth(x, y, cutoff, H, budget) : null;
    const bandwidth = options.bandwidth === null ? ik.bandwidth : options.bandwidth;
    if (!(bandwidth > 0) || !Number.isFinite(bandwidth)) H.fail("STAT_DEGENERATE", "bandwidth is not positive and finite");
    const main = rdEstimate(x, y, cutoff, bandwidth, sign, H, budget);
    if (!main) H.fail("STAT_INSUFFICIENT_SAMPLE", "fewer than three observations with positive kernel weight on one side of the cutoff; widen the bandwidth");
    const z = H.normalInv(1 - (1 - level) / 2);
    const lower = main.estimate - z * main.standardError;
    const upper = main.estimate + z * main.standardError;
    const pValue = H.pFromNormal(main.estimate / main.standardError, "two-sided");
    const sensitivityRows = [0.5, 0.75, 1, 1.5, 2].map((factor) => {
      const h = bandwidth * factor;
      const result = rdEstimate(x, y, cutoff, h, sign, H, budget);
      return { bandwidthFactor: factor, bandwidth: h, estimate: result ? result.estimate : null, standardError: result ? result.standardError : null, lower: result ? result.estimate - z * result.standardError : null, upper: result ? result.estimate + z * result.standardError : null, nLeft: result ? result.left.n : 0, nRight: result ? result.right.n : 0 };
    });
    // Binned means.
    const { min, max } = H.minMax(x);
    const binRows = [];
    const buildBins = (start, end, side) => {
      const width = (end - start) / options.binsPerSide;
      if (!(width > 0)) return;
      for (let b = 0; b < options.binsPerSide; b += 1) {
        const lo = start + b * width;
        const hi = b === options.binsPerSide - 1 ? end : start + (b + 1) * width;
        const values = [];
        for (let index = 0; index < n; index += 1) {
          const onSide = side === "left" ? x[index] < cutoff : x[index] >= cutoff;
          if (!onSide) continue;
          const inBin = b === options.binsPerSide - 1 ? x[index] >= lo && x[index] <= hi : x[index] >= lo && x[index] < hi;
          if (inBin) values.push(y[index]);
        }
        if (!values.length) continue;
        const mid = (lo + hi) / 2;
        const fit = side === "left" ? main.left : main.right;
        const within = Math.abs(mid - cutoff) < bandwidth;
        // A bin mean drawn as a bare dot invites the eye to read the jump off four or five points
        // that each carry their own error. The interval is what separates a discontinuity from bin
        // noise, so it travels with the point.
        const binMean = K.mean(values);
        const binSd = values.length > 1 ? Math.sqrt(K.sampleVariance(values)) : null;
        const binHalf = binSd === null ? null : H.tCritical(level, values.length - 1) * binSd / Math.sqrt(values.length);
        binRows.push({
          side: side === "left" ? (sign === 1 ? "Control (below cutoff)" : "Treated (below cutoff)") : (sign === 1 ? "Treated (above cutoff)" : "Control (above cutoff)"),
          binStart: lo, binEnd: hi, binMidpoint: mid, meanOutcome: binMean, count: values.length,
          lower: binHalf === null ? null : binMean - binHalf,
          upper: binHalf === null ? null : binMean + binHalf,
          fitted: within ? fit.intercept + fit.slope * (mid - cutoff) : null,
        });
      }
    };
    buildBins(min, cutoff, "left");
    buildBins(cutoff, max, "right");
    // Count symmetry screen within the bandwidth.
    let leftCount = 0;
    let rightCount = 0;
    for (let index = 0; index < n; index += 1) {
      const c = x[index] - cutoff;
      if (c < 0 && c > -bandwidth) leftCount += 1;
      else if (c >= 0 && c < bandwidth) rightCount += 1;
    }
    const symmetryP = exactBinomialTwoSided(rightCount, leftCount + rightCount, H);
    const sideRows = [
      { side: "left of cutoff", n: main.left.n, effectiveN: main.left.effectiveN, intercept: main.left.intercept, interceptSe: Math.sqrt(main.left.interceptVariance), slope: main.left.slope, slopeSe: Math.sqrt(main.left.slopeVariance) },
      { side: "right of cutoff", n: main.right.n, effectiveN: main.right.effectiveN, intercept: main.right.intercept, interceptSe: Math.sqrt(main.right.interceptVariance), slope: main.right.slope, slopeSe: Math.sqrt(main.right.slopeVariance) },
    ];
    return {
      sample: { n, leftOfCutoff: x.filter((value) => value < cutoff).length, rightOfCutoff: x.filter((value) => value >= cutoff).length, withinBandwidthLeft: main.left.n, withinBandwidthRight: main.right.n, cutoff, bandwidth, bandwidthSource: options.bandwidth === null ? "imbens-kalyanaraman" : "user" },
      estimates: [
        { term: "local average treatment effect at the cutoff", estimate: main.estimate, standardError: main.standardError, statistic: main.estimate / main.standardError, df: null, pValue, lower, upper, kind: "effect" },
        { term: "bandwidth", estimate: bandwidth, kind: "tuning", source: options.bandwidth === null ? "imbens-kalyanaraman" : "user" },
        ...sideRows.map((row) => ({ term: `${row.side} intercept`, estimate: row.intercept, standardError: row.interceptSe, kind: "local-linear" })),
        ...sideRows.map((row) => ({ term: `${row.side} slope`, estimate: row.slope, standardError: row.slopeSe, kind: "local-linear" })),
      ],
      tests: [
        { name: "discontinuity at the cutoff = 0", statistic: main.estimate / main.standardError, df: null, pValue, distribution: "normal (HC1 sandwich per side)" },
        { name: "cutoff count symmetry screen (exact binomial within bandwidth)", statistic: rightCount, n: leftCount + rightCount, pValue: symmetryP, distribution: "binomial(n, 1/2)" },
      ],
      confidenceIntervals: [{ parameter: "local average treatment effect", level, lower, upper, method: "normal with HC1 sandwich (conventional, no bias correction)" }],
      effectSizes: [
        { name: "discontinuity", estimate: main.estimate, lower, upper },
        { name: "discontinuity relative to control-side intercept", estimate: (sign === 1 ? main.left.intercept : main.right.intercept) !== 0 ? main.estimate / Math.abs(sign === 1 ? main.left.intercept : main.right.intercept) : null },
      ],
      assumptions: [
        { name: "continuity of potential outcomes at the cutoff", status: "requires_design_review" },
        { name: "no manipulation of the running variable", status: symmetryP < 0.05 ? "count_asymmetry_detected_near_cutoff" : "no_count_asymmetry_detected", detail: "exact binomial screen of counts on each side within the bandwidth; not a McCrary density test", pValue: symmetryP },
        { name: "sharp assignment (treatment is a deterministic function of the cutoff)", status: "requires_design_review" },
        { name: "local linearity within the bandwidth", status: "asymptotic", detail: "conventional local-linear inference ignores smoothing bias; robust bias-corrected intervals are not computed" },
      ],
      diagnostics: [
        { name: "bandwidth", status: options.bandwidth === null ? "imbens_kalyanaraman" : "user_supplied", bandwidth, ...(ik ? { pilot: ik.pilot, densityAtCutoff: ik.density, conditionalVariance: ik.variance, secondDerivativeLeft: ik.secondDerivativeLeft, secondDerivativeRight: ik.secondDerivativeRight, regularizationLeft: ik.regularizationLeft, regularizationRight: ik.regularizationRight } : {}) },
        { name: "bandwidth sensitivity", status: sensitivityRows.every((row) => row.estimate !== null) && (Math.max(...sensitivityRows.map((row) => row.estimate)) - Math.min(...sensitivityRows.map((row) => row.estimate))) < 2 * main.standardError ? "stable_within_two_standard_errors" : "estimate_varies_with_bandwidth", range: sensitivityRows.map((row) => row.estimate) },
        { name: "covariance", status: "hc1_per_side", detail: "variance of the jump is the sum of the two intercept variances from separate weighted regressions" },
        { name: "inference boundary", status: "conventional_not_bias_corrected", detail: "no Calonico-Cattaneo-Titiunik robust bias correction" },
      ],
      artifacts: [
        H.tableArtifact("Sharp regression discontinuity estimate", `${parsed.yLabel} at ${parsed.xLabel} = ${cutoff}, treatment ${options.treatmentSide} the cutoff; local linear, triangular kernel, bandwidth ${bandwidth.toPrecision(5)} (${options.bandwidth === null ? "Imbens-Kalyanaraman" : "user"}).`, [STRING_COLUMN("side", "Side"), NUMBER_COLUMN("n", "n in bandwidth"), NUMBER_COLUMN("effectiveN", "Kernel-weighted n"), NUMBER_COLUMN("intercept", "Intercept at cutoff"), NUMBER_COLUMN("interceptSe", "SE"), NUMBER_COLUMN("slope", "Slope"), NUMBER_COLUMN("slopeSe", "Slope SE")], sideRows, [`Discontinuity = ${main.estimate.toPrecision(6)} (SE ${main.standardError.toPrecision(6)}, ${percent(level)} CI ${lower.toPrecision(6)} to ${upper.toPrecision(6)}).`], "rd-estimate-table"),
        H.tableArtifact("Bandwidth sensitivity", "Discontinuity estimates at multiples of the main bandwidth.", [NUMBER_COLUMN("bandwidthFactor", "Factor"), NUMBER_COLUMN("bandwidth", "Bandwidth"), NUMBER_COLUMN("estimate", "Estimate"), NUMBER_COLUMN("standardError", "SE"), NUMBER_COLUMN("lower", "CI lower"), NUMBER_COLUMN("upper", "CI upper"), NUMBER_COLUMN("nLeft", "n left"), NUMBER_COLUMN("nRight", "n right")], sensitivityRows, [], "rd-sensitivity-table"),
        H.tableArtifact("Binned means for the RD plot", `${options.binsPerSide} evenly spaced bins per side; fitted values come from the local-linear fits and are only shown within the bandwidth.`, [STRING_COLUMN("side", "Side"), NUMBER_COLUMN("binStart", "Bin start"), NUMBER_COLUMN("binEnd", "Bin end"), NUMBER_COLUMN("binMidpoint", "Midpoint"), NUMBER_COLUMN("meanOutcome", "Mean outcome"), NUMBER_COLUMN("count", "Count"), NUMBER_COLUMN("lower", "CI lower"), NUMBER_COLUMN("upper", "CI upper"), NUMBER_COLUMN("fitted", "Local-linear fit")], binRows, [], "rd-bins-table"),
        H.vegaArtifact("rd-plot", `Regression discontinuity plot: binned means and local-linear fits at ${parsed.xLabel} = ${cutoff}`, {
          data: { values: binRows },
          layer: [
            { mark: { type: "rule", strokeWidth: 1.2, opacity: 0.7 }, encoding: { x: { field: "binMidpoint", type: "quantitative", title: parsed.xLabel }, y: { field: "lower", type: "quantitative", scale: { zero: false }, title: `${parsed.yLabel} (bin mean)` }, y2: { field: "upper" }, color: { field: "side", type: "nominal", title: null } } },
            { mark: { type: "point", filled: true, size: 70 }, encoding: { x: { field: "binMidpoint", type: "quantitative", title: parsed.xLabel }, y: { field: "meanOutcome", type: "quantitative", scale: { zero: false }, title: `${parsed.yLabel} (bin mean)` }, color: { field: "side", type: "nominal", title: null }, size: { field: "count", type: "quantitative", legend: null }, tooltip: [{ field: "side" }, { field: "binMidpoint", format: ".4g" }, { field: "meanOutcome", format: ".4g" }, { field: "count" }, { field: "lower", format: ".4g" }, { field: "upper", format: ".4g" }] } },
            { mark: { type: "line", strokeWidth: 2 }, encoding: { x: { field: "binMidpoint", type: "quantitative" }, y: { field: "fitted", type: "quantitative", scale: { zero: false } }, color: { field: "side", type: "nominal" }, detail: { field: "side" } } },
            { mark: { type: "rule", strokeDash: [4, 4], color: "#555" }, encoding: { x: { datum: cutoff } } },
          ],
        }),
        H.vegaArtifact("rd-sensitivity-plot", "Discontinuity estimate across bandwidth multiples", {
          data: { values: sensitivityRows },
          layer: [
            { mark: { type: "rule", strokeWidth: 2 }, encoding: { x: { field: "bandwidthFactor", type: "quantitative", title: "Bandwidth multiple" }, y: { field: "lower", type: "quantitative", title: "Discontinuity" }, y2: { field: "upper" } } },
            { mark: { type: "point", filled: true, size: 80 }, encoding: { x: { field: "bandwidthFactor", type: "quantitative" }, y: { field: "estimate", type: "quantitative" }, tooltip: [{ field: "bandwidth", format: ".4g" }, { field: "estimate", format: ".4g" }, { field: "nLeft" }, { field: "nRight" }] } },
            { mark: { type: "rule", strokeDash: [4, 4], color: "#777" }, encoding: { y: { datum: 0 } } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "Treatment is assigned deterministically by whether a running variable crosses a known threshold, so units just on either side are comparable.",
    decision: "Whether the outcome jumps at the threshold, how large the local effect is, and whether the estimate is robust to the bandwidth and free of sorting at the cutoff.",
    mustShow: "The RD plot with binned means and local fits, the bandwidth and how it was chosen, the estimate with its interval, the bandwidth sensitivity, and the manipulation screen.",
    userGoal: "Estimate a credible local causal effect from a threshold rule without a randomized experiment.",
    nextActions: [
      { trigger: "estimate-varies-with-bandwidth", action: "report-sensitivity-table-and-prefer-robust-bias-corrected-inference", reason: "Bandwidth-dependent estimates signal curvature near the cutoff that conventional intervals do not account for." },
      { trigger: "count-asymmetry-near-cutoff", action: "run-formal-density-test-and-inspect-running-variable-provenance", reason: "Bunching on one side suggests manipulation of the running variable, which breaks the design." },
      { trigger: "few-observations-in-bandwidth", action: "widen-bandwidth-with-explicit-bias-tradeoff-statement", reason: "A very local estimate with few units has large variance and unstable slopes." },
      { trigger: "credible-jump", action: "bind-rd-plot-and-sensitivity-table", reason: "Readers need to see the discontinuity in the data and its stability across bandwidths." },
    ],
  },
  fixture: {
    data: {
      x: [30, 32, 35, 37, 38, 40, 41, 43, 44, 45, 46, 47, 48, 49, 49.5, 50, 50.5, 51, 52, 53, 54, 55, 56, 57, 59, 60, 62, 63, 65, 67, 68, 70, 33, 36, 42, 47.5, 48.5, 51.5, 52.5, 58],
      y: [20.1, 20.9, 22.2, 22.8, 23.4, 24.0, 24.6, 25.3, 25.8, 26.1, 26.5, 26.9, 27.4, 27.6, 27.9, 33.2, 33.5, 33.9, 34.3, 34.8, 35.1, 35.6, 36.0, 36.5, 37.2, 37.6, 38.4, 38.8, 39.7, 40.4, 40.9, 41.6, 21.4, 22.6, 24.9, 27.2, 27.7, 34.0, 34.5, 36.8],
      cutoff: 50,
      xLabel: "Test score",
      yLabel: "Outcome",
    },
    options: { binsPerSide: 8, confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "Sharp regression discontinuity by separate local-linear triangular-kernel fits on each side of the cutoff with HC1 variance, the Imbens-Kalyanaraman (2012) bandwidth or a user bandwidth, bandwidth sensitivity, binned-means RD plot, and an exact binomial count-symmetry screen.",
    oracle: {
      level: "external-library-partial",
      evidence: ["contracts/causal-inference-scipy-crosscheck.py"],
      verifiedOutputs: ["discontinuity estimate and HC1 standard error (statsmodels WLS per side)", "Imbens-Kalyanaraman bandwidth (numpy first-principles re-derivation of the published steps, not rdrobust or rdd)", "binned means", "binomial symmetry p value (scipy binomtest)"],
      excludedOutputs: ["bandwidth sensitivity stability flag", "relative effect size"],
    },
    diagnostic: { level: "method-specific-partial", emitted: ["bandwidth", "bandwidth sensitivity", "manipulation screen", "covariance", "inference boundary"], limitations: ["no robust bias-corrected intervals", "no McCrary or Cattaneo-Jansson-Ma density test", "no covariate balance at the cutoff"] },
    knownGaps: ["fuzzy designs are not supported", "Calonico-Cattaneo-Titiunik bias correction and rdrobust bandwidths are not implemented", "no placebo cutoffs or covariate continuity tests"],
  },
};

/* ------------------------------------------------------------------------------------------ */
/* Mediation analysis                                                                          */
/* ------------------------------------------------------------------------------------------ */

const mediationAnalysis = {
  method: "mediation_analysis",
  family: "causal-inference",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    seed: { schema: { type: "integer", minimum: 0, maximum: 4294967295 }, default: 20240901, parse(value, H, path) { return H.integer(value, 0, 4294967295, path); } },
    bootstrapSamples: { schema: { type: "integer", minimum: 200, maximum: 5000 }, default: 1000, parse(value, H, path) { return H.integer(value, 200, 5000, path); } },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["x", "m", "y"],
    properties: { x: NUMERIC_SCHEMA(10), m: NUMERIC_SCHEMA(10), y: NUMERIC_SCHEMA(10), covariates: PREDICTORS_SCHEMA(1), xLabel: LABEL_SCHEMA, mLabel: LABEL_SCHEMA, yLabel: LABEL_SCHEMA },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["x", "m", "y", "covariates", "xLabel", "mLabel", "yLabel"], "data");
    const x = H.numericVector(data.x, "data.x", 10);
    const m = H.numericVector(data.m, "data.m", 10);
    const y = H.numericVector(data.y, "data.y", 10);
    if (x.length !== m.length || x.length !== y.length) H.fail("STAT_INVALID_INPUT", "data.x, data.m, and data.y must have the same length");
    if (x.length > 2000) H.fail("STAT_LIMIT_EXCEEDED", "mediation_analysis supports at most 2000 observations");
    if (H.minMax(x).min === H.minMax(x).max) H.fail("STAT_DEGENERATE", "data.x is constant");
    if (H.minMax(m).min === H.minMax(m).max) H.fail("STAT_DEGENERATE", "data.m is constant");
    const covariates = optionalPredictors(data.covariates, x.length, H);
    return { x, m, y, covariates, xLabel: H.label(data.xLabel, "X", "data.xLabel"), mLabel: H.label(data.mLabel, "M", "data.mLabel"), yLabel: H.label(data.yLabel, "Y", "data.yLabel") };
  },
  analyze(parsed, options, budget, H) {
    const { x, m, y, covariates } = parsed;
    const n = x.length;
    const level = options.confidenceLevel;
    const covariateDesign = covariates.length ? H.designMatrix({ y, predictors: covariates }, false) : { x: y.map(() => []), terms: [] };
    const covariateNames = covariateDesign.terms.map((term) => term.name);
    const xm = y.map((_, index) => [1, x[index], ...covariateDesign.x[index]]);
    const xmy = y.map((_, index) => [1, x[index], m[index], ...covariateDesign.x[index]]);
    assertRank(xmy, H, "mediation design is rank deficient");
    const mediatorFit = K.olsFit(m, xm, H, budget);
    const outcomeFit = K.olsFit(y, xmy, H, budget);
    const totalFit = K.olsFit(y, xm, H, budget);
    const a = mediatorFit.beta[1];
    const b = outcomeFit.beta[2];
    const cPrime = outcomeFit.beta[1];
    const c = totalFit.beta[1];
    const seA = Math.sqrt(mediatorFit.covariance[1][1]);
    const seB = Math.sqrt(outcomeFit.covariance[2][2]);
    const indirect = a * b;
    const sobelSe = Math.sqrt(a * a * seB * seB + b * b * seA * seA);
    const aroianSe = Math.sqrt(a * a * seB * seB + b * b * seA * seA + seA * seA * seB * seB);
    const sobelZ = indirect / sobelSe;
    const z = H.normalInv(1 - (1 - level) / 2);
    // Seeded nonparametric bootstrap.
    const generator = K.seededGenerator(options.seed);
    const B = options.bootstrapSamples;
    const indirectDraws = [];
    const directDraws = [];
    const totalDraws = [];
    for (let replicate = 0; replicate < B; replicate += 1) {
      budget.check(n * 16);
      const indices = Array.from({ length: n }, () => generator.below(n));
      const mB = indices.map((index) => m[index]);
      const yB = indices.map((index) => y[index]);
      const xmB = indices.map((index) => xm[index]);
      const xmyB = indices.map((index) => xmy[index]);
      let mediatorB;
      let outcomeB;
      try {
        mediatorB = K.weightedLeastSquares(mB, xmB, null, H, budget);
        outcomeB = K.weightedLeastSquares(yB, xmyB, null, H, budget);
      } catch (error) {
        if (error instanceof H.StatisticsError) H.fail("STAT_DEGENERATE", "a bootstrap resample produced a singular design; the sample is too small for resampling");
        throw error;
      }
      indirectDraws.push(mediatorB.beta[1] * outcomeB.beta[2]);
      directDraws.push(outcomeB.beta[1]);
      totalDraws.push(outcomeB.beta[1] + mediatorB.beta[1] * outcomeB.beta[2]);
    }
    const alpha = 1 - level;
    const percentile = (draws) => { const sorted = H.sorted(draws); return { lower: H.quantileR7(sorted, alpha / 2), upper: H.quantileR7(sorted, 1 - alpha / 2), se: Math.sqrt(K.sampleVariance(draws)), mean: K.mean(draws) }; };
    const biasCorrected = (draws, estimate) => {
      const below = draws.filter((value) => value < estimate).length;
      const proportion = Math.min(1 - 1e-9, Math.max(1e-9, below / B));
      const z0 = H.normalInv(proportion);
      const lowerP = H.normalCdf(2 * z0 + H.normalInv(alpha / 2));
      const upperP = H.normalCdf(2 * z0 + H.normalInv(1 - alpha / 2));
      const sorted = H.sorted(draws);
      return { lower: H.quantileR7(sorted, lowerP), upper: H.quantileR7(sorted, upperP), z0 };
    };
    const indirectBoot = percentile(indirectDraws);
    const indirectBc = biasCorrected(indirectDraws, indirect);
    const directBoot = percentile(directDraws);
    const totalBoot = percentile(totalDraws);
    const pathRows = [
      { path: `a: ${parsed.xLabel} -> ${parsed.mLabel}`, estimate: a, standardError: seA, statistic: a / seA, df: mediatorFit.df, pValue: H.pFromT(a / seA, mediatorFit.df, "two-sided"), lower: a - H.tCritical(level, mediatorFit.df) * seA, upper: a + H.tCritical(level, mediatorFit.df) * seA, method: "OLS t" },
      { path: `b: ${parsed.mLabel} -> ${parsed.yLabel} | ${parsed.xLabel}`, estimate: b, standardError: seB, statistic: b / seB, df: outcomeFit.df, pValue: H.pFromT(b / seB, outcomeFit.df, "two-sided"), lower: b - H.tCritical(level, outcomeFit.df) * seB, upper: b + H.tCritical(level, outcomeFit.df) * seB, method: "OLS t" },
      { path: `c': direct ${parsed.xLabel} -> ${parsed.yLabel} | ${parsed.mLabel}`, estimate: cPrime, standardError: Math.sqrt(outcomeFit.covariance[1][1]), statistic: cPrime / Math.sqrt(outcomeFit.covariance[1][1]), df: outcomeFit.df, pValue: H.pFromT(cPrime / Math.sqrt(outcomeFit.covariance[1][1]), outcomeFit.df, "two-sided"), lower: cPrime - H.tCritical(level, outcomeFit.df) * Math.sqrt(outcomeFit.covariance[1][1]), upper: cPrime + H.tCritical(level, outcomeFit.df) * Math.sqrt(outcomeFit.covariance[1][1]), method: "OLS t" },
      { path: `c: total ${parsed.xLabel} -> ${parsed.yLabel}`, estimate: c, standardError: Math.sqrt(totalFit.covariance[1][1]), statistic: c / Math.sqrt(totalFit.covariance[1][1]), df: totalFit.df, pValue: H.pFromT(c / Math.sqrt(totalFit.covariance[1][1]), totalFit.df, "two-sided"), lower: c - H.tCritical(level, totalFit.df) * Math.sqrt(totalFit.covariance[1][1]), upper: c + H.tCritical(level, totalFit.df) * Math.sqrt(totalFit.covariance[1][1]), method: "OLS t" },
    ];
    const effectRows = [
      { effect: "indirect (a x b)", estimate: indirect, standardError: sobelSe, lower: indirect - z * sobelSe, upper: indirect + z * sobelSe, method: "Sobel normal" },
      { effect: "indirect (a x b)", estimate: indirect, standardError: indirectBoot.se, lower: indirectBoot.lower, upper: indirectBoot.upper, method: `bootstrap percentile (${B} resamples, seed ${options.seed})` },
      { effect: "indirect (a x b)", estimate: indirect, standardError: indirectBoot.se, lower: indirectBc.lower, upper: indirectBc.upper, method: "bootstrap bias-corrected" },
      { effect: "direct (c')", estimate: cPrime, standardError: directBoot.se, lower: directBoot.lower, upper: directBoot.upper, method: "bootstrap percentile" },
      { effect: "total (c' + a x b)", estimate: cPrime + indirect, standardError: totalBoot.se, lower: totalBoot.lower, upper: totalBoot.upper, method: "bootstrap percentile" },
    ];
    const proportionMediated = c !== 0 ? indirect / c : null;
    // Histogram of bootstrap indirect effects.
    const bins = 30;
    const drawMin = Math.min(...indirectDraws);
    const drawMax = Math.max(...indirectDraws);
    const width = drawMax > drawMin ? (drawMax - drawMin) / bins : 1;
    const histogramRows = Array.from({ length: bins }, (_, b) => ({ binStart: drawMin + b * width, binEnd: drawMin + (b + 1) * width, count: 0 }));
    for (const draw of indirectDraws) {
      let b = Math.floor((draw - drawMin) / width);
      if (b >= bins) b = bins - 1;
      histogramRows[b].count += 1;
    }
    const covariateNote = covariateNames.length ? ` adjusting for ${covariateNames.join(", ")}` : "";
    return {
      sample: { n, covariateColumns: covariateNames.length, bootstrapSamples: B, seed: options.seed },
      estimates: [
        ...pathRows.map((row) => ({ term: row.path, estimate: row.estimate, standardError: row.standardError, statistic: row.statistic, df: row.df, pValue: row.pValue, lower: row.lower, upper: row.upper, kind: "path" })),
        ...effectRows.map((row) => ({ term: `${row.effect} [${row.method}]`, estimate: row.estimate, standardError: row.standardError, lower: row.lower, upper: row.upper, kind: "effect" })),
        { term: "proportion mediated (ab / c)", estimate: proportionMediated, kind: "derived" },
        { term: "bootstrap mean of indirect effect", estimate: indirectBoot.mean, kind: "bootstrap" },
      ],
      tests: [
        { name: "Sobel test of the indirect effect", statistic: sobelZ, df: null, pValue: H.pFromNormal(sobelZ, "two-sided"), distribution: "normal", standardError: sobelSe },
        { name: "Aroian variant of the Sobel test", statistic: indirect / aroianSe, df: null, pValue: H.pFromNormal(indirect / aroianSe, "two-sided"), distribution: "normal", standardError: aroianSe },
        ...pathRows.map((row) => ({ name: `${row.path} = 0`, statistic: row.statistic, df: row.df, pValue: row.pValue, distribution: "t" })),
      ],
      confidenceIntervals: effectRows.map((row) => ({ parameter: row.effect, level, lower: row.lower, upper: row.upper, method: row.method })),
      effectSizes: [
        { name: "indirect effect", estimate: indirect, lower: indirectBoot.lower, upper: indirectBoot.upper },
        { name: "proportion mediated", estimate: proportionMediated },
        { name: "ratio of indirect to direct effect", estimate: cPrime !== 0 ? indirect / cPrime : null },
      ],
      assumptions: [
        { name: "no unmeasured confounding of X-M, X-Y, and M-Y (sequential ignorability)", status: "requires_design_review" },
        { name: "no exposure-mediator interaction", status: "not_established", detail: "the product-of-coefficients model assumes the mediator effect does not depend on exposure; an interaction term is not fitted" },
        { name: "linear relations and homoscedastic errors", status: "requires_design_review" },
        { name: "indirect-effect sampling distribution is non-normal", status: "handled_by_bootstrap", detail: "Sobel intervals assume normality of a x b; prefer the bootstrap intervals" },
      ],
      diagnostics: [
        { name: "bootstrap", status: "seeded_nonparametric", resamples: B, seed: options.seed, generator: "SplitMix64 case resampling", biasCorrectionZ0: indirectBc.z0 },
        { name: "interval agreement", status: (indirectBoot.lower <= 0 && indirectBoot.upper >= 0) === (indirect - z * sobelSe <= 0 && indirect + z * sobelSe >= 0) ? "sobel_and_bootstrap_agree_on_zero" : "sobel_and_bootstrap_disagree_on_zero" },
        { name: "suppression check", status: proportionMediated !== null && proportionMediated < 0 ? "inconsistent_mediation_signs_differ" : "consistent_signs" },
        { name: "model fit", mediatorRSquared: mediatorFit.rSquared, outcomeRSquared: outcomeFit.rSquared, totalRSquared: totalFit.rSquared },
      ],
      artifacts: [
        H.tableArtifact("Mediation path coefficients", `Simple mediation of ${parsed.xLabel} on ${parsed.yLabel} through ${parsed.mLabel}${covariateNote}; ${percent(level)} t intervals.`, [STRING_COLUMN("path", "Path"), NUMBER_COLUMN("estimate", "Estimate"), NUMBER_COLUMN("standardError", "SE"), NUMBER_COLUMN("statistic", "t"), NUMBER_COLUMN("df", "df"), NUMBER_COLUMN("pValue", "p"), NUMBER_COLUMN("lower", "CI lower"), NUMBER_COLUMN("upper", "CI upper"), STRING_COLUMN("method", "Method")], pathRows, [], "mediation-paths-table"),
        H.tableArtifact("Indirect, direct, and total effects", "Product-of-coefficients effects with Sobel and seeded bootstrap intervals.", [STRING_COLUMN("effect", "Effect"), NUMBER_COLUMN("estimate", "Estimate"), NUMBER_COLUMN("standardError", "SE"), NUMBER_COLUMN("lower", "CI lower"), NUMBER_COLUMN("upper", "CI upper"), STRING_COLUMN("method", "Interval method")], effectRows, [`Proportion mediated = ${proportionMediated === null ? "undefined (total effect is zero)" : proportionMediated.toPrecision(4)}.`], "mediation-effects-table"),
        H.tableArtifact("Bootstrap distribution of the indirect effect", `Histogram of ${B} resampled a x b products.`, [NUMBER_COLUMN("binStart", "Bin start"), NUMBER_COLUMN("binEnd", "Bin end"), NUMBER_COLUMN("count", "Count")], histogramRows, [], "mediation-bootstrap-table"),
        H.vegaArtifact("mediation-bootstrap-plot", `Bootstrap distribution of the indirect effect with ${percent(level)} percentile interval`, {
          data: { values: histogramRows },
          layer: [
            { mark: { type: "bar", color: "#6baed6" }, encoding: { x: { field: "binStart", type: "quantitative", title: "Indirect effect (a x b)", bin: { binned: true } }, x2: { field: "binEnd" }, y: { field: "count", type: "quantitative", title: "Resamples" }, tooltip: [{ field: "binStart", format: ".4g" }, { field: "binEnd", format: ".4g" }, { field: "count" }] } },
            { mark: { type: "rule", color: "#c0392b", strokeWidth: 2 }, encoding: { x: { datum: indirect } } },
            { mark: { type: "rule", strokeDash: [4, 4], color: "#333" }, encoding: { x: { datum: indirectBoot.lower } } },
            { mark: { type: "rule", strokeDash: [4, 4], color: "#333" }, encoding: { x: { datum: indirectBoot.upper } } },
            { mark: { type: "rule", strokeDash: [2, 2], color: "#999" }, encoding: { x: { datum: 0 } } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "A hypothesized mechanism links an exposure to an outcome through an intermediate variable and the researcher wants to quantify how much of the effect travels through it.",
    decision: "Whether the indirect path is supported, how large the mediated share is, and whether the bootstrap and normal-theory intervals agree.",
    mustShow: "The a, b, c, and c' paths with uncertainty, the indirect effect with Sobel and bootstrap intervals, the bootstrap distribution, the seed, and the untestable ignorability assumptions.",
    userGoal: "Report a mechanism claim with intervals that respect the non-normal distribution of the indirect effect.",
    nextActions: [
      { trigger: "sobel-and-bootstrap-disagree", action: "report-bootstrap-interval-as-primary", reason: "The product of two coefficients is skewed, so the normal-theory Sobel interval is the less reliable of the two." },
      { trigger: "exposure-mediator-interaction-plausible", action: "fit-interaction-model-and-report-natural-effects", reason: "Product-of-coefficients mediation misstates effects when the mediator effect depends on exposure." },
      { trigger: "confounding-of-mediator-outcome-plausible", action: "run-sensitivity-analysis-for-sequential-ignorability", reason: "The indirect effect is identified only if no unmeasured variable affects both mediator and outcome." },
      { trigger: "mechanism-supported", action: "bind-path-table-effects-table-and-bootstrap-plot", reason: "Readers need the paths, the decomposition, and the resampling evidence together." },
    ],
  },
  fixture: {
    data: {
      x: [1.2, 2.4, 0.8, 3.1, 2.2, 1.9, 3.6, 0.5, 2.8, 1.5, 3.3, 2.0, 0.9, 2.6, 1.7, 3.8, 1.1, 2.9, 2.3, 0.7, 3.0, 1.4, 2.7, 1.8],
      m: [2.5, 4.1, 1.9, 5.2, 3.8, 3.4, 5.9, 1.4, 4.6, 2.9, 5.5, 3.6, 2.2, 4.4, 3.1, 6.3, 2.4, 4.9, 4.0, 1.8, 5.0, 2.7, 4.5, 3.3],
      y: [4.1, 6.8, 3.2, 8.9, 6.1, 5.7, 9.8, 2.6, 7.7, 4.9, 9.1, 6.0, 3.7, 7.3, 5.4, 10.4, 4.0, 8.2, 6.6, 3.0, 8.4, 4.6, 7.5, 5.6],
      xLabel: "Training hours",
      mLabel: "Skill score",
      yLabel: "Productivity",
    },
    options: { seed: 20240901, bootstrapSamples: 1000, confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "Single-mediator product-of-coefficients analysis with optional covariates, Sobel and Aroian tests, seeded nonparametric bootstrap percentile and bias-corrected intervals for indirect, direct, and total effects, and proportion mediated.",
    oracle: {
      level: "external-library-partial",
      evidence: ["contracts/causal-inference-scipy-crosscheck.py"],
      verifiedOutputs: ["path coefficients and standard errors (statsmodels OLS)", "Sobel statistic", "bootstrap percentile bounds on the identical SplitMix64 resample stream (numpy)", "bias-corrected bounds"],
      excludedOutputs: ["proportion mediated", "histogram bins", "interval agreement flag"],
    },
    diagnostic: { level: "method-specific-partial", emitted: ["bootstrap", "interval agreement", "suppression check", "model fit"], limitations: ["no exposure-mediator interaction", "no sensitivity analysis for sequential ignorability", "no multiple mediators"] },
    knownGaps: ["causal mediation with exposure-mediator interaction (natural effects) is not implemented", "no sensitivity analysis for unmeasured mediator-outcome confounding", "binary mediators or outcomes are not supported"],
  },
};

module.exports = {
  methods: [differenceInDifferences, propensityScoreAnalysis, instrumentalVariables2sls, regressionDiscontinuity, mediationAnalysis],
};
