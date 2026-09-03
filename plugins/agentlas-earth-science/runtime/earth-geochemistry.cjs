"use strict";

// Geochronology and igneous geochemistry on researcher-supplied tables.
//  1. York (2004) errors-in-variables isochron regression with correlated
//     errors, MSWD, probability of fit, initial ratio, and isochron age from a
//     tabulated decay-constant catalogue.
//  2. TAS classification (Le Bas et al. 1986) and the AFM ternary transform.
//
// References
//  York D., Evensen N. M., López Martínez M., De Basabe Delgado J. (2004) Am. J. Phys. 72, 367–375.
//  Ludwig K. R. (2003) Isoplot 3.00 — MSWD, probability of fit, and the "model 1" error expansion.
//  Wendt I. & Carl C. (1991) Chem. Geol. 86, 275–285 — statistical distribution of MSWD.
//  Villa I. M. et al. (2015) Geochim. Cosmochim. Acta 164, 382–385 — λ(87Rb).
//  Lugmair G. W. & Marti K. (1978) EPSL 39, 349–357 — λ(147Sm).
//  Söderlund U. et al. (2004) EPSL 219, 311–324 — λ(176Lu).
//  Smoliar M. I., Walker R. J., Morgan J. W. (1996) Science 271, 1099–1102 — λ(187Re).
//  Jaffey A. H. et al. (1971) Phys. Rev. C 4, 1889–1906 — λ(238U), λ(235U).
//  Le Bas M. J., Le Maitre R. W., Streckeisen A., Zanettin B. (1986) J. Petrol. 27, 745–750.
//  Le Maitre R. W. et al. (2002) Igneous Rocks: A Classification and Glossary of Terms, 2nd ed.
//  Irvine T. N. & Baragar W. R. A. (1971) Can. J. Earth Sci. 8, 523–548 — AFM diagram.

const N = require("./earth-numerics.cjs");

function core() {
  return require("./earth-science.cjs");
}

// Decay constants in a⁻¹. Each entry names its source so the age is auditable.
const DECAY_SYSTEMS = Object.freeze({
  "rb-sr": { parent: "87Rb", daughter: "87Sr", normalizer: "86Sr", xLabel: "87Rb/86Sr", yLabel: "87Sr/86Sr", lambdaPerYear: 1.3972e-11, lambdaSource: "Villa et al. (2015), IUGS–IUPAC recommended" },
  "sm-nd": { parent: "147Sm", daughter: "143Nd", normalizer: "144Nd", xLabel: "147Sm/144Nd", yLabel: "143Nd/144Nd", lambdaPerYear: 6.54e-12, lambdaSource: "Lugmair & Marti (1978)" },
  "lu-hf": { parent: "176Lu", daughter: "176Hf", normalizer: "177Hf", xLabel: "176Lu/177Hf", yLabel: "176Hf/177Hf", lambdaPerYear: 1.867e-11, lambdaSource: "Söderlund et al. (2004)" },
  "re-os": { parent: "187Re", daughter: "187Os", normalizer: "188Os", xLabel: "187Re/188Os", yLabel: "187Os/188Os", lambdaPerYear: 1.666e-11, lambdaSource: "Smoliar et al. (1996)" },
  "u-pb-238": { parent: "238U", daughter: "206Pb", normalizer: "204Pb", xLabel: "238U/204Pb", yLabel: "206Pb/204Pb", lambdaPerYear: 1.55125e-10, lambdaSource: "Jaffey et al. (1971)" },
  "u-pb-235": { parent: "235U", daughter: "207Pb", normalizer: "204Pb", xLabel: "235U/204Pb", yLabel: "207Pb/204Pb", lambdaPerYear: 9.8485e-10, lambdaSource: "Jaffey et al. (1971)" },
  custom: { parent: "parent", daughter: "daughter", normalizer: "normalizer", xLabel: "parent/normalizer", yLabel: "daughter/normalizer", lambdaPerYear: null, lambdaSource: "researcher-supplied" },
});

const UNCERTAINTY_KINDS = new Set(["1-sigma-absolute", "2-sigma-absolute", "1-sigma-percent", "2-sigma-percent"]);

function assertSourceSha(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw N.fail("earth-table-source-sha256-invalid");
  return value;
}

function vegaConfig() {
  return { axis: { labelFontSize: 11, titleFontSize: 12 }, view: { stroke: "#D8D5D0" } };
}

// ---------------------------------------------------------------------------
// 1. York regression and isochron ages
// ---------------------------------------------------------------------------

