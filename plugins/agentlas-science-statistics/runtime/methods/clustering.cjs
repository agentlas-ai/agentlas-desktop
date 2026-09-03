"use strict";

/**
 * Clustering family: k-means (k-means++ seeded restarts, silhouette, elbow table), agglomerative
 * hierarchical clustering (single / complete / average / Ward.D2 with cophenetic correlation and a
 * segment-mark dendrogram), Gaussian mixtures by EM (diagonal / full covariance, AIC / BIC ladder),
 * DBSCAN with a k-distance table, and a label-driven internal / external validation method.
 * Pure deterministic JavaScript: every stochastic step consumes the seeded generator from
 * ./extended-shared-numeric.cjs and the engine helper object `H`.
 */

const S = require("./extended-shared-numeric.cjs");

const FAMILY = "clustering";
const ORACLE_FILE = "contracts/clustering-scipy-crosscheck.py";
const MAX_ROWS = 2000;

// ---------------------------------------------------------------------------------------------
// Fixture: three Gaussian blobs in three variables (deterministic literal generation).
// ---------------------------------------------------------------------------------------------

function blobFixture() {
  const rng = S.createRng(20260902);
  const centers = [[0, 0, 0], [6, 6, 1.5], [12, 0, -1.5]];
  const spread = [0.8, 0.9, 0.7];
  const rows = [];
  const groups = [];
  centers.forEach((center, index) => {
    for (let i = 0; i < 12; i += 1) {
      rows.push(center.map((value) => S.round(value + spread[index] * rng.normal(), 4)));
      groups.push(`blob-${index + 1}`);
    }
  });
  const names = ["x1", "x2", "x3"];
  return {
    variables: names.map((name, column) => ({ name, values: rows.map((row) => row[column]) })),
    rowLabels: rows.map((_, index) => `obs-${index + 1}`),
    groups,
  };
}

const BLOBS = blobFixture();
const NOISE_ROWS = [[30, 30, 8], [-20, 25, -9], [25, -22, 12]];
const DBSCAN_FIXTURE = {
  variables: BLOBS.variables.map((variable, column) => ({ name: variable.name, values: [...variable.values, ...NOISE_ROWS.map((row) => row[column])] })),
  rowLabels: [...BLOBS.rowLabels, "far-1", "far-2", "far-3"],
};

// ---------------------------------------------------------------------------------------------
// Shared kernels.
// ---------------------------------------------------------------------------------------------

function parseMatrix(data, H, { minRows, minVariables = 1, maxVariables = 32 }) {
  return S.parseVariableMatrix(data, H, { minRows, minVariables, maxVariables, maxRows: MAX_ROWS });
}

function standardizeOption() {
  return { schema: { type: "boolean" }, default: false, parse(value, H, path) { if (typeof value !== "boolean") H.fail("STAT_INVALID_INPUT", `${path} must be boolean`); return value; } };
}

function booleanOption(defaultValue) {
  return { schema: { type: "boolean" }, default: defaultValue, parse(value, H, path) { if (typeof value !== "boolean") H.fail("STAT_INVALID_INPUT", `${path} must be boolean`); return value; } };
}

function integerOption(defaultValue, minimum, maximum) {
  return { schema: { type: "integer", minimum, maximum }, default: defaultValue, parse(value, H, path) { return H.integer(value, minimum, maximum, path); } };
}

function prepareRows(parsed, standardize, H) {
  const columns = parsed.variables.map((variable) => variable.values);
  const scaling = parsed.variables.map((variable) => {
    const mean = H.mean(variable.values);
    const sd = Math.sqrt(H.variance(variable.values));
    return { variable: variable.name, mean, sd, standardized: standardize };
  });
  const scaled = standardize ? columns.map((column, index) => column.map((value) => (value - scaling[index].mean) / scaling[index].sd)) : columns;
  const rows = S.columnsToRows(scaled);
  const rawRows = S.columnsToRows(columns);
  const sds = scaling.map((item) => item.sd);
  const scaleRatio = Math.max(...sds) / Math.min(...sds);
  return { rows, rawRows, scaling, scaleRatio };
}

function squaredDistance(a, b) {
  let total = 0;
  for (let index = 0; index < a.length; index += 1) {
    const delta = a[index] - b[index];
    total += delta * delta;
  }
  return total;
}

function fullDistanceMatrix(rows, budget) {
  const n = rows.length;
  const matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    budget.check(n);
    for (let j = i + 1; j < n; j += 1) {
      const distance = Math.sqrt(squaredDistance(rows[i], rows[j]));
      matrix[i][j] = distance;
      matrix[j][i] = distance;
    }
  }
  return matrix;
}

function centroidOf(rows, members) {
  const d = rows[0].length;
  const center = new Array(d).fill(0);
  for (const index of members) for (let axis = 0; axis < d; axis += 1) center[axis] += rows[index][axis];
  return center.map((value) => value / members.length);
}

function membersByLabel(labels, k) {
  const members = Array.from({ length: k }, () => []);
  labels.forEach((label, index) => { members[label].push(index); });
  return members;
}

function silhouetteValues(distances, labels, k, budget) {
  const n = labels.length;
  const members = membersByLabel(labels, k);
  const values = new Array(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    budget.check(n);
    const own = labels[i];
    if (members[own].length <= 1) { values[i] = 0; continue; }
    let a = 0;
    for (const j of members[own]) if (j !== i) a += distances[i][j];
    a /= members[own].length - 1;
    let b = Infinity;
    for (let cluster = 0; cluster < k; cluster += 1) {
      if (cluster === own || members[cluster].length === 0) continue;
      let total = 0;
      for (const j of members[cluster]) total += distances[i][j];
      total /= members[cluster].length;
      if (total < b) b = total;
    }
    values[i] = b === Infinity ? 0 : (b - a) / Math.max(a, b);
  }
  return values;
}

function calinskiHarabasz(rows, labels, k) {
  const n = rows.length;
  if (k < 2 || k >= n) return null;
  const members = membersByLabel(labels, k);
  const grand = centroidOf(rows, rows.map((_, index) => index));
  let between = 0;
  let within = 0;
  for (let cluster = 0; cluster < k; cluster += 1) {
    if (!members[cluster].length) continue;
    const center = centroidOf(rows, members[cluster]);
    between += members[cluster].length * squaredDistance(center, grand);
    for (const index of members[cluster]) within += squaredDistance(rows[index], center);
  }
  if (within <= 0) return null;
  return (between / (k - 1)) / (within / (n - k));
}

function daviesBouldin(rows, labels, k) {
  if (k < 2) return null;
  const members = membersByLabel(labels, k);
  const centers = members.map((list) => (list.length ? centroidOf(rows, list) : null));
  const scatter = members.map((list, cluster) => {
    if (!list.length) return 0;
    let total = 0;
    for (const index of list) total += Math.sqrt(squaredDistance(rows[index], centers[cluster]));
    return total / list.length;
  });
  let total = 0;
  let counted = 0;
  for (let i = 0; i < k; i += 1) {
    if (!centers[i]) continue;
    let worst = 0;
    for (let j = 0; j < k; j += 1) {
      if (i === j || !centers[j]) continue;
      const separation = Math.sqrt(squaredDistance(centers[i], centers[j]));
      if (separation === 0) return null;
      const ratio = (scatter[i] + scatter[j]) / separation;
      if (ratio > worst) worst = ratio;
    }
    total += worst;
    counted += 1;
  }
  return counted ? total / counted : null;
}

function dunnIndex(distances, labels, k) {
  if (k < 2) return null;
  const n = labels.length;
  let minBetween = Infinity;
  let maxWithin = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (labels[i] === labels[j]) { if (distances[i][j] > maxWithin) maxWithin = distances[i][j]; } else if (distances[i][j] < minBetween) minBetween = distances[i][j];
    }
  }
  if (!Number.isFinite(minBetween) || maxWithin <= 0) return null;
  return minBetween / maxWithin;
}

function rendererContract(H, rows, extra = {}) {
  return { name: "renderer exact-data contract", status: "verified", rows: rows.length, rowsHash: H.sha256(rows), ...extra };
}

function scalingRows(prepared) {
  return prepared.scaling.map((item) => ({ variable: item.variable, mean: item.mean, sd: item.sd, standardized: item.standardized }));
}

function scaleAssumption(prepared, standardize) {
  return {
    name: "variables on comparable scales (Euclidean geometry)",
    status: standardize ? "standardized_to_unit_variance" : prepared.scaleRatio > 10 ? "not_established" : "acknowledged",
    sdRatio: prepared.scaleRatio,
    detail: standardize ? "each variable was centred and divided by its sample standard deviation before clustering" : "raw variable scales are used; a large SD ratio lets the widest variable dominate the distances",
  };
}

// ---------------------------------------------------------------------------------------------
// k-means.
// ---------------------------------------------------------------------------------------------

function kMeansPlusPlus(rows, k, rng, budget) {
  const n = rows.length;
  const centers = [rows[rng.integer(n)].slice()];
  const closest = rows.map((row) => squaredDistance(row, centers[0]));
  while (centers.length < k) {
    budget.check(n);
    let total = 0;
    for (const value of closest) total += value;
    let pick = n - 1;
    if (total > 0) {
      const target = rng.uniform() * total;
      let cumulative = 0;
      for (let index = 0; index < n; index += 1) {
        cumulative += closest[index];
        if (target < cumulative) { pick = index; break; }
      }
    } else pick = rng.integer(n);
    const center = rows[pick].slice();
    centers.push(center);
    for (let index = 0; index < n; index += 1) {
      const distance = squaredDistance(rows[index], center);
      if (distance < closest[index]) closest[index] = distance;
    }
  }
  return centers;
}

function assignRows(rows, centers) {
  const labels = new Array(rows.length);
  let inertia = 0;
  for (let index = 0; index < rows.length; index += 1) {
    let best = 0;
    let bestDistance = Infinity;
    for (let cluster = 0; cluster < centers.length; cluster += 1) {
      const distance = squaredDistance(rows[index], centers[cluster]);
      if (distance < bestDistance) { bestDistance = distance; best = cluster; }
    }
    labels[index] = best;
    inertia += bestDistance;
  }
  return { labels, inertia };
}

function lloyd(rows, initialCenters, { maxIterations, tolerance, budget }) {
  const n = rows.length;
  const d = rows[0].length;
  let centers = initialCenters.map((center) => center.slice());
  let { labels, inertia } = assignRows(rows, centers);
  let iterations = 0;
  let converged = false;
  while (iterations < maxIterations) {
    budget.check(n * centers.length * d);
    iterations += 1;
    const sums = centers.map(() => new Array(d).fill(0));
    const counts = new Array(centers.length).fill(0);
    for (let index = 0; index < n; index += 1) {
      counts[labels[index]] += 1;
      for (let axis = 0; axis < d; axis += 1) sums[labels[index]][axis] += rows[index][axis];
    }
    let shift = 0;
    const next = centers.map((center, cluster) => {
      if (counts[cluster] === 0) {
        // relocate an empty cluster to the row farthest from its current centre (deterministic)
        let farthest = 0;
        let farthestDistance = -1;
        for (let index = 0; index < n; index += 1) {
          const distance = squaredDistance(rows[index], centers[labels[index]]);
          if (distance > farthestDistance) { farthestDistance = distance; farthest = index; }
        }
        return rows[farthest].slice();
      }
      return sums[cluster].map((value) => value / counts[cluster]);
    });
    for (let cluster = 0; cluster < centers.length; cluster += 1) shift = Math.max(shift, squaredDistance(next[cluster], centers[cluster]));
    centers = next;
    const assignment = assignRows(rows, centers);
    const changed = assignment.labels.some((label, index) => label !== labels[index]);
    labels = assignment.labels;
    inertia = assignment.inertia;
    if (!changed || shift <= tolerance) { converged = true; break; }
  }
  return { centers, labels, inertia, iterations, converged };
}

