"use strict";

/**
 * Flat Lambda-CDM distance calculator (Hogg 1999): comoving, transverse comoving
 * (= comoving in a flat universe), angular-diameter and luminosity distances,
 * distance modulus, lookback time, age at redshift, comoving volume, and the
 * proper-kpc-per-arcsecond scale for explicit redshifts plus a declared z grid.
 *
 * All integrals use adaptive Simpson quadrature in a substituted variable so the
 * integrands are smooth at both ends; the caller declares H0, Omega_m and Omega_r.
 */

const common = require("./analysis-common.cjs");

const { AstronomyDataError } = common;
const SCHEMA = "agentlas.science.astronomy-flat-lambda-cdm-cosmology-result/v1";
const SPEED_OF_LIGHT_KM_S = 299792.458;
/** 1 / (1 km/s/Mpc) expressed in Gyr: (1 Mpc / 1 km) / (Julian year seconds) / 1e9. */
const HUBBLE_TIME_GYR_PER_UNIT_H0 = 977.7922216807891;
const ARCSEC_RAD = Math.PI / 648000;
const LIMITS = common.deepFreeze({ maxRedshifts: 500, minGridCount: 2, maxGridCount: 2000, maxRedshift: 1100, quadratureTolerance: 1e-13 });
const ALGORITHM = common.deepFreeze({
  id: "agentlas.astronomy.flat-lambda-cdm-cosmology",
  version: "1.0.0",
  model: "flat FLRW with matter, radiation and a cosmological constant: E(z) = sqrt(Omega_r (1+z)^4 + Omega_m (1+z)^3 + Omega_Lambda), Omega_Lambda = 1 - Omega_m - Omega_r",
  distances: "D_H = c/H0; D_C = D_H Integral_0^z dz'/E(z'); D_M = D_C (flat); D_A = D_M/(1+z); D_L = (1+z) D_M; mu = 5 log10(D_L/Mpc) + 25 (Hogg 1999 eqs. 14-25)",
  times: "t_H = 1/H0; lookback t_L = t_H Integral_0^z dz'/((1+z') E(z')); age t(z) = t_H Integral_0^{a} da'/(a' E(a')) with a = 1/(1+z) and substitution a' = x^2 (Hogg 1999 eq. 30)",
  volume: "V_C = (4 pi/3) D_M^3 (flat)",
  scale: "proper kpc per arcsecond = D_A [Mpc] * 1000 * (pi/648000)",
  quadrature: "adaptive Simpson with 1e-13 relative tolerance; the comoving integral uses the substitution 1+z = 1/a to avoid large-z stiffness",
  constants: { speedOfLightKmS: SPEED_OF_LIGHT_KM_S, hubbleTimeGyrPerUnitH0: HUBBLE_TIME_GYR_PER_UNIT_H0 },
  references: [
    { title: "Distance measures in cosmology", authors: "D. W. Hogg", journal: "arXiv:astro-ph/9905116 (1999)", doi: "10.48550/arXiv.astro-ph/9905116" },
    { title: "The Cosmological Constant", authors: "S. M. Carroll, W. H. Press and E. L. Turner", journal: "ARA&A 30, 499 (1992)", doi: "10.1146/annurev.aa.30.090192.002435" },
  ],
});
const BOUNDARIES = common.deepFreeze([
  "Only spatially flat models are computed; curvature, dynamical dark energy (w != -1), and massive-neutrino corrections are not modelled.",
  "Radiation density is a declared constant; it is not derived from the CMB temperature or the effective number of neutrino species.",
  "No uncertainty propagation from cosmological-parameter errors is performed; rerun with alternative parameters to bracket systematics.",
  "Redshifts are treated as cosmological; peculiar velocities are not removed.",
]);

