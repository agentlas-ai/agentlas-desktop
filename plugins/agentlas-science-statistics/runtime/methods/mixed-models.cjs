"use strict";

/**
 * Mixed-models family: designs where observations are not independent because they are nested in
 * subjects, clinics, schools, or litters.
 *
 *   linear_mixed_model_random_slopes  Gaussian LMM with a correlated random intercept AND random
 *                                     slope, REML/ML by profiled likelihood, Satterthwaite
 *                                     denominator degrees of freedom, and a singular-fit report.
 *   generalized_estimating_equations  Population-averaged GEE with exchangeable, independence, and
 *                                     AR(1) working correlations, robust sandwich standard errors,
 *                                     and QIC for choosing the correlation structure.
 *   generalized_linear_mixed_model    Subject-specific GLMM (binomial or Poisson) with one random
 *                                     intercept, integrated by adaptive Gauss-Hermite quadrature.
 *
 * Numerical conventions are inherited from the bounded core LMM (`gaussian_random_intercept_lmm`
 * in runtime/engine.cjs). Deliberate differences from that method are flagged inline with
 * "DIFFERS FROM CORE LMM". Everything is pure deterministic JavaScript; numerics arrive through
 * `H` and runtime/methods/regression-kit.cjs. No engine require, no Math.random, no I/O.
 */

const K = require("./regression-kit.cjs");

const MAX_ROWS = 5000;
const MAX_GROUPS = 500;
const MIN_GROUPS = 4;
const MAX_CLUSTER_SIZE = 200;

const NUMBER_COLUMN = (key, label) => ({ key, label, type: "number" });
const STRING_COLUMN = (key, label) => ({ key, label, type: "string" });
const BOOLEAN_COLUMN = (key, label) => ({ key, label, type: "boolean" });
const LABEL_SCHEMA = { type: "string", minLength: 1, maxLength: 128 };
const NUMERIC_SCHEMA = (minItems) => ({ type: "array", minItems, maxItems: MAX_ROWS, items: { type: "number" } });
const GROUP_SCHEMA = (minItems) => ({ type: "array", minItems, maxItems: MAX_ROWS, items: { type: "string", minLength: 1, maxLength: 128 } });
const PREDICTORS_SCHEMA = (minItems) => ({
  type: "array",
  minItems,
  maxItems: 24,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["values"],
    properties: {
      name: LABEL_SCHEMA,
      type: { type: "string", enum: ["numeric", "categorical"] },
      values: { type: "array", minItems: 4, maxItems: MAX_ROWS, items: { type: ["number", "string"] } },
      reference: LABEL_SCHEMA,
    },
  },
});

function percent(level) {
  return `${Math.round(level * 1000) / 10}%`;
}

/** Cluster rows by group label. Levels are en-collated; row order inside a cluster is input order. */
function clusterStructure(groups, H, method) {
  const levels = K.sortedLevels(groups);
  if (levels.length < MIN_GROUPS) H.fail("STAT_INSUFFICIENT_SAMPLE", `${method} requires at least ${MIN_GROUPS} groups in data.groups`);
  if (levels.length > MAX_GROUPS) H.fail("STAT_LIMIT_EXCEEDED", `${method} supports at most ${MAX_GROUPS} groups`);
  const index = new Map(levels.map((level, position) => [level, position]));
  const rows = levels.map(() => []);
  groups.forEach((value, position) => { rows[index.get(value)].push(position); });
  for (const [position, member] of rows.entries()) {
    if (member.length > MAX_CLUSTER_SIZE) H.fail("STAT_LIMIT_EXCEEDED", `${method} supports at most ${MAX_CLUSTER_SIZE} observations in one group (${levels[position]})`);
  }
  return { levels, rows };
}

/**
 * Deterministic Nelder-Mead. The objective may return a non-finite value for an infeasible point;
 * the simplex is initialised from a fixed offset so the whole search is reproducible.
 */
function nelderMead(objective, start, steps, { maxIterations, tolerance, budget }) {
  const dimension = start.length;
  const evaluate = (point) => {
    budget.check(64);
    const value = objective(point);
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  };
  let vertices = [start.slice()];
  for (let index = 0; index < dimension; index += 1) {
    const point = start.slice();
    point[index] += steps[index];
    vertices.push(point);
  }
  let values = vertices.map(evaluate);
  let iterations = 0;
  let converged = false;
  for (; iterations < maxIterations; iterations += 1) {
    const order = vertices.map((_, index) => index).sort((left, right) => values[left] - values[right] || left - right);
    vertices = order.map((index) => vertices[index]);
    values = order.map((index) => values[index]);
    const best = values[0];
    const worst = values[dimension];
    if (!Number.isFinite(best)) break;
    const valueSpread = Number.isFinite(worst) ? Math.abs(worst - best) : Number.POSITIVE_INFINITY;
    let pointSpread = 0;
    for (let vertex = 1; vertex <= dimension; vertex += 1) {
      for (let index = 0; index < dimension; index += 1) pointSpread = Math.max(pointSpread, Math.abs(vertices[vertex][index] - vertices[0][index]));
    }
    if (valueSpread <= tolerance * (1 + Math.abs(best)) && pointSpread <= Math.sqrt(tolerance)) {
      converged = true;
      break;
    }
    const centroid = Array(dimension).fill(0);
    for (let vertex = 0; vertex < dimension; vertex += 1) {
      for (let index = 0; index < dimension; index += 1) centroid[index] += vertices[vertex][index] / dimension;
    }
    const combine = (factor) => centroid.map((value, index) => value + factor * (value - vertices[dimension][index]));
    const reflected = combine(1);
    const reflectedValue = evaluate(reflected);
    if (reflectedValue < values[0]) {
      const expanded = combine(2);
      const expandedValue = evaluate(expanded);
      if (expandedValue < reflectedValue) { vertices[dimension] = expanded; values[dimension] = expandedValue; } else { vertices[dimension] = reflected; values[dimension] = reflectedValue; }
      continue;
    }
    if (reflectedValue < values[dimension - 1]) { vertices[dimension] = reflected; values[dimension] = reflectedValue; continue; }
    const contracted = reflectedValue < values[dimension] ? combine(0.5) : combine(-0.5);
    const contractedValue = evaluate(contracted);
    if (contractedValue < Math.min(reflectedValue, values[dimension])) { vertices[dimension] = contracted; values[dimension] = contractedValue; continue; }
    for (let vertex = 1; vertex <= dimension; vertex += 1) {
      vertices[vertex] = vertices[vertex].map((value, index) => vertices[0][index] + 0.5 * (value - vertices[0][index]));
      values[vertex] = evaluate(vertices[vertex]);
    }
  }
  let bestIndex = 0;
  for (let index = 1; index < values.length; index += 1) if (values[index] < values[bestIndex]) bestIndex = index;
  return { point: vertices[bestIndex], value: values[bestIndex], iterations, converged };
}

/** Nelder-Mead with deterministic restarts; each restart rebuilds the simplex at the current best. */
function minimizeWithRestarts(objective, start, steps, { restarts, iterationsPerRestart, tolerance, budget }) {
  let best = { point: start.slice(), value: objective(start), iterations: 0, converged: false };
  if (!Number.isFinite(best.value)) best.value = Number.POSITIVE_INFINITY;
  let totalIterations = 0;
  let round = 0;
  let scale = 1;
  for (; round < restarts; round += 1) {
    const run = nelderMead(objective, best.point, steps.map((step) => step * scale), { maxIterations: iterationsPerRestart, tolerance, budget });
    totalIterations += run.iterations;
    const improvement = best.value - run.value;
    if (run.value < best.value) best = run;
    if (round > 0 && improvement <= tolerance * (1 + Math.abs(best.value))) { round += 1; break; }
    scale *= 0.5;
  }
  return { ...best, restarts: round, iterations: totalIterations };
}

/** Central-difference gradient with one Richardson extrapolation step (error O(h^4)). */
function richardsonGradient(fn, point, steps) {
  return point.map((value, index) => {
    const step = steps[index];
    const shift = (delta) => {
      const moved = point.slice();
      moved[index] = value + delta;
      return fn(moved);
    };
    const coarse = (shift(step) - shift(-step)) / (2 * step);
    const fine = (shift(step / 2) - shift(-step / 2)) / step;
    return (4 * fine - coarse) / 3;
  });
}

/** Central-difference Hessian with one Richardson extrapolation step. */
function richardsonHessian(fn, point, steps, H) {
  const dimension = point.length;
  const at = (deltas) => fn(point.map((value, index) => value + deltas[index]));
  const base = fn(point);
  const build = (factor) => {
    const hessian = Array.from({ length: dimension }, () => Array(dimension).fill(0));
    for (let row = 0; row < dimension; row += 1) {
      const hr = steps[row] * factor;
      const forward = Array(dimension).fill(0); forward[row] = hr;
      const backward = Array(dimension).fill(0); backward[row] = -hr;
      hessian[row][row] = (at(forward) - 2 * base + at(backward)) / (hr * hr);
      for (let column = row + 1; column < dimension; column += 1) {
        const hc = steps[column] * factor;
        const shift = (signRow, signColumn) => {
          const deltas = Array(dimension).fill(0);
          deltas[row] = signRow * hr;
          deltas[column] = signColumn * hc;
          return at(deltas);
        };
        const value = (shift(1, 1) - shift(1, -1) - shift(-1, 1) + shift(-1, -1)) / (4 * hr * hc);
        hessian[row][column] = value;
        hessian[column][row] = value;
      }
    }
    return hessian;
  };
  const coarse = build(1);
  const fine = build(0.5);
  const combined = coarse.map((row, i) => row.map((value, j) => (4 * fine[i][j] - value) / 3));
  if (combined.some((row) => row.some((value) => !Number.isFinite(value)))) H.fail("STAT_NUMERIC_FAILURE", "numeric Hessian of the restricted likelihood is not finite");
  return combined;
}

/** Gauss-Hermite nodes and weights (physicists' convention) by Golub-Welsch on the Jacobi matrix. */
function gaussHermite(points, H, budget) {
  if (points === 1) return { nodes: [0], weights: [Math.sqrt(Math.PI)] };
  // Golub-Welsch: the Jacobi matrix has zero diagonal and sqrt(k/2) off-diagonals. Its spectrum is
  // symmetric about zero, so it is shifted by +c*I to stay positive definite for the shared
  // eigensolver (which refuses materially negative eigenvalues) and the shift is removed afterwards.
  const shift = points + 8;
  const jacobi = Array.from({ length: points }, (_, index) => Array.from({ length: points }, (_, column) => index === column ? shift : 0));
  for (let index = 0; index + 1 < points; index += 1) {
    const offDiagonal = Math.sqrt((index + 1) / 2);
    jacobi[index][index + 1] = offDiagonal;
    jacobi[index + 1][index] = offDiagonal;
  }
  const { pairs } = H.symmetricEigenJacobi(jacobi, budget);
  const rows = pairs.map((pair) => ({ node: pair.value - shift, weight: Math.PI ** 0.5 * pair.vector[0] * pair.vector[0] }))
    .sort((left, right) => left.node - right.node);
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  if (!(Math.abs(total - Math.sqrt(Math.PI)) < 1e-8)) H.fail("STAT_NUMERIC_FAILURE", "Gauss-Hermite weights do not sum to sqrt(pi)");
  return { nodes: rows.map((row) => row.node), weights: rows.map((row) => row.weight) };
}

/* ------------------------------------------------------------------------------------------ */
/* 1. linear_mixed_model_random_slopes                                                          */
/* ------------------------------------------------------------------------------------------ */

/**
 * Sufficient statistics for a two-column random-effect design Z = [1, s].
 * Per group: M = Z'Z (2x2), P = X'Z (p x 2), u = Z'y (2). Globally: X'X, X'y, y'y.
 * The profiled objective then costs O(G p^2) per evaluation and never touches the raw rows again.
 */
function slopeSufficient(y, x, z, groupRows, budget) {
  const p = x[0].length;
  const xtx = Array.from({ length: p }, () => Array(p).fill(0));
  const xty = Array(p).fill(0);
  let yty = 0;
  for (let row = 0; row < y.length; row += 1) {
    const xi = x[row];
    const yi = y[row];
    yty += yi * yi;
    for (let left = 0; left < p; left += 1) {
      budget.check();
      xty[left] += xi[left] * yi;
      for (let right = left; right < p; right += 1) xtx[left][right] += xi[left] * xi[right];
    }
  }
  for (let left = 0; left < p; left += 1) for (let right = 0; right < left; right += 1) xtx[left][right] = xtx[right][left];
  const groups = groupRows.map((rows) => {
    const m = [[0, 0], [0, 0]];
    const pMatrix = Array.from({ length: p }, () => [0, 0]);
    const u = [0, 0];
    for (const row of rows) {
      const zi = z[row];
      const xi = x[row];
      const yi = y[row];
      for (let a = 0; a < 2; a += 1) {
        u[a] += zi[a] * yi;
        for (let b = 0; b < 2; b += 1) m[a][b] += zi[a] * zi[b];
        for (let column = 0; column < p; column += 1) pMatrix[column][a] += xi[column] * zi[a];
      }
    }
    return { n: rows.length, m, p: pMatrix, u };
  });
  return { n: y.length, p, xtx, xty, yty, groups };
}

/**
 * Weighted cross products at a relative random-effect covariance Lambda = G / sigma^2.
 * Uses det(I + Z Lambda Z') = det(I + M Lambda) and (I + Z Lambda Z')^-1 = I - Z C Z' with
 * C = Lambda (I + M Lambda)^-1, so the 2x2 algebra is closed form and Lambda may be singular.
 * Returns null when the point is infeasible (non-positive determinant or no residual variance).
 */
