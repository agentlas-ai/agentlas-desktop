"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { ENGINE, METHODS, sha256 } = require("./engine.cjs");

const COVERAGE_SCHEMA = "agentlas.science.statistics-coverage/v1";
const COVERAGE_FILE = "coverage-manifest.json";
const MAX_COVERAGE_BYTES = 2 * 1024 * 1024;

const INTERNAL_VERIFIED = Object.freeze([
  "deterministic numeric fixtures",
  "strict invalid-input rejection",
  "canonical result determinism",
]);

const INTERNAL_EXCLUDED = Object.freeze([
  "independent external implementation equivalence",
]);

// These registry modules currently have deterministic fixtures but no checked-in
// independent oracle bytes. They must not inherit the registry's normal
// `external-library-partial` claim merely because a proposed filename exists in
// method metadata. Adding a real oracle requires removing its exact id here and
// regenerating the coverage and integrity manifests in the same change.
const UNVERIFIED_REGISTRY_EVIDENCE = new Set([
  "contracts/bayesian-scipy-crosscheck.py",
  "contracts/causal-inference-scipy-crosscheck.py",
  "contracts/distributions-extended-scipy-crosscheck.py",
  "contracts/nonparametric-extended-scipy-crosscheck.py",
  "contracts/regression-extended-scipy-crosscheck.py",
]);

const oraclePolicy = Object.fromEntries(METHODS.map((method) => [method, Object.freeze({
  level: "internal-fixture-only",
  evidence: Object.freeze(["contracts/statistics-contract.cjs"]),
  verifiedOutputs: INTERNAL_VERIFIED,
  excludedOutputs: INTERNAL_EXCLUDED,
  independentlyCrossChecked: false,
})]));

const coreEvidence = Object.freeze(["contracts/core-scipy-crosscheck.py"]);

oraclePolicy.descriptive = Object.freeze({
  level: "external-library-partial", evidence: coreEvidence,
  verifiedOutputs: Object.freeze(["mean", "sample variance and standard deviation", "R-7 quartiles and median", "bias-corrected skewness and excess kurtosis", "Student-t mean confidence interval"]),
  excludedOutputs: Object.freeze(["Jarque-Bera p-value", "bootstrap or robust intervals", "weighted or missing-data summaries"]),
  independentlyCrossChecked: true,
});
oraclePolicy.distribution_fit = Object.freeze({
  level: "external-library-partial",
  evidence: Object.freeze(["contracts/distribution-fit-scipy-crosscheck.py"]),
  verifiedOutputs: Object.freeze([
    "normal, zero-location lognormal, and zero-location exponential maximum-likelihood parameters",
    "log likelihood, AIC, and BIC for every explicit candidate",
    "descriptive one-sample Kolmogorov-Smirnov D statistic with fitted parameters",
    "exact Q-Q and P-P renderer rows for every observation and candidate",
  ]),
  excludedOutputs: Object.freeze([
    "calibrated goodness-of-fit p-values or accept-reject decisions after parameter estimation",
    "confidence intervals for fitted parameters or information-criterion differences",
    "shifted-location, censored, truncated, mixture, discrete, heavy-tail, or custom probability families",
  ]),
  independentlyCrossChecked: true,
});
oraclePolicy.pearson_correlation = Object.freeze({
  level: "external-library-partial", evidence: coreEvidence,
  verifiedOutputs: Object.freeze(["Pearson coefficient", "two-sided t-reference p-value", "Fisher-transformed confidence interval"]),
  excludedOutputs: Object.freeze(["Jarque-Bera diagnostics", "linearity or bivariate-normality assessment", "partial, weighted, clustered, or robust correlation"]),
  independentlyCrossChecked: true,
});
oraclePolicy.independent_t_test = Object.freeze({
  level: "external-library-partial", evidence: coreEvidence,
  verifiedOutputs: Object.freeze(["pooled-variance t statistic", "degrees of freedom and two-sided p-value", "mean-difference confidence interval"]),
  excludedOutputs: Object.freeze(["Cohen d and Hedges g", "Brown-Forsythe and normality diagnostics", "directional alternatives"]),
  independentlyCrossChecked: true,
});
oraclePolicy.welch_t_test = Object.freeze({
  level: "external-library-partial", evidence: coreEvidence,
  verifiedOutputs: Object.freeze(["Welch t statistic", "Satterthwaite degrees of freedom and two-sided p-value", "mean-difference confidence interval"]),
  excludedOutputs: Object.freeze(["Cohen d and Hedges g", "Brown-Forsythe and normality diagnostics", "directional alternatives"]),
  independentlyCrossChecked: true,
});
oraclePolicy.paired_t_test = Object.freeze({
  level: "external-library-partial", evidence: coreEvidence,
  verifiedOutputs: Object.freeze(["paired-difference t statistic", "degrees of freedom and two-sided p-value", "paired mean-difference confidence interval"]),
  excludedOutputs: Object.freeze(["Cohen dz and Hedges correction", "paired-difference normality diagnostic", "directional alternatives"]),
  independentlyCrossChecked: true,
});
oraclePolicy.kruskal_wallis = Object.freeze({
  level: "external-library-partial", evidence: coreEvidence,
  verifiedOutputs: Object.freeze(["tie-corrected Kruskal-Wallis H statistic", "chi-square reference p-value"]),
  excludedOutputs: Object.freeze(["epsilon-squared effect", "post-hoc comparisons", "exact or permutation inference"]),
  independentlyCrossChecked: true,
});
const robustBlockedRocEvidence = Object.freeze(["contracts/robust-blocked-roc-scipy-crosscheck.py"]);

