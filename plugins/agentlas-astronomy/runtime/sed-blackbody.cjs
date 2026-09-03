"use strict";

/**
 * Single-temperature blackbody fit to broadband photometry: a deterministic
 * temperature grid seed with the analytic optimal scale, then Levenberg–Marquardt
 * on (T, log10 scale) against inverse-variance weighted residuals. Reports T and the
 * solid-angle scale with covariance uncertainties (raw and chi-square scaled), the
 * angular radius, bolometric flux, a residual/pull table, and a log-log SED figure.
 *
 * Flux densities are declared either as F_nu in jansky or F_lambda in
 * erg s^-1 cm^-2 A^-1 at the effective wavelength of each band (micron).
 */

const common = require("./analysis-common.cjs");

const { AstronomyDataError } = common;
const SCHEMA = "agentlas.science.astronomy-sed-blackbody-fit-result/v1";
const PLANCK_J_S = 6.62607015e-34;
const BOLTZMANN_J_K = 1.380649e-23;
const SPEED_OF_LIGHT_M_S = 299792458;
const STEFAN_BOLTZMANN_W_M2_K4 = 5.670374419e-8;
const JANSKY_W_M2_HZ = 1e-26;
/** 1 W m^-2 m^-1 = 1e-7 erg s^-1 cm^-2 A^-1. */
const W_M3_TO_ERG_S_CM2_A = 1e-7;
const FLUX_KINDS = ["F_nu_Jy", "F_lambda_erg_s_cm2_A"];
const LIMITS = common.deepFreeze({ minPoints: 3, maxPoints: 500, minTemperatureK: 100, maxTemperatureK: 1e6, seedGridPoints: 400, modelCurvePoints: 200 });
const ALGORITHM = common.deepFreeze({
  id: "agentlas.astronomy.sed-blackbody-fit",
  version: "1.0.0",
  model: "F = Omega * B(T); B_nu = 2 h nu^3 / c^2 / (exp(h nu / k T) - 1) in W m^-2 Hz^-1 sr^-1 (reported in Jy); B_lambda = 2 h c^2 / lambda^5 / (exp(h c / lambda k T) - 1) in W m^-3 sr^-1 (reported in erg s^-1 cm^-2 A^-1)",
  seed: "400-point logarithmic temperature grid between 100 K and 1e6 K; at each temperature the optimal scale is the weighted linear least-squares solution; the lowest chi-square seeds the nonlinear fit",
  optimizer: "Levenberg-Marquardt on parameters (T, log10 Omega) with central finite-difference Jacobian; residuals r_i = (F_i - model_i) / sigma_i",
  uncertainties: "covariance (J^T J)^-1 at the optimum; scaled uncertainties multiply by sqrt(max(1, chi^2 / dof))",
  derived: "angular radius theta = sqrt(Omega / pi); bolometric flux = Omega sigma_SB T^4 / pi; goodness of fit chi^2, dof = N - 2, chi-square survival p-value",
  constants: { planckJS: PLANCK_J_S, boltzmannJK: BOLTZMANN_J_K, speedOfLightMS: SPEED_OF_LIGHT_M_S, stefanBoltzmannWM2K4: STEFAN_BOLTZMANN_W_M2_K4 },
  references: [
    { title: "Numerical Optimization (Levenberg-Marquardt, Section 10.3)", authors: "J. Nocedal and S. J. Wright", journal: "Springer (2006)", doi: "10.1007/978-0-387-40065-5" },
    { title: "Allen's Astrophysical Quantities, 4th ed. (Planck function)", authors: "A. N. Cox (ed.)", journal: "Springer (2000)", doi: "10.1007/978-1-4612-1186-0" },
  ],
});
const BOUNDARIES = common.deepFreeze([
  "A single blackbody is fitted at the effective wavelength of each band; no filter-transmission integration, colour correction, or extinction is applied.",
  "Photometric calibration systematics (zero points, saturation, variability, blending) are not modelled; supplied uncertainties are taken at face value.",
  "The scale is a solid angle only under the assumption of an unresolved, spherical, uniformly bright source; converting it to a radius needs an independent distance.",
  "Bolometric flux is the analytic blackbody integral, not an integration of the observed points.",
]);