function slopeCore(sufficient, lambda, H, budget) {
  const p = sufficient.p;
  const information = sufficient.xtx.map((row) => [...row]);
  const rhs = [...sufficient.xty];
  let yWy = sufficient.yty;
  let logDeterminant = 0;
  for (const group of sufficient.groups) {
    budget.check(16);
    const m = group.m;
    const a00 = 1 + m[0][0] * lambda[0][0] + m[0][1] * lambda[1][0];
    const a01 = m[0][0] * lambda[0][1] + m[0][1] * lambda[1][1];
    const a10 = m[1][0] * lambda[0][0] + m[1][1] * lambda[1][0];
    const a11 = 1 + m[1][0] * lambda[0][1] + m[1][1] * lambda[1][1];
    const determinant = a00 * a11 - a01 * a10;
    if (!(determinant > 0) || !Number.isFinite(determinant)) return null;
    logDeterminant += Math.log(determinant);
    // C = Lambda * inv(I + M Lambda); symmetric by construction.
    const i00 = a11 / determinant;
    const i01 = -a01 / determinant;
    const i10 = -a10 / determinant;
    const i11 = a00 / determinant;
    const c00 = lambda[0][0] * i00 + lambda[0][1] * i10;
    const c01 = lambda[0][0] * i01 + lambda[0][1] * i11;
    const c10 = lambda[1][0] * i00 + lambda[1][1] * i10;
    const c11 = lambda[1][0] * i01 + lambda[1][1] * i11;
    const u = group.u;
    const cu = [c00 * u[0] + c01 * u[1], c10 * u[0] + c11 * u[1]];
    yWy -= u[0] * cu[0] + u[1] * cu[1];
    const q = group.p.map((row) => [row[0] * c00 + row[1] * c10, row[0] * c01 + row[1] * c11]);
    for (let left = 0; left < p; left += 1) {
      rhs[left] -= q[left][0] * u[0] + q[left][1] * u[1];
      for (let right = 0; right < p; right += 1) information[left][right] -= q[left][0] * group.p[right][0] + q[left][1] * group.p[right][1];
    }
  }
  let inverse;
  let informationLogDeterminant;
  try {
    informationLogDeterminant = H.positiveDefiniteLogDeterminant(information);
    inverse = H.invert(information);
  } catch { return null; }
  const beta = inverse.map((row) => row.reduce((total, value, index) => total + value * rhs[index], 0));
  const betaRhs = beta.reduce((total, value, index) => total + value * rhs[index], 0);
  const q = yWy - betaRhs;
  if (!(q > 0) || !Number.isFinite(q)) return null;
  const conditionNumber = H.matrixInfinityNorm(information) * H.matrixInfinityNorm(inverse);
  return { information, inverse, informationLogDeterminant, logDeterminant, beta, q, conditionNumber };
}

/**
 * Profiled -2 log-likelihood. Identical convention to the core LMM `lmmProfilePoint`:
 * ML   : n     * (log 2pi + 1 + log sigma^2) + log|V/sigma^2|
 * REML : (n-p) * (log 2pi + 1 + log sigma^2) + log|V/sigma^2| + log|X'(V/sigma^2)^-1 X|
 * statsmodels MixedLM reports exactly this profiled value as `llf` (times -1/2).
 */
function slopeObjective(sufficient, lambda, fitMethod, H, budget) {
  const core = slopeCore(sufficient, lambda, H, budget);
  if (!core) return null;
  const divisor = fitMethod === "ml" ? sufficient.n : sufficient.n - sufficient.p;
  const sigma2 = core.q / divisor;
  if (!(sigma2 > 0) || !Number.isFinite(sigma2)) return null;
  const objective = divisor * (Math.log(2 * Math.PI) + 1 + Math.log(sigma2))
    + core.logDeterminant
    + (fitMethod === "ml" ? 0 : core.informationLogDeterminant);
  if (!Number.isFinite(objective)) return null;
  return { ...core, sigma2, objective, logLikelihood: -0.5 * objective };
}

/** Non-profiled -2 log-likelihood as a function of (G, sigma^2); used for the Satterthwaite Hessian. */
function slopeDeviance(sufficient, g, sigma2, fitMethod, H, budget) {
  if (!(sigma2 > 0)) return Number.NaN;
  const lambda = [[g[0][0] / sigma2, g[0][1] / sigma2], [g[1][0] / sigma2, g[1][1] / sigma2]];
  const core = slopeCore(sufficient, lambda, H, budget);
  if (!core) return Number.NaN;
  const divisor = fitMethod === "ml" ? sufficient.n : sufficient.n - sufficient.p;
  return divisor * Math.log(2 * Math.PI) + divisor * Math.log(sigma2) + core.logDeterminant
    + (fitMethod === "ml" ? 0 : core.informationLogDeterminant) + core.q / sigma2;
}

/** theta -> Lambda. Lambda = L L' with L lower triangular; the map is sign-canonicalised so the
 *  optimiser stays unconstrained while the diagonal of L is free to reach exactly zero. */
function thetaToLambda(theta) {
  const sign = theta[0] < 0 ? -1 : 1;
  const l11 = Math.abs(theta[0]);
  const l21 = sign * theta[1];
  const l22 = Math.abs(theta[2]);
  return [[l11 * l11, l11 * l21], [l11 * l21, l21 * l21 + l22 * l22]];
}

function symmetricEigen2(matrix) {
  const a = matrix[0][0];
  const b = matrix[0][1];
  const d = matrix[1][1];
  const trace = a + d;
  const gap = Math.sqrt(Math.max(0, (a - d) * (a - d) + 4 * b * b));
  return [(trace + gap) / 2, (trace - gap) / 2];
}

