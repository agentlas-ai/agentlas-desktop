"use strict";

/**
 * Box Least Squares transit search (Kovács, Zucker & Mazeh 2002) evaluated exactly at
 * data resolution (no phase binning): for every trial period and duration the in-transit
 * window starts at each observed phase and the box statistic is computed from cumulative
 * weighted sums. Reports the signal residue spectrum, Signal Detection Efficiency, the best
 * box (period, duration, epoch, depth with uncertainty), a secondary-eclipse check at
 * phase 0.5, an odd/even depth comparison, folded observations, and a Vega-Lite figure.
 */

const common = require("./analysis-common.cjs");

const { AstronomyDataError } = common;
const SCHEMA = "agentlas.science.astronomy-transit-search-bls-result/v1";
const TIME_SYSTEMS = ["BJD_TDB", "BJD_UTC", "HJD_UTC", "JD_UTC", "MJD_UTC", "relative-day"];
const VALUE_KINDS = ["flux", "relative-flux"];
const WEIGHTINGS = ["auto", "weighted", "unweighted"];
const EXCLUSION_REASONS = ["user-excluded", "time-missing", "value-missing", "uncertainty-missing-for-weighted-fit"];
const LIMITS = common.deepFreeze({
  minMeasurements: 8,
  maxMeasurements: 5000,
  minPeriodCount: 32,
  maxPeriodCount: 5000,
  minDurationCount: 1,
  maxDurationCount: 50,
  minInTransitPoints: 3,
  maxWorkUnits: 100_000_000,
  maxPeaks: 20,
  maxPeriodRatio: 1e6,
});
const ALGORITHM = common.deepFreeze({
  id: "agentlas.astronomy.box-least-squares",
  version: "1.0.0",
  method: "exact data-resolution Box Least Squares with inverse-variance weights normalized to unit sum; in-transit windows start at every observed phase",
  statistic: "power = s^2 / (r (1 - r)) with r = sum of in-transit weights and s = sum of in-transit weight * (value - weighted mean); only dips (s < 0) are scored",
  signalResidue: "SR(P) = sqrt(max power over durations and epochs at P)",
  signalDetectionEfficiency: "SDE = (SR_max - mean(SR)) / population standard deviation of SR over the period grid",
  depth: "depth = -s / (r (1 - r)); out-of-transit level H = -s / (1 - r); in-transit level L = s / r, both relative to the weighted mean",
  depthUncertainty: "weighted: sqrt((1/r + 1/(1-r)) / sum(1/sigma^2)); unweighted: out-of-transit population scatter * sqrt(1/n_in + 1/n_out)",
  periodGrid: "inclusive linear frequency grid between 1/maximumPeriodDays and 1/minimumPeriodDays",
  durationGrid: "inclusive linear grid in hours; durations with fractional length q >= 0.5 or fewer than minimumInTransitPoints are skipped",
  secondaryEclipse: "same box evaluated at the primary phase + 0.5 with the same duration",
  oddEvenCheck: "in-transit points are split by the parity of the transit number round((t - T0) / P); depths use the common out-of-transit level",
  references: [
    { title: "A box-fitting algorithm in the search for periodic transits", authors: "G. Kovács, S. Zucker and T. Mazeh", journal: "A&A 391, 369 (2002)", doi: "10.1051/0004-6361:20020802" },
    { title: "Transit Least Squares (SDE threshold discussion)", authors: "M. Hippke and R. Heller", journal: "A&A 623, A39 (2019)", doi: "10.1051/0004-6361/201834672" },
  ],
});
const BOUNDARIES = common.deepFreeze([
  "The box model has a flat bottom and vertical ingress/egress; limb darkening, ingress/egress duration, and transit-shape parameters are not modelled.",
  "No detrending or systematics correction is applied; the caller must supply a normalized (flat) light curve.",
  "The SDE is a customary detection heuristic on the finite period grid, not a calibrated false-alarm probability.",
  "Odd/even and secondary-eclipse statistics are diagnostic screens for eclipsing-binary scenarios, not a validation verdict.",
  "Declared time systems are preserved verbatim; no barycentric correction is applied.",
]);

