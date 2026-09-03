"use strict";

// Straight-line fit with uncertainties in both coordinates (errors-in-variables).
//
// York, Evans & Evans, "Unified equations for the slope, intercept, and
// standard errors of the best straight line", Am. J. Phys. 72, 367 (2004).
// The iteration, the adjusted points, and the standard errors follow that
// paper exactly (eqs. 13a–13c for the slope and intercept variances). The
// solution is the maximum-likelihood straight line for independent Gaussian
// errors σx_i, σy_i with optional per-point error correlation r_i.
// OLS and WLS (y-only weights) are reported alongside for comparison.

const common = require("./analysis-common.cjs");

const { PhysicsError } = common;

function normalizeInput(input) {
  const value = common.exactObject(input, ["table", "x_column", "y_column", "sigma_x_column", "sigma_y_column", "correlation_column", "correlation", "range", "options"], "physics-york-fit-input");
  const table = common.verifiedScienceTable(value.table);
  const x = common.numericColumn(table, value.x_column, "physics-york-fit-x-column");
  const y = common.numericColumn(table, value.y_column, "physics-york-fit-y-column");
  const sigmaX = common.numericColumn(table, value.sigma_x_column, "physics-york-fit-sigma-x-column");
  const sigmaY = common.numericColumn(table, value.sigma_y_column, "physics-york-fit-sigma-y-column");
  if (value.correlation_column !== undefined && value.correlation !== undefined) throw new PhysicsError("physics-york-fit-correlation-conflict", "give either correlation_column or correlation, not both");
  const correlationColumn = value.correlation_column === undefined ? null : common.numericColumn(table, value.correlation_column, "physics-york-fit-correlation-column");
  const correlation = common.optionalFinite(value.correlation, -1, 1, "physics-york-fit-correlation", 0);
  const range = value.range === undefined ? null : (() => {
    const item = common.exactObject(value.range, ["min", "max"], "physics-york-fit-range");
    const min = common.finite(item.min, -Number.MAX_VALUE, Number.MAX_VALUE, "physics-york-fit-range-min");
    const max = common.finite(item.max, -Number.MAX_VALUE, Number.MAX_VALUE, "physics-york-fit-range-max");
    if (!(max > min)) throw new PhysicsError("physics-york-fit-range-invalid");
    return { min, max };
  })();
  const optionsInput = value.options === undefined ? {} : common.exactObject(value.options, ["max_iterations", "tolerance", "curve_points"], "physics-york-fit-options");
  const options = {
    maxIterations: common.optionalInteger(optionsInput.max_iterations, 1, 1_000, "physics-york-fit-max-iterations", 200),
    tolerance: common.optionalFinite(optionsInput.tolerance, 1e-15, 1e-3, "physics-york-fit-tolerance", 1e-12),
    curvePoints: common.optionalInteger(optionsInput.curve_points, 50, 2_000, "physics-york-fit-curve-points", 200),
  };
  return { table, x, y, sigmaX, sigmaY, correlationColumn, correlation, range, options };
}

