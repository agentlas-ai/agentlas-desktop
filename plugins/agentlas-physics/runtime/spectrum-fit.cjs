"use strict";

// Multi-peak spectrum fitting with Levenberg–Marquardt.
//
// Signal shapes: Gaussian, Lorentzian, pseudo-Voigt (Thompson–Cox–Hastings
// style linear mixture with a shared FWHM), Voigt (Faddeeva function,
// Weideman 1994 rational approximation, N=64), Crystal Ball (Oreglia 1980 /
// Gaisser 1982 parameterization), relativistic Breit–Wigner (PDG normalization).
// Backgrounds: none, polynomial in x, exponential a·exp(b·x).
//
// The LM damping strategy follows Madsen, Nielsen & Tingleff, "Methods for
// Non-Linear Least Squares Problems" (2004), section 3.2 (Nielsen's update of
// the damping parameter). Parameter covariance is (JᵀWJ)⁻¹ evaluated at the
// converged parameters with W = diag(1/σᵢ²), i.e. the absolute-σ convention
// used by ROOT/Minuit for chi-square fits; the reduced-chi-square scaled
// errors are reported alongside because curve_fit(absolute_sigma=False)
// and many lab reports quote those instead.

const common = require("./analysis-common.cjs");

const { PhysicsError } = common;
const MAX_PEAKS = 16;
const MAX_PARAMETERS = 64;
const SQRT_2PI = Math.sqrt(2 * Math.PI);
const FWHM_GAUSS = 2 * Math.sqrt(2 * Math.log(2));

// ---------------------------------------------------------------------------
// Faddeeva function w(z) = exp(-z²) erfc(-iz) for Im(z) >= 0 (Weideman 1994).
// ---------------------------------------------------------------------------

const WEIDEMAN_N = 64;
const WEIDEMAN = (() => {
  const N = WEIDEMAN_N;
  const M = 2 * N;
  const M2 = 2 * M;
  const L = Math.sqrt(N / Math.SQRT2);
  const f = new Array(M2).fill(0);
  for (let index = 1; index < M2; index += 1) {
    const k = index - M;
    const theta = k * Math.PI / M;
    const t = L * Math.tan(theta / 2);
    f[index] = Math.exp(-t * t) * (L * L + t * t);
  }
  // fftshift for even length: shifted[j] = f[(j + M2/2) mod M2]
  const shifted = f.map((_, j) => f[(j + M2 / 2) % M2]);
  const a = new Array(N + 1).fill(0);
  for (let n = 0; n <= N; n += 1) {
    let real = 0;
    for (let j = 0; j < M2; j += 1) real += shifted[j] * Math.cos(2 * Math.PI * j * n / M2);
    a[n] = real / M2;
  }
  // polynomial coefficients in ascending power order: p(Z) = Σ_{n=1..N} a[n] Z^{n-1}
  const ascending = a.slice(1, N + 1);
  return { L, ascending };
})();

function faddeeva(re, im) {
  if (!(im >= 0)) throw new PhysicsError("physics-faddeeva-domain", "Faddeeva evaluation requires Im(z) >= 0");
  const { L, ascending } = WEIDEMAN;
  // Z = (L + i z)/(L - i z); with z = re + i im: i z = -im + i re
  const numeratorRe = L - im; const numeratorIm = re;
  const denominatorRe = L + im; const denominatorIm = -re;
  const denominatorAbs2 = denominatorRe * denominatorRe + denominatorIm * denominatorIm;
  const zRe = (numeratorRe * denominatorRe + numeratorIm * denominatorIm) / denominatorAbs2;
  const zIm = (numeratorIm * denominatorRe - numeratorRe * denominatorIm) / denominatorAbs2;
  // Horner in ascending order evaluated from the top: p = a[N-1]; p = p*Z + a[n]
  let pRe = 0; let pIm = 0;
  for (let n = ascending.length - 1; n >= 0; n -= 1) {
    const nextRe = pRe * zRe - pIm * zIm + ascending[n];
    const nextIm = pRe * zIm + pIm * zRe;
    pRe = nextRe; pIm = nextIm;
  }
  // w = 2 p / (L - i z)^2 + (1/sqrt(pi)) / (L - i z)
  const dRe = denominatorRe; const dIm = denominatorIm;
  const d2Re = dRe * dRe - dIm * dIm; const d2Im = 2 * dRe * dIm;
  const d2Abs2 = d2Re * d2Re + d2Im * d2Im;
  const term1Re = 2 * (pRe * d2Re + pIm * d2Im) / d2Abs2;
  const term1Im = 2 * (pIm * d2Re - pRe * d2Im) / d2Abs2;
  const invSqrtPi = 1 / Math.sqrt(Math.PI);
  const term2Re = invSqrtPi * dRe / denominatorAbs2;
  const term2Im = -invSqrtPi * dIm / denominatorAbs2;
  return { re: term1Re + term2Re, im: term1Im + term2Im };
}

// Voigt profile normalized to unit area.
function voigtDensity(x, center, sigma, gamma) {
  const zRe = (x - center) / (sigma * Math.SQRT2);
  const zIm = gamma / (sigma * Math.SQRT2);
  return faddeeva(zRe, zIm).re / (sigma * SQRT_2PI);
}

// ---------------------------------------------------------------------------
// Shape catalogue
// ---------------------------------------------------------------------------

