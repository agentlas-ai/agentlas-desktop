"use strict";

// Hydrology / oceanography / climate analyses on researcher-supplied series.
//  1. Tidal harmonic analysis (least squares, bounded constituent catalogue).
//  2. Sea-level / climate trend with AR(1)-corrected uncertainty, Mann–Kendall
//     (Hamed & Rao 1998), Sen's slope with Gilbert (1987) interval, Pettitt (1979).
//  3. Standardized Precipitation Index (McKee et al. 1993; Edwards & McKee 1997)
//     with Thom (1958) gamma fit, and SPEI (Vicente-Serrano et al. 2010).
//  4. Flood frequency: Log-Pearson III (Bulletin 17B method of moments, Wilson–
//     Hilferty frequency factor, Appendix 9 confidence limits), Gumbel (method of
//     moments, Kite 1977 standard error), GEV (Hosking 1990 L-moments).
//
// References
//  Schureman P. (1958) Manual of Harmonic Analysis and Prediction of Tides, US C&GS Spec. Pub. 98 — constituent speeds.
//  Pugh D. T. (1987) Tides, Surges and Mean Sea-Level — form factor F=(K1+O1)/(M2+S2) classification.
//  Godin G. (1972) The Analysis of Tides — Rayleigh separation criterion.
//  Santer B. D. et al. (2000) JGR 105, 7337–7356 — AR(1) effective sample size for trend SE.
//  Mann H. B. (1945) Econometrica 13, 245–259; Kendall M. G. (1975) Rank Correlation Methods.
//  Hamed K. H. & Rao A. R. (1998) J. Hydrol. 204, 182–196 — autocorrelation-corrected MK variance.
//  Sen P. K. (1968) JASA 63, 1379–1389; Gilbert R. O. (1987) Statistical Methods for Environmental Pollution Monitoring.
//  Pettitt A. N. (1979) Appl. Stat. 28, 126–135.
//  McKee T. B., Doesken N. J., Kleist J. (1993) 8th Conf. Applied Climatology, 179–184.
//  Edwards D. C. & McKee T. B. (1997) Colorado State Univ. Climatology Report 97-2.
//  Thom H. C. S. (1958) Monthly Weather Review 86, 117–122 — gamma MLE approximation.
//  Vicente-Serrano S. M., Beguería S., López-Moreno J. I. (2010) J. Climate 23, 1696–1718.
//  Hosking J. R. M. (1990) J. R. Stat. Soc. B 52, 105–124 — L-moments.
//  IACWD (1982) Bulletin 17B, Guidelines for Determining Flood Flow Frequency.
//  Kite G. W. (1977) Frequency and Risk Analyses in Hydrology.

const N = require("./earth-numerics.cjs");

function core() {
  return require("./earth-science.cjs");
}

const EULER_GAMMA = 0.5772156649015329;
const HOURS_PER_DAY = 24;

// Constituent speeds in degrees per mean solar hour (Schureman 1958, Table 2).
const TIDAL_CONSTITUENTS = Object.freeze([
  { name: "M2", description: "Principal lunar semidiurnal", speedDegPerHour: 28.9841042, priority: 1 },
  { name: "S2", description: "Principal solar semidiurnal", speedDegPerHour: 30.0, priority: 2 },
  { name: "K1", description: "Lunisolar diurnal", speedDegPerHour: 15.0410686, priority: 3 },
  { name: "O1", description: "Principal lunar diurnal", speedDegPerHour: 13.9430356, priority: 4 },
  { name: "N2", description: "Larger lunar elliptic semidiurnal", speedDegPerHour: 28.4397295, priority: 5 },
  { name: "M4", description: "Shallow-water overtide of M2", speedDegPerHour: 57.9682084, priority: 6 },
  { name: "P1", description: "Principal solar diurnal", speedDegPerHour: 14.9589314, priority: 7 },
  { name: "K2", description: "Lunisolar semidiurnal", speedDegPerHour: 30.0821373, priority: 8 },
  { name: "Q1", description: "Larger lunar elliptic diurnal", speedDegPerHour: 13.3986609, priority: 9 },
  { name: "MS4", description: "Shallow-water compound of M2 and S2", speedDegPerHour: 58.9841042, priority: 10 },
  { name: "Sa", description: "Solar annual", speedDegPerHour: 0.0410686, priority: 11 },
  { name: "Ssa", description: "Solar semiannual", speedDegPerHour: 0.0821373, priority: 12 },
].map((item) => Object.freeze({ ...item, frequencyCyclesPerHour: item.speedDegPerHour / 360, periodHours: 360 / item.speedDegPerHour })));

const DROUGHT_CATEGORIES = Object.freeze([
  { label: "extremely wet", minimum: 2, maximum: Infinity },
  { label: "very wet", minimum: 1.5, maximum: 2 },
  { label: "moderately wet", minimum: 1, maximum: 1.5 },
  { label: "near normal", minimum: -1, maximum: 1 },
  { label: "moderately dry", minimum: -1.5, maximum: -1 },
  { label: "severely dry", minimum: -2, maximum: -1.5 },
  { label: "extremely dry", minimum: -Infinity, maximum: -2 },
]);

function droughtCategory(value) {
  if (value === null) return null;
  if (value >= 2) return "extremely wet";
  if (value >= 1.5) return "very wet";
  if (value >= 1) return "moderately wet";
  if (value > -1) return "near normal";
  if (value > -1.5) return "moderately dry";
  if (value > -2) return "severely dry";
  return "extremely dry";
}

function assertSourceSha(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw N.fail("earth-series-source-sha256-invalid");
  return value;
}

function unitText(value, label) {
  const C = core();
  return C.text(value, 1, 40, label);
}

function vegaConfig() {
  return { axis: { labelFontSize: 11, titleFontSize: 12 }, view: { stroke: "#D8D5D0" } };
}

// ---------------------------------------------------------------------------
// 1. Tidal harmonic analysis
// ---------------------------------------------------------------------------

function normalizeTidalInput(value) {
  const C = core();
  const input = C.exactObject(value, ["sourceContentSha256", "series", "valueUnit", "verticalDatum", "constituents", "referenceTime", "predictionStepMinutes", "predictionStartTime", "predictionEndTime"], "earth-tidal-input");
  const sourceContentSha256 = assertSourceSha(input.sourceContentSha256);
  if (!Array.isArray(input.series) || input.series.length < 24 || input.series.length > 20_000) throw N.fail("earth-tidal-series-length-invalid", "tidal analysis requires 24–20000 samples");
  const series = input.series.map((row, index) => {
    const item = C.exactObject(row, ["time", "value"], "earth-tidal-sample");
    const instant = C.isoInstant(item.time, "earth-tidal-sample-time");
    const sample = item.value === null ? null : C.finite(item.value, -1e5, 1e5, "earth-tidal-sample-value");
    if (index > 0 && instant.millis <= Date.parse(input.series[index - 1].time)) throw N.fail("earth-tidal-series-not-increasing", "sample times must be strictly increasing", { index });
    return { time: instant.iso, millis: instant.millis, value: sample };
  });
  const valueUnit = unitText(input.valueUnit, "earth-tidal-value-unit");
  const verticalDatum = input.verticalDatum === undefined || input.verticalDatum === null ? null : unitText(input.verticalDatum, "earth-tidal-vertical-datum");
  let requested = null;
  if (input.constituents !== undefined && input.constituents !== null) {
    if (!Array.isArray(input.constituents) || input.constituents.length < 1 || input.constituents.length > TIDAL_CONSTITUENTS.length) throw N.fail("earth-tidal-constituents-invalid");
    requested = input.constituents.map((name) => {
      const found = TIDAL_CONSTITUENTS.find((item) => item.name === name);
      if (!found) throw N.fail("earth-tidal-constituent-unknown", `unknown constituent ${String(name)}`, { name: String(name), catalogue: TIDAL_CONSTITUENTS.map((item) => item.name) });
      return found.name;
    });
    if (new Set(requested).size !== requested.length) throw N.fail("earth-tidal-constituents-duplicate");
  }
  const reference = input.referenceTime === undefined || input.referenceTime === null ? { iso: series[0].time, millis: series[0].millis } : C.isoInstant(input.referenceTime, "earth-tidal-reference-time");
  const predictionStepMinutes = input.predictionStepMinutes === undefined ? 6 : C.integer(input.predictionStepMinutes, 1, 1_440, "earth-tidal-prediction-step");
  const predictionStart = input.predictionStartTime === undefined || input.predictionStartTime === null ? { iso: series[0].time, millis: series[0].millis } : C.isoInstant(input.predictionStartTime, "earth-tidal-prediction-start");
  const predictionEnd = input.predictionEndTime === undefined || input.predictionEndTime === null ? { iso: series[series.length - 1].time, millis: series[series.length - 1].millis } : C.isoInstant(input.predictionEndTime, "earth-tidal-prediction-end");
  if (predictionEnd.millis <= predictionStart.millis) throw N.fail("earth-tidal-prediction-window-invalid");
  const predictionPoints = Math.floor((predictionEnd.millis - predictionStart.millis) / (predictionStepMinutes * 60_000)) + 1;
  if (predictionPoints > 200_000) throw N.fail("earth-tidal-prediction-too-dense", "prediction window / step would exceed 200000 points", { predictionPoints });
  return { sourceContentSha256, series, valueUnit, verticalDatum, requested, reference, predictionStepMinutes, predictionStart, predictionEnd, predictionPoints };
}

