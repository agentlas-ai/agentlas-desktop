"use strict";

/**
 * Non-central t, chi-square, and F distribution functions plus high-precision normal / quantile helpers.
 *
 * The core engine only ships central distributions, so the power-analysis family carries these here.
 * Every function is pure, deterministic, and receives the engine helper object `H` (for logGamma,
 * regularizedBeta, gammaQ, tCdf, pFromF, fail) so this file never requires engine.cjs.
 *
 * Algorithms
 *  - nctCdf: Lenth (1989) AS 243 series (as in R's pnt.c), errmax 1e-12, itrmax 1000; for
 *    delta^2 > 2 ln2 * 1021 (|delta| > ~37.6) the Abramowitz-Stegun 26.7.10 normal approximation is used.
 *  - ncx2Sf / ncx2Cdf: Poisson-weighted mixture of central chi-square survival functions with the
 *    upward recurrence Q(a+1, y) = Q(a, y) + y^a e^-y / Gamma(a+1) (Ding 1992 / AS 275 form, evaluated on
 *    the survival side so every term is positive and no cancellation occurs).
 *  - ncfSf / ncfCdf: Poisson-weighted mixture of central incomplete-beta survival functions with the
 *    upward recurrence 1 - I_z(a+1, b) = 1 - I_z(a, b) + z^a (1-z)^b / (a B(a, b)).
 *  - nctPdf: closed-form density with two 1F1 confluent hypergeometric series (log-space, positive terms).
 */

const LN_SQRT_PI = 0.5 * Math.log(Math.PI);
const LN2 = Math.log(2);

function normalCdfPrecise(H, x) {
  if (!Number.isFinite(x)) return x < 0 ? 0 : 1;
  if (x === 0) return 0.5;
  const halfTail = 0.5 * H.gammaQ(0.5, x * x / 2);
  return x > 0 ? 1 - halfTail : halfTail;
}

function normalPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function normalQuantilePrecise(H, p) {
  if (!(p > 0 && p < 1)) H.fail("STAT_INVALID_INPUT", "normal quantile probability must be strictly inside (0, 1)");
  let x = H.normalInv(p);
  for (let i = 0; i < 3; i += 1) {
    const error = normalCdfPrecise(H, x) - p;
    const density = normalPdf(x);
    if (density < 1e-300) break;
    const step = error / density;
    x -= step;
    if (Math.abs(step) < 1e-15) break;
  }
  return x;
}

function bisectQuantile(cdf, p, lower, upper, iterations = 200) {
  let low = lower;
  let high = upper;
  for (let i = 0; i < iterations; i += 1) {
    const mid = 0.5 * (low + high);
    if (mid === low || mid === high) break;
    if (cdf(mid) < p) low = mid;
    else high = mid;
  }
  return 0.5 * (low + high);
}

function tQuantile(H, p, df) {
  if (!(p > 0 && p < 1)) H.fail("STAT_INVALID_INPUT", "t quantile probability must be strictly inside (0, 1)");
  if (p === 0.5) return 0;
  if (p < 0.5) return -tQuantile(H, 1 - p, df);
  let high = 1;
  while (H.tCdf(high, df) < p && high < 1e12) high *= 2;
  return bisectQuantile((value) => H.tCdf(value, df), p, 0, high);
}

function chiSquareCdf(H, x, df) {
  if (x <= 0) return 0;
  return 1 - H.gammaQ(df / 2, x / 2);
}

function chiSquareQuantile(H, p, df) {
  if (!(p > 0 && p < 1)) H.fail("STAT_INVALID_INPUT", "chi-square quantile probability must be strictly inside (0, 1)");
  let high = Math.max(1, df);
  while (chiSquareCdf(H, high, df) < p && high < 1e12) high *= 2;
  return bisectQuantile((value) => chiSquareCdf(H, value, df), p, 0, high);
}

function fCdf(H, x, df1, df2) {
  if (x <= 0) return 0;
  return 1 - H.pFromF(x, df1, df2);
}

function fQuantile(H, p, df1, df2) {
  if (!(p > 0 && p < 1)) H.fail("STAT_INVALID_INPUT", "F quantile probability must be strictly inside (0, 1)");
  let high = 1;
  while (fCdf(H, high, df1, df2) < p && high < 1e12) high *= 2;
  return bisectQuantile((value) => fCdf(H, value, df1, df2), p, 0, high);
}

