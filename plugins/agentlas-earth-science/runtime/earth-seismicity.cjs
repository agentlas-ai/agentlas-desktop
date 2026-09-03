"use strict";

// Seismicity analyses: magnitude of completeness, b-value with Shi & Bolt (1982)
// uncertainty, return periods, sliding-window b-value series, and aftershock
// productivity (Båth's law, sequence duration, Omori–Utsu forecast table).
//
// References
//  Aki K. (1965) Bull. Earthq. Res. Inst. 43, 237–239 — maximum-likelihood b.
//  Utsu T. (1966) — binning correction Mc − ΔM/2 for discretised magnitudes.
//  Shi Y. & Bolt B. A. (1982) BSSA 72, 1677–1687 — standard deviation of b.
//  Wiemer S. & Wyss M. (2000) BSSA 90, 859–869 — maximum curvature and goodness-of-fit Mc.
//  Cao A. & Gao S. S. (2002) GRL 29 — b-value stability Mc.
//  Woessner J. & Wiemer S. (2005) BSSA 95, 684–698 — Mc method comparison, MAXC + 0.2 correction.
//  Båth M. (1965) Tectonophysics 2, 483–514 — mainshock/largest-aftershock difference ≈ 1.2.
//  Shcherbakov R. & Turcotte D. L. (2004) BSSA 94, 1968–1975 — modified Båth's law.
//  Utsu T., Ogata Y., Matsu'ura R. S. (1995) J. Phys. Earth 43, 1–33 — Omori–Utsu law.
//  Reasenberg P. A. & Jones L. M. (1989) Science 243, 1173–1176 — aftershock forecast form.

const N = require("./earth-numerics.cjs");

function core() {
  return require("./earth-science.cjs");
}

const MIN_WINDOW_EVENTS = 20;
const MIN_B_STABILITY_SAMPLE = 20;
const MIN_AFTERSHOCK_B_SAMPLE = 20;
const COMPLETENESS_SELECTIONS = new Set([
  "maximum-curvature", "maximum-curvature-corrected", "goodness-of-fit-90", "goodness-of-fit-95", "b-value-stability", "explicit",
]);

function binIndex(magnitude, binWidth) {
  return Math.round(magnitude / binWidth);
}

function akiB(magnitudes, completenessMagnitude, binWidth) {
  const n = magnitudes.length;
  const meanMagnitude = N.mean(magnitudes);
  const effectiveThreshold = completenessMagnitude - binWidth / 2;
  const denominator = meanMagnitude - effectiveThreshold;
  if (!(denominator > 0)) return null;
  const bValue = Math.LOG10E / denominator;
  const squares = magnitudes.reduce((sum, value) => sum + (value - meanMagnitude) ** 2, 0);
  const shiBolt = 2.30 * bValue * bValue * Math.sqrt(squares / (n * (n - 1)));
  return { sampleSize: n, meanMagnitude, effectiveThreshold, bValue, akiStandardError: bValue / Math.sqrt(n), shiBoltStandardError: shiBolt, aValue: Math.log10(n) + bValue * completenessMagnitude };
}

function selectSameTypeEvents(input, label) {
  const C = core();
  const seen = new Set();
  const included = [];
  const auditRows = [];
  const excludedByReason = { missingMagnitude: 0, magnitudeTypeMismatch: 0 };
  for (const rawEvent of input.catalog.observations) {
    if (!rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent)) throw N.fail(`${label}-event-invalid`);
    const id = C.normalizeEventId(String(rawEvent.id ?? ""));
    if (seen.has(id)) throw N.fail(`${label}-event-id-duplicate`);
    seen.add(id);
    const instant = C.isoInstant(rawEvent.time, `${label}-event-time`);
    if (instant.millis < input.start.millis || instant.millis > input.end.millis) throw N.fail(`${label}-event-outside-source-window`);
    const magnitude = rawEvent.magnitude === null ? null : C.finite(rawEvent.magnitude, -2, 10, `${label}-event-magnitude`);
    const magnitudeType = rawEvent.magnitudeType === null ? null : C.text(rawEvent.magnitudeType, 1, 40, `${label}-event-magnitude-type`).toLowerCase();
    let exclusionReason = null;
    if (magnitude === null) exclusionReason = "missing-magnitude";
    else if (magnitudeType !== input.magnitudeType) exclusionReason = "magnitude-type-mismatch";
    if (exclusionReason === "missing-magnitude") excludedByReason.missingMagnitude += 1;
    else if (exclusionReason === "magnitude-type-mismatch") excludedByReason.magnitudeTypeMismatch += 1;
    else {
      if (Math.abs(magnitude / input.binWidth - Math.round(magnitude / input.binWidth)) > 1e-8) {
        throw N.fail(`${label}-magnitude-bin-alignment-invalid`, "Included magnitudes must align to the declared catalog bin width", { eventId: id, magnitude, binWidth: input.binWidth });
      }
      included.push({ id, time: instant.iso, millis: instant.millis, magnitude });
    }
    auditRows.push([id, instant.iso, magnitude, magnitudeType, exclusionReason === null, exclusionReason]);
  }
  return { included, auditRows, excludedByReason };
}

