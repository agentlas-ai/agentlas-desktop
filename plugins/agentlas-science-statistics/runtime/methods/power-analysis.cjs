"use strict";

/**
 * Power-analysis family: a priori / sensitivity / criterion power calculations that solve for the
 * one omitted quantity among power, sample size, effect size, and alpha (customOption `solveFor`).
 *
 * Distribution work uses ./power-noncentral.cjs (AS 243 non-central t, Poisson-mixture non-central
 * chi-square and F). Every solver is a bracketed bisection on a monotone map, so results are
 * deterministic and reported with the residual of the final bracket.
 */

const NC = require("./power-noncentral.cjs");

const SOLVE_TARGETS = Object.freeze(["power", "sampleSize", "effectSize", "alpha"]);
const MAX_SAMPLE_SIZE = 10_000_000;
const CURVE_POINTS = 40;

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

const solveForOption = enumOption(SOLVE_TARGETS, "power", "power analysis");

function probability(H, value, path) {
  const number = H.finiteNumber(value, path);
  if (number <= 0 || number >= 1) H.fail("STAT_INVALID_INPUT", `${path} must be strictly inside (0, 1)`);
  return number;
}

function positive(H, value, path) {
  const number = H.finiteNumber(value, path);
  if (number <= 0) H.fail("STAT_INVALID_INPUT", `${path} must be positive`);
  return number;
}

/**
 * Validate the "solve for the missing one" contract: every quantity in `quantities` except the
 * solve target must be present; the solve target must be omitted.
 */
function parseSolveInputs(H, data, options, quantities, parsers) {
  const target = options.solveFor;
  if (!quantities.includes(target)) H.fail("STAT_INVALID_INPUT", `options.solveFor=${target} is not solvable for this method`);
  const parsed = {};
  for (const key of quantities) {
    if (key === target) {
      if (data[key] !== undefined) H.fail("STAT_INVALID_INPUT", `data.${key} must be omitted when options.solveFor is ${target}`);
      parsed[key] = null;
      continue;
    }
    if (data[key] === undefined) H.fail("STAT_INVALID_INPUT", `data.${key} is required when options.solveFor is ${target}`);
    parsed[key] = parsers[key](data[key], `data.${key}`);
  }
  return parsed;
}

function solveScalar(H, budget, fn, target, low, high, { increasing = true, iterations = 200, label = "quantity", expand = false } = {}) {
  const lowValue = fn(low);
  if (increasing ? lowValue >= target : lowValue <= target) return { value: low, residual: lowValue - target, iterations: 0, boundary: "lower" };
  let a = low;
  let b = high;
  let count = 0;
  if (expand) {
    // grow the bracket geometrically from the lower bound so extreme upper limits are never evaluated needlessly
    b = Math.max(low * 2, low + 1);
    for (;;) {
      budget.check(64);
      count += 1;
      if (b >= high) { b = high; break; }
      const value = fn(b);
      if (increasing ? value >= target : value <= target) break;
      a = b;
      b = Math.min(high, b * 2);
    }
  }
  const highValue = fn(b);
  if (increasing ? highValue < target : highValue > target) {
    H.fail("STAT_NON_CONVERGENCE", `requested power is unattainable within the search range for ${label} (power at bound ${highValue.toPrecision(6)})`);
  }
  for (let i = 0; i < iterations; i += 1) {
    budget.check(64);
    count += 1;
    const mid = 0.5 * (a + b);
    if (mid === a || mid === b) break;
    const value = fn(mid);
    if (increasing ? value < target : value > target) a = mid;
    else b = mid;
  }
  const value = b;
  return { value, residual: fn(value) - target, iterations: count, boundary: null };
}

function alternativeSuffix(alternative) {
  return alternative === "two-sided" ? "two-sided" : `one-sided (${alternative})`;
}

function inputTable(H, rows, title, caption, role) {
  return H.tableArtifact(title, caption, [
    { key: "parameter", label: "Parameter", type: "string" },
    { key: "value", label: "Value", type: "number" },
    { key: "status", label: "Status", type: "string" },
    { key: "note", label: "Note", type: "string" },
  ], rows, [], role);
}

function curveArtifacts(H, curveRows, { xKey, xLabel, yKey = "power", yLabel = "Power", targetPower, role, tableRole, title, caption }) {
  const table = H.tableArtifact(`${title} curve`, caption, [
    { key: xKey, label: xLabel, type: "number" },
    { key: yKey, label: yLabel, type: "number" },
    { key: "solution", label: "Solution point", type: "boolean" },
  ], curveRows, [], tableRole);
  const layers = [
    { mark: { type: "line", strokeWidth: 2 }, encoding: { x: { field: xKey, type: "quantitative", title: xLabel }, y: { field: yKey, type: "quantitative", title: yLabel, scale: { domain: [0, 1] } } } },
    { mark: { type: "point", filled: true, size: 140, color: "#d62728" }, encoding: { x: { field: xKey, type: "quantitative" }, y: { field: yKey, type: "quantitative" }, opacity: { condition: { test: "datum.solution === true", value: 1 }, value: 0 }, tooltip: [{ field: xKey, title: xLabel }, { field: yKey, title: yLabel, format: ".4f" }] } },
  ];
  if (targetPower !== null && targetPower !== undefined) {
    layers.push({ mark: { type: "rule", strokeDash: [6, 4], color: "#555" }, encoding: { y: { datum: targetPower, type: "quantitative" } } });
  }
  const figure = H.vegaArtifact(role, title, { data: { values: curveRows }, width: 480, height: 300, layer: layers });
  return [table, figure];
}

function integerCurveGrid(minimum, solution, points = CURVE_POINTS) {
  const top = Math.max(Math.ceil(solution * 2), minimum + points);
  const grid = new Set();
  for (let i = 0; i < points; i += 1) grid.add(Math.round(minimum + (top - minimum) * i / (points - 1)));
  grid.add(Math.ceil(solution));
  return [...grid].filter((value) => value >= minimum).sort((a, b) => a - b);
}

function linearCurveGrid(minimum, maximum, points, solution) {
  const grid = new Set();
  for (let i = 0; i < points; i += 1) grid.add(Number((minimum + (maximum - minimum) * i / (points - 1)).toPrecision(10)));
  grid.add(Number(solution.toPrecision(10)));
  return [...grid].sort((a, b) => a - b);
}

function powerLinkage(kind) {
  return {
    neededWhen: `Before data collection or when justifying a study size for a ${kind}, when the researcher must state the smallest effect worth detecting and the error rates the design will tolerate.`,
    decision: `How many observations to enrol, which effect size the study can credibly detect, or whether an already-collected ${kind} sample was adequate for its stated hypothesis.`,
    mustShow: "The solved quantity with the three fixed inputs, the alternative and test model used, the exact distributional approximation, and a power curve so the sensitivity of the design to sample size is visible.",
    userGoal: "Commit to a defensible sample size or effect-size target before analysis, and document that decision in a pre-registration or grant methods section.",
    nextActions: [
      { trigger: "sample-size-exceeds-feasible-budget", action: "revise-effect-size-target-or-design-with-explicit-justification", reason: "Shrinking the target effect after seeing the number is only defensible when the new minimal effect is scientifically motivated." },
      { trigger: "effect-size-unsupported-by-prior-evidence", action: "run-sensitivity-power-analysis-across-plausible-effect-range", reason: "A single point estimate from a pilot is a noisy anchor; the curve shows how fragile the plan is." },
      { trigger: "design-committed", action: "bind-power-table-and-curve-to-preregistration", reason: "The sample-size justification must travel with the frozen hypothesis, alpha, and alternative." },
      { trigger: "post-hoc-power-requested", action: "report-confidence-interval-instead-of-observed-power", reason: "Observed power is a monotone transform of the p value and adds no information beyond the interval." },
    ],
  };
}

function baseAssumptions(extra = []) {
  return [
    { name: "prespecified effect size", status: "requires_design_review", detail: "The effect size must be the smallest scientifically meaningful effect, not a pilot point estimate." },
    { name: "independent observations", status: "requires_design_review" },
    ...extra,
  ];
}

function solverDiagnostic(solved, target, method) {
  return {
    name: "solver",
    status: "evaluated",
    target,
    method,
    iterations: solved.iterations,
    residualPower: solved.residual,
    boundary: solved.boundary,
  };
}

function coverageTemplate(boundary, verified, excluded, emitted, limitations, gaps) {
  return {
    implementedBoundary: boundary,
    oracle: { level: "external-library-partial", evidence: ["contracts/power-analysis-scipy-crosscheck.py"], verifiedOutputs: verified, excludedOutputs: excluded },
    diagnostic: { level: "method-specific-partial", emitted, limitations },
    knownGaps: gaps,
  };
}

// ---------------------------------------------------------------------------------------------
// power_t_test
// ---------------------------------------------------------------------------------------------

function tTestPower(H, { effectSize, sampleSize, alpha, design, ratio, alternative }) {
  let df;
  let noncentrality;
  if (design === "two-sample") {
    const n1 = sampleSize;
    const n2 = sampleSize * ratio;
    df = n1 + n2 - 2;
    noncentrality = effectSize * Math.sqrt(n1 * n2 / (n1 + n2));
  } else {
    df = sampleSize - 1;
    noncentrality = effectSize * Math.sqrt(sampleSize);
  }
  if (!(df > 0)) return 0;
  if (alternative === "two-sided") {
    const critical = NC.tQuantile(H, 1 - alpha / 2, df);
    return Math.min(1, NC.nctSf(H, critical, df, noncentrality) + NC.nctCdf(H, -critical, df, noncentrality));
  }
  if (alternative === "greater") return NC.nctSf(H, NC.tQuantile(H, 1 - alpha, df), df, noncentrality);
  return NC.nctCdf(H, NC.tQuantile(H, alpha, df), df, noncentrality);
}