/** Lenth (1989) AS 243 non-central t CDF. */
function nctCdf(H, t, df, delta) {
  if (!(df > 0)) H.fail("STAT_INVALID_INPUT", "non-central t requires positive degrees of freedom");
  if (!Number.isFinite(t)) return t < 0 ? 0 : 1;
  if (delta === 0) return H.tCdf(t, df);
  let tt = t;
  let del = delta;
  let negdel = false;
  if (t < 0) {
    negdel = true;
    tt = -t;
    del = -delta;
  }
  if (df > 4e5 || del * del > 2 * LN2 * 1021) {
    // Abramowitz & Stegun 26.7.10 normal approximation
    const s = 1 / (4 * df);
    const z = (tt * (1 - s) - del) / Math.sqrt(1 + tt * tt * 2 * s);
    const value = normalCdfPrecise(H, z);
    return negdel ? 1 - value : value;
  }
  const x = tt * tt / (tt * tt + df);
  let tnc;
  if (x > 0) {
    const lambda = del * del;
    let p = 0.5 * Math.exp(-0.5 * lambda);
    let q = Math.sqrt(2 / Math.PI) * p * del;
    let s = 0.5 - p;
    if (s < 1e-7) s = -0.5 * Math.expm1(-0.5 * lambda);
    let a = 0.5;
    const b = 0.5 * df;
    const rxb = Math.pow(1 - x, b);
    const albeta = LN_SQRT_PI + H.logGamma(b) - H.logGamma(0.5 + b);
    let xodd = H.regularizedBeta(x, a, b);
    let godd = 2 * rxb * Math.exp(a * Math.log(x) - albeta);
    let tnc0 = b * x;
    let xeven = tnc0 < Number.EPSILON ? tnc0 : 1 - rxb;
    let geven = tnc0 * rxb;
    tnc = p * xodd + q * xeven;
    for (let it = 1; it <= 1000; it += 1) {
      a += 1;
      xodd -= godd;
      xeven -= geven;
      godd *= x * (a + b - 1) / a;
      geven *= x * (a + b - 0.5) / (a + 0.5);
      p *= lambda / (2 * it);
      q *= lambda / (2 * it + 1);
      tnc += p * xodd + q * xeven;
      s -= p;
      if (s < -1e-10) break;
      if (s <= 0 && it > 1) break;
      const errbd = 2 * s * (xodd - godd);
      if (Math.abs(errbd) < 1e-12) break;
    }
    tnc += normalCdfPrecise(H, -del);
  } else tnc = normalCdfPrecise(H, -del);
  if (negdel) tnc = 1 - tnc;
  return Math.min(1, Math.max(0, tnc));
}

function nctSf(H, t, df, delta) {
  // survival on the mirrored side keeps precision in the upper tail
  return nctCdf(H, -t, df, -delta);
}

/** Confluent hypergeometric 1F1(a; b; z) for z >= 0 as a positive-term series in log space. */
function log1F1(a, b, z) {
  if (z === 0) return 0;
  let logTerm = 0;
  let maxLog = 0;
  const logs = [0];
  for (let k = 0; k < 20000; k += 1) {
    logTerm += Math.log((a + k) * z / ((b + k) * (k + 1)));
    logs.push(logTerm);
    if (logTerm > maxLog) maxLog = logTerm;
    if (k > z && logTerm < maxLog - 40) break;
  }
  let total = 0;
  for (const value of logs) total += Math.exp(value - maxLog);
  return maxLog + Math.log(total);
}

/**
 * Non-central t density from the integral representation
 *   f(t) = nu^(nu/2) e^(-mu^2/2) / (sqrt(pi) Gamma(nu/2) (t^2+nu)^((nu+1)/2))
 *          * [ Gamma((nu+1)/2) 1F1((nu+1)/2; 1/2; z) + sqrt(2) c Gamma(nu/2+1) 1F1(nu/2+1; 3/2; z) ]
 * with c = mu t / sqrt(t^2 + nu) and z = c^2 / 2. Reduces to the central t density when mu = 0.
 */
