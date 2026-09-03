"use strict";

/**
 * Extended meta-analysis family: arm-level effect sizes, mixed-effects meta-regression (REML),
 * subgroup analysis, Duval-Tweedie trim-and-fill, Hartung-Knapp-Sidik-Jonkman intervals,
 * cumulative meta-analysis, and a bounded contrast-based frequentist network meta-analysis.
 *
 * Pure deterministic JavaScript. Every numeric helper arrives through `H`; nothing here requires
 * engine.cjs. Estimator definitions follow the ones documented for metafor / netmeta, but no
 * equivalence with those packages is claimed beyond the bounded oracle cross-check.
 */

const MAX_MODERATORS = 8;
const MAX_TREATMENTS = 12;
const MAX_COMPARISONS = 200;
const MAX_SUBGROUPS = 32;

const labelSchema = { type: "string", minLength: 1, maxLength: 128 };
const positive = { type: "number", exclusiveMinimum: 0 };

function studySchema(extraProperties = {}, extraRequired = []) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["effect", ...extraRequired],
    properties: { label: labelSchema, effect: { type: "number" }, standardError: positive, variance: positive, ...extraProperties },
  };
}

// ---------------------------------------------------------------------------------------------
// Shared numerics
// ---------------------------------------------------------------------------------------------

function normalSf(x, H) {
  return x >= 0 ? 0.5 * H.gammaQ(0.5, x * x / 2) : 1 - 0.5 * H.gammaQ(0.5, x * x / 2);
}

function twoSidedNormalP(z, H) {
  return Math.min(1, 2 * normalSf(Math.abs(z), H));
}

function zCritical(level, H) {
  return H.normalInv(1 - (1 - level) / 2);
}

function finite(value, H, what) {
  if (!Number.isFinite(value)) H.fail("STAT_NUMERIC_OVERFLOW", `${what} exceeded the numeric boundary`);
  return value;
}

function parseStudy(rawStudy, index, H, path, extraKeys = []) {
  const study = H.assertObject(rawStudy, path);
  H.assertKeys(study, ["label", "effect", "standardError", "variance", ...extraKeys], path);
  const label = H.label(study.label, `Study ${index + 1}`, `${path}.label`);
  const effect = H.finiteNumber(study.effect, `${path}.effect`);
  const hasStandardError = study.standardError !== undefined;
  const hasVariance = study.variance !== undefined;
  if (hasStandardError === hasVariance) H.fail("STAT_INVALID_INPUT", `${path} must contain exactly one of standardError or variance`);
  const variance = hasVariance ? H.finiteNumber(study.variance, `${path}.variance`) : Math.pow(H.finiteNumber(study.standardError, `${path}.standardError`), 2);
  if (!(variance > 0)) H.fail("STAT_INVALID_INPUT", `${path} variance must be positive`);
  const standardError = Math.sqrt(variance);
  if (!Number.isFinite(standardError) || !(standardError > 0)) H.fail("STAT_NUMERIC_OVERFLOW", `${path} standard error exceeds the numeric boundary`);
  return { label, effect, standardError, variance, raw: study };
}

function parseStudies(raw, H, { path = "data.studies", extraKeys = [], minimum = 2 } = {}) {
  if (!Array.isArray(raw) || raw.length < minimum || raw.length > H.LIMITS.maxMetaStudies) {
    H.fail("STAT_INVALID_INPUT", `${path} length must be between ${minimum} and ${H.LIMITS.maxMetaStudies}`);
  }
  const names = new Set();
  return raw.map((rawStudy, index) => {
    const study = parseStudy(rawStudy, index, H, `${path}[${index}]`, extraKeys);
    if (names.has(study.label)) H.fail("STAT_INVALID_INPUT", `${path} labels must be unique`);
    names.add(study.label);
    return study;
  });
}

function parseCommon(data, H) {
  return {
    effectLabel: H.label(data.effectLabel, "Effect", "data.effectLabel"),
    nullValue: data.nullValue === undefined ? 0 : H.finiteNumber(data.nullValue, "data.nullValue"),
  };
}

function pooled(studies, tauSquared, H, budget) {
  const weights = studies.map((study) => {
    budget.check();
    const weight = 1 / (study.variance + tauSquared);
    if (!Number.isFinite(weight) || !(weight > 0)) H.fail("STAT_NUMERIC_FAILURE", "meta-analysis produced an invalid inverse-variance weight");
    return weight;
  });
  const weightSum = H.sum(weights, budget);
  const estimate = H.sum(studies.map((study, index) => study.effect * weights[index]), budget) / weightSum;
  const standardError = Math.sqrt(1 / weightSum);
  const q = H.sum(studies.map((study, index) => weights[index] * Math.pow(study.effect - estimate, 2)), budget);
  if (![estimate, standardError, q].every(Number.isFinite)) H.fail("STAT_NUMERIC_OVERFLOW", "pooled estimate exceeded the numeric boundary");
  return { estimate, standardError, weights, weightSum, q };
}

function tauDerSimonianLaird(studies, H, budget) {
  if (studies.length < 2) return { value: 0, iterations: 0, converged: true, boundary: "single-study" };
  const fixed = pooled(studies, 0, H, budget);
  const df = studies.length - 1;
  const squaredWeightSum = H.sum(fixed.weights.map((weight) => weight * weight), budget);
  const denominator = fixed.weightSum - squaredWeightSum / fixed.weightSum;
  if (!(denominator > 0) || !Number.isFinite(denominator)) H.fail("STAT_NUMERIC_FAILURE", "DerSimonian-Laird denominator is not positive");
  return { value: Math.max(0, (fixed.q - df) / denominator), iterations: 0, converged: true, boundary: fixed.q <= df ? "zero" : "interior" };
}

function rootSearch(objective, initialHigh, options, H) {
  // objective is decreasing in tau-squared; find objective(tau2) = 0 on [0, inf).
  let low = 0;
  let high = Math.max(1e-12, initialHigh);
  let highValue = objective(high);
  let bracketIterations = 0;
  while (highValue > 0 && bracketIterations < options.maxIterations) {
    high *= 2;
    if (!Number.isFinite(high)) H.fail("STAT_NUMERIC_OVERFLOW", "tau-squared bracket exceeded the numeric boundary");
    highValue = objective(high);
    bracketIterations += 1;
  }
  if (highValue > 0) H.fail("STAT_NON_CONVERGENCE", "tau-squared bracketing did not converge");
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
  H.fail("STAT_NON_CONVERGENCE", "tau-squared root search did not converge");
}

function tauPauleMandel(studies, options, H, budget) {
  if (studies.length < 2) return { value: 0, iterations: 0, converged: true, boundary: "single-study" };
  const df = studies.length - 1;
  if (pooled(studies, 0, H, budget).q <= df) return { value: 0, iterations: 0, converged: true, boundary: "zero" };
  return rootSearch((tauSquared) => pooled(studies, tauSquared, H, budget).q - df, Math.max(...studies.map((study) => study.variance)), options, H);
}

function tauSquaredBy(studies, estimator, options, H, budget) {
  return estimator === "der-simonian-laird" ? tauDerSimonianLaird(studies, H, budget) : tauPauleMandel(studies, options, H, budget);
}

function randomEffectsSummary(studies, options, H, budget) {
  const critical = zCritical(options.confidenceLevel, H);
  const fixed = pooled(studies, 0, H, budget);
  const tau = tauSquaredBy(studies, options.tauEstimator, options, H, budget);
  const random = pooled(studies, tau.value, H, budget);
  const df = studies.length - 1;
  const iSquared = fixed.q > 0 ? Math.max(0, (fixed.q - df) / fixed.q) : 0;
  return {
    critical,
    fixed: { ...fixed, lower: fixed.estimate - critical * fixed.standardError, upper: fixed.estimate + critical * fixed.standardError },
    random: { ...random, lower: random.estimate - critical * random.standardError, upper: random.estimate + critical * random.standardError },
    tau,
    q: fixed.q,
    df,
    qPValue: df > 0 ? H.pFromChiSquare(fixed.q, df) : null,
    iSquared,
  };
}

function forestLayers(effectLabel, nullValue, colorField = "rowType") {
  return [
    { mark: { type: "rule", strokeWidth: 2 }, encoding: { y: { field: "label", type: "ordinal", sort: null, title: null }, x: { field: "lower", type: "quantitative", title: effectLabel }, x2: { field: "upper" }, color: { field: colorField, type: "nominal", title: colorField === "rowType" ? null : colorField } } },
    { mark: { type: "point", filled: true, size: 85 }, encoding: { y: { field: "label", type: "ordinal", sort: null }, x: { field: "effect", type: "quantitative" }, color: { field: colorField, type: "nominal" }, tooltip: [{ field: "label" }, { field: "effect", format: ".5g" }, { field: "lower", format: ".5g" }, { field: "upper", format: ".5g" }] } },
    { mark: { type: "rule", strokeDash: [5, 4], color: "#7A7672" }, encoding: { x: { datum: nullValue } } },
  ];
}


function estimateRows(object) {
  // Registry analyses must report estimates as an array; each named block becomes one row.
  return Object.entries(object).map(([name, value]) => (H_isPlain(value) ? { name, ...value } : { name, value }));
}

function H_isPlain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const numberColumn = (key, label) => ({ key, label, type: "number" });
const stringColumn = (key, label) => ({ key, label, type: "string" });

// ---------------------------------------------------------------------------------------------
// effect_size_from_arms
// ---------------------------------------------------------------------------------------------

const MEASURES = ["smd", "cohen-d", "log-odds-ratio", "log-risk-ratio", "risk-difference", "fisher-z"];
const CONTINUOUS = new Set(["smd", "cohen-d"]);
const BINARY = new Set(["log-odds-ratio", "log-risk-ratio", "risk-difference"]);

const armSchema = {
  type: "object",
  additionalProperties: false,
  required: ["n"],
  properties: { n: { type: "integer", minimum: 2 }, mean: { type: "number" }, sd: { type: "number", exclusiveMinimum: 0 }, events: { type: "integer", minimum: 0 } },
};

