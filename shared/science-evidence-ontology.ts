import type {
  ScienceEvidenceGraphEdge,
  ScienceEvidenceGraphEdgeKind,
  ScienceEvidenceGraphNode,
  ScienceEvidenceGraphNodeKind,
} from "./science-evidence-graph";

export const SCIENCE_RESEARCH_ONTOLOGY_SCHEMA = "agentlas.science.research-ontology/v1" as const;
export const SCIENCE_RESEARCH_ONTOLOGY_VERSION = "2026-09-01" as const;
export const SCIENCE_RESEARCH_ONTOLOGY_NAMESPACE =
  `https://agentlas.ai/ns/science/research/${SCIENCE_RESEARCH_ONTOLOGY_VERSION}#` as const;

type NodeClass = {
  iri: string;
  alignsWith: readonly string[];
};

type RelationShape = {
  iri: string;
  from: readonly ScienceEvidenceGraphNodeKind[];
  to: readonly ScienceEvidenceGraphNodeKind[];
  requiresEvidencePath: boolean;
};

const ALL_NODE_KINDS = [
  "research-question", "concept", "variable", "source-version", "evidence-span", "extracted-claim",
  "hypothesis", "analysis-plan-version", "research-run", "artifact-version", "episode-result",
  "inference-candidate", "conclusion", "manuscript-version", "manuscript-sentence", "manuscript-claim",
] as const satisfies readonly ScienceEvidenceGraphNodeKind[];

const ASSERTION_KINDS = [
  "extracted-claim", "hypothesis", "episode-result", "inference-candidate", "conclusion", "manuscript-claim",
] as const satisfies readonly ScienceEvidenceGraphNodeKind[];

export const SCIENCE_RESEARCH_ONTOLOGY_NODE_CLASSES: Record<ScienceEvidenceGraphNodeKind, NodeClass> = {
  "research-question": { iri: `${SCIENCE_RESEARCH_ONTOLOGY_NAMESPACE}ResearchQuestion`, alignsWith: ["https://orkg.org/orkg/class/ResearchProblem"] },
  concept: { iri: `${SCIENCE_RESEARCH_ONTOLOGY_NAMESPACE}Concept`, alignsWith: ["http://www.w3.org/2002/07/owl#Class"] },
  variable: { iri: `${SCIENCE_RESEARCH_ONTOLOGY_NAMESPACE}Variable`, alignsWith: ["http://purl.obolibrary.org/obo/STATO_0000258"] },
  "source-version": { iri: `${SCIENCE_RESEARCH_ONTOLOGY_NAMESPACE}SourceVersion`, alignsWith: ["http://www.w3.org/ns/prov#Entity", "https://schema.org/ScholarlyArticle"] },
  "evidence-span": { iri: `${SCIENCE_RESEARCH_ONTOLOGY_NAMESPACE}EvidenceSpan`, alignsWith: ["http://www.w3.org/ns/prov#Entity"] },
  "extracted-claim": { iri: `${SCIENCE_RESEARCH_ONTOLOGY_NAMESPACE}ExtractedClaim`, alignsWith: ["https://w3id.org/np/o/ntemplate/Assertion"] },
  hypothesis: { iri: `${SCIENCE_RESEARCH_ONTOLOGY_NAMESPACE}Hypothesis`, alignsWith: ["http://purl.obolibrary.org/obo/OBI_0001908"] },
  "analysis-plan-version": { iri: `${SCIENCE_RESEARCH_ONTOLOGY_NAMESPACE}AnalysisPlanVersion`, alignsWith: ["http://purl.obolibrary.org/obo/OBI_0500000", "http://www.w3.org/ns/prov#Plan"] },
  "research-run": { iri: `${SCIENCE_RESEARCH_ONTOLOGY_NAMESPACE}ResearchRun`, alignsWith: ["http://www.w3.org/ns/prov#Activity", "http://purl.obolibrary.org/obo/OBI_0000011"] },
  "artifact-version": { iri: `${SCIENCE_RESEARCH_ONTOLOGY_NAMESPACE}ArtifactVersion`, alignsWith: ["http://www.w3.org/ns/prov#Entity", "https://schema.org/Dataset"] },
  "episode-result": { iri: `${SCIENCE_RESEARCH_ONTOLOGY_NAMESPACE}EpisodeResult`, alignsWith: ["http://www.w3.org/ns/prov#Entity"] },
  "inference-candidate": { iri: `${SCIENCE_RESEARCH_ONTOLOGY_NAMESPACE}InferenceCandidate`, alignsWith: ["https://w3id.org/np/o/ntemplate/Assertion"] },
  conclusion: { iri: `${SCIENCE_RESEARCH_ONTOLOGY_NAMESPACE}Conclusion`, alignsWith: ["https://w3id.org/np/o/ntemplate/Assertion"] },
  "manuscript-version": { iri: `${SCIENCE_RESEARCH_ONTOLOGY_NAMESPACE}ManuscriptVersion`, alignsWith: ["http://www.w3.org/ns/prov#Entity", "https://schema.org/ScholarlyArticle"] },
  "manuscript-sentence": { iri: `${SCIENCE_RESEARCH_ONTOLOGY_NAMESPACE}ManuscriptSentence`, alignsWith: ["http://www.w3.org/ns/prov#Entity"] },
  "manuscript-claim": { iri: `${SCIENCE_RESEARCH_ONTOLOGY_NAMESPACE}ManuscriptClaim`, alignsWith: ["https://w3id.org/np/o/ntemplate/Assertion"] },
};