function normalizeSeismicityInput(value) {
  const C = core();
  const input = C.exactObject(value, [
    "catalog", "magnitudeType", "binWidth", "confidenceLevel", "completenessSelection", "completenessMagnitude", "maximumCurvatureCorrection",
    "windowEvents", "stepEvents", "returnPeriodMagnitudes", "stabilityWindowBins",
  ], "earth-seismicity-input");
  const catalogInput = C.validateGutenbergRichterCatalog(input.catalog);
  const magnitudeType = C.text(input.magnitudeType, 1, 40, "earth-seismicity-magnitude-type").toLowerCase();
  const binWidth = input.binWidth === undefined ? 0.1 : C.finite(input.binWidth, 0.01, 1, "earth-seismicity-bin-width");
  const confidenceLevel = input.confidenceLevel === undefined ? 0.95 : C.finite(input.confidenceLevel, 0.9, 0.99, "earth-seismicity-confidence-level");
  if (!Object.hasOwn(C.NORMAL_CRITICAL_VALUES, String(confidenceLevel))) throw N.fail("earth-seismicity-confidence-level-invalid");
  const completenessSelection = input.completenessSelection === undefined ? "maximum-curvature-corrected" : C.text(input.completenessSelection, 1, 40, "earth-seismicity-completeness-selection");
  if (!COMPLETENESS_SELECTIONS.has(completenessSelection)) throw N.fail("earth-seismicity-completeness-selection-invalid");
  const completenessMagnitude = input.completenessMagnitude === undefined || input.completenessMagnitude === null ? null : C.finite(input.completenessMagnitude, -2, 10, "earth-seismicity-completeness-magnitude");
  if (completenessSelection === "explicit" && completenessMagnitude === null) throw N.fail("earth-seismicity-explicit-completeness-required");
  if (completenessMagnitude !== null && Math.abs(completenessMagnitude / binWidth - Math.round(completenessMagnitude / binWidth)) > 1e-8) throw N.fail("earth-seismicity-completeness-bin-alignment-invalid");
  const maximumCurvatureCorrection = input.maximumCurvatureCorrection === undefined ? 0.2 : C.finite(input.maximumCurvatureCorrection, 0, 1, "earth-seismicity-maxc-correction");
  if (Math.abs(maximumCurvatureCorrection / binWidth - Math.round(maximumCurvatureCorrection / binWidth)) > 1e-8) throw N.fail("earth-seismicity-maxc-correction-bin-alignment-invalid");
  const windowEvents = input.windowEvents === undefined ? 100 : C.integer(input.windowEvents, MIN_WINDOW_EVENTS, 2_000, "earth-seismicity-window-events");
  const stepEvents = input.stepEvents === undefined ? 25 : C.integer(input.stepEvents, 1, 2_000, "earth-seismicity-step-events");
  if (stepEvents > windowEvents) throw N.fail("earth-seismicity-step-exceeds-window");
  const stabilityWindowBins = input.stabilityWindowBins === undefined ? Math.round(0.5 / binWidth) + 1 : C.integer(input.stabilityWindowBins, 2, 50, "earth-seismicity-stability-window-bins");
  let returnPeriodMagnitudes = null;
  if (input.returnPeriodMagnitudes !== undefined && input.returnPeriodMagnitudes !== null) {
    if (!Array.isArray(input.returnPeriodMagnitudes) || input.returnPeriodMagnitudes.length < 1 || input.returnPeriodMagnitudes.length > 40) throw N.fail("earth-seismicity-return-period-magnitudes-invalid");
    returnPeriodMagnitudes = input.returnPeriodMagnitudes.map((item) => C.finite(item, -2, 10, "earth-seismicity-return-period-magnitude"));
    const sorted = N.sortedCopy(returnPeriodMagnitudes);
    if (new Set(sorted).size !== sorted.length) throw N.fail("earth-seismicity-return-period-magnitudes-duplicate");
    returnPeriodMagnitudes = sorted;
  }
  return { ...catalogInput, magnitudeType, binWidth, confidenceLevel, completenessSelection, completenessMagnitude, maximumCurvatureCorrection, windowEvents, stepEvents, stabilityWindowBins, returnPeriodMagnitudes };
}

