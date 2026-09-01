import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { userDataPath } from "../runtime-paths";
import type { InvocationExecutionContext } from "../mcp/client";
import {
  parseScienceServiceDescriptor,
  scienceLabCapabilityCatalog,
  type ScienceLabCapabilityCatalog,
  type ScienceLabToolDescriptor,
} from "../../shared/science-lab-capability";
import { parseScienceVegaEditInput, commitScienceVegaEdit } from "./vega-editor";
import {
  renderScienceStatisticsFigurePng,
  renderScienceStatisticsFigureSvg,
  renderScienceStatisticsFigureSvgPreviewPng,
} from "./statistics-figure-export";
import { isScienceResidueInteraction, type ScienceProteinColorTheme, type ScienceProteinRepresentation } from "../../shared/science-renderer-runtime";
import { commitScienceChemistrySmilesEdit, commitScienceMolstarViewEdit } from "./lab-editors";
import type { ExecuteStatisticsAnalysisInput } from "./tool-gateway";
import { scienceAcademicFullTextService, scienceAcademicSearchService, scienceArtifactPublicationValidator, scienceAstronomyCatalogService, scienceBiodiversityCatalogService, scienceChemistryValidator, scienceDomainAnalysisService, scienceEarthquakeCatalogService, scienceEconomicsCatalogService, scienceEvidenceGraphService, scienceGenomicsCatalogService, scienceJournalPublicationService, scienceMaterialsCatalogService, sciencePhysicsHepDataLiveService, sciencePhysicsInspireLiveService, scienceScientificDataService, scienceStore, scienceToolGateway } from "./runtime";
import { ACADEMIC_SEARCH_PROVIDERS, type AcademicSearchProvider } from "./academic-search";
import type {
  ScienceAnalysisDecisionDraft,
  ScienceAnalysisSpecDocument,
  ScienceDecisionRequest,
  ScienceJournalRuleInput,
  ScienceJournalCoverageEntry,
  ScienceManuscript,
  ScienceManuscriptBindingInput,
  ScienceSubmissionMetadata,
} from "../../shared/science-contract";
import type {
  ScienceResearchBlockingDecision,
  ScienceResearchFrozenPlanBinding,
  ScienceResearchLifecyclePhase,
  ScienceResearchLifecycleTransitionPreconditions,
  ScienceResearchStopCondition,
  ScienceResearchSubmissionExportBinding,
} from "../../shared/science-lifecycle";
import type { ScienceClaimLedgerManifest } from "../../shared/science-claim-ledger";
import type { ScienceEvidenceGraphConditioningContext, ScienceEvidenceGraphEdgeKind } from "../../shared/science-evidence-graph";
import { SCIENCE_EVIDENCE_GRAPH_EDGE_KINDS } from "../../shared/science-evidence-graph";
import { scienceResearchIntentCatalog } from "../../shared/science-research-intent";
import { scienceLabDecisionProjectionsForProject } from "./lab-decision-projection-service";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_AI_VISUAL_BYTES = 8 * 1024 * 1024;
const TOKEN_ENV = "AGENTLAS_SCIENCE_MCP_TOKEN";
const ENDPOINT_ENV = "AGENTLAS_SCIENCE_MCP_ENDPOINT";
const CATALOG_ENV = "AGENTLAS_SCIENCE_MCP_CATALOG";
const SERVER_KEY = "agentlas-science";
const requireFromToolControl = createRequire(__filename);

type ScienceContext = NonNullable<InvocationExecutionContext["science"]>;
type McpTool = { name: string; route: string; description: string; inputSchema: Record<string, unknown> };
type Grant = { tokenHash: string; context: ScienceContext; catalog: ScienceLabCapabilityCatalog; expiresAt: number };

const MANUSCRIPT_BINDING_SCHEMA = {
  type: "object",
  properties: {
    ordinal: { type: "integer", minimum: 1, maximum: 100000 },
    role: { type: "string", enum: ["claim", "citation", "figure", "table", "supplement"] },
    locator: { type: "string", minLength: 1, maxLength: 2000 },
    target: {
      oneOf: [
        {
          type: "object",
          properties: { kind: { const: "citation" }, citationId: { type: "string" } },
          required: ["kind", "citationId"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { kind: { const: "source-figure" }, sourceFigureId: { type: "string" } },
          required: ["kind", "sourceFigureId"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            kind: { const: "artifact" },
            artifactId: { type: "string" },
            artifactVersion: { type: "integer", minimum: 1 },
            captureId: { type: "string" },
            validationReceiptId: { type: "string" },
          },
          required: ["kind", "artifactId", "artifactVersion", "captureId", "validationReceiptId"],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ["ordinal", "role", "locator", "target"],
  additionalProperties: false,
} as const;

const JOURNAL_RULE_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,119}$" },
    category: { type: "string", enum: ["structure", "length", "figures", "references", "ethics", "data-code", "files", "review", "other"] },
    severity: { type: "string", enum: ["error", "warning", "manual"] },
    requirement: { type: "string", minLength: 1, maxLength: 4000 },
    inspectionId: { type: "string" },
    evidenceQuote: { type: "string", minLength: 20, maxLength: 4000 },
    check: {
      oneOf: [
        { type: "object", properties: { kind: { const: "heading-present" }, headings: { type: "array", minItems: 1, maxItems: 20, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 } }, minimumMatches: { type: "integer", minimum: 1, maximum: 20 } }, required: ["kind", "headings", "minimumMatches"], additionalProperties: false },
        { type: "object", properties: { kind: { const: "max-title-characters" }, maximum: { type: "integer", minimum: 1, maximum: 10000 } }, required: ["kind", "maximum"], additionalProperties: false },
        { type: "object", properties: { kind: { const: "max-section-words" }, heading: { type: "string", minLength: 1, maxLength: 200 }, maximum: { type: "integer", minimum: 1, maximum: 1000000 } }, required: ["kind", "heading", "maximum"], additionalProperties: false },
        { type: "object", properties: { kind: { const: "max-manuscript-words" }, maximum: { type: "integer", minimum: 1, maximum: 2000000 } }, required: ["kind", "maximum"], additionalProperties: false },
        { type: "object", properties: { kind: { const: "binding-count" }, role: { type: "string", enum: ["claim", "citation", "figure", "table", "supplement"] }, minimum: { type: "integer", minimum: 0, maximum: 100000 }, maximum: { type: "integer", minimum: 0, maximum: 100000 } }, required: ["kind", "role"], anyOf: [{ required: ["minimum"] }, { required: ["maximum"] }], additionalProperties: false },
        { type: "object", properties: { kind: { const: "required-text" }, patterns: { type: "array", minItems: 1, maxItems: 30, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 500 } }, minimumMatches: { type: "integer", minimum: 1, maximum: 30 } }, required: ["kind", "patterns", "minimumMatches"], additionalProperties: false },
        { type: "object", properties: { kind: { const: "output-format" }, allowed: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: { type: "string", enum: ["docx", "tex", "pdf", "zip"] } }, preferred: { type: "string", enum: ["docx", "tex", "pdf"] } }, required: ["kind", "allowed", "preferred"], additionalProperties: false },
        { type: "object", properties: { kind: { const: "figure-raster-profile" }, minimumDpi: { type: "integer", enum: [300, 600] }, allowedColorSpaces: { type: "array", minItems: 1, maxItems: 2, uniqueItems: true, items: { type: "string", enum: ["srgb", "cmyk"] } } }, required: ["kind", "minimumDpi", "allowedColorSpaces"], additionalProperties: false },
        { type: "object", properties: { kind: { const: "figure-vector-profile" }, allowedFormats: { type: "array", minItems: 1, maxItems: 1, uniqueItems: true, items: { type: "string", enum: ["svg"] } } }, required: ["kind", "allowedFormats"], additionalProperties: false },
        { type: "object", properties: { kind: { const: "manual-attestation" }, code: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,119}$" } }, required: ["kind", "code"], additionalProperties: false },
      ],
    },
  },
  required: ["id", "category", "severity", "requirement", "inspectionId", "evidenceQuote", "check"],
  additionalProperties: false,
} as const;

const SUBMISSION_METADATA_SCHEMA = {
  type: "object",
  properties: {
    authors: { type: "array", maxItems: 500, items: { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 500 }, affiliations: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 1000 } }, email: { type: ["string", "null"], maxLength: 500 }, orcid: { type: ["string", "null"], maxLength: 40 }, corresponding: { type: "boolean" } }, required: ["name", "affiliations"], additionalProperties: false } },
    keywords: { type: "array", maxItems: 100, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 500 } },
    fundingStatement: { type: ["string", "null"], maxLength: 20000 }, competingInterestsStatement: { type: ["string", "null"], maxLength: 20000 },
    authorContributionsStatement: { type: ["string", "null"], maxLength: 40000 }, dataAvailabilityStatement: { type: ["string", "null"], maxLength: 40000 },
    codeAvailabilityStatement: { type: ["string", "null"], maxLength: 40000 }, ethicsStatement: { type: ["string", "null"], maxLength: 40000 }, coverLetter: { type: ["string", "null"], maxLength: 100000 },
  },
  required: ["authors", "keywords", "fundingStatement", "competingInterestsStatement", "authorContributionsStatement", "dataAvailabilityStatement", "codeAvailabilityStatement", "ethicsStatement", "coverLetter"],
  additionalProperties: false,
} as const;

const ANALYSIS_ARTIFACT_REF_SCHEMA = {
  type: "object",
  properties: {
    artifactId: { type: "string" },
    artifactVersion: { type: "integer", minimum: 1 },
    contentSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
  },
  required: ["artifactId", "artifactVersion", "contentSha256"],
  additionalProperties: false,
} as const;

const ANALYSIS_ESTIMAND_SCHEMA = {
  type: "object",
  properties: {
    population: { type: "string", minLength: 1, maxLength: 8_000 },
    treatmentOrExposure: { type: "string", minLength: 1, maxLength: 8_000 },
    comparator: { type: "string", minLength: 1, maxLength: 8_000 },
    outcome: { type: "string", minLength: 1, maxLength: 8_000 },
    summaryMeasure: { type: "string", minLength: 1, maxLength: 8_000 },
    timeHorizon: { type: "string", minLength: 1, maxLength: 8_000 },
  },
  required: ["population", "treatmentOrExposure", "comparator", "outcome", "summaryMeasure", "timeHorizon"],
  additionalProperties: false,
} as const;

const ANALYSIS_DEPENDENCE_SCHEMA = {
  oneOf: [
    { type: "object", properties: { kind: { const: "unresolved" } }, required: ["kind"], additionalProperties: false },
    { type: "object", properties: { kind: { const: "independent" } }, required: ["kind"], additionalProperties: false },
    {
      type: "object",
      properties: { kind: { const: "repeated" }, subjectIdVariable: { type: "string", minLength: 1, maxLength: 500 }, timeVariable: { type: ["string", "null"], maxLength: 500 } },
      required: ["kind", "subjectIdVariable", "timeVariable"], additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { const: "clustered" }, clusterVariables: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 500 } } },
      required: ["kind", "clusterVariables"], additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "repeated-and-clustered" }, subjectIdVariable: { type: "string", minLength: 1, maxLength: 500 }, timeVariable: { type: ["string", "null"], maxLength: 500 },
        clusterVariables: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 500 } },
      },
      required: ["kind", "subjectIdVariable", "timeVariable", "clusterVariables"], additionalProperties: false,
    },
  ],
} as const;

const ANALYSIS_MODEL_SCHEMA = {
  type: "object",
  properties: {
    family: { type: "string", enum: ["lm", "glm", "mixed-effects", "gee"] },
    formula: { type: "string", minLength: 1, maxLength: 20_000 },
    distribution: { type: ["string", "null"], maxLength: 500 },
    link: { type: ["string", "null"], maxLength: 500 },
    groupingVariables: { type: "array", maxItems: 100, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 500 } },
    randomEffects: { type: "array", maxItems: 100, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 2_000 } },
    rationale: { type: "string", minLength: 1, maxLength: 20_000 },
  },
  required: ["family", "formula", "distribution", "link", "groupingVariables", "randomEffects", "rationale"],
  additionalProperties: false,
} as const;

const ANALYSIS_DOCUMENT_SCHEMA = {
  type: "object",
  properties: {
    schemaVersion: { const: "agentlas.science.analysis-spec.v1" },
    purpose: { const: "confirmatory" },
    researchQuestion: { type: "string", minLength: 1, maxLength: 20_000 },
    population: { type: "string", minLength: 1, maxLength: 20_000 },
    estimand: { oneOf: [{ type: "null" }, ANALYSIS_ESTIMAND_SCHEMA] },
    design: {
      type: "object",
      properties: {
        studyType: { type: "string", enum: ["randomized-experiment", "observational", "quasi-experiment", "simulation"] },
        experimentalUnit: { type: ["string", "null"], maxLength: 8_000 },
        observationUnit: { type: "string", minLength: 1, maxLength: 8_000 },
        dependence: ANALYSIS_DEPENDENCE_SCHEMA,
      },
      required: ["studyType", "experimentalUnit", "observationUnit", "dependence"], additionalProperties: false,
    },
    data: {
      type: "object",
      properties: {
        inputs: { type: "array", minItems: 1, maxItems: 100, items: ANALYSIS_ARTIFACT_REF_SCHEMA },
        outcomeVariables: { type: "array", minItems: 1, maxItems: 200, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 500 } },
        predictorVariables: { type: "array", maxItems: 500, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 500 } },
        transformations: { type: "array", maxItems: 500, items: { type: "string", minLength: 1, maxLength: 8_000 } },
        exclusions: { type: "array", maxItems: 500, items: { type: "string", minLength: 1, maxLength: 8_000 } },
      },
      required: ["inputs", "outcomeVariables", "predictorVariables", "transformations", "exclusions"], additionalProperties: false,
    },
    model: { oneOf: [{ type: "null" }, ANALYSIS_MODEL_SCHEMA] },
    missingData: {
      type: "object",
      properties: { strategy: { type: "string", enum: ["unresolved", "complete-case", "multiple-imputation", "model-based", "not-applicable"] }, rationale: { type: "string", minLength: 1, maxLength: 20_000 } },
      required: ["strategy", "rationale"], additionalProperties: false,
    },
    multiplicity: {
      type: "object",
      properties: { strategy: { type: "string", enum: ["unresolved", "none", "fdr", "fwer"] }, families: { type: "array", maxItems: 200, items: { type: "string", minLength: 1, maxLength: 1_000 } }, rationale: { type: "string", minLength: 1, maxLength: 20_000 } },
      required: ["strategy", "families", "rationale"], additionalProperties: false,
    },
    requiredDiagnostics: { type: "array", minItems: 1, maxItems: 500, items: { type: "string", minLength: 1, maxLength: 4_000 } },
    sensitivityAnalyses: { type: "array", maxItems: 500, items: { type: "string", minLength: 1, maxLength: 4_000 } },
    seed: { type: "object", properties: { algorithm: { const: "fixed" }, value: { type: "integer", minimum: 0, maximum: 4_294_967_295 } }, required: ["algorithm", "value"], additionalProperties: false },
    runtimePolicy: {
      type: "object",
      properties: { network: { const: "deny" }, maxWallTimeMinutes: { type: "integer", minimum: 1, maximum: 1440 }, maxCpuCores: { type: "integer", minimum: 1, maximum: 256 }, maxRamMb: { type: "integer", minimum: 128, maximum: 1_048_576 } },
      required: ["network", "maxWallTimeMinutes", "maxCpuCores", "maxRamMb"], additionalProperties: false,
    },
    expectedArtifacts: {
      type: "array", minItems: 1, maxItems: 500,
      items: { type: "object", properties: { role: { type: "string", enum: ["result-table", "figure", "diagnostics", "methods"] }, title: { type: "string", minLength: 1, maxLength: 1_000 } }, required: ["role", "title"], additionalProperties: false },
    },
  },
  required: ["schemaVersion", "purpose", "researchQuestion", "population", "estimand", "design", "data", "model", "missingData", "multiplicity", "requiredDiagnostics", "sensitivityAnalyses", "seed", "runtimePolicy", "expectedArtifacts"],
  additionalProperties: false,
} as const;

const ANALYSIS_DECISION_DRAFT_SCHEMA = {
  type: "object",
  properties: {
    decisionKey: { type: "string", enum: ["analysis.estimand", "analysis.dependence-structure"] },
    mergeKey: { type: "string", minLength: 1, maxLength: 500 },
    prompt: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 1_000 }, question: { type: "string", minLength: 1, maxLength: 8_000 },
        whyAsked: { type: "string", minLength: 1, maxLength: 8_000 }, impactIfUnanswered: { type: "string", minLength: 1, maxLength: 8_000 },
      },
      required: ["title", "question", "whyAsked", "impactIfUnanswered"], additionalProperties: false,
    },
    evidenceRefs: {
      type: "array", maxItems: 500,
      items: { oneOf: [
        { type: "object", properties: { kind: { const: "analysis-spec-version" } }, required: ["kind"], additionalProperties: false },
        { type: "object", properties: { kind: { const: "artifact-version" }, artifactId: ANALYSIS_ARTIFACT_REF_SCHEMA.properties.artifactId, artifactVersion: ANALYSIS_ARTIFACT_REF_SCHEMA.properties.artifactVersion, contentSha256: ANALYSIS_ARTIFACT_REF_SCHEMA.properties.contentSha256 }, required: ["kind", "artifactId", "artifactVersion", "contentSha256"], additionalProperties: false },
        { type: "object", properties: { kind: { const: "evidence-span" }, evidenceSpanId: { type: "string" } }, required: ["kind", "evidenceSpanId"], additionalProperties: false },
      ] },
    },
    options: {
      type: "array", minItems: 2, maxItems: 8,
      items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1, maxLength: 80 }, label: { type: "string", minLength: 1, maxLength: 1_000 }, description: { type: "string", minLength: 1, maxLength: 8_000 },
          benefits: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 4_000 } }, risks: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 4_000 } },
          downstreamImpact: { type: "string", minLength: 1, maxLength: 8_000 }, reversible: { type: "boolean" }, recommended: { type: "boolean" },
          effect: { oneOf: [
            { type: "object", properties: { kind: { const: "set-estimand" }, value: ANALYSIS_ESTIMAND_SCHEMA }, required: ["kind", "value"], additionalProperties: false },
            { type: "object", properties: { kind: { const: "set-dependence" }, value: ANALYSIS_DEPENDENCE_SCHEMA }, required: ["kind", "value"], additionalProperties: false },
          ] },
        },
        required: ["id", "label", "description", "benefits", "risks", "downstreamImpact", "reversible", "recommended", "effect"], additionalProperties: false,
      },
    },
    recommendationRationale: { type: "string", minLength: 1, maxLength: 8_000 },
    recommendationConfidence: { type: "number", minimum: 0, maximum: 1 },
    recommendationAssumptions: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 4_000 } },
    unaffectedNodeIds: { type: "array", maxItems: 500, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 500 } },
  },
  required: ["decisionKey", "mergeKey", "prompt", "evidenceRefs", "options", "recommendationRationale", "recommendationConfidence", "recommendationAssumptions", "unaffectedNodeIds"],
  additionalProperties: false,
} as const;

