"use strict";

// Teaching-laboratory result checkers: free-fall g, pendulum g, Ohm's-law R.
//
// Each experiment is a weighted linear least-squares fit built from an explicit
// design matrix (common.weightedLinearLeastSquares), followed by shared residual
// diagnostics (runs test, Durbin–Watson, lag-1 autocorrelation, largest
// standardized residual) and a comparison with a declared reference value.
// When no per-point uncertainty is supplied, unit weights are used and the
// parameter errors are scaled by sqrt(chi²/ndf): the uncertainty then comes
// from the scatter of the data, not from a declared measurement error.

const common = require("./analysis-common.cjs");

const { PhysicsError } = common;
const STANDARD_GRAVITY = 9.80665;
const EXPERIMENTS = ["free_fall", "pendulum", "ohms_law"];

// ---------------------------------------------------------------------------
// Special functions needed for the F-test
// ---------------------------------------------------------------------------

// Regularized incomplete beta I_x(a, b) via Lentz continued fraction
// (Numerical Recipes betacf), symmetric fallback for x > (a+1)/(a+b+2).
function betaContinuedFraction(a, b, x) {
  const tiny = 1e-300;
  const qab = a + b; const qap = a + 1; const qam = a - 1;
  let c = 1; let d = 1 - qab * x / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 3e-16) break;
  }
  return h;
}

function regularizedIncompleteBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(common.logGamma(a + b) - common.logGamma(a) - common.logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return front * betaContinuedFraction(a, b, x) / a;
  return 1 - front * betaContinuedFraction(b, a, 1 - x) / b;
}

// P(F > f) for an F distribution with (d1, d2) degrees of freedom.
function fSurvival(f, d1, d2) {
  if (!(f > 0)) return 1;
  return regularizedIncompleteBeta(d2 / 2, d1 / 2, d2 / (d2 + d1 * f));
}

// ---------------------------------------------------------------------------
// Residual diagnostics (shared)
// ---------------------------------------------------------------------------

function runsTest(signs) {
  const n1 = signs.filter((s) => s > 0).length;
  const n2 = signs.filter((s) => s < 0).length;
  const nonZero = signs.filter((s) => s !== 0);
  let runs = nonZero.length ? 1 : 0;
  for (let i = 1; i < nonZero.length; i += 1) if (nonZero[i] !== nonZero[i - 1]) runs += 1;
  if (n1 < 2 || n2 < 2) return { runs, positive: n1, negative: n2, expected: null, z: null, pValue: null };
  const N = n1 + n2;
  const expected = 2 * n1 * n2 / N + 1;
  const variance = 2 * n1 * n2 * (2 * n1 * n2 - N) / (N * N * (N - 1));
  const z = variance > 0 ? (runs - expected) / Math.sqrt(variance) : null;
  return { runs, positive: n1, negative: n2, expected, z, pValue: z === null ? null : 2 * common.normalSurvival(Math.abs(z)) };
}

function residualDiagnostics(orderedResiduals, orderedStandardized, ordinals) {
  const e = orderedResiduals;
  const sumSq = e.reduce((s, v) => s + v * v, 0);
  let dw = null; let lag1 = null;
  if (e.length >= 3 && sumSq > 0) {
    let diff = 0; let cross = 0;
    for (let i = 1; i < e.length; i += 1) { diff += (e[i] - e[i - 1]) ** 2; cross += e[i] * e[i - 1]; }
    dw = diff / sumSq;
    lag1 = cross / sumSq;
  }
  let largestIndex = 0;
  orderedStandardized.forEach((v, i) => { if (Math.abs(v) > Math.abs(orderedStandardized[largestIndex])) largestIndex = i; });
  return {
    runsTest: runsTest(e.map((v) => Math.sign(v))),
    durbinWatson: dw,
    lag1Autocorrelation: lag1,
    largestStandardizedResidual: { value: orderedStandardized[largestIndex], point: ordinals[largestIndex] },
  };
}

// ---------------------------------------------------------------------------
// Fit helper: weighted linear least squares with optional scatter scaling
// ---------------------------------------------------------------------------

function linearFit(design, y, sigma, label) {
  const hasSigma = sigma !== null;
  const usedSigma = hasSigma ? sigma : y.map(() => 1);
  const fit = common.weightedLinearLeastSquares(design, y, usedSigma, label);
  const reduced = fit.chiSquare / fit.degreesOfFreedom;
  const scale = hasSigma ? 1 : Math.sqrt(reduced);
  const covariance = fit.covariance.map((row) => row.map((v) => v * scale * scale));
  const errors = covariance.map((row, i) => Math.sqrt(Math.max(0, row[i])));
  const effectiveSigma = usedSigma.map((s) => s * scale);
  return { ...fit, hasSigma, covariance, errors, scale, effectiveSigma, reducedChiSquare: reduced, pValue: hasSigma ? common.chiSquareSurvival(fit.chiSquare, fit.degreesOfFreedom) : null, standardized: fit.residuals.map((r, i) => (effectiveSigma[i] > 0 ? r / effectiveSigma[i] : 0)) };
}