function analyzeSeismicityBValue(value) {
  const C = core();
  const input = normalizeSeismicityInput(value);
  const { included, auditRows, excludedByReason } = selectSameTypeEvents(input, "earth-seismicity");
  if (included.length < C.MIN_GUTENBERG_RICHTER_EVENTS) {
    throw N.fail("earth-seismicity-sample-inadequate", `At least ${C.MIN_GUTENBERG_RICHTER_EVENTS} same-type magnitudes are required`, { includedCount: included.length, minimum: C.MIN_GUTENBERG_RICHTER_EVENTS });
  }
  const binWidthValue = input.binWidth;
  const magnitudes = included.map((event) => event.magnitude);
  const minIndex = Math.min(...magnitudes.map((m) => binIndex(m, binWidthValue)));
  const maxIndex = Math.max(...magnitudes.map((m) => binIndex(m, binWidthValue)));
  if (maxIndex - minIndex + 1 < 3) throw N.fail("earth-seismicity-magnitude-range-inadequate", "At least three occupied magnitude bins are required");
  const fmdRows = [];
  for (let index = minIndex; index <= maxIndex; index += 1) {
    const magnitude = N.rounded(index * binWidthValue, 10);
    const binCount = magnitudes.filter((m) => binIndex(m, binWidthValue) === index).length;
    const cumulativeCount = magnitudes.filter((m) => binIndex(m, binWidthValue) >= index).length;
    fmdRows.push({ magnitude, binCount, cumulativeCount });
  }
  // Maximum curvature: mode of the non-cumulative frequency–magnitude distribution (Wiemer & Wyss 2000).
  const maxBinCount = Math.max(...fmdRows.map((row) => row.binCount));
  const maxcRow = fmdRows.find((row) => row.binCount === maxBinCount);
  const maximumCurvature = { completenessMagnitude: maxcRow.magnitude, binCount: maxcRow.binCount };
  const maximumCurvatureCorrected = N.rounded(maxcRow.magnitude + input.maximumCurvatureCorrection, 10);
  // Goodness of fit (Wiemer & Wyss 2000): R = 100 − 100·Σ|B_i − S_i| / Σ B_i over cumulative bins ≥ Mc.
  const candidateRows = [];
  for (const row of fmdRows) {
    const subset = magnitudes.filter((m) => binIndex(m, binWidthValue) >= binIndex(row.magnitude, binWidthValue));
    if (subset.length < MIN_B_STABILITY_SAMPLE) break;
    const fit = akiB(subset, row.magnitude, binWidthValue);
    if (!fit) break;
    const bins = fmdRows.filter((item) => binIndex(item.magnitude, binWidthValue) >= binIndex(row.magnitude, binWidthValue));
    const absoluteResidual = bins.reduce((sum, item) => sum + Math.abs(item.cumulativeCount - 10 ** (fit.aValue - fit.bValue * item.magnitude)), 0);
    const observedTotal = bins.reduce((sum, item) => sum + item.cumulativeCount, 0);
    candidateRows.push({ magnitude: row.magnitude, sampleSize: subset.length, bValue: fit.bValue, shiBoltStandardError: fit.shiBoltStandardError, aValue: fit.aValue, goodnessOfFitPercent: 100 - 100 * absoluteResidual / observedTotal, stabilityMeanB: null, stabilityDelta: null, stable: null });
  }
  if (!candidateRows.length) throw N.fail("earth-seismicity-completeness-candidates-inadequate");
  // b-value stability (Cao & Gao 2002; Woessner & Wiemer 2005): |b_ave(Mc..Mc+0.5) − b(Mc)| ≤ δb(Mc).
  for (let index = 0; index < candidateRows.length; index += 1) {
    const window = candidateRows.slice(index, index + input.stabilityWindowBins);
    if (window.length < input.stabilityWindowBins) break;
    const meanB = N.mean(window.map((row) => row.bValue));
    candidateRows[index].stabilityMeanB = meanB;
    candidateRows[index].stabilityDelta = Math.abs(meanB - candidateRows[index].bValue);
    candidateRows[index].stable = candidateRows[index].stabilityDelta <= candidateRows[index].shiBoltStandardError;
  }
  const gft90 = candidateRows.find((row) => row.goodnessOfFitPercent >= 90) ?? null;
  const gft95 = candidateRows.find((row) => row.goodnessOfFitPercent >= 95) ?? null;
  const stability = candidateRows.find((row) => row.stable === true) ?? null;
  const completenessEstimates = {
    maximumCurvature: maximumCurvature.completenessMagnitude,
    maximumCurvatureCorrected,
    goodnessOfFit90: gft90 ? gft90.magnitude : null,
    goodnessOfFit95: gft95 ? gft95.magnitude : null,
    bValueStability: stability ? stability.magnitude : null,
    explicit: input.completenessMagnitude,
  };
  const selectionKey = {
    "maximum-curvature": "maximumCurvature", "maximum-curvature-corrected": "maximumCurvatureCorrected", "goodness-of-fit-90": "goodnessOfFit90",
    "goodness-of-fit-95": "goodnessOfFit95", "b-value-stability": "bValueStability", explicit: "explicit",
  }[input.completenessSelection];
  const selectedMc = completenessEstimates[selectionKey];
  if (selectedMc === null) throw N.fail("earth-seismicity-completeness-selection-unavailable", `The ${input.completenessSelection} estimate could not be determined for this catalog`, { completenessEstimates });
  if (input.query.minMagnitude > selectedMc) throw N.fail("earth-seismicity-query-truncates-completeness", "USGS query minimum magnitude is above the selected completeness threshold");
  const complete = included.filter((event) => binIndex(event.magnitude, binWidthValue) >= binIndex(selectedMc, binWidthValue));
  if (complete.length < C.MIN_GUTENBERG_RICHTER_EVENTS) {
    throw N.fail("earth-seismicity-sample-inadequate", `At least ${C.MIN_GUTENBERG_RICHTER_EVENTS} magnitudes at or above the selected Mc are required`, { includedCount: complete.length, minimum: C.MIN_GUTENBERG_RICHTER_EVENTS, selectedMc });
  }
  const fit = akiB(complete.map((event) => event.magnitude), selectedMc, binWidthValue);
  if (!fit) throw N.fail("earth-seismicity-mle-denominator-invalid");
  const z = C.NORMAL_CRITICAL_VALUES[String(input.confidenceLevel)];
  const bLower = Math.max(0, fit.bValue - z * fit.shiBoltStandardError);
  const bUpper = fit.bValue + z * fit.shiBoltStandardError;
  const durationYears = (input.end.millis - input.start.millis) / (365.25 * 86_400_000);
  const maximumMagnitude = Math.max(...complete.map((event) => event.magnitude));
  const thresholds = input.returnPeriodMagnitudes ?? (() => {
    const list = [];
    const stop = Math.max(maximumMagnitude, selectedMc + 2);
    for (let m = selectedMc; m <= stop + 1e-9; m += 0.5) list.push(N.rounded(m, 10));
    return list;
  })();
  const rateRows = thresholds.map((magnitude) => {
    const observed = magnitude < selectedMc - 1e-9 ? null : complete.filter((event) => event.magnitude >= magnitude - 1e-9).length;
    const log10Rate = (b) => Math.log10(complete.length / durationYears) - b * (magnitude - selectedMc);
    const annualRate = magnitude < selectedMc - 1e-9 ? null : 10 ** log10Rate(fit.bValue);
    return {
      magnitude,
      observedCount: observed,
      annualRate: annualRate === null ? null : N.rounded(annualRate),
      returnPeriodYears: annualRate === null ? null : N.rounded(1 / annualRate),
      returnPeriodLowerYears: annualRate === null ? null : N.rounded(1 / 10 ** log10Rate(bLower)),
      returnPeriodUpperYears: annualRate === null ? null : N.rounded(1 / 10 ** log10Rate(bUpper)),
      extrapolated: magnitude > maximumMagnitude + 1e-9,
    };
  });
  // Sliding-window b-value time series over events ≥ Mc sorted by origin time.
  const chronological = complete.slice().sort((left, right) => left.millis - right.millis || left.id.localeCompare(right.id));
  const seriesRows = [];
  for (let start = 0; start + input.windowEvents <= chronological.length; start += input.stepEvents) {
    const window = chronological.slice(start, start + input.windowEvents);
    const windowFit = akiB(window.map((event) => event.magnitude), selectedMc, binWidthValue);
    if (!windowFit) continue;
    const centerMillis = (window[0].millis + window[window.length - 1].millis) / 2;
    seriesRows.push({
      windowIndex: seriesRows.length, startTime: window[0].time, endTime: window[window.length - 1].time, centerTime: new Date(Math.round(centerMillis)).toISOString(),
      eventCount: window.length, bValue: N.rounded(windowFit.bValue), shiBoltStandardError: N.rounded(windowFit.shiBoltStandardError),
      lower: N.rounded(Math.max(0, windowFit.bValue - z * windowFit.shiBoltStandardError)), upper: N.rounded(windowFit.bValue + z * windowFit.shiBoltStandardError),
    });
  }
  const publicationTable = {
    schema: "agentlas.science-table/v1",
    title: "Gutenberg–Richter recurrence (annual rate and return period by magnitude)",
    columns: [
      { id: "magnitude", label: "Magnitude threshold", type: "number", unit: input.magnitudeType },
      { id: "observedCount", label: "Observed events ≥ M", type: "integer", unit: "count" },
      { id: "annualRate", label: "Annual rate ≥ M", type: "number", unit: "events/year" },
      { id: "returnPeriodYears", label: "Return period", type: "number", unit: "year" },
      { id: "returnPeriodLowerYears", label: `Return period lower (${input.confidenceLevel * 100}% b-band)`, type: "number", unit: "year" },
      { id: "returnPeriodUpperYears", label: `Return period upper (${input.confidenceLevel * 100}% b-band)`, type: "number", unit: "year" },
      { id: "extrapolated", label: "Beyond observed maximum", type: "boolean", unit: null },
    ],
    rows: rateRows.map((row) => [row.magnitude, row.observedCount, row.annualRate, row.returnPeriodYears, row.returnPeriodLowerYears, row.returnPeriodUpperYears, row.extrapolated]),
    notes: [
      `Selected Mc=${selectedMc} (${input.completenessSelection}); b=${N.rounded(fit.bValue, 4)} ± ${N.rounded(fit.shiBoltStandardError, 4)} (Shi & Bolt 1982), a=${N.rounded(fit.aValue, 4)}, N=${complete.length} over ${N.rounded(durationYears, 6)} years.`,
      "Annual rate λ(M)=N(≥Mc)/T·10^(−b(M−Mc)); the band propagates only the b uncertainty and treats the catalog window as the exposure time. Extrapolation beyond the observed maximum is not a hazard estimate.",
    ],
  };
  const completenessTable = {
    schema: "agentlas.science-table/v1",
    title: "Magnitude of completeness candidates",
    columns: [
      { id: "magnitude", label: "Candidate Mc", type: "number", unit: input.magnitudeType },
      { id: "sampleSize", label: "Events ≥ Mc", type: "integer", unit: "count" },
      { id: "bValue", label: "b (Aki MLE)", type: "number", unit: null },
      { id: "shiBoltStandardError", label: "δb (Shi & Bolt)", type: "number", unit: null },
      { id: "goodnessOfFitPercent", label: "Goodness of fit R", type: "number", unit: "percent" },
      { id: "stabilityMeanB", label: "Mean b over stability window", type: "number", unit: null },
      { id: "stable", label: "b-value stability criterion met", type: "boolean", unit: null },
    ],
    rows: candidateRows.map((row) => [row.magnitude, row.sampleSize, N.rounded(row.bValue), N.rounded(row.shiBoltStandardError), N.rounded(row.goodnessOfFitPercent), N.rounded(row.stabilityMeanB), row.stable]),
  };
  const bValueSeriesTable = {
    schema: "agentlas.science-table/v1",
    title: "Sliding-window b-value series",
    columns: [
      { id: "windowIndex", label: "Window", type: "integer", unit: null },
      { id: "startTime", label: "Window start", type: "datetime", unit: null },
      { id: "endTime", label: "Window end", type: "datetime", unit: null },
      { id: "centerTime", label: "Window centre", type: "datetime", unit: null },
      { id: "eventCount", label: "Events", type: "integer", unit: "count" },
      { id: "bValue", label: "b", type: "number", unit: null },
      { id: "shiBoltStandardError", label: "δb", type: "number", unit: null },
      { id: "lower", label: "Lower band", type: "number", unit: null },
      { id: "upper", label: "Upper band", type: "number", unit: null },
    ],
    rows: seriesRows.map((row) => [row.windowIndex, row.startTime, row.endTime, row.centerTime, row.eventCount, row.bValue, row.shiBoltStandardError, row.lower, row.upper]),
  };
  const eventAuditTable = {
    schema: "agentlas.science-table/v1", title: "Seismicity inclusion audit",
    columns: [
      { id: "eventId", label: "USGS event id", type: "string", unit: null }, { id: "time", label: "Origin time", type: "datetime", unit: null },
      { id: "magnitude", label: "Preferred magnitude", type: "number", unit: null }, { id: "magnitudeType", label: "Magnitude type", type: "string", unit: null },
      { id: "included", label: "Same magnitude type", type: "boolean", unit: null }, { id: "exclusionReason", label: "Exclusion reason", type: "string", unit: null },
    ],
    rows: auditRows,
  };
  const vegaLite = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    title: `Sliding-window b-value (${input.windowEvents} events, step ${input.stepEvents}) with ${input.confidenceLevel * 100}% Shi–Bolt band`,
    background: "white", width: 600, height: 340,
    data: { values: seriesRows },
    layer: [
      { mark: { type: "area", opacity: 0.25, color: "#2E6F62" }, encoding: { x: { field: "centerTime", type: "temporal", title: "Window centre (UTC)" }, y: { field: "lower", type: "quantitative", title: "b-value" }, y2: { field: "upper" } } },
      { mark: { type: "line", color: "#2E6F62", strokeWidth: 2, point: true }, encoding: { x: { field: "centerTime", type: "temporal" }, y: { field: "bValue", type: "quantitative", scale: { zero: false } }, tooltip: [{ field: "centerTime", type: "temporal" }, { field: "bValue", type: "quantitative", format: ".3f" }, { field: "shiBoltStandardError", type: "quantitative", format: ".3f" }, { field: "eventCount", type: "quantitative" }] } },
      { mark: { type: "rule", color: "#B85C38", strokeDash: [6, 4] }, encoding: { y: { datum: N.rounded(fit.bValue) } } },
    ],
    config: { axis: { labelFontSize: 11, titleFontSize: 12 }, view: { stroke: "#D8D5D0" } },
  };
  const fmdVegaLite = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    title: "Frequency–magnitude distribution with selected Mc and Aki MLE fit",
    background: "white", width: 600, height: 340,
    data: { values: fmdRows.map((row) => ({ ...row, log10Cumulative: Math.log10(row.cumulativeCount), log10Bin: row.binCount > 0 ? Math.log10(row.binCount) : null, fitted: row.magnitude >= selectedMc - 1e-9 ? fit.aValue - fit.bValue * row.magnitude : null })) },
    layer: [
      { mark: { type: "point", filled: true, color: "#2E6F62", size: 70 }, encoding: { x: { field: "magnitude", type: "quantitative", title: `Magnitude (${input.magnitudeType})` }, y: { field: "log10Cumulative", type: "quantitative", title: "log₁₀ N" }, tooltip: [{ field: "magnitude", type: "quantitative" }, { field: "cumulativeCount", type: "quantitative" }, { field: "binCount", type: "quantitative" }] } },
      { transform: [{ filter: "datum.log10Bin != null" }], mark: { type: "point", color: "#7A7772", size: 50 }, encoding: { x: { field: "magnitude", type: "quantitative" }, y: { field: "log10Bin", type: "quantitative" } } },
      { transform: [{ filter: "datum.fitted != null" }], mark: { type: "line", color: "#B85C38", strokeWidth: 2 }, encoding: { x: { field: "magnitude", type: "quantitative" }, y: { field: "fitted", type: "quantitative" } } },
      { mark: { type: "rule", color: "#5C7080", strokeDash: [4, 4] }, encoding: { x: { datum: selectedMc } } },
    ],
    config: { axis: { labelFontSize: 11, titleFontSize: 12 }, view: { stroke: "#D8D5D0" } },
  };
  const selection = {
    totalEvents: input.catalog.eventCount, sameTypeCount: included.length, completeCount: complete.length, excludedByReason,
    magnitudeType: input.magnitudeType, binWidth: binWidthValue, completenessSelection: input.completenessSelection, selectedCompletenessMagnitude: selectedMc,
    maximumCurvatureCorrection: input.maximumCurvatureCorrection, stabilityWindowBins: input.stabilityWindowBins,
    catalogDurationYears: N.rounded(durationYears), includedEventIdsSha256: N.sha256Json(complete.map((event) => event.id).sort()),
  };
  const estimates = {
    estimator: "Aki (1965) maximum likelihood with Utsu (1966) binning correction Mc − ΔM/2",
    uncertainty: "Shi & Bolt (1982) standard deviation 2.30·b²·sqrt(Σ(Mi−M̄)²/(n(n−1))); Aki b/sqrt(n) reported for comparison",
    sampleSize: fit.sampleSize, meanMagnitude: N.rounded(fit.meanMagnitude), effectiveThreshold: N.rounded(fit.effectiveThreshold),
    bValue: N.rounded(fit.bValue), shiBoltStandardError: N.rounded(fit.shiBoltStandardError), akiStandardError: N.rounded(fit.akiStandardError),
    aValue: N.rounded(fit.aValue), annualAValue: N.rounded(Math.log10(10 ** fit.aValue / durationYears)),
    confidenceLevel: input.confidenceLevel, bConfidenceInterval: { lower: N.rounded(bLower), upper: N.rounded(bUpper) },
    maximumObservedMagnitude: maximumMagnitude,
    bValueSeries: { windowEvents: input.windowEvents, stepEvents: input.stepEvents, windowCount: seriesRows.length, status: seriesRows.length ? "complete" : "insufficient-events-for-one-window" },
  };
  const contentReceipts = {
    publicationTable: C.contentReceipt("seismicity-return-period-table", "application/vnd.agentlas.science-table+json", publicationTable),
    completenessTable: C.contentReceipt("seismicity-completeness-table", "application/vnd.agentlas.science-table+json", completenessTable),
    bValueSeriesTable: C.contentReceipt("seismicity-b-value-series-table", "application/vnd.agentlas.science-table+json", bValueSeriesTable),
    eventAuditTable: C.contentReceipt("seismicity-event-audit", "application/vnd.agentlas.science-table+json", eventAuditTable),
    figure: C.contentReceipt("seismicity-b-value-series-figure", "application/vnd.vegalite.v5+json", vegaLite),
    fmdFigure: C.contentReceipt("seismicity-fmd-figure", "application/vnd.vegalite.v5+json", fmdVegaLite),
  };
  const analysis = {
    schema: "agentlas.earth.seismicity-b-value-analysis/v1",
    methodRevision: "maxc-gft-stability-aki-shibolt/v1",
    source: {
      provider: input.receipt.provider, endpoint: input.receipt.endpoint, requestUrl: input.receipt.requestUrl, requestSha256: input.requestSha256,
      rawResponseSha256: input.rawResponseSha256, rawResponseBytes: input.receipt.rawResponseBytes, normalizedCatalogSha256: input.normalizedSha256,
      timeWindow: { startTime: input.start.iso, endTime: input.end.iso, inclusive: true },
    },
    selection, completenessEstimates, estimates,
    frequencyMagnitudeDistribution: fmdRows,
    publicationTable, completenessTable, bValueSeriesTable, eventAuditTable, vegaLite, fmdVegaLite, contentReceipts,
    assumptions: [
      "Mc candidates are evaluated only on the declared magnitude type; no magnitude-scale conversion or declustering is performed.",
      "Goodness-of-fit uses cumulative counts per bin (Wiemer & Wyss 2000); the stability criterion compares b(Mc) with the mean b over the next stability window against the Shi & Bolt δb.",
      "Return periods assume a stationary Poisson process over the catalog window and propagate only b uncertainty; they are not a probabilistic hazard assessment.",
      "Sliding windows are event-count based, so window durations vary with seismicity rate.",
    ],
    rendererCompatibility: { rendererId: "agentlas.vega", hostRequired: true, bundledRenderer: false, interactive: "tooltip-only" },
  };
  return { ...analysis, analysisSha256: N.sha256Json(analysis) };
}

