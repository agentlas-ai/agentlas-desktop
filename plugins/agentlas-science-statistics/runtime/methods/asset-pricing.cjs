"use strict";

/**
 * Finance / asset-pricing family: the three estimators a Fama-French style study is built from.
 *
 *   linear_factor_model     time-series regression of an excess return on a constant and K factors
 *   fama_macbeth_regression two-pass cross-sectional risk premia on a long panel
 *   grs_test                Gibbons-Ross-Shanken joint test that every alpha is zero
 *
 * Everything here is deterministic pure JavaScript: no engine require (circular), no Math.random,
 * no Date, no I/O. Numerics arrive through the `H` helper surface and through regression-kit.cjs
 * (olsFit, hacCovariance, automaticHacLags, coefficientRows, forestPlot, ...), which is also what
 * the python oracle in contracts/asset-pricing-statsmodels-crosscheck.py reproduces independently.
 *
 * Conventions that a reader of the output must be able to check:
 *
 * * Rows are read as a time series. `hacCovariance` treats adjacency as lag, so a shuffled sample
 *   would return a confident wrong answer; the time-order requirement is declared as an assumption
 *   rather than silently assumed.
 * * HAC standard errors are Newey-West with Bartlett weights and no small-sample correction, which
 *   is exactly statsmodels' `OLS(...).fit(cov_type="HAC", cov_kwds={"maxlags": L,
 *   "use_correction": False})`. Robust covariance (hac, hc1, hc2, hc3) is reported against a normal
 *   reference and classical covariance against t with n - p degrees of freedom - the same pairing
 *   statsmodels uses (`use_t` is False for every robust covariance type).
 * * Annualisation is arithmetic (estimate x periodsPerYear). It is not a compounded return and is
 *   labelled as such everywhere it appears.
 *
 * Known engine boundary, stated because it changes what a user can actually request:
 * `options.covariance` is a shared option and engine.cjs's shared option parser currently accepts
 * only classical, hc0, hc1, hc2, and hc3, and fills an omitted value with "classical". This module
 * implements and declares "hac" as the default covariance for linear_factor_model, and it always
 * computes the Newey-West standard errors and reports them in the coefficient table and in the
 * diagnostics, so the HAC numbers are visible no matter which estimator drives the intervals. Until
 * the shared whitelist learns "hac", an explicit `covariance: "hac"` request is rejected upstream
 * before it reaches this module, and the reported intervals fall back to classical. That gap is
 * recorded in coverage.knownGaps and in the covariance diagnostic instead of being papered over.
 */

const K = require("./regression-kit.cjs");

const MIN_PERIODS = 12;
const MIN_PANEL_PERIODS = 5;
const MAX_FACTORS = 12;
const MIN_PORTFOLIOS = 2;
const MAX_PORTFOLIOS = 200;
const MAX_HAC_LAGS = 500;
const BAND_POINTS = 41;
const COVARIANCE_CHOICES = Object.freeze(["hac", "classical", "hc1", "hc2", "hc3"]);
const DEFAULT_COVARIANCE = "hac";

// ---------------------------------------------------------------------------------
// Shared parsing and small numeric helpers
// ---------------------------------------------------------------------------------

/** [{ name, values }] with unique names and a fixed length; used for factors and for exposures. */
function parseSeriesBlock(raw, n, H, path, { minimum = 1, maximum = MAX_FACTORS } = {}) {
  if (!Array.isArray(raw) || raw.length < minimum || raw.length > maximum) {
    H.fail("STAT_INVALID_INPUT", `${path} must list between ${minimum} and ${maximum} named series`);
  }
  const seen = new Set();
  return raw.map((item, index) => {
    const entry = H.assertObject(item, `${path}[${index}]`);
    H.assertKeys(entry, ["name", "values"], `${path}[${index}]`);
    const name = H.label(entry.name, `Series ${index + 1}`, `${path}[${index}].name`);
    if (seen.has(name)) H.fail("STAT_INVALID_INPUT", `${path} repeats the name ${name}`);
    seen.add(name);
    const values = H.numericVector(entry.values, `${path}[${index}].values`, 2);
    if (values.length !== n) H.fail("STAT_INVALID_INPUT", `${path}[${index}].values must hold ${n} observations, one per period`);
    return { name, values };
  });
}

/** [1, s1_t, ..., sK_t] design rows in the supplied order. */
function designRows(series, n) {
  const rows = [];
  for (let index = 0; index < n; index += 1) {
    const row = [1];
    for (const item of series) row.push(item.values[index]);
    rows.push(row);
  }
  return rows;
}

function assertInterceptNameFree(names, H, path) {
  for (const name of names) {
    if (name.toLowerCase() === "alpha") H.fail("STAT_INVALID_INPUT", `${path} may not use the reserved term name alpha; the intercept already carries it`);
  }
}

/**
 * The covariance estimator this method reports inference from.
 *
 * The declared default is "hac": for a monthly time-series factor regression, classical standard
 * errors are the exceptional request, not the neutral one. When the shared option parser has
 * already substituted its own default the value arrives as "classical" and is honoured literally -
 * an explicit request is never silently reinterpreted as something else.
 */
function resolveCovariance(options, H) {
  const requested = options.covariance === undefined ? DEFAULT_COVARIANCE : options.covariance;
  if (!COVARIANCE_CHOICES.includes(requested)) {
    H.fail("STAT_INVALID_INPUT", `options.covariance for linear_factor_model must be one of ${COVARIANCE_CHOICES.join(", ")}`);
  }
  return requested;
}

function resolveHacLags(options, n, H) {
  const supplied = options.hacLags === undefined ? null : options.hacLags;
  const lags = supplied === null ? K.automaticHacLags(n) : supplied;
  if (lags >= n) H.fail("STAT_INVALID_INPUT", `options.hacLags must be smaller than the ${n} observed periods`);
  return {
    lags,
    selection: supplied === null ? "automatic" : "analyst",
    rule: supplied === null
      ? `Newey and West (1994) rule of thumb floor(4 (T/100)^(2/9)) with T = ${n}`
      : "supplied by the analyst as options.hacLags",
  };
}

function periodsPerYear(options) {
  return options.periodsPerYear === undefined ? 12 : options.periodsPerYear;
}

/**
 * Two-sided normal tail from the regularized incomplete gamma instead of the engine's erf
 * approximation: P(|Z| > z) = erfc(z / sqrt(2)) = Q(1/2, z^2/2). The erf path is only about 1.5e-7
 * accurate and returns exactly zero beyond |z| ~ 8. A market loading with t = 22 is ordinary in
 * this family, and "p = 0" is not a number a paper can report or a reader can check.
 */
function normalTwoSided(z, H) {
  return Math.min(1, Math.max(0, H.gammaQ(0.5, z * z / 2)));
}

/** Normal critical value refined by Newton steps against that same accurate tail. */
function normalCritical(confidenceLevel, H) {
  const tail = 1 - confidenceLevel;
  let z = H.normalInv(1 - tail / 2);
  for (let step = 0; step < 4; step += 1) {
    const error = normalTwoSided(z, H) - tail;
    const density = 2 * Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
    if (!(density > 0)) break;
    z += error / density;
  }
  return z;
}

/**
 * Exact two-sided Student-t tail: P(|T| > t) = I_{df/(df+t^2)}(df/2, 1/2). The engine's pFromT
 * forms 2 (1 - F(|t|)), which cancels to exactly zero once the tail falls below the double
 * epsilon. A market loading with t = 22 is routine in this family, so that cancellation is
 * reachable on ordinary data.
 */
function studentTwoSided(statistic, df, H) {
  return Math.min(1, Math.max(0, H.regularizedBeta(df / (df + statistic * statistic), df / 2, 0.5)));
}

/** Replace a coefficient row's p value with the accurate tail for whichever reference it declares. */
function withAccurateTail(row, H) {
  return { ...row, pValue: row.df === null ? normalTwoSided(row.statistic, H) : studentTwoSided(row.statistic, row.df, H) };
}

function criticalValue(df, confidenceLevel, H) {
  return df === null ? normalCritical(confidenceLevel, H) : H.tCritical(confidenceLevel, df);
}

function firstOrderAutocorrelation(residuals) {
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < residuals.length; index += 1) {
    denominator += residuals[index] * residuals[index];
    if (index > 0) numerator += residuals[index] * residuals[index - 1];
  }
  return denominator > 0 ? numerator / denominator : 0;
}

function diagonalStandardErrors(matrix, H, label) {
  return matrix.map((row, index) => {
    const variance = row[index];
    if (!(variance > 0) || !Number.isFinite(variance)) H.fail("STAT_DEGENERATE", `${label} variance ${index + 1} is not positive and finite`);
    return Math.sqrt(variance);
  });
}

/**
 * K.forestPlot draws the intervals but leaves the estimate axis on the Vega-Lite default, which
 * anchors a quantitative scale at zero. Every axis here carries a measurement, so the anchor is
 * released on the encodings that bind a field; the dashed layer at x = 0 keeps its `datum`, so the
 * null line still appears - zero is in the frame because it was drawn, not because the axis was
 * padded down to it.
 *
 * `independentX` additionally gives each facet row its own axis. An alpha of 0.004 and a market
 * loading of 1.03 do not share a scale: on a common axis the alpha interval collapses into a
 * sliver, which is exactly the failure a figure with intervals exists to prevent.
 */
function unanchorForestAxis(artifact, { independentX = false } = {}) {
  const layers = artifact.payload.spec ? artifact.payload.spec.layer : artifact.payload.layer;
  for (const layer of layers) {
    const encoding = layer.encoding;
    if (encoding && encoding.x && encoding.x.field) {
      encoding.x.scale = { ...(encoding.x.scale || {}), zero: false, nice: true };
    }
  }
  // MERGE, do not replace. The forest builder already resolves both scales independently for a
  // faceted forest, and assigning a fresh object here silently dropped the y half: every panel then
  // listed every term, so the alpha panel carried three empty factor rows and the loadings panel an
  // empty alpha row.
  if (independentX) {
    artifact.payload.resolve = {
      ...artifact.payload.resolve,
      scale: { ...(artifact.payload.resolve && artifact.payload.resolve.scale), x: "independent" },
    };
  }
  return artifact;
}

const SUMMARY_COLUMNS = Object.freeze([
  { key: "quantity", label: "Quantity", type: "string" },
  { key: "value", label: "Value", type: "number" },
  { key: "basis", label: "Basis", type: "string" },
]);

