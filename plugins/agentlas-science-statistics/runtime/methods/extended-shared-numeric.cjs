"use strict";

/**
 * Shared deterministic numeric kernels for the multivariate-extended, clustering, and
 * distributions-extended method modules. Pure JavaScript, no engine require (circular),
 * no Date/Math.random: every stochastic routine consumes an explicit seeded generator.
 */

const MASK64 = (1n << 64n) - 1n;
const TWO53 = 2 ** 53;

function createRng(seed) {
  let state = BigInt(seed) & MASK64;
  let spare = null;
  const next64 = () => {
    state = (state + 0x9E3779B97F4A7C15n) & MASK64;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & MASK64;
    return z ^ (z >> 31n);
  };
  const uniform = () => Number(next64() >> 11n) / TWO53;
  const uniformOpen = () => {
    let u = uniform();
    while (u <= 0) u = uniform();
    return u;
  };
  const normal = () => {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    const radius = Math.sqrt(-2 * Math.log(uniformOpen()));
    const angle = 2 * Math.PI * uniform();
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
  const integer = (n) => Math.min(n - 1, Math.floor(uniform() * n));
  const shuffle = (array) => {
    for (let index = array.length - 1; index > 0; index -= 1) {
      const swap = integer(index + 1);
      [array[index], array[swap]] = [array[swap], array[index]];
    }
    return array;
  };
  const gamma = (shape) => {
    if (shape < 1) return gamma(shape + 1) * Math.pow(uniformOpen(), 1 / shape);
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x;
      let v;
      do {
        x = normal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = uniformOpen();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  };
  const poisson = (lambda) => {
    if (lambda < 30) {
      const limit = Math.exp(-lambda);
      let k = 0;
      let product = uniform();
      while (product > limit) {
        k += 1;
        product *= uniform();
      }
      return k;
    }
    // inversion from the mode for larger means (deterministic, O(sqrt(lambda)) expected)
    const mode = Math.floor(lambda);
    const logMode = mode * Math.log(lambda) - lambda - logGamma(mode + 1);
    const pMode = Math.exp(logMode);
    const u = uniform();
    let lower = mode;
    let upper = mode;
    let pLower = pMode;
    let pUpper = pMode;
    let cumulative = pMode;
    if (u < cumulative) return mode;
    for (let step = 0; step < 1e7; step += 1) {
      if (lower > 0) {
        pLower *= lower / lambda;
        lower -= 1;
        cumulative += pLower;
        if (u < cumulative) return lower;
      }
      pUpper *= lambda / (upper + 1);
      upper += 1;
      cumulative += pUpper;
      if (u < cumulative) return upper;
      if (cumulative >= 1 - 1e-15 && lower === 0) return upper;
    }
    return upper;
  };
  return { uniform, uniformOpen, normal, integer, shuffle, gamma, poisson };
}

// ---------------------------------------------------------------------------------------------
// Special functions (Lanczos log-gamma, incomplete gamma/beta, digamma, trigamma, erfc).
// ---------------------------------------------------------------------------------------------

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

function logGamma(z) {
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  let x = LANCZOS[0];
  const shifted = z - 1;
  for (let i = 1; i < LANCZOS.length; i += 1) x += LANCZOS[i] / (shifted + i);
  const t = shifted + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(x);
}

function digamma(x) {
  let result = 0;
  let value = x;
  if (value <= 0 && Number.isInteger(value)) return NaN;
  if (value < 0) return digamma(1 - value) - Math.PI / Math.tan(Math.PI * value);
  while (value < 6) {
    result -= 1 / value;
    value += 1;
  }
  const inv = 1 / value;
  const inv2 = inv * inv;
  result += Math.log(value) - 0.5 * inv - inv2 * (1 / 12 - inv2 * (1 / 120 - inv2 * (1 / 252 - inv2 * (1 / 240 - inv2 * (1 / 132 - inv2 * (691 / 32760 - inv2 / 12))))));
  return result;
}

function trigamma(x) {
  let result = 0;
  let value = x;
  if (value <= 0 && Number.isInteger(value)) return NaN;
  if (value < 0) {
    const s = Math.PI / Math.sin(Math.PI * value);
    return -trigamma(1 - value) + s * s;
  }
  while (value < 6) {
    result += 1 / (value * value);
    value += 1;
  }
  const inv = 1 / value;
  const inv2 = inv * inv;
  result += inv + 0.5 * inv2 + inv * inv2 * (1 / 6 - inv2 * (1 / 30 - inv2 * (1 / 42 - inv2 * (1 / 30 - inv2 * (5 / 66 - inv2 * (691 / 2730 - inv2 * 7 / 6))))));
  return result;
}

function gammaSeriesP(a, x) {
  let sumValue = 1 / a;
  let delta = sumValue;
  let ap = a;
  for (let n = 1; n <= 500; n += 1) {
    ap += 1;
    delta *= x / ap;
    sumValue += delta;
    if (Math.abs(delta) < Math.abs(sumValue) * 1e-16) break;
  }
  return sumValue * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

function gammaContinuedFractionQ(a, x) {
  const fpmin = 1e-300;
  let b = x + 1 - a;
  let c = 1 / fpmin;
  let d = 1 / Math.max(fpmin, b);
  let h = d;
  for (let i = 1; i <= 500; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = b + an / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

function gammaP(a, x) {
  if (x <= 0) return 0;
  return x < a + 1 ? gammaSeriesP(a, x) : 1 - gammaContinuedFractionQ(a, x);
}

function gammaQ(a, x) {
  if (x <= 0) return 1;
  return x < a + 1 ? 1 - gammaSeriesP(a, x) : gammaContinuedFractionQ(a, x);
}

function betaContinuedFraction(a, b, x) {
  const fpmin = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < fpmin) d = fpmin;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 500; m += 1) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-16) return h;
  }
  return h;
}

function regularizedBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
  if (x < (a + 1) / (a + b + 2)) return front * betaContinuedFraction(a, b, x) / a;
  return 1 - front * betaContinuedFraction(b, a, 1 - x) / b;
}

