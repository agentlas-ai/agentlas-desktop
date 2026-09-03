"use strict";

// Deterministic numerical kernels shared by the Earth Science analyses.
// Every routine is pure, dependency-free, and documented with its source so a
// reviewer can trace each number. Nothing here touches the network or clock.

function core() {
  // Lazy to avoid a require cycle: earth-science.cjs re-exports the analyses.
  return require("./earth-science.cjs");
}

function fail(code, message = code, details = null) {
  const { EarthScienceError } = core();
  return new EarthScienceError(code, message, details);
}

// ---------------------------------------------------------------------------
// Special functions
// ---------------------------------------------------------------------------

// Lanczos approximation (g = 607/128, n = 15), Godfrey 2001; |rel err| < 1e-15.
const LANCZOS_G = 607 / 128;
const LANCZOS_COEFFICIENTS = [
  0.99999999999999709182, 57.156235665862923517, -59.597960355475491248, 14.136097974741747174,
  -0.49191381609762019978, 0.33994649984811888699e-4, 0.46523628927048575665e-4, -0.98374475304879564677e-4,
  0.15808870322491248884e-3, -0.21026444172410488319e-3, 0.21743961811521264320e-3, -0.16431810653676389022e-3,
  0.84418223983852743293e-4, -0.26190838401581408670e-4, 0.36899182659531622704e-5,
];

function lnGamma(x) {
  if (!(x > 0)) throw fail("earth-numeric-lngamma-domain", "lnGamma requires x > 0", { x });
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const shifted = x - 1;
  let sum = LANCZOS_COEFFICIENTS[0];
  for (let index = 1; index < LANCZOS_COEFFICIENTS.length; index += 1) sum += LANCZOS_COEFFICIENTS[index] / (shifted + index);
  const t = shifted + LANCZOS_G + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum);
}

function gammaFunction(x) {
  if (x > 0) return Math.exp(lnGamma(x));
  if (Number.isInteger(x)) throw fail("earth-numeric-gamma-pole", "Gamma function pole", { x });
  return Math.PI / (Math.sin(Math.PI * x) * Math.exp(lnGamma(1 - x)));
}

// Regularized lower incomplete gamma P(a, x) (Numerical Recipes gser/gcf).
function regularizedGammaP(a, x) {
  if (!(a > 0) || !(x >= 0)) throw fail("earth-numeric-gamma-domain", "P(a,x) requires a > 0 and x >= 0", { a, x });
  if (x === 0) return 0;
  if (x < a + 1) {
    let term = 1 / a;
    let sum = term;
    for (let n = 1; n < 10_000; n += 1) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-16) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
  }
  return 1 - regularizedGammaQ(a, x);
}