const linearMixedModelRandomSlopes = {
  method: "linear_mixed_model_random_slopes",
  family: "mixed-models",
  analysisModel: { families: ["mixed-models", "lmm", "mixed-effects"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "fitMethod", "timeoutMs", "maxIterations", "tolerance"],
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["y", "groups", "slope"],
    properties: {
      y: NUMERIC_SCHEMA(12),
      groups: GROUP_SCHEMA(12),
      slope: NUMERIC_SCHEMA(12),
      predictors: PREDICTORS_SCHEMA(1),
      outcomeLabel: LABEL_SCHEMA,
      groupLabel: LABEL_SCHEMA,
      slopeLabel: LABEL_SCHEMA,
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["y", "groups", "slope", "predictors", "outcomeLabel", "groupLabel", "slopeLabel"], "data");
    const y = H.numericVector(data.y, "data.y", 12);
    if (y.length > MAX_ROWS) H.fail("STAT_LIMIT_EXCEEDED", `linear_mixed_model_random_slopes supports at most ${MAX_ROWS} observations`);
    const groups = H.categoryVector(data.groups, "data.groups", 12);
    const slope = H.numericVector(data.slope, "data.slope", 12);
    if (groups.length !== y.length || slope.length !== y.length) H.fail("STAT_INVALID_INPUT", "data.groups and data.slope must have the same length as data.y");
    const bounds = H.minMax(slope);
    if (bounds.min === bounds.max) H.fail("STAT_DEGENERATE", "data.slope is constant, so a random slope is not identified");
    const predictors = data.predictors === undefined ? [] : H.regressionPredictors(data.predictors, y.length, { allowEmpty: true });
    const cluster = clusterStructure(groups, H, "linear_mixed_model_random_slopes");
    for (const [position, rows] of cluster.rows.entries()) {
      if (rows.length < 2) H.fail("STAT_INSUFFICIENT_SAMPLE", `group ${cluster.levels[position]} has one observation; a random slope needs at least two rows per group`);
    }
    const withSlopeVariation = cluster.rows.filter((rows) => new Set(rows.map((row) => slope[row])).size > 1).length;
    if (withSlopeVariation < 2) H.fail("STAT_DEGENERATE", "data.slope must vary inside at least two groups for a random slope to be identified");
    return {
      y,
      groups,
      slope,
      predictors,
      cluster,
      withSlopeVariation,
      outcomeLabel: H.label(data.outcomeLabel, "Outcome", "data.outcomeLabel"),
      groupLabel: H.label(data.groupLabel, "Group", "data.groupLabel"),
      slopeLabel: H.label(data.slopeLabel, "Slope variable", "data.slopeLabel"),
    };
  },
  analyze(parsed, options, budget, H) {
    const { y, slope, cluster } = parsed;
    const n = y.length;
    const level = options.confidenceLevel;
    const slopePredictor = { name: parsed.slopeLabel, type: "numeric", values: slope };
    const design = H.designMatrix({ y, predictors: [slopePredictor, ...parsed.predictors] }, true);
    const x = design.x;
    const p = x[0].length;
    const names = design.terms.map((term) => term.name);
    if (H.matrixRank(x) !== p) H.fail("STAT_RANK_DEFICIENT", "fixed-effect design is rank deficient after categorical expansion");
    if (n <= p + 3) H.fail("STAT_INSUFFICIENT_SAMPLE", "at least p + 4 observations are required for random-slope inference");
    const z = y.map((_, row) => [1, slope[row]]);
    const sufficient = slopeSufficient(y, x, z, cluster.rows, budget);
    const fitMethod = options.fitMethod;

    // Optimise theta = (L11, L21, L22). lme4's default start theta = (1, 0, 1) is reused so the
    // search path is reproducible; options.maxIterations bounds restart rounds, not simplex steps.
    const objective = (theta) => {
      const point = slopeObjective(sufficient, thetaToLambda(theta), fitMethod, H, budget);
      return point === null ? Number.POSITIVE_INFINITY : point.objective;
    };
    const restarts = Math.max(3, Math.min(options.maxIterations, 12));
    const search = minimizeWithRestarts(objective, [1, 0, 1], [0.5, 0.5, 0.5], {
      restarts,
      iterationsPerRestart: 600,
      tolerance: options.tolerance,
      budget,
    });
    // Deterministic coarse grid so a reported optimum is never a local artefact of the simplex path.
    const gridScale = [0, 0.05, 0.2, 0.5, 1, 2, 5];
    let gridBest = Number.POSITIVE_INFINITY;
    let gridPoint = null;
    for (const first of gridScale) {
      for (const third of gridScale) {
        for (const second of [-1, -0.5, 0, 0.5, 1]) {
          const candidate = [first, second * first, third];
          const value = objective(candidate);
          if (value < gridBest) { gridBest = value; gridPoint = candidate; }
        }
      }
    }
    let theta = search.point;
    let best = search.value;
    let gridAgreement = true;
    if (gridBest < best - Math.abs(options.tolerance) * (1 + Math.abs(best))) {
      gridAgreement = false;
      const polished = minimizeWithRestarts(objective, gridPoint, [0.25, 0.25, 0.25], { restarts, iterationsPerRestart: 600, tolerance: options.tolerance, budget });
      if (polished.value < best) { theta = polished.point; best = polished.value; }
    }
    const lambda = thetaToLambda(theta);
    const fit = slopeObjective(sufficient, lambda, fitMethod, H, budget);
    if (!fit) H.fail("STAT_NUMERIC_FAILURE", "random-slope profiled likelihood is not finite at the reported optimum");
    if (fit.conditionNumber > 1e10) H.fail("STAT_ILL_CONDITIONED", "weighted fixed-effect information exceeds the 1e10 condition boundary", { conditionNumber: fit.conditionNumber, maximum: 1e10 });
    const gradient = richardsonGradient((point) => objective(point), theta, theta.map((value) => Math.max(1e-4, 1e-3 * Math.abs(value))));
    const gradientNorm = Math.max(...gradient.map((value) => Math.abs(value)));
    const gradientTolerance = Math.max(1e-4, Math.sqrt(options.tolerance) * (1 + Math.abs(best)));
    if (!Number.isFinite(gradientNorm) || gradientNorm > gradientTolerance) {
      H.fail("STAT_NON_CONVERGENCE", "random-slope optimiser did not reach a stationary point of the profiled objective", { gradientNorm, gradientTolerance });
    }

    const sigma2 = fit.sigma2;
    const g = [[lambda[0][0] * sigma2, lambda[0][1] * sigma2], [lambda[1][0] * sigma2, lambda[1][1] * sigma2]];
    const interceptSd = Math.sqrt(Math.max(0, g[0][0]));
    const slopeSd = Math.sqrt(Math.max(0, g[1][1]));
    const correlation = interceptSd > 0 && slopeSd > 0 ? g[0][1] / (interceptSd * slopeSd) : null;
    const eigenvalues = symmetricEigen2(g);
    // DIFFERS FROM CORE LMM: gaussian_random_intercept_lmm fails closed with STAT_SINGULAR_FIT when
    // the random variance sits on the zero boundary. A random-slope model is singular far more often
    // (|corr| -> 1 is the usual case), and refusing would hide the very fact the researcher needs.
    // This method therefore reports the singularity and keeps the fit; it never silently drops the
    // slope or falls back to a random-intercept model.
    const relativeSmallest = eigenvalues[0] > 0 ? eigenvalues[1] / eigenvalues[0] : 0;
    const singular = !(relativeSmallest > 1e-6) || (correlation !== null && Math.abs(correlation) > 1 - 1e-4);
    const covariance = fit.inverse.map((row) => row.map((value) => value * sigma2));

    // Satterthwaite denominator degrees of freedom (Giesbrecht-Burns / Fai-Cornelius, as in lmerTest):
    // nu_j = 2 c_j^2 / (grad_j' A grad_j) with c_j = [ (X' V^-1 X)^-1 ]_jj and
    // A = 2 * inv(Hessian of the -2 log restricted likelihood in the variance parameters).
    // The variance parameterisation is (G11, G21, G22, sigma^2); the ratio is invariant to smooth
    // reparameterisation because the gradient and Hessian transform with the same Jacobian.
    // statsmodels MixedLM reports normal (z) inference and no denominator df at all, so this
    // quantity has no statsmodels counterpart and is declared as an uncross-checked output.
    const psi = [g[0][0], g[0][1], g[1][1], sigma2];
    const psiSteps = psi.map((value) => Math.max(1e-4, 1e-3 * Math.abs(value)));
    const devianceAt = (candidate) => slopeDeviance(sufficient, [[candidate[0], candidate[1]], [candidate[1], candidate[2]]], candidate[3], fitMethod, H, budget);
    const hessian = richardsonHessian(devianceAt, psi, psiSteps, H);
    let varianceParameterCovariance = null;
    try {
      varianceParameterCovariance = H.invert(hessian).map((row) => row.map((value) => 2 * value));
    } catch {
      varianceParameterCovariance = null;
    }
    const marginalVarianceAt = (index) => (candidate) => {
      const core = slopeCore(sufficient, [
        [candidate[0] / candidate[3], candidate[1] / candidate[3]],
        [candidate[1] / candidate[3], candidate[2] / candidate[3]],
      ], H, budget);
      return core === null ? Number.NaN : core.inverse[index][index] * candidate[3];
    };
    const satterthwaite = fit.beta.map((_, index) => {
      if (!varianceParameterCovariance) return null;
      const c = covariance[index][index];
      const gradientC = richardsonGradient(marginalVarianceAt(index), psi, psiSteps);
      if (gradientC.some((value) => !Number.isFinite(value))) return null;
      let quadratic = 0;
      for (let row = 0; row < 4; row += 1) for (let column = 0; column < 4; column += 1) quadratic += gradientC[row] * varianceParameterCovariance[row][column] * gradientC[column];
      if (!(quadratic > 0) || !Number.isFinite(quadratic)) return null;
      const df = 2 * c * c / quadratic;
      return Number.isFinite(df) && df > 0 ? df : null;
    });
    const residualDf = n - p;
    const fixedEffects = fit.beta.map((estimate, index) => {
      const standardError = Math.sqrt(Math.max(0, covariance[index][index]));
      if (!(standardError > 0)) H.fail("STAT_DEGENERATE", `fixed-effect standard error for ${names[index]} is zero`);
      const statistic = estimate / standardError;
      const df = satterthwaite[index] === null ? residualDf : satterthwaite[index];
      const critical = H.tCritical(level, df);
      return {
        term: names[index],
        estimate,
        standardError,
        statistic,
        df,
        dfMethod: satterthwaite[index] === null ? "residual n - p fallback" : "Satterthwaite",
        pValue: H.pFromT(statistic, df, "two-sided"),
        lower: estimate - critical * standardError,
        upper: estimate + critical * standardError,
      };
    });

    // BLUPs: b_i = Lambda (I - M C) Z_i'(y_i - X_i beta), with conditional variance
    // sigma^2 (Lambda - Lambda (M - M C M) Lambda).
    const fitted = x.map((row) => row.reduce((total, value, index) => total + value * fit.beta[index], 0));
    const marginalResiduals = y.map((value, index) => value - fitted[index]);
    const groupEffects = cluster.levels.map((groupLabel, position) => {
      const rows = cluster.rows[position];
      const group = sufficient.groups[position];
      const m = group.m;
      const a00 = 1 + m[0][0] * lambda[0][0] + m[0][1] * lambda[1][0];
      const a01 = m[0][0] * lambda[0][1] + m[0][1] * lambda[1][1];
      const a10 = m[1][0] * lambda[0][0] + m[1][1] * lambda[1][0];
      const a11 = 1 + m[1][0] * lambda[0][1] + m[1][1] * lambda[1][1];
      const determinant = a00 * a11 - a01 * a10;
      const c = [
        [lambda[0][0] * (a11 / determinant) + lambda[0][1] * (-a10 / determinant), lambda[0][0] * (-a01 / determinant) + lambda[0][1] * (a00 / determinant)],
        [lambda[1][0] * (a11 / determinant) + lambda[1][1] * (-a10 / determinant), lambda[1][0] * (-a01 / determinant) + lambda[1][1] * (a00 / determinant)],
      ];
      const v = [0, 0];
      for (const row of rows) {
        v[0] += marginalResiduals[row];
        v[1] += slope[row] * marginalResiduals[row];
      }
      const mc = [
        [m[0][0] * c[0][0] + m[0][1] * c[1][0], m[0][0] * c[0][1] + m[0][1] * c[1][1]],
        [m[1][0] * c[0][0] + m[1][1] * c[1][0], m[1][0] * c[0][1] + m[1][1] * c[1][1]],
      ];
      const adjusted = [v[0] - (mc[0][0] * v[0] + mc[0][1] * v[1]), v[1] - (mc[1][0] * v[0] + mc[1][1] * v[1])];
      const effect = [
        lambda[0][0] * adjusted[0] + lambda[0][1] * adjusted[1],
        lambda[1][0] * adjusted[0] + lambda[1][1] * adjusted[1],
      ];
      const mcm = [
        [mc[0][0] * m[0][0] + mc[0][1] * m[1][0], mc[0][0] * m[0][1] + mc[0][1] * m[1][1]],
        [mc[1][0] * m[0][0] + mc[1][1] * m[1][0], mc[1][0] * m[0][1] + mc[1][1] * m[1][1]],
      ];
      const middle = [[m[0][0] - mcm[0][0], m[0][1] - mcm[0][1]], [m[1][0] - mcm[1][0], m[1][1] - mcm[1][1]]];
      const lm = [
        [lambda[0][0] * middle[0][0] + lambda[0][1] * middle[1][0], lambda[0][0] * middle[0][1] + lambda[0][1] * middle[1][1]],
        [lambda[1][0] * middle[0][0] + lambda[1][1] * middle[1][0], lambda[1][0] * middle[0][1] + lambda[1][1] * middle[1][1]],
      ];
      const posterior = [
        sigma2 * (lambda[0][0] - (lm[0][0] * lambda[0][0] + lm[0][1] * lambda[1][0])),
        sigma2 * (lambda[1][1] - (lm[1][0] * lambda[0][1] + lm[1][1] * lambda[1][1])),
      ];
      return {
        group: groupLabel,
        n: rows.length,
        interceptEffect: effect[0],
        interceptSd: Math.sqrt(Math.max(0, posterior[0])),
        slopeEffect: effect[1],
        slopeSd: Math.sqrt(Math.max(0, posterior[1])),
      };
    });
    const normalCritical = H.normalInv(1 - (1 - level) / 2);
    const groupRows = groupEffects.map((row) => ({
      ...row,
      interceptLower: row.interceptEffect - normalCritical * row.interceptSd,
      interceptUpper: row.interceptEffect + normalCritical * row.interceptSd,
      slopeLower: row.slopeEffect - normalCritical * row.slopeSd,
      slopeUpper: row.slopeEffect + normalCritical * row.slopeSd,
    }));
    const varianceRows = [
      { component: `Random intercept (${parsed.groupLabel})`, variance: g[0][0], standardDeviation: interceptSd, correlation: null },
      { component: `Random slope (${parsed.slopeLabel} | ${parsed.groupLabel})`, variance: g[1][1], standardDeviation: slopeSd, correlation },
      { component: "Residual", variance: sigma2, standardDeviation: Math.sqrt(sigma2), correlation: null },
    ];
    const parameterCount = p + 4;
    const deviance = -2 * fit.logLikelihood;
    const formula = `${parsed.outcomeLabel} ~ ${names.map((term, index) => index === 0 ? "1" : term).join(" + ")} + (1 + ${parsed.slopeLabel} | ${parsed.groupLabel})`;
    const forestRows = fixedEffects.map((row) => ({ term: row.term, estimate: row.estimate, lower: row.lower, upper: row.upper, standardError: row.standardError, statistic: row.statistic, df: row.df, pValue: row.pValue, dfMethod: row.dfMethod }));
    return {
      sample: {
        n,
        groups: cluster.levels.length,
        minimumGroupSize: Math.min(...cluster.rows.map((rows) => rows.length)),
        maximumGroupSize: Math.max(...cluster.rows.map((rows) => rows.length)),
        groupsWithSlopeVariation: parsed.withSlopeVariation,
        fixedCoefficients: p,
        randomEffects: 2,
      },
      estimates: [
        ...fixedEffects.map((row) => ({ kind: "fixed-effect", ...row })),
        { kind: "variance-component", term: `Random intercept variance (${parsed.groupLabel})`, estimate: g[0][0], standardDeviation: interceptSd },
        { kind: "variance-component", term: `Random slope variance (${parsed.slopeLabel})`, estimate: g[1][1], standardDeviation: slopeSd },
        { kind: "variance-component", term: "Random intercept-slope covariance", estimate: g[0][1], correlation },
        { kind: "variance-component", term: "Residual variance", estimate: sigma2, standardDeviation: Math.sqrt(sigma2) },
        {
          kind: "random-effect-covariance",
          term: "Random-effect variance-covariance matrix G",
          matrix: [[g[0][0], g[0][1]], [g[1][0], g[1][1]]],
          eigenvalues,
          relativeSmallestEigenvalue: relativeSmallest,
          correlation,
          singular,
          relativeCovarianceFactor: { lambda, theta },
        },
        {
          kind: "model",
          term: "profiled likelihood",
          fitMethod,
          formula,
          estimate: fit.logLikelihood,
          logLikelihood: fit.logLikelihood,
          deviance,
          aic: fitMethod === "ml" ? deviance + 2 * parameterCount : null,
          bic: fitMethod === "ml" ? deviance + Math.log(n) * parameterCount : null,
          comparisonBoundary: fitMethod === "ml"
            ? "ML information criteria may compare models fit to the same observations."
            : "REML likelihoods are not comparable across different fixed-effect designs.",
        },
        ...groupRows.map((row) => ({ kind: "group-effect", term: row.group, estimate: row.slopeEffect, ...row })),
      ],
      tests: fixedEffects.map((row) => ({
        name: `Fixed effect: ${row.term}`,
        statistic: row.statistic,
        distribution: "Student t with Satterthwaite denominator degrees of freedom",
        df: row.df,
        pValue: row.pValue,
      })),
      confidenceIntervals: fixedEffects.map((row) => ({ parameter: row.term, level, lower: row.lower, upper: row.upper, method: `${row.dfMethod} Student t` })),
      effectSizes: [
        { name: "random intercept standard deviation", estimate: interceptSd },
        { name: "random slope standard deviation", estimate: slopeSd },
        { name: "intercept-slope correlation", estimate: correlation },
        ...fixedEffects.map((row) => ({ name: `fixed effect ${row.term}`, estimate: row.estimate })),
      ],
      assumptions: [
        { name: "one grouping factor with a correlated random intercept and slope", status: "verified_by_input_contract", groupLabel: parsed.groupLabel, slopeLabel: parsed.slopeLabel },
        { name: "Gaussian conditional residuals with constant variance", status: "requires_residual_review" },
        { name: "bivariate Gaussian random effects", status: "requires_design_review" },
        { name: "independent groups", status: "requires_design_review" },
        { name: "random-effect covariance is positive definite", status: singular ? "violated_singular_fit" : "satisfied" },
        { name: "complete observations", status: "verified_by_input_contract" },
      ],
      diagnostics: [
        {
          name: "singular fit",
          status: singular ? "singular" : "not_singular",
          smallestEigenvalue: eigenvalues[1],
          largestEigenvalue: eigenvalues[0],
          relativeSmallestEigenvalue: relativeSmallest,
          correlation,
          detail: singular
            ? "the estimated random-effect covariance is on or near its boundary; the reported slope variance, correlation, and Satterthwaite degrees of freedom are unreliable and the model is over-parameterised for this data"
            : "the estimated random-effect covariance is interior to the parameter space",
          boundary: "the fit is reported as estimated; this method never drops the random slope or falls back to a random-intercept model",
        },
        {
          name: "optimizer",
          status: search.converged ? "converged" : "iteration_limit",
          objective: best,
          restarts: search.restarts,
          simplexIterations: search.iterations,
          gradientNorm,
          gradientTolerance,
          globalGridAgreement: gridAgreement,
          parameterization: "theta = (L11, L21, L22) of the relative covariance factor Lambda = L L'",
          startTheta: [1, 0, 1],
        },
        {
          name: "denominator degrees of freedom",
          status: satterthwaite.every((value) => value !== null) ? "satterthwaite" : "satterthwaite_partial",
          method: "Satterthwaite (Giesbrecht-Burns) from the numeric Hessian of the restricted likelihood in (G11, G21, G22, sigma^2)",
          varianceParameterCovarianceAvailable: varianceParameterCovariance !== null,
          residualFallbackDf: residualDf,
          boundary: "statsmodels MixedLM uses a normal (z) reference and reports no denominator degrees of freedom, so this column has no statsmodels counterpart",
        },
        { name: "fit method", status: fitMethod, detail: fitMethod === "reml" ? "REML profiled likelihood; log-likelihood and deviance are restricted quantities" : "ML profiled likelihood" },
        {
          name: "renderer exact-data contract",
          status: "verified",
          inlineRows: "all",
          sampling: "none",
          fixedEffectRows: fixedEffects.length,
          groupEffectRows: groupRows.length,
          varianceRows: varianceRows.length,
          fixedRowsHash: H.sha256(forestRows),
          groupRowsHash: H.sha256(groupRows),
        },
      ],
      artifacts: [
        H.tableArtifact(
          `Random-slope mixed model fixed effects: ${parsed.outcomeLabel}`,
          `${formula}; ${fitMethod.toUpperCase()} fit, ${percent(level)} Student t intervals on Satterthwaite denominator degrees of freedom.`,
          [STRING_COLUMN("term", "Term"), NUMBER_COLUMN("estimate", "Estimate"), NUMBER_COLUMN("standardError", "SE"), NUMBER_COLUMN("statistic", "t"), NUMBER_COLUMN("df", "df"), STRING_COLUMN("dfMethod", "df method"), NUMBER_COLUMN("pValue", "p"), NUMBER_COLUMN("lower", "CI lower"), NUMBER_COLUMN("upper", "CI upper")],
          forestRows,
          ["Denominator degrees of freedom are Satterthwaite, not residual n - p and not Kenward-Roger.", singular ? "The random-effect covariance is singular; treat the variance components and degrees of freedom as unreliable." : "The random-effect covariance is interior to the parameter space."],
          "lmm-slopes-fixed-effects-table",
        ),
        H.tableArtifact(
          "Random-effect variance-covariance",
          `Estimated covariance of the random intercept and the random ${parsed.slopeLabel} slope, plus the conditional residual variance.`,
          [STRING_COLUMN("component", "Component"), NUMBER_COLUMN("variance", "Variance"), NUMBER_COLUMN("standardDeviation", "SD"), NUMBER_COLUMN("correlation", "Corr with intercept")],
          varianceRows,
          [`Covariance G12 = ${g[0][1].toPrecision(6)}; eigenvalues ${eigenvalues[0].toPrecision(6)} and ${eigenvalues[1].toPrecision(6)}.`],
          "lmm-slopes-variance-table",
        ),
        H.tableArtifact(
          `Group intercepts and slopes (${parsed.groupLabel})`,
          `Conditional modes with ${percent(level)} conditional intervals; intervals condition on the fitted variance parameters and are not simultaneous tests.`,
          [STRING_COLUMN("group", "Group"), NUMBER_COLUMN("n", "n"), NUMBER_COLUMN("interceptEffect", "Intercept"), NUMBER_COLUMN("interceptSd", "Intercept SD"), NUMBER_COLUMN("interceptLower", "Intercept lower"), NUMBER_COLUMN("interceptUpper", "Intercept upper"), NUMBER_COLUMN("slopeEffect", "Slope"), NUMBER_COLUMN("slopeSd", "Slope SD"), NUMBER_COLUMN("slopeLower", "Slope lower"), NUMBER_COLUMN("slopeUpper", "Slope upper")],
          groupRows,
          [],
          "lmm-slopes-group-effects-table",
        ),
        K.forestPlot(H, "lmm-slopes-fixed-effects-plot", `Fixed effects with ${percent(level)} Satterthwaite intervals`, forestRows, { xTitle: parsed.outcomeLabel }),
        H.vegaArtifact("lmm-slopes-group-effects-plot", `Group ${parsed.slopeLabel} slopes (conditional modes)`, {
          data: { values: groupRows },
          layer: [
            { mark: { type: "rule", strokeWidth: 2 }, encoding: { y: { field: "group", type: "nominal", title: parsed.groupLabel }, x: { field: "slopeLower", type: "quantitative", title: `Random ${parsed.slopeLabel} slope` }, x2: { field: "slopeUpper" } } },
            { mark: { type: "point", filled: true, size: 70 }, encoding: { y: { field: "group", type: "nominal" }, x: { field: "slopeEffect", type: "quantitative" }, tooltip: [{ field: "group" }, { field: "n" }, { field: "slopeEffect", format: ".5g" }, { field: "interceptEffect", format: ".5g" }] } },
            { mark: { type: "rule", strokeDash: [4, 4], color: "#777" }, encoding: { x: { datum: 0 } } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "Repeated measurements are taken on each subject or cluster over a covariate such as time or dose, and the researcher believes the clusters differ not only in level but also in how strongly they respond.",
    decision: "Whether the response slope genuinely varies between clusters, and what the average fixed effect is once that between-cluster slope variation is accounted for rather than absorbed into the residual.",
    mustShow: "The fixed-effect table with Satterthwaite degrees of freedom, the full random-effect variance-covariance including the intercept-slope correlation, the singular-fit verdict, and the per-group conditional slopes.",
    userGoal: "Report a subject-specific effect with standard errors that are not anti-conservative because within-subject slope heterogeneity was ignored.",
    nextActions: [
      { trigger: "singular-fit", action: "refit-without-the-random-slope-or-with-an-uncorrelated-random-effect-and-report-both", reason: "A boundary covariance means the data cannot identify the slope variance and correlation; the reported values and their degrees of freedom are not interpretable." },
      { trigger: "slope-variance-materially-above-zero", action: "keep-the-random-slope-and-report-the-per-group-slope-plot", reason: "Dropping a real random slope makes fixed-effect standard errors too small and inflates the false-positive rate for the covariate of interest." },
      { trigger: "satterthwaite-df-far-below-residual-df", action: "report-satterthwaite-degrees-of-freedom-and-avoid-large-sample-z-intervals", reason: "Few effective clusters make normal-theory intervals too narrow, which is exactly the case Satterthwaite exists to correct." },
      { trigger: "population-averaged-effect-wanted", action: "switch-to-generalized-estimating-equations", reason: "A mixed model estimates a cluster-specific effect; a marginal question about the population average is the GEE question, not this one." },
      { trigger: "fixed-effect-supported", action: "bind-fixed-effect-table-variance-table-and-group-slope-plot", reason: "Readers need the effect, the variance structure that produced its standard error, and the cluster-level heterogeneity behind it." },
    ],
  },
  fixture: {
    data: {
      y: [5.75, 6.1, 8.43, 9.43, 10.31, 4.68, 4.75, 4.86, 5.53, 6.08, 6.54, 6.51, 7.66, 9.28, 11.02, 3.05, 4.41, 5.56, 5.93, 7.34, 8.06, 7.23, 8.88, 10.19, 9.94, 5.82, 6.18, 7.31, 7.06, 8.02, 4.41, 7.27, 8.02, 8.68, 11.56, 6.48, 7.63, 10.84, 11.61, 13.83, 6.45, 7.47, 8.55, 9.52, 10.13, 6.18, 9.18, 10.86, 13.61, 14.86],
      slope: [0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1, 2, 3, 4],
      groups: ["s01", "s01", "s01", "s01", "s01", "s02", "s02", "s02", "s02", "s02", "s03", "s03", "s03", "s03", "s03", "s04", "s04", "s04", "s04", "s04", "s05", "s05", "s05", "s05", "s05", "s06", "s06", "s06", "s06", "s06", "s07", "s07", "s07", "s07", "s07", "s08", "s08", "s08", "s08", "s08", "s09", "s09", "s09", "s09", "s09", "s10", "s10", "s10", "s10", "s10"],
      outcomeLabel: "Reaction score",
      groupLabel: "Subject",
      slopeLabel: "Session",
    },
    options: { fitMethod: "reml", confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "Gaussian linear mixed model with exactly one grouping factor carrying a correlated random intercept and one random slope, fitted by profiled REML or ML over the relative covariance factor, with Satterthwaite denominator degrees of freedom, conditional modes with conditional intervals, and an explicit singular-fit verdict.",
    oracle: {
      level: "external-library-partial",
      evidence: ["contracts/mixed-models-scipy-crosscheck.py", "contracts/mixed-models-contract.cjs"],
      verifiedOutputs: [
        "fixed-effect coefficients (statsmodels MixedLM with a correlated random slope)",
        "fixed-effect standard errors (statsmodels MixedLM)",
        "random-effect variance-covariance matrix and residual variance (statsmodels MixedLM cov_re and scale)",
        "REML and ML profiled log-likelihood (statsmodels MixedLM llf)",
      ],
      excludedOutputs: [
        "Satterthwaite denominator degrees of freedom and the p-values that use them (statsmodels reports z inference and has no denominator-df counterpart)",
        "conditional modes and conditional interval widths",
        "singular-fit verdict",
      ],
    },
    diagnostic: {
      level: "method-specific-partial",
      emitted: ["singular fit", "optimizer", "denominator degrees of freedom", "fit method", "renderer exact-data contract"],
      limitations: ["no Kenward-Roger correction", "no likelihood-ratio test of the random slope", "no residual or random-effect normality screen"],
    },
    knownGaps: [
      "Satterthwaite degrees of freedom are cross-checked only for internal consistency (finite, positive, at most the residual n - p) because statsmodels has no denominator-df implementation to compare against",
      "more than one grouping factor, more than one random slope, uncorrelated random effects, and residual correlation structures are not supported",
      "no boundary likelihood-ratio test for whether the random slope is needed",
      "conditional modes are empirical Bayes predictions and are not cross-checked against statsmodels random_effects",
    ],
  },
};

/* ------------------------------------------------------------------------------------------ */
/* 2. generalized_estimating_equations                                                          */
/* ------------------------------------------------------------------------------------------ */

const GEE_FAMILIES = {
  gaussian: {
    link: "identity",
    variance: () => 1,
    mean: (eta) => eta,
    derivative: () => 1,
    estimateScale: true,
    validate: () => null,
  },
  binomial: {
    link: "logit",
    variance: (mu) => mu * (1 - mu),
    mean: (eta) => 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, eta)))),
    derivative: (mu) => mu * (1 - mu),
    estimateScale: false,
    validate: (values) => values.every((value) => value === 0 || value === 1) ? null : "binomial GEE requires data.y to contain only 0 and 1",
  },
  poisson: {
    link: "log",
    variance: (mu) => mu,
    mean: (eta) => Math.exp(Math.max(-500, Math.min(500, eta))),
    derivative: (mu) => mu,
    estimateScale: false,
    validate: (values) => values.every((value) => Number.isInteger(value) && value >= 0) ? null : "Poisson GEE requires data.y to contain non-negative integer counts",
  },
};

/**
 * Solve R^-1 x for the three working correlations, sandwiched by the marginal standard deviations:
 * returns V^-1 x with V = A^(1/2) R A^(1/2). Closed forms mirror statsmodels'
 * CovStruct.covariance_matrix_solve so the working covariance is identical by construction.
 */
function workingSolve(structure, alpha, standardDeviations, vectors) {
  const k = standardDeviations.length;
  return vectors.map((vector) => {
    const scaled = vector.map((value, index) => value / standardDeviations[index]);
    let solved;
    if (structure === "independence" || alpha === 0 || k === 1) {
      solved = scaled.slice();
    } else if (structure === "exchangeable") {
      const c = alpha / (1 - alpha) / (1 + alpha * (k - 1));
      const total = scaled.reduce((sum, value) => sum + value, 0);
      solved = scaled.map((value) => value / (1 - alpha) - c * total);
    } else if (k === 2) {
      const factor = 1 / (1 - alpha * alpha);
      solved = [factor * (scaled[0] - alpha * scaled[1]), factor * (scaled[1] - alpha * scaled[0])];
    } else {
      const c0 = (1 + alpha * alpha) / (1 - alpha * alpha);
      const c1 = 1 / (1 - alpha * alpha);
      const c2 = -alpha / (1 - alpha * alpha);
      solved = scaled.map((value, index) => {
        if (index === 0) return c1 * scaled[0] + c2 * scaled[1];
        if (index === k - 1) return c1 * scaled[k - 1] + c2 * scaled[k - 2];
        return c0 * value + c2 * scaled[index - 1] + c2 * scaled[index + 1];
      });
    }
    return solved.map((value, index) => value / standardDeviations[index]);
  });
}

function geeFit(parsed, structure, options, budget, H) {
  const family = GEE_FAMILIES[parsed.family];
  const { y, x, cluster, offset } = parsed;
  const n = y.length;
  const p = x[0].length;
  const start = parsed.startBeta;
  let beta = start.slice();
  let alpha = 0;
  let scale = 1;
  let converged = false;
  let iterations = 0;
  const clusterCount = cluster.rows.length;

  const meanAt = (candidate) => {
    const mu = Array(n);
    const derivative = Array(n);
    for (let row = 0; row < n; row += 1) {
      let eta = offset === null ? 0 : offset[row];
      for (let column = 0; column < p; column += 1) eta += x[row][column] * candidate[column];
      const value = family.mean(eta);
      mu[row] = value;
      derivative[row] = family.derivative(value);
    }
    return { mu, derivative };
  };

  // Pearson scale exactly as statsmodels GEE.estimate_scale: sum(r^2) / (n - p), and fixed at 1
  // for the binomial and Poisson families (statsmodels' default scaletype=None behaviour).
  const pearsonScale = (mu) => {
    let total = 0;
    for (let row = 0; row < n; row += 1) {
      const variance = family.variance(mu[row]);
      if (!(variance > 0)) H.fail("STAT_DEGENERATE", "a fitted mean produced a zero working variance; the GEE cannot be solved");
      total += (y[row] - mu[row]) ** 2 / variance;
    }
    return total / (n - p);
  };

  // Dependence updates copy statsmodels' moment estimators exactly:
  //   exchangeable  alpha = sum_{i, j<k} r_ij r_ik / (phi * (n_pairs - p))   (Liang-Zeger)
  //   ar(1)         alpha = lag1 / lag0 with per-cluster averaging, i.e. statsmodels'
  //                 Autoregressive(grid=True) estimator, which uses within-cluster row position
  //                 as the time index. Cluster rows keep their input order for that reason.
  const updateDependence = (mu) => {
    if (structure === "independence") return 0;
    if (structure === "exchangeable") {
      let squared = 0;
      let cross = 0;
      let pairs = 0;
      for (const rows of cluster.rows) {
        let sum = 0;
        let sumSquares = 0;
        for (const row of rows) {
          const residual = (y[row] - mu[row]) / Math.sqrt(family.variance(mu[row]));
          sum += residual;
          sumSquares += residual * residual;
        }
        squared += sumSquares;
        cross += (sum * sum - sumSquares) / 2;
        pairs += 0.5 * rows.length * (rows.length - 1);
      }
      if (!(pairs > p)) H.fail("STAT_INSUFFICIENT_SAMPLE", "the exchangeable working correlation needs more within-cluster pairs than model parameters");
      const localScale = squared / (n - p);
      return cross / localScale / (pairs - p);
    }
    let lag0 = 0;
    let lag1 = 0;
    const arScale = family.estimateScale ? pearsonScale(mu) : 1;
    for (const rows of cluster.rows) {
      if (rows.length < 2) continue;
      const residuals = rows.map((row) => (y[row] - mu[row]) / Math.sqrt(arScale * family.variance(mu[row])));
      let product = 0;
      let squares = 0;
      for (let index = 0; index < residuals.length; index += 1) {
        squares += residuals[index] * residuals[index];
        if (index + 1 < residuals.length) product += residuals[index] * residuals[index + 1];
      }
      lag1 += product / (residuals.length - 1);
      lag0 += squares / residuals.length;
    }
    if (!(lag0 > 0)) H.fail("STAT_DEGENERATE", "AR(1) working correlation has no residual variation");
    return lag1 / lag0;
  };

  let mean = meanAt(beta);
  for (iterations = 1; iterations <= 200; iterations += 1) {
    budget.check(1024);
    alpha = updateDependence(mean.mu);
    if (!Number.isFinite(alpha)) H.fail("STAT_NUMERIC_FAILURE", "working correlation parameter is not finite");
    if (structure !== "independence" && Math.abs(alpha) >= 0.999) H.fail("STAT_DEGENERATE", "working correlation parameter reached the |alpha| = 1 boundary");
    scale = family.estimateScale ? pearsonScale(mean.mu) : 1;
    const bread = Array.from({ length: p }, () => Array(p).fill(0));
    const score = Array(p).fill(0);
    for (const rows of cluster.rows) {
      const standardDeviations = rows.map((row) => Math.sqrt(family.variance(mean.mu[row])));
      const residual = rows.map((row) => y[row] - mean.mu[row]);
      const derivativeColumns = [];
      for (let column = 0; column < p; column += 1) derivativeColumns.push(rows.map((row) => mean.derivative[row] * x[row][column]));
      const solved = workingSolve(structure, alpha, standardDeviations, [...derivativeColumns, residual]);
      const solvedResidual = solved[p];
      for (let left = 0; left < p; left += 1) {
        const dLeft = derivativeColumns[left];
        for (let index = 0; index < rows.length; index += 1) score[left] += dLeft[index] * solvedResidual[index];
        for (let right = 0; right < p; right += 1) {
          const solvedRight = solved[right];
          let total = 0;
          for (let index = 0; index < rows.length; index += 1) total += dLeft[index] * solvedRight[index];
          bread[left][right] += total;
        }
      }
    }
    let inverse;
    try { inverse = H.invert(bread); } catch { H.fail("STAT_SINGULAR_FIT", "GEE working information matrix is singular"); }
    const step = inverse.map((row) => row.reduce((total, value, index) => total + value * score[index], 0));
    if (step.some((value) => !Number.isFinite(value))) H.fail("STAT_NUMERIC_FAILURE", "GEE parameter update is not finite");
    beta = beta.map((value, index) => value + step[index]);
    mean = meanAt(beta);
    if (Math.max(...step.map((value) => Math.abs(value))) < options.tolerance) { converged = true; break; }
  }
  if (!converged) H.fail("STAT_NON_CONVERGENCE", `GEE with a ${structure} working correlation did not converge to the declared tolerance`);
  alpha = updateDependence(mean.mu);
  scale = family.estimateScale ? pearsonScale(mean.mu) : 1;

  // Sandwich exactly as statsmodels GEE._covmat: bread uses V = A^(1/2) R A^(1/2) with no scale,
  // cov_naive = bread^-1 * phi, cov_robust = bread^-1 meat bread^-1 (no finite-sample correction).
  const bread = Array.from({ length: p }, () => Array(p).fill(0));
  const meat = Array.from({ length: p }, () => Array(p).fill(0));
  const independenceInformation = Array.from({ length: p }, () => Array(p).fill(0));
  for (const rows of cluster.rows) {
    budget.check(256);
    const standardDeviations = rows.map((row) => Math.sqrt(family.variance(mean.mu[row])));
    const residual = rows.map((row) => y[row] - mean.mu[row]);
    const derivativeColumns = [];
    for (let column = 0; column < p; column += 1) derivativeColumns.push(rows.map((row) => mean.derivative[row] * x[row][column]));
    const solved = workingSolve(structure, alpha, standardDeviations, [...derivativeColumns, residual]);
    const solvedResidual = solved[p];
    const clusterScore = Array(p).fill(0);
    for (let left = 0; left < p; left += 1) {
      const dLeft = derivativeColumns[left];
      for (let index = 0; index < rows.length; index += 1) clusterScore[left] += dLeft[index] * solvedResidual[index];
      for (let right = 0; right < p; right += 1) {
        const solvedRight = solved[right];
        let total = 0;
        let independence = 0;
        for (let index = 0; index < rows.length; index += 1) {
          total += dLeft[index] * solvedRight[index];
          independence += dLeft[index] * derivativeColumns[right][index];
        }
        bread[left][right] += total;
        independenceInformation[left][right] += independence;
      }
    }
    for (let left = 0; left < p; left += 1) for (let right = 0; right < p; right += 1) meat[left][right] += clusterScore[left] * clusterScore[right];
  }
  let breadInverse;
  try { breadInverse = H.invert(bread); } catch { H.fail("STAT_SINGULAR_FIT", "GEE information matrix is singular at the solution"); }
  const robust = H.matMul(H.matMul(breadInverse, meat, budget), breadInverse, budget);
  const naive = breadInverse.map((row) => row.map((value) => value * scale));

  // QIC, numerically identical to statsmodels GEE.qic: Wedderburn's quasi-likelihood integral
  // evaluated by the trapezoid rule on 1000 points of linspace(-0.99999, 1), then
  // QIC = -2 Q + 2 tr(Omega_I V_robust) with Omega_I = sum D'D / phi.
  const steps = 1000;
  const lower = -0.99999;
  const width = (1 - lower) / (steps - 1);
  let quasi = 0;
  for (let index = 0; index < steps; index += 1) {
    budget.check(64);
    const grid = lower + width * index;
    let total = 0;
    for (let row = 0; row < n; row += 1) {
      const difference = mean.mu[row] - y[row];
      const point = y[row] + (grid + 1) * difference / 2;
      const variance = family.variance(point);
      if (!(variance > 0)) H.fail("STAT_DEGENERATE", "the quasi-likelihood integrand has a zero variance function");
      total += difference * difference * (grid + 1) / variance;
    }
    const value = -total / (4 * scale);
    quasi += (index === 0 || index === steps - 1) ? value / 2 : value;
  }
  quasi *= width;
  let trace = 0;
  for (let left = 0; left < p; left += 1) for (let right = 0; right < p; right += 1) trace += independenceInformation[left][right] / scale * robust[right][left];
  const qic = -2 * quasi + 2 * trace;
  const qicu = -2 * quasi + 2 * p;
  return { beta, alpha, scale, robust, naive, mu: mean.mu, iterations, converged, quasiLikelihood: quasi, qic, qicu, clusterCount, structure };
}

const generalizedEstimatingEquations = {
  method: "generalized_estimating_equations",
  family: "mixed-models",
  analysisModel: { families: ["gee", "mixed-models"], distributions: [null, "normal", "gaussian", "binomial", "poisson"], links: [null, "identity", "logit", "log"] },
  optionKeys: ["confidenceLevel", "intercept", "timeoutMs", "maxIterations", "tolerance"],
  customOptions: {
    outcomeFamily: {
      schema: { type: "string", enum: ["gaussian", "binomial", "poisson"] },
      default: "gaussian",
      parse(value, H, path) {
        if (!Object.prototype.hasOwnProperty.call(GEE_FAMILIES, value)) H.fail("STAT_INVALID_INPUT", `${path} must be gaussian, binomial, or poisson`);
        return value;
      },
    },
    workingCorrelation: {
      schema: { type: "string", enum: ["exchangeable", "independence", "ar1"] },
      default: "exchangeable",
      parse(value, H, path) {
        if (!["exchangeable", "independence", "ar1"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be exchangeable, independence, or ar1`);
        return value;
      },
    },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["y", "groups", "predictors"],
    properties: {
      y: NUMERIC_SCHEMA(12),
      groups: GROUP_SCHEMA(12),
      predictors: PREDICTORS_SCHEMA(1),
      offset: NUMERIC_SCHEMA(12),
      outcomeLabel: LABEL_SCHEMA,
      groupLabel: LABEL_SCHEMA,
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["y", "groups", "predictors", "offset", "outcomeLabel", "groupLabel"], "data");
    const y = H.numericVector(data.y, "data.y", 12);
    if (y.length > MAX_ROWS) H.fail("STAT_LIMIT_EXCEEDED", `generalized_estimating_equations supports at most ${MAX_ROWS} observations`);
    const family = GEE_FAMILIES[options.outcomeFamily];
    const violation = family.validate(y);
    if (violation) H.fail("STAT_INVALID_INPUT", violation);
    const groups = H.categoryVector(data.groups, "data.groups", 12);
    if (groups.length !== y.length) H.fail("STAT_INVALID_INPUT", "data.groups must have the same length as data.y");
    const predictors = H.regressionPredictors(data.predictors, y.length, { allowEmpty: false });
    let offset = null;
    if (data.offset !== undefined) {
      if (options.outcomeFamily !== "poisson") H.fail("STAT_INVALID_INPUT", "data.offset is only supported for the Poisson family");
      offset = H.numericVector(data.offset, "data.offset", 12);
      if (offset.length !== y.length) H.fail("STAT_INVALID_INPUT", "data.offset must have the same length as data.y");
    }
    const cluster = clusterStructure(groups, H, "generalized_estimating_equations");
    return {
      y,
      groups,
      predictors,
      offset,
      cluster,
      family: options.outcomeFamily,
      outcomeLabel: H.label(data.outcomeLabel, "Outcome", "data.outcomeLabel"),
      groupLabel: H.label(data.groupLabel, "Cluster", "data.groupLabel"),
    };
  },
  analyze(parsed, options, budget, H) {
    const level = options.confidenceLevel;
    const design = H.designMatrix({ y: parsed.y, predictors: parsed.predictors }, options.intercept);
    const x = design.x;
    const p = x[0].length;
    const names = design.terms.map((term) => term.name);
    const n = parsed.y.length;
    if (H.matrixRank(x) !== p) H.fail("STAT_RANK_DEFICIENT", "GEE design matrix is rank deficient after categorical expansion");
    if (parsed.cluster.rows.length <= p) H.fail("STAT_INSUFFICIENT_SAMPLE", "the robust sandwich needs more clusters than model parameters");

    // Starting values from the corresponding independence GLM, as statsmodels' GEE does.
    let startBeta;
    if (parsed.family === "gaussian") startBeta = K.olsFit(parsed.y, x, H, budget).beta;
    else if (parsed.family === "binomial") startBeta = K.logisticFit(parsed.y, x, H, budget).beta;
    else startBeta = K.poissonFit(parsed.y, x, H, budget, { offset: parsed.offset }).beta;

    const state = { ...parsed, x, startBeta };
    const structures = ["independence", "exchangeable", "ar1"];
    const fits = {};
    for (const structure of structures) fits[structure] = geeFit(state, structure, options, budget, H);
    const chosen = fits[options.workingCorrelation];
    const critical = H.normalInv(1 - (1 - level) / 2);
    const exponentiate = parsed.family !== "gaussian";
    const coefficients = chosen.beta.map((estimate, index) => {
      const robustSe = Math.sqrt(Math.max(0, chosen.robust[index][index]));
      const naiveSe = Math.sqrt(Math.max(0, chosen.naive[index][index]));
      if (!(robustSe > 0)) H.fail("STAT_DEGENERATE", `robust standard error for ${names[index]} is zero`);
      const statistic = estimate / robustSe;
      const lower = estimate - critical * robustSe;
      const upper = estimate + critical * robustSe;
      const row = {
        term: names[index],
        estimate,
        standardError: robustSe,
        naiveStandardError: naiveSe,
        statistic,
        pValue: H.pFromNormal(statistic, "two-sided"),
        lower,
        upper,
      };
      if (exponentiate) {
        row.ratio = H.finiteExp(estimate, `${names[index]} ratio`);
        row.ratioLower = H.finiteExp(lower, `${names[index]} ratio lower`);
        row.ratioUpper = H.finiteExp(upper, `${names[index]} ratio upper`);
      } else {
        row.ratio = null;
        row.ratioLower = null;
        row.ratioUpper = null;
      }
      return row;
    });
    const structureRows = structures.map((structure) => {
      const fit = fits[structure];
      return {
        workingCorrelation: structure,
        selected: structure === options.workingCorrelation,
        dependenceParameter: structure === "independence" ? 0 : fit.alpha,
        scale: fit.scale,
        quasiLikelihood: fit.quasiLikelihood,
        qic: fit.qic,
        qicu: fit.qicu,
        deltaQic: fit.qic - Math.min(...structures.map((item) => fits[item].qic)),
        iterations: fit.iterations,
      };
    });
    const bestStructure = structureRows.reduce((best, row) => row.qic < best.qic ? row : best, structureRows[0]);
    const clusterSizes = parsed.cluster.rows.map((rows) => rows.length);
    const clusterRows = parsed.cluster.levels.map((groupLabel, index) => {
      const rows = parsed.cluster.rows[index];
      const residuals = rows.map((row) => parsed.y[row] - chosen.mu[row]);
      return {
        cluster: groupLabel,
        n: rows.length,
        meanOutcome: K.mean(rows.map((row) => parsed.y[row])),
        meanFitted: K.mean(rows.map((row) => chosen.mu[row])),
        meanResidual: K.mean(residuals),
        maximumAbsoluteResidual: Math.max(...residuals.map((value) => Math.abs(value))),
      };
    });
    const efficiency = coefficients.map((row) => ({ term: row.term, robustToNaiveRatio: row.naiveStandardError > 0 ? row.standardError / row.naiveStandardError : null }));
    const forestRows = coefficients.map((row) => ({ term: row.term, estimate: row.estimate, lower: row.lower, upper: row.upper, standardError: row.standardError, naiveStandardError: row.naiveStandardError, statistic: row.statistic, pValue: row.pValue, ratio: row.ratio, ratioLower: row.ratioLower, ratioUpper: row.ratioUpper }));
    return {
      sample: {
        n,
        clusters: parsed.cluster.levels.length,
        minimumClusterSize: Math.min(...clusterSizes),
        maximumClusterSize: Math.max(...clusterSizes),
        coefficients: p,
        family: parsed.family,
        link: GEE_FAMILIES[parsed.family].link,
      },
      estimates: [
        ...coefficients.map((row) => ({ kind: "coefficient", ...row })),
        { kind: "working-correlation", term: `${options.workingCorrelation} dependence parameter`, estimate: options.workingCorrelation === "independence" ? 0 : chosen.alpha, structure: options.workingCorrelation },
        { kind: "scale", term: "scale (dispersion)", estimate: chosen.scale, estimated: GEE_FAMILIES[parsed.family].estimateScale },
        ...structureRows.map((row) => ({ kind: "structure-comparison", term: `${row.workingCorrelation} working correlation`, estimate: row.qic, ...row })),
        {
          kind: "interpretation",
          term: "target of inference",
          family: parsed.family,
          link: GEE_FAMILIES[parsed.family].link,
          detail: "population-averaged (marginal) coefficients: the change in the population mean response per unit predictor, not the change for an individual cluster",
        },
      ],
      tests: coefficients.map((row) => ({
        name: `Marginal coefficient: ${row.term}`,
        statistic: row.statistic,
        distribution: "standard normal with robust sandwich standard error",
        df: null,
        pValue: row.pValue,
      })),
      confidenceIntervals: coefficients.map((row) => ({ parameter: row.term, level, lower: row.lower, upper: row.upper, method: "robust sandwich normal approximation" })),
      effectSizes: [
        { name: "working correlation parameter", estimate: options.workingCorrelation === "independence" ? 0 : chosen.alpha },
        ...coefficients.map((row) => ({ name: `marginal ${exponentiate ? "log-" : ""}effect ${row.term}`, estimate: row.estimate, ...(exponentiate ? { ratio: row.ratio } : {}) })),
      ],
      assumptions: [
        { name: "clusters are independent of one another", status: "requires_design_review" },
        { name: "marginal mean model is correctly specified", status: "required_for_consistency", detail: "GEE coefficients are consistent only if the marginal mean is right; the working correlation may be wrong" },
        { name: "working correlation structure", status: "may_be_misspecified_by_design", detail: "robust standard errors stay valid under misspecification; QIC ranks the candidate structures" },
        { name: "missingness is completely at random", status: "requires_design_review", detail: "unweighted GEE is not valid under missing-at-random dropout" },
        { name: "enough clusters for the sandwich", status: parsed.cluster.levels.length >= 30 ? "satisfied" : "small_cluster_count", clusters: parsed.cluster.levels.length },
      ],
      diagnostics: [
        { name: "estimating-equation solution", status: chosen.converged ? "converged" : "iteration_limit", iterations: chosen.iterations, tolerance: options.tolerance },
        {
          name: "working correlation",
          status: "estimated",
          structure: options.workingCorrelation,
          dependenceParameter: options.workingCorrelation === "independence" ? 0 : chosen.alpha,
          estimator: options.workingCorrelation === "exchangeable"
            ? "Liang-Zeger moment estimator on Pearson residuals, divided by (number of within-cluster pairs - p)"
            : options.workingCorrelation === "ar1"
              ? "lag-1 to lag-0 Pearson residual ratio on within-cluster row position (statsmodels Autoregressive with grid=True)"
              : "fixed at zero",
          timeIndex: options.workingCorrelation === "ar1" ? "within-cluster input row order" : null,
        },
        {
          name: "covariance estimator",
          status: "robust_sandwich",
          finiteSampleCorrection: "none",
          detail: "matches the statsmodels GEE default: no g/(g-1) or Mancl-DeRouen bias correction is applied, so standard errors are anti-conservative with few clusters",
          clusters: parsed.cluster.levels.length,
        },
        { name: "robust versus model-based standard errors", status: "reported", ratios: efficiency, boundary: "a large ratio means the working correlation is a poor description of the real dependence" },
        {
          name: "correlation-structure selection",
          status: bestStructure.workingCorrelation === options.workingCorrelation ? "selected_structure_minimises_qic" : "another_structure_minimises_qic",
          selected: options.workingCorrelation,
          minimumQicStructure: bestStructure.workingCorrelation,
          qic: structureRows.map((row) => ({ workingCorrelation: row.workingCorrelation, qic: row.qic, qicu: row.qicu })),
          boundary: "QIC compares working correlations for the same mean model on the same rows; it is not comparable across different outcomes or samples",
        },
        {
          name: "population-averaged interpretation",
          status: "declared",
          detail: "these coefficients answer a marginal question; for a cluster-specific answer on the same data use generalized_linear_mixed_model or linear_mixed_model_random_slopes",
        },
        { name: "renderer exact-data contract", status: "verified", inlineRows: "all", sampling: "none", coefficientRows: forestRows.length, structureRows: structureRows.length, clusterRows: clusterRows.length, coefficientRowsHash: H.sha256(forestRows) },
      ],
      artifacts: [
        H.tableArtifact(
          `Population-averaged GEE coefficients: ${parsed.outcomeLabel}`,
          `${parsed.family} family, ${GEE_FAMILIES[parsed.family].link} link, ${options.workingCorrelation} working correlation; ${percent(level)} robust sandwich intervals.`,
          [STRING_COLUMN("term", "Term"), NUMBER_COLUMN("estimate", "Estimate"), NUMBER_COLUMN("standardError", "Robust SE"), NUMBER_COLUMN("naiveStandardError", "Model-based SE"), NUMBER_COLUMN("statistic", "z"), NUMBER_COLUMN("pValue", "p"), NUMBER_COLUMN("lower", "CI lower"), NUMBER_COLUMN("upper", "CI upper"), NUMBER_COLUMN("ratio", exponentiate ? "exp(estimate)" : "ratio"), NUMBER_COLUMN("ratioLower", "Ratio lower"), NUMBER_COLUMN("ratioUpper", "Ratio upper")],
          forestRows,
          ["Coefficients are population-averaged: they describe the population mean, not a single cluster.", "Inference uses the robust sandwich with a normal reference and no finite-sample correction."],
          "gee-coefficients-table",
        ),
        H.tableArtifact(
          "Working correlation structures compared by QIC",
          "The same marginal mean model refitted under each working correlation; QIC ranks the correlation structures and QICu ranks mean structures only.",
          [STRING_COLUMN("workingCorrelation", "Working correlation"), BOOLEAN_COLUMN("selected", "Selected"), NUMBER_COLUMN("dependenceParameter", "Dependence parameter"), NUMBER_COLUMN("scale", "Scale"), NUMBER_COLUMN("quasiLikelihood", "Quasi-likelihood"), NUMBER_COLUMN("qic", "QIC"), NUMBER_COLUMN("qicu", "QICu"), NUMBER_COLUMN("deltaQic", "Delta QIC"), NUMBER_COLUMN("iterations", "Iterations")],
          structureRows,
          [`Lowest QIC: ${bestStructure.workingCorrelation}.`, "QIC uses the numerically evaluated Wedderburn quasi-likelihood, so only differences between rows are meaningful."],
          "gee-structure-table",
        ),
        H.tableArtifact(
          `Cluster summary (${parsed.groupLabel})`,
          "Observed and fitted means per cluster under the selected working correlation.",
          [STRING_COLUMN("cluster", "Cluster"), NUMBER_COLUMN("n", "n"), NUMBER_COLUMN("meanOutcome", "Mean observed"), NUMBER_COLUMN("meanFitted", "Mean fitted"), NUMBER_COLUMN("meanResidual", "Mean residual"), NUMBER_COLUMN("maximumAbsoluteResidual", "Max |residual|")],
          clusterRows,
          [],
          "gee-cluster-table",
        ),
        K.forestPlot(H, "gee-coefficients-plot", `Population-averaged coefficients with ${percent(level)} robust intervals`, forestRows, { xTitle: "Marginal coefficient" }),
        H.vegaArtifact("gee-structure-plot", "QIC by working correlation structure", {
          data: { values: structureRows },
          layer: [
            { mark: { type: "bar" }, encoding: { x: { field: "workingCorrelation", type: "nominal", title: "Working correlation", sort: null }, y: { field: "qic", type: "quantitative", title: "QIC" }, color: { field: "selected", type: "nominal", title: "Selected" }, tooltip: [{ field: "workingCorrelation" }, { field: "qic", format: ".6g" }, { field: "qicu", format: ".6g" }, { field: "dependenceParameter", format: ".4g" }] } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "Outcomes are clustered or repeated and the research question is about the population average response, not about how one particular subject would change.",
    decision: "The marginal effect of each predictor with standard errors that survive a wrong guess about the within-cluster correlation, plus which working correlation the data actually support.",
    mustShow: "The coefficient table with robust and model-based standard errors side by side, the estimated dependence parameter, the QIC comparison across working correlations, and the statement that the coefficients are population-averaged.",
    userGoal: "Report a defensible population-level effect from clustered data without having to model the cluster-level random effects correctly.",
    nextActions: [
      { trigger: "subject-specific-question", action: "switch-to-generalized-linear-mixed-model", reason: "GEE answers what happens to the population average; a question about how an individual subject changes is a random-effects question and the two coefficients are not the same number for non-identity links." },
      { trigger: "another-structure-minimises-qic", action: "refit-with-the-minimum-qic-working-correlation-and-report-both", reason: "QIC exists precisely to choose the correlation structure; reporting a structure the data rank worse needs a stated reason." },
      { trigger: "robust-far-larger-than-model-based-standard-errors", action: "treat-the-working-correlation-as-misspecified-and-keep-the-robust-intervals", reason: "A large gap says the assumed correlation is wrong; only the sandwich interval remains valid." },
      { trigger: "few-clusters", action: "apply-a-small-sample-corrected-sandwich-or-a-cluster-bootstrap-outside-this-method", reason: "With few clusters the uncorrected sandwich is anti-conservative and this method applies no correction." },
      { trigger: "informative-dropout-suspected", action: "use-weighted-gee-or-a-likelihood-based-mixed-model", reason: "Unweighted GEE requires data missing completely at random, which dropout related to the outcome violates." },
    ],
  },
  fixture: {
    data: {
      y: [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1],
      groups: ["c01", "c01", "c01", "c01", "c02", "c02", "c02", "c02", "c03", "c03", "c03", "c03", "c04", "c04", "c04", "c04", "c05", "c05", "c05", "c05", "c06", "c06", "c06", "c06", "c07", "c07", "c07", "c07", "c08", "c08", "c08", "c08", "c09", "c09", "c09", "c09", "c10", "c10", "c10", "c10", "c11", "c11", "c11", "c11", "c12", "c12", "c12", "c12", "c13", "c13", "c13", "c13", "c14", "c14", "c14", "c14", "c15", "c15", "c15", "c15"],
      predictors: [
        { name: "Visit", type: "numeric", values: [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3] },
        { name: "Treatment", type: "numeric", values: [1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1] },
      ],
      outcomeLabel: "Symptom free",
      groupLabel: "Clinic",
    },
    options: { outcomeFamily: "binomial", workingCorrelation: "exchangeable", confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "Generalized estimating equations for one level of clustering with Gaussian identity, binomial logit, and Poisson log families, exchangeable, independence, and AR(1) working correlations estimated by the statsmodels moment estimators, robust sandwich covariance with no finite-sample correction, model-based covariance, and QIC/QICu from the numerically evaluated Wedderburn quasi-likelihood.",
    oracle: {
      level: "external-library-partial",
      evidence: ["contracts/mixed-models-scipy-crosscheck.py", "contracts/mixed-models-contract.cjs"],
      verifiedOutputs: [
        "marginal coefficients for all three working correlations and all three families (statsmodels GEE)",
        "robust sandwich standard errors (statsmodels GEE cov_robust)",
        "model-based standard errors and the Pearson scale (statsmodels GEE cov_naive and scale)",
        "working correlation parameter (statsmodels Exchangeable and Autoregressive(grid=True))",
        "QIC and QICu (statsmodels GEEResults.qic)",
      ],
      excludedOutputs: [
        "cluster summary table",
        "robust-to-model-based standard error ratios",
        "the structure-selection verdict itself",
      ],
    },
    diagnostic: {
      level: "method-specific-partial",
      emitted: ["estimating-equation solution", "working correlation", "covariance estimator", "robust versus model-based standard errors", "correlation-structure selection", "population-averaged interpretation"],
      limitations: ["no Mancl-DeRouen or Kauermann-Carroll small-sample sandwich", "no weighted GEE for missing-at-random dropout", "no ordinal or multinomial families"],
    },
    knownGaps: [
      "no small-sample corrected sandwich; with fewer than roughly 30 clusters the reported standard errors are known to be anti-conservative and only the diagnostic says so",
      "unstructured, nested, and stationary-m-dependent working correlations are not implemented",
      "AR(1) uses the within-cluster row position as its time index, matching statsmodels Autoregressive(grid=True); unequally spaced time points and the statsmodels grid=False weighted-least-squares estimator are not supported",
      "weighted GEE, ordinal and multinomial families, and negative binomial dispersion are not implemented",
    ],
  },
};

/* ------------------------------------------------------------------------------------------ */
/* 3. generalized_linear_mixed_model                                                            */
/* ------------------------------------------------------------------------------------------ */

const GLMM_FAMILIES = {
  binomial: {
    link: "logit",
    validate: (values) => values.every((value) => value === 0 || value === 1) ? null : "binomial GLMM requires data.y to contain only 0 and 1",
    mean: (eta) => 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, eta)))),
    // log f(y | eta) for the Bernoulli logit, written so large |eta| stays finite.
    logDensity: (y, eta) => {
      const bounded = Math.max(-500, Math.min(500, eta));
      return y * bounded - (bounded > 0 ? bounded + Math.log1p(Math.exp(-bounded)) : Math.log1p(Math.exp(bounded)));
    },
    score: (y, mu) => y - mu,
    information: (mu) => mu * (1 - mu),
  },
  poisson: {
    link: "log",
    validate: (values) => values.every((value) => Number.isInteger(value) && value >= 0) ? null : "Poisson GLMM requires data.y to contain non-negative integer counts",
    mean: (eta) => Math.exp(Math.max(-500, Math.min(500, eta))),
    logDensity: null,
    score: (y, mu) => y - mu,
    information: (mu) => mu,
  },
};

/**
 * Adaptive Gauss-Hermite log-likelihood for one random intercept.
 * For every cluster the integrand log h(b) = log N(b; 0, sigma^2) + sum_j log f(y_ij | eta_ij + b)
 * is centred at its mode and scaled by its curvature, then
 *   integral = sum_k sqrt(2) s_i w_k exp(x_k^2) h(mode_i + sqrt(2) s_i x_k).
 * With one quadrature point this collapses to the Laplace approximation.
 */
function glmmLogLikelihood(state, beta, sigma, quadrature, H, budget) {
  const { y, x, cluster, offset, family } = state;
  const spec = GLMM_FAMILIES[family];
  const p = x[0].length;
  if (!(sigma > 0) || !Number.isFinite(sigma)) return Number.NaN;
  const eta = y.map((_, row) => {
    let total = offset === null ? 0 : offset[row];
    for (let column = 0; column < p; column += 1) total += x[row][column] * beta[column];
    return total;
  });
  const logDensity = (value, linear) => {
    if (spec.logDensity) return spec.logDensity(value, linear);
    const bounded = Math.max(-500, Math.min(500, linear));
    return value * bounded - Math.exp(bounded) - H.logGamma(value + 1);
  };
  let total = 0;
  const modes = [];
  for (const rows of cluster.rows) {
    budget.check(64);
    // Newton on the mode of the log integrand; the objective is strictly concave for both families.
    let mode = 0;
    let curvature = 1 / (sigma * sigma);
    for (let iteration = 0; iteration < 60; iteration += 1) {
      let gradient = -mode / (sigma * sigma);
      let hessian = -1 / (sigma * sigma);
      for (const row of rows) {
        const mu = spec.mean(eta[row] + mode);
        gradient += spec.score(y[row], mu);
        hessian -= spec.information(mu);
      }
      if (!Number.isFinite(gradient) || !Number.isFinite(hessian) || hessian >= 0) return Number.NaN;
      const step = -gradient / hessian;
      mode += Math.max(-4, Math.min(4, step));
      curvature = -hessian;
      if (Math.abs(step) < 1e-12) break;
    }
    if (!(curvature > 0) || !Number.isFinite(curvature)) return Number.NaN;
    modes.push(mode);
    const spread = 1 / Math.sqrt(curvature);
    const terms = [];
    for (let point = 0; point < quadrature.nodes.length; point += 1) {
      const node = quadrature.nodes[point];
      const b = mode + Math.SQRT2 * spread * node;
      let logIntegrand = -0.5 * Math.log(2 * Math.PI) - Math.log(sigma) - b * b / (2 * sigma * sigma);
      for (const row of rows) logIntegrand += logDensity(y[row], eta[row] + b);
      terms.push(Math.log(quadrature.weights[point]) + node * node + logIntegrand);
    }
    const maximum = Math.max(...terms);
    if (!Number.isFinite(maximum)) return Number.NaN;
    let sum = 0;
    for (const term of terms) sum += Math.exp(term - maximum);
    total += Math.log(Math.SQRT2 * spread) + maximum + Math.log(sum);
  }
  return Number.isFinite(total) ? total : Number.NaN;
}

const generalizedLinearMixedModel = {
  method: "generalized_linear_mixed_model",
  family: "mixed-models",
  analysisModel: { families: ["mixed-models", "mixed-effects", "glm"], distributions: [null, "binomial", "poisson"], links: [null, "logit", "log"] },
  optionKeys: ["confidenceLevel", "intercept", "timeoutMs", "maxIterations", "tolerance"],
  customOptions: {
    outcomeFamily: {
      schema: { type: "string", enum: ["binomial", "poisson"] },
      default: "binomial",
      parse(value, H, path) {
        if (!Object.prototype.hasOwnProperty.call(GLMM_FAMILIES, value)) H.fail("STAT_INVALID_INPUT", `${path} must be binomial or poisson`);
        return value;
      },
    },
    quadraturePoints: {
      schema: { type: "integer", minimum: 1, maximum: 31 },
      default: 11,
      parse(value, H, path) {
        const points = H.integer(value, 1, 31, path);
        if (points % 2 === 0) H.fail("STAT_INVALID_INPUT", `${path} must be odd so the adapted mode is itself a quadrature node`);
        return points;
      },
    },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["y", "groups", "predictors"],
    properties: {
      y: NUMERIC_SCHEMA(12),
      groups: GROUP_SCHEMA(12),
      predictors: PREDICTORS_SCHEMA(1),
      offset: NUMERIC_SCHEMA(12),
      outcomeLabel: LABEL_SCHEMA,
      groupLabel: LABEL_SCHEMA,
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["y", "groups", "predictors", "offset", "outcomeLabel", "groupLabel"], "data");
    const y = H.numericVector(data.y, "data.y", 12);
    if (y.length > MAX_ROWS) H.fail("STAT_LIMIT_EXCEEDED", `generalized_linear_mixed_model supports at most ${MAX_ROWS} observations`);
    const spec = GLMM_FAMILIES[options.outcomeFamily];
    const violation = spec.validate(y);
    if (violation) H.fail("STAT_INVALID_INPUT", violation);
    if (options.outcomeFamily === "binomial" && (!y.some((value) => value === 1) || !y.some((value) => value === 0))) {
      H.fail("STAT_DEGENERATE", "data.y must contain both 0 and 1 for a binomial GLMM");
    }
    const groups = H.categoryVector(data.groups, "data.groups", 12);
    if (groups.length !== y.length) H.fail("STAT_INVALID_INPUT", "data.groups must have the same length as data.y");
    const predictors = H.regressionPredictors(data.predictors, y.length, { allowEmpty: false });
    let offset = null;
    if (data.offset !== undefined) {
      if (options.outcomeFamily !== "poisson") H.fail("STAT_INVALID_INPUT", "data.offset is only supported for the Poisson family");
      offset = H.numericVector(data.offset, "data.offset", 12);
      if (offset.length !== y.length) H.fail("STAT_INVALID_INPUT", "data.offset must have the same length as data.y");
    }
    const cluster = clusterStructure(groups, H, "generalized_linear_mixed_model");
    return {
      y,
      groups,
      predictors,
      offset,
      cluster,
      family: options.outcomeFamily,
      outcomeLabel: H.label(data.outcomeLabel, "Outcome", "data.outcomeLabel"),
      groupLabel: H.label(data.groupLabel, "Group", "data.groupLabel"),
    };
  },
  analyze(parsed, options, budget, H) {
    const level = options.confidenceLevel;
    const design = H.designMatrix({ y: parsed.y, predictors: parsed.predictors }, options.intercept);
    const x = design.x;
    const p = x[0].length;
    const names = design.terms.map((term) => term.name);
    const n = parsed.y.length;
    if (H.matrixRank(x) !== p) H.fail("STAT_RANK_DEFICIENT", "GLMM design matrix is rank deficient after categorical expansion");
    if (n <= p + 2) H.fail("STAT_INSUFFICIENT_SAMPLE", "at least p + 3 observations are required");
    const state = { ...parsed, x };
    const quadrature = gaussHermite(options.quadraturePoints, H, budget);

    // Start from the marginal GLM plus a small positive random-effect standard deviation.
    const startBeta = parsed.family === "binomial"
      ? K.logisticFit(parsed.y, x, H, budget).beta
      : K.poissonFit(parsed.y, x, H, budget, { offset: parsed.offset }).beta;
    const objective = (point) => {
      const value = glmmLogLikelihood(state, point.slice(0, p), Math.exp(point[p]), quadrature, H, budget);
      return Number.isFinite(value) ? -value : Number.POSITIVE_INFINITY;
    };
    const restarts = Math.max(3, Math.min(options.maxIterations, 12));
    const start = [...startBeta, Math.log(0.5)];
    const steps = [...startBeta.map((value) => Math.max(0.1, 0.25 * Math.abs(value))), 0.5];
    const search = minimizeWithRestarts(objective, start, steps, {
      restarts,
      iterationsPerRestart: 400 + 200 * p,
      tolerance: options.tolerance,
      budget,
    });
    if (!Number.isFinite(search.value)) H.fail("STAT_NUMERIC_FAILURE", "GLMM quadrature log-likelihood is not finite at the reported optimum");
    const parameters = search.point;
    const beta = parameters.slice(0, p);
    const sigma = Math.exp(parameters[p]);
    const logLikelihood = -search.value;
    const gradientSteps = parameters.map((value) => Math.max(1e-4, 1e-3 * Math.abs(value)));
    const gradient = richardsonGradient(objective, parameters, gradientSteps);
    const gradientNorm = Math.max(...gradient.map((value) => Math.abs(value)));
    const gradientTolerance = Math.max(1e-3, Math.sqrt(options.tolerance) * (1 + Math.abs(search.value)));
    if (!Number.isFinite(gradientNorm) || gradientNorm > gradientTolerance) {
      H.fail("STAT_NON_CONVERGENCE", "GLMM optimiser did not reach a stationary point of the quadrature log-likelihood", { gradientNorm, gradientTolerance });
    }
    // Observed information on the (beta, log sigma) scale, then delta method back to sigma.
    const hessian = richardsonHessian(objective, parameters, gradientSteps, H);
    let covariance = null;
    let observedInformation = "full";
    try { covariance = H.invert(hessian); } catch { covariance = null; }
    if (covariance === null) {
      // A random-intercept variance at the zero boundary leaves the log-sigma direction flat, so the
      // joint information is singular. Rather than refuse the fit, the fixed effects are reported
      // conditional on the fitted variance and the variance interval is withheld.
      const block = hessian.slice(0, p).map((row) => row.slice(0, p));
      let blockInverse;
      try { blockInverse = H.invert(block); } catch { H.fail("STAT_SINGULAR_FIT", "GLMM observed information is singular even after conditioning on the fitted random-intercept variance"); }
      covariance = Array.from({ length: p + 1 }, (_, row) => Array.from({ length: p + 1 }, (_, column) => (row < p && column < p) ? blockInverse[row][column] : Number.NaN));
      observedInformation = "conditioned_on_fitted_random_intercept_variance";
    }
    const critical = H.normalInv(1 - (1 - level) / 2);
    const exponentiate = true;
    const coefficients = beta.map((estimate, index) => {
      const variance = covariance[index][index];
      if (!(variance > 0) || !Number.isFinite(variance)) H.fail("STAT_DEGENERATE", `standard error for ${names[index]} is not positive and finite`);
      const standardError = Math.sqrt(variance);
      const statistic = estimate / standardError;
      const lower = estimate - critical * standardError;
      const upper = estimate + critical * standardError;
      return {
        term: names[index],
        estimate,
        standardError,
        statistic,
        pValue: H.pFromNormal(statistic, "two-sided"),
        lower,
        upper,
        ratio: H.finiteExp(estimate, `${names[index]} ratio`),
        ratioLower: H.finiteExp(lower, `${names[index]} ratio lower`),
        ratioUpper: H.finiteExp(upper, `${names[index]} ratio upper`),
      };
    });
    // A random-intercept standard deviation near zero is weakly identified on the log scale, so the
    // delta-method interval can overflow. That is reported as an absent interval, never as Infinity.
    const logSigmaVariance = covariance[p][p];
    const logSigmaSd = logSigmaVariance > 0 && Number.isFinite(logSigmaVariance) ? Math.sqrt(logSigmaVariance) : null;
    const sigmaStandardError = logSigmaSd === null ? null : logSigmaSd * sigma;
    const sigmaLower = logSigmaSd === null ? null : sigma * Math.exp(-critical * logSigmaSd);
    const rawSigmaUpper = logSigmaSd === null ? null : sigma * Math.exp(critical * logSigmaSd);
    const sigmaUpper = rawSigmaUpper !== null && Number.isFinite(rawSigmaUpper) ? rawSigmaUpper : null;

    // Quadrature sensitivity at the fitted parameters: the log-likelihood is only as trustworthy
    // as the number of nodes, so the researcher sees the value move (or stop moving) with Q.
    const sensitivityPoints = [...new Set([1, 3, 5, 7, 11, 15, 21, options.quadraturePoints])].filter((points) => points <= 31).sort((left, right) => left - right);
    const sensitivityRows = sensitivityPoints.map((points) => {
      const value = glmmLogLikelihood(state, beta, sigma, gaussHermite(points, H, budget), H, budget);
      return {
        quadraturePoints: points,
        selected: points === options.quadraturePoints,
        logLikelihood: Number.isFinite(value) ? value : null,
        deltaFromSelected: Number.isFinite(value) ? value - logLikelihood : null,
        rule: points === 1 ? "Laplace approximation" : "adaptive Gauss-Hermite",
      };
    });
    const stabilityReference = sensitivityRows.filter((row) => row.quadraturePoints >= Math.min(11, options.quadraturePoints) && row.deltaFromSelected !== null);
    const stable = stabilityReference.every((row) => Math.abs(row.deltaFromSelected) < 1e-4);

    // Empirical Bayes modes and curvature-based standard deviations at the fitted parameters.
    const spec = GLMM_FAMILIES[parsed.family];
    const eta = parsed.y.map((_, row) => {
      let total = parsed.offset === null ? 0 : parsed.offset[row];
      for (let column = 0; column < p; column += 1) total += x[row][column] * beta[column];
      return total;
    });
    const groupRows = parsed.cluster.levels.map((groupLabel, index) => {
      const rows = parsed.cluster.rows[index];
      let mode = 0;
      let curvature = 1 / (sigma * sigma);
      for (let iteration = 0; iteration < 60; iteration += 1) {
        let gradientValue = -mode / (sigma * sigma);
        let hessianValue = -1 / (sigma * sigma);
        for (const row of rows) {
          const mu = spec.mean(eta[row] + mode);
          gradientValue += spec.score(parsed.y[row], mu);
          hessianValue -= spec.information(mu);
        }
        const step = -gradientValue / hessianValue;
        mode += Math.max(-4, Math.min(4, step));
        curvature = -hessianValue;
        if (Math.abs(step) < 1e-12) break;
      }
      const posteriorSd = 1 / Math.sqrt(curvature);
      return {
        group: groupLabel,
        n: rows.length,
        conditionalMode: mode,
        posteriorSd,
        lower: mode - critical * posteriorSd,
        upper: mode + critical * posteriorSd,
        meanOutcome: K.mean(rows.map((row) => parsed.y[row])),
      };
    });
    const parameterCount = p + 1;
    const forestRows = coefficients.map((row) => ({ ...row }));
    const marginalLogLikelihood = glmmLogLikelihood({ ...state, cluster: { levels: parsed.cluster.levels, rows: parsed.cluster.rows } }, beta, 1e-6, quadrature, H, budget);
    return {
      sample: {
        n,
        groups: parsed.cluster.levels.length,
        minimumGroupSize: Math.min(...parsed.cluster.rows.map((rows) => rows.length)),
        maximumGroupSize: Math.max(...parsed.cluster.rows.map((rows) => rows.length)),
        coefficients: p,
        family: parsed.family,
        link: spec.link,
        quadraturePoints: options.quadraturePoints,
      },
      estimates: [
        ...coefficients.map((row) => ({ kind: "coefficient", ...row })),
        {
          kind: "variance-component",
          term: `Random intercept standard deviation (${parsed.groupLabel})`,
          estimate: sigma,
          variance: sigma * sigma,
          standardError: sigmaStandardError,
          lower: sigmaLower,
          upper: sigmaUpper,
          scale: "estimated as log standard deviation and transformed back by the delta method",
        },
        {
          kind: "model",
          term: "adaptive Gauss-Hermite likelihood",
          estimate: logLikelihood,
          logLikelihood,
          quadraturePoints: options.quadraturePoints,
          quadratureRule: options.quadraturePoints === 1 ? "Laplace approximation (adaptive Gauss-Hermite with one node)" : "adaptive Gauss-Hermite",
          deviance: -2 * logLikelihood,
          aic: -2 * logLikelihood + 2 * parameterCount,
          bic: -2 * logLikelihood + Math.log(n) * parameterCount,
        },
        ...sensitivityRows.map((row) => ({ kind: "quadrature-sensitivity", term: `${row.quadraturePoints}-node log-likelihood`, estimate: row.logLikelihood, ...row })),
        ...groupRows.map((row) => ({ kind: "group-effect", term: row.group, estimate: row.conditionalMode, ...row })),
        {
          kind: "interpretation",
          term: "target of inference",
          family: parsed.family,
          link: spec.link,
          detail: "subject-specific (conditional) coefficients: the change for a given cluster holding its random intercept fixed, which for a logit link is larger in absolute value than the population-averaged GEE coefficient",
        },
      ],
      tests: coefficients.map((row) => ({
        name: `Conditional coefficient: ${row.term}`,
        statistic: row.statistic,
        distribution: "standard normal from the observed information of the quadrature log-likelihood",
        df: null,
        pValue: row.pValue,
      })),
      confidenceIntervals: [
        ...coefficients.map((row) => ({ parameter: row.term, level, lower: row.lower, upper: row.upper, method: "observed-information normal approximation" })),
        { parameter: "random intercept standard deviation", level, lower: sigmaLower, upper: sigmaUpper, method: "log-scale normal approximation transformed by the delta method" },
      ],
      effectSizes: [
        { name: "random intercept standard deviation", estimate: sigma },
        { name: "random intercept variance", estimate: sigma * sigma },
        ...coefficients.map((row) => ({ name: `conditional effect ${row.term}`, estimate: row.estimate, ratio: row.ratio })),
      ],
      assumptions: [
        { name: "one grouping factor with a Gaussian random intercept", status: "verified_by_input_contract", groupLabel: parsed.groupLabel },
        { name: "conditional distribution is the declared family", status: "requires_design_review", family: parsed.family },
        { name: "independent groups", status: "requires_design_review" },
        { name: "no overdispersion beyond the random intercept", status: parsed.family === "poisson" ? "requires_review" : "not_applicable" },
        { name: "quadrature is accurate enough for the reported likelihood", status: stable ? "stable_across_quadrature_points" : "sensitive_to_quadrature_points" },
      ],
      diagnostics: [
        {
          name: "quadrature",
          status: stable ? "stable" : "sensitive",
          points: options.quadraturePoints,
          rule: options.quadraturePoints === 1 ? "Laplace approximation" : "adaptive Gauss-Hermite",
          nodes: quadrature.nodes,
          weights: quadrature.weights,
          logLikelihood,
          boundary: "the log-likelihood, AIC, and BIC are quadrature approximations; comparing models fitted with different node counts is not valid",
        },
        { name: "optimizer", status: search.converged ? "converged" : "iteration_limit", objective: search.value, restarts: search.restarts, simplexIterations: search.iterations, gradientNorm, gradientTolerance, parameterization: "(beta, log sigma)" },
        {
          name: "random-intercept magnitude",
          status: sigma < 1e-3 ? "near_zero_boundary" : "interior",
          standardDeviation: sigma,
          observedInformation,
          varianceIntervalAvailable: sigmaLower !== null && sigmaUpper !== null,
          logLikelihoodAtZeroVariance: Number.isFinite(marginalLogLikelihood) ? marginalLogLikelihood : null,
          detail: "the value at a numerically zero variance is reported for orientation only; it is not a boundary likelihood-ratio test, whose null distribution is a chi-square mixture",
        },
        {
          name: "subject-specific interpretation",
          status: "declared",
          detail: "these coefficients are conditional on the cluster; the population-averaged answer on the same data comes from generalized_estimating_equations and is attenuated toward zero for the logit link",
        },
        { name: "renderer exact-data contract", status: "verified", inlineRows: "all", sampling: "none", coefficientRows: forestRows.length, quadratureRows: sensitivityRows.length, groupRows: groupRows.length, coefficientRowsHash: H.sha256(forestRows) },
      ],
      artifacts: [
        H.tableArtifact(
          `Subject-specific GLMM coefficients: ${parsed.outcomeLabel}`,
          `${parsed.family} family, ${spec.link} link, one random intercept on ${parsed.groupLabel}; adaptive Gauss-Hermite with ${options.quadraturePoints} node${options.quadraturePoints === 1 ? "" : "s"}, ${percent(level)} intervals.`,
          [STRING_COLUMN("term", "Term"), NUMBER_COLUMN("estimate", "Estimate"), NUMBER_COLUMN("standardError", "SE"), NUMBER_COLUMN("statistic", "z"), NUMBER_COLUMN("pValue", "p"), NUMBER_COLUMN("lower", "CI lower"), NUMBER_COLUMN("upper", "CI upper"), NUMBER_COLUMN("ratio", exponentiate ? "exp(estimate)" : "ratio"), NUMBER_COLUMN("ratioLower", "Ratio lower"), NUMBER_COLUMN("ratioUpper", "Ratio upper")],
          forestRows,
          [`Random intercept SD = ${sigma.toPrecision(6)}${sigmaLower === null || sigmaUpper === null ? " (interval unavailable: the log-scale information is not positive definite)" : ` (${percent(level)} CI ${sigmaLower.toPrecision(6)} to ${sigmaUpper.toPrecision(6)})`}; log-likelihood = ${logLikelihood.toPrecision(10)}.`, "Coefficients are subject-specific, not population-averaged."],
          "glmm-fixed-effects-table",
        ),
        H.tableArtifact(
          "Quadrature sensitivity of the log-likelihood",
          "The same fitted parameters re-integrated at other node counts; accuracy of the reported likelihood depends on this table, not on the optimiser.",
          [NUMBER_COLUMN("quadraturePoints", "Nodes"), BOOLEAN_COLUMN("selected", "Selected"), STRING_COLUMN("rule", "Rule"), NUMBER_COLUMN("logLikelihood", "Log-likelihood"), NUMBER_COLUMN("deltaFromSelected", "Delta from selected")],
          sensitivityRows,
          [stable ? "The log-likelihood is stable across node counts at or above the selected value." : "The log-likelihood still moves with the node count; increase quadraturePoints before reporting."],
          "glmm-quadrature-table",
        ),
        H.tableArtifact(
          `Conditional modes by ${parsed.groupLabel}`,
          "Empirical Bayes modes of the random intercept with curvature-based conditional intervals.",
          [STRING_COLUMN("group", "Group"), NUMBER_COLUMN("n", "n"), NUMBER_COLUMN("meanOutcome", "Mean outcome"), NUMBER_COLUMN("conditionalMode", "Conditional mode"), NUMBER_COLUMN("posteriorSd", "Conditional SD"), NUMBER_COLUMN("lower", "CI lower"), NUMBER_COLUMN("upper", "CI upper")],
          groupRows,
          [],
          "glmm-group-effects-table",
        ),
        K.forestPlot(H, "glmm-fixed-effects-plot", `Subject-specific coefficients with ${percent(level)} intervals`, forestRows, { xTitle: "Conditional coefficient" }),
        H.vegaArtifact("glmm-quadrature-plot", "Log-likelihood against the number of quadrature nodes", {
          data: { values: sensitivityRows },
          layer: [
            { mark: { type: "line", strokeWidth: 2 }, encoding: { x: { field: "quadraturePoints", type: "quantitative", title: "Quadrature nodes" }, y: { field: "logLikelihood", type: "quantitative", title: "Log-likelihood", scale: { zero: false } } } },
            { mark: { type: "point", filled: true, size: 80 }, encoding: { x: { field: "quadraturePoints", type: "quantitative" }, y: { field: "logLikelihood", type: "quantitative" }, color: { field: "selected", type: "nominal", title: "Selected" }, tooltip: [{ field: "quadraturePoints" }, { field: "logLikelihood", format: ".10g" }, { field: "deltaFromSelected", format: ".3g" }] } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "A binary or count outcome is measured repeatedly within subjects or clusters and the question is what happens to a given subject, not to the population average.",
    decision: "The conditional effect of each predictor with the between-cluster variation estimated rather than ignored, and whether the reported likelihood is accurate enough at the chosen number of quadrature nodes.",
    mustShow: "The coefficient table on both the link and the ratio scale, the random-intercept standard deviation with its interval, the number of quadrature nodes and the log-likelihood they produced, and the quadrature sensitivity check.",
    userGoal: "Report a subject-specific odds or rate ratio for clustered non-Gaussian data, with a likelihood that is reproducible and stated to a declared quadrature accuracy.",
    nextActions: [
      { trigger: "sensitive-to-quadrature-points", action: "increase-quadraturepoints-until-the-log-likelihood-stops-moving-and-refit", reason: "A likelihood that still changes with the node count is not the model's likelihood, and every AIC or likelihood comparison built on it is unreliable." },
      { trigger: "population-averaged-effect-wanted", action: "switch-to-generalized-estimating-equations", reason: "For a logit link the subject-specific coefficient is systematically larger in magnitude than the population-averaged one; reporting one for the other misstates the effect." },
      { trigger: "near-zero-random-intercept", action: "compare-against-an-ordinary-glm-and-justify-keeping-the-random-effect", reason: "A random-effect standard deviation at the boundary means the clustering is not detectable here and the simpler model may be the honest report." },
      { trigger: "large-random-intercept-variance", action: "report-the-conditional-modes-and-check-for-an-omitted-cluster-level-covariate", reason: "Large between-cluster variation is usually a missing cluster-level predictor, which is a finding rather than a nuisance." },
      { trigger: "conditional-effect-supported", action: "bind-coefficient-table-quadrature-table-and-conditional-mode-table", reason: "Readers need the effect, the numerical accuracy behind its likelihood, and the cluster heterogeneity it conditions on." },
    ],
  },
  fixture: {
    data: {
      y: [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1],
      groups: ["c01", "c01", "c01", "c01", "c02", "c02", "c02", "c02", "c03", "c03", "c03", "c03", "c04", "c04", "c04", "c04", "c05", "c05", "c05", "c05", "c06", "c06", "c06", "c06", "c07", "c07", "c07", "c07", "c08", "c08", "c08", "c08", "c09", "c09", "c09", "c09", "c10", "c10", "c10", "c10", "c11", "c11", "c11", "c11", "c12", "c12", "c12", "c12", "c13", "c13", "c13", "c13", "c14", "c14", "c14", "c14", "c15", "c15", "c15", "c15"],
      predictors: [
        { name: "Visit", type: "numeric", values: [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3] },
        { name: "Treatment", type: "numeric", values: [1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1] },
      ],
      outcomeLabel: "Symptom free",
      groupLabel: "Clinic",
    },
    options: { outcomeFamily: "binomial", quadraturePoints: 11, confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.regression"] },
  coverage: {
    implementedBoundary: "Generalized linear mixed model with a binomial logit or Poisson log outcome and exactly one Gaussian random intercept, with the marginal likelihood integrated by adaptive Gauss-Hermite quadrature on a reported odd number of nodes, maximised by deterministic Nelder-Mead over (beta, log sigma), standard errors from the numeric observed information, empirical Bayes conditional modes, and a quadrature sensitivity table.",
    oracle: {
      level: "external-library-partial",
      evidence: ["contracts/mixed-models-scipy-crosscheck.py", "contracts/mixed-models-contract.cjs"],
      verifiedOutputs: [
        "adaptive Gauss-Hermite log-likelihood at the reported estimates against an independent scipy.integrate.quad evaluation of the same marginal likelihood",
        "maximum-likelihood coefficients and random-intercept standard deviation against scipy.optimize on the quad-based likelihood",
        "standard errors against a numpy observed-information computation on the quad-based likelihood",
        "Gauss-Hermite nodes and weights against numpy.polynomial.hermite.hermgauss",
      ],
      excludedOutputs: [
        "conditional modes and their curvature intervals",
        "the quadrature stability verdict",
        "AIC and BIC, which inherit the quadrature approximation",
      ],
    },
    diagnostic: {
      level: "method-specific-partial",
      emitted: ["quadrature", "optimizer", "random-intercept magnitude", "subject-specific interpretation", "renderer exact-data contract"],
      limitations: ["no likelihood-ratio test with the correct boundary null distribution", "no overdispersion parameter for the Poisson family", "no residual diagnostics for discrete outcomes"],
    },
    knownGaps: [
      "statsmodels has no frequentist GLMM: BinomialBayesMixedGLM and PoissonBayesMixedGLM are variational Bayes fits whose posterior means are not maximum-likelihood estimates, so the parity oracle is an independent scipy quadrature and optimiser rather than a statsmodels result",
      "only one random intercept on one grouping factor; no random slopes, crossed or nested factors, and no correlated random effects",
      "binomial outcomes must be 0/1 Bernoulli; grouped binomial counts with a denominator are not supported",
      "no boundary likelihood-ratio test for the random-intercept variance",
      "when the random-intercept variance sits on the zero boundary the joint observed information is singular; the fixed effects are then reported conditional on the fitted variance and the variance interval is withheld rather than approximated",
    ],
  },
};

module.exports = {
  methods: [linearMixedModelRandomSlopes, generalizedEstimatingEquations, generalizedLinearMixedModel],
};
