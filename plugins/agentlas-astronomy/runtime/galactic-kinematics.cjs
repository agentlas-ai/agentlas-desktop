"use strict";

/**
 * Galactic space velocities from astrometry and radial velocities: inverse-parallax
 * distance with a fractional-error guard, tangential velocity, heliocentric UVW after
 * Johnson & Soderblom (1987) with the J2000/ICRS Galactic pole, first-order error
 * propagation (J&S eq. 2), LSR correction, a Toomre diagram, and a Bensby-style
 * thin-disc / thick-disc / halo kinematic membership screen.
 *
 * Proper motions are the tangent-plane components mu_alpha* = mu_alpha cos(delta) and
 * mu_delta in mas/yr; parallaxes are in mas; radial velocities in km/s.
 */

const common = require("./analysis-common.cjs");

const { AstronomyDataError } = common;
const SCHEMA = "agentlas.science.astronomy-galactic-kinematics-result/v1";
const KM_S_PER_AU_YR = 4.740470463533348;
const DEG = Math.PI / 180;
/** Galactic pole and node in ICRS (Perryman et al. 1997, Hipparcos Vol. 1 Sect. 1.5.3; Reid & Brunthaler 2004). */
const GALACTIC_FRAME = common.deepFreeze({ raNgpDeg: 192.85948, decNgpDeg: 27.12825, thetaZeroDeg: 122.93192 });
const DEFAULT_SOLAR_MOTION = common.deepFreeze({ uKmS: 11.1, vKmS: 12.24, wKmS: 7.25 });
const DEFAULT_POPULATIONS = common.deepFreeze([
  { id: "thin-disc", fraction: 0.85, sigmaUKmS: 35, sigmaVKmS: 20, sigmaWKmS: 16, asymmetricDriftKmS: -15 },
  { id: "thick-disc", fraction: 0.08, sigmaUKmS: 67, sigmaVKmS: 38, sigmaWKmS: 35, asymmetricDriftKmS: -46 },
  { id: "halo", fraction: 0.06, sigmaUKmS: 160, sigmaVKmS: 90, sigmaWKmS: 90, asymmetricDriftKmS: -220 },
]);
const EXCLUSION_REASONS = common.deepFreeze([
  "user-excluded", "position-missing", "parallax-missing", "parallax-nonpositive", "parallax-error-missing",
  "parallax-fractional-error-exceeded", "proper-motion-missing", "proper-motion-error-missing",
  "radial-velocity-missing", "radial-velocity-error-missing",
]);
const LIMITS = common.deepFreeze({ minRows: 1, maxRows: 2000, toomreArcsKmS: [50, 100, 150, 200] });
const ALGORITHM = common.deepFreeze({
  id: "agentlas.astronomy.galactic-kinematics",
  version: "1.0.0",
  distance: "d[pc] = 1000 / parallax[mas] for positive parallaxes; sigma_d = d * sigma_parallax / parallax (first order); rows with sigma_parallax/parallax above the declared threshold are reported but excluded from inference",
  tangentialVelocity: "v_t[km/s] = 4.740470463533348 * mu[mas/yr] / parallax[mas], mu = sqrt(mu_alpha*^2 + mu_delta^2)",
  spaceVelocity: "Johnson & Soderblom (1987) eq. 1 with the J2000/ICRS Galactic pole (alpha_NGP = 192.85948, delta_NGP = 27.12825, theta_0 = 122.93192 deg); U positive toward the Galactic centre, V toward rotation, W toward the north Galactic pole",
  errorPropagation: "Johnson & Soderblom (1987) eq. 2: first-order propagation of sigma_rv, sigma_mu_alpha*, sigma_mu_delta, sigma_parallax with the parallax-induced covariance term; correlations between astrometric parameters are assumed zero",
  localStandardOfRest: "(U, V, W)_LSR = (U, V, W) + (U, V, W)_sun with the declared solar motion (default Schoenrich, Binney & Dehnen 2010: 11.1, 12.24, 7.25 km/s)",
  toomre: "x = V_LSR, y = sqrt(U_LSR^2 + W_LSR^2); constant-total-velocity arcs at 50, 100, 150, 200 km/s",
  membership: "Bensby et al. (2003, 2014) Gaussian velocity-ellipsoid likelihoods f_i = X_i k_i exp(-U_LSR^2/(2 sigma_U^2) - (V_LSR - V_asym)^2/(2 sigma_V^2) - W_LSR^2/(2 sigma_W^2)); ratios TD/D and TD/H; labels thin (TD/D < 0.5), thick (TD/D > 2), in-between otherwise, halo when TD/H < 1",
  references: [
    { title: "Calculating galactic space velocities and their uncertainties, with an application to the Ursa Major group", authors: "D. R. H. Johnson and D. R. Soderblom", journal: "AJ 93, 864 (1987)", doi: "10.1086/114370" },
    { title: "Local kinematics and the local standard of rest", authors: "R. Schoenrich, J. Binney and W. Dehnen", journal: "MNRAS 403, 1829 (2010)", doi: "10.1111/j.1365-2966.2010.16253.x" },
    { title: "Elemental abundance trends in the Galactic thin and thick disks as traced by nearby F and G dwarf stars", authors: "T. Bensby, S. Feltzing and I. Lundstroem", journal: "A&A 410, 527 (2003)", doi: "10.1051/0004-6361:20031213" },
    { title: "Exploring the Milky Way stellar disk", authors: "T. Bensby, S. Feltzing and M. S. Oey", journal: "A&A 562, A71 (2014)", doi: "10.1051/0004-6361/201322631" },
  ],
});
const BOUNDARIES = common.deepFreeze([
  "Distance is the naive inverse parallax, not a Bayesian distance; the fractional-error guard limits, but does not remove, the inverse-parallax bias.",
  "Uncertainties are first-order (delta-method) and assume uncorrelated astrometric parameters; Gaia-style correlation coefficients are not consumed.",
  "Membership ratios depend entirely on the declared population parameters (velocity dispersions, asymmetric drifts, normalisations); the defaults are literature values that the caller must confirm for the sample in hand.",
  "No Galactic potential, orbit integration, or age information is used; kinematic membership is a screen, not a population assignment.",
  "Proper motions must already include the cos(delta) factor in the right-ascension component.",
]);

