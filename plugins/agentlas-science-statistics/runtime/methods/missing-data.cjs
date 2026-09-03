"use strict";

/**
 * Missing-data family: describe the missingness, then analyse under a stated missingness assumption.
 *
 * Methods: missing_data_pattern, multiple_imputation_regression, inverse_probability_weighting.
 * Pure deterministic JavaScript; every numeric helper arrives through `H` and the module never
 * requires engine.cjs. All randomness comes from ./resampling-prng.cjs (xoshiro128** seeded by
 * SplitMix32), so every imputation stream is reproducible from `seed` and is byte-for-byte
 * reproducible by the Python oracle port.
 *
 * Independent oracle: contracts/missing-data-scipy-crosscheck.py
 *   - pattern / variable accounting        -> pandas
 *   - EM maximum-likelihood mean and covariance under MCAR -> numpy (independent implementation,
 *     verified against the observed-data score equations)
 *   - Little (1988) MCAR chi-square        -> derived in the oracle from the same pattern
 *     likelihood; no Python library implements it (see coverage.knownGaps)
 *   - per-imputation analysis fits         -> statsmodels.OLS on the reconstructed completed data
 *   - Rubin (1987) pooling + Barnard-Rubin -> numpy / scipy from first principles
 *   - response propensity model            -> statsmodels.Logit
 *   - weighted analysis + sandwich         -> statsmodels.WLS(...).fit(cov_type="HC0")
 */

const PRNG = require("./resampling-prng.cjs");

const MAX_VARIABLES = 24;
const MAX_ROWS = 5_000;
const MAX_PREDICTORS = 12;
const LAMBDA_FLOOR = 1e-10;

// ---------------------------------------------------------------------------------------------
// Shared parsing helpers
// ---------------------------------------------------------------------------------------------

/** A numeric vector that may carry explicit `null` holes. Returns (number | null)[]. */
function gappyVector(raw, path, H, minLength = 2) {
  if (!Array.isArray(raw) || raw.length < minLength || raw.length > MAX_ROWS) {
    H.fail("STAT_INVALID_INPUT", `${path} must contain between ${minLength} and ${MAX_ROWS} values`);
  }
  return raw.map((value, index) => {
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      H.fail("STAT_INVALID_INPUT", `${path}[${index}] must be a finite number or null for a missing value`);
    }
    return Object.is(value, -0) ? 0 : value;
  });
}

/** A numeric vector with no holes allowed (fully observed covariate). */
function completeVector(raw, path, H, minLength = 2) {
  const values = gappyVector(raw, path, H, minLength);
  values.forEach((value, index) => {
    if (value === null) H.fail("STAT_INVALID_INPUT", `${path}[${index}] must be observed; this variable may not contain null`);
  });
  return values;
}

function parseColumns(raw, path, fallbackPrefix, H, { minColumns, maxColumns, rows, allowMissing }) {
  if (!Array.isArray(raw) || raw.length < minColumns || raw.length > maxColumns) {
    H.fail("STAT_INVALID_INPUT", `${path} must contain between ${minColumns} and ${maxColumns} entries`);
  }
  const names = [];
  const columns = [];
  const seen = new Set();
  raw.forEach((rawColumn, index) => {
    const columnPath = `${path}[${index}]`;
    const column = H.assertObject(rawColumn, columnPath);
    H.assertKeys(column, ["name", "values"], columnPath);
    const name = H.label(column.name, `${fallbackPrefix} ${index + 1}`, `${columnPath}.name`);
    if (seen.has(name)) H.fail("STAT_INVALID_INPUT", `${path} has a duplicate name: ${name}`);
    seen.add(name);
    const values = allowMissing
      ? gappyVector(column.values, `${columnPath}.values`, H, 2)
      : completeVector(column.values, `${columnPath}.values`, H, 2);
    const expected = rows === null ? (columns.length ? columns[0].length : values.length) : rows;
    if (values.length !== expected) H.fail("STAT_INVALID_INPUT", `${path} entries must all have ${expected} rows`);
    names.push(name);
    columns.push(values);
  });
  return { names, columns, n: columns[0].length };
}

function columnSchema(minItems, maxItems, allowMissing) {
  return {
    type: "array",
    minItems,
    maxItems,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["values"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 128 },
        values: {
          type: "array",
          minItems: 2,
          maxItems: MAX_ROWS,
          items: allowMissing ? { type: ["number", "null"] } : { type: "number" },
        },
      },
    },
  };
}

function finiteOrFail(value, message, H) {
  if (typeof value !== "number" || !Number.isFinite(value)) H.fail("STAT_DEGENERATE", message);
  return Object.is(value, -0) ? 0 : value;
}

function observedOf(column) {
  const values = [];
  for (const value of column) if (value !== null) values.push(value);
  return values;
}

function submatrix(matrix, rows, columns) {
  return rows.map((row) => columns.map((column) => matrix[row][column]));
}

/** Lower Cholesky factor L with matrix = L Lᵀ. */
function choleskyLower(matrix, H, message) {
  const n = matrix.length;
  const lower = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let total = matrix[i][j];
      for (let k = 0; k < j; k += 1) total -= lower[i][k] * lower[j][k];
      if (i === j) {
        if (!(total > 0)) H.fail("STAT_SINGULAR_MATRIX", message);
        lower[i][i] = Math.sqrt(total);
      } else {
        lower[i][j] = total / lower[j][j];
      }
    }
  }
  return lower;
}

/** OLS on a design already built as rows of x; returns beta, (XᵀX)⁻¹, residuals, sse. */
function fitOls(y, x, H, budget) {
  const p = x[0].length;
  if (y.length <= p) H.fail("STAT_INSUFFICIENT_SAMPLE", "regression requires more rows than fitted coefficients");
  const core = H.olsCore(y, x, budget);
  let sse = 0;
  for (const residual of core.residuals) sse += residual * residual;
  return { ...core, sse, dfResidual: y.length - p };
}

// ---------------------------------------------------------------------------------------------
// missing_data_pattern
// ---------------------------------------------------------------------------------------------

/**
 * EM for the multivariate normal mean and (maximum-likelihood, divisor n) covariance under an
 * ignorable missingness mechanism. Rows with no observed variable are excluded: they leave the
 * fixed point of the EM equations unchanged and contribute nothing to Little's statistic.
 */
function emNormal(rawRows, variableCount, tolerance, maxIterations, H, budget) {
  const n = rawRows.length;
  const rawColumns = Array.from({ length: variableCount }, (_, j) => rawRows.map((row) => row.values[j]).filter((value) => value !== null));
  // Iterate on the standardized scale: the convergence test is then scale free and the
  // cross-product matrices are far better conditioned. Little's statistic is a Mahalanobis
  // distance, so it is invariant to this affine change of units.
  const center = rawColumns.map((values, j) => {
    if (!values.length) H.fail("STAT_DEGENERATE", `variable ${j + 1} has no observed value`);
    return H.mean(values, budget);
  });
  const scale = rawColumns.map((values, j) => {
    if (values.length < 2) H.fail("STAT_INSUFFICIENT_SAMPLE", `variable ${j + 1} needs at least two observed values`);
    let total = 0;
    for (const value of values) total += (value - center[j]) ** 2;
    if (!(total > 0)) H.fail("STAT_DEGENERATE", `variable ${j + 1} is constant among its observed values`);
    return Math.sqrt(total / values.length);
  });
  const rows = rawRows.map((row) => ({
    observed: row.observed,
    missing: row.missing,
    values: row.values.map((value, j) => (value === null ? null : (value - center[j]) / scale[j])),
  }));
  // Deterministic start: zero mean, identity covariance on the standardized scale.
  let mu = Array(variableCount).fill(0);
  let sigma = Array.from({ length: variableCount }, (_, i) => Array.from({ length: variableCount }, (_, j) => (i === j ? 1 : 0)));
  let iterations = 0;
  let converged = false;
  let change = null;
  for (; iterations < maxIterations; iterations += 1) {
    const t1 = Array(variableCount).fill(0);
    const t2 = Array.from({ length: variableCount }, () => Array(variableCount).fill(0));
    for (const row of rows) {
      budget.check(variableCount);
      const filled = row.values.slice();
      let correction = null;
      if (row.missing.length) {
        const soo = submatrix(sigma, row.observed, row.observed);
        const inverse = H.invert(soo);
        const smo = submatrix(sigma, row.missing, row.observed);
        const gain = H.matMul(smo, inverse, budget);
        const deviation = row.observed.map((index) => row.values[index] - mu[index]);
        row.missing.forEach((index, position) => {
          let value = mu[index];
          for (let k = 0; k < deviation.length; k += 1) value += gain[position][k] * deviation[k];
          filled[index] = value;
        });
        const smm = submatrix(sigma, row.missing, row.missing);
        const oms = submatrix(sigma, row.observed, row.missing);
        const reduction = H.matMul(gain, oms, budget);
        correction = smm.map((line, i) => line.map((value, j) => value - reduction[i][j]));
      }
      for (let i = 0; i < variableCount; i += 1) {
        t1[i] += filled[i];
        for (let j = 0; j < variableCount; j += 1) t2[i][j] += filled[i] * filled[j];
      }
      if (correction) {
        row.missing.forEach((i, a) => {
          row.missing.forEach((j, b) => { t2[i][j] += correction[a][b]; });
        });
      }
    }
    const nextMu = t1.map((value) => value / n);
    const nextSigma = t2.map((line, i) => line.map((value, j) => value / n - nextMu[i] * nextMu[j]));
    for (let i = 0; i < variableCount; i += 1) {
      for (let j = i + 1; j < variableCount; j += 1) {
        const averaged = (nextSigma[i][j] + nextSigma[j][i]) / 2;
        nextSigma[i][j] = averaged;
        nextSigma[j][i] = averaged;
      }
    }
    change = 0;
    for (let i = 0; i < variableCount; i += 1) {
      change = Math.max(change, Math.abs(nextMu[i] - mu[i]));
      for (let j = 0; j < variableCount; j += 1) change = Math.max(change, Math.abs(nextSigma[i][j] - sigma[i][j]));
    }
    mu = nextMu;
    sigma = nextSigma;
    if (change < tolerance) {
      converged = true;
      iterations += 1;
      break;
    }
  }
  if (!converged) H.fail("STAT_NON_CONVERGENCE", `EM for the maximum-likelihood mean and covariance did not converge within ${maxIterations} iterations`);
  return {
    mu: mu.map((value, j) => center[j] + scale[j] * value),
    sigma: sigma.map((line, i) => line.map((value, j) => value * scale[i] * scale[j])),
    iterations,
    change,
  };
}

