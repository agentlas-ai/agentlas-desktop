"use strict";

/**
 * Extended regression family: ordinal and multinomial logistic regression, negative binomial
 * regression, penalized regression (ridge, lasso, elastic net), quantile regression, robust
 * M-estimation, polynomial regression, Levenberg-Marquardt nonlinear least squares, and
 * information-criterion model comparison. Pure deterministic JavaScript; numerics via H and
 * the shared regression kit. No engine require, no Math.random, no Date, no I/O.
 */

const K = require("./regression-kit.cjs");

const MAX_ROWS = 5000;
const NUMBER_COLUMN = (key, label) => ({ key, label, type: "number" });
const STRING_COLUMN = (key, label) => ({ key, label, type: "string" });
const BOOLEAN_COLUMN = (key, label) => ({ key, label, type: "boolean" });

const PREDICTORS_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: 48,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["values"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 128 },
      type: { type: "string", enum: ["numeric", "categorical"] },
      values: { type: "array", minItems: 4, maxItems: 100000, items: { type: ["number", "string"] } },
      reference: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
};
const LABEL_SCHEMA = { type: "string", minLength: 1, maxLength: 128 };
const NUMERIC_SCHEMA = (minItems) => ({ type: "array", minItems, maxItems: MAX_ROWS, items: { type: "number" } });
const CATEGORY_SCHEMA = (minItems) => ({ type: "array", minItems, maxItems: MAX_ROWS, items: { type: "string", minLength: 1, maxLength: 128 } });

function limitRows(n, H, method) {
  if (n > MAX_ROWS) H.fail("STAT_LIMIT_EXCEEDED", `${method} supports at most ${MAX_ROWS} observations`);
}

function parseNumericOutcome(data, H, method, minRows) {
  const y = H.numericVector(data.y, "data.y", minRows);
  limitRows(y.length, H, method);
  const predictors = H.regressionPredictors(data.predictors, y.length);
  return { y, predictors, outcomeLabel: H.label(data.outcomeLabel, "Outcome", "data.outcomeLabel") };
}

function percent(level) {
  return `${Math.round(level * 1000) / 10}%`;
}

function informationCriteria(logLikelihood, parameters, n) {
  return {
    aic: -2 * logLikelihood + 2 * parameters,
    bic: -2 * logLikelihood + parameters * Math.log(n),
    aicc: n - parameters - 1 > 0 ? -2 * logLikelihood + 2 * parameters + 2 * parameters * (parameters + 1) / (n - parameters - 1) : null,
  };
}

function pseudoRSquared(logLikelihood, nullLogLikelihood, n) {
  const coxSnell = 1 - Math.exp(2 * (nullLogLikelihood - logLikelihood) / n);
  const maximum = 1 - Math.exp(2 * nullLogLikelihood / n);
  return {
    mcFadden: 1 - logLikelihood / nullLogLikelihood,
    coxSnell,
    nagelkerke: maximum > 0 ? coxSnell / maximum : null,
  };
}

function convergenceDiagnostic(iterations, maxIterations, tolerance, extra = {}) {
  return { name: "convergence", status: "converged", iterations, maxIterations, tolerance, ...extra };
}

/* ------------------------------------------------------------------------------------------ */
/* Ordinal logistic regression (proportional odds)                                             */
/* ------------------------------------------------------------------------------------------ */

function sigmoidDerivatives(H, value) {
  if (value === Infinity) return { cdf: 1, pdf: 0, pdfDerivative: 0 };
  if (value === -Infinity) return { cdf: 0, pdf: 0, pdfDerivative: 0 };
  const cdf = H.sigmoid(value);
  const pdf = cdf * (1 - cdf);
  return { cdf, pdf, pdfDerivative: pdf * (1 - 2 * cdf) };
}

/** Log-likelihood, gradient, and Hessian of the proportional-odds model at (beta, thresholds). */
function proportionalOddsObjective(codes, x, beta, thresholds, H, budget, needDerivatives) {
  const n = codes.length;
  const p = beta.length;
  const q = thresholds.length;
  const size = p + q;
  const gradient = needDerivatives ? Array(size).fill(0) : null;
  const hessian = needDerivatives ? Array.from({ length: size }, () => Array(size).fill(0)) : null;
  let logLikelihood = 0;
  const probabilities = [];
  for (let index = 0; index < n; index += 1) {
    budget.check(size);
    const eta = K.dot(x[index], beta);
    const k = codes[index];
    const upper = k === q ? Infinity : thresholds[k] - eta;
    const lower = k === 0 ? -Infinity : thresholds[k - 1] - eta;
    const a = sigmoidDerivatives(H, upper);
    const b = sigmoidDerivatives(H, lower);
    const probability = a.cdf - b.cdf;
    if (!(probability > 1e-300)) return { logLikelihood: -Infinity };
    probabilities.push(probability);
    logLikelihood += Math.log(probability);
    if (!needDerivatives) continue;
    // gradient of a and b with respect to parameters: d a / d beta = -x, d a / d theta_k = 1
    const gradA = Array(size).fill(0);
    const gradB = Array(size).fill(0);
    for (let j = 0; j < p; j += 1) { gradA[j] = -x[index][j]; gradB[j] = -x[index][j]; }
    if (k < q) gradA[p + k] = 1;
    if (k > 0) gradB[p + k - 1] = 1;
    const score = Array(size).fill(0);
    for (let j = 0; j < size; j += 1) score[j] = (a.pdf * gradA[j] - b.pdf * gradB[j]) / probability;
    for (let j = 0; j < size; j += 1) {
      gradient[j] += score[j];
      for (let l = 0; l < size; l += 1) {
        hessian[j][l] += (a.pdfDerivative * gradA[j] * gradA[l] - b.pdfDerivative * gradB[j] * gradB[l]) / probability - score[j] * score[l];
      }
    }
  }
  return { logLikelihood, gradient, hessian, probabilities };
}

function fitProportionalOdds(codes, x, levelCount, H, budget, { maxIterations, tolerance }) {
  const n = codes.length;
  const p = x.length ? x[0].length : 0;
  const q = levelCount - 1;
  const counts = Array(levelCount).fill(0);
  for (const code of codes) counts[code] += 1;
  let cumulative = 0;
  const thresholds = [];
  for (let j = 0; j < q; j += 1) {
    cumulative += counts[j];
    const share = cumulative / n;
    thresholds.push(Math.log(share / (1 - share)));
  }
  let beta = Array(p).fill(0);
  let theta = thresholds;
  let current = proportionalOddsObjective(codes, x, beta, theta, H, budget, true);
  let iterations = 0;
  let converged = false;
  for (iterations = 1; iterations <= maxIterations; iterations += 1) {
    budget.check(1024);
    const negative = current.hessian.map((row) => row.map((value) => -value));
    let inverse;
    try { inverse = H.invert(negative); } catch { H.fail("STAT_SINGULAR_FIT", "proportional-odds information matrix is singular (check for separation or empty categories)"); }
    const step = K.matVec(inverse, current.gradient);
    let scale = 1;
    let candidate = null;
    let next = null;
    for (let halving = 0; halving < 40; halving += 1) {
      const betaNext = beta.map((value, index) => value + scale * step[index]);
      const thetaNext = theta.map((value, index) => value + scale * step[p + index]);
      const ordered = thetaNext.every((value, index) => index === 0 || value > thetaNext[index - 1]);
      if (ordered) {
        candidate = proportionalOddsObjective(codes, x, betaNext, thetaNext, H, budget, true);
        if (candidate.logLikelihood >= current.logLikelihood - 1e-12) { next = { beta: betaNext, theta: thetaNext }; break; }
      }
      scale /= 2;
    }
    if (!next) H.fail("STAT_NON_CONVERGENCE", "proportional-odds Newton step could not increase the log-likelihood");
    const delta = Math.max(...step.map((value) => Math.abs(scale * value)));
    beta = next.beta;
    theta = next.theta;
    current = candidate;
    if (!Number.isFinite(delta) || current.logLikelihood > -1e-8 * n) H.fail("STAT_NON_CONVERGENCE", "proportional-odds fit diverged: the outcome is completely or quasi-completely separated by the predictors");
    if (delta < tolerance) { converged = true; break; }
  }
  if (!converged) H.fail("STAT_NON_CONVERGENCE", `proportional-odds fit did not converge in ${maxIterations} iterations`);
  const negative = current.hessian.map((row) => row.map((value) => -value));
  let covariance;
  try { covariance = H.invert(negative); } catch { H.fail("STAT_SINGULAR_FIT", "proportional-odds information matrix is singular at the optimum"); }
  const nullLogLikelihood = counts.reduce((total, count) => total + (count > 0 ? count * Math.log(count / n) : 0), 0);
  return { beta, thresholds: theta, covariance, logLikelihood: current.logLikelihood, nullLogLikelihood, iterations, counts, probabilities: current.probabilities };
}

/** Brant (1990) parallel-lines test from J-1 separate binary logits on I(y >= j). */
function brantTest(codes, x, names, levelCount, H, budget) {
  const n = codes.length;
  const p = x[0].length;
  const q = levelCount - 1;
  const design = x.map((row) => [1, ...row]);
  const fits = [];
  for (let j = 1; j <= q; j += 1) {
    const z = codes.map((code) => (code >= j ? 1 : 0));
    const fit = K.logisticFit(z, design, H, budget, { maxIterations: 100, tolerance: 1e-10, soft: true });
    if (!fit) return { status: "not_established", reason: `binary logit for outcome >= level ${j + 1} did not converge (separation)`, rows: [], omnibus: null };
    fits.push(fit);
  }
  // Covariance blocks between binary models l < m: (X'W_l X)^-1 X' W_lm X (X'W_m X)^-1 with W_lm = pi_m - pi_l pi_m.
  const blocks = Array.from({ length: q }, () => Array(q).fill(null));
  for (let l = 0; l < q; l += 1) {
    for (let m = l; m < q; m += 1) {
      budget.check(1024);
      if (l === m) { blocks[l][l] = fits[l].covariance; continue; }
      const weights = fits[l].probabilities.map((pl, index) => fits[m].probabilities[index] - pl * fits[m].probabilities[index]);
      const middle = K.crossProduct(design, weights, budget);
      const block = H.matMul(H.matMul(fits[l].covariance, middle, budget), fits[m].covariance, budget);
      blocks[l][m] = block;
      blocks[m][l] = H.transpose(block);
    }
  }
  // Contrasts beta_1 - beta_j for j = 2..q on the non-intercept coefficients.
  const contrastCount = q - 1;
  const differenceVector = [];
  for (let j = 1; j < q; j += 1) for (let v = 0; v < p; v += 1) differenceVector.push(fits[0].beta[v + 1] - fits[j].beta[v + 1]);
  const size = contrastCount * p;
  const covariance = Array.from({ length: size }, () => Array(size).fill(0));
  for (let j = 1; j < q; j += 1) {
    for (let k = 1; k < q; k += 1) {
      for (let v = 0; v < p; v += 1) {
        for (let w = 0; w < p; w += 1) {
          const value = blocks[0][0][v + 1][w + 1] - blocks[0][k][v + 1][w + 1] - blocks[j][0][v + 1][w + 1] + blocks[j][k][v + 1][w + 1];
          covariance[(j - 1) * p + v][(k - 1) * p + w] = value;
        }
      }
    }
  }
  const omnibus = K.waldChiSquare(differenceVector, covariance, differenceVector.map((_, index) => index), H);
  const rows = names.map((name, v) => {
    const indices = Array.from({ length: contrastCount }, (_, j) => j * p + v);
    const test = K.waldChiSquare(differenceVector, covariance, indices, H);
    return { term: name, statistic: test.statistic, df: test.df, pValue: test.pValue, parallelSlopes: fits.map((fit) => fit.beta[v + 1]).map((value) => Number(value.toPrecision(12))).join(", ") };
  });
  return { status: "evaluated", rows, omnibus: { statistic: omnibus.statistic, df: omnibus.df, pValue: omnibus.pValue }, binaryCoefficients: fits.map((fit) => fit.beta) };
}

