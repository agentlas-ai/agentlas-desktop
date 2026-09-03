"use strict";

const { LIMITS, REQUEST_SCHEMA, METHOD_REGISTRY } = require("./engine.cjs");

const numberVector = (minimum = 2, binary = false) => ({
  type: "array",
  minItems: minimum,
  maxItems: LIMITS.maxVectorLength,
  items: binary ? { type: "integer", enum: [0, 1] } : { type: "number" },
});

const label = { type: "string", minLength: 1, maxLength: 128 };

const group = {
  type: "object",
  additionalProperties: false,
  required: ["values"],
  properties: { name: label, values: numberVector(2) },
};

const condition = {
  type: "object",
  additionalProperties: false,
  required: ["values"],
  properties: { name: label, values: numberVector(2) },
};

const numericPredictor = {
  type: "object",
  additionalProperties: false,
  required: ["name", "values"],
  properties: { name: label, type: { type: "string", enum: ["numeric"] }, values: numberVector(4) },
};

const categoricalPredictor = {
  type: "object",
  additionalProperties: false,
  required: ["name", "type", "values"],
  properties: {
    name: label,
    type: { const: "categorical" },
    values: { type: "array", minItems: 4, maxItems: LIMITS.maxVectorLength, items: label },
    reference: label,
  },
};

const predictor = { oneOf: [numericPredictor, categoricalPredictor] };

const optionProperties = Object.freeze({
  confidenceLevel: { type: "number", minimum: 0.5, exclusiveMaximum: 1 },
  alternative: { type: "string", enum: ["two-sided", "less", "greater"] },
  correction: { type: "string", enum: ["all", "bonferroni", "holm", "benjamini-hochberg", "benjamini-yekutieli"] },
  estimator: { type: "string", enum: ["mean", "proportion-wilson"] },
  intercept: { type: "boolean" },
  timeoutMs: { type: "integer", minimum: 1, maximum: LIMITS.maxTimeoutMs },
  maxIterations: { type: "integer", minimum: 1, maximum: LIMITS.maxIterations },
  tolerance: { type: "number", minimum: 1e-12, maximum: 1e-3 },
  ties: { type: "string", enum: ["efron", "breslow"] },
  postHoc: { type: "string", enum: ["none", "holm"] },
  covariance: { type: "string", enum: ["classical", "hc0", "hc1", "hc2", "hc3"] },
  pValueMethod: { type: "string", enum: ["auto", "exact", "asymptotic"] },
  scaling: { type: "string", enum: ["correlation", "covariance"] },
  components: { type: "integer", minimum: 1, maximum: LIMITS.maxPcaVariables },
  maxLag: { type: "integer", minimum: 1, maximum: LIMITS.maxTimeSeriesLag },
  differenceOrder: { type: "integer", enum: [0, 1] },
  metaModel: { type: "string", enum: ["fixed", "random", "both"] },
  tauEstimator: { type: "string", enum: ["der-simonian-laird", "paule-mandel"] },
  gridSize: { type: "integer", minimum: 11, maximum: LIMITS.maxResponseSurfaceGridSize, not: { multipleOf: 2 } },
  fitMethod: { type: "string", enum: ["ml", "reml"] },
});

function options(keys, required = []) {
  return {
    type: "object",
    additionalProperties: false,
    ...(required.length ? { required } : {}),
    properties: Object.fromEntries(keys.map((key) => [key, optionProperties[key]])),
  };
}

function data(properties, required) {
  return { type: "object", additionalProperties: false, required, properties };
}

function variant(method, dataSchema, optionKeys, optionRequired = []) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["schema", "method", "data"],
    properties: {
      schema: { const: REQUEST_SCHEMA },
      method: { const: method },
      data: dataSchema,
      options: options(optionKeys, optionRequired),
    },
  };
}