function analyzeTidalHarmonics(value) {
  const C = core();
  const input = normalizeTidalInput(value);
  const valid = input.series.filter((row) => row.value !== null);
  const recordHours = (input.series[input.series.length - 1].millis - input.series[0].millis) / 3_600_000;
  const candidates = (input.requested ? TIDAL_CONSTITUENTS.filter((item) => input.requested.includes(item.name)) : TIDAL_CONSTITUENTS.slice())
    .sort((left, right) => left.priority - right.priority);
  // Rayleigh criterion: two constituents are resolvable only if record length ≥ 1/|Δf|.
  const selected = [];
  const excluded = [];
  for (const candidate of candidates) {
    const conflict = selected.find((item) => recordHours * Math.abs(item.frequencyCyclesPerHour - candidate.frequencyCyclesPerHour) < 1);
    if (conflict) {
      excluded.push({ name: candidate.name, reason: "rayleigh-criterion", conflictsWith: conflict.name, requiredRecordHours: N.rounded(1 / Math.abs(conflict.frequencyCyclesPerHour - candidate.frequencyCyclesPerHour), 6), recordHours: N.rounded(recordHours, 6) });
    } else if (recordHours < candidate.periodHours) {
      excluded.push({ name: candidate.name, reason: "record-shorter-than-period", conflictsWith: null, requiredRecordHours: N.rounded(candidate.periodHours, 6), recordHours: N.rounded(recordHours, 6) });
    } else selected.push(candidate);
  }
  if (!selected.length) throw N.fail("earth-tidal-no-resolvable-constituents", "no requested constituent is resolvable with this record length", { excluded });
  const parameterCount = 1 + 2 * selected.length;
  if (valid.length < 2 * parameterCount) throw N.fail("earth-tidal-sample-inadequate", "at least twice as many non-null samples as parameters are required", { validSamples: valid.length, parameters: parameterCount });
  const hoursSinceReference = (millis) => (millis - input.reference.millis) / 3_600_000;
  const designRow = (millis) => {
    const t = hoursSinceReference(millis);
    const row = [1];
    for (const constituent of selected) {
      const angle = 2 * Math.PI * constituent.frequencyCyclesPerHour * t;
      row.push(Math.cos(angle), Math.sin(angle));
    }
    return row;
  };
  const fit = N.leastSquares(valid.map((row) => designRow(row.millis)), valid.map((row) => row.value));
  const meanLevel = fit.beta[0];
  const constituentRows = selected.map((constituent, index) => {
    const a = fit.beta[1 + 2 * index];
    const b = fit.beta[2 + 2 * index];
    const varA = fit.covariance[1 + 2 * index][1 + 2 * index];
    const varB = fit.covariance[2 + 2 * index][2 + 2 * index];
    const covAB = fit.covariance[1 + 2 * index][2 + 2 * index];
    const amplitude = Math.hypot(a, b);
    const phaseRad = Math.atan2(b, a);
    const phaseDeg = ((phaseRad * 180 / Math.PI) % 360 + 360) % 360;
    const amplitudeSe = amplitude > 0 ? Math.sqrt(Math.max(0, a * a * varA + b * b * varB + 2 * a * b * covAB)) / amplitude : Math.sqrt(Math.max(varA, varB));
    const phaseSeRad = amplitude > 0 ? Math.sqrt(Math.max(0, b * b * varA + a * a * varB - 2 * a * b * covAB)) / (amplitude * amplitude) : null;
    return {
      name: constituent.name, description: constituent.description, speedDegPerHour: constituent.speedDegPerHour,
      frequencyCyclesPerHour: N.rounded(constituent.frequencyCyclesPerHour, 12), periodHours: N.rounded(constituent.periodHours, 8),
      cosineCoefficient: N.rounded(a), sineCoefficient: N.rounded(b),
      amplitude: N.rounded(amplitude), amplitudeStandardError: N.rounded(amplitudeSe),
      phaseDeg: N.rounded(phaseDeg, 8), phaseStandardErrorDeg: phaseSeRad === null ? null : N.rounded(phaseSeRad * 180 / Math.PI, 8),
      signalToNoise: amplitudeSe > 0 ? N.rounded(amplitude / amplitudeSe, 6) : null,
    };
  });
  const byName = Object.fromEntries(constituentRows.map((row) => [row.name, row]));
  const formFactor = byName.K1 && byName.O1 && byName.M2 && byName.S2 ? (byName.K1.amplitude + byName.O1.amplitude) / (byName.M2.amplitude + byName.S2.amplitude) : null;
  const formClass = formFactor === null ? null : formFactor < 0.25 ? "semidiurnal" : formFactor < 1.5 ? "mixed, mainly semidiurnal" : formFactor <= 3 ? "mixed, mainly diurnal" : "diurnal";
  const predict = (millis) => designRow(millis).reduce((sum, term, index) => sum + term * fit.beta[index], 0);
  const residualRows = input.series.map((row) => {
    const predicted = predict(row.millis);
    return { time: row.time, observed: row.value, predicted: N.rounded(predicted), residual: row.value === null ? null : N.rounded(row.value - predicted) };
  });
  const observedVariance = N.sampleVariance(valid.map((row) => row.value));
  const residualVariance = fit.degreesOfFreedom > 0 ? fit.rss / fit.degreesOfFreedom : null;
  const varianceExplained = 1 - fit.rss / (observedVariance * (valid.length - 1));
  // Predicted tide table: local extrema of the prediction sampled at the requested step.
  const predictedSeries = [];
  for (let index = 0; index < input.predictionPoints; index += 1) {
    const millis = input.predictionStart.millis + index * input.predictionStepMinutes * 60_000;
    predictedSeries.push({ millis, height: predict(millis) });
  }
  const tideTableRows = [];
  for (let index = 1; index + 1 < predictedSeries.length; index += 1) {
    const previous = predictedSeries[index - 1].height;
    const current = predictedSeries[index].height;
    const next = predictedSeries[index + 1].height;
    if (current > previous && current >= next) tideTableRows.push([new Date(predictedSeries[index].millis).toISOString(), N.rounded(current), "high"]);
    else if (current < previous && current <= next) tideTableRows.push([new Date(predictedSeries[index].millis).toISOString(), N.rounded(current), "low"]);
  }
  const publicationTable = {
    schema: "agentlas.science-table/v1",
    title: "Tidal harmonic constituents (least-squares fit)",
    columns: [
      { id: "name", label: "Constituent", type: "string", unit: null },
      { id: "speedDegPerHour", label: "Speed", type: "number", unit: "deg/h" },
      { id: "periodHours", label: "Period", type: "number", unit: "h" },
      { id: "amplitude", label: "Amplitude H", type: "number", unit: input.valueUnit },
      { id: "amplitudeStandardError", label: "SE(H)", type: "number", unit: input.valueUnit },
      { id: "phaseDeg", label: "Phase g (relative to reference epoch)", type: "number", unit: "degree" },
      { id: "phaseStandardErrorDeg", label: "SE(g)", type: "number", unit: "degree" },
      { id: "signalToNoise", label: "H/SE(H)", type: "number", unit: null },
    ],
    rows: constituentRows.map((row) => [row.name, row.speedDegPerHour, row.periodHours, row.amplitude, row.amplitudeStandardError, row.phaseDeg, row.phaseStandardErrorDeg, row.signalToNoise]),
    notes: [
      `Mean level Z0=${N.rounded(meanLevel, 6)} ${input.valueUnit}${input.verticalDatum ? ` relative to ${input.verticalDatum}` : ""}; ${valid.length} samples over ${N.rounded(recordHours, 3)} h; residual RMSE=${N.rounded(Math.sqrt(fit.rss / valid.length), 6)} ${input.valueUnit}; variance explained=${N.rounded(varianceExplained, 6)}.`,
      `Phases are referenced to ${input.reference.iso} (not Greenwich epoch) and no nodal (f, u) corrections are applied; ${excluded.length ? `excluded: ${excluded.map((item) => `${item.name} (${item.reason})`).join(", ")}` : "no constituent was excluded"}.`,
      formFactor === null ? "Form factor unavailable (K1, O1, M2, S2 not all fitted)." : `Form factor F=(K1+O1)/(M2+S2)=${N.rounded(formFactor, 6)} → ${formClass}.`,
    ],
  };
  const tideTable = {
    schema: "agentlas.science-table/v1", title: `Predicted high and low waters (${input.predictionStepMinutes}-minute sampling)`,
    columns: [{ id: "time", label: "Time (UTC)", type: "datetime", unit: null }, { id: "height", label: "Predicted height", type: "number", unit: input.valueUnit }, { id: "type", label: "Extremum", type: "string", unit: null }],
    rows: tideTableRows,
  };
  const residualTable = {
    schema: "agentlas.science-table/v1", title: "Observed, predicted, and residual water level",
    columns: [{ id: "time", label: "Time (UTC)", type: "datetime", unit: null }, { id: "observed", label: "Observed", type: "number", unit: input.valueUnit }, { id: "predicted", label: "Predicted", type: "number", unit: input.valueUnit }, { id: "residual", label: "Residual", type: "number", unit: input.valueUnit }],
    rows: residualRows.map((row) => [row.time, row.observed, row.predicted, row.residual]),
  };
  const vegaLite = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    title: "Observed vs harmonic prediction",
    background: "white", width: 640, height: 320,
    data: { values: residualRows },
    layer: [
      { mark: { type: "line", color: "#B85C38", strokeWidth: 1.5 }, encoding: { x: { field: "time", type: "temporal", title: "UTC" }, y: { field: "predicted", type: "quantitative", title: `Water level (${input.valueUnit})`, scale: { zero: false } } } },
      { transform: [{ filter: "datum.observed != null" }], mark: { type: "point", color: "#2E6F62", size: 14 }, encoding: { x: { field: "time", type: "temporal" }, y: { field: "observed", type: "quantitative" }, tooltip: [{ field: "time", type: "temporal" }, { field: "observed", type: "quantitative", format: ".3f" }, { field: "predicted", type: "quantitative", format: ".3f" }, { field: "residual", type: "quantitative", format: ".3f" }] } },
    ],
    config: vegaConfig(),
  };
  const contentReceipts = {
    publicationTable: C.contentReceipt("tidal-constituent-table", "application/vnd.agentlas.science-table+json", publicationTable),
    tideTable: C.contentReceipt("tidal-prediction-table", "application/vnd.agentlas.science-table+json", tideTable),
    residualTable: C.contentReceipt("tidal-residual-table", "application/vnd.agentlas.science-table+json", residualTable),
    figure: C.contentReceipt("tidal-observed-predicted-figure", "application/vnd.vegalite.v5+json", vegaLite),
  };
  const analysis = {
    schema: "agentlas.earth.tidal-harmonic-analysis/v1",
    methodRevision: "least-squares-bounded-catalogue-rayleigh/v1",
    source: { sourceContentSha256: input.sourceContentSha256, sampleCount: input.series.length, validSampleCount: valid.length, recordHours: N.rounded(recordHours, 6), startTime: input.series[0].time, endTime: input.series[input.series.length - 1].time, valueUnit: input.valueUnit, verticalDatum: input.verticalDatum },
    settings: { referenceTime: input.reference.iso, requestedConstituents: input.requested, predictionStepMinutes: input.predictionStepMinutes, predictionWindow: { startTime: input.predictionStart.iso, endTime: input.predictionEnd.iso } },
    constituents: constituentRows, excludedConstituents: excluded,
    estimates: {
      meanLevel: N.rounded(meanLevel), meanLevelStandardError: N.rounded(Math.sqrt(fit.covariance[0][0])), residualVariance: residualVariance === null ? null : N.rounded(residualVariance),
      residualRootMeanSquare: N.rounded(Math.sqrt(fit.rss / valid.length)), varianceExplained: N.rounded(varianceExplained), degreesOfFreedom: fit.degreesOfFreedom,
      formFactor: formFactor === null ? null : N.rounded(formFactor), tidalRegime: formClass, predictedExtremaCount: tideTableRows.length,
    },
    residualSeries: residualRows,
    publicationTable, tideTable, residualTable, vegaLite, contentReceipts,
    assumptions: [
      "Ordinary least squares with a fixed constituent catalogue; constituents violating the Rayleigh criterion for the record length are dropped by priority, not inferred.",
      "Amplitude and phase standard errors follow the delta method from the OLS covariance under independent homoscedastic residuals; serial correlation of residuals is not modelled.",
      "No nodal corrections, inference of unresolved constituents, or datum conversion are performed; phases are relative to the declared reference epoch.",
    ],
    rendererCompatibility: { rendererId: "agentlas.vega", hostRequired: true, bundledRenderer: false, interactive: "tooltip-only" },
  };
  return { ...analysis, analysisSha256: N.sha256Json(analysis) };
}

