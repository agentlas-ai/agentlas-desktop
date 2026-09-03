"use strict";

/**
 * Single-Keplerian radial-velocity orbit fit: a floating-mean generalized
 * Lomb–Scargle periodogram seeds the period, semi-amplitude and phase; a fixed set
 * of (e, omega) starts is refined by Levenberg–Marquardt over (P, K, e, omega, T_p,
 * gamma); the lowest chi-square solution is reported with covariance uncertainties,
 * minimum mass m sin i (given a declared primary mass), the projected semi-major
 * axis, residual RMS, a phase-folded figure, and a per-observation residual table.
 */

const common = require("./analysis-common.cjs");

const { AstronomyDataError } = common;
const SCHEMA = "agentlas.science.astronomy-radial-velocity-orbit-result/v1";
const TIME_SYSTEMS = ["BJD_TDB", "BJD_UTC", "HJD_UTC", "JD_UTC", "MJD_UTC", "relative-day"];
const GRAVITATIONAL_CONSTANT_SI = 6.67430e-11;
const SOLAR_MASS_KG = 1.988409870698051e30;
const JUPITER_MASS_KG = 1.8981245973360505e27;
const EARTH_MASS_KG = 5.972167867791379e24;
const ASTRONOMICAL_UNIT_M = 149597870700;
const DAY_S = 86400;
const LIMITS = common.deepFreeze({ minMeasurements: 8, maxMeasurements: 5000, minFrequencyCount: 32, maxFrequencyCount: 20000, maxEccentricity: 0.95, modelCurvePoints: 241 });
const START_ECCENTRICITIES = [0, 0.3, 0.6];
const START_ARGUMENTS = [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2];
const ALGORITHM = common.deepFreeze({
  id: "agentlas.astronomy.radial-velocity-keplerian-orbit",
  version: "1.0.0",
  model: "v(t) = gamma + K [cos(nu(t) + omega) + e cos(omega)], nu from Kepler's equation E - e sin E = M, M = 2 pi (t - T_p)/P, solved by Newton-Raphson",
  seed: "weighted floating-mean generalized Lomb-Scargle over an inclusive linear frequency grid; the strongest peak supplies P, and its sinusoid fit supplies K, the phase and gamma",
  starts: "eccentricities {0, 0.3, 0.6} x arguments of periastron {0, pi/2, pi, 3pi/2}; each start is refined with Levenberg-Marquardt on residuals (v_i - model_i)/sigma_i and the lowest chi-square solution is kept",
  constraints: "e in [0, 0.95], K > 0, P > 0; omega wrapped to [0, 2 pi); T_p wrapped into one period of the first observation",
  uncertainties: "covariance (J^T J)^-1 from a central-difference Jacobian at the optimum; scaled uncertainties multiply by sqrt(max(1, chi^2/dof)), dof = N - 6",
  derived: "mass function f(m) = P K^3 (1 - e^2)^{3/2} / (2 pi G); m sin i = K (1 - e^2)^{1/2} (P / 2 pi G)^{1/3} M_*^{2/3} for m << M_*; a = (G M_* P^2 / 4 pi^2)^{1/3}",
  constants: { gravitationalConstantSI: GRAVITATIONAL_CONSTANT_SI, solarMassKg: SOLAR_MASS_KG, jupiterMassKg: JUPITER_MASS_KG, earthMassKg: EARTH_MASS_KG, astronomicalUnitM: ASTRONOMICAL_UNIT_M },
  references: [
    { title: "Fundamentals of Celestial Mechanics, 2nd ed. (Kepler's equation)", authors: "J. M. A. Danby", journal: "Willmann-Bell (1988)" },
    { title: "The generalised Lomb-Scargle periodogram", authors: "M. Zechmeister and M. Kuerster", journal: "A&A 496, 577 (2009)", doi: "10.1051/0004-6361:200811296" },
    { title: "Exoplanet Handbook, 2nd ed. (radial-velocity orbit elements)", authors: "M. Perryman", journal: "Cambridge University Press (2018)", doi: "10.1017/9781108304160" },
  ],
});
const BOUNDARIES = common.deepFreeze([
  "A single Keplerian is fitted; stellar activity, additional companions, linear trends, and instrument offsets between data sets are not modelled.",
  "The starting grid over (e, omega) is finite; strongly eccentric or poorly sampled orbits can converge to a local minimum, and the period alias screen of the periodogram tool should be consulted.",
  "m sin i assumes the companion mass is negligible against the declared primary mass and that the primary mass itself carries no uncertainty.",
  "Uncertainties are first-order covariance estimates, not posterior credible intervals; jitter is not fitted.",
  "Declared time systems are preserved verbatim; no barycentric correction is applied.",
]);