oraclePolicy.friedman_test = Object.freeze({
  level: "external-library-partial", evidence: robustBlockedRocEvidence,
  verifiedOutputs: Object.freeze(["tie-corrected Friedman chi-square statistic", "chi-square reference p-value", "condition rank sums and mean ranks", "Kendall W concordance"]),
  excludedOutputs: Object.freeze(["Iman-Davenport correction", "post-hoc comparisons", "incomplete-block inference"]),
  independentlyCrossChecked: true,
});
oraclePolicy.chi_square_test = Object.freeze({
  level: "external-library-partial", evidence: coreEvidence,
  verifiedOutputs: Object.freeze(["Pearson chi-square statistic", "degrees of freedom and p-value", "expected cell frequencies"]),
  excludedOutputs: Object.freeze(["standardized residuals", "Cramer's V", "small-expected-cell decision rule"]),
  independentlyCrossChecked: true,
});
oraclePolicy.fisher_exact_test = Object.freeze({
  level: "external-library-partial", evidence: coreEvidence,
  verifiedOutputs: Object.freeze(["sample odds ratio", "two-sided conditional-hypergeometric p-value"]),
  excludedOutputs: Object.freeze(["Wald log-odds confidence interval", "one-sided alternatives", "zero-cell interval boundaries"]),
  independentlyCrossChecked: true,
});
oraclePolicy.multiple_testing_correction = Object.freeze({
  level: "external-library-partial", evidence: coreEvidence,
  verifiedOutputs: Object.freeze(["Benjamini-Hochberg adjusted p-values", "Benjamini-Yekutieli adjusted p-values", "Bonferroni and Holm formula outputs"]),
  excludedOutputs: Object.freeze(["weighted procedures", "adaptive false-discovery procedures", "simultaneous confidence intervals"]),
  independentlyCrossChecked: true,
});
oraclePolicy.confidence_interval = Object.freeze({
  level: "external-library-partial", evidence: coreEvidence,
  verifiedOutputs: Object.freeze(["sample mean", "Student-t mean confidence interval", "Wilson score proportion confidence interval"]),
  excludedOutputs: Object.freeze(["bootstrap intervals", "exact binomial interval", "weighted, clustered, or finite-population intervals"]),
  independentlyCrossChecked: true,
});

const advancedEvidence = Object.freeze(["contracts/advanced-scipy-crosscheck.py"]);