// ---------------------------------------------------------------------------------
// A. linear_factor_model
// ---------------------------------------------------------------------------------

const linearFactorModel = {
  method: "linear_factor_model",
  family: "asset-pricing",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "covariance", "timeoutMs"],
  customOptions: {
    hacLags: {
      schema: { type: ["integer", "null"], minimum: 0, maximum: MAX_HAC_LAGS },
      default: null,
      parse(value, H, path) {
        if (value === null) return null;
        return H.integer(value, 0, MAX_HAC_LAGS, path);
      },
    },
    periodsPerYear: {
      schema: { type: "integer", minimum: 1, maximum: 366 },
      default: 12,
      parse(value, H, path) { return H.integer(value, 1, 366, path); },
    },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["excessReturns", "factors"],
    properties: {
      excessReturns: { type: "array", minItems: MIN_PERIODS, items: { type: "number" } },
      factors: {
        type: "array",
        minItems: 1,
        maxItems: MAX_FACTORS,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "values"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 128 },
            values: { type: "array", minItems: MIN_PERIODS, items: { type: "number" } },
          },
        },
      },
      label: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["excessReturns", "factors", "label"], "data");
    if (data.excessReturns === undefined) H.fail("STAT_INVALID_INPUT", "data.excessReturns is required");
    if (data.factors === undefined) H.fail("STAT_INVALID_INPUT", "data.factors is required");
    const excessReturns = H.numericVector(data.excessReturns, "data.excessReturns", MIN_PERIODS);
    const factors = parseSeriesBlock(data.factors, excessReturns.length, H, "data.factors");
    assertInterceptNameFree(factors.map((factor) => factor.name), H, "data.factors");
    if (excessReturns.length <= factors.length + 2) {
      H.fail("STAT_INSUFFICIENT_SAMPLE", `a ${factors.length}-factor time-series regression needs more than ${factors.length + 2} periods`);
    }
    return {
      excessReturns,
      factors,
      label: H.label(data.label, "Excess return", "data.label"),
    };
  },
  analyze(parsed, options, budget, H) {
    const y = parsed.excessReturns;
    const periods = y.length;
    const x = designRows(parsed.factors, periods);
    const parameters = x[0].length;
    const terms = ["alpha", ...parsed.factors.map((factor) => factor.name)];
    const annualFactor = periodsPerYear(options);
    const level = options.confidenceLevel;

    const fit = K.olsFit(y, x, H, budget, { covariance: "classical" });

    // The Newey-West covariance is always computed: it is the estimator this family exists for, and
    // reporting it next to whichever estimator drives the intervals keeps the comparison visible.
    const hac = resolveHacLags(options, periods, H);
    const hacMatrix = K.hacCovariance(x, fit.bread, fit.residuals, hac.lags, H, budget);
    const hacStandardErrors = diagonalStandardErrors(hacMatrix, H, "HAC");

    const estimator = resolveCovariance(options, H);
    let covariance;
    let dfReference;
    if (estimator === "classical") {
      covariance = fit.covariance;
      dfReference = fit.df;
    } else if (estimator === "hac") {
      covariance = hacMatrix;
      dfReference = null;
    } else {
      const leverage = estimator === "hc2" || estimator === "hc3" ? K.leverageFromBread(x, fit.bread) : null;
      covariance = K.hcCovariance(x, fit.bread, fit.residuals, estimator, H, budget, leverage, parameters);
      dfReference = null;
    }

    const normalReferenceCritical = dfReference === null ? normalCritical(level, H) : null;
    const rows = K.coefficientRows(terms, fit.beta, covariance, dfReference, level, H).map((row, index) => {
      const base = withAccurateTail({ ...row, hacStandardError: hacStandardErrors[index] }, H);
      if (dfReference !== null) return base;
      return {
        ...base,
        lower: base.estimate - normalReferenceCritical * base.standardError,
        upper: base.estimate + normalReferenceCritical * base.standardError,
      };
    });
    const alphaRow = rows[0];
    const residualVolatility = Math.sqrt(fit.sigma2);
    const rSquared = fit.rSquared;
    const adjustedRSquared = 1 - (1 - rSquared) * (periods - 1) / (periods - parameters);
    const informationRatio = alphaRow.estimate / residualVolatility * Math.sqrt(annualFactor);
    const annualisedAlpha = alphaRow.estimate * annualFactor;
    const statisticLabel = dfReference === null ? "z" : "t";
    const referenceName = dfReference === null ? "normal" : "t";

    const summaryRows = [
      { quantity: "Alpha (per period)", value: alphaRow.estimate, basis: `${estimator} standard error ${alphaRow.standardError}` },
      { quantity: "Annualised alpha", value: annualisedAlpha, basis: `arithmetic annualisation: alpha x ${annualFactor} periods per year, no compounding` },
      { quantity: "Annualised alpha CI lower", value: alphaRow.lower * annualFactor, basis: `${Math.round(level * 100)}% interval scaled arithmetically` },
      { quantity: "Annualised alpha CI upper", value: alphaRow.upper * annualFactor, basis: `${Math.round(level * 100)}% interval scaled arithmetically` },
      { quantity: "R squared", value: rSquared, basis: "1 - RSS/TSS about the sample mean" },
      { quantity: "Adjusted R squared", value: adjustedRSquared, basis: `1 - (1 - R2)(T - 1)/(T - ${parameters})` },
      { quantity: "Residual volatility (per period)", value: residualVolatility, basis: `sqrt(RSS / (T - ${parameters}))` },
      { quantity: "Annualised residual volatility", value: residualVolatility * Math.sqrt(annualFactor), basis: `residual sd x sqrt(${annualFactor})` },
      { quantity: "Information ratio (annualised)", value: informationRatio, basis: `alpha / residual sd x sqrt(${annualFactor})` },
      { quantity: "Newey-West lag length", value: hac.lags, basis: hac.rule },
      { quantity: "Periods", value: periods, basis: "observations used, in the supplied time order" },
    ];

    // Characteristic line: fitted excess return against the first factor with the other factors
    // held at their sample means, plus the confidence band from the reported coefficient covariance.
    const primary = parsed.factors[0];
    const otherMeans = parsed.factors.map((factor) => K.mean(factor.values));
    const { min: primaryMin, max: primaryMax } = H.minMax(primary.values);
    const critical = criticalValue(dfReference, level, H);
    const bandRows = [];
    for (let index = 0; index < BAND_POINTS; index += 1) {
      const value = primaryMin + (primaryMax - primaryMin) * index / (BAND_POINTS - 1);
      const row = [1, ...otherMeans];
      row[1] = value;
      const fitted = K.dot(row, fit.beta);
      const standardError = Math.sqrt(Math.max(0, H.quadraticForm(row, covariance)));
      bandRows.push({ factor: value, fit: fitted, lower: fitted - critical * standardError, upper: fitted + critical * standardError });
      budget.check(parameters);
    }
    const scatterRows = primary.values.map((value, index) => ({ factor: value, excessReturn: y[index], period: index + 1, residual: fit.residuals[index] }));

    const artifacts = [
      H.tableArtifact(
        `Factor model coefficients: ${parsed.label}`,
        `Time-series regression of ${parsed.label} on a constant and ${parsed.factors.length} factor(s). Intervals use the ${estimator} covariance against a ${referenceName} reference; the Newey-West column is reported for every fit.`,
        K.coefficientColumns(statisticLabel, [{ key: "hacStandardError", label: `Newey-West SE (L = ${hac.lags})`, type: "number" }]),
        rows,
        [
          `Reported covariance: ${estimator}. Newey-West lag length ${hac.lags} chosen ${hac.selection === "automatic" ? "automatically" : "by the analyst"}: ${hac.rule}.`,
          "Robust covariance uses a normal reference and classical covariance a t reference with T - p degrees of freedom, matching statsmodels.",
        ],
        "asset-pricing-coefficient-table",
      ),
      H.tableArtifact(
        `Factor model summary: ${parsed.label}`,
        "Alpha on the sampling frequency and annualised, fit quality, residual volatility, information ratio, and the HAC lag length actually used.",
        SUMMARY_COLUMNS,
        summaryRows,
        ["Annualisation is arithmetic throughout; it is not a compounded return and does not adjust for skewness or autocorrelation in the underlying series."],
        "asset-pricing-summary-table",
      ),
      unanchorForestAxis(
        K.forestPlot(
          H,
          "asset-pricing-coefficient-forest",
          `Alpha and factor loadings with ${Math.round(level * 100)}% intervals: ${parsed.label}`,
          rows.map((row) => ({ ...row, panel: row.term === "alpha" ? "Alpha" : "Factor loadings" })),
          { xTitle: `Estimate (${estimator} covariance)`, rowFacet: "panel" },
        ),
        { independentX: true },
      ),
      H.vegaArtifact("asset-pricing-characteristic-line", `Characteristic line against ${primary.name}: ${parsed.label}`, {
        layer: [
          {
            data: { values: bandRows },
            mark: { type: "area", opacity: 0.25, color: "#4E6E64" },
            encoding: {
              x: { field: "factor", type: "quantitative", title: primary.name, scale: H.MEASUREMENT_SCALE },
              y: { field: "lower", type: "quantitative", title: parsed.label, scale: H.MEASUREMENT_SCALE },
              y2: { field: "upper" },
            },
          },
          {
            data: { values: bandRows },
            mark: { type: "line", color: "#1F4E79", strokeWidth: 2 },
            encoding: {
              x: { field: "factor", type: "quantitative", scale: H.MEASUREMENT_SCALE },
              y: { field: "fit", type: "quantitative", scale: H.MEASUREMENT_SCALE },
            },
          },
          {
            data: { values: scatterRows },
            mark: { type: "point", filled: true, size: 55, opacity: 0.8, color: "#B24A3B" },
            encoding: {
              x: { field: "factor", type: "quantitative", scale: H.MEASUREMENT_SCALE },
              y: { field: "excessReturn", type: "quantitative", scale: H.MEASUREMENT_SCALE },
              tooltip: [{ field: "period" }, { field: "factor", format: ".5g" }, { field: "excessReturn", format: ".5g" }, { field: "residual", format: ".5g" }],
            },
          },
        ],
      }),
    ];

    return {
      sample: {
        periods,
        factors: parsed.factors.length,
        parameters,
        label: parsed.label,
        periodsPerYear: annualFactor,
        covariance: estimator,
        hacLags: hac.lags,
      },
      estimates: [
        { name: "alpha", estimate: alphaRow.estimate, standardError: alphaRow.standardError, statistic: alphaRow.statistic, pValue: alphaRow.pValue, lower: alphaRow.lower, upper: alphaRow.upper, scale: "per period" },
        { name: "annualised alpha", estimate: annualisedAlpha, standardError: alphaRow.standardError * annualFactor, lower: alphaRow.lower * annualFactor, upper: alphaRow.upper * annualFactor, method: `arithmetic annualisation (alpha x ${annualFactor}); not a compounded return` },
        ...rows.slice(1).map((row) => ({ name: `${row.term} loading`, estimate: row.estimate, standardError: row.standardError, statistic: row.statistic, pValue: row.pValue, lower: row.lower, upper: row.upper })),
        { name: "R squared", estimate: rSquared },
        { name: "adjusted R squared", estimate: adjustedRSquared },
        { name: "residual volatility", estimate: residualVolatility, scale: "per period" },
        { name: "information ratio", estimate: informationRatio, method: `alpha / residual sd x sqrt(${annualFactor})` },
      ],
      tests: rows.map((row) => ({
        name: row.term === "alpha" ? "alpha is zero" : `${row.term} loading is zero`,
        statistic: row.statistic,
        distribution: referenceName,
        df: row.df,
        pValue: row.pValue,
      })),
      confidenceIntervals: [
        ...rows.map((row) => ({ parameter: row.term, level, lower: row.lower, upper: row.upper, method: `${estimator} covariance with a ${referenceName} reference` })),
        { parameter: "annualised alpha", level, lower: alphaRow.lower * annualFactor, upper: alphaRow.upper * annualFactor, method: `arithmetic annualisation of the ${estimator} interval` },
      ],
      effectSizes: [
        { name: "annualised alpha", estimate: annualisedAlpha },
        { name: "information ratio", estimate: informationRatio },
        { name: "R squared", estimate: rSquared },
      ],
      assumptions: [
        { name: "returns are already in excess of the risk-free rate", status: "requires_data_review" },
        { name: "observations are supplied in ascending time order", status: "assumed", detail: "HAC weighting reads row adjacency as lag; shuffled rows produce a wrong answer without an error" },
        { name: "constant factor loadings over the sample", status: "not_established" },
        { name: "stationary factor and residual moments", status: "not_established" },
        {
          name: "homoskedastic and serially uncorrelated errors",
          status: estimator === "classical" ? "required_for_the_reported_standard_errors" : `relaxed_by_${estimator}`,
        },
      ],
      diagnostics: [
        {
          name: "HAC standard errors",
          status: "computed",
          lags: hac.lags,
          lagSelection: hac.selection,
          lagRule: hac.rule,
          kernel: "Bartlett (Newey-West), no small-sample correction",
          standardErrors: terms.map((term, index) => ({ term, standardError: hacStandardErrors[index] })),
          boundary: "HAC repairs the standard errors only; it does not repair a misspecified mean model, structural breaks, or non-stationary loadings",
        },
        {
          name: "covariance estimator",
          status: "resolved",
          reported: estimator,
          declaredDefault: DEFAULT_COVARIANCE,
          supported: [...COVARIANCE_CHOICES],
          inferenceReference: referenceName,
          boundary: "engine.cjs's shared option parser accepts classical, hc0, hc1, hc2, hc3 and substitutes classical for an omitted value; until it also accepts hac, an explicit hac request cannot reach this method and the Newey-West numbers are available only in this diagnostic and in the coefficient table column",
        },
        { name: "residual first-order autocorrelation", statistic: firstOrderAutocorrelation(fit.residuals), status: "screen_only", boundary: "a single lag-1 ratio, not a Ljung-Box or Durbin-Watson test" },
        H.jarqueBera(fit.residuals, budget),
        { name: "annualisation convention", status: "arithmetic", periodsPerYear: annualFactor, detail: "estimate x periodsPerYear for alpha and sqrt(periodsPerYear) for volatility; no compounding and no autocorrelation adjustment" },
        { name: "residual range", ...H.minMax(fit.residuals) },
      ],
      artifacts,
    };
  },
  linkage: {
    neededWhen: "When a fund, strategy, or test portfolio has a return history and the question is whether it earns anything beyond exposure to the declared factors.",
    decision: "Whether alpha is distinguishable from zero once serial correlation and heteroskedasticity are allowed for, and what factor exposures the return series actually carries.",
    mustShow: "Alpha and every loading with its standard error, reference distribution, p value and interval; the annualised alpha and how it was annualised; R squared, residual volatility, the information ratio, and the HAC lag length with how it was chosen.",
    userGoal: "Report a defensible alpha with an uncertainty a referee can check, and know which factor exposures explain the rest of the return.",
    nextActions: [
      { trigger: "alpha-interval-excludes-zero", action: "report-annualised-alpha-with-its-interval-and-the-covariance-used", reason: "An alpha claim is only readable together with the estimator that produced its standard error." },
      { trigger: "residual-autocorrelation-visible", action: "raise-the-hac-lag-length-and-refit-before-reporting", reason: "A lag length shorter than the dependence in the residuals understates the standard error." },
      { trigger: "loading-far-from-the-prior-exposure", action: "open-the-return-series-and-check-the-sample-window-and-factor-alignment", reason: "A loading that contradicts the mandate is usually a data alignment problem, not a discovery." },
      { trigger: "low-r-squared", action: "consider-additional-declared-factors-before-interpreting-alpha", reason: "Alpha measured against an incomplete factor set absorbs the omitted exposure." },
    ],
  },
  fixture: {
    data: {
      excessReturns: [
        0.025395, 0.017006, 0.091233, -0.050438, -0.028961, 0.010532, 0.061507, -0.046475,
        -0.075133, -0.070277, -0.003597, -0.073058, 0.034702, 0.050336, -0.098335, 0.034129,
        -0.021186, -0.034579, -0.069104, 0.102231, 0.002664, -0.029015, 0.008875, -0.009421,
        0.003934, 0.052163, 0.023789, -0.040497, -0.025368, -0.00446, 0.086726, -0.007663,
        -0.060044, -0.046018, -0.00061, -0.006947, 0.010847, 0.002183, 0.00542, 0.01804,
        0.066351, -0.079167, 0.036071, 0.032181, -0.015712, -0.035775, 0.01573, 0.021411,
        -0.023578, 0.018666, 0.018357, 0.080264, 0.01652, -0.037334, 0.063945, 0.041049,
        -0.030711, 0.066522, -0.042197, 0.011746,
      ],
      factors: [
        {
          name: "Mkt-RF",
          values: [
            -0.014507, 0.006297, 0.038084, -0.054965, -0.037078, -0.004888, 0.062803, -0.008243,
            -0.079004, -0.067287, -0.020619, -0.068093, 0.004174, 0.040196, -0.06252, 0.041188,
            -0.017534, 0.002694, -0.085513, 0.066365, 0.02556, -0.040134, 0.035563, 0.016554,
            -0.010941, 0.030918, -0.004749, -0.03668, -0.028965, -0.029846, 0.043267, -0.047638,
            -0.054362, -0.027333, 0.007919, -0.040554, -0.006762, 0.011859, -0.025307, 0.011997,
            0.076872, -0.0425, 0.016364, 0.050303, -0.027425, 0.013911, -0.006477, 0.029196,
            -0.034955, -0.011488, -0.037065, 0.060326, 0.007152, -0.053611, 0.045156, 0.00038,
            -0.040693, 0.065587, -0.003226, 0.032189,
          ],
        },
        {
          name: "SMB",
          values: [
            0.045474, 0.034575, 0.026126, 0.012705, -0.018601, -0.041678, 0.006524, -0.010217,
            0.0255, -0.01214, 0.041619, -0.027679, 0.014892, -0.007398, 0.005349, 0.04174,
            -0.011748, -0.016269, 0.064655, 0.020565, -0.031645, 0.009548, -0.043316, -0.016934,
            0.038902, -0.018692, 0.023334, -0.030676, 0.006363, 0.049637, 0.0078, 0.002901,
            -0.012668, -0.0005, -0.037057, 0.038623, 0.000438, 0.01845, 0.013644, 0.026216,
            -0.013566, -0.033482, 0.008786, -0.004295, 0.021337, -0.030218, -0.002877, 0.002547,
            0.01149, 0.030863, 0.052172, 0.027794, 0.024835, -0.00425, -0.027513, 0.048546,
            -0.025178, -0.020852, -0.027107, -0.028012,
          ],
        },
        {
          name: "HML",
          values: [
            -0.031973, 0.031414, 0.006414, -0.03558, -0.060355, -0.004217, -0.015838, 0.041203,
            -0.002459, 0.052113, 0.064654, 0.006201, 0.017816, -0.005767, -0.028457, -0.012984,
            0.015564, 0.046002, -0.006685, -0.002427, -0.007105, -0.008232, 0.015094, -0.012505,
            0.005571, 0.020065, -0.017481, -0.020404, 0.015576, 0.010715, -0.018448, -0.036423,
            -0.055487, -0.026628, -0.021588, 0.004122, 3.1e-05, 0.022926, 0.00641, -0.045489,
            -0.005287, 0.037849, 0.002521, -0.003829, 0.003956, 0.050197, 0.022167, 0.013586,
            0.056088, 0.013265, -0.023944, -0.01637, -0.006562, -0.000926, -0.03623, 0.017021,
            0.011602, -0.017036, -0.016328, 0.012635,
          ],
        },
      ],
      label: "Portfolio 1 excess return",
    },
    options: { hacLags: 4, periodsPerYear: 12 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "Time-series excess-return regression on a constant and up to twelve supplied factors, with classical, Newey-West HAC, and HC1/HC2/HC3 covariance, arithmetic annualisation of alpha and volatility, the information ratio, and a characteristic line with a coefficient-covariance confidence band.",
    oracle: {
      level: "external-library-partial",
      evidence: ["contracts/asset-pricing-statsmodels-crosscheck.py"],
      verifiedOutputs: [
        "alpha and factor loadings against statsmodels OLS",
        "Newey-West HAC standard errors against statsmodels cov_type=HAC with use_correction=False",
        "classical and HC1/HC2/HC3 standard errors against statsmodels",
        "R squared, adjusted R squared, and residual standard error",
      ],
      excludedOutputs: [
        "annualised alpha and annualised residual volatility (a reporting convention, not a library output)",
        "the information ratio",
        "the confidence band drawn on the characteristic line",
      ],
    },
    diagnostic: {
      level: "method-specific-partial",
      emitted: ["HAC lag length with how it was chosen and the per-term HAC standard errors", "the covariance estimator actually reported and its reference distribution", "residual first-order autocorrelation and a Jarque-Bera residual screen"],
      limitations: ["no Ljung-Box, Durbin-Watson, or breakpoint test", "no rolling or time-varying loadings", "no check that the supplied returns are genuinely in excess of a risk-free rate"],
    },
    knownGaps: [
      "engine.cjs's shared option parser does not yet accept covariance=hac, so the declared default cannot be requested through the engine and the reported intervals fall back to classical; the HAC standard errors are still computed and reported in the coefficient table and diagnostics",
      "no GMM or errors-in-variables treatment of estimated factor loadings",
      "no Sharpe-ratio or turnover statistics",
      "no adjustment for overlapping return horizons beyond the HAC lag length",
    ],
  },
};