function normalizeRow(row, index) {
  const code = `astronomy-galactic-kinematics-row-${index}`;
  common.exactObject(row, [
    "objectId", "raDeg", "decDeg", "parallaxMas", "parallaxErrorMas", "pmRaMasYr", "pmRaErrorMasYr", "pmDecMasYr", "pmDecErrorMasYr",
    "radialVelocityKmS", "radialVelocityErrorKmS", "use",
  ], `${code}-invalid`);
  common.requiredOwn(row, [
    "objectId", "raDeg", "decDeg", "parallaxMas", "parallaxErrorMas", "pmRaMasYr", "pmRaErrorMasYr", "pmDecMasYr", "pmDecErrorMasYr",
    "radialVelocityKmS", "radialVelocityErrorKmS", "use",
  ], `${code}-invalid`);
  return {
    objectId: common.text(row.objectId, `${code}-object-id-invalid`, 160),
    raDeg: common.nullableNumber(row.raDeg, `${code}-ra-invalid`, 0, 360, { maximumExclusive: true }),
    decDeg: common.nullableNumber(row.decDeg, `${code}-dec-invalid`, -90, 90),
    parallaxMas: common.nullableNumber(row.parallaxMas, `${code}-parallax-invalid`, -1e4, 1e4),
    parallaxErrorMas: common.nullableNumber(row.parallaxErrorMas, `${code}-parallax-error-invalid`, 0, 1e4, { minimumExclusive: true }),
    pmRaMasYr: common.nullableNumber(row.pmRaMasYr, `${code}-pm-ra-invalid`, -1e6, 1e6),
    pmRaErrorMasYr: common.nullableNumber(row.pmRaErrorMasYr, `${code}-pm-ra-error-invalid`, 0, 1e6, { minimumExclusive: true }),
    pmDecMasYr: common.nullableNumber(row.pmDecMasYr, `${code}-pm-dec-invalid`, -1e6, 1e6),
    pmDecErrorMasYr: common.nullableNumber(row.pmDecErrorMasYr, `${code}-pm-dec-error-invalid`, 0, 1e6, { minimumExclusive: true }),
    radialVelocityKmS: common.nullableNumber(row.radialVelocityKmS, `${code}-rv-invalid`, -1e5, 1e5),
    radialVelocityErrorKmS: common.nullableNumber(row.radialVelocityErrorKmS, `${code}-rv-error-invalid`, 0, 1e5, { minimumExclusive: true }),
    use: common.boolean(row.use, `${code}-use-invalid`),
  };
}

