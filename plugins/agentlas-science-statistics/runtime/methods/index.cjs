"use strict";

/**
 * Statistics method registry.
 *
 * Every family module under runtime/methods/ exports `{ methods: [...] }` where each
 * entry is a self-describing method definition. The engine, request contract, decision
 * linkage, and coverage manifest are all derived from this registry so a new method
 * never has to touch engine.cjs.
 *
 * Method definition shape (all fields required unless marked optional):
 *
 * {
 *   method: "tukey_hsd",                       // snake_case id, unique across core + extension
 *   family: "anova",                           // free-form family label used for grouping
 *   analysisModel: {                            // frozen AnalysisSpec compatibility (mirrored to shared/science-statistics.ts)
 *     families: ["lm"],                         // subset of SCIENCE_ANALYSIS_MODEL_FAMILIES
 *     distributions: [null, "normal"],          // accepted lower-cased distribution labels (null = unspecified)
 *     links: [null, "identity"],
 *   },
 *   optionKeys: ["confidenceLevel", "timeoutMs"],  // shared option keys the method accepts
 *   customOptions: {                            // optional; method-specific option keys
 *     adjustment: { schema: { type: "string", enum: ["tukey", "bonferroni"] }, default: "tukey", parse(value, H) { ... } },
 *   },
 *   dataSchema: { type: "object", additionalProperties: false, required: [...], properties: {...} },
 *   parse(data, options, H) -> parsedData,      // must reject unsupported keys with H.assertKeys and throw via H.fail
 *   analyze(parsedData, options, budget, H) -> { sample, estimates, tests, confidenceIntervals, effectSizes, assumptions, diagnostics, artifacts },
 *   linkage: { neededWhen, decision, mustShow, userGoal, nextActions: [{ trigger, action, reason }] },
 *   fixture: { data: {...}, options?: {...} },   // one canonical request used by product-level figure/table coverage contracts
 *   matlabParity: { taxonomyIds: ["matlab.stats.anova"] },   // MathWorks taxonomy rows this method maps to (analysis axis only)
 *   coverage: {
 *     implementedBoundary: "...",
 *     oracle: { level: "external-library-partial", evidence: ["contracts/<file>.py"], verifiedOutputs: [...], excludedOutputs: [...] },
 *     diagnostic: { level: "basic" | "method-specific-partial", emitted: [...], limitations: [...] },
 *     knownGaps: [...],
 *   },
 * }
 *
 * Modules must not require engine.cjs (circular). All numeric helpers arrive through `H`.
 */

const MODULE_FILES = Object.freeze([
  "anova-extended.cjs",
  "assumption-tests.cjs",
  "regression-extended.cjs",
  "time-series-extended.cjs",
  "power-analysis.cjs",
  "resampling.cjs",
  "bayesian.cjs",
  "multivariate-extended.cjs",
  "clustering.cjs",
  "distributions-extended.cjs",
  "survival-extended.cjs",
  "nonparametric-extended.cjs",
  "categorical-extended.cjs",
  "effect-sizes.cjs",
  "equivalence.cjs",
  "reliability.cjs",
  "causal-inference.cjs",
  "meta-analysis-extended.cjs",
  "quality-control.cjs",
  "missing-data.cjs",
  "diagnostic-accuracy.cjs",
  "mixed-models.cjs",
  "asset-pricing.cjs",
  "theil-sen-regression.cjs",
]);

const METHOD_ID_RE = /^[a-z][a-z0-9_]{2,63}$/;
const MATLAB_ANALYSIS_TAXONOMY = new Set(["matlab.stats.anova", "matlab.stats.classification", "matlab.stats.cluster-anomaly", "matlab.stats.descriptive-visualization", "matlab.stats.dimensionality-reduction-feature-extraction", "matlab.stats.hypothesis.dispersion", "matlab.stats.hypothesis.distribution", "matlab.stats.hypothesis.linear", "matlab.stats.hypothesis.location", "matlab.stats.industrial-statistics", "matlab.stats.machine-learning-pipelines", "matlab.stats.probability-hypothesis", "matlab.stats.regression"]);
const SHARED_OPTION_KEYS = new Set([
  "confidenceLevel", "alternative", "correction", "estimator", "intercept", "timeoutMs", "maxIterations", "tolerance",
  "ties", "postHoc", "covariance", "pValueMethod", "scaling", "components", "maxLag", "differenceOrder", "metaModel",
  "tauEstimator", "gridSize", "fitMethod",
]);