const PLATFORM_TOOLS: McpTool[] = [
  {
    name: "read_research_lifecycle",
    route: "/v1/platform/research-lifecycle/read",
    description: "Read the current canonical, hash-chained research lifecycle head for this granted project. The project scope comes only from the Main-owned tool grant; use the returned revision and state SHA-256 as append preconditions.",
    inputSchema: {
      type: "object",
      properties: { tool_call_id: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["tool_call_id"],
      additionalProperties: false,
    },
  },
  {
    name: "inspect_evidence_graph",
    route: "/v1/platform/evidence-graph/inspect",
    description: "Refresh the project-scoped immutable Evidence Graph from canonical Science records and return a bounded subgraph for one query. Citation is distinct from support; invalidated evidence and pending inference are explicit.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        query: { type: "string", minLength: 1, maxLength: 2000 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        direction: { type: "string", enum: ["outgoing", "incoming", "both"] },
        edge_kinds: { type: "array", minItems: 1, maxItems: SCIENCE_EVIDENCE_GRAPH_EDGE_KINDS.length, uniqueItems: true, items: { type: "string", enum: [...SCIENCE_EVIDENCE_GRAPH_EDGE_KINDS] } },
        max_hops: { type: "integer", minimum: 1, maximum: 6 },
        max_seeds: { type: "integer", minimum: 1, maximum: 24 },
        max_nodes: { type: "integer", minimum: 4, maximum: 100 },
        max_edges: { type: "integer", minimum: 1, maximum: 400 },
      },
      required: ["tool_call_id", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_evidence_graph_inference",
    route: "/v1/platform/evidence-graph/inferences/propose",
    description: "Persist a review-required inference candidate against one exact graph revision and exact evidence path. This never promotes a fact or conclusion and requires falsification criteria plus an alternative hypothesis.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        expected_graph_revision: { type: "integer", minimum: 1 },
        expected_graph_content_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        label: { type: "string", minLength: 1, maxLength: 500 },
        statement: { type: "string", minLength: 1, maxLength: 20000 },
        rationale: { type: "string", minLength: 1, maxLength: 20000 },
        normalized_proposition: { type: "string", minLength: 1, maxLength: 2000 },
        polarity: { type: "string", enum: ["supports", "opposes", "neutral"] },
        conditioning_context: {
          type: "object",
          properties: {
            population: { type: ["string", "null"] }, interventionOrExposure: { type: ["string", "null"] },
            comparator: { type: ["string", "null"] }, outcome: { type: ["string", "null"] },
            timeframe: { type: ["string", "null"] }, method: { type: ["string", "null"] },
            datasetOrSetting: { type: ["string", "null"] },
          },
          required: ["population", "interventionOrExposure", "comparator", "outcome", "timeframe", "method", "datasetOrSetting"],
          additionalProperties: false,
        },
        evidence_path_node_ids: { type: "array", maxItems: 500, uniqueItems: true, items: { type: "string", format: "uuid" } },
        falsification_criteria: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 2000 } },
        alternative_hypothesis: { type: "string", minLength: 1, maxLength: 10000 },
      },
      required: ["tool_call_id", "expected_graph_revision", "expected_graph_content_sha256", "label", "statement", "rationale",
        "normalized_proposition", "polarity", "conditioning_context", "evidence_path_node_ids", "falsification_criteria", "alternative_hypothesis"],
      additionalProperties: false,
    },
  },
  {
    name: "materialize_evidence_graph_inference",
    route: "/v1/platform/evidence-graph/inferences/materialize",
    description: "Materialize one exact, latest, human-accepted graph inference into a canonical proposed hypothesis bound to its exact EvidenceSpans. Pending, rejected, agent-self-reviewed, stale, or evidence-free candidates fail closed. This does not approve the hypothesis or start a Research Episode.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        graph_revision_id: { type: "string", format: "uuid" },
        expected_graph_content_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        candidate_id: { type: "string", format: "uuid" },
        expected_candidate_content_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        expected_review_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        contract_id: { type: "string", format: "uuid" },
        role: { type: "string", enum: ["primary", "alternative"] },
      },
      required: ["tool_call_id", "graph_revision_id", "expected_graph_content_sha256", "candidate_id",
        "expected_candidate_content_sha256", "expected_review_sha256", "contract_id", "role"],
      additionalProperties: false,
    },
  },
  {
    name: "explain_evidence_graph_path",
    route: "/v1/platform/evidence-graph/path",
    description: "Explain a directed exact edge path between two current graph nodes. Reverse-only connectivity is not reported as a derivation path.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        from_node_id: { type: "string", format: "uuid" },
        to_node_id: { type: "string", format: "uuid" },
      },
      required: ["tool_call_id", "from_node_id", "to_node_id"],
      additionalProperties: false,
    },
  },
  {
    name: "inspect_research_workspace",
    route: "/v1/platform/research-workspace/inspect",
    description: "Read a bounded, project-scoped inventory of the current Science workspace before planning work: lifecycle head, Lab holdings, immutable SourceVersion identities, ResearchRun receipts, and current artifact/version/linkage identities. Payload bytes and full artifact payloads are deliberately omitted; use the returned exact IDs and hashes with the dedicated inspection tools. The Main-owned grant fixes project scope.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
      },
      required: ["tool_call_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_lab_research_intents",
    route: "/v1/platform/lab-intents/list",
    description: "Read the machine-readable research intent contract for every granted Lab or an exact subset. Use this before selecting an analysis or renderer: each contract states when the Lab is needed, the live scientific decision, blocking questions, what the artifact must show, valid human and AI interactions, claim boundaries, and decision-linked next actions.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        lab_ids: { type: "array", minItems: 1, maxItems: 64, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 80 } },
      },
      required: ["tool_call_id"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_research_contract",
    route: "/v1/platform/research-contracts/propose",
    description: "Create a versioned draft research contract for the granted project, including objective, success and failure criteria, operating constraints, and bounded loop budgets. This tool cannot approve its own draft. After proposing, stop the intake phase and ask the human to approve or revise the exact draft through the Science decision surface.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        expected_project_version: { type: "integer", minimum: 1 },
        objective: { type: "string", minLength: 1, maxLength: 20000 },
        success_criteria: { type: "array", minItems: 1, maxItems: 30, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 2000 } },
        failure_criteria: { type: "array", minItems: 1, maxItems: 30, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 2000 } },
        constraints: { type: "array", maxItems: 50, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 2000 } },
        max_episodes: { type: "integer", minimum: 1, maximum: 1000 },
        max_wall_time_minutes: { type: "integer", minimum: 1, maximum: 10080 },
      },
      required: ["tool_call_id", "expected_project_version", "objective", "success_criteria", "failure_criteria", "constraints", "max_episodes", "max_wall_time_minutes"],
      additionalProperties: false,
    },
  },
  {
    name: "inspect_research_loop",
    route: "/v1/platform/research-loop/inspect",
    description: "Inspect the granted project's authoritative autonomous research loop, immutable episode plans/results, exact contract and lifecycle bindings, event ledger, and remaining episode/time budget. This is the only loop discovery surface; never infer loop progress from prose.",
    inputSchema: {
      type: "object",
      properties: { tool_call_id: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["tool_call_id"],
      additionalProperties: false,
    },
  },
  {
    name: "start_research_loop",
    route: "/v1/platform/research-loop/start",
    description: "Start the one project-scoped autonomous research loop only after the human-approved Research Contract exists. Main binds the exact contract, lifecycle head, conversation runtime, episode budget, and wall-time deadline. This does not bypass later material decisions.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        contract_id: { type: "string", format: "uuid" },
        expected_project_version: { type: "integer", minimum: 1 },
        expected_contract_version: { type: "integer", minimum: 1 },
      },
      required: ["tool_call_id", "contract_id", "expected_project_version", "expected_contract_version"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_research_episode",
    route: "/v1/platform/research-episodes/propose",
    description: "Persist one immutable, budgeted research episode plan against the exact current hypothesis revision and lifecycle head. The plan names intended Labs/tools, expected observations, and falsification criteria before any execution. Only one non-terminal episode may exist per loop.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        loop_session_id: { type: "string", format: "uuid" },
        expected_loop_version: { type: "integer", minimum: 1 },
        expected_loop_state_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        hypothesis_id: { type: "string", format: "uuid" },
        expected_hypothesis_version: { type: "integer", minimum: 1 },
        expected_hypothesis_content_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        kind: { type: "string", enum: ["literature", "simulation", "experiment", "analysis", "verification"] },
        objective: { type: "string", minLength: 1, maxLength: 20000 },
        method: { type: "string", minLength: 1, maxLength: 40000 },
        expected_observations: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 4000 } },
        falsification_criteria: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 4000 } },
        tool_intents: { type: "array", minItems: 1, maxItems: 50, items: { type: "object", properties: {
          tool_name: { type: "string", minLength: 1, maxLength: 160 },
          lab_id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,79}$" },
          purpose: { type: "string", minLength: 1, maxLength: 4000 },
        }, required: ["tool_name", "lab_id", "purpose"], additionalProperties: false } },
      },
      required: ["tool_call_id", "loop_session_id", "expected_loop_version", "expected_loop_state_sha256", "hypothesis_id",
        "expected_hypothesis_version", "expected_hypothesis_content_sha256", "kind", "objective", "method",
        "expected_observations", "falsification_criteria", "tool_intents"],
      additionalProperties: false,
    },
  },
  {
    name: "start_research_episode",
    route: "/v1/platform/research-episodes/start",
    description: "Move one exact persisted episode plan into execution after re-reading its loop, plan, hypothesis, and lifecycle optimistic-concurrency receipts. A stale lifecycle head is rejected instead of silently running an obsolete design.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        loop_session_id: { type: "string", format: "uuid" },
        episode_id: { type: "string", format: "uuid" },
        expected_loop_version: { type: "integer", minimum: 1 },
        expected_loop_state_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        expected_episode_version: { type: "integer", minimum: 1 },
        expected_episode_state_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        expected_plan_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
      required: ["tool_call_id", "loop_session_id", "episode_id", "expected_loop_version", "expected_loop_state_sha256",
        "expected_episode_version", "expected_episode_state_sha256", "expected_plan_sha256"],
      additionalProperties: false,
    },
  },
  {
    name: "settle_research_episode",
    route: "/v1/platform/research-episodes/settle",
    description: "Settle one running episode exactly once by binding terminal ResearchRuns, exact current run-backed Artifact versions, and committed evidence spans. Scientific negative results are succeeded episodes with contradicted or inconclusive outcomes; failed is reserved for execution/integrity failure.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        loop_session_id: { type: "string", format: "uuid" },
        episode_id: { type: "string", format: "uuid" },
        expected_loop_version: { type: "integer", minimum: 1 },
        expected_loop_state_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        expected_episode_version: { type: "integer", minimum: 1 },
        expected_episode_state_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        expected_plan_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        status: { type: "string", enum: ["succeeded", "failed", "cancelled"] },
        outcome: { type: "string", enum: ["supported", "contradicted", "inconclusive", "not-tested"] },
        observation_summary: { type: "string", minLength: 1, maxLength: 40000 },
        conclusion: { type: "string", minLength: 1, maxLength: 40000 },
        next_action: { type: "string", minLength: 1, maxLength: 20000 },
        run_ids: { type: "array", maxItems: 100, uniqueItems: true, items: { type: "string", format: "uuid" } },
        artifacts: { type: "array", maxItems: 100, items: { type: "object", properties: {
          artifact_id: { type: "string", format: "uuid" },
          artifact_version: { type: "integer", minimum: 1 },
          content_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        }, required: ["artifact_id", "artifact_version", "content_sha256"], additionalProperties: false } },
        evidence_span_ids: { type: "array", maxItems: 200, uniqueItems: true, items: { type: "string", format: "uuid" } },
      },
      required: ["tool_call_id", "loop_session_id", "episode_id", "expected_loop_version", "expected_loop_state_sha256",
        "expected_episode_version", "expected_episode_state_sha256", "expected_plan_sha256", "status", "outcome",
        "observation_summary", "conclusion", "next_action", "run_ids", "artifacts", "evidence_span_ids"],
      additionalProperties: false,
    },
  },
  {
    name: "verify_research_success_criterion",
    route: "/v1/platform/research-loop/criteria/verify",
    description: "Record an immutable verdict for one exact approved success criterion. Every cited evidence span and exact artifact version must already be bound to a succeeded episode in this loop; loop completion remains blocked until the latest receipt for every criterion is passed.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        loop_session_id: { type: "string", format: "uuid" },
        expected_loop_version: { type: "integer", minimum: 1 },
        expected_loop_state_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        criterion_index: { type: "integer", minimum: 0 },
        verdict: { type: "string", enum: ["passed", "failed", "inconclusive"] },
        evidence_span_ids: { type: "array", maxItems: 200, uniqueItems: true, items: { type: "string", format: "uuid" } },
        artifacts: { type: "array", maxItems: 100, items: { type: "object", properties: {
          artifact_id: { type: "string", format: "uuid" },
          artifact_version: { type: "integer", minimum: 1 },
          content_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        }, required: ["artifact_id", "artifact_version", "content_sha256"], additionalProperties: false } },
        summary: { type: "string", minLength: 1, maxLength: 8000 },
      },
      required: ["tool_call_id", "loop_session_id", "expected_loop_version", "expected_loop_state_sha256", "criterion_index",
        "verdict", "evidence_span_ids", "artifacts", "summary"],
      additionalProperties: false,
    },
  },
  {
    name: "transition_research_loop",
    route: "/v1/platform/research-loop/transition",
    description: "Pause, resume, complete, fail, or cancel the authoritative loop. Pause/resume/complete/fail use exact loop OCC. Cancel is idempotent and terminal even from a stale caller so the stop control cannot deadlock.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        loop_session_id: { type: "string", format: "uuid" },
        expected_loop_version: { type: "integer", minimum: 1 },
        expected_loop_state_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        action: { type: "string", enum: ["pause", "resume", "complete", "fail", "cancel"] },
        reason: { type: "string", minLength: 1, maxLength: 8000 },
      },
      required: ["tool_call_id", "loop_session_id", "expected_loop_version", "expected_loop_state_sha256", "action", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "append_research_lifecycle_revision",
    route: "/v1/platform/research-lifecycle/append",
    description: "Append one immutable canonical lifecycle revision for this granted project using exact optimistic concurrency. A stale revision or state hash is rejected; never retry by overwriting the newer state.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        study_id: { type: "string" },
        expected_revision: { type: "integer", minimum: 1 },
        expected_state_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        phase: { type: "string", enum: ["intake", "literature", "hypothesis", "analysis_plan_draft", "analysis_plan_frozen", "execution", "evidence_reconciliation", "conclusions", "manuscript", "journal_profile", "submission_validation", "ready_to_submit", "blocked", "stopped", "failed"] },
        question: { type: "string", minLength: 1, maxLength: 20000 },
        preconditions: { type: "object" },
        open_blocking_decisions: { type: "array", maxItems: 100, items: { type: "object" } },
        blockers: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 8000 } },
        frozen_analysis_plan: { type: ["object", "null"] },
        submission_export: { type: ["object", "null"] },
        stop: { type: ["object", "null"] },
      },
      required: ["tool_call_id", "study_id", "expected_revision", "expected_state_sha256", "phase", "question", "preconditions", "open_blocking_decisions", "blockers", "frozen_analysis_plan", "submission_export", "stop"],
      additionalProperties: false,
    },
  },
  {
    name: "search_academic_literature",
    route: "/v1/platform/academic-search",
    description: "Search prior research through multiple public scholarly metadata providers, normalize and DOI/title-deduplicate the results, save them as project Sources, and return provider-level provenance receipts. Use this before making literature, novelty, prior-art, state-of-the-art, citation, or related-paper claims. Partial provider failure is explicit; metadata search is not full-text verification.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        query: { type: "string", minLength: 1, maxLength: 1000 },
        domain: { type: "string", maxLength: 160 },
        from_year: { type: "integer", minimum: 1000, maximum: 3000 },
        to_year: { type: "integer", minimum: 1000, maximum: 3000 },
        sort: { type: "string", enum: ["relevance", "newest", "cited"] },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        include_preprints: { type: "boolean" },
        providers: {
          anyOf: [
            { type: "string", enum: ["auto"] },
            { type: "array", minItems: 1, maxItems: 6, uniqueItems: true, items: { type: "string", enum: ACADEMIC_SEARCH_PROVIDERS } },
          ],
        },
      },
      required: ["tool_call_id", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "promote_source_abstract_to_evidence",
    route: "/v1/platform/sources/promote-abstract",
    description: "Promote the exact abstract already persisted on one metadata-only academic Source into an immutable parsed text SourceVersion. The returned bytes are abstract-only evidence, never full text; preserve that limitation in claims. Use the exact current source/version IDs returned by search_academic_literature.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        source_id: { type: "string", format: "uuid" },
        expected_source_version_id: { type: "string", format: "uuid" },
      },
      required: ["tool_call_id", "source_id", "expected_source_version_id"],
      additionalProperties: false,
    },
  },
  {
    name: "retrieve_open_access_full_text",
    route: "/v1/platform/sources/retrieve-full-text",
    description: "Resolve one exact DOI- or PMID-identified project Source against Europe PMC, retrieve only an Open Access full-text XML record, preserve the raw provider bytes and hashes, and append a deterministic parsed full-text SourceVersion that can support byte-exact evidence spans. This is a content-verification step, not metadata search. A stale SourceVersion, identity mismatch, non-OA record, redirect, or malformed JATS response fails closed.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        source_id: { type: "string", format: "uuid" },
        expected_source_version_id: { type: "string", format: "uuid" },
      },
      required: ["tool_call_id", "source_id", "expected_source_version_id"],
      additionalProperties: false,
    },
  },
  {
    name: "stage_response_evidence",
    route: "/v1/platform/evidence/stage-response",
    description: "Stage one exact evidence span for the current assistant turn before its final message exists. The block_content must appear verbatim in the final response; after settlement the host binds it to the durable assistant message and creates a real citation. Any text or byte mismatch fails closed and remains uncited.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        block_ordinal: { type: "integer", minimum: 1, maximum: 100000 },
        block_kind: { type: "string", enum: ["markdown", "claim", "artifact", "run-status"] },
        block_content: { type: "string", minLength: 1, maxLength: 100000 },
        source_id: { type: "string", format: "uuid" },
        source_version_id: { type: "string", format: "uuid" },
        citation_ordinal: { type: "integer", minimum: 1, maximum: 10000 },
        relation: { type: "string", enum: ["supports", "contradicts", "context"] },
        locator: { type: "string", minLength: 1, maxLength: 2000 },
        start_byte: { type: "integer", minimum: 0, maximum: 134217727 },
        end_byte: { type: "integer", minimum: 1, maximum: 134217728 },
        excerpt: { type: "string", minLength: 1, maxLength: 20000 },
      },
      required: ["tool_call_id", "block_ordinal", "block_kind", "block_content", "source_id", "source_version_id", "citation_ordinal", "relation", "locator", "start_byte", "end_byte", "excerpt"],
      additionalProperties: false,
    },
  },
  {
    name: "list_project_evidence",
    route: "/v1/platform/evidence/list",
    description: "List the project's committed citation/evidence ledger with exact evidence-span IDs, immutable source-version IDs, byte ranges, assistant claim blocks, and source metadata. Use these evidence_span_ids when proposing or revising hypotheses; staged or rejected evidence is never returned.",
    inputSchema: {
      type: "object",
      properties: { tool_call_id: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["tool_call_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_research_hypotheses",
    route: "/v1/platform/hypotheses/list",
    description: "List the current primary and alternative hypothesis revisions, or the full immutable revision history, including falsification criteria and exact evidence-span bindings.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        include_history: { type: "boolean" },
      },
      required: ["tool_call_id"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_research_hypothesis",
    route: "/v1/platform/hypotheses/propose",
    description: "Create one immutable version-1 primary or alternative hypothesis under the approved research contract. Every hypothesis must have falsification criteria and at least one exact committed evidence-span binding; unsupported prose is rejected.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        contract_id: { type: "string", format: "uuid" },
        role: { type: "string", enum: ["primary", "alternative"] },
        statement: { type: "string", minLength: 1, maxLength: 20000 },
        rationale: { type: "string", minLength: 1, maxLength: 20000 },
        falsification_criteria: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 4000 } },
        evidence_span_ids: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "string", format: "uuid" } },
      },
      required: ["tool_call_id", "contract_id", "role", "statement", "rationale", "falsification_criteria", "evidence_span_ids"],
      additionalProperties: false,
    },
  },
  {
    name: "revise_research_hypothesis",
    route: "/v1/platform/hypotheses/revise",
    description: "Append an immutable successor revision to one current hypothesis using exact optimistic concurrency. Supported or contradicted states require exact succeeded Research Episode result bindings against that parent hypothesis; stale parents, fabricated outcomes, and invalid transitions are rejected.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        parent_hypothesis_id: { type: "string", format: "uuid" },
        expected_parent_version: { type: "integer", minimum: 1 },
        expected_parent_content_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        role: { type: "string", enum: ["primary", "alternative"] },
        status: { type: "string", enum: ["proposed", "approved", "rejected", "supported", "contradicted"] },
        statement: { type: "string", minLength: 1, maxLength: 20000 },
        rationale: { type: "string", minLength: 1, maxLength: 20000 },
        falsification_criteria: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 4000 } },
        evidence_span_ids: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "string", format: "uuid" } },
        episode_result_ids: { type: "array", maxItems: 100, uniqueItems: true, items: { type: "string", format: "uuid" } },
      },
      required: ["tool_call_id", "parent_hypothesis_id", "expected_parent_version", "expected_parent_content_sha256", "role", "status", "statement", "rationale", "falsification_criteria", "evidence_span_ids"],
      additionalProperties: false,
    },
  },
  {
    name: "search_physics_literature",
    route: "/v1/platform/physics/inspire-search",
    description: "Search the official INSPIRE HEP literature API, preserve exact provider bytes as an immutable SourceVersion and ResearchRun, and create a receipt-bound Vega/table artifact with DOI and record URLs. Metadata and abstracts are discovery evidence, not full-text verification.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        query: { type: "string", minLength: 2, maxLength: 500 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        page: { type: "integer", minimum: 1, maximum: 100 },
        sort: { type: "string", enum: ["relevance", "mostrecent", "mostcited"] },
        title: { type: "string", minLength: 1, maxLength: 240 },
      },
      required: ["tool_call_id", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "fetch_hepdata_table",
    route: "/v1/platform/physics/hepdata-table",
    description: "Fetch an official HEPData record and one exact version-pinned JSON table, preserve record/table bytes and DOI lineage in separate SourceVersions and one ResearchRun, and create a Vega/table artifact without converting missing measurements to zero. Provider access refusals are surfaced without bypass.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        record_id: { type: "string", pattern: "^ins[0-9]{1,16}$" },
        table_name: { type: "string", minLength: 1, maxLength: 500 },
        version: { type: "integer", minimum: 1, maximum: 999 },
        title: { type: "string", minLength: 1, maxLength: 240 },
      },
      required: ["tool_call_id", "record_id", "table_name"],
      additionalProperties: false,
    },
  },
  {
    name: "search_astronomy_catalog",
    route: "/v1/platform/astronomy/catalog-search",
    description: "Run an exact JSON-only SIMBAD TAP cone search in ICRS coordinates, preserve the raw provider response and normalized rows as a ResearchRun and retrieved project SourceVersion, and return the catalog run id required by build_astronomy_sky_map. Missing measurements remain null and are never imputed.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        center_ra_deg: { type: "number", minimum: 0, exclusiveMaximum: 360 },
        center_dec_deg: { type: "number", minimum: -90, maximum: 90 },
        radius_deg: { type: "number", minimum: 0.001, maximum: 10 },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        title: { type: "string", minLength: 1, maxLength: 240 },
      },
      required: ["tool_call_id", "center_ra_deg", "center_dec_deg", "radius_deg"],
      additionalProperties: false,
    },
  },
  {
    name: "search_biodiversity_occurrences",
    route: "/v1/platform/biodiversity/occurrence-search",
    description: "Search exact coordinate-bearing GBIF occurrence records, preserve the raw provider JSON as an immutable project Source and ResearchRun, and return the catalog run id required by build_biodiversity_occurrence_map. Provider issue flags and missing values are preserved without imputation.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        scientific_name: { type: "string", minLength: 1, maxLength: 500 },
        country_code: { type: "string", pattern: "^[A-Za-z]{2}$" },
        from_year: { type: "integer", minimum: 1000, maximum: 3000 },
        to_year: { type: "integer", minimum: 1000, maximum: 3000 },
        limit: { type: "integer", minimum: 1, maximum: 300 },
        title: { type: "string", minLength: 1, maxLength: 240 },
      },
      required: ["tool_call_id", "scientific_name"],
      additionalProperties: false,
    },
  },
  {
    name: "search_earthquake_observations",
    route: "/v1/platform/earth-science/earthquake-search",
    description: "Run a bounded anonymous USGS FDSN Event search, preserve the exact raw GeoJSON and normalized earthquake catalog as a project Source and ResearchRun, and return the catalog run id required by build_earthquake_observation_map. Missing magnitudes and place labels remain missing.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        start_time: { type: "string", format: "date-time" },
        end_time: { type: "string", format: "date-time" },
        min_magnitude: { type: "number", minimum: -2, maximum: 10 },
        max_magnitude: { type: "number", minimum: -2, maximum: 10 },
        min_depth_km: { type: "number", minimum: -100, maximum: 1000 },
        max_depth_km: { type: "number", minimum: -100, maximum: 1000 },
        bounds: {
          type: "object", properties: {
            min_longitude: { type: "number", minimum: -180, maximum: 180 }, min_latitude: { type: "number", minimum: -90, maximum: 90 },
            max_longitude: { type: "number", minimum: -180, maximum: 180 }, max_latitude: { type: "number", minimum: -90, maximum: 90 },
          }, required: ["min_longitude", "min_latitude", "max_longitude", "max_latitude"], additionalProperties: false,
        },
        limit: { type: "integer", minimum: 1, maximum: 2000 },
        offset: { type: "integer", minimum: 1, maximum: 1000000 },
        order_by: { type: "string", enum: ["time", "time-asc", "magnitude", "magnitude-asc"] },
        title: { type: "string", minLength: 1, maxLength: 240 },
      },
      required: ["tool_call_id", "start_time", "end_time"], additionalProperties: false,
    },
  },
  {
    name: "get_earthquake_event_detail",
    route: "/v1/platform/earth-science/earthquake-event-detail",
    description: "Retrieve one exact USGS ComCat event detail by event id, preserve the raw GeoJSON as a versioned project Source and ResearchRun, and return normalized origin quality, uncertainty/error-ellipse measurements, and product/content inventory without inventing a confidence level.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        event_id: { type: "string", pattern: "^[A-Za-z0-9._-]+$", minLength: 1, maxLength: 120 },
        title: { type: "string", minLength: 1, maxLength: 240 },
      },
      required: ["tool_call_id", "event_id"],
      additionalProperties: false,
    },
  },
  {
    name: "fetch_world_bank_indicator",
    route: "/v1/platform/economics/world-bank-indicator",
    description: "Fetch one bounded official World Bank indicator series, preserve the exact provider response as a project Source and ResearchRun, and create a lineage-bound Vega artifact in Economic Indicators Lab. This is official macro/development indicator retrieval, not a stock-price, trading, or free market-data API; finance data must be supplied by the user through Data Table, Statistical Analysis, and Vega.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        country: { type: "string", pattern: "^[A-Za-z]{2,3}$", minLength: 2, maxLength: 3 },
        indicator: { type: "string", pattern: "^[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+){1,7}$", minLength: 3, maxLength: 64 },
        start_year: { type: "integer", minimum: 1800, maximum: 2200 },
        end_year: { type: "integer", minimum: 1800, maximum: 2200 },
        title: { type: "string", minLength: 1, maxLength: 240 },
      },
      required: ["tool_call_id", "country", "indicator", "start_year", "end_year"],
      additionalProperties: false,
    },
  },
  {
    name: "search_materials_structures",
    route: "/v1/platform/materials/structure-search",
    description: "Search anonymous OQMD OPTIMADE structures for an exact element set, preserve the raw provider JSON as an immutable project Source and ResearchRun, and create a receipt-bound interactive materials table with lattice/site records, band gaps, formation energies, and missing values preserved without imputation.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        elements: { type: "array", minItems: 1, maxItems: 8, uniqueItems: true, items: { type: "string", pattern: "^[A-Z][a-z]?$" } },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        offset: { type: "integer", minimum: 0, maximum: 10000 },
        title: { type: "string", minLength: 1, maxLength: 240 },
      },
      required: ["tool_call_id", "elements"],
      additionalProperties: false,
    },
  },
  {
    name: "build_genomics_variant_track",
    route: "/v1/platform/genomics/variant-track",
    description: "Validate an exact Ensembl assembly and coordinate interval, retrieve the raw ClinVar variation overlap response without imputation, preserve both provider responses as immutable Sources and a ResearchRun, and create an interactive JBrowse 2 artifact that can be captured and bound to a manuscript.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        species: { type: "string", pattern: "^[a-z][a-z0-9_]+$", maxLength: 80 },
        assembly: { type: "string", pattern: "^[A-Za-z0-9_.-]+$", maxLength: 120 },
        ref_name: { type: "string", pattern: "^[A-Za-z0-9_.-]+$", maxLength: 120 },
        start: { type: "integer", minimum: 1, maximum: 500000000 },
        end: { type: "integer", minimum: 1, maximum: 500000000 },
        title: { type: "string", minLength: 1, maxLength: 240 },
      },
      required: ["tool_call_id", "species", "assembly", "ref_name", "start", "end"],
      additionalProperties: false,
    },
  },
  {
    name: "list_scientific_data_sources",
    route: "/v1/platform/scientific-data/sources",
    description: "List only the scientific databases that are actually installed and callable, including their entity types, policy, license model, and source-bound Lab materializer availability.",
    inputSchema: {
      type: "object",
      properties: { tool_call_id: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["tool_call_id"],
      additionalProperties: false,
    },
  },
  {
    name: "retrieve_scientific_data",
    route: "/v1/platform/scientific-data/retrieve",
    description: "Retrieve an exact RCSB PDB structure or PubChem compound through the trusted Electron runtime, persist the official bytes and provider receipts as an immutable project Source/ResearchRun, and return an exact source-bound materialization plan when one is genuinely available. This is data retrieval, not evidence that a scientific claim is true.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        provider: { type: "string", enum: ["rcsb-pdb", "pubchem"] },
        entry_id: { type: "string", pattern: "^[0-9][A-Za-z0-9]{3}$" },
        namespace: { type: "string", enum: ["cid", "name", "inchikey"] },
        value: { type: "string", minLength: 1, maxLength: 240 },
      },
      required: ["tool_call_id", "provider"],
      additionalProperties: false,
      allOf: [
        { if: { properties: { provider: { const: "rcsb-pdb" } } }, then: { required: ["entry_id"], not: { anyOf: [{ required: ["namespace"] }, { required: ["value"] }] } } },
        { if: { properties: { provider: { const: "pubchem" } } }, then: { required: ["namespace", "value"], not: { required: ["entry_id"] } } },
      ],
    },
  },
  {
    name: "list_science_lab_capabilities",
    route: "/v1/platform/capabilities",
    description: "List the exact installed Agentlas Science Labs, artifact types, renderers, and operations currently callable by the AI. Treat absent operations as unavailable.",
    inputSchema: {
      type: "object",
      properties: { tool_call_id: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["tool_call_id"],
      additionalProperties: false,
    },
  },
  {
    name: "inspect_science_artifact",
    route: "/v1/platform/artifacts/inspect",
    description: "Inspect an exact Science artifact version, its semantic observations, provenance, Lab linkage, immutable history, and current verified visual-capture metadata.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        artifact_id: { type: "string" },
        artifact_version: { type: "integer", minimum: 1 },
      },
      required: ["tool_call_id", "artifact_id"],
      additionalProperties: false,
    },
  },
  {
    name: "describe_statistics_capabilities",
    route: "/v1/platform/statistics/capabilities",
    description: "Read the installed statistics engine's validated coverage manifest and Figure catalog before choosing a method or visualization. It reports exact implemented boundaries, independent-oracle coverage, known gaps, renderer capabilities, and current export support so the AI cannot imply R or MATLAB parity that the installed package does not have.",
    inputSchema: {
      type: "object",
      properties: { tool_call_id: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["tool_call_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_statistics_figures",
    route: "/v1/platform/statistics/figures/list",
    description: "List independent, versioned statistical Figure artifacts already materialized in Data Visualization Lab. Optionally restrict the inventory to one exact parent statistics artifact.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        statistics_artifact_id: { type: "string" },
      },
      required: ["tool_call_id"],
      additionalProperties: false,
    },
  },
  {
    name: "materialize_statistics_figure",
    route: "/v1/platform/statistics/figures/materialize",
    description: "Materialize one exact visualization from an immutable statistics-analysis artifact as its own publication Figure artifact. The trusted host binds the parent version, analysis receipt, renderer spec, Figure Spec, provenance, and Lab linkage; this does not invent a chart absent from the analysis output.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        statistics_artifact_id: { type: "string" },
        statistics_artifact_version: { type: "integer", minimum: 1 },
        statistics_artifact_content_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        visualization_index: { type: "integer", minimum: 0, maximum: 999 },
        title: { type: "string", minLength: 1, maxLength: 240 },
      },
      required: ["tool_call_id", "statistics_artifact_id", "statistics_artifact_version", "statistics_artifact_content_sha256", "visualization_index"],
      additionalProperties: false,
    },
  },
  {
    name: "materialize_statistics_numeric_surface",
    route: "/v1/platform/statistics/numeric-surfaces/materialize",
    description: "Materialize one exact response_surface_regression numeric-surface source artifact as a run-backed interactive Three.js artifact in Data Visualization Lab. The host binds the immutable parent analysis artifact/version/hash, exact source artifact receipt, observed points, convex-hull support mask, analysis run manifests, child materializer run, and output artifact; unsupported or stale lineage fails closed.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        statistics_artifact_id: { type: "string" },
        statistics_artifact_version: { type: "integer", minimum: 1 },
        statistics_artifact_content_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        source_artifact_index: { type: "integer", minimum: 0, maximum: 31 },
      },
      required: ["tool_call_id", "statistics_artifact_id", "statistics_artifact_version", "statistics_artifact_content_sha256", "source_artifact_index"],
      additionalProperties: false,
    },
  },
  {
    name: "export_statistics_figure_svg",
    route: "/v1/platform/statistics/figures/export-svg",
    description: "Render one exact immutable statistical Figure artifact through the bundled Vega runtime, persist the exact UTF-8 SVG as the sole CAS output of a run-backed vector artifact, and return its version/hash closure plus a bounded PNG inspection preview. The source Figure, analysis receipt, and artifact version must already be valid; this never substitutes a screenshot, PDF, CMYK asset, or different chart specification.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        artifact_id: { type: "string" },
        artifact_version: { type: "integer", minimum: 1 },
        artifact_content_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
      required: ["tool_call_id", "artifact_id", "artifact_version", "artifact_content_sha256"],
      additionalProperties: false,
    },
  },
  {
    name: "export_statistics_figure_png",
    route: "/v1/platform/statistics/figures/export-png",
    description: "Render one exact immutable statistical Figure artifact as a journal raster at 300 or 600 DPI and persist the exact PNG as a new run-backed image artifact with an adopted CAS capture. The trusted host derives it from the same sanitized Vega-to-SVG render, fixes sRGB and a white background, records physical and pixel dimensions plus source/output hashes, and returns the exact pixels plus the export artifact/version/hash needed for manuscript validation and binding.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        artifact_id: { type: "string" },
        artifact_version: { type: "integer", minimum: 1 },
        artifact_content_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        dpi: { type: "integer", enum: [300, 600] },
        width_mm: { type: "number", minimum: 20, maximum: 200 },
      },
      required: ["tool_call_id", "artifact_id", "artifact_version", "artifact_content_sha256", "dpi"],
      additionalProperties: false,
    },
  },
  {
    name: "inspect_science_artifact_visual",
    route: "/v1/platform/artifacts/inspect-visual",
    description: "Inspect the exact adopted PNG pixels for the current immutable version of a Science artifact. The result includes verified capture metadata plus an MCP image content block so the AI can visually review the same rendered artifact the researcher sees.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        artifact_id: { type: "string" },
        artifact_version: { type: "integer", minimum: 1 },
      },
      required: ["tool_call_id", "artifact_id", "artifact_version"],
      additionalProperties: false,
    },
  },
  {
    name: "compare_science_artifact_versions",
    route: "/v1/platform/artifacts/compare",
    description: "Compare two immutable versions of one Science artifact with renderer-aware structural and scientific change classification.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        artifact_id: { type: "string" },
        from_version: { type: "integer", minimum: 1 },
        to_version: { type: "integer", minimum: 1 },
      },
      required: ["tool_call_id", "artifact_id", "from_version", "to_version"],
      additionalProperties: false,
    },
  },
  {
    name: "validate_artifact_for_manuscript",
    route: "/v1/platform/artifacts/validate-for-manuscript",
    description: "Run the trusted main-process publication provenance gate for one exact immutable artifact version. It verifies the succeeded source run, artifact linkage, adopted capture, CAS bytes, and minimum pixel dimensions, then returns the exact capture and validation receipt target required by a manuscript binding. The caller cannot choose the validation status or checks.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        artifact_id: { type: "string" },
        artifact_version: { type: "integer", minimum: 1 },
      },
      required: ["tool_call_id", "artifact_id", "artifact_version"],
      additionalProperties: false,
    },
  },
  {
    name: "list_analysis_plans",
    route: "/v1/platform/analysis-plans/list",
    description: "List the project's immutable confirmatory analysis plans, including draft/frozen status, exact version, content hash, and lock version. A draft is not authorization to run confirmatory analysis.",
    inputSchema: {
      type: "object",
      properties: { tool_call_id: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["tool_call_id"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_analysis_plan",
    route: "/v1/platform/analysis-plans/propose",
    description: "Create the first immutable version of a confirmatory analysis plan bound to exact project artifact versions. If the estimand or dependence structure is unresolved, include exactly one matching human decision draft; otherwise decisions must be empty. This does not freeze or authorize execution.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        title: { type: "string", minLength: 1, maxLength: 500 },
        document: ANALYSIS_DOCUMENT_SCHEMA,
        decisions: { type: "array", maxItems: 3, items: ANALYSIS_DECISION_DRAFT_SCHEMA },
      },
      required: ["tool_call_id", "title", "document", "decisions"],
      additionalProperties: false,
    },
  },
  {
    name: "list_research_decisions",
    route: "/v1/platform/analysis-decisions/list",
    description: "List typed human decisions raised by analysis planning. Use current lock/version/hash fields; never infer a human choice from chat prose.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        analysis_spec_id: { type: "string" },
        statuses: { type: "array", maxItems: 7, uniqueItems: true, items: { type: "string", enum: ["queued", "presented", "deferred", "applied", "superseded", "expired", "cancelled"] } },
      },
      required: ["tool_call_id"],
      additionalProperties: false,
    },
  },
  {
    name: "request_human_research_decision",
    route: "/v1/platform/analysis-decisions/present",
    description: "Mark one queued or deferred typed analysis decision as presented so the Science UI can ask the researcher in a bottom sheet. The AI cannot choose an option on the human's behalf.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        decision_id: { type: "string" },
        expected_lock_version: { type: "integer", minimum: 1 },
      },
      required: ["tool_call_id", "decision_id", "expected_lock_version"],
      additionalProperties: false,
    },
  },
  {
    name: "freeze_analysis_plan",
    route: "/v1/platform/analysis-plans/freeze",
    description: "Freeze a complete confirmatory analysis plan using exact optimistic-concurrency fields. Freezing is rejected while a typed human decision is open, a required design field is unresolved, or an artifact reference is stale.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        analysis_spec_id: { type: "string" },
        expected_version: { type: "integer", minimum: 1 },
        expected_content_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        expected_lock_version: { type: "integer", minimum: 1 },
      },
      required: ["tool_call_id", "analysis_spec_id", "expected_version", "expected_content_sha256", "expected_lock_version"],
      additionalProperties: false,
    },
  },
  {
    name: "list_project_manuscripts",
    route: "/v1/platform/manuscripts/list",
    description: "List the project manuscripts currently stored in the immutable Science manuscript ledger. Returns current version and binding hashes, not a claim that a manuscript is journal-ready.",
    inputSchema: {
      type: "object",
      properties: { tool_call_id: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["tool_call_id"],
      additionalProperties: false,
    },
  },
  {
    name: "inspect_science_manuscript",
    route: "/v1/platform/manuscripts/inspect",
    description: "Read one exact current manuscript version, including its Markdown, integrity hashes, and evidence bindings. Use the returned version and content hash as the concurrency precondition for saving a revision.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        manuscript_id: { type: "string" },
      },
      required: ["tool_call_id", "manuscript_id"],
      additionalProperties: false,
    },
  },
  {
    name: "prepare_manuscript_claim_context",
    route: "/v1/platform/claim-ledgers/prepare-context",
    description: "Explicitly revalidate the exact current manuscript, citations, evidence bytes, and artifact validation receipts, then create immutable versioned snapshots required by the claim ledger. This is the only legacy migration path: missing versions or hashes are never synthesized. Only artifact receipts whose live status is verified map to passed; all others map to failed.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        manuscript_id: { type: "string" },
        expected_manuscript_version: { type: "integer", minimum: 1 },
        expected_manuscript_content_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        citation_ids: { type: "array", maxItems: 100000, uniqueItems: true, items: { type: "string" } },
        validation_receipt_ids: { type: "array", maxItems: 100000, uniqueItems: true, items: { type: "string" } },
      },
      required: ["tool_call_id", "manuscript_id", "expected_manuscript_version", "expected_manuscript_content_sha256", "citation_ids", "validation_receipt_ids"],
      additionalProperties: false,
    },
  },
  {
    name: "inspect_manuscript_claim_ledger",
    route: "/v1/platform/claim-ledgers/inspect",
    description: "Read and fully revalidate the immutable hash-chained claim ledger for one manuscript in this granted project. Returns active claim counts and the publication gate; missing, stale, cross-project, replayed, or tampered evidence fails closed.",
    inputSchema: { type: "object", properties: { tool_call_id: { type: "string", minLength: 1, maxLength: 160 }, manuscript_id: { type: "string" } }, required: ["tool_call_id", "manuscript_id"], additionalProperties: false },
  },
  {
    name: "create_manuscript_claim_ledger",
    route: "/v1/platform/claim-ledgers/create",
    description: "Create revision 1 of a strict immutable manuscript claim ledger after prepare_manuscript_claim_context. The complete canonical manifest must already contain exact text and locator hashes, versioned evidence atoms, supersession links, and its canonical manifest hash; the runtime does not repair or infer fields.",
    inputSchema: { type: "object", properties: { tool_call_id: { type: "string", minLength: 1, maxLength: 160 }, manifest: { type: "object" } }, required: ["tool_call_id", "manifest"], additionalProperties: false },
  },
  {
    name: "append_manuscript_claim_ledger_revision",
    route: "/v1/platform/claim-ledgers/append",
    description: "Append one full immutable claim-ledger manifest using exact revision and manifest SHA-256 CAS preconditions. Claim history is append-only; changed claims must supersede an exact prior record and stale or replayed evidence is rejected.",
    inputSchema: { type: "object", properties: { tool_call_id: { type: "string", minLength: 1, maxLength: 160 }, ledger_id: { type: "string" }, expected_revision: { type: "integer", minimum: 1 }, expected_manifest_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, manifest: { type: "object" } }, required: ["tool_call_id", "ledger_id", "expected_revision", "expected_manifest_sha256", "manifest"], additionalProperties: false },
  },
  {
    name: "evaluate_manuscript_claim_gate",
    route: "/v1/platform/claim-ledgers/evaluate",
    description: "Recompute the publication claim gate from the exact current manuscript version, current ledger head, immutable evidence snapshots, and pinned policy. This reports assessment linkage and resolution status, never ground truth; no ledger or any unresolved required claim blocks readiness.",
    inputSchema: { type: "object", properties: { tool_call_id: { type: "string", minLength: 1, maxLength: 160 }, manuscript_id: { type: "string" } }, required: ["tool_call_id", "manuscript_id"], additionalProperties: false },
  },
  {
    name: "create_science_manuscript",
    route: "/v1/platform/manuscripts/create",
    description: "Create the first immutable version of a project manuscript. Evidence bindings are accepted only when they resolve to exact project citations, source figures, or verified artifact captures; unsupported claims must remain explicitly unbound in the Markdown.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        title: { type: "string", minLength: 1, maxLength: 500 },
        markdown: { type: "string", minLength: 1, maxLength: 2000000 },
        bindings: { type: "array", maxItems: 10000, items: MANUSCRIPT_BINDING_SCHEMA },
      },
      required: ["tool_call_id", "title", "markdown", "bindings"],
      additionalProperties: false,
    },
  },
  {
    name: "save_science_manuscript_version",
    route: "/v1/platform/manuscripts/append-version",
    description: "Append a new immutable manuscript version with optimistic concurrency. Supply the exact current version, content hash, complete Markdown, and complete binding manifest returned by inspect_science_manuscript.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        manuscript_id: { type: "string" },
        expected_version: { type: "integer", minimum: 1 },
        expected_content_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        markdown: { type: "string", minLength: 1, maxLength: 2000000 },
        bindings: { type: "array", maxItems: 10000, items: MANUSCRIPT_BINDING_SCHEMA },
      },
      required: ["tool_call_id", "manuscript_id", "expected_version", "expected_content_sha256", "markdown", "bindings"],
      additionalProperties: false,
    },
  },
  {
    name: "inspect_official_journal_guidelines",
    route: "/v1/platform/journals/inspect-official-guidelines",
    description: "Fetch one exact HTTPS page from the target journal's official site through the trusted Electron runtime, reject private-network/redirect targets, store a hash-verified immutable text snapshot, and return that snapshot for rule extraction. Call this before creating a journal profile; search snippets alone are insufficient.",
    inputSchema: { type: "object", properties: { tool_call_id: { type: "string", minLength: 1, maxLength: 160 }, source_url: { type: "string", minLength: 8, maxLength: 4000 } }, required: ["tool_call_id", "source_url"], additionalProperties: false },
  },
  {
    name: "list_journal_profiles",
    route: "/v1/platform/journals/list",
    description: "List journal profiles already grounded in immutable official-guideline snapshots for this project. A profile is a versioned rule contract, not a generic style preset.",
    inputSchema: { type: "object", properties: { tool_call_id: { type: "string", minLength: 1, maxLength: 160 } }, required: ["tool_call_id"], additionalProperties: false },
  },
  {
    name: "create_journal_profile_from_official_guidelines",
    route: "/v1/platform/journals/create-profile",
    description: "Create a versioned target-journal profile only from prior inspect_official_journal_guidelines snapshots. Every normalized rule must quote exact text from the cited snapshot; mismatched evidence is rejected. Use multiple inspection ids when manuscript, figure, data, ethics, or review rules live on separate official pages.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 }, journal_name: { type: "string", minLength: 1, maxLength: 500 }, article_type: { type: "string", minLength: 1, maxLength: 500 }, identity_receipt_id: { type: "string" },
        inspection_ids: { type: "array", minItems: 1, maxItems: 20, uniqueItems: true, items: { type: "string" } },
        rules: { type: "array", minItems: 1, maxItems: 500, items: JOURNAL_RULE_SCHEMA },
        coverage: { type: "array", minItems: 11, maxItems: 11, items: { type: "object", properties: {
          category: { type: "string", enum: ["identity", "article-structure", "length-limits", "manuscript-files", "figures-tables", "references", "supplements", "data-code", "ethics-conflicts", "authorship", "peer-review"] },
          status: { type: "string", enum: ["covered", "not-applicable", "unresolved"] }, inspectionId: { type: "string" }, evidenceQuote: { type: "string", minLength: 20, maxLength: 4000 }, rationale: { type: "string", minLength: 1, maxLength: 4000 },
        }, required: ["category", "status", "inspectionId", "evidenceQuote", "rationale"], additionalProperties: false } },
      },
      required: ["tool_call_id", "journal_name", "article_type", "identity_receipt_id", "inspection_ids", "rules", "coverage"], additionalProperties: false,
    },
  },
  {
    name: "validate_manuscript_for_journal",
    route: "/v1/platform/journals/validate-manuscript",
    description: "Validate the exact current manuscript and evidence bindings against one exact journal-profile version. Returns rule-level pass/fail/manual findings with official source URLs and quotes; it never upgrades a manual attestation by inference.",
    inputSchema: { type: "object", properties: { tool_call_id: { type: "string", minLength: 1, maxLength: 160 }, manuscript_id: { type: "string" }, journal_profile_id: { type: "string" }, human_attestation_receipt_ids: { type: "array", maxItems: 500, uniqueItems: true, items: { type: "string" } }, metadata: SUBMISSION_METADATA_SCHEMA }, required: ["tool_call_id", "manuscript_id", "journal_profile_id", "human_attestation_receipt_ids", "metadata"], additionalProperties: false },
  },
  {
    name: "export_journal_submission_bundle",
    route: "/v1/platform/journals/export-submission",
    description: "Build a hash-manifested ZIP containing DOCX, TeX, Markdown, exact bound figures, journal profile, validation report, evidence ledger, metadata, and cover letter. Export is blocked unless the exact manuscript/profile versions pass all error rules and every manual rule is explicitly attested.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 }, manuscript_id: { type: "string" }, expected_manuscript_version: { type: "integer", minimum: 1 }, expected_manuscript_content_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        journal_profile_id: { type: "string" }, expected_journal_profile_version: { type: "integer", minimum: 1 }, expected_journal_profile_content_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, human_attestation_receipt_ids: { type: "array", maxItems: 500, uniqueItems: true, items: { type: "string" } }, metadata: SUBMISSION_METADATA_SCHEMA,
      },
      required: ["tool_call_id", "manuscript_id", "expected_manuscript_version", "expected_manuscript_content_sha256", "journal_profile_id", "expected_journal_profile_version", "expected_journal_profile_content_sha256", "human_attestation_receipt_ids", "metadata"], additionalProperties: false,
    },
  },
];