function logBeta(a, b) {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

function erfc(z) {
  if (z >= 0) return gammaQ(0.5, z * z);
  return 2 - gammaQ(0.5, z * z);
}

function normalCdf(x) {
  if (!Number.isFinite(x)) return x < 0 ? 0 : 1;
  return 0.5 * erfc(-x / Math.SQRT2);
}

function normalSurvival(x) {
  if (!Number.isFinite(x)) return x < 0 ? 1 : 0;
  return 0.5 * erfc(x / Math.SQRT2);
}

function normalLogPdf(z) {
  return -0.5 * z * z - 0.5 * Math.log(2 * Math.PI);
}

function normalQuantileApprox(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function normalQuantile(p) {
  if (!(p > 0) || !(p < 1)) return p <= 0 ? -Infinity : Infinity;
  let x = normalQuantileApprox(p);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const error = (p < 0.5 ? normalCdf(x) - p : -(normalSurvival(x) - (1 - p)));
    const density = Math.exp(normalLogPdf(x));
    if (density <= 0) break;
    const step = error / density;
    x -= step / (1 + 0.5 * x * step); // Halley refinement
    if (Math.abs(step) < 1e-16 * Math.max(1, Math.abs(x))) break;
  }
  return x;
}

function tCdf(value, df) {
  if (!Number.isFinite(value)) return value < 0 ? 0 : 1;
  const x = df / (df + value * value);
  const tail = 0.5 * regularizedBeta(x, df / 2, 0.5);
  return value >= 0 ? 1 - tail : tail;
}

function tLogPdf(value, df) {
  return logGamma((df + 1) / 2) - logGamma(df / 2) - 0.5 * Math.log(df * Math.PI) - ((df + 1) / 2) * Math.log1p(value * value / df);
}

function chiSquareCdf(value, df) {
  if (value <= 0) return 0;
  return gammaP(df / 2, value / 2);
}

function chiSquareSurvival(value, df) {
  if (value <= 0) return 1;
  return gammaQ(df / 2, value / 2);
}

function fSurvival(value, df1, df2) {
  if (value <= 0) return 1;
  return regularizedBeta(df2 / (df2 + df1 * value), df2 / 2, df1 / 2);
}

function fCdf(value, df1, df2) {
  if (value <= 0) return 0;
  return regularizedBeta(df1 * value / (df1 * value + df2), df1 / 2, df2 / 2);
}

/**
 * Monotone inversion of a cdf on [lower, upper] by bisection followed by secant polish.
 * Returns the x with cdf(x) = p to ~1e-13 relative precision.
 */
function invertMonotone(cdf, p, lower, upper, iterations = 200) {
  let lo = lower;
  let hi = upper;
  let flo = cdf(lo) - p;
  let fhi = cdf(hi) - p;
  if (flo > 0) return lo;
  if (fhi < 0) return hi;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const mid = 0.5 * (lo + hi);
    if (mid === lo || mid === hi) break;
    const fmid = cdf(mid) - p;
    if (fmid === 0) return mid;
    if (fmid < 0) {
      lo = mid;
      flo = fmid;
    } else {
      hi = mid;
      fhi = fmid;
    }
    if (hi - lo <= 1e-15 * Math.max(1, Math.abs(lo), Math.abs(hi))) break;
  }
  if (fhi !== flo) {
    const secant = lo - flo * (hi - lo) / (fhi - flo);
    if (secant >= lo && secant <= hi) return secant;
  }
  return 0.5 * (lo + hi);
}