const effectSizeFromArms = {
  method: "effect_size_from_arms",
  family: "meta-analysis",
  analysisModel: { families: ["meta-analysis"], distributions: [null, "normal", "binomial"], links: [null, "identity", "logit", "log"] },
  optionKeys: ["confidenceLevel", "tauEstimator", "timeoutMs", "maxIterations", "tolerance"],
  customOptions: {
    measure: {
      schema: { type: "string", enum: MEASURES },
      default: "smd",
      parse(value, H, path) {
        if (!MEASURES.includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be one of ${MEASURES.join(", ")}`);
        return value;
      },
    },
    zeroCellCorrection: {
      schema: { type: "number", minimum: 0, maximum: 1 },
      default: 0.5,
      parse(value, H, path) {
        const parsed = H.finiteNumber(value, path);
        if (parsed < 0 || parsed > 1) H.fail("STAT_INVALID_INPUT", `${path} must be in [0, 1]`);
        return parsed;
      },
    },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["studies"],
    properties: {
      studies: {
        type: "array",
        minItems: 2,
        maxItems: 1000,
        items: {
          type: "object",
          additionalProperties: false,
          required: [],
          properties: { label: labelSchema, treatment: armSchema, control: armSchema, n: { type: "integer", minimum: 4 }, r: { type: "number", exclusiveMinimum: -1, exclusiveMaximum: 1 } },
        },
      },
      effectLabel: labelSchema,
      treatmentLabel: labelSchema,
      controlLabel: labelSchema,
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["studies", "effectLabel", "treatmentLabel", "controlLabel"], "data");
    if (!Array.isArray(data.studies) || data.studies.length < 2 || data.studies.length > H.LIMITS.maxMetaStudies) {
      H.fail("STAT_INVALID_INPUT", `data.studies length must be between 2 and ${H.LIMITS.maxMetaStudies}`);
    }
    const measure = options.measure;
    const names = new Set();
    const parseArm = (raw, path) => {
      const arm = H.assertObject(raw, path);
      H.assertKeys(arm, ["n", "mean", "sd", "events"], path);
      const n = H.integer(arm.n, 2, 10_000_000, `${path}.n`);
      if (CONTINUOUS.has(measure)) {
        if (arm.events !== undefined) H.fail("STAT_INVALID_INPUT", `${path}.events is not used by measure ${measure}`);
        const mean = H.finiteNumber(arm.mean, `${path}.mean`);
        const sd = H.finiteNumber(arm.sd, `${path}.sd`);
        if (!(sd > 0)) H.fail("STAT_INVALID_INPUT", `${path}.sd must be positive`);
        return { n, mean, sd };
      }
      if (arm.mean !== undefined || arm.sd !== undefined) H.fail("STAT_INVALID_INPUT", `${path}.mean/sd are not used by measure ${measure}`);
      const events = H.integer(arm.events, 0, n, `${path}.events`);
      return { n, events };
    };
    const studies = data.studies.map((rawStudy, index) => {
      const path = `data.studies[${index}]`;
      const study = H.assertObject(rawStudy, path);
      H.assertKeys(study, ["label", "treatment", "control", "n", "r"], path);
      const label = H.label(study.label, `Study ${index + 1}`, `${path}.label`);
      if (names.has(label)) H.fail("STAT_INVALID_INPUT", "data.studies labels must be unique");
      names.add(label);
      if (measure === "fisher-z") {
        if (study.treatment !== undefined || study.control !== undefined) H.fail("STAT_INVALID_INPUT", `${path} must supply n and r only for measure fisher-z`);
        const n = H.integer(study.n, 4, 10_000_000, `${path}.n`);
        const r = H.finiteNumber(study.r, `${path}.r`);
        if (!(r > -1 && r < 1)) H.fail("STAT_INVALID_INPUT", `${path}.r must lie strictly inside (-1, 1)`);
        return { label, n, r };
      }
      if (study.n !== undefined || study.r !== undefined) H.fail("STAT_INVALID_INPUT", `${path}.n/r are only used by measure fisher-z`);
      if (study.treatment === undefined || study.control === undefined) H.fail("STAT_INVALID_INPUT", `${path} must supply treatment and control arms`);
      return { label, treatment: parseArm(study.treatment, `${path}.treatment`), control: parseArm(study.control, `${path}.control`) };
    });
    return {
      studies,
      effectLabel: H.label(data.effectLabel, measure, "data.effectLabel"),
      treatmentLabel: H.label(data.treatmentLabel, "Treatment", "data.treatmentLabel"),
      controlLabel: H.label(data.controlLabel, "Control", "data.controlLabel"),
    };
  },
  analyze(parsed, options, budget, H) {
    const measure = options.measure;
    const critical = zCritical(options.confidenceLevel, H);
    let zeroCellStudies = 0;
    const rows = parsed.studies.map((study) => {
      budget.check();
      let effect;
      let variance;
      let detail = {};
      if (measure === "fisher-z") {
        effect = Math.atanh(study.r);
        variance = 1 / (study.n - 3);
        detail = { nTreatment: study.n, nControl: null, correction: null };
      } else if (CONTINUOUS.has(measure)) {
        const { treatment: t, control: c } = study;
        const df = t.n + c.n - 2;
        const pooledSd = Math.sqrt(((t.n - 1) * t.sd * t.sd + (c.n - 1) * c.sd * c.sd) / df);
        if (!(pooledSd > 0)) H.fail("STAT_DEGENERATE", `study ${study.label} has zero pooled standard deviation`);
        const d = (t.mean - c.mean) / pooledSd;
        const j = measure === "smd" ? 1 - 3 / (4 * df - 1) : 1;
        effect = j * d;
        variance = 1 / t.n + 1 / c.n + effect * effect / (2 * (t.n + c.n));
        detail = { nTreatment: t.n, nControl: c.n, correction: j };
      } else {
        let a = study.treatment.events;
        let b = study.treatment.n - study.treatment.events;
        let c = study.control.events;
        let d = study.control.n - study.control.events;
        const hasZero = [a, b, c, d].some((cell) => cell === 0);
        let correction = 0;
        if (hasZero && measure !== "risk-difference") {
          if (!(options.zeroCellCorrection > 0)) H.fail("STAT_DEGENERATE", `study ${study.label} has a zero cell and zeroCellCorrection is 0; ${measure} is undefined`);
          correction = options.zeroCellCorrection;
          zeroCellStudies += 1;
          a += correction; b += correction; c += correction; d += correction;
        }
        const n1 = a + b;
        const n2 = c + d;
        if (measure === "log-odds-ratio") {
          effect = Math.log((a * d) / (b * c));
          variance = 1 / a + 1 / b + 1 / c + 1 / d;
        } else if (measure === "log-risk-ratio") {
          effect = Math.log((a / n1) / (c / n2));
          variance = 1 / a - 1 / n1 + 1 / c - 1 / n2;
        } else {
          effect = a / n1 - c / n2;
          variance = a * b / Math.pow(n1, 3) + c * d / Math.pow(n2, 3);
          if (!(variance > 0)) H.fail("STAT_DEGENERATE", `study ${study.label} has zero risk-difference variance (all-or-none events in both arms)`);
        }
        detail = { nTreatment: study.treatment.n, nControl: study.control.n, correction: hasZero ? correction : 0 };
      }
      finite(effect, H, `effect for ${study.label}`);
      if (!(variance > 0) || !Number.isFinite(variance)) H.fail("STAT_DEGENERATE", `study ${study.label} yields a non-positive sampling variance`);
      const standardError = Math.sqrt(variance);
      return { study: study.label, effect, standardError, variance, lower: effect - critical * standardError, upper: effect + critical * standardError, ...detail };
    });
    const studies = rows.map((row) => ({ label: row.study, effect: row.effect, standardError: row.standardError, variance: row.variance }));
    const summary = randomEffectsSummary(studies, options, H, budget);
    const forestRows = [
      ...rows.map((row) => ({ rowType: "study", label: row.study, effect: row.effect, lower: row.lower, upper: row.upper })),
      { rowType: "pooled-fixed", label: "Pooled fixed effect", effect: summary.fixed.estimate, lower: summary.fixed.lower, upper: summary.fixed.upper },
      { rowType: "pooled-random", label: `Pooled random effect (${options.tauEstimator})`, effect: summary.random.estimate, lower: summary.random.lower, upper: summary.random.upper },
    ];
    const nullValue = measure === "risk-difference" || CONTINUOUS.has(measure) || measure === "fisher-z" ? 0 : 0;
    return {
      sample: { studies: rows.length, measure, effectLabel: parsed.effectLabel, zeroCellStudies },
      estimates: estimateRows({ studies: rows, fixed: { estimate: summary.fixed.estimate, standardError: summary.fixed.standardError, lower: summary.fixed.lower, upper: summary.fixed.upper }, random: { estimate: summary.random.estimate, standardError: summary.random.standardError, lower: summary.random.lower, upper: summary.random.upper, tauSquared: summary.tau.value, tauEstimator: options.tauEstimator }, heterogeneity: { q: summary.q, df: summary.df, pValue: summary.qPValue, iSquared: summary.iSquared } }),
      tests: [{ name: "Cochran Q heterogeneity", statistic: summary.q, distribution: "chi-square", df: summary.df, pValue: summary.qPValue }],
      confidenceIntervals: [
        ...rows.map((row) => ({ parameter: `${row.study} ${measure}`, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: "normal large-sample" })),
        { parameter: "random pooled effect", level: options.confidenceLevel, lower: summary.random.lower, upper: summary.random.upper, method: `normal inverse-variance with ${options.tauEstimator} tau-squared` },
      ],
      effectSizes: [...rows.map((row) => ({ name: `${row.study} ${measure}`, estimate: row.effect, standardError: row.standardError })), { name: `pooled random ${measure}`, estimate: summary.random.estimate }],
      assumptions: [
        { name: "independent studies with two independent arms (or one correlation each)", status: "requires_design_review" },
        { name: "large-sample normality of each study effect", status: "asymptotic", detail: "the large-sample variance formulas are used; small arms make the normal approximation coarse" },
        ...(CONTINUOUS.has(measure) ? [{ name: "equal population variances across arms for the pooled SD", status: "requires_design_review" }] : []),
      ],
      diagnostics: [
        { name: "effect-size formula", status: "declared", measure, formula: measure === "smd" ? "Hedges g = J * (m1 - m2) / pooled sd, J = 1 - 3 / (4 df - 1), var = 1/n1 + 1/n2 + g^2 / (2 (n1 + n2))" : measure === "cohen-d" ? "d = (m1 - m2) / pooled sd, var = 1/n1 + 1/n2 + d^2 / (2 (n1 + n2))" : measure === "log-odds-ratio" ? "log(ad / bc), var = 1/a + 1/b + 1/c + 1/d" : measure === "log-risk-ratio" ? "log((a/n1) / (c/n2)), var = 1/a - 1/n1 + 1/c - 1/n2" : measure === "risk-difference" ? "a/n1 - c/n2, var = ab/n1^3 + cd/n2^3" : "atanh(r), var = 1 / (n - 3)" },
        { name: "zero-cell handling", status: zeroCellStudies > 0 ? "applied" : "not_needed", correction: options.zeroCellCorrection, policy: "added to all four cells of studies that contain at least one zero cell (log OR / log RR only)", studiesAffected: zeroCellStudies },
        { name: "pooling boundary", status: "convenience_summary", detail: "fixed and random pooled rows reuse inverse-variance pooling; run meta_analysis for leave-one-out, funnel, and Egger diagnostics" },
      ],
      artifacts: [
        H.tableArtifact(`Study effect sizes: ${parsed.effectLabel}`, `Per-study ${measure} with large-sample standard errors and ${Math.round(options.confidenceLevel * 100)}% normal intervals.`, [stringColumn("study", "Study"), numberColumn("nTreatment", `n ${parsed.treatmentLabel}`), numberColumn("nControl", `n ${parsed.controlLabel}`), numberColumn("effect", parsed.effectLabel), numberColumn("standardError", "SE"), numberColumn("variance", "Variance"), numberColumn("lower", "CI lower"), numberColumn("upper", "CI upper"), numberColumn("correction", "Correction")], rows, ["Correction is the Hedges J factor for smd, the zero-cell constant for binary measures, and null for fisher-z."], "arm-effect-table"),
        H.tableArtifact("Pooled effect from arm-level data", "Inverse-variance fixed and random-effects summaries of the computed study effects.", [stringColumn("label", "Row"), stringColumn("rowType", "Type"), numberColumn("effect", parsed.effectLabel), numberColumn("lower", "CI lower"), numberColumn("upper", "CI upper")], forestRows, [], "arm-effect-pooled-table"),
        H.vegaArtifact("arm-effect-forest", `Forest plot: ${parsed.effectLabel}`, { data: { values: forestRows }, layer: forestLayers(parsed.effectLabel, nullValue) }),
      ],
    };
  },
  linkage: {
    neededWhen: "Studies report raw arm summaries (means and SDs, event counts, or correlations) and a common effect-size scale must be computed before pooling.",
    decision: "Whether each study's effect and sampling variance are usable on the chosen scale, and which studies needed zero-cell corrections or have implausible variances.",
    mustShow: "The per-study effect, standard error, and interval table plus the forest plot with fixed and random pooled rows and the declared formula.",
    userGoal: "Convert heterogeneous arm-level reports into one effect-size scale with honest sampling variances so a meta-analysis can be run.",
    nextActions: [
      { trigger: "zero-cell-correction-applied", action: "run-sensitivity-without-corrected-studies", reason: "Continuity corrections can shift pooled log odds ratios, so the pooled result should be checked without them." },
      { trigger: "heterogeneity-q-significant", action: "run-subgroup-or-meta-regression", reason: "Substantial between-study heterogeneity suggests moderators rather than a single common effect." },
      { trigger: "effects-computed", action: "run-meta-analysis-with-study-effects", reason: "The computed effects and variances feed the full meta-analysis with influence and funnel diagnostics." },
    ],
  },
  fixture: {
    data: {
      studies: [
        { label: "Aster", treatment: { n: 24, mean: 12.4, sd: 3.1 }, control: { n: 25, mean: 10.9, sd: 3.4 } },
        { label: "Birch", treatment: { n: 40, mean: 14.1, sd: 4.2 }, control: { n: 38, mean: 12.2, sd: 4.0 } },
        { label: "Cedar", treatment: { n: 18, mean: 11.0, sd: 2.9 }, control: { n: 20, mean: 11.3, sd: 3.0 } },
        { label: "Dogwood", treatment: { n: 55, mean: 13.6, sd: 3.8 }, control: { n: 52, mean: 12.0, sd: 3.6 } },
        { label: "Elm", treatment: { n: 30, mean: 12.9, sd: 3.3 }, control: { n: 31, mean: 11.1, sd: 3.5 } },
        { label: "Fir", treatment: { n: 22, mean: 12.2, sd: 3.0 }, control: { n: 21, mean: 11.9, sd: 2.8 } },
        { label: "Ginkgo", treatment: { n: 44, mean: 13.8, sd: 4.1 }, control: { n: 45, mean: 12.6, sd: 3.9 } },
        { label: "Hazel", treatment: { n: 27, mean: 12.7, sd: 3.2 }, control: { n: 26, mean: 11.4, sd: 3.3 } },
      ],
      effectLabel: "Hedges g",
    },
    options: { measure: "smd", tauEstimator: "der-simonian-laird" },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.location"] },
  coverage: {
    implementedBoundary: "Per-study SMD (Hedges g or Cohen d), log odds ratio, log risk ratio, risk difference, and Fisher z with large-sample variances from two-arm or correlation summaries, plus inverse-variance pooling.",
    oracle: { level: "external-library-partial", evidence: ["contracts/meta-analysis-extended-numpy-crosscheck.py"], verifiedOutputs: ["per-study effect", "per-study variance", "pooled fixed estimate", "pooled random estimate"], excludedOutputs: ["fisher-z pooling", "cluster-adjusted variances"] },
    diagnostic: { level: "method-specific-partial", emitted: ["effect-size formula", "zero-cell handling", "pooling boundary"], limitations: ["no small-sample exact variances", "no within-study correlation for multi-arm designs"] },
    knownGaps: ["pre/post change-score SMDs", "hazard ratios from survival summaries", "multi-arm studies sharing a control arm"],
  },
};

// ---------------------------------------------------------------------------------------------
// meta_regression (REML mixed-effects)
// ---------------------------------------------------------------------------------------------

function remlComponents(y, v, X, tauSquared, H, budget) {
  const k = y.length;
  const p = X[0].length;
  const w = v.map((value) => 1 / (value + tauSquared));
  const xtwx = Array.from({ length: p }, () => Array(p).fill(0));
  const xtwy = Array(p).fill(0);
  for (let i = 0; i < k; i += 1) {
    budget.check();
    for (let a = 0; a < p; a += 1) {
      xtwy[a] += w[i] * X[i][a] * y[i];
      for (let b = 0; b < p; b += 1) xtwx[a][b] += w[i] * X[i][a] * X[i][b];
    }
  }
  const covariance = H.invert(xtwx);
  const beta = covariance.map((row) => row.reduce((total, value, index) => total + value * xtwy[index], 0));
  const residuals = y.map((value, i) => value - X[i].reduce((total, x, index) => total + x * beta[index], 0));
  const weightedRss = residuals.reduce((total, r, i) => total + w[i] * r * r, 0);
  // tr(P) = sum w - tr(A M2), tr(P^2) = sum w^2 - 2 tr(A M3) + tr(A M2 A M2)
  const m2 = Array.from({ length: p }, () => Array(p).fill(0));
  const m3 = Array.from({ length: p }, () => Array(p).fill(0));
  let sumW = 0;
  let sumW2 = 0;
  for (let i = 0; i < k; i += 1) {
    budget.check();
    sumW += w[i];
    sumW2 += w[i] * w[i];
    for (let a = 0; a < p; a += 1) {
      for (let b = 0; b < p; b += 1) {
        m2[a][b] += w[i] * w[i] * X[i][a] * X[i][b];
        m3[a][b] += w[i] * w[i] * w[i] * X[i][a] * X[i][b];
      }
    }
  }
  const am2 = H.matMul(covariance, m2);
  const am3 = H.matMul(covariance, m3);
  const trace = (matrix) => matrix.reduce((total, row, index) => total + row[index], 0);
  const traceP = sumW - trace(am2);
  const tracePP = sumW2 - 2 * trace(am3) + trace(H.matMul(am2, am2));
  const pyNorm = residuals.reduce((total, r, i) => total + Math.pow(w[i] * r, 2), 0);
  const logDetXtwx = H.positiveDefiniteLogDeterminant(xtwx);
  const logLikelihood = -0.5 * w.reduce((total, weight) => total - Math.log(weight), 0) - 0.5 * logDetXtwx - 0.5 * weightedRss;
  const score = -0.5 * traceP + 0.5 * pyNorm;
  const information = 0.5 * tracePP;
  return { w, beta, covariance, residuals, weightedRss, traceP, logLikelihood, score, information, sumW, generalizedC: traceP };
}

function remlTauSquared(y, v, X, options, H, budget) {
  const k = y.length;
  const p = X[0].length;
  const df = k - p;
  if (df < 1) H.fail("STAT_INSUFFICIENT_SAMPLE", "meta-regression needs more studies than model coefficients");
  const at0 = remlComponents(y, v, X, 0, H, budget);
  const qe = at0.weightedRss;
  const dlStart = Math.max(0, (qe - df) / at0.generalizedC);
  if (at0.score <= 0) return { value: 0, iterations: 0, converged: true, boundary: "zero", logLikelihood: at0.logLikelihood, generalizedDl: dlStart };
  let tau = dlStart > 0 ? dlStart : Math.max(1e-8, H.mean(v, budget) * 1e-3);
  let current = remlComponents(y, v, X, tau, H, budget);
  let iterations = 0;
  let converged = false;
  let boundary = "interior";
  while (iterations < options.maxIterations) {
    iterations += 1;
    budget.check(64);
    if (!(current.information > 0)) H.fail("STAT_NUMERIC_FAILURE", "REML Fisher information is not positive");
    let step = current.score / current.information;
    let candidateTau = tau + step;
    let candidate = null;
    let halvings = 0;
    while (halvings < 60) {
      candidateTau = Math.max(0, tau + step);
      candidate = remlComponents(y, v, X, candidateTau, H, budget);
      if (candidate.logLikelihood >= current.logLikelihood - 1e-12) break;
      step /= 2;
      halvings += 1;
    }
    if (halvings >= 60) H.fail("STAT_NON_CONVERGENCE", "REML step halving could not increase the restricted likelihood");
    const change = Math.abs(candidateTau - tau);
    tau = candidateTau;
    current = candidate;
    if (tau === 0 && current.score <= 0) { converged = true; boundary = "zero"; break; }
    if (change <= options.tolerance * Math.max(1, tau) && Math.abs(current.score) <= Math.sqrt(options.tolerance) * Math.max(1, current.information)) { converged = true; break; }
  }
  if (!converged) H.fail("STAT_NON_CONVERGENCE", `REML tau-squared estimation did not converge in ${options.maxIterations} iterations`);
  return { value: tau, iterations, converged, boundary, logLikelihood: current.logLikelihood, generalizedDl: dlStart };
}

const metaRegression = {
  method: "meta_regression",
  family: "meta-analysis",
  analysisModel: { families: ["meta-analysis"], distributions: [null, "normal"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs", "maxIterations", "tolerance"],
  customOptions: {
    knappHartung: {
      schema: { type: "boolean" },
      default: false,
      parse(value, H, path) {
        if (typeof value !== "boolean") H.fail("STAT_INVALID_INPUT", `${path} must be boolean`);
        return value;
      },
    },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["studies", "moderators"],
    properties: {
      studies: { type: "array", minItems: 4, maxItems: 1000, items: studySchema() },
      moderators: { type: "array", minItems: 1, maxItems: MAX_MODERATORS, items: { type: "object", additionalProperties: false, required: ["name", "values"], properties: { name: labelSchema, values: { type: "array", minItems: 4, maxItems: 1000, items: { type: "number" } } } } },
      effectLabel: labelSchema,
      nullValue: { type: "number" },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["studies", "moderators", "effectLabel", "nullValue"], "data");
    const studies = parseStudies(data.studies, H, { minimum: 4 });
    if (!Array.isArray(data.moderators) || data.moderators.length < 1 || data.moderators.length > MAX_MODERATORS) {
      H.fail("STAT_INVALID_INPUT", `data.moderators length must be between 1 and ${MAX_MODERATORS}`);
    }
    const names = new Set();
    const moderators = data.moderators.map((raw, index) => {
      const path = `data.moderators[${index}]`;
      const moderator = H.assertObject(raw, path);
      H.assertKeys(moderator, ["name", "values"], path);
      const name = H.label(moderator.name, `M${index + 1}`, `${path}.name`);
      if (names.has(name)) H.fail("STAT_INVALID_INPUT", `duplicate moderator name: ${name}`);
      names.add(name);
      const values = H.numericVector(moderator.values, `${path}.values`, 4);
      if (values.length !== studies.length) H.fail("STAT_INVALID_INPUT", `moderator ${name} length does not match data.studies`);
      const range = H.minMax(values);
      if (range.min === range.max) H.fail("STAT_DEGENERATE", `moderator ${name} is constant`);
      return { name, values };
    });
    if (studies.length < moderators.length + 2) H.fail("STAT_INSUFFICIENT_SAMPLE", "meta_regression needs at least moderators + 2 studies");
    return { studies, moderators, ...parseCommon(data, H) };
  },
  analyze(parsed, options, budget, H) {
    const k = parsed.studies.length;
    const y = parsed.studies.map((study) => study.effect);
    const v = parsed.studies.map((study) => study.variance);
    const X = parsed.studies.map((_, i) => [1, ...parsed.moderators.map((moderator) => moderator.values[i])]);
    const p = X[0].length;
    if (H.matrixRank(X) < p) H.fail("STAT_RANK_DEFICIENT", "moderator design matrix is rank deficient");
    const tau = remlTauSquared(y, v, X, options, H, budget);
    const fit = remlComponents(y, v, X, tau.value, H, budget);
    const interceptOnly = remlTauSquared(y, v, parsed.studies.map(() => [1]), options, H, budget);
    const fixedFit = remlComponents(y, v, X, 0, H, budget);
    const df = k - p;
    const qe = fixedFit.weightedRss;
    const qePValue = H.pFromChiSquare(qe, df);
    const knapp = options.knappHartung;
    const scale = knapp ? fit.weightedRss / df : 1;
    if (knapp && !(scale > 0)) H.fail("STAT_DEGENERATE", "Knapp-Hartung scale factor is zero because the weighted residuals vanish");
    const covariance = fit.covariance.map((row) => row.map((value) => value * scale));
    const critical = knapp ? H.tCritical(options.confidenceLevel, df) : zCritical(options.confidenceLevel, H);
    const terms = ["intercept", ...parsed.moderators.map((moderator) => moderator.name)];
    const coefficients = fit.beta.map((estimate, index) => {
      const standardError = Math.sqrt(Math.max(0, covariance[index][index]));
      if (!(standardError > 0)) H.fail("STAT_DEGENERATE", `standard error is zero for ${terms[index]}`);
      const statistic = estimate / standardError;
      return { term: terms[index], estimate, standardError, statistic, pValue: knapp ? H.pFromT(statistic, df, "two-sided") : twoSidedNormalP(statistic, H), lower: estimate - critical * standardError, upper: estimate + critical * standardError };
    });
    // QM omnibus on the moderator coefficients (excluding intercept).
    const modIndex = Array.from({ length: p - 1 }, (_, i) => i + 1);
    const subCov = modIndex.map((a) => modIndex.map((b) => fit.covariance[a][b]));
    const subInv = H.invert(subCov);
    const subBeta = modIndex.map((index) => fit.beta[index]);
    const qm = H.quadraticForm(subBeta, subInv);
    const m = p - 1;
    const qmTest = knapp
      ? { name: "QM omnibus moderator test (Knapp-Hartung F)", statistic: qm / (m * scale), distribution: "F", df1: m, df2: df, pValue: H.pFromF(qm / (m * scale), m, df) }
      : { name: "QM omnibus moderator test", statistic: qm, distribution: "chi-square", df: m, pValue: H.pFromChiSquare(qm, m) };
    const rSquared = interceptOnly.value > 0 ? Math.max(0, Math.min(1, (interceptOnly.value - tau.value) / interceptOnly.value)) : null;
    const iSquaredResidual = qe > 0 ? Math.max(0, (qe - df) / qe) : 0;
    const sumW = fit.sumW;
    const studyRows = parsed.studies.map((study, i) => {
      const fitted = X[i].reduce((total, x, index) => total + x * fit.beta[index], 0);
      return { study: study.label, effect: study.effect, standardError: study.standardError, moderator: parsed.moderators[0].values[i], fitted, residual: study.effect - fitted, standardizedResidual: (study.effect - fitted) / Math.sqrt(study.variance + tau.value), weightPercent: 100 * fit.w[i] / sumW };
    });
    const coefficientRows = coefficients.map((row) => ({ ...row }));
    const bubbleLayers = [
      { mark: { type: "circle", opacity: 0.75 }, encoding: { x: { field: "moderator", type: "quantitative", title: parsed.moderators[0].name }, y: { field: "effect", type: "quantitative", title: parsed.effectLabel }, size: { field: "weightPercent", type: "quantitative", title: "Weight (%)" }, tooltip: [{ field: "study" }, { field: "effect", format: ".4g" }, { field: "moderator", format: ".4g" }, { field: "weightPercent", format: ".3g" }] } },
      ...(parsed.moderators.length === 1 ? [{ mark: { type: "line", color: "#4E6E64", strokeWidth: 2 }, encoding: { x: { field: "moderator", type: "quantitative" }, y: { field: "fitted", type: "quantitative" }, order: { field: "moderator" } } }] : []),
      { mark: { type: "rule", strokeDash: [5, 4], color: "#7A7672" }, encoding: { y: { datum: parsed.nullValue } } },
    ];
    return {
      sample: { studies: k, moderators: parsed.moderators.length, coefficients: p, residualDf: df, effectLabel: parsed.effectLabel },
      estimates: estimateRows({
        coefficients,
        tauSquared: tau.value,
        tauSquaredInterceptOnly: interceptOnly.value,
        rSquaredAnalog: rSquared,
        residualHeterogeneity: { qe, df, pValue: qePValue, iSquaredResidual },
        qm: { statistic: qm, df: m, pValue: H.pFromChiSquare(qm, m) },
        knappHartung: knapp ? { scale, df } : null,
        restrictedLogLikelihood: fit.logLikelihood,
        studyRows,
      }),
      tests: [qmTest, { name: "QE residual heterogeneity", statistic: qe, distribution: "chi-square", df, pValue: qePValue }, ...coefficients.map((row) => ({ name: `${knapp ? "t" : "Wald z"} test: ${row.term}`, statistic: row.statistic, distribution: knapp ? "t" : "normal", ...(knapp ? { df } : {}), pValue: row.pValue }))],
      confidenceIntervals: coefficients.map((row) => ({ parameter: row.term, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: knapp ? "Knapp-Hartung t" : "Wald normal" })),
      effectSizes: [...coefficients.slice(1).map((row) => ({ name: `${row.term} slope`, estimate: row.estimate, lower: row.lower, upper: row.upper })), { name: "tau-squared (REML)", estimate: tau.value }, { name: "R-squared analog", estimate: rSquared, estimable: rSquared !== null }],
      assumptions: [
        { name: "independent study estimates", status: "requires_design_review" },
        { name: "known within-study sampling variances", status: "assumed_from_supplied_standard_errors_or_variances" },
        { name: "linear moderator effects with normal random effects", status: "requires_model_review" },
        { name: "moderators measured without error at study level", status: "requires_design_review" },
      ],
      diagnostics: [
        { name: "REML tau-squared estimation", status: tau.converged ? "converged" : "failed", iterations: tau.iterations, boundary: tau.boundary, generalizedDerSimonianLaird: tau.generalizedDl, method: "Fisher scoring with step halving on the restricted log-likelihood" },
        { name: "residual heterogeneity", status: "evaluated", qe, df, pValue: qePValue, iSquaredResidual },
        { name: "R-squared analog boundary", status: rSquared === null ? "not_estimable" : "evaluated", detail: "(tau2 intercept-only - tau2 model) / tau2 intercept-only, truncated to [0, 1]; undefined when the intercept-only tau-squared is zero" },
        { name: "inference boundary", status: knapp ? "knapp_hartung_t" : "asymptotic_normal", detail: knapp ? "coefficient tests use t with k - p df and the Knapp-Hartung scale without truncation at one" : "Wald z tests; enable knappHartung for small-k inference" },
        { name: "collinearity", status: "screened", designRank: p, note: "rank-deficient designs are rejected before fitting" },
      ],
      artifacts: [
        H.tableArtifact(`Meta-regression coefficients: ${parsed.effectLabel}`, `REML mixed-effects meta-regression with ${knapp ? "Knapp-Hartung t" : "Wald normal"} inference.`, [stringColumn("term", "Term"), numberColumn("estimate", "Estimate"), numberColumn("standardError", "SE"), numberColumn("statistic", knapp ? "t" : "z"), numberColumn("pValue", "p"), numberColumn("lower", "CI lower"), numberColumn("upper", "CI upper")], coefficientRows, [`tau-squared (REML) = ${tau.value}; QE(${df}) = ${qe}; R-squared analog = ${rSquared === null ? "not estimable" : rSquared}.`], "meta-regression-coefficient-table"),
        H.tableArtifact("Meta-regression study rows", "Observed effects, fitted values, standardized residuals, and random-effects weights.", [stringColumn("study", "Study"), numberColumn("effect", parsed.effectLabel), numberColumn("standardError", "SE"), numberColumn("moderator", parsed.moderators[0].name), numberColumn("fitted", "Fitted"), numberColumn("residual", "Residual"), numberColumn("standardizedResidual", "Standardized residual"), numberColumn("weightPercent", "Weight (%)")], studyRows, ["Fitted values use all moderators; the moderator column shows the first moderator only."], "meta-regression-study-table"),
        H.vegaArtifact("meta-regression-bubble", `Meta-regression bubble plot: ${parsed.effectLabel} versus ${parsed.moderators[0].name}`, { data: { values: studyRows }, layer: bubbleLayers }),
      ],
    };
  },
  linkage: {
    neededWhen: "Between-study heterogeneity may be explained by study-level numeric moderators such as dose, year, or baseline risk.",
    decision: "Whether the moderators explain heterogeneity (QM), how much residual heterogeneity remains (QE, tau-squared), and the direction of each slope.",
    mustShow: "The coefficient table with intervals, the residual-heterogeneity test, the R-squared analog, and the bubble plot against the first moderator.",
    userGoal: "Explain why study effects differ instead of only averaging them, with an honest account of residual heterogeneity.",
    nextActions: [
      { trigger: "few-studies-per-moderator", action: "enable-knapp-hartung-or-drop-moderators", reason: "Fewer than ten studies per moderator makes Wald z inference anti-conservative in meta-regression." },
      { trigger: "residual-heterogeneity-large", action: "report-prediction-interval-and-search-moderators", reason: "Large QE means the moderators leave most heterogeneity unexplained and the slopes should not be over-read." },
      { trigger: "influential-study-detected", action: "refit-without-influential-study", reason: "A single high-weight study with a large standardized residual can drive a moderator slope." },
    ],
  },
  fixture: {
    data: {
      studies: [
        { label: "Aster", effect: 0.02, standardError: 0.08 }, { label: "Birch", effect: 0.61, variance: 0.0144 }, { label: "Cedar", effect: -0.18, standardError: 0.09 }, { label: "Dogwood", effect: 0.12, variance: 0.0121 },
        { label: "Elm", effect: 0.85, standardError: 0.12 }, { label: "Fir", effect: 0.24, variance: 0.0100 }, { label: "Ginkgo", effect: 0.21, standardError: 0.10 }, { label: "Hazel", effect: 0.49, variance: 0.0169 },
        { label: "Iris", effect: 0.37, standardError: 0.11 }, { label: "Juniper", effect: 0.33, variance: 0.0196 },
      ],
      moderators: [{ name: "dose", values: [10, 30, 5, 20, 40, 8, 25, 15, 35, 12] }],
      effectLabel: "log response ratio",
      nullValue: 0,
    },
    options: { knappHartung: false },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "Mixed-effects meta-regression with numeric moderators, REML tau-squared by Fisher scoring, Wald or Knapp-Hartung inference, QM omnibus, QE residual heterogeneity, and an R-squared analog.",
    oracle: { level: "external-library-partial", evidence: ["contracts/meta-analysis-extended-numpy-crosscheck.py"], verifiedOutputs: ["REML tau-squared", "coefficients", "standard errors", "QM", "QE", "Knapp-Hartung scale"], excludedOutputs: ["categorical moderators", "permutation tests", "profile-likelihood tau-squared intervals"] },
    diagnostic: { level: "method-specific-partial", emitted: ["REML convergence", "residual heterogeneity", "R-squared analog boundary", "inference boundary", "collinearity"], limitations: ["no influence or leave-one-out diagnostics", "no multilevel or multivariate structures"] },
    knownGaps: ["categorical moderators require manual dummy coding by the caller", "ML, HS, SJ, and EB tau-squared estimators", "robust variance estimation"],
  },
};

// ---------------------------------------------------------------------------------------------
// subgroup_meta_analysis
// ---------------------------------------------------------------------------------------------

const subgroupMetaAnalysis = {
  method: "subgroup_meta_analysis",
  family: "meta-analysis",
  analysisModel: { families: ["meta-analysis"], distributions: [null, "normal"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "tauEstimator", "timeoutMs", "maxIterations", "tolerance"],
  customOptions: {
    tauModel: {
      schema: { type: "string", enum: ["separate", "common"] },
      default: "separate",
      parse(value, H, path) {
        if (!["separate", "common"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be separate or common`);
        return value;
      },
    },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["studies"],
    properties: {
      studies: { type: "array", minItems: 4, maxItems: 1000, items: studySchema({ subgroup: labelSchema }, ["subgroup"]) },
      effectLabel: labelSchema,
      nullValue: { type: "number" },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["studies", "effectLabel", "nullValue"], "data");
    const studies = parseStudies(data.studies, H, { extraKeys: ["subgroup"], minimum: 4 }).map((study, index) => {
      if (study.raw.subgroup === undefined) H.fail("STAT_INVALID_INPUT", `data.studies[${index}].subgroup is required`);
      return { label: study.label, effect: study.effect, standardError: study.standardError, variance: study.variance, subgroup: H.label(study.raw.subgroup, "", `data.studies[${index}].subgroup`) };
    });
    const subgroups = [...new Set(studies.map((study) => study.subgroup))];
    if (subgroups.length < 2) H.fail("STAT_INVALID_INPUT", "subgroup_meta_analysis needs at least two distinct subgroups");
    if (subgroups.length > MAX_SUBGROUPS) H.fail("STAT_LIMIT_EXCEEDED", `subgroup_meta_analysis supports at most ${MAX_SUBGROUPS} subgroups`);
    return { studies, subgroups, ...parseCommon(data, H) };
  },
  analyze(parsed, options, budget, H) {
    const critical = zCritical(options.confidenceLevel, H);
    const groups = parsed.subgroups.map((name) => ({ name, studies: parsed.studies.filter((study) => study.subgroup === name) }));
    const k = parsed.studies.length;
    const G = groups.length;
    let commonTau = null;
    if (options.tauModel === "common") {
      const withinDf = k - G;
      const qWithinAt = (tauSquared) => groups.reduce((total, group) => total + (group.studies.length > 1 ? pooled(group.studies, tauSquared, H, budget).q : 0), 0);
      if (withinDf < 1) H.fail("STAT_INSUFFICIENT_SAMPLE", "common tau-squared needs more studies than subgroups");
      if (options.tauEstimator === "der-simonian-laird") {
        const c = groups.reduce((total, group) => {
          if (group.studies.length < 2) return total;
          const fixed = pooled(group.studies, 0, H, budget);
          return total + fixed.weightSum - H.sum(fixed.weights.map((weight) => weight * weight), budget) / fixed.weightSum;
        }, 0);
        const qWithin = qWithinAt(0);
        commonTau = { value: Math.max(0, (qWithin - withinDf) / c), iterations: 0, converged: true, boundary: qWithin <= withinDf ? "zero" : "interior" };
      } else if (qWithinAt(0) <= withinDf) commonTau = { value: 0, iterations: 0, converged: true, boundary: "zero" };
      else commonTau = rootSearch((tauSquared) => qWithinAt(tauSquared) - withinDf, Math.max(...parsed.studies.map((study) => study.variance)), options, H);
    }
    const subgroupRows = groups.map((group) => {
      const fixed = pooled(group.studies, 0, H, budget);
      const tau = options.tauModel === "common" ? commonTau : tauSquaredBy(group.studies, options.tauEstimator, options, H, budget);
      const random = pooled(group.studies, tau.value, H, budget);
      const df = group.studies.length - 1;
      return { subgroup: group.name, studies: group.studies.length, fixedEffect: fixed.estimate, randomEffect: random.estimate, standardError: random.standardError, lower: random.estimate - critical * random.standardError, upper: random.estimate + critical * random.standardError, tauSquared: tau.value, q: fixed.q, df, qPValue: df > 0 ? H.pFromChiSquare(fixed.q, df) : null, iSquared: df > 0 && fixed.q > 0 ? Math.max(0, (fixed.q - df) / fixed.q) : 0 };
    });
    const betweenWeights = subgroupRows.map((row) => 1 / (row.standardError * row.standardError));
    const betweenWeightSum = H.sum(betweenWeights, budget);
    const combined = H.sum(subgroupRows.map((row, index) => row.randomEffect * betweenWeights[index]), budget) / betweenWeightSum;
    const qBetween = H.sum(subgroupRows.map((row, index) => betweenWeights[index] * Math.pow(row.randomEffect - combined, 2)), budget);
    const qBetweenP = H.pFromChiSquare(qBetween, G - 1);
    const qWithin = H.sum(subgroupRows.map((row) => row.q), budget);
    const withinDf = k - G;
    const overall = randomEffectsSummary(parsed.studies, options, H, budget);
    const combinedSe = Math.sqrt(1 / betweenWeightSum);
    const studyRows = parsed.studies.map((study) => ({ study: study.label, subgroup: study.subgroup, effect: study.effect, standardError: study.standardError, lower: study.effect - critical * study.standardError, upper: study.effect + critical * study.standardError }));
    const forestRows = [];
    for (const row of subgroupRows) {
      for (const study of studyRows.filter((item) => item.subgroup === row.subgroup)) forestRows.push({ rowType: "study", subgroup: row.subgroup, label: study.study, effect: study.effect, lower: study.lower, upper: study.upper });
      forestRows.push({ rowType: "subgroup-pooled", subgroup: row.subgroup, label: `Pooled: ${row.subgroup}`, effect: row.randomEffect, lower: row.lower, upper: row.upper });
    }
    forestRows.push({ rowType: "overall", subgroup: "All", label: "Overall random effect", effect: overall.random.estimate, lower: overall.random.lower, upper: overall.random.upper });
    return {
      sample: { studies: k, subgroups: G, tauModel: options.tauModel, effectLabel: parsed.effectLabel },
      estimates: estimateRows({ subgroups: subgroupRows, betweenSubgroup: { q: qBetween, df: G - 1, pValue: qBetweenP, combinedEstimate: combined, combinedStandardError: combinedSe }, withinSubgroup: { q: qWithin, df: withinDf, pValue: withinDf > 0 ? H.pFromChiSquare(qWithin, withinDf) : null }, commonTauSquared: commonTau ? commonTau.value : null, overall: { estimate: overall.random.estimate, standardError: overall.random.standardError, lower: overall.random.lower, upper: overall.random.upper, tauSquared: overall.tau.value }, studyRows }),
      tests: [
        { name: "Between-subgroup heterogeneity Q", statistic: qBetween, distribution: "chi-square", df: G - 1, pValue: qBetweenP },
        { name: "Within-subgroup heterogeneity Q", statistic: qWithin, distribution: "chi-square", df: withinDf, pValue: withinDf > 0 ? H.pFromChiSquare(qWithin, withinDf) : null },
      ],
      confidenceIntervals: subgroupRows.map((row) => ({ parameter: `${row.subgroup} random pooled effect`, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: `normal inverse-variance with ${options.tauModel} ${options.tauEstimator} tau-squared` })),
      effectSizes: [...subgroupRows.map((row) => ({ name: `${row.subgroup} pooled effect`, estimate: row.randomEffect, lower: row.lower, upper: row.upper })), { name: "overall random pooled effect", estimate: overall.random.estimate }],
      assumptions: [
        { name: "independent study estimates", status: "requires_design_review" },
        { name: "subgroups defined a priori", status: "requires_design_review", detail: "post hoc subgroups inflate false-positive subgroup differences" },
        { name: options.tauModel === "common" ? "common between-study variance across subgroups" : "separate between-study variance per subgroup", status: "model_definition" },
      ],
      diagnostics: [
        { name: "between-subgroup test boundary", status: "asymptotic", detail: "Q_between compares random-effects subgroup means with inverse-variance weights; it is a Wald-type chi-square test with G - 1 df" },
        { name: "tau-squared model", status: "declared", tauModel: options.tauModel, estimator: options.tauEstimator, commonTauSquared: commonTau ? commonTau.value : null, perSubgroup: subgroupRows.map((row) => ({ subgroup: row.subgroup, tauSquared: row.tauSquared, boundary: row.tauSquared === 0 ? "zero" : "interior" })) },
        { name: "small subgroups", status: subgroupRows.some((row) => row.studies < 3) ? "warning" : "acceptable", detail: "subgroups with fewer than three studies cannot estimate tau-squared reliably", counts: subgroupRows.map((row) => ({ subgroup: row.subgroup, studies: row.studies })) },
        { name: "overall summary boundary", status: "reference_only", detail: "the overall row pools all studies with its own tau-squared and is reported for orientation, not as the subgroup model summary" },
      ],
      artifacts: [
        H.tableArtifact("Subgroup pooled estimates", `${Math.round(options.confidenceLevel * 100)}% random-effects estimates per subgroup with heterogeneity.`, [stringColumn("subgroup", "Subgroup"), numberColumn("studies", "Studies"), numberColumn("fixedEffect", "Fixed effect"), numberColumn("randomEffect", "Random effect"), numberColumn("standardError", "SE"), numberColumn("lower", "CI lower"), numberColumn("upper", "CI upper"), numberColumn("tauSquared", "Tau squared"), numberColumn("q", "Q"), numberColumn("df", "df"), numberColumn("qPValue", "Q p"), numberColumn("iSquared", "I squared")], subgroupRows, [`Q_between(${G - 1}) = ${qBetween}, p = ${qBetweenP}.`], "subgroup-summary-table"),
        H.tableArtifact("Subgroup forest rows", "Every study, subgroup pooled row, and the overall random-effects row in display order.", [stringColumn("label", "Row"), stringColumn("rowType", "Type"), stringColumn("subgroup", "Subgroup"), numberColumn("effect", parsed.effectLabel), numberColumn("lower", "CI lower"), numberColumn("upper", "CI upper")], forestRows, [], "subgroup-forest-table"),
        H.vegaArtifact("subgroup-forest", `Subgroup forest plot: ${parsed.effectLabel}`, { data: { values: forestRows }, layer: forestLayers(parsed.effectLabel, parsed.nullValue, "subgroup") }),
      ],
    };
  },
  linkage: {
    neededWhen: "Studies fall into pre-specified categories (population, design, dose class) and the pooled effect may differ between those categories.",
    decision: "Whether the subgroup pooled effects differ more than sampling error allows (Q_between) and how heterogeneous each subgroup remains.",
    mustShow: "The per-subgroup pooled table with tau-squared and I-squared, the between-subgroup Q test, and the grouped forest plot.",
    userGoal: "Judge whether the intervention effect is consistent across study categories before reporting one overall estimate.",
    nextActions: [
      { trigger: "between-subgroup-difference-detected", action: "report-subgroup-estimates-separately", reason: "A significant Q_between means one pooled number would misrepresent at least one subgroup." },
      { trigger: "subgroup-has-few-studies", action: "treat-subgroup-result-as-exploratory", reason: "Tau-squared and intervals for subgroups with fewer than three studies are unstable and easily over-interpreted." },
      { trigger: "no-subgroup-difference", action: "report-overall-random-effect", reason: "Without evidence of subgroup differences the overall random-effects estimate is the primary result." },
    ],
  },
  fixture: {
    data: {
      studies: [
        { label: "Aster", effect: 0.12, standardError: 0.11, subgroup: "adults" }, { label: "Birch", effect: 0.41, variance: 0.0324, subgroup: "adults" }, { label: "Cedar", effect: -0.08, standardError: 0.14, subgroup: "children" }, { label: "Dogwood", effect: 0.28, variance: 0.0144, subgroup: "adults" },
        { label: "Elm", effect: 0.55, standardError: 0.21, subgroup: "adults" }, { label: "Fir", effect: 0.04, variance: 0.0225, subgroup: "children" }, { label: "Ginkgo", effect: 0.33, standardError: 0.13, subgroup: "adults" }, { label: "Hazel", effect: 0.19, variance: 0.0256, subgroup: "children" },
        { label: "Iris", effect: 0.02, standardError: 0.12, subgroup: "children" }, { label: "Juniper", effect: 0.36, standardError: 0.15, subgroup: "adults" },
      ],
      effectLabel: "log response ratio",
      nullValue: 0,
    },
    options: { tauEstimator: "der-simonian-laird", tauModel: "separate" },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.location"] },
  coverage: {
    implementedBoundary: "Per-subgroup inverse-variance pooling with separate or common DL/PM tau-squared and a Wald-type between-subgroup Q test on the random-effects subgroup means.",
    oracle: { level: "external-library-partial", evidence: ["contracts/meta-analysis-extended-numpy-crosscheck.py"], verifiedOutputs: ["subgroup random estimates", "subgroup tau-squared", "Q_between", "Q_within", "common tau-squared"], excludedOutputs: ["mixed-effects model with subgroup dummies and REML", "multiple-testing adjustment across subgroups"] },
    diagnostic: { level: "method-specific-partial", emitted: ["between-subgroup test boundary", "tau-squared model", "small subgroups", "overall summary boundary"], limitations: ["no credibility assessment of subgroup effects", "no interaction with continuous moderators"] },
    knownGaps: ["Knapp-Hartung subgroup intervals", "study-level covariates beyond one categorical factor", "overlapping subgroup memberships"],
  },
};

// ---------------------------------------------------------------------------------------------
// trim_and_fill (Duval-Tweedie)
// ---------------------------------------------------------------------------------------------

function rankFirst(values) {
  // rank with ties broken by original order (R's ties.method = "first")
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value || a.index - b.index);
  const ranks = Array(values.length);
  order.forEach((item, position) => { ranks[item.index] = position + 1; });
  return ranks;
}