const pairedData = data({ x: numberVector(2), y: numberVector(2), xLabel: label, yLabel: label }, ["x", "y"]);
const correlationData = data({ x: numberVector(3), y: numberVector(3), xLabel: label, yLabel: label }, ["x", "y"]);
const twoGroups = data({ groups: { type: "array", minItems: 2, maxItems: 2, items: group } }, ["groups"]);
const manyGroups = data({ groups: { type: "array", minItems: 2, maxItems: LIMITS.maxGroups, items: group } }, ["groups"]);
const manyConditions = data({ conditions: { type: "array", minItems: 3, maxItems: LIMITS.maxGroups, items: condition } }, ["conditions"]);
const rocData = data({
  outcomes: { type: "array", minItems: 4, maxItems: LIMITS.maxRocRows, items: { type: "integer", enum: [0, 1] } },
  scores: { type: "array", minItems: 4, maxItems: LIMITS.maxRocRows, items: { type: "number" } },
  observationLabels: { type: "array", minItems: 4, maxItems: LIMITS.maxRocRows, items: label },
  outcomeLabel: label,
  scoreLabel: label,
}, ["outcomes", "scores"]);
const contingencyData = data({
  table: { type: "array", minItems: 2, maxItems: LIMITS.maxContingencyCells / 2, items: { type: "array", minItems: 2, maxItems: LIMITS.maxContingencyCells / 2, items: { type: "integer", minimum: 0 } } },
  rowLabels: { type: "array", minItems: 2, items: label },
  columnLabels: { type: "array", minItems: 2, items: label },
}, ["table"]);
const fisherData = data({
  table: { type: "array", minItems: 2, maxItems: 2, items: { type: "array", minItems: 2, maxItems: 2, items: { type: "integer", minimum: 0 } } },
  rowLabels: { type: "array", minItems: 2, maxItems: 2, items: label },
  columnLabels: { type: "array", minItems: 2, maxItems: 2, items: label },
}, ["table"]);

const poissonData = {
  type: "object",
  additionalProperties: false,
  required: ["y", "predictors"],
  properties: {
    y: { type: "array", minItems: 4, maxItems: LIMITS.maxPoissonRows, items: { type: "integer", minimum: 0 } },
    predictors: { type: "array", minItems: 1, maxItems: LIMITS.maxPredictors, items: predictor },
    outcomeLabel: label,
    exposure: { type: "array", minItems: 4, maxItems: LIMITS.maxPoissonRows, items: { type: "number", exclusiveMinimum: 0 } },
    logOffset: { type: "array", minItems: 4, maxItems: LIMITS.maxPoissonRows, items: { type: "number" } },
  },
  oneOf: [
    { not: { anyOf: [{ required: ["exposure"] }, { required: ["logOffset"] }] } },
    { required: ["exposure"], not: { required: ["logOffset"] } },
    { required: ["logOffset"], not: { required: ["exposure"] } },
  ],
};

const survivalTime = {
  type: "array",
  minItems: 2,
  maxItems: LIMITS.maxSurvivalRows,
  items: { type: "number", exclusiveMinimum: 0 },
};
const survivalEvent = {
  type: "array",
  minItems: 2,
  maxItems: LIMITS.maxSurvivalRows,
  items: { type: "integer", enum: [0, 1] },
};
const survivalGroup = {
  type: "object",
  additionalProperties: false,
  required: ["name", "time", "event"],
  properties: { name: label, time: survivalTime, event: survivalEvent },
};
const survivalPredictor = {
  type: "object",
  additionalProperties: false,
  required: ["name", "values"],
  properties: { name: label, values: numberVector(5) },
};

const pcaVariable = {
  type: "object",
  additionalProperties: false,
  required: ["name", "values"],
  properties: {
    name: label,
    values: { type: "array", minItems: 3, maxItems: LIMITS.maxPcaRows, items: { type: "number" } },
  },
};

const metaStudy = {
  type: "object",
  additionalProperties: false,
  required: ["effect"],
  properties: {
    label,
    effect: { type: "number" },
    standardError: { type: "number", exclusiveMinimum: 0 },
    variance: { type: "number", exclusiveMinimum: 0 },
  },
  oneOf: [
    { required: ["standardError"], not: { required: ["variance"] } },
    { required: ["variance"], not: { required: ["standardError"] } },
  ],
};

const responseSurfaceCoding = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "center", "halfRange"],
  properties: {
    kind: { const: "center-half-range-to-minus-one-one" },
    center: { type: "number" },
    halfRange: { type: "number", exclusiveMinimum: 0 },
  },
};