// ---------------------------------------------------------------------------------
// B. fama_macbeth_regression
// ---------------------------------------------------------------------------------

/** Period keys must be all numbers or all strings so the sort order is defined. */
function parsePeriods(raw, n, H) {
  if (!Array.isArray(raw) || raw.length !== n) H.fail("STAT_INVALID_INPUT", `data.period must be an array of ${n} period labels`);
  const numeric = raw.every((item) => typeof item === "number");
  const textual = raw.every((item) => typeof item === "string");
  if (!numeric && !textual) H.fail("STAT_INVALID_INPUT", "data.period must be either all numbers or all strings");
  if (numeric) return { keys: raw.map((item, index) => H.finiteNumber(item, `data.period[${index}]`)), numeric: true };
  return { keys: H.categoryVector(raw, "data.period", n), numeric: false };
}

function groupByPeriod(periods, H) {
  const order = [];
  const index = new Map();
  periods.keys.forEach((key, row) => {
    const mapKey = periods.numeric ? `n:${key}` : `s:${key}`;
    if (!index.has(mapKey)) {
      index.set(mapKey, { key, label: String(key), rows: [] });
      order.push(mapKey);
    }
    index.get(mapKey).rows.push(row);
  });
  const groups = order.map((mapKey) => index.get(mapKey));
  groups.sort((a, b) => (periods.numeric ? a.key - b.key : a.label.localeCompare(b.label, "en")));
  if (groups.length < MIN_PANEL_PERIODS) H.fail("STAT_INSUFFICIENT_SAMPLE", `Fama-MacBeth needs at least ${MIN_PANEL_PERIODS} periods`);
  return groups;
}

