"use strict";

/**
 * Diagnostic accuracy and competing-risks regression family.
 *
 * Methods:
 *   roc_curve_comparison            DeLong's test for correlated ROC curves measured on the same subjects.
 *   diagnostic_accuracy_measures    Sensitivity / specificity / predictive values / likelihood ratios / DOR
 *                                   at a declared threshold, with exact Clopper-Pearson intervals and
 *                                   predictive values recomputed at a declared prevalence.
 *   fine_gray_subdistribution_hazard  Fine-Gray regression on the subdistribution hazard of one cause in
 *                                   the presence of competing risks, with score-residual robust errors.
 *
 * Pure deterministic JavaScript. Every numeric helper arrives through `H` (engine HELPERS); nothing here
 * requires engine.cjs. Independent oracle: contracts/diagnostic-accuracy-scipy-crosscheck.py.
 *
 * References implemented (definitions, not package equivalence):
 *   DeLong, DeLong & Clarke-Pearson (1988) Biometrics 44:837-845 - correlated ROC areas.
 *   Sun & Xu (2014) IEEE Signal Process. Lett. 21:1389-1393 - the O(N log N) midrank form of the
 *     DeLong placement values, which is what computePlacements() below implements.
 *   Clopper & Pearson (1934) Biometrika 26:404-413 - exact binomial interval.
 *   Simel, Samsa & Matchar (1991) J. Clin. Epidemiol. 44:763-770 - log likelihood-ratio intervals.
 *   Fine & Gray (1999) JASA 94:496-509 - subdistribution hazard regression with IPCW risk sets.
 *   Geskus (2011) Biometrics 67:39-49 - the weighted-data representation of the Fine-Gray risk set.
 */

const ORACLE_FILE = "contracts/diagnostic-accuracy-scipy-crosscheck.py";
const DIAGNOSTIC_MODEL = Object.freeze({ families: ["diagnostic-accuracy", "classification-evaluation"], distributions: [null, "binary", "binomial", "bernoulli"], links: [null, "logit", "identity"] });
const COMPETING_RISK_MODEL = Object.freeze({ families: ["survival"], distributions: [null], links: [null] });

const MAX_MARKERS = 8;
const MAX_ROC_ROWS = 4000;
const MAX_CURVE_POINTS = 800;
const MAX_FG_ROWS = 2000;
const MAX_FG_PREDICTORS = 8;
const MAX_CAUSES = 8;
const MAX_COUNT = 1_000_000;

// ---------------------------------------------------------------------------------------------
// Shared numerics
// ---------------------------------------------------------------------------------------------

function normalSf(H, x) {
  const tail = 0.5 * H.gammaQ(0.5, (x * x) / 2);
  return x >= 0 ? tail : 1 - tail;
}

function twoSidedNormalP(H, z) {
  return Math.min(1, Math.max(0, 2 * normalSf(H, Math.abs(z))));
}

function directionalNormalP(H, z, alternative) {
  if (alternative === "greater") return normalSf(H, z);
  if (alternative === "less") return 1 - normalSf(H, z);
  return twoSidedNormalP(H, z);
}

function zCritical(H, level) {
  return H.normalInv(1 - (1 - level) / 2);
}

function percent(level) {
  return Math.round(level * 100);
}

function finite(H, value, what, code = "STAT_NUMERIC_FAILURE") {
  if (typeof value !== "number" || !Number.isFinite(value)) H.fail(code, `${what} is not finite`);
  return Object.is(value, -0) ? 0 : value;
}

function zeros(n) {
  return Array(n).fill(0);
}

function zeroMatrix(n, m = n) {
  return Array.from({ length: n }, () => Array(m).fill(0));
}

function dot(a, b) {
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += a[i] * b[i];
  return total;
}

function matVec(matrix, vector) {
  return matrix.map((row) => dot(row, vector));
}

function safeInvert(H, matrix, what) {
  try {
    return H.invert(matrix);
  } catch (error) {
    if (error && error.code === "STAT_SINGULAR_MATRIX") H.fail("STAT_SINGULAR_FIT", `${what} is singular or ill-conditioned`);
    throw error;
  }
}

/**
 * Inverse of the regularized incomplete beta function by bisection. `H.regularizedBeta` is strictly
 * increasing in x for positive shape parameters, so plain bisection converges to machine precision
 * and is deterministic (no seeded search, no library-dependent root finder).
 */
function betaQuantile(H, probability, a, b) {
  if (!(probability > 0 && probability < 1)) H.fail("STAT_INTERNAL", "beta quantile probability out of range");
  if (!(a > 0) || !(b > 0)) H.fail("STAT_INTERNAL", "beta quantile requires positive shape parameters");
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const mid = (low + high) / 2;
    if (H.regularizedBeta(mid, a, b) < probability) low = mid;
    else high = mid;
    if (high - low <= 1e-16) break;
  }
  return (low + high) / 2;
}

/**
 * Clopper-Pearson ("exact") interval for a binomial proportion. Boundary cases are the exact
 * one-sided intervals: x = 0 has lower bound 0, x = n has upper bound 1.
 */
function clopperPearson(H, successes, trials, level) {
  if (!(trials > 0)) H.fail("STAT_INSUFFICIENT_SAMPLE", "an exact binomial interval needs at least one trial");
  const alpha = 1 - level;
  const lower = successes === 0 ? 0 : betaQuantile(H, alpha / 2, successes, trials - successes + 1);
  const upper = successes === trials ? 1 : betaQuantile(H, 1 - alpha / 2, successes + 1, trials - successes);
  return { estimate: successes / trials, lower, upper, successes, trials };
}

function parseBinaryOutcome(raw, path, H, minLength) {
  if (!Array.isArray(raw) || raw.length < minLength) H.fail("STAT_INVALID_INPUT", `${path} must contain at least ${minLength} entries`);
  return raw.map((value, index) => H.integer(value, 0, 1, `${path}[${index}]`));
}

// ---------------------------------------------------------------------------------------------
// 1. roc_curve_comparison - DeLong's test for correlated ROC curves
// ---------------------------------------------------------------------------------------------

/**
 * DeLong placement values by the Sun & Xu (2014) midrank identity.
 *
 * With m positives X and n negatives Y and the trapezoidal kernel psi(x, y) = 1{y < x} + 0.5*1{y = x}:
 *   V10_i = (1/n) sum_j psi(X_i, Y_j) = (TZ_i - TX_i) / n
 *   V01_j = (1/m) sum_i psi(X_i, Y_j) = 1 - (TZ_{m+j} - TY_j) / m
 * where TX, TY are midranks within each label group and TZ is the midrank in the pooled sample.
 * The empirical AUC is the mean of V10 and equally the mean of V01; both are returned so the
 * identity can be asserted rather than assumed.
 */
function computePlacements(H, positiveValues, negativeValues, budget) {
  const m = positiveValues.length;
  const n = negativeValues.length;
  budget.check(m + n);
  const tx = H.averageRanks(positiveValues).ranks;
  const ty = H.averageRanks(negativeValues).ranks;
  const tz = H.averageRanks([...positiveValues, ...negativeValues]).ranks;
  const v10 = Array(m);
  const v01 = Array(n);
  for (let i = 0; i < m; i += 1) v10[i] = (tz[i] - tx[i]) / n;
  for (let j = 0; j < n; j += 1) v01[j] = 1 - (tz[m + j] - ty[j]) / m;
  const aucFrom10 = v10.reduce((total, value) => total + value, 0) / m;
  const aucFrom01 = v01.reduce((total, value) => total + value, 0) / n;
  return { v10, v01, aucFrom10, aucFrom01 };
}

/** Structural covariance matrices S10 (over positives) and S01 (over negatives), DeLong (1988). */
function delongCovariance(H, placements, budget) {
  const k = placements.length;
  const m = placements[0].v10.length;
  const n = placements[0].v01.length;
  if (m < 2 || n < 2) H.fail("STAT_INSUFFICIENT_SAMPLE", "DeLong covariance needs at least two positive and two negative subjects");
  const s10 = zeroMatrix(k);
  const s01 = zeroMatrix(k);
  for (let r = 0; r < k; r += 1) {
    for (let s = r; s < k; s += 1) {
      budget.check(m + n);
      let sum10 = 0;
      for (let i = 0; i < m; i += 1) sum10 += (placements[r].v10[i] - placements[r].aucFrom10) * (placements[s].v10[i] - placements[s].aucFrom10);
      let sum01 = 0;
      for (let j = 0; j < n; j += 1) sum01 += (placements[r].v01[j] - placements[r].aucFrom01) * (placements[s].v01[j] - placements[s].aucFrom01);
      s10[r][s] = sum10 / (m - 1);
      s10[s][r] = s10[r][s];
      s01[r][s] = sum01 / (n - 1);
      s01[s][r] = s01[r][s];
    }
  }
  const covariance = zeroMatrix(k);
  for (let r = 0; r < k; r += 1) for (let s = 0; s < k; s += 1) covariance[r][s] = s10[r][s] / m + s01[r][s] / n;
  return { s10, s01, covariance };
}

/**
 * Exact empirical ROC operating points: one row per distinct threshold plus the two trivial corners.
 * "Positive when score >= threshold" is the declared rule, so thresholds descend.
 */
function rocPoints(values, outcome, positives, negatives, budget) {
  const order = values.map((value, index) => index).sort((a, b) => values[b] - values[a] || a - b);
  const points = [{ threshold: Number.POSITIVE_INFINITY, truePositive: 0, falsePositive: 0 }];
  let truePositive = 0;
  let falsePositive = 0;
  let cursor = 0;
  while (cursor < order.length) {
    budget.check();
    const threshold = values[order[cursor]];
    while (cursor < order.length && values[order[cursor]] === threshold) {
      if (outcome[order[cursor]] === 1) truePositive += 1;
      else falsePositive += 1;
      cursor += 1;
    }
    points.push({ threshold, truePositive, falsePositive });
  }
  return points.map((point) => ({
    threshold: point.threshold,
    truePositive: point.truePositive,
    falsePositive: point.falsePositive,
    sensitivity: point.truePositive / positives,
    falsePositiveRate: point.falsePositive / negatives,
    specificity: 1 - point.falsePositive / negatives,
    youdenJ: point.truePositive / positives - point.falsePositive / negatives,
  }));
}

/** Deterministic thinning that always keeps both endpoints; used only for the figure, never for inference. */
function thinPoints(points, cap) {
  if (points.length <= cap) return { rows: points, thinned: false };
  const step = (points.length - 1) / (cap - 1);
  const kept = [];
  const seen = new Set();
  for (let index = 0; index < cap; index += 1) {
    const position = Math.round(index * step);
    if (!seen.has(position)) {
      seen.add(position);
      kept.push(points[position]);
    }
  }
  if (!seen.has(points.length - 1)) kept.push(points[points.length - 1]);
  return { rows: kept, thinned: true };
}