const IMPLEMENTED_TOOL_IDS = new Set([
  "agentlas.earth-gutenberg-richter-analysis",
  "agentlas.physics-hepdata-chi-square-analysis",
  "agentlas.materials-lattice-metrics-analysis",
  "agentlas.statistics-analysis",
  "agentlas.table-to-vega",
  "agentlas.academic-to-citation-network",
  "agentlas.astronomy-to-sky-map",
  "agentlas.astronomy-light-curve-periodicity",
  "agentlas.biodiversity-to-map",
  "agentlas.earthquake-to-map",
  "agentlas.physics-dataset",
  "agentlas.source-to-molstar",
  "agentlas.smiles-to-ketcher",
  "agentlas.source-to-ketcher",
  "agentlas.vega-edit",
  "agentlas.molstar-view-edit",
  "agentlas.chemistry-smiles-edit",
]);

let server: http.Server | null = null;
let endpoint: string | null = null;
const grants = new Map<string, Grant>();

function stableUuid(value: string): string {
  const hex = createHash("sha256").update(value, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function tokenHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function authorize(header: string | undefined): Grant | null {
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  const digest = tokenHash(token);
  for (const [key, grant] of grants) {
    if (grant.expiresAt < Date.now()) {
      grants.delete(key);
      continue;
    }
    const left = Buffer.from(digest, "hex");
    const right = Buffer.from(grant.tokenHash, "hex");
    if (left.length === right.length && timingSafeEqual(left, right)) return grant;
  }
  return null;
}

function respond(response: http.ServerResponse, status: number, value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(bytes.length),
    "cache-control": "no-store",
  });
  response.end(bytes);
}

function positiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(code);
  return Number(value);
}

function boundedInteger(value: unknown, minimum: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(code);
  return Number(value);
}

function scienceEconomicsYears(startValue: unknown, endValue: unknown): { startYear: number; endYear: number } {
  const startYear = boundedInteger(startValue, 1800, 2200, "science-economics-start-year-invalid");
  const endYear = boundedInteger(endValue, 1800, 2200, "science-economics-end-year-invalid");
  if (startYear > endYear || endYear - startYear > 400) throw new Error("science-economics-year-range-invalid");
  return { startYear, endYear };
}

function nonNegativeInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(code);
  return Number(value);
}

function finiteNumber(value: unknown, minimum: number, maximum: number, code: string, exclusiveMaximum = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || (exclusiveMaximum ? value >= maximum : value > maximum)) throw new Error(code);
  return value;
}

function exactSha256(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(code);
  return value;
}

function exactText(value: unknown, maximum: number, code: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value)) throw new Error(code);
  return value.trim();
}

function exactToolBody(value: unknown, allowedKeys: readonly string[], code: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !allowedKeys.includes(key))) throw new Error(code);
}

function exactPatternText(value: unknown, maximum: number, pattern: RegExp, code: string): string {
  const text = exactText(value, maximum, code);
  if (!pattern.test(text)) throw new Error(code);
  return text;
}

function artifactResult(tool: ScienceLabToolDescriptor, artifact: {
  id: string;
  currentVersion: number;
  kind: string;
  title: string;
  version: { version: number; contentSha256: string };
}, replayed: boolean, run?: { id: string; status: string }): Record<string, unknown> {
  return {
    ok: true,
    schema: "agentlas.science-mcp-tool-result/v2",
    tool: { id: tool.id, version: tool.version, labId: tool.labId, operation: tool.operation },
    run: run ?? null,
    artifact: {
      id: artifact.id,
      version: artifact.version.version,
      currentVersion: artifact.currentVersion,
      kind: artifact.kind,
      title: artifact.title,
      contentSha256: artifact.version.contentSha256,
      labId: tool.labId,
    },
    replayed,
  };
}

function genomicsResultRecord(result: Awaited<ReturnType<ReturnType<typeof scienceGenomicsCatalogService>["search"]>>): Record<string, unknown> {
  return {
    ok: true,
    schema: "agentlas.science-genomics-mcp-result/v1",
    provider: result.provider,
    query: result.query,
    assembly: result.assembly,
    variantCount: result.variants.length,
    run: { id: result.runId, status: "succeeded" },
    artifact: {
      id: result.artifact.id,
      version: result.artifact.version.version,
      currentVersion: result.artifact.currentVersion,
      kind: result.artifact.kind,
      title: result.artifact.title,
      contentSha256: result.artifact.version.contentSha256,
      labId: "genomics-variants",
    },
    sources: [
      { id: result.assemblySourceId, versionId: result.assemblySourceVersionId, sha256: result.assemblyResponseSha256, url: result.assemblyEndpoint },
      { id: result.variantSourceId, versionId: result.variantSourceVersionId, sha256: result.variantResponseSha256, url: result.variantEndpoint },
    ],
    retrievedAt: result.retrievedAt,
    replayed: result.replayed,
  };
}

function manuscriptRecord(manuscript: ScienceManuscript, includeMarkdown: boolean): Record<string, unknown> {
  return {
    id: manuscript.id,
    projectId: manuscript.projectId,
    title: manuscript.title,
    status: manuscript.status,
    currentVersion: manuscript.currentVersion,
    updatedAt: manuscript.updatedAt,
    version: {
      id: manuscript.version.id,
      version: manuscript.version.version,
      ...(includeMarkdown ? { markdown: manuscript.version.markdown } : {}),
      contentSha256: manuscript.version.contentSha256,
      bindingManifestSha256: manuscript.version.bindingManifestSha256,
      bindingCount: manuscript.version.bindings.length,
      ...(includeMarkdown ? { bindings: manuscript.version.bindings } : {}),
      createdAt: manuscript.version.createdAt,
    },
  };
}