// ---------------------------------------------------------------------------
// 2. Climate / sea-level trend
// ---------------------------------------------------------------------------

function normalizeClimateTrendInput(value) {
  const C = core();
  const input = C.exactObject(value, ["sourceContentSha256", "series", "valueUnit", "seasonalHarmonics", "confidenceLevel"], "earth-trend-input");
  const sourceContentSha256 = assertSourceSha(input.sourceContentSha256);
  if (!Array.isArray(input.series) || input.series.length < 10 || input.series.length > 20_000) throw N.fail("earth-trend-series-length-invalid", "trend analysis requires 10–20000 samples");
  const series = input.series.map((row, index) => {
    const item = C.exactObject(row, ["time", "value"], "earth-trend-sample");
    const time = C.finite(item.time, -10_000, 10_000, "earth-trend-sample-time");
    if (index > 0 && !(time > input.series[index - 1].time)) throw N.fail("earth-trend-series-not-increasing", "decimal-year times must be strictly increasing", { index });
    return { time, value: item.value === null ? null : C.finite(item.value, -1e12, 1e12, "earth-trend-sample-value") };
  });
  const valueUnit = unitText(input.valueUnit, "earth-trend-value-unit");
  const seasonalHarmonics = input.seasonalHarmonics === undefined ? 2 : C.integer(input.seasonalHarmonics, 0, 4, "earth-trend-seasonal-harmonics");
  const confidenceLevel = input.confidenceLevel === undefined ? 0.95 : C.finite(input.confidenceLevel, 0.8, 0.999, "earth-trend-confidence-level");
  return { sourceContentSha256, series, valueUnit, seasonalHarmonics, confidenceLevel };
}

function mannKendall(values) {
  const n = values.length;
  let s = 0;
  for (let i = 0; i < n - 1; i += 1) for (let j = i + 1; j < n; j += 1) s += Math.sign(values[j] - values[i]);
  const tieCounts = new Map();
  for (const item of values) tieCounts.set(item, (tieCounts.get(item) ?? 0) + 1);
  let tieTerm = 0;
  for (const count of tieCounts.values()) if (count > 1) tieTerm += count * (count - 1) * (2 * count + 5);
  const variance = (n * (n - 1) * (2 * n + 5) - tieTerm) / 18;
  return { s, variance, ties: [...tieCounts.values()].filter((count) => count > 1).length };
}

function zAndP(s, variance) {
  const z = variance > 0 ? (s > 0 ? (s - 1) / Math.sqrt(variance) : s < 0 ? (s + 1) / Math.sqrt(variance) : 0) : 0;
  return { z, pValue: 2 * N.normalSf(Math.abs(z)) };
}

function senSlope(times, values) {
  const slopes = [];
  for (let i = 0; i < values.length - 1; i += 1) for (let j = i + 1; j < values.length; j += 1) slopes.push((values[j] - values[i]) / (times[j] - times[i]));
  return { slope: N.median(slopes), slopes: N.sortedCopy(slopes) };
}

function autocorrelation(values, lag) {
  const n = values.length;
  const m = N.mean(values);
  let denominator = 0;
  for (const item of values) denominator += (item - m) ** 2;
  if (denominator === 0) return 0;
  let numerator = 0;
  for (let i = 0; i + lag < n; i += 1) numerator += (values[i] - m) * (values[i + lag] - m);
  return numerator / denominator;
}

function pettitt(values) {
  const n = values.length;
  let bestK = 0;
  let bestIndex = 0;
  let u = 0;
  const series = [];
  for (let t = 0; t < n - 1; t += 1) {
    // U_t = Σ_{i≤t} Σ_{j>t} sgn(x_j − x_i), updated incrementally.
    let delta = 0;
    for (let j = 0; j < n; j += 1) if (j !== t) delta += Math.sign(values[j] - values[t]);
    u += delta;
    series.push(u);
    if (Math.abs(u) > bestK) { bestK = Math.abs(u); bestIndex = t; }
  }
  const pValue = Math.min(1, 2 * Math.exp(-6 * bestK * bestK / (n ** 3 + n ** 2)));
  return { k: bestK, index: bestIndex, pValue, series };
}

