import type {
  OneMemoryMapNode,
  OneMemoryMapSnapshot,
} from "@shared/one-memory-map";

export interface OneMemoryMapPlacedNode extends OneMemoryMapNode {
  clusterKey: string;
  cx: number;
  cy: number;
  size: number;
}

export interface OneMemoryMapLayout {
  nodes: OneMemoryMapPlacedNode[];
  fieldBlend: number;
  scalePercent: number;
  plot: { left: number; top: number; width: number; height: number };
}

interface Point { x: number; y: number }

interface ClusterLayout {
  key: string;
  nodes: OneMemoryMapNode[];
  offsets: Point[];
  centroid: Point;
  center: Point;
  desired: Point;
  radius: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function smoothstep(low: number, high: number, value: number): number {
  const t = clamp((value - low) / (high - low), 0, 1);
  return t * t * (3 - 2 * t);
}

function hashUnit(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function clusterKey(node: OneMemoryMapNode): string {
  return node.projectSlug ?? `one-${node.kind}`;
}

/** Rounded, deterministic lattice used for the option-2 memory islands. */
function compactOffsets(count: number): Point[] {
  if (count <= 0) return [];
  const extent = Math.ceil(Math.sqrt(count) * 1.15) + 2;
  const candidates: Array<Point & { order: number }> = [];
  for (let y = -extent; y <= extent; y += 1) {
    for (let x = -extent; x <= extent; x += 1) {
      const elliptical = Math.sqrt(x * x + y * y * 1.12);
      const edgeNoise = hashUnit(`${x}:${y}`) * 0.34;
      candidates.push({ x, y, order: elliptical + edgeNoise });
    }
  }
  candidates.sort((a, b) => a.order - b.order || a.y - b.y || a.x - b.x);
  return candidates.slice(0, count).map(({ x, y }) => ({ x, y }));
}

function globalGridPosition(
  node: OneMemoryMapNode,
  plot: OneMemoryMapLayout["plot"],
): Point {
  return {
    x: plot.left + node.x * plot.width,
    y: plot.top + node.y * plot.height,
  };
}

function nearestFreeGridCell(
  targetColumn: number,
  targetRow: number,
  columns: number,
  rows: number,
  occupied: Set<number>,
): { column: number; row: number } | null {
  const clampedColumn = clamp(targetColumn, 0, columns - 1);
  const clampedRow = clamp(targetRow, 0, rows - 1);
  const maxRadius = Math.max(columns, rows);
  for (let radius = 0; radius <= maxRadius; radius += 1) {
    const minX = Math.max(0, clampedColumn - radius);
    const maxX = Math.min(columns - 1, clampedColumn + radius);
    const minY = Math.max(0, clampedRow - radius);
    const maxY = Math.min(rows - 1, clampedRow + radius);
    for (let column = minX; column <= maxX; column += 1) {
      for (const row of radius === 0 ? [clampedRow] : [minY, maxY]) {
        const index = row * columns + column;
        if (!occupied.has(index)) return { column, row };
      }
    }
    for (let row = minY + 1; row < maxY; row += 1) {
      for (const column of [minX, maxX]) {
        const index = row * columns + column;
        if (!occupied.has(index)) return { column, row };
      }
    }
  }
  return null;
}

function separateClusters(
  clusters: ClusterLayout[],
  plot: OneMemoryMapLayout["plot"],
  islandGap: number,
): void {
  if (clusters.length === 0) return;
  const largest = clusters[0];
  for (let iteration = 0; iteration < 90; iteration += 1) {
    for (let leftIndex = 0; leftIndex < clusters.length; leftIndex += 1) {
      const left = clusters[leftIndex];
      for (let rightIndex = leftIndex + 1; rightIndex < clusters.length; rightIndex += 1) {
        const right = clusters[rightIndex];
        const dx = right.center.x - left.center.x;
        const dy = right.center.y - left.center.y;
        const distance = Math.max(0.001, Math.hypot(dx, dy));
        const required = left.radius + right.radius + islandGap;
        if (distance >= required) continue;
        const push = (required - distance) * 0.52;
        const ux = dx / distance || Math.cos((leftIndex + 1) * 2.399);
        const uy = dy / distance || Math.sin((rightIndex + 1) * 2.399);
        if (left !== largest) {
          left.center.x -= ux * push * 0.5;
          left.center.y -= uy * push * 0.5;
        }
        right.center.x += ux * push * (left === largest ? 1 : 0.5);
        right.center.y += uy * push * (left === largest ? 1 : 0.5);
      }
    }
    for (const cluster of clusters) {
      if (cluster === largest) {
        cluster.center.x = plot.left + plot.width / 2;
        cluster.center.y = plot.top + plot.height / 2;
      } else {
        cluster.center.x += (cluster.desired.x - cluster.center.x) * 0.022;
        cluster.center.y += (cluster.desired.y - cluster.center.y) * 0.022;
      }
      cluster.center.x = clamp(cluster.center.x, plot.left + cluster.radius, plot.left + plot.width - cluster.radius);
      cluster.center.y = clamp(cluster.center.y, plot.top + cluster.radius, plot.top + plot.height - cluster.radius);
    }
  }
}

export function layoutOneMemoryMap(
  snapshot: OneMemoryMapSnapshot,
  width: number,
  height: number,
): OneMemoryMapLayout {
  const plot = {
    left: 22,
    top: 56,
    width: Math.max(80, width - 44),
    height: Math.max(80, height - 82),
  };
  const count = snapshot.nodes.length;
  if (count === 0) return { nodes: [], fieldBlend: 0, scalePercent: 100, plot };

  // At today's few-hundred scale this is option 2. From 320 memories onward
  // the fit changes continuously; around 1,800 it has become option 3's field.
  const fieldBlend = smoothstep(320, 1_800, count);
  const viewportScale = clamp(Math.sqrt((width * height) / (1_020 * 560)), 0.76, 1.12);
  const nominalSize = 9.2 * viewportScale * (1 - 0.43 * fieldBlend);
  const veryLargeScale = count > 1_800 ? Math.pow(1_800 / count, 0.26) : 1;
  const desiredGap = Math.max(0.7, 1.7 - fieldBlend * 0.95);
  const capacitySize = Math.sqrt((plot.width * plot.height) / Math.max(1, count * 1.12)) - desiredGap;
  const cellSize = clamp(Math.min(nominalSize * veryLargeScale, capacitySize), 2.4, 10.4);
  const pitch = cellSize + desiredGap;

  const grouped = new Map<string, OneMemoryMapNode[]>();
  for (const node of snapshot.nodes) {
    const key = clusterKey(node);
    const group = grouped.get(key) ?? [];
    group.push(node);
    grouped.set(key, group);
  }
  const clusters: ClusterLayout[] = [...grouped.entries()].map(([key, nodes]) => {
    const offsets = compactOffsets(nodes.length);
    const centroid = {
      x: nodes.reduce((sum, node) => sum + node.x, 0) / nodes.length,
      y: nodes.reduce((sum, node) => sum + node.y, 0) / nodes.length,
    };
    const maxOffset = offsets.reduce((maximum, point) => Math.max(maximum, Math.hypot(point.x, point.y)), 0);
    return {
      key,
      nodes: [...nodes].sort((a, b) => b.density - a.density || a.id.localeCompare(b.id)),
      offsets,
      centroid,
      center: { x: 0, y: 0 },
      desired: { x: 0, y: 0 },
      radius: (maxOffset + 1) * pitch,
    };
  }).sort((a, b) => b.nodes.length - a.nodes.length || a.key.localeCompare(b.key));

  const center = { x: plot.left + plot.width / 2, y: plot.top + plot.height / 2 };
  const semanticOrder = clusters.slice(1).sort((left, right) => {
    const leftAngle = Math.atan2(left.centroid.y - 0.5, left.centroid.x - 0.5);
    const rightAngle = Math.atan2(right.centroid.y - 0.5, right.centroid.x - 0.5);
    return leftAngle - rightAngle || left.key.localeCompare(right.key);
  });
  const semanticIndex = new Map(semanticOrder.map((cluster, index) => [cluster.key, index]));
  for (const [index, cluster] of clusters.entries()) {
    const order = semanticIndex.get(cluster.key) ?? 0;
    const angle = -Math.PI / 2 + (order / Math.max(1, semanticOrder.length)) * Math.PI * 2;
    // The semantic projection owns clockwise order. A deterministic staggered
    // radius uses the whole plane instead of collapsing close centroids into a
    // small knot around the largest island.
    const radial = 0.62 + (((order * 7) % 5) / 4) * 0.34;
    const desired = index === 0
      ? { ...center }
      : {
          x: center.x + Math.cos(angle) * plot.width * 0.44 * radial,
          y: center.y + Math.sin(angle) * plot.height * 0.43 * radial,
        };
    cluster.desired = desired;
    cluster.center = { ...desired };
  }
  separateClusters(clusters, plot, Math.max(8, 28 * (1 - fieldBlend)));

  const lowPositions = new Map<string, Point>();
  for (const cluster of clusters) {
    cluster.nodes.forEach((node, index) => {
      const offset = cluster.offsets[index] ?? { x: 0, y: 0 };
      lowPositions.set(node.id, {
        x: cluster.center.x + offset.x * pitch,
        y: cluster.center.y + offset.y * pitch,
      });
    });
  }

  const blendedTargets = snapshot.nodes.map((node) => {
    const low = lowPositions.get(node.id) ?? globalGridPosition(node, plot);
    const high = globalGridPosition(node, plot);
    return {
      node,
      target: {
        x: low.x + (high.x - low.x) * fieldBlend,
        y: low.y + (high.y - low.y) * fieldBlend,
      },
    };
  }).sort((a, b) => b.node.density - a.node.density || a.node.id.localeCompare(b.node.id));

  const columns = Math.max(1, Math.floor(plot.width / pitch));
  const rows = Math.max(1, Math.floor(plot.height / pitch));
  const occupied = new Set<number>();
  const placed = new Map<string, Point>();
  for (const item of blendedTargets) {
    const column = Math.round((item.target.x - plot.left) / pitch);
    const row = Math.round((item.target.y - plot.top) / pitch);
    const cell = nearestFreeGridCell(column, row, columns, rows, occupied);
    if (!cell) continue;
    occupied.add(cell.row * columns + cell.column);
    placed.set(item.node.id, {
      x: plot.left + cell.column * pitch + cellSize / 2,
      y: plot.top + cell.row * pitch + cellSize / 2,
    });
  }

  return {
    fieldBlend,
    scalePercent: Math.round(clamp((cellSize / Math.max(0.001, 9.2 * viewportScale)) * 100, 20, 100)),
    plot,
    nodes: snapshot.nodes.flatMap((node) => {
      const point = placed.get(node.id);
      return point ? [{ ...node, clusterKey: clusterKey(node), cx: point.x, cy: point.y, size: cellSize }] : [];
    }),
  };
}