function normalizeIsochronInput(value) {
  const C = core();
  const input = C.exactObject(value, ["sourceContentSha256", "system", "decayConstantPerYear", "samples", "uncertaintyKind", "confidenceLevel", "ageUnit"], "earth-isochron-input");
  const sourceContentSha256 = assertSourceSha(input.sourceContentSha256);
  const system = C.text(input.system, 3, 20, "earth-isochron-system");
  if (!Object.hasOwn(DECAY_SYSTEMS, system)) throw N.fail("earth-isochron-system-unknown", `unknown decay system ${system}`, { catalogue: Object.keys(DECAY_SYSTEMS) });
  const catalogue = DECAY_SYSTEMS[system];
  let lambda = catalogue.lambdaPerYear;
  let lambdaSource = catalogue.lambdaSource;
  if (input.decayConstantPerYear !== undefined && input.decayConstantPerYear !== null) {
    lambda = C.finite(input.decayConstantPerYear, 1e-15, 1e-5, "earth-isochron-decay-constant");
    lambdaSource = "researcher-supplied override";
  }
  if (lambda === null) throw N.fail("earth-isochron-decay-constant-required", "custom systems require decayConstantPerYear");
  if (!Array.isArray(input.samples) || input.samples.length < 3 || input.samples.length > 500) throw N.fail("earth-isochron-samples-length-invalid", "York regression requires 3–500 samples");
  const uncertaintyKind = input.uncertaintyKind === undefined ? "1-sigma-absolute" : C.text(input.uncertaintyKind, 1, 20, "earth-isochron-uncertainty-kind");
  if (!UNCERTAINTY_KINDS.has(uncertaintyKind)) throw N.fail("earth-isochron-uncertainty-kind-invalid");
  const sigmaFactor = uncertaintyKind.startsWith("2-sigma") ? 0.5 : 1;
  const percent = uncertaintyKind.endsWith("percent");
  const ids = new Set();
  const samples = input.samples.map((row, index) => {
    const item = C.exactObject(row, ["id", "x", "y", "sigmaX", "sigmaY", "correlation"], "earth-isochron-sample");
    const id = C.text(item.id, 1, 80, "earth-isochron-sample-id");
    if (ids.has(id)) throw N.fail("earth-isochron-sample-id-duplicate", `duplicate sample id ${id}`, { index });
    ids.add(id);
    const x = C.finite(item.x, 0, 1e9, "earth-isochron-sample-x");
    const y = C.finite(item.y, 0, 1e9, "earth-isochron-sample-y");
    const rawSx = C.finite(item.sigmaX, 1e-15, 1e9, "earth-isochron-sample-sigma-x");
    const rawSy = C.finite(item.sigmaY, 1e-15, 1e9, "earth-isochron-sample-sigma-y");
    const sigmaX = sigmaFactor * (percent ? rawSx / 100 * x : rawSx);
    const sigmaY = sigmaFactor * (percent ? rawSy / 100 * y : rawSy);
    if (!(sigmaX > 0) || !(sigmaY > 0)) throw N.fail("earth-isochron-sample-sigma-invalid", "uncertainties must be positive after conversion", { id });
    const correlation = item.correlation === undefined || item.correlation === null ? 0 : C.finite(item.correlation, -0.999999, 0.999999, "earth-isochron-sample-correlation");
    return { id, x, y, sigmaX, sigmaY, correlation };
  });
  const confidenceLevel = input.confidenceLevel === undefined ? 0.95 : C.finite(input.confidenceLevel, 0.8, 0.999, "earth-isochron-confidence-level");
  const ageUnit = input.ageUnit === undefined ? "Ma" : C.text(input.ageUnit, 1, 4, "earth-isochron-age-unit");
  if (!["a", "ka", "Ma", "Ga"].includes(ageUnit)) throw N.fail("earth-isochron-age-unit-invalid");
  return { sourceContentSha256, system, catalogue, lambda, lambdaSource, samples, uncertaintyKind, confidenceLevel, ageUnit };
}