function normalizeAftershockInput(value) {
  const C = core();
  const input = C.exactObject(value, [
    "catalog", "mainshockTime", "mainshockMagnitude", "observationStartTime", "observationEndTime", "completenessStartTime", "completenessMagnitude",
    "magnitudeType", "rateBinWidthSeconds", "parameterBounds", "forecastHorizonDays", "forecastMagnitudes", "bValue", "binWidth", "backgroundRatePerDay", "bathReferenceDifference",
  ], "earth-aftershock-input");
  const omoriInput = {
    catalog: input.catalog, mainshockTime: input.mainshockTime, observationStartTime: input.observationStartTime, observationEndTime: input.observationEndTime,
    completenessStartTime: input.completenessStartTime, completenessMagnitude: input.completenessMagnitude, magnitudeType: input.magnitudeType,
    rateBinWidthSeconds: input.rateBinWidthSeconds, parameterBounds: input.parameterBounds,
  };
  const normalizedOmori = C.normalizeOmoriUtsuInput(omoriInput);
  const mainshockMagnitude = C.finite(input.mainshockMagnitude, -2, 10, "earth-aftershock-mainshock-magnitude");
  if (mainshockMagnitude < normalizedOmori.completenessMagnitude) throw N.fail("earth-aftershock-mainshock-below-completeness");
  const forecastHorizonDays = C.finite(input.forecastHorizonDays, 0.01, 3_650, "earth-aftershock-forecast-horizon-days");
  if (!Array.isArray(input.forecastMagnitudes) || input.forecastMagnitudes.length < 1 || input.forecastMagnitudes.length > 20) throw N.fail("earth-aftershock-forecast-magnitudes-invalid");
  const forecastMagnitudes = N.sortedCopy(input.forecastMagnitudes.map((item) => C.finite(item, -2, 10, "earth-aftershock-forecast-magnitude")));
  if (new Set(forecastMagnitudes).size !== forecastMagnitudes.length) throw N.fail("earth-aftershock-forecast-magnitudes-duplicate");
  if (forecastMagnitudes[0] < normalizedOmori.completenessMagnitude) throw N.fail("earth-aftershock-forecast-magnitude-below-completeness", "Forecast magnitudes must be at or above Mc; the Gutenberg–Richter scaling is not defined below completeness");
  const explicitB = input.bValue === undefined || input.bValue === null ? null : C.finite(input.bValue, 0.1, 3, "earth-aftershock-b-value");
  const binWidth = input.binWidth === undefined ? 0.1 : C.finite(input.binWidth, 0.01, 1, "earth-aftershock-bin-width");
  if (Math.abs(normalizedOmori.completenessMagnitude / binWidth - Math.round(normalizedOmori.completenessMagnitude / binWidth)) > 1e-8) throw N.fail("earth-aftershock-completeness-bin-alignment-invalid");
  const backgroundRatePerDay = input.backgroundRatePerDay === undefined || input.backgroundRatePerDay === null ? null : C.finite(input.backgroundRatePerDay, 1e-9, 1e6, "earth-aftershock-background-rate");
  const bathReferenceDifference = input.bathReferenceDifference === undefined ? 1.2 : C.finite(input.bathReferenceDifference, 0, 5, "earth-aftershock-bath-reference");
  return { omoriInput, normalizedOmori, mainshockMagnitude, forecastHorizonDays, forecastMagnitudes, explicitB, binWidth, backgroundRatePerDay, bathReferenceDifference };
}