function nctPdf(H, t, df, delta) {
  const nu = df;
  const mu = delta;
  const s = nu + t * t;
  const c = mu * t / Math.sqrt(s);
  const z = c * c / 2;
  const logFront = (nu / 2) * Math.log(nu) - mu * mu / 2 - 0.5 * Math.log(Math.PI) - H.logGamma(nu / 2) - ((nu + 1) / 2) * Math.log(s);
  const logA = H.logGamma((nu + 1) / 2) + log1F1((nu + 1) / 2, 0.5, z);
  const logB = c === 0 ? -Infinity : 0.5 * LN2 + Math.log(Math.abs(c)) + H.logGamma(nu / 2 + 1) + log1F1(nu / 2 + 1, 1.5, z);
  const maxLog = Math.max(logA, logB);
  const inner = Math.exp(logA - maxLog) + (c === 0 ? 0 : Math.sign(c) * Math.exp(logB - maxLog));
  if (!(inner > 0)) return 0;
  return Math.exp(logFront + maxLog + Math.log(inner));
}

function poissonWeightedSurvival(H, lambdaHalf, survivalAt, incrementLog, tailLimit) {
  // sum_i w_i S_i with S_{i+1} = S_i + exp(incrementLog(i)); w_i = Poisson(i; lambdaHalf).
  // The sum starts 12 standard deviations below the Poisson mode so large lambda never exhausts the loop.
  const start = Math.max(0, Math.floor(lambdaHalf - 12 * Math.sqrt(lambdaHalf) - 5));
  let survival = survivalAt(start);
  let cumulativeWeight = 0;
  let total = 0;
  const logLambda = Math.log(lambdaHalf);
  for (let i = start; i < start + 400000; i += 1) {
    const logWeight = -lambdaHalf + i * logLambda - H.logGamma(i + 1);
    const weight = Math.exp(logWeight);
    cumulativeWeight += weight;
    total += weight * survival;
    if (i > lambdaHalf && 1 - cumulativeWeight < tailLimit) break;
    survival = Math.min(1, survival + Math.exp(incrementLog(i)));
  }
  return Math.min(1, Math.max(0, total));
}

function ncx2Sf(H, x, df, lambda) {
  if (!(df > 0) || !(lambda >= 0)) H.fail("STAT_INVALID_INPUT", "non-central chi-square requires df > 0 and lambda >= 0");
  if (x <= 0) return 1;
  if (lambda === 0) return H.gammaQ(df / 2, x / 2);
  const y = x / 2;
  const a0 = df / 2;
  const logY = Math.log(y);
  return poissonWeightedSurvival(H, lambda / 2, (i) => H.gammaQ(a0 + i, y), (i) => -y + (a0 + i) * logY - H.logGamma(a0 + i + 1), 1e-16);
}

function ncx2Cdf(H, x, df, lambda) {
  return 1 - ncx2Sf(H, x, df, lambda);
}

function ncfSf(H, f, df1, df2, lambda) {
  if (!(df1 > 0) || !(df2 > 0) || !(lambda >= 0)) H.fail("STAT_INVALID_INPUT", "non-central F requires positive df and lambda >= 0");
  if (f <= 0) return 1;
  if (lambda === 0) return H.pFromF(f, df1, df2);
  const z = df1 * f / (df1 * f + df2);
  const a0 = df1 / 2;
  const b = df2 / 2;
  const logZ = Math.log(z);
  const log1mZ = Math.log1p(-z);
  return poissonWeightedSurvival(H, lambda / 2, (i) => 1 - H.regularizedBeta(z, a0 + i, b), (i) => {
    const a = a0 + i;
    return a * logZ + b * log1mZ - Math.log(a) - (H.logGamma(a) + H.logGamma(b) - H.logGamma(a + b));
  }, 1e-16);
}

function ncfCdf(H, f, df1, df2, lambda) {
  return 1 - ncfSf(H, f, df1, df2, lambda);
}

module.exports = {
  normalCdfPrecise,
  normalPdf,
  normalQuantilePrecise,
  tQuantile,
  chiSquareCdf,
  chiSquareQuantile,
  fCdf,
  fQuantile,
  nctCdf,
  nctSf,
  nctPdf,
  ncx2Sf,
  ncx2Cdf,
  ncfSf,
  ncfCdf,
  bisectQuantile,
};