const SHAPES = {
  gaussian: {
    parameters: ["amplitude", "center", "sigma"],
    positive: ["sigma"],
    describe: "A·exp(−(x−μ)²/(2σ²)); amplitude is the peak height.",
    evaluate: ([A, mu, sigma], x) => A * Math.exp(-((x - mu) ** 2) / (2 * sigma * sigma)),
    gradient: ([A, mu, sigma], x) => {
      const d = x - mu;
      const e = Math.exp(-(d * d) / (2 * sigma * sigma));
      return [e, A * e * d / (sigma * sigma), A * e * d * d / (sigma ** 3)];
    },
    derived: ([A, , sigma]) => ({ fwhm: FWHM_GAUSS * Math.abs(sigma), area: A * Math.abs(sigma) * SQRT_2PI, height: A }),
  },
  lorentzian: {
    parameters: ["amplitude", "center", "gamma"],
    positive: ["gamma"],
    describe: "A·γ²/((x−x₀)²+γ²); γ is the half width at half maximum and amplitude is the peak height.",
    evaluate: ([A, x0, gamma], x) => A * gamma * gamma / ((x - x0) ** 2 + gamma * gamma),
    gradient: ([A, x0, gamma], x) => {
      const d = x - x0;
      const den = d * d + gamma * gamma;
      const l = gamma * gamma / den;
      return [l, A * 2 * gamma * gamma * d / (den * den), A * 2 * gamma * d * d / (den * den)];
    },
    derived: ([A, , gamma]) => ({ fwhm: 2 * Math.abs(gamma), area: A * Math.PI * Math.abs(gamma), height: A }),
  },
  pseudo_voigt: {
    parameters: ["amplitude", "center", "fwhm", "eta"],
    positive: ["fwhm"],
    describe: "A·[η·L(x; x₀, Γ) + (1−η)·G(x; x₀, Γ)] with unit-height Lorentzian and Gaussian sharing FWHM Γ; η ∈ [0, 1].",
    evaluate: ([A, x0, fwhm, eta], x) => {
      const d = x - x0;
      const gamma = fwhm / 2;
      const sigma = fwhm / FWHM_GAUSS;
      const l = gamma * gamma / (d * d + gamma * gamma);
      const g = Math.exp(-(d * d) / (2 * sigma * sigma));
      return A * (eta * l + (1 - eta) * g);
    },
    gradient: null,
    derived: ([A, , fwhm, eta]) => ({
      fwhm: Math.abs(fwhm),
      area: A * Math.abs(fwhm) * (eta * Math.PI / 2 + (1 - eta) * Math.sqrt(Math.PI / (4 * Math.log(2)))),
      height: A,
    }),
  },
  voigt: {
    parameters: ["area", "center", "sigma", "gamma"],
    positive: ["sigma", "gamma"],
    describe: "Area-normalized Voigt profile: N·Re[w(z)]/(σ√(2π)), z = ((x−x₀)+iγ)/(σ√2), Faddeeva w via Weideman (1994) N=64.",
    evaluate: ([N, x0, sigma, gamma], x) => N * voigtDensity(x, x0, sigma, gamma),
    gradient: null,
    derived: ([N, x0, sigma, gamma]) => {
      const fG = FWHM_GAUSS * Math.abs(sigma);
      const fL = 2 * Math.abs(gamma);
      // Olivero & Longbothum (1977) approximation, accuracy ~0.02 %.
      const fwhm = 0.5346 * fL + Math.sqrt(0.2166 * fL * fL + fG * fG);
      return { fwhm, area: N, height: N * voigtDensity(x0, x0, Math.abs(sigma), Math.abs(gamma)) };
    },
  },
  crystal_ball: {
    parameters: ["amplitude", "center", "sigma", "alpha", "n"],
    positive: ["sigma", "alpha"],
    describe: "Gaussian core with a power-law tail on the low side: t=(x−x₀)/σ; N·exp(−t²/2) for t>−α, N·A·(B−t)^(−n) otherwise (A=(n/α)ⁿ·exp(−α²/2), B=n/α−α). n must exceed 1.",
    evaluate: ([N, x0, sigma, alpha, n], x) => {
      const t = (x - x0) / sigma;
      if (t > -alpha) return N * Math.exp(-t * t / 2);
      const a = Math.pow(n / alpha, n) * Math.exp(-alpha * alpha / 2);
      const b = n / alpha - alpha;
      return N * a * Math.pow(b - t, -n);
    },
    gradient: null,
    derived: ([N, , sigma]) => ({ fwhm: FWHM_GAUSS * Math.abs(sigma), area: null, height: N }),
  },
  relativistic_breit_wigner: {
    parameters: ["area", "mass", "width"],
    positive: ["mass", "width"],
    describe: "PDG relativistic Breit–Wigner: N·k/((E²−M²)²+M²Γ²), k=2√2·M·Γ·γ/(π·√(M²+γ)), γ=√(M²(M²+Γ²)); N is the area.",
    evaluate: ([N, M, G], E) => {
      const gamma = Math.sqrt(M * M * (M * M + G * G));
      const k = 2 * Math.SQRT2 * M * G * gamma / (Math.PI * Math.sqrt(M * M + gamma));
      return N * k / ((E * E - M * M) ** 2 + M * M * G * G);
    },
    gradient: null,
    derived: ([N, M, G]) => {
      const gamma = Math.sqrt(M * M * (M * M + G * G));
      const k = 2 * Math.SQRT2 * M * G * gamma / (Math.PI * Math.sqrt(M * M + gamma));
      return { fwhm: G, area: N, height: N * k / (M * M * G * G) };
    },
  },
};

