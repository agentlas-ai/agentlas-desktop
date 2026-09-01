export const SCIENCE_EVIDENCE_GRAPH_SCHEMA = "agentlas.science.evidence-graph/v1" as const;
export const SCIENCE_EVIDENCE_GRAPH_REVIEW_SCHEMA = "agentlas.science.evidence-graph-inference-review/v1" as const;
export const SCIENCE_EVIDENCE_GRAPH_MAX_NODES = 5_000;
export const SCIENCE_EVIDENCE_GRAPH_MAX_EDGES = 20_000;
export const SCIENCE_EVIDENCE_GRAPH_MAX_CANDIDATES = 2_000;

export const SCIENCE_EVIDENCE_GRAPH_NODE_KINDS = [
  "research-question",
  "concept",
  "variable",
  "source-version",
  "evidence-span",
  "extracted-claim",
  "hypothesis",
  "analysis-plan-version",
  "research-run",
  "artifact-version",
  "episode-result",
  "inference-candidate",
  "conclusion",
  "manuscript-version",
  "manuscript-sentence",
  "manuscript-claim",
] as const;
export type ScienceEvidenceGraphNodeKind = typeof SCIENCE_EVIDENCE_GRAPH_NODE_KINDS[number];

export const SCIENCE_EVIDENCE_GRAPH_ASSERTION_KINDS = [
  "source-fact",
  "source-claim",
  "hypothesis",
  "computed-result",
  "inference",
  "conclusion",
] as const;
export type ScienceEvidenceGraphAssertionKind = typeof SCIENCE_EVIDENCE_GRAPH_ASSERTION_KINDS[number];

export const SCIENCE_EVIDENCE_GRAPH_EPISTEMIC_STATUSES = [
  "candidate",
  "supported",
  "contradicted",
  "mixed",
  "inconclusive",
  "invalidated",
] as const;
export type ScienceEvidenceGraphEpistemicStatus = typeof SCIENCE_EVIDENCE_GRAPH_EPISTEMIC_STATUSES[number];

export const SCIENCE_EVIDENCE_GRAPH_EDGE_KINDS = [
  "derived-from",
  "extracted-from",
  "cites",
  "supports",
  "contradicts",
  "qualifies",
  "tests",
  "operationalizes",
  "uses-input",
  "produced",
  "addresses",
  "supersedes",
  "invalidated-by",
  "identifies-gap",
] as const;
export type ScienceEvidenceGraphEdgeKind = typeof SCIENCE_EVIDENCE_GRAPH_EDGE_KINDS[number];

export type ScienceEvidenceGraphReviewStatus = "pending" | "accepted" | "rejected";
export type ScienceEvidenceGraphProducerKind = "agent" | "tool" | "human" | "system";
export type ScienceEvidenceGraphInferenceKind =
  | "evidence-gap"
  | "operationalization-gap"
  | "contradiction-candidate"
  | "qualification"
  | "conclusion-eligibility"
  | "cross-source-corroboration"
  | "hypothesis-proposal"
  | "user-proposed";

export const SCIENCE_EVIDENCE_GRAPH_CANONICAL_REF_KINDS = [
  "project",
  "source-version",
  "evidence-span",
  "message-block",
  "hypothesis",
  "analysis-plan-version",
  "research-run",
  "artifact-version",
  "episode-result",
  "research-lifecycle-revision",
  "artifact-validation-receipt",
  "graph-inference-candidate",
  "manuscript-version",
  "manuscript-sentence",
  "claim-ledger-claim",
] as const;
export type ScienceEvidenceGraphCanonicalRefKind = typeof SCIENCE_EVIDENCE_GRAPH_CANONICAL_REF_KINDS[number];

export interface ScienceEvidenceGraphCanonicalRef {
  kind: ScienceEvidenceGraphCanonicalRefKind;
  id: string;
  version: number;
  contentSha256: string;
}