const powerTTest = {
  method: "power_t_test",
  family: "power-analysis",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["alternative", "timeoutMs"],
  customOptions: {
    solveFor: solveForOption,
    design: enumOption(["one-sample", "two-sample", "paired"], "two-sample", "power_t_test"),
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      effectSize: { type: "number", description: "Cohen d (one-sample / two-sample) or dz (paired); omit when solving for it" },
      sampleSize: { type: "number", minimum: 2, description: "n (one-sample / paired) or n per first group (two-sample); omit when solving for it" },
      power: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
      alpha: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
      ratio: { type: "number", exclusiveMinimum: 0, maximum: 100, description: "n2 / n1 allocation ratio for two-sample designs" },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["effectSize", "sampleSize", "power", "alpha", "ratio"], "data");
    const ratio = data.ratio === undefined ? 1 : positive(H, data.ratio, "data.ratio");
    if (ratio > 100) H.fail("STAT_INVALID_INPUT", "data.ratio must not exceed 100");
    if (options.design !== "two-sample" && data.ratio !== undefined) H.fail("STAT_INVALID_INPUT", "data.ratio is only valid for the two-sample design");
    const values = parseSolveInputs(H, data, options, ["effectSize", "sampleSize", "power", "alpha"], {
      effectSize: (value, path) => {
        const number = H.finiteNumber(value, path);
        if (number === 0) H.fail("STAT_DEGENERATE", `${path} must be non-zero; power at a zero effect equals alpha`);
        if (Math.abs(number) > 20) H.fail("STAT_INVALID_INPUT", `${path} magnitude must not exceed 20`);
        if (options.alternative === "greater" && number < 0) H.fail("STAT_INVALID_INPUT", `${path} must be positive for alternative=greater`);
        if (options.alternative === "less" && number > 0) H.fail("STAT_INVALID_INPUT", `${path} must be negative for alternative=less`);
        return number;
      },
      sampleSize: (value, path) => {
        const number = positive(H, value, path);
        if (number < 2 || number > MAX_SAMPLE_SIZE) H.fail("STAT_INVALID_INPUT", `${path} must be between 2 and ${MAX_SAMPLE_SIZE}`);
        return number;
      },
      power: (value, path) => probability(H, value, path),
      alpha: (value, path) => probability(H, value, path),
    });
    return { ...values, ratio };
  },
  analyze(parsed, options, budget, H) {
    const design = options.design;
    const alternative = options.alternative;
    const minimumN = design === "two-sample" ? Math.max(2, 2 / parsed.ratio) : 2;
    const state = { effectSize: parsed.effectSize, sampleSize: parsed.sampleSize, alpha: parsed.alpha, power: parsed.power, design, ratio: parsed.ratio, alternative };
    const powerAt = (patch) => tTestPower(H, { ...state, ...patch });
    let solved = { iterations: 0, residual: 0, boundary: null };
    let solverMethod = "direct non-central t evaluation";
    if (options.solveFor === "power") {
      state.power = powerAt({});
    } else if (options.solveFor === "sampleSize") {
      solved = solveScalar(H, budget, (n) => powerAt({ sampleSize: n }), state.power, minimumN, MAX_SAMPLE_SIZE, { label: "sample size", expand: true });
      state.sampleSize = solved.value;
      solverMethod = "bisection on continuous n";
    } else if (options.solveFor === "effectSize") {
      const sign = alternative === "less" ? -1 : 1;
      solved = solveScalar(H, budget, (d) => powerAt({ effectSize: sign * d }), state.power, 1e-9, 20, { label: "effect size" });
      state.effectSize = sign * solved.value;
      solverMethod = "bisection on |d|";
    } else {
      solved = solveScalar(H, budget, (a) => powerAt({ alpha: a }), state.power, 1e-10, 1 - 1e-10, { label: "alpha" });
      state.alpha = solved.value;
      solverMethod = "bisection on alpha";
    }
    const n1 = state.sampleSize;
    const n2 = design === "two-sample" ? n1 * parsed.ratio : null;
    const df = design === "two-sample" ? n1 + n2 - 2 : n1 - 1;
    const noncentrality = design === "two-sample" ? state.effectSize * Math.sqrt(n1 * n2 / (n1 + n2)) : state.effectSize * Math.sqrt(n1);
    const ceilingN = Math.ceil(n1 - 1e-9);
    const achievedPowerAtCeiling = powerAt({ sampleSize: ceilingN });
    const status = (key) => (options.solveFor === key ? "solved" : "given");
    const inputRows = [
      { parameter: "effectSize", value: state.effectSize, status: status("effectSize"), note: design === "paired" ? "Cohen dz on paired differences" : "Cohen d (standardized mean difference)" },
      { parameter: "sampleSize", value: state.sampleSize, status: status("sampleSize"), note: design === "two-sample" ? `n per first group; second group n = ${n2}` : "n observations (pairs for paired design)" },
      { parameter: "power", value: state.power, status: status("power"), note: `1 - beta, ${alternativeSuffix(alternative)}` },
      { parameter: "alpha", value: state.alpha, status: status("alpha"), note: "type I error rate" },
    ];
    const grid = integerCurveGrid(Math.ceil(minimumN), n1);
    const curveRows = grid.map((n) => ({ sampleSize: n, power: powerAt({ sampleSize: n }), solution: n === ceilingN }));
    const [curveTable, figure] = curveArtifacts(H, curveRows, {
      xKey: "sampleSize", xLabel: design === "two-sample" ? "n per first group" : "n", targetPower: options.solveFor === "power" ? null : state.power,
      role: "power-curve", tableRole: "power-curve-table", title: `Power of the ${design} t test`,
      caption: `Power versus sample size at d = ${state.effectSize.toPrecision(4)}, alpha = ${state.alpha.toPrecision(4)}, ${alternativeSuffix(alternative)}.`,
    });
    return {
      sample: { design, sampleSize: state.sampleSize, sampleSizeCeiling: ceilingN, secondGroupSize: n2, ratio: parsed.ratio, totalSampleSize: design === "two-sample" ? n1 + n2 : n1 },
      estimates: [
        { parameter: options.solveFor, estimate: state[options.solveFor], role: "solved" },
        { parameter: "power", estimate: state.power, role: status("power") },
        { parameter: "effectSize", estimate: state.effectSize, role: status("effectSize") },
        { parameter: "sampleSize", estimate: state.sampleSize, role: status("sampleSize") },
        { parameter: "alpha", estimate: state.alpha, role: status("alpha") },
        { parameter: "sampleSizeCeiling", estimate: ceilingN, role: "derived" },
        { parameter: "achievedPowerAtCeiling", estimate: achievedPowerAtCeiling, role: "derived" },
        { parameter: "noncentrality", estimate: noncentrality, role: "derived" },
        { parameter: "degreesOfFreedom", estimate: df, role: "derived" },
      ],
      tests: [{ name: `${design} t test power`, distribution: "non-central t", df, noncentrality, alternative, alpha: state.alpha, power: state.power }],
      confidenceIntervals: [],
      effectSizes: [{ name: design === "paired" ? "Cohen dz" : "Cohen d", estimate: state.effectSize }],
      assumptions: baseAssumptions([
        { name: "normal outcome with known-form variance", status: "requires_design_review" },
        ...(design === "two-sample" ? [{ name: "equal variances (pooled t)", status: "requires_design_review", detail: "The non-central t power model assumes the pooled-variance t test; Welch power is not computed." }] : []),
      ]),
      diagnostics: [
        { name: "distribution model", status: "exact_under_model", model: "non-central t (AS 243 series)", detail: "Exact power under normality and the pooled/paired t model; the continuous sample-size solution is rounded up for planning." },
        solverDiagnostic(solved, options.solveFor, solverMethod),
      ],
      artifacts: [
        inputTable(H, inputRows, "t test power analysis", `Solved for ${options.solveFor} (${design} design, ${alternativeSuffix(alternative)}).`, "power-summary-table"),
        curveTable,
        figure,
      ],
    };
  },
  linkage: powerLinkage("one-sample, paired, or two-group mean comparison"),
  fixture: { data: { effectSize: 0.5, power: 0.8, alpha: 0.05, ratio: 1 }, options: { solveFor: "sampleSize", design: "two-sample", alternative: "two-sided" } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.location"] },
  coverage: coverageTemplate(
    "A priori, sensitivity, and criterion power for one-sample, paired, and pooled two-sample t tests (unequal allocation via ratio) using the exact non-central t distribution; one quantity solved by bisection.",
    ["power at given d, n, alpha for all three designs and alternatives", "continuous sample-size solution", "effect-size solution", "alpha solution", "non-central t cdf against scipy.stats.nct"],
    ["Welch unequal-variance power", "non-normal or robust test power", "simulation-based power"],
    ["distribution model", "solver residual and iteration count", "achieved power at the integer ceiling"],
    ["does not validate whether the supplied effect size is scientifically meaningful"],
    ["no Welch, rank-based, or cluster-adjusted power", "no simulation-based power for non-normal data"],
  ),
};

// ---------------------------------------------------------------------------------------------
// power_anova
// ---------------------------------------------------------------------------------------------

function anovaPower(H, { effectSize, sampleSize, alpha, groups }) {
  const total = groups * sampleSize;
  const df1 = groups - 1;
  const df2 = total - groups;
  if (!(df2 > 0)) return 0;
  const lambda = effectSize * effectSize * total;
  const critical = NC.fQuantile(H, 1 - alpha, df1, df2);
  return NC.ncfSf(H, critical, df1, df2, lambda);
}

