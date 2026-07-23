"use strict";

/**
 * Experience Map core — deterministic clustering + layout for the local 3D
 * experience graph. No LLM, no server, no external graph library: the inputs
 * already carry the needed signals (task-taxonomy nodes, node kinds,
 * similar_to edges).
 *
 * Everything in this file is a pure function of its inputs with a fixed seed,
 * so cluster assignment and node coordinates are stable across sessions and
 * unit-testable as snapshots. It is CommonJS on purpose: the renderer imports
 * it through webpack and `scripts/test-experience-map-clustering.cjs` requires
 * it directly under node.
 */

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Kinds treated as "experience items/chips" for first-pass task assignment. */
const ITEM_KINDS = new Set(["experience-item", "taste-draft", "hub-operational", "hub-taste"]);

/** FNV-1a 32-bit hash — the only randomness source (as a fixed seed). */
function fnv1a(text) {
  let hash = 2166136261;
  const value = String(text);
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Deterministic PRNG (mulberry32). */
function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Stable content hash of a graph, used as the coordinate-cache key so a
 * revisit with an unchanged graph reuses the exact same coordinates.
 */
function graphContentHash(nodes, edges) {
  const nodeKey = nodes.map((node) => `${node.id}${node.kind}`).sort(compareAscii).join("");
  const edgeKey = edges.map((edge) => `${edge.from}${edge.to}${edge.kind}${edge.status}`)
    .sort(compareAscii)
    .join("");
  return `${fnv1a(nodeKey).toString(16)}-${fnv1a(edgeKey).toString(16)}-${nodes.length}-${edges.length}`;
}

const LABEL_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "that", "this", "when", "then",
  "저장", "확인", "경험", "관련", "위한", "대한", "하는", "합니다", "했다",
]);

function topKeywords(labels, limit) {
  const counts = new Map();
  for (const label of labels) {
    const tokens = String(label ?? "")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length >= 2 && !LABEL_STOPWORDS.has(token));
    for (const token of new Set(tokens)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || compareAscii(left[0], right[0]))
    .slice(0, limit)
    .map(([token]) => token);
}

/**
 * Deterministic cluster assignment.
 *
 * 1. Every experience-item/chip node joins the task-taxonomy node it is most
 *    connected to (tie → lexicographically smallest task node id).
 * 2. Unassigned nodes take the majority cluster of their neighbors
 *    (similar_to / contains relations are just edges here), over three
 *    deterministic sweeps.
 * 3. Anything still unassigned falls back to its kind bucket.
 *
 * @param {Array<{id:string, kind:string, label?:string, ref?:string|null}>} nodes
 * @param {Array<{id:string, from:string, to:string, kind:string, status:string}>} edges
 * @param {string} rootId
 */