export interface ScienceEvidenceGraphConditioningContext {
  population: string | null;
  interventionOrExposure: string | null;
  comparator: string | null;
  outcome: string | null;
  timeframe: string | null;
  method: string | null;
  datasetOrSetting: string | null;
}

export interface ScienceEvidenceGraphNode {
  id: string;
  projectId: string;
  kind: ScienceEvidenceGraphNodeKind;
  canonicalRef: ScienceEvidenceGraphCanonicalRef;
  assertionKind: ScienceEvidenceGraphAssertionKind;
  epistemicStatus: ScienceEvidenceGraphEpistemicStatus;
  label: string;
  statement: string;
  normalizedProposition: string | null;
  polarity: "supports" | "opposes" | "neutral" | null;
  conditioningContext: ScienceEvidenceGraphConditioningContext | null;
  evidenceScope: "metadata" | "abstract" | "full-text" | "computed" | "human" | "system";
  contentSha256: string;
}

export interface ScienceEvidenceGraphDerivation {
  parentNodeIds: string[];
  parentContentSha256: string[];
  ruleId: string;
  ruleVersion: string;
  producer: { kind: ScienceEvidenceGraphProducerKind; id: string };
  reviewStatus: ScienceEvidenceGraphReviewStatus;
  createdAt: string;
}

export interface ScienceEvidenceGraphEdge {
  id: string;
  projectId: string;
  kind: ScienceEvidenceGraphEdgeKind;
  fromNodeId: string;
  toNodeId: string;
  fromContentSha256: string;
  toContentSha256: string;
  evidencePathNodeIds: string[];
  derivation: ScienceEvidenceGraphDerivation;
  contentSha256: string;
}

export interface ScienceEvidenceGraphInferenceCandidate {
  id: string;
  projectId: string;
  kind: ScienceEvidenceGraphInferenceKind;
  nodeId: string;
  label: string;
  rationale: string;
  missingRequirements: string[];
  evidencePathNodeIds: string[];
  independentSourceVersionCount: number;
  coverage: number;
  relevance: number;
  assessmentConfidence: number;
  reviewStatus: ScienceEvidenceGraphReviewStatus;
  materializationProposal?: {
    statement: string;
    rationale: string;
    falsificationCriteria: string[];
    alternativeHypothesis: string;
  };
  contentSha256: string;
}

export interface ScienceEvidenceGraphSummary {
  nodeCounts: Record<ScienceEvidenceGraphNodeKind, number>;
  edgeCounts: Record<ScienceEvidenceGraphEdgeKind, number>;
  pendingInferenceCount: number;
  contradictionCandidateCount: number;
  evidenceGapCount: number;
  invalidatedNodeCount: number;
  unsupportedConclusionCount: number;
}

export interface ScienceEvidenceGraphRevision {
  schema: typeof SCIENCE_EVIDENCE_GRAPH_SCHEMA;
  id: string;
  projectId: string;
  revision: number;
  previousRevisionSha256: string | null;
  projectionSha256: string;
  nodes: ScienceEvidenceGraphNode[];
  edges: ScienceEvidenceGraphEdge[];
  inferenceCandidates: ScienceEvidenceGraphInferenceCandidate[];
  summary: ScienceEvidenceGraphSummary;
  createdAt: string;
  contentSha256: string;
}

export interface ScienceEvidenceGraphInferenceReview {
  schema: typeof SCIENCE_EVIDENCE_GRAPH_REVIEW_SCHEMA;
  id: string;
  projectId: string;
  graphRevisionId: string;
  graphRevisionSha256: string;
  candidateId: string;
  candidateContentSha256: string;
  revision: number;
  previousReviewSha256: string | null;
  decision: "accepted" | "rejected";
  rationale: string;
  reviewer: { kind: "human" | "agent"; id: string };
  createdAt: string;
  reviewSha256: string;
}

