"use strict";

// Spatial autocorrelation on researcher-supplied point observations:
// global Moran's I and Geary's C under the randomisation assumption, and
// Anselin's local Moran (LISA) with analytical conditional moments.
//
// References
//  Moran P. A. P. (1950) Biometrika 37, 17–23.
//  Geary R. C. (1954) The Incorporated Statistician 5, 115–146.
//  Cliff A. D. & Ord J. K. (1981) Spatial Processes: Models and Applications — randomisation moments (eqs. 2.35–2.38).
//  Anselin L. (1995) Geographical Analysis 27, 93–115 — local indicators of spatial association.
//  Sokal R. R., Oden N. L., Thomson B. A. (1998) Geographical Analysis 30, 331–354 — local Moran moments.
//  IUGG (1980) — mean Earth radius 6371.0088 km for great-circle distances.

const N = require("./earth-numerics.cjs");

function core() {
  return require("./earth-science.cjs");
}

const EARTH_RADIUS_KM = 6371.0088;
const WEIGHT_KINDS = new Set(["inverse-distance", "knn"]);
const COORDINATE_SYSTEMS = new Set(["geographic", "planar"]);

function assertSourceSha(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw N.fail("earth-table-source-sha256-invalid");
  return value;
}

function haversineKm(lonA, latA, lonB, latB) {
  const toRad = Math.PI / 180;
  const dLat = (latB - latA) * toRad;
  const dLon = (lonB - lonA) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(latA * toRad) * Math.cos(latB * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function normalizeSpatialInput(value) {
  const C = core();
  const input = C.exactObject(value, ["sourceContentSha256", "coordinateSystem", "distanceUnit", "valueUnit", "locations", "weights", "confidenceLevel"], "earth-spatial-input");
  const sourceContentSha256 = assertSourceSha(input.sourceContentSha256);
  const coordinateSystem = input.coordinateSystem === undefined ? "geographic" : C.text(input.coordinateSystem, 1, 20, "earth-spatial-coordinate-system");
  if (!COORDINATE_SYSTEMS.has(coordinateSystem)) throw N.fail("earth-spatial-coordinate-system-invalid");
  const distanceUnit = coordinateSystem === "geographic" ? "km" : input.distanceUnit === undefined ? "unit" : C.text(input.distanceUnit, 1, 20, "earth-spatial-distance-unit");
  const valueUnit = input.valueUnit === undefined || input.valueUnit === null ? null : C.text(input.valueUnit, 1, 40, "earth-spatial-value-unit");
  if (!Array.isArray(input.locations) || input.locations.length < 4 || input.locations.length > 3_000) throw N.fail("earth-spatial-locations-length-invalid", "spatial autocorrelation requires 4–3000 locations");
  const ids = new Set();
  const seenCoordinates = new Set();
  const locations = input.locations.map((row, index) => {
    const item = C.exactObject(row, ["id", "x", "y", "value"], "earth-spatial-location");
    const id = C.text(item.id, 1, 80, "earth-spatial-location-id");
    if (ids.has(id)) throw N.fail("earth-spatial-location-id-duplicate", `duplicate location id ${id}`, { index });
    ids.add(id);
    const x = coordinateSystem === "geographic" ? C.finite(item.x, -180, 180, "earth-spatial-longitude") : C.finite(item.x, -1e9, 1e9, "earth-spatial-x");
    const y = coordinateSystem === "geographic" ? C.finite(item.y, -90, 90, "earth-spatial-latitude") : C.finite(item.y, -1e9, 1e9, "earth-spatial-y");
    const key = `${x}:${y}`;
    if (seenCoordinates.has(key)) throw N.fail("earth-spatial-location-coincident", "two locations share exact coordinates; inverse-distance weights are undefined at zero distance", { id });
    seenCoordinates.add(key);
    const observed = C.finite(item.value, -1e12, 1e12, "earth-spatial-value");
    return { id, x, y, value: observed };
  });
  const weightsInput = C.exactObject(input.weights ?? {}, ["kind", "power", "bandwidth", "k", "rowStandardize"], "earth-spatial-weights");
  const kind = weightsInput.kind === undefined ? "inverse-distance" : C.text(weightsInput.kind, 1, 20, "earth-spatial-weights-kind");
  if (!WEIGHT_KINDS.has(kind)) throw N.fail("earth-spatial-weights-kind-invalid");
  const power = kind === "inverse-distance" ? (weightsInput.power === undefined ? 1 : C.finite(weightsInput.power, 0.1, 4, "earth-spatial-weights-power")) : null;
  const bandwidth = kind === "inverse-distance" ? (weightsInput.bandwidth === undefined || weightsInput.bandwidth === null ? null : C.finite(weightsInput.bandwidth, 1e-9, 1e9, "earth-spatial-weights-bandwidth")) : null;
  const k = kind === "knn" ? (weightsInput.k === undefined ? Math.min(8, locations.length - 1) : C.integer(weightsInput.k, 1, locations.length - 1, "earth-spatial-weights-k")) : null;
  const rowStandardize = weightsInput.rowStandardize === undefined ? true : weightsInput.rowStandardize;
  if (typeof rowStandardize !== "boolean") throw N.fail("earth-spatial-weights-row-standardize-invalid");
  const confidenceLevel = input.confidenceLevel === undefined ? 0.95 : C.finite(input.confidenceLevel, 0.8, 0.999, "earth-spatial-confidence-level");
  return { sourceContentSha256, coordinateSystem, distanceUnit, valueUnit, locations, weights: { kind, power, bandwidth, k, rowStandardize }, confidenceLevel };
}

function buildWeights(locations, coordinateSystem, weights) {
  const n = locations.length;
  const distance = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const d = coordinateSystem === "geographic"
        ? haversineKm(locations[i].x, locations[i].y, locations[j].x, locations[j].y)
        : Math.hypot(locations[i].x - locations[j].x, locations[i].y - locations[j].y);
      if (!(d > 0)) throw N.fail("earth-spatial-distance-zero", "two locations are at zero distance", { i: locations[i].id, j: locations[j].id });
      distance[i][j] = d;
      distance[j][i] = d;
    }
  }
  const raw = Array.from({ length: n }, () => new Array(n).fill(0));
  if (weights.kind === "inverse-distance") {
    for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) {
      if (i === j) continue;
      if (weights.bandwidth !== null && distance[i][j] > weights.bandwidth) continue;
      raw[i][j] = 1 / distance[i][j] ** weights.power;
    }
  } else {
    for (let i = 0; i < n; i += 1) {
      const order = [];
      for (let j = 0; j < n; j += 1) if (j !== i) order.push(j);
      order.sort((a, b) => distance[i][a] - distance[i][b] || locations[a].id.localeCompare(locations[b].id));
      for (const j of order.slice(0, weights.k)) raw[i][j] = 1;
    }
  }
  const islands = [];
  const matrix = raw.map((row, i) => {
    const total = N.sum(row);
    if (total === 0) { islands.push(locations[i].id); return row.slice(); }
    return weights.rowStandardize ? row.map((w) => w / total) : row.slice();
  });
  return { distance, matrix, islands };
}