function analyzeClimateTrend(value) {
  const C = core();
  const input = normalizeClimateTrendInput(value);
  const valid = input.series.filter((row) => row.value !== null);
  const p = 2 + 2 * input.seasonalHarmonics;
  if (valid.length < p + 8) throw N.fail("earth-trend-sample-inadequate", "at least parameters + 8 non-null samples are required", { validSamples: valid.length, parameters: p });
  const times = valid.map((row) => row.time);
  const values = valid.map((row) => row.value);
  const t0 = times[0];
  const designRow = (t) => {
    const row = [1, t - t0];
    for (let k = 1; k <= input.seasonalHarmonics; k += 1) row.push(Math.cos(2 * Math.PI * k * t), Math.sin(2 * Math.PI * k * t));
    return row;
  };
  const fit = N.leastSquares(times.map(designRow), values);
  const slope = fit.beta[1];
  const slopeSe = Math.sqrt(fit.covariance[1][1]);
  const r1 = autocorrelation(fit.residuals, 1);
  const n = valid.length;
  const effectiveN = r1 > 0 ? n * (1 - r1) / (1 + r1) : n;
  const inflation = r1 > 0 ? Math.sqrt((1 + r1) / (1 - r1)) : 1;
  const adjustedSe = slopeSe * inflation;
  const effectiveDf = Math.max(1, effectiveN - p);
  const alpha = 1 - input.confidenceLevel;
  const tCritical = N.studentTQuantile(1 - alpha / 2, effectiveDf);
  const tCriticalOls = N.studentTQuantile(1 - alpha / 2, fit.degreesOfFreedom);
  const seasonal = times.map((t) => designRow(t).reduce((sum, term, index) => (index >= 2 ? sum + term * fit.beta[index] : sum), 0));
  const deseasonalized = values.map((v, index) => v - seasonal[index]);
  // Mann–Kendall with Hamed & Rao (1998) correction on the deseasonalized series.
  const mk = mannKendall(deseasonalized);
  const sen = senSlope(times, deseasonalized);
  const detrended = deseasonalized.map((v, index) => v - sen.slope * times[index]);
  const rankSeries = N.ranks(detrended);
  const bound = N.normalQuantile(0.975) / Math.sqrt(n);
  let correctionSum = 0;
  const significantLags = [];
  for (let lag = 1; lag < n; lag += 1) {
    const rho = autocorrelation(rankSeries, lag);
    if (Math.abs(rho) > bound) {
      correctionSum += (n - lag) * (n - lag - 1) * (n - lag - 2) * rho;
      significantLags.push({ lag, rankAutocorrelation: N.rounded(rho) });
    }
  }
  const varianceRatio = 1 + 2 / (n * (n - 1) * (n - 2)) * correctionSum;
  const correctedVariance = mk.variance * varianceRatio;
  const uncorrected = zAndP(mk.s, mk.variance);
  const corrected = zAndP(mk.s, correctedVariance);
  // Sen's slope interval (Gilbert 1987) using the corrected variance.
  const z = N.normalQuantile(1 - alpha / 2);
  const cInterval = z * Math.sqrt(correctedVariance);
  const total = sen.slopes.length;
  const lowerRank = Math.max(0, Math.min(total - 1, Math.round((total - cInterval) / 2)));
  const upperRank = Math.max(0, Math.min(total - 1, Math.round((total + cInterval) / 2) + 1));
  const senLower = sen.slopes[lowerRank];
  const senUpper = sen.slopes[upperRank];
  const change = pettitt(deseasonalized);
  const rows = valid.map((row, index) => ({
    time: row.time, value: row.value, seasonal: N.rounded(seasonal[index]), deseasonalized: N.rounded(deseasonalized[index]),
    olsTrend: N.rounded(fit.beta[0] + slope * (row.time - t0)), senTrend: N.rounded(N.median(deseasonalized) + sen.slope * (row.time - N.median(times))),
    residual: N.rounded(fit.residuals[index]),
  }));
  const publicationTable = {
    schema: "agentlas.science-table/v1",
    title: "Trend estimates with serial-correlation correction, Mann–Kendall, Sen's slope, and Pettitt change point",
    columns: [{ id: "quantity", label: "Quantity", type: "string", unit: null }, { id: "value", label: "Value", type: "number", unit: null }, { id: "unit", label: "Unit", type: "string", unit: null }, { id: "note", label: "Method", type: "string", unit: null }],
    rows: [
      ["OLS trend", N.rounded(slope), `${input.valueUnit}/year`, `OLS with ${input.seasonalHarmonics} seasonal harmonic(s)`],
      ["OLS standard error", N.rounded(slopeSe), `${input.valueUnit}/year`, "independent residuals"],
      ["Lag-1 residual autocorrelation", N.rounded(r1), null, "sample ACF of OLS residuals"],
      ["Effective sample size", N.rounded(effectiveN, 6), "count", "n(1−r1)/(1+r1) (Santer et al. 2000)"],
      ["AR(1)-adjusted standard error", N.rounded(adjustedSe), `${input.valueUnit}/year`, "SE·sqrt((1+r1)/(1−r1))"],
      [`Trend ${input.confidenceLevel * 100}% lower (adjusted)`, N.rounded(slope - tCritical * adjustedSe), `${input.valueUnit}/year`, `t(${N.rounded(effectiveDf, 3)} df)`],
      [`Trend ${input.confidenceLevel * 100}% upper (adjusted)`, N.rounded(slope + tCritical * adjustedSe), `${input.valueUnit}/year`, `t(${N.rounded(effectiveDf, 3)} df)`],
      ["Mann–Kendall S", mk.s, null, "deseasonalized series"],
      ["Mann–Kendall Z (Hamed–Rao corrected)", N.rounded(corrected.z), null, `variance ratio ${N.rounded(varianceRatio, 6)}`],
      ["Mann–Kendall p (Hamed–Rao corrected)", N.rounded(corrected.pValue), null, "two-sided normal approximation"],
      ["Sen's slope", N.rounded(sen.slope), `${input.valueUnit}/year`, "median of pairwise slopes"],
      [`Sen ${input.confidenceLevel * 100}% lower`, N.rounded(senLower), `${input.valueUnit}/year`, "Gilbert (1987) with corrected variance"],
      [`Sen ${input.confidenceLevel * 100}% upper`, N.rounded(senUpper), `${input.valueUnit}/year`, "Gilbert (1987) with corrected variance"],
      ["Pettitt K", change.k, null, "max |U_t| on deseasonalized series"],
      ["Pettitt p", N.rounded(change.pValue), null, "2·exp(−6K²/(n³+n²))"],
      ["Pettitt change point time", times[change.index], "decimal year", "last sample of the first segment"],
    ],
  };
  const seriesTable = {
    schema: "agentlas.science-table/v1", title: "Series, seasonal component, and trend lines",
    columns: [
      { id: "time", label: "Time", type: "number", unit: "decimal year" }, { id: "value", label: "Observed", type: "number", unit: input.valueUnit },
      { id: "seasonal", label: "Seasonal component", type: "number", unit: input.valueUnit }, { id: "deseasonalized", label: "Deseasonalized", type: "number", unit: input.valueUnit },
      { id: "olsTrend", label: "OLS trend line", type: "number", unit: input.valueUnit }, { id: "senTrend", label: "Sen trend line", type: "number", unit: input.valueUnit },
      { id: "residual", label: "OLS residual", type: "number", unit: input.valueUnit },
    ],
    rows: rows.map((row) => [row.time, row.value, row.seasonal, row.deseasonalized, row.olsTrend, row.senTrend, row.residual]),
  };
  const vegaLite = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    title: `Deseasonalized series with OLS trend (${N.rounded(slope, 4)} ${input.valueUnit}/yr) and Sen's slope (${N.rounded(sen.slope, 4)} ${input.valueUnit}/yr)`,
    background: "white", width: 640, height: 320,
    data: { values: rows },
    layer: [
      { mark: { type: "point", color: "#2E6F62", size: 18 }, encoding: { x: { field: "time", type: "quantitative", title: "Decimal year", scale: { zero: false } }, y: { field: "deseasonalized", type: "quantitative", title: `Deseasonalized (${input.valueUnit})`, scale: { zero: false } }, tooltip: [{ field: "time", type: "quantitative", format: ".3f" }, { field: "value", type: "quantitative", format: ".4f" }, { field: "deseasonalized", type: "quantitative", format: ".4f" }] } },
      { mark: { type: "line", color: "#B85C38", strokeWidth: 2 }, encoding: { x: { field: "time", type: "quantitative" }, y: { field: "olsTrend", type: "quantitative" } } },
      { mark: { type: "line", color: "#5C7080", strokeWidth: 2, strokeDash: [6, 3] }, encoding: { x: { field: "time", type: "quantitative" }, y: { field: "senTrend", type: "quantitative" } } },
      { mark: { type: "rule", color: "#7A7772", strokeDash: [3, 3] }, encoding: { x: { datum: times[change.index] } } },
    ],
    config: vegaConfig(),
  };
  const contentReceipts = {
    publicationTable: C.contentReceipt("climate-trend-table", "application/vnd.agentlas.science-table+json", publicationTable),
    seriesTable: C.contentReceipt("climate-trend-series-table", "application/vnd.agentlas.science-table+json", seriesTable),
    figure: C.contentReceipt("climate-trend-figure", "application/vnd.vegalite.v5+json", vegaLite),
  };
  const analysis = {
    schema: "agentlas.earth.climate-trend-analysis/v1",
    methodRevision: "ols-ar1-hamed-rao-sen-pettitt/v1",
    source: { sourceContentSha256: input.sourceContentSha256, sampleCount: input.series.length, validSampleCount: n, startTime: times[0], endTime: times[n - 1], valueUnit: input.valueUnit, timeUnit: "decimal-year" },
    settings: { seasonalHarmonics: input.seasonalHarmonics, confidenceLevel: input.confidenceLevel },
    ols: {
      intercept: N.rounded(fit.beta[0]), interceptTime: t0, slopePerYear: N.rounded(slope), standardError: N.rounded(slopeSe), degreesOfFreedom: fit.degreesOfFreedom,
      confidenceInterval: { lower: N.rounded(slope - tCriticalOls * slopeSe), upper: N.rounded(slope + tCriticalOls * slopeSe) },
      seasonalCoefficients: fit.beta.slice(2).map((item) => N.rounded(item)), residualStandardDeviation: N.rounded(Math.sqrt(fit.sigma2)),
    },
    serialCorrelation: {
      lag1Autocorrelation: N.rounded(r1), effectiveSampleSize: N.rounded(effectiveN), effectiveDegreesOfFreedom: N.rounded(effectiveDf), inflationFactor: N.rounded(inflation),
      adjustedStandardError: N.rounded(adjustedSe), adjustedConfidenceInterval: { lower: N.rounded(slope - tCritical * adjustedSe), upper: N.rounded(slope + tCritical * adjustedSe) },
      method: "Santer et al. (2000) AR(1) effective sample size n(1−r1)/(1+r1); no correction when r1 ≤ 0",
    },
    mannKendall: {
      s: mk.s, varianceUncorrected: N.rounded(mk.variance), tiedGroups: mk.ties, zUncorrected: N.rounded(uncorrected.z), pValueUncorrected: N.rounded(uncorrected.pValue),
      hamedRaoVarianceRatio: N.rounded(varianceRatio), varianceCorrected: N.rounded(correctedVariance), zCorrected: N.rounded(corrected.z), pValueCorrected: N.rounded(corrected.pValue),
      significantRankAutocorrelationLags: significantLags, trendDirection: mk.s > 0 ? "increasing" : mk.s < 0 ? "decreasing" : "none",
      significantAtLevel: corrected.pValue < alpha,
      appliedTo: "seasonal-harmonics-removed series; ranks detrended with Sen's slope before rank autocorrelation",
    },
    sen: { slopePerYear: N.rounded(sen.slope), pairCount: total, confidenceInterval: { lower: N.rounded(senLower), upper: N.rounded(senUpper) }, ranks: { lower: lowerRank, upper: upperRank } },
    pettitt: { k: change.k, pValue: N.rounded(change.pValue), changePointIndex: change.index, changePointTime: times[change.index], significantAtLevel: change.pValue < alpha, statisticSeries: change.series },
    series: rows,
    publicationTable, seriesTable, vegaLite, contentReceipts,
    assumptions: [
      "The seasonal cycle is modelled by fixed annual harmonics; times must be decimal years so that a one-year period is exact.",
      "The AR(1) adjustment corrects only lag-1 serial correlation of OLS residuals; longer-memory processes need a different model.",
      "Mann–Kendall, Sen's slope, and Pettitt are applied to the deseasonalized series; Hamed–Rao uses rank autocorrelations significant at the 5% level.",
      "Pettitt's approximate p-value assumes independent observations; interpret with the reported autocorrelation.",
    ],
    rendererCompatibility: { rendererId: "agentlas.vega", hostRequired: true, bundledRenderer: false, interactive: "tooltip-only" },
  };
  return { ...analysis, analysisSha256: N.sha256Json(analysis) };
}