async function dispatchDescriptorTool(
  tool: ScienceLabToolDescriptor,
  body: Record<string, unknown>,
  grant: Grant,
  toolCallId: string,
): Promise<Record<string, unknown>> {
  const common = {
    requestId: stableUuid(`science-mcp-tool:v2:${grant.context.invocationRunId}:${tool.id}:${toolCallId}`),
    projectId: grant.context.projectId,
    conversationId: grant.context.conversationId,
    originMessageId: grant.context.originUserMessageId,
    turnId: grant.context.turnId,
    invocationRunId: grant.context.invocationRunId,
    toolCallId,
  };
  if (tool.id === "agentlas.statistics-analysis") {
    const sourceTable = body.source_table as Record<string, unknown> | undefined;
    const statisticsInput = {
      ...common,
      request: body.request as Record<string, unknown>,
      ...(sourceTable === undefined ? {} : {
        sourceTable: ({
          artifactId: sourceTable.artifact_id as string,
          artifactVersion: sourceTable.artifact_version as number,
          contentSha256: sourceTable.content_sha256 as string,
          ...(sourceTable.method === undefined ? {
            timeColumn: sourceTable.time_column as string,
            eventColumn: sourceTable.event_column as string,
            ...(sourceTable.label === undefined ? {} : { label: sourceTable.label as string }),
          } : {
            method: sourceTable.method as string,
            projectionKind: sourceTable.projection_kind as string,
            ...(sourceTable.method === "welch_one_way_anova" ? {
              groupColumn: sourceTable.group_column as string,
              valueColumn: sourceTable.value_column as string,
            } : sourceTable.method === "friedman_test" ? {
              blockColumn: sourceTable.block_column as string,
              conditionColumn: sourceTable.condition_column as string,
              valueColumn: sourceTable.value_column as string,
            } : sourceTable.method === "response_surface_regression" ? {
              responseColumn: sourceTable.response_column as string,
              factor1Column: sourceTable.factor1_column as string,
              factor2Column: sourceTable.factor2_column as string,
            } : sourceTable.method === "gaussian_random_intercept_lmm" ? {
              outcomeColumn: sourceTable.outcome_column as string,
              groupColumn: sourceTable.group_column as string,
              fixedEffects: sourceTable.fixed_effects,
              ...(sourceTable.observation_label_column === undefined ? {} : { observationLabelColumn: sourceTable.observation_label_column as string | null }),
            } : {
              outcomeColumn: sourceTable.outcome_column as string,
              scoreColumn: sourceTable.score_column as string,
              ...(sourceTable.observation_label_column === undefined ? {} : { observationLabelColumn: sourceTable.observation_label_column as string | null }),
            }),
          }),
        }) as ExecuteStatisticsAnalysisInput["sourceTable"],
      }),
    };
    const receipt = await scienceToolGateway().executeStatisticsAnalysis(statisticsInput);
    return artifactResult(tool, receipt.artifact, receipt.replayed, { id: receipt.run.id, status: receipt.run.status });
  }
  if (tool.id === "agentlas.earth-gutenberg-richter-analysis") {
    const result = scienceDomainAnalysisService().analyzeEarthGutenbergRichter({
      requestId: common.requestId,
      projectId: common.projectId,
      conversationId: common.conversationId,
      originMessageId: common.originMessageId,
      catalogRunId: body.catalog_run_id as string,
      completenessMagnitude: body.completeness_magnitude as number,
      magnitudeType: body.magnitude_type as string,
      ...(body.bin_width === undefined ? {} : { binWidth: body.bin_width as number }),
      ...(body.confidence_level === undefined ? {} : { confidenceLevel: body.confidence_level as number }),
      ...(body.title === undefined ? {} : { title: body.title as string }),
    });
    return { ...artifactResult(tool, result.artifact, result.replayed, { id: result.runId, status: "succeeded" }),
      methodRevision: result.analysis.methodRevision,
      selection: result.analysis.selection,
      estimates: result.analysis.estimates,
      parentRunId: result.parentRunId,
    };
  }
  if (tool.id === "agentlas.astronomy-light-curve-periodicity") {
    const sourceTable = body.source_table as Record<string, unknown>;
    const columns = body.columns as Record<string, unknown>;
    const receipt = await scienceToolGateway().executeAstronomyLightCurvePeriodicity({
      ...common,
      title: body.title as string,
      sourceTable: {
        artifactId: sourceTable.artifact_id as string,
        artifactVersion: sourceTable.artifact_version as number,
        contentSha256: sourceTable.content_sha256 as string,
      },
      columns: {
        observationIdColumn: columns.observation_id_column as string,
        timeColumn: columns.time_column as string,
        valueColumn: columns.value_column as string,
        standardErrorColumn: columns.standard_error_column as string,
        useColumn: columns.use_column as string,
      },
      analysis: {
        targetId: body.target_id as string,
        timeSystem: body.time_system as "BJD_TDB" | "BJD_UTC" | "HJD_UTC" | "JD_UTC" | "MJD_UTC" | "relative-day",
        timeOffsetDays: body.time_offset_days as number,
        valueKind: body.value_kind as "magnitude" | "flux" | "relative-flux" | "generic",
        valueUnit: body.value_unit as string | null,
        weighting: body.weighting as "auto" | "weighted" | "unweighted",
        minimumPeriodDays: body.minimum_period_days as number,
        maximumPeriodDays: body.maximum_period_days as number,
        frequencyCount: body.frequency_count as number,
        maximumPeaks: body.maximum_peaks === undefined ? 5 : body.maximum_peaks as number,
      },
    });
    const analysis = receipt.artifact.version.payload.analysis as Record<string, unknown>;
    const publication = receipt.artifact.version.payload.publication as Record<string, unknown>;
    const provenance = analysis.provenance as Record<string, unknown>;
    const tableRecord = (value: unknown) => value as { schema: string; rows: unknown[] };
    const observations = tableRecord(publication.observationsTable);
    const peaks = tableRecord(publication.peaksTable);
    const periodogram = tableRecord(publication.periodogramTable);
    return {
      ...artifactResult(tool, receipt.artifact, receipt.replayed, { id: receipt.run.id, status: receipt.run.status }),
      method: { id: "agentlas.astronomy.generalized-lomb-scargle", version: "1.0.0" },
      settings: analysis.settings,
      summary: analysis.summary,
      bestFit: analysis.bestFit,
      warnings: analysis.warnings,
      publicationTables: [
        { schema: observations.schema, rowCount: observations.rows.length, contentSha256: provenance.observationsTableSha256 },
        { schema: peaks.schema, rowCount: peaks.rows.length, contentSha256: provenance.peaksTableSha256 },
        { schema: periodogram.schema, rowCount: periodogram.rows.length, contentSha256: provenance.periodogramTableSha256 },
      ],
      figure: { schema: "agentlas.astronomy.light-curve-publication-figure/v1", contentSha256: provenance.figureSha256 },
      scientificLimits: ["false-alarm-probability-not-computed", "period-uncertainty-not-computed", "single-sinusoid-model-only"],
    };
  }
  if (tool.id === "agentlas.physics-hepdata-chi-square-analysis") {
    const prediction = body.prediction as { label: string; units: string | null; values: Array<number | null> };
    const result = scienceDomainAnalysisService().analyzePhysicsHepDataChiSquare({
      requestId: common.requestId,
      projectId: common.projectId,
      conversationId: common.conversationId,
      originMessageId: common.originMessageId,
      tableRunId: body.table_run_id as string,
      dependentSeriesIndex: body.dependent_series_index as number,
      prediction,
      uncertaintyLabels: body.uncertainty_labels as string[],
      ...(body.fitted_parameter_count === undefined ? {} : { fittedParameterCount: body.fitted_parameter_count as number }),
      ...(body.title === undefined ? {} : { title: body.title as string }),
    });
    return {
      ...artifactResult(tool, result.artifact, result.replayed, { id: result.runId, status: "succeeded" }),
      parentRunId: result.parentRunId,
      series: result.analysis.series,
      uncertaintyModel: result.analysis.uncertaintyModel,
      summary: result.analysis.summary,
    };
  }
  if (tool.id === "agentlas.materials-lattice-metrics-analysis") {
    const result = scienceDomainAnalysisService().analyzeMaterialsLatticeMetrics({
      requestId: common.requestId,
      projectId: common.projectId,
      conversationId: common.conversationId,
      originMessageId: common.originMessageId,
      catalogRunId: body.catalog_run_id as string,
      structureId: body.structure_id as string,
      ...(body.declared_volume_tolerance_relative === undefined ? {} : { declaredVolumeToleranceRelative: body.declared_volume_tolerance_relative as number }),
      ...(body.title === undefined ? {} : { title: body.title as string }),
    });
    return {
      ...artifactResult(tool, result.artifact, result.replayed, { id: result.runId, status: "succeeded" }),
      parentRunId: result.parentRunId,
      sourceLineage: result.analysis.sourceLineage,
      volume: result.analysis.volume,
      density: result.analysis.density,
    };
  }
  if (tool.id === "agentlas.source-to-molstar") {
    const receipt = await scienceToolGateway().executeSourceToMolstar({
      ...common,
      sourceId: body.source_id as string,
      sourceVersionId: body.source_version_id as string,
      title: body.title as string | undefined,
      representation: body.representation as "cartoon" | "ball-and-stick" | "surface" | undefined,
      colorTheme: body.color_theme as "chain-id" | "element-symbol" | "secondary-structure" | undefined,
    });
    return artifactResult(tool, receipt.artifact, receipt.replayed, { id: receipt.run.id, status: receipt.run.status });
  }
  if (tool.id === "agentlas.smiles-to-ketcher") {
    const receipt = await scienceToolGateway().executeSmilesToKetcher({
      ...common,
      title: body.title as string,
      smiles: body.smiles as string,
    });
    return artifactResult(tool, receipt.artifact, receipt.replayed, { id: receipt.run.id, status: receipt.run.status });
  }
  if (tool.id === "agentlas.source-to-ketcher") {
    const receipt = await scienceToolGateway().executeSourceToKetcher({
      ...common,
      retrievalRunId: body.retrieval_run_id as string,
      sourceId: body.source_id as string,
      sourceVersionId: body.source_version_id as string,
      title: body.title as string | undefined,
    });
    return artifactResult(tool, receipt.artifact, receipt.replayed, { id: receipt.run.id, status: receipt.run.status });
  }
  if (tool.id === "agentlas.table-to-vega") {
    const receipt = await scienceToolGateway().executeTableToVega({
      ...common,
      title: body.title as string,
      xField: body.x_field as string,
      yField: body.y_field as string,
      rows: body.rows as Array<Record<string, string | number>>,
    });
    return artifactResult(tool, receipt.artifact, receipt.replayed, { id: receipt.run.id, status: receipt.run.status });
  }
  if (tool.id === "agentlas.academic-to-citation-network") {
    const receipt = await scienceToolGateway().executeAcademicToCitationNetwork({
      ...common,
      searchRunId: body.search_run_id as string,
      title: body.title as string,
      maxRecords: body.max_records as number | undefined,
    });
    return artifactResult(tool, receipt.artifact, receipt.replayed, { id: receipt.run.id, status: receipt.run.status });
  }
  if (tool.id === "agentlas.astronomy-to-sky-map") {
    const receipt = await scienceToolGateway().executeAstronomyToSkyMap({
      ...common,
      catalogRunId: body.catalog_run_id as string,
      title: body.title as string,
    });
    return artifactResult(tool, receipt.artifact, receipt.replayed, { id: receipt.run.id, status: receipt.run.status });
  }
  if (tool.id === "agentlas.biodiversity-to-map") {
    const receipt = await scienceToolGateway().executeBiodiversityToMap({
      ...common,
      catalogRunId: body.catalog_run_id as string,
      title: body.title as string,
    });
    return artifactResult(tool, receipt.artifact, receipt.replayed, { id: receipt.run.id, status: receipt.run.status });
  }
  if (tool.id === "agentlas.earthquake-to-map") {
    const receipt = await scienceToolGateway().executeEarthquakeToMap({
      ...common,
      catalogRunId: body.catalog_run_id as string,
      title: body.title as string,
    });
    return artifactResult(tool, receipt.artifact, receipt.replayed, { id: receipt.run.id, status: receipt.run.status });
  }
  if (tool.id === "agentlas.physics-dataset") {
    const receipt = await scienceToolGateway().executePhysicsDataset({
      ...common,
      title: body.title as string,
      columns: body.columns as Array<{ name: string; type: "number" | "string"; unit?: string | null }>,
      rows: body.rows as Array<Array<string | number | null>>,
    });
    return artifactResult(tool, receipt.artifact, receipt.replayed, { id: receipt.run.id, status: receipt.run.status });
  }
  if (tool.id === "agentlas.vega-edit") {
    const parsed = parseScienceVegaEditInput({
      schema: "agentlas.science-vega-edit/v1",
      requestId: common.requestId,
      projectId: common.projectId,
      artifactId: body.artifact_id,
      expectedArtifactVersion: body.expected_artifact_version,
      expectedContentSha256: body.expected_content_sha256,
      title: body.title,
      mark: body.mark,
      color: body.color,
    });
    const result = commitScienceVegaEdit(scienceStore(), {
      ...parsed,
      actionContext: {
        conversationId: common.conversationId,
        originMessageId: common.originMessageId,
        turnId: common.turnId,
      },
    });
    return artifactResult(tool, result.artifact, result.replayed);
  }
  if (tool.id === "agentlas.molstar-view-edit") {
    const representation = body.representation as ScienceProteinRepresentation;
    const colorTheme = body.color_theme as ScienceProteinColorTheme;
    if (!["cartoon", "ball-and-stick", "surface"].includes(String(representation))) throw new Error("science-molstar-representation-invalid");
    if (!["chain-id", "element-symbol", "secondary-structure"].includes(String(colorTheme))) throw new Error("science-molstar-color-theme-invalid");
    if (body.interaction !== undefined && !isScienceResidueInteraction(body.interaction)) throw new Error("science-residue-interaction-invalid");
    const result = await commitScienceMolstarViewEdit(scienceStore(), {
      requestId: common.requestId,
      projectId: common.projectId,
      artifactId: exactText(body.artifact_id, 80, "science-artifact-id-invalid"),
      expectedArtifactVersion: positiveInteger(body.expected_artifact_version, "science-artifact-version-invalid"),
      expectedContentSha256: exactSha256(body.expected_content_sha256, "science-artifact-content-invalid"),
      representation,
      colorTheme,
      ...(body.interaction === undefined ? {} : { interaction: body.interaction }),
      actionContext: {
        conversationId: common.conversationId,
        originMessageId: common.originMessageId,
        turnId: common.turnId,
      },
    });
    return artifactResult(tool, result.artifact, result.replayed);
  }
  if (tool.id === "agentlas.chemistry-smiles-edit") {
    const result = await commitScienceChemistrySmilesEdit(scienceStore(), scienceChemistryValidator(), {
      requestId: common.requestId,
      projectId: common.projectId,
      artifactId: exactText(body.artifact_id, 80, "science-artifact-id-invalid"),
      expectedArtifactVersion: positiveInteger(body.expected_artifact_version, "science-artifact-version-invalid"),
      expectedContentSha256: exactSha256(body.expected_content_sha256, "science-artifact-content-invalid"),
      title: exactText(body.title, 240, "science-chemistry-validation-title-invalid"),
      smiles: exactText(body.smiles, 100_000, "science-chemistry-validation-smiles-invalid"),
      actionContext: {
        conversationId: common.conversationId,
        originMessageId: common.originMessageId,
        turnId: common.turnId,
      },
    });
    return artifactResult(tool, result.artifact, result.replayed);
  }
  throw new Error("science-tool-adapter-unavailable");
}

