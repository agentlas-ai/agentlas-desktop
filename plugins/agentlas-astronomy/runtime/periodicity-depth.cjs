"use strict";

/**
 * Light-curve periodicity depth: generalized Lomb–Scargle with Baluev (2008) analytic
 * false-alarm probability, seeded permutation-bootstrap FAP, peak-width / analytic /
 * residual-bootstrap period uncertainties, daily and sidereal alias screening, and a
 * fixed two-harmonic refinement of the strongest period.
 *
 * The GLS grid itself is delegated to `analyzeLightCurvePeriodicity` (astronomy.cjs) so
 * the depth analysis can never disagree with the bounded periodogram it extends.
 */

const { analyzeLightCurvePeriodicity } = require("./astronomy.cjs");
const common = require("./analysis-common.cjs");

const { AstronomyDataError } = common;
const SCHEMA = "agentlas.science.astronomy-light-curve-periodicity-depth-result/v1";
const SIDEREAL_DAY_DAYS = 0.99726956633;
const LIMITS = common.deepFreeze({
  minBootstrapSamples: 0,
  maxBootstrapSamples: 1000,
  maxBootstrapWorkUnits: 150_000_000,
  localGridPoints: 201,
  minFalseAlarmLevel: 1e-12,
  maxFalseAlarmLevel: 0.5,
  maxAliasPeriods: 6,
});
const ALGORITHM = common.deepFreeze({
  id: "agentlas.astronomy.light-curve-periodicity-depth",
  version: "1.0.0",
  periodogram: "weighted floating-mean generalized Lomb-Scargle from agentlas.astronomy.generalized-lomb-scargle@1.0.0 (standard normalization, z in [0,1])",
  analyticFalseAlarm: "Baluev (2008) upper bound for the floating-mean periodogram: FAP = 1 - (1 - (1-z)^((N-3)/2)) * exp(-tau), tau = Gamma((N-1)/2)/Gamma((N-3)/2) * W * (1-z)^((N-4)/2) * sqrt((N-1) z / 2), W = f_max * sqrt(4 pi Var_w(t))",
  bootstrapFalseAlarm: "seeded permutation bootstrap: (value, standardError) pairs are shuffled across the fixed observation times, the maximum GLS power over the identical frequency grid is recorded, FAP = exceedances / samples",
  randomNumberGenerator: "mulberry32(seed); Fisher-Yates shuffle from the last index down; resampling indices floor(u * n)",
  peakRefinement: "201-point linear local grid spanning one coarse frequency step on each side of the strongest grid peak, then a parabola through the three highest local-grid samples",
  peakWidthUncertainty: "half width at half maximum of the local GLS peak in frequency; sigma_P = P^2 * HWHM_f",
  analyticFrequencyUncertainty: "Montgomery & O'Donoghue (1999): sigma_f = sqrt(6/N) * sigma_residual / (pi * T * A)",
  bootstrapPeriodUncertainty: "seeded residual bootstrap around the two-harmonic model at the refined frequency; each replicate refits the strongest local-grid frequency",
  aliasScreen: "for every alias period P_a the frequencies f_best +/- k/P_a (k = 1, 2) are mapped to the nearest coarse grid sample; the sampling-window power at 1/P_a is reported",
  multiTermRefinement: "weighted least squares of y = c0 + a1 cos(wt) + b1 sin(wt) + a2 cos(2wt) + b2 sin(2wt) at the refined frequency",
  references: [
    { title: "Assessing the statistical significance of periodogram peaks", authors: "R. V. Baluev", journal: "MNRAS 385, 1279 (2008)", doi: "10.1111/j.1365-2966.2008.12689.x" },
    { title: "The generalised Lomb-Scargle periodogram", authors: "M. Zechmeister and M. Kuerster", journal: "A&A 496, 577 (2009)", doi: "10.1051/0004-6361:200811296" },
    { title: "A method for the direct determination of the surface gravities of pulsating white dwarfs (frequency error appendix)", authors: "M. H. Montgomery and D. O'Donoghue", journal: "Delta Scuti Star Newsletter 13, 28 (1999)" },
    { title: "Understanding the Lomb-Scargle periodogram", authors: "J. T. VanderPlas", journal: "ApJS 236, 16 (2018)", doi: "10.3847/1538-4365/aab766" },
  ],
});
const BOUNDARIES = common.deepFreeze([
  "The Baluev false-alarm probability assumes independent Gaussian white noise, correctly scaled uncertainties, and a single-sinusoid alternative; correlated (red) noise makes it optimistic.",
  "The bootstrap false-alarm probability permutes values across the fixed sampling; it preserves the window function but not any intrinsic time correlation.",
  "Period uncertainties describe the local peak only. They do not account for alias ambiguity, which must be resolved with the alias screen and independent data.",
  "No detrending, red-noise model, barycentric or heliocentric time correction, transit model, or more than two harmonics is applied.",
  "Declared time systems are preserved verbatim; BJD, HJD, JD, MJD, UTC, and TDB are never converted.",
]);