// ---------------------------------------------------------------------------
// 3. SPI / SPEI
// ---------------------------------------------------------------------------

function normalizeDroughtInput(value) {
  const C = core();
  const input = C.exactObject(value, ["sourceContentSha256", "series", "precipitationUnit", "scales", "index", "referencePeriod", "primaryScale"], "earth-drought-input");
  const sourceContentSha256 = assertSourceSha(input.sourceContentSha256);
  if (!Array.isArray(input.series) || input.series.length < 120 || input.series.length > 6_000) throw N.fail("earth-drought-series-length-invalid", "drought index requires 120–6000 consecutive months");
  const index = input.index === undefined ? "spi" : C.text(input.index, 3, 4, "earth-drought-index");
  if (!["spi", "spei"].includes(index)) throw N.fail("earth-drought-index-invalid");
  const series = input.series.map((row, position) => {
    const item = C.exactObject(row, ["year", "month", "precipitation", "potentialEvapotranspiration"], "earth-drought-sample");
    const year = C.integer(item.year, 1, 9999, "earth-drought-year");
    const month = C.integer(item.month, 1, 12, "earth-drought-month");
    if (position > 0) {
      const previous = input.series[position - 1];
      const expectedMonth = previous.month === 12 ? 1 : previous.month + 1;
      const expectedYear = previous.month === 12 ? previous.year + 1 : previous.year;
      if (year !== expectedYear || month !== expectedMonth) throw N.fail("earth-drought-months-not-consecutive", "months must be consecutive without gaps", { position, year, month });
    }
    const precipitation = item.precipitation === null ? null : C.finite(item.precipitation, 0, 1e6, "earth-drought-precipitation");
    const pet = item.potentialEvapotranspiration === undefined || item.potentialEvapotranspiration === null ? null : C.finite(item.potentialEvapotranspiration, 0, 1e6, "earth-drought-pet");
    if (index === "spei" && precipitation !== null && pet === null) throw N.fail("earth-drought-pet-required", "SPEI requires potential evapotranspiration for every month with precipitation");
    return { year, month, precipitation, pet };
  });
  const precipitationUnit = unitText(input.precipitationUnit, "earth-drought-precipitation-unit");
  let scales = [1, 3, 6, 12];
  if (input.scales !== undefined && input.scales !== null) {
    if (!Array.isArray(input.scales) || input.scales.length < 1 || input.scales.length > 6) throw N.fail("earth-drought-scales-invalid");
    scales = N.sortedCopy(input.scales.map((item) => C.integer(item, 1, 48, "earth-drought-scale")));
    if (new Set(scales).size !== scales.length) throw N.fail("earth-drought-scales-duplicate");
  }
  const primaryScale = input.primaryScale === undefined ? scales[scales.length - 1] : C.integer(input.primaryScale, 1, 48, "earth-drought-primary-scale");
  if (!scales.includes(primaryScale)) throw N.fail("earth-drought-primary-scale-not-in-scales");
  let referencePeriod = null;
  if (input.referencePeriod !== undefined && input.referencePeriod !== null) {
    const period = C.exactObject(input.referencePeriod, ["startYear", "endYear"], "earth-drought-reference-period");
    referencePeriod = { startYear: C.integer(period.startYear, 1, 9999, "earth-drought-reference-start"), endYear: C.integer(period.endYear, 1, 9999, "earth-drought-reference-end") };
    if (referencePeriod.endYear < referencePeriod.startYear) throw N.fail("earth-drought-reference-period-invalid");
  }
  return { sourceContentSha256, series, precipitationUnit, scales, index, referencePeriod, primaryScale };
}

// Thom (1958) gamma maximum-likelihood approximation used by SPI implementations.
function fitGammaThom(values) {
  const positive = values.filter((item) => item > 0);
  const zeros = values.length - positive.length;
  if (positive.length < 5) return null;
  const meanValue = N.mean(positive);
  const meanLog = N.mean(positive.map((item) => Math.log(item)));
  const a = Math.log(meanValue) - meanLog;
  if (!(a > 0)) return null;
  const shape = (1 + Math.sqrt(1 + 4 * a / 3)) / (4 * a);
  const scale = meanValue / shape;
  return { shape, scale, zeroProbability: zeros / values.length, sampleSize: values.length, positiveCount: positive.length };
}

// Unbiased probability-weighted moments b0, b1, b2 (Hosking 1990).
function probabilityWeightedMoments(values) {
  const sorted = N.sortedCopy(values);
  const n = sorted.length;
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < n; i += 1) {
    b0 += sorted[i];
    b1 += sorted[i] * i / (n - 1);
    b2 += sorted[i] * i * (i - 1) / ((n - 1) * (n - 2));
  }
  return { b0: b0 / n, b1: b1 / n, b2: b2 / n };
}

// Three-parameter log-logistic via probability-weighted moments (Vicente-Serrano et al. 2010, eqs. 9–11).
// Their w_s = E[X(1−F)^s] are converted from the unbiased b_s = E[X F^s]: w0=b0, w1=b0−b1, w2=b0−2b1+b2.
function fitLogLogistic(values) {
  if (values.length < 10) return null;
  const { b0, b1, b2 } = probabilityWeightedMoments(values);
  const w0 = b0;
  const w1 = b0 - b1;
  const w2 = b0 - 2 * b1 + b2;
  const beta = (2 * w1 - w0) / (6 * w1 - w0 - 6 * w2);
  if (!(beta > 1)) return null;
  const gammaProduct = N.gammaFunction(1 + 1 / beta) * N.gammaFunction(1 - 1 / beta);
  const alpha = (w0 - 2 * w1) * beta / gammaProduct;
  const gamma = w0 - alpha * gammaProduct;
  if (!(alpha > 0)) return null;
  return { alpha, beta, gamma, sampleSize: values.length };
}