function normalizeInput(input) {
  const code = "astronomy-cosmology-input-invalid";
  common.exactObject(input, ["sourceContentSha256", "label", "hubbleConstantKmSMpc", "omegaMatter", "omegaRadiation", "redshifts", "grid"], code);
  common.requiredOwn(input, ["sourceContentSha256", "label", "hubbleConstantKmSMpc", "omegaMatter", "redshifts"], code);
  const sourceContentSha256 = common.sourceHash(input.sourceContentSha256, "astronomy-cosmology-source-hash-invalid");
  const label = common.text(input.label, "astronomy-cosmology-label-invalid", 500);
  const hubbleConstantKmSMpc = common.number(input.hubbleConstantKmSMpc, "astronomy-cosmology-hubble-constant-invalid", 20, 200);
  const omegaMatter = common.number(input.omegaMatter, "astronomy-cosmology-omega-matter-invalid", 0, 1, { minimumExclusive: true });
  const omegaRadiation = common.optional(input.omegaRadiation, 0, (value) => common.number(value, "astronomy-cosmology-omega-radiation-invalid", 0, 0.01));
  const omegaLambda = 1 - omegaMatter - omegaRadiation;
  if (omegaLambda < 0) throw new AstronomyDataError("astronomy-cosmology-density-budget-invalid", "Omega_m + Omega_r must not exceed 1 in a flat model");
  if (!Array.isArray(input.redshifts) || input.redshifts.length > LIMITS.maxRedshifts) throw new AstronomyDataError("astronomy-cosmology-redshifts-invalid", `redshifts must hold at most ${LIMITS.maxRedshifts} values`);
  const redshifts = input.redshifts.map((value, index) => common.number(value, `astronomy-cosmology-redshift-${index}-invalid`, 0, LIMITS.maxRedshift, { minimumExclusive: true }));
  const grid = common.optional(input.grid, { minimumRedshift: 0.01, maximumRedshift: 10, count: 200, spacing: "log" }, (value) => {
    common.exactObject(value, ["minimumRedshift", "maximumRedshift", "count", "spacing"], "astronomy-cosmology-grid-invalid");
    common.requiredOwn(value, ["minimumRedshift", "maximumRedshift", "count", "spacing"], "astronomy-cosmology-grid-invalid");
    const minimumRedshift = common.number(value.minimumRedshift, "astronomy-cosmology-grid-invalid", 0, LIMITS.maxRedshift, { minimumExclusive: true });
    const maximumRedshift = common.number(value.maximumRedshift, "astronomy-cosmology-grid-invalid", 0, LIMITS.maxRedshift, { minimumExclusive: true });
    if (maximumRedshift <= minimumRedshift) throw new AstronomyDataError("astronomy-cosmology-grid-invalid", "maximumRedshift must exceed minimumRedshift");
    return {
      minimumRedshift, maximumRedshift,
      count: common.integer(value.count, "astronomy-cosmology-grid-invalid", LIMITS.minGridCount, LIMITS.maxGridCount),
      spacing: common.enumeration(value.spacing, ["linear", "log"], "astronomy-cosmology-grid-invalid"),
    };
  });
  if (!redshifts.length && !grid) throw new AstronomyDataError("astronomy-cosmology-redshifts-invalid", "at least one redshift or a grid is required");
  return { sourceContentSha256, label, hubbleConstantKmSMpc, omegaMatter, omegaRadiation, omegaLambda, redshifts, grid };
}

function createCosmology(parameters) {
  const { hubbleConstantKmSMpc: H0, omegaMatter, omegaRadiation, omegaLambda } = parameters;
  const hubbleDistanceMpc = SPEED_OF_LIGHT_KM_S / H0;
  const hubbleTimeGyr = HUBBLE_TIME_GYR_PER_UNIT_H0 / H0;
  const E = (z) => Math.sqrt(omegaRadiation * (1 + z) ** 4 + omegaMatter * (1 + z) ** 3 + omegaLambda);
  // Integral_0^z dz'/E(z') with 1+z' = 1/a: = Integral_a^1 da'/(a'^2 E(a')).
  const comovingIntegral = (z) => {
    const a = 1 / (1 + z);
    return common.adaptiveSimpson((ap) => 1 / (ap * ap * E(1 / ap - 1)), a, 1, LIMITS.quadratureTolerance);
  };
  const lookbackIntegral = (z) => {
    const a = 1 / (1 + z);
    return common.adaptiveSimpson((ap) => 1 / (ap * E(1 / ap - 1)), a, 1, LIMITS.quadratureTolerance);
  };
  // Integral_0^a da'/(a' E(a')) with a' = x^2: = Integral_0^{sqrt a} 2 dx/(x E(x^2)); x E(x^2) is finite and smooth at 0.
  const ageIntegral = (z) => {
    const a = 1 / (1 + z);
    const integrand = (x) => {
      if (x === 0) return 0;
      const aa = x * x;
      const xe = Math.sqrt(omegaRadiation / aa ** 3 + omegaMatter / aa ** 2 + omegaLambda * aa);
      return 2 / xe;
    };
    return common.adaptiveSimpson(integrand, 0, Math.sqrt(a), LIMITS.quadratureTolerance);
  };
  const evaluate = (z) => {
    const comovingDistanceMpc = hubbleDistanceMpc * comovingIntegral(z);
    const angularDiameterDistanceMpc = comovingDistanceMpc / (1 + z);
    const luminosityDistanceMpc = comovingDistanceMpc * (1 + z);
    const lookbackTimeGyr = hubbleTimeGyr * lookbackIntegral(z);
    const ageGyr = hubbleTimeGyr * ageIntegral(z);
    return {
      redshift: z,
      hubbleParameterKmSMpc: H0 * E(z),
      comovingDistanceMpc,
      transverseComovingDistanceMpc: comovingDistanceMpc,
      angularDiameterDistanceMpc,
      luminosityDistanceMpc,
      distanceModulusMag: 5 * Math.log10(luminosityDistanceMpc) + 25,
      lookbackTimeGyr,
      ageAtRedshiftGyr: ageGyr,
      comovingVolumeGpc3: (4 * Math.PI / 3) * (comovingDistanceMpc / 1000) ** 3,
      properKpcPerArcsec: angularDiameterDistanceMpc * 1000 * ARCSEC_RAD,
    };
  };
  return { hubbleDistanceMpc, hubbleTimeGyr, ageNowGyr: hubbleTimeGyr * ageIntegral(0), E, evaluate };
}