function bracketUpper(cdf, p, start) {
  let hi = Math.max(start, 1e-8);
  for (let index = 0; index < 2000 && cdf(hi) < p; index += 1) hi *= 2;
  return hi;
}

function tQuantile(p, df) {
  if (!(p > 0) || !(p < 1)) return p <= 0 ? -Infinity : Infinity;
  if (p === 0.5) return 0;
  const target = p < 0.5 ? 1 - p : p;
  const hi = bracketUpper((x) => tCdf(x, df), target, 1);
  const value = invertMonotone((x) => tCdf(x, df), target, 0, hi);
  return p < 0.5 ? -value : value;
}

function chiSquareQuantile(p, df) {
  if (!(p > 0) || !(p < 1)) return p <= 0 ? 0 : Infinity;
  const hi = bracketUpper((x) => chiSquareCdf(x, df), p, Math.max(df, 1));
  return invertMonotone((x) => chiSquareCdf(x, df), p, 0, hi);
}

function fQuantile(p, df1, df2) {
  if (!(p > 0) || !(p < 1)) return p <= 0 ? 0 : Infinity;
  const hi = bracketUpper((x) => fCdf(x, df1, df2), p, 1);
  return invertMonotone((x) => fCdf(x, df1, df2), p, 0, hi);
}

function gammaQuantile(p, shape, scale) {
  if (!(p > 0) || !(p < 1)) return p <= 0 ? 0 : Infinity;
  const cdf = (x) => gammaP(shape, x / scale);
  const hi = bracketUpper(cdf, p, shape * scale + 1);
  return invertMonotone(cdf, p, 0, hi);
}

function betaQuantile(p, a, b) {
  if (!(p > 0) || !(p < 1)) return p <= 0 ? 0 : 1;
  return invertMonotone((x) => regularizedBeta(x, a, b), p, 0, 1);
}

/** Kolmogorov distribution survival: P(K > x) = 2 sum (-1)^(k-1) exp(-2 k^2 x^2). */
function kolmogorovSurvival(x) {
  if (x <= 0) return 1;
  if (x < 1) {
    // Jacobi theta form for small x (better convergence)
    const z = -(Math.PI * Math.PI) / (8 * x * x);
    let total = 0;
    for (let k = 1; k <= 200; k += 2) {
      const term = Math.exp(z * k * k);
      total += term;
      if (term < 1e-18) break;
    }
    return Math.min(1, Math.max(0, 1 - Math.sqrt(2 * Math.PI) / x * total));
  }
  let total = 0;
  for (let k = 1; k <= 200; k += 1) {
    const term = Math.exp(-2 * k * k * x * x);
    total += (k % 2 === 1 ? 1 : -1) * term;
    if (term < 1e-18) break;
  }
  return Math.min(1, Math.max(0, 2 * total));
}

// ---------------------------------------------------------------------------------------------
// Optimizers (deterministic).
// ---------------------------------------------------------------------------------------------

function nelderMead(objective, start, { step = 0.1, maxIterations = 2000, tolerance = 1e-10, budget = null } = {}) {
  const dimension = start.length;
  let simplex = [start.slice()];
  for (let index = 0; index < dimension; index += 1) {
    const vertex = start.slice();
    const scale = Array.isArray(step) ? step[index] : step;
    vertex[index] += scale === 0 ? 0.00025 : scale;
    simplex.push(vertex);
  }
  let values = simplex.map((vertex) => objective(vertex));
  let evaluations = simplex.length;
  const order = () => {
    const indices = values.map((_, index) => index).sort((a, b) => values[a] - values[b] || a - b);
    simplex = indices.map((index) => simplex[index]);
    values = indices.map((index) => values[index]);
  };
  let iterations = 0;
  let converged = false;
  for (; iterations < maxIterations; iterations += 1) {
    if (budget) budget.check(dimension * 4);
    order();
    const best = values[0];
    const worst = values[dimension];
    let spread = 0;
    for (let index = 1; index <= dimension; index += 1) {
      for (let axis = 0; axis < dimension; axis += 1) spread = Math.max(spread, Math.abs(simplex[index][axis] - simplex[0][axis]));
    }
    const valueSpread = Math.abs(worst - best);
    if (valueSpread <= tolerance * (1 + Math.abs(best)) && spread <= Math.sqrt(tolerance) * (1 + Math.max(...simplex[0].map(Math.abs)))) {
      converged = true;
      break;
    }
    const centroid = Array(dimension).fill(0);
    for (let index = 0; index < dimension; index += 1) for (let axis = 0; axis < dimension; axis += 1) centroid[axis] += simplex[index][axis] / dimension;
    const reflect = centroid.map((value, axis) => value + (value - simplex[dimension][axis]));
    const reflectValue = objective(reflect);
    evaluations += 1;
    if (reflectValue < values[0]) {
      const expand = centroid.map((value, axis) => value + 2 * (value - simplex[dimension][axis]));
      const expandValue = objective(expand);
      evaluations += 1;
      if (expandValue < reflectValue) {
        simplex[dimension] = expand;
        values[dimension] = expandValue;
      } else {
        simplex[dimension] = reflect;
        values[dimension] = reflectValue;
      }
      continue;
    }
    if (reflectValue < values[dimension - 1]) {
      simplex[dimension] = reflect;
      values[dimension] = reflectValue;
      continue;
    }
    const outside = reflectValue < values[dimension];
    const contract = centroid.map((value, axis) => value + (outside ? 0.5 : -0.5) * (value - simplex[dimension][axis]));
    const contractValue = objective(contract);
    evaluations += 1;
    if (contractValue < (outside ? reflectValue : values[dimension])) {
      simplex[dimension] = contract;
      values[dimension] = contractValue;
      continue;
    }
    for (let index = 1; index <= dimension; index += 1) {
      simplex[index] = simplex[index].map((value, axis) => simplex[0][axis] + 0.5 * (value - simplex[0][axis]));
      values[index] = objective(simplex[index]);
      evaluations += 1;
    }
  }
  order();
  return { x: simplex[0], value: values[0], iterations, evaluations, converged };
}