oraclePolicy.spearman_correlation = Object.freeze({
  level: "external-library-partial", evidence: advancedEvidence,
  verifiedOutputs: Object.freeze(["Spearman coefficient", "exact no-tie permutation p-value"]),
  excludedOutputs: Object.freeze(["confidence interval", "tied exact inference", "partial rank correlation"]),
  independentlyCrossChecked: true,
});
oraclePolicy.kendall_correlation = Object.freeze({
  level: "external-library-partial", evidence: advancedEvidence,
  verifiedOutputs: Object.freeze(["Kendall tau-b coefficient", "exact no-tie permutation p-value"]),
  excludedOutputs: Object.freeze(["confidence interval", "large-sample tie-corrected p-value", "partial rank correlation"]),
  independentlyCrossChecked: true,
});
oraclePolicy.one_way_anova = Object.freeze({
  level: "external-library-partial", evidence: advancedEvidence,
  verifiedOutputs: Object.freeze(["omnibus F statistic", "omnibus p-value", "Holm-adjusted pairwise p-values"]),
  excludedOutputs: Object.freeze(["Brown-Forsythe diagnostic", "effect-size sampling intervals", "simultaneous contrast intervals"]),
  independentlyCrossChecked: true,
});
oraclePolicy.welch_one_way_anova = Object.freeze({
  level: "external-library-partial", evidence: robustBlockedRocEvidence,
  verifiedOutputs: Object.freeze(["Welch omnibus F statistic", "numerator and Satterthwaite denominator degrees of freedom", "omnibus p-value", "variance-weighted grand mean and per-group summaries"]),
  excludedOutputs: Object.freeze(["Games-Howell or other post-hoc comparisons", "effect-size estimates", "simultaneous confidence intervals"]),
  independentlyCrossChecked: true,
});
oraclePolicy.two_way_anova = Object.freeze({
  level: "independent-formula-partial", evidence: advancedEvidence,
  verifiedOutputs: Object.freeze(["balanced main-effect F statistics", "balanced interaction F statistic", "F-reference p-values"]),
  excludedOutputs: Object.freeze(["unbalanced sums of squares", "post-hoc contrast inference", "effect-size sampling intervals"]),
  independentlyCrossChecked: true,
});
oraclePolicy.mann_whitney_u = Object.freeze({
  level: "external-library-partial", evidence: advancedEvidence,
  verifiedOutputs: Object.freeze(["U statistic", "exact no-tie two-sided p-value"]),
  excludedOutputs: Object.freeze(["asymptotic tie-corrected p-value", "rank-biserial interval", "location-shift interval"]),
  independentlyCrossChecked: true,
});
oraclePolicy.wilcoxon_signed_rank = Object.freeze({
  level: "external-library-partial", evidence: advancedEvidence,
  verifiedOutputs: Object.freeze(["signed-rank statistic", "exact no-tie two-sided p-value"]),
  excludedOutputs: Object.freeze(["asymptotic tied p-value", "effect-size interval", "Pratt zero handling"]),
  independentlyCrossChecked: true,
});
oraclePolicy.linear_regression = Object.freeze({
  level: "independent-formula-partial", evidence: advancedEvidence,
  verifiedOutputs: Object.freeze(["OLS coefficients with treatment coding", "HC3 coefficient standard errors"]),
  excludedOutputs: Object.freeze(["HC0, HC1, and HC2 standard errors", "coefficient p-values and intervals", "diagnostic p-values"]),
  independentlyCrossChecked: true,
});
oraclePolicy.logistic_regression = Object.freeze({
  level: "independent-optimizer-partial", evidence: advancedEvidence,
  verifiedOutputs: Object.freeze(["maximum-likelihood coefficients with treatment coding", "HC1 coefficient standard errors"]),
  excludedOutputs: Object.freeze(["HC0, HC2, and HC3 standard errors", "Wald p-values and intervals", "calibration and influence diagnostics"]),
  independentlyCrossChecked: true,
});
oraclePolicy.poisson_regression = Object.freeze({
  level: "independent-optimizer-partial", evidence: Object.freeze(["contracts/poisson-scipy-crosscheck.py"]),
  verifiedOutputs: Object.freeze(["maximum-likelihood coefficients with treatment coding and exposure offset", "fitted means", "log likelihood", "deviance", "AIC", "HC0 through HC3 coefficient standard errors", "scikit-learn PoissonRegressor alpha-zero coefficient agreement"]),
  excludedOutputs: Object.freeze(["Wald p-values and intervals", "overdispersion decision limit", "influence diagnostics", "quasi-Poisson or negative-binomial equivalence"]),
  independentlyCrossChecked: true,
});