function normalizeInput(input) {
  const code = "astronomy-sed-input-invalid";
  common.exactObject(input, ["sourceContentSha256", "targetId", "fluxKind", "photometry"], code);
  common.requiredOwn(input, ["sourceContentSha256", "targetId", "fluxKind", "photometry"], code);
  const sourceContentSha256 = common.sourceHash(input.sourceContentSha256, "astronomy-sed-source-hash-invalid");
  const targetId = common.text(input.targetId, "astronomy-sed-target-id-invalid", 500);
  const fluxKind = common.enumeration(input.fluxKind, FLUX_KINDS, "astronomy-sed-flux-kind-invalid");
  if (!Array.isArray(input.photometry) || input.photometry.length < LIMITS.minPoints || input.photometry.length > LIMITS.maxPoints) {
    throw new AstronomyDataError("astronomy-sed-photometry-invalid", `photometry must contain ${LIMITS.minPoints} through ${LIMITS.maxPoints} rows`);
  }
  const photometry = input.photometry.map((row, index) => {
    const rowCode = `astronomy-sed-row-${index}`;
    common.exactObject(row, ["pointId", "wavelengthMicron", "fluxDensity", "fluxDensityError", "use"], `${rowCode}-invalid`);
    common.requiredOwn(row, ["pointId", "wavelengthMicron", "fluxDensity", "fluxDensityError", "use"], `${rowCode}-invalid`);
    return {
      pointId: common.text(row.pointId, `${rowCode}-point-id-invalid`, 160),
      wavelengthMicron: common.number(row.wavelengthMicron, `${rowCode}-wavelength-invalid`, 1e-4, 1e6, { minimumExclusive: true }),
      fluxDensity: common.nullableNumber(row.fluxDensity, `${rowCode}-flux-invalid`, -1e30, 1e30),
      fluxDensityError: common.nullableNumber(row.fluxDensityError, `${rowCode}-flux-error-invalid`, 0, 1e30, { minimumExclusive: true }),
      use: common.boolean(row.use, `${rowCode}-use-invalid`),
    };
  }).sort((left, right) => left.wavelengthMicron - right.wavelengthMicron || common.compareText(left.pointId, right.pointId));
  common.uniqueIds(photometry, "pointId", "astronomy-sed-duplicate-point-id");
  return { sourceContentSha256, targetId, fluxKind, photometry };
}

/** Planck function per unit solid angle in the declared flux-density convention. */
function planck(fluxKind, wavelengthMicron, temperatureK) {
  const lambda = wavelengthMicron * 1e-6;
  if (fluxKind === "F_nu_Jy") {
    const nu = SPEED_OF_LIGHT_M_S / lambda;
    const x = PLANCK_J_S * nu / (BOLTZMANN_J_K * temperatureK);
    const value = (2 * PLANCK_J_S * nu ** 3 / SPEED_OF_LIGHT_M_S ** 2) / Math.expm1(x);
    return value / JANSKY_W_M2_HZ;
  }
  const x = PLANCK_J_S * SPEED_OF_LIGHT_M_S / (lambda * BOLTZMANN_J_K * temperatureK);
  const value = (2 * PLANCK_J_S * SPEED_OF_LIGHT_M_S ** 2 / lambda ** 5) / Math.expm1(x);
  return value * W_M3_TO_ERG_S_CM2_A;
}