const powerAnova = {
  method: "power_anova",
  family: "power-analysis",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["timeoutMs"],
  customOptions: { solveFor: solveForOption },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["groups"],
    properties: {
      effectSize: { type: "number", exclusiveMinimum: 0, description: "Cohen f; omit when solving for it" },
      groups: { type: "integer", minimum: 2, maximum: 64 },
      sampleSize: { type: "number", minimum: 2, description: "n per group (equal allocation); omit when solving for it" },
      power: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
      alpha: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["effectSize", "groups", "sampleSize", "power", "alpha"], "data");
    const groups = H.integer(data.groups, 2, H.LIMITS.maxGroups, "data.groups");
    const values = parseSolveInputs(H, data, options, ["effectSize", "sampleSize", "power", "alpha"], {
      effectSize: (value, path) => {
        const number = positive(H, value, path);
        if (number > 20) H.fail("STAT_INVALID_INPUT", `${path} must not exceed 20`);
        return number;
      },
      sampleSize: (value, path) => {
        const number = positive(H, value, path);
        if (number < 2 || number > MAX_SAMPLE_SIZE) H.fail("STAT_INVALID_INPUT", `${path} must be between 2 and ${MAX_SAMPLE_SIZE}`);
        return number;
      },
      power: (value, path) => probability(H, value, path),
      alpha: (value, path) => probability(H, value, path),
    });
    return { ...values, groups };
  },
  analyze(parsed, options, budget, H) {
    const state = { effectSize: parsed.effectSize, sampleSize: parsed.sampleSize, alpha: parsed.alpha, power: parsed.power, groups: parsed.groups };
    const powerAt = (patch) => anovaPower(H, { ...state, ...patch });
    let solved = { iterations: 0, residual: 0, boundary: null };
    let solverMethod = "direct non-central F evaluation";
    if (options.solveFor === "power") state.power = powerAt({});
    else if (options.solveFor === "sampleSize") {
      solved = solveScalar(H, budget, (n) => powerAt({ sampleSize: n }), state.power, 2, MAX_SAMPLE_SIZE / parsed.groups, { label: "sample size per group", expand: true });
      state.sampleSize = solved.value;
      solverMethod = "bisection on continuous n per group";
    } else if (options.solveFor === "effectSize") {
      solved = solveScalar(H, budget, (f) => powerAt({ effectSize: f }), state.power, 1e-9, 20, { label: "effect size" });
      state.effectSize = solved.value;
      solverMethod = "bisection on f";
    } else {
      solved = solveScalar(H, budget, (a) => powerAt({ alpha: a }), state.power, 1e-10, 1 - 1e-10, { label: "alpha" });
      state.alpha = solved.value;
      solverMethod = "bisection on alpha";
    }
    const ceilingN = Math.ceil(state.sampleSize - 1e-9);
    const total = parsed.groups * state.sampleSize;
    const df1 = parsed.groups - 1;
    const df2 = total - parsed.groups;
    const lambda = state.effectSize ** 2 * total;
    const status = (key) => (options.solveFor === key ? "solved" : "given");
    const inputRows = [
      { parameter: "effectSize", value: state.effectSize, status: status("effectSize"), note: "Cohen f = sigma_means / sigma_within" },
      { parameter: "groups", value: parsed.groups, status: "given", note: "k independent groups, equal allocation" },
      { parameter: "sampleSize", value: state.sampleSize, status: status("sampleSize"), note: `n per group; total N = ${total}` },
      { parameter: "power", value: state.power, status: status("power"), note: "1 - beta for the omnibus F test" },
      { parameter: "alpha", value: state.alpha, status: status("alpha"), note: "type I error rate" },
    ];
    const grid = integerCurveGrid(2, state.sampleSize);
    const curveRows = grid.map((n) => ({ sampleSize: n, power: powerAt({ sampleSize: n }), solution: n === ceilingN }));
    const [curveTable, figure] = curveArtifacts(H, curveRows, {
      xKey: "sampleSize", xLabel: "n per group", targetPower: options.solveFor === "power" ? null : state.power,
      role: "power-curve", tableRole: "power-curve-table", title: `Power of the one-way ANOVA F test (k = ${parsed.groups})`,
      caption: `Power versus n per group at f = ${state.effectSize.toPrecision(4)}, alpha = ${state.alpha.toPrecision(4)}.`,
    });
    return {
      sample: { groups: parsed.groups, sampleSizePerGroup: state.sampleSize, sampleSizeCeiling: ceilingN, totalSampleSize: total },
      estimates: [
        { parameter: options.solveFor, estimate: state[options.solveFor], role: "solved" },
        { parameter: "power", estimate: state.power, role: status("power") },
        { parameter: "effectSize", estimate: state.effectSize, role: status("effectSize") },
        { parameter: "sampleSize", estimate: state.sampleSize, role: status("sampleSize") },
        { parameter: "alpha", estimate: state.alpha, role: status("alpha") },
        { parameter: "sampleSizeCeiling", estimate: ceilingN, role: "derived" },
        { parameter: "achievedPowerAtCeiling", estimate: powerAt({ sampleSize: ceilingN }), role: "derived" },
        { parameter: "noncentrality", estimate: lambda, role: "derived" },
        { parameter: "numeratorDf", estimate: df1, role: "derived" },
        { parameter: "denominatorDf", estimate: df2, role: "derived" },
      ],
      tests: [{ name: "one-way ANOVA F test power", distribution: "non-central F", df1, df2, noncentrality: lambda, alpha: state.alpha, power: state.power }],
      confidenceIntervals: [],
      effectSizes: [{ name: "Cohen f", estimate: state.effectSize }, { name: "eta squared (implied)", estimate: state.effectSize ** 2 / (1 + state.effectSize ** 2) }],
      assumptions: baseAssumptions([{ name: "normal residuals with equal group variances", status: "requires_design_review" }, { name: "equal allocation across groups", status: "by_construction" }]),
      diagnostics: [
        { name: "distribution model", status: "exact_under_model", model: "non-central F (Poisson-mixture series)", detail: "lambda = f^2 * k * n, df1 = k - 1, df2 = k(n - 1)." },
        solverDiagnostic(solved, options.solveFor, solverMethod),
      ],
      artifacts: [inputTable(H, inputRows, "One-way ANOVA power analysis", `Solved for ${options.solveFor} with ${parsed.groups} groups.`, "power-summary-table"), curveTable, figure],
    };
  },
  linkage: powerLinkage("multi-group one-way ANOVA"),
  fixture: { data: { effectSize: 0.25, groups: 4, power: 0.8, alpha: 0.05 }, options: { solveFor: "sampleSize" } },
  matlabParity: { taxonomyIds: ["matlab.stats.anova"] },
  coverage: coverageTemplate(
    "Omnibus one-way fixed-effects ANOVA power for k equal-size groups from Cohen f using the exact non-central F distribution; one quantity solved by bisection.",
    ["power at given f, k, n, alpha against statsmodels FTestAnovaPower", "sample-size, effect-size, and alpha solutions", "non-central F survival function against scipy.stats.ncf"],
    ["unequal allocation", "contrast or post-hoc power", "repeated-measures or mixed ANOVA power"],
    ["distribution model", "solver residual", "achieved power at integer ceiling"],
    ["does not evaluate variance heterogeneity or non-normality effects on power"],
    ["no unequal-n, factorial, or repeated-measures designs", "no contrast-specific power"],
  ),
};

// ---------------------------------------------------------------------------------------------
// power_proportions
// ---------------------------------------------------------------------------------------------

function cohenH(p1, p2) {
  return 2 * Math.asin(Math.sqrt(p1)) - 2 * Math.asin(Math.sqrt(p2));
}

function proportionFromH(h, p2) {
  const angle = (h + 2 * Math.asin(Math.sqrt(p2))) / 2;
  const clamped = Math.min(Math.PI / 2, Math.max(0, angle));
  return Math.sin(clamped) ** 2;
}

function normalTestPower(H, effect, nobs, alpha, alternative) {
  const shift = effect * Math.sqrt(nobs);
  if (alternative === "two-sided") {
    const critical = NC.normalQuantilePrecise(H, 1 - alpha / 2);
    return Math.min(1, NC.normalCdfPrecise(H, -critical - shift) + 1 - NC.normalCdfPrecise(H, critical - shift));
  }
  const critical = NC.normalQuantilePrecise(H, 1 - alpha);
  if (alternative === "greater") return 1 - NC.normalCdfPrecise(H, critical - shift);
  return NC.normalCdfPrecise(H, -critical - shift);
}

function binomialCdf(H, k, n, p) {
  if (k < 0) return 0;
  if (k >= n) return 1;
  return H.regularizedBeta(1 - p, n - k, k + 1);
}

function exactBinomialPower(H, p0, p1, n, alpha, alternative) {
  const size = Math.round(n);
  const tailAlpha = alternative === "two-sided" ? alpha / 2 : alpha;
  let upperK = null;
  let lowerK = null;
  if (alternative !== "less") {
    // smallest k with P(X >= k | p0) <= tailAlpha
    let k = size + 1;
    for (let candidate = size; candidate >= 0; candidate -= 1) {
      if (1 - binomialCdf(H, candidate - 1, size, p0) <= tailAlpha) k = candidate;
      else break;
    }
    upperK = k;
  }
  if (alternative !== "greater") {
    let k = -1;
    for (let candidate = 0; candidate <= size; candidate += 1) {
      if (binomialCdf(H, candidate, size, p0) <= tailAlpha) k = candidate;
      else break;
    }
    lowerK = k;
  }
  let power = 0;
  if (upperK !== null && upperK <= size) power += 1 - binomialCdf(H, upperK - 1, size, p1);
  if (lowerK !== null && lowerK >= 0) power += binomialCdf(H, lowerK, size, p1);
  let actualAlpha = 0;
  if (upperK !== null && upperK <= size) actualAlpha += 1 - binomialCdf(H, upperK - 1, size, p0);
  if (lowerK !== null && lowerK >= 0) actualAlpha += binomialCdf(H, lowerK, size, p0);
  return { power: Math.min(1, power), actualAlpha, upperCritical: upperK, lowerCritical: lowerK };
}

