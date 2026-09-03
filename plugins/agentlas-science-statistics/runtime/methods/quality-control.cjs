"use strict";

/**
 * Statistical process control family: Shewhart control charts with Western Electric
 * run rules, process capability indices, crossed Gage R&R (ANOVA method), and
 * CUSUM / EWMA monitoring. Pure JavaScript, deterministic, no engine require.
 *
 * Control-chart constants: d2 and d3 are the standard tabulated values for n = 2..25;
 * c4 is the closed form sqrt(2/(n-1)) * Gamma(n/2) / Gamma((n-1)/2); A2, A3, B3, B4,
 * D3, D4 are derived from those exactly (three-sigma limits).
 */

const D2_TABLE = Object.freeze([1.128, 1.693, 2.059, 2.326, 2.534, 2.704, 2.847, 2.970, 3.078, 3.173, 3.258, 3.336, 3.407, 3.472, 3.532, 3.588, 3.640, 3.689, 3.735, 3.778, 3.819, 3.858, 3.895, 3.931]);
const D3_TABLE = Object.freeze([0.853, 0.888, 0.880, 0.864, 0.848, 0.833, 0.820, 0.808, 0.797, 0.787, 0.778, 0.770, 0.763, 0.756, 0.750, 0.744, 0.739, 0.734, 0.729, 0.724, 0.720, 0.716, 0.712, 0.708]);
const MIN_SUBGROUPS = 5;
const MIN_INDIVIDUALS = 8;
const MAX_POINTS = 10_000;

function c4Constant(n, H) {
  return Math.sqrt(2 / (n - 1)) * Math.exp(H.logGamma(n / 2) - H.logGamma((n - 1) / 2));
}

function chartConstants(n, H) {
  if (!Number.isInteger(n) || n < 2 || n > 25) H.fail("STAT_INVALID_INPUT", "control-chart constants are tabulated for subgroup sizes 2 through 25");
  const d2 = D2_TABLE[n - 2];
  const d3 = D3_TABLE[n - 2];
  const c4 = c4Constant(n, H);
  const c5 = Math.sqrt(1 - c4 * c4);
  return {
    n,
    d2,
    d3,
    c4,
    A2: 3 / (d2 * Math.sqrt(n)),
    A3: 3 / (c4 * Math.sqrt(n)),
    B3: Math.max(0, 1 - 3 * c5 / c4),
    B4: 1 + 3 * c5 / c4,
    D3: Math.max(0, 1 - 3 * d3 / d2),
    D4: 1 + 3 * d3 / d2,
  };
}

function constantsRows(H, usedN) {
  const rows = [];
  for (let n = 2; n <= 25; n += 1) {
    const c = chartConstants(n, H);
    rows.push({ n, d2: c.d2, d3: c.d3, c4: c.c4, A2: c.A2, A3: c.A3, B3: c.B3, B4: c.B4, D3: c.D3, D4: c.D4, used: n === usedN });
  }
  return rows;
}

const CONSTANT_COLUMNS = [
  { key: "n", label: "n", type: "number" },
  { key: "d2", label: "d2", type: "number" },
  { key: "d3", label: "d3", type: "number" },
  { key: "c4", label: "c4", type: "number" },
  { key: "A2", label: "A2", type: "number" },
  { key: "A3", label: "A3", type: "number" },
  { key: "B3", label: "B3", type: "number" },
  { key: "B4", label: "B4", type: "number" },
  { key: "D3", label: "D3", type: "number" },
  { key: "D4", label: "D4", type: "number" },
  { key: "used", label: "Used", type: "boolean" },
];

// Accurate normal tails through the regularized incomplete gamma (the engine's erf
// approximation is only ~1.5e-7 accurate, too coarse for PPM and interval comparisons).
function normalUpperTail(z, H) {
  if (!Number.isFinite(z)) return z > 0 ? 0 : 1;
  const half = 0.5 * H.gammaQ(0.5, z * z / 2);
  return z >= 0 ? half : 1 - half;
}

function normalLowerTail(z, H) {
  return normalUpperTail(-z, H);
}

function normalDensity(z) {
  return Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
}

function normalQuantile(p, H) {
  let z = H.normalInv(p);
  for (let step = 0; step < 3; step += 1) {
    const error = normalLowerTail(z, H) - p;
    const density = normalDensity(z);
    if (!(density > 0)) break;
    z -= error / density;
  }
  return z;
}

function chiSquareQuantile(p, df, H) {
  if (!(p > 0 && p < 1) || !(df > 0)) H.fail("STAT_INTERNAL", "chi-square quantile arguments out of range");
  let low = 0;
  let high = Math.max(1, df);
  while (H.pFromChiSquare(high, df) > 1 - p) high *= 2;
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const mid = (low + high) / 2;
    if (H.pFromChiSquare(mid, df) > 1 - p) low = mid;
    else high = mid;
    if (high - low <= 1e-15 * high) break;
  }
  return (low + high) / 2;
}

function parseBoundedNumber(value, H, path, minimum, maximum, { exclusiveMin = false } = {}) {
  const number = H.finiteNumber(value, path);
  if (number > maximum || (exclusiveMin ? number <= minimum : number < minimum)) {
    H.fail("STAT_INVALID_INPUT", `${path} must be ${exclusiveMin ? "greater than" : "at least"} ${minimum} and at most ${maximum}`);
  }
  return number;
}

function nonNegativeIntegerVector(value, path, minLength, H) {
  const values = H.numericVector(value, path, minLength);
  return values.map((item, index) => {
    if (!Number.isInteger(item) || item < 0) H.fail("STAT_INVALID_INPUT", `${path}[${index}] must be a non-negative integer`);
    return item;
  });
}

function positiveIntegerVector(value, path, minLength, H) {
  const values = nonNegativeIntegerVector(value, path, minLength, H);
  values.forEach((item, index) => { if (item < 1) H.fail("STAT_INVALID_INPUT", `${path}[${index}] must be a positive integer`); });
  return values;
}

function chunk(values, size, H, path) {
  if (values.length % size !== 0) H.fail("STAT_INVALID_INPUT", `${path} length must be a multiple of the subgroup size ${size}`);
  const out = [];
  for (let start = 0; start < values.length; start += size) out.push(values.slice(start, start + size));
  return out;
}

function movingRanges(values, budget) {
  const out = [];
  for (let index = 1; index < values.length; index += 1) {
    if (budget) budget.check();
    out.push(Math.abs(values[index] - values[index - 1]));
  }
  return out;
}

function range(values) {
  const { min, max } = { min: Math.min(...values), max: Math.max(...values) };
  return max - min;
}

// ---------------------------------------------------------------------------------
// Western Electric run rules 1-4 on a sequence of chart points with per-point sigma.
// Rule 1: beyond 3 sigma (outside control limits).
// Rule 2: two of three consecutive points beyond 2 sigma on the same side (flagged at the completing point).
// Rule 3: four of five consecutive points beyond 1 sigma on the same side (flagged at the completing point).
// Rule 4: eight consecutive points on the same side of the center line (flagged at every point continuing the run).
// ---------------------------------------------------------------------------------
function westernElectric(points, chartName, rules, budget) {
  const violations = [];
  const z = points.map((point) => (point.sigma > 0 ? (point.statistic - point.center) / point.sigma : 0));
  const flagged = points.map(() => new Set());
  const push = (index, rule, side) => {
    flagged[index].add(rule);
    violations.push({ index: index + 1, chart: chartName, rule, side, value: points[index].statistic, center: points[index].center, sigma: points[index].sigma });
  };
  for (let index = 0; index < points.length; index += 1) {
    budget.check();
    const point = points[index];
    if (rules.includes(1)) {
      if (point.statistic > point.ucl) push(index, 1, "above");
      else if (point.statistic < point.lcl) push(index, 1, "below");
    }
    if (rules.includes(2) && index >= 2) {
      for (const side of ["above", "below"]) {
        const beyond = (i) => (side === "above" ? z[i] > 2 : z[i] < -2);
        const count = [index - 2, index - 1, index].filter(beyond).length;
        if (count >= 2 && beyond(index)) push(index, 2, side);
      }
    }
    if (rules.includes(3) && index >= 4) {
      for (const side of ["above", "below"]) {
        const beyond = (i) => (side === "above" ? z[i] > 1 : z[i] < -1);
        const count = [index - 4, index - 3, index - 2, index - 1, index].filter(beyond).length;
        if (count >= 4 && beyond(index)) push(index, 3, side);
      }
    }
    if (rules.includes(4) && index >= 7) {
      for (const side of ["above", "below"]) {
        const same = (i) => (side === "above" ? z[i] > 0 : z[i] < 0);
        let run = true;
        for (let back = 0; back < 8; back += 1) if (!same(index - back)) { run = false; break; }
        if (run) push(index, 4, side);
      }
    }
  }
  return { violations, flagged: flagged.map((set) => [...set].sort((a, b) => a - b)) };
}

const POINT_COLUMNS = (statisticLabel) => [
  { key: "index", label: "Sample", type: "number" },
  { key: "statistic", label: statisticLabel, type: "number" },
  { key: "center", label: "Center line", type: "number" },
  { key: "lcl", label: "LCL", type: "number" },
  { key: "ucl", label: "UCL", type: "number" },
  { key: "sigma", label: "Sigma", type: "number" },
  { key: "sampleSize", label: "n", type: "number" },
  { key: "violation", label: "Violation", type: "boolean" },
  { key: "rules", label: "Rules", type: "string" },
];

const VIOLATION_COLUMNS = [
  { key: "index", label: "Sample", type: "number" },
  { key: "chart", label: "Chart", type: "string" },
  { key: "rule", label: "Western Electric rule", type: "number" },
  { key: "side", label: "Side", type: "string" },
  { key: "value", label: "Value", type: "number" },
  { key: "center", label: "Center line", type: "number" },
  { key: "sigma", label: "Sigma", type: "number" },
];

function chartFigure(H, role, title, rows, yLabel) {
  return H.vegaArtifact(role, title, {
    data: { values: rows },
    layer: [
      { mark: { type: "line", color: "#B24A3B", strokeDash: [6, 4] }, encoding: { x: { field: "index", type: "quantitative", title: "Sample" }, y: { field: "ucl", type: "quantitative", title: yLabel } } },
      { mark: { type: "line", color: "#B24A3B", strokeDash: [6, 4] }, encoding: { x: { field: "index", type: "quantitative" }, y: { field: "lcl", type: "quantitative" } } },
      { mark: { type: "line", color: "#4A6B3A", strokeDash: [2, 2] }, encoding: { x: { field: "index", type: "quantitative" }, y: { field: "center", type: "quantitative" } } },
      { mark: { type: "line", color: "#1F4E79" }, encoding: { x: { field: "index", type: "quantitative" }, y: { field: "statistic", type: "quantitative" } } },
      {
        mark: { type: "point", filled: true, size: 70 },
        encoding: {
          x: { field: "index", type: "quantitative" },
          y: { field: "statistic", type: "quantitative" },
          color: { condition: { test: "datum.violation === true", value: "#B24A3B" }, value: "#1F4E79" },
          shape: { condition: { test: "datum.violation === true", value: "diamond" }, value: "circle" },
          tooltip: [{ field: "index" }, { field: "statistic", format: ".5g" }, { field: "lcl", format: ".5g" }, { field: "ucl", format: ".5g" }, { field: "rules" }],
        },
      },
    ],
  });
}