// York et al. (2004) iterative solution; returns null when the iteration does not converge.
function yorkRegression(samples, options = {}) {
  const maxIterations = options.maxIterations ?? 200;
  const tolerance = options.tolerance ?? 1e-13;
  const n = samples.length;
  const wx = samples.map((s) => 1 / (s.sigmaX * s.sigmaX));
  const wy = samples.map((s) => 1 / (s.sigmaY * s.sigmaY));
  const alpha = samples.map((_, i) => Math.sqrt(wx[i] * wy[i]));
  // Initial slope from ordinary least squares.
  const xs = samples.map((s) => s.x);
  const ys = samples.map((s) => s.y);
  const mx = N.mean(xs);
  const my = N.mean(ys);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  if (!(sxx > 0)) return null;
  let b = sxy / sxx;
  let iterations = 0;
  let converged = false;
  let W = null;
  let U = null;
  let V = null;
  let beta = null;
  let xBar = 0;
  let yBar = 0;
  for (iterations = 1; iterations <= maxIterations; iterations += 1) {
    W = samples.map((s, i) => wx[i] * wy[i] / (wx[i] + b * b * wy[i] - 2 * b * s.correlation * alpha[i]));
    const sumW = N.sum(W);
    xBar = N.sum(W.map((w, i) => w * xs[i])) / sumW;
    yBar = N.sum(W.map((w, i) => w * ys[i])) / sumW;
    U = xs.map((x) => x - xBar);
    V = ys.map((y) => y - yBar);
    beta = W.map((w, i) => w * (U[i] / wy[i] + b * V[i] / wx[i] - (b * U[i] + V[i]) * samples[i].correlation / alpha[i]));
    const numerator = N.sum(W.map((w, i) => w * beta[i] * V[i]));
    const denominator = N.sum(W.map((w, i) => w * beta[i] * U[i]));
    if (!(Math.abs(denominator) > 0) || !Number.isFinite(numerator / denominator)) return null;
    const next = numerator / denominator;
    const delta = Math.abs(next - b);
    b = next;
    if (delta <= tolerance * Math.max(1, Math.abs(b))) { converged = true; break; }
  }
  if (!converged) return null;
  // Final pass with the converged slope so W, means, and adjusted x are consistent.
  W = samples.map((s, i) => wx[i] * wy[i] / (wx[i] + b * b * wy[i] - 2 * b * s.correlation * alpha[i]));
  const sumW = N.sum(W);
  xBar = N.sum(W.map((w, i) => w * xs[i])) / sumW;
  yBar = N.sum(W.map((w, i) => w * ys[i])) / sumW;
  U = xs.map((x) => x - xBar);
  V = ys.map((y) => y - yBar);
  beta = W.map((w, i) => w * (U[i] / wy[i] + b * V[i] / wx[i] - (b * U[i] + V[i]) * samples[i].correlation / alpha[i]));
  const a = yBar - b * xBar;
  const xAdjusted = beta.map((item) => xBar + item);
  const xAdjustedMean = N.sum(W.map((w, i) => w * xAdjusted[i])) / sumW;
  const u = xAdjusted.map((item) => item - xAdjustedMean);
  const slopeVariance = 1 / N.sum(W.map((w, i) => w * u[i] * u[i]));
  const interceptVariance = 1 / sumW + xAdjustedMean * xAdjustedMean * slopeVariance;
  const residuals = samples.map((s, i) => s.y - b * s.x - a);
  const S = N.sum(W.map((w, i) => w * residuals[i] * residuals[i]));
  const degreesOfFreedom = n - 2;
  return {
    slope: b, intercept: a, slopeStandardError: Math.sqrt(slopeVariance), interceptStandardError: Math.sqrt(interceptVariance),
    slopeInterceptCovariance: -xAdjustedMean * slopeVariance,
    weightedResidualSumOfSquares: S, degreesOfFreedom, mswd: degreesOfFreedom > 0 ? S / degreesOfFreedom : NaN,
    iterations, weights: W, residuals, xAdjusted, yAdjusted: xAdjusted.map((x) => a + b * x), weightedMeanX: xBar, weightedMeanY: yBar,
  };
}

function ageFromSlope(slope, lambda) {
  return Math.log(1 + slope) / lambda;
}