oraclePolicy.kaplan_meier = Object.freeze({
  level: "external-library-partial",
  evidence: Object.freeze(["contracts/survival-scipy-crosscheck.py"]),
  verifiedOutputs: Object.freeze([
    "survival probabilities",
    "pointwise log-log confidence intervals",
    "terminal survival boundary handling",
  ]),
  excludedOutputs: Object.freeze([
    "median-survival interval",
    "simultaneous confidence bands",
    "left-truncation behavior",
  ]),
  independentlyCrossChecked: true,
});

oraclePolicy.log_rank_test = Object.freeze({
  level: "independent-formula-partial",
  evidence: Object.freeze(["contracts/survival-scipy-crosscheck.py"]),
  verifiedOutputs: Object.freeze([
    "observed-minus-expected",
    "hypergeometric variance",
    "chi-square statistic",
    "chi-square p-value",
  ]),
  excludedOutputs: Object.freeze([
    "external survival-package implementation equivalence",
    "weighted log-rank variants",
    "stratified log-rank variants",
  ]),
  independentlyCrossChecked: true,
});

oraclePolicy.cox_proportional_hazards = Object.freeze({
  level: "independent-optimizer-partial",
  evidence: Object.freeze(["contracts/survival-scipy-crosscheck.py"]),
  verifiedOutputs: Object.freeze([
    "regression coefficients",
    "partial log-likelihood",
    "Efron and Breslow tie branches",
  ]),
  excludedOutputs: Object.freeze([
    "standard errors",
    "confidence intervals",
    "hazard ratios",
    "likelihood-ratio p-value",
    "proportional-hazards diagnostic",
  ]),
  independentlyCrossChecked: true,
});

const multivariateTimeSeriesEvidence = Object.freeze(["contracts/multivariate-timeseries-scipy-crosscheck.py"]);

oraclePolicy.principal_component_analysis = Object.freeze({
  level: "external-library-partial",
  evidence: multivariateTimeSeriesEvidence,
  verifiedOutputs: Object.freeze([
    "correlation and covariance eigenvalues",
    "explained-variance ratios",
    "deterministically signed eigenvector coefficients",
    "component loadings and exact scores",
    "Kaiser-Meyer-Olkin adequacy values",
    "Bartlett sphericity statistic and p-value",
  ]),
  excludedOutputs: Object.freeze([
    "component-retention uncertainty",
    "rotated, sparse, robust, probabilistic, or supervised PCA",
    "missing-data estimation",
  ]),
  independentlyCrossChecked: true,
});

oraclePolicy.time_series_diagnostics = Object.freeze({
  level: "external-library-partial",
  evidence: multivariateTimeSeriesEvidence,
  verifiedOutputs: Object.freeze([
    "centered-time OLS trend coefficient and standard error",
    "trend t-test p-value",
    "sample autocorrelation function",
    "Yule-Walker partial autocorrelation function",
    "Ljung-Box statistic and p-value",
    "first-difference values",
  ]),
  excludedOutputs: Object.freeze([
    "unit-root and stationarity tests",
    "ARIMA, state-space, spectral, seasonal, change-point, or forecast models",
    "irregular-time or missing-time inference",
  ]),
  independentlyCrossChecked: true,
});

oraclePolicy.roc_curve_analysis = Object.freeze({
  level: "independent-formula-partial",
  evidence: robustBlockedRocEvidence,
  verifiedOutputs: Object.freeze([
    "all distinct-threshold confusion counts and derived rates",
    "tie-aware rank and trapezoidal ROC area",
    "trapezoidal precision-recall area",
    "exact observation, threshold-table, ROC-curve, and precision-recall renderer rows",
  ]),
  excludedOutputs: Object.freeze([
    "DeLong, bootstrap, or other uncertainty intervals",
    "threshold optimization",
    "cross-validation or paired-model comparison",
  ]),
  independentlyCrossChecked: true,
});