function invalid(file, message) {
  throw new Error(`statistics method module ${file}: ${message}`);
}

function assertStringArray(value, file, label, minimum = 1) {
  if (!Array.isArray(value) || value.length < minimum || value.some((item) => typeof item !== "string" || !item.trim())) {
    invalid(file, `${label} must be a non-empty string array`);
  }
}

function validateDefinition(definition, file, seen) {
  if (!definition || typeof definition !== "object") invalid(file, "method definition must be an object");
  const {
    method, family, analysisModel, optionKeys, customOptions, dataSchema, parse, analyze, linkage, coverage, fixture, matlabParity,
  } = definition;
  if (typeof method !== "string" || !METHOD_ID_RE.test(method)) invalid(file, `invalid method id ${String(method)}`);
  if (seen.has(method)) invalid(file, `duplicate method id ${method}`);
  if (typeof family !== "string" || !family.trim()) invalid(file, `${method}: family required`);
  if (!analysisModel || !Array.isArray(analysisModel.families) || !analysisModel.families.length
    || !Array.isArray(analysisModel.distributions) || !Array.isArray(analysisModel.links)) {
    invalid(file, `${method}: analysisModel { families, distributions, links } required`);
  }
  if (!Array.isArray(optionKeys) || optionKeys.some((key) => !SHARED_OPTION_KEYS.has(key))) {
    invalid(file, `${method}: optionKeys must only contain shared option keys`);
  }
  if (!optionKeys.includes("timeoutMs")) invalid(file, `${method}: optionKeys must include timeoutMs`);
  if (customOptions !== undefined) {
    if (!customOptions || typeof customOptions !== "object" || Array.isArray(customOptions)) invalid(file, `${method}: customOptions must be an object`);
    for (const [key, spec] of Object.entries(customOptions)) {
      if (SHARED_OPTION_KEYS.has(key) || !/^[a-z][A-Za-z0-9]{1,40}$/.test(key)) invalid(file, `${method}: custom option key ${key} is reserved or malformed`);
      if (!spec || typeof spec !== "object" || !spec.schema || typeof spec.parse !== "function") {
        invalid(file, `${method}: custom option ${key} needs { schema, default, parse }`);
      }
    }
  }
  if (!dataSchema || typeof dataSchema !== "object" || dataSchema.type !== "object" || dataSchema.additionalProperties !== false
    || !Array.isArray(dataSchema.required) || !dataSchema.properties || typeof dataSchema.properties !== "object") {
    invalid(file, `${method}: dataSchema must be a closed object schema with required[] and properties{}`);
  }
  if (typeof parse !== "function" || typeof analyze !== "function") invalid(file, `${method}: parse() and analyze() required`);
  if (!linkage || typeof linkage !== "object") invalid(file, `${method}: linkage required`);
  for (const key of ["neededWhen", "decision", "mustShow", "userGoal"]) {
    if (typeof linkage[key] !== "string" || linkage[key].length < 20) invalid(file, `${method}: linkage.${key} must be a sentence`);
  }
  if (!Array.isArray(linkage.nextActions) || !linkage.nextActions.length) invalid(file, `${method}: linkage.nextActions required`);
  for (const action of linkage.nextActions) {
    const keys = Object.keys(action).sort().join(",");
    if (keys !== "action,reason,trigger") invalid(file, `${method}: nextActions entries must be exactly { trigger, action, reason }`);
  }
  if (!coverage || typeof coverage !== "object") invalid(file, `${method}: coverage required`);
  if (typeof coverage.implementedBoundary !== "string" || coverage.implementedBoundary.length <= 20) invalid(file, `${method}: coverage.implementedBoundary required`);
  const oracle = coverage.oracle;
  if (!oracle || oracle.level !== "external-library-partial") invalid(file, `${method}: coverage.oracle.level must be external-library-partial`);
  assertStringArray(oracle.evidence, file, `${method}: coverage.oracle.evidence`);
  assertStringArray(oracle.verifiedOutputs, file, `${method}: coverage.oracle.verifiedOutputs`);
  assertStringArray(oracle.excludedOutputs, file, `${method}: coverage.oracle.excludedOutputs`);
  const diagnostic = coverage.diagnostic;
  if (!diagnostic || !["basic", "method-specific-partial"].includes(diagnostic.level)) invalid(file, `${method}: coverage.diagnostic.level invalid`);
  assertStringArray(diagnostic.emitted, file, `${method}: coverage.diagnostic.emitted`);
  assertStringArray(diagnostic.limitations, file, `${method}: coverage.diagnostic.limitations`);
  assertStringArray(coverage.knownGaps, file, `${method}: coverage.knownGaps`);
  if (!fixture || typeof fixture !== "object" || !fixture.data || typeof fixture.data !== "object") invalid(file, `${method}: fixture { data, options? } required`);
  if (!matlabParity || !Array.isArray(matlabParity.taxonomyIds) || !matlabParity.taxonomyIds.length
    || matlabParity.taxonomyIds.some((id) => !MATLAB_ANALYSIS_TAXONOMY.has(id)) || new Set(matlabParity.taxonomyIds).size !== matlabParity.taxonomyIds.length) {
    invalid(file, `${method}: matlabParity.taxonomyIds must list known matlab.stats.* taxonomy ids`);
  }
  seen.add(method);
  return Object.freeze({
    method,
    family,
    file,
    analysisModel: Object.freeze({
      families: Object.freeze([...analysisModel.families]),
      distributions: Object.freeze([...analysisModel.distributions]),
      links: Object.freeze([...analysisModel.links]),
    }),
    optionKeys: Object.freeze([...optionKeys]),
    customOptions: Object.freeze(customOptions ? { ...customOptions } : {}),
    dataSchema,
    parse,
    analyze,
    linkage: Object.freeze({ ...linkage, nextActions: Object.freeze(linkage.nextActions.map((item) => Object.freeze({ ...item }))) }),
    coverage,
    fixture: Object.freeze({ data: fixture.data, ...(fixture.options === undefined ? {} : { options: fixture.options }) }),
    matlabParity: Object.freeze({ taxonomyIds: Object.freeze([...matlabParity.taxonomyIds]) }),
  });
}

