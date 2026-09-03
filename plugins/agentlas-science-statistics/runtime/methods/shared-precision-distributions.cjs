"use strict";

/**
 * Shared deterministic numeric support for the anova-extended, assumption-tests and
 * equivalence method modules. Pure JavaScript, no Date/Math.random, no filesystem.
 *
 * Everything that needs engine helpers (incomplete beta, gamma tails, fail codes)
 * is created through `createSupport(H)` so this file never requires engine.cjs.
 */

const SQRT_2PI_INV = 0.3989422804014327;

// Cody (1993) rational Chebyshev approximation of the normal CDF (as used by R's pnorm).
const CODY_A = [2.2352520354606839287, 161.02823106855587881, 1067.6894854603709582, 18154.981253343561249, 0.065682337918207449113];
const CODY_B = [47.20258190468824187, 976.09855173777669322, 10260.932208618978205, 45507.789335026729956];
const CODY_C = [0.39894151208813466764, 8.8831497943883759412, 93.506656132177855979, 597.27027639480026226, 2494.5375852903726711, 6848.1904505362823326, 11602.651437647350124, 9842.7148383839780218, 1.0765576773720192317e-8];
const CODY_D = [22.266688044328115691, 235.38790178262499861, 1519.377599407554805, 6485.558298266760755, 18615.571640885098091, 34900.952721145977266, 38912.003286093271411, 19685.429676859990727];
const CODY_P = [0.21589853405795699, 0.1274011611602473639, 0.022235277870649807, 0.001421619193227893466, 2.9112874951168792e-5, 0.02307344176494017303];
const CODY_Q = [1.28426009614491121, 0.468238212480865118, 0.0659881378689285515, 0.00378239633202758244, 7.29751555083966205e-5];

function pnormBoth(x) {
  const y = Math.abs(x);
  let cum;
  let ccum;
  if (y <= 0.67448975) {
    let xnum = 0;
    let xden = 0;
    if (y > 1.1102230246251565e-16) {
      const xsq = x * x;
      xnum = CODY_A[4] * xsq;
      xden = xsq;
      for (let i = 0; i < 3; i += 1) {
        xnum = (xnum + CODY_A[i]) * xsq;
        xden = (xden + CODY_B[i]) * xsq;
      }
    }
    const temp = x * (xnum + CODY_A[3]) / (xden + CODY_B[3]);
    cum = 0.5 + temp;
    ccum = 0.5 - temp;
  } else if (y <= Math.sqrt(32)) {
    let xnum = CODY_C[8] * y;
    let xden = y;
    for (let i = 0; i < 7; i += 1) {
      xnum = (xnum + CODY_C[i]) * y;
      xden = (xden + CODY_D[i]) * y;
    }
    const temp = (xnum + CODY_C[7]) / (xden + CODY_D[7]);
    const xsq = Math.trunc(y * 16) / 16;
    const del = (y - xsq) * (y + xsq);
    cum = Math.exp(-xsq * xsq * 0.5) * Math.exp(-del * 0.5) * temp;
    ccum = 1 - cum;
    if (x > 0) [cum, ccum] = [ccum, cum];
  } else if (y < 50) {
    const xsq = 1 / (x * x);
    let xnum = CODY_P[5] * xsq;
    let xden = xsq;
    for (let i = 0; i < 4; i += 1) {
      xnum = (xnum + CODY_P[i]) * xsq;
      xden = (xden + CODY_Q[i]) * xsq;
    }
    let temp = xsq * (xnum + CODY_P[4]) / (xden + CODY_Q[4]);
    temp = (SQRT_2PI_INV - temp) / y;
    const xsqTrunc = Math.trunc(x * 16) / 16;
    const del = (x - xsqTrunc) * (x + xsqTrunc);
    cum = Math.exp(-xsqTrunc * xsqTrunc * 0.5) * Math.exp(-del * 0.5) * temp;
    ccum = 1 - cum;
    if (x > 0) [cum, ccum] = [ccum, cum];
  } else {
    cum = x > 0 ? 1 : 0;
    ccum = 1 - cum;
  }
  return { lower: Math.min(1, Math.max(0, cum)), upper: Math.min(1, Math.max(0, ccum)) };
}

function pnorm(x) {
  return pnormBoth(x).lower;
}

function pnormUpper(x) {
  return pnormBoth(x).upper;
}