const rocCurveComparison = {
  method: "roc_curve_comparison",
  family: "diagnostic-accuracy",
  analysisModel: DIAGNOSTIC_MODEL,
  optionKeys: ["confidenceLevel", "alternative", "correction", "timeoutMs"],
  customOptions: {
    referenceMarker: {
      schema: { type: ["string", "null"], minLength: 1, maxLength: 128 },
      default: null,
      parse(value, H, path) { return value === null ? null : H.label(value, "", path); },
    },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["outcome", "markers"],
    properties: {
      outcome: { type: "array", minItems: 8, maxItems: MAX_ROC_ROWS, items: { type: "integer", minimum: 0, maximum: 1 } },
      markers: {
        type: "array",
        minItems: 2,
        maxItems: MAX_MARKERS,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["values"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 128 },
            values: { type: "array", minItems: 8, maxItems: MAX_ROC_ROWS, items: { type: "number" } },
          },
        },
      },
      outcomeLabel: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["outcome", "markers", "outcomeLabel"], "data");
    const outcome = parseBinaryOutcome(data.outcome, "data.outcome", H, 8);
    if (outcome.length > MAX_ROC_ROWS) H.fail("STAT_LIMIT_EXCEEDED", `data.outcome exceeds ${MAX_ROC_ROWS} rows`);
    const positives = outcome.filter((value) => value === 1).length;
    const negatives = outcome.length - positives;
    if (positives < 2 || negatives < 2) H.fail("STAT_INSUFFICIENT_SAMPLE", "roc_curve_comparison requires at least two positive and two negative subjects");
    if (!Array.isArray(data.markers) || data.markers.length < 2 || data.markers.length > MAX_MARKERS) {
      H.fail("STAT_INVALID_INPUT", `data.markers must contain between 2 and ${MAX_MARKERS} markers measured on the same subjects`);
    }
    const seen = new Set();
    const markers = data.markers.map((rawMarker, index) => {
      const marker = H.assertObject(rawMarker, `data.markers[${index}]`);
      H.assertKeys(marker, ["name", "values"], `data.markers[${index}]`);
      const name = H.label(marker.name, `Marker ${index + 1}`, `data.markers[${index}].name`);
      if (seen.has(name)) H.fail("STAT_INVALID_INPUT", `duplicate marker name: ${name}`);
      seen.add(name);
      const values = H.numericVector(marker.values, `data.markers[${index}].values`, 8);
      if (values.length !== outcome.length) H.fail("STAT_INVALID_INPUT", `marker ${name} length does not match data.outcome`);
      const range = H.minMax(values);
      if (range.min === range.max) H.fail("STAT_DEGENERATE", `marker ${name} is constant and has no ROC curve`);
      return { name, values };
    });
    if (options.referenceMarker !== null && !seen.has(options.referenceMarker)) {
      H.fail("STAT_INVALID_INPUT", `options.referenceMarker must name one of the supplied markers: ${[...seen].join(", ")}`);
    }
    return { outcome, markers, positives, negatives, outcomeLabel: H.label(data.outcomeLabel, "Condition present", "data.outcomeLabel") };
  },
  analyze(parsed, options, budget, H) {
    const { outcome, markers, positives, negatives } = parsed;
    const n = outcome.length;
    const k = markers.length;
    const z = zCritical(H, options.confidenceLevel);
    const positiveIndices = outcome.map((value, index) => (value === 1 ? index : -1)).filter((index) => index >= 0);
    const negativeIndices = outcome.map((value, index) => (value === 0 ? index : -1)).filter((index) => index >= 0);

    const placements = markers.map((marker) => computePlacements(
      H,
      positiveIndices.map((index) => marker.values[index]),
      negativeIndices.map((index) => marker.values[index]),
      budget,
    ));
    // The two placement means must agree with each other and with the Mann-Whitney AUC. This is an
    // identity of the estimator, so a disagreement is an implementation fault, not a data condition.
    placements.forEach((placement, index) => {
      const mannWhitney = H.auc(markers[index].values, outcome);
      if (Math.abs(placement.aucFrom10 - placement.aucFrom01) > 1e-9 || Math.abs(placement.aucFrom10 - mannWhitney) > 1e-9) {
        H.fail("STAT_INTERNAL", `DeLong placement values disagree with the rank AUC for ${markers[index].name}`);
      }
    });

    const { s10, s01, covariance } = delongCovariance(H, placements, budget);
    const aucRows = markers.map((marker, index) => {
      const auc = finite(H, placements[index].aucFrom10, `AUC for ${marker.name}`);
      const variance = finite(H, covariance[index][index], `AUC variance for ${marker.name}`);
      if (!(variance > 0)) H.fail("STAT_DEGENERATE", `the DeLong variance of ${marker.name} is zero; its placement values do not vary`);
      const standardError = Math.sqrt(variance);
      return {
        marker: marker.name,
        auc,
        standardError,
        variance,
        lower: Math.max(0, auc - z * standardError),
        upper: Math.min(1, auc + z * standardError),
        positives,
        negatives,
      };
    });

    const referenceIndex = options.referenceMarker === null ? 0 : markers.findIndex((marker) => marker.name === options.referenceMarker);
    const pairs = [];
    for (let r = 0; r < k; r += 1) {
      for (let s = r + 1; s < k; s += 1) {
        budget.check();
        const difference = aucRows[r].auc - aucRows[s].auc;
        const varianceOfDifference = covariance[r][r] + covariance[s][s] - 2 * covariance[r][s];
        if (!(varianceOfDifference > 0)) {
          H.fail("STAT_DEGENERATE", `the DeLong variance of ${markers[r].name} - ${markers[s].name} is zero; the two markers order every subject identically`);
        }
        const standardError = Math.sqrt(varianceOfDifference);
        const statistic = difference / standardError;
        pairs.push({
          comparison: `${markers[r].name} - ${markers[s].name}`,
          markerA: markers[r].name,
          markerB: markers[s].name,
          aucA: aucRows[r].auc,
          aucB: aucRows[s].auc,
          difference,
          standardError,
          covariance: covariance[r][s],
          correlation: covariance[r][s] / Math.sqrt(covariance[r][r] * covariance[s][s]),
          lower: difference - z * standardError,
          upper: difference + z * standardError,
          statistic,
          pValue: directionalNormalP(H, statistic, options.alternative),
          isReferenceContrast: r === referenceIndex || s === referenceIndex,
        });
      }
    }
    const adjustmentMethod = options.correction === "all" ? "holm" : options.correction;
    const adjusted = pairs.length > 1 ? H.adjustedPValues(pairs.map((pair) => pair.pValue), adjustmentMethod) : pairs.map((pair) => pair.pValue);
    pairs.forEach((pair, index) => { pair.adjustedPValue = adjusted[index]; });

    const curves = markers.map((marker) => rocPoints(marker.values, outcome, positives, negatives, budget));
    const thinned = curves.map((points) => thinPoints(points, MAX_CURVE_POINTS));
    const curveRows = markers.flatMap((marker, index) => thinned[index].rows.map((point) => ({
      marker: marker.name,
      threshold: Number.isFinite(point.threshold) ? point.threshold : null,
      falsePositiveRate: point.falsePositiveRate,
      sensitivity: point.sensitivity,
      specificity: point.specificity,
      youdenJ: point.youdenJ,
      truePositive: point.truePositive,
      falsePositive: point.falsePositive,
    })));
    const anyThinned = thinned.some((entry) => entry.thinned);

    const aucColumns = [
      { key: "marker", label: "Marker", type: "string" },
      { key: "auc", label: "AUC", type: "number" },
      { key: "standardError", label: "DeLong SE", type: "number" },
      { key: "lower", label: "CI lower", type: "number" },
      { key: "upper", label: "CI upper", type: "number" },
      { key: "positives", label: "Positives", type: "number" },
      { key: "negatives", label: "Negatives", type: "number" },
    ];
    const pairColumns = [
      { key: "comparison", label: "Comparison", type: "string" },
      { key: "aucA", label: "AUC A", type: "number" },
      { key: "aucB", label: "AUC B", type: "number" },
      { key: "difference", label: "Difference", type: "number" },
      { key: "standardError", label: "SE of difference", type: "number" },
      { key: "covariance", label: "Covariance", type: "number" },
      { key: "correlation", label: "Correlation of AUCs", type: "number" },
      { key: "lower", label: "CI lower", type: "number" },
      { key: "upper", label: "CI upper", type: "number" },
      { key: "statistic", label: "z", type: "number" },
      { key: "pValue", label: "p", type: "number" },
      { key: "adjustedPValue", label: `p (${adjustmentMethod})`, type: "number" },
    ];
    const curveColumns = [
      { key: "marker", label: "Marker", type: "string" },
      { key: "threshold", label: "Threshold", type: "number" },
      { key: "falsePositiveRate", label: "1 - specificity", type: "number" },
      { key: "sensitivity", label: "Sensitivity", type: "number" },
      { key: "specificity", label: "Specificity", type: "number" },
      { key: "youdenJ", label: "Youden J", type: "number" },
      { key: "truePositive", label: "TP", type: "number" },
      { key: "falsePositive", label: "FP", type: "number" },
    ];

    return {
      sample: { n, positives, negatives, markers: k, prevalence: positives / n, pairedDesign: true },
      estimates: [
        ...aucRows.map((row) => ({ name: `AUC ${row.marker}`, estimate: row.auc, standardError: row.standardError, variance: row.variance, lower: row.lower, upper: row.upper })),
        ...pairs.map((pair) => ({ name: `AUC difference ${pair.comparison}`, estimate: pair.difference, standardError: pair.standardError, covariance: pair.covariance, correlation: pair.correlation })),
      ],
      tests: pairs.map((pair) => ({
        name: `DeLong test ${pair.comparison}`,
        statistic: pair.statistic,
        distribution: "normal",
        pValue: pair.pValue,
        adjustedPValue: pair.adjustedPValue,
        adjustment: adjustmentMethod,
        alternative: options.alternative,
        varianceEstimator: "DeLong structural components on the same subjects",
      })),
      confidenceIntervals: [
        ...aucRows.map((row) => ({ parameter: `AUC ${row.marker}`, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: "Wald normal on the DeLong variance, clipped to [0, 1]" })),
        ...pairs.map((pair) => ({ parameter: `AUC difference ${pair.comparison}`, level: options.confidenceLevel, lower: pair.lower, upper: pair.upper, method: "Wald normal on the DeLong variance of the difference (paired)" })),
      ],
      effectSizes: pairs.map((pair) => ({
        name: `AUC difference ${pair.comparison}`,
        estimate: pair.difference,
        lower: pair.lower,
        upper: pair.upper,
        interpretationBoundary: "difference in the probability that a random positive outranks a random negative; not a difference in accuracy at any single threshold",
      })),
      assumptions: [
        { name: "every marker is measured on the same subjects", status: "verified_by_input_contract", note: "The DeLong covariance is only defined for paired markers; unpaired markers would need an independent-samples variance." },
        { name: "outcome status is known without error for every subject", status: "requires_design_review", note: "Verification bias (reference standard applied only to test-positive subjects) is not detectable from these data." },
        { name: "independent subjects", status: "requires_design_review" },
        { name: "asymptotic normality of the AUC difference", status: "asymptotic", note: "The normal approximation degrades with few positives or negatives or with AUC near 1." },
      ],
      diagnostics: [
        { name: "class balance", status: "evaluated", positives, negatives, prevalence: positives / n, note: "Sample prevalence governs the width of the DeLong interval but not the AUC itself." },
        { name: "placement-value identity", status: "verified", detail: "mean(V10) equals mean(V01) and equals the Mann-Whitney rank AUC for every marker to within 1e-9." },
        { name: "AUC correlation", status: "evaluated", pairs: pairs.map((pair) => ({ comparison: pair.comparison, correlation: pair.correlation })), detail: "Positively correlated markers give a smaller variance of the difference than two independent studies would." },
        { name: "tied marker values", status: "evaluated", tiedMarkers: markers.filter((marker) => H.averageRanks(marker.values).tieSizes.length > 0).map((marker) => marker.name), detail: "Ties are handled by the 0.5 midrank kernel, which is the trapezoidal AUC." },
        { name: "curve rendering", status: anyThinned ? "thinned_for_figure" : "exact", pointsPerMarker: thinned.map((entry, index) => ({ marker: markers[index].name, exactPoints: curves[index].length, reportedPoints: entry.rows.length })), detail: anyThinned ? `Operating points were thinned to at most ${MAX_CURVE_POINTS} per marker for the figure; AUC, variance, and every test use all observations.` : "All exact operating points are reported." },
        { name: "multiplicity", status: pairs.length > 1 ? "adjusted" : "single_comparison", adjustment: adjustmentMethod, comparisons: pairs.length },
      ],
      artifacts: [
        H.tableArtifact(`Area under the ROC curve: ${parsed.outcomeLabel}`, `Empirical AUC per marker with the DeLong standard error and ${percent(options.confidenceLevel)}% interval.`, aucColumns, aucRows.map(({ variance, ...row }) => row), ["The AUC is the probability that a randomly chosen positive subject has a higher marker value than a randomly chosen negative subject."], "roc-auc-table"),
        H.tableArtifact(`DeLong comparison of correlated ROC curves: ${parsed.outcomeLabel}`, "Pairwise AUC differences with the paired DeLong variance, covariance, and z test.", pairColumns, pairs.map(({ markerA, markerB, isReferenceContrast, ...row }) => row), [`${percent(options.confidenceLevel)}% Wald intervals; p adjusted by ${adjustmentMethod} across ${pairs.length} comparison(s).`], "roc-delong-comparison-table"),
        H.tableArtifact(`ROC operating points: ${parsed.outcomeLabel}`, "Empirical sensitivity and 1 - specificity at each threshold, with positive defined as marker value greater than or equal to the threshold.", curveColumns, curveRows, [], "roc-curve-comparison-points-table"),
        H.vegaArtifact("roc-curve-comparison-plot", `ROC curves: ${parsed.outcomeLabel}`, {
          layer: [{
            // The chance diagonal. A ROC curve is read against it, so it belongs in the figure.
            data: { values: [{ chance: 0 }, { chance: 1 }] },
            mark: { type: "line", strokeDash: [4, 4], color: "#999999", strokeWidth: 1 },
            encoding: {
              x: { field: "chance", type: "quantitative", scale: { domain: [0, 1] } },
              y: { field: "chance", type: "quantitative", scale: { domain: [0, 1] } },
            },
          }, {
            data: { values: curveRows },
            mark: { type: "line", interpolate: "step-after", point: false },
            encoding: {
              x: { field: "falsePositiveRate", type: "quantitative", title: "1 - specificity", scale: { domain: [0, 1] } },
              y: { field: "sensitivity", type: "quantitative", title: "Sensitivity", scale: { domain: [0, 1] } },
              color: { field: "marker", type: "nominal", title: "Marker" },
              tooltip: [{ field: "marker" }, { field: "threshold", format: ".4g" }, { field: "sensitivity", format: ".4f" }, { field: "specificity", format: ".4f" }, { field: "youdenJ", format: ".4f" }],
            },
          }],
          description: "Empirical ROC curves for markers measured on the same subjects, with the chance diagonal; the DeLong test compares the areas under these curves.",
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "Two or more markers, scores, or model outputs were measured on the same subjects against the same reference standard, and the claim on the table is that one of them discriminates better than another.",
    decision: "Whether the difference between the two areas under the curve is larger than the paired sampling error, so the better-performing marker can be named rather than merely ranked.",
    mustShow: "Each AUC with its DeLong standard error and interval, the covariance and correlation between the two AUCs, the difference with its own interval, the z statistic and p value, and the number of positive and negative subjects.",
    userGoal: "Support a sentence of the form 'marker A discriminated better than marker B (difference in AUC, interval, p)' in a diagnostic accuracy paper, without treating two curves from the same subjects as if they came from two independent studies.",
    nextActions: [
      { trigger: "difference-interval-excludes-zero", action: "report-the-auc-difference-with-its-interval-and-then-fix-a-threshold", reason: "A better AUC is a claim about ranking across all thresholds; the clinical claim still needs sensitivity and specificity at a declared cut-off." },
      { trigger: "difference-interval-includes-zero", action: "report-equivalence-boundary-or-power-rather-than-declaring-the-markers-equal", reason: "A non-significant DeLong test with few positives is an absence of evidence, not evidence that the two curves coincide." },
      { trigger: "auc-correlation-near-one", action: "check-whether-the-two-markers-are-near-duplicates-before-claiming-incremental-value", reason: "Highly correlated markers give a tiny variance of the difference, so a statistically detectable difference can still be clinically meaningless." },
      { trigger: "few-positives-or-negatives", action: "report-the-normal-approximation-boundary-or-use-a-bootstrap", reason: "The DeLong variance is asymptotic; with a handful of events the interval understates the uncertainty." },
      { trigger: "markers-come-from-a-fitted-model-on-these-same-data", action: "report-optimism-or-refit-with-external-validation-before-comparing", reason: "Comparing an in-sample model score to a raw marker rewards overfitting, and DeLong does not correct for it." },
    ],
  },
  fixture: {
    data: {
      outcomeLabel: "Disease present",
      outcome: [1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 1],
      markers: [
        { name: "biomarker A", values: [7.2, 3.1, 6.8, 4.0, 8.1, 4.5, 2.7, 5.6, 7.7, 4.4, 6.1, 3.3, 8.6, 6.5, 6.2, 2.9, 7.0, 3.9, 3.9, 4.2, 8.9, 6.3, 3.4, 4.6, 7.5, 2.5, 4.1, 6.9, 3.8, 5.4] },
        { name: "biomarker B", values: [5.5, 4.2, 5.0, 5.1, 6.3, 4.8, 3.9, 4.7, 6.0, 5.3, 4.9, 4.1, 6.6, 5.2, 5.6, 3.7, 5.8, 4.5, 4.6, 5.0, 6.8, 5.4, 4.3, 5.5, 6.1, 3.5, 4.9, 5.7, 4.4, 4.6] },
      ],
    },
    options: { confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.classification"] },
  coverage: {
    implementedBoundary: "Empirical (trapezoidal, midrank-tied) AUC for 2 to 8 markers measured on the same 8 to 4000 subjects, the full DeLong structural covariance matrix, every pairwise AUC difference with a Wald interval and a one- or two-sided z test, and multiplicity adjustment across the pairwise tests; no bootstrap interval, no partial AUC, no covariate adjustment, and no unpaired (two independent samples) ROC comparison.",
    oracle: {
      level: "external-library-partial",
      evidence: [ORACLE_FILE],
      verifiedOutputs: [
        "AUC per marker (sklearn.metrics.roc_auc_score)",
        "ROC operating points, sensitivity and 1 - specificity per threshold (sklearn.metrics.roc_curve)",
        "DeLong placement values V10 and V01 (direct O(m*n) kernel evaluation in numpy, independent of the midrank algorithm used here)",
        "DeLong variance, covariance, AUC difference, z statistic and p value (direct numpy re-derivation of DeLong 1988 following Sun & Xu 2014)",
      ],
      excludedOutputs: [
        "bootstrap or exact intervals for the AUC difference",
        "partial AUC over a restricted specificity range",
        "unpaired ROC comparison across independent samples",
        "covariate-adjusted ROC curves",
      ],
    },
    diagnostic: {
      level: "method-specific-partial",
      emitted: ["class balance", "placement-value identity", "AUC correlation", "tied marker values", "curve rendering", "multiplicity"],
      limitations: [
        "the DeLong variance is asymptotic and is not calibrated for very few positives or negatives",
        "verification bias and spectrum bias are design properties that no diagnostic here can detect",
        "in-sample model scores are not corrected for optimism",
      ],
    },
    knownGaps: [
      "no bootstrap or permutation interval for the AUC difference",
      "no partial AUC or sensitivity-at-fixed-specificity comparison",
      "no unpaired ROC comparison for markers measured on different subjects",
      "no covariate adjustment and no clustered or repeated-measures DeLong variance",
      "no integrated discrimination improvement or net reclassification index",
    ],
  },
};

// ---------------------------------------------------------------------------------------------
// 2. diagnostic_accuracy_measures
// ---------------------------------------------------------------------------------------------

function logit(p) {
  return Math.log(p / (1 - p));
}

function expit(x) {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Predictive value at a declared prevalence, on the log-odds scale.
 *
 *   odds(PPV | pi) = LR+ * odds(pi)         so  logit PPV = log LR+ + logit pi
 *   odds(1 - NPV | pi) = LR- * odds(pi)     so  logit(1 - NPV) = log LR- + logit pi
 *
 * The interval propagates only the sampling error of the likelihood ratio (Simel 1991); the declared
 * prevalence is treated as a fixed external quantity, which is exactly what "declared" means here.
 */
function predictiveValueAtPrevalence(H, logRatio, standardError, prevalence, z, kind) {
  const centre = logRatio + logit(prevalence);
  const lower = centre - z * standardError;
  const upper = centre + z * standardError;
  if (kind === "ppv") return { estimate: expit(centre), lower: expit(lower), upper: expit(upper) };
  return { estimate: 1 - expit(centre), lower: 1 - expit(upper), upper: 1 - expit(lower) };
}

const diagnosticAccuracyMeasures = {
  method: "diagnostic_accuracy_measures",
  family: "diagnostic-accuracy",
  analysisModel: DIAGNOSTIC_MODEL,
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    threshold: {
      schema: { type: ["number", "null"] },
      default: null,
      parse(value, H, path) { return value === null ? null : H.finiteNumber(value, path); },
    },
    positiveWhen: {
      schema: { type: "string", enum: ["at-or-above", "at-or-below"] },
      default: "at-or-above",
      parse(value, H, path) {
        if (!["at-or-above", "at-or-below"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be at-or-above or at-or-below`);
        return value;
      },
    },
    targetPrevalence: {
      schema: { type: ["number", "null"], exclusiveMinimum: 0, exclusiveMaximum: 1 },
      default: null,
      parse(value, H, path) {
        if (value === null) return null;
        const parsed = H.finiteNumber(value, path);
        if (!(parsed > 0 && parsed < 1)) H.fail("STAT_INVALID_INPUT", `${path} must lie strictly between 0 and 1`);
        return parsed;
      },
    },
    samplingDesign: {
      schema: { type: "string", enum: ["cohort", "case-control"] },
      default: "cohort",
      parse(value, H, path) {
        if (!["cohort", "case-control"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be cohort or case-control`);
        return value;
      },
    },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      counts: {
        type: "object",
        additionalProperties: false,
        required: ["truePositive", "falseNegative", "falsePositive", "trueNegative"],
        properties: {
          truePositive: { type: "integer", minimum: 0, maximum: MAX_COUNT },
          falseNegative: { type: "integer", minimum: 0, maximum: MAX_COUNT },
          falsePositive: { type: "integer", minimum: 0, maximum: MAX_COUNT },
          trueNegative: { type: "integer", minimum: 0, maximum: MAX_COUNT },
        },
      },
      score: { type: "array", minItems: 4, maxItems: MAX_ROC_ROWS, items: { type: "number" } },
      outcome: { type: "array", minItems: 4, maxItems: MAX_ROC_ROWS, items: { type: "integer", minimum: 0, maximum: 1 } },
      testLabel: { type: "string", minLength: 1, maxLength: 128 },
      conditionLabel: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["counts", "score", "outcome", "testLabel", "conditionLabel"], "data");
    const hasCounts = data.counts !== undefined;
    const hasScores = data.score !== undefined || data.outcome !== undefined;
    if (hasCounts === hasScores) {
      H.fail("STAT_INVALID_INPUT", "supply exactly one of data.counts (a 2x2 classification table) or data.score with data.outcome and options.threshold");
    }
    const testLabel = H.label(data.testLabel, "Index test", "data.testLabel");
    const conditionLabel = H.label(data.conditionLabel, "Target condition", "data.conditionLabel");
    if (hasCounts) {
      if (options.threshold !== null) H.fail("STAT_INVALID_INPUT", "options.threshold applies to data.score, not to an already-classified data.counts table");
      const counts = H.assertObject(data.counts, "data.counts");
      H.assertKeys(counts, ["truePositive", "falseNegative", "falsePositive", "trueNegative"], "data.counts");
      const cell = (key) => H.integer(counts[key], 0, MAX_COUNT, `data.counts.${key}`);
      const table = {
        truePositive: cell("truePositive"),
        falseNegative: cell("falseNegative"),
        falsePositive: cell("falsePositive"),
        trueNegative: cell("trueNegative"),
      };
      if (table.truePositive + table.falseNegative < 1) H.fail("STAT_INSUFFICIENT_SAMPLE", "the table has no subjects with the target condition, so sensitivity is undefined");
      if (table.falsePositive + table.trueNegative < 1) H.fail("STAT_INSUFFICIENT_SAMPLE", "the table has no subjects without the target condition, so specificity is undefined");
      return { table, source: "counts", threshold: null, testLabel, conditionLabel };
    }
    if (data.score === undefined || data.outcome === undefined) H.fail("STAT_INVALID_INPUT", "data.score and data.outcome must be supplied together");
    if (options.threshold === null) H.fail("STAT_INVALID_INPUT", "options.threshold must be declared before data.score can be classified; an accuracy measure without a declared cut-off is not defined");
    const score = H.numericVector(data.score, "data.score", 4);
    if (score.length > MAX_ROC_ROWS) H.fail("STAT_LIMIT_EXCEEDED", `data.score exceeds ${MAX_ROC_ROWS} rows`);
    const outcome = parseBinaryOutcome(data.outcome, "data.outcome", H, 4);
    if (outcome.length !== score.length) H.fail("STAT_INVALID_INPUT", "data.outcome must match data.score length");
    const table = { truePositive: 0, falseNegative: 0, falsePositive: 0, trueNegative: 0 };
    score.forEach((value, index) => {
      const positiveTest = options.positiveWhen === "at-or-above" ? value >= options.threshold : value <= options.threshold;
      if (outcome[index] === 1) table[positiveTest ? "truePositive" : "falseNegative"] += 1;
      else table[positiveTest ? "falsePositive" : "trueNegative"] += 1;
    });
    if (table.truePositive + table.falseNegative < 1) H.fail("STAT_INSUFFICIENT_SAMPLE", "data.outcome contains no subjects with the target condition, so sensitivity is undefined");
    if (table.falsePositive + table.trueNegative < 1) H.fail("STAT_INSUFFICIENT_SAMPLE", "data.outcome contains no subjects without the target condition, so specificity is undefined");
    return { table, source: "score-threshold", threshold: options.threshold, testLabel, conditionLabel };
  },
  analyze(parsed, options, budget, H) {
    budget.check();
    const { truePositive: tp, falseNegative: fn, falsePositive: fp, trueNegative: tn } = parsed.table;
    const diseased = tp + fn;
    const healthy = fp + tn;
    const testPositive = tp + fp;
    const testNegative = fn + tn;
    const n = diseased + healthy;
    const level = options.confidenceLevel;
    const z = zCritical(H, level);

    const sensitivity = clopperPearson(H, tp, diseased, level);
    const specificity = clopperPearson(H, tn, healthy, level);
    const accuracy = clopperPearson(H, tp + tn, n, level);
    const samplePrevalence = clopperPearson(H, diseased, n, level);
    const ppv = testPositive > 0 ? clopperPearson(H, tp, testPositive, level) : null;
    const npv = testNegative > 0 ? clopperPearson(H, tn, testNegative, level) : null;

    // Likelihood ratios on the log scale (Simel, Samsa & Matchar 1991). The variance is only defined
    // when no cell of the relevant margin is empty; an empty cell is reported as an undefined ratio
    // rather than silently replaced by a continuity-corrected number.
    const se = sensitivity.estimate;
    const sp = specificity.estimate;
    const lrPositiveDefined = tp > 0 && fp > 0 && fn > 0 && tn > 0;
    const positiveLikelihoodRatio = lrPositiveDefined
      ? (() => {
        const ratio = se / (1 - sp);
        const standardError = Math.sqrt((1 - se) / (se * diseased) + sp / ((1 - sp) * healthy));
        const centre = Math.log(ratio);
        return { estimate: ratio, logEstimate: centre, logStandardError: standardError, lower: Math.exp(centre - z * standardError), upper: Math.exp(centre + z * standardError) };
      })()
      : null;
    const negativeLikelihoodRatio = lrPositiveDefined
      ? (() => {
        const ratio = (1 - se) / sp;
        const standardError = Math.sqrt(se / ((1 - se) * diseased) + (1 - sp) / (sp * healthy));
        const centre = Math.log(ratio);
        return { estimate: ratio, logEstimate: centre, logStandardError: standardError, lower: Math.exp(centre - z * standardError), upper: Math.exp(centre + z * standardError) };
      })()
      : null;
    const diagnosticOddsRatio = lrPositiveDefined
      ? (() => {
        const ratio = (tp * tn) / (fp * fn);
        const centre = Math.log(ratio);
        const standardError = Math.sqrt(1 / tp + 1 / fp + 1 / fn + 1 / tn);
        return { estimate: ratio, logEstimate: centre, logStandardError: standardError, lower: Math.exp(centre - z * standardError), upper: Math.exp(centre + z * standardError) };
      })()
      : null;
    const youdenJ = se + sp - 1;

    const prevalenceUsed = options.targetPrevalence;
    const adjusted = prevalenceUsed !== null && positiveLikelihoodRatio && negativeLikelihoodRatio
      ? {
        prevalence: prevalenceUsed,
        ppv: predictiveValueAtPrevalence(H, positiveLikelihoodRatio.logEstimate, positiveLikelihoodRatio.logStandardError, prevalenceUsed, z, "ppv"),
        npv: predictiveValueAtPrevalence(H, negativeLikelihoodRatio.logEstimate, negativeLikelihoodRatio.logStandardError, prevalenceUsed, z, "npv"),
      }
      : null;

    const measureRow = (measure, definition, interval, basis, intervalMethod) => ({
      measure,
      definition,
      estimate: finite(H, interval.estimate, measure),
      lower: finite(H, interval.lower, `${measure} lower`),
      upper: finite(H, interval.upper, `${measure} upper`),
      numerator: interval.successes === undefined ? null : interval.successes,
      denominator: interval.trials === undefined ? null : interval.trials,
      basis,
      intervalMethod,
    });
    const exact = "Clopper-Pearson exact";
    const rows = [
      measureRow("Sensitivity", "TP / (TP + FN)", sensitivity, "subjects with the condition", exact),
      measureRow("Specificity", "TN / (TN + FP)", specificity, "subjects without the condition", exact),
      measureRow("Accuracy", "(TP + TN) / N", accuracy, "all subjects", exact),
      measureRow("Sample prevalence", "(TP + FN) / N", samplePrevalence, "all subjects", exact),
      ...(ppv ? [measureRow("PPV at sample prevalence", "TP / (TP + FP)", ppv, "test-positive subjects", exact)] : []),
      ...(npv ? [measureRow("NPV at sample prevalence", "TN / (TN + FN)", npv, "test-negative subjects", exact)] : []),
      ...(adjusted ? [
        { measure: `PPV at declared prevalence ${adjusted.prevalence}`, definition: "expit(log LR+ + logit prevalence)", estimate: adjusted.ppv.estimate, lower: adjusted.ppv.lower, upper: adjusted.ppv.upper, numerator: null, denominator: null, basis: "declared external prevalence", intervalMethod: "log likelihood-ratio (Simel) propagated to the log-odds of PPV" },
        { measure: `NPV at declared prevalence ${adjusted.prevalence}`, definition: "1 - expit(log LR- + logit prevalence)", estimate: adjusted.npv.estimate, lower: adjusted.npv.lower, upper: adjusted.npv.upper, numerator: null, denominator: null, basis: "declared external prevalence", intervalMethod: "log likelihood-ratio (Simel) propagated to the log-odds of 1 - NPV" },
      ] : []),
      ...(positiveLikelihoodRatio ? [{ measure: "Positive likelihood ratio", definition: "sensitivity / (1 - specificity)", estimate: positiveLikelihoodRatio.estimate, lower: positiveLikelihoodRatio.lower, upper: positiveLikelihoodRatio.upper, numerator: null, denominator: null, basis: "both margins", intervalMethod: "log-normal (Simel 1991)" }] : []),
      ...(negativeLikelihoodRatio ? [{ measure: "Negative likelihood ratio", definition: "(1 - sensitivity) / specificity", estimate: negativeLikelihoodRatio.estimate, lower: negativeLikelihoodRatio.lower, upper: negativeLikelihoodRatio.upper, numerator: null, denominator: null, basis: "both margins", intervalMethod: "log-normal (Simel 1991)" }] : []),
      ...(diagnosticOddsRatio ? [{ measure: "Diagnostic odds ratio", definition: "(TP * TN) / (FP * FN)", estimate: diagnosticOddsRatio.estimate, lower: diagnosticOddsRatio.lower, upper: diagnosticOddsRatio.upper, numerator: null, denominator: null, basis: "all four cells", intervalMethod: "Woolf log-normal" }] : []),
      { measure: "Youden J", definition: "sensitivity + specificity - 1", estimate: youdenJ, lower: sensitivity.lower + specificity.lower - 1, upper: sensitivity.upper + specificity.upper - 1, numerator: null, denominator: null, basis: "both margins", intervalMethod: "conservative sum of the two exact bounds (not an exact interval for J)" },
    ];

    const tableRows = [
      { row: "Test positive", conditionPresent: tp, conditionAbsent: fp, total: testPositive },
      { row: "Test negative", conditionPresent: fn, conditionAbsent: tn, total: testNegative },
      { row: "Total", conditionPresent: diseased, conditionAbsent: healthy, total: n },
    ];

    const predictiveValuesAreInterpretable = options.samplingDesign === "cohort";
    const prevalenceWarningNeeded = !predictiveValuesAreInterpretable && prevalenceUsed === null;

    const measureColumns = [
      { key: "measure", label: "Measure", type: "string" },
      { key: "definition", label: "Definition", type: "string" },
      { key: "estimate", label: "Estimate", type: "number" },
      { key: "lower", label: "CI lower", type: "number" },
      { key: "upper", label: "CI upper", type: "number" },
      { key: "numerator", label: "Numerator", type: "number" },
      { key: "denominator", label: "Denominator", type: "number" },
      { key: "basis", label: "Denominator basis", type: "string" },
      { key: "intervalMethod", label: "Interval method", type: "string" },
    ];
    const tableColumns = [
      { key: "row", label: "", type: "string" },
      { key: "conditionPresent", label: `${parsed.conditionLabel} present`, type: "number" },
      { key: "conditionAbsent", label: `${parsed.conditionLabel} absent`, type: "number" },
      { key: "total", label: "Total", type: "number" },
    ];

    return {
      sample: {
        n,
        conditionPresent: diseased,
        conditionAbsent: healthy,
        testPositive,
        testNegative,
        samplePrevalence: diseased / n,
        declaredPrevalence: prevalenceUsed,
        samplingDesign: options.samplingDesign,
        classifiedFrom: parsed.source,
        threshold: parsed.threshold,
        positiveWhen: options.positiveWhen,
      },
      estimates: rows.map((row) => ({ name: row.measure, estimate: row.estimate, lower: row.lower, upper: row.upper, denominatorBasis: row.basis, intervalMethod: row.intervalMethod })),
      tests: [],
      confidenceIntervals: rows.map((row) => ({ parameter: row.measure, level, lower: row.lower, upper: row.upper, method: row.intervalMethod })),
      effectSizes: [
        { name: "Youden J", estimate: youdenJ, interpretationBoundary: "sensitivity plus specificity minus one at this single declared threshold; it is not an area under a curve" },
        ...(diagnosticOddsRatio ? [{ name: "Diagnostic odds ratio", estimate: diagnosticOddsRatio.estimate, lower: diagnosticOddsRatio.lower, upper: diagnosticOddsRatio.upper, interpretationBoundary: "one number for the whole 2x2 table; it hides an unequal trade-off between sensitivity and specificity" }] : []),
      ],
      assumptions: [
        { name: "the threshold was declared before the data were classified", status: parsed.source === "counts" ? "verified_by_input_contract" : "requires_design_review", note: parsed.source === "counts" ? "A pre-classified table carries no threshold to optimize." : "A threshold chosen to maximize accuracy on these same data inflates every measure reported here." },
        { name: "the reference standard is applied to every subject regardless of test result", status: "requires_design_review", note: "Partial verification makes sensitivity and specificity biased in opposite directions." },
        { name: "predictive values require the sample prevalence to equal the target prevalence", status: predictiveValuesAreInterpretable ? "verified_by_input_contract" : "violated_by_declared_design", note: predictiveValuesAreInterpretable ? "A consecutive or cohort sample carries the population prevalence, so PPV and NPV from the table are interpretable." : "The declared sampling design is case-control, so the sample prevalence is fixed by the investigator and PPV and NPV computed from the table are not population quantities." },
        { name: "independent subjects, one test result each", status: "requires_design_review" },
      ],
      diagnostics: [
        { name: "cell counts", status: "evaluated", truePositive: tp, falseNegative: fn, falsePositive: fp, trueNegative: tn, emptyCells: [["TP", tp], ["FN", fn], ["FP", fp], ["TN", tn]].filter(([, count]) => count === 0).map(([cell]) => cell) },
        {
          name: "predictive value validity",
          status: prevalenceWarningNeeded ? "not_interpretable" : (prevalenceUsed === null ? "sample_prevalence_only" : "recomputed_at_declared_prevalence"),
          samplePrevalence: diseased / n,
          declaredPrevalence: prevalenceUsed,
          samplingDesign: options.samplingDesign,
          detail: prevalenceWarningNeeded
            ? "PPV and NPV must be recomputed at a declared prevalence: this sample is case-control, so its prevalence is an artefact of the sampling ratio and the tabulated PPV and NPV describe no population. Supply options.targetPrevalence."
            : (prevalenceUsed === null
              ? "PPV and NPV are reported at the sample prevalence only. They transfer to another setting only if that setting has the same prevalence; supply options.targetPrevalence to recompute them."
              : `PPV and NPV were recomputed at the declared prevalence ${prevalenceUsed} through the likelihood ratios, which are prevalence-independent. The tabulated values at the sample prevalence ${diseased / n} are reported alongside for comparison.`),
        },
        { name: "interval methods", status: "evaluated", exactMeasures: ["sensitivity", "specificity", "accuracy", "prevalence", "PPV", "NPV"], asymptoticMeasures: ["positive likelihood ratio", "negative likelihood ratio", "diagnostic odds ratio", "prevalence-adjusted predictive values"], detail: "Proportions carry Clopper-Pearson exact intervals; ratios carry log-normal intervals, which are asymptotic." },
        { name: "likelihood ratio definition", status: lrPositiveDefined ? "defined" : "undefined_empty_cell", detail: lrPositiveDefined ? "All four cells are non-zero, so both likelihood ratios and the diagnostic odds ratio have finite log-normal intervals." : "At least one cell of the table is zero, so the likelihood ratios and the diagnostic odds ratio are withheld rather than continuity-corrected." },
        { name: "threshold provenance", status: parsed.source === "counts" ? "pre_classified" : "applied_here", threshold: parsed.threshold, positiveWhen: options.positiveWhen },
      ],
      artifacts: [
        H.tableArtifact(`Classification table: ${parsed.testLabel} against ${parsed.conditionLabel}`, parsed.threshold === null ? "Supplied 2x2 classification table." : `Classified at threshold ${parsed.threshold} (positive when the score is ${options.positiveWhen === "at-or-above" ? "at or above" : "at or below"} the threshold).`, tableColumns, tableRows, [], "diagnostic-accuracy-2x2-table"),
        H.tableArtifact(`Diagnostic accuracy measures: ${parsed.testLabel}`, `Each measure with its ${percent(level)}% interval and the denominator it is computed over.`, measureColumns, rows, [prevalenceUsed === null ? "Predictive values are reported at the sample prevalence only." : `Predictive values are also reported at the declared prevalence ${prevalenceUsed}.`], "diagnostic-accuracy-measures-table"),
        H.vegaArtifact("diagnostic-accuracy-forest", `Diagnostic accuracy with ${percent(level)}% intervals: ${parsed.testLabel}`, {
          data: { values: rows },
          layer: [
            { mark: { type: "rule", strokeWidth: 2 }, encoding: { y: { field: "measure", type: "nominal", title: null, sort: null }, x: { field: "lower", type: "quantitative", title: "Estimate" }, x2: { field: "upper" } } },
            { mark: { type: "point", filled: true, size: 90 }, encoding: { y: { field: "measure", type: "nominal", sort: null }, x: { field: "estimate", type: "quantitative" }, tooltip: [{ field: "measure" }, { field: "estimate", format: ".4f" }, { field: "lower", format: ".4f" }, { field: "upper", format: ".4f" }, { field: "intervalMethod" }] } },
          ],
          description: "Point estimates with intervals; proportions and ratios share one axis, so read each row against its own definition column.",
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "A test, score, or rule has been reduced to a yes/no call at one declared threshold and the paper has to state how often that call is right, separately among people who do and do not have the condition.",
    decision: "Whether the test performs well enough at this cut-off to be used for the stated purpose (ruling in, ruling out, or triage), and what a positive or negative result actually implies about a patient in the intended setting.",
    mustShow: "The 2x2 table, sensitivity and specificity with exact intervals, predictive values with the prevalence they were computed at, both likelihood ratios and the diagnostic odds ratio with intervals, and an explicit statement of whether the threshold was fixed in advance.",
    userGoal: "Report accuracy in the STARD format and let a reader carry the result to their own setting, where the prevalence is usually not the prevalence of the study sample.",
    nextActions: [
      { trigger: "sampling-design-is-case-control", action: "recompute-predictive-values-at-a-declared-target-prevalence", reason: "In a case-control sample the number of cases and controls is chosen by the investigator, so the tabulated PPV and NPV describe the sampling ratio rather than any population; only sensitivity, specificity, and the likelihood ratios transfer." },
      { trigger: "intended-setting-prevalence-differs-from-sample-prevalence", action: "recompute-predictive-values-at-the-intended-setting-prevalence-and-report-both", reason: "PPV and NPV move with prevalence even when the test does not change, so a screening PPV taken from a referral cohort will be far too high." },
      { trigger: "threshold-was-chosen-on-these-data", action: "declare-the-threshold-as-data-derived-and-validate-it-on-a-separate-sample", reason: "A cut-off picked to maximize Youden J on the same data biases every measure in this table upward." },
      { trigger: "a-cell-of-the-table-is-empty", action: "report-the-exact-one-sided-bound-and-withhold-the-likelihood-ratios", reason: "An empty cell makes the ratios infinite or zero; a continuity correction would invent an estimate the data do not contain." },
      { trigger: "sensitivity-and-specificity-trade-off-matters-clinically", action: "report-the-full-roc-curve-or-compare-thresholds-explicitly", reason: "One threshold hides the trade-off; the diagnostic odds ratio compresses it into a single number that cannot be acted on." },
    ],
  },
  fixture: {
    data: {
      testLabel: "Rapid antigen test",
      conditionLabel: "Infection",
      counts: { truePositive: 84, falseNegative: 16, falsePositive: 30, trueNegative: 470 },
    },
    options: { confidenceLevel: 0.95, targetPrevalence: 0.02, samplingDesign: "cohort" },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.classification"] },
  coverage: {
    implementedBoundary: "Sensitivity, specificity, accuracy, prevalence and both predictive values with Clopper-Pearson exact intervals from a 2x2 table or from a score classified at one declared threshold, plus both likelihood ratios, the diagnostic odds ratio and Youden J with log-normal intervals, and predictive values recomputed at one declared external prevalence; no multi-threshold summary, no clustered or repeated-measures data, no comparison between two tests, and no verification-bias correction.",
    oracle: {
      level: "external-library-partial",
      evidence: [ORACLE_FILE],
      verifiedOutputs: [
        "Clopper-Pearson bounds for sensitivity, specificity, accuracy, prevalence, PPV and NPV (statsmodels.stats.proportion.proportion_confint method='beta')",
        "point estimates of sensitivity, specificity, PPV, NPV and accuracy (sklearn.metrics.confusion_matrix)",
        "likelihood ratios, diagnostic odds ratio and their log-normal bounds (numpy re-derivation of Simel 1991 and the Woolf standard error)",
        "predictive values recomputed at a declared prevalence, against Bayes' rule applied directly to sensitivity and specificity",
        "the 2x2 table produced by applying a declared threshold to a score vector",
      ],
      excludedOutputs: [
        "an exact interval for Youden J (the reported bounds are the conservative sum of two exact bounds)",
        "exact intervals for the likelihood ratios and the diagnostic odds ratio",
        "verification-bias-corrected accuracy",
        "comparison of two tests on the same subjects",
      ],
    },
    diagnostic: {
      level: "method-specific-partial",
      emitted: ["cell counts", "predictive value validity", "interval methods", "likelihood ratio definition", "threshold provenance"],
      limitations: [
        "whether the threshold was pre-specified cannot be verified from the data and is reported as a design question",
        "verification bias and spectrum bias are not detectable here",
        "the prevalence-adjusted predictive value interval treats the declared prevalence as known without error",
      ],
    },
    knownGaps: [
      "no exact interval for Youden J, the likelihood ratios, or the diagnostic odds ratio",
      "no correction for partial or differential verification bias",
      "no paired comparison of two tests (McNemar on discordant pairs) in this method",
      "no clustered or multi-reader accuracy",
      "the declared prevalence contributes no uncertainty to the adjusted predictive value interval",
    ],
  },
};

// ---------------------------------------------------------------------------------------------
// 3. fine_gray_subdistribution_hazard
// ---------------------------------------------------------------------------------------------

/**
 * Kaplan-Meier estimate of the censoring survival function G, with censoring treated as the event.
 * The usual convention is used: at a shared time, events are taken to occur before censorings, so a
 * subject censored at time t is still in the risk set for an event at t.
 *
 * Exposes at(t) = G(t) and before(t) = G(t-). Both are needed: the Fine-Gray weight of a subject who
 * already failed from a competing cause at T and is carried into the risk set at t is G(t-)/G(T).
 */
function censoringSurvival(time, event, H, budget) {
  const n = time.length;
  const order = Array.from({ length: n }, (_, index) => index).sort((a, b) => time[a] - time[b] || a - b);
  const times = [];
  const gAt = [];
  let survival = 1;
  let atRisk = n;
  let cursor = 0;
  while (cursor < n) {
    budget.check();
    const current = time[order[cursor]];
    let censored = 0;
    let block = 0;
    while (cursor < n && time[order[cursor]] === current) {
      if (event[order[cursor]] === 0) censored += 1;
      block += 1;
      cursor += 1;
    }
    times.push(current);
    if (censored > 0) {
      if (!(atRisk > 0)) H.fail("STAT_DEGENERATE", "censoring risk set is empty");
      survival *= 1 - censored / atRisk;
    }
    gAt.push(survival);
    atRisk -= block;
  }
  const lookup = (value, series) => {
    // G(value): largest observed time at or before `value`; 1 before the first observed time
    let low = 0;
    let high = times.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (times[mid] <= value) { found = mid; low = mid + 1; } else high = mid - 1;
    }
    return found < 0 ? 1 : series[found];
  };
  return {
    times,
    gAt,
    at(value) { return lookup(value, gAt); },
    before(value) {
      // G(value-) = G evaluated over censoring times strictly before `value`
      let low = 0;
      let high = times.length - 1;
      let found = -1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (times[mid] < value) { found = mid; low = mid + 1; } else high = mid - 1;
      }
      return found < 0 ? 1 : gAt[found];
    },
  };
}

/**
 * Fine-Gray risk-set sums at every event time of the cause of interest.
 *
 * The subdistribution risk set at t is
 *   {j : T_j >= t}                                     with weight 1, and
 *   {j : T_j < t and j failed from a competing cause}  with weight G(t-)/G(T_j).
 * Because G(t-) does not depend on j, the second block factorizes:
 *   S0(t) = R0(t) + G(t-) * A0(t)   with   A0(t) = sum over that block of exp(eta_j)/G(T_j).
 * R is accumulated by a descending sweep and A by an ascending sweep, so both are additive and the
 * whole state costs O(n * p^2) per iteration rather than O(events * n * p^2).
 */
function fineGrayState(H, model, beta, budget, wantResiduals = false) {
  const { rows, eventTimes, p, censoring } = model;
  const n = rows.length;
  const eta = rows.map((row) => dot(row.x, beta));
  if (eta.some((value) => !Number.isFinite(value) || Math.abs(value) > 700)) H.fail("STAT_NON_CONVERGENCE", "Fine-Gray linear predictor diverged");
  const shift = Math.max(...eta);
  const weight = eta.map((value) => Math.exp(value - shift));

  // Descending sweep: R sums over {T_j >= t}.
  const rAtTime = new Map();
  {
    let r0 = 0;
    const r1 = zeros(p);
    const r2 = zeroMatrix(p);
    let cursor = n - 1;
    while (cursor >= 0) {
      budget.check();
      const current = rows[cursor].time;
      while (cursor >= 0 && rows[cursor].time === current) {
        r0 += weight[cursor];
        for (let j = 0; j < p; j += 1) {
          r1[j] += weight[cursor] * rows[cursor].x[j];
          for (let l = 0; l < p; l += 1) r2[j][l] += weight[cursor] * rows[cursor].x[j] * rows[cursor].x[l];
        }
        cursor -= 1;
      }
      rAtTime.set(current, { r0, r1: [...r1], r2: r2.map((row) => [...row]) });
    }
  }
  // Ascending sweep: A sums over competing-cause failures already past.
  const aAtTime = new Map();
  {
    let a0 = 0;
    const a1 = zeros(p);
    const a2 = zeroMatrix(p);
    let cursor = 0;
    while (cursor < n) {
      budget.check();
      const current = rows[cursor].time;
      aAtTime.set(current, { a0, a1: [...a1], a2: a2.map((row) => [...row]) });
      while (cursor < n && rows[cursor].time === current) {
        if (rows[cursor].competing) {
          const scale = weight[cursor] / rows[cursor].gAtOwnTime;
          a0 += scale;
          for (let j = 0; j < p; j += 1) {
            a1[j] += scale * rows[cursor].x[j];
            for (let l = 0; l < p; l += 1) a2[j][l] += scale * rows[cursor].x[j] * rows[cursor].x[l];
          }
        }
        cursor += 1;
      }
    }
  }

  let logLikelihood = 0;
  const score = zeros(p);
  const information = zeroMatrix(p);
  const blocks = [];
  let tiedEventTimes = 0;

  for (const eventTime of eventTimes) {
    budget.check();
    const t = eventTime.time;
    const gBefore = censoring.before(t);
    const r = rAtTime.get(t);
    const a = aAtTime.get(t);
    const s0 = r.r0 + gBefore * a.a0;
    const s1 = zeros(p);
    const s2 = zeroMatrix(p);
    for (let j = 0; j < p; j += 1) {
      s1[j] = r.r1[j] + gBefore * a.a1[j];
      for (let l = 0; l < p; l += 1) s2[j][l] = r.r2[j][l] + gBefore * a.a2[j][l];
    }
    const deaths = eventTime.indices;
    const d = deaths.length;
    if (d > 1) tiedEventTimes += 1;
    let e0 = 0;
    const e1 = zeros(p);
    const e2 = zeroMatrix(p);
    for (const i of deaths) {
      logLikelihood += eta[i];
      e0 += weight[i];
      for (let j = 0; j < p; j += 1) {
        score[j] += rows[i].x[j];
        e1[j] += weight[i] * rows[i].x[j];
        for (let l = 0; l < p; l += 1) e2[j][l] += weight[i] * rows[i].x[j] * rows[i].x[l];
      }
    }
    const repeats = model.ties === "efron" ? d : 1;
    const multiplicity = model.ties === "efron" ? 1 : d;
    const means = [];
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const fraction = model.ties === "efron" ? repeat / d : 0;
      const denominator = s0 - fraction * e0;
      if (!(denominator > 1e-300)) H.fail("STAT_NUMERIC_FAILURE", "Fine-Gray subdistribution risk-set denominator is non-positive");
      logLikelihood -= multiplicity * (Math.log(denominator) + shift);
      const expected = zeros(p);
      for (let j = 0; j < p; j += 1) expected[j] = (s1[j] - fraction * e1[j]) / denominator;
      for (let j = 0; j < p; j += 1) {
        score[j] -= multiplicity * expected[j];
        for (let l = 0; l < p; l += 1) information[j][l] += multiplicity * ((s2[j][l] - fraction * e2[j][l]) / denominator - expected[j] * expected[l]);
      }
      means.push(expected);
    }
    if (wantResiduals) {
      // Breslow-form quantities: one mean and one 1/S0 term per event time, weighted by d.
      const breslowMean = zeros(p);
      for (let j = 0; j < p; j += 1) breslowMean[j] = s1[j] / s0;
      blocks.push({ time: t, deaths: d, s0, gBefore, mean: breslowMean });
    }
  }
  return { logLikelihood, score, information, blocks, tiedEventTimes, eta, weight, shift };
}

/**
 * Score (dfbeta-style) residuals for the Fine-Gray fit, Breslow form.
 *
 *   L_i = 1{cause of interest} (x_i - xbar(T_i))
 *         - exp(eta_i) [ sum_{t_j <= T_i} (x_i - xbar(t_j)) d_j / S0(t_j)
 *                      + 1{competing} / G(T_i) * sum_{t_j > T_i} G(t_j-) (x_i - xbar(t_j)) d_j / S0(t_j) ]
 *
 * The first bracket is the ordinary at-risk contribution (weight 1 while T_i >= t_j); the second is
 * the IPCW contribution a competing-cause failure keeps making after its own failure time. Both are
 * prefix and suffix cumulative sums over the event times, so this costs O((n + events) * p).
 */
function fineGrayScoreResiduals(H, model, state, budget) {
  const { rows, p } = model;
  const blocks = state.blocks;
  const prefix0 = Array(blocks.length + 1).fill(0);
  const prefix1 = Array.from({ length: blocks.length + 1 }, () => zeros(p));
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const factor = block.deaths / block.s0;
    prefix0[index + 1] = prefix0[index] + factor;
    for (let j = 0; j < p; j += 1) prefix1[index + 1][j] = prefix1[index][j] + factor * block.mean[j];
  }
  const suffix0 = Array(blocks.length + 1).fill(0);
  const suffix1 = Array.from({ length: blocks.length + 1 }, () => zeros(p));
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    const factor = block.gBefore * block.deaths / block.s0;
    suffix0[index] = suffix0[index + 1] + factor;
    for (let j = 0; j < p; j += 1) suffix1[index][j] = suffix1[index + 1][j] + factor * block.mean[j];
  }
  const times = blocks.map((block) => block.time);
  const countAtOrBefore = (value) => {
    let low = 0;
    let high = times.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (times[mid] <= value) { found = mid; low = mid + 1; } else high = mid - 1;
    }
    return found + 1;
  };
  // The Breslow-form mean is used for every term, including the event term, so the residual is the
  // same one an implementation that reports Breslow-form score residuals would produce.
  const meanAt = new Map(blocks.map((block) => [block.time, block.mean]));
  return rows.map((row, index) => {
    budget.check();
    const residual = zeros(p);
    const cut = countAtOrBefore(row.time);
    // state.weight[i] is exp(eta_i - shift) and every S0 in `blocks` carries the same shift, so this
    // ratio is exp(eta_i) / S0 on the unshifted scale.
    const exponential = state.weight[index];
    for (let j = 0; j < p; j += 1) {
      residual[j] -= exponential * (row.x[j] * prefix0[cut] - prefix1[cut][j]);
      if (row.competing) residual[j] -= exponential * (row.x[j] * suffix0[cut] - suffix1[cut][j]) / row.gAtOwnTime;
    }
    if (row.eventOfInterest) {
      const mean = meanAt.get(row.time);
      for (let j = 0; j < p; j += 1) residual[j] += row.x[j] - mean[j];
    }
    return residual;
  });
}

const fineGraySubdistributionHazard = {
  method: "fine_gray_subdistribution_hazard",
  family: "survival",
  analysisModel: COMPETING_RISK_MODEL,
  optionKeys: ["confidenceLevel", "ties", "maxIterations", "tolerance", "timeoutMs"],
  customOptions: {
    causeOfInterest: {
      schema: { type: "integer", minimum: 1, maximum: MAX_CAUSES },
      default: 1,
      parse(value, H, path) { return H.integer(value, 1, MAX_CAUSES, path); },
    },
    robust: {
      schema: { type: "boolean" },
      default: true,
      parse(value, H, path) { if (typeof value !== "boolean") H.fail("STAT_INVALID_INPUT", `${path} must be boolean`); return value; },
    },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["time", "event", "predictors"],
    properties: {
      time: { type: "array", minItems: 10, maxItems: MAX_FG_ROWS, items: { type: "number", exclusiveMinimum: 0 } },
      event: { type: "array", minItems: 10, maxItems: MAX_FG_ROWS, items: { type: "integer", minimum: 0, maximum: MAX_CAUSES } },
      predictors: {
        type: "array",
        minItems: 1,
        maxItems: MAX_FG_PREDICTORS,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["values"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 128 },
            values: { type: "array", minItems: 10, maxItems: MAX_FG_ROWS, items: { type: "number" } },
          },
        },
      },
      causeLabels: { type: "array", minItems: 1, maxItems: MAX_CAUSES, items: { type: "string", minLength: 1, maxLength: 128 } },
      outcomeLabel: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["time", "event", "predictors", "causeLabels", "outcomeLabel"], "data");
    const time = H.numericVector(data.time, "data.time", 10);
    if (time.length > MAX_FG_ROWS) H.fail("STAT_LIMIT_EXCEEDED", `data.time exceeds ${MAX_FG_ROWS} rows`);
    if (time.some((value) => value <= 0)) H.fail("STAT_INVALID_INPUT", "data.time must contain only positive durations");
    if (!Array.isArray(data.event) || data.event.length !== time.length) H.fail("STAT_INVALID_INPUT", "data.event must match data.time length");
    const event = data.event.map((value, index) => H.integer(value, 0, MAX_CAUSES, `data.event[${index}]`));
    const causes = Math.max(...event);
    if (causes < 2) H.fail("STAT_INVALID_INPUT", "Fine-Gray regression requires at least two competing causes coded 1..K (0 = censored)");
    for (let k = 1; k <= causes; k += 1) if (!event.includes(k)) H.fail("STAT_DEGENERATE", `cause ${k} has no observed events; recode causes consecutively`);
    if (options.causeOfInterest > causes) H.fail("STAT_INVALID_INPUT", `options.causeOfInterest exceeds the ${causes} coded causes`);
    const eventsOfInterest = event.filter((value) => value === options.causeOfInterest).length;
    if (eventsOfInterest < 3) H.fail("STAT_INSUFFICIENT_SAMPLE", "Fine-Gray regression requires at least three events of the cause of interest");
    if (!Array.isArray(data.predictors) || data.predictors.length < 1 || data.predictors.length > MAX_FG_PREDICTORS) {
      H.fail("STAT_INVALID_INPUT", `data.predictors length must be between 1 and ${MAX_FG_PREDICTORS}`);
    }
    const seen = new Set();
    const predictors = data.predictors.map((rawPredictor, index) => {
      const predictor = H.assertObject(rawPredictor, `data.predictors[${index}]`);
      H.assertKeys(predictor, ["name", "values"], `data.predictors[${index}]`);
      const name = H.label(predictor.name, `X${index + 1}`, `data.predictors[${index}].name`);
      if (seen.has(name)) H.fail("STAT_INVALID_INPUT", `duplicate predictor name: ${name}`);
      seen.add(name);
      const values = H.numericVector(predictor.values, `data.predictors[${index}].values`, 10);
      if (values.length !== time.length) H.fail("STAT_INVALID_INPUT", `predictor ${name} length does not match data.time`);
      const range = H.minMax(values);
      if (range.min === range.max) H.fail("STAT_DEGENERATE", `predictor ${name} is constant`);
      return { name, values };
    });
    if (eventsOfInterest < predictors.length + 1) H.fail("STAT_INSUFFICIENT_SAMPLE", "Fine-Gray regression needs more events of the cause of interest than predictors");
    let causeLabels = null;
    if (data.causeLabels !== undefined) {
      causeLabels = H.categoryVector(data.causeLabels, "data.causeLabels", 1);
      if (causeLabels.length !== causes) H.fail("STAT_INVALID_INPUT", `data.causeLabels must contain exactly ${causes} labels`);
      if (new Set(causeLabels).size !== causes) H.fail("STAT_INVALID_INPUT", "data.causeLabels must be unique");
    }
    return {
      time,
      event,
      causes,
      predictors,
      causeLabels: causeLabels || Array.from({ length: causes }, (_, index) => `cause ${index + 1}`),
      outcomeLabel: H.label(data.outcomeLabel, "Event", "data.outcomeLabel"),
    };
  },
  analyze(parsed, options, budget, H) {
    const n = parsed.time.length;
    const p = parsed.predictors.length;
    const cause = options.causeOfInterest;
    const causeLabel = parsed.causeLabels[cause - 1];
    const z = zCritical(H, options.confidenceLevel);

    // Standardize predictors for the Newton solve; coefficients and errors are returned on the
    // original scale. Centering does not change a partial-likelihood coefficient.
    const centres = parsed.predictors.map((predictor) => H.mean(predictor.values, budget));
    const scales = parsed.predictors.map((predictor, index) => {
      const sd = Math.sqrt(H.variance(predictor.values, true, budget));
      if (!(sd > 0)) H.fail("STAT_DEGENERATE", `predictor ${parsed.predictors[index].name} has zero variance`);
      return sd;
    });

    const censoring = censoringSurvival(parsed.time, parsed.event, H, budget);
    const rows = Array.from({ length: n }, (_, index) => {
      const own = censoring.at(parsed.time[index]);
      const competing = parsed.event[index] !== 0 && parsed.event[index] !== cause;
      if (competing && !(own > 0)) H.fail("STAT_DEGENERATE", "the censoring distribution reaches zero at a competing event time, so its inverse-probability weight is undefined");
      return {
        index,
        time: parsed.time[index],
        event: parsed.event[index],
        eventOfInterest: parsed.event[index] === cause,
        competing,
        gAtOwnTime: own,
        x: parsed.predictors.map((predictor, column) => (predictor.values[index] - centres[column]) / scales[column]),
      };
    }).sort((a, b) => a.time - b.time || a.index - b.index);

    const eventTimes = [];
    for (let cursor = 0; cursor < rows.length;) {
      const current = rows[cursor].time;
      const indices = [];
      while (cursor < rows.length && rows[cursor].time === current) {
        if (rows[cursor].eventOfInterest) indices.push(cursor);
        cursor += 1;
      }
      if (indices.length) eventTimes.push({ time: current, indices });
    }
    const model = { rows, eventTimes, p, censoring, ties: options.ties };

    let beta = zeros(p);
    const nullState = fineGrayState(H, model, beta, budget);
    let current = nullState;
    let converged = false;
    let iterations = 0;
    for (iterations = 1; iterations <= options.maxIterations; iterations += 1) {
      budget.check(2048);
      const inverse = safeInvert(H, current.information, "Fine-Gray information matrix");
      const direction = matVec(inverse, current.score);
      let factor = 1;
      let next = null;
      let candidate = null;
      while (factor >= 1 / 1024) {
        candidate = beta.map((value, index) => value + factor * direction[index]);
        if (candidate.some((value) => !Number.isFinite(value) || Math.abs(value) > 30)) { factor /= 2; continue; }
        next = fineGrayState(H, model, candidate, budget);
        if (next.logLikelihood >= current.logLikelihood - 1e-10) break;
        factor /= 2;
        next = null;
      }
      if (!next) H.fail("STAT_NON_CONVERGENCE", "Fine-Gray weighted partial-likelihood line search failed");
      const delta = Math.max(...candidate.map((value, index) => Math.abs(value - beta[index])));
      beta = candidate;
      current = next;
      if (delta < options.tolerance && Math.max(...current.score.map(Math.abs)) < Math.sqrt(options.tolerance)) { converged = true; break; }
    }
    if (!converged) H.fail("STAT_NON_CONVERGENCE", `Fine-Gray regression did not converge in ${options.maxIterations} iterations`);

    const finalState = fineGrayState(H, model, beta, budget, true);
    const naive = safeInvert(H, finalState.information, "Fine-Gray information matrix");
    let robust = null;
    if (options.robust) {
      const residuals = fineGrayScoreResiduals(H, model, finalState, budget);
      const meat = zeroMatrix(p);
      for (const residual of residuals) {
        budget.check();
        for (let j = 0; j < p; j += 1) for (let l = 0; l < p; l += 1) meat[j][l] += residual[j] * residual[l];
      }
      const left = H.matMul(naive, meat, budget);
      robust = H.matMul(left, naive, budget);
    }
    const reported = options.robust ? robust : naive;

    const coefficients = parsed.predictors.map((predictor, index) => {
      const estimate = beta[index] / scales[index];
      const naiveStandardError = Math.sqrt(Math.max(0, naive[index][index])) / scales[index];
      const robustStandardError = robust ? Math.sqrt(Math.max(0, robust[index][index])) / scales[index] : null;
      const standardError = Math.sqrt(Math.max(0, reported[index][index])) / scales[index];
      if (!(standardError > 0)) H.fail("STAT_DEGENERATE", `Fine-Gray standard error is zero for ${predictor.name}`);
      const statistic = estimate / standardError;
      const lower = estimate - z * standardError;
      const upper = estimate + z * standardError;
      if ([estimate, lower, upper].some((value) => Math.abs(value) > 700)) H.fail("STAT_NON_CONVERGENCE", `Fine-Gray subdistribution hazard ratio scale diverged for ${predictor.name}`);
      return {
        term: predictor.name,
        estimate: finite(H, estimate, `${predictor.name} log subdistribution hazard ratio`),
        standardError,
        naiveStandardError,
        robustStandardError,
        statistic,
        pValue: twoSidedNormalP(H, statistic),
        lower,
        upper,
        subdistributionHazardRatio: Math.exp(estimate),
        hazardRatioLower: Math.exp(lower),
        hazardRatioUpper: Math.exp(upper),
      };
    });

    const likelihoodRatio = 2 * (finalState.logLikelihood - nullState.logLikelihood);
    const waldVector = coefficients.map((row) => row.estimate * scales[parsed.predictors.findIndex((predictor) => predictor.name === row.term)]);
    const waldGlobal = Math.max(0, dot(waldVector, matVec(safeInvert(H, reported, "Fine-Gray reported covariance"), waldVector)));
    const scoreGlobal = Math.max(0, dot(nullState.score, matVec(safeInvert(H, nullState.information, "Fine-Gray null information"), nullState.score)));

    const eventCounts = {
      censored: parsed.event.filter((value) => value === 0).length,
      ...Object.fromEntries(parsed.causeLabels.map((labelText, index) => [`events_${index + 1}`, parsed.event.filter((value) => value === index + 1).length])),
    };
    const eventsOfInterest = parsed.event.filter((value) => value === cause).length;
    const competingEvents = parsed.event.filter((value) => value !== 0 && value !== cause).length;
    const weightRows = model.eventTimes.map((eventTime) => {
      const gBefore = censoring.before(eventTime.time);
      const carried = rows.filter((row) => row.competing && row.time < eventTime.time);
      return {
        time: eventTime.time,
        eventsOfInterest: eventTime.indices.length,
        atRisk: rows.filter((row) => row.time >= eventTime.time).length,
        carriedCompetingFailures: carried.length,
        censoringSurvivalBefore: gBefore,
        totalSubdistributionWeight: rows.filter((row) => row.time >= eventTime.time).length + carried.reduce((total, row) => total + gBefore / row.gAtOwnTime, 0),
      };
    });

    const coefficientColumns = [
      { key: "term", label: "Term", type: "string" },
      { key: "estimate", label: "Log SHR", type: "number" },
      { key: "standardError", label: options.robust ? "Robust SE" : "SE", type: "number" },
      { key: "naiveStandardError", label: "Model-based SE", type: "number" },
      { key: "robustStandardError", label: "Robust SE", type: "number" },
      { key: "statistic", label: "z", type: "number" },
      { key: "pValue", label: "p", type: "number" },
      { key: "subdistributionHazardRatio", label: "SHR", type: "number" },
      { key: "hazardRatioLower", label: "SHR CI lower", type: "number" },
      { key: "hazardRatioUpper", label: "SHR CI upper", type: "number" },
    ];
    const weightColumns = [
      { key: "time", label: "Event time", type: "number" },
      { key: "eventsOfInterest", label: `${causeLabel} events`, type: "number" },
      { key: "atRisk", label: "Still at risk", type: "number" },
      { key: "carriedCompetingFailures", label: "Carried competing failures", type: "number" },
      { key: "censoringSurvivalBefore", label: "G(t-)", type: "number" },
      { key: "totalSubdistributionWeight", label: "Subdistribution risk set", type: "number" },
    ];

    return {
      sample: {
        n,
        predictors: p,
        causes: parsed.causes,
        causeOfInterest: cause,
        causeLabel,
        eventsOfInterest,
        competingEvents,
        censored: eventCounts.censored,
        counts: eventCounts,
        distinctEventTimes: model.eventTimes.length,
      },
      estimates: coefficients.map((row) => ({
        name: `${row.term} log subdistribution hazard ratio`,
        estimate: row.estimate,
        standardError: row.standardError,
        naiveStandardError: row.naiveStandardError,
        robustStandardError: row.robustStandardError,
        subdistributionHazardRatio: row.subdistributionHazardRatio,
      })),
      tests: [
        ...coefficients.map((row) => ({ name: `${row.term} Wald test`, statistic: row.statistic, distribution: "normal", pValue: row.pValue })),
        { name: options.robust ? "Global Wald test (robust covariance)" : "Global Wald test", statistic: waldGlobal, distribution: "chi-square", df: p, pValue: H.pFromChiSquare(waldGlobal, p) },
        { name: "Weighted partial likelihood-ratio test", statistic: likelihoodRatio, distribution: "chi-square", df: p, pValue: H.pFromChiSquare(likelihoodRatio, p), boundary: "the weighted partial likelihood is not a likelihood, so this reference distribution is approximate under estimated censoring weights" },
        { name: "Score test at beta = 0", statistic: scoreGlobal, distribution: "chi-square", df: p, pValue: H.pFromChiSquare(scoreGlobal, p) },
      ],
      confidenceIntervals: [
        ...coefficients.map((row) => ({ parameter: `${row.term} log subdistribution hazard ratio`, level: options.confidenceLevel, lower: row.lower, upper: row.upper, method: options.robust ? "Wald normal on the score-residual sandwich variance" : "Wald normal on the inverse weighted information" })),
        ...coefficients.map((row) => ({ parameter: `${row.term} subdistribution hazard ratio`, level: options.confidenceLevel, lower: row.hazardRatioLower, upper: row.hazardRatioUpper, method: "exponentiated Wald interval" })),
      ],
      effectSizes: coefficients.map((row) => ({
        name: `${row.term} subdistribution hazard ratio`,
        estimate: row.subdistributionHazardRatio,
        lower: row.hazardRatioLower,
        upper: row.hazardRatioUpper,
        interpretationBoundary: `effect on the cumulative incidence of ${causeLabel}; it is not a cause-specific hazard ratio and does not describe the rate among subjects who are still event-free`,
      })),
      assumptions: [
        { name: "proportional subdistribution hazards", status: "not_established", note: "The model assumes the covariate effect on the subdistribution hazard is constant over time; no time-varying-effect test is computed here." },
        { name: "censoring is independent of covariates and of both event types", status: "requires_design_review", note: "The inverse-probability weights use one pooled Kaplan-Meier censoring curve, so covariate-dependent censoring is not corrected." },
        { name: "competing events are terminal and mutually exclusive", status: "verified_by_input_contract" },
        { name: "independent observations", status: "requires_design_review" },
        { name: "the subdistribution risk set keeps competing-cause failures under IPCW", status: "method_definition", note: "This is what makes the coefficient a statement about cumulative incidence rather than about instantaneous rate." },
      ],
      diagnostics: [
        { name: "weighted partial-likelihood convergence", status: "converged", iterations, ties: options.ties, tiedEventTimes: finalState.tiedEventTimes, maxAbsoluteScore: Math.max(...finalState.score.map(Math.abs)), logLikelihood: finalState.logLikelihood, nullLogLikelihood: nullState.logLikelihood },
        { name: "event accounting", status: "evaluated", counts: eventCounts, causeOfInterest: cause, causeLabel, eventsPerPredictor: eventsOfInterest / p, note: eventsOfInterest / p < 10 ? "Fewer than ten events of interest per predictor; the Wald interval is optimistic." : "At least ten events of interest per predictor." },
        {
          name: "censoring weight boundary",
          status: "asymptotic",
          censoringSurvivalAtLastEvent: censoring.before(model.eventTimes[model.eventTimes.length - 1].time),
          minimumCarriedWeightDenominator: Math.min(1, ...rows.filter((row) => row.competing).map((row) => row.gAtOwnTime)),
          detail: "Weights are G(t-)/G(T_i) with the convention that events precede censorings at a shared time. The reported robust variance is the score-residual sandwich; it does not include the Fine-Gray (1999) correction term for the fact that G itself is estimated, so it is exact only when there is no censoring and is a partial correction otherwise.",
        },
        { name: "variance estimator", status: options.robust ? "score_residual_sandwich" : "model_based", detail: options.robust ? "V = I^-1 (sum_i L_i L_i') I^-1 with Breslow-form score residuals L_i" : "inverse of the weighted observed information" },
        { name: "subdistribution risk set", status: "evaluated", distinctEventTimes: model.eventTimes.length, carriedCompetingFailuresAtLastEventTime: weightRows[weightRows.length - 1].carriedCompetingFailures, detail: "Subjects who failed from a competing cause stay in the risk set with a decaying inverse-probability-of-censoring weight instead of being removed." },
        { name: "proportional subdistribution hazards diagnostic", status: "not_evaluated", reason: "no scaled-Schoenfeld test is implemented for the weighted risk set; assess by fitting over time windows" },
      ],
      artifacts: [
        H.tableArtifact(
          `Fine-Gray subdistribution hazard model for ${causeLabel}: ${parsed.outcomeLabel}`,
          `Weighted partial-likelihood fit (${options.ties} ties, ${options.robust ? "score-residual robust" : "model-based"} standard errors) on ${eventsOfInterest} events of interest with ${competingEvents} competing events.`,
          coefficientColumns,
          coefficients.map(({ lower, upper, ...row }) => row),
          [`${percent(options.confidenceLevel)}% Wald intervals; weighted likelihood-ratio chi-square(${p}) = ${likelihoodRatio}.`, "A subdistribution hazard ratio describes the cumulative incidence of the cause of interest, not the rate among the still-event-free."],
          "fine-gray-coefficient-table",
        ),
        H.tableArtifact(
          `Subdistribution risk set for ${causeLabel}`,
          "At each event time of the cause of interest: how many subjects are still at risk, how many competing-cause failures are carried forward, and the censoring survival that scales their weight.",
          weightColumns,
          weightRows,
          [],
          "fine-gray-risk-set-table",
        ),
        H.vegaArtifact("fine-gray-subdistribution-hazard-plot", `Subdistribution hazard ratios for ${causeLabel}`, {
          data: { values: coefficients.map(({ lower, upper, ...row }) => row) },
          layer: [
            { mark: { type: "rule", strokeWidth: 2 }, encoding: { y: { field: "term", type: "nominal", title: null, sort: null }, x: { field: "hazardRatioLower", type: "quantitative", title: "Subdistribution hazard ratio", scale: { type: "log" } }, x2: { field: "hazardRatioUpper" } } },
            { mark: { type: "point", filled: true, size: 90 }, encoding: { y: { field: "term", type: "nominal", sort: null }, x: { field: "subdistributionHazardRatio", type: "quantitative", scale: { type: "log" } }, tooltip: [{ field: "term" }, { field: "subdistributionHazardRatio", format: ".4f" }, { field: "hazardRatioLower", format: ".4f" }, { field: "hazardRatioUpper", format: ".4f" }, { field: "pValue", format: ".4g" }] } },
          ],
          description: "Subdistribution hazard ratios on a log axis with Wald intervals; a ratio of one is no effect on cumulative incidence.",
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "Subjects can fail from more than one mutually exclusive cause and the question is how a covariate changes the absolute probability of one particular cause by a given time, not merely whether the groups' incidence curves differ.",
    decision: "Whether a covariate raises or lowers the cumulative incidence of the cause of interest, by how much, and with what precision, once the competing events are prevented from being treated as ordinary censoring.",
    mustShow: "Subdistribution hazard ratios with robust standard errors and intervals, the event accounting by cause, the ties handling, the convergence state, the censoring-weight boundary, and the explicit statement that a subdistribution hazard ratio is not a cause-specific hazard ratio.",
    userGoal: "Move from describing cumulative incidence to modelling it, so a competing-risks paper can report an adjusted effect on absolute risk in the same table as the incidence curves.",
    nextActions: [
      { trigger: "subdistribution-and-cause-specific-effects-point-in-different-directions", action: "report-both-models-and-say-which-question-each-answers", reason: "A covariate can raise the rate of the cause of interest while lowering its cumulative incidence, because it also raises the competing event; only reporting both makes that visible." },
      { trigger: "competing-event-is-frequent", action: "report-cumulative-incidence-curves-alongside-the-model", reason: "With a dominant competing event the subdistribution hazard ratio is hard to read on its own; the incidence curves show the absolute scale it acts on." },
      { trigger: "robust-and-model-based-se-diverge", action: "report-the-robust-interval-and-review-censoring-and-clustering", reason: "A large gap indicates estimated weights, correlated observations, or misspecification that the model-based error ignores." },
      { trigger: "censoring-depends-on-a-covariate", action: "stratify-the-censoring-weights-or-declare-the-limitation", reason: "The weights here come from one pooled censoring curve, so covariate-dependent censoring biases the subdistribution estimate." },
      { trigger: "few-events-of-the-cause-of-interest", action: "reduce-predictors-or-report-the-events-per-variable-boundary", reason: "The Wald interval is asymptotic; fewer than about ten events of interest per predictor makes it optimistic." },
      { trigger: "effect-appears-to-change-over-follow-up", action: "fit-over-time-windows-or-add-a-time-interaction-elsewhere", reason: "Proportional subdistribution hazards is assumed, not tested, by this method." },
    ],
  },
  fixture: {
    data: {
      outcomeLabel: "Relapse",
      causeLabels: ["relapse", "death without relapse"],
      time: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41],
      event: [1, 2, 1, 0, 1, 2, 1, 1, 0, 2, 1, 1, 2, 0, 1, 2, 1, 0, 1, 2, 0, 1, 1, 2, 1, 0, 2, 1, 0, 1, 2, 1, 0, 1, 2, 1, 0, 2, 1, 1],
      predictors: [
        { name: "treatment", values: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0] },
        { name: "age", values: [61, 54, 48, 70, 66, 59, 44, 73, 52, 68, 57, 63, 49, 71, 55, 60, 46, 74, 58, 65, 50, 69, 53, 62, 47, 72, 56, 64, 51, 67, 45, 75, 59, 61, 48, 70, 54, 66, 43, 68] },
      ],
    },
    options: { causeOfInterest: 1, ties: "efron", robust: true, confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "Fine-Gray proportional subdistribution hazards regression for one declared cause among up to 8 competing causes, 10 to 2000 right-censored rows and up to 8 numeric predictors, with inverse-probability-of-censoring weights from a single pooled Kaplan-Meier censoring curve, Efron or Breslow ties, model-based and Breslow-form score-residual robust covariance, and Wald, weighted likelihood-ratio and score tests; no time-varying covariates, no strata, no covariate-dependent censoring weights, no scaled-Schoenfeld test for the weighted risk set, and no correction term for the fact that the censoring distribution is estimated.",
    oracle: {
      level: "external-library-partial",
      evidence: [ORACLE_FILE],
      verifiedOutputs: [
        "coefficients, model-based standard errors, subdistribution hazard ratios and log partial likelihood on uncensored data (lifelines CoxPHFitter on the equivalent transformed risk set, where the Fine-Gray weights are identically one)",
        "robust standard errors on uncensored data (lifelines CoxPHFitter robust=True on the same transformed risk set)",
        "Kaplan-Meier censoring survival G(t) and G(t-) used for the weights (lifelines KaplanMeierFitter with censoring as the event)",
        "coefficients and model-based standard errors on censored data with Efron and Breslow ties (independent scipy.optimize BFGS maximization of the IPCW-weighted log partial likelihood, a different algorithm from the Newton-Raphson solve used here)",
        "score-residual robust covariance on censored data (independent numpy re-derivation of the residual formula)",
        "the subdistribution risk set and its weights on a five-subject case whose weights are computed by hand in the oracle comments",
      ],
      excludedOutputs: [
        "any comparison against an established Fine-Gray package (R cmprsk::crr and its Python ports are not available in this environment; lifelines exposes no Fine-Gray fitter, so the censored case is checked against a re-derivation rather than an independent package)",
        "the Fine-Gray variance correction term for the estimated censoring distribution",
        "time-varying covariate effects and any proportional-subdistribution-hazards test",
        "cumulative incidence predicted from the fitted model",
      ],
    },
    diagnostic: {
      level: "method-specific-partial",
      emitted: ["weighted partial-likelihood convergence", "event accounting", "censoring weight boundary", "variance estimator", "subdistribution risk set", "proportional subdistribution hazards diagnostic"],
      limitations: [
        "no proportional-subdistribution-hazards test is computed",
        "the robust variance omits the Fine-Gray correction for the estimated censoring weights, so it is exact only without censoring",
        "the weighted likelihood-ratio and score tests use an approximate chi-square reference",
      ],
    },
    knownGaps: [
      "no cross-check against an established Fine-Gray implementation: R cmprsk::crr is unavailable here and lifelines exposes no Fine-Gray fitter, so the censored case is verified only against an independently derived weighted partial likelihood and a hand-computed five-subject risk set",
      "the robust standard error omits the Fine-Gray (1999) term for the estimated censoring distribution and is therefore a partial correction under censoring",
      "no covariate-dependent or stratified censoring weights",
      "no time-varying covariates, no strata, and no left truncation",
      "no scaled-Schoenfeld or other proportional-subdistribution-hazards test",
      "no predicted cumulative incidence curve from the fitted model",
    ],
  },
};

module.exports = { methods: [rocCurveComparison, diagnosticAccuracyMeasures, fineGraySubdistributionHazard] };