function computeExperienceClusters(nodes, edges, rootId) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const sortedNodes = [...nodes].sort((left, right) => compareAscii(left.id, right.id));
  const neighbors = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of [...edges].sort((left, right) => compareAscii(left.id, right.id))) {
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue;
    neighbors.get(edge.from).push({ id: edge.to, kind: edge.kind });
    neighbors.get(edge.to).push({ id: edge.from, kind: edge.kind });
  }

  const assignment = new Map();
  const taskClusterId = (taskNodeId) => `cluster:task:${taskNodeId}`;

  // Task-taxonomy nodes anchor their own clusters.
  for (const node of sortedNodes) {
    if (node.kind === "task") assignment.set(node.id, taskClusterId(node.id));
  }
  if (nodeById.has(rootId)) assignment.set(rootId, "cluster:root");

  // Pass 1 — items/chips to their most-connected task node.
  for (const node of sortedNodes) {
    if (assignment.has(node.id) || !ITEM_KINDS.has(node.kind)) continue;
    const taskCounts = new Map();
    for (const neighbor of neighbors.get(node.id) ?? []) {
      if (nodeById.get(neighbor.id)?.kind !== "task") continue;
      taskCounts.set(neighbor.id, (taskCounts.get(neighbor.id) ?? 0) + 1);
    }
    if (taskCounts.size === 0) continue;
    const best = [...taskCounts.entries()]
      .sort((left, right) => right[1] - left[1] || compareAscii(left[0], right[0]))[0][0];
    assignment.set(node.id, taskClusterId(best));
  }

  // Pass 2 — neighbor majority vote, three deterministic sweeps.
  for (let sweep = 0; sweep < 3; sweep += 1) {
    const votesThisSweep = new Map();
    for (const node of sortedNodes) {
      if (assignment.has(node.id)) continue;
      const votes = new Map();
      for (const neighbor of neighbors.get(node.id) ?? []) {
        const cluster = assignment.get(neighbor.id);
        if (!cluster || cluster === "cluster:root") continue;
        votes.set(cluster, (votes.get(cluster) ?? 0) + 1);
      }
      if (votes.size === 0) continue;
      const best = [...votes.entries()]
        .sort((left, right) => right[1] - left[1] || compareAscii(left[0], right[0]))[0][0];
      votesThisSweep.set(node.id, best);
    }
    if (votesThisSweep.size === 0) break;
    for (const [nodeId, cluster] of votesThisSweep) assignment.set(nodeId, cluster);
  }

  // Pass 3 — kind bucket fallback.
  for (const node of sortedNodes) {
    if (!assignment.has(node.id)) assignment.set(node.id, `cluster:kind:${node.kind}`);
  }

  // Cluster summaries.
  const memberIdsByCluster = new Map();
  for (const node of sortedNodes) {
    const cluster = assignment.get(node.id);
    if (!memberIdsByCluster.has(cluster)) memberIdsByCluster.set(cluster, []);
    memberIdsByCluster.get(cluster).push(node.id);
  }
  const clusters = [...memberIdsByCluster.entries()]
    .map(([id, memberIds]) => {
      const anchorTaskNodeId = id.startsWith("cluster:task:") ? id.slice("cluster:task:".length) : null;
      const anchorNode = anchorTaskNodeId ? nodeById.get(anchorTaskNodeId) ?? null : null;
      const kindKey = id.startsWith("cluster:kind:") ? id.slice("cluster:kind:".length) : null;
      // Cluster labels are computed here (once per graph snapshot), never at
      // render time. Anchor clusters read the task node; anonymous clusters
      // fall back to the two most frequent member-title keywords.
      const keywords = anchorNode
        ? []
        : topKeywords(memberIds.map((memberId) => nodeById.get(memberId)?.label ?? ""), 2);
      return {
        id,
        memberIds,
        count: memberIds.length,
        anchorTaskNodeId,
        anchorTaskRef: anchorNode?.ref ?? null,
        anchorLabel: anchorNode?.label ?? null,
        kindKey,
        keywords,
        isRoot: id === "cluster:root",
      };
    })
    .sort((left, right) => right.count - left.count || compareAscii(left.id, right.id));

  return { assignment, clusters };
}

/**
 * Deterministic layout: cluster centroids on a 3D ring, then a fixed-seed
 * force relaxation inside each cluster (pairwise repulsion + edge springs +
 * centroid gravity). Coordinates are a pure function of the graph, so the
 * same graph renders in the same place in every session.
 */
