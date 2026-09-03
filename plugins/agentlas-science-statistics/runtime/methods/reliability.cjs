"use strict";

/**
 * Reliability, psychometric, and inter-rater agreement family.
 *
 * Methods: cronbach_alpha, mcdonald_omega, intraclass_correlation, cohen_kappa, fleiss_kappa,
 * krippendorff_alpha, kendall_w. Pure deterministic JavaScript; every numeric helper arrives through `H`.
 * Independent oracle: contracts/reliability-scipy-crosscheck.py (pingouin, sklearn, statsmodels, numpy/scipy).
 */

const MAX_COLUMNS = 64;
const MAX_ROWS = 10_000;

// ---------------------------------------------------------------------------------------------
// Shared numeric helpers
// ---------------------------------------------------------------------------------------------

function normalUpperTail(z, H) {
  const tail = 0.5 * H.gammaQ(0.5, (z * z) / 2);
  return z >= 0 ? tail : 1 - tail;
}

function twoSidedNormalP(z, H) {
  if (!Number.isFinite(z)) H.fail("STAT_DEGENERATE", "z statistic is not finite");
  return Math.min(1, Math.max(0, H.gammaQ(0.5, (z * z) / 2)));
}

function fQuantile(probability, df1, df2, H) {
  // Returns x with P(F(df1, df2) <= x) = probability, by bisection on the accurate upper tail.
  if (!(probability > 0 && probability < 1)) H.fail("STAT_INTERNAL", "F quantile probability out of range");
  if (!(df1 > 0) || !(df2 > 0)) H.fail("STAT_DEGENERATE", "F quantile requires positive degrees of freedom");
  const upper = 1 - probability;
  let low = 0;
  let high = 1;
  let guard = 0;
  while (H.pFromF(high, df1, df2) > upper) {
    high *= 2;
    guard += 1;
    if (guard > 200) H.fail("STAT_NON_CONVERGENCE", "F quantile bracket search did not converge");
  }
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const mid = (low + high) / 2;
    if (H.pFromF(mid, df1, df2) > upper) low = mid;
    else high = mid;
    if (high - low <= 1e-14 * Math.max(1, high)) break;
  }
  return (low + high) / 2;
}

/**
 * Leading eigenpair of a symmetric (possibly indefinite) matrix by shifted power iteration.
 * The shift by the infinity norm makes every eigenvalue non-negative so the largest algebraic
 * eigenvalue of the original matrix dominates. Deterministic start vector; sign canonicalized.
 */
function leadingEigenpair(matrix, budget, H) {
  const n = matrix.length;
  const shift = H.matrixInfinityNorm(matrix);
  let vector = Array(n).fill(1 / Math.sqrt(n));
  let value = 0;
  for (let iteration = 0; iteration < 20000; iteration += 1) {
    budget.check(n);
    const next = matrix.map((row, i) => row.reduce((total, entry, j) => total + entry * vector[j], 0) + shift * vector[i]);
    const norm = Math.sqrt(next.reduce((total, entry) => total + entry * entry, 0));
    if (!(norm > 0)) H.fail("STAT_DEGENERATE", "power iteration collapsed to the zero vector");
    const normalized = next.map((entry) => entry / norm);
    const change = Math.max(...normalized.map((entry, i) => Math.abs(entry - vector[i])));
    vector = normalized;
    value = norm - shift;
    if (change < 1e-15) break;
    if (iteration === 19999) H.fail("STAT_NON_CONVERGENCE", "leading eigenvector power iteration did not converge");
  }
  let anchor = 0;
  for (let i = 1; i < n; i += 1) if (Math.abs(vector[i]) > Math.abs(vector[anchor])) anchor = i;
  if (vector[anchor] < 0) vector = vector.map((entry) => -entry);
  return { value, vector };
}

function finiteOrFail(value, message, H) {
  if (typeof value !== "number" || !Number.isFinite(value)) H.fail("STAT_DEGENERATE", message);
  return Object.is(value, -0) ? 0 : value;
}

function pearson(x, y, H, budget) {
  const mx = H.mean(x, budget);
  const my = H.mean(y, budget);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let index = 0; index < x.length; index += 1) {
    if (budget) budget.check();
    const dx = x[index] - mx;
    const dy = y[index] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (!(sxx > 0) || !(syy > 0)) H.fail("STAT_DEGENERATE", "correlation requires both series to vary");
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * Parses a wide numeric matrix given as an array of { <nameKey>, values } columns.
 * Returns { names, columns, n }.
 */
function parseNumericColumns(raw, path, nameKey, fallbackPrefix, H, { minColumns = 2, minRows = 2 } = {}) {
  if (!Array.isArray(raw) || raw.length < minColumns || raw.length > MAX_COLUMNS) {
    H.fail("STAT_INVALID_INPUT", `${path} must contain between ${minColumns} and ${MAX_COLUMNS} entries`);
  }
  const names = [];
  const columns = [];
  const seen = new Set();
  raw.forEach((rawColumn, index) => {
    const columnPath = `${path}[${index}]`;
    const column = H.assertObject(rawColumn, columnPath);
    H.assertKeys(column, [nameKey, "values"], columnPath);
    const name = H.label(column[nameKey], `${fallbackPrefix} ${index + 1}`, `${columnPath}.${nameKey}`);
    if (seen.has(name)) H.fail("STAT_INVALID_INPUT", `${path} has a duplicate ${nameKey}: ${name}`);
    seen.add(name);
    const values = H.numericVector(column.values, `${columnPath}.values`, minRows);
    if (values.length > MAX_ROWS) H.fail("STAT_LIMIT_EXCEEDED", `${columnPath}.values exceeds ${MAX_ROWS} rows`);
    if (columns.length && values.length !== columns[0].length) H.fail("STAT_INVALID_INPUT", `${path} entries must all have the same number of rows`);
    names.push(name);
    columns.push(values);
  });
  return { names, columns, n: columns[0].length };
}

function parseSubjectLabels(raw, n, H) {
  if (raw === undefined) return Array.from({ length: n }, (_, index) => `Subject ${index + 1}`);
  if (!Array.isArray(raw) || raw.length !== n) H.fail("STAT_INVALID_INPUT", "data.subjectLabels length must match the number of rows");
  const labels = raw.map((item, index) => H.label(item, `Subject ${index + 1}`, `data.subjectLabels[${index}]`));
  if (new Set(labels).size !== labels.length) H.fail("STAT_INVALID_INPUT", "data.subjectLabels must be unique");
  return labels;
}

function correlationMatrix(columns, H, budget) {
  const k = columns.length;
  const matrix = Array.from({ length: k }, () => Array(k).fill(1));
  for (let row = 0; row < k; row += 1) {
    for (let column = row + 1; column < k; column += 1) {
      const value = pearson(columns[row], columns[column], H, budget);
      matrix[row][column] = value;
      matrix[column][row] = value;
    }
  }
  return matrix;
}

function columnSchema(nameKey, minItems, itemType = { type: "number" }) {
  return {
    type: "array",
    minItems,
    maxItems: MAX_COLUMNS,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["values"],
      properties: {
        [nameKey]: { type: "string", minLength: 1, maxLength: 128 },
        values: { type: "array", minItems: 2, maxItems: MAX_ROWS, items: itemType },
      },
    },
  };
}

const subjectLabelsSchema = { type: "array", minItems: 2, maxItems: MAX_ROWS, items: { type: "string", minLength: 1, maxLength: 128 } };

// ---------------------------------------------------------------------------------------------
// cronbach_alpha
// ---------------------------------------------------------------------------------------------