oraclePolicy.meta_analysis = Object.freeze({
  level: "external-library-partial",
  evidence: Object.freeze(["contracts/meta-analysis-scipy-crosscheck.py"]),
  verifiedOutputs: Object.freeze([
    "fixed inverse-variance pooled estimate, standard error, and confidence interval",
    "Cochran Q, chi-square p-value, I-squared, and H-squared",
    "DerSimonian-Laird and Paule-Mandel tau-squared estimates",
    "selected random-effects pooled estimate and normal prediction interval",
    "leave-one-out fixed and random-effects summaries",
    "Egger intercept regression when mathematically eligible",
    "exact forest, funnel, and influence renderer rows",
  ]),
  excludedOutputs: Object.freeze([
    "Hartung-Knapp, profile-likelihood, bootstrap, or Bayesian uncertainty",
    "risk-ratio, odds-ratio, standardized-mean-difference, proportion, or diagnostic-test effect-size transformations",
    "multilevel, multivariate, network, individual-participant-data, or meta-regression models",
    "trim-and-fill, selection models, p-curve, PET-PEESE, or publication-bias conclusions",
  ]),
  independentlyCrossChecked: true,
});

oraclePolicy.response_surface_regression = Object.freeze({
  level: "external-library-partial",
  evidence: Object.freeze([
    "contracts/response-surface-contract.cjs",
    "contracts/response-surface-numpy-crosscheck.py",
  ]),
  verifiedOutputs: Object.freeze([
    "six-term two-factor quadratic OLS coefficients and classical covariance inference",
    "overall model F test and replicated pure-error lack-of-fit F test",
    "exact raw-unit prediction grid and source-order observed coordinates with residuals",
    "monotone-chain observed-domain convex hull and deterministic point support mask",
  ]),
  excludedOutputs: Object.freeze([
    "more than two factors, automatic term selection, transformations, ridge analysis, or desirability optimization",
    "robust, clustered, weighted, repeated-measures, mixed-effects, Bayesian, or missing-data inference",
    "surface uncertainty bands, simultaneous intervals, and extrapolation outside observed convex-hull support",
  ]),
  independentlyCrossChecked: true,
});

oraclePolicy.gaussian_random_intercept_lmm = Object.freeze({
  level: "independent-optimizer-partial",
  evidence: Object.freeze([
    "contracts/lmm-contract.cjs",
    "contracts/lmm-scipy-crosscheck.py",
    "contracts/lmm-scale-contract.cjs",
  ]),
  verifiedOutputs: Object.freeze([
    "ML and REML one-dimensional profile likelihood objectives for one Gaussian random intercept",
    "fixed-effect estimates, model-based standard errors, residual n-minus-p t statistics, p-values, and confidence intervals",
    "random-intercept and residual variance estimates, variance ratio, standard deviations, and ICC",
    "group BLUPs with plug-in conditional uncertainty, shrinkage, and exact conditional fitted and residual rows",
    "ten-thousand-row, five-hundred-group, thirty-two-fixed-predictor deterministic scale boundary with unsampled output rows",
  ]),
  excludedOutputs: Object.freeze([
    "executed MATLAB fitlme, R lme4, nlme, SAS, Stata, or another mixed-model package equivalence on this host",
    "Satterthwaite, Kenward-Roger, bootstrap, profile-likelihood, or boundary likelihood-ratio inference",
    "random slopes, multiple, nested, or crossed random effects, residual covariance structures, weights, GLMMs, nonlinear mixed effects, or missing-data estimation",
  ]),
  independentlyCrossChecked: true,
});