function normalizePopulation(value, index) {
  const code = `astronomy-galactic-kinematics-population-${index}-invalid`;
  common.exactObject(value, ["id", "fraction", "sigmaUKmS", "sigmaVKmS", "sigmaWKmS", "asymmetricDriftKmS"], code);
  common.requiredOwn(value, ["id", "fraction", "sigmaUKmS", "sigmaVKmS", "sigmaWKmS", "asymmetricDriftKmS"], code);
  return {
    id: common.text(value.id, code, 40),
    fraction: common.number(value.fraction, code, 0, 1, { minimumExclusive: true }),
    sigmaUKmS: common.number(value.sigmaUKmS, code, 0, 1e4, { minimumExclusive: true }),
    sigmaVKmS: common.number(value.sigmaVKmS, code, 0, 1e4, { minimumExclusive: true }),
    sigmaWKmS: common.number(value.sigmaWKmS, code, 0, 1e4, { minimumExclusive: true }),
    asymmetricDriftKmS: common.number(value.asymmetricDriftKmS, code, -1e4, 1e4),
  };
}

function normalizeInput(input) {
  const code = "astronomy-galactic-kinematics-input-invalid";
  common.exactObject(input, ["sourceContentSha256", "sampleId", "measurements", "maxFractionalParallaxError", "solarMotion", "populations"], code);
  common.requiredOwn(input, ["sourceContentSha256", "sampleId", "measurements"], code);
  const sourceContentSha256 = common.sourceHash(input.sourceContentSha256, "astronomy-galactic-kinematics-source-hash-invalid");
  const sampleId = common.text(input.sampleId, "astronomy-galactic-kinematics-sample-id-invalid", 500);
  if (!Array.isArray(input.measurements) || input.measurements.length < LIMITS.minRows || input.measurements.length > LIMITS.maxRows) {
    throw new AstronomyDataError("astronomy-galactic-kinematics-measurements-invalid", `measurements must contain ${LIMITS.minRows} through ${LIMITS.maxRows} rows`);
  }
  const measurements = input.measurements.map(normalizeRow).sort((left, right) => common.compareText(left.objectId, right.objectId));
  common.uniqueIds(measurements, "objectId", "astronomy-galactic-kinematics-duplicate-object-id");
  const maxFractionalParallaxError = common.optional(input.maxFractionalParallaxError, 0.2, (value) => common.number(value, "astronomy-galactic-kinematics-threshold-invalid", 0.01, 1));
  const solarMotion = common.optional(input.solarMotion, DEFAULT_SOLAR_MOTION, (value) => {
    common.exactObject(value, ["uKmS", "vKmS", "wKmS"], "astronomy-galactic-kinematics-solar-motion-invalid");
    common.requiredOwn(value, ["uKmS", "vKmS", "wKmS"], "astronomy-galactic-kinematics-solar-motion-invalid");
    return {
      uKmS: common.number(value.uKmS, "astronomy-galactic-kinematics-solar-motion-invalid", -100, 100),
      vKmS: common.number(value.vKmS, "astronomy-galactic-kinematics-solar-motion-invalid", -100, 100),
      wKmS: common.number(value.wKmS, "astronomy-galactic-kinematics-solar-motion-invalid", -100, 100),
    };
  });
  const populations = common.optional(input.populations, DEFAULT_POPULATIONS, (value) => {
    if (!Array.isArray(value) || value.length < 2 || value.length > 6) throw new AstronomyDataError("astronomy-galactic-kinematics-populations-invalid");
    const normalized = value.map(normalizePopulation);
    if (new Set(normalized.map((population) => population.id)).size !== normalized.length) throw new AstronomyDataError("astronomy-galactic-kinematics-populations-invalid", "population ids must be unique");
    if (!normalized.some((population) => population.id === "thin-disc") || !normalized.some((population) => population.id === "thick-disc")) {
      throw new AstronomyDataError("astronomy-galactic-kinematics-populations-invalid", "populations must include thin-disc and thick-disc");
    }
    return normalized;
  });
  return { sourceContentSha256, sampleId, measurements, maxFractionalParallaxError, solarMotion, populations };
}

