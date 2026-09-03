"use strict";

// Counting-experiment significance and limits.
//
// Model: n ~ Poisson(μ·s + b'), with the background nuisance b' constrained
// by a Gaussian auxiliary measurement of mean b and standard deviation σ_b
// (σ_b = 0 fixes b' = b). All statistics derive from the profile likelihood
// ratio exactly; the nuisance profile has a closed form (a quadratic in b').
//
// - q0 / Z0: Cowan, Cranmer, Gross, Vitells, EPJC 71, 1554 (2011) eqs. 12, 52.
// - Cross-check row: on/off closed form (Cowan 2011 eq. 25 with τ = b/σ_b²;
//   Cousins, Linnemann, Tucker NIM A 595, 480 (2008)).
// - CLs upper limit: q̃_μ (Cowan eq. 16) with the asymptotic distributions of
//   eqs. 61–62 and the Asimov σ_μ² = μ²/q̃_μ,A; CLs = p_μ / (1 − p_b) solved
//   for CLs = 1 − CL by bisection. Expected bands: μ_up^{±N} = σ(Φ⁻¹(1 − α Φ(±N)) ± N).
// - Feldman–Cousins: Phys. Rev. D 57, 3873 (1998), explicit likelihood-ratio
//   ordering on a bounded signal grid with known background (σ_b ignored).

const common = require("./analysis-common.cjs");

const { PhysicsError } = common;

function normalizeInput(input) {
  const value = common.exactObject(input, ["observed", "background", "background_uncertainty", "signal_expected", "confidence_level", "feldman_cousins", "label"], "physics-significance-input");
  const observed = common.integer(value.observed, 0, 1_000_000_000, "physics-significance-observed");
  const background = common.finite(value.background, Number.MIN_VALUE, 1e12, "physics-significance-background");
  const backgroundUncertainty = common.optionalFinite(value.background_uncertainty, 0, 1e12, "physics-significance-background-uncertainty", 0);
  const signalExpected = common.finite(value.signal_expected, Number.MIN_VALUE, 1e12, "physics-significance-signal-expected");
  const confidenceLevel = common.optionalFinite(value.confidence_level, 0.5, 0.999999, "physics-significance-confidence-level", 0.95);
  const fcInput = value.feldman_cousins === undefined ? {} : common.exactObject(value.feldman_cousins, ["enabled", "signal_max", "signal_step"], "physics-significance-feldman-cousins");
  const fcEnabled = common.boolean(fcInput.enabled, "physics-significance-feldman-cousins-enabled", true);
  const defaultSignalMax = Math.max(10, Math.ceil(observed + 5 * Math.sqrt(observed + background) + 10));
  const signalMax = common.optionalFinite(fcInput.signal_max, 1, 1e5, "physics-significance-feldman-cousins-signal-max", defaultSignalMax);
  const signalStep = common.optionalFinite(fcInput.signal_step, 1e-4, 10, "physics-significance-feldman-cousins-signal-step", Math.max(0.01, signalMax / 2000));
  if (signalMax / signalStep > 20_000) throw new PhysicsError("physics-significance-feldman-cousins-grid-too-fine", "signal_max / signal_step must not exceed 20000 grid points");
  return { observed, background, backgroundUncertainty, signalExpected, confidenceLevel, feldmanCousins: { enabled: fcEnabled, signalMax, signalStep }, label: common.optionalText(value.label, 160, "physics-significance-label") ?? "Counting experiment" };
}

// ln L up to constants; n ln λ − λ − (b'−b)²/(2σ²)
function logLikelihood(n, lambda, bPrime, b, sigma) {
  if (lambda < 0 || (lambda === 0 && n > 0)) return -Infinity;
  const poisson = (n > 0 ? n * Math.log(lambda) : 0) - lambda;
  const constraint = sigma > 0 ? -((bPrime - b) ** 2) / (2 * sigma * sigma) : 0;
  return poisson + constraint;
}

function profiledBackground(n, mu, s, b, sigma) {
  if (sigma === 0) return b;
  const lambdaSignal = mu * s;
  const s2 = sigma * sigma;
  const B = b - lambdaSignal - s2;
  const C = n * s2 - s2 * lambdaSignal + b * lambdaSignal;
  const root = (B + Math.sqrt(B * B + 4 * C)) / 2;
  return Math.max(0, root);
}