function regularizedGammaQ(a, x) {
  if (!(a > 0) || !(x >= 0)) throw fail("earth-numeric-gamma-domain", "Q(a,x) requires a > 0 and x >= 0", { a, x });
  if (x < a + 1) return 1 - regularizedGammaP(a, x);
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 10_000; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

function erfc(x) {
  if (x === 0) return 1;
  const tail = regularizedGammaQ(0.5, x * x);
  return x > 0 ? tail : 2 - tail;
}

function normalCdf(z) {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  return 0.5 * erfc(-z / Math.SQRT2);
}

function normalSf(z) {
  return normalCdf(-z);
}

// Acklam's rational approximation refined by one Halley step against normalCdf.
function normalQuantile(p) {
  if (!(p > 0 && p < 1)) throw fail("earth-numeric-normal-quantile-domain", "quantile requires 0 < p < 1", { p });
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  let x;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - low) {
    const q = p - 0.5;
    const r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  for (let step = 0; step < 2; step += 1) {
    const error = normalCdf(x) - p;
    const density = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
    if (density === 0) break;
    const u = error / density;
    x -= u / (1 + x * u / 2);
  }
  return x;
}

// Regularized incomplete beta I_x(a, b) via Lentz continued fraction (NR betacf).
function regularizedBeta(x, a, b) {
  if (!(a > 0) || !(b > 0) || !(x >= 0 && x <= 1)) throw fail("earth-numeric-beta-domain", "I_x(a,b) domain", { x, a, b });
  if (x === 0) return 0;
  if (x === 1) return 1;
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  const continued = (xx, aa, bb) => {
    const tiny = 1e-300;
    const qab = aa + bb;
    const qap = aa + 1;
    const qam = aa - 1;
    let c = 1;
    let d = 1 - qab * xx / qap;
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;
    let h = d;
    for (let m = 1; m < 10_000; m += 1) {
      const m2 = 2 * m;
      let aa2 = m * (bb - m) * xx / ((qam + m2) * (aa + m2));
      d = 1 + aa2 * d;
      if (Math.abs(d) < tiny) d = tiny;
      c = 1 + aa2 / c;
      if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d;
      h *= d * c;
      aa2 = -(aa + m) * (qab + m) * xx / ((aa + m2) * (qap + m2));
      d = 1 + aa2 * d;
      if (Math.abs(d) < tiny) d = tiny;
      c = 1 + aa2 / c;
      if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d;
      const delta = d * c;
      h *= delta;
      if (Math.abs(delta - 1) < 1e-16) break;
    }
    return h;
  };
  if (x < (a + 1) / (a + b + 2)) return front * continued(x, a, b) / a;
  return 1 - front * continued(1 - x, b, a) / b;
}

function studentTCdf(t, df) {
  if (!(df > 0)) throw fail("earth-numeric-t-domain", "Student t requires df > 0", { df });
  const x = df / (df + t * t);
  const tail = 0.5 * regularizedBeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

function studentTQuantile(p, df) {
  if (!(p > 0 && p < 1)) throw fail("earth-numeric-t-quantile-domain", "t quantile requires 0 < p < 1", { p, df });
  let lower = -1e3;
  let upper = 1e3;
  let mid = normalQuantile(p);
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const value = studentTCdf(mid, df);
    if (Math.abs(value - p) < 1e-14) break;
    if (value < p) lower = mid; else upper = mid;
    mid = (lower + upper) / 2;
  }
  return mid;
}

function chiSquareSf(x, df) {
  if (!(df > 0)) throw fail("earth-numeric-chi-square-domain", "chi-square requires df > 0", { df });
  if (!(x >= 0)) return 1;
  return regularizedGammaQ(df / 2, x / 2);
}

function poissonQuantile(p, lambda) {
  if (!(p >= 0 && p < 1) || !(lambda >= 0)) throw fail("earth-numeric-poisson-domain", "Poisson quantile domain", { p, lambda });
  if (lambda === 0) return 0;
  let k = 0;
  let term = Math.exp(-lambda);
  let cumulative = term;
  while (cumulative < p && k < 10_000_000) {
    k += 1;
    term *= lambda / k;
    cumulative += term;
  }
  return k;
}

// ---------------------------------------------------------------------------
// Linear algebra: Householder QR least squares with covariance
// ---------------------------------------------------------------------------

function leastSquares(design, response) {
  const n = design.length;
  if (n < 1 || !Array.isArray(design[0])) throw fail("earth-numeric-least-squares-input", "design matrix required");
  const p = design[0].length;
  if (p < 1 || n < p || response.length !== n) throw fail("earth-numeric-least-squares-shape", "least squares requires n >= p", { n, p });
  const a = design.map((row) => {
    if (row.length !== p) throw fail("earth-numeric-least-squares-shape", "ragged design matrix");
    return row.slice();
  });
  const y = response.slice();
  // Householder reflections (Golub & Van Loan, Algorithm 5.2.1)
  for (let k = 0; k < p; k += 1) {
    let norm = 0;
    for (let i = k; i < n; i += 1) norm += a[i][k] * a[i][k];
    norm = Math.sqrt(norm);
    if (norm === 0) throw fail("earth-numeric-least-squares-singular", "design matrix is rank deficient", { column: k });
    const alpha = a[k][k] > 0 ? -norm : norm;
    const v = new Array(n - k).fill(0);
    v[0] = a[k][k] - alpha;
    for (let i = k + 1; i < n; i += 1) v[i - k] = a[i][k];
    let vNorm = 0;
    for (const item of v) vNorm += item * item;
    if (vNorm === 0) continue;
    for (let j = k; j < p; j += 1) {
      let dot = 0;
      for (let i = k; i < n; i += 1) dot += v[i - k] * a[i][j];
      const factor = 2 * dot / vNorm;
      for (let i = k; i < n; i += 1) a[i][j] -= factor * v[i - k];
    }
    let dotY = 0;
    for (let i = k; i < n; i += 1) dotY += v[i - k] * y[i];
    const factorY = 2 * dotY / vNorm;
    for (let i = k; i < n; i += 1) y[i] -= factorY * v[i - k];
  }
  const beta = new Array(p).fill(0);
  for (let i = p - 1; i >= 0; i -= 1) {
    let sum = y[i];
    for (let j = i + 1; j < p; j += 1) sum -= a[i][j] * beta[j];
    if (Math.abs(a[i][i]) < 1e-300) throw fail("earth-numeric-least-squares-singular", "design matrix is rank deficient", { column: i });
    beta[i] = sum / a[i][i];
  }
  // (R^T R)^{-1} = R^{-1} R^{-T}
  const rInverse = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let col = 0; col < p; col += 1) {
    for (let i = p - 1; i >= 0; i -= 1) {
      let sum = i === col ? 1 : 0;
      for (let j = i + 1; j < p; j += 1) sum -= a[i][j] * rInverse[j][col];
      rInverse[i][col] = sum / a[i][i];
    }
  }
  const unscaledCovariance = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (__, j) => {
    let sum = 0;
    for (let k = 0; k < p; k += 1) sum += rInverse[i][k] * rInverse[j][k];
    return sum;
  }));
  const fitted = design.map((row) => row.reduce((sum, value, index) => sum + value * beta[index], 0));
  const residuals = response.map((value, index) => value - fitted[index]);
  const rss = residuals.reduce((sum, value) => sum + value * value, 0);
  const degreesOfFreedom = n - p;
  const sigma2 = degreesOfFreedom > 0 ? rss / degreesOfFreedom : NaN;
  const covariance = unscaledCovariance.map((row) => row.map((value) => value * sigma2));
  return { beta, fitted, residuals, rss, degreesOfFreedom, sigma2, covariance, unscaledCovariance };
}