function analyzeDroughtIndex(value) {
  const C = core();
  const input = normalizeDroughtInput(value);
  const warnings = [];
  const months = input.series;
  if (months.length < 360) warnings.push("Fewer than 30 years of data: distribution fits per calendar month rest on small samples.");
  const inReference = (row) => input.referencePeriod === null || (row.year >= input.referencePeriod.startYear && row.year <= input.referencePeriod.endYear);
  const base = months.map((row) => (input.index === "spei" ? (row.precipitation === null || row.pet === null ? null : row.precipitation - row.pet) : row.precipitation));
  const perScale = {};
  const fitRows = [];
  for (const scale of input.scales) {
    const accumulated = months.map((_, position) => {
      if (position < scale - 1) return null;
      let total = 0;
      for (let back = 0; back < scale; back += 1) {
        const item = base[position - back];
        if (item === null) return null;
        total += item;
      }
      return total;
    });
    const indexValues = new Array(months.length).fill(null);
    const fitsByMonth = {};
    for (let calendarMonth = 1; calendarMonth <= 12; calendarMonth += 1) {
      const sample = months.map((row, position) => ({ row, position, value: accumulated[position] })).filter((item) => item.row.month === calendarMonth && item.value !== null && inReference(item.row)).map((item) => item.value);
      let fit = null;
      if (input.index === "spi") {
        const gamma = fitGammaThom(sample);
        if (gamma) fit = { distribution: "gamma", ...gamma };
      } else {
        const logLogistic = fitLogLogistic(sample);
        if (logLogistic) fit = { distribution: "log-logistic", ...logLogistic };
      }
      fitsByMonth[calendarMonth] = fit;
      if (!fit) { warnings.push(`${input.index.toUpperCase()}-${scale}: calendar month ${calendarMonth} has no valid fit; values left null.`); continue; }
      fitRows.push([scale, calendarMonth, fit.distribution, fit.sampleSize, fit.distribution === "gamma" ? N.rounded(fit.shape) : N.rounded(fit.alpha), fit.distribution === "gamma" ? N.rounded(fit.scale) : N.rounded(fit.beta), fit.distribution === "gamma" ? N.rounded(fit.zeroProbability) : N.rounded(fit.gamma)]);
      months.forEach((row, position) => {
        if (row.month !== calendarMonth || accumulated[position] === null) return;
        const x = accumulated[position];
        let cumulative;
        if (fit.distribution === "gamma") {
          cumulative = x > 0 ? fit.zeroProbability + (1 - fit.zeroProbability) * N.regularizedGammaP(fit.shape, x / fit.scale) : fit.zeroProbability;
          if (cumulative <= 0) { indexValues[position] = null; return; }
        } else {
          const shifted = x - fit.gamma;
          cumulative = shifted > 0 ? 1 / (1 + (fit.alpha / shifted) ** fit.beta) : 0;
        }
        const clipped = Math.min(Math.max(cumulative, 1e-12), 1 - 1e-12);
        indexValues[position] = N.rounded(N.normalQuantile(clipped));
      });
    }
    // Drought events (McKee 1993): begins when index ≤ −1, ends when index becomes positive.
    const events = [];
    let current = null;
    months.forEach((row, position) => {
      const item = indexValues[position];
      if (item === null) { if (current) { events.push(current); current = null; } return; }
      if (current) {
        if (item > 0) { events.push(current); current = null; }
        else { current.durationMonths += 1; current.magnitude += item; current.peak = Math.min(current.peak, item); current.endYear = row.year; current.endMonth = row.month; }
      } else if (item <= -1) current = { startYear: row.year, startMonth: row.month, endYear: row.year, endMonth: row.month, durationMonths: 1, magnitude: item, peak: item };
    });
    if (current) events.push(current);
    const categoryCounts = Object.fromEntries(DROUGHT_CATEGORIES.map((item) => [item.label, 0]));
    let valued = 0;
    for (const item of indexValues) if (item !== null) { valued += 1; categoryCounts[droughtCategory(item)] += 1; }
    perScale[scale] = { accumulated, indexValues, fitsByMonth, events, categoryCounts, valuedMonths: valued };
  }
  const monthRows = months.map((row, position) => {
    const record = { year: row.year, month: row.month, precipitation: row.precipitation, potentialEvapotranspiration: row.pet };
    for (const scale of input.scales) {
      record[`accumulated${scale}`] = perScale[scale].accumulated[position] === null ? null : N.rounded(perScale[scale].accumulated[position]);
      record[`index${scale}`] = perScale[scale].indexValues[position];
      record[`category${scale}`] = droughtCategory(perScale[scale].indexValues[position]);
    }
    return record;
  });
  const indexLabel = input.index.toUpperCase();
  const publicationTable = {
    schema: "agentlas.science-table/v1",
    title: `${indexLabel} at ${input.scales.map((scale) => `${scale}-month`).join(", ")} scales with McKee drought categories`,
    columns: [
      { id: "year", label: "Year", type: "integer", unit: null }, { id: "month", label: "Month", type: "integer", unit: null },
      { id: "precipitation", label: "Precipitation", type: "number", unit: input.precipitationUnit },
      ...(input.index === "spei" ? [{ id: "potentialEvapotranspiration", label: "PET", type: "number", unit: input.precipitationUnit }] : []),
      ...input.scales.flatMap((scale) => [
        { id: `accumulated${scale}`, label: `${scale}-month ${input.index === "spei" ? "P−PET" : "total"}`, type: "number", unit: input.precipitationUnit },
        { id: `index${scale}`, label: `${indexLabel}-${scale}`, type: "number", unit: null },
        { id: `category${scale}`, label: `Category ${scale}`, type: "string", unit: null },
      ]),
    ],
    rows: monthRows.map((record) => publicationTableColumnsFor(input).map((id) => record[id])),
    notes: [
      input.index === "spi" ? "Gamma parameters by Thom (1958) maximum-likelihood approximation per calendar month; zero months enter through the mixed distribution H(x)=q+(1−q)G(x)." : "Log-logistic parameters by unbiased L-moments (Vicente-Serrano et al. 2010); the standard normal quantile is evaluated exactly rather than by the Abramowitz–Stegun approximation.",
      `Reference period: ${input.referencePeriod ? `${input.referencePeriod.startYear}–${input.referencePeriod.endYear}` : "entire record"}. Categories follow McKee et al. (1993).`,
    ],
  };
  const summaryTable = {
    schema: "agentlas.science-table/v1", title: "Drought category frequencies and events by scale",
    columns: [
      { id: "scale", label: "Scale (months)", type: "integer", unit: null }, { id: "valuedMonths", label: "Months with index", type: "integer", unit: "count" },
      ...DROUGHT_CATEGORIES.map((item) => ({ id: item.label, label: item.label, type: "integer", unit: "count" })),
      { id: "events", label: "Drought events (index ≤ −1)", type: "integer", unit: "count" }, { id: "longestEventMonths", label: "Longest event", type: "integer", unit: "month" },
      { id: "largestMagnitude", label: "Largest cumulative magnitude", type: "number", unit: null }, { id: "lowestIndex", label: "Lowest index", type: "number", unit: null },
    ],
    rows: input.scales.map((scale) => {
      const item = perScale[scale];
      const valued = item.indexValues.filter((entry) => entry !== null);
      return [scale, item.valuedMonths, ...DROUGHT_CATEGORIES.map((category) => item.categoryCounts[category.label]), item.events.length,
        item.events.length ? Math.max(...item.events.map((event) => event.durationMonths)) : 0,
        item.events.length ? N.rounded(Math.min(...item.events.map((event) => event.magnitude))) : null,
        valued.length ? Math.min(...valued) : null];
    }),
  };
  const fitTable = {
    schema: "agentlas.science-table/v1", title: `${indexLabel} distribution parameters by scale and calendar month`,
    columns: [
      { id: "scale", label: "Scale", type: "integer", unit: "month" }, { id: "calendarMonth", label: "Calendar month", type: "integer", unit: null }, { id: "distribution", label: "Distribution", type: "string", unit: null },
      { id: "sampleSize", label: "Sample size", type: "integer", unit: "count" },
      { id: "parameter1", label: input.index === "spi" ? "Shape α" : "Scale α", type: "number", unit: null }, { id: "parameter2", label: input.index === "spi" ? "Scale β" : "Shape β", type: "number", unit: null },
      { id: "parameter3", label: input.index === "spi" ? "Zero probability q" : "Origin γ", type: "number", unit: null },
    ],
    rows: fitRows,
  };
  const primary = perScale[input.primaryScale];
  const figureRows = months.map((row, position) => ({ time: `${row.year}-${String(row.month).padStart(2, "0")}-01T00:00:00.000Z`, index: primary.indexValues[position], sign: primary.indexValues[position] === null ? null : primary.indexValues[position] < 0 ? "dry" : "wet" }));
  const vegaLite = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    title: `${indexLabel}-${input.primaryScale}`,
    background: "white", width: 640, height: 300,
    data: { values: figureRows },
    layer: [
      { transform: [{ filter: "datum.index != null" }], mark: { type: "bar" }, encoding: { x: { field: "time", type: "temporal", title: "Month" }, y: { field: "index", type: "quantitative", title: `${indexLabel}-${input.primaryScale}` }, color: { field: "sign", type: "nominal", scale: { domain: ["dry", "wet"], range: ["#B85C38", "#2E6F62"] }, title: null }, tooltip: [{ field: "time", type: "temporal" }, { field: "index", type: "quantitative", format: ".2f" }] } },
      { mark: { type: "rule", color: "#7A7772", strokeDash: [4, 4] }, encoding: { y: { datum: -1 } } },
      { mark: { type: "rule", color: "#7A7772", strokeDash: [4, 4] }, encoding: { y: { datum: -2 } } },
    ],
    config: vegaConfig(),
  };
  const contentReceipts = {
    publicationTable: C.contentReceipt("drought-index-table", "application/vnd.agentlas.science-table+json", publicationTable),
    summaryTable: C.contentReceipt("drought-summary-table", "application/vnd.agentlas.science-table+json", summaryTable),
    fitTable: C.contentReceipt("drought-fit-table", "application/vnd.agentlas.science-table+json", fitTable),
    figure: C.contentReceipt("drought-index-figure", "application/vnd.vegalite.v5+json", vegaLite),
  };
  const analysis = {
    schema: "agentlas.earth.drought-index-analysis/v1",
    methodRevision: input.index === "spi" ? "spi-thom-gamma-mixed-zero/v1" : "spei-log-logistic-lmoments/v1",
    index: input.index, warnings,
    source: { sourceContentSha256: input.sourceContentSha256, monthCount: months.length, firstMonth: `${months[0].year}-${months[0].month}`, lastMonth: `${months[months.length - 1].year}-${months[months.length - 1].month}`, precipitationUnit: input.precipitationUnit },
    settings: { scales: input.scales, primaryScale: input.primaryScale, referencePeriod: input.referencePeriod },
    scales: Object.fromEntries(input.scales.map((scale) => [scale, {
      valuedMonths: perScale[scale].valuedMonths, categoryCounts: perScale[scale].categoryCounts, events: perScale[scale].events.map((event) => ({ ...event, magnitude: N.rounded(event.magnitude), peak: N.rounded(event.peak) })),
      fitsByMonth: Object.fromEntries(Object.entries(perScale[scale].fitsByMonth).map(([month, fit]) => [month, fit ? Object.fromEntries(Object.entries(fit).map(([key, item]) => [key, typeof item === "number" ? N.rounded(item) : item])) : null])),
    }])),
    monthlyValues: monthRows,
    publicationTable, summaryTable, fitTable, vegaLite, contentReceipts,
    assumptions: [
      "Accumulations are trailing k-month sums ending in the reported month; any null month nulls every accumulation that includes it.",
      "Distribution parameters are fitted per calendar month on the reference period; the index is undefined where the fit fails or the sample is too small.",
      "SPI uses the mixed zero/gamma distribution of Edwards & McKee (1997); SPEI uses the L-moment log-logistic of Vicente-Serrano et al. (2010). Neither propagates parameter uncertainty.",
    ],
    rendererCompatibility: { rendererId: "agentlas.vega", hostRequired: true, bundledRenderer: false, interactive: "tooltip-only" },
  };
  return { ...analysis, analysisSha256: N.sha256Json(analysis) };
}