const responseSurfaceFactor = {
  type: "object",
  additionalProperties: false,
  required: ["name", "values", "coding"],
  properties: {
    name: label,
    unit: { type: "string", minLength: 1, maxLength: 80 },
    values: { type: "array", minItems: 9, maxItems: LIMITS.maxResponseSurfaceRows, items: { type: "number" } },
    coding: responseSurfaceCoding,
  },
};

const responseSurfaceResponse = {
  type: "object",
  additionalProperties: false,
  required: ["values"],
  properties: {
    name: label,
    unit: { type: "string", minLength: 1, maxLength: 80 },
    values: { type: "array", minItems: 9, maxItems: LIMITS.maxResponseSurfaceRows, items: { type: "number" } },
  },
};

const meanConfidenceVariant = variant("confidence_interval", data({ values: numberVector(2), label }, ["values"]), ["confidenceLevel", "estimator", "timeoutMs"]);
meanConfidenceVariant.properties.options.properties.estimator = { const: "mean" };
const proportionConfidenceVariant = variant("confidence_interval", data({ successes: { type: "integer", minimum: 0, maximum: LIMITS.maxVectorLength }, trials: { type: "integer", minimum: 1, maximum: LIMITS.maxVectorLength }, label }, ["successes", "trials"]), ["confidenceLevel", "estimator", "timeoutMs"], ["estimator"]);
proportionConfidenceVariant.properties.options.properties.estimator = { const: "proportion-wilson" };