function analyzeSpatialAutocorrelation(value) {
  const C = core();
  const input = normalizeSpatialInput(value);
  const n = input.locations.length;
  const { distance, matrix: w, islands } = buildWeights(input.locations, input.coordinateSystem, input.weights);
  if (islands.length) throw N.fail("earth-spatial-islands", "some locations have no neighbours under the declared weights; widen the bandwidth or k", { islands });
  const values = input.locations.map((item) => item.value);
  const meanValue = N.mean(values);
  const z = values.map((item) => item - meanValue);
  const m2Sum = N.sum(z.map((item) => item * item));
  if (!(m2Sum > 0)) throw N.fail("earth-spatial-values-constant", "all values are identical; autocorrelation is undefined");
  const m4Sum = N.sum(z.map((item) => item ** 4));
  const b2 = n * m4Sum / (m2Sum * m2Sum);
  let S0 = 0;
  let S1 = 0;
  let numeratorI = 0;
  let numeratorC = 0;
  const rowSums = new Array(n).fill(0);
  const columnSums = new Array(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const wij = w[i][j];
      if (wij === 0 && w[j][i] === 0) continue;
      S0 += wij;
      S1 += 0.5 * (wij + w[j][i]) ** 2;
      numeratorI += wij * z[i] * z[j];
      numeratorC += wij * (values[i] - values[j]) ** 2;
      rowSums[i] += wij;
      columnSums[j] += wij;
    }
  }
  // S1 above double counts each unordered pair when both directions are visited; Cliff & Ord define S1 = ½ΣΣ(w_ij + w_ji)² over all i,j.
  const S2 = N.sum(rowSums.map((r, i) => (r + columnSums[i]) ** 2));
  const moranI = (n / S0) * numeratorI / m2Sum;
  const expectedI = -1 / (n - 1);
  const varianceI = (n * ((n * n - 3 * n + 3) * S1 - n * S2 + 3 * S0 * S0) - b2 * ((n * n - n) * S1 - 2 * n * S2 + 6 * S0 * S0)) / ((n - 1) * (n - 2) * (n - 3) * S0 * S0) - expectedI * expectedI;
  const zI = (moranI - expectedI) / Math.sqrt(varianceI);
  const pI = 2 * N.normalSf(Math.abs(zI));
  const gearyC = (n - 1) * numeratorC / (2 * S0 * m2Sum);
  const expectedC = 1;
  const varianceC = ((n - 1) * S1 * (n * n - 3 * n + 3 - (n - 1) * b2) - 0.25 * (n - 1) * S2 * (n * n + 3 * n - 6 - (n * n - n + 2) * b2) + S0 * S0 * (n * n - 3 - (n - 1) ** 2 * b2)) / (n * (n - 2) * (n - 3) * S0 * S0);
  const zC = (gearyC - expectedC) / Math.sqrt(varianceC);
  const pC = 2 * N.normalSf(Math.abs(zC));
  const alpha = 1 - input.confidenceLevel;
  // Local Moran (Anselin 1995) with m2 = Σz²/n and conditional-randomisation moments (Sokal et al. 1998).
  const m2 = m2Sum / n;
  const localB2 = b2; // b2 = (Σz⁴/n)/(Σz²/n)²
  const localRows = input.locations.map((item, i) => {
    let lag = 0;
    let wi = 0;
    let wi2 = 0;
    for (let j = 0; j < n; j += 1) { lag += w[i][j] * z[j]; wi += w[i][j]; wi2 += w[i][j] * w[i][j]; }
    const wikh = wi * wi - wi2;
    const localI = z[i] / m2 * lag;
    const expected = -wi / (n - 1);
    const variance = wi2 * (n - localB2) / (n - 1) + 2 * wikh * (2 * localB2 - n) / ((n - 1) * (n - 2)) - (wi * wi) / ((n - 1) * (n - 1));
    const zScore = variance > 0 ? (localI - expected) / Math.sqrt(variance) : null;
    const pValue = zScore === null ? null : 2 * N.normalSf(Math.abs(zScore));
    const quadrant = z[i] >= 0 ? (lag >= 0 ? "high-high" : "high-low") : (lag >= 0 ? "low-high" : "low-low");
    return {
      id: item.id, x: item.x, y: item.y, value: item.value, deviation: N.rounded(z[i]), spatialLag: N.rounded(lag), neighbourWeightSum: N.rounded(wi),
      localMoranI: N.rounded(localI), expected: N.rounded(expected), variance: N.rounded(variance), zScore: zScore === null ? null : N.rounded(zScore), pValue: pValue === null ? null : N.rounded(pValue),
      quadrant, significant: pValue !== null && pValue < alpha, significantBonferroni: pValue !== null && pValue < alpha / n,
      cluster: pValue !== null && pValue < alpha ? quadrant : "not significant",
    };
  });
  const distances = [];
  for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) distances.push(distance[i][j]);
  const publicationTable = {
    schema: "agentlas.science-table/v1",
    title: "Global spatial autocorrelation (randomisation inference)",
    columns: [{ id: "statistic", label: "Statistic", type: "string", unit: null }, { id: "observed", label: "Observed", type: "number", unit: null }, { id: "expected", label: "Expected", type: "number", unit: null }, { id: "variance", label: "Variance", type: "number", unit: null }, { id: "z", label: "z", type: "number", unit: null }, { id: "pValue", label: "p (two-sided)", type: "number", unit: null }, { id: "interpretation", label: "Interpretation", type: "string", unit: null }],
    rows: [
      ["Moran's I", N.rounded(moranI), N.rounded(expectedI), N.rounded(varianceI), N.rounded(zI), N.rounded(pI), pI < alpha ? (moranI > expectedI ? "positive spatial autocorrelation (clustering)" : "negative spatial autocorrelation (dispersion)") : "no evidence against spatial randomness"],
      ["Geary's C", N.rounded(gearyC), 1, N.rounded(varianceC), N.rounded(zC), N.rounded(pC), pC < alpha ? (gearyC < 1 ? "positive spatial autocorrelation (similar neighbours)" : "negative spatial autocorrelation (dissimilar neighbours)") : "no evidence against spatial randomness"],
    ],
    notes: [
      `n=${n}; weights: ${input.weights.kind}${input.weights.kind === "inverse-distance" ? ` (power ${input.weights.power}${input.weights.bandwidth === null ? "" : `, bandwidth ${input.weights.bandwidth} ${input.distanceUnit}`})` : ` (k=${input.weights.k})`}, ${input.weights.rowStandardize ? "row-standardised" : "binary/raw"}; S0=${N.rounded(S0, 6)}, S1=${N.rounded(S1, 6)}, S2=${N.rounded(S2, 6)}, kurtosis b2=${N.rounded(b2, 6)}.`,
      "Variances follow the randomisation assumption (Cliff & Ord 1981); p-values are two-sided normal approximations, not permutation p-values.",
    ],
  };
  const localTable = {
    schema: "agentlas.science-table/v1", title: "Local Moran (LISA) by location",
    columns: [
      { id: "id", label: "Location", type: "string", unit: null }, { id: "x", label: input.coordinateSystem === "geographic" ? "Longitude" : "x", type: "number", unit: input.coordinateSystem === "geographic" ? "degree" : input.distanceUnit },
      { id: "y", label: input.coordinateSystem === "geographic" ? "Latitude" : "y", type: "number", unit: input.coordinateSystem === "geographic" ? "degree" : input.distanceUnit },
      { id: "value", label: "Value", type: "number", unit: input.valueUnit }, { id: "spatialLag", label: "Spatial lag of deviation", type: "number", unit: input.valueUnit },
      { id: "localMoranI", label: "Local I", type: "number", unit: null }, { id: "expected", label: "E[I_i]", type: "number", unit: null }, { id: "zScore", label: "z", type: "number", unit: null }, { id: "pValue", label: "p", type: "number", unit: null },
      { id: "quadrant", label: "Quadrant", type: "string", unit: null }, { id: "cluster", label: `Cluster (α=${N.rounded(alpha, 4)})`, type: "string", unit: null }, { id: "significantBonferroni", label: "Bonferroni significant", type: "boolean", unit: null },
    ],
    rows: localRows.map((row) => [row.id, row.x, row.y, row.value, row.spatialLag, row.localMoranI, row.expected, row.zScore, row.pValue, row.quadrant, row.cluster, row.significantBonferroni]),
  };
  const vegaLite = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    title: `Moran scatterplot (I=${N.rounded(moranI, 4)}, z=${N.rounded(zI, 3)}, p=${N.rounded(pI, 4)})`,
    background: "white", width: 480, height: 420,
    layer: [
      { data: { values: localRows.map((row) => ({ id: row.id, deviation: row.deviation, spatialLag: row.spatialLag, cluster: row.cluster })) }, mark: { type: "point", filled: true, size: 55 }, encoding: { x: { field: "deviation", type: "quantitative", title: `Deviation from mean${input.valueUnit ? ` (${input.valueUnit})` : ""}` }, y: { field: "spatialLag", type: "quantitative", title: "Spatial lag of deviation" }, color: { field: "cluster", type: "nominal", scale: { domain: ["high-high", "low-low", "high-low", "low-high", "not significant"], range: ["#B85C38", "#2E6F62", "#D9A441", "#5C7080", "#C9C5BE"] }, title: "LISA cluster" }, tooltip: [{ field: "id", type: "nominal" }, { field: "deviation", type: "quantitative", format: ".3f" }, { field: "spatialLag", type: "quantitative", format: ".3f" }, { field: "cluster", type: "nominal" }] } },
      { data: { values: [{ x: Math.min(...z), y: Math.min(...z) * moranI * (S0 / n) }, { x: Math.max(...z), y: Math.max(...z) * moranI * (S0 / n) }].map((row) => ({ x: N.rounded(row.x), y: N.rounded(row.y) })) }, mark: { type: "line", color: "#7A7772", strokeDash: [6, 3] }, encoding: { x: { field: "x", type: "quantitative" }, y: { field: "y", type: "quantitative" } } },
      { mark: { type: "rule", color: "#D8D5D0" }, encoding: { x: { datum: 0 } } },
      { mark: { type: "rule", color: "#D8D5D0" }, encoding: { y: { datum: 0 } } },
    ],
    config: { axis: { labelFontSize: 11, titleFontSize: 12 }, view: { stroke: "#D8D5D0" } },
  };
  const contentReceipts = {
    publicationTable: C.contentReceipt("spatial-global-table", "application/vnd.agentlas.science-table+json", publicationTable),
    localTable: C.contentReceipt("spatial-lisa-table", "application/vnd.agentlas.science-table+json", localTable),
    figure: C.contentReceipt("spatial-moran-scatter-figure", "application/vnd.vegalite.v5+json", vegaLite),
  };
  const analysis = {
    schema: "agentlas.earth.spatial-autocorrelation-analysis/v1",
    methodRevision: "moran-geary-randomisation-lisa-analytical/v1",
    source: { sourceContentSha256: input.sourceContentSha256, locationCount: n, coordinateSystem: input.coordinateSystem, distanceUnit: input.distanceUnit, valueUnit: input.valueUnit },
    settings: { weights: input.weights, confidenceLevel: input.confidenceLevel, earthRadiusKm: input.coordinateSystem === "geographic" ? EARTH_RADIUS_KM : null },
    weightSummary: { S0: N.rounded(S0), S1: N.rounded(S1), S2: N.rounded(S2), kurtosisB2: N.rounded(b2), minimumDistance: N.rounded(Math.min(...distances)), maximumDistance: N.rounded(Math.max(...distances)), meanNeighboursPerLocation: N.rounded(N.mean(w.map((row) => row.filter((item) => item > 0).length))) },
    moran: { observed: N.rounded(moranI), expected: N.rounded(expectedI), variance: N.rounded(varianceI), z: N.rounded(zI), pValue: N.rounded(pI), significantAtLevel: pI < alpha },
    geary: { observed: N.rounded(gearyC), expected: 1, variance: N.rounded(varianceC), z: N.rounded(zC), pValue: N.rounded(pC), significantAtLevel: pC < alpha },
    local: { definition: "I_i = (z_i/m2)·Σ_j w_ij z_j with m2 = Σz²/n (Anselin 1995); moments under conditional randomisation (Sokal et al. 1998)", clusterCounts: localRows.reduce((counts, row) => { counts[row.cluster] = (counts[row.cluster] ?? 0) + 1; return counts; }, {}), rows: localRows },
    publicationTable, localTable, vegaLite, contentReceipts,
    assumptions: [
      "Weights are computed from the declared coordinates only; geographic coordinates use great-circle distance on a sphere of radius 6371.0088 km.",
      "Inference uses analytical randomisation moments and a normal approximation; no permutation test is run, so small-n or highly skewed data need caution.",
      "Local p-values are not adjusted for multiple comparisons except the reported Bonferroni flag; LISA clusters describe association, not process.",
    ],
    rendererCompatibility: { rendererId: "agentlas.vega", hostRequired: true, bundledRenderer: false, interactive: "tooltip-only" },
  };
  return { ...analysis, analysisSha256: N.sha256Json(analysis) };
}

module.exports = {
  EARTH_RADIUS_KM,
  analyzeSpatialAutocorrelation,
  buildWeights,
  haversineKm,
  normalizeSpatialInput,
};