// York 2004 iteration. Returns parameters, standard errors, covariance, and
// the adjusted points; throws when the iteration does not converge.
function yorkRegression(x, y, sigmaX, sigmaY, r, options) {
  const n = x.length;
  const wx = sigmaX.map((s) => 1 / (s * s));
  const wy = sigmaY.map((s) => 1 / (s * s));
  const alpha = wx.map((wxi, i) => Math.sqrt(wxi * wy[i]));
  // Initial slope from ordinary least squares.
  const mx = common.mean(x); const my = common.mean(y);
  let sxx = 0; let sxy = 0;
  for (let i = 0; i < n; i += 1) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); }
  if (!(sxx > 0)) throw new PhysicsError("physics-york-fit-x-degenerate", "all x values are identical");
  let b = sxy / sxx;
  let W = null; let U = null; let V = null; let beta = null; let xBar = 0; let yBar = 0;
  let iterations = 0;
  let converged = false;
  const history = [];
  while (iterations < options.maxIterations) {
    iterations += 1;
    W = wx.map((wxi, i) => wxi * wy[i] / (wxi + b * b * wy[i] - 2 * b * r[i] * alpha[i]));
    if (W.some((w) => !(w > 0) || !Number.isFinite(w))) throw new PhysicsError("physics-york-fit-weights-invalid", "York weights became non-positive; check correlations");
    const sumW = W.reduce((s, w) => s + w, 0);
    xBar = W.reduce((s, w, i) => s + w * x[i], 0) / sumW;
    yBar = W.reduce((s, w, i) => s + w * y[i], 0) / sumW;
    U = x.map((xi) => xi - xBar);
    V = y.map((yi) => yi - yBar);
    beta = W.map((w, i) => w * (U[i] / wy[i] + b * V[i] / wx[i] - (b * U[i] + V[i]) * r[i] / alpha[i]));
    const numerator = W.reduce((s, w, i) => s + w * beta[i] * V[i], 0);
    const denominator = W.reduce((s, w, i) => s + w * beta[i] * U[i], 0);
    if (!(Math.abs(denominator) > 0)) throw new PhysicsError("physics-york-fit-degenerate", "York denominator vanished");
    const bNew = numerator / denominator;
    history.push({ iteration: iterations, slope: bNew, change: bNew - b });
    const done = Math.abs(bNew - b) <= options.tolerance * Math.max(Math.abs(bNew), 1e-300);
    b = bNew;
    if (done) { converged = true; break; }
  }
  // Final quantities at the converged slope.
  W = wx.map((wxi, i) => wxi * wy[i] / (wxi + b * b * wy[i] - 2 * b * r[i] * alpha[i]));
  const sumW = W.reduce((s, w) => s + w, 0);
  xBar = W.reduce((s, w, i) => s + w * x[i], 0) / sumW;
  yBar = W.reduce((s, w, i) => s + w * y[i], 0) / sumW;
  U = x.map((xi) => xi - xBar);
  V = y.map((yi) => yi - yBar);
  beta = W.map((w, i) => w * (U[i] / wy[i] + b * V[i] / wx[i] - (b * U[i] + V[i]) * r[i] / alpha[i]));
  const a = yBar - b * xBar;
  const xAdj = beta.map((bi) => xBar + bi);
  const xAdjBar = W.reduce((s, w, i) => s + w * xAdj[i], 0) / sumW;
  const u = xAdj.map((xi) => xi - xAdjBar);
  const sumWu2 = W.reduce((s, w, i) => s + w * u[i] * u[i], 0);
  if (!(sumWu2 > 0)) throw new PhysicsError("physics-york-fit-degenerate", "adjusted points collapsed to a single abscissa");
  const varB = 1 / sumWu2;
  const varA = 1 / sumW + xAdjBar * xAdjBar * varB;
  const covAB = -xAdjBar * varB;
  const chiSquare = W.reduce((s, w, i) => s + w * (y[i] - b * x[i] - a) ** 2, 0);
  return { a, b, sigmaA: Math.sqrt(varA), sigmaB: Math.sqrt(varB), covAB, covariance: [[varA, covAB], [covAB, varB]], W, xAdj, xAdjBar, chiSquare, iterations, converged, history: history.slice(-50) };
}

function ordinaryLeastSquares(x, y) {
  const n = x.length;
  const mx = common.mean(x); const my = common.mean(y);
  let sxx = 0; let sxy = 0;
  for (let i = 0; i < n; i += 1) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); }
  const b = sxy / sxx;
  const a = my - b * mx;
  const residuals = y.map((yi, i) => yi - a - b * x[i]);
  const s2 = residuals.reduce((s, e) => s + e * e, 0) / (n - 2);
  const varB = s2 / sxx;
  const varA = s2 * (1 / n + mx * mx / sxx);
  const covAB = -mx * varB;
  return { a, b, sigmaA: Math.sqrt(varA), sigmaB: Math.sqrt(varB), covAB, residualVariance: s2 };
}

// A perfectly collinear comparison fit has zero residual variance.  In that
// case the OLS covariance matrix is the zero matrix and its correlation is
// mathematically undefined (0 / 0), not a non-finite result.  Keep the
// publication table JSON-safe by representing the undefined diagnostic as
// null; the York fit itself still carries the declared measurement-error
// covariance and remains the inferential result.
function safeCorrelation(covariance, sigmaA, sigmaB) {
  const denominator = sigmaA * sigmaB;
  if (!(denominator > 0) || !Number.isFinite(denominator)) return null;
  const value = covariance / denominator;
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : null;
}