const powerProportions = {
  method: "power_proportions",
  family: "power-analysis",
  analysisModel: { families: ["glm"], distributions: [null, "binomial", "bernoulli"], links: [null, "logit", "identity"] },
  optionKeys: ["alternative", "timeoutMs"],
  customOptions: {
    solveFor: solveForOption,
    design: enumOption(["two-sample", "one-sample"], "two-sample", "power_proportions"),
    approximation: enumOption(["arcsine", "exact-binomial"], "arcsine", "power_proportions"),
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["proportion2"],
    properties: {
      proportion1: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1, description: "alternative-hypothesis proportion; omit when solving for effect size" },
      proportion2: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1, description: "comparison proportion (two-sample) or null proportion p0 (one-sample)" },
      sampleSize: { type: "number", minimum: 2 },
      power: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
      alpha: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
      ratio: { type: "number", exclusiveMinimum: 0, maximum: 100 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["proportion1", "proportion2", "sampleSize", "power", "alpha", "ratio"], "data");
    const proportion2 = probability(H, data.proportion2, "data.proportion2");
    const ratio = data.ratio === undefined ? 1 : positive(H, data.ratio, "data.ratio");
    if (ratio > 100) H.fail("STAT_INVALID_INPUT", "data.ratio must not exceed 100");
    if (options.design === "one-sample" && data.ratio !== undefined) H.fail("STAT_INVALID_INPUT", "data.ratio is only valid for the two-sample design");
    if (options.approximation === "exact-binomial") {
      if (options.design !== "one-sample") H.fail("STAT_INVALID_INPUT", "exact-binomial power is only implemented for the one-sample design");
      if (!["power", "sampleSize"].includes(options.solveFor)) H.fail("STAT_INVALID_INPUT", "exact-binomial power can only solve for power or sampleSize");
    }
    const mapped = { ...data };
    delete mapped.proportion1;
    if (data.proportion1 !== undefined) mapped.effectSize = data.proportion1;
    const values = parseSolveInputs(H, mapped, options, ["effectSize", "sampleSize", "power", "alpha"], {
      effectSize: (value) => {
        const proportion1 = probability(H, value, "data.proportion1");
        if (proportion1 === proportion2) H.fail("STAT_DEGENERATE", "data.proportion1 equals data.proportion2; power at a zero effect equals alpha");
        const h = cohenH(proportion1, proportion2);
        if (options.alternative === "greater" && h < 0) H.fail("STAT_INVALID_INPUT", "proportion1 must exceed proportion2 for alternative=greater");
        if (options.alternative === "less" && h > 0) H.fail("STAT_INVALID_INPUT", "proportion1 must be below proportion2 for alternative=less");
        return proportion1;
      },
      sampleSize: (value, path) => {
        const number = positive(H, value, path);
        if (number < 2 || number > MAX_SAMPLE_SIZE) H.fail("STAT_INVALID_INPUT", `${path} must be between 2 and ${MAX_SAMPLE_SIZE}`);
        if (options.approximation === "exact-binomial" && (!Number.isInteger(number) || number > 200000)) H.fail("STAT_INVALID_INPUT", `${path} must be an integer <= 200000 for exact-binomial power`);
        return number;
      },
      power: (value, path) => probability(H, value, path),
      alpha: (value, path) => probability(H, value, path),
    });
    const proportion1 = values.effectSize;
    return { proportion1, proportion2, sampleSize: values.sampleSize, power: values.power, alpha: values.alpha, ratio };
  },
  analyze(parsed, options, budget, H) {
    const { design, alternative, approximation } = options;
    const nobsFor = (n) => (design === "two-sample" ? 1 / (1 / n + 1 / (n * parsed.ratio)) : n);
    const state = { effectSize: parsed.proportion1 === null ? null : cohenH(parsed.proportion1, parsed.proportion2), sampleSize: parsed.sampleSize, power: parsed.power, alpha: parsed.alpha, proportion1: parsed.proportion1 };
    let exact = null;
    let solved = { iterations: 0, residual: 0, boundary: null };
    let solverMethod = "direct normal evaluation";
    const powerAt = (patch) => {
      const merged = { ...state, ...patch };
      if (approximation === "exact-binomial") return exactBinomialPower(H, parsed.proportion2, merged.proportion1, merged.sampleSize, merged.alpha, alternative).power;
      return normalTestPower(H, merged.effectSize, nobsFor(merged.sampleSize), merged.alpha, alternative);
    };
    const minimumN = design === "two-sample" ? Math.max(2, 2 / parsed.ratio) : 2;
    if (options.solveFor === "power") {
      state.power = powerAt({});
      solverMethod = approximation === "exact-binomial" ? "direct exact binomial evaluation" : solverMethod;
    } else if (options.solveFor === "sampleSize") {
      if (approximation === "exact-binomial") {
        let found = null;
        for (let n = 2; n <= 200000; n += 1) {
          budget.check(4);
          if (powerAt({ sampleSize: n }) >= state.power) { found = n; break; }
        }
        if (found === null) H.fail("STAT_NON_CONVERGENCE", "exact-binomial sample-size search exceeded n = 200000 without reaching the target power");
        state.sampleSize = found;
        solverMethod = "ascending integer search (exact binomial power is not monotone in n; the first n reaching the target is reported)";
      } else {
        solved = solveScalar(H, budget, (n) => powerAt({ sampleSize: n }), state.power, minimumN, MAX_SAMPLE_SIZE, { label: "sample size", expand: true });
        state.sampleSize = solved.value;
        solverMethod = "bisection on continuous n";
      }
    } else if (options.solveFor === "effectSize") {
      const sign = alternative === "less" ? -1 : 1;
      solved = solveScalar(H, budget, (h) => powerAt({ effectSize: sign * h }), state.power, 1e-9, Math.PI, { label: "effect size h" });
      state.effectSize = sign * solved.value;
      state.proportion1 = proportionFromH(state.effectSize, parsed.proportion2);
      solverMethod = "bisection on |h|, then back-transformed to proportion1";
    } else {
      solved = solveScalar(H, budget, (a) => powerAt({ alpha: a }), state.power, 1e-10, 1 - 1e-10, { label: "alpha" });
      state.alpha = solved.value;
      solverMethod = "bisection on alpha";
    }
    if (approximation === "exact-binomial") exact = exactBinomialPower(H, parsed.proportion2, state.proportion1, state.sampleSize, state.alpha, alternative);
    const ceilingN = Math.ceil(state.sampleSize - 1e-9);
    const status = (key) => (options.solveFor === key ? "solved" : "given");
    const inputRows = [
      { parameter: "proportion1", value: state.proportion1, status: options.solveFor === "effectSize" ? "solved" : "given", note: design === "one-sample" ? "alternative proportion" : "first-group proportion" },
      { parameter: "proportion2", value: parsed.proportion2, status: "given", note: design === "one-sample" ? "null proportion p0" : "second-group proportion" },
      { parameter: "effectSize", value: state.effectSize, status: status("effectSize"), note: "Cohen h = 2 asin(sqrt p1) - 2 asin(sqrt p2)" },
      { parameter: "sampleSize", value: state.sampleSize, status: status("sampleSize"), note: design === "two-sample" ? `n per first group; second group n = ${state.sampleSize * parsed.ratio}` : "n trials" },
      { parameter: "power", value: state.power, status: status("power"), note: `${approximation}, ${alternativeSuffix(alternative)}` },
      { parameter: "alpha", value: state.alpha, status: status("alpha"), note: exact ? `nominal; actual exact alpha = ${exact.actualAlpha.toPrecision(4)}` : "type I error rate" },
    ];
    const grid = integerCurveGrid(Math.ceil(minimumN), state.sampleSize);
    const curveRows = grid.map((n) => ({ sampleSize: n, power: powerAt({ sampleSize: n }), solution: n === ceilingN }));
    const [curveTable, figure] = curveArtifacts(H, curveRows, {
      xKey: "sampleSize", xLabel: design === "two-sample" ? "n per first group" : "n", targetPower: options.solveFor === "power" ? null : state.power,
      role: "power-curve", tableRole: "power-curve-table", title: `Power for ${design} proportions (${approximation})`,
      caption: `Power versus sample size at h = ${state.effectSize.toPrecision(4)}, alpha = ${state.alpha.toPrecision(4)}, ${alternativeSuffix(alternative)}.`,
    });
    return {
      sample: { design, approximation, sampleSize: state.sampleSize, sampleSizeCeiling: ceilingN, ratio: parsed.ratio, effectiveSampleSize: nobsFor(state.sampleSize) },
      estimates: [
        { parameter: options.solveFor, estimate: state[options.solveFor], role: "solved" },
        { parameter: "power", estimate: state.power, role: status("power") },
        { parameter: "effectSize", estimate: state.effectSize, role: status("effectSize") },
        { parameter: "proportion1", estimate: state.proportion1, role: options.solveFor === "effectSize" ? "solved" : "given" },
        { parameter: "proportion2", estimate: parsed.proportion2, role: "given" },
        { parameter: "sampleSize", estimate: state.sampleSize, role: status("sampleSize") },
        { parameter: "alpha", estimate: state.alpha, role: status("alpha") },
        { parameter: "sampleSizeCeiling", estimate: ceilingN, role: "derived" },
        { parameter: "achievedPowerAtCeiling", estimate: powerAt({ sampleSize: ceilingN }), role: "derived" },
        ...(exact ? [
          { parameter: "actualAlpha", estimate: exact.actualAlpha, role: "derived" },
          { parameter: "upperCriticalCount", estimate: exact.upperCritical, role: "derived" },
          { parameter: "lowerCriticalCount", estimate: exact.lowerCritical, role: "derived" },
        ] : []),
      ],
      tests: [{ name: `${design} proportion test power`, distribution: approximation === "arcsine" ? "normal (arcsine-transformed)" : "exact binomial", alternative, alpha: state.alpha, power: state.power }],
      confidenceIntervals: [],
      effectSizes: [{ name: "Cohen h", estimate: state.effectSize }, { name: "risk difference", estimate: state.proportion1 - parsed.proportion2 }],
      assumptions: baseAssumptions([
        approximation === "arcsine"
          ? { name: "normal approximation on the arcsine scale", status: "asymptotic", detail: "Variance-stabilizing transform; accuracy degrades for very small n or proportions near 0 or 1." }
          : { name: "exact binomial sampling", status: "exact_under_model", detail: "Rejection region built from the null binomial at the nominal alpha (alpha/2 per tail for two-sided), so actual alpha is at most nominal." },
      ]),
      diagnostics: [
        { name: "distribution model", status: approximation === "arcsine" ? "asymptotic" : "exact_under_model", model: approximation === "arcsine" ? "z test on Cohen h" : "binomial with conservative critical region" },
        solverDiagnostic(solved, options.solveFor, solverMethod),
      ],
      artifacts: [inputTable(H, inputRows, "Proportion power analysis", `Solved for ${options.solveFor} (${design}, ${approximation}).`, "power-summary-table"), curveTable, figure],
    };
  },
  linkage: powerLinkage("comparison of proportions or event rates"),
  fixture: { data: { proportion1: 0.65, proportion2: 0.5, power: 0.8, alpha: 0.05 }, options: { solveFor: "sampleSize", design: "two-sample", alternative: "two-sided" } },
  matlabParity: { taxonomyIds: ["matlab.stats.probability-hypothesis"] },
  coverage: coverageTemplate(
    "Power for two independent proportions (Cohen h, arcsine normal approximation, allocation ratio) and one-sample proportions (arcsine or conservative exact binomial); one quantity solved by bisection or integer search.",
    ["arcsine power against statsmodels NormalIndPower", "sample-size, effect-size, and alpha solutions", "exact binomial power and critical counts against scipy.stats.binom"],
    ["continuity-corrected or Fisher exact power", "two-sample exact power", "non-inferiority margins"],
    ["distribution model", "solver method and residual", "actual alpha under the exact binomial region"],
    ["arcsine approximation accuracy is not checked against exact two-sample enumeration"],
    ["no two-sample exact or continuity-corrected power", "no non-inferiority or equivalence power"],
  ),
};

