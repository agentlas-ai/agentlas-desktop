export const ONE_MEMORY_MAP_CONTRACT_VERSION = "1.0.0" as const;

export type OneMemoryMapKind =
  | "fact"
  | "decision"
  | "preference"
  | "risk"
  | "procedure"
  | "hypothesis"
  | "evidence"
  | "deprecation"
  | "conflict";

export type OneMemoryMapScope =
  | "user_identity"
  | "team_memory"
  | "agent_repo"
  | "agent_team"
  | "project"
  | "session";

export type OneMemoryMapRelation = "similar_to" | "supersedes" | "contradicts";

/**
 * Renderer-safe durable-memory projection. The content, raw evidence, absolute
 * workspace path, embedding vector, and owner identifiers stay in Main.
 */
export interface OneMemoryMapNode {
  id: string;
  kind: OneMemoryMapKind;
  scope: OneMemoryMapScope;
  projectSlug: string | null;
  /** Principal-component coordinates, normalized to [0, 1]. */
  x: number;
  y: number;
  /** Relation-weighted local density, normalized to [0, 1]. */
  density: number;
  relationCount: number;
  evidenceCount: number;
}

export interface OneMemoryMapEdge {
  from: string;
  to: string;
  relation: OneMemoryMapRelation;
  score: number | null;
}

export interface OneMemoryMapSnapshot {
  contractVersion: typeof ONE_MEMORY_MAP_CONTRACT_VERSION;
  generatedAt: string;
  /** Opaque digest for renderer identity checks; contains no local path. */
  sourceRevision: string;
  nodes: OneMemoryMapNode[];
  edges: OneMemoryMapEdge[];
  clusterCount: number;
}