function analyzeIsochron(value) {
  const C = core();
  const input = normalizeIsochronInput(value);
  const fit = yorkRegression(input.samples);
  if (!fit) throw N.fail("earth-isochron-regression-failed", "York iteration did not converge or the data are degenerate");
  if (!(fit.slope > 0)) throw N.fail("earth-isochron-slope-not-positive", "a negative or zero isochron slope has no radiogenic age", { slope: fit.slope });
  const alpha = 1 - input.confidenceLevel;
  const tCritical = N.studentTQuantile(1 - alpha / 2, fit.degreesOfFreedom);
  const probabilityOfFit = N.chiSquareSf(fit.weightedResidualSumOfSquares, fit.degreesOfFreedom);
  const expansion = fit.mswd > 1 ? Math.sqrt(fit.mswd) : 1;
  const ageYears = ageFromSlope(fit.slope, input.lambda);
  const ageSeYears = fit.slopeStandardError / (input.lambda * (1 + fit.slope));
  const unitFactor = { a: 1, ka: 1e-3, Ma: 1e-6, Ga: 1e-9 }[input.ageUnit];
  const age = ageYears * unitFactor;
  const ageSe = ageSeYears * unitFactor;
  const ageUncertainty = tCritical * ageSe * expansion;
  const interceptUncertainty = tCritical * fit.interceptStandardError * expansion;
  const slopeUncertainty = tCritical * fit.slopeStandardError * expansion;
  // MSWD acceptance envelope (Wendt & Carl 1991): 1 ± 2·sqrt(2/f).
  const mswdUpperBound = 1 + 2 * Math.sqrt(2 / fit.degreesOfFreedom);
  const fitClass = fit.mswd <= mswdUpperBound ? "isochron (scatter explained by analytical error)" : "errorchron (excess scatter beyond analytical error)";
  const sampleRows = input.samples.map((s, i) => ({
    id: s.id, x: s.x, y: s.y, sigmaX: N.rounded(s.sigmaX), sigmaY: N.rounded(s.sigmaY), correlation: s.correlation,
    weight: N.rounded(fit.weights[i]), fitted: N.rounded(fit.intercept + fit.slope * s.x), residual: N.rounded(fit.residuals[i]),
    weightedResidual: N.rounded(fit.residuals[i] * Math.sqrt(fit.weights[i])), xAdjusted: N.rounded(fit.xAdjusted[i]), yAdjusted: N.rounded(fit.yAdjusted[i]),
  }));
  const publicationTable = {
    schema: "agentlas.science-table/v1",
    title: `${input.catalogue.parent}–${input.catalogue.daughter} isochron (York 2004 regression)`,
    columns: [{ id: "quantity", label: "Quantity", type: "string", unit: null }, { id: "value", label: "Value", type: "number", unit: null }, { id: "uncertainty", label: `± (${input.confidenceLevel * 100}% conf.)`, type: "number", unit: null }, { id: "unit", label: "Unit", type: "string", unit: null }, { id: "note", label: "Note", type: "string", unit: null }],
    rows: [
      ["Age", N.rounded(age, 8), N.rounded(ageUncertainty, 8), input.ageUnit, `t = ln(1+slope)/λ, λ=${input.lambda} a⁻¹ (${input.lambdaSource})`],
      ["Age 1σ (a priori)", N.rounded(ageSe, 8), null, input.ageUnit, "slope SE propagated: σ_t = σ_m/(λ(1+m))"],
      [`Initial ${input.catalogue.yLabel}`, N.rounded(fit.intercept, 10), N.rounded(interceptUncertainty, 10), null, "York intercept"],
      ["Slope", N.rounded(fit.slope, 12), N.rounded(slopeUncertainty, 12), null, "York (2004) slope"],
      ["Slope 1σ (a priori)", N.rounded(fit.slopeStandardError, 12), null, null, "1/Σ W u²"],
      ["MSWD", N.rounded(fit.mswd, 8), null, null, `S/(n−2), n=${input.samples.length}`],
      ["Probability of fit", N.rounded(probabilityOfFit, 8), null, null, "χ² survival with n−2 degrees of freedom"],
      ["MSWD acceptance upper bound", N.rounded(mswdUpperBound, 8), null, null, "1 + 2·sqrt(2/(n−2)) (Wendt & Carl 1991)"],
      ["Error expansion factor", N.rounded(expansion, 8), null, null, "sqrt(MSWD) when MSWD > 1 (Isoplot model 1), else 1"],
      ["Classification", null, null, null, fitClass],
    ],
    notes: [
      `Uncertainties supplied as ${input.uncertaintyKind}; converted to 1σ absolute before weighting. Quoted ± values are t(${fit.degreesOfFreedom} df)·SE·expansion at ${input.confidenceLevel * 100}% confidence.`,
      "The age assumes an initially homogeneous daughter ratio and a closed system since crystallisation; the regression cannot test these assumptions.",
    ],
  };
  const sampleTable = {
    schema: "agentlas.science-table/v1", title: "Isochron samples, weights, and residuals",
    columns: [
      { id: "id", label: "Sample", type: "string", unit: null }, { id: "x", label: input.catalogue.xLabel, type: "number", unit: null }, { id: "y", label: input.catalogue.yLabel, type: "number", unit: null },
      { id: "sigmaX", label: "σx (1σ)", type: "number", unit: null }, { id: "sigmaY", label: "σy (1σ)", type: "number", unit: null }, { id: "correlation", label: "ρ", type: "number", unit: null },
      { id: "weight", label: "York weight W", type: "number", unit: null }, { id: "fitted", label: "Fitted y", type: "number", unit: null }, { id: "residual", label: "Residual", type: "number", unit: null },
      { id: "weightedResidual", label: "Weighted residual", type: "number", unit: null },
    ],
    rows: sampleRows.map((row) => [row.id, row.x, row.y, row.sigmaX, row.sigmaY, row.correlation, row.weight, row.fitted, row.residual, row.weightedResidual]),
  };
  const xMin = Math.min(...input.samples.map((s) => s.x));
  const xMax = Math.max(...input.samples.map((s) => s.x));
  const span = xMax - xMin || 1;
  const lineRows = [xMin - 0.05 * span, xMax + 0.05 * span].map((x) => ({ x: N.rounded(x), y: N.rounded(fit.intercept + fit.slope * x) }));
  const pointRows = input.samples.map((s) => ({ id: s.id, x: s.x, y: s.y, xLower: N.rounded(s.x - 2 * s.sigmaX), xUpper: N.rounded(s.x + 2 * s.sigmaX), yLower: N.rounded(s.y - 2 * s.sigmaY), yUpper: N.rounded(s.y + 2 * s.sigmaY) }));
  const vegaLite = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    title: `${input.catalogue.parent}–${input.catalogue.daughter} isochron: age ${N.rounded(age, 4)} ± ${N.rounded(ageUncertainty, 4)} ${input.ageUnit}, MSWD ${N.rounded(fit.mswd, 3)}`,
    background: "white", width: 600, height: 380,
    layer: [
      { data: { values: lineRows }, mark: { type: "line", color: "#B85C38", strokeWidth: 2 }, encoding: { x: { field: "x", type: "quantitative", title: input.catalogue.xLabel, scale: { zero: false } }, y: { field: "y", type: "quantitative", title: input.catalogue.yLabel, scale: { zero: false } } } },
      { data: { values: pointRows }, mark: { type: "rule", color: "#5C7080" }, encoding: { x: { field: "xLower", type: "quantitative" }, x2: { field: "xUpper" }, y: { field: "y", type: "quantitative" } } },
      { data: { values: pointRows }, mark: { type: "rule", color: "#5C7080" }, encoding: { x: { field: "x", type: "quantitative" }, y: { field: "yLower", type: "quantitative" }, y2: { field: "yUpper" } } },
      { data: { values: pointRows }, mark: { type: "point", filled: true, color: "#2E6F62", size: 60 }, encoding: { x: { field: "x", type: "quantitative" }, y: { field: "y", type: "quantitative" }, tooltip: [{ field: "id", type: "nominal" }, { field: "x", type: "quantitative" }, { field: "y", type: "quantitative" }] } },
    ],
    config: vegaConfig(),
  };
  const contentReceipts = {
    publicationTable: C.contentReceipt("isochron-summary-table", "application/vnd.agentlas.science-table+json", publicationTable),
    sampleTable: C.contentReceipt("isochron-sample-table", "application/vnd.agentlas.science-table+json", sampleTable),
    figure: C.contentReceipt("isochron-figure", "application/vnd.vegalite.v5+json", vegaLite),
  };
  const analysis = {
    schema: "agentlas.earth.isochron-analysis/v1",
    methodRevision: "york-2004-correlated-errors-mswd/v1",
    source: { sourceContentSha256: input.sourceContentSha256, sampleCount: input.samples.length },
    settings: { system: input.system, parent: input.catalogue.parent, daughter: input.catalogue.daughter, normalizer: input.catalogue.normalizer, decayConstantPerYear: input.lambda, decayConstantSource: input.lambdaSource, uncertaintyKind: input.uncertaintyKind, confidenceLevel: input.confidenceLevel, ageUnit: input.ageUnit },
    regression: {
      slope: N.rounded(fit.slope), slopeStandardError: N.rounded(fit.slopeStandardError), intercept: N.rounded(fit.intercept), interceptStandardError: N.rounded(fit.interceptStandardError),
      slopeInterceptCovariance: N.rounded(fit.slopeInterceptCovariance), weightedResidualSumOfSquares: N.rounded(fit.weightedResidualSumOfSquares), degreesOfFreedom: fit.degreesOfFreedom,
      mswd: N.rounded(fit.mswd), probabilityOfFit: N.rounded(probabilityOfFit), mswdUpperBound: N.rounded(mswdUpperBound), classification: fitClass,
      iterations: fit.iterations, weightedMeanX: N.rounded(fit.weightedMeanX), weightedMeanY: N.rounded(fit.weightedMeanY), tCritical: N.rounded(tCritical), errorExpansionFactor: N.rounded(expansion),
    },
    age: { value: N.rounded(age), standardError: N.rounded(ageSe), uncertainty: N.rounded(ageUncertainty), unit: input.ageUnit, years: N.rounded(ageYears, 3), initialRatio: N.rounded(fit.intercept), initialRatioUncertainty: N.rounded(interceptUncertainty) },
    samples: sampleRows,
    publicationTable, sampleTable, vegaLite, contentReceipts,
    assumptions: [
      "York (2004) maximum-likelihood line with per-sample x/y uncertainties and error correlation; no outlier rejection or model-2/model-3 error treatment.",
      "The isochron age requires an initially homogeneous daughter-isotope ratio and closed-system behaviour; MSWD tests only internal scatter against the stated analytical errors.",
      "Decay constants are tabulated with their sources; changing λ changes the age but not the regression.",
    ],
    rendererCompatibility: { rendererId: "agentlas.vega", hostRequired: true, bundledRenderer: false, interactive: "tooltip-only" },
  };
  return { ...analysis, analysisSha256: N.sha256Json(analysis) };
}