// ---------------------------------------------------------------------------------------------
// power_correlation
// ---------------------------------------------------------------------------------------------

function correlationPower(H, { correlation, sampleSize, alpha, alternative, approximation }) {
  const n = sampleSize;
  if (!(n > 3)) return 0;
  if (approximation === "fisher-z") {
    const shift = Math.atanh(correlation) * Math.sqrt(n - 3);
    if (alternative === "two-sided") {
      const critical = NC.normalQuantilePrecise(H, 1 - alpha / 2);
      return Math.min(1, NC.normalCdfPrecise(H, -critical - shift) + 1 - NC.normalCdfPrecise(H, critical - shift));
    }
    const critical = NC.normalQuantilePrecise(H, 1 - alpha);
    if (alternative === "greater") return 1 - NC.normalCdfPrecise(H, critical - shift);
    return NC.normalCdfPrecise(H, -critical - shift);
  }
  const tside = alternative === "two-sided" ? 2 : 1;
  const ttt = NC.tQuantile(H, 1 - alpha / tside, n - 2);
  const rc = Math.sqrt(ttt * ttt / (ttt * ttt + n - 2));
  const zr = Math.atanh(correlation) + correlation / (2 * (n - 1));
  const zrc = Math.atanh(rc);
  if (alternative === "two-sided") return Math.min(1, NC.normalCdfPrecise(H, (zr - zrc) * Math.sqrt(n - 3)) + NC.normalCdfPrecise(H, (-zr - zrc) * Math.sqrt(n - 3)));
  if (alternative === "greater") return NC.normalCdfPrecise(H, (zr - zrc) * Math.sqrt(n - 3));
  return NC.normalCdfPrecise(H, (-zr - zrc) * Math.sqrt(n - 3));
}

const powerCorrelation = {
  method: "power_correlation",
  family: "power-analysis",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["alternative", "timeoutMs"],
  customOptions: {
    solveFor: solveForOption,
    approximation: enumOption(["fisher-z", "pwr-r"], "fisher-z", "power_correlation"),
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      correlation: { type: "number", exclusiveMinimum: -1, exclusiveMaximum: 1, description: "population Pearson correlation under the alternative; omit when solving for effect size" },
      sampleSize: { type: "number", minimum: 4 },
      power: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
      alpha: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["correlation", "sampleSize", "power", "alpha"], "data");
    const mapped = { ...data };
    if (data.correlation !== undefined) { mapped.effectSize = data.correlation; delete mapped.correlation; }
    const values = parseSolveInputs(H, mapped, options, ["effectSize", "sampleSize", "power", "alpha"], {
      effectSize: (value) => {
        const number = H.finiteNumber(value, "data.correlation");
        if (number <= -1 || number >= 1) H.fail("STAT_INVALID_INPUT", "data.correlation must be strictly inside (-1, 1)");
        if (number === 0) H.fail("STAT_DEGENERATE", "data.correlation must be non-zero; power at a zero effect equals alpha");
        if (options.alternative === "greater" && number < 0) H.fail("STAT_INVALID_INPUT", "data.correlation must be positive for alternative=greater");
        if (options.alternative === "less" && number > 0) H.fail("STAT_INVALID_INPUT", "data.correlation must be negative for alternative=less");
        return number;
      },
      sampleSize: (value, path) => {
        const number = positive(H, value, path);
        if (number < 4 || number > MAX_SAMPLE_SIZE) H.fail("STAT_INVALID_INPUT", `${path} must be between 4 and ${MAX_SAMPLE_SIZE}`);
        return number;
      },
      power: (value, path) => probability(H, value, path),
      alpha: (value, path) => probability(H, value, path),
    });
    return { correlation: values.effectSize, sampleSize: values.sampleSize, power: values.power, alpha: values.alpha };
  },
  analyze(parsed, options, budget, H) {
    const { alternative, approximation } = options;
    const state = { correlation: parsed.correlation, sampleSize: parsed.sampleSize, power: parsed.power, alpha: parsed.alpha, alternative, approximation };
    const powerAt = (patch) => correlationPower(H, { ...state, ...patch });
    let solved = { iterations: 0, residual: 0, boundary: null };
    let solverMethod = "direct evaluation";
    if (options.solveFor === "power") state.power = powerAt({});
    else if (options.solveFor === "sampleSize") {
      solved = solveScalar(H, budget, (n) => powerAt({ sampleSize: n }), state.power, 4, MAX_SAMPLE_SIZE, { label: "sample size", expand: true });
      state.sampleSize = solved.value;
      solverMethod = "bisection on continuous n";
    } else if (options.solveFor === "effectSize") {
      const sign = alternative === "less" ? -1 : 1;
      solved = solveScalar(H, budget, (r) => powerAt({ correlation: sign * r }), state.power, 1e-9, 1 - 1e-9, { label: "correlation" });
      state.correlation = sign * solved.value;
      solverMethod = "bisection on |r|";
    } else {
      solved = solveScalar(H, budget, (a) => powerAt({ alpha: a }), state.power, 1e-10, 1 - 1e-10, { label: "alpha" });
      state.alpha = solved.value;
      solverMethod = "bisection on alpha";
    }
    const ceilingN = Math.ceil(state.sampleSize - 1e-9);
    const status = (key) => (options.solveFor === key ? "solved" : "given");
    const inputRows = [
      { parameter: "correlation", value: state.correlation, status: status("effectSize"), note: "population Pearson r under H1" },
      { parameter: "sampleSize", value: state.sampleSize, status: status("sampleSize"), note: "paired observations" },
      { parameter: "power", value: state.power, status: status("power"), note: `${approximation}, ${alternativeSuffix(alternative)}` },
      { parameter: "alpha", value: state.alpha, status: status("alpha"), note: "type I error rate" },
    ];
    const grid = integerCurveGrid(4, state.sampleSize);
    const curveRows = grid.map((n) => ({ sampleSize: n, power: powerAt({ sampleSize: n }), solution: n === ceilingN }));
    const [curveTable, figure] = curveArtifacts(H, curveRows, {
      xKey: "sampleSize", xLabel: "n pairs", targetPower: options.solveFor === "power" ? null : state.power,
      role: "power-curve", tableRole: "power-curve-table", title: "Power for a Pearson correlation test",
      caption: `Power versus n at r = ${state.correlation.toPrecision(4)}, alpha = ${state.alpha.toPrecision(4)}, ${alternativeSuffix(alternative)} (${approximation}).`,
    });
    return {
      sample: { sampleSize: state.sampleSize, sampleSizeCeiling: ceilingN },
      estimates: [
        { parameter: options.solveFor, estimate: options.solveFor === "effectSize" ? state.correlation : state[options.solveFor], role: "solved" },
        { parameter: "power", estimate: state.power, role: status("power") },
        { parameter: "correlation", estimate: state.correlation, role: status("effectSize") },
        { parameter: "fisherZ", estimate: Math.atanh(state.correlation), role: "derived" },
        { parameter: "sampleSize", estimate: state.sampleSize, role: status("sampleSize") },
        { parameter: "alpha", estimate: state.alpha, role: status("alpha") },
        { parameter: "sampleSizeCeiling", estimate: ceilingN, role: "derived" },
        { parameter: "achievedPowerAtCeiling", estimate: powerAt({ sampleSize: ceilingN }), role: "derived" },
      ],
      tests: [{ name: "Pearson correlation test power", distribution: approximation === "fisher-z" ? "normal on Fisher z" : "normal on bias-adjusted Fisher z with t critical", alternative, alpha: state.alpha, power: state.power }],
      confidenceIntervals: [],
      effectSizes: [{ name: "Pearson r", estimate: state.correlation }, { name: "Fisher z", estimate: Math.atanh(state.correlation) }],
      assumptions: baseAssumptions([{ name: "bivariate normality", status: "requires_design_review" }, { name: "Fisher z normal approximation", status: "asymptotic", detail: "SE = 1/sqrt(n - 3); the approximation is inaccurate for very small n." }]),
      diagnostics: [
        { name: "distribution model", status: "asymptotic", model: approximation === "fisher-z" ? "z = atanh(r) sqrt(n - 3) versus normal critical" : "pwr.r.test form: bias-adjusted z with t-derived critical correlation" },
        solverDiagnostic(solved, options.solveFor, solverMethod),
      ],
      artifacts: [inputTable(H, inputRows, "Correlation power analysis", `Solved for ${options.solveFor} (${approximation}).`, "power-summary-table"), curveTable, figure],
    };
  },
  linkage: powerLinkage("test of a Pearson correlation"),
  fixture: { data: { correlation: 0.3, power: 0.8, alpha: 0.05 }, options: { solveFor: "sampleSize", alternative: "two-sided" } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.linear"] },
  coverage: coverageTemplate(
    "Power for testing a Pearson correlation against zero via the Fisher z normal approximation (default) or the pwr.r.test bias-adjusted form; one quantity solved by bisection.",
    ["Fisher z power against a first-principles scipy computation", "pwr-r form power against a first-principles scipy computation", "sample-size, correlation, and alpha solutions"],
    ["exact power from the sampling distribution of r", "power for comparing two correlations or for partial correlations"],
    ["distribution model", "solver residual"],
    ["approximation error for n < 10 is not quantified"],
    ["no exact-distribution power", "no two-correlation or rank-correlation power"],
  ),
};