const cronbachAlpha = {
  method: "cronbach_alpha",
  family: "reliability",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: columnSchema("name", 2),
      subjectLabels: subjectLabelsSchema,
      scaleLabel: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["items", "subjectLabels", "scaleLabel"], "data");
    const matrix = parseNumericColumns(data.items, "data.items", "name", "Item", H, { minColumns: 2, minRows: 2 });
    if (matrix.n < 3) H.fail("STAT_INSUFFICIENT_SAMPLE", "cronbach_alpha requires at least three respondents");
    matrix.columns.forEach((column, index) => {
      if (!(H.variance(column) > 0)) H.fail("STAT_DEGENERATE", `item ${matrix.names[index]} is constant`);
    });
    return { ...matrix, subjectLabels: parseSubjectLabels(data.subjectLabels, matrix.n, H), scaleLabel: H.label(data.scaleLabel, "Scale", "data.scaleLabel") };
  },
  analyze(parsed, options, budget, H) {
    const { names, columns, n } = parsed;
    const k = columns.length;
    const alphaFromColumns = (cols) => {
      const kk = cols.length;
      const itemVariance = cols.reduce((total, column) => total + H.variance(column, true, budget), 0);
      const totals = cols[0].map((_, row) => cols.reduce((total, column) => total + column[row], 0));
      const totalVariance = H.variance(totals, true, budget);
      if (!(totalVariance > 0)) H.fail("STAT_DEGENERATE", "total score variance must be positive");
      return { alpha: (kk / (kk - 1)) * (1 - itemVariance / totalVariance), itemVariance, totalVariance, totals };
    };
    const full = alphaFromColumns(columns);
    const alpha = finiteOrFail(full.alpha, "Cronbach alpha is not finite", H);
    const R = correlationMatrix(columns, H, budget);
    let correlationSum = 0;
    for (let row = 0; row < k; row += 1) for (let column = row + 1; column < k; column += 1) correlationSum += R[row][column];
    const meanCorrelation = correlationSum / (k * (k - 1) / 2);
    const standardizedAlpha = (k * meanCorrelation) / (1 + (k - 1) * meanCorrelation);
    finiteOrFail(standardizedAlpha, "standardized alpha is not finite", H);
    const df1 = n - 1;
    const df2 = (n - 1) * (k - 1);
    const a = 1 - options.confidenceLevel;
    const fUpper = fQuantile(1 - a / 2, df1, df2, H);
    const fLower = fQuantile(a / 2, df1, df2, H);
    const lower = 1 - (1 - alpha) * fUpper;
    const upper = 1 - (1 - alpha) * fLower;
    const itemRows = columns.map((column, index) => {
      budget.check();
      const rest = full.totals.map((total, row) => total - column[row]);
      const others = columns.filter((_, other) => other !== index);
      const alphaIfDeleted = others.length >= 2 ? alphaFromColumns(others).alpha : null;
      return {
        item: names[index],
        mean: H.mean(column, budget),
        sd: Math.sqrt(H.variance(column, true, budget)),
        correctedItemTotal: pearson(column, rest, H, budget),
        alphaIfDeleted: alphaIfDeleted === null ? null : finiteOrFail(alphaIfDeleted, "alpha-if-deleted is not finite", H),
        overallAlpha: alpha,
      };
    });
    const summaryRows = [
      { statistic: "Cronbach alpha (raw)", value: alpha },
      { statistic: "Cronbach alpha (standardized)", value: standardizedAlpha },
      { statistic: "Mean inter-item correlation", value: meanCorrelation },
      { statistic: `Feldt lower ${Math.round(options.confidenceLevel * 100)}% bound`, value: lower },
      { statistic: `Feldt upper ${Math.round(options.confidenceLevel * 100)}% bound`, value: upper },
      { statistic: "Items", value: k },
      { statistic: "Respondents", value: n },
    ];
    const itemColumns = [
      { key: "item", label: "Item", type: "string" },
      { key: "mean", label: "Mean", type: "number" },
      { key: "sd", label: "SD", type: "number" },
      { key: "correctedItemTotal", label: "Corrected item-total r", type: "number" },
      { key: "alphaIfDeleted", label: "Alpha if deleted", type: "number" },
      { key: "overallAlpha", label: "Overall alpha", type: "number" },
    ];
    return {
      sample: { n, items: k, completeRows: n },
      estimates: [
        { name: "Cronbach alpha", estimate: alpha, metric: "raw covariance", items: k },
        { name: "standardized alpha", estimate: standardizedAlpha, metric: "mean inter-item correlation" },
        { name: "mean inter-item correlation", estimate: meanCorrelation },
        { name: "item variance sum", estimate: full.itemVariance },
        { name: "total score variance", estimate: full.totalVariance },
      ],
      tests: [],
      confidenceIntervals: [{ parameter: "Cronbach alpha", level: options.confidenceLevel, lower, upper, method: "Feldt (1965) F-distribution interval, df1 = n-1, df2 = (n-1)(k-1)", df1, df2 }],
      effectSizes: [{ name: "Cronbach alpha", estimate: alpha, interpretationBoundary: "internal consistency of one summed scale; not unidimensionality evidence" }],
      assumptions: [
        { name: "tau-equivalence (equal true-score loadings)", status: "not_established", note: "Alpha is a lower bound on reliability unless items are essentially tau-equivalent." },
        { name: "unidimensionality", status: "not_established", note: "Alpha does not test dimensionality; see mcdonald_omega loadings." },
        { name: "complete finite responses", status: "verified" },
        { name: "uncorrelated errors", status: "not_established" },
      ],
      diagnostics: [
        { name: "item-total screen", status: "evaluated", lowestCorrectedItemTotal: Math.min(...itemRows.map((row) => row.correctedItemTotal)), itemsBelow0p3: itemRows.filter((row) => row.correctedItemTotal < 0.3).map((row) => row.item) },
        { name: "alpha-if-deleted screen", status: k >= 3 ? "evaluated" : "not_evaluated", itemsImprovingAlphaWhenDeleted: itemRows.filter((row) => row.alphaIfDeleted !== null && row.alphaIfDeleted > alpha).map((row) => row.item) },
        { name: "Feldt interval boundary", status: "asymptotic", detail: "Assumes multivariate normal items and compound-symmetric covariance; F quantiles solved by bisection on the regularized incomplete beta function." },
      ],
      artifacts: [
        H.tableArtifact(`Item-total statistics: ${parsed.scaleLabel}`, "Item means, standard deviations, corrected item-total correlations, and alpha if the item is deleted.", itemColumns, itemRows, ["Corrected item-total r correlates each item with the sum of the remaining items."], "reliability-item-total-table"),
        H.tableArtifact(`Scale reliability: ${parsed.scaleLabel}`, "Raw and standardized Cronbach alpha with the Feldt confidence interval.", [{ key: "statistic", label: "Statistic", type: "string" }, { key: "value", label: "Value", type: "number" }], summaryRows, [], "reliability-summary-table"),
        H.vegaArtifact("reliability-alpha-if-deleted-plot", `Alpha if item deleted: ${parsed.scaleLabel}`, {
          data: { values: itemRows },
          layer: [
            { mark: { type: "rule", color: "#B24A3B", strokeDash: [4, 3] }, encoding: { x: { field: "overallAlpha", type: "quantitative", title: "Cronbach alpha" } } },
            { mark: { type: "point", filled: true, size: 90 }, encoding: { y: { field: "item", type: "nominal", title: "Item" }, x: { field: "alphaIfDeleted", type: "quantitative" }, tooltip: [{ field: "item" }, { field: "alphaIfDeleted", format: ".4f" }, { field: "correctedItemTotal", format: ".4f" }] } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When several items are summed into one scale score and the researcher must report how internally consistent that summed score is before using it as an outcome or predictor.",
    decision: "Whether the scale is consistent enough to be used as a single score, and whether any item should be reviewed because it lowers consistency or correlates weakly with the rest.",
    mustShow: "Raw and standardized alpha with the Feldt interval, every item's corrected item-total correlation and alpha-if-deleted, item and respondent counts, and the boundary that alpha is not a dimensionality test.",
    userGoal: "Justify the composite score in a methods section and decide whether the item set needs revision before further analysis.",
    nextActions: [
      { trigger: "item-lowers-alpha-or-weak-item-total", action: "review-item-wording-and-prespecify-removal-sensitivity", reason: "Dropping items after seeing alpha is a data-driven decision that must be declared, not silently applied." },
      { trigger: "alpha-acceptable", action: "report-alpha-with-interval-and-run-omega-dimensionality-check", reason: "Alpha assumes tau-equivalence; omega and loadings show whether one factor is defensible." },
      { trigger: "alpha-interval-crosses-threshold", action: "increase-sample-or-items-before-claiming-reliability", reason: "A wide Feldt interval means the consistency claim is not yet supported by the sample size." },
    ],
  },
  fixture: {
    data: {
      scaleLabel: "Satisfaction",
      items: [
        { name: "q1", values: [4, 5, 3, 4, 5, 2, 3, 4, 5, 3, 4, 2] },
        { name: "q2", values: [5, 5, 3, 4, 4, 2, 3, 5, 4, 3, 4, 3] },
        { name: "q3", values: [4, 4, 2, 5, 5, 1, 3, 4, 5, 2, 3, 2] },
        { name: "q4", values: [3, 5, 3, 4, 4, 2, 2, 4, 5, 3, 4, 2] },
        { name: "q5", values: [4, 4, 3, 5, 5, 2, 3, 3, 4, 3, 5, 1] },
      ],
    },
    options: { confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.descriptive-visualization"] },
  coverage: {
    implementedBoundary: "Raw and standardized Cronbach alpha for a complete numeric item matrix (2..64 items, 3..10000 respondents) with the Feldt F-based interval, corrected item-total correlations, and alpha-if-deleted; no missing-data handling and no ordinal (polychoric) alpha.",
    oracle: { level: "external-library-partial", evidence: ["contracts/reliability-scipy-crosscheck.py"], verifiedOutputs: ["raw alpha", "Feldt confidence bounds", "standardized alpha", "corrected item-total correlations", "alpha if deleted"], excludedOutputs: ["ordinal alpha", "missing-data pairwise alpha"] },
    diagnostic: { level: "method-specific-partial", emitted: ["item-total screen", "alpha-if-deleted screen", "Feldt interval boundary"], limitations: ["no dimensionality test", "Feldt interval assumes multivariate normality"] },
    knownGaps: ["polychoric or ordinal alpha", "bootstrap intervals", "stratified alpha"],
  },
};

// ---------------------------------------------------------------------------------------------
// mcdonald_omega
// ---------------------------------------------------------------------------------------------

const mcdonaldOmega = {
  method: "mcdonald_omega",
  family: "reliability",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["tolerance", "timeoutMs"],
  customOptions: {
    factorIterations: {
      schema: { type: "integer", minimum: 10, maximum: 5000 },
      default: 500,
      parse(value, H, path) { return H.integer(value, 10, 5000, path); },
    },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: columnSchema("name", 3),
      subjectLabels: subjectLabelsSchema,
      scaleLabel: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["items", "subjectLabels", "scaleLabel"], "data");
    const matrix = parseNumericColumns(data.items, "data.items", "name", "Item", H, { minColumns: 3, minRows: 2 });
    if (matrix.n < 4) H.fail("STAT_INSUFFICIENT_SAMPLE", "mcdonald_omega requires at least four respondents");
    matrix.columns.forEach((column, index) => {
      if (!(H.variance(column) > 0)) H.fail("STAT_DEGENERATE", `item ${matrix.names[index]} is constant`);
    });
    return { ...matrix, subjectLabels: parseSubjectLabels(data.subjectLabels, matrix.n, H), scaleLabel: H.label(data.scaleLabel, "Scale", "data.scaleLabel") };
  },
  analyze(parsed, options, budget, H) {
    const { names, columns, n } = parsed;
    const k = columns.length;
    const R = correlationMatrix(columns, H, budget);
    const sds = columns.map((column) => Math.sqrt(H.variance(column, true, budget)));
    // Principal-axis iteration (fixed point of the one-factor unweighted least squares problem).
    let communalities = R.map((row, index) => Math.max(...row.map((value, column) => (column === index ? 0 : Math.abs(value)))));
    let loadings = null;
    let iterations = 0;
    let converged = false;
    let maxChange = null;
    for (; iterations < options.factorIterations; iterations += 1) {
      budget.check();
      const reduced = R.map((row, index) => row.map((value, column) => (column === index ? communalities[index] : value)));
      const first = leadingEigenpair(reduced, budget, H);
      if (!(first.value > 0)) H.fail("STAT_DEGENERATE", "reduced correlation matrix has no positive leading eigenvalue");
      loadings = first.vector.map((value) => value * Math.sqrt(first.value));
      const next = loadings.map((value) => value * value);
      maxChange = Math.max(...next.map((value, index) => Math.abs(value - communalities[index])));
      communalities = next;
      if (next.some((value) => value >= 1)) H.fail("STAT_DEGENERATE", "Heywood case: an item communality reached one under the one-factor model");
      if (maxChange < options.tolerance) {
        converged = true;
        iterations += 1;
        break;
      }
    }
    if (!converged) H.fail("STAT_NON_CONVERGENCE", `one-factor principal-axis iteration did not converge within ${options.factorIterations} iterations`);
    // Orient so that the loading sum is positive (sign of a factor is arbitrary).
    const loadingSum = loadings.reduce((total, value) => total + value, 0);
    if (loadingSum < 0) loadings = loadings.map((value) => -value);
    const sumLoadings = Math.abs(loadingSum);
    const uniquenesses = loadings.map((value) => 1 - value * value);
    const sumUniqueness = uniquenesses.reduce((total, value) => total + value, 0);
    const omegaModelImplied = (sumLoadings ** 2) / (sumLoadings ** 2 + sumUniqueness);
    let correlationTotal = 0;
    for (const row of R) for (const value of row) correlationTotal += value;
    const omegaObservedDenominator = 1 - sumUniqueness / correlationTotal;
    const rawLoadings = loadings.map((value, index) => value * sds[index]);
    const totals = columns[0].map((_, row) => columns.reduce((total, column) => total + column[row], 0));
    const totalVariance = H.variance(totals, true, budget);
    if (!(totalVariance > 0)) H.fail("STAT_DEGENERATE", "total score variance must be positive");
    const rawSum = rawLoadings.reduce((total, value) => total + value, 0);
    const omegaCovarianceMetric = (rawSum ** 2) / totalVariance;
    let residualSumSquares = 0;
    for (let row = 0; row < k; row += 1) {
      for (let column = row + 1; column < k; column += 1) residualSumSquares += (R[row][column] - loadings[row] * loadings[column]) ** 2;
    }
    const rmsr = Math.sqrt((2 * residualSumSquares) / (k * (k - 1)));
    for (const value of [omegaModelImplied, omegaObservedDenominator, omegaCovarianceMetric, rmsr]) finiteOrFail(value, "omega output is not finite", H);
    const loadingRows = loadings.map((value, index) => ({ item: names[index], loading: value, rawLoading: rawLoadings[index], communality: value * value, uniqueness: uniquenesses[index], sd: sds[index] }));
    const summaryRows = [
      { statistic: "omega total (model-implied denominator)", value: omegaModelImplied },
      { statistic: "omega total (observed correlation-sum denominator)", value: omegaObservedDenominator },
      { statistic: "omega total (raw covariance metric)", value: omegaCovarianceMetric },
      { statistic: "sum of standardized loadings", value: sumLoadings },
      { statistic: "sum of uniquenesses", value: sumUniqueness },
      { statistic: "root mean square off-diagonal residual", value: rmsr },
      { statistic: "iterations", value: iterations },
    ];
    return {
      sample: { n, items: k, completeRows: n },
      estimates: [
        { name: "McDonald omega total", estimate: omegaModelImplied, denominator: "model-implied (sum loadings)^2 + sum uniqueness", metric: "correlation" },
        { name: "McDonald omega total (observed denominator)", estimate: omegaObservedDenominator, denominator: "sum of the observed correlation matrix", metric: "correlation" },
        { name: "McDonald omega total (covariance metric)", estimate: omegaCovarianceMetric, denominator: "observed total score variance", metric: "covariance" },
        { name: "standardized loadings", estimate: loadings.length, loadings: loadingRows.map((row) => ({ item: row.item, loading: row.loading })) },
      ],
      tests: [],
      confidenceIntervals: [],
      effectSizes: [{ name: "omega total", estimate: omegaModelImplied, interpretationBoundary: "reliability of the summed score under a single common factor" }],
      assumptions: [
        { name: "single common factor", status: "not_established", note: "Omega total here is the one-factor (congeneric) form; a bifactor or hierarchical omega is not computed." },
        { name: "no Heywood case", status: "verified", maxCommunality: Math.max(...communalities) },
        { name: "complete finite responses", status: "verified" },
      ],
      diagnostics: [
        { name: "one-factor fit", status: "converged", algorithm: "principal-axis iteration on the correlation matrix (fixed point of one-factor unweighted least squares)", iterations, maxCommunalityChange: maxChange, tolerance: options.tolerance },
        { name: "off-diagonal residual screen", status: "evaluated", rmsr, boundary: "descriptive fit only; no chi-square or RMSEA is computed" },
        { name: "loading screen", status: "evaluated", itemsBelow0p4: loadingRows.filter((row) => row.loading < 0.4).map((row) => row.item) },
      ],
      artifacts: [
        H.tableArtifact(`One-factor loadings: ${parsed.scaleLabel}`, "Standardized and raw-metric loadings, communalities, and uniquenesses from the one-factor fit.", [
          { key: "item", label: "Item", type: "string" },
          { key: "loading", label: "Standardized loading", type: "number" },
          { key: "rawLoading", label: "Raw loading", type: "number" },
          { key: "communality", label: "Communality", type: "number" },
          { key: "uniqueness", label: "Uniqueness", type: "number" },
          { key: "sd", label: "Item SD", type: "number" },
        ], loadingRows, [], "reliability-omega-loading-table"),
        H.tableArtifact(`McDonald omega: ${parsed.scaleLabel}`, "Omega total under the three common denominators plus fit descriptors.", [{ key: "statistic", label: "Statistic", type: "string" }, { key: "value", label: "Value", type: "number" }], summaryRows, ["The model-implied form is McDonald's definition; the observed-denominator form matches software that divides by the sum of the observed correlation matrix."], "reliability-omega-summary-table"),
        H.vegaArtifact("reliability-omega-loading-plot", `Standardized one-factor loadings: ${parsed.scaleLabel}`, {
          data: { values: loadingRows },
          mark: { type: "bar" },
          encoding: {
            y: { field: "item", type: "nominal", title: "Item" },
            x: { field: "loading", type: "quantitative", title: "Standardized loading", scale: { domain: [-1, 1] } },
            tooltip: [{ field: "item" }, { field: "loading", format: ".4f" }, { field: "communality", format: ".4f" }],
          },
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When a summed scale is claimed to measure one construct and alpha's equal-loading assumption is doubtful, so reliability must be computed from estimated factor loadings instead.",
    decision: "Whether one common factor accounts for the items well enough that the summed score is a reliable measure, and which items load weakly on that factor.",
    mustShow: "Every standardized loading, communality and uniqueness, omega total under each denominator convention, the residual fit descriptor, convergence details, and the boundary that hierarchical omega is not computed.",
    userGoal: "Report a loading-based reliability coefficient and justify or revise the item set before using the composite score.",
    nextActions: [
      { trigger: "weak-or-negative-loading", action: "review-item-content-and-consider-reverse-coding-or-removal-plan", reason: "A loading near zero means the item does not share the common factor and dilutes the composite." },
      { trigger: "large-off-diagonal-residuals", action: "run-multi-factor-exploratory-analysis-before-reporting-omega", reason: "Poor one-factor fit means omega total for a single factor is not the right reliability model." },
      { trigger: "omega-and-alpha-agree", action: "report-omega-with-loadings-table-and-bind-figure", reason: "Agreement between alpha and omega supports the tau-equivalent simplification for the manuscript." },
    ],
  },
  fixture: {
    data: {
      scaleLabel: "Engagement",
      items: [
        { name: "e1", values: [2, 2, 2, 2, 3, 3, 3, 4, 2, 3, 3, 3, 3, 1, 3, 4, 2, 3, 1, 3] },
        { name: "e2", values: [3, 3, 2, 2, 2, 2, 3, 3, 2, 3, 3, 3, 4, 1, 3, 4, 2, 1, 2, 3] },
        { name: "e3", values: [2, 3, 3, 2, 3, 2, 4, 4, 3, 2, 4, 4, 3, 2, 3, 3, 3, 2, 1, 2] },
        { name: "e4", values: [3, 3, 2, 3, 3, 3, 3, 4, 1, 2, 3, 4, 3, 2, 3, 3, 2, 3, 3, 2] },
        { name: "e5", values: [3, 2, 3, 2, 2, 2, 3, 4, 2, 2, 3, 3, 2, 3, 3, 3, 2, 1, 2, 2] },
        { name: "e6", values: [3, 3, 3, 2, 4, 3, 3, 5, 3, 4, 3, 4, 3, 4, 3, 3, 2, 3, 1, 2] },
      ],
    },
    options: { tolerance: 1e-10 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.dimensionality-reduction-feature-extraction", "matlab.stats.descriptive-visualization"] },
  coverage: {
    implementedBoundary: "Single-factor McDonald omega total from principal-axis iterated one-factor loadings on the Pearson correlation matrix (3..64 items, 4..10000 respondents); reports model-implied, observed-denominator, and covariance-metric forms. No hierarchical or bifactor omega, no maximum-likelihood factor fit, and no confidence interval.",
    oracle: { level: "external-library-partial", evidence: ["contracts/reliability-scipy-crosscheck.py"], verifiedOutputs: ["standardized loadings (against a scipy minimize unweighted least squares one-factor fit)", "omega total model-implied", "omega total observed denominator"], excludedOutputs: ["hierarchical omega", "omega confidence interval", "maximum-likelihood loadings"] },
    diagnostic: { level: "method-specific-partial", emitted: ["one-factor fit", "off-diagonal residual screen", "loading screen"], limitations: ["no chi-square fit test", "single-factor only"] },
    knownGaps: ["hierarchical and bifactor omega", "polychoric correlations", "bootstrap or delta-method interval"],
  },
};

// ---------------------------------------------------------------------------------------------
// intraclass_correlation
// ---------------------------------------------------------------------------------------------

const intraclassCorrelation = {
  method: "intraclass_correlation",
  family: "reliability",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["ratings"],
    properties: {
      ratings: columnSchema("rater", 2),
      subjectLabels: subjectLabelsSchema,
      outcomeLabel: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["ratings", "subjectLabels", "outcomeLabel"], "data");
    const matrix = parseNumericColumns(data.ratings, "data.ratings", "rater", "Rater", H, { minColumns: 2, minRows: 2 });
    if (matrix.n < 3) H.fail("STAT_INSUFFICIENT_SAMPLE", "intraclass_correlation requires at least three targets");
    return { ...matrix, subjectLabels: parseSubjectLabels(data.subjectLabels, matrix.n, H), outcomeLabel: H.label(data.outcomeLabel, "Rating", "data.outcomeLabel") };
  },
  analyze(parsed, options, budget, H) {
    const { names, columns, n } = parsed;
    const k = columns.length;
    const grand = H.mean(columns.flat(), budget);
    const rowMeans = Array.from({ length: n }, (_, row) => columns.reduce((total, column) => total + column[row], 0) / k);
    const columnMeans = columns.map((column) => H.mean(column, budget));
    let ssRows = 0;
    let ssColumns = 0;
    let ssError = 0;
    let ssTotal = 0;
    for (let row = 0; row < n; row += 1) {
      ssRows += k * (rowMeans[row] - grand) ** 2;
      for (let column = 0; column < k; column += 1) {
        budget.check();
        const value = columns[column][row];
        ssTotal += (value - grand) ** 2;
        ssError += (value - rowMeans[row] - columnMeans[column] + grand) ** 2;
      }
    }
    for (let column = 0; column < k; column += 1) ssColumns += n * (columnMeans[column] - grand) ** 2;
    const dfRows = n - 1;
    const dfColumns = k - 1;
    const dfError = (n - 1) * (k - 1);
    const dfWithin = n * (k - 1);
    const msb = ssRows / dfRows;
    const msj = ssColumns / dfColumns;
    const mse = ssError / dfError;
    const msw = (ssColumns + ssError) / dfWithin;
    if (!(msb > 0)) H.fail("STAT_DEGENERATE", "between-target mean square must be positive");
    if (!(mse > 0) || !(msw > 0)) H.fail("STAT_DEGENERATE", "residual mean square is zero (perfect agreement leaves no error variance for inference)");
    const icc1 = (msb - msw) / (msb + (k - 1) * msw);
    const icc2 = (msb - mse) / (msb + (k - 1) * mse + (k * (msj - mse)) / n);
    const icc3 = (msb - mse) / (msb + (k - 1) * mse);
    const icc1k = (msb - msw) / msb;
    const icc2k = (msb - mse) / (msb + (msj - mse) / n);
    const icc3k = (msb - mse) / msb;
    const f1 = msb / msw;
    const f2 = msb / mse;
    const p1 = H.pFromF(f1, dfRows, dfWithin);
    const p2 = H.pFromF(f2, dfRows, dfError);
    const a = 1 - options.confidenceLevel;
    const q = 1 - a / 2;
    const f1l = f1 / fQuantile(q, dfRows, dfWithin, H);
    const f1u = f1 * fQuantile(q, dfWithin, dfRows, H);
    const l1 = (f1l - 1) / (f1l + (k - 1));
    const u1 = (f1u - 1) / (f1u + (k - 1));
    const f3l = f2 / fQuantile(q, dfRows, dfError, H);
    const f3u = f2 * fQuantile(q, dfError, dfRows, H);
    const l3 = (f3l - 1) / (f3l + (k - 1));
    const u3 = (f3u - 1) / (f3u + (k - 1));
    const fj = msj / mse;
    const vn = dfError * (k * icc2 * fj + n * (1 + (k - 1) * icc2) - k * icc2) ** 2;
    const vd = dfRows * k * k * icc2 * icc2 * fj * fj + (n * (1 + (k - 1) * icc2) - k * icc2) ** 2;
    const v = vn / vd;
    if (!(v > 0) || !Number.isFinite(v)) H.fail("STAT_DEGENERATE", "ICC(2) Satterthwaite degrees of freedom are not positive");
    const f2u = fQuantile(q, n - 1, v, H);
    const f2l = fQuantile(q, v, n - 1, H);
    const l2 = (n * (msb - f2u * mse)) / (f2u * (k * msj + (k * n - k - n) * mse) + n * msb);
    const u2 = (n * (f2l * msb - mse)) / (k * msj + (k * n - k - n) * mse + n * f2l * msb);
    const l2k = (l2 * k) / (1 + l2 * (k - 1));
    const u2k = (u2 * k) / (1 + u2 * (k - 1));
    const forms = [
      { form: "ICC(1,1)", description: "one-way random, single rater", icc: icc1, f: f1, df1: dfRows, df2: dfWithin, pValue: p1, lower: l1, upper: u1 },
      { form: "ICC(2,1)", description: "two-way random, single rater, absolute agreement", icc: icc2, f: f2, df1: dfRows, df2: dfError, pValue: p2, lower: l2, upper: u2 },
      { form: "ICC(3,1)", description: "two-way mixed, single rater, consistency", icc: icc3, f: f2, df1: dfRows, df2: dfError, pValue: p2, lower: l3, upper: u3 },
      { form: "ICC(1,k)", description: "one-way random, average of k raters", icc: icc1k, f: f1, df1: dfRows, df2: dfWithin, pValue: p1, lower: 1 - 1 / f1l, upper: 1 - 1 / f1u },
      { form: "ICC(2,k)", description: "two-way random, average of k raters, absolute agreement", icc: icc2k, f: f2, df1: dfRows, df2: dfError, pValue: p2, lower: l2k, upper: u2k },
      { form: "ICC(3,k)", description: "two-way mixed, average of k raters, consistency", icc: icc3k, f: f2, df1: dfRows, df2: dfError, pValue: p2, lower: 1 - 1 / f3l, upper: 1 - 1 / f3u },
    ];
    for (const row of forms) for (const key of ["icc", "f", "pValue", "lower", "upper"]) finiteOrFail(row[key], `${row.form} ${key} is not finite`, H);
    const anovaRows = [
      { source: "Targets (between)", ss: ssRows, df: dfRows, ms: msb },
      { source: "Raters", ss: ssColumns, df: dfColumns, ms: msj },
      { source: "Residual", ss: ssError, df: dfError, ms: mse },
      { source: "Within targets (raters + residual)", ss: ssColumns + ssError, df: dfWithin, ms: msw },
      { source: "Total", ss: ssTotal, df: n * k - 1, ms: ssTotal / (n * k - 1) },
    ];
    const level = options.confidenceLevel;
    return {
      sample: { n, raters: k, completeRows: n },
      estimates: forms.map((row) => ({ name: row.form, estimate: row.icc, description: row.description })),
      tests: [
        { name: "one-way ANOVA F for target effect (ICC1 forms)", statistic: f1, distribution: "F", df1: dfRows, df2: dfWithin, pValue: p1 },
        { name: "two-way ANOVA F for target effect (ICC2 and ICC3 forms)", statistic: f2, distribution: "F", df1: dfRows, df2: dfError, pValue: p2 },
      ],
      confidenceIntervals: forms.map((row) => ({ parameter: row.form, level, lower: row.lower, upper: row.upper, method: row.form.startsWith("ICC(2") ? "Shrout-Fleiss with Satterthwaite degrees of freedom" : "exact F interval (Shrout-Fleiss / McGraw-Wong)" })),
      effectSizes: [{ name: "ICC(2,1)", estimate: icc2, interpretationBoundary: "absolute agreement of a single randomly chosen rater" }],
      assumptions: [
        { name: "targets are a random sample", status: "not_established" },
        { name: "raters random (ICC2) or fixed (ICC3)", status: "requires_design_review", note: "The correct form depends on whether the same raters would be used in future studies." },
        { name: "normal residuals with equal variance", status: "not_established" },
        { name: "complete crossed design", status: "verified" },
      ],
      diagnostics: [
        { name: "rater mean differences", status: msj > mse ? "rater effect present" : "no rater effect beyond residual", raterMeanSquare: msj, residualMeanSquare: mse },
        { name: "ICC(2) interval boundary", status: "asymptotic", satterthwaiteDf: v, detail: "Two-way random absolute-agreement bounds use the Shrout-Fleiss approximation." },
        { name: "form selection boundary", status: "requires_design_review", detail: "ICC(1) ignores rater identity; ICC(2) treats raters as random; ICC(3) treats raters as fixed." },
      ],
      artifacts: [
        H.tableArtifact(`Intraclass correlation forms: ${parsed.outcomeLabel}`, "Six Shrout-Fleiss / McGraw-Wong forms with F tests and confidence bounds.", [
          { key: "form", label: "Form", type: "string" },
          { key: "description", label: "Model", type: "string" },
          { key: "icc", label: "ICC", type: "number" },
          { key: "f", label: "F", type: "number" },
          { key: "df1", label: "df1", type: "number" },
          { key: "df2", label: "df2", type: "number" },
          { key: "pValue", label: "p", type: "number" },
          { key: "lower", label: `Lower ${Math.round(level * 100)}%`, type: "number" },
          { key: "upper", label: `Upper ${Math.round(level * 100)}%`, type: "number" },
        ], forms, ["ICC(2,k) bounds are transformed from the single-rater ICC(2,1) bounds."], "reliability-icc-table"),
        H.tableArtifact("Two-way ANOVA for ratings", "Sums of squares underlying every ICC form.", [{ key: "source", label: "Source", type: "string" }, { key: "ss", label: "SS", type: "number" }, { key: "df", label: "df", type: "number" }, { key: "ms", label: "MS", type: "number" }], anovaRows, [], "reliability-icc-anova-table"),
        H.vegaArtifact("reliability-icc-plot", `ICC forms with ${Math.round(level * 100)}% confidence bounds`, {
          data: { values: forms },
          layer: [
            { mark: { type: "rule", strokeWidth: 2 }, encoding: { y: { field: "form", type: "nominal", title: "Form" }, x: { field: "lower", type: "quantitative", title: "ICC" }, x2: { field: "upper" } } },
            { mark: { type: "point", filled: true, size: 90 }, encoding: { y: { field: "form", type: "nominal" }, x: { field: "icc", type: "quantitative" }, tooltip: [{ field: "form" }, { field: "icc", format: ".4f" }, { field: "lower", format: ".4f" }, { field: "upper", format: ".4f" }] } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When several raters or repeated measurements score the same targets and the researcher must quantify how much of the score variance is attributable to the targets rather than raters or noise.",
    decision: "Which ICC form matches the design (random or fixed raters, single or averaged scores, agreement or consistency) and whether the reliability is adequate for the intended use.",
    mustShow: "All six forms with their model descriptions, F tests, and confidence bounds, the underlying ANOVA table, rater and target counts, and the boundary that form choice is a design decision.",
    userGoal: "Report inter-rater or test-retest reliability with the correct model and defend the choice in a methods section.",
    nextActions: [
      { trigger: "form-not-prespecified", action: "declare-rater-sampling-model-before-reporting-a-single-icc", reason: "Reporting the largest ICC after seeing all six forms is selective reporting." },
      { trigger: "rater-effect-present", action: "inspect-rater-means-and-plan-calibration-or-training", reason: "Systematic rater differences lower absolute agreement even when consistency is high." },
      { trigger: "icc-interval-wide", action: "increase-targets-before-claiming-reliability-level", reason: "ICC precision depends mostly on the number of targets, not raters." },
    ],
  },
  fixture: {
    data: {
      outcomeLabel: "Wine rating",
      ratings: [
        { rater: "judge A", values: [1, 1, 3, 6, 6, 7, 8, 9, 5, 4] },
        { rater: "judge B", values: [2, 3, 8, 4, 5, 5, 7, 9, 4, 3] },
        { rater: "judge C", values: [0, 3, 1, 5, 6, 5, 6, 8, 6, 2] },
        { rater: "judge D", values: [1, 2, 4, 5, 6, 6, 7, 9, 5, 2] },
      ],
    },
    options: { confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.anova", "matlab.stats.descriptive-visualization"] },
  coverage: {
    implementedBoundary: "Six Shrout-Fleiss / McGraw-Wong ICC forms from a complete crossed targets-by-raters numeric matrix (2..64 raters, 3..10000 targets) with F tests and F-based confidence bounds; no missing cells, no mixed-model estimation, no unbalanced designs.",
    oracle: { level: "external-library-partial", evidence: ["contracts/reliability-scipy-crosscheck.py"], verifiedOutputs: ["ICC(1,1)", "ICC(2,1)", "ICC(3,1)", "ICC(1,k)", "ICC(2,k)", "ICC(3,k)", "F statistics", "degrees of freedom", "p values", "95% confidence bounds"], excludedOutputs: ["unbalanced designs", "confidence bounds at levels other than the fixture level are computed but not oracle-checked"] },
    diagnostic: { level: "method-specific-partial", emitted: ["rater mean differences", "ICC(2) interval boundary", "form selection boundary"], limitations: ["no residual normality test", "no missing-data support"] },
    knownGaps: ["unbalanced or missing ratings", "mixed-model (REML) ICC", "ICC for binary outcomes"],
  },
};

// ---------------------------------------------------------------------------------------------
// cohen_kappa
// ---------------------------------------------------------------------------------------------

function parseCategoricalPair(rawA, rawB, rawCategories, H) {
  const check = (raw, path) => {
    if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_ROWS) H.fail("STAT_INVALID_INPUT", `${path} must contain between 2 and ${MAX_ROWS} labels`);
    return raw.map((item, index) => {
      if (typeof item === "number") {
        if (!Number.isSafeInteger(item)) H.fail("STAT_INVALID_INPUT", `${path}[${index}] must be an integer or string category`);
        return item;
      }
      if (typeof item !== "string" || !item.trim() || item.trim().length > 128 || /[\u0000-\u001f]/u.test(item)) {
        H.fail("STAT_INVALID_INPUT", `${path}[${index}] must be an integer or non-empty string category`);
      }
      return item.trim();
    });
  };
  const a = check(rawA, "data.rater1");
  const b = check(rawB, "data.rater2");
  if (a.length !== b.length) H.fail("STAT_INVALID_INPUT", "data.rater1 and data.rater2 must have the same length");
  const all = [...a, ...b];
  const numeric = all.every((item) => typeof item === "number");
  const textual = all.every((item) => typeof item === "string");
  if (!numeric && !textual) H.fail("STAT_INVALID_INPUT", "category labels must be all integers or all strings");
  let categories;
  if (rawCategories === undefined) {
    categories = [...new Set(all)].sort((left, right) => (numeric ? left - right : left.localeCompare(right, "en")));
  } else {
    categories = check(rawCategories, "data.categories");
    if (new Set(categories).size !== categories.length) H.fail("STAT_INVALID_INPUT", "data.categories must be unique");
    if (categories.some((item) => typeof item !== typeof all[0])) H.fail("STAT_INVALID_INPUT", "data.categories must have the same label type as the ratings");
    const known = new Set(categories);
    if (all.some((item) => !known.has(item))) H.fail("STAT_INVALID_INPUT", "every rating must be listed in data.categories");
  }
  if (categories.length < 2) H.fail("STAT_DEGENERATE", "kappa requires at least two categories");
  if (categories.length > 64) H.fail("STAT_LIMIT_EXCEEDED", "kappa supports at most 64 categories");
  return { a, b, categories, n: a.length };
}

const cohenKappa = {
  method: "cohen_kappa",
  family: "agreement",
  analysisModel: { families: ["glm"], distributions: [null, "multinomial", "binomial"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    weights: {
      schema: { type: "string", enum: ["none", "linear", "quadratic"] },
      default: "none",
      parse(value, H, path) {
        if (!["none", "linear", "quadratic"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be none, linear, or quadratic`);
        return value;
      },
    },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["rater1", "rater2"],
    properties: {
      rater1: { type: "array", minItems: 2, maxItems: MAX_ROWS, items: { type: ["string", "integer"] } },
      rater2: { type: "array", minItems: 2, maxItems: MAX_ROWS, items: { type: ["string", "integer"] } },
      categories: { type: "array", minItems: 2, maxItems: 64, items: { type: ["string", "integer"] } },
      rater1Label: { type: "string", minLength: 1, maxLength: 128 },
      rater2Label: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["rater1", "rater2", "categories", "rater1Label", "rater2Label"], "data");
    const pair = parseCategoricalPair(data.rater1, data.rater2, data.categories, H);
    return { ...pair, rater1Label: H.label(data.rater1Label, "Rater 1", "data.rater1Label"), rater2Label: H.label(data.rater2Label, "Rater 2", "data.rater2Label") };
  },
  analyze(parsed, options, budget, H) {
    const { a, b, categories, n } = parsed;
    const k = categories.length;
    const index = new Map(categories.map((category, position) => [category, position]));
    const counts = Array.from({ length: k }, () => Array(k).fill(0));
    for (let row = 0; row < n; row += 1) {
      budget.check();
      counts[index.get(a[row])][index.get(b[row])] += 1;
    }
    const weight = (i, j) => {
      if (options.weights === "linear") return 1 - Math.abs(i - j) / (k - 1);
      if (options.weights === "quadratic") return 1 - ((i - j) ** 2) / ((k - 1) ** 2);
      return i === j ? 1 : 0;
    };
    const rowMargin = counts.map((row) => row.reduce((total, value) => total + value, 0) / n);
    const columnMargin = categories.map((_, column) => counts.reduce((total, row) => total + row[column], 0) / n);
    let po = 0;
    let pe = 0;
    for (let i = 0; i < k; i += 1) {
      for (let j = 0; j < k; j += 1) {
        const w = weight(i, j);
        po += w * counts[i][j] / n;
        pe += w * rowMargin[i] * columnMargin[j];
      }
    }
    if (!(1 - pe > 1e-12)) H.fail("STAT_DEGENERATE", "expected agreement is one; kappa is undefined");
    const kappa = (po - pe) / (1 - pe);
    const wRow = categories.map((_, i) => categories.reduce((total, __, j) => total + columnMargin[j] * weight(i, j), 0));
    const wColumn = categories.map((_, j) => categories.reduce((total, __, i) => total + rowMargin[i] * weight(i, j), 0));
    let varianceSum = 0;
    let nullSum = 0;
    for (let i = 0; i < k; i += 1) {
      for (let j = 0; j < k; j += 1) {
        const w = weight(i, j);
        const pij = counts[i][j] / n;
        varianceSum += pij * (w * (1 - pe) - (wRow[i] + wColumn[j]) * (1 - po)) ** 2;
        nullSum += rowMargin[i] * columnMargin[j] * (w - (wRow[i] + wColumn[j])) ** 2;
      }
    }
    const variance = (varianceSum - (po * pe - 2 * pe + po) ** 2) / (n * (1 - pe) ** 4);
    const nullVariance = (nullSum - pe * pe) / (n * (1 - pe) ** 2);
    const se = Math.sqrt(Math.max(0, variance));
    const se0 = Math.sqrt(Math.max(0, nullVariance));
    if (!(se0 > 0)) H.fail("STAT_DEGENERATE", "null standard error of kappa is zero");
    const z = kappa / se0;
    const pValue = twoSidedNormalP(z, H);
    const zCritical = H.normalInv(0.5 + options.confidenceLevel / 2);
    const lower = kappa - zCritical * se;
    const upper = kappa + zCritical * se;
    for (const value of [kappa, se, z, pValue, lower, upper]) finiteOrFail(value, "kappa output is not finite", H);
    const cellRows = [];
    for (let i = 0; i < k; i += 1) {
      for (let j = 0; j < k; j += 1) {
        cellRows.push({ rater1: String(categories[i]), rater2: String(categories[j]), count: counts[i][j], proportion: counts[i][j] / n, expected: rowMargin[i] * columnMargin[j] * n, weight: weight(i, j) });
      }
    }
    const maximumKappa = (() => {
      // Maximum attainable kappa given the marginals (unweighted: sum of min marginals).
      if (options.weights !== "none") return null;
      const poMax = categories.reduce((total, _, i) => total + Math.min(rowMargin[i], columnMargin[i]), 0);
      return (poMax - pe) / (1 - pe);
    })();
    return {
      sample: { n, categories: k, completeRows: n },
      estimates: [
        { name: "Cohen kappa", estimate: kappa, weights: options.weights, standardError: se, nullStandardError: se0 },
        { name: "observed agreement", estimate: po, weighted: options.weights !== "none" },
        { name: "expected agreement", estimate: pe, weighted: options.weights !== "none" },
        ...(maximumKappa === null ? [] : [{ name: "maximum attainable kappa given marginals", estimate: maximumKappa }]),
      ],
      tests: [{ name: "kappa = 0 (z under the null)", statistic: z, distribution: "normal", pValue, standardError: se0 }],
      confidenceIntervals: [{ parameter: "Cohen kappa", level: options.confidenceLevel, lower, upper, method: "Wald interval with the Fleiss-Cohen-Everitt (1969) asymptotic standard error" }],
      effectSizes: [{ name: "Cohen kappa", estimate: kappa, interpretationBoundary: "chance-corrected agreement between two fixed raters; benchmark labels are convention, not inference" }],
      assumptions: [
        { name: "two fixed raters classify the same units independently", status: "assumed" },
        { name: "categories exhaustive and mutually exclusive", status: "verified" },
        { name: "ordinal category order (weighted kappa)", status: options.weights === "none" ? "not_applicable" : "assumed_from_category_order" },
        { name: "large-sample normal approximation", status: "asymptotic" },
      ],
      diagnostics: [
        { name: "marginal homogeneity screen", status: "evaluated", maxMarginalDifference: Math.max(...categories.map((_, i) => Math.abs(rowMargin[i] - columnMargin[i]))), boundary: "large marginal differences bound kappa below one (prevalence and bias effects)" },
        { name: "sparse cells", status: cellRows.filter((row) => row.count === 0).length ? "empty cells present" : "no empty cells", emptyCells: cellRows.filter((row) => row.count === 0).length },
        { name: "standard error boundary", status: "asymptotic", detail: "Wald interval may exceed [-1, 1] for small samples; no exact or bootstrap interval is computed." },
      ],
      artifacts: [
        H.tableArtifact(`Agreement table: ${parsed.rater1Label} vs ${parsed.rater2Label}`, "Cross-classification counts, expected counts under independence, and the agreement weight of each cell.", [
          { key: "rater1", label: parsed.rater1Label, type: "string" },
          { key: "rater2", label: parsed.rater2Label, type: "string" },
          { key: "count", label: "Count", type: "number" },
          { key: "proportion", label: "Proportion", type: "number" },
          { key: "expected", label: "Expected count", type: "number" },
          { key: "weight", label: "Agreement weight", type: "number" },
        ], cellRows, [`Weights: ${options.weights}.`], "agreement-crosstab-table"),
        H.tableArtifact("Cohen kappa", "Kappa, standard errors, z test, and confidence bounds.", [{ key: "statistic", label: "Statistic", type: "string" }, { key: "value", label: "Value", type: "number" }], [
          { statistic: `kappa (${options.weights})`, value: kappa },
          { statistic: "observed agreement", value: po },
          { statistic: "expected agreement", value: pe },
          { statistic: "SE", value: se },
          { statistic: "SE under H0", value: se0 },
          { statistic: "z", value: z },
          { statistic: "p", value: pValue },
          { statistic: `lower ${Math.round(options.confidenceLevel * 100)}%`, value: lower },
          { statistic: `upper ${Math.round(options.confidenceLevel * 100)}%`, value: upper },
        ], [], "agreement-kappa-table"),
        H.vegaArtifact("agreement-heatmap", `Agreement heatmap: ${parsed.rater1Label} vs ${parsed.rater2Label}`, {
          data: { values: cellRows },
          layer: [
            { mark: { type: "rect" }, encoding: { x: { field: "rater2", type: "nominal", title: parsed.rater2Label }, y: { field: "rater1", type: "nominal", title: parsed.rater1Label }, color: { field: "count", type: "quantitative", title: "Count", scale: { scheme: "blues" } }, tooltip: [{ field: "rater1" }, { field: "rater2" }, { field: "count" }, { field: "expected", format: ".3f" }] } },
            { mark: { type: "text" }, encoding: { x: { field: "rater2", type: "nominal" }, y: { field: "rater1", type: "nominal" }, text: { field: "count", type: "quantitative" } } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When two raters, instruments, or coders assign the same units to nominal or ordinal categories and agreement must be corrected for the agreement expected by chance.",
    decision: "Whether the two raters agree beyond chance strongly enough for one rater's classifications to stand in for the other, and whether disagreement concentrates in particular categories.",
    mustShow: "The full cross-classification with expected counts and weights, kappa with standard error and confidence bounds, observed and expected agreement, the weighting scheme, and marginal-homogeneity diagnostics.",
    userGoal: "Report inter-rater agreement for a coding scheme and locate the categories that need clearer definitions.",
    nextActions: [
      { trigger: "disagreement-concentrated-in-cells", action: "open-disagreeing-units-and-refine-coding-manual", reason: "Kappa alone hides which category boundaries the raters interpret differently." },
      { trigger: "marginals-differ-materially", action: "report-prevalence-and-bias-adjusted-context-with-kappa", reason: "Unequal marginals cap kappa and can make moderate agreement look poor." },
      { trigger: "ordinal-categories", action: "prespecify-linear-or-quadratic-weights-before-reporting", reason: "Weighted and unweighted kappa answer different questions and must not be chosen after the fact." },
    ],
  },
  fixture: {
    data: {
      rater1Label: "Pathologist 1",
      rater2Label: "Pathologist 2",
      rater1: ["low", "low", "mid", "high", "mid", "low", "high", "high", "mid", "low", "mid", "high", "low", "mid", "high", "mid"],
      rater2: ["low", "mid", "mid", "high", "mid", "low", "high", "mid", "mid", "low", "low", "high", "low", "mid", "high", "high"],
      categories: ["low", "mid", "high"],
    },
    options: { weights: "none", confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.descriptive-visualization"] },
  coverage: {
    implementedBoundary: "Two-rater Cohen kappa (unweighted, linear, quadratic agreement weights) for 2..64 categories with the Fleiss-Cohen-Everitt asymptotic standard error, null standard error z test, and Wald interval; no missing ratings, no more than two raters, no bootstrap interval.",
    oracle: { level: "external-library-partial", evidence: ["contracts/reliability-scipy-crosscheck.py"], verifiedOutputs: ["unweighted kappa", "linear weighted kappa", "quadratic weighted kappa", "observed and expected agreement", "asymptotic standard error (numpy first principles)"], excludedOutputs: ["bootstrap interval", "exact p value"] },
    diagnostic: { level: "method-specific-partial", emitted: ["marginal homogeneity screen", "sparse cells", "standard error boundary"], limitations: ["Wald interval not truncated", "no McNemar/Bowker symmetry test"] },
    knownGaps: ["more than two raters (use fleiss_kappa or krippendorff_alpha)", "exact or bootstrap intervals", "custom weight matrices"],
  },
};

// ---------------------------------------------------------------------------------------------
// fleiss_kappa
// ---------------------------------------------------------------------------------------------

function parseRatingLabelsColumns(raw, path, H, { allowNull = false, minColumns = 2 } = {}) {
  if (!Array.isArray(raw) || raw.length < minColumns || raw.length > MAX_COLUMNS) H.fail("STAT_INVALID_INPUT", `${path} must contain between ${minColumns} and ${MAX_COLUMNS} raters`);
  const names = [];
  const columns = [];
  const seen = new Set();
  raw.forEach((rawColumn, index) => {
    const columnPath = `${path}[${index}]`;
    const column = H.assertObject(rawColumn, columnPath);
    H.assertKeys(column, ["rater", "values"], columnPath);
    const name = H.label(column.rater, `Rater ${index + 1}`, `${columnPath}.rater`);
    if (seen.has(name)) H.fail("STAT_INVALID_INPUT", `${path} has a duplicate rater: ${name}`);
    seen.add(name);
    if (!Array.isArray(column.values) || column.values.length < 2 || column.values.length > MAX_ROWS) H.fail("STAT_INVALID_INPUT", `${columnPath}.values must contain between 2 and ${MAX_ROWS} entries`);
    const values = column.values.map((item, row) => {
      if (item === null) {
        if (!allowNull) H.fail("STAT_INVALID_INPUT", `${columnPath}.values[${row}] must not be null`);
        return null;
      }
      if (typeof item === "number") {
        if (!Number.isFinite(item)) H.fail("STAT_INVALID_INPUT", `${columnPath}.values[${row}] must be finite`);
        return Object.is(item, -0) ? 0 : item;
      }
      if (typeof item !== "string" || !item.trim() || item.trim().length > 128 || /[\u0000-\u001f]/u.test(item)) H.fail("STAT_INVALID_INPUT", `${columnPath}.values[${row}] must be a number or non-empty string`);
      return item.trim();
    });
    if (columns.length && values.length !== columns[0].length) H.fail("STAT_INVALID_INPUT", `${path} entries must all have the same number of units`);
    names.push(name);
    columns.push(values);
  });
  const present = columns.flat().filter((item) => item !== null);
  const numeric = present.every((item) => typeof item === "number");
  const textual = present.every((item) => typeof item === "string");
  if (!numeric && !textual) H.fail("STAT_INVALID_INPUT", `${path} values must be all numbers or all strings`);
  return { names, columns, n: columns[0].length, numeric };
}

const fleissKappa = {
  method: "fleiss_kappa",
  family: "agreement",
  analysisModel: { families: ["glm"], distributions: [null, "multinomial", "binomial"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      counts: { type: "array", minItems: 2, maxItems: MAX_ROWS, items: { type: "array", minItems: 2, maxItems: 64, items: { type: "integer", minimum: 0 } } },
      ratings: columnSchema("rater", 2, { type: ["string", "number"] }),
      categories: { type: "array", minItems: 2, maxItems: 64, items: { type: ["string", "number"] } },
      subjectLabels: subjectLabelsSchema,
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["counts", "ratings", "categories", "subjectLabels"], "data");
    if ((data.counts === undefined) === (data.ratings === undefined)) H.fail("STAT_INVALID_INPUT", "provide exactly one of data.counts or data.ratings");
    let counts;
    let categories;
    if (data.counts !== undefined) {
      if (!Array.isArray(data.counts) || data.counts.length < 2 || data.counts.length > MAX_ROWS) H.fail("STAT_INVALID_INPUT", `data.counts must contain between 2 and ${MAX_ROWS} subjects`);
      const width = Array.isArray(data.counts[0]) ? data.counts[0].length : 0;
      if (width < 2 || width > 64) H.fail("STAT_INVALID_INPUT", "data.counts rows must contain between 2 and 64 categories");
      counts = data.counts.map((row, subject) => {
        if (!Array.isArray(row) || row.length !== width) H.fail("STAT_INVALID_INPUT", `data.counts[${subject}] must have ${width} categories`);
        return row.map((value, column) => H.integer(value, 0, MAX_ROWS, `data.counts[${subject}][${column}]`));
      });
      if (data.categories === undefined) categories = Array.from({ length: width }, (_, index) => `Category ${index + 1}`);
      else {
        if (!Array.isArray(data.categories) || data.categories.length !== width) H.fail("STAT_INVALID_INPUT", "data.categories length must match the count columns");
        categories = data.categories.map((item, index) => (typeof item === "number" && Number.isFinite(item) ? String(item) : H.label(item, `Category ${index + 1}`, `data.categories[${index}]`)));
        if (new Set(categories).size !== categories.length) H.fail("STAT_INVALID_INPUT", "data.categories must be unique");
      }
    } else {
      const matrix = parseRatingLabelsColumns(data.ratings, "data.ratings", H);
      const all = matrix.columns.flat();
      let ordered;
      if (data.categories === undefined) ordered = [...new Set(all)].sort((left, right) => (matrix.numeric ? left - right : left.localeCompare(right, "en")));
      else {
        if (!Array.isArray(data.categories) || data.categories.length < 2) H.fail("STAT_INVALID_INPUT", "data.categories must list at least two categories");
        ordered = data.categories.map((item, index) => {
          if (typeof item === "number") {
            if (!Number.isFinite(item)) H.fail("STAT_INVALID_INPUT", `data.categories[${index}] must be finite`);
            return item;
          }
          return H.label(item, `Category ${index + 1}`, `data.categories[${index}]`);
        });
        if (new Set(ordered).size !== ordered.length) H.fail("STAT_INVALID_INPUT", "data.categories must be unique");
        const known = new Set(ordered);
        if (all.some((item) => !known.has(item))) H.fail("STAT_INVALID_INPUT", "every rating must be listed in data.categories");
      }
      if (ordered.length > 64) H.fail("STAT_LIMIT_EXCEEDED", "fleiss_kappa supports at most 64 categories");
      const index = new Map(ordered.map((category, position) => [category, position]));
      counts = Array.from({ length: matrix.n }, (_, row) => {
        const rowCounts = Array(ordered.length).fill(0);
        for (const column of matrix.columns) rowCounts[index.get(column[row])] += 1;
        return rowCounts;
      });
      categories = ordered.map(String);
    }
    if (categories.length < 2) H.fail("STAT_DEGENERATE", "fleiss_kappa requires at least two categories");
    const ratersPerSubject = counts[0].reduce((total, value) => total + value, 0);
    if (ratersPerSubject < 2) H.fail("STAT_INVALID_INPUT", "each subject must be rated by at least two raters");
    counts.forEach((row, subject) => {
      if (row.reduce((total, value) => total + value, 0) !== ratersPerSubject) H.fail("STAT_INVALID_INPUT", `data.counts[${subject}] rater total differs from the first subject; Fleiss kappa requires a constant number of raters`);
    });
    return { counts, categories, ratersPerSubject, subjectLabels: parseSubjectLabels(data.subjectLabels, counts.length, H) };
  },
  analyze(parsed, options, budget, H) {
    const { counts, categories, ratersPerSubject: m } = parsed;
    const N = counts.length;
    const k = categories.length;
    const pj = categories.map((_, column) => counts.reduce((total, row) => total + row[column], 0) / (N * m));
    const subjectAgreement = counts.map((row) => {
      budget.check();
      return (row.reduce((total, value) => total + value * value, 0) - m) / (m * (m - 1));
    });
    const pBar = subjectAgreement.reduce((total, value) => total + value, 0) / N;
    const pe = pj.reduce((total, value) => total + value * value, 0);
    if (!(1 - pe > 1e-12)) H.fail("STAT_DEGENERATE", "expected agreement is one; every rating falls in a single category");
    const kappa = (pBar - pe) / (1 - pe);
    const pq = pj.map((value) => value * (1 - value));
    const sumPq = pq.reduce((total, value) => total + value, 0);
    const se0 = (Math.sqrt(2 / (N * m * (m - 1))) * Math.sqrt(sumPq ** 2 - pj.reduce((total, value) => total + value * (1 - value) * (1 - 2 * value), 0))) / sumPq;
    if (!(se0 > 0) || !Number.isFinite(se0)) H.fail("STAT_DEGENERATE", "null standard error of Fleiss kappa is not positive");
    const z = kappa / se0;
    const pValue = twoSidedNormalP(z, H);
    const zCritical = H.normalInv(0.5 + options.confidenceLevel / 2);
    const categoryRows = categories.map((category, column) => {
      const disagreement = counts.reduce((total, row) => total + row[column] * (m - row[column]), 0);
      const categoryKappa = pq[column] > 0 ? 1 - disagreement / (N * m * (m - 1) * pq[column]) : null;
      return { category, proportion: pj[column], kappa: categoryKappa === null ? null : finiteOrFail(categoryKappa, "category kappa is not finite", H), ratings: counts.reduce((total, row) => total + row[column], 0) };
    });
    const subjectRows = counts.map((row, subject) => ({ subject: parsed.subjectLabels[subject], agreement: subjectAgreement[subject], ...Object.fromEntries(categories.map((category, column) => [`c${column + 1}`, row[column]])) }));
    for (const value of [kappa, z, pValue]) finiteOrFail(value, "Fleiss kappa output is not finite", H);
    return {
      sample: { n: N, ratersPerSubject: m, categories: k, completeRows: N },
      estimates: [
        { name: "Fleiss kappa", estimate: kappa, nullStandardError: se0 },
        { name: "mean observed agreement", estimate: pBar },
        { name: "expected agreement", estimate: pe },
      ],
      tests: [{ name: "kappa = 0 (z under the null, Fleiss 1971)", statistic: z, distribution: "normal", pValue, standardError: se0 }],
      confidenceIntervals: [{ parameter: "Fleiss kappa", level: options.confidenceLevel, lower: kappa - zCritical * se0, upper: kappa + zCritical * se0, method: "Wald interval using the null-hypothesis standard error (Fleiss 1971); wider than an estimate-based interval when kappa is far from zero" }],
      effectSizes: [{ name: "Fleiss kappa", estimate: kappa, interpretationBoundary: "chance-corrected agreement among a constant number of raters who need not be the same individuals" }],
      assumptions: [
        { name: "constant number of raters per subject", status: "verified", ratersPerSubject: m },
        { name: "raters are exchangeable (not necessarily the same individuals)", status: "assumed" },
        { name: "nominal categories", status: "assumed" },
        { name: "large-sample normal approximation", status: "asymptotic" },
      ],
      diagnostics: [
        { name: "category prevalence screen", status: "evaluated", rarestCategoryProportion: Math.min(...pj), boundary: "rare categories lower expected agreement and inflate kappa variance" },
        { name: "standard error boundary", status: "asymptotic", detail: "Only the null-hypothesis standard error is available in closed form; the interval is not an estimate-based interval." },
        { name: "per-category kappa", status: "evaluated", categoriesWithUndefinedKappa: categoryRows.filter((row) => row.kappa === null).map((row) => row.category) },
      ],
      artifacts: [
        H.tableArtifact("Fleiss kappa by category", "Category proportions and per-category kappa.", [
          { key: "category", label: "Category", type: "string" },
          { key: "ratings", label: "Ratings", type: "number" },
          { key: "proportion", label: "Proportion", type: "number" },
          { key: "kappa", label: "Category kappa", type: "number" },
        ], categoryRows, [`Overall Fleiss kappa: ${kappa}.`], "agreement-fleiss-category-table"),
        H.tableArtifact("Subject agreement", "Ratings per category and the observed agreement proportion for every subject.", [
          { key: "subject", label: "Subject", type: "string" },
          ...categories.map((category, column) => ({ key: `c${column + 1}`, label: category, type: "number" })),
          { key: "agreement", label: "Agreement P_i", type: "number" },
        ], subjectRows, [], "agreement-fleiss-subject-table"),
        H.vegaArtifact("agreement-fleiss-plot", "Per-category kappa", {
          data: { values: categoryRows },
          mark: { type: "bar" },
          encoding: {
            x: { field: "category", type: "nominal", title: "Category" },
            y: { field: "kappa", type: "quantitative", title: "Category kappa" },
            tooltip: [{ field: "category" }, { field: "kappa", format: ".4f" }, { field: "proportion", format: ".4f" }],
          },
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When more than two raters assign nominal categories to the same subjects, each subject receives the same number of ratings, and chance-corrected agreement across the whole panel is required.",
    decision: "Whether the rating panel agrees beyond chance and which categories drive disagreement.",
    mustShow: "Overall kappa with its null standard error and z test, per-category kappa and prevalence, per-subject agreement, the number of raters per subject, and the boundary that the interval uses the null standard error.",
    userGoal: "Report panel agreement for a classification scheme and identify categories whose definitions need work.",
    nextActions: [
      { trigger: "category-kappa-low", action: "review-category-definition-and-rater-training-for-that-category", reason: "Low category-specific kappa localizes disagreement that the overall kappa averages away." },
      { trigger: "rare-category", action: "report-prevalence-alongside-kappa-and-consider-pooling-plan", reason: "Rare categories make expected agreement high and kappa unstable." },
      { trigger: "raters-not-exchangeable", action: "switch-to-intraclass-correlation-or-krippendorff-alpha", reason: "Fleiss kappa assumes exchangeable raters; identifiable fixed raters need a different model." },
    ],
  },
  fixture: {
    data: {
      categories: ["absent", "mild", "severe"],
      counts: [[3, 1, 0], [0, 4, 0], [1, 2, 1], [0, 1, 3], [4, 0, 0], [0, 0, 4], [2, 2, 0], [0, 3, 1], [1, 3, 0], [0, 1, 3]],
    },
    options: { confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.descriptive-visualization"] },
  coverage: {
    implementedBoundary: "Fleiss kappa for a subjects-by-categories count table (or raters-by-units labels) with a constant number of raters per subject, per-category kappa, the Fleiss (1971) null standard error, z test, and null-SE interval; no missing ratings, no weighted variant.",
    oracle: { level: "external-library-partial", evidence: ["contracts/reliability-scipy-crosscheck.py"], verifiedOutputs: ["Fleiss kappa (statsmodels)", "per-category kappa (numpy first principles)", "null standard error (numpy first principles)"], excludedOutputs: ["estimate-based standard error", "bootstrap interval"] },
    diagnostic: { level: "method-specific-partial", emitted: ["category prevalence screen", "standard error boundary", "per-category kappa"], limitations: ["interval uses the null standard error", "no missing-rating support"] },
    knownGaps: ["unequal raters per subject", "weighted Fleiss kappa", "estimate-based variance (Fleiss, Nee and Landis)"],
  },
};

// ---------------------------------------------------------------------------------------------
// krippendorff_alpha
// ---------------------------------------------------------------------------------------------

const krippendorffAlpha = {
  method: "krippendorff_alpha",
  family: "agreement",
  analysisModel: { families: ["glm"], distributions: [null, "multinomial", "normal"], links: [null, "identity"] },
  optionKeys: ["timeoutMs"],
  customOptions: {
    level: {
      schema: { type: "string", enum: ["nominal", "ordinal", "interval"] },
      default: "nominal",
      parse(value, H, path) {
        if (!["nominal", "ordinal", "interval"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be nominal, ordinal, or interval`);
        return value;
      },
    },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["ratings"],
    properties: {
      ratings: columnSchema("rater", 2, { type: ["string", "number", "null"] }),
      unitLabels: subjectLabelsSchema,
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["ratings", "unitLabels"], "data");
    const matrix = parseRatingLabelsColumns(data.ratings, "data.ratings", H, { allowNull: true });
    if (options.level !== "nominal" && !matrix.numeric) H.fail("STAT_INVALID_INPUT", `options.level ${options.level} requires numeric ratings`);
    return { ...matrix, unitLabels: parseSubjectLabels(data.unitLabels, matrix.n, H) };
  },
  analyze(parsed, options, budget, H) {
    const { columns, n, numeric } = parsed;
    const m = columns.length;
    const present = columns.flat().filter((item) => item !== null);
    const values = [...new Set(present)].sort((left, right) => (numeric ? left - right : left.localeCompare(right, "en")));
    if (values.length < 2) H.fail("STAT_DEGENERATE", "krippendorff_alpha requires at least two distinct values");
    const k = values.length;
    const index = new Map(values.map((value, position) => [value, position]));
    const coincidence = Array.from({ length: k }, () => Array(k).fill(0));
    let unitsUsed = 0;
    let pairableValues = 0;
    for (let unit = 0; unit < n; unit += 1) {
      const unitValues = columns.map((column) => column[unit]).filter((item) => item !== null);
      const mu = unitValues.length;
      if (mu < 2) continue;
      unitsUsed += 1;
      pairableValues += mu;
      for (let first = 0; first < mu; first += 1) {
        for (let second = 0; second < mu; second += 1) {
          if (first === second) continue;
          budget.check();
          coincidence[index.get(unitValues[first])][index.get(unitValues[second])] += 1 / (mu - 1);
        }
      }
    }
    if (unitsUsed < 2) H.fail("STAT_INSUFFICIENT_SAMPLE", "krippendorff_alpha requires at least two units with two or more ratings");
    const nc = coincidence.map((row) => row.reduce((total, value) => total + value, 0));
    const total = nc.reduce((sum, value) => sum + value, 0);
    const delta = (c, d) => {
      if (c === d) return 0;
      if (options.level === "nominal") return 1;
      if (options.level === "interval") return (values[c] - values[d]) ** 2;
      const low = Math.min(c, d);
      const high = Math.max(c, d);
      let between = 0;
      for (let g = low; g <= high; g += 1) between += nc[g];
      return (between - (nc[low] + nc[high]) / 2) ** 2;
    };
    let observed = 0;
    let expected = 0;
    const cellRows = [];
    for (let c = 0; c < k; c += 1) {
      for (let d = 0; d < k; d += 1) {
        const metric = delta(c, d);
        observed += coincidence[c][d] * metric;
        expected += nc[c] * nc[d] * metric;
        cellRows.push({ value: String(values[c]), pairedValue: String(values[d]), coincidence: coincidence[c][d], deltaSquared: metric });
      }
    }
    observed /= total;
    expected /= total * (total - 1);
    if (!(expected > 0)) H.fail("STAT_DEGENERATE", "expected disagreement is zero; alpha is undefined");
    const alpha = 1 - observed / expected;
    finiteOrFail(alpha, "Krippendorff alpha is not finite", H);
    const valueRows = values.map((value, c) => ({ value: String(value), pairableCount: nc[c], proportion: nc[c] / total }));
    return {
      sample: { n, unitsUsed, unitsExcluded: n - unitsUsed, raters: m, pairableValues, distinctValues: k },
      estimates: [
        { name: "Krippendorff alpha", estimate: alpha, level: options.level },
        { name: "observed disagreement", estimate: observed },
        { name: "expected disagreement", estimate: expected },
      ],
      tests: [],
      confidenceIntervals: [],
      effectSizes: [{ name: "Krippendorff alpha", estimate: alpha, interpretationBoundary: "chance-corrected agreement tolerant of missing ratings; 0.8 and 0.667 are conventional, not inferential, cutoffs" }],
      assumptions: [
        { name: "units with a single rating are excluded from the coincidence matrix", status: "verified", excludedUnits: n - unitsUsed },
        { name: `metric matches measurement level (${options.level})`, status: "assumed_from_option" },
        { name: "missing ratings ignorable", status: "assumed" },
      ],
      diagnostics: [
        { name: "coincidence matrix", status: "evaluated", pairableValues, distinctValues: k },
        { name: "uncertainty boundary", status: "not_established", detail: "No bootstrap or analytic interval is computed; alpha is reported as a point estimate." },
        { name: "sparse values", status: valueRows.some((row) => row.pairableCount < 2) ? "values with fewer than two pairable ratings present" : "every value pairable", sparseValues: valueRows.filter((row) => row.pairableCount < 2).map((row) => row.value) },
      ],
      artifacts: [
        H.tableArtifact("Krippendorff alpha", "Alpha, observed and expected disagreement, and the units and values used.", [{ key: "statistic", label: "Statistic", type: "string" }, { key: "value", label: "Value", type: "number" }], [
          { statistic: `alpha (${options.level})`, value: alpha },
          { statistic: "observed disagreement D_o", value: observed },
          { statistic: "expected disagreement D_e", value: expected },
          { statistic: "units used", value: unitsUsed },
          { statistic: "pairable values", value: pairableValues },
        ], [], "agreement-krippendorff-table"),
        H.tableArtifact("Value totals", "Pairable ratings per distinct value (the n_c totals of the coincidence matrix).", [{ key: "value", label: "Value", type: "string" }, { key: "pairableCount", label: "Pairable ratings", type: "number" }, { key: "proportion", label: "Proportion", type: "number" }], valueRows, [], "agreement-krippendorff-value-table"),
        H.tableArtifact("Coincidence matrix", "Value-by-value coincidence counts and the squared difference metric used for each pair.", [{ key: "value", label: "Value", type: "string" }, { key: "pairedValue", label: "Paired value", type: "string" }, { key: "coincidence", label: "Coincidence", type: "number" }, { key: "deltaSquared", label: "delta^2", type: "number" }], cellRows, [], "agreement-krippendorff-coincidence-table"),
        H.vegaArtifact("agreement-krippendorff-heatmap", `Coincidence matrix (${options.level} metric)`, {
          data: { values: cellRows },
          mark: { type: "rect" },
          encoding: {
            x: { field: "pairedValue", type: "nominal", title: "Paired value" },
            y: { field: "value", type: "nominal", title: "Value" },
            color: { field: "coincidence", type: "quantitative", title: "Coincidence", scale: { scheme: "greens" } },
            tooltip: [{ field: "value" }, { field: "pairedValue" }, { field: "coincidence", format: ".3f" }, { field: "deltaSquared", format: ".3f" }],
          },
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When any number of raters code the same units, some ratings are missing, and agreement must be computed with a metric that respects the nominal, ordinal, or interval level of the codes.",
    decision: "Whether the coding is reliable enough to draw conclusions from the coded data, and whether missing ratings or rare values are eroding that reliability.",
    mustShow: "Alpha with the metric used, observed and expected disagreement, the coincidence matrix, the number of units and pairable values, and the boundary that no interval is computed.",
    userGoal: "Report content-analysis reliability under missing data and choose the metric that matches the coding scale.",
    nextActions: [
      { trigger: "alpha-below-convention", action: "open-low-agreement-units-and-revise-codebook-before-analysis", reason: "Conclusions drawn from unreliable codes inherit the coder disagreement." },
      { trigger: "many-units-excluded", action: "review-missingness-pattern-and-collect-second-ratings", reason: "Units with one rating contribute nothing to alpha, shrinking the effective sample." },
      { trigger: "metric-choice-uncertain", action: "prespecify-level-and-report-sensitivity-across-metrics", reason: "Nominal, ordinal, and interval alpha differ materially for the same data." },
    ],
  },
  fixture: {
    data: {
      ratings: [
        { rater: "coder A", values: [1, 2, 3, 3, 2, 1, 4, 1, 2, null, 3, 4] },
        { rater: "coder B", values: [1, 2, 3, 3, 2, 2, 4, 1, 2, 5, 3, 4] },
        { rater: "coder C", values: [null, 3, 3, 3, 2, 3, 4, 2, 2, 5, null, 4] },
        { rater: "coder D", values: [1, 2, 3, 3, 2, 4, 4, 1, 2, 5, 3, null] },
      ],
    },
    options: { level: "ordinal" },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.descriptive-visualization"] },
  coverage: {
    implementedBoundary: "Krippendorff alpha (nominal, ordinal, interval metrics) from a raters-by-units matrix with missing ratings via the coincidence-matrix formulation; no ratio metric, no bootstrap interval, no custom difference functions.",
    oracle: { level: "external-library-partial", evidence: ["contracts/reliability-scipy-crosscheck.py"], verifiedOutputs: ["alpha nominal", "alpha ordinal", "alpha interval", "observed and expected disagreement (numpy first-principles coincidence matrix; no external library implementation is used)"], excludedOutputs: ["bootstrap interval", "ratio metric"] },
    diagnostic: { level: "method-specific-partial", emitted: ["coincidence matrix", "uncertainty boundary", "sparse values"], limitations: ["point estimate only", "oracle is first principles, not an external reference implementation"] },
    knownGaps: ["bootstrap interval and probability of failing the cutoff", "ratio and circular metrics", "per-unit agreement diagnostics"],
  },
};

// ---------------------------------------------------------------------------------------------
// kendall_w
// ---------------------------------------------------------------------------------------------

const kendallW = {
  method: "kendall_w",
  family: "agreement",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "ordinal"], links: [null, "identity"] },
  optionKeys: ["timeoutMs"],
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["ratings"],
    properties: {
      ratings: columnSchema("rater", 2),
      objectLabels: subjectLabelsSchema,
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["ratings", "objectLabels"], "data");
    const matrix = parseNumericColumns(data.ratings, "data.ratings", "rater", "Rater", H, { minColumns: 2, minRows: 3 });
    if (matrix.n < 3) H.fail("STAT_INVALID_INPUT", "kendall_w requires at least three objects");
    return { ...matrix, objectLabels: parseSubjectLabels(data.objectLabels, matrix.n, H) };
  },
  analyze(parsed, options, budget, H) {
    const { names, columns, n, objectLabels } = parsed;
    const m = columns.length;
    const ranked = columns.map((column) => H.averageRanks(column));
    const tieCorrection = ranked.reduce((total, { tieSizes }) => total + tieSizes.reduce((sum, size) => sum + size ** 3 - size, 0), 0);
    const rankSums = Array.from({ length: n }, (_, object) => ranked.reduce((total, { ranks }) => total + ranks[object], 0));
    const meanRankSum = (m * (n + 1)) / 2;
    let s = 0;
    for (const value of rankSums) {
      budget.check();
      s += (value - meanRankSum) ** 2;
    }
    const denominator = m * m * (n ** 3 - n) - m * tieCorrection;
    if (!(denominator > 0)) H.fail("STAT_DEGENERATE", "every rater assigns tied ranks to all objects; W is undefined");
    const w = (12 * s) / denominator;
    const chiSquare = m * (n - 1) * w;
    const df = n - 1;
    const pValue = H.pFromChiSquare(chiSquare, df);
    const meanSpearman = (m * w - 1) / (m - 1);
    for (const value of [w, chiSquare, pValue]) finiteOrFail(value, "Kendall W output is not finite", H);
    const objectRows = rankSums.map((rankSum, object) => ({ object: objectLabels[object], rankSum, meanRank: rankSum / m, ...Object.fromEntries(ranked.map(({ ranks }, rater) => [`r${rater + 1}`, ranks[object]])) }));
    return {
      sample: { n, raters: m, completeRows: n, tiedRankGroups: ranked.reduce((total, { tieSizes }) => total + tieSizes.length, 0) },
      estimates: [
        { name: "Kendall W", estimate: w, tieCorrected: tieCorrection > 0 },
        { name: "mean pairwise Spearman correlation implied by W", estimate: meanSpearman },
        { name: "sum of squared rank-sum deviations S", estimate: s },
      ],
      tests: [{ name: "Friedman chi-square for W = 0", statistic: chiSquare, distribution: "chi-square", df, pValue }],
      confidenceIntervals: [],
      effectSizes: [{ name: "Kendall W", estimate: w, interpretationBoundary: "0 = no concordance, 1 = identical rankings among the raters" }],
      assumptions: [
        { name: "every rater ranks every object", status: "verified" },
        { name: "chi-square approximation adequate", status: n > 7 ? "asymptotic" : "small_sample_boundary", note: "For fewer than eight objects the chi-square approximation is rough; exact tables are not implemented." },
        { name: "ties handled by average ranks with tie correction", status: "verified" },
      ],
      diagnostics: [
        { name: "tie correction", status: tieCorrection > 0 ? "applied" : "not_needed", sumOfTieTerms: tieCorrection },
        { name: "small-sample boundary", status: n > 7 ? "not_triggered" : "triggered", objects: n },
        { name: "rank spread", status: "evaluated", highestMeanRank: Math.max(...objectRows.map((row) => row.meanRank)), lowestMeanRank: Math.min(...objectRows.map((row) => row.meanRank)) },
      ],
      artifacts: [
        H.tableArtifact("Object rank sums", "Within-rater average ranks, rank sums, and mean ranks for every object.", [
          { key: "object", label: "Object", type: "string" },
          ...names.map((name, rater) => ({ key: `r${rater + 1}`, label: name, type: "number" })),
          { key: "rankSum", label: "Rank sum", type: "number" },
          { key: "meanRank", label: "Mean rank", type: "number" },
        ], objectRows, [], "agreement-kendall-w-rank-table"),
        H.tableArtifact("Kendall coefficient of concordance", "W, the chi-square test, and the implied mean Spearman correlation.", [{ key: "statistic", label: "Statistic", type: "string" }, { key: "value", label: "Value", type: "number" }], [
          { statistic: "W", value: w },
          { statistic: "chi-square", value: chiSquare },
          { statistic: "df", value: df },
          { statistic: "p", value: pValue },
          { statistic: "mean Spearman rho", value: meanSpearman },
          { statistic: "tie correction term", value: tieCorrection },
        ], [], "agreement-kendall-w-table"),
        H.vegaArtifact("agreement-kendall-w-plot", "Mean rank per object across raters", {
          data: { values: objectRows },
          mark: { type: "bar" },
          encoding: {
            y: { field: "object", type: "nominal", title: "Object", sort: "-x" },
            x: { field: "meanRank", type: "quantitative", title: "Mean rank" },
            tooltip: [{ field: "object" }, { field: "meanRank", format: ".3f" }, { field: "rankSum", format: ".3f" }],
          },
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When several judges rank or score the same set of objects and the researcher must show whether the judges order the objects consistently before using a consensus ranking.",
    decision: "Whether the panel's rankings agree enough to justify a pooled ranking and which objects are ranked most and least consistently.",
    mustShow: "W with the tie correction, the chi-square test, every rater's ranks and each object's rank sum and mean rank, and the small-sample boundary of the approximation.",
    userGoal: "Report judge concordance and produce a defensible consensus ordering of the objects.",
    nextActions: [
      { trigger: "concordance-low", action: "inspect-per-rater-rankings-and-review-rating-criteria", reason: "Low W means the judges disagree on the ordering; a pooled ranking would hide that disagreement." },
      { trigger: "few-objects", action: "use-exact-or-permutation-reference-before-reporting-p", reason: "The chi-square approximation is unreliable for fewer than eight objects." },
      { trigger: "concordance-adequate", action: "bind-mean-rank-table-and-figure-as-consensus-ranking", reason: "The mean rank ordering is the consensus result the manuscript should report." },
    ],
  },
  fixture: {
    data: {
      ratings: [
        { rater: "judge 1", values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
        { rater: "judge 2", values: [2, 1, 4, 3, 5, 7, 6, 9, 8, 10] },
        { rater: "judge 3", values: [1, 3, 2, 4, 6, 5, 8, 7, 10, 9] },
        { rater: "judge 4", values: [2, 2, 3, 5, 4, 6, 7, 9, 8, 10] },
      ],
      objectLabels: ["wine a", "wine b", "wine c", "wine d", "wine e", "wine f", "wine g", "wine h", "wine i", "wine j"],
    },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.hypothesis.location", "matlab.stats.descriptive-visualization"] },
  coverage: {
    implementedBoundary: "Kendall coefficient of concordance W for 2..64 raters scoring 3..10000 objects, with average-rank ties, the tie-corrected denominator, and the Friedman chi-square approximation; no exact small-sample p value.",
    oracle: { level: "external-library-partial", evidence: ["contracts/reliability-scipy-crosscheck.py"], verifiedOutputs: ["W with tie correction (numpy/scipy rankdata first principles)", "chi-square (scipy friedmanchisquare relationship)", "p value"], excludedOutputs: ["exact small-sample p value", "F approximation"] },
    diagnostic: { level: "method-specific-partial", emitted: ["tie correction", "small-sample boundary", "rank spread"], limitations: ["chi-square approximation only"] },
    knownGaps: ["exact permutation reference for small n", "incomplete block (BIBD) designs", "Kendall W confidence interval"],
  },
};

module.exports = { methods: [cronbachAlpha, mcdonaldOmega, intraclassCorrelation, cohenKappa, fleissKappa, krippendorffAlpha, kendallW] };