export interface ScienceEvidenceGraphBoundedSubgraph {
  schema: "agentlas.science.evidence-graph-bounded-context/v1";
  projectId: string;
  graphRevisionId: string;
  graphRevisionSha256: string;
  query: string;
  traversal: {
    seedMatcher: "hybrid-fts-token-ppr/v1";
    direction: "outgoing" | "incoming" | "both";
    edgeKinds: ScienceEvidenceGraphEdgeKind[];
    maxHops: number;
    budget: { maxSeeds: number; maxNodes: number; maxEdges: number };
    consumed: { seeds: number; nodes: number; edges: number; hops: number };
    truncated: boolean;
  };
  nodes: ScienceEvidenceGraphNode[];
  edges: ScienceEvidenceGraphEdge[];
  inferenceCandidates: Array<ScienceEvidenceGraphInferenceCandidate & {
    review: ScienceEvidenceGraphInferenceReview | null;
  }>;
  reviews: ScienceEvidenceGraphInferenceReview[];
  literatureChunks: import("./science-literature-chunks").ScienceSourceTextChunk[];
  chunkBindings: Array<{
    chunkId: string;
    chunkContentSha256: string;
    sourceVersionNodeId: string;
    evidenceSpanNodeIds: string[];
  }>;
  missing: string[];
  contentSha256: string;
}

export interface ScienceEvidenceGraphBoundedContextOptions {
  direction?: "outgoing" | "incoming" | "both";
  edgeKinds?: ScienceEvidenceGraphEdgeKind[];
  maxHops?: number;
  maxSeeds?: number;
  maxNodes?: number;
  maxEdges?: number;
}

export interface ScienceEvidenceGraphPathExplanation {
  schema: "agentlas.science.evidence-graph-path/v1";
  projectId: string;
  graphRevisionId: string;
  fromNodeId: string;
  toNodeId: string;
  found: boolean;
  nodeIds: string[];
  edgeIds: string[];
  blockedBy: string[];
  contentSha256: string;
}

export interface RefreshScienceEvidenceGraphInput {
  requestId: string;
  projectId: string;
  expectedRevision?: number | null;
  expectedContentSha256?: string | null;
}

export interface RefreshScienceEvidenceGraphResult {
  graph: ScienceEvidenceGraphRevision;
  replayed: boolean;
}

export interface ProposeScienceEvidenceGraphInferenceInput {
  requestId: string;
  projectId: string;
  expectedGraphRevision: number;
  expectedGraphContentSha256: string;
  label: string;
  statement: string;
  rationale: string;
  normalizedProposition: string;
  polarity: "supports" | "opposes" | "neutral";
  conditioningContext: ScienceEvidenceGraphConditioningContext;
  evidencePathNodeIds: string[];
  falsificationCriteria: string[];
  alternativeHypothesis: string;
  producer: { kind: "agent" | "human"; id: string };
}

export interface ReviewScienceEvidenceGraphInferenceInput {
  requestId: string;
  projectId: string;
  graphRevisionId: string;
  expectedGraphContentSha256: string;
  candidateId: string;
  expectedCandidateContentSha256: string;
  decision: "accepted" | "rejected";
  rationale: string;
  reviewer: { kind: "human" | "agent"; id: string };
}

export interface MaterializeScienceEvidenceGraphInferenceInput {
  requestId: string;
  projectId: string;
  graphRevisionId: string;
  expectedGraphContentSha256: string;
  candidateId: string;
  expectedCandidateContentSha256: string;
  expectedReviewSha256: string;
  contractId: string;
  role: "primary" | "alternative";
}

export interface ScienceEvidenceGraphInferenceMaterialization {
  schema: "agentlas.science.evidence-graph-inference-materialization/v1";
  id: string;
  projectId: string;
  graphRevisionId: string;
  graphRevisionSha256: string;
  candidateId: string;
  candidateContentSha256: string;
  reviewId: string;
  reviewSha256: string;
  target: { kind: "hypothesis"; id: string; version: number; contentSha256: string };
  createdAt: string;
  contentSha256: string;
}