// ---------------------------------------------------------------------------------------------
// power_chi_square
// ---------------------------------------------------------------------------------------------

function chiSquarePower(H, { effectSize, sampleSize, alpha, df }) {
  const lambda = effectSize * effectSize * sampleSize;
  const critical = NC.chiSquareQuantile(H, 1 - alpha, df);
  return NC.ncx2Sf(H, critical, df, lambda);
}

const powerChiSquare = {
  method: "power_chi_square",
  family: "power-analysis",
  analysisModel: { families: ["glm"], distributions: [null, "multinomial", "binomial"], links: [null, "logit", "log"] },
  optionKeys: ["timeoutMs"],
  customOptions: { solveFor: solveForOption },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["df"],
    properties: {
      effectSize: { type: "number", exclusiveMinimum: 0, description: "Cohen w; omit when solving for it" },
      df: { type: "integer", minimum: 1, maximum: 10000 },
      sampleSize: { type: "number", minimum: 2, description: "total N; omit when solving for it" },
      power: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
      alpha: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["effectSize", "df", "sampleSize", "power", "alpha"], "data");
    const df = H.integer(data.df, 1, 10000, "data.df");
    const values = parseSolveInputs(H, data, options, ["effectSize", "sampleSize", "power", "alpha"], {
      effectSize: (value, path) => {
        const number = positive(H, value, path);
        if (number > 20) H.fail("STAT_INVALID_INPUT", `${path} must not exceed 20`);
        return number;
      },
      sampleSize: (value, path) => {
        const number = positive(H, value, path);
        if (number < 2 || number > MAX_SAMPLE_SIZE) H.fail("STAT_INVALID_INPUT", `${path} must be between 2 and ${MAX_SAMPLE_SIZE}`);
        return number;
      },
      power: (value, path) => probability(H, value, path),
      alpha: (value, path) => probability(H, value, path),
    });
    return { ...values, df };
  },
  analyze(parsed, options, budget, H) {
    const state = { effectSize: parsed.effectSize, sampleSize: parsed.sampleSize, power: parsed.power, alpha: parsed.alpha, df: parsed.df };
    const powerAt = (patch) => chiSquarePower(H, { ...state, ...patch });
    let solved = { iterations: 0, residual: 0, boundary: null };
    let solverMethod = "direct non-central chi-square evaluation";
    if (options.solveFor === "power") state.power = powerAt({});
    else if (options.solveFor === "sampleSize") {
      solved = solveScalar(H, budget, (n) => powerAt({ sampleSize: n }), state.power, 2, MAX_SAMPLE_SIZE, { label: "sample size", expand: true });
      state.sampleSize = solved.value;
      solverMethod = "bisection on continuous N";
    } else if (options.solveFor === "effectSize") {
      solved = solveScalar(H, budget, (w) => powerAt({ effectSize: w }), state.power, 1e-9, 20, { label: "effect size" });
      state.effectSize = solved.value;
      solverMethod = "bisection on w";
    } else {
      solved = solveScalar(H, budget, (a) => powerAt({ alpha: a }), state.power, 1e-10, 1 - 1e-10, { label: "alpha" });
      state.alpha = solved.value;
      solverMethod = "bisection on alpha";
    }
    const ceilingN = Math.ceil(state.sampleSize - 1e-9);
    const lambda = state.effectSize ** 2 * state.sampleSize;
    const status = (key) => (options.solveFor === key ? "solved" : "given");
    const inputRows = [
      { parameter: "effectSize", value: state.effectSize, status: status("effectSize"), note: "Cohen w = sqrt(sum (p1 - p0)^2 / p0)" },
      { parameter: "df", value: parsed.df, status: "given", note: "chi-square degrees of freedom" },
      { parameter: "sampleSize", value: state.sampleSize, status: status("sampleSize"), note: "total N" },
      { parameter: "power", value: state.power, status: status("power"), note: "1 - beta" },
      { parameter: "alpha", value: state.alpha, status: status("alpha"), note: "type I error rate" },
    ];
    const grid = integerCurveGrid(2, state.sampleSize);
    const curveRows = grid.map((n) => ({ sampleSize: n, power: powerAt({ sampleSize: n }), solution: n === ceilingN }));
    const [curveTable, figure] = curveArtifacts(H, curveRows, {
      xKey: "sampleSize", xLabel: "total N", targetPower: options.solveFor === "power" ? null : state.power,
      role: "power-curve", tableRole: "power-curve-table", title: `Power of the chi-square test (df = ${parsed.df})`,
      caption: `Power versus N at w = ${state.effectSize.toPrecision(4)}, alpha = ${state.alpha.toPrecision(4)}.`,
    });
    return {
      sample: { sampleSize: state.sampleSize, sampleSizeCeiling: ceilingN, df: parsed.df },
      estimates: [
        { parameter: options.solveFor, estimate: state[options.solveFor], role: "solved" },
        { parameter: "power", estimate: state.power, role: status("power") },
        { parameter: "effectSize", estimate: state.effectSize, role: status("effectSize") },
        { parameter: "sampleSize", estimate: state.sampleSize, role: status("sampleSize") },
        { parameter: "alpha", estimate: state.alpha, role: status("alpha") },
        { parameter: "sampleSizeCeiling", estimate: ceilingN, role: "derived" },
        { parameter: "achievedPowerAtCeiling", estimate: powerAt({ sampleSize: ceilingN }), role: "derived" },
        { parameter: "noncentrality", estimate: lambda, role: "derived" },
      ],
      tests: [{ name: "chi-square test power", distribution: "non-central chi-square", df: parsed.df, noncentrality: lambda, alpha: state.alpha, power: state.power }],
      confidenceIntervals: [],
      effectSizes: [{ name: "Cohen w", estimate: state.effectSize }],
      assumptions: baseAssumptions([{ name: "expected cell counts adequate for the chi-square approximation", status: "requires_design_review" }]),
      diagnostics: [
        { name: "distribution model", status: "asymptotic", model: "non-central chi-square (Poisson-mixture series)", detail: "lambda = w^2 N; the chi-square reference itself is a large-sample approximation." },
        solverDiagnostic(solved, options.solveFor, solverMethod),
      ],
      artifacts: [inputTable(H, inputRows, "Chi-square power analysis", `Solved for ${options.solveFor} with df = ${parsed.df}.`, "power-summary-table"), curveTable, figure],
    };
  },
  linkage: powerLinkage("goodness-of-fit or contingency-table chi-square test"),
  fixture: { data: { effectSize: 0.3, df: 2, power: 0.8, alpha: 0.05 }, options: { solveFor: "sampleSize" } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.distribution"] },
  coverage: coverageTemplate(
    "Power for chi-square goodness-of-fit and contingency tests from Cohen w and df using the non-central chi-square distribution; one quantity solved by bisection.",
    ["power against statsmodels GofChisquarePower", "sample-size, effect-size, and alpha solutions", "non-central chi-square survival function against scipy.stats.ncx2"],
    ["exact multinomial power", "power for Fisher exact or likelihood-ratio tests"],
    ["distribution model", "solver residual"],
    ["small expected-count adequacy is not evaluated"],
    ["no exact or simulation-based power for sparse tables"],
  ),
};

// ---------------------------------------------------------------------------------------------
// power_regression
// ---------------------------------------------------------------------------------------------

function regressionPower(H, { effectSize, sampleSize, alpha, numeratorDf, predictors, convention }) {
  const v = sampleSize - predictors - 1;
  if (!(v > 0)) return 0;
  const lambda = convention === "cohen" ? effectSize * (numeratorDf + v + 1) : effectSize * sampleSize;
  const critical = NC.fQuantile(H, 1 - alpha, numeratorDf, v);
  return NC.ncfSf(H, critical, numeratorDf, v, lambda);
}