function runKMeans(rows, k, { seed, restarts, maxIterations, tolerance, budget }) {
  let best = null;
  const attempts = [];
  for (let restart = 0; restart < restarts; restart += 1) {
    const rng = S.createRng(seed + 1000003 * restart);
    const init = kMeansPlusPlus(rows, k, rng, budget);
    const fit = lloyd(rows, init, { maxIterations, tolerance, budget });
    attempts.push({ restart: restart + 1, inertia: fit.inertia, iterations: fit.iterations, converged: fit.converged });
    if (!best || fit.inertia < best.inertia - 1e-12 * Math.max(1, best.inertia)) best = { ...fit, restart: restart + 1 };
  }
  // canonical cluster numbering: order clusters by the first row index they contain
  const order = [];
  for (const label of best.labels) if (!order.includes(label)) order.push(label);
  for (let cluster = 0; cluster < k; cluster += 1) if (!order.includes(cluster)) order.push(cluster);
  const remap = new Map(order.map((label, index) => [label, index]));
  return { ...best, labels: best.labels.map((label) => remap.get(label)), centers: order.map((label) => best.centers[label]), attempts };
}

const kMeans = {
  method: "k_means",
  family: FAMILY,
  analysisModel: { families: ["pca"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["tolerance", "timeoutMs"],
  customOptions: {
    clusters: integerOption(3, 2, 20),
    restarts: integerOption(10, 1, 100),
    lloydIterations: integerOption(300, 1, 5000),
    elbowMaxClusters: integerOption(8, 2, 20),
    seed: S.seedOption(),
    standardize: standardizeOption(),
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["variables"],
    properties: {
      variables: { type: "array", minItems: 1, maxItems: 32, items: { type: "object", additionalProperties: false, required: ["values"], properties: { name: { type: "string", minLength: 1, maxLength: 128 }, values: { type: "array", minItems: 6, maxItems: MAX_ROWS, items: { type: "number" } } } } },
      rowLabels: { type: "array", minItems: 6, maxItems: MAX_ROWS, items: { type: "string", minLength: 1, maxLength: 128 } },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["variables", "rowLabels"], "data");
    const matrix = parseMatrix(data, H, { minRows: 6 });
    if (options.clusters >= matrix.rowCount) H.fail("STAT_INVALID_INPUT", "options.clusters must be smaller than the number of rows");
    if (options.elbowMaxClusters >= matrix.rowCount) H.fail("STAT_INVALID_INPUT", "options.elbowMaxClusters must be smaller than the number of rows");
    return matrix;
  },
  analyze(parsed, options, budget, H) {
    const prepared = prepareRows(parsed, options.standardize, H);
    const { rows } = prepared;
    const n = rows.length;
    const k = options.clusters;
    const names = parsed.variables.map((variable) => variable.name);
    const fitOptions = { seed: options.seed, restarts: options.restarts, maxIterations: options.lloydIterations, tolerance: options.tolerance, budget };
    const fit = runKMeans(rows, k, fitOptions);
    const distances = fullDistanceMatrix(rows, budget);
    const silhouettes = silhouetteValues(distances, fit.labels, k, budget);
    const members = membersByLabel(fit.labels, k);
    const meanSilhouette = H.mean(silhouettes);
    const ch = calinskiHarabasz(rows, fit.labels, k);
    const db = daviesBouldin(rows, fit.labels, k);
    const totalSs = (() => { const grand = centroidOf(rows, rows.map((_, index) => index)); let total = 0; for (const row of rows) total += squaredDistance(row, grand); return total; })();
    const assignmentRows = rows.map((row, index) => ({
      row: index + 1,
      label: parsed.rowLabels[index],
      cluster: fit.labels[index] + 1,
      distanceToCentre: Math.sqrt(squaredDistance(row, fit.centers[fit.labels[index]])),
      silhouette: silhouettes[index],
      ...Object.fromEntries(names.map((name, axis) => [name, prepared.rawRows[index][axis]])),
    }));
    const centreRows = fit.centers.map((center, cluster) => ({
      cluster: cluster + 1,
      size: members[cluster].length,
      withinSs: members[cluster].reduce((total, index) => total + squaredDistance(rows[index], center), 0),
      meanSilhouette: members[cluster].length ? H.mean(members[cluster].map((index) => silhouettes[index])) : 0,
      ...Object.fromEntries(names.map((name, axis) => [name, options.standardize ? center[axis] * prepared.scaling[axis].sd + prepared.scaling[axis].mean : center[axis]])),
      ...(options.standardize ? Object.fromEntries(names.map((name, axis) => [`${name}Standardized`, center[axis]])) : {}),
    }));
    const elbowRows = [];
    for (let candidate = 1; candidate <= options.elbowMaxClusters; candidate += 1) {
      budget.check(n * candidate);
      const candidateFit = candidate === k ? fit : runKMeans(rows, candidate, { ...fitOptions, seed: options.seed });
      const candidateSilhouette = candidate >= 2 ? H.mean(silhouetteValues(distances, candidateFit.labels, candidate, budget)) : null;
      elbowRows.push({
        clusters: candidate,
        inertia: candidateFit.inertia,
        explainedVarianceRatio: totalSs > 0 ? 1 - candidateFit.inertia / totalSs : null,
        silhouette: candidateSilhouette,
        calinskiHarabasz: calinskiHarabasz(rows, candidateFit.labels, candidate),
        daviesBouldin: daviesBouldin(rows, candidateFit.labels, candidate),
        selected: candidate === k,
      });
    }
    const bestSilhouetteK = elbowRows.filter((row) => row.silhouette !== null).reduce((best, row) => (best === null || row.silhouette > best.silhouette ? row : best), null);
    const displayX = names[0];
    const displayY = names.length > 1 ? names[1] : names[0];
    const restartRows = fit.attempts;
    const scaleRows = scalingRows(prepared);
    return {
      sample: { n, variables: names.length, clusters: k, restarts: options.restarts, standardized: options.standardize },
      estimates: [
        { name: "inertia (within-cluster sum of squares)", kind: "scalar", estimate: fit.inertia },
        { name: "explained variance ratio", kind: "scalar", estimate: totalSs > 0 ? 1 - fit.inertia / totalSs : null },
        { name: "mean silhouette", kind: "scalar", estimate: meanSilhouette },
        { name: "Calinski-Harabasz", kind: "scalar", estimate: ch },
        { name: "Davies-Bouldin", kind: "scalar", estimate: db },
        { name: "best restart", kind: "scalar", estimate: fit.restart },
        { name: "iterations of best restart", kind: "scalar", estimate: fit.iterations },
        { name: "centres", kind: "rows", rows: centreRows },
        { name: "assignments", kind: "rows", rows: assignmentRows },
        { name: "elbow", kind: "rows", rows: elbowRows },
        { name: "restarts", kind: "rows", rows: restartRows },
        { name: "scaling", kind: "rows", rows: scaleRows },
      ],
      tests: [],
      confidenceIntervals: [],
      effectSizes: [
        { name: "mean silhouette", estimate: meanSilhouette },
        { name: "explained variance ratio", estimate: totalSs > 0 ? 1 - fit.inertia / totalSs : null },
      ],
      assumptions: [
        scaleAssumption(prepared, options.standardize),
        { name: "roughly spherical, similarly sized clusters", status: "requires_design_review", detail: "k-means minimises squared Euclidean distance to centroids; elongated or unequal-density clusters are split or merged" },
        { name: "number of clusters is a modelling choice", status: "requires_design_review", detail: "the elbow table reports internal indices for candidate k; no index establishes the true number of clusters" },
      ],
      diagnostics: [
        { name: "convergence", status: fit.converged ? "converged" : "iteration_limit", iterations: fit.iterations, tolerance: options.tolerance, restarts: options.restarts, restartsAtBestInertia: restartRows.filter((row) => Math.abs(row.inertia - fit.inertia) <= 1e-9 * Math.max(1, fit.inertia)).length },
        { name: "initialization", status: "k_means_plus_plus_seeded", seed: options.seed, detail: "D^2 sampling from the seeded generator; restarts use seed + 1000003 * restartIndex" },
        { name: "empty clusters", status: centreRows.some((row) => row.size === 0) ? "present" : "none" },
        { name: "silhouette boundary", status: "internal_index", detail: "silhouette, Calinski-Harabasz, and Davies-Bouldin compare compactness to separation within this data set only; they do not test cluster existence" },
        { name: "elbow scan", status: "evaluated", candidates: elbowRows.length, bestSilhouetteClusters: bestSilhouetteK ? bestSilhouetteK.clusters : null },
        rendererContract(H, assignmentRows, { centreRowsHash: H.sha256(centreRows), elbowRowsHash: H.sha256(elbowRows) }),
      ],
      artifacts: [
        H.tableArtifact("k-means cluster centres", `Centres on the original scale for k = ${k}${options.standardized ? "" : ""}; within-cluster sums of squares are on the clustering scale.`, [{ key: "cluster", label: "Cluster", type: "number" }, { key: "size", label: "n", type: "number" }, { key: "withinSs", label: "Within SS", type: "number" }, { key: "meanSilhouette", label: "Mean silhouette", type: "number" }, ...names.map((name) => ({ key: name, label: name, type: "number" })), ...(options.standardize ? names.map((name) => ({ key: `${name}Standardized`, label: `${name} (z)`, type: "number" })) : [])], centreRows, ["Clusters are numbered by the first row they contain."], "kmeans-centre-table"),
        H.tableArtifact("k-means assignments", "Cluster membership, distance to the assigned centre (clustering scale), and per-row silhouette.", [{ key: "row", label: "Row", type: "number" }, { key: "label", label: "Label", type: "string" }, { key: "cluster", label: "Cluster", type: "number" }, { key: "distanceToCentre", label: "Distance to centre", type: "number" }, { key: "silhouette", label: "Silhouette", type: "number" }, ...names.map((name) => ({ key: name, label: name, type: "number" }))], assignmentRows, [], "kmeans-assignment-table"),
        H.tableArtifact("k-means elbow scan", "Inertia and internal validity indices for each candidate number of clusters (same seed and restarts).", [{ key: "clusters", label: "k", type: "number" }, { key: "inertia", label: "Inertia", type: "number" }, { key: "explainedVarianceRatio", label: "Explained variance", type: "number" }, { key: "silhouette", label: "Silhouette", type: "number" }, { key: "calinskiHarabasz", label: "Calinski-Harabasz", type: "number" }, { key: "daviesBouldin", label: "Davies-Bouldin", type: "number" }, { key: "selected", label: "Selected", type: "boolean" }], elbowRows, ["Silhouette and the indices are undefined for k = 1."], "kmeans-elbow-table"),
        H.tableArtifact("k-means restarts", "Inertia reached by each seeded k-means++ restart.", [{ key: "restart", label: "Restart", type: "number" }, { key: "inertia", label: "Inertia", type: "number" }, { key: "iterations", label: "Iterations", type: "number" }, { key: "converged", label: "Converged", type: "boolean" }], restartRows, [], "kmeans-restart-table"),
        H.tableArtifact("Variable scaling", "Means and standard deviations used (or not) to standardize the variables before clustering.", [{ key: "variable", label: "Variable", type: "string" }, { key: "mean", label: "Mean", type: "number" }, { key: "sd", label: "SD", type: "number" }, { key: "standardized", label: "Standardized", type: "boolean" }], scaleRows, [], "kmeans-scaling-table"),
        H.vegaArtifact("kmeans-cluster-scatter", `k-means clusters (k = ${k}) on ${displayX} and ${displayY}`, {
          layer: [
            { data: { values: assignmentRows }, mark: { type: "point", filled: true, size: 60, opacity: 0.85 }, encoding: { x: { field: displayX, type: "quantitative", title: displayX }, y: { field: displayY, type: "quantitative", title: displayY }, color: { field: "cluster", type: "nominal", title: "Cluster" }, tooltip: [{ field: "label" }, { field: "cluster" }, { field: "silhouette", format: ".3f" }] } },
            { data: { values: centreRows }, mark: { type: "point", shape: "diamond", size: 220, filled: true, stroke: "#1F1F1F", strokeWidth: 1.5 }, encoding: { x: { field: displayX, type: "quantitative" }, y: { field: displayY, type: "quantitative" }, color: { field: "cluster", type: "nominal", legend: null }, tooltip: [{ field: "cluster" }, { field: "size" }, { field: "withinSs", format: ".4g" }] } },
          ],
        }),
        H.vegaArtifact("kmeans-elbow-plot", "Inertia by number of clusters (elbow scan)", {
          data: { values: elbowRows },
          layer: [
            { mark: { type: "line", point: true, color: "#285F8F" }, encoding: { x: { field: "clusters", type: "quantitative", title: "Number of clusters k", axis: { tickMinStep: 1 } }, y: { field: "inertia", type: "quantitative", title: "Inertia (within-cluster SS)" }, tooltip: [{ field: "clusters" }, { field: "inertia", format: ".4g" }, { field: "silhouette", format: ".3f" }] } },
            { mark: { type: "point", filled: true, size: 160, color: "#B3261E" }, encoding: { x: { field: "clusters", type: "quantitative" }, y: { field: "inertia", type: "quantitative" }, opacity: { field: "selected", type: "nominal", scale: { domain: [false, true], range: [0, 1] }, legend: null } } },
          ],
        }),
        H.vegaArtifact("kmeans-silhouette-plot", "Silhouette by observation within cluster", {
          data: { values: assignmentRows },
          mark: { type: "bar" },
          encoding: { y: { field: "label", type: "nominal", sort: { field: "silhouette", order: "descending" }, title: null, axis: { labelLimit: 80 } }, x: { field: "silhouette", type: "quantitative", title: "Silhouette" }, color: { field: "cluster", type: "nominal", title: "Cluster" }, row: { field: "cluster", type: "nominal", title: "Cluster" }, tooltip: [{ field: "label" }, { field: "silhouette", format: ".3f" }] },
          resolve: { scale: { y: "independent" } },
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When observations must be partitioned into a stated number of compact groups on numeric variables and the partition has to be reproducible from a seed.",
    decision: "Which observations belong together, whether the chosen k is defensible against the elbow and silhouette scan, and whether the partition is stable across restarts.",
    mustShow: "Cluster centres and sizes, per-row assignments with silhouettes, the inertia/silhouette scan over candidate k, and the restart inertias.",
    userGoal: "Segment observations into interpretable groups without hand-tuning an unstable algorithm.",
    nextActions: [
      { trigger: "restarts-disagree-on-inertia", action: "increase-restarts-or-standardize-variables", reason: "Several local optima indicate weak cluster structure or dominant variable scales." },
      { trigger: "silhouette-below-threshold", action: "reconsider-k-or-use-density-or-model-based-clustering", reason: "Weak silhouettes mean the partition is not supported by the distance structure." },
      { trigger: "clusters-well-separated", action: "profile-clusters-and-validate-on-held-out-data", reason: "A compact partition still needs substantive validation before it drives decisions." },
    ],
  },
  fixture: { data: { variables: BLOBS.variables, rowLabels: BLOBS.rowLabels }, options: { clusters: 3, restarts: 10, seed: 11, elbowMaxClusters: 6 } },
  matlabParity: { taxonomyIds: ["matlab.stats.cluster-anomaly"] },
  coverage: {
    implementedBoundary: "Lloyd k-means with seeded k-means++ initialization and restarts, optional standardization, silhouette / Calinski-Harabasz / Davies-Bouldin indices, and an inertia scan over candidate k; no mini-batch, kernel, or constrained variants.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["best inertia against sklearn KMeans (objective comparison, both with restarts)", "silhouette, Calinski-Harabasz, and Davies-Bouldin for the emitted partition against sklearn", "centres recomputed from the emitted labels against numpy"], excludedOutputs: ["restart-by-restart inertia (initialization streams differ)", "elbow rows for k other than the selected k"] },
    diagnostic: { level: "method-specific-partial", emitted: ["convergence", "initialization", "empty clusters", "silhouette boundary", "elbow scan"], limitations: ["internal indices do not test whether clusters exist", "restart agreement is evidence of a stable optimum, not of a correct k"] },
    knownGaps: ["gap statistic and consensus clustering", "k-medoids / PAM", "mini-batch and kernel k-means"],
  },
};

// ---------------------------------------------------------------------------------------------
// Hierarchical agglomerative clustering.
// ---------------------------------------------------------------------------------------------

function agglomerate(distances, linkage, budget) {
  const n = distances.length;
  const active = new Map();
  const size = new Map();
  const dist = new Map();
  for (let i = 0; i < n; i += 1) { active.set(i, true); size.set(i, 1); dist.set(i, new Map()); }
  for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) { dist.get(i).set(j, distances[i][j]); dist.get(j).set(i, distances[i][j]); }
  const merges = [];
  let nextId = n;
  while (active.size > 1) {
    budget.check(active.size * active.size);
    let bestPair = null;
    let bestHeight = Infinity;
    const ids = [...active.keys()].sort((a, b) => a - b);
    for (let a = 0; a < ids.length; a += 1) {
      const rowDist = dist.get(ids[a]);
      for (let b = a + 1; b < ids.length; b += 1) {
        const value = rowDist.get(ids[b]);
        if (value < bestHeight) { bestHeight = value; bestPair = [ids[a], ids[b]]; }
      }
    }
    const [i, j] = bestPair;
    const ni = size.get(i);
    const nj = size.get(j);
    const merged = new Map();
    for (const k of ids) {
      if (k === i || k === j) continue;
      const nk = size.get(k);
      const dik = dist.get(i).get(k);
      const djk = dist.get(j).get(k);
      let value;
      if (linkage === "single") value = Math.min(dik, djk);
      else if (linkage === "complete") value = Math.max(dik, djk);
      else if (linkage === "average") value = (ni * dik + nj * djk) / (ni + nj);
      else value = Math.sqrt(Math.max(0, ((ni + nk) * dik * dik + (nj + nk) * djk * djk - nk * bestHeight * bestHeight) / (ni + nj + nk)));
      merged.set(k, value);
      dist.get(k).delete(i);
      dist.get(k).delete(j);
      dist.get(k).set(nextId, value);
    }
    active.delete(i);
    active.delete(j);
    dist.delete(i);
    dist.delete(j);
    active.set(nextId, true);
    size.set(nextId, ni + nj);
    dist.set(nextId, merged);
    merges.push({ step: merges.length + 1, id: nextId, left: i, right: j, height: bestHeight, size: ni + nj });
    nextId += 1;
  }
  return merges;
}

function leafOrder(merges, n) {
  const byId = new Map(merges.map((merge) => [merge.id, merge]));
  const order = [];
  const visit = (id) => {
    if (id < n) { order.push(id); return; }
    const merge = byId.get(id);
    visit(merge.left);
    visit(merge.right);
  };
  visit(merges.length ? merges[merges.length - 1].id : 0);
  return order;
}

function cutTree(merges, n, k) {
  const parent = Array.from({ length: n + merges.length }, (_, index) => index);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let step = 0; step < n - k; step += 1) {
    const merge = merges[step];
    parent[find(merge.left)] = merge.id;
    parent[find(merge.right)] = merge.id;
  }
  const roots = new Map();
  const labels = [];
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    if (!roots.has(root)) roots.set(root, roots.size);
    labels.push(roots.get(root));
  }
  return labels;
}

function pearson(x, y) {
  const n = x.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i += 1) { mx += x[i]; my += y[i]; }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) { const dx = x[i] - mx; const dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

function copheneticMatrix(merges, n) {
  const members = new Map();
  for (let i = 0; i < n; i += 1) members.set(i, [i]);
  const matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  for (const merge of merges) {
    const left = members.get(merge.left);
    const right = members.get(merge.right);
    for (const a of left) for (const b of right) { matrix[a][b] = merge.height; matrix[b][a] = merge.height; }
    members.set(merge.id, [...left, ...right]);
    members.delete(merge.left);
    members.delete(merge.right);
  }
  return matrix;
}

const hierarchicalClustering = {
  method: "hierarchical_clustering",
  family: FAMILY,
  analysisModel: { families: ["pca"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["timeoutMs"],
  customOptions: {
    linkage: { schema: { type: "string", enum: ["single", "complete", "average", "ward"] }, default: "ward", parse(value, H, path) { if (!["single", "complete", "average", "ward"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be single, complete, average, or ward`); return value; } },
    clusters: integerOption(3, 2, 20),
    standardize: standardizeOption(),
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["variables"],
    properties: {
      variables: { type: "array", minItems: 1, maxItems: 32, items: { type: "object", additionalProperties: false, required: ["values"], properties: { name: { type: "string", minLength: 1, maxLength: 128 }, values: { type: "array", minItems: 4, maxItems: 600, items: { type: "number" } } } } },
      rowLabels: { type: "array", minItems: 4, maxItems: 600, items: { type: "string", minLength: 1, maxLength: 128 } },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["variables", "rowLabels"], "data");
    const matrix = parseMatrix(data, H, { minRows: 4 });
    if (matrix.rowCount > 600) H.fail("STAT_LIMIT_EXCEEDED", "hierarchical clustering is limited to 600 rows");
    if (options.clusters >= matrix.rowCount) H.fail("STAT_INVALID_INPUT", "options.clusters must be smaller than the number of rows");
    return matrix;
  },
  analyze(parsed, options, budget, H) {
    const prepared = prepareRows(parsed, options.standardize, H);
    const { rows } = prepared;
    const n = rows.length;
    const names = parsed.variables.map((variable) => variable.name);
    const distances = fullDistanceMatrix(rows, budget);
    const merges = agglomerate(distances, options.linkage, budget);
    const cophenetic = copheneticMatrix(merges, n);
    const original = [];
    const coph = [];
    for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) { original.push(distances[i][j]); coph.push(cophenetic[i][j]); }
    const copheneticCorrelation = pearson(original, coph);
    const k = options.clusters;
    const labels = cutTree(merges, n, k);
    const silhouettes = silhouetteValues(distances, labels, k, budget);
    const members = membersByLabel(labels, k);
    const mergeRows = merges.map((merge) => ({ step: merge.step, clusterId: merge.id, left: merge.left, right: merge.right, leftLabel: merge.left < n ? parsed.rowLabels[merge.left] : `cluster ${merge.left}`, rightLabel: merge.right < n ? parsed.rowLabels[merge.right] : `cluster ${merge.right}`, height: merge.height, size: merge.size }));
    const order = leafOrder(merges, n);
    const position = new Map(order.map((index, place) => [index, place + 1]));
    const nodeX = new Map();
    const nodeHeight = new Map();
    for (let i = 0; i < n; i += 1) { nodeX.set(i, position.get(i)); nodeHeight.set(i, 0); }
    const segmentRows = [];
    for (const merge of merges) {
      const x1 = nodeX.get(merge.left);
      const x2 = nodeX.get(merge.right);
      const y1 = nodeHeight.get(merge.left);
      const y2 = nodeHeight.get(merge.right);
      segmentRows.push({ step: merge.step, segment: "left", x: x1, x2: x1, y: y1, y2: merge.height, height: merge.height });
      segmentRows.push({ step: merge.step, segment: "right", x: x2, x2, y: y2, y2: merge.height, height: merge.height });
      segmentRows.push({ step: merge.step, segment: "top", x: x1, x2, y: merge.height, y2: merge.height, height: merge.height });
      nodeX.set(merge.id, (x1 + x2) / 2);
      nodeHeight.set(merge.id, merge.height);
    }
    const cutHeight = merges[n - k - 1] ? (merges[n - k - 1].height + (merges[n - k] ? merges[n - k].height : merges[n - k - 1].height)) / 2 : null;
    const leafRows = order.map((index, place) => ({ position: place + 1, row: index + 1, label: parsed.rowLabels[index], cluster: labels[index] + 1, cutHeight }));
    const assignmentRows = rows.map((_, index) => ({ row: index + 1, label: parsed.rowLabels[index], cluster: labels[index] + 1, silhouette: silhouettes[index], dendrogramPosition: position.get(index) }));
    const clusterRows = members.map((list, cluster) => ({ cluster: cluster + 1, size: list.length, meanSilhouette: list.length ? H.mean(list.map((index) => silhouettes[index])) : 0, ...Object.fromEntries(names.map((name, axis) => [name, H.mean(list.map((index) => prepared.rawRows[index][axis]))])) }));
    const monotone = merges.every((merge, index) => index === 0 || merge.height >= merges[index - 1].height - 1e-12);
    return {
      sample: { n, variables: names.length, linkage: options.linkage, clusters: k, standardized: options.standardize },
      estimates: [
        { name: "cophenetic correlation", kind: "scalar", estimate: copheneticCorrelation },
        { name: "mean silhouette at cut", kind: "scalar", estimate: H.mean(silhouettes) },
        { name: "Calinski-Harabasz at cut", kind: "scalar", estimate: calinskiHarabasz(rows, labels, k) },
        { name: "Davies-Bouldin at cut", kind: "scalar", estimate: daviesBouldin(rows, labels, k) },
        { name: "cut height", kind: "scalar", estimate: cutHeight },
        { name: "merges", kind: "rows", rows: mergeRows },
        { name: "clusters", kind: "rows", rows: clusterRows },
        { name: "assignments", kind: "rows", rows: assignmentRows },
        { name: "dendrogramSegments", kind: "rows", rows: segmentRows },
        { name: "dendrogramLeaves", kind: "rows", rows: leafRows },
        { name: "scaling", kind: "rows", rows: scalingRows(prepared) },
      ],
      tests: [],
      confidenceIntervals: [],
      effectSizes: [{ name: "cophenetic correlation", estimate: copheneticCorrelation }, { name: "mean silhouette at cut", estimate: H.mean(silhouettes) }],
      assumptions: [
        scaleAssumption(prepared, options.standardize),
        { name: "Euclidean distance is meaningful for these variables", status: "requires_design_review" },
        { name: "linkage choice matches the expected cluster shape", status: "requires_design_review", detail: "single linkage chains, complete linkage compacts, average linkage balances, Ward (D2) minimises within-cluster variance increase" },
      ],
      diagnostics: [
        { name: "merge heights monotone", status: monotone ? "monotone" : "inversions_present", detail: monotone ? "no dendrogram inversions" : "centroid-like inversions detected; interpret the cut with care" },
        { name: "cophenetic fidelity", status: copheneticCorrelation >= 0.75 ? "acceptable" : "weak", estimate: copheneticCorrelation, detail: "correlation between the original distances and the heights at which pairs merge" },
        { name: "tie handling", status: "lowest_ids_first", detail: "equal merge heights are resolved by the lowest cluster ids; libraries may order tied merges differently" },
        { name: "cut", status: "evaluated", clusters: k, cutHeight },
        rendererContract(H, segmentRows, { assignmentRowsHash: H.sha256(assignmentRows), leafRowsHash: H.sha256(leafRows) }),
      ],
      artifacts: [
        H.tableArtifact("Agglomeration schedule", `${options.linkage} linkage merges in order; ids below n are rows (0-based), larger ids are earlier merges (n + step - 1).`, [{ key: "step", label: "Step", type: "number" }, { key: "clusterId", label: "New id", type: "number" }, { key: "left", label: "Left id", type: "number" }, { key: "right", label: "Right id", type: "number" }, { key: "leftLabel", label: "Left", type: "string" }, { key: "rightLabel", label: "Right", type: "string" }, { key: "height", label: "Height", type: "number" }, { key: "size", label: "Size", type: "number" }], mergeRows, ["Ward heights are on the Ward.D2 scale (Euclidean distances, not squared)."], "hclust-merge-table"),
        H.tableArtifact("Clusters at the cut", `Sizes, silhouettes, and variable means (original scale) for the ${k}-cluster cut.`, [{ key: "cluster", label: "Cluster", type: "number" }, { key: "size", label: "n", type: "number" }, { key: "meanSilhouette", label: "Mean silhouette", type: "number" }, ...names.map((name) => ({ key: name, label: name, type: "number" }))], clusterRows, [], "hclust-cluster-table"),
        H.tableArtifact("Hierarchical assignments", "Cluster label at the cut, silhouette, and dendrogram leaf position for each row.", [{ key: "row", label: "Row", type: "number" }, { key: "label", label: "Label", type: "string" }, { key: "cluster", label: "Cluster", type: "number" }, { key: "silhouette", label: "Silhouette", type: "number" }, { key: "dendrogramPosition", label: "Leaf position", type: "number" }], assignmentRows, [], "hclust-assignment-table"),
        H.tableArtifact("Dendrogram segments", "Line segments (x, x2, y, y2) that draw the dendrogram; leaf x positions follow the agglomeration order.", [{ key: "step", label: "Step", type: "number" }, { key: "segment", label: "Segment", type: "string" }, { key: "x", label: "x", type: "number" }, { key: "x2", label: "x2", type: "number" }, { key: "y", label: "y", type: "number" }, { key: "y2", label: "y2", type: "number" }, { key: "height", label: "Merge height", type: "number" }], segmentRows, [], "hclust-dendrogram-segment-table"),
        H.tableArtifact("Dendrogram leaves", "Leaf order of the dendrogram with the cluster label at the cut.", [{ key: "position", label: "Position", type: "number" }, { key: "row", label: "Row", type: "number" }, { key: "label", label: "Label", type: "string" }, { key: "cluster", label: "Cluster", type: "number" }, { key: "cutHeight", label: "Cut height", type: "number" }], leafRows, [], "hclust-leaf-table"),
        H.vegaArtifact("hclust-dendrogram", `Dendrogram (${options.linkage} linkage), cut at ${k} clusters`, {
          layer: [
            { data: { values: segmentRows }, mark: { type: "rule", strokeWidth: 1.5, color: "#3B3B3B" }, encoding: { x: { field: "x", type: "quantitative", title: null, axis: null }, x2: { field: "x2" }, y: { field: "y", type: "quantitative", title: "Merge height" }, y2: { field: "y2" }, tooltip: [{ field: "step" }, { field: "height", format: ".4g" }] } },
            { data: { values: leafRows }, mark: { type: "rule", strokeDash: [6, 4], color: "#B3261E" }, encoding: { y: { field: "cutHeight", type: "quantitative" } } },
            { data: { values: leafRows }, mark: { type: "text", angle: 270, align: "right", baseline: "middle", dy: 0, fontSize: 9 }, encoding: { x: { field: "position", type: "quantitative" }, y: { datum: 0 }, text: { field: "label" }, color: { field: "cluster", type: "nominal", title: "Cluster" } } },
          ],
        }),
        H.vegaArtifact("hclust-silhouette-plot", "Silhouette by observation at the cut", {
          data: { values: assignmentRows },
          mark: { type: "bar" },
          encoding: { y: { field: "label", type: "nominal", sort: { field: "silhouette", order: "descending" }, title: null, axis: { labelLimit: 80 } }, x: { field: "silhouette", type: "quantitative", title: "Silhouette" }, color: { field: "cluster", type: "nominal", title: "Cluster" }, row: { field: "cluster", type: "nominal", title: "Cluster" }, tooltip: [{ field: "label" }, { field: "silhouette", format: ".3f" }] },
          resolve: { scale: { y: "independent" } },
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When the nested structure of similarities matters, the number of clusters is not fixed in advance, or a dendrogram is needed to justify a cut.",
    decision: "Which linkage reproduces the distance structure (cophenetic correlation), where to cut, and which observations merge early versus late.",
    mustShow: "The agglomeration schedule with heights, the dendrogram, cophenetic correlation, and the assignments and silhouettes at the chosen cut.",
    userGoal: "Reveal hierarchical grouping and choose a defensible cut with visible evidence.",
    nextActions: [
      { trigger: "cophenetic-correlation-below-threshold", action: "try-average-or-complete-linkage-or-standardize", reason: "A weak cophenetic correlation means the tree distorts the original distances." },
      { trigger: "single-linkage-chaining", action: "switch-to-ward-or-average-linkage", reason: "Chaining produces one large cluster and many singletons." },
      { trigger: "clear-gap-in-merge-heights", action: "cut-at-the-gap-and-profile-clusters", reason: "A large jump in merge height is the usual visual justification for a cut." },
    ],
  },
  fixture: { data: { variables: BLOBS.variables, rowLabels: BLOBS.rowLabels }, options: { linkage: "ward", clusters: 3 } },
  matlabParity: { taxonomyIds: ["matlab.stats.cluster-anomaly"] },
  coverage: {
    implementedBoundary: "Agglomerative clustering on Euclidean distances with single, complete, average (UPGMA), and Ward.D2 linkage via Lance-Williams updates, cophenetic correlation, a k-cluster cut, and dendrogram segments; no centroid/median linkage, no alternative metrics.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["sorted merge heights against scipy linkage", "cophenetic correlation against scipy cophenet", "cut partition against scipy fcluster (partition equality)", "silhouette at the cut against sklearn"], excludedOutputs: ["dendrogram leaf order (library-specific)", "merge order among tied heights"] },
    diagnostic: { level: "method-specific-partial", emitted: ["merge heights monotone", "cophenetic fidelity", "tie handling", "cut"], limitations: ["no inferential test of cluster existence", "O(n^3) implementation limited to 600 rows"] },
    knownGaps: ["centroid and median linkage", "non-Euclidean metrics and precomputed distances", "dynamic tree cutting"],
  },
};

// ---------------------------------------------------------------------------------------------
// Gaussian mixture by EM.
// ---------------------------------------------------------------------------------------------

function logSumExp(values) {
  let max = -Infinity;
  for (const value of values) if (value > max) max = value;
  if (max === -Infinity) return -Infinity;
  let total = 0;
  for (const value of values) total += Math.exp(value - max);
  return max + Math.log(total);
}

function componentLogDensity(row, component, covarianceType) {
  const d = row.length;
  if (covarianceType === "diag") {
    let total = 0;
    for (let axis = 0; axis < d; axis += 1) {
      const delta = row[axis] - component.mean[axis];
      total += Math.log(2 * Math.PI * component.variance[axis]) + (delta * delta) / component.variance[axis];
    }
    return -0.5 * total;
  }
  const centered = row.map((value, axis) => value - component.mean[axis]);
  const solved = S.choleskySolve(component.cholesky, centered);
  let quadratic = 0;
  for (let axis = 0; axis < d; axis += 1) quadratic += centered[axis] * solved[axis];
  return -0.5 * (d * Math.log(2 * Math.PI) + component.logDeterminant + quadratic);
}

function mStep(rows, responsibilities, k, covarianceType, regularization, H) {
  const n = rows.length;
  const d = rows[0].length;
  const components = [];
  for (let component = 0; component < k; component += 1) {
    let weight = 0;
    const mean = new Array(d).fill(0);
    for (let index = 0; index < n; index += 1) {
      const r = responsibilities[index][component];
      weight += r;
      for (let axis = 0; axis < d; axis += 1) mean[axis] += r * rows[index][axis];
    }
    const nk = weight + 10 * Number.EPSILON;
    for (let axis = 0; axis < d; axis += 1) mean[axis] /= nk;
    if (covarianceType === "diag") {
      const variance = new Array(d).fill(0);
      for (let index = 0; index < n; index += 1) {
        const r = responsibilities[index][component];
        for (let axis = 0; axis < d; axis += 1) { const delta = rows[index][axis] - mean[axis]; variance[axis] += r * delta * delta; }
      }
      for (let axis = 0; axis < d; axis += 1) variance[axis] = variance[axis] / nk + regularization;
      components.push({ weight: weight / n, mean, variance });
    } else {
      const covariance = S.zeros(d, d);
      for (let index = 0; index < n; index += 1) {
        const r = responsibilities[index][component];
        const delta = rows[index].map((value, axis) => value - mean[axis]);
        for (let a = 0; a < d; a += 1) for (let b = 0; b < d; b += 1) covariance[a][b] += r * delta[a] * delta[b];
      }
      for (let a = 0; a < d; a += 1) { for (let b = 0; b < d; b += 1) covariance[a][b] /= nk; covariance[a][a] += regularization; }
      const cholesky = S.cholesky(covariance);
      if (!cholesky) H.fail("STAT_SINGULAR_FIT", "a mixture component covariance became singular; increase regularization or reduce components");
      components.push({ weight: weight / n, mean, covariance, cholesky, logDeterminant: S.choleskyLogDeterminant(cholesky) });
    }
  }
  return components;
}

function eStep(rows, components, covarianceType) {
  const n = rows.length;
  const responsibilities = new Array(n);
  let logLikelihood = 0;
  for (let index = 0; index < n; index += 1) {
    const logJoint = components.map((component) => Math.log(Math.max(component.weight, 1e-300)) + componentLogDensity(rows[index], component, covarianceType));
    const norm = logSumExp(logJoint);
    logLikelihood += norm;
    responsibilities[index] = logJoint.map((value) => Math.exp(value - norm));
  }
  return { responsibilities, logLikelihood };
}

function runEm(rows, k, { seed, restarts, maxIterations, tolerance, covarianceType, regularization, budget, H }) {
  const n = rows.length;
  let best = null;
  const attempts = [];
  for (let restart = 0; restart < restarts; restart += 1) {
    const restartSeed = seed + 7919 * restart;
    const init = runKMeans(rows, k, { seed: restartSeed, restarts: 1, maxIterations: 100, tolerance: 1e-8, budget });
    let responsibilities = init.labels.map((label) => Array.from({ length: k }, (_, component) => (component === label ? 1 : 0)));
    let components = mStep(rows, responsibilities, k, covarianceType, regularization, H);
    let previous = -Infinity;
    let logLikelihood = -Infinity;
    let iterations = 0;
    let converged = false;
    while (iterations < maxIterations) {
      budget.check(n * k * rows[0].length);
      iterations += 1;
      const e = eStep(rows, components, covarianceType);
      responsibilities = e.responsibilities;
      logLikelihood = e.logLikelihood;
      components = mStep(rows, responsibilities, k, covarianceType, regularization, H);
      if (Math.abs(logLikelihood - previous) / n < tolerance) { converged = true; break; }
      previous = logLikelihood;
    }
    const final = eStep(rows, components, covarianceType);
    attempts.push({ restart: restart + 1, logLikelihood: final.logLikelihood, iterations, converged });
    if (!best || final.logLikelihood > best.logLikelihood + 1e-12 * Math.max(1, Math.abs(best.logLikelihood))) {
      best = { components, responsibilities: final.responsibilities, logLikelihood: final.logLikelihood, iterations, converged, restart: restart + 1 };
    }
  }
  const labels = best.responsibilities.map((row) => row.indexOf(Math.max(...row)));
  const order = [];
  for (const label of labels) if (!order.includes(label)) order.push(label);
  for (let component = 0; component < k; component += 1) if (!order.includes(component)) order.push(component);
  const remap = new Map(order.map((label, index) => [label, index]));
  return {
    ...best,
    attempts,
    components: order.map((label) => best.components[label]),
    responsibilities: best.responsibilities.map((row) => order.map((label) => row[label])),
    labels: labels.map((label) => remap.get(label)),
  };
}

function mixtureParameterCount(k, d, covarianceType) {
  return (k - 1) + k * d + (covarianceType === "diag" ? k * d : k * d * (d + 1) / 2);
}

const gaussianMixture = {
  method: "gaussian_mixture",
  family: FAMILY,
  analysisModel: { families: ["pca"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["tolerance", "timeoutMs"],
  customOptions: {
    clusters: integerOption(2, 1, 12),
    covarianceType: { schema: { type: "string", enum: ["diag", "full"] }, default: "full", parse(value, H, path) { if (!["diag", "full"].includes(value)) H.fail("STAT_INVALID_INPUT", `${path} must be diag or full`); return value; } },
    restarts: integerOption(5, 1, 50),
    emIterations: integerOption(500, 1, 5000),
    maxComponents: integerOption(6, 1, 12),
    regularization: { schema: { type: "number", minimum: 0, maximum: 1 }, default: 1e-6, parse(value, H, path) { const number = H.finiteNumber(value, path); if (number < 0 || number > 1) H.fail("STAT_INVALID_INPUT", `${path} must be in [0, 1]`); return number; } },
    seed: S.seedOption(),
    standardize: standardizeOption(),
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["variables"],
    properties: {
      variables: { type: "array", minItems: 1, maxItems: 16, items: { type: "object", additionalProperties: false, required: ["values"], properties: { name: { type: "string", minLength: 1, maxLength: 128 }, values: { type: "array", minItems: 8, maxItems: MAX_ROWS, items: { type: "number" } } } } },
      rowLabels: { type: "array", minItems: 8, maxItems: MAX_ROWS, items: { type: "string", minLength: 1, maxLength: 128 } },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["variables", "rowLabels"], "data");
    const matrix = parseMatrix(data, H, { minRows: 8, maxVariables: 16 });
    const d = matrix.variables.length;
    const needed = Math.max(options.clusters, options.maxComponents) * (d + 1) + 1;
    if (matrix.rowCount < needed) H.fail("STAT_INSUFFICIENT_SAMPLE", `at least ${needed} rows are needed for ${Math.max(options.clusters, options.maxComponents)} components in ${d} dimensions`);
    return matrix;
  },
  analyze(parsed, options, budget, H) {
    const prepared = prepareRows(parsed, options.standardize, H);
    const { rows } = prepared;
    const n = rows.length;
    const d = rows[0].length;
    const k = options.clusters;
    const names = parsed.variables.map((variable) => variable.name);
    const emOptions = { seed: options.seed, restarts: options.restarts, maxIterations: options.emIterations, tolerance: options.tolerance, covarianceType: options.covarianceType, regularization: options.regularization, budget, H };
    const fit = runEm(rows, k, emOptions);
    const parameters = mixtureParameterCount(k, d, options.covarianceType);
    const aic = -2 * fit.logLikelihood + 2 * parameters;
    const bic = -2 * fit.logLikelihood + parameters * Math.log(n);
    const componentRows = fit.components.map((component, index) => ({
      component: index + 1,
      weight: component.weight,
      size: fit.labels.filter((label) => label === index).length,
      ...Object.fromEntries(names.map((name, axis) => [`${name}Mean`, component.mean[axis]])),
      ...Object.fromEntries(names.map((name, axis) => [`${name}Variance`, options.covarianceType === "diag" ? component.variance[axis] : component.covariance[axis][axis]])),
    }));
    const covarianceRows = [];
    fit.components.forEach((component, index) => {
      for (let a = 0; a < d; a += 1) {
        covarianceRows.push({ component: index + 1, variable: names[a], ...Object.fromEntries(names.map((name, b) => [name, options.covarianceType === "diag" ? (a === b ? component.variance[a] : 0) : component.covariance[a][b]])) });
      }
    });
    const assignmentRows = rows.map((row, index) => ({
      row: index + 1,
      label: parsed.rowLabels[index],
      component: fit.labels[index] + 1,
      maxResponsibility: fit.responsibilities[index][fit.labels[index]],
      entropy: -fit.responsibilities[index].reduce((total, r) => total + (r > 0 ? r * Math.log(r) : 0), 0),
      ...Object.fromEntries(fit.responsibilities[index].map((r, component) => [`responsibility${component + 1}`, r])),
      ...Object.fromEntries(names.map((name, axis) => [name, prepared.rawRows[index][axis]])),
    }));
    const selectionRows = [];
    for (let candidate = 1; candidate <= options.maxComponents; candidate += 1) {
      budget.check(n * candidate * d);
      const candidateFit = candidate === k ? fit : runEm(rows, candidate, emOptions);
      const p = mixtureParameterCount(candidate, d, options.covarianceType);
      selectionRows.push({ components: candidate, logLikelihood: candidateFit.logLikelihood, parameters: p, aic: -2 * candidateFit.logLikelihood + 2 * p, bic: -2 * candidateFit.logLikelihood + p * Math.log(n), converged: candidateFit.converged, selected: candidate === k });
    }
    const bestBic = selectionRows.reduce((best, row) => (best === null || row.bic < best.bic ? row : best), null);
    const bestAic = selectionRows.reduce((best, row) => (best === null || row.aic < best.aic ? row : best), null);
    const meanEntropy = H.mean(assignmentRows.map((row) => row.entropy));
    const icl = bic + 2 * n * meanEntropy;
    const displayX = names[0];
    const displayY = names.length > 1 ? names[1] : names[0];
    return {
      sample: { n, variables: d, components: k, covarianceType: options.covarianceType, restarts: options.restarts, standardized: options.standardize },
      estimates: [
        { name: "log-likelihood", kind: "scalar", estimate: fit.logLikelihood },
        { name: "AIC", kind: "scalar", estimate: aic },
        { name: "BIC", kind: "scalar", estimate: bic },
        { name: "ICL (BIC + 2 * total entropy)", kind: "scalar", estimate: icl },
        { name: "free parameters", kind: "scalar", estimate: parameters },
        { name: "best restart", kind: "scalar", estimate: fit.restart },
        { name: "components", kind: "rows", rows: componentRows },
        { name: "covariances", kind: "rows", rows: covarianceRows },
        { name: "assignments", kind: "rows", rows: assignmentRows },
        { name: "modelSelection", kind: "rows", rows: selectionRows },
        { name: "restarts", kind: "rows", rows: fit.attempts },
        { name: "scaling", kind: "rows", rows: scalingRows(prepared) },
      ],
      tests: [],
      confidenceIntervals: [],
      effectSizes: [{ name: "mean classification certainty (max responsibility)", estimate: H.mean(assignmentRows.map((row) => row.maxResponsibility)) }, { name: "mean assignment entropy", estimate: meanEntropy }],
      assumptions: [
        scaleAssumption(prepared, options.standardize),
        { name: "each component is multivariate normal", status: "requires_design_review", detail: `${options.covarianceType} covariance per component` },
        { name: "independent observations", status: "requires_design_review" },
      ],
      diagnostics: [
        { name: "EM convergence", status: fit.converged ? "converged" : "iteration_limit", iterations: fit.iterations, tolerance: options.tolerance, criterion: "change in mean log-likelihood per observation", restarts: options.restarts },
        { name: "initialization", status: "seeded_k_means", seed: options.seed, detail: "each restart initialises responsibilities from a seeded k-means++ / Lloyd partition" },
        { name: "regularization", status: options.regularization > 0 ? "applied" : "none", value: options.regularization, detail: "added to every covariance diagonal after each M-step" },
        { name: "model selection", status: "information_criteria", bestBicComponents: bestBic ? bestBic.components : null, bestAicComponents: bestAic ? bestAic.components : null, boundary: "BIC/AIC ladders compare fitted local optima; they are not likelihood-ratio tests of the number of components" },
        { name: "component degeneracy", status: componentRows.some((row) => row.size === 0) ? "empty_hard_assignment" : "none", detail: "a component with no hard assignments still contributes to the mixture density" },
        rendererContract(H, assignmentRows, { componentRowsHash: H.sha256(componentRows), selectionRowsHash: H.sha256(selectionRows) }),
      ],
      artifacts: [
        H.tableArtifact("Mixture components", `Weights, hard-assignment sizes, means, and variances (clustering scale) for ${k} ${options.covarianceType}-covariance components.`, [{ key: "component", label: "Component", type: "number" }, { key: "weight", label: "Weight", type: "number" }, { key: "size", label: "Hard n", type: "number" }, ...names.map((name) => ({ key: `${name}Mean`, label: `${name} mean`, type: "number" })), ...names.map((name) => ({ key: `${name}Variance`, label: `${name} variance`, type: "number" }))], componentRows, ["Components are numbered by the first row hard-assigned to them."], "gmm-component-table"),
        H.tableArtifact("Component covariances", "Covariance matrix rows per component (clustering scale, regularization included).", [{ key: "component", label: "Component", type: "number" }, { key: "variable", label: "Variable", type: "string" }, ...names.map((name) => ({ key: name, label: name, type: "number" }))], covarianceRows, [], "gmm-covariance-table"),
        H.tableArtifact("Mixture responsibilities", "Posterior component probabilities, hard assignment, and assignment entropy per row.", [{ key: "row", label: "Row", type: "number" }, { key: "label", label: "Label", type: "string" }, { key: "component", label: "Component", type: "number" }, { key: "maxResponsibility", label: "Max responsibility", type: "number" }, { key: "entropy", label: "Entropy", type: "number" }, ...Array.from({ length: k }, (_, component) => ({ key: `responsibility${component + 1}`, label: `P(comp ${component + 1})`, type: "number" })), ...names.map((name) => ({ key: name, label: name, type: "number" }))], assignmentRows, [], "gmm-assignment-table"),
        H.tableArtifact("Mixture model selection", "Log-likelihood, AIC, and BIC for each candidate number of components (same covariance type, seed, and restarts).", [{ key: "components", label: "Components", type: "number" }, { key: "logLikelihood", label: "Log-likelihood", type: "number" }, { key: "parameters", label: "Parameters", type: "number" }, { key: "aic", label: "AIC", type: "number" }, { key: "bic", label: "BIC", type: "number" }, { key: "converged", label: "Converged", type: "boolean" }, { key: "selected", label: "Selected", type: "boolean" }], selectionRows, ["Lower AIC/BIC is preferred; each row is the best of the seeded restarts."], "gmm-selection-table"),
        H.tableArtifact("EM restarts", "Log-likelihood reached by each seeded restart for the selected number of components.", [{ key: "restart", label: "Restart", type: "number" }, { key: "logLikelihood", label: "Log-likelihood", type: "number" }, { key: "iterations", label: "Iterations", type: "number" }, { key: "converged", label: "Converged", type: "boolean" }], fit.attempts, [], "gmm-restart-table"),
        H.vegaArtifact("gmm-assignment-scatter", `Gaussian mixture hard assignments (k = ${k}, ${options.covarianceType}) on ${displayX} and ${displayY}`, {
          data: { values: assignmentRows },
          mark: { type: "point", filled: true, size: 60 },
          encoding: { x: { field: displayX, type: "quantitative", title: displayX }, y: { field: displayY, type: "quantitative", title: displayY }, color: { field: "component", type: "nominal", title: "Component" }, opacity: { field: "maxResponsibility", type: "quantitative", scale: { domain: [0.5, 1], range: [0.25, 1] }, title: "Max responsibility" }, tooltip: [{ field: "label" }, { field: "component" }, { field: "maxResponsibility", format: ".3f" }] },
        }),
        H.vegaArtifact("gmm-bic-plot", "BIC and AIC by number of components", {
          data: { values: selectionRows },
          layer: [
            { mark: { type: "line", point: true, color: "#285F8F" }, encoding: { x: { field: "components", type: "quantitative", title: "Components", axis: { tickMinStep: 1 } }, y: { field: "bic", type: "quantitative", title: "Information criterion" }, tooltip: [{ field: "components" }, { field: "bic", format: ".5g" }, { field: "aic", format: ".5g" }] } },
            { mark: { type: "line", point: true, color: "#A36D47", strokeDash: [4, 3] }, encoding: { x: { field: "components", type: "quantitative" }, y: { field: "aic", type: "quantitative" } } },
            { mark: { type: "point", filled: true, size: 160, color: "#B3261E" }, encoding: { x: { field: "components", type: "quantitative" }, y: { field: "bic", type: "quantitative" }, opacity: { field: "selected", type: "nominal", scale: { domain: [false, true], range: [0, 1] }, legend: null } } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When clusters may overlap or have different shapes and sizes, and a probabilistic (soft) membership with a likelihood-based model comparison is required.",
    decision: "How many Gaussian components the data support (BIC/AIC), what each component looks like, and how confidently each observation is classified.",
    mustShow: "Component weights, means, and covariances, per-row responsibilities, the BIC/AIC ladder over candidate component counts, and restart log-likelihoods.",
    userGoal: "Obtain a model-based clustering with uncertainty instead of hard geometric assignment.",
    nextActions: [
      { trigger: "bic-minimum-at-different-k", action: "refit-with-bic-selected-components", reason: "The requested component count is not the one the information criterion prefers." },
      { trigger: "restarts-disagree-on-log-likelihood", action: "increase-restarts-or-regularization", reason: "EM found several local optima; the reported fit may not be the global one." },
      { trigger: "low-max-responsibilities", action: "report-soft-memberships-not-hard-labels", reason: "Overlapping components make hard assignment misleading." },
    ],
  },
  fixture: { data: { variables: BLOBS.variables, rowLabels: BLOBS.rowLabels }, options: { clusters: 3, covarianceType: "full", restarts: 5, seed: 3, maxComponents: 5 } },
  matlabParity: { taxonomyIds: ["matlab.stats.cluster-anomaly"] },
  coverage: {
    implementedBoundary: "Expectation-maximization for finite Gaussian mixtures with diagonal or full covariances, seeded k-means initialization and restarts, diagonal regularization, posterior responsibilities, and AIC/BIC/ICL over a component ladder; no tied or spherical covariances, no Bayesian or variational inference.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["log-likelihood of the emitted parameters against scipy multivariate_normal", "responsibilities recomputed from the emitted parameters against scipy", "best log-likelihood against sklearn GaussianMixture (objective comparison, both with restarts)", "AIC/BIC formulas against sklearn"], excludedOutputs: ["restart-by-restart log-likelihoods (initialization streams differ)", "ICL (no sklearn reference)"] },
    diagnostic: { level: "method-specific-partial", emitted: ["EM convergence", "initialization", "regularization", "model selection", "component degeneracy"], limitations: ["information criteria compare local optima", "no bootstrap likelihood-ratio test for the number of components"] },
    knownGaps: ["tied and spherical covariance structures", "bootstrap LRT for component count", "variational or Dirichlet-process mixtures"],
  },
};

// ---------------------------------------------------------------------------------------------
// DBSCAN.
// ---------------------------------------------------------------------------------------------

function dbscanLabels(distances, epsilon, minPoints) {
  const n = distances.length;
  const neighbors = distances.map((row) => { const list = []; for (let j = 0; j < n; j += 1) if (row[j] <= epsilon) list.push(j); return list; });
  const core = neighbors.map((list) => list.length >= minPoints);
  const labels = new Array(n).fill(-1);
  let cluster = 0;
  for (let i = 0; i < n; i += 1) {
    if (labels[i] !== -1 || !core[i]) continue;
    labels[i] = cluster;
    const queue = [i];
    while (queue.length) {
      const current = queue.shift();
      for (const j of neighbors[current]) {
        if (labels[j] !== -1) continue;
        labels[j] = cluster;
        if (core[j]) queue.push(j);
      }
    }
    cluster += 1;
  }
  return { labels, core, clusters: cluster, neighborCounts: neighbors.map((list) => list.length) };
}

const dbscan = {
  method: "dbscan",
  family: FAMILY,
  analysisModel: { families: ["pca"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["timeoutMs"],
  customOptions: {
    epsilon: { schema: { type: "number", exclusiveMinimum: 0 }, default: 1, parse(value, H, path) { const number = H.finiteNumber(value, path); if (number <= 0) H.fail("STAT_INVALID_INPUT", `${path} must be positive`); return number; } },
    minPoints: integerOption(5, 2, 200),
    standardize: standardizeOption(),
  },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["variables"],
    properties: {
      variables: { type: "array", minItems: 1, maxItems: 32, items: { type: "object", additionalProperties: false, required: ["values"], properties: { name: { type: "string", minLength: 1, maxLength: 128 }, values: { type: "array", minItems: 6, maxItems: MAX_ROWS, items: { type: "number" } } } } },
      rowLabels: { type: "array", minItems: 6, maxItems: MAX_ROWS, items: { type: "string", minLength: 1, maxLength: 128 } },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["variables", "rowLabels"], "data");
    const matrix = parseMatrix(data, H, { minRows: 6 });
    if (options.minPoints > matrix.rowCount) H.fail("STAT_INVALID_INPUT", "options.minPoints must not exceed the number of rows");
    return matrix;
  },
  analyze(parsed, options, budget, H) {
    const prepared = prepareRows(parsed, options.standardize, H);
    const { rows } = prepared;
    const n = rows.length;
    const names = parsed.variables.map((variable) => variable.name);
    const distances = fullDistanceMatrix(rows, budget);
    const result = dbscanLabels(distances, options.epsilon, options.minPoints);
    const kNeighbor = options.minPoints - 1;
    const kDistances = distances.map((row, index) => {
      const others = row.filter((_, j) => j !== index).sort((a, b) => a - b);
      return others[Math.min(kNeighbor, others.length) - 1];
    });
    const assignmentRows = rows.map((_, index) => ({
      row: index + 1,
      label: parsed.rowLabels[index],
      cluster: result.labels[index] === -1 ? 0 : result.labels[index] + 1,
      pointType: result.labels[index] === -1 ? "noise" : result.core[index] ? "core" : "border",
      neighborsWithinEpsilon: result.neighborCounts[index],
      kDistance: kDistances[index],
      ...Object.fromEntries(names.map((name, axis) => [name, prepared.rawRows[index][axis]])),
    }));
    const clusterRows = [];
    for (let cluster = 0; cluster < result.clusters; cluster += 1) {
      const members = result.labels.map((label, index) => (label === cluster ? index : -1)).filter((index) => index >= 0);
      clusterRows.push({ cluster: cluster + 1, size: members.length, corePoints: members.filter((index) => result.core[index]).length, borderPoints: members.filter((index) => !result.core[index]).length, ...Object.fromEntries(names.map((name, axis) => [name, H.mean(members.map((index) => prepared.rawRows[index][axis]))])) });
    }
    const noiseCount = result.labels.filter((label) => label === -1).length;
    const kDistanceRows = kDistances.map((value, index) => ({ label: parsed.rowLabels[index], kDistance: value })).sort((a, b) => b.kDistance - a.kDistance || (a.label < b.label ? -1 : 1)).map((row, rank) => ({ rank: rank + 1, ...row, epsilon: options.epsilon }));
    const clustered = result.labels.map((label, index) => (label >= 0 ? index : -1)).filter((index) => index >= 0);
    let silhouette = null;
    let silhouetteValuesByRow = null;
    if (result.clusters >= 2) {
      const subDistances = clustered.map((i) => clustered.map((j) => distances[i][j]));
      const subLabels = clustered.map((index) => result.labels[index]);
      const values = silhouetteValues(subDistances, subLabels, result.clusters, budget);
      silhouette = H.mean(values);
      silhouetteValuesByRow = values;
    }
    const displayX = names[0];
    const displayY = names.length > 1 ? names[1] : names[0];
    return {
      sample: { n, variables: names.length, epsilon: options.epsilon, minPoints: options.minPoints, clusters: result.clusters, noise: noiseCount, standardized: options.standardize },
      estimates: [
        { name: "clusters found", kind: "scalar", estimate: result.clusters },
        { name: "noise points", kind: "scalar", estimate: noiseCount },
        { name: "noise fraction", kind: "scalar", estimate: noiseCount / n },
        { name: "core points", kind: "scalar", estimate: result.core.filter(Boolean).length },
        { name: "mean silhouette of clustered points", kind: "scalar", estimate: silhouette },
        { name: "clusters", kind: "rows", rows: clusterRows },
        { name: "assignments", kind: "rows", rows: assignmentRows },
        { name: "kDistance", kind: "rows", rows: kDistanceRows },
        { name: "scaling", kind: "rows", rows: scalingRows(prepared) },
      ],
      tests: [],
      confidenceIntervals: [],
      effectSizes: [{ name: "noise fraction", estimate: noiseCount / n }, { name: "mean silhouette of clustered points", estimate: silhouette }],
      assumptions: [
        scaleAssumption(prepared, options.standardize),
        { name: "clusters are regions of similar density", status: "requires_design_review", detail: "a single epsilon cannot separate clusters of very different densities" },
      ],
      diagnostics: [
        { name: "cluster discovery", status: result.clusters === 0 ? "no_clusters_found" : "evaluated", clusters: result.clusters, detail: result.clusters === 0 ? "no point has minPoints neighbours within epsilon; use the k-distance table to choose epsilon" : "clusters are numbered by the order in which their first core point was reached" },
        { name: "k-distance", status: "evaluated", k: kNeighbor, detail: `distance to the ${kNeighbor}-th nearest other point; a point is core exactly when this distance is at most epsilon` },
        { name: "silhouette boundary", status: silhouette === null ? "not_evaluated" : "clustered_points_only", detail: "noise points are excluded; fewer than two clusters leave the silhouette undefined" },
        rendererContract(H, assignmentRows, { kDistanceRowsHash: H.sha256(kDistanceRows) }),
      ],
      artifacts: [
        H.tableArtifact("DBSCAN assignments", `Cluster (0 = noise), point type, neighbour count within epsilon = ${options.epsilon}, and k-distance per row.`, [{ key: "row", label: "Row", type: "number" }, { key: "label", label: "Label", type: "string" }, { key: "cluster", label: "Cluster", type: "number" }, { key: "pointType", label: "Type", type: "string" }, { key: "neighborsWithinEpsilon", label: "Neighbours", type: "number" }, { key: "kDistance", label: "k-distance", type: "number" }, ...names.map((name) => ({ key: name, label: name, type: "number" }))], assignmentRows, [], "dbscan-assignment-table"),
        H.tableArtifact("DBSCAN clusters", "Size, core and border counts, and variable means (original scale) per discovered cluster.", [{ key: "cluster", label: "Cluster", type: "number" }, { key: "size", label: "n", type: "number" }, { key: "corePoints", label: "Core", type: "number" }, { key: "borderPoints", label: "Border", type: "number" }, ...names.map((name) => ({ key: name, label: name, type: "number" }))], clusterRows, [], "dbscan-cluster-table"),
        H.tableArtifact("k-distance table", `Sorted distance to the ${kNeighbor}-th nearest other point (minPoints - 1) for choosing epsilon.`, [{ key: "rank", label: "Rank", type: "number" }, { key: "label", label: "Label", type: "string" }, { key: "kDistance", label: "k-distance", type: "number" }, { key: "epsilon", label: "Epsilon", type: "number" }], kDistanceRows, ["The knee of the sorted curve is the usual epsilon heuristic."], "dbscan-kdistance-table"),
        H.vegaArtifact("dbscan-cluster-scatter", `DBSCAN clusters (epsilon = ${options.epsilon}, minPoints = ${options.minPoints}) on ${displayX} and ${displayY}`, {
          data: { values: assignmentRows },
          mark: { type: "point", filled: true, size: 60 },
          encoding: { x: { field: displayX, type: "quantitative", title: displayX }, y: { field: displayY, type: "quantitative", title: displayY }, color: { field: "cluster", type: "nominal", title: "Cluster (0 = noise)" }, shape: { field: "pointType", type: "nominal", title: "Type" }, tooltip: [{ field: "label" }, { field: "cluster" }, { field: "pointType" }, { field: "kDistance", format: ".3f" }] },
        }),
        H.vegaArtifact("dbscan-kdistance-plot", "Sorted k-distance curve with the chosen epsilon", {
          data: { values: kDistanceRows },
          layer: [
            { mark: { type: "line", point: true, color: "#285F8F" }, encoding: { x: { field: "rank", type: "quantitative", title: "Points sorted by k-distance" }, y: { field: "kDistance", type: "quantitative", title: `Distance to ${kNeighbor}-th neighbour` }, tooltip: [{ field: "label" }, { field: "kDistance", format: ".3f" }] } },
            { mark: { type: "rule", strokeDash: [6, 4], color: "#B3261E" }, encoding: { y: { field: "epsilon", type: "quantitative" } } },
          ],
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When clusters have arbitrary shapes, the number of clusters is unknown, and observations that belong to no cluster (noise) must be identified rather than forced into a group.",
    decision: "Which dense regions form clusters at the chosen epsilon and minPoints, which observations are noise, and whether epsilon sits at the knee of the k-distance curve.",
    mustShow: "Per-row cluster and point type, cluster sizes with core/border counts, and the sorted k-distance curve with epsilon marked.",
    userGoal: "Find density-based groups and outliers without prescribing the number of clusters.",
    nextActions: [
      { trigger: "no-clusters-found-or-mostly-noise", action: "raise-epsilon-toward-the-k-distance-knee", reason: "Epsilon is below the typical neighbour distance, so few points are core." },
      { trigger: "single-giant-cluster", action: "lower-epsilon-or-raise-min-points", reason: "Epsilon bridges distinct dense regions, so one merged cluster hides the structure the analysis was run to find." },
      { trigger: "clusters-of-different-density", action: "use-hierarchical-density-clustering-outside-this-plugin", reason: "One epsilon cannot separate regions of very different density." },
    ],
  },
  fixture: { data: DBSCAN_FIXTURE, options: { epsilon: 2.2, minPoints: 4 } },
  matlabParity: { taxonomyIds: ["matlab.stats.cluster-anomaly"] },
  coverage: {
    implementedBoundary: "Exact DBSCAN on a dense Euclidean distance matrix (core / border / noise, clusters numbered by discovery order), a k-distance table, and silhouette of the clustered points; no OPTICS or HDBSCAN, no spatial indexing.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["cluster partition and noise set against sklearn DBSCAN", "core-point set against sklearn", "k-distances against sklearn NearestNeighbors"], excludedOutputs: ["border-point tie assignment order (implementation-specific when a border point touches two clusters)"] },
    diagnostic: { level: "method-specific-partial", emitted: ["cluster discovery", "k-distance", "silhouette boundary"], limitations: ["no automatic epsilon selection", "O(n^2) memory limits rows to 2000"] },
    knownGaps: ["OPTICS and HDBSCAN", "non-Euclidean metrics", "automatic epsilon selection from the k-distance knee"],
  },
};

// ---------------------------------------------------------------------------------------------
// Cluster validation for a supplied labelling.
// ---------------------------------------------------------------------------------------------

function contingency(a, b) {
  const rows = new Map();
  const colTotals = new Map();
  for (let index = 0; index < a.length; index += 1) {
    if (!rows.has(a[index])) rows.set(a[index], new Map());
    const row = rows.get(a[index]);
    row.set(b[index], (row.get(b[index]) || 0) + 1);
    colTotals.set(b[index], (colTotals.get(b[index]) || 0) + 1);
  }
  return { rows, colTotals };
}

function comb2(x) { return x * (x - 1) / 2; }

function adjustedRandIndex(a, b) {
  const { rows, colTotals } = contingency(a, b);
  const n = a.length;
  let sumCells = 0;
  let sumRows = 0;
  for (const row of rows.values()) {
    let total = 0;
    for (const count of row.values()) { sumCells += comb2(count); total += count; }
    sumRows += comb2(total);
  }
  let sumCols = 0;
  for (const count of colTotals.values()) sumCols += comb2(count);
  const expected = sumRows * sumCols / comb2(n);
  const maximum = (sumRows + sumCols) / 2;
  if (maximum === expected) return 1;
  return (sumCells - expected) / (maximum - expected);
}

function entropyOf(counts, n) {
  let total = 0;
  for (const count of counts) if (count > 0) total -= (count / n) * Math.log(count / n);
  return total;
}

function normalizedMutualInformation(a, b) {
  const { rows, colTotals } = contingency(a, b);
  const n = a.length;
  const rowTotals = new Map();
  for (const [key, row] of rows) { let total = 0; for (const count of row.values()) total += count; rowTotals.set(key, total); }
  let mutual = 0;
  for (const [key, row] of rows) for (const [col, count] of row) mutual += (count / n) * Math.log((count * n) / (rowTotals.get(key) * colTotals.get(col)));
  const ha = entropyOf([...rowTotals.values()], n);
  const hb = entropyOf([...colTotals.values()], n);
  const denominator = (ha + hb) / 2;
  return denominator === 0 ? 1 : mutual / denominator;
}

const clusterValidation = {
  method: "cluster_validation",
  family: FAMILY,
  analysisModel: { families: ["pca"], distributions: [null, "normal", "gaussian"], links: [null, "identity"] },
  optionKeys: ["timeoutMs"],
  customOptions: { standardize: standardizeOption() },
  dataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["variables", "labels"],
    properties: {
      variables: { type: "array", minItems: 1, maxItems: 32, items: { type: "object", additionalProperties: false, required: ["values"], properties: { name: { type: "string", minLength: 1, maxLength: 128 }, values: { type: "array", minItems: 4, maxItems: MAX_ROWS, items: { type: "number" } } } } },
      labels: { type: "array", minItems: 4, maxItems: MAX_ROWS, items: { type: "string", minLength: 1, maxLength: 128 } },
      referenceLabels: { type: "array", minItems: 4, maxItems: MAX_ROWS, items: { type: "string", minLength: 1, maxLength: 128 } },
      rowLabels: { type: "array", minItems: 4, maxItems: MAX_ROWS, items: { type: "string", minLength: 1, maxLength: 128 } },
    },
  },
  parse(data, options, H) {
    H.assertKeys(data, ["variables", "labels", "referenceLabels", "rowLabels"], "data");
    const matrix = parseMatrix(data, H, { minRows: 4 });
    const labels = H.categoryVector(data.labels, "data.labels", 4);
    if (labels.length !== matrix.rowCount) H.fail("STAT_INVALID_INPUT", "data.labels length must match the variable rows");
    const levels = [...new Set(labels)];
    if (levels.length < 2) H.fail("STAT_INVALID_INPUT", "data.labels must contain at least two distinct clusters");
    if (levels.length >= matrix.rowCount) H.fail("STAT_DEGENERATE", "every row is its own cluster");
    let reference = null;
    if (data.referenceLabels !== undefined) {
      reference = H.categoryVector(data.referenceLabels, "data.referenceLabels", 4);
      if (reference.length !== matrix.rowCount) H.fail("STAT_INVALID_INPUT", "data.referenceLabels length must match the variable rows");
    }
    return { ...matrix, labels, levels, reference };
  },
  analyze(parsed, options, budget, H) {
    const prepared = prepareRows(parsed, options.standardize, H);
    const { rows } = prepared;
    const n = rows.length;
    const k = parsed.levels.length;
    const names = parsed.variables.map((variable) => variable.name);
    const index = new Map(parsed.levels.map((level, position) => [level, position]));
    const labels = parsed.labels.map((label) => index.get(label));
    const distances = fullDistanceMatrix(rows, budget);
    const silhouettes = silhouetteValues(distances, labels, k, budget);
    const members = membersByLabel(labels, k);
    const ch = calinskiHarabasz(rows, labels, k);
    const db = daviesBouldin(rows, labels, k);
    const dunn = dunnIndex(distances, labels, k);
    const meanSilhouette = H.mean(silhouettes);
    const rowsOut = rows.map((_, i) => ({ row: i + 1, label: parsed.rowLabels[i], cluster: parsed.levels[labels[i]], silhouette: silhouettes[i], ...(parsed.reference ? { reference: parsed.reference[i] } : {}) }));
    const clusterRows = parsed.levels.map((level, cluster) => {
      const list = members[cluster];
      const center = centroidOf(rows, list);
      return { cluster: level, size: list.length, meanSilhouette: H.mean(list.map((i) => silhouettes[i])), minSilhouette: Math.min(...list.map((i) => silhouettes[i])), negativeSilhouettes: list.filter((i) => silhouettes[i] < 0).length, withinSs: list.reduce((total, i) => total + squaredDistance(rows[i], center), 0), ...Object.fromEntries(names.map((name, axis) => [name, H.mean(list.map((i) => prepared.rawRows[i][axis]))])) };
    });
    let external = null;
    let agreementRows = [];
    if (parsed.reference) {
      const ari = adjustedRandIndex(parsed.labels, parsed.reference);
      const nmi = normalizedMutualInformation(parsed.labels, parsed.reference);
      const { rows: table } = contingency(parsed.labels, parsed.reference);
      let purity = 0;
      for (const row of table.values()) purity += Math.max(...row.values());
      purity /= n;
      external = { adjustedRandIndex: ari, normalizedMutualInformation: nmi, purity };
      const referenceLevels = [...new Set(parsed.reference)];
      for (const level of parsed.levels) for (const ref of referenceLevels) agreementRows.push({ cluster: level, reference: ref, count: table.get(level)?.get(ref) || 0 });
    }
    const indexRows = [
      { index: "mean silhouette", value: meanSilhouette, direction: "higher is better", range: "[-1, 1]" },
      { index: "Calinski-Harabasz", value: ch, direction: "higher is better", range: "[0, inf)" },
      { index: "Davies-Bouldin", value: db, direction: "lower is better", range: "[0, inf)" },
      { index: "Dunn", value: dunn, direction: "higher is better", range: "[0, inf)" },
      ...(external ? [{ index: "adjusted Rand index", value: external.adjustedRandIndex, direction: "higher is better", range: "[-0.5, 1]" }, { index: "normalized mutual information", value: external.normalizedMutualInformation, direction: "higher is better", range: "[0, 1]" }, { index: "purity", value: external.purity, direction: "higher is better", range: "[0, 1]" }] : []),
    ];
    return {
      sample: { n, variables: names.length, clusters: k, referenceSupplied: Boolean(parsed.reference), standardized: options.standardize },
      estimates: [
        { name: "mean silhouette", kind: "scalar", estimate: meanSilhouette },
        { name: "Calinski-Harabasz", kind: "scalar", estimate: ch },
        { name: "Davies-Bouldin", kind: "scalar", estimate: db },
        { name: "Dunn", kind: "scalar", estimate: dunn },
        ...(external ? [{ name: "adjusted Rand index", kind: "scalar", estimate: external.adjustedRandIndex }, { name: "normalized mutual information", kind: "scalar", estimate: external.normalizedMutualInformation }, { name: "purity", kind: "scalar", estimate: external.purity }] : []),
        { name: "indices", kind: "rows", rows: indexRows },
        { name: "clusters", kind: "rows", rows: clusterRows },
        { name: "rows", kind: "rows", rows: rowsOut },
        { name: "agreement", kind: "rows", rows: agreementRows },
        { name: "scaling", kind: "rows", rows: scalingRows(prepared) },
      ],
      tests: [],
      confidenceIntervals: [],
      effectSizes: [{ name: "mean silhouette", estimate: meanSilhouette }, ...(external ? [{ name: "adjusted Rand index", estimate: external.adjustedRandIndex }] : [])],
      assumptions: [
        scaleAssumption(prepared, options.standardize),
        { name: "labels were produced independently of these indices", status: "requires_design_review", detail: "optimising an index and then reporting it on the same data overstates cluster quality" },
      ],
      diagnostics: [
        { name: "internal indices boundary", status: "internal_index", detail: "silhouette, Calinski-Harabasz, Davies-Bouldin, and Dunn describe compactness versus separation; none tests whether clusters exist" },
        { name: "external agreement", status: external ? "evaluated" : "not_evaluated", detail: external ? "adjusted Rand index (chance-corrected), NMI with arithmetic-mean normalization, and purity against the supplied reference" : "supply data.referenceLabels for chance-corrected agreement" },
        { name: "negative silhouettes", status: silhouettes.some((value) => value < 0) ? "present" : "none", count: silhouettes.filter((value) => value < 0).length },
        rendererContract(H, rowsOut, { clusterRowsHash: H.sha256(clusterRows), indexRowsHash: H.sha256(indexRows) }),
      ],
      artifacts: [
        H.tableArtifact("Cluster validity indices", "Internal indices for the supplied partition and, when a reference labelling is supplied, chance-corrected external agreement.", [{ key: "index", label: "Index", type: "string" }, { key: "value", label: "Value", type: "number" }, { key: "direction", label: "Direction", type: "string" }, { key: "range", label: "Range", type: "string" }], indexRows, [], "cluster-validation-index-table"),
        H.tableArtifact("Per-cluster validity", "Size, silhouette summaries, within-cluster sum of squares (clustering scale), and variable means (original scale).", [{ key: "cluster", label: "Cluster", type: "string" }, { key: "size", label: "n", type: "number" }, { key: "meanSilhouette", label: "Mean silhouette", type: "number" }, { key: "minSilhouette", label: "Min silhouette", type: "number" }, { key: "negativeSilhouettes", label: "Negative", type: "number" }, { key: "withinSs", label: "Within SS", type: "number" }, ...names.map((name) => ({ key: name, label: name, type: "number" }))], clusterRows, [], "cluster-validation-cluster-table"),
        H.tableArtifact("Per-row silhouettes", "Silhouette width for every row under the supplied labelling.", [{ key: "row", label: "Row", type: "number" }, { key: "label", label: "Label", type: "string" }, { key: "cluster", label: "Cluster", type: "string" }, { key: "silhouette", label: "Silhouette", type: "number" }, ...(parsed.reference ? [{ key: "reference", label: "Reference", type: "string" }] : [])], rowsOut, [], "cluster-validation-row-table"),
        ...(external ? [H.tableArtifact("Cluster versus reference", "Contingency counts between the supplied clusters and the reference labelling.", [{ key: "cluster", label: "Cluster", type: "string" }, { key: "reference", label: "Reference", type: "string" }, { key: "count", label: "Count", type: "number" }], agreementRows, [], "cluster-validation-agreement-table")] : []),
        H.vegaArtifact("cluster-validation-silhouette-plot", "Silhouette widths by cluster", {
          data: { values: rowsOut },
          mark: { type: "bar" },
          encoding: { y: { field: "label", type: "nominal", sort: { field: "silhouette", order: "descending" }, title: null, axis: { labelLimit: 80 } }, x: { field: "silhouette", type: "quantitative", title: "Silhouette width", scale: { domain: [-1, 1] } }, color: { field: "cluster", type: "nominal", title: "Cluster" }, row: { field: "cluster", type: "nominal", title: "Cluster" }, tooltip: [{ field: "label" }, { field: "silhouette", format: ".3f" }] },
          resolve: { scale: { y: "independent" } },
        }),
      ],
    };
  },
  linkage: {
    neededWhen: "When a partition produced elsewhere (or by another method here) must be judged for compactness, separation, and, if ground truth exists, agreement with a reference.",
    decision: "Whether the supplied clustering is internally coherent and how well it recovers a known labelling.",
    mustShow: "The index table with directions, per-cluster silhouette summaries, per-row silhouettes, and the contingency with the reference when available.",
    userGoal: "Quantify the quality of a clustering before acting on it, so a partition is reported as structure rather than as an artefact of the chosen k.",
    nextActions: [
      { trigger: "many-negative-silhouettes", action: "revisit-cluster-count-or-method", reason: "Rows closer to another cluster than their own signal a poor partition." },
      { trigger: "low-adjusted-rand-against-reference", action: "inspect-contingency-for-merged-or-split-classes", reason: "The contingency table shows which reference classes were merged or split." },
      { trigger: "indices-disagree", action: "report-all-indices-with-directions", reason: "Different indices reward different geometry; a single index can mislead." },
    ],
  },
  fixture: { data: { variables: BLOBS.variables, labels: BLOBS.groups, referenceLabels: BLOBS.groups.map((group, index) => (index % 12 === 11 ? "blob-1" : group)), rowLabels: BLOBS.rowLabels } },
  matlabParity: { taxonomyIds: ["matlab.stats.cluster-anomaly"] },
  coverage: {
    implementedBoundary: "Silhouette, Calinski-Harabasz, Davies-Bouldin, and Dunn indices for a supplied labelling on Euclidean distances, plus adjusted Rand index, arithmetic-normalized mutual information, and purity against an optional reference; no stability or bootstrap validation.",
    oracle: { level: "external-library-partial", evidence: [ORACLE_FILE], verifiedOutputs: ["silhouette (per row and mean) against sklearn", "Calinski-Harabasz and Davies-Bouldin against sklearn", "adjusted Rand index and NMI against sklearn", "Dunn index against numpy"], excludedOutputs: ["purity (no sklearn reference)"] },
    diagnostic: { level: "method-specific-partial", emitted: ["internal indices boundary", "external agreement", "negative silhouettes"], limitations: ["indices describe geometry, not cluster existence", "labels tuned on these indices are optimistically scored"] },
    knownGaps: ["stability and consensus indices", "gap statistic", "prediction-strength cross-validation"],
  },
};

module.exports = { methods: [kMeans, hierarchicalClustering, gaussianMixture, dbscan, clusterValidation] };