function profiledLogLikelihood(n, mu, s, b, sigma) {
  const bPrime = profiledBackground(n, mu, s, b, sigma);
  return { value: logLikelihood(n, mu * s + bPrime, bPrime, b, sigma), bPrime };
}

function globalMaximum(n, s, b) {
  const muHat = (n - b) / s;
  return { muHat, bHat: b, value: logLikelihood(n, n, b, b, 0) };
}

function discoveryStatistic(n, s, b, sigma) {
  const hat = globalMaximum(n, s, b);
  if (hat.muHat < 0) return { q0: 0, muHat: hat.muHat, profiledBackgroundAtZero: profiledBackground(n, 0, s, b, sigma) };
  const null0 = profiledLogLikelihood(n, 0, s, b, sigma);
  const q0 = Math.max(0, -2 * (null0.value - hat.value));
  return { q0, muHat: hat.muHat, profiledBackgroundAtZero: null0.bPrime };
}

function qTilde(n, mu, s, b, sigma) {
  const hat = globalMaximum(n, s, b);
  if (hat.muHat > mu) return 0;
  const numerator = profiledLogLikelihood(n, mu, s, b, sigma).value;
  const denominator = hat.muHat < 0 ? profiledLogLikelihood(n, 0, s, b, sigma).value : hat.value;
  return Math.max(0, -2 * (numerator - denominator));
}

function clsAt(n, mu, s, b, sigma) {
  const q = qTilde(n, mu, s, b, sigma);
  const qA = qTilde(b, mu, s, b, sigma);
  if (!(qA > 0)) return { cls: 1, pMu: 0.5, oneMinusPb: 0.5, q, qA, sigmaMu: null };
  const sigmaMu = mu / Math.sqrt(qA);
  const sqrtQ = Math.sqrt(q);
  const sqrtQA = Math.sqrt(qA);
  let pMu; let oneMinusPb;
  if (q <= qA) {
    pMu = common.normalSurvival(sqrtQ);
    oneMinusPb = common.normalCdf(sqrtQ - sqrtQA);
  } else {
    pMu = common.normalSurvival((q + qA) / (2 * sqrtQA));
    oneMinusPb = common.normalCdf((q - qA) / (2 * sqrtQA));
  }
  const cls = oneMinusPb > 0 ? pMu / oneMinusPb : (pMu > 0 ? Infinity : 1);
  return { cls, pMu, oneMinusPb, q, qA, sigmaMu };
}

function bisect(fn, low, high, iterations = 200, tolerance = 1e-12) {
  let fLow = fn(low);
  for (let index = 0; index < iterations; index += 1) {
    const middle = (low + high) / 2;
    const fMiddle = fn(middle);
    if (Math.abs(high - low) <= tolerance * Math.max(1, Math.abs(middle))) return middle;
    if ((fLow < 0) === (fMiddle < 0)) { low = middle; fLow = fMiddle; } else high = middle;
  }
  return (low + high) / 2;
}

function upperLimitCls(n, s, b, sigma, alpha) {
  const target = (mu) => clsAt(n, mu, s, b, sigma).cls - alpha;
  let high = 1;
  let guard = 0;
  while (target(high) > 0 && guard < 60) { high *= 2; guard += 1; }
  if (target(high) > 0) throw new PhysicsError("physics-significance-cls-no-root", "CLs did not fall below alpha within the search range");
  return bisect(target, 0, high);
}

function expectedBandCls(s, b, sigma, alpha, N) {
  const factor = common.normalQuantile(1 - alpha * common.normalCdf(N)) + N;
  const target = (mu) => {
    const qA = qTilde(b, mu, s, b, sigma);
    if (!(qA > 0)) return -1;
    return mu - (mu / Math.sqrt(qA)) * factor;
  };
  let high = 1;
  let guard = 0;
  while (target(high) < 0 && guard < 60) { high *= 2; guard += 1; }
  if (target(high) < 0) throw new PhysicsError("physics-significance-expected-band-no-root");
  return bisect(target, 0, high);
}

function logPoisson(n, lambda) {
  if (lambda === 0) return n === 0 ? 0 : -Infinity;
  return n * Math.log(lambda) - lambda - common.logGamma(n + 1);
}

