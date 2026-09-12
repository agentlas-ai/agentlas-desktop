/** Immutable product-owned source identity. Readiness needs separate receipts. */
export interface ArtifactRevisionV2 {
  schemaVersion: "agentlas.artifact-revision.v2";
  artifactId: string;
  owner: { product: "desktop"; chatId: string; projectId: string | null; agentId: string };
  revision: number;
  parentRevision: number | null;
  sourceDigest: string;
  dataDigest: string;
  stateSchemaDigest: string;
  status: "drafted" | "legacy-unverified";
  createdAt: string;
}