/** Brent minimisation on [a, b]. */
function brentMinimize(objective, a, b, { tolerance = 1e-10, maxIterations = 200, budget = null } = {}) {
  const golden = 0.3819660112501051;
  let lo = a;
  let hi = b;
  let x = lo + golden * (hi - lo);
  let w = x;
  let v = x;
  let fx = objective(x);
  let fw = fx;
  let fv = fx;
  let d = 0;
  let e = 0;
  let iterations = 0;
  for (; iterations < maxIterations; iterations += 1) {
    if (budget) budget.check();
    const mid = 0.5 * (lo + hi);
    const tol1 = tolerance * Math.abs(x) + 1e-12;
    const tol2 = 2 * tol1;
    if (Math.abs(x - mid) <= tol2 - 0.5 * (hi - lo)) break;
    let useGolden = true;
    if (Math.abs(e) > tol1) {
      let r = (x - w) * (fx - fv);
      let q = (x - v) * (fx - fw);
      let p = (x - v) * q - (x - w) * r;
      q = 2 * (q - r);
      if (q > 0) p = -p;
      q = Math.abs(q);
      const previous = e;
      e = d;
      if (Math.abs(p) < Math.abs(0.5 * q * previous) && p > q * (lo - x) && p < q * (hi - x)) {
        d = p / q;
        const u = x + d;
        if (u - lo < tol2 || hi - u < tol2) d = mid - x >= 0 ? tol1 : -tol1;
        useGolden = false;
      }
    }
    if (useGolden) {
      e = x >= mid ? lo - x : hi - x;
      d = golden * e;
    }
    const u = Math.abs(d) >= tol1 ? x + d : x + (d >= 0 ? tol1 : -tol1);
    const fu = objective(u);
    if (fu <= fx) {
      if (u >= x) lo = x;
      else hi = x;
      v = w; fv = fw;
      w = x; fw = fx;
      x = u; fx = fu;
    } else {
      if (u < x) lo = u;
      else hi = u;
      if (fu <= fw || w === x) {
        v = w; fv = fw;
        w = u; fw = fu;
      } else if (fu <= fv || v === x || v === w) {
        v = u; fv = fu;
      }
    }
  }
  return { x, value: fx, iterations };
}

/** Bisection root on a bracket [a, b] where f(a) and f(b) differ in sign. */
function bisectionRoot(f, a, b, { tolerance = 1e-13, maxIterations = 300 } = {}) {
  let lo = a;
  let hi = b;
  let flo = f(lo);
  let fhi = f(hi);
  if (flo === 0) return lo;
  if (fhi === 0) return hi;
  if (flo * fhi > 0) return null;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const mid = 0.5 * (lo + hi);
    const fmid = f(mid);
    if (fmid === 0) return mid;
    if (fmid * flo < 0) {
      hi = mid;
      fhi = fmid;
    } else {
      lo = mid;
      flo = fmid;
    }
    if (hi - lo <= tolerance * Math.max(1, Math.abs(lo), Math.abs(hi))) break;
  }
  return 0.5 * (lo + hi);
}