function normalizeInput(input) {
  const code = "astronomy-transit-search-input-invalid";
  common.exactObject(input, [
    "sourceContentSha256", "targetId", "timeSystem", "timeOffsetDays", "valueKind", "valueUnit", "weighting",
    "minimumPeriodDays", "maximumPeriodDays", "periodCount", "minimumDurationHours", "maximumDurationHours", "durationCount",
    "maximumPeaks", "minimumInTransitPoints", "measurements",
  ], code);
  common.requiredOwn(input, [
    "sourceContentSha256", "targetId", "timeSystem", "timeOffsetDays", "valueKind", "valueUnit", "weighting",
    "minimumPeriodDays", "maximumPeriodDays", "periodCount", "minimumDurationHours", "maximumDurationHours", "durationCount", "measurements",
  ], code);
  const sourceContentSha256 = common.sourceHash(input.sourceContentSha256, "astronomy-transit-search-source-hash-invalid");
  const targetId = common.text(input.targetId, "astronomy-transit-search-target-id-invalid", 500);
  const timeSystem = common.enumeration(input.timeSystem, TIME_SYSTEMS, "astronomy-transit-search-time-system-invalid");
  const timeOffsetDays = common.number(input.timeOffsetDays, "astronomy-transit-search-time-offset-invalid", -1e9, 1e9);
  const valueKind = common.enumeration(input.valueKind, VALUE_KINDS, "astronomy-transit-search-value-kind-invalid");
  const valueUnit = common.nullableText(input.valueUnit, "astronomy-transit-search-value-unit-invalid", 80);
  const weighting = common.enumeration(input.weighting, WEIGHTINGS, "astronomy-transit-search-weighting-invalid");
  const minimumPeriodDays = common.number(input.minimumPeriodDays, "astronomy-transit-search-period-range-invalid", 1e-6, 1e6);
  const maximumPeriodDays = common.number(input.maximumPeriodDays, "astronomy-transit-search-period-range-invalid", 1e-6, 1e6);
  if (maximumPeriodDays <= minimumPeriodDays || maximumPeriodDays / minimumPeriodDays > LIMITS.maxPeriodRatio) {
    throw new AstronomyDataError("astronomy-transit-search-period-range-invalid", "maximumPeriodDays must exceed minimumPeriodDays within the allowed ratio");
  }
  const periodCount = common.integer(input.periodCount, "astronomy-transit-search-period-count-invalid", LIMITS.minPeriodCount, LIMITS.maxPeriodCount);
  const minimumDurationHours = common.number(input.minimumDurationHours, "astronomy-transit-search-duration-range-invalid", 1e-4, 1e5);
  const maximumDurationHours = common.number(input.maximumDurationHours, "astronomy-transit-search-duration-range-invalid", 1e-4, 1e5);
  if (maximumDurationHours < minimumDurationHours) throw new AstronomyDataError("astronomy-transit-search-duration-range-invalid", "maximumDurationHours must not be below minimumDurationHours");
  const durationCount = common.integer(input.durationCount, "astronomy-transit-search-duration-count-invalid", LIMITS.minDurationCount, LIMITS.maxDurationCount);
  if (durationCount === 1 && maximumDurationHours !== minimumDurationHours) throw new AstronomyDataError("astronomy-transit-search-duration-count-invalid", "a single duration requires equal minimum and maximum durations");
  const maximumPeaks = common.optional(input.maximumPeaks, 5, (value) => common.integer(value, "astronomy-transit-search-maximum-peaks-invalid", 1, LIMITS.maxPeaks));
  const minimumInTransitPoints = common.optional(input.minimumInTransitPoints, LIMITS.minInTransitPoints, (value) => common.integer(value, "astronomy-transit-search-minimum-in-transit-points-invalid", 2, 1000));
  if (!Array.isArray(input.measurements) || input.measurements.length < LIMITS.minMeasurements || input.measurements.length > LIMITS.maxMeasurements) {
    throw new AstronomyDataError("astronomy-transit-search-measurements-invalid", `measurements must contain ${LIMITS.minMeasurements} through ${LIMITS.maxMeasurements} rows`);
  }
  const measurements = input.measurements.map((row, rowIndex) => {
    common.exactObject(row, ["observationId", "time", "value", "standardError", "use"], "astronomy-transit-search-measurement-invalid");
    common.requiredOwn(row, ["observationId", "time", "value", "standardError", "use"], "astronomy-transit-search-measurement-invalid");
    return {
      observationId: common.text(row.observationId, `astronomy-transit-search-row-${rowIndex}-observation-id-invalid`, 160),
      time: common.nullableNumber(row.time, `astronomy-transit-search-row-${rowIndex}-time-invalid`, -1e9, 1e9),
      value: common.nullableNumber(row.value, `astronomy-transit-search-row-${rowIndex}-value-invalid`, -1e15, 1e15),
      standardError: common.nullableNumber(row.standardError, `astronomy-transit-search-row-${rowIndex}-standard-error-invalid`, 1e-12, 1e15, { minimumExclusive: true }),
      use: common.boolean(row.use, `astronomy-transit-search-row-${rowIndex}-use-invalid`),
    };
  }).sort((left, right) => {
    if (left.time === null && right.time !== null) return 1;
    if (left.time !== null && right.time === null) return -1;
    if (left.time !== null && right.time !== null && left.time !== right.time) return left.time - right.time;
    return common.compareText(left.observationId, right.observationId);
  });
  common.uniqueIds(measurements, "observationId", "astronomy-transit-search-duplicate-observation-id");
  return {
    sourceContentSha256, targetId, timeSystem, timeOffsetDays, valueKind, valueUnit, weighting,
    minimumPeriodDays, maximumPeriodDays, periodCount, minimumDurationHours, maximumDurationHours, durationCount,
    maximumPeaks, minimumInTransitPoints, measurements,
  };
}