// ---------------------------------------------------------------------------
// Descriptive helpers
// ---------------------------------------------------------------------------

function sum(values) {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function mean(values) {
  if (!values.length) throw fail("earth-numeric-empty-sample");
  return sum(values) / values.length;
}

function sampleVariance(values) {
  if (values.length < 2) throw fail("earth-numeric-variance-sample", "variance needs n >= 2");
  const m = mean(values);
  return sum(values.map((value) => (value - m) ** 2)) / (values.length - 1);
}

function sortedCopy(values) {
  return values.slice().sort((left, right) => left - right);
}

function median(values) {
  const sorted = sortedCopy(values);
  const n = sorted.length;
  if (!n) throw fail("earth-numeric-empty-sample");
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

// Average ranks with ties (1-based).
function ranks(values) {
  const order = values.map((value, index) => ({ value, index })).sort((left, right) => left.value - right.value || left.index - right.index);
  const output = new Array(values.length).fill(0);
  let position = 0;
  while (position < order.length) {
    let end = position;
    while (end + 1 < order.length && order[end + 1].value === order[position].value) end += 1;
    const rank = (position + end) / 2 + 1;
    for (let cursor = position; cursor <= end; cursor += 1) output[order[cursor].index] = rank;
    position = end + 1;
  }
  return output;
}

function rounded(value, digits = 12) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) throw fail("earth-numeric-non-finite", "non-finite value cannot be reported", { value: String(value) });
  const factor = 10 ** digits;
  const result = Math.round((value + Number.EPSILON) * factor) / factor;
  return Object.is(result, -0) ? 0 : result;
}

function sha256Json(value) {
  const { sha256, stableStringify } = core();
  return sha256(stableStringify(value));
}

module.exports = {
  chiSquareSf,
  erfc,
  fail,
  gammaFunction,
  leastSquares,
  lnGamma,
  mean,
  median,
  normalCdf,
  normalQuantile,
  normalSf,
  poissonQuantile,
  ranks,
  regularizedBeta,
  regularizedGammaP,
  regularizedGammaQ,
  rounded,
  sampleVariance,
  sha256Json,
  sortedCopy,
  studentTCdf,
  studentTQuantile,
  sum,
};
