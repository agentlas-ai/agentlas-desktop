/** Type surface for the CommonJS Experience Map core (see experience-map-core.cjs). */

export interface ExperienceMapCoreNode {
  id: string;
  kind: string;
  label?: string;
  ref?: string | null;
}

export interface ExperienceMapCoreEdge {
  id: string;
  from: string;
  to: string;
  kind: string;
  status: string;
}

export interface ExperienceMapCluster {
  id: string;
  memberIds: string[];
  count: number;
  anchorTaskNodeId: string | null;
  anchorTaskRef: string | null;
  anchorLabel: string | null;
  kindKey: string | null;
  keywords: string[];
  isRoot: boolean;
}

export interface ExperienceMapClustering {
  assignment: Map<string, string>;
  clusters: ExperienceMapCluster[];
}

export interface ExperienceMapLayout {
  positions: Map<string, [number, number, number]>;
  clusterGeometry: Map<string, { centroid: [number, number, number]; radius: number }>;
  extent: number;
  depthSpan: number;
}

export type ExperienceMapLabelMode = "cluster" | "major" | "all";

export function computeExperienceClusters(
  nodes: ExperienceMapCoreNode[],
  edges: ExperienceMapCoreEdge[],
  rootId: string,
): ExperienceMapClustering;

export function computeExperienceMapLayout(
  nodes: ExperienceMapCoreNode[],
  edges: ExperienceMapCoreEdge[],
  clustering: ExperienceMapClustering,
  rootId: string,
): ExperienceMapLayout;

export function graphContentHash(
  nodes: ExperienceMapCoreNode[],
  edges: Array<Pick<ExperienceMapCoreEdge, "from" | "to" | "kind" | "status">>,
): string;

export function labelModeForDistance(cameraDistance: number, extent: number): ExperienceMapLabelMode;

export function fnv1a(text: string): number;
export function mulberry32(seed: number): () => number;