function localGravity(latitudeDeg, altitudeM) {
  const phi = latitudeDeg * Math.PI / 180;
  const s = Math.sin(phi); const s2 = Math.sin(2 * phi);
  return 9.780327 * (1 + 0.0053024 * s * s - 0.0000058 * s2 * s2) - 3.086e-6 * altitudeM;
}

function optionalColumn(table, name, label) {
  return name === undefined ? null : common.numericColumn(table, name, label);
}

function comparison(value, error, reference) {
  if (reference === null) return { reference: null, z: null, percentDifference: null };
  return { reference, z: error > 0 ? (value - reference) / error : null, percentDifference: 100 * (value - reference) / reference };
}

// ---------------------------------------------------------------------------
// Input normalization
// ---------------------------------------------------------------------------

const COMMON_KEYS = ["experiment", "table", "options"];
const KEYS = {
  free_fall: ["time_column", "height_column", "distance_column", "sigma_column", "model", "reference_g", "latitude_deg", "altitude_m"],
  pendulum: ["length_column", "period_column", "sigma_period_column", "amplitude_deg", "amplitude_column", "model", "reference_g", "latitude_deg", "altitude_m"],
  ohms_law: ["voltage_column", "current_column", "sigma_voltage_column", "sigma_current_column", "model", "reference_resistance"],
};

function normalizeInput(input) {
  if (!common.isPlainObject(input)) throw new PhysicsError("physics-lab-input-invalid", "input must be a plain object");
  const experiment = common.enumText(input.experiment, EXPERIMENTS, "physics-lab-experiment");
  const value = common.exactObject(input, [...COMMON_KEYS, ...KEYS[experiment]], "physics-lab-input");
  const table = common.verifiedScienceTable(value.table);
  const optionsInput = value.options === undefined ? {} : common.exactObject(value.options, ["curve_points"], "physics-lab-options");
  const options = { curvePoints: common.optionalInteger(optionsInput.curve_points, 50, 2_000, "physics-lab-curve-points", 200) };
  const referenceGravity = (() => {
    if (experiment === "ohms_law") return null;
    const hasLocation = value.latitude_deg !== undefined || value.altitude_m !== undefined;
    if (value.reference_g !== undefined && hasLocation) throw new PhysicsError("physics-lab-reference-conflict", "give either reference_g or latitude_deg/altitude_m, not both");
    if (hasLocation) {
      if (value.latitude_deg === undefined) throw new PhysicsError("physics-lab-latitude-required", "altitude_m requires latitude_deg");
      const latitude = common.finite(value.latitude_deg, -90, 90, "physics-lab-latitude");
      const altitude = common.optionalFinite(value.altitude_m, -500, 10_000, "physics-lab-altitude", 0);
      return { value: localGravity(latitude, altitude), source: `WGS84 international gravity formula at latitude ${latitude}°, altitude ${altitude} m`, latitude, altitude };
    }
    const reference = common.optionalFinite(value.reference_g, 0.1, 100, "physics-lab-reference-g", STANDARD_GRAVITY);
    return { value: reference, source: value.reference_g === undefined ? "standard gravity g_n = 9.80665 m/s² (conventional)" : "caller-declared reference", latitude: null, altitude: null };
  })();
  const out = { experiment, table, options, referenceGravity };
  if (experiment === "free_fall") {
    if ((value.height_column === undefined) === (value.distance_column === undefined)) throw new PhysicsError("physics-lab-free-fall-distance-column-required", "give exactly one of height_column or distance_column");
    out.time = common.numericColumn(table, value.time_column, "physics-lab-time-column");
    out.distance = common.numericColumn(table, value.height_column ?? value.distance_column, "physics-lab-distance-column");
    out.distanceColumnKind = value.height_column === undefined ? "distance" : "height";
    out.sigma = optionalColumn(table, value.sigma_column, "physics-lab-sigma-column");
    out.model = value.model === undefined ? "with_initial_velocity" : common.enumText(value.model, ["half_g_t_squared", "with_initial_velocity", "full"], "physics-lab-free-fall-model");
  } else if (experiment === "pendulum") {
    out.length = common.numericColumn(table, value.length_column, "physics-lab-length-column");
    out.period = common.numericColumn(table, value.period_column, "physics-lab-period-column");
    out.sigmaPeriod = optionalColumn(table, value.sigma_period_column, "physics-lab-sigma-period-column");
    if (value.amplitude_deg !== undefined && value.amplitude_column !== undefined) throw new PhysicsError("physics-lab-amplitude-conflict", "give either amplitude_deg or amplitude_column, not both");
    out.amplitudeDeg = value.amplitude_deg === undefined ? null : common.finite(value.amplitude_deg, 0, 179, "physics-lab-amplitude-deg");
    out.amplitudeColumn = optionalColumn(table, value.amplitude_column, "physics-lab-amplitude-column");
    out.model = value.model === undefined ? "through_origin" : common.enumText(value.model, ["through_origin", "with_intercept"], "physics-lab-pendulum-model");
  } else {
    out.voltage = common.numericColumn(table, value.voltage_column, "physics-lab-voltage-column");
    out.current = common.numericColumn(table, value.current_column, "physics-lab-current-column");
    out.sigmaVoltage = optionalColumn(table, value.sigma_voltage_column, "physics-lab-sigma-voltage-column");
    out.sigmaCurrent = optionalColumn(table, value.sigma_current_column, "physics-lab-sigma-current-column");
    out.model = value.model === undefined ? "with_intercept" : common.enumText(value.model, ["through_origin", "with_intercept"], "physics-lab-ohms-law-model");
    out.referenceResistance = value.reference_resistance === undefined ? null : common.finite(value.reference_resistance, Number.MIN_VALUE, 1e12, "physics-lab-reference-resistance");
  }
  return out;
}