function normalizeInput(input) {
  common.exactObject(input, [
    "sourceContentSha256", "targetId", "timeSystem", "timeOffsetDays", "valueKind", "valueUnit", "weighting",
    "minimumPeriodDays", "maximumPeriodDays", "frequencyCount", "maximumPeaks", "measurements",
    "bootstrapSamples", "bootstrapSeed", "aliasPeriodsDays", "falseAlarmLevels",
  ], "astronomy-periodicity-depth-input-invalid");
  const baseKeys = [
    "sourceContentSha256", "targetId", "timeSystem", "timeOffsetDays", "valueKind", "valueUnit", "weighting",
    "minimumPeriodDays", "maximumPeriodDays", "frequencyCount", "maximumPeaks", "measurements",
  ];
  const base = {};
  for (const key of baseKeys) if (Object.hasOwn(input, key)) base[key] = input[key];
  const bootstrapSamples = common.optional(input.bootstrapSamples, 200, (value) => common.integer(value, "astronomy-periodicity-depth-bootstrap-samples-invalid", LIMITS.minBootstrapSamples, LIMITS.maxBootstrapSamples));
  const bootstrapSeed = common.optional(input.bootstrapSeed, 20240901, (value) => common.integer(value, "astronomy-periodicity-depth-bootstrap-seed-invalid", 0, 4294967295));
  const aliasPeriodsDays = common.optional(input.aliasPeriodsDays, [1, SIDEREAL_DAY_DAYS], (value) => {
    if (!Array.isArray(value) || value.length < 1 || value.length > LIMITS.maxAliasPeriods) throw new AstronomyDataError("astronomy-periodicity-depth-alias-periods-invalid");
    const periods = value.map((entry) => common.number(entry, "astronomy-periodicity-depth-alias-periods-invalid", 1e-6, 1e9));
    if (new Set(periods).size !== periods.length) throw new AstronomyDataError("astronomy-periodicity-depth-alias-periods-invalid", "alias periods must be unique");
    return periods;
  });
  const falseAlarmLevels = common.optional(input.falseAlarmLevels, [0.1, 0.01, 0.001], (value) => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 6) throw new AstronomyDataError("astronomy-periodicity-depth-false-alarm-levels-invalid");
    const levels = value.map((entry) => common.number(entry, "astronomy-periodicity-depth-false-alarm-levels-invalid", LIMITS.minFalseAlarmLevel, LIMITS.maxFalseAlarmLevel));
    if (new Set(levels).size !== levels.length) throw new AstronomyDataError("astronomy-periodicity-depth-false-alarm-levels-invalid", "false-alarm levels must be unique");
    return [...levels].sort((left, right) => right - left);
  });
  return { base, bootstrapSamples, bootstrapSeed, aliasPeriodsDays, falseAlarmLevels };
}

/** Standard-normalized GLS power at one frequency for points {time, value, weight} (weights sum to 1). */
function glsFit(points, frequencyPerDay, timeOrigin, constantResidualSum) {
  const omega = 2 * Math.PI * frequencyPerDay;
  let s1 = 0; let sc = 0; let ss = 0; let scc = 0; let sss = 0; let scs = 0;
  let sy = 0; let scy = 0; let ssy = 0;
  for (const point of points) {
    const angle = omega * (point.time - timeOrigin);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const w = point.weight;
    s1 += w; sc += w * c; ss += w * s; scc += w * c * c; sss += w * s * s; scs += w * c * s;
    sy += w * point.value; scy += w * c * point.value; ssy += w * s * point.value;
  }
  const coefficients = common.solveLinear([[s1, sc, ss], [sc, scc, scs], [ss, scs, sss]], [sy, scy, ssy]);
  if (!coefficients) return null;
  let residualSum = 0;
  for (const point of points) {
    const angle = omega * (point.time - timeOrigin);
    const fitted = coefficients[0] + coefficients[1] * Math.cos(angle) + coefficients[2] * Math.sin(angle);
    residualSum += point.weight * (point.value - fitted) ** 2;
  }
  residualSum = Math.max(0, residualSum);
  return { coefficients, residualSum, power: Math.min(1, Math.max(0, 1 - residualSum / constantResidualSum)) };
}

function glsPower(points, frequencyPerDay, timeOrigin, constantResidualSum) {
  const fit = glsFit(points, frequencyPerDay, timeOrigin, constantResidualSum);
  return fit === null ? null : fit.power;
}