function finishPoints(points, flagged) {
  return points.map((point, index) => ({ ...point, violation: flagged[index].length > 0, rules: flagged[index].length ? flagged[index].join(",") : null }));
}

const controlChart = {
  method: "control_chart",
  family: "quality-control",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian", "binomial", "poisson"], links: [null, "identity"] },
  optionKeys: ["timeoutMs"],
  customOptions: {
    chartType: {
      schema: { type: "string", enum: ["xbar_r", "xbar_s", "i_mr", "p", "np", "c", "u"] },
      default: "xbar_r",
      parse(value, H, path) {
        if (!["xbar_r", "xbar_s", "i_mr", "p", "np", "c", "u"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be xbar_r, xbar_s, i_mr, p, np, c, or u`);
        return value;
      },
    },
    subgroupSize: {
      schema: { type: "integer", minimum: 2, maximum: 25 },
      default: 5,
      parse(value, H, path) { return H.integer(value, 2, 25, path); },
    },
    rules: {
      schema: { type: "array", minItems: 1, maxItems: 4, items: { type: "integer", minimum: 1, maximum: 4 } },
      default: [1, 2, 3, 4],
      parse(value, H, path) {
        if (!Array.isArray(value) || !value.length || value.length > 4) H.fail("STAT_INVALID_INPUT", `${path} must list one to four Western Electric rule numbers`);
        const rules = value.map((item, index) => H.integer(item, 1, 4, `${path}[${index}]`));
        if (new Set(rules).size !== rules.length) H.fail("STAT_INVALID_INPUT", `${path} must not repeat rules`);
        return rules.sort((a, b) => a - b);
      },
    },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      subgroups: { type: "array", minItems: 5, maxItems: 10000, items: { type: "array", minItems: 2, maxItems: 25, items: { type: "number" } } },
      values: { type: "array", minItems: 8, maxItems: 100000, items: { type: "number" } },
      defectives: { type: "array", minItems: 5, maxItems: 10000, items: { type: "integer", minimum: 0 } },
      sampleSizes: { type: "array", minItems: 5, maxItems: 10000, items: { type: "integer", minimum: 1 } },
      defects: { type: "array", minItems: 5, maxItems: 10000, items: { type: "integer", minimum: 0 } },
      unitsInspected: { type: "array", minItems: 5, maxItems: 10000, items: { type: "number", exclusiveMinimum: 0 } },
      label: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["subgroups", "values", "defectives", "sampleSizes", "defects", "unitsInspected", "label"], "data");
    const label = H.label(data.label, "Measurement", "data.label");
    const type = options.chartType;
    const forbid = (keys) => {
      for (const key of keys) if (data[key] !== undefined) H.fail("STAT_INVALID_INPUT", `data.${key} is not used by the ${type} chart`);
    };
    if (type === "xbar_r" || type === "xbar_s") {
      forbid(["defectives", "sampleSizes", "defects", "unitsInspected"]);
      let subgroups;
      if (data.subgroups !== undefined) {
        if (data.values !== undefined) H.fail("STAT_INVALID_INPUT", "provide either data.subgroups or data.values, not both");
        if (!Array.isArray(data.subgroups)) H.fail("STAT_INVALID_INPUT", "data.subgroups must be an array of arrays");
        subgroups = data.subgroups.map((group, index) => H.numericVector(group, `data.subgroups[${index}]`, 2));
      } else if (data.values !== undefined) {
        subgroups = chunk(H.numericVector(data.values, "data.values", 2), options.subgroupSize, H, "data.values");
      } else H.fail("STAT_INVALID_INPUT", `${type} chart requires data.subgroups or data.values`);
      if (subgroups.length < MIN_SUBGROUPS) H.fail("STAT_INSUFFICIENT_SAMPLE", `${type} chart requires at least ${MIN_SUBGROUPS} subgroups`);
      if (subgroups.length > MAX_POINTS) H.fail("STAT_LIMIT_EXCEEDED", `subgroups exceed ${MAX_POINTS}`);
      const n = subgroups[0].length;
      if (n < 2 || n > 25) H.fail("STAT_INVALID_INPUT", "subgroup size must be between 2 and 25");
      if (subgroups.some((group) => group.length !== n)) H.fail("STAT_INVALID_INPUT", `${type} chart requires equal subgroup sizes`);
      return { type, label, subgroups, n };
    }
    if (type === "i_mr" || type === "c") {
      forbid(["subgroups", "defectives", "sampleSizes", "defects", "unitsInspected"]);
      if (data.values === undefined) H.fail("STAT_INVALID_INPUT", `${type} chart requires data.values`);
      const values = type === "c" ? nonNegativeIntegerVector(data.values, "data.values", 2, H) : H.numericVector(data.values, "data.values", 2);
      if (values.length < MIN_INDIVIDUALS) H.fail("STAT_INSUFFICIENT_SAMPLE", `${type} chart requires at least ${MIN_INDIVIDUALS} observations`);
      if (values.length > MAX_POINTS) H.fail("STAT_LIMIT_EXCEEDED", `observations exceed ${MAX_POINTS}`);
      return { type, label, values };
    }
    if (type === "p" || type === "np") {
      forbid(["subgroups", "values", "defects", "unitsInspected"]);
      if (data.defectives === undefined || data.sampleSizes === undefined) H.fail("STAT_INVALID_INPUT", `${type} chart requires data.defectives and data.sampleSizes`);
      const defectives = nonNegativeIntegerVector(data.defectives, "data.defectives", 2, H);
      const sampleSizes = positiveIntegerVector(data.sampleSizes, "data.sampleSizes", 2, H);
      if (defectives.length !== sampleSizes.length) H.fail("STAT_INVALID_INPUT", "data.defectives and data.sampleSizes must have the same length");
      if (defectives.length < MIN_SUBGROUPS) H.fail("STAT_INSUFFICIENT_SAMPLE", `${type} chart requires at least ${MIN_SUBGROUPS} samples`);
      if (defectives.length > MAX_POINTS) H.fail("STAT_LIMIT_EXCEEDED", `samples exceed ${MAX_POINTS}`);
      defectives.forEach((count, index) => { if (count > sampleSizes[index]) H.fail("STAT_INVALID_INPUT", `data.defectives[${index}] exceeds its sample size`); });
      if (type === "np" && sampleSizes.some((size) => size !== sampleSizes[0])) H.fail("STAT_INVALID_INPUT", "np chart requires equal sample sizes; use the p chart for varying sizes");
      return { type, label, defectives, sampleSizes };
    }
    forbid(["subgroups", "values", "defectives", "sampleSizes"]);
    if (data.defects === undefined || data.unitsInspected === undefined) H.fail("STAT_INVALID_INPUT", "u chart requires data.defects and data.unitsInspected");
    const defects = nonNegativeIntegerVector(data.defects, "data.defects", 2, H);
    const units = H.numericVector(data.unitsInspected, "data.unitsInspected", 2);
    units.forEach((value, index) => { if (!(value > 0)) H.fail("STAT_INVALID_INPUT", `data.unitsInspected[${index}] must be positive`); });
    if (defects.length !== units.length) H.fail("STAT_INVALID_INPUT", "data.defects and data.unitsInspected must have the same length");
    if (defects.length < MIN_SUBGROUPS) H.fail("STAT_INSUFFICIENT_SAMPLE", `u chart requires at least ${MIN_SUBGROUPS} samples`);
    if (defects.length > MAX_POINTS) H.fail("STAT_LIMIT_EXCEEDED", `samples exceed ${MAX_POINTS}`);
    return { type, label, defects, unitsInspected: units };
  },
  analyze(parsed, options, budget, H) {
    const { type, label } = parsed;
    const rules = options.rules;
    let primary = [];
    let secondary = null;
    let secondaryLabel = null;
    let constants = null;
    const estimates = [];
    let sampleInfo;
    let primaryLabel;
    const point = (index, statistic, center, sigma, lcl, ucl, sampleSize) => ({ index, statistic, center, lcl, ucl, sigma, sampleSize });

    if (type === "xbar_r" || type === "xbar_s") {
      const { subgroups, n } = parsed;
      constants = chartConstants(n, H);
      const means = subgroups.map((group) => H.mean(group, budget));
      const grandMean = H.mean(means, budget);
      if (type === "xbar_r") {
        const ranges = subgroups.map((group) => range(group));
        const rBar = H.mean(ranges, budget);
        if (!(rBar > 0)) H.fail("STAT_DEGENERATE", "average subgroup range is zero; limits are undefined");
        const sigmaWithin = rBar / constants.d2;
        const sigmaXbar = constants.A2 * rBar / 3;
        primary = means.map((value, index) => point(index + 1, value, grandMean, sigmaXbar, grandMean - constants.A2 * rBar, grandMean + constants.A2 * rBar, n));
        const rSigma = constants.d3 * sigmaWithin;
        secondary = ranges.map((value, index) => point(index + 1, value, rBar, rSigma, constants.D3 * rBar, constants.D4 * rBar, n));
        secondaryLabel = "Subgroup range";
        estimates.push({ name: "grand mean", estimate: grandMean }, { name: "average range", estimate: rBar }, { name: "within sigma (R-bar/d2)", estimate: sigmaWithin });
      } else {
        const sds = subgroups.map((group) => Math.sqrt(H.variance(group, true, budget)));
        const sBar = H.mean(sds, budget);
        if (!(sBar > 0)) H.fail("STAT_DEGENERATE", "average subgroup standard deviation is zero; limits are undefined");
        const sigmaWithin = sBar / constants.c4;
        const sigmaXbar = constants.A3 * sBar / 3;
        primary = means.map((value, index) => point(index + 1, value, grandMean, sigmaXbar, grandMean - constants.A3 * sBar, grandMean + constants.A3 * sBar, n));
        const sSigma = Math.sqrt(1 - constants.c4 * constants.c4) * sigmaWithin;
        secondary = sds.map((value, index) => point(index + 1, value, sBar, sSigma, constants.B3 * sBar, constants.B4 * sBar, n));
        secondaryLabel = "Subgroup standard deviation";
        estimates.push({ name: "grand mean", estimate: grandMean }, { name: "average standard deviation", estimate: sBar }, { name: "within sigma (S-bar/c4)", estimate: sigmaWithin });
      }
      primaryLabel = "Subgroup mean";
      sampleInfo = { subgroups: subgroups.length, subgroupSize: n, n: subgroups.length * n };
    } else if (type === "i_mr") {
      const { values } = parsed;
      constants = chartConstants(2, H);
      const mr = movingRanges(values, budget);
      const mrBar = H.mean(mr, budget);
      if (!(mrBar > 0)) H.fail("STAT_DEGENERATE", "average moving range is zero; limits are undefined");
      const center = H.mean(values, budget);
      const sigma = mrBar / constants.d2;
      primary = values.map((value, index) => point(index + 1, value, center, sigma, center - 3 * sigma, center + 3 * sigma, 1));
      const mrSigma = constants.d3 * sigma;
      secondary = mr.map((value, index) => point(index + 2, value, mrBar, mrSigma, constants.D3 * mrBar, constants.D4 * mrBar, 2));
      secondaryLabel = "Moving range (2)";
      primaryLabel = "Individual value";
      estimates.push({ name: "process mean", estimate: center }, { name: "average moving range", estimate: mrBar }, { name: "sigma (MR-bar/1.128)", estimate: sigma });
      sampleInfo = { n: values.length, movingRanges: mr.length };
    } else if (type === "p" || type === "np") {
      const { defectives, sampleSizes } = parsed;
      const totalDefective = H.sum(defectives, budget);
      const totalInspected = H.sum(sampleSizes, budget);
      const pBar = totalDefective / totalInspected;
      if (!(pBar > 0) || !(pBar < 1)) H.fail("STAT_DEGENERATE", "pooled proportion must be strictly between 0 and 1 for binomial limits");
      if (type === "p") {
        primary = defectives.map((count, index) => {
          const n = sampleSizes[index];
          const sigma = Math.sqrt(pBar * (1 - pBar) / n);
          return point(index + 1, count / n, pBar, sigma, Math.max(0, pBar - 3 * sigma), Math.min(1, pBar + 3 * sigma), n);
        });
        primaryLabel = "Proportion defective";
      } else {
        const n = sampleSizes[0];
        const sigma = Math.sqrt(n * pBar * (1 - pBar));
        primary = defectives.map((count, index) => point(index + 1, count, n * pBar, sigma, Math.max(0, n * pBar - 3 * sigma), Math.min(n, n * pBar + 3 * sigma), n));
        primaryLabel = "Number defective";
      }
      estimates.push({ name: "pooled proportion defective", estimate: pBar }, { name: "total inspected", estimate: totalInspected });
      sampleInfo = { samples: defectives.length, totalInspected, totalDefective };
    } else if (type === "c") {
      const { values } = parsed;
      const cBar = H.mean(values, budget);
      if (!(cBar > 0)) H.fail("STAT_DEGENERATE", "average count must be positive for Poisson limits");
      const sigma = Math.sqrt(cBar);
      primary = values.map((value, index) => point(index + 1, value, cBar, sigma, Math.max(0, cBar - 3 * sigma), cBar + 3 * sigma, 1));
      primaryLabel = "Count of defects";
      estimates.push({ name: "average count", estimate: cBar });
      sampleInfo = { samples: values.length, totalDefects: H.sum(values, budget) };
    } else {
      const { defects, unitsInspected } = parsed;
      const totalDefects = H.sum(defects, budget);
      const totalUnits = H.sum(unitsInspected, budget);
      const uBar = totalDefects / totalUnits;
      if (!(uBar > 0)) H.fail("STAT_DEGENERATE", "average defects per unit must be positive for Poisson limits");
      primary = defects.map((count, index) => {
        const n = unitsInspected[index];
        const sigma = Math.sqrt(uBar / n);
        return point(index + 1, count / n, uBar, sigma, Math.max(0, uBar - 3 * sigma), uBar + 3 * sigma, n);
      });
      primaryLabel = "Defects per unit";
      estimates.push({ name: "average defects per unit", estimate: uBar }, { name: "total units inspected", estimate: totalUnits });
      sampleInfo = { samples: defects.length, totalDefects, totalUnits };
    }

    const primaryRules = westernElectric(primary, "primary", rules, budget);
    const primaryRows = finishPoints(primary, primaryRules.flagged);
    let secondaryRows = null;
    let violations = [...primaryRules.violations];
    if (secondary) {
      const secondaryRules = westernElectric(secondary, "dispersion", rules.filter((rule) => rule === 1), budget);
      secondaryRows = finishPoints(secondary, secondaryRules.flagged);
      violations = violations.concat(secondaryRules.violations);
    }
    violations.sort((a, b) => a.index - b.index || a.chart.localeCompare(b.chart, "en") || a.rule - b.rule);
    const primaryViolations = primaryRows.filter((row) => row.violation).length;
    const beyondLimits = primaryRows.filter((row) => row.rules && row.rules.split(",").includes("1")).length;
    const inControl = violations.length === 0;

    const artifacts = [
      H.tableArtifact(`${type} chart: ${primaryLabel}`, `Plotted statistic, center line, three-sigma limits, per-point sigma, and Western Electric flags for ${label}.`, POINT_COLUMNS(primaryLabel), primaryRows, [`Rules applied to the primary chart: ${rules.join(", ")}. Limits are Phase I trial limits estimated from these data.`], "control-chart-primary-table"),
    ];
    if (secondaryRows) {
      artifacts.push(H.tableArtifact(`${type} chart: ${secondaryLabel}`, "Dispersion chart statistic with center line and limits; only rule 1 (beyond limits) is applied here.", POINT_COLUMNS(secondaryLabel), secondaryRows, [], "control-chart-dispersion-table"));
    }
    artifacts.push(H.tableArtifact("Western Electric rule violations", "Each flagged point with the rule number and the side of the center line.", VIOLATION_COLUMNS, violations, violations.length ? [] : ["No rule violations were detected."], "control-chart-violations-table"));
    if (constants) {
      artifacts.push(H.tableArtifact("Control-chart constants", "d2, d3, c4 and derived A2, A3, B3, B4, D3, D4 for n = 2..25; the row used by this chart is marked.", CONSTANT_COLUMNS, constantsRows(H, constants.n), ["c4 uses the closed form sqrt(2/(n-1)) Gamma(n/2)/Gamma((n-1)/2); d2 and d3 are the standard tabulated values."], "control-chart-constants-table"));
    }
    artifacts.push(chartFigure(H, "control-chart", `${type} chart for ${label}`, primaryRows, primaryLabel));
    if (secondaryRows) artifacts.push(chartFigure(H, "control-chart-dispersion", `${type} dispersion chart for ${label}`, secondaryRows, secondaryLabel));

    const diagnostics = [
      { name: "process state", status: inControl ? "no_rule_violation" : "rule_violation", primaryFlaggedPoints: primaryViolations, beyondLimitPoints: beyondLimits, totalViolations: violations.length, boundary: "Phase I trial limits; points that violate rules should be investigated and, if assignable, removed before recomputing limits" },
      { name: "limit basis", status: "estimated_from_data", chartType: type, sigmaEstimator: type === "xbar_r" ? "R-bar/d2" : type === "xbar_s" ? "S-bar/c4" : type === "i_mr" ? "MR-bar/d2(2)" : type === "p" || type === "np" ? "binomial" : "poisson" },
      { name: "run-rule sensitivity", status: "asymptotic", detail: "Western Electric rules raise false-alarm rates; the in-control average run length of the combined rule set is not reported" },
    ];
    if (constants) diagnostics.push({ name: "constants", status: "tabulated", ...constants });
    return {
      sample: { chartType: type, points: primary.length, ...sampleInfo },
      estimates,
      tests: [],
      confidenceIntervals: [],
      effectSizes: [],
      assumptions: [
        { name: "rational subgroups in time order", status: "assumed" },
        { name: type === "p" || type === "np" ? "binomial counts with constant probability" : type === "c" || type === "u" ? "Poisson counts with constant rate" : "approximately normal subgroup statistic", status: "not_established" },
        { name: "independent samples", status: "not_established" },
      ],
      diagnostics,
      artifacts,
    };
  },
  linkage: {
    neededWhen: "When a process is monitored over time and the analyst must separate common-cause variation from assignable causes before trusting capability or making adjustments.",
    decision: "Whether the process is in statistical control, which samples carry assignable-cause evidence, and whether trial limits can be frozen for ongoing monitoring.",
    mustShow: "Every plotted statistic with center line and limits, the dispersion chart, the exact constants used, and each Western Electric violation with its rule and side.",
    userGoal: "Establish a stable baseline, investigate flagged samples with provenance, and only then proceed to capability or improvement claims.",
    nextActions: [
      { trigger: "rule-violation", action: "open-flagged-samples-and-record-assignable-cause", reason: "A flagged sample is a lead for investigation, not an automatic exclusion or a proof of a shift." },
      { trigger: "dispersion-out-of-control", action: "stabilize-variation-before-interpreting-the-mean-chart", reason: "Mean-chart limits depend on the dispersion estimate, so an unstable range chart invalidates them." },
      { trigger: "no-rule-violation", action: "freeze-limits-and-proceed-to-process-capability", reason: "Capability indices are only meaningful for a process shown to be in statistical control." },
      { trigger: "few-subgroups", action: "collect-more-subgroups-before-freezing-limits", reason: "Trial limits from fewer than about twenty subgroups are imprecise and inflate false alarms." },
    ],
  },
  fixture: {
    data: {
      subgroups: [
        [74.030, 74.002, 74.019, 73.992, 74.008],
        [73.995, 73.992, 74.001, 74.011, 74.004],
        [73.988, 74.024, 74.021, 74.005, 74.002],
        [74.002, 73.996, 73.993, 74.015, 74.009],
        [73.992, 74.007, 74.015, 73.989, 74.014],
        [74.009, 73.994, 73.997, 73.985, 73.993],
        [73.995, 74.006, 73.994, 74.000, 74.005],
        [73.985, 74.003, 73.993, 74.015, 73.988],
        [74.008, 73.995, 74.009, 74.005, 74.004],
        [73.998, 74.000, 73.990, 74.007, 73.995],
        [73.994, 73.998, 73.994, 73.995, 73.990],
        [74.004, 74.000, 74.007, 74.000, 73.996],
      ],
      label: "Piston ring diameter (mm)",
    },
    options: { chartType: "xbar_r" },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.industrial-statistics", "matlab.stats.descriptive-visualization"] },
  coverage: {
    implementedBoundary: "Shewhart X-bar/R, X-bar/S, I-MR, p, np, c, and u charts with three-sigma Phase I trial limits, tabulated constants for n = 2..25, and Western Electric rules 1-4 on the primary chart (rule 1 on the dispersion chart).",
    oracle: { level: "external-library-partial", evidence: ["contracts/quality-control-numpy-crosscheck.py"], verifiedOutputs: ["control-chart constants d2, d3, c4, A2, A3, B3, B4, D3, D4 for n = 2..25", "center lines, limits, and per-point sigma for every chart type", "Western Electric rule flags"], excludedOutputs: ["average run length", "Phase II limit revision after exclusions", "probability limits for small counts"] },
    diagnostic: { level: "method-specific-partial", emitted: ["process state with counts of flagged and beyond-limit points", "limit basis and sigma estimator", "constants used"], limitations: ["no ARL or false-alarm rate for the combined rule set", "no automatic exclusion of assignable-cause samples", "no normality check of the subgroup statistic"] },
    knownGaps: ["no exact binomial or Poisson probability limits", "no CUSUM/EWMA here (see cusum_ewma)", "no unequal-subgroup-size X-bar charts"],
  },
};

// ---------------------------------------------------------------------------------
// Process capability
// ---------------------------------------------------------------------------------
const processCapability = {
  method: "process_capability",
  family: "quality-control",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["confidenceLevel", "timeoutMs"],
  customOptions: {
    subgroupSize: {
      schema: { type: "integer", minimum: 1, maximum: 25 },
      default: 1,
      parse(value, H, path) { return H.integer(value, 1, 25, path); },
    },
    withinSigmaMethod: {
      schema: { type: "string", enum: ["auto", "mr", "rbar", "sbar"] },
      default: "auto",
      parse(value, H, path) {
        if (!["auto", "mr", "rbar", "sbar"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be auto, mr, rbar, or sbar`);
        return value;
      },
    },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["values"],
    properties: {
      values: { type: "array", minItems: 8, maxItems: 100000, items: { type: "number" } },
      lsl: { type: "number" },
      usl: { type: "number" },
      target: { type: "number" },
      label: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["values", "lsl", "usl", "target", "label"], "data");
    const values = H.numericVector(data.values, "data.values", 2);
    if (values.length < MIN_INDIVIDUALS) H.fail("STAT_INSUFFICIENT_SAMPLE", `process capability requires at least ${MIN_INDIVIDUALS} observations`);
    if (values.length > MAX_POINTS) H.fail("STAT_LIMIT_EXCEEDED", `observations exceed ${MAX_POINTS}`);
    const lsl = data.lsl === undefined ? null : H.finiteNumber(data.lsl, "data.lsl");
    const usl = data.usl === undefined ? null : H.finiteNumber(data.usl, "data.usl");
    const target = data.target === undefined ? null : H.finiteNumber(data.target, "data.target");
    if (lsl === null && usl === null) H.fail("STAT_INVALID_INPUT", "at least one of data.lsl or data.usl is required");
    if (lsl !== null && usl !== null && !(usl > lsl)) H.fail("STAT_INVALID_INPUT", "data.usl must exceed data.lsl");
    if (target !== null && ((lsl !== null && target < lsl) || (usl !== null && target > usl))) H.fail("STAT_INVALID_INPUT", "data.target must lie inside the specification limits");
    const subgroupSize = options.subgroupSize;
    let method = options.withinSigmaMethod;
    if (method === "auto") method = subgroupSize === 1 ? "mr" : "rbar";
    if (subgroupSize === 1 && method !== "mr") H.fail("STAT_INVALID_INPUT", "rbar and sbar within-sigma estimators require options.subgroupSize >= 2");
    if (subgroupSize > 1 && method === "mr") H.fail("STAT_INVALID_INPUT", "the mr within-sigma estimator requires options.subgroupSize = 1");
    const subgroups = subgroupSize === 1 ? null : chunk(values, subgroupSize, H, "data.values");
    if (subgroups && subgroups.length < 2) H.fail("STAT_INSUFFICIENT_SAMPLE", "at least two complete subgroups are required");
    return { values, lsl, usl, target, subgroupSize, subgroups, withinSigmaMethod: method, label: H.label(data.label, "Measurement", "data.label") };
  },
  analyze(parsed, options, budget, H) {
    const { values, lsl, usl, target, subgroupSize, subgroups, withinSigmaMethod, label } = parsed;
    const n = values.length;
    const mu = H.mean(values, budget);
    const sigmaOverall = Math.sqrt(H.variance(values, true, budget));
    if (!(sigmaOverall > 0)) H.fail("STAT_DEGENERATE", "observations have zero variance");
    let sigmaWithin;
    let withinDf;
    let sigmaBasis;
    if (withinSigmaMethod === "mr") {
      const mrBar = H.mean(movingRanges(values, budget), budget);
      if (!(mrBar > 0)) H.fail("STAT_DEGENERATE", "average moving range is zero");
      sigmaWithin = mrBar / D2_TABLE[0];
      withinDf = 0.9 * (n - 1);
      sigmaBasis = "MR-bar/d2(2)";
    } else {
      const constants = chartConstants(subgroupSize, H);
      const m = subgroups.length;
      if (withinSigmaMethod === "rbar") {
        const rBar = H.mean(subgroups.map((group) => range(group)), budget);
        if (!(rBar > 0)) H.fail("STAT_DEGENERATE", "average subgroup range is zero");
        sigmaWithin = rBar / constants.d2;
        withinDf = 0.9 * m * (subgroupSize - 1);
        sigmaBasis = "R-bar/d2";
      } else {
        const sBar = H.mean(subgroups.map((group) => Math.sqrt(H.variance(group, true, budget))), budget);
        if (!(sBar > 0)) H.fail("STAT_DEGENERATE", "average subgroup standard deviation is zero");
        sigmaWithin = sBar / constants.c4;
        withinDf = m * (subgroupSize - 1);
        sigmaBasis = "S-bar/c4";
      }
    }
    const twoSided = lsl !== null && usl !== null;
    const indices = (sigma) => {
      const upper = usl === null ? null : (usl - mu) / (3 * sigma);
      const lower = lsl === null ? null : (mu - lsl) / (3 * sigma);
      const spread = twoSided ? (usl - lsl) / (6 * sigma) : null;
      const k = upper === null ? lower : lower === null ? upper : Math.min(lower, upper);
      return { spread, lower, upper, k };
    };
    const within = indices(sigmaWithin);
    const overall = indices(sigmaOverall);
    const cpm = twoSided && target !== null ? (usl - lsl) / (6 * Math.sqrt(sigmaOverall * sigmaOverall + (mu - target) ** 2)) : null;
    const alpha = 1 - options.confidenceLevel;
    const z = normalQuantile(1 - alpha / 2, H);
    const spreadInterval = (value, df) => (value === null ? null : { lower: value * Math.sqrt(chiSquareQuantile(alpha / 2, df, H) / df), upper: value * Math.sqrt(chiSquareQuantile(1 - alpha / 2, df, H) / df) });
    const kInterval = (value, df) => {
      const half = z * Math.sqrt(1 / (9 * n) + value * value / (2 * df));
      return { lower: value - half, upper: value + half };
    };
    const cpCi = spreadInterval(within.spread, withinDf);
    const ppCi = spreadInterval(overall.spread, n - 1);
    const cpkCi = kInterval(within.k, withinDf);
    const ppkCi = kInterval(overall.k, n - 1);
    const ppm = (sigma) => {
      const below = lsl === null ? 0 : 1e6 * normalLowerTail((lsl - mu) / sigma, H);
      const above = usl === null ? 0 : 1e6 * normalUpperTail((usl - mu) / sigma, H);
      return { below, above, total: below + above };
    };
    const ppmWithin = ppm(sigmaWithin);
    const ppmOverall = ppm(sigmaOverall);
    const observedBelow = lsl === null ? 0 : values.filter((value) => value < lsl).length;
    const observedAbove = usl === null ? 0 : values.filter((value) => value > usl).length;
    const observed = { below: 1e6 * observedBelow / n, above: 1e6 * observedAbove / n, total: 1e6 * (observedBelow + observedAbove) / n };
    const normality = H.jarqueBera(values, budget);

    const indexRows = [
      { index: "Cp", estimate: within.spread, lower: cpCi ? cpCi.lower : null, upper: cpCi ? cpCi.upper : null, sigmaBasis: "within" },
      { index: "Cpl", estimate: within.lower, lower: null, upper: null, sigmaBasis: "within" },
      { index: "Cpu", estimate: within.upper, lower: null, upper: null, sigmaBasis: "within" },
      { index: "Cpk", estimate: within.k, lower: cpkCi.lower, upper: cpkCi.upper, sigmaBasis: "within" },
      { index: "Pp", estimate: overall.spread, lower: ppCi ? ppCi.lower : null, upper: ppCi ? ppCi.upper : null, sigmaBasis: "overall" },
      { index: "Ppl", estimate: overall.lower, lower: null, upper: null, sigmaBasis: "overall" },
      { index: "Ppu", estimate: overall.upper, lower: null, upper: null, sigmaBasis: "overall" },
      { index: "Ppk", estimate: overall.k, lower: ppkCi.lower, upper: ppkCi.upper, sigmaBasis: "overall" },
      { index: "Cpm", estimate: cpm, lower: null, upper: null, sigmaBasis: "overall-with-target" },
    ];
    const ppmRows = [
      { basis: "observed", below: observed.below, above: observed.above, total: observed.total },
      { basis: "expected within", below: ppmWithin.below, above: ppmWithin.above, total: ppmWithin.total },
      { basis: "expected overall", below: ppmOverall.below, above: ppmOverall.above, total: ppmOverall.total },
    ];
    const binCount = Math.max(5, Math.min(30, Math.ceil(Math.sqrt(n))));
    const histogramRows = H.histogram(values, binCount).map((bin, index) => ({ bin: index + 1, binStart: bin.binStart, binEnd: bin.binEnd, count: bin.count }));
    const markerRows = [];
    if (lsl !== null) markerRows.push({ marker: "LSL", value: lsl });
    if (usl !== null) markerRows.push({ marker: "USL", value: usl });
    if (target !== null) markerRows.push({ marker: "Target", value: target });
    markerRows.push({ marker: "Mean", value: mu });

    const confidenceIntervals = [];
    if (cpCi) confidenceIntervals.push({ parameter: "Cp", level: options.confidenceLevel, lower: cpCi.lower, upper: cpCi.upper, method: `chi-square interval with approximate within df ${withinDf}` });
    confidenceIntervals.push({ parameter: "Cpk", level: options.confidenceLevel, lower: cpkCi.lower, upper: cpkCi.upper, method: "Bissell normal approximation using within df" });
    if (ppCi) confidenceIntervals.push({ parameter: "Pp", level: options.confidenceLevel, lower: ppCi.lower, upper: ppCi.upper, method: "chi-square interval with n-1 df" });
    confidenceIntervals.push({ parameter: "Ppk", level: options.confidenceLevel, lower: ppkCi.lower, upper: ppkCi.upper, method: "Bissell normal approximation with n-1 df" });

    return {
      sample: { n, subgroupSize, subgroups: subgroups ? subgroups.length : null, lsl, usl, target },
      estimates: [
        { name: "process mean", estimate: mu },
        { name: "within sigma", estimate: sigmaWithin, basis: sigmaBasis, approximateDf: withinDf },
        { name: "overall sigma", estimate: sigmaOverall, basis: "sample standard deviation", df: n - 1 },
        ...indexRows.filter((row) => row.estimate !== null).map((row) => ({ name: row.index, estimate: row.estimate })),
        { name: "expected PPM within", estimate: ppmWithin.total },
        { name: "expected PPM overall", estimate: ppmOverall.total },
        { name: "observed PPM", estimate: observed.total },
      ],
      tests: normality.status === "evaluated" ? [{ name: "Jarque-Bera normality", statistic: normality.statistic, distribution: "chi-square", df: 2, pValue: normality.pValue }] : [],
      confidenceIntervals,
      effectSizes: [],
      assumptions: [
        { name: "process in statistical control", status: "not_established", detail: "capability indices presume a stable process; verify with control_chart first" },
        { name: "normal measurement distribution", status: normality.status === "evaluated" ? (normality.pValue < 0.05 ? "questionable" : "not_rejected") : "not_evaluated", pValue: normality.status === "evaluated" ? normality.pValue : null },
        { name: "specification limits are the true requirement", status: "assumed" },
      ],
      diagnostics: [
        { ...normality, boundary: "Jarque-Bera is a large-sample moment screen; expected PPM values are normal-theory extrapolations and are unreliable when normality fails" },
        { name: "within versus overall sigma", status: sigmaOverall > 1.2 * sigmaWithin ? "between-subgroup_variation_present" : "comparable", ratio: sigmaOverall / sigmaWithin },
        { name: "interval approximation", status: "asymptotic", detail: "Cp/Pp use chi-square intervals; Cpk/Ppk use the Bissell normal approximation; the within df is an approximation for range-based estimators" },
        { name: "one-sided specification", status: twoSided ? "not_applicable" : "cp_pp_cpm_undefined" },
      ],
      artifacts: [
        H.tableArtifact(`Process capability: ${label}`, `Capability and performance indices with ${Math.round(options.confidenceLevel * 100)}% intervals where available.`, [{ key: "index", label: "Index", type: "string" }, { key: "estimate", label: "Estimate", type: "number" }, { key: "lower", label: "Lower", type: "number" }, { key: "upper", label: "Upper", type: "number" }, { key: "sigmaBasis", label: "Sigma basis", type: "string" }], indexRows, ["Null cells mark indices that are undefined for one-sided specifications or that have no interval implemented."], "capability-index-table"),
        H.tableArtifact("Parts per million outside specification", "Observed versus normal-theory expected PPM using within and overall sigma.", [{ key: "basis", label: "Basis", type: "string" }, { key: "below", label: "Below LSL", type: "number" }, { key: "above", label: "Above USL", type: "number" }, { key: "total", label: "Total", type: "number" }], ppmRows, [], "capability-ppm-table"),
        H.tableArtifact("Capability histogram bins", "Equal-width bins of the observed measurements.", [{ key: "bin", label: "Bin", type: "number" }, { key: "binStart", label: "Start", type: "number" }, { key: "binEnd", label: "End", type: "number" }, { key: "count", label: "Count", type: "number" }], histogramRows, [], "capability-histogram-table"),
        H.tableArtifact("Specification markers", "Specification limits, target, and process mean used on the histogram.", [{ key: "marker", label: "Marker", type: "string" }, { key: "value", label: "Value", type: "number" }], markerRows, [], "capability-marker-table"),
        H.vegaArtifact("capability-histogram", `Process capability histogram: ${label}`, {
          layer: [
            { data: { values: histogramRows }, mark: { type: "bar", color: "#8FA9C2" }, encoding: { x: { field: "binStart", type: "quantitative", title: label, bin: { binned: true } }, x2: { field: "binEnd" }, y: { field: "count", type: "quantitative", title: "Count" }, tooltip: [{ field: "binStart", format: ".5g" }, { field: "binEnd", format: ".5g" }, { field: "count" }] } },
            { data: { values: markerRows }, mark: { type: "rule", strokeWidth: 2 }, encoding: { x: { field: "value", type: "quantitative" }, color: { field: "marker", type: "nominal", title: "Marker" }, tooltip: [{ field: "marker" }, { field: "value", format: ".5g" }] } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When a stable process must be compared against customer or engineering specification limits to quantify how much of its output can be expected to conform.",
    decision: "Whether the process is capable, whether the shortfall is centering or spread, and whether the normal-theory PPM projections are trustworthy.",
    mustShow: "Within and overall sigma with their basis, every index with its interval, expected and observed PPM, the histogram against specification limits, and the normality screen.",
    userGoal: "Report a defensible capability figure and choose between centering, variation reduction, or specification review.",
    nextActions: [
      { trigger: "cpk-much-lower-than-cp", action: "center-the-process-before-reducing-variation", reason: "A large gap between Cp and Cpk points at off-center location rather than excessive spread." },
      { trigger: "normality-questionable", action: "consider-transformation-or-distribution-specific-capability", reason: "Normal-theory PPM projections are unreliable when the measurement distribution is skewed." },
      { trigger: "overall-sigma-exceeds-within", action: "return-to-control-chart-for-between-subgroup-causes", reason: "Performance below capability signals drift or shifts between subgroups that a stable process would not show." },
      { trigger: "capable-and-stable", action: "bind-capability-table-and-histogram-to-the-report", reason: "The indices should travel with their intervals and sigma basis so the claim can be audited." },
    ],
  },
  fixture: {
    data: {
      values: [74.030, 74.002, 74.019, 73.992, 74.008, 73.995, 73.992, 74.001, 74.011, 74.004, 73.988, 74.024, 74.021, 74.005, 74.002, 74.002, 73.996, 73.993, 74.015, 74.009, 73.992, 74.007, 74.015, 73.989, 74.014, 74.009, 73.994, 73.997, 73.985, 73.993, 73.995, 74.006, 73.994, 74.000, 74.005, 73.985, 74.003, 73.993, 74.015, 73.988],
      lsl: 73.95,
      usl: 74.05,
      target: 74.0,
      label: "Piston ring diameter (mm)",
    },
    options: { subgroupSize: 5, withinSigmaMethod: "rbar", confidenceLevel: 0.95 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.industrial-statistics"] },
  coverage: {
    implementedBoundary: "Normal-theory Cp, Cpl, Cpu, Cpk, Pp, Ppl, Ppu, Ppk, and Cpm with within sigma from moving range, R-bar/d2, or S-bar/c4, chi-square and Bissell intervals, and expected PPM.",
    oracle: { level: "external-library-partial", evidence: ["contracts/quality-control-numpy-crosscheck.py"], verifiedOutputs: ["within and overall sigma", "all capability and performance indices", "chi-square Cp/Pp intervals", "Bissell Cpk/Ppk intervals", "expected and observed PPM"], excludedOutputs: ["non-normal capability", "bootstrap intervals", "Cpm interval"] },
    diagnostic: { level: "method-specific-partial", emitted: ["Jarque-Bera normality screen", "within versus overall sigma ratio", "interval approximation boundary"], limitations: ["no Anderson-Darling or Shapiro-Wilk test", "control state is not verified here", "within df for range-based estimators is an approximation"] },
    knownGaps: ["no Box-Cox or Johnson transformation", "no Cpm confidence interval", "no pooled-standard-deviation within estimator"],
  },
};

// ---------------------------------------------------------------------------------
// Crossed Gage R&R (ANOVA method)
// ---------------------------------------------------------------------------------
const gageRr = {
  method: "gage_rr",
  family: "quality-control",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["timeoutMs"],
  customOptions: {
    interactionAlpha: {
      schema: { type: "number", exclusiveMinimum: 0, maximum: 1 },
      default: 0.05,
      parse(value, H, path) { return parseBoundedNumber(value, H, path, 0, 1, { exclusiveMin: true }); },
    },
    studyVarMultiplier: {
      schema: { type: "number", minimum: 1, maximum: 10 },
      default: 6,
      parse(value, H, path) { return parseBoundedNumber(value, H, path, 1, 10); },
    },
    specTolerance: {
      schema: { type: ["number", "null"], exclusiveMinimum: 0 },
      default: null,
      parse(value, H, path) {
        if (value === null) return null;
        const number = H.finiteNumber(value, path);
        if (!(number > 0)) H.fail("STAT_INVALID_INPUT", `${path} must be a positive tolerance width`);
        return number;
      },
    },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["measurements"],
    properties: {
      measurements: { type: "array", minItems: 8, maxItems: 6000, items: { type: "object", additionalProperties: false, required: ["operator", "part", "value"], properties: { operator: { type: "string", minLength: 1, maxLength: 128 }, part: { type: "string", minLength: 1, maxLength: 128 }, value: { type: "number" } } } },
      label: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, _options, H) {
    H.assertKeys(data, ["measurements", "label"], "data");
    if (!Array.isArray(data.measurements)) H.fail("STAT_INVALID_INPUT", "data.measurements must be an array");
    if (data.measurements.length > 6000) H.fail("STAT_LIMIT_EXCEEDED", "measurements exceed 6000 rows");
    const rows = data.measurements.map((raw, index) => {
      const path = `data.measurements[${index}]`;
      const row = H.assertObject(raw, path);
      H.assertKeys(row, ["operator", "part", "value"], path);
      return { operator: H.label(row.operator, undefined, `${path}.operator`), part: H.label(row.part, undefined, `${path}.part`), value: H.finiteNumber(row.value, `${path}.value`) };
    });
    rows.forEach((row, index) => {
      if (row.operator === undefined || row.part === undefined) H.fail("STAT_INVALID_INPUT", `data.measurements[${index}] requires operator and part`);
    });
    const operators = [...new Set(rows.map((row) => row.operator))].sort((a, b) => a.localeCompare(b, "en"));
    const parts = [...new Set(rows.map((row) => row.part))].sort((a, b) => a.localeCompare(b, "en"));
    if (operators.length < 2 || operators.length > 10) H.fail("STAT_INVALID_INPUT", "gage_rr requires 2 to 10 operators");
    if (parts.length < 2 || parts.length > 30) H.fail("STAT_INVALID_INPUT", "gage_rr requires 2 to 30 parts");
    const cells = new Map();
    for (const row of rows) {
      const key = `${row.operator}\u0000${row.part}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(row.value);
    }
    const replicates = Math.max(...[...cells.values()].map((cell) => cell.length));
    if (replicates < 2) H.fail("STAT_INSUFFICIENT_SAMPLE", "gage_rr requires at least two replicate measurements per operator-part cell");
    for (const operator of operators) {
      for (const part of parts) {
        const cell = cells.get(`${operator}\u0000${part}`);
        if (!cell) H.fail("STAT_INVALID_INPUT", `missing measurements for operator ${operator} and part ${part}; the design must be balanced`);
        if (cell.length !== replicates) H.fail("STAT_INVALID_INPUT", `operator ${operator} and part ${part} have ${cell.length} replicates; every cell must have ${replicates}`);
      }
    }
    return { rows, operators, parts, replicates, cells: Object.fromEntries([...cells.entries()].map(([key, values]) => [key, values])), label: H.label(data.label, "Measurement", "data.label") };
  },
  analyze(parsed, options, budget, H) {
    const { operators, parts, replicates: r, cells, label } = parsed;
    const o = operators.length;
    const p = parts.length;
    const cellValues = (operator, part) => cells[`${operator}\u0000${part}`];
    const all = [];
    const cellMeans = {};
    for (const operator of operators) {
      for (const part of parts) {
        const values = cellValues(operator, part);
        cellMeans[`${operator}\u0000${part}`] = H.mean(values, budget);
        all.push(...values);
      }
    }
    const grand = H.mean(all, budget);
    const operatorMeans = operators.map((operator) => H.mean(parts.map((part) => cellMeans[`${operator}\u0000${part}`]), budget));
    const partMeans = parts.map((part) => H.mean(operators.map((operator) => cellMeans[`${operator}\u0000${part}`]), budget));
    let ssO = 0;
    let ssP = 0;
    let ssOP = 0;
    let ssE = 0;
    let ssT = 0;
    operatorMeans.forEach((m) => { ssO += (m - grand) ** 2; });
    partMeans.forEach((m) => { ssP += (m - grand) ** 2; });
    ssO *= p * r;
    ssP *= o * r;
    operators.forEach((operator, i) => {
      parts.forEach((part, j) => {
        budget.check();
        const cm = cellMeans[`${operator}\u0000${part}`];
        ssOP += (cm - operatorMeans[i] - partMeans[j] + grand) ** 2;
        for (const value of cellValues(operator, part)) {
          ssE += (value - cm) ** 2;
          ssT += (value - grand) ** 2;
        }
      });
    });
    ssOP *= r;
    const dfO = o - 1;
    const dfP = p - 1;
    const dfOP = dfO * dfP;
    const dfE = o * p * (r - 1);
    const dfT = o * p * r - 1;
    const msO = ssO / dfO;
    const msP = ssP / dfP;
    const msOP = ssOP / dfOP;
    const msE = ssE / dfE;
    if (!(msE > 0) && !(msOP > 0)) H.fail("STAT_DEGENERATE", "no measurement variation within or between operator-part cells");
    const fullRows = [
      { source: "Operator", df: dfO, ss: ssO, ms: msO, f: msOP > 0 ? msO / msOP : null, pValue: msOP > 0 ? H.pFromF(msO / msOP, dfO, dfOP) : null },
      { source: "Part", df: dfP, ss: ssP, ms: msP, f: msOP > 0 ? msP / msOP : null, pValue: msOP > 0 ? H.pFromF(msP / msOP, dfP, dfOP) : null },
      { source: "Operator x Part", df: dfOP, ss: ssOP, ms: msOP, f: msE > 0 ? msOP / msE : null, pValue: msE > 0 ? H.pFromF(msOP / msE, dfOP, dfE) : null },
      { source: "Repeatability", df: dfE, ss: ssE, ms: msE, f: null, pValue: null },
      { source: "Total", df: dfT, ss: ssT, ms: null, f: null, pValue: null },
    ];
    const interactionP = fullRows[2].pValue;
    const dropInteraction = interactionP !== null && interactionP > options.interactionAlpha;
    let anovaRows = fullRows;
    let vcRepeat;
    let vcInteraction;
    let vcOperator;
    let vcPart;
    if (dropInteraction) {
      const ssE2 = ssOP + ssE;
      const dfE2 = dfOP + dfE;
      const msE2 = ssE2 / dfE2;
      if (!(msE2 > 0)) H.fail("STAT_DEGENERATE", "pooled repeatability mean square is zero");
      anovaRows = [
        { source: "Operator", df: dfO, ss: ssO, ms: msO, f: msO / msE2, pValue: H.pFromF(msO / msE2, dfO, dfE2) },
        { source: "Part", df: dfP, ss: ssP, ms: msP, f: msP / msE2, pValue: H.pFromF(msP / msE2, dfP, dfE2) },
        { source: "Repeatability", df: dfE2, ss: ssE2, ms: msE2, f: null, pValue: null },
        { source: "Total", df: dfT, ss: ssT, ms: null, f: null, pValue: null },
      ];
      vcRepeat = msE2;
      vcInteraction = 0;
      vcOperator = Math.max(0, (msO - msE2) / (p * r));
      vcPart = Math.max(0, (msP - msE2) / (o * r));
    } else {
      vcRepeat = msE;
      vcInteraction = Math.max(0, (msOP - msE) / r);
      vcOperator = Math.max(0, (msO - msOP) / (p * r));
      vcPart = Math.max(0, (msP - msOP) / (o * r));
    }
    const vcReproducibility = vcOperator + vcInteraction;
    const vcGrr = vcRepeat + vcReproducibility;
    const vcTotal = vcGrr + vcPart;
    if (!(vcGrr > 0)) H.fail("STAT_DEGENERATE", "gage repeatability and reproducibility variance is zero");
    const k = options.studyVarMultiplier;
    const tol = options.specTolerance;
    const sdTotal = Math.sqrt(vcTotal);
    const component = (source, vc) => {
      const sd = Math.sqrt(vc);
      return { source, varianceComponent: vc, percentContribution: 100 * vc / vcTotal, standardDeviation: sd, studyVariation: k * sd, percentStudyVariation: 100 * sd / sdTotal, percentTolerance: tol === null ? null : 100 * k * sd / tol };
    };
    const componentRows = [
      component("Total Gage R&R", vcGrr),
      component("Repeatability", vcRepeat),
      component("Reproducibility", vcReproducibility),
      component("Operator", vcOperator),
      ...(dropInteraction ? [] : [component("Operator x Part", vcInteraction)]),
      component("Part-to-Part", vcPart),
      component("Total Variation", vcTotal),
    ];
    const ndc = Math.floor(1.41 * Math.sqrt(vcPart) / Math.sqrt(vcGrr));
    const percentGrrStudy = 100 * Math.sqrt(vcGrr) / sdTotal;
    const verdict = percentGrrStudy < 10 ? "acceptable" : percentGrrStudy <= 30 ? "marginal" : "unacceptable";
    const longRows = [];
    for (const row of componentRows) {
      if (row.source === "Total Variation") continue;
      longRows.push({ source: row.source, metric: "% Contribution", percent: row.percentContribution });
      longRows.push({ source: row.source, metric: "% Study Var", percent: row.percentStudyVariation });
      if (tol !== null) longRows.push({ source: row.source, metric: "% Tolerance", percent: row.percentTolerance });
    }
    // Repeatability error on every cell mean. The interaction plot is read by asking whether the
    // operator lines cross by more than the gauge itself scatters; without the repeatability
    // interval a reader cannot answer that from the picture, and the whole study is about exactly
    // that comparison. The half-width is the standard error of a cell mean under the fitted
    // repeatability variance, so it is the study's own estimate rather than a separate one.
    const cellHalfWidth = Math.sqrt(vcRepeat / r);
    const cellRows = [];
    operators.forEach((operator) => parts.forEach((part) => {
      const mean = cellMeans[`${operator}\u0000${part}`];
      cellRows.push({ operator, part, mean, replicates: r, standardError: cellHalfWidth, lower: mean - cellHalfWidth, upper: mean + cellHalfWidth });
    }));
    const anovaColumns = [{ key: "source", label: "Source", type: "string" }, { key: "df", label: "df", type: "number" }, { key: "ss", label: "SS", type: "number" }, { key: "ms", label: "MS", type: "number" }, { key: "f", label: "F", type: "number" }, { key: "pValue", label: "p", type: "number" }];
    return {
      sample: { operators: o, parts: p, replicates: r, n: o * p * r },
      estimates: [
        ...componentRows.map((row) => ({ name: `${row.source} variance component`, estimate: row.varianceComponent, percentContribution: row.percentContribution, percentStudyVariation: row.percentStudyVariation })),
        { name: "number of distinct categories", estimate: ndc },
        { name: "% Gage R&R (study variation)", estimate: percentGrrStudy },
      ],
      tests: anovaRows.filter((row) => row.f !== null).map((row) => ({ name: `${row.source} F test`, statistic: row.f, distribution: "F", df: [row.df, anovaRows.find((item) => item.source === (dropInteraction || row.source === "Operator x Part" ? "Repeatability" : "Operator x Part")).df], pValue: row.pValue })),
      confidenceIntervals: [],
      effectSizes: [{ name: "% Gage R&R of study variation", estimate: percentGrrStudy }, { name: "% part-to-part of study variation", estimate: 100 * Math.sqrt(vcPart) / sdTotal }],
      assumptions: [
        { name: "balanced crossed design", status: "verified", operators: o, parts: p, replicates: r },
        { name: "random operators and parts", status: "assumed" },
        { name: "normal measurement error", status: "not_established" },
        { name: "parts span the process range", status: "assumed" },
      ],
      diagnostics: [
        { name: "model", status: dropInteraction ? "reduced_interaction_pooled" : "full_with_interaction", interactionPValue: interactionP, interactionAlpha: options.interactionAlpha, detail: dropInteraction ? "interaction p exceeded alpha, so it was pooled into repeatability" : "interaction retained" },
        { name: "measurement system verdict", status: verdict, percentStudyVariation: percentGrrStudy, numberOfDistinctCategories: ndc, rule: "AIAG guidance: <10% acceptable, 10-30% marginal, >30% unacceptable; ndc >= 5 desired" },
        { name: "negative variance components", status: [vcOperator, vcInteraction, vcPart].some((vc) => vc === 0) ? "truncated_to_zero_possible" : "none", detail: "ANOVA-method components below zero are set to zero" },
      ],
      artifacts: [
        H.tableArtifact(`Gage R&R ANOVA: ${label}`, dropInteraction ? "Two-way ANOVA with the operator-by-part interaction pooled into repeatability." : "Two-way ANOVA with operator-by-part interaction.", anovaColumns, anovaRows, ["Operator and part F tests use the interaction mean square as denominator in the full model."], "gage-rr-anova-table"),
        ...(dropInteraction ? [H.tableArtifact("Gage R&R full-model ANOVA", "Full model with interaction, retained for transparency before pooling.", anovaColumns, fullRows, [], "gage-rr-full-anova-table")] : []),
        H.tableArtifact("Variance components", `Variance components, % contribution, ${k}-sigma study variation, and % study variation${tol === null ? "" : ", % tolerance"}.`, [{ key: "source", label: "Source", type: "string" }, { key: "varianceComponent", label: "VarComp", type: "number" }, { key: "percentContribution", label: "% Contribution", type: "number" }, { key: "standardDeviation", label: "StdDev", type: "number" }, { key: "studyVariation", label: `Study Var (${k}xSD)`, type: "number" }, { key: "percentStudyVariation", label: "% Study Var", type: "number" }, { key: "percentTolerance", label: "% Tolerance", type: "number" }], componentRows, [`Number of distinct categories: ${ndc}.`], "gage-rr-variance-components-table"),
        H.tableArtifact("Components of variation", "Long-format percentages used by the components-of-variation chart.", [{ key: "source", label: "Source", type: "string" }, { key: "metric", label: "Metric", type: "string" }, { key: "percent", label: "Percent", type: "number" }], longRows, [], "gage-rr-components-table"),
        H.tableArtifact("Operator-by-part cell means", "Mean of the replicate measurements per operator and part.", [{ key: "operator", label: "Operator", type: "string" }, { key: "part", label: "Part", type: "string" }, { key: "mean", label: "Mean", type: "number" }, { key: "replicates", label: "Replicates", type: "number" }, { key: "standardError", label: "Repeatability SE", type: "number" }, { key: "lower", label: "Lower", type: "number" }, { key: "upper", label: "Upper", type: "number" }], cellRows, ["The interval is one repeatability standard error of a cell mean, sqrt(repeatability variance / replicates)."], "gage-rr-cell-means-table"),
        H.vegaArtifact("gage-rr-components-of-variation", `Components of variation: ${label}`, {
          data: { values: longRows },
          mark: { type: "bar" },
          encoding: {
            x: { field: "source", type: "nominal", title: "Source", sort: null },
            xOffset: { field: "metric", type: "nominal" },
            y: { field: "percent", type: "quantitative", title: "Percent" },
            color: { field: "metric", type: "nominal", title: "Metric" },
            tooltip: [{ field: "source" }, { field: "metric" }, { field: "percent", format: ".4g" }],
          },
        }),
        H.vegaArtifact("gage-rr-interaction-plot", `Operator by part interaction with repeatability error: ${label}`, {
          data: { values: cellRows },
          layer: [
            {
              mark: { type: "rule", strokeWidth: 1.2, opacity: 0.7 },
              encoding: {
                x: { field: "part", type: "nominal", title: "Part", sort: null },
                y: { field: "lower", type: "quantitative", scale: { zero: false }, title: "Mean measurement" },
                y2: { field: "upper" },
                color: { field: "operator", type: "nominal", title: "Operator" },
              },
            },
            {
              mark: { type: "line", point: true },
              encoding: {
                x: { field: "part", type: "nominal", title: "Part", sort: null },
                y: { field: "mean", type: "quantitative", scale: { zero: false }, title: "Mean measurement" },
                color: { field: "operator", type: "nominal", title: "Operator" },
                tooltip: [{ field: "operator" }, { field: "part" }, { field: "mean", format: ".5g" }, { field: "lower", format: ".5g" }, { field: "upper", format: ".5g" }],
              },
            },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When a measurement system must be qualified before its readings are used for process control, capability, or acceptance decisions.",
    decision: "Whether measurement error is small enough relative to process and tolerance variation, and whether the error is repeatability or operator related.",
    mustShow: "The ANOVA table, every variance component with percent contribution and study variation, the number of distinct categories, and the interaction pattern by operator.",
    userGoal: "Accept, improve, or reject the gage and know which source of measurement error to attack first.",
    nextActions: [
      { trigger: "gage-rr-unacceptable", action: "identify-dominant-error-source-and-plan-gage-improvement", reason: "Repeatability points at the instrument while reproducibility points at operator training or procedure." },
      { trigger: "few-distinct-categories", action: "review-part-selection-and-gage-resolution", reason: "A low category count means the gage cannot distinguish the parts the process actually produces." },
      { trigger: "operator-part-interaction", action: "inspect-interaction-plot-and-standardize-measurement-procedure", reason: "Operators measuring specific parts differently indicates a procedure or fixture problem." },
      { trigger: "gage-acceptable", action: "bind-variance-components-and-proceed-to-process-capability", reason: "Downstream capability claims must carry the measurement-system qualification." },
    ],
  },
  fixture: {
    data: {
      measurements: [
        { operator: "A", part: "P1", value: 0.29 }, { operator: "A", part: "P1", value: 0.41 },
        { operator: "A", part: "P2", value: -0.56 }, { operator: "A", part: "P2", value: -0.68 },
        { operator: "A", part: "P3", value: 1.34 }, { operator: "A", part: "P3", value: 1.17 },
        { operator: "A", part: "P4", value: 0.47 }, { operator: "A", part: "P4", value: 0.50 },
        { operator: "A", part: "P5", value: -0.80 }, { operator: "A", part: "P5", value: -0.92 },
        { operator: "B", part: "P1", value: 0.08 }, { operator: "B", part: "P1", value: 0.25 },
        { operator: "B", part: "P2", value: -0.47 }, { operator: "B", part: "P2", value: -1.22 },
        { operator: "B", part: "P3", value: 1.19 }, { operator: "B", part: "P3", value: 0.94 },
        { operator: "B", part: "P4", value: 0.01 }, { operator: "B", part: "P4", value: 1.03 },
        { operator: "B", part: "P5", value: -0.56 }, { operator: "B", part: "P5", value: -1.20 },
        { operator: "C", part: "P1", value: 0.04 }, { operator: "C", part: "P1", value: -0.11 },
        { operator: "C", part: "P2", value: -1.38 }, { operator: "C", part: "P2", value: -1.13 },
        { operator: "C", part: "P3", value: 0.88 }, { operator: "C", part: "P3", value: 1.09 },
        { operator: "C", part: "P4", value: 0.14 }, { operator: "C", part: "P4", value: 0.20 },
        { operator: "C", part: "P5", value: -1.46 }, { operator: "C", part: "P5", value: -1.07 },
      ],
      label: "Thickness (mm)",
    },
    options: { studyVarMultiplier: 6, specTolerance: 8 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.industrial-statistics", "matlab.stats.anova"] },
  coverage: {
    implementedBoundary: "Balanced crossed Gage R&R by the two-way random-effects ANOVA method with optional pooling of a non-significant operator-by-part interaction, variance components, percent contribution, percent study variation, percent tolerance, and number of distinct categories.",
    oracle: { level: "external-library-partial", evidence: ["contracts/quality-control-numpy-crosscheck.py"], verifiedOutputs: ["sums of squares, mean squares, F statistics", "variance components for full and reduced models", "% contribution, % study variation, % tolerance", "number of distinct categories"], excludedOutputs: ["confidence intervals on variance components", "nested or unbalanced designs", "expanded (fixed-operator) models"] },
    diagnostic: { level: "method-specific-partial", emitted: ["model choice with interaction p-value", "AIAG verdict and ndc", "negative-component truncation flag"], limitations: ["no MLS or bootstrap intervals for components", "no per-operator range charts", "no linearity or bias study"] },
    knownGaps: ["unbalanced designs are rejected rather than analyzed", "no attribute agreement analysis", "no nested (destructive testing) Gage R&R"],
  },
};

// ---------------------------------------------------------------------------------
// CUSUM and EWMA monitoring
// ---------------------------------------------------------------------------------
const cusumEwma = {
  method: "cusum_ewma",
  family: "quality-control",
  analysisModel: { families: ["lm"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["timeoutMs"],
  customOptions: {
    cusumH: { schema: { type: "number", minimum: 0.1, maximum: 20 }, default: 5, parse(value, H, path) { return parseBoundedNumber(value, H, path, 0.1, 20); } },
    cusumK: { schema: { type: "number", minimum: 0.01, maximum: 5 }, default: 0.5, parse(value, H, path) { return parseBoundedNumber(value, H, path, 0.01, 5); } },
    cusumReset: { schema: { type: "boolean" }, default: true, parse(value, H, path) { if (typeof value !== "boolean") H.fail("STAT_INVALID_INPUT", `${path} must be boolean`); return value; } },
    ewmaLambda: { schema: { type: "number", exclusiveMinimum: 0, maximum: 1 }, default: 0.2, parse(value, H, path) { return parseBoundedNumber(value, H, path, 0, 1, { exclusiveMin: true }); } },
    ewmaL: { schema: { type: "number", minimum: 0.5, maximum: 10 }, default: 3, parse(value, H, path) { return parseBoundedNumber(value, H, path, 0.5, 10); } },
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["values"],
    properties: {
      values: { type: "array", minItems: 8, maxItems: 10000, items: { type: "number" } },
      target: { type: "number" },
      sigma: { type: "number", exclusiveMinimum: 0 },
      label: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  parse(data, _options, H) {
    H.assertKeys(data, ["values", "target", "sigma", "label"], "data");
    const values = H.numericVector(data.values, "data.values", 2);
    if (values.length < MIN_INDIVIDUALS) H.fail("STAT_INSUFFICIENT_SAMPLE", `cusum_ewma requires at least ${MIN_INDIVIDUALS} observations`);
    if (values.length > MAX_POINTS) H.fail("STAT_LIMIT_EXCEEDED", `observations exceed ${MAX_POINTS}`);
    const target = data.target === undefined ? null : H.finiteNumber(data.target, "data.target");
    const sigma = data.sigma === undefined ? null : H.finiteNumber(data.sigma, "data.sigma");
    if (sigma !== null && !(sigma > 0)) H.fail("STAT_INVALID_INPUT", "data.sigma must be positive");
    return { values, target, sigma, label: H.label(data.label, "Measurement", "data.label") };
  },
  analyze(parsed, options, budget, H) {
    const { values, label } = parsed;
    const n = values.length;
    const target = parsed.target === null ? H.mean(values, budget) : parsed.target;
    let sigma = parsed.sigma;
    let sigmaBasis = "supplied";
    if (sigma === null) {
      const mrBar = H.mean(movingRanges(values, budget), budget);
      if (!(mrBar > 0)) H.fail("STAT_DEGENERATE", "average moving range is zero; sigma cannot be estimated");
      sigma = mrBar / D2_TABLE[0];
      sigmaBasis = "MR-bar/d2(2)";
    }
    const h = options.cusumH * sigma;
    const k = options.cusumK * sigma;
    const lambda = options.ewmaLambda;
    const L = options.ewmaL;
    const cusumRows = [];
    const signals = [];
    let upper = 0;
    let lower = 0;
    for (let index = 0; index < n; index += 1) {
      budget.check();
      const value = values[index];
      upper = Math.max(0, value - (target + k) + upper);
      lower = Math.max(0, (target - k) - value + lower);
      const signalUpper = upper > h;
      const signalLower = lower > h;
      cusumRows.push({ index: index + 1, value, cusumUpper: upper, cusumLower: lower, threshold: h, signalUpper, signalLower });
      if (signalUpper) signals.push({ index: index + 1, chart: "cusum", side: "above", statistic: upper, limit: h });
      if (signalLower) signals.push({ index: index + 1, chart: "cusum", side: "below", statistic: lower, limit: h });
      if (options.cusumReset) {
        if (signalUpper) upper = 0;
        if (signalLower) lower = 0;
      }
    }
    const ewmaRows = [];
    let z = target;
    for (let index = 0; index < n; index += 1) {
      budget.check();
      const t = index + 1;
      z = lambda * values[index] + (1 - lambda) * z;
      const width = L * sigma * Math.sqrt(lambda / (2 - lambda) * (1 - (1 - lambda) ** (2 * t)));
      const lcl = target - width;
      const ucl = target + width;
      const signal = z > ucl || z < lcl;
      ewmaRows.push({ index: t, value: values[index], ewma: z, center: target, lcl, ucl, signal });
      if (z > ucl) signals.push({ index: t, chart: "ewma", side: "above", statistic: z, limit: ucl });
      else if (z < lcl) signals.push({ index: t, chart: "ewma", side: "below", statistic: z, limit: lcl });
    }
    signals.sort((a, b) => a.index - b.index || a.chart.localeCompare(b.chart, "en") || a.side.localeCompare(b.side, "en"));
    const cusumSignals = signals.filter((row) => row.chart === "cusum").length;
    const ewmaSignals = signals.filter((row) => row.chart === "ewma").length;
    const firstCusum = cusumSignals ? signals.find((row) => row.chart === "cusum").index : null;
    const firstEwma = ewmaSignals ? signals.find((row) => row.chart === "ewma").index : null;
    return {
      sample: { n, target, sigma, sigmaBasis },
      estimates: [
        { name: "target", estimate: target, basis: parsed.target === null ? "sample mean" : "supplied" },
        { name: "sigma", estimate: sigma, basis: sigmaBasis },
        { name: "CUSUM decision interval h", estimate: h, sigmaUnits: options.cusumH },
        { name: "CUSUM reference value k", estimate: k, sigmaUnits: options.cusumK },
        { name: "EWMA lambda", estimate: lambda },
        { name: "EWMA limit multiplier L", estimate: L },
        { name: "final EWMA", estimate: z },
      ],
      tests: [],
      confidenceIntervals: [],
      effectSizes: [],
      assumptions: [
        { name: "independent observations around a known target", status: "not_established" },
        { name: "sigma known or stable", status: sigmaBasis === "supplied" ? "supplied" : "estimated_from_moving_range" },
        { name: "approximately normal observations", status: "not_established" },
      ],
      diagnostics: [
        { name: "CUSUM signals", status: cusumSignals ? "out_of_control" : "no_signal", count: cusumSignals, firstSignal: firstCusum, reset: options.cusumReset },
        { name: "EWMA signals", status: ewmaSignals ? "out_of_control" : "no_signal", count: ewmaSignals, firstSignal: firstEwma },
        { name: "design", status: "user_specified", detail: "h, k, lambda, and L are design choices; average run length for this design is not computed" },
      ],
      artifacts: [
        H.tableArtifact(`Tabular CUSUM: ${label}`, `One-sided upper and lower cumulative sums with k = ${options.cusumK} sigma and decision interval h = ${options.cusumH} sigma${options.cusumReset ? " (reset after a signal)" : ""}.`, [{ key: "index", label: "Sample", type: "number" }, { key: "value", label: label, type: "number" }, { key: "cusumUpper", label: "C+", type: "number" }, { key: "cusumLower", label: "C-", type: "number" }, { key: "threshold", label: "h", type: "number" }, { key: "signalUpper", label: "Signal C+", type: "boolean" }, { key: "signalLower", label: "Signal C-", type: "boolean" }], cusumRows, [], "cusum-table"),
        H.tableArtifact(`EWMA: ${label}`, `Exponentially weighted moving average with lambda = ${lambda} and exact time-varying ${L}-sigma limits.`, [{ key: "index", label: "Sample", type: "number" }, { key: "value", label: label, type: "number" }, { key: "ewma", label: "EWMA", type: "number" }, { key: "center", label: "Center", type: "number" }, { key: "lcl", label: "LCL", type: "number" }, { key: "ucl", label: "UCL", type: "number" }, { key: "signal", label: "Signal", type: "boolean" }], ewmaRows, [], "ewma-table"),
        H.tableArtifact("Out-of-control signals", "Samples where a CUSUM statistic exceeded h or the EWMA crossed a limit.", [{ key: "index", label: "Sample", type: "number" }, { key: "chart", label: "Chart", type: "string" }, { key: "side", label: "Side", type: "string" }, { key: "statistic", label: "Statistic", type: "number" }, { key: "limit", label: "Limit", type: "number" }], signals, signals.length ? [] : ["No signals were detected."], "cusum-ewma-signal-table"),
        H.vegaArtifact("cusum-chart", `Tabular CUSUM: ${label}`, {
          data: { values: cusumRows },
          layer: [
            { mark: { type: "line", color: "#B24A3B", strokeDash: [6, 4] }, encoding: { x: { field: "index", type: "quantitative", title: "Sample" }, y: { field: "threshold", type: "quantitative", title: "Cumulative sum" } } },
            { mark: { type: "line", color: "#1F4E79", point: true }, encoding: { x: { field: "index", type: "quantitative" }, y: { field: "cusumUpper", type: "quantitative" }, tooltip: [{ field: "index" }, { field: "cusumUpper", format: ".5g" }, { field: "signalUpper" }] } },
            { mark: { type: "line", color: "#4A6B3A", point: true }, encoding: { x: { field: "index", type: "quantitative" }, y: { field: "cusumLower", type: "quantitative" }, tooltip: [{ field: "index" }, { field: "cusumLower", format: ".5g" }, { field: "signalLower" }] } },
          ],
        }),
        H.vegaArtifact("ewma-chart", `EWMA chart: ${label}`, {
          data: { values: ewmaRows },
          layer: [
            { mark: { type: "line", color: "#B24A3B", strokeDash: [6, 4] }, encoding: { x: { field: "index", type: "quantitative", title: "Sample" }, y: { field: "ucl", type: "quantitative", title: "EWMA" } } },
            { mark: { type: "line", color: "#B24A3B", strokeDash: [6, 4] }, encoding: { x: { field: "index", type: "quantitative" }, y: { field: "lcl", type: "quantitative" } } },
            { mark: { type: "line", color: "#4A6B3A", strokeDash: [2, 2] }, encoding: { x: { field: "index", type: "quantitative" }, y: { field: "center", type: "quantitative" } } },
            { mark: { type: "line", color: "#1F4E79" }, encoding: { x: { field: "index", type: "quantitative" }, y: { field: "ewma", type: "quantitative" } } },
            { mark: { type: "point", filled: true, size: 70 }, encoding: { x: { field: "index", type: "quantitative" }, y: { field: "ewma", type: "quantitative" }, color: { condition: { test: "datum.signal === true", value: "#B24A3B" }, value: "#1F4E79" }, tooltip: [{ field: "index" }, { field: "ewma", format: ".5g" }, { field: "lcl", format: ".5g" }, { field: "ucl", format: ".5g" }] } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When small sustained shifts from a target must be detected faster than a Shewhart chart allows, typically in individual-measurement monitoring.",
    decision: "Whether the process mean has drifted from target, when the shift began, and whether the chart design (h, k, lambda, L) matches the shift size of concern.",
    mustShow: "The target and sigma basis, both CUSUM statistics against the decision interval, the EWMA path with its time-varying limits, and every signal with its sample index.",
    userGoal: "Catch drift early, date its onset, and justify an adjustment or investigation with the signal evidence.",
    nextActions: [
      { trigger: "cusum-or-ewma-signal", action: "date-shift-onset-and-open-process-records-around-it", reason: "The sample where the statistic began to climb dates the shift better than the signal sample itself." },
      { trigger: "no-signal", action: "confirm-design-parameters-match-target-shift-size", reason: "A CUSUM tuned for a large shift will miss a smaller drift that still matters to the customer." },
      { trigger: "sigma-estimated-from-data", action: "replace-with-phase-one-sigma-when-available", reason: "Limits computed from the monitored data themselves are contaminated by any shift present." },
    ],
  },
  fixture: {
    data: {
      values: [9.45, 7.99, 9.29, 11.66, 12.16, 10.18, 8.04, 11.46, 9.20, 10.34, 9.03, 11.47, 10.51, 9.40, 10.08, 9.37, 10.62, 10.31, 8.52, 10.90, 9.33, 12.29, 11.50, 10.60, 11.08, 10.38, 11.62, 11.31, 10.52, 10.84],
      target: 10,
      sigma: 1,
      label: "Concentration",
    },
    options: { cusumH: 5, cusumK: 0.5, ewmaLambda: 0.1, ewmaL: 2.7 },
  },
  matlabParity: { taxonomyIds: ["matlab.stats.industrial-statistics"] },
  coverage: {
    implementedBoundary: "Two-sided tabular CUSUM with reference value k and decision interval h (optional reset after signal) and an EWMA chart with exact time-varying limits, both with user-supplied or moving-range sigma.",
    oracle: { level: "external-library-partial", evidence: ["contracts/quality-control-numpy-crosscheck.py"], verifiedOutputs: ["CUSUM upper and lower statistics and signals", "EWMA statistics, limits, and signals", "moving-range sigma"], excludedOutputs: ["average run length", "fast initial response (FIR) CUSUM", "variance monitoring"] },
    diagnostic: { level: "method-specific-partial", emitted: ["signal counts and first signal per chart", "design parameter echo"], limitations: ["no ARL evaluation of the chosen design", "no autocorrelation adjustment"] },
    knownGaps: ["no FIR head start", "no V-mask CUSUM", "no multivariate EWMA"],
  },
};

module.exports = { methods: [controlChart, processCapability, gageRr, cusumEwma] };
