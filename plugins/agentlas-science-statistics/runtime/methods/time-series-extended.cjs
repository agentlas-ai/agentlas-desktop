"use strict";

/**
 * Time-series extension family: unit-root tests (ADF, KPSS, Phillips–Perron), ARIMA / SARIMA by
 * CSS start then exact Gaussian maximum likelihood (Kalman innovations likelihood), a stepwise
 * auto-ARIMA, exponential smoothing (SES, Holt, Holt–Winters), classical and STL seasonal
 * decomposition, spectral estimation (periodogram, Welch, Lomb–Scargle), change-point detection
 * (PELT, binary segmentation), Granger causality, cross-correlation, and vector autoregression.
 *
 * All numerics live in ./time-series-kernels.cjs; this file only defines method contracts,
 * typed tables, figures, linkage, and coverage. Pure JavaScript, deterministic, no engine require.
 */

const K = require("./time-series-kernels.cjs");

const ANALYSIS_MODEL = { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] };
const MAX_ROWS = 10000;
const MIN_SERIES = 10;

const SERIES_PROPERTIES = Object.freeze({
  values: { type: "array", minItems: MIN_SERIES, maxItems: MAX_ROWS, items: { type: "number" } },
  time: { type: "array", minItems: MIN_SERIES, maxItems: MAX_ROWS, items: { type: "number" } },
  seriesLabel: { type: "string", minLength: 1, maxLength: 128 },
  timeLabel: { type: "string", minLength: 1, maxLength: 128 },
});

function seriesSchema(extra = {}) {
  return { type: "object", additionalProperties: false, required: ["values"], properties: { ...SERIES_PROPERTIES, ...extra } };
}

// ---------------------------------------------------------------------------------------------
// Option factories
// ---------------------------------------------------------------------------------------------