function publicationTableColumnsFor(input) {
  return ["year", "month", "precipitation", ...(input.index === "spei" ? ["potentialEvapotranspiration"] : []), ...input.scales.flatMap((scale) => [`accumulated${scale}`, `index${scale}`, `category${scale}`])];
}

// ---------------------------------------------------------------------------
// 4. Flood frequency analysis
// ---------------------------------------------------------------------------

const DEFAULT_RETURN_PERIODS = Object.freeze([2, 5, 10, 25, 50, 100, 200, 500]);

function normalizeFloodInput(value) {
  const C = core();
  const input = C.exactObject(value, ["sourceContentSha256", "peaks", "flowUnit", "returnPeriods", "regionalSkew", "plottingPosition", "confidenceLevel"], "earth-flood-input");
  const sourceContentSha256 = assertSourceSha(input.sourceContentSha256);
  if (!Array.isArray(input.peaks) || input.peaks.length < 10 || input.peaks.length > 2_000) throw N.fail("earth-flood-peaks-length-invalid", "flood frequency requires 10–2000 annual peaks");
  const years = new Set();
  const peaks = input.peaks.map((row) => {
    const item = C.exactObject(row, ["year", "flow"], "earth-flood-peak");
    const year = C.integer(item.year, 1, 9999, "earth-flood-year");
    if (years.has(year)) throw N.fail("earth-flood-year-duplicate", "annual peaks must have unique years", { year });
    years.add(year);
    const flow = C.finite(item.flow, 1e-9, 1e12, "earth-flood-flow");
    return { year, flow };
  }).sort((left, right) => left.year - right.year);
  const flowUnit = unitText(input.flowUnit, "earth-flood-flow-unit");
  let returnPeriods = DEFAULT_RETURN_PERIODS.slice();
  if (input.returnPeriods !== undefined && input.returnPeriods !== null) {
    if (!Array.isArray(input.returnPeriods) || input.returnPeriods.length < 1 || input.returnPeriods.length > 20) throw N.fail("earth-flood-return-periods-invalid");
    returnPeriods = N.sortedCopy(input.returnPeriods.map((item) => C.finite(item, 1.01, 100_000, "earth-flood-return-period")));
    if (new Set(returnPeriods).size !== returnPeriods.length) throw N.fail("earth-flood-return-periods-duplicate");
  }
  let regionalSkew = null;
  if (input.regionalSkew !== undefined && input.regionalSkew !== null) {
    const skew = C.exactObject(input.regionalSkew, ["value", "meanSquareError"], "earth-flood-regional-skew");
    regionalSkew = { value: C.finite(skew.value, -3, 3, "earth-flood-regional-skew-value"), meanSquareError: C.finite(skew.meanSquareError, 1e-6, 10, "earth-flood-regional-skew-mse") };
  }
  const plottingPosition = input.plottingPosition === undefined ? "weibull" : C.text(input.plottingPosition, 1, 20, "earth-flood-plotting-position");
  if (!["weibull", "gringorten"].includes(plottingPosition)) throw N.fail("earth-flood-plotting-position-invalid");
  const confidenceLevel = input.confidenceLevel === undefined ? 0.95 : C.finite(input.confidenceLevel, 0.8, 0.999, "earth-flood-confidence-level");
  return { sourceContentSha256, peaks, flowUnit, returnPeriods, regionalSkew, plottingPosition, confidenceLevel };
}

// Wilson–Hilferty Pearson III frequency factor (Bulletin 17B eq. 3; adequate for |G| ≤ ~2).
function pearsonFrequencyFactor(z, skew) {
  if (Math.abs(skew) < 1e-9) return z;
  const k = skew / 6;
  return (2 / skew) * ((1 + k * z - k * k) ** 3 - 1);
}

// Bulletin 17B eq. 6 generalised-skew mean square error (station-skew weighting).
function bulletin17bSkewMse(skew, n) {
  const g = Math.abs(skew);
  const a = g <= 0.9 ? -0.33 + 0.08 * g : -0.52 + 0.30 * g;
  const b = g <= 1.5 ? 0.94 - 0.26 * g : 0.55;
  return 10 ** (a - b * Math.log10(n / 10));
}