/** Equatorial (ICRS) to Galactic rotation matrix built from the declared pole and node. */
function galacticRotation(frame) {
  const raNgp = frame.raNgpDeg * DEG;
  const decNgp = frame.decNgpDeg * DEG;
  const theta = frame.thetaZeroDeg * DEG;
  const t1 = [[Math.cos(theta), -Math.sin(theta), 0], [Math.sin(theta), Math.cos(theta), 0], [0, 0, 1]];
  const t2 = [[-Math.sin(decNgp), 0, Math.cos(decNgp)], [0, -1, 0], [Math.cos(decNgp), 0, Math.sin(decNgp)]];
  const t3 = [[Math.cos(raNgp), Math.sin(raNgp), 0], [-Math.sin(raNgp), Math.cos(raNgp), 0], [0, 0, 1]];
  const multiply = (left, right) => left.map((row) => right[0].map((_, column) => row.reduce((sum, value, k) => sum + value * right[k][column], 0)));
  return multiply(multiply(t1, t2), t3);
}

function spaceVelocity(T, row) {
  const ra = row.raDeg * DEG;
  const dec = row.decDeg * DEG;
  const A = [
    [Math.cos(ra) * Math.cos(dec), -Math.sin(ra), -Math.cos(ra) * Math.sin(dec)],
    [Math.sin(ra) * Math.cos(dec), Math.cos(ra), -Math.sin(ra) * Math.sin(dec)],
    [Math.sin(dec), 0, Math.cos(dec)],
  ];
  const B = T.map((tRow) => A[0].map((_, column) => tRow.reduce((sum, value, k) => sum + value * A[k][column], 0)));
  const k = KM_S_PER_AU_YR / row.parallaxMas;
  const vector = [row.radialVelocityKmS, k * row.pmRaMasYr, k * row.pmDecMasYr];
  const velocity = B.map((bRow) => bRow.reduce((sum, value, index) => sum + value * vector[index], 0));
  const parallaxRatio = row.parallaxErrorMas / row.parallaxMas;
  const errorVector = [
    row.radialVelocityErrorKmS ** 2,
    k * k * (row.pmRaErrorMasYr ** 2 + (row.pmRaMasYr * parallaxRatio) ** 2),
    k * k * (row.pmDecErrorMasYr ** 2 + (row.pmDecMasYr * parallaxRatio) ** 2),
  ];
  const covarianceTerm = 2 * row.pmRaMasYr * row.pmDecMasYr * (KM_S_PER_AU_YR ** 2) * (row.parallaxErrorMas ** 2) / (row.parallaxMas ** 4);
  const variance = B.map((bRow) => bRow.reduce((sum, value, index) => sum + value * value * errorVector[index], 0) + covarianceTerm * bRow[1] * bRow[2]);
  return { velocity, sigma: variance.map((value) => Math.sqrt(Math.max(0, value))), B };
}