/** Limited-memory BFGS with Armijo backtracking. gradient(x) returns an array. */
function lbfgs(objective, gradient, start, { maxIterations = 500, tolerance = 1e-9, memory = 8, budget = null } = {}) {
  let x = start.slice();
  let value = objective(x);
  let grad = gradient(x);
  const history = [];
  let iterations = 0;
  let converged = false;
  const dot = (a, b) => a.reduce((total, item, index) => total + item * b[index], 0);
  for (; iterations < maxIterations; iterations += 1) {
    if (budget) budget.check(x.length);
    const gradNorm = Math.sqrt(dot(grad, grad));
    if (gradNorm <= tolerance * (1 + Math.abs(value))) {
      converged = true;
      break;
    }
    let q = grad.slice();
    const alphas = [];
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const { s, y, rho } = history[index];
      const alpha = rho * dot(s, q);
      alphas[index] = alpha;
      q = q.map((item, axis) => item - alpha * y[axis]);
    }
    let scale = 1;
    if (history.length) {
      const last = history[history.length - 1];
      scale = dot(last.s, last.y) / dot(last.y, last.y);
    }
    let direction = q.map((item) => item * scale);
    for (let index = 0; index < history.length; index += 1) {
      const { s, y, rho } = history[index];
      const beta = rho * dot(y, direction);
      direction = direction.map((item, axis) => item + s[axis] * (alphas[index] - beta));
    }
    direction = direction.map((item) => -item);
    let slope = dot(grad, direction);
    if (slope >= 0) {
      direction = grad.map((item) => -item);
      slope = dot(grad, direction);
      history.length = 0;
    }
    let stepSize = 1;
    let nextX = null;
    let nextValue = Infinity;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const candidate = x.map((item, axis) => item + stepSize * direction[axis]);
      const candidateValue = objective(candidate);
      if (Number.isFinite(candidateValue) && candidateValue <= value + 1e-4 * stepSize * slope) {
        nextX = candidate;
        nextValue = candidateValue;
        break;
      }
      stepSize *= 0.5;
    }
    if (nextX === null) break;
    const nextGrad = gradient(nextX);
    const s = nextX.map((item, axis) => item - x[axis]);
    const y = nextGrad.map((item, axis) => item - grad[axis]);
    const sy = dot(s, y);
    if (sy > 1e-14) {
      history.push({ s, y, rho: 1 / sy });
      if (history.length > memory) history.shift();
    }
    const improvement = value - nextValue;
    x = nextX;
    value = nextValue;
    grad = nextGrad;
    if (improvement <= tolerance * (1 + Math.abs(value)) && Math.sqrt(dot(s, s)) <= tolerance * (1 + Math.sqrt(dot(x, x)))) {
      converged = true;
      break;
    }
  }
  return { x, value, gradient: grad, iterations, converged };
}

// ---------------------------------------------------------------------------------------------
// Dense linear algebra.
// ---------------------------------------------------------------------------------------------

function zeros(rows, columns) {
  return Array.from({ length: rows }, () => Array(columns).fill(0));
}

function identity(n) {
  return Array.from({ length: n }, (_, row) => Array.from({ length: n }, (_, column) => row === column ? 1 : 0));
}

function transpose(matrix) {
  return matrix[0].map((_, column) => matrix.map((row) => row[column]));
}

function multiply(left, right, budget) {
  const out = zeros(left.length, right[0].length);
  for (let i = 0; i < left.length; i += 1) {
    for (let k = 0; k < right.length; k += 1) {
      const value = left[i][k];
      if (value === 0) continue;
      if (budget) budget.check();
      for (let j = 0; j < right[0].length; j += 1) out[i][j] += value * right[k][j];
    }
  }
  return out;
}

function multiplyVector(matrix, vector) {
  return matrix.map((row) => row.reduce((total, value, index) => total + value * vector[index], 0));
}

function cholesky(matrix) {
  const n = matrix.length;
  const lower = zeros(n, n);
  for (let row = 0; row < n; row += 1) {
    for (let column = 0; column <= row; column += 1) {
      let value = matrix[row][column];
      for (let index = 0; index < column; index += 1) value -= lower[row][index] * lower[column][index];
      if (row === column) {
        if (!(value > 0) || !Number.isFinite(value)) return null;
        lower[row][column] = Math.sqrt(value);
      } else lower[row][column] = value / lower[column][column];
    }
  }
  return lower;
}

function choleskySolve(lower, rhs) {
  const n = lower.length;
  const y = Array(n).fill(0);
  for (let row = 0; row < n; row += 1) {
    let value = rhs[row];
    for (let index = 0; index < row; index += 1) value -= lower[row][index] * y[index];
    y[row] = value / lower[row][row];
  }
  const x = Array(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let value = y[row];
    for (let index = row + 1; index < n; index += 1) value -= lower[index][row] * x[index];
    x[row] = value / lower[row][row];
  }
  return x;
}

function choleskyInverse(lower) {
  const n = lower.length;
  const columns = identity(n).map((column) => choleskySolve(lower, column));
  return transpose(columns);
}

function choleskyLogDeterminant(lower) {
  let total = 0;
  for (let index = 0; index < lower.length; index += 1) total += 2 * Math.log(lower[index][index]);
  return total;
}