function positiveSigma(values, label) {
  values.forEach((v, i) => { if (!(v > 0)) throw new PhysicsError(label, `point ${i + 1} has a non-positive uncertainty`); });
  return values;
}

// ---------------------------------------------------------------------------
// Experiments
// ---------------------------------------------------------------------------

function freeFall(n) {
  const t = n.time.values; const d = n.distance.values;
  t.forEach((v, i) => { if (!(v >= 0)) throw new PhysicsError("physics-lab-free-fall-time-negative", `point ${i + 1} has a negative time`); });
  const sigma = n.sigma ? positiveSigma(n.sigma.values, "physics-lab-sigma-nonpositive") : null;
  const designs = {
    half_g_t_squared: { columns: (ti) => [ti * ti / 2], names: ["g"], gIndex: 0 },
    with_initial_velocity: { columns: (ti) => [ti, ti * ti / 2], names: ["v0", "g"], gIndex: 1 },
    full: { columns: (ti) => [1, ti, ti * ti / 2], names: ["d0", "v0", "g"], gIndex: 2 },
  }[n.model];
  const fit = linearFit(t.map(designs.columns), d, sigma, "physics-lab-free-fall-fit");
  const g = fit.parameters[designs.gIndex]; const sigmaG = fit.errors[designs.gIndex];
  const dUnit = n.distance.column.unit ?? "m"; const tUnit = n.time.column.unit ?? "s";
  const gUnit = `${dUnit}/${tUnit}²`;
  const parameters = designs.names.map((name, i) => ({ id: name, value: fit.parameters[i], error: fit.errors[i], unit: name === "g" ? gUnit : name === "v0" ? `${dUnit}/${tUnit}` : dUnit }));
  const evaluate = (ti) => common.dot(designs.columns(ti), fit.parameters);
  return { fit, x: t, y: d, sigmaUsed: fit.effectiveSigma, xUnit: tUnit, yUnit: dUnit, xLabel: n.time.column.name, yLabel: n.distance.column.name, parameters, evaluate, primary: { id: "g", label: "Gravitational acceleration g", value: g, error: sigmaG, unit: gUnit, ...comparison(g, sigmaG, n.referenceGravity.value) }, extraRows: [], modelText: { half_g_t_squared: "d = ½·g·t²", with_initial_velocity: "d = v0·t + ½·g·t²", full: "d = d0 + v0·t + ½·g·t²" }[n.model], hypothesisRows: [] };
}