function analyzeGalacticKinematics(input) {
  const normalized = normalizeInput(input);
  const T = galacticRotation(GALACTIC_FRAME);
  const warnings = [];
  const rows = normalized.measurements.map((row) => {
    const exclusionReasons = [];
    if (!row.use) exclusionReasons.push("user-excluded");
    if (row.raDeg === null || row.decDeg === null) exclusionReasons.push("position-missing");
    if (row.parallaxMas === null) exclusionReasons.push("parallax-missing");
    else if (row.parallaxMas <= 0) exclusionReasons.push("parallax-nonpositive");
    if (row.parallaxErrorMas === null) exclusionReasons.push("parallax-error-missing");
    const fractionalParallaxError = row.parallaxMas !== null && row.parallaxMas > 0 && row.parallaxErrorMas !== null ? row.parallaxErrorMas / row.parallaxMas : null;
    if (fractionalParallaxError !== null && fractionalParallaxError > normalized.maxFractionalParallaxError) exclusionReasons.push("parallax-fractional-error-exceeded");
    if (row.pmRaMasYr === null || row.pmDecMasYr === null) exclusionReasons.push("proper-motion-missing");
    if (row.pmRaErrorMasYr === null || row.pmDecErrorMasYr === null) exclusionReasons.push("proper-motion-error-missing");
    if (row.radialVelocityKmS === null) exclusionReasons.push("radial-velocity-missing");
    if (row.radialVelocityErrorKmS === null) exclusionReasons.push("radial-velocity-error-missing");
    const distanceEligible = row.parallaxMas !== null && row.parallaxMas > 0;
    const distancePc = distanceEligible ? 1000 / row.parallaxMas : null;
    const distanceErrorPc = distanceEligible && row.parallaxErrorMas !== null ? distancePc * row.parallaxErrorMas / row.parallaxMas : null;
    const totalProperMotion = row.pmRaMasYr !== null && row.pmDecMasYr !== null ? Math.hypot(row.pmRaMasYr, row.pmDecMasYr) : null;
    const tangentialVelocityKmS = distanceEligible && totalProperMotion !== null ? KM_S_PER_AU_YR * totalProperMotion / row.parallaxMas : null;
    let tangentialVelocityErrorKmS = null;
    if (tangentialVelocityKmS !== null && row.pmRaErrorMasYr !== null && row.pmDecErrorMasYr !== null && row.parallaxErrorMas !== null && totalProperMotion > 0) {
      const muVariance = ((row.pmRaMasYr * row.pmRaErrorMasYr) ** 2 + (row.pmDecMasYr * row.pmDecErrorMasYr) ** 2) / totalProperMotion ** 2;
      tangentialVelocityErrorKmS = tangentialVelocityKmS * Math.sqrt(muVariance / totalProperMotion ** 2 + (row.parallaxErrorMas / row.parallaxMas) ** 2);
    }
    const inferenceEligible = exclusionReasons.length === 0;
    const base = {
      ...row, exclusionReasons, inferenceEligible, fractionalParallaxError, distancePc, distanceErrorPc, totalProperMotionMasYr: totalProperMotion,
      tangentialVelocityKmS, tangentialVelocityErrorKmS,
      uKmS: null, vKmS: null, wKmS: null, uErrorKmS: null, vErrorKmS: null, wErrorKmS: null,
      uLsrKmS: null, vLsrKmS: null, wLsrKmS: null, totalSpaceVelocityKmS: null, totalSpaceVelocityLsrKmS: null, toomreYKmS: null,
      membership: null, thickToThinRatio: null, thickToHaloRatio: null, populationLikelihoods: null,
    };
    if (!inferenceEligible) return base;
    const { velocity, sigma } = spaceVelocity(T, row);
    const lsr = [velocity[0] + normalized.solarMotion.uKmS, velocity[1] + normalized.solarMotion.vKmS, velocity[2] + normalized.solarMotion.wKmS];
    const likelihoods = normalized.populations.map((population) => {
      const k = 1 / (Math.pow(2 * Math.PI, 1.5) * population.sigmaUKmS * population.sigmaVKmS * population.sigmaWKmS);
      const exponent = -(lsr[0] ** 2) / (2 * population.sigmaUKmS ** 2)
        - ((lsr[1] - population.asymmetricDriftKmS) ** 2) / (2 * population.sigmaVKmS ** 2)
        - (lsr[2] ** 2) / (2 * population.sigmaWKmS ** 2);
      return { id: population.id, likelihood: population.fraction * k * Math.exp(exponent) };
    });
    const byId = new Map(likelihoods.map((entry) => [entry.id, entry.likelihood]));
    const thin = byId.get("thin-disc");
    const thick = byId.get("thick-disc");
    const halo = byId.has("halo") ? byId.get("halo") : null;
    const thickToThin = thin > 0 ? thick / thin : (thick > 0 ? Infinity : null);
    const thickToHalo = halo === null ? null : (halo > 0 ? thick / halo : (thick > 0 ? Infinity : null));
    let membership = "undetermined";
    if (thickToThin !== null) {
      if (thickToHalo !== null && Number.isFinite(thickToHalo) && thickToHalo < 1) membership = "halo";
      else if (thickToThin > 2) membership = "thick-disc";
      else if (thickToThin < 0.5) membership = "thin-disc";
      else membership = "in-between";
    }
    return {
      ...base,
      uKmS: velocity[0], vKmS: velocity[1], wKmS: velocity[2], uErrorKmS: sigma[0], vErrorKmS: sigma[1], wErrorKmS: sigma[2],
      uLsrKmS: lsr[0], vLsrKmS: lsr[1], wLsrKmS: lsr[2],
      totalSpaceVelocityKmS: Math.hypot(velocity[0], velocity[1], velocity[2]),
      totalSpaceVelocityLsrKmS: Math.hypot(lsr[0], lsr[1], lsr[2]),
      toomreYKmS: Math.hypot(lsr[0], lsr[2]),
      membership,
      thickToThinRatio: thickToThin === null || !Number.isFinite(thickToThin) ? null : thickToThin,
      thickToHaloRatio: thickToHalo === null || !Number.isFinite(thickToHalo) ? null : thickToHalo,
      populationLikelihoods: likelihoods,
    };
  });
  const eligible = rows.filter((row) => row.inferenceEligible);
  if (!eligible.length) warnings.push("no-row-eligible-for-space-velocity-inference");
  if (rows.some((row) => row.exclusionReasons.includes("parallax-fractional-error-exceeded"))) warnings.push("rows-excluded-by-parallax-fractional-error-guard");
  if (rows.some((row) => row.fractionalParallaxError !== null && row.fractionalParallaxError > 0.1 && row.inferenceEligible)) warnings.push("inverse-parallax-bias-exceeds-ten-percent-for-some-rows");
  if (eligible.some((row) => row.membership === "in-between")) warnings.push("some-rows-have-ambiguous-disc-membership");
  const membershipCounts = Object.fromEntries(["thin-disc", "thick-disc", "in-between", "halo", "undetermined"].map((label) => [label, eligible.filter((row) => row.membership === label).length]));
  const summary = {
    inputRows: rows.length,
    inferenceEligibleRows: eligible.length,
    excludedRows: rows.length - eligible.length,
    exclusionCounts: Object.fromEntries(EXCLUSION_REASONS.map((reason) => [reason, rows.filter((row) => row.exclusionReasons.includes(reason)).length])),
    membershipCounts,
    medianTotalSpaceVelocityLsrKmS: eligible.length ? common.median(eligible.map((row) => row.totalSpaceVelocityLsrKmS)) : null,
    maxTotalSpaceVelocityLsrKmS: eligible.length ? Math.max(...eligible.map((row) => row.totalSpaceVelocityLsrKmS)) : null,
  };
  const settings = {
    sampleId: normalized.sampleId, maxFractionalParallaxError: normalized.maxFractionalParallaxError, solarMotion: normalized.solarMotion,
    populations: normalized.populations, galacticFrame: GALACTIC_FRAME, kmSPerAuYr: KM_S_PER_AU_YR, rotationMatrix: T,
  };
  const table = common.publicationTable(`${normalized.sampleId}: Galactic space velocities and kinematic membership`, [
    { key: "objectId", label: "Object", unit: null, datatype: "string" },
    { key: "distancePc", label: "Distance", unit: "pc", datatype: "number|null" },
    { key: "distanceErrorPc", label: "Distance s.e.", unit: "pc", datatype: "number|null" },
    { key: "tangentialVelocityKmS", label: "v_t", unit: "km/s", datatype: "number|null" },
    { key: "tangentialVelocityErrorKmS", label: "v_t s.e.", unit: "km/s", datatype: "number|null" },
    { key: "uLsrKmS", label: "U_LSR", unit: "km/s", datatype: "number|null" },
    { key: "uErrorKmS", label: "U s.e.", unit: "km/s", datatype: "number|null" },
    { key: "vLsrKmS", label: "V_LSR", unit: "km/s", datatype: "number|null" },
    { key: "vErrorKmS", label: "V s.e.", unit: "km/s", datatype: "number|null" },
    { key: "wLsrKmS", label: "W_LSR", unit: "km/s", datatype: "number|null" },
    { key: "wErrorKmS", label: "W s.e.", unit: "km/s", datatype: "number|null" },
    { key: "totalSpaceVelocityLsrKmS", label: "v_total (LSR)", unit: "km/s", datatype: "number|null" },
    { key: "thickToThinRatio", label: "TD/D", unit: null, datatype: "number|null" },
    { key: "thickToHaloRatio", label: "TD/H", unit: null, datatype: "number|null" },
    { key: "membership", label: "Kinematic membership", unit: null, datatype: "string|null" },
    { key: "inferenceEligible", label: "Inference eligible", unit: null, datatype: "boolean" },
    { key: "exclusionReasons", label: "Exclusion reasons", unit: null, datatype: "string[]" },
  ], rows.map((row) => ({
    objectId: row.objectId, distancePc: row.distancePc, distanceErrorPc: row.distanceErrorPc,
    tangentialVelocityKmS: row.tangentialVelocityKmS, tangentialVelocityErrorKmS: row.tangentialVelocityErrorKmS,
    uLsrKmS: row.uLsrKmS, uErrorKmS: row.uErrorKmS, vLsrKmS: row.vLsrKmS, vErrorKmS: row.vErrorKmS, wLsrKmS: row.wLsrKmS, wErrorKmS: row.wErrorKmS,
    totalSpaceVelocityLsrKmS: row.totalSpaceVelocityLsrKmS, thickToThinRatio: row.thickToThinRatio, thickToHaloRatio: row.thickToHaloRatio,
    membership: row.membership, inferenceEligible: row.inferenceEligible, exclusionReasons: row.exclusionReasons,
  })), [
    `U, V, W are heliocentric (Johnson & Soderblom 1987, J2000 pole); LSR values add the declared solar motion (${normalized.solarMotion.uKmS}, ${normalized.solarMotion.vKmS}, ${normalized.solarMotion.wKmS}) km/s.`,
    `Rows with sigma_parallax/parallax > ${normalized.maxFractionalParallaxError} are excluded from inference; distances remain naive inverse parallaxes.`,
    "TD/D and TD/H follow the Bensby et al. velocity-ellipsoid likelihoods with the declared population parameters; labels are kinematic screens only.",
  ]);
  const arcs = LIMITS.toomreArcsKmS.flatMap((radius) => Array.from({ length: 61 }, (_, index) => {
    const angle = Math.PI * index / 60;
    return { arcKmS: radius, vLsrKmS: -radius * Math.cos(angle), toomreYKmS: radius * Math.sin(angle), order: index };
  }));
  const buildFigure = (provenance) => common.publicationFigure(
    `${normalized.sampleId}: Toomre diagram`,
    `Toomre diagram of ${eligible.length} stars: horizontal axis V_LSR, vertical axis sqrt(U_LSR^2 + W_LSR^2), error bars from first-order propagation, points coloured by kinematic membership, with dashed arcs of constant total LSR velocity at ${LIMITS.toomreArcsKmS.join(", ")} km/s.`,
    {
      $schema: common.VEGA_LITE_SCHEMA_URL,
      description: "Toomre diagram with membership colouring and constant-velocity arcs.",
      width: 640, height: 420,
      layer: [
        { data: { values: arcs }, mark: { type: "line", color: "#9CA3AF", strokeDash: [5, 4], strokeWidth: 1 },
          encoding: { x: { field: "vLsrKmS", type: "quantitative", title: "V_LSR (km/s)" }, y: { field: "toomreYKmS", type: "quantitative", title: "sqrt(U_LSR^2 + W_LSR^2) (km/s)" }, detail: { field: "arcKmS", type: "nominal" }, order: { field: "order", type: "quantitative" } } },
        { data: { values: eligible.map((row) => ({ objectId: row.objectId, vLsrKmS: row.vLsrKmS, lower: row.vLsrKmS - row.vErrorKmS, upper: row.vLsrKmS + row.vErrorKmS, toomreYKmS: row.toomreYKmS })) },
          mark: { type: "rule", color: "#6B7280", strokeWidth: 1 },
          encoding: { x: { field: "lower", type: "quantitative" }, x2: { field: "upper" }, y: { field: "toomreYKmS", type: "quantitative" } } },
        { data: { values: eligible.map((row) => ({
            objectId: row.objectId, vLsrKmS: row.vLsrKmS, toomreYKmS: row.toomreYKmS,
            lower: Math.max(0, row.toomreYKmS - Math.hypot(row.uLsrKmS * row.uErrorKmS, row.wLsrKmS * row.wErrorKmS) / Math.max(row.toomreYKmS, 1e-12)),
            upper: row.toomreYKmS + Math.hypot(row.uLsrKmS * row.uErrorKmS, row.wLsrKmS * row.wErrorKmS) / Math.max(row.toomreYKmS, 1e-12),
          })) },
          mark: { type: "rule", color: "#6B7280", strokeWidth: 1 },
          encoding: { x: { field: "vLsrKmS", type: "quantitative" }, y: { field: "lower", type: "quantitative" }, y2: { field: "upper" } } },
        { data: { values: eligible.map((row) => ({ objectId: row.objectId, vLsrKmS: row.vLsrKmS, toomreYKmS: row.toomreYKmS, membership: row.membership, thickToThinRatio: row.thickToThinRatio, totalSpaceVelocityLsrKmS: row.totalSpaceVelocityLsrKmS })) },
          mark: { type: "point", filled: true, size: 64, stroke: "#FFFFFF", strokeWidth: 0.7 },
          encoding: {
            x: { field: "vLsrKmS", type: "quantitative" }, y: { field: "toomreYKmS", type: "quantitative" },
            color: { field: "membership", type: "nominal", title: "Membership", scale: { domain: ["thin-disc", "in-between", "thick-disc", "halo", "undetermined"], range: ["#255C99", "#D97706", "#C2415D", "#111827", "#9CA3AF"] } },
            tooltip: [{ field: "objectId", type: "nominal", title: "Object" }, { field: "vLsrKmS", type: "quantitative", title: "V_LSR", format: ".3f" }, { field: "toomreYKmS", type: "quantitative", title: "sqrt(U^2+W^2)", format: ".3f" }, { field: "thickToThinRatio", type: "quantitative", title: "TD/D", format: ".4g" }, { field: "totalSpaceVelocityLsrKmS", type: "quantitative", title: "v_total", format: ".3f" }],
          } },
      ],
    },
    provenance,
  );
  return common.finalizeAnalysis({
    schema: SCHEMA, algorithm: ALGORITHM, normalizedInput: normalized, sourceContentSha256: normalized.sourceContentSha256,
    sections: { settings, summary, warnings, boundaries: BOUNDARIES, rows, toomreArcs: arcs },
    table, buildFigure,
  });
}

module.exports = {
  DEFAULT_POPULATIONS,
  DEFAULT_SOLAR_MOTION,
  GALACTIC_FRAME,
  GALACTIC_KINEMATICS_ALGORITHM: ALGORITHM,
  GALACTIC_KINEMATICS_BOUNDARIES: BOUNDARIES,
  GALACTIC_KINEMATICS_LIMITS: LIMITS,
  GALACTIC_KINEMATICS_SCHEMA: SCHEMA,
  KM_S_PER_AU_YR,
  analyzeGalacticKinematics,
  galacticRotation,
};
