"use strict";

// Uncertainty propagation for a closed-form measurement model y = f(x₁..xₙ):
// first-order (linear) propagation with exact forward-mode derivatives and a
// seeded Monte Carlo with Cholesky-correlated inputs, compared side by side.
//
// References: JCGM 100:2008 (GUM) §5.1–5.2 (law of propagation of
// uncertainty) and JCGM 101:2008 (GUM Supplement 1, Monte Carlo method).

const common = require("./analysis-common.cjs");
const expression = require("./expression.cjs");

const { PhysicsError } = common;

const MAX_VARIABLES = 24;
const DEFAULT_SAMPLES = 20_000;
const DEFAULT_SEED = 20240901;
const HISTOGRAM_BINS = 80;

const FORMULAS = Object.freeze({
  pendulum_g: { expression: "4*pi^2*L/T^2", description: "Local gravitational acceleration from a simple pendulum length L and period T (small-angle limit).", units_hint: "L in m, T in s → g in m/s²" },
  ohm_resistance: { expression: "V/I", description: "Resistance from voltage V and current I (Ohm's law).", units_hint: "V in V, I in A → R in Ω" },
  free_fall_g: { expression: "2*h/t^2", description: "Gravitational acceleration from drop height h and fall time t (rest start, no drag).", units_hint: "h in m, t in s → g in m/s²" },
  kinetic_energy: { expression: "0.5*m*v^2", description: "Translational kinetic energy of mass m at speed v.", units_hint: "m in kg, v in m/s → E in J" },
  cylinder_density: { expression: "m/(pi*r^2*h)", description: "Density of a solid cylinder from mass m, radius r, and height h.", units_hint: "m in kg, r and h in m → ρ in kg/m³" },
  refractive_index_snell: { expression: "sin(i)/sin(r)", description: "Refractive index from incidence angle i and refraction angle r (Snell's law, medium 1 = vacuum/air).", units_hint: "i and r in rad → n dimensionless" },
  lens_focal_length: { expression: "1/(1/u+1/v)", description: "Thin-lens focal length from object distance u and image distance v.", units_hint: "u and v in m → f in m" },
  projectile_range: { expression: "v^2*sin(2*theta)/g", description: "Range of a drag-free projectile launched at speed v and angle theta on level ground.", units_hint: "v in m/s, theta in rad, g in m/s² → R in m" },
  spring_constant: { expression: "4*pi^2*m/T^2", description: "Spring constant from oscillating mass m and period T.", units_hint: "m in kg, T in s → k in N/m" },
  resistivity: { expression: "R*pi*r^2/L", description: "Resistivity of a wire from resistance R, radius r, and length L.", units_hint: "R in Ω, r and L in m → ρ in Ω·m" },
  young_modulus: { expression: "F*L/(A*dL)", description: "Young's modulus from load F, original length L, cross-section A, and extension dL.", units_hint: "F in N, L and dL in m, A in m² → E in Pa" },
  specific_heat: { expression: "Q/(m*dT)", description: "Specific heat capacity from heat Q, mass m, and temperature rise dT.", units_hint: "Q in J, m in kg, dT in K → c in J/(kg·K)" },
});