function computeExperienceMapLayout(nodes, edges, clustering, rootId) {
  const { assignment, clusters } = clustering;
  const nodeIds = new Set(nodes.map((node) => node.id));
  const positions = new Map();
  const ringClusters = clusters.filter((cluster) => !cluster.isRoot);
  const nodeCount = nodes.length;
  const ringRadius = Math.min(26, 3.4 + Math.sqrt(Math.max(1, nodeCount)) * 0.9 + ringClusters.length * 0.35);

  const centroids = new Map();
  centroids.set("cluster:root", [0, 0, 0]);
  ringClusters.forEach((cluster, index) => {
    // The 0.65 rad offset keeps small cluster counts (1–2) off the z=0 plane
    // so the scene always has real depth around the centered root node.
    const angle = (index / Math.max(1, ringClusters.length)) * Math.PI * 2 + 0.65;
    const y = Math.sin(index * GOLDEN_ANGLE) * ringRadius * 0.24;
    centroids.set(cluster.id, [Math.cos(angle) * ringRadius, y, Math.sin(angle) * ringRadius]);
  });

  // Seeded initial placement around each centroid.
  const sortedNodes = [...nodes].sort((left, right) => compareAscii(left.id, right.id));
  for (const cluster of clusters) {
    const centroid = centroids.get(cluster.id) ?? [0, 0, 0];
    const random = mulberry32(fnv1a(`layout:${cluster.id}`));
    const spread = 0.7 + Math.sqrt(cluster.count) * 0.55;
    for (const memberId of cluster.memberIds) {
      if (memberId === rootId) {
        positions.set(memberId, [0, 0, 0]);
        continue;
      }
      if (cluster.anchorTaskNodeId === memberId) {
        positions.set(memberId, [centroid[0], centroid[1], centroid[2]]);
        continue;
      }
      const theta = random() * Math.PI * 2;
      const phi = Math.acos(2 * random() - 1);
      const radius = spread * (0.35 + 0.65 * random());
      positions.set(memberId, [
        centroid[0] + Math.sin(phi) * Math.cos(theta) * radius,
        centroid[1] + Math.cos(phi) * radius * 0.7,
        centroid[2] + Math.sin(phi) * Math.sin(theta) * radius,
      ]);
    }
  }

  // Force relaxation with a fixed iteration budget (deterministic order).
  const iterations = nodeCount > 240 ? 60 : 130;
  const validEdges = edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  const membersByCluster = clusters.map((cluster) => cluster.memberIds.filter((id) => id !== rootId));
  for (let step = 0; step < iterations; step += 1) {
    const forces = new Map();
    const addForce = (id, x, y, z) => {
      const force = forces.get(id);
      if (force) {
        force[0] += x;
        force[1] += y;
        force[2] += z;
      } else {
        forces.set(id, [x, y, z]);
      }
    };

    // Same-cluster pairwise repulsion.
    for (let clusterIndex = 0; clusterIndex < clusters.length; clusterIndex += 1) {
      const members = membersByCluster[clusterIndex];
      for (let a = 0; a < members.length; a += 1) {
        const pa = positions.get(members[a]);
        for (let b = a + 1; b < members.length; b += 1) {
          const pb = positions.get(members[b]);
          let dx = pa[0] - pb[0];
          let dy = pa[1] - pb[1];
          let dz = pa[2] - pb[2];
          let distSq = dx * dx + dy * dy + dz * dz;
          if (distSq < 1e-6) {
            // Deterministic tiny separation for coincident points.
            const jitter = (fnv1a(members[a] + members[b]) % 1000) / 1000 - 0.5;
            dx = 0.01 + jitter * 0.01;
            dy = jitter * 0.01;
            dz = 0.01 - jitter * 0.01;
            distSq = dx * dx + dy * dy + dz * dz;
          }
          const magnitude = Math.min(0.6, 0.55 / distSq);
          const dist = Math.sqrt(distSq);
          const fx = (dx / dist) * magnitude;
          const fy = (dy / dist) * magnitude;
          const fz = (dz / dist) * magnitude;
          addForce(members[a], fx, fy, fz);
          addForce(members[b], -fx, -fy, -fz);
        }
      }
    }

    // Edge springs — intra-cluster tight, inter-cluster loose.
    for (const edge of validEdges) {
      if (edge.from === rootId || edge.to === rootId) continue;
      const pa = positions.get(edge.from);
      const pb = positions.get(edge.to);
      if (!pa || !pb) continue;
      const sameCluster = assignment.get(edge.from) === assignment.get(edge.to);
      const rest = sameCluster ? 1.7 : ringRadius * 0.9;
      const strength = sameCluster ? 0.05 : 0.004;
      const dx = pb[0] - pa[0];
      const dy = pb[1] - pa[1];
      const dz = pb[2] - pa[2];
      const dist = Math.max(0.001, Math.sqrt(dx * dx + dy * dy + dz * dz));
      const magnitude = strength * (dist - rest);
      const fx = (dx / dist) * magnitude;
      const fy = (dy / dist) * magnitude;
      const fz = (dz / dist) * magnitude;
      addForce(edge.from, fx, fy, fz);
      addForce(edge.to, -fx, -fy, -fz);
    }

    // Centroid gravity keeps clusters compact and separated.
    for (let clusterIndex = 0; clusterIndex < clusters.length; clusterIndex += 1) {
      const centroid = centroids.get(clusters[clusterIndex].id) ?? [0, 0, 0];
      for (const memberId of membersByCluster[clusterIndex]) {
        const point = positions.get(memberId);
        const anchor = clusters[clusterIndex].anchorTaskNodeId === memberId ? 0.2 : 0.07;
        addForce(
          memberId,
          (centroid[0] - point[0]) * anchor,
          (centroid[1] - point[1]) * anchor,
          (centroid[2] - point[2]) * anchor,
        );
      }
    }

    const damping = 0.85 * (1 - step / (iterations * 1.35));
    for (const node of sortedNodes) {
      if (node.id === rootId) continue;
      const force = forces.get(node.id);
      if (!force) continue;
      const point = positions.get(node.id);
      point[0] += Math.max(-1.2, Math.min(1.2, force[0])) * damping;
      point[1] += Math.max(-1.2, Math.min(1.2, force[1])) * damping;
      point[2] += Math.max(-1.2, Math.min(1.2, force[2])) * damping;
    }
  }

  // Round to a fixed precision so serialized snapshots are stable.
  for (const point of positions.values()) {
    point[0] = Math.round(point[0] * 10000) / 10000;
    point[1] = Math.round(point[1] * 10000) / 10000;
    point[2] = Math.round(point[2] * 10000) / 10000;
  }

  const clusterGeometry = new Map();
  for (const cluster of clusters) {
    if (cluster.isRoot) continue;
    const centroid = centroids.get(cluster.id);
    let radius = 0.8;
    for (const memberId of cluster.memberIds) {
      const point = positions.get(memberId);
      if (!point) continue;
      const dx = point[0] - centroid[0];
      const dy = point[1] - centroid[1];
      const dz = point[2] - centroid[2];
      radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    clusterGeometry.set(cluster.id, {
      centroid: centroid.map((value) => Math.round(value * 10000) / 10000),
      radius: Math.round((radius + 0.9) * 10000) / 10000,
    });
  }

  let extent = 1;
  let zMin = 0;
  let zMax = 0;
  for (const point of positions.values()) {
    extent = Math.max(extent, Math.sqrt(point[0] * point[0] + point[1] * point[1] + point[2] * point[2]) + 0.8);
    zMin = Math.min(zMin, point[2]);
    zMax = Math.max(zMax, point[2]);
  }

  return {
    positions,
    clusterGeometry,
    extent: Math.round(extent * 10000) / 10000,
    depthSpan: Math.round((zMax - zMin) * 10000) / 10000,
  };
}

/**
 * Obsidian-style zoom label density: far → cluster labels only, mid → only
 * high-degree node labels, near → every node label.
 */
function labelModeForDistance(cameraDistance, extent) {
  const safeExtent = Math.max(1, extent);
  if (cameraDistance > safeExtent * 1.5) return "cluster";
  if (cameraDistance > safeExtent * 0.85) return "major";
  return "all";
}

module.exports = {
  computeExperienceClusters,
  computeExperienceMapLayout,
  graphContentHash,
  labelModeForDistance,
  fnv1a,
  mulberry32,
};