// ---------------------------------------------------------------------------
// 2. TAS classification and AFM ternary transform
// ---------------------------------------------------------------------------

// Field vertices (SiO2 wt%, Na2O+K2O wt%) after Le Bas et al. (1986) as tabulated by Le Maitre et al.
// (2002). The diagram is closed at 35 and 90 wt% SiO2 and at 18 wt% total alkali; those closures are
// plotting limits, not rock boundaries. Fields are tested in this order and shared edges belong to the
// first matching field.
const TAS_FIELDS = Object.freeze([
  { id: "picrobasalt", label: "Picrobasalt", vertices: [[41, 0], [41, 3], [45, 3], [45, 0]] },
  { id: "basalt", label: "Basalt", vertices: [[45, 0], [45, 5], [52, 5], [52, 0]] },
  { id: "basaltic-andesite", label: "Basaltic andesite", vertices: [[52, 0], [52, 5], [57, 5.9], [57, 0]] },
  { id: "andesite", label: "Andesite", vertices: [[57, 0], [57, 5.9], [63, 7], [63, 0]] },
  { id: "dacite", label: "Dacite", vertices: [[63, 0], [63, 7], [69, 8], [77, 0]] },
  { id: "rhyolite", label: "Rhyolite", vertices: [[77, 0], [69, 8], [69, 18], [90, 18], [90, 0]] },
  { id: "trachybasalt", label: "Trachybasalt", vertices: [[45, 5], [49.4, 7.3], [52, 5]] },
  { id: "basaltic-trachyandesite", label: "Basaltic trachyandesite", vertices: [[49.4, 7.3], [53, 9.3], [57, 5.9], [52, 5]] },
  { id: "trachyandesite", label: "Trachyandesite", vertices: [[53, 9.3], [57.6, 11.7], [63, 7], [57, 5.9]] },
  { id: "trachyte-trachydacite", label: "Trachyte / trachydacite", vertices: [[57.6, 11.7], [63, 7], [69, 8], [69, 18], [63, 18], [63, 16.2]] },
  { id: "tephrite-basanite", label: "Tephrite / basanite", vertices: [[41, 3], [41, 7], [45, 9.4], [49.4, 7.3], [45, 5], [45, 3]] },
  { id: "phonotephrite", label: "Phonotephrite", vertices: [[45, 9.4], [48.4, 11.5], [53, 9.3], [49.4, 7.3]] },
  { id: "tephriphonolite", label: "Tephriphonolite", vertices: [[48.4, 11.5], [52.5, 14], [57.6, 11.7], [53, 9.3]] },
  { id: "phonolite", label: "Phonolite", vertices: [[52.5, 14], [57.6, 11.7], [63, 16.2], [63, 18], [52.5, 18]] },
  { id: "foidite", label: "Foidite", vertices: [[35, 0], [41, 0], [41, 7], [45, 9.4], [48.4, 11.5], [52.5, 14], [52.5, 18], [35, 18]] },
].map((field) => Object.freeze({ ...field, vertices: field.vertices.map((vertex) => Object.freeze(vertex.slice())) })));