function normalizeInput(input) {
  const value = common.exactObject(input, ["expression", "formula", "variables", "correlation", "options"], "physics-uncertainty-input");
  if ((value.expression === undefined) === (value.formula === undefined)) throw new PhysicsError("physics-uncertainty-model-invalid", "provide exactly one of expression or formula");
  let formulaId = null;
  let expressionText;
  if (value.formula !== undefined) {
    formulaId = common.enumText(value.formula, Object.keys(FORMULAS), "physics-uncertainty-formula");
    expressionText = FORMULAS[formulaId].expression;
  } else {
    expressionText = common.text(value.expression, 1, expression.MAX_CHARS, "physics-uncertainty-expression");
  }
  const ast = expression.parseExpression(expressionText);
  const required = expression.variablesOf(ast);
  if (!Array.isArray(value.variables) || value.variables.length < 1 || value.variables.length > MAX_VARIABLES) throw new PhysicsError("physics-uncertainty-variables-invalid", `variables must contain 1..${MAX_VARIABLES} entries`);
  const seen = new Set();
  const variables = value.variables.map((entry, index) => {
    const item = common.exactObject(entry, ["name", "value", "sigma", "unit", "distribution"], `physics-uncertainty-variable-${index}`);
    const name = common.text(item.name, 1, 64, `physics-uncertainty-variable-${index}-name`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new PhysicsError(`physics-uncertainty-variable-${index}-name-invalid`, "variable names must be identifiers");
    if (seen.has(name)) throw new PhysicsError("physics-uncertainty-variable-duplicate", `variable "${name}" is declared twice`);
    seen.add(name);
    return {
      name,
      value: common.finite(item.value, -Number.MAX_VALUE, Number.MAX_VALUE, `physics-uncertainty-variable-${index}-value`),
      sigma: common.finite(item.sigma, 0, Number.MAX_VALUE, `physics-uncertainty-variable-${index}-sigma`),
      unit: common.optionalText(item.unit, 64, `physics-uncertainty-variable-${index}-unit`),
      distribution: item.distribution === undefined ? "normal" : common.enumText(item.distribution, ["normal", "uniform"], `physics-uncertainty-variable-${index}-distribution`),
    };
  });
  const missing = required.filter((name) => !seen.has(name));
  if (missing.length) throw new PhysicsError("physics-uncertainty-variable-missing", `expression uses undeclared variable(s): ${missing.join(", ")}`);
  const unused = variables.filter((entry) => !required.includes(entry.name)).map((entry) => entry.name);
  const n = variables.length;
  let correlation = null;
  if (value.correlation !== undefined) {
    if (!Array.isArray(value.correlation) || value.correlation.length !== n) throw new PhysicsError("physics-uncertainty-correlation-invalid", `correlation must be a ${n}×${n} matrix in variable order`);
    correlation = value.correlation.map((row, i) => common.finiteArray(row, n, n, `physics-uncertainty-correlation-row-${i}`, -1, 1));
    for (let i = 0; i < n; i += 1) {
      if (correlation[i][i] !== 1) throw new PhysicsError("physics-uncertainty-correlation-invalid", "correlation diagonal must be 1");
      for (let j = 0; j < i; j += 1) if (correlation[i][j] !== correlation[j][i]) throw new PhysicsError("physics-uncertainty-correlation-invalid", "correlation matrix must be symmetric");
    }
    common.cholesky(correlation, "physics-uncertainty-correlation");
  }
  const optionsInput = value.options === undefined ? {} : common.exactObject(value.options, ["samples", "seed", "result_unit"], "physics-uncertainty-options");
  const options = {
    samples: common.optionalInteger(optionsInput.samples, 1_000, 200_000, "physics-uncertainty-samples", DEFAULT_SAMPLES),
    seed: common.optionalInteger(optionsInput.seed, 0, 4_294_967_295, "physics-uncertainty-seed", DEFAULT_SEED),
    resultUnit: common.optionalText(optionsInput.result_unit, 64, "physics-uncertainty-result-unit"),
  };
  return { formulaId, expressionText, ast, variables, correlation, options, unused };
}

function skewness(values, center, spread) {
  if (spread <= 0 || values.length < 3) return 0;
  const n = values.length;
  const third = values.reduce((sum, value) => sum + ((value - center) / spread) ** 3, 0) / n;
  return third * Math.sqrt(n * (n - 1)) / (n - 2);
}

function analyzeUncertaintyPropagation(input) {
  const normalized = normalizeInput(input);
  const { ast, variables, options } = normalized;
  const n = variables.length;
  const warnings = [];
  if (normalized.unused.length) warnings.push(`Declared variable(s) not used by the expression: ${normalized.unused.join(", ")}.`);
  const values = Object.fromEntries(variables.map((entry) => [entry.name, entry.value]));
  const dual = expression.evaluateDual(ast, values);
  if (!Number.isFinite(dual.value)) throw new PhysicsError("physics-uncertainty-model-non-finite", "the expression is not finite at the central values");
  const gradient = variables.map((entry) => dual.gradient[entry.name] ?? 0);
  if (gradient.some((entry) => !Number.isFinite(entry))) throw new PhysicsError("physics-uncertainty-gradient-non-finite", "a partial derivative is not finite at the central values");
  const correlation = normalized.correlation ?? common.identity(n);
  const covariance = variables.map((row, i) => variables.map((column, j) => correlation[i][j] * row.sigma * column.sigma));
  const linearVariance = common.dot(gradient, common.matVec(covariance, gradient));
  const linearSigma = Math.sqrt(Math.max(0, linearVariance));
  const contributions = variables.map((entry, i) => ({ variable: entry.name, sensitivity: gradient[i], contribution: gradient[i] * entry.sigma, variance: (gradient[i] * entry.sigma) ** 2 }));
  const uncorrelatedVariance = contributions.reduce((sum, entry) => sum + entry.variance, 0);
  contributions.forEach((entry) => { entry.fraction = uncorrelatedVariance > 0 ? entry.variance / uncorrelatedVariance : 0; });
  const correlationVariance = linearVariance - uncorrelatedVariance;

  // Monte Carlo with Cholesky-correlated standard normals.
  const lower = common.cholesky(correlation, "physics-uncertainty-correlation");
  const random = common.createRandom(options.seed);
  const samples = [];
  let nonFinite = 0;
  const draw = new Array(n).fill(0);
  const sampleValues = {};
  for (let s = 0; s < options.samples; s += 1) {
    for (let i = 0; i < n; i += 1) draw[i] = random.normal();
    for (let i = 0; i < n; i += 1) {
      let z = 0;
      for (let k = 0; k <= i; k += 1) z += lower[i][k] * draw[k];
      const entry = variables[i];
      if (entry.distribution === "uniform") {
        const halfWidth = entry.sigma * Math.sqrt(3);
        sampleValues[entry.name] = entry.value + halfWidth * (2 * common.normalCdf(z) - 1);
      } else sampleValues[entry.name] = entry.value + entry.sigma * z;
    }
    const y = expression.evaluate(ast, sampleValues);
    if (Number.isFinite(y)) samples.push(y); else nonFinite += 1;
  }
  const nonFiniteFraction = nonFinite / options.samples;
  if (nonFiniteFraction > 0.01) throw new PhysicsError("physics-uncertainty-monte-carlo-non-finite", `${(nonFiniteFraction * 100).toFixed(2)} % of Monte Carlo samples are not finite`);
  if (nonFinite > 0) warnings.push(`${nonFinite} Monte Carlo sample(s) were not finite and were dropped.`);
  if (samples.length < 100) throw new PhysicsError("physics-uncertainty-monte-carlo-too-few", "too few finite Monte Carlo samples");
  const mcMean = common.mean(samples);
  const mcStd = common.sampleStandardDeviation(samples, mcMean);
  const sorted = [...samples].sort((left, right) => left - right);
  const q = (p) => common.quantile(sorted, p);
  const mc = { mean: mcMean, std: mcStd, median: q(0.5), q025: q(0.025), q16: q(0.16), q84: q(0.84), q975: q(0.975), skewness: skewness(samples, mcMean, mcStd), stdStatisticalError: mcStd / Math.sqrt(2 * samples.length), meanStatisticalError: mcStd / Math.sqrt(samples.length) };
  const shift = linearSigma > 0 ? Math.abs(mcMean - dual.value) / linearSigma : (mcMean === dual.value ? 0 : Infinity);
  const spreadRatio = linearSigma > 0 ? mcStd / linearSigma - 1 : (mcStd === 0 ? 0 : Infinity);
  if (shift > 0.1 || Math.abs(spreadRatio) > 0.1) warnings.push(`Nonlinearity: Monte Carlo mean shifts ${shift.toPrecision(3)} σ_lin from the linear value and σ_MC/σ_lin − 1 = ${spreadRatio.toPrecision(3)}; report the Monte Carlo interval rather than the linear symmetric band.`);
  if (linearSigma === 0) warnings.push("All input uncertainties are zero or the expression is insensitive to them; the propagated uncertainty is zero.");

  const unit = options.resultUnit;
  const z68 = common.normalQuantile(0.84);
  const z95 = common.normalQuantile(0.975);
  const publicationTable = common.scienceTable("Uncertainty propagation comparison", [
    { id: "method", label: "Method", type: "string" }, { id: "central", label: "Central value", unit }, { id: "sigma", label: "Std uncertainty", unit },
    { id: "low68", label: "Lower (68 %)", unit }, { id: "high68", label: "Upper (68 %)", unit }, { id: "low95", label: "Lower (95 %)", unit }, { id: "high95", label: "Upper (95 %)", unit },
  ], [
    ["Linear (GUM first order)", dual.value, linearSigma, dual.value - z68 * linearSigma, dual.value + z68 * linearSigma, dual.value - z95 * linearSigma, dual.value + z95 * linearSigma],
    [`Monte Carlo (${samples.length} samples, seed ${options.seed})`, mc.mean, mc.std, mc.q16, mc.q84, mc.q025, mc.q975],
  ]);
  const contributionTable = common.scienceTable("Linear uncertainty budget", [
    { id: "variable", label: "Variable", type: "string" }, { id: "value", label: "Value" }, { id: "sigma", label: "σ" }, { id: "unit", label: "Unit", type: "string" }, { id: "distribution", label: "Distribution", type: "string" },
    { id: "sensitivity", label: "∂f/∂x" }, { id: "contribution", label: "|∂f/∂x|·σ", unit }, { id: "fraction", label: "Variance fraction (uncorrelated)" },
  ], variables.map((entry, i) => [entry.name, entry.value, entry.sigma, entry.unit, entry.distribution, gradient[i], Math.abs(contributions[i].contribution), contributions[i].fraction]));
  const quantileTable = common.scienceTable("Monte Carlo distribution summary", [
    { id: "statistic", label: "Statistic", type: "string" }, { id: "value", label: "Value", unit },
  ], [["Mean", mc.mean], ["Standard deviation", mc.std], ["Median", mc.median], ["2.5 % quantile", mc.q025], ["16 % quantile", mc.q16], ["84 % quantile", mc.q84], ["97.5 % quantile", mc.q975], ["Skewness", mc.skewness], ["Std. error of the mean", mc.meanStatisticalError], ["Std. error of the standard deviation", mc.stdStatisticalError]]);

  // Histogram (≤ 80 bins) over the central 99.8 % of samples.
  const histogramLow = q(0.001);
  const histogramHigh = q(0.999);
  const span = histogramHigh - histogramLow;
  const bins = span > 0 ? HISTOGRAM_BINS : 1;
  const binWidth = span > 0 ? span / bins : 1;
  const counts = new Array(bins).fill(0);
  for (const sample of samples) {
    if (sample < histogramLow || sample > histogramHigh) continue;
    const index = Math.min(bins - 1, Math.floor((sample - histogramLow) / binWidth));
    counts[index] += 1;
  }
  const histogram = counts.map((count, index) => ({ x: histogramLow + index * binWidth, x2: histogramLow + (index + 1) * binWidth, count, density: count / (samples.length * binWidth) }));
  const width = 680;
  const markers = [
    { label: "linear − σ", x: dual.value - linearSigma }, { label: "linear", x: dual.value }, { label: "linear + σ", x: dual.value + linearSigma },
  ];
  const contributionRows = contributions.map((entry) => ({ variable: entry.variable, fraction: entry.fraction }));
  const spec = common.stackedVegaFigure({
    description: `Monte Carlo distribution of ${normalized.expressionText} (${samples.length} samples) with linear central value ± σ markers, and the linear variance budget per input variable.`,
    width,
    data: [
      { name: "histogram", values: histogram },
      { name: "markers", values: markers },
      { name: "contributions", values: contributionRows },
      { name: "domainHint", values: [{ x: Math.min(histogramLow, markers[0].x), x2: Math.max(histogramHigh, markers[2].x) }] },
    ],
    panels: [
      {
        name: "histogramPanel", height: 260, title: "Monte Carlo samples",
        scales: [
          { name: "x", type: "linear", domain: { fields: [{ data: "domainHint", field: "x" }, { data: "domainHint", field: "x2" }] }, range: "width", nice: true, zero: false },
          { name: "y", type: "linear", domain: { data: "histogram", field: "density" }, range: "height", nice: true, zero: true },
        ],
        axes: [common.axis("bottom", "x", `Result${unit ? ` (${unit})` : ""}`), common.axis("left", "y", "Probability density")],
        marks: [
          { type: "rect", from: { data: "histogram" }, encode: { enter: { x: { scale: "x", field: "x" }, x2: { scale: "x", field: "x2" }, y: { scale: "y", field: "density" }, y2: { scale: "y", value: 0 }, fill: { value: common.PALETTE.data }, opacity: { value: 0.75 } } } },
          { type: "rule", from: { data: "markers" }, encode: { enter: { x: { scale: "x", field: "x" }, y: { value: 0 }, y2: { value: 260 }, stroke: { value: common.PALETTE.fit }, strokeWidth: { value: 1.5 }, strokeDash: { value: [4, 3] } } } },
        ],
      },
      {
        name: "budgetPanel", height: Math.max(60, 26 * n), title: "Linear variance budget (uncorrelated fractions)",
        scales: [
          { name: "x", type: "linear", domain: [0, 1], range: "width", nice: false, zero: true },
          { name: "y", type: "band", domain: { data: "contributions", field: "variable" }, range: "height", padding: 0.2 },
        ],
        axes: [common.axis("bottom", "x", "Fraction of Σ (∂f/∂xᵢ · σᵢ)²"), { orient: "left", scale: "y", title: "Variable", grid: false }],
        marks: [
          { type: "rect", from: { data: "contributions" }, encode: { enter: { x: { scale: "x", value: 0 }, x2: { scale: "x", field: "fraction" }, y: { scale: "y", field: "variable" }, height: { scale: "y", band: 1 }, fill: { value: common.PALETTE.component[0] } } } },
        ],
      },
    ],
  });
  const result = {
    schema: "agentlas.physics.analysis-result/v1",
    analysisId: "uncertainty-propagation",
    method: {
      id: "gum-linear-plus-seeded-monte-carlo", version: "1.0.0",
      derivative: "forward-mode-dual-numbers",
      randomGenerator: "xoshiro128**-seeded-splitmix32-box-muller",
      references: [
        "JCGM 100:2008, Evaluation of measurement data — Guide to the expression of uncertainty in measurement, §5.1–5.2",
        "JCGM 101:2008, Supplement 1 — Propagation of distributions using a Monte Carlo method",
      ],
    },
    input: {
      formulaId: normalized.formulaId, expression: normalized.expressionText, canonicalExpression: expression.formatAst(ast),
      ...(normalized.formulaId ? { formulaDescription: FORMULAS[normalized.formulaId].description, unitsHint: FORMULAS[normalized.formulaId].units_hint } : {}),
      variables, correlation: normalized.correlation, options,
    },
    summary: {
      resultUnit: unit,
      linear: { value: dual.value, sigma: linearSigma, variance: linearVariance, uncorrelatedVariance, correlationVariance, relativeSigma: dual.value !== 0 ? linearSigma / Math.abs(dual.value) : null },
      monteCarlo: { ...mc, sampleCount: samples.length, droppedCount: nonFinite, seed: options.seed },
      comparison: { meanShiftInLinearSigma: Number.isFinite(shift) ? shift : null, spreadRatioMinusOne: Number.isFinite(spreadRatio) ? spreadRatio : null, nonlinear: shift > 0.1 || Math.abs(spreadRatio) > 0.1 },
      dominantVariable: contributions.length ? contributions.reduce((best, entry) => (entry.variance > best.variance ? entry : best)).variable : null,
    },
    gradient: Object.fromEntries(variables.map((entry, i) => [entry.name, gradient[i]])),
    contributions,
    publicationTable,
    tables: { budget: contributionTable, monteCarlo: quantileTable },
    figure: common.figureReceipt(spec),
    boundaries: [
      "Linear propagation is a first-order Taylor expansion (GUM); it is exact only for linear models and symmetric only by construction.",
      `Monte Carlo statistical error: ≈ σ/√N on the mean and ≈ σ/√(2N) on the standard deviation (N = ${samples.length}).`,
      "Correlations are imposed on the underlying Gaussian draws; for uniform inputs the transformed samples reproduce the requested correlation only approximately.",
      "Input distributions are limited to normal and uniform; the result distribution is characterised by its sample quantiles, not by a fitted form.",
      "Units are informational labels here and are not checked; use the unit-analysis tool for dimensional consistency.",
    ],
    warnings,
  };
  return common.finalizeAnalysis(result);
}

module.exports = { analyzeUncertaintyPropagation, FORMULAS };