async function platformResult(route: string, body: Record<string, unknown>, grant: Grant, toolCallId: string): Promise<Record<string, unknown>> {
  const store = scienceStore();
  if (route === "/v1/platform/research-lifecycle/read") {
    const lifecycle = store.getResearchLifecycleForProject(grant.context.projectId);
    if (!lifecycle) throw new Error("science-research-lifecycle-canonical-missing");
    return { ok: true, schema: "agentlas.science.research-lifecycle-read/v1", lifecycle };
  }
  if (route === "/v1/platform/evidence-graph/inspect") {
    const service = scienceEvidenceGraphService();
    const refreshed = service.refresh({
      requestId: stableUuid(`science-evidence-graph-inspect:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
    });
    const context = service.boundedContext(
      grant.context.projectId,
      exactText(body.query, 2_000, "science-evidence-graph-query-invalid"),
      body.limit === undefined ? 40 : boundedInteger(body.limit, 1, 100, "science-evidence-graph-limit-invalid"),
      {
        ...(body.direction === undefined ? {} : { direction: body.direction as "outgoing" | "incoming" | "both" }),
        ...(body.edge_kinds === undefined ? {} : {
          edgeKinds: (body.edge_kinds as unknown[]).map((item) => exactText(item, 32, "science-evidence-graph-traversal-edge-kind-invalid") as ScienceEvidenceGraphEdgeKind),
        }),
        ...(body.max_hops === undefined ? {} : { maxHops: boundedInteger(body.max_hops, 1, 6, "science-evidence-graph-query-budget-invalid") }),
        ...(body.max_seeds === undefined ? {} : { maxSeeds: boundedInteger(body.max_seeds, 1, 24, "science-evidence-graph-query-budget-invalid") }),
        ...(body.max_nodes === undefined ? {} : { maxNodes: boundedInteger(body.max_nodes, 4, 100, "science-evidence-graph-query-budget-invalid") }),
        ...(body.max_edges === undefined ? {} : { maxEdges: boundedInteger(body.max_edges, 1, 400, "science-evidence-graph-query-budget-invalid") }),
      },
    );
    return { ok: true, schema: "agentlas.science.evidence-graph-inspection/v1", graph: refreshed.graph, context };
  }
  if (route === "/v1/platform/evidence-graph/inferences/propose") {
    const conditioningContext = body.conditioning_context;
    if (!conditioningContext || typeof conditioningContext !== "object" || Array.isArray(conditioningContext)) {
      throw new Error("science-evidence-graph-context-invalid");
    }
    const result = scienceEvidenceGraphService().proposeInference({
      requestId: stableUuid(`science-evidence-graph-propose:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      expectedGraphRevision: positiveInteger(body.expected_graph_revision, "science-evidence-graph-revision-invalid"),
      expectedGraphContentSha256: exactSha256(body.expected_graph_content_sha256, "science-evidence-graph-content-invalid"),
      label: exactText(body.label, 500, "science-evidence-graph-inference-label-invalid"),
      statement: exactText(body.statement, 20_000, "science-evidence-graph-inference-statement-invalid"),
      rationale: exactText(body.rationale, 20_000, "science-evidence-graph-inference-rationale-invalid"),
      normalizedProposition: exactText(body.normalized_proposition, 2_000, "science-evidence-graph-inference-proposition-invalid"),
      polarity: body.polarity as "supports" | "opposes" | "neutral",
      conditioningContext: conditioningContext as unknown as ScienceEvidenceGraphConditioningContext,
      evidencePathNodeIds: Array.isArray(body.evidence_path_node_ids) ? body.evidence_path_node_ids.map((id) => exactText(id, 80, "science-evidence-graph-inference-evidence-invalid")) : [],
      falsificationCriteria: Array.isArray(body.falsification_criteria) ? body.falsification_criteria.map((item) => exactText(item, 2_000, "science-evidence-graph-inference-falsification-invalid")) : [],
      alternativeHypothesis: exactText(body.alternative_hypothesis, 10_000, "science-evidence-graph-inference-alternative-invalid"),
      producer: { kind: "agent", id: grant.context.researchDirectorAgentId },
    });
    return { ok: true, schema: "agentlas.science.evidence-graph-inference-proposal/v1", ...result };
  }
  if (route === "/v1/platform/evidence-graph/inferences/materialize") {
    const result = scienceEvidenceGraphService().materializeInferenceAsHypothesis({
      requestId: stableUuid(`science-evidence-graph-materialize:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      graphRevisionId: exactText(body.graph_revision_id, 80, "science-evidence-graph-materialization-graph-invalid"),
      expectedGraphContentSha256: exactSha256(body.expected_graph_content_sha256, "science-evidence-graph-materialization-graph-invalid"),
      candidateId: exactText(body.candidate_id, 80, "science-evidence-graph-materialization-candidate-invalid"),
      expectedCandidateContentSha256: exactSha256(body.expected_candidate_content_sha256, "science-evidence-graph-materialization-candidate-invalid"),
      expectedReviewSha256: exactSha256(body.expected_review_sha256, "science-evidence-graph-materialization-review-invalid"),
      contractId: exactText(body.contract_id, 80, "science-evidence-graph-materialization-contract-invalid"),
      role: body.role as "primary" | "alternative",
    });
    return { ok: true, schema: "agentlas.science.evidence-graph-inference-materialization-result/v1", ...result };
  }
  if (route === "/v1/platform/evidence-graph/path") {
    return { ok: true, ...scienceEvidenceGraphService().explainPath(
      grant.context.projectId,
      exactText(body.from_node_id, 80, "science-evidence-graph-path-node-invalid"),
      exactText(body.to_node_id, 80, "science-evidence-graph-path-node-invalid"),
    ) };
  }
  if (route === "/v1/platform/lab-intents/list") {
    const grantedLabIds = grant.catalog.labs.map((lab) => lab.id);
    const requestedLabIds = body.lab_ids === undefined
      ? grantedLabIds
      : Array.isArray(body.lab_ids) && body.lab_ids.length > 0
        ? body.lab_ids.map((labId) => exactText(labId, 80, "science-research-intent-lab-invalid"))
        : (() => { throw new Error("science-research-intent-lab-invalid"); })();
    if (new Set(requestedLabIds).size !== requestedLabIds.length
      || requestedLabIds.some((labId) => !grantedLabIds.includes(labId))) {
      throw new Error("science-research-intent-lab-invalid");
    }
    return { ok: true, ...scienceResearchIntentCatalog(requestedLabIds) };
  }
  if (route === "/v1/platform/research-workspace/inspect") {
    const requestedLimit = body.limit === undefined ? 100 : positiveInteger(body.limit, "science-research-workspace-limit-invalid");
    if (requestedLimit > 200) throw new Error("science-research-workspace-limit-invalid");
    const project = store.getProject(grant.context.projectId);
    const lifecycle = store.getResearchLifecycleForProject(grant.context.projectId);
    if (!project) throw new Error("science-project-not-found");
    if (!lifecycle) throw new Error("science-research-lifecycle-canonical-missing");
    const sources = store.listSources(project.id, requestedLimit).map((source) => ({
      id: source.id,
      kind: source.kind,
      title: source.title,
      canonicalUri: source.canonicalUri,
      verificationStatus: source.verificationStatus,
      currentVersion: source.currentVersion,
      version: {
        id: source.version.id,
        version: source.version.version,
        accessState: source.version.accessState,
        contentSha256: source.version.contentSha256,
        mimeType: source.version.mimeType,
        retrievedAt: source.version.retrievedAt,
        retrievalMethod: source.version.retrievalMethod,
      },
      updatedAt: source.updatedAt,
    }));
    const runs = store.listResearchRuns(project.id, requestedLimit).map((run) => ({
      id: run.id,
      parentRunId: run.parentRunId,
      toolId: run.toolId,
      toolVersion: run.toolVersion,
      runtime: run.runtime,
      status: run.status,
      inputManifestSha256: run.inputManifestSha256,
      environmentSha256: run.environmentSha256,
      outputManifestSha256: run.outputManifestSha256,
      summary: run.summary,
      analysisPlan: run.analysisPlan,
      inputCount: run.inputs.length,
      outputCount: run.outputs.length,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    }));
    const artifacts = store.listArtifacts(project.id, requestedLimit).map((artifact) => {
      const context = store.getArtifactContextForProject(project.id, artifact.id, artifact.currentVersion);
      if (!context?.isCurrent || context.selectedVersion.contentSha256 !== artifact.version.contentSha256) {
        throw new Error("science-research-workspace-artifact-integrity-failed");
      }
      return {
        id: artifact.id,
        kind: artifact.kind,
        title: artifact.title,
        status: artifact.status,
        labId: context.linkage.labId,
        sourceRunId: artifact.sourceRunId,
        currentVersion: artifact.currentVersion,
        version: {
          id: artifact.version.id,
          version: artifact.version.version,
          rendererId: artifact.version.rendererId,
          rendererVersion: artifact.version.rendererVersion,
          contentSha256: artifact.version.contentSha256,
          semanticTitle: artifact.version.semantic.title,
          semanticSummary: artifact.version.semantic.summary,
        },
        linkageSha256: context.linkage.linkageSha256,
        updatedAt: artifact.updatedAt,
      };
    });
    const activeLoopSession = store.getActiveLoopSession(project.id);
    const activeEpisodes = activeLoopSession ? store.listResearchEpisodes(project.id, activeLoopSession.id) : [];
    const labDecisionProjections = scienceLabDecisionProjectionsForProject(store, project.id, grant.catalog);
    return {
      ok: true,
      schema: "agentlas.science.research-workspace/v1",
      project,
      lifecycle,
      researchContract: store.latestResearchContract(project.id),
      researchLoop: activeLoopSession ? { session: activeLoopSession, episodes: activeEpisodes } : null,
      researchIntents: scienceResearchIntentCatalog(grant.catalog.labs.map((lab) => lab.id)),
      labDecisionProjections,
      labs: store.listLabs(project.id),
      sources,
      runs,
      artifacts,
      window: {
        limit: requestedLimit,
        sourcesMayBeTruncated: sources.length === requestedLimit,
        runsMayBeTruncated: runs.length === requestedLimit,
        artifactsMayBeTruncated: artifacts.length === requestedLimit,
      },
    };
  }
  if (route === "/v1/platform/research-contracts/propose") {
    const result = store.saveResearchContract({
      requestId: stableUuid(`science-research-contract-propose:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      expectedProjectVersion: positiveInteger(body.expected_project_version, "science-project-version-invalid"),
      objective: exactText(body.objective, 20_000, "science-contract-objective-invalid"),
      successCriteria: body.success_criteria as string[],
      failureCriteria: body.failure_criteria as string[],
      constraints: body.constraints as string[],
      maxEpisodes: positiveInteger(body.max_episodes, "science-contract-max-episodes-invalid"),
      maxWallTimeMinutes: positiveInteger(body.max_wall_time_minutes, "science-contract-max-wall-time-invalid"),
    });
    return { ok: true, schema: "agentlas.science.research-contract-proposal/v1", ...result };
  }
  if (route === "/v1/platform/research-loop/inspect") {
    const active = store.getActiveLoopSession(grant.context.projectId);
    const sessions = store.listLoopSessions(grant.context.projectId);
    const session = active ?? sessions[0] ?? null;
    const episodes = session ? store.listResearchEpisodes(grant.context.projectId, session.id) : [];
    const events = session ? store.listLoopEvents(session.id, 0, 1_000) : [];
    return {
      ok: true,
      schema: "agentlas.science.research-loop-inspection/v1",
      active: active !== null,
      session,
      episodes,
      events,
      budget: session ? {
        usedEpisodes: session.currentEpisode,
        remainingEpisodes: Math.max(0, session.maxEpisodes - session.currentEpisode),
        maxEpisodes: session.maxEpisodes,
        maxWallTimeMinutes: session.maxWallTimeMinutes,
        deadlineAt: session.deadlineAt,
        remainingWallTimeMs: Math.max(0, Date.parse(session.deadlineAt) - Date.now()),
        exhausted: session.currentEpisode >= session.maxEpisodes || Date.now() >= Date.parse(session.deadlineAt),
      } : null,
    };
  }
  if (route === "/v1/platform/research-loop/start") {
    let result = store.startLoopSession({
      requestId: stableUuid(`science-research-loop-start:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      conversationId: grant.context.conversationId,
      contractId: exactText(body.contract_id, 80, "science-loop-contract-id-invalid"),
      expectedProjectVersion: positiveInteger(body.expected_project_version, "science-project-version-invalid"),
      expectedContractVersion: positiveInteger(body.expected_contract_version, "science-contract-version-invalid"),
    });
    if (result.session.status === "queued") {
      const session = store.confirmLoopResumeDispatch({
        projectId: grant.context.projectId,
        loopSessionId: result.session.id,
        expectedLoopVersion: result.session.version,
        expectedLoopStateSha256: result.session.stateSha256,
        invocationRunId: grant.context.invocationRunId,
      });
      result = { ...result, session };
    }
    return { ok: true, schema: "agentlas.science.research-loop-start-result/v1", ...result };
  }
  if (route === "/v1/platform/research-episodes/propose") {
    const toolIntents = (body.tool_intents as Array<Record<string, unknown>>).map((item) => ({
      toolName: exactText(item.tool_name, 160, "science-research-episode-tool-name-invalid"),
      labId: exactText(item.lab_id, 80, "science-research-episode-lab-id-invalid"),
      purpose: exactText(item.purpose, 4_000, "science-research-episode-tool-purpose-invalid"),
    }));
    const result = store.planResearchEpisode({
      requestId: stableUuid(`science-research-episode-propose:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      loopSessionId: exactText(body.loop_session_id, 80, "science-loop-session-id-invalid"),
      expectedLoopVersion: positiveInteger(body.expected_loop_version, "science-loop-version-invalid"),
      expectedLoopStateSha256: exactSha256(body.expected_loop_state_sha256, "science-loop-state-invalid"),
      hypothesisId: exactText(body.hypothesis_id, 80, "science-hypothesis-id-invalid"),
      expectedHypothesisVersion: positiveInteger(body.expected_hypothesis_version, "science-hypothesis-version-invalid"),
      expectedHypothesisContentSha256: exactSha256(body.expected_hypothesis_content_sha256, "science-hypothesis-content-invalid"),
      kind: body.kind as "literature" | "simulation" | "experiment" | "analysis" | "verification",
      objective: exactText(body.objective, 20_000, "science-research-episode-objective-invalid"),
      method: exactText(body.method, 40_000, "science-research-episode-method-invalid"),
      expectedObservations: body.expected_observations as string[],
      falsificationCriteria: body.falsification_criteria as string[],
      toolIntents,
    });
    return { ok: true, schema: "agentlas.science.research-episode-plan-result/v1", ...result };
  }
  if (route === "/v1/platform/research-episodes/start") {
    const result = store.startResearchEpisode({
      requestId: stableUuid(`science-research-episode-start:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      loopSessionId: exactText(body.loop_session_id, 80, "science-loop-session-id-invalid"),
      episodeId: exactText(body.episode_id, 80, "science-research-episode-id-invalid"),
      expectedLoopVersion: positiveInteger(body.expected_loop_version, "science-loop-version-invalid"),
      expectedLoopStateSha256: exactSha256(body.expected_loop_state_sha256, "science-loop-state-invalid"),
      expectedEpisodeVersion: positiveInteger(body.expected_episode_version, "science-research-episode-version-invalid"),
      expectedEpisodeStateSha256: exactSha256(body.expected_episode_state_sha256, "science-research-episode-state-invalid"),
      expectedPlanSha256: exactSha256(body.expected_plan_sha256, "science-research-episode-plan-invalid"),
    });
    return { ok: true, schema: "agentlas.science.research-episode-start-result/v1", ...result };
  }
  if (route === "/v1/platform/research-episodes/settle") {
    const artifacts = (body.artifacts as Array<Record<string, unknown>>).map((item) => ({
      artifactId: exactText(item.artifact_id, 80, "science-research-episode-artifact-id-invalid"),
      artifactVersion: positiveInteger(item.artifact_version, "science-research-episode-artifact-version-invalid"),
      contentSha256: exactSha256(item.content_sha256, "science-research-episode-artifact-content-invalid"),
    }));
    const result = store.settleResearchEpisode({
      requestId: stableUuid(`science-research-episode-settle:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      loopSessionId: exactText(body.loop_session_id, 80, "science-loop-session-id-invalid"),
      episodeId: exactText(body.episode_id, 80, "science-research-episode-id-invalid"),
      expectedLoopVersion: positiveInteger(body.expected_loop_version, "science-loop-version-invalid"),
      expectedLoopStateSha256: exactSha256(body.expected_loop_state_sha256, "science-loop-state-invalid"),
      expectedEpisodeVersion: positiveInteger(body.expected_episode_version, "science-research-episode-version-invalid"),
      expectedEpisodeStateSha256: exactSha256(body.expected_episode_state_sha256, "science-research-episode-state-invalid"),
      expectedPlanSha256: exactSha256(body.expected_plan_sha256, "science-research-episode-plan-invalid"),
      status: body.status as "succeeded" | "failed" | "cancelled",
      outcome: body.outcome as "supported" | "contradicted" | "inconclusive" | "not-tested",
      observationSummary: exactText(body.observation_summary, 40_000, "science-research-episode-observation-invalid"),
      conclusion: exactText(body.conclusion, 40_000, "science-research-episode-conclusion-invalid"),
      nextAction: exactText(body.next_action, 20_000, "science-research-episode-next-action-invalid"),
      runIds: body.run_ids as string[],
      artifacts,
      evidenceSpanIds: body.evidence_span_ids as string[],
    });
    return { ok: true, schema: "agentlas.science.research-episode-settle-result/v1", ...result };
  }
  if (route === "/v1/platform/research-loop/criteria/verify") {
    const artifacts = (body.artifacts as Array<Record<string, unknown>>).map((item) => ({
      artifactId: exactText(item.artifact_id, 80, "science-loop-criterion-artifact-id-invalid"),
      artifactVersion: positiveInteger(item.artifact_version, "science-loop-criterion-artifact-version-invalid"),
      contentSha256: exactSha256(item.content_sha256, "science-loop-criterion-artifact-content-invalid"),
    }));
    const result = store.recordLoopCriterionVerification({
      requestId: stableUuid(`science-research-loop-criterion-verify:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      loopSessionId: exactText(body.loop_session_id, 80, "science-loop-session-id-invalid"),
      expectedLoopVersion: positiveInteger(body.expected_loop_version, "science-loop-version-invalid"),
      expectedLoopStateSha256: exactSha256(body.expected_loop_state_sha256, "science-loop-state-invalid"),
      criterionIndex: Number(body.criterion_index),
      verdict: body.verdict as "passed" | "failed" | "inconclusive",
      evidenceSpanIds: body.evidence_span_ids as string[],
      artifacts,
      verifier: {
        method: "research-director-attestation",
        agentId: grant.context.researchDirectorAgentId,
        agentSlug: grant.context.researchDirectorAgentSlug,
        packageVersion: grant.context.researchDirectorPackageVersion,
        packageDigest: grant.context.researchDirectorPackageDigest,
        systemPromptSha256: grant.context.researchDirectorSystemPromptSha256,
        invocationRunId: grant.context.invocationRunId,
      },
      summary: exactText(body.summary, 8_000, "science-loop-criterion-summary-invalid"),
    });
    return { ok: true, schema: "agentlas.science.research-loop-criterion-verification-result/v1", ...result };
  }
  if (route === "/v1/platform/research-loop/transition") {
    let result = store.transitionLoopSession({
      requestId: stableUuid(`science-research-loop-transition:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      loopSessionId: exactText(body.loop_session_id, 80, "science-loop-session-id-invalid"),
      expectedLoopVersion: positiveInteger(body.expected_loop_version, "science-loop-version-invalid"),
      expectedLoopStateSha256: exactSha256(body.expected_loop_state_sha256, "science-loop-state-invalid"),
      action: body.action as "pause" | "resume" | "complete" | "fail" | "cancel",
      reason: exactText(body.reason, 8_000, "science-loop-transition-reason-invalid"),
    });
    if (body.action === "resume" && result.session.status === "queued") {
      const session = store.confirmLoopResumeDispatch({
        projectId: grant.context.projectId,
        loopSessionId: result.session.id,
        expectedLoopVersion: result.session.version,
        expectedLoopStateSha256: result.session.stateSha256,
        invocationRunId: grant.context.invocationRunId,
      });
      result = { ...result, session };
    }
    return { ok: true, schema: "agentlas.science.research-loop-transition-result/v1", ...result };
  }
  if (route === "/v1/platform/research-lifecycle/append") {
    const result = store.appendResearchLifecycleRevision({
      requestId: stableUuid(`science-research-lifecycle-append:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      studyId: exactText(body.study_id, 80, "science-research-lifecycle-study-id-invalid"),
      expectedRevision: positiveInteger(body.expected_revision, "science-research-lifecycle-expected-revision-invalid"),
      expectedStateSha256: exactSha256(body.expected_state_sha256, "science-research-lifecycle-expected-state-invalid"),
      phase: body.phase as ScienceResearchLifecyclePhase,
      question: body.question as string,
      preconditions: body.preconditions as ScienceResearchLifecycleTransitionPreconditions,
      openBlockingDecisions: body.open_blocking_decisions as ScienceResearchBlockingDecision[],
      blockers: body.blockers as string[],
      frozenAnalysisPlan: body.frozen_analysis_plan as ScienceResearchFrozenPlanBinding | null,
      submissionExport: body.submission_export as ScienceResearchSubmissionExportBinding | null,
      stop: body.stop as ScienceResearchStopCondition | null,
    });
    return { ok: true, schema: "agentlas.science.research-lifecycle-append-result/v1", ...result };
  }
  if (route === "/v1/platform/sources/promote-abstract") {
    const result = store.promoteSourceAbstract({
      requestId: stableUuid(`science-source-abstract-promote:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      sourceId: exactText(body.source_id, 80, "science-source-id-invalid"),
      expectedSourceVersionId: exactText(body.expected_source_version_id, 80, "science-source-version-id-invalid"),
    });
    return { ok: true, schema: "agentlas.science.source-abstract-evidence/v1", ...result };
  }
  if (route === "/v1/platform/evidence/stage-response") {
    const result = store.stageMessageEvidence({
      requestId: stableUuid(`science-response-evidence-stage:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      conversationId: grant.context.conversationId,
      turnId: grant.context.turnId,
      invocationRunId: grant.context.invocationRunId,
      blockOrdinal: positiveInteger(body.block_ordinal, "science-message-block-ordinal-invalid"),
      blockKind: body.block_kind as "markdown" | "claim" | "artifact" | "run-status",
      blockContent: exactText(body.block_content, 100_000, "science-message-block-content-invalid"),
      sourceId: exactText(body.source_id, 80, "science-source-id-invalid"),
      sourceVersionId: exactText(body.source_version_id, 80, "science-source-version-id-invalid"),
      citationOrdinal: positiveInteger(body.citation_ordinal, "science-citation-ordinal-invalid"),
      relation: body.relation as "supports" | "contradicts" | "context",
      locator: exactText(body.locator, 2_000, "science-evidence-locator-invalid"),
      startByte: nonNegativeInteger(body.start_byte, "science-evidence-start-byte-invalid"),
      endByte: positiveInteger(body.end_byte, "science-evidence-end-byte-invalid"),
      excerpt: exactText(body.excerpt, 20_000, "science-evidence-excerpt-invalid"),
    });
    return { ok: true, schema: "agentlas.science.staged-response-evidence/v1", ...result };
  }
  if (route === "/v1/platform/evidence/list") {
    return {
      ok: true,
      schema: "agentlas.science.evidence-ledger/v1",
      entries: store.listProjectEvidenceLedger(grant.context.projectId),
      literatureManifest: store.currentLiteratureEvidenceManifest(grant.context.projectId),
    };
  }
  if (route === "/v1/platform/hypotheses/list") {
    const currentOnly = body.include_history !== true;
    return {
      ok: true,
      schema: "agentlas.science.hypothesis-list/v1",
      currentOnly,
      hypotheses: store.listHypotheses(grant.context.projectId, currentOnly),
      currentManifest: store.currentHypothesisManifest(grant.context.projectId),
    };
  }
  if (route === "/v1/platform/hypotheses/propose") {
    const result = store.proposeHypothesis({
      requestId: stableUuid(`science-hypothesis-propose:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      contractId: exactText(body.contract_id, 80, "science-hypothesis-contract-invalid"),
      role: body.role as "primary" | "alternative",
      statement: exactText(body.statement, 20_000, "science-hypothesis-statement-invalid"),
      rationale: exactText(body.rationale, 20_000, "science-hypothesis-rationale-invalid"),
      falsificationCriteria: body.falsification_criteria as string[],
      evidenceSpanIds: body.evidence_span_ids as string[],
      episodeResultIds: body.episode_result_ids === undefined ? [] : body.episode_result_ids as string[],
    });
    return { ok: true, schema: "agentlas.science.hypothesis-write-result/v1", ...result };
  }
  if (route === "/v1/platform/hypotheses/revise") {
    const result = store.reviseHypothesis({
      requestId: stableUuid(`science-hypothesis-revise:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      parentHypothesisId: exactText(body.parent_hypothesis_id, 80, "science-hypothesis-parent-invalid"),
      expectedParentVersion: positiveInteger(body.expected_parent_version, "science-hypothesis-parent-version-invalid"),
      expectedParentContentSha256: exactSha256(body.expected_parent_content_sha256, "science-hypothesis-parent-content-invalid"),
      role: body.role as "primary" | "alternative",
      status: body.status as "proposed" | "approved" | "rejected" | "supported" | "contradicted",
      statement: exactText(body.statement, 20_000, "science-hypothesis-statement-invalid"),
      rationale: exactText(body.rationale, 20_000, "science-hypothesis-rationale-invalid"),
      falsificationCriteria: body.falsification_criteria as string[],
      evidenceSpanIds: body.evidence_span_ids as string[],
      episodeResultIds: body.episode_result_ids === undefined ? [] : body.episode_result_ids as string[],
    });
    return { ok: true, schema: "agentlas.science.hypothesis-write-result/v1", ...result };
  }
  if (route === "/v1/platform/scientific-data/sources") {
    return { ok: true, schema: "agentlas.scientific-data-source-registry/v1", sources: scienceScientificDataService().listSources() };
  }
  if (route === "/v1/platform/capabilities") {
    return { ok: true, ...grant.catalog };
  }
  if (route === "/v1/platform/analysis-plans/list") {
    return { ok: true, schema: "agentlas.science-analysis-plan-list/v1", analysisPlans: store.listAnalysisSpecs(grant.context.projectId) };
  }
  if (route === "/v1/platform/analysis-plans/propose") {
    const result = store.proposeAnalysisPlan({
      requestId: stableUuid(`science-analysis-plan-propose:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      title: exactText(body.title, 500, "science-analysis-title-invalid"),
      document: body.document as ScienceAnalysisSpecDocument,
      decisions: body.decisions as ScienceAnalysisDecisionDraft[],
    });
    return { ok: true, schema: "agentlas.science-analysis-plan-write-result/v1", ...result };
  }
  if (route === "/v1/platform/analysis-decisions/list") {
    const analysisSpecId = body.analysis_spec_id === undefined ? undefined : exactText(body.analysis_spec_id, 80, "science-analysis-spec-id-invalid");
    const statuses = body.statuses === undefined ? undefined : body.statuses as ScienceDecisionRequest["status"][];
    return { ok: true, schema: "agentlas.science-analysis-decision-list/v1", decisions: store.listDecisionRequests(grant.context.projectId, analysisSpecId, statuses) };
  }
  if (route === "/v1/platform/analysis-decisions/present") {
    const result = store.presentDecision({
      requestId: stableUuid(`science-analysis-decision-present:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      decisionId: exactText(body.decision_id, 80, "science-decision-id-invalid"),
      expectedLockVersion: positiveInteger(body.expected_lock_version, "science-decision-lock-version-invalid"),
    });
    return { ok: true, schema: "agentlas.science-analysis-decision-present-result/v1", ...result };
  }
  if (route === "/v1/platform/analysis-plans/freeze") {
    const result = store.freezeAnalysisSpec({
      requestId: stableUuid(`science-analysis-plan-freeze:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      analysisSpecId: exactText(body.analysis_spec_id, 80, "science-analysis-spec-id-invalid"),
      expectedVersion: positiveInteger(body.expected_version, "science-analysis-version-invalid"),
      expectedContentSha256: exactSha256(body.expected_content_sha256, "science-analysis-content-invalid"),
      expectedLockVersion: positiveInteger(body.expected_lock_version, "science-analysis-lock-version-invalid"),
    });
    return { ok: true, schema: "agentlas.science-analysis-plan-freeze-result/v1", ...result };
  }
  if (route === "/v1/platform/journals/list") {
    return { ok: true, schema: "agentlas.science-journal-profile-list/v1", profiles: store.listJournalProfiles(grant.context.projectId) };
  }
  if (route === "/v1/platform/journals/create-profile") {
    const result = scienceJournalPublicationService().createJournalProfile({
      requestId: stableUuid(`science-journal-profile:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      journalName: exactText(body.journal_name, 500, "science-journal-name-invalid"),
      articleType: exactText(body.article_type, 500, "science-journal-article-type-invalid"),
      identityReceiptId: exactText(body.identity_receipt_id, 80, "science-journal-identity-receipt-invalid"),
      inspectionIds: body.inspection_ids as string[],
      rules: body.rules as ScienceJournalRuleInput[],
      coverage: body.coverage as ScienceJournalCoverageEntry[],
    });
    return { ok: true, schema: "agentlas.science-journal-profile-write-result/v1", profile: result.profile, replayed: result.replayed };
  }
  if (route === "/v1/platform/journals/validate-manuscript") {
    const manuscript = store.getManuscriptForProject(grant.context.projectId, exactText(body.manuscript_id, 80, "science-manuscript-id-invalid"));
    const profile = store.getJournalProfileForProject(grant.context.projectId, exactText(body.journal_profile_id, 80, "science-journal-profile-id-invalid"));
    if (!manuscript || !profile) throw new Error("science-journal-validation-target-not-found");
    return { ok: true, validation: scienceJournalPublicationService().validate(manuscript, profile, body.metadata as ScienceSubmissionMetadata, body.human_attestation_receipt_ids as string[]) };
  }
  if (route === "/v1/platform/journals/export-submission") {
    const result = scienceJournalPublicationService().createSubmissionExport({
      requestId: stableUuid(`science-submission-export:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      manuscriptId: exactText(body.manuscript_id, 80, "science-manuscript-id-invalid"),
      expectedManuscriptVersion: positiveInteger(body.expected_manuscript_version, "science-manuscript-version-invalid"),
      expectedManuscriptContentSha256: exactSha256(body.expected_manuscript_content_sha256, "science-manuscript-content-invalid"),
      journalProfileId: exactText(body.journal_profile_id, 80, "science-journal-profile-id-invalid"),
      expectedJournalProfileVersion: positiveInteger(body.expected_journal_profile_version, "science-journal-profile-version-invalid"),
      expectedJournalProfileContentSha256: exactSha256(body.expected_journal_profile_content_sha256, "science-journal-profile-content-invalid"),
      metadata: body.metadata as ScienceSubmissionMetadata,
      humanAttestationReceiptIds: body.human_attestation_receipt_ids as string[],
    });
    return { ok: true, schema: "agentlas.science-submission-export-result/v1", ...result };
  }
  if (route === "/v1/platform/manuscripts/list") {
    return {
      ok: true,
      schema: "agentlas.science-manuscript-list/v1",
      manuscripts: store.listManuscripts(grant.context.projectId).map((manuscript) => manuscriptRecord(manuscript, false)),
    };
  }
  if (route === "/v1/platform/artifacts/validate-for-manuscript") {
    const result = scienceArtifactPublicationValidator().validate({
      requestId: stableUuid(`science-publication-validation:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      artifactId: exactText(body.artifact_id, 80, "science-artifact-id-invalid"),
      artifactVersion: positiveInteger(body.artifact_version, "science-artifact-version-invalid"),
    });
    return {
      ok: true,
      schema: "agentlas.science-publication-artifact-validation-result/v1",
      receipt: result.receipt,
      bindingTarget: result.bindingTarget,
      replayed: result.replayed,
    };
  }
  if (route === "/v1/platform/manuscripts/inspect") {
    const manuscriptId = exactText(body.manuscript_id, 80, "science-manuscript-id-invalid");
    const manuscript = store.getManuscriptForProject(grant.context.projectId, manuscriptId);
    if (!manuscript) throw new Error("science-manuscript-not-found");
    return { ok: true, schema: "agentlas.science-manuscript-inspection/v1", manuscript: manuscriptRecord(manuscript, true) };
  }
  if (route === "/v1/platform/claim-ledgers/prepare-context") {
    const result = store.prepareClaimLedgerContext({
      requestId: stableUuid(`science-claim-context-prepare:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      manuscriptId: exactText(body.manuscript_id, 80, "science-manuscript-id-invalid"),
      expectedManuscriptVersion: positiveInteger(body.expected_manuscript_version, "science-manuscript-version-invalid"),
      expectedManuscriptContentSha256: exactSha256(body.expected_manuscript_content_sha256, "science-manuscript-content-invalid"),
      citationIds: body.citation_ids as string[],
      validationReceiptIds: body.validation_receipt_ids as string[],
    });
    return { ok: true, schema: "agentlas.science.claim-context-prepare-result/v1", ...result };
  }
  if (route === "/v1/platform/claim-ledgers/inspect") {
    const manuscriptId = exactText(body.manuscript_id, 80, "science-manuscript-id-invalid");
    const ledger = store.getClaimLedgerForManuscript(grant.context.projectId, manuscriptId);
    if (!ledger) throw new Error("science-claim-ledger-required");
    return { ok: true, schema: "agentlas.science.claim-ledger-read/v1", ledger };
  }
  if (route === "/v1/platform/claim-ledgers/create") {
    const result = store.createClaimLedger({ requestId: stableUuid(`science-claim-ledger-create:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId, manifest: body.manifest as ScienceClaimLedgerManifest });
    return { ok: true, schema: "agentlas.science.claim-ledger-mutation/v1", ...result };
  }
  if (route === "/v1/platform/claim-ledgers/append") {
    const result = store.appendClaimLedgerManifest({ requestId: stableUuid(`science-claim-ledger-append:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId, ledgerId: exactText(body.ledger_id, 80, "science-claim-ledger-id-invalid"),
      expectedRevision: positiveInteger(body.expected_revision, "science-claim-ledger-revision-invalid"),
      expectedManifestSha256: exactSha256(body.expected_manifest_sha256, "science-claim-ledger-manifest-invalid"),
      manifest: body.manifest as ScienceClaimLedgerManifest });
    return { ok: true, schema: "agentlas.science.claim-ledger-mutation/v1", ...result };
  }
  if (route === "/v1/platform/claim-ledgers/evaluate") {
    const manuscriptId = exactText(body.manuscript_id, 80, "science-manuscript-id-invalid");
    return { ok: true, schema: "agentlas.science.claim-ledger-gate-read/v1", ledger: store.evaluateClaimLedgerForManuscript(grant.context.projectId, manuscriptId) };
  }
  if (route === "/v1/platform/manuscripts/create") {
    const result = store.createManuscript({
      requestId: stableUuid(`science-manuscript-create:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      title: body.title as string,
      markdown: body.markdown as string,
      bindings: body.bindings as ScienceManuscriptBindingInput[],
    });
    return { ok: true, schema: "agentlas.science-manuscript-write-result/v1", manuscript: manuscriptRecord(result.manuscript, true), replayed: result.replayed };
  }
  if (route === "/v1/platform/manuscripts/append-version") {
    const result = store.appendManuscriptVersion({
      requestId: stableUuid(`science-manuscript-append:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      manuscriptId: exactText(body.manuscript_id, 80, "science-manuscript-id-invalid"),
      expectedVersion: positiveInteger(body.expected_version, "science-manuscript-version-invalid"),
      expectedContentSha256: exactSha256(body.expected_content_sha256, "science-manuscript-content-invalid"),
      markdown: body.markdown as string,
      bindings: body.bindings as ScienceManuscriptBindingInput[],
    });
    return { ok: true, schema: "agentlas.science-manuscript-write-result/v1", manuscript: manuscriptRecord(result.manuscript, true), replayed: result.replayed };
  }
  if (route === "/v1/platform/statistics/capabilities") {
    const pluginRoot = path.resolve(__dirname, "../../../plugins/agentlas-science-statistics");
    const coverageRuntime = requireFromToolControl(path.join(pluginRoot, "runtime/coverage.cjs")) as {
      loadCoverageManifest(root: string): Record<string, unknown>;
    };
    const figureRuntime = requireFromToolControl(path.join(pluginRoot, "runtime/figure-catalog.cjs")) as {
      loadFigureCatalog(root: string): { schema: string; catalogVersion: string; templates: Array<Record<string, unknown>> };
      summarizeFigureCatalog(catalog: unknown): Record<string, unknown>;
    };
    const coverage = coverageRuntime.loadCoverageManifest(pluginRoot);
    const figureCatalog = figureRuntime.loadFigureCatalog(pluginRoot);
    const threeDimensionalTemplates = figureCatalog.templates.filter((template) => template.family === "3d-numeric");
    const catalogHasThreeDimensional = threeDimensionalTemplates.some((template) => {
      const renderer = template.renderer && typeof template.renderer === "object" && !Array.isArray(template.renderer)
        ? template.renderer as Record<string, unknown>
        : null;
      const capabilities = Array.isArray(renderer?.capabilities)
        ? renderer.capabilities.filter((item): item is string => typeof item === "string")
        : [];
      return renderer?.id === "agentlas.three-numeric"
        && ["surface-3d", "observed-points", "support-mask", "orbit-controls", "persisted-view-state"]
          .every((capability) => capabilities.includes(capability));
    });
    const trueThreeDimensional = catalogHasThreeDimensional
      && typeof store.materializeStatisticsNumericSurface === "function";
    return {
      ok: true,
      schema: "agentlas.science-statistics-capabilities/v1",
      coverage,
      figures: {
        summary: figureRuntime.summarizeFigureCatalog(figureCatalog),
        templates: figureCatalog.templates,
        trueThreeDimensional,
        threeDimensionalPolicy: trueThreeDimensional
          ? "interactive-3d"
          : "orthogonal-projection-and-contour-only",
      },
      exports: {
        svg: "implemented-run-backed-journal-vector-with-exact-utf8-cas-bytes",
        png: "implemented-journal-raster-300-or-600dpi-srgb-white-background-content-hashed",
        pdf: "implemented-raster-pdf-300-or-600dpi-srgb-white-background-content-hashed",
        tiff: "implemented-raster-tiff-300-or-600dpi-srgb-white-background-content-hashed",
        cmyk: "unsupported-fail-closed",
      },
    };
  }
  if (route === "/v1/platform/statistics/figures/list") {
    const parentId = body.statistics_artifact_id === undefined
      ? undefined
      : exactText(body.statistics_artifact_id, 80, "science-statistics-figure-parent-invalid");
    const figures = store.listStatisticsFigures(grant.context.projectId, parentId).map((artifact) => {
      const payload = artifact.version.payload as Record<string, unknown>;
      const numericSurface = payload.schema === "agentlas.science.numeric-surface-artifact/v2";
      return {
        id: artifact.id,
        version: artifact.version.version,
        currentVersion: artifact.currentVersion,
        title: artifact.title,
        contentSha256: artifact.version.contentSha256,
        rendererId: artifact.version.rendererId,
        rendererVersion: artifact.version.rendererVersion,
        statisticsArtifact: numericSurface ? undefined : payload.statisticsArtifact,
        method: numericSurface ? "response_surface_regression" : payload.method,
        visualization: numericSurface ? undefined : payload.visualization,
        figureSpec: numericSurface ? undefined : payload.figureSpec,
        numericSurface: numericSurface ? {
          schema: payload.schema,
          grid: payload.grid,
          observations: payload.observations,
          support: payload.support,
          axes: payload.axes,
          appearance: payload.appearance,
          viewState: payload.viewState,
          analysis: payload.analysis,
        } : undefined,
        updatedAt: artifact.updatedAt,
      };
    });
    return { ok: true, schema: "agentlas.science-statistics-figure-list/v1", figures };
  }
  if (route === "/v1/platform/statistics/figures/materialize") {
    const result = store.materializeStatisticsFigure({
      requestId: stableUuid(`science-statistics-figure-materialize:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      statisticsArtifactId: exactText(body.statistics_artifact_id, 80, "science-statistics-figure-parent-invalid"),
      statisticsArtifactVersion: positiveInteger(body.statistics_artifact_version, "science-statistics-figure-parent-version-invalid"),
      statisticsArtifactContentSha256: exactSha256(body.statistics_artifact_content_sha256, "science-statistics-figure-parent-content-invalid"),
      visualizationIndex: nonNegativeInteger(body.visualization_index, "science-statistics-figure-index-invalid"),
      ...(body.title === undefined ? {} : { title: exactText(body.title, 240, "science-statistics-figure-title-invalid") }),
    });
    return {
      ok: true,
      schema: "agentlas.science-statistics-figure-materialization/v1",
      artifact: {
        id: result.artifact.id,
        version: result.artifact.version.version,
        currentVersion: result.artifact.currentVersion,
        kind: result.artifact.kind,
        title: result.artifact.title,
        contentSha256: result.artifact.version.contentSha256,
        rendererId: result.artifact.version.rendererId,
        rendererVersion: result.artifact.version.rendererVersion,
        labId: "data-visualization",
      },
      parent: result.parent,
      visualization: result.payload.visualization,
      figureSpec: result.payload.figureSpec,
      replayed: result.replayed,
    };
  }
  if (route === "/v1/platform/statistics/numeric-surfaces/materialize") {
    const result = store.materializeStatisticsNumericSurface({
      requestId: stableUuid(`science-statistics-numeric-surface-materialize:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      statisticsArtifactId: exactText(body.statistics_artifact_id, 80, "science-statistics-numeric-surface-parent-invalid"),
      statisticsArtifactVersion: positiveInteger(body.statistics_artifact_version, "science-statistics-numeric-surface-parent-version-invalid"),
      statisticsArtifactContentSha256: exactSha256(body.statistics_artifact_content_sha256, "science-statistics-numeric-surface-parent-content-invalid"),
      sourceArtifactIndex: nonNegativeInteger(body.source_artifact_index, "science-statistics-numeric-surface-source-index-invalid"),
    });
    return {
      ok: true,
      schema: "agentlas.science-statistics-numeric-surface-materialization/v1",
      artifact: {
        id: result.artifact.id,
        version: result.artifact.version.version,
        currentVersion: result.artifact.currentVersion,
        kind: result.artifact.kind,
        title: result.artifact.title,
        contentSha256: result.artifact.version.contentSha256,
        rendererId: result.artifact.version.rendererId,
        rendererVersion: result.artifact.version.rendererVersion,
        labId: "data-visualization",
      },
      parent: result.parent,
      source: result.source,
      payload: result.payload,
      replayed: result.replayed,
    };
  }
  if (route === "/v1/platform/statistics/figures/export-svg") {
    const artifactId = exactText(body.artifact_id, 80, "science-statistics-figure-not-found");
    const artifactVersion = positiveInteger(body.artifact_version, "science-statistics-figure-version-invalid");
    const contentSha256 = exactSha256(body.artifact_content_sha256, "science-statistics-figure-content-invalid");
    const artifact = store.getArtifactForProject(grant.context.projectId, artifactId);
    if (!artifact || artifact.kind !== "chart.vega" || artifact.version.rendererId !== "agentlas.vega") {
      throw new Error("science-statistics-figure-not-found");
    }
    if (artifact.currentVersion !== artifactVersion || artifact.version.contentSha256 !== contentSha256) {
      throw new Error("science-artifact-version-conflict");
    }
    const rendered = await renderScienceStatisticsFigureSvg(artifact.version.payload);
    if (rendered.byteSize > MAX_AI_VISUAL_BYTES) throw new Error("science-statistics-figure-svg-too-large-for-ai");
    const preview = await renderScienceStatisticsFigureSvgPreviewPng(rendered);
    const persisted = store.persistStatisticsFigureSvg({
      requestId: stableUuid(`science-statistics-figure-svg-persist:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      artifactId,
      artifactVersion,
      contentSha256,
      rendered,
      svg: Buffer.from(rendered.svg, "utf8"),
      preview,
      previewPng: Buffer.from(preview.dataBase64, "base64"),
    });
    return {
      ok: true,
      artifact: { id: artifactId, version: artifactVersion, contentSha256 },
      exportArtifact: {
        id: persisted.artifact.id,
        version: persisted.artifact.currentVersion,
        kind: persisted.artifact.kind,
        contentSha256: persisted.artifact.version.contentSha256,
        captureId: persisted.visualCapture.id,
        captureSha256: persisted.visualCapture.sha256,
        exportSha256: persisted.payload.export.sha256,
        exportReceiptSha256: persisted.payload.exportSha256,
      },
      replayed: persisted.replayed,
      ...rendered,
    };
  }
  if (route === "/v1/platform/statistics/figures/export-png") {
    const artifactId = exactText(body.artifact_id, 80, "science-statistics-figure-not-found");
    const artifactVersion = positiveInteger(body.artifact_version, "science-statistics-figure-version-invalid");
    const contentSha256 = exactSha256(body.artifact_content_sha256, "science-statistics-figure-content-invalid");
    const dpi = positiveInteger(body.dpi, "science-statistics-figure-png-dpi-invalid");
    if (dpi !== 300 && dpi !== 600) throw new Error("science-statistics-figure-png-dpi-invalid");
    const widthMm = body.width_mm === undefined ? undefined : Number(body.width_mm);
    if (widthMm !== undefined && (!Number.isFinite(widthMm) || widthMm < 20 || widthMm > 200)) {
      throw new Error("science-statistics-figure-png-width-mm-invalid");
    }
    const artifact = store.getArtifactForProject(grant.context.projectId, artifactId);
    if (!artifact || artifact.kind !== "chart.vega" || artifact.version.rendererId !== "agentlas.vega") {
      throw new Error("science-statistics-figure-not-found");
    }
    if (artifact.currentVersion !== artifactVersion || artifact.version.contentSha256 !== contentSha256) {
      throw new Error("science-artifact-version-conflict");
    }
    const rendered = await renderScienceStatisticsFigurePng(artifact.version.payload, {
      dpi,
      ...(widthMm === undefined ? {} : { widthMm }),
    });
    if (rendered.byteSize > MAX_AI_VISUAL_BYTES) throw new Error("science-statistics-figure-png-too-large-for-ai");
    const persisted = store.persistStatisticsFigurePng({
      requestId: stableUuid(`science-statistics-figure-png-persist:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      artifactId,
      artifactVersion,
      contentSha256,
      rendered,
      png: Buffer.from(rendered.dataBase64, "base64"),
    });
    return {
      ok: true,
      schema: rendered.schema,
      artifact: { id: artifactId, version: artifactVersion, contentSha256 },
      exportArtifact: {
        id: persisted.artifact.id,
        version: persisted.artifact.currentVersion,
        kind: persisted.artifact.kind,
        contentSha256: persisted.artifact.version.contentSha256,
        captureId: persisted.visualCapture.id,
        captureSha256: persisted.visualCapture.sha256,
        exportSha256: persisted.payload.export.sha256,
        exportReceiptSha256: persisted.payload.exportSha256,
      },
      replayed: persisted.replayed,
      exportProfile: rendered.exportProfile,
      renderer: rendered.renderer,
      sourceSpecSha256: rendered.sourceSpecSha256,
      sourceSvgSha256: rendered.sourceSvgSha256,
      visual: {
        mimeType: rendered.mimeType,
        width: rendered.width,
        height: rendered.height,
        widthMm: rendered.widthMm,
        heightMm: rendered.heightMm,
        dpi: rendered.dpi,
        colorSpace: rendered.colorSpace,
        background: rendered.background,
        byteSize: rendered.byteSize,
        sha256: rendered.sha256,
        dataBase64: rendered.dataBase64,
      },
    };
  }
  const artifactId = typeof body.artifact_id === "string" ? body.artifact_id : "";
  if (route === "/v1/platform/artifacts/inspect") {
    const requestedVersion = body.artifact_version === undefined ? undefined : positiveInteger(body.artifact_version, "science-artifact-version-invalid");
    const context = store.getArtifactContextForProject(grant.context.projectId, artifactId, requestedVersion);
    if (!context) throw new Error("science-artifact-not-found");
    const history = store.getArtifactVersionHistoryForProject(grant.context.projectId, artifactId);
    if (!history) throw new Error("science-artifact-history-not-found");
    const observation = context.isCurrent ? store.artifactObservationBundleForProject(grant.context.projectId, artifactId) : null;
    return {
      ok: true,
      schema: "agentlas.science-artifact-inspection/v1",
      artifact: {
        id: context.artifact.id,
        kind: context.artifact.kind,
        title: context.artifact.title,
        currentVersion: context.artifact.currentVersion,
        selectedVersion: context.selectedVersion.version,
        isCurrent: context.isCurrent,
        rendererId: context.selectedVersion.rendererId,
        rendererVersion: context.selectedVersion.rendererVersion,
        contentSha256: context.selectedVersion.contentSha256,
        semantic: context.selectedVersion.semantic,
        provenance: context.selectedVersion.provenance,
        linkage: context.linkage,
      },
      visualObservation: observation ? {
        visualReviewEligible: observation.visualReviewEligible,
        visualCapture: observation.visualCapture,
      } : null,
      history,
    };
  }
  if (route === "/v1/platform/artifacts/inspect-visual") {
    const artifactVersion = positiveInteger(body.artifact_version, "science-artifact-version-invalid");
    const context = store.getArtifactContextForProject(grant.context.projectId, artifactId, artifactVersion);
    if (!context) throw new Error("science-artifact-not-found");
    if (!context.isCurrent) throw new Error("science-artifact-visual-version-not-current");
    const observation = store.artifactObservationBundleForProject(grant.context.projectId, artifactId);
    const capture = observation.visualCapture;
    if (!capture || capture.artifactVersion !== artifactVersion || capture.contentSha256 !== context.selectedVersion.contentSha256) {
      throw new Error("science-artifact-visual-capture-missing");
    }
    const preview = store.artifactVisualPreviewForProject(grant.context.projectId, artifactId, artifactVersion);
    if (!preview || preview.sha256 !== capture.sha256 || preview.contentSha256 !== capture.contentSha256) {
      throw new Error("science-artifact-visual-capture-invalid");
    }
    if (preview.byteSize > MAX_AI_VISUAL_BYTES) throw new Error("science-artifact-visual-too-large-for-ai");
    return {
      ok: true,
      schema: "agentlas.science-artifact-visual-inspection/v1",
      artifact: {
        id: context.artifact.id,
        kind: context.artifact.kind,
        title: context.artifact.title,
        version: artifactVersion,
        rendererId: context.selectedVersion.rendererId,
        rendererVersion: context.selectedVersion.rendererVersion,
        contentSha256: context.selectedVersion.contentSha256,
      },
      visual: {
        captureId: capture.id,
        mimeType: preview.mimeType,
        width: preview.width,
        height: preview.height,
        byteSize: preview.byteSize,
        sha256: preview.sha256,
        renderContext: capture.renderContext,
        renderContextSha256: capture.renderContextSha256,
        capturedAt: capture.capturedAt,
        dataBase64: Buffer.from(preview.bytes).toString("base64"),
      },
    };
  }
  if (route === "/v1/platform/artifacts/compare") {
    const fromVersion = positiveInteger(body.from_version, "science-artifact-diff-input-invalid");
    const toVersion = positiveInteger(body.to_version, "science-artifact-diff-input-invalid");
    const diff = store.getArtifactVersionDiffForProject(grant.context.projectId, artifactId, fromVersion, toVersion);
    if (!diff) throw new Error("science-artifact-diff-version-not-found");
    return { ok: true, diff };
  }
  throw new Error("science-tool-control-not-found");
}

async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  if (request.method !== "POST") {
    respond(response, 404, { ok: false, code: "science-tool-control-not-found" });
    return;
  }
  const grant = authorize(request.headers.authorization);
  if (!grant) {
    respond(response, 401, { ok: false, code: "science-tool-control-unauthorized" });
    return;
  }
  const route = String(request.url ?? "");
  const platformTool = PLATFORM_TOOLS.find((tool) => tool.route === route);
  const descriptorTool = grant.catalog.tools.find((tool) => tool.mcp.route === route);
  if (!platformTool && !descriptorTool) {
    respond(response, 404, { ok: false, code: "science-tool-control-not-found" });
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) {
      respond(response, 413, { ok: false, code: "science-tool-control-request-too-large" });
      request.destroy();
      return;
    }
    chunks.push(bytes);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    const toolCallId = typeof body.tool_call_id === "string" ? body.tool_call_id.trim() : "";
    if (!toolCallId || toolCallId.length > 160) throw new Error("science-tool-call-id-invalid");
    if (route === "/v1/platform/astronomy/catalog-search") {
      exactToolBody(body, ["tool_call_id", "center_ra_deg", "center_dec_deg", "radius_deg", "limit", "title"], "science-astronomy-catalog-input-invalid");
    }
    const result = route === "/v1/platform/sources/retrieve-full-text"
      ? { ok: true, ...await scienceAcademicFullTextService().retrieve({
          requestId: stableUuid(`science-academic-full-text:v1:${grant.context.invocationRunId}:${toolCallId}`),
          projectId: grant.context.projectId,
          conversationId: grant.context.conversationId,
          originMessageId: grant.context.originUserMessageId,
          sourceId: exactText(body.source_id, 80, "science-source-id-invalid"),
          expectedSourceVersionId: exactText(body.expected_source_version_id, 80, "science-source-version-id-invalid"),
        }) }
      : route === "/v1/platform/academic-search"
        ? { ok: true, ...await scienceAcademicSearchService().search({
          requestId: stableUuid(`science-academic-search:v1:${grant.context.invocationRunId}:${toolCallId}`),
          projectId: grant.context.projectId,
          conversationId: grant.context.conversationId,
          originMessageId: grant.context.originUserMessageId,
          query: exactText(body.query, 1_000, "science-academic-search-query-invalid"),
          ...(body.domain === undefined ? {} : { domain: exactText(body.domain, 160, "science-academic-search-domain-invalid") }),
          ...(body.from_year === undefined ? {} : { fromYear: positiveInteger(body.from_year, "science-academic-search-from-year-invalid") }),
          ...(body.to_year === undefined ? {} : { toYear: positiveInteger(body.to_year, "science-academic-search-to-year-invalid") }),
          ...(body.sort === undefined ? {} : { sort: body.sort as "relevance" | "newest" | "cited" }),
          ...(body.limit === undefined ? {} : { limit: positiveInteger(body.limit, "science-academic-search-limit-invalid") }),
          ...(body.include_preprints === undefined ? {} : { includePreprints: body.include_preprints === true }),
          ...(body.providers === undefined || body.providers === "auto"
            ? { providers: "auto" as const }
            : { providers: body.providers as AcademicSearchProvider[] }),
          }) }
        : route === "/v1/platform/physics/inspire-search"
        ? { ok: true, ...await sciencePhysicsInspireLiveService().search({
            requestId: stableUuid(`science-physics-inspire:v1:${grant.context.invocationRunId}:${toolCallId}`),
            projectId: grant.context.projectId,
            conversationId: grant.context.conversationId,
            originMessageId: grant.context.originUserMessageId,
            query: exactText(body.query, 500, "science-physics-inspire-query-invalid"),
            ...(body.limit === undefined ? {} : { limit: positiveInteger(body.limit, "science-physics-inspire-limit-invalid") }),
            ...(body.page === undefined ? {} : { page: positiveInteger(body.page, "science-physics-inspire-page-invalid") }),
            ...(body.sort === undefined ? {} : { sort: exactText(body.sort, 24, "science-physics-inspire-sort-invalid") as "relevance" | "mostrecent" | "mostcited" }),
            ...(body.title === undefined ? {} : { title: exactText(body.title, 240, "science-physics-inspire-title-invalid") }),
          }) }
      : route === "/v1/platform/physics/hepdata-table"
        ? { ok: true, ...await sciencePhysicsHepDataLiveService().fetchTable({
            requestId: stableUuid(`science-physics-hepdata:v1:${grant.context.invocationRunId}:${toolCallId}`),
            projectId: grant.context.projectId,
            conversationId: grant.context.conversationId,
            originMessageId: grant.context.originUserMessageId,
            recordId: exactText(body.record_id, 24, "science-physics-hepdata-record-invalid"),
            tableName: exactText(body.table_name, 500, "science-physics-hepdata-table-invalid"),
            ...(body.version === undefined ? {} : { version: positiveInteger(body.version, "science-physics-hepdata-version-invalid") }),
            ...(body.title === undefined ? {} : { title: exactText(body.title, 240, "science-physics-hepdata-title-invalid") }),
          }) }
      : route === "/v1/platform/astronomy/catalog-search"
        ? { ok: true, ...await scienceAstronomyCatalogService().search({
            requestId: stableUuid(`science-astronomy-catalog:v1:${grant.context.invocationRunId}:${toolCallId}`),
            projectId: grant.context.projectId,
            conversationId: grant.context.conversationId,
            originMessageId: grant.context.originUserMessageId,
            centerRaDeg: finiteNumber(body.center_ra_deg, 0, 360, "science-astronomy-catalog-ra-invalid", true),
            centerDecDeg: finiteNumber(body.center_dec_deg, -90, 90, "science-astronomy-catalog-dec-invalid"),
            radiusDeg: finiteNumber(body.radius_deg, 0.001, 10, "science-astronomy-catalog-radius-invalid"),
            ...(body.limit === undefined ? {} : { limit: boundedInteger(body.limit, 1, 500, "science-astronomy-catalog-limit-invalid") }),
            ...(body.title === undefined ? {} : { title: exactText(body.title, 240, "science-astronomy-catalog-title-invalid") }),
          }) }
      : route === "/v1/platform/biodiversity/occurrence-search"
        ? { ok: true, ...await scienceBiodiversityCatalogService().search({
            requestId: stableUuid(`science-biodiversity-catalog:v1:${grant.context.invocationRunId}:${toolCallId}`),
            projectId: grant.context.projectId,
            conversationId: grant.context.conversationId,
            originMessageId: grant.context.originUserMessageId,
            scientificName: exactText(body.scientific_name, 500, "science-biodiversity-name-invalid"),
            ...(body.country_code === undefined ? {} : { countryCode: exactText(body.country_code, 2, "science-biodiversity-country-invalid") }),
            ...(body.from_year === undefined ? {} : { fromYear: positiveInteger(body.from_year, "science-biodiversity-from-year-invalid") }),
            ...(body.to_year === undefined ? {} : { toYear: positiveInteger(body.to_year, "science-biodiversity-to-year-invalid") }),
            ...(body.limit === undefined ? {} : { limit: positiveInteger(body.limit, "science-biodiversity-limit-invalid") }),
            ...(body.title === undefined ? {} : { title: exactText(body.title, 240, "science-biodiversity-title-invalid") }),
          }) }
      : route === "/v1/platform/earth-science/earthquake-search"
        ? { ok: true, ...await scienceEarthquakeCatalogService().search({
            requestId: stableUuid(`science-earthquake-catalog:v1:${grant.context.invocationRunId}:${toolCallId}`),
            projectId: grant.context.projectId, conversationId: grant.context.conversationId, originMessageId: grant.context.originUserMessageId,
            startTime: exactText(body.start_time, 80, "science-earthquake-start-time-invalid"),
            endTime: exactText(body.end_time, 80, "science-earthquake-end-time-invalid"),
            ...(body.min_magnitude === undefined ? {} : { minMagnitude: finiteNumber(body.min_magnitude, -2, 10, "science-earthquake-magnitude-invalid") }),
            ...(body.max_magnitude === undefined ? {} : { maxMagnitude: finiteNumber(body.max_magnitude, -2, 10, "science-earthquake-magnitude-invalid") }),
            ...(body.min_depth_km === undefined ? {} : { minDepthKm: finiteNumber(body.min_depth_km, -100, 1000, "science-earthquake-depth-invalid") }),
            ...(body.max_depth_km === undefined ? {} : { maxDepthKm: finiteNumber(body.max_depth_km, -100, 1000, "science-earthquake-depth-invalid") }),
            ...(body.bounds === undefined ? {} : (() => {
              if (!body.bounds || typeof body.bounds !== "object" || Array.isArray(body.bounds)) throw new Error("science-earthquake-bounds-invalid");
              const bounds = body.bounds as Record<string, unknown>;
              return { bounds: {
                minLongitude: finiteNumber(bounds.min_longitude, -180, 180, "science-earthquake-bounds-invalid"),
                minLatitude: finiteNumber(bounds.min_latitude, -90, 90, "science-earthquake-bounds-invalid"),
                maxLongitude: finiteNumber(bounds.max_longitude, -180, 180, "science-earthquake-bounds-invalid"),
                maxLatitude: finiteNumber(bounds.max_latitude, -90, 90, "science-earthquake-bounds-invalid"),
              } };
            })()),
            ...(body.limit === undefined ? {} : { limit: positiveInteger(body.limit, "science-earthquake-limit-invalid") }),
            ...(body.offset === undefined ? {} : { offset: boundedInteger(body.offset, 1, 1_000_000, "science-earthquake-offset-invalid") }),
            ...(body.order_by === undefined ? {} : { orderBy: exactText(body.order_by, 24, "science-earthquake-order-invalid") as "time" | "time-asc" | "magnitude" | "magnitude-asc" }),
            ...(body.title === undefined ? {} : { title: exactText(body.title, 240, "science-earthquake-title-invalid") }),
          }) }
      : route === "/v1/platform/earth-science/earthquake-event-detail"
        ? { ok: true, ...await scienceEarthquakeCatalogService().getEventDetail({
            requestId: stableUuid(`science-earthquake-event-detail:v1:${grant.context.invocationRunId}:${toolCallId}`),
            projectId: grant.context.projectId, conversationId: grant.context.conversationId, originMessageId: grant.context.originUserMessageId,
            eventId: exactPatternText(body.event_id, 120, /^[A-Za-z0-9._-]+$/, "science-earthquake-event-id-invalid"),
            ...(body.title === undefined ? {} : { title: exactText(body.title, 240, "science-earthquake-title-invalid") }),
          }) }
      : route === "/v1/platform/economics/world-bank-indicator"
        ? { ok: true, ...await scienceEconomicsCatalogService().fetchSeries({
            requestId: stableUuid(`science-economics-world-bank:v1:${grant.context.invocationRunId}:${toolCallId}`),
            projectId: grant.context.projectId,
            conversationId: grant.context.conversationId,
            originMessageId: grant.context.originUserMessageId,
            country: exactPatternText(body.country, 3, /^[A-Za-z]{2,3}$/, "science-economics-country-invalid"),
            indicator: exactPatternText(body.indicator, 64, /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+){1,7}$/, "science-economics-indicator-invalid"),
            ...scienceEconomicsYears(body.start_year, body.end_year),
            ...(body.title === undefined ? {} : { title: exactText(body.title, 240, "science-economics-title-invalid") }),
          }) }
      : route === "/v1/platform/materials/structure-search"
        ? { ok: true, ...await scienceMaterialsCatalogService().search({
            requestId: stableUuid(`science-materials-structure-search:v1:${grant.context.invocationRunId}:${toolCallId}`),
            projectId: grant.context.projectId, conversationId: grant.context.conversationId, originMessageId: grant.context.originUserMessageId,
            elements: Array.isArray(body.elements) ? body.elements.map((value) => exactText(value, 3, "science-materials-element-invalid")) : (() => { throw new Error("science-materials-elements-invalid"); })(),
            ...(body.limit === undefined ? {} : { limit: positiveInteger(body.limit, "science-materials-limit-invalid") }),
            ...(body.offset === undefined ? {} : { offset: nonNegativeInteger(body.offset, "science-materials-offset-invalid") }),
            ...(body.title === undefined ? {} : { title: exactText(body.title, 240, "science-materials-title-invalid") }),
          }) }
      : route === "/v1/platform/genomics/variant-track"
        ? genomicsResultRecord(await scienceGenomicsCatalogService().search({
            requestId: stableUuid(`science-genomics-variant-track:v1:${grant.context.invocationRunId}:${toolCallId}`),
            projectId: grant.context.projectId,
            conversationId: grant.context.conversationId,
            originMessageId: grant.context.originUserMessageId,
            species: exactText(body.species, 80, "science-genomics-species-invalid"),
            assembly: exactText(body.assembly, 120, "science-genomics-assembly-invalid"),
            refName: exactText(body.ref_name, 120, "science-genomics-reference-invalid"),
            start: positiveInteger(body.start, "science-genomics-start-invalid"),
            end: positiveInteger(body.end, "science-genomics-end-invalid"),
            ...(body.title === undefined ? {} : { title: exactText(body.title, 240, "science-genomics-title-invalid") }),
          }))
      : route === "/v1/platform/scientific-data/retrieve"
        ? { ok: true, ...await scienceScientificDataService().retrieve({
            requestId: stableUuid(`science-scientific-data:v1:${grant.context.invocationRunId}:${toolCallId}`),
            projectId: grant.context.projectId,
            conversationId: grant.context.conversationId,
            originMessageId: grant.context.originUserMessageId,
            query: body.provider === "rcsb-pdb"
              ? { provider: "rcsb-pdb", entryId: exactText(body.entry_id, 12, "science-data-rcsb-id-invalid") }
              : body.provider === "pubchem"
                ? {
                    provider: "pubchem", namespace: body.namespace as "cid" | "name" | "inchikey",
                    value: exactText(body.value, 240, "science-data-pubchem-value-invalid"),
                  }
                : (() => { throw new Error("science-data-provider-invalid"); })(),
          }) }
      : route === "/v1/platform/journals/inspect-official-guidelines"
        ? { ok: true, schema: "agentlas.science-journal-guideline-inspection/v1", inspection: await scienceJournalPublicationService().inspectOfficialGuidelines({
            projectId: grant.context.projectId,
            sourceUrl: exactText(body.source_url, 4_000, "science-journal-guideline-url-invalid"),
          }) }
      : descriptorTool
        ? await dispatchDescriptorTool(descriptorTool, body, grant, toolCallId)
        : await platformResult(route, body, grant, toolCallId);
    respond(response, 200, result);
  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 240) : "science-tool-control-failed";
    respond(response, 400, { ok: false, code });
  }
}

async function ensureServer(): Promise<string> {
  if (server && endpoint) return endpoint;
  server = http.createServer((request, response) => void handle(request, response));
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("science-tool-control-address-invalid");
  endpoint = `http://127.0.0.1:${address.port}`;
  return endpoint;
}

const SCIENCE_MCP_SOURCE = String.raw`"use strict";
const MAX=8*1024*1024;
const endpoint=process.env.AGENTLAS_SCIENCE_MCP_ENDPOINT;
const token=process.env.AGENTLAS_SCIENCE_MCP_TOKEN;
const encoded=process.env.AGENTLAS_SCIENCE_MCP_CATALOG;
if(!endpoint||!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)||!token||!encoded)process.exit(78);
let catalog;try{catalog=JSON.parse(Buffer.from(encoded,"base64url").toString("utf8"))}catch{process.exit(78)}
if(!catalog||catalog.schema!=="agentlas.science-mcp-catalog/v1"||!Array.isArray(catalog.tools)||catalog.tools.length<1||catalog.tools.length>300)process.exit(78);
const tools=[];const byName=new Map();
for(const item of catalog.tools){if(!item||typeof item.name!=="string"||!/^[a-z][a-z0-9_]{0,79}$/.test(item.name)||typeof item.route!=="string"||!/^\/v1\/[a-z0-9/._-]+$/.test(item.route)||typeof item.description!=="string"||!item.inputSchema||typeof item.inputSchema!=="object"||byName.has(item.name))process.exit(78);const tool={name:item.name,description:item.description,inputSchema:item.inputSchema};tools.push(tool);byName.set(item.name,item.route)}
const result=(value,error=false)=>{const visual=value&&(value.schema==="agentlas.science-artifact-visual-inspection/v1"||value.schema==="agentlas.science.statistics-figure-png-export/v1")&&value.visual&&value.visual.mimeType==="image/png"&&typeof value.visual.dataBase64==="string"&&/^[A-Za-z0-9+/]+={0,2}$/.test(value.visual.dataBase64)?value.visual:null;const textValue=visual?JSON.parse(JSON.stringify(value)):value;if(visual)delete textValue.visual.dataBase64;return{content:[{type:"text",text:JSON.stringify(textValue)},...(visual?[{type:"image",data:visual.dataBase64,mimeType:"image/png"}]:[])],...(error?{isError:true}:{})}};
async function handle(req){if(req.method==="initialize")return{protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"agentlas-science",version:"2.1.0"}};if(req.method==="notifications/initialized")return;if(req.method==="ping")return{};if(req.method==="tools/list")return{tools};if(req.method!=="tools/call")throw Object.assign(new Error("Method not found"),{code:-32601});const route=req.params&&byName.get(req.params.name);if(!route)return result({ok:false,code:"science-tool-unknown"},true);const response=await fetch(endpoint+route,{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify(req.params.arguments||{})});const text=await response.text();let value;try{value=JSON.parse(text)}catch{value={ok:false,code:"science-tool-invalid-response"}}return result(value,!response.ok||value.ok!==true)}
function emit(req,payload){if(req.id===undefined||payload===undefined)return;process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:req.id,result:payload})+"\n")}
let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>{input+=chunk;let i;while((i=input.indexOf("\n"))>=0){const line=input.slice(0,i).replace(/\r$/,"");input=input.slice(i+1);if(!line)continue;let req;try{req=JSON.parse(line);Promise.resolve(handle(req)).then(value=>emit(req,value)).catch(error=>{if(req.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:req.id,error:{code:Number(error&&error.code)||-32603,message:"Agentlas Science tool failed."}})+"\n")})}catch{} }if(Buffer.byteLength(input,"utf8")>MAX)process.exit(78)});`;

function writePrivate(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.renameSync(temp, target);
  if (process.platform !== "win32") fs.chmodSync(target, 0o600);
}

function toml(value: string): string { return JSON.stringify(value); }
function tomlArray(values: string[]): string { return `[${values.map(toml).join(",")}]`; }

function validatedCatalog(value: unknown): ScienceLabCapabilityCatalog {
  const descriptor = parseScienceServiceDescriptor(value);
  if (descriptor.tools.some((tool) => !IMPLEMENTED_TOOL_IDS.has(tool.id))) throw new Error("science-service-tool-adapter-unavailable");
  return scienceLabCapabilityCatalog(descriptor);
}

async function assertScienceServiceAuthority(testDescriptor?: unknown): Promise<ScienceLabCapabilityCatalog> {
  if (testDescriptor !== undefined) {
    if (process.env.AGENTLAS_SCIENCE_MCP_CONTRACT !== "1") throw new Error("science-service-test-authority-denied");
    return validatedCatalog(testDescriptor);
  }
  const { activeScienceExtension } = await import("../extensions/science");
  const release = activeScienceExtension();
  if (!release || !release.manifest.permissions.includes("science:compute") || !release.manifest.serviceEntry) {
    throw new Error("science-service-not-authorized");
  }
  const servicePath = path.join(release.releaseDir, release.manifest.serviceEntry);
  const stat = fs.lstatSync(servicePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 2 || stat.size > 256 * 1024) throw new Error("science-service-entry-invalid");
  return validatedCatalog(JSON.parse(fs.readFileSync(servicePath, "utf8")));
}

export async function activeScienceLabCapabilityCatalog(): Promise<ScienceLabCapabilityCatalog> {
  return assertScienceServiceAuthority();
}

export async function materializeScienceMcpGrant(context: ScienceContext, baseConfigPath?: string, testDescriptor?: unknown): Promise<{
  configPath: string;
  allowedTools: string[];
  codexConfigArgs: string[];
  runtimeEnv: Record<string, string>;
  includedServer: { serverId: string; catalogId: string; configKey: string };
}> {
  const catalog = await assertScienceServiceAuthority(testDescriptor);
  const controlEndpoint = await ensureServer();
  const token = randomBytes(32).toString("base64url");
  grants.set(context.invocationRunId, { tokenHash: tokenHash(token), context: { ...context }, catalog, expiresAt: Date.now() + 60 * 60_000 });
  let base: { mcpServers?: Record<string, unknown> } = {};
  if (baseConfigPath) {
    const stat = fs.lstatSync(baseConfigPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("science-mcp-base-config-invalid");
    base = JSON.parse(fs.readFileSync(baseConfigPath, "utf8")) as { mcpServers?: Record<string, unknown> };
  }
  const args = ["-e", SCIENCE_MCP_SOURCE];
  const configPath = userDataPath("mcp", `agentlas-science-${context.invocationRunId}.json`);
  writePrivate(configPath, {
    mcpServers: {
      ...(base.mcpServers ?? {}),
      [SERVER_KEY]: { command: process.execPath, args, env: { ELECTRON_RUN_AS_NODE: "1" } },
    },
  });
  const mcpCatalog = {
    schema: "agentlas.science-mcp-catalog/v1",
    tools: [
      ...PLATFORM_TOOLS,
      ...catalog.tools.map((tool) => ({
        name: tool.mcp.name,
        route: tool.mcp.route,
        description: tool.mcp.description,
        inputSchema: tool.mcp.inputSchema,
      })),
    ],
  };
  const encodedCatalog = Buffer.from(JSON.stringify(mcpCatalog), "utf8").toString("base64url");
  return {
    configPath,
    allowedTools: [`mcp__${SERVER_KEY}`, `mcp__${SERVER_KEY}__*`],
    codexConfigArgs: [
      "-c", `mcp_servers.${SERVER_KEY}.command=${toml(process.execPath)}`,
      "-c", `mcp_servers.${SERVER_KEY}.args=${tomlArray(args)}`,
      "-c", `mcp_servers.${SERVER_KEY}.env_vars=${tomlArray([TOKEN_ENV, ENDPOINT_ENV, CATALOG_ENV])}`,
    ],
    runtimeEnv: { [TOKEN_ENV]: token, [ENDPOINT_ENV]: controlEndpoint, [CATALOG_ENV]: encodedCatalog },
    includedServer: { serverId: SERVER_KEY, catalogId: SERVER_KEY, configKey: SERVER_KEY },
  };
}

export async function closeScienceToolControlServer(): Promise<void> {
  grants.clear();
  const current = server;
  server = null;
  endpoint = null;
  if (!current) return;
  await new Promise<void>((resolve) => current.close(() => resolve()));
}

export function revokeScienceMcpGrant(invocationRunId: string): boolean {
  return grants.delete(invocationRunId);
}