export const SCIENCE_RESEARCH_ONTOLOGY_RELATION_SHAPES: Record<ScienceEvidenceGraphEdgeKind, RelationShape> = {
  "derived-from": { iri: "http://www.w3.org/ns/prov#wasDerivedFrom", from: ALL_NODE_KINDS, to: ALL_NODE_KINDS, requiresEvidencePath: false },
  "extracted-from": { iri: `${SCIENCE_RESEARCH_ONTOLOGY_NAMESPACE}extractedFrom`, from: ["extracted-claim", "manuscript-claim"], to: ["evidence-span", "manuscript-sentence"], requiresEvidencePath: false },
  cites: { iri: "https://schema.org/citation", from: ASSERTION_KINDS, to: ["source-version"], requiresEvidencePath: false },
  supports: { iri: `${SCIENCE_RESEARCH_ONTOLOGY_NAMESPACE}supports`, from: ["evidence-span", "artifact-version", "episode-result"], to: ASSERTION_KINDS, requiresEvidencePath: true },
  contradicts: { iri: `${SCIENCE_RESEARCH_ONTOLOGY_NAMESPACE}contradicts`, from: ["evidence-span", "artifact-version", "episode-result", "inference-candidate"], to: ASSERTION_KINDS, requiresEvidencePath: true },
  qualifies: { iri: `${SCIENCE_RESEARCH_ONTOLOGY_NAMESPACE}qualifies`, from: ["evidence-span", "inference-candidate"], to: ASSERTION_KINDS, requiresEvidencePath: true },
  tests: { iri: `${SCIENCE_RESEARCH_ONTOLOGY_NAMESPACE}tests`, from: ["episode-result"], to: ["hypothesis"], requiresEvidencePath: true },
  operationalizes: { iri: `${SCIENCE_RESEARCH_ONTOLOGY_NAMESPACE}operationalizes`, from: ["analysis-plan-version"], to: ["variable", "hypothesis"], requiresEvidencePath: false },
  "uses-input": { iri: "http://www.w3.org/ns/prov#used", from: ["research-run", "artifact-version", "episode-result"], to: ["analysis-plan-version", "artifact-version", "source-version"], requiresEvidencePath: true },
  produced: { iri: "http://www.w3.org/ns/prov#generated", from: ["research-run"], to: ["artifact-version", "episode-result"], requiresEvidencePath: true },
  addresses: { iri: `${SCIENCE_RESEARCH_ONTOLOGY_NAMESPACE}addresses`, from: ["hypothesis", "analysis-plan-version"], to: ["research-question"], requiresEvidencePath: false },
  supersedes: { iri: "http://www.w3.org/ns/prov#wasRevisionOf", from: ["hypothesis", "manuscript-version"], to: ["hypothesis", "manuscript-version"], requiresEvidencePath: false },
  "invalidated-by": { iri: "http://www.w3.org/ns/prov#wasInvalidatedBy", from: ALL_NODE_KINDS, to: ["concept", "research-run", "source-version"], requiresEvidencePath: false },
  "identifies-gap": { iri: `${SCIENCE_RESEARCH_ONTOLOGY_NAMESPACE}identifiesGap`, from: ["inference-candidate"], to: ASSERTION_KINDS, requiresEvidencePath: false },
};

export const SCIENCE_RESEARCH_ONTOLOGY_PROFILE = Object.freeze({
  schema: SCIENCE_RESEARCH_ONTOLOGY_SCHEMA,
  version: SCIENCE_RESEARCH_ONTOLOGY_VERSION,
  namespace: SCIENCE_RESEARCH_ONTOLOGY_NAMESPACE,
  standards: Object.freeze({
    provenance: "https://www.w3.org/TR/prov-o/",
    researchObject: "https://w3id.org/ro/crate/1.2",
    scholarlyContribution: "https://orkg.org/",
    investigation: "http://purl.obolibrary.org/obo/obi.owl",
    statistics: "http://purl.obolibrary.org/obo/stato.owl",
  }),
  nodeClasses: SCIENCE_RESEARCH_ONTOLOGY_NODE_CLASSES,
  relationShapes: SCIENCE_RESEARCH_ONTOLOGY_RELATION_SHAPES,
});

export function validateScienceResearchOntologyGraph(
  nodes: readonly ScienceEvidenceGraphNode[],
  edges: readonly ScienceEvidenceGraphEdge[],
): void {
  const nodesById = new Map(nodes.map((value) => [value.id, value]));
  if (nodesById.size !== nodes.length) throw new Error("science-research-ontology-node-id-duplicate");
  for (const value of nodes) {
    if (!SCIENCE_RESEARCH_ONTOLOGY_NODE_CLASSES[value.kind]) throw new Error("science-research-ontology-node-class-unknown");
  }
  for (const value of edges) {
    const from = nodesById.get(value.fromNodeId);
    const to = nodesById.get(value.toNodeId);
    if (!from || !to) throw new Error("science-research-ontology-edge-orphan");
    if (from.projectId !== value.projectId || to.projectId !== value.projectId) throw new Error("science-research-ontology-project-scope-invalid");
    const shape = SCIENCE_RESEARCH_ONTOLOGY_RELATION_SHAPES[value.kind];
    if (!shape.from.includes(from.kind) || !shape.to.includes(to.kind)) throw new Error(`science-research-ontology-${value.kind}-domain-range-invalid`);
    if (shape.requiresEvidencePath && value.evidencePathNodeIds.length === 0) throw new Error(`science-research-ontology-${value.kind}-evidence-path-required`);
    if (value.evidencePathNodeIds.some((id) => !nodesById.has(id))) throw new Error("science-research-ontology-evidence-path-orphan");
    if (!value.derivation.parentNodeIds.includes(from.id) || !value.derivation.parentNodeIds.includes(to.id)) {
      throw new Error("science-research-ontology-derivation-parents-invalid");
    }
  }
}