const { loadMethodRegistry } = require("./methods/index.cjs");
for (const definition of loadMethodRegistry().definitions) {
  const independentlyCrossChecked = definition.coverage.oracle.evidence.every(
    (item) => !UNVERIFIED_REGISTRY_EVIDENCE.has(item),
  );
  oraclePolicy[definition.method] = Object.freeze({
    level: independentlyCrossChecked ? definition.coverage.oracle.level : "internal-fixture-only",
    evidence: independentlyCrossChecked
      ? Object.freeze([...definition.coverage.oracle.evidence])
      : Object.freeze(["deterministic runtime fixture only"]),
    verifiedOutputs: independentlyCrossChecked
      ? Object.freeze([...definition.coverage.oracle.verifiedOutputs])
      : INTERNAL_VERIFIED,
    excludedOutputs: independentlyCrossChecked
      ? Object.freeze([...definition.coverage.oracle.excludedOutputs])
      : Object.freeze([...definition.coverage.oracle.excludedOutputs, ...INTERNAL_EXCLUDED]),
    independentlyCrossChecked,
  });
}
const ORACLE_POLICY = Object.freeze(oraclePolicy);
const REGISTRY_COVERAGE = Object.freeze(Object.fromEntries(loadMethodRegistry().definitions.map((definition) => [definition.method, definition.coverage])));

const METHOD_KEYS = Object.freeze([
  "method",
  "implementedBoundary",
  "oracleCoverage",
  "diagnosticCoverage",
  "knownGaps",
  "independentlyCrossChecked",
]);
const ORACLE_KEYS = Object.freeze(["level", "evidence", "verifiedOutputs", "excludedOutputs"]);
const DIAGNOSTIC_KEYS = Object.freeze(["level", "emitted", "limitations"]);
const ROOT_KEYS = Object.freeze(["schema", "engine", "support", "methods", "manifestSha256"]);
const ENGINE_KEYS = Object.freeze(["id", "version", "algorithmRevision"]);
const SUPPORT_KEYS = Object.freeze(["scope", "parity", "methodCount"]);
const DIAGNOSTIC_LEVELS = new Set(["basic", "method-specific-partial"]);
const FORBIDDEN_CLAIMS = [
  /\b(?:r|matlab|sas|stata)\s+(?:parity|equivalence|equivalent)\b/iu,
  /\b(?:complete|full|fully)\s+(?:parity|validation|validated|coverage)\b/iu,
  /\b(?:journal|regulatory)[ -]grade\b/iu,
];

class CoverageManifestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CoverageManifestError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new CoverageManifestError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys, label) {
  if (!isPlainObject(value)) fail("STAT_COVERAGE_SCHEMA", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("STAT_COVERAGE_SCHEMA", `${label} has unknown or missing fields`);
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > 2_000) {
    fail("STAT_COVERAGE_SCHEMA", `${label} must be a bounded non-empty string`);
  }
  for (const pattern of FORBIDDEN_CLAIMS) {
    if (pattern.test(value)) fail("STAT_COVERAGE_OVERCLAIM", `${label} contains a prohibited support claim`);
  }
}

function stringArray(value, label, { nonEmpty = true } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0) || value.length > 64) {
    fail("STAT_COVERAGE_SCHEMA", `${label} must be a bounded${nonEmpty ? " non-empty" : ""} string array`);
  }
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    nonEmptyString(item, `${label}[${index}]`);
    if (seen.has(item)) fail("STAT_COVERAGE_SCHEMA", `${label} contains duplicates`);
    seen.add(item);
  }
}

function sameStrings(actual, expected, label) {
  stringArray(actual, label);
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    fail("STAT_COVERAGE_OVERCLAIM", `${label} does not match the audited oracle policy`);
  }
}

function digestManifest(manifest) {
  if (!isPlainObject(manifest)) fail("STAT_COVERAGE_SCHEMA", "coverage manifest must be an object");
  const unsigned = { ...manifest };
  delete unsigned.manifestSha256;
  return sha256(unsigned);
}