/**
 * Newey-West covariance of the mean of a coefficient time series.
 *
 * S = S(0) + sum_{l=1..L} (1 - l/(L+1)) (S(l) + S(l)'), S(l) = (1/(T-1)) sum_{t>l} (g_t - g)(g_{t-l} - g)',
 * and Var(mean) = S / T. The (T - 1) denominator is what makes lag 0 reproduce the classic
 * Fama-MacBeth standard error sqrt(sum (g_t - g)^2 / (T (T - 1))) exactly.
 */
function neweyWestMeanCovariance(series, mean, lags, budget) {
  const periods = series.length;
  const parameters = mean.length;
  const centered = series.map((row) => row.map((value, index) => value - mean[index]));
  const scaled = Array.from({ length: parameters }, () => Array(parameters).fill(0));
  const add = (lag, weight) => {
    for (let t = lag; t < periods; t += 1) {
      const current = centered[t];
      const previous = centered[t - lag];
      for (let i = 0; i < parameters; i += 1) {
        for (let j = 0; j < parameters; j += 1) {
          scaled[i][j] += lag === 0
            ? weight * current[i] * current[j]
            : weight * (current[i] * previous[j] + previous[i] * current[j]);
        }
      }
      if (budget) budget.check(parameters);
    }
  };
  add(0, 1);
  for (let lag = 1; lag <= lags; lag += 1) add(lag, 1 - lag / (lags + 1));
  const denominator = periods - 1;
  return scaled.map((row) => row.map((value) => value / denominator / periods));
}

