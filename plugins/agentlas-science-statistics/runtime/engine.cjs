"use strict";

const { createHash } = require("node:crypto");
const { buildResearchDecisionLinkage } = require("./decision-linkage.cjs");

const ENGINE = Object.freeze({
  id: "agentlas-science-statistics",
  version: "1.10.0",
  algorithmRevision: "gaussian-random-intercept-lmm-v9-js-2026-09-01",
});

const REQUEST_SCHEMA = "agentlas.science.statistics.request/v1";
const RESULT_SCHEMA = "agentlas.science.statistics.result/v1";
const TABLE_SCHEMA = "agentlas.science.statistics-table/v1";
const RECEIPT_SCHEMA = "agentlas.science.statistics.receipt/v1";
const VEGA_SCHEMA = "https://vega.github.io/schema/vega-lite/v6.json";
const NUMERIC_SURFACE_SOURCE_SCHEMA = "agentlas.science.statistics-numeric-surface-source/v2";

const LIMITS = Object.freeze({
  maxRequestBytes: 8 * 1024 * 1024,
  maxVectorLength: 100_000,
  maxTotalValues: 200_000,
  maxGroups: 64,
  maxPredictors: 48,
  maxSurvivalRows: 10_000,
  maxCoxPredictors: 16,
  maxPoissonRows: 5_000,
  maxPcaRows: 10_000,
  maxPcaVariables: 32,
  maxTimeSeriesRows: 10_000,
  maxTimeSeriesLag: 200,
  maxRocRows: 10_000,
  maxMetaStudies: 1_000,
  maxResponseSurfaceRows: 10_000,
  maxResponseSurfaceGridSize: 101,
  maxLmmRows: 10_000,
  maxLmmGroups: 2_000,
  maxLmmFixedTerms: 32,
  maxLmmTotalValues: 340_000,
  maxContingencyCells: 10_000,
  maxPValues: 10_000,
  defaultTimeoutMs: 5_000,
  maxTimeoutMs: 10_000,
  maxIterations: 100,
  maxArtifactRows: 10_000,
});

const CORE_METHODS = Object.freeze([
  "descriptive",
  "distribution_fit",
  "pearson_correlation",
  "spearman_correlation",
  "kendall_correlation",
  "independent_t_test",
  "welch_t_test",
  "paired_t_test",
  "one_way_anova",
  "welch_one_way_anova",
  "two_way_anova",
  "mann_whitney_u",
  "wilcoxon_signed_rank",
  "kruskal_wallis",
  "friedman_test",
  "linear_regression",
  "logistic_regression",
  "poisson_regression",
  "chi_square_test",
  "fisher_exact_test",
  "multiple_testing_correction",
  "confidence_interval",
  "kaplan_meier",
  "log_rank_test",
  "cox_proportional_hazards",
  "principal_component_analysis",
  "time_series_diagnostics",
  "roc_curve_analysis",
  "meta_analysis",
  "response_surface_regression",
  "gaussian_random_intercept_lmm",
]);

const { loadMethodRegistry } = require("./methods/index.cjs");
const METHOD_REGISTRY = loadMethodRegistry();
for (const method of METHOD_REGISTRY.methods) {
  if (CORE_METHODS.includes(method)) throw new Error(`statistics method registry duplicates core method ${method}`);
}
const METHODS = Object.freeze([...CORE_METHODS, ...METHOD_REGISTRY.methods]);
const SHARED_OPTION_KEYS = Object.freeze(["confidenceLevel", "alternative", "correction", "estimator", "intercept", "timeoutMs", "maxIterations", "tolerance", "ties", "postHoc", "covariance", "pValueMethod", "scaling", "components", "maxLag", "differenceOrder", "metaModel", "tauEstimator", "gridSize", "fitMethod"]);

class StatisticsError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "StatisticsError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new StatisticsError(code, message, details);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertObject(value, path) {
  if (!plainObject(value)) fail("STAT_INVALID_INPUT", `${path} must be an object`);
  return value;
}

function assertKeys(value, allowed, path) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) fail("STAT_INVALID_INPUT", `${path} has unsupported field(s): ${extra.sort().join(", ")}`);
}

function assertExactKeys(value, expected, path) {
  const item = assertObject(value, path);
  assertKeys(item, expected, path);
  const missing = expected.filter((key) => !Object.hasOwn(item, key));
  if (missing.length) fail("STAT_INTERNAL", `${path} is missing field(s): ${missing.join(", ")}`);
  return item;
}

function label(value, fallback, path) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim() || value.trim().length > 128 || /[\u0000-\u001f]/u.test(value)) {
    fail("STAT_INVALID_INPUT", `${path} must be a non-empty string of at most 128 characters`);
  }
  return value.trim();
}

function optionalUnit(value, path) {
  if (value === undefined) return null;
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 80 || /[\u0000-\u001f]/u.test(value)) {
    fail("STAT_INVALID_INPUT", `${path} must be omitted or a non-empty trimmed string of at most 80 characters`);
  }
  return value;
}

function finiteNumber(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("STAT_INVALID_INPUT", `${path} must be a finite number`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function integer(value, min, max, path) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail("STAT_INVALID_INPUT", `${path} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function numericVector(value, path, minLength = 2) {
  if (!Array.isArray(value)) fail("STAT_INVALID_INPUT", `${path} must be an array`);
  if (value.length < minLength || value.length > LIMITS.maxVectorLength) {
    fail("STAT_INVALID_INPUT", `${path} length must be between ${minLength} and ${LIMITS.maxVectorLength}`);
  }
  return value.map((item, index) => finiteNumber(item, `${path}[${index}]`));
}

function categoryVector(value, path, minLength = 2) {
  if (!Array.isArray(value)) fail("STAT_INVALID_INPUT", `${path} must be an array`);
  if (value.length < minLength || value.length > LIMITS.maxVectorLength) {
    fail("STAT_INVALID_INPUT", `${path} length must be between ${minLength} and ${LIMITS.maxVectorLength}`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim() || item.trim().length > 128 || /[\u0000-\u001f]/u.test(item)) {
      fail("STAT_INVALID_INPUT", `${path}[${index}] must be a non-empty string of at most 128 characters`);
    }
    return item.trim();
  });
}

function regressionPredictors(raw, n, { allowEmpty = false } = {}) {
  const minimum = allowEmpty ? 0 : 1;
  if (!Array.isArray(raw) || raw.length < minimum || raw.length > LIMITS.maxPredictors) {
    fail("STAT_INVALID_INPUT", `data.predictors length must be between ${minimum} and ${LIMITS.maxPredictors}`);
  }
  const seen = new Set();
  const predictors = raw.map((rawPredictor, index) => {
    const path = `data.predictors[${index}]`;
    const predictor = assertObject(rawPredictor, path);
    assertKeys(predictor, ["name", "type", "values", "reference"], path);
    const name = label(predictor.name, `X${index + 1}`, `${path}.name`);
    if (seen.has(name)) fail("STAT_INVALID_INPUT", `duplicate predictor name: ${name}`);
    seen.add(name);
    const type = predictor.type === undefined ? "numeric" : predictor.type;
    if (!["numeric", "categorical"].includes(type)) fail("STAT_INVALID_INPUT", `${path}.type must be numeric or categorical`);
    if (type === "numeric") {
      if (predictor.reference !== undefined) fail("STAT_INVALID_INPUT", `${path}.reference is only valid for categorical predictors`);
      const values = numericVector(predictor.values, `${path}.values`, 4);
      if (values.length !== n) fail("STAT_INVALID_INPUT", `predictor ${name} length does not match data.y`);
      if (minMax(values).min === minMax(values).max) fail("STAT_DEGENERATE", `predictor ${name} is constant`);
      return { name, type, values };
    }
    const values = categoryVector(predictor.values, `${path}.values`, 4);
    if (values.length !== n) fail("STAT_INVALID_INPUT", `predictor ${name} length does not match data.y`);
    const levels = [...new Set(values)].sort((a, b) => a.localeCompare(b, "en"));
    if (levels.length < 2 || levels.length > 32) fail("STAT_INVALID_INPUT", `categorical predictor ${name} must have 2 to 32 levels`);
    const reference = predictor.reference === undefined ? levels[0] : categoryVector([predictor.reference, predictor.reference], `${path}.reference`, 2)[0];
    if (!levels.includes(reference)) fail("STAT_INVALID_INPUT", `categorical predictor ${name} reference is not present in values`);
    return { name, type, values, levels, reference };
  });
  return predictors;
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("STAT_INTERNAL", "non-finite number reached canonicalization");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (plainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = canonicalize(value[key]);
    }
    return out;
  }
  fail("STAT_INTERNAL", "unsupported value reached canonicalization");
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex")}`;
}

class Budget {
  constructor(timeoutMs) {
    this.deadline = Date.now() + timeoutMs;
    this.operations = 0;
  }

  check(weight = 1) {
    this.operations += weight;
    if ((this.operations & 2047) === 0 && Date.now() > this.deadline) {
      fail("STAT_TIMEOUT", "analysis exceeded its deterministic execution budget");
    }
  }
}

function parseOptions(raw, method = null) {
  const value = raw === undefined ? {} : assertObject(raw, "options");
  assertKeys(value, [...SHARED_OPTION_KEYS, ...METHOD_REGISTRY.customOptionKeys], "options");
  const custom = {};
  const definition = method === null ? null : METHOD_REGISTRY.byMethod[method];
  if (definition) {
    for (const [key, spec] of Object.entries(definition.customOptions)) {
      custom[key] = value[key] === undefined ? spec.default : spec.parse(value[key], HELPERS, `options.${key}`);
    }
  }
  const confidenceLevel = value.confidenceLevel === undefined ? 0.95 : finiteNumber(value.confidenceLevel, "options.confidenceLevel");
  if (confidenceLevel < 0.5 || confidenceLevel >= 1) fail("STAT_INVALID_INPUT", "options.confidenceLevel must be in [0.5, 1)");
  const alternative = value.alternative === undefined ? "two-sided" : value.alternative;
  if (!["two-sided", "less", "greater"].includes(alternative)) fail("STAT_INVALID_INPUT", "options.alternative must be two-sided, less, or greater");
  const correction = value.correction === undefined ? "all" : value.correction;
  if (!["all", "bonferroni", "holm", "benjamini-hochberg", "benjamini-yekutieli"].includes(correction)) {
    fail("STAT_INVALID_INPUT", "options.correction is unsupported");
  }
  const estimator = value.estimator === undefined ? "mean" : value.estimator;
  if (!["mean", "proportion-wilson"].includes(estimator)) fail("STAT_INVALID_INPUT", "options.estimator is unsupported");
  const timeoutMs = value.timeoutMs === undefined ? LIMITS.defaultTimeoutMs : integer(value.timeoutMs, 1, LIMITS.maxTimeoutMs, "options.timeoutMs");
  const maxIterations = value.maxIterations === undefined ? 50 : integer(value.maxIterations, 1, LIMITS.maxIterations, "options.maxIterations");
  const tolerance = value.tolerance === undefined ? 1e-8 : finiteNumber(value.tolerance, "options.tolerance");
  if (tolerance < 1e-12 || tolerance > 1e-3) fail("STAT_INVALID_INPUT", "options.tolerance must be in [1e-12, 1e-3]");
  if (value.intercept !== undefined && typeof value.intercept !== "boolean") fail("STAT_INVALID_INPUT", "options.intercept must be boolean");
  const ties = value.ties === undefined ? "efron" : value.ties;
  if (!["efron", "breslow"].includes(ties)) fail("STAT_INVALID_INPUT", "options.ties must be efron or breslow");
  const postHoc = value.postHoc === undefined ? "none" : value.postHoc;
  if (!["none", "holm"].includes(postHoc)) fail("STAT_INVALID_INPUT", "options.postHoc must be none or holm");
  const covariance = value.covariance === undefined ? "classical" : value.covariance;
  // "hac" is the Newey-West estimator: heteroskedasticity AND autocorrelation consistent. A
  // time-series regression -- an asset-pricing factor model, a Fama-MacBeth premium -- needs it,
  // because HC alone assumes the residuals are independent across periods and they are not.
  if (!["classical", "hc0", "hc1", "hc2", "hc3", "hac"].includes(covariance)) fail("STAT_INVALID_INPUT", "options.covariance must be classical, hc0, hc1, hc2, hc3, or hac");
  const pValueMethod = value.pValueMethod === undefined ? "auto" : value.pValueMethod;
  if (!["auto", "exact", "asymptotic"].includes(pValueMethod)) fail("STAT_INVALID_INPUT", "options.pValueMethod must be auto, exact, or asymptotic");
  const scaling = value.scaling === undefined ? "correlation" : value.scaling;
  if (!["correlation", "covariance"].includes(scaling)) fail("STAT_INVALID_INPUT", "options.scaling must be correlation or covariance");
  const components = value.components === undefined ? null : integer(value.components, 1, LIMITS.maxPcaVariables, "options.components");
  const maxLag = value.maxLag === undefined ? null : integer(value.maxLag, 1, LIMITS.maxTimeSeriesLag, "options.maxLag");
  const differenceOrder = value.differenceOrder === undefined ? 0 : integer(value.differenceOrder, 0, 1, "options.differenceOrder");
  const metaModel = value.metaModel === undefined ? "both" : value.metaModel;
  if (!["fixed", "random", "both"].includes(metaModel)) fail("STAT_INVALID_INPUT", "options.metaModel must be fixed, random, or both");
  const tauEstimator = value.tauEstimator === undefined ? "paule-mandel" : value.tauEstimator;
  if (!["der-simonian-laird", "paule-mandel"].includes(tauEstimator)) fail("STAT_INVALID_INPUT", "options.tauEstimator must be der-simonian-laird or paule-mandel");
  const gridSize = value.gridSize === undefined ? 31 : integer(value.gridSize, 11, LIMITS.maxResponseSurfaceGridSize, "options.gridSize");
  if (gridSize % 2 === 0) fail("STAT_INVALID_INPUT", "options.gridSize must be odd so the declared factor center is represented exactly");
  const fitMethod = value.fitMethod === undefined ? "reml" : value.fitMethod;
  if (!["ml", "reml"].includes(fitMethod)) fail("STAT_INVALID_INPUT", "options.fitMethod must be ml or reml");
  return {
    confidenceLevel,
    alternative,
    correction,
    estimator,
    intercept: value.intercept !== false,
    timeoutMs,
    maxIterations,
    tolerance,
    ties,
    postHoc,
    covariance,
    pValueMethod,
    scaling,
    components,
    maxLag,
    differenceOrder,
    metaModel,
    tauEstimator,
    gridSize,
    fitMethod,
    ...custom,
  };
}

const CORE_METHOD_OPTION_KEYS = Object.freeze({
  descriptive: ["confidenceLevel", "timeoutMs"],
  distribution_fit: ["timeoutMs"],
  pearson_correlation: ["confidenceLevel", "alternative", "timeoutMs"],
  spearman_correlation: ["confidenceLevel", "alternative", "pValueMethod", "timeoutMs"],
  kendall_correlation: ["confidenceLevel", "alternative", "pValueMethod", "timeoutMs"],
  independent_t_test: ["confidenceLevel", "alternative", "timeoutMs"],
  welch_t_test: ["confidenceLevel", "alternative", "timeoutMs"],
  paired_t_test: ["confidenceLevel", "alternative", "timeoutMs"],
  one_way_anova: ["confidenceLevel", "postHoc", "timeoutMs"],
  welch_one_way_anova: ["confidenceLevel", "timeoutMs"],
  two_way_anova: ["confidenceLevel", "postHoc", "timeoutMs"],
  mann_whitney_u: ["confidenceLevel", "alternative", "pValueMethod", "timeoutMs"],
  wilcoxon_signed_rank: ["alternative", "pValueMethod", "timeoutMs"],
  kruskal_wallis: ["confidenceLevel", "timeoutMs"],
  friedman_test: ["timeoutMs"],
  linear_regression: ["confidenceLevel", "intercept", "covariance", "timeoutMs"],
  logistic_regression: ["confidenceLevel", "intercept", "covariance", "timeoutMs", "maxIterations", "tolerance"],
  poisson_regression: ["confidenceLevel", "intercept", "covariance", "timeoutMs", "maxIterations", "tolerance"],
  chi_square_test: ["timeoutMs"],
  fisher_exact_test: ["confidenceLevel", "alternative", "timeoutMs"],
  multiple_testing_correction: ["correction", "timeoutMs"],
  confidence_interval: ["confidenceLevel", "estimator", "timeoutMs"],
  kaplan_meier: ["confidenceLevel", "timeoutMs"],
  log_rank_test: ["confidenceLevel", "timeoutMs"],
  cox_proportional_hazards: ["confidenceLevel", "timeoutMs", "maxIterations", "tolerance", "ties"],
  principal_component_analysis: ["scaling", "components", "timeoutMs"],
  time_series_diagnostics: ["confidenceLevel", "maxLag", "differenceOrder", "timeoutMs"],
  roc_curve_analysis: ["timeoutMs"],
  meta_analysis: ["confidenceLevel", "metaModel", "tauEstimator", "timeoutMs", "maxIterations", "tolerance"],
  response_surface_regression: ["confidenceLevel", "gridSize", "timeoutMs"],
  gaussian_random_intercept_lmm: ["confidenceLevel", "fitMethod", "intercept", "timeoutMs", "maxIterations", "tolerance"],
});

const METHOD_OPTION_KEYS = Object.freeze({
  ...CORE_METHOD_OPTION_KEYS,
  ...Object.fromEntries(METHOD_REGISTRY.definitions.map((definition) => [
    definition.method,
    Object.freeze([...definition.optionKeys, ...Object.keys(definition.customOptions)]),
  ])),
});

function assertMethodOptions(method, raw) {
  if (raw === undefined) return;
  const value = assertObject(raw, "options");
  assertKeys(value, METHOD_OPTION_KEYS[method], `options for ${method}`);
}

function parseGroups(data, minimumGroups = 2, exactGroups = undefined) {
  assertKeys(data, ["groups"], "data");
  if (!Array.isArray(data.groups)) fail("STAT_INVALID_INPUT", "data.groups must be an array");
  if (exactGroups !== undefined && data.groups.length !== exactGroups) fail("STAT_INVALID_INPUT", `data.groups must contain exactly ${exactGroups} groups`);
  if (data.groups.length < minimumGroups || data.groups.length > LIMITS.maxGroups) {
    fail("STAT_INVALID_INPUT", `data.groups length must be between ${minimumGroups} and ${LIMITS.maxGroups}`);
  }
  const names = new Set();
  const groups = data.groups.map((raw, index) => {
    const group = assertObject(raw, `data.groups[${index}]`);
    assertKeys(group, ["name", "values"], `data.groups[${index}]`);
    const name = label(group.name, `Group ${index + 1}`, `data.groups[${index}].name`);
    if (names.has(name)) fail("STAT_INVALID_INPUT", `duplicate group name: ${name}`);
    names.add(name);
    return { name, values: numericVector(group.values, `data.groups[${index}].values`, 2) };
  });
  const total = groups.reduce((sum, group) => sum + group.values.length, 0);
  if (total > LIMITS.maxTotalValues) fail("STAT_LIMIT_EXCEEDED", `group values exceed ${LIMITS.maxTotalValues}`);
  return groups;
}

function parseConditions(data) {
  assertKeys(data, ["conditions"], "data");
  if (!Array.isArray(data.conditions) || data.conditions.length < 3 || data.conditions.length > LIMITS.maxGroups) {
    fail("STAT_INVALID_INPUT", `data.conditions length must be between 3 and ${LIMITS.maxGroups}`);
  }
  const names = new Set();
  let blockCount = null;
  const conditions = data.conditions.map((raw, index) => {
    const path = `data.conditions[${index}]`;
    const condition = assertObject(raw, path);
    assertKeys(condition, ["name", "values"], path);
    const name = label(condition.name, `Condition ${index + 1}`, `${path}.name`);
    if (names.has(name)) fail("STAT_INVALID_INPUT", `duplicate condition name: ${name}`);
    names.add(name);
    const values = numericVector(condition.values, `${path}.values`, 2);
    if (blockCount === null) blockCount = values.length;
    if (values.length !== blockCount) fail("STAT_INVALID_INPUT", "friedman_test requires a complete paired matrix with equal condition lengths");
    return { name, values };
  });
  if (conditions.length * blockCount > LIMITS.maxTotalValues) {
    fail("STAT_LIMIT_EXCEEDED", `Friedman paired matrix exceeds ${LIMITS.maxTotalValues} values`);
  }
  return { conditions, blockCount };
}

function survivalCohort(raw, path, fallbackName, requireName = false) {
  const cohort = assertObject(raw, path);
  assertKeys(cohort, ["name", "time", "event"], path);
  if (requireName && cohort.name === undefined) fail("STAT_INVALID_INPUT", `${path}.name is required`);
  const name = label(cohort.name, fallbackName, `${path}.name`);
  const time = numericVector(cohort.time, `${path}.time`, 2);
  if (time.length > LIMITS.maxSurvivalRows) fail("STAT_LIMIT_EXCEEDED", `${path}.time exceeds ${LIMITS.maxSurvivalRows} rows`);
  if (time.some((value) => value <= 0)) fail("STAT_INVALID_INPUT", `${path}.time must contain only positive durations`);
  if (!Array.isArray(cohort.event) || cohort.event.length !== time.length) fail("STAT_INVALID_INPUT", `${path}.event must match ${path}.time length`);
  const event = cohort.event.map((value, index) => integer(value, 0, 1, `${path}.event[${index}]`));
  if (sum(event) === 0) fail("STAT_DEGENERATE", `${path}.event must contain at least one observed event`);
  return { name, time, event };
}

function survivalPredictors(raw, n) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > LIMITS.maxCoxPredictors) {
    fail("STAT_INVALID_INPUT", `data.predictors length must be between 1 and ${LIMITS.maxCoxPredictors}`);
  }
  const seen = new Set();
  return raw.map((rawPredictor, index) => {
    const predictor = assertObject(rawPredictor, `data.predictors[${index}]`);
    assertKeys(predictor, ["name", "values"], `data.predictors[${index}]`);
    const name = label(predictor.name, `X${index + 1}`, `data.predictors[${index}].name`);
    if (seen.has(name)) fail("STAT_INVALID_INPUT", `duplicate predictor name: ${name}`);
    seen.add(name);
    const values = numericVector(predictor.values, `data.predictors[${index}].values`, 5);
    if (values.length !== n) fail("STAT_INVALID_INPUT", `predictor ${name} length does not match survival rows`);
    const range = minMax(values);
    if (range.min === range.max) fail("STAT_DEGENERATE", `predictor ${name} is constant`);
    return { name, values };
  });
}

function parseRequest(raw) {
  const request = assertObject(raw, "request");
  assertKeys(request, ["schema", "method", "data", "options"], "request");
  if (request.schema !== REQUEST_SCHEMA) fail("STAT_INVALID_INPUT", `request.schema must be ${REQUEST_SCHEMA}`);
  if (!METHODS.includes(request.method)) fail("STAT_INVALID_INPUT", `unsupported method: ${String(request.method)}`);
  const data = assertObject(request.data, "data");
  assertMethodOptions(request.method, request.options);
  const options = parseOptions(request.options, request.method);
  let parsedData;

  switch (request.method) {
    case "descriptive": {
      assertKeys(data, ["values", "label"], "data");
      parsedData = { values: numericVector(data.values, "data.values", 2), label: label(data.label, "Value", "data.label") };
      break;
    }
    case "distribution_fit": {
      assertKeys(data, ["values", "candidates", "label"], "data");
      const values = numericVector(data.values, "data.values", 8);
      if (!Array.isArray(data.candidates) || data.candidates.length < 1 || data.candidates.length > 3) {
        fail("STAT_INVALID_INPUT", "data.candidates must contain between one and three explicit distribution IDs");
      }
      const supported = ["normal", "lognormal", "exponential"];
      const candidates = data.candidates.map((candidate, index) => {
        if (typeof candidate !== "string" || !supported.includes(candidate)) {
          fail("STAT_INVALID_INPUT", `data.candidates[${index}] must be normal, lognormal, or exponential`);
        }
        return candidate;
      });
      if (new Set(candidates).size !== candidates.length) fail("STAT_INVALID_INPUT", "data.candidates must be unique");
      if (candidates.includes("lognormal") && values.some((value) => !(value > 0))) {
        fail("STAT_INVALID_INPUT", "lognormal fitting requires every observation to be strictly positive");
      }
      if (candidates.includes("exponential") && values.some((value) => value < 0)) {
        fail("STAT_INVALID_INPUT", "exponential fitting with location fixed at zero requires non-negative observations");
      }
      if (candidates.includes("exponential") && mean(values) === 0) {
        fail("STAT_DEGENERATE", "exponential fitting requires a positive sample mean");
      }
      if (candidates.includes("normal") && variance(values, false) === 0) {
        fail("STAT_DEGENERATE", "normal fitting requires non-zero maximum-likelihood variance");
      }
      if (candidates.includes("lognormal") && variance(values.map(Math.log), false) === 0) {
        fail("STAT_DEGENERATE", "lognormal fitting requires non-zero maximum-likelihood log variance");
      }
      parsedData = { values, candidates, label: label(data.label, "Value", "data.label") };
      break;
    }
    case "pearson_correlation":
    case "spearman_correlation":
    case "kendall_correlation":
    case "paired_t_test":
    case "wilcoxon_signed_rank": {
      assertKeys(data, ["x", "y", "xLabel", "yLabel"], "data");
      const x = numericVector(data.x, "data.x", request.method.includes("correlation") ? 3 : 2);
      const y = numericVector(data.y, "data.y", request.method.includes("correlation") ? 3 : 2);
      if (x.length !== y.length) fail("STAT_INVALID_INPUT", "data.x and data.y must have the same length");
      if (x.length + y.length > LIMITS.maxTotalValues) fail("STAT_LIMIT_EXCEEDED", `paired values exceed ${LIMITS.maxTotalValues}`);
      parsedData = { x, y, xLabel: label(data.xLabel, "X", "data.xLabel"), yLabel: label(data.yLabel, "Y", "data.yLabel") };
      break;
    }
    case "independent_t_test":
    case "welch_t_test":
    case "mann_whitney_u":
      parsedData = { groups: parseGroups(data, 2, 2) };
      break;
    case "one_way_anova":
    case "welch_one_way_anova":
    case "kruskal_wallis":
      parsedData = { groups: parseGroups(data, 2) };
      break;
    case "friedman_test":
      parsedData = parseConditions(data);
      break;
    case "two_way_anova": {
      assertKeys(data, ["y", "factorA", "factorB", "outcomeLabel", "factorALabel", "factorBLabel"], "data");
      const y = numericVector(data.y, "data.y", 8);
      const factorA = categoryVector(data.factorA, "data.factorA", 8);
      const factorB = categoryVector(data.factorB, "data.factorB", 8);
      if (factorA.length !== y.length || factorB.length !== y.length) fail("STAT_INVALID_INPUT", "two_way_anova factor vectors must match data.y length");
      const levelsA = [...new Set(factorA)].sort((a, b) => a.localeCompare(b, "en"));
      const levelsB = [...new Set(factorB)].sort((a, b) => a.localeCompare(b, "en"));
      if (levelsA.length < 2 || levelsB.length < 2 || levelsA.length > 16 || levelsB.length > 16) fail("STAT_INVALID_INPUT", "two_way_anova requires 2 to 16 levels in each factor");
      parsedData = {
        y, factorA, factorB, levelsA, levelsB,
        outcomeLabel: label(data.outcomeLabel, "Outcome", "data.outcomeLabel"),
        factorALabel: label(data.factorALabel, "Factor A", "data.factorALabel"),
        factorBLabel: label(data.factorBLabel, "Factor B", "data.factorBLabel"),
      };
      break;
    }
    case "linear_regression":
    case "logistic_regression":
    case "poisson_regression": {
      assertKeys(data, ["y", "predictors", "outcomeLabel", "exposure", "logOffset"], "data");
      if (request.method !== "poisson_regression" && (data.exposure !== undefined || data.logOffset !== undefined)) {
        fail("STAT_INVALID_INPUT", `${request.method} does not accept exposure or logOffset`);
      }
      const y = numericVector(data.y, "data.y", 4);
      const predictors = regressionPredictors(data.predictors, y.length);
      const expandedColumns = predictors.reduce((count, predictor) => count + (predictor.type === "categorical" ? predictor.levels.length - 1 : 1), 0);
      if (expandedColumns > LIMITS.maxPredictors) fail("STAT_LIMIT_EXCEEDED", `expanded regression terms exceed ${LIMITS.maxPredictors}`);
      if (y.length * (expandedColumns + 1) > LIMITS.maxTotalValues) fail("STAT_LIMIT_EXCEEDED", `regression matrix exceeds ${LIMITS.maxTotalValues} values`);
      if (request.method === "logistic_regression" && y.some((item) => item !== 0 && item !== 1)) {
        fail("STAT_INVALID_INPUT", "logistic_regression data.y must contain only 0 and 1");
      }
      if (request.method === "logistic_regression" && (y.every((item) => item === 0) || y.every((item) => item === 1))) {
        fail("STAT_INVALID_INPUT", "logistic_regression data.y must contain both outcome classes");
      }
      if (request.method === "poisson_regression") {
        if (y.length > LIMITS.maxPoissonRows) fail("STAT_LIMIT_EXCEEDED", `poisson_regression rows exceed ${LIMITS.maxPoissonRows}`);
        if (y.some((item) => !Number.isSafeInteger(item) || item < 0)) fail("STAT_INVALID_INPUT", "poisson_regression data.y must contain non-negative integer counts");
        if (y.every((item) => item === 0)) fail("STAT_DEGENERATE", "poisson_regression data.y must contain at least one positive count");
        if (data.exposure !== undefined && data.logOffset !== undefined) fail("STAT_INVALID_INPUT", "poisson_regression accepts exposure or logOffset, not both");
        let exposure = null;
        let logOffset = Array(y.length).fill(0);
        let offsetMode = "none";
        if (data.exposure !== undefined) {
          exposure = numericVector(data.exposure, "data.exposure", 4);
          if (exposure.length !== y.length) fail("STAT_INVALID_INPUT", "data.exposure length does not match data.y");
          if (exposure.some((item) => !(item > 0))) fail("STAT_INVALID_INPUT", "poisson_regression data.exposure must contain only positive values");
          logOffset = exposure.map((item) => Math.log(item));
          offsetMode = "exposure";
        } else if (data.logOffset !== undefined) {
          logOffset = numericVector(data.logOffset, "data.logOffset", 4);
          if (logOffset.length !== y.length) fail("STAT_INVALID_INPUT", "data.logOffset length does not match data.y");
          offsetMode = "log-offset";
        }
        parsedData = { y, predictors, exposure, logOffset, offsetMode, outcomeLabel: label(data.outcomeLabel, "Count", "data.outcomeLabel") };
      } else {
        parsedData = { y, predictors, outcomeLabel: label(data.outcomeLabel, "Outcome", "data.outcomeLabel") };
      }
      break;
    }
    case "roc_curve_analysis": {
      assertKeys(data, ["outcomes", "scores", "observationLabels", "outcomeLabel", "scoreLabel"], "data");
      const outcomes = numericVector(data.outcomes, "data.outcomes", 4);
      const scores = numericVector(data.scores, "data.scores", 4);
      if (outcomes.length !== scores.length) fail("STAT_INVALID_INPUT", "data.outcomes and data.scores must have the same length");
      if (outcomes.length > LIMITS.maxRocRows) fail("STAT_LIMIT_EXCEEDED", `roc_curve_analysis rows exceed ${LIMITS.maxRocRows}`);
      if (outcomes.some((value) => value !== 0 && value !== 1)) fail("STAT_INVALID_INPUT", "roc_curve_analysis data.outcomes must contain only 0 and 1");
      if (outcomes.every((value) => value === 0) || outcomes.every((value) => value === 1)) {
        fail("STAT_DEGENERATE", "roc_curve_analysis requires both outcome classes");
      }
      let observationLabels;
      if (data.observationLabels === undefined) observationLabels = outcomes.map((_, index) => `Row ${index + 1}`);
      else {
        if (!Array.isArray(data.observationLabels) || data.observationLabels.length !== outcomes.length) {
          fail("STAT_INVALID_INPUT", "data.observationLabels length must match data.outcomes");
        }
        observationLabels = data.observationLabels.map((item, index) => label(item, `Row ${index + 1}`, `data.observationLabels[${index}]`));
        if (new Set(observationLabels).size !== observationLabels.length) fail("STAT_INVALID_INPUT", "data.observationLabels must be unique");
      }
      parsedData = {
        outcomes,
        scores,
        observationLabels,
        outcomeLabel: label(data.outcomeLabel, "Outcome", "data.outcomeLabel"),
        scoreLabel: label(data.scoreLabel, "Score", "data.scoreLabel"),
      };
      break;
    }
    case "chi_square_test":
    case "fisher_exact_test": {
      assertKeys(data, ["table", "rowLabels", "columnLabels"], "data");
      if (!Array.isArray(data.table) || data.table.length < 2) fail("STAT_INVALID_INPUT", "data.table must have at least two rows");
      const width = Array.isArray(data.table[0]) ? data.table[0].length : 0;
      if (width < 2 || data.table.length * width > LIMITS.maxContingencyCells) fail("STAT_LIMIT_EXCEEDED", "contingency table dimensions are unsupported");
      const table = data.table.map((row, rowIndex) => {
        if (!Array.isArray(row) || row.length !== width) fail("STAT_INVALID_INPUT", "all contingency rows must have equal length");
        return row.map((cell, columnIndex) => integer(cell, 0, Number.MAX_SAFE_INTEGER, `data.table[${rowIndex}][${columnIndex}]`));
      });
      if (table.flat().reduce((sum, value) => sum + value, 0) === 0) fail("STAT_INVALID_INPUT", "contingency table total must be positive");
      if (request.method === "fisher_exact_test" && (table.length !== 2 || width !== 2)) fail("STAT_INVALID_INPUT", "fisher_exact_test requires a 2x2 table");
      const parseLabels = (values, count, path, prefix) => {
        if (values === undefined) return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);
        if (!Array.isArray(values) || values.length !== count) fail("STAT_INVALID_INPUT", `${path} length must match its table dimension`);
        const parsed = values.map((item, index) => label(item, `${prefix} ${index + 1}`, `${path}[${index}]`));
        if (new Set(parsed).size !== parsed.length) fail("STAT_INVALID_INPUT", `${path} must be unique`);
        return parsed;
      };
      parsedData = {
        table,
        rowLabels: parseLabels(data.rowLabels, table.length, "data.rowLabels", "Row"),
        columnLabels: parseLabels(data.columnLabels, width, "data.columnLabels", "Column"),
      };
      break;
    }
    case "multiple_testing_correction": {
      assertKeys(data, ["pValues", "labels"], "data");
      if (!Array.isArray(data.pValues) || data.pValues.length < 1 || data.pValues.length > LIMITS.maxPValues) {
        fail("STAT_INVALID_INPUT", `data.pValues length must be between 1 and ${LIMITS.maxPValues}`);
      }
      const pValues = data.pValues.map((item, index) => {
        const p = finiteNumber(item, `data.pValues[${index}]`);
        if (p < 0 || p > 1) fail("STAT_INVALID_INPUT", `data.pValues[${index}] must be in [0,1]`);
        return p;
      });
      let labels;
      if (data.labels !== undefined) {
        if (!Array.isArray(data.labels) || data.labels.length !== pValues.length) fail("STAT_INVALID_INPUT", "data.labels length must match data.pValues");
        labels = data.labels.map((item, index) => label(item, `H${index + 1}`, `data.labels[${index}]`));
      } else labels = pValues.map((_, index) => `H${index + 1}`);
      parsedData = { pValues, labels };
      break;
    }
    case "confidence_interval": {
      if (options.estimator === "mean") {
        assertKeys(data, ["values", "label"], "data");
        parsedData = { values: numericVector(data.values, "data.values", 2), label: label(data.label, "Mean", "data.label") };
      } else {
        assertKeys(data, ["successes", "trials", "label"], "data");
        const trials = integer(data.trials, 1, LIMITS.maxVectorLength, "data.trials");
        const successes = integer(data.successes, 0, trials, "data.successes");
        parsedData = { successes, trials, label: label(data.label, "Proportion", "data.label") };
      }
      break;
    }
    case "kaplan_meier": {
      assertKeys(data, ["time", "event", "label"], "data");
      const cohort = survivalCohort({ time: data.time, event: data.event, name: data.label }, "data", "Cohort");
      parsedData = { time: cohort.time, event: cohort.event, label: cohort.name };
      break;
    }
    case "log_rank_test": {
      assertKeys(data, ["groups"], "data");
      if (!Array.isArray(data.groups) || data.groups.length !== 2) fail("STAT_INVALID_INPUT", "data.groups must contain exactly two survival cohorts");
      const groups = data.groups.map((group, index) => survivalCohort(group, `data.groups[${index}]`, `Group ${index + 1}`, true));
      if (groups[0].name === groups[1].name) fail("STAT_INVALID_INPUT", "survival group names must be unique");
      if (groups[0].time.length + groups[1].time.length > LIMITS.maxSurvivalRows) fail("STAT_LIMIT_EXCEEDED", `survival rows exceed ${LIMITS.maxSurvivalRows}`);
      parsedData = { groups };
      break;
    }
    case "cox_proportional_hazards": {
      assertKeys(data, ["time", "event", "predictors", "outcomeLabel"], "data");
      const cohort = survivalCohort({ time: data.time, event: data.event, name: data.outcomeLabel }, "data", "Time to event");
      if (cohort.time.length < 5) fail("STAT_INVALID_INPUT", "Cox regression requires at least five rows");
      const predictors = survivalPredictors(data.predictors, cohort.time.length);
      const events = sum(cohort.event);
      if (events <= predictors.length) fail("STAT_DEGENERATE", "Cox regression requires more observed events than predictors");
      const eventTimes = new Set(cohort.time.filter((_, index) => cohort.event[index] === 1));
      if (eventTimes.size < 2) fail("STAT_DEGENERATE", "Cox regression requires at least two distinct event times");
      if (cohort.time.length * (predictors.length + 2) > LIMITS.maxTotalValues) fail("STAT_LIMIT_EXCEEDED", `Cox design exceeds ${LIMITS.maxTotalValues} values`);
      parsedData = { time: cohort.time, event: cohort.event, predictors, outcomeLabel: cohort.name };
      break;
    }
    case "principal_component_analysis": {
      assertKeys(data, ["variables", "rowLabels"], "data");
      if (!Array.isArray(data.variables) || data.variables.length < 2 || data.variables.length > LIMITS.maxPcaVariables) {
        fail("STAT_INVALID_INPUT", `data.variables length must be between 2 and ${LIMITS.maxPcaVariables}`);
      }
      const names = new Set();
      let rowCount = null;
      const variables = data.variables.map((rawVariable, index) => {
        const variable = assertObject(rawVariable, `data.variables[${index}]`);
        assertKeys(variable, ["name", "values"], `data.variables[${index}]`);
        const name = label(variable.name, `Variable ${index + 1}`, `data.variables[${index}].name`);
        if (names.has(name)) fail("STAT_INVALID_INPUT", `duplicate PCA variable name: ${name}`);
        names.add(name);
        const values = numericVector(variable.values, `data.variables[${index}].values`, 3);
        if (values.length > LIMITS.maxPcaRows) fail("STAT_LIMIT_EXCEEDED", `PCA rows exceed ${LIMITS.maxPcaRows}`);
        if (rowCount === null) rowCount = values.length;
        if (values.length !== rowCount) fail("STAT_INVALID_INPUT", "all PCA variables must have equal row counts");
        if (minMax(values).min === minMax(values).max) fail("STAT_DEGENERATE", `PCA variable ${name} is constant`);
        return { name, values };
      });
      if (rowCount * variables.length > LIMITS.maxTotalValues) fail("STAT_LIMIT_EXCEEDED", `PCA matrix exceeds ${LIMITS.maxTotalValues} values`);
      const availableComponents = Math.min(variables.length, rowCount - 1);
      const components = options.components === null ? availableComponents : options.components;
      if (components > availableComponents) fail("STAT_INVALID_INPUT", `options.components must not exceed ${availableComponents} for this PCA matrix`);
      let rowLabels;
      if (data.rowLabels === undefined) rowLabels = Array.from({ length: rowCount }, (_, index) => `Row ${index + 1}`);
      else {
        if (!Array.isArray(data.rowLabels) || data.rowLabels.length !== rowCount) fail("STAT_INVALID_INPUT", "data.rowLabels length must match PCA rows");
        rowLabels = data.rowLabels.map((item, index) => label(item, `Row ${index + 1}`, `data.rowLabels[${index}]`));
        if (new Set(rowLabels).size !== rowLabels.length) fail("STAT_INVALID_INPUT", "data.rowLabels must be unique");
      }
      parsedData = { variables, rowLabels, rowCount, components };
      break;
    }
    case "time_series_diagnostics": {
      assertKeys(data, ["values", "time", "seriesLabel", "timeLabel"], "data");
      const values = numericVector(data.values, "data.values", 8);
      if (values.length > LIMITS.maxTimeSeriesRows) fail("STAT_LIMIT_EXCEEDED", `time-series rows exceed ${LIMITS.maxTimeSeriesRows}`);
      let time;
      let explicitTime = false;
      let interval = 1;
      if (data.time === undefined) time = Array.from({ length: values.length }, (_, index) => index + 1);
      else {
        time = numericVector(data.time, "data.time", 8);
        if (time.length !== values.length) fail("STAT_INVALID_INPUT", "data.time length must match data.values");
        explicitTime = true;
        const deltas = time.slice(1).map((value, index) => value - time[index]);
        if (deltas.some((value) => !(value > 0))) fail("STAT_INVALID_INPUT", "data.time must be strictly increasing");
        interval = deltas[0];
        const spacingTolerance = Math.max(1e-12, Math.abs(interval) * 1e-9);
        if (deltas.some((value) => Math.abs(value - interval) > spacingTolerance)) {
          fail("STAT_IRREGULAR_TIME", "time_series_diagnostics requires evenly spaced observations");
        }
      }
      const analyzedLength = values.length - options.differenceOrder;
      if (analyzedLength < 8) fail("STAT_INVALID_INPUT", "differenced time series must retain at least eight observations");
      const maximumAllowedLag = Math.min(LIMITS.maxTimeSeriesLag, analyzedLength - 2);
      const maxLag = options.maxLag === null ? Math.min(20, Math.max(1, Math.floor(analyzedLength / 5))) : options.maxLag;
      if (maxLag > maximumAllowedLag) fail("STAT_INVALID_INPUT", `options.maxLag must not exceed ${maximumAllowedLag} for this series`);
      parsedData = {
        values,
        time,
        explicitTime,
        interval,
        maxLag,
        seriesLabel: label(data.seriesLabel, "Value", "data.seriesLabel"),
        timeLabel: label(data.timeLabel, "Time", "data.timeLabel"),
      };
      break;
    }
    case "meta_analysis": {
      assertKeys(data, ["studies", "effectLabel", "nullValue"], "data");
      if (!Array.isArray(data.studies) || data.studies.length < 2 || data.studies.length > LIMITS.maxMetaStudies) {
        fail("STAT_INVALID_INPUT", `data.studies length must be between 2 and ${LIMITS.maxMetaStudies}`);
      }
      const names = new Set();
      const studies = data.studies.map((rawStudy, index) => {
        const path = `data.studies[${index}]`;
        const study = assertObject(rawStudy, path);
        assertKeys(study, ["label", "effect", "standardError", "variance"], path);
        const studyLabel = label(study.label, `Study ${index + 1}`, `${path}.label`);
        if (names.has(studyLabel)) fail("STAT_INVALID_INPUT", "meta_analysis study labels must be unique");
        names.add(studyLabel);
        const effect = finiteNumber(study.effect, `${path}.effect`);
        const hasStandardError = study.standardError !== undefined;
        const hasVariance = study.variance !== undefined;
        if (hasStandardError === hasVariance) fail("STAT_INVALID_INPUT", `${path} must contain exactly one of standardError or variance`);
        const variance = hasVariance
          ? finiteNumber(study.variance, `${path}.variance`)
          : Math.pow(finiteNumber(study.standardError, `${path}.standardError`), 2);
        if (!(variance > 0)) fail("STAT_INVALID_INPUT", `${path} variance must be positive`);
        const standardError = Math.sqrt(variance);
        if (!Number.isFinite(standardError) || !(standardError > 0)) fail("STAT_NUMERIC_OVERFLOW", `${path} standard error exceeds the numeric boundary`);
        return { label: studyLabel, effect, standardError, variance };
      });
      parsedData = {
        studies,
        effectLabel: label(data.effectLabel, "Effect", "data.effectLabel"),
        nullValue: data.nullValue === undefined ? 0 : finiteNumber(data.nullValue, "data.nullValue"),
      };
      break;
    }
    case "response_surface_regression": {
      assertKeys(data, ["response", "factors"], "data");
      const response = assertObject(data.response, "data.response");
      assertKeys(response, ["name", "unit", "values"], "data.response");
      const values = numericVector(response.values, "data.response.values", 2);
      if (values.length < 9) fail("STAT_INSUFFICIENT_SAMPLE", "response_surface_regression requires at least nine complete observations for six coefficients and residual inference");
      if (values.length > LIMITS.maxResponseSurfaceRows) fail("STAT_LIMIT_EXCEEDED", `response-surface rows exceed ${LIMITS.maxResponseSurfaceRows}`);
      if (!Array.isArray(data.factors) || data.factors.length !== 2) {
        fail("STAT_INVALID_INPUT", "response_surface_regression requires exactly two quantitative factors");
      }
      const seen = new Set();
      const factors = data.factors.map((rawFactor, index) => {
        const factorPath = `data.factors[${index}]`;
        const factor = assertObject(rawFactor, factorPath);
        assertKeys(factor, ["name", "unit", "values", "coding"], factorPath);
        const name = label(factor.name, `Factor ${index + 1}`, `${factorPath}.name`);
        if (seen.has(name)) fail("STAT_INVALID_INPUT", "response-surface factor names must be unique");
        seen.add(name);
        const rawValues = numericVector(factor.values, `${factorPath}.values`, 2);
        if (rawValues.length !== values.length) fail("STAT_INVALID_INPUT", `${factorPath}.values length must match data.response.values`);
        if (!plainObject(factor.coding)) {
          fail("STAT_UNSCALED_INPUT", `${factorPath}.coding is required; raw factors must declare center and halfRange before quadratic fitting`);
        }
        const coding = assertObject(factor.coding, `${factorPath}.coding`);
        assertKeys(coding, ["kind", "center", "halfRange"], `${factorPath}.coding`);
        if (coding.kind !== "center-half-range-to-minus-one-one") {
          fail("STAT_UNSCALED_INPUT", `${factorPath}.coding.kind must be center-half-range-to-minus-one-one`);
        }
        const center = finiteNumber(coding.center, `${factorPath}.coding.center`);
        const halfRange = finiteNumber(coding.halfRange, `${factorPath}.coding.halfRange`);
        if (!(halfRange > 0) || Math.abs(center) + halfRange > 1e15) {
          fail("STAT_UNSCALED_INPUT", `${factorPath}.coding must define a positive finite halfRange inside the numeric surface boundary`);
        }
        const tolerance = 1e-10;
        const codedValues = rawValues.map((rawValue, row) => {
          const coded = (rawValue - center) / halfRange;
          if (!Number.isFinite(coded) || coded < -1 - tolerance || coded > 1 + tolerance) {
            fail("STAT_UNSCALED_INPUT", `${factorPath}.values[${row}] falls outside the declared [-1, 1] coded domain`);
          }
          return Math.max(-1, Math.min(1, Object.is(coded, -0) ? 0 : coded));
        });
        const domain = minMax(codedValues);
        if (domain.max - domain.min < 1) {
          fail("STAT_UNSCALED_INPUT", `${factorPath} must span at least one coded unit inside [-1, 1]`);
        }
        if (new Set(codedValues).size < 3) {
          fail("STAT_RANK_DEFICIENT", `${factorPath} requires at least three distinct coded levels for a quadratic term`);
        }
        return {
          name,
          unit: optionalUnit(factor.unit, `${factorPath}.unit`),
          values: rawValues,
          codedValues,
          coding: { kind: "center-half-range-to-minus-one-one", center, halfRange },
        };
      });
      parsedData = {
        response: {
          name: label(response.name, "Response", "data.response.name"),
          unit: optionalUnit(response.unit, "data.response.unit"),
          values,
        },
        factors,
      };
      break;
    }
    case "gaussian_random_intercept_lmm": {
      assertKeys(data, ["y", "groups", "predictors", "outcomeLabel", "groupLabel", "observationLabels"], "data");
      const y = numericVector(data.y, "data.y", 12);
      if (y.length > LIMITS.maxLmmRows) fail("STAT_LIMIT_EXCEEDED", `gaussian_random_intercept_lmm rows exceed ${LIMITS.maxLmmRows}`);
      const groups = categoryVector(data.groups, "data.groups", 12);
      if (groups.length !== y.length) fail("STAT_INVALID_INPUT", "data.groups length must match data.y");
      const groupLevels = [...new Set(groups)].sort((left, right) => left.localeCompare(right, "en"));
      if (groupLevels.length < 5 || groupLevels.length > LIMITS.maxLmmGroups) {
        fail("STAT_INVALID_INPUT", `gaussian_random_intercept_lmm requires 5 to ${LIMITS.maxLmmGroups} groups`);
      }
      const groupCounts = new Map(groupLevels.map((group) => [group, 0]));
      for (const group of groups) groupCounts.set(group, groupCounts.get(group) + 1);
      const singleton = groupLevels.find((group) => groupCounts.get(group) < 2);
      if (singleton !== undefined) fail("STAT_INSUFFICIENT_SAMPLE", `random-intercept group ${singleton} requires at least two observations`);
      const predictors = regressionPredictors(data.predictors === undefined ? [] : data.predictors, y.length, { allowEmpty: true });
      const expandedColumns = predictors.reduce((count, predictor) => count + (predictor.type === "categorical" ? predictor.levels.length - 1 : 1), 0);
      if (expandedColumns > LIMITS.maxLmmFixedTerms) fail("STAT_LIMIT_EXCEEDED", `expanded LMM fixed-effect terms exceed ${LIMITS.maxLmmFixedTerms}`);
      const duplicatedGroupingPredictor = predictors.find((predictor) => predictor.type === "categorical" && predictor.values.every((value, index) => value === groups[index]));
      if (duplicatedGroupingPredictor) fail("STAT_INVALID_INPUT", `grouping variable cannot also be entered as fixed categorical predictor ${duplicatedGroupingPredictor.name}`);
      if (y.length * (expandedColumns + 2) > LIMITS.maxLmmTotalValues) fail("STAT_LIMIT_EXCEEDED", `LMM design exceeds ${LIMITS.maxLmmTotalValues} values`);
      let observationLabels;
      if (data.observationLabels === undefined) observationLabels = y.map((_, index) => `Row ${index + 1}`);
      else {
        if (!Array.isArray(data.observationLabels) || data.observationLabels.length !== y.length) {
          fail("STAT_INVALID_INPUT", "data.observationLabels length must match data.y");
        }
        observationLabels = data.observationLabels.map((item, index) => label(item, `Row ${index + 1}`, `data.observationLabels[${index}]`));
        if (new Set(observationLabels).size !== observationLabels.length) fail("STAT_INVALID_INPUT", "data.observationLabels must be unique");
      }
      parsedData = {
        y,
        groups,
        groupLevels,
        groupCounts: Object.fromEntries(groupLevels.map((group) => [group, groupCounts.get(group)])),
        predictors,
        observationLabels,
        outcomeLabel: label(data.outcomeLabel, "Outcome", "data.outcomeLabel"),
        groupLabel: label(data.groupLabel, "Group", "data.groupLabel"),
      };
      break;
    }
    default: {
      const definition = METHOD_REGISTRY.byMethod[request.method];
      if (!definition) fail("STAT_INTERNAL", "unreachable method parser");
      parsedData = definition.parse(data, options, HELPERS);
      if (!plainObject(parsedData)) fail("STAT_INTERNAL", `${request.method} parser must return an object`);
      break;
    }
  }

  return { schema: REQUEST_SCHEMA, method: request.method, data: parsedData, options };
}

function sum(values, budget) {
  let total = 0;
  let compensation = 0;
  for (const value of values) {
    if (budget) budget.check();
    const adjusted = value - compensation;
    const next = total + adjusted;
    compensation = (next - total) - adjusted;
    total = next;
  }
  return total;
}

function mean(values, budget) {
  return sum(values, budget) / values.length;
}

function variance(values, sample = true, budget) {
  const center = mean(values, budget);
  let ss = 0;
  let correction = 0;
  for (const value of values) {
    if (budget) budget.check();
    const delta = value - center;
    const term = delta * delta - correction;
    const next = ss + term;
    correction = (next - ss) - term;
    ss = next;
  }
  const divisor = values.length - (sample ? 1 : 0);
  return divisor > 0 ? ss / divisor : 0;
}

function sorted(values) {
  return [...values].sort((a, b) => a - b);
}

function quantileR7(sortedValues, probability) {
  if (sortedValues.length === 1) return sortedValues[0];
  const h = (sortedValues.length - 1) * probability;
  const lower = Math.floor(h);
  const upper = Math.ceil(h);
  return sortedValues[lower] + (h - lower) * (sortedValues[upper] - sortedValues[lower]);
}

function moments(values, budget) {
  const n = values.length;
  const avg = mean(values, budget);
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const value of values) {
    if (budget) budget.check();
    const d = value - avg;
    const d2 = d * d;
    m2 += d2;
    m3 += d2 * d;
    m4 += d2 * d2;
  }
  const sampleVariance = m2 / (n - 1);
  let skewness = null;
  let excessKurtosis = null;
  if (m2 > 0 && n >= 3) skewness = (n * Math.sqrt(n - 1) / (n - 2)) * (m3 / Math.pow(m2, 1.5));
  if (m2 > 0 && n >= 4) {
    excessKurtosis = ((n - 1) / ((n - 2) * (n - 3))) * ((n + 1) * n * m4 / (m2 * m2) - 3 * (n - 1));
  }
  return { n, mean: avg, variance: sampleVariance, sd: Math.sqrt(sampleVariance), skewness, excessKurtosis, m2 };
}

function descriptiveStats(values, budget) {
  const ordered = sorted(values);
  const stats = moments(values, budget);
  return {
    n: values.length,
    mean: stats.mean,
    sd: stats.sd,
    variance: stats.variance,
    min: ordered[0],
    q1: quantileR7(ordered, 0.25),
    median: quantileR7(ordered, 0.5),
    q3: quantileR7(ordered, 0.75),
    max: ordered[ordered.length - 1],
    iqr: quantileR7(ordered, 0.75) - quantileR7(ordered, 0.25),
    skewness: stats.skewness,
    excessKurtosis: stats.excessKurtosis,
  };
}

// Lanczos log-gamma, incomplete beta/gamma, and distribution functions are
// implemented locally so the plugin has no network or native-runtime dependency.
function logGamma(z) {
  const coefficients = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  let x = coefficients[0];
  const shifted = z - 1;
  for (let i = 1; i < coefficients.length; i += 1) x += coefficients[i] / (shifted + i);
  const t = shifted + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(x);
}

function betaContinuedFraction(a, b, x) {
  const maxIterations = 200;
  const epsilon = 3e-14;
  const fpmin = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < fpmin) d = fpmin;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIterations; m += 1) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < epsilon) return h;
  }
  fail("STAT_NUMERIC_FAILURE", "incomplete beta did not converge");
}

function regularizedBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
  if (x < (a + 1) / (a + b + 2)) return front * betaContinuedFraction(a, b, x) / a;
  return 1 - front * betaContinuedFraction(b, a, 1 - x) / b;
}

function gammaSeries(a, x) {
  let sumValue = 1 / a;
  let delta = sumValue;
  let ap = a;
  for (let n = 1; n <= 200; n += 1) {
    ap += 1;
    delta *= x / ap;
    sumValue += delta;
    if (Math.abs(delta) < Math.abs(sumValue) * 1e-14) break;
  }
  return sumValue * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

function gammaContinuedFraction(a, x) {
  const fpmin = 1e-300;
  let b = x + 1 - a;
  let c = 1 / fpmin;
  let d = 1 / Math.max(fpmin, b);
  let h = d;
  for (let i = 1; i <= 200; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = b + an / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

function gammaQ(a, x) {
  if (x < 0 || a <= 0) fail("STAT_INTERNAL", "invalid gamma arguments");
  if (x === 0) return 1;
  return x < a + 1 ? 1 - gammaSeries(a, x) : gammaContinuedFraction(a, x);
}

/**
 * Upper tail of the standard normal, computed directly rather than as 1 - CDF.
 *
 * The previous implementation was the five-term Abramowitz & Stegun 7.1.26 erf approximation,
 * whose stated accuracy is 1.5e-7 ABSOLUTE. That is fine for a CDF near 0.5 and useless in a tail:
 * measured against scipy it was wrong in the fifth significant figure at z = 3 (0.00269993 against
 * 0.00269980), 1.6e-3 relative at z = 5, 7% at z = 8, and returned exactly 0 from z = 10 -- and a
 * p value is precisely the number a paper prints in the tail. Q(z) = 1/2 Q_gamma(1/2, z^2/2) is
 * exact to the working precision of the incomplete gamma, and it never forms 1 - (something tiny),
 * so the tail survives instead of cancelling to zero.
 */
function normalSurvival(x) {
  if (!Number.isFinite(x)) return x > 0 ? 0 : 1;
  if (x === 0) return 0.5;
  const tail = 0.5 * gammaQ(0.5, x * x / 2);
  return x > 0 ? tail : 1 - tail;
}

function normalCdf(x) {
  return normalSurvival(-x);
}

function normalInv(p) {
  if (p <= 0 || p >= 1) fail("STAT_INTERNAL", "normal quantile probability out of range");
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  const high = 1 - low;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > high) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function tCdf(value, df) {
  if (df <= 0) fail("STAT_INTERNAL", "t distribution df must be positive");
  if (!Number.isFinite(value)) return value < 0 ? 0 : 1;
  const x = df / (df + value * value);
  const tail = 0.5 * regularizedBeta(x, df / 2, 0.5);
  return value >= 0 ? 1 - tail : tail;
}

function tCritical(confidenceLevel, df) {
  const target = 1 - (1 - confidenceLevel) / 2;
  let low = 0;
  let high = 1;
  while (tCdf(high, df) < target && high < 1e12) high *= 2;
  if (high >= 1e12 && tCdf(high, df) < target) fail("STAT_NUMERIC_FAILURE", "t critical value exceeded numeric search range");
  for (let i = 0; i < 100; i += 1) {
    const mid = (low + high) / 2;
    if (tCdf(mid, df) < target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * Student t p values taken from the tail itself.
 *
 * The two-sided form used to be 2 (1 - F(|t|)). `tCdf` builds F as 1 - tail, so for a large
 * statistic the tail is lost to rounding, 1 - tail rounds to exactly 1, and the p value comes back
 * as exactly 0: measured, t = 15 on 56 df returned 0 where the true value is 2.9e-21, and t = 22.6
 * returned 0 against 8.0e-30. Zero is not a small number, it is a different claim -- it says the
 * result is impossible under the null rather than merely extreme.
 *
 * The regularized incomplete beta IS twice the one-sided tail, so the two-sided p value is one
 * evaluation with no subtraction anywhere.
 */
function tTailProbability(value, df) {
  if (!Number.isFinite(value)) return 0;
  return 0.5 * regularizedBeta(df / (df + value * value), df / 2, 0.5);
}

function pFromT(value, df, alternative) {
  if (df <= 0) fail("STAT_INTERNAL", "t distribution df must be positive");
  const tail = tTailProbability(value, df);
  if (alternative === "less") return Math.min(1, Math.max(0, value >= 0 ? 1 - tail : tail));
  if (alternative === "greater") return Math.min(1, Math.max(0, value >= 0 ? tail : 1 - tail));
  return Math.min(1, Math.max(0, 2 * tail));
}

function pFromNormal(value, alternative) {
  if (alternative === "less") return normalCdf(value);
  if (alternative === "greater") return normalSurvival(value);
  return Math.min(1, 2 * normalSurvival(Math.abs(value)));
}

function pFromF(value, df1, df2) {
  if (value < 0) return 1;
  return regularizedBeta(df2 / (df2 + df1 * value), df2 / 2, df1 / 2);
}

function pFromChiSquare(value, df) {
  return gammaQ(df / 2, value / 2);
}

function jarqueBera(values, budget) {
  if (values.length < 8) return { name: "Jarque-Bera normality", status: "not_evaluated", reason: "requires n >= 8" };
  const m = moments(values, budget);
  if (m.variance === 0) return { name: "Jarque-Bera normality", status: "failed", reason: "zero variance" };
  const statistic = values.length / 6 * (m.skewness * m.skewness + (m.excessKurtosis * m.excessKurtosis) / 4);
  return { name: "Jarque-Bera normality", status: "evaluated", statistic, df: 2, pValue: pFromChiSquare(statistic, 2), interpretation: "large-sample diagnostic; not a substitute for residual inspection" };
}

function histogram(values, bins = 30) {
  const { min, max } = minMax(values);
  if (min === max) return [{ binStart: min, binEnd: max, count: values.length }];
  const width = (max - min) / bins;
  const counts = Array.from({ length: bins }, () => 0);
  for (const value of values) {
    const index = Math.min(bins - 1, Math.floor((value - min) / width));
    counts[index] += 1;
  }
  return counts.map((count, index) => ({ binStart: min + index * width, binEnd: min + (index + 1) * width, count }));
}

function bivariateBins(x, y, bins = 32) {
  const { min: minX, max: maxX } = minMax(x);
  const { min: minY, max: maxY } = minMax(y);
  if (minX === maxX || minY === maxY) return [];
  const widthX = (maxX - minX) / bins;
  const widthY = (maxY - minY) / bins;
  const counts = new Map();
  for (let index = 0; index < x.length; index += 1) {
    const bx = Math.min(bins - 1, Math.floor((x[index] - minX) / widthX));
    const by = Math.min(bins - 1, Math.floor((y[index] - minY) / widthY));
    const key = `${bx}:${by}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, count]) => {
    const [bx, by] = key.split(":").map(Number);
    return { x0: minX + bx * widthX, x1: minX + (bx + 1) * widthX, y0: minY + by * widthY, y1: minY + (by + 1) * widthY, count };
  });
}

function minMax(values) {
  let min = values[0];
  let max = values[0];
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] < min) min = values[index];
    if (values[index] > max) max = values[index];
  }
  return { min, max };
}

function tableArtifact(title, caption, columns, rows, notes = [], role = "publication-table") {
  if (rows.length > LIMITS.maxArtifactRows) fail("STAT_LIMIT_EXCEEDED", "table artifact exceeds row cap");
  return {
    kind: "table",
    role,
    schema: TABLE_SCHEMA,
    payload: { schema: TABLE_SCHEMA, title, caption, columns, rows, notes },
  };
}

/**
 * A publication figure's default plotting area.
 *
 * Single-column journal width at a readable aspect. It is a DEFAULT: a method that knows better --
 * a tall forest, a faceted panel -- sets its own and this stays out of the way.
 */
const DEFAULT_CHART_SIZE = Object.freeze({ width: 560, height: 320 });

/**
 * The two Vega-Lite defaults that make a figure unreadable, turned off.
 *
 * `labelLimit` truncates an axis label at 180px with an ellipsis. On screen that is a tolerable
 * space saving; in a paper it is a figure that will not say what it plotted -- the effect-size
 * figure came out listing "common language effec...", "probability of superi..." and
 * "Hedges g (approximate...", four rows the reader cannot identify. A figure that cannot name its
 * own rows is not evidence. Zero means no limit, and the canvas grows to fit because sizing is
 * `pad`.
 *
 * A facet row header is the same decision: with the label on the left it becomes a wide empty
 * gutter, and truncating it hides which group the panel is. Put it above the panel it names.
 *
 * This is deliberately the smallest possible config -- legibility only, no colours, no fonts, no
 * spacing. Visual styling belongs to the surface that renders the figure and merges its own config
 * over this one.
 */
const FIGURE_LEGIBILITY_CONFIG = Object.freeze({
  axis: { labelLimit: 0 },
  // A category axis reads horizontally. Vega-Lite's default stands discrete labels on end, and a
  // rendered figure showed "Control" and "Treated" -- two values -- turned ninety degrees for no
  // reason. A spec that genuinely needs an angle (many long categories) still overrides this.
  axisX: { labelAngle: 0 },
  // A figure title sits over the figure. Vega-Lite anchors a multi-panel title to the start, and a
  // rendered paper showed the title hanging off the left edge, clear of the panels it named.
  title: { anchor: "middle" },
  legend: { labelLimit: 0 },
  header: { labelLimit: 0, labelOrient: "top", labelAnchor: "start", titleOrient: "top" },
});

/**
 * Wraps a method's Vega-Lite spec as a figure artifact.
 *
 * Two sizing decisions live here, and they were both wrong before.
 *
 * `autosize: fit` used to be applied to every chart. `fit` shrinks the PLOTTING AREA until the whole
 * view -- title, axis labels, legend -- fits inside the declared width, and almost no method declared
 * one, so the default 200 was split between the furniture and the data. Measured across the shipped
 * fixtures: 70 of 175 figures rendered a plotting area under 120px, and the Fama-MacBeth premium
 * forest came out 8px wide with three risk premia stacked on top of each other at 0.00. Every one of
 * them was a valid Vega-Lite spec and every contract was green. `pad` is the publication behaviour:
 * the plotting area is what you asked for and the canvas grows to hold the labels.
 *
 * The size default matters for the same reason -- a figure with no width is not asking for 200px,
 * it simply has not said. Concat, facet and repeat specs are left alone: their sizing belongs to the
 * inner view, and putting a width at the top level of one of those means something different.
 */
function vegaArtifact(role, title, spec) {
  const composed = spec.facet !== undefined || spec.vconcat !== undefined || spec.hconcat !== undefined
    || spec.concat !== undefined || spec.repeat !== undefined || spec.spec !== undefined;
  const size = composed || spec.width !== undefined || spec.height !== undefined ? {} : DEFAULT_CHART_SIZE;
  return {
    kind: "vega-lite",
    role,
    schema: "vega-lite/v6",
    payload: { $schema: VEGA_SCHEMA, title, background: "white", autosize: { type: "pad", contains: "padding" }, ...size, config: FIGURE_LEGIBILITY_CONFIG, ...spec },
  };
}

function summaryChart(groups, confidenceLevel) {
  const rows = groups.map((group) => {
    const n = group.values.length;
    const avg = mean(group.values);
    const sd = Math.sqrt(variance(group.values));
    const half = tCritical(confidenceLevel, n - 1) * sd / Math.sqrt(n);
    return { group: group.name, mean: avg, lower: avg - half, upper: avg + half, n };
  });
  return vegaArtifact("estimate-plot", `Group means with ${Math.round(confidenceLevel * 100)}% confidence intervals`, {
    data: { values: rows },
    layer: [
      { mark: { type: "rule", strokeWidth: 2 }, encoding: { x: { field: "group", type: "nominal", title: "Group", sort: null }, y: { field: "lower", type: "quantitative", title: "Mean", scale: MEASUREMENT_SCALE }, y2: { field: "upper" } } },
      { mark: { type: "point", filled: true, size: 80 }, encoding: { x: { field: "group", type: "nominal", sort: null }, y: { field: "mean", type: "quantitative", scale: MEASUREMENT_SCALE }, tooltip: [{ field: "group" }, { field: "mean", format: ".4g" }, { field: "lower", format: ".4g" }, { field: "upper", format: ".4g" }, { field: "n" }] } },
    ],
  });
}

/**
 * Axis settings for a value that lives on the data's own measurement scale.
 *
 * Vega-Lite anchors a quantitative axis at zero by default. For a count or a proportion that is
 * correct, but for a mean, an adjusted mean, a rate, or a return level, zero is an arbitrary point
 * on the instrument. Anchoring there squeezes the estimates and their confidence intervals into a
 * sliver at the top of the frame, so the interval a reader is supposed to judge becomes invisible.
 * These figures are bound into manuscripts, so a flattened interval is a published defect.
 */
const MEASUREMENT_SCALE = Object.freeze({ zero: false, nice: true });

function validateArtifact(artifact) {
  assertObject(artifact, "artifact");
  if (artifact.kind === "table") {
    const payload = assertObject(artifact.payload, "artifact.payload");
    if (payload.schema !== TABLE_SCHEMA || !Array.isArray(payload.columns) || !Array.isArray(payload.rows)) fail("STAT_INTERNAL", "invalid table artifact");
    const keys = new Set(payload.columns.map((column) => column.key));
    for (const row of payload.rows) {
      assertObject(row, "artifact.payload.rows[]");
      for (const key of Object.keys(row)) if (!keys.has(key)) fail("STAT_INTERNAL", `table row has undeclared key: ${key}`);
      for (const value of Object.values(row)) {
        if (value !== null && !["string", "number", "boolean"].includes(typeof value)) fail("STAT_INTERNAL", "table cells must be scalar values");
        if (typeof value === "number" && !Number.isFinite(value)) fail("STAT_INTERNAL", "table cells must be finite");
      }
    }
  } else if (artifact.kind === "vega-lite") {
    if (artifact.schema !== "vega-lite/v6" || artifact.payload?.$schema !== VEGA_SCHEMA) fail("STAT_INTERNAL", "invalid Vega-Lite artifact");
    const serialized = canonicalJson(artifact.payload);
    if (/\bhttps?:\/\//u.test(serialized.replace(VEGA_SCHEMA, ""))) fail("STAT_INTERNAL", "Vega artifact may not reference remote data");
  } else if (artifact.kind === "numeric-surface") {
    if (artifact.schema !== NUMERIC_SURFACE_SOURCE_SCHEMA) fail("STAT_INTERNAL", "invalid numeric-surface source schema");
    const payload = assertExactKeys(artifact.payload, ["schema", "chartFamily", "title", "grid", "observations", "support", "axes", "appearance", "viewState", "method", "model"], "artifact.payload");
    if (payload.schema !== NUMERIC_SURFACE_SOURCE_SCHEMA || payload.chartFamily !== "surface3d" || payload.method !== "response_surface_regression") {
      fail("STAT_INTERNAL", "invalid numeric-surface source identity");
    }
    if (typeof payload.title !== "string" || !payload.title || typeof payload.model !== "string" || !payload.model) fail("STAT_INTERNAL", "invalid numeric-surface source text");
    const grid = assertExactKeys(payload.grid, ["x", "y", "z", "valueCount", "zMin", "zMax", "gridSha256", "supportMask", "supportedValueCount", "supportMaskSha256"], "artifact.payload.grid");
    if (!Array.isArray(grid.x) || !Array.isArray(grid.y) || grid.x.length < 2 || grid.y.length < 2
      || grid.x.length > LIMITS.maxResponseSurfaceGridSize || grid.y.length > LIMITS.maxResponseSurfaceGridSize) {
      fail("STAT_INTERNAL", "invalid numeric-surface grid axes");
    }
    const validateAxisValues = (values, path) => values.map((value, index) => {
      if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e15) fail("STAT_INTERNAL", `${path}[${index}] is invalid`);
      if (index > 0 && !(value > values[index - 1])) fail("STAT_INTERNAL", `${path} must be strictly increasing`);
      return Object.is(value, -0) ? 0 : value;
    });
    const gridX = validateAxisValues(grid.x, "artifact.payload.grid.x");
    const gridY = validateAxisValues(grid.y, "artifact.payload.grid.y");
    if (!Array.isArray(grid.z) || grid.z.length !== gridY.length || grid.z.some((row) => !Array.isArray(row) || row.length !== gridX.length)) {
      fail("STAT_INTERNAL", "invalid numeric-surface grid z shape");
    }
    const gridZ = grid.z.map((row, yIndex) => row.map((value, xIndex) => {
      if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e15) fail("STAT_INTERNAL", `artifact.payload.grid.z[${yIndex}][${xIndex}] is invalid`);
      return Object.is(value, -0) ? 0 : value;
    }));
    if (grid.valueCount !== gridX.length * gridY.length || grid.gridSha256 !== rawSha256({ x: gridX, y: gridY, z: gridZ })) {
      fail("STAT_INTERNAL", "numeric-surface grid count or digest mismatch");
    }
    const zValues = gridZ.flat();
    if (grid.zMin !== Math.min(...zValues) || grid.zMax !== Math.max(...zValues) || grid.zMin === grid.zMax) fail("STAT_INTERNAL", "numeric-surface z domain mismatch");
    if (!Array.isArray(grid.supportMask) || grid.supportMask.length !== gridY.length
      || grid.supportMask.some((row) => !Array.isArray(row) || row.length !== gridX.length || row.some((value) => typeof value !== "boolean"))) {
      fail("STAT_INTERNAL", "invalid numeric-surface support mask shape");
    }
    const supportedValueCount = grid.supportMask.flat().filter(Boolean).length;
    if (grid.supportedValueCount !== supportedValueCount || grid.supportMaskSha256 !== rawSha256(grid.supportMask)) {
      fail("STAT_INTERNAL", "numeric-surface support mask count or digest mismatch");
    }
    const observations = assertExactKeys(payload.observations, ["points", "pointsSha256"], "artifact.payload.observations");
    if (!Array.isArray(observations.points) || observations.points.length < 9 || observations.points.length > LIMITS.maxResponseSurfaceRows) {
      fail("STAT_INTERNAL", "invalid numeric-surface observations");
    }
    for (const [index, rawPoint] of observations.points.entries()) {
      const point = assertExactKeys(rawPoint, ["row", "x", "y", "z", "residual", "id"], `artifact.payload.observations.points[${index}]`);
      if (point.row !== index + 1 || typeof point.id !== "string" || !point.id) fail("STAT_INTERNAL", "numeric-surface observation identity mismatch");
      for (const field of ["x", "y", "z", "residual"]) {
        if (typeof point[field] !== "number" || !Number.isFinite(point[field]) || Math.abs(point[field]) > 1e15) fail("STAT_INTERNAL", `numeric-surface observation ${field} is invalid`);
      }
    }
    if (observations.pointsSha256 !== rawSha256(observations.points)) fail("STAT_INTERNAL", "numeric-surface observation digest mismatch");
    const support = assertExactKeys(payload.support, ["algorithm", "hull", "hullSha256", "maskRule", "receiptSha256"], "artifact.payload.support");
    if (support.algorithm !== "monotone-chain-2d/v1" || support.maskRule !== "grid-point-inside-or-boundary/v1" || !Array.isArray(support.hull)) {
      fail("STAT_INTERNAL", "numeric-surface support algorithm mismatch");
    }
    const expectedHull = monotoneChainHull(observations.points.map((point) => ({ x: point.x, y: point.y })));
    if (canonicalJson(support.hull) !== canonicalJson(expectedHull) || support.hullSha256 !== rawSha256(expectedHull)) {
      fail("STAT_INTERNAL", "numeric-surface hull mismatch");
    }
    const expectedMask = gridY.map((rawSecond) => gridX.map((rawFirst) => pointInsideOrOnConvexHull({ x: rawFirst, y: rawSecond }, expectedHull)));
    if (canonicalJson(grid.supportMask) !== canonicalJson(expectedMask)) fail("STAT_INTERNAL", "numeric-surface support mask geometry mismatch");
    const receiptCore = { algorithm: support.algorithm, hullSha256: support.hullSha256, maskRule: support.maskRule, supportMaskSha256: grid.supportMaskSha256, supportedValueCount, pointsSha256: observations.pointsSha256 };
    if (support.receiptSha256 !== rawSha256(receiptCore)) fail("STAT_INTERNAL", "numeric-surface support receipt mismatch");
    const axes = assertExactKeys(payload.axes, ["x", "y", "z"], "artifact.payload.axes");
    for (const axisName of ["x", "y", "z"]) {
      const axis = assertExactKeys(axes[axisName], ["title", "unit"], `artifact.payload.axes.${axisName}`);
      if (typeof axis.title !== "string" || !axis.title || (axis.unit !== null && (typeof axis.unit !== "string" || !axis.unit))) fail("STAT_INTERNAL", "invalid numeric-surface axis metadata");
    }
    const appearance = assertExactKeys(payload.appearance, ["palette", "wireframe", "showObservedPoints"], "artifact.payload.appearance");
    if (!["viridis", "cividis", "blue-red", "grayscale"].includes(appearance.palette) || typeof appearance.wireframe !== "boolean" || appearance.showObservedPoints !== true) {
      fail("STAT_INTERNAL", "invalid numeric-surface appearance");
    }
    const viewState = assertExactKeys(payload.viewState, ["cameraPosition", "target", "up"], "artifact.payload.viewState");
    for (const field of ["cameraPosition", "target", "up"]) {
      if (!Array.isArray(viewState[field]) || viewState[field].length !== 3 || viewState[field].some((value) => typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e15)) {
        fail("STAT_INTERNAL", `invalid numeric-surface ${field}`);
      }
    }
    if (canonicalJson(viewState) !== canonicalJson({ cameraPosition: [3.2, 2.5, 3.4], target: [0, 0, 0], up: [0, 1, 0] })) {
      fail("STAT_INTERNAL", "numeric-surface viewState must use normalized renderer scene coordinates");
    }
  } else fail("STAT_INTERNAL", `unsupported artifact kind: ${artifact.kind}`);
}

function correlation(x, y, budget) {
  const mx = mean(x, budget);
  const my = mean(y, budget);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < x.length; i += 1) {
    budget.check();
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  if (sxx === 0 || syy === 0) fail("STAT_DEGENERATE", "correlation is undefined for a constant vector");
  return Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
}

function averageRanks(values) {
  const indexed = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value || a.index - b.index);
  const ranks = Array(values.length);
  const tieSizes = [];
  let i = 0;
  while (i < indexed.length) {
    let j = i + 1;
    while (j < indexed.length && indexed[j].value === indexed[i].value) j += 1;
    const rank = (i + 1 + j) / 2;
    for (let k = i; k < j; k += 1) ranks[indexed[k].index] = rank;
    if (j - i > 1) tieSizes.push(j - i);
    i = j;
  }
  return { ranks, tieSizes };
}

function analyzeDescriptive(data, options, budget) {
  const stats = descriptiveStats(data.values, budget);
  const rows = Object.entries(stats).map(([metric, value]) => ({ metric, value }));
  return {
    sample: { n: stats.n, variables: 1 },
    estimates: stats,
    tests: [],
    confidenceIntervals: [{ parameter: "mean", level: options.confidenceLevel, lower: stats.mean - tCritical(options.confidenceLevel, stats.n - 1) * stats.sd / Math.sqrt(stats.n), upper: stats.mean + tCritical(options.confidenceLevel, stats.n - 1) * stats.sd / Math.sqrt(stats.n), method: "Student t" }],
    effectSizes: [],
    assumptions: [],
    diagnostics: [jarqueBera(data.values, budget)],
    artifacts: [
      tableArtifact(`Descriptive statistics: ${data.label}`, `Sample descriptive statistics for ${data.label}. Quantiles use the R-7 definition.`, [{ key: "metric", label: "Metric", type: "string" }, { key: "value", label: "Value", type: "number" }], rows, ["SD and variance use n - 1."]),
      vegaArtifact("distribution", `Distribution of ${data.label}`, { data: { values: histogram(data.values) }, mark: "bar", encoding: { x: { field: "binStart", type: "quantitative", title: data.label, bin: "binned" }, x2: { field: "binEnd" }, y: { field: "count", type: "quantitative", title: "Count" }, tooltip: [{ field: "binStart", format: ".4g" }, { field: "binEnd", format: ".4g" }, { field: "count" }] } }),
    ],
  };
}

function distributionFitDefinition(candidate, values, budget) {
  const n = values.length;
  const logTwoPi = Math.log(2 * Math.PI);
  let parameters;
  let parameterCount;
  let logLikelihood;
  let cdf;
  let quantile;

  if (candidate === "normal") {
    const location = mean(values, budget);
    const varianceMle = variance(values, false, budget);
    const scale = Math.sqrt(varianceMle);
    if (!Number.isFinite(location) || !(scale > 0) || !Number.isFinite(scale)) {
      fail("STAT_NUMERIC_FAILURE", "normal maximum-likelihood parameters are not finite and non-degenerate");
    }
    logLikelihood = -0.5 * n * (logTwoPi + 1 + Math.log(varianceMle));
    parameters = { location, scale };
    parameterCount = 2;
    cdf = (value) => normalCdf((value - location) / scale);
    quantile = (probability) => location + scale * normalInv(probability);
  } else if (candidate === "lognormal") {
    const logValues = values.map((value) => Math.log(value));
    const logLocation = mean(logValues, budget);
    const logVarianceMle = variance(logValues, false, budget);
    const shape = Math.sqrt(logVarianceMle);
    const scale = Math.exp(logLocation);
    if (!Number.isFinite(logLocation) || !(shape > 0) || !Number.isFinite(shape) || !(scale > 0) || !Number.isFinite(scale)) {
      fail("STAT_NUMERIC_FAILURE", "lognormal maximum-likelihood parameters are not finite and non-degenerate");
    }
    logLikelihood = -0.5 * n * (logTwoPi + 1 + Math.log(logVarianceMle)) - sum(logValues, budget);
    parameters = { shape, location: 0, scale, logLocation };
    parameterCount = 2;
    cdf = (value) => value <= 0 ? 0 : normalCdf((Math.log(value) - logLocation) / shape);
    quantile = (probability) => Math.exp(logLocation + shape * normalInv(probability));
  } else if (candidate === "exponential") {
    const scale = mean(values, budget);
    if (!(scale > 0) || !Number.isFinite(scale)) {
      fail("STAT_NUMERIC_FAILURE", "exponential maximum-likelihood scale is not finite and positive");
    }
    const rate = 1 / scale;
    logLikelihood = n * Math.log(rate) - rate * sum(values, budget);
    parameters = { rate, location: 0, scale };
    parameterCount = 1;
    cdf = (value) => value < 0 ? 0 : -Math.expm1(-value / scale);
    quantile = (probability) => -scale * Math.log1p(-probability);
  } else {
    fail("STAT_INTERNAL", "unreachable distribution family");
  }

  if (!Number.isFinite(logLikelihood)) fail("STAT_NUMERIC_FAILURE", `${candidate} log likelihood is not finite`);
  const aic = 2 * parameterCount - 2 * logLikelihood;
  const bic = Math.log(n) * parameterCount - 2 * logLikelihood;
  if (![aic, bic].every(Number.isFinite)) fail("STAT_NUMERIC_FAILURE", `${candidate} information criteria are not finite`);
  return { candidate, parameters, parameterCount, logLikelihood, aic, bic, cdf, quantile };
}

function distributionKsRows(ordered, fit, budget) {
  const n = ordered.length;
  let dPlus = 0;
  let dMinus = 0;
  const qqRows = [];
  const ppRows = [];
  for (let index = 0; index < n; index += 1) {
    budget.check();
    const observed = ordered[index];
    const plottingPosition = (index + 0.5) / n;
    const fittedCdf = Math.min(1, Math.max(0, fit.cdf(observed)));
    const theoretical = fit.quantile(plottingPosition);
    if (![fittedCdf, theoretical].every(Number.isFinite)) {
      fail("STAT_NUMERIC_FAILURE", `${fit.candidate} Figure rows contain a non-finite fitted value`);
    }
    dPlus = Math.max(dPlus, (index + 1) / n - fittedCdf);
    dMinus = Math.max(dMinus, fittedCdf - index / n);
    qqRows.push({ candidate: fit.candidate, rank: index + 1, probability: plottingPosition, theoretical, observed, reference: theoretical });
    ppRows.push({ candidate: fit.candidate, rank: index + 1, observed, empiricalProbability: plottingPosition, fittedProbability: fittedCdf, reference: fittedCdf });
  }
  return { statistic: Math.max(dPlus, dMinus), dPlus, dMinus, qqRows, ppRows };
}

function analyzeDistributionFit(data, _options, budget) {
  const ordered = sorted(data.values);
  const fits = data.candidates.map((candidate) => distributionFitDefinition(candidate, data.values, budget));
  const qqRows = [];
  const ppRows = [];
  const comparisons = fits.map((fit) => {
    const ks = distributionKsRows(ordered, fit, budget);
    qqRows.push(...ks.qqRows);
    ppRows.push(...ks.ppRows);
    return {
      candidate: fit.candidate,
      parameters: fit.parameters,
      parameterCount: fit.parameterCount,
      logLikelihood: fit.logLikelihood,
      aic: fit.aic,
      bic: fit.bic,
      goodnessOfFit: {
        method: "one-sample Kolmogorov-Smirnov descriptive statistic",
        statistic: ks.statistic,
        dPlus: ks.dPlus,
        dMinus: ks.dMinus,
        pValue: null,
        pValueStatus: "not-reported-parameters-estimated",
        decision: null,
        calibrationRequired: "parametric bootstrap or family-appropriate correction using the complete fitting procedure",
      },
    };
  });
  const bestByAic = comparisons.reduce((best, item) => item.aic < best.aic ? item : best).candidate;
  const bestByBic = comparisons.reduce((best, item) => item.bic < best.bic ? item : best).candidate;
  const comparisonRows = comparisons.map((fit) => ({
    candidate: fit.candidate,
    parameters: Object.entries(fit.parameters).map(([name, value]) => `${name}=${value}`).join("; "),
    parameterCount: fit.parameterCount,
    logLikelihood: fit.logLikelihood,
    aic: fit.aic,
    bic: fit.bic,
    ksStatistic: fit.goodnessOfFit.statistic,
    ksPValue: null,
    ksPValueStatus: fit.goodnessOfFit.pValueStatus,
  }));
  const rendererDataContract = {
    inlineRows: "all",
    sampling: "none",
    aggregation: "none",
    observationCount: data.values.length,
    candidateCount: comparisons.length,
    observationValuesHash: sha256(data.values),
    comparisonRowsHash: sha256(comparisonRows),
    qqRowCount: qqRows.length,
    qqRowsHash: sha256(qqRows),
    ppRowCount: ppRows.length,
    ppRowsHash: sha256(ppRows),
    figureBindings: [
      { templateId: "distribution-fit-qq", artifactRole: "distribution-fit-qq", rowsHash: sha256(qqRows) },
      { templateId: "distribution-fit-pp", artifactRole: "distribution-fit-pp", rowsHash: sha256(ppRows) },
    ],
  };
  const tests = comparisons.map((fit) => ({
    name: `${fit.candidate} Kolmogorov-Smirnov descriptive goodness-of-fit`,
    statistic: fit.goodnessOfFit.statistic,
    distribution: "not-calibrated-after-parameter-estimation",
    pValue: null,
    pValueStatus: fit.goodnessOfFit.pValueStatus,
    decision: null,
  }));
  return {
    sample: { n: data.values.length, variables: 1, label: data.label, candidates: [...data.candidates] },
    estimates: { comparisons, bestByAic, bestByBic, rendererDataContract },
    tests,
    confidenceIntervals: [],
    effectSizes: [],
    assumptions: [
      { name: "independent identically distributed observations", status: "requires_design_review" },
      { name: "complete finite observations", status: "enforced", missingValuesAccepted: false },
      { name: "candidate support", status: "enforced", detail: "lognormal values are strictly positive; exponential values are non-negative with location fixed at zero" },
      { name: "candidate family specification", status: "explicit", candidates: [...data.candidates] },
    ],
    diagnostics: [
      { name: "goodness-of-fit calibration boundary", status: "not_calibrated", detail: "KS statistics are descriptive because each candidate's parameters were estimated from these observations. No standard KS p value or accept/reject decision is reported; use a parametric bootstrap or a validated family-specific correction." },
      { name: "information-criterion boundary", status: "evaluated", detail: "AIC and BIC compare only the explicitly supplied candidate families fitted to identical observations; they do not establish absolute fit or scientific validity." },
      { name: "sample-size review", status: data.values.length < 20 ? "limited" : "reviewed", n: data.values.length, detail: data.values.length < 20 ? "fewer than twenty observations makes graphical and asymptotic fit review fragile" : "graphical fit rows preserve every observation" },
      { name: "renderer exact-data contract", status: "verified", ...rendererDataContract },
    ],
    artifacts: [
      tableArtifact(
        `Probability distribution fits: ${data.label}`,
        "Maximum-likelihood fits for the explicitly requested families. KS p values and decisions are withheld because parameters were estimated from the same observations.",
        [
          { key: "candidate", label: "Candidate", type: "string" },
          { key: "parameters", label: "MLE parameters", type: "string" },
          { key: "parameterCount", label: "k", type: "number" },
          { key: "logLikelihood", label: "Log likelihood", type: "number" },
          { key: "aic", label: "AIC", type: "number" },
          { key: "bic", label: "BIC", type: "number" },
          { key: "ksStatistic", label: "KS D", type: "number" },
          { key: "ksPValue", label: "KS p", type: "number" },
          { key: "ksPValueStatus", label: "KS p status", type: "string" },
        ],
        comparisonRows,
        ["Location is fixed at zero for lognormal and exponential candidates.", "AIC and BIC rank only the declared candidates; KS D is descriptive without fitted-parameter calibration."],
        "distribution-fit-comparison-table",
      ),
      vegaArtifact("distribution-fit-qq", `Q-Q fit diagnostics: ${data.label}`, {
        data: { values: qqRows },
        facet: { column: { field: "candidate", type: "nominal", title: "Candidate" } },
        spec: {
          layer: [
            { mark: { type: "line", color: "#7A7672", strokeDash: [5, 4] }, encoding: { x: { field: "theoretical", type: "quantitative", title: "Theoretical quantile" }, y: { field: "reference", type: "quantitative", title: `Observed ${data.label}` } } },
            { mark: { type: "point", filled: true, size: 55, color: "#285F8F" }, encoding: { x: { field: "theoretical", type: "quantitative" }, y: { field: "observed", type: "quantitative" }, tooltip: [{ field: "candidate" }, { field: "rank" }, { field: "probability", format: ".4f" }, { field: "theoretical", format: ".6g" }, { field: "observed", format: ".6g" }] } },
          ],
        },
      }),
      vegaArtifact("distribution-fit-pp", `P-P fit diagnostics: ${data.label}`, {
        data: { values: ppRows },
        facet: { column: { field: "candidate", type: "nominal", title: "Candidate" } },
        spec: {
          layer: [
            { mark: { type: "line", color: "#7A7672", strokeDash: [5, 4] }, encoding: { x: { field: "fittedProbability", type: "quantitative", title: "Fitted cumulative probability", scale: { domain: [0, 1] } }, y: { field: "reference", type: "quantitative", title: "Empirical plotting position", scale: { domain: [0, 1] } } } },
            { mark: { type: "point", filled: true, size: 55, color: "#A36D47" }, encoding: { x: { field: "fittedProbability", type: "quantitative" }, y: { field: "empiricalProbability", type: "quantitative" }, tooltip: [{ field: "candidate" }, { field: "rank" }, { field: "fittedProbability", format: ".6f" }, { field: "empiricalProbability", format: ".6f" }] } },
          ],
        },
      }),
    ],
  };
}

function exactPermutationP(x, y, statisticFn, observed, alternative, budget) {
  const used = Array(y.length).fill(false);
  const permutation = Array(y.length);
  let total = 0;
  let extreme = 0;
  const visit = (depth) => {
    if (depth === y.length) {
      budget.check();
      const statistic = statisticFn(x, permutation, budget);
      total += 1;
      if (alternative === "greater" ? statistic >= observed - 1e-12 : alternative === "less" ? statistic <= observed + 1e-12 : Math.abs(statistic) >= Math.abs(observed) - 1e-12) extreme += 1;
      return;
    }
    for (let index = 0; index < y.length; index += 1) {
      if (used[index]) continue;
      used[index] = true;
      permutation[depth] = y[index];
      visit(depth + 1);
      used[index] = false;
    }
  };
  visit(0);
  return { pValue: extreme / total, permutations: total };
}

function kendallCore(x, y, budget) {
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < x.length - 1; i += 1) {
    for (let j = i + 1; j < x.length; j += 1) {
      budget.check();
      const dx = Math.sign(x[i] - x[j]);
      const dy = Math.sign(y[i] - y[j]);
      if (dx && dy) {
        if (dx === dy) concordant += 1;
        else discordant += 1;
      }
    }
  }
  const xTies = averageRanks(x).tieSizes;
  const yTies = averageRanks(y).tieSizes;
  const n0 = x.length * (x.length - 1) / 2;
  const n1 = sum(xTies.map((size) => size * (size - 1) / 2));
  const n2 = sum(yTies.map((size) => size * (size - 1) / 2));
  const denominator = Math.sqrt((n0 - n1) * (n0 - n2));
  if (!(denominator > 0)) fail("STAT_DEGENERATE", "Kendall correlation is undefined when either variable is constant");
  const s = concordant - discordant;
  const term1 = (x.length * (x.length - 1) * (2 * x.length + 5)
    - sum(xTies.map((size) => size * (size - 1) * (2 * size + 5)))
    - sum(yTies.map((size) => size * (size - 1) * (2 * size + 5)))) / 18;
  const term2 = x.length > 1 ? sum(xTies.map((size) => size * (size - 1))) * sum(yTies.map((size) => size * (size - 1))) / (2 * x.length * (x.length - 1)) : 0;
  const term3 = x.length > 2 ? sum(xTies.map((size) => size * (size - 1) * (size - 2))) * sum(yTies.map((size) => size * (size - 1) * (size - 2))) / (9 * x.length * (x.length - 1) * (x.length - 2)) : 0;
  const varianceS = term1 + term2 + term3;
  if (!(varianceS > 0)) fail("STAT_DEGENERATE", "Kendall null variance is zero after tie correction");
  return { coefficient: s / denominator, s, varianceS, denominator, concordant, discordant, xTies, yTies };
}

function analyzeCorrelation(method, data, options, budget) {
  if (method === "kendall_correlation") {
    const core = kendallCore(data.x, data.y, budget);
    const exactEligible = data.x.length <= 9 && core.xTies.length === 0 && core.yTies.length === 0;
    if (options.pValueMethod === "exact" && !exactEligible) fail("STAT_EXACT_UNAVAILABLE", "exact Kendall permutation inference requires n <= 9 and no ties");
    const useExact = options.pValueMethod !== "asymptotic" && exactEligible;
    const exact = useExact ? exactPermutationP(data.x, data.y, (left, right, innerBudget) => kendallCore(left, right, innerBudget).coefficient, core.coefficient, options.alternative, budget) : null;
    const z = core.s / Math.sqrt(core.varianceS);
    const pValue = exact ? exact.pValue : pFromNormal(z, options.alternative);
    const se = Math.sqrt(core.varianceS) / core.denominator;
    const critical = normalInv(1 - (1 - options.confidenceLevel) / 2);
    const lower = Math.max(-1, core.coefficient - critical * se);
    const upper = Math.min(1, core.coefficient + critical * se);
    return {
      sample: { n: data.x.length, variables: 2 },
      estimates: { coefficient: core.coefficient, concordantPairs: core.concordant, discordantPairs: core.discordant },
      tests: [{ name: "Kendall tau-b", statistic: core.s, standardizedStatistic: z, distribution: exact ? "exact permutation" : "normal approximation with tie correction", pValue, alternative: options.alternative, pValueMethod: exact ? "exact" : "asymptotic", ...(exact ? { permutations: exact.permutations } : {}) }],
      confidenceIntervals: [{ parameter: "Kendall tau-b", level: options.confidenceLevel, lower, upper, method: "normal approximation using tie-corrected null variance" }],
      effectSizes: [{ name: "Kendall tau-b", estimate: core.coefficient }],
      assumptions: [{ name: "independent paired observations", status: "requires_design_review" }, { name: "ordinal variables and monotonic association", status: "requires_domain_review" }],
      diagnostics: [{ name: "ties", status: core.xTies.length || core.yTies.length ? "present" : "absent", xTieBlocks: core.xTies.length, yTieBlocks: core.yTies.length }, { name: "p-value method", requested: options.pValueMethod, used: exact ? "exact" : "asymptotic", exactEligibility: "n <= 9 and no ties" }],
      artifacts: [
        tableArtifact(`Kendall tau-b: ${data.xLabel} and ${data.yLabel}`, "Rank association with tie-aware inference.", [{ key: "coefficient", label: "Tau-b", type: "number" }, { key: "lower", label: "CI lower", type: "number" }, { key: "upper", label: "CI upper", type: "number" }, { key: "statistic", label: "S", type: "number" }, { key: "z", label: "z", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "method", label: "P-value method", type: "string" }, { key: "n", label: "N", type: "number" }], [{ coefficient: core.coefficient, lower, upper, statistic: core.s, z, pValue, method: exact ? "exact" : "asymptotic", n: data.x.length }]),
        vegaArtifact("relationship", `${data.yLabel} by ${data.xLabel}`, { data: { values: bivariateBins(data.x, data.y) }, mark: "rect", encoding: { x: { field: "x0", type: "quantitative", title: data.xLabel, bin: "binned" }, x2: { field: "x1" }, y: { field: "y0", type: "quantitative", title: data.yLabel, bin: "binned" }, y2: { field: "y1" }, color: { field: "count", type: "quantitative", title: "N" }, tooltip: [{ field: "count" }] } }),
      ],
    };
  }
  let x = data.x;
  let y = data.y;
  let ties = { x: [], y: [] };
  if (method === "spearman_correlation") {
    const rx = averageRanks(x);
    const ry = averageRanks(y);
    x = rx.ranks;
    y = ry.ranks;
    ties = { x: rx.tieSizes, y: ry.tieSizes };
  }
  const r = correlation(x, y, budget);
  const df = x.length - 2;
  const perfect = Math.abs(r) === 1;
  const statistic = perfect ? null : r * Math.sqrt(df / (1 - r * r));
  const exactEligible = method === "spearman_correlation" && x.length <= 9 && ties.x.length === 0 && ties.y.length === 0;
  if (method === "spearman_correlation" && options.pValueMethod === "exact" && !exactEligible) fail("STAT_EXACT_UNAVAILABLE", "exact Spearman permutation inference requires n <= 9 and no ties");
  const exact = method === "spearman_correlation" && options.pValueMethod !== "asymptotic" && exactEligible
    ? exactPermutationP(x, y, correlation, r, options.alternative, budget)
    : null;
  const pValue = exact ? exact.pValue : perfect ? 0 : pFromT(statistic, df, options.alternative);
  const zCritical = normalInv(1 - (1 - options.confidenceLevel) / 2);
  let lower = -1;
  let upper = 1;
  if (x.length > 3 && Math.abs(r) < 1) {
    const transformed = Math.atanh(r);
    const half = zCritical / Math.sqrt(x.length - 3);
    lower = Math.tanh(transformed - half);
    upper = Math.tanh(transformed + half);
  }
  const coefficientName = method === "pearson_correlation" ? "Pearson r" : "Spearman rho";
  return {
    sample: { n: x.length, variables: 2 },
    estimates: { coefficient: r },
    tests: [{ name: coefficientName, statistic, ...(perfect ? { statisticBoundary: r > 0 ? "positive_infinity" : "negative_infinity" } : {}), distribution: exact ? "exact permutation" : "t", df, pValue, alternative: options.alternative, approximation: method === "spearman_correlation" ? (exact ? "none" : "t approximation on average ranks") : "exact under bivariate normal null", ...(exact ? { pValueMethod: "exact", permutations: exact.permutations } : method === "spearman_correlation" ? { pValueMethod: "asymptotic" } : {}) }],
    confidenceIntervals: [{ parameter: coefficientName, level: options.confidenceLevel, lower, upper, method: "Fisher z approximation" }],
    effectSizes: [{ name: coefficientName, estimate: r }, { name: "r squared", estimate: r * r }],
    assumptions: method === "pearson_correlation" ? [{ name: "linearity", status: "requires_visual_review" }, { name: "bivariate normality", status: "requires_domain_review" }] : [{ name: "monotonicity", status: "requires_visual_review" }],
    diagnostics: [jarqueBera(data.x, budget), jarqueBera(data.y, budget), ...(method === "spearman_correlation" ? [{ name: "ties", status: ties.x.length || ties.y.length ? "present" : "absent", xTieBlocks: ties.x.length, yTieBlocks: ties.y.length }, { name: "p-value method", requested: options.pValueMethod, used: exact ? "exact" : "asymptotic", exactEligibility: "n <= 9 and no ties" }] : [])],
    artifacts: [
      tableArtifact(`${coefficientName}: ${data.xLabel} and ${data.yLabel}`, `${coefficientName} with inferential test and confidence interval.`, [{ key: "coefficient", label: "Coefficient", type: "number" }, { key: "lower", label: "CI lower", type: "number" }, { key: "upper", label: "CI upper", type: "number" }, { key: "statistic", label: "Statistic", type: "number" }, { key: "df", label: "df", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "n", label: "N", type: "number" }], [{ coefficient: r, lower, upper, statistic, df, pValue, n: x.length }]),
      vegaArtifact("relationship", `${data.yLabel} by ${data.xLabel}`, { data: { values: bivariateBins(data.x, data.y) }, mark: "rect", encoding: { x: { field: "x0", type: "quantitative", title: data.xLabel, bin: "binned" }, x2: { field: "x1" }, y: { field: "y0", type: "quantitative", title: data.yLabel, bin: "binned" }, y2: { field: "y1" }, color: { field: "count", type: "quantitative", title: "N" }, tooltip: [{ field: "count" }] } }),
    ],
  };
}

function leveneDiagnostic(groups, budget) {
  const transformed = groups.map((group) => {
    const center = quantileR7(sorted(group.values), 0.5);
    return { name: group.name, values: group.values.map((value) => Math.abs(value - center)) };
  });
  try {
    const core = anovaCore(transformed, budget);
    return { name: "Brown-Forsythe variance homogeneity", status: "evaluated", statistic: core.f, df1: core.dfBetween, df2: core.dfWithin, pValue: pFromF(core.f, core.dfBetween, core.dfWithin) };
  } catch (error) {
    return { name: "Brown-Forsythe variance homogeneity", status: "not_evaluated", reason: error.message };
  }
}

function analyzeTTest(method, data, options, budget) {
  let first;
  let second;
  let paired = false;
  if (method === "paired_t_test") {
    first = { name: data.xLabel, values: data.x };
    second = { name: data.yLabel, values: data.y };
    paired = true;
  } else [first, second] = data.groups;
  const n1 = first.values.length;
  const n2 = second.values.length;
  const m1 = mean(first.values, budget);
  const m2 = mean(second.values, budget);
  const difference = m1 - m2;
  let statistic;
  let df;
  let se;
  let effectDenominator;
  let assumptions;
  let diagnostics;
  if (paired) {
    const differences = first.values.map((value, index) => value - second.values[index]);
    const sd = Math.sqrt(variance(differences, true, budget));
    se = sd / Math.sqrt(differences.length);
    if (se === 0) fail("STAT_DEGENERATE", "paired differences have zero variance");
    statistic = difference / se;
    df = differences.length - 1;
    effectDenominator = sd;
    assumptions = [{ name: "independent pairs", status: "requires_design_review" }, { name: "normal paired differences", status: "diagnostic_attached" }];
    diagnostics = [jarqueBera(differences, budget)];
  } else if (method === "welch_t_test") {
    const v1 = variance(first.values, true, budget);
    const v2 = variance(second.values, true, budget);
    se = Math.sqrt(v1 / n1 + v2 / n2);
    if (se === 0) fail("STAT_DEGENERATE", "both groups have zero variance");
    statistic = difference / se;
    df = Math.pow(v1 / n1 + v2 / n2, 2) / (Math.pow(v1 / n1, 2) / (n1 - 1) + Math.pow(v2 / n2, 2) / (n2 - 1));
    effectDenominator = Math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2));
    assumptions = [{ name: "independent observations", status: "requires_design_review" }, { name: "normality within groups", status: "diagnostic_attached" }];
    diagnostics = [jarqueBera(first.values, budget), jarqueBera(second.values, budget), leveneDiagnostic([first, second], budget)];
  } else {
    const v1 = variance(first.values, true, budget);
    const v2 = variance(second.values, true, budget);
    const pooledVariance = ((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2);
    se = Math.sqrt(pooledVariance * (1 / n1 + 1 / n2));
    if (se === 0) fail("STAT_DEGENERATE", "both groups have zero pooled variance");
    statistic = difference / se;
    df = n1 + n2 - 2;
    effectDenominator = Math.sqrt(pooledVariance);
    assumptions = [{ name: "independent observations", status: "requires_design_review" }, { name: "normality within groups", status: "diagnostic_attached" }, { name: "equal variances", status: "diagnostic_attached" }];
    diagnostics = [jarqueBera(first.values, budget), jarqueBera(second.values, budget), leveneDiagnostic([first, second], budget)];
  }
  const critical = tCritical(options.confidenceLevel, df);
  const lower = difference - critical * se;
  const upper = difference + critical * se;
  const pValue = pFromT(statistic, df, options.alternative);
  const d = difference / effectDenominator;
  const correction = 1 - 3 / (4 * df - 1);
  const g = d * correction;
  const displayName = method === "welch_t_test" ? "Welch independent t test" : paired ? "Paired t test" : "Independent pooled t test";
  return {
    sample: { n: paired ? n1 : n1 + n2, groupSizes: [n1, n2], paired },
    estimates: { firstMean: m1, secondMean: m2, meanDifference: difference, standardError: se },
    tests: [{ name: displayName, statistic, distribution: "t", df, pValue, alternative: options.alternative }],
    confidenceIntervals: [{ parameter: "mean difference", level: options.confidenceLevel, lower, upper, method: "Student t" }],
    effectSizes: [{ name: paired ? "Cohen dz" : "Cohen d", estimate: d }, { name: "Hedges g", estimate: g }],
    assumptions,
    diagnostics,
    artifacts: [
      tableArtifact(displayName, `${displayName} comparing ${first.name} with ${second.name}.`, [{ key: "contrast", label: "Contrast", type: "string" }, { key: "difference", label: "Mean difference", type: "number" }, { key: "lower", label: "CI lower", type: "number" }, { key: "upper", label: "CI upper", type: "number" }, { key: "t", label: "t", type: "number" }, { key: "df", label: "df", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "effect", label: paired ? "Cohen dz" : "Cohen d", type: "number" }], [{ contrast: `${first.name} - ${second.name}`, difference, lower, upper, t: statistic, df, pValue, effect: d }]),
      summaryChart([first, second], options.confidenceLevel),
    ],
  };
}

function anovaCore(groups, budget) {
  const all = groups.flatMap((group) => group.values);
  const grand = mean(all, budget);
  let ssBetween = 0;
  let ssWithin = 0;
  for (const group of groups) {
    budget.check();
    const groupMean = mean(group.values, budget);
    ssBetween += group.values.length * Math.pow(groupMean - grand, 2);
    for (const value of group.values) ssWithin += Math.pow(value - groupMean, 2);
  }
  const dfBetween = groups.length - 1;
  const dfWithin = all.length - groups.length;
  if (dfWithin <= 0 || ssWithin === 0) fail("STAT_DEGENERATE", "ANOVA within-group variance is zero or degrees of freedom are insufficient");
  const msBetween = ssBetween / dfBetween;
  const msWithin = ssWithin / dfWithin;
  return { n: all.length, grand, ssBetween, ssWithin, ssTotal: ssBetween + ssWithin, dfBetween, dfWithin, msBetween, msWithin, f: msBetween / msWithin };
}

function pooledPairwiseContrasts(groups, mse, df, postHoc, budget) {
  if (postHoc === "none") return [];
  const raw = [];
  for (let first = 0; first < groups.length - 1; first += 1) {
    for (let second = first + 1; second < groups.length; second += 1) {
      budget.check();
      const left = groups[first];
      const right = groups[second];
      const difference = mean(left.values, budget) - mean(right.values, budget);
      const standardError = Math.sqrt(mse * (1 / left.values.length + 1 / right.values.length));
      const statistic = difference / standardError;
      raw.push({ contrast: `${left.name} - ${right.name}`, difference, standardError, statistic, df, rawPValue: pFromT(statistic, df, "two-sided") });
    }
  }
  const adjusted = adjustedPValues(raw.map((row) => row.rawPValue), "holm");
  return raw.map((row, index) => ({ ...row, adjustedPValue: adjusted[index], adjustment: "Holm" }));
}

function analyzeAnova(data, options, budget) {
  const core = anovaCore(data.groups, budget);
  const pValue = pFromF(core.f, core.dfBetween, core.dfWithin);
  const etaSquared = core.ssBetween / core.ssTotal;
  const omegaSquared = Math.max(0, (core.ssBetween - core.dfBetween * core.msWithin) / (core.ssTotal + core.msWithin));
  const contrasts = pooledPairwiseContrasts(data.groups, core.msWithin, core.dfWithin, options.postHoc, budget);
  const rows = [
    { source: "Between groups", ss: core.ssBetween, df: core.dfBetween, ms: core.msBetween, statistic: core.f, pValue },
    { source: "Within groups", ss: core.ssWithin, df: core.dfWithin, ms: core.msWithin, statistic: null, pValue: null },
    { source: "Total", ss: core.ssTotal, df: core.n - 1, ms: null, statistic: null, pValue: null },
  ];
  return {
    sample: { n: core.n, groups: data.groups.length, groupSizes: data.groups.map((group) => group.values.length) },
    estimates: { grandMean: core.grand, postHocContrasts: contrasts },
    tests: [{ name: "One-way ANOVA", statistic: core.f, distribution: "F", df1: core.dfBetween, df2: core.dfWithin, pValue }],
    confidenceIntervals: [],
    effectSizes: [{ name: "eta squared", estimate: etaSquared }, { name: "omega squared", estimate: omegaSquared }],
    assumptions: [{ name: "independent observations", status: "requires_design_review" }, { name: "normal residuals within groups", status: "diagnostic_attached" }, { name: "variance homogeneity", status: "diagnostic_attached" }],
    diagnostics: [...data.groups.map((group) => ({ group: group.name, ...jarqueBera(group.values, budget) })), leveneDiagnostic(data.groups, budget), { name: "post-hoc boundary", requested: options.postHoc, method: contrasts.length ? "pooled-MSE pairwise t contrasts with Holm-adjusted p-values" : "none", confidenceIntervals: "not provided for multiplicity-adjusted contrasts" }],
    artifacts: [
      tableArtifact("One-way analysis of variance", "Omnibus one-way ANOVA table.", [{ key: "source", label: "Source", type: "string" }, { key: "ss", label: "Sum of squares", type: "number" }, { key: "df", label: "df", type: "number" }, { key: "ms", label: "Mean square", type: "number" }, { key: "statistic", label: "F", type: "number" }, { key: "pValue", label: "p", type: "number" }], rows, ["Effect sizes: eta squared and bias-reduced omega squared are included in the result payload."]),
      summaryChart(data.groups, options.confidenceLevel),
      ...(contrasts.length ? [tableArtifact("One-way ANOVA Holm post-hoc contrasts", "Pairwise pooled-MSE t contrasts. Holm adjusts p-values; no simultaneous confidence intervals are claimed.", [{ key: "contrast", label: "Contrast", type: "string" }, { key: "difference", label: "Mean difference", type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "statistic", label: "t", type: "number" }, { key: "df", label: "df", type: "number" }, { key: "rawPValue", label: "Raw p", type: "number" }, { key: "adjustedPValue", label: "Holm p", type: "number" }, { key: "adjustment", label: "Adjustment", type: "string" }], contrasts)] : []),
    ],
  };
}

function analyzeWelchOneWayAnova(data, options, budget) {
  const summaries = data.groups.map((group) => {
    const n = group.values.length;
    const groupMean = mean(group.values, budget);
    const sampleVariance = variance(group.values, true, budget);
    if (!(sampleVariance > 0)) fail("STAT_DEGENERATE", `Welch one-way ANOVA requires positive variance in group ${group.name}`);
    const standardError = Math.sqrt(sampleVariance / n);
    const critical = tCritical(options.confidenceLevel, n - 1);
    return {
      group: group.name,
      n,
      mean: groupMean,
      variance: sampleVariance,
      standardError,
      lower: groupMean - critical * standardError,
      upper: groupMean + critical * standardError,
      weight: n / sampleVariance,
    };
  });
  const k = summaries.length;
  const totalWeight = sum(summaries.map((row) => row.weight), budget);
  if (!(totalWeight > 0) || !Number.isFinite(totalWeight)) fail("STAT_NUMERIC_FAILURE", "Welch one-way ANOVA weights are not finite");
  const weightedMean = sum(summaries.map((row) => row.weight * row.mean), budget) / totalWeight;
  const adjustmentTerm = sum(summaries.map((row) => ((1 - row.weight / totalWeight) ** 2) / (row.n - 1)), budget);
  if (!(adjustmentTerm > 0)) fail("STAT_DEGENERATE", "Welch one-way ANOVA denominator degrees of freedom are undefined");
  const numerator = sum(summaries.map((row) => row.weight * (row.mean - weightedMean) ** 2), budget) / (k - 1);
  const denominatorCorrection = 1 + (2 * (k - 2) / (k ** 2 - 1)) * adjustmentTerm;
  const statistic = numerator / denominatorCorrection;
  const df1 = k - 1;
  const df2 = (k ** 2 - 1) / (3 * adjustmentTerm);
  if (![statistic, df2].every(Number.isFinite) || statistic < 0 || !(df2 > 0)) {
    fail("STAT_NUMERIC_FAILURE", "Welch one-way ANOVA produced invalid F-distribution parameters");
  }
  const pValue = pFromF(statistic, df1, df2);
  const testRow = { statistic, df1, df2, pValue, weightedMean, denominatorCorrection };
  const groupSummaryRowsHash = sha256(summaries);
  return {
    sample: { n: summaries.reduce((total, row) => total + row.n, 0), groups: k, groupSizes: summaries.map((row) => row.n) },
    estimates: {
      weightedMean,
      groupSummaries: summaries,
      adjustmentTerm,
      denominatorCorrection,
      rendererDataContract: {
        inlineRows: "all",
        sampling: "none",
        aggregation: "none",
        rowCount: summaries.length,
        groupSummaryRowsHash,
        tableRole: "welch-group-summary-table",
        vegaRole: "estimate-plot",
      },
    },
    tests: [{ name: "Welch one-way ANOVA", statistic, distribution: "F", df1, df2, pValue }],
    confidenceIntervals: summaries.map((row) => ({ parameter: `${row.group} mean`, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: "groupwise Student t" })),
    effectSizes: [],
    assumptions: [{ name: "independent observations", status: "requires_design_review" }, { name: "normal residuals within groups", status: "diagnostic_attached" }, { name: "equal variances", status: "not_required_by_welch_test" }],
    diagnostics: [...data.groups.map((group) => ({ group: group.name, ...jarqueBera(group.values, budget) })), { name: "Welch boundary", status: "omnibus_only", unsupported: ["Games-Howell post-hoc comparisons", "multiplicity-adjusted contrasts", "Welch effect-size estimator"] }],
    artifacts: [
      tableArtifact("Welch one-way analysis of variance", "Heteroscedastic omnibus Welch ANOVA with fractional denominator degrees of freedom.", [{ key: "statistic", label: "F", type: "number" }, { key: "df1", label: "Numerator df", type: "number" }, { key: "df2", label: "Denominator df", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "weightedMean", label: "Weighted mean", type: "number" }, { key: "denominatorCorrection", label: "Denominator correction", type: "number" }], [testRow], ["No equal-variance assumption or post-hoc procedure is claimed."], "welch-anova-table"),
      tableArtifact("Welch group summaries", `Group means and unadjusted ${Math.round(options.confidenceLevel * 100)}% confidence intervals.`, [{ key: "group", label: "Group", type: "string" }, { key: "n", label: "N", type: "number" }, { key: "mean", label: "Mean", type: "number" }, { key: "variance", label: "Variance", type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "lower", label: "CI lower", type: "number" }, { key: "upper", label: "CI upper", type: "number" }, { key: "weight", label: "Welch weight", type: "number" }], summaries, ["Confidence intervals are groupwise and are not simultaneous."], "welch-group-summary-table"),
      vegaArtifact("estimate-plot", `Group means with ${Math.round(options.confidenceLevel * 100)}% confidence intervals`, { data: { values: summaries }, layer: [{ mark: { type: "rule", strokeWidth: 2 }, encoding: { x: { field: "group", type: "nominal", title: "Group", sort: null }, y: { field: "lower", type: "quantitative", title: "Mean", scale: MEASUREMENT_SCALE }, y2: { field: "upper" } } }, { mark: { type: "point", filled: true, size: 80 }, encoding: { x: { field: "group", type: "nominal", sort: null }, y: { field: "mean", type: "quantitative", scale: MEASUREMENT_SCALE }, tooltip: [{ field: "group" }, { field: "mean", format: ".6g" }, { field: "lower", format: ".6g" }, { field: "upper", format: ".6g" }, { field: "variance", format: ".6g" }, { field: "n" }] } }] }),
    ],
  };
}

function analyzeTwoWayAnova(data, options, budget) {
  const cells = new Map();
  for (let index = 0; index < data.y.length; index += 1) {
    budget.check();
    const key = `${data.factorA[index]}\u0000${data.factorB[index]}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(data.y[index]);
  }
  const expectedCells = data.levelsA.length * data.levelsB.length;
  if (cells.size !== expectedCells) fail("STAT_INVALID_INPUT", "two_way_anova requires every factor-level combination to be present");
  const cellSizes = [...cells.values()].map((values) => values.length);
  const replications = cellSizes[0];
  if (replications < 2 || cellSizes.some((size) => size !== replications)) {
    fail("STAT_INVALID_INPUT", "two_way_anova is bounded to balanced complete cells with at least two observations per cell");
  }
  const grandMean = mean(data.y, budget);
  const meanA = new Map(data.levelsA.map((level) => [level, mean(data.y.filter((_, index) => data.factorA[index] === level), budget)]));
  const meanB = new Map(data.levelsB.map((level) => [level, mean(data.y.filter((_, index) => data.factorB[index] === level), budget)]));
  const cellRows = [];
  let ssA = 0;
  let ssB = 0;
  let ssInteraction = 0;
  let ssError = 0;
  for (const level of data.levelsA) ssA += data.levelsB.length * replications * (meanA.get(level) - grandMean) ** 2;
  for (const level of data.levelsB) ssB += data.levelsA.length * replications * (meanB.get(level) - grandMean) ** 2;
  for (const levelA of data.levelsA) {
    for (const levelB of data.levelsB) {
      const values = cells.get(`${levelA}\u0000${levelB}`);
      const cellMean = mean(values, budget);
      ssInteraction += replications * (cellMean - meanA.get(levelA) - meanB.get(levelB) + grandMean) ** 2;
      for (const value of values) ssError += (value - cellMean) ** 2;
      const se = Math.sqrt(variance(values, true, budget) / values.length);
      cellRows.push({ factorA: levelA, factorB: levelB, mean: cellMean, standardError: se, n: values.length });
    }
  }
  if (!(ssError > 0)) fail("STAT_DEGENERATE", "two_way_anova within-cell variance is zero");
  const dfA = data.levelsA.length - 1;
  const dfB = data.levelsB.length - 1;
  const dfInteraction = dfA * dfB;
  const dfError = data.levelsA.length * data.levelsB.length * (replications - 1);
  const msError = ssError / dfError;
  const sources = [
    { source: data.factorALabel, ss: ssA, df: dfA },
    { source: data.factorBLabel, ss: ssB, df: dfB },
    { source: `${data.factorALabel} × ${data.factorBLabel}`, ss: ssInteraction, df: dfInteraction },
  ].map((row) => ({ ...row, ms: row.ss / row.df, statistic: (row.ss / row.df) / msError, pValue: pFromF((row.ss / row.df) / msError, row.df, dfError) }));
  const ssTotal = sum(data.y.map((value) => (value - grandMean) ** 2), budget);
  const errorRow = { source: "Error", ss: ssError, df: dfError, ms: msError, statistic: null, pValue: null };
  const totalRow = { source: "Total", ss: ssTotal, df: data.y.length - 1, ms: null, statistic: null, pValue: null };
  const effects = sources.map((row) => ({
    name: `${row.source} partial eta squared`,
    estimate: row.ss / (row.ss + ssError),
    partialOmegaSquared: Math.max(0, (row.ss - row.df * msError) / (row.ss + ssError + msError)),
  }));
  const marginalGroupsA = data.levelsA.map((level) => ({ name: level, values: data.y.filter((_, index) => data.factorA[index] === level) }));
  const marginalGroupsB = data.levelsB.map((level) => ({ name: level, values: data.y.filter((_, index) => data.factorB[index] === level) }));
  const contrastsA = pooledPairwiseContrasts(marginalGroupsA, msError, dfError, options.postHoc, budget);
  const contrastsB = pooledPairwiseContrasts(marginalGroupsB, msError, dfError, options.postHoc, budget);
  const residualGroups = cellRows.map((row) => ({ name: `${row.factorA} × ${row.factorB}`, values: cells.get(`${row.factorA}\u0000${row.factorB}`) }));
  const contrastRows = [
    ...contrastsA.map((row) => ({ factor: data.factorALabel, ...row })),
    ...contrastsB.map((row) => ({ factor: data.factorBLabel, ...row })),
  ];
  return {
    sample: { n: data.y.length, factorALevels: data.levelsA.length, factorBLevels: data.levelsB.length, cells: expectedCells, replicationsPerCell: replications, balanced: true },
    estimates: { grandMean, cellMeans: cellRows, postHocContrasts: contrastRows },
    tests: sources.map((row) => ({ name: `Two-way ANOVA: ${row.source}`, statistic: row.statistic, distribution: "F", df1: row.df, df2: dfError, pValue: row.pValue })),
    confidenceIntervals: [],
    effectSizes: effects,
    assumptions: [{ name: "balanced complete fixed-effects factorial design", status: "verified_by_input_contract" }, { name: "independent observations", status: "requires_design_review" }, { name: "normal within-cell residuals", status: "diagnostic_attached" }, { name: "variance homogeneity across cells", status: "diagnostic_attached" }],
    diagnostics: [...residualGroups.map((group) => ({ cell: group.name, ...jarqueBera(group.values, budget) })), leveneDiagnostic(residualGroups, budget), { name: "ANOVA boundary", status: "balanced_complete_fixed_effects_only", unsupported: ["unbalanced Type II/III sums of squares", "repeated measures", "random or mixed effects", "ANCOVA"] }, { name: "post-hoc boundary", requested: options.postHoc, method: contrastRows.length ? "marginal pooled-MSE pairwise t contrasts with Holm-adjusted p-values" : "none", interactionCaution: "marginal contrasts require substantive review when interaction is present" }],
    artifacts: [
      tableArtifact("Balanced two-way analysis of variance", "Fixed-effects balanced complete-factorial ANOVA with interaction.", [{ key: "source", label: "Source", type: "string" }, { key: "ss", label: "Sum of squares", type: "number" }, { key: "df", label: "df", type: "number" }, { key: "ms", label: "Mean square", type: "number" }, { key: "statistic", label: "F", type: "number" }, { key: "pValue", label: "p", type: "number" }], [...sources, errorRow, totalRow], ["Classical balanced fixed-effects decomposition; effect sizes are in the result payload."]),
      vegaArtifact("interaction-plot", `${data.factorALabel} × ${data.factorBLabel} interaction`, { data: { values: cellRows }, mark: { type: "line", point: true }, encoding: { x: { field: "factorA", type: "nominal", title: data.factorALabel }, y: { field: "mean", type: "quantitative", title: `Mean ${data.outcomeLabel}` }, color: { field: "factorB", type: "nominal", title: data.factorBLabel }, detail: { field: "factorB" }, tooltip: [{ field: "factorA" }, { field: "factorB" }, { field: "mean", format: ".5g" }, { field: "standardError", format: ".4g" }, { field: "n" }] } }),
      ...(contrastRows.length ? [tableArtifact("Two-way ANOVA Holm marginal contrasts", "Marginal pairwise contrasts for each factor using the pooled cell-error mean square.", [{ key: "factor", label: "Factor", type: "string" }, { key: "contrast", label: "Contrast", type: "string" }, { key: "difference", label: "Mean difference", type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "statistic", label: "t", type: "number" }, { key: "df", label: "df", type: "number" }, { key: "rawPValue", label: "Raw p", type: "number" }, { key: "adjustedPValue", label: "Holm p", type: "number" }, { key: "adjustment", label: "Adjustment", type: "string" }], contrastRows, ["Review marginal contrasts cautiously when the interaction is non-negligible."])] : []),
    ],
  };
}

function exactMannWhitneyP(n1, n2, observedU, alternative, budget) {
  const totalN = n1 + n2;
  const maximumRankSum = n1 * (2 * totalN - n1 + 1) / 2;
  const counts = Array.from({ length: n1 + 1 }, () => Array(maximumRankSum + 1).fill(0n));
  counts[0][0] = 1n;
  for (let rank = 1; rank <= totalN; rank += 1) {
    for (let chosen = Math.min(rank, n1); chosen >= 1; chosen -= 1) {
      for (let rankSum = maximumRankSum; rankSum >= rank; rankSum -= 1) {
        budget.check();
        counts[chosen][rankSum] += counts[chosen - 1][rankSum - rank];
      }
    }
  }
  const offset = n1 * (n1 + 1) / 2;
  let total = 0n;
  let less = 0n;
  let greater = 0n;
  for (let rankSum = 0; rankSum <= maximumRankSum; rankSum += 1) {
    const count = counts[n1][rankSum];
    if (!count) continue;
    const u = rankSum - offset;
    total += count;
    if (u <= observedU + 1e-12) less += count;
    if (u >= observedU - 1e-12) greater += count;
  }
  const left = Number(less) / Number(total);
  const right = Number(greater) / Number(total);
  return { pValue: alternative === "less" ? left : alternative === "greater" ? right : Math.min(1, 2 * Math.min(left, right)), allocations: Number(total) };
}

function exactWilcoxonP(n, observedPositive, alternative, budget) {
  const totalRank = n * (n + 1) / 2;
  const counts = Array(totalRank + 1).fill(0n);
  counts[0] = 1n;
  let reached = 0;
  for (let rank = 1; rank <= n; rank += 1) {
    reached += rank;
    for (let rankSum = reached; rankSum >= rank; rankSum -= 1) {
      budget.check();
      counts[rankSum] += counts[rankSum - rank];
    }
  }
  let less = 0n;
  let greater = 0n;
  let total = 0n;
  for (let rankSum = 0; rankSum <= totalRank; rankSum += 1) {
    total += counts[rankSum];
    if (rankSum <= observedPositive + 1e-12) less += counts[rankSum];
    if (rankSum >= observedPositive - 1e-12) greater += counts[rankSum];
  }
  const left = Number(less) / Number(total);
  const right = Number(greater) / Number(total);
  return { pValue: alternative === "less" ? left : alternative === "greater" ? right : Math.min(1, 2 * Math.min(left, right)), signPatterns: Number(total) };
}

function analyzeMannWhitney(data, options, budget) {
  const [first, second] = data.groups;
  const combined = [...first.values.map((value) => ({ value, group: 0 })), ...second.values.map((value) => ({ value, group: 1 }))];
  const ranked = averageRanks(combined.map((item) => item.value));
  let rankSum1 = 0;
  combined.forEach((item, index) => { budget.check(); if (item.group === 0) rankSum1 += ranked.ranks[index]; });
  const n1 = first.values.length;
  const n2 = second.values.length;
  const u1 = rankSum1 - n1 * (n1 + 1) / 2;
  const u2 = n1 * n2 - u1;
  const meanU = n1 * n2 / 2;
  const n = n1 + n2;
  const tieTerm = ranked.tieSizes.reduce((acc, size) => acc + size ** 3 - size, 0);
  const varianceU = n1 * n2 / 12 * ((n + 1) - tieTerm / (n * (n - 1)));
  if (varianceU <= 0) fail("STAT_DEGENERATE", "Mann-Whitney variance is zero after tie correction");
  const direction = u1 - meanU;
  const correction = direction === 0 ? 0 : 0.5 * Math.sign(direction);
  const z = (direction - correction) / Math.sqrt(varianceU);
  const exactEligible = ranked.tieSizes.length === 0 && n <= 50 && n1 * n2 <= 400;
  if (options.pValueMethod === "exact" && !exactEligible) fail("STAT_EXACT_UNAVAILABLE", "exact Mann-Whitney inference requires no ties, total n <= 50, and n1*n2 <= 400");
  const exact = options.pValueMethod !== "asymptotic" && exactEligible ? exactMannWhitneyP(n1, n2, u1, options.alternative, budget) : null;
  const pValue = exact ? exact.pValue : pFromNormal(z, options.alternative);
  const rankBiserial = 2 * u1 / (n1 * n2) - 1;
  return {
    sample: { n: n1 + n2, groupSizes: [n1, n2] },
    estimates: { uFirst: u1, uSecond: u2, rankSumFirst: rankSum1 },
    tests: [{ name: "Mann-Whitney U", statistic: u1, standardizedStatistic: z, distribution: exact ? "exact rank-allocation distribution" : "normal approximation with tie and continuity correction", pValue, alternative: options.alternative, pValueMethod: exact ? "exact" : "asymptotic", ...(exact ? { allocations: exact.allocations } : {}) }],
    confidenceIntervals: [],
    effectSizes: [{ name: "rank-biserial correlation", estimate: rankBiserial }],
    assumptions: [{ name: "independent observations", status: "requires_design_review" }, { name: "ordinal or continuous outcome", status: "requires_domain_review" }],
    diagnostics: [{ name: "ties", status: ranked.tieSizes.length ? "present" : "absent", tieBlocks: ranked.tieSizes.length }, { name: "p-value method", requested: options.pValueMethod, used: exact ? "exact" : "asymptotic", exactEligibility: "no ties, total n <= 50, n1*n2 <= 400" }],
    artifacts: [tableArtifact("Mann-Whitney U test", `Rank-based comparison of ${first.name} and ${second.name}.`, [{ key: "contrast", label: "Contrast", type: "string" }, { key: "u", label: "U", type: "number" }, { key: "z", label: "z", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "effect", label: "Rank-biserial r", type: "number" }], [{ contrast: `${first.name} vs ${second.name}`, u: u1, z, pValue, effect: rankBiserial }]), summaryChart(data.groups, options.confidenceLevel)],
  };
}

function analyzeWilcoxon(data, options, budget) {
  const differences = data.x.map((value, index) => value - data.y[index]);
  const nonzero = differences.map((value, index) => ({ value, index })).filter((item) => item.value !== 0);
  if (nonzero.length < 2) fail("STAT_DEGENERATE", "Wilcoxon signed-rank requires at least two non-zero differences");
  const ranked = averageRanks(nonzero.map((item) => Math.abs(item.value)));
  let positive = 0;
  let negative = 0;
  nonzero.forEach((item, index) => {
    budget.check();
    if (item.value > 0) positive += ranked.ranks[index];
    else negative += ranked.ranks[index];
  });
  const n = nonzero.length;
  const expected = n * (n + 1) / 4;
  const tieTerm = ranked.tieSizes.reduce((acc, size) => acc + size ** 3 - size, 0);
  const varianceW = n * (n + 1) * (2 * n + 1) / 24 - tieTerm / 48;
  if (varianceW <= 0) fail("STAT_DEGENERATE", "Wilcoxon variance is zero after tie correction");
  const direction = positive - expected;
  const correction = direction === 0 ? 0 : 0.5 * Math.sign(direction);
  const z = (direction - correction) / Math.sqrt(varianceW);
  const exactEligible = ranked.tieSizes.length === 0 && n <= 30;
  if (options.pValueMethod === "exact" && !exactEligible) fail("STAT_EXACT_UNAVAILABLE", "exact Wilcoxon inference requires no absolute-difference ties after zero removal and nonzero n <= 30");
  const exact = options.pValueMethod !== "asymptotic" && exactEligible ? exactWilcoxonP(n, positive, options.alternative, budget) : null;
  const pValue = exact ? exact.pValue : pFromNormal(z, options.alternative);
  const effect = z / Math.sqrt(n);
  return {
    sample: { nPairs: data.x.length, nonzeroPairs: n, zeroPairs: data.x.length - n },
    estimates: { positiveRankSum: positive, negativeRankSum: negative, statistic: Math.min(positive, negative) },
    tests: [{ name: "Wilcoxon signed-rank", statistic: Math.min(positive, negative), standardizedStatistic: z, distribution: exact ? "exact sign-allocation distribution" : "normal approximation with tie and continuity correction", pValue, alternative: options.alternative, pValueMethod: exact ? "exact" : "asymptotic", ...(exact ? { signPatterns: exact.signPatterns } : {}) }],
    confidenceIntervals: [],
    effectSizes: [{ name: "matched-pairs rank effect r", estimate: effect }],
    assumptions: [{ name: "paired observations", status: "requires_design_review" }, { name: "symmetric difference distribution", status: "requires_visual_review" }],
    diagnostics: [{ name: "zero differences", count: data.x.length - n }, { name: "absolute-difference ties", tieBlocks: ranked.tieSizes.length }, { name: "p-value method", requested: options.pValueMethod, used: exact ? "exact" : "asymptotic", exactEligibility: "no absolute-difference ties after zero removal and nonzero n <= 30" }],
    artifacts: [tableArtifact("Wilcoxon signed-rank test", `${data.xLabel} minus ${data.yLabel}.`, [{ key: "contrast", label: "Contrast", type: "string" }, { key: "w", label: "W", type: "number" }, { key: "z", label: "z", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "effect", label: "Effect r", type: "number" }, { key: "n", label: "Non-zero N", type: "number" }], [{ contrast: `${data.xLabel} - ${data.yLabel}`, w: Math.min(positive, negative), z, pValue, effect, n }]), vegaArtifact("difference-distribution", "Paired difference distribution", { data: { values: histogram(differences) }, mark: "bar", encoding: { x: { field: "binStart", type: "quantitative", bin: "binned", title: "Difference" }, x2: { field: "binEnd" }, y: { field: "count", type: "quantitative" } } })],
  };
}

function analyzeKruskalWallis(data, options, budget) {
  const combined = [];
  data.groups.forEach((group, groupIndex) => group.values.forEach((value) => combined.push({ value, groupIndex })));
  const ranked = averageRanks(combined.map((item) => item.value));
  const rankSums = Array.from({ length: data.groups.length }, () => 0);
  combined.forEach((item, index) => { budget.check(); rankSums[item.groupIndex] += ranked.ranks[index]; });
  const n = combined.length;
  let h = 0;
  for (let i = 0; i < data.groups.length; i += 1) h += rankSums[i] ** 2 / data.groups[i].values.length;
  h = 12 / (n * (n + 1)) * h - 3 * (n + 1);
  const tieTerm = ranked.tieSizes.reduce((acc, size) => acc + size ** 3 - size, 0);
  const correction = 1 - tieTerm / (n ** 3 - n);
  if (correction <= 0) fail("STAT_DEGENERATE", "Kruskal-Wallis tie correction is zero");
  h /= correction;
  const df = data.groups.length - 1;
  const pValue = pFromChiSquare(h, df);
  const epsilonSquared = Math.max(0, (h - data.groups.length + 1) / (n - data.groups.length));
  return {
    sample: { n, groups: data.groups.length, groupSizes: data.groups.map((group) => group.values.length) },
    estimates: { rankSums },
    tests: [{ name: "Kruskal-Wallis", statistic: h, distribution: "chi-square approximation with tie correction", df, pValue }],
    confidenceIntervals: [],
    effectSizes: [{ name: "epsilon squared", estimate: epsilonSquared }],
    assumptions: [{ name: "independent observations", status: "requires_design_review" }, { name: "ordinal or continuous outcome", status: "requires_domain_review" }],
    diagnostics: [{ name: "ties", status: ranked.tieSizes.length ? "present" : "absent", tieBlocks: ranked.tieSizes.length }],
    artifacts: [tableArtifact("Kruskal-Wallis test", "Omnibus rank comparison across independent groups.", [{ key: "statistic", label: "H", type: "number" }, { key: "df", label: "df", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "effect", label: "Epsilon squared", type: "number" }, { key: "n", label: "N", type: "number" }], [{ statistic: h, df, pValue, effect: epsilonSquared, n }]), summaryChart(data.groups, options.confidenceLevel)],
  };
}

function analyzeFriedman(data, _options, budget) {
  const k = data.conditions.length;
  const n = data.blockCount;
  const rankSums = Array(k).fill(0);
  let tieTerm = 0;
  for (let block = 0; block < n; block += 1) {
    budget.check();
    const ranked = averageRanks(data.conditions.map((condition) => condition.values[block]));
    for (let condition = 0; condition < k; condition += 1) rankSums[condition] += ranked.ranks[condition];
    tieTerm += ranked.tieSizes.reduce((total, size) => total + size ** 3 - size, 0);
  }
  const tieCorrection = 1 - tieTerm / (n * k * (k ** 2 - 1));
  if (!(tieCorrection > 0)) fail("STAT_DEGENERATE", "Friedman tie correction is zero because every block is tied");
  const uncorrectedStatistic = 12 / (n * k * (k + 1)) * sum(rankSums.map((value) => value ** 2), budget) - 3 * n * (k + 1);
  const statistic = Math.max(0, uncorrectedStatistic / tieCorrection);
  const df = k - 1;
  const pValue = pFromChiSquare(statistic, df);
  const kendallsW = Math.max(0, Math.min(1, statistic / (n * (k - 1))));
  const conditionRows = data.conditions.map((condition, index) => ({ condition: condition.name, rankSum: rankSums[index], meanRank: rankSums[index] / n, nBlocks: n }));
  const testRow = { statistic, df, pValue, kendallsW, tieCorrection, blocks: n, conditions: k };
  const conditionRankRowsHash = sha256(conditionRows);
  return {
    sample: { n: n * k, blocks: n, conditions: k, completePairs: n },
    estimates: {
      rankSums,
      conditionRanks: conditionRows,
      tieCorrection,
      uncorrectedStatistic,
      rendererDataContract: {
        inlineRows: "all",
        sampling: "none",
        aggregation: "none",
        rowCount: conditionRows.length,
        conditionRankRowsHash,
        tableRole: "friedman-rank-summary-table",
        vegaRole: "paired-rank-profile",
      },
    },
    tests: [{ name: "Friedman test", statistic, distribution: "chi-square approximation with within-block tie correction", df, pValue }],
    confidenceIntervals: [],
    effectSizes: [{ name: "Kendall W", estimate: kendallsW }],
    assumptions: [{ name: "complete matched blocks", status: "verified_by_input_contract" }, { name: "independent blocks", status: "requires_design_review" }, { name: "ordinal or continuous outcome", status: "requires_domain_review" }],
    diagnostics: [{ name: "within-block ties", status: tieTerm > 0 ? "present" : "absent", tieTerm, tieCorrection }, { name: "Friedman boundary", status: "asymptotic_omnibus_only", unsupported: ["Iman-Davenport correction", "post-hoc pairwise comparisons", "incomplete blocks"] }],
    artifacts: [
      tableArtifact("Friedman test", "Rank-based omnibus comparison across complete matched conditions.", [{ key: "statistic", label: "Q", type: "number" }, { key: "df", label: "df", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "kendallsW", label: "Kendall W", type: "number" }, { key: "tieCorrection", label: "Tie correction", type: "number" }, { key: "blocks", label: "Blocks", type: "number" }, { key: "conditions", label: "Conditions", type: "number" }], [testRow], ["Rows with missing or non-finite observations are rejected rather than silently dropped."], "friedman-test-table"),
      tableArtifact("Friedman condition ranks", "Rank sums and mean within-block ranks for every condition.", [{ key: "condition", label: "Condition", type: "string" }, { key: "rankSum", label: "Rank sum", type: "number" }, { key: "meanRank", label: "Mean rank", type: "number" }, { key: "nBlocks", label: "Blocks", type: "number" }], conditionRows, [], "friedman-rank-summary-table"),
      vegaArtifact("paired-rank-profile", "Friedman mean ranks by condition", { data: { values: conditionRows }, mark: { type: "line", point: true }, encoding: { x: { field: "condition", type: "nominal", title: "Condition" }, y: { field: "meanRank", type: "quantitative", title: "Mean within-block rank", scale: { domain: [1, k] } }, tooltip: [{ field: "condition" }, { field: "rankSum", format: ".6g" }, { field: "meanRank", format: ".6g" }, { field: "nBlocks" }] } }),
    ],
  };
}

function transpose(matrix) {
  return matrix[0].map((_, column) => matrix.map((row) => row[column]));
}

function matMul(left, right, budget) {
  const out = Array.from({ length: left.length }, () => Array(right[0].length).fill(0));
  for (let i = 0; i < left.length; i += 1) {
    for (let k = 0; k < right.length; k += 1) {
      for (let j = 0; j < right[0].length; j += 1) {
        if (budget) budget.check();
        out[i][j] += left[i][k] * right[k][j];
      }
    }
  }
  return out;
}

function invert(matrix) {
  const n = matrix.length;
  if (!matrix.every((row) => row.length === n)) fail("STAT_INTERNAL", "matrix inversion requires square matrix");
  const augmented = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => i === j ? 1 : 0)]);
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    if (Math.abs(augmented[pivot][column]) < 1e-12) fail("STAT_SINGULAR_MATRIX", "design matrix is singular or ill-conditioned");
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let j = 0; j < 2 * n; j += 1) augmented[column][j] /= divisor;
    for (let row = 0; row < n; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let j = 0; j < 2 * n; j += 1) augmented[row][j] -= factor * augmented[column][j];
    }
  }
  return augmented.map((row) => row.slice(n));
}

function matrixRank(matrix, relativeTolerance = 1e-10) {
  const work = matrix.map((row) => [...row]);
  const rows = work.length;
  const columns = work[0].length;
  let scale = 1;
  for (const row of work) {
    for (const value of row) scale = Math.max(scale, Math.abs(value));
  }
  const tolerance = relativeTolerance * scale;
  let rank = 0;
  for (let column = 0; column < columns && rank < rows; column += 1) {
    let pivot = rank;
    for (let row = rank + 1; row < rows; row += 1) {
      if (Math.abs(work[row][column]) > Math.abs(work[pivot][column])) pivot = row;
    }
    if (Math.abs(work[pivot][column]) <= tolerance) continue;
    [work[rank], work[pivot]] = [work[pivot], work[rank]];
    const divisor = work[rank][column];
    for (let cell = column; cell < columns; cell += 1) work[rank][cell] /= divisor;
    for (let row = rank + 1; row < rows; row += 1) {
      const factor = work[row][column];
      for (let cell = column; cell < columns; cell += 1) work[row][cell] -= factor * work[rank][cell];
    }
    rank += 1;
  }
  return rank;
}

function matrixInfinityNorm(matrix) {
  return Math.max(...matrix.map((row) => row.reduce((total, value) => total + Math.abs(value), 0)));
}

function positiveDefiniteLogDeterminant(matrix) {
  const n = matrix.length;
  if (!matrix.every((row) => row.length === n)) fail("STAT_INTERNAL", "positive-definite determinant requires a square matrix");
  const lower = Array.from({ length: n }, () => Array(n).fill(0));
  let logDeterminant = 0;
  for (let row = 0; row < n; row += 1) {
    for (let column = 0; column <= row; column += 1) {
      let value = matrix[row][column];
      for (let index = 0; index < column; index += 1) value -= lower[row][index] * lower[column][index];
      if (row === column) {
        if (!(value > 1e-12) || !Number.isFinite(value)) fail("STAT_SINGULAR_MATRIX", "weighted fixed-effect information matrix is not positive definite");
        lower[row][column] = Math.sqrt(value);
        logDeterminant += 2 * Math.log(lower[row][column]);
      } else lower[row][column] = value / lower[column][column];
    }
  }
  return logDeterminant;
}

function quadraticForm(row, matrix) {
  let value = 0;
  for (let first = 0; first < row.length; first += 1) {
    for (let second = 0; second < row.length; second += 1) value += row[first] * matrix[first][second] * row[second];
  }
  return value;
}

function rawSha256(value) {
  return sha256(value).slice("sha256:".length);
}

function monotoneChainHull(points) {
  const unique = [...new Map(points.map((point) => [`${point.x}\u0000${point.y}`, { x: point.x, y: point.y }])).values()]
    .sort((left, right) => left.x - right.x || left.y - right.y);
  if (unique.length < 3) fail("STAT_RANK_DEFICIENT", "response-surface support requires at least three unique factor-coordinate pairs");
  const cross = (origin, first, second) => (first.x - origin.x) * (second.y - origin.y) - (first.y - origin.y) * (second.x - origin.x);
  const lower = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    const point = unique[index];
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop();
    upper.push(point);
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  if (hull.length < 3) fail("STAT_RANK_DEFICIENT", "response-surface factor coordinates are collinear");
  return hull;
}

function pointInsideOrOnConvexHull(point, hull, tolerance = 1e-10) {
  for (let index = 0; index < hull.length; index += 1) {
    const first = hull[index];
    const second = hull[(index + 1) % hull.length];
    const cross = (second.x - first.x) * (point.y - first.y) - (second.y - first.y) * (point.x - first.x);
    if (cross < -tolerance) return false;
  }
  return true;
}

function inclusiveGrid(minimum, maximum, count) {
  const step = (maximum - minimum) / (count - 1);
  return Array.from({ length: count }, (_, index) => index === count - 1 ? maximum : Object.is(minimum + step * index, -0) ? 0 : minimum + step * index);
}

function designMatrix(data, intercept) {
  const terms = [];
  if (intercept) terms.push({ name: "Intercept", kind: "intercept" });
  for (const predictor of data.predictors) {
    if (predictor.type === "categorical") {
      for (const level of predictor.levels) {
        if (level !== predictor.reference) terms.push({ name: `${predictor.name}[${level}]`, kind: "categorical", predictor: predictor.name, level, reference: predictor.reference });
      }
    } else terms.push({ name: predictor.name, kind: "numeric", predictor: predictor.name });
  }
  const x = data.y.map((_, row) => terms.map((term) => {
    if (term.kind === "intercept") return 1;
    const predictor = data.predictors.find((item) => item.name === term.predictor);
    return term.kind === "numeric" ? predictor.values[row] : predictor.values[row] === term.level ? 1 : 0;
  }));
  return { x, terms };
}

function olsCore(y, x, budget) {
  const xt = transpose(x);
  const xtx = matMul(xt, x, budget);
  const inverse = invert(xtx);
  const betaMatrix = matMul(matMul(inverse, xt, budget), y.map((value) => [value]), budget);
  const beta = betaMatrix.map((row) => row[0]);
  const fitted = x.map((row) => row.reduce((acc, value, index) => acc + value * beta[index], 0));
  const residuals = y.map((value, index) => value - fitted[index]);
  return { beta, inverse, fitted, residuals };
}

function leverageValues(x, inverseBread, weights, budget) {
  return x.map((row, rowIndex) => {
    let value = 0;
    for (let j = 0; j < row.length; j += 1) {
      for (let k = 0; k < row.length; k += 1) {
        budget.check();
        value += row[j] * inverseBread[j][k] * row[k];
      }
    }
    return Math.max(0, Math.min(1 - 1e-12, value * (weights ? weights[rowIndex] : 1)));
  });
}

function sandwichCovariance(x, inverseBread, scoreResiduals, leverage, covariance, budget) {
  const n = x.length;
  const p = x[0].length;
  const meat = Array.from({ length: p }, () => Array(p).fill(0));
  for (let row = 0; row < n; row += 1) {
    let scale = scoreResiduals[row] ** 2;
    if (covariance === "hc1") scale *= n / (n - p);
    if (covariance === "hc2") scale /= Math.max(1e-12, 1 - leverage[row]);
    if (covariance === "hc3") scale /= Math.max(1e-12, (1 - leverage[row]) ** 2);
    for (let j = 0; j < p; j += 1) {
      for (let k = 0; k < p; k += 1) {
        budget.check();
        meat[j][k] += scale * x[row][j] * x[row][k];
      }
    }
  }
  return matMul(matMul(inverseBread, meat, budget), inverseBread, budget);
}

function breuschPaganDiagnostic(x, residuals, budget) {
  try {
    const hasInterceptColumn = x.every((row) => row[0] === 1);
    const auxiliaryX = hasInterceptColumn ? x : x.map((row) => [1, ...row]);
    if (auxiliaryX[0].length < 2 || residuals.length <= auxiliaryX[0].length) return { name: "Breusch-Pagan", status: "not_evaluated", reason: "insufficient residual degrees of freedom" };
    const squared = residuals.map((value) => value ** 2);
    if (minMax(squared).min === minMax(squared).max) return { name: "Breusch-Pagan", status: "not_evaluated", reason: "squared residuals are constant" };
    const auxiliary = olsCore(squared, auxiliaryX, budget);
    const centered = mean(squared, budget);
    const sst = sum(squared.map((value) => (value - centered) ** 2), budget);
    const sse = sum(auxiliary.residuals.map((value) => value ** 2), budget);
    const rSquared = Math.max(0, Math.min(1, 1 - sse / sst));
    const statistic = residuals.length * rSquared;
    const df = auxiliaryX[0].length - 1;
    return { name: "Breusch-Pagan", status: "evaluated", statistic, df, pValue: pFromChiSquare(statistic, df), method: "LM auxiliary regression on squared OLS residuals" };
  } catch (error) {
    return { name: "Breusch-Pagan", status: "not_evaluated", reason: error.message };
  }
}

function analyzeLinearRegression(data, options, budget) {
  const design = designMatrix(data, options.intercept);
  const x = design.x;
  const n = data.y.length;
  const p = x[0].length;
  if (n <= p) fail("STAT_INVALID_INPUT", "linear regression requires more rows than fitted coefficients");
  const core = olsCore(data.y, x, budget);
  const sse = sum(core.residuals.map((value) => value * value), budget);
  if (sse === 0) fail("STAT_DEGENERATE", "perfect fit leaves no residual variance for inference");
  const yMean = mean(data.y, budget);
  const sst = sum(data.y.map((value) => (value - yMean) ** 2), budget);
  if (sst === 0) fail("STAT_DEGENERATE", "outcome variance is zero");
  const dfResidual = n - p;
  const mse = sse / dfResidual;
  const rSquared = 1 - sse / sst;
  const adjustedRSquared = 1 - (1 - rSquared) * (n - 1) / dfResidual;
  const names = design.terms.map((term) => term.name);
  const leverage = leverageValues(x, core.inverse, null, budget);
  const covarianceMatrix = options.covariance === "classical"
    ? core.inverse.map((row) => row.map((value) => value * mse))
    : sandwichCovariance(x, core.inverse, core.residuals, leverage, options.covariance, budget);
  const critical = tCritical(options.confidenceLevel, dfResidual);
  const coefficients = core.beta.map((estimate, index) => {
    const standardError = Math.sqrt(Math.max(0, covarianceMatrix[index][index]));
    if (standardError === 0) fail("STAT_DEGENERATE", "coefficient standard error is zero");
    const statistic = estimate / standardError;
    return { term: names[index], estimate, standardError, statistic, df: dfResidual, pValue: pFromT(statistic, dfResidual, "two-sided"), lower: estimate - critical * standardError, upper: estimate + critical * standardError };
  });
  const modelDf = p - (options.intercept ? 1 : 0);
  const f = modelDf > 0 ? ((sst - sse) / modelDf) / mse : null;
  const modelP = f === null ? null : pFromF(f, modelDf, dfResidual);
  const durbinWatsonDenominator = sum(core.residuals.map((value) => value * value), budget);
  const durbinWatson = sum(core.residuals.slice(1).map((value, index) => (value - core.residuals[index]) ** 2), budget) / durbinWatsonDenominator;
  const residualHistogram = histogram(core.residuals);
  const influence = core.residuals.map((residual, index) => ({ row: index + 1, leverage: leverage[index], residual, cooksDistance: residual ** 2 / (p * mse) * leverage[index] / Math.max(1e-12, (1 - leverage[index]) ** 2) }));
  const influential = [...influence].sort((a, b) => b.cooksDistance - a.cooksDistance || a.row - b.row).slice(0, 10);
  const categoricalCoding = data.predictors.filter((predictor) => predictor.type === "categorical").map((predictor) => ({ predictor: predictor.name, levels: predictor.levels, reference: predictor.reference, coding: "treatment/reference" }));
  return {
    sample: { n, predictors: data.predictors.length, coefficients: p },
    estimates: { coefficients, rSquared, adjustedRSquared, residualStandardError: Math.sqrt(mse), sse, sst, covariance: options.covariance, expandedTerms: names },
    tests: f === null ? [] : [{ name: "Overall regression F test", statistic: f, distribution: "F", df1: modelDf, df2: dfResidual, pValue: modelP }],
    confidenceIntervals: coefficients.map((coefficient) => ({ parameter: coefficient.term, level: options.confidenceLevel, lower: coefficient.lower, upper: coefficient.upper, method: options.covariance === "classical" ? "classical OLS Student t" : `${options.covariance.toUpperCase()} covariance with residual-df t reference` })),
    effectSizes: [{ name: "R squared", estimate: rSquared }, { name: "adjusted R squared", estimate: adjustedRSquared }],
    assumptions: [{ name: "linearity", status: "requires_residual_plot_review" }, { name: "independent errors", status: "diagnostic_attached" }, { name: "homoscedastic errors", status: options.covariance === "classical" ? "diagnostic_attached" : "robust_covariance_requested_but_design_review_still_required" }, { name: "normal residuals", status: "diagnostic_attached" }, { name: "full-rank treatment coding", status: "verified_by_matrix_inversion" }],
    diagnostics: [jarqueBera(core.residuals, budget), breuschPaganDiagnostic(x, core.residuals, budget), { name: "Durbin-Watson", statistic: durbinWatson, interpretation: "approximately 2 is consistent with no first-order residual autocorrelation" }, { name: "residual range", ...minMax(core.residuals) }, { name: "covariance estimator", value: options.covariance, inferenceReference: "residual-df t", boundary: "HC estimators do not repair clustering, dependence, misspecification, or small-sample bias beyond the declared correction" }, { name: "categorical treatment coding", predictors: categoricalCoding }, { name: "influence screen", thresholdLeverage: 2 * p / n, thresholdCooksDistance: 4 / n, topRows: influential, status: "screen_only" }],
    artifacts: [
      tableArtifact(`Linear regression: ${data.outcomeLabel}`, "Ordinary least-squares coefficient table.", [{ key: "term", label: "Term", type: "string" }, { key: "estimate", label: "Estimate", type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "statistic", label: "t", type: "number" }, { key: "df", label: "df", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "lower", label: "CI lower", type: "number" }, { key: "upper", label: "CI upper", type: "number" }], coefficients, [`R² = ${rSquared}; adjusted R² = ${adjustedRSquared}; covariance = ${options.covariance}.`, "Categorical terms use deterministic treatment coding with the declared reference level."]),
      vegaArtifact("coefficient-plot", "Linear regression coefficients", { data: { values: coefficients.filter((row) => row.term !== "Intercept") }, layer: [{ mark: { type: "rule", strokeWidth: 2 }, encoding: { y: { field: "term", type: "nominal", title: null }, x: { field: "lower", type: "quantitative", title: "Coefficient" }, x2: { field: "upper" } } }, { mark: { type: "point", filled: true, size: 80 }, encoding: { y: { field: "term", type: "nominal" }, x: { field: "estimate", type: "quantitative" }, tooltip: [{ field: "term" }, { field: "estimate", format: ".4g" }, { field: "pValue", format: ".4g" }] } }, { mark: { type: "rule", strokeDash: [4, 4], color: "#777" }, encoding: { x: { datum: 0 } } }] }),
      vegaArtifact("residual-distribution", "Residual distribution", { data: { values: residualHistogram }, mark: "bar", encoding: { x: { field: "binStart", type: "quantitative", bin: "binned", title: "Residual" }, x2: { field: "binEnd" }, y: { field: "count", type: "quantitative" } } }),
    ],
  };
}

function lmmSufficientStatistics(y, x, groupRows, budget) {
  const p = x[0].length;
  const xtx = Array.from({ length: p }, () => Array(p).fill(0));
  const xty = Array(p).fill(0);
  let yty = 0;
  for (let rowIndex = 0; rowIndex < y.length; rowIndex += 1) {
    const row = x[rowIndex];
    const outcome = y[rowIndex];
    yty += outcome * outcome;
    for (let left = 0; left < p; left += 1) {
      budget.check();
      xty[left] += row[left] * outcome;
      for (let right = left; right < p; right += 1) xtx[left][right] += row[left] * row[right];
    }
  }
  for (let left = 0; left < p; left += 1) {
    for (let right = 0; right < left; right += 1) xtx[left][right] = xtx[right][left];
  }
  const groups = groupRows.map((rows) => {
    const sumX = Array(p).fill(0);
    let sumY = 0;
    for (const rowIndex of rows) {
      sumY += y[rowIndex];
      for (let column = 0; column < p; column += 1) sumX[column] += x[rowIndex][column];
    }
    return { n: rows.length, sumX, sumY };
  });
  return { n: y.length, p, xtx, xty, yty, groups };
}

function lmmProfilePoint(sufficient, fitMethod, logOnePlusLambda, budget) {
  const lambda = Math.expm1(logOnePlusLambda);
  if (!(lambda >= 0) || !Number.isFinite(lambda)) fail("STAT_NUMERIC_OVERFLOW", "LMM variance-ratio search exceeded its numeric boundary");
  const information = sufficient.xtx.map((row) => [...row]);
  const rhs = [...sufficient.xty];
  let logDeterminantA = 0;
  for (const group of sufficient.groups) {
    const shrink = lambda / (1 + lambda * group.n);
    logDeterminantA += Math.log1p(lambda * group.n);
    for (let left = 0; left < sufficient.p; left += 1) {
      budget.check();
      rhs[left] -= shrink * group.sumX[left] * group.sumY;
      for (let right = 0; right < sufficient.p; right += 1) information[left][right] -= shrink * group.sumX[left] * group.sumX[right];
    }
  }
  const informationLogDeterminant = positiveDefiniteLogDeterminant(information);
  const informationInverse = invert(information);
  const conditionNumber = matrixInfinityNorm(information) * matrixInfinityNorm(informationInverse);
  if (!Number.isFinite(conditionNumber)) fail("STAT_ILL_CONDITIONED", "LMM weighted fixed-effect information matrix has a non-finite condition number");
  const beta = informationInverse.map((row) => row.reduce((total, value, index) => total + value * rhs[index], 0));
  const betaXty = beta.reduce((total, value, index) => total + value * sufficient.xty[index], 0);
  let betaXtxBeta = 0;
  for (let left = 0; left < sufficient.p; left += 1) {
    for (let right = 0; right < sufficient.p; right += 1) betaXtxBeta += beta[left] * sufficient.xtx[left][right] * beta[right];
  }
  let q = sufficient.yty - 2 * betaXty + betaXtxBeta;
  for (const group of sufficient.groups) {
    const residualSum = group.sumY - group.sumX.reduce((total, value, index) => total + value * beta[index], 0);
    q -= lambda / (1 + lambda * group.n) * residualSum * residualSum;
  }
  const n = sufficient.n;
  const p = sufficient.p;
  const residualDf = n - p;
  if (!(q > 0) || !Number.isFinite(q)) fail("STAT_DEGENERATE", "LMM profile leaves no finite residual variance");
  const divisor = fitMethod === "ml" ? n : residualDf;
  const residualVariance = q / divisor;
  if (!(residualVariance > 0) || !Number.isFinite(residualVariance)) fail("STAT_NUMERIC_FAILURE", "LMM residual variance is not finite and positive");
  const objective = fitMethod === "ml"
    ? n * (Math.log(2 * Math.PI) + 1 + Math.log(residualVariance)) + logDeterminantA
    : residualDf * (Math.log(2 * Math.PI) + 1 + Math.log(residualVariance)) + logDeterminantA + informationLogDeterminant;
  if (!Number.isFinite(objective)) fail("STAT_NUMERIC_FAILURE", "LMM likelihood objective is not finite");
  return {
    lambda,
    beta,
    q,
    residualVariance,
    randomInterceptVariance: lambda * residualVariance,
    objective,
    logLikelihood: -0.5 * objective,
    logDeterminantA,
    informationLogDeterminant,
    informationInverse,
    conditionNumber,
  };
}

function optimizeLmmVarianceRatio(y, x, groupRows, options, budget) {
  const sufficient = lmmSufficientStatistics(y, x, groupRows, budget);
  const exponentMinimum = -12;
  const exponentMaximum = 12;
  const exponentStep = 0.125;
  const positiveGridCount = Math.round((exponentMaximum - exponentMinimum) / exponentStep) + 1;
  const evaluateLogLambda = (logLambda) => lmmProfilePoint(
    sufficient,
    options.fitMethod,
    Math.log1p(Math.exp(logLambda)),
    budget,
  );
  const zeroFit = lmmProfilePoint(sufficient, options.fitMethod, 0, budget);
  const grid = Array.from({ length: positiveGridCount }, (_, index) => {
    const exponent = exponentMinimum + exponentStep * index;
    const logLambda = exponent * Math.LN10;
    return { exponent, logLambda, fit: evaluateLogLambda(logLambda) };
  });
  let bestIndex = 0;
  for (let index = 1; index < grid.length; index += 1) {
    const objectiveDelta = grid[index].fit.objective - grid[bestIndex].fit.objective;
    if (objectiveDelta < 0 || (Math.abs(objectiveDelta) <= 1e-12 && grid[index].fit.lambda < grid[bestIndex].fit.lambda)) bestIndex = index;
  }
  if (zeroFit.objective <= grid[bestIndex].fit.objective + 1e-12 * (1 + Math.abs(zeroFit.objective))) {
    fail("STAT_SINGULAR_FIT", "random-intercept variance is on the zero boundary; the engine will not silently return an OLS fit");
  }
  if (bestIndex === grid.length - 1) fail("STAT_VARIANCE_RATIO_LIMIT", "LMM profile objective is still decreasing at the lambda = 1e12 search boundary");
  let left = grid[Math.max(0, bestIndex - 1)].logLambda;
  let right = grid[bestIndex + 1].logLambda;
  const golden = (Math.sqrt(5) - 1) / 2;
  let firstScale = right - golden * (right - left);
  let secondScale = left + golden * (right - left);
  let first = evaluateLogLambda(firstScale);
  let second = evaluateLogLambda(secondScale);
  let converged = false;
  let iterations = 0;
  for (; iterations < options.maxIterations; iterations += 1) {
    if (right - left <= Math.min(1e-10, options.tolerance)) {
      converged = true;
      break;
    }
    if (first.objective <= second.objective) {
      right = secondScale;
      secondScale = firstScale;
      second = first;
      firstScale = right - golden * (right - left);
      first = evaluateLogLambda(firstScale);
    } else {
      left = firstScale;
      firstScale = secondScale;
      first = second;
      secondScale = left + golden * (right - left);
      second = evaluateLogLambda(secondScale);
    }
  }
  if (!converged) fail("STAT_NON_CONVERGENCE", "LMM variance-ratio optimizer did not satisfy the declared tolerance");
  const refinedLogLambda = (left + right) / 2;
  const fit = evaluateLogLambda(refinedLogLambda);
  if (fit.conditionNumber > 1e10) {
    fail("STAT_ILL_CONDITIONED", "LMM weighted fixed-effect information matrix exceeds the 1e10 condition boundary at the fitted variance ratio", { conditionNumber: fit.conditionNumber, maximum: 1e10 });
  }
  const singularThetaThreshold = 1e-4;
  if (!(Math.sqrt(fit.lambda) > singularThetaThreshold)) {
    fail("STAT_SINGULAR_FIT", "random-intercept variance is numerically indistinguishable from zero at the declared tolerance");
  }
  const logLambda = Math.log(fit.lambda);
  const derivativeStep = 1e-4;
  const below = evaluateLogLambda(logLambda - derivativeStep);
  const above = evaluateLogLambda(logLambda + derivativeStep);
  const gradient = (above.objective - below.objective) / (2 * derivativeStep);
  const curvature = (above.objective - 2 * fit.objective + below.objective) / (derivativeStep * derivativeStep);
  const gradientTolerance = Math.max(1e-5, Math.sqrt(options.tolerance) * (1 + Math.abs(fit.objective)));
  const globalGridAgreement = fit.objective <= grid[bestIndex].fit.objective + options.tolerance * (1 + Math.abs(grid[bestIndex].fit.objective));
  if (!Number.isFinite(gradient) || !Number.isFinite(curvature) || curvature <= 0 || Math.abs(gradient) > gradientTolerance || !globalGridAgreement) {
    fail("STAT_NON_CONVERGENCE", "LMM optimizer failed the deterministic gradient, curvature, or global-grid agreement check", {
      gradient,
      curvature,
      gradientTolerance,
      globalGridAgreement,
    });
  }
  const fitted = x.map((row) => row.reduce((total, value, index) => total + value * fit.beta[index], 0));
  const residuals = y.map((value, index) => value - fitted[index]);
  return {
    ...fit,
    fitted,
    residuals,
    iterations,
    converged: true,
    search: {
      parameter: "log(lambda)",
      gridVersion: "log10-lambda-minus12-plus12-step0.125-v1",
      zeroObjective: zeroFit.objective,
      lowerExponent: exponentMinimum,
      upperExponent: exponentMaximum,
      positiveGridCount,
      bracket: { lower: left, upper: right },
      tolerance: options.tolerance,
      derivativeStep,
      gradient,
      curvature,
      gradientTolerance,
      globalGridAgreement,
    },
  };
}

function lmmProfileRows(data, design, beta, covarianceMatrix, confidenceLevel) {
  const critical = tCritical(confidenceLevel, data.y.length - design.terms.length);
  const predictor = data.predictors[0] || null;
  const numericMeans = new Map(data.predictors.filter((item) => item.type === "numeric").map((item) => [item.name, mean(item.values)]));
  const rowFor = (targetValue) => design.terms.map((term) => {
    if (term.kind === "intercept") return 1;
    if (term.kind === "numeric") return predictor?.name === term.predictor ? targetValue : numericMeans.get(term.predictor);
    if (predictor?.name === term.predictor) return targetValue === term.level ? 1 : 0;
    return 0;
  });
  if (!predictor) {
    const row = rowFor(null);
    const estimate = row.reduce((total, value, index) => total + value * beta[index], 0);
    const standardError = Math.sqrt(Math.max(0, quadraticForm(row, covarianceMatrix)));
    return { predictor: "Intercept", kind: "intercept", rows: [{ profileValue: "Population mean", estimate, lower: estimate - critical * standardError, upper: estimate + critical * standardError }] };
  }
  if (predictor.type === "numeric") {
    const range = minMax(predictor.values);
    const values = inclusiveGrid(range.min, range.max, 41);
    return {
      predictor: predictor.name,
      kind: "numeric",
      rows: values.map((profileValue) => {
        const row = rowFor(profileValue);
        const estimate = row.reduce((total, value, index) => total + value * beta[index], 0);
        const standardError = Math.sqrt(Math.max(0, quadraticForm(row, covarianceMatrix)));
        return { profileValue, estimate, lower: estimate - critical * standardError, upper: estimate + critical * standardError };
      }),
    };
  }
  return {
    predictor: predictor.name,
    kind: "categorical",
    rows: predictor.levels.map((profileValue) => {
      const row = rowFor(profileValue);
      const estimate = row.reduce((total, value, index) => total + value * beta[index], 0);
      const standardError = Math.sqrt(Math.max(0, quadraticForm(row, covarianceMatrix)));
      return { profileValue, estimate, lower: estimate - critical * standardError, upper: estimate + critical * standardError };
    }),
  };
}

function analyzeGaussianRandomInterceptLmm(data, options, budget) {
  if (!options.intercept) fail("STAT_INVALID_INPUT", "gaussian_random_intercept_lmm v1 requires a fixed intercept");
  const design = designMatrix(data, options.intercept);
  const x = design.x;
  const n = data.y.length;
  const p = x[0]?.length || 0;
  if (p < 1) fail("STAT_INVALID_INPUT", "gaussian_random_intercept_lmm requires at least one fixed-effect coefficient");
  if (n <= p + 2) fail("STAT_INSUFFICIENT_SAMPLE", "gaussian_random_intercept_lmm requires more than p + 2 rows for residual inference");
  const rank = matrixRank(x);
  if (rank !== p) fail("STAT_RANK_DEFICIENT", `LMM fixed-effect design rank is ${rank}; ${p} independent columns are required`);
  const groupRows = data.groupLevels.map((group) => data.groups.flatMap((value, index) => value === group ? [index] : []));
  const fit = optimizeLmmVarianceRatio(data.y, x, groupRows, options, budget);
  const residualDf = n - p;
  const covarianceMatrix = fit.informationInverse.map((row) => row.map((value) => value * fit.residualVariance));
  const critical = tCritical(options.confidenceLevel, residualDf);
  const fixedEffects = fit.beta.map((estimate, index) => {
    const standardError = Math.sqrt(Math.max(0, covarianceMatrix[index][index]));
    if (!(standardError > 0)) fail("STAT_DEGENERATE", "LMM fixed-effect standard error is zero");
    const statistic = estimate / standardError;
    return {
      term: design.terms[index].name,
      estimate,
      standardError,
      statistic,
      df: residualDf,
      pValue: pFromT(statistic, residualDf, "two-sided"),
      lower: estimate - critical * standardError,
      upper: estimate + critical * standardError,
    };
  });
  const randomVariance = fit.randomInterceptVariance;
  const residualVariance = fit.residualVariance;
  const totalVariance = randomVariance + residualVariance;
  const icc = randomVariance / totalVariance;
  const normalCritical = normalInv(1 - (1 - options.confidenceLevel) / 2);
  const groupEffects = data.groupLevels.map((group, groupIndex) => {
    const rows = groupRows[groupIndex];
    const residualSum = sum(rows.map((row) => fit.residuals[row]), budget);
    const denominator = residualVariance + rows.length * randomVariance;
    const effect = randomVariance / denominator * residualSum;
    const posteriorVariance = randomVariance * residualVariance / denominator;
    const posteriorSd = Math.sqrt(Math.max(0, posteriorVariance));
    const shrinkage = rows.length * randomVariance / denominator;
    return { group, n: rows.length, effect, posteriorSd, shrinkage, lower: effect - normalCritical * posteriorSd, upper: effect + normalCritical * posteriorSd };
  });
  const effectByGroup = new Map(groupEffects.map((row) => [row.group, row.effect]));
  const withinGroupCount = new Map();
  const observationRows = data.y.map((observed, index) => {
    const group = data.groups[index];
    const withinGroupIndex = (withinGroupCount.get(group) || 0) + 1;
    withinGroupCount.set(group, withinGroupIndex);
    const marginalFitted = fit.fitted[index];
    const conditionalFitted = marginalFitted + effectByGroup.get(group);
    const marginalResidual = observed - marginalFitted;
    const conditionalResidual = observed - conditionalFitted;
    return {
      row: index + 1,
      observation: data.observationLabels[index],
      group,
      withinGroupIndex,
      observed,
      marginalFitted,
      conditionalFitted,
      marginalResidual,
      conditionalResidual,
      standardizedConditionalResidual: conditionalResidual / Math.sqrt(residualVariance),
    };
  });
  const residualQqRows = [...observationRows].sort((left, right) => left.conditionalResidual - right.conditionalResidual || left.row - right.row).map((row, index) => ({ expected: normalInv((index + 0.5) / n), observed: row.standardizedConditionalResidual, observation: row.observation }));
  const randomQqRows = [...groupEffects].sort((left, right) => left.effect - right.effect || left.group.localeCompare(right.group, "en")).map((row, index) => ({ expected: normalInv((index + 0.5) / groupEffects.length), observed: row.effect / Math.sqrt(randomVariance), group: row.group }));
  const profile = lmmProfileRows(data, design, fit.beta, covarianceMatrix, options.confidenceLevel);
  const parameterCount = p + 2;
  const deviance = -2 * fit.logLikelihood;
  const sortedGroupSizes = groupRows.map((rows) => rows.length).sort((left, right) => left - right);
  const formula = `${data.outcomeLabel} ~ ${["1", ...design.terms.slice(1).map((term) => term.name)].join(" + ")} + (1 | ${data.groupLabel})`;
  const modelSummary = [{
    fitMethod: options.fitMethod.toUpperCase(),
    formula,
    observations: n,
    groups: data.groupLevels.length,
    minimumGroupSize: sortedGroupSizes[0],
    medianGroupSize: quantileR7(sortedGroupSizes, 0.5),
    maximumGroupSize: sortedGroupSizes[sortedGroupSizes.length - 1],
    fixedCoefficients: p,
    logLikelihood: fit.logLikelihood,
    deviance,
    aic: options.fitMethod === "ml" ? deviance + 2 * parameterCount : null,
    bic: options.fitMethod === "ml" ? deviance + Math.log(n) * parameterCount : null,
    converged: fit.converged,
    iterations: fit.iterations,
    conditionNumber: fit.conditionNumber,
  }];
  const varianceComponents = [
    { component: `Random intercept: ${data.groupLabel}`, variance: randomVariance, standardDeviation: Math.sqrt(randomVariance), icc },
    { component: "Conditional residual", variance: residualVariance, standardDeviation: Math.sqrt(residualVariance), icc: null },
  ];
  const fixedRowsHash = sha256(fixedEffects);
  const groupRowsHash = sha256(groupEffects);
  const observationRowsHash = sha256(observationRows);
  const profileRowsHash = sha256(profile.rows);
  const coding = data.predictors.filter((predictor) => predictor.type === "categorical").map((predictor) => ({ predictor: predictor.name, levels: predictor.levels, reference: predictor.reference, coding: "treatment/reference" }));
  const fixedEffectsArtifact = tableArtifact(`LMM fixed effects: ${data.outcomeLabel}`, "Gaussian random-intercept mixed model fixed effects using residual n - p t inference.", [{ key: "term", label: "Term", type: "string" }, { key: "estimate", label: "Estimate", type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "statistic", label: "t", type: "number" }, { key: "df", label: "df", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "lower", label: "CI lower", type: "number" }, { key: "upper", label: "CI upper", type: "number" }], fixedEffects, [`Fit method = ${options.fitMethod.toUpperCase()}; fixed-effect df = residual n - p.`, "This is not Satterthwaite or Kenward-Roger inference.", "Categorical terms use deterministic treatment coding with the declared reference level."], "lmm-fixed-effects-table");
  const profileEncoding = profile.kind === "numeric"
    ? { x: { field: "profileValue", type: "quantitative", title: profile.predictor } }
    : { x: { field: "profileValue", type: "nominal", title: profile.predictor, sort: null } };
  return {
    sample: { n, groups: data.groupLevels.length, minimumGroupSize: Math.min(...groupRows.map((rows) => rows.length)), maximumGroupSize: Math.max(...groupRows.map((rows) => rows.length)), predictors: data.predictors.length, coefficients: p },
    estimates: {
      fitMethod: options.fitMethod,
      fixedEffects,
      varianceComponents: { randomInterceptVariance: randomVariance, residualVariance, totalVariance, randomInterceptStandardDeviation: Math.sqrt(randomVariance), residualStandardDeviation: Math.sqrt(residualVariance), varianceRatio: fit.lambda, icc },
      likelihood: { logLikelihood: fit.logLikelihood, deviance, aic: modelSummary[0].aic, bic: modelSummary[0].bic, comparisonBoundary: options.fitMethod === "ml" ? "ML information criteria may compare models fit to the same observations." : "REML likelihoods are not comparable across different fixed-effect designs." },
      groupEffects,
      rendererDataContract: { inlineRows: "all", sampling: "none", aggregation: "none", fixedEffectRows: fixedEffects.length, groupEffectRows: groupEffects.length, observationRows: observationRows.length, profileRows: profile.rows.length, fixedRowsHash, groupRowsHash, observationRowsHash, profileRowsHash },
    },
    tests: fixedEffects.map((row) => ({ name: `Fixed effect: ${row.term}`, statistic: row.statistic, distribution: "Student t with residual n - p degrees of freedom", df: row.df, pValue: row.pValue })),
    confidenceIntervals: fixedEffects.map((row) => ({ parameter: row.term, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: "residual n - p Student t approximation" })),
    effectSizes: [{ name: "intraclass correlation coefficient", estimate: icc }, ...fixedEffects.map((row) => ({ name: `fixed effect ${row.term}`, estimate: row.estimate }))],
    assumptions: [
      { name: "single random-intercept grouping factor", status: "verified_by_input_contract", groupLabel: data.groupLabel },
      { name: "conditional Gaussian residuals", status: "diagnostic_attached" },
      { name: "Gaussian random intercepts", status: "diagnostic_attached" },
      { name: "independent groups", status: "requires_design_review" },
      { name: "fixed-effect functional form", status: "requires_profile_and_residual_review" },
      { name: "complete observations", status: "verified_by_input_contract" },
    ],
    diagnostics: [
      jarqueBera(observationRows.map((row) => row.conditionalResidual), budget),
      { name: "variance-ratio optimizer", status: "converged", iterations: fit.iterations, objective: fit.objective, conditionNumber: fit.conditionNumber, search: fit.search },
      { name: "singular-fit boundary", status: "passed", varianceRatio: fit.lambda, policy: "zero or near-zero random-intercept variance fails closed instead of falling back to OLS" },
      { name: "fixed-effect inference boundary", status: "bounded", method: "residual n - p Student t", unsupported: ["Satterthwaite df", "Kenward-Roger df", "bootstrap inference", "likelihood-ratio boundary test"] },
      { name: "random-effects boundary", status: "bounded_random_intercept_only", unsupported: ["random slopes", "crossed effects", "nested effects", "residual correlation structures", "weights", "GLMM", "nonlinear mixed effects", "missing-data estimation"] },
      { name: "categorical treatment coding", predictors: coding },
      { name: "renderer exact-data contract", sampling: "none", aggregation: "none", fixedRowsHash, groupRowsHash, observationRowsHash, profileRowsHash },
    ],
    artifacts: [
      tableArtifact("LMM model summary", "Bounded Gaussian random-intercept model fit summary.", [{ key: "fitMethod", label: "Fit", type: "string" }, { key: "formula", label: "Formula", type: "string" }, { key: "observations", label: "Rows", type: "number" }, { key: "groups", label: "Groups", type: "number" }, { key: "minimumGroupSize", label: "Min group n", type: "number" }, { key: "medianGroupSize", label: "Median group n", type: "number" }, { key: "maximumGroupSize", label: "Max group n", type: "number" }, { key: "fixedCoefficients", label: "Fixed coefficients", type: "number" }, { key: "logLikelihood", label: options.fitMethod === "ml" ? "Log likelihood" : "Restricted log likelihood", type: "number" }, { key: "deviance", label: options.fitMethod === "ml" ? "Deviance" : "REML criterion", type: "number" }, { key: "aic", label: "AIC", type: "number" }, { key: "bic", label: "BIC", type: "number" }, { key: "converged", label: "Converged", type: "boolean" }, { key: "iterations", label: "Optimizer iterations", type: "number" }, { key: "conditionNumber", label: "Information condition", type: "number" }], modelSummary, [options.fitMethod === "ml" ? "AIC and BIC include fixed coefficients plus two variance parameters." : "AIC/BIC are withheld for REML; restricted likelihoods are not comparable across different fixed-effect designs."], "lmm-model-summary-table"),
      fixedEffectsArtifact,
      tableArtifact("LMM variance components", "Between-group random-intercept and conditional residual variation.", [{ key: "component", label: "Component", type: "string" }, { key: "variance", label: "Variance", type: "number" }, { key: "standardDeviation", label: "SD", type: "number" }, { key: "icc", label: "ICC", type: "number" }], varianceComponents, ["ICC is random-intercept variance divided by total modeled variance."], "lmm-variance-components-table"),
      tableArtifact("LMM group effects", "Empirical-Bayes random-intercept estimates with conditional posterior uncertainty.", [{ key: "group", label: data.groupLabel, type: "string" }, { key: "n", label: "n", type: "number" }, { key: "effect", label: "BLUP", type: "number" }, { key: "posteriorSd", label: "Posterior SD", type: "number" }, { key: "shrinkage", label: "Shrinkage", type: "number" }, { key: "lower", label: "Interval lower", type: "number" }, { key: "upper", label: "Interval upper", type: "number" }], groupEffects, ["Intervals condition on fitted variance parameters and use a normal reference; they are not multiple-comparison tests."], "lmm-group-effects-table"),
      tableArtifact("LMM observation diagnostics", "Exact marginal and conditional fitted values and residuals for every included row.", [{ key: "row", label: "Row", type: "number" }, { key: "observation", label: "Observation", type: "string" }, { key: "group", label: data.groupLabel, type: "string" }, { key: "withinGroupIndex", label: "Within-group order", type: "number" }, { key: "observed", label: "Observed", type: "number" }, { key: "marginalFitted", label: "Marginal fitted", type: "number" }, { key: "conditionalFitted", label: "Conditional fitted", type: "number" }, { key: "marginalResidual", label: "Marginal residual", type: "number" }, { key: "conditionalResidual", label: "Conditional residual", type: "number" }, { key: "standardizedConditionalResidual", label: "Standardized residual", type: "number" }], observationRows, ["Within-group order is row order unless a real time predictor is explicitly present; it is not an inferred time axis."], "lmm-observation-diagnostics-table"),
      vegaArtifact("lmm-fixed-effects-plot", "LMM fixed effects", { data: { values: fixedEffects }, layer: [{ mark: { type: "rule", strokeWidth: 2 }, encoding: { y: { field: "term", type: "nominal", title: null, sort: null }, x: { field: "lower", type: "quantitative", title: "Fixed-effect estimate" }, x2: { field: "upper" } } }, { mark: { type: "point", filled: true, size: 85 }, encoding: { y: { field: "term", type: "nominal", sort: null }, x: { field: "estimate", type: "quantitative" }, tooltip: [{ field: "term" }, { field: "estimate", format: ".5g" }, { field: "standardError", format: ".5g" }, { field: "pValue", format: ".5g" }] } }, { mark: { type: "rule", color: "#777", strokeDash: [4, 4] }, encoding: { x: { datum: 0 } } }] }),
      vegaArtifact("lmm-marginal-mean-profile", `Population fixed-effect profile: ${profile.predictor}`, { data: { values: profile.rows }, layer: [{ mark: { type: "area", opacity: 0.18 }, encoding: { ...profileEncoding, y: { field: "lower", type: "quantitative", title: data.outcomeLabel }, y2: { field: "upper" } } }, { mark: { type: "line", point: profile.kind !== "numeric" }, encoding: { ...profileEncoding, y: { field: "estimate", type: "quantitative" }, tooltip: [{ field: "profileValue" }, { field: "estimate", format: ".5g" }, { field: "lower", format: ".5g" }, { field: "upper", format: ".5g" }] } }] }),
      vegaArtifact("lmm-subject-trajectory-plot", "Observed and conditional fitted trajectories by group", { data: { values: observationRows }, transform: [{ fold: ["observed", "conditionalFitted"], as: ["series", "value"] }], mark: { type: "line", point: true, opacity: 0.72 }, encoding: { x: { field: "withinGroupIndex", type: "quantitative", title: "Within-group observation order" }, y: { field: "value", type: "quantitative", title: data.outcomeLabel }, color: { field: "group", type: "nominal", title: data.groupLabel }, strokeDash: { field: "series", type: "nominal", title: null }, detail: [{ field: "group" }, { field: "series" }], tooltip: [{ field: "observation" }, { field: "group" }, { field: "series" }, { field: "value", format: ".5g" }] } }),
      vegaArtifact("lmm-random-intercept-plot", "Random-intercept estimates", { data: { values: groupEffects }, layer: [{ mark: { type: "rule", strokeWidth: 2 }, encoding: { y: { field: "group", type: "nominal", title: data.groupLabel, sort: { field: "effect", order: "ascending" } }, x: { field: "lower", type: "quantitative", title: "Random-intercept BLUP" }, x2: { field: "upper" } } }, { mark: { type: "point", filled: true, size: 80 }, encoding: { y: { field: "group", type: "nominal", sort: { field: "effect", order: "ascending" } }, x: { field: "effect", type: "quantitative" }, tooltip: [{ field: "group" }, { field: "n" }, { field: "effect", format: ".5g" }, { field: "posteriorSd", format: ".5g" }, { field: "shrinkage", format: ".4f" }] } }, { mark: { type: "rule", color: "#777", strokeDash: [4, 4] }, encoding: { x: { datum: 0 } } }] }),
      vegaArtifact("lmm-diagnostic-grid", "LMM conditional diagnostics", { vconcat: [{ data: { values: observationRows }, mark: { type: "point", filled: true, opacity: 0.72 }, encoding: { x: { field: "conditionalFitted", type: "quantitative", title: "Conditional fitted" }, y: { field: "standardizedConditionalResidual", type: "quantitative", title: "Standardized conditional residual" }, tooltip: [{ field: "observation" }, { field: "group" }, { field: "standardizedConditionalResidual", format: ".5g" }] } }, { data: { values: residualQqRows }, layer: [{ mark: { type: "line", color: "#777", strokeDash: [4, 4] }, encoding: { x: { field: "expected", type: "quantitative", title: "Expected normal quantile" }, y: { field: "expected", type: "quantitative", title: "Conditional residual quantile" } } }, { mark: { type: "point", filled: true }, encoding: { x: { field: "expected", type: "quantitative" }, y: { field: "observed", type: "quantitative" }, tooltip: [{ field: "observation" }, { field: "observed", format: ".5g" }] } }] }, { data: { values: randomQqRows }, layer: [{ mark: { type: "line", color: "#777", strokeDash: [4, 4] }, encoding: { x: { field: "expected", type: "quantitative", title: "Expected normal quantile" }, y: { field: "expected", type: "quantitative", title: "Standardized random intercept" } } }, { mark: { type: "point", filled: true }, encoding: { x: { field: "expected", type: "quantitative" }, y: { field: "observed", type: "quantitative" }, tooltip: [{ field: "group" }, { field: "observed", format: ".5g" }] } }] }], resolve: { scale: { x: "independent", y: "independent" } } }),
    ],
  };
}

function analyzeResponseSurfaceRegression(data, options, budget) {
  const [factor1, factor2] = data.factors;
  const y = data.response.values;
  const n = y.length;
  const p = 6;
  const x = y.map((_, row) => {
    const first = factor1.codedValues[row];
    const second = factor2.codedValues[row];
    return [1, first, second, first * second, first * first, second * second];
  });
  const rank = matrixRank(x);
  if (rank !== p) fail("STAT_RANK_DEFICIENT", `quadratic response-surface design rank is ${rank}; six independent coefficient columns are required`);
  const xtx = matMul(transpose(x), x, budget);
  let core;
  try {
    core = olsCore(y, x, budget);
  } catch (error) {
    if (error instanceof StatisticsError && error.code === "STAT_SINGULAR_MATRIX") {
      fail("STAT_RANK_DEFICIENT", "quadratic response-surface design is singular or ill-conditioned");
    }
    throw error;
  }
  const conditionNumber = matrixInfinityNorm(xtx) * matrixInfinityNorm(core.inverse);
  if (!Number.isFinite(conditionNumber) || conditionNumber > 1e10) {
    fail("STAT_RANK_DEFICIENT", "quadratic response-surface design exceeds the condition-number boundary", { conditionNumber, maximum: 1e10 });
  }
  const dfResidual = n - p;
  const yMean = mean(y, budget);
  const sse = sum(core.residuals.map((value) => value * value), budget);
  const sst = sum(y.map((value) => (value - yMean) ** 2), budget);
  if (!(sst > 0)) fail("STAT_DEGENERATE", "response_surface_regression requires non-zero response variance");
  if (!(sse > Number.EPSILON * Math.max(1, sst))) {
    fail("STAT_DEGENERATE", "perfect quadratic fit leaves no residual variance for coefficient or model inference");
  }
  const mse = sse / dfResidual;
  const rSquared = Math.max(0, Math.min(1, 1 - sse / sst));
  const adjustedRSquared = 1 - (1 - rSquared) * (n - 1) / dfResidual;
  const modelDf = p - 1;
  const modelF = ((sst - sse) / modelDf) / mse;
  const modelPValue = pFromF(modelF, modelDf, dfResidual);
  const critical = tCritical(options.confidenceLevel, dfResidual);
  const termRows = [
    { term: "intercept", label: "Intercept" },
    { term: "factor1-linear", label: factor1.name },
    { term: "factor2-linear", label: factor2.name },
    { term: "factor1-factor2-interaction", label: `${factor1.name} × ${factor2.name}` },
    { term: "factor1-quadratic", label: `${factor1.name}²` },
    { term: "factor2-quadratic", label: `${factor2.name}²` },
  ].map((term, index) => {
    const estimate = core.beta[index];
    const varianceValue = mse * core.inverse[index][index];
    if (!(varianceValue > 0) || !Number.isFinite(varianceValue)) fail("STAT_NUMERIC_FAILURE", `coefficient variance is invalid for ${term.term}`);
    const standardError = Math.sqrt(varianceValue);
    const statistic = estimate / standardError;
    return {
      ...term,
      estimate,
      standardError,
      statistic,
      df: dfResidual,
      pValue: pFromT(statistic, dfResidual, "two-sided"),
      lower: estimate - critical * standardError,
      upper: estimate + critical * standardError,
    };
  });

  const observations = y.map((observed, row) => ({
    row: row + 1,
    id: `Row ${row + 1}`,
    factor1: factor1.values[row],
    factor2: factor2.values[row],
    codedFactor1: factor1.codedValues[row],
    codedFactor2: factor2.codedValues[row],
    observed,
    fitted: core.fitted[row],
    residual: core.residuals[row],
  }));
  if (observations.some((row) => Object.values(row).some((value) => typeof value === "number" && (!Number.isFinite(value) || Math.abs(value) > 1e15)))) {
    fail("STAT_NUMERIC_OVERFLOW", "response-surface fitted values exceed the numeric artifact boundary");
  }

  const designGroups = new Map();
  for (const row of observations) {
    const key = `${row.codedFactor1}\u0000${row.codedFactor2}`;
    const values = designGroups.get(key) || [];
    values.push(row.observed);
    designGroups.set(key, values);
  }
  let pureErrorSse = 0;
  for (const values of designGroups.values()) {
    const groupMean = mean(values, budget);
    pureErrorSse += sum(values.map((value) => (value - groupMean) ** 2), budget);
  }
  const pureErrorDf = n - designGroups.size;
  const lackOfFitDf = designGroups.size - p;
  const lackOfFitSse = Math.max(0, sse - pureErrorSse);
  const lackOfFit = pureErrorDf > 0 && lackOfFitDf > 0 && pureErrorSse > Number.EPSILON * Math.max(1, sse)
    ? {
      name: "lack-of-fit against replicated design points",
      status: "evaluated",
      statistic: (lackOfFitSse / lackOfFitDf) / (pureErrorSse / pureErrorDf),
      df1: lackOfFitDf,
      df2: pureErrorDf,
      lackOfFitSse,
      pureErrorSse,
    }
    : {
      name: "lack-of-fit against replicated design points",
      status: "not_evaluated",
      lackOfFitSse,
      pureErrorSse,
      lackOfFitDf,
      pureErrorDf,
      reason: pureErrorDf <= 0 ? "no replicated factor coordinates" : lackOfFitDf <= 0 ? "too few unique design points beyond the six fitted coefficients" : "replicate pure-error variance is numerically zero",
    };
  if (lackOfFit.status === "evaluated") lackOfFit.pValue = pFromF(lackOfFit.statistic, lackOfFit.df1, lackOfFit.df2);

  const [, beta1, beta2, beta12, beta11, beta22] = core.beta;
  const hessian = [[2 * beta11, beta12], [beta12, 2 * beta22]];
  const hessianDeterminant = hessian[0][0] * hessian[1][1] - hessian[0][1] * hessian[1][0];
  let stationaryPoint;
  if (Math.abs(hessianDeterminant) <= 1e-10) {
    stationaryPoint = { status: "not_evaluated", reason: "quadratic Hessian is singular or nearly singular", hessianDeterminant };
  } else {
    const codedFactor1 = (-beta1 * hessian[1][1] + beta12 * beta2) / hessianDeterminant;
    const codedFactor2 = (-hessian[0][0] * beta2 + beta12 * beta1) / hessianDeterminant;
    const rawFactor1 = factor1.coding.center + factor1.coding.halfRange * codedFactor1;
    const rawFactor2 = factor2.coding.center + factor2.coding.halfRange * codedFactor2;
    const fittedResponse = core.beta[0] + beta1 * codedFactor1 + beta2 * codedFactor2 + beta12 * codedFactor1 * codedFactor2 + beta11 * codedFactor1 ** 2 + beta22 * codedFactor2 ** 2;
    const trace = hessian[0][0] + hessian[1][1];
    const root = Math.sqrt(Math.max(0, (hessian[0][0] - hessian[1][1]) ** 2 + 4 * beta12 ** 2));
    const eigenvalues = [(trace - root) / 2, (trace + root) / 2];
    const classification = eigenvalues.every((value) => value > 0) ? "minimum" : eigenvalues.every((value) => value < 0) ? "maximum" : "saddle";
    stationaryPoint = {
      status: "evaluated",
      codedFactor1,
      codedFactor2,
      rawFactor1,
      rawFactor2,
      fittedResponse,
      classification,
      hessianEigenvalues: eigenvalues,
      hessianDeterminant,
      domainStatus: Math.abs(codedFactor1) <= 1 && Math.abs(codedFactor2) <= 1 ? "inside_declared_domain" : "outside_declared_domain_no_extrapolation_claim",
    };
  }

  const gridX = inclusiveGrid(factor1.coding.center - factor1.coding.halfRange, factor1.coding.center + factor1.coding.halfRange, options.gridSize);
  const gridY = inclusiveGrid(factor2.coding.center - factor2.coding.halfRange, factor2.coding.center + factor2.coding.halfRange, options.gridSize);
  const gridZ = gridY.map((rawSecond) => gridX.map((rawFirst) => {
    const first = (rawFirst - factor1.coding.center) / factor1.coding.halfRange;
    const second = (rawSecond - factor2.coding.center) / factor2.coding.halfRange;
    const value = core.beta[0] + beta1 * first + beta2 * second + beta12 * first * second + beta11 * first * first + beta22 * second * second;
    if (!Number.isFinite(value) || Math.abs(value) > 1e15) fail("STAT_NUMERIC_OVERFLOW", "response-surface prediction grid exceeds the numeric artifact boundary");
    return Object.is(value, -0) ? 0 : value;
  }));
  const gridValues = gridZ.flat();
  const gridDomain = minMax(gridValues);
  if (gridDomain.min === gridDomain.max) fail("STAT_DEGENERATE", "quadratic response-surface grid is constant over the declared domain");

  const hull = monotoneChainHull(observations.map((row) => ({ x: row.factor1, y: row.factor2 })));
  const supportMask = gridY.map((rawSecond) => gridX.map((rawFirst) => pointInsideOrOnConvexHull({ x: rawFirst, y: rawSecond }, hull)));
  const supportedValueCount = supportMask.flat().filter(Boolean).length;
  if (supportedValueCount === 0 || supportedValueCount === options.gridSize ** 2 && hull.length < 4) {
    fail("STAT_INTERNAL", "response-surface convex-hull mask failed its support-domain invariant");
  }

  const observedPoints = observations.map((row) => ({ row: row.row, x: row.factor1, y: row.factor2, z: row.observed, residual: row.residual, id: row.id }));
  const gridSha256 = rawSha256({ x: gridX, y: gridY, z: gridZ });
  const supportMaskSha256 = rawSha256(supportMask);
  const pointsSha256 = rawSha256(observedPoints);
  const hullSha256 = rawSha256(hull);
  const supportReceiptSha256 = rawSha256({
    algorithm: "monotone-chain-2d/v1",
    hullSha256,
    maskRule: "grid-point-inside-or-boundary/v1",
    supportMaskSha256,
    supportedValueCount,
    pointsSha256,
  });
  const model = "quadratic response surface: y ~ x1 + x2 + x1*x2 + x1^2 + x2^2";
  const inputSha256 = rawSha256({
    method: "response_surface_regression",
    response: data.response,
    factors: data.factors.map((factor) => ({ name: factor.name, unit: factor.unit, values: factor.values, coding: factor.coding })),
    options: { confidenceLevel: options.confidenceLevel, gridSize: options.gridSize },
  });
  const coefficientRowsSha256 = rawSha256(termRows);
  const observationRowsSha256 = rawSha256(observations);
  const publishedCoding = data.factors.map((factor) => ({ factor: factor.name, unit: factor.unit, ...factor.coding }));
  const modelSha256 = rawSha256({ model, coefficients: termRows, coding: publishedCoding });
  const outputSha256 = rawSha256({ modelSha256, coefficientRowsSha256, observationRowsSha256, gridSha256, supportMaskSha256, pointsSha256, hullSha256, supportReceiptSha256 });
  const numericSurfacePayload = {
    schema: NUMERIC_SURFACE_SOURCE_SCHEMA,
    chartFamily: "surface3d",
    title: `Quadratic response surface: ${data.response.name}`,
    grid: {
      x: gridX,
      y: gridY,
      z: gridZ,
      valueCount: options.gridSize ** 2,
      zMin: gridDomain.min,
      zMax: gridDomain.max,
      gridSha256,
      supportMask,
      supportedValueCount,
      supportMaskSha256,
    },
    observations: { points: observedPoints, pointsSha256 },
    support: {
      algorithm: "monotone-chain-2d/v1",
      hull,
      hullSha256,
      maskRule: "grid-point-inside-or-boundary/v1",
      receiptSha256: supportReceiptSha256,
    },
    axes: {
      x: { title: factor1.name, unit: factor1.unit },
      y: { title: factor2.name, unit: factor2.unit },
      z: { title: data.response.name, unit: data.response.unit },
    },
    appearance: { palette: "viridis", wireframe: true, showObservedPoints: true },
    viewState: {
      cameraPosition: [3.2, 2.5, 3.4],
      target: [0, 0, 0],
      up: [0, 1, 0],
    },
    method: "response_surface_regression",
    model,
  };
  const rendererDataContract = {
    schema: "agentlas.science.statistics-numeric-surface-lineage/v1",
    sourceArtifactSchema: NUMERIC_SURFACE_SOURCE_SCHEMA,
    destinationPayloadSchema: "agentlas.science.numeric-surface-artifact/v2",
    destinationRendererId: "agentlas.three-numeric",
    destinationRendererVersion: "1.0.0",
    inputSha256,
    modelSha256,
    outputSha256,
    coefficientRowsSha256,
    observationRowsSha256,
    gridSha256,
    supportMaskSha256,
    pointsSha256,
    hullSha256,
    supportReceiptSha256,
    gridSize: options.gridSize,
    valueCount: options.gridSize ** 2,
    supportedValueCount,
    sampling: "none",
    extrapolation: "masked-outside-observed-convex-hull",
    sourceArtifactRole: "response-surface-grid",
  };

  return {
    sample: { n, factors: 2, coefficients: p, residualDf: dfResidual, uniqueDesignPoints: designGroups.size, replicatedRows: n - designGroups.size },
    estimates: {
      coefficients: termRows,
      rSquared,
      adjustedRSquared,
      residualStandardError: Math.sqrt(mse),
      sse,
      sst,
      mse,
      stationaryPoint,
      coding: publishedCoding,
      rendererDataContract,
    },
    tests: [
      { name: "Overall quadratic response-surface F test", statistic: modelF, distribution: "F", df1: modelDf, df2: dfResidual, pValue: modelPValue },
      ...(lackOfFit.status === "evaluated" ? [{ name: "Response-surface lack-of-fit test", statistic: lackOfFit.statistic, distribution: "F against replicated pure error", df1: lackOfFit.df1, df2: lackOfFit.df2, pValue: lackOfFit.pValue }] : []),
    ],
    confidenceIntervals: termRows.map((row) => ({ parameter: row.term, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: "classical OLS Student t in declared coded coordinates" })),
    effectSizes: [{ name: "R squared", estimate: rSquared }, { name: "adjusted R squared", estimate: adjustedRSquared }],
    assumptions: [
      { name: "exactly two quantitative factors", status: "verified_by_input_contract" },
      { name: "center and half-range scaling to [-1, 1]", status: "verified_by_input_contract" },
      { name: "full-rank quadratic design", status: "verified", rank, requiredRank: p, conditionNumber },
      { name: "quadratic conditional mean inside observed support", status: "requires_scientific_review" },
      { name: "independent errors", status: "requires_design_review" },
      { name: "homoscedastic normal errors for classical inference", status: "diagnostics_attached" },
    ],
    diagnostics: [
      { name: "design rank and conditioning", status: "verified", rank, requiredRank: p, conditionNumber, maximumConditionNumber: 1e10 },
      { name: "factor coding", status: "verified", boundary: "raw factor values outside either declared center ± halfRange domain fail closed", factors: data.factors.map((factor) => ({ name: factor.name, unit: factor.unit, ...factor.coding, codedMin: minMax(factor.codedValues).min, codedMax: minMax(factor.codedValues).max })) },
      lackOfFit,
      stationaryPoint,
      jarqueBera(core.residuals, budget),
      breuschPaganDiagnostic(x, core.residuals, budget),
      { name: "observed-domain support", status: "verified", algorithm: "monotone-chain-2d/v1", maskRule: "grid-point-inside-or-boundary/v1", hullVertices: hull.length, supportedValueCount, totalValueCount: options.gridSize ** 2, cellRule: "a rendered surface cell is supported only when all four grid vertices are true" },
      { name: "renderer exact-data contract", status: "verified", ...rendererDataContract },
      { name: "response-surface interpretation boundary", status: "bounded_quadratic_only", unsupported: ["more than two factors", "automatic model selection", "transformation selection", "robust or clustered covariance", "desirability optimization", "ridge analysis", "uncertainty bands over the surface", "extrapolation outside observed convex-hull support"] },
    ],
    artifacts: [
      tableArtifact("Quadratic response-surface coefficients", "Classical OLS coefficients in explicitly declared center/half-range coded coordinates.", [{ key: "term", label: "Term ID", type: "string" }, { key: "label", label: "Term", type: "string" }, { key: "estimate", label: "Estimate", type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "statistic", label: "t", type: "number" }, { key: "df", label: "df", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "lower", label: "CI lower", type: "number" }, { key: "upper", label: "CI upper", type: "number" }], termRows, [`Model sha256: ${modelSha256}. Coefficients use coded factors, not raw-unit slopes.`], "response-surface-coefficient-table"),
      tableArtifact("Response-surface observations and fitted values", "Every complete input row is retained in source order with raw and coded factors, observed response, fitted response, and residual.", [{ key: "row", label: "Row", type: "number" }, { key: "id", label: "Observation", type: "string" }, { key: "factor1", label: factor1.name, type: "number" }, { key: "factor2", label: factor2.name, type: "number" }, { key: "codedFactor1", label: `${factor1.name} (coded)`, type: "number" }, { key: "codedFactor2", label: `${factor2.name} (coded)`, type: "number" }, { key: "observed", label: data.response.name, type: "number" }, { key: "fitted", label: "Fitted response", type: "number" }, { key: "residual", label: "Residual", type: "number" }], observations, [`Observation rows sha256: ${observationRowsSha256}. No sampling or imputation.`], "response-surface-observation-table"),
      { kind: "numeric-surface", role: "response-surface-grid", schema: NUMERIC_SURFACE_SOURCE_SCHEMA, payload: numericSurfacePayload },
    ],
  };
}

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

function auc(scores, outcomes) {
  const ranked = averageRanks(scores);
  let positiveRankSum = 0;
  let positives = 0;
  outcomes.forEach((outcome, index) => { if (outcome === 1) { positives += 1; positiveRankSum += ranked.ranks[index]; } });
  const negatives = outcomes.length - positives;
  return (positiveRankSum - positives * (positives + 1) / 2) / (positives * negatives);
}

function trapezoidArea(rows, xKey, yKey, budget) {
  let area = 0;
  for (let index = 1; index < rows.length; index += 1) {
    budget.check();
    const width = rows[index][xKey] - rows[index - 1][xKey];
    if (width < 0) fail("STAT_INTERNAL", `${xKey} must be non-decreasing for trapezoid integration`);
    area += width * (rows[index][yKey] + rows[index - 1][yKey]) / 2;
  }
  return Math.max(0, Math.min(1, area));
}

function analyzeRocCurve(data, _options, budget) {
  const observations = data.scores.map((score, index) => ({
    row: index + 1,
    label: data.observationLabels[index],
    outcome: data.outcomes[index],
    score,
  }));
  const ordered = [...observations].sort((left, right) => left.score === right.score ? left.row - right.row : left.score > right.score ? -1 : 1);
  const positives = sum(data.outcomes, budget);
  const negatives = data.outcomes.length - positives;
  let truePositive = 0;
  let falsePositive = 0;
  let index = 0;
  const thresholdRows = [];
  let tiedScoreBlocks = 0;
  while (index < ordered.length) {
    budget.check();
    const threshold = ordered[index].score;
    let next = index;
    let positiveAtThreshold = 0;
    let negativeAtThreshold = 0;
    while (next < ordered.length && ordered[next].score === threshold) {
      if (ordered[next].outcome === 1) positiveAtThreshold += 1;
      else negativeAtThreshold += 1;
      next += 1;
    }
    if (next - index > 1) tiedScoreBlocks += 1;
    truePositive += positiveAtThreshold;
    falsePositive += negativeAtThreshold;
    const trueNegative = negatives - falsePositive;
    const falseNegative = positives - truePositive;
    const sensitivity = truePositive / positives;
    const falsePositiveRate = falsePositive / negatives;
    thresholdRows.push({
      threshold,
      truePositive,
      falsePositive,
      trueNegative,
      falseNegative,
      sensitivity,
      specificity: trueNegative / negatives,
      falsePositiveRate,
      precision: truePositive / (truePositive + falsePositive),
      recall: sensitivity,
    });
    index = next;
  }
  const curveRows = [{ threshold: null, truePositive: 0, falsePositive: 0, trueNegative: negatives, falseNegative: positives, sensitivity: 0, specificity: 1, falsePositiveRate: 0, precision: 1, recall: 0 }, ...thresholdRows];
  const rocAuc = trapezoidArea(curveRows, "falsePositiveRate", "sensitivity", budget);
  const precisionRecallAuc = trapezoidArea(curveRows, "recall", "precision", budget);
  const rankAuc = auc(data.scores, data.outcomes);
  if (Math.abs(rankAuc - rocAuc) > 1e-12) fail("STAT_INTERNAL", "ROC trapezoid AUC disagrees with the tie-aware rank identity");
  const prevalence = positives / data.outcomes.length;
  const thresholdRowsHash = sha256(thresholdRows);
  const observationRowsHash = sha256(observations);
  return {
    sample: { n: data.outcomes.length, positives, negatives, distinctThresholds: thresholdRows.length },
    estimates: {
      rocAuc,
      precisionRecallAuc,
      prevalence,
      thresholdRows,
      rendererDataContract: { inlineRows: "all", sampling: "none", aggregation: "tie-aware score blocks only", thresholdRowCount: thresholdRows.length, thresholdRowsHash, observationRowCount: observations.length, observationRowsHash },
    },
    tests: [],
    confidenceIntervals: [],
    effectSizes: [{ name: "ROC AUC", estimate: rocAuc }, { name: "trapezoidal precision-recall area", estimate: precisionRecallAuc }],
    assumptions: [{ name: "binary outcomes", status: "verified" }, { name: "both outcome classes", status: "verified" }, { name: "higher score indicates the positive class", status: "declared_by_method_contract" }, { name: "independent evaluation observations", status: "requires_design_review" }],
    diagnostics: [{ name: "score ties", status: tiedScoreBlocks ? "present" : "absent", tiedScoreBlocks, distinctThresholds: thresholdRows.length }, { name: "AUC identity", status: "verified", trapezoidAuc: rocAuc, tieAwareRankAuc: rankAuc }, { name: "renderer exact-data contract", status: "verified", sampling: "none", thresholdRows: thresholdRows.length, thresholdRowsHash, observationRows: observations.length, observationRowsHash }, { name: "ROC boundary", status: "descriptive_evaluation_only", unsupported: ["DeLong confidence intervals", "bootstrap confidence intervals", "optimal-threshold selection", "paired-model comparison", "cross-validation"] }],
    artifacts: [
      tableArtifact("ROC threshold operating points", "Every distinct score threshold is retained after stable descending sorting; tied scores enter the confusion matrix together.", [{ key: "threshold", label: data.scoreLabel, type: "number" }, { key: "truePositive", label: "TP", type: "number" }, { key: "falsePositive", label: "FP", type: "number" }, { key: "trueNegative", label: "TN", type: "number" }, { key: "falseNegative", label: "FN", type: "number" }, { key: "sensitivity", label: "Sensitivity", type: "number" }, { key: "specificity", label: "Specificity", type: "number" }, { key: "falsePositiveRate", label: "False-positive rate", type: "number" }, { key: "precision", label: "Precision", type: "number" }, { key: "recall", label: "Recall", type: "number" }], thresholdRows, [`Threshold rows sha256: ${thresholdRowsHash}. No sampling; tied scores are aggregated only at their exact shared threshold.`], "roc-threshold-table"),
      tableArtifact("ROC input observations", "Exact local observations used for the ROC analysis in original input order.", [{ key: "row", label: "Row", type: "number" }, { key: "label", label: "Observation", type: "string" }, { key: "outcome", label: data.outcomeLabel, type: "number" }, { key: "score", label: data.scoreLabel, type: "number" }], observations, [`Observation rows sha256: ${observationRowsHash}. No sampling or aggregation.`], "roc-observation-table"),
      vegaArtifact("roc-curve", `ROC curve · AUC ${rocAuc.toFixed(4)}`, { data: { values: curveRows }, layer: [{ mark: { type: "line", point: true }, encoding: { x: { field: "falsePositiveRate", type: "quantitative", title: "False-positive rate", scale: { domain: [0, 1] } }, y: { field: "sensitivity", type: "quantitative", title: "Sensitivity", scale: { domain: [0, 1] } }, tooltip: [{ field: "threshold", format: ".6g" }, { field: "sensitivity", format: ".6g" }, { field: "specificity", format: ".6g" }, { field: "truePositive" }, { field: "falsePositive" }] } }, { mark: { type: "line", color: "#777", strokeDash: [4, 4] }, data: { values: [{ falsePositiveRate: 0, sensitivity: 0 }, { falsePositiveRate: 1, sensitivity: 1 }] }, encoding: { x: { field: "falsePositiveRate", type: "quantitative" }, y: { field: "sensitivity", type: "quantitative" } } }] }),
      vegaArtifact("precision-recall-curve", `Precision-recall curve · trapezoidal area ${precisionRecallAuc.toFixed(4)}`, { data: { values: thresholdRows }, layer: [{ mark: { type: "line", point: true }, encoding: { x: { field: "recall", type: "quantitative", title: "Recall", scale: { domain: [0, 1] } }, y: { field: "precision", type: "quantitative", title: "Precision", scale: { domain: [0, 1] } }, tooltip: [{ field: "threshold", format: ".6g" }, { field: "recall", format: ".6g" }, { field: "precision", format: ".6g" }, { field: "truePositive" }, { field: "falsePositive" }] } }, { mark: { type: "rule", color: "#777", strokeDash: [4, 4] }, encoding: { y: { datum: prevalence } } }] }),
    ],
  };
}

function analyzeLogisticRegression(data, options, budget) {
  const design = designMatrix(data, options.intercept);
  const x = design.x;
  const n = data.y.length;
  const p = x[0].length;
  if (n <= p + 1) fail("STAT_INVALID_INPUT", "logistic regression requires more rows than fitted coefficients plus one");
  let beta = Array(p).fill(0);
  let converged = false;
  let iterations = 0;
  let informationInverse;
  for (iterations = 1; iterations <= options.maxIterations; iterations += 1) {
    budget.check(2048);
    const probabilities = x.map((row) => sigmoid(row.reduce((acc, value, index) => acc + value * beta[index], 0)));
    const weights = probabilities.map((probability) => Math.max(1e-9, probability * (1 - probability)));
    const z = probabilities.map((probability, index) => x[index].reduce((acc, value, j) => acc + value * beta[j], 0) + (data.y[index] - probability) / weights[index]);
    const xtwx = Array.from({ length: p }, () => Array(p).fill(0));
    const xtwz = Array(p).fill(0);
    for (let row = 0; row < n; row += 1) {
      for (let j = 0; j < p; j += 1) {
        xtwz[j] += x[row][j] * weights[row] * z[row];
        for (let k = 0; k < p; k += 1) xtwx[j][k] += x[row][j] * weights[row] * x[row][k];
      }
    }
    informationInverse = invert(xtwx);
    const next = matMul(informationInverse, xtwz.map((value) => [value]), budget).map((row) => row[0]);
    const delta = Math.max(...next.map((value, index) => Math.abs(value - beta[index])));
    if (next.some((value) => !Number.isFinite(value) || Math.abs(value) > 30)) fail("STAT_NON_CONVERGENCE", "logistic regression shows complete/quasi-complete separation or numeric divergence");
    beta = next;
    if (delta < options.tolerance) { converged = true; break; }
  }
  if (!converged) fail("STAT_NON_CONVERGENCE", `logistic regression did not converge in ${options.maxIterations} iterations`);
  const probabilities = x.map((row) => sigmoid(row.reduce((acc, value, index) => acc + value * beta[index], 0)));
  const finalInformation = Array.from({ length: p }, () => Array(p).fill(0));
  for (let row = 0; row < n; row += 1) {
    const weight = Math.max(1e-9, probabilities[row] * (1 - probabilities[row]));
    for (let j = 0; j < p; j += 1) {
      for (let k = 0; k < p; k += 1) finalInformation[j][k] += x[row][j] * weight * x[row][k];
    }
  }
  informationInverse = invert(finalInformation);
  const finalWeights = probabilities.map((probability) => Math.max(1e-9, probability * (1 - probability)));
  const leverage = leverageValues(x, informationInverse, finalWeights, budget);
  const scoreResiduals = data.y.map((outcome, index) => outcome - probabilities[index]);
  const covarianceMatrix = options.covariance === "classical"
    ? informationInverse
    : sandwichCovariance(x, informationInverse, scoreResiduals, leverage, options.covariance, budget);
  const epsilon = 1e-15;
  const logLikelihood = sum(data.y.map((outcome, index) => outcome * Math.log(Math.max(epsilon, probabilities[index])) + (1 - outcome) * Math.log(Math.max(epsilon, 1 - probabilities[index]))), budget);
  const prevalence = mean(data.y, budget);
  const nullLogLikelihood = sum(data.y.map((outcome) => outcome * Math.log(prevalence) + (1 - outcome) * Math.log(1 - prevalence)), budget);
  const names = design.terms.map((term) => term.name);
  const zCritical = normalInv(1 - (1 - options.confidenceLevel) / 2);
  const coefficients = beta.map((estimate, index) => {
    const standardError = Math.sqrt(Math.max(0, covarianceMatrix[index][index]));
    if (!(standardError > 0)) fail("STAT_DEGENERATE", `logistic coefficient standard error is zero for ${names[index]}`);
    const statistic = estimate / standardError;
    const lower = estimate - zCritical * standardError;
    const upper = estimate + zCritical * standardError;
    return { term: names[index], estimate, standardError, statistic, pValue: pFromNormal(statistic, "two-sided"), lower, upper, oddsRatio: Math.exp(estimate), oddsRatioLower: Math.exp(lower), oddsRatioUpper: Math.exp(upper) };
  });
  const modelAuc = auc(probabilities, data.y);
  const brierScore = mean(probabilities.map((probability, index) => (probability - data.y[index]) ** 2), budget);
  const calibrationRows = [...probabilities.keys()].sort((a, b) => probabilities[a] - probabilities[b] || a - b);
  const groups = Math.min(10, Math.max(2, Math.floor(n / 5)));
  const calibration = Array.from({ length: groups }, (_, groupIndex) => {
    const start = Math.floor(groupIndex * n / groups);
    const end = Math.floor((groupIndex + 1) * n / groups);
    const indices = calibrationRows.slice(start, end);
    return { group: groupIndex + 1, n: indices.length, predicted: mean(indices.map((index) => probabilities[index])), observed: mean(indices.map((index) => data.y[index])) };
  });
  const likelihoodRatio = options.intercept ? Math.max(0, 2 * (logLikelihood - nullLogLikelihood)) : null;
  const modelDf = options.intercept ? p - 1 : null;
  const pearsonChiSquare = sum(data.y.map((outcome, index) => (outcome - probabilities[index]) ** 2 / finalWeights[index]), budget);
  const residualDf = n - p;
  const deviance = -2 * logLikelihood;
  const calibrationStatistic = sum(calibration.map((row) => {
    const expected = row.n * row.predicted;
    const observed = row.n * row.observed;
    return (observed - expected) ** 2 / Math.max(1e-12, row.n * row.predicted * (1 - row.predicted));
  }), budget);
  const calibrationDf = Math.max(1, calibration.length - 2);
  const influence = data.y.map((outcome, index) => {
    const pearsonResidual = (outcome - probabilities[index]) / Math.sqrt(finalWeights[index]);
    return { row: index + 1, probability: probabilities[index], leverage: leverage[index], pearsonResidual, cooksDistance: pearsonResidual ** 2 * leverage[index] / Math.max(1e-12, p * (1 - leverage[index]) ** 2) };
  });
  const influential = [...influence].sort((a, b) => b.cooksDistance - a.cooksDistance || a.row - b.row).slice(0, 10);
  const categoricalCoding = data.predictors.filter((predictor) => predictor.type === "categorical").map((predictor) => ({ predictor: predictor.name, levels: predictor.levels, reference: predictor.reference, coding: "treatment/reference" }));
  return {
    sample: { n, events: sum(data.y), nonEvents: n - sum(data.y), predictors: data.predictors.length, coefficients: p },
    estimates: { coefficients, logLikelihood, nullLogLikelihood, mcfaddenRSquared: 1 - logLikelihood / nullLogLikelihood, auc: modelAuc, brierScore, deviance, pearsonChiSquare, covariance: options.covariance, expandedTerms: names },
    tests: [...(likelihoodRatio === null || modelDf <= 0 ? [] : [{ name: "Logistic likelihood-ratio test", statistic: likelihoodRatio, distribution: "chi-square", df: modelDf, pValue: pFromChiSquare(likelihoodRatio, modelDf) }]), ...coefficients.map((coefficient) => ({ name: `Wald test: ${coefficient.term}`, statistic: coefficient.statistic, distribution: "normal", pValue: coefficient.pValue }))],
    confidenceIntervals: coefficients.map((coefficient) => ({ parameter: `${coefficient.term} log-odds`, level: options.confidenceLevel, lower: coefficient.lower, upper: coefficient.upper, method: options.covariance === "classical" ? "model-information Wald normal" : `${options.covariance.toUpperCase()} sandwich Wald normal` })),
    effectSizes: coefficients.map((coefficient) => ({ name: `${coefficient.term} odds ratio`, estimate: coefficient.oddsRatio, lower: coefficient.oddsRatioLower, upper: coefficient.oddsRatioUpper })),
    assumptions: [{ name: "binary outcome", status: "verified" }, { name: "independent observations", status: "requires_design_review" }, { name: "linearity of continuous predictors in logit", status: "requires_diagnostic_review" }, { name: "absence of complete separation", status: "screened_by_convergence_bounds_not_proven" }, { name: "full-rank treatment coding", status: "verified_by_matrix_inversion" }],
    diagnostics: [{ name: "IRLS convergence", status: "converged", iterations, tolerance: options.tolerance }, { name: "covariance estimator", value: options.covariance, boundary: "HC sandwich covariance is available; clustered covariance and Firth or other penalized separation correction are not implemented" }, { name: "deviance", value: deviance, residualDf }, { name: "Pearson goodness-of-fit", statistic: pearsonChiSquare, df: residualDf, pValue: pFromChiSquare(pearsonChiSquare, residualDf), boundary: "asymptotic diagnostic, not valid as a universal calibration test for sparse or continuous-covariate data" }, { name: "grouped calibration screen", statistic: calibrationStatistic, df: calibrationDf, pValue: pFromChiSquare(calibrationStatistic, calibrationDf), groups: calibration.length, values: calibration, boundary: "deterministic equal-count grouping; not claimed as a definitive Hosmer-Lemeshow implementation under tied predictions" }, { name: "AUC", value: modelAuc }, { name: "Brier score", value: brierScore }, { name: "categorical treatment coding", predictors: categoricalCoding }, { name: "influence screen", thresholdLeverage: 2 * p / n, thresholdCooksDistance: 4 / n, topRows: influential, status: "screen_only" }],
    artifacts: [
      tableArtifact(`Logistic regression: ${data.outcomeLabel}`, "Maximum-likelihood logistic regression coefficient and odds-ratio table.", [{ key: "term", label: "Term", type: "string" }, { key: "estimate", label: "Log-odds", type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "statistic", label: "z", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "lower", label: "Log-odds CI lower", type: "number" }, { key: "upper", label: "Log-odds CI upper", type: "number" }, { key: "oddsRatio", label: "Odds ratio", type: "number" }, { key: "oddsRatioLower", label: "OR CI lower", type: "number" }, { key: "oddsRatioUpper", label: "OR CI upper", type: "number" }], coefficients, [`AUC = ${modelAuc}; Brier score = ${brierScore}; covariance = ${options.covariance}.`, "Categorical terms use deterministic treatment coding; Firth correction is not implemented."]),
      vegaArtifact("odds-ratio-plot", "Odds ratios with confidence intervals", { data: { values: coefficients.filter((row) => row.term !== "Intercept") }, layer: [{ mark: { type: "rule", strokeWidth: 2 }, encoding: { y: { field: "term", type: "nominal", title: null }, x: { field: "oddsRatioLower", type: "quantitative", scale: { type: "log" }, title: "Odds ratio" }, x2: { field: "oddsRatioUpper" } } }, { mark: { type: "point", filled: true, size: 80 }, encoding: { y: { field: "term", type: "nominal" }, x: { field: "oddsRatio", type: "quantitative", scale: { type: "log" } }, tooltip: [{ field: "term" }, { field: "oddsRatio", format: ".4g" }, { field: "pValue", format: ".4g" }] } }, { mark: { type: "rule", strokeDash: [4, 4], color: "#777" }, encoding: { x: { datum: 1, scale: { type: "log" } } } }] }),
      vegaArtifact("calibration", "Calibration by predicted-risk group", { data: { values: calibration }, layer: [{ mark: { type: "line", point: true }, encoding: { x: { field: "predicted", type: "quantitative", title: "Mean predicted probability" }, y: { field: "observed", type: "quantitative", title: "Observed event rate" }, tooltip: [{ field: "group" }, { field: "n" }, { field: "predicted", format: ".3f" }, { field: "observed", format: ".3f" }] } }, { mark: { type: "line", strokeDash: [4, 4], color: "#777" }, data: { values: [{ predicted: 0, observed: 0 }, { predicted: 1, observed: 1 }] }, encoding: { x: { field: "predicted", type: "quantitative" }, y: { field: "observed", type: "quantitative" } } }] }),
    ],
  };
}

function poissonLinearPredictor(x, beta, logOffset, budget) {
  const eta = x.map((row, rowIndex) => {
    budget.check();
    const value = logOffset[rowIndex] + row.reduce((total, cell, columnIndex) => total + cell * beta[columnIndex], 0);
    if (!Number.isFinite(value) || value > 700 || value < -700) {
      fail("STAT_NUMERIC_OVERFLOW", "Poisson log-link linear predictor exceeded the supported [-700, 700] range");
    }
    return value;
  });
  const fittedMeans = eta.map((value) => Math.exp(value));
  if (fittedMeans.some((value) => !Number.isFinite(value) || !(value > 0))) {
    fail("STAT_NUMERIC_OVERFLOW", "Poisson fitted mean overflowed or underflowed");
  }
  return { eta, fittedMeans };
}

function poissonLogLikelihood(y, eta, fittedMeans, budget) {
  return sum(y.map((count, index) => {
    budget.check();
    return count * eta[index] - fittedMeans[index] - logGamma(count + 1);
  }), budget);
}

function poissonInformation(x, fittedMeans, budget) {
  const p = x[0].length;
  const information = Array.from({ length: p }, () => Array(p).fill(0));
  for (let row = 0; row < x.length; row += 1) {
    for (let j = 0; j < p; j += 1) {
      for (let k = 0; k < p; k += 1) {
        budget.check();
        information[j][k] += fittedMeans[row] * x[row][j] * x[row][k];
      }
    }
  }
  return information;
}

function poissonDeviance(y, fittedMeans, budget) {
  return Math.max(0, 2 * sum(y.map((count, index) => {
    budget.check();
    return count === 0 ? fittedMeans[index] : count * Math.log(count / fittedMeans[index]) - (count - fittedMeans[index]);
  }), budget));
}

function finiteExp(value, path) {
  if (!Number.isFinite(value) || value > 700 || value < -700) fail("STAT_NUMERIC_OVERFLOW", `${path} exponent exceeds the supported [-700, 700] range`);
  const result = Math.exp(value);
  if (!Number.isFinite(result) || !(result > 0)) fail("STAT_NUMERIC_OVERFLOW", `${path} is not representable`);
  return result;
}

function analyzePoissonRegression(data, options, budget) {
  const design = designMatrix(data, options.intercept);
  const x = design.x;
  const n = data.y.length;
  const p = x[0].length;
  if (n <= p) fail("STAT_INVALID_INPUT", "Poisson regression requires more rows than fitted coefficients");
  let beta = Array(p).fill(0);
  let nullIntercept = null;
  if (options.intercept) {
    const maxOffset = Math.max(...data.logOffset);
    const scaledExposure = sum(data.logOffset.map((value) => Math.exp(value - maxOffset)), budget);
    nullIntercept = Math.log(sum(data.y, budget)) - (maxOffset + Math.log(scaledExposure));
    beta[0] = nullIntercept;
  }
  let state = poissonLinearPredictor(x, beta, data.logOffset, budget);
  let logLikelihood = poissonLogLikelihood(data.y, state.eta, state.fittedMeans, budget);
  let converged = false;
  let iterations = 0;
  let finalStep = null;
  for (iterations = 1; iterations <= options.maxIterations; iterations += 1) {
    budget.check(2048);
    const informationInverse = invert(poissonInformation(x, state.fittedMeans, budget));
    const score = Array(p).fill(0);
    for (let row = 0; row < n; row += 1) {
      const residual = data.y[row] - state.fittedMeans[row];
      for (let column = 0; column < p; column += 1) {
        budget.check();
        score[column] += x[row][column] * residual;
      }
    }
    const direction = matMul(informationInverse, score.map((value) => [value]), budget).map((row) => row[0]);
    if (direction.some((value) => !Number.isFinite(value))) fail("STAT_NON_CONVERGENCE", "Poisson Fisher scoring produced a non-finite update");
    let stepScale = 1;
    let accepted = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      budget.check();
      const candidateBeta = beta.map((value, index) => value + stepScale * direction[index]);
      try {
        const candidateState = poissonLinearPredictor(x, candidateBeta, data.logOffset, budget);
        const candidateLogLikelihood = poissonLogLikelihood(data.y, candidateState.eta, candidateState.fittedMeans, budget);
        if (candidateLogLikelihood >= logLikelihood - 1e-12) {
          accepted = { beta: candidateBeta, state: candidateState, logLikelihood: candidateLogLikelihood };
          break;
        }
      } catch (error) {
        if (!(error instanceof StatisticsError) || error.code !== "STAT_NUMERIC_OVERFLOW") throw error;
      }
      stepScale /= 2;
    }
    if (!accepted) fail("STAT_NON_CONVERGENCE", "Poisson Fisher scoring could not find a finite likelihood-improving step");
    finalStep = Math.max(...direction.map((value) => Math.abs(stepScale * value)));
    beta = accepted.beta;
    state = accepted.state;
    logLikelihood = accepted.logLikelihood;
    if (finalStep <= options.tolerance * (1 + Math.max(...beta.map(Math.abs)))) {
      converged = true;
      break;
    }
  }
  if (!converged) fail("STAT_NON_CONVERGENCE", `Poisson regression did not converge in ${options.maxIterations} iterations`);

  const informationInverse = invert(poissonInformation(x, state.fittedMeans, budget));
  const scoreResiduals = data.y.map((count, index) => count - state.fittedMeans[index]);
  const leverage = leverageValues(x, informationInverse, state.fittedMeans, budget);
  const covarianceMatrix = options.covariance === "classical"
    ? informationInverse
    : sandwichCovariance(x, informationInverse, scoreResiduals, leverage, options.covariance, budget);
  const names = design.terms.map((term) => term.name);
  const zCritical = normalInv(1 - (1 - options.confidenceLevel) / 2);
  const coefficients = beta.map((estimate, index) => {
    const standardError = Math.sqrt(Math.max(0, covarianceMatrix[index][index]));
    if (!(standardError > 0)) fail("STAT_DEGENERATE", `Poisson coefficient standard error is zero for ${names[index]}`);
    const statistic = estimate / standardError;
    const lower = estimate - zCritical * standardError;
    const upper = estimate + zCritical * standardError;
    return {
      term: names[index], estimate, standardError, statistic,
      pValue: pFromNormal(statistic, "two-sided"), lower, upper,
      incidenceRateRatio: finiteExp(estimate, `${names[index]} incidence-rate ratio`),
      incidenceRateRatioLower: finiteExp(lower, `${names[index]} incidence-rate ratio lower bound`),
      incidenceRateRatioUpper: finiteExp(upper, `${names[index]} incidence-rate ratio upper bound`),
    };
  });
  const residualDf = n - p;
  const pearsonChiSquare = sum(scoreResiduals.map((value, index) => value ** 2 / state.fittedMeans[index]), budget);
  const dispersion = pearsonChiSquare / residualDf;
  const deviance = poissonDeviance(data.y, state.fittedMeans, budget);
  const aic = 2 * p - 2 * logLikelihood;
  let nullLogLikelihood = null;
  let likelihoodRatio = null;
  let modelDf = null;
  if (options.intercept) {
    const nullBeta = [nullIntercept, ...Array(p - 1).fill(0)];
    const nullState = poissonLinearPredictor(x, nullBeta, data.logOffset, budget);
    nullLogLikelihood = poissonLogLikelihood(data.y, nullState.eta, nullState.fittedMeans, budget);
    modelDf = p - 1;
    if (modelDf > 0) likelihoodRatio = Math.max(0, 2 * (logLikelihood - nullLogLikelihood));
  }
  const fittedRows = data.y.map((observedCount, index) => ({
    row: index + 1,
    observedCount,
    fittedMean: state.fittedMeans[index],
    logOffset: data.logOffset[index],
    exposure: data.exposure === null ? null : data.exposure[index],
    pearsonResidual: scoreResiduals[index] / Math.sqrt(state.fittedMeans[index]),
  }));
  const influence = fittedRows.map((row, index) => ({
    row: row.row,
    fittedMean: row.fittedMean,
    leverage: leverage[index],
    pearsonResidual: row.pearsonResidual,
    cooksDistance: row.pearsonResidual ** 2 * leverage[index] / Math.max(1e-12, p * (1 - leverage[index]) ** 2),
  }));
  const influential = [...influence].sort((a, b) => b.cooksDistance - a.cooksDistance || a.row - b.row).slice(0, 10);
  const categoricalCoding = data.predictors.filter((predictor) => predictor.type === "categorical").map((predictor) => ({ predictor: predictor.name, levels: predictor.levels, reference: predictor.reference, coding: "treatment/reference" }));
  const fittedRowsHash = sha256(fittedRows);
  const overdispersionLimit = 1.5;
  return {
    sample: { n, totalCount: sum(data.y, budget), zeroCounts: data.y.filter((value) => value === 0).length, predictors: data.predictors.length, coefficients: p },
    estimates: {
      coefficients,
      fittedMeans: state.fittedMeans,
      logLikelihood,
      nullLogLikelihood,
      deviance,
      aic,
      pearsonChiSquare,
      residualDf,
      dispersion,
      covariance: options.covariance,
      expandedTerms: names,
      offsetMode: data.offsetMode,
      rendererDataContract: { rowCount: fittedRows.length, fittedRowsHash, inlineRows: "all", tableRole: "fitted-mean-table", vegaRole: "observed-fitted-plot" },
    },
    tests: [
      ...(likelihoodRatio === null ? [] : [{ name: "Poisson likelihood-ratio test", statistic: likelihoodRatio, distribution: "chi-square", df: modelDf, pValue: pFromChiSquare(likelihoodRatio, modelDf) }]),
      ...coefficients.map((coefficient) => ({ name: `Wald test: ${coefficient.term}`, statistic: coefficient.statistic, distribution: "normal", pValue: coefficient.pValue })),
    ],
    confidenceIntervals: coefficients.map((coefficient) => ({ parameter: `${coefficient.term} log rate`, level: options.confidenceLevel, lower: coefficient.lower, upper: coefficient.upper, method: options.covariance === "classical" ? "model-information Wald normal" : `${options.covariance.toUpperCase()} sandwich Wald normal` })),
    effectSizes: coefficients.map((coefficient) => ({ name: `${coefficient.term} incidence-rate ratio`, estimate: coefficient.incidenceRateRatio, lower: coefficient.incidenceRateRatioLower, upper: coefficient.incidenceRateRatioUpper })),
    assumptions: [
      { name: "non-negative integer count outcome", status: "verified" },
      { name: "positive exposure when supplied", status: data.offsetMode === "exposure" ? "verified" : "not_applicable" },
      { name: "log link and additive log offset", status: "verified_by_model_contract" },
      { name: "independent observations", status: "requires_design_review" },
      { name: "Poisson conditional variance equals conditional mean", status: "diagnostic_screen_only" },
      { name: "full-rank treatment coding", status: "verified_by_matrix_inversion" },
    ],
    diagnostics: [
      { name: "Fisher scoring convergence", status: "converged", iterations, tolerance: options.tolerance, finalMaximumCoefficientStep: finalStep },
      { name: "covariance estimator", value: options.covariance, boundary: "HC0-HC3 sandwich covariance changes coefficient inference only; it does not repair dependence, clustering, zero inflation, or conditional-mean misspecification" },
      { name: "Poisson deviance", value: deviance, residualDf },
      { name: "Pearson dispersion", statistic: pearsonChiSquare, residualDf, estimate: dispersion },
      { name: "overdispersion screen", status: dispersion > overdispersionLimit ? "flagged" : "not_flagged", estimate: dispersion, decisionLimit: overdispersionLimit, boundary: "screen only; quasi-Poisson, negative-binomial, zero-inflated, clustered, and random-effects count models are not implemented" },
      { name: "offset", mode: data.offsetMode, boundary: "exposure is converted exactly to its natural logarithm; a supplied logOffset is used as-is and its coefficient is fixed at one" },
      { name: "categorical treatment coding", predictors: categoricalCoding },
      { name: "influence screen", thresholdLeverage: 2 * p / n, thresholdCooksDistance: 4 / n, topRows: influential, status: "screen_only" },
      { name: "renderer exact-data contract", fittedRowsHash, rowCount: fittedRows.length, tableRows: fittedRows.length, vegaRows: fittedRows.length, sampling: "none", aggregation: "none", remoteData: false },
    ],
    artifacts: [
      tableArtifact(`Poisson regression: ${data.outcomeLabel}`, "Log-link Poisson maximum-likelihood coefficient and incidence-rate-ratio table.", [{ key: "term", label: "Term", type: "string" }, { key: "estimate", label: "Log rate", type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "statistic", label: "z", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "lower", label: "Log-rate CI lower", type: "number" }, { key: "upper", label: "Log-rate CI upper", type: "number" }, { key: "incidenceRateRatio", label: "IRR", type: "number" }, { key: "incidenceRateRatioLower", label: "IRR CI lower", type: "number" }, { key: "incidenceRateRatioUpper", label: "IRR CI upper", type: "number" }], coefficients, [`Log likelihood = ${logLikelihood}; deviance = ${deviance}; AIC = ${aic}; covariance = ${options.covariance}.`, "Categorical terms use deterministic treatment coding. Exposure/log-offset has fixed coefficient one."]),
      tableArtifact(`Poisson fitted means: ${data.outcomeLabel}`, "All observed counts, fitted means, offsets, exposures, and Pearson residuals; rows are neither sampled nor aggregated.", [{ key: "row", label: "Row", type: "number" }, { key: "observedCount", label: "Observed count", type: "number" }, { key: "fittedMean", label: "Fitted mean", type: "number" }, { key: "logOffset", label: "Log offset", type: "number" }, { key: "exposure", label: "Exposure", type: "number" }, { key: "pearsonResidual", label: "Pearson residual", type: "number" }], fittedRows, [`Exact row hash: ${fittedRowsHash}.`, "Null exposure cells mean that no exposure vector was supplied; logOffset remains explicit."], "fitted-mean-table"),
      vegaArtifact("incidence-rate-ratio-plot", "Poisson incidence-rate ratios with confidence intervals", { data: { values: coefficients }, layer: [{ mark: { type: "rule", strokeWidth: 2 }, encoding: { y: { field: "term", type: "nominal", title: null }, x: { field: "incidenceRateRatioLower", type: "quantitative", scale: { type: "log" }, title: "Incidence-rate ratio" }, x2: { field: "incidenceRateRatioUpper" } } }, { mark: { type: "point", filled: true, size: 90 }, encoding: { y: { field: "term", type: "nominal" }, x: { field: "incidenceRateRatio", type: "quantitative", scale: { type: "log" } }, tooltip: [{ field: "term" }, { field: "incidenceRateRatio", format: ".5g" }, { field: "pValue", format: ".5g" }] } }, { mark: { type: "rule", strokeDash: [4, 4], color: "#777" }, encoding: { x: { datum: 1, scale: { type: "log" } } } }] }),
      vegaArtifact("observed-fitted-plot", "Observed counts versus Poisson fitted means", { data: { values: fittedRows }, mark: { type: "point", filled: true, opacity: 0.75 }, encoding: { x: { field: "fittedMean", type: "quantitative", title: "Fitted mean" }, y: { field: "observedCount", type: "quantitative", title: "Observed count" }, tooltip: [{ field: "row" }, { field: "observedCount" }, { field: "fittedMean", format: ".8g" }, { field: "logOffset", format: ".8g" }, { field: "exposure", format: ".8g" }, { field: "pearsonResidual", format: ".8g" }] } }),
    ],
  };
}

function analyzeChiSquare(data, budget) {
  const rows = data.table.length;
  const columns = data.table[0].length;
  const rowTotals = data.table.map((row) => sum(row));
  const columnTotals = Array.from({ length: columns }, (_, column) => sum(data.table.map((row) => row[column])));
  const total = sum(rowTotals);
  let statistic = 0;
  let lowExpected = 0;
  let zeroExpected = 0;
  const cells = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      budget.check();
      const expected = rowTotals[row] * columnTotals[column] / total;
      if (expected === 0) zeroExpected += 1;
      else statistic += (data.table[row][column] - expected) ** 2 / expected;
      if (expected < 5) lowExpected += 1;
      cells.push({ row: data.rowLabels[row], column: data.columnLabels[column], observed: data.table[row][column], expected, standardizedResidual: expected > 0 ? (data.table[row][column] - expected) / Math.sqrt(expected) : 0 });
    }
  }
  if (zeroExpected) fail("STAT_DEGENERATE", "chi-square expected counts contain structural zero(s)");
  const df = (rows - 1) * (columns - 1);
  const pValue = pFromChiSquare(statistic, df);
  const cramerV = Math.sqrt(statistic / (total * Math.min(rows - 1, columns - 1)));
  return {
    sample: { n: total, rows, columns },
    estimates: { cells },
    tests: [{ name: "Pearson chi-square", statistic, distribution: "chi-square", df, pValue }],
    confidenceIntervals: [],
    effectSizes: [{ name: "Cramer's V", estimate: cramerV }],
    assumptions: [{ name: "independent counts", status: "requires_design_review" }, { name: "expected cell counts", status: lowExpected / (rows * columns) > 0.2 ? "warning" : "acceptable", cellsBelowFive: lowExpected, fractionBelowFive: lowExpected / (rows * columns) }],
    diagnostics: [{ name: "expected counts", minimum: Math.min(...cells.map((cell) => cell.expected)), cellsBelowFive: lowExpected }],
    artifacts: [
      tableArtifact("Pearson chi-square test", "Observed and expected cell counts with standardized residuals.", [{ key: "row", label: "Row", type: "string" }, { key: "column", label: "Column", type: "string" }, { key: "observed", label: "Observed", type: "number" }, { key: "expected", label: "Expected", type: "number" }, { key: "standardizedResidual", label: "Standardized residual", type: "number" }], cells, [`χ²(${df}) = ${statistic}, p = ${pValue}; Cramer's V = ${cramerV}.`]),
      vegaArtifact("contingency-heatmap", "Contingency counts", { data: { values: cells }, mark: "rect", encoding: { x: { field: "column", type: "nominal", title: null }, y: { field: "row", type: "nominal", title: null }, color: { field: "observed", type: "quantitative", title: "Observed" }, tooltip: [{ field: "row" }, { field: "column" }, { field: "observed" }, { field: "expected", format: ".3f" }, { field: "standardizedResidual", format: ".3f" }] } }),
    ],
  };
}

function logChoose(n, k) {
  if (k < 0 || k > n) return -Infinity;
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

function analyzeFisher(data, options, budget) {
  const [[a, b], [c, d]] = data.table;
  const row1 = a + b;
  const row2 = c + d;
  const col1 = a + c;
  const total = row1 + row2;
  const minA = Math.max(0, col1 - row2);
  const maxA = Math.min(row1, col1);
  const probability = (x) => Math.exp(logChoose(col1, x) + logChoose(total - col1, row1 - x) - logChoose(total, row1));
  const observedProbability = probability(a);
  let pTwoSided = 0;
  let pLess = 0;
  let pGreater = 0;
  for (let x = minA; x <= maxA; x += 1) {
    budget.check();
    const p = probability(x);
    if (p <= observedProbability * (1 + 1e-12)) pTwoSided += p;
    if (x <= a) pLess += p;
    if (x >= a) pGreater += p;
  }
  const pValue = options.alternative === "less" ? pLess : options.alternative === "greater" ? pGreater : pTwoSided;
  const oddsRatio = b * c === 0 ? null : a * d / (b * c);
  const oddsRatioBoundary = b * c === 0 ? (a * d === 0 ? "undefined" : "positive_infinity") : null;
  let lower = null;
  let upper = null;
  if (a > 0 && b > 0 && c > 0 && d > 0) {
    const logOr = Math.log(oddsRatio);
    const se = Math.sqrt(1 / a + 1 / b + 1 / c + 1 / d);
    const critical = normalInv(1 - (1 - options.confidenceLevel) / 2);
    lower = Math.exp(logOr - critical * se);
    upper = Math.exp(logOr + critical * se);
  }
  const cells = [
    { row: data.rowLabels[0], column: data.columnLabels[0], count: a }, { row: data.rowLabels[0], column: data.columnLabels[1], count: b },
    { row: data.rowLabels[1], column: data.columnLabels[0], count: c }, { row: data.rowLabels[1], column: data.columnLabels[1], count: d },
  ];
  return {
    sample: { n: total, rows: 2, columns: 2 },
    estimates: { oddsRatio },
    tests: [{ name: "Fisher exact test", statistic: observedProbability, distribution: "conditional hypergeometric", pValue: Math.min(1, pValue), alternative: options.alternative }],
    confidenceIntervals: [{ parameter: "odds ratio", level: options.confidenceLevel, lower, upper, method: lower === null ? "not estimated because at least one cell is zero" : "Wald log-odds approximation" }],
    effectSizes: [{ name: "odds ratio", estimate: oddsRatio, ...(oddsRatioBoundary ? { boundary: oddsRatioBoundary } : {}) }],
    assumptions: [{ name: "fixed margins / conditional test", status: "method_definition" }, { name: "independent counts", status: "requires_design_review" }],
    diagnostics: [{ name: "support", minimumA: minA, maximumA: maxA, observedProbability }, ...(oddsRatioBoundary ? [{ name: "odds-ratio boundary", status: oddsRatioBoundary }] : [])],
    artifacts: [tableArtifact("Fisher exact test", "Exact conditional 2×2 test and odds ratio.", [{ key: "oddsRatio", label: "Odds ratio", type: "number" }, { key: "lower", label: "CI lower", type: "number" }, { key: "upper", label: "CI upper", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "alternative", label: "Alternative", type: "string" }], [{ oddsRatio, lower, upper, pValue: Math.min(1, pValue), alternative: options.alternative }]), vegaArtifact("contingency-heatmap", "2×2 contingency counts", { data: { values: cells }, mark: "rect", encoding: { x: { field: "column", type: "nominal" }, y: { field: "row", type: "nominal" }, color: { field: "count", type: "quantitative" }, tooltip: [{ field: "row" }, { field: "column" }, { field: "count" }] } })],
  };
}

function adjustedPValues(values, method) {
  const n = values.length;
  if (method === "bonferroni") return values.map((value) => Math.min(1, value * n));
  const indexed = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value || a.index - b.index);
  const adjusted = Array(n);
  if (method === "holm") {
    let running = 0;
    indexed.forEach((item, rank) => {
      running = Math.max(running, (n - rank) * item.value);
      adjusted[item.index] = Math.min(1, running);
    });
    return adjusted;
  }
  const harmonic = method === "benjamini-yekutieli" ? Array.from({ length: n }, (_, i) => 1 / (i + 1)).reduce((a, b) => a + b, 0) : 1;
  let running = 1;
  for (let rank = n - 1; rank >= 0; rank -= 1) {
    const item = indexed[rank];
    running = Math.min(running, item.value * n * harmonic / (rank + 1));
    adjusted[item.index] = Math.min(1, running);
  }
  return adjusted;
}

function analyzeMultipleTesting(data, options) {
  const methods = options.correction === "all" ? ["bonferroni", "holm", "benjamini-hochberg", "benjamini-yekutieli"] : [options.correction];
  const adjusted = Object.fromEntries(methods.map((method) => [method, adjustedPValues(data.pValues, method)]));
  const rows = data.pValues.map((pValue, index) => ({ label: data.labels[index], pValue, ...Object.fromEntries(methods.map((method) => [method, adjusted[method][index]])) }));
  const columns = [{ key: "label", label: "Hypothesis", type: "string" }, { key: "pValue", label: "Raw p", type: "number" }, ...methods.map((method) => ({ key: method, label: method, type: "number" }))];
  const chartRows = rows.flatMap((row) => methods.map((method) => ({ label: row.label, method, raw: row.pValue, adjusted: row[method] })));
  return {
    sample: { hypotheses: data.pValues.length },
    estimates: { adjusted },
    tests: [],
    confidenceIntervals: [],
    effectSizes: [],
    assumptions: [{ name: "family definition", status: "requires_researcher_review" }, { name: "Benjamini-Hochberg dependence", status: methods.includes("benjamini-hochberg") ? "positive-dependence_or_independence_assumed" : "not_applicable" }],
    diagnostics: [{ name: "methods", values: methods }],
    artifacts: [tableArtifact("Multiple-testing corrections", "Raw and adjusted p values in original hypothesis order.", columns, rows), vegaArtifact("adjustment-plot", "Raw versus adjusted p values", { data: { values: chartRows }, mark: { type: "point", filled: true }, encoding: { x: { field: "raw", type: "quantitative", title: "Raw p" }, y: { field: "adjusted", type: "quantitative", title: "Adjusted p" }, color: { field: "method", type: "nominal" }, tooltip: [{ field: "label" }, { field: "method" }, { field: "raw", format: ".4g" }, { field: "adjusted", format: ".4g" }] } })],
  };
}

function analyzeConfidenceInterval(data, options, budget) {
  let estimate;
  let lower;
  let upper;
  let method;
  let n;
  if (options.estimator === "mean") {
    n = data.values.length;
    estimate = mean(data.values, budget);
    const sd = Math.sqrt(variance(data.values, true, budget));
    const half = tCritical(options.confidenceLevel, n - 1) * sd / Math.sqrt(n);
    lower = estimate - half;
    upper = estimate + half;
    method = "Student t mean interval";
  } else {
    n = data.trials;
    estimate = data.successes / n;
    const z = normalInv(1 - (1 - options.confidenceLevel) / 2);
    const denominator = 1 + z * z / n;
    const center = (estimate + z * z / (2 * n)) / denominator;
    const half = z / denominator * Math.sqrt(estimate * (1 - estimate) / n + z * z / (4 * n * n));
    lower = Math.max(0, center - half);
    upper = Math.min(1, center + half);
    method = "Wilson score proportion interval";
  }
  const row = { parameter: data.label, estimate, lower, upper, confidenceLevel: options.confidenceLevel, method };
  return {
    sample: { n },
    estimates: { estimate },
    tests: [],
    confidenceIntervals: [{ parameter: data.label, level: options.confidenceLevel, lower, upper, method }],
    effectSizes: [],
    assumptions: options.estimator === "mean" ? [{ name: "independent observations", status: "requires_design_review" }, { name: "approximately normal sampling distribution", status: n >= 30 ? "supported_by_sample_size" : "requires_distribution_review" }] : [{ name: "binomial trials", status: "requires_design_review" }],
    diagnostics: options.estimator === "mean" ? [jarqueBera(data.values, budget)] : [{ name: "event counts", successes: data.successes, failures: data.trials - data.successes }],
    artifacts: [tableArtifact(`Confidence interval: ${data.label}`, `${Math.round(options.confidenceLevel * 100)}% ${method}.`, [{ key: "parameter", label: "Parameter", type: "string" }, { key: "estimate", label: "Estimate", type: "number" }, { key: "lower", label: "CI lower", type: "number" }, { key: "upper", label: "CI upper", type: "number" }, { key: "confidenceLevel", label: "Confidence level", type: "number" }, { key: "method", label: "Method", type: "string" }], [row]), vegaArtifact("interval-plot", `${Math.round(options.confidenceLevel * 100)}% confidence interval`, { data: { values: [row] }, layer: [{ mark: { type: "rule", strokeWidth: 3 }, encoding: { y: { field: "parameter", type: "nominal", title: null }, x: { field: "lower", type: "quantitative", title: "Estimate" }, x2: { field: "upper" } } }, { mark: { type: "point", filled: true, size: 100 }, encoding: { y: { field: "parameter", type: "nominal" }, x: { field: "estimate", type: "quantitative" } } }] })],
  };
}

function survivalRows(time, event, name) {
  return time.map((duration, index) => ({ time: duration, event: event[index], group: name, index }))
    .sort((left, right) => left.time - right.time || right.event - left.event || left.index - right.index);
}

function kaplanMeierCore(time, event, name, confidenceLevel, budget) {
  const rows = survivalRows(time, event, name);
  const z = normalInv(1 - (1 - confidenceLevel) / 2);
  let atRisk = rows.length;
  let survival = 1;
  let greenwoodSum = 0;
  let tiedTimes = 0;
  let sharedEventCensorTimes = 0;
  const curve = [{ group: name, time: 0, nAtRisk: atRisk, events: 0, censored: 0, survival: 1, greenwoodVariance: 0, standardError: 0, lower: 1, upper: 1 }];
  for (let start = 0; start < rows.length;) {
    budget.check();
    let end = start + 1;
    while (end < rows.length && rows[end].time === rows[start].time) end += 1;
    const block = rows.slice(start, end);
    const events = block.reduce((total, row) => total + row.event, 0);
    const censored = block.length - events;
    if (block.length > 1) tiedTimes += 1;
    if (events > 0 && censored > 0) sharedEventCensorTimes += 1;
    if (events > atRisk) fail("STAT_INTERNAL", "survival risk set underflow");
    if (events > 0) {
      survival *= 1 - events / atRisk;
      if (atRisk > events) greenwoodSum += events / (atRisk * (atRisk - events));
    }
    let varianceValue = survival > 0 ? survival * survival * greenwoodSum : 0;
    if (!Number.isFinite(varianceValue)) varianceValue = 0;
    const standardError = Math.sqrt(Math.max(0, varianceValue));
    let lower = survival;
    let upper = survival;
    if (survival > 0 && survival < 1 && greenwoodSum > 0) {
      const logSurvival = Math.log(survival);
      const seLogLog = Math.sqrt(greenwoodSum) / Math.abs(logSurvival);
      const center = Math.log(-logSurvival);
      lower = Math.exp(-Math.exp(center + z * seLogLog));
      upper = Math.exp(-Math.exp(center - z * seLogLog));
    } else if (survival === 0) {
      lower = 0;
      upper = 0;
    }
    curve.push({ group: name, time: rows[start].time, nAtRisk: atRisk, events, censored, survival, greenwoodVariance: varianceValue, standardError, lower, upper });
    atRisk -= block.length;
    start = end;
  }
  const medianRow = curve.find((row) => row.survival <= 0.5);
  return {
    curve,
    medianSurvival: medianRow ? medianRow.time : null,
    events: sum(event),
    censored: event.length - sum(event),
    tiedTimes,
    sharedEventCensorTimes,
  };
}

function kmTableColumns(includeGroup = false) {
  return [
    ...(includeGroup ? [{ key: "group", label: "Group", type: "string" }] : []),
    { key: "time", label: "Time", type: "number" },
    { key: "nAtRisk", label: "At risk", type: "number" },
    { key: "events", label: "Events", type: "number" },
    { key: "censored", label: "Censored", type: "number" },
    { key: "survival", label: "Survival", type: "number" },
    { key: "standardError", label: "SE", type: "number" },
    { key: "lower", label: "CI lower", type: "number" },
    { key: "upper", label: "CI upper", type: "number" },
  ];
}

function kmVega(curves, confidenceLevel, title, colored) {
  const values = curves.flatMap((curve) => curve.curve);
  const color = colored ? { field: "group", type: "nominal", title: "Group" } : { value: "#285f8f" };
  return vegaArtifact("survival-curve", title, {
    data: { values },
    layer: [
      { mark: { type: "area", opacity: 0.16, interpolate: "step-after" }, encoding: { x: { field: "time", type: "quantitative", title: "Time" }, y: { field: "lower", type: "quantitative", scale: { domain: [0, 1] }, title: "Survival probability" }, y2: { field: "upper" }, color } },
      { mark: { type: "line", interpolate: "step-after", strokeWidth: 2.5 }, encoding: { x: { field: "time", type: "quantitative" }, y: { field: "survival", type: "quantitative" }, color, tooltip: [{ field: "group" }, { field: "time", format: ".4g" }, { field: "nAtRisk" }, { field: "survival", format: ".4f" }, { field: "lower", format: ".4f" }, { field: "upper", format: ".4f" }] } },
      { transform: [{ filter: "datum.censored > 0" }], mark: { type: "point", shape: "cross", size: 55 }, encoding: { x: { field: "time", type: "quantitative" }, y: { field: "survival", type: "quantitative" }, color, tooltip: [{ field: "group" }, { field: "time" }, { field: "censored" }] } },
    ],
    config: { axis: { grid: true } },
    description: `Kaplan-Meier estimate with ${Math.round(confidenceLevel * 100)}% log-log Greenwood confidence intervals.`,
  });
}

function analyzeKaplanMeier(data, options, budget) {
  const km = kaplanMeierCore(data.time, data.event, data.label, options.confidenceLevel, budget);
  const rows = km.curve.slice(1).map(({ greenwoodVariance, group, ...row }) => row);
  return {
    sample: { n: data.time.length, events: km.events, censored: km.censored },
    estimates: { medianSurvival: km.medianSurvival, finalSurvival: km.curve[km.curve.length - 1].survival, curve: km.curve },
    tests: [],
    confidenceIntervals: km.curve.slice(1).map((row) => ({ parameter: `S(${row.time})`, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: "Greenwood log-log" })),
    effectSizes: [{ name: "median survival", estimate: km.medianSurvival, estimable: km.medianSurvival !== null }],
    assumptions: [{ name: "right censoring", status: "verified_by_input_contract" }, { name: "non-informative censoring", status: "requires_design_review" }, { name: "independent observations", status: "requires_design_review" }],
    diagnostics: [{ name: "censoring summary", events: km.events, censored: km.censored, censoringFraction: km.censored / data.time.length }, { name: "ties", tiedTimes: km.tiedTimes, eventAndCensorSameTime: km.sharedEventCensorTimes, policy: "events are evaluated before censor removals at a shared time" }, { name: "confidence interval", method: "Greenwood variance with complementary-log-log transform", boundary: "pointwise intervals only" }],
    artifacts: [
      tableArtifact(`Kaplan-Meier estimate: ${data.label}`, `${Math.round(options.confidenceLevel * 100)}% pointwise Greenwood log-log confidence intervals.`, kmTableColumns(false), rows, ["Right-censored observations only; events precede censor removals when times are equal."]),
      kmVega([km], options.confidenceLevel, `Kaplan-Meier survival: ${data.label}`, false),
    ],
  };
}

function analyzeLogRank(data, options, budget) {
  const [first, second] = data.groups;
  const summarizeTimes = (group) => {
    const blocks = new Map();
    group.time.forEach((time, index) => {
      const block = blocks.get(time) || { events: 0, censored: 0 };
      if (group.event[index] === 1) block.events += 1;
      else block.censored += 1;
      blocks.set(time, block);
    });
    return blocks;
  };
  const blocks1 = summarizeTimes(first);
  const blocks2 = summarizeTimes(second);
  const allTimes = [...new Set([...blocks1.keys(), ...blocks2.keys()])].sort((a, b) => a - b);
  let observedMinusExpected = 0;
  let varianceValue = 0;
  let informativeTimes = 0;
  let tiedEventTimes = 0;
  const riskRows = [];
  let atRisk1 = first.time.length;
  let atRisk2 = second.time.length;
  for (const time of allTimes) {
    budget.check();
    const block1 = blocks1.get(time) || { events: 0, censored: 0 };
    const block2 = blocks2.get(time) || { events: 0, censored: 0 };
    const events1 = block1.events;
    const events2 = block2.events;
    const events = events1 + events2;
    const atRisk = atRisk1 + atRisk2;
    if (events > 0 && atRisk > 1) {
      informativeTimes += 1;
      if (events > 1) tiedEventTimes += 1;
      const expected1 = events * atRisk1 / atRisk;
      const contribution = atRisk1 * atRisk2 * events * (atRisk - events) / (atRisk * atRisk * (atRisk - 1));
      observedMinusExpected += events1 - expected1;
      varianceValue += contribution;
      riskRows.push({ time, firstAtRisk: atRisk1, secondAtRisk: atRisk2, firstEvents: events1, secondEvents: events2, firstExpected: expected1, variance: contribution });
    }
    atRisk1 -= block1.events + block1.censored;
    atRisk2 -= block2.events + block2.censored;
  }
  if (!(varianceValue > 0)) fail("STAT_DEGENERATE", "log-rank variance is zero; groups cannot be compared");
  const z = observedMinusExpected / Math.sqrt(varianceValue);
  const chiSquare = z * z;
  const pValue = pFromChiSquare(chiSquare, 1);
  const curves = data.groups.map((group) => kaplanMeierCore(group.time, group.event, group.name, options.confidenceLevel, budget));
  const curveRows = curves.flatMap((curve) => curve.curve.slice(1));
  return {
    sample: { groups: data.groups.map((group) => ({ name: group.name, n: group.time.length, events: sum(group.event), censored: group.time.length - sum(group.event) })), totalN: data.groups.reduce((total, group) => total + group.time.length, 0) },
    estimates: { observedMinusExpected, variance: varianceValue, riskTable: riskRows },
    tests: [{ name: "Two-group log-rank test", statistic: chiSquare, distribution: "chi-square", df: 1, pValue }],
    confidenceIntervals: [],
    effectSizes: [{ name: `${first.name} standardized observed-minus-expected`, estimate: z, interpretation: "signed standardized log-rank contrast; not a hazard ratio" }],
    assumptions: [{ name: "independent groups and observations", status: "requires_design_review" }, { name: "non-informative right censoring", status: "requires_design_review" }, { name: "proportional hazards for a stable hazard-ratio interpretation", status: "not_required_for_null_test_but_requires_review_for_effect_interpretation" }],
    diagnostics: [{ name: "event-time accounting", informativeTimes, tiedEventTimes, tieVariance: "hypergeometric", policy: "events are evaluated before censor removals at a shared time" }, { name: "effect boundary", status: "no_hazard_ratio_estimated", reason: "the log-rank test alone does not identify a constant hazard ratio" }],
    artifacts: [
      tableArtifact("Two-group log-rank test", `Comparison of ${first.name} and ${second.name}.`, [{ key: "contrast", label: "Contrast", type: "string" }, { key: "observedMinusExpected", label: "O-E", type: "number" }, { key: "variance", label: "Variance", type: "number" }, { key: "z", label: "z", type: "number" }, { key: "chiSquare", label: "Chi-square", type: "number" }, { key: "df", label: "df", type: "number" }, { key: "pValue", label: "p", type: "number" }], [{ contrast: `${first.name} vs ${second.name}`, observedMinusExpected, variance: varianceValue, z, chiSquare, df: 1, pValue }], ["Hypergeometric variance at tied event times; right censoring only."]),
      tableArtifact("Kaplan-Meier estimates by group", `${Math.round(options.confidenceLevel * 100)}% pointwise Greenwood log-log confidence intervals.`, kmTableColumns(true), curveRows.map(({ greenwoodVariance, ...row }) => row)),
      kmVega(curves, options.confidenceLevel, "Kaplan-Meier survival by group", true),
    ],
  };
}

function standardizePredictors(data, budget) {
  const centers = [];
  const scales = [];
  for (const predictor of data.predictors) {
    const center = mean(predictor.values, budget);
    const scale = Math.sqrt(variance(predictor.values, true, budget));
    if (!(scale > 0)) fail("STAT_DEGENERATE", `predictor ${predictor.name} has zero variance`);
    centers.push(center);
    scales.push(scale);
  }
  const x = data.time.map((_, row) => data.predictors.map((predictor, column) => (predictor.values[row] - centers[column]) / scales[column]));
  return { x, centers, scales };
}

function coxState(beta, time, event, x, ties, budget, includeResiduals = false) {
  const n = time.length;
  const p = beta.length;
  const eta = x.map((row) => row.reduce((total, value, index) => total + value * beta[index], 0));
  if (eta.some((value) => !Number.isFinite(value) || Math.abs(value) > 700)) fail("STAT_NON_CONVERGENCE", "Cox linear predictor diverged");
  const shift = Math.max(...eta);
  const weight = eta.map((value) => Math.exp(value - shift));
  const order = Array.from({ length: n }, (_, index) => index).sort((a, b) => time[b] - time[a] || a - b);
  let s0 = 0;
  const s1 = Array(p).fill(0);
  const s2 = Array.from({ length: p }, () => Array(p).fill(0));
  let logLikelihood = 0;
  const score = Array(p).fill(0);
  const information = Array.from({ length: p }, () => Array(p).fill(0));
  const residuals = [];
  let tiedEventTimes = 0;
  for (let start = 0; start < order.length;) {
    budget.check();
    let end = start + 1;
    while (end < order.length && time[order[end]] === time[order[start]]) end += 1;
    const block = order.slice(start, end);
    for (const index of block) {
      budget.check();
      s0 += weight[index];
      for (let j = 0; j < p; j += 1) {
        s1[j] += weight[index] * x[index][j];
        for (let k = 0; k < p; k += 1) s2[j][k] += weight[index] * x[index][j] * x[index][k];
      }
    }
    const deaths = block.filter((index) => event[index] === 1);
    const d = deaths.length;
    if (d > 0) {
      if (d > 1) tiedEventTimes += 1;
      const e0 = deaths.reduce((total, index) => total + weight[index], 0);
      const e1 = Array(p).fill(0);
      const e2 = Array.from({ length: p }, () => Array(p).fill(0));
      for (const index of deaths) {
        budget.check();
        logLikelihood += eta[index];
        for (let j = 0; j < p; j += 1) {
          score[j] += x[index][j];
          e1[j] += weight[index] * x[index][j];
          for (let k = 0; k < p; k += 1) e2[j][k] += weight[index] * x[index][j] * x[index][k];
        }
      }
      const expectedMeans = [];
      const repeats = ties === "efron" ? d : 1;
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        const fraction = ties === "efron" ? repeat / d : 0;
        const multiplicity = ties === "efron" ? 1 : d;
        const denominator = s0 - fraction * e0;
        if (!(denominator > 1e-300)) fail("STAT_NUMERIC_FAILURE", "Cox risk-set denominator is non-positive");
        logLikelihood -= multiplicity * (Math.log(denominator) + shift);
        const expected = Array(p).fill(0);
        for (let j = 0; j < p; j += 1) {
          expected[j] = (s1[j] - fraction * e1[j]) / denominator;
          score[j] -= multiplicity * expected[j];
          for (let k = 0; k < p; k += 1) {
            const second = (s2[j][k] - fraction * e2[j][k]) / denominator;
            information[j][k] += multiplicity * (second - expected[j] * ((s1[k] - fraction * e1[k]) / denominator));
          }
        }
        expectedMeans.push(expected);
      }
      if (includeResiduals) {
        const averageExpected = Array.from({ length: p }, (_, column) => mean(expectedMeans.map((row) => row[column])));
        for (const index of deaths) residuals.push({ time: time[index], values: x[index].map((value, column) => value - averageExpected[column]) });
      }
    }
    start = end;
  }
  return { logLikelihood, score, information, residuals, tiedEventTimes };
}

function analyzeCox(data, options, budget) {
  const standardized = standardizePredictors(data, budget);
  const p = data.predictors.length;
  let beta = Array(p).fill(0);
  const nullState = coxState(beta, data.time, data.event, standardized.x, options.ties, budget);
  let current = nullState;
  let converged = false;
  let iterations = 0;
  for (iterations = 1; iterations <= options.maxIterations; iterations += 1) {
    budget.check(2048);
    const inverseInformation = invert(current.information);
    const direction = matMul(inverseInformation, current.score.map((value) => [value]), budget).map((row) => row[0]);
    let factor = 1;
    let next;
    let candidate;
    while (factor >= 1 / 1024) {
      candidate = beta.map((value, index) => value + factor * direction[index]);
      if (candidate.some((value) => !Number.isFinite(value) || Math.abs(value) > 30)) {
        factor /= 2;
        continue;
      }
      next = coxState(candidate, data.time, data.event, standardized.x, options.ties, budget);
      if (next.logLikelihood >= current.logLikelihood - 1e-10) break;
      factor /= 2;
    }
    if (!next || factor < 1 / 1024) fail("STAT_NON_CONVERGENCE", "Cox partial-likelihood line search failed");
    const delta = Math.max(...candidate.map((value, index) => Math.abs(value - beta[index])));
    beta = candidate;
    current = next;
    if (delta < options.tolerance && Math.max(...current.score.map(Math.abs)) < Math.sqrt(options.tolerance)) { converged = true; break; }
  }
  if (!converged) fail("STAT_NON_CONVERGENCE", `Cox regression did not converge in ${options.maxIterations} iterations`);
  const finalState = coxState(beta, data.time, data.event, standardized.x, options.ties, budget, true);
  const covarianceScaled = invert(finalState.information);
  const critical = normalInv(1 - (1 - options.confidenceLevel) / 2);
  const coefficients = data.predictors.map((predictor, index) => {
    const estimate = beta[index] / standardized.scales[index];
    const standardError = Math.sqrt(Math.max(0, covarianceScaled[index][index])) / standardized.scales[index];
    if (!(standardError > 0)) fail("STAT_DEGENERATE", `Cox standard error is zero for ${predictor.name}`);
    const statistic = estimate / standardError;
    const lower = estimate - critical * standardError;
    const upper = estimate + critical * standardError;
    if ([estimate, lower, upper].some((value) => Math.abs(value) > 700)) fail("STAT_NON_CONVERGENCE", `Cox hazard ratio scale diverged for ${predictor.name}`);
    return { term: predictor.name, estimate, standardError, statistic, pValue: pFromNormal(statistic, "two-sided"), lower, upper, hazardRatio: Math.exp(estimate), hazardRatioLower: Math.exp(lower), hazardRatioUpper: Math.exp(upper) };
  });
  const phScreens = data.predictors.map((predictor, column) => {
    const values = finalState.residuals.map((row) => row.values[column]);
    const transformedTime = finalState.residuals.map((row) => Math.log(row.time));
    if (values.length < 4 || minMax(values).min === minMax(values).max || minMax(transformedTime).min === minMax(transformedTime).max) {
      return { term: predictor.name, status: "not_evaluated", reason: "requires at least four events across varying event times and residuals" };
    }
    const r = correlation(values, transformedTime, budget);
    const statistic = r * Math.sqrt((values.length - 2) / Math.max(1e-15, 1 - r * r));
    return { term: predictor.name, status: "screened", correlation: r, statistic, df: values.length - 2, pValue: pFromT(statistic, values.length - 2, "two-sided"), method: "unscaled Schoenfeld residual correlation with log(event time)" };
  });
  const likelihoodRatio = 2 * (finalState.logLikelihood - nullState.logLikelihood);
  if (likelihoodRatio < -1e-8) fail("STAT_NUMERIC_FAILURE", "Cox fitted likelihood is below null likelihood");
  const lr = Math.max(0, likelihoodRatio);
  const events = sum(data.event);
  return {
    sample: { n: data.time.length, events, censored: data.time.length - events, predictors: p },
    estimates: { coefficients, logPartialLikelihood: finalState.logLikelihood, nullLogPartialLikelihood: nullState.logLikelihood, tieMethod: options.ties },
    tests: [{ name: "Cox partial-likelihood ratio test", statistic: lr, distribution: "chi-square", df: p, pValue: pFromChiSquare(lr, p) }, ...coefficients.map((row) => ({ name: `Wald test: ${row.term}`, statistic: row.statistic, distribution: "normal", pValue: row.pValue }))],
    confidenceIntervals: coefficients.map((row) => ({ parameter: `${row.term} log hazard ratio`, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: "Wald normal" })),
    effectSizes: coefficients.map((row) => ({ name: `${row.term} hazard ratio`, estimate: row.hazardRatio, lower: row.hazardRatioLower, upper: row.hazardRatioUpper })),
    assumptions: [{ name: "right censoring", status: "verified_by_input_contract" }, { name: "independent observations and non-informative censoring", status: "requires_design_review" }, { name: "proportional hazards", status: "diagnostic_screen_attached" }, { name: "linear time-independent covariate effects on log hazard", status: "requires_model_review" }],
    diagnostics: [{ name: "partial-likelihood convergence", status: "converged", iterations, tolerance: options.tolerance, tieMethod: options.ties, tiedEventTimes: finalState.tiedEventTimes }, { name: "PH diagnostic boundary", status: "approximate_screen_only", detail: "unscaled Schoenfeld residual time-trend screens are provided; this is not a formal scaled-residual cox.zph test or a global PH test", screens: phScreens }, { name: "predictor standardization", status: "internal_only", centers: standardized.centers, scales: standardized.scales, outputScale: "original predictor units" }],
    artifacts: [
      tableArtifact(`Cox proportional hazards: ${data.outcomeLabel}`, `Partial-likelihood Cox model using ${options.ties} tie handling.`, [{ key: "term", label: "Term", type: "string" }, { key: "estimate", label: "Log HR", type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "statistic", label: "z", type: "number" }, { key: "pValue", label: "p", type: "number" }, { key: "hazardRatio", label: "Hazard ratio", type: "number" }, { key: "hazardRatioLower", label: "HR CI lower", type: "number" }, { key: "hazardRatioUpper", label: "HR CI upper", type: "number" }], coefficients.map(({ lower, upper, ...row }) => row), [`${Math.round(options.confidenceLevel * 100)}% Wald intervals; ${options.ties} ties; right censoring and time-independent covariates only.`]),
      vegaArtifact("hazard-ratio-plot", "Cox hazard ratios with confidence intervals", { data: { values: coefficients }, layer: [{ mark: { type: "rule", strokeWidth: 2 }, encoding: { y: { field: "term", type: "nominal", title: null }, x: { field: "hazardRatioLower", type: "quantitative", scale: { type: "log" }, title: "Hazard ratio" }, x2: { field: "hazardRatioUpper" } } }, { mark: { type: "point", filled: true, size: 90 }, encoding: { y: { field: "term", type: "nominal" }, x: { field: "hazardRatio", type: "quantitative", scale: { type: "log" } }, tooltip: [{ field: "term" }, { field: "hazardRatio", format: ".4g" }, { field: "pValue", format: ".4g" }] } }, { mark: { type: "rule", strokeDash: [4, 4], color: "#777" }, encoding: { x: { datum: 1, scale: { type: "log" } } } }] }),
    ],
  };
}

function symmetricEigenJacobi(matrix, budget) {
  const n = matrix.length;
  if (!matrix.every((row) => row.length === n)) fail("STAT_INTERNAL", "symmetric eigendecomposition requires a square matrix");
  const a = matrix.map((row) => [...row]);
  const vectors = Array.from({ length: n }, (_, row) => Array.from({ length: n }, (_, column) => row === column ? 1 : 0));
  const tolerance = 1e-12;
  const maxSweeps = 100 * n * n;
  let rotations = 0;
  let converged = n === 1;
  for (; rotations < maxSweeps; rotations += 1) {
    let p = 0;
    let q = 1;
    let maximum = 0;
    for (let row = 0; row < n; row += 1) {
      for (let column = row + 1; column < n; column += 1) {
        budget.check();
        const candidate = Math.abs(a[row][column]);
        if (candidate > maximum) {
          maximum = candidate;
          p = row;
          q = column;
        }
      }
    }
    if (maximum <= tolerance) {
      converged = true;
      break;
    }
    const theta = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
    const cosine = Math.cos(theta);
    const sine = Math.sin(theta);
    const app = a[p][p];
    const aqq = a[q][q];
    const apq = a[p][q];
    a[p][p] = cosine * cosine * app - 2 * sine * cosine * apq + sine * sine * aqq;
    a[q][q] = sine * sine * app + 2 * sine * cosine * apq + cosine * cosine * aqq;
    a[p][q] = 0;
    a[q][p] = 0;
    for (let index = 0; index < n; index += 1) {
      if (index !== p && index !== q) {
        const aip = a[index][p];
        const aiq = a[index][q];
        a[index][p] = cosine * aip - sine * aiq;
        a[p][index] = a[index][p];
        a[index][q] = sine * aip + cosine * aiq;
        a[q][index] = a[index][q];
      }
      const vip = vectors[index][p];
      const viq = vectors[index][q];
      vectors[index][p] = cosine * vip - sine * viq;
      vectors[index][q] = sine * vip + cosine * viq;
    }
  }
  if (!converged) fail("STAT_NON_CONVERGENCE", "PCA symmetric eigendecomposition did not converge");
  const pairs = Array.from({ length: n }, (_, index) => ({
    value: Math.abs(a[index][index]) < 1e-12 ? 0 : a[index][index],
    vector: vectors.map((row) => row[index]),
  })).sort((left, right) => right.value - left.value);
  for (const pair of pairs) {
    let anchor = 0;
    for (let index = 1; index < pair.vector.length; index += 1) {
      if (Math.abs(pair.vector[index]) > Math.abs(pair.vector[anchor])) anchor = index;
    }
    if (pair.vector[anchor] < 0) pair.vector = pair.vector.map((value) => -value);
    if (pair.value < -1e-9) fail("STAT_NUMERIC_FAILURE", "PCA covariance matrix produced a materially negative eigenvalue");
    pair.value = Math.max(0, pair.value);
  }
  return { pairs, rotations, tolerance };
}

function covarianceMatrix(columns, budget) {
  const n = columns[0].length;
  const matrix = Array.from({ length: columns.length }, () => Array(columns.length).fill(0));
  for (let row = 0; row < columns.length; row += 1) {
    for (let column = row; column < columns.length; column += 1) {
      let value = 0;
      for (let index = 0; index < n; index += 1) {
        budget.check();
        value += columns[row][index] * columns[column][index];
      }
      value /= n - 1;
      matrix[row][column] = value;
      matrix[column][row] = value;
    }
  }
  return matrix;
}

function pcaAdequacy(correlationMatrix, eigenvalues, sampleSize) {
  const variables = correlationMatrix.length;
  const positive = eigenvalues.every((value) => value > 1e-12);
  let bartlett = { name: "Bartlett sphericity", status: "not_evaluated", reason: "correlation matrix is singular" };
  if (positive) {
    const logDeterminant = sum(eigenvalues.map(Math.log));
    const statistic = Math.max(0, -(sampleSize - 1 - (2 * variables + 5) / 6) * logDeterminant);
    const df = variables * (variables - 1) / 2;
    bartlett = { name: "Bartlett sphericity", status: "evaluated", statistic, df, pValue: pFromChiSquare(statistic, df), logDeterminant, method: "large-sample chi-square approximation" };
  }
  try {
    const inverse = invert(correlationMatrix);
    let correlationSquares = 0;
    let partialSquares = 0;
    const perVariable = [];
    for (let row = 0; row < variables; row += 1) {
      let rowCorrelationSquares = 0;
      let rowPartialSquares = 0;
      for (let column = 0; column < variables; column += 1) {
        if (row === column) continue;
        const correlationSquare = correlationMatrix[row][column] ** 2;
        const partial = -inverse[row][column] / Math.sqrt(inverse[row][row] * inverse[column][column]);
        const partialSquare = partial ** 2;
        rowCorrelationSquares += correlationSquare;
        rowPartialSquares += partialSquare;
        if (column > row) {
          correlationSquares += correlationSquare;
          partialSquares += partialSquare;
        }
      }
      const rowDenominator = rowCorrelationSquares + rowPartialSquares;
      perVariable.push(rowDenominator > 1e-15 ? rowCorrelationSquares / rowDenominator : null);
    }
    const overallDenominator = correlationSquares + partialSquares;
    if (!(overallDenominator > 1e-15)) {
      return { bartlett, kmo: { name: "Kaiser-Meyer-Olkin", status: "not_evaluated", reason: "variables have no measurable shared correlation", boundary: "sampling-adequacy screen only" } };
    }
    const overall = correlationSquares / overallDenominator;
    return { bartlett, kmo: { name: "Kaiser-Meyer-Olkin", status: "evaluated", overall, perVariable, method: "squared-correlation to squared-partial-correlation ratio", boundary: "sampling-adequacy screen only" } };
  } catch (error) {
    return { bartlett, kmo: { name: "Kaiser-Meyer-Olkin", status: "not_evaluated", reason: "correlation matrix is singular", boundary: "sampling-adequacy screen only" } };
  }
}

function analyzePca(data, options, budget) {
  const n = data.rowCount;
  const p = data.variables.length;
  const centers = data.variables.map((variable) => mean(variable.values, budget));
  const standardDeviations = data.variables.map((variable) => Math.sqrt(variance(variable.values, true, budget)));
  const centeredColumns = data.variables.map((variable, column) => variable.values.map((value) => value - centers[column]));
  const correlationColumns = centeredColumns.map((column, index) => column.map((value) => value / standardDeviations[index]));
  const analysisColumns = options.scaling === "correlation" ? correlationColumns : centeredColumns;
  const analysisMatrix = covarianceMatrix(analysisColumns, budget);
  const correlationMatrix = covarianceMatrix(correlationColumns, budget);
  const decomposition = symmetricEigenJacobi(analysisMatrix, budget);
  const correlationEigen = options.scaling === "correlation" ? decomposition : symmetricEigenJacobi(correlationMatrix, budget);
  const totalVariance = sum(decomposition.pairs.map((pair) => pair.value), budget);
  if (!(totalVariance > 0)) fail("STAT_DEGENERATE", "PCA total variance must be positive");
  const componentRows = [];
  let cumulative = 0;
  for (const [index, pair] of decomposition.pairs.entries()) {
    const explainedVarianceRatio = pair.value / totalVariance;
    cumulative += explainedVarianceRatio;
    componentRows.push({ component: `PC${index + 1}`, eigenvalue: pair.value, explainedVarianceRatio, cumulativeExplainedVariance: Math.min(1, cumulative), retained: index < data.components });
  }
  const selected = decomposition.pairs.slice(0, data.components);
  const scoreRows = Array.from({ length: n }, (_, row) => {
    const result = { row: row + 1, label: data.rowLabels[row] };
    for (let component = 0; component < selected.length; component += 1) {
      let score = 0;
      for (let variable = 0; variable < p; variable += 1) {
        budget.check();
        score += analysisColumns[variable][row] * selected[component].vector[variable];
      }
      result[`PC${component + 1}`] = score;
    }
    return result;
  });
  const loadingRows = [];
  const communalities = data.variables.map((variable) => ({ variable: variable.name, communality: 0 }));
  for (let variable = 0; variable < p; variable += 1) {
    for (let component = 0; component < selected.length; component += 1) {
      const coefficient = selected[component].vector[variable];
      const loading = coefficient * Math.sqrt(selected[component].value);
      loadingRows.push({ variable: data.variables[variable].name, component: `PC${component + 1}`, coefficient, loading });
      communalities[variable].communality += loading * loading;
    }
  }
  let residualSumSquares = 0;
  let totalSumSquares = 0;
  for (let row = 0; row < n; row += 1) {
    for (let variable = 0; variable < p; variable += 1) {
      budget.check();
      let reconstructed = 0;
      for (let component = 0; component < selected.length; component += 1) reconstructed += scoreRows[row][`PC${component + 1}`] * selected[component].vector[variable];
      const residual = analysisColumns[variable][row] - reconstructed;
      residualSumSquares += residual * residual;
      totalSumSquares += analysisColumns[variable][row] ** 2;
    }
  }
  let orthogonalityResidual = 0;
  for (let first = 0; first < selected.length; first += 1) {
    for (let second = 0; second < selected.length; second += 1) {
      const dot = sum(selected[first].vector.map((value, index) => value * selected[second].vector[index]), budget);
      orthogonalityResidual = Math.max(orthogonalityResidual, Math.abs(dot - (first === second ? 1 : 0)));
    }
  }
  const adequacy = pcaAdequacy(correlationMatrix, correlationEigen.pairs.map((pair) => pair.value), n);
  const retainedVariance = componentRows[data.components - 1].cumulativeExplainedVariance;
  const repeatedEigenvalues = decomposition.pairs.slice(1).filter((pair, index) => Math.abs(pair.value - decomposition.pairs[index].value) <= 1e-10 * Math.max(1, pair.value, decomposition.pairs[index].value)).length;
  const scoreColumns = [{ key: "row", label: "Row", type: "number" }, { key: "label", label: "Label", type: "string" }, ...Array.from({ length: data.components }, (_, index) => ({ key: `PC${index + 1}`, label: `PC${index + 1} score`, type: "number" }))];
  const scoreHash = sha256(scoreRows);
  const scorePlot = data.components >= 2
    ? vegaArtifact("pca-score-plot", "PCA score plot", { data: { values: scoreRows }, mark: { type: "point", filled: true, size: 70, opacity: 0.8 }, encoding: { x: { field: "PC1", type: "quantitative", title: `PC1 (${(componentRows[0].explainedVarianceRatio * 100).toFixed(1)}%)` }, y: { field: "PC2", type: "quantitative", title: `PC2 (${(componentRows[1].explainedVarianceRatio * 100).toFixed(1)}%)` }, tooltip: [{ field: "label" }, { field: "PC1", format: ".5g" }, { field: "PC2", format: ".5g" }] } })
    : vegaArtifact("pca-score-plot", "PCA first-component scores", { data: { values: scoreRows }, mark: { type: "point", filled: true, size: 70 }, encoding: { x: { field: "row", type: "quantitative", title: "Row" }, y: { field: "PC1", type: "quantitative", title: "PC1 score" }, tooltip: [{ field: "label" }, { field: "PC1", format: ".5g" }] } });
  return {
    sample: { n, variables: p, retainedComponents: data.components, completeRows: n },
    estimates: {
      scaling: options.scaling,
      centers,
      scales: options.scaling === "correlation" ? standardDeviations : Array(p).fill(1),
      variableNames: data.variables.map((variable) => variable.name),
      components: componentRows,
      loadings: loadingRows,
      communalities,
      reconstructionRelativeSquaredError: residualSumSquares / totalSumSquares,
      rendererDataContract: { inlineRows: "all", sampling: "none", aggregation: "none", rowCount: scoreRows.length, componentScoresHash: scoreHash },
    },
    tests: adequacy.bartlett.status === "evaluated" ? [{ name: "Bartlett test of sphericity", statistic: adequacy.bartlett.statistic, distribution: "chi-square", df: adequacy.bartlett.df, pValue: adequacy.bartlett.pValue }] : [],
    confidenceIntervals: [],
    effectSizes: [{ name: "retained cumulative explained variance", estimate: retainedVariance }, { name: "retained reconstruction proportion", estimate: 1 - residualSumSquares / totalSumSquares }],
    assumptions: [{ name: "complete finite numeric matrix", status: "verified" }, { name: "independent observational units", status: "requires_design_review" }, { name: "linear low-dimensional structure", status: "requires_score_and_residual_review" }, { name: "measurement scale", status: options.scaling === "correlation" ? "standardized_to_unit_sample_variance" : "raw_covariance_scale" }],
    diagnostics: [adequacy.bartlett, adequacy.kmo, { name: "eigendecomposition", status: "converged", rotations: decomposition.rotations, tolerance: decomposition.tolerance, signConvention: "largest-absolute coefficient positive", repeatedEigenvaluePairs: repeatedEigenvalues, boundary: repeatedEigenvalues ? "individual eigenvectors inside a repeated-eigenvalue subspace are not uniquely identified" : "ordered eigenvectors are numerically separated" }, { name: "component orthogonality", status: orthogonalityResidual <= 1e-9 ? "verified" : "numeric_warning", maximumAbsoluteResidual: orthogonalityResidual }, { name: "renderer exact-data contract", status: "verified", sampling: "none", aggregation: "none", rows: scoreRows.length, componentScoresHash: scoreHash }, { name: "PCA inference boundary", status: "descriptive_decomposition", detail: "Bartlett and KMO are adequacy screens; component retention and scientific interpretation require researcher judgment" }],
    artifacts: [
      tableArtifact("PCA variance summary", `Principal components from the ${options.scaling} matrix.`, [{ key: "component", label: "Component", type: "string" }, { key: "eigenvalue", label: "Eigenvalue", type: "number" }, { key: "explainedVarianceRatio", label: "Explained variance", type: "number" }, { key: "cumulativeExplainedVariance", label: "Cumulative", type: "number" }, { key: "retained", label: "Retained", type: "boolean" }], componentRows, ["Components are ordered by descending eigenvalue; eigenvector signs use a deterministic largest-loading-positive convention."], "pca-variance-table"),
      tableArtifact("PCA loadings", "Eigenvector coefficients and eigenvector-times-square-root-eigenvalue loadings.", [{ key: "variable", label: "Variable", type: "string" }, { key: "component", label: "Component", type: "string" }, { key: "coefficient", label: "Coefficient", type: "number" }, { key: "loading", label: "Loading", type: "number" }], loadingRows, [options.scaling === "covariance" ? "Loadings are expressed on the covariance analysis scale." : "Correlation-matrix loadings are variable-component correlations."], "pca-loading-table"),
      tableArtifact("PCA component scores", "Exact retained-component scores for every input row.", scoreColumns, scoreRows, [`Rows sha256: ${scoreHash}. No sampling or aggregation.`], "pca-score-table"),
      vegaArtifact("pca-scree-plot", "PCA scree and cumulative variance", {
        data: { values: componentRows },
        layer: [
          {
            mark: { type: "bar", opacity: 0.75 },
            encoding: {
              x: { field: "component", type: "ordinal", title: "Component" },
              y: { field: "explainedVarianceRatio", type: "quantitative", title: "Explained variance", axis: { format: "%" } },
              color: { field: "retained", type: "nominal", legend: null },
              tooltip: [{ field: "component" }, { field: "eigenvalue", format: ".5g" }, { field: "explainedVarianceRatio", format: ".2%" }],
            },
          },
          {
            mark: { type: "line", point: true, color: "#9A5B2E" },
            encoding: {
              x: { field: "component", type: "ordinal" },
              y: { field: "cumulativeExplainedVariance", type: "quantitative", axis: { format: "%" } },
            },
          },
        ],
        resolve: { scale: { y: "shared" } },
      }),
      scorePlot,
      vegaArtifact("pca-loading-heatmap", "PCA loading heatmap", { data: { values: loadingRows }, mark: "rect", encoding: { x: { field: "component", type: "ordinal", title: "Component" }, y: { field: "variable", type: "nominal", title: null }, color: { field: "loading", type: "quantitative", scale: { scheme: "redblue", domainMid: 0 }, title: "Loading" }, tooltip: [{ field: "variable" }, { field: "component" }, { field: "loading", format: ".5g" }] } }),
    ],
  };
}

function timeSeriesAutocorrelation(values, maxLag, budget) {
  const center = mean(values, budget);
  const deviations = values.map((value) => value - center);
  const denominator = sum(deviations.map((value) => value * value), budget);
  if (!(denominator > 0)) fail("STAT_DEGENERATE", "time series variance must be positive");
  const acf = [1];
  for (let lag = 1; lag <= maxLag; lag += 1) {
    let numerator = 0;
    for (let index = lag; index < deviations.length; index += 1) {
      budget.check();
      numerator += deviations[index] * deviations[index - lag];
    }
    acf.push(numerator / denominator);
  }
  const pacf = [1];
  let previous = [];
  let innovation = 1;
  for (let order = 1; order <= maxLag; order += 1) {
    let numerator = acf[order];
    for (let index = 1; index < order; index += 1) numerator -= previous[index - 1] * acf[order - index];
    if (Math.abs(innovation) < 1e-12) {
      pacf.push(0);
      previous = [...previous, 0];
      continue;
    }
    const reflection = numerator / innovation;
    const current = Array(order).fill(0);
    for (let index = 1; index < order; index += 1) current[index - 1] = previous[index - 1] - reflection * previous[order - index - 1];
    current[order - 1] = reflection;
    previous = current;
    innovation *= 1 - reflection * reflection;
    pacf.push(reflection);
  }
  return { acf, pacf };
}

function analyzeTimeSeries(data, options, budget) {
  let values = [...data.values];
  let time = [...data.time];
  if (options.differenceOrder === 1) {
    values = values.slice(1).map((value, index) => value - values[index]);
    time = time.slice(1);
  }
  const n = values.length;
  const autocorrelation = timeSeriesAutocorrelation(values, data.maxLag, budget);
  const confidenceLimit = normalInv(0.5 + options.confidenceLevel / 2) / Math.sqrt(n);
  let ljungBox = 0;
  const correlationRows = [];
  for (let lag = 1; lag <= data.maxLag; lag += 1) {
    ljungBox += n * (n + 2) * autocorrelation.acf[lag] ** 2 / (n - lag);
    correlationRows.push({ lag, autocorrelation: autocorrelation.acf[lag], partialAutocorrelation: autocorrelation.pacf[lag], lower: -confidenceLimit, upper: confidenceLimit, cumulativeLjungBox: ljungBox, cumulativePValue: pFromChiSquare(ljungBox, lag) });
  }
  const timeCenter = mean(time, budget);
  const valueCenter = mean(values, budget);
  const centeredTime = time.map((value) => value - timeCenter);
  const centeredValues = values.map((value) => value - valueCenter);
  const timeSumSquares = sum(centeredTime.map((value) => value * value), budget);
  if (!(timeSumSquares > 0)) fail("STAT_DEGENERATE", "time-series sampling times must vary");
  const slope = sum(centeredTime.map((value, index) => value * centeredValues[index]), budget) / timeSumSquares;
  const intercept = valueCenter - slope * timeCenter;
  const fitted = time.map((value) => intercept + slope * value);
  const residuals = values.map((value, index) => value - fitted[index]);
  const sse = sum(residuals.map((value) => value * value), budget);
  if (!(sse > 0)) fail("STAT_DEGENERATE", "perfect linear time-series fit leaves no residual variance for inference");
  const df = n - 2;
  const mse = sse / df;
  const standardError = Math.sqrt(Math.max(0, mse / timeSumSquares));
  if (!(standardError > 0)) fail("STAT_DEGENERATE", "time-series trend standard error must be positive");
  const slopeStatistic = slope / standardError;
  const critical = tCritical(options.confidenceLevel, df);
  const lower = slope - critical * standardError;
  const upper = slope + critical * standardError;
  const finalLjungBoxP = correlationRows[correlationRows.length - 1].cumulativePValue;
  const seriesRows = values.map((value, index) => ({ row: index + 1, time: time[index], value, fittedTrend: fitted[index], residual: residuals[index] }));
  const seriesHash = sha256(seriesRows);
  const standardDeviation = Math.sqrt(variance(values, true, budget));
  return {
    sample: { n: data.values.length, analyzedN: n, maxLag: data.maxLag, differenceOrder: options.differenceOrder, completeRows: data.values.length },
    estimates: {
      seriesLabel: data.seriesLabel,
      timeLabel: data.timeLabel,
      differenceOrder: options.differenceOrder,
      interval: data.interval,
      mean: mean(values, budget),
      sampleVariance: variance(values, true, budget),
      trend: { intercept, slope, standardError, statistic: slopeStatistic, df, pValue: pFromT(slopeStatistic, df, "two-sided"), lower, upper },
      autocorrelation: correlationRows,
      rendererDataContract: { inlineRows: "all", sampling: "none", aggregation: "none", rowCount: seriesRows.length, seriesRowsHash: seriesHash },
    },
    tests: [{ name: "Linear time-trend t test", statistic: slopeStatistic, distribution: "t", df, pValue: pFromT(slopeStatistic, df, "two-sided") }, { name: `Ljung-Box portmanteau through lag ${data.maxLag}`, statistic: ljungBox, distribution: "chi-square", df: data.maxLag, pValue: finalLjungBoxP }],
    confidenceIntervals: [{ parameter: "linear trend slope", level: options.confidenceLevel, lower, upper, method: "classical OLS Student t for deterministic time trend" }],
    effectSizes: [{ name: "lag-1 autocorrelation", estimate: autocorrelation.acf[1] }, { name: "standardized trend per sampling interval", estimate: slope * data.interval / standardDeviation }],
    assumptions: [{ name: "complete finite observations", status: "verified" }, { name: "evenly spaced sampling", status: data.explicitTime ? "verified" : "assumed_from_implicit_index" }, { name: "weak stationarity", status: options.differenceOrder === 1 ? "requires_review_after_first_difference" : "not_established" }, { name: "independent innovations", status: "Ljung-Box_diagnostic_attached" }, { name: "deterministic linear trend inference", status: "requires_residual_dependence_review" }],
    diagnostics: [{ name: "sampling interval", status: data.explicitTime ? "verified_equal_spacing" : "implicit_unit_spacing", interval: data.interval }, { name: "Ljung-Box", status: "evaluated", lag: data.maxLag, statistic: ljungBox, df: data.maxLag, pValue: finalLjungBoxP, boundary: "tests residual white-noise structure of the analyzed series without fitted ARMA degree correction" }, { name: "ACF uncertainty", status: "approximate_screen_only", confidenceLevel: options.confidenceLevel, lower: -confidenceLimit, upper: confidenceLimit, method: "white-noise normal bound" }, { name: "stationarity boundary", status: "not_a_stationarity_test", detail: "ACF, PACF, trend, and Ljung-Box diagnostics do not replace ADF, KPSS, structural-break, seasonal-unit-root, or domain review" }, { name: "renderer exact-data contract", status: "verified", sampling: "none", aggregation: "none", rows: seriesRows.length, seriesRowsHash: seriesHash }],
    artifacts: [
      tableArtifact(`Time series: ${data.seriesLabel}`, "Exact analyzed observations, fitted deterministic trend, and residuals.", [{ key: "row", label: "Row", type: "number" }, { key: "time", label: data.timeLabel, type: "number" }, { key: "value", label: data.seriesLabel, type: "number" }, { key: "fittedTrend", label: "Fitted trend", type: "number" }, { key: "residual", label: "Residual", type: "number" }], seriesRows, [`Rows sha256: ${seriesHash}. No sampling or aggregation.`], "time-series-observation-table"),
      tableArtifact("Autocorrelation diagnostics", "Sample ACF, Durbin-Levinson/Yule-Walker PACF, white-noise bounds, and cumulative Ljung-Box statistics.", [{ key: "lag", label: "Lag", type: "number" }, { key: "autocorrelation", label: "ACF", type: "number" }, { key: "partialAutocorrelation", label: "PACF", type: "number" }, { key: "lower", label: "Lower bound", type: "number" }, { key: "upper", label: "Upper bound", type: "number" }, { key: "cumulativeLjungBox", label: "Ljung-Box Q", type: "number" }, { key: "cumulativePValue", label: "p", type: "number" }], correlationRows, ["Intermediate lag p values are exploratory cumulative portmanteau results; the final selected lag is the declared primary diagnostic."], "time-series-correlation-table"),
      vegaArtifact("time-series-plot", `Time series: ${data.seriesLabel}`, {
        data: { values: seriesRows },
        layer: [
          {
            mark: { type: "line", point: seriesRows.length <= 500 },
            encoding: {
              x: { field: "time", type: "quantitative", title: data.timeLabel },
              y: { field: "value", type: "quantitative", title: data.seriesLabel },
              tooltip: [{ field: "time", format: ".6g" }, { field: "value", format: ".6g" }],
            },
          },
          {
            mark: { type: "line", color: "#9A5B2E", strokeDash: [6, 4] },
            encoding: {
              x: { field: "time", type: "quantitative" },
              y: { field: "fittedTrend", type: "quantitative" },
            },
          },
        ],
      }),
      vegaArtifact("autocorrelation-plot", "Autocorrelation function", { data: { values: correlationRows }, layer: [{ mark: { type: "bar" }, encoding: { x: { field: "lag", type: "ordinal", title: "Lag" }, y: { field: "autocorrelation", type: "quantitative", title: "ACF" }, tooltip: [{ field: "lag" }, { field: "autocorrelation", format: ".5g" }, { field: "cumulativePValue", format: ".5g" }] } }, { mark: { type: "rule", color: "#B24A3B", strokeDash: [4, 3] }, encoding: { y: { field: "upper", type: "quantitative" } } }, { mark: { type: "rule", color: "#B24A3B", strokeDash: [4, 3] }, encoding: { y: { field: "lower", type: "quantitative" } } }] }),
    ],
  };
}

function metaWeightedSummary(studies, tauSquared, critical, budget) {
  const weights = studies.map((study) => {
    budget.check();
    const weight = 1 / (study.variance + tauSquared);
    if (!Number.isFinite(weight) || !(weight > 0)) fail("STAT_NUMERIC_FAILURE", "meta-analysis produced an invalid inverse-variance weight");
    return weight;
  });
  const weightSum = sum(weights, budget);
  const estimate = sum(studies.map((study, index) => study.effect * weights[index]), budget) / weightSum;
  const standardError = Math.sqrt(1 / weightSum);
  const lower = estimate - critical * standardError;
  const upper = estimate + critical * standardError;
  if (![estimate, standardError, lower, upper].every(Number.isFinite)) fail("STAT_NUMERIC_OVERFLOW", "meta-analysis pooled estimate exceeded the numeric boundary");
  const q = sum(studies.map((study, index) => weights[index] * Math.pow(study.effect - estimate, 2)), budget);
  if (!Number.isFinite(q)) fail("STAT_NUMERIC_OVERFLOW", "meta-analysis heterogeneity statistic exceeded the numeric boundary");
  return { estimate, standardError, lower, upper, weights, weightSum, q };
}

function metaTauSquared(studies, estimator, options, budget) {
  if (studies.length < 2) return { value: 0, iterations: 0, converged: true, boundary: "single-study" };
  const critical = normalInv(1 - (1 - options.confidenceLevel) / 2);
  const fixed = metaWeightedSummary(studies, 0, critical, budget);
  const df = studies.length - 1;
  if (estimator === "der-simonian-laird") {
    const squaredWeightSum = sum(fixed.weights.map((weight) => weight * weight), budget);
    const denominator = fixed.weightSum - squaredWeightSum / fixed.weightSum;
    if (!(denominator > 0) || !Number.isFinite(denominator)) fail("STAT_NUMERIC_FAILURE", "DerSimonian-Laird denominator is not positive");
    return { value: Math.max(0, (fixed.q - df) / denominator), iterations: 0, converged: true, boundary: fixed.q <= df ? "zero" : "interior" };
  }
  if (fixed.q <= df) return { value: 0, iterations: 0, converged: true, boundary: "zero" };
  const objective = (tauSquared) => metaWeightedSummary(studies, tauSquared, critical, budget).q - df;
  let low = 0;
  let high = Math.max(1e-12, Math.max(...studies.map((study) => study.variance)));
  let highValue = objective(high);
  let bracketIterations = 0;
  while (highValue > 0 && bracketIterations < options.maxIterations) {
    high *= 2;
    if (!Number.isFinite(high)) fail("STAT_NUMERIC_OVERFLOW", "Paule-Mandel tau-squared bracket exceeded the numeric boundary");
    highValue = objective(high);
    bracketIterations += 1;
  }
  if (highValue > 0) fail("STAT_NON_CONVERGENCE", "Paule-Mandel tau-squared bracketing did not converge");
  let iterations = bracketIterations;
  while (iterations < options.maxIterations) {
    const midpoint = (low + high) / 2;
    const value = objective(midpoint);
    iterations += 1;
    if (Math.abs(value) <= options.tolerance || high - low <= options.tolerance * Math.max(1, midpoint)) {
      return { value: midpoint, iterations, converged: true, boundary: "interior" };
    }
    if (value > 0) low = midpoint;
    else high = midpoint;
  }
  fail("STAT_NON_CONVERGENCE", "Paule-Mandel tau-squared root search did not converge");
}

function metaEgger(studies, budget) {
  const k = studies.length;
  if (k < 3) return { name: "Egger regression intercept", status: "not_evaluated", reason: "requires at least three studies; ten or more are commonly recommended for interpretation" };
  const precision = studies.map((study) => 1 / study.standardError);
  const standardized = studies.map((study) => study.effect / study.standardError);
  const meanPrecision = mean(precision, budget);
  const meanStandardized = mean(standardized, budget);
  const centeredPrecision = precision.map((value) => value - meanPrecision);
  const sxx = sum(centeredPrecision.map((value) => value * value), budget);
  if (!(sxx > Math.max(1, meanPrecision * meanPrecision) * 1e-14)) {
    return { name: "Egger regression intercept", status: "not_evaluated", reason: "study precisions do not vary enough for the regression" };
  }
  const slope = sum(centeredPrecision.map((value, index) => value * (standardized[index] - meanStandardized)), budget) / sxx;
  const intercept = meanStandardized - slope * meanPrecision;
  const residuals = standardized.map((value, index) => value - intercept - slope * precision[index]);
  const df = k - 2;
  const residualSumSquares = sum(residuals.map((value) => value * value), budget);
  const standardError = Math.sqrt((residualSumSquares / df) * (1 / k + meanPrecision * meanPrecision / sxx));
  if (!(standardError > 0) || !Number.isFinite(standardError)) {
    return { name: "Egger regression intercept", status: "not_evaluated", reason: "perfect or numerically degenerate regression leaves no estimable intercept standard error" };
  }
  const statistic = intercept / standardError;
  return {
    name: "Egger regression intercept",
    status: "evaluated",
    intercept,
    slope,
    standardError,
    statistic,
    df,
    pValue: pFromT(statistic, df, "two-sided"),
    interpretationBoundary: k < 10 ? "mathematically estimable but underpowered below ten studies; do not treat as a publication-bias verdict" : "asymmetry screen only; selective reporting and heterogeneity require substantive review",
  };
}

function metaAnalysisCore(studies, options, budget) {
  const critical = normalInv(1 - (1 - options.confidenceLevel) / 2);
  const fixed = metaWeightedSummary(studies, 0, critical, budget);
  const df = studies.length - 1;
  const tauDl = metaTauSquared(studies, "der-simonian-laird", options, budget);
  const tauPm = metaTauSquared(studies, "paule-mandel", options, budget);
  const selectedTau = options.tauEstimator === "der-simonian-laird" ? tauDl : tauPm;
  const random = metaWeightedSummary(studies, selectedTau.value, critical, budget);
  const predictionStandardError = Math.sqrt(selectedTau.value + random.standardError * random.standardError);
  const prediction = {
    level: options.confidenceLevel,
    lower: random.estimate - critical * predictionStandardError,
    upper: random.estimate + critical * predictionStandardError,
    method: "normal-approximation random-effects prediction interval",
  };
  const iSquared = fixed.q > 0 ? Math.max(0, (fixed.q - df) / fixed.q) : 0;
  const hSquared = df > 0 ? Math.max(1, fixed.q / df) : null;
  const qPValue = df > 0 ? pFromChiSquare(fixed.q, df) : null;
  return { critical, fixed, random, tauDl, tauPm, selectedTau, prediction, q: fixed.q, df, qPValue, iSquared, hSquared };
}

function analyzeMetaAnalysis(data, options, budget) {
  const core = metaAnalysisCore(data.studies, options, budget);
  const fixedWeightSum = core.fixed.weightSum;
  const randomWeightSum = core.random.weightSum;
  const studyRows = data.studies.map((study, index) => ({
    study: study.label,
    effect: study.effect,
    standardError: study.standardError,
    variance: study.variance,
    lower: study.effect - core.critical * study.standardError,
    upper: study.effect + core.critical * study.standardError,
    fixedWeightPercent: 100 * core.fixed.weights[index] / fixedWeightSum,
    randomWeightPercent: 100 * core.random.weights[index] / randomWeightSum,
  }));
  const leaveOneOut = data.studies.map((omittedStudy, omittedIndex) => {
    const retained = data.studies.filter((_, index) => index !== omittedIndex);
    const result = metaAnalysisCore(retained, options, budget);
    return {
      omittedStudy: omittedStudy.label,
      retainedStudies: retained.length,
      fixedEffect: result.fixed.estimate,
      fixedLower: result.fixed.lower,
      fixedUpper: result.fixed.upper,
      randomEffect: result.random.estimate,
      randomLower: result.random.lower,
      randomUpper: result.random.upper,
      tauSquared: result.selectedTau.value,
      q: result.q,
      deltaFixed: result.fixed.estimate - core.fixed.estimate,
      deltaRandom: result.random.estimate - core.random.estimate,
    };
  });
  const forestRows = [
    ...studyRows.map((row) => ({ rowType: "study", label: row.study, effect: row.effect, lower: row.lower, upper: row.upper, standardError: row.standardError, fixedWeightPercent: row.fixedWeightPercent, randomWeightPercent: row.randomWeightPercent, tauSquared: 0 })),
    { rowType: "pooled-fixed", label: "Pooled fixed effect", effect: core.fixed.estimate, lower: core.fixed.lower, upper: core.fixed.upper, standardError: core.fixed.standardError, fixedWeightPercent: 100, randomWeightPercent: 0, tauSquared: 0 },
    { rowType: "pooled-random", label: `Pooled random effect (${options.tauEstimator})`, effect: core.random.estimate, lower: core.random.lower, upper: core.random.upper, standardError: core.random.standardError, fixedWeightPercent: 0, randomWeightPercent: 100, tauSquared: core.selectedTau.value },
  ];
  const funnelRows = studyRows.map((row) => ({ study: row.study, effect: row.effect, standardError: row.standardError, precision: 1 / row.standardError, lowerPseudoLimit: core.random.estimate - core.critical * row.standardError, upperPseudoLimit: core.random.estimate + core.critical * row.standardError }));
  const influenceRows = leaveOneOut.map((row) => ({ omittedStudy: row.omittedStudy, fixedEffect: row.fixedEffect, randomEffect: row.randomEffect, deltaFixed: row.deltaFixed, deltaRandom: row.deltaRandom, tauSquared: row.tauSquared, q: row.q }));
  const primaryModel = options.metaModel === "fixed" ? "fixed" : "random";
  const egger = metaEgger(data.studies, budget);
  const summaryRows = [
    { model: "fixed inverse variance", estimate: core.fixed.estimate, standardError: core.fixed.standardError, lower: core.fixed.lower, upper: core.fixed.upper, tauSquared: 0, estimator: "fixed" },
    { model: "random effects", estimate: core.random.estimate, standardError: core.random.standardError, lower: core.random.lower, upper: core.random.upper, tauSquared: core.selectedTau.value, estimator: options.tauEstimator },
  ];
  const rendererDataContract = {
    inlineRows: "all",
    sampling: "none",
    aggregation: "declared inverse-variance pooling only",
    studyRowCount: studyRows.length,
    forestRowCount: forestRows.length,
    funnelRowCount: funnelRows.length,
    influenceRowCount: influenceRows.length,
    studyRowsHash: sha256(studyRows),
    forestRowsHash: sha256(forestRows),
    funnelRowsHash: sha256(funnelRows),
    influenceRowsHash: sha256(influenceRows),
  };
  return {
    sample: { studies: data.studies.length, effectLabel: data.effectLabel, primaryModel, reportedModels: options.metaModel },
    estimates: {
      fixed: { estimate: core.fixed.estimate, standardError: core.fixed.standardError, lower: core.fixed.lower, upper: core.fixed.upper, weightSum: core.fixed.weightSum },
      random: { estimate: core.random.estimate, standardError: core.random.standardError, lower: core.random.lower, upper: core.random.upper, weightSum: core.random.weightSum, tauSquared: core.selectedTau.value, tauEstimator: options.tauEstimator },
      heterogeneity: { q: core.q, df: core.df, pValue: core.qPValue, iSquared: core.iSquared, hSquared: core.hSquared, tauSquaredByEstimator: { derSimonianLaird: core.tauDl.value, pauleMandel: core.tauPm.value } },
      predictionInterval: core.prediction,
      leaveOneOut,
      egger,
      studyRows,
      rendererDataContract,
    },
    tests: [
      { name: "Cochran Q heterogeneity", statistic: core.q, distribution: "chi-square", df: core.df, pValue: core.qPValue },
      ...(egger.status === "evaluated" ? [{ name: "Egger regression intercept", statistic: egger.statistic, distribution: "t", df: egger.df, pValue: egger.pValue }] : []),
    ],
    confidenceIntervals: [
      { parameter: "fixed pooled effect", level: options.confidenceLevel, lower: core.fixed.lower, upper: core.fixed.upper, method: "normal inverse-variance" },
      { parameter: "random pooled effect", level: options.confidenceLevel, lower: core.random.lower, upper: core.random.upper, method: `normal inverse-variance with ${options.tauEstimator} tau-squared` },
      { parameter: "random-effects prediction interval", level: options.confidenceLevel, lower: core.prediction.lower, upper: core.prediction.upper, method: core.prediction.method },
    ],
    effectSizes: [
      { name: "fixed pooled effect", estimate: core.fixed.estimate },
      { name: "random pooled effect", estimate: core.random.estimate },
      { name: "I-squared", estimate: core.iSquared },
      { name: "tau-squared", estimate: core.selectedTau.value, estimator: options.tauEstimator },
    ],
    assumptions: [
      { name: "independent study estimates", status: "requires_design_review" },
      { name: "known within-study sampling variances", status: "assumed_from_supplied_standard_errors_or_variances" },
      { name: "common effect scale and direction", status: "requires_metadata_review", effectLabel: data.effectLabel },
      { name: "fixed-effect common true effect", status: options.metaModel === "random" ? "reported_for_reference" : "required_for_fixed_interpretation" },
      { name: "random-effects exchangeability", status: options.metaModel === "fixed" ? "reported_for_sensitivity" : "required_for_random_interpretation" },
    ],
    diagnostics: [
      { name: "heterogeneity", status: "evaluated", q: core.q, df: core.df, pValue: core.qPValue, iSquared: core.iSquared, hSquared: core.hSquared },
      { name: "tau-squared estimation", status: core.selectedTau.converged ? "converged" : "failed", estimator: options.tauEstimator, iterations: core.selectedTau.iterations, boundary: core.selectedTau.boundary, selected: core.selectedTau.value, derSimonianLaird: core.tauDl.value, pauleMandel: core.tauPm.value },
      egger,
      { name: "leave-one-out influence", status: "evaluated", omittedFits: leaveOneOut.length, boundary: "diagnostic sensitivity analysis only; it does not identify bias or justify exclusion" },
      { name: "prediction interval boundary", status: "normal_approximation", detail: "uses z critical value and tau-squared plus pooled-mean variance; no Hartung-Knapp, profile likelihood, bootstrap, or small-sample correction" },
      { name: "publication-bias boundary", status: "not_established", detail: "a funnel display and Egger screen cannot establish absence or presence of selective reporting" },
      { name: "renderer exact-data contract", status: "verified", ...rendererDataContract },
    ],
    artifacts: [
      tableArtifact("Meta-analysis pooled estimates", `${Math.round(options.confidenceLevel * 100)}% fixed and random-effects pooled estimates on the supplied ${data.effectLabel} scale.`, [{ key: "model", label: "Model", type: "string" }, { key: "estimate", label: "Estimate", type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "lower", label: "CI lower", type: "number" }, { key: "upper", label: "CI upper", type: "number" }, { key: "tauSquared", label: "Tau squared", type: "number" }, { key: "estimator", label: "Estimator", type: "string" }], summaryRows, ["Normal-approximation pooled intervals; inspect the heterogeneity, prediction-interval, and small-study diagnostics."], "meta-summary-table"),
      tableArtifact("Meta-analysis study estimates", "Exact supplied study effects, uncertainty, and normalized fixed/random inverse-variance weights.", [{ key: "study", label: "Study", type: "string" }, { key: "effect", label: data.effectLabel, type: "number" }, { key: "standardError", label: "SE", type: "number" }, { key: "variance", label: "Variance", type: "number" }, { key: "lower", label: "CI lower", type: "number" }, { key: "upper", label: "CI upper", type: "number" }, { key: "fixedWeightPercent", label: "Fixed weight (%)", type: "number" }, { key: "randomWeightPercent", label: "Random weight (%)", type: "number" }], studyRows, [`Rows sha256: ${sha256(studyRows)}. No sampling.`], "meta-study-table"),
      tableArtifact("Leave-one-out meta-analysis", "Each row omits exactly one named study and recomputes fixed and selected random-effects summaries.", [{ key: "omittedStudy", label: "Omitted study", type: "string" }, { key: "retainedStudies", label: "Retained studies", type: "number" }, { key: "fixedEffect", label: "Fixed effect", type: "number" }, { key: "fixedLower", label: "Fixed lower", type: "number" }, { key: "fixedUpper", label: "Fixed upper", type: "number" }, { key: "randomEffect", label: "Random effect", type: "number" }, { key: "randomLower", label: "Random lower", type: "number" }, { key: "randomUpper", label: "Random upper", type: "number" }, { key: "tauSquared", label: "Tau squared", type: "number" }, { key: "q", label: "Q", type: "number" }, { key: "deltaFixed", label: "Delta fixed", type: "number" }, { key: "deltaRandom", label: "Delta random", type: "number" }], leaveOneOut, ["Single-study retained fits have tau-squared fixed at zero; heterogeneity is undefined."], "meta-leave-one-out-table"),
      vegaArtifact("meta-analysis-forest", `Meta-analysis forest plot: ${data.effectLabel}`, { data: { values: forestRows }, layer: [{ mark: { type: "rule", strokeWidth: 2 }, encoding: { y: { field: "label", type: "ordinal", sort: null, title: null }, x: { field: "lower", type: "quantitative", title: data.effectLabel }, x2: { field: "upper" }, color: { field: "rowType", type: "nominal", legend: null } } }, { mark: { type: "point", filled: true, size: 85 }, encoding: { y: { field: "label", type: "ordinal", sort: null }, x: { field: "effect", type: "quantitative" }, color: { field: "rowType", type: "nominal", legend: null }, tooltip: [{ field: "label" }, { field: "effect", format: ".5g" }, { field: "lower", format: ".5g" }, { field: "upper", format: ".5g" }, { field: "randomWeightPercent", format: ".3g" }] } }, { mark: { type: "rule", strokeDash: [5, 4], color: "#7A7672" }, encoding: { x: { datum: data.nullValue } } }] }),
      vegaArtifact("meta-analysis-funnel", `Meta-analysis funnel plot: ${data.effectLabel}`, { data: { values: funnelRows }, layer: [{ mark: { type: "line", color: "#A36D47", strokeDash: [5, 4] }, encoding: { x: { field: "lowerPseudoLimit", type: "quantitative", title: data.effectLabel }, y: { field: "standardError", type: "quantitative", title: "Standard error", scale: { reverse: true } } } }, { mark: { type: "line", color: "#A36D47", strokeDash: [5, 4] }, encoding: { x: { field: "upperPseudoLimit", type: "quantitative" }, y: { field: "standardError", type: "quantitative", scale: { reverse: true } } } }, { mark: { type: "point", filled: true, size: 75 }, encoding: { x: { field: "effect", type: "quantitative" }, y: { field: "standardError", type: "quantitative", scale: { reverse: true } }, tooltip: [{ field: "study" }, { field: "effect", format: ".5g" }, { field: "standardError", format: ".5g" }] } }, { mark: { type: "rule", color: "#4E6E64" }, encoding: { x: { datum: core.random.estimate } } }] }),
      vegaArtifact("meta-analysis-influence", "Leave-one-out random-effects influence", { data: { values: influenceRows }, layer: [{ mark: { type: "bar" }, encoding: { x: { field: "omittedStudy", type: "nominal", title: "Omitted study" }, y: { field: "deltaRandom", type: "quantitative", title: "Change in pooled random effect" }, tooltip: [{ field: "omittedStudy" }, { field: "deltaRandom", format: ".5g" }, { field: "tauSquared", format: ".5g" }, { field: "q", format: ".5g" }] } }, { mark: { type: "rule", color: "#7A7672" }, encoding: { y: { datum: 0 } } }] }),
    ],
  };
}

function finalize(request, analysis) {
  for (const artifact of analysis.artifacts) validateArtifact(artifact);
  if (!analysis.diagnostics.some((diagnostic) => diagnostic?.name === "research-decision linkage")) {
    analysis.diagnostics.push(buildResearchDecisionLinkage(request.method, analysis.artifacts.map((artifact) => artifact.role)));
  }
  const requestHash = sha256(request);
  const artifactReceipts = analysis.artifacts.map((artifact, index) => ({ index, kind: artifact.kind, role: artifact.role, sha256: sha256(artifact), bytes: Buffer.byteLength(canonicalJson(artifact)) }));
  const inferenceReceipt = {
    schema: "agentlas.science.statistics.inference-receipt/v1",
    effectSizesHash: sha256(analysis.effectSizes),
    assumptionsHash: sha256(analysis.assumptions),
    diagnosticsHash: sha256(analysis.diagnostics),
  };
  const core = {
    schema: RESULT_SCHEMA,
    engine: ENGINE,
    method: request.method,
    status: "ok",
    requestHash,
    sample: analysis.sample,
    estimates: analysis.estimates,
    tests: analysis.tests,
    confidenceIntervals: analysis.confidenceIntervals,
    effectSizes: analysis.effectSizes,
    assumptions: analysis.assumptions,
    diagnostics: analysis.diagnostics,
    artifacts: analysis.artifacts,
    artifactReceipts,
    inferenceReceipt,
    limits: LIMITS,
  };
  const resultHash = sha256(core);
  const receiptCore = { schema: RECEIPT_SCHEMA, engine: ENGINE, method: request.method, requestHash, resultHash, artifactReceipts, inferenceReceipt };
  const receipt = { ...receiptCore, receiptId: sha256(receiptCore) };
  return { ...core, resultHash, receipt };
}

function analyze(rawRequest) {
  let requestBytes;
  try {
    requestBytes = Buffer.byteLength(canonicalJson(rawRequest));
  } catch (error) {
    if (error instanceof StatisticsError && error.code === "STAT_INTERNAL") {
      fail("STAT_INVALID_INPUT", "statistics request contains a non-finite number");
    }
    if (error instanceof StatisticsError) throw error;
    fail("STAT_INVALID_INPUT", "statistics request must be canonical JSON data");
  }
  if (requestBytes > LIMITS.maxRequestBytes) {
    fail(
      "STAT_LIMIT_EXCEEDED",
      `statistics request exceeds ${LIMITS.maxRequestBytes} bytes`,
      { requestBytes, maxRequestBytes: LIMITS.maxRequestBytes },
    );
  }
  const parsed = parseRequest(rawRequest);
  const budget = new Budget(parsed.options.timeoutMs);
  let analysis;
  switch (parsed.method) {
    case "descriptive": analysis = analyzeDescriptive(parsed.data, parsed.options, budget); break;
    case "distribution_fit": analysis = analyzeDistributionFit(parsed.data, parsed.options, budget); break;
    case "pearson_correlation":
    case "spearman_correlation":
    case "kendall_correlation": analysis = analyzeCorrelation(parsed.method, parsed.data, parsed.options, budget); break;
    case "independent_t_test":
    case "welch_t_test":
    case "paired_t_test": analysis = analyzeTTest(parsed.method, parsed.data, parsed.options, budget); break;
    case "one_way_anova": analysis = analyzeAnova(parsed.data, parsed.options, budget); break;
    case "welch_one_way_anova": analysis = analyzeWelchOneWayAnova(parsed.data, parsed.options, budget); break;
    case "two_way_anova": analysis = analyzeTwoWayAnova(parsed.data, parsed.options, budget); break;
    case "mann_whitney_u": analysis = analyzeMannWhitney(parsed.data, parsed.options, budget); break;
    case "wilcoxon_signed_rank": analysis = analyzeWilcoxon(parsed.data, parsed.options, budget); break;
    case "kruskal_wallis": analysis = analyzeKruskalWallis(parsed.data, parsed.options, budget); break;
    case "friedman_test": analysis = analyzeFriedman(parsed.data, parsed.options, budget); break;
    case "linear_regression": analysis = analyzeLinearRegression(parsed.data, parsed.options, budget); break;
    case "logistic_regression": analysis = analyzeLogisticRegression(parsed.data, parsed.options, budget); break;
    case "poisson_regression": analysis = analyzePoissonRegression(parsed.data, parsed.options, budget); break;
    case "chi_square_test": analysis = analyzeChiSquare(parsed.data, budget); break;
    case "fisher_exact_test": analysis = analyzeFisher(parsed.data, parsed.options, budget); break;
    case "multiple_testing_correction": analysis = analyzeMultipleTesting(parsed.data, parsed.options); break;
    case "confidence_interval": analysis = analyzeConfidenceInterval(parsed.data, parsed.options, budget); break;
    case "kaplan_meier": analysis = analyzeKaplanMeier(parsed.data, parsed.options, budget); break;
    case "log_rank_test": analysis = analyzeLogRank(parsed.data, parsed.options, budget); break;
    case "cox_proportional_hazards": analysis = analyzeCox(parsed.data, parsed.options, budget); break;
    case "principal_component_analysis": analysis = analyzePca(parsed.data, parsed.options, budget); break;
    case "time_series_diagnostics": analysis = analyzeTimeSeries(parsed.data, parsed.options, budget); break;
    case "roc_curve_analysis": analysis = analyzeRocCurve(parsed.data, parsed.options, budget); break;
    case "meta_analysis": analysis = analyzeMetaAnalysis(parsed.data, parsed.options, budget); break;
    case "response_surface_regression": analysis = analyzeResponseSurfaceRegression(parsed.data, parsed.options, budget); break;
    case "gaussian_random_intercept_lmm": analysis = analyzeGaussianRandomInterceptLmm(parsed.data, parsed.options, budget); break;
    default: {
      const definition = METHOD_REGISTRY.byMethod[parsed.method];
      if (!definition) fail("STAT_INTERNAL", "unreachable method dispatcher");
      analysis = definition.analyze(parsed.data, parsed.options, budget, HELPERS);
      assertAnalysisShape(analysis, parsed.method);
      break;
    }
  }
  return finalize(parsed, analysis);
}

function assertAnalysisShape(analysis, method) {
  if (!plainObject(analysis)) fail("STAT_INTERNAL", `${method} analysis must be an object`);
  for (const key of ["estimates", "tests", "confidenceIntervals", "effectSizes", "assumptions", "diagnostics", "artifacts"]) {
    if (!Array.isArray(analysis[key])) fail("STAT_INTERNAL", `${method} analysis.${key} must be an array`);
  }
  if (!plainObject(analysis.sample)) fail("STAT_INTERNAL", `${method} analysis.sample must be an object`);
  if (!analysis.artifacts.some((artifact) => artifact?.kind === "table") || !analysis.artifacts.some((artifact) => artifact?.kind === "vega-lite")) {
    fail("STAT_INTERNAL", `${method} must emit at least one table and one vega-lite artifact`);
  }
}

/**
 * Helper surface handed to registry method modules. Modules must never require engine.cjs
 * directly (circular load); everything numeric, validating, or artifact-building comes from here.
 */
const HELPERS = Object.freeze({
  MEASUREMENT_SCALE,
  LIMITS, TABLE_SCHEMA, VEGA_SCHEMA, NUMERIC_SURFACE_SOURCE_SCHEMA, StatisticsError, Budget,
  fail, plainObject, assertObject, assertKeys, assertExactKeys, label, optionalUnit, finiteNumber, integer,
  numericVector, categoryVector, regressionPredictors, canonicalize, canonicalJson, sha256, rawSha256,
  parseGroups, parseConditions, survivalCohort, survivalPredictors,
  sum, mean, variance, sorted, quantileR7, moments, descriptiveStats, averageRanks, correlation, minMax, histogram, bivariateBins,
  logGamma, betaContinuedFraction, regularizedBeta, gammaSeries, gammaContinuedFraction, gammaQ,
  normalCdf, normalInv, tCdf, tCritical, pFromT, pFromNormal, pFromF, pFromChiSquare, jarqueBera, logChoose,
  transpose, matMul, invert, matrixRank, matrixInfinityNorm, positiveDefiniteLogDeterminant, quadraticForm,
  symmetricEigenJacobi, covarianceMatrix, designMatrix, olsCore, leverageValues, sandwichCovariance, standardizePredictors,
  tableArtifact, vegaArtifact, summaryChart, validateArtifact, adjustedPValues, leveneDiagnostic, anovaCore,
  kaplanMeierCore, survivalRows, coxState, sigmoid, auc, trapezoidArea, finiteExp,
});

function publicError(error) {
  if (error instanceof StatisticsError) return { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
  return { code: "STAT_INTERNAL", message: "statistics engine failed unexpectedly" };
}

module.exports = {
  ENGINE,
  LIMITS,
  METHODS,
  CORE_METHODS,
  METHOD_REGISTRY,
  METHOD_OPTION_KEYS,
  SHARED_OPTION_KEYS,
  HELPERS,
  REQUEST_SCHEMA,
  RESULT_SCHEMA,
  RECEIPT_SCHEMA,
  TABLE_SCHEMA,
  StatisticsError,
  analyze,
  canonicalJson,
  publicError,
  sha256,
};