const REQUEST_INPUT_SCHEMA = Object.freeze({
  oneOf: [
    variant("descriptive", data({ values: numberVector(2), label }, ["values"]), ["confidenceLevel", "timeoutMs"]),
    variant("distribution_fit", data({
      values: numberVector(8),
      candidates: { type: "array", minItems: 1, maxItems: 3, uniqueItems: true, items: { type: "string", enum: ["normal", "lognormal", "exponential"] } },
      label,
    }, ["values", "candidates"]), ["timeoutMs"]),
    variant("pearson_correlation", correlationData, ["confidenceLevel", "alternative", "timeoutMs"]),
    variant("spearman_correlation", correlationData, ["confidenceLevel", "alternative", "pValueMethod", "timeoutMs"]),
    variant("kendall_correlation", correlationData, ["confidenceLevel", "alternative", "pValueMethod", "timeoutMs"]),
    variant("independent_t_test", twoGroups, ["confidenceLevel", "alternative", "timeoutMs"]),
    variant("welch_t_test", twoGroups, ["confidenceLevel", "alternative", "timeoutMs"]),
    variant("paired_t_test", pairedData, ["confidenceLevel", "alternative", "timeoutMs"]),
    variant("one_way_anova", manyGroups, ["confidenceLevel", "postHoc", "timeoutMs"]),
    variant("welch_one_way_anova", manyGroups, ["confidenceLevel", "timeoutMs"]),
    variant("two_way_anova", data({
      y: numberVector(8),
      factorA: { type: "array", minItems: 8, maxItems: LIMITS.maxVectorLength, items: label },
      factorB: { type: "array", minItems: 8, maxItems: LIMITS.maxVectorLength, items: label },
      outcomeLabel: label,
      factorALabel: label,
      factorBLabel: label,
    }, ["y", "factorA", "factorB"]), ["confidenceLevel", "postHoc", "timeoutMs"]),
    variant("mann_whitney_u", twoGroups, ["confidenceLevel", "alternative", "pValueMethod", "timeoutMs"]),
    variant("wilcoxon_signed_rank", pairedData, ["alternative", "pValueMethod", "timeoutMs"]),
    variant("kruskal_wallis", manyGroups, ["confidenceLevel", "timeoutMs"]),
    variant("friedman_test", manyConditions, ["timeoutMs"]),
    variant("linear_regression", data({ y: numberVector(4), predictors: { type: "array", minItems: 1, maxItems: LIMITS.maxPredictors, items: predictor }, outcomeLabel: label }, ["y", "predictors"]), ["confidenceLevel", "intercept", "covariance", "timeoutMs"]),
    variant("logistic_regression", data({ y: numberVector(4, true), predictors: { type: "array", minItems: 1, maxItems: LIMITS.maxPredictors, items: predictor }, outcomeLabel: label }, ["y", "predictors"]), ["confidenceLevel", "intercept", "covariance", "timeoutMs", "maxIterations", "tolerance"]),
    variant("poisson_regression", poissonData, ["confidenceLevel", "intercept", "covariance", "timeoutMs", "maxIterations", "tolerance"]),
    variant("chi_square_test", contingencyData, ["timeoutMs"]),
    variant("fisher_exact_test", fisherData, ["confidenceLevel", "alternative", "timeoutMs"]),
    variant("multiple_testing_correction", data({ pValues: { type: "array", minItems: 1, maxItems: LIMITS.maxPValues, items: { type: "number", minimum: 0, maximum: 1 } }, labels: { type: "array", minItems: 1, maxItems: LIMITS.maxPValues, items: label } }, ["pValues"]), ["correction", "timeoutMs"]),
    meanConfidenceVariant,
    proportionConfidenceVariant,
    variant("kaplan_meier", data({ time: survivalTime, event: survivalEvent, label }, ["time", "event"]), ["confidenceLevel", "timeoutMs"]),
    variant("log_rank_test", data({ groups: { type: "array", minItems: 2, maxItems: 2, items: survivalGroup } }, ["groups"]), ["confidenceLevel", "timeoutMs"]),
    variant("cox_proportional_hazards", data({ time: { ...survivalTime, minItems: 5 }, event: { ...survivalEvent, minItems: 5 }, predictors: { type: "array", minItems: 1, maxItems: LIMITS.maxCoxPredictors, items: survivalPredictor }, outcomeLabel: label }, ["time", "event", "predictors"]), ["confidenceLevel", "timeoutMs", "maxIterations", "tolerance", "ties"]),
    variant("principal_component_analysis", data({
      variables: { type: "array", minItems: 2, maxItems: LIMITS.maxPcaVariables, items: pcaVariable },
      rowLabels: { type: "array", minItems: 3, maxItems: LIMITS.maxPcaRows, items: label },
    }, ["variables"]), ["scaling", "components", "timeoutMs"]),
    variant("time_series_diagnostics", data({
      values: { type: "array", minItems: 8, maxItems: LIMITS.maxTimeSeriesRows, items: { type: "number" } },
      time: { type: "array", minItems: 8, maxItems: LIMITS.maxTimeSeriesRows, items: { type: "number" } },
      seriesLabel: label,
      timeLabel: label,
    }, ["values"]), ["confidenceLevel", "maxLag", "differenceOrder", "timeoutMs"]),
    variant("roc_curve_analysis", rocData, ["timeoutMs"]),
    variant("meta_analysis", data({
      studies: { type: "array", minItems: 2, maxItems: LIMITS.maxMetaStudies, items: metaStudy },
      effectLabel: label,
      nullValue: { type: "number" },
    }, ["studies"]), ["confidenceLevel", "metaModel", "tauEstimator", "timeoutMs", "maxIterations", "tolerance"]),
    variant("response_surface_regression", data({
      response: responseSurfaceResponse,
      factors: { type: "array", minItems: 2, maxItems: 2, items: responseSurfaceFactor },
    }, ["response", "factors"]), ["confidenceLevel", "gridSize", "timeoutMs"]),
    variant("gaussian_random_intercept_lmm", data({
      y: { type: "array", minItems: 12, maxItems: LIMITS.maxLmmRows, items: { type: "number" } },
      groups: { type: "array", minItems: 12, maxItems: LIMITS.maxLmmRows, items: label },
      predictors: { type: "array", minItems: 0, maxItems: LIMITS.maxPredictors, items: predictor },
      observationLabels: { type: "array", minItems: 12, maxItems: LIMITS.maxLmmRows, items: label },
      outcomeLabel: label,
      groupLabel: label,
    }, ["y", "groups"]), ["confidenceLevel", "fitMethod", "intercept", "timeoutMs", "maxIterations", "tolerance"]),
    ...METHOD_REGISTRY.definitions.map((definition) => {
      const entry = variant(definition.method, definition.dataSchema, definition.optionKeys);
      for (const [key, spec] of Object.entries(definition.customOptions)) entry.properties.options.properties[key] = spec.schema;
      return entry;
    }),
  ],
});

module.exports = { REQUEST_INPUT_SCHEMA };