function pendulum(n) {
  const L = n.length.values; const T = n.period.values;
  L.forEach((v, i) => { if (!(v > 0)) throw new PhysicsError("physics-lab-pendulum-length-nonpositive", `point ${i + 1} has a non-positive length`); });
  T.forEach((v, i) => { if (!(v > 0)) throw new PhysicsError("physics-lab-pendulum-period-nonpositive", `point ${i + 1} has a non-positive period`); });
  const sigmaT = n.sigmaPeriod ? positiveSigma(n.sigmaPeriod.values, "physics-lab-sigma-nonpositive") : null;
  const amplitudes = n.amplitudeColumn ? n.amplitudeColumn.values.map((v, i) => { if (!(v >= 0 && v < 180)) throw new PhysicsError("physics-lab-amplitude-invalid", `point ${i + 1} amplitude must lie in [0, 180) degrees`); return v; }) : L.map(() => n.amplitudeDeg ?? 0);
  // Finite-amplitude factor T/T0 = (2/π) K(sin(θ0/2)).
  const factors = amplitudes.map((deg) => (2 / Math.PI) * common.completeEllipticK(Math.sin(deg * Math.PI / 360)));
  const T0 = T.map((v, i) => v / factors[i]);
  const sigmaT0 = sigmaT ? sigmaT.map((s, i) => s / factors[i]) : null;
  const y = T0.map((v) => v * v);
  const sigmaY = sigmaT0 ? sigmaT0.map((s, i) => 2 * T0[i] * s) : null;
  const design = n.model === "through_origin" ? L.map((li) => [li]) : L.map((li) => [1, li]);
  const slopeIndex = n.model === "through_origin" ? 0 : 1;
  const fit = linearFit(design, y, sigmaY, "physics-lab-pendulum-fit");
  const slope = fit.parameters[slopeIndex]; const sigmaSlope = fit.errors[slopeIndex];
  if (!(slope > 0)) throw new PhysicsError("physics-lab-pendulum-slope-nonpositive", "fitted T² versus L slope is not positive; g cannot be derived");
  const g = 4 * Math.PI * Math.PI / slope; const sigmaG = 4 * Math.PI * Math.PI * sigmaSlope / (slope * slope);
  // Naive fit on uncorrected periods for comparison.
  const naiveFit = linearFit(design, T.map((v) => v * v), sigmaT ? sigmaT.map((s, i) => 2 * T[i] * s) : null, "physics-lab-pendulum-naive-fit");
  const naiveSlope = naiveFit.parameters[slopeIndex];
  const naiveG = naiveSlope > 0 ? 4 * Math.PI * Math.PI / naiveSlope : null;
  const lUnit = n.length.column.unit ?? "m"; const tUnit = n.period.column.unit ?? "s";
  const gUnit = `${lUnit}/${tUnit}²`;
  const parameters = n.model === "through_origin"
    ? [{ id: "slope", value: slope, error: sigmaSlope, unit: `${tUnit}²/${lUnit}` }]
    : [{ id: "intercept", value: fit.parameters[0], error: fit.errors[0], unit: `${tUnit}²` }, { id: "slope", value: slope, error: sigmaSlope, unit: `${tUnit}²/${lUnit}` }];
  const extraRows = [
    ["Naive g (no amplitude correction)", naiveG, naiveG === null ? null : 4 * Math.PI * Math.PI * naiveFit.errors[slopeIndex] / (naiveSlope * naiveSlope), gUnit, "same fit on raw T²"],
    ["Mean amplitude correction factor T/T0", common.mean(factors), null, null, "(2/π)·K(sin(θ0/2))"],
  ];
  if (n.model === "with_intercept") {
    const intercept = fit.parameters[0]; const sigmaIntercept = fit.errors[0];
    extraRows.push(["Intercept of T0² vs L", intercept, sigmaIntercept, `${tUnit}²`, "fitted"]);
    extraRows.push(["Equivalent length offset (intercept / slope)", intercept / slope, Math.hypot(sigmaIntercept / slope, intercept * sigmaSlope / (slope * slope)), lUnit, "e.g. bob radius or pivot offset (hypothesis)"]);
  }
  const evaluate = (li) => common.dot(n.model === "through_origin" ? [li] : [1, li], fit.parameters);
  return { fit, x: L, y, sigmaUsed: fit.effectiveSigma, xUnit: lUnit, yUnit: `${tUnit}²`, xLabel: n.length.column.name, yLabel: `${n.period.column.name}² (amplitude-corrected)`, parameters, evaluate, primary: { id: "g", label: "Gravitational acceleration g", value: g, error: sigmaG, unit: gUnit, ...comparison(g, sigmaG, n.referenceGravity.value) }, extraRows, modelText: n.model === "through_origin" ? "T0² = (4π²/g)·L" : "T0² = c + (4π²/g)·L", hypothesisRows: [], naive: { g: naiveG, meanFactor: common.mean(factors) } };
}