function computeFlatLambdaCdmCosmology(input) {
  const normalized = normalizeInput(input);
  const cosmology = createCosmology(normalized);
  const warnings = [];
  if (normalized.omegaRadiation === 0 && (normalized.redshifts.some((z) => z > 100) || (normalized.grid && normalized.grid.maximumRedshift > 100))) {
    warnings.push("radiation-neglected-at-high-redshift-lookback-and-age-optimistic");
  }
  const explicitRows = normalized.redshifts.map((z) => cosmology.evaluate(z));
  const gridRows = normalized.grid ? Array.from({ length: normalized.grid.count }, (_, index) => {
    const fraction = index / (normalized.grid.count - 1);
    const z = normalized.grid.spacing === "log"
      ? Math.exp(Math.log(normalized.grid.minimumRedshift) + (Math.log(normalized.grid.maximumRedshift) - Math.log(normalized.grid.minimumRedshift)) * fraction)
      : normalized.grid.minimumRedshift + (normalized.grid.maximumRedshift - normalized.grid.minimumRedshift) * fraction;
    return cosmology.evaluate(index === normalized.grid.count - 1 ? normalized.grid.maximumRedshift : z);
  }) : [];
  const settings = {
    label: normalized.label, hubbleConstantKmSMpc: normalized.hubbleConstantKmSMpc, omegaMatter: normalized.omegaMatter, omegaRadiation: normalized.omegaRadiation,
    omegaLambda: normalized.omegaLambda, grid: normalized.grid, hubbleDistanceMpc: cosmology.hubbleDistanceMpc, hubbleTimeGyr: cosmology.hubbleTimeGyr,
  };
  const summary = {
    explicitRedshiftCount: explicitRows.length,
    gridRowCount: gridRows.length,
    ageOfUniverseGyr: cosmology.ageNowGyr,
    hubbleDistanceMpc: cosmology.hubbleDistanceMpc,
    hubbleTimeGyr: cosmology.hubbleTimeGyr,
  };
  const table = common.publicationTable(`${normalized.label}: flat Lambda-CDM distances (H0 = ${normalized.hubbleConstantKmSMpc}, Omega_m = ${normalized.omegaMatter}, Omega_r = ${normalized.omegaRadiation})`, [
    { key: "redshift", label: "z", unit: null, datatype: "number" },
    { key: "comovingDistanceMpc", label: "D_C", unit: "Mpc", datatype: "number" },
    { key: "angularDiameterDistanceMpc", label: "D_A", unit: "Mpc", datatype: "number" },
    { key: "luminosityDistanceMpc", label: "D_L", unit: "Mpc", datatype: "number" },
    { key: "distanceModulusMag", label: "Distance modulus", unit: "mag", datatype: "number" },
    { key: "lookbackTimeGyr", label: "Lookback time", unit: "Gyr", datatype: "number" },
    { key: "ageAtRedshiftGyr", label: "Age at z", unit: "Gyr", datatype: "number" },
    { key: "properKpcPerArcsec", label: "Scale", unit: "kpc/arcsec", datatype: "number" },
    { key: "comovingVolumeGpc3", label: "Comoving volume", unit: "Gpc^3", datatype: "number" },
  ], explicitRows, [
    `Age of the universe at z = 0 is ${cosmology.ageNowGyr.toPrecision(6)} Gyr for the declared parameters.`,
    "Flat geometry: transverse comoving distance equals comoving distance.",
  ]);
  const curveRows = (gridRows.length ? gridRows : explicitRows).flatMap((row) => [
    { redshift: row.redshift, quantity: "D_C", distanceMpc: row.comovingDistanceMpc },
    { redshift: row.redshift, quantity: "D_A", distanceMpc: row.angularDiameterDistanceMpc },
    { redshift: row.redshift, quantity: "D_L", distanceMpc: row.luminosityDistanceMpc },
  ]);
  const timeRows = (gridRows.length ? gridRows : explicitRows).flatMap((row) => [
    { redshift: row.redshift, quantity: "lookback time", timeGyr: row.lookbackTimeGyr },
    { redshift: row.redshift, quantity: "age at z", timeGyr: row.ageAtRedshiftGyr },
  ]);
  const buildFigure = (provenance) => common.publicationFigure(
    `${normalized.label}: flat Lambda-CDM distances and times versus redshift`,
    `Two-panel figure. Upper panel: comoving, angular-diameter and luminosity distances in Mpc versus redshift on a logarithmic redshift axis for H0 = ${normalized.hubbleConstantKmSMpc} km/s/Mpc, Omega_m = ${normalized.omegaMatter}. Lower panel: lookback time and age at redshift in Gyr. ${explicitRows.length} explicit redshifts are marked as points.`,
    {
      $schema: common.VEGA_LITE_SCHEMA_URL,
      description: "Flat Lambda-CDM distance and time curves.",
      vconcat: [
        { width: 680, height: 260, layer: [
          { data: { values: curveRows }, mark: { type: "line", strokeWidth: 1.8 },
            encoding: { x: { field: "redshift", type: "quantitative", title: "Redshift z", scale: { type: "log" } }, y: { field: "distanceMpc", type: "quantitative", title: "Distance (Mpc)", scale: { type: "log" } },
              color: { field: "quantity", type: "nominal", title: "Distance", scale: { domain: ["D_C", "D_A", "D_L"], range: ["#255C99", "#C2415D", "#111827"] } } } },
          { data: { values: explicitRows.map((row) => ({ redshift: row.redshift, distanceMpc: row.luminosityDistanceMpc, quantity: "D_L", distanceModulusMag: row.distanceModulusMag })) },
            mark: { type: "point", filled: true, size: 60, color: "#111827" },
            encoding: { x: { field: "redshift", type: "quantitative", scale: { type: "log" } }, y: { field: "distanceMpc", type: "quantitative", scale: { type: "log" } },
              tooltip: [{ field: "redshift", type: "quantitative", title: "z", format: ".5g" }, { field: "distanceMpc", type: "quantitative", title: "D_L (Mpc)", format: ".6g" }, { field: "distanceModulusMag", type: "quantitative", title: "mu (mag)", format: ".4f" }] } },
        ] },
        { width: 680, height: 220, layer: [
          { data: { values: timeRows }, mark: { type: "line", strokeWidth: 1.8 },
            encoding: { x: { field: "redshift", type: "quantitative", title: "Redshift z", scale: { type: "log" } }, y: { field: "timeGyr", type: "quantitative", title: "Time (Gyr)" },
              color: { field: "quantity", type: "nominal", title: "Time", scale: { domain: ["lookback time", "age at z"], range: ["#255C99", "#C2415D"] } } } },
        ] },
      ],
      spacing: 22,
    },
    provenance,
  );
  return common.finalizeAnalysis({
    schema: SCHEMA, algorithm: ALGORITHM, normalizedInput: normalized, sourceContentSha256: normalized.sourceContentSha256,
    sections: { settings, summary, warnings, boundaries: BOUNDARIES, explicitRows, gridRows },
    table, buildFigure,
  });
}

module.exports = {
  COSMOLOGY_ALGORITHM: ALGORITHM,
  COSMOLOGY_BOUNDARIES: BOUNDARIES,
  COSMOLOGY_LIMITS: LIMITS,
  COSMOLOGY_SCHEMA: SCHEMA,
  HUBBLE_TIME_GYR_PER_UNIT_H0,
  SPEED_OF_LIGHT_KM_S,
  computeFlatLambdaCdmCosmology,
  createCosmology,
};