function analyzeYorkFit(input) {
  const normalized = normalizeInput(input);
  const rowsAll = normalized.x.values.map((xi, index) => ({
    ordinal: index + 1, x: xi, y: normalized.y.values[index], sigmaX: normalized.sigmaX.values[index], sigmaY: normalized.sigmaY.values[index],
    r: normalized.correlationColumn ? normalized.correlationColumn.values[index] : normalized.correlation,
  }));
  const rows = rowsAll.filter((row) => normalized.range === null || (row.x >= normalized.range.min && row.x <= normalized.range.max));
  if (rows.length < 3) throw new PhysicsError("physics-york-fit-too-few-points", "at least three points are required inside the fit range");
  rows.forEach((row) => {
    if (!(row.sigmaX > 0)) throw new PhysicsError("physics-york-fit-sigma-x-nonpositive", `point ${row.ordinal} has a non-positive x uncertainty`);
    if (!(row.sigmaY > 0)) throw new PhysicsError("physics-york-fit-sigma-y-nonpositive", `point ${row.ordinal} has a non-positive y uncertainty`);
    if (!(row.r >= -1 && row.r <= 1)) throw new PhysicsError("physics-york-fit-correlation-invalid", `point ${row.ordinal} has a correlation outside [-1, 1]`);
  });
  const x = rows.map((row) => row.x); const y = rows.map((row) => row.y);
  const sigmaX = rows.map((row) => row.sigmaX); const sigmaY = rows.map((row) => row.sigmaY); const r = rows.map((row) => row.r);
  const warnings = [];
  const york = yorkRegression(x, y, sigmaX, sigmaY, r, normalized.options);
  if (!york.converged) warnings.push(`York iteration stopped after ${york.iterations} iterations without meeting the tolerance; treat the slope and its error as provisional.`);
  const ndf = rows.length - 2;
  // WLS with y-only weights.
  const wls = common.weightedLinearLeastSquares(x.map((xi) => [1, xi]), y, sigmaY, "physics-york-fit-wls");
  // OLS; chi-square evaluated with sigma_y so that all three rows share a footing.
  const ols = ordinaryLeastSquares(x, y);
  const olsChiSquare = y.reduce((s, yi, i) => s + ((yi - ols.a - ols.b * x[i]) / sigmaY[i]) ** 2, 0);
  const methodRows = [
    { method: "york", label: "York 2004 (errors in x and y)", a: york.a, sigmaA: york.sigmaA, b: york.b, sigmaB: york.sigmaB, correlation: safeCorrelation(york.covAB, york.sigmaA, york.sigmaB), chiSquare: york.chiSquare },
    { method: "wls", label: "Weighted least squares (σy only)", a: wls.parameters[0], sigmaA: Math.sqrt(wls.covariance[0][0]), b: wls.parameters[1], sigmaB: Math.sqrt(wls.covariance[1][1]), correlation: safeCorrelation(wls.covariance[0][1], Math.sqrt(wls.covariance[0][0]), Math.sqrt(wls.covariance[1][1])), chiSquare: wls.chiSquare },
    { method: "ols", label: "Ordinary least squares (unweighted; errors from scatter)", a: ols.a, sigmaA: ols.sigmaA, b: ols.b, sigmaB: ols.sigmaB, correlation: safeCorrelation(ols.covAB, ols.sigmaA, ols.sigmaB), chiSquare: olsChiSquare },
  ].map((row) => ({ ...row, ndf, reducedChiSquare: row.chiSquare / ndf, pValue: common.chiSquareSurvival(row.chiSquare, ndf) }));
  if (york.chiSquare / ndf > 3) warnings.push(`York χ²/ndf = ${(york.chiSquare / ndf).toPrecision(3)}: the declared uncertainties do not account for the scatter, or the relation is not a straight line.`);
  const pointRows = rows.map((row, i) => {
    const residual = row.y - york.a - york.b * row.x;
    const effectiveSigma = Math.sqrt(row.sigmaY ** 2 + york.b ** 2 * row.sigmaX ** 2 - 2 * york.b * row.r * row.sigmaX * row.sigmaY);
    return { ordinal: row.ordinal, x: row.x, y: row.y, sigmaX: row.sigmaX, sigmaY: row.sigmaY, correlation: row.r, weight: york.W[i], xAdjusted: york.xAdj[i], yAdjusted: york.a + york.b * york.xAdj[i], residual, weightedResidual: Math.sqrt(york.W[i]) * residual, effectiveSigma, pull: residual / effectiveSigma };
  });
  const xLo = Math.min(...x.map((xi, i) => xi - sigmaX[i])); const xHi = Math.max(...x.map((xi, i) => xi + sigmaX[i]));
  const grid = common.linspace(xLo, xHi, normalized.options.curvePoints);
  const curveRows = grid.map((xi) => {
    const yi = york.a + york.b * xi;
    const variance = york.sigmaA ** 2 + xi * xi * york.sigmaB ** 2 + 2 * xi * york.covAB;
    const band = Math.sqrt(Math.max(0, variance));
    return { x: xi, y: yi, low: yi - band, high: yi + band, ols: ols.a + ols.b * xi };
  });
  const xUnit = normalized.x.column.unit; const yUnit = normalized.y.column.unit;
  const xLabel = `${normalized.x.column.name}${xUnit ? ` (${xUnit})` : ""}`;
  const yLabel = `${normalized.y.column.name}${yUnit ? ` (${yUnit})` : ""}`;
  const slopeUnit = xUnit && yUnit ? `${yUnit}/${xUnit}` : (yUnit ?? null);
  const publicationTable = common.scienceTable(`Straight-line fits · ${normalized.table.title}`, [
    { id: "method", label: "Method", type: "string" }, { id: "intercept", label: "Intercept", unit: yUnit }, { id: "interceptError", label: "Intercept error", unit: yUnit },
    { id: "slope", label: "Slope", unit: slopeUnit }, { id: "slopeError", label: "Slope error", unit: slopeUnit }, { id: "correlation", label: "Correlation(a, b)" },
    { id: "chiSquare", label: "χ²" }, { id: "ndf", label: "ndf" }, { id: "reducedChiSquare", label: "χ²/ndf" }, { id: "pValue", label: "p-value" },
  ], methodRows.map((row) => [row.label, row.a, row.sigmaA, row.b, row.sigmaB, row.correlation, row.chiSquare, row.ndf, row.reducedChiSquare, row.pValue]));
  const pointsTable = common.scienceTable("Points, York adjusted points, residuals, pulls", [
    { id: "ordinal", label: "Point" }, { id: "x", label: normalized.x.column.name, unit: xUnit }, { id: "y", label: normalized.y.column.name, unit: yUnit },
    { id: "sigmaX", label: "σx", unit: xUnit }, { id: "sigmaY", label: "σy", unit: yUnit }, { id: "correlation", label: "r" }, { id: "weight", label: "York weight W" },
    { id: "xAdjusted", label: "Adjusted x", unit: xUnit }, { id: "yAdjusted", label: "Adjusted y", unit: yUnit }, { id: "residual", label: "Residual", unit: yUnit },
    { id: "weightedResidual", label: "√W · residual" }, { id: "effectiveSigma", label: "Effective σ", unit: yUnit }, { id: "pull", label: "Pull" },
  ], pointRows.map((row) => [row.ordinal, row.x, row.y, row.sigmaX, row.sigmaY, row.correlation, row.weight, row.xAdjusted, row.yAdjusted, row.residual, row.weightedResidual, row.effectiveSigma, row.pull]));
  const curveTable = common.scienceTable("York line with ±1σ band", [
    { id: "x", label: normalized.x.column.name, unit: xUnit }, { id: "y", label: "York line", unit: yUnit }, { id: "low", label: "−1σ", unit: yUnit }, { id: "high", label: "+1σ", unit: yUnit }, { id: "ols", label: "OLS line", unit: yUnit },
  ], curveRows.map((row) => [row.x, row.y, row.low, row.high, row.ols]));
  const width = 680;
  const pointValues = pointRows.map((row) => ({ x: row.x, y: row.y, xLow: row.x - row.sigmaX, xHigh: row.x + row.sigmaX, yLow: row.y - row.sigmaY, yHigh: row.y + row.sigmaY, pull: row.pull }));
  const spec = common.stackedVegaFigure({
    description: `York (2004) errors-in-variables fit of ${normalized.y.column.name} versus ${normalized.x.column.name}: data with x and y error bars, York line with ±1σ band, dashed OLS line, and pulls (χ²/ndf = ${(york.chiSquare / ndf).toPrecision(4)}).`,
    width,
    data: [
      { name: "points", values: pointValues },
      { name: "curve", values: curveRows },
      { name: "pullBand", values: [{ level: 1 }, { level: -1 }, { level: 2 }, { level: -2 }] },
    ],
    panels: [
      {
        name: "fitPanel", height: 320,
        scales: [
          { name: "x", type: "linear", domain: { fields: [{ data: "points", field: "xLow" }, { data: "points", field: "xHigh" }] }, range: "width", nice: true, zero: false },
          { name: "y", type: "linear", domain: { fields: [{ data: "points", field: "yLow" }, { data: "points", field: "yHigh" }, { data: "curve", field: "low" }, { data: "curve", field: "high" }] }, range: "height", nice: true, zero: false },
        ],
        axes: [common.axis("bottom", "x", xLabel), common.axis("left", "y", yLabel)],
        marks: [
          { type: "area", from: { data: "curve" }, encode: { enter: { x: { scale: "x", field: "x" }, y: { scale: "y", field: "low" }, y2: { scale: "y", field: "high" }, fill: { value: common.PALETTE.band }, opacity: { value: 0.6 } } } },
          { type: "rule", from: { data: "points" }, encode: { enter: { x: { scale: "x", field: "xLow" }, x2: { scale: "x", field: "xHigh" }, y: { scale: "y", field: "y" }, stroke: { value: common.PALETTE.neutral }, strokeWidth: { value: 1.2 } } } },
          common.errorBarMark("points", "x", "yLow", "yHigh", common.PALETTE.neutral),
          common.lineMark("curve", "x", "ols", common.PALETTE.component[0], { strokeWidth: 1.2, dash: [5, 3] }),
          common.lineMark("curve", "x", "y", common.PALETTE.fit, { strokeWidth: 2 }),
          common.symbolMark("points", "x", "y", common.PALETTE.data, { tooltip: "pull" }),
        ],
      },
      {
        name: "pullPanel", height: 120,
        scales: [
          { name: "x", type: "linear", domain: { fields: [{ data: "points", field: "xLow" }, { data: "points", field: "xHigh" }] }, range: "width", nice: true, zero: false },
          { name: "y", type: "linear", domain: { fields: [{ data: "points", field: "pull" }, { data: "pullBand", field: "level" }] }, range: "height", nice: true, zero: true },
        ],
        axes: [common.axis("bottom", "x", xLabel), common.axis("left", "y", "Pull (y − line)/σ_eff")],
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
    analysisId: "york-fit",
    method: {
      id: "york-2004-errors-in-variables-line", version: "1.0.0",
      references: [
        "D. York, N. M. Evans, D. J. Evans, Unified equations for the slope, intercept, and standard errors of the best straight line, Am. J. Phys. 72, 367 (2004)",
        "D. York, Least-squares fitting of a straight line, Can. J. Phys. 44, 1079 (1966)",
      ],
    },
    input: {
      title: normalized.table.title, xColumn: normalized.x.column.name, xUnit, yColumn: normalized.y.column.name, yUnit,
      sigmaXColumn: normalized.sigmaX.column.name, sigmaYColumn: normalized.sigmaY.column.name,
      correlationColumn: normalized.correlationColumn ? normalized.correlationColumn.column.name : null, correlation: normalized.correlationColumn ? null : normalized.correlation,
      range: normalized.range, pointCount: rows.length, excludedPointCount: rowsAll.length - rows.length, options: normalized.options,
    },
    summary: {
      slope: york.b, slopeError: york.sigmaB, slopeUnit, intercept: york.a, interceptError: york.sigmaA, interceptUnit: yUnit,
      covarianceInterceptSlope: york.covAB, correlationInterceptSlope: york.covAB / (york.sigmaA * york.sigmaB),
      chiSquare: york.chiSquare, degreesOfFreedom: ndf, reducedChiSquare: york.chiSquare / ndf, pValue: common.chiSquareSurvival(york.chiSquare, ndf),
      iterations: york.iterations, converged: york.converged, weightedMeanAdjustedX: york.xAdjBar,
      comparison: methodRows.map((row) => ({ method: row.method, slope: row.b, slopeError: row.sigmaB, intercept: row.a, interceptError: row.sigmaA, chiSquare: row.chiSquare, reducedChiSquare: row.reducedChiSquare, pValue: row.pValue })),
    },
    parameters: [
      { id: "intercept", value: york.a, error: york.sigmaA, unit: yUnit },
      { id: "slope", value: york.b, error: york.sigmaB, unit: slopeUnit },
    ],
    covariance: york.covariance,
    parameterOrder: ["intercept", "slope"],
    points: pointRows,
    convergenceHistory: york.history,
    publicationTable,
    tables: { points: pointsTable, york_curve: curveTable },
    figure: common.figureReceipt(spec),
    boundaries: [
      "Straight-line model y = a + b·x only; no curvature, no outlier rejection.",
      "Errors are assumed Gaussian and independent between points; per-point x–y error correlation r_i is honoured, but inter-point correlations are not.",
      "The York solution is the exact maximum-likelihood line for that error model; its standard errors (eq. 13) treat the declared σ as known, so the p-values are asymptotic and do not inflate errors by χ²/ndf.",
      "OLS errors come from residual scatter (σ unknown); its χ² row uses σy only so the three methods can be compared on one footing.",
    ],
    warnings,
  };
  return common.finalizeAnalysis(result);
}

module.exports = { analyzeYorkFit, yorkRegression, ordinaryLeastSquares };