const MAJOR_OXIDES = Object.freeze(["sio2", "tio2", "al2o3", "fe2o3", "feo", "mno", "mgo", "cao", "na2o", "k2o", "p2o5"]);
const VOLATILE_OXIDES = Object.freeze(["loi", "h2o", "co2"]);
const FE2O3_TO_FEO = 0.8998; // 2·M(FeO)/M(Fe2O3) = 143.69/159.69

function pointOnSegment(px, py, ax, ay, bx, by) {
  const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  if (Math.abs(cross) > 1e-9 * Math.max(1, Math.hypot(bx - ax, by - ay))) return false;
  return px >= Math.min(ax, bx) - 1e-12 && px <= Math.max(ax, bx) + 1e-12 && py >= Math.min(ay, by) - 1e-12 && py <= Math.max(ay, by) + 1e-12;
}

// Even-odd ray casting; boundary points count as inside.
function pointInPolygon(px, py, vertices) {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i, i += 1) {
    const [xi, yi] = vertices[i];
    const [xj, yj] = vertices[j];
    if (pointOnSegment(px, py, xi, yi, xj, yj)) return true;
    const intersects = (yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function classifyTas(sio2, totalAlkali) {
  for (const field of TAS_FIELDS) if (pointInPolygon(sio2, totalAlkali, field.vertices)) return field;
  return null;
}

function normalizeTasInput(value) {
  const C = core();
  const input = C.exactObject(value, ["sourceContentSha256", "samples", "normalizeToAnhydrous"], "earth-tas-input");
  const sourceContentSha256 = assertSourceSha(input.sourceContentSha256);
  if (!Array.isArray(input.samples) || input.samples.length < 1 || input.samples.length > 5_000) throw N.fail("earth-tas-samples-length-invalid", "TAS classification requires 1–5000 samples");
  const normalizeToAnhydrous = input.normalizeToAnhydrous === undefined ? true : input.normalizeToAnhydrous;
  if (typeof normalizeToAnhydrous !== "boolean") throw N.fail("earth-tas-normalize-invalid");
  const ids = new Set();
  const samples = input.samples.map((row, index) => {
    const item = C.exactObject(row, ["id", ...MAJOR_OXIDES, ...VOLATILE_OXIDES], "earth-tas-sample");
    const id = C.text(item.id, 1, 80, "earth-tas-sample-id");
    if (ids.has(id)) throw N.fail("earth-tas-sample-id-duplicate", `duplicate sample id ${id}`, { index });
    ids.add(id);
    const oxides = {};
    for (const oxide of [...MAJOR_OXIDES, ...VOLATILE_OXIDES]) {
      oxides[oxide] = item[oxide] === undefined || item[oxide] === null ? null : C.finite(item[oxide], 0, 100, `earth-tas-sample-${oxide}`);
    }
    for (const required of ["sio2", "na2o", "k2o"]) if (oxides[required] === null) throw N.fail("earth-tas-sample-required-oxide-missing", `${required} is required for TAS`, { id, oxide: required });
    return { id, oxides };
  });
  return { sourceContentSha256, samples, normalizeToAnhydrous };
}

function analyzeTasClassification(value) {
  const C = core();
  const input = normalizeTasInput(value);
  const warnings = [];
  const rows = input.samples.map((sample) => {
    const majors = MAJOR_OXIDES.filter((oxide) => sample.oxides[oxide] !== null);
    const majorSum = N.sum(majors.map((oxide) => sample.oxides[oxide]));
    const volatileSum = N.sum(VOLATILE_OXIDES.filter((oxide) => sample.oxides[oxide] !== null).map((oxide) => sample.oxides[oxide]));
    const totalSum = majorSum + volatileSum;
    let factor = 1;
    let normalizationStatus = "as-reported";
    if (input.normalizeToAnhydrous) {
      if (!(majorSum > 0)) throw N.fail("earth-tas-major-sum-invalid", "major oxide sum must be positive", { id: sample.id });
      factor = 100 / majorSum;
      normalizationStatus = "anhydrous-100";
      if (majorSum < 95 || majorSum > 103) warnings.push(`${sample.id}: major-oxide sum ${N.rounded(majorSum, 3)} wt% is outside 95–103 before normalisation; check the analysis or missing oxides.`);
    }
    const sio2 = sample.oxides.sio2 * factor;
    const na2o = sample.oxides.na2o * factor;
    const k2o = sample.oxides.k2o * factor;
    const totalAlkali = na2o + k2o;
    const field = classifyTas(sio2, totalAlkali);
    const feoTotal = sample.oxides.feo === null && sample.oxides.fe2o3 === null ? null : (sample.oxides.feo ?? 0) * factor + (sample.oxides.fe2o3 ?? 0) * factor * FE2O3_TO_FEO;
    const mgo = sample.oxides.mgo === null ? null : sample.oxides.mgo * factor;
    let afm = null;
    if (feoTotal !== null && mgo !== null) {
      const total = totalAlkali + feoTotal + mgo;
      if (total > 0) {
        const a = totalAlkali / total;
        const f = feoTotal / total;
        const m = mgo / total;
        afm = { a: N.rounded(a), f: N.rounded(f), m: N.rounded(m), ternaryX: N.rounded(m + f / 2), ternaryY: N.rounded(f * Math.sqrt(3) / 2) };
      }
    }
    return {
      id: sample.id, reportedMajorSum: N.rounded(majorSum), reportedVolatileSum: N.rounded(volatileSum), reportedTotal: N.rounded(totalSum), normalizationFactor: N.rounded(factor), normalizationStatus,
      sio2: N.rounded(sio2), na2o: N.rounded(na2o), k2o: N.rounded(k2o), totalAlkali: N.rounded(totalAlkali),
      tasFieldId: field ? field.id : null, tasField: field ? field.label : "outside TAS diagram",
      // Le Bas et al. (1986) subdivide the three trachy- fields by Na2O − 2 ≥ K2O (sodic: hawaiite, mugearite, benmoreite) versus potassic (potassic trachybasalt, shoshonite, latite).
      alkalinity: field && ["trachybasalt", "basaltic-trachyandesite", "trachyandesite"].includes(field.id) ? (na2o - 2 >= k2o ? "sodic (Na2O − 2 ≥ K2O)" : "potassic (Na2O − 2 < K2O)") : null,
      feoTotal: feoTotal === null ? null : N.rounded(feoTotal), mgo: mgo === null ? null : N.rounded(mgo), afm,
    };
  });
  const fieldCounts = {};
  for (const row of rows) fieldCounts[row.tasField] = (fieldCounts[row.tasField] ?? 0) + 1;
  const publicationTable = {
    schema: "agentlas.science-table/v1",
    title: "TAS classification (Le Bas et al. 1986) and AFM ternary coordinates",
    columns: [
      { id: "id", label: "Sample", type: "string", unit: null }, { id: "sio2", label: "SiO2", type: "number", unit: "wt%" }, { id: "na2o", label: "Na2O", type: "number", unit: "wt%" }, { id: "k2o", label: "K2O", type: "number", unit: "wt%" },
      { id: "totalAlkali", label: "Na2O + K2O", type: "number", unit: "wt%" }, { id: "tasField", label: "TAS field", type: "string", unit: null }, { id: "alkalinity", label: "Na/K series", type: "string", unit: null },
      { id: "feoTotal", label: "FeO total", type: "number", unit: "wt%" }, { id: "mgo", label: "MgO", type: "number", unit: "wt%" },
      { id: "afmA", label: "A fraction", type: "number", unit: null }, { id: "afmF", label: "F fraction", type: "number", unit: null }, { id: "afmM", label: "M fraction", type: "number", unit: null },
      { id: "normalizationFactor", label: "Anhydrous factor", type: "number", unit: null },
    ],
    rows: rows.map((row) => [row.id, row.sio2, row.na2o, row.k2o, row.totalAlkali, row.tasField, row.alkalinity, row.feoTotal, row.mgo, row.afm ? row.afm.a : null, row.afm ? row.afm.f : null, row.afm ? row.afm.m : null, row.normalizationFactor]),
    notes: [
      input.normalizeToAnhydrous ? "Major oxides were recalculated to 100 wt% volatile-free before plotting (Le Bas et al. 1986 recommendation)." : "Oxides were used as reported without anhydrous recalculation.",
      "Trachyte vs trachydacite and tephrite vs basanite need CIPW normative quartz/olivine, which is not computed; the combined field label is reported. AFM uses FeO_total = FeO + 0.8998·Fe2O3.",
    ],
  };
  const fieldTable = {
    schema: "agentlas.science-table/v1", title: "TAS field vertex catalogue used for classification",
    columns: [{ id: "fieldId", label: "Field id", type: "string", unit: null }, { id: "label", label: "Field", type: "string", unit: null }, { id: "vertices", label: "Vertices (SiO2, Na2O+K2O)", type: "string", unit: "wt%" }, { id: "count", label: "Samples", type: "integer", unit: "count" }],
    rows: TAS_FIELDS.map((field) => [field.id, field.label, field.vertices.map((vertex) => `(${vertex[0]}, ${vertex[1]})`).join(" "), fieldCounts[field.label] ?? 0]),
  };
  const outlineRows = TAS_FIELDS.flatMap((field) => field.vertices.map((vertex, index) => ({ field: field.label, order: index, sio2: vertex[0], alkali: vertex[1] })).concat([{ field: field.label, order: field.vertices.length, sio2: field.vertices[0][0], alkali: field.vertices[0][1] }]));
  const vegaLite = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    title: "Total alkali–silica diagram (Le Bas et al. 1986)",
    background: "white", width: 620, height: 400,
    layer: [
      { data: { values: outlineRows }, mark: { type: "line", color: "#C9C5BE", strokeWidth: 1 }, encoding: { x: { field: "sio2", type: "quantitative", title: "SiO2 (wt%)", scale: { domain: [35, 80] } }, y: { field: "alkali", type: "quantitative", title: "Na2O + K2O (wt%)", scale: { domain: [0, 16] } }, detail: { field: "field", type: "nominal" }, order: { field: "order", type: "quantitative" } } },
      { data: { values: rows.map((row) => ({ id: row.id, sio2: row.sio2, alkali: row.totalAlkali, field: row.tasField })) }, mark: { type: "point", filled: true, color: "#2E6F62", size: 55 }, encoding: { x: { field: "sio2", type: "quantitative" }, y: { field: "alkali", type: "quantitative" }, tooltip: [{ field: "id", type: "nominal" }, { field: "field", type: "nominal" }, { field: "sio2", type: "quantitative", format: ".2f" }, { field: "alkali", type: "quantitative", format: ".2f" }] } },
    ],
    config: vegaConfig(),
  };
  const afmRows = rows.filter((row) => row.afm).map((row) => ({ id: row.id, x: row.afm.ternaryX, y: row.afm.ternaryY, a: row.afm.a, f: row.afm.f, m: row.afm.m }));
  const afmVegaLite = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    title: "AFM ternary (A = Na2O+K2O, F = FeO total, M = MgO)",
    background: "white", width: 480, height: 420,
    layer: [
      { data: { values: [{ order: 0, x: 0, y: 0, corner: "A" }, { order: 1, x: 1, y: 0, corner: "M" }, { order: 2, x: 0.5, y: N.rounded(Math.sqrt(3) / 2) , corner: "F" }, { order: 3, x: 0, y: 0, corner: "A" }] }, mark: { type: "line", color: "#7A7772", strokeWidth: 1.2 }, encoding: { x: { field: "x", type: "quantitative", axis: null, scale: { domain: [-0.05, 1.05] } }, y: { field: "y", type: "quantitative", axis: null, scale: { domain: [-0.05, 0.95] } }, order: { field: "order", type: "quantitative" } } },
      { data: { values: afmRows }, mark: { type: "point", filled: true, color: "#B85C38", size: 55 }, encoding: { x: { field: "x", type: "quantitative" }, y: { field: "y", type: "quantitative" }, tooltip: [{ field: "id", type: "nominal" }, { field: "a", type: "quantitative", format: ".3f" }, { field: "f", type: "quantitative", format: ".3f" }, { field: "m", type: "quantitative", format: ".3f" }] } },
    ],
    config: vegaConfig(),
  };
  const contentReceipts = {
    publicationTable: C.contentReceipt("tas-classification-table", "application/vnd.agentlas.science-table+json", publicationTable),
    fieldTable: C.contentReceipt("tas-field-table", "application/vnd.agentlas.science-table+json", fieldTable),
    figure: C.contentReceipt("tas-figure", "application/vnd.vegalite.v5+json", vegaLite),
    afmFigure: C.contentReceipt("afm-figure", "application/vnd.vegalite.v5+json", afmVegaLite),
  };
  const analysis = {
    schema: "agentlas.earth.tas-classification/v1",
    methodRevision: "le-bas-1986-polygons-afm-ternary/v1",
    warnings,
    source: { sourceContentSha256: input.sourceContentSha256, sampleCount: input.samples.length },
    settings: { normalizeToAnhydrous: input.normalizeToAnhydrous, fe2o3ToFeoFactor: FE2O3_TO_FEO, fieldCatalogue: "Le Bas et al. (1986) via Le Maitre et al. (2002); closure at SiO2 35–90 and alkali 18 wt%" },
    fieldCounts, samples: rows,
    publicationTable, fieldTable, vegaLite, afmVegaLite, contentReceipts,
    assumptions: [
      "TAS applies to fresh volcanic rocks; altered, cumulate, or plutonic samples need other schemes.",
      "Boundary points are assigned to the first field in catalogue order; the vertex table is reported so the assignment is auditable.",
      "The AFM transform reports ternary coordinates only; no tholeiitic/calc-alkaline divider is asserted.",
    ],
    rendererCompatibility: { rendererId: "agentlas.vega", hostRequired: true, bundledRenderer: false, interactive: "tooltip-only" },
  };
  return { ...analysis, analysisSha256: N.sha256Json(analysis) };
}

module.exports = {
  DECAY_SYSTEMS,
  FE2O3_TO_FEO,
  MAJOR_OXIDES,
  TAS_FIELDS,
  VOLATILE_OXIDES,
  ageFromSlope,
  analyzeIsochron,
  analyzeTasClassification,
  classifyTas,
  normalizeIsochronInput,
  normalizeTasInput,
  pointInPolygon,
  yorkRegression,
};