const missingDataPattern = {
  method: "missing_data_pattern",
  family: "missing-data",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["tolerance", "timeoutMs"],
  customOptions: {
    emIterations: {
      schema: { type: "integer", minimum: 10, maximum: 5000, description: "Iteration cap for the EM estimate of the mean and covariance used by Little's MCAR test." },
      default: 1000,
      parse(value, H, path) { return H.integer(value, 10, 5000, path); },
    },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["variables"],
    properties: {
      variables: columnSchema(2, MAX_VARIABLES, true),
      datasetLabel: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["variables", "datasetLabel"], "data");
    const parsed = parseColumns(data.variables, "data.variables", "Variable", H, { minColumns: 2, maxColumns: MAX_VARIABLES, rows: null, allowMissing: true });
    if (parsed.n < 4) H.fail("STAT_INSUFFICIENT_SAMPLE", "missing_data_pattern requires at least four rows");
    parsed.columns.forEach((column, index) => {
      const observed = observedOf(column);
      if (observed.length < 2) H.fail("STAT_INSUFFICIENT_SAMPLE", `variable ${parsed.names[index]} has fewer than two observed values`);
      const { min, max } = H.minMax(observed);
      if (min === max) H.fail("STAT_DEGENERATE", `variable ${parsed.names[index]} is constant among its observed values`);
    });
    return { ...parsed, datasetLabel: H.label(data.datasetLabel, "Dataset", "data.datasetLabel") };
  },
  analyze(parsed, options, budget, H) {
    const { names, columns, n } = parsed;
    const j = columns.length;

    const variableRows = names.map((name, index) => {
      const column = columns[index];
      const observed = observedOf(column);
      const missing = n - observed.length;
      return {
        variable: name,
        observed: observed.length,
        missing,
        percentMissing: (100 * missing) / n,
        observedMean: H.mean(observed, budget),
        observedSd: observed.length >= 2 ? Math.sqrt(H.variance(observed, true, budget)) : null,
      };
    });

    // Missingness patterns keyed by the observed indicator string ("1" observed, "0" missing).
    const patternMap = new Map();
    const rowPatterns = [];
    for (let row = 0; row < n; row += 1) {
      budget.check(j);
      let key = "";
      for (let variable = 0; variable < j; variable += 1) key += columns[variable][row] === null ? "0" : "1";
      rowPatterns.push(key);
      if (!patternMap.has(key)) patternMap.set(key, []);
      patternMap.get(key).push(row);
    }
    const patternRows = [...patternMap.entries()]
      .map(([pattern, rows]) => {
        const missingNames = names.filter((_, index) => pattern[index] === "0");
        return {
          pattern,
          count: rows.length,
          percentOfRows: (100 * rows.length) / n,
          variablesObserved: j - missingNames.length,
          variablesMissing: missingNames.length,
          missingVariables: missingNames.length ? missingNames.join(", ") : "(none: complete case)",
        };
      })
      .sort((left, right) => right.count - left.count || left.pattern.localeCompare(right.pattern, "en"));
    const completePattern = "1".repeat(j);
    const completeRows = patternMap.has(completePattern) ? patternMap.get(completePattern).length : 0;

    // Monotone check: order variables by missing count ascending (ties by declaration order).
    // The design is monotone when, in that order, every row's observed indicators are 1...10...0.
    const monotoneOrder = names
      .map((name, index) => ({ name, index, missing: variableRows[index].missing }))
      .sort((left, right) => left.missing - right.missing || left.index - right.index);
    let monotone = true;
    let monotoneViolationRow = null;
    for (let row = 0; row < n && monotone; row += 1) {
      let seenMissing = false;
      for (const entry of monotoneOrder) {
        const isMissing = columns[entry.index][row] === null;
        if (isMissing) seenMissing = true;
        else if (seenMissing) {
          monotone = false;
          monotoneViolationRow = row + 1;
          break;
        }
      }
    }

    // Little (1988) MCAR test. Under MCAR the pattern-specific observed means are all unbiased for
    // the same mean vector, so the pooled Mahalanobis distance of each pattern mean from the EM
    // maximum-likelihood mean is chi-square with sum(observed variables per pattern) - J degrees of
    // freedom. The covariance used is the ML (divisor n) estimate, as in Little's derivation.
    const usableRows = [];
    for (let row = 0; row < n; row += 1) {
      const observed = [];
      const missing = [];
      for (let variable = 0; variable < j; variable += 1) {
        if (columns[variable][row] === null) missing.push(variable);
        else observed.push(variable);
      }
      if (observed.length) usableRows.push({ row, observed, missing, values: columns.map((column) => column[row]) });
    }
    if (usableRows.length < j + 1) H.fail("STAT_INSUFFICIENT_SAMPLE", "too few rows with at least one observed value to estimate the mean and covariance");
    const em = emNormal(usableRows, j, options.tolerance, options.emIterations, H, budget);

    let statistic = 0;
    let dfSum = 0;
    let patternsUsed = 0;
    const mcarRows = [];
    for (const entry of patternRows) {
      const rows = patternMap.get(entry.pattern);
      const observed = [];
      for (let variable = 0; variable < j; variable += 1) if (entry.pattern[variable] === "1") observed.push(variable);
      if (!observed.length) continue;
      budget.check(observed.length * observed.length);
      const means = observed.map((variable) => {
        let total = 0;
        for (const row of rows) total += columns[variable][row];
        return total / rows.length;
      });
      const deviation = means.map((value, index) => value - em.mu[observed[index]]);
      const inverse = H.invert(submatrix(em.sigma, observed, observed));
      let quadratic = 0;
      for (let a = 0; a < observed.length; a += 1) {
        for (let b = 0; b < observed.length; b += 1) quadratic += deviation[a] * inverse[a][b] * deviation[b];
      }
      const contribution = rows.length * quadratic;
      statistic += contribution;
      dfSum += observed.length;
      patternsUsed += 1;
      mcarRows.push({ pattern: entry.pattern, count: rows.length, variablesObserved: observed.length, contribution });
    }
    const df = dfSum - j;
    const evaluated = df > 0;
    statistic = finiteOrFail(statistic, "Little MCAR statistic is not finite", H);
    const pValue = evaluated ? Math.min(1, Math.max(0, H.pFromChiSquare(statistic, df))) : null;

    const testRows = [
      { statistic: "Little MCAR chi-square", value: statistic },
      { statistic: "degrees of freedom", value: evaluated ? df : 0 },
      { statistic: "p value", value: evaluated ? pValue : 0 },
      { statistic: "missing-data patterns", value: patternRows.length },
      { statistic: "patterns entering the test", value: patternsUsed },
      { statistic: "complete rows", value: completeRows },
      { statistic: "incomplete rows", value: n - completeRows },
      { statistic: "cells missing (%)", value: (100 * variableRows.reduce((total, row) => total + row.missing, 0)) / (n * j) },
    ];

    return {
      sample: {
        n,
        variables: j,
        completeRows,
        incompleteRows: n - completeRows,
        patterns: patternRows.length,
        missingCells: variableRows.reduce((total, row) => total + row.missing, 0),
        rowsWithAnyObservedValue: usableRows.length,
      },
      estimates: [
        { name: "proportion of complete rows", estimate: completeRows / n },
        { name: "proportion of missing cells", estimate: variableRows.reduce((total, row) => total + row.missing, 0) / (n * j) },
        { name: "number of missing-data patterns", estimate: patternRows.length },
        { name: "largest per-variable missing proportion", estimate: Math.max(...variableRows.map((row) => row.percentMissing)) / 100, variable: variableRows.reduce((worst, row) => (row.percentMissing > worst.percentMissing ? row : worst)).variable },
      ],
      tests: evaluated
        ? [{ name: "Little MCAR test", statistic, distribution: "chi-square", df, pValue, method: "Little (1988) pooled pattern-mean Mahalanobis distance from the EM maximum-likelihood mean", interpretationBoundary: "rejecting MCAR does not identify MAR or MNAR; failing to reject is not evidence for MCAR" }]
        : [{ name: "Little MCAR test", status: "not_evaluated", reason: "degrees of freedom are not positive; the patterns carry no information beyond the variable count", df }],
      confidenceIntervals: [],
      effectSizes: [{ name: "proportion of missing cells", estimate: variableRows.reduce((total, row) => total + row.missing, 0) / (n * j), interpretationBoundary: "describes how much data is absent, not how much bias the absence causes" }],
      assumptions: [
        { name: "missingness indicator is explicit", status: "verified", note: "Every absent value arrived as null; sentinel codes such as -99 are not detected." },
        { name: "multivariate normality of the analysis variables", status: "not_established", note: "Little's test derives from the normal likelihood; heavy tails or categorical codings distort it." },
        { name: "MCAR (testable)", status: evaluated ? "tested" : "not_evaluated", note: "The chi-square is the only assumption this method tests; MAR and MNAR are untestable from the observed data." },
        { name: "patterns have enough rows for a pattern mean", status: patternRows.every((row) => row.count >= 2) ? "verified" : "requires_design_review", smallestPattern: Math.min(...patternRows.map((row) => row.count)) },
      ],
      diagnostics: [
        { name: "monotone missingness", status: monotone ? "monotone" : "non-monotone", variableOrder: monotoneOrder.map((entry) => entry.name), firstViolatingRow: monotoneViolationRow, detail: monotone ? "A monotone pattern admits sequential regression imputation without iteration." : "A non-monotone pattern requires chained equations or full-information likelihood." },
        { name: "EM convergence", status: "converged", iterations: em.iterations, maxParameterChange: em.change, tolerance: options.tolerance, detail: "Maximum-likelihood mean and covariance (divisor n) under an ignorable mechanism." },
        { name: "pattern concentration", status: "evaluated", patterns: patternRows.length, largestPatternShare: patternRows[0].percentOfRows / 100, completeCaseShare: completeRows / n },
        { name: "complete-case loss", status: completeRows / n < 0.9 ? "material" : "limited", rowsLostToCompleteCaseAnalysis: n - completeRows, detail: "Rows a complete-case analysis would silently discard." },
      ],
      artifacts: [
        H.tableArtifact(`Missingness by variable: ${parsed.datasetLabel}`, "Observed and missing counts per variable with the observed-value mean and standard deviation.", [
          { key: "variable", label: "Variable", type: "string" },
          { key: "observed", label: "Observed", type: "number" },
          { key: "missing", label: "Missing", type: "number" },
          { key: "percentMissing", label: "Missing (%)", type: "number" },
          { key: "observedMean", label: "Observed mean", type: "number" },
          { key: "observedSd", label: "Observed SD", type: "number" },
        ], variableRows, ["Observed means are computed on the observed values only and are biased under any mechanism other than MCAR."], "missing-data-variable-summary-table"),
        H.tableArtifact(`Missing-data patterns: ${parsed.datasetLabel}`, "Every distinct pattern of observed variables with its row count. 1 marks an observed variable in the declared variable order.", [
          { key: "pattern", label: "Pattern (1 = observed)", type: "string" },
          { key: "count", label: "Rows", type: "number" },
          { key: "percentOfRows", label: "Rows (%)", type: "number" },
          { key: "variablesObserved", label: "Variables observed", type: "number" },
          { key: "variablesMissing", label: "Variables missing", type: "number" },
          { key: "missingVariables", label: "Missing variables", type: "string" },
        ], patternRows, [`Variable order: ${names.join(", ")}.`], "missing-data-pattern-table"),
        H.tableArtifact(`MCAR test and missingness accounting: ${parsed.datasetLabel}`, "Little's MCAR chi-square with its degrees of freedom and p value, plus the row and cell accounting a reviewer asks for before any imputation.", [
          { key: "statistic", label: "Quantity", type: "string" },
          { key: "value", label: "Value", type: "number" },
        ], testRows, evaluated ? ["Degrees of freedom are the summed count of observed variables across patterns minus the number of variables."] : ["The test was not evaluated: the degrees of freedom are not positive."], "missing-data-mcar-test-table"),
        H.vegaArtifact("missing-data-percent-missing-plot", `Percent missing by variable: ${parsed.datasetLabel}`, {
          data: { values: variableRows },
          mark: { type: "bar" },
          encoding: {
            y: { field: "variable", type: "nominal", title: "Variable", sort: null },
            x: { field: "percentMissing", type: "quantitative", title: "Missing (%)" },
            tooltip: [{ field: "variable" }, { field: "missing" }, { field: "percentMissing", format: ".2f" }],
          },
        }),
        H.vegaArtifact("missing-data-pattern-plot", `Rows per missing-data pattern: ${parsed.datasetLabel}`, {
          data: { values: patternRows },
          mark: { type: "bar" },
          encoding: {
            y: { field: "pattern", type: "nominal", title: "Pattern (1 = observed)", sort: null },
            x: { field: "count", type: "quantitative", title: "Rows" },
            tooltip: [{ field: "pattern" }, { field: "count" }, { field: "missingVariables" }],
          },
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "Before any analysis on a dataset that has holes in it, when the researcher has to state in the methods section how much data is absent, where it is absent, and on what evidence the chosen handling (complete cases, imputation, or weighting) rests.",
    decision: "Whether dropping incomplete rows is defensible, or whether the pattern and the MCAR test force a principled alternative such as multiple imputation or a full-information likelihood.",
    mustShow: "Missing counts and percentages for every variable, every distinct missingness pattern with its row count, whether the pattern is monotone, the number of rows a complete-case analysis would discard, and Little's MCAR chi-square with its degrees of freedom and p value.",
    userGoal: "Write a defensible missing-data paragraph and pick a handling strategy the reviewer will accept instead of silently deleting rows.",
    nextActions: [
      { trigger: "mcar-rejected", action: "run-multiple-imputation-or-weighting-under-a-stated-mar-assumption", reason: "Rejecting MCAR means complete-case analysis can be biased, so the paper needs a method that uses the observed information in the incomplete rows." },
      { trigger: "mcar-not-rejected", action: "report-the-test-and-still-justify-the-handling-choice", reason: "Failing to reject MCAR is weak evidence at small sample sizes and is not a licence to delete rows without saying so." },
      { trigger: "non-monotone-pattern", action: "choose-chained-equations-over-sequential-regression", reason: "A non-monotone pattern cannot be filled in one pass, so the imputation method has to iterate over variables." },
      { trigger: "complete-case-loss-material", action: "report-rows-lost-and-compare-complete-case-with-imputed-results", reason: "A large share of discarded rows changes the effective sample size and the precision claimed in the abstract." },
      { trigger: "one-variable-dominates-the-missingness", action: "review-that-variables-collection-process-before-modelling", reason: "Missingness concentrated in one variable is usually a measurement or instrument problem, not a statistical one." },
    ],
  },
  fixture: {
    data: {
      datasetLabel: "Cardiometabolic cohort",
      variables: [
        { name: "age", values: [49.1, 53.6, 36.6, 42.3, 53.0, 53.3, 41.1, 61.4, 46.6, 55.8, 40.0, 39.1, 51.4, 44.7, 50.0, 42.3, 47.1, 37.3, 24.5, 40.4, 50.4, 49.5, 45.6, 37.5] },
        { name: "bmi", values: [23.8, 25.4, 20.6, null, 23.5, 19.9, 26.7, 24.1, 25.1, null, 20.6, 24.8, 22.5, 23.3, 24.1, null, 25.5, 19.3, 18.6, 23.4, null, 27.7, null, 17.6] },
        { name: "systolic", values: [108.3, 122.2, 111.8, 105.9, 112.7, null, 120.7, 130.0, 111.3, null, 103.4, 92.8, 112.1, 112.6, 103.6, null, 115.9, 99.4, 94.5, 106.7, null, 118.0, null, 99.9] },
        { name: "cholesterol", values: [196.2, 187.4, null, 169.6, 193.5, 197.3, 179.4, null, 181.3, 215.7, 203.0, null, 197.0, 170.7, 200.0, null, 178.7, 165.2, 164.3, 158.5, null, 211.7, null, 179.9] },
      ],
    },
    options: { tolerance: 1e-10, emIterations: 1000 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.descriptive-visualization", "matlab.stats.hypothesis.distribution"] },
  coverage: {
    implementedBoundary: "Missingness accounting (per variable, per pattern, monotone check) and Little's (1988) MCAR chi-square from an EM maximum-likelihood mean and covariance, for 2..24 continuous numeric variables and 4..5000 rows with explicit nulls. No categorical or ordinal variables, no sentinel-code detection, no covariate-dependent (Jamshidian-Jalal) MCAR test, and no pattern-mixture modelling.",
    oracle: {
      level: "external-library-partial",
      evidence: ["contracts/missing-data-scipy-crosscheck.py"],
      verifiedOutputs: ["per-variable observed and missing counts against pandas", "pattern keys and counts against a pandas groupby", "complete-row count against pandas", "EM maximum-likelihood mean and covariance against an independent numpy implementation and against the observed-data score equations", "Little MCAR chi-square, degrees of freedom and p value against a numpy/scipy derivation from the same pattern likelihood"],
      excludedOutputs: ["Little MCAR statistic against a published library implementation (none exists in the numpy/scipy/statsmodels stack)", "monotone classification", "categorical or mixed-type missingness"],
    },
    diagnostic: {
      level: "method-specific-partial",
      emitted: ["monotone missingness", "EM convergence", "pattern concentration", "complete-case loss"],
      limitations: ["does not test MAR or MNAR, which are not testable from observed data", "assumes multivariate normality for the MCAR chi-square", "does not detect sentinel codes used in place of null"],
    },
    knownGaps: ["no external library oracle for Little's MCAR statistic in the Python stack; the crosscheck is an independent re-derivation, not library parity", "covariate-dependent MCAR tests (Jamshidian-Jalal)", "categorical and mixed-type missingness patterns", "pattern-mixture and selection models for MNAR"],
  },
};

// ---------------------------------------------------------------------------------------------
// multiple_imputation_regression
// ---------------------------------------------------------------------------------------------

/**
 * One predictive-mean-matching draw for variable `target` given the currently completed matrix.
 *
 * Follows the standard MICE recipe (van Buuren, matchtype 1): the observed cases are regressed on
 * the other variables, a Bayesian draw (beta*, sigma*) is taken from the normal-inverse-chi-square
 * posterior, predicted means for the observed cases use beta-hat while predicted means for the
 * missing cases use beta*, and each missing case takes the observed value of one of its `donors`
 * nearest predicted means, chosen uniformly at random.
 */
function pmmDraw(filled, masks, target, order, donors, prng, H, budget) {
  const n = filled[0].length;
  const others = order.filter((index) => index !== target);
  const design = (row) => [1, ...others.map((index) => filled[index][row])];
  const observedRows = [];
  const missingRows = [];
  for (let row = 0; row < n; row += 1) (masks[target][row] ? missingRows : observedRows).push(row);
  if (!missingRows.length) return 0;
  const x = observedRows.map(design);
  const y = observedRows.map((row) => filled[target][row]);
  const p = x[0].length;
  if (y.length <= p) H.fail("STAT_INSUFFICIENT_SAMPLE", "an imputation model has fewer observed rows than coefficients");
  const fit = fitOls(y, x, H, budget);
  const df = fit.dfResidual;
  const chiSquare = prng.nextChiSquare(df);
  if (!(chiSquare > 0)) H.fail("STAT_NUMERIC_FAILURE", "posterior chi-square draw collapsed to zero");
  const sigmaStar = Math.sqrt(fit.sse / chiSquare);
  const lower = choleskyLower(fit.inverse, H, "imputation model cross-product matrix is not positive definite");
  const z = Array.from({ length: p }, () => prng.nextNormal());
  const betaStar = fit.beta.map((value, i) => {
    let shift = 0;
    for (let k = 0; k <= i; k += 1) shift += lower[i][k] * z[k];
    return value + sigmaStar * shift;
  });
  const predictedObserved = x.map((row) => row.reduce((total, value, index) => total + value * fit.beta[index], 0));
  for (const row of missingRows) {
    budget.check(observedRows.length);
    const line = design(row);
    let predicted = 0;
    for (let index = 0; index < p; index += 1) predicted += line[index] * betaStar[index];
    const ranked = predictedObserved
      .map((value, index) => ({ distance: Math.abs(value - predicted), index }))
      .sort((left, right) => left.distance - right.distance || left.index - right.index);
    const pool = Math.min(donors, ranked.length);
    const chosen = ranked[prng.nextIndex(pool)].index;
    filled[target][row] = y[chosen];
  }
  return missingRows.length;
}

const multipleImputationRegression = {
  method: "multiple_imputation_regression",
  family: "missing-data",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    imputations: {
      schema: { type: "integer", minimum: 2, maximum: 100, description: "Number of imputed datasets m. Declare it before running; it fixes the Monte Carlo error of the pooled estimate." },
      default: 20,
      parse(value, H, path) { return H.integer(value, 2, 100, path); },
    },
    cycles: {
      schema: { type: "integer", minimum: 1, maximum: 50, description: "Chained-equation cycles run within each imputed dataset before the analysis model is fitted." },
      default: 10,
      parse(value, H, path) { return H.integer(value, 1, 50, path); },
    },
    donors: {
      schema: { type: "integer", minimum: 1, maximum: 20, description: "Size of the predictive-mean-matching donor pool." },
      default: 5,
      parse(value, H, path) { return H.integer(value, 1, 20, path); },
    },
    seed: PRNG.seedOption,
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["y", "predictors"],
    properties: {
      y: { type: "array", minItems: 8, maxItems: MAX_ROWS, items: { type: ["number", "null"] } },
      predictors: columnSchema(1, MAX_PREDICTORS, true),
      outcomeLabel: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["y", "predictors", "outcomeLabel"], "data");
    const y = gappyVector(data.y, "data.y", H, 8);
    const predictors = parseColumns(data.predictors, "data.predictors", "Predictor", H, { minColumns: 1, maxColumns: MAX_PREDICTORS, rows: y.length, allowMissing: true });
    const n = y.length;
    const p = predictors.columns.length + 1;
    if (n <= p + 2) H.fail("STAT_INSUFFICIENT_SAMPLE", "multiple_imputation_regression requires more rows than fitted coefficients plus two");
    const anyMissing = y.some((value) => value === null) || predictors.columns.some((column) => column.some((value) => value === null));
    if (!anyMissing) H.fail("STAT_INVALID_INPUT", "no value is missing; fit linear_regression directly instead of imputing");
    const columns = [...predictors.columns, y];
    const names = [...predictors.names, H.label(data.outcomeLabel, "Outcome", "data.outcomeLabel")];
    columns.forEach((column, index) => {
      const observed = observedOf(column);
      if (observed.length <= p) H.fail("STAT_INSUFFICIENT_SAMPLE", `variable ${names[index]} has too few observed values (${observed.length}) to fit its imputation model`);
      const { min, max } = H.minMax(observed);
      if (min === max) H.fail("STAT_DEGENERATE", `variable ${names[index]} is constant among its observed values`);
    });
    return { y, names, columns, predictorNames: predictors.names, n, outcomeLabel: names[names.length - 1] };
  },
  analyze(parsed, options, budget, H) {
    const { columns, names, predictorNames, n } = parsed;
    const variableCount = columns.length;
    const outcomeIndex = variableCount - 1;
    const masks = columns.map((column) => column.map((value) => value === null));
    const missingCounts = masks.map((mask) => mask.reduce((total, flag) => total + (flag ? 1 : 0), 0));
    // Visit order: predictors in declared order, then the outcome last.
    const order = Array.from({ length: variableCount }, (_, index) => index);
    const incomplete = order.filter((index) => missingCounts[index] > 0);
    const terms = ["Intercept", ...predictorNames];
    const p = terms.length;
    const dfComplete = n - p;
    if (dfComplete <= 0) H.fail("STAT_INSUFFICIENT_SAMPLE", "the analysis model has no residual degrees of freedom");

    const prng = PRNG.createPrng(options.seed);
    const perImputation = [];
    const cellRows = [];
    for (let imputation = 1; imputation <= options.imputations; imputation += 1) {
      // Fresh chain: each missing cell starts at a random observed value of its own variable.
      const filled = columns.map((column) => column.slice());
      for (const index of incomplete) {
        const observed = observedOf(columns[index]);
        for (let row = 0; row < n; row += 1) {
          if (masks[index][row]) filled[index][row] = observed[prng.nextIndex(observed.length)];
        }
      }
      for (let cycle = 0; cycle < options.cycles; cycle += 1) {
        for (const index of incomplete) {
          budget.check(n);
          pmmDraw(filled, masks, index, order, options.donors, prng, H, budget);
        }
      }
      for (const index of incomplete) {
        const imputed = [];
        for (let row = 0; row < n; row += 1) if (masks[index][row]) imputed.push(filled[index][row]);
        cellRows.push({
          imputation,
          variable: names[index],
          imputedCells: imputed.length,
          meanImputed: H.mean(imputed, budget),
          sdImputed: imputed.length >= 2 ? Math.sqrt(H.variance(imputed, true, budget)) : null,
        });
      }
      const x = Array.from({ length: n }, (_, row) => [1, ...predictorNames.map((_unused, index) => filled[index][row])]);
      const yFilled = filled[outcomeIndex];
      const fit = fitOls(yFilled, x, H, budget);
      if (!(fit.sse > 0)) H.fail("STAT_DEGENERATE", "an imputed dataset produced a perfect fit with no residual variance");
      const sigmaSquared = fit.sse / fit.dfResidual;
      const estimates = fit.beta.map((value) => finiteOrFail(value, "an imputed-dataset coefficient is not finite", H));
      const variances = terms.map((_term, index) => sigmaSquared * fit.inverse[index][index]);
      perImputation.push({ imputation, estimates, variances, residualVariance: sigmaSquared });
    }

    const m = options.imputations;
    const tCriticalCache = new Map();
    const pooled = terms.map((term, index) => {
      const draws = perImputation.map((entry) => entry.estimates[index]);
      const within = perImputation.map((entry) => entry.variances[index]);
      const qBar = H.mean(draws, budget);
      const uBar = H.mean(within, budget);
      let between = 0;
      for (const value of draws) between += (value - qBar) ** 2;
      between /= m - 1;
      const total = uBar + (1 + 1 / m) * between;
      if (!(total > 0)) H.fail("STAT_DEGENERATE", `pooled total variance for ${term} is not positive`);
      const relativeIncrease = ((1 + 1 / m) * between) / uBar;
      const lambdaRaw = ((1 + 1 / m) * between) / total;
      const lambda = Math.max(lambdaRaw, LAMBDA_FLOOR);
      const dfOld = (m - 1) / (lambda * lambda);
      const dfObserved = ((dfComplete + 1) / (dfComplete + 3)) * dfComplete * (1 - lambda);
      const dfAdjusted = (dfOld * dfObserved) / (dfOld + dfObserved);
      const fmi = (relativeIncrease + 2 / (dfAdjusted + 3)) / (relativeIncrease + 1);
      const standardError = Math.sqrt(total);
      const statistic = qBar / standardError;
      const pValue = H.pFromT(statistic, dfAdjusted, "two-sided");
      if (!tCriticalCache.has(dfAdjusted)) tCriticalCache.set(dfAdjusted, H.tCritical(options.confidenceLevel, dfAdjusted));
      const half = tCriticalCache.get(dfAdjusted) * standardError;
      for (const value of [qBar, uBar, between, total, relativeIncrease, lambdaRaw, dfOld, dfObserved, dfAdjusted, fmi, statistic, pValue]) {
        finiteOrFail(value, `pooled quantity for ${term} is not finite`, H);
      }
      return {
        term,
        estimate: qBar,
        standardError,
        withinVariance: uBar,
        betweenVariance: between,
        totalVariance: total,
        relativeIncrease,
        lambda: lambdaRaw,
        fractionMissingInformation: fmi,
        df: dfAdjusted,
        dfOld,
        dfObserved,
        statistic,
        pValue,
        lower: qBar - half,
        upper: qBar + half,
      };
    });

    const pooledRows = pooled.map((row) => ({
      term: row.term,
      estimate: row.estimate,
      standardError: row.standardError,
      t: row.statistic,
      df: row.df,
      pValue: row.pValue,
      lower: row.lower,
      upper: row.upper,
      fractionMissingInformation: row.fractionMissingInformation,
    }));
    const varianceRows = pooled.map((row) => ({
      term: row.term,
      withinVariance: row.withinVariance,
      betweenVariance: row.betweenVariance,
      totalVariance: row.totalVariance,
      relativeIncreaseInVariance: row.relativeIncrease,
      lambda: row.lambda,
      fractionMissingInformation: row.fractionMissingInformation,
      dfBarnardRubin: row.df,
    }));
    const imputationRows = [];
    for (const entry of perImputation) {
      terms.forEach((term, index) => {
        imputationRows.push({
          imputation: entry.imputation,
          term,
          estimate: entry.estimates[index],
          standardError: Math.sqrt(entry.variances[index]),
        });
      });
    }
    const meanResidualVariance = H.mean(perImputation.map((entry) => entry.residualVariance), budget);
    const level = options.confidenceLevel;
    const maxFmi = Math.max(...pooled.map((row) => row.fractionMissingInformation));

    return {
      sample: {
        n,
        predictors: predictorNames.length,
        coefficients: p,
        completeRows: Array.from({ length: n }, (_, row) => row).filter((row) => masks.every((mask) => !mask[row])).length,
        imputations: m,
        cycles: options.cycles,
        donors: options.donors,
        seed: options.seed,
        generator: prng.generator,
        draws: prng.drawCount(),
        completeDataDf: dfComplete,
      },
      estimates: pooled.map((row) => ({
        name: row.term,
        estimate: row.estimate,
        standardError: row.standardError,
        pooling: "Rubin (1987) rules over m imputed datasets",
        fractionMissingInformation: row.fractionMissingInformation,
      })),
      tests: pooled.map((row) => ({
        name: `pooled coefficient ${row.term} = 0`,
        statistic: row.statistic,
        distribution: "t",
        df: row.df,
        pValue: row.pValue,
        method: "Rubin total variance with Barnard-Rubin (1999) adjusted degrees of freedom",
      })),
      confidenceIntervals: pooled.map((row) => ({
        parameter: row.term,
        level,
        lower: row.lower,
        upper: row.upper,
        method: "pooled estimate +/- t(Barnard-Rubin df) x sqrt(total variance)",
        df: row.df,
      })),
      effectSizes: [
        { name: "largest fraction of missing information", estimate: maxFmi, term: pooled.reduce((worst, row) => (row.fractionMissingInformation > worst.fractionMissingInformation ? row : worst)).term, interpretationBoundary: "share of the coefficient's uncertainty attributable to the missing data, not an effect on the outcome scale" },
        { name: "mean residual variance across imputations", estimate: meanResidualVariance, interpretationBoundary: "averaged, not pooled by Rubin's rules; reported as a scale descriptor only" },
      ],
      assumptions: [
        { name: "missing at random given the imputation model variables", status: "not_established", note: "MAR is not testable from the observed data; it is an assumption the paper must argue for." },
        { name: "imputation model is congenial with the analysis model", status: "requires_design_review", note: "Every analysis variable enters every imputation model here, including the outcome; interactions and non-linear terms do not." },
        { name: "linear analysis model with normal residuals", status: "not_established" },
        { name: "number of imputations declared before running", status: "verified", imputations: m, note: "m is a caller option, so the pooled estimate is not chosen after seeing the result." },
        { name: "donor pool is non-empty for every incomplete variable", status: "verified", donors: options.donors },
      ],
      diagnostics: [
        { name: "imputation stream", status: "evaluated", generator: prng.generator, seed: options.seed, imputations: m, cycles: options.cycles, donors: options.donors, visitOrder: incomplete.map((index) => names[index]), draws: prng.drawCount(), detail: "Deterministic in the seed: the same request reproduces the same imputed values." },
        { name: "missingness entering the model", status: "evaluated", perVariable: names.map((name, index) => ({ variable: name, missing: missingCounts[index], percentMissing: (100 * missingCounts[index]) / n })), completeRows: Array.from({ length: n }, (_, row) => row).filter((row) => masks.every((mask) => !mask[row])).length },
        { name: "fraction of missing information screen", status: maxFmi > 0.5 ? "high" : "acceptable", maxFractionMissingInformation: maxFmi, termsAbove0p5: pooled.filter((row) => row.fractionMissingInformation > 0.5).map((row) => row.term), detail: "A high fraction of missing information means the reported precision depends heavily on the imputation model and on m." },
        { name: "between-imputation variability", status: "evaluated", maxRelativeIncreaseInVariance: Math.max(...pooled.map((row) => row.relativeIncrease)), minBarnardRubinDf: Math.min(...pooled.map((row) => row.df)), completeDataDf: dfComplete },
        { name: "pooling boundary", status: "declared", detail: "Rubin's rules pool the coefficients only. The residual variance, R-squared and any model-fit statistic are not pooled and are reported as averages.", lambdaFloor: LAMBDA_FLOOR },
      ],
      artifacts: [
        H.tableArtifact(`Pooled coefficients: ${parsed.outcomeLabel}`, `Rubin-pooled coefficients over ${m} imputations with Barnard-Rubin degrees of freedom and ${Math.round(level * 100)}% intervals.`, [
          { key: "term", label: "Term", type: "string" },
          { key: "estimate", label: "Estimate", type: "number" },
          { key: "standardError", label: "SE", type: "number" },
          { key: "t", label: "t", type: "number" },
          { key: "df", label: "df", type: "number" },
          { key: "pValue", label: "p", type: "number" },
          { key: "lower", label: `Lower ${Math.round(level * 100)}%`, type: "number" },
          { key: "upper", label: `Upper ${Math.round(level * 100)}%`, type: "number" },
          { key: "fractionMissingInformation", label: "FMI", type: "number" },
        ], pooledRows, ["Degrees of freedom are the Barnard-Rubin (1999) adjustment, which cannot exceed the complete-data residual degrees of freedom."], "missing-data-mi-pooled-table"),
        H.tableArtifact(`Rubin variance decomposition: ${parsed.outcomeLabel}`, "Within-imputation, between-imputation, and total variance per coefficient with the relative increase in variance and the fraction of missing information.", [
          { key: "term", label: "Term", type: "string" },
          { key: "withinVariance", label: "Within (Ubar)", type: "number" },
          { key: "betweenVariance", label: "Between (B)", type: "number" },
          { key: "totalVariance", label: "Total (T)", type: "number" },
          { key: "relativeIncreaseInVariance", label: "RIV", type: "number" },
          { key: "lambda", label: "lambda", type: "number" },
          { key: "fractionMissingInformation", label: "FMI", type: "number" },
          { key: "dfBarnardRubin", label: "df (Barnard-Rubin)", type: "number" },
        ], varianceRows, ["T = Ubar + (1 + 1/m) B; RIV = (1 + 1/m) B / Ubar; lambda = (1 + 1/m) B / T."], "missing-data-mi-variance-table"),
        H.tableArtifact(`Per-imputation estimates: ${parsed.outcomeLabel}`, "The analysis model refitted on each imputed dataset, before pooling.", [
          { key: "imputation", label: "Imputation", type: "number" },
          { key: "term", label: "Term", type: "string" },
          { key: "estimate", label: "Estimate", type: "number" },
          { key: "standardError", label: "SE", type: "number" },
        ], imputationRows, ["Spread across imputations is the between-imputation variance B."], "missing-data-mi-imputation-table"),
        H.tableArtifact(`Imputed cells: ${parsed.outcomeLabel}`, "How many cells each imputation filled per variable, and the mean and spread of the values it drew.", [
          { key: "imputation", label: "Imputation", type: "number" },
          { key: "variable", label: "Variable", type: "string" },
          { key: "imputedCells", label: "Cells imputed", type: "number" },
          { key: "meanImputed", label: "Mean imputed", type: "number" },
          { key: "sdImputed", label: "SD imputed", type: "number" },
        ], cellRows, ["Predictive mean matching draws only from observed values, so imputed values stay inside the observed range."], "missing-data-mi-cell-table"),
        H.vegaArtifact("missing-data-mi-pooled-plot", `Pooled coefficients with ${Math.round(level * 100)}% intervals: ${parsed.outcomeLabel}`, {
          data: { values: pooledRows },
          layer: [
            { mark: { type: "rule", strokeWidth: 2 }, encoding: { y: { field: "term", type: "nominal", title: "Term", sort: null }, x: { field: "lower", type: "quantitative", title: "Coefficient" }, x2: { field: "upper" } } },
            { mark: { type: "point", filled: true, size: 90 }, encoding: { y: { field: "term", type: "nominal", sort: null }, x: { field: "estimate", type: "quantitative" }, tooltip: [{ field: "term" }, { field: "estimate", format: ".4f" }, { field: "lower", format: ".4f" }, { field: "upper", format: ".4f" }, { field: "fractionMissingInformation", format: ".4f" }] } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When a linear regression would otherwise be fitted on complete cases only, and the discarded rows are numerous enough or systematic enough that deleting them would change the coefficient or overstate its precision.",
    decision: "Whether the reported coefficient and interval should come from the imputed analysis rather than from complete cases, and whether the number of imputations is large enough for the amount of information that is missing.",
    mustShow: "The pooled coefficient with its standard error, Barnard-Rubin degrees of freedom, interval and p value; the within, between and total variance behind that standard error; the relative increase in variance and fraction of missing information per coefficient; and the generator, seed, number of imputations and cycles that make the result reproducible.",
    userGoal: "Report a regression that uses every row's observed information under a stated MAR assumption, and defend both the imputation model and the number of imputations to a reviewer.",
    nextActions: [
      { trigger: "fraction-of-missing-information-high", action: "increase-imputations-and-rerun-with-the-same-seed-family", reason: "When most of a coefficient's uncertainty comes from the missing data, the pooled interval itself is unstable across imputation counts." },
      { trigger: "pooled-and-complete-case-estimates-disagree", action: "report-both-and-argue-the-missingness-assumption-explicitly", reason: "A material difference between the two is exactly the evidence a reviewer needs to judge whether the deletion would have been misleading." },
      { trigger: "imputed-values-cluster-at-the-observed-range-edge", action: "review-the-imputation-model-before-trusting-the-pooled-estimate", reason: "Predictive mean matching can only reuse observed values, so an edge pile-up signals that the model has no donors in the relevant region." },
      { trigger: "barnard-rubin-df-far-below-complete-data-df", action: "state-the-reduced-degrees-of-freedom-next-to-the-p-value", reason: "The p value is being read on a much shorter reference distribution than the complete-data one, and that has to be visible." },
      { trigger: "pooled-inference-committed", action: "bind-seed-imputations-and-cycles-to-the-report", reason: "An imputed result is only reproducible when the generator, seed, m and cycle count travel with the numbers." },
    ],
  },
  fixture: {
    data: {
      outcomeLabel: "Recovery score",
      y: [7.13, null, 6.44, 2.19, 5.29, 9.15, 4.13, -2.34, 10.59, 4.42, 2.8, null, 6.13, 13.71, 11.56, 1.23, 6.75, 1.54, 10.2, 6.21, 2.46, 4.5, null, 4.47, 1.04, 9.16, 1.62, 6.86, -1.01, 9.23, null, 1.09, -1.01, 7.25, 5.19, -1.57, 5.76, 0.18, 8.95, 2.98],
      predictors: [
        { name: "dose", values: [11.86, 6.01, null, 7.26, 12.0, 10.15, 10.22, null, 13.9, 8.35, 9.69, 5.95, 8.69, null, 12.85, 9.97, 12.52, 7.55, 7.87, null, 4.49, 9.77, 11.34, 7.09, 2.11, 14.22, null, 11.15, 1.67, 10.44, 8.33, 8.32, 7.73, null, 10.26, 7.33, 9.66, 8.77, 12.43, 12.25] },
        { name: "baseline", values: [4.14, 9.32, 3.9, 6.78, null, 2.44, 6.19, 7.32, 3.55, null, 5.29, 8.29, 4.62, 0.83, 2.53, 7.8, 5.93, null, -0.12, 5.73, 5.06, 5.2, 5.19, 3.64, 4.3, 3.71, 4.96, 4.66, null, 3.26, 3.42, 6.54, 5.37, 4.77, 5.26, null, 4.08, 6.81, null, 7.94] },
        { name: "age", values: [0.37, 3.15, 3.22, 0.16, 2.11, 0.61, 2.41, 1.28, 1.9, 2.14, 2.49, 0.92, 0.89, 2.18, 2.25, -0.1, 2.85, 2.26, 0.92, 1.35, 3.18, 2.23, 1.83, 0.79, -0.11, 0.22, 1.65, 2.05, 1.76, 2.67, 1.61, 2.97, -1.19, 4.41, 1.13, 1.22, 1.82, 0.89, 2.32, 1.45] },
      ],
    },
    options: { imputations: 10, cycles: 5, donors: 5, seed: 20240901, confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression", "matlab.stats.descriptive-visualization"] },
  coverage: {
    implementedBoundary: "Multiple imputation by chained equations with predictive mean matching for continuous variables (1..12 numeric predictors plus a numeric outcome, 8..5000 rows), a seeded xoshiro128** stream, a linear analysis model with an intercept, and Rubin (1987) pooling with Barnard-Rubin (1999) adjusted degrees of freedom, relative increase in variance and fraction of missing information. No categorical or binary variables, no interaction or non-linear terms in the imputation models, no passive imputation, no multilevel imputation, and no pooling of R-squared or model-fit statistics.",
    oracle: {
      level: "external-library-partial",
      evidence: ["contracts/missing-data-scipy-crosscheck.py"],
      verifiedOutputs: ["per-imputation coefficients and standard errors against statsmodels.OLS refitted on the independently reconstructed completed datasets", "imputed-cell counts, means and standard deviations against the Python port of the seeded chained-equations stream", "pooled estimate, within, between and total variance against a numpy implementation of Rubin's rules", "relative increase in variance, lambda and Barnard-Rubin degrees of freedom against a numpy derivation", "fraction of missing information against the same derivation", "pooled t statistic, p value and confidence bounds against scipy.stats.t"],
      excludedOutputs: ["statsmodels.imputation.mice imputed values (its predictive mean matching uses a different generator, so only the pooling algebra is comparable)", "R mice numerical parity", "categorical or binary imputation", "pooled R-squared"],
    },
    diagnostic: {
      level: "method-specific-partial",
      emitted: ["imputation stream", "missingness entering the model", "fraction of missing information screen", "between-imputation variability", "pooling boundary"],
      limitations: ["does not test MAR", "no chain convergence trace across cycles", "no imputation-model fit diagnostic beyond the imputed-cell summary"],
    },
    knownGaps: ["no external library reproduces the seeded imputed values, so imputation parity is against an independent Python port of the same algorithm rather than against mice or statsmodels", "categorical, binary and count variables", "interactions, splines and passive imputation", "multilevel and longitudinal imputation", "pooled R-squared and likelihood-ratio tests across imputations", "chain convergence diagnostics such as between-chain variance across cycles"],
  },
};

// ---------------------------------------------------------------------------------------------
// inverse_probability_weighting
// ---------------------------------------------------------------------------------------------

/** Logistic regression by iteratively reweighted least squares. Deterministic; no random start. */
function fitLogistic(response, x, tolerance, maxIterations, H, budget) {
  const n = x.length;
  const p = x[0].length;
  let beta = Array(p).fill(0);
  let iterations = 0;
  let converged = false;
  let change = null;
  let inverse = null;
  for (; iterations < maxIterations; iterations += 1) {
    const eta = x.map((row) => row.reduce((total, value, index) => total + value * beta[index], 0));
    const probability = eta.map((value) => H.sigmoid(value));
    const weights = probability.map((value) => Math.max(value * (1 - value), 1e-10));
    const bread = Array.from({ length: p }, () => Array(p).fill(0));
    const score = Array(p).fill(0);
    for (let row = 0; row < n; row += 1) {
      budget.check(p);
      const residual = response[row] - probability[row];
      for (let a = 0; a < p; a += 1) {
        score[a] += x[row][a] * residual;
        for (let b = 0; b < p; b += 1) bread[a][b] += weights[row] * x[row][a] * x[row][b];
      }
    }
    inverse = H.invert(bread);
    const step = inverse.map((row) => row.reduce((total, value, index) => total + value * score[index], 0));
    const next = beta.map((value, index) => value + step[index]);
    change = Math.max(...step.map((value) => Math.abs(value)));
    beta = next;
    if (!beta.every((value) => Number.isFinite(value))) H.fail("STAT_NUMERIC_FAILURE", "response propensity model diverged");
    if (change < tolerance) {
      converged = true;
      iterations += 1;
      break;
    }
  }
  if (!converged) H.fail("STAT_NON_CONVERGENCE", `response propensity model did not converge within ${maxIterations} iterations`);
  const eta = x.map((row) => row.reduce((total, value, index) => total + value * beta[index], 0));
  const probability = eta.map((value) => H.sigmoid(value));
  const bread = Array.from({ length: p }, () => Array(p).fill(0));
  for (let row = 0; row < n; row += 1) {
    const weight = Math.max(probability[row] * (1 - probability[row]), 1e-10);
    for (let a = 0; a < p; a += 1) for (let b = 0; b < p; b += 1) bread[a][b] += weight * x[row][a] * x[row][b];
  }
  return { beta, probability, covariance: H.invert(bread), iterations, change };
}

const inverseProbabilityWeighting = {
  method: "inverse_probability_weighting",
  family: "missing-data",
  analysisModel: { families: ["lm", "glm"], distributions: [null, "normal", "gaussian", "binomial", "bernoulli"], links: [null, "identity", "logit"] },
  optionKeys: ["confidenceLevel", "tolerance", "maxIterations", "timeoutMs"],
  customOptions: {
    truncationQuantile: {
      schema: { type: "number", minimum: 0, maximum: 0.2, description: "Upper quantile at which the weights are truncated (0 disables truncation). 0.01 trims the top 1% of weights to that quantile." },
      default: 0,
      parse(value, H, path) {
        const parsed = H.finiteNumber(value, path);
        if (parsed < 0 || parsed > 0.2) H.fail("STAT_INVALID_INPUT", `${path} must be in [0, 0.2]`);
        return parsed;
      },
    },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["y", "predictors"],
    properties: {
      y: { type: "array", minItems: 8, maxItems: MAX_ROWS, items: { type: ["number", "null"] } },
      predictors: columnSchema(1, MAX_PREDICTORS, false),
      auxiliary: columnSchema(1, MAX_PREDICTORS, false),
      outcomeLabel: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["y", "predictors", "auxiliary", "outcomeLabel"], "data");
    const y = gappyVector(data.y, "data.y", H, 8);
    const predictors = parseColumns(data.predictors, "data.predictors", "Predictor", H, { minColumns: 1, maxColumns: MAX_PREDICTORS, rows: y.length, allowMissing: false });
    const auxiliary = data.auxiliary === undefined
      ? { names: [], columns: [] }
      : parseColumns(data.auxiliary, "data.auxiliary", "Auxiliary", H, { minColumns: 1, maxColumns: MAX_PREDICTORS, rows: y.length, allowMissing: false });
    for (const name of auxiliary.names) {
      if (predictors.names.includes(name)) H.fail("STAT_INVALID_INPUT", `data.auxiliary reuses the analysis predictor name ${name}`);
    }
    const n = y.length;
    const respondents = y.filter((value) => value !== null).length;
    if (respondents === n) H.fail("STAT_INVALID_INPUT", "no outcome is missing; fit linear_regression directly instead of reweighting");
    if (respondents <= predictors.columns.length + 2) H.fail("STAT_INSUFFICIENT_SAMPLE", "too few observed outcomes to fit the weighted analysis model");
    const responseTerms = predictors.columns.length + auxiliary.columns.length + 1;
    if (n <= responseTerms + 2) H.fail("STAT_INSUFFICIENT_SAMPLE", "too few rows to fit the response propensity model");
    for (const [index, column] of [...predictors.columns, ...auxiliary.columns].entries()) {
      const { min, max } = H.minMax(column);
      if (min === max) H.fail("STAT_DEGENERATE", `covariate ${[...predictors.names, ...auxiliary.names][index]} is constant`);
    }
    return {
      y,
      n,
      respondents,
      predictorNames: predictors.names,
      predictorColumns: predictors.columns,
      auxiliaryNames: auxiliary.names,
      auxiliaryColumns: auxiliary.columns,
      outcomeLabel: H.label(data.outcomeLabel, "Outcome", "data.outcomeLabel"),
    };
  },
  analyze(parsed, options, budget, H) {
    const { y, n, predictorNames, predictorColumns, auxiliaryNames, auxiliaryColumns } = parsed;
    const responseNames = ["Intercept", ...predictorNames, ...auxiliaryNames];
    const responseColumns = [...predictorColumns, ...auxiliaryColumns];
    const responseDesign = Array.from({ length: n }, (_, row) => [1, ...responseColumns.map((column) => column[row])]);
    const response = y.map((value) => (value === null ? 0 : 1));

    const propensity = fitLogistic(response, responseDesign, options.tolerance, options.maxIterations, H, budget);
    const minPropensity = Math.min(...propensity.probability);
    const maxPropensity = Math.max(...propensity.probability);
    if (!(minPropensity > 1e-6)) H.fail("STAT_DEGENERATE", "a fitted response probability is effectively zero; the positivity condition inverse probability weighting requires is violated");

    const respondentRows = [];
    for (let row = 0; row < n; row += 1) if (y[row] !== null) respondentRows.push(row);
    const responseRate = respondentRows.length / n;
    const rawWeights = respondentRows.map((row) => 1 / propensity.probability[row]);
    let weights = rawWeights.map((value) => responseRate * value);
    let truncatedCount = 0;
    let truncationCut = null;
    if (options.truncationQuantile > 0) {
      truncationCut = H.quantileR7(H.sorted(weights), 1 - options.truncationQuantile);
      weights = weights.map((value) => {
        if (value > truncationCut) {
          truncatedCount += 1;
          return truncationCut;
        }
        return value;
      });
    }

    const terms = ["Intercept", ...predictorNames];
    const p = terms.length;
    const x = respondentRows.map((row) => [1, ...predictorColumns.map((column) => column[row])]);
    const yObserved = respondentRows.map((row) => y[row]);
    const nr = respondentRows.length;
    if (nr <= p) H.fail("STAT_INSUFFICIENT_SAMPLE", "weighted analysis needs more respondents than coefficients");

    // Weighted least squares: beta = (XᵀWX)⁻¹ XᵀWy.
    const bread = Array.from({ length: p }, () => Array(p).fill(0));
    const rhs = Array(p).fill(0);
    for (let i = 0; i < nr; i += 1) {
      budget.check(p);
      const weight = weights[i];
      for (let a = 0; a < p; a += 1) {
        rhs[a] += weight * x[i][a] * yObserved[i];
        for (let b = 0; b < p; b += 1) bread[a][b] += weight * x[i][a] * x[i][b];
      }
    }
    const inverseBread = H.invert(bread);
    const beta = inverseBread.map((row) => row.reduce((total, value, index) => total + value * rhs[index], 0));
    const residuals = x.map((row, i) => yObserved[i] - row.reduce((total, value, index) => total + value * beta[index], 0));
    let weightedSse = 0;
    for (let i = 0; i < nr; i += 1) weightedSse += weights[i] * residuals[i] * residuals[i];
    const dfResidual = nr - p;
    const modelVariance = (weightedSse / dfResidual);
    // Sandwich (HC0) for weighted least squares: (XᵀWX)⁻¹ [Σ wᵢ² eᵢ² xᵢ xᵢᵀ] (XᵀWX)⁻¹.
    const scoreResiduals = residuals.map((value, i) => weights[i] * value);
    const sandwich = H.sandwichCovariance(x, inverseBread, scoreResiduals, Array(nr).fill(0), "hc0", budget);

    const completeCase = fitOls(yObserved, x, H, budget);
    const completeCaseVariance = completeCase.sse / completeCase.dfResidual;

    const tCriticalValue = H.tCritical(options.confidenceLevel, dfResidual);
    const coefficientRows = terms.map((term, index) => {
      const estimate = finiteOrFail(beta[index], `weighted coefficient ${term} is not finite`, H);
      const variance = sandwich[index][index];
      if (!(variance > 0)) H.fail("STAT_DEGENERATE", `sandwich variance for ${term} is not positive`);
      const standardError = Math.sqrt(variance);
      const statistic = estimate / standardError;
      const completeCaseEstimate = completeCase.beta[index];
      const completeCaseSe = Math.sqrt(completeCaseVariance * completeCase.inverse[index][index]);
      return {
        term,
        estimate,
        sandwichSe: standardError,
        modelSe: Math.sqrt(modelVariance * inverseBread[index][index]),
        t: statistic,
        df: dfResidual,
        pValue: H.pFromT(statistic, dfResidual, "two-sided"),
        lower: estimate - tCriticalValue * standardError,
        upper: estimate + tCriticalValue * standardError,
        completeCaseEstimate,
        completeCaseSe,
        difference: estimate - completeCaseEstimate,
      };
    });

    const propensityRows = responseNames.map((term, index) => {
      const estimate = propensity.beta[index];
      const standardError = Math.sqrt(propensity.covariance[index][index]);
      const statistic = estimate / standardError;
      return {
        term,
        coefficient: estimate,
        standardError,
        z: statistic,
        pValue: H.pFromNormal(statistic, "two-sided"),
        oddsRatio: H.finiteExp(estimate, "response propensity odds ratio"),
      };
    });

    const sortedWeights = H.sorted(weights);
    const weightMean = H.mean(weights, budget);
    const weightSd = Math.sqrt(H.variance(weights, true, budget));
    let weightSum = 0;
    let weightSquareSum = 0;
    for (const weight of weights) {
      weightSum += weight;
      weightSquareSum += weight * weight;
    }
    const effectiveSampleSize = (weightSum * weightSum) / weightSquareSum;
    const coefficientOfVariation = weightSd / weightMean;
    const weightRows = [
      { statistic: "respondents (analysed rows)", value: nr },
      { statistic: "non-respondents (rows reweighted away)", value: n - nr },
      { statistic: "response rate", value: responseRate },
      { statistic: "minimum fitted response probability", value: minPropensity },
      { statistic: "maximum fitted response probability", value: maxPropensity },
      { statistic: "minimum stabilised weight", value: sortedWeights[0] },
      { statistic: "median stabilised weight", value: H.quantileR7(sortedWeights, 0.5) },
      { statistic: "mean stabilised weight", value: weightMean },
      { statistic: "maximum stabilised weight", value: sortedWeights[sortedWeights.length - 1] },
      { statistic: "stabilised weight SD", value: weightSd },
      { statistic: "coefficient of variation of weights", value: coefficientOfVariation },
      { statistic: "design effect (1 + CV^2)", value: 1 + coefficientOfVariation * coefficientOfVariation },
      { statistic: "effective sample size", value: effectiveSampleSize },
      { statistic: "weights truncated", value: truncatedCount },
      { statistic: "maximum raw weight (1/propensity)", value: Math.max(...rawWeights) },
    ];

    const level = options.confidenceLevel;
    return {
      sample: {
        n,
        respondents: nr,
        nonRespondents: n - nr,
        responseRate,
        predictors: predictorNames.length,
        auxiliary: auxiliaryNames.length,
        coefficients: p,
        effectiveSampleSize,
        dfResidual,
      },
      estimates: coefficientRows.map((row) => ({
        name: row.term,
        estimate: row.estimate,
        standardError: row.sandwichSe,
        weighting: "stabilised inverse response propensity",
        completeCaseEstimate: row.completeCaseEstimate,
      })),
      tests: coefficientRows.map((row) => ({
        name: `weighted coefficient ${row.term} = 0`,
        statistic: row.t,
        distribution: "t",
        df: row.df,
        pValue: row.pValue,
        method: "HC0 sandwich standard error treating the fitted weights as known",
      })),
      confidenceIntervals: coefficientRows.map((row) => ({
        parameter: row.term,
        level,
        lower: row.lower,
        upper: row.upper,
        method: "weighted estimate +/- t(n_respondents - p) x sandwich SE",
        df: row.df,
      })),
      effectSizes: [
        { name: "effective sample size", estimate: effectiveSampleSize, interpretationBoundary: `weighting ${nr} respondents costs the precision of about ${(nr - effectiveSampleSize).toFixed(2)} observations` },
        { name: "largest weighted vs complete-case coefficient shift", estimate: Math.max(...coefficientRows.slice(1).map((row) => Math.abs(row.difference))), interpretationBoundary: "how far reweighting moved the estimate; not a bias estimate, since both may be biased under the same violated assumption" },
      ],
      assumptions: [
        { name: "missing at random given the response model covariates", status: "not_established", note: "The weights only remove the part of the non-response that these covariates explain." },
        { name: "positivity (every row could have responded)", status: minPropensity > 0.05 ? "verified" : "requires_design_review", minimumFittedProbability: minPropensity, note: "Fitted probabilities near zero produce extreme weights and unstable estimates." },
        { name: "response model is correctly specified", status: "not_established", note: "Inverse probability weighting is not doubly robust here; a misspecified propensity model biases the weighted estimate." },
        { name: "outcome is the only variable with missing values", status: "verified", note: "Analysis covariates were required to be fully observed." },
        { name: "sandwich treats the estimated weights as known", status: "requires_design_review", note: "Ignoring propensity estimation typically makes this standard error conservative, but that is not guaranteed under misspecification." },
      ],
      diagnostics: [
        { name: "weight distribution", status: coefficientOfVariation > 1 ? "unstable" : "acceptable", coefficientOfVariation, designEffect: 1 + coefficientOfVariation * coefficientOfVariation, effectiveSampleSize, maxWeightOverMean: sortedWeights[sortedWeights.length - 1] / weightMean, truncated: truncatedCount, truncationCut },
        { name: "positivity screen", status: minPropensity > 0.05 ? "acceptable" : "violated", minimumFittedProbability: minPropensity, maximumFittedProbability: maxPropensity, rowsBelow0p05: propensity.probability.filter((value) => value < 0.05).length },
        { name: "response model convergence", status: "converged", iterations: propensity.iterations, maxCoefficientStep: propensity.change, tolerance: options.tolerance, algorithm: "iteratively reweighted least squares" },
        { name: "weighted versus complete-case comparison", status: "evaluated", largestShift: Math.max(...coefficientRows.slice(1).map((row) => Math.abs(row.difference))), detail: "A large shift means the complete-case analysis was leaning on the missingness mechanism." },
        { name: "variance estimator boundary", status: "declared", detail: "HC0 sandwich on the weighted score. The point estimate and this sandwich are invariant to rescaling all weights by a constant, so stabilisation changes reporting, not inference." },
      ],
      artifacts: [
        H.tableArtifact(`Inverse-probability-weighted coefficients: ${parsed.outcomeLabel}`, `Weighted coefficients with sandwich standard errors and ${Math.round(level * 100)}% intervals, next to the unweighted complete-case fit.`, [
          { key: "term", label: "Term", type: "string" },
          { key: "estimate", label: "IPW estimate", type: "number" },
          { key: "sandwichSe", label: "Sandwich SE", type: "number" },
          { key: "modelSe", label: "Model-based SE", type: "number" },
          { key: "t", label: "t", type: "number" },
          { key: "df", label: "df", type: "number" },
          { key: "pValue", label: "p", type: "number" },
          { key: "lower", label: `Lower ${Math.round(level * 100)}%`, type: "number" },
          { key: "upper", label: `Upper ${Math.round(level * 100)}%`, type: "number" },
          { key: "completeCaseEstimate", label: "Complete-case estimate", type: "number" },
          { key: "completeCaseSe", label: "Complete-case SE", type: "number" },
          { key: "difference", label: "IPW - complete case", type: "number" },
        ], coefficientRows, ["The complete-case column is the same model fitted on respondents with every weight set to one."], "missing-data-ipw-coefficient-table"),
        H.tableArtifact(`Response propensity model: ${parsed.outcomeLabel}`, "Logistic regression of the response indicator on the analysis covariates and any auxiliary variables.", [
          { key: "term", label: "Term", type: "string" },
          { key: "coefficient", label: "Coefficient", type: "number" },
          { key: "standardError", label: "SE", type: "number" },
          { key: "z", label: "z", type: "number" },
          { key: "pValue", label: "p", type: "number" },
          { key: "oddsRatio", label: "Odds ratio", type: "number" },
        ], propensityRows, ["A covariate that predicts response strongly is the reason complete-case analysis would have been biased."], "missing-data-ipw-propensity-table"),
        H.tableArtifact(`Weight diagnostics: ${parsed.outcomeLabel}`, "Distribution of the stabilised weights, the positivity range, and the precision cost of weighting.", [
          { key: "statistic", label: "Quantity", type: "string" },
          { key: "value", label: "Value", type: "number" },
        ], weightRows, ["Stabilised weights multiply the raw inverse propensity by the marginal response rate, so they average to about one."], "missing-data-ipw-weight-table"),
        H.vegaArtifact("missing-data-ipw-coefficient-plot", `Weighted versus complete-case coefficients: ${parsed.outcomeLabel}`, {
          data: { values: coefficientRows },
          layer: [
            { mark: { type: "rule", strokeWidth: 2 }, encoding: { y: { field: "term", type: "nominal", title: "Term", sort: null }, x: { field: "lower", type: "quantitative", title: "Coefficient" }, x2: { field: "upper" } } },
            { mark: { type: "point", filled: true, size: 90 }, encoding: { y: { field: "term", type: "nominal", sort: null }, x: { field: "estimate", type: "quantitative" }, tooltip: [{ field: "term" }, { field: "estimate", format: ".4f" }, { field: "sandwichSe", format: ".4f" }, { field: "completeCaseEstimate", format: ".4f" }] } },
            { mark: { type: "point", shape: "cross", filled: false, size: 70, color: "#B24A3B" }, encoding: { y: { field: "term", type: "nominal", sort: null }, x: { field: "completeCaseEstimate", type: "quantitative" }, tooltip: [{ field: "term" }, { field: "completeCaseEstimate", format: ".4f" }] } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When the outcome is missing for part of the sample, the covariates that predict whether it is missing were recorded, and the researcher wants to keep the analysis model simple instead of imputing every variable.",
    decision: "Whether reweighting the respondents by their modelled chance of responding changes the conclusion the complete-case analysis would have given, and whether the resulting weights are stable enough to trust that answer.",
    mustShow: "The response propensity model with every coefficient, the range of fitted response probabilities, the weight distribution with its coefficient of variation and effective sample size, the weighted coefficients with sandwich standard errors and intervals, and the unweighted complete-case estimate beside them.",
    userGoal: "Report an analysis that accounts for who did not respond, and show the reviewer both how the weights behaved and how far they moved the answer.",
    nextActions: [
      { trigger: "weights-highly-variable", action: "truncate-or-trim-weights-and-report-both-the-trimmed-and-untrimmed-fit", reason: "A few large weights let a handful of respondents drive the estimate, which is a variance problem the interval alone does not reveal." },
      { trigger: "positivity-violated", action: "restrict-the-analysis-population-to-the-region-with-common-support", reason: "Rows whose modelled chance of responding is near zero cannot be represented by anyone in the sample, so weighting extrapolates instead of adjusting." },
      { trigger: "weighted-and-complete-case-agree", action: "report-the-agreement-as-a-sensitivity-result", reason: "Concordance between the two is a genuine robustness argument that costs nothing to state and pre-empts the obvious reviewer question." },
      { trigger: "response-model-covariate-strongly-predicts-response", action: "name-that-covariate-in-the-missingness-paragraph", reason: "The reader needs to know which measured feature explains non-response before judging whether the MAR assumption is plausible." },
      { trigger: "effective-sample-size-much-smaller-than-respondents", action: "recompute-the-precision-claim-on-the-effective-sample-size", reason: "Weighting buys bias reduction with variance, and a power or precision statement based on the raw respondent count would overstate the study." },
    ],
  },
  fixture: {
    data: {
      outcomeLabel: "Follow-up score",
      y: [null, 12.33, 5.98, null, null, 13.44, null, 15.79, null, null, null, 13.12, null, 12.56, null, 15.1, 14.89, 14.67, 19.57, 13.18, 9.53, null, 11.07, 12.53, 9.29, 12.28, 14.61, 12.75, null, 11.45, 12.02, null, 13.54, 15.8, 11.58, 13.27, null, 7.96, 13.24, 9.76, null, 8.81, 17.39, 17.12, 19.72, 6.79, 7.5, null, null, 16.37],
      predictors: [
        { name: "exposure", values: [8.93, 7.79, 1.43, 6.25, 5.84, 8.56, 9.3, 11.25, 9.53, 8.83, 6.63, 7.81, 6.04, 8.37, 8.21, 9.93, 9.29, 10.03, 11.94, 8.83, 6.21, 3.91, 7.33, 7.52, 6.75, 5.48, 9.29, 9.65, 8.32, 7.64, 7.33, 5.17, 9.27, 9.05, 7.85, 8.85, 7.1, 5.45, 9.46, 6.53, 6.49, 7.98, 9.57, 10.31, 12.05, 5.18, 5.22, 9.61, 5.08, 11.19] },
        { name: "baseline", values: [4.76, 3.21, 2.19, 3.22, 0.04, 3.63, 3.6, 2.39, 3.7, 3.27, 4.71, 2.2, 2.89, 4.66, 2.51, 2.24, 3.22, 3.81, 1.9, 2.25, 3.57, 4.21, 4.89, 1.6, 4.69, 1.66, 1.81, 4.54, 3.6, 3.79, 3.15, 3.95, 2.44, 2.13, 1.77, 2.79, 2.47, 3.65, 3.74, 2.94, 1.98, 3.16, 2.2, 3.12, 1.26, 4.85, 3.79, 4.05, 5.21, 1.71] },
      ],
      auxiliary: [
        { name: "contactScore", values: [2.21, -0.55, 2.12, 0.28, 0.19, 0.52, -0.11, 2.53, 2.94, -0.29, 0.54, 1.09, 2.28, 1.62, 0.93, 0.16, 1.22, 1.28, 1.84, 2.27, 1.37, -0.56, 1.45, 1.44, 2.76, 1.64, 0.59, 1.08, -0.8, 0.75, 1.82, 0.8, 3.03, 0.96, 1.35, 3.71, 0.56, 2.06, 0.99, 0.89, 2.24, 2.04, 0.76, -1.29, 0.5, 2.15, 0.43, -0.51, -0.53, -0.04] },
      ],
    },
    options: { confidenceLevel: 0.95, tolerance: 1e-10, maxIterations: 100, truncationQuantile: 0 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression", "matlab.stats.classification"] },
  coverage: {
    implementedBoundary: "Complete-case linear regression reweighted by the inverse of a logistic response propensity fitted on fully observed analysis covariates plus optional auxiliary variables (1..12 of each, 8..5000 rows), with stabilised weights, optional upper-quantile truncation, a weight-distribution diagnostic and an HC0 sandwich covariance. Missing values are allowed in the outcome only; the sandwich treats the fitted weights as known and the estimator is not augmented or doubly robust.",
    oracle: {
      level: "external-library-partial",
      evidence: ["contracts/missing-data-scipy-crosscheck.py"],
      verifiedOutputs: ["response propensity coefficients, standard errors and fitted probabilities against statsmodels.Logit", "stabilised weights against a numpy derivation from those fitted probabilities", "weighted coefficients against statsmodels.WLS", "sandwich standard errors against statsmodels.WLS(...).fit(cov_type=\"HC0\")", "complete-case coefficients and standard errors against statsmodels.OLS", "effective sample size, coefficient of variation and design effect against numpy", "t statistics, p values and confidence bounds against scipy.stats.t"],
      excludedOutputs: ["standard errors that account for estimating the propensity model (not implemented)", "augmented or doubly robust estimators", "weight truncation at quantiles other than the fixture value is computed but not oracle-checked"],
    },
    diagnostic: {
      level: "method-specific-partial",
      emitted: ["weight distribution", "positivity screen", "response model convergence", "weighted versus complete-case comparison", "variance estimator boundary"],
      limitations: ["does not test MAR", "does not diagnose response-model misspecification", "does not propagate propensity estimation uncertainty into the interval"],
    },
    knownGaps: ["standard errors that account for the estimated propensity (the two-stage correction or a bootstrap over both stages)", "augmented inverse probability weighting and other doubly robust estimators", "missing values in the covariates as well as the outcome", "categorical covariates in the response model", "calibration or entropy-balancing weights"],
  },
};

module.exports = { methods: [missingDataPattern, multipleImputationRegression, inverseProbabilityWeighting] };