function ohmsLaw(n) {
  const V = n.voltage.values; const I = n.current.values;
  const sigmaV = n.sigmaVoltage ? positiveSigma(n.sigmaVoltage.values, "physics-lab-sigma-nonpositive") : null;
  const sigmaI = n.sigmaCurrent ? positiveSigma(n.sigmaCurrent.values, "physics-lab-sigma-nonpositive") : null;
  const design = n.model === "through_origin" ? I.map((ii) => [ii]) : I.map((ii) => [1, ii]);
  const rIndex = n.model === "through_origin" ? 0 : 1;
  // Fold the current uncertainty into an effective voltage uncertainty using
  // the fitted R, iterated twice (the second pass uses the first-pass R).
  let sigmaEff = sigmaV;
  let fit = linearFit(design, V, sigmaEff, "physics-lab-ohms-law-fit");
  let foldPasses = 0;
  if (sigmaI) {
    for (let pass = 0; pass < 2; pass += 1) {
      const R = fit.parameters[rIndex];
      sigmaEff = I.map((_, i) => Math.sqrt((sigmaV ? sigmaV[i] ** 2 : 0) + R * R * sigmaI[i] ** 2));
      fit = linearFit(design, V, sigmaEff, "physics-lab-ohms-law-fit");
      foldPasses += 1;
    }
  }
  const R = fit.parameters[rIndex]; const sigmaR = fit.errors[rIndex];
  const vUnit = n.voltage.column.unit ?? "V"; const iUnit = n.current.column.unit ?? "A";
  const rUnit = vUnit === "V" && iUnit === "A" ? "Ω" : `${vUnit}/${iUnit}`;
  const parameters = n.model === "through_origin"
    ? [{ id: "R", value: R, error: sigmaR, unit: rUnit }]
    : [{ id: "offset", value: fit.parameters[0], error: fit.errors[0], unit: vUnit }, { id: "R", value: R, error: sigmaR, unit: rUnit }];
  const extraRows = [];
  const hypothesisRows = [];
  if (n.model === "with_intercept") {
    const a = fit.parameters[0]; const sa = fit.errors[0];
    const ratio = sa > 0 ? Math.abs(a) / sa : null;
    extraRows.push(["Offset voltage (intercept)", a, sa, vUnit, ratio === null ? "σ_a = 0 (no scatter)" : `|a|/σ_a = ${ratio.toPrecision(3)}${ratio < 2 ? " — consistent with zero" : " — not consistent with zero"}`]);
  }
  // Quadratic-term test on the same weights: V = a + R I + c I².
  if (I.length >= 4) {
    const quadDesign = I.map((ii) => [1, ii, ii * ii]);
    try {
      const quad = linearFit(quadDesign, V, fit.hasSigma ? sigmaEff : null, "physics-lab-ohms-law-quadratic-fit");
      const c = quad.parameters[2]; const sc = quad.errors[2];
      const linearForF = linearFit(I.map((ii) => [1, ii]), V, fit.hasSigma ? sigmaEff : null, "physics-lab-ohms-law-linear-for-f");
      const chiLin = linearForF.chiSquare; const chiQuad = quad.chiSquare;
      const F = chiQuad > 0 ? Math.max(0, (chiLin - chiQuad) / (chiQuad / (I.length - 3))) : null;
      const pF = F === null ? null : fSurvival(F, 1, I.length - 3);
      const cOverSigma = sc > 0 ? c / sc : null;
      extraRows.push(["Quadratic term c in V = a + R·I + c·I²", c, sc, `${vUnit}/${iUnit}²`, cOverSigma === null ? "σ_c = 0 (no scatter)" : `c/σ_c = ${cOverSigma.toPrecision(3)}`]);
      extraRows.push(["F statistic for adding the quadratic term", F, null, null, pF === null ? "not computable" : `p = ${pF.toPrecision(3)} (F(1, ${I.length - 3}))`]);
      hypothesisRows.push({ id: "quadratic-term", cOverSigma, F, pValue: pF, verdict: pF !== null && pF < 0.05 ? "a quadratic term improves the fit at the 5 % level; nonlinearity (e.g. resistive heating) is a hypothesis to check, not a conclusion" : "no evidence for a quadratic term at the 5 % level" });
    } catch { /* singular quadratic design (e.g. duplicated currents) leaves the test out */ }
  }
  const evaluate = (ii) => common.dot(n.model === "through_origin" ? [ii] : [1, ii], fit.parameters);
  return { fit, x: I, y: V, sigmaUsed: fit.effectiveSigma, xUnit: iUnit, yUnit: vUnit, xLabel: n.current.column.name, yLabel: n.voltage.column.name, parameters, evaluate, primary: { id: "R", label: "Resistance R", value: R, error: sigmaR, unit: rUnit, ...comparison(R, sigmaR, n.referenceResistance) }, extraRows, modelText: n.model === "through_origin" ? "V = R·I" : "V = V0 + R·I", hypothesisRows, foldPasses };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function analyzeLabExperiment(input) {
  const n = normalizeInput(input);
  const runner = { free_fall: freeFall, pendulum, ohms_law: ohmsLaw }[n.experiment];
  const minimumPoints = { free_fall: { half_g_t_squared: 3, with_initial_velocity: 4, full: 5 }[n.model], pendulum: n.model === "through_origin" ? 3 : 4, ohms_law: n.model === "through_origin" ? 3 : 4 }[n.experiment];
  if (n.table.rows.length < minimumPoints) throw new PhysicsError("physics-lab-too-few-points", `${n.experiment} with model ${n.model} needs at least ${minimumPoints} points`);
  const r = runner(n);
  const warnings = [];
  const fit = r.fit;
  const ordinals = r.x.map((_, i) => i + 1);
  const order = ordinals.map((o) => o - 1).sort((a, b) => r.x[a] - r.x[b]);
  const diagnostics = residualDiagnostics(order.map((i) => fit.residuals[i]), order.map((i) => fit.standardized[i]), order.map((i) => i + 1));
  const verdict = [];
  const p = r.primary;
  if (p.z !== null) {
    verdict.push(`${p.label} = ${p.value.toPrecision(5)} ± ${p.error.toPrecision(2)} ${p.unit}; ${Math.abs(p.z) <= 2 ? "agrees with" : "differs from"} the reference ${p.reference.toPrecision(6)} ${p.unit} by ${Math.abs(p.z).toPrecision(2)}σ (${p.percentDifference.toPrecision(3)} %).`);
  } else verdict.push(`${p.label} = ${p.value.toPrecision(5)} ± ${p.error.toPrecision(2)} ${p.unit}; no reference value declared.`);
  if (!fit.hasSigma && !(fit.scale > 0)) warnings.push("The data lie exactly on the model: with no declared uncertainties and zero scatter the parameter errors are zero, which is not a physical uncertainty.");
  if (!fit.hasSigma) {
    verdict.push("No per-point uncertainties were declared: the quoted uncertainty is derived from the residual scatter (errors scaled by √(χ²/ndf) with unit weights).");
    warnings.push("Parameter uncertainties come from scatter, not from declared measurement errors; χ² goodness-of-fit and its p-value are therefore not reported.");
  } else if (fit.reducedChiSquare > 3) {
    verdict.push(`χ²/ndf = ${fit.reducedChiSquare.toPrecision(3)}: the declared uncertainties are too small for the scatter, or the model is incomplete.`);
    warnings.push("Reduced chi-square is large; parameter errors are not scaled and may be underestimated.");
  } else if (fit.reducedChiSquare < 0.2 && fit.degreesOfFreedom >= 3) {
    verdict.push(`χ²/ndf = ${fit.reducedChiSquare.toPrecision(3)}: the declared uncertainties are probably overestimated.`);
  }
  const rt = diagnostics.runsTest;
  if (rt.pValue !== null && rt.pValue < 0.05) verdict.push(`Residual signs are not random (runs test z = ${rt.z.toPrecision(3)}, p = ${rt.pValue.toPrecision(2)}): the residuals show a trend — check for a systematic offset or a missing term (e.g. timing offset, length offset, heating).`);
  if (diagnostics.durbinWatson !== null && (diagnostics.durbinWatson < 1 || diagnostics.durbinWatson > 3)) verdict.push(`Durbin–Watson = ${diagnostics.durbinWatson.toPrecision(3)} indicates ${diagnostics.durbinWatson < 1 ? "positive" : "negative"} serial correlation of the residuals in x order.`);
  if (Math.abs(diagnostics.largestStandardizedResidual.value) > 3) verdict.push(`Point ${diagnostics.largestStandardizedResidual.point} has a standardized residual of ${diagnostics.largestStandardizedResidual.value.toPrecision(3)}; inspect it before excluding anything.`);
  if (n.experiment === "pendulum" && r.naive.meanFactor > 1.001) verdict.push(`Finite-amplitude correction applied (mean T/T0 = ${r.naive.meanFactor.toPrecision(5)}); the uncorrected fit would give g = ${r.naive.g === null ? "n/a" : r.naive.g.toPrecision(5)} ${p.unit}.`);
  if (n.experiment === "pendulum" && r.naive.meanFactor === 1) warnings.push("No amplitude declared: the small-angle formula is used; at 15° the period is 0.43 % long, biasing g low by 0.9 %.");
  r.hypothesisRows.forEach((h) => verdict.push(h.verdict));
  const rows = r.x.map((xi, i) => ({ ordinal: i + 1, x: xi, y: r.y[i], sigma: r.sigmaUsed[i], fitted: fit.fitted[i], residual: fit.residuals[i], standardizedResidual: fit.standardized[i] }));
  const publicationRows = [
    [p.label, p.value, p.error, p.unit, `weighted linear least squares, model ${r.modelText}`],
    ...(p.reference === null ? [] : [["Reference value", p.reference, null, p.unit, n.experiment === "ohms_law" ? "caller-declared" : n.referenceGravity.source], ["z = (measured − reference)/σ", p.z, null, "σ", "comparison"], ["Percent difference", p.percentDifference, null, "%", "(measured − reference)/reference"]]),
    ...r.parameters.map((par) => [`Fit parameter ${par.id}`, par.value, par.error, par.unit, fit.hasSigma ? "declared σ" : "scatter-scaled σ"]),
    ...r.extraRows,
    ["χ²", fit.chiSquare, null, null, fit.hasSigma ? "with declared σ" : "with unit weights (not a goodness-of-fit)"],
    ["Degrees of freedom", fit.degreesOfFreedom, null, null, ""],
    ["χ²/ndf", fit.reducedChiSquare, null, null, fit.hasSigma ? "" : "used as the error scale factor²"],
    ["χ² p-value", fit.pValue, null, null, fit.hasSigma ? "survival probability" : "not applicable without declared σ"],
    ["Runs test z", rt.z, null, null, rt.pValue === null ? "too few sign changes" : `p = ${rt.pValue.toPrecision(3)}`],
    ["Durbin–Watson", diagnostics.durbinWatson, null, null, "2 ≈ no serial correlation"],
    ["Lag-1 residual autocorrelation", diagnostics.lag1Autocorrelation, null, null, "in x order"],
    ["Largest |standardized residual|", diagnostics.largestStandardizedResidual.value, null, null, `point ${diagnostics.largestStandardizedResidual.point}`],
  ];
  const publicationTable = common.scienceTable(`${{ free_fall: "Free-fall g", pendulum: "Pendulum g", ohms_law: "Ohm's law R" }[n.experiment]} · ${n.table.title}`, [
    { id: "quantity", label: "Quantity", type: "string" }, { id: "value", label: "Value" }, { id: "uncertainty", label: "Uncertainty" }, { id: "unit", label: "Unit", type: "string" }, { id: "method", label: "Method / note", type: "string" },
  ], publicationRows);
  const pointsTable = common.scienceTable("Points, fitted values, residuals", [
    { id: "ordinal", label: "Point" }, { id: "x", label: r.xLabel, unit: r.xUnit }, { id: "y", label: r.yLabel, unit: r.yUnit }, { id: "sigma", label: fit.hasSigma ? "σ" : "σ (scatter-scaled)", unit: r.yUnit },
    { id: "fitted", label: "Fitted", unit: r.yUnit }, { id: "residual", label: "Residual", unit: r.yUnit }, { id: "standardized", label: "Standardized residual" },
  ], rows.map((row) => [row.ordinal, row.x, row.y, row.sigma, row.fitted, row.residual, row.standardizedResidual]));
  const xMin = Math.min(...r.x); const xMax = Math.max(...r.x);
  const grid = common.linspace(xMin, xMax, n.options.curvePoints);
  const curveRows = grid.map((xi) => ({ x: xi, y: r.evaluate(xi) }));
  const width = 680;
  const pointValues = rows.map((row) => ({ x: row.x, y: row.y, low: row.y - row.sigma, high: row.y + row.sigma, residual: row.residual, standardized: row.standardizedResidual }));
  const spec = common.stackedVegaFigure({
    description: `${r.yLabel} versus ${r.xLabel} with ±1σ bars and the fitted model ${r.modelText}; lower panel: residuals.`,
    width,
    data: [{ name: "points", values: pointValues }, { name: "curve", values: curveRows }, { name: "zero", values: [{ level: 0 }] }],
    panels: [
      {
        name: "fitPanel", height: 300,
        scales: [
          common.linearScale("x", "points", "x", "width"),
          { name: "y", type: "linear", domain: { fields: [{ data: "points", field: "low" }, { data: "points", field: "high" }, { data: "curve", field: "y" }] }, range: "height", nice: true, zero: false },
        ],
        axes: [common.axis("bottom", "x", `${r.xLabel}${r.xUnit ? ` (${r.xUnit})` : ""}`), common.axis("left", "y", `${r.yLabel}${r.yUnit ? ` (${r.yUnit})` : ""}`)],
        marks: [
          common.errorBarMark("points", "x", "low", "high", common.PALETTE.neutral),
          common.lineMark("curve", "x", "y", common.PALETTE.fit, { strokeWidth: 2 }),
          common.symbolMark("points", "x", "y", common.PALETTE.data, { tooltip: "standardized" }),
        ],
      },
      {
        name: "residualPanel", height: 120,
        scales: [
          common.linearScale("x", "points", "x", "width"),
          { name: "y", type: "linear", domain: { fields: [{ data: "points", field: "residual" }, { data: "zero", field: "level" }] }, range: "height", nice: true, zero: true },
        ],
        axes: [common.axis("bottom", "x", `${r.xLabel}${r.xUnit ? ` (${r.xUnit})` : ""}`), common.axis("left", "y", `Residual${r.yUnit ? ` (${r.yUnit})` : ""}`)],
        marks: [
          common.horizontalRule("zero", 0, common.PALETTE.neutral, { width }),
          common.barMark("points", "x", "residual", common.PALETTE.data, { halfWidth: 2 }),
        ],
      },
    ],
  });
  const result = {
    schema: "agentlas.physics.analysis-result/v1",
    analysisId: "lab-experiment",
    method: {
      id: `teaching-lab-${n.experiment.replace(/_/g, "-")}-checker`, version: "1.0.0",
      references: [
        "P. R. Bevington, D. K. Robinson, Data Reduction and Error Analysis for the Physical Sciences, 3rd ed. (2003), ch. 6–7 (weighted linear least squares, chi-square)",
        "J. R. Taylor, An Introduction to Error Analysis, 2nd ed. (1997), ch. 8",
        ...(n.experiment === "pendulum" ? ["Exact pendulum period T = (2/π)·T0·K(sin(θ0/2)), e.g. R. A. Nelson, M. G. Olsson, Am. J. Phys. 54, 112 (1986)"] : []),
        ...(n.experiment !== "ohms_law" ? ["WGS84 international gravity formula (NIMA TR8350.2, 2000) for the optional local reference g"] : []),
        "A. Wald, J. Wolfowitz, Ann. Math. Stat. 11, 147 (1940) (runs test); J. Durbin, G. S. Watson, Biometrika 37, 409 (1950)",
      ],
    },
    input: {
      experiment: n.experiment, title: n.table.title, model: n.model, pointCount: n.table.rows.length,
      columns: { x: r.xLabel, xUnit: r.xUnit, y: r.yLabel, yUnit: r.yUnit }, declaredSigma: fit.hasSigma,
      reference: n.experiment === "ohms_law" ? { resistance: n.referenceResistance } : n.referenceGravity,
      ...(n.experiment === "pendulum" ? { amplitudeDeg: n.amplitudeDeg, amplitudeColumn: n.amplitudeColumn ? n.amplitudeColumn.column.name : null } : {}),
      ...(n.experiment === "free_fall" ? { distanceColumnKind: n.distanceColumnKind } : {}),
      ...(n.experiment === "ohms_law" ? { currentUncertaintyFolded: r.foldPasses > 0, foldPasses: r.foldPasses } : {}),
      options: n.options,
    },
    summary: {
      quantity: p.id, value: p.value, error: p.error, unit: p.unit, reference: p.reference, z: p.z, percentDifference: p.percentDifference,
      parameters: r.parameters, chiSquare: fit.chiSquare, degreesOfFreedom: fit.degreesOfFreedom, reducedChiSquare: fit.reducedChiSquare, pValue: fit.pValue,
      errorScale: fit.scale, uncertaintySource: fit.hasSigma ? "declared" : "scatter",
      diagnostics, hypotheses: r.hypothesisRows, verdict,
      ...(n.experiment === "pendulum" ? { naiveG: r.naive.g, meanAmplitudeFactor: r.naive.meanFactor } : {}),
    },
    covariance: fit.covariance,
    parameterOrder: r.parameters.map((par) => par.id),
    points: rows,
    publicationTable,
    tables: { points: pointsTable },
    figure: common.figureReceipt(spec),
    boundaries: [
      "Weighted linear least squares on the stated model; no systematic-error model, no outlier rejection, no error in the independent variable (use the York fit for that).",
      n.experiment === "ohms_law" ? "The reference resistance is caller-declared; nominal component values carry their own tolerance." : "The reference g is standard gravity g_n = 9.80665 m/s² unless latitude/altitude are given, in which case the WGS84 gravity formula (no local anomalies) is used.",
      ...(n.experiment === "pendulum" ? ["The amplitude correction assumes a point-mass simple pendulum with no damping, string mass, or bob rotation; T/T0 = (2/π)K(sin(θ0/2))."] : []),
      ...(n.experiment === "free_fall" ? ["The height/distance column is interpreted as distance fallen from release; air resistance is not modelled."] : []),
      ...(n.experiment === "ohms_law" ? ["Linearity diagnostics (runs test, quadratic term, F-test) are indications, not proof of a physical nonlinearity; the current uncertainty is folded into an effective voltage uncertainty using the fitted R."] : []),
      "Without declared uncertainties the parameter errors reflect scatter only and χ² is not a goodness-of-fit statistic.",
    ],
    warnings,
  };
  return common.finalizeAnalysis(result);
}

module.exports = { analyzeLabExperiment, runsTest, fSurvival, regularizedIncompleteBeta, localGravity };