const famaMacBethRegression = {
  method: "fama_macbeth_regression",
  family: "asset-pricing",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    neweyWestLags: {
      schema: { type: "integer", minimum: 0, maximum: MAX_HAC_LAGS },
      default: 0,
      parse(value, H, path) { return H.integer(value, 0, MAX_HAC_LAGS, path); },
    },
    periodsPerYear: {
      schema: { type: "integer", minimum: 1, maximum: 366 },
      default: 12,
      parse(value, H, path) { return H.integer(value, 1, 366, path); },
    },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["period", "asset", "returns", "exposures"],
    properties: {
      period: { type: "array", minItems: 10, items: { type: ["number", "string"] } },
      asset: { type: "array", minItems: 10, items: { type: "string", minLength: 1, maxLength: 128 } },
      returns: { type: "array", minItems: 10, items: { type: "number" } },
      exposures: {
        type: "array",
        minItems: 1,
        maxItems: MAX_FACTORS,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "values"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 128 },
            values: { type: "array", minItems: 10, items: { type: "number" } },
          },
        },
      },
      label: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["period", "asset", "returns", "exposures", "label"], "data");
    for (const key of ["period", "asset", "returns", "exposures"]) {
      if (data[key] === undefined) H.fail("STAT_INVALID_INPUT", `data.${key} is required`);
    }
    const returns = H.numericVector(data.returns, "data.returns", 10);
    const rows = returns.length;
    const asset = H.categoryVector(data.asset, "data.asset", 2);
    if (asset.length !== rows) H.fail("STAT_INVALID_INPUT", "data.asset must have one entry per row of data.returns");
    const period = parsePeriods(data.period, rows, H);
    const exposures = parseSeriesBlock(data.exposures, rows, H, "data.exposures");
    assertInterceptNameFree(exposures.map((item) => item.name), H, "data.exposures");
    const pairs = new Set();
    for (let row = 0; row < rows; row += 1) {
      const key = `${period.numeric ? "n" : "s"}:${period.keys[row]}\u0000${asset[row]}`;
      if (pairs.has(key)) H.fail("STAT_INVALID_INPUT", `data has two rows for asset ${asset[row]} in period ${period.keys[row]}`);
      pairs.add(key);
    }
    return { period, asset, returns, exposures, label: H.label(data.label, "Excess return", "data.label") };
  },
  analyze(parsed, options, budget, H) {
    const terms = ["intercept", ...parsed.exposures.map((item) => item.name)];
    const parameters = terms.length;
    const groups = groupByPeriod(parsed.period, H);
    const level = options.confidenceLevel;
    const lags = options.neweyWestLags === undefined ? 0 : options.neweyWestLags;
    const annualFactor = periodsPerYear(options);
    if (lags >= groups.length) H.fail("STAT_INVALID_INPUT", `options.neweyWestLags must be smaller than the ${groups.length} periods`);

    const series = [];
    const periodRows = [];
    const seriesRows = [];
    const crossSectional = [];
    groups.forEach((group, index) => {
      const path = `period ${group.label}`;
      if (group.rows.length <= parameters) {
        H.fail("STAT_INSUFFICIENT_SAMPLE", `${path} has ${group.rows.length} assets, which cannot identify ${parameters} cross-sectional coefficients`);
      }
      const y = group.rows.map((row) => parsed.returns[row]);
      const x = group.rows.map((row) => [1, ...parsed.exposures.map((item) => item.values[row])]);
      const fit = K.olsFit(y, x, H, budget, { covariance: "classical" });
      const standardErrors = diagonalStandardErrors(fit.covariance, H, `${path} cross-sectional`);
      series.push(fit.beta);
      crossSectional.push({ rSquared: fit.rSquared, assets: group.rows.length, df: fit.df });
      const row = { period: group.label, periodIndex: index + 1, assets: group.rows.length, rSquared: fit.rSquared };
      terms.forEach((term, termIndex) => {
        row[`coefficient${termIndex}`] = fit.beta[termIndex];
        row[`standardError${termIndex}`] = standardErrors[termIndex];
      });
      periodRows.push(row);
      const critical = H.tCritical(level, fit.df);
      terms.forEach((term, termIndex) => {
        seriesRows.push({
          period: group.label,
          periodIndex: index + 1,
          term,
          estimate: fit.beta[termIndex],
          lower: fit.beta[termIndex] - critical * standardErrors[termIndex],
          upper: fit.beta[termIndex] + critical * standardErrors[termIndex],
        });
      });
    });

    const periods = series.length;
    const premia = terms.map((_, index) => K.mean(series.map((row) => row[index])));
    const covariance = neweyWestMeanCovariance(series, premia, lags, budget);
    const rows = K.coefficientRows(terms, premia, covariance, periods - 1, level, H)
      .map((row) => withAccurateTail({ ...row, annualised: row.estimate * annualFactor, periods }, H));
    const averageRSquared = K.mean(crossSectional.map((item) => item.rSquared));
    const meanByTerm = new Map(rows.map((row) => [row.term, row.estimate]));
    for (const row of seriesRows) row.mean = meanByTerm.get(row.term);

    const periodColumns = [
      { key: "period", label: "Period", type: "string" },
      { key: "periodIndex", label: "Order", type: "number" },
      { key: "assets", label: "Assets", type: "number" },
      { key: "rSquared", label: "Cross-sectional R2", type: "number" },
      ...terms.flatMap((term, index) => ([
        { key: `coefficient${index}`, label: term, type: "number" },
        { key: `standardError${index}`, label: `${term} SE`, type: "number" },
      ])),
    ];

    const artifacts = [
      H.tableArtifact(
        `Fama-MacBeth risk premia: ${parsed.label}`,
        `Average of ${periods} cross-sectional coefficient estimates, with the Newey-West standard error of that average at lag ${lags}.`,
        K.coefficientColumns("t", [
          { key: "annualised", label: `Annualised (x ${annualFactor})`, type: "number" },
          { key: "periods", label: "Periods", type: "number" },
        ]),
        rows,
        [
          lags === 0
            ? "Lag 0 reproduces the classic Fama-MacBeth standard error sqrt(sum (g_t - g)^2 / (T (T - 1)))."
            : `Bartlett weights 1 - l/(L+1) up to L = ${lags}, applied to the coefficient time series and divided by T.`,
          `t statistics use T - 1 = ${periods - 1} degrees of freedom. Annualisation is arithmetic.`,
        ],
        "fama-macbeth-premium-table",
      ),
      H.tableArtifact(
        `Fama-MacBeth per-period coefficients: ${parsed.label}`,
        "Every cross-sectional regression that entered the average, in ascending period order, with its own standard errors and fit.",
        periodColumns,
        periodRows,
        [`Average cross-sectional R squared: ${averageRSquared}.`, "Each row is a separate ordinary least-squares fit across the assets available in that period."],
        "fama-macbeth-period-table",
      ),
      unanchorForestAxis(K.forestPlot(H, "fama-macbeth-premium-forest", `Risk premia with ${Math.round(level * 100)}% intervals: ${parsed.label}`, rows, { xTitle: "Average cross-sectional coefficient" })),
      H.vegaArtifact("fama-macbeth-coefficient-series", `Per-period cross-sectional coefficients with ${Math.round(level * 100)}% intervals`, {
        data: { values: seriesRows },
        facet: { row: { field: "term", type: "nominal", title: null } },
        spec: {
          layer: [
            {
              mark: { type: "rule", strokeWidth: 1.5, color: "#1F4E79", opacity: 0.7 },
              encoding: {
                x: { field: "periodIndex", type: "quantitative", title: "Period (ascending order)", scale: H.MEASUREMENT_SCALE },
                y: { field: "lower", type: "quantitative", title: "Cross-sectional coefficient", scale: H.MEASUREMENT_SCALE },
                y2: { field: "upper" },
              },
            },
            {
              mark: { type: "point", filled: true, size: 55, color: "#1F4E79" },
              encoding: {
                x: { field: "periodIndex", type: "quantitative", scale: H.MEASUREMENT_SCALE },
                y: { field: "estimate", type: "quantitative", scale: H.MEASUREMENT_SCALE },
                tooltip: [{ field: "period" }, { field: "term" }, { field: "estimate", format: ".5g" }, { field: "lower", format: ".5g" }, { field: "upper", format: ".5g" }],
              },
            },
            {
              mark: { type: "line", color: "#4E6E64", strokeWidth: 2 },
              encoding: {
                x: { field: "periodIndex", type: "quantitative", scale: H.MEASUREMENT_SCALE },
                y: { field: "mean", type: "quantitative", scale: H.MEASUREMENT_SCALE },
              },
            },
            { mark: { type: "rule", strokeDash: [4, 4], color: "#777" }, encoding: { y: { datum: 0 } } },
          ],
        },
        resolve: { scale: { y: "independent" } },
      }),
    ];

    return {
      sample: {
        rows: parsed.returns.length,
        periods,
        assets: new Set(parsed.asset).size,
        exposures: parsed.exposures.length,
        label: parsed.label,
        periodsPerYear: annualFactor,
        neweyWestLags: lags,
      },
      estimates: rows.map((row) => ({
        name: row.term === "intercept" ? "intercept (zero-beta rate)" : `${row.term} risk premium`,
        estimate: row.estimate,
        standardError: row.standardError,
        statistic: row.statistic,
        pValue: row.pValue,
        lower: row.lower,
        upper: row.upper,
        annualised: row.annualised,
      })).concat([
        { name: "average cross-sectional R squared", estimate: averageRSquared },
        { name: "periods", estimate: periods },
      ]),
      tests: rows.map((row) => ({ name: `${row.term} premium is zero`, statistic: row.statistic, distribution: "t", df: periods - 1, pValue: row.pValue })),
      confidenceIntervals: rows.map((row) => ({ parameter: row.term, level, lower: row.lower, upper: row.upper, method: lags === 0 ? "classic Fama-MacBeth standard error with a t reference" : `Newey-West lag ${lags} on the coefficient series with a t reference` })),
      effectSizes: rows.filter((row) => row.term !== "intercept").map((row) => ({ name: `${row.term} annualised premium`, estimate: row.annualised })),
      assumptions: [
        { name: "exposures are known, not estimated in a prior pass from the same returns", status: "requires_design_review", detail: "estimated exposures introduce an errors-in-variables bias that this method does not correct" },
        { name: "periods are independent apart from the declared Newey-West lags", status: lags === 0 ? "required_for_the_reported_standard_errors" : "relaxed_up_to_the_declared_lag" },
        { name: "cross-sectional relation is linear in the supplied exposures", status: "not_established" },
        { name: "asset composition may change between periods", status: "allowed", detail: "each period is fitted on the assets present in that period only" },
      ],
      diagnostics: [
        { name: "second-pass standard error", status: "computed", lags, kernel: lags === 0 ? "none (classic Fama-MacBeth)" : "Bartlett (Newey-West) on the coefficient time series", denominator: "sum of squares divided by T - 1, then divided by T" },
        { name: "cross-sectional fits", status: "evaluated", periods, minimumAssets: Math.min(...crossSectional.map((item) => item.assets)), maximumAssets: Math.max(...crossSectional.map((item) => item.assets)), averageRSquared },
        { name: "period ordering", status: parsed.period.numeric ? "numeric_ascending" : "lexicographic_ascending", boundary: "the sort defines the lag structure; string labels must sort into true time order" },
        { name: "errors-in-variables", status: "not_corrected", boundary: "no Shanken correction is applied, so standard errors are understated when exposures are pre-estimated" },
      ],
      artifacts,
    };
  },
  linkage: {
    neededWhen: "When a panel of asset returns and asset characteristics is available and the question is what the market paid per unit of exposure, period by period.",
    decision: "Whether the average cross-sectional price of each exposure is distinguishable from zero once the period-to-period variation in that price is accounted for.",
    mustShow: "Each risk premium with its standard error, t statistic, p value and interval; the number of periods; the average cross-sectional fit; and the whole per-period coefficient series that was averaged.",
    userGoal: "Report a priced factor with an honest standard error, and be able to see whether the average is carried by a few unusual periods.",
    nextActions: [
      { trigger: "premium-interval-excludes-zero", action: "report-the-premium-with-the-period-count-and-the-lag-length-used", reason: "A Fama-MacBeth t statistic is only interpretable together with the number of periods behind it." },
      { trigger: "coefficient-series-shows-persistence", action: "raise-newey-west-lags-and-refit-before-reporting", reason: "Serially correlated premia make the lag-zero standard error too small." },
      { trigger: "few-assets-in-some-periods", action: "open-those-periods-and-decide-inclusion-before-averaging", reason: "A thin cross-section produces a wild coefficient that moves the average without carrying information." },
      { trigger: "exposures-were-estimated-from-returns", action: "plan-a-shanken-or-portfolio-grouping-correction", reason: "Errors in estimated exposures bias the second pass and are not corrected here." },
    ],
  },
  fixture: {
    data: {
      period: [
        "1990-01", "1990-01", "1990-01", "1990-01", "1990-01", "1990-01", "1990-01", "1990-01",
        "1990-02", "1990-02", "1990-02", "1990-02", "1990-02", "1990-02", "1990-02", "1990-02",
        "1990-03", "1990-03", "1990-03", "1990-03", "1990-03", "1990-03", "1990-03", "1990-03",
        "1990-04", "1990-04", "1990-04", "1990-04", "1990-04", "1990-04", "1990-04", "1990-04",
        "1990-05", "1990-05", "1990-05", "1990-05", "1990-05", "1990-05", "1990-05", "1990-05",
        "1990-06", "1990-06", "1990-06", "1990-06", "1990-06", "1990-06", "1990-06", "1990-06",
        "1990-07", "1990-07", "1990-07", "1990-07", "1990-07", "1990-07", "1990-07", "1990-07",
        "1990-08", "1990-08", "1990-08", "1990-08", "1990-08", "1990-08", "1990-08", "1990-08",
        "1990-09", "1990-09", "1990-09", "1990-09", "1990-09", "1990-09", "1990-09", "1990-09",
        "1990-10", "1990-10", "1990-10", "1990-10", "1990-10", "1990-10", "1990-10", "1990-10",
        "1990-11", "1990-11", "1990-11", "1990-11", "1990-11", "1990-11", "1990-11", "1990-11",
        "1990-12", "1990-12", "1990-12", "1990-12", "1990-12", "1990-12", "1990-12", "1990-12",
        "1991-01", "1991-01", "1991-01", "1991-01", "1991-01", "1991-01", "1991-01", "1991-01",
        "1991-02", "1991-02", "1991-02", "1991-02", "1991-02", "1991-02", "1991-02", "1991-02",
        "1991-03", "1991-03", "1991-03", "1991-03", "1991-03", "1991-03", "1991-03", "1991-03",
      ],
      asset: [
        "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8",
        "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8",
        "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8",
        "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8",
        "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8",
        "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8",
        "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8",
        "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8",
        "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8",
        "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8",
        "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8",
        "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8",
        "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8",
        "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8",
        "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8",
      ],
      returns: [
        0.003353, -0.041967, -0.019835, -0.000749, -0.028682, -0.001084, -0.016799, -0.011458,
        0.020876, 0.023652, 0.068451, 0.034712, 0.033499, 0.021019, 0.050046, 0.004609,
        -0.023714, -0.023822, -0.01496, -0.025342, -0.036514, -0.027262, -0.024945, 0.003645,
        0.045853, 0.051774, 0.078605, 0.045432, 0.056615, 0.074479, 0.078217, 0.038152,
        -0.003226, -0.05289, -0.074345, -0.052464, -0.0619, -0.049447, -0.041073, -0.048626,
        0.006885, 0.029787, 0.055798, 0.039494, 0.008973, 0.029441, 0.012194, 0.010927,
        0.027081, 0.00486, 0.011533, 0.013608, -0.002276, 0.028303, 0.027071, -0.002205,
        0.065945, 0.070007, 0.071199, 0.054516, 0.091046, 0.102184, 0.085998, 0.08081,
        0.025142, 0.026906, 0.008258, 0.010979, 0.035235, 0.056735, 0.043384, -0.018093,
        0.008934, -0.000605, 0.003376, 0.015766, -0.013979, 0.001641, -0.014932, 0.021596,
        -0.022697, -0.029211, -0.03845, -0.02568, -0.04441, -0.063177, -0.043961, -0.008206,
        -0.000956, 0.002701, 0.01014, 0.018593, 0.00308, 0.03444, 0.003247, 0.008345,
        0.012851, 0.001907, 0.036671, 0.01411, 0.033913, 0.025004, 0.038956, 0.017352,
        0.02427, 0.028761, 0.05389, 0.031222, 0.036805, 0.041687, 0.052341, 0.024953,
        -0.019972, -0.017663, 0.010514, -0.010821, -0.005161, -0.005777, 0.010441, -0.021897,
      ],
      exposures: [
        {
          name: "market beta",
          values: [
            0.5901, 0.8252, 1.3971, 0.9263, 1.1822, 1.1638, 1.2951, 0.7248,
            0.5901, 0.8252, 1.3971, 0.9263, 1.1822, 1.1638, 1.2951, 0.7248,
            0.5901, 0.8252, 1.3971, 0.9263, 1.1822, 1.1638, 1.2951, 0.7248,
            0.5901, 0.8252, 1.3971, 0.9263, 1.1822, 1.1638, 1.2951, 0.7248,
            0.5901, 0.8252, 1.3971, 0.9263, 1.1822, 1.1638, 1.2951, 0.7248,
            0.5901, 0.8252, 1.3971, 0.9263, 1.1822, 1.1638, 1.2951, 0.7248,
            0.5901, 0.8252, 1.3971, 0.9263, 1.1822, 1.1638, 1.2951, 0.7248,
            0.5901, 0.8252, 1.3971, 0.9263, 1.1822, 1.1638, 1.2951, 0.7248,
            0.5901, 0.8252, 1.3971, 0.9263, 1.1822, 1.1638, 1.2951, 0.7248,
            0.5901, 0.8252, 1.3971, 0.9263, 1.1822, 1.1638, 1.2951, 0.7248,
            0.5901, 0.8252, 1.3971, 0.9263, 1.1822, 1.1638, 1.2951, 0.7248,
            0.5901, 0.8252, 1.3971, 0.9263, 1.1822, 1.1638, 1.2951, 0.7248,
            0.5901, 0.8252, 1.3971, 0.9263, 1.1822, 1.1638, 1.2951, 0.7248,
            0.5901, 0.8252, 1.3971, 0.9263, 1.1822, 1.1638, 1.2951, 0.7248,
            0.5901, 0.8252, 1.3971, 0.9263, 1.1822, 1.1638, 1.2951, 0.7248,
          ],
        },
        {
          name: "log size",
          values: [
            0.5238, 0.905, -0.7508, -0.7697, 1.1267, 0.1897, 0.777, -0.8181,
            0.5238, 0.905, -0.7508, -0.7697, 1.1267, 0.1897, 0.777, -0.8181,
            0.5238, 0.905, -0.7508, -0.7697, 1.1267, 0.1897, 0.777, -0.8181,
            0.5238, 0.905, -0.7508, -0.7697, 1.1267, 0.1897, 0.777, -0.8181,
            0.5238, 0.905, -0.7508, -0.7697, 1.1267, 0.1897, 0.777, -0.8181,
            0.5238, 0.905, -0.7508, -0.7697, 1.1267, 0.1897, 0.777, -0.8181,
            0.5238, 0.905, -0.7508, -0.7697, 1.1267, 0.1897, 0.777, -0.8181,
            0.5238, 0.905, -0.7508, -0.7697, 1.1267, 0.1897, 0.777, -0.8181,
            0.5238, 0.905, -0.7508, -0.7697, 1.1267, 0.1897, 0.777, -0.8181,
            0.5238, 0.905, -0.7508, -0.7697, 1.1267, 0.1897, 0.777, -0.8181,
            0.5238, 0.905, -0.7508, -0.7697, 1.1267, 0.1897, 0.777, -0.8181,
            0.5238, 0.905, -0.7508, -0.7697, 1.1267, 0.1897, 0.777, -0.8181,
            0.5238, 0.905, -0.7508, -0.7697, 1.1267, 0.1897, 0.777, -0.8181,
            0.5238, 0.905, -0.7508, -0.7697, 1.1267, 0.1897, 0.777, -0.8181,
            0.5238, 0.905, -0.7508, -0.7697, 1.1267, 0.1897, 0.777, -0.8181,
          ],
        },
      ],
      label: "Test asset excess return",
    },
    options: { neweyWestLags: 0, periodsPerYear: 12 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "Two-pass Fama-MacBeth on a long panel: one ordinary least-squares cross-section per period on a constant and up to twelve supplied exposures, the average of those coefficients, and a Newey-West standard error of that average (lag 0 reproduces the classic Fama-MacBeth standard error).",
    oracle: {
      level: "external-library-partial",
      evidence: ["contracts/asset-pricing-statsmodels-crosscheck.py"],
      verifiedOutputs: [
        "per-period cross-sectional coefficients and R squared against statsmodels OLS",
        "average risk premia",
        "Newey-West and classic Fama-MacBeth standard errors of the averages computed directly in numpy",
        "t statistics and p values against a t reference with T - 1 degrees of freedom",
      ],
      excludedOutputs: [
        "annualised premia (a reporting convention)",
        "the per-period intervals drawn on the coefficient-series figure",
      ],
    },
    diagnostic: {
      level: "method-specific-partial",
      emitted: ["the lag length and kernel used for the second-pass standard error", "period count and the smallest and largest cross-section", "how periods were ordered"],
      limitations: ["no Shanken errors-in-variables correction", "no test that the cross-sectional relation is stable across periods", "no weighting by cross-sectional precision"],
    },
    knownGaps: [
      "no Shanken correction for pre-estimated exposures",
      "no generalized least squares or weighted cross-sections",
      "no rolling-window first pass; exposures must be supplied",
      "string period labels are ordered lexicographically, which is only the true time order for zero-padded labels",
    ],
  },
};