let cache = null;

function loadMethodRegistry() {
  if (cache) return cache;
  const seen = new Set();
  const definitions = [];
  const loadedFiles = [];
  for (const file of MODULE_FILES) {
    // A module named here but missing must stop the registry, not shrink it quietly. The require
    // below already throws in that case, and the verified in-memory loader that runs this file in
    // the product rejects a missing file and a symlink before it ever reaches here -- so the check
    // stays with the loader instead of a disk stat, which has no meaning inside that sandbox.
    let loaded;
    try { loaded = require(`./${file}`); }
    catch { invalid(file, "is declared in MODULE_FILES but could not be loaded"); }
    if (!loaded || !Array.isArray(loaded.methods) || !loaded.methods.length) invalid(file, "must export { methods: [...] }");
    for (const definition of loaded.methods) definitions.push(validateDefinition(definition, file, seen));
    loadedFiles.push(file);
  }
  const byMethod = Object.freeze(Object.fromEntries(definitions.map((definition) => [definition.method, definition])));
  const customOptionKeys = new Set();
  for (const definition of definitions) for (const key of Object.keys(definition.customOptions)) customOptionKeys.add(key);
  cache = Object.freeze({
    files: Object.freeze(loadedFiles),
    definitions: Object.freeze(definitions),
    byMethod,
    methods: Object.freeze(definitions.map((definition) => definition.method)),
    customOptionKeys: Object.freeze([...customOptionKeys].sort()),
  });
  return cache;
}

module.exports = { MODULE_FILES, loadMethodRegistry };