const ordinalLogisticRegression = {
  method: "ordinal_logistic_regression",
  family: "regression",
  analysisModel: { families: ["glm"], distributions: [null, "multinomial", "ordinal"], links: [null, "logit"] },
  optionKeys: ["confidenceLevel", "timeoutMs", "maxIterations", "tolerance"],
  customOptions: {},
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["y", "levels", "predictors"],
    properties: {
      y: CATEGORY_SCHEMA(12),
      levels: { type: "array", minItems: 3, maxItems: 12, items: LABEL_SCHEMA },
      predictors: PREDICTORS_SCHEMA,
      outcomeLabel: LABEL_SCHEMA,
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["y", "levels", "predictors", "outcomeLabel"], "data");
    const y = H.categoryVector(data.y, "data.y", 12);
    limitRows(y.length, H, "ordinal_logistic_regression");
    if (!Array.isArray(data.levels) || data.levels.length < 3 || data.levels.length > 12) H.fail("STAT_INVALID_INPUT", "data.levels must list 3 to 12 ordered outcome levels");
    const levels = data.levels.map((item, index) => H.label(item, "", `data.levels[${index}]`));
    if (new Set(levels).size !== levels.length) H.fail("STAT_INVALID_INPUT", "data.levels must be unique");
    const codes = y.map((value, index) => {
      const code = levels.indexOf(value);
      if (code < 0) H.fail("STAT_INVALID_INPUT", `data.y[${index}] is not one of data.levels`);
      return code;
    });
    const counts = levels.map((_, code) => codes.filter((value) => value === code).length);
    counts.forEach((count, code) => { if (count === 0) H.fail("STAT_DEGENERATE", `outcome level ${levels[code]} has no observations`); });
    const predictors = H.regressionPredictors(data.predictors, y.length);
    return { y, codes, levels, counts, predictors, outcomeLabel: H.label(data.outcomeLabel, "Outcome", "data.outcomeLabel") };
  },
  analyze(parsed, options, budget, H) {
    const { codes, levels, counts, predictors } = parsed;
    const n = codes.length;
    const design = H.designMatrix({ y: codes, predictors }, false);
    const p = design.terms.length;
    if (H.matrixRank(design.x) < p) H.fail("STAT_RANK_DEFICIENT", "predictor design is rank deficient after categorical expansion");
    if (n <= p + levels.length) H.fail("STAT_INSUFFICIENT_SAMPLE", `at least ${p + levels.length + 1} observations are required`);
    const fit = fitProportionalOdds(codes, design.x, levels.length, H, budget, { maxIterations: Math.max(options.maxIterations, 50), tolerance: options.tolerance });
    const names = design.terms.map((term) => term.name);
    const coefficientRows = K.coefficientRows(names, fit.beta, fit.covariance, null, options.confidenceLevel, H, { expKey: "oddsRatio" });
    const thresholdRows = fit.thresholds.map((estimate, index) => {
      const variance = fit.covariance[p + index][p + index];
      const standardError = Math.sqrt(variance);
      return { threshold: `${levels[index]}|${levels[index + 1]}`, estimate, standardError, statistic: estimate / standardError, pValue: H.pFromNormal(estimate / standardError, "two-sided") };
    });
    const lr = 2 * (fit.logLikelihood - fit.nullLogLikelihood);
    const pseudo = pseudoRSquared(fit.logLikelihood, fit.nullLogLikelihood, n);
    const criteria = informationCriteria(fit.logLikelihood, p + levels.length - 1, n);
    const brant = brantTest(codes, design.x, names, levels.length, H, budget);
    const level = options.confidenceLevel;
    const tests = [
      { name: "likelihood-ratio test versus thresholds-only model", statistic: lr, df: p, pValue: H.pFromChiSquare(lr, p), distribution: "chi-square" },
    ];
    if (brant.status === "evaluated") tests.push({ name: "Brant parallel-lines test (omnibus)", statistic: brant.omnibus.statistic, df: brant.omnibus.df, pValue: brant.omnibus.pValue, distribution: "chi-square", boundary: "asymptotic Wald test built from separate binary logits" });
    const countRows = levels.map((name, code) => ({ level: name, count: counts[code], proportion: counts[code] / n }));
    return {
      sample: { n, predictors: predictors.length, designColumns: p, levels: levels.length, counts: Object.fromEntries(levels.map((name, code) => [name, counts[code]])) },
      estimates: [
        ...coefficientRows.map((row) => ({ ...row, kind: "coefficient" })),
        ...thresholdRows.map((row) => ({ term: row.threshold, estimate: row.estimate, standardError: row.standardError, statistic: row.statistic, pValue: row.pValue, kind: "threshold" })),
        { term: "log-likelihood", estimate: fit.logLikelihood, kind: "fit" },
        { term: "null log-likelihood", estimate: fit.nullLogLikelihood, kind: "fit" },
        { term: "AIC", estimate: criteria.aic, kind: "fit" },
        { term: "BIC", estimate: criteria.bic, kind: "fit" },
      ],
      tests,
      confidenceIntervals: coefficientRows.map((row) => ({ parameter: `odds ratio ${row.term}`, level, lower: row.oddsRatioLower, upper: row.oddsRatioUpper, method: "Wald on the log-odds scale" })),
      effectSizes: [
        { name: "McFadden pseudo R-squared", estimate: pseudo.mcFadden },
        { name: "Cox-Snell pseudo R-squared", estimate: pseudo.coxSnell },
        { name: "Nagelkerke pseudo R-squared", estimate: pseudo.nagelkerke },
      ],
      assumptions: [
        { name: "proportional odds (parallel lines)", status: brant.status === "evaluated" ? (brant.omnibus.pValue < 0.05 ? "violated_by_brant_test" : "not_rejected_by_brant_test") : "not_established", detail: brant.status === "evaluated" ? "Brant omnibus and per-term Wald tests reported" : brant.reason },
        { name: "ordered outcome levels reflect the scientific ordering", status: "requires_domain_review" },
        { name: "independent observations", status: "requires_design_review" },
        { name: "no complete separation", status: "verified_by_convergence" },
      ],
      diagnostics: [
        convergenceDiagnostic(fit.iterations, Math.max(options.maxIterations, 50), options.tolerance, { algorithm: "Newton-Raphson with step halving on (beta, thresholds)" }),
        { name: "information criteria", aic: criteria.aic, bic: criteria.bic, parameters: p + levels.length - 1 },
        { name: "Brant parallel-lines diagnostic", status: brant.status, ...(brant.omnibus ? { statistic: brant.omnibus.statistic, df: brant.omnibus.df, pValue: brant.omnibus.pValue } : { reason: brant.reason }) },
        { name: "sparse outcome levels", status: Math.min(...counts) < 5 ? "level_with_fewer_than_five_observations" : "acceptable", minimumCount: Math.min(...counts) },
        { name: "inference boundary", status: "asymptotic", detail: "Wald intervals and likelihood-ratio tests rely on large-sample normality of the maximum-likelihood estimator" },
      ],
      artifacts: [
        H.tableArtifact("Proportional-odds coefficients", `Cumulative logit model for ${parsed.outcomeLabel} with ${percent(level)} Wald intervals; odds ratios are for higher outcome categories.`, K.coefficientColumns("z", [NUMBER_COLUMN("oddsRatio", "Odds ratio"), NUMBER_COLUMN("oddsRatioLower", "OR lower"), NUMBER_COLUMN("oddsRatioUpper", "OR upper")]), coefficientRows, ["P(Y <= j | x) = logistic(theta_j - x'beta); a positive coefficient shifts mass toward higher categories."], "ordinal-coefficients-table"),
        H.tableArtifact("Threshold (cut-point) estimates", "Latent-scale cut points between adjacent outcome categories.", [STRING_COLUMN("threshold", "Threshold"), NUMBER_COLUMN("estimate", "Estimate"), NUMBER_COLUMN("standardError", "SE"), NUMBER_COLUMN("statistic", "z"), NUMBER_COLUMN("pValue", "p")], thresholdRows, [], "ordinal-thresholds-table"),
        H.tableArtifact("Brant parallel-lines test", "Per-term Wald tests that the slopes of the J-1 separate binary logits are equal; small p indicates the proportional-odds assumption is questionable for that term.", [STRING_COLUMN("term", "Term"), NUMBER_COLUMN("statistic", "Chi-square"), NUMBER_COLUMN("df", "df"), NUMBER_COLUMN("pValue", "p"), STRING_COLUMN("parallelSlopes", "Binary-logit slopes")], brant.rows, brant.status === "evaluated" ? [] : [`Not evaluated: ${brant.reason}`], "ordinal-brant-table"),
        H.tableArtifact("Outcome level counts", "Observed frequency of each ordered level.", [STRING_COLUMN("level", "Level"), NUMBER_COLUMN("count", "Count"), NUMBER_COLUMN("proportion", "Proportion")], countRows, [], "ordinal-level-counts-table"),
        K.forestPlot(H, "ordinal-odds-ratio-forest", `Proportional-odds ratios with ${percent(level)} intervals`, coefficientRows, { xTitle: "Odds ratio (log scale)", estimateField: "oddsRatio", lowerField: "oddsRatioLower", upperField: "oddsRatioUpper", referenceValue: 1, logScale: true }),
      ],
    };
  },
  linkage: {
    neededWhen: "The outcome is an ordered categorical scale (severity grade, Likert response, stage) and the researcher needs adjusted effects of predictors on the odds of higher categories.",
    decision: "Whether each predictor shifts the ordered outcome distribution, whether one common odds ratio is defensible across all cut points, and how large the adjusted effects are.",
    mustShow: "Odds ratios with intervals, threshold estimates, the likelihood-ratio test, the Brant parallel-lines diagnostic per term, and the count of observations in every outcome level.",
    userGoal: "Report adjusted proportional-odds effects on an ordinal outcome with an explicit check of the parallel-lines assumption.",
    nextActions: [
      { trigger: "brant-test-rejects-parallel-lines", action: "fit-partial-proportional-odds-or-multinomial-sensitivity", reason: "A single odds ratio misstates effects that differ across cut points, so a relaxed model should be compared before reporting." },
      { trigger: "sparse-outcome-level", action: "review-level-merging-plan-before-reinterpreting", reason: "Levels with very few observations make threshold estimates unstable and Wald intervals unreliable." },
      { trigger: "separation-or-nonconvergence", action: "inspect-predictor-outcome-cross-tabulation", reason: "Perfectly predicted categories inflate coefficients toward infinity and invalidate the asymptotic inference." },
      { trigger: "interpretable-adjusted-effects", action: "bind-odds-ratio-forest-and-threshold-table", reason: "Readers need the effect direction on the ordered scale together with the cut points that define the categories." },
    ],
  },
  fixture: {
    data: {
      y: ["high", "low", "high", "low", "low", "low", "low", "mid", "mid", "high", "low", "mid", "mid", "high", "high", "mid", "mid", "low", "high", "low", "low", "mid", "low", "high", "high", "mid", "mid", "high", "high", "mid", "mid", "mid", "low", "high", "mid", "high", "high", "low", "high", "low", "high", "low", "mid", "mid", "low"],
      levels: ["low", "mid", "high"],
      predictors: [
        { name: "dose", values: [1.7, 5.0, 5.9, 0.8, 1.8, 8.9, 1.1, 1.7, 9.0, 6.1, 3.8, 5.1, 6.5, 3.0, 1.7, 7.6, 6.5, 5.1, 7.9, 5.4, 9.3, 2.3, 5.5, 4.9, 3.7, 5.8, 2.6, 7.7, 8.3, 1.7, 4.7, 3.0, 1.2, 8.6, 4.4, 1.8, 6.6, 2.3, 8.6, 2.5, 0.8, 2.3, 3.6, 4.7, 8.7] },
        { name: "age", values: [56, 59, 62, 41, 69, 25, 40, 32, 25, 74, 29, 47, 65, 59, 67, 27, 49, 26, 34, 67, 28, 54, 26, 40, 71, 40, 40, 29, 63, 33, 49, 26, 26, 66, 25, 48, 46, 31, 57, 61, 74, 34, 71, 28, 32] },
      ],
      outcomeLabel: "Response grade",
    },
    options: { confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression", "matlab.stats.classification"] },
  coverage: {
    implementedBoundary: "Cumulative-logit proportional-odds regression by Newton-Raphson with Wald and likelihood-ratio inference, pseudo R-squared, information criteria, and a Brant (1990) parallel-lines test built from separate binary logits.",
    oracle: {
      level: "external-library-partial",
      evidence: ["contracts/regression-extended-scipy-crosscheck.py"],
      verifiedOutputs: ["coefficients", "thresholds", "coefficient standard errors", "log-likelihood", "null log-likelihood", "Brant omnibus statistic (first-principles re-derivation with statsmodels binary logits)"],
      excludedOutputs: ["pseudo R-squared variants", "sparse-level diagnostic", "Brant per-term decomposition"],
    },
    diagnostic: { level: "method-specific-partial", emitted: ["Brant parallel-lines test", "convergence", "sparse outcome levels", "information criteria"], limitations: ["no partial proportional-odds fallback", "no probit or complementary log-log links", "no influence diagnostics"] },
    knownGaps: ["probit and cloglog links are not implemented", "partial proportional-odds models are not fitted automatically when Brant rejects", "no predicted-category confusion table"],
  },
};

/* ------------------------------------------------------------------------------------------ */
/* Multinomial logistic regression                                                             */
/* ------------------------------------------------------------------------------------------ */

function multinomialObjective(codes, x, params, classCount, H, budget, needDerivatives) {
  const n = codes.length;
  const p = x[0].length;
  const kFree = classCount - 1;
  const size = kFree * p;
  const gradient = needDerivatives ? Array(size).fill(0) : null;
  const hessian = needDerivatives ? Array.from({ length: size }, () => Array(size).fill(0)) : null;
  let logLikelihood = 0;
  const probabilities = [];
  for (let index = 0; index < n; index += 1) {
    budget.check(size);
    const xi = x[index];
    const eta = Array(kFree).fill(0);
    for (let k = 0; k < kFree; k += 1) for (let j = 0; j < p; j += 1) eta[k] += xi[j] * params[k * p + j];
    const maximum = Math.max(0, ...eta);
    const weights = eta.map((value) => Math.exp(value - maximum));
    const denominator = Math.exp(-maximum) + weights.reduce((total, value) => total + value, 0);
    const pi = weights.map((value) => value / denominator);
    const reference = Math.exp(-maximum) / denominator;
    const code = codes[index];
    const probability = code === 0 ? reference : pi[code - 1];
    if (!(probability > 1e-300)) return { logLikelihood: -Infinity };
    probabilities.push([reference, ...pi]);
    logLikelihood += Math.log(probability);
    if (!needDerivatives) continue;
    for (let k = 0; k < kFree; k += 1) {
      const indicator = code === k + 1 ? 1 : 0;
      const residual = indicator - pi[k];
      for (let j = 0; j < p; j += 1) gradient[k * p + j] += xi[j] * residual;
      for (let l = 0; l < kFree; l += 1) {
        const weight = -pi[k] * ((k === l ? 1 : 0) - pi[l]);
        for (let j = 0; j < p; j += 1) {
          const scaled = weight * xi[j];
          for (let m = 0; m < p; m += 1) hessian[k * p + j][l * p + m] += scaled * xi[m];
        }
      }
    }
  }
  return { logLikelihood, gradient, hessian, probabilities };
}

function fitMultinomial(codes, x, classCount, H, budget, { maxIterations, tolerance }) {
  const p = x[0].length;
  const size = (classCount - 1) * p;
  let params = Array(size).fill(0);
  let current = multinomialObjective(codes, x, params, classCount, H, budget, true);
  let iterations = 0;
  let converged = false;
  for (iterations = 1; iterations <= maxIterations; iterations += 1) {
    budget.check(1024);
    const negative = current.hessian.map((row) => row.map((value) => -value));
    let inverse;
    try { inverse = H.invert(negative); } catch { H.fail("STAT_SINGULAR_FIT", "multinomial information matrix is singular (check for separation or empty classes)"); }
    const step = K.matVec(inverse, current.gradient);
    let scale = 1;
    let candidate = null;
    let next = null;
    for (let halving = 0; halving < 40; halving += 1) {
      const trial = params.map((value, index) => value + scale * step[index]);
      candidate = multinomialObjective(codes, x, trial, classCount, H, budget, true);
      if (candidate.logLikelihood >= current.logLikelihood - 1e-12) { next = trial; break; }
      scale /= 2;
    }
    if (!next) H.fail("STAT_NON_CONVERGENCE", "multinomial Newton step could not increase the log-likelihood");
    const delta = Math.max(...step.map((value) => Math.abs(scale * value)));
    params = next;
    current = candidate;
    if (!Number.isFinite(delta) || current.logLikelihood > -1e-8 * codes.length) H.fail("STAT_NON_CONVERGENCE", "multinomial fit diverged: a class is completely or quasi-completely separated by the predictors");
    if (delta < tolerance) { converged = true; break; }
  }
  if (!converged) H.fail("STAT_NON_CONVERGENCE", `multinomial fit did not converge in ${maxIterations} iterations`);
  let covariance;
  try { covariance = H.invert(current.hessian.map((row) => row.map((value) => -value))); } catch { H.fail("STAT_SINGULAR_FIT", "multinomial information matrix is singular at the optimum"); }
  return { params, covariance, logLikelihood: current.logLikelihood, probabilities: current.probabilities, iterations };
}

const multinomialLogisticRegression = {
  method: "multinomial_logistic_regression",
  family: "regression",
  analysisModel: { families: ["glm"], distributions: [null, "multinomial"], links: [null, "logit"] },
  optionKeys: ["confidenceLevel", "timeoutMs", "maxIterations", "tolerance"],
  customOptions: {},
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["y", "predictors"],
    properties: {
      y: CATEGORY_SCHEMA(12),
      reference: LABEL_SCHEMA,
      predictors: PREDICTORS_SCHEMA,
      outcomeLabel: LABEL_SCHEMA,
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["y", "reference", "predictors", "outcomeLabel"], "data");
    const y = H.categoryVector(data.y, "data.y", 12);
    limitRows(y.length, H, "multinomial_logistic_regression");
    const levels = K.sortedLevels(y);
    if (levels.length < 3 || levels.length > 10) H.fail("STAT_INVALID_INPUT", "data.y must contain 3 to 10 distinct classes (use logistic_regression for binary outcomes)");
    const reference = data.reference === undefined ? levels[0] : H.label(data.reference, levels[0], "data.reference");
    if (!levels.includes(reference)) H.fail("STAT_INVALID_INPUT", "data.reference must be one of the observed classes");
    const ordered = [reference, ...levels.filter((item) => item !== reference)];
    const codes = y.map((value) => ordered.indexOf(value));
    const counts = ordered.map((_, code) => codes.filter((value) => value === code).length);
    const predictors = H.regressionPredictors(data.predictors, y.length);
    return { y, codes, levels: ordered, counts, predictors, outcomeLabel: H.label(data.outcomeLabel, "Outcome", "data.outcomeLabel") };
  },
  analyze(parsed, options, budget, H) {
    const { codes, levels, counts, predictors } = parsed;
    const n = codes.length;
    const design = K.buildDesign(codes, predictors, H, true);
    const p = design.terms.length;
    const kFree = levels.length - 1;
    if (n <= kFree * p + 1) H.fail("STAT_INSUFFICIENT_SAMPLE", `at least ${kFree * p + 2} observations are required for ${kFree * p} parameters`);
    const fit = fitMultinomial(codes, design.x, levels.length, H, budget, { maxIterations: Math.max(options.maxIterations, 50), tolerance: options.tolerance });
    const names = design.terms.map((term) => term.name);
    const level = options.confidenceLevel;
    const rows = [];
    for (let k = 0; k < kFree; k += 1) {
      const block = K.coefficientRows(names, fit.params.slice(k * p, (k + 1) * p), fit.covariance.slice(k * p, (k + 1) * p).map((row) => row.slice(k * p, (k + 1) * p)), null, level, H, { expKey: "relativeRiskRatio" });
      for (const row of block) rows.push({ outcome: levels[k + 1], ...row });
    }
    const nullLogLikelihood = counts.reduce((total, count) => total + (count > 0 ? count * Math.log(count / n) : 0), 0);
    const lr = 2 * (fit.logLikelihood - nullLogLikelihood);
    const lrDf = kFree * (p - 1);
    const pseudo = pseudoRSquared(fit.logLikelihood, nullLogLikelihood, n);
    const criteria = informationCriteria(fit.logLikelihood, kFree * p, n);
    // Predicted classes and confusion counts.
    const confusion = levels.map(() => levels.map(() => 0));
    let correct = 0;
    fit.probabilities.forEach((row, index) => {
      let best = 0;
      for (let k = 1; k < row.length; k += 1) if (row[k] > row[best]) best = k;
      confusion[codes[index]][best] += 1;
      if (best === codes[index]) correct += 1;
    });
    const confusionRows = [];
    levels.forEach((observed, i) => levels.forEach((predicted, j) => confusionRows.push({ observed, predicted, count: confusion[i][j] })));
    const termTests = names.slice(1).map((name, indexInTerms) => {
      const indices = Array.from({ length: kFree }, (_, k) => k * p + indexInTerms + 1);
      const test = K.waldChiSquare(fit.params, fit.covariance, indices, H);
      return { name: `Wald test ${name} across all outcomes`, statistic: test.statistic, df: test.df, pValue: test.pValue, distribution: "chi-square" };
    });
    return {
      sample: { n, classes: levels.length, reference: levels[0], counts: Object.fromEntries(levels.map((name, code) => [name, counts[code]])), designColumns: p },
      estimates: [
        ...rows.map((row) => ({ ...row, kind: "coefficient" })),
        { term: "log-likelihood", estimate: fit.logLikelihood, kind: "fit" },
        { term: "null log-likelihood", estimate: nullLogLikelihood, kind: "fit" },
        { term: "AIC", estimate: criteria.aic, kind: "fit" },
        { term: "BIC", estimate: criteria.bic, kind: "fit" },
        { term: "classification accuracy (in-sample)", estimate: correct / n, kind: "fit" },
      ],
      tests: [
        { name: "likelihood-ratio test versus intercept-only model", statistic: lr, df: lrDf, pValue: H.pFromChiSquare(lr, lrDf), distribution: "chi-square" },
        ...termTests,
      ],
      confidenceIntervals: rows.map((row) => ({ parameter: `relative risk ratio ${row.term} (${row.outcome} vs ${levels[0]})`, level, lower: row.relativeRiskRatioLower, upper: row.relativeRiskRatioUpper, method: "Wald on the log scale" })),
      effectSizes: [
        { name: "McFadden pseudo R-squared", estimate: pseudo.mcFadden },
        { name: "Cox-Snell pseudo R-squared", estimate: pseudo.coxSnell },
        { name: "Nagelkerke pseudo R-squared", estimate: pseudo.nagelkerke },
      ],
      assumptions: [
        { name: "independence of irrelevant alternatives", status: "not_established", detail: "no Hausman-McFadden IIA test is computed; review whether removing a class would change the remaining relative risks" },
        { name: "independent observations", status: "requires_design_review" },
        { name: "no complete separation", status: "verified_by_convergence" },
        { name: "sufficient observations per class", status: Math.min(...counts) < 10 ? "class_with_fewer_than_ten_observations" : "acceptable" },
      ],
      diagnostics: [
        convergenceDiagnostic(fit.iterations, Math.max(options.maxIterations, 50), options.tolerance, { algorithm: "Newton-Raphson on the full (K-1)p Hessian with step halving" }),
        { name: "information criteria", aic: criteria.aic, bic: criteria.bic, parameters: kFree * p },
        { name: "in-sample classification", accuracy: correct / n, status: "optimistic_in_sample_estimate" },
        { name: "inference boundary", status: "asymptotic", detail: "Wald intervals and likelihood-ratio tests rely on large-sample normality of the maximum-likelihood estimator" },
      ],
      artifacts: [
        H.tableArtifact("Multinomial logit coefficients", `Log relative-risk coefficients for ${parsed.outcomeLabel} versus reference class ${levels[0]} with ${percent(level)} Wald intervals.`, [STRING_COLUMN("outcome", "Outcome"), ...K.coefficientColumns("z", [NUMBER_COLUMN("relativeRiskRatio", "RRR"), NUMBER_COLUMN("relativeRiskRatioLower", "RRR lower"), NUMBER_COLUMN("relativeRiskRatioUpper", "RRR upper")])], rows, ["Relative risk ratio = exp(coefficient): multiplicative change in P(outcome)/P(reference) per unit of the term."], "multinomial-coefficients-table"),
        H.tableArtifact("In-sample confusion counts", "Observed class versus modal predicted class.", [STRING_COLUMN("observed", "Observed"), STRING_COLUMN("predicted", "Predicted"), NUMBER_COLUMN("count", "Count")], confusionRows, ["In-sample accuracy is optimistic; use held-out data for predictive claims."], "multinomial-confusion-table"),
        K.forestPlot(H, "multinomial-rrr-forest", `Relative risk ratios versus ${levels[0]} with ${percent(level)} intervals`, rows, { xTitle: "Relative risk ratio (log scale)", estimateField: "relativeRiskRatio", lowerField: "relativeRiskRatioLower", upperField: "relativeRiskRatioUpper", referenceValue: 1, logScale: true, colorField: "outcome" }),
      ],
    };
  },
  linkage: {
    neededWhen: "The outcome is a nominal categorical variable with three or more unordered classes and the researcher needs adjusted class probabilities or relative risks.",
    decision: "Which predictors change the relative risk of each class versus the reference class and whether the model separates the classes meaningfully.",
    mustShow: "Relative risk ratios with intervals per outcome class, the reference class, the likelihood-ratio test, per-term Wald tests, class counts, and in-sample confusion counts.",
    userGoal: "Report adjusted multi-class associations without imposing an ordering on the outcome categories.",
    nextActions: [
      { trigger: "class-with-few-observations", action: "review-class-merging-or-penalized-fit-plan", reason: "Small classes drive separation and unstable relative risk ratios that Wald inference cannot support." },
      { trigger: "outcome-is-actually-ordered", action: "compare-proportional-odds-model", reason: "An ordinal model uses fewer parameters and answers a directional question the nominal model ignores." },
      { trigger: "separation-or-nonconvergence", action: "inspect-predictor-class-cross-tabulation", reason: "Perfect prediction of a class inflates coefficients toward infinity and invalidates asymptotic tests." },
      { trigger: "interpretable-relative-risks", action: "bind-rrr-forest-and-confusion-table", reason: "Readers need effects per class and a view of how well classes are recovered." },
    ],
  },
  fixture: {
    data: {
      y: ["car", "car", "bus", "car", "bike", "car", "bike", "bike", "car", "car", "car", "bus", "car", "bike", "car", "bus", "bike", "car", "bike", "bus", "car", "car", "car", "car", "bus", "car", "car", "bike", "car", "bike", "bike", "bus", "car", "car", "bike", "car", "bus", "bike", "car", "car", "bus", "car", "car", "bike", "car", "car", "car", "bus"],
      predictors: [
        { name: "distanceKm", values: [19.3, 14.4, 4.4, 11.5, 2.7, 13.8, 5.9, 1.8, 3.4, 12.7, 14.4, 7.8, 14.5, 8.4, 3.7, 7.6, 9.3, 20.2, 3.4, 2.8, 12.8, 21.2, 20.1, 15.7, 2.4, 17.9, 15.4, 4.0, 10.8, 2.0, 17.8, 16.1, 17.9, 17.0, 6.6, 17.6, 6.2, 3.9, 9.2, 11.5, 7.0, 13.7, 13.7, 6.0, 14.1, 8.5, 16.4, 7.1] },
        { name: "income", values: [57, 32, 68, 59, 47, 63, 55, 54, 62, 67, 53, 47, 39, 41, 78, 35, 30, 58, 42, 30, 55, 66, 26, 51, 33, 56, 68, 69, 68, 41, 60, 60, 74, 63, 66, 30, 41, 45, 60, 72, 43, 52, 66, 35, 46, 35, 33, 63] },
      ],
      outcomeLabel: "Commute mode",
    },
    options: { confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression", "matlab.stats.classification"] },
  coverage: {
    implementedBoundary: "Baseline-category multinomial logit by full Newton-Raphson with Wald and likelihood-ratio inference, pseudo R-squared, information criteria, and in-sample confusion counts.",
    oracle: {
      level: "external-library-partial",
      evidence: ["contracts/regression-extended-scipy-crosscheck.py"],
      verifiedOutputs: ["coefficients per outcome class", "coefficient standard errors", "log-likelihood", "null log-likelihood", "likelihood-ratio statistic"],
      excludedOutputs: ["pseudo R-squared variants", "confusion counts", "per-term Wald tests"],
    },
    diagnostic: { level: "method-specific-partial", emitted: ["convergence", "information criteria", "in-sample classification", "per-term Wald tests"], limitations: ["no IIA test", "no cross-validated accuracy", "no influence diagnostics"] },
    knownGaps: ["Hausman-McFadden IIA test is not implemented", "conditional (alternative-specific) logit is out of scope", "no penalized fallback under separation"],
  },
};

/* ------------------------------------------------------------------------------------------ */
/* Negative binomial regression (NB2)                                                          */
/* ------------------------------------------------------------------------------------------ */

function nbLogLikelihood(y, mu, alpha, H) {
  const r = 1 / alpha;
  let total = 0;
  for (let index = 0; index < y.length; index += 1) {
    const m = mu[index];
    total += H.logGamma(y[index] + r) - H.logGamma(r) - H.logGamma(y[index] + 1) + y[index] * Math.log(alpha * m) - (y[index] + r) * Math.log(1 + alpha * m);
  }
  return total;
}

/** Analytic first and second derivatives of the NB2 log-likelihood with respect to alpha at fixed mu. */
function nbAlphaDerivatives(y, mu, alpha) {
  const r = 1 / alpha;
  let first = 0;
  let second = 0;
  for (let index = 0; index < y.length; index += 1) {
    const m = mu[index];
    const yi = y[index];
    const log1 = Math.log(1 + alpha * m);
    const ratio = m / (1 + alpha * m);
    first += -(r * r) * K.digamma(yi + r) + (r * r) * K.digamma(r) + yi * r + (r * r) * log1 - (yi + r) * ratio;
    second += (2 / alpha ** 3) * K.digamma(yi + r) + (1 / alpha ** 4) * K.trigamma(yi + r)
      - (2 / alpha ** 3) * K.digamma(r) - (1 / alpha ** 4) * K.trigamma(r)
      - yi / alpha ** 2
      - (2 / alpha ** 3) * log1 + (1 / alpha ** 2) * ratio
      + (1 / alpha ** 2) * ratio + (yi + r) * ratio * ratio;
  }
  return { first, second };
}

function fitNegativeBinomial(y, x, offset, H, budget, { maxIterations, tolerance }) {
  const n = y.length;
  const p = x[0].length;
  const poisson = K.poissonFit(y, x, H, budget, { offset, maxIterations: 200, tolerance: 1e-12 });
  let beta = [...poisson.beta];
  let mu = [...poisson.mu];
  let dispersion = 0;
  for (let index = 0; index < n; index += 1) dispersion += ((y[index] - mu[index]) ** 2 - mu[index]) / (mu[index] ** 2);
  let alpha = Math.min(50, Math.max(0.01, dispersion / Math.max(1, n - p)));
  const predictor = (coefficients) => x.map((row, index) => Math.exp(K.dot(row, coefficients) + (offset ? offset[index] : 0)));
  let logLikelihood = nbLogLikelihood(y, mu, alpha, H);
  let iterations = 0;
  let converged = false;
  for (iterations = 1; iterations <= maxIterations; iterations += 1) {
    budget.check(1024);
    // Beta step: Newton with observed Hessian at fixed alpha.
    const weights = mu.map((m, index) => m * (1 + alpha * y[index]) / (1 + alpha * m) ** 2);
    let inverse;
    try { inverse = H.invert(K.crossProduct(x, weights, budget)); } catch { H.fail("STAT_SINGULAR_FIT", "negative binomial information matrix is singular"); }
    const score = K.crossVector(x, null, y.map((value, index) => (value - mu[index]) / (1 + alpha * mu[index])));
    const step = K.matVec(inverse, score);
    let scale = 1;
    let betaNext = beta;
    let muNext = mu;
    let llNext = logLikelihood;
    for (let halving = 0; halving < 40; halving += 1) {
      const trial = beta.map((value, index) => value + scale * step[index]);
      if (trial.every((value) => Number.isFinite(value) && Math.abs(value) < 50)) {
        const muTrial = predictor(trial);
        const llTrial = nbLogLikelihood(y, muTrial, alpha, H);
        if (Number.isFinite(llTrial) && llTrial >= logLikelihood - 1e-12) { betaNext = trial; muNext = muTrial; llNext = llTrial; break; }
      }
      scale /= 2;
    }
    const betaDelta = Math.max(...step.map((value) => Math.abs(scale * value)));
    beta = betaNext;
    mu = muNext;
    logLikelihood = llNext;
    // Alpha step: Newton on log(alpha) with step halving.
    const derivatives = nbAlphaDerivatives(y, mu, alpha);
    const gradLog = alpha * derivatives.first;
    const hessLog = alpha * alpha * derivatives.second + alpha * derivatives.first;
    let logStep = hessLog < 0 ? -gradLog / hessLog : Math.sign(gradLog) * 0.5;
    if (!Number.isFinite(logStep)) logStep = 0;
    logStep = Math.max(-2, Math.min(2, logStep));
    let alphaScale = 1;
    let alphaNext = alpha;
    let llAlpha = logLikelihood;
    for (let halving = 0; halving < 40; halving += 1) {
      const trial = Math.exp(Math.log(alpha) + alphaScale * logStep);
      if (trial > 1e-8 && trial < 1e4) {
        const llTrial = nbLogLikelihood(y, mu, trial, H);
        if (Number.isFinite(llTrial) && llTrial >= logLikelihood - 1e-12) { alphaNext = trial; llAlpha = llTrial; break; }
      }
      alphaScale /= 2;
    }
    const alphaDelta = Math.abs(Math.log(alphaNext) - Math.log(alpha));
    alpha = alphaNext;
    logLikelihood = llAlpha;
    if (Math.max(betaDelta, alphaDelta) < tolerance) { converged = true; break; }
  }
  if (!converged) H.fail("STAT_NON_CONVERGENCE", `negative binomial fit did not converge in ${maxIterations} iterations`);
  // Joint observed information in (beta, alpha).
  const size = p + 1;
  const hessian = Array.from({ length: size }, () => Array(size).fill(0));
  const weights = mu.map((m, index) => m * (1 + alpha * y[index]) / (1 + alpha * m) ** 2);
  const betaBlock = K.crossProduct(x, weights, budget);
  for (let j = 0; j < p; j += 1) for (let l = 0; l < p; l += 1) hessian[j][l] = -betaBlock[j][l];
  const cross = K.crossVector(x, null, y.map((value, index) => -(value - mu[index]) * mu[index] / (1 + alpha * mu[index]) ** 2));
  for (let j = 0; j < p; j += 1) { hessian[j][p] = cross[j]; hessian[p][j] = cross[j]; }
  hessian[p][p] = nbAlphaDerivatives(y, mu, alpha).second;
  let covariance;
  try { covariance = H.invert(hessian.map((row) => row.map((value) => -value))); } catch { H.fail("STAT_SINGULAR_FIT", "negative binomial joint information matrix is singular"); }
  let deviance = 0;
  let pearson = 0;
  for (let index = 0; index < n; index += 1) {
    const yi = y[index];
    const m = mu[index];
    deviance += 2 * ((yi > 0 ? yi * Math.log(yi / m) : 0) - (yi + 1 / alpha) * Math.log((1 + alpha * yi) / (1 + alpha * m)));
    pearson += (yi - m) ** 2 / (m + alpha * m * m);
  }
  return { beta, alpha, mu, covariance, logLikelihood, iterations, poisson, deviance, pearson };
}

const negativeBinomialRegression = {
  method: "negative_binomial_regression",
  family: "regression",
  analysisModel: { families: ["glm"], distributions: [null, "poisson", "negative-binomial", "negative_binomial"], links: [null, "log"] },
  optionKeys: ["confidenceLevel", "timeoutMs", "maxIterations", "tolerance"],
  customOptions: {},
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["y", "predictors"],
    properties: {
      y: { type: "array", minItems: 10, maxItems: MAX_ROWS, items: { type: "integer", minimum: 0 } },
      predictors: PREDICTORS_SCHEMA,
      exposure: { type: "array", minItems: 10, maxItems: MAX_ROWS, items: { type: "number", exclusiveMinimum: 0 } },
      outcomeLabel: LABEL_SCHEMA,
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["y", "predictors", "exposure", "outcomeLabel"], "data");
    const y = H.numericVector(data.y, "data.y", 10);
    limitRows(y.length, H, "negative_binomial_regression");
    y.forEach((value, index) => { if (!Number.isInteger(value) || value < 0) H.fail("STAT_INVALID_INPUT", `data.y[${index}] must be a non-negative integer count`); });
    if (y.every((value) => value === y[0])) H.fail("STAT_DEGENERATE", "data.y is constant");
    const predictors = H.regressionPredictors(data.predictors, y.length);
    let exposure = null;
    if (data.exposure !== undefined) {
      exposure = H.numericVector(data.exposure, "data.exposure", 10);
      if (exposure.length !== y.length) H.fail("STAT_INVALID_INPUT", "data.exposure length must match data.y");
      exposure.forEach((value, index) => { if (!(value > 0)) H.fail("STAT_INVALID_INPUT", `data.exposure[${index}] must be positive`); });
    }
    return { y, predictors, exposure, outcomeLabel: H.label(data.outcomeLabel, "Count", "data.outcomeLabel") };
  },
  analyze(parsed, options, budget, H) {
    const { y, predictors, exposure } = parsed;
    const n = y.length;
    const design = K.buildDesign(y, predictors, H, true);
    const p = design.terms.length;
    const offset = exposure ? exposure.map((value) => Math.log(value)) : null;
    const maxIterations = Math.max(options.maxIterations, 100);
    const fit = fitNegativeBinomial(y, design.x, offset, H, budget, { maxIterations, tolerance: options.tolerance });
    const nullFit = fitNegativeBinomial(y, y.map(() => [1]), offset, H, budget, { maxIterations, tolerance: options.tolerance });
    const names = design.terms.map((term) => term.name);
    const level = options.confidenceLevel;
    const betaCovariance = (fit.alpha <= 1e-6 ? fit.poisson.covariance : fit.covariance.slice(0, p).map((row) => row.slice(0, p)));
    const coefficientRows = K.coefficientRows(names, fit.beta, betaCovariance, null, level, H, { expKey: "incidenceRateRatio" });
    const alphaAtBoundary = fit.alpha <= 1e-6 || !(fit.covariance[p][p] > 0) || !Number.isFinite(fit.covariance[p][p]);
    const alphaSe = alphaAtBoundary ? null : Math.sqrt(fit.covariance[p][p]);
    const z = H.normalInv(1 - (1 - level) / 2);
    const alphaRow = alphaAtBoundary
      ? { term: "alpha (NB2 dispersion)", estimate: fit.alpha, standardError: null, statistic: null, df: null, pValue: null, lower: null, upper: null }
      : { term: "alpha (NB2 dispersion)", estimate: fit.alpha, standardError: alphaSe, statistic: fit.alpha / alphaSe, df: null, pValue: H.pFromNormal(fit.alpha / alphaSe, "two-sided"), lower: fit.alpha - z * alphaSe, upper: fit.alpha + z * alphaSe };
    const lrPoisson = 2 * (fit.logLikelihood - fit.poisson.logLikelihood);
    const lrPoissonP = 0.5 * H.pFromChiSquare(Math.max(0, lrPoisson), 1);
    const lrNull = 2 * (fit.logLikelihood - nullFit.logLikelihood);
    const criteria = informationCriteria(fit.logLikelihood, p + 1, n);
    const poissonCriteria = informationCriteria(fit.poisson.logLikelihood, p, n);
    const pseudo = pseudoRSquared(fit.logLikelihood, nullFit.logLikelihood, n);
    const dispersionRows = [
      { model: "Poisson", logLikelihood: fit.poisson.logLikelihood, aic: poissonCriteria.aic, bic: poissonCriteria.bic, pearsonChiSquare: fit.poisson.pearson, deviance: fit.poisson.deviance, residualDf: n - p, pearsonDispersion: fit.poisson.pearson / (n - p) },
      { model: "Negative binomial (NB2)", logLikelihood: fit.logLikelihood, aic: criteria.aic, bic: criteria.bic, pearsonChiSquare: fit.pearson, deviance: fit.deviance, residualDf: n - p - 1, pearsonDispersion: fit.pearson / (n - p - 1) },
    ];
    return {
      sample: { n, predictors: predictors.length, designColumns: p, totalCount: y.reduce((total, value) => total + value, 0), zeros: y.filter((value) => value === 0).length, exposureOffset: Boolean(exposure) },
      estimates: [
        ...coefficientRows.map((row) => ({ ...row, kind: "coefficient" })),
        { ...alphaRow, kind: "dispersion" },
        { term: "log-likelihood", estimate: fit.logLikelihood, kind: "fit" },
        { term: "Poisson log-likelihood", estimate: fit.poisson.logLikelihood, kind: "fit" },
        { term: "AIC", estimate: criteria.aic, kind: "fit" },
        { term: "BIC", estimate: criteria.bic, kind: "fit" },
      ],
      tests: [
        { name: "likelihood-ratio test of overdispersion (NB2 versus Poisson, alpha = 0 on the boundary)", statistic: lrPoisson, df: 1, pValue: lrPoissonP, distribution: "0.5 chi-square(1) boundary mixture", boundary: "alpha = 0 lies on the parameter boundary so the null distribution is a 50:50 mixture of a point mass at zero and chi-square(1)" },
        { name: "likelihood-ratio test versus intercept-only NB2 model", statistic: lrNull, df: p - 1, pValue: H.pFromChiSquare(Math.max(0, lrNull), p - 1), distribution: "chi-square" },
      ],
      confidenceIntervals: [
        ...coefficientRows.map((row) => ({ parameter: `incidence rate ratio ${row.term}`, level, lower: row.incidenceRateRatioLower, upper: row.incidenceRateRatioUpper, method: "Wald on the log scale" })),
        { parameter: "alpha", level, lower: alphaRow.lower, upper: alphaRow.upper, method: alphaAtBoundary ? "not estimated: alpha at the Poisson boundary" : "Wald from the joint observed information" },
      ],
      effectSizes: [
        { name: "McFadden pseudo R-squared", estimate: pseudo.mcFadden },
        { name: "Pearson dispersion ratio (Poisson)", estimate: fit.poisson.pearson / (n - p) },
        { name: "Pearson dispersion ratio (NB2)", estimate: fit.pearson / (n - p - 1) },
      ],
      assumptions: [
        { name: "count outcome with NB2 variance mu + alpha mu^2", status: fit.alpha < 1e-4 ? "alpha_near_zero_poisson_adequate" : "diagnostic_attached" },
        { name: "log-linear mean structure", status: "requires_design_review" },
        { name: "independent observations", status: "requires_design_review" },
        { name: "no excess zeros beyond NB2", status: "not_established", detail: "zero-inflation is not tested; compare observed zeros with model-implied zeros before interpreting" },
      ],
      diagnostics: [
        convergenceDiagnostic(fit.iterations, maxIterations, options.tolerance, { algorithm: "alternating Newton steps on beta (observed information) and log(alpha), joint observed information for standard errors" }),
        { name: "overdispersion", status: lrPoissonP < 0.05 ? "poisson_rejected" : "poisson_not_rejected", poissonPearsonDispersion: fit.poisson.pearson / (n - p), alpha: fit.alpha },
        { name: "alpha boundary", status: alphaAtBoundary ? "at_lower_boundary_no_standard_error" : "interior", alpha: fit.alpha, detail: alphaAtBoundary ? "alpha collapsed to the Poisson limit; coefficient standard errors are taken from the Poisson information and no alpha interval is reported" : "alpha is interior; joint observed information used" },
        { name: "information criteria", aic: criteria.aic, bic: criteria.bic, poissonAic: poissonCriteria.aic, poissonBic: poissonCriteria.bic },
        { name: "inference boundary", status: "asymptotic", detail: "Wald intervals rely on large-sample normality; the alpha interval is symmetric on the natural scale and may cross zero for weak overdispersion" },
      ],
      artifacts: [
        H.tableArtifact("Negative binomial (NB2) coefficients", `Log-linear rate model for ${parsed.outcomeLabel}${exposure ? " with log(exposure) offset" : ""}; ${percent(level)} Wald intervals.`, K.coefficientColumns("z", [NUMBER_COLUMN("incidenceRateRatio", "IRR"), NUMBER_COLUMN("incidenceRateRatioLower", "IRR lower"), NUMBER_COLUMN("incidenceRateRatioUpper", "IRR upper")]), coefficientRows, [`alpha = ${fit.alpha.toPrecision(6)}${alphaSe === null ? " (at the Poisson boundary, no SE)" : ` (SE ${alphaSe.toPrecision(6)})`}; variance = mu + alpha mu^2.`], "negative-binomial-coefficients-table"),
        H.tableArtifact("Poisson versus negative binomial fit", "Overdispersion evidence: Pearson dispersion near 1 supports the model variance assumption.", [STRING_COLUMN("model", "Model"), NUMBER_COLUMN("logLikelihood", "Log-likelihood"), NUMBER_COLUMN("aic", "AIC"), NUMBER_COLUMN("bic", "BIC"), NUMBER_COLUMN("pearsonChiSquare", "Pearson chi-square"), NUMBER_COLUMN("deviance", "Deviance"), NUMBER_COLUMN("residualDf", "Residual df"), NUMBER_COLUMN("pearsonDispersion", "Pearson dispersion")], dispersionRows, [`Boundary LR test of alpha = 0: statistic ${lrPoisson.toPrecision(6)}, p = ${lrPoissonP.toPrecision(4)}.`], "negative-binomial-dispersion-table"),
        K.forestPlot(H, "negative-binomial-irr-forest", `Incidence rate ratios with ${percent(level)} intervals`, coefficientRows, { xTitle: "Incidence rate ratio (log scale)", estimateField: "incidenceRateRatio", lowerField: "incidenceRateRatioLower", upperField: "incidenceRateRatioUpper", referenceValue: 1, logScale: true }),
      ],
    };
  },
  linkage: {
    neededWhen: "The outcome is a count whose variance exceeds its mean (overdispersion) so that Poisson standard errors would be too small.",
    decision: "Whether overdispersion is real, how large the adjusted incidence rate ratios are, and whether the Poisson model should be abandoned.",
    mustShow: "Incidence rate ratios with intervals, the estimated dispersion alpha with its uncertainty, the boundary likelihood-ratio test versus Poisson, and Pearson dispersion for both models.",
    userGoal: "Report count-regression effects with standard errors that respect the extra-Poisson variation in the data.",
    nextActions: [
      { trigger: "poisson-not-rejected", action: "report-poisson-model-as-primary-with-nb-sensitivity", reason: "When alpha is near zero the simpler Poisson model is adequate and the NB interval on alpha is uninformative." },
      { trigger: "excess-zeros-suspected", action: "compare-zero-inflated-or-hurdle-specification", reason: "NB2 absorbs overdispersion but not a separate zero-generating process, which biases rate ratios." },
      { trigger: "exposure-varies-across-units", action: "confirm-exposure-offset-is-declared", reason: "Without the log-exposure offset the rate ratios confound event rates with observation time." },
      { trigger: "interpretable-rate-ratios", action: "bind-irr-forest-and-dispersion-table", reason: "Readers need both the effect sizes and the evidence that the variance model is appropriate." },
    ],
  },
  fixture: {
    data: {
      y: [11, 18, 0, 2, 0, 0, 0, 0, 0, 1, 11, 7, 2, 0, 5, 1, 13, 12, 13, 18, 7, 9, 2, 2, 5, 1, 12, 12, 21, 2, 0, 18, 4, 19, 7, 10],
      predictors: [
        { name: "exposureIndex", values: [3.3, 4.4, 0.5, 0.8, 1.7, 2.3, 0.4, 0.3, 1.1, 1.8, 3.4, 2.8, 0.2, 0.3, 2.1, 3.9, 4.1, 1.7, 4.0, 4.2, 1.9, 3.4, 1.7, 0.8, 2.6, 0.5, 3.0, 3.7, 4.1, 2.1, 0.6, 4.1, 3.9, 4.4, 2.7, 3.1] },
        { name: "site", type: "categorical", values: ["A", "B", "A", "B", "A", "B", "A", "B", "A", "B", "A", "B", "A", "B", "A", "B", "A", "B", "A", "B", "A", "B", "A", "B", "A", "B", "A", "B", "A", "B", "A", "B", "A", "B", "A", "B"] },
      ],
      exposure: [2, 1, 1.5, 1, 1, 1.5, 1, 1, 2, 1, 1, 1, 2, 2, 1.5, 1, 1.5, 2, 2, 2, 1, 1, 1.5, 1, 1, 1, 2, 2, 1.5, 1.5, 1, 1.5, 1, 1, 1.5, 1.5],
      outcomeLabel: "Events",
    },
    options: { confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "NB2 negative binomial regression with alpha estimated by maximum likelihood, log-exposure offset, joint observed-information standard errors, boundary likelihood-ratio test versus Poisson, and dispersion diagnostics.",
    oracle: {
      level: "external-library-partial",
      evidence: ["contracts/regression-extended-scipy-crosscheck.py"],
      verifiedOutputs: ["coefficients", "alpha", "coefficient standard errors", "alpha standard error", "log-likelihood", "Poisson log-likelihood"],
      excludedOutputs: ["pseudo R-squared", "deviance", "Pearson dispersion", "intercept-only NB2 likelihood-ratio test"],
    },
    diagnostic: { level: "method-specific-partial", emitted: ["overdispersion", "alpha boundary", "convergence", "information criteria"], limitations: ["no zero-inflation test", "no influence diagnostics", "no NB1 variance function"] },
    knownGaps: ["zero-inflated and hurdle models are not implemented", "NB1 (linear variance) parameterization is not offered", "no robust sandwich standard errors"],
  },
};

/* ------------------------------------------------------------------------------------------ */
/* Penalized regression: ridge, lasso, elastic net                                             */
/* ------------------------------------------------------------------------------------------ */

const LAMBDAS_OPTION = {
  schema: { type: "array", minItems: 2, maxItems: 200, items: { type: "number", exclusiveMinimum: 0 } },
  default: null,
  parse(value, H, path) {
    if (!Array.isArray(value) || value.length < 2 || value.length > 200) H.fail("STAT_INVALID_INPUT", `${path} must list 2 to 200 positive penalties`);
    const lambdas = value.map((item, index) => { const number = H.finiteNumber(item, `${path}[${index}]`); if (!(number > 0)) H.fail("STAT_INVALID_INPUT", `${path}[${index}] must be positive`); return number; });
    const sorted = [...lambdas].sort((a, b) => b - a);
    if (new Set(sorted).size !== sorted.length) H.fail("STAT_INVALID_INPUT", `${path} must not contain duplicates`);
    return sorted;
  },
};
const SEED_OPTION = { schema: { type: "integer", minimum: 0, maximum: 4294967295 }, default: 20240901, parse(value, H, path) { return H.integer(value, 0, 4294967295, path); } };
const FOLDS_OPTION = { schema: { type: "integer", minimum: 2, maximum: 20 }, default: 5, parse(value, H, path) { return H.integer(value, 2, 20, path); } };

/** Standardized design (no intercept column) plus centered outcome for penalized fits. */
function standardizedProblem(parsed, H) {
  const design = K.buildDesign(parsed.y, parsed.predictors, H, false);
  const { z, centers, scales } = K.standardizeColumns(design.x, H);
  const yMean = K.mean(parsed.y);
  const yc = parsed.y.map((value) => value - yMean);
  return { design, z, centers, scales, yMean, yc, names: design.terms.map((term) => term.name) };
}

function originalScaleRow(names, standardized, centers, scales, yMean) {
  const original = standardized.map((value, index) => value / scales[index]);
  const intercept = yMean - original.reduce((total, value, index) => total + value * centers[index], 0);
  return { original, intercept };
}

function ridgeSolve(z, yc, lambda, H, budget) {
  const gram = K.crossProduct(z, null, budget);
  const p = gram.length;
  const penalized = gram.map((row, index) => row.map((value, column) => value + (index === column ? lambda : 0)));
  const inverse = K.invertSymmetric(penalized, H, "STAT_SINGULAR_FIT", "ridge system is singular");
  const beta = K.matVec(inverse, K.crossVector(z, null, yc));
  // effective df = trace(Z (Z'Z + lambda I)^-1 Z') = trace(inverse * gram)
  let df = 0;
  for (let j = 0; j < p; j += 1) for (let l = 0; l < p; l += 1) df += inverse[j][l] * gram[l][j];
  return { beta, inverse, df, gram };
}

const ridgeRegression = {
  method: "ridge_regression",
  family: "regression",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    lambdas: LAMBDAS_OPTION,
    selection: { schema: { type: "string", enum: ["gcv", "loocv"] }, default: "gcv", parse(value, H, path) { if (!["gcv", "loocv"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be gcv or loocv`); return value; } },
  },
  dataSchema: { type: "object", additionalProperties: false, required: ["y", "predictors"], properties: { y: NUMERIC_SCHEMA(8), predictors: PREDICTORS_SCHEMA, outcomeLabel: LABEL_SCHEMA } },
  parse(data, options, H) {
    H.assertKeys(data, ["y", "predictors", "outcomeLabel"], "data");
    return parseNumericOutcome(data, H, "ridge_regression", 8);
  },
  analyze(parsed, options, budget, H) {
    const problem = standardizedProblem(parsed, H);
    const { z, yc, names, centers, scales, yMean } = problem;
    const n = yc.length;
    const p = names.length;
    const lambdas = options.lambdas || K.logSpacedGrid(1000, 1e-6, 25);
    const summaryRows = [];
    const pathRows = [];
    const solutions = [];
    for (const lambda of lambdas) {
      budget.check(1024);
      const solution = ridgeSolve(z, yc, lambda, H, budget);
      const fitted = z.map((row) => K.dot(row, solution.beta));
      let rss = 0;
      let press = 0;
      for (let index = 0; index < n; index += 1) {
        const residual = yc[index] - fitted[index];
        rss += residual * residual;
        const leverage = 1 / n + H.quadraticForm(z[index], solution.inverse);
        press += (residual / (1 - leverage)) ** 2;
      }
      const effectiveDf = solution.df + 1;
      const gcv = (rss / n) / (1 - effectiveDf / n) ** 2;
      const loocv = press / n;
      solutions.push({ lambda, ...solution, rss, gcv, loocv, effectiveDf });
      summaryRows.push({ lambda, effectiveDf, rss, gcv, loocv, selected: false });
      const scaled = originalScaleRow(names, solution.beta, centers, scales, yMean);
      solution.beta.forEach((value, index) => pathRows.push({ lambda, term: names[index], standardizedCoefficient: value, coefficient: scaled.original[index] }));
    }
    const criterion = options.selection;
    let bestIndex = 0;
    solutions.forEach((solution, index) => { if (solution[criterion] < solutions[bestIndex][criterion]) bestIndex = index; });
    summaryRows[bestIndex].selected = true;
    const best = solutions[bestIndex];
    const scaled = originalScaleRow(names, best.beta, centers, scales, yMean);
    const coefficientRows = [
      { term: "Intercept", coefficient: scaled.intercept, standardizedCoefficient: null, shrinkageRatio: null },
    ];
    const ols = K.olsFit(yc, z, H, budget);
    best.beta.forEach((value, index) => coefficientRows.push({ term: names[index], coefficient: scaled.original[index], standardizedCoefficient: value, shrinkageRatio: ols.beta[index] !== 0 ? value / ols.beta[index] : null }));
    const tss = yc.reduce((total, value) => total + value * value, 0);
    const boundary = bestIndex === 0 ? "selected_penalty_at_grid_maximum" : bestIndex === solutions.length - 1 ? "selected_penalty_at_grid_minimum" : "interior";
    return {
      sample: { n, predictors: parsed.predictors.length, designColumns: p, penalties: lambdas.length },
      estimates: [
        ...coefficientRows.map((row) => ({ ...row, kind: "coefficient", lambda: best.lambda })),
        { term: "selected lambda", estimate: best.lambda, kind: "tuning", criterion },
        { term: "effective degrees of freedom", estimate: best.effectiveDf, kind: "tuning" },
        { term: "GCV at selected lambda", estimate: best.gcv, kind: "tuning" },
        { term: "LOOCV mean squared error at selected lambda", estimate: best.loocv, kind: "tuning" },
      ],
      tests: [],
      confidenceIntervals: [],
      effectSizes: [
        { name: "in-sample R-squared at selected lambda", estimate: tss > 0 ? 1 - best.rss / tss : 0 },
        { name: "OLS R-squared (unpenalized)", estimate: ols.rSquared },
      ],
      assumptions: [
        { name: "linear mean structure", status: "requires_design_review" },
        { name: "predictors standardized before penalization", status: "verified_by_construction", detail: "columns centered and scaled to unit sample standard deviation; intercept unpenalized" },
        { name: "homoscedastic errors for GCV/LOOCV interpretation", status: "not_established" },
      ],
      diagnostics: [
        { name: "penalty selection", criterion, selectedLambda: best.lambda, status: boundary, gridMinimum: lambdas[lambdas.length - 1], gridMaximum: lambdas[0] },
        { name: "shrinkage", status: "reported", meanShrinkageRatio: K.mean(coefficientRows.slice(1).map((row) => row.shrinkageRatio).filter((value) => value !== null)) },
        { name: "inference boundary", status: "no_standard_errors", detail: "ridge estimates are biased and no sampling-based intervals are reported; use resampling for uncertainty" },
      ],
      artifacts: [
        H.tableArtifact("Ridge coefficients at the selected penalty", `Coefficients for ${parsed.outcomeLabel} at lambda = ${best.lambda.toPrecision(6)} chosen by ${criterion.toUpperCase()}.`, [STRING_COLUMN("term", "Term"), NUMBER_COLUMN("coefficient", "Coefficient (original scale)"), NUMBER_COLUMN("standardizedCoefficient", "Standardized coefficient"), NUMBER_COLUMN("shrinkageRatio", "Ratio to OLS")], coefficientRows, ["Penalty applied on standardized predictors: minimize ||y - b0 - Zw||^2 + lambda ||w||^2."], "ridge-coefficients-table"),
        H.tableArtifact("Ridge penalty path summary", "Effective degrees of freedom, residual sum of squares, GCV, and leave-one-out cross-validation error along the penalty grid.", [NUMBER_COLUMN("lambda", "lambda"), NUMBER_COLUMN("effectiveDf", "Effective df"), NUMBER_COLUMN("rss", "RSS"), NUMBER_COLUMN("gcv", "GCV"), NUMBER_COLUMN("loocv", "LOOCV MSE"), BOOLEAN_COLUMN("selected", "Selected")], summaryRows, ["GCV = (RSS/n) / (1 - df/n)^2 with df = trace of the hat matrix including the intercept."], "ridge-path-summary-table"),
        H.tableArtifact("Ridge coefficient path", "Standardized and original-scale coefficients for every penalty on the grid.", [NUMBER_COLUMN("lambda", "lambda"), STRING_COLUMN("term", "Term"), NUMBER_COLUMN("standardizedCoefficient", "Standardized coefficient"), NUMBER_COLUMN("coefficient", "Coefficient")], pathRows, [], "ridge-path-table"),
        H.vegaArtifact("ridge-coefficient-path", `Ridge coefficient path (selected lambda = ${best.lambda.toPrecision(4)})`, {
          data: { values: pathRows },
          layer: [
            { mark: { type: "line", point: true }, encoding: { x: { field: "lambda", type: "quantitative", scale: { type: "log" }, title: "lambda (log scale)" }, y: { field: "standardizedCoefficient", type: "quantitative", title: "Standardized coefficient" }, color: { field: "term", type: "nominal", title: "Term" }, tooltip: [{ field: "term" }, { field: "lambda", format: ".4g" }, { field: "standardizedCoefficient", format: ".4g" }] } },
            { mark: { type: "rule", strokeDash: [4, 4], color: "#777" }, encoding: { x: { datum: best.lambda } } },
            { mark: { type: "rule", color: "#999" }, encoding: { y: { datum: 0 } } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "Predictors are numerous or collinear so ordinary least squares coefficients are unstable, and the goal is a stable predictive or descriptive linear model.",
    decision: "How much shrinkage to apply, which penalty the cross-validation criteria support, and how the shrunken coefficients differ from the unpenalized fit.",
    mustShow: "The penalty grid with GCV and leave-one-out error, the selected penalty and its effective degrees of freedom, the coefficient path, and the coefficients on both standardized and original scales.",
    userGoal: "Obtain a regularized linear model with a transparent, criterion-based choice of penalty strength.",
    nextActions: [
      { trigger: "selected-penalty-at-grid-boundary", action: "extend-lambda-grid-and-refit", reason: "A boundary optimum means the grid did not bracket the criterion minimum and the chosen penalty is arbitrary." },
      { trigger: "variable-selection-needed", action: "compare-lasso-or-elastic-net-path", reason: "Ridge shrinks but never zeroes coefficients, so a sparse model requires an L1 penalty." },
      { trigger: "uncertainty-required", action: "plan-bootstrap-or-post-selection-inference", reason: "Ridge does not deliver valid standard errors, so intervals must come from a declared resampling plan." },
      { trigger: "stable-shrunken-fit", action: "bind-coefficient-path-and-selected-coefficients", reason: "Readers need the whole path to judge sensitivity to the penalty choice." },
    ],
  },
  fixture: {
    data: {
      y: [12.1, 14.3, 15.9, 18.2, 20.4, 21.7, 24.1, 26.3, 27.8, 30.2, 31.5, 33.9, 36.1, 37.6, 40.2, 41.8],
      predictors: [
        { name: "x1", values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] },
        { name: "x2", values: [1.2, 1.9, 3.2, 3.9, 5.1, 6.2, 6.8, 8.1, 9.3, 9.8, 11.2, 12.1, 12.8, 14.2, 15.1, 15.9] },
        { name: "x3", values: [0.5, -0.2, 0.8, 1.1, -0.6, 0.3, 1.4, -0.9, 0.2, 0.7, -0.4, 1.0, -0.1, 0.6, -0.8, 0.9] },
      ],
      outcomeLabel: "Yield",
    },
    options: { selection: "gcv" },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression", "matlab.stats.machine-learning-pipelines"] },
  coverage: {
    implementedBoundary: "Ridge regression on standardized predictors with an unpenalized intercept, closed-form solutions along a penalty grid, effective degrees of freedom, generalized cross-validation, and exact leave-one-out cross-validation via the hat matrix.",
    oracle: {
      level: "external-library-partial",
      evidence: ["contracts/regression-extended-scipy-crosscheck.py"],
      verifiedOutputs: ["standardized coefficients along the grid (sklearn Ridge)", "original-scale coefficients", "intercept", "GCV", "LOOCV mean squared error", "effective degrees of freedom"],
      excludedOutputs: ["shrinkage ratio", "penalty selection boundary flag"],
    },
    diagnostic: { level: "method-specific-partial", emitted: ["penalty selection boundary", "shrinkage", "inference boundary"], limitations: ["no k-fold cross-validation", "no standard errors", "no residual diagnostics"] },
    knownGaps: ["no per-predictor penalty factors", "no weighted observations", "GCV assumes homoscedastic errors"],
  },
};

/** Coordinate descent for (1/2n)||y - Zw||^2 + lambda (l1 ||w||_1 + (1 - l1)/2 ||w||^2), warm-started along decreasing lambdas. */
function coordinateDescentPath(z, yc, lambdas, l1Ratio, H, budget, { tolerance = 1e-12, maxSweeps = 50000 } = {}) {
  const n = yc.length;
  const p = z[0].length;
  const columnScale = Array(p).fill(0);
  for (let j = 0; j < p; j += 1) {
    let total = 0;
    for (let index = 0; index < n; index += 1) total += z[index][j] ** 2;
    columnScale[j] = total / n;
  }
  let w = Array(p).fill(0);
  const residual = [...yc];
  const path = [];
  for (const lambda of lambdas) {
    const l1 = lambda * l1Ratio;
    const l2 = lambda * (1 - l1Ratio);
    let sweeps = 0;
    let converged = false;
    for (sweeps = 1; sweeps <= maxSweeps; sweeps += 1) {
      budget.check(p * n);
      let maxChange = 0;
      for (let j = 0; j < p; j += 1) {
        let rho = 0;
        for (let index = 0; index < n; index += 1) rho += z[index][j] * residual[index];
        rho = rho / n + columnScale[j] * w[j];
        const soft = Math.abs(rho) <= l1 ? 0 : (rho > 0 ? rho - l1 : rho + l1);
        const next = soft / (columnScale[j] + l2);
        const change = next - w[j];
        if (change !== 0) {
          for (let index = 0; index < n; index += 1) residual[index] -= z[index][j] * change;
          w[j] = next;
          maxChange = Math.max(maxChange, Math.abs(change));
        }
      }
      if (maxChange < tolerance) { converged = true; break; }
    }
    if (!converged) H.fail("STAT_NON_CONVERGENCE", `coordinate descent did not converge at lambda = ${lambda}`);
    let rss = 0;
    for (let index = 0; index < n; index += 1) rss += residual[index] ** 2;
    path.push({ lambda, coefficients: [...w], rss, nonzero: w.filter((value) => value !== 0).length, sweeps });
  }
  return path;
}

function centeredSubset(z, y, rows) {
  const p = z[0].length;
  const means = Array(p).fill(0);
  for (const row of rows) for (let j = 0; j < p; j += 1) means[j] += z[row][j];
  for (let j = 0; j < p; j += 1) means[j] /= rows.length;
  let yMean = 0;
  for (const row of rows) yMean += y[row];
  yMean /= rows.length;
  const zc = rows.map((row) => z[row].map((value, j) => value - means[j]));
  const yc = rows.map((row) => y[row] - yMean);
  return { zc, yc, means, yMean };
}

function crossValidatePath(z, yc, lambdas, l1Ratio, folds, k, H, budget) {
  const n = yc.length;
  const perFold = Array.from({ length: k }, () => Array(lambdas.length).fill(0));
  for (let fold = 0; fold < k; fold += 1) {
    const train = [];
    const test = [];
    for (let index = 0; index < n; index += 1) (folds[index] === fold ? test : train).push(index);
    if (test.length === 0 || train.length <= z[0].length) H.fail("STAT_INSUFFICIENT_SAMPLE", "a cross-validation fold has too few observations");
    const subset = centeredSubset(z, yc, train);
    const path = coordinateDescentPath(subset.zc, subset.yc, lambdas, l1Ratio, H, budget);
    path.forEach((solution, lambdaIndex) => {
      let total = 0;
      for (const row of test) {
        let prediction = subset.yMean;
        for (let j = 0; j < z[0].length; j += 1) prediction += solution.coefficients[j] * (z[row][j] - subset.means[j]);
        total += (yc[row] - prediction) ** 2;
      }
      perFold[fold][lambdaIndex] = total / test.length;
    });
  }
  return lambdas.map((lambda, lambdaIndex) => {
    const values = perFold.map((row) => row[lambdaIndex]);
    const meanMse = K.mean(values);
    const standardError = Math.sqrt(K.sampleVariance(values) / k);
    return { lambda, meanMse, standardError, foldMse: values };
  });
}

function penalizedAnalyze(parsed, options, budget, H, { l1Ratio, label, role }) {
  const problem = standardizedProblem(parsed, H);
  const { z, yc, names, centers, scales, yMean } = problem;
  const n = yc.length;
  const p = names.length;
  let lambdaMax = 0;
  for (let j = 0; j < p; j += 1) {
    let total = 0;
    for (let index = 0; index < n; index += 1) total += z[index][j] * yc[index];
    lambdaMax = Math.max(lambdaMax, Math.abs(total) / n);
  }
  lambdaMax /= l1Ratio;
  if (!(lambdaMax > 0)) H.fail("STAT_DEGENERATE", "outcome is uncorrelated with every predictor; the penalty path is empty");
  const lambdas = options.lambdas || K.logSpacedGrid(lambdaMax, options.lambdaRatio, options.nLambdas);
  const k = options.folds;
  if (n < 2 * k) H.fail("STAT_INSUFFICIENT_SAMPLE", `at least ${2 * k} observations are required for ${k}-fold cross-validation`);
  const folds = K.seededFolds(n, k, options.seed);
  const fullPath = coordinateDescentPath(z, yc, lambdas, l1Ratio, H, budget);
  const cv = crossValidatePath(z, yc, lambdas, l1Ratio, folds, k, H, budget);
  let minIndex = 0;
  cv.forEach((row, index) => { if (row.meanMse < cv[minIndex].meanMse) minIndex = index; });
  const threshold = cv[minIndex].meanMse + cv[minIndex].standardError;
  let oneSeIndex = minIndex;
  for (let index = 0; index <= minIndex; index += 1) { if (cv[index].meanMse <= threshold) { oneSeIndex = index; break; } }
  const cvRows = cv.map((row, index) => ({ lambda: row.lambda, meanMse: row.meanMse, standardError: row.standardError, lower: row.meanMse - row.standardError, upper: row.meanMse + row.standardError, nonzero: fullPath[index].nonzero, rule: index === minIndex ? "lambda.min" : index === oneSeIndex ? "lambda.1se" : "" }));
  const tss = yc.reduce((total, value) => total + value * value, 0);
  const coefficientRowsFor = (index, rule) => {
    const solution = fullPath[index];
    const scaled = originalScaleRow(names, solution.coefficients, centers, scales, yMean);
    const rows = [{ rule, lambda: solution.lambda, term: "Intercept", coefficient: scaled.intercept, standardizedCoefficient: null, selected: true }];
    solution.coefficients.forEach((value, j) => rows.push({ rule, lambda: solution.lambda, term: names[j], coefficient: scaled.original[j], standardizedCoefficient: value, selected: value !== 0 }));
    return rows;
  };
  const coefficientRows = [...coefficientRowsFor(minIndex, "lambda.min"), ...coefficientRowsFor(oneSeIndex, "lambda.1se")];
  const pathRows = [];
  fullPath.forEach((solution) => solution.coefficients.forEach((value, j) => pathRows.push({ lambda: solution.lambda, term: names[j], standardizedCoefficient: value })));
  const best = fullPath[minIndex];
  const boundary = minIndex === lambdas.length - 1 ? "lambda_min_at_grid_minimum" : minIndex === 0 ? "lambda_min_at_grid_maximum" : "interior";
  return {
    sample: { n, predictors: parsed.predictors.length, designColumns: p, penalties: lambdas.length, folds: k, seed: options.seed },
    estimates: [
      ...coefficientRows.map((row) => ({ ...row, kind: "coefficient" })),
      { term: "lambda.min", estimate: lambdas[minIndex], kind: "tuning", cvMse: cv[minIndex].meanMse },
      { term: "lambda.1se", estimate: lambdas[oneSeIndex], kind: "tuning", cvMse: cv[oneSeIndex].meanMse },
      { term: "lambda.max", estimate: lambdaMax, kind: "tuning" },
      { term: "nonzero coefficients at lambda.min", estimate: best.nonzero, kind: "tuning" },
      { term: "l1 ratio", estimate: l1Ratio, kind: "tuning" },
    ],
    tests: [],
    confidenceIntervals: [],
    effectSizes: [
      { name: "in-sample R-squared at lambda.min", estimate: tss > 0 ? 1 - best.rss / tss : 0 },
      { name: "cross-validated MSE at lambda.min", estimate: cv[minIndex].meanMse, standardError: cv[minIndex].standardError },
    ],
    assumptions: [
      { name: "linear mean structure", status: "requires_design_review" },
      { name: "predictors standardized before penalization", status: "verified_by_construction" },
      { name: "cross-validation folds are exchangeable", status: "requires_design_review", detail: "seeded random folds ignore clustering or time ordering" },
    ],
    diagnostics: [
      { name: "penalty selection", status: boundary, lambdaMin: lambdas[minIndex], lambdaOneSe: lambdas[oneSeIndex], criterion: `${k}-fold cross-validated mean squared error with seed ${options.seed}` },
      { name: "coordinate descent", status: "converged", maxSweeps: Math.max(...fullPath.map((solution) => solution.sweeps)), tolerance: 1e-12 },
      { name: "inference boundary", status: "no_standard_errors", detail: "penalized estimates are biased; selected-variable p-values are not valid without post-selection inference" },
    ],
    artifacts: [
      H.tableArtifact(`${label} coefficients at lambda.min and lambda.1se`, `Coefficients for ${parsed.outcomeLabel}; lambda.min minimizes cross-validated error, lambda.1se is the most regularized penalty within one standard error.`, [STRING_COLUMN("rule", "Rule"), NUMBER_COLUMN("lambda", "lambda"), STRING_COLUMN("term", "Term"), NUMBER_COLUMN("coefficient", "Coefficient (original scale)"), NUMBER_COLUMN("standardizedCoefficient", "Standardized coefficient"), BOOLEAN_COLUMN("selected", "Nonzero")], coefficientRows, [`Objective: (1/2n)||y - b0 - Zw||^2 + lambda (${l1Ratio} ||w||_1 + ${(1 - l1Ratio) / 2} ||w||^2) on standardized predictors.`], `${role}-coefficients-table`),
      H.tableArtifact(`${label} cross-validation curve`, `Mean ${k}-fold cross-validated squared error with one-standard-error bands along the penalty grid.`, [NUMBER_COLUMN("lambda", "lambda"), NUMBER_COLUMN("meanMse", "CV MSE"), NUMBER_COLUMN("standardError", "SE"), NUMBER_COLUMN("lower", "MSE - SE"), NUMBER_COLUMN("upper", "MSE + SE"), NUMBER_COLUMN("nonzero", "Nonzero coefficients"), STRING_COLUMN("rule", "Rule")], cvRows, ["Folds are assigned by a seeded SplitMix64 shuffle; change options.seed to assess fold sensitivity."], `${role}-cv-table`),
      H.tableArtifact(`${label} coefficient path`, "Standardized coefficients for every penalty on the grid.", [NUMBER_COLUMN("lambda", "lambda"), STRING_COLUMN("term", "Term"), NUMBER_COLUMN("standardizedCoefficient", "Standardized coefficient")], pathRows, [], `${role}-path-table`),
      H.vegaArtifact(`${role}-cv-curve`, `${label}: cross-validated error along the penalty path`, {
        data: { values: cvRows },
        layer: [
          { mark: { type: "errorbar", ticks: true }, encoding: { x: { field: "lambda", type: "quantitative", scale: { type: "log" }, title: "lambda (log scale)" }, y: { field: "lower", type: "quantitative", title: "Cross-validated MSE" }, y2: { field: "upper" } } },
          { mark: { type: "point", filled: true, color: "#c0392b" }, encoding: { x: { field: "lambda", type: "quantitative", scale: { type: "log" } }, y: { field: "meanMse", type: "quantitative" }, tooltip: [{ field: "lambda", format: ".4g" }, { field: "meanMse", format: ".4g" }, { field: "nonzero" }] } },
          { mark: { type: "rule", strokeDash: [4, 4], color: "#555" }, encoding: { x: { datum: lambdas[minIndex] } } },
          { mark: { type: "rule", strokeDash: [2, 2], color: "#999" }, encoding: { x: { datum: lambdas[oneSeIndex] } } },
        ],
      }),
      H.vegaArtifact(`${role}-coefficient-path`, `${label} coefficient path`, {
        data: { values: pathRows },
        layer: [
          { mark: { type: "line" }, encoding: { x: { field: "lambda", type: "quantitative", scale: { type: "log" }, title: "lambda (log scale)" }, y: { field: "standardizedCoefficient", type: "quantitative", title: "Standardized coefficient" }, color: { field: "term", type: "nominal", title: "Term" }, tooltip: [{ field: "term" }, { field: "lambda", format: ".4g" }, { field: "standardizedCoefficient", format: ".4g" }] } },
          { mark: { type: "rule", strokeDash: [4, 4], color: "#555" }, encoding: { x: { datum: lambdas[minIndex] } } },
        ],
      }),
    ],
  };
}

const PENALIZED_DATA_SCHEMA = { type: "object", additionalProperties: false, required: ["y", "predictors"], properties: { y: NUMERIC_SCHEMA(10), predictors: PREDICTORS_SCHEMA, outcomeLabel: LABEL_SCHEMA } };
const PENALIZED_OPTIONS = {
  lambdas: LAMBDAS_OPTION,
  seed: SEED_OPTION,
  folds: FOLDS_OPTION,
  nLambdas: { schema: { type: "integer", minimum: 5, maximum: 200 }, default: 50, parse(value, H, path) { return H.integer(value, 5, 200, path); } },
  lambdaRatio: { schema: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 }, default: 0.001, parse(value, H, path) { const number = H.finiteNumber(value, path); if (!(number > 0 && number < 1)) H.fail("STAT_INVALID_INPUT", `${path} must be in (0, 1)`); return number; } },
};

const lassoRegression = {
  method: "lasso_regression",
  family: "regression",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["timeoutMs"],
  customOptions: PENALIZED_OPTIONS,
  dataSchema: PENALIZED_DATA_SCHEMA,
  parse(data, options, H) {
    H.assertKeys(data, ["y", "predictors", "outcomeLabel"], "data");
    return parseNumericOutcome(data, H, "lasso_regression", 10);
  },
  analyze(parsed, options, budget, H) {
    return penalizedAnalyze(parsed, options, budget, H, { l1Ratio: 1, label: "Lasso", role: "lasso" });
  },
  linkage: {
    neededWhen: "Many candidate predictors are available and the researcher needs a sparse linear model that selects variables while controlling overfitting.",
    decision: "Which predictors survive the L1 penalty, which penalty strength cross-validation supports, and how much predictive error is gained by sparsity.",
    mustShow: "The cross-validation curve with one-standard-error bands, lambda.min and lambda.1se, the coefficient path, the selected coefficients on both scales, and the seed that defined the folds.",
    userGoal: "Select a parsimonious predictor set with a reproducible, cross-validated penalty rather than stepwise significance hunting.",
    nextActions: [
      { trigger: "lambda-min-at-grid-boundary", action: "extend-lambda-grid-or-adjust-lambda-ratio", reason: "A boundary optimum means the grid did not bracket the cross-validated minimum." },
      { trigger: "selected-set-unstable-across-seeds", action: "run-seed-sensitivity-and-report-selection-frequency", reason: "Lasso selection among correlated predictors is fragile; stability should be measured, not assumed." },
      { trigger: "correlated-predictor-groups", action: "compare-elastic-net-path", reason: "The lasso picks one member of a correlated group arbitrarily; an L2 component spreads the selection." },
      { trigger: "sparse-model-accepted", action: "bind-cv-curve-and-selected-coefficients-without-naive-p-values", reason: "Post-selection p-values are invalid, so the report should show the path and error curve instead." },
    ],
  },
  fixture: {
    data: {
      y: [12.1, 14.3, 15.9, 18.2, 20.4, 21.7, 24.1, 26.3, 27.8, 30.2, 31.5, 33.9, 36.1, 37.6, 40.2, 41.8, 44.0, 45.7, 48.1, 49.6],
      predictors: [
        { name: "x1", values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20] },
        { name: "x2", values: [1.2, 1.9, 3.2, 3.9, 5.1, 6.2, 6.8, 8.1, 9.3, 9.8, 11.2, 12.1, 12.8, 14.2, 15.1, 15.9, 17.2, 17.8, 19.1, 20.3] },
        { name: "noise1", values: [0.5, -0.2, 0.8, 1.1, -0.6, 0.3, 1.4, -0.9, 0.2, 0.7, -0.4, 1.0, -0.1, 0.6, -0.8, 0.9, -0.3, 0.4, -0.7, 0.1] },
        { name: "noise2", values: [-0.3, 0.9, -0.5, 0.2, 1.3, -0.7, 0.4, 0.8, -1.1, 0.1, 0.6, -0.2, 1.2, -0.9, 0.3, -0.4, 0.7, -0.6, 0.5, -1.0] },
      ],
      outcomeLabel: "Yield",
    },
    options: { seed: 20240901, folds: 5 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression", "matlab.stats.machine-learning-pipelines"] },
  coverage: {
    implementedBoundary: "Lasso regression by cyclic coordinate descent on standardized predictors with warm starts along a log-spaced penalty grid, seeded k-fold cross-validation, and lambda.min / lambda.1se selection.",
    oracle: {
      level: "external-library-partial",
      evidence: ["contracts/regression-extended-scipy-crosscheck.py"],
      verifiedOutputs: ["standardized coefficients along the grid (sklearn Lasso)", "original-scale coefficients and intercept", "lambda.max", "per-fold cross-validated MSE on identical seeded folds", "lambda.min"],
      excludedOutputs: ["one-standard-error rule selection", "nonzero count"],
    },
    diagnostic: { level: "method-specific-partial", emitted: ["penalty selection boundary", "coordinate descent convergence", "inference boundary"], limitations: ["no post-selection inference", "no stability selection", "no adaptive weights"] },
    knownGaps: ["no post-selection or debiased inference", "no grouped or adaptive lasso variants", "folds ignore clustering and time ordering"],
  },
};

const elasticNetRegression = {
  method: "elastic_net_regression",
  family: "regression",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["timeoutMs"],
  customOptions: {
    ...PENALIZED_OPTIONS,
    l1Ratio: { schema: { type: "number", exclusiveMinimum: 0, maximum: 1 }, default: 0.5, parse(value, H, path) { const number = H.finiteNumber(value, path); if (!(number > 0 && number <= 1)) H.fail("STAT_INVALID_INPUT", `${path} must be in (0, 1]`); return number; } },
  },
  dataSchema: PENALIZED_DATA_SCHEMA,
  parse(data, options, H) {
    H.assertKeys(data, ["y", "predictors", "outcomeLabel"], "data");
    return parseNumericOutcome(data, H, "elastic_net_regression", 10);
  },
  analyze(parsed, options, budget, H) {
    return penalizedAnalyze(parsed, options, budget, H, { l1Ratio: options.l1Ratio, label: "Elastic net", role: "elastic-net" });
  },
  linkage: {
    neededWhen: "Predictors form correlated groups or outnumber observations, and the researcher wants sparse selection that keeps correlated variables together.",
    decision: "Which penalty strength and L1/L2 mixture cross-validation supports and which predictor groups the mixed penalty retains.",
    mustShow: "The cross-validation curve, lambda.min and lambda.1se, the mixing ratio, the coefficient path, and selected coefficients on both scales.",
    userGoal: "Balance sparsity and grouping stability in a regularized linear model with a reproducible tuning record.",
    nextActions: [
      { trigger: "lambda-min-at-grid-boundary", action: "extend-lambda-grid-or-adjust-lambda-ratio", reason: "A boundary optimum means the grid did not bracket the cross-validated minimum." },
      { trigger: "mixing-ratio-untuned", action: "run-l1-ratio-sensitivity-grid", reason: "A single mixing ratio is an analyst choice; the report should show how selection changes across ratios." },
      { trigger: "no-grouping-benefit", action: "prefer-lasso-path-for-simplicity", reason: "If the L2 component does not change the selected set, the simpler penalty is easier to defend." },
      { trigger: "regularized-model-accepted", action: "bind-cv-curve-and-selected-coefficients-without-naive-p-values", reason: "Post-selection p-values are invalid; readers need the tuning evidence instead." },
    ],
  },
  fixture: {
    data: {
      y: [12.1, 14.3, 15.9, 18.2, 20.4, 21.7, 24.1, 26.3, 27.8, 30.2, 31.5, 33.9, 36.1, 37.6, 40.2, 41.8, 44.0, 45.7, 48.1, 49.6],
      predictors: [
        { name: "x1", values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20] },
        { name: "x2", values: [1.2, 1.9, 3.2, 3.9, 5.1, 6.2, 6.8, 8.1, 9.3, 9.8, 11.2, 12.1, 12.8, 14.2, 15.1, 15.9, 17.2, 17.8, 19.1, 20.3] },
        { name: "noise1", values: [0.5, -0.2, 0.8, 1.1, -0.6, 0.3, 1.4, -0.9, 0.2, 0.7, -0.4, 1.0, -0.1, 0.6, -0.8, 0.9, -0.3, 0.4, -0.7, 0.1] },
        { name: "noise2", values: [-0.3, 0.9, -0.5, 0.2, 1.3, -0.7, 0.4, 0.8, -1.1, 0.1, 0.6, -0.2, 1.2, -0.9, 0.3, -0.4, 0.7, -0.6, 0.5, -1.0] },
      ],
      outcomeLabel: "Yield",
    },
    options: { seed: 20240901, folds: 5, l1Ratio: 0.5 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression", "matlab.stats.machine-learning-pipelines"] },
  coverage: {
    implementedBoundary: "Elastic net regression by cyclic coordinate descent on standardized predictors with a user-set L1 ratio, warm starts along a log-spaced penalty grid, seeded k-fold cross-validation, and lambda.min / lambda.1se selection.",
    oracle: {
      level: "external-library-partial",
      evidence: ["contracts/regression-extended-scipy-crosscheck.py"],
      verifiedOutputs: ["standardized coefficients along the grid (sklearn ElasticNet)", "original-scale coefficients and intercept", "lambda.max", "per-fold cross-validated MSE on identical seeded folds", "lambda.min"],
      excludedOutputs: ["one-standard-error rule selection", "nonzero count"],
    },
    diagnostic: { level: "method-specific-partial", emitted: ["penalty selection boundary", "coordinate descent convergence", "inference boundary"], limitations: ["no post-selection inference", "mixing ratio is not tuned automatically", "no adaptive weights"] },
    knownGaps: ["no automatic l1Ratio tuning", "no post-selection or debiased inference", "folds ignore clustering and time ordering"],
  },
};

/* ------------------------------------------------------------------------------------------ */
/* Quantile regression (IRLS with kernel sandwich covariance)                                  */
/* ------------------------------------------------------------------------------------------ */

function normalPdf(value) {
  return Math.exp(-0.5 * value * value) / Math.sqrt(2 * Math.PI);
}

function hallSheatherBandwidth(n, q, H, alpha = 0.05) {
  const z = H.normalInv(q);
  const numerator = 1.5 * normalPdf(z) ** 2;
  const denominator = 2 * z * z + 1;
  return n ** (-1 / 3) * H.normalInv(1 - alpha / 2) ** (2 / 3) * (numerator / denominator) ** (1 / 3);
}

function quantileFit(y, x, q, H, budget, maxIterations) {
  const n = y.length;
  const p = x[0].length;
  let beta = Array(p).fill(1);
  let xstar = x;
  let diff = 10;
  let iterations = 0;
  while (iterations < maxIterations && diff > 1e-6) {
    iterations += 1;
    budget.check(n * p);
    const previous = beta;
    const xtx = Array.from({ length: p }, () => Array(p).fill(0));
    const xty = Array(p).fill(0);
    for (let index = 0; index < n; index += 1) {
      for (let j = 0; j < p; j += 1) {
        xty[j] += xstar[index][j] * y[index];
        for (let l = 0; l < p; l += 1) xtx[j][l] += xstar[index][j] * x[index][l];
      }
    }
    const inverse = K.invertSymmetric(xtx, H, "STAT_SINGULAR_FIT", "quantile regression weighted system is singular");
    beta = K.matVec(inverse, xty);
    const resid = y.map((value, index) => {
      let r = value - K.dot(x[index], beta);
      if (Math.abs(r) < 0.000001) r = (r >= 0 ? 1 : -1) * 0.000001;
      r = r < 0 ? q * r : (1 - q) * r;
      return Math.abs(r);
    });
    xstar = x.map((row, index) => row.map((value) => value / resid[index]));
    diff = Math.max(...beta.map((value, index) => Math.abs(value - previous[index])));
  }
  if (diff > 1e-6) H.fail("STAT_NON_CONVERGENCE", `quantile regression IRLS did not converge in ${maxIterations} iterations`);
  const residuals = y.map((value, index) => value - K.dot(x[index], beta));
  const sortedResiduals = H.sorted(residuals);
  const iqr = H.quantileR7(sortedResiduals, 0.75) - H.quantileR7(sortedResiduals, 0.25);
  const hs = hallSheatherBandwidth(n, q, H);
  const yMean = K.mean(y);
  const yStd = Math.sqrt(y.reduce((total, value) => total + (value - yMean) ** 2, 0) / n);
  const bandwidth = Math.min(yStd, iqr / 1.34) * (H.normalInv(q + hs) - H.normalInv(q - hs));
  if (!(bandwidth > 0)) H.fail("STAT_DEGENERATE", "kernel bandwidth for the quantile sparsity estimate is zero");
  let kernelSum = 0;
  for (const residual of residuals) { const u = residual / bandwidth; if (Math.abs(u) <= 1) kernelSum += 0.75 * (1 - u * u); }
  const density = kernelSum / (n * bandwidth);
  if (!(density > 0)) H.fail("STAT_DEGENERATE", "kernel density of residuals at zero is zero; sandwich covariance is undefined");
  const d = residuals.map((residual) => (residual > 0 ? (q / density) ** 2 : ((1 - q) / density) ** 2));
  const xtxi = K.invertSymmetric(K.crossProduct(x, null, budget), H, "STAT_RANK_DEFICIENT", "design matrix is singular");
  const middle = K.crossProduct(x, d, budget);
  const covariance = H.matMul(H.matMul(xtxi, middle, budget), xtxi, budget);
  const checkLoss = residuals.reduce((total, residual) => total + (residual < 0 ? (q - 1) * residual : q * residual), 0);
  const sampleQuantile = H.quantileR7(H.sorted(y), q);
  const nullLoss = y.reduce((total, value) => { const e = value - sampleQuantile; return total + (e < 0 ? (q - 1) * e : q * e); }, 0);
  return { beta, covariance, residuals, iterations, bandwidth, sparsity: 1 / density, checkLoss, pseudoRSquared: 1 - checkLoss / nullLoss };
}

const quantileRegression = {
  method: "quantile_regression",
  family: "regression",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    quantiles: {
      schema: { type: "array", minItems: 1, maxItems: 9, items: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 } },
      default: [0.5],
      parse(value, H, path) {
        if (!Array.isArray(value) || value.length < 1 || value.length > 9) H.fail("STAT_INVALID_INPUT", `${path} must list 1 to 9 quantiles`);
        const quantiles = value.map((item, index) => { const number = H.finiteNumber(item, `${path}[${index}]`); if (!(number > 0 && number < 1)) H.fail("STAT_INVALID_INPUT", `${path}[${index}] must be strictly between 0 and 1`); return number; });
        const sorted = [...quantiles].sort((a, b) => a - b);
        if (new Set(sorted).size !== sorted.length) H.fail("STAT_INVALID_INPUT", `${path} must not contain duplicates`);
        return sorted;
      },
    },
  },
  dataSchema: { type: "object", additionalProperties: false, required: ["y", "predictors"], properties: { y: NUMERIC_SCHEMA(10), predictors: PREDICTORS_SCHEMA, outcomeLabel: LABEL_SCHEMA } },
  parse(data, options, H) {
    H.assertKeys(data, ["y", "predictors", "outcomeLabel"], "data");
    return parseNumericOutcome(data, H, "quantile_regression", 10);
  },
  analyze(parsed, options, budget, H) {
    const design = K.buildDesign(parsed.y, parsed.predictors, H, true);
    const n = parsed.y.length;
    const p = design.terms.length;
    const names = design.terms.map((term) => term.name);
    const level = options.confidenceLevel;
    const rows = [];
    const fits = [];
    for (const q of options.quantiles) {
      const fit = quantileFit(parsed.y, design.x, q, H, budget, 1000);
      fits.push({ q, ...fit });
      const coefficientRows = K.coefficientRows(names, fit.beta, fit.covariance, n - p, level, H);
      for (const row of coefficientRows) rows.push({ quantile: q, ...row });
    }
    const ols = K.olsFit(parsed.y, design.x, H, budget);
    const olsRows = K.coefficientRows(names, ols.beta, ols.covariance, ols.df, level, H);
    const fitRows = fits.map((fit) => ({ quantile: fit.q, checkLoss: fit.checkLoss, pseudoRSquared: fit.pseudoRSquared, sparsity: fit.sparsity, bandwidth: fit.bandwidth, iterations: fit.iterations }));
    return {
      sample: { n, predictors: parsed.predictors.length, designColumns: p, quantiles: options.quantiles },
      estimates: [
        ...rows.map((row) => ({ ...row, kind: "coefficient" })),
        ...olsRows.map((row) => ({ ...row, kind: "ols-reference" })),
      ],
      tests: rows.map((row) => ({ name: `t test ${row.term} at quantile ${row.quantile}`, statistic: row.statistic, df: row.df, pValue: row.pValue, distribution: "t (kernel sandwich standard error)" })),
      confidenceIntervals: rows.map((row) => ({ parameter: `${row.term} at quantile ${row.quantile}`, level, lower: row.lower, upper: row.upper, method: "t with Hall-Sheather kernel sandwich" })),
      effectSizes: fitRows.map((row) => ({ name: `Koenker-Machado pseudo R1 at quantile ${row.quantile}`, estimate: row.pseudoRSquared })),
      assumptions: [
        { name: "linear conditional quantile", status: "requires_design_review" },
        { name: "independent observations", status: "requires_design_review" },
        { name: "density of errors at the quantile is positive and smooth", status: "asymptotic", detail: "sparsity is estimated by an Epanechnikov kernel with the Hall-Sheather bandwidth" },
      ],
      diagnostics: [
        { name: "optimizer", status: "irls_approximation", detail: "iteratively reweighted least squares (statsmodels-equivalent, p_tol 1e-6) approximates the linear-programming minimizer; the exact simplex vertex is not computed", iterations: fits.map((fit) => fit.iterations) },
        { name: "covariance", status: "heteroskedasticity_robust_kernel_sandwich", bandwidths: fits.map((fit) => fit.bandwidth), sparsity: fits.map((fit) => fit.sparsity) },
        { name: "quantile crossing", status: options.quantiles.length > 1 ? (quantileCrossing(fits, design.x) ? "crossing_detected_in_sample" : "no_crossing_in_sample") : "single_quantile" },
      ],
      artifacts: [
        H.tableArtifact("Quantile regression coefficients", `Conditional quantile coefficients for ${parsed.outcomeLabel} with ${percent(level)} t intervals from the kernel sandwich covariance.`, [NUMBER_COLUMN("quantile", "Quantile"), ...K.coefficientColumns("t")], rows, ["Standard errors use the heteroskedasticity-robust kernel estimator (Koenker 2005, section 3.4.2)."], "quantile-coefficients-table"),
        H.tableArtifact("OLS reference coefficients", "Conditional-mean coefficients for comparison with the quantile estimates.", K.coefficientColumns("t"), olsRows, [], "quantile-ols-reference-table"),
        H.tableArtifact("Quantile fit summary", "Check-loss, pseudo R1, sparsity, and bandwidth per quantile.", [NUMBER_COLUMN("quantile", "Quantile"), NUMBER_COLUMN("checkLoss", "Check loss"), NUMBER_COLUMN("pseudoRSquared", "Pseudo R1"), NUMBER_COLUMN("sparsity", "Sparsity"), NUMBER_COLUMN("bandwidth", "Bandwidth"), NUMBER_COLUMN("iterations", "IRLS iterations")], fitRows, [], "quantile-fit-table"),
        H.vegaArtifact("quantile-coefficient-process", `Coefficients across quantiles with ${percent(level)} intervals`, {
          data: { values: rows },
          facet: { field: "term", type: "nominal", columns: 3, title: null },
          spec: {
            layer: [
              { mark: { type: "area", opacity: 0.25 }, encoding: { x: { field: "quantile", type: "quantitative", title: "Quantile" }, y: { field: "lower", type: "quantitative", title: "Coefficient" }, y2: { field: "upper" } } },
              { mark: { type: "line", point: true }, encoding: { x: { field: "quantile", type: "quantitative" }, y: { field: "estimate", type: "quantitative" }, tooltip: [{ field: "term" }, { field: "quantile" }, { field: "estimate", format: ".4g" }, { field: "lower", format: ".4g" }, { field: "upper", format: ".4g" }] } },
              { mark: { type: "rule", strokeDash: [4, 4], color: "#777" }, encoding: { y: { datum: 0 } } },
            ],
          },
          resolve: { scale: { y: "independent" } },
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "The research question concerns the tails or the whole conditional distribution of the outcome, or the errors are heteroskedastic and heavy-tailed so the conditional mean is not the estimand of interest.",
    decision: "Whether predictor effects differ across quantiles of the outcome and which quantile-specific effects are supported by the data.",
    mustShow: "Coefficients per quantile with kernel-sandwich intervals, the OLS reference, pseudo R1 per quantile, and the coefficient process across quantiles.",
    userGoal: "Describe how covariates shift different parts of the outcome distribution instead of only its mean.",
    nextActions: [
      { trigger: "effects-vary-across-quantiles", action: "report-coefficient-process-and-test-equality-of-slopes", reason: "Heterogeneous quantile effects are the scientific finding and should not be collapsed to a mean effect." },
      { trigger: "quantile-crossing-detected", action: "review-model-specification-or-restrict-quantile-range", reason: "Crossing conditional quantiles are logically inconsistent and signal misspecification or sparse tails." },
      { trigger: "extreme-quantile-with-small-sample", action: "widen-intervals-with-bootstrap-plan", reason: "Kernel sandwich standard errors are unreliable in sparse tails; a declared resampling plan is safer." },
      { trigger: "interpretable-quantile-effects", action: "bind-coefficient-table-and-quantile-process-figure", reason: "Readers need both the numeric effects and their trajectory across the distribution." },
    ],
  },
  fixture: {
    data: {
      y: [3.1, 4.5, 5.2, 6.8, 7.1, 9.4, 8.2, 10.9, 12.3, 11.8, 14.6, 13.9, 16.2, 17.8, 16.9, 19.5, 21.7, 20.4, 23.6, 24.9, 26.1, 25.3, 28.7, 30.2],
      predictors: [
        { name: "x", values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24] },
        { name: "w", values: [0.3, 1.1, 0.7, 1.9, 0.2, 1.4, 0.9, 2.2, 0.5, 1.7, 1.2, 2.5, 0.8, 1.5, 2.8, 0.4, 1.8, 2.1, 0.6, 2.4, 1.3, 2.9, 1.0, 2.6] },
      ],
      outcomeLabel: "Score",
    },
    options: { quantiles: [0.25, 0.5, 0.75], confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "Linear quantile regression at one or more quantiles by iteratively reweighted least squares with the heteroskedasticity-robust kernel sandwich covariance (Epanechnikov kernel, Hall-Sheather bandwidth), t intervals, pseudo R1, and an in-sample crossing check.",
    oracle: {
      level: "external-library-partial",
      evidence: ["contracts/regression-extended-scipy-crosscheck.py"],
      verifiedOutputs: ["coefficients per quantile (statsmodels QuantReg)", "kernel sandwich standard errors", "bandwidth", "sparsity", "pseudo R1"],
      excludedOutputs: ["quantile crossing flag", "OLS reference rows"],
    },
    diagnostic: { level: "method-specific-partial", emitted: ["optimizer boundary", "covariance boundary", "quantile crossing"], limitations: ["IRLS approximates the exact linear-programming solution", "no bootstrap or rank-inversion intervals", "no slope-equality test across quantiles"] },
    knownGaps: ["exact simplex (Barrodale-Roberts) solution is not computed", "no test of equal slopes across quantiles", "no bootstrap intervals"],
  },
};

function quantileCrossing(fits, x) {
  for (let index = 0; index < x.length; index += 1) {
    let previous = -Infinity;
    for (const fit of fits) {
      const fitted = K.dot(x[index], fit.beta);
      if (fitted < previous) return true;
      previous = fitted;
    }
  }
  return false;
}

/* ------------------------------------------------------------------------------------------ */
/* Robust linear regression (Huber / Tukey biweight M-estimation)                              */
/* ------------------------------------------------------------------------------------------ */

const GAUSSIAN_3_4 = 0.6744897501960817;
const NORMS = {
  huber: {
    label: "Huber",
    defaultTuning: 1.345,
    weight: (z, t) => (Math.abs(z) <= t ? 1 : t / Math.abs(z)),
    psi: (z, t) => (Math.abs(z) <= t ? z : t * Math.sign(z)),
    psiDerivative: (z, t) => (Math.abs(z) <= t ? 1 : 0),
    rho: (z, t) => (Math.abs(z) <= t ? 0.5 * z * z : Math.abs(z) * t - 0.5 * t * t),
  },
  biweight: {
    label: "Tukey biweight",
    defaultTuning: 4.685,
    weight: (z, c) => (Math.abs(z) <= c ? (1 - (z / c) ** 2) ** 2 : 0),
    psi: (z, c) => (Math.abs(z) <= c ? z * (1 - (z / c) ** 2) ** 2 : 0),
    psiDerivative: (z, c) => (Math.abs(z) <= c ? (1 - (z / c) ** 2) ** 2 - (4 * z * z / (c * c)) * (1 - (z / c) ** 2) : 0),
    rho: (z, c) => (Math.abs(z) <= c ? (c * c / 6) * (1 - (1 - (z / c) ** 2) ** 3) : c * c / 6),
  },
};

function madScale(residuals) {
  return K.median(residuals.map((value) => Math.abs(value))) / GAUSSIAN_3_4;
}

function robustFit(y, x, norm, tuning, H, budget, { maxIterations = 500, tolerance = 1e-10 } = {}) {
  const n = y.length;
  const p = x[0].length;
  const ols = K.weightedLeastSquares(y, x, null, H, budget, "STAT_RANK_DEFICIENT", "design matrix is rank deficient");
  let beta = ols.beta;
  let residuals = ols.residuals;
  let scale = madScale(residuals);
  if (!(scale > 0)) H.fail("STAT_DEGENERATE", "median absolute deviation of the initial residuals is zero");
  let iterations = 0;
  let converged = false;
  let weights = null;
  for (iterations = 1; iterations <= maxIterations; iterations += 1) {
    budget.check(n * p);
    weights = residuals.map((value) => norm.weight(value / scale, tuning));
    if (weights.every((value) => value === 0)) H.fail("STAT_DEGENERATE", "all observations received zero weight");
    const fit = K.weightedLeastSquares(y, x, weights, H, budget, "STAT_SINGULAR_FIT", "weighted design matrix is singular after downweighting");
    const delta = Math.max(...fit.beta.map((value, index) => Math.abs(value - beta[index])));
    beta = fit.beta;
    residuals = fit.residuals;
    scale = madScale(residuals);
    if (!(scale > 0)) H.fail("STAT_DEGENERATE", "median absolute deviation of the residuals collapsed to zero (perfect fit of the weighted data)");
    if (delta < tolerance) { converged = true; break; }
  }
  if (!converged) H.fail("STAT_NON_CONVERGENCE", `robust IRLS did not converge in ${maxIterations} iterations`);
  weights = residuals.map((value) => norm.weight(value / scale, tuning));
  const standardized = residuals.map((value) => value / scale);
  const psi = standardized.map((value) => norm.psi(value, tuning));
  const psiDerivative = standardized.map((value) => norm.psiDerivative(value, tuning));
  const meanDerivative = K.mean(psiDerivative);
  const varianceDerivative = psiDerivative.reduce((total, value) => total + (value - meanDerivative) ** 2, 0) / n;
  const kFactor = 1 + (p / n) * varianceDerivative / (meanDerivative ** 2);
  const sumPsiSquared = psi.reduce((total, value) => total + value * value, 0);
  const sumDerivative = psiDerivative.reduce((total, value) => total + value, 0);
  const xtxi = K.invertSymmetric(K.crossProduct(x, null, budget), H, "STAT_RANK_DEFICIENT", "design matrix is singular");
  const factor = kFactor ** 2 * ((1 / (n - p)) * sumPsiSquared * scale * scale) / ((sumDerivative / n) ** 2);
  const covariance = xtxi.map((row) => row.map((value) => value * factor));
  return { beta, residuals, scale, weights, standardized, iterations, covariance, ols, kFactor, objective: standardized.reduce((total, value) => total + norm.rho(value, tuning), 0) };
}

const robustLinearRegression = {
  method: "robust_linear_regression",
  family: "regression",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    norm: { schema: { type: "string", enum: ["huber", "biweight"] }, default: "huber", parse(value, H, path) { if (!Object.hasOwn(NORMS, value)) H.fail("STAT_INVALID_INPUT", `${path} must be huber or biweight`); return value; } },
    tuningConstant: { schema: { type: "number", exclusiveMinimum: 0 }, default: null, parse(value, H, path) { const number = H.finiteNumber(value, path); if (!(number > 0)) H.fail("STAT_INVALID_INPUT", `${path} must be positive`); return number; } },
  },
  dataSchema: { type: "object", additionalProperties: false, required: ["y", "predictors"], properties: { y: NUMERIC_SCHEMA(8), predictors: PREDICTORS_SCHEMA, outcomeLabel: LABEL_SCHEMA } },
  parse(data, options, H) {
    H.assertKeys(data, ["y", "predictors", "outcomeLabel"], "data");
    return parseNumericOutcome(data, H, "robust_linear_regression", 8);
  },
  analyze(parsed, options, budget, H) {
    const design = K.buildDesign(parsed.y, parsed.predictors, H, true);
    const n = parsed.y.length;
    const p = design.terms.length;
    const names = design.terms.map((term) => term.name);
    const norm = NORMS[options.norm];
    const tuning = options.tuningConstant === null ? norm.defaultTuning : options.tuningConstant;
    const fit = robustFit(parsed.y, design.x, norm, tuning, H, budget);
    const level = options.confidenceLevel;
    const coefficientRows = K.coefficientRows(names, fit.beta, fit.covariance, null, level, H);
    const ols = K.olsFit(parsed.y, design.x, H, budget);
    const olsRows = K.coefficientRows(names, ols.beta, ols.covariance, ols.df, level, H);
    const comparisonRows = [
      ...coefficientRows.map((row) => ({ estimator: `${norm.label} M-estimator`, term: row.term, estimate: row.estimate, standardError: row.standardError, lower: row.lower, upper: row.upper })),
      ...olsRows.map((row) => ({ estimator: "OLS", term: row.term, estimate: row.estimate, standardError: row.standardError, lower: row.lower, upper: row.upper })),
    ];
    const weightRows = parsed.y.map((value, index) => ({ observation: index + 1, observed: value, fitted: value - fit.residuals[index], residual: fit.residuals[index], standardizedResidual: fit.standardized[index], weight: fit.weights[index], downweighted: fit.weights[index] < 0.999999 }));
    const downweighted = weightRows.filter((row) => row.downweighted).length;
    const zeroWeight = weightRows.filter((row) => row.weight === 0).length;
    return {
      sample: { n, predictors: parsed.predictors.length, designColumns: p, downweightedObservations: downweighted, zeroWeightObservations: zeroWeight },
      estimates: [
        ...coefficientRows.map((row) => ({ ...row, kind: "coefficient" })),
        { term: "robust scale (MAD/0.6745)", estimate: fit.scale, kind: "scale" },
        { term: "tuning constant", estimate: tuning, kind: "scale" },
        { term: "M-objective at solution", estimate: fit.objective, kind: "fit" },
      ],
      tests: coefficientRows.map((row) => ({ name: `z test ${row.term}`, statistic: row.statistic, df: null, pValue: row.pValue, distribution: "normal (Huber H1 covariance)" })),
      confidenceIntervals: coefficientRows.map((row) => ({ parameter: row.term, level, lower: row.lower, upper: row.upper, method: "normal with Huber H1 covariance" })),
      effectSizes: [
        { name: "proportion of observations downweighted", estimate: downweighted / n },
        { name: "maximum absolute standardized residual", estimate: Math.max(...fit.standardized.map(Math.abs)) },
      ],
      assumptions: [
        { name: "linear mean structure", status: "requires_design_review" },
        { name: "symmetric error distribution around the regression line", status: "not_established", detail: "M-estimators protect against outlying responses, not against asymmetric errors or leverage points in the predictors" },
        { name: "no high-leverage predictor outliers", status: "not_established", detail: "M-estimation does not bound the influence of leverage points; consider MM-estimation for that case" },
      ],
      diagnostics: [
        convergenceDiagnostic(fit.iterations, 500, 1e-10, { algorithm: `IRLS with ${norm.label} weights, MAD scale re-estimated each iteration (statsmodels RLM-equivalent)` }),
        { name: "covariance", status: "huber_h1", kFactor: fit.kFactor, detail: "H1: k^2 * (sum psi^2 / (n - p)) * scale^2 / (mean psi')^2 * (X'X)^-1" },
        { name: "downweighting", downweighted, zeroWeight, status: zeroWeight > 0 ? "observations_rejected_by_redescending_norm" : downweighted > 0 ? "observations_downweighted" : "no_downweighting" },
        { name: "OLS comparison", status: "reported", maxAbsoluteCoefficientChange: Math.max(...fit.beta.map((value, index) => Math.abs(value - ols.beta[index]))) },
      ],
      artifacts: [
        H.tableArtifact(`${norm.label} robust regression coefficients`, `M-estimates for ${parsed.outcomeLabel} with ${percent(level)} normal intervals from the Huber H1 covariance.`, K.coefficientColumns("z"), coefficientRows, [`Tuning constant ${tuning}; scale is MAD/0.6745 of the residuals about zero.`], "robust-coefficients-table"),
        H.tableArtifact("Robust versus OLS coefficients", "Side-by-side estimates showing how much outlying observations move the ordinary least squares fit.", [STRING_COLUMN("estimator", "Estimator"), STRING_COLUMN("term", "Term"), NUMBER_COLUMN("estimate", "Estimate"), NUMBER_COLUMN("standardError", "SE"), NUMBER_COLUMN("lower", "CI lower"), NUMBER_COLUMN("upper", "CI upper")], comparisonRows, [], "robust-comparison-table"),
        H.tableArtifact("Observation weights", "Final IRLS weight for every observation; weights below one identify downweighted responses.", [NUMBER_COLUMN("observation", "Observation"), NUMBER_COLUMN("observed", "Observed"), NUMBER_COLUMN("fitted", "Fitted"), NUMBER_COLUMN("residual", "Residual"), NUMBER_COLUMN("standardizedResidual", "Residual / scale"), NUMBER_COLUMN("weight", "Weight"), BOOLEAN_COLUMN("downweighted", "Downweighted")], weightRows, [], "robust-weights-table"),
        H.vegaArtifact("robust-weight-plot", `${norm.label} weights against standardized residuals`, {
          data: { values: weightRows },
          layer: [
            { mark: { type: "point", filled: true, size: 70 }, encoding: { x: { field: "standardizedResidual", type: "quantitative", title: "Residual / robust scale" }, y: { field: "weight", type: "quantitative", title: "IRLS weight", scale: { domain: [0, 1.05] } }, color: { field: "downweighted", type: "nominal", title: "Downweighted" }, tooltip: [{ field: "observation" }, { field: "observed", format: ".4g" }, { field: "residual", format: ".4g" }, { field: "weight", format: ".3f" }] } },
            { mark: { type: "rule", strokeDash: [4, 4], color: "#777" }, encoding: { x: { datum: tuning } } },
            { mark: { type: "rule", strokeDash: [4, 4], color: "#777" }, encoding: { x: { datum: -tuning } } },
          ],
        }),
        K.forestPlot(H, "robust-vs-ols-forest", `Robust and OLS coefficients with ${percent(level)} intervals`, comparisonRows, { xTitle: "Estimate", colorField: "estimator" }),
      ],
    };
  },
  linkage: {
    neededWhen: "Residual diagnostics or subject knowledge indicate outlying responses that would dominate ordinary least squares, and the researcher wants a fit resistant to them.",
    decision: "Whether outliers materially change the coefficients, which observations are downweighted, and whether the robust fit should replace or accompany the OLS fit.",
    mustShow: "Robust coefficients with intervals, the OLS comparison, the robust scale, the weight of every observation, and the identity of downweighted or rejected observations.",
    userGoal: "Report a regression that is honest about influential responses without silently deleting data.",
    nextActions: [
      { trigger: "observations-rejected-or-heavily-downweighted", action: "open-source-rows-and-document-provenance-before-exclusion", reason: "A zero weight is a data-quality claim about that row and must be reviewed, not hidden in an algorithm." },
      { trigger: "robust-and-ols-disagree", action: "report-both-fits-with-sensitivity-statement", reason: "Disagreement means the conclusion depends on how outliers are handled, which readers must see." },
      { trigger: "leverage-points-suspected", action: "plan-mm-estimation-or-influence-analysis", reason: "M-estimation bounds residual influence only; leverage in the predictors needs a high-breakdown estimator." },
      { trigger: "robust-fit-accepted", action: "bind-coefficient-table-weight-plot-and-comparison", reason: "The weight plot documents exactly which observations shaped the estimate." },
    ],
  },
  fixture: {
    data: {
      y: [2.1, 3.9, 6.2, 7.8, 10.1, 12.3, 13.8, 16.2, 30.5, 19.9, 22.1, 24.3, 25.8, 28.2, 29.9, 32.1],
      predictors: [{ name: "x", values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] }],
      outcomeLabel: "Response",
    },
    options: { norm: "huber", confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "Huber and Tukey-biweight M-estimation by iteratively reweighted least squares with MAD scale updated each iteration and the Huber H1 asymptotic covariance, plus OLS comparison and per-observation weights.",
    oracle: {
      level: "external-library-partial",
      evidence: ["contracts/regression-extended-scipy-crosscheck.py"],
      verifiedOutputs: ["coefficients (statsmodels RLM)", "H1 standard errors", "robust scale", "observation weights"],
      excludedOutputs: ["M-objective value", "downweighting counts", "OLS comparison rows"],
    },
    diagnostic: { level: "method-specific-partial", emitted: ["convergence", "covariance", "downweighting", "OLS comparison"], limitations: ["no leverage-based influence measures", "no MM or S estimation", "no H2/H3 covariance options"] },
    knownGaps: ["high-breakdown MM and S estimators are not implemented", "no bounded-influence (GM) weighting for leverage points", "Huber proposal-2 scale is not offered"],
  },
};

/* ------------------------------------------------------------------------------------------ */
/* Polynomial regression with orthogonal polynomials and nested F tests                        */
/* ------------------------------------------------------------------------------------------ */

function binomial(n, k) {
  let value = 1;
  for (let index = 1; index <= k; index += 1) value = value * (n - k + index) / index;
  return value;
}

/** Orthonormal polynomial basis (Gram-Schmidt on the scaled powers) plus the transform to raw x powers. */
function orthogonalPolynomials(x, degree, H, budget) {
  const n = x.length;
  const center = K.mean(x);
  const spread = Math.sqrt(K.sampleVariance(x));
  if (!(spread > 0)) H.fail("STAT_DEGENERATE", "data.x is constant");
  const scaled = x.map((value) => (value - center) / spread);
  // Scaled powers and their expansion in raw x powers: ((x - c)/s)^k = sum_i C(k,i) (-c/s)^(k-i) (1/s)^i x^i.
  const powers = Array.from({ length: degree + 1 }, (_, k) => scaled.map((value) => value ** k));
  const expansion = Array.from({ length: degree + 1 }, (_, k) => Array.from({ length: degree + 1 }, (_, i) => (i > k ? 0 : binomial(k, i) * (-center / spread) ** (k - i) * (1 / spread) ** i)));
  const basis = [];
  const transform = [];
  for (let k = 0; k <= degree; k += 1) {
    budget.check(n * degree);
    let vector = [...powers[k]];
    let coefficients = [...expansion[k]];
    for (let j = 0; j < k; j += 1) {
      const projection = K.dot(vector, basis[j]);
      for (let index = 0; index < n; index += 1) vector[index] -= projection * basis[j][index];
      for (let i = 0; i <= degree; i += 1) coefficients[i] -= projection * transform[j][i];
    }
    const norm = Math.sqrt(K.dot(vector, vector));
    if (!(norm > 1e-10 * Math.sqrt(n))) H.fail("STAT_RANK_DEFICIENT", `polynomial degree ${degree} is not identifiable from ${new Set(x).size} distinct x values`);
    vector = vector.map((value) => value / norm);
    coefficients = coefficients.map((value) => value / norm);
    basis.push(vector);
    transform.push(coefficients);
  }
  return { basis, transform, center, spread };
}

const polynomialRegression = {
  method: "polynomial_regression",
  family: "regression",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    degree: { schema: { type: "integer", minimum: 1, maximum: 6 }, default: 2, parse(value, H, path) { return H.integer(value, 1, 6, path); } },
  },
  dataSchema: { type: "object", additionalProperties: false, required: ["x", "y"], properties: { x: NUMERIC_SCHEMA(8), y: NUMERIC_SCHEMA(8), xLabel: LABEL_SCHEMA, yLabel: LABEL_SCHEMA } },
  parse(data, options, H) {
    H.assertKeys(data, ["x", "y", "xLabel", "yLabel"], "data");
    const x = H.numericVector(data.x, "data.x", 8);
    const y = H.numericVector(data.y, "data.y", 8);
    if (x.length !== y.length) H.fail("STAT_INVALID_INPUT", "data.x and data.y must have the same length");
    limitRows(x.length, H, "polynomial_regression");
    if (new Set(x).size <= options.degree) H.fail("STAT_DEGENERATE", `degree ${options.degree} requires more than ${options.degree} distinct x values`);
    if (x.length <= options.degree + 2) H.fail("STAT_INSUFFICIENT_SAMPLE", `degree ${options.degree} requires at least ${options.degree + 3} observations`);
    return { x, y, xLabel: H.label(data.xLabel, "x", "data.xLabel"), yLabel: H.label(data.yLabel, "y", "data.yLabel") };
  },
  analyze(parsed, options, budget, H) {
    const { x, y } = parsed;
    const n = x.length;
    const degree = options.degree;
    const level = options.confidenceLevel;
    const poly = orthogonalPolynomials(x, degree, H, budget);
    const projections = poly.basis.map((vector) => K.dot(vector, y));
    const yy = K.dot(y, y);
    const yMean = K.mean(y);
    const tss = y.reduce((total, value) => total + (value - yMean) ** 2, 0);
    // Nested residual sums of squares for degrees 0..degree.
    const rss = [];
    let remaining = yy;
    for (let k = 0; k <= degree; k += 1) { remaining -= projections[k] ** 2; rss.push(Math.max(0, remaining)); }
    const nestedRows = [];
    for (let k = 1; k <= degree; k += 1) {
      const dfResidual = n - k - 1;
      const f = (rss[k - 1] - rss[k]) / (rss[k] / dfResidual);
      nestedRows.push({ degree: k, residualDf: dfResidual, rss: rss[k], sequentialSumOfSquares: rss[k - 1] - rss[k], fStatistic: f, pValue: H.pFromF(f, 1, dfResidual), rSquared: tss > 0 ? 1 - rss[k] / tss : 0, aic: informationCriteria(K.gaussianLogLikelihood(rss[k], n), k + 1, n).aic, bic: informationCriteria(K.gaussianLogLikelihood(rss[k], n), k + 1, n).bic });
    }
    const dfResidual = n - degree - 1;
    const sigma2 = rss[degree] / dfResidual;
    // Raw coefficients: beta_raw = T' gamma where gamma are orthonormal-basis coefficients (projections).
    const raw = Array(degree + 1).fill(0);
    for (let k = 0; k <= degree; k += 1) for (let i = 0; i <= degree; i += 1) raw[i] += poly.transform[k][i] * projections[k];
    const rawCovariance = Array.from({ length: degree + 1 }, (_, i) => Array.from({ length: degree + 1 }, (_, j) => {
      let total = 0;
      for (let k = 0; k <= degree; k += 1) total += poly.transform[k][i] * poly.transform[k][j];
      return total * sigma2;
    }));
    const rawNames = Array.from({ length: degree + 1 }, (_, i) => (i === 0 ? "Intercept" : i === 1 ? parsed.xLabel : `${parsed.xLabel}^${i}`));
    const rawRows = K.coefficientRows(rawNames, raw, rawCovariance, dfResidual, level, H);
    const orthogonalRows = projections.map((estimate, k) => ({ term: k === 0 ? "orthogonal degree 0 (intercept)" : `orthogonal degree ${k}`, estimate, standardError: Math.sqrt(sigma2), statistic: estimate / Math.sqrt(sigma2), df: dfResidual, pValue: H.pFromT(estimate / Math.sqrt(sigma2), dfResidual, "two-sided"), lower: estimate - H.tCritical(level, dfResidual) * Math.sqrt(sigma2), upper: estimate + H.tCritical(level, dfResidual) * Math.sqrt(sigma2) }));
    const fitted = x.map((_, index) => poly.basis.reduce((total, vector, k) => total + vector[index] * projections[k], 0));
    const observationRows = x.map((value, index) => ({ x: value, y: y[index], fitted: fitted[index], residual: y[index] - fitted[index] }));
    const { min, max } = H.minMax(x);
    const critical = H.tCritical(level, dfResidual);
    const curveRows = H.inclusiveGrid ? [] : [];
    const gridCount = 101;
    for (let g = 0; g < gridCount; g += 1) {
      const xg = min + (max - min) * g / (gridCount - 1);
      const rawPowers = Array.from({ length: degree + 1 }, (_, i) => xg ** i);
      const prediction = K.dot(rawPowers, raw);
      const variance = H.quadraticForm(rawPowers, rawCovariance);
      const se = Math.sqrt(Math.max(0, variance));
      curveRows.push({ x: xg, fitted: prediction, lower: prediction - critical * se, upper: prediction + critical * se, predictionLower: prediction - critical * Math.sqrt(variance + sigma2), predictionUpper: prediction + critical * Math.sqrt(variance + sigma2) });
    }
    const fullF = degree > 0 ? ((tss - rss[degree]) / degree) / sigma2 : 0;
    const adjustedR2 = 1 - (rss[degree] / dfResidual) / (tss / (n - 1));
    const highestTerm = nestedRows[nestedRows.length - 1];
    const residualJb = H.jarqueBera(observationRows.map((row) => row.residual), budget);
    return {
      sample: { n, degree, distinctX: new Set(x).size, residualDf: dfResidual },
      estimates: [
        ...rawRows.map((row) => ({ ...row, kind: "raw-coefficient" })),
        ...orthogonalRows.map((row) => ({ ...row, kind: "orthogonal-coefficient" })),
        { term: "residual standard error", estimate: Math.sqrt(sigma2), kind: "fit" },
        { term: "R-squared", estimate: tss > 0 ? 1 - rss[degree] / tss : 0, kind: "fit" },
        { term: "adjusted R-squared", estimate: adjustedR2, kind: "fit" },
      ],
      tests: [
        { name: `overall F test for degree ${degree} polynomial`, statistic: fullF, df1: degree, df2: dfResidual, pValue: H.pFromF(fullF, degree, dfResidual), distribution: "F" },
        ...nestedRows.map((row) => ({ name: `nested F test: degree ${row.degree} versus degree ${row.degree - 1}`, statistic: row.fStatistic, df1: 1, df2: row.residualDf, pValue: row.pValue, distribution: "F" })),
      ],
      confidenceIntervals: rawRows.map((row) => ({ parameter: row.term, level, lower: row.lower, upper: row.upper, method: "t" })),
      effectSizes: [
        { name: "R-squared", estimate: tss > 0 ? 1 - rss[degree] / tss : 0 },
        { name: "adjusted R-squared", estimate: adjustedR2 },
        { name: `partial R-squared gained by degree ${degree}`, estimate: rss[degree - 1] > 0 ? (rss[degree - 1] - rss[degree]) / rss[degree - 1] : 0 },
      ],
      assumptions: [
        { name: "polynomial mean structure of the chosen degree", status: highestTerm.pValue < 0.05 ? "highest_degree_supported_by_nested_f" : "highest_degree_not_supported_by_nested_f" },
        { name: "homoscedastic normal errors", status: residualJb.pValue < 0.05 ? "residual_normality_rejected_by_jarque_bera" : "residual_normality_not_rejected", statistic: residualJb.statistic, pValue: residualJb.pValue },
        { name: "independent observations", status: "requires_design_review" },
        { name: "no extrapolation beyond the observed x range", status: "requires_domain_review", detail: `fitted curve is reported only on [${min}, ${max}]` },
      ],
      diagnostics: [
        { name: "orthogonal basis", status: "gram_schmidt_on_scaled_powers", center: poly.center, spread: poly.spread, detail: "sequential sums of squares are exact because the basis is orthonormal" },
        { name: "nested model selection", status: "reported", suggestedDegree: nestedRows.reduce((best, row) => (row.aic < best.aic ? row : best), nestedRows[0]).degree, rule: "lowest AIC among degrees 1..degree" },
        { name: "conditioning", status: degree >= 5 ? "raw_power_coefficients_may_be_ill_conditioned" : "acceptable", detail: "raw-scale coefficients are obtained by transforming the orthonormal fit, not by inverting the raw Vandermonde matrix" },
      ],
      artifacts: [
        H.tableArtifact(`Polynomial regression coefficients (degree ${degree})`, `Raw-scale coefficients of ${parsed.yLabel} on powers of ${parsed.xLabel} with ${percent(level)} t intervals.`, K.coefficientColumns("t"), rawRows, ["Raw coefficients are highly correlated; use the nested F table to judge each degree."], "polynomial-coefficients-table"),
        H.tableArtifact("Nested degree comparison", "Sequential (type I) F tests comparing each degree with the next-lower degree, with fit statistics per degree.", [NUMBER_COLUMN("degree", "Degree"), NUMBER_COLUMN("residualDf", "Residual df"), NUMBER_COLUMN("rss", "RSS"), NUMBER_COLUMN("sequentialSumOfSquares", "Sequential SS"), NUMBER_COLUMN("fStatistic", "F"), NUMBER_COLUMN("pValue", "p"), NUMBER_COLUMN("rSquared", "R-squared"), NUMBER_COLUMN("aic", "AIC"), NUMBER_COLUMN("bic", "BIC")], nestedRows, ["Each F compares degree k with degree k-1 using the residual mean square of degree k."], "polynomial-nested-table"),
        H.tableArtifact("Orthogonal polynomial coefficients", "Coefficients on the orthonormal basis; each has the same standard error and is independent of the others.", K.coefficientColumns("t"), orthogonalRows, [], "polynomial-orthogonal-table"),
        H.tableArtifact("Observations and fitted values", "Observed data with fitted values and residuals from the highest-degree model.", [NUMBER_COLUMN("x", parsed.xLabel), NUMBER_COLUMN("y", parsed.yLabel), NUMBER_COLUMN("fitted", "Fitted"), NUMBER_COLUMN("residual", "Residual")], observationRows, [], "polynomial-observations-table"),
        H.tableArtifact("Fitted curve", `Fitted polynomial on a 101-point grid with ${percent(level)} confidence and prediction bands.`, [NUMBER_COLUMN("x", parsed.xLabel), NUMBER_COLUMN("fitted", "Fitted"), NUMBER_COLUMN("lower", "CI lower"), NUMBER_COLUMN("upper", "CI upper"), NUMBER_COLUMN("predictionLower", "PI lower"), NUMBER_COLUMN("predictionUpper", "PI upper")], curveRows, [], "polynomial-curve-table"),
        H.vegaArtifact("polynomial-fit-plot", `Degree ${degree} polynomial fit with ${percent(level)} confidence band`, {
          layer: [
            { data: { values: curveRows }, mark: { type: "area", opacity: 0.2, color: "#2c7fb8" }, encoding: { x: { field: "x", type: "quantitative", title: parsed.xLabel }, y: { field: "lower", type: "quantitative", title: parsed.yLabel }, y2: { field: "upper" } } },
            { data: { values: curveRows }, mark: { type: "line", color: "#2c7fb8", strokeWidth: 2 }, encoding: { x: { field: "x", type: "quantitative" }, y: { field: "fitted", type: "quantitative" } } },
            { data: { values: observationRows }, mark: { type: "point", filled: true, color: "#222", opacity: 0.8 }, encoding: { x: { field: "x", type: "quantitative" }, y: { field: "y", type: "quantitative" }, tooltip: [{ field: "x", format: ".4g" }, { field: "y", format: ".4g" }, { field: "fitted", format: ".4g" }, { field: "residual", format: ".4g" }] } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "A single continuous predictor shows curvature and the researcher must decide how much polynomial flexibility the data support before interpreting the shape.",
    decision: "Which polynomial degree is warranted, whether the highest-degree term adds explanatory power, and what the fitted curve and its uncertainty look like across the observed range.",
    mustShow: "Nested F tests per degree with AIC and BIC, raw and orthogonal coefficients, the fitted curve with confidence bands over the observed range only, and residual diagnostics.",
    userGoal: "Model a curved relationship with a defensible, explicitly tested degree rather than an arbitrary polynomial.",
    nextActions: [
      { trigger: "highest-degree-not-supported", action: "refit-with-lower-degree-and-freeze-choice", reason: "An unsupported high-order term adds variance and spurious wiggles without explanatory gain." },
      { trigger: "residual-pattern-or-nonnormality", action: "compare-spline-or-transformation-model", reason: "Global polynomials fit poorly at the edges; a local basis or a transformed scale may describe the curve better." },
      { trigger: "extrapolation-requested", action: "refuse-prediction-outside-observed-range", reason: "Polynomial predictions diverge rapidly beyond the data and carry no empirical support there." },
      { trigger: "curve-accepted", action: "bind-fit-plot-and-nested-f-table", reason: "Readers need the curve with its band and the evidence for the chosen degree." },
    ],
  },
  fixture: {
    data: {
      x: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
      y: [2.3, 3.9, 6.2, 9.1, 12.4, 16.5, 20.9, 26.1, 31.2, 37.4, 43.9, 51.2, 58.8, 67.1, 75.6, 85.2],
      xLabel: "Dose",
      yLabel: "Response",
    },
    options: { degree: 3, confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "Single-predictor polynomial regression up to degree 6 on an orthonormal Gram-Schmidt basis with exact sequential F tests, raw-scale coefficients and covariance by basis transformation, fitted curve with confidence and prediction bands, and per-degree AIC/BIC.",
    oracle: {
      level: "external-library-partial",
      evidence: ["contracts/regression-extended-scipy-crosscheck.py"],
      verifiedOutputs: ["raw coefficients (numpy polyfit)", "raw coefficient standard errors (statsmodels OLS)", "residual sum of squares per degree", "nested F statistics and p values (statsmodels compare_f_test)", "R-squared", "AIC and BIC per degree"],
      excludedOutputs: ["prediction bands", "Jarque-Bera residual screen", "suggested degree"],
    },
    diagnostic: { level: "method-specific-partial", emitted: ["nested model selection", "residual normality screen", "conditioning", "orthogonal basis"], limitations: ["single predictor only", "no cross-validated degree selection", "no influence diagnostics"] },
    knownGaps: ["multivariable polynomial and interaction terms are not supported", "no spline alternative is fitted", "degree selection is by nested F and AIC only"],
  },
};

/* ------------------------------------------------------------------------------------------ */
/* Nonlinear least squares (Levenberg-Marquardt over a named model catalogue)                  */
/* ------------------------------------------------------------------------------------------ */

function linearStart(xs, ys) {
  const n = xs.length;
  const mx = K.mean(xs);
  const my = K.mean(ys);
  let sxx = 0;
  let sxy = 0;
  for (let index = 0; index < n; index += 1) { sxx += (xs[index] - mx) ** 2; sxy += (xs[index] - mx) * (ys[index] - my); }
  const slope = sxx > 0 ? sxy / sxx : 0;
  return { slope, intercept: my - slope * mx };
}

const NLS_MODELS = {
  exponential_decay: {
    formula: "y = a * exp(-k * x) + c",
    parameters: ["a", "k", "c"],
    value: ([a, k, c], x) => a * Math.exp(-k * x) + c,
    jacobian: ([a, k], x) => { const e = Math.exp(-k * x); return [e, -a * x * e, 1]; },
    start(x, y) {
      const minY = Math.min(...y);
      const maxY = Math.max(...y);
      const c = minY - 0.05 * (maxY - minY);
      const positive = x.map((value, index) => ({ x: value, y: y[index] - c })).filter((point) => point.y > 0);
      const line = linearStart(positive.map((point) => point.x), positive.map((point) => Math.log(point.y)));
      return [Math.exp(line.intercept), Math.max(1e-6, -line.slope), c];
    },
    domain: () => true,
  },
  exponential_growth: {
    formula: "y = a * exp(k * x)",
    parameters: ["a", "k"],
    value: ([a, k], x) => a * Math.exp(k * x),
    jacobian: ([a, k], x) => { const e = Math.exp(k * x); return [e, a * x * e]; },
    start(x, y) {
      const positive = x.map((value, index) => ({ x: value, y: y[index] })).filter((point) => point.y > 0);
      const line = linearStart(positive.map((point) => point.x), positive.map((point) => Math.log(point.y)));
      return [Math.exp(line.intercept), line.slope];
    },
    domain: () => true,
  },
  logistic_growth: {
    formula: "y = K / (1 + exp(-r * (x - x0)))",
    parameters: ["K", "r", "x0"],
    value: ([Kc, r, x0], x) => Kc / (1 + Math.exp(-r * (x - x0))),
    jacobian: ([Kc, r, x0], x) => { const e = Math.exp(-r * (x - x0)); const d = 1 + e; return [1 / d, Kc * e * (x - x0) / (d * d), -Kc * e * r / (d * d)]; },
    start(x, y) {
      const maxY = Math.max(...y);
      const Kc = maxY * 1.05;
      const logits = x.map((value, index) => ({ x: value, y: y[index] })).filter((point) => point.y > 0 && point.y < Kc).map((point) => ({ x: point.x, z: Math.log(point.y / (Kc - point.y)) }));
      const line = linearStart(logits.map((point) => point.x), logits.map((point) => point.z));
      const r = line.slope !== 0 ? line.slope : 1;
      return [Kc, r, -line.intercept / r];
    },
    domain: () => true,
  },
  michaelis_menten: {
    formula: "y = Vmax * x / (Km + x)",
    parameters: ["Vmax", "Km"],
    value: ([vmax, km], x) => vmax * x / (km + x),
    jacobian: ([vmax, km], x) => [x / (km + x), -vmax * x / (km + x) ** 2],
    start(x, y) {
      const points = x.map((value, index) => ({ x: value, y: y[index] })).filter((point) => point.x > 0 && point.y > 0);
      const line = linearStart(points.map((point) => 1 / point.x), points.map((point) => 1 / point.y));
      const vmax = line.intercept > 0 ? 1 / line.intercept : Math.max(...y);
      const km = line.intercept > 0 ? Math.max(1e-6, line.slope / line.intercept) : K.median(x);
      return [vmax, km];
    },
    domain: (x) => x.every((value) => value >= 0),
  },
  power_law: {
    formula: "y = a * x^b",
    parameters: ["a", "b"],
    value: ([a, b], x) => a * x ** b,
    jacobian: ([a, b], x) => { const powered = x ** b; return [powered, a * powered * Math.log(x)]; },
    start(x, y) {
      const line = linearStart(x.map((value) => Math.log(value)), y.map((value) => Math.log(value)));
      return [Math.exp(line.intercept), line.slope];
    },
    domain: (x, y) => x.every((value) => value > 0) && y.every((value) => value > 0),
  },
  gaussian_peak: {
    formula: "y = a * exp(-(x - mu)^2 / (2 sigma^2)) + c",
    parameters: ["a", "mu", "sigma", "c"],
    value: ([a, mu, sigma, c], x) => a * Math.exp(-((x - mu) ** 2) / (2 * sigma * sigma)) + c,
    jacobian: ([a, mu, sigma], x) => { const e = Math.exp(-((x - mu) ** 2) / (2 * sigma * sigma)); return [e, a * e * (x - mu) / (sigma * sigma), a * e * (x - mu) ** 2 / (sigma ** 3), 1]; },
    start(x, y) {
      const minY = Math.min(...y);
      const maxIndex = y.indexOf(Math.max(...y));
      const a = y[maxIndex] - minY;
      const half = minY + a / 2;
      const above = x.filter((_, index) => y[index] >= half);
      const width = above.length > 1 ? Math.max(...above) - Math.min(...above) : (Math.max(...x) - Math.min(...x)) / 4;
      return [a, x[maxIndex], Math.max(1e-6, width / 2.3548), minY];
    },
    domain: () => true,
  },
  hill: {
    formula: "y = a * x^n / (k^n + x^n)",
    parameters: ["a", "k", "n"],
    value: ([a, k, nn], x) => { const u = x ** nn; return a * u / (k ** nn + u); },
    jacobian: ([a, k, nn], x) => { const u = x ** nn; const v = k ** nn; const d = u + v; return [u / d, -a * u * nn * k ** (nn - 1) / (d * d), a * u * v * (Math.log(x) - Math.log(k)) / (d * d)]; },
    start(x, y) {
      const a = Math.max(...y) * 1.02;
      const half = a / 2;
      let closest = 0;
      for (let index = 1; index < y.length; index += 1) if (Math.abs(y[index] - half) < Math.abs(y[closest] - half)) closest = index;
      return [a, Math.max(1e-6, x[closest]), 1];
    },
    domain: (x) => x.every((value) => value > 0),
  },
};

function levenbergMarquardt(model, x, y, start, H, budget, { maxIterations = 500, tolerance = 1e-12 } = {}) {
  const n = x.length;
  const k = start.length;
  const sse = (params) => { let total = 0; for (let index = 0; index < n; index += 1) { const value = model.value(params, x[index]); if (!Number.isFinite(value)) return Infinity; total += (y[index] - value) ** 2; } return total; };
  let params = [...start];
  let current = sse(params);
  if (!Number.isFinite(current)) H.fail("STAT_DEGENERATE", "starting values give a non-finite model value");
  let damping = 1e-3;
  let iterations = 0;
  let converged = false;
  let reason = "";
  for (iterations = 1; iterations <= maxIterations; iterations += 1) {
    budget.check(n * k * k);
    const jtj = Array.from({ length: k }, () => Array(k).fill(0));
    const jtr = Array(k).fill(0);
    for (let index = 0; index < n; index += 1) {
      const row = model.jacobian(params, x[index]);
      const residual = y[index] - model.value(params, x[index]);
      for (let a = 0; a < k; a += 1) {
        jtr[a] += row[a] * residual;
        for (let b = 0; b < k; b += 1) jtj[a][b] += row[a] * row[b];
      }
    }
    if (jtj.some((row) => row.some((value) => !Number.isFinite(value)))) H.fail("STAT_NON_CONVERGENCE", "Jacobian became non-finite during Levenberg-Marquardt iterations");
    const gradientNorm = Math.max(...jtr.map(Math.abs));
    if (gradientNorm < 1e-14 * Math.max(1, current)) { converged = true; reason = "gradient"; break; }
    let accepted = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const augmented = jtj.map((row, a) => row.map((value, b) => (a === b ? value + damping * Math.max(value, 1e-12) : value)));
      let step;
      try { step = K.matVec(H.invert(augmented), jtr); } catch { damping *= 10; continue; }
      const trial = params.map((value, index) => value + step[index]);
      const trialSse = sse(trial);
      if (trialSse < current) {
        const relative = (current - trial.length ? current - trialSse : 0) / Math.max(current, 1e-300);
        const stepSize = Math.max(...step.map((value, index) => Math.abs(value) / Math.max(1, Math.abs(params[index]))));
        params = trial;
        current = trialSse;
        damping = Math.max(1e-15, damping / 10);
        accepted = true;
        if (relative < tolerance || stepSize < 1e-12) { converged = true; reason = relative < tolerance ? "sse" : "step"; }
        break;
      }
      damping *= 10;
      if (damping > 1e16) break;
    }
    if (converged) break;
    if (!accepted) { converged = true; reason = "no_improving_step"; break; }
  }
  if (!converged) H.fail("STAT_NON_CONVERGENCE", `Levenberg-Marquardt did not converge in ${maxIterations} iterations`);
  const jtj = Array.from({ length: k }, () => Array(k).fill(0));
  const residuals = [];
  const fitted = [];
  for (let index = 0; index < n; index += 1) {
    const row = model.jacobian(params, x[index]);
    const value = model.value(params, x[index]);
    fitted.push(value);
    residuals.push(y[index] - value);
    for (let a = 0; a < k; a += 1) for (let b = 0; b < k; b += 1) jtj[a][b] += row[a] * row[b];
  }
  const inverse = K.invertSymmetric(jtj, H, "STAT_SINGULAR_FIT", "Jacobian cross-product is singular at the solution (parameters not identifiable)");
  const df = n - k;
  const sigma2 = current / df;
  const covariance = inverse.map((row) => row.map((value) => value * sigma2));
  return { params, sse: current, residuals, fitted, covariance, iterations, reason, df, sigma2, damping };
}

const nonlinearLeastSquares = {
  method: "nonlinear_least_squares",
  family: "regression",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs", "maxIterations"],
  customOptions: {
    model: { schema: { type: "string", enum: Object.keys(NLS_MODELS) }, default: "exponential_decay", parse(value, H, path) { if (!Object.hasOwn(NLS_MODELS, value)) H.fail("STAT_INVALID_INPUT", `${path} must be one of ${Object.keys(NLS_MODELS).join(", ")}`); return value; } },
    start: {
      schema: { type: "object", additionalProperties: { type: "number" } },
      default: null,
      parse(value, H, path) {
        const object = H.assertObject(value, path);
        const parsed = {};
        for (const [key, item] of Object.entries(object)) parsed[key] = H.finiteNumber(item, `${path}.${key}`);
        return parsed;
      },
    },
  },
  dataSchema: { type: "object", additionalProperties: false, required: ["x", "y"], properties: { x: NUMERIC_SCHEMA(6), y: NUMERIC_SCHEMA(6), xLabel: LABEL_SCHEMA, yLabel: LABEL_SCHEMA } },
  parse(data, options, H) {
    H.assertKeys(data, ["x", "y", "xLabel", "yLabel"], "data");
    const x = H.numericVector(data.x, "data.x", 6);
    const y = H.numericVector(data.y, "data.y", 6);
    if (x.length !== y.length) H.fail("STAT_INVALID_INPUT", "data.x and data.y must have the same length");
    limitRows(x.length, H, "nonlinear_least_squares");
    const model = NLS_MODELS[options.model];
    if (x.length <= model.parameters.length + 1) H.fail("STAT_INSUFFICIENT_SAMPLE", `${options.model} needs at least ${model.parameters.length + 2} observations`);
    if (!model.domain(x, y)) H.fail("STAT_INVALID_INPUT", `${options.model} requires data within its domain (positive x and/or y where the model takes logarithms or powers)`);
    if (new Set(x).size < 3) H.fail("STAT_DEGENERATE", "data.x needs at least three distinct values");
    if (options.start !== null) {
      const keys = Object.keys(options.start).sort();
      const expected = [...model.parameters].sort();
      if (keys.join(",") !== expected.join(",")) H.fail("STAT_INVALID_INPUT", `options.start must provide exactly the parameters ${model.parameters.join(", ")}`);
    }
    return { x, y, xLabel: H.label(data.xLabel, "x", "data.xLabel"), yLabel: H.label(data.yLabel, "y", "data.yLabel") };
  },
  analyze(parsed, options, budget, H) {
    const { x, y } = parsed;
    const n = x.length;
    const model = NLS_MODELS[options.model];
    const start = options.start ? model.parameters.map((name) => options.start[name]) : model.start(x, y);
    if (start.some((value) => !Number.isFinite(value))) H.fail("STAT_DEGENERATE", "starting values could not be derived from the data; supply options.start");
    const fit = levenbergMarquardt(model, x, y, start, H, budget, { maxIterations: Math.max(options.maxIterations, 200) });
    const level = options.confidenceLevel;
    const rows = K.coefficientRows(model.parameters, fit.params, fit.covariance, fit.df, level, H);
    const yMean = K.mean(y);
    const tss = y.reduce((total, value) => total + (value - yMean) ** 2, 0);
    const logLikelihood = K.gaussianLogLikelihood(fit.sse, n);
    const criteria = informationCriteria(logLikelihood, model.parameters.length + 1, n);
    const observationRows = x.map((value, index) => ({ x: value, y: y[index], fitted: fit.fitted[index], residual: fit.residuals[index] }));
    const { min, max } = H.minMax(x);
    const curveRows = [];
    const critical = H.tCritical(level, fit.df);
    for (let g = 0; g < 101; g += 1) {
      const xg = min + (max - min) * g / 100;
      const prediction = model.value(fit.params, xg);
      const gradient = model.jacobian(fit.params, xg);
      const se = Math.sqrt(Math.max(0, H.quadraticForm(gradient, fit.covariance)));
      curveRows.push({ x: xg, fitted: prediction, lower: prediction - critical * se, upper: prediction + critical * se });
    }
    const correlationRows = [];
    for (let a = 0; a < model.parameters.length; a += 1) for (let b = a + 1; b < model.parameters.length; b += 1) correlationRows.push({ parameterA: model.parameters[a], parameterB: model.parameters[b], correlation: fit.covariance[a][b] / Math.sqrt(fit.covariance[a][a] * fit.covariance[b][b]) });
    const maxCorrelation = correlationRows.length ? Math.max(...correlationRows.map((row) => Math.abs(row.correlation))) : 0;
    const residualJb = H.jarqueBera(fit.residuals, budget);
    return {
      sample: { n, model: options.model, parameters: model.parameters.length, residualDf: fit.df },
      estimates: [
        ...rows.map((row) => ({ ...row, kind: "parameter" })),
        { term: "residual standard error", estimate: Math.sqrt(fit.sigma2), kind: "fit" },
        { term: "residual sum of squares", estimate: fit.sse, kind: "fit" },
        { term: "pseudo R-squared (1 - SSE/TSS)", estimate: tss > 0 ? 1 - fit.sse / tss : 0, kind: "fit" },
        { term: "AIC (Gaussian, sigma counted)", estimate: criteria.aic, kind: "fit" },
        { term: "BIC (Gaussian, sigma counted)", estimate: criteria.bic, kind: "fit" },
      ],
      tests: rows.map((row) => ({ name: `t test ${row.term} = 0`, statistic: row.statistic, df: row.df, pValue: row.pValue, distribution: "t (linearization)" })),
      confidenceIntervals: rows.map((row) => ({ parameter: row.term, level, lower: row.lower, upper: row.upper, method: "t on the linearized (Gauss-Newton) covariance" })),
      effectSizes: [{ name: "pseudo R-squared", estimate: tss > 0 ? 1 - fit.sse / tss : 0 }],
      assumptions: [
        { name: `mean function ${model.formula}`, status: "requires_domain_review" },
        { name: "homoscedastic normal errors", status: residualJb.pValue < 0.05 ? "residual_normality_rejected_by_jarque_bera" : "residual_normality_not_rejected", statistic: residualJb.statistic, pValue: residualJb.pValue },
        { name: "local linearization adequate for intervals", status: maxCorrelation > 0.99 ? "parameters_nearly_collinear_intervals_unreliable" : "asymptotic" },
        { name: "global minimum reached", status: "not_established", detail: "Levenberg-Marquardt finds a local minimum from the reported start; verify with alternative starts" },
      ],
      diagnostics: [
        { name: "convergence", status: "converged", iterations: fit.iterations, criterion: fit.reason, finalDamping: fit.damping, algorithm: "Levenberg-Marquardt with analytic Jacobian" },
        { name: "start values", status: options.start ? "user_supplied" : "heuristic", values: Object.fromEntries(model.parameters.map((name, index) => [name, start[index]])) },
        { name: "parameter correlation", status: maxCorrelation > 0.99 ? "near_singular" : "reported", maximumAbsoluteCorrelation: maxCorrelation },
        { name: "information criteria", aic: criteria.aic, bic: criteria.bic, parameters: model.parameters.length + 1 },
      ],
      artifacts: [
        H.tableArtifact(`Nonlinear least squares: ${options.model}`, `${model.formula}; ${percent(level)} t intervals from the linearized covariance with ${fit.df} residual df.`, K.coefficientColumns("t"), rows, [`Start values: ${model.parameters.map((name, index) => `${name} = ${start[index].toPrecision(6)}`).join(", ")}.`], "nls-parameters-table"),
        H.tableArtifact("Parameter correlations", "Correlations of the parameter estimates from the linearized covariance; values near 1 signal weak identifiability.", [STRING_COLUMN("parameterA", "Parameter A"), STRING_COLUMN("parameterB", "Parameter B"), NUMBER_COLUMN("correlation", "Correlation")], correlationRows, [], "nls-correlation-table"),
        H.tableArtifact("Observations and fitted values", "Observed data with fitted values and residuals.", [NUMBER_COLUMN("x", parsed.xLabel), NUMBER_COLUMN("y", parsed.yLabel), NUMBER_COLUMN("fitted", "Fitted"), NUMBER_COLUMN("residual", "Residual")], observationRows, [], "nls-observations-table"),
        H.tableArtifact("Fitted curve", `Fitted model on a 101-point grid with ${percent(level)} delta-method confidence band.`, [NUMBER_COLUMN("x", parsed.xLabel), NUMBER_COLUMN("fitted", "Fitted"), NUMBER_COLUMN("lower", "CI lower"), NUMBER_COLUMN("upper", "CI upper")], curveRows, [], "nls-curve-table"),
        H.vegaArtifact("nls-fit-plot", `${options.model} fit with ${percent(level)} confidence band`, {
          layer: [
            { data: { values: curveRows }, mark: { type: "area", opacity: 0.2, color: "#d95f02" }, encoding: { x: { field: "x", type: "quantitative", title: parsed.xLabel }, y: { field: "lower", type: "quantitative", title: parsed.yLabel }, y2: { field: "upper" } } },
            { data: { values: curveRows }, mark: { type: "line", color: "#d95f02", strokeWidth: 2 }, encoding: { x: { field: "x", type: "quantitative" }, y: { field: "fitted", type: "quantitative" } } },
            { data: { values: observationRows }, mark: { type: "point", filled: true, color: "#222", opacity: 0.8 }, encoding: { x: { field: "x", type: "quantitative" }, y: { field: "y", type: "quantitative" }, tooltip: [{ field: "x", format: ".4g" }, { field: "y", format: ".4g" }, { field: "fitted", format: ".4g" }, { field: "residual", format: ".4g" }] } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "Theory specifies a mechanistic curve (decay, growth, saturation, dose-response, peak) whose parameters have scientific meaning, so a linear or polynomial fit would not answer the question.",
    decision: "Whether the mechanistic model describes the data, what the parameter values and uncertainties are, and whether the parameters are identifiable from this design.",
    mustShow: "Parameter estimates with intervals, start values, convergence evidence, parameter correlations, residual diagnostics, and the fitted curve with its confidence band over the observed range.",
    userGoal: "Estimate interpretable mechanistic parameters with honest uncertainty rather than an empirical curve.",
    nextActions: [
      { trigger: "parameters-nearly-collinear", action: "redesign-x-coverage-or-fix-a-parameter", reason: "Near-singular parameter correlations mean the data cannot separate the parameters and intervals are unreliable." },
      { trigger: "convergence-depends-on-start", action: "run-multi-start-sensitivity-and-report-best-sse", reason: "A local minimum is not evidence for the mechanism; competing optima must be shown." },
      { trigger: "systematic-residual-pattern", action: "compare-alternative-model-from-catalogue", reason: "Structured residuals indicate the chosen mechanistic form is wrong for this system." },
      { trigger: "fit-accepted", action: "bind-parameter-table-and-fit-plot", reason: "The parameters and the curve with its band are the scientific result." },
    ],
  },
  fixture: {
    data: {
      x: [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20],
      y: [10.2, 8.1, 6.6, 5.4, 4.5, 3.8, 3.2, 2.5, 2.1, 1.8, 1.55, 1.4],
      xLabel: "Time (h)",
      yLabel: "Concentration",
    },
    options: { model: "exponential_decay", confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "Levenberg-Marquardt nonlinear least squares with analytic Jacobians for a catalogue of seven named models (exponential decay and growth, logistic growth, Michaelis-Menten, power law, Gaussian peak, Hill), linearized standard errors and t intervals, parameter correlations, and a delta-method confidence band.",
    oracle: {
      level: "external-library-partial",
      evidence: ["contracts/regression-extended-scipy-crosscheck.py"],
      verifiedOutputs: ["parameter estimates (scipy least_squares from the same start)", "residual sum of squares", "linearized standard errors"],
      excludedOutputs: ["heuristic start values", "delta-method band", "information criteria"],
    },
    diagnostic: { level: "method-specific-partial", emitted: ["convergence", "start values", "parameter correlation", "residual normality screen"], limitations: ["no multi-start search", "no profile-likelihood intervals", "no weighted residuals"] },
    knownGaps: ["profile-likelihood intervals are not computed", "custom user formulas are not accepted; only the named catalogue", "no weighted or heteroscedastic error model"],
  },
};

/* ------------------------------------------------------------------------------------------ */
/* Model comparison by information criteria                                                    */
/* ------------------------------------------------------------------------------------------ */

const modelComparisonInformationCriteria = {
  method: "model_comparison_information_criteria",
  family: "regression",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["timeoutMs"],
  customOptions: {},
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["y", "predictors", "models"],
    properties: {
      y: NUMERIC_SCHEMA(8),
      predictors: PREDICTORS_SCHEMA,
      models: { type: "array", minItems: 2, maxItems: 16, items: { type: "object", additionalProperties: false, required: ["terms"], properties: { name: LABEL_SCHEMA, terms: { type: "array", minItems: 0, maxItems: 48, items: LABEL_SCHEMA } } } },
      outcomeLabel: LABEL_SCHEMA,
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["y", "predictors", "models", "outcomeLabel"], "data");
    const base = parseNumericOutcome(data, H, "model_comparison_information_criteria", 8);
    if (!Array.isArray(data.models) || data.models.length < 2 || data.models.length > 16) H.fail("STAT_INVALID_INPUT", "data.models must list 2 to 16 candidate models");
    const names = new Set();
    const models = data.models.map((raw, index) => {
      const path = `data.models[${index}]`;
      const item = H.assertObject(raw, path);
      H.assertKeys(item, ["name", "terms"], path);
      if (!Array.isArray(item.terms)) H.fail("STAT_INVALID_INPUT", `${path}.terms must be an array of predictor names`);
      const terms = item.terms.map((term, termIndex) => H.label(term, "", `${path}.terms[${termIndex}]`));
      if (new Set(terms).size !== terms.length) H.fail("STAT_INVALID_INPUT", `${path}.terms must not repeat a predictor`);
      for (const term of terms) if (!base.predictors.some((predictor) => predictor.name === term)) H.fail("STAT_INVALID_INPUT", `${path}.terms references unknown predictor ${term}`);
      const name = H.label(item.name, terms.length ? terms.join(" + ") : "intercept only", `${path}.name`);
      if (names.has(name)) H.fail("STAT_INVALID_INPUT", `duplicate model name ${name}`);
      names.add(name);
      return { name, terms };
    });
    return { ...base, models };
  },
  analyze(parsed, options, budget, H) {
    const { y, predictors, models } = parsed;
    const n = y.length;
    const yMean = K.mean(y);
    const tss = y.reduce((total, value) => total + (value - yMean) ** 2, 0);
    const fits = models.map((model) => {
      const subset = model.terms.map((term) => predictors.find((predictor) => predictor.name === term));
      const design = H.designMatrix({ y, predictors: subset }, true);
      const p = design.terms.length;
      if (H.matrixRank(design.x) < p) H.fail("STAT_RANK_DEFICIENT", `model ${model.name} has a rank-deficient design`);
      const fit = K.olsFit(y, design.x, H, budget);
      const criteria = informationCriteria(fit.logLikelihood, p, n);
      return { model, fit, p, criteria, adjustedRSquared: 1 - (fit.rss / fit.df) / (tss / (n - 1)) };
    });
    const minAic = Math.min(...fits.map((item) => item.criteria.aic));
    const minBic = Math.min(...fits.map((item) => item.criteria.bic));
    const minAicc = Math.min(...fits.map((item) => (item.criteria.aicc === null ? Infinity : item.criteria.aicc)));
    const aicWeights = fits.map((item) => Math.exp(-0.5 * (item.criteria.aic - minAic)));
    const bicWeights = fits.map((item) => Math.exp(-0.5 * (item.criteria.bic - minBic)));
    const aicTotal = aicWeights.reduce((total, value) => total + value, 0);
    const bicTotal = bicWeights.reduce((total, value) => total + value, 0);
    const rows = fits.map((item, index) => ({
      model: item.model.name,
      terms: item.model.terms.length ? item.model.terms.join(" + ") : "(intercept only)",
      parameters: item.p,
      rss: item.fit.rss,
      logLikelihood: item.fit.logLikelihood,
      aic: item.criteria.aic,
      aicc: item.criteria.aicc,
      bic: item.criteria.bic,
      deltaAic: item.criteria.aic - minAic,
      deltaAicc: item.criteria.aicc === null ? null : item.criteria.aicc - minAicc,
      deltaBic: item.criteria.bic - minBic,
      akaikeWeight: aicWeights[index] / aicTotal,
      bicWeight: bicWeights[index] / bicTotal,
      rSquared: item.fit.rSquared,
      adjustedRSquared: item.adjustedRSquared,
    }));
    const nestedRows = [];
    for (let a = 0; a < fits.length; a += 1) {
      for (let b = 0; b < fits.length; b += 1) {
        if (a === b) continue;
        const small = fits[a];
        const large = fits[b];
        const setLarge = new Set(large.model.terms);
        if (small.model.terms.length >= large.model.terms.length || !small.model.terms.every((term) => setLarge.has(term))) continue;
        budget.check();
        const df1 = large.p - small.p;
        const df2 = large.fit.df;
        const f = ((small.fit.rss - large.fit.rss) / df1) / (large.fit.rss / df2);
        nestedRows.push({ reducedModel: small.model.name, fullModel: large.model.name, df1, df2, fStatistic: f, pValue: H.pFromF(Math.max(0, f), df1, df2), addedTerms: large.model.terms.filter((term) => !small.model.terms.includes(term)).join(" + ") });
      }
    }
    const bestAic = rows.reduce((best, row) => (row.aic < best.aic ? row : best), rows[0]);
    const bestBic = rows.reduce((best, row) => (row.bic < best.bic ? row : best), rows[0]);
    const sortedWeights = [...rows].sort((left, right) => right.akaikeWeight - left.akaikeWeight);
    return {
      sample: { n, candidateModels: models.length, nestedComparisons: nestedRows.length },
      estimates: rows.map((row) => ({ ...row, kind: "model" })),
      tests: nestedRows.map((row) => ({ name: `nested F test: ${row.fullModel} versus ${row.reducedModel}`, statistic: row.fStatistic, df1: row.df1, df2: row.df2, pValue: row.pValue, distribution: "F" })),
      confidenceIntervals: [],
      effectSizes: [
        { name: "Akaike weight of the best AIC model", estimate: bestAic.akaikeWeight, model: bestAic.model },
        { name: "evidence ratio best versus second AIC model", estimate: sortedWeights.length > 1 && sortedWeights[1].akaikeWeight > 0 ? sortedWeights[0].akaikeWeight / sortedWeights[1].akaikeWeight : null },
      ],
      assumptions: [
        { name: "all candidates fitted to the same observations", status: "verified_by_construction" },
        { name: "Gaussian likelihood for AIC/BIC", status: "requires_design_review", detail: "log-likelihood uses the maximum-likelihood error variance RSS/n; the parameter count excludes the error variance (statsmodels convention; R adds one)" },
        { name: "candidate set contains a scientifically adequate model", status: "requires_domain_review", detail: "information criteria rank relative fit only" },
      ],
      diagnostics: [
        { name: "best models", aic: bestAic.model, bic: bestBic.model, status: bestAic.model === bestBic.model ? "aic_and_bic_agree" : "aic_and_bic_disagree" },
        { name: "small-sample correction", status: n / Math.max(...fits.map((item) => item.p)) < 40 ? "aicc_recommended" : "aic_adequate", ratio: n / Math.max(...fits.map((item) => item.p)) },
        { name: "nested comparisons", status: nestedRows.length ? "reported" : "no_nested_pairs" },
      ],
      artifacts: [
        H.tableArtifact("Information-criterion model comparison", `Candidate linear models for ${parsed.outcomeLabel} ranked by AIC with Akaike and BIC weights.`, [STRING_COLUMN("model", "Model"), STRING_COLUMN("terms", "Terms"), NUMBER_COLUMN("parameters", "k"), NUMBER_COLUMN("rss", "RSS"), NUMBER_COLUMN("logLikelihood", "Log-likelihood"), NUMBER_COLUMN("aic", "AIC"), NUMBER_COLUMN("aicc", "AICc"), NUMBER_COLUMN("bic", "BIC"), NUMBER_COLUMN("deltaAic", "dAIC"), NUMBER_COLUMN("deltaAicc", "dAICc"), NUMBER_COLUMN("deltaBic", "dBIC"), NUMBER_COLUMN("akaikeWeight", "Akaike weight"), NUMBER_COLUMN("bicWeight", "BIC weight"), NUMBER_COLUMN("rSquared", "R-squared"), NUMBER_COLUMN("adjustedRSquared", "Adjusted R-squared")], rows, ["k counts the intercept and slopes only (statsmodels convention); AICc adds 2k(k+1)/(n-k-1)."], "model-comparison-table"),
        H.tableArtifact("Nested model F tests", "Extra-sum-of-squares F tests for every strictly nested pair of candidates.", [STRING_COLUMN("reducedModel", "Reduced"), STRING_COLUMN("fullModel", "Full"), STRING_COLUMN("addedTerms", "Added terms"), NUMBER_COLUMN("df1", "df1"), NUMBER_COLUMN("df2", "df2"), NUMBER_COLUMN("fStatistic", "F"), NUMBER_COLUMN("pValue", "p")], nestedRows, nestedRows.length ? [] : ["No candidate pair is strictly nested."], "model-comparison-nested-table"),
        H.vegaArtifact("model-comparison-weights", "Akaike weights across candidate models", {
          data: { values: rows },
          layer: [
            { mark: { type: "bar" }, encoding: { y: { field: "model", type: "nominal", sort: "-x", title: null }, x: { field: "akaikeWeight", type: "quantitative", title: "Akaike weight", scale: { domain: [0, 1] } }, color: { field: "deltaAic", type: "quantitative", title: "dAIC", scale: { scheme: "blues", reverse: true } }, tooltip: [{ field: "model" }, { field: "aic", format: ".4g" }, { field: "deltaAic", format: ".3g" }, { field: "akaikeWeight", format: ".3f" }, { field: "bicWeight", format: ".3f" }] } },
            { mark: { type: "text", align: "left", dx: 4 }, encoding: { y: { field: "model", type: "nominal", sort: "-x" }, x: { field: "akaikeWeight", type: "quantitative" }, text: { field: "deltaAic", type: "quantitative", format: ".2f" } } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "Several prespecified linear models compete to explain the same outcome and the researcher needs a principled ranking rather than a sequence of significance tests.",
    decision: "Which candidate model has the best support, how much better it is than the alternatives, and whether the added terms in nested models earn their parameters.",
    mustShow: "AIC, AICc, BIC, delta values, Akaike and BIC weights, evidence ratios, adjusted R-squared, and nested F tests for every nested pair.",
    userGoal: "Choose and justify a model from a declared candidate set with transparent relative-support measures.",
    nextActions: [
      { trigger: "aic-and-bic-disagree", action: "report-both-rankings-and-state-selection-goal", reason: "AIC favors prediction and BIC favors parsimony; the choice between them is a research decision, not a numeric one." },
      { trigger: "no-model-dominates", action: "plan-model-averaging-or-collect-more-data", reason: "Similar weights mean the data cannot discriminate the candidates and a single-model report overstates certainty." },
      { trigger: "small-sample-ratio", action: "rank-by-aicc-instead-of-aic", reason: "AIC over-selects complex models when n/k is small." },
      { trigger: "clear-winner", action: "bind-comparison-table-and-weight-figure", reason: "Readers need the full candidate set and its relative support, not only the chosen model." },
    ],
  },
  fixture: {
    data: {
      y: [12.1, 14.3, 15.9, 18.2, 20.4, 21.7, 24.1, 26.3, 27.8, 30.2, 31.5, 33.9, 36.1, 37.6, 40.2, 41.8],
      predictors: [
        { name: "x1", values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] },
        { name: "x2", values: [1.2, 1.9, 3.2, 3.9, 5.1, 6.2, 6.8, 8.1, 9.3, 9.8, 11.2, 12.1, 12.8, 14.2, 15.1, 15.9] },
        { name: "x3", values: [0.5, -0.2, 0.8, 1.1, -0.6, 0.3, 1.4, -0.9, 0.2, 0.7, -0.4, 1.0, -0.1, 0.6, -0.8, 0.9] },
      ],
      models: [
        { name: "null", terms: [] },
        { name: "x1", terms: ["x1"] },
        { name: "x1 + x3", terms: ["x1", "x3"] },
        { name: "x1 + x2 + x3", terms: ["x1", "x2", "x3"] },
      ],
      outcomeLabel: "Yield",
    },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "Gaussian linear candidate models fitted by least squares with AIC, AICc, BIC, delta values, Akaike and BIC weights, evidence ratio, adjusted R-squared, and extra-sum-of-squares F tests for all strictly nested pairs.",
    oracle: {
      level: "external-library-partial",
      evidence: ["contracts/regression-extended-scipy-crosscheck.py"],
      verifiedOutputs: ["log-likelihood, AIC, BIC per model (statsmodels OLS)", "adjusted R-squared", "nested F statistics and p values (statsmodels compare_f_test)", "Akaike weights (first-principles)"],
      excludedOutputs: ["AICc", "evidence ratio", "small-sample recommendation"],
    },
    diagnostic: { level: "method-specific-partial", emitted: ["best models", "small-sample correction", "nested comparisons"], limitations: ["linear Gaussian models only", "no cross-validated comparison", "no model averaging of coefficients"] },
    knownGaps: ["generalized linear and mixed candidates are not compared", "no multimodel-averaged coefficients", "no cross-validation-based ranking"],
  },
};

module.exports = {
  methods: [
    ordinalLogisticRegression,
    multinomialLogisticRegression,
    negativeBinomialRegression,
    ridgeRegression,
    lassoRegression,
    elasticNetRegression,
    quantileRegression,
    robustLinearRegression,
    polynomialRegression,
    nonlinearLeastSquares,
    modelComparisonInformationCriteria,
  ],
  NLS_MODELS,
};
