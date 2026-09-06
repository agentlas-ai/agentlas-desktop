import { createHash, randomUUID } from "node:crypto";
import type { ScienceArtifact, ScienceHypothesis, ScienceResearchRun, ScienceSourceVersion } from "../../shared/science-contract";
import type {
  ProposeScienceEvidenceGraphInferenceInput,
  RefreshScienceEvidenceGraphInput,
  RefreshScienceEvidenceGraphResult,
  ReviewScienceEvidenceGraphInferenceInput,
  ScienceEvidenceGraphBoundedContextOptions,
  ScienceEvidenceGraphBoundedSubgraph,
  ScienceEvidenceGraphCanonicalRef,
  ScienceEvidenceGraphConditioningContext,
  ScienceEvidenceGraphEdge,
  ScienceEvidenceGraphEdgeKind,
  ScienceEvidenceGraphEpistemicStatus,
  ScienceEvidenceGraphInferenceCandidate,
  ScienceEvidenceGraphInferenceMaterialization,
  ScienceEvidenceGraphInferenceReview,
  ScienceEvidenceGraphNode,
  ScienceEvidenceGraphNodeKind,
  ScienceEvidenceGraphPathExplanation,
  ScienceEvidenceGraphRevision,
  ScienceEvidenceGraphSummary,
  MaterializeScienceEvidenceGraphInferenceInput,
} from "../../shared/science-evidence-graph";
import {
  SCIENCE_EVIDENCE_GRAPH_EDGE_KINDS,
  SCIENCE_EVIDENCE_GRAPH_MAX_CANDIDATES,
  SCIENCE_EVIDENCE_GRAPH_MAX_EDGES,
  SCIENCE_EVIDENCE_GRAPH_MAX_NODES,
  SCIENCE_EVIDENCE_GRAPH_NODE_KINDS,
} from "../../shared/science-evidence-graph";
import { validateScienceResearchOntologyGraph } from "../../shared/science-evidence-ontology";
import {
  ScienceStore,
  scienceEvidenceGraphCandidateContentSha256,
  scienceEvidenceGraphEdgeContentSha256,
  scienceEvidenceGraphEvidenceSpanContentSha256,
  scienceEvidenceGraphInferenceCanonicalContentSha256,
  scienceEvidenceGraphNodeContentSha256,
  scienceEvidenceGraphProjectionContentSha256,
  scienceEvidenceGraphProjectContentSha256,
  scienceEvidenceGraphResearchRunContentSha256,
  scienceEvidenceGraphSourceVersionContentSha256,
  scienceEvidenceGraphReviewContentSha256,
  scienceEvidenceGraphRevisionContentSha256,
} from "./store";

const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_GRAPH_NODES = SCIENCE_EVIDENCE_GRAPH_MAX_NODES;
const MAX_GRAPH_EDGES = SCIENCE_EVIDENCE_GRAPH_MAX_EDGES;
const MAX_GRAPH_CANDIDATES = SCIENCE_EVIDENCE_GRAPH_MAX_CANDIDATES;
const EMPTY_CONTEXT: ScienceEvidenceGraphConditioningContext = {
  population: null,
  interventionOrExposure: null,
  comparator: null,
  outcome: null,
  timeframe: null,
  method: null,
  datasetOrSetting: null,
};

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("science-evidence-graph-non-finite-number");
    return Object.is(value, -0) ? 0 : value;
  }
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().flatMap((key) => {
    const child = (value as Record<string, unknown>)[key];
    return child === undefined ? [] : [[key, canonicalValue(child)]];
  }));
}

function canonicalJson(value: unknown): string { return JSON.stringify(canonicalValue(value)); }
function sha256(value: unknown): string { return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value), "utf8").digest("hex"); }

function stableUuid(value: string): string {
  const hex = sha256(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function safeText(value: unknown, maximum: number, code: string): string {
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) throw new Error(code);
  return normalized;
}

function normalizeProposition(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ").slice(0, 2_000);
}

function exactContext(value: ScienceEvidenceGraphConditioningContext): ScienceEvidenceGraphConditioningContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("science-evidence-graph-context-invalid");
  const keys = Object.keys(value).sort();
  const expected = Object.keys(EMPTY_CONTEXT).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error("science-evidence-graph-context-invalid");
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, child === null ? null : safeText(child, 1_000, "science-evidence-graph-context-invalid")])) as unknown as ScienceEvidenceGraphConditioningContext;
}

function contextKey(context: ScienceEvidenceGraphConditioningContext | null): string { return canonicalJson(context ?? EMPTY_CONTEXT); }

function node(input: Omit<ScienceEvidenceGraphNode, "contentSha256">): ScienceEvidenceGraphNode {
  return { ...input, contentSha256: scienceEvidenceGraphNodeContentSha256(input) };
}

function edge(input: Omit<ScienceEvidenceGraphEdge, "contentSha256">): ScienceEvidenceGraphEdge {
  return { ...input, contentSha256: scienceEvidenceGraphEdgeContentSha256(input) };
}

function candidate(input: Omit<ScienceEvidenceGraphInferenceCandidate, "contentSha256">): ScienceEvidenceGraphInferenceCandidate {
  return { ...input, contentSha256: scienceEvidenceGraphCandidateContentSha256(input) };
}

function projectContent(project: NonNullable<ReturnType<ScienceStore["getProject"]>>): string {
  return scienceEvidenceGraphProjectContentSha256(project);
}

function evidenceSpanContent(evidence: NonNullable<ReturnType<ScienceStore["getEvidenceSpanForProject"]>>): string {
  return scienceEvidenceGraphEvidenceSpanContentSha256(evidence);
}

function researchRunContent(run: ScienceResearchRun): string {
  return scienceEvidenceGraphResearchRunContentSha256(run);
}

function hypothesisStatus(hypothesis: ScienceHypothesis): ScienceEvidenceGraphEpistemicStatus {
  if (hypothesis.status === "supported") return "supported";
  if (hypothesis.status === "contradicted") return "contradicted";
  if (hypothesis.status === "rejected") return "invalidated";
  return "candidate";
}

function sourceScope(version: ScienceSourceVersion): ScienceEvidenceGraphNode["evidenceScope"] {
  // `parsed` describes byte availability, not how much of the paper was acquired. An
  // abstract promoted into immutable bytes must never be presented to the model as full text.
  if (version.retrievalMethod?.startsWith("agentlas.abstract-promotion/v1:")) return "abstract";
  if (version.accessState === "parsed" || version.accessState === "evidence-linked") return "full-text";
  if (version.accessState === "retrieved") return "abstract";
  return "metadata";
}

function summary(nodes: ScienceEvidenceGraphNode[], edges: ScienceEvidenceGraphEdge[], candidates: ScienceEvidenceGraphInferenceCandidate[]): ScienceEvidenceGraphSummary {
  const nodeCounts = Object.fromEntries(SCIENCE_EVIDENCE_GRAPH_NODE_KINDS.map((kind) => [kind, nodes.filter((item) => item.kind === kind).length])) as ScienceEvidenceGraphSummary["nodeCounts"];
  const edgeCounts = Object.fromEntries(SCIENCE_EVIDENCE_GRAPH_EDGE_KINDS.map((kind) => [kind, edges.filter((item) => item.kind === kind).length])) as ScienceEvidenceGraphSummary["edgeCounts"];
  return {
    nodeCounts,
    edgeCounts,
    pendingInferenceCount: candidates.filter((item) => item.reviewStatus === "pending").length,
    contradictionCandidateCount: candidates.filter((item) => item.kind === "contradiction-candidate").length,
    evidenceGapCount: candidates.filter((item) => item.kind === "evidence-gap" || item.kind === "operationalization-gap").length,
    invalidatedNodeCount: nodes.filter((item) => item.epistemicStatus === "invalidated").length,
    unsupportedConclusionCount: nodes.filter((item) => item.kind === "conclusion" && item.epistemicStatus !== "supported").length,
  };
}

interface ProjectionBuilder {
  nodes: Map<string, ScienceEvidenceGraphNode>;
  edges: Map<string, ScienceEvidenceGraphEdge>;
  candidates: Map<string, ScienceEvidenceGraphInferenceCandidate>;
  priorEdges: Map<string, ScienceEvidenceGraphEdge>;
  now: string;
}

function addNode(builder: ProjectionBuilder, value: ScienceEvidenceGraphNode): ScienceEvidenceGraphNode {
  const existing = builder.nodes.get(value.id);
  if (existing && existing.contentSha256 !== value.contentSha256) throw new Error("science-evidence-graph-node-id-collision");
  builder.nodes.set(value.id, value);
  if (builder.nodes.size > MAX_GRAPH_NODES) throw new Error("science-evidence-graph-node-limit");
  return value;
}

function addEdge(builder: ProjectionBuilder, input: {
  kind: ScienceEvidenceGraphEdgeKind;
  from: ScienceEvidenceGraphNode;
  to: ScienceEvidenceGraphNode;
  evidencePathNodeIds?: string[];
  ruleId: string;
  ruleVersion?: string;
  producer?: { kind: "agent" | "tool" | "human" | "system"; id: string };
  reviewStatus?: "pending" | "accepted" | "rejected";
}): ScienceEvidenceGraphEdge {
  const evidencePathNodeIds = [...new Set(input.evidencePathNodeIds ?? [])].sort();
  const id = stableUuid(`science-evidence-edge:v1:${input.kind}:${input.from.id}:${input.to.id}:${input.ruleId}:${evidencePathNodeIds.join(",")}`);
  const previous = builder.priorEdges.get(id);
  const value = edge({
    id,
    projectId: input.from.projectId,
    kind: input.kind,
    fromNodeId: input.from.id,
    toNodeId: input.to.id,
    fromContentSha256: input.from.contentSha256,
    toContentSha256: input.to.contentSha256,
    evidencePathNodeIds,
    derivation: {
      parentNodeIds: [input.from.id, input.to.id],
      parentContentSha256: [input.from.contentSha256, input.to.contentSha256],
      ruleId: input.ruleId,
      ruleVersion: input.ruleVersion ?? "1.0.0",
      producer: input.producer ?? { kind: "system", id: "agentlas-science-evidence-graph" },
      reviewStatus: input.reviewStatus ?? "accepted",
      createdAt: previous?.fromContentSha256 === input.from.contentSha256 && previous.toContentSha256 === input.to.contentSha256 ? previous.derivation.createdAt : builder.now,
    },
  });
  builder.edges.set(id, value);
  if (builder.edges.size > MAX_GRAPH_EDGES) throw new Error("science-evidence-graph-edge-limit");
  return value;
}

function addCandidate(builder: ProjectionBuilder, input: Omit<ScienceEvidenceGraphInferenceCandidate, "contentSha256">): ScienceEvidenceGraphInferenceCandidate {
  const value = candidate(input);
  builder.candidates.set(value.id, value);
  if (builder.candidates.size > MAX_GRAPH_CANDIDATES) throw new Error("science-evidence-graph-candidate-limit");
  return value;
}

function inferenceNode(builder: ProjectionBuilder, projectId: string, input: { key: string; label: string; statement: string; normalizedProposition?: string | null; context?: ScienceEvidenceGraphConditioningContext | null }): ScienceEvidenceGraphNode {
  const id = stableUuid(`science-evidence-inference-node:v1:${projectId}:${input.key}`);
  const unsignedNode: Omit<ScienceEvidenceGraphNode, "canonicalRef" | "contentSha256"> = {
    id,
    projectId,
    kind: "inference-candidate",
    assertionKind: "inference",
    epistemicStatus: "candidate",
    label: input.label,
    statement: input.statement,
    normalizedProposition: input.normalizedProposition ?? normalizeProposition(input.statement),
    polarity: "neutral",
    conditioningContext: input.context ?? { ...EMPTY_CONTEXT },
    evidenceScope: "system",
  };
  const canonicalRef: ScienceEvidenceGraphCanonicalRef = {
    kind: "graph-inference-candidate",
    id,
    version: 1,
    contentSha256: scienceEvidenceGraphInferenceCanonicalContentSha256(unsignedNode),
  };
  return addNode(builder, node({ ...unsignedNode, canonicalRef }));
}