function feldmanCousins(observed, b, confidenceLevel, signalMax, signalStep) {
  const nMax = Math.ceil(signalMax + b + 10 * Math.sqrt(signalMax + b) + 25);
  const gridCount = Math.floor(signalMax / signalStep + 1e-9) + 1;
  const belt = [];
  let low = null; let high = null;
  const probabilities = new Array(nMax + 1);
  const bestLog = new Array(nMax + 1);
  for (let n = 0; n <= nMax; n += 1) bestLog[n] = logPoisson(n, Math.max(0, n - b) + b);
  for (let gridIndex = 0; gridIndex < gridCount; gridIndex += 1) {
    const mu = gridIndex * signalStep;
    const order = [];
    for (let n = 0; n <= nMax; n += 1) {
      const logP = logPoisson(n, mu + b);
      probabilities[n] = Math.exp(logP);
      order.push({ n, ratio: logP - bestLog[n] });
    }
    order.sort((left, right) => right.ratio - left.ratio || left.n - right.n);
    let coverage = 0;
    const accepted = new Set();
    for (const entry of order) {
      accepted.add(entry.n);
      coverage += probabilities[entry.n];
      if (coverage >= confidenceLevel) break;
    }
    let nLow = Infinity; let nHigh = -Infinity;
    for (const n of accepted) { if (n < nLow) nLow = n; if (n > nHigh) nHigh = n; }
    belt.push({ mu, nLow, nHigh, coverage });
    if (accepted.has(observed)) {
      if (low === null) low = mu;
      high = mu;
    }
  }
  const lastBelt = belt[belt.length - 1];
  const truncated = high === null || high >= lastBelt.mu - signalStep / 2;
  return { belt, lower: low, upper: high, truncated, found: high !== null, nMax, gridCount };
}