function analyzeFloodFrequency(value) {
  const C = core();
  const input = normalizeFloodInput(value);
  const flows = input.peaks.map((row) => row.flow);
  const n = flows.length;
  const alpha = 1 - input.confidenceLevel;
  const z = N.normalQuantile(1 - alpha / 2);
  // Log-Pearson III moments (base-10 logs).
  const logs = flows.map((item) => Math.log10(item));
  const logMean = N.mean(logs);
  const logSd = Math.sqrt(N.sampleVariance(logs));
  const stationSkew = n * logs.reduce((sum, item) => sum + (item - logMean) ** 3, 0) / ((n - 1) * (n - 2) * logSd ** 3);
  let skewUsed = stationSkew;
  let skewWeighting = null;
  if (input.regionalSkew) {
    const mseStation = bulletin17bSkewMse(stationSkew, n);
    skewUsed = (input.regionalSkew.meanSquareError * stationSkew + mseStation * input.regionalSkew.value) / (input.regionalSkew.meanSquareError + mseStation);
    skewWeighting = { stationSkew: N.rounded(stationSkew), stationMeanSquareError: N.rounded(mseStation), regionalSkew: input.regionalSkew.value, regionalMeanSquareError: input.regionalSkew.meanSquareError, weightedSkew: N.rounded(skewUsed) };
  }
  // Gumbel method of moments.
  const mean = N.mean(flows);
  const sd = Math.sqrt(N.sampleVariance(flows));
  const gumbelScale = sd * Math.sqrt(6) / Math.PI;
  const gumbelLocation = mean - EULER_GAMMA * gumbelScale;
  // GEV via L-moments (Hosking 1990).
  const pwm = probabilityWeightedMoments(flows);
  const l1 = pwm.b0;
  const l2 = 2 * pwm.b1 - pwm.b0;
  const l3 = 6 * pwm.b2 - 6 * pwm.b1 + pwm.b0;
  const tau3 = l3 / l2;
  const c = 2 / (3 + tau3) - Math.log(2) / Math.log(3);
  const gevShape = 7.8590 * c + 2.9554 * c * c;
  const gevScale = l2 * gevShape / ((1 - 2 ** -gevShape) * N.gammaFunction(1 + gevShape));
  const gevLocation = l1 - gevScale * (1 - N.gammaFunction(1 + gevShape)) / gevShape;
  const quantileRows = input.returnPeriods.map((returnPeriod) => {
    const probability = 1 - 1 / returnPeriod;
    const zT = N.normalQuantile(probability);
    const kT = pearsonFrequencyFactor(zT, skewUsed);
    const lp3 = 10 ** (logMean + kT * logSd);
    // Bulletin 17B Appendix 9 confidence limits.
    const a = 1 - z * z / (2 * (n - 1));
    const b = kT * kT - z * z / n;
    const root = Math.sqrt(Math.max(0, kT * kT - a * b));
    const kUpper = (kT + root) / a;
    const kLower = (kT - root) / a;
    const gumbel = gumbelLocation - gumbelScale * Math.log(-Math.log(probability));
    const gumbelK = (gumbel - mean) / sd;
    const gumbelSe = sd / Math.sqrt(n) * Math.sqrt(1 + 1.1396 * gumbelK + 1.1 * gumbelK * gumbelK);
    const gev = Math.abs(gevShape) < 1e-9 ? gevLocation - gevScale * Math.log(-Math.log(probability)) : gevLocation + gevScale / gevShape * (1 - (-Math.log(probability)) ** gevShape);
    return {
      returnPeriod, exceedanceProbability: N.rounded(1 / returnPeriod), reducedVariate: N.rounded(-Math.log(-Math.log(probability))),
      logPearson3: N.rounded(lp3), logPearson3Lower: N.rounded(10 ** (logMean + kLower * logSd)), logPearson3Upper: N.rounded(10 ** (logMean + kUpper * logSd)), frequencyFactor: N.rounded(kT),
      gumbel: N.rounded(gumbel), gumbelLower: N.rounded(gumbel - z * gumbelSe), gumbelUpper: N.rounded(gumbel + z * gumbelSe), gumbelStandardError: N.rounded(gumbelSe),
      gev: N.rounded(gev),
    };
  });
  const sortedFlows = N.sortedCopy(flows).reverse();
  const observedRows = sortedFlows.map((flow, index) => {
    const rank = index + 1;
    const probability = input.plottingPosition === "weibull" ? rank / (n + 1) : (rank - 0.44) / (n + 0.12);
    return { rank, flow, exceedanceProbability: N.rounded(probability), empiricalReturnPeriod: N.rounded(1 / probability), reducedVariate: N.rounded(-Math.log(-Math.log(1 - probability))) };
  });
  const publicationTable = {
    schema: "agentlas.science-table/v1",
    title: "Flood quantiles by return period",
    columns: [
      { id: "returnPeriod", label: "Return period", type: "number", unit: "year" }, { id: "exceedanceProbability", label: "Annual exceedance probability", type: "number", unit: null },
      { id: "logPearson3", label: "Log-Pearson III", type: "number", unit: input.flowUnit },
      { id: "logPearson3Lower", label: `LP3 ${input.confidenceLevel * 100}% lower`, type: "number", unit: input.flowUnit }, { id: "logPearson3Upper", label: `LP3 ${input.confidenceLevel * 100}% upper`, type: "number", unit: input.flowUnit },
      { id: "gumbel", label: "Gumbel", type: "number", unit: input.flowUnit }, { id: "gumbelLower", label: `Gumbel ${input.confidenceLevel * 100}% lower`, type: "number", unit: input.flowUnit }, { id: "gumbelUpper", label: `Gumbel ${input.confidenceLevel * 100}% upper`, type: "number", unit: input.flowUnit },
      { id: "gev", label: "GEV (L-moments)", type: "number", unit: input.flowUnit },
    ],
    rows: quantileRows.map((row) => [row.returnPeriod, row.exceedanceProbability, row.logPearson3, row.logPearson3Lower, row.logPearson3Upper, row.gumbel, row.gumbelLower, row.gumbelUpper, row.gev]),
    notes: [
      `n=${n} annual peaks; log10 mean=${N.rounded(logMean, 6)}, log10 SD=${N.rounded(logSd, 6)}, station skew=${N.rounded(stationSkew, 6)}${skewWeighting ? `, weighted skew=${skewWeighting.weightedSkew}` : " (no regional skew supplied)"}.`,
      "LP3 limits follow Bulletin 17B Appendix 9 (non-central t approximation); Gumbel limits use the Kite (1977) method-of-moments standard error; GEV L-moment quantiles carry no confidence band in this version.",
      "The Wilson–Hilferty frequency factor is accurate for |skew| ≤ ~2; low-outlier screening, historical-peak adjustment, and the Expected Moments Algorithm (Bulletin 17C) are not implemented.",
    ],
  };
  const observedTable = {
    schema: "agentlas.science-table/v1", title: `Observed annual peaks with ${input.plottingPosition} plotting positions`,
    columns: [
      { id: "rank", label: "Rank", type: "integer", unit: null }, { id: "flow", label: "Peak flow", type: "number", unit: input.flowUnit },
      { id: "exceedanceProbability", label: "Plotting-position exceedance probability", type: "number", unit: null }, { id: "empiricalReturnPeriod", label: "Empirical return period", type: "number", unit: "year" },
      { id: "reducedVariate", label: "Gumbel reduced variate", type: "number", unit: null },
    ],
    rows: observedRows.map((row) => [row.rank, row.flow, row.exceedanceProbability, row.empiricalReturnPeriod, row.reducedVariate]),
  };
  const curveRows = [];
  for (let index = 0; index <= 80; index += 1) {
    const probability = 0.02 + 0.978 * index / 80;
    const zT = N.normalQuantile(probability);
    const kT = pearsonFrequencyFactor(zT, skewUsed);
    const a = 1 - z * z / (2 * (n - 1));
    const b = kT * kT - z * z / n;
    const root = Math.sqrt(Math.max(0, kT * kT - a * b));
    curveRows.push({
      reducedVariate: N.rounded(-Math.log(-Math.log(probability))), returnPeriod: N.rounded(1 / (1 - probability), 6),
      logPearson3: N.rounded(10 ** (logMean + kT * logSd)), lower: N.rounded(10 ** (logMean + (kT - root) / a * logSd)), upper: N.rounded(10 ** (logMean + (kT + root) / a * logSd)),
      gumbel: N.rounded(gumbelLocation - gumbelScale * Math.log(-Math.log(probability))),
      gev: N.rounded(Math.abs(gevShape) < 1e-9 ? gevLocation - gevScale * Math.log(-Math.log(probability)) : gevLocation + gevScale / gevShape * (1 - (-Math.log(probability)) ** gevShape)),
    });
  }
  const vegaLite = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    title: "Flood frequency curve (Gumbel reduced variate axis)",
    background: "white", width: 640, height: 340,
    layer: [
      { data: { values: curveRows }, mark: { type: "area", opacity: 0.18, color: "#B85C38" }, encoding: { x: { field: "reducedVariate", type: "quantitative", title: "Reduced variate −ln(−ln(1−1/T))" }, y: { field: "lower", type: "quantitative", title: `Peak flow (${input.flowUnit})`, scale: { type: "log" } }, y2: { field: "upper" } } },
      { data: { values: curveRows }, mark: { type: "line", color: "#B85C38", strokeWidth: 2 }, encoding: { x: { field: "reducedVariate", type: "quantitative" }, y: { field: "logPearson3", type: "quantitative" }, tooltip: [{ field: "returnPeriod", type: "quantitative", format: ".1f" }, { field: "logPearson3", type: "quantitative", format: ".1f" }] } },
      { data: { values: curveRows }, mark: { type: "line", color: "#5C7080", strokeWidth: 1.5, strokeDash: [6, 3] }, encoding: { x: { field: "reducedVariate", type: "quantitative" }, y: { field: "gumbel", type: "quantitative" } } },
      { data: { values: curveRows }, mark: { type: "line", color: "#2E6F62", strokeWidth: 1.5, strokeDash: [2, 2] }, encoding: { x: { field: "reducedVariate", type: "quantitative" }, y: { field: "gev", type: "quantitative" } } },
      { data: { values: observedRows }, mark: { type: "point", filled: true, color: "#2E6F62", size: 50 }, encoding: { x: { field: "reducedVariate", type: "quantitative" }, y: { field: "flow", type: "quantitative" }, tooltip: [{ field: "rank", type: "quantitative" }, { field: "flow", type: "quantitative" }, { field: "empiricalReturnPeriod", type: "quantitative", format: ".2f" }] } },
    ],
    config: vegaConfig(),
  };
  const contentReceipts = {
    publicationTable: C.contentReceipt("flood-frequency-table", "application/vnd.agentlas.science-table+json", publicationTable),
    observedTable: C.contentReceipt("flood-observed-table", "application/vnd.agentlas.science-table+json", observedTable),
    figure: C.contentReceipt("flood-frequency-figure", "application/vnd.vegalite.v5+json", vegaLite),
  };
  const analysis = {
    schema: "agentlas.earth.flood-frequency-analysis/v1",
    methodRevision: "lp3-b17b-gumbel-mom-gev-lmoments/v1",
    source: { sourceContentSha256: input.sourceContentSha256, peakCount: n, firstYear: input.peaks[0].year, lastYear: input.peaks[n - 1].year, flowUnit: input.flowUnit },
    settings: { returnPeriods: input.returnPeriods, plottingPosition: input.plottingPosition, confidenceLevel: input.confidenceLevel, regionalSkew: input.regionalSkew },
    logPearson3: { logMean: N.rounded(logMean), logStandardDeviation: N.rounded(logSd), stationSkew: N.rounded(stationSkew), skewUsed: N.rounded(skewUsed), skewWeighting, frequencyFactor: "Wilson–Hilferty (Bulletin 17B)" },
    gumbel: { location: N.rounded(gumbelLocation), scale: N.rounded(gumbelScale), mean: N.rounded(mean), standardDeviation: N.rounded(sd), method: "method of moments" },
    gev: { shape: N.rounded(gevShape), scale: N.rounded(gevScale), location: N.rounded(gevLocation), lMoments: { l1: N.rounded(l1), l2: N.rounded(l2), l3: N.rounded(l3), tau3: N.rounded(tau3) }, shapeConvention: "Hosking (1990): k > 0 bounded upper tail (Weibull type), k < 0 heavy tail (Fréchet type)", confidenceBand: null },
    quantiles: quantileRows, observed: observedRows, frequencyCurve: curveRows,
    publicationTable, observedTable, vegaLite, contentReceipts,
    assumptions: [
      "Annual peaks are treated as independent, identically distributed, and stationary; no trend, regulation, or mixed-population screening is performed.",
      "Log-Pearson III uses method of moments on log10 flows with optional Bulletin 17B skew weighting; no low-outlier or historical adjustment.",
      "Gumbel and GEV are fitted to untransformed flows; GEV confidence limits are not computed.",
    ],
    rendererCompatibility: { rendererId: "agentlas.vega", hostRequired: true, bundledRenderer: false, interactive: "tooltip-only" },
  };
  return { ...analysis, analysisSha256: N.sha256Json(analysis) };
}

module.exports = {
  DEFAULT_RETURN_PERIODS,
  DROUGHT_CATEGORIES,
  TIDAL_CONSTITUENTS,
  analyzeClimateTrend,
  analyzeDroughtIndex,
  analyzeFloodFrequency,
  analyzeTidalHarmonics,
  bulletin17bSkewMse,
  droughtCategory,
  fitGammaThom,
  fitLogLogistic,
  mannKendall,
  normalizeClimateTrendInput,
  normalizeDroughtInput,
  normalizeFloodInput,
  normalizeTidalInput,
  pearsonFrequencyFactor,
  pettitt,
  probabilityWeightedMoments,
  senSlope,
};