function latestReviewMap(reviews: ScienceEvidenceGraphInferenceReview[]): Map<string, ScienceEvidenceGraphInferenceReview> {
  const output = new Map<string, ScienceEvidenceGraphInferenceReview>();
  for (const review of reviews) {
    const current = output.get(review.candidateId);
    if (!current || review.revision > current.revision) output.set(review.candidateId, review);
  }
  return output;
}

export class ScienceEvidenceGraphService {
  constructor(private readonly store: ScienceStore) {}

  private graphWithCanonicalRefs(projectId: string, prior: ScienceEvidenceGraphRevision | null, now: string): {
    nodes: ScienceEvidenceGraphNode[];
    edges: ScienceEvidenceGraphEdge[];
    inferenceCandidates: ScienceEvidenceGraphInferenceCandidate[];
  } {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error("science-project-not-found");
    const builder: ProjectionBuilder = {
      nodes: new Map(),
      edges: new Map(),
      candidates: new Map(),
      priorEdges: new Map((prior?.edges ?? []).map((item) => [item.id, item])),
      now,
    };
    const questionNode = addNode(builder, node({
      id: stableUuid(`science-evidence-node:v1:project:${project.id}:${project.version}`),
      projectId,
      kind: "research-question",
      canonicalRef: { kind: "project", id: project.id, version: project.version, contentSha256: projectContent(project) },
      assertionKind: "hypothesis",
      epistemicStatus: "candidate",
      label: project.title,
      statement: project.question,
      normalizedProposition: normalizeProposition(project.question),
      polarity: "neutral",
      conditioningContext: { ...EMPTY_CONTEXT },
      evidenceScope: "human",
    }));

    const sourceNodes = new Map<string, ScienceEvidenceGraphNode>();
    for (const source of this.store.listSources(projectId, MAX_GRAPH_NODES)) {
      if (source.version.contentSha256) this.store.ensureSourceTextIndex(projectId, source.id, source.version.id);
      const graphSourceSha256 = scienceEvidenceGraphSourceVersionContentSha256(source);
      const sourceNode = addNode(builder, node({
        id: stableUuid(`science-evidence-node:v1:source-version:${source.version.id}:${graphSourceSha256}`),
        projectId,
        kind: "source-version",
        canonicalRef: { kind: "source-version", id: source.version.id, version: source.version.version, contentSha256: graphSourceSha256 },
        assertionKind: "source-fact",
        epistemicStatus: source.verificationStatus === "retracted" ? "invalidated" : source.version.accessState === "metadata-only" ? "candidate" : "supported",
        label: source.title,
        statement: `${source.kind} · ${source.canonicalUri}`,
        normalizedProposition: null,
        polarity: null,
        conditioningContext: null,
        evidenceScope: sourceScope(source.version),
      }));
      sourceNodes.set(source.version.id, sourceNode);
      if (source.verificationStatus === "retracted") {
        const invalidation = addNode(builder, node({
          id: stableUuid(`science-evidence-node:v1:source-invalidation:${source.version.id}:${graphSourceSha256}`),
          projectId,
          kind: "concept",
          canonicalRef: { kind: "source-version", id: source.version.id, version: source.version.version, contentSha256: graphSourceSha256 },
          assertionKind: "source-fact",
          epistemicStatus: "supported",
          label: "Source invalidation check",
          statement: `${source.title} is marked retracted in the canonical source record.`,
          normalizedProposition: normalizeProposition(`${source.title} retracted`),
          polarity: "neutral",
          conditioningContext: null,
          evidenceScope: "system",
        }));
        addEdge(builder, { kind: "invalidated-by", from: sourceNode, to: invalidation, evidencePathNodeIds: [sourceNode.id], ruleId: "source-verification-retraction" });
      }
    }

    const evidenceNodes = new Map<string, ScienceEvidenceGraphNode>();
    const evidenceSourceVersionIds = new Map<string, string>();
    const claimNodes = new Map<string, ScienceEvidenceGraphNode>();
    const ledger = this.store.listProjectEvidenceLedger(projectId);
    for (const row of ledger) {
      const sourceNode = sourceNodes.get(row.evidence.sourceVersionId);
      if (!sourceNode) continue;
      let evidenceNode = evidenceNodes.get(row.evidence.id);
      if (!evidenceNode) {
        const evidenceHash = evidenceSpanContent(row.evidence);
        evidenceNode = addNode(builder, node({
          id: stableUuid(`science-evidence-node:v1:evidence-span:${row.evidence.id}:${evidenceHash}`),
          projectId,
          kind: "evidence-span",
          canonicalRef: { kind: "evidence-span", id: row.evidence.id, version: 1, contentSha256: evidenceHash },
          assertionKind: "source-fact",
          epistemicStatus: sourceNode.epistemicStatus === "invalidated" ? "invalidated" : "supported",
          label: row.evidence.locator,
          statement: row.evidence.excerpt,
          normalizedProposition: normalizeProposition(row.evidence.excerpt),
          polarity: null,
          conditioningContext: null,
          evidenceScope: sourceNode.evidenceScope,
        }));
        evidenceNodes.set(row.evidence.id, evidenceNode);
        evidenceSourceVersionIds.set(row.evidence.id, row.evidence.sourceVersionId);
        addEdge(builder, { kind: "derived-from", from: evidenceNode, to: sourceNode, evidencePathNodeIds: [sourceNode.id], ruleId: "canonical-evidence-source-binding" });
      }
      let claimNode = claimNodes.get(row.block.id);
      if (!claimNode) {
        claimNode = addNode(builder, node({
          id: stableUuid(`science-evidence-node:v1:extracted-claim:${row.block.id}:${row.block.contentSha256}`),
          projectId,
          kind: "extracted-claim",
          canonicalRef: { kind: "message-block", id: row.block.id, version: 1, contentSha256: row.block.contentSha256 },
          assertionKind: "source-claim",
          epistemicStatus: "candidate",
          label: `Extracted claim · block ${row.block.ordinal}`,
          statement: row.block.content,
          normalizedProposition: normalizeProposition(row.block.content),
          polarity: "neutral",
          conditioningContext: { ...EMPTY_CONTEXT },
          evidenceScope: evidenceNode.evidenceScope,
        }));
        claimNodes.set(row.block.id, claimNode);
      }
      addEdge(builder, { kind: "extracted-from", from: claimNode, to: evidenceNode, evidencePathNodeIds: [evidenceNode.id, sourceNode.id], ruleId: "canonical-message-evidence-binding" });
      addEdge(builder, { kind: "cites", from: claimNode, to: sourceNode, evidencePathNodeIds: [], ruleId: "canonical-citation-binding" });
      if (evidenceNode.epistemicStatus !== "invalidated") {
        const relation: ScienceEvidenceGraphEdgeKind = row.citation.relation === "contradicts" ? "contradicts" : row.citation.relation === "supports" ? "supports" : "qualifies";
        addEdge(builder, { kind: relation, from: evidenceNode, to: claimNode, evidencePathNodeIds: [evidenceNode.id, sourceNode.id], ruleId: "canonical-citation-relation" });
      }
    }

    const hypothesisNodes = new Map<string, ScienceEvidenceGraphNode>();
    for (const hypothesis of this.store.listHypotheses(projectId, false)) {
      const hypothesisNode = addNode(builder, node({
        id: stableUuid(`science-evidence-node:v1:hypothesis:${hypothesis.id}:${hypothesis.version}:${hypothesis.contentSha256}`),
        projectId,
        kind: "hypothesis",
        canonicalRef: { kind: "hypothesis", id: hypothesis.id, version: hypothesis.version, contentSha256: hypothesis.contentSha256 },
        assertionKind: "hypothesis",
        epistemicStatus: hypothesisStatus(hypothesis),
        label: `${hypothesis.role === "primary" ? "Primary" : "Alternative"} hypothesis v${hypothesis.version}`,
        statement: hypothesis.statement,
        normalizedProposition: normalizeProposition(hypothesis.statement),
        polarity: "neutral",
        conditioningContext: { ...EMPTY_CONTEXT },
        evidenceScope: "human",
      }));
      hypothesisNodes.set(hypothesis.id, hypothesisNode);
      addEdge(builder, { kind: "addresses", from: hypothesisNode, to: questionNode, ruleId: "hypothesis-addresses-project-question" });
      for (const evidenceId of hypothesis.evidenceSpanIds) {
        const evidenceNode = evidenceNodes.get(evidenceId);
        if (evidenceNode && evidenceNode.epistemicStatus !== "invalidated") addEdge(builder, { kind: "supports", from: evidenceNode, to: hypothesisNode, evidencePathNodeIds: [evidenceNode.id], ruleId: "hypothesis-evidence-binding" });
      }
    }
    for (const hypothesis of this.store.listHypotheses(projectId, false)) {
      const current = hypothesisNodes.get(hypothesis.id);
      const parent = hypothesis.parentHypothesisId ? hypothesisNodes.get(hypothesis.parentHypothesisId) : null;
      if (current && parent) addEdge(builder, { kind: "supersedes", from: current, to: parent, ruleId: "hypothesis-successor-chain" });
    }

    const planNodes = new Map<string, ScienceEvidenceGraphNode>();
    for (const plan of this.store.listAnalysisSpecs(projectId, MAX_GRAPH_NODES)) {
      const planNode = addNode(builder, node({
        id: stableUuid(`science-evidence-node:v1:analysis-plan:${plan.version.id}:${plan.version.documentSha256}`),
        projectId,
        kind: "analysis-plan-version",
        canonicalRef: { kind: "analysis-plan-version", id: plan.version.id, version: plan.version.version, contentSha256: plan.version.documentSha256 },
        assertionKind: "hypothesis",
        epistemicStatus: plan.status === "frozen" ? "supported" : "candidate",
        label: `${plan.title} · ${plan.status} v${plan.version.version}`,
        statement: plan.version.document.researchQuestion,
        normalizedProposition: normalizeProposition(plan.version.document.researchQuestion),
        polarity: "neutral",
        conditioningContext: {
          ...EMPTY_CONTEXT,
          population: plan.version.document.population || null,
          outcome: plan.version.document.data.outcomeVariables.join(", ") || null,
          method: plan.version.document.model?.family ?? plan.version.document.design.studyType,
          datasetOrSetting: plan.version.document.data.inputs.map((item) => item.artifactId).join(", ")
            || plan.version.document.data.acquisition?.sources.map((source) => `${source.provider}: ${source.sourceRefs.join(", ")}`).join("; ")
            || null,
        },
        evidenceScope: "human",
      }));
      planNodes.set(`${plan.id}:${plan.version.version}:${plan.version.documentSha256}`, planNode);
      addEdge(builder, { kind: "addresses", from: planNode, to: questionNode, ruleId: "analysis-plan-addresses-project-question" });
      for (const variableName of [...plan.version.document.data.outcomeVariables, ...plan.version.document.data.predictorVariables]) {
        const variable = addNode(builder, node({
          id: stableUuid(`science-evidence-node:v1:variable:${plan.version.id}:${variableName}`),
          projectId,
          kind: "variable",
          canonicalRef: { kind: "analysis-plan-version", id: plan.version.id, version: plan.version.version, contentSha256: plan.version.documentSha256 },
          assertionKind: "hypothesis",
          epistemicStatus: plan.status === "frozen" ? "supported" : "candidate",
          label: variableName,
          statement: variableName,
          normalizedProposition: normalizeProposition(variableName),
          polarity: null,
          conditioningContext: null,
          evidenceScope: "human",
        }));
        addEdge(builder, { kind: "operationalizes", from: planNode, to: variable, ruleId: "analysis-plan-variable-binding" });
      }
    }

    const runNodes = new Map<string, ScienceEvidenceGraphNode>();
    const runs = this.store.listResearchRuns(projectId, MAX_GRAPH_NODES);
    for (const run of runs) {
      const runHash = researchRunContent(run);
      const runNode = addNode(builder, node({
        id: stableUuid(`science-evidence-node:v1:research-run:${run.id}:${runHash}`),
        projectId,
        kind: "research-run",
        canonicalRef: { kind: "research-run", id: run.id, version: 1, contentSha256: runHash },
        assertionKind: "computed-result",
        epistemicStatus: run.status === "succeeded" ? "supported" : run.status === "failed" || run.status === "cancelled" ? "invalidated" : "inconclusive",
        label: `${run.toolId}@${run.toolVersion}`,
        statement: run.summary ?? `${run.toolId} ${run.status}`,
        normalizedProposition: null,
        polarity: null,
        conditioningContext: null,
        evidenceScope: "computed",
      }));
      runNodes.set(run.id, runNode);
      if (run.analysisPlan) {
        const plan = planNodes.get(`${run.analysisPlan.analysisSpecId}:${run.analysisPlan.version}:${run.analysisPlan.contentSha256}`);
        if (plan) addEdge(builder, { kind: "uses-input", from: runNode, to: plan, evidencePathNodeIds: [plan.id], ruleId: "run-analysis-plan-binding" });
      }
    }
    for (const run of runs) {
      const runNode = runNodes.get(run.id);
      if (!runNode) continue;
      const bindings = this.store.getResearchRunParentBindings(projectId, run.id);
      for (const binding of bindings) {
        const parent = runNodes.get(binding.parentRunId);
        // The projection has a bounded node budget. Preserve the previous
        // behavior for a parent outside that window, but never accept a hash
        // mismatch for a parent that is present in the projection.
        if (!parent) continue;
        if (parent.canonicalRef.contentSha256 !== binding.parentContentSha256) {
          throw new Error("science-evidence-graph-run-parent-binding-invalid");
        }
        addEdge(builder, {
          kind: "derived-from",
          from: runNode,
          to: parent,
          evidencePathNodeIds: [parent.id],
          ruleId: "research-run-parent-binding",
        });
      }
      const sourceBindings = this.store.getResearchRunSourceBindings(projectId, run.id);
      for (const binding of sourceBindings) {
        const source = this.store.getSourceVersionForProject(projectId, binding.sourceId, binding.sourceVersionId);
        const sourceNode = sourceNodes.get(binding.sourceVersionId);
        if (!source || source.version.contentSha256 !== binding.contentSha256) {
          throw new Error("science-evidence-graph-run-source-binding-invalid");
        }
        // A bounded graph may omit older source nodes, but a present node must
        // still point to the exact bound SourceVersion rather than a current
        // or same-URI substitute.
        if (!sourceNode) continue;
        addEdge(builder, {
          kind: "uses-input",
          from: runNode,
          to: sourceNode,
          evidencePathNodeIds: [sourceNode.id],
          ruleId: "research-run-source-binding",
        });
      }
    }

    const episodes = this.store.listLoopSessions(projectId).flatMap((session) => this.store.listResearchEpisodes(projectId, session.id));
    const artifactContexts = new Map<string, NonNullable<ReturnType<ScienceStore["getArtifactContextForProject"]>>>();
    for (const artifact of this.store.listArtifacts(projectId, MAX_GRAPH_NODES)) {
      const context = this.store.getArtifactContextForProject(projectId, artifact.id, artifact.version.version);
      if (context?.artifact.kind === "chart.numeric-3d"
        && context.selectedVersion.payload.schema === "agentlas.science.numeric-surface-artifact/v2") {
        const binding = context.artifact.sourceRunId
          ? this.store.getRunArtifactBinding(projectId, context.artifact.sourceRunId)
          : null;
        if (!binding || binding.artifactId !== context.artifact.id
          || binding.artifactVersion !== context.selectedVersion.version
          || binding.artifactContentSha256 !== context.selectedVersion.contentSha256) continue;
      }
      if (context) artifactContexts.set(`${artifact.id}:${artifact.version.version}`, context);
    }
    for (const binding of episodes.flatMap((episode) => episode.result?.artifacts ?? [])) {
      const key = `${binding.artifactId}:${binding.artifactVersion}`;
      if (artifactContexts.has(key)) continue;
      const context = this.store.getArtifactContextForProject(projectId, binding.artifactId, binding.artifactVersion);
      if (context) artifactContexts.set(key, context);
    }

    const artifactNodes = new Map<string, ScienceEvidenceGraphNode>();
    for (const [key, context] of artifactContexts) {
      const artifactNode = addNode(builder, node({
        id: stableUuid(`science-evidence-node:v1:artifact-version:${context.artifact.id}:${context.selectedVersion.version}:${context.selectedVersion.contentSha256}`),
        projectId,
        kind: "artifact-version",
        canonicalRef: { kind: "artifact-version", id: context.artifact.id, version: context.selectedVersion.version, contentSha256: context.selectedVersion.contentSha256 },
        assertionKind: "computed-result",
        epistemicStatus: context.artifact.status === "ready" ? "supported" : "inconclusive",
        label: context.artifact.title,
        statement: context.selectedVersion.semantic.summary,
        normalizedProposition: null,
        polarity: null,
        conditioningContext: null,
        evidenceScope: "computed",
      }));
      artifactNodes.set(key, artifactNode);
      if (context.artifact.sourceRunId) {
        const runNode = runNodes.get(context.artifact.sourceRunId);
        if (runNode) addEdge(builder, { kind: "produced", from: runNode, to: artifactNode, evidencePathNodeIds: [runNode.id], ruleId: "run-artifact-binding" });
      }
    }
    for (const [key, context] of artifactContexts) {
      const artifactNode = artifactNodes.get(key)!;
      for (const input of context.linkage.inputs) {
        const inputNode = artifactNodes.get(`${input.artifactId}:${input.version}`);
        if (inputNode) addEdge(builder, { kind: "uses-input", from: artifactNode, to: inputNode, evidencePathNodeIds: [inputNode.id], ruleId: "artifact-input-binding" });
      }
    }

    const runsById = new Map(runs.map((run) => [run.id, run]));
    for (const episode of episodes) {
      if (!episode.result) continue;
      const result = episode.result;
      const hypothesisNode = [...hypothesisNodes.values()].find((item) => item.canonicalRef.id === episode.hypothesisId
        && item.canonicalRef.version === episode.hypothesisVersion && item.canonicalRef.contentSha256 === episode.hypothesisContentSha256);
      const episodeNode = addNode(builder, node({
        id: stableUuid(`science-evidence-node:v1:episode-result:${episode.id}:${result.resultSha256}`),
        projectId,
        kind: "episode-result",
        canonicalRef: { kind: "episode-result", id: episode.id, version: episode.version, contentSha256: result.resultSha256 },
        assertionKind: "computed-result",
        epistemicStatus: episode.status === "succeeded" ? result.outcome === "supported" ? "supported" : result.outcome === "contradicted" ? "contradicted" : "inconclusive" : "invalidated",
        label: `Episode ${episode.ordinal} · ${result.outcome}`,
        statement: result.observationSummary,
        normalizedProposition: normalizeProposition(result.conclusion),
        polarity: result.outcome === "supported" ? "supports" : result.outcome === "contradicted" ? "opposes" : "neutral",
        conditioningContext: { ...EMPTY_CONTEXT, method: episode.method },
        evidenceScope: "computed",
      }));
      if (hypothesisNode) addEdge(builder, { kind: "tests", from: episodeNode, to: hypothesisNode, evidencePathNodeIds: [episodeNode.id], ruleId: "episode-hypothesis-binding" });
      const runRecords = result.runIds.map((id) => runsById.get(id)).filter((item): item is ScienceResearchRun => Boolean(item));
      const runPath = result.runIds.map((id) => runNodes.get(id)).filter((item): item is ScienceEvidenceGraphNode => Boolean(item));
      const artifactPath = result.artifacts.map((item) => {
        const nodeValue = artifactNodes.get(`${item.artifactId}:${item.artifactVersion}`);
        return nodeValue?.canonicalRef.contentSha256 === item.contentSha256 ? nodeValue : undefined;
      }).filter((item): item is ScienceEvidenceGraphNode => Boolean(item));
      const evidencePath = result.evidenceSpanIds.map((id) => evidenceNodes.get(id)).filter((item): item is ScienceEvidenceGraphNode => Boolean(item));
      for (const runNode of runPath) addEdge(builder, { kind: "produced", from: runNode, to: episodeNode, evidencePathNodeIds: [runNode.id], ruleId: "episode-run-binding" });
      for (const artifactNode of artifactPath) addEdge(builder, { kind: "uses-input", from: episodeNode, to: artifactNode, evidencePathNodeIds: [artifactNode.id], ruleId: "episode-artifact-binding" });
      if (result.outcome === "supported" || result.outcome === "contradicted") {
        for (const evidenceNode of evidencePath.filter((item) => item.epistemicStatus !== "invalidated")) {
          addEdge(builder, { kind: result.outcome === "contradicted" ? "contradicts" : "supports", from: evidenceNode, to: episodeNode, evidencePathNodeIds: [evidenceNode.id], ruleId: "episode-evidence-binding" });
        }
      }

      const planKeys = new Set(runRecords.map((run) => run.analysisPlan
        ? `${run.analysisPlan.analysisSpecId}:${run.analysisPlan.version}:${run.analysisPlan.contentSha256}`
        : "missing"));
      const exactPlanKey = planKeys.size === 1 && !planKeys.has("missing") ? [...planKeys][0]! : null;
      const exactPlanNode = exactPlanKey ? planNodes.get(exactPlanKey) : undefined;
      const lifecycleRevisions = this.store.listResearchLifecycleRevisions(projectId, episode.lifecycleStudyId);
      const episodeLifecycle = lifecycleRevisions.find((revision) => revision.revision === episode.lifecycleRevision
        && revision.stateSha256 === episode.lifecycleStateSha256) ?? null;
      const conclusionGate = lifecycleRevisions.find((revision) => revision.phase === "conclusions"
        && revision.preconditions.kind === "phase_gate"
        && revision.preconditions.fromPhase === "evidence_reconciliation"
        && revision.preconditions.toPhase === "conclusions"
        && revision.preconditions.gateCode === "evidence.reconciled") ?? null;
      let claimGateReady = false;
      let lifecycleGateNode: ScienceEvidenceGraphNode | null = null;
      if (conclusionGate?.preconditions.kind === "phase_gate" && conclusionGate.preconditions.fromPhase === "evidence_reconciliation") {
        const ledgerModel = this.store.getClaimLedgerById(projectId, conclusionGate.preconditions.claimLedgerId);
        claimGateReady = Boolean(ledgerModel?.gate.ready
          && ledgerModel.manifest.revision === conclusionGate.preconditions.claimLedgerRevision
          && ledgerModel.manifest.manifestSha256 === conclusionGate.preconditions.claimLedgerManifestSha256
          && ledgerModel.gate.reportSha256 === conclusionGate.preconditions.claimGateReportSha256
          && ledgerModel.gate.policyContentSha256 === conclusionGate.preconditions.claimPolicyContentSha256
          && conclusionGate.preconditions.evidenceSha256 === ledgerModel.gate.reportSha256);
        if (claimGateReady) {
          lifecycleGateNode = addNode(builder, node({
            id: stableUuid(`science-evidence-node:v1:research-lifecycle-revision:${conclusionGate.id}:${conclusionGate.contentSha256}`),
            projectId,
            kind: "concept",
            canonicalRef: { kind: "research-lifecycle-revision", id: conclusionGate.id, version: conclusionGate.revision, contentSha256: conclusionGate.contentSha256 },
            assertionKind: "source-fact",
            epistemicStatus: "supported",
            label: "Evidence reconciliation gate",
            statement: `Lifecycle revision ${conclusionGate.revision} binds the ready claim ledger and frozen analysis plan.`,
            normalizedProposition: null,
            polarity: null,
            conditioningContext: null,
            evidenceScope: "system",
          }));
        }
      }

      const validationNodes: ScienceEvidenceGraphNode[] = [];
      const invalidArtifactBindings: string[] = [];
      for (const binding of result.artifacts) {
        const context = artifactContexts.get(`${binding.artifactId}:${binding.artifactVersion}`);
        const verifiedReceipt = context && context.selectedVersion.contentSha256 === binding.contentSha256
          ? this.store.listArtifactValidationReceipts(projectId, binding.artifactId, binding.artifactVersion).find((receipt) => receipt.status === "verified"
            && receipt.artifactVersionId === context.selectedVersion.id
            && receipt.artifactContentSha256 === binding.contentSha256
            && receipt.artifactLinkageSha256 === context.linkage.linkageSha256
            && result.runIds.includes(receipt.researchRunId))
          : undefined;
        if (!verifiedReceipt) { invalidArtifactBindings.push(`${binding.artifactId}:${binding.artifactVersion}`); continue; }
        validationNodes.push(addNode(builder, node({
          id: stableUuid(`science-evidence-node:v1:artifact-validation-receipt:${verifiedReceipt.id}:${verifiedReceipt.receiptSha256}`),
          projectId,
          kind: "concept",
          canonicalRef: { kind: "artifact-validation-receipt", id: verifiedReceipt.id, version: 1, contentSha256: verifiedReceipt.receiptSha256 },
          assertionKind: "source-fact",
          epistemicStatus: "supported",
          label: `Verified artifact · ${binding.artifactId}`,
          statement: `Artifact version ${binding.artifactVersion} passed ${verifiedReceipt.policyId}@${verifiedReceipt.policyVersion}.`,
          normalizedProposition: null,
          polarity: null,
          conditioningContext: null,
          evidenceScope: "system",
        })));
      }

      const missing: string[] = [];
      if (!hypothesisNode || hypothesisNode.epistemicStatus === "invalidated") missing.push("exact-current-hypothesis");
      if (!exactPlanNode || exactPlanNode.epistemicStatus !== "supported") missing.push("single-exact-frozen-analysis-plan");
      if (!episodeLifecycle || !exactPlanKey || !episodeLifecycle.frozenAnalysisPlan
        || `${episodeLifecycle.frozenAnalysisPlan.analysisSpecId}:${episodeLifecycle.frozenAnalysisPlan.version}:${episodeLifecycle.frozenAnalysisPlan.contentSha256}` !== exactPlanKey) {
        missing.push("episode-lifecycle-plan-binding");
      }
      if (episode.status !== "succeeded") missing.push("succeeded-episode");
      if (!runPath.length || runPath.length !== result.runIds.length || runRecords.length !== result.runIds.length
        || runRecords.some((run) => run.status !== "succeeded" || !run.outputManifestSha256)) missing.push("exact-succeeded-run-binding");
      if (!artifactPath.length || artifactPath.length !== result.artifacts.length
        || artifactPath.some((item) => item.epistemicStatus !== "supported")) missing.push("exact-artifact-binding");
      if (invalidArtifactBindings.length) missing.push("verified-artifact-receipts");
      if (!evidencePath.length || evidencePath.length !== result.evidenceSpanIds.length
        || evidencePath.some((item) => item.epistemicStatus === "invalidated")) missing.push("exact-active-evidence-binding");
      if (!claimGateReady || !lifecycleGateNode) missing.push("same-study-ready-claim-gate");
      if (!["supported", "contradicted"].includes(result.outcome)) missing.push("conclusive-episode-outcome");
      const conclusionPath = [hypothesisNode, exactPlanNode, ...runPath, ...artifactPath, ...validationNodes, lifecycleGateNode, episodeNode, ...evidencePath]
        .filter((item): item is ScienceEvidenceGraphNode => Boolean(item));
      const conclusionNode = addNode(builder, node({
        id: stableUuid(`science-evidence-node:v1:conclusion:${episode.id}:${result.resultSha256}`),
        projectId,
        kind: "conclusion",
        canonicalRef: { kind: "episode-result", id: episode.id, version: episode.version, contentSha256: result.resultSha256 },
        assertionKind: "conclusion",
        epistemicStatus: missing.length === 0
          ? result.outcome === "supported" ? "supported" : "contradicted"
          : result.outcome === "contradicted" ? "contradicted" : "candidate",
        label: `Conclusion · episode ${episode.ordinal}`,
        statement: result.conclusion,
        normalizedProposition: normalizeProposition(result.conclusion),
        polarity: result.outcome === "supported" ? "supports" : result.outcome === "contradicted" ? "opposes" : "neutral",
        conditioningContext: { ...EMPTY_CONTEXT, method: episode.method },
        evidenceScope: "computed",
      }));
      addEdge(builder, { kind: "derived-from", from: episodeNode, to: conclusionNode, evidencePathNodeIds: conclusionPath.map((item) => item.id), ruleId: "conclusion-eligibility-chain" });
      if (missing.length) {
        const inference = inferenceNode(builder, projectId, { key: `conclusion-eligibility:${episode.id}:${result.resultSha256}`, label: "Conclusion eligibility gap", statement: `Conclusion cannot be promoted: ${missing.join(", ")}.` });
        addEdge(builder, { kind: "identifies-gap", from: inference, to: conclusionNode, evidencePathNodeIds: conclusionPath.map((item) => item.id), ruleId: "conclusion-eligibility-gap" });
        addCandidate(builder, {
          id: stableUuid(`science-evidence-candidate:v1:conclusion-eligibility:${episode.id}:${result.resultSha256}`),
          projectId,
          kind: "conclusion-eligibility",
          nodeId: inference.id,
          label: "Conclusion eligibility path incomplete",
          rationale: `The immutable conclusion gate is missing: ${missing.join(", ")}.`,
          missingRequirements: missing,
          evidencePathNodeIds: conclusionPath.map((item) => item.id),
          independentSourceVersionCount: new Set(result.evidenceSpanIds.map((id) => evidenceSourceVersionIds.get(id)).filter(Boolean)).size,
          coverage: Math.max(0, (8 - missing.length) / 8),
          relevance: 1,
          assessmentConfidence: 1,
          reviewStatus: "pending",
        });
      }
    }

    // Project the current manuscript and its active claim-ledger records into the same
    // executable graph. Only claim-linked sentence snapshots are projected, keeping the
    // global graph bounded while preserving an exact sentence -> claim -> evidence/source
    // and artifact path for every substantive manuscript assertion.
    for (const manuscript of this.store.listManuscripts(projectId, MAX_GRAPH_NODES)) {
      const manuscriptNode = addNode(builder, node({
        id: stableUuid(`science-evidence-node:v1:manuscript-version:${manuscript.version.id}:${manuscript.version.contentSha256}`),
        projectId,
        kind: "manuscript-version",
        canonicalRef: { kind: "manuscript-version", id: manuscript.version.id, version: manuscript.currentVersion, contentSha256: manuscript.version.contentSha256 },
        assertionKind: "source-claim",
        epistemicStatus: manuscript.status === "draft" ? "candidate" : "supported",
        label: `${manuscript.title} · v${manuscript.currentVersion}`,
        statement: `Current manuscript version with ${manuscript.version.bindings.length} exact citation, figure, or artifact bindings.`,
        normalizedProposition: normalizeProposition(manuscript.title),
        polarity: "neutral",
        conditioningContext: null,
        evidenceScope: "human",
      }));
      const ledgerModel = this.store.getClaimLedgerForManuscript(projectId, manuscript.id);
      if (!ledgerModel || ledgerModel.manifest.manuscript.version !== manuscript.currentVersion
        || ledgerModel.manifest.manuscript.contentSha256 !== manuscript.version.contentSha256) continue;
      const sentences = this.store.listManuscriptSentenceSnapshots(projectId, manuscript.version.id);
      const sentenceByLocator = new Map(sentences.map((sentence) => [
        `${sentence.sectionId}:${sentence.sectionOrdinal}:${sentence.paragraphOrdinal}:${sentence.sentenceOrdinal}`,
        sentence,
      ]));
      for (const claim of ledgerModel.manifest.claims.filter((item) => ledgerModel.manifest.activeClaimIds.includes(item.claimId))) {
        const sentence = sentenceByLocator.get(`${claim.locator.sectionId}:${claim.locator.sectionOrdinal}:${claim.locator.paragraphOrdinal}:${claim.locator.sentenceOrdinal}`);
        if (!sentence || sentence.textSha256 !== claim.locator.sentenceTextSha256) throw new Error("science-evidence-graph-manuscript-sentence-stale");
        const sentenceNode = addNode(builder, node({
          id: stableUuid(`science-evidence-node:v1:manuscript-sentence:${sentence.id}:${sentence.contentSha256}`),
          projectId,
          kind: "manuscript-sentence",
          canonicalRef: { kind: "manuscript-sentence", id: sentence.id, version: 1, contentSha256: sentence.contentSha256 },
          assertionKind: "source-claim",
          epistemicStatus: "candidate",
          label: `${sentence.sectionId} · sentence ${sentence.sentenceOrdinal + 1}`,
          statement: sentence.text,
          normalizedProposition: normalizeProposition(sentence.text),
          polarity: "neutral",
          conditioningContext: null,
          evidenceScope: "human",
        }));
        addEdge(builder, { kind: "derived-from", from: sentenceNode, to: manuscriptNode, ruleId: "manuscript-sentence-version-binding" });
        const status: ScienceEvidenceGraphEpistemicStatus = claim.status === "supported" ? "supported"
          : claim.status === "contradicted" ? "contradicted" : claim.status === "mixed" ? "mixed"
            : claim.status === "not-applicable" ? "inconclusive" : "candidate";
        const assertionKind: ScienceEvidenceGraphNode["assertionKind"] = claim.claimClass === "result" ? "computed-result"
          : claim.claimClass === "inference" ? "inference" : "source-claim";
        const claimNode = addNode(builder, node({
          id: stableUuid(`science-evidence-node:v1:manuscript-claim:${claim.claimId}:${claim.contentSha256}`),
          projectId,
          kind: "manuscript-claim",
          canonicalRef: { kind: "claim-ledger-claim", id: claim.claimId, version: 1, contentSha256: claim.contentSha256 },
          assertionKind,
          epistemicStatus: status,
          label: `${claim.claimClass} · ${claim.status}`,
          statement: claim.exactText,
          normalizedProposition: normalizeProposition(claim.exactText),
          polarity: claim.status === "contradicted" ? "opposes" : claim.status === "supported" ? "supports" : "neutral",
          conditioningContext: { ...EMPTY_CONTEXT },
          evidenceScope: claim.evidence.some((atom) => atom.artifact) ? "computed" : "full-text",
        }));
        addEdge(builder, { kind: "extracted-from", from: claimNode, to: sentenceNode, ruleId: "claim-ledger-sentence-binding" });
        for (const atom of claim.evidence) {
          const evidenceNode = evidenceNodes.get(atom.evidenceSpanId);
          const sourceNode = sourceNodes.get(atom.sourceVersionId);
          const artifactNode = atom.artifact ? artifactNodes.get(`${atom.artifact.artifactId}:${atom.artifact.artifactVersion}`) : undefined;
          if (!evidenceNode || !sourceNode || evidenceNode.epistemicStatus === "invalidated" || sourceNode.epistemicStatus === "invalidated") continue;
          const path = [evidenceNode, sourceNode, ...(artifactNode ? [artifactNode] : [])];
          const relation: ScienceEvidenceGraphEdgeKind = atom.direction === "support" ? "supports" : atom.direction === "contradict" ? "contradicts" : "qualifies";
          addEdge(builder, { kind: relation, from: evidenceNode, to: claimNode, evidencePathNodeIds: path.map((item) => item.id), ruleId: "claim-ledger-evidence-atom-binding" });
          addEdge(builder, { kind: "cites", from: claimNode, to: sourceNode, evidencePathNodeIds: [evidenceNode.id, sourceNode.id], ruleId: "claim-ledger-citation-binding" });
          if (artifactNode) addEdge(builder, { kind: "derived-from", from: claimNode, to: artifactNode, evidencePathNodeIds: path.map((item) => item.id), ruleId: "claim-ledger-artifact-binding" });
        }
      }
    }

    for (const hypothesis of this.store.listHypotheses(projectId, true)) {
      const hypothesisNode = hypothesisNodes.get(hypothesis.id);
      if (!hypothesisNode) continue;
      const supporting = [...builder.edges.values()].filter((item) => item.kind === "supports" && item.toNodeId === hypothesisNode.id);
      if (supporting.length === 0) {
        const inference = inferenceNode(builder, projectId, { key: `evidence-gap:${hypothesis.id}:${hypothesis.contentSha256}`, label: "Evidence gap", statement: `No exact supporting or falsifier evidence path is bound to: ${hypothesis.statement}` });
        addEdge(builder, { kind: "identifies-gap", from: inference, to: hypothesisNode, ruleId: "hypothesis-evidence-gap" });
        addCandidate(builder, { id: stableUuid(`science-evidence-candidate:v1:evidence-gap:${hypothesis.id}:${hypothesis.contentSha256}`), projectId, kind: "evidence-gap", nodeId: inference.id, label: "Hypothesis evidence gap", rationale: "No exact evidence span or verified computed result is connected to the hypothesis.", missingRequirements: ["support-or-falsifier-evidence"], evidencePathNodeIds: [], independentSourceVersionCount: 0, coverage: 0, relevance: 1, assessmentConfidence: 1, reviewStatus: "pending" });
      }
      const tested = [...builder.edges.values()].some((item) => item.kind === "tests" && item.toNodeId === hypothesisNode.id);
      if (!tested) {
        const inference = inferenceNode(builder, projectId, { key: `operationalization-gap:${hypothesis.id}:${hypothesis.contentSha256}`, label: "Operationalization gap", statement: `No frozen plan and succeeded episode operationalize: ${hypothesis.statement}` });
        addEdge(builder, { kind: "identifies-gap", from: inference, to: hypothesisNode, ruleId: "hypothesis-operationalization-gap" });
        addCandidate(builder, { id: stableUuid(`science-evidence-candidate:v1:operationalization-gap:${hypothesis.id}:${hypothesis.contentSha256}`), projectId, kind: "operationalization-gap", nodeId: inference.id, label: "Hypothesis operationalization gap", rationale: "The hypothesis is not connected to a frozen-plan execution result.", missingRequirements: ["frozen-plan", "succeeded-episode"], evidencePathNodeIds: [], independentSourceVersionCount: 0, coverage: 0, relevance: 1, assessmentConfidence: 1, reviewStatus: "pending" });
      }
    }

    const claimsByProposition = new Map<string, ScienceEvidenceGraphNode[]>();
    for (const claimNode of claimNodes.values()) {
      const key = `${claimNode.normalizedProposition}\0${contextKey(claimNode.conditioningContext)}`;
      claimsByProposition.set(key, [...(claimsByProposition.get(key) ?? []), claimNode]);
    }
    for (const [key, claims] of claimsByProposition) {
      const supportEdges = [...builder.edges.values()].filter((item) => item.kind === "supports" && claims.some((claim) => claim.id === item.toNodeId));
      const contradictEdges = [...builder.edges.values()].filter((item) => item.kind === "contradicts" && claims.some((claim) => claim.id === item.toNodeId));
      if (supportEdges.length && contradictEdges.length) {
        const paths = [...new Set([...supportEdges, ...contradictEdges].flatMap((item) => item.evidencePathNodeIds))].sort();
        const inference = inferenceNode(builder, projectId, { key: `contradiction:${sha256(key)}`, label: "Contradiction candidate", statement: `Exact evidence paths have opposed polarity for: ${claims[0]!.statement}`, normalizedProposition: claims[0]!.normalizedProposition, context: claims[0]!.conditioningContext });
        for (const claim of claims) addEdge(builder, { kind: "contradicts", from: inference, to: claim, evidencePathNodeIds: paths, ruleId: "same-proposition-opposed-polarity", reviewStatus: "pending" });
        addCandidate(builder, { id: stableUuid(`science-evidence-candidate:v1:contradiction:${sha256(key)}`), projectId, kind: "contradiction-candidate", nodeId: inference.id, label: "Contradiction candidate", rationale: "The same normalized proposition and conditioning context have exact supporting and contradicting evidence paths.", missingRequirements: ["human-context-review"], evidencePathNodeIds: paths, independentSourceVersionCount: new Set(paths.map((id) => builder.nodes.get(id)).filter((item) => item?.kind === "source-version").map((item) => item!.canonicalRef.id)).size, coverage: 1, relevance: 1, assessmentConfidence: 1, reviewStatus: "pending" });
      }
    }

    const retainedKinds = new Set(["user-proposed", "hypothesis-proposal"]);
    for (const retained of prior?.inferenceCandidates ?? []) {
      if (!retainedKinds.has(retained.kind)) continue;
      const retainedNode = prior!.nodes.find((item) => item.id === retained.nodeId);
      if (!retainedNode) continue;
      const validPaths = retained.evidencePathNodeIds.filter((id) => {
        const current = builder.nodes.get(id);
        return Boolean(current && current.epistemicStatus !== "invalidated");
      });
      const { contentSha256: _retainedNodeSha256, canonicalRef: _retainedCanonicalRef, ...retainedNodeUnsigned } = retainedNode;
      const copiedNode = addNode(builder, node({
        ...retainedNodeUnsigned,
        canonicalRef: {
          kind: "graph-inference-candidate",
          id: retainedNode.id,
          version: 1,
          contentSha256: scienceEvidenceGraphInferenceCanonicalContentSha256(retainedNodeUnsigned),
        },
      }));
      const { contentSha256: _retainedContentSha256, ...retainedUnsigned } = retained;
      const copied = addCandidate(builder, {
        ...retainedUnsigned,
        evidencePathNodeIds: validPaths,
        missingRequirements: validPaths.length === retained.evidencePathNodeIds.length
          ? retained.missingRequirements
          : [...new Set([...retained.missingRequirements, "stale-evidence-path"])],
      });
      for (const pathId of validPaths) {
        const parent = builder.nodes.get(pathId)!;
        const priorEdge = prior!.edges.find((item) => item.kind === "derived-from"
          && item.fromNodeId === retainedNode.id
          && item.toNodeId === pathId
          && ["user-proposed-inference", "retained-user-inference"].includes(item.derivation.ruleId));
        addEdge(builder, {
          kind: "derived-from",
          from: copiedNode,
          to: parent,
          evidencePathNodeIds: validPaths,
          ruleId: priorEdge?.derivation.ruleId ?? "retained-user-inference",
          producer: priorEdge?.derivation.producer,
          reviewStatus: copied.reviewStatus,
        });
      }
    }

    const contextualAssertions = [...builder.nodes.values()].filter((item) => item.normalizedProposition
      && (item.kind === "extracted-claim" || item.kind === "inference-candidate"));
    const contextualGroups = new Map<string, ScienceEvidenceGraphNode[]>();
    for (const assertion of contextualAssertions) {
      contextualGroups.set(assertion.normalizedProposition!, [...(contextualGroups.get(assertion.normalizedProposition!) ?? []), assertion]);
    }
    for (const [proposition, assertions] of contextualGroups) {
      const contexts = new Map(assertions.map((item) => [contextKey(item.conditioningContext), item.conditioningContext]));
      if (contexts.size < 2) continue;
      const paths = [...new Set(assertions.flatMap((item) => [...builder.candidates.values()].find((candidateValue) => candidateValue.nodeId === item.id)?.evidencePathNodeIds ?? []))]
        .filter((id) => builder.nodes.get(id)?.epistemicStatus !== "invalidated").sort();
      const qualifier = inferenceNode(builder, projectId, {
        key: `qualification:${sha256({ proposition, contexts: [...contexts.keys()].sort() })}`,
        label: "Context qualification",
        statement: `The same proposition appears under ${contexts.size} distinct conditioning contexts and must not be treated as an exact contradiction.`,
        normalizedProposition: proposition,
      });
      for (const assertion of assertions) {
        addEdge(builder, { kind: "qualifies", from: qualifier, to: assertion, evidencePathNodeIds: paths, ruleId: "same-proposition-different-context", reviewStatus: "pending" });
      }
      addCandidate(builder, {
        id: stableUuid(`science-evidence-candidate:v1:qualification:${projectId}:${sha256({ proposition, contexts: [...contexts.keys()].sort() })}`),
        projectId,
        kind: "qualification",
        nodeId: qualifier.id,
        label: "Conditioning contexts differ",
        rationale: "Population, intervention/exposure, comparator, outcome, timeframe, method, or dataset/setting differs. Review the context delta before reconciling the claims.",
        missingRequirements: ["human-context-review"],
        evidencePathNodeIds: paths,
        independentSourceVersionCount: new Set(paths.map((id) => builder.nodes.get(id)).filter((item) => item?.kind === "source-version").map((item) => item!.canonicalRef.id)).size,
        coverage: 1,
        relevance: 1,
        assessmentConfidence: 1,
        reviewStatus: "pending",
      });
    }

    return {
      nodes: [...builder.nodes.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)),
      edges: [...builder.edges.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)),
      inferenceCandidates: [...builder.candidates.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)),
    };
  }

  /**
   * Which nodes' pinned versions no longer match what they point at.
   *
   * Separated from the assertion because a WRITE and a READ need opposite things from this answer. A
   * write must refuse: building on a graph whose pins have moved records a claim about a state that
   * no longer exists. A read must not -- and it used to, for the whole graph, because of one node.
   *
   * Staleness here is not a fault, it is the normal consequence of a study progressing: a node
   * pinned to project v1 goes stale the moment the research contract is approved, which is a
   * required step. So the graph became permanently unreadable at the exact point every study passes
   * through, and the director could not even see WHICH pin had moved -- the read that would have
   * told it was the read that refused.
   */
  private canonicalStaleness(graph: ScienceEvidenceGraphRevision): Array<{ nodeId: string; kind: string; pinnedVersion: number | null; currentVersion: number | null }> {
    validateScienceResearchOntologyGraph(graph.nodes, graph.edges);
    const project = this.store.getProject(graph.projectId);
    if (!project) throw new Error("science-evidence-graph-project-not-found");
    const ledger = this.store.listProjectEvidenceLedger(graph.projectId);
    const messageBlockById = new Map(ledger.map((item) => [item.block.id, item.block]));
    const episodeById = new Map(this.store.listLoopSessions(graph.projectId).flatMap((session) => this.store.listResearchEpisodes(graph.projectId, session.id)).map((item) => [item.id, item]));
    const manuscriptsByVersionId = new Map(this.store.listManuscripts(graph.projectId, MAX_GRAPH_NODES).map((manuscript) => [manuscript.version.id, manuscript]));
    const manuscriptSentencesById = new Map([...manuscriptsByVersionId.values()]
      .flatMap((manuscript) => this.store.listManuscriptSentenceSnapshots(graph.projectId, manuscript.version.id))
      .map((sentence) => [sentence.id, sentence]));
    const stale: Array<{ nodeId: string; kind: string; pinnedVersion: number | null; currentVersion: number | null }> = [];
    const manuscriptClaimsById = new Map([...manuscriptsByVersionId.values()].flatMap((manuscript) => {
      const claimLedger = this.store.getClaimLedgerForManuscript(graph.projectId, manuscript.id);
      return claimLedger?.manifest.claims ?? [];
    }).map((claim) => [claim.claimId, claim]));
    for (const value of graph.nodes) {
      const ref = value.canonicalRef;
      let currentSha256: string | null = null;
      let currentVersion: number | null = null;
      if (ref.kind === "project" && ref.id === project.id) { currentVersion = project.version; currentSha256 = projectContent(project); }
      else if (ref.kind === "source-version") {
        const source = this.store.listSources(graph.projectId, MAX_GRAPH_NODES).find((item) => item.version.id === ref.id);
        currentVersion = source?.version.version ?? null; currentSha256 = source ? scienceEvidenceGraphSourceVersionContentSha256(source) : null;
      } else if (ref.kind === "evidence-span") {
        const evidence = this.store.getEvidenceSpanForProject(graph.projectId, ref.id);
        currentVersion = evidence ? 1 : null; currentSha256 = evidence ? evidenceSpanContent(evidence) : null;
      } else if (ref.kind === "message-block") {
        const block = messageBlockById.get(ref.id); currentVersion = block ? 1 : null; currentSha256 = block?.contentSha256 ?? null;
      } else if (ref.kind === "hypothesis") {
        const hypothesis = this.store.getHypothesisForProject(graph.projectId, ref.id); currentVersion = hypothesis?.version ?? null; currentSha256 = hypothesis?.contentSha256 ?? null;
      } else if (ref.kind === "analysis-plan-version") {
        const plan = this.store.listAnalysisSpecs(graph.projectId, MAX_GRAPH_NODES).find((item) => item.version.id === ref.id); currentVersion = plan?.version.version ?? null; currentSha256 = plan?.version.documentSha256 ?? null;
      } else if (ref.kind === "research-run") {
        const run = this.store.getResearchRunForProject(graph.projectId, ref.id); currentVersion = run ? 1 : null; currentSha256 = run ? researchRunContent(run) : null;
      } else if (ref.kind === "artifact-version") {
        const artifact = this.store.getArtifactContextForProject(graph.projectId, ref.id, ref.version); currentVersion = artifact?.selectedVersion.version ?? null; currentSha256 = artifact?.selectedVersion.contentSha256 ?? null;
      } else if (ref.kind === "episode-result") {
        const episode = episodeById.get(ref.id); currentVersion = episode?.version ?? null; currentSha256 = episode?.result?.resultSha256 ?? null;
      } else if (ref.kind === "research-lifecycle-revision") {
        const lifecycle = this.store.getResearchLifecycleForProject(graph.projectId);
        const revision = lifecycle ? this.store.listResearchLifecycleRevisions(graph.projectId, lifecycle.studyId).find((item) => item.id === ref.id) : null;
        currentVersion = revision?.revision ?? null; currentSha256 = revision?.contentSha256 ?? null;
      } else if (ref.kind === "artifact-validation-receipt") {
        const receipt = this.store.getArtifactValidationReceiptForProject(graph.projectId, ref.id);
        currentVersion = receipt ? 1 : null; currentSha256 = receipt?.receiptSha256 ?? null;
      } else if (ref.kind === "manuscript-version") {
        const manuscript = manuscriptsByVersionId.get(ref.id);
        currentVersion = manuscript?.currentVersion ?? null; currentSha256 = manuscript?.version.contentSha256 ?? null;
      } else if (ref.kind === "manuscript-sentence") {
        const sentence = manuscriptSentencesById.get(ref.id);
        currentVersion = sentence ? 1 : null; currentSha256 = sentence?.contentSha256 ?? null;
      } else if (ref.kind === "claim-ledger-claim") {
        const claim = manuscriptClaimsById.get(ref.id);
        currentVersion = claim ? 1 : null; currentSha256 = claim?.contentSha256 ?? null;
      } else if (ref.kind === "graph-inference-candidate") {
        currentVersion = ref.id === value.id && value.kind === "inference-candidate" ? 1 : null;
        currentSha256 = currentVersion ? scienceEvidenceGraphInferenceCanonicalContentSha256(value) : null;
      }
      if (currentVersion !== ref.version || currentSha256 !== ref.contentSha256) {
        stale.push({ nodeId: value.id, kind: String(ref.kind), pinnedVersion: ref.version ?? null, currentVersion });
      }
    }
    return stale;
  }

  /** Refuses a graph whose pins have moved. For writes only: a read reports staleness instead. */
  private assertCanonicalGraph(graph: ScienceEvidenceGraphRevision): void {
    if (this.canonicalStaleness(graph).length) throw new Error("science-evidence-graph-canonical-ref-stale");
  }

  /**
   * Reads the graph, and SAYS which pins have moved rather than refusing to answer.
   *
   * This used to throw for the whole graph when any node's pin had moved -- which happens the moment
   * a study progresses -- so the evidence graph became unreadable at the point every study passes
   * through, and nothing could report which node it was. Writes still refuse (see the assertion),
   * because building on moved pins records a claim about a state that no longer exists.
   */
  get(projectId: string): { graph: ScienceEvidenceGraphRevision | null; reviews: ScienceEvidenceGraphInferenceReview[]; staleNodes: Array<{ nodeId: string; kind: string; pinnedVersion: number | null; currentVersion: number | null }> } {
    const graph = this.store.latestEvidenceGraphRevision(projectId);
    const staleNodes = graph ? this.canonicalStaleness(graph) : [];
    return { graph, reviews: this.store.listEvidenceGraphInferenceReviews(projectId), staleNodes };
  }

  refresh(input: RefreshScienceEvidenceGraphInput): RefreshScienceEvidenceGraphResult {
    const prior = this.store.latestEvidenceGraphRevision(input.projectId);
    if (input.expectedRevision !== undefined && input.expectedRevision !== null && prior?.revision !== input.expectedRevision) throw new Error("science-evidence-graph-revision-stale");
    if (input.expectedContentSha256 !== undefined && input.expectedContentSha256 !== null && prior?.contentSha256 !== input.expectedContentSha256) throw new Error("science-evidence-graph-content-stale");
    const now = new Date().toISOString();
    const projection = this.graphWithCanonicalRefs(input.projectId, prior, now);
    validateScienceResearchOntologyGraph(projection.nodes, projection.edges);
    const projectionSha256 = scienceEvidenceGraphProjectionContentSha256(projection);
    if (prior?.projectionSha256 === projectionSha256) return { graph: prior, replayed: true };
    const unsigned: Omit<ScienceEvidenceGraphRevision, "contentSha256"> = {
      schema: "agentlas.science.evidence-graph/v1",
      id: randomUUID(),
      projectId: input.projectId,
      revision: (prior?.revision ?? 0) + 1,
      previousRevisionSha256: prior?.contentSha256 ?? null,
      projectionSha256,
      nodes: projection.nodes,
      edges: projection.edges,
      inferenceCandidates: projection.inferenceCandidates,
      summary: summary(projection.nodes, projection.edges, projection.inferenceCandidates),
      createdAt: now,
    };
    const graph = this.store.appendEvidenceGraphRevision({ ...unsigned, contentSha256: scienceEvidenceGraphRevisionContentSha256(unsigned) });
    return { graph, replayed: false };
  }

  listCandidates(projectId: string): Array<ScienceEvidenceGraphInferenceCandidate & { review: ScienceEvidenceGraphInferenceReview | null }> {
    const { graph, reviews } = this.get(projectId);
    if (!graph) return [];
    const latest = latestReviewMap(reviews);
    return graph.inferenceCandidates.map((item) => {
      const review = latest.get(item.id);
      // Rejection is sticky for the stable candidate identity so refresh cannot resurrect work
      // the researcher declined. Acceptance is exact-content only: changed evidence or missing
      // requirements must be reviewed again before the successor can drive research work.
      return { ...item, review: review?.decision === "rejected" || review?.candidateContentSha256 === item.contentSha256 ? review : null };
    });
  }

  proposeInference(input: ProposeScienceEvidenceGraphInferenceInput): RefreshScienceEvidenceGraphResult {
    const current = this.store.latestEvidenceGraphRevision(input.projectId);
    if (!current || current.revision !== input.expectedGraphRevision || current.contentSha256 !== input.expectedGraphContentSha256) throw new Error("science-evidence-graph-revision-stale");
    this.assertCanonicalGraph(current);
    const label = safeText(input.label, 500, "science-evidence-graph-inference-label-invalid");
    const statement = safeText(input.statement, 20_000, "science-evidence-graph-inference-statement-invalid");
    const rationale = safeText(input.rationale, 20_000, "science-evidence-graph-inference-rationale-invalid");
    const normalizedProposition = safeText(input.normalizedProposition, 2_000, "science-evidence-graph-inference-proposition-invalid");
    const context = exactContext(input.conditioningContext);
    const evidencePathNodeIds = [...new Set(input.evidencePathNodeIds)].sort();
    const nodesById = new Map(current.nodes.map((item) => [item.id, item]));
    if (evidencePathNodeIds.some((id) => !nodesById.has(id))) throw new Error("science-evidence-graph-inference-evidence-orphan");
    if (!Array.isArray(input.falsificationCriteria) || input.falsificationCriteria.length < 1 || input.falsificationCriteria.length > 50) throw new Error("science-evidence-graph-inference-falsification-invalid");
    input.falsificationCriteria.forEach((item) => safeText(item, 2_000, "science-evidence-graph-inference-falsification-invalid"));
    const alternative = safeText(input.alternativeHypothesis, 10_000, "science-evidence-graph-inference-alternative-invalid");
    if (evidencePathNodeIds.some((id) => nodesById.get(id)?.epistemicStatus === "invalidated")) throw new Error("science-evidence-graph-inference-evidence-invalidated");
    const sourceCount = new Set(evidencePathNodeIds.flatMap((id) => {
      const value = nodesById.get(id);
      if (value?.kind === "source-version") return [value.canonicalRef.id];
      if (value?.kind === "evidence-span") {
        const evidence = this.store.getEvidenceSpanForProject(input.projectId, value.canonicalRef.id);
        return evidence ? [evidence.sourceVersionId] : [];
      }
      return [];
    })).size;
    const key = sha256({ statement, normalizedProposition, context, evidencePathNodeIds, rationale, falsificationCriteria: input.falsificationCriteria, alternative, producer: input.producer });
    const candidateId = stableUuid(`science-evidence-candidate:v1:user-proposed:${input.projectId}:${key}`);
    if (current.inferenceCandidates.some((item) => item.id === candidateId)) return { graph: current, replayed: true };
    const candidateNodeId = stableUuid(`science-evidence-inference-node:v1:${input.projectId}:user-proposed:${key}`);
    const candidateNodeUnsigned: Omit<ScienceEvidenceGraphNode, "canonicalRef" | "contentSha256"> = {
      id: candidateNodeId,
      projectId: input.projectId,
      kind: "inference-candidate",
      assertionKind: "inference",
      epistemicStatus: "candidate",
      label,
      statement,
      normalizedProposition,
      polarity: input.polarity,
      conditioningContext: context,
      evidenceScope: input.producer.kind === "human" ? "human" : "system",
    };
    const candidateNode = node({
      ...candidateNodeUnsigned,
      canonicalRef: {
        kind: "graph-inference-candidate",
        id: candidateNodeId,
        version: 1,
        contentSha256: scienceEvidenceGraphInferenceCanonicalContentSha256(candidateNodeUnsigned),
      },
    });
    const missingRequirements = [
      ...(sourceCount < 2 ? ["two-independent-source-paths"] : []),
      ...(evidencePathNodeIds.length === 0 ? ["exact-evidence-path"] : []),
      "human-review",
    ];
    const proposed = candidate({
      id: candidateId,
      projectId: input.projectId,
      kind: "user-proposed",
      nodeId: candidateNode.id,
      label,
      rationale: `${rationale} Falsification: ${input.falsificationCriteria.join(" | ")}. Alternative: ${alternative}`,
      missingRequirements,
      evidencePathNodeIds,
      independentSourceVersionCount: sourceCount,
      coverage: Math.min(1, sourceCount / 2),
      relevance: 1,
      assessmentConfidence: evidencePathNodeIds.length ? 0.75 : 0,
      reviewStatus: "pending",
      materializationProposal: {
        statement,
        rationale,
        falsificationCriteria: input.falsificationCriteria.map((item) => safeText(item, 2_000, "science-evidence-graph-inference-falsification-invalid")),
        alternativeHypothesis: alternative,
      },
    });
    const now = new Date().toISOString();
    const nodes = [...current.nodes, candidateNode].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    const newEdges = evidencePathNodeIds.map((id) => {
      const parent = nodesById.get(id)!;
      return edge({
        id: stableUuid(`science-evidence-edge:v1:derived-from:${candidateNode.id}:${parent.id}:user-proposed-inference:${evidencePathNodeIds.join(",")}`),
        projectId: input.projectId,
        kind: "derived-from",
        fromNodeId: candidateNode.id,
        toNodeId: parent.id,
        fromContentSha256: candidateNode.contentSha256,
        toContentSha256: parent.contentSha256,
        evidencePathNodeIds,
        derivation: { parentNodeIds: [candidateNode.id, parent.id], parentContentSha256: [candidateNode.contentSha256, parent.contentSha256], ruleId: "user-proposed-inference", ruleVersion: "1.0.0", producer: input.producer, reviewStatus: "pending", createdAt: now },
      });
    });
    const edges = [...current.edges, ...newEdges].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    const inferenceCandidates = [...current.inferenceCandidates, proposed].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    const projectionSha256 = scienceEvidenceGraphProjectionContentSha256({ nodes, edges, inferenceCandidates });
    const unsigned: Omit<ScienceEvidenceGraphRevision, "contentSha256"> = {
      schema: "agentlas.science.evidence-graph/v1",
      id: randomUUID(),
      projectId: input.projectId,
      revision: current.revision + 1,
      previousRevisionSha256: current.contentSha256,
      projectionSha256,
      nodes,
      edges,
      inferenceCandidates,
      summary: summary(nodes, edges, inferenceCandidates),
      createdAt: now,
    };
    return { graph: this.store.appendEvidenceGraphRevision({ ...unsigned, contentSha256: scienceEvidenceGraphRevisionContentSha256(unsigned) }), replayed: false };
  }

  reviewInference(input: ReviewScienceEvidenceGraphInferenceInput): { review: ScienceEvidenceGraphInferenceReview; replayed: boolean } {
    const graph = this.store.getEvidenceGraphRevisionForProject(input.projectId, input.graphRevisionId);
    if (!graph || graph.contentSha256 !== input.expectedGraphContentSha256) throw new Error("science-evidence-graph-review-graph-stale");
    this.assertCanonicalGraph(graph);
    const candidateValue = graph.inferenceCandidates.find((item) => item.id === input.candidateId);
    if (!candidateValue || candidateValue.contentSha256 !== input.expectedCandidateContentSha256) throw new Error("science-evidence-graph-review-candidate-stale");
    const rationale = safeText(input.rationale, 20_000, "science-evidence-graph-review-rationale-invalid");
    const prior = this.store.listEvidenceGraphInferenceReviews(input.projectId, input.candidateId).at(-1) ?? null;
    if (prior?.decision === input.decision && prior.rationale === rationale && prior.candidateContentSha256 === candidateValue.contentSha256) return { review: prior, replayed: true };
    const unsigned: Omit<ScienceEvidenceGraphInferenceReview, "reviewSha256"> = {
      schema: "agentlas.science.evidence-graph-inference-review/v1",
      id: randomUUID(),
      projectId: input.projectId,
      graphRevisionId: graph.id,
      graphRevisionSha256: graph.contentSha256,
      candidateId: candidateValue.id,
      candidateContentSha256: candidateValue.contentSha256,
      revision: (prior?.revision ?? 0) + 1,
      previousReviewSha256: prior?.reviewSha256 ?? null,
      decision: input.decision,
      rationale,
      reviewer: input.reviewer,
      createdAt: new Date().toISOString(),
    };
    return { review: this.store.appendEvidenceGraphInferenceReview({ ...unsigned, reviewSha256: scienceEvidenceGraphReviewContentSha256(unsigned) }), replayed: false };
  }

  materializeInferenceAsHypothesis(input: MaterializeScienceEvidenceGraphInferenceInput): {
    materialization: ScienceEvidenceGraphInferenceMaterialization;
    hypothesis: ScienceHypothesis;
    replayed: boolean;
  } {
    const graph = this.store.latestEvidenceGraphRevision(input.projectId);
    if (!graph || graph.id !== input.graphRevisionId || graph.contentSha256 !== input.expectedGraphContentSha256) {
      throw new Error("science-evidence-graph-materialization-graph-stale");
    }
    this.assertCanonicalGraph(graph);
    const candidateValue = graph.inferenceCandidates.find((item) => item.id === input.candidateId);
    if (!candidateValue || candidateValue.contentSha256 !== input.expectedCandidateContentSha256
      || !candidateValue.materializationProposal || !["user-proposed", "hypothesis-proposal"].includes(candidateValue.kind)) {
      throw new Error("science-evidence-graph-materialization-candidate-stale");
    }
    const review = this.store.listEvidenceGraphInferenceReviews(input.projectId, candidateValue.id).at(-1) ?? null;
    if (!review || review.decision !== "accepted" || review.reviewer.kind !== "human"
      || review.candidateContentSha256 !== candidateValue.contentSha256 || review.reviewSha256 !== input.expectedReviewSha256) {
      throw new Error("science-evidence-graph-materialization-human-acceptance-required");
    }
    const nodesById = new Map(graph.nodes.map((item) => [item.id, item]));
    const evidenceSpanIds = [...new Set(candidateValue.evidencePathNodeIds.flatMap((id) => {
      const graphNode = nodesById.get(id);
      return graphNode?.kind === "evidence-span" && graphNode.epistemicStatus !== "invalidated" ? [graphNode.canonicalRef.id] : [];
    }))].sort();
    if (!evidenceSpanIds.length || candidateValue.evidencePathNodeIds.some((id) => nodesById.get(id)?.epistemicStatus === "invalidated")) {
      throw new Error("science-evidence-graph-materialization-evidence-invalid");
    }
    const prior = this.store.getEvidenceGraphInferenceMaterialization(input.projectId, candidateValue.id, candidateValue.contentSha256);
    if (prior) {
      const hypothesis = this.store.getHypothesisForProject(input.projectId, prior.target.id);
      if (!hypothesis || hypothesis.version !== prior.target.version || hypothesis.contentSha256 !== prior.target.contentSha256) {
        throw new Error("science-evidence-graph-materialization-target-stale");
      }
      return { materialization: prior, hypothesis, replayed: true };
    }
    const proposal = candidateValue.materializationProposal;
    const hypothesisResult = this.store.proposeHypothesis({
      requestId: stableUuid(`science-evidence-materialize-hypothesis:v1:${input.requestId}:${candidateValue.id}:${candidateValue.contentSha256}`),
      projectId: input.projectId,
      contractId: input.contractId,
      role: input.role,
      statement: proposal.statement,
      rationale: `${proposal.rationale} Accepted graph inference ${candidateValue.id}; alternative: ${proposal.alternativeHypothesis}`,
      falsificationCriteria: proposal.falsificationCriteria,
      evidenceSpanIds,
      episodeResultIds: [],
    });
    const now = new Date().toISOString();
    const unsigned: Omit<ScienceEvidenceGraphInferenceMaterialization, "contentSha256"> = {
      schema: "agentlas.science.evidence-graph-inference-materialization/v1",
      id: stableUuid(`science-evidence-materialization:v1:${input.projectId}:${candidateValue.id}:${candidateValue.contentSha256}:hypothesis`),
      projectId: input.projectId,
      graphRevisionId: graph.id,
      graphRevisionSha256: graph.contentSha256,
      candidateId: candidateValue.id,
      candidateContentSha256: candidateValue.contentSha256,
      reviewId: review.id,
      reviewSha256: review.reviewSha256,
      target: { kind: "hypothesis", id: hypothesisResult.hypothesis.id, version: hypothesisResult.hypothesis.version, contentSha256: hypothesisResult.hypothesis.contentSha256 },
      createdAt: now,
    };
    const materialization = this.store.appendEvidenceGraphInferenceMaterialization({ ...unsigned, contentSha256: sha256(unsigned) });
    return { materialization, hypothesis: hypothesisResult.hypothesis, replayed: hypothesisResult.replayed };
  }

  explainPath(projectId: string, fromNodeId: string, toNodeId: string): ScienceEvidenceGraphPathExplanation {
    const graph = this.store.latestEvidenceGraphRevision(projectId);
    if (!graph) throw new Error("science-evidence-graph-missing");
    // A read does not refuse a graph whose pins have moved -- that is the normal consequence of a
    // study progressing, and refusing made the graph unreadable at the point every study passes
    // through. Staleness is reported by get(), whose result is not content-hashed; this payload is,
    // so the list is not added here rather than changing what its receipt covers.
    const nodeIds = new Set(graph.nodes.map((item) => item.id));
    if (!nodeIds.has(fromNodeId) || !nodeIds.has(toNodeId)) throw new Error("science-evidence-graph-path-node-invalid");
    const queue: Array<{ nodeId: string; nodes: string[]; edges: string[] }> = [{ nodeId: fromNodeId, nodes: [fromNodeId], edges: [] }];
    const visited = new Set([fromNodeId]);
    let found: { nodes: string[]; edges: string[] } | null = null;
    while (queue.length && !found) {
      const current = queue.shift()!;
      for (const nextEdge of graph.edges.filter((item) => item.fromNodeId === current.nodeId)) {
        const next = nextEdge.toNodeId;
        if (visited.has(next)) continue;
        const path = { nodeId: next, nodes: [...current.nodes, next], edges: [...current.edges, nextEdge.id] };
        if (next === toNodeId) { found = path; break; }
        visited.add(next); queue.push(path);
      }
    }
    const blockedBy = found ? [] : ["no-connected-exact-edge-path"];
    const unsigned = { schema: "agentlas.science.evidence-graph-path/v1" as const, projectId, graphRevisionId: graph.id, fromNodeId, toNodeId, found: Boolean(found), nodeIds: found?.nodes ?? [], edgeIds: found?.edges ?? [], blockedBy };
    return { ...unsigned, contentSha256: sha256(unsigned) };
  }

  boundedContext(projectId: string, query: string, limit = 40, options: ScienceEvidenceGraphBoundedContextOptions = {}): ScienceEvidenceGraphBoundedSubgraph | null {
    const graph = this.store.latestEvidenceGraphRevision(projectId);
    if (!graph) return null;
    // A read does not refuse a graph whose pins have moved -- that is the normal consequence of a
    // study progressing, and refusing made the graph unreadable at the point every study passes
    // through. Staleness is reported by get(), whose result is not content-hashed; this payload is,
    // so the list is not added here rather than changing what its receipt covers.
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || !options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some((key) => !["direction", "edgeKinds", "maxHops", "maxSeeds", "maxNodes", "maxEdges"].includes(key))) {
      throw new Error("science-evidence-graph-query-budget-invalid");
    }
    if (options.direction !== undefined && !["outgoing", "incoming", "both"].includes(options.direction)) {
      throw new Error("science-evidence-graph-traversal-direction-invalid");
    }
    if (options.edgeKinds !== undefined && (!Array.isArray(options.edgeKinds) || options.edgeKinds.length < 1
      || options.edgeKinds.length > SCIENCE_EVIDENCE_GRAPH_EDGE_KINDS.length
      || new Set(options.edgeKinds).size !== options.edgeKinds.length
      || options.edgeKinds.some((kind) => !SCIENCE_EVIDENCE_GRAPH_EDGE_KINDS.includes(kind)))) {
      throw new Error("science-evidence-graph-traversal-edge-kind-invalid");
    }
    const boundedInteger = (value: number | undefined, fallback: number, minimum: number, maximum: number): number => {
      const resolved = value ?? fallback;
      if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) throw new Error("science-evidence-graph-query-budget-invalid");
      return resolved;
    };
    const latestReviews = latestReviewMap(this.store.listEvidenceGraphInferenceReviews(projectId));
    const reviewedCandidates = graph.inferenceCandidates.map((item) => {
      const storedReview = latestReviews.get(item.id) ?? null;
      const review = storedReview?.decision === "rejected" || storedReview?.candidateContentSha256 === item.contentSha256
        ? storedReview
        : null;
      return {
        ...item,
        reviewStatus: review?.decision ?? item.reviewStatus,
        review,
      };
    });
    const nonInvalidatedNodeIds = new Set(graph.nodes.filter((item) => item.epistemicStatus !== "invalidated").map((item) => item.id));
    const rejectedNodeIds = new Set(reviewedCandidates
      .filter((item) => item.reviewStatus === "rejected" || item.missingRequirements.includes("stale-evidence-path")
        || item.evidencePathNodeIds.some((id) => !nonInvalidatedNodeIds.has(id)))
      .map((item) => item.nodeId));
    const usableNodeIds = new Set(graph.nodes
      .filter((item) => item.epistemicStatus !== "invalidated" && !rejectedNodeIds.has(item.id))
      .map((item) => item.id));
    const normalizedQuery = normalizeProposition(query);
    const tokens = new Set(normalizedQuery.split(" ").filter((item) => item.length > 1));
    const boundedLimit = boundedInteger(options.maxNodes, Math.max(4, limit), 4, 100);
    const maxSeeds = boundedInteger(options.maxSeeds, Math.min(12, boundedLimit), 1, Math.min(24, boundedLimit));
    const maxEdges = boundedInteger(options.maxEdges, Math.min(400, boundedLimit * 4), 1, 400);
    const maxHops = boundedInteger(options.maxHops, 3, 1, 6);
    const direction = options.direction ?? "both";
    const requestedEdgeKinds = options.edgeKinds?.length ? new Set(options.edgeKinds) : null;
    const scored = graph.nodes.filter((item) => usableNodeIds.has(item.id)).map((item) => {
      const haystack = normalizeProposition(`${item.label} ${item.statement} ${item.normalizedProposition ?? ""}`);
      const score = [...tokens].filter((token) => haystack.includes(token)).length;
      return { item, score };
    }).sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
    const literatureSearch = this.store.searchSourceTextChunks(projectId, query, Math.min(24, boundedLimit));
    const sourceNodeByVersionId = new Map(graph.nodes
      .filter((item) => item.kind === "source-version" && usableNodeIds.has(item.id))
      .map((item) => [item.canonicalRef.id, item]));
    const evidenceNodesBySourceVersionId = new Map<string, ScienceEvidenceGraphNode[]>();
    for (const edgeValue of graph.edges.filter((item) => item.kind === "derived-from")) {
      const evidenceNode = graph.nodes.find((item) => item.id === edgeValue.fromNodeId && item.kind === "evidence-span");
      const sourceNode = graph.nodes.find((item) => item.id === edgeValue.toNodeId && item.kind === "source-version");
      if (evidenceNode && sourceNode && usableNodeIds.has(evidenceNode.id) && usableNodeIds.has(sourceNode.id)) {
        evidenceNodesBySourceVersionId.set(sourceNode.canonicalRef.id, [...(evidenceNodesBySourceVersionId.get(sourceNode.canonicalRef.id) ?? []), evidenceNode]);
      }
    }
    const lexicalWeights = new Map(scored.filter((item) => item.score > 0).map((item) => [item.item.id, item.score]));
    for (const chunk of literatureSearch.chunks) {
      const sourceNode = sourceNodeByVersionId.get(chunk.sourceVersionId);
      if (sourceNode) lexicalWeights.set(sourceNode.id, (lexicalWeights.get(sourceNode.id) ?? 0) + 4);
    }
    const rankableEdges = graph.edges.filter((item) => usableNodeIds.has(item.fromNodeId) && usableNodeIds.has(item.toNodeId));
    const neighbors = new Map<string, Set<string>>();
    for (const value of rankableEdges) {
      neighbors.set(value.fromNodeId, new Set([...(neighbors.get(value.fromNodeId) ?? []), value.toNodeId]));
      neighbors.set(value.toNodeId, new Set([...(neighbors.get(value.toNodeId) ?? []), value.fromNodeId]));
    }
    const weightTotal = [...lexicalWeights.values()].reduce((sum, value) => sum + value, 0);
    let ranks = new Map([...lexicalWeights].map(([id, value]) => [id, value / Math.max(1, weightTotal)]));
    const teleport = new Map(ranks);
    for (let iteration = 0; iteration < 12; iteration += 1) {
      const next = new Map<string, number>();
      for (const [id, value] of teleport) next.set(id, (next.get(id) ?? 0) + 0.15 * value);
      for (const [id, value] of ranks) {
        const adjacent = [...(neighbors.get(id) ?? [])].sort();
        if (!adjacent.length) {
          for (const [seedId, seedWeight] of teleport) next.set(seedId, (next.get(seedId) ?? 0) + 0.85 * value * seedWeight);
          continue;
        }
        for (const neighbor of adjacent) next.set(neighbor, (next.get(neighbor) ?? 0) + (0.85 * value) / adjacent.length);
      }
      ranks = next;
    }
    const seedNodeIds = [...ranks].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, maxSeeds).map(([id]) => id);
    const selected = new Set(seedNodeIds);
    let budgetTruncated = ranks.size > maxSeeds || literatureSearch.truncated;
    for (const candidateValue of reviewedCandidates.filter((item) => item.reviewStatus !== "rejected").slice(0, 10)) {
      if (rejectedNodeIds.has(candidateValue.nodeId)) continue;
      const closure = [candidateValue.nodeId, ...candidateValue.evidencePathNodeIds.filter((id) => usableNodeIds.has(id)).slice(0, 10)];
      const additions = closure.filter((id) => !selected.has(id));
      if (selected.size + additions.length > boundedLimit) { budgetTruncated = true; continue; }
      additions.forEach((id) => selected.add(id));
    }

    // Retrieval must use the graph, not merely return independently matching labels. Expand
    // through both incoming and outgoing exact relations so a selected claim carries its
    // evidence span and SourceVersion, and a selected result carries its run/plan lineage.
    const usableEdges = graph.edges.filter((item) => (!requestedEdgeKinds || requestedEdgeKinds.has(item.kind))
      && usableNodeIds.has(item.fromNodeId)
      && usableNodeIds.has(item.toNodeId)
      && !item.evidencePathNodeIds.some((id) => !usableNodeIds.has(id)));
    const edgePriority: Record<ScienceEvidenceGraphEdgeKind, number> = {
      "supports": 0, "contradicts": 0, "qualifies": 0, "extracted-from": 0,
      "derived-from": 1, "tests": 1, "operationalizes": 1, "uses-input": 1,
      "produced": 1, "addresses": 1, "cites": 2, "identifies-gap": 2,
      "supersedes": 3, "invalidated-by": 3,
    };
    const incident = new Map<string, ScienceEvidenceGraphEdge[]>();
    for (const edgeValue of usableEdges) {
      if (direction !== "incoming") incident.set(edgeValue.fromNodeId, [...(incident.get(edgeValue.fromNodeId) ?? []), edgeValue]);
      if (direction !== "outgoing") incident.set(edgeValue.toNodeId, [...(incident.get(edgeValue.toNodeId) ?? []), edgeValue]);
    }
    const queue = [...selected].map((nodeId) => ({ nodeId, depth: 0 }));
    const expanded = new Set(selected);
    let consumedHops = 0;
    while (queue.length && expanded.size < boundedLimit) {
      const current = queue.shift()!;
      consumedHops = Math.max(consumedHops, current.depth);
      if (current.depth >= maxHops) continue;
      const nextEdges = [...(incident.get(current.nodeId) ?? [])].sort((a, b) => edgePriority[a.kind] - edgePriority[b.kind] || a.id.localeCompare(b.id));
      for (const edgeValue of nextEdges) {
        const nextNodeId = edgeValue.fromNodeId === current.nodeId ? edgeValue.toNodeId : edgeValue.fromNodeId;
        if (expanded.has(nextNodeId)) continue;
        expanded.add(nextNodeId);
        queue.push({ nodeId: nextNodeId, depth: current.depth + 1 });
        if (expanded.size >= boundedLimit) { budgetTruncated = true; break; }
      }
    }
    if (queue.length && expanded.size >= boundedLimit) budgetTruncated = true;
    const allSelectedEdges = usableEdges.filter((item) => expanded.has(item.fromNodeId) && expanded.has(item.toNodeId))
      .sort((a, b) => edgePriority[a.kind] - edgePriority[b.kind] || a.id.localeCompare(b.id));
    if (allSelectedEdges.length > maxEdges) budgetTruncated = true;
    const edges = allSelectedEdges.slice(0, maxEdges);
    const nodes = graph.nodes.filter((item) => expanded.has(item.id));
    const inferenceCandidates = reviewedCandidates.filter((item) => item.reviewStatus !== "rejected"
      && !rejectedNodeIds.has(item.nodeId) && expanded.has(item.nodeId));
    const reviews = inferenceCandidates.map((item) => item.review).filter((item): item is ScienceEvidenceGraphInferenceReview => Boolean(item));
    const literatureChunks = literatureSearch.chunks.filter((item) => sourceNodeByVersionId.has(item.sourceVersionId));
    const chunkBindings = literatureChunks.map((chunk) => {
      const sourceNode = sourceNodeByVersionId.get(chunk.sourceVersionId)!;
      const evidenceSpanNodeIds = (evidenceNodesBySourceVersionId.get(chunk.sourceVersionId) ?? [])
        .filter((node) => {
          const evidence = this.store.getEvidenceSpanForProject(projectId, node.canonicalRef.id);
          return evidence && evidence.startByte < chunk.endByte && evidence.endByte > chunk.startByte;
        })
        .map((node) => node.id)
        .sort();
      return { chunkId: chunk.id, chunkContentSha256: chunk.contentSha256, sourceVersionNodeId: sourceNode.id, evidenceSpanNodeIds };
    });
    const missing = [...(budgetTruncated || literatureSearch.truncated ? ["query-budget-exhausted"] : []),
      ...(literatureChunks.some((item) => item.evidenceScope === "abstract") ? ["abstract-only-source"] : []),
      ...inferenceCandidates.flatMap((item) => item.missingRequirements)]
      .filter((item, index, array) => array.indexOf(item) === index).slice(0, 50);
    const traversal = {
      seedMatcher: "hybrid-fts-token-ppr/v1" as const,
      direction,
      edgeKinds: [...(requestedEdgeKinds ?? new Set(SCIENCE_EVIDENCE_GRAPH_EDGE_KINDS))].sort() as ScienceEvidenceGraphEdgeKind[],
      maxHops,
      budget: { maxSeeds, maxNodes: boundedLimit, maxEdges },
      consumed: { seeds: seedNodeIds.length, nodes: nodes.length, edges: edges.length, hops: consumedHops },
      truncated: budgetTruncated,
    };
    const unsigned = { schema: "agentlas.science.evidence-graph-bounded-context/v1" as const, projectId, graphRevisionId: graph.id, graphRevisionSha256: graph.contentSha256, query: safeText(query, 2_000, "science-evidence-graph-query-invalid"), traversal, nodes, edges, inferenceCandidates, reviews, literatureChunks, chunkBindings, missing };
    return { ...unsigned, contentSha256: sha256(unsigned) };
  }
}