function maximumPowerOverGrid(points, frequencies, timeOrigin) {
  let sy = 0;
  for (const point of points) sy += point.weight * point.value;
  let constant = 0;
  for (const point of points) constant += point.weight * (point.value - sy) ** 2;
  if (!(constant > 0)) return { power: 0, frequencyPerDay: frequencies[0] };
  let best = 0;
  let bestFrequency = frequencies[0];
  for (const frequency of frequencies) {
    const power = glsPower(points, frequency, timeOrigin, constant);
    if (power !== null && power > best) { best = power; bestFrequency = frequency; }
  }
  return { power: best, frequencyPerDay: bestFrequency };
}

function windowPower(points, frequencyPerDay, timeOrigin) {
  let real = 0;
  let imaginary = 0;
  for (const point of points) {
    const angle = 2 * Math.PI * frequencyPerDay * (point.time - timeOrigin);
    real += point.weight * Math.cos(angle);
    imaginary += point.weight * Math.sin(angle);
  }
  return Math.min(1, Math.max(0, real ** 2 + imaginary ** 2));
}

function baluev(z, pointCount, maximumFrequencyPerDay, weightedTimeVariance) {
  const NH = pointCount - 1;
  const NK = pointCount - 3;
  const clipped = Math.min(1 - 1e-300, Math.max(0, z));
  const fapSingle = Math.exp(0.5 * NK * Math.log1p(-clipped));
  const effectiveBaseline = Math.sqrt(4 * Math.PI * weightedTimeVariance);
  const trialFactor = maximumFrequencyPerDay * effectiveBaseline;
  const tau = Math.exp(common.gammaLn(NH / 2) - common.gammaLn(NK / 2)) * trialFactor
    * Math.exp(0.5 * (NK - 1) * Math.log1p(-clipped)) * Math.sqrt(0.5 * NH * clipped);
  const fap = -Math.expm1(-tau) + fapSingle * Math.exp(-tau);
  return { fapSingle, tau, fap: Math.min(1, Math.max(0, fap)), effectiveBaseline, trialFactor };
}

function weightedTimeVariance(points) {
  let meanTime = 0;
  for (const point of points) meanTime += point.weight * point.time;
  let variance = 0;
  for (const point of points) variance += point.weight * (point.time - meanTime) ** 2;
  return variance;
}

function harmonicDesign(points, frequencyPerDay, timeOrigin, harmonics) {
  const omega = 2 * Math.PI * frequencyPerDay;
  return points.map((point) => {
    const row = [1];
    for (let k = 1; k <= harmonics; k += 1) {
      row.push(Math.cos(k * omega * (point.time - timeOrigin)), Math.sin(k * omega * (point.time - timeOrigin)));
    }
    return row;
  });
}

function evaluateHarmonic(coefficients, phase) {
  let value = coefficients[0];
  const harmonics = (coefficients.length - 1) / 2;
  for (let k = 1; k <= harmonics; k += 1) {
    value += coefficients[2 * k - 1] * Math.cos(2 * Math.PI * k * phase) + coefficients[2 * k] * Math.sin(2 * Math.PI * k * phase);
  }
  return value;
}