function lowerBound(array, value, from, to) {
  let low = from;
  let high = to;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (array[mid] < value) low = mid + 1; else high = mid;
  }
  return low;
}

/** Evaluates the box statistic for one phase window [start, start + q) using doubled cumulative sums. */
function boxAt(sorted, start, q) {
  const { phases, cumulativeWeight, cumulativeWeightedValue, count } = sorted;
  const from = lowerBound(phases, start, 0, count);
  const to = lowerBound(phases, start + q, from, 2 * count);
  const r = cumulativeWeight[to] - cumulativeWeight[from];
  const s = cumulativeWeightedValue[to] - cumulativeWeightedValue[from];
  return { r, s, inTransitCount: to - from };
}

function sortedPhaseArrays(points, period, timeOrigin) {
  const count = points.length;
  const order = points.map((point, index) => ({ phase: common.unitPhase((point.time - timeOrigin) / period), index }))
    .sort((left, right) => left.phase - right.phase || left.index - right.index);
  const phases = new Float64Array(2 * count);
  const cumulativeWeight = new Float64Array(2 * count + 1);
  const cumulativeWeightedValue = new Float64Array(2 * count + 1);
  for (let k = 0; k < count; k += 1) {
    const point = points[order[k].index];
    phases[k] = order[k].phase;
    phases[k + count] = order[k].phase + 1;
    cumulativeWeight[k + 1] = cumulativeWeight[k] + point.weight;
    cumulativeWeightedValue[k + 1] = cumulativeWeightedValue[k] + point.weight * point.centered;
  }
  for (let k = count; k < 2 * count; k += 1) {
    const point = points[order[k - count].index];
    cumulativeWeight[k + 1] = cumulativeWeight[k] + point.weight;
    cumulativeWeightedValue[k + 1] = cumulativeWeightedValue[k] + point.weight * point.centered;
  }
  return { phases, cumulativeWeight, cumulativeWeightedValue, count, order };
}