function validateCoverageManifest(manifest) {
  exactKeys(manifest, ROOT_KEYS, "coverage manifest");
  if (manifest.schema !== COVERAGE_SCHEMA) fail("STAT_COVERAGE_SCHEMA", "unsupported coverage schema");

  exactKeys(manifest.engine, ENGINE_KEYS, "coverage engine");
  for (const key of ENGINE_KEYS) {
    if (manifest.engine[key] !== ENGINE[key]) fail("STAT_COVERAGE_ENGINE", `coverage engine ${key} does not match runtime`);
  }

  exactKeys(manifest.support, SUPPORT_KEYS, "coverage support");
  if (manifest.support.scope !== "bounded-method-subset" || manifest.support.parity !== "none" || manifest.support.methodCount !== METHODS.length) {
    fail("STAT_COVERAGE_OVERCLAIM", "coverage support declaration exceeds the audited boundary");
  }

  if (!Array.isArray(manifest.methods) || manifest.methods.length !== METHODS.length) {
    fail("STAT_COVERAGE_REGISTRY", "coverage methods must exactly cover the runtime registry");
  }
  const seen = new Set();
  for (const [index, entry] of manifest.methods.entries()) {
    exactKeys(entry, METHOD_KEYS, `methods[${index}]`);
    if (entry.method !== METHODS[index] || seen.has(entry.method) || !ORACLE_POLICY[entry.method]) {
      fail("STAT_COVERAGE_REGISTRY", "coverage method order and membership must exactly match the runtime registry");
    }
    seen.add(entry.method);
    nonEmptyString(entry.implementedBoundary, `${entry.method}.implementedBoundary`);
    stringArray(entry.knownGaps, `${entry.method}.knownGaps`);

    exactKeys(entry.oracleCoverage, ORACLE_KEYS, `${entry.method}.oracleCoverage`);
    const policy = ORACLE_POLICY[entry.method];
    if (entry.oracleCoverage.level !== policy.level) {
      fail("STAT_COVERAGE_OVERCLAIM", `${entry.method} oracle level exceeds or contradicts audited coverage`);
    }
    sameStrings(entry.oracleCoverage.evidence, policy.evidence, `${entry.method}.oracleCoverage.evidence`);
    sameStrings(entry.oracleCoverage.verifiedOutputs, policy.verifiedOutputs, `${entry.method}.oracleCoverage.verifiedOutputs`);
    sameStrings(entry.oracleCoverage.excludedOutputs, policy.excludedOutputs, `${entry.method}.oracleCoverage.excludedOutputs`);

    exactKeys(entry.diagnosticCoverage, DIAGNOSTIC_KEYS, `${entry.method}.diagnosticCoverage`);
    if (!DIAGNOSTIC_LEVELS.has(entry.diagnosticCoverage.level)) fail("STAT_COVERAGE_SCHEMA", `${entry.method} has an unknown diagnostic level`);
    stringArray(entry.diagnosticCoverage.emitted, `${entry.method}.diagnosticCoverage.emitted`);
    stringArray(entry.diagnosticCoverage.limitations, `${entry.method}.diagnosticCoverage.limitations`);

    if (entry.independentlyCrossChecked !== policy.independentlyCrossChecked) {
      fail("STAT_COVERAGE_OVERCLAIM", `${entry.method} independent cross-check flag contradicts audited coverage`);
    }
  }

  if (typeof manifest.manifestSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(manifest.manifestSha256)) {
    fail("STAT_COVERAGE_HASH", "coverage manifest hash is malformed");
  }
  const expected = digestManifest(manifest);
  if (manifest.manifestSha256 !== expected) fail("STAT_COVERAGE_HASH", "coverage manifest hash does not match content");
  return manifest;
}

function loadCoverageManifest(pluginRoot = path.resolve(__dirname, "..")) {
  const file = path.join(pluginRoot, COVERAGE_FILE);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_COVERAGE_BYTES) {
    fail("STAT_COVERAGE_IO", "coverage manifest must be a bounded regular file");
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail("STAT_COVERAGE_SCHEMA", "coverage manifest is not valid JSON");
  }
  return validateCoverageManifest(parsed);
}

module.exports = {
  COVERAGE_FILE,
  COVERAGE_SCHEMA,
  CoverageManifestError,
  ORACLE_POLICY,
  REGISTRY_COVERAGE,
  digestManifest,
  loadCoverageManifest,
  validateCoverageManifest,
};