const powerRegression = {
  method: "power_regression",
  family: "power-analysis",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["timeoutMs"],
  customOptions: {
    solveFor: solveForOption,
    noncentrality: enumOption(["cohen", "total-n"], "cohen", "power_regression"),
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["numeratorDf", "predictors"],
    properties: {
      effectSize: { type: "number", exclusiveMinimum: 0, description: "Cohen f^2 = (R2_full - R2_reduced) / (1 - R2_full); omit when solving for it" },
      numeratorDf: { type: "integer", minimum: 1, maximum: 1000, description: "number of predictors tested (u)" },
      predictors: { type: "integer", minimum: 1, maximum: 1000, description: "total predictors in the full model (>= numeratorDf)" },
      sampleSize: { type: "number", minimum: 3, description: "total N; omit when solving for it" },
      power: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
      alpha: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["effectSize", "numeratorDf", "predictors", "sampleSize", "power", "alpha"], "data");
    const numeratorDf = H.integer(data.numeratorDf, 1, 1000, "data.numeratorDf");
    const predictors = H.integer(data.predictors, 1, 1000, "data.predictors");
    if (predictors < numeratorDf) H.fail("STAT_INVALID_INPUT", "data.predictors must be at least data.numeratorDf");
    const values = parseSolveInputs(H, data, options, ["effectSize", "sampleSize", "power", "alpha"], {
      effectSize: (value, path) => {
        const number = positive(H, value, path);
        if (number > 100) H.fail("STAT_INVALID_INPUT", `${path} must not exceed 100`);
        return number;
      },
      sampleSize: (value, path) => {
        const number = positive(H, value, path);
        if (number <= predictors + 1 || number > MAX_SAMPLE_SIZE) H.fail("STAT_INVALID_INPUT", `${path} must exceed predictors + 1 and be at most ${MAX_SAMPLE_SIZE}`);
        return number;
      },
      power: (value, path) => probability(H, value, path),
      alpha: (value, path) => probability(H, value, path),
    });
    return { ...values, numeratorDf, predictors };
  },
  analyze(parsed, options, budget, H) {
    const convention = options.noncentrality;
    const state = { effectSize: parsed.effectSize, sampleSize: parsed.sampleSize, power: parsed.power, alpha: parsed.alpha, numeratorDf: parsed.numeratorDf, predictors: parsed.predictors, convention };
    const powerAt = (patch) => regressionPower(H, { ...state, ...patch });
    const minimumN = parsed.predictors + 2;
    let solved = { iterations: 0, residual: 0, boundary: null };
    let solverMethod = "direct non-central F evaluation";
    if (options.solveFor === "power") state.power = powerAt({});
    else if (options.solveFor === "sampleSize") {
      solved = solveScalar(H, budget, (n) => powerAt({ sampleSize: n }), state.power, minimumN, MAX_SAMPLE_SIZE, { label: "sample size", expand: true });
      state.sampleSize = solved.value;
      solverMethod = "bisection on continuous N";
    } else if (options.solveFor === "effectSize") {
      solved = solveScalar(H, budget, (f2) => powerAt({ effectSize: f2 }), state.power, 1e-10, 100, { label: "effect size" });
      state.effectSize = solved.value;
      solverMethod = "bisection on f^2";
    } else {
      solved = solveScalar(H, budget, (a) => powerAt({ alpha: a }), state.power, 1e-10, 1 - 1e-10, { label: "alpha" });
      state.alpha = solved.value;
      solverMethod = "bisection on alpha";
    }
    const ceilingN = Math.ceil(state.sampleSize - 1e-9);
    const v = state.sampleSize - parsed.predictors - 1;
    const lambda = convention === "cohen" ? state.effectSize * (parsed.numeratorDf + v + 1) : state.effectSize * state.sampleSize;
    const status = (key) => (options.solveFor === key ? "solved" : "given");
    const inputRows = [
      { parameter: "effectSize", value: state.effectSize, status: status("effectSize"), note: "Cohen f^2 for the tested R^2 increment" },
      { parameter: "numeratorDf", value: parsed.numeratorDf, status: "given", note: "u = predictors tested" },
      { parameter: "predictors", value: parsed.predictors, status: "given", note: "total predictors in the full model" },
      { parameter: "sampleSize", value: state.sampleSize, status: status("sampleSize"), note: `total N; v = N - p - 1 = ${v}` },
      { parameter: "power", value: state.power, status: status("power"), note: `noncentrality convention: ${convention === "cohen" ? "f^2 (u + v + 1)" : "f^2 N"}` },
      { parameter: "alpha", value: state.alpha, status: status("alpha"), note: "type I error rate" },
    ];
    const grid = integerCurveGrid(minimumN, state.sampleSize);
    const curveRows = grid.map((n) => ({ sampleSize: n, power: powerAt({ sampleSize: n }), solution: n === ceilingN }));
    const [curveTable, figure] = curveArtifacts(H, curveRows, {
      xKey: "sampleSize", xLabel: "total N", targetPower: options.solveFor === "power" ? null : state.power,
      role: "power-curve", tableRole: "power-curve-table", title: `Power of the R-squared change F test (u = ${parsed.numeratorDf})`,
      caption: `Power versus N at f^2 = ${state.effectSize.toPrecision(4)}, alpha = ${state.alpha.toPrecision(4)}.`,
    });
    return {
      sample: { sampleSize: state.sampleSize, sampleSizeCeiling: ceilingN, numeratorDf: parsed.numeratorDf, denominatorDf: v, predictors: parsed.predictors },
      estimates: [
        { parameter: options.solveFor, estimate: state[options.solveFor], role: "solved" },
        { parameter: "power", estimate: state.power, role: status("power") },
        { parameter: "effectSize", estimate: state.effectSize, role: status("effectSize") },
        { parameter: "sampleSize", estimate: state.sampleSize, role: status("sampleSize") },
        { parameter: "alpha", estimate: state.alpha, role: status("alpha") },
        { parameter: "sampleSizeCeiling", estimate: ceilingN, role: "derived" },
        { parameter: "achievedPowerAtCeiling", estimate: powerAt({ sampleSize: ceilingN }), role: "derived" },
        { parameter: "noncentrality", estimate: lambda, role: "derived" },
        { parameter: "numeratorDf", estimate: parsed.numeratorDf, role: "given" },
        { parameter: "denominatorDf", estimate: v, role: "derived" },
      ],
      tests: [{ name: "R-squared change F test power", distribution: "non-central F", df1: parsed.numeratorDf, df2: v, noncentrality: lambda, alpha: state.alpha, power: state.power }],
      confidenceIntervals: [],
      effectSizes: [{ name: "Cohen f squared", estimate: state.effectSize }, { name: "R-squared increment (implied at R2_full unknown)", estimate: state.effectSize / (1 + state.effectSize) }],
      assumptions: baseAssumptions([{ name: "fixed predictors with normal homoscedastic errors", status: "requires_design_review" }]),
      diagnostics: [
        { name: "distribution model", status: "exact_under_model", model: "non-central F (Poisson-mixture series)", detail: convention === "cohen" ? "lambda = f^2 (u + v + 1) as in Cohen (1988) and pwr::pwr.f2.test" : "lambda = f^2 N as in G*Power fixed-model R^2 increase" },
        solverDiagnostic(solved, options.solveFor, solverMethod),
      ],
      artifacts: [inputTable(H, inputRows, "Regression F test power analysis", `Solved for ${options.solveFor}.`, "power-summary-table"), curveTable, figure],
    };
  },
  linkage: powerLinkage("multiple regression R-squared increment test"),
  fixture: { data: { effectSize: 0.15, numeratorDf: 3, predictors: 5, power: 0.8, alpha: 0.05 }, options: { solveFor: "sampleSize" } },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: coverageTemplate(
    "Power for the fixed-predictor F test of an R-squared increment (Cohen f^2) with both the Cohen/pwr and total-N noncentrality conventions using the non-central F distribution; one quantity solved by bisection.",
    ["power against scipy.stats.ncf with both noncentrality conventions", "power against statsmodels FTestPowerF2 where the convention matches", "sample-size, effect-size, and alpha solutions"],
    ["random-predictor (conditional) regression power", "logistic or mixed-model regression power"],
    ["distribution model with the noncentrality convention stated", "solver residual"],
    ["does not evaluate multicollinearity effects on the achievable f^2"],
    ["no random-X, GLM, or hierarchical-model power"],
  ),
};

// ---------------------------------------------------------------------------------------------
// sample_size_precision
// ---------------------------------------------------------------------------------------------