const BACKGROUNDS = {
  none: { parameterCount: () => 0, parameters: () => [], evaluate: () => 0, gradient: () => [] },
  polynomial: {
    parameterCount: (degree) => degree + 1,
    parameters: (degree) => Array.from({ length: degree + 1 }, (_, k) => `c${k}`),
    evaluate: (params, x) => params.reduce((sum, coefficient, k) => sum + coefficient * Math.pow(x, k), 0),
    gradient: (params, x) => params.map((_, k) => Math.pow(x, k)),
  },
  exponential: {
    parameterCount: () => 2,
    parameters: () => ["a", "b"],
    evaluate: ([a, b], x) => a * Math.exp(b * x),
    gradient: ([a, b], x) => { const e = Math.exp(b * x); return [e, a * x * e]; },
  },
};

// ---------------------------------------------------------------------------
// Input normalization
// ---------------------------------------------------------------------------

function normalizeInput(input) {
  const value = common.exactObject(input, ["table", "x_column", "y_column", "sigma_column", "uncertainty_model", "range", "peaks", "background", "options"], "physics-spectrum-fit-input");
  const table = common.verifiedScienceTable(value.table);
  const x = common.numericColumn(table, value.x_column, "physics-spectrum-fit-x-column");
  const y = common.numericColumn(table, value.y_column, "physics-spectrum-fit-y-column");
  const uncertaintyModel = value.uncertainty_model === undefined ? (value.sigma_column === undefined ? "poisson" : "column") : common.enumText(value.uncertainty_model, ["column", "poisson", "unit"], "physics-spectrum-fit-uncertainty-model");
  let sigma = null;
  if (uncertaintyModel === "column") {
    if (value.sigma_column === undefined) throw new PhysicsError("physics-spectrum-fit-sigma-column-required", "uncertainty_model \"column\" requires sigma_column");
    sigma = common.numericColumn(table, value.sigma_column, "physics-spectrum-fit-sigma-column");
  } else if (value.sigma_column !== undefined) throw new PhysicsError("physics-spectrum-fit-sigma-column-conflict", "sigma_column is only valid with uncertainty_model \"column\"");
  const range = value.range === undefined ? null : (() => {
    const item = common.exactObject(value.range, ["min", "max"], "physics-spectrum-fit-range");
    const min = common.finite(item.min, -Number.MAX_VALUE, Number.MAX_VALUE, "physics-spectrum-fit-range-min");
    const max = common.finite(item.max, -Number.MAX_VALUE, Number.MAX_VALUE, "physics-spectrum-fit-range-max");
    if (!(max > min)) throw new PhysicsError("physics-spectrum-fit-range-invalid");
    return { min, max };
  })();
  if (!Array.isArray(value.peaks) || value.peaks.length < 1 || value.peaks.length > MAX_PEAKS) throw new PhysicsError("physics-spectrum-fit-peaks-invalid", `peaks must contain 1..${MAX_PEAKS} entries`);
  const peaks = value.peaks.map((peak, index) => {
    const item = common.exactObject(peak, ["label", "shape", "initial", "fixed", "bounds"], `physics-spectrum-fit-peak-${index}`);
    const shape = common.enumText(item.shape, Object.keys(SHAPES), `physics-spectrum-fit-peak-${index}-shape`);
    const definition = SHAPES[shape];
    const initialRecord = common.exactObject(item.initial, definition.parameters, `physics-spectrum-fit-peak-${index}-initial`);
    const initial = definition.parameters.map((name) => {
      const parameter = common.finite(initialRecord[name], -Number.MAX_VALUE, Number.MAX_VALUE, `physics-spectrum-fit-peak-${index}-initial-${name}`);
      if (definition.positive.includes(name) && !(parameter > 0)) throw new PhysicsError(`physics-spectrum-fit-peak-${index}-initial-${name}-invalid`, `${name} must be positive`);
      return parameter;
    });
    if (shape === "pseudo_voigt" && !(initial[3] >= 0 && initial[3] <= 1)) throw new PhysicsError(`physics-spectrum-fit-peak-${index}-initial-eta-invalid`, "eta must lie in [0, 1]");
    if (shape === "crystal_ball" && !(initial[4] > 1)) throw new PhysicsError(`physics-spectrum-fit-peak-${index}-initial-n-invalid`, "n must exceed 1");
    const fixed = item.fixed === undefined ? [] : (() => {
      if (!Array.isArray(item.fixed)) throw new PhysicsError(`physics-spectrum-fit-peak-${index}-fixed-invalid`);
      return item.fixed.map((name) => common.enumText(name, definition.parameters, `physics-spectrum-fit-peak-${index}-fixed`));
    })();
    const bounds = item.bounds === undefined ? {} : (() => {
      const record = common.exactObject(item.bounds, definition.parameters, `physics-spectrum-fit-peak-${index}-bounds`);
      const out = {};
      for (const name of Object.keys(record)) {
        const pair = common.finiteArray(record[name], 2, 2, `physics-spectrum-fit-peak-${index}-bounds-${name}`);
        if (!(pair[1] > pair[0])) throw new PhysicsError(`physics-spectrum-fit-peak-${index}-bounds-${name}-invalid`);
        const initialValue = initial[definition.parameters.indexOf(name)];
        if (initialValue < pair[0] || initialValue > pair[1]) throw new PhysicsError(`physics-spectrum-fit-peak-${index}-initial-${name}-outside-bounds`);
        out[name] = pair;
      }
      return out;
    })();
    return { label: common.optionalText(item.label, 80, `physics-spectrum-fit-peak-${index}-label`) ?? `${shape} ${index + 1}`, shape, initial, fixed, bounds };
  });
  const backgroundInput = value.background === undefined ? { kind: "none" } : common.exactObject(value.background, ["kind", "degree", "initial", "fixed"], "physics-spectrum-fit-background");
  const backgroundKind = common.enumText(backgroundInput.kind, Object.keys(BACKGROUNDS), "physics-spectrum-fit-background-kind");
  const degree = backgroundKind === "polynomial" ? common.optionalInteger(backgroundInput.degree, 0, 6, "physics-spectrum-fit-background-degree", 1) : null;
  if (backgroundKind !== "polynomial" && backgroundInput.degree !== undefined) throw new PhysicsError("physics-spectrum-fit-background-degree-invalid", "degree applies only to polynomial backgrounds");
  const backgroundParameterNames = BACKGROUNDS[backgroundKind].parameters(degree);
  const backgroundInitial = backgroundKind === "none" ? [] : common.finiteArray(backgroundInput.initial, backgroundParameterNames.length, backgroundParameterNames.length, "physics-spectrum-fit-background-initial");
  if (backgroundKind === "none" && backgroundInput.initial !== undefined) throw new PhysicsError("physics-spectrum-fit-background-initial-invalid");
  const backgroundFixed = backgroundInput.fixed === undefined ? [] : (() => {
    if (!Array.isArray(backgroundInput.fixed)) throw new PhysicsError("physics-spectrum-fit-background-fixed-invalid");
    return backgroundInput.fixed.map((name) => common.enumText(name, backgroundParameterNames, "physics-spectrum-fit-background-fixed"));
  })();
  const optionsInput = value.options === undefined ? {} : common.exactObject(value.options, ["max_iterations", "tolerance", "jacobian", "curve_points"], "physics-spectrum-fit-options");
  const options = {
    maxIterations: common.optionalInteger(optionsInput.max_iterations, 1, 5_000, "physics-spectrum-fit-max-iterations", 400),
    tolerance: common.optionalFinite(optionsInput.tolerance, 1e-15, 1e-2, "physics-spectrum-fit-tolerance", 1e-10),
    jacobian: optionsInput.jacobian === undefined ? "analytic" : common.enumText(optionsInput.jacobian, ["analytic", "numeric"], "physics-spectrum-fit-jacobian"),
    curvePoints: common.optionalInteger(optionsInput.curve_points, 50, 2_000, "physics-spectrum-fit-curve-points", 400),
  };
  return { table, x, y, sigma, uncertaintyModel, range, peaks, background: { kind: backgroundKind, degree, parameterNames: backgroundParameterNames, initial: backgroundInitial, fixed: backgroundFixed }, options };
}