/** Gauss-Jordan inverse with partial pivoting; returns null when singular. */
function inverse(matrix) {
  const n = matrix.length;
  const work = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => i === j ? 1 : 0)]);
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) if (Math.abs(work[row][column]) > Math.abs(work[pivot][column])) pivot = row;
    if (Math.abs(work[pivot][column]) < 1e-300) return null;
    [work[column], work[pivot]] = [work[pivot], work[column]];
    const divisor = work[column][column];
    for (let j = 0; j < 2 * n; j += 1) work[column][j] /= divisor;
    for (let row = 0; row < n; row += 1) {
      if (row === column) continue;
      const factor = work[row][column];
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j += 1) work[row][j] -= factor * work[column][j];
    }
  }
  return work.map((row) => row.slice(n));
}

function logAbsDeterminant(matrix) {
  const n = matrix.length;
  const work = matrix.map((row) => [...row]);
  let total = 0;
  let sign = 1;
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) if (Math.abs(work[row][column]) > Math.abs(work[pivot][column])) pivot = row;
    if (Math.abs(work[pivot][column]) < 1e-300) return { logAbs: -Infinity, sign: 0 };
    if (pivot !== column) {
      [work[column], work[pivot]] = [work[pivot], work[column]];
      sign = -sign;
    }
    const value = work[column][column];
    total += Math.log(Math.abs(value));
    if (value < 0) sign = -sign;
    for (let row = column + 1; row < n; row += 1) {
      const factor = work[row][column] / value;
      if (factor === 0) continue;
      for (let j = column; j < n; j += 1) work[row][j] -= factor * work[column][j];
    }
  }
  return { logAbs: total, sign };
}

/**
 * Cyclic Jacobi eigendecomposition for symmetric matrices. Unlike the engine helper this keeps
 * negative eigenvalues (needed for reduced correlation matrices in factor analysis and for
 * double-centred MDS matrices). Eigenvectors are columns of `vectors`, ordered by descending value,
 * with the largest-absolute component of each vector made positive.
 */
function symmetricEigen(matrix, budget, tolerance = 1e-13) {
  const n = matrix.length;
  const a = matrix.map((row) => [...row]);
  const v = identity(n);
  let off = 0;
  let scale = 0;
  for (let row = 0; row < n; row += 1) for (let column = 0; column < n; column += 1) {
    scale = Math.max(scale, Math.abs(a[row][column]));
    if (row !== column) off += a[row][column] * a[row][column];
  }
  const threshold = tolerance * Math.max(scale, 1e-300);
  let sweeps = 0;
  if (n > 1) {
    for (; sweeps < 100; sweeps += 1) {
      let rotated = false;
      for (let p = 0; p < n - 1; p += 1) {
        for (let q = p + 1; q < n; q += 1) {
          if (budget) budget.check();
          const apq = a[p][q];
          if (Math.abs(apq) <= threshold * 1e-3) continue;
          rotated = true;
          const theta = (a[q][q] - a[p][p]) / (2 * apq);
          const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          const c = 1 / Math.sqrt(t * t + 1);
          const s = t * c;
          for (let k = 0; k < n; k += 1) {
            const akp = a[k][p];
            const akq = a[k][q];
            a[k][p] = c * akp - s * akq;
            a[k][q] = s * akp + c * akq;
          }
          for (let k = 0; k < n; k += 1) {
            const apk = a[p][k];
            const aqk = a[q][k];
            a[p][k] = c * apk - s * aqk;
            a[q][k] = s * apk + c * aqk;
          }
          for (let k = 0; k < n; k += 1) {
            const vkp = v[k][p];
            const vkq = v[k][q];
            v[k][p] = c * vkp - s * vkq;
            v[k][q] = s * vkp + c * vkq;
          }
        }
      }
      if (!rotated) break;
      off = 0;
      for (let row = 0; row < n; row += 1) for (let column = row + 1; column < n; column += 1) off += a[row][column] * a[row][column];
      if (Math.sqrt(off) <= threshold) break;
    }
  }
  const order = Array.from({ length: n }, (_, index) => index).sort((left, right) => a[right][right] - a[left][left] || left - right);
  const values = order.map((index) => a[index][index]);
  const vectors = order.map((index) => {
    const column = v.map((row) => row[index]);
    let anchor = 0;
    for (let k = 1; k < n; k += 1) if (Math.abs(column[k]) > Math.abs(column[anchor])) anchor = k;
    return column[anchor] < 0 ? column.map((value) => -value) : column;
  });
  return { values, vectors, sweeps };
}

function eigenvectorMatrix(decomposition, count) {
  const n = decomposition.vectors[0].length;
  return Array.from({ length: n }, (_, row) => Array.from({ length: count }, (_, column) => decomposition.vectors[column][row]));
}