function fitBlackbodySed(input) {
  const normalized = normalizeInput(input);
  const warnings = [];
  const rows = normalized.photometry.map((row) => {
    const exclusionReasons = [];
    if (!row.use) exclusionReasons.push("user-excluded");
    if (row.fluxDensity === null) exclusionReasons.push("flux-missing");
    if (row.fluxDensityError === null) exclusionReasons.push("flux-error-missing");
    if (row.fluxDensity !== null && row.fluxDensity <= 0) exclusionReasons.push("flux-nonpositive");
    return { ...row, exclusionReasons, fitEligible: exclusionReasons.length === 0 };
  });
  const points = rows.filter((row) => row.fitEligible);
  if (points.length < LIMITS.minPoints) throw new AstronomyDataError("astronomy-sed-insufficient-points", `At least ${LIMITS.minPoints} fit-eligible photometric points are required`, { eligible: points.length });
  const { fluxKind } = normalized;
  const shapes = (temperature) => points.map((point) => planck(fluxKind, point.wavelengthMicron, temperature));
  const optimalScale = (shape) => {
    let numerator = 0; let denominator = 0;
    for (let index = 0; index < points.length; index += 1) {
      const weight = 1 / points[index].fluxDensityError ** 2;
      numerator += weight * shape[index] * points[index].fluxDensity;
      denominator += weight * shape[index] * shape[index];
    }
    return denominator > 0 ? numerator / denominator : 0;
  };
  const chiSquareFor = (shape, scale) => points.reduce((sum, point, index) => sum + ((point.fluxDensity - scale * shape[index]) / point.fluxDensityError) ** 2, 0);

  // Deterministic seed grid.
  let seed = null;
  const logMin = Math.log(LIMITS.minTemperatureK);
  const logMax = Math.log(LIMITS.maxTemperatureK);
  for (let index = 0; index < LIMITS.seedGridPoints; index += 1) {
    const temperature = Math.exp(logMin + (logMax - logMin) * index / (LIMITS.seedGridPoints - 1));
    const shape = shapes(temperature);
    if (!shape.every((value) => Number.isFinite(value) && value > 0)) continue;
    const scale = optimalScale(shape);
    if (!(scale > 0)) continue;
    const chiSquare = chiSquareFor(shape, scale);
    if (seed === null || chiSquare < seed.chiSquare) seed = { temperature, scale, chiSquare };
  }
  if (!seed) throw new AstronomyDataError("astronomy-sed-seed-failed", "No temperature on the seed grid produced a positive finite model");
  if (seed.temperature <= LIMITS.minTemperatureK * 1.01 || seed.temperature >= LIMITS.maxTemperatureK / 1.01) warnings.push("seed-temperature-at-grid-boundary");

  const residualFn = (parameters) => {
    const temperature = parameters[0];
    const scale = 10 ** parameters[1];
    return points.map((point) => (point.fluxDensity - scale * planck(fluxKind, point.wavelengthMicron, temperature)) / point.fluxDensityError);
  };
  const fit = common.levenbergMarquardt(residualFn, [seed.temperature, Math.log10(seed.scale)], {
    maxIterations: 500,
    tolerance: 1e-14,
    steps: [Math.max(1e-3, seed.temperature * 1e-6), 1e-7],
    constrain: (candidate) => [Math.min(LIMITS.maxTemperatureK, Math.max(LIMITS.minTemperatureK, candidate[0])), Math.min(60, Math.max(-60, candidate[1]))],
  });
  if (!fit.converged) warnings.push("levenberg-marquardt-did-not-converge");
  const temperatureK = fit.parameters[0];
  const log10Scale = fit.parameters[1];
  const scale = 10 ** log10Scale;
  const degreesOfFreedom = points.length - 2;
  const reducedChiSquare = degreesOfFreedom > 0 ? fit.chiSquare / degreesOfFreedom : null;
  const inflation = reducedChiSquare !== null ? Math.sqrt(Math.max(1, reducedChiSquare)) : null;
  const covariance = fit.covariance;
  if (!covariance) warnings.push("covariance-singular-uncertainties-unavailable");
  const temperatureError = covariance ? Math.sqrt(Math.max(0, covariance[0][0])) : null;
  const log10ScaleError = covariance ? Math.sqrt(Math.max(0, covariance[1][1])) : null;
  const scaleError = log10ScaleError === null ? null : scale * Math.LN10 * log10ScaleError;
  const correlation = covariance && temperatureError > 0 && log10ScaleError > 0 ? covariance[0][1] / (temperatureError * log10ScaleError) : null;
  if (reducedChiSquare !== null && reducedChiSquare > 3) warnings.push("reduced-chi-square-above-3-single-blackbody-inadequate-or-errors-underestimated");
  if (temperatureK <= LIMITS.minTemperatureK * 1.001 || temperatureK >= LIMITS.maxTemperatureK / 1.001) warnings.push("temperature-at-fit-boundary");
  const angularRadiusRad = Math.sqrt(scale / Math.PI);
  const bolometricFluxWM2 = scale * STEFAN_BOLTZMANN_W_M2_K4 * temperatureK ** 4 / Math.PI;
  const unit = fluxKind === "F_nu_Jy" ? "Jy" : "erg/s/cm^2/A";
  const modelAt = (wavelength) => scale * planck(fluxKind, wavelength, temperatureK);
  const tableRows = rows.map((row) => {
    const model = modelAt(row.wavelengthMicron);
    const residual = row.fluxDensity === null ? null : row.fluxDensity - model;
    const pull = residual === null || row.fluxDensityError === null ? null : residual / row.fluxDensityError;
    return {
      pointId: row.pointId, wavelengthMicron: row.wavelengthMicron, fluxDensity: row.fluxDensity, fluxDensityError: row.fluxDensityError,
      model, residual, pull, fitEligible: row.fitEligible, exclusionReasons: row.exclusionReasons,
    };
  });
  const wavelengths = points.map((point) => point.wavelengthMicron);
  const curveMin = Math.min(...wavelengths) / 2;
  const curveMax = Math.max(...wavelengths) * 2;
  const modelCurve = Array.from({ length: LIMITS.modelCurvePoints }, (_, index) => {
    const wavelength = Math.exp(Math.log(curveMin) + (Math.log(curveMax) - Math.log(curveMin)) * index / (LIMITS.modelCurvePoints - 1));
    return { wavelengthMicron: wavelength, model: modelAt(wavelength) };
  });
  const settings = { targetId: normalized.targetId, fluxKind, fluxUnit: unit, temperatureBoundsK: [LIMITS.minTemperatureK, LIMITS.maxTemperatureK], seedGridPoints: LIMITS.seedGridPoints };
  const summary = {
    inputPoints: rows.length, fitEligiblePoints: points.length, excludedPoints: rows.length - points.length,
    temperatureK, temperatureErrorK: temperatureError, temperatureErrorScaledK: temperatureError === null || inflation === null ? temperatureError : temperatureError * inflation,
    scale, scaleError, scaleErrorScaled: scaleError === null || inflation === null ? scaleError : scaleError * inflation, log10Scale, log10ScaleError,
    temperatureScaleCorrelation: correlation,
    angularRadiusRad, angularRadiusMas: angularRadiusRad / (Math.PI / 648000) * 1000,
    bolometricFluxWM2, bolometricFluxErgSCm2: bolometricFluxWM2 * 1e3,
    chiSquare: fit.chiSquare, degreesOfFreedom, reducedChiSquare, pValue: common.chiSquareSurvival(fit.chiSquare, degreesOfFreedom),
    seed: { temperatureK: seed.temperature, scale: seed.scale, chiSquare: seed.chiSquare }, iterations: fit.iterations, converged: fit.converged,
  };
  const table = common.publicationTable(`${normalized.targetId}: blackbody SED fit residuals (T = ${temperatureK.toPrecision(6)} K)`, [
    { key: "pointId", label: "Band", unit: null, datatype: "string" },
    { key: "wavelengthMicron", label: "Wavelength", unit: "micron", datatype: "number" },
    { key: "fluxDensity", label: "Observed", unit, datatype: "number|null" },
    { key: "fluxDensityError", label: "Observed s.e.", unit, datatype: "number|null" },
    { key: "model", label: "Blackbody model", unit, datatype: "number" },
    { key: "residual", label: "Residual", unit, datatype: "number|null" },
    { key: "pull", label: "Pull", unit: null, datatype: "number|null" },
    { key: "fitEligible", label: "Fit eligible", unit: null, datatype: "boolean" },
    { key: "exclusionReasons", label: "Exclusion reasons", unit: null, datatype: "string[]" },
  ], tableRows, [
    `T = ${temperatureK.toPrecision(6)} ± ${temperatureError === null ? "NA" : temperatureError.toPrecision(3)} K (covariance), chi^2 = ${fit.chiSquare.toPrecision(5)} for ${degreesOfFreedom} degrees of freedom.`,
    "Scaled uncertainties inflate by sqrt(chi^2/dof) when the reduced chi-square exceeds one.",
    "Model values at the effective wavelength; no bandpass integration.",
  ]);
  const buildFigure = (provenance) => common.publicationFigure(
    `${normalized.targetId}: spectral energy distribution with single blackbody`,
    `Log-log spectral energy distribution of ${points.length} fitted photometric points (${unit}) with error bars and the best-fitting blackbody at ${temperatureK.toPrecision(5)} K; excluded points are shown hollow. Lower panel shows the pull of each point.`,
    {
      $schema: common.VEGA_LITE_SCHEMA_URL,
      description: "SED with blackbody model and pulls.",
      vconcat: [
        { width: 680, height: 300, layer: [
          { data: { values: modelCurve }, mark: { type: "line", color: "#C2415D", strokeWidth: 1.8 },
            encoding: { x: { field: "wavelengthMicron", type: "quantitative", title: "Wavelength (micron)", scale: { type: "log" } }, y: { field: "model", type: "quantitative", title: `Flux density (${unit})`, scale: { type: "log" } } } },
          { data: { values: tableRows.filter((row) => row.fitEligible).map((row) => ({ pointId: row.pointId, wavelengthMicron: row.wavelengthMicron, lower: Math.max(row.fluxDensity - row.fluxDensityError, row.fluxDensity * 1e-3), upper: row.fluxDensity + row.fluxDensityError })) },
            mark: { type: "rule", color: "#6B7280", strokeWidth: 1 },
            encoding: { x: { field: "wavelengthMicron", type: "quantitative", scale: { type: "log" } }, y: { field: "lower", type: "quantitative", scale: { type: "log" } }, y2: { field: "upper" } } },
          { data: { values: tableRows.filter((row) => row.fitEligible).map((row) => ({ pointId: row.pointId, wavelengthMicron: row.wavelengthMicron, fluxDensity: row.fluxDensity, pull: row.pull })) },
            mark: { type: "point", filled: true, color: "#255C99", size: 64, stroke: "#FFFFFF", strokeWidth: 0.7 },
            encoding: { x: { field: "wavelengthMicron", type: "quantitative", scale: { type: "log" } }, y: { field: "fluxDensity", type: "quantitative", scale: { type: "log" } },
              tooltip: [{ field: "pointId", type: "nominal", title: "Band" }, { field: "wavelengthMicron", type: "quantitative", title: "Wavelength (micron)", format: ".5g" }, { field: "fluxDensity", type: "quantitative", title: "Observed", format: ".5g" }, { field: "pull", type: "quantitative", title: "Pull", format: ".3f" }] } },
          { data: { values: tableRows.filter((row) => !row.fitEligible && row.fluxDensity !== null && row.fluxDensity > 0).map((row) => ({ pointId: row.pointId, wavelengthMicron: row.wavelengthMicron, fluxDensity: row.fluxDensity })) },
            mark: { type: "point", filled: false, color: "#9CA3AF", size: 64 },
            encoding: { x: { field: "wavelengthMicron", type: "quantitative", scale: { type: "log" } }, y: { field: "fluxDensity", type: "quantitative", scale: { type: "log" } } } },
        ] },
        { width: 680, height: 120, layer: [
          { data: { values: [{ pull: 0 }] }, mark: { type: "rule", color: "#9CA3AF", strokeDash: [5, 4] }, encoding: { y: { field: "pull", type: "quantitative" } } },
          { data: { values: tableRows.filter((row) => row.fitEligible).map((row) => ({ pointId: row.pointId, wavelengthMicron: row.wavelengthMicron, pull: row.pull })) },
            mark: { type: "point", filled: true, color: "#255C99", size: 56 },
            encoding: { x: { field: "wavelengthMicron", type: "quantitative", title: "Wavelength (micron)", scale: { type: "log" } }, y: { field: "pull", type: "quantitative", title: "Pull (sigma)" } } },
        ] },
      ],
      spacing: 18,
    },
    provenance,
  );
  return common.finalizeAnalysis({
    schema: SCHEMA, algorithm: ALGORITHM, normalizedInput: normalized, sourceContentSha256: normalized.sourceContentSha256,
    sections: { settings, summary, warnings, boundaries: BOUNDARIES, rows: tableRows, modelCurve, fit: { parameters: fit.parameters, covariance, iterations: fit.iterations, converged: fit.converged } },
    table, buildFigure,
  });
}

module.exports = {
  SED_BLACKBODY_ALGORITHM: ALGORITHM,
  SED_BLACKBODY_BOUNDARIES: BOUNDARIES,
  SED_BLACKBODY_LIMITS: LIMITS,
  SED_BLACKBODY_SCHEMA: SCHEMA,
  SED_FLUX_KINDS: FLUX_KINDS,
  fitBlackbodySed,
  planck,
};