// ---------------------------------------------------------------------------------
// C. grs_test
// ---------------------------------------------------------------------------------

const grsTest = {
  method: "grs_test",
  family: "asset-pricing",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    periodsPerYear: {
      schema: { type: "integer", minimum: 1, maximum: 366 },
      default: 12,
      parse(value, H, path) { return H.integer(value, 1, 366, path); },
    },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["portfolios", "factors"],
    properties: {
      portfolios: {
        type: "array",
        minItems: MIN_PORTFOLIOS,
        maxItems: MAX_PORTFOLIOS,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "excessReturns"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 128 },
            excessReturns: { type: "array", minItems: MIN_PERIODS, items: { type: "number" } },
          },
        },
      },
      factors: {
        type: "array",
        minItems: 1,
        maxItems: MAX_FACTORS,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "values"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 128 },
            values: { type: "array", minItems: MIN_PERIODS, items: { type: "number" } },
          },
        },
      },
      label: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["portfolios", "factors", "label"], "data");
    if (data.portfolios === undefined) H.fail("STAT_INVALID_INPUT", "data.portfolios is required");
    if (data.factors === undefined) H.fail("STAT_INVALID_INPUT", "data.factors is required");
    if (!Array.isArray(data.portfolios) || data.portfolios.length < MIN_PORTFOLIOS || data.portfolios.length > MAX_PORTFOLIOS) {
      H.fail("STAT_INVALID_INPUT", `data.portfolios must list between ${MIN_PORTFOLIOS} and ${MAX_PORTFOLIOS} portfolios`);
    }
    const seen = new Set();
    const first = H.assertObject(data.portfolios[0], "data.portfolios[0]");
    H.assertKeys(first, ["name", "excessReturns"], "data.portfolios[0]");
    const periods = H.numericVector(first.excessReturns, "data.portfolios[0].excessReturns", MIN_PERIODS).length;
    const portfolios = data.portfolios.map((raw, index) => {
      const entry = H.assertObject(raw, `data.portfolios[${index}]`);
      H.assertKeys(entry, ["name", "excessReturns"], `data.portfolios[${index}]`);
      const name = H.label(entry.name, `Portfolio ${index + 1}`, `data.portfolios[${index}].name`);
      if (seen.has(name)) H.fail("STAT_INVALID_INPUT", `data.portfolios repeats the name ${name}`);
      seen.add(name);
      const excessReturns = H.numericVector(entry.excessReturns, `data.portfolios[${index}].excessReturns`, MIN_PERIODS);
      if (excessReturns.length !== periods) H.fail("STAT_INVALID_INPUT", `data.portfolios[${index}].excessReturns must hold ${periods} observations, one per period`);
      return { name, excessReturns };
    });
    const factors = parseSeriesBlock(data.factors, periods, H, "data.factors");
    const residualDf = periods - portfolios.length - factors.length;
    if (residualDf < 1) {
      H.fail("STAT_INSUFFICIENT_SAMPLE", `the GRS statistic needs T - N - K >= 1; ${periods} periods with ${portfolios.length} portfolios and ${factors.length} factors gives ${residualDf}`);
    }
    return { portfolios, factors, label: H.label(data.label, "Test portfolios", "data.label") };
  },
  analyze(parsed, options, budget, H) {
    const factorCount = parsed.factors.length;
    const portfolioCount = parsed.portfolios.length;
    const periods = parsed.portfolios[0].excessReturns.length;
    const level = options.confidenceLevel;
    const annualFactor = periodsPerYear(options);
    const x = designRows(parsed.factors, periods);
    const parameters = x[0].length;

    const alphas = [];
    const residuals = [];
    const alphaRows = [];
    const loadingRows = [];
    parsed.portfolios.forEach((portfolio) => {
      const fit = K.olsFit(portfolio.excessReturns, x, H, budget, { covariance: "classical" });
      const terms = ["alpha", ...parsed.factors.map((factor) => factor.name)];
      const rows = K.coefficientRows(terms, fit.beta, fit.covariance, fit.df, level, H);
      alphas.push(fit.beta[0]);
      residuals.push(fit.residuals);
      alphaRows.push(withAccurateTail({ ...rows[0], term: portfolio.name, annualisedAlpha: fit.beta[0] * annualFactor, rSquared: fit.rSquared }, H));
      loadingRows.push({ portfolio: portfolio.name, betas: fit.beta.slice(1), rSquared: fit.rSquared });
    });

    // Sigma: residual covariance across portfolios with the T - K - 1 denominator.
    const residualDenominator = periods - factorCount - 1;
    const sigma = Array.from({ length: portfolioCount }, () => Array(portfolioCount).fill(0));
    for (let i = 0; i < portfolioCount; i += 1) {
      for (let j = i; j < portfolioCount; j += 1) {
        let total = 0;
        for (let t = 0; t < periods; t += 1) total += residuals[i][t] * residuals[j][t];
        const value = total / residualDenominator;
        sigma[i][j] = value;
        sigma[j][i] = value;
      }
      budget.check(portfolioCount);
    }

    const factorMeans = parsed.factors.map((factor) => K.mean(factor.values));
    const centeredFactors = parsed.factors.map((factor, index) => factor.values.map((value) => value - factorMeans[index]));
    const omega = H.covarianceMatrix(centeredFactors, budget);
    const omegaInverse = K.invertSymmetric(omega, H, "STAT_SINGULAR_FIT", "the factor covariance matrix is singular");
    const sigmaInverse = K.invertSymmetric(sigma, H, "STAT_SINGULAR_FIT", "the residual covariance matrix is singular; N portfolios need T - K - 1 >= N for it to be invertible");

    const sharpeSquared = H.quadraticForm(factorMeans, omegaInverse);
    const alphaQuadratic = H.quadraticForm(alphas, sigmaInverse);
    const df1 = portfolioCount;
    const df2 = periods - portfolioCount - factorCount;
    const statistic = ((periods - portfolioCount - factorCount) / portfolioCount) * alphaQuadratic / (1 + sharpeSquared);
    if (!Number.isFinite(statistic) || statistic < 0) H.fail("STAT_DEGENERATE", "the GRS statistic is not a finite non-negative number");
    const pValue = H.pFromF(statistic, df1, df2);
    const meanAbsoluteAlpha = K.mean(alphas.map((value) => Math.abs(value)));

    const summaryRows = [
      { quantity: "GRS F statistic", value: statistic, basis: `((T - N - K)/N) (1 + mu' Omega^-1 mu)^-1 alpha' Sigma^-1 alpha with T = ${periods}, N = ${portfolioCount}, K = ${factorCount}` },
      { quantity: "Numerator degrees of freedom (N)", value: df1, basis: "number of test portfolios" },
      { quantity: "Denominator degrees of freedom (T - N - K)", value: df2, basis: "periods minus portfolios minus factors" },
      { quantity: "p value", value: pValue, basis: "upper tail of F(N, T - N - K)" },
      { quantity: "Mean absolute alpha (per period)", value: meanAbsoluteAlpha, basis: "average of |alpha_i| over the test portfolios" },
      { quantity: "Mean absolute alpha (annualised)", value: meanAbsoluteAlpha * annualFactor, basis: `arithmetic annualisation x ${annualFactor}, no compounding` },
      { quantity: "alpha' Sigma^-1 alpha", value: alphaQuadratic, basis: `Sigma divides by T - K - 1 = ${residualDenominator}` },
      { quantity: "mu' Omega^-1 mu (squared factor Sharpe ratio)", value: sharpeSquared, basis: "Omega is the sample factor covariance with the T - 1 denominator" },
    ];

    const critical = H.tCritical(level, periods - parameters);
    const comparisonRows = parsed.portfolios.map((portfolio, index) => {
      const realised = K.mean(portfolio.excessReturns);
      const standardError = Math.sqrt(K.sampleVariance(portfolio.excessReturns) / periods);
      return {
        portfolio: portfolio.name,
        predicted: realised - alphas[index],
        realised,
        lower: realised - critical * standardError,
        upper: realised + critical * standardError,
        alpha: alphas[index],
      };
    });
    const bounds = comparisonRows.reduce(
      (state, row) => ({
        min: Math.min(state.min, row.predicted, row.lower),
        max: Math.max(state.max, row.predicted, row.upper),
      }),
      { min: Infinity, max: -Infinity },
    );
    const diagonalRows = [{ axis: bounds.min }, { axis: bounds.max }];

    const artifacts = [
      H.tableArtifact(
        `GRS test summary: ${parsed.label}`,
        "The joint test that every time-series intercept is zero, with both degrees of freedom and the two quadratic forms it is built from.",
        SUMMARY_COLUMNS,
        summaryRows,
        ["Sigma uses the T - K - 1 denominator and Omega the T - 1 denominator; the statistic is exactly F distributed under normal, homoskedastic, serially independent residuals."],
        "grs-summary-table",
      ),
      H.tableArtifact(
        `Portfolio alphas: ${parsed.label}`,
        `Time-series intercept of each portfolio on the same ${factorCount} factor(s), with its classical standard error, t statistic and interval.`,
        K.coefficientColumns("t", [
          { key: "annualisedAlpha", label: `Annualised alpha (x ${annualFactor})`, type: "number" },
          { key: "rSquared", label: "R2", type: "number" },
        ]),
        alphaRows,
        [`Mean absolute alpha ${meanAbsoluteAlpha}; the joint test is in the GRS summary table and is not the same claim as any single row.`],
        "grs-alpha-table",
      ),
      unanchorForestAxis(K.forestPlot(H, "grs-alpha-forest", `Portfolio alphas with ${Math.round(level * 100)}% intervals: ${parsed.label}`, alphaRows, { xTitle: "Alpha (per period)" })),
      H.vegaArtifact("grs-realised-versus-predicted", `Realised against model-predicted mean excess return: ${parsed.label}`, {
        layer: [
          {
            data: { values: diagonalRows },
            mark: { type: "line", strokeDash: [5, 4], color: "#777" },
            encoding: {
              x: { field: "axis", type: "quantitative", title: "Model-predicted mean excess return", scale: H.MEASUREMENT_SCALE },
              y: { field: "axis", type: "quantitative", title: "Realised mean excess return", scale: H.MEASUREMENT_SCALE },
            },
          },
          {
            data: { values: comparisonRows },
            mark: { type: "rule", strokeWidth: 2, color: "#1F4E79" },
            encoding: {
              x: { field: "predicted", type: "quantitative", scale: H.MEASUREMENT_SCALE },
              y: { field: "lower", type: "quantitative", scale: H.MEASUREMENT_SCALE },
              y2: { field: "upper" },
            },
          },
          {
            data: { values: comparisonRows },
            mark: { type: "point", filled: true, size: 90, color: "#1F4E79" },
            encoding: {
              x: { field: "predicted", type: "quantitative", scale: H.MEASUREMENT_SCALE },
              y: { field: "realised", type: "quantitative", scale: H.MEASUREMENT_SCALE },
              tooltip: [{ field: "portfolio" }, { field: "realised", format: ".5g" }, { field: "predicted", format: ".5g" }, { field: "alpha", format: ".5g" }],
            },
          },
        ],
      }),
    ];

    return {
      sample: {
        periods,
        portfolios: portfolioCount,
        factors: factorCount,
        label: parsed.label,
        periodsPerYear: annualFactor,
        residualCovarianceDenominator: residualDenominator,
      },
      estimates: [
        { name: "GRS statistic", estimate: statistic, df1, df2, pValue },
        { name: "mean absolute alpha", estimate: meanAbsoluteAlpha, scale: "per period" },
        { name: "annualised mean absolute alpha", estimate: meanAbsoluteAlpha * annualFactor, method: `arithmetic annualisation x ${annualFactor}` },
        { name: "squared factor Sharpe ratio", estimate: sharpeSquared },
        ...alphaRows.map((row) => ({ name: `${row.term} alpha`, estimate: row.estimate, standardError: row.standardError, statistic: row.statistic, pValue: row.pValue, lower: row.lower, upper: row.upper })),
      ],
      tests: [
        { name: "Gibbons-Ross-Shanken: all alphas are zero", statistic, distribution: "F", df1, df2, pValue },
        ...alphaRows.map((row) => ({ name: `${row.term} alpha is zero`, statistic: row.statistic, distribution: "t", df: row.df, pValue: row.pValue, boundary: "single-portfolio test, not corrected for testing N portfolios" })),
      ],
      confidenceIntervals: alphaRows.map((row) => ({ parameter: `${row.term} alpha`, level, lower: row.lower, upper: row.upper, method: "classical time-series standard error with a t reference" })),
      effectSizes: [
        { name: "mean absolute alpha", estimate: meanAbsoluteAlpha },
        { name: "alpha' Sigma^-1 alpha", estimate: alphaQuadratic },
        { name: "squared factor Sharpe ratio", estimate: sharpeSquared },
      ],
      assumptions: [
        { name: "residuals are jointly normal, homoskedastic and serially independent", status: "required_for_the_exact_F_distribution" },
        { name: "the same periods are observed for every portfolio", status: "verified_by_equal_series_lengths" },
        { name: "returns are already in excess of the risk-free rate", status: "requires_data_review" },
        { name: "constant loadings over the sample", status: "not_established" },
      ],
      diagnostics: [
        { name: "GRS construction", status: "computed", periods, portfolios: portfolioCount, factors: factorCount, sigmaDenominator: residualDenominator, omegaDenominator: periods - 1, alphaQuadratic, sharpeSquared },
        { name: "residual covariance conditioning", status: "inverted", boundary: `Sigma is ${portfolioCount} x ${portfolioCount} estimated from ${periods} periods; it is only well conditioned while T - K - 1 comfortably exceeds N` },
        { name: "distributional boundary", status: "exact_under_normality", boundary: "no heteroskedasticity- or autocorrelation-robust GRS variant and no bootstrap p value is computed here" },
        { name: "per-portfolio alphas", status: "reported_without_multiplicity_correction", portfolios: portfolioCount, boundary: "the joint test is the claim; individual t statistics are descriptive" },
      ],
      artifacts,
    };
  },
  linkage: {
    neededWhen: "When a set of test portfolios is regressed on a candidate factor model and the question is whether the model prices all of them together, not one at a time.",
    decision: "Whether the joint hypothesis that every intercept is zero can be rejected, and which portfolios carry the pricing error.",
    mustShow: "The F statistic with both degrees of freedom and its p value, every portfolio alpha with its t statistic and interval, and the mean absolute alpha on the sampling frequency and annualised.",
    userGoal: "Report a defensible verdict on a factor model rather than a collection of separate alpha tests, and see where the model fails.",
    nextActions: [
      { trigger: "joint-test-rejects", action: "inspect-the-alpha-forest-and-name-the-portfolios-that-carry-the-pricing-error", reason: "A rejection is a direction for model repair, not a verdict on every portfolio." },
      { trigger: "joint-test-does-not-reject", action: "report-the-mean-absolute-alpha-and-the-power-limitation-together", reason: "Failing to reject with few periods and many portfolios is weak evidence, not evidence of a correct model." },
      { trigger: "portfolios-close-to-the-period-count", action: "reduce-the-number-of-test-portfolios-or-extend-the-sample", reason: "The residual covariance matrix becomes unstable as N approaches T - K - 1." },
      { trigger: "residual-non-normality-or-autocorrelation-suspected", action: "plan-a-robust-or-bootstrap-variant-before-publishing-the-exact-p-value", reason: "The exact F distribution depends on assumptions this test does not verify." },
    ],
  },
  fixture: {
    data: {
      portfolios: [
        {
          name: "P1 growth",
          excessReturns: [
            0.025395, 0.017006, 0.091233, -0.050438, -0.028961, 0.010532, 0.061507, -0.046475,
            -0.075133, -0.070277, -0.003597, -0.073058, 0.034702, 0.050336, -0.098335, 0.034129,
            -0.021186, -0.034579, -0.069104, 0.102231, 0.002664, -0.029015, 0.008875, -0.009421,
            0.003934, 0.052163, 0.023789, -0.040497, -0.025368, -0.00446, 0.086726, -0.007663,
            -0.060044, -0.046018, -0.00061, -0.006947, 0.010847, 0.002183, 0.00542, 0.01804,
            0.066351, -0.079167, 0.036071, 0.032181, -0.015712, -0.035775, 0.01573, 0.021411,
            -0.023578, 0.018666, 0.018357, 0.080264, 0.01652, -0.037334, 0.063945, 0.041049,
            -0.030711, 0.066522, -0.042197, 0.011746,
          ],
        },
        {
          name: "P2 blend",
          excessReturns: [
            -0.038071, -0.011163, 0.005238, -0.07355, -0.071656, 0.017343, 0.047193, 0.012314,
            -0.073415, 0.015152, -0.00997, -0.02142, 0.011354, 0.037696, -0.060091, 0.053582,
            -0.005021, 0.046725, -0.072987, 0.055001, 0.032747, -0.013294, 0.028229, 0.055257,
            -0.021726, 0.035091, -0.01279, -0.059089, 0.00416, -0.068625, 0.001438, -0.040116,
            -0.05877, 0.007188, 0.007759, -0.04612, -0.042979, 0.032791, -0.027699, -0.012762,
            0.062093, -0.000111, 0.037574, 0.043078, -0.036165, 0.070764, -0.000928, -0.004051,
            -0.024907, -0.058336, -0.047858, 0.009803, -0.014619, -0.078261, 0.035708, 0.000164,
            -0.062274, 0.007947, -0.002602, 0.055798,
          ],
        },
        {
          name: "P3 value",
          excessReturns: [
            -0.045665, 0.018133, 0.022203, -0.07745, -0.083407, -0.028895, 0.075062, 0.013007,
            -0.049644, -0.036879, 0.081081, -0.085348, 0.000378, -0.00476, -0.081001, 0.093584,
            -0.021248, 0.045173, -0.105404, 0.137856, 0.031934, -0.05303, 0.035935, 0.00531,
            -0.023708, 0.065575, -0.01883, -0.094529, -0.040543, -0.011189, 0.00527, -0.084248,
            -0.121539, -0.041408, -0.033336, -0.040216, 0.005029, 0.038717, -0.019994, -0.012623,
            0.055711, -0.02671, 0.041355, 0.067372, -0.033827, 0.076008, 0.032687, 0.032358,
            -0.005716, 0.010774, -0.021515, 0.033417, -0.004439, -0.055602, -0.005133, 0.014139,
            -0.001947, 0.046458, -0.014387, 0.005834,
          ],
        },
        {
          name: "P4 small",
          excessReturns: [
            0.049684, 0.001058, 0.035114, -0.0407, -0.000179, -0.013295, 0.067088, -0.028008,
            -0.036243, -0.063322, -0.026948, -0.069373, 0.011243, 0.015019, -0.043581, 0.063875,
            -0.009504, -0.019781, -0.029696, 0.079034, -0.00451, -0.047866, -0.00879, 0.035717,
            0.025961, 0.017378, 0.001817, -0.086063, -0.025395, -0.007015, 0.047696, -0.065291,
            -0.042705, -0.051562, 0.010116, 0.002378, 0.019535, 0.024402, -0.022724, 0.016684,
            0.071847, -0.057968, 0.047916, 0.06766, 0.017748, -0.073478, -0.019177, 0.018118,
            -0.019497, 0.029436, -0.028782, 0.085442, 0.039204, -0.044074, 0.041952, 0.006796,
            -0.045188, 0.042982, 0.01256, -0.010436,
          ],
        },
        {
          name: "P5 momentum",
          excessReturns: [
            0.024388, 0.012952, 0.028191, -0.04192, -0.050042, 0.015938, 0.054922, 0.010659,
            -0.102665, -0.049324, -0.002702, -0.072918, -0.031458, 0.094497, -0.019048, 0.041763,
            -0.023362, -0.007277, -0.14812, 0.049269, 0.058103, -0.057671, 0.043308, 0.010479,
            -0.02751, 0.045385, 0.009618, -0.043319, -0.020596, -0.041733, 0.034648, -0.057371,
            -0.037457, -0.03056, 0.011537, -0.063668, 0.017671, -0.03778, -0.035893, -0.003585,
            0.064224, -0.015303, 0.009333, 0.079334, -0.02515, 0.014764, -0.001909, -0.002695,
            -0.000587, -0.018377, -0.029228, 0.057012, -0.005152, -0.101587, 0.053134, 0.015896,
            -0.008336, 0.079297, 0.021292, 0.04743,
          ],
        },
      ],
      factors: [
        {
          name: "Mkt-RF",
          values: [
            -0.014507, 0.006297, 0.038084, -0.054965, -0.037078, -0.004888, 0.062803, -0.008243,
            -0.079004, -0.067287, -0.020619, -0.068093, 0.004174, 0.040196, -0.06252, 0.041188,
            -0.017534, 0.002694, -0.085513, 0.066365, 0.02556, -0.040134, 0.035563, 0.016554,
            -0.010941, 0.030918, -0.004749, -0.03668, -0.028965, -0.029846, 0.043267, -0.047638,
            -0.054362, -0.027333, 0.007919, -0.040554, -0.006762, 0.011859, -0.025307, 0.011997,
            0.076872, -0.0425, 0.016364, 0.050303, -0.027425, 0.013911, -0.006477, 0.029196,
            -0.034955, -0.011488, -0.037065, 0.060326, 0.007152, -0.053611, 0.045156, 0.00038,
            -0.040693, 0.065587, -0.003226, 0.032189,
          ],
        },
        {
          name: "SMB",
          values: [
            0.045474, 0.034575, 0.026126, 0.012705, -0.018601, -0.041678, 0.006524, -0.010217,
            0.0255, -0.01214, 0.041619, -0.027679, 0.014892, -0.007398, 0.005349, 0.04174,
            -0.011748, -0.016269, 0.064655, 0.020565, -0.031645, 0.009548, -0.043316, -0.016934,
            0.038902, -0.018692, 0.023334, -0.030676, 0.006363, 0.049637, 0.0078, 0.002901,
            -0.012668, -0.0005, -0.037057, 0.038623, 0.000438, 0.01845, 0.013644, 0.026216,
            -0.013566, -0.033482, 0.008786, -0.004295, 0.021337, -0.030218, -0.002877, 0.002547,
            0.01149, 0.030863, 0.052172, 0.027794, 0.024835, -0.00425, -0.027513, 0.048546,
            -0.025178, -0.020852, -0.027107, -0.028012,
          ],
        },
        {
          name: "HML",
          values: [
            -0.031973, 0.031414, 0.006414, -0.03558, -0.060355, -0.004217, -0.015838, 0.041203,
            -0.002459, 0.052113, 0.064654, 0.006201, 0.017816, -0.005767, -0.028457, -0.012984,
            0.015564, 0.046002, -0.006685, -0.002427, -0.007105, -0.008232, 0.015094, -0.012505,
            0.005571, 0.020065, -0.017481, -0.020404, 0.015576, 0.010715, -0.018448, -0.036423,
            -0.055487, -0.026628, -0.021588, 0.004122, 3.1e-05, 0.022926, 0.00641, -0.045489,
            -0.005287, 0.037849, 0.002521, -0.003829, 0.003956, 0.050197, 0.022167, 0.013586,
            0.056088, 0.013265, -0.023944, -0.01637, -0.006562, -0.000926, -0.03623, 0.017021,
            0.011602, -0.017036, -0.016328, 0.012635,
          ],
        },
      ],
      label: "Five test portfolios on a three-factor model",
    },
    options: { periodsPerYear: 12 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.linear", "matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "Gibbons-Ross-Shanken exact F test that all time-series intercepts are zero, for N portfolios on K supplied factors over T common periods, with Sigma using the T - K - 1 denominator and Omega the T - 1 denominator, plus each portfolio's alpha, t statistic and interval and the mean absolute alpha.",
    oracle: {
      level: "external-library-partial",
      evidence: ["contracts/asset-pricing-statsmodels-crosscheck.py"],
      verifiedOutputs: [
        "every portfolio alpha and its classical standard error against statsmodels OLS",
        "the residual covariance matrix and the factor covariance matrix",
        "the GRS statistic and both quadratic forms computed directly in numpy",
        "the p value against scipy.stats.f",
      ],
      excludedOutputs: [
        "annualised mean absolute alpha (a reporting convention)",
        "the realised-versus-predicted figure and its error bars",
      ],
    },
    diagnostic: {
      level: "method-specific-partial",
      emitted: ["both degrees of freedom, both denominators, and the two quadratic forms", "a conditioning warning tied to N against T - K - 1", "the boundary of the exact F distribution"],
      limitations: ["no robust or bootstrap GRS variant", "no test of residual normality or serial correlation", "no multiplicity correction across the individual portfolio alphas"],
    },
    knownGaps: [
      "no heteroskedasticity- and autocorrelation-robust GRS variant",
      "no bootstrap or simulated p value",
      "no shrinkage of the residual covariance matrix when N approaches T - K - 1",
      "missing periods are not supported: every portfolio must be observed on the same periods",
    ],
  },
};

module.exports = { methods: [linearFactorModel, famaMacBethRegression, grsTest] };