function normalizeInput(input) {
  const code = "astronomy-rv-orbit-input-invalid";
  common.exactObject(input, ["sourceContentSha256", "targetId", "timeSystem", "timeOffsetDays", "minimumPeriodDays", "maximumPeriodDays", "frequencyCount", "primaryMassSolar", "measurements"], code);
  common.requiredOwn(input, ["sourceContentSha256", "targetId", "timeSystem", "timeOffsetDays", "minimumPeriodDays", "maximumPeriodDays", "frequencyCount", "measurements"], code);
  const sourceContentSha256 = common.sourceHash(input.sourceContentSha256, "astronomy-rv-orbit-source-hash-invalid");
  const targetId = common.text(input.targetId, "astronomy-rv-orbit-target-id-invalid", 500);
  const timeSystem = common.enumeration(input.timeSystem, TIME_SYSTEMS, "astronomy-rv-orbit-time-system-invalid");
  const timeOffsetDays = common.number(input.timeOffsetDays, "astronomy-rv-orbit-time-offset-invalid", -1e9, 1e9);
  const minimumPeriodDays = common.number(input.minimumPeriodDays, "astronomy-rv-orbit-period-range-invalid", 1e-4, 1e6);
  const maximumPeriodDays = common.number(input.maximumPeriodDays, "astronomy-rv-orbit-period-range-invalid", 1e-4, 1e6);
  if (maximumPeriodDays <= minimumPeriodDays) throw new AstronomyDataError("astronomy-rv-orbit-period-range-invalid", "maximumPeriodDays must exceed minimumPeriodDays");
  const frequencyCount = common.integer(input.frequencyCount, "astronomy-rv-orbit-frequency-count-invalid", LIMITS.minFrequencyCount, LIMITS.maxFrequencyCount);
  const primaryMassSolar = common.optional(input.primaryMassSolar, null, (value) => common.nullableNumber(value, "astronomy-rv-orbit-primary-mass-invalid", 0.01, 1000));
  if (!Array.isArray(input.measurements) || input.measurements.length < LIMITS.minMeasurements || input.measurements.length > LIMITS.maxMeasurements) {
    throw new AstronomyDataError("astronomy-rv-orbit-measurements-invalid", `measurements must contain ${LIMITS.minMeasurements} through ${LIMITS.maxMeasurements} rows`);
  }
  const measurements = input.measurements.map((row, index) => {
    const rowCode = `astronomy-rv-orbit-row-${index}`;
    common.exactObject(row, ["observationId", "time", "radialVelocityKmS", "standardErrorKmS", "use"], `${rowCode}-invalid`);
    common.requiredOwn(row, ["observationId", "time", "radialVelocityKmS", "standardErrorKmS", "use"], `${rowCode}-invalid`);
    return {
      observationId: common.text(row.observationId, `${rowCode}-observation-id-invalid`, 160),
      time: common.nullableNumber(row.time, `${rowCode}-time-invalid`, -1e9, 1e9),
      radialVelocityKmS: common.nullableNumber(row.radialVelocityKmS, `${rowCode}-rv-invalid`, -1e5, 1e5),
      standardErrorKmS: common.nullableNumber(row.standardErrorKmS, `${rowCode}-standard-error-invalid`, 0, 1e5, { minimumExclusive: true }),
      use: common.boolean(row.use, `${rowCode}-use-invalid`),
    };
  }).sort((left, right) => {
    if (left.time === null && right.time !== null) return 1;
    if (left.time !== null && right.time === null) return -1;
    if (left.time !== null && right.time !== null && left.time !== right.time) return left.time - right.time;
    return common.compareText(left.observationId, right.observationId);
  });
  common.uniqueIds(measurements, "observationId", "astronomy-rv-orbit-duplicate-observation-id");
  return { sourceContentSha256, targetId, timeSystem, timeOffsetDays, minimumPeriodDays, maximumPeriodDays, frequencyCount, primaryMassSolar, measurements };
}