function analyzeAftershockProductivity(value) {
  const C = core();
  const input = normalizeAftershockInput(value);
  const omori = C.analyzeOmoriUtsu(input.omoriInput);
  const includedRows = omori.eventAuditTable.rows.filter((row) => row[4] === true);
  const included = includedRows.map((row) => ({ id: row[0], time: row[1], millis: Date.parse(row[1]), magnitude: row[2] }))
    .sort((left, right) => left.millis - right.millis || left.id.localeCompare(right.id));
  const mainshockMillis = input.normalizedOmori.mainshock.millis;
  const Mc = input.normalizedOmori.completenessMagnitude;
  const warnings = [];
  // Båth's law
  const largest = included.length ? included.reduce((best, event) => (event.magnitude > best.magnitude ? event : best), included[0]) : null;
  const bathDifference = largest ? input.mainshockMagnitude - largest.magnitude : null;
  // b-value of the aftershock sequence (Aki MLE with binning correction) unless supplied explicitly.
  let bSource = "explicit";
  let bValue = input.explicitB;
  let bStandardError = null;
  if (bValue === null) {
    bSource = "aftershock-sequence-aki-mle";
    if (included.length < MIN_AFTERSHOCK_B_SAMPLE) {
      bSource = "unavailable";
      warnings.push(`Fewer than ${MIN_AFTERSHOCK_B_SAMPLE} complete aftershocks: b-value, modified Båth difference, and magnitude-scaled forecasts are not computed.`);
    } else {
      for (const event of included) {
        if (Math.abs(event.magnitude / input.binWidth - Math.round(event.magnitude / input.binWidth)) > 1e-8) throw N.fail("earth-aftershock-magnitude-bin-alignment-invalid", "Included magnitudes must align to the declared bin width", { eventId: event.id });
      }
      const fit = akiB(included.map((event) => event.magnitude), Mc, input.binWidth);
      if (!fit) throw N.fail("earth-aftershock-mle-denominator-invalid");
      bValue = fit.bValue;
      bStandardError = fit.shiBoltStandardError;
    }
  }
  const aValue = bValue === null || !included.length ? null : Math.log10(included.length) + bValue * Mc;
  const modifiedBathInferredMaximum = aValue === null ? null : aValue / bValue;
  const modifiedBathDifference = modifiedBathInferredMaximum === null ? null : input.mainshockMagnitude - modifiedBathInferredMaximum;
  const fit = omori.status === "complete" ? omori.estimates : null;
  if (!fit) warnings.push(`Omori–Utsu fit status is ${omori.status} (${omori.statusReasons.join(", ") || "no reason"}); duration and forecast rows are null.`);
  const observationEndSeconds = (input.normalizedOmori.observationEnd.millis - mainshockMillis) / 1_000;
  const forecastStartSeconds = observationEndSeconds;
  const forecastEndSeconds = forecastStartSeconds + input.forecastHorizonDays * 86_400;
  // Sequence duration: time at which the Omori–Utsu rate falls to the declared background rate.
  let duration = null;
  if (fit && input.backgroundRatePerDay !== null) {
    const backgroundPerSecond = input.backgroundRatePerDay / 86_400;
    const seconds = (fit.k / backgroundPerSecond) ** (1 / fit.p) - fit.cSeconds;
    duration = {
      definition: "t_d = (K/λ_bg)^(1/p) − c, the time since the mainshock when λ(t)=K/(t+c)^p equals the background rate",
      backgroundRatePerDay: input.backgroundRatePerDay, seconds: N.rounded(seconds, 6), days: N.rounded(seconds / 86_400, 9),
      endsWithinObservationWindow: seconds <= observationEndSeconds,
      rateAtObservationEndPerDay: N.rounded(86_400 * fit.k / (observationEndSeconds + fit.cSeconds) ** fit.p),
    };
  } else if (input.backgroundRatePerDay === null) warnings.push("No background rate supplied: sequence duration is not computed.");
  const expectedAboveMc = fit ? fit.k * C.omoriIntegral(fit.p, fit.cSeconds, forecastStartSeconds, forecastEndSeconds) : null;
  const forecastRows = input.forecastMagnitudes.map((magnitude) => {
    const scaled = expectedAboveMc === null || bValue === null ? null : expectedAboveMc * 10 ** (-bValue * (magnitude - Mc));
    return {
      magnitude,
      expectedCount: scaled === null ? null : N.rounded(scaled),
      poissonLower: scaled === null ? null : N.poissonQuantile(0.025, scaled),
      poissonUpper: scaled === null ? null : N.poissonQuantile(0.975, scaled),
      probabilityAtLeastOne: scaled === null ? null : N.rounded(1 - Math.exp(-scaled)),
    };
  });
  // Cumulative observed vs modelled counts for the figure.
  const startSeconds = (input.normalizedOmori.completenessStart.millis - mainshockMillis) / 1_000;
  const curveRows = [];
  const points = 60;
  for (let index = 0; index <= points; index += 1) {
    const t = startSeconds + (forecastEndSeconds - startSeconds) * index / points;
    const observed = t <= observationEndSeconds ? included.filter((event) => (event.millis - mainshockMillis) / 1_000 <= t).length : null;
    const modelled = fit ? (t > startSeconds ? fit.k * C.omoriIntegral(fit.p, fit.cSeconds, startSeconds, t) : 0) : null;
    curveRows.push({ days: N.rounded(t / 86_400, 9), observedCumulative: observed, modelledCumulative: modelled === null ? null : N.rounded(modelled), phase: t <= observationEndSeconds ? "observation" : "forecast" });
  }
  const publicationTable = {
    schema: "agentlas.science-table/v1",
    title: `Expected aftershocks in the next ${input.forecastHorizonDays} days after the observation window`,
    columns: [
      { id: "magnitude", label: "Magnitude ≥", type: "number", unit: input.normalizedOmori.magnitudeType },
      { id: "expectedCount", label: "Expected count", type: "number", unit: "count" },
      { id: "poissonLower", label: "Poisson 2.5% count", type: "integer", unit: "count" },
      { id: "poissonUpper", label: "Poisson 97.5% count", type: "integer", unit: "count" },
      { id: "probabilityAtLeastOne", label: "P(≥1 event)", type: "number", unit: null },
    ],
    rows: forecastRows.map((row) => [row.magnitude, row.expectedCount, row.poissonLower, row.poissonUpper, row.probabilityAtLeastOne]),
    notes: [
      `Forecast window: ${N.rounded(forecastStartSeconds / 86_400, 6)}–${N.rounded(forecastEndSeconds / 86_400, 6)} days after the mainshock; N(≥Mc)=K∫(t+c)^−p dt scaled by 10^(−b(M−Mc)) with b=${bValue === null ? "unavailable" : N.rounded(bValue, 4)} (${bSource}).`,
      "Caveats: parameter uncertainty in p, c, K, and b is not propagated; the Poisson interval reflects only counting variability; secondary aftershock triggering, rate changes, and larger subsequent mainshocks are not modelled.",
    ],
  };
  const productivityTable = {
    schema: "agentlas.science-table/v1", title: "Aftershock productivity summary",
    columns: [{ id: "quantity", label: "Quantity", type: "string", unit: null }, { id: "value", label: "Value", type: "number", unit: null }, { id: "note", label: "Note", type: "string", unit: null }],
    rows: [
      ["Mainshock magnitude (declared)", input.mainshockMagnitude, input.normalizedOmori.magnitudeType],
      ["Largest complete aftershock", largest ? largest.magnitude : null, largest ? largest.id : "none"],
      ["Båth difference ΔM", bathDifference === null ? null : N.rounded(bathDifference), `reference ${input.bathReferenceDifference} (Båth 1965)`],
      ["Modified Båth difference ΔM*", modifiedBathDifference === null ? null : N.rounded(modifiedBathDifference), "Shcherbakov & Turcotte 2004: M*=a/b from the aftershock GR fit"],
      ["Aftershock b-value", bValue === null ? null : N.rounded(bValue), bSource],
      ["Omori p", fit ? fit.p : null, omori.status],
      ["Omori c (s)", fit ? fit.cSeconds : null, omori.status],
      ["Omori K (events·s^(p−1))", fit ? fit.k : null, omori.status],
      ["Sequence duration (days)", duration ? duration.days : null, duration ? "rate falls to declared background" : "background rate not supplied or fit unavailable"],
      ["Expected N(≥Mc) in forecast window", expectedAboveMc === null ? null : N.rounded(expectedAboveMc), `${input.forecastHorizonDays} days`],
    ],
  };
  const vegaLite = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    title: "Cumulative aftershocks ≥ Mc: observed vs Omori–Utsu model, extended into the forecast window",
    background: "white", width: 600, height: 340,
    data: { values: curveRows },
    layer: [
      { transform: [{ filter: "datum.observedCumulative != null" }], mark: { type: "line", color: "#2E6F62", strokeWidth: 2, interpolate: "step-after" }, encoding: { x: { field: "days", type: "quantitative", title: "Days since mainshock" }, y: { field: "observedCumulative", type: "quantitative", title: "Cumulative events ≥ Mc" }, tooltip: [{ field: "days", type: "quantitative", format: ".3f" }, { field: "observedCumulative", type: "quantitative" }] } },
      { transform: [{ filter: "datum.modelledCumulative != null" }], mark: { type: "line", color: "#B85C38", strokeWidth: 2, strokeDash: [6, 3] }, encoding: { x: { field: "days", type: "quantitative" }, y: { field: "modelledCumulative", type: "quantitative" }, tooltip: [{ field: "days", type: "quantitative", format: ".3f" }, { field: "modelledCumulative", type: "quantitative", format: ".2f" }, { field: "phase", type: "nominal" }] } },
      { mark: { type: "rule", color: "#5C7080", strokeDash: [4, 4] }, encoding: { x: { datum: N.rounded(forecastStartSeconds / 86_400, 9) } } },
    ],
    config: { axis: { labelFontSize: 11, titleFontSize: 12 }, view: { stroke: "#D8D5D0" } },
  };
  const contentReceipts = {
    publicationTable: C.contentReceipt("aftershock-forecast-table", "application/vnd.agentlas.science-table+json", publicationTable),
    productivityTable: C.contentReceipt("aftershock-productivity-table", "application/vnd.agentlas.science-table+json", productivityTable),
    figure: C.contentReceipt("aftershock-cumulative-figure", "application/vnd.vegalite.v5+json", vegaLite),
    omoriAnalysis: C.contentReceipt("omori-utsu-analysis", "application/vnd.agentlas.earth.omori-utsu-analysis+json", omori),
  };
  const analysis = {
    schema: "agentlas.earth.aftershock-productivity-analysis/v1",
    methodRevision: "omori-utsu-bath-forecast/v1",
    status: omori.status, statusReasons: omori.statusReasons, warnings,
    source: omori.source,
    selection: { ...omori.selection, mainshockMagnitude: input.mainshockMagnitude, binWidth: input.binWidth },
    omoriUtsu: { analysisSha256: omori.analysisSha256, methodRevision: omori.methodRevision, estimates: omori.estimates, diagnostics: omori.diagnostics },
    bath: {
      reference: input.bathReferenceDifference, largestAftershock: largest ? { id: largest.id, time: largest.time, magnitude: largest.magnitude } : null,
      difference: bathDifference === null ? null : N.rounded(bathDifference),
      differenceMinusReference: bathDifference === null ? null : N.rounded(bathDifference - input.bathReferenceDifference),
      modified: { aValue: aValue === null ? null : N.rounded(aValue), inferredMaximumMagnitude: modifiedBathInferredMaximum === null ? null : N.rounded(modifiedBathInferredMaximum), difference: modifiedBathDifference === null ? null : N.rounded(modifiedBathDifference) },
    },
    bValue: { source: bSource, value: bValue === null ? null : N.rounded(bValue), shiBoltStandardError: bStandardError === null ? null : N.rounded(bStandardError), sampleSize: included.length, binWidth: input.binWidth },
    duration,
    forecast: {
      horizonDays: input.forecastHorizonDays, startSecondsSinceMainshock: N.rounded(forecastStartSeconds, 6), endSecondsSinceMainshock: N.rounded(forecastEndSeconds, 6),
      expectedAboveCompleteness: expectedAboveMc === null ? null : N.rounded(expectedAboveMc), rows: forecastRows,
      caveats: [
        "Point forecast from fitted p, c, K and b without parameter-uncertainty propagation.",
        "Assumes the single Omori–Utsu sequence continues unchanged; secondary sequences and larger events are not modelled.",
        "Not an operational forecast; operational use requires ensemble/ETAS models and validated skill.",
      ],
    },
    cumulativeCurve: curveRows,
    publicationTable, productivityTable, vegaLite, contentReceipts,
    assumptions: [...omori.assumptions, "Mainshock magnitude is researcher-declared and must be on the same magnitude scale as the catalog events."],
    rendererCompatibility: { rendererId: "agentlas.vega", hostRequired: true, bundledRenderer: false, interactive: "tooltip-only" },
  };
  return { ...analysis, analysisSha256: N.sha256Json(analysis) };
}

module.exports = {
  MIN_AFTERSHOCK_B_SAMPLE,
  MIN_B_STABILITY_SAMPLE,
  MIN_WINDOW_EVENTS,
  akiB,
  analyzeAftershockProductivity,
  analyzeSeismicityBValue,
  normalizeAftershockInput,
  normalizeSeismicityInput,
};