/** Symmetric square root / inverse square root via eigendecomposition (positive definite input). */
function symmetricPower(matrix, power, budget) {
  const decomposition = symmetricEigen(matrix, budget);
  const n = matrix.length;
  const out = zeros(n, n);
  for (let k = 0; k < n; k += 1) {
    const value = decomposition.values[k];
    if (!(value > 0)) return null;
    const scaled = Math.pow(value, power);
    const vector = decomposition.vectors[k];
    for (let row = 0; row < n; row += 1) for (let column = 0; column < n; column += 1) out[row][column] += scaled * vector[row] * vector[column];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Data-shaping helpers shared by matrix-valued methods.
// ---------------------------------------------------------------------------------------------

function parseVariableMatrix(data, H, { minRows = 3, minVariables = 2, maxVariables = 32, maxRows = 10_000, path = "data.variables", allowConstant = false } = {}) {
  const raw = data.variables;
  if (!Array.isArray(raw) || raw.length < minVariables || raw.length > maxVariables) {
    H.fail("STAT_INVALID_INPUT", `${path} length must be between ${minVariables} and ${maxVariables}`);
  }
  const names = new Set();
  let rowCount = null;
  const variables = raw.map((rawVariable, index) => {
    const variable = H.assertObject(rawVariable, `${path}[${index}]`);
    H.assertKeys(variable, ["name", "values"], `${path}[${index}]`);
    const name = H.label(variable.name, `Variable ${index + 1}`, `${path}[${index}].name`);
    if (names.has(name)) H.fail("STAT_INVALID_INPUT", `duplicate variable name: ${name}`);
    names.add(name);
    const values = H.numericVector(variable.values, `${path}[${index}].values`, minRows);
    if (values.length > maxRows) H.fail("STAT_LIMIT_EXCEEDED", `${path}[${index}].values exceeds ${maxRows} rows`);
    if (rowCount === null) rowCount = values.length;
    if (values.length !== rowCount) H.fail("STAT_INVALID_INPUT", "all variables must have equal row counts");
    if (!allowConstant && H.minMax(values).min === H.minMax(values).max) H.fail("STAT_DEGENERATE", `variable ${name} is constant`);
    return { name, values };
  });
  if (rowCount * variables.length > H.LIMITS.maxTotalValues) H.fail("STAT_LIMIT_EXCEEDED", `matrix exceeds ${H.LIMITS.maxTotalValues} values`);
  let rowLabels;
  if (data.rowLabels === undefined) rowLabels = Array.from({ length: rowCount }, (_, index) => `Row ${index + 1}`);
  else {
    if (!Array.isArray(data.rowLabels) || data.rowLabels.length !== rowCount) H.fail("STAT_INVALID_INPUT", "data.rowLabels length must match the variable rows");
    rowLabels = data.rowLabels.map((item, index) => H.label(item, `Row ${index + 1}`, `data.rowLabels[${index}]`));
    if (new Set(rowLabels).size !== rowLabels.length) H.fail("STAT_INVALID_INPUT", "data.rowLabels must be unique");
  }
  return { variables, rowCount, rowLabels };
}

function columnsToRows(columns) {
  const n = columns[0].length;
  return Array.from({ length: n }, (_, row) => columns.map((column) => column[row]));
}

function columnMeans(columns) {
  return columns.map((column) => column.reduce((total, value) => total + value, 0) / column.length);
}

function centerColumns(columns) {
  const means = columnMeans(columns);
  return { means, centered: columns.map((column, index) => column.map((value) => value - means[index])) };
}

function sampleCovariance(columns, budget) {
  const { centered } = centerColumns(columns);
  const n = columns[0].length;
  const p = columns.length;
  const matrix = zeros(p, p);
  for (let row = 0; row < p; row += 1) {
    for (let column = row; column < p; column += 1) {
      let value = 0;
      for (let index = 0; index < n; index += 1) value += centered[row][index] * centered[column][index];
      if (budget) budget.check(n);
      value /= n - 1;
      matrix[row][column] = value;
      matrix[column][row] = value;
    }
  }
  return matrix;
}

function correlationFromCovariance(covariance) {
  const p = covariance.length;
  return covariance.map((row, i) => row.map((value, j) => value / Math.sqrt(covariance[i][i] * covariance[j][j])));
}

function standardizeColumns(columns) {
  return columns.map((column) => {
    const meanValue = column.reduce((total, value) => total + value, 0) / column.length;
    const variance = column.reduce((total, value) => total + (value - meanValue) ** 2, 0) / (column.length - 1);
    const sd = Math.sqrt(variance);
    return column.map((value) => (value - meanValue) / sd);
  });
}

function euclideanDistance(a, b) {
  let total = 0;
  for (let index = 0; index < a.length; index += 1) total += (a[index] - b[index]) ** 2;
  return Math.sqrt(total);
}

function distanceMatrix(rows, metric, budget) {
  const n = rows.length;
  const matrix = zeros(n, n);
  const normalized = metric === "correlation" ? rows.map((row) => {
    const meanValue = row.reduce((total, value) => total + value, 0) / row.length;
    const centered = row.map((value) => value - meanValue);
    const norm = Math.sqrt(centered.reduce((total, value) => total + value * value, 0));
    return { centered, norm };
  }) : null;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (budget) budget.check(rows[0].length);
      let value;
      if (metric === "correlation") {
        const left = normalized[i];
        const right = normalized[j];
        if (!(left.norm > 0) || !(right.norm > 0)) return null;
        let dot = 0;
        for (let k = 0; k < left.centered.length; k += 1) dot += left.centered[k] * right.centered[k];
        value = 1 - dot / (left.norm * right.norm);
        if (value < 0) value = 0;
      } else value = euclideanDistance(rows[i], rows[j]);
      matrix[i][j] = value;
      matrix[j][i] = value;
    }
  }
  return matrix;
}