function analyzeLightCurvePeriodicityDepth(input) {
  const normalized = normalizeInput(input);
  const base = analyzeLightCurvePeriodicity(normalized.base);
  const rows = base.publication.observationsTable.rows;
  const points = rows.filter((row) => row.analysisEligible).map((row) => ({
    observationId: row.observationId, time: row.time, value: row.value, standardError: row.standardError, weight: row.normalizedWeight,
  }));
  const pointCount = points.length;
  if (pointCount < 6) throw new AstronomyDataError("astronomy-periodicity-depth-insufficient-points", "Baluev's bound needs at least six analysis-eligible observations");
  const timeOrigin = base.settings.timeOrigin;
  const constantResidualSum = base.bestFit.constantModelResidualSum;
  const weighted = base.settings.resolvedWeighting === "weighted";
  const absoluteWeightSum = weighted ? points.reduce((sum, point) => sum + 1 / point.standardError ** 2, 0) : null;
  const frequencies = base.periodogram.map((row) => row.frequencyPerDay);
  const frequencyStep = base.settings.frequencyStepPerDay;
  const maximumFrequency = base.settings.maximumFrequencyPerDay;
  const timeVariance = weightedTimeVariance(points);
  const warnings = [...base.warnings.filter((warning) => !["false-alarm-probability-not-computed", "period-uncertainty-not-computed", "single-sinusoid-model-only"].includes(warning))];

  // Consistency guard: the local GLS evaluator must reproduce the bounded periodogram exactly.
  const bestGrid = base.bestFit;
  const reproduced = glsPower(points, bestGrid.frequencyPerDay, timeOrigin, constantResidualSum);
  if (reproduced === null || Math.abs(reproduced - bestGrid.power) > 1e-9) {
    throw new AstronomyDataError("astronomy-periodicity-depth-periodogram-mismatch", "The depth evaluator disagrees with the bounded periodogram", { reproduced, expected: bestGrid.power });
  }

  // Analytic false-alarm probability for every reported peak and power thresholds per level.
  const peakRows = base.peaks.map((peak) => ({ ...peak, baluev: baluev(peak.power, pointCount, maximumFrequency, timeVariance) }));
  const thresholds = normalized.falseAlarmLevels.map((level) => {
    const power = common.bisect((z) => baluev(z, pointCount, maximumFrequency, timeVariance).fap - level, 1e-12, 1 - 1e-12);
    return { falseAlarmProbability: level, powerThreshold: power, exceededByBestPeak: power === null ? null : bestGrid.power >= power };
  });

  // Permutation bootstrap of the maximum power over the identical grid.
  const bootstrapWork = normalized.bootstrapSamples * frequencies.length * pointCount;
  if (bootstrapWork > LIMITS.maxBootstrapWorkUnits) {
    throw new AstronomyDataError("astronomy-periodicity-depth-bootstrap-budget-exceeded",
      `bootstrapSamples * frequencyCount * eligibleRows = ${bootstrapWork} exceeds ${LIMITS.maxBootstrapWorkUnits}; lower bootstrapSamples or frequencyCount`,
      { bootstrapSamples: normalized.bootstrapSamples, frequencyCount: frequencies.length, eligibleRows: pointCount, maximumWorkUnits: LIMITS.maxBootstrapWorkUnits });
  }
  const random = common.mulberry32(normalized.bootstrapSeed);
  const bootstrapMaxima = [];
  let exceedances = 0;
  for (let sample = 0; sample < normalized.bootstrapSamples; sample += 1) {
    const order = common.shuffleInPlace(points.map((_, index) => index), random);
    let rawWeightSum = 0;
    const permuted = points.map((point, index) => {
      const donor = points[order[index]];
      const rawWeight = weighted ? 1 / donor.standardError ** 2 : 1;
      rawWeightSum += rawWeight;
      return { time: point.time, value: donor.value, weight: rawWeight };
    });
    for (const point of permuted) point.weight /= rawWeightSum;
    const maximum = maximumPowerOverGrid(permuted, frequencies, timeOrigin);
    bootstrapMaxima.push(maximum.power);
    if (maximum.power >= bestGrid.power) exceedances += 1;
  }
  const bootstrap = {
    samples: normalized.bootstrapSamples,
    seed: normalized.bootstrapSeed,
    exceedances,
    falseAlarmProbability: normalized.bootstrapSamples > 0 ? exceedances / normalized.bootstrapSamples : null,
    falseAlarmUpperBound: normalized.bootstrapSamples > 0 ? (exceedances + 1) / (normalized.bootstrapSamples + 1) : null,
    maximumPowerPercentiles: normalized.bootstrapSamples > 0 ? {
      p50: common.percentile(bootstrapMaxima, 50), p90: common.percentile(bootstrapMaxima, 90),
      p99: common.percentile(bootstrapMaxima, 99), max: Math.max(...bootstrapMaxima),
    } : null,
  };
  if (normalized.bootstrapSamples === 0) warnings.push("bootstrap-false-alarm-probability-skipped-zero-samples");
  else if (exceedances === 0) warnings.push("bootstrap-false-alarm-probability-below-resolution-report-upper-bound");

  // Local refinement of the strongest peak.
  const localLow = Math.max(base.settings.minimumFrequencyPerDay, bestGrid.frequencyPerDay - frequencyStep);
  const localHigh = Math.min(maximumFrequency, bestGrid.frequencyPerDay + frequencyStep);
  const localFrequencies = Array.from({ length: LIMITS.localGridPoints }, (_, index) => localLow + (localHigh - localLow) * index / (LIMITS.localGridPoints - 1));
  const localPowers = localFrequencies.map((frequency) => glsPower(points, frequency, timeOrigin, constantResidualSum));
  let localBest = 0;
  for (let index = 1; index < localPowers.length; index += 1) {
    if (localPowers[index] !== null && (localPowers[localBest] === null || localPowers[index] > localPowers[localBest])) localBest = index;
  }
  let refinedFrequency = localFrequencies[localBest];
  let refinedPower = localPowers[localBest];
  if (localBest > 0 && localBest < localPowers.length - 1 && localPowers[localBest - 1] !== null && localPowers[localBest + 1] !== null) {
    const yl = localPowers[localBest - 1]; const y0 = localPowers[localBest]; const yr = localPowers[localBest + 1];
    const denominator = yl - 2 * y0 + yr;
    if (denominator < 0) {
      const offset = 0.5 * (yl - yr) / denominator;
      const candidate = localFrequencies[localBest] + offset * (localFrequencies[1] - localFrequencies[0]);
      const candidatePower = glsPower(points, candidate, timeOrigin, constantResidualSum);
      if (candidatePower !== null && candidatePower >= refinedPower) { refinedFrequency = candidate; refinedPower = candidatePower; }
    }
  }
  const refinedPeriod = 1 / refinedFrequency;

  // Peak half width at half maximum (search on the local grid, then the coarse grid).
  const halfPower = refinedPower / 2;
  const findCrossing = (direction) => {
    let previousFrequency = refinedFrequency;
    let previousPower = refinedPower;
    const step = (localFrequencies[1] - localFrequencies[0]) * direction;
    for (let count = 1; count <= 20000; count += 1) {
      const frequency = refinedFrequency + step * count;
      if (frequency <= 0 || frequency < base.settings.minimumFrequencyPerDay - frequencyStep || frequency > maximumFrequency + frequencyStep) return null;
      const power = glsPower(points, frequency, timeOrigin, constantResidualSum);
      if (power === null) return null;
      if (power <= halfPower) {
        const fraction = (previousPower - halfPower) / (previousPower - power);
        return Math.abs((previousFrequency + fraction * (frequency - previousFrequency)) - refinedFrequency);
      }
      previousFrequency = frequency;
      previousPower = power;
    }
    return null;
  };
  const halfWidthUpper = findCrossing(1);
  const halfWidthLower = findCrossing(-1);
  const halfWidth = halfWidthUpper === null && halfWidthLower === null ? null
    : halfWidthUpper === null ? halfWidthLower : halfWidthLower === null ? halfWidthUpper : (halfWidthUpper + halfWidthLower) / 2;
  if (halfWidth === null) warnings.push("peak-half-width-not-resolved-within-grid");

  // Harmonic refinements at the refined frequency.
  const weights = points.map((point) => point.weight);
  const values = points.map((point) => point.value);
  const single = common.weightedLeastSquares(harmonicDesign(points, refinedFrequency, timeOrigin, 1), values, weights);
  const double = common.weightedLeastSquares(harmonicDesign(points, refinedFrequency, timeOrigin, 2), values, weights);
  if (!single || !double) throw new AstronomyDataError("astronomy-periodicity-depth-harmonic-design-singular");
  const amplitude1 = Math.hypot(single.coefficients[1], single.coefficients[2]);
  const residualRms = Math.sqrt(single.residualSum);
  const baseline = base.summary.baselineDays;
  const analyticFrequencySigma = amplitude1 > 0 ? Math.sqrt(6 / pointCount) * residualRms / (Math.PI * baseline * amplitude1) : null;
  const chiSquare = (residualSum) => (weighted ? absoluteWeightSum * residualSum : null);
  const harmonicComparison = {
    refinedFrequencyPerDay: refinedFrequency,
    single: {
      coefficients: single.coefficients, amplitude: amplitude1, residualSum: single.residualSum,
      power: Math.min(1, Math.max(0, 1 - single.residualSum / constantResidualSum)),
      chiSquare: chiSquare(single.residualSum), degreesOfFreedom: pointCount - 3,
      reducedChiSquare: weighted ? chiSquare(single.residualSum) / (pointCount - 3) : null,
      bayesianInformationCriterion: weighted ? chiSquare(single.residualSum) + 3 * Math.log(pointCount) : null,
    },
    twoHarmonic: {
      coefficients: double.coefficients,
      amplitudes: [Math.hypot(double.coefficients[1], double.coefficients[2]), Math.hypot(double.coefficients[3], double.coefficients[4])],
      residualSum: double.residualSum,
      power: Math.min(1, Math.max(0, 1 - double.residualSum / constantResidualSum)),
      chiSquare: chiSquare(double.residualSum), degreesOfFreedom: pointCount - 5,
      reducedChiSquare: weighted ? chiSquare(double.residualSum) / (pointCount - 5) : null,
      bayesianInformationCriterion: weighted ? chiSquare(double.residualSum) + 5 * Math.log(pointCount) : null,
    },
    residualSumReductionFraction: single.residualSum > 0 ? (single.residualSum - double.residualSum) / single.residualSum : null,
    deltaBayesianInformationCriterion: weighted ? (chiSquare(double.residualSum) + 5 * Math.log(pointCount)) - (chiSquare(single.residualSum) + 3 * Math.log(pointCount)) : null,
  };

  // Residual bootstrap of the refined period around the two-harmonic model.
  const modelValues = harmonicDesign(points, refinedFrequency, timeOrigin, 2).map((row) => row.reduce((sum, basis, index) => sum + basis * double.coefficients[index], 0));
  const residuals = points.map((point, index) => point.value - modelValues[index]);
  const bootstrapPeriods = [];
  for (let sample = 0; sample < normalized.bootstrapSamples; sample += 1) {
    const indices = common.resampleIndices(pointCount, random);
    const replicate = points.map((point, index) => ({ time: point.time, value: modelValues[index] + residuals[indices[index]], weight: point.weight }));
    const maximum = maximumPowerOverGrid(replicate, localFrequencies, timeOrigin);
    bootstrapPeriods.push(1 / maximum.frequencyPerDay);
  }
  const periodUncertainty = {
    gridResolutionPeriodDays: refinedPeriod ** 2 * frequencyStep,
    inverseBaselinePeriodDays: refinedPeriod ** 2 / baseline,
    halfWidthFrequencyPerDay: halfWidth,
    halfWidthPeriodDays: halfWidth === null ? null : refinedPeriod ** 2 * halfWidth,
    analyticFrequencyStandardErrorPerDay: analyticFrequencySigma,
    analyticPeriodStandardErrorDays: analyticFrequencySigma === null ? null : refinedPeriod ** 2 * analyticFrequencySigma,
    bootstrap: bootstrapPeriods.length > 1 ? {
      samples: bootstrapPeriods.length,
      standardDeviationDays: common.standardDeviation(bootstrapPeriods),
      percentile16Days: common.percentile(bootstrapPeriods, 16),
      percentile50Days: common.percentile(bootstrapPeriods, 50),
      percentile84Days: common.percentile(bootstrapPeriods, 84),
      localGridSpanPerDay: [localLow, localHigh],
    } : null,
  };

  // Alias screen.
  const gridIndexFor = (frequency) => Math.round((frequency - base.settings.minimumFrequencyPerDay) / frequencyStep);
  const peakIndices = new Set(base.peaks.map((peak) => peak.gridIndex));
  const aliasRows = [];
  for (const aliasPeriod of normalized.aliasPeriodsDays) {
    const aliasFrequency = 1 / aliasPeriod;
    const aliasWindowPower = windowPower(points, aliasFrequency, timeOrigin);
    for (const multiple of [1, -1, 2, -2]) {
      const frequency = refinedFrequency + multiple * aliasFrequency;
      const inGrid = frequency >= base.settings.minimumFrequencyPerDay && frequency <= maximumFrequency;
      const gridIndex = inGrid ? Math.min(base.periodogram.length - 1, Math.max(0, gridIndexFor(frequency))) : null;
      const gridRow = gridIndex === null ? null : base.periodogram[gridIndex];
      const isLocalPeak = gridIndex !== null && [gridIndex - 1, gridIndex, gridIndex + 1].some((index) => peakIndices.has(index));
      aliasRows.push({
        aliasPeriodDays: aliasPeriod,
        aliasFrequencyPerDay: aliasFrequency,
        multiple,
        candidateFrequencyPerDay: frequency > 0 ? frequency : null,
        candidatePeriodDays: frequency > 0 ? 1 / frequency : null,
        withinGrid: inGrid,
        gridPower: gridRow ? gridRow.power : null,
        gridPeriodDays: gridRow ? gridRow.periodDays : null,
        coincidesWithReportedPeak: isLocalPeak,
        windowPowerAtAliasFrequency: aliasWindowPower,
      });
    }
  }
  if (aliasRows.some((row) => row.coincidesWithReportedPeak)) warnings.push("reported-peak-coincides-with-alias-candidate");
  if (normalized.aliasPeriodsDays.some((period) => windowPower(points, 1 / period, timeOrigin) > 0.5)) warnings.push("strong-sampling-window-power-at-alias-frequency");

  // Folded observations at the refined period.
  const folded = rows.map((row) => {
    const eligible = row.analysisEligible;
    const phase = eligible ? common.unitPhase((row.time - timeOrigin) * refinedFrequency) : null;
    const singleModel = eligible ? evaluateHarmonic(single.coefficients, phase) : null;
    const doubleModel = eligible ? evaluateHarmonic(double.coefficients, phase) : null;
    return {
      observationId: row.observationId, time: row.time, phase, value: row.value, standardError: row.standardError,
      analysisEligible: eligible, exclusionReasons: row.exclusionReasons,
      singleHarmonicModel: singleModel, twoHarmonicModel: doubleModel,
      residual: eligible ? row.value - doubleModel : null,
    };
  });
  const modelCurve = Array.from({ length: 201 }, (_, index) => {
    const phase = index / 200;
    return { phase, singleHarmonicModel: evaluateHarmonic(single.coefficients, phase), twoHarmonicModel: evaluateHarmonic(double.coefficients, phase) };
  });

  const settings = {
    ...base.settings,
    bootstrapSamples: normalized.bootstrapSamples,
    bootstrapSeed: normalized.bootstrapSeed,
    aliasPeriodsDays: normalized.aliasPeriodsDays,
    falseAlarmLevels: normalized.falseAlarmLevels,
    localGridPoints: LIMITS.localGridPoints,
  };
  const bestBaluev = peakRows[0].baluev;
  const summary = {
    ...base.summary,
    bestGridPeriodDays: bestGrid.periodDays,
    bestGridPower: bestGrid.power,
    refinedPeriodDays: refinedPeriod,
    refinedFrequencyPerDay: refinedFrequency,
    refinedPower,
    baluevFalseAlarmProbability: bestBaluev.fap,
    baluevSingleFrequencyFalseAlarmProbability: bestBaluev.fapSingle,
    baluevTau: bestBaluev.tau,
    effectiveTrialFactor: bestBaluev.trialFactor,
    bootstrapFalseAlarmProbability: bootstrap.falseAlarmProbability,
    twoHarmonicResidualSumReductionFraction: harmonicComparison.residualSumReductionFraction,
    weighted,
  };
  const sourceContentSha256 = normalized.base.sourceContentSha256;
  const tableRows = peakRows.map((peak) => ({
    rank: peak.rank,
    gridPeriodDays: peak.periodDays,
    gridFrequencyPerDay: peak.frequencyPerDay,
    refinedPeriodDays: peak.rank === 1 ? refinedPeriod : null,
    power: peak.power,
    amplitude: peak.amplitude,
    windowPower: peak.windowPower,
    baluevSingleFrequencyFap: peak.baluev.fapSingle,
    baluevFap: peak.baluev.fap,
    bootstrapFap: peak.rank === 1 ? bootstrap.falseAlarmProbability : null,
    halfWidthPeriodDays: peak.rank === 1 ? periodUncertainty.halfWidthPeriodDays : null,
    bootstrapPeriodStandardDeviationDays: peak.rank === 1 && periodUncertainty.bootstrap ? periodUncertainty.bootstrap.standardDeviationDays : null,
  }));
  const table = common.publicationTable(`${base.settings.targetId}: periodogram peaks with false-alarm probabilities`, [
    { key: "rank", label: "Rank", unit: null, datatype: "integer" },
    { key: "gridPeriodDays", label: "Grid period", unit: "day", datatype: "number" },
    { key: "gridFrequencyPerDay", label: "Grid frequency", unit: "1/day", datatype: "number" },
    { key: "refinedPeriodDays", label: "Refined period", unit: "day", datatype: "number|null" },
    { key: "power", label: "GLS power", unit: null, datatype: "number" },
    { key: "amplitude", label: "Sinusoid amplitude", unit: base.settings.valueUnit, datatype: "number" },
    { key: "windowPower", label: "Window power", unit: null, datatype: "number" },
    { key: "baluevSingleFrequencyFap", label: "Single-frequency FAP", unit: null, datatype: "number" },
    { key: "baluevFap", label: "Baluev FAP", unit: null, datatype: "number" },
    { key: "bootstrapFap", label: "Bootstrap FAP", unit: null, datatype: "number|null" },
    { key: "halfWidthPeriodDays", label: "Peak HWHM period s.e.", unit: "day", datatype: "number|null" },
    { key: "bootstrapPeriodStandardDeviationDays", label: "Bootstrap period s.d.", unit: "day", datatype: "number|null" },
  ], tableRows, [
    "Baluev FAP is an analytic upper bound assuming white Gaussian noise; the bootstrap FAP is a permutation estimate with the same frequency grid.",
    `Bootstrap FAP resolution is 1/${normalized.bootstrapSamples || "n"}; zero exceedances mean FAP < upper bound, not FAP = 0.`,
    "Refinement, peak width, and bootstrap period uncertainties are reported for the strongest peak only.",
  ]);
  const valueTitle = base.settings.valueUnit ? `Observed value (${base.settings.valueUnit})` : "Observed value";
  const yScale = common.measurementScale(base.settings.valueKind);
  const buildFigure = (provenance) => common.publicationFigure(
    `${base.settings.targetId}: GLS periodogram with Baluev false-alarm levels and two-harmonic fold`,
    `Two-panel figure. Upper panel: generalized Lomb-Scargle power over ${base.periodogram.length} trial periods with ${thresholds.length} Baluev false-alarm thresholds and the refined period ${refinedPeriod} days marked. Lower panel: ${points.length} observations folded at the refined period with single- and two-harmonic model curves.`,
    {
      $schema: common.VEGA_LITE_SCHEMA_URL,
      description: "GLS periodogram with analytic false-alarm thresholds and refined-period fold.",
      vconcat: [
        {
          width: 720, height: 260,
          layer: [
            { data: { values: base.periodogram.filter((row) => row.power !== null).map((row) => ({ periodDays: row.periodDays, power: row.power })) },
              mark: { type: "line", color: "#255C99", strokeWidth: 1.6, clip: true },
              encoding: { x: { field: "periodDays", type: "quantitative", title: "Trial period (day)", scale: { type: "log" } }, y: { field: "power", type: "quantitative", title: "GLS power", scale: { domain: [0, 1] } } } },
            { data: { values: thresholds.filter((row) => row.powerThreshold !== null).map((row) => ({ power: row.powerThreshold, label: `FAP ${row.falseAlarmProbability}` })) },
              mark: { type: "rule", color: "#9CA3AF", strokeDash: [6, 4], strokeWidth: 1 },
              encoding: { y: { field: "power", type: "quantitative" }, tooltip: [{ field: "label", type: "nominal", title: "Threshold" }, { field: "power", type: "quantitative", title: "Power", format: ".4f" }] } },
            { data: { values: [{ periodDays: refinedPeriod }] }, mark: { type: "rule", color: "#C2415D", strokeWidth: 1.5 },
              encoding: { x: { field: "periodDays", type: "quantitative", scale: { type: "log" } } } },
          ],
        },
        {
          width: 720, height: 260,
          layer: [
            { data: { values: modelCurve }, mark: { type: "line", color: "#9CA3AF", strokeDash: [4, 3], strokeWidth: 1.4 },
              encoding: { x: { field: "phase", type: "quantitative", title: `Phase at refined period ${refinedPeriod.toPrecision(8)} day`, scale: { domain: [0, 1] } }, y: { field: "singleHarmonicModel", type: "quantitative", title: valueTitle, scale: yScale } } },
            { data: { values: modelCurve }, mark: { type: "line", color: "#C2415D", strokeWidth: 1.8 },
              encoding: { x: { field: "phase", type: "quantitative", scale: { domain: [0, 1] } }, y: { field: "twoHarmonicModel", type: "quantitative", scale: yScale } } },
            { data: { values: folded.filter((row) => row.analysisEligible && row.standardError !== null).map((row) => ({ phase: row.phase, lower: row.value - row.standardError, upper: row.value + row.standardError })) },
              mark: { type: "rule", color: "#6B7280", strokeWidth: 1 },
              encoding: { x: { field: "phase", type: "quantitative", scale: { domain: [0, 1] } }, y: { field: "lower", type: "quantitative", scale: yScale }, y2: { field: "upper" } } },
            { data: { values: folded.filter((row) => row.analysisEligible).map((row) => ({ observationId: row.observationId, phase: row.phase, value: row.value, residual: row.residual })) },
              mark: { type: "point", filled: true, color: "#255C99", size: 48, stroke: "#FFFFFF", strokeWidth: 0.7 },
              encoding: { x: { field: "phase", type: "quantitative", scale: { domain: [0, 1] } }, y: { field: "value", type: "quantitative", scale: yScale },
                tooltip: [{ field: "observationId", type: "nominal", title: "Observation" }, { field: "phase", type: "quantitative", title: "Phase", format: ".5f" }, { field: "value", type: "quantitative", title: "Observed", format: ".6g" }, { field: "residual", type: "quantitative", title: "Residual (2-harmonic)", format: ".6g" }] } },
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
    normalizedInput: { ...normalized.base, bootstrapSamples: normalized.bootstrapSamples, bootstrapSeed: normalized.bootstrapSeed, aliasPeriodsDays: normalized.aliasPeriodsDays, falseAlarmLevels: normalized.falseAlarmLevels },
    sourceContentSha256,
    sections: {
      settings,
      summary,
      warnings,
      boundaries: BOUNDARIES,
      basePeriodogram: { schema: base.schema, resultSha256: base.provenance.resultSha256, gridPoints: base.periodogram.length },
      periodogram: base.periodogram,
      peaks: peakRows.map(({ baluev: peakBaluev, ...peak }) => ({ ...peak, baluevFap: peakBaluev.fap, baluevSingleFrequencyFap: peakBaluev.fapSingle, baluevTau: peakBaluev.tau })),
      falseAlarm: { baluevBestPeak: bestBaluev, thresholds, bootstrap },
      refinedPeak: { frequencyPerDay: refinedFrequency, periodDays: refinedPeriod, power: refinedPower, localGrid: { pointCount: LIMITS.localGridPoints, lowFrequencyPerDay: localLow, highFrequencyPerDay: localHigh } },
      periodUncertainty,
      harmonicComparison,
      aliasScreen: aliasRows,
      folded,
      modelCurve,
    },
    table,
    buildFigure,
  });
}

module.exports = {
  PERIODICITY_DEPTH_ALGORITHM: ALGORITHM,
  PERIODICITY_DEPTH_BOUNDARIES: BOUNDARIES,
  PERIODICITY_DEPTH_LIMITS: LIMITS,
  PERIODICITY_DEPTH_SCHEMA: SCHEMA,
  SIDEREAL_DAY_DAYS,
  analyzeLightCurvePeriodicityDepth,
  baluevFalseAlarm: baluev,
  glsPower,
};