function searchLightCurveTransitsBls(input) {
  const normalized = normalizeInput(input);
  const initialRows = normalized.measurements.map((measurement) => {
    const exclusionReasons = [];
    if (!measurement.use) exclusionReasons.push("user-excluded");
    if (measurement.time === null) exclusionReasons.push("time-missing");
    if (measurement.value === null) exclusionReasons.push("value-missing");
    return { measurement, exclusionReasons };
  });
  const complete = initialRows.filter((row) => row.exclusionReasons.length === 0);
  const allHaveErrors = complete.length > 0 && complete.every((row) => row.measurement.standardError !== null);
  const resolvedWeighting = normalized.weighting === "auto" ? (allHaveErrors ? "weighted" : "unweighted") : normalized.weighting;
  if (resolvedWeighting === "weighted") {
    for (const row of initialRows) if (row.exclusionReasons.length === 0 && row.measurement.standardError === null) row.exclusionReasons.push("uncertainty-missing-for-weighted-fit");
  }
  const eligible = initialRows.filter((row) => row.exclusionReasons.length === 0);
  if (eligible.length < LIMITS.minMeasurements) throw new AstronomyDataError("astronomy-transit-search-insufficient-eligible-observations", `At least ${LIMITS.minMeasurements} analysis-eligible observations are required`, { eligible: eligible.length });
  const times = eligible.map((row) => row.measurement.time);
  const timeOrigin = Math.min(...times);
  const baselineDays = Math.max(...times) - timeOrigin;
  if (!(baselineDays > 0)) throw new AstronomyDataError("astronomy-transit-search-baseline-invalid");
  const weighted = resolvedWeighting === "weighted";
  const absoluteWeightSum = weighted ? eligible.reduce((sum, row) => sum + 1 / row.measurement.standardError ** 2, 0) : null;
  const points = eligible.map((row) => ({
    observationId: row.measurement.observationId,
    time: row.measurement.time,
    value: row.measurement.value,
    standardError: row.measurement.standardError,
    weight: weighted ? (1 / row.measurement.standardError ** 2) / absoluteWeightSum : 1 / eligible.length,
    centered: 0,
  }));
  const weightedMean = points.reduce((sum, point) => sum + point.weight * point.value, 0);
  for (const point of points) point.centered = point.value - weightedMean;
  const totalVariance = points.reduce((sum, point) => sum + point.weight * point.centered ** 2, 0);
  if (!(totalVariance > 0)) throw new AstronomyDataError("astronomy-transit-search-constant-series", "The analysis-eligible series has no resolvable variance");

  const warnings = [];
  if (normalized.weighting === "auto" && !weighted) warnings.push("auto-weighting-fell-back-to-unweighted-missing-uncertainties");
  if (normalized.maximumPeriodDays > baselineDays / 2) warnings.push("maximum-period-exceeds-half-baseline-fewer-than-two-transits-possible");
  const minimumFrequency = 1 / normalized.maximumPeriodDays;
  const maximumFrequency = 1 / normalized.minimumPeriodDays;
  const frequencyStep = (maximumFrequency - minimumFrequency) / (normalized.periodCount - 1);
  const durationsHours = Array.from({ length: normalized.durationCount }, (_, index) => (normalized.durationCount === 1
    ? normalized.minimumDurationHours
    : normalized.minimumDurationHours + (normalized.maximumDurationHours - normalized.minimumDurationHours) * index / (normalized.durationCount - 1)));
  const workUnits = normalized.periodCount * normalized.durationCount * points.length;
  if (workUnits > LIMITS.maxWorkUnits) {
    throw new AstronomyDataError("astronomy-transit-search-budget-exceeded", `periodCount * durationCount * eligibleRows = ${workUnits} exceeds ${LIMITS.maxWorkUnits}; reduce the grids`, { workUnits, maximumWorkUnits: LIMITS.maxWorkUnits });
  }

  const spectrum = [];
  let skippedDurationCombinations = 0;
  for (let gridIndex = 0; gridIndex < normalized.periodCount; gridIndex += 1) {
    const frequency = gridIndex === normalized.periodCount - 1 ? maximumFrequency : minimumFrequency + gridIndex * frequencyStep;
    const period = 1 / frequency;
    const sorted = sortedPhaseArrays(points, period, timeOrigin);
    let best = null;
    for (const durationHours of durationsHours) {
      const q = durationHours / 24 / period;
      if (q >= 0.5) { skippedDurationCombinations += 1; continue; }
      let evaluated = false;
      for (let k = 0; k < sorted.count; k += 1) {
        const start = sorted.phases[k];
        const to = lowerBound(sorted.phases, start + q, k, 2 * sorted.count);
        const inTransitCount = to - k;
        if (inTransitCount < normalized.minimumInTransitPoints) continue;
        const r = sorted.cumulativeWeight[to] - sorted.cumulativeWeight[k];
        const s = sorted.cumulativeWeightedValue[to] - sorted.cumulativeWeightedValue[k];
        if (!(r > 0) || !(r < 1) || !(s < 0)) continue;
        evaluated = true;
        const power = (s * s) / (r * (1 - r));
        if (best === null || power > best.power) best = { power, r, s, q, durationHours, startPhase: start, inTransitCount };
      }
      if (!evaluated) skippedDurationCombinations += 1;
    }
    spectrum.push({
      gridIndex,
      frequencyPerDay: frequency,
      periodDays: period,
      power: best ? best.power : null,
      signalResidue: best ? Math.sqrt(best.power) : null,
      durationHours: best ? best.durationHours : null,
      epochPhase: best ? common.unitPhase(best.startPhase + best.q / 2) : null,
      depth: best ? -best.s / (best.r * (1 - best.r)) : null,
      inTransitCount: best ? best.inTransitCount : null,
      inTransitWeight: best ? best.r : null,
    });
  }
  const valid = spectrum.filter((row) => row.power !== null);
  if (!valid.length) throw new AstronomyDataError("astronomy-transit-search-no-valid-box", "No trial period admitted a box with enough in-transit points and a dip");
  if (skippedDurationCombinations > 0) warnings.push("some-period-duration-combinations-skipped-fractional-duration-or-point-count");
  const residues = valid.map((row) => row.signalResidue);
  const meanResidue = common.mean(residues);
  const residueScatter = Math.sqrt(residues.reduce((sum, value) => sum + (value - meanResidue) ** 2, 0) / residues.length);
  const localMaxima = valid.filter((row) => {
    const left = row.gridIndex === 0 ? null : spectrum[row.gridIndex - 1].power;
    const right = row.gridIndex === spectrum.length - 1 ? null : spectrum[row.gridIndex + 1].power;
    return (left === null || row.power >= left) && (right === null || row.power >= right);
  });
  const ranked = (localMaxima.length ? localMaxima : valid).sort((left, right) => right.power - left.power || left.gridIndex - right.gridIndex).slice(0, normalized.maximumPeaks);
  const bestRow = ranked[0];
  const bestPeriod = bestRow.periodDays;
  const sde = residueScatter > 0 ? (bestRow.signalResidue - meanResidue) / residueScatter : null;
  if (sde !== null && sde < 7) warnings.push("sde-below-customary-detection-threshold-7");

  // Best-box characterization.
  const sorted = sortedPhaseArrays(points, bestPeriod, timeOrigin);
  const q = bestRow.durationHours / 24 / bestPeriod;
  const primaryStart = common.unitPhase(bestRow.epochPhase - q / 2);
  const primary = boxAt(sorted, primaryStart, q);
  const r = primary.r;
  const s = primary.s;
  const depth = -s / (r * (1 - r));
  const outOfTransitLevel = weightedMean - s / (1 - r);
  const inTransitLevel = weightedMean + s / r;
  const epochTime = timeOrigin + bestPeriod * bestRow.epochPhase;
  const centredPhase = (time) => common.unitPhase((time - epochTime) / bestPeriod + 0.5) - 0.5;
  const inTransit = (time) => Math.abs(centredPhase(time)) < q / 2;
  const outPoints = points.filter((point) => !inTransit(point.time));
  const inPoints = points.filter((point) => inTransit(point.time));
  const outScatter = outPoints.length > 1 ? Math.sqrt(outPoints.reduce((sum, point) => sum + (point.value - outOfTransitLevel) ** 2, 0) / outPoints.length) : null;
  const depthSigma = weighted
    ? Math.sqrt((1 / r + 1 / (1 - r)) / absoluteWeightSum)
    : (outScatter === null || !inPoints.length ? null : outScatter * Math.sqrt(1 / inPoints.length + 1 / outPoints.length));
  const deltaChiSquare = weighted ? absoluteWeightSum * bestRow.power : null;
  const secondaryBox = boxAt(sorted, common.unitPhase(primaryStart + 0.5), q);
  const secondary = secondaryBox.inTransitCount >= normalized.minimumInTransitPoints && secondaryBox.r > 0 && secondaryBox.r < 1 ? (() => {
    const depth2 = -secondaryBox.s / (secondaryBox.r * (1 - secondaryBox.r));
    const sigma2 = weighted
      ? Math.sqrt((1 / secondaryBox.r + 1 / (1 - secondaryBox.r)) / absoluteWeightSum)
      : (outScatter === null ? null : outScatter * Math.sqrt(1 / secondaryBox.inTransitCount + 1 / Math.max(1, points.length - secondaryBox.inTransitCount)));
    return {
      phase: 0.5, inTransitCount: secondaryBox.inTransitCount, depth: depth2, depthStandardError: sigma2,
      signalToNoise: sigma2 === null || sigma2 === 0 ? null : depth2 / sigma2,
      flag: sigma2 !== null && sigma2 > 0 && depth2 / sigma2 >= 3 ? "secondary-dip-at-3-sigma-screen" : "no-significant-secondary-dip",
    };
  })() : { phase: 0.5, inTransitCount: secondaryBox.inTransitCount, depth: null, depthStandardError: null, signalToNoise: null, flag: "insufficient-points-at-secondary-phase" };
  if (secondary.flag === "secondary-dip-at-3-sigma-screen") warnings.push("secondary-eclipse-screen-flagged-review-eclipsing-binary-scenario");

  const parityDepth = (parity) => {
    const subset = inPoints.filter((point) => (Math.abs(Math.round((point.time - epochTime) / bestPeriod)) % 2) === parity);
    if (!subset.length) return { count: 0, depth: null, depthStandardError: null };
    const weightSum = subset.reduce((sum, point) => sum + point.weight, 0);
    const level = subset.reduce((sum, point) => sum + point.weight * point.value, 0) / weightSum;
    const sigma = weighted
      ? Math.sqrt(1 / (weightSum * absoluteWeightSum) + 1 / ((1 - r) * absoluteWeightSum))
      : (outScatter === null ? null : outScatter * Math.sqrt(1 / subset.length + 1 / Math.max(1, outPoints.length)));
    return { count: subset.length, depth: outOfTransitLevel - level, depthStandardError: sigma };
  };
  const even = parityDepth(0);
  const odd = parityDepth(1);
  const oddEven = {
    even, odd,
    depthDifference: even.depth === null || odd.depth === null ? null : odd.depth - even.depth,
    differenceSignificance: even.depthStandardError === null || odd.depthStandardError === null || even.depth === null || odd.depth === null
      ? null : Math.abs(odd.depth - even.depth) / Math.sqrt(even.depthStandardError ** 2 + odd.depthStandardError ** 2),
  };
  if (oddEven.differenceSignificance !== null && oddEven.differenceSignificance >= 3) warnings.push("odd-even-depth-difference-at-3-sigma-screen");

  const folded = initialRows.map(({ measurement, exclusionReasons }) => {
    const eligibleRow = exclusionReasons.length === 0;
    const phase = eligibleRow ? centredPhase(measurement.time) : null;
    const inside = eligibleRow ? Math.abs(phase) < q / 2 : null;
    const model = eligibleRow ? (inside ? inTransitLevel : outOfTransitLevel) : null;
    return {
      observationId: measurement.observationId, time: measurement.time, value: measurement.value, standardError: measurement.standardError,
      analysisEligible: eligibleRow, exclusionReasons, phase, inTransit: inside,
      transitNumber: eligibleRow ? Math.round((measurement.time - epochTime) / bestPeriod) : null,
      model, residual: eligibleRow ? measurement.value - model : null,
    };
  });
  const boxCurve = [
    { phase: -0.5, model: outOfTransitLevel }, { phase: -q / 2, model: outOfTransitLevel }, { phase: -q / 2, model: inTransitLevel },
    { phase: q / 2, model: inTransitLevel }, { phase: q / 2, model: outOfTransitLevel }, { phase: 0.5, model: outOfTransitLevel },
  ].map((row, order) => ({ ...row, order }));

  const candidates = ranked.map((row, index) => ({
    rank: index + 1,
    gridIndex: row.gridIndex,
    periodDays: row.periodDays,
    frequencyPerDay: row.frequencyPerDay,
    durationHours: row.durationHours,
    epochPhase: row.epochPhase,
    epochTime: timeOrigin + row.periodDays * row.epochPhase,
    epochAbsoluteTime: timeOrigin + row.periodDays * row.epochPhase + normalized.timeOffsetDays,
    depth: row.depth,
    depthStandardError: index === 0 ? depthSigma : null,
    depthSignalToNoise: index === 0 && depthSigma ? depth / depthSigma : null,
    power: row.power,
    signalResidue: row.signalResidue,
    signalDetectionEfficiency: index === 0 ? sde : null,
    inTransitCount: row.inTransitCount,
    inTransitWeight: row.inTransitWeight,
    deltaChiSquare: index === 0 ? deltaChiSquare : null,
    residualSumReductionFraction: row.power / totalVariance,
  }));
  const bestBox = {
    periodDays: bestPeriod,
    frequencyPerDay: bestRow.frequencyPerDay,
    durationHours: bestRow.durationHours,
    fractionalDuration: q,
    epochPhase: bestRow.epochPhase,
    epochTime,
    epochAbsoluteTime: epochTime + normalized.timeOffsetDays,
    depth,
    depthStandardError: depthSigma,
    depthSignalToNoise: depthSigma ? depth / depthSigma : null,
    outOfTransitLevel,
    inTransitLevel,
    inTransitCount: primary.inTransitCount,
    inTransitWeight: r,
    power: bestRow.power,
    signalResidue: bestRow.signalResidue,
    signalDetectionEfficiency: sde,
    deltaChiSquare,
    residualSumReductionFraction: bestRow.power / totalVariance,
    outOfTransitScatter: outScatter,
    transitsCovered: new Set(inPoints.map((point) => Math.round((point.time - epochTime) / bestPeriod))).size,
  };
  const settings = {
    targetId: normalized.targetId, timeSystem: normalized.timeSystem, timeOffsetDays: normalized.timeOffsetDays,
    valueKind: normalized.valueKind, valueUnit: normalized.valueUnit, requestedWeighting: normalized.weighting, resolvedWeighting,
    minimumPeriodDays: normalized.minimumPeriodDays, maximumPeriodDays: normalized.maximumPeriodDays, periodCount: normalized.periodCount,
    minimumFrequencyPerDay: minimumFrequency, maximumFrequencyPerDay: maximumFrequency, frequencyStepPerDay: frequencyStep,
    durationsHours, minimumInTransitPoints: normalized.minimumInTransitPoints, maximumPeaks: normalized.maximumPeaks, timeOrigin,
  };
  const summary = {
    inputRows: initialRows.length,
    analysisEligibleRows: points.length,
    excludedRows: initialRows.length - points.length,
    exclusionCounts: Object.fromEntries(EXCLUSION_REASONS.map((reason) => [reason, initialRows.filter((row) => row.exclusionReasons.includes(reason)).length])),
    baselineDays,
    weightedMean,
    validPeriodCount: valid.length,
    skippedDurationCombinations,
    localPeakCount: localMaxima.length,
    meanSignalResidue: meanResidue,
    signalResidueScatter: residueScatter,
    bestPeriodDays: bestPeriod,
    bestDurationHours: bestRow.durationHours,
    bestDepth: depth,
    bestDepthStandardError: depthSigma,
    signalDetectionEfficiency: sde,
    secondaryEclipseFlag: secondary.flag,
    weighted,
  };
  const table = common.publicationTable(`${normalized.targetId}: Box Least Squares transit candidates`, [
    { key: "rank", label: "Rank", unit: null, datatype: "integer" },
    { key: "periodDays", label: "Period", unit: "day", datatype: "number" },
    { key: "durationHours", label: "Duration", unit: "hour", datatype: "number" },
    { key: "epochAbsoluteTime", label: `Mid-transit epoch (${normalized.timeSystem})`, unit: "day", datatype: "number" },
    { key: "depth", label: "Depth", unit: normalized.valueUnit, datatype: "number" },
    { key: "depthStandardError", label: "Depth s.e.", unit: normalized.valueUnit, datatype: "number|null" },
    { key: "depthSignalToNoise", label: "Depth S/N", unit: null, datatype: "number|null" },
    { key: "signalResidue", label: "Signal residue", unit: null, datatype: "number" },
    { key: "signalDetectionEfficiency", label: "SDE", unit: null, datatype: "number|null" },
    { key: "inTransitCount", label: "In-transit points", unit: null, datatype: "integer" },
    { key: "deltaChiSquare", label: "Δχ² vs constant", unit: null, datatype: "number|null" },
  ], candidates, [
    "Candidates are local maxima of the BLS spectrum on the declared finite grids; SDE, depth uncertainty, and Δχ² are reported for the strongest candidate only.",
    `Secondary-eclipse screen at phase 0.5: ${secondary.flag}; odd/even depth difference significance: ${oddEven.differenceSignificance === null ? "not computed" : oddEven.differenceSignificance.toPrecision(4)} σ.`,
    "Depth is measured relative to the box out-of-transit level in the declared value unit.",
  ]);
  const valueTitle = normalized.valueUnit ? `Value (${normalized.valueUnit})` : "Value";
  // The transit is a fraction of a percent of the flux. On a zero-anchored axis it is a smudge
  // on a flat line -- the detection stops being visible in the figure that reports it.
  const foldedScale = common.measurementScale(normalized.valueKind);
  const buildFigure = (provenance) => common.publicationFigure(
    `${normalized.targetId}: BLS spectrum and folded transit`,
    `Two-panel figure. Upper panel: BLS signal residue over ${valid.length} trial periods with the best period ${bestPeriod} days marked (SDE ${sde === null ? "not computed" : sde.toPrecision(4)}). Lower panel: ${points.length} observations folded on the best period, centred on mid-transit, with the fitted box model.`,
    {
      $schema: common.VEGA_LITE_SCHEMA_URL,
      description: "Box Least Squares spectrum and best-candidate folded transit.",
      vconcat: [
        {
          width: 720, height: 240,
          layer: [
            { data: { values: valid.map((row) => ({ periodDays: row.periodDays, signalResidue: row.signalResidue })) },
              mark: { type: "line", color: "#255C99", strokeWidth: 1.5, clip: true },
              encoding: { x: { field: "periodDays", type: "quantitative", title: "Trial period (day)", scale: { type: "log" } }, y: { field: "signalResidue", type: "quantitative", title: "BLS signal residue" } } },
            { data: { values: [{ periodDays: bestPeriod }] }, mark: { type: "rule", color: "#C2415D", strokeWidth: 1.5 },
              encoding: { x: { field: "periodDays", type: "quantitative", scale: { type: "log" } } } },
          ],
        },
        {
          width: 720, height: 260,
          layer: [
            { data: { values: folded.filter((row) => row.analysisEligible && row.standardError !== null).map((row) => ({ phase: row.phase, lower: row.value - row.standardError, upper: row.value + row.standardError })) },
              mark: { type: "rule", color: "#9CA3AF", strokeWidth: 1 },
              encoding: { x: { field: "phase", type: "quantitative", title: `Phase from mid-transit (P = ${bestPeriod.toPrecision(8)} day)`, scale: { domain: [-0.5, 0.5] } }, y: { field: "lower", type: "quantitative", title: valueTitle, scale: foldedScale }, y2: { field: "upper" } } },
            { data: { values: folded.filter((row) => row.analysisEligible).map((row) => ({ observationId: row.observationId, phase: row.phase, value: row.value, inTransit: row.inTransit })) },
              mark: { type: "point", filled: true, size: 40, stroke: "#FFFFFF", strokeWidth: 0.6 },
              encoding: { x: { field: "phase", type: "quantitative", scale: { domain: [-0.5, 0.5] } }, y: { field: "value", type: "quantitative", title: valueTitle, scale: foldedScale },
                color: { field: "inTransit", type: "nominal", title: "In transit", scale: { domain: [false, true], range: ["#255C99", "#C2415D"] } },
                tooltip: [{ field: "observationId", type: "nominal", title: "Observation" }, { field: "phase", type: "quantitative", title: "Phase", format: ".5f" }, { field: "value", type: "quantitative", title: "Value", format: ".6g" }] } },
            { data: { values: boxCurve }, mark: { type: "line", color: "#111827", strokeWidth: 1.8 },
              encoding: { x: { field: "phase", type: "quantitative", scale: { domain: [-0.5, 0.5] } }, y: { field: "model", type: "quantitative", scale: foldedScale }, order: { field: "order", type: "quantitative" } } },
          ],
        },
      ],
      spacing: 22,
    },
    provenance,
  );
  return common.finalizeAnalysis({
    schema: SCHEMA,
    algorithm: ALGORITHM,
    normalizedInput: normalized,
    sourceContentSha256: normalized.sourceContentSha256,
    sections: {
      settings, summary, warnings, boundaries: BOUNDARIES,
      spectrum, candidates, bestBox, secondaryEclipse: secondary, oddEven, folded, boxCurve,
    },
    table,
    buildFigure,
  });
}

module.exports = {
  TRANSIT_SEARCH_ALGORITHM: ALGORITHM,
  TRANSIT_SEARCH_BOUNDARIES: BOUNDARIES,
  TRANSIT_SEARCH_LIMITS: LIMITS,
  TRANSIT_SEARCH_SCHEMA: SCHEMA,
  searchLightCurveTransitsBls,
};