function analyzeSignificanceLimits(input) {
  const normalized = normalizeInput(input);
  const { observed: n, background: b, backgroundUncertainty: sigma, signalExpected: s, confidenceLevel } = normalized;
  const alpha = 1 - confidenceLevel;
  const warnings = [];
  const discovery = discoveryStatistic(n, s, b, sigma);
  const z0 = Math.sqrt(discovery.q0);
  const p0 = common.normalSurvival(z0);
  // On/off closed form (Cowan 2011 eq. 25 with τ = b/σ²); only defined for σ > 0 and n > 0.
  let zOnOff = null;
  if (sigma > 0 && n > 0) {
    const s2 = sigma * sigma;
    const term1 = n * Math.log(n * (b + s2) / (b * b + n * s2));
    const term2 = (b * b / s2) * Math.log(1 + s2 * (n - b) / (b * (b + s2)));
    const q = 2 * (term1 - term2);
    zOnOff = n >= b && q > 0 ? Math.sqrt(q) : 0;
  } else if (sigma === 0 && n > 0) {
    zOnOff = n >= b ? Math.sqrt(Math.max(0, 2 * (n * Math.log(n / b) - (n - b)))) : 0;
  }
  const poissonP = n === 0 ? 1 : common.regularizedGammaP(n, b);
  // Z = −Φ⁻¹(p) avoids the 1 − p cancellation for tiny p; p that underflows to 0 has no finite Z.
  const poissonZ = poissonP >= 1 ? -Infinity : poissonP > 0 ? -common.normalQuantile(poissonP) : Infinity;
  if (poissonP <= 0) warnings.push("The exact Poisson p-value underflows double precision (p < 1e-308); its Z-score is reported as unavailable.");
  let marginalizedP = null;
  if (sigma > 0) {
    const lower = Math.max(0, b - 8 * sigma);
    const upper = b + 8 * sigma;
    const normalization = common.simpson((bp) => common.normalPdf((bp - b) / sigma) / sigma, lower, upper, 4000);
    marginalizedP = common.simpson((bp) => (n === 0 ? 1 : (bp > 0 ? common.regularizedGammaP(n, bp) : 0)) * common.normalPdf((bp - b) / sigma) / sigma, lower, upper, 4000) / normalization;
  }
  const observedLimit = upperLimitCls(n, s, b, sigma, alpha);
  const observedCls = clsAt(n, observedLimit, s, b, sigma);
  const expected = { minus2: expectedBandCls(s, b, sigma, alpha, -2), minus1: expectedBandCls(s, b, sigma, alpha, -1), median: expectedBandCls(s, b, sigma, alpha, 0), plus1: expectedBandCls(s, b, sigma, alpha, 1), plus2: expectedBandCls(s, b, sigma, alpha, 2) };
  const asimovMedian = upperLimitCls(b, s, b, sigma, alpha);
  const clsCurveMax = Math.max(observedLimit, expected.plus2) * 1.4;
  const clsCurve = common.linspace(0, clsCurveMax, 121).map((mu) => {
    const observedPoint = clsAt(n, mu, s, b, sigma);
    const expectedPoint = clsAt(b, mu, s, b, sigma);
    return { mu, observed: Math.min(1, observedPoint.cls), expected: Math.min(1, expectedPoint.cls) };
  });
  if (n < 5 || b < 5) warnings.push("Asymptotic (Wilks/Wald) formulae are approximate for small counts; a toy-MC calibration of q̃_μ and q0 is recommended before publication.");
  if (sigma > 0 && sigma > b / 2) warnings.push("Background uncertainty exceeds half the background; the Gaussian constraint allows negative b' and was clamped at zero in the profile.");
  let fc = null;
  if (normalized.feldmanCousins.enabled) {
    fc = feldmanCousins(n, b, confidenceLevel, normalized.feldmanCousins.signalMax, normalized.feldmanCousins.signalStep);
    if (!fc.found) warnings.push("Feldman–Cousins: no signal value in [0, signal_max] accepts n_obs; raise feldman_cousins.signal_max to obtain the interval.");
    else if (fc.truncated) warnings.push("Feldman–Cousins acceptance still contained n_obs at signal_max; raise feldman_cousins.signal_max to obtain the upper bound.");
    if (sigma > 0) warnings.push("Feldman–Cousins construction treats the background as exactly known; the declared background uncertainty is not propagated there.");
  }
  const statisticRows = [
    ["Observed events n", n, "count", "input"],
    ["Expected background b", b, "count", "input"],
    ["Background uncertainty σ_b", sigma, "count", "input (Gaussian constraint)"],
    ["Expected signal s (μ = 1)", s, "count", "input"],
    ["μ̂ = (n − b)/s", discovery.muHat, null, "unconstrained best-fit signal strength"],
    ["Profiled b' at μ = 0", discovery.profiledBackgroundAtZero, "count", "closed-form profile"],
    ["q0", discovery.q0, null, "Cowan et al. 2011 eq. 12 (0 when μ̂ < 0)"],
    ["Z0 = √q0", z0, "σ", "Cowan et al. 2011 eq. 52"],
    ["p0 = 1 − Φ(Z0)", p0, null, "one-sided"],
    ["Z (on/off closed form, τ = b/σ_b²)", zOnOff, "σ", "Cowan et al. 2011 eq. 25 / Cousins–Linnemann–Tucker 2008"],
    ["Poisson p-value P(N ≥ n | b)", poissonP, null, "exact, background fixed"],
    ["Poisson Z = Φ⁻¹(1 − p)", Number.isFinite(poissonZ) ? poissonZ : null, "σ", "exact, background fixed"],
    ["Marginalized p-value (Gaussian b prior, truncated at 0)", marginalizedP, null, "Simpson integration over b'"],
    [`CLs ${(confidenceLevel * 100).toFixed(1)}% upper limit on μ (observed)`, observedLimit, null, "asymptotic q̃_μ"],
    ["Observed limit in signal events (μ_up · s)", observedLimit * s, "count", "asymptotic q̃_μ"],
    ["σ_μ at observed limit (Asimov)", observedCls.sigmaMu, null, "μ/√q̃_μ,A"],
    ["Expected limit −2σ", expected.minus2, null, "σ(Φ⁻¹(1 − αΦ(−2)) − 2)"],
    ["Expected limit −1σ", expected.minus1, null, "σ(Φ⁻¹(1 − αΦ(−1)) − 1)"],
    ["Expected limit (median)", expected.median, null, "σ·Φ⁻¹(1 − α/2)"],
    ["Expected limit +1σ", expected.plus1, null, "σ(Φ⁻¹(1 − αΦ(1)) + 1)"],
    ["Expected limit +2σ", expected.plus2, null, "σ(Φ⁻¹(1 − αΦ(2)) + 2)"],
    ["Expected limit (median, Asimov n = b solved directly)", asimovMedian, null, "consistency check of the band formula"],
    ...(fc ? [
      [`Feldman–Cousins ${(confidenceLevel * 100).toFixed(1)}% interval on signal events: lower`, fc.lower, "count", "explicit construction, background known"],
      ["Feldman–Cousins interval: upper", fc.upper, "count", "explicit construction, background known"],
      ["Feldman–Cousins interval on μ: lower", fc.lower === null ? null : fc.lower / s, null, "signal events / s"],
      ["Feldman–Cousins interval on μ: upper", fc.upper === null ? null : fc.upper / s, null, "signal events / s"],
    ] : []),
  ];
  const publicationTable = common.scienceTable(`Significance and limits · ${normalized.label}`, [
    { id: "statistic", label: "Statistic", type: "string" }, { id: "value", label: "Value" }, { id: "unit", label: "Unit", type: "string" }, { id: "method", label: "Method", type: "string" },
  ], statisticRows);
  const beltRows = fc ? fc.belt.filter((_, index) => index % Math.max(1, Math.ceil(fc.belt.length / 400)) === 0 || index === fc.belt.length - 1).map((row) => [row.mu, row.nLow, row.nHigh, row.coverage]) : [];
  const beltTable = common.scienceTable("Feldman–Cousins acceptance belt (downsampled)", [
    { id: "signal", label: "Signal events" }, { id: "nLow", label: "n low" }, { id: "nHigh", label: "n high" }, { id: "coverage", label: "Coverage" },
  ], beltRows);
  const width = 680;
  const panels = [{
    name: "clsPanel", height: 260,
    scales: [common.linearScale("x", "clsCurve", "mu", "width", { zero: true }), { name: "y", type: "linear", domain: [0, 1], range: "height", nice: false, zero: true }],
    axes: [common.axis("bottom", "x", "Signal strength μ"), common.axis("left", "y", "CLs")],
    marks: [
      { type: "rect", from: { data: "band2" }, encode: { enter: { x: { scale: "x", field: "low" }, x2: { scale: "x", field: "high" }, y: { scale: "y", value: 0 }, y2: { scale: "y", value: 1 }, fill: { value: "#F2E6A7" }, opacity: { value: 0.6 } } } },
      { type: "rect", from: { data: "band1" }, encode: { enter: { x: { scale: "x", field: "low" }, x2: { scale: "x", field: "high" }, y: { scale: "y", value: 0 }, y2: { scale: "y", value: 1 }, fill: { value: "#A7D8A0" }, opacity: { value: 0.6 } } } },
      common.horizontalRule("clsCurve", alpha, common.PALETTE.neutral, { width, dash: [4, 3] }),
      common.lineMark("clsCurve", "mu", "expected", common.PALETTE.neutral, { dash: [6, 3] }),
      common.lineMark("clsCurve", "mu", "observed", common.PALETTE.fit),
      { type: "rule", from: { data: "limitMarker" }, encode: { enter: { x: { scale: "x", field: "mu" }, y: { scale: "y", value: 0 }, y2: { scale: "y", value: 1 }, stroke: { value: common.PALETTE.data }, strokeWidth: { value: 1.5 } } } },
    ],
  }];
  if (fc) {
    panels.push({
      name: "beltPanel", height: 260,
      scales: [
        { name: "x", type: "linear", domain: { fields: [{ data: "belt", field: "nLow" }, { data: "belt", field: "nHigh" }, { data: "observedMarker", field: "n" }] }, range: "width", nice: true, zero: true },
        common.linearScale("y", "belt", "mu", "height", { zero: true }),
      ],
      axes: [common.axis("bottom", "x", "Measured n"), common.axis("left", "y", "Signal events (true)")],
      marks: [
        { type: "rule", from: { data: "belt" }, encode: { enter: { x: { scale: "x", field: "nLow" }, x2: { scale: "x", field: "nHigh" }, y: { scale: "y", field: "mu" }, stroke: { value: common.PALETTE.band }, strokeWidth: { value: 1.5 } } } },
        { type: "rule", from: { data: "observedMarker" }, encode: { enter: { x: { scale: "x", field: "n" }, y: { scale: "y", value: 0 }, y2: { scale: "y", field: "muMax" }, stroke: { value: common.PALETTE.fit }, strokeWidth: { value: 1.5 } } } },
        { type: "rule", from: { data: "intervalMarker" }, encode: { enter: { x: { scale: "x", value: 0 }, x2: { scale: "x", field: "n" }, y: { scale: "y", field: "mu" }, stroke: { value: common.PALETTE.data }, strokeWidth: { value: 1.2 }, strokeDash: { value: [3, 3] } } } },
      ],
    });
  }
  const spec = common.stackedVegaFigure({
    description: `CLs versus signal strength for ${normalized.label}: observed (solid), expected (dashed) with ±1σ/±2σ bands, α = ${alpha.toPrecision(3)} line, observed limit marker${fc ? "; lower panel: Feldman–Cousins acceptance belt with n_obs and interval markers" : ""}.`,
    width,
    data: [
      { name: "clsCurve", values: clsCurve },
      { name: "band1", values: [{ low: expected.minus1, high: expected.plus1 }] },
      { name: "band2", values: [{ low: expected.minus2, high: expected.plus2 }] },
      { name: "limitMarker", values: [{ mu: observedLimit }] },
      ...(fc ? [
        { name: "belt", values: fc.belt.filter((_, index) => index % Math.max(1, Math.ceil(fc.belt.length / 400)) === 0).map((row) => ({ mu: row.mu, nLow: row.nLow, nHigh: row.nHigh })) },
        { name: "observedMarker", values: [{ n, muMax: fc.belt[fc.belt.length - 1].mu }] },
        { name: "intervalMarker", values: [{ n, mu: fc.lower ?? 0 }, { n, mu: fc.upper ?? 0 }] },
      ] : []),
    ],
    panels,
  });
  const result = {
    schema: "agentlas.physics.analysis-result/v1",
    analysisId: "significance-limits",
    method: {
      id: "profile-likelihood-counting-experiment", version: "1.0.0",
      references: [
        "G. Cowan, K. Cranmer, E. Gross, O. Vitells, Asymptotic formulae for likelihood-based tests of new physics, Eur. Phys. J. C 71, 1554 (2011); erratum C 73, 2501 (2013)",
        "R. D. Cousins, J. T. Linnemann, J. Tucker, NIM A 595, 480 (2008)",
        "A. L. Read, Presentation of search results: the CLs technique, J. Phys. G 28, 2693 (2002)",
        "G. J. Feldman, R. D. Cousins, Phys. Rev. D 57, 3873 (1998)",
      ],
    },
    input: { label: normalized.label, observed: n, background: b, backgroundUncertainty: sigma, signalExpected: s, confidenceLevel, feldmanCousins: normalized.feldmanCousins },
    summary: {
      muHat: discovery.muHat, q0: discovery.q0, z0, p0, zOnOff, poissonP, poissonZ: Number.isFinite(poissonZ) ? poissonZ : null, marginalizedP,
      clsUpperLimit: { observed: observedLimit, observedSignalEvents: observedLimit * s, expected, asimovMedian, clsAtLimit: observedCls.cls, alpha },
      feldmanCousins: fc ? { lowerSignalEvents: fc.lower, upperSignalEvents: fc.upper, lowerMu: fc.lower === null ? null : fc.lower / s, upperMu: fc.upper === null ? null : fc.upper / s, truncated: fc.truncated, gridCount: fc.gridCount, nMax: fc.nMax } : null,
    },
    clsCurve,
    publicationTable,
    tables: { feldmanCousinsBelt: beltTable },
    figure: common.figureReceipt(spec),
    boundaries: [
      "Single-bin counting model with one Gaussian-constrained background nuisance; no signal-shape, multi-bin, or correlated-systematic modelling.",
      "Z0 and CLs use asymptotic (Wilks/Wald) distributions; they are approximate for small expected counts.",
      "The CLs expected bands use the Asimov σ_μ; the median band is cross-checked by solving the Asimov dataset directly.",
      "Feldman–Cousins intervals are computed on a bounded discrete signal grid with the background treated as exactly known; interval edges are grid values.",
      "The Feldman–Cousins construction is the plain likelihood-ratio ordering: rows n_obs = 1..10 of Feldman & Cousins (1998) Table IV (b = 3, 90 %) are reproduced to the grid step, but the published n_obs = 0 upper limit (1.08) is not (this construction gives 0.95); treat n_obs = 0 limits as construction-specific.",
    ],
    warnings,
  };
  return common.finalizeAnalysis(result);
}

module.exports = { analyzeSignificanceLimits, qTilde, discoveryStatistic, clsAt, profiledBackground, feldmanCousins };