function wrapAngle(value) {
  const twoPi = 2 * Math.PI;
  let angle = value % twoPi;
  if (angle < 0) angle += twoPi;
  return angle;
}

function keplerianVelocity(parameters, time) {
  const [period, semiAmplitude, eccentricity, argument, periastron, gamma] = parameters;
  const meanAnomaly = 2 * Math.PI * (time - periastron) / period;
  const eccentricAnomaly = common.solveKepler(meanAnomaly, eccentricity);
  const nu = common.trueAnomaly(eccentricAnomaly, eccentricity);
  return gamma + semiAmplitude * (Math.cos(nu + argument) + eccentricity * Math.cos(argument));
}

function fitRadialVelocityOrbit(input) {
  const normalized = normalizeInput(input);
  const warnings = [];
  const rows = normalized.measurements.map((row) => {
    const exclusionReasons = [];
    if (!row.use) exclusionReasons.push("user-excluded");
    if (row.time === null) exclusionReasons.push("time-missing");
    if (row.radialVelocityKmS === null) exclusionReasons.push("value-missing");
    if (row.standardErrorKmS === null) exclusionReasons.push("uncertainty-missing");
    return { ...row, exclusionReasons, fitEligible: exclusionReasons.length === 0 };
  });
  const points = rows.filter((row) => row.fitEligible);
  if (points.length < LIMITS.minMeasurements) throw new AstronomyDataError("astronomy-rv-orbit-insufficient-eligible-observations", `At least ${LIMITS.minMeasurements} fit-eligible observations are required`, { eligible: points.length });
  const times = points.map((point) => point.time);
  const timeOrigin = Math.min(...times);
  const baselineDays = Math.max(...times) - timeOrigin;
  if (!(baselineDays > 0)) throw new AstronomyDataError("astronomy-rv-orbit-baseline-invalid");
  const weightSum = points.reduce((sum, point) => sum + 1 / point.standardErrorKmS ** 2, 0);
  const weights = points.map((point) => (1 / point.standardErrorKmS ** 2) / weightSum);
  const values = points.map((point) => point.radialVelocityKmS);
  const weightedMean = points.reduce((sum, point, index) => sum + weights[index] * point.radialVelocityKmS, 0);
  const constantResidual = points.reduce((sum, point, index) => sum + weights[index] * (point.radialVelocityKmS - weightedMean) ** 2, 0);
  if (!(constantResidual > 0)) throw new AstronomyDataError("astronomy-rv-orbit-constant-series");

  // Periodogram seed.
  const minimumFrequency = 1 / normalized.maximumPeriodDays;
  const maximumFrequency = 1 / normalized.minimumPeriodDays;
  const frequencyStep = (maximumFrequency - minimumFrequency) / (normalized.frequencyCount - 1);
  const periodogram = [];
  let best = null;
  for (let index = 0; index < normalized.frequencyCount; index += 1) {
    const frequency = index === normalized.frequencyCount - 1 ? maximumFrequency : minimumFrequency + index * frequencyStep;
    const omega = 2 * Math.PI * frequency;
    const design = points.map((point) => [1, Math.cos(omega * (point.time - timeOrigin)), Math.sin(omega * (point.time - timeOrigin))]);
    const fit = common.weightedLeastSquares(design, values, weights);
    const power = fit ? Math.min(1, Math.max(0, 1 - fit.residualSum / constantResidual)) : null;
    periodogram.push({ gridIndex: index, frequencyPerDay: frequency, periodDays: 1 / frequency, power });
    if (power !== null && (best === null || power > best.power)) best = { gridIndex: index, frequency, power, coefficients: fit.coefficients };
  }
  if (!best) throw new AstronomyDataError("astronomy-rv-orbit-periodogram-singular");
  if (normalized.maximumPeriodDays > baselineDays) warnings.push("maximum-period-exceeds-baseline-orbit-not-fully-sampled");
  const seedPeriod = 1 / best.frequency;
  const seedAmplitude = Math.hypot(best.coefficients[1], best.coefficients[2]);
  const seedPhase = Math.atan2(-best.coefficients[2], best.coefficients[1]);
  const seedGamma = best.coefficients[0];

  const residualFn = (parameters) => points.map((point) => (point.radialVelocityKmS - keplerianVelocity(parameters, point.time)) / point.standardErrorKmS);
  const constrain = (candidate) => {
    const period = Math.max(normalized.minimumPeriodDays / 4, Math.min(normalized.maximumPeriodDays * 4, Math.abs(candidate[0])));
    const semiAmplitude = Math.abs(candidate[1]);
    const eccentricity = Math.min(LIMITS.maxEccentricity, Math.max(0, candidate[2]));
    const argument = wrapAngle(candidate[3]);
    let periastron = candidate[4];
    periastron = timeOrigin + ((periastron - timeOrigin) % period + period) % period;
    return [period, semiAmplitude, eccentricity, argument, periastron, candidate[5]];
  };
  const starts = [];
  for (const eccentricity of START_ECCENTRICITIES) {
    for (const argument of START_ARGUMENTS) {
      // For a circular orbit v = gamma + K cos(2 pi (t - T_p)/P + omega): phase from the sinusoid fit gives T_p.
      const periastron = timeOrigin + ((seedPhase - argument) / (2 * Math.PI)) * seedPeriod;
      starts.push([seedPeriod, seedAmplitude, eccentricity, argument, periastron, seedGamma]);
    }
  }
  let bestFit = null;
  const startResults = [];
  for (const start of starts) {
    let fit;
    try {
      fit = common.levenbergMarquardt(residualFn, start, {
        maxIterations: 400, tolerance: 1e-14, constrain,
        steps: [seedPeriod * 1e-6, Math.max(1e-6, seedAmplitude * 1e-6), 1e-6, 1e-6, seedPeriod * 1e-6, Math.max(1e-6, Math.abs(seedGamma) * 1e-6 + 1e-6)],
      });
    } catch { continue; }
    startResults.push({ start: { eccentricity: start[2], argumentOfPeriastronRad: start[3] }, chiSquare: fit.chiSquare, converged: fit.converged });
    if (bestFit === null || fit.chiSquare < bestFit.chiSquare) bestFit = fit;
  }
  if (!bestFit) throw new AstronomyDataError("astronomy-rv-orbit-fit-failed", "Every Levenberg-Marquardt start failed");
  if (!bestFit.converged) warnings.push("levenberg-marquardt-did-not-converge");
  const [period, semiAmplitude, eccentricity, argument, periastron, gamma] = bestFit.parameters;
  if (eccentricity >= LIMITS.maxEccentricity - 1e-9) warnings.push("eccentricity-at-upper-bound");
  if (period > baselineDays) warnings.push("fitted-period-exceeds-baseline");
  const degreesOfFreedom = points.length - 6;
  const reducedChiSquare = degreesOfFreedom > 0 ? bestFit.chiSquare / degreesOfFreedom : null;
  const inflation = reducedChiSquare !== null ? Math.sqrt(Math.max(1, reducedChiSquare)) : null;
  const covariance = bestFit.covariance;
  if (!covariance) warnings.push("covariance-singular-uncertainties-unavailable");
  const sigma = (index) => (covariance ? Math.sqrt(Math.max(0, covariance[index][index])) : null);
  const scaled = (value) => (value === null || inflation === null ? value : value * inflation);
  const errors = { period: sigma(0), semiAmplitude: sigma(1), eccentricity: sigma(2), argument: sigma(3), periastron: sigma(4), gamma: sigma(5) };
  if (reducedChiSquare !== null && reducedChiSquare > 3) warnings.push("reduced-chi-square-above-3-jitter-or-additional-signal-likely");
  const residuals = points.map((point) => point.radialVelocityKmS - keplerianVelocity(bestFit.parameters, point.time));
  const residualRms = Math.sqrt(residuals.reduce((sum, value) => sum + value * value, 0) / residuals.length);
  const weightedResidualRms = Math.sqrt(bestFit.chiSquare / points.length);

  // Derived masses.
  const periodS = period * DAY_S;
  const semiAmplitudeMS = semiAmplitude * 1000;
  const massFunctionKg = periodS * semiAmplitudeMS ** 3 * (1 - eccentricity ** 2) ** 1.5 / (2 * Math.PI * GRAVITATIONAL_CONSTANT_SI);
  let derived = { massFunctionSolar: massFunctionKg / SOLAR_MASS_KG, minimumMassJupiter: null, minimumMassEarth: null, minimumMassSolar: null, semiMajorAxisAu: null, minimumMassErrorJupiter: null };
  if (normalized.primaryMassSolar !== null) {
    const primaryKg = normalized.primaryMassSolar * SOLAR_MASS_KG;
    const minimumMassKg = semiAmplitudeMS * Math.sqrt(1 - eccentricity ** 2) * Math.cbrt(periodS / (2 * Math.PI * GRAVITATIONAL_CONSTANT_SI)) * primaryKg ** (2 / 3);
    const semiMajorAxisM = Math.cbrt(GRAVITATIONAL_CONSTANT_SI * primaryKg * periodS ** 2 / (4 * Math.PI ** 2));
    let minimumMassError = null;
    if (covariance) {
      // First-order propagation over K, e, P (primary mass treated as exact).
      const dK = minimumMassKg / semiAmplitudeMS;
      const dE = -minimumMassKg * eccentricity / (1 - eccentricity ** 2);
      const dP = minimumMassKg / (3 * periodS);
      const g = [dP * DAY_S, dK * 1000, dE];
      const indices = [0, 1, 2];
      let variance = 0;
      for (let left = 0; left < 3; left += 1) for (let right = 0; right < 3; right += 1) variance += g[left] * g[right] * covariance[indices[left]][indices[right]];
      minimumMassError = Math.sqrt(Math.max(0, variance)) / JUPITER_MASS_KG;
    }
    derived = {
      massFunctionSolar: massFunctionKg / SOLAR_MASS_KG,
      minimumMassJupiter: minimumMassKg / JUPITER_MASS_KG,
      minimumMassEarth: minimumMassKg / EARTH_MASS_KG,
      minimumMassSolar: minimumMassKg / SOLAR_MASS_KG,
      minimumMassErrorJupiter: minimumMassError,
      semiMajorAxisAu: semiMajorAxisM / ASTRONOMICAL_UNIT_M,
    };
    if (derived.minimumMassSolar > 0.1 * normalized.primaryMassSolar) warnings.push("companion-mass-not-negligible-m-sin-i-approximation-breaks-down");
  } else warnings.push("primary-mass-not-declared-minimum-mass-not-computed");

  const phaseOf = (time) => common.unitPhase((time - periastron) / period);
  const folded = rows.map((row) => {
    const eligible = row.fitEligible;
    const model = eligible ? keplerianVelocity(bestFit.parameters, row.time) : null;
    return {
      observationId: row.observationId, time: row.time, absoluteTime: row.time === null ? null : row.time + normalized.timeOffsetDays,
      radialVelocityKmS: row.radialVelocityKmS, standardErrorKmS: row.standardErrorKmS,
      fitEligible: eligible, exclusionReasons: row.exclusionReasons, phase: eligible ? phaseOf(row.time) : null,
      model, residual: eligible ? row.radialVelocityKmS - model : null, pull: eligible ? (row.radialVelocityKmS - model) / row.standardErrorKmS : null,
    };
  });
  const modelCurve = Array.from({ length: LIMITS.modelCurvePoints }, (_, index) => {
    const phase = index / (LIMITS.modelCurvePoints - 1);
    return { phase, model: keplerianVelocity(bestFit.parameters, periastron + phase * period) };
  });
  const orbit = {
    periodDays: period, periodErrorDays: errors.period, periodErrorScaledDays: scaled(errors.period),
    semiAmplitudeKmS: semiAmplitude, semiAmplitudeErrorKmS: errors.semiAmplitude, semiAmplitudeErrorScaledKmS: scaled(errors.semiAmplitude),
    eccentricity, eccentricityError: errors.eccentricity, eccentricityErrorScaled: scaled(errors.eccentricity),
    argumentOfPeriastronRad: argument, argumentOfPeriastronDeg: argument * 180 / Math.PI, argumentOfPeriastronErrorRad: errors.argument, argumentOfPeriastronErrorScaledRad: scaled(errors.argument),
    periastronTime: periastron, periastronAbsoluteTime: periastron + normalized.timeOffsetDays, periastronTimeErrorDays: errors.periastron, periastronTimeErrorScaledDays: scaled(errors.periastron),
    systemicVelocityKmS: gamma, systemicVelocityErrorKmS: errors.gamma, systemicVelocityErrorScaledKmS: scaled(errors.gamma),
    chiSquare: bestFit.chiSquare, degreesOfFreedom, reducedChiSquare, pValue: common.chiSquareSurvival(bestFit.chiSquare, degreesOfFreedom),
    residualRmsKmS: residualRms, weightedResidualRms, iterations: bestFit.iterations, converged: bestFit.converged, covariance,
  };
  const settings = {
    targetId: normalized.targetId, timeSystem: normalized.timeSystem, timeOffsetDays: normalized.timeOffsetDays,
    minimumPeriodDays: normalized.minimumPeriodDays, maximumPeriodDays: normalized.maximumPeriodDays, frequencyCount: normalized.frequencyCount,
    primaryMassSolar: normalized.primaryMassSolar, timeOrigin, maximumEccentricity: LIMITS.maxEccentricity, startCount: starts.length,
  };
  const summary = {
    inputRows: rows.length, fitEligibleRows: points.length, excludedRows: rows.length - points.length, baselineDays,
    seed: { periodDays: seedPeriod, power: best.power, semiAmplitudeKmS: seedAmplitude, gammaKmS: seedGamma, gridIndex: best.gridIndex },
    periodDays: period, semiAmplitudeKmS: semiAmplitude, eccentricity, argumentOfPeriastronDeg: orbit.argumentOfPeriastronDeg, systemicVelocityKmS: gamma,
    residualRmsKmS: residualRms, reducedChiSquare, minimumMassJupiter: derived.minimumMassJupiter, semiMajorAxisAu: derived.semiMajorAxisAu,
  };
  const table = common.publicationTable(`${normalized.targetId}: radial-velocity observations and Keplerian residuals`, [
    { key: "observationId", label: "Observation", unit: null, datatype: "string" },
    { key: "absoluteTime", label: `Time (${normalized.timeSystem})`, unit: "day", datatype: "number|null" },
    { key: "phase", label: "Orbital phase (from periastron)", unit: null, datatype: "number|null" },
    { key: "radialVelocityKmS", label: "RV", unit: "km/s", datatype: "number|null" },
    { key: "standardErrorKmS", label: "RV s.e.", unit: "km/s", datatype: "number|null" },
    { key: "model", label: "Keplerian model", unit: "km/s", datatype: "number|null" },
    { key: "residual", label: "O - C", unit: "km/s", datatype: "number|null" },
    { key: "pull", label: "Pull", unit: null, datatype: "number|null" },
    { key: "fitEligible", label: "Fit eligible", unit: null, datatype: "boolean" },
    { key: "exclusionReasons", label: "Exclusion reasons", unit: null, datatype: "string[]" },
  ], folded, [
    `P = ${period.toPrecision(8)} ± ${errors.period === null ? "NA" : errors.period.toPrecision(3)} d, K = ${semiAmplitude.toPrecision(6)} ± ${errors.semiAmplitude === null ? "NA" : errors.semiAmplitude.toPrecision(3)} km/s, e = ${eccentricity.toPrecision(4)} ± ${errors.eccentricity === null ? "NA" : errors.eccentricity.toPrecision(3)}, omega = ${orbit.argumentOfPeriastronDeg.toPrecision(5)} deg, gamma = ${gamma.toPrecision(6)} km/s.`,
    `chi^2 = ${bestFit.chiSquare.toPrecision(5)} for ${degreesOfFreedom} degrees of freedom; residual RMS ${residualRms.toPrecision(4)} km/s.`,
    derived.minimumMassJupiter === null ? "Minimum mass not computed: no primary mass declared." : `m sin i = ${derived.minimumMassJupiter.toPrecision(5)} M_Jup for M_* = ${normalized.primaryMassSolar} M_sun (companion mass assumed negligible).`,
  ]);
  // A Keplerian wobble of a few km/s sits on a systemic velocity of tens: anchored at zero the
  // orbit flattens into the line it is meant to disprove.
  const velocityScale = common.measurementScale();
  const buildFigure = (provenance) => common.publicationFigure(
    `${normalized.targetId}: phase-folded radial velocities with Keplerian orbit`,
    `Upper panel: ${points.length} radial velocities folded on P = ${period.toPrecision(7)} days from periastron with error bars and the best-fitting Keplerian curve (K = ${semiAmplitude.toPrecision(5)} km/s, e = ${eccentricity.toPrecision(3)}). Lower panel: residuals against phase.`,
    {
      $schema: common.VEGA_LITE_SCHEMA_URL,
      description: "Phase-folded radial velocity curve and residuals.",
      vconcat: [
        { width: 680, height: 300, layer: [
          { data: { values: modelCurve }, mark: { type: "line", color: "#C2415D", strokeWidth: 1.8 },
            encoding: { x: { field: "phase", type: "quantitative", title: `Orbital phase (P = ${period.toPrecision(7)} day)`, scale: { domain: [0, 1] } }, y: { field: "model", type: "quantitative", title: "Radial velocity (km/s)", scale: velocityScale } } },
          { data: { values: folded.filter((row) => row.fitEligible).map((row) => ({ observationId: row.observationId, phase: row.phase, lower: row.radialVelocityKmS - row.standardErrorKmS, upper: row.radialVelocityKmS + row.standardErrorKmS })) },
            mark: { type: "rule", color: "#6B7280", strokeWidth: 1 },
            encoding: { x: { field: "phase", type: "quantitative", scale: { domain: [0, 1] } }, y: { field: "lower", type: "quantitative", scale: velocityScale }, y2: { field: "upper" } } },
          { data: { values: folded.filter((row) => row.fitEligible).map((row) => ({ observationId: row.observationId, phase: row.phase, radialVelocityKmS: row.radialVelocityKmS, residual: row.residual })) },
            mark: { type: "point", filled: true, color: "#255C99", size: 56, stroke: "#FFFFFF", strokeWidth: 0.7 },
            encoding: { x: { field: "phase", type: "quantitative", scale: { domain: [0, 1] } }, y: { field: "radialVelocityKmS", type: "quantitative", scale: velocityScale },
              tooltip: [{ field: "observationId", type: "nominal", title: "Observation" }, { field: "phase", type: "quantitative", title: "Phase", format: ".4f" }, { field: "radialVelocityKmS", type: "quantitative", title: "RV (km/s)", format: ".5g" }, { field: "residual", type: "quantitative", title: "O - C (km/s)", format: ".4g" }] } },
        ] },
        { width: 680, height: 120, layer: [
          { data: { values: [{ residual: 0 }] }, mark: { type: "rule", color: "#9CA3AF", strokeDash: [5, 4] }, encoding: { y: { field: "residual", type: "quantitative" } } },
          { data: { values: folded.filter((row) => row.fitEligible).map((row) => ({ phase: row.phase, lower: row.residual - row.standardErrorKmS, upper: row.residual + row.standardErrorKmS })) },
            mark: { type: "rule", color: "#6B7280", strokeWidth: 1 },
            encoding: { x: { field: "phase", type: "quantitative", scale: { domain: [0, 1] } }, y: { field: "lower", type: "quantitative" }, y2: { field: "upper" } } },
          { data: { values: folded.filter((row) => row.fitEligible).map((row) => ({ observationId: row.observationId, phase: row.phase, residual: row.residual })) },
            mark: { type: "point", filled: true, color: "#255C99", size: 48 },
            encoding: { x: { field: "phase", type: "quantitative", title: "Orbital phase", scale: { domain: [0, 1] } }, y: { field: "residual", type: "quantitative", title: "O - C (km/s)" } } },
        ] },
      ],
      spacing: 18,
    },
    provenance,
  );
  return common.finalizeAnalysis({
    schema: SCHEMA, algorithm: ALGORITHM, normalizedInput: normalized, sourceContentSha256: normalized.sourceContentSha256,
    sections: { settings, summary, warnings, boundaries: BOUNDARIES, periodogram, orbit, derived, starts: startResults, folded, modelCurve },
    table, buildFigure,
  });
}

module.exports = {
  RV_ORBIT_ALGORITHM: ALGORITHM,
  RV_ORBIT_BOUNDARIES: BOUNDARIES,
  RV_ORBIT_LIMITS: LIMITS,
  RV_ORBIT_SCHEMA: SCHEMA,
  RV_TIME_SYSTEMS: TIME_SYSTEMS,
  fitRadialVelocityOrbit,
  keplerianVelocity,
};