/** Kaiser-Meyer-Olkin and Bartlett sphericity from a correlation matrix. */
function samplingAdequacy(correlation, sampleSize) {
  const p = correlation.length;
  const inv = inverse(correlation);
  let bartlett = { name: "Bartlett sphericity", status: "not_evaluated", reason: "correlation matrix is singular" };
  const determinant = logAbsDeterminant(correlation);
  if (determinant.sign > 0 && Number.isFinite(determinant.logAbs)) {
    const statistic = Math.max(0, -(sampleSize - 1 - (2 * p + 5) / 6) * determinant.logAbs);
    const df = p * (p - 1) / 2;
    bartlett = { name: "Bartlett sphericity", status: "evaluated", statistic, df, pValue: chiSquareSurvival(statistic, df), method: "large-sample chi-square approximation" };
  }
  if (!inv) return { bartlett, kmo: { name: "Kaiser-Meyer-Olkin", status: "not_evaluated", reason: "correlation matrix is singular" } };
  let correlationSquares = 0;
  let partialSquares = 0;
  const perVariable = [];
  for (let row = 0; row < p; row += 1) {
    let rowR = 0;
    let rowP = 0;
    for (let column = 0; column < p; column += 1) {
      if (row === column) continue;
      const r2 = correlation[row][column] ** 2;
      const partial = -inv[row][column] / Math.sqrt(inv[row][row] * inv[column][column]);
      rowR += r2;
      rowP += partial * partial;
      if (column > row) {
        correlationSquares += r2;
        partialSquares += partial * partial;
      }
    }
    perVariable.push(rowR + rowP > 1e-15 ? rowR / (rowR + rowP) : null);
  }
  if (!(correlationSquares + partialSquares > 1e-15)) {
    return { bartlett, kmo: { name: "Kaiser-Meyer-Olkin", status: "not_evaluated", reason: "variables have no measurable shared correlation" } };
  }
  return { bartlett, kmo: { name: "Kaiser-Meyer-Olkin", status: "evaluated", overall: correlationSquares / (correlationSquares + partialSquares), perVariable, method: "squared-correlation to squared-partial-correlation ratio" } };
}

function seedOption(H, defaultSeed = 20260901) {
  return {
    schema: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    default: defaultSeed,
    parse(value, helpers, path) { return helpers.integer(value, 0, Number.MAX_SAFE_INTEGER, path); },
  };
}

function round(value, digits = 12) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function finiteOrFail(H, value, message) {
  if (typeof value !== "number" || !Number.isFinite(value)) H.fail("STAT_NUMERIC_FAILURE", message);
  return Object.is(value, -0) ? 0 : value;
}

module.exports = {
  createRng,
  logGamma, digamma, trigamma, gammaP, gammaQ, regularizedBeta, logBeta, erfc,
  normalCdf, normalSurvival, normalLogPdf, normalQuantile, tCdf, tLogPdf, tQuantile,
  chiSquareCdf, chiSquareSurvival, chiSquareQuantile, fCdf, fSurvival, fQuantile,
  gammaQuantile, betaQuantile, invertMonotone, bracketUpper, kolmogorovSurvival,
  nelderMead, brentMinimize, bisectionRoot, lbfgs,
  zeros, identity, transpose, multiply, multiplyVector, cholesky, choleskySolve, choleskyInverse, choleskyLogDeterminant,
  inverse, logAbsDeterminant, symmetricEigen, eigenvectorMatrix, symmetricPower,
  parseVariableMatrix, columnsToRows, columnMeans, centerColumns, sampleCovariance, correlationFromCovariance, standardizeColumns,
  euclideanDistance, distanceMatrix, samplingAdequacy, seedOption, round, finiteOrFail,
};