// ---------------------------------------------------------------------------
// Model assembly
// ---------------------------------------------------------------------------

function buildModel(normalized) {
  const slots = [];
  normalized.peaks.forEach((peak, peakIndex) => {
    const definition = SHAPES[peak.shape];
    definition.parameters.forEach((name, parameterIndex) => {
      slots.push({
        id: `peak${peakIndex + 1}.${name}`, component: peakIndex, componentLabel: peak.label, name, shape: peak.shape,
        initial: peak.initial[parameterIndex], fixed: peak.fixed.includes(name),
        lower: peak.bounds[name]?.[0] ?? (definition.positive.includes(name) ? Number.MIN_VALUE : (peak.shape === "pseudo_voigt" && name === "eta" ? 0 : -Infinity)),
        upper: peak.bounds[name]?.[1] ?? (peak.shape === "pseudo_voigt" && name === "eta" ? 1 : Infinity),
      });
    });
    if (peak.shape === "crystal_ball") {
      const slot = slots.find((entry) => entry.component === peakIndex && entry.name === "n");
      slot.lower = Math.max(slot.lower, 1 + 1e-9);
    }
  });
  normalized.background.parameterNames.forEach((name, index) => {
    slots.push({ id: `background.${name}`, component: -1, componentLabel: "background", name, shape: normalized.background.kind, initial: normalized.background.initial[index], fixed: normalized.background.fixed.includes(name), lower: -Infinity, upper: Infinity });
  });
  if (slots.length > MAX_PARAMETERS) throw new PhysicsError("physics-spectrum-fit-too-many-parameters");
  const peakOffsets = [];
  let cursor = 0;
  normalized.peaks.forEach((peak) => { peakOffsets.push(cursor); cursor += SHAPES[peak.shape].parameters.length; });
  const backgroundOffset = cursor;
  const evaluateComponent = (full, componentIndex, x) => {
    if (componentIndex === -1) return BACKGROUNDS[normalized.background.kind].evaluate(full.slice(backgroundOffset), x);
    const peak = normalized.peaks[componentIndex];
    const count = SHAPES[peak.shape].parameters.length;
    return SHAPES[peak.shape].evaluate(full.slice(peakOffsets[componentIndex], peakOffsets[componentIndex] + count), x);
  };
  const evaluate = (full, x) => {
    let total = evaluateComponent(full, -1, x);
    for (let index = 0; index < normalized.peaks.length; index += 1) total += evaluateComponent(full, index, x);
    return total;
  };
  const analyticGradient = normalized.options.jacobian === "analytic" && normalized.peaks.every((peak) => SHAPES[peak.shape].gradient !== null);
  const gradient = (full, x) => {
    if (!analyticGradient) return null;
    const out = new Array(full.length).fill(0);
    normalized.peaks.forEach((peak, index) => {
      const count = SHAPES[peak.shape].parameters.length;
      const local = SHAPES[peak.shape].gradient(full.slice(peakOffsets[index], peakOffsets[index] + count), x);
      for (let k = 0; k < count; k += 1) out[peakOffsets[index] + k] = local[k];
    });
    const backgroundLocal = BACKGROUNDS[normalized.background.kind].gradient(full.slice(backgroundOffset), x);
    backgroundLocal.forEach((value, k) => { out[backgroundOffset + k] = value; });
    return out;
  };
  return { slots, evaluate, evaluateComponent, gradient, jacobianMode: analyticGradient ? "analytic" : "numeric-central-difference", peakOffsets, backgroundOffset };
}