const sampleSizePrecision = {
  method: "sample_size_precision",
  family: "power-analysis",
  analysisModel: { families: ["lm", "glm"], distributions: [null, "normal", "gaussian", "binomial"], links: [null, "identity", "logit"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    target: enumOption(["mean", "proportion"], "mean", "sample_size_precision"),
    intervalMethod: enumOption(["normal", "t"], "normal", "sample_size_precision"),
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["halfWidth"],
    properties: {
      halfWidth: { type: "number", exclusiveMinimum: 0, description: "desired confidence-interval half-width (margin of error)" },
      standardDeviation: { type: "number", exclusiveMinimum: 0, description: "anticipated SD (target = mean)" },
      proportion: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1, description: "anticipated proportion (target = proportion); defaults to 0.5" },
      populationSize: { type: "integer", minimum: 2, description: "optional finite population for the FPC" },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["halfWidth", "standardDeviation", "proportion", "populationSize"], "data");
    const halfWidth = positive(H, data.halfWidth, "data.halfWidth");
    let standardDeviation = null;
    let proportion = null;
    if (options.target === "mean") {
      if (data.proportion !== undefined) H.fail("STAT_INVALID_INPUT", "data.proportion is only valid for target=proportion");
      if (data.standardDeviation === undefined) H.fail("STAT_INVALID_INPUT", "data.standardDeviation is required for target=mean");
      standardDeviation = positive(H, data.standardDeviation, "data.standardDeviation");
    } else {
      if (data.standardDeviation !== undefined) H.fail("STAT_INVALID_INPUT", "data.standardDeviation is only valid for target=mean");
      if (options.intervalMethod === "t") H.fail("STAT_INVALID_INPUT", "intervalMethod=t is only valid for target=mean");
      proportion = data.proportion === undefined ? 0.5 : probability(H, data.proportion, "data.proportion");
      if (halfWidth >= 1) H.fail("STAT_INVALID_INPUT", "data.halfWidth must be below 1 for a proportion");
    }
    const populationSize = data.populationSize === undefined ? null : H.integer(data.populationSize, 2, Number.MAX_SAFE_INTEGER, "data.populationSize");
    return { halfWidth, standardDeviation, proportion, populationSize };
  },
  analyze(parsed, options, budget, H) {
    const level = options.confidenceLevel;
    const z = NC.normalQuantilePrecise(H, 1 - (1 - level) / 2);
    const variance = options.target === "mean" ? parsed.standardDeviation ** 2 : parsed.proportion * (1 - parsed.proportion);
    const halfWidthAt = (n) => {
      const critical = options.intervalMethod === "t" ? NC.tQuantile(H, 1 - (1 - level) / 2, n - 1) : z;
      const fpc = parsed.populationSize === null ? 1 : Math.max(0, (parsed.populationSize - n) / (parsed.populationSize - 1));
      return critical * Math.sqrt(variance * fpc / n);
    };
    const infiniteN = z * z * variance / (parsed.halfWidth ** 2);
    let exactN = infiniteN;
    if (parsed.populationSize !== null) exactN = infiniteN / (1 + (infiniteN - 1) / parsed.populationSize);
    let solverMethod = "closed form n = z^2 sigma^2 / E^2";
    if (parsed.populationSize !== null) solverMethod += " with finite population correction";
    let ceilingN = Math.max(2, Math.ceil(exactN - 1e-9));
    if (options.intervalMethod === "t") {
      let n = Math.max(2, Math.ceil(infiniteN - 1e-9));
      let iterations = 0;
      while (halfWidthAt(n) > parsed.halfWidth && n < MAX_SAMPLE_SIZE) {
        budget.check(8);
        n += 1;
        iterations += 1;
        if (iterations > 1_000_000) H.fail("STAT_NON_CONVERGENCE", "t-based sample-size search did not converge");
      }
      if (halfWidthAt(n) > parsed.halfWidth) H.fail("STAT_NON_CONVERGENCE", "required precision is not attainable below the sample-size limit");
      ceilingN = n;
      exactN = n;
      solverMethod = "ascending integer search on t_(n-1) sigma / sqrt(n) <= E";
    }
    if (parsed.populationSize !== null && ceilingN > parsed.populationSize) {
      ceilingN = parsed.populationSize;
    }
    const achievedHalfWidth = halfWidthAt(ceilingN);
    const inputRows = [
      { parameter: "halfWidth", value: parsed.halfWidth, status: "given", note: "target margin of error" },
      options.target === "mean"
        ? { parameter: "standardDeviation", value: parsed.standardDeviation, status: "given", note: "anticipated SD" }
        : { parameter: "proportion", value: parsed.proportion, status: "given", note: "anticipated proportion (0.5 is the conservative maximum)" },
      { parameter: "confidenceLevel", value: level, status: "given", note: `z = ${z.toPrecision(6)}` },
      { parameter: "populationSize", value: parsed.populationSize === null ? 0 : parsed.populationSize, status: parsed.populationSize === null ? "not_applied" : "given", note: parsed.populationSize === null ? "infinite population" : "finite population correction applied" },
      { parameter: "sampleSize", value: exactN, status: "solved", note: solverMethod },
      { parameter: "sampleSizeCeiling", value: ceilingN, status: "derived", note: `achieved half-width ${achievedHalfWidth.toPrecision(6)}` },
    ];
    const upper = Math.max(ceilingN * 2, 12);
    const grid = integerCurveGrid(2, ceilingN).filter((n) => n <= upper || n === ceilingN).filter((n) => parsed.populationSize === null || n <= parsed.populationSize);
    const curveRows = grid.map((n) => ({ sampleSize: n, halfWidth: halfWidthAt(n), solution: n === ceilingN }));
    const curveTable = H.tableArtifact("Precision curve", "Confidence-interval half-width versus sample size.", [
      { key: "sampleSize", label: "n", type: "number" },
      { key: "halfWidth", label: "Half-width", type: "number" },
      { key: "solution", label: "Solution point", type: "boolean" },
    ], curveRows, [], "precision-curve-table");
    const figure = H.vegaArtifact("precision-curve", `Half-width of the ${Math.round(level * 100)}% interval for a ${options.target} versus n`, {
      data: { values: curveRows },
      width: 480,
      height: 300,
      layer: [
        { mark: { type: "line", strokeWidth: 2 }, encoding: { x: { field: "sampleSize", type: "quantitative", title: "n" }, y: { field: "halfWidth", type: "quantitative", title: "Half-width" } } },
        { mark: { type: "point", filled: true, size: 140, color: "#d62728" }, encoding: { x: { field: "sampleSize", type: "quantitative" }, y: { field: "halfWidth", type: "quantitative" }, opacity: { condition: { test: "datum.solution === true", value: 1 }, value: 0 } } },
        { mark: { type: "rule", strokeDash: [6, 4], color: "#555" }, encoding: { y: { datum: parsed.halfWidth, type: "quantitative" } } },
      ],
    });
    return {
      sample: { target: options.target, sampleSize: exactN, sampleSizeCeiling: ceilingN, populationSize: parsed.populationSize },
      estimates: [
        { parameter: "sampleSize", estimate: exactN, role: "solved" },
        { parameter: "sampleSizeCeiling", estimate: ceilingN, role: "derived" },
        { parameter: "achievedHalfWidth", estimate: achievedHalfWidth, role: "derived" },
        { parameter: "criticalValue", estimate: options.intervalMethod === "t" ? NC.tQuantile(H, 1 - (1 - level) / 2, ceilingN - 1) : z, role: "derived" },
        { parameter: "assumedVariance", estimate: variance, role: "derived" },
      ],
      tests: [],
      confidenceIntervals: [{ parameter: options.target, level, lower: -parsed.halfWidth, upper: parsed.halfWidth, method: `${options.intervalMethod === "t" ? "Student t" : "normal"} half-width relative to the estimate` }],
      effectSizes: [],
      assumptions: [
        { name: options.target === "mean" ? "anticipated standard deviation is accurate" : "anticipated proportion is accurate", status: "requires_design_review", detail: "The required n scales with the assumed variance; a conservative variance guess is safer." },
        { name: "simple random sampling", status: "requires_design_review" },
        ...(options.target === "proportion" ? [{ name: "Wald interval variance p(1-p)/n", status: "asymptotic", detail: "Planning uses the Wald variance; the reported interval in analysis may be Wilson." }] : []),
      ],
      diagnostics: [
        { name: "solver", status: "evaluated", method: solverMethod, target: "sampleSize" },
        { name: "finite population correction", status: parsed.populationSize === null ? "not_applied" : "applied", populationSize: parsed.populationSize },
      ],
      artifacts: [inputTable(H, inputRows, `Sample size for ${options.target} precision`, `Sample size needed for a ${Math.round(level * 100)}% interval half-width of ${parsed.halfWidth}.`, "precision-summary-table"), curveTable, figure],
    };
  },
  linkage: {
    neededWhen: "When the study goal is estimation precision rather than hypothesis testing, and the researcher must justify a sample size by the confidence-interval width they can tolerate.",
    decision: "How many observations to collect so that the reported interval for a mean or proportion is narrow enough to be scientifically useful.",
    mustShow: "The target half-width, the assumed variance or proportion, the confidence level, the finite-population correction if used, the solved n, and the half-width curve against n.",
    userGoal: "Plan a descriptive or survey study around estimation precision and document the variance assumption behind the number.",
    nextActions: [
      { trigger: "variance-assumption-uncertain", action: "run-precision-sensitivity-across-plausible-sd-or-proportion", reason: "The required n is proportional to the assumed variance, so an optimistic guess silently under-powers precision." },
      { trigger: "n-exceeds-budget", action: "widen-acceptable-half-width-with-explicit-justification", reason: "Relaxing precision is a scientific decision that must be recorded, not a numeric convenience." },
      { trigger: "design-committed", action: "bind-precision-table-to-protocol", reason: "The planned interval width should be reported alongside the achieved interval after data collection." },
    ],
  },
  fixture: { data: { halfWidth: 2, standardDeviation: 8 }, options: { confidenceLevel: 0.95, target: "mean", intervalMethod: "normal" } },
  matlabParity: { taxonomyIds: ["matlab.stats.descriptive-visualization"] },
  coverage: coverageTemplate(
    "Sample size for a target confidence-interval half-width of a mean (normal or iterative Student t) or a proportion (Wald variance), with an optional finite population correction.",
    ["closed-form normal n for means and proportions against scipy", "iterative t-based n against a scipy loop", "finite population correction"],
    ["Wilson or exact-interval planning for proportions", "precision for regression coefficients or differences"],
    ["solver method", "finite population correction status"],
    ["assumed variance is taken as given and not calibrated"],
    ["no Wilson/Clopper-Pearson precision planning", "no two-group difference precision"],
  ),
};

module.exports = {
  methods: [powerTTest, powerAnova, powerProportions, powerCorrelation, powerChiSquare, powerRegression, sampleSizePrecision],
  internals: { tTestPower, anovaPower, normalTestPower, exactBinomialPower, correlationPower, chiSquarePower, regressionPower, cohenH, solveScalar },
};