function dnorm(x) {
  return SQRT_2PI_INV * Math.exp(-0.5 * x * x);
}

// Acklam initial guess refined by two Newton steps on the Cody CDF (full double precision).
function qnorm(p) {
  if (!(p > 0 && p < 1)) throw new Error("qnorm probability out of range");
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  let x;
  if (p < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p > 1 - 0.02425) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else {
    const q = p - 0.5;
    const r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  for (let step = 0; step < 2; step += 1) {
    const both = pnormBoth(x);
    const error = p < 0.5 ? both.lower - p : (1 - p) - both.upper;
    const density = dnorm(x);
    if (density < 1e-300) break;
    x -= error / density;
  }
  return x;
}

const GAUSS_LEGENDRE_CACHE = new Map();

/** Gauss-Legendre nodes/weights on [-1, 1] via Newton iteration (deterministic). */
function gaussLegendre(n) {
  if (GAUSS_LEGENDRE_CACHE.has(n)) return GAUSS_LEGENDRE_CACHE.get(n);
  const nodes = Array(n).fill(0);
  const weights = Array(n).fill(0);
  const m = Math.floor((n + 1) / 2);
  for (let i = 0; i < m; i += 1) {
    let z = Math.cos(Math.PI * (i + 0.75) / (n + 0.5));
    let pp = 0;
    for (let iteration = 0; iteration < 100; iteration += 1) {
      let p1 = 1;
      let p2 = 0;
      for (let j = 1; j <= n; j += 1) {
        const p3 = p2;
        p2 = p1;
        p1 = ((2 * j - 1) * z * p2 - (j - 1) * p3) / j;
      }
      pp = n * (z * p1 - p2) / (z * z - 1);
      const z1 = z;
      z = z1 - p1 / pp;
      if (Math.abs(z - z1) < 1e-15) break;
    }
    nodes[i] = -z;
    nodes[n - 1 - i] = z;
    weights[i] = 2 / ((1 - z * z) * pp * pp);
    weights[n - 1 - i] = weights[i];
  }
  const result = Object.freeze({ nodes: Object.freeze(nodes), weights: Object.freeze(weights) });
  GAUSS_LEGENDRE_CACHE.set(n, result);
  return result;
}

/** Integrate f over [a, b] with `panels` Gauss-Legendre panels of `order` nodes each. */
function integratePanels(f, a, b, panels, order, budget) {
  const rule = gaussLegendre(order);
  const width = (b - a) / panels;
  let total = 0;
  for (let panel = 0; panel < panels; panel += 1) {
    const lo = a + panel * width;
    const center = lo + width / 2;
    const half = width / 2;
    for (let i = 0; i < order; i += 1) {
      if (budget) budget.check();
      total += rule.weights[i] * f(center + half * rule.nodes[i]);
    }
  }
  return total * (b - a) / (2 * panels);
}

// ---------------------------------------------------------------------------------
// Studentized range distribution (Copenhaver & Holland 1988, AS 190 style as in R's ptukey).
// ---------------------------------------------------------------------------------

function wprob(w, rr, cc) {
  const nleg = 12;
  const ihalf = 6;
  const C1 = -30;
  const C3 = 60;
  const bb = 8;
  const wlar = 3;
  const wincr1 = 2;
  const wincr2 = 3;
  const rule = gaussLegendre(nleg);
  // R stores the positive half of the nodes descending; reproduce that layout.
  const xleg = rule.nodes.slice(ihalf).reverse();
  const aleg = rule.weights.slice(ihalf).reverse();
  const qsqz = w * 0.5;
  if (qsqz >= bb) return 1;
  let prW = 2 * pnorm(qsqz) - 1;
  if (prW >= 1) return 1;
  prW = Math.pow(prW, cc);
  const wincr = w > wlar ? wincr1 : wincr2;
  let blb = qsqz;
  const binc = (bb - qsqz) / wincr;
  let bub = blb + binc;
  let einsum = 0;
  const cc1 = cc - 1;
  for (let wi = 1; wi <= wincr; wi += 1) {
    let elsum = 0;
    const a = 0.5 * (bub + blb);
    const b = 0.5 * (bub - blb);
    for (let jj = 1; jj <= nleg; jj += 1) {
      let j;
      let xx;
      if (ihalf < jj) {
        j = nleg - jj + 1;
        xx = xleg[j - 1];
      } else {
        j = jj;
        xx = -xleg[j - 1];
      }
      const c = b * xx;
      const ac = a + c;
      const qexpo = ac * ac;
      if (qexpo > C3) break;
      const pplus = 2 * pnorm(ac);
      const pminus = 2 * pnorm(ac - w);
      let rinsum = pplus * 0.5 - pminus * 0.5;
      if (rinsum >= Math.exp(C1 / cc1)) {
        rinsum = aleg[j - 1] * Math.exp(-(0.5 * qexpo)) * Math.pow(rinsum, cc1);
        elsum += rinsum;
      }
    }
    elsum *= (2 * b) * cc * SQRT_2PI_INV;
    einsum += elsum;
    blb = bub;
    bub += binc;
  }
  prW += einsum;
  if (prW <= Math.exp(C1 / rr)) return 0;
  prW = Math.pow(prW, rr);
  return prW >= 1 ? 1 : prW;
}

/** P(Q <= q) for the studentized range with `cc` groups, `rr` = 1 range, `df` error df. */
function ptukey(q, cc, df, rr = 1) {
  if (!(q > 0)) return 0;
  if (!Number.isFinite(q)) return 1;
  if (df < 2 || rr < 1 || cc < 2) return NaN;
  const nlegq = 16;
  const ihalfq = 8;
  const eps1 = -30;
  const eps2 = 1e-14;
  const dhaf = 100;
  const dquar = 800;
  const deigh = 5000;
  const dlarg = 25000;
  const rule = gaussLegendre(nlegq);
  const xlegq = rule.nodes.slice(ihalfq).reverse();
  const alegq = rule.weights.slice(ihalfq).reverse();
  if (df > dlarg) return wprob(q, rr, cc);
  const f2 = df * 0.5;
  let f2lf = f2 * Math.log(df) - df * Math.LN2 - logGammaLanczos(f2);
  const f21 = f2 - 1;
  const ff4 = df * 0.25;
  let ulen;
  if (df <= dhaf) ulen = 1;
  else if (df <= dquar) ulen = 0.5;
  else if (df <= deigh) ulen = 0.25;
  else ulen = 0.125;
  f2lf += Math.log(ulen);
  let ans = 0;
  let otsum = 0;
  for (let i = 1; i <= 50; i += 1) {
    otsum = 0;
    const twa1 = (2 * i - 1) * ulen;
    for (let jj = 1; jj <= nlegq; jj += 1) {
      let j;
      let t1;
      if (ihalfq < jj) {
        j = jj - ihalfq - 1;
        t1 = f2lf + f21 * Math.log(twa1 + xlegq[j] * ulen) - (xlegq[j] * ulen + twa1) * ff4;
      } else {
        j = jj - 1;
        t1 = f2lf + f21 * Math.log(twa1 - xlegq[j] * ulen) + (xlegq[j] * ulen - twa1) * ff4;
      }
      if (t1 >= eps1) {
        const qsqz = ihalfq < jj ? q * Math.sqrt((xlegq[j] * ulen + twa1) * 0.5) : q * Math.sqrt((-(xlegq[j] * ulen) + twa1) * 0.5);
        const wprb = wprob(qsqz, rr, cc);
        otsum += wprb * alegq[j] * Math.exp(t1);
      }
    }
    if (i * ulen >= 1 && otsum <= eps2) break;
    ans += otsum;
  }
  return ans > 1 ? 1 : ans;
}

function logGammaLanczos(z) {
  const coefficients = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGammaLanczos(1 - z);
  const x = z - 1;
  let a = coefficients[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i += 1) a += coefficients[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Upper-tail quantile: smallest q with P(Q <= q) >= p. Bracketing + bisection/secant hybrid. */
function qtukey(p, cc, df, budget) {
  if (!(p > 0 && p < 1)) throw new Error("qtukey probability out of range");
  let low = 0;
  let high = 4;
  while (ptukey(high, cc, df) < p) {
    if (budget) budget.check();
    low = high;
    high *= 2;
    if (high > 1e4) throw new Error("qtukey bracket failed");
  }
  let fLow = ptukey(low, cc, df) - p;
  let fHigh = ptukey(high, cc, df) - p;
  let x = (low + high) / 2;
  for (let iteration = 0; iteration < 200; iteration += 1) {
    if (budget) budget.check();
    // Illinois false-position step with bisection safeguard.
    const secant = high - fHigh * (high - low) / (fHigh - fLow);
    x = (secant > low && secant < high) ? secant : (low + high) / 2;
    const fx = ptukey(x, cc, df) - p;
    if (Math.abs(fx) < 1e-13 || (high - low) < 1e-12) return x;
    if (fx < 0) {
      low = x;
      fLow = fx;
      fHigh *= 0.5;
    } else {
      high = x;
      fHigh = fx;
      fLow *= 0.5;
    }
  }
  return x;
}

// ---------------------------------------------------------------------------------
// Dunnett many-to-one multivariate-t probabilities (product-correlation structure).
// rho_ij = b_i * b_j with b_i = 1 / sqrt(1 + n0 / n_i). Balanced designs give equal correlation.
// P(max |T_i| <= c) (two-sided) or P(max T_i <= c) (one-sided), df error degrees of freedom.
// ---------------------------------------------------------------------------------

function chiScaleLogDensity(s, df) {
  // density of S = sqrt(chi2_df / df)
  return Math.log(2) + (df / 2) * Math.log(df / 2) - logGammaLanczos(df / 2) + (df - 1) * Math.log(s) - df * s * s / 2;
}

function dunnettProbability(c, bs, df, twoSided, budget) {
  if (!(c > 0)) return 0;
  const zRule = gaussLegendre(48);
  const zLimit = 8;
  const inner = (s) => {
    let total = 0;
    for (let i = 0; i < zRule.nodes.length; i += 1) {
      const z = zLimit * zRule.nodes[i];
      let product = 1;
      for (const b of bs) {
        const scale = Math.sqrt(1 - b * b);
        const upper = pnorm((c * s + b * z) / scale);
        product *= twoSided ? upper - pnorm((-c * s + b * z) / scale) : upper;
        if (product <= 0) break;
      }
      total += zRule.weights[i] * product * dnorm(z);
    }
    return total * zLimit;
  };
  const sd = 1 / Math.sqrt(2 * df);
  const sLow = Math.max(1e-6, 1 - 12 * sd);
  const sHigh = 1 + 12 * sd + 2 / Math.sqrt(df);
  const value = integratePanels((s) => inner(s) * Math.exp(chiScaleLogDensity(s, df)), sLow, sHigh, 32, 16, budget);
  return Math.min(1, Math.max(0, value));
}

function dunnettCritical(p, bs, df, twoSided, budget) {
  let low = 0;
  let high = 3;
  while (dunnettProbability(high, bs, df, twoSided, budget) < p) {
    low = high;
    high *= 2;
    if (high > 1e3) throw new Error("dunnett critical bracket failed");
  }
  let fLow = dunnettProbability(low, bs, df, twoSided, budget) - p;
  let fHigh = dunnettProbability(high, bs, df, twoSided, budget) - p;
  let x = (low + high) / 2;
  for (let iteration = 0; iteration < 200; iteration += 1) {
    if (budget) budget.check();
    const secant = high - fHigh * (high - low) / (fHigh - fLow);
    x = (secant > low && secant < high) ? secant : (low + high) / 2;
    const fx = dunnettProbability(x, bs, df, twoSided, budget) - p;
    if (Math.abs(fx) < 1e-12 || (high - low) < 1e-11) return x;
    if (fx < 0) {
      low = x;
      fLow = fx;
      fHigh *= 0.5;
    } else {
      high = x;
      fHigh = fx;
      fLow *= 0.5;
    }
  }
  return x;
}

// ---------------------------------------------------------------------------------
// Helper factory bound to the engine helper surface.
// ---------------------------------------------------------------------------------

const SUPPORT_CACHE = new WeakMap();

function createSupport(H) {
  if (SUPPORT_CACHE.has(H)) return SUPPORT_CACHE.get(H);

  function invertMonotone(fn, target, low, high, tolerance = 1e-12) {
    let lo = low;
    let hi = high;
    while (fn(hi) < target) {
      lo = hi;
      hi *= 2;
      if (hi > 1e12) H.fail("STAT_NUMERIC_FAILURE", "quantile search exceeded numeric range");
    }
    for (let i = 0; i < 200; i += 1) {
      const mid = (lo + hi) / 2;
      if (fn(mid) < target) lo = mid;
      else hi = mid;
      if (hi - lo < tolerance * Math.max(1, Math.abs(hi))) break;
    }
    return (lo + hi) / 2;
  }

  const support = {
    pnorm,
    pnormUpper,
    dnorm,
    qnorm,
    gaussLegendre,
    integratePanels,
    ptukey,
    qtukey,
    dunnettProbability,
    dunnettCritical,
    logGamma: logGammaLanczos,
    tQuantile(p, df) {
      // lower-tail quantile of Student t
      if (p === 0.5) return 0;
      if (p < 0.5) return -support.tQuantile(1 - p, df);
      return invertMonotone((x) => H.tCdf(x, df), p, 0, 2);
    },
    fQuantile(p, df1, df2) {
      return invertMonotone((x) => 1 - H.pFromF(x, df1, df2), p, 0, 2);
    },
    chiSquareQuantile(p, df) {
      return invertMonotone((x) => 1 - H.pFromChiSquare(x, df), p, 0, Math.max(1, df));
    },
    residualSumOfSquares(residuals, budget) {
      return H.sum(residuals.map((value) => value * value), budget);
    },
    olsFit(y, x, budget) {
      let fit;
      try {
        fit = H.olsCore(y, x, budget);
      } catch (error) {
        if (error?.code === "STAT_SINGULAR_MATRIX") H.fail("STAT_RANK_DEFICIENT", "design matrix is rank deficient for this model");
        throw error;
      }
      return { ...fit, rss: support.residualSumOfSquares(fit.residuals, budget) };
    },
    qqRows(values, budget) {
      const ordered = H.sorted(values);
      const n = ordered.length;
      const m = H.mean(values, budget);
      const sd = Math.sqrt(H.variance(values, true, budget));
      return ordered.map((value, index) => {
        if (budget) budget.check();
        const probability = (index + 1 - 0.375) / (n + 0.25);
        const theoretical = qnorm(probability);
        return { order: index + 1, probability, theoreticalQuantile: theoretical, sampleValue: value, standardizedValue: sd > 0 ? (value - m) / sd : 0 };
      });
    },
    qqArtifact(role, title, rows, valueLabel) {
      return H.vegaArtifact(role, title, {
        data: { values: rows },
        layer: [
          { mark: { type: "line", strokeDash: [4, 4], color: "#888888" }, encoding: { x: { field: "theoreticalQuantile", type: "quantitative", title: "Theoretical normal quantile" }, y: { field: "theoreticalQuantile", type: "quantitative", title: `Standardized ${valueLabel}` } } },
          { mark: { type: "point", filled: true, size: 40 }, encoding: { x: { field: "theoreticalQuantile", type: "quantitative" }, y: { field: "standardizedValue", type: "quantitative" }, tooltip: [{ field: "order" }, { field: "sampleValue", format: ".5g" }, { field: "theoreticalQuantile", format: ".4g" }, { field: "standardizedValue", format: ".4g" }] } },
        ],
      });
    },
    forestArtifact(role, title, rows, xTitle) {
      return H.vegaArtifact(role, title, {
        data: { values: rows },
        layer: [
          { mark: { type: "rule", strokeDash: [4, 4], color: "#888888" }, encoding: { x: { datum: 0 } } },
          { mark: { type: "rule", strokeWidth: 2 }, encoding: { y: { field: "contrast", type: "nominal", title: "Contrast", sort: null }, x: { field: "lower", type: "quantitative", title: xTitle }, x2: { field: "upper" } } },
          { mark: { type: "point", filled: true, size: 80 }, encoding: { y: { field: "contrast", type: "nominal", sort: null }, x: { field: "difference", type: "quantitative" }, color: { field: "significant", type: "nominal", title: "Significant", scale: { domain: [true, false], range: ["#c0392b", "#2c3e50"] } }, tooltip: [{ field: "contrast" }, { field: "difference", format: ".5g" }, { field: "lower", format: ".5g" }, { field: "upper", format: ".5g" }, { field: "adjustedPValue", format: ".4g" }] } },
        ],
      });
    },
  };
  SUPPORT_CACHE.set(H, support);
  return support;
}

module.exports = { createSupport, pnorm, pnormUpper, dnorm, qnorm, gaussLegendre, ptukey, qtukey, dunnettProbability, dunnettCritical, integratePanels };