function enumOption(values, fallback) {
  return {
    schema: { type: "string", enum: values },
    default: fallback,
    parse(value, H, path) {
      if (typeof value !== "string" || !values.includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be one of ${values.join(", ")}`);
      return value;
    },
  };
}

function integerOption(min, max, fallback) {
  return { schema: { type: "integer", minimum: min, maximum: max }, default: fallback, parse(value, H, path) { return H.integer(value, min, max, path); } };
}

function nullableIntegerOption(min, max) {
  return {
    schema: { type: ["integer", "null"], minimum: min, maximum: max },
    default: null,
    parse(value, H, path) { return value === null ? null : H.integer(value, min, max, path); },
  };
}

function booleanOption(fallback) {
  return { schema: { type: "boolean" }, default: fallback, parse(value, H, path) { if (typeof value !== "boolean") H.fail("STAT_INVALID_INPUT", `${path} must be boolean`); return value; } };
}

function nullableBooleanOption() {
  return { schema: { type: ["boolean", "null"] }, default: null, parse(value, H, path) { if (value !== null && typeof value !== "boolean") H.fail("STAT_INVALID_INPUT", `${path} must be boolean or null`); return value; } };
}

function nullableNumberOption(min, max) {
  return {
    schema: { type: ["number", "null"], minimum: min, maximum: max },
    default: null,
    parse(value, H, path) {
      if (value === null) return null;
      const number = H.finiteNumber(value, path);
      if (number < min || number > max) H.fail("STAT_INVALID_INPUT", `${path} must be between ${min} and ${max}`);
      return number;
    },
  };
}

function integerArrayOption(length, bounds, fallback) {
  return {
    schema: { type: "array", minItems: length, maxItems: length, items: { type: "integer", minimum: 0 } },
    default: fallback,
    parse(value, H, path) {
      if (!Array.isArray(value) || value.length !== length) H.fail("STAT_INVALID_INPUT", `${path} must be an array of ${length} integers`);
      return value.map((item, index) => H.integer(item, 0, bounds[index], `${path}[${index}]`));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Shared table / figure helpers
// ---------------------------------------------------------------------------------------------

const COLORS = Object.freeze({ observed: "#1F4E79", fitted: "#4A6B3A", forecast: "#B24A3B", band: "#B24A3B", neutral: "#6B6B6B", accent: "#8C6A1F" });

function col(key, label, type = "number") {
  return { key, label, type };
}

function seriesColumns(parsed) {
  return [col("index", "Index"), col("time", parsed.timeLabel), col("value", parsed.seriesLabel)];
}

function seriesRows(parsed) {
  return parsed.values.map((value, index) => ({ index: index + 1, time: parsed.time[index], value }));
}

function futureTimes(parsed, horizon) {
  const last = parsed.time[parsed.time.length - 1];
  return Array.from({ length: horizon }, (_, index) => last + parsed.interval * (index + 1));
}

function zQuantile(H, probability) {
  let z = H.normalInv(probability);
  for (let step = 0; step < 4; step += 1) {
    const error = K.normalCdfAccurate(H, z) - probability;
    const density = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
    if (!(density > 0)) break;
    z -= error / density;
  }
  return z;
}

function lineLayer(rows, x, y, color, { dash = null, point = false, xTitle = null, yTitle = null, tooltip = null } = {}) {
  const mark = { type: "line", color, ...(dash ? { strokeDash: dash } : {}), ...(point ? { point: true } : {}) };
  const encoding = {
    x: { field: x, type: "quantitative", ...(xTitle ? { title: xTitle } : {}) },
    y: { field: y, type: "quantitative", ...(yTitle ? { title: yTitle } : {}) },
  };
  if (tooltip) encoding.tooltip = tooltip.map((field) => ({ field }));
  return { ...(rows ? { data: { values: rows } } : {}), mark, encoding };
}

function ljungBoxRows(H, residuals, lags, modelDf, z, budget) {
  const box = K.ljungBox(H, residuals, lags, modelDf, budget);
  const bound = z / Math.sqrt(residuals.length);
  return {
    summary: box,
    rows: box.rows.map((row) => ({ lag: row.lag, autocorrelation: row.autocorrelation, statistic: row.statistic, df: row.df, pValue: row.pValue, upperBound: bound, lowerBound: -bound })),
  };
}

const LJUNG_COLUMNS = [col("lag", "Lag"), col("autocorrelation", "Residual ACF"), col("statistic", "Q"), col("df", "df"), col("pValue", "p"), col("upperBound", "Upper bound"), col("lowerBound", "Lower bound")];

function acfFigure(role, title, rows) {
  return {
    role,
    title,
    spec: {
      data: { values: rows },
      layer: [
        { mark: { type: "bar", color: COLORS.observed, width: { band: 0.6 } }, encoding: { x: { field: "lag", type: "ordinal", title: "Lag" }, y: { field: "autocorrelation", type: "quantitative", title: "Residual autocorrelation" }, tooltip: [{ field: "lag" }, { field: "autocorrelation", format: ".4f" }, { field: "pValue", format: ".4f" }] } },
        { mark: { type: "line", color: COLORS.forecast, strokeDash: [6, 4] }, encoding: { x: { field: "lag", type: "ordinal" }, y: { field: "upperBound", type: "quantitative" } } },
        { mark: { type: "line", color: COLORS.forecast, strokeDash: [6, 4] }, encoding: { x: { field: "lag", type: "ordinal" }, y: { field: "lowerBound", type: "quantitative" } } },
      ],
    },
  };
}

function seriesFixture(kind) {
  // Deterministic realistic fixtures (values are literal so the fixture is self-contained).
  if (kind === "trend") {
    return [101.2, 102.9, 102.1, 104.6, 105.8, 105.1, 107.9, 108.4, 108.0, 110.6, 111.9, 111.3, 113.7, 114.2, 115.9, 116.1, 117.8, 118.9, 118.3, 120.7, 121.4, 122.9, 122.6, 124.8, 125.3, 126.9, 127.1, 128.4, 129.8, 130.2, 131.7, 132.1, 133.9, 134.6, 135.1, 136.8, 137.2, 138.9, 139.4, 140.8];
  }
  if (kind === "stationary") {
    return [0.62, -0.41, 0.88, 1.35, 0.27, -0.73, -1.12, -0.36, 0.44, 1.02, 0.71, -0.15, -0.94, -0.52, 0.31, 0.97, 0.58, -0.22, -0.81, -1.05, -0.33, 0.49, 1.21, 0.86, 0.12, -0.67, -0.98, -0.41, 0.35, 0.92, 1.14, 0.47, -0.28, -0.85, -0.6, 0.18, 0.76, 1.03, 0.39, -0.44, -0.91, -0.37, 0.29, 0.84, 0.66, -0.09, -0.72, -1.01, -0.48, 0.21, 0.79, 1.08, 0.53, -0.19, -0.77, -0.55, 0.26, 0.9, 0.61, -0.13];
  }
  if (kind === "seasonal") {
    return [112, 118, 132, 129, 121, 135, 148, 148, 136, 119, 104, 118, 115, 126, 141, 135, 125, 149, 170, 170, 158, 133, 114, 140, 145, 150, 178, 163, 172, 178, 199, 199, 184, 162, 146, 166, 171, 180, 193, 181, 183, 218, 230, 242, 209, 191, 172, 194, 196, 196, 236, 235, 229, 243, 264, 272, 237, 211, 180, 201, 204, 188, 235, 227, 234, 264, 302, 293, 259, 229, 203, 229];
  }
  if (kind === "step") {
    return [5.1, 4.8, 5.3, 4.9, 5.0, 5.2, 4.7, 5.1, 5.0, 4.9, 5.2, 4.8, 8.1, 7.9, 8.3, 8.0, 7.8, 8.2, 8.1, 7.7, 8.0, 8.2, 7.9, 8.1, 6.0, 6.2, 5.8, 6.1, 5.9, 6.3, 6.0, 5.8, 6.1, 6.2, 5.9, 6.0];
  }
  throw new Error(`unknown fixture ${kind}`);
}

// ---------------------------------------------------------------------------------------------
// Augmented Dickey–Fuller
// ---------------------------------------------------------------------------------------------

const REGRESSION_LABELS = Object.freeze({ n: "no deterministic terms", c: "constant", ct: "constant and linear trend" });

const augmentedDickeyFuller = {
  method: "augmented_dickey_fuller",
  family: "time-series",
  analysisModel: ANALYSIS_MODEL,
  optionKeys: ["maxLag", "timeoutMs"],
  customOptions: {
    regression: enumOption(["c", "ct", "n"], "c"),
    lagSelection: enumOption(["aic", "bic", "none"], "aic"),
  },
  dataSchema: seriesSchema(),
  parse(data, _options, H) {
    return K.parseSeries(data, H, { minLength: MIN_SERIES });
  },
  analyze(parsed, options, budget, H) {
    const { values } = parsed;
    const n = values.length;
    const result = K.augmentedDickeyFuller(H, values, { regression: options.regression, maxLag: options.maxLag, autolag: options.lagSelection }, budget);
    const table = K.MACKINNON_1994[options.regression];
    const pBoundary = result.statistic > table.max ? "above_surface_maximum" : result.statistic < table.min ? "below_surface_minimum" : "within_surface";
    const diff = K.differenceOnce(values, 1);
    const regressionRows = [];
    for (let t = result.usedLag, row = 0; t < diff.length; t += 1, row += 1) {
      regressionRows.push({ index: t + 2, time: parsed.time[t + 1], laggedLevel: values[t], difference: diff[t], fitted: result.fit.fitted[row], residual: result.fit.residuals[row] });
    }
    const z = zQuantile(H, 0.975);
    const lbLags = Math.max(1, Math.min(10, Math.floor(result.nobs / 4)));
    const ljung = ljungBoxRows(H, result.fit.residuals, lbLags, 0, z, budget);
    const reject = result.pValue < 0.05;
    const testRows = [{ regression: REGRESSION_LABELS[options.regression], statistic: result.statistic, pValue: result.pValue, usedLag: result.usedLag, maxLag: result.maxLag, nobs: result.nobs, critical1: result.critical["1%"], critical5: result.critical["5%"], critical10: result.critical["10%"], lagSelection: options.lagSelection }];
    const coefficientRows = result.coefficientRows.map((row) => ({ term: row.term, estimate: row.estimate, standardError: row.standardError, tStatistic: row.tStatistic, pValue: row.pValue }));
    const searchRows = result.searchRows.map((row) => ({ lag: row.lag, nobs: row.nobs, aic: row.aic, bic: row.bic, tStatistic: row.tStatistic, selected: row.lag === result.usedLag }));
    const artifacts = [
      H.tableArtifact("Augmented Dickey-Fuller test", `Regression of the first difference on the lagged level with ${REGRESSION_LABELS[options.regression]} and ${result.usedLag} lagged differences; p-value from the MacKinnon (1994) response surface, critical values from MacKinnon (2010).`, [col("regression", "Deterministic terms", "string"), col("statistic", "tau"), col("pValue", "p (MacKinnon)"), col("usedLag", "Lags used"), col("maxLag", "Max lag"), col("nobs", "n used"), col("critical1", "1% critical"), col("critical5", "5% critical"), col("critical10", "10% critical"), col("lagSelection", "Lag selection", "string")], testRows, [], "adf-test-table"),
      H.tableArtifact("ADF regression coefficients", "OLS coefficients of the auxiliary regression; y.lag1 carries the unit-root tau statistic (its OLS t ratio, which is not t distributed under the null).", [col("term", "Term", "string"), col("estimate", "Estimate"), col("standardError", "SE"), col("tStatistic", "t"), col("pValue", "p (t, not valid for y.lag1)")], coefficientRows, [], "adf-coefficient-table"),
      H.tableArtifact("Dickey-Fuller regression points", "Lagged level against first difference for the observations used in the final regression, with fitted values of the auxiliary regression.", [col("index", "Index"), col("time", parsed.timeLabel), col("laggedLevel", "Lagged level"), col("difference", "First difference"), col("fitted", "Fitted"), col("residual", "Residual")], regressionRows, [], "adf-regression-table"),
      H.tableArtifact("ADF residual autocorrelation", `Ljung-Box statistics of the auxiliary-regression residuals through lag ${lbLags} with approximate 95% white-noise bounds.`, LJUNG_COLUMNS, ljung.rows, [], "adf-residual-acf-table"),
      H.vegaArtifact("adf-regression-figure", `Dickey-Fuller regression: ${parsed.seriesLabel}`, {
        data: { values: regressionRows },
        layer: [
          { mark: { type: "point", filled: true, color: COLORS.observed, opacity: 0.7 }, encoding: { x: { field: "laggedLevel", type: "quantitative", title: "Lagged level" }, y: { field: "difference", type: "quantitative", title: "First difference" }, tooltip: [{ field: "index" }, { field: "laggedLevel", format: ".4g" }, { field: "difference", format: ".4g" }] } },
          { mark: { type: "line", color: COLORS.forecast }, encoding: { x: { field: "laggedLevel", type: "quantitative" }, y: { field: "fitted", type: "quantitative" } } },
        ],
      }),
    ];
    if (searchRows.length) {
      artifacts.push(H.tableArtifact("ADF lag selection", `Information criteria over lag lengths 0..${result.maxLag} on the common trimmed sample; the ${options.lagSelection.toUpperCase()} minimum is used.`, [col("lag", "Lag"), col("nobs", "n"), col("aic", "AIC"), col("bic", "BIC"), col("tStatistic", "tau"), col("selected", "Selected", "boolean")], searchRows, [], "adf-lag-selection-table"));
    }
    return {
      sample: { n, nobs: result.nobs, usedLag: result.usedLag, maxLag: result.maxLag, regression: options.regression },
      estimates: [
        { name: "coefficient on lagged level (rho - 1)", estimate: result.fit.beta[coefficientRows.findIndex((row) => row.term === "y.lag1")], standardError: result.fit.se[coefficientRows.findIndex((row) => row.term === "y.lag1")] },
      ],
      tests: [
        { name: "Augmented Dickey-Fuller tau", statistic: result.statistic, distribution: "MacKinnon (1994) tau response surface", df: null, pValue: result.pValue, nullHypothesis: "unit root", criticalValues: result.critical },
      ],
      confidenceIntervals: [],
      effectSizes: [],
      assumptions: [
        { name: "lag augmentation absorbs residual serial correlation", status: ljung.summary.pValue > 0.05 ? "supported_by_ljung_box" : "not_established", statistic: ljung.summary.statistic, df: ljung.summary.df, pValue: ljung.summary.pValue },
        { name: "deterministic specification matches the series", status: "requires_design_review", detail: `regression = ${options.regression}` },
        { name: "no structural break in the sample", status: "not_established" },
      ],
      diagnostics: [
        { name: "unit-root verdict at 5%", status: reject ? "unit_root_rejected" : "unit_root_not_rejected", pValue: result.pValue, statistic: result.statistic, criticalValue5: result.critical["5%"] },
        { name: "p-value surface", status: pBoundary === "within_surface" ? "asymptotic" : pBoundary, method: "MacKinnon 1994 N=1 surface" },
        { name: "lag selection", status: options.lagSelection === "none" ? "user_specified" : `${options.lagSelection}_minimum`, usedLag: result.usedLag, maxLag: result.maxLag, criterion: result.icBest },
        { name: "residual autocorrelation (Ljung-Box)", status: ljung.summary.pValue > 0.05 ? "no_evidence" : "serial_correlation_detected", statistic: ljung.summary.statistic, df: ljung.summary.df, pValue: ljung.summary.pValue },
      ],
      artifacts,
    };
  },
  linkage: {
    neededWhen: "Before modelling or regressing a time series you need to know whether it is integrated (a unit root) or stationary around a constant or trend.",
    decision: "Whether to difference the series before ARIMA or regression, and whether level regressions between series risk being spurious.",
    mustShow: "The tau statistic against the MacKinnon critical values, the p-value with its surface boundary status, the lags used, and the deterministic terms assumed.",
    userGoal: "Justify the differencing order and the deterministic specification used in every downstream time-series model of this series.",
    nextActions: [
      { trigger: "unit-root-not-rejected", action: "difference-once-and-retest", reason: "A unit root that survives the test means levels are not mean-reverting and models on levels will be misspecified." },
      { trigger: "unit-root-rejected", action: "confirm-with-kpss-stationarity-test", reason: "ADF and KPSS have opposite null hypotheses; agreement between them makes the stationarity verdict much stronger." },
      { trigger: "residual-serial-correlation-detected", action: "increase-max-lag-and-refit", reason: "Serial correlation left in the auxiliary regression invalidates the tau distribution used for the p-value." },
      { trigger: "trend-visible-in-series", action: "rerun-with-constant-and-trend", reason: "Omitting a trend term when the series trends makes the ADF test lose power against trend stationarity." },
    ],
  },
  fixture: { data: { values: seriesFixture("trend"), seriesLabel: "Quarterly index", timeLabel: "Quarter" }, options: { regression: "ct", lagSelection: "aic" } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.distribution"] },
  coverage: {
    implementedBoundary: "ADF tau test with none/constant/constant-plus-trend deterministic terms, AIC/BIC lag search on a common sample or a fixed lag, MacKinnon (1994) p-value surface and MacKinnon (2010) critical values, auxiliary-regression coefficients and residual Ljung-Box.",
    oracle: { level: "external-library-partial", evidence: ["contracts/time-series-extended-scipy-crosscheck.py"], verifiedOutputs: ["tau statistic", "MacKinnon p-value", "critical values", "selected lag and information criteria", "auxiliary regression coefficients", "residual Ljung-Box"], excludedOutputs: ["structural-break robust variants", "GLS-detrended (DF-GLS) statistic"] },
    diagnostic: { level: "method-specific-partial", emitted: ["unit-root verdict at 5%", "p-value surface boundary", "lag selection", "residual Ljung-Box"], limitations: ["no automatic deterministic-term selection", "p-values are asymptotic response-surface approximations"] },
    knownGaps: ["no DF-GLS", "no break-robust unit-root tests", "no seasonal unit-root tests"],
  },
};

// ---------------------------------------------------------------------------------------------
// KPSS
// ---------------------------------------------------------------------------------------------

const kpssTest = {
  method: "kpss_test",
  family: "time-series",
  analysisModel: ANALYSIS_MODEL,
  optionKeys: ["timeoutMs"],
  customOptions: {
    regression: enumOption(["c", "ct"], "c"),
    bandwidth: nullableIntegerOption(0, 200),
    bandwidthRule: enumOption(["auto", "legacy"], "auto"),
  },
  dataSchema: seriesSchema(),
  parse(data, _options, H) {
    return K.parseSeries(data, H, { minLength: MIN_SERIES });
  },
  analyze(parsed, options, budget, H) {
    const { values } = parsed;
    const n = values.length;
    let nlags = options.bandwidth;
    let rule = "user";
    if (nlags === null) {
      if (options.bandwidthRule === "legacy") { nlags = Math.min(Math.ceil(12 * (n / 100) ** 0.25), n - 1); rule = "legacy-schwert-ceil-12(n/100)^(1/4)"; }
      else rule = "hobijn-franses-ooms-1998-automatic";
    }
    if (nlags !== null && nlags >= n) H.fail("STAT_INVALID_INPUT", `options.bandwidth must be less than the series length ${n}`);
    const result = K.kpssTest(H, values, { regression: options.regression, nlags }, budget);
    const reject = result.statistic > result.critical["5%"];
    let cumulative = 0;
    const partialRows = result.residuals.map((residual, index) => { cumulative += residual; return { index: index + 1, time: parsed.time[index], residual, partialSum: cumulative }; });
    const testRows = [{ regression: options.regression === "c" ? "level stationarity (constant)" : "trend stationarity (constant and trend)", statistic: result.statistic, pValue: result.pValue, pValueBoundary: result.pBoundary, bandwidth: result.lags, bandwidthRule: rule, longRunVariance: result.longRunVariance, eta: result.eta, n }];
    const criticalRows = [["10%", 0.10], ["5%", 0.05], ["2.5%", 0.025], ["1%", 0.01]].map(([level, alpha]) => ({ level, alpha, critical: result.critical[level], exceeded: result.statistic > result.critical[level] }));
    return {
      sample: { n, bandwidth: result.lags, regression: options.regression },
      estimates: [
        { name: "long-run variance (Bartlett kernel)", estimate: result.longRunVariance, bandwidth: result.lags },
        { name: "eta (scaled partial-sum sum of squares)", estimate: result.eta },
      ],
      tests: [
        { name: "KPSS", statistic: result.statistic, distribution: "KPSS (1992) asymptotic table", df: null, pValue: result.pValue, pValueBoundary: result.pBoundary, nullHypothesis: options.regression === "c" ? "level stationary" : "trend stationary", criticalValues: result.critical },
      ],
      confidenceIntervals: [],
      effectSizes: [],
      assumptions: [
        { name: "Bartlett long-run variance with chosen bandwidth is adequate", status: "asymptotic", bandwidth: result.lags, rule },
        { name: "no structural break in the sample", status: "not_established" },
      ],
      diagnostics: [
        { name: "stationarity verdict at 5%", status: reject ? "stationarity_rejected" : "stationarity_not_rejected", statistic: result.statistic, criticalValue5: result.critical["5%"] },
        { name: "p-value interpolation", status: result.pBoundary === "interpolated" ? "interpolated_between_tabulated_levels" : result.pBoundary, detail: "p is linearly interpolated between the 10%, 5%, 2.5%, and 1% table entries and clipped at the table ends" },
        { name: "bandwidth", status: rule === "user" ? "user_specified" : "automatic", bandwidth: result.lags, rule },
      ],
      artifacts: [
        H.tableArtifact("KPSS stationarity test", "Kwiatkowski-Phillips-Schmidt-Shin statistic with Bartlett-kernel (Newey-West) long-run variance; the null hypothesis is stationarity.", [col("regression", "Null hypothesis", "string"), col("statistic", "KPSS"), col("pValue", "p (table interpolation)"), col("pValueBoundary", "p boundary", "string"), col("bandwidth", "Bandwidth"), col("bandwidthRule", "Bandwidth rule", "string"), col("longRunVariance", "Long-run variance"), col("eta", "eta"), col("n", "n")], testRows, [], "kpss-test-table"),
        H.tableArtifact("KPSS critical values", "Asymptotic critical values from Kwiatkowski et al. (1992) Table 1 for the chosen null.", [col("level", "Level", "string"), col("alpha", "alpha"), col("critical", "Critical value"), col("exceeded", "Statistic exceeds", "boolean")], criticalRows, [], "kpss-critical-value-table"),
        H.tableArtifact("KPSS partial sums", "Residuals from the deterministic regression and their cumulative partial sums, the quantity whose scaled sum of squares forms the statistic.", [col("index", "Index"), col("time", parsed.timeLabel), col("residual", "Residual"), col("partialSum", "Partial sum")], partialRows, [], "kpss-partial-sum-table"),
        H.vegaArtifact("kpss-partial-sum-figure", `KPSS partial sums: ${parsed.seriesLabel}`, {
          data: { values: partialRows },
          layer: [
            lineLayer(null, "time", "partialSum", COLORS.observed, { xTitle: parsed.timeLabel, yTitle: "Cumulative residual sum", tooltip: ["index", "partialSum"] }),
            { mark: { type: "bar", color: COLORS.neutral, opacity: 0.35 }, encoding: { x: { field: "time", type: "quantitative" }, y: { field: "residual", type: "quantitative" } } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When you need positive evidence of stationarity rather than a failure to reject a unit root, or to confirm an ADF verdict from the opposite null hypothesis.",
    decision: "Whether the series can be modelled in levels (stationarity not rejected) or must be differenced or detrended before further modelling.",
    mustShow: "The KPSS statistic against the tabulated critical values, the interpolated p-value with its table-boundary status, and the bandwidth used for the long-run variance.",
    userGoal: "Establish, together with ADF, a stationarity classification that determines the differencing order of downstream models.",
    nextActions: [
      { trigger: "stationarity-rejected", action: "difference-or-detrend-and-retest", reason: "Rejecting stationarity means level models are misspecified; differencing usually removes the stochastic trend." },
      { trigger: "stationarity-not-rejected", action: "cross-check-with-augmented-dickey-fuller", reason: "KPSS has low power against near-unit-root alternatives, so an agreeing ADF rejection is needed for a firm verdict." },
      { trigger: "p-value-at-table-boundary", action: "report-statistic-and-critical-values-not-p", reason: "The tabulated p-value is clipped at 0.01 and 0.10, so the exact p is unknown outside that range." },
      { trigger: "bandwidth-sensitivity-suspected", action: "rerun-with-legacy-bandwidth-rule", reason: "The statistic depends on the long-run variance bandwidth; a verdict that flips with the rule is not robust." },
    ],
  },
  fixture: { data: { values: seriesFixture("trend"), seriesLabel: "Quarterly index", timeLabel: "Quarter" }, options: { regression: "ct" } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.distribution"] },
  coverage: {
    implementedBoundary: "KPSS level- and trend-stationarity statistic with Bartlett (Newey-West) long-run variance; automatic (Hobijn et al. 1998), legacy Schwert, or user bandwidth; table-interpolated p-value with explicit boundary flags.",
    oracle: { level: "external-library-partial", evidence: ["contracts/time-series-extended-scipy-crosscheck.py"], verifiedOutputs: ["KPSS statistic", "interpolated p-value", "selected bandwidth", "critical values"], excludedOutputs: ["long-run variance with non-Bartlett kernels", "structural-break variants"] },
    diagnostic: { level: "method-specific-partial", emitted: ["stationarity verdict at 5%", "p-value boundary", "bandwidth rule"], limitations: ["p-values are interpolated from four tabulated levels", "no small-sample correction"] },
    knownGaps: ["no quadratic-spectral kernel", "no seasonal KPSS"],
  },
};

// ---------------------------------------------------------------------------------------------
// Phillips–Perron
// ---------------------------------------------------------------------------------------------

const phillipsPerron = {
  method: "phillips_perron",
  family: "time-series",
  analysisModel: ANALYSIS_MODEL,
  optionKeys: ["timeoutMs"],
  customOptions: {
    regression: enumOption(["c", "ct", "n"], "c"),
    bandwidth: nullableIntegerOption(0, 200),
  },
  dataSchema: seriesSchema(),
  parse(data, _options, H) {
    return K.parseSeries(data, H, { minLength: MIN_SERIES });
  },
  analyze(parsed, options, budget, H) {
    const { values } = parsed;
    const n = values.length;
    if (options.bandwidth !== null && options.bandwidth >= n - 1) H.fail("STAT_INVALID_INPUT", `options.bandwidth must be less than ${n - 1}`);
    const result = K.phillipsPerron(H, values, { regression: options.regression, lags: options.bandwidth }, budget);
    const table = K.MACKINNON_1994[options.regression];
    const pBoundary = result.zTau > table.max ? "above_surface_maximum" : result.zTau < table.min ? "below_surface_minimum" : "within_surface";
    const reject = result.pValueTau < 0.05;
    const regressionRows = values.slice(1).map((value, index) => ({ index: index + 2, time: parsed.time[index + 1], laggedLevel: values[index], value, fitted: result.fit.fitted[index], residual: result.fit.residuals[index] }));
    const testRows = [
      { statistic: "Z_tau", value: result.zTau, pValue: result.pValueTau, critical1: result.critical[0], critical5: result.critical[1], critical10: result.critical[2] },
      { statistic: "Z_rho", value: result.zAlpha, pValue: null, critical1: null, critical5: null, critical10: null },
    ];
    const detailRows = [{ regression: REGRESSION_LABELS[options.regression], rho: result.rho, rhoStandardError: result.seRho, tStatistic: result.tStatistic, bandwidth: result.bandwidth, bandwidthRule: options.bandwidth === null ? "floor(4 (n/100)^(1/4))" : "user", gamma0: result.gamma0, longRunVariance: result.longRunVariance, nobs: result.nobs }];
    return {
      sample: { n, nobs: result.nobs, bandwidth: result.bandwidth, regression: options.regression },
      estimates: [
        { name: "rho (AR(1) coefficient on lagged level)", estimate: result.rho, standardError: result.seRho },
        { name: "residual variance gamma0", estimate: result.gamma0 },
        { name: "long-run variance (Bartlett kernel)", estimate: result.longRunVariance, bandwidth: result.bandwidth },
      ],
      tests: [
        { name: "Phillips-Perron Z_tau", statistic: result.zTau, distribution: "MacKinnon (1994) tau response surface", df: null, pValue: result.pValueTau, nullHypothesis: "unit root", criticalValues: { "1%": result.critical[0], "5%": result.critical[1], "10%": result.critical[2] } },
        { name: "Phillips-Perron Z_rho", statistic: result.zAlpha, distribution: "Dickey-Fuller rho (not tabulated here)", df: null, pValue: null, nullHypothesis: "unit root" },
      ],
      confidenceIntervals: [],
      effectSizes: [],
      assumptions: [
        { name: "Bartlett long-run variance corrects residual serial correlation", status: "asymptotic", bandwidth: result.bandwidth },
        { name: "deterministic specification matches the series", status: "requires_design_review", detail: `regression = ${options.regression}` },
        { name: "no structural break in the sample", status: "not_established" },
      ],
      diagnostics: [
        { name: "unit-root verdict at 5% (Z_tau)", status: reject ? "unit_root_rejected" : "unit_root_not_rejected", pValue: result.pValueTau, statistic: result.zTau, criticalValue5: result.critical[1] },
        { name: "p-value surface", status: pBoundary === "within_surface" ? "asymptotic" : pBoundary, method: "MacKinnon 1994 N=1 tau surface applied to Z_tau" },
        { name: "Z_rho p-value", status: "not_available", detail: "the rho-statistic distribution is not tabulated in this engine; compare Z_rho with published Dickey-Fuller rho tables" },
        { name: "serial-correlation correction", status: result.longRunVariance > result.gamma0 ? "positive_autocorrelation_corrected" : "negative_autocorrelation_corrected", gamma0: result.gamma0, longRunVariance: result.longRunVariance },
      ],
      artifacts: [
        H.tableArtifact("Phillips-Perron unit-root test", "Non-parametrically corrected Dickey-Fuller statistics (Hamilton 1994, eq. 17.6.8 and 17.6.10) using a Bartlett-kernel long-run variance; Z_tau p-value from the MacKinnon (1994) tau surface.", [col("statistic", "Statistic", "string"), col("value", "Value"), col("pValue", "p"), col("critical1", "1% critical"), col("critical5", "5% critical"), col("critical10", "10% critical")], testRows, ["Z_rho has no tabulated p-value in this engine."], "phillips-perron-test-table"),
        H.tableArtifact("Phillips-Perron regression details", "AR(1) regression estimate, its OLS standard error and t ratio, the short-run and long-run variance estimates, and the bandwidth.", [col("regression", "Deterministic terms", "string"), col("rho", "rho"), col("rhoStandardError", "SE(rho)"), col("tStatistic", "t(rho = 1)"), col("bandwidth", "Bandwidth"), col("bandwidthRule", "Bandwidth rule", "string"), col("gamma0", "gamma0"), col("longRunVariance", "Long-run variance"), col("nobs", "n used")], detailRows, [], "phillips-perron-detail-table"),
        H.tableArtifact("Phillips-Perron regression points", "Lagged level against current level with the fitted AR(1) regression line.", [col("index", "Index"), col("time", parsed.timeLabel), col("laggedLevel", "Lagged level"), col("value", parsed.seriesLabel), col("fitted", "Fitted"), col("residual", "Residual")], regressionRows, [], "phillips-perron-regression-table"),
        H.vegaArtifact("phillips-perron-regression-figure", `AR(1) regression: ${parsed.seriesLabel}`, {
          data: { values: regressionRows },
          layer: [
            { mark: { type: "point", filled: true, color: COLORS.observed, opacity: 0.7 }, encoding: { x: { field: "laggedLevel", type: "quantitative", title: "Lagged level" }, y: { field: "value", type: "quantitative", title: parsed.seriesLabel }, tooltip: [{ field: "index" }, { field: "laggedLevel", format: ".4g" }, { field: "value", format: ".4g" }] } },
            { mark: { type: "line", color: COLORS.forecast }, encoding: { x: { field: "laggedLevel", type: "quantitative" }, y: { field: "fitted", type: "quantitative" } } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When a unit-root test is needed but the residual serial correlation should be handled non-parametrically rather than by choosing an ADF lag length.",
    decision: "Whether the series carries a unit root after correcting the Dickey-Fuller statistic for heteroskedastic and autocorrelated errors.",
    mustShow: "Both Z statistics, the MacKinnon p-value and critical values for Z_tau, the bandwidth, and the short- versus long-run variance that drives the correction.",
    userGoal: "Obtain a unit-root verdict that does not hinge on an ADF lag choice and reconcile it with the ADF and KPSS results.",
    nextActions: [
      { trigger: "unit-root-not-rejected", action: "difference-once-and-retest", reason: "A unit root that survives the corrected test means level models are misspecified; differencing removes the stochastic trend." },
      { trigger: "verdict-differs-from-adf", action: "inspect-residual-autocorrelation-structure", reason: "PP and ADF disagree mainly when moving-average errors are strong, where PP is known to over-reject in small samples." },
      { trigger: "long-run-variance-far-from-gamma0", action: "report-bandwidth-sensitivity", reason: "A large correction means the verdict depends on the bandwidth choice and should be shown for more than one bandwidth." },
    ],
  },
  fixture: { data: { values: seriesFixture("trend"), seriesLabel: "Quarterly index", timeLabel: "Quarter" }, options: { regression: "ct" } },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.distribution"] },
  coverage: {
    implementedBoundary: "Phillips-Perron Z_tau and Z_rho with Bartlett long-run variance and automatic or user bandwidth for none/constant/constant-plus-trend regressions; MacKinnon tau p-value and critical values for Z_tau only.",
    oracle: { level: "external-library-partial", evidence: ["contracts/time-series-extended-scipy-crosscheck.py"], verifiedOutputs: ["Z_tau", "Z_rho", "rho and its standard error", "gamma0 and long-run variance", "MacKinnon p-value and critical values"], excludedOutputs: ["Z_rho p-value", "non-Bartlett kernels"] },
    diagnostic: { level: "method-specific-partial", emitted: ["unit-root verdict at 5%", "p-value surface boundary", "direction of the serial-correlation correction"], limitations: ["the oracle is a first-principles NumPy recomputation, not an external PP implementation", "Z_rho is reported without a p-value"] },
    knownGaps: ["no Z_rho critical values", "no quadratic-spectral kernel", "no prewhitening"],
  },
};


// ---------------------------------------------------------------------------------------------
// ARIMA helpers
// ---------------------------------------------------------------------------------------------

const COEFFICIENT_COLUMNS = [col("term", "Term", "string"), col("estimate", "Estimate"), col("standardError", "SE"), col("zStatistic", "z"), col("pValue", "p"), col("lower", "Lower"), col("upper", "Upper")];
const FIT_COLUMNS = [col("statistic", "Statistic", "string"), col("value", "Value")];
const FORECAST_COLUMNS = (parsed) => [col("step", "Step"), col("time", parsed.timeLabel), col("forecast", "Forecast"), col("standardError", "SE"), col("lower", "Lower"), col("upper", "Upper")];
const FITTED_COLUMNS = (parsed) => [col("index", "Index"), col("time", parsed.timeLabel), col("value", parsed.seriesLabel), col("fitted", "Fitted"), col("residual", "Residual")];

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function orderLabel(order) {
  const base = `ARIMA(${order.p},${order.d},${order.q})`;
  return order.s === null || order.s === undefined ? base : `${base}(${order.P},${order.D},${order.Q})[${order.s}]`;
}

function arimaCoefficientRows(H, fit, z) {
  return fit.names.map((term, index) => {
    const estimate = fit.flat[index];
    const standardError = fit.standardErrors[index];
    if (standardError === null || !(standardError > 0)) return { term, estimate, standardError: null, zStatistic: null, pValue: null, lower: null, upper: null };
    const zStatistic = estimate / standardError;
    return { term, estimate, standardError, zStatistic, pValue: K.twoSidedNormalP(H, zStatistic), lower: estimate - z * standardError, upper: estimate + z * standardError };
  });
}

function arimaFittedRows(parsed, fit) {
  const offset = fit.order.d + fit.order.D * (fit.order.s === null ? 1 : fit.order.s);
  return parsed.values.map((value, index) => {
    const residual = index >= offset ? fit.residuals[index - offset] : null;
    return { index: index + 1, time: parsed.time[index], value, fitted: residual === null ? null : value - residual, residual };
  });
}

function forecastRowsFrom(parsed, mean, variance, z) {
  const times = futureTimes(parsed, mean.length);
  return mean.map((forecast, index) => {
    const standardError = Math.sqrt(Math.max(0, variance[index]));
    return { step: index + 1, time: times[index], forecast, standardError, lower: forecast - z * standardError, upper: forecast + z * standardError };
  });
}

function arimaFitRows(fit) {
  return [
    { statistic: "log-likelihood (exact Gaussian)", value: fit.loglik },
    { statistic: "AIC", value: fit.aic },
    { statistic: "AICc", value: finiteOrNull(fit.aicc) },
    { statistic: "BIC", value: fit.bic },
    { statistic: "sigma^2 (innovation variance, MLE)", value: fit.sigma2 },
    { statistic: "n (original)", value: fit.nOriginal },
    { statistic: "n (differenced)", value: fit.n },
    { statistic: "parameters counted (incl. sigma^2)", value: fit.k },
    { statistic: "CSS objective at start", value: finiteOrNull(fit.css.value) },
    { statistic: "negative log-likelihood at optimum", value: fit.ml.value },
  ];
}

function forecastFigure(role, title, parsed, fittedRows, forecastRows, confidenceLevel) {
  return {
    role,
    title,
    spec: {
      layer: [
        { data: { values: forecastRows }, mark: { type: "area", color: COLORS.band, opacity: 0.2 }, encoding: { x: { field: "time", type: "quantitative", title: parsed.timeLabel }, y: { field: "lower", type: "quantitative", title: parsed.seriesLabel }, y2: { field: "upper" } } },
        lineLayer(fittedRows, "time", "value", COLORS.observed, { tooltip: ["index", "value"] }),
        lineLayer(fittedRows, "time", "fitted", COLORS.fitted, { dash: [4, 3] }),
        lineLayer(forecastRows, "time", "forecast", COLORS.forecast, { point: true, tooltip: ["step", "forecast", "lower", "upper"] }),
      ],
    },
    note: `${Math.round(confidenceLevel * 100)}% prediction band`,
  };
}

function ljungLagCount(H, options, residualCount, modelDf) {
  if (options.ljungBoxLags !== null) {
    if (options.ljungBoxLags <= modelDf) H.fail("STAT_INVALID_INPUT", `options.ljungBoxLags must exceed the number of ARMA parameters (${modelDf})`);
    if (options.ljungBoxLags >= residualCount) H.fail("STAT_INVALID_INPUT", `options.ljungBoxLags must be less than the number of residuals (${residualCount})`);
    return options.ljungBoxLags;
  }
  const preferred = Math.max(10, modelDf + 5);
  return Math.max(modelDf + 1, Math.min(preferred, Math.floor(residualCount / 2)));
}

function validateSeasonalOrder(H, seasonalOrder, n) {
  const [P, D, Q, s] = seasonalOrder;
  if (s === 0 && (P > 0 || D > 0 || Q > 0)) H.fail("STAT_INVALID_INPUT", "options.seasonalOrder needs a seasonal period s >= 2 when P, D, or Q is positive");
  if (s === 1) H.fail("STAT_INVALID_INPUT", "options.seasonalOrder seasonal period must be 0 (none) or at least 2");
  if (s > 0 && n < 2 * s + 2) H.fail("STAT_INSUFFICIENT_SAMPLE", `a seasonal period of ${s} needs at least ${2 * s + 2} observations`);
  return s === 0 ? { P: 0, D: 0, Q: 0, s: 1, seasonal: false } : { P, D, Q, s, seasonal: true };
}

function arimaModelOutputs(H, parsed, fit, options, budget, { roleprefix, extraTables = [], extraDiagnostics = [], sampleExtra = {} }) {
  const z = zQuantile(H, 0.5 + options.confidenceLevel / 2);
  const forecast = K.forecastArima(H, fit, parsed.values, options.horizon, budget);
  const coefficientRows = arimaCoefficientRows(H, fit, z);
  const fittedRows = arimaFittedRows(parsed, fit);
  const forecastRows = forecastRowsFrom(parsed, forecast.mean, forecast.variance, z);
  const modelDf = fit.order.p + fit.order.q + fit.order.P + fit.order.Q;
  const lbLags = ljungLagCount(H, options, fit.residuals.length, modelDf);
  const ljung = ljungBoxRows(H, fit.residuals, lbLags, modelDf, zQuantile(H, 0.975), budget);
  const label = orderLabel(fit.order);
  const seAvailable = fit.hessianStatus === "observed_information_numeric";
  const figure = forecastFigure(`${roleprefix}-forecast-figure`, `${label} forecast: ${parsed.seriesLabel}`, parsed, fittedRows, forecastRows, options.confidenceLevel);
  const acf = acfFigure(`${roleprefix}-residual-acf-figure`, `${label} residual autocorrelation`, ljung.rows);
  const artifacts = [
    H.tableArtifact(`${label} coefficients`, `Exact Gaussian maximum-likelihood estimates (CSS start, Kalman-filter likelihood with concentrated sigma^2); standard errors from the numeric observed information of the profile likelihood; ${Math.round(options.confidenceLevel * 100)}% Wald intervals.`, COEFFICIENT_COLUMNS, coefficientRows, seAvailable ? [] : [`Standard errors unavailable: ${fit.hessianStatus}.`], `${roleprefix}-coefficient-table`),
    H.tableArtifact(`${label} fit statistics`, "Likelihood-based fit statistics; sigma^2 is counted as a parameter in AIC, AICc, and BIC.", FIT_COLUMNS, arimaFitRows(fit), [], `${roleprefix}-fit-table`),
    ...extraTables,
    H.tableArtifact(`${label} fitted values`, "One-step-ahead in-sample predictions on the original scale; the first d + D*s observations have no prediction because they are consumed by differencing.", FITTED_COLUMNS(parsed), fittedRows, [], `${roleprefix}-fitted-table`),
    H.tableArtifact(`${label} forecasts`, `${options.horizon}-step forecasts with ${Math.round(options.confidenceLevel * 100)}% Gaussian prediction intervals from the state-space forecast variance (parameter uncertainty not included).`, FORECAST_COLUMNS(parsed), forecastRows, [], `${roleprefix}-forecast-table`),
    H.tableArtifact(`${label} residual autocorrelation`, `Ljung-Box statistics through lag ${lbLags} with ${modelDf} degrees of freedom removed for the fitted ARMA parameters.`, LJUNG_COLUMNS, ljung.rows, [], `${roleprefix}-residual-acf-table`),
    H.vegaArtifact(figure.role, figure.title, figure.spec),
    H.vegaArtifact(acf.role, acf.title, acf.spec),
  ];
  const estimates = coefficientRows.map((row) => ({ name: row.term, estimate: row.estimate, standardError: row.standardError }));
  estimates.push({ name: "sigma^2", estimate: fit.sigma2 });
  return {
    sample: { n: fit.nOriginal, nDifferenced: fit.n, order: fit.order, includeConstant: fit.includeConstant, horizon: options.horizon, ...sampleExtra },
    estimates,
    tests: [
      { name: `Ljung-Box on residuals through lag ${lbLags}`, statistic: ljung.summary.statistic, distribution: "chi-square", df: ljung.summary.df, pValue: ljung.summary.pValue },
      ...coefficientRows.filter((row) => row.zStatistic !== null).map((row) => ({ name: `${row.term} = 0`, statistic: row.zStatistic, distribution: "normal", df: null, pValue: row.pValue })),
    ],
    confidenceIntervals: coefficientRows.filter((row) => row.lower !== null).map((row) => ({ name: row.term, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: "Wald (normal)" })),
    effectSizes: [],
    assumptions: [
      { name: "innovations are white noise", status: ljung.summary.pValue > 0.05 ? "supported_by_ljung_box" : "not_established", statistic: ljung.summary.statistic, df: ljung.summary.df, pValue: ljung.summary.pValue },
      { name: "innovations are Gaussian", status: "not_established", detail: "prediction intervals assume Gaussian innovations" },
      { name: "differenced series is stationary and the fitted ARMA is invertible", status: fit.stationary && fit.invertible ? "satisfied_at_estimate" : "violated_at_estimate", stationary: fit.stationary, invertible: fit.invertible },
    ],
    diagnostics: [
      { name: "optimizer", status: fit.ml.converged ? "converged" : "iteration_limit", cssIterations: fit.css.iterations, mlIterations: fit.ml.iterations, cssConverged: fit.css.converged },
      { name: "standard errors", status: seAvailable ? "observed_information_numeric" : "not_available", hessianStatus: fit.hessianStatus },
      { name: "stationarity and invertibility", status: fit.stationary && fit.invertible ? "inside_region" : "at_or_outside_boundary", stationary: fit.stationary, invertible: fit.invertible },
      { name: "residual autocorrelation (Ljung-Box)", status: ljung.summary.pValue > 0.05 ? "no_evidence" : "serial_correlation_detected", lags: lbLags, df: ljung.summary.df, pValue: ljung.summary.pValue },
      { name: "prediction intervals", status: "asymptotic", detail: "Gaussian intervals from the state-space forecast variance; parameter-estimation uncertainty is not propagated" },
      ...extraDiagnostics,
    ],
    artifacts,
  };
}

// ---------------------------------------------------------------------------------------------
// ARIMA
// ---------------------------------------------------------------------------------------------

const arima = {
  method: "arima",
  family: "time-series",
  analysisModel: ANALYSIS_MODEL,
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    order: integerArrayOption(3, [5, 2, 5], [1, 0, 0]),
    seasonalOrder: integerArrayOption(4, [2, 1, 2, 52], [0, 0, 0, 0]),
    includeConstant: nullableBooleanOption(),
    horizon: integerOption(1, 100, 12),
    ljungBoxLags: nullableIntegerOption(1, 200),
  },
  dataSchema: seriesSchema(),
  parse(data, _options, H) {
    return K.parseSeries(data, H, { minLength: MIN_SERIES });
  },
  analyze(parsed, options, budget, H) {
    const [p, d, q] = options.order;
    const seasonal = validateSeasonalOrder(H, options.seasonalOrder, parsed.values.length);
    const includeConstant = options.includeConstant === null ? d + seasonal.D === 0 : options.includeConstant;
    const fit = K.fitArima(H, parsed.values, { p, d, q, P: seasonal.P, D: seasonal.D, Q: seasonal.Q, s: seasonal.s, includeConstant }, budget);
    return arimaModelOutputs(H, parsed, fit, options, budget, { roleprefix: "arima", sampleExtra: { constantRule: options.includeConstant === null ? "automatic (constant when d + D = 0)" : "user" } });
  },
  linkage: {
    neededWhen: "When a single series must be forecast or its dynamics summarised by an autoregressive integrated moving-average model of a chosen order.",
    decision: "Whether the specified ARIMA order fits adequately (white-noise residuals, interior estimates) and what the forecasts and their uncertainty are.",
    mustShow: "Coefficients with standard errors and intervals, likelihood-based fit statistics, residual Ljung-Box results, and forecasts with prediction bands.",
    userGoal: "Report a defensible ARIMA specification and its forecasts with honest interval and diagnostic evidence.",
    nextActions: [
      { trigger: "residual-serial-correlation-detected", action: "increase-ar-or-ma-order-and-compare-aicc", reason: "Remaining autocorrelation means the model has not captured the dynamics and its intervals are too narrow." },
      { trigger: "estimate-at-stationarity-boundary", action: "difference-once-more-or-drop-a-term", reason: "An AR root near one indicates under-differencing; an MA root near one indicates over-differencing." },
      { trigger: "standard-errors-unavailable", action: "simplify-the-order-or-inspect-identifiability", reason: "A singular information matrix usually means redundant AR and MA terms that cancel each other." },
      { trigger: "forecast-band-too-wide-for-decision", action: "shorten-the-horizon-or-add-covariates", reason: "State-space forecast variance grows with the horizon for integrated models, so long horizons rarely support decisions." },
    ],
  },
  fixture: { data: { values: seriesFixture("trend"), seriesLabel: "Quarterly index", timeLabel: "Quarter" }, options: { order: [1, 1, 0], includeConstant: true, horizon: 8 } },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "ARIMA(p,d,q) with optional multiplicative seasonal (P,D,Q)s part and optional constant (mean of the differenced series), estimated by conditional sum of squares then exact Gaussian ML through a Kalman innovations likelihood with concentrated sigma^2; observed-information standard errors, Ljung-Box residual check, and state-space forecasts with Gaussian intervals.",
    oracle: { level: "external-library-partial", evidence: ["contracts/time-series-extended-scipy-crosscheck.py"], verifiedOutputs: ["coefficients", "log-likelihood, AIC, BIC, sigma^2", "standard errors (approx Hessian)", "forecast means and variances", "residual Ljung-Box"], excludedOutputs: ["AICc (statsmodels does not report it)", "seasonal models at the stationarity boundary"] },
    diagnostic: { level: "method-specific-partial", emitted: ["optimizer convergence", "standard-error availability", "stationarity and invertibility at the estimate", "residual Ljung-Box", "interval method"], limitations: ["no exogenous regressors", "no parameter-uncertainty propagation into intervals", "no residual normality test"] },
    knownGaps: ["no ARIMAX", "no fractional differencing", "no Box-Cox transformation"],
  },
};

// ---------------------------------------------------------------------------------------------
// Auto ARIMA (Hyndman–Khandakar stepwise search)
// ---------------------------------------------------------------------------------------------

const SEARCH_COLUMNS = [col("evaluationOrder", "Order evaluated"), col("model", "Model", "string"), col("p", "p"), col("d", "d"), col("q", "q"), col("P", "P"), col("D", "D"), col("Q", "Q"), col("constant", "Constant", "boolean"), col("loglik", "Log-likelihood"), col("aic", "AIC"), col("aicc", "AICc"), col("bic", "BIC"), col("status", "Status", "string"), col("selected", "Selected", "boolean")];
const SEARCH_OPTIMIZER = Object.freeze({ computeHessian: false, maxIterations: 300, tolerance: 1e-9, multiStart: false });

function seasonalStrength(H, values, period, budget) {
  const stl = K.stlDecomposition(H, values, { period, seasonalLength: 7 }, budget);
  const remainderVariance = K.sampleVariance(stl.residual);
  const combined = stl.residual.map((value, index) => value + stl.seasonal[index]);
  const combinedVariance = K.sampleVariance(combined);
  return combinedVariance > 0 ? Math.max(0, 1 - remainderVariance / combinedVariance) : 0;
}

function chooseDifferencing(H, values, options, seasonal, budget) {
  const rows = [];
  let work = [...values];
  let D = 0;
  let strength = null;
  if (seasonal.seasonal) {
    strength = seasonalStrength(H, values, seasonal.s, budget);
    if (strength >= 0.64 && options.maxSeasonalD >= 1) { D = 1; work = K.differenceOnce(work, seasonal.s); }
    rows.push({ step: "seasonal strength (STL)", d: 0, D, statistic: strength, threshold: 0.64, decision: D === 1 ? "seasonal difference" : "no seasonal difference" });
  }
  let d = 0;
  for (;;) {
    if (work.length < MIN_SERIES) H.fail("STAT_INSUFFICIENT_SAMPLE", "too few observations remain after differencing to test for a unit root");
    const kpss = K.kpssTest(H, work, { regression: "c", nlags: null }, budget);
    const reject = kpss.statistic > kpss.critical["5%"];
    const canDifference = reject && d < options.maxD;
    rows.push({ step: `KPSS level test (d = ${d})`, d, D, statistic: kpss.statistic, threshold: kpss.critical["5%"], decision: canDifference ? "difference" : reject ? "stationarity rejected but maxD reached" : "stop" });
    if (!canDifference) break;
    work = K.differenceOnce(work, 1);
    d += 1;
  }
  return { d, D, rows, strength };
}

function candidateKey(spec) {
  return `${spec.p},${spec.q},${spec.P},${spec.Q},${spec.includeConstant ? 1 : 0}`;
}

function runSearch(H, values, options, base, budget) {
  const { d, D, s, seasonal } = base;
  const allowConstant = d + D <= 1;
  const maxP = options.maxP;
  const maxQ = options.maxQ;
  const maxSP = seasonal ? options.maxSeasonalP : 0;
  const maxSQ = seasonal ? options.maxSeasonalQ : 0;
  const cache = new Map();
  const rows = [];
  const value = (entry) => (entry.fit === null ? Infinity : entry[options.criterion]);
  const evaluate = (spec) => {
    const key = candidateKey(spec);
    if (cache.has(key)) return cache.get(key);
    let entry;
    try {
      const fit = K.fitArima(H, values, { p: spec.p, d, q: spec.q, P: spec.P, D, Q: spec.Q, s, includeConstant: spec.includeConstant }, budget, SEARCH_OPTIMIZER);
      entry = { spec, fit, loglik: fit.loglik, aic: fit.aic, aicc: fit.aicc, bic: fit.bic, status: fit.ml.converged ? "converged" : "iteration_limit" };
    } catch (error) {
      if (!(error instanceof H.StatisticsError) || error.code === "STAT_TIMEOUT") throw error;
      entry = { spec, fit: null, loglik: null, aic: null, aicc: null, bic: null, status: error.code };
    }
    entry.evaluationOrder = rows.length + 1;
    cache.set(key, entry);
    rows.push(entry);
    return entry;
  };
  const make = (p, q, P, Q, includeConstant) => ({ p: Math.min(p, maxP), q: Math.min(q, maxQ), P: Math.min(P, maxSP), Q: Math.min(Q, maxSQ), includeConstant: allowConstant && includeConstant });
  let best;
  if (options.stepwise) {
    const starts = [make(2, 2, 1, 1, true), make(0, 0, 0, 0, true), make(1, 0, 1, 0, true), make(0, 1, 0, 1, true)];
    best = null;
    for (const start of starts) {
      const entry = evaluate(start);
      if (best === null || value(entry) < value(best)) best = entry;
    }
    for (let round = 0; round < 40; round += 1) {
      budget.check();
      const { p, q, P, Q, includeConstant } = best.spec;
      const neighbors = [];
      for (const [dp, dq] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]]) {
        const np = p + dp;
        const nq = q + dq;
        if (np >= 0 && np <= maxP && nq >= 0 && nq <= maxQ) neighbors.push({ p: np, q: nq, P, Q, includeConstant });
      }
      if (seasonal) {
        for (const [dP, dQ] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]]) {
          const nP = P + dP;
          const nQ = Q + dQ;
          if (nP >= 0 && nP <= maxSP && nQ >= 0 && nQ <= maxSQ) neighbors.push({ p, q, P: nP, Q: nQ, includeConstant });
        }
      }
      if (allowConstant) neighbors.push({ p, q, P, Q, includeConstant: !includeConstant });
      let improved = null;
      for (const neighbor of neighbors) {
        if (rows.length >= 60) break;
        const entry = evaluate(neighbor);
        if (value(entry) < value(improved === null ? best : improved)) improved = entry;
      }
      if (improved === null) break;
      best = improved;
    }
  } else {
    const total = (maxP + 1) * (maxQ + 1) * (maxSP + 1) * (maxSQ + 1) * (allowConstant ? 2 : 1);
    if (total > 64) H.fail("STAT_LIMIT_EXCEEDED", `exhaustive search would fit ${total} models; lower the maximum orders or use stepwise = true`);
    best = null;
    for (let p = 0; p <= maxP; p += 1) for (let q = 0; q <= maxQ; q += 1) for (let P = 0; P <= maxSP; P += 1) for (let Q = 0; Q <= maxSQ; Q += 1) {
      for (const includeConstant of allowConstant ? [false, true] : [false]) {
        const entry = evaluate({ p, q, P, Q, includeConstant });
        if (best === null || value(entry) < value(best)) best = entry;
      }
    }
  }
  if (best === null || best.fit === null || !Number.isFinite(value(best))) H.fail("STAT_NON_CONVERGENCE", "no candidate ARIMA model produced a finite information criterion");
  return { best, rows, allowConstant };
}

const autoArima = {
  method: "auto_arima",
  family: "time-series",
  analysisModel: ANALYSIS_MODEL,
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    maxP: integerOption(0, 5, 3),
    maxQ: integerOption(0, 5, 3),
    maxD: integerOption(0, 2, 2),
    seasonalPeriod: nullableIntegerOption(2, 52),
    maxSeasonalP: integerOption(0, 2, 1),
    maxSeasonalQ: integerOption(0, 2, 1),
    maxSeasonalD: integerOption(0, 1, 1),
    criterion: enumOption(["aicc", "aic", "bic"], "aicc"),
    stepwise: booleanOption(true),
    horizon: integerOption(1, 100, 12),
    ljungBoxLags: nullableIntegerOption(1, 200),
  },
  dataSchema: seriesSchema(),
  parse(data, _options, H) {
    return K.parseSeries(data, H, { minLength: MIN_SERIES });
  },
  analyze(parsed, options, budget, H) {
    const n = parsed.values.length;
    const seasonal = options.seasonalPeriod === null ? { s: 1, seasonal: false } : { s: options.seasonalPeriod, seasonal: true };
    if (seasonal.seasonal && n < 2 * seasonal.s + 2) H.fail("STAT_INSUFFICIENT_SAMPLE", `a seasonal period of ${seasonal.s} needs at least ${2 * seasonal.s + 2} observations`);
    const differencing = chooseDifferencing(H, parsed.values, options, seasonal, budget);
    const search = runSearch(H, parsed.values, options, { d: differencing.d, D: differencing.D, s: seasonal.s, seasonal: seasonal.seasonal }, budget);
    const spec = search.best.spec;
    const fit = K.fitArima(H, parsed.values, { p: spec.p, d: differencing.d, q: spec.q, P: spec.P, D: differencing.D, Q: spec.Q, s: seasonal.s, includeConstant: spec.includeConstant }, budget, { ...SEARCH_OPTIMIZER, computeHessian: true });
    const searchRows = search.rows.map((entry) => ({
      evaluationOrder: entry.evaluationOrder,
      model: orderLabel({ p: entry.spec.p, d: differencing.d, q: entry.spec.q, P: entry.spec.P, D: differencing.D, Q: entry.spec.Q, s: seasonal.seasonal ? seasonal.s : null }),
      p: entry.spec.p, d: differencing.d, q: entry.spec.q, P: entry.spec.P, D: differencing.D, Q: entry.spec.Q, constant: entry.spec.includeConstant,
      loglik: entry.loglik, aic: entry.aic, aicc: finiteOrNull(entry.aicc), bic: entry.bic, status: entry.status, selected: entry === search.best,
    }));
    const differencingRows = differencing.rows;
    const extraTables = [
      H.tableArtifact("Differencing selection", "Seasonal difference chosen by STL seasonal strength (threshold 0.64); regular differences chosen by repeated KPSS level tests at the 5% critical value.", [col("step", "Step", "string"), col("d", "d"), col("D", "D"), col("statistic", "Statistic"), col("threshold", "Threshold"), col("decision", "Decision", "string")], differencingRows, [], "auto-arima-differencing-table"),
      H.tableArtifact("Model search", `${options.stepwise ? "Stepwise (Hyndman-Khandakar 2008)" : "Exhaustive"} search over ARMA orders${seasonal.seasonal ? " and seasonal orders" : ""}${search.allowConstant ? " with and without a constant" : " without a constant (d + D > 1)"}, ranked by ${options.criterion.toUpperCase()}.`, SEARCH_COLUMNS, searchRows, [], "auto-arima-search-table"),
    ];
    const extraDiagnostics = [
      { name: "model search", status: options.stepwise ? "stepwise" : "exhaustive", criterion: options.criterion, modelsEvaluated: searchRows.length, failed: searchRows.filter((row) => row.status !== "converged" && row.status !== "iteration_limit").length },
      { name: "differencing", status: "automatic", d: differencing.d, D: differencing.D, seasonalStrength: differencing.strength, rule: "STL seasonal strength >= 0.64 then repeated KPSS at 5%" },
    ];
    return arimaModelOutputs(H, parsed, fit, options, budget, { roleprefix: "auto-arima", extraTables, extraDiagnostics, sampleExtra: { criterion: options.criterion, modelsEvaluated: searchRows.length, seasonalPeriod: seasonal.seasonal ? seasonal.s : null } });
  },
  linkage: {
    neededWhen: "When the ARIMA order is not known in advance and a reproducible, criterion-based search over differencing and ARMA orders is required.",
    decision: "Which differencing and ARMA orders the data support, and whether the selected model produces adequate residuals and usable forecasts.",
    mustShow: "The differencing decisions with their test statistics, every candidate evaluated with its criterion value, the selected model's coefficients and diagnostics, and the forecasts.",
    userGoal: "Arrive at a defensible ARIMA specification without hand-tuning and document the search that produced it.",
    nextActions: [
      { trigger: "selected-model-fails-ljung-box", action: "raise-max-orders-or-add-seasonal-period", reason: "A search that cannot reach an adequate model is usually bounded too tightly or missing a seasonal component." },
      { trigger: "many-candidates-failed", action: "inspect-series-for-outliers-or-shorten-search", reason: "Candidate fits that fail to converge often signal outliers or near-cancelling AR and MA roots." },
      { trigger: "criterion-values-nearly-tied", action: "prefer-the-simpler-model-and-report-both", reason: "Differences under two criterion units do not separate models; parsimony and diagnostics should decide." },
      { trigger: "seasonal-strength-near-threshold", action: "rerun-with-forced-seasonal-difference-in-arima", reason: "The 0.64 strength rule is a heuristic; a borderline value warrants comparing both seasonal differencing choices." },
    ],
  },
  fixture: { data: { values: seriesFixture("trend"), seriesLabel: "Quarterly index", timeLabel: "Quarter" }, options: { maxP: 2, maxQ: 2, horizon: 8 } },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "Automatic differencing (STL seasonal strength for D, repeated KPSS for d) followed by a stepwise Hyndman-Khandakar or bounded exhaustive search over (p,q)(P,Q) and constant, each candidate fitted by CSS then exact ML and ranked by AICc, AIC, or BIC; the selected model is reported with full ARIMA outputs.",
    oracle: { level: "external-library-partial", evidence: ["contracts/time-series-extended-scipy-crosscheck.py"], verifiedOutputs: ["KPSS differencing statistics", "seasonal strength", "log-likelihood and AIC of every converged candidate", "selected model is the criterion minimum among evaluated candidates", "selected-model coefficients, forecasts, and Ljung-Box"], excludedOutputs: ["equivalence with other stepwise implementations (search path is implementation-specific)", "candidates that failed to converge"] },
    diagnostic: { level: "method-specific-partial", emitted: ["search summary", "differencing rule", "all ARIMA diagnostics of the selected model"], limitations: ["search path can differ from other packages even when the final model agrees", "no approximation step for long series"] },
    knownGaps: ["no OCSB or Canova-Hansen seasonal test", "no Box-Cox selection", "no exogenous regressors"],
  },
};


// ---------------------------------------------------------------------------------------------
// Exponential smoothing
// ---------------------------------------------------------------------------------------------

const SMOOTHING_LABELS = Object.freeze({ simple: "Simple exponential smoothing", holt: "Holt linear trend", holt_winters_additive: "Holt-Winters additive seasonal", holt_winters_multiplicative: "Holt-Winters multiplicative seasonal" });

const exponentialSmoothing = {
  method: "exponential_smoothing",
  family: "time-series",
  analysisModel: ANALYSIS_MODEL,
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    smoothingModel: enumOption(["simple", "holt", "holt_winters_additive", "holt_winters_multiplicative"], "simple"),
    seasonalPeriod: nullableIntegerOption(2, 52),
    damped: booleanOption(false),
    horizon: integerOption(1, 100, 12),
    seed: integerOption(0, 2147483647, 20240901),
  },
  dataSchema: seriesSchema(),
  parse(data, _options, H) {
    return K.parseSeries(data, H, { minLength: MIN_SERIES });
  },
  analyze(parsed, options, budget, H) {
    const { values } = parsed;
    const n = values.length;
    const model = options.smoothingModel;
    const seasonal = model.startsWith("holt_winters");
    if (seasonal && options.seasonalPeriod === null) H.fail("STAT_INVALID_INPUT", "options.seasonalPeriod is required for Holt-Winters models");
    if (options.damped && model === "simple") H.fail("STAT_INVALID_INPUT", "options.damped requires a trend component (holt or holt_winters models)");
    const period = seasonal ? options.seasonalPeriod : null;
    const fit = K.fitExponentialSmoothing(H, values, { model, period, damped: options.damped }, budget);
    const z = zQuantile(H, 0.5 + options.confidenceLevel / 2);
    const forecast = K.etsForecast(H, fit, options.horizon, options.confidenceLevel, options.seed, budget);
    const fittedRows = values.map((value, index) => ({ index: index + 1, time: parsed.time[index], value, fitted: fit.fitted[index], residual: fit.residuals[index] }));
    const forecastRows = forecastRowsFrom(parsed, forecast.mean, forecast.variance, z);
    const parameterRows = [
      { parameter: "alpha (level)", estimate: fit.params.alpha, role: "smoothing" },
      { parameter: "beta (trend)", estimate: fit.hasTrend ? fit.params.beta : null, role: "smoothing" },
      { parameter: "gamma (seasonal)", estimate: seasonal ? fit.params.gamma : null, role: "smoothing" },
      { parameter: "phi (damping)", estimate: fit.damped ? fit.params.phi : null, role: "smoothing" },
      { parameter: "initial level", estimate: fit.initial.level, role: "initial state (heuristic)" },
      { parameter: "initial trend", estimate: fit.hasTrend ? fit.initial.trend : null, role: "initial state (heuristic)" },
      { parameter: "final level", estimate: fit.finalLevel, role: "final state" },
      { parameter: "final trend", estimate: fit.hasTrend ? fit.finalTrend : null, role: "final state" },
    ];
    const seasonalRows = seasonal ? fit.initial.seasonal.map((initialIndex, index) => ({ season: index + 1, initialIndex, finalIndex: fit.finalSeasonals[index] })) : [];
    let absoluteError = 0;
    for (const residual of fit.residuals) absoluteError += Math.abs(residual);
    const fitRows = [
      { statistic: "SSE", value: fit.sse },
      { statistic: "MSE", value: fit.sse / n },
      { statistic: "RMSE", value: Math.sqrt(fit.sse / n) },
      { statistic: "MAE", value: absoluteError / n },
      { statistic: "sigma^2 (SSE / (n - parameters))", value: fit.sigma2 },
      { statistic: "log-likelihood (Gaussian, includes constant)", value: fit.loglik },
      { statistic: "AIC", value: fit.aic },
      { statistic: "AICc", value: finiteOrNull(fit.aicc) },
      { statistic: "BIC", value: fit.bic },
      { statistic: "parameters counted (smoothing + initial states)", value: fit.k },
      { statistic: "n", value: n },
    ];
    const lbLags = Math.max(1, Math.min(10, Math.floor(n / 4)));
    const ljung = ljungBoxRows(H, fit.residuals, lbLags, 0, zQuantile(H, 0.975), budget);
    const label = `${SMOOTHING_LABELS[model]}${fit.damped ? " (damped)" : ""}`;
    const figure = forecastFigure("ets-forecast-figure", `${label}: ${parsed.seriesLabel}`, parsed, fittedRows, forecastRows, options.confidenceLevel);
    const acf = acfFigure("ets-residual-acf-figure", `${label} residual autocorrelation`, ljung.rows);
    const boundaryFlags = [];
    if (fit.params.alpha < 1e-4 || fit.params.alpha > 1 - 1e-4) boundaryFlags.push("alpha");
    if (fit.hasTrend && fit.params.beta < 1e-6) boundaryFlags.push("beta");
    if (seasonal && fit.params.gamma < 1e-6) boundaryFlags.push("gamma");
    const artifacts = [
      H.tableArtifact(`${label}: parameters`, "Smoothing parameters minimising the in-sample sum of squared one-step errors (bounded Nelder-Mead from a grid start) with Hyndman et al. (2008) heuristic initial states.", [col("parameter", "Parameter", "string"), col("estimate", "Estimate"), col("role", "Role", "string")], parameterRows, [], "ets-parameter-table"),
      H.tableArtifact(`${label}: fit statistics`, "Error measures and Gaussian-likelihood criteria; the log-likelihood includes the n(1 + log 2 pi) constant that some packages omit.", FIT_COLUMNS, fitRows, [], "ets-fit-table"),
      H.tableArtifact(`${label}: fitted values`, "One-step-ahead in-sample predictions from the smoothing recursions.", FITTED_COLUMNS(parsed), fittedRows, [], "ets-fitted-table"),
      H.tableArtifact(`${label}: forecasts`, `${options.horizon}-step forecasts with ${Math.round(options.confidenceLevel * 100)}% prediction intervals; ${forecast.intervalMethod}.`, FORECAST_COLUMNS(parsed), forecastRows, [], "ets-forecast-table"),
      H.tableArtifact(`${label}: residual autocorrelation`, `Ljung-Box statistics through lag ${lbLags} (no degrees-of-freedom adjustment for smoothing parameters).`, LJUNG_COLUMNS, ljung.rows, [], "ets-residual-acf-table"),
      H.vegaArtifact(figure.role, figure.title, figure.spec),
      H.vegaArtifact(acf.role, acf.title, acf.spec),
    ];
    if (seasonal) artifacts.splice(1, 0, H.tableArtifact(`${label}: seasonal indices`, "Heuristic initial seasonal indices and the final smoothed indices used for forecasting.", [col("season", "Season"), col("initialIndex", "Initial index"), col("finalIndex", "Final index")], seasonalRows, [], "ets-seasonal-table"));
    return {
      sample: { n, model, seasonalPeriod: period, damped: fit.damped, horizon: options.horizon },
      estimates: parameterRows.filter((row) => row.estimate !== null).map((row) => ({ name: row.parameter, estimate: row.estimate })),
      tests: [{ name: `Ljung-Box on residuals through lag ${lbLags}`, statistic: ljung.summary.statistic, distribution: "chi-square", df: ljung.summary.df, pValue: ljung.summary.pValue }],
      confidenceIntervals: [],
      effectSizes: [],
      assumptions: [
        { name: "one-step errors are white noise", status: ljung.summary.pValue > 0.05 ? "supported_by_ljung_box" : "not_established", statistic: ljung.summary.statistic, df: ljung.summary.df, pValue: ljung.summary.pValue },
        { name: "errors are Gaussian and homoscedastic (additive-error intervals)", status: "not_established" },
        { name: "seasonal pattern is stable over the sample", status: seasonal ? "requires_design_review" : "not_applicable" },
      ],
      diagnostics: [
        { name: "optimizer", status: fit.converged ? "converged" : "iteration_limit", iterations: fit.iterations },
        { name: "parameter boundary", status: boundaryFlags.length ? "at_boundary" : "interior", parameters: boundaryFlags.join(",") },
        { name: "residual autocorrelation (Ljung-Box)", status: ljung.summary.pValue > 0.05 ? "no_evidence" : "serial_correlation_detected", lags: lbLags, pValue: ljung.summary.pValue },
        { name: "prediction intervals", status: fit.seasonalType === "multiplicative" ? "simulated" : "analytic", method: forecast.intervalMethod, seed: fit.seasonalType === "multiplicative" ? options.seed : null },
        { name: "initialization", status: "heuristic", detail: "Hyndman, Koehler, Ord & Snyder (2008) section 2.6 heuristic initial states; not jointly estimated" },
      ],
      artifacts,
    };
  },
  linkage: {
    neededWhen: "When a series needs a short-horizon forecast with a transparent level/trend/seasonal structure rather than an ARMA parameterisation.",
    decision: "Which smoothing structure (level only, trend, damped trend, additive or multiplicative seasonality) tracks the series and what the forecasts and intervals are.",
    mustShow: "The smoothing parameters, initial and final states, in-sample error measures, residual autocorrelation, and forecasts with prediction bands.",
    userGoal: "Produce and justify an exponential-smoothing forecast whose structure and uncertainty can be explained to non-specialists.",
    nextActions: [
      { trigger: "gamma-at-zero-boundary", action: "compare-with-non-seasonal-model-by-aicc", reason: "A seasonal smoothing weight of zero means the seasonal pattern is frozen at its initial estimate and may not be needed." },
      { trigger: "residual-serial-correlation-detected", action: "compare-with-arima-on-the-same-series", reason: "Autocorrelated one-step errors indicate dynamics the smoothing structure cannot represent." },
      { trigger: "trend-extrapolates-far-beyond-history", action: "enable-damped-trend-and-compare", reason: "Undamped linear trends extrapolate indefinitely and overshoot at longer horizons." },
      { trigger: "multiplicative-intervals-requested", action: "report-seed-and-replicate-count-with-intervals", reason: "Simulated intervals are reproducible only with the seed and replicate count that produced them." },
    ],
  },
  fixture: { data: { values: seriesFixture("seasonal"), seriesLabel: "Monthly passengers (thousands)", timeLabel: "Month" }, options: { smoothingModel: "holt_winters_additive", seasonalPeriod: 12, horizon: 12 } },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "Simple, Holt, damped Holt, and Holt-Winters additive/multiplicative smoothing with heuristic initial states and SSE-minimising parameters; analytic class-1 prediction intervals for additive-error structures and seeded simulated intervals for multiplicative seasonality.",
    oracle: { level: "external-library-partial", evidence: ["contracts/time-series-extended-scipy-crosscheck.py"], verifiedOutputs: ["smoothing parameters", "initial states", "SSE and fitted values", "forecast means", "analytic interval variances (first-principles recomputation)"], excludedOutputs: ["simulated multiplicative intervals", "AIC constant convention"] },
    diagnostic: { level: "method-specific-partial", emitted: ["optimizer convergence", "parameter boundary flags", "residual Ljung-Box", "interval method", "initialization method"], limitations: ["initial states are heuristic, not jointly estimated", "no Box-Cox or bias adjustment"] },
    knownGaps: ["no multiplicative trend", "no ETS state-space likelihood estimation", "no automatic model selection"],
  },
};

// ---------------------------------------------------------------------------------------------
// Seasonal decomposition
// ---------------------------------------------------------------------------------------------

function decompositionStrength(observedLog, trend, seasonal, residual) {
  const rows = [];
  for (let index = 0; index < trend.length; index += 1) if (trend[index] !== null && residual[index] !== null) rows.push(index);
  if (rows.length < 3) return { trend: null, seasonal: null, n: rows.length };
  const residualVariance = K.sampleVariance(rows.map((index) => residual[index]));
  const trendPlusResidual = K.sampleVariance(rows.map((index) => trend[index] + residual[index]));
  const seasonalPlusResidual = K.sampleVariance(rows.map((index) => seasonal[index] + residual[index]));
  return {
    trend: trendPlusResidual > 0 ? Math.max(0, 1 - residualVariance / trendPlusResidual) : null,
    seasonal: seasonalPlusResidual > 0 ? Math.max(0, 1 - residualVariance / seasonalPlusResidual) : null,
    n: rows.length,
  };
}

const seasonalDecomposition = {
  method: "seasonal_decomposition",
  family: "time-series",
  analysisModel: ANALYSIS_MODEL,
  optionKeys: ["timeoutMs"],
  customOptions: {
    decompositionMethod: enumOption(["classical", "stl"], "classical"),
    decompositionModel: enumOption(["additive", "multiplicative"], "additive"),
    seasonalPeriod: nullableIntegerOption(2, 52),
    stlSeasonalLength: integerOption(3, 101, 7),
    stlTrendLength: nullableIntegerOption(3, 1001),
    stlRobust: booleanOption(false),
  },
  dataSchema: seriesSchema(),
  parse(data, _options, H) {
    return K.parseSeries(data, H, { minLength: MIN_SERIES });
  },
  analyze(parsed, options, budget, H) {
    const { values } = parsed;
    const n = values.length;
    if (options.seasonalPeriod === null) H.fail("STAT_INVALID_INPUT", "options.seasonalPeriod is required for seasonal decomposition");
    const period = options.seasonalPeriod;
    if (n < 2 * period) H.fail("STAT_INSUFFICIENT_SAMPLE", `seasonal decomposition needs at least two full cycles (${2 * period} observations)`);
    const multiplicative = options.decompositionModel === "multiplicative";
    if (options.decompositionMethod === "stl" && multiplicative) H.fail("STAT_INVALID_INPUT", "STL is an additive decomposition; log-transform the series first to model a multiplicative structure");
    let components;
    let settings;
    if (options.decompositionMethod === "classical") {
      components = K.classicalDecomposition(H, values, period, options.decompositionModel, budget);
      settings = { method: "classical", filter: period % 2 === 0 ? "2 x MA(period)" : `MA(${period})` };
    } else {
      components = K.stlDecomposition(H, values, { period, seasonalLength: options.stlSeasonalLength, trendLength: options.stlTrendLength, robust: options.stlRobust }, budget);
      settings = { method: "stl", seasonalLength: components.seasonalLength, trendLength: components.trendLength, lowPassLength: components.lowPassLength, innerIterations: components.innerIterations, outerIterations: components.outerIterations, robust: options.stlRobust };
    }
    const toLog = (value) => (value === null ? null : Math.log(value));
    const strength = multiplicative
      ? decompositionStrength(null, components.trend.map(toLog), components.seasonal.map(toLog), components.residual.map(toLog))
      : decompositionStrength(null, components.trend, components.seasonal, components.residual);
    const componentRows = values.map((value, index) => ({ index: index + 1, time: parsed.time[index], observed: value, trend: components.trend[index], seasonal: components.seasonal[index], residual: components.residual[index], ...(settings.method === "stl" ? { weight: components.weights[index] } : {}) }));
    const longRows = [];
    for (const row of componentRows) {
      longRows.push({ index: row.index, time: row.time, component: "observed", value: row.observed });
      longRows.push({ index: row.index, time: row.time, component: "trend", value: row.trend });
      longRows.push({ index: row.index, time: row.time, component: "seasonal", value: row.seasonal });
      longRows.push({ index: row.index, time: row.time, component: "residual", value: row.residual });
    }
    const seasonalRows = [];
    for (let season = 0; season < period; season += 1) {
      const cycleValues = [];
      for (let index = season; index < n; index += period) cycleValues.push(components.seasonal[index]);
      const mean = K.meanOf(cycleValues);
      seasonalRows.push({ season: season + 1, meanEffect: mean, minEffect: Math.min(...cycleValues), maxEffect: Math.max(...cycleValues), cycles: cycleValues.length });
    }
    const strengthRows = [
      { component: "trend", strength: strength.trend, basis: multiplicative ? "log scale" : "additive" },
      { component: "seasonal", strength: strength.seasonal, basis: multiplicative ? "log scale" : "additive" },
    ];
    const componentColumns = [col("index", "Index"), col("time", parsed.timeLabel), col("observed", parsed.seriesLabel), col("trend", "Trend"), col("seasonal", "Seasonal"), col("residual", "Residual"), ...(settings.method === "stl" ? [col("weight", "Robustness weight")] : [])];
    const title = settings.method === "stl" ? `STL decomposition (period ${period})` : `Classical ${options.decompositionModel} decomposition (period ${period})`;
    return {
      sample: { n, seasonalPeriod: period, cycles: Math.floor(n / period), ...settings },
      estimates: [
        { name: "trend strength (Wang, Smith & Hyndman 2006)", estimate: strength.trend, basis: strengthRows[0].basis },
        { name: "seasonal strength (Wang, Smith & Hyndman 2006)", estimate: strength.seasonal, basis: strengthRows[1].basis },
      ],
      tests: [],
      confidenceIntervals: [],
      effectSizes: [],
      assumptions: [
        { name: "seasonal period is correct", status: "requires_design_review", period },
        { name: settings.method === "classical" ? "seasonal pattern is constant across cycles" : "seasonal pattern evolves smoothly across cycles", status: "not_established" },
        { name: multiplicative ? "components combine multiplicatively" : "components combine additively", status: "requires_design_review" },
      ],
      diagnostics: [
        { name: "component availability", status: settings.method === "classical" ? "trend_undefined_at_ends" : "complete", missingTrend: components.trend.filter((value) => value === null).length },
        { name: "strength summary", status: strength.seasonal !== null && strength.seasonal >= 0.64 ? "strong_seasonality" : "weak_or_moderate_seasonality", trendStrength: strength.trend, seasonalStrength: strength.seasonal, rowsUsed: strength.n },
        { name: "smoothing settings", status: settings.method === "stl" ? (options.stlRobust ? "stl_robust" : "stl") : "classical_moving_average", ...settings },
      ],
      artifacts: [
        H.tableArtifact(`${title}: components`, settings.method === "classical" ? "Centered moving-average trend, average detrended seasonal effects normalised per cycle, and the remainder; the trend is undefined for the first and last half-window." : `Loess-based STL (Cleveland et al. 1990) with seasonal window ${settings.seasonalLength}, trend window ${settings.trendLength}, low-pass window ${settings.lowPassLength}${options.stlRobust ? ", robustness iterations" : ""}.`, componentColumns, componentRows, [], "decomposition-component-table"),
        H.tableArtifact(`${title}: seasonal effects`, settings.method === "classical" ? "Seasonal effect per position in the cycle (constant across cycles)." : "Mean, minimum, and maximum STL seasonal effect per position in the cycle.", [col("season", "Season"), col("meanEffect", "Mean effect"), col("minEffect", "Min effect"), col("maxEffect", "Max effect"), col("cycles", "Cycles")], seasonalRows, [], "decomposition-seasonal-table"),
        H.tableArtifact(`${title}: strength`, "Strength of trend and seasonality, 1 - var(remainder) / var(component + remainder), clipped at 0 (Wang, Smith & Hyndman 2006).", [col("component", "Component", "string"), col("strength", "Strength"), col("basis", "Basis", "string")], strengthRows, [], "decomposition-strength-table"),
        H.tableArtifact(`${title}: long-format components`, "Observed, trend, seasonal, and residual components in long format for the faceted figure.", [col("index", "Index"), col("time", parsed.timeLabel), col("component", "Component", "string"), col("value", "Value")], longRows, [], "decomposition-long-table"),
        H.vegaArtifact("decomposition-figure", `${title}: ${parsed.seriesLabel}`, {
          data: { values: longRows },
          mark: { type: "line", color: COLORS.observed },
          encoding: {
            x: { field: "time", type: "quantitative", title: parsed.timeLabel },
            y: { field: "value", type: "quantitative", title: null },
            row: { field: "component", type: "nominal", sort: ["observed", "trend", "seasonal", "residual"], title: null },
            tooltip: [{ field: "index" }, { field: "component" }, { field: "value", format: ".4g" }],
          },
          resolve: { scale: { y: "independent" } },
          height: 90,
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When a seasonal series must be separated into trend, seasonal, and remainder components before modelling, adjustment, or reporting.",
    decision: "How strong the seasonal and trend components are, whether seasonality is stable across cycles, and what remains once both are removed.",
    mustShow: "Every component per observation, the seasonal effect by position in the cycle, the strength measures, and the faceted component figure.",
    userGoal: "Report seasonally adjusted values and justify the seasonal treatment chosen for downstream forecasting or comparison.",
    nextActions: [
      { trigger: "seasonal-strength-below-threshold", action: "model-without-seasonal-component-and-compare", reason: "Weak seasonality (strength under 0.64) is usually not worth the extra parameters in a forecasting model." },
      { trigger: "seasonal-effects-vary-across-cycles", action: "switch-from-classical-to-stl", reason: "The classical method forces one seasonal pattern; STL lets the pattern evolve and reveals whether it does." },
      { trigger: "remainder-shows-outliers", action: "enable-stl-robust-weights-and-inspect", reason: "Robustness weights downweight outliers so they do not distort the trend and seasonal estimates." },
      { trigger: "variance-grows-with-level", action: "use-multiplicative-model-or-log-transform", reason: "An additive decomposition of a series whose seasonal swing scales with its level leaves structure in the remainder." },
    ],
  },
  fixture: { data: { values: seriesFixture("seasonal"), seriesLabel: "Monthly passengers (thousands)", timeLabel: "Month" }, options: { decompositionMethod: "stl", seasonalPeriod: 12, stlSeasonalLength: 7 } },
  matlabParity: { taxonomyIds: ["matlab.stats.descriptive-visualization"] },
  coverage: {
    implementedBoundary: "Classical additive/multiplicative moving-average decomposition and additive STL (loess) decomposition with optional robustness weights; strength of trend and seasonality per Wang, Smith & Hyndman.",
    oracle: { level: "external-library-partial", evidence: ["contracts/time-series-extended-scipy-crosscheck.py"], verifiedOutputs: ["classical trend, seasonal, and residual", "STL trend, seasonal, residual, and robustness weights", "strength measures (first-principles recomputation)"], excludedOutputs: ["multiplicative STL (not offered)", "X-13 style adjustments"] },
    diagnostic: { level: "method-specific-partial", emitted: ["component availability", "strength summary", "smoothing settings"], limitations: ["no test for changing seasonality", "no calendar or trading-day effects"] },
    knownGaps: ["no X-13ARIMA-SEATS", "no multiple seasonal periods (MSTL)", "no Box-Cox transformation"],
  },
};

// ---------------------------------------------------------------------------------------------
// Spectral periodogram
// ---------------------------------------------------------------------------------------------

const spectralPeriodogram = {
  method: "spectral_periodogram",
  family: "time-series",
  analysisModel: ANALYSIS_MODEL,
  optionKeys: ["timeoutMs"],
  customOptions: {
    spectralMethod: enumOption(["periodogram", "welch", "lomb_scargle"], "periodogram"),
    segmentLength: nullableIntegerOption(8, MAX_ROWS),
    frequencyCount: integerOption(8, 2000, 200),
    peakCount: integerOption(1, 20, 5),
    // A trend puts most of its power at the lowest resolvable frequency, which then outranks the
    // cycle the researcher is looking for. Default stays "mean" (the raw spectrum minus the DC
    // term, i.e. what a spectral estimate normally means); "linear" removes a straight-line trend
    // first, "none" leaves the series untouched.
    detrend: enumOption(["none", "mean", "linear"], "mean"),
  },
  dataSchema: seriesSchema(),
  parse(data, options, H) {
    return K.parseSeries(data, H, { minLength: MIN_SERIES, allowIrregular: options.spectralMethod === "lomb_scargle" });
  },
  analyze(parsed, options, budget, H) {
    const { time, interval } = parsed;
    const raw = parsed.values;
    const n = raw.length;
    if (K.sampleVariance(raw) <= 0) H.fail("STAT_DEGENERATE", "series is constant; the spectrum is identically zero");
    // Detrend before estimating, and record exactly what was removed so the spectrum is never
    // reported as if it came from the untouched series.
    let values = raw;
    let removedSlope = null;
    let removedIntercept = null;
    if (options.detrend === "mean") {
      const mean = raw.reduce((total, value) => total + value, 0) / n;
      values = raw.map((value) => value - mean);
      removedIntercept = mean;
    } else if (options.detrend === "linear") {
      const meanIndex = (n - 1) / 2;
      const meanValue = raw.reduce((total, value) => total + value, 0) / n;
      let covariance = 0;
      let variance = 0;
      for (let index = 0; index < n; index += 1) {
        covariance += (index - meanIndex) * (raw[index] - meanValue);
        variance += (index - meanIndex) ** 2;
      }
      removedSlope = variance > 0 ? covariance / variance : 0;
      removedIntercept = meanValue - removedSlope * meanIndex;
      values = raw.map((value, index) => value - (removedIntercept + removedSlope * index));
    }
    if (K.sampleVariance(values) <= 0) H.fail("STAT_DEGENERATE", "the series is exactly the removed trend; nothing remains to estimate");
    let spectrumRows;
    let settings;
    const tests = [];
    const diagnostics = [];
    if (options.spectralMethod === "periodogram") {
      const spectrum = K.periodogram(values, interval, budget);
      spectrumRows = spectrum.frequencies.map((frequency, index) => ({ index, frequency, period: frequency > 0 ? 1 / frequency : null, power: spectrum.power[index] }));
      const interiorEnd = Math.floor((n - 1) / 2);
      const interior = spectrum.power.slice(1, interiorEnd + 1);
      const fisher = K.fisherG(H, interior);
      tests.push({ name: "Fisher g test for the largest periodogram ordinate", statistic: fisher.g, distribution: "Fisher (1929) exact under Gaussian white noise", df: null, pValue: fisher.pValue, ordinates: fisher.m, peakFrequency: spectrum.frequencies[fisher.maxIndex + 1] });
      diagnostics.push({ name: "Fisher g test", status: fisher.pValue < 0.05 ? "periodicity_detected" : "no_periodicity_detected", g: fisher.g, pValue: fisher.pValue, ordinates: fisher.m });
      settings = { method: "periodogram", window: "boxcar", detrend: "constant", scaling: "density", samplingFrequency: 1 / interval };
    } else if (options.spectralMethod === "welch") {
      const nperseg = options.segmentLength === null ? Math.min(256, n) : options.segmentLength;
      if (nperseg > n) H.fail("STAT_INVALID_INPUT", `options.segmentLength must not exceed the series length ${n}`);
      const spectrum = K.welch(values, interval, nperseg, budget);
      spectrumRows = spectrum.frequencies.map((frequency, index) => ({ index, frequency, period: frequency > 0 ? 1 / frequency : null, power: spectrum.power[index] }));
      settings = { method: "welch", window: "hann (periodic)", segmentLength: spectrum.nperseg, overlap: spectrum.noverlap, segments: spectrum.segments, detrend: "constant per segment", scaling: "density", samplingFrequency: 1 / interval };
      diagnostics.push({ name: "segment averaging", status: spectrum.segments >= 4 ? "adequate" : "few_segments", segments: spectrum.segments, approximateDegreesOfFreedom: 2 * spectrum.segments });
    } else {
      const span = time[n - 1] - time[0];
      const spacings = time.slice(1).map((value, index) => value - time[index]).sort((a, b) => a - b);
      const medianSpacing = spacings.length % 2 === 1 ? spacings[(spacings.length - 1) / 2] : (spacings[spacings.length / 2 - 1] + spacings[spacings.length / 2]) / 2;
      const fmin = 1 / span;
      const fmax = 0.5 / medianSpacing;
      if (!(fmax > fmin)) H.fail("STAT_DEGENERATE", "time span is too short relative to the sampling spacing to form a frequency grid");
      const count = options.frequencyCount;
      const frequencies = Array.from({ length: count }, (_, index) => fmin + (fmax - fmin) * index / (count - 1));
      const power = K.lombScargle(time, values, frequencies, budget);
      spectrumRows = frequencies.map((frequency, index) => ({ index, frequency, period: 1 / frequency, power: power[index] }));
      const variance = K.sampleVariance(values);
      let maxIndex = 0;
      for (let index = 1; index < count; index += 1) if (power[index] > power[maxIndex]) maxIndex = index;
      const normalized = power[maxIndex] / variance;
      const falseAlarm = 1 - (1 - Math.exp(-normalized)) ** count;
      tests.push({ name: "Lomb-Scargle peak false-alarm probability", statistic: normalized, distribution: "exponential with Horne-Baliunas independent-frequency heuristic", df: null, pValue: Math.min(1, Math.max(0, falseAlarm)), independentFrequencies: count, peakFrequency: frequencies[maxIndex] });
      diagnostics.push({ name: "false-alarm probability", status: "heuristic", detail: `M = ${count} grid frequencies treated as independent (Horne & Baliunas 1986)`, pValue: Math.min(1, Math.max(0, falseAlarm)) });
      settings = { method: "lomb_scargle", normalization: "classical Scargle (1982), variance-unnormalised", frequencyMinimum: fmin, frequencyMaximum: fmax, frequencyCount: count, medianSpacing, irregular: !parsed.regular };
    }
    const ranked = spectrumRows.filter((row) => row.frequency > 0).sort((a, b) => b.power - a.power || a.frequency - b.frequency);
    const peakRows = ranked.slice(0, options.peakCount).map((row, rank) => ({ rank: rank + 1, frequency: row.frequency, period: row.period, power: row.power }));
    // A residual trend piles its power onto the longest resolvable period, where it outranks the
    // cycle the researcher came for. Say so instead of letting the top row be read as a real cycle.
    if (options.detrend !== "linear" && peakRows.length > 0 && peakRows[0].period !== null && peakRows[0].period >= n / 2) {
      const runnerUp = peakRows[1] ?? null;
      diagnostics.push({
        name: "low-frequency dominance",
        status: "possible_trend_leakage",
        detrend: options.detrend,
        dominantPeriod: peakRows[0].period,
        seriesLength: n,
        nextRankedPeriod: runnerUp ? runnerUp.period : null,
        detail: `The largest ordinate sits at period ${peakRows[0].period} for a series of length ${n}, which is what a remaining trend looks like rather than a resolvable cycle. Re-run with detrend "linear" to see the spectrum of the residuals${runnerUp ? `; the next ranked period is ${runnerUp.period}` : ""}.`,
      });
    }
    let totalPower = 0;
    for (const row of spectrumRows) totalPower += row.power;
    const spectrumColumns = [col("index", "Bin"), col("frequency", `Frequency (cycles per ${parsed.timeLabel.toLowerCase()} unit)`), col("period", "Period"), col("power", "Power spectral density")];
    return {
      sample: { n, ...settings, bins: spectrumRows.length },
      estimates: [
        { name: "dominant frequency", estimate: peakRows[0].frequency, period: peakRows[0].period, power: peakRows[0].power },
        { name: "total spectral power (sum of density bins)", estimate: totalPower },
      ],
      tests,
      confidenceIntervals: [],
      effectSizes: [],
      assumptions: [
        { name: "series is (weakly) stationary over the sample", status: "not_established" },
        { name: options.spectralMethod === "lomb_scargle" ? "sampling times are known exactly" : "observations are evenly spaced", status: options.spectralMethod === "lomb_scargle" || parsed.regular ? "satisfied" : "not_established" },
        { name: "no spectral leakage from strong trend", status: "not_established", detail: "only the mean is removed before transforming" },
      ],
      diagnostics: [
        ...diagnostics,
        { name: "resolution", status: "asymptotic", frequencyResolution: spectrumRows.length > 1 ? spectrumRows[1].frequency - spectrumRows[0].frequency : null },
      ],
      artifacts: [
        H.tableArtifact(`${settings.method === "periodogram" ? "Periodogram" : settings.method === "welch" ? "Welch power spectrum" : "Lomb-Scargle periodogram"}: ${parsed.seriesLabel}`, settings.method === "periodogram" ? "One-sided density-scaled periodogram of the mean-removed series (boxcar window)." : settings.method === "welch" ? `Welch average of ${settings.segments} Hann-windowed segments of length ${settings.segmentLength} with 50% overlap, density scaling.` : `Classical Lomb-Scargle periodogram on ${settings.frequencyCount} frequencies from 1/span to the pseudo-Nyquist limit 0.5 / median spacing.`, spectrumColumns, spectrumRows, [], "spectrum-table"),
        H.tableArtifact("Spectral peaks", `The ${peakRows.length} largest non-zero-frequency ordinates.`, [col("rank", "Rank"), col("frequency", "Frequency"), col("period", "Period"), col("power", "Power")], peakRows, [], "spectrum-peak-table"),
        H.vegaArtifact("spectrum-figure", `Power spectrum: ${parsed.seriesLabel}`, {
          layer: [
            lineLayer(spectrumRows, "frequency", "power", COLORS.observed, { xTitle: "Frequency", yTitle: "Power spectral density", tooltip: ["frequency", "period", "power"] }),
            { data: { values: peakRows }, mark: { type: "point", filled: true, color: COLORS.forecast, size: 80 }, encoding: { x: { field: "frequency", type: "quantitative" }, y: { field: "power", type: "quantitative" }, tooltip: [{ field: "rank" }, { field: "frequency", format: ".4g" }, { field: "period", format: ".4g" }] } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When hidden periodicities or the frequency content of a series must be quantified, or when observations are irregularly spaced and a Fourier periodogram is unavailable.",
    decision: "Which frequencies dominate the variance, whether the dominant peak is statistically distinguishable from white noise, and what seasonal period to carry into other models.",
    mustShow: "The full spectrum, the ranked peaks with their periods, the estimator settings (window, segments, grid), and the peak significance test where one applies.",
    userGoal: "Identify and defend the cycle lengths that structure the series before seasonal modelling.",
    nextActions: [
      { trigger: "periodicity-detected", action: "carry-peak-period-into-seasonal-decomposition", reason: "A significant spectral peak fixes the seasonal period that decomposition and seasonal ARIMA require as input." },
      { trigger: "spectrum-dominated-by-lowest-frequencies", action: "detrend-or-difference-and-recompute", reason: "Trend leaks power into the lowest bins and masks genuine cycles; only the mean is removed here." },
      { trigger: "few-welch-segments", action: "shorten-segment-length-or-use-raw-periodogram", reason: "Welch variance reduction needs several segments; with one or two the estimate is no better than the raw periodogram." },
      { trigger: "irregular-sampling", action: "use-lomb-scargle-and-report-false-alarm-heuristic", reason: "Fourier methods assume even spacing; Lomb-Scargle handles gaps but its false-alarm probability is only a heuristic." },
    ],
  },
  fixture: { data: { values: seriesFixture("seasonal"), seriesLabel: "Monthly passengers (thousands)", timeLabel: "Month" }, options: { spectralMethod: "periodogram", peakCount: 5 } },
  matlabParity: { taxonomyIds: ["matlab.stats.descriptive-visualization"] },
  coverage: {
    implementedBoundary: "Density-scaled periodogram with Fisher g test, Welch averaged periodogram with Hann window and 50% overlap, and classical Lomb-Scargle periodogram on a fixed frequency grid with a Horne-Baliunas false-alarm heuristic.",
    oracle: { level: "external-library-partial", evidence: ["contracts/time-series-extended-scipy-crosscheck.py"], verifiedOutputs: ["periodogram frequencies and densities", "Welch densities", "Lomb-Scargle powers on the same grid", "Fisher g statistic and p-value (first-principles recomputation)"], excludedOutputs: ["false-alarm probability (heuristic, not cross-checked against an external implementation)"] },
    diagnostic: { level: "method-specific-partial", emitted: ["Fisher g test or false-alarm heuristic", "segment adequacy", "frequency resolution"], limitations: ["no confidence intervals on spectral densities", "no multitaper estimator"] },
    knownGaps: ["no multitaper or autoregressive spectral estimation", "no coherence or cross-spectrum", "no window choice beyond boxcar and Hann"],
  },
};


// ---------------------------------------------------------------------------------------------
// Change-point detection
// ---------------------------------------------------------------------------------------------

const changePointDetection = {
  method: "change_point_detection",
  family: "time-series",
  analysisModel: ANALYSIS_MODEL,
  optionKeys: ["timeoutMs"],
  customOptions: {
    changePointMethod: enumOption(["pelt", "binary_segmentation"], "pelt"),
    penalty: enumOption(["bic", "mbic", "aic", "manual"], "bic"),
    penaltyValue: nullableNumberOption(0, 1e12),
    minSegmentLength: integerOption(1, 1000, 2),
    maxChanges: integerOption(1, 100, 10),
  },
  dataSchema: seriesSchema(),
  parse(data, _options, H) {
    return K.parseSeries(data, H, { minLength: MIN_SERIES });
  },
  analyze(parsed, options, budget, H) {
    const { values } = parsed;
    const n = values.length;
    if (options.minSegmentLength * 2 > n) H.fail("STAT_INVALID_INPUT", `options.minSegmentLength must be at most ${Math.floor(n / 2)} for this series`);
    if (K.sampleVariance(values) <= 0) H.fail("STAT_DEGENERATE", "series is constant; no change point can exist");
    const sigma = K.robustNoiseScale(values);
    let penalty;
    let penaltyRule;
    if (options.penalty === "manual") {
      if (options.penaltyValue === null || !(options.penaltyValue > 0)) H.fail("STAT_INVALID_INPUT", "options.penaltyValue must be a positive number when options.penalty is manual");
      penalty = options.penaltyValue;
      penaltyRule = "user (raw squared-error cost units)";
    } else {
      if (!(sigma > 0)) H.fail("STAT_DEGENERATE", "median absolute first difference is zero, so the noise scale cannot be estimated; supply penalty = manual with penaltyValue");
      if (options.penalty === "bic") { penalty = sigma * sigma * Math.log(n); penaltyRule = "sigma^2 log(n)"; }
      else if (options.penalty === "mbic") { penalty = 3 * sigma * sigma * Math.log(n); penaltyRule = "3 sigma^2 log(n)"; }
      else { penalty = 2 * sigma * sigma; penaltyRule = "2 sigma^2"; }
    }
    const result = options.changePointMethod === "pelt"
      ? K.pelt(H, values, penalty, options.minSegmentLength, budget)
      : K.binarySegmentation(H, values, penalty, options.minSegmentLength, options.maxChanges, budget);
    const cost = K.segmentCostFactory(values);
    const bounds = [0, ...result.changePoints, n];
    const segmentRows = [];
    const segmentMeans = Array(n).fill(0);
    const segmentIds = Array(n).fill(0);
    for (let segment = 0; segment + 1 < bounds.length; segment += 1) {
      const start = bounds[segment];
      const end = bounds[segment + 1];
      const slice = values.slice(start, end);
      const mean = K.meanOf(slice);
      for (let index = start; index < end; index += 1) { segmentMeans[index] = mean; segmentIds[index] = segment + 1; }
      segmentRows.push({ segment: segment + 1, startIndex: start + 1, endIndex: end, startTime: parsed.time[start], endTime: parsed.time[end - 1], n: end - start, mean, sd: slice.length > 1 ? Math.sqrt(K.sampleVariance(slice)) : null, cost: cost(start, end) });
    }
    const changeRows = result.changePoints.map((tau, order) => {
      const left = bounds[order];
      const right = bounds[order + 2];
      const meanBefore = segmentRows[order].mean;
      const meanAfter = segmentRows[order + 1].mean;
      return { order: order + 1, index: tau + 1, time: parsed.time[tau], meanBefore, meanAfter, shift: meanAfter - meanBefore, shiftInSigma: sigma > 0 ? (meanAfter - meanBefore) / sigma : null, costReduction: cost(left, right) - cost(left, tau) - cost(tau, right) };
    });
    const seriesRowsWithSegments = values.map((value, index) => ({ index: index + 1, time: parsed.time[index], value, segment: segmentIds[index], segmentMean: segmentMeans[index] }));
    const methodLabel = options.changePointMethod === "pelt" ? "PELT (Killick, Fearnhead & Eckley 2012)" : "binary segmentation";
    return {
      sample: { n, method: options.changePointMethod, penalty, penaltyRule, noiseScale: sigma, minSegmentLength: options.minSegmentLength, changePoints: result.changePoints.length },
      estimates: [
        { name: "number of change points", estimate: result.changePoints.length },
        { name: "robust noise scale (MAD of first differences / sqrt 2)", estimate: sigma },
        { name: "penalty", estimate: penalty, rule: penaltyRule },
        { name: "total within-segment squared error", estimate: result.totalCost },
        { name: "penalized objective", estimate: result.penalizedObjective },
      ],
      tests: [],
      confidenceIntervals: [],
      effectSizes: changeRows.map((row) => ({ name: `shift at index ${row.index}`, estimate: row.shift, standardized: row.shiftInSigma })),
      assumptions: [
        { name: "piecewise-constant mean with homoscedastic noise", status: "requires_design_review" },
        { name: "observations are independent within segments", status: "not_established", detail: "autocorrelation inflates the number of detected changes" },
        { name: "noise scale estimated from first differences is adequate", status: options.penalty === "manual" ? "not_applicable" : "asymptotic" },
      ],
      diagnostics: [
        { name: "search", status: options.changePointMethod === "pelt" ? "exact_penalized_optimum" : "greedy_approximation", method: methodLabel, maxChanges: options.changePointMethod === "pelt" ? null : options.maxChanges },
        { name: "change points", status: result.changePoints.length ? "changes_detected" : "no_change_detected", count: result.changePoints.length, indices: result.changePoints.map((tau) => tau + 1).join(",") },
        { name: "penalty", status: options.penalty === "manual" ? "user_specified" : "derived_from_noise_scale", value: penalty, rule: penaltyRule },
        { name: "uncertainty", status: "not_available", detail: "no confidence sets for change locations are computed" },
      ],
      artifacts: [
        H.tableArtifact("Change points", `Mean shifts found by ${methodLabel} with the L2 (squared-error) segment cost and penalty ${penaltyRule}; index is the first observation of the new segment.`, [col("order", "Order"), col("index", "Index"), col("time", parsed.timeLabel), col("meanBefore", "Mean before"), col("meanAfter", "Mean after"), col("shift", "Shift"), col("shiftInSigma", "Shift / sigma"), col("costReduction", "Cost reduction")], changeRows, changeRows.length ? [] : ["No change point exceeded the penalty."], "change-point-table"),
        H.tableArtifact("Segments", "Segment boundaries, sizes, means, standard deviations, and squared-error costs.", [col("segment", "Segment"), col("startIndex", "Start index"), col("endIndex", "End index"), col("startTime", "Start time"), col("endTime", "End time"), col("n", "n"), col("mean", "Mean"), col("sd", "SD"), col("cost", "Cost")], segmentRows, [], "change-point-segment-table"),
        H.tableArtifact("Series with segment means", "Each observation with its segment membership and the segment mean.", [col("index", "Index"), col("time", parsed.timeLabel), col("value", parsed.seriesLabel), col("segment", "Segment"), col("segmentMean", "Segment mean")], seriesRowsWithSegments, [], "change-point-series-table"),
        H.vegaArtifact("change-point-figure", `Change points: ${parsed.seriesLabel}`, {
          layer: [
            lineLayer(seriesRowsWithSegments, "time", "value", COLORS.observed, { xTitle: parsed.timeLabel, yTitle: parsed.seriesLabel, tooltip: ["index", "value", "segment"] }),
            { data: { values: seriesRowsWithSegments }, mark: { type: "line", color: COLORS.forecast, interpolate: "step-after", strokeWidth: 2 }, encoding: { x: { field: "time", type: "quantitative" }, y: { field: "segmentMean", type: "quantitative" } } },
            { data: { values: changeRows }, mark: { type: "rule", color: COLORS.accent, strokeDash: [4, 4] }, encoding: { x: { field: "time", type: "quantitative" }, tooltip: [{ field: "index" }, { field: "shift", format: ".4g" }] } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When a series may have shifted its mean level at unknown times and those times must be located and quantified rather than assumed.",
    decision: "How many level shifts the data support under the chosen penalty, where they occur, and how large each shift is relative to the noise.",
    mustShow: "The change points with before/after means and cost reductions, the segments, the penalty and noise scale used, and the series with segment means overlaid.",
    userGoal: "Date regime changes defensibly so that models, monitoring, or causal narratives can be aligned to them.",
    nextActions: [
      { trigger: "changes-detected", action: "align-events-and-interventions-to-change-times", reason: "A located shift is only meaningful once it is matched to a documented event or intervention near that time." },
      { trigger: "no-change-detected", action: "lower-penalty-or-check-autocorrelation", reason: "A large penalty or a large noise estimate can hide moderate shifts; autocorrelation can also inflate the noise scale." },
      { trigger: "many-small-shifts", action: "raise-penalty-to-mbic-and-compare", reason: "Autocorrelated or trending data produce spurious frequent changes under a BIC penalty; a stiffer penalty tests robustness." },
      { trigger: "shift-under-one-sigma", action: "treat-as-tentative-and-seek-corroboration", reason: "Shifts smaller than the noise scale are hard to distinguish from chance under the L2 cost." },
    ],
  },
  fixture: { data: { values: seriesFixture("step"), seriesLabel: "Sensor reading", timeLabel: "Hour" }, options: { changePointMethod: "pelt", penalty: "bic", minSegmentLength: 3 } },
  matlabParity: { taxonomyIds: ["matlab.stats.cluster-anomaly"] },
  coverage: {
    implementedBoundary: "Mean-shift detection with the L2 segment cost by exact PELT or greedy binary segmentation, penalties derived from a robust noise scale (BIC, MBIC, AIC) or supplied manually, with segment summaries and shift sizes.",
    oracle: { level: "external-library-partial", evidence: ["contracts/time-series-extended-scipy-crosscheck.py"], verifiedOutputs: ["PELT change points equal the exact optimal-partitioning solution recomputed by dynamic programming in NumPy", "binary-segmentation change points from an independent NumPy implementation", "segment means and costs", "noise scale and penalty"], excludedOutputs: ["comparison against the ruptures package (not installed locally)"] },
    diagnostic: { level: "method-specific-partial", emitted: ["search type", "change count and indices", "penalty derivation", "uncertainty availability"], limitations: ["no confidence sets for change locations", "no variance-change or slope-change costs"] },
    knownGaps: ["no changes in variance or slope", "no kernel or rank-based costs", "no online detection"],
  },
};

// ---------------------------------------------------------------------------------------------
// Pair-series parsing (Granger, cross-correlation) and multi-series parsing (VAR)
// ---------------------------------------------------------------------------------------------

function parsePair(data, H, keys, labels) {
  H.assertKeys(data, [keys[0], keys[1], "time", labels[0], labels[1], "timeLabel"], "data");
  const first = H.numericVector(data[keys[0]], `data.${keys[0]}`, MIN_SERIES);
  const second = H.numericVector(data[keys[1]], `data.${keys[1]}`, MIN_SERIES);
  if (first.length !== second.length) H.fail("STAT_INVALID_INPUT", `data.${keys[0]} and data.${keys[1]} must have the same length`);
  if (first.length > MAX_ROWS) H.fail("STAT_LIMIT_EXCEEDED", `time-series rows exceed ${MAX_ROWS}`);
  const timing = K.parseSeries({ values: first, ...(data.time === undefined ? {} : { time: data.time }), ...(data.timeLabel === undefined ? {} : { timeLabel: data.timeLabel }) }, H, { minLength: MIN_SERIES });
  if (K.sampleVariance(first) <= 0 || K.sampleVariance(second) <= 0) H.fail("STAT_DEGENERATE", "both series need positive variance");
  return {
    first, second, time: timing.time, interval: timing.interval, timeLabel: timing.timeLabel,
    firstLabel: H.label(data[labels[0]], keys[0], `data.${labels[0]}`),
    secondLabel: H.label(data[labels[1]], keys[1], `data.${labels[1]}`),
  };
}

const PAIR_TIME_PROPERTIES = { time: SERIES_PROPERTIES.time, timeLabel: SERIES_PROPERTIES.timeLabel };

// ---------------------------------------------------------------------------------------------
// Granger causality
// ---------------------------------------------------------------------------------------------

const GRANGER_COLUMNS = [col("direction", "Direction", "string"), col("lag", "Lags"), col("nobs", "n used"), col("fStatistic", "F"), col("df1", "df1"), col("df2", "df2"), col("fPValue", "p (F)"), col("chiSquare", "Chi-square"), col("chiSquarePValue", "p (chi-square)"), col("likelihoodRatio", "LR"), col("likelihoodRatioPValue", "p (LR)"), col("rssRestricted", "RSS restricted"), col("rssUnrestricted", "RSS unrestricted")];

const grangerCausality = {
  method: "granger_causality",
  family: "time-series",
  analysisModel: ANALYSIS_MODEL,
  optionKeys: ["maxLag", "timeoutMs"],
  customOptions: {
    bothDirections: booleanOption(true),
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["cause", "effect"],
    properties: {
      cause: SERIES_PROPERTIES.values,
      effect: SERIES_PROPERTIES.values,
      causeLabel: SERIES_PROPERTIES.seriesLabel,
      effectLabel: SERIES_PROPERTIES.seriesLabel,
      ...PAIR_TIME_PROPERTIES,
    },
  },
  parse(data, _options, H) {
    const pair = parsePair(data, H, ["cause", "effect"], ["causeLabel", "effectLabel"]);
    return { cause: pair.first, effect: pair.second, causeLabel: pair.firstLabel, effectLabel: pair.secondLabel, time: pair.time, timeLabel: pair.timeLabel };
  },
  analyze(parsed, options, budget, H) {
    const n = parsed.cause.length;
    const maxLag = options.maxLag === null ? Math.max(1, Math.min(4, Math.floor(n / 10))) : options.maxLag;
    if (n - maxLag <= 2 * maxLag + 3) H.fail("STAT_INVALID_INPUT", `options.maxLag = ${maxLag} leaves too few observations for the unrestricted regression`);
    const directions = [{ direction: `${parsed.causeLabel} -> ${parsed.effectLabel}`, effect: parsed.effect, cause: parsed.cause }];
    if (options.bothDirections) directions.push({ direction: `${parsed.effectLabel} -> ${parsed.causeLabel}`, effect: parsed.cause, cause: parsed.effect });
    const rows = [];
    for (const item of directions) {
      for (const row of K.grangerCausality(H, item.effect, item.cause, maxLag, budget)) {
        rows.push({ direction: item.direction, lag: row.lag, nobs: row.nobs, fStatistic: row.fStatistic, df1: row.lag, df2: row.dfDenominator, fPValue: row.fPValue, chiSquare: row.chiSquare, chiSquarePValue: row.chiSquarePValue, likelihoodRatio: row.likelihoodRatio, likelihoodRatioPValue: row.likelihoodRatioPValue, rssRestricted: row.rssRestricted, rssUnrestricted: row.rssUnrestricted });
      }
    }
    const verdicts = directions.map((item) => {
      const own = rows.filter((row) => row.direction === item.direction);
      const best = own.reduce((acc, row) => (acc === null || row.fPValue < acc.fPValue ? row : acc), null);
      return { name: `verdict: ${item.direction}`, status: best.fPValue < 0.05 ? "predictive_content_detected_at_some_lag" : "no_predictive_content_detected", minimumPValue: best.fPValue, atLag: best.lag, lagsTested: maxLag, adjustedForMultipleLags: false };
    });
    return {
      sample: { n, maxLag, directions: directions.length },
      estimates: [],
      tests: rows.map((row) => ({ name: `${row.direction}, ${row.lag} lag${row.lag > 1 ? "s" : ""}: F`, statistic: row.fStatistic, distribution: "F", df: [row.df1, row.df2], pValue: row.fPValue })),
      confidenceIntervals: [],
      effectSizes: [],
      assumptions: [
        { name: "both series are stationary", status: "not_established", detail: "Granger tests on integrated series produce spurious rejections" },
        { name: "linear VAR dynamics with homoscedastic errors", status: "requires_design_review" },
        { name: "lag length spans the true dynamics", status: "requires_design_review", maxLag },
      ],
      diagnostics: [
        ...verdicts,
        { name: "multiple-lag testing", status: "not_adjusted", detail: "p-values are reported per lag without adjustment; choose the lag a priori or by information criterion" },
      ],
      artifacts: [
        H.tableArtifact("Granger causality tests", "For each lag length, the restricted (own lags only) and unrestricted (own plus the other series' lags) regressions with constant; F test (statsmodels ssr_ftest convention), Wald chi-square, and likelihood-ratio versions.", GRANGER_COLUMNS, rows, [], "granger-causality-table"),
        H.vegaArtifact("granger-causality-figure", `Granger causality p-values by lag`, {
          data: { values: rows },
          layer: [
            { mark: { type: "line", point: true }, encoding: { x: { field: "lag", type: "ordinal", title: "Lags" }, y: { field: "fPValue", type: "quantitative", title: "p (F test)", scale: { domain: [0, 1] } }, color: { field: "direction", type: "nominal", title: "Direction" }, tooltip: [{ field: "direction" }, { field: "lag" }, { field: "fStatistic", format: ".4g" }, { field: "fPValue", format: ".4g" }] } },
            { mark: { type: "rule", color: COLORS.forecast, strokeDash: [4, 4] }, encoding: { y: { datum: 0.05 } } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When you need to know whether the past of one series improves prediction of another beyond the second series' own past, in either or both directions.",
    decision: "Whether one series carries predictive content for the other at some lag, and in which direction, as a precondition for VAR modelling or causal narratives.",
    mustShow: "The F, chi-square, and LR statistics with p-values at every lag tested in both directions, the sample used, and the unadjusted status of multiple-lag testing.",
    userGoal: "Support or refute a lead-lag claim between two series with a standard, reproducible test.",
    nextActions: [
      { trigger: "predictive-content-detected", action: "fit-vector-autoregression-and-inspect-impulse-responses", reason: "Granger rejection says only that lags matter; a VAR shows the sign, size, and persistence of the effect." },
      { trigger: "predictive-content-in-both-directions", action: "treat-as-feedback-system-not-one-way-cause", reason: "Bidirectional predictive content indicates a feedback loop or a common driver rather than a single cause." },
      { trigger: "series-not-tested-for-stationarity", action: "run-unit-root-tests-and-difference-if-needed", reason: "Integrated series produce spurious Granger rejections; stationarity must be established first." },
      { trigger: "verdict-depends-on-lag-choice", action: "select-lag-by-information-criterion-in-var", reason: "Per-lag p-values are not adjusted, so a rejection at one lag among many is weak evidence." },
    ],
  },
  fixture: {
    data: {
      cause: [0.62, -0.41, 0.88, 1.35, 0.27, -0.73, -1.12, -0.36, 0.44, 1.02, 0.71, -0.15, -0.94, -0.52, 0.31, 0.97, 0.58, -0.22, -0.81, -1.05, -0.33, 0.49, 1.21, 0.86, 0.12, -0.67, -0.98, -0.41, 0.35, 0.92, 1.14, 0.47, -0.28, -0.85, -0.6, 0.18, 0.76, 1.03, 0.39, -0.44, -0.91, -0.37, 0.29, 0.84, 0.66, -0.09, -0.72, -1.01, -0.48, 0.21, 0.79, 1.08, 0.53, -0.19, -0.77, -0.55, 0.26, 0.9, 0.61, -0.13],
      effect: [0.10, 0.51, -0.05, 0.62, 1.04, 0.33, -0.44, -0.91, -0.52, 0.18, 0.79, 0.68, 0.06, -0.71, -0.60, 0.05, 0.74, 0.62, 0.01, -0.63, -0.94, -0.44, 0.27, 0.99, 0.81, 0.19, -0.49, -0.87, -0.46, 0.14, 0.72, 1.01, 0.53, -0.11, -0.69, -0.61, 0.02, 0.61, 0.92, 0.46, -0.24, -0.78, -0.45, 0.13, 0.69, 0.66, 0.08, -0.55, -0.90, -0.53, 0.05, 0.63, 0.95, 0.56, -0.05, -0.62, -0.57, 0.09, 0.71, 0.64],
      causeLabel: "Leading indicator",
      effectLabel: "Output",
    },
    options: { maxLag: 3 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "Bivariate Granger causality for lags 1..maxLag in one or both directions using nested OLS regressions with constant; F, Wald chi-square, and likelihood-ratio statistics.",
    oracle: { level: "external-library-partial", evidence: ["contracts/time-series-extended-scipy-crosscheck.py"], verifiedOutputs: ["F statistic and p-value", "chi-square statistic and p-value", "likelihood-ratio statistic and p-value", "restricted and unrestricted RSS"], excludedOutputs: ["multivariate (conditional) Granger tests", "heteroskedasticity-robust versions"] },
    diagnostic: { level: "method-specific-partial", emitted: ["per-direction verdict with minimum p and lag", "multiple-lag adjustment status"], limitations: ["no stationarity pre-check", "no robust covariance"] },
    knownGaps: ["no block-exogeneity tests in a VAR with more than two series", "no Toda-Yamamoto procedure for integrated series"],
  },
};

// ---------------------------------------------------------------------------------------------
// Cross-correlation
// ---------------------------------------------------------------------------------------------

const crossCorrelation = {
  method: "cross_correlation",
  family: "time-series",
  analysisModel: ANALYSIS_MODEL,
  optionKeys: ["confidenceLevel", "maxLag", "timeoutMs"],
  customOptions: {
    adjusted: booleanOption(true),
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["x", "y"],
    properties: {
      x: SERIES_PROPERTIES.values,
      y: SERIES_PROPERTIES.values,
      xLabel: SERIES_PROPERTIES.seriesLabel,
      yLabel: SERIES_PROPERTIES.seriesLabel,
      ...PAIR_TIME_PROPERTIES,
    },
  },
  parse(data, _options, H) {
    const pair = parsePair(data, H, ["x", "y"], ["xLabel", "yLabel"]);
    return { x: pair.first, y: pair.second, xLabel: pair.firstLabel, yLabel: pair.secondLabel, time: pair.time, timeLabel: pair.timeLabel };
  },
  analyze(parsed, options, budget, H) {
    const n = parsed.x.length;
    const maxLag = options.maxLag === null ? Math.max(1, Math.min(20, Math.floor(n / 4))) : options.maxLag;
    if (maxLag > n - 3) H.fail("STAT_INVALID_INPUT", `options.maxLag must be at most ${n - 3} for this series length`);
    const z = zQuantile(H, 0.5 + options.confidenceLevel / 2);
    const bound = z / Math.sqrt(n);
    const rows = K.crossCorrelation(H, parsed.x, parsed.y, maxLag, budget, options.adjusted).map((row) => ({ lag: row.lag, correlation: row.correlation, upperBound: bound, lowerBound: -bound, exceedsBound: Math.abs(row.correlation) > bound }));
    const peak = rows.reduce((acc, row) => (acc === null || Math.abs(row.correlation) > Math.abs(acc.correlation) ? row : acc), null);
    const lagZero = rows.find((row) => row.lag === 0);
    return {
      sample: { n, maxLag, adjusted: options.adjusted, confidenceLevel: options.confidenceLevel },
      estimates: [
        { name: "peak cross-correlation", estimate: peak.correlation, lag: peak.lag, interpretation: peak.lag > 0 ? `${parsed.yLabel} leads ${parsed.xLabel} by ${peak.lag}` : peak.lag < 0 ? `${parsed.xLabel} leads ${parsed.yLabel} by ${-peak.lag}` : "contemporaneous" },
        { name: "contemporaneous correlation (lag 0)", estimate: lagZero.correlation },
        { name: "approximate white-noise bound", estimate: bound, level: options.confidenceLevel },
      ],
      tests: [],
      confidenceIntervals: [],
      effectSizes: [{ name: "peak cross-correlation", estimate: peak.correlation, lag: peak.lag }],
      assumptions: [
        { name: "both series are stationary", status: "not_established" },
        { name: "white-noise bounds are approximate (z / sqrt(n))", status: "asymptotic", detail: "autocorrelated series inflate the true sampling variance of the cross-correlation" },
      ],
      diagnostics: [
        { name: "lags exceeding bound", status: rows.some((row) => row.exceedsBound) ? "some_lags_exceed_bound" : "no_lag_exceeds_bound", count: rows.filter((row) => row.exceedsBound).length, of: rows.length },
        { name: "lag convention", status: "documented", detail: `lag k correlates ${parsed.xLabel} at t + k with ${parsed.yLabel} at t; positive k means ${parsed.yLabel} leads` },
        { name: "normalisation", status: options.adjusted ? "adjusted_n_minus_lag" : "unadjusted_n" },
      ],
      artifacts: [
        H.tableArtifact(`Cross-correlation: ${parsed.xLabel} and ${parsed.yLabel}`, `Sample cross-correlation for lags -${maxLag}..${maxLag} (lag k pairs ${parsed.xLabel} at t + k with ${parsed.yLabel} at t), divided by ${options.adjusted ? "n - |k|" : "n"}, with approximate ${Math.round(options.confidenceLevel * 100)}% white-noise bounds.`, [col("lag", "Lag"), col("correlation", "Cross-correlation"), col("upperBound", "Upper bound"), col("lowerBound", "Lower bound"), col("exceedsBound", "Exceeds bound", "boolean")], rows, [], "cross-correlation-table"),
        H.vegaArtifact("cross-correlation-figure", `Cross-correlation function: ${parsed.xLabel} vs ${parsed.yLabel}`, {
          data: { values: rows },
          layer: [
            { mark: { type: "bar", width: { band: 0.6 } }, encoding: { x: { field: "lag", type: "ordinal", title: "Lag" }, y: { field: "correlation", type: "quantitative", title: "Cross-correlation" }, color: { condition: { test: "datum.exceedsBound === true", value: COLORS.forecast }, value: COLORS.observed }, tooltip: [{ field: "lag" }, { field: "correlation", format: ".4f" }] } },
            { mark: { type: "line", color: COLORS.forecast, strokeDash: [6, 4] }, encoding: { x: { field: "lag", type: "ordinal" }, y: { field: "upperBound", type: "quantitative" } } },
            { mark: { type: "line", color: COLORS.forecast, strokeDash: [6, 4] }, encoding: { x: { field: "lag", type: "ordinal" }, y: { field: "lowerBound", type: "quantitative" } } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When the lead-lag relationship between two series must be described across lags before choosing a model or claiming that one series anticipates the other.",
    decision: "At which lag the two series are most strongly related, which series leads, and whether any lag exceeds the white-noise reference bound.",
    mustShow: "The full cross-correlation function with its bounds, the peak lag and its interpretation, and the normalisation and lag convention used.",
    userGoal: "Characterise the timing relationship between two series in a form that can be reported and acted on.",
    nextActions: [
      { trigger: "peak-at-nonzero-lag", action: "test-lead-lag-with-granger-causality", reason: "A cross-correlation peak suggests a lead, but only a regression-based test controls for each series' own persistence." },
      { trigger: "many-lags-exceed-bound", action: "prewhiten-both-series-before-interpreting", reason: "Strong autocorrelation inflates cross-correlations at every lag; prewhitening removes that artefact." },
      { trigger: "no-lag-exceeds-bound", action: "report-absence-of-linear-lead-lag-relationship", reason: "Absence of any significant cross-correlation is itself a reportable finding for the pair." },
      { trigger: "series-not-tested-for-stationarity", action: "run-unit-root-tests-first", reason: "Cross-correlations between integrated series are spurious and can be large at every lag." },
    ],
  },
  fixture: { data: { x: grangerCausality.fixture.data.cause, y: grangerCausality.fixture.data.effect, xLabel: "Leading indicator", yLabel: "Output" }, options: { maxLag: 8 } },
  matlabParity: { taxonomyIds: ["matlab.stats.descriptive-visualization"] },
  coverage: {
    implementedBoundary: "Sample cross-correlation function at positive and negative lags with adjusted (n - |k|) or unadjusted (n) normalisation and approximate white-noise bounds; peak lag with lead interpretation.",
    oracle: { level: "external-library-partial", evidence: ["contracts/time-series-extended-scipy-crosscheck.py"], verifiedOutputs: ["cross-correlations at every lag (adjusted and unadjusted)"], excludedOutputs: ["Bartlett-corrected bounds", "prewhitened cross-correlation"] },
    diagnostic: { level: "method-specific-partial", emitted: ["count of lags beyond the bound", "lag convention", "normalisation"], limitations: ["bounds assume both series are white noise"] },
    knownGaps: ["no prewhitening", "no Bartlett variance bounds", "no cross-spectral phase"],
  },
};

// ---------------------------------------------------------------------------------------------
// Vector autoregression
// ---------------------------------------------------------------------------------------------

const vectorAutoregression = {
  method: "vector_autoregression",
  family: "time-series",
  analysisModel: ANALYSIS_MODEL,
  optionKeys: ["confidenceLevel", "maxLag", "timeoutMs"],
  customOptions: {
    lagSelection: enumOption(["aic", "bic", "hqic", "fixed"], "aic"),
    irfHorizon: integerOption(1, 50, 10),
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["series"],
    properties: {
      series: { type: "array", minItems: 2, maxItems: 8, items: { type: "object", additionalProperties: false, required: ["values"], properties: { name: SERIES_PROPERTIES.seriesLabel, values: SERIES_PROPERTIES.values } } },
      ...PAIR_TIME_PROPERTIES,
    },
  },
  parse(data, _options, H) {
    H.assertKeys(data, ["series", "time", "timeLabel"], "data");
    if (!Array.isArray(data.series) || data.series.length < 2 || data.series.length > 8) H.fail("STAT_INVALID_INPUT", "data.series must list between 2 and 8 series");
    const series = data.series.map((item, index) => {
      H.assertKeys(item, ["name", "values"], `data.series[${index}]`);
      return { name: H.label(item.name, `y${index + 1}`, `data.series[${index}].name`), values: H.numericVector(item.values, `data.series[${index}].values`, MIN_SERIES) };
    });
    const length = series[0].values.length;
    if (series.some((item) => item.values.length !== length)) H.fail("STAT_INVALID_INPUT", "all series must have the same length");
    if (length > MAX_ROWS) H.fail("STAT_LIMIT_EXCEEDED", `time-series rows exceed ${MAX_ROWS}`);
    if (new Set(series.map((item) => item.name)).size !== series.length) H.fail("STAT_INVALID_INPUT", "series names must be unique");
    if (series.some((item) => K.sampleVariance(item.values) <= 0)) H.fail("STAT_DEGENERATE", "every series needs positive variance");
    const timing = K.parseSeries({ values: series[0].values, ...(data.time === undefined ? {} : { time: data.time }), ...(data.timeLabel === undefined ? {} : { timeLabel: data.timeLabel }) }, H, { minLength: MIN_SERIES });
    return { series, time: timing.time, timeLabel: timing.timeLabel, n: length };
  },
  analyze(parsed, options, budget, H) {
    const k = parsed.series.length;
    const n = parsed.n;
    const matrix = parsed.series.map((item) => item.values);
    const names = parsed.series.map((item) => item.name);
    const maxLag = options.maxLag === null ? Math.max(1, Math.min(4, Math.floor((n - 1) / (3 * k)))) : options.maxLag;
    if (n - maxLag <= k * maxLag + 1) H.fail("STAT_INVALID_INPUT", `options.maxLag = ${maxLag} needs more than ${k * maxLag + 1 + maxLag} observations for ${k} series`);
    const lagRows = [];
    let chosen = maxLag;
    if (options.lagSelection !== "fixed") {
      let best = null;
      for (let lag = 0; lag <= maxLag; lag += 1) {
        budget.check(k * k * lag);
        const candidate = K.fitVar(H, matrix, lag, maxLag - lag, budget);
        const row = { lag, nobs: candidate.nobs, aic: candidate.aic, bic: candidate.bic, hqic: candidate.hqic, loglik: candidate.llf, selected: false };
        lagRows.push(row);
        if (lag >= 1 && (best === null || row[options.lagSelection] < best[options.lagSelection])) best = row;
      }
      chosen = best.lag;
      best.selected = true;
    }
    const fit = K.fitVar(H, matrix, chosen, 0, budget);
    const irf = K.impulseResponses(H, fit, options.irfHorizon, budget);
    const z = zQuantile(H, 0.5 + options.confidenceLevel / 2);
    const termNames = ["const"];
    for (let lag = 1; lag <= chosen; lag += 1) for (const name of names) termNames.push(`L${lag}.${name}`);
    const coefficientRows = [];
    for (let equation = 0; equation < k; equation += 1) {
      for (let term = 0; term < termNames.length; term += 1) {
        const estimate = fit.params[term][equation];
        const standardError = fit.stderr[term][equation];
        const statistic = standardError > 0 ? estimate / standardError : null;
        coefficientRows.push({ equation: names[equation], term: termNames[term], estimate, standardError, zStatistic: statistic, pValue: statistic === null ? null : K.twoSidedNormalP(H, statistic), lower: estimate - z * standardError, upper: estimate + z * standardError });
      }
    }
    const covarianceRows = [];
    for (let i = 0; i < k; i += 1) for (let j = 0; j < k; j += 1) covarianceRows.push({ variable1: names[i], variable2: names[j], covariance: fit.sigmaU[i][j], correlation: fit.sigmaU[i][j] / Math.sqrt(fit.sigmaU[i][i] * fit.sigmaU[j][j]) });
    const irfRows = [];
    for (let step = 0; step <= options.irfHorizon; step += 1) {
      for (let impulse = 0; impulse < k; impulse += 1) for (let response = 0; response < k; response += 1) {
        irfRows.push({ horizon: step, impulse: names[impulse], response: names[response], orthogonalized: irf.orthogonal[step][response][impulse], plain: irf.psi[step][response][impulse] });
      }
    }
    const fitRows = [
      { statistic: "log-likelihood", value: fit.llf },
      { statistic: "AIC (statsmodels scaling)", value: fit.aic },
      { statistic: "BIC (statsmodels scaling)", value: fit.bic },
      { statistic: "HQIC (statsmodels scaling)", value: fit.hqic },
      { statistic: "n used", value: fit.nobs },
      { statistic: "residual degrees of freedom", value: fit.dfResid },
      { statistic: "coefficients per equation", value: termNames.length },
    ];
    const lastPsi = irf.psi[options.irfHorizon];
    let maxLastResponse = 0;
    for (const row of lastPsi) for (const value of row) maxLastResponse = Math.max(maxLastResponse, Math.abs(value));
    return {
      sample: { n, nUsed: fit.nobs, series: k, lag: chosen, maxLag, lagSelection: options.lagSelection, irfHorizon: options.irfHorizon },
      estimates: coefficientRows.map((row) => ({ name: `${row.equation}: ${row.term}`, estimate: row.estimate, standardError: row.standardError })),
      tests: coefficientRows.filter((row) => row.zStatistic !== null).map((row) => ({ name: `${row.equation}: ${row.term} = 0`, statistic: row.zStatistic, distribution: "normal", df: null, pValue: row.pValue })),
      confidenceIntervals: coefficientRows.map((row) => ({ name: `${row.equation}: ${row.term}`, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: "Wald (normal)" })),
      effectSizes: [],
      assumptions: [
        { name: "all series are stationary", status: "not_established" },
        { name: "errors are serially uncorrelated and homoscedastic", status: "not_established" },
        { name: "orthogonalized responses depend on the variable ordering (Cholesky)", status: "requires_design_review", ordering: names.join(" > ") },
      ],
      diagnostics: [
        { name: "lag order", status: options.lagSelection === "fixed" ? "user_specified" : `${options.lagSelection}_minimum`, lag: chosen, candidates: lagRows.length },
        { name: "impulse-response decay", status: maxLastResponse < 0.05 ? "responses_decayed_at_horizon" : "responses_persist_at_horizon", maxAbsoluteResponseAtHorizon: maxLastResponse, horizon: options.irfHorizon },
        { name: "stability", status: "not_established", detail: "companion-matrix eigenvalues are not computed; use the impulse-response decay as a heuristic" },
        { name: "standard errors", status: "ols_equation_by_equation", detail: "conventional OLS standard errors with sigma_u divided by (n - k p - 1)" },
      ],
      artifacts: [
        H.tableArtifact(`VAR(${chosen}) coefficients`, `Equation-by-equation OLS estimates with constant; z tests and ${Math.round(options.confidenceLevel * 100)}% Wald intervals.`, [col("equation", "Equation", "string"), col("term", "Term", "string"), col("estimate", "Estimate"), col("standardError", "SE"), col("zStatistic", "z"), col("pValue", "p"), col("lower", "Lower"), col("upper", "Upper")], coefficientRows, [], "var-coefficient-table"),
        H.tableArtifact("VAR lag-order selection", `Information criteria for lags 0..${maxLag} fitted on the common sample that drops the first ${maxLag} observations (statsmodels select_order convention); lag 0 is shown for reference and never selected.`, [col("lag", "Lag"), col("nobs", "n used"), col("aic", "AIC"), col("bic", "BIC"), col("hqic", "HQIC"), col("loglik", "Log-likelihood"), col("selected", "Selected", "boolean")], lagRows, lagRows.length ? [] : ["Lag order fixed by the user; no selection table."], "var-lag-selection-table"),
        H.tableArtifact(`VAR(${chosen}) fit statistics`, "Gaussian log-likelihood and information criteria scaled per observation as in statsmodels.", FIT_COLUMNS, fitRows, [], "var-fit-table"),
        H.tableArtifact("Residual covariance", "Residual covariance (divided by residual degrees of freedom) and the implied residual correlations.", [col("variable1", "Variable", "string"), col("variable2", "Variable", "string"), col("covariance", "Covariance"), col("correlation", "Correlation")], covarianceRows, [], "var-residual-covariance-table"),
        H.tableArtifact("Impulse responses", `Responses to a one-standard-deviation orthogonalized shock (Cholesky ordering ${names.join(" > ")}) and to a unit non-orthogonalized shock, horizons 0..${options.irfHorizon}.`, [col("horizon", "Horizon"), col("impulse", "Impulse", "string"), col("response", "Response", "string"), col("orthogonalized", "Orthogonalized response"), col("plain", "Non-orthogonalized response")], irfRows, [], "var-impulse-response-table"),
        H.vegaArtifact("var-impulse-response-figure", `Orthogonalized impulse responses (VAR(${chosen}))`, {
          data: { values: irfRows },
          mark: { type: "line", point: true, color: COLORS.observed },
          encoding: {
            x: { field: "horizon", type: "quantitative", title: "Horizon" },
            y: { field: "orthogonalized", type: "quantitative", title: "Response" },
            row: { field: "response", type: "nominal", title: "Response" },
            column: { field: "impulse", type: "nominal", title: "Impulse" },
            tooltip: [{ field: "horizon" }, { field: "impulse" }, { field: "response" }, { field: "orthogonalized", format: ".4g" }],
          },
          resolve: { scale: { y: "independent" } },
          height: 110,
          width: 160,
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When several stationary series influence each other dynamically and their joint lag structure, residual covariance, and shock responses must be estimated together.",
    decision: "Which lag order the data support, how each series responds over time to a shock in another, and how strongly the contemporaneous residuals are correlated.",
    mustShow: "The lag-selection criteria, every equation's coefficients with intervals, the residual covariance, and the impulse-response table and figure with the Cholesky ordering stated.",
    userGoal: "Describe the dynamic interdependence of a small system of series with a standard VAR and communicate shock propagation honestly.",
    nextActions: [
      { trigger: "responses-persist-at-horizon", action: "check-stationarity-and-consider-differencing", reason: "Impulse responses that do not decay indicate a near-unit-root system whose VAR in levels is unreliable." },
      { trigger: "ordering-sensitive-conclusions", action: "rerun-with-alternative-cholesky-ordering", reason: "Orthogonalized responses depend on the ordering; conclusions that flip with it are not identified." },
      { trigger: "criteria-disagree-on-lag", action: "prefer-bic-or-hqic-for-forecasting-aic-for-dynamics", reason: "AIC tends to over-parameterise in small samples while BIC is consistent; the purpose decides." },
      { trigger: "large-residual-correlation", action: "state-contemporaneous-link-is-not-identified", reason: "Strong residual correlation means shocks are not separable without identifying restrictions." },
    ],
  },
  fixture: { data: { series: [{ name: "Leading indicator", values: grangerCausality.fixture.data.cause }, { name: "Output", values: grangerCausality.fixture.data.effect }] }, options: { maxLag: 4, lagSelection: "aic", irfHorizon: 8 } },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "VAR(p) with constant for 2 to 8 series by equation-by-equation OLS, lag selection by AIC/BIC/HQIC on a common sample, residual covariance, and orthogonalized and non-orthogonalized impulse responses.",
    oracle: { level: "external-library-partial", evidence: ["contracts/time-series-extended-scipy-crosscheck.py"], verifiedOutputs: ["coefficients and standard errors", "residual covariance", "information criteria and selected lag", "orthogonalized and plain impulse responses"], excludedOutputs: ["forecast error variance decomposition", "impulse-response confidence bands"] },
    diagnostic: { level: "method-specific-partial", emitted: ["lag-order choice", "impulse-response decay heuristic", "stability status", "standard-error type"], limitations: ["no companion-matrix stability check", "no residual portmanteau test"] },
    knownGaps: ["no FEVD", "no bootstrap IRF bands", "no exogenous variables or cointegration (VECM)"],
  },
};

module.exports = {
  methods: [augmentedDickeyFuller, kpssTest, phillipsPerron, arima, autoArima, exponentialSmoothing, seasonalDecomposition, spectralPeriodogram, changePointDetection, grangerCausality, crossCorrelation, vectorAutoregression],
};