const trimAndFill = {
  method: "trim_and_fill",
  family: "meta-analysis",
  analysisModel: { families: ["meta-analysis"], distributions: [null, "normal"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "tauEstimator", "timeoutMs", "maxIterations", "tolerance"],
  customOptions: {
    fillEstimator: {
      schema: { type: "string", enum: ["L0", "R0"] },
      default: "L0",
      parse(value, H, path) {
        if (!["L0", "R0"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be L0 or R0`);
        return value;
      },
    },
    side: {
      schema: { type: "string", enum: ["auto", "left", "right"] },
      default: "auto",
      parse(value, H, path) {
        if (!["auto", "left", "right"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be auto, left, or right`);
        return value;
      },
    },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["studies"],
    properties: { studies: { type: "array", minItems: 3, maxItems: 1000, items: studySchema() }, effectLabel: labelSchema, nullValue: { type: "number" } },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["studies", "effectLabel", "nullValue"], "data");
    return { studies: parseStudies(data.studies, H, { minimum: 3 }), ...parseCommon(data, H) };
  },
  analyze(parsed, options, budget, H) {
    const critical = zCritical(options.confidenceLevel, H);
    const k = parsed.studies.length;
    // Side selection: fixed-effects regression of effect on SE (Egger-type); negative slope => missing on the right.
    let side = options.side;
    let sideSlope = null;
    if (side === "auto") {
      const w = parsed.studies.map((study) => 1 / study.variance);
      const x = parsed.studies.map((study) => study.standardError);
      const y = parsed.studies.map((study) => study.effect);
      const sw = H.sum(w, budget);
      const mx = H.sum(w.map((weight, i) => weight * x[i]), budget) / sw;
      const my = H.sum(w.map((weight, i) => weight * y[i]), budget) / sw;
      const sxx = H.sum(w.map((weight, i) => weight * (x[i] - mx) * (x[i] - mx)), budget);
      if (!(sxx > 0)) H.fail("STAT_DEGENERATE", "study standard errors do not vary; the funnel side cannot be chosen automatically");
      sideSlope = H.sum(w.map((weight, i) => weight * (x[i] - mx) * (y[i] - my)), budget) / sxx;
      side = sideSlope < 0 ? "right" : "left";
    }
    const sign = side === "right" ? -1 : 1;
    const ordered = parsed.studies.map((study) => ({ ...study, flipped: sign * study.effect })).sort((a, b) => a.flipped - b.flipped || a.label.localeCompare(b.label, "en"));
    const fitRandom = (studies) => {
      const tau = tauSquaredBy(studies, options.tauEstimator, options, H, budget);
      return { ...pooled(studies, tau.value, H, budget), tauSquared: tau.value };
    };
    let k0 = 0;
    let previous = -1;
    let iterations = 0;
    let trimmedFit = null;
    const trace = [];
    while (k0 !== previous && iterations < options.maxIterations) {
      budget.check(64);
      previous = k0;
      iterations += 1;
      const retained = ordered.slice(0, k - k0).map((study) => ({ label: study.label, effect: study.flipped, variance: study.variance, standardError: study.standardError }));
      if (retained.length < 2) H.fail("STAT_DEGENERATE", "trim-and-fill trimmed all but one study");
      trimmedFit = fitRandom(retained);
      const centered = ordered.map((study) => study.flipped - trimmedFit.estimate);
      const ranks = rankFirst(centered.map(Math.abs));
      const signedRanks = centered.map((value, i) => (value > 0 ? 1 : value < 0 ? -1 : 0) * ranks[i]);
      let next;
      if (options.fillEstimator === "L0") {
        const sr = signedRanks.filter((value) => value > 0).reduce((total, value) => total + value, 0);
        next = Math.round((4 * sr - k * (k + 1)) / (2 * k - 1));
      } else {
        const negatives = signedRanks.filter((value) => value < 0).map((value) => -value);
        next = negatives.length ? k - Math.max(...negatives) - 1 : 0;
      }
      next = Math.max(0, Math.min(k - 2, next));
      trace.push({ iteration: iterations, k0Estimate: next, trimmedEstimate: sign * trimmedFit.estimate });
      k0 = next;
    }
    if (k0 !== previous) H.fail("STAT_NON_CONVERGENCE", `trim-and-fill did not stabilise within ${options.maxIterations} iterations`);
    const original = fitRandom(parsed.studies);
    const imputed = ordered.slice(k - k0).map((study, index) => ({ label: `Imputed ${index + 1} (mirror of ${study.label})`, effect: sign * (2 * trimmedFit.estimate - study.flipped), standardError: study.standardError, variance: study.variance, mirrorOf: study.label }));
    const filledStudies = [...parsed.studies, ...imputed.map((study) => ({ label: study.label, effect: study.effect, standardError: study.standardError, variance: study.variance }))];
    const filled = fitRandom(filledStudies);
    const funnelRows = [
      ...parsed.studies.map((study) => ({ study: study.label, source: "observed", effect: study.effect, standardError: study.standardError })),
      ...imputed.map((study) => ({ study: study.label, source: "imputed", effect: study.effect, standardError: study.standardError })),
    ];
    const summaryRows = [
      { model: "observed studies", studies: k, estimate: original.estimate, standardError: original.standardError, lower: original.estimate - critical * original.standardError, upper: original.estimate + critical * original.standardError, tauSquared: original.tauSquared },
      { model: `filled (${k0} imputed)`, studies: k + k0, estimate: filled.estimate, standardError: filled.standardError, lower: filled.estimate - critical * filled.standardError, upper: filled.estimate + critical * filled.standardError, tauSquared: filled.tauSquared },
    ];
    const imputedRows = imputed.map((study) => ({ label: study.label, mirrorOf: study.mirrorOf, effect: study.effect, standardError: study.standardError }));
    const filledSe = filled.standardError;
    return {
      sample: { studies: k, imputedStudies: k0, side, estimator: options.fillEstimator, effectLabel: parsed.effectLabel },
      estimates: estimateRows({ k0, side, sideSlope, observed: summaryRows[0], filled: summaryRows[1], trimmedEstimate: sign * trimmedFit.estimate, imputedStudies: imputedRows, iterationTrace: trace, funnelRows }),
      tests: [{ name: "Trim-and-fill missing-study count", statistic: k0, distribution: "none", df: null, pValue: null, method: options.fillEstimator }],
      confidenceIntervals: summaryRows.map((row) => ({ parameter: `${row.model} random pooled effect`, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: `normal inverse-variance with ${options.tauEstimator} tau-squared` })),
      effectSizes: [{ name: "observed random pooled effect", estimate: original.estimate }, { name: "filled random pooled effect", estimate: filled.estimate, standardError: filledSe }, { name: "adjustment", estimate: filled.estimate - original.estimate }],
      assumptions: [
        { name: "funnel asymmetry caused by suppression of one-sided results", status: "requires_design_review", detail: "heterogeneity and small-study effects also create asymmetry and are not distinguished by trim-and-fill" },
        { name: "symmetric distribution of study effects around the true effect", status: "method_definition" },
      ],
      diagnostics: [
        { name: "side selection", status: options.side === "auto" ? "estimated" : "declared", side, fixedEffectSlopeOnStandardError: sideSlope, rule: "negative slope of effect on SE implies missing studies on the right" },
        { name: "iteration", status: "converged", iterations, estimator: options.fillEstimator, trace },
        { name: "interpretation boundary", status: "sensitivity_analysis_only", detail: "the filled estimate is a sensitivity analysis, not a corrected effect; k0 is a rough count of suppressed studies" },
        { name: "small-k boundary", status: k < 10 ? "underpowered" : "acceptable", detail: "trim-and-fill is unreliable below roughly ten studies" },
      ],
      artifacts: [
        H.tableArtifact("Trim-and-fill pooled estimates", `Random-effects estimates before and after imputing ${k0} mirrored studies on the ${side} side.`, [stringColumn("model", "Model"), numberColumn("studies", "Studies"), numberColumn("estimate", parsed.effectLabel), numberColumn("standardError", "SE"), numberColumn("lower", "CI lower"), numberColumn("upper", "CI upper"), numberColumn("tauSquared", "Tau squared")], summaryRows, [`Estimator ${options.fillEstimator}; side ${side}.`], "trim-fill-summary-table"),
        H.tableArtifact("Imputed studies", "Mirror images of the trimmed studies around the trimmed pooled estimate.", [stringColumn("label", "Imputed study"), stringColumn("mirrorOf", "Mirror of"), numberColumn("effect", parsed.effectLabel), numberColumn("standardError", "SE")], imputedRows, imputedRows.length ? [] : ["No studies were imputed."], "trim-fill-imputed-table"),
        H.tableArtifact("Funnel rows", "Observed and imputed studies as plotted.", [stringColumn("study", "Study"), stringColumn("source", "Source"), numberColumn("effect", parsed.effectLabel), numberColumn("standardError", "SE")], funnelRows, [], "trim-fill-funnel-table"),
        H.vegaArtifact("trim-fill-funnel", `Trim-and-fill funnel plot: ${parsed.effectLabel}`, { data: { values: funnelRows }, layer: [
          { mark: { type: "point", size: 80, filled: true }, encoding: { x: { field: "effect", type: "quantitative", title: parsed.effectLabel }, y: { field: "standardError", type: "quantitative", title: "Standard error", scale: { reverse: true } }, color: { field: "source", type: "nominal", title: "Source" }, shape: { field: "source", type: "nominal" }, tooltip: [{ field: "study" }, { field: "effect", format: ".5g" }, { field: "standardError", format: ".5g" }] } },
          { mark: { type: "rule", color: "#4E6E64" }, encoding: { x: { datum: filled.estimate } } },
          { mark: { type: "rule", color: "#A36D47", strokeDash: [5, 4] }, encoding: { x: { datum: original.estimate } } },
        ] }),
      ],
    };
  },
  linkage: {
    neededWhen: "A funnel plot looks asymmetric and the reviewer needs a sensitivity analysis for how many suppressed studies would restore symmetry.",
    decision: "How much the pooled effect changes when mirrored studies are imputed, and whether that adjustment would alter the conclusion.",
    mustShow: "The observed versus filled pooled estimates, the number and values of imputed studies, and the funnel plot marking imputed points.",
    userGoal: "Quantify the sensitivity of the pooled effect to plausible one-sided publication bias.",
    nextActions: [
      { trigger: "filled-estimate-crosses-null", action: "downgrade-certainty-for-publication-bias", reason: "If imputing suppressed studies removes the effect, the evidence base cannot support a confident claim." },
      { trigger: "heterogeneity-high", action: "interpret-trim-fill-with-caution", reason: "Trim-and-fill mistakes heterogeneity-driven asymmetry for missing studies and can impute spurious ones." },
      { trigger: "no-studies-imputed", action: "report-funnel-symmetry-screen", reason: "Zero imputed studies is weak evidence against bias and should be reported alongside Egger-type tests." },
    ],
  },
  fixture: {
    data: {
      studies: [
        { label: "Aster", effect: 0.62, standardError: 0.28 }, { label: "Birch", effect: 0.41, variance: 0.0324 }, { label: "Cedar", effect: 0.55, standardError: 0.24 }, { label: "Dogwood", effect: 0.28, variance: 0.0144 },
        { label: "Elm", effect: 0.75, standardError: 0.31 }, { label: "Fir", effect: 0.19, variance: 0.0121 }, { label: "Ginkgo", effect: 0.33, standardError: 0.13 }, { label: "Hazel", effect: 0.47, variance: 0.0256 },
        { label: "Iris", effect: 0.22, standardError: 0.10 }, { label: "Juniper", effect: 0.58, standardError: 0.26 },
      ],
      effectLabel: "standardized mean difference",
      nullValue: 0,
    },
    options: { fillEstimator: "L0", side: "auto", tauEstimator: "der-simonian-laird" },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.location"] },
  coverage: {
    implementedBoundary: "Duval-Tweedie trim-and-fill with L0 or R0 missing-study estimators, automatic or declared funnel side, iterative trimming with random-effects refits, and mirrored imputation.",
    oracle: { level: "external-library-partial", evidence: ["contracts/meta-analysis-extended-numpy-crosscheck.py"], verifiedOutputs: ["k0", "side", "filled pooled estimate", "imputed effects"], excludedOutputs: ["Q0 estimator", "fixed-effect trimming variants"] },
    diagnostic: { level: "method-specific-partial", emitted: ["side selection", "iteration", "interpretation boundary", "small-k boundary"], limitations: ["no standard error for k0", "no selection-model alternative"] },
    knownGaps: ["Q0 estimator", "selection models (Copas, Vevea-Hedges)", "PET-PEESE regression adjustments"],
  },
};

// ---------------------------------------------------------------------------------------------
// hartung_knapp_meta_analysis
// ---------------------------------------------------------------------------------------------

const hartungKnappMetaAnalysis = {
  method: "hartung_knapp_meta_analysis",
  family: "meta-analysis",
  analysisModel: { families: ["meta-analysis"], distributions: [null, "normal"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "tauEstimator", "timeoutMs", "maxIterations", "tolerance"],
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["studies"],
    properties: { studies: { type: "array", minItems: 3, maxItems: 1000, items: studySchema() }, effectLabel: labelSchema, nullValue: { type: "number" } },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["studies", "effectLabel", "nullValue"], "data");
    return { studies: parseStudies(data.studies, H, { minimum: 3 }), ...parseCommon(data, H) };
  },
  analyze(parsed, options, budget, H) {
    const summary = randomEffectsSummary(parsed.studies, options, H, budget);
    const k = parsed.studies.length;
    const df = k - 1;
    const random = summary.random;
    const qScale = random.q / df;
    const seHk = Math.sqrt(qScale) * random.standardError;
    if (!(seHk > 0)) H.fail("STAT_DEGENERATE", "Hartung-Knapp standard error is zero because all study effects coincide with the pooled estimate");
    const seModified = Math.sqrt(Math.max(1, qScale)) * random.standardError;
    const tCrit = H.tCritical(options.confidenceLevel, df);
    const center = random.estimate - parsed.nullValue;
    const rows = [
      { method: "random effects (z)", estimate: random.estimate, standardError: random.standardError, lower: random.lower, upper: random.upper, statistic: center / random.standardError, df: null, pValue: twoSidedNormalP(center / random.standardError, H) },
      { method: "Hartung-Knapp-Sidik-Jonkman (t)", estimate: random.estimate, standardError: seHk, lower: random.estimate - tCrit * seHk, upper: random.estimate + tCrit * seHk, statistic: center / seHk, df, pValue: H.pFromT(center / seHk, df, "two-sided") },
      { method: "modified Hartung-Knapp (t, q truncated at 1)", estimate: random.estimate, standardError: seModified, lower: random.estimate - tCrit * seModified, upper: random.estimate + tCrit * seModified, statistic: center / seModified, df, pValue: H.pFromT(center / seModified, df, "two-sided") },
    ];
    const forestRows = [
      ...parsed.studies.map((study) => ({ rowType: "study", label: study.label, effect: study.effect, lower: study.effect - summary.critical * study.standardError, upper: study.effect + summary.critical * study.standardError })),
      ...rows.map((row) => ({ rowType: "pooled", label: row.method, effect: row.estimate, lower: row.lower, upper: row.upper })),
    ];
    return {
      sample: { studies: k, effectLabel: parsed.effectLabel, tauEstimator: options.tauEstimator },
      estimates: estimateRows({ pooled: random.estimate, tauSquared: summary.tau.value, qScale, standardErrors: { normal: random.standardError, hartungKnapp: seHk, modified: seModified }, intervals: rows, heterogeneity: { q: summary.q, df, pValue: summary.qPValue, iSquared: summary.iSquared } }),
      tests: rows.map((row) => ({ name: `${row.method} test of pooled effect = ${parsed.nullValue}`, statistic: row.statistic, distribution: row.df === null ? "normal" : "t", df: row.df, pValue: row.pValue })),
      confidenceIntervals: rows.map((row) => ({ parameter: `pooled effect (${row.method})`, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: row.method })),
      effectSizes: [{ name: "random pooled effect", estimate: random.estimate, lower: rows[1].lower, upper: rows[1].upper, interval: "Hartung-Knapp" }, { name: "tau-squared", estimate: summary.tau.value, estimator: options.tauEstimator }],
      assumptions: [
        { name: "independent study estimates", status: "requires_design_review" },
        { name: "known within-study sampling variances", status: "assumed_from_supplied_standard_errors_or_variances" },
        { name: "random-effects exchangeability", status: "required_for_random_interpretation" },
      ],
      diagnostics: [
        { name: "Hartung-Knapp scale", status: qScale < 1 ? "below_one" : "at_or_above_one", qScale, detail: options.tauEstimator === "paule-mandel" ? "with Paule-Mandel tau-squared the random-effects Q equals k - 1 by construction, so q is 1 and the HK interval differs from the z interval only through the t quantile" : "when q < 1 the unmodified HK interval can be narrower than the z interval; the modified row truncates q at 1" },
        { name: "heterogeneity", status: "evaluated", q: summary.q, df, pValue: summary.qPValue, iSquared: summary.iSquared },
        { name: "small-k boundary", status: k < 5 ? "very_small_k" : "acceptable", detail: "HK intervals remain wide and t-based with k - 1 df; with very few studies all intervals are fragile" },
      ],
      artifacts: [
        H.tableArtifact(`Hartung-Knapp random-effects intervals: ${parsed.effectLabel}`, `${Math.round(options.confidenceLevel * 100)}% intervals under normal, HKSJ, and modified HK inference.`, [stringColumn("method", "Method"), numberColumn("estimate", parsed.effectLabel), numberColumn("standardError", "SE"), numberColumn("lower", "CI lower"), numberColumn("upper", "CI upper"), numberColumn("statistic", "Statistic"), numberColumn("df", "df"), numberColumn("pValue", "p")], rows, [`tau-squared (${options.tauEstimator}) = ${summary.tau.value}; q = ${qScale}.`], "hksj-summary-table"),
        H.tableArtifact("Forest rows", "Study rows with normal intervals and the three pooled rows.", [stringColumn("label", "Row"), stringColumn("rowType", "Type"), numberColumn("effect", parsed.effectLabel), numberColumn("lower", "CI lower"), numberColumn("upper", "CI upper")], forestRows, [], "hksj-forest-table"),
        H.vegaArtifact("hksj-forest", `Forest plot with Hartung-Knapp intervals: ${parsed.effectLabel}`, { data: { values: forestRows }, layer: forestLayers(parsed.effectLabel, parsed.nullValue) }),
      ],
    };
  },
  linkage: {
    neededWhen: "A random-effects meta-analysis has few studies or notable heterogeneity, so the normal-approximation interval is known to be too narrow.",
    decision: "Whether the conclusion survives the wider Hartung-Knapp t-based interval and whether the q scale is below one.",
    mustShow: "The three pooled rows (normal, HKSJ, modified HK) with intervals and p-values plus the heterogeneity summary.",
    userGoal: "Report a random-effects interval whose coverage is defensible when the number of studies is small.",
    nextActions: [
      { trigger: "hksj-interval-includes-null", action: "report-hksj-as-primary-inference", reason: "When the HK interval spans the null the normal-approximation significance should not be the headline result." },
      { trigger: "q-scale-below-one", action: "prefer-modified-hk-interval", reason: "A q scale below one narrows the HK interval below the z interval, which several guidelines advise against." },
      { trigger: "very-few-studies", action: "add-prediction-interval-and-caveat", reason: "With fewer than five studies every random-effects interval is fragile and the prediction interval is very wide." },
    ],
  },
  fixture: {
    data: {
      studies: [
        { label: "Aster", effect: 0.12, standardError: 0.11 }, { label: "Birch", effect: 0.41, variance: 0.0324 }, { label: "Cedar", effect: -0.08, standardError: 0.14 }, { label: "Dogwood", effect: 0.28, variance: 0.0144 },
        { label: "Elm", effect: 0.55, standardError: 0.21 }, { label: "Fir", effect: 0.04, variance: 0.0225 }, { label: "Ginkgo", effect: 0.33, standardError: 0.13 }, { label: "Hazel", effect: 0.19, variance: 0.0256 },
      ],
      effectLabel: "log response ratio",
      nullValue: 0,
    },
    options: { tauEstimator: "der-simonian-laird" },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.location"] },
  coverage: {
    implementedBoundary: "Random-effects pooling with DL or PM tau-squared and Hartung-Knapp-Sidik-Jonkman t-based intervals, reported alongside the modified (q truncated at one) and normal intervals.",
    oracle: { level: "external-library-partial", evidence: ["contracts/meta-analysis-extended-numpy-crosscheck.py"], verifiedOutputs: ["q scale", "HK standard error", "HK interval", "HK p-value"], excludedOutputs: ["Sidik-Jonkman tau-squared", "prediction intervals"] },
    diagnostic: { level: "method-specific-partial", emitted: ["Hartung-Knapp scale", "heterogeneity", "small-k boundary"], limitations: ["no simulation-based coverage assessment", "no bootstrap alternative"] },
    knownGaps: ["Sidik-Jonkman and REML tau-squared estimators", "HK intervals for meta-regression subgroups"],
  },
};

// ---------------------------------------------------------------------------------------------
// cumulative_meta_analysis
// ---------------------------------------------------------------------------------------------

const ORDERINGS = ["supplied", "year", "precision"];

const cumulativeMetaAnalysis = {
  method: "cumulative_meta_analysis",
  family: "meta-analysis",
  analysisModel: { families: ["meta-analysis"], distributions: [null, "normal"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "tauEstimator", "timeoutMs", "maxIterations", "tolerance"],
  customOptions: {
    orderBy: {
      schema: { type: "string", enum: ORDERINGS },
      default: "supplied",
      parse(value, H, path) {
        if (!ORDERINGS.includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be one of ${ORDERINGS.join(", ")}`);
        return value;
      },
    },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["studies"],
    properties: { studies: { type: "array", minItems: 2, maxItems: 1000, items: studySchema({ order: { type: "number" } }) }, effectLabel: labelSchema, nullValue: { type: "number" } },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["studies", "effectLabel", "nullValue"], "data");
    const studies = parseStudies(data.studies, H, { extraKeys: ["order"] }).map((study, index) => ({
      label: study.label, effect: study.effect, standardError: study.standardError, variance: study.variance,
      order: study.raw.order === undefined ? null : H.finiteNumber(study.raw.order, `data.studies[${index}].order`),
      suppliedIndex: index,
    }));
    if (options.orderBy === "year" && studies.some((study) => study.order === null)) H.fail("STAT_INVALID_INPUT", "orderBy year requires an order value on every study");
    return { studies, ...parseCommon(data, H) };
  },
  analyze(parsed, options, budget, H) {
    const critical = zCritical(options.confidenceLevel, H);
    const ordered = [...parsed.studies].sort((a, b) => {
      if (options.orderBy === "year") return a.order - b.order || a.suppliedIndex - b.suppliedIndex;
      if (options.orderBy === "precision") return b.variance !== a.variance ? a.variance - b.variance : a.suppliedIndex - b.suppliedIndex;
      return a.suppliedIndex - b.suppliedIndex;
    });
    const rows = [];
    for (let step = 1; step <= ordered.length; step += 1) {
      budget.check(16);
      const subset = ordered.slice(0, step);
      const fixed = pooled(subset, 0, H, budget);
      const tau = tauSquaredBy(subset, options.tauEstimator, options, H, budget);
      const random = pooled(subset, tau.value, H, budget);
      const df = step - 1;
      rows.push({ step, addedStudy: ordered[step - 1].label, order: ordered[step - 1].order, studies: step, fixedEffect: fixed.estimate, fixedLower: fixed.estimate - critical * fixed.standardError, fixedUpper: fixed.estimate + critical * fixed.standardError, randomEffect: random.estimate, randomStandardError: random.standardError, randomLower: random.estimate - critical * random.standardError, randomUpper: random.estimate + critical * random.standardError, tauSquared: tau.value, q: fixed.q, df, iSquared: df > 0 && fixed.q > 0 ? Math.max(0, (fixed.q - df) / fixed.q) : 0 });
    }
    const forestRows = rows.map((row) => ({ label: `${row.step}: + ${row.addedStudy}`, effect: row.randomEffect, lower: row.randomLower, upper: row.randomUpper, studies: row.studies }));
    const final = rows[rows.length - 1];
    const shifts = rows.slice(1).map((row, index) => Math.abs(row.randomEffect - rows[index].randomEffect));
    const largestShift = shifts.length ? Math.max(...shifts) : 0;
    return {
      sample: { studies: parsed.studies.length, orderBy: options.orderBy, effectLabel: parsed.effectLabel },
      estimates: estimateRows({ rows, final: { fixedEffect: final.fixedEffect, randomEffect: final.randomEffect, randomLower: final.randomLower, randomUpper: final.randomUpper, tauSquared: final.tauSquared }, largestStepShift: largestShift }),
      tests: [{ name: "Cochran Q heterogeneity at the final step", statistic: final.q, distribution: "chi-square", df: final.df, pValue: final.df > 0 ? H.pFromChiSquare(final.q, final.df) : null }],
      confidenceIntervals: rows.map((row) => ({ parameter: `random pooled effect after ${row.studies} studies`, level: options.confidenceLevel, lower: row.randomLower, upper: row.randomUpper, method: `normal inverse-variance with ${options.tauEstimator} tau-squared` })),
      effectSizes: [{ name: "final random pooled effect", estimate: final.randomEffect }, { name: "largest step-to-step shift", estimate: largestShift }],
      assumptions: [
        { name: "independent study estimates", status: "requires_design_review" },
        { name: "ordering variable is meaningful", status: "requires_design_review", detail: options.orderBy === "supplied" ? "the supplied order is treated as the accumulation order" : `studies are accumulated by ${options.orderBy}` },
      ],
      diagnostics: [
        { name: "accumulation order", status: "declared", orderBy: options.orderBy, sequence: ordered.map((study) => study.label) },
        { name: "early-step boundary", status: "asymptotic", detail: "steps with one study report tau-squared zero and no heterogeneity; steps with two or three studies have unstable tau-squared" },
        { name: "stability", status: largestShift > 0 ? "evaluated" : "flat", largestStepShift: largestShift, detail: "largest absolute change in the random pooled estimate between consecutive steps" },
      ],
      artifacts: [
        H.tableArtifact(`Cumulative meta-analysis: ${parsed.effectLabel}`, `Pooled estimates after each study is added in ${options.orderBy} order.`, [numberColumn("step", "Step"), stringColumn("addedStudy", "Added study"), numberColumn("order", "Order"), numberColumn("studies", "Studies"), numberColumn("fixedEffect", "Fixed effect"), numberColumn("fixedLower", "Fixed lower"), numberColumn("fixedUpper", "Fixed upper"), numberColumn("randomEffect", "Random effect"), numberColumn("randomStandardError", "Random SE"), numberColumn("randomLower", "Random lower"), numberColumn("randomUpper", "Random upper"), numberColumn("tauSquared", "Tau squared"), numberColumn("q", "Q"), numberColumn("df", "df"), numberColumn("iSquared", "I squared")], rows, ["Order is null when the study did not supply one."], "cumulative-meta-table"),
        H.tableArtifact("Cumulative forest rows", "Random-effects pooled estimate after each step.", [stringColumn("label", "Step"), numberColumn("effect", parsed.effectLabel), numberColumn("lower", "CI lower"), numberColumn("upper", "CI upper"), numberColumn("studies", "Studies")], forestRows, [], "cumulative-forest-table"),
        H.vegaArtifact("cumulative-forest", `Cumulative forest plot: ${parsed.effectLabel}`, { data: { values: forestRows }, layer: [
          { mark: { type: "rule", strokeWidth: 2, color: "#285f8f" }, encoding: { y: { field: "label", type: "ordinal", sort: null, title: null }, x: { field: "lower", type: "quantitative", title: parsed.effectLabel }, x2: { field: "upper" } } },
          { mark: { type: "point", filled: true, size: 85, color: "#285f8f" }, encoding: { y: { field: "label", type: "ordinal", sort: null }, x: { field: "effect", type: "quantitative" }, tooltip: [{ field: "label" }, { field: "effect", format: ".5g" }, { field: "lower", format: ".5g" }, { field: "upper", format: ".5g" }, { field: "studies" }] } },
          { mark: { type: "rule", strokeDash: [5, 4], color: "#7A7672" }, encoding: { x: { datum: parsed.nullValue } } },
        ] }),
      ],
    };
  },
  linkage: {
    neededWhen: "The reviewer needs to see how the pooled evidence evolved as studies accumulated, by year or by precision, to detect early overestimation or stabilisation.",
    decision: "At which step the pooled estimate stabilised, whether early studies overstated the effect, and whether later precise studies changed the conclusion.",
    mustShow: "The step-by-step table of pooled estimates with intervals and tau-squared plus the cumulative forest plot.",
    userGoal: "Communicate the trajectory of the evidence rather than a single endpoint, supporting decisions about whether more trials are needed.",
    nextActions: [
      { trigger: "estimate-drifts-toward-null", action: "investigate-time-lag-or-small-study-effects", reason: "A pooled effect that shrinks as studies accumulate is a classic signature of early small-study bias." },
      { trigger: "estimate-stable-early", action: "consider-evidence-sufficient", reason: "If the interval stopped changing many studies ago, additional trials may add little information." },
      { trigger: "late-precise-study-shifts-estimate", action: "examine-that-study-for-design-differences", reason: "A single late precise study that moves the pooled value deserves scrutiny for design or population differences." },
    ],
  },
  fixture: {
    data: {
      studies: [
        { label: "Aster", effect: 0.52, standardError: 0.21, order: 2008 }, { label: "Birch", effect: 0.41, variance: 0.0324, order: 2010 }, { label: "Cedar", effect: 0.38, standardError: 0.14, order: 2011 }, { label: "Dogwood", effect: 0.28, variance: 0.0144, order: 2013 },
        { label: "Elm", effect: 0.25, standardError: 0.11, order: 2015 }, { label: "Fir", effect: 0.14, variance: 0.0225, order: 2016 }, { label: "Ginkgo", effect: 0.23, standardError: 0.09, order: 2018 }, { label: "Hazel", effect: 0.19, variance: 0.0064, order: 2020 },
      ],
      effectLabel: "log response ratio",
      nullValue: 0,
    },
    options: { orderBy: "year", tauEstimator: "der-simonian-laird" },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.location"] },
  coverage: {
    implementedBoundary: "Cumulative fixed and random-effects pooling with DL or PM tau-squared after each study in supplied, year, or precision order.",
    oracle: { level: "external-library-partial", evidence: ["contracts/meta-analysis-extended-numpy-crosscheck.py"], verifiedOutputs: ["per-step random estimate", "per-step tau-squared", "per-step fixed estimate"], excludedOutputs: ["sequential monitoring boundaries", "trial sequential analysis"] },
    diagnostic: { level: "method-specific-partial", emitted: ["accumulation order", "early-step boundary", "stability"], limitations: ["no formal test of drift", "no multiplicity control across steps"] },
    knownGaps: ["trial sequential analysis with alpha-spending", "cumulative Hartung-Knapp intervals"],
  },
};

// ---------------------------------------------------------------------------------------------
// network_meta_analysis_frequentist
// ---------------------------------------------------------------------------------------------

const comparisonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["study", "treatment", "comparator", "effect"],
  properties: { study: labelSchema, treatment: labelSchema, comparator: labelSchema, effect: { type: "number" }, standardError: positive, variance: positive },
};

function weightedLeastSquares(X, y, w, H, budget) {
  const p = X[0].length;
  const xtwx = Array.from({ length: p }, () => Array(p).fill(0));
  const xtwy = Array(p).fill(0);
  for (let i = 0; i < X.length; i += 1) {
    budget.check();
    for (let a = 0; a < p; a += 1) {
      xtwy[a] += w[i] * X[i][a] * y[i];
      for (let b = 0; b < p; b += 1) xtwx[a][b] += w[i] * X[i][a] * X[i][b];
    }
  }
  const covariance = H.invert(xtwx);
  const beta = covariance.map((row) => row.reduce((total, value, index) => total + value * xtwy[index], 0));
  const fitted = X.map((row) => row.reduce((total, x, index) => total + x * beta[index], 0));
  const q = y.reduce((total, value, i) => total + w[i] * Math.pow(value - fitted[i], 2), 0);
  // C = tr(W) - tr((X'WX)^-1 X'W^2X)
  const m2 = Array.from({ length: p }, () => Array(p).fill(0));
  let sumW = 0;
  for (let i = 0; i < X.length; i += 1) {
    sumW += w[i];
    for (let a = 0; a < p; a += 1) for (let b = 0; b < p; b += 1) m2[a][b] += w[i] * w[i] * X[i][a] * X[i][b];
  }
  const am2 = H.matMul(covariance, m2);
  const generalizedC = sumW - am2.reduce((total, row, index) => total + row[index], 0);
  return { beta, covariance, fitted, q, generalizedC };
}

const networkMetaAnalysis = {
  method: "network_meta_analysis_frequentist",
  family: "meta-analysis",
  analysisModel: { families: ["meta-analysis"], distributions: [null, "normal"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs", "maxIterations", "tolerance"],
  customOptions: {
    smallValuesGood: {
      schema: { type: "boolean" },
      default: false,
      parse(value, H, path) {
        if (typeof value !== "boolean") H.fail("STAT_INVALID_INPUT", `${path} must be boolean`);
        return value;
      },
    },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["comparisons"],
    properties: {
      comparisons: { type: "array", minItems: 2, maxItems: MAX_COMPARISONS, items: comparisonSchema },
      reference: labelSchema,
      effectLabel: labelSchema,
      nullValue: { type: "number" },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["comparisons", "reference", "effectLabel", "nullValue"], "data");
    if (!Array.isArray(data.comparisons) || data.comparisons.length < 2) H.fail("STAT_INVALID_INPUT", "data.comparisons must contain at least two comparisons");
    if (data.comparisons.length > MAX_COMPARISONS) H.fail("STAT_LIMIT_EXCEEDED", `data.comparisons exceeds ${MAX_COMPARISONS} comparisons`);
    const studyPairs = new Set();
    const comparisons = data.comparisons.map((raw, index) => {
      const path = `data.comparisons[${index}]`;
      const comparison = H.assertObject(raw, path);
      H.assertKeys(comparison, ["study", "treatment", "comparator", "effect", "standardError", "variance"], path);
      const study = H.label(comparison.study, "", `${path}.study`);
      const treatment = H.label(comparison.treatment, "", `${path}.treatment`);
      const comparator = H.label(comparison.comparator, "", `${path}.comparator`);
      if (treatment === comparator) H.fail("STAT_INVALID_INPUT", `${path} compares a treatment with itself`);
      const pairKey = `${study} ${[treatment, comparator].sort().join(" ")}`;
      if (studyPairs.has(pairKey)) H.fail("STAT_INVALID_INPUT", `${path} duplicates a comparison already supplied for study ${study}`);
      studyPairs.add(pairKey);
      const effect = H.finiteNumber(comparison.effect, `${path}.effect`);
      const hasSe = comparison.standardError !== undefined;
      const hasVar = comparison.variance !== undefined;
      if (hasSe === hasVar) H.fail("STAT_INVALID_INPUT", `${path} must contain exactly one of standardError or variance`);
      const variance = hasVar ? H.finiteNumber(comparison.variance, `${path}.variance`) : Math.pow(H.finiteNumber(comparison.standardError, `${path}.standardError`), 2);
      if (!(variance > 0)) H.fail("STAT_INVALID_INPUT", `${path} variance must be positive`);
      return { study, treatment, comparator, effect, variance, standardError: Math.sqrt(variance) };
    });
    const studyCounts = new Map();
    for (const comparison of comparisons) studyCounts.set(comparison.study, (studyCounts.get(comparison.study) || 0) + 1);
    const multiArm = [...studyCounts.entries()].filter(([, count]) => count > 1).map(([study]) => study);
    if (multiArm.length) H.fail("STAT_INVALID_INPUT", `two-arm comparisons only: studies ${multiArm.join(", ")} supply more than one contrast; multi-arm studies are a known gap`);
    const treatments = [...new Set(comparisons.flatMap((comparison) => [comparison.treatment, comparison.comparator]))].sort((a, b) => a.localeCompare(b, "en"));
    if (treatments.length > MAX_TREATMENTS) H.fail("STAT_LIMIT_EXCEEDED", `network supports at most ${MAX_TREATMENTS} treatments (received ${treatments.length})`);
    if (treatments.length < 3) H.fail("STAT_INVALID_INPUT", "a network needs at least three treatments; use meta_analysis for a single pairwise comparison");
    const reference = data.reference === undefined ? treatments[0] : H.label(data.reference, treatments[0], "data.reference");
    if (!treatments.includes(reference)) H.fail("STAT_INVALID_INPUT", `data.reference ${reference} is not a treatment in the network`);
    // Connectivity (BFS).
    const adjacency = new Map(treatments.map((treatment) => [treatment, new Set()]));
    for (const comparison of comparisons) {
      adjacency.get(comparison.treatment).add(comparison.comparator);
      adjacency.get(comparison.comparator).add(comparison.treatment);
    }
    const visited = new Set([reference]);
    const queue = [reference];
    while (queue.length) {
      const node = queue.shift();
      for (const next of adjacency.get(node)) if (!visited.has(next)) { visited.add(next); queue.push(next); }
    }
    if (visited.size !== treatments.length) {
      const unreachable = treatments.filter((treatment) => !visited.has(treatment));
      H.fail("STAT_INVALID_INPUT", `network is disconnected: ${unreachable.join(", ")} cannot be reached from ${reference}`);
    }
    const orderedTreatments = [reference, ...treatments.filter((treatment) => treatment !== reference)];
    return { comparisons, treatments: orderedTreatments, reference, ...parseCommon(data, H) };
  },
  analyze(parsed, options, budget, H) {
    const treatments = parsed.treatments;
    const T = treatments.length;
    const index = new Map(treatments.map((treatment, position) => [treatment, position]));
    const m = parsed.comparisons.length;
    const X = parsed.comparisons.map((comparison) => {
      const row = Array(T - 1).fill(0);
      const t = index.get(comparison.treatment);
      const c = index.get(comparison.comparator);
      if (t > 0) row[t - 1] += 1;
      if (c > 0) row[c - 1] -= 1;
      return row;
    });
    const y = parsed.comparisons.map((comparison) => comparison.effect);
    const v = parsed.comparisons.map((comparison) => comparison.variance);
    const df = m - (T - 1);
    if (H.matrixRank(X) < T - 1) H.fail("STAT_RANK_DEFICIENT", "network design matrix is rank deficient");
    const fixed = weightedLeastSquares(X, y, v.map((value) => 1 / value), H, budget);
    const qTotal = fixed.q;
    const tauSquared = df > 0 ? Math.max(0, (qTotal - df) / fixed.generalizedC) : 0;
    const random = weightedLeastSquares(X, y, v.map((value) => 1 / (value + tauSquared)), H, budget);
    // Q decomposition: heterogeneity within designs vs inconsistency between designs.
    const designs = new Map();
    parsed.comparisons.forEach((comparison, i) => {
      const key = [comparison.treatment, comparison.comparator].sort((a, b) => a.localeCompare(b, "en")).join(" vs ");
      if (!designs.has(key)) designs.set(key, []);
      designs.get(key).push(i);
    });
    let qHeterogeneity = 0;
    const directRows = [];
    for (const [design, members] of designs) {
      budget.check();
      const first = parsed.comparisons[members[0]];
      const orientation = first.treatment.localeCompare(first.comparator, "en") <= 0 ? 1 : -1;
      const studies = members.map((i) => ({ effect: orientation * (parsed.comparisons[i].treatment === first.treatment ? parsed.comparisons[i].effect : -parsed.comparisons[i].effect), variance: parsed.comparisons[i].variance }));
      const summary = pooled(studies, 0, H, budget);
      qHeterogeneity += summary.q;
      const [left, right] = design.split(" vs ");
      directRows.push({ design, treatment: left, comparator: right, studies: members.length, directEstimate: summary.estimate, directStandardError: summary.standardError, qWithin: summary.q, dfWithin: members.length - 1 });
    }
    const D = designs.size;
    const dfHeterogeneity = m - D;
    const dfInconsistency = D - (T - 1);
    const qInconsistency = qTotal - qHeterogeneity;
    const critical = zCritical(options.confidenceLevel, H);
    const effectOf = (fit, t) => (t === 0 ? 0 : fit.beta[t - 1]);
    const contrastVariance = (fit, a, b) => {
      const c = Array(T - 1).fill(0);
      if (a > 0) c[a - 1] += 1;
      if (b > 0) c[b - 1] -= 1;
      return H.quadraticForm(c, fit.covariance);
    };
    const versusReference = treatments.slice(1).map((treatment, i) => {
      const estimate = random.beta[i];
      const standardError = Math.sqrt(Math.max(0, random.covariance[i][i]));
      if (!(standardError > 0)) H.fail("STAT_DEGENERATE", `standard error is zero for ${treatment} versus ${parsed.reference}`);
      const fixedEstimate = fixed.beta[i];
      const fixedSe = Math.sqrt(Math.max(0, fixed.covariance[i][i]));
      const statistic = (estimate - parsed.nullValue) / standardError;
      return { treatment, comparator: parsed.reference, estimate, standardError, lower: estimate - critical * standardError, upper: estimate + critical * standardError, statistic, pValue: twoSidedNormalP(statistic, H), fixedEstimate, fixedStandardError: fixedSe };
    });
    const league = [];
    const superiority = Array.from({ length: T }, () => Array(T).fill(0));
    for (let a = 0; a < T; a += 1) {
      for (let b = 0; b < T; b += 1) {
        if (a === b) continue;
        budget.check();
        const estimate = effectOf(random, a) - effectOf(random, b);
        const variance = contrastVariance(random, a, b);
        const standardError = Math.sqrt(Math.max(0, variance));
        if (!(standardError > 0)) H.fail("STAT_DEGENERATE", `standard error is zero for ${treatments[a]} versus ${treatments[b]}`);
        const z = (estimate - parsed.nullValue) / standardError;
        // Probability that a is better than b.
        const better = options.smallValuesGood ? 1 - normalSf(-z, H) : 1 - normalSf(z, H);
        superiority[a][b] = better;
        league.push({ treatment: treatments[a], comparator: treatments[b], estimate, standardError, lower: estimate - critical * standardError, upper: estimate + critical * standardError, pValue: twoSidedNormalP(z, H) });
      }
    }
    const ranking = treatments.map((treatment, a) => {
      const pScore = superiority[a].reduce((total, value, b) => total + (a === b ? 0 : value), 0) / (T - 1);
      const involved = parsed.comparisons.filter((comparison) => comparison.treatment === treatment || comparison.comparator === treatment).length;
      return { treatment, pScore, comparisons: involved };
    }).sort((left, right) => right.pScore - left.pScore || left.treatment.localeCompare(right.treatment, "en")).map((row, position) => ({ ...row, rank: position + 1 }));
    // Geometry.
    const nodeRows = treatments.map((treatment, i) => {
      const angle = 2 * Math.PI * i / T - Math.PI / 2;
      const row = ranking.find((item) => item.treatment === treatment);
      return { treatment, x: Math.cos(angle), y: Math.sin(angle), comparisons: row.comparisons, pScore: row.pScore };
    });
    const nodeIndex = new Map(nodeRows.map((row) => [row.treatment, row]));
    const edgeRows = directRows.map((row) => ({ design: row.design, treatment: row.treatment, comparator: row.comparator, studies: row.studies, x: nodeIndex.get(row.treatment).x, y: nodeIndex.get(row.treatment).y, x2: nodeIndex.get(row.comparator).x, y2: nodeIndex.get(row.comparator).y }));
    const inconsistencyTest = dfInconsistency > 0
      ? { name: "Design-by-treatment inconsistency Q", statistic: Math.max(0, qInconsistency), distribution: "chi-square", df: dfInconsistency, pValue: H.pFromChiSquare(Math.max(0, qInconsistency), dfInconsistency), status: "evaluated" }
      : { name: "Design-by-treatment inconsistency Q", statistic: null, distribution: "chi-square", df: dfInconsistency, pValue: null, status: "not_estimable", reason: "the network has no independent loops (designs minus treatments plus one is zero)" };
    return {
      sample: { comparisons: m, studies: new Set(parsed.comparisons.map((comparison) => comparison.study)).size, treatments: T, designs: D, reference: parsed.reference, effectLabel: parsed.effectLabel },
      estimates: estimateRows({ versusReference, league, ranking, tauSquared, heterogeneity: { qTotal, dfTotal: df, qHeterogeneity, dfHeterogeneity, qInconsistency, dfInconsistency }, direct: directRows, geometry: { nodes: nodeRows, edges: edgeRows } }),
      tests: [
        { name: "Total Q (heterogeneity plus inconsistency)", statistic: qTotal, distribution: "chi-square", df, pValue: df > 0 ? H.pFromChiSquare(qTotal, df) : null },
        { name: "Within-design heterogeneity Q", statistic: qHeterogeneity, distribution: "chi-square", df: dfHeterogeneity, pValue: dfHeterogeneity > 0 ? H.pFromChiSquare(qHeterogeneity, dfHeterogeneity) : null },
        inconsistencyTest,
        ...versusReference.map((row) => ({ name: `Wald z: ${row.treatment} vs ${parsed.reference}`, statistic: row.statistic, distribution: "normal", pValue: row.pValue })),
      ],
      confidenceIntervals: versusReference.map((row) => ({ parameter: `${row.treatment} vs ${parsed.reference}`, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: "Wald normal, random effects with common tau-squared" })),
      effectSizes: [...versusReference.map((row) => ({ name: `${row.treatment} vs ${parsed.reference}`, estimate: row.estimate, lower: row.lower, upper: row.upper })), { name: "common tau-squared", estimate: tauSquared }],
      assumptions: [
        { name: "transitivity across comparisons", status: "requires_design_review", detail: "indirect comparisons are valid only if trial populations are exchangeable across designs" },
        { name: "consistency between direct and indirect evidence", status: inconsistencyTest.status === "evaluated" ? "diagnostic_attached" : "not_testable_in_this_network" },
        { name: "common between-study variance across comparisons", status: "model_definition" },
        { name: "two-arm studies with independent contrasts", status: "verified_by_input_contract" },
      ],
      diagnostics: [
        { name: "tau-squared estimation", status: "evaluated", method: "generalized DerSimonian-Laird on the consistency model residual Q", tauSquared, boundary: tauSquared === 0 ? "zero" : "interior" },
        { name: "Q decomposition", status: dfInconsistency > 0 ? "evaluated" : "not_estimable", qTotal, dfTotal: df, qHeterogeneity, dfHeterogeneity, qInconsistency: Math.max(0, qInconsistency), dfInconsistency },
        { name: "ranking boundary", status: "asymptotic", detail: `P-scores average the normal probabilities that each treatment beats every other (${options.smallValuesGood ? "smaller" : "larger"} values better); they are not posterior rank probabilities` },
        { name: "network geometry", status: "declared", treatments: T, designs: D, loops: Math.max(0, dfInconsistency), connected: true },
        { name: "multi-arm boundary", status: "not_supported", detail: "multi-arm studies are rejected; splitting them into independent contrasts would understate uncertainty" },
      ],
      artifacts: [
        H.tableArtifact(`Network estimates versus ${parsed.reference}`, `Random-effects consistency model with common tau-squared and ${Math.round(options.confidenceLevel * 100)}% Wald intervals.`, [stringColumn("treatment", "Treatment"), stringColumn("comparator", "Comparator"), numberColumn("estimate", parsed.effectLabel), numberColumn("standardError", "SE"), numberColumn("lower", "CI lower"), numberColumn("upper", "CI upper"), numberColumn("statistic", "z"), numberColumn("pValue", "p"), numberColumn("fixedEstimate", "Fixed estimate"), numberColumn("fixedStandardError", "Fixed SE")], versusReference, [`tau-squared = ${tauSquared}; Q_total(${df}) = ${qTotal}.`], "network-reference-table"),
        H.tableArtifact("League table", "Every ordered pairwise contrast from the random-effects consistency model (treatment minus comparator).", [stringColumn("treatment", "Treatment"), stringColumn("comparator", "Comparator"), numberColumn("estimate", parsed.effectLabel), numberColumn("standardError", "SE"), numberColumn("lower", "CI lower"), numberColumn("upper", "CI upper"), numberColumn("pValue", "p")], league, [], "network-league-table"),
        H.tableArtifact("Treatment ranking (P-scores)", `Mean probability of being better than each other treatment; ${options.smallValuesGood ? "smaller" : "larger"} values are better.`, [numberColumn("rank", "Rank"), stringColumn("treatment", "Treatment"), numberColumn("pScore", "P-score"), numberColumn("comparisons", "Comparisons")], ranking, [], "network-ranking-table"),
        H.tableArtifact("Direct comparisons by design", "Fixed-effect pooled direct estimates within each design (first-listed treatment minus second).", [stringColumn("design", "Design"), stringColumn("treatment", "Treatment"), stringColumn("comparator", "Comparator"), numberColumn("studies", "Studies"), numberColumn("directEstimate", "Direct estimate"), numberColumn("directStandardError", "SE"), numberColumn("qWithin", "Q within"), numberColumn("dfWithin", "df")], directRows, [], "network-direct-table"),
        H.tableArtifact("Network geometry nodes", "Node coordinates on the unit circle with comparison counts and P-scores.", [stringColumn("treatment", "Treatment"), numberColumn("x", "x"), numberColumn("y", "y"), numberColumn("comparisons", "Comparisons"), numberColumn("pScore", "P-score")], nodeRows, [], "network-node-table"),
        H.tableArtifact("Network geometry edges", "Edge endpoints per design with the number of contributing studies.", [stringColumn("design", "Design"), stringColumn("treatment", "Treatment"), stringColumn("comparator", "Comparator"), numberColumn("studies", "Studies"), numberColumn("x", "x"), numberColumn("y", "y"), numberColumn("x2", "x2"), numberColumn("y2", "y2")], edgeRows, [], "network-edge-table"),
        H.vegaArtifact("network-geometry", "Network geometry: nodes are treatments, edge width is the number of studies", { layer: [
          { data: { values: edgeRows }, mark: { type: "rule", color: "#7A7672", opacity: 0.8 }, encoding: { x: { field: "x", type: "quantitative", axis: null, scale: { domain: [-1.3, 1.3] } }, y: { field: "y", type: "quantitative", axis: null, scale: { domain: [-1.3, 1.3] } }, x2: { field: "x2" }, y2: { field: "y2" }, strokeWidth: { field: "studies", type: "quantitative", legend: { title: "Studies" } }, tooltip: [{ field: "design" }, { field: "studies" }] } },
          { data: { values: nodeRows }, mark: { type: "circle", color: "#285f8f", opacity: 0.9 }, encoding: { x: { field: "x", type: "quantitative", axis: null }, y: { field: "y", type: "quantitative", axis: null }, size: { field: "comparisons", type: "quantitative", legend: { title: "Comparisons" } }, tooltip: [{ field: "treatment" }, { field: "comparisons" }, { field: "pScore", format: ".3f" }] } },
          { data: { values: nodeRows }, mark: { type: "text", dy: -14, fontSize: 12 }, encoding: { x: { field: "x", type: "quantitative", axis: null }, y: { field: "y", type: "quantitative", axis: null }, text: { field: "treatment" } } },
        ], width: 420, height: 420 }),
      ],
    };
  },
  linkage: {
    neededWhen: "Several treatments have been compared in different two-arm trials and the question is how all of them rank against each other, including pairs never compared directly.",
    decision: "Which treatments differ from the reference and from each other, how they rank by P-score, and whether direct and indirect evidence are consistent.",
    mustShow: "The versus-reference table, the league table, the P-score ranking, the Q decomposition, and the network geometry plot.",
    userGoal: "Synthesize an entire treatment network into comparable relative effects and an honest ranking with its consistency caveats.",
    nextActions: [
      { trigger: "inconsistency-q-significant", action: "run-node-splitting-or-drop-inconsistent-design", reason: "Significant inconsistency means direct and indirect estimates disagree and the consistency model is not trustworthy." },
      { trigger: "treatment-connected-by-single-study", action: "flag-fragile-treatment-estimates", reason: "A treatment linked to the network by one trial inherits that trial's biases with no replication." },
      { trigger: "ranking-p-scores-close", action: "report-estimates-not-ranks", reason: "P-scores that differ by a few hundredths do not support a claim that one treatment is best." },
    ],
  },
  fixture: {
    data: {
      comparisons: [
        { study: "S1", treatment: "B", comparator: "A", effect: -0.62, standardError: 0.14 },
        { study: "S2", treatment: "B", comparator: "A", effect: -0.11, standardError: 0.13 },
        { study: "S3", treatment: "C", comparator: "A", effect: -0.85, standardError: 0.16 },
        { study: "S4", treatment: "C", comparator: "A", effect: -0.31, standardError: 0.15 },
        { study: "S5", treatment: "C", comparator: "B", effect: -0.08, standardError: 0.14 },
        { study: "S6", treatment: "D", comparator: "A", effect: -0.25, standardError: 0.19 },
        { study: "S7", treatment: "D", comparator: "B", effect: 0.42, standardError: 0.17 },
        { study: "S8", treatment: "D", comparator: "C", effect: 0.63, standardError: 0.18 },
        { study: "S9", treatment: "C", comparator: "B", effect: -0.52, standardError: 0.15 },
      ],
      reference: "A",
      effectLabel: "log odds ratio",
      nullValue: 0,
    },
    options: { smallValuesGood: true },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "Contrast-based frequentist network meta-analysis for connected two-arm networks of at most 12 treatments: weighted least-squares consistency model, generalized DL common tau-squared, league table, P-score ranking, and a Q decomposition into heterogeneity and inconsistency.",
    oracle: { level: "external-library-partial", evidence: ["contracts/meta-analysis-extended-numpy-crosscheck.py"], verifiedOutputs: ["versus-reference estimates", "standard errors", "tau-squared", "league table contrasts", "P-scores", "Q decomposition"], excludedOutputs: ["multi-arm study handling", "node-splitting", "SUCRA from rank probabilities"] },
    diagnostic: { level: "method-specific-partial", emitted: ["tau-squared estimation", "Q decomposition", "ranking boundary", "network geometry", "multi-arm boundary"], limitations: ["no local inconsistency tests", "no covariate adjustment"] },
    knownGaps: ["multi-arm studies with correlated contrasts", "node-splitting and net-heat inconsistency diagnostics", "Bayesian rank probabilities and SUCRA", "arm-based models"],
  },
};

module.exports = {
  methods: [effectSizeFromArms, metaRegression, subgroupMetaAnalysis, trimAndFill, hartungKnappMetaAnalysis, cumulativeMetaAnalysis, networkMetaAnalysis],
};