// ---------------------------------------------------------------------------
// Levenberg–Marquardt
// ---------------------------------------------------------------------------

function levenbergMarquardt(model, x, y, sigma, options) {
  const free = model.slots.map((slot, index) => (slot.fixed ? -1 : index)).filter((index) => index >= 0);
  const full = model.slots.map((slot) => slot.initial);
  const weights = sigma.map((value) => 1 / (value * value));
  const n = x.length;
  const m = free.length;
  if (m === 0) throw new PhysicsError("physics-spectrum-fit-no-free-parameters");
  if (n <= m) throw new PhysicsError("physics-spectrum-fit-underdetermined", `${n} points cannot constrain ${m} free parameters`);
  const clamp = (vector) => vector.map((value, k) => Math.min(model.slots[free[k]].upper, Math.max(model.slots[free[k]].lower, value)));
  const assemble = (p) => { const out = [...full]; free.forEach((index, k) => { out[index] = p[k]; }); return out; };
  const residuals = (p) => { const assembled = assemble(p); return x.map((xi, i) => (y[i] - model.evaluate(assembled, xi)) * Math.sqrt(weights[i])); };
  const jacobian = (p) => {
    const assembled = assemble(p);
    const rows = [];
    for (let i = 0; i < n; i += 1) {
      const analytic = model.gradient(assembled, x[i]);
      const row = new Array(m).fill(0);
      if (analytic) {
        free.forEach((index, k) => { row[k] = -analytic[index] * Math.sqrt(weights[i]); });
      } else {
        free.forEach((index, k) => {
          const step = 1e-6 * Math.max(1, Math.abs(assembled[index]));
          const plus = [...assembled]; plus[index] += step;
          const minus = [...assembled]; minus[index] -= step;
          row[k] = -((model.evaluate(plus, x[i]) - model.evaluate(minus, x[i])) / (2 * step)) * Math.sqrt(weights[i]);
        });
      }
      rows.push(row);
    }
    return rows;
  };
  let p = clamp(free.map((index) => full[index]));
  let r = residuals(p);
  if (r.some((value) => !Number.isFinite(value))) throw new PhysicsError("physics-spectrum-fit-model-non-finite", "the model is not finite at the initial parameters");
  let chi2 = common.dot(r, r);
  let J = jacobian(p);
  let A = common.multiply(common.transpose(J), J);
  let g = common.matVec(common.transpose(J), r);
  let mu = 1e-3 * Math.max(...A.map((row, k) => row[k]));
  if (!(mu > 0)) mu = 1e-3;
  let nu = 2;
  let iterations = 0;
  let converged = false;
  let reason = "max-iterations";
  const history = [];
  let boundHits = 0;
  // Marquardt scaling: the damping term is μ·diag(JᵀJ); the gain ratio uses
  // the matching model reduction ½hᵀ(μDh − g) (Madsen et al. 2004, eq. 3.14
  // with D = diag(A)). Convergence is only declared on an accepted step whose
  // length is below tolerance, or when the gradient vanishes; rejected steps
  // only raise μ so a run of rejections cannot masquerade as convergence.
  let rejectedRun = 0;
  while (iterations < options.maxIterations) {
    iterations += 1;
    const diagonal = A.map((row, k) => Math.max(row[k], 1e-300));
    const damped = A.map((row, k) => row.map((value, j) => (k === j ? value + mu * diagonal[k] : value)));
    let h;
    try { h = common.solveLinear(damped, g.map((value) => -value), "physics-spectrum-fit-normal-equations"); }
    catch { mu *= nu; nu *= 2; continue; }
    const candidateRaw = p.map((value, k) => value + h[k]);
    const candidate = clamp(candidateRaw);
    if (candidate.some((value, k) => value !== candidateRaw[k])) boundHits += 1;
    const rCandidate = residuals(candidate);
    const chi2Candidate = rCandidate.some((value) => !Number.isFinite(value)) ? Infinity : common.dot(rCandidate, rCandidate);
    const predicted = 0.5 * common.dot(h, h.map((value, k) => mu * diagonal[k] * value - g[k]));
    const rho = predicted > 0 ? (chi2 - chi2Candidate) / (2 * predicted) : (chi2 - chi2Candidate);
    history.push({ iteration: iterations, chiSquare: chi2, damping: mu, accepted: rho > 0 });
    if (rho > 0 && Number.isFinite(chi2Candidate)) {
      const stepNorm = Math.sqrt(candidate.reduce((sum, value, k) => sum + (value - p[k]) ** 2, 0));
      const pNorm = Math.sqrt(common.dot(p, p));
      p = candidate; r = rCandidate; chi2 = chi2Candidate;
      J = jacobian(p); A = common.multiply(common.transpose(J), J); g = common.matVec(common.transpose(J), r);
      mu *= Math.max(1 / 3, 1 - (2 * rho - 1) ** 3);
      nu = 2;
      rejectedRun = 0;
      const gradientNorm = Math.max(...g.map((value) => Math.abs(value)));
      if (gradientNorm <= options.tolerance) { converged = true; reason = "gradient-below-tolerance"; break; }
      if (stepNorm <= options.tolerance * (pNorm + options.tolerance)) { converged = true; reason = "step-below-tolerance"; break; }
    } else {
      mu *= nu;
      nu *= 2;
      rejectedRun += 1;
      if (!Number.isFinite(mu) || mu > 1e30) { reason = "damping-overflow"; break; }
      // A minimum at working precision: every proposal (now tiny) fails to
      // lower χ² and the model predicts a negligible relative gain.
      if (rejectedRun >= 8 && Math.abs(predicted) <= 1e-14 * Math.max(1, chi2)) { converged = true; reason = "no-further-reduction"; break; }
    }
  }
  if (history.length && !converged && iterations >= options.maxIterations) reason = "max-iterations";
  let covarianceFree;
  try { covarianceFree = common.invertMatrix(A, "physics-spectrum-fit-covariance"); }
  catch { covarianceFree = null; }
  const assembled = assemble(p);
  return { parameters: assembled, free, chiSquare: chi2, iterations, converged, reason, covarianceFree, jacobian: J, history: history.slice(-50), boundHits, degreesOfFreedom: n - m };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function analyzeSpectrumFit(input) {
  const normalized = normalizeInput(input);
  const rowsAll = normalized.x.values.map((xi, index) => ({ ordinal: index + 1, x: xi, y: normalized.y.values[index], sigmaRaw: normalized.sigma ? normalized.sigma.values[index] : null }));
  const rows = rowsAll.filter((row) => normalized.range === null || (row.x >= normalized.range.min && row.x <= normalized.range.max));
  if (rows.length < 3) throw new PhysicsError("physics-spectrum-fit-too-few-points", "at least three points are required inside the fit range");
  const warnings = [];
  const sigma = rows.map((row) => {
    if (normalized.uncertaintyModel === "column") {
      if (!(row.sigmaRaw > 0)) throw new PhysicsError("physics-spectrum-fit-sigma-nonpositive", `point ${row.ordinal} has a non-positive uncertainty`);
      return row.sigmaRaw;
    }
    if (normalized.uncertaintyModel === "unit") return 1;
    if (row.y < 0) throw new PhysicsError("physics-spectrum-fit-poisson-negative", `point ${row.ordinal} is negative; Poisson uncertainties need counts >= 0`);
    return Math.sqrt(Math.max(row.y, 1));
  });
  if (normalized.uncertaintyModel === "poisson" && rows.some((row) => row.y < 1)) warnings.push("Poisson uncertainty model: bins with fewer than one count use σ = 1 (Neyman χ² floor); a likelihood fit is more appropriate for sparse spectra.");
  const model = buildModel(normalized);
  const x = rows.map((row) => row.x);
  const y = rows.map((row) => row.y);
  const fit = levenbergMarquardt(model, x, y, sigma, normalized.options);
  const degreesOfFreedom = fit.degreesOfFreedom;
  const reducedChiSquare = fit.chiSquare / degreesOfFreedom;
  const pValue = common.chiSquareSurvival(fit.chiSquare, degreesOfFreedom);
  if (!fit.converged) warnings.push(`Levenberg–Marquardt stopped without meeting the tolerance (${fit.reason}); treat parameters and errors as provisional.`);
  if (fit.boundHits > 0) warnings.push(`${fit.boundHits} accepted step(s) were clamped at parameter bounds; covariance from the unconstrained normal matrix may overstate precision.`);
  if (fit.covarianceFree === null) warnings.push("The normal matrix is singular at the solution; parameter errors and correlations are not available.");
  // Full covariance with fixed parameters as zero rows/columns.
  const count = fit.parameters.length;
  const covariance = common.zeros(count, count);
  if (fit.covarianceFree) fit.free.forEach((i, a) => fit.free.forEach((j, b) => { covariance[i][j] = fit.covarianceFree[a][b]; }));
  const correlation = fit.covarianceFree ? common.correlationFromCovariance(covariance) : null;
  const errorScale = Math.sqrt(Math.max(1, reducedChiSquare));
  const parameterRows = model.slots.map((slot, index) => {
    const error = fit.covarianceFree && !slot.fixed ? Math.sqrt(Math.max(0, covariance[index][index])) : null;
    const atBound = !slot.fixed && (fit.parameters[index] <= slot.lower || fit.parameters[index] >= slot.upper);
    return { id: slot.id, component: slot.componentLabel, name: slot.name, value: fit.parameters[index], error, errorScaled: error === null ? null : error * errorScale, fixed: slot.fixed, atBound, initial: slot.initial, lower: Number.isFinite(slot.lower) ? slot.lower : null, upper: Number.isFinite(slot.upper) ? slot.upper : null };
  });
  // Per-point diagnostics
  const pointRows = rows.map((row, index) => {
    const modelValue = model.evaluate(fit.parameters, row.x);
    const residual = row.y - modelValue;
    const pull = residual / sigma[index];
    return { ordinal: row.ordinal, x: row.x, y: row.y, sigma: sigma[index], model: modelValue, residual, pull, chiSquareContribution: pull * pull };
  });
  // Derived per-peak quantities with linear error propagation (numeric gradient).
  const derivedRows = normalized.peaks.map((peak, peakIndex) => {
    const definition = SHAPES[peak.shape];
    const offset = model.peakOffsets[peakIndex];
    const local = fit.parameters.slice(offset, offset + definition.parameters.length);
    const derived = definition.derived(local);
    const propagate = (key) => {
      if (derived[key] === null || !fit.covarianceFree) return null;
      const gradientFull = new Array(count).fill(0);
      definition.parameters.forEach((_, k) => {
        const step = 1e-6 * Math.max(1, Math.abs(local[k]));
        const plus = [...local]; plus[k] += step;
        const minus = [...local]; minus[k] -= step;
        gradientFull[offset + k] = (definition.derived(plus)[key] - definition.derived(minus)[key]) / (2 * step);
      });
      const variance = common.dot(gradientFull, common.matVec(covariance, gradientFull));
      return Number.isFinite(variance) && variance >= 0 ? Math.sqrt(variance) : null;
    };
    const areaInRange = common.simpson((xi) => model.evaluateComponent(fit.parameters, peakIndex, xi), Math.min(...x), Math.max(...x), 2000);
    return { component: peak.label, shape: peak.shape, center: local[1], centerError: fit.covarianceFree ? Math.sqrt(Math.max(0, covariance[offset + 1][offset + 1])) : null, fwhm: derived.fwhm, fwhmError: propagate("fwhm"), area: derived.area, areaError: propagate("area"), areaInFitRange: areaInRange, height: derived.height };
  });
  // Dense curves for the figure
  const xMin = Math.min(...x); const xMax = Math.max(...x);
  const grid = common.linspace(xMin, xMax, normalized.options.curvePoints);
  const curveRows = grid.map((xi) => ({ x: xi, total: model.evaluate(fit.parameters, xi), background: model.evaluateComponent(fit.parameters, -1, xi) }));
  const componentRows = [];
  normalized.peaks.forEach((peak, peakIndex) => {
    for (const xi of grid) componentRows.push({ component: peak.label, x: xi, y: model.evaluateComponent(fit.parameters, peakIndex, xi) + model.evaluateComponent(fit.parameters, -1, xi) });
  });
  const xLabel = `${normalized.x.column.name}${normalized.x.column.unit ? ` (${normalized.x.column.unit})` : ""}`;
  const yLabel = `${normalized.y.column.name}${normalized.y.column.unit ? ` (${normalized.y.column.unit})` : ""}`;
  const publicationTable = common.scienceTable(`Fit parameters · ${normalized.table.title}`, [
    { id: "parameter", label: "Parameter", type: "string" }, { id: "component", label: "Component", type: "string" },
    { id: "value", label: "Value" }, { id: "error", label: "Error (absolute σ)" }, { id: "errorScaled", label: "Error × √(χ²/ndf)" },
    { id: "initial", label: "Initial" }, { id: "status", label: "Status", type: "string" },
  ], parameterRows.map((row) => [row.id, row.component, row.value, row.error, row.errorScaled, row.initial, row.fixed ? "fixed" : row.atBound ? "at-bound" : "free"]));
  const pointsTable = common.scienceTable("Points, model, residuals, pulls", [
    { id: "ordinal", label: "Point" }, { id: "x", label: normalized.x.column.name, unit: normalized.x.column.unit }, { id: "y", label: normalized.y.column.name, unit: normalized.y.column.unit },
    { id: "sigma", label: "σ", unit: normalized.y.column.unit }, { id: "model", label: "Model", unit: normalized.y.column.unit }, { id: "residual", label: "Residual", unit: normalized.y.column.unit }, { id: "pull", label: "Pull" }, { id: "chi2", label: "χ² contribution" },
  ], pointRows.map((row) => [row.ordinal, row.x, row.y, row.sigma, row.model, row.residual, row.pull, row.chiSquareContribution]));
  const peaksTable = common.scienceTable("Derived peak quantities", [
    { id: "component", label: "Component", type: "string" }, { id: "shape", label: "Shape", type: "string" }, { id: "center", label: "Center", unit: normalized.x.column.unit }, { id: "centerError", label: "Center error", unit: normalized.x.column.unit },
    { id: "fwhm", label: "FWHM", unit: normalized.x.column.unit }, { id: "fwhmError", label: "FWHM error", unit: normalized.x.column.unit }, { id: "area", label: "Analytic area" }, { id: "areaError", label: "Area error" }, { id: "areaInFitRange", label: "Numeric area in fit range" }, { id: "height", label: "Height", unit: normalized.y.column.unit },
  ], derivedRows.map((row) => [row.component, row.shape, row.center, row.centerError, row.fwhm, row.fwhmError, row.area, row.areaError, row.areaInFitRange, row.height]));
  const width = 680;
  const pointValues = pointRows.map((row) => ({ x: row.x, y: row.y, low: row.y - row.sigma, high: row.y + row.sigma, pull: row.pull, ordinal: row.ordinal }));
  const spec = common.stackedVegaFigure({
    description: `Spectrum fit of ${normalized.y.column.name} versus ${normalized.x.column.name}: data with ±1σ bars, total model, per-component curves, and pulls (χ²/ndf = ${reducedChiSquare.toPrecision(4)}).`,
    width,
    data: [
      { name: "points", values: pointValues },
      { name: "curve", values: curveRows },
      { name: "components", values: componentRows },
      { name: "pullBand", values: [{ level: 1 }, { level: -1 }, { level: 2 }, { level: -2 }] },
    ],
    panels: [
      {
        name: "fitPanel", height: 320,
        scales: [
          common.linearScale("x", "points", "x", "width"),
          { name: "y", type: "linear", domain: { fields: [{ data: "points", field: "low" }, { data: "points", field: "high" }, { data: "curve", field: "total" }] }, range: "height", nice: true, zero: false },
          { name: "componentColor", type: "ordinal", domain: { data: "components", field: "component" }, range: common.PALETTE.component },
          // Components are always dashed so they never read as the fitted total, and each one gets a
          // DIFFERENT dash: the colour ladder holds 1.4:1 in greyscale but falls to 1.35:1 under
          // protanopia between the teal and the tan, so two components drawn with one dash pattern
          // would rely on a hue that reader does not have.
          { name: "componentDash", type: "ordinal", domain: { data: "components", field: "component" }, range: [[4, 3], [1, 3], [8, 3, 2, 3], [2, 2], [10, 4]] },
        ],
        axes: [common.axis("bottom", "x", xLabel), common.axis("left", "y", yLabel)],
        legends: [{ fill: "componentColor", strokeDash: "componentDash", orient: "right", title: "Components" }],
        marks: [
          common.errorBarMark("points", "x", "low", "high", common.PALETTE.neutral),
          common.symbolMark("points", "x", "y", common.PALETTE.data, { tooltip: "pull" }),
          {
            type: "group", from: { facet: { name: "componentSeries", data: "components", groupby: "component" } },
            marks: [{ type: "line", from: { data: "componentSeries" }, encode: { enter: { x: { scale: "x", field: "x" }, y: { scale: "y", field: "y" }, stroke: { scale: "componentColor", field: "component" }, strokeWidth: { value: 1.2 }, strokeDash: { scale: "componentDash", field: "component" } } } }],
          },
          common.lineMark("curve", "x", "background", common.PALETTE.neutral, { strokeWidth: 1, dash: [2, 2] }),
          common.lineMark("curve", "x", "total", common.PALETTE.fit, { strokeWidth: 2 }),
        ],
      },
      {
        name: "pullPanel", height: 120,
        scales: [
          common.linearScale("x", "points", "x", "width"),
          { name: "y", type: "linear", domain: { fields: [{ data: "points", field: "pull" }, { data: "pullBand", field: "level" }] }, range: "height", nice: true, zero: true },
        ],
        axes: [common.axis("bottom", "x", xLabel), common.axis("left", "y", "Pull (data − model)/σ")],
        marks: [
          common.horizontalRule("pullBand", 2, common.PALETTE.band, { width, dash: [3, 3] }),
          common.horizontalRule("pullBand", -2, common.PALETTE.band, { width, dash: [3, 3] }),
          common.horizontalRule("pullBand", 0, common.PALETTE.neutral, { width }),
          common.barMark("points", "x", "pull", common.PALETTE.data, { halfWidth: 2 }),
        ],
      },
    ],
  });
  const result = {
    schema: "agentlas.physics.analysis-result/v1",
    analysisId: "spectrum-fit",
    method: {
      id: "levenberg-marquardt-chi-square-spectrum-fit", version: "1.0.0",
      jacobian: model.jacobianMode,
      dampingUpdate: "nielsen-2004",
      covariance: "inverse-normal-matrix-absolute-sigma",
      references: [
        "K. Madsen, H. B. Nielsen, O. Tingleff, Methods for Non-Linear Least Squares Problems, 2nd ed., IMM DTU (2004), §3.2",
        "J. A. C. Weideman, Computation of the complex error function, SIAM J. Numer. Anal. 31, 1497 (1994)",
        "J. J. Olivero, R. L. Longbothum, Empirical fits to the Voigt line width, JQSRT 17, 233 (1977)",
        "M. J. Oreglia, PhD thesis SLAC-R-236 (1980) Appendix D (Crystal Ball function)",
        "Particle Data Group, Review of Particle Physics, Resonances (relativistic Breit–Wigner normalization)",
      ],
    },
    input: {
      title: normalized.table.title, xColumn: normalized.x.column.name, xUnit: normalized.x.column.unit, yColumn: normalized.y.column.name, yUnit: normalized.y.column.unit,
      uncertaintyModel: normalized.uncertaintyModel, range: normalized.range, pointCount: rows.length, excludedPointCount: rowsAll.length - rows.length,
      peaks: normalized.peaks.map((peak) => ({ label: peak.label, shape: peak.shape, parameters: SHAPES[peak.shape].parameters, initial: peak.initial, fixed: peak.fixed, bounds: peak.bounds, description: SHAPES[peak.shape].describe })),
      background: { kind: normalized.background.kind, degree: normalized.background.degree, parameters: normalized.background.parameterNames, initial: normalized.background.initial, fixed: normalized.background.fixed },
      options: normalized.options,
    },
    summary: { chiSquare: fit.chiSquare, degreesOfFreedom, reducedChiSquare, pValue, converged: fit.converged, stopReason: fit.reason, iterations: fit.iterations, freeParameterCount: fit.free.length, fixedParameterCount: model.slots.length - fit.free.length, errorScaleApplied: errorScale },
    parameters: parameterRows,
    covariance: fit.covarianceFree ? covariance : null,
    correlation,
    parameterOrder: model.slots.map((slot) => slot.id),
    peaks: derivedRows,
    points: pointRows,
    convergenceHistory: fit.history,
    publicationTable,
    tables: { points: pointsTable, peaks: peaksTable },
    figure: common.figureReceipt(spec),
    boundaries: [
      "Chi-square (Neyman) fit with the caller-declared uncertainty model; for low-count spectra a Poisson likelihood fit would be more appropriate.",
      "Covariance is the inverse normal matrix at the solution (absolute σ). The scaled column multiplies errors by √(max(1, χ²/ndf)) for the curve_fit(absolute_sigma=False) convention.",
      "Bounds are enforced by projection; a parameter reported at-bound has no valid symmetric error.",
      "Voigt FWHM uses the Olivero–Longbothum approximation (≈0.02 % accuracy); Crystal Ball analytic area is not reported (numeric area in range is).",
      "Starting values are the caller's responsibility; LM converges to a local minimum.",
    ],
    warnings,
  };
  return common.finalizeAnalysis(result);
}

module.exports = { analyzeSpectrumFit, faddeeva, voigtDensity, SHAPES, BACKGROUNDS };
