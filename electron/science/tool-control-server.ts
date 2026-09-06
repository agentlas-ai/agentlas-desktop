import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { userDataPath } from "../runtime-paths";
import type { InvocationExecutionContext } from "../mcp/client";
import type { ProductExtensionManifest } from "../../shared/product-extension";
import {
  parseScienceServiceDescriptor,
  scienceLabCapabilityCatalog,
  type ScienceLabCapabilityCatalog,
  type ScienceLabToolDescriptor,
} from "../../shared/science-lab-capability";
import {
  SCIENCE_DESKTOP_HOST_API_NAME,
  SCIENCE_DESKTOP_HOST_API_VERSION,
  assertScienceExtensionHostCompatibility,
  scienceExtensionHostCompatibilitySha256,
  type ScienceDesktopHostCompatibilitySnapshot,
} from "../../shared/science-extension-host-compatibility";
import { parseScienceVegaEditInput, commitScienceVegaEdit } from "./vega-editor";
import {
  renderScienceStatisticsFigurePng,
  renderScienceStatisticsFigureSvg,
  renderScienceStatisticsFigureSvgPreviewPng,
} from "./statistics-figure-export";
import { isScienceResidueInteraction, type ScienceProteinColorTheme, type ScienceProteinRepresentation } from "../../shared/science-renderer-runtime";
import { commitScienceChemistrySmilesEdit, commitScienceMolstarViewEdit } from "./lab-editors";
import type { ExecuteStatisticsAnalysisInput } from "./tool-gateway";
import { scienceAcademicFullTextService, scienceAcademicSearchService, scienceAstronomyAnalysisService, scienceArtifactPublicationValidator, scienceAstronomyCatalogService, scienceBiodiversityCatalogService, scienceChemistryValidator, scienceComparativeGenomicsService, scienceComparativeGenomicsTableService, scienceDeextinctionFeasibilityService, scienceDomainAnalysisService, scienceEarthAnalysisService, scienceEarthquakeCatalogService, scienceEconomicsAnalysisService, scienceEconomicsCatalogService, scienceEvidenceGraphService, scienceExtantArchosaurLocusPanelService, scienceExtantReferenceAssemblyService, scienceGenomicsCatalogService, scienceHypotheticalAsrService, scienceJournalPublicationService, scienceManuscriptRenderService, scienceMaterialsCatalogService, scienceNoaaCoopsWaterLevelService, sciencePaleontologyAnalysisService, sciencePaleontologyCandidateComparisonService, sciencePaleontologyCatalogService, sciencePhysicsAnalysisService, sciencePhysicsHepDataLiveService, sciencePhysicsInspireLiveService, scienceScientificDataService, scienceStore, scienceToolGateway } from "./runtime";
import { earthAnalysisToolSummary, isEarthAnalysisToolId } from "./earth-analysis";
import { deextinctionFeasibilityToolSummary } from "./deextinction-feasibility";
import { paleontologyCandidateComparisonToolSummary } from "./paleontology-candidate-comparison";
import { physicsAnalysisKindForToolId } from "./physics-analysis";
import { ACADEMIC_SEARCH_PROVIDERS, type AcademicSearchProvider } from "./academic-search";
import type {
  ScienceAnalysisDecisionDraft,
  ScienceAnalysisSpecDocument,
  ScienceDecisionRequest,
  ScienceJournalRuleInput,
  ScienceJournalCoverageEntry,
  ScienceManuscript,
  ScienceManuscriptBindingInput,
  ScienceManuscriptEditProposalStatus,
  ScienceManuscriptOperation,
  ScienceManuscriptArticleFamily,
  ScienceManuscriptBlueprintBindingInput,
  ScienceManuscriptBlueprintComparableInput,
  ScienceManuscriptBlueprintJournalBindingInput,
  ScienceManuscriptBlueprintSectionInput,
  ScienceSubmissionMetadata,
  ScienceResearchCompletionScope,
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
import { SCIENCE_CLAIM_CLASSES, SCIENCE_CLAIM_STATUSES } from "../../shared/science-claim-ledger";
import type { RecordScienceManuscriptComparableEligibilityInput } from "../../shared/science-manuscript-comparable-eligibility";
import type {
  RecordScienceManuscriptCoherenceAssessmentInput,
  ScienceCoherenceNumericAssertionInput,
  ScienceCoherenceNumericExemptionInput,
  ScienceCoherenceNumericSourceSelectorInput,
  ScienceCoherenceTextOwner,
} from "../../shared/science-manuscript-coherence";
import type { ScienceEvidenceGraphConditioningContext, ScienceEvidenceGraphEdgeKind } from "../../shared/science-evidence-graph";
import { SCIENCE_EVIDENCE_GRAPH_EDGE_KINDS } from "../../shared/science-evidence-graph";
import { scienceResearchIntentCatalog } from "../../shared/science-research-intent";
import { scienceStudyProgress } from "./study-progress";
import { SCIENCE_PAIRED_TABLE_METHODS, SCIENCE_TABLE_LIMITS } from "../../shared/science-table";
import { scienceNextResearchPhaseGate } from "./store";
import { scienceLabDecisionProjectionsForProject } from "./lab-decision-projection-service";
import { loadSciencePluginRuntime, readSciencePluginFile } from "./plugin-runtime";
import { inspectScienceManuscriptDepth } from "./manuscript/depth-preflight";
import { assertScienceAgentManuscriptDraft } from "./manuscript/agent-draft-gate";
import { ScienceExtantReferenceAssemblyHttpError } from "./extant-reference-assemblies";
import { ScienceComparativeGenomicsProviderValidationError } from "./comparative-genomics";
import {
  SCIENCE_MCP_SERVER_KEY,
  installedCodexSupportsExactMcpToolApproval,
  scienceCodexExactToolApprovalConfigArgs,
} from "./codex-tool-approval";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_AI_VISUAL_BYTES = 8 * 1024 * 1024;
const TOKEN_ENV = "AGENTLAS_SCIENCE_MCP_TOKEN";
const ENDPOINT_ENV = "AGENTLAS_SCIENCE_MCP_ENDPOINT";
const CATALOG_ENV = "AGENTLAS_SCIENCE_MCP_CATALOG";
const SERVER_KEY = SCIENCE_MCP_SERVER_KEY;

type ScienceContext = NonNullable<InvocationExecutionContext["science"]>;
type McpTool = { name: string; route: string; description: string; inputSchema: Record<string, unknown> };
const TOOL_UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
type Grant = {
  tokenHash: string;
  context: ScienceContext;
  catalog: ScienceLabCapabilityCatalog;
  expiresAt: number;
  routeState: {
    paleontologyOccurrenceAttempts: number;
    autoAnalyzedPaleontologyCatalogRuns: Map<string, string>;
  };
};

const MANUSCRIPT_UUID_SCHEMA = {
  type: "string",
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
} as const;

const MANUSCRIPT_SHA256_SCHEMA = { type: "string", pattern: "^[a-f0-9]{64}$" } as const;
const SCIENCE_RESEARCH_MAIN_PHASE_SCHEMA = {
  type: "string",
  enum: ["intake", "literature", "hypothesis", "analysis_plan_draft", "analysis_plan_frozen", "execution", "evidence_reconciliation", "conclusions", "manuscript", "journal_profile", "submission_validation", "ready_to_submit"],
} as const;
const exactLifecyclePreconditionSchema = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const phaseGatePreconditionSchema = (fromPhase: string, toPhase: string, gateCode: string, extra: Record<string, unknown> = {}) => exactLifecyclePreconditionSchema({
  kind: { const: "phase_gate" },
  fromPhase: { const: fromPhase },
  toPhase: { const: toPhase },
  gateCode: { const: gateCode },
  evidenceSha256: MANUSCRIPT_SHA256_SCHEMA,
  ...extra,
});
export const SCIENCE_RESEARCH_LIFECYCLE_PRECONDITIONS_SCHEMA = {
  oneOf: [
    exactLifecyclePreconditionSchema({ kind: { const: "state_update" }, reason: { type: "string", enum: ["progress", "decision_opened", "decision_resolved", "blocker_changed"] }, evidenceSha256: MANUSCRIPT_SHA256_SCHEMA }),
    phaseGatePreconditionSchema("intake", "literature", "intake.complete"),
    phaseGatePreconditionSchema("literature", "hypothesis", "literature.complete"),
    phaseGatePreconditionSchema("hypothesis", "analysis_plan_draft", "hypothesis.complete"),
    phaseGatePreconditionSchema("analysis_plan_draft", "analysis_plan_frozen", "analysis_plan.frozen"),
    phaseGatePreconditionSchema("analysis_plan_frozen", "execution", "analysis_plan.execution_authorized"),
    phaseGatePreconditionSchema("execution", "evidence_reconciliation", "execution.receipts_verified"),
    phaseGatePreconditionSchema("evidence_reconciliation", "conclusions", "evidence.reconciled", {
      claimLedgerId: MANUSCRIPT_UUID_SCHEMA,
      claimLedgerRevision: { type: "integer", minimum: 1 },
      claimLedgerManifestSha256: MANUSCRIPT_SHA256_SCHEMA,
      claimGateReportSha256: MANUSCRIPT_SHA256_SCHEMA,
      claimPolicyContentSha256: MANUSCRIPT_SHA256_SCHEMA,
    }),
    phaseGatePreconditionSchema("conclusions", "manuscript", "conclusions.bounded"),
    phaseGatePreconditionSchema("manuscript", "journal_profile", "manuscript.version_bound"),
    phaseGatePreconditionSchema("journal_profile", "submission_validation", "journal_profile.verified"),
    phaseGatePreconditionSchema("submission_validation", "ready_to_submit", "submission.package_verified"),
    exactLifecyclePreconditionSchema({ kind: { const: "block" }, fromPhase: SCIENCE_RESEARCH_MAIN_PHASE_SCHEMA, evidenceSha256: MANUSCRIPT_SHA256_SCHEMA }),
    exactLifecyclePreconditionSchema({ kind: { const: "resume" }, resumePhase: SCIENCE_RESEARCH_MAIN_PHASE_SCHEMA, resolutionSha256: MANUSCRIPT_SHA256_SCHEMA }),
    exactLifecyclePreconditionSchema({ kind: { const: "stop" }, fromPhase: { type: "string", enum: [...SCIENCE_RESEARCH_MAIN_PHASE_SCHEMA.enum, "blocked"] }, evidenceSha256: MANUSCRIPT_SHA256_SCHEMA }),
    exactLifecyclePreconditionSchema({ kind: { const: "fail" }, fromPhase: { type: "string", enum: [...SCIENCE_RESEARCH_MAIN_PHASE_SCHEMA.enum, "blocked"] }, evidenceSha256: MANUSCRIPT_SHA256_SCHEMA }),
  ],
} as const;
export const SCIENCE_RESEARCH_FROZEN_PLAN_SCHEMA = {
  type: ["object", "null"],
  description: "Exact frozen analysis-plan binding from list_analysis_plans. Use null before a plan is frozen; otherwise send only analysisSpecId, version, and contentSha256.",
  properties: {
    analysisSpecId: {
      ...MANUSCRIPT_UUID_SCHEMA,
      description: "The frozen analysis plan's id from list_analysis_plans (not id or analysisSpecVersion).",
    },
    version: {
      type: "integer",
      minimum: 1,
      description: "The frozen analysis plan's currentVersion from list_analysis_plans.",
    },
    contentSha256: {
      ...MANUSCRIPT_SHA256_SCHEMA,
      description: "The frozen analysis plan's currentDocumentSha256 from list_analysis_plans.",
    },
  },
  required: ["analysisSpecId", "version", "contentSha256"],
  additionalProperties: false,
} as const;
const SCIENCE_DOMAIN_SCHEMA = {
  type: "string",
  enum: ["general", "life-science", "chemistry", "physics", "materials-science", "genomics", "astronomy", "earth-ecology", "statistics", "economics", "finance"],
} as const;
const MANUSCRIPT_COMPARABLE_QUOTE_LOCATOR_SCHEMA = {
  type: "object",
  properties: {
    section_id: MANUSCRIPT_UUID_SCHEMA,
    start_byte: { type: "integer", minimum: 0, maximum: 100_000_000 },
    end_byte: { type: "integer", minimum: 1, maximum: 100_000_000 },
    exact_quote: { type: "string", minLength: 1, maxLength: 20_000 },
    exact_quote_sha256: MANUSCRIPT_SHA256_SCHEMA,
  },
  required: ["section_id", "start_byte", "end_byte", "exact_quote", "exact_quote_sha256"],
  additionalProperties: false,
} as const;
const MANUSCRIPT_BLUEPRINT_COMPARABLE_SCHEMA = {
  type: "object",
  properties: {
    source_id: MANUSCRIPT_UUID_SCHEMA,
    source_version_id: MANUSCRIPT_UUID_SCHEMA,
    source_version: { type: "integer", minimum: 1 },
    source_content_sha256: MANUSCRIPT_SHA256_SCHEMA,
    eligibility_receipt_id: MANUSCRIPT_UUID_SCHEMA,
    section_mappings: { type: "array", minItems: 2, maxItems: 20, items: {
      type: "object", properties: {
        role: { type: "string", enum: ["abstract", "introduction", "related-work", "methods", "theory", "results", "discussion", "limitations", "conclusion", "references", "appendix", "other"] },
        source_section_ids: { type: "array", minItems: 1, maxItems: 20, uniqueItems: true, items: MANUSCRIPT_UUID_SCHEMA },
      }, required: ["role", "source_section_ids"], additionalProperties: false,
    } },
  },
  required: ["source_id", "source_version_id", "source_version", "source_content_sha256", "eligibility_receipt_id", "section_mappings"],
  additionalProperties: false,
} as const;
const MANUSCRIPT_BLUEPRINT_SECTION_SCHEMA = {
  type: "object",
  properties: {
    key: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,119}$" },
    title: { type: "string", minLength: 1, maxLength: 240 },
    role: { type: "string", enum: ["abstract", "introduction", "related-work", "methods", "theory", "results", "discussion", "limitations", "conclusion", "references", "appendix", "other"] },
    required: { type: "boolean" },
    rhetorical_moves: { type: "array", minItems: 1, maxItems: 20, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 1000 } },
    visual_expectation: { type: "string", enum: ["none", "optional", "required"] },
    evidence_roles: { type: "array", maxItems: 20, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 240 } },
  },
  required: ["key", "title", "role", "required", "rhetorical_moves", "visual_expectation", "evidence_roles"],
  additionalProperties: false,
} as const;
const MANUSCRIPT_BLUEPRINT_JOURNAL_SCHEMA = {
  type: ["object", "null"],
  properties: {
    journal_profile_id: MANUSCRIPT_UUID_SCHEMA,
    journal_profile_version: { type: "integer", minimum: 1 },
    journal_profile_content_sha256: MANUSCRIPT_SHA256_SCHEMA,
  },
  required: ["journal_profile_id", "journal_profile_version", "journal_profile_content_sha256"],
  additionalProperties: false,
} as const;
const MANUSCRIPT_BLUEPRINT_BINDING_SCHEMA = {
  type: "object",
  properties: {
    blueprint_id: MANUSCRIPT_UUID_SCHEMA,
    blueprint_version: { type: "integer", minimum: 1 },
    blueprint_content_sha256: MANUSCRIPT_SHA256_SCHEMA,
  },
  required: ["blueprint_id", "blueprint_version", "blueprint_content_sha256"],
  additionalProperties: false,
} as const;
const MANUSCRIPT_SCHOLARLY_NODE_LOCATOR_SCHEMA = {
  type: "object",
  properties: {
    node_id: MANUSCRIPT_UUID_SCHEMA,
    node_revision: { type: "integer", minimum: 1 },
    node_content_sha256: MANUSCRIPT_SHA256_SCHEMA,
    node_kind: { type: "string", enum: ["heading", "paragraph", "equation", "figure", "table", "list", "blockquote", "code", "rule"] },
  },
  required: ["node_id", "node_revision", "node_content_sha256", "node_kind"],
  additionalProperties: false,
} as const;
const MANUSCRIPT_SCHOLARLY_QUOTE_LOCATOR_SCHEMA = {
  type: "object",
  properties: {
    node_id: MANUSCRIPT_UUID_SCHEMA,
    node_revision: { type: "integer", minimum: 1 },
    node_content_sha256: MANUSCRIPT_SHA256_SCHEMA,
    node_kind: { const: "paragraph" },
    from: { type: "integer", minimum: 0, maximum: 2_000_000 },
    to: { type: "integer", minimum: 1, maximum: 2_000_000 },
    exact_quote: { type: "string", minLength: 1, maxLength: 20_000 },
  },
  required: ["node_id", "node_revision", "node_content_sha256", "node_kind", "from", "to", "exact_quote"],
  additionalProperties: false,
} as const;
const MANUSCRIPT_SCHOLARLY_ITEM_SCHEMA = {
  type: "object",
  properties: {
    label: { type: "string", minLength: 1, maxLength: 1_000 },
    status: { type: "string", enum: ["satisfied", "partial", "missing"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence: { type: "array", minItems: 0, maxItems: 100, items: MANUSCRIPT_SCHOLARLY_QUOTE_LOCATOR_SCHEMA },
    rationale: { type: "string", minLength: 1, maxLength: 8_000 },
  },
  required: ["label", "status", "confidence", "evidence", "rationale"], additionalProperties: false,
} as const;

const MANUSCRIPT_COHERENCE_TEXT_OWNER_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { const: "claim" },
        claim_id: MANUSCRIPT_UUID_SCHEMA,
        claim_content_sha256: MANUSCRIPT_SHA256_SCHEMA,
      },
      required: ["kind", "claim_id", "claim_content_sha256"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "visual-caption" },
        node_id: MANUSCRIPT_UUID_SCHEMA,
        node_revision: { type: "integer", minimum: 1 },
        node_content_sha256: MANUSCRIPT_SHA256_SCHEMA,
      },
      required: ["kind", "node_id", "node_revision", "node_content_sha256"],
      additionalProperties: false,
    },
  ],
} as const;

const MANUSCRIPT_COHERENCE_NUMERIC_SOURCE_SELECTOR_SCHEMA = {
  type: "object",
  properties: {
    component_role: { type: "string", enum: ["value", "confidence-level", "lower", "upper"] },
    artifact_id: MANUSCRIPT_UUID_SCHEMA,
    artifact_version: { type: "integer", minimum: 1 },
    artifact_content_sha256: MANUSCRIPT_SHA256_SCHEMA,
    validation_receipt_id: MANUSCRIPT_UUID_SCHEMA,
    json_pointer: { type: "string", minLength: 2, maxLength: 2_048, pattern: "^/(?:[^~]|~[01])+$" },
    unit_json_pointer: { oneOf: [
      { type: "null" },
      { type: "string", minLength: 2, maxLength: 2_048, pattern: "^/(?:[^~]|~[01])+$" },
    ] },
  },
  required: ["component_role", "artifact_id", "artifact_version", "artifact_content_sha256", "validation_receipt_id", "json_pointer", "unit_json_pointer"],
  additionalProperties: false,
} as const;

const MANUSCRIPT_COHERENCE_DECLARATIONS_SCHEMA = {
  summary_claim_links: {
    type: "array",
    maxItems: 5_000,
    items: {
      type: "object",
      properties: {
        summary_claim_id: MANUSCRIPT_UUID_SCHEMA,
        body_claim_ids: { type: "array", minItems: 1, maxItems: 5_000, uniqueItems: true, items: MANUSCRIPT_UUID_SCHEMA },
      },
      required: ["summary_claim_id", "body_claim_ids"],
      additionalProperties: false,
    },
  },
  results_discussion_links: {
    type: "array",
    maxItems: 5_000,
    items: {
      type: "object",
      properties: {
        result_claim_id: MANUSCRIPT_UUID_SCHEMA,
        discussion_claim_ids: { type: "array", minItems: 1, maxItems: 5_000, uniqueItems: true, items: MANUSCRIPT_UUID_SCHEMA },
      },
      required: ["result_claim_id", "discussion_claim_ids"],
      additionalProperties: false,
    },
  },
  numeric_assertions: {
    type: "array",
    maxItems: 20_000,
    items: {
      type: "object",
      properties: {
        group_id: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$" },
        owner: MANUSCRIPT_COHERENCE_TEXT_OWNER_SCHEMA,
        from: { type: "integer", minimum: 0, maximum: 2_000_000 },
        to: { type: "integer", minimum: 1, maximum: 2_000_000 },
        exact_quote: { type: "string", minLength: 1, maxLength: 20_000 },
        grammar: { type: "string", enum: ["sample-size/v1", "effect-estimate/v1", "confidence-interval/v1", "quantity-unit/v1"] },
        presentation: { type: "string", enum: ["exact", "rounded"] },
        sources: { type: "array", minItems: 1, maxItems: 3, uniqueItems: true, items: MANUSCRIPT_COHERENCE_NUMERIC_SOURCE_SELECTOR_SCHEMA },
      },
      required: ["group_id", "owner", "from", "to", "exact_quote", "grammar", "presentation", "sources"],
      additionalProperties: false,
    },
  },
  numeric_exemptions: {
    type: "array",
    maxItems: 20_000,
    items: {
      type: "object",
      properties: {
        owner: MANUSCRIPT_COHERENCE_TEXT_OWNER_SCHEMA,
        from: { type: "integer", minimum: 0, maximum: 2_000_000 },
        to: { type: "integer", minimum: 1, maximum: 2_000_000 },
        exact_quote: { type: "string", minLength: 1, maxLength: 20_000 },
        reason: { type: "string", enum: ["calendar-year", "citation-number", "identifier"] },
      },
      required: ["owner", "from", "to", "exact_quote", "reason"],
      additionalProperties: false,
    },
  },
} as const;

/**
 * Closed JSON Schema for the exact stable-ID operation union accepted by the
 * manuscript document model. The runtime model/store still revalidate every
 * identity, revision, semantic hash, citation offset and table shape before a
 * proposal can be persisted or applied.
 */
const MANUSCRIPT_SCHEMA_DEFS = {
    citationMark: {
      type: "object",
      properties: {
        id: MANUSCRIPT_UUID_SCHEMA,
        revision: { type: "integer", minimum: 1 },
        contentSha256: MANUSCRIPT_SHA256_SCHEMA,
        from: { type: "integer", minimum: 0, maximum: 2_000_000 },
        to: { type: "integer", minimum: 1, maximum: 2_000_000 },
        syntax: { type: "string", enum: ["placeholder", "pandoc"] },
        locators: { type: "array", minItems: 1, maxItems: 128, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 240 } },
      },
      required: ["id", "revision", "contentSha256", "from", "to", "syntax", "locators"],
      additionalProperties: false,
    },
    node: {
      oneOf: [
        {
          type: "object",
          properties: { id: MANUSCRIPT_UUID_SCHEMA, revision: { type: "integer", minimum: 1 }, contentSha256: MANUSCRIPT_SHA256_SCHEMA, kind: { const: "heading" }, level: { type: "integer", minimum: 1, maximum: 4 }, text: { type: "string", minLength: 1, maxLength: 8_000 } },
          required: ["id", "revision", "contentSha256", "kind", "level", "text"], additionalProperties: false,
        },
        {
          type: "object",
          properties: { id: MANUSCRIPT_UUID_SCHEMA, revision: { type: "integer", minimum: 1 }, contentSha256: MANUSCRIPT_SHA256_SCHEMA, kind: { const: "paragraph" }, markdown: { type: "string", minLength: 1, maxLength: 2_000_000 }, citationMarks: { type: "array", maxItems: 10_000, items: { $ref: "#/$defs/citationMark" } } },
          required: ["id", "revision", "contentSha256", "kind", "markdown", "citationMarks"], additionalProperties: false,
        },
        {
          type: "object",
          properties: { id: MANUSCRIPT_UUID_SCHEMA, revision: { type: "integer", minimum: 1 }, contentSha256: MANUSCRIPT_SHA256_SCHEMA, kind: { const: "equation" }, tex: { type: "string", minLength: 1, maxLength: 200_000 }, label: { type: ["string", "null"], maxLength: 120 } },
          required: ["id", "revision", "contentSha256", "kind", "tex", "label"], additionalProperties: false,
        },
        {
          type: "object",
          properties: { id: MANUSCRIPT_UUID_SCHEMA, revision: { type: "integer", minimum: 1 }, contentSha256: MANUSCRIPT_SHA256_SCHEMA, kind: { const: "figure" }, locator: { type: "string", minLength: 1, maxLength: 240 }, caption: { type: "string", maxLength: 100_000 } },
          required: ["id", "revision", "contentSha256", "kind", "locator", "caption"], additionalProperties: false,
        },
        {
          type: "object",
          properties: { id: MANUSCRIPT_UUID_SCHEMA, revision: { type: "integer", minimum: 1 }, contentSha256: MANUSCRIPT_SHA256_SCHEMA, kind: { const: "table" }, mode: { const: "artifact" }, locator: { type: "string", minLength: 1, maxLength: 240 }, caption: { type: "string", maxLength: 100_000 } },
          required: ["id", "revision", "contentSha256", "kind", "mode", "locator", "caption"], additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            id: MANUSCRIPT_UUID_SCHEMA, revision: { type: "integer", minimum: 1 }, contentSha256: MANUSCRIPT_SHA256_SCHEMA, kind: { const: "table" }, mode: { const: "inline" },
            caption: { type: "string", maxLength: 100_000 }, label: { type: ["string", "null"], maxLength: 120 },
            align: { type: "array", minItems: 1, maxItems: 512, items: { type: ["string", "null"], enum: ["left", "center", "right", null] } },
            header: { type: "array", minItems: 1, maxItems: 512, items: { type: "string", maxLength: 100_000 } },
            rows: { type: "array", maxItems: 100_000, items: { type: "array", minItems: 1, maxItems: 512, items: { type: "string", maxLength: 100_000 } } },
          },
          required: ["id", "revision", "contentSha256", "kind", "mode", "caption", "label", "align", "header", "rows"], additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            id: MANUSCRIPT_UUID_SCHEMA, revision: { type: "integer", minimum: 1 }, contentSha256: MANUSCRIPT_SHA256_SCHEMA, kind: { const: "list" }, ordered: { type: "boolean" }, start: { type: "integer", minimum: 1, maximum: 999 },
            items: { type: "array", minItems: 1, maxItems: 10_000, items: { type: "object", properties: { nodes: { type: "array", minItems: 1, maxItems: 20_000, items: { $ref: "#/$defs/node" } } }, required: ["nodes"], additionalProperties: false } },
          },
          required: ["id", "revision", "contentSha256", "kind", "ordered", "start", "items"], additionalProperties: false,
        },
        {
          type: "object",
          properties: { id: MANUSCRIPT_UUID_SCHEMA, revision: { type: "integer", minimum: 1 }, contentSha256: MANUSCRIPT_SHA256_SCHEMA, kind: { const: "blockquote" }, children: { type: "array", minItems: 1, maxItems: 20_000, items: { $ref: "#/$defs/node" } } },
          required: ["id", "revision", "contentSha256", "kind", "children"], additionalProperties: false,
        },
        {
          type: "object",
          properties: { id: MANUSCRIPT_UUID_SCHEMA, revision: { type: "integer", minimum: 1 }, contentSha256: MANUSCRIPT_SHA256_SCHEMA, kind: { const: "code" }, language: { type: ["string", "null"], maxLength: 80 }, text: { type: "string", maxLength: 2_000_000 } },
          required: ["id", "revision", "contentSha256", "kind", "language", "text"], additionalProperties: false,
        },
        {
          type: "object",
          properties: { id: MANUSCRIPT_UUID_SCHEMA, revision: { type: "integer", minimum: 1 }, contentSha256: MANUSCRIPT_SHA256_SCHEMA, kind: { const: "rule" } },
          required: ["id", "revision", "contentSha256", "kind"], additionalProperties: false,
        },
      ],
    },
} as const;

const MANUSCRIPT_OPERATION_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: { kind: { const: "insert-node" }, afterNodeId: { oneOf: [{ type: "null" }, MANUSCRIPT_UUID_SCHEMA] }, expectedAfterNodeRevision: { type: ["integer", "null"], minimum: 1 }, expectedAfterNodeContentSha256: { oneOf: [{ type: "null" }, MANUSCRIPT_SHA256_SCHEMA] }, node: { $ref: "#/$defs/node" } },
      required: ["kind", "afterNodeId", "expectedAfterNodeRevision", "expectedAfterNodeContentSha256", "node"], additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { const: "insert-artifact" }, afterNodeId: { oneOf: [{ type: "null" }, MANUSCRIPT_UUID_SCHEMA] }, expectedAfterNodeRevision: { type: ["integer", "null"], minimum: 1 }, expectedAfterNodeContentSha256: { oneOf: [{ type: "null" }, MANUSCRIPT_SHA256_SCHEMA] }, nodeId: MANUSCRIPT_UUID_SCHEMA, nodeKind: { type: "string", enum: ["figure", "table"] }, locator: { type: "string", minLength: 1, maxLength: 240 }, caption: { type: "string", maxLength: 100_000 }, validationReceiptId: MANUSCRIPT_UUID_SCHEMA },
      required: ["kind", "afterNodeId", "expectedAfterNodeRevision", "expectedAfterNodeContentSha256", "nodeId", "nodeKind", "locator", "caption", "validationReceiptId"], additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { const: "replace-node" }, nodeId: MANUSCRIPT_UUID_SCHEMA, expectedRevision: { type: "integer", minimum: 1 }, expectedContentSha256: MANUSCRIPT_SHA256_SCHEMA, replacement: { $ref: "#/$defs/node" } },
      required: ["kind", "nodeId", "expectedRevision", "expectedContentSha256", "replacement"], additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { const: "delete-node" }, nodeId: MANUSCRIPT_UUID_SCHEMA, expectedRevision: { type: "integer", minimum: 1 }, expectedContentSha256: MANUSCRIPT_SHA256_SCHEMA },
      required: ["kind", "nodeId", "expectedRevision", "expectedContentSha256"], additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { const: "move-node" }, nodeId: MANUSCRIPT_UUID_SCHEMA, expectedRevision: { type: "integer", minimum: 1 }, expectedContentSha256: MANUSCRIPT_SHA256_SCHEMA, afterNodeId: { oneOf: [{ type: "null" }, MANUSCRIPT_UUID_SCHEMA] }, expectedAfterNodeRevision: { type: ["integer", "null"], minimum: 1 }, expectedAfterNodeContentSha256: { oneOf: [{ type: "null" }, MANUSCRIPT_SHA256_SCHEMA] } },
      required: ["kind", "nodeId", "expectedRevision", "expectedContentSha256", "afterNodeId", "expectedAfterNodeRevision", "expectedAfterNodeContentSha256"], additionalProperties: false,
    },
  ],
} as const;

const MANUSCRIPT_SELECTION_CONTEXT_REFS_SCHEMA = {
  type: "array",
  maxItems: 100,
  uniqueItems: true,
  items: MANUSCRIPT_UUID_SCHEMA,
} as const;

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
        { type: "object", properties: { kind: { const: "bibliography-style" }, style: { type: "string", enum: ["numeric", "apa", "nature"] } }, required: ["kind", "style"], additionalProperties: false },
        { type: "object", properties: {
          kind: { const: "manuscript-layout" },
          pageSize: { type: "string", enum: ["a4", "letter"] },
          marginsMm: { type: "object", properties: { top: { type: "integer", minimum: 5, maximum: 100 }, right: { type: "integer", minimum: 5, maximum: 100 }, bottom: { type: "integer", minimum: 5, maximum: 100 }, left: { type: "integer", minimum: 5, maximum: 100 } }, required: ["top", "right", "bottom", "left"], additionalProperties: false },
          fontFamily: { type: "string", enum: ["serif", "sans-serif"] },
          fontSizePt: { type: "integer", enum: [10, 11, 12] },
          lineSpacing: { type: "string", enum: ["single", "one-and-half", "double"] },
          lineNumbers: { type: "boolean" },
          renderTarget: { type: "string", enum: ["initial-submission", "accepted-source", "published-approximation"] },
          latexTemplate: { type: "string", enum: ["generic-article", "aps-revtex4-2"] },
          latexJournalStyle: { type: "string", enum: ["pra", "prb", "prc", "prd", "pre", "prl", "rmp"] },
          columnCount: { type: "integer", enum: [1, 2] },
          columnGapMm: { type: "integer", minimum: 3, maximum: 30 },
          titlePageMode: { type: "string", enum: ["inline", "separate"] },
        }, required: ["kind", "pageSize", "marginsMm", "fontFamily", "fontSizePt", "lineSpacing", "lineNumbers"], additionalProperties: false },
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

const ANALYSIS_ACQUISITION_SCHEMA = {
  type: "object",
  properties: {
    strategy: { const: "acquire-before-execution" },
    sources: {
      type: "array", minItems: 1, maxItems: 100,
      items: {
        type: "object",
        properties: {
          provider: { type: "string", minLength: 1, maxLength: 500 },
          sourceRefs: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 4_000 } },
          retrievalPlan: { type: "string", minLength: 1, maxLength: 8_000 },
          expectedArtifactKind: { type: "string", minLength: 1, maxLength: 500 },
        },
        required: ["provider", "sourceRefs", "retrievalPlan", "expectedArtifactKind"],
        additionalProperties: false,
      },
    },
  },
  required: ["strategy", "sources"],
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
        inputs: { type: "array", maxItems: 100, items: ANALYSIS_ARTIFACT_REF_SCHEMA },
        acquisition: { oneOf: [{ type: "null" }, ANALYSIS_ACQUISITION_SCHEMA] },
        outcomeVariables: { type: "array", minItems: 1, maxItems: 200, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 500 } },
        predictorVariables: { type: "array", maxItems: 500, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 500 } },
        transformations: { type: "array", maxItems: 500, items: { type: "string", minLength: 1, maxLength: 8_000 } },
        exclusions: { type: "array", maxItems: 500, items: { type: "string", minLength: 1, maxLength: 8_000 } },
      },
      required: ["inputs", "acquisition", "outcomeVariables", "predictorVariables", "transformations", "exclusions"],
      anyOf: [
        { properties: { inputs: { type: "array", minItems: 1 } }, required: ["inputs"] },
        { properties: { acquisition: ANALYSIS_ACQUISITION_SCHEMA }, required: ["acquisition"] },
      ],
      additionalProperties: false,
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
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        method_selection_detail: {
          type: "array",
          maxItems: 40,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 160 },
        },
      },
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
    description: "Create a versioned research contract for the granted project, including objective, evidence-verifiable success and failure criteria, operating constraints, and loop budgets sized for the research objective. Main applies the project's existing standing research-contract approval when authorized and returns the exact approval receipt. If the returned contract is approved, continue the research and start its loop; do not stop for another confirmation. A draft result requires the human decision surface. Neither a short answer nor a manuscript alone proves the research objective complete.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        expected_project_version: { type: "integer", minimum: 1 },
        objective: { type: "string", minLength: 1, maxLength: 20000 },
        success_criteria: { type: "array", minItems: 1, maxItems: 30, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 2000 } },
        failure_criteria: { type: "array", minItems: 1, maxItems: 30, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 2000 } },
        constraints: { type: "array", maxItems: 50, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 2000 } },
        completion_scope: { type: "string", enum: ["full-study", "bounded-deliverable"], description: "Whether the authoritative loop ends at the contract criteria or remains active through the lifecycle ready_to_submit gate." },
        max_episodes: { type: "integer", minimum: 1, maximum: 1000 },
        max_wall_time_minutes: { type: "integer", minimum: 1, maximum: 10080 },
      },
      required: ["tool_call_id", "expected_project_version", "objective", "success_criteria", "failure_criteria", "constraints", "completion_scope", "max_episodes", "max_wall_time_minutes"],
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
        preconditions: SCIENCE_RESEARCH_LIFECYCLE_PRECONDITIONS_SCHEMA,
        open_blocking_decisions: { type: "array", maxItems: 100, items: { type: "object" } },
        blockers: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 8000 } },
        frozen_analysis_plan: SCIENCE_RESEARCH_FROZEN_PLAN_SCHEMA,
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
    description: "Append an immutable successor revision to one current hypothesis using exact optimistic concurrency. Supported or contradicted states require exact succeeded Research Episode result bindings against that parent hypothesis; stale parents, fabricated outcomes, and invalid transitions are rejected. This route records evidence-derived states only: approved and rejected are human authorization decisions and are refused here. To obtain one, call request_human_research_decision and let the accountable human answer it in the app.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        parent_hypothesis_id: { type: "string", format: "uuid" },
        expected_parent_version: { type: "integer", minimum: 1 },
        expected_parent_content_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        role: { type: "string", enum: ["primary", "alternative"] },
        status: { type: "string", enum: ["proposed", "supported", "contradicted"] },
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
    name: "search_paleontology_occurrences",
    route: "/v1/platform/paleontology/occurrence-search",
    description: "Retrieve bounded, deterministic PBDB taxon and fossil-occurrence pages, preserve every exact provider response as immutable project Sources and one ResearchRun, and return stratigraphic age intervals without presenting midpoints as point dates. This tool records fossil evidence only and never claims recovered DNA, a genome, or de-extinction feasibility.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        taxon_name: { type: "string", minLength: 1, maxLength: 500 },
        page_size: { type: "integer", minimum: 1, maximum: 100 },
        max_pages: { type: "integer", minimum: 1, maximum: 20 },
        max_records: { type: "integer", minimum: 1, maximum: 2000 },
        title: { type: "string", minLength: 1, maxLength: 240 },
      },
      required: ["tool_call_id", "taxon_name"],
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
    name: "fetch_noaa_coops_water_levels",
    route: "/v1/platform/earth-science/noaa-coops-water-levels",
    description: "Fetch one bounded observed NOAA CO-OPS water_level series for an exact station and UTC-minute interval, preserve the exact provider response as a project Source and ResearchRun, and create a lineage-bound editable table plus interactive Vega artifact. No prediction or interpolation is performed.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        station_id: { type: "string", pattern: "^[0-9]{7}$", minLength: 7, maxLength: 7 },
        start_time: { type: "string", format: "date-time" },
        end_time: { type: "string", format: "date-time" },
        datum: { type: "string", enum: ["CRD", "IGLD", "LWD", "MHHW", "MHW", "MTL", "MSL", "MLW", "MLLW", "NAVD", "STND"] },
        units: { type: "string", enum: ["metric", "english"] },
        title: { type: "string", minLength: 1, maxLength: 240 },
      },
      required: ["tool_call_id", "station_id", "start_time", "end_time", "datum"],
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
    name: "analyze_world_bank_indicator_growth",
    route: "/v1/platform/economics/world-bank-growth-analysis",
    description: "Transform one exact succeeded World Bank indicator run into an adjacent annual year-over-year percentage-change table and Vega artifact. Missing values, zero baselines, and year gaps remain explicit and are never imputed; this is descriptive analysis, not causal inference, forecasting, or investment advice.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        parent_run_id: { type: "string", format: "uuid", minLength: 36, maxLength: 36 },
        title: { type: "string", minLength: 1, maxLength: 240 },
      },
      required: ["tool_call_id", "parent_run_id"],
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
    name: "build_extant_reference_assembly_manifest",
    route: "/v1/platform/genomics/extant-reference-assemblies",
    description: "Retrieve exact Ensembl release, genome, assembly, README, and CHECKSUMS bytes for 2–8 extant species; cross-check each accession; and create a project-scoped publication table that pins the provider's toplevel FASTA locator and BSD checksum. FASTA contents are not downloaded, and no extinct genome, ancestral sequence, phenotype, embryo, or hatching claim is emitted.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        species: { type: "array", minItems: 2, maxItems: 8, uniqueItems: true, items: { type: "string", pattern: "^[a-z][a-z0-9_]+$", maxLength: 80 } },
        title: { type: "string", minLength: 1, maxLength: 240 },
      },
      required: ["tool_call_id", "species"],
      additionalProperties: false,
    },
  },
  {
    name: "build_comparative_genomics_gene_tree",
    route: "/v1/platform/genomics/comparative-gene-tree",
    description: "Retrieve the current Ensembl data-release receipt plus one bounded rooted Compara gene tree with provider-aligned extant protein or cDNA sequences, preserve exact responses as Sources and a ResearchRun, and create a lineage-bound phylogeny artifact with an alignment-QC publication table. Orthology, alignment, and topology remain inferred; no ancestral sequence or extinct-species genome is emitted.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        species: { type: "string", pattern: "^[a-z][a-z0-9_]+$", maxLength: 80 },
        gene_id: { type: "string", pattern: "^[A-Za-z0-9_.-]+$", maxLength: 80 },
        prune_taxon: { type: "integer", minimum: 1, maximum: 2147483647 },
        sequence_type: { type: "string", enum: ["protein", "cdna"] },
        title: { type: "string", minLength: 1, maxLength: 240 },
      },
      required: ["tool_call_id", "species", "gene_id", "prune_taxon", "sequence_type"],
      additionalProperties: false,
    },
  },
  {
    name: "materialize_comparative_genomics_publication_table",
    route: "/v1/platform/genomics/comparative-publication-table",
    description: "Project the exact alignment-QC output of a succeeded comparative-genomics run into an independently editable, run-bound table artifact that can be inserted into a manuscript and exported as DOCX or LaTeX without pretending the data came from CSV.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        parent_run_id: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" },
        title: { type: "string", minLength: 1, maxLength: 240 },
      },
      required: ["tool_call_id", "parent_run_id"],
      additionalProperties: false,
    },
  },
  {
    name: "run_hypothetical_asr_fitch",
    route: "/v1/platform/genomics/hypothetical-asr-fitch",
    description: "Run deterministic Fitch parsimony over the exact extant cDNA alignment and rooted bifurcating topology of a succeeded comparative-genomics parent run. Persist a site table and interactive ambiguity Figure as a comparative-genomics Lab artifact. The result remains explicitly hypothetical, not probabilistic or publication-grade ASR, and never an extinct genome, phenotype, embryo, or hatching result.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        parent_run_id: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" },
        target_node_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]*$", maxLength: 80 },
      },
      required: ["tool_call_id", "parent_run_id", "target_node_id"],
      additionalProperties: false,
    },
  },
  {
    name: "materialize_extant_archosaur_locus_panel",
    route: "/v1/platform/genomics/extant-archosaur-locus-panel",
    description: "Materialize an extant-only avian/crocodilian locus panel from succeeded Ensembl Compara cDNA and pinned extant reference-assembly runs. The operation emits a lineage-bound exploratory QC analysis, publication table, and Vega figure; it does not reconstruct extinct DNA, an ancestral sequence, a chromosome, a phenotype, an embryo, or a hatching result.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        parent_run_id: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" },
        reference_assembly_run_id: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" },
        avian_leaf_node_ids: { type: "array", minItems: 2, maxItems: 4, uniqueItems: true, items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]*$", maxLength: 80 } },
        crocodilian_leaf_node_ids: { type: "array", minItems: 2, maxItems: 4, uniqueItems: true, items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]*$", maxLength: 80 } },
        title: { type: "string", minLength: 1, maxLength: 240 },
      },
      required: ["tool_call_id", "parent_run_id", "reference_assembly_run_id", "avian_leaf_node_ids", "crocodilian_leaf_node_ids"],
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
    name: "inspect_science_artifact_numeric_values",
    route: "/v1/platform/artifacts/inspect-numeric-values",
    description: "Inspect a bounded catalog of exact numeric scalar values from one immutable, publication-validated, run-bound Science artifact. The host returns JSON Pointers and canonical values without exposing the raw payload; use these locators when binding manuscript numbers.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        artifact_id: MANUSCRIPT_UUID_SCHEMA,
        artifact_version: { type: "integer", minimum: 1 },
        artifact_content_sha256: MANUSCRIPT_SHA256_SCHEMA,
        validation_receipt_id: MANUSCRIPT_UUID_SCHEMA,
        json_pointer_prefix: { type: "string", minLength: 2, maxLength: 2_048, pattern: "^/(?:[^~]|~[01])+$" },
        after_json_pointer: { type: "string", minLength: 2, maxLength: 2_048, pattern: "^/(?:[^~]|~[01])+$" },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
      },
      required: ["tool_call_id", "artifact_id", "artifact_version", "artifact_content_sha256", "validation_receipt_id"],
      additionalProperties: false,
    },
  },
  {
    name: "describe_statistics_capabilities",
    route: "/v1/platform/statistics/capabilities",
    description: "Read the installed statistics engine's validated coverage manifest and Figure catalog before choosing a method or visualization. It reports exact implemented boundaries, independent-oracle coverage, known gaps, renderer capabilities, and current export support so the AI cannot imply R or MATLAB parity that the installed package does not have.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        method_selection_detail: {
          type: "array",
          maxItems: 40,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 160 },
        },
      },
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
    name: "prepare_paired_statistics_table",
    route: "/v1/platform/statistics/prepare-paired-table",
    description: "Before proposing an artifact-bound confirmatory plan, deterministically full-outer-align exactly two immutable World Bank indicator artifacts by their exact string key. The output is one run-backed Data Table with both measured columns, preserved nulls, explicit per-series missing flags, a paired_eligible flag, exact parent-run/artifact lineage, a compatible reviewed model hash, method tokens, and ready-to-use declared-column source_table bindings. Pass the plan's prespecified minimum complete-pair count. The table remains visible when that threshold is not met, but readyForStatistics is false and a successor statistics plan is rejected. This tool prepares evidence and execution bindings only; it does not approve, freeze, or run an analysis plan.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        title: { type: "string", minLength: 1, maxLength: 240 },
        output_key_column: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]{0,119}$" },
        sources: {
          type: "array", minItems: 2, maxItems: 2,
          items: {
            type: "object",
            properties: {
              artifact_id: { type: "string", format: "uuid" },
              artifact_version: { type: "integer", minimum: 1 },
              content_sha256: MANUSCRIPT_SHA256_SCHEMA,
              key_column: { type: "string", minLength: 1, maxLength: 240 },
              value_column: { type: "string", minLength: 1, maxLength: 240 },
              output_column: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]{0,119}$" },
              label: { type: "string", minLength: 1, maxLength: 240 },
            },
            required: ["artifact_id", "artifact_version", "content_sha256", "key_column", "value_column", "output_column", "label"],
            additionalProperties: false,
          },
        },
        methods: { type: "array", minItems: 1, maxItems: SCIENCE_PAIRED_TABLE_METHODS.length, uniqueItems: true, items: { type: "string", enum: [...SCIENCE_PAIRED_TABLE_METHODS] } },
        model: ANALYSIS_MODEL_SCHEMA,
        minimum_complete_pairs: { type: "integer", minimum: 3, maximum: SCIENCE_TABLE_LIMITS.maxRows },
      },
      required: ["tool_call_id", "title", "output_key_column", "sources", "methods", "model", "minimum_complete_pairs"],
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
    description: "Create the first immutable version of a confirmatory analysis plan. `document` is never arbitrary JSON: it requires exactly schemaVersion,purpose,researchQuestion,population,estimand,design,data,model,missingData,multiplicity,requiredDiagnostics,sensitivityAnalyses,seed,runtimePolicy,expectedArtifacts. estimand is null or exactly {population,treatmentOrExposure,comparator,outcome,summaryMeasure,timeHorizon}. design is exactly {studyType,experimentalUnit,observationUnit,dependence}; dependence is exactly one of {kind:'unresolved'}, {kind:'independent'}, {kind:'repeated',subjectIdVariable,timeVariable}, {kind:'clustered',clusterVariables}, or {kind:'repeated-and-clustered',subjectIdVariable,timeVariable,clusterVariables}. data is exactly {inputs,acquisition,outcomeVariables,predictorVariables,transformations,exclusions}. When immutable project artifacts already exist, inputs must contain their exact camelCase {artifactId,artifactVersion,contentSha256} bindings and acquisition may be null. Before collection, inputs may be empty only when acquisition is exactly {strategy:'acquire-before-execution',sources:[{provider,sourceRefs,retrievalPlan,expectedArtifactKind}]}; sourceRefs identify the planned authoritative sources. An acquisition-only frozen plan authorizes collection, not analysis execution: after collection, propose a successor plan with exact input artifact bindings and obtain human approval again. model is null for domain-specific tools, otherwise exactly {family,formula,distribution,link,groupingVariables,randomEffects,rationale}, family lm|glm|mixed-effects|gee. expectedArtifacts items are exactly {role,title}, role result-table|figure|diagnostics|methods. If estimand or dependence is unresolved, include exactly one matching human decision draft; otherwise decisions must be empty. This creates a draft only and never records human approval or authorizes execution.",
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
    description: "Verify and bind an exact analysis plan. Under the project's existing standing analysis-plan authorization, the host validates a complete draft with no unresolved decisions, records the exact policy and plan version, and freezes it without another human checkpoint. This is a policy approval, not a human review. Without that scope, a draft requires the Science UI review. Pass the current version, content hash, and lock version; use the returned frozen receipt for subsequent work. Acquisition-only plans authorize collection only: after collection, propose and freeze a successor plan with exact immutable input artifact bindings before analysis execution.",
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
    name: "inspect_source_text_structure",
    route: "/v1/platform/source-text/structure",
    description: "Inspect the deterministic section map for one exact project SourceVersion before selecting a manuscript corpus. Returns evidence scope, parser/index hashes, stable source-section IDs, titles, word and paragraph counts. Abstract scope is reported explicitly and cannot calibrate a manuscript blueprint.",
    inputSchema: {
      type: "object", properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 }, source_id: MANUSCRIPT_UUID_SCHEMA,
        source_version_id: MANUSCRIPT_UUID_SCHEMA, source_version: { type: "integer", minimum: 1 }, source_content_sha256: MANUSCRIPT_SHA256_SCHEMA,
      }, required: ["tool_call_id", "source_id", "source_version_id", "source_version", "source_content_sha256"], additionalProperties: false,
    },
  },
  {
    name: "record_manuscript_comparable_eligibility",
    route: "/v1/platform/manuscript-comparable-eligibility/record",
    description: "Attest whether one exact, content-checked full-text SourceVersion may calibrate the target manuscript family. The Research Director must quote exact UTF-8 byte ranges for its field and article-family classification. Cross-field work may be retained only as a rhetorical analogue and can never influence quantitative corpus targets. Evaluator identity is injected from the trusted grant, never caller supplied.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        source_id: MANUSCRIPT_UUID_SCHEMA,
        expected_source_version_id: MANUSCRIPT_UUID_SCHEMA,
        expected_source_version: { type: "integer", minimum: 1 },
        expected_source_content_sha256: MANUSCRIPT_SHA256_SCHEMA,
        source_domain: SCIENCE_DOMAIN_SCHEMA,
        article_family: { type: "string", enum: ["empirical", "theoretical-proof", "review-synthesis", "methods-model", "data-resource"] },
        decision: { type: "string", enum: ["quantitative-calibration", "rhetorical-analogue-only", "ineligible"] },
        venue_relation: { type: "string", enum: ["exact-target-journal", "same-field-peer-journal", "cross-field-analogue", "incompatible"] },
        target_journal: MANUSCRIPT_BLUEPRINT_JOURNAL_SCHEMA,
        evidence: { type: "array", minItems: 1, maxItems: 20, items: MANUSCRIPT_COMPARABLE_QUOTE_LOCATOR_SCHEMA },
        rationale: { type: "string", minLength: 1, maxLength: 20_000 },
        limitations: { type: "array", maxItems: 50, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 2_000 } },
      },
      required: ["tool_call_id", "source_id", "expected_source_version_id", "expected_source_version", "expected_source_content_sha256",
        "source_domain", "article_family", "decision", "venue_relation", "target_journal", "evidence", "rationale", "limitations"],
      additionalProperties: false,
    },
  },
  {
    name: "inspect_manuscript_comparable_eligibility",
    route: "/v1/platform/manuscript-comparable-eligibility/inspect",
    description: "Read one immutable comparable-eligibility receipt and its current/stale projection. The receipt closes the project domain, exact source version, article family, venue relation, optional exact journal profile, source quotes, and trusted Research Director release used for the decision.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        eligibility_receipt_id: MANUSCRIPT_UUID_SCHEMA,
      },
      required: ["tool_call_id", "eligibility_receipt_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_manuscript_blueprints",
    route: "/v1/platform/manuscript-blueprints/list",
    description: "List the project manuscript blueprints. Each blueprint is an immutable, hash-bound calibration snapshot built only from exact full-text SourceVersions; status is re-evaluated against current source and journal versions on every read.",
    inputSchema: {
      type: "object",
      properties: { tool_call_id: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["tool_call_id"], additionalProperties: false,
    },
  },
  {
    name: "inspect_manuscript_blueprint",
    route: "/v1/platform/manuscript-blueprints/inspect",
    description: "Inspect one exact manuscript blueprint version, host-derived corpus metrics and section targets, full-text source/index hashes, journal binding, confidence, and deterministic stale reasons. This is planning evidence, not manuscript conformance or journal readiness.",
    inputSchema: {
      type: "object",
      properties: { tool_call_id: { type: "string", minLength: 1, maxLength: 160 }, blueprint_id: MANUSCRIPT_UUID_SCHEMA },
      required: ["tool_call_id", "blueprint_id"], additionalProperties: false,
    },
  },
  {
    name: "inspect_manuscript_blueprint_assessment",
    route: "/v1/platform/manuscript-blueprint-assessments/inspect",
    description: "Read the latest immutable structural assessment for a manuscript. Returns the exact manuscript, Blueprint, journal, and assessment-policy closures plus host-derived per-section observations and deterministic stale reasons. The renderer must not recompute readiness.",
    inputSchema: {
      type: "object",
      properties: { tool_call_id: { type: "string", minLength: 1, maxLength: 160 }, manuscript_id: MANUSCRIPT_UUID_SCHEMA },
      required: ["tool_call_id", "manuscript_id"], additionalProperties: false,
    },
  },
  {
    name: "record_manuscript_blueprint_assessment",
    route: "/v1/platform/manuscript-blueprint-assessments/record",
    description: "Record or reuse the immutable host-computed structural assessment for one exact current manuscript, its bound full-text Blueprint, verified journal profile, and versioned assessment policy. Callers cannot supply scores or thresholds.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 }, manuscript_id: MANUSCRIPT_UUID_SCHEMA,
        expected_manuscript_version: { type: "integer", minimum: 1 }, expected_manuscript_content_sha256: MANUSCRIPT_SHA256_SCHEMA,
        journal_profile_id: MANUSCRIPT_UUID_SCHEMA, expected_journal_profile_version: { type: "integer", minimum: 1 },
        expected_journal_profile_content_sha256: MANUSCRIPT_SHA256_SCHEMA,
      },
      required: ["tool_call_id", "manuscript_id", "expected_manuscript_version", "expected_manuscript_content_sha256", "journal_profile_id", "expected_journal_profile_version", "expected_journal_profile_content_sha256"],
      additionalProperties: false,
    },
  },
  {
    name: "inspect_manuscript_scholarly_assessment",
    route: "/v1/platform/manuscript-scholarly-assessments/inspect",
    description: "Read the latest immutable scholarly-flow assessment for one manuscript. It closes the exact manuscript, Blueprint, structural assessment, journal profile, Research Director runtime, policy, paragraph evidence spans, rhetorical moves, evidence roles, section flow, and host-derived visual coverage. Passing is manuscript-conformance evidence, not peer review or scientific truth.",
    inputSchema: {
      type: "object", properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 }, manuscript_id: MANUSCRIPT_UUID_SCHEMA,
      }, required: ["tool_call_id", "manuscript_id"], additionalProperties: false,
    },
  },
  {
    name: "record_manuscript_scholarly_assessment",
    route: "/v1/platform/manuscript-scholarly-assessments/record",
    description: "Attest whether every exact Blueprint rhetorical move, evidence role, section transition, corpus-calibrated paragraph sequence, and conditional visual expectation is actually present in one exact manuscript. Quote spans must resolve byte-for-byte inside stable paragraph nodes. Evaluator identity is injected from the trusted Research Director grant; it cannot be supplied by the caller. A blocked receipt is still recorded for diagnosis and can never satisfy submission readiness.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 }, manuscript_id: MANUSCRIPT_UUID_SCHEMA,
        expected_manuscript_version: { type: "integer", minimum: 1 }, expected_manuscript_content_sha256: MANUSCRIPT_SHA256_SCHEMA,
        expected_blueprint_assessment_id: MANUSCRIPT_UUID_SCHEMA, expected_blueprint_assessment_report_sha256: MANUSCRIPT_SHA256_SCHEMA,
        journal_profile_id: MANUSCRIPT_UUID_SCHEMA, expected_journal_profile_version: { type: "integer", minimum: 1 },
        expected_journal_profile_content_sha256: MANUSCRIPT_SHA256_SCHEMA,
        overall_confidence: { type: "number", minimum: 0, maximum: 1 },
        sections: { type: "array", minItems: 3, maxItems: 30, items: {
          type: "object", properties: {
            section_key: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,119}$" },
            heading: MANUSCRIPT_SCHOLARLY_NODE_LOCATOR_SCHEMA,
            rhetorical_moves: { type: "array", maxItems: 20, items: MANUSCRIPT_SCHOLARLY_ITEM_SCHEMA },
            evidence_role_coverage: { type: "array", maxItems: 20, items: MANUSCRIPT_SCHOLARLY_ITEM_SCHEMA },
            flow: { type: "object", properties: {
              status: { type: "string", enum: ["coherent", "partial", "broken"] },
              reader_starts_with: { type: "string", minLength: 1, maxLength: 4_000 },
              contribution: { type: "string", minLength: 1, maxLength: 4_000 },
              next_question: { type: "string", minLength: 1, maxLength: 4_000 },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              evidence: { type: "array", maxItems: 100, items: MANUSCRIPT_SCHOLARLY_QUOTE_LOCATOR_SCHEMA },
              rationale: { type: "string", minLength: 1, maxLength: 8_000 },
            }, required: ["status", "reader_starts_with", "contribution", "next_question", "confidence", "evidence", "rationale"], additionalProperties: false },
          }, required: ["section_key", "heading", "rhetorical_moves", "evidence_role_coverage", "flow"], additionalProperties: false,
        } },
        summary: { type: "string", minLength: 1, maxLength: 20_000 },
        limitations: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 4_000 } },
      },
      required: ["tool_call_id", "manuscript_id", "expected_manuscript_version", "expected_manuscript_content_sha256",
        "expected_blueprint_assessment_id", "expected_blueprint_assessment_report_sha256", "journal_profile_id",
        "expected_journal_profile_version", "expected_journal_profile_content_sha256", "overall_confidence", "sections", "summary", "limitations"],
      additionalProperties: false,
    },
  },
  {
    name: "prepare_manuscript_coherence_context",
    route: "/v1/platform/manuscript-coherence/prepare-context",
    description: "Prepare the exact current manuscript-coherence context from durable host state. The host revalidates the manuscript, claim-ledger gate, per-claim evidence signatures, visual nodes, artifact validation receipts, and run-output closure. Callers cannot supply or repair context facts.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        manuscript_id: MANUSCRIPT_UUID_SCHEMA,
        expected_manuscript_version: { type: "integer", minimum: 1 },
        expected_manuscript_content_sha256: MANUSCRIPT_SHA256_SCHEMA,
      },
      required: ["tool_call_id", "manuscript_id", "expected_manuscript_version", "expected_manuscript_content_sha256"],
      additionalProperties: false,
    },
  },
  {
    name: "inspect_manuscript_coherence_assessment",
    route: "/v1/platform/manuscript-coherence/inspect",
    description: "Read the latest immutable manuscript-coherence receipt with its host-revalidated current or stale projection. Missing, advanced, or tampered manuscript and claim-ledger closures fail closed; a passing receipt proves bounded linkage and numeric/visual consistency, not scientific truth.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        manuscript_id: MANUSCRIPT_UUID_SCHEMA,
      },
      required: ["tool_call_id", "manuscript_id"],
      additionalProperties: false,
    },
  },
  {
    name: "record_manuscript_coherence_assessment",
    route: "/v1/platform/manuscript-coherence/record",
    description: "Record or reuse an immutable host-evaluated coherence receipt for one exact manuscript and claim-ledger head. Supply semantic claim links and exact numeric quote declarations only; all manuscript, section, evidence, visual, artifact, receipt, and run-output facts are rebuilt inside the host transaction. Blocked receipts are retained for diagnosis and cannot satisfy submission readiness.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        manuscript_id: MANUSCRIPT_UUID_SCHEMA,
        expected_manuscript_version: { type: "integer", minimum: 1 },
        expected_manuscript_content_sha256: MANUSCRIPT_SHA256_SCHEMA,
        expected_claim_ledger_id: MANUSCRIPT_UUID_SCHEMA,
        expected_claim_ledger_revision: { type: "integer", minimum: 1 },
        expected_claim_ledger_manifest_sha256: MANUSCRIPT_SHA256_SCHEMA,
        expected_claim_ledger_gate_report_sha256: MANUSCRIPT_SHA256_SCHEMA,
        expected_claim_ledger_policy_content_sha256: MANUSCRIPT_SHA256_SCHEMA,
        ...MANUSCRIPT_COHERENCE_DECLARATIONS_SCHEMA,
      },
      required: [
        "tool_call_id", "manuscript_id", "expected_manuscript_version", "expected_manuscript_content_sha256",
        "expected_claim_ledger_id", "expected_claim_ledger_revision", "expected_claim_ledger_manifest_sha256",
        "expected_claim_ledger_gate_report_sha256", "expected_claim_ledger_policy_content_sha256", "summary_claim_links",
        "results_discussion_links", "numeric_assertions", "numeric_exemptions",
      ],
      additionalProperties: false,
    },
  },
  {
    name: "create_manuscript_blueprint",
    route: "/v1/platform/manuscript-blueprints/create",
    description: "Create the first immutable manuscript blueprint before drafting prose. Supply 1-20 exact current full-text SourceVersions and rhetorical section jobs. One to four sources remain collecting; five or more permit a current corpus calibration. The host measures the complete indexed article body, verifies complete section coverage, recomputes targets, and forbids caller-supplied thresholds.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 }, title: { type: "string", minLength: 1, maxLength: 500 },
        article_family: { type: "string", enum: ["empirical", "theoretical-proof", "review-synthesis", "methods-model", "data-resource"] },
        comparables: { type: "array", minItems: 1, maxItems: 20, items: MANUSCRIPT_BLUEPRINT_COMPARABLE_SCHEMA },
        journal_binding: MANUSCRIPT_BLUEPRINT_JOURNAL_SCHEMA,
        sections: { type: "array", minItems: 3, maxItems: 30, items: MANUSCRIPT_BLUEPRINT_SECTION_SCHEMA },
        planning_rationale: { type: "string", minLength: 1, maxLength: 20000 },
        limitations: { type: "array", maxItems: 50, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 2000 } },
      },
      required: ["tool_call_id", "title", "article_family", "comparables", "journal_binding", "sections", "planning_rationale", "limitations"],
      additionalProperties: false,
    },
  },
  {
    name: "revise_manuscript_blueprint",
    route: "/v1/platform/manuscript-blueprints/append-version",
    description: "Append a new immutable blueprint version using exact optimistic concurrency. Use this when the comparable corpus, article family, section plan, or target journal changes; ordinary prose edits do not rewrite the blueprint.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 }, blueprint_id: MANUSCRIPT_UUID_SCHEMA,
        expected_version: { type: "integer", minimum: 1 }, expected_content_sha256: MANUSCRIPT_SHA256_SCHEMA,
        article_family: { type: "string", enum: ["empirical", "theoretical-proof", "review-synthesis", "methods-model", "data-resource"] },
        comparables: { type: "array", minItems: 1, maxItems: 20, items: MANUSCRIPT_BLUEPRINT_COMPARABLE_SCHEMA },
        journal_binding: MANUSCRIPT_BLUEPRINT_JOURNAL_SCHEMA,
        sections: { type: "array", minItems: 3, maxItems: 30, items: MANUSCRIPT_BLUEPRINT_SECTION_SCHEMA },
        planning_rationale: { type: "string", minLength: 1, maxLength: 20000 },
        limitations: { type: "array", maxItems: 50, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 2000 } },
      },
      required: ["tool_call_id", "blueprint_id", "expected_version", "expected_content_sha256", "article_family", "comparables", "journal_binding", "sections", "planning_rationale", "limitations"],
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
    description: "Read one exact current manuscript version, including its stable-ID structured document, Markdown projection, integrity hashes, identity epoch, evidence bindings, and a deterministic anti-stub depth preflight. Use the returned version plus content and document hashes as concurrency preconditions; never infer node identity from Markdown offsets. A passing anti-stub preflight is not journal readiness: compare it with the full-text corpus blueprint and verified journal profile.",
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
    name: "inspect_science_manuscript_editor_model",
    route: "/v1/platform/manuscripts/editor-model",
    description: "Read the exact current stable-ID manuscript editor model for this granted project. Returns the immutable document snapshot, current manuscript hashes, recent append-only transactions, and undo availability. This is read-only and is the authoritative source for node-level edit preconditions.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        manuscript_id: { type: "string", minLength: 1, maxLength: 80 },
      },
      required: ["tool_call_id", "manuscript_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_science_manuscript_transactions",
    route: "/v1/platform/manuscripts/transactions",
    description: "List the bounded append-only transaction history for one manuscript in this granted project. Returns exact operation, version, content-hash, document-hash, actor, and revert lineage; it never reconstructs edits from prose or Markdown diffs.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        manuscript_id: { type: "string", minLength: 1, maxLength: 80 },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      required: ["tool_call_id", "manuscript_id"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_science_manuscript_edit",
    route: "/v1/platform/manuscripts/edit-proposals/create",
    description: "Persist an assistant-authored preview against one exact manuscript version and stable-ID document. This does not mutate the manuscript: the runtime validates every node/anchor CAS field, applies the operations in memory, and returns the complete preview plus hashes for human review. Exact selection-context ids may ground a request such as 'rewrite this passage'.",
    inputSchema: {
      $defs: MANUSCRIPT_SCHEMA_DEFS,
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        manuscript_id: { type: "string", minLength: 1, maxLength: 80 },
        expected_version: { type: "integer", minimum: 1 },
        expected_content_sha256: MANUSCRIPT_SHA256_SCHEMA,
        expected_document_sha256: MANUSCRIPT_SHA256_SCHEMA,
        operations: { type: "array", minItems: 1, maxItems: 1_000, items: MANUSCRIPT_OPERATION_SCHEMA },
        summary: { type: "string", minLength: 1, maxLength: 1_000 },
        rationale: { type: "string", minLength: 1, maxLength: 20_000 },
        selection_context_ids: MANUSCRIPT_SELECTION_CONTEXT_REFS_SCHEMA,
      },
      required: ["tool_call_id", "manuscript_id", "expected_version", "expected_content_sha256", "expected_document_sha256", "operations", "summary", "rationale"],
      additionalProperties: false,
    },
  },
  {
    name: "list_science_manuscript_edit_proposals",
    route: "/v1/platform/manuscripts/edit-proposals/list",
    description: "List bounded assistant edit proposals for one manuscript in this granted project. Each read reprojects pending versus stale from the exact current manuscript head and returns immutable preview, selection, payload-hash, and decision lineage.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        manuscript_id: { type: "string", minLength: 1, maxLength: 80 },
        statuses: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: { type: "string", enum: ["pending", "stale", "applied", "rejected"] } },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      required: ["tool_call_id", "manuscript_id"],
      additionalProperties: false,
    },
  },
  {
    name: "apply_science_manuscript_edit_proposal",
    route: "/v1/platform/manuscripts/edit-proposals/apply",
    description: "Apply one exact reviewed pending proposal as the manuscript's single atomic assistant transaction. This mutates the manuscript and records an immutable applied decision; it fails closed if the manuscript version, content hash, document hash, proposal payload, node CAS, artifact validation receipt, or project scope is stale.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        manuscript_id: { type: "string", minLength: 1, maxLength: 80 },
        proposal_id: MANUSCRIPT_UUID_SCHEMA,
        expected_version: { type: "integer", minimum: 1 },
        expected_content_sha256: MANUSCRIPT_SHA256_SCHEMA,
        expected_document_sha256: MANUSCRIPT_SHA256_SCHEMA,
      },
      required: ["tool_call_id", "manuscript_id", "proposal_id", "expected_version", "expected_content_sha256", "expected_document_sha256"],
      additionalProperties: false,
    },
  },
  {
    name: "reject_science_manuscript_edit_proposal",
    route: "/v1/platform/manuscripts/edit-proposals/reject",
    description: "Reject one exact pending or stale assistant proposal without changing manuscript content. This records an immutable rejection decision and reason; applied or already rejected proposals cannot be decided again.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        manuscript_id: { type: "string", minLength: 1, maxLength: 80 },
        proposal_id: MANUSCRIPT_UUID_SCHEMA,
        reason: { type: ["string", "null"], maxLength: 4_000 },
      },
      required: ["tool_call_id", "manuscript_id", "proposal_id", "reason"],
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
    name: "seal_manuscript_claim_ledger",
    route: "/v1/platform/claim-ledgers/seal",
    description: "Create revision 1 of a manuscript claim ledger from explicit per-sentence classifications. Every canonical manuscript sentence returned by prepare_manuscript_claim_context must be classified; omission fails closed instead of silently treating a sentence as non-factual. A supported sentence must name snapshotted evidence. Supported method/result sentences must use evidence_assessments to pair a citation with a passed artifact validation receipt and state evidence direction, relevance, and assessment confidence. The runtime derives and seals exact artifact versions and hashes.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        manuscript_id: { type: "string" },
        expected_manuscript_version: { type: "integer", minimum: 1 },
        expected_manuscript_content_sha256: { type: "string" },
        citation_ids: { type: "array", items: { type: "string" }, maxItems: 500 },
        validation_receipt_ids: { type: "array", items: { type: "string" }, maxItems: 500 },
        classifications: {
          type: "array",
          maxItems: 5_000,
          items: {
            type: "object",
            properties: {
              sentence_id: { type: "string" },
              claim_class: { type: "string", enum: [...SCIENCE_CLAIM_CLASSES] },
              status: { type: "string", enum: [...SCIENCE_CLAIM_STATUSES] },
              evidence_citation_ids: { type: "array", items: { type: "string" }, maxItems: 100 },
              evidence_assessments: {
                type: "array",
                maxItems: 100,
                items: {
                  type: "object",
                  properties: {
                    citation_id: { type: "string" },
                    validation_receipt_id: { type: ["string", "null"] },
                    direction: { type: "string", enum: ["support", "contradict", "qualify"] },
                    relevance: { type: "number", minimum: 0, maximum: 1 },
                    assessment_confidence: { type: "number", minimum: 0, maximum: 1 },
                  },
                  required: ["citation_id", "direction", "relevance", "assessment_confidence"],
                  additionalProperties: false,
                },
              },
            },
            required: ["sentence_id", "claim_class", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["tool_call_id", "manuscript_id", "expected_manuscript_version", "expected_manuscript_content_sha256", "classifications"],
      additionalProperties: false,
    },
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
    name: "start_manuscript_drafting_session",
    route: "/v1/platform/manuscript-drafting/start",
    description: "Start a durable Blueprint-bound long-form drafting session. The host derives the exact ordered section plan and corpus-calibrated word/paragraph targets. Use this for a real full manuscript instead of trying to emit the entire paper in one model response.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        title: { type: "string", minLength: 1, maxLength: 500 },
        bindings: { type: "array", maxItems: 10000, items: MANUSCRIPT_BINDING_SCHEMA },
        blueprint_binding: MANUSCRIPT_BLUEPRINT_BINDING_SCHEMA,
      },
      required: ["tool_call_id", "title", "bindings", "blueprint_binding"],
      additionalProperties: false,
    },
  },
  {
    name: "inspect_manuscript_drafting_session",
    route: "/v1/platform/manuscript-drafting/inspect",
    description: "Inspect exact durable progress for a long-form manuscript drafting session, including the Blueprint-derived plan, current immutable section revisions, readiness, optimistic version, and state hash. Call this after restart or before every section save.",
    inputSchema: { type: "object", properties: {
      tool_call_id: { type: "string", minLength: 1, maxLength: 160 }, session_id: MANUSCRIPT_UUID_SCHEMA,
    }, required: ["tool_call_id", "session_id"], additionalProperties: false },
  },
  {
    name: "save_manuscript_section_draft",
    route: "/v1/platform/manuscript-drafting/save-section",
    description: "Append one immutable body-only section revision to a durable long-form drafting session. Supply the exact latest session version and state hash. The host measures words and substantive paragraphs against the sealed Blueprint target and reports draft or ready; Abstract is accepted only after every required body section has a revision.",
    inputSchema: { type: "object", properties: {
      tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
      session_id: MANUSCRIPT_UUID_SCHEMA,
      expected_version: { type: "integer", minimum: 1 },
      expected_state_sha256: MANUSCRIPT_SHA256_SCHEMA,
      section_key: { type: "string", minLength: 1, maxLength: 120 },
      markdown: { type: "string", minLength: 1, maxLength: 2000000 },
    }, required: ["tool_call_id", "session_id", "expected_version", "expected_state_sha256", "section_key", "markdown"], additionalProperties: false },
  },
  {
    name: "assemble_manuscript_drafting_session",
    route: "/v1/platform/manuscript-drafting/assemble",
    description: "Deterministically assemble the latest ready section revisions in Blueprint order and create manuscript v1. Assembly rechecks the exact current Blueprint and the whole-document anti-stub, section-depth, paragraph-flow, total-length, and duplicate-padding gates. Any incomplete or stale session fails closed.",
    inputSchema: { type: "object", properties: {
      tool_call_id: { type: "string", minLength: 1, maxLength: 160 }, session_id: MANUSCRIPT_UUID_SCHEMA,
      expected_version: { type: "integer", minimum: 1 }, expected_state_sha256: MANUSCRIPT_SHA256_SCHEMA,
    }, required: ["tool_call_id", "session_id", "expected_version", "expected_state_sha256"], additionalProperties: false },
  },
  {
    name: "cancel_manuscript_drafting_session",
    route: "/v1/platform/manuscript-drafting/cancel",
    description: "Irreversibly cancel one still-drafting session with exact optimistic concurrency. Existing immutable section revisions remain available for audit but can never be assembled by this session.",
    inputSchema: { type: "object", properties: {
      tool_call_id: { type: "string", minLength: 1, maxLength: 160 }, session_id: MANUSCRIPT_UUID_SCHEMA,
      expected_version: { type: "integer", minimum: 1 }, expected_state_sha256: MANUSCRIPT_SHA256_SCHEMA,
      reason: { type: "string", minLength: 1, maxLength: 4000 },
    }, required: ["tool_call_id", "session_id", "expected_version", "expected_state_sha256", "reason"], additionalProperties: false },
  },
  {
    name: "create_science_manuscript",
    route: "/v1/platform/manuscripts/create",
    description: "Compatibility/import boundary for an already complete external full draft. New Research Director long-form papers must use start_manuscript_drafting_session, immutable section saves, and assemble_manuscript_drafting_session so generation can resume across model turns. An outline, one-line demonstration, collecting Blueprint, missing required section, or draft grossly below the comparable full-text corpus is rejected.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        title: { type: "string", minLength: 1, maxLength: 500 },
        markdown: { type: "string", minLength: 1, maxLength: 2000000 },
        bindings: { type: "array", maxItems: 10000, items: MANUSCRIPT_BINDING_SCHEMA },
        blueprint_binding: MANUSCRIPT_BLUEPRINT_BINDING_SCHEMA,
      },
      required: ["tool_call_id", "title", "markdown", "bindings", "blueprint_binding"],
      additionalProperties: false,
    },
  },
  {
    name: "save_science_manuscript_version",
    route: "/v1/platform/manuscripts/append-version",
    description: "Append a new immutable full-draft version with optimistic concurrency. The exact current Blueprint binding is inherited unless an exact current replacement is supplied; an outline, one-line replacement, missing required section, or draft grossly below its comparable full-text corpus is rejected. Supply the exact current version, content hash, complete Markdown, and complete binding manifest returned by inspect_science_manuscript.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 },
        manuscript_id: { type: "string" },
        expected_version: { type: "integer", minimum: 1 },
        expected_content_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        markdown: { type: "string", minLength: 1, maxLength: 2000000 },
        bindings: { type: "array", maxItems: 10000, items: MANUSCRIPT_BINDING_SCHEMA },
        blueprint_binding: MANUSCRIPT_BLUEPRINT_BINDING_SCHEMA,
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
    name: "render_science_manuscript",
    route: "/v1/platform/manuscripts/render",
    description: "Render an exact stored manuscript version into the full paper: numbered figures embedded from verified captures/vector exports, editable tables built from exact artifact rows, numbered equations, formatted references (numeric, APA, or Nature style) with a BibTeX file, and author/affiliation front matter. Writes manuscript.html, manuscript.tex, references.bib, manuscript.docx, and manuscript.pdf (LaTeX via tectonic when installed, otherwise Chromium print, reported honestly) under the project's manuscript-renders directory and returns the numbering report plus every warning (unbound placeholders, unresolved references, missing assets). Use it before claiming a manuscript is complete and after every manuscript edit.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string", minLength: 1, maxLength: 160 }, manuscript_id: { type: "string" },
        style: { type: "string", enum: ["numeric", "apa", "nature"] }, line_numbers: { type: "boolean" }, double_spacing: { type: "boolean" },
        outputs: { type: "array", minItems: 1, maxItems: 5, uniqueItems: true, items: { type: "string", enum: ["html", "latex", "docx", "pdf", "package"] } },
        metadata: SUBMISSION_METADATA_SCHEMA,
      },
      required: ["tool_call_id", "manuscript_id"], additionalProperties: false,
    },
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

const SCIENCE_EXTENSION_REQUIRED_PLATFORM_TOOL_NAMES = [
  "build_comparative_genomics_gene_tree",
  "build_extant_reference_assembly_manifest",
  "materialize_extant_archosaur_locus_panel",
] as const;

export function scienceDesktopHostCompatibilitySnapshot(): ScienceDesktopHostCompatibilitySnapshot {
  const byName = new Map(PLATFORM_TOOLS.map((tool) => [tool.name, tool]));
  return {
    apiName: SCIENCE_DESKTOP_HOST_API_NAME,
    apiVersion: SCIENCE_DESKTOP_HOST_API_VERSION,
    platformTools: SCIENCE_EXTENSION_REQUIRED_PLATFORM_TOOL_NAMES.map((name) => {
      const tool = byName.get(name);
      if (!tool) throw new Error("science-desktop-host-contract-tool-missing");
      return { name: tool.name, route: tool.route, inputSchemaSha256: scienceExtensionHostCompatibilitySha256(tool.inputSchema) };
    }),
  };
}

const IMPLEMENTED_TOOL_IDS = new Set([
  "agentlas.earth-aftershock-table-study",
  "agentlas.earth-gutenberg-richter-analysis",
  "agentlas.physics-hepdata-chi-square-analysis",
  "agentlas.physics-spectrum-fit-analysis",
  "agentlas.physics-significance-limits-analysis",
  "agentlas.physics-uncertainty-propagation-analysis",
  "agentlas.physics-unit-analysis",
  "agentlas.physics-ode-simulation-analysis",
  "agentlas.physics-signal-analysis",
  "agentlas.physics-york-fit-analysis",
  "agentlas.physics-lab-experiment-analysis",
  "agentlas.materials-lattice-metrics-analysis",
  "agentlas.paleontology-stratigraphic-support",
  "agentlas.paleontology-candidate-comparison",
  "agentlas.paleontology-deextinction-feasibility",
  "agentlas.statistics-analysis",
  "agentlas.table-to-vega",
  "agentlas.academic-to-citation-network",
  "agentlas.astronomy-to-sky-map",
  "agentlas.astronomy-light-curve-periodicity",
  "agentlas.astronomy-light-curve-periodicity-depth",
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


/**
 * Attach the study's standing to a tool result.
 *
 * Additive and defensive: a non-object result, a failed result, or one that already carries this is
 * returned untouched, and a store that cannot answer is not allowed to turn a successful tool call
 * into an error.
 */

/**
 * A decision the RESEARCHER still owes at this phase, or null.
 *
 * Only `hypothesis` has one beyond the contract today: the gate out of it refuses any hypothesis
 * still `proposed`, and only a person can approve one. Reading it here rather than assuming keeps
 * the answer true for a project whose hypotheses are already approved.
 */

/** Column names and types for a Data Table artifact version, or null when it is not one. */
export function dataTableShape(payload: unknown): { columns: Array<{ name: string; logicalType: string; nullable: boolean }>; rowCount: number } | null {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  if (!record || record.schema !== "agentlas.science-table/v1" || !Array.isArray(record.columns)
    || record.columns.length < 1 || record.columns.length > 512 || !Array.isArray(record.rows)) return null;
  const columns = record.columns as Array<Record<string, unknown>>;
  const rows = record.rows as unknown[];
  if (columns.some((column) => !column || typeof column !== "object" || Array.isArray(column))) return null;
  const domainShape = columns.some((column) => column?.id !== undefined) || rows.some(Array.isArray);
  if (domainShape) {
    const normalized = columns.map((column, index) => {
      const name = typeof column?.id === "string" ? column.id.trim() : "";
      const logicalType = String(column?.type ?? "").toLowerCase();
      if (!name || !["integer", "number", "boolean", "string"].includes(logicalType)) return null;
      const nullable = rows.some((row) => Array.isArray(row) && (row[index] === null || row[index] === undefined));
      return { name, logicalType, nullable };
    });
    if (normalized.some((column) => !column)
      || new Set(normalized.map((column) => column!.name.toLocaleLowerCase("en-US"))).size !== normalized.length
      || rows.some((row) => !Array.isArray(row) || row.length !== normalized.length
        || row.some((value, index) => value !== null && value !== undefined
          && ((normalized[index]!.logicalType === "integer" && (typeof value !== "number" || !Number.isSafeInteger(value)))
            || (normalized[index]!.logicalType === "number" && (typeof value !== "number" || !Number.isFinite(value)))
            || (normalized[index]!.logicalType === "boolean" && typeof value !== "boolean")
            || (normalized[index]!.logicalType === "string" && typeof value !== "string"))))) return null;
    return { columns: normalized as Array<{ name: string; logicalType: string; nullable: boolean }>, rowCount: rows.length };
  }
  const profile = record.profile && typeof record.profile === "object" ? record.profile as Record<string, unknown> : null;
  const normalized = columns.map((column) => ({
    name: String(column.name ?? "").trim(),
    logicalType: String(column.logicalType ?? "").toLowerCase(),
    nullable: Boolean(column.nullable),
  }));
  if (!profile || !Number.isSafeInteger(profile.rowCount) || profile.rowCount !== rows.length
    || normalized.some((column) => !column.name || !["integer", "number", "boolean", "string"].includes(column.logicalType))
    || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) return null;
  return {
    columns: normalized,
    rowCount: Number(profile.rowCount ?? rows.length),
  };
}


/**
 * The tool speaks snake_case and the gateway speaks camelCase; only one key differs, and leaving it
 * unmapped would silently drop the upper label of a derived cut -- every row would land in one group
 * and the comparison would look real.
 */
function normalizeTablePreparation(value: unknown): unknown {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!record) return value;
  const derive = record.derive && typeof record.derive === "object" ? { ...record.derive as Record<string, unknown> } : null;
  if (derive && derive.at_or_above !== undefined) {
    derive.atOrAbove = derive.at_or_above;
    delete derive.at_or_above;
  }
  return { ...record, ...(derive ? { derive } : {}) };
}

/**
 * The decision this phase is waiting on a person for, or null when the director may proceed alone.
 *
 * Four decisions in this product are reserved for a human: approving the research contract,
 * deciding a hypothesis, confirming the journal's identity, and signing the submission
 * attestation. The contract one is answered upstream by the contract's own state; the other three
 * belong here. Only `hypothesis` was covered, so a study that got as far as choosing a journal
 * fell into the same hole the hypothesis gate used to have -- the gate refuses, the refusal names
 * no remedy, and the director retries it instead of stopping to ask. Measured before: two turns
 * burned against a locked door. One entry per phase removes that wall for the whole back half of
 * the lifecycle.
 */
export function pendingResearcherDecisionFor(store: ReturnType<typeof scienceStore>, projectId: string, phase: string | null) {
  try {
    if (phase === "hypothesis") {
      const manifest = store.currentHypothesisManifest(projectId);
      const unapproved = manifest.hypotheses.filter((item) => item.status !== "approved").length;
      return unapproved > 0 ? { what: "hypotheses", count: unapproved } : null;
    }
    if (phase === "journal_profile") {
      // A profile becomes verified only once a person has confirmed the journal is the real one.
      // Profiles the director drafted but nobody vouched for are exactly the waiting state; no
      // profile at all is the director's own work, not the researcher's, so it is not reported here.
      const profiles = store.listJournalProfiles(projectId, 100);
      const unconfirmed = profiles.filter((profile) => !profile.version.identityReceiptId).length;
      return unconfirmed > 0 ? { what: "journal identity confirmations", count: unconfirmed } : null;
    }
    if (phase === "submission_validation") {
      // The attestation is made in the researcher's name to a publisher, so the export refuses
      // without one. Zero unconsumed receipts means the signature has not been given yet.
      return store.countUnconsumedJournalHumanAttestations(projectId) === 0
        ? { what: "submission attestations", count: 1 }
        : null;
    }
    return null;
  } catch {
    return null;
  }
}

function withStudyProgress(result: unknown, projectId: string): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  if (record.ok !== true || record.studyProgress !== undefined) return result;
  try {
    const store = scienceStore();
    const lifecycle = store.getResearchLifecycleForProject(projectId);
    const contract = store.latestResearchContract(projectId);
    return { ...record, studyProgress: scienceStudyProgress({
      phase: lifecycle?.phase ?? null,
      contract,
      approvedTermsSha256: store.approvedResearchContractSha256(projectId),
      nextGate: lifecycle?.phase ? scienceNextResearchPhaseGate(lifecycle.phase) : null,
      pendingResearcherDecision: pendingResearcherDecisionFor(store, projectId, lifecycle?.phase ?? null),
    }) };
  } catch {
    return result;
  }
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

function localJsonSchemaRef(rootSchemaValue: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) return null;
  let current: unknown = rootSchemaValue;
  for (const encoded of ref.slice(2).split("/")) {
    const key = encoded.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (!current || typeof current !== "object" || Array.isArray(current)
      || !Object.prototype.hasOwnProperty.call(current, key)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function schemaTypeMatches(value: unknown, type: unknown): boolean {
  if (Array.isArray(type)) return type.some((candidate) => schemaTypeMatches(value, candidate));
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  return true;
}

function schemaValueEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertExactToolInputSchema(
  value: unknown,
  schemaValue: unknown,
  code: string,
  rootSchemaValue: unknown = schemaValue,
  path = "$",
): void {
  if (!schemaValue || typeof schemaValue !== "object" || Array.isArray(schemaValue)) return;
  const schema = schemaValue as Record<string, unknown>;
  if (typeof schema.$ref === "string") {
    const resolved = localJsonSchemaRef(rootSchemaValue, schema.$ref);
    if (!resolved) throw new Error(code);
    assertExactToolInputSchema(value, resolved, code, rootSchemaValue, path);
    return;
  }
  if (schema.type !== undefined && !schemaTypeMatches(value, schema.type)) throw new Error(code);
  if (Object.prototype.hasOwnProperty.call(schema, "const") && !schemaValueEquals(value, schema.const)) throw new Error(code);
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => schemaValueEquals(value, candidate))) throw new Error(code);

  const alternativesMatch = (candidate: unknown): boolean => {
    try {
      assertExactToolInputSchema(value, candidate, code, rootSchemaValue, path);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === code) return false;
      throw error;
    }
  };
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter(alternativesMatch).length !== 1) throw new Error(code);
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(alternativesMatch)) throw new Error(code);
  if (Array.isArray(schema.allOf)) {
    for (const candidate of schema.allOf) assertExactToolInputSchema(value, candidate, code, rootSchemaValue, path);
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) throw new Error(code);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) throw new Error(code);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) throw new Error(code);
    if (schema.format === "uuid" && !TOOL_UUID_RE.test(value)) throw new Error(code);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) throw new Error(code);
    if (typeof schema.maximum === "number" && value > schema.maximum) throw new Error(code);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) throw new Error(code);
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) throw new Error(code);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) throw new Error(code);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) throw new Error(code);
    if (schema.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) throw new Error(code);
    if (schema.items !== undefined) {
      for (const [index, item] of value.entries()) assertExactToolInputSchema(item, schema.items, code, rootSchemaValue, `${path}[${index}]`);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, unknown>
    : null;
  const recordValue = value as Record<string, unknown>;
  if (Array.isArray(schema.required) && schema.required.some((key) => typeof key !== "string" || !Object.prototype.hasOwnProperty.call(recordValue, key))) {
    throw new Error(code);
  }
  if (schema.additionalProperties === false) {
    const unexpectedProperty = Object.keys(value).find((key) => !properties || !Object.prototype.hasOwnProperty.call(properties, key));
    if (unexpectedProperty) throw new ToolInputSchemaError(code, path, unexpectedProperty, properties ? Object.keys(properties) : []);
  }
  if (properties) {
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(recordValue, key)) {
        assertExactToolInputSchema(recordValue[key], propertySchema, code, rootSchemaValue, `${path}.${key}`);
      }
    }
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object" && properties) {
    for (const [key, nested] of Object.entries(recordValue)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        assertExactToolInputSchema(nested, schema.additionalProperties, code, rootSchemaValue, `${path}.${key}`);
      }
    }
  }
}

class ToolInputSchemaError extends Error {
  constructor(
    code: string,
    readonly path: string,
    readonly unexpectedProperty: string,
    readonly allowedProperties: string[],
  ) {
    super(code);
    this.name = "ToolInputSchemaError";
  }
}

function scienceToolErrorPayload(route: string, error: unknown): Record<string, unknown> {
  const code = error instanceof Error ? error.message.slice(0, 240) : "science-tool-control-failed";
  if (route === "/v1/platform/genomics/extant-reference-assemblies" && error instanceof ScienceExtantReferenceAssemblyHttpError) {
    return { ok: false, code, failureReceipt: error.failureReceipt };
  }
  if (route === "/v1/platform/genomics/comparative-gene-tree" && error instanceof ScienceComparativeGenomicsProviderValidationError) {
    return { ok: false, code, failureReceipt: error.failureReceipt };
  }
  if (route === "/v1/platform/analysis-plans/propose") {
    if (code === "science-analysis-dependence-invalid"
      || (error instanceof ToolInputSchemaError && error.path === "$.document.design.dependence")) {
      return {
        ok: false, code, path: "$.document.design.dependence",
        unexpectedProperty: error instanceof ToolInputSchemaError ? error.unexpectedProperty : null,
        allowedProperties: ["kind", "subjectIdVariable", "timeVariable", "clusterVariables"],
        allowedValues: ["unresolved", "independent", "repeated", "clustered", "repeated-and-clustered"],
      };
    }
    if (code === "science-analysis-model-invalid"
      || (error instanceof ToolInputSchemaError && error.path === "$.document.model")) {
      return {
        ok: false, code, path: "$.document.model",
        unexpectedProperty: error instanceof ToolInputSchemaError ? error.unexpectedProperty : null,
        allowedProperties: ["family", "formula", "distribution", "link", "groupingVariables", "randomEffects", "rationale"],
        allowedValues: ["lm", "glm", "mixed-effects", "gee", null],
        guidance: "Use null for a domain-specific analysis tool.",
      };
    }
    if (code === "science-analysis-expected-artifact-invalid"
      || (error instanceof ToolInputSchemaError && error.path.startsWith("$.document.expectedArtifacts["))) {
      return {
        ok: false, code, path: "$.document.expectedArtifacts[*]",
        unexpectedProperty: error instanceof ToolInputSchemaError ? error.unexpectedProperty : null,
        allowedProperties: ["role", "title"],
        allowedValues: ["result-table", "figure", "diagnostics", "methods"],
      };
    }
  }
  if (error instanceof ToolInputSchemaError) {
    return { ok: false, code, path: error.path, unexpectedProperty: error.unexpectedProperty, allowedProperties: error.allowedProperties };
  }
  return { ok: false, code };
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

function extantReferenceAssemblyResultRecord(result: Awaited<ReturnType<ReturnType<typeof scienceExtantReferenceAssemblyService>["build"]>>): Record<string, unknown> {
  return {
    ok: true,
    schema: "agentlas.science-extant-reference-assembly-mcp-result/v1",
    provider: result.provider,
    providerRelease: result.assessment.providerRelease,
    assemblies: result.assessment.assemblies,
    evidenceBoundary: result.assessment.evidenceBoundary,
    warnings: result.assessment.warnings,
    publicationTable: result.assessment.publicationTable,
    run: { id: result.runId, status: "succeeded" },
    artifact: {
      id: result.artifact.id,
      version: result.artifact.version.version,
      currentVersion: result.artifact.currentVersion,
      kind: result.artifact.kind,
      title: result.artifact.title,
      contentSha256: result.artifact.version.contentSha256,
      labId: "comparative-genomics",
    },
    sources: result.sources,
    retrievedAt: result.retrievedAt,
    replayed: result.replayed,
  };
}

function comparativeGenomicsResultRecord(result: Awaited<ReturnType<ReturnType<typeof scienceComparativeGenomicsService>["build"]>>): Record<string, unknown> {
  return {
    ok: true,
    schema: "agentlas.science-comparative-genomics-mcp-result/v1",
    provider: result.provider,
    providerRelease: result.assessment.providerRelease,
    geneTreeId: result.assessment.geneTreeId,
    targetNode: result.assessment.targetNode,
    diagnostics: result.assessment.diagnostics,
    alignment: result.assessment.alignment,
    evidenceBoundary: result.assessment.evidenceBoundary,
    warnings: result.assessment.warnings,
    publicationTable: result.assessment.publicationTable,
    run: { id: result.runId, status: "succeeded" },
    artifact: {
      id: result.artifact.id,
      version: result.artifact.version.version,
      currentVersion: result.artifact.currentVersion,
      kind: result.artifact.kind,
      title: result.artifact.title,
      contentSha256: result.artifact.version.contentSha256,
      labId: "comparative-genomics",
    },
    sources: [
      { id: result.releaseSourceId, versionId: result.releaseSourceVersionId, sha256: result.releaseResponseSha256, url: result.releaseEndpoint },
      { id: result.treeSourceId, versionId: result.treeSourceVersionId, sha256: result.treeResponseSha256, url: result.treeEndpoint },
    ],
    retrievedAt: result.retrievedAt,
    replayed: result.replayed,
  };
}

function dinosaurComparativeRouteMetadata(
  assessment: Awaited<ReturnType<ReturnType<typeof scienceComparativeGenomicsService>["build"]>>["assessment"],
  grant: Grant,
): Record<string, unknown> | null {
  if (grant.context.workflowRoute !== "dinosaur-comparative-proxy") return null;
  const nodes = Array.isArray(assessment.nodes) ? assessment.nodes : [];
  const nodeById = new Map(nodes.map((node) => [String(node.nodeId), node]));
  const isUnder = (nodeId: string, predicate: (node: Record<string, unknown>) => boolean): boolean => {
    const seen = new Set<string>();
    let current = nodeById.get(nodeId);
    while (current && !seen.has(String(current.nodeId))) {
      seen.add(String(current.nodeId));
      if (predicate(current)) return true;
      current = current.parentId === null ? undefined : nodeById.get(String(current.parentId));
    }
    return false;
  };
  const avian = [] as string[];
  const crocodilian = [] as string[];
  for (const rawLeaf of Array.isArray(assessment.leaves) ? assessment.leaves : []) {
    const leaf = rawLeaf as Record<string, unknown>;
    const nodeId = String(leaf.nodeId ?? "");
    const scientificName = String(leaf.scientificName ?? "");
    const crocodilianLeaf = /(?:crocodyl|alligator|gavial|caiman)/iu.test(scientificName)
      || isUnder(nodeId, (node) => /(?:crocodyl|alligator|gavial|caiman)/iu.test(String(node.scientificName ?? node.label ?? "")));
    const avianLeaf = isUnder(nodeId, (node) => String(node.taxonomyId ?? "") === "8782"
      || /(?:^|\b)aves(?:\b|$)|birds?/iu.test(String(node.scientificName ?? node.label ?? node.commonName ?? "")));
    if (crocodilianLeaf) crocodilian.push(nodeId);
    else if (avianLeaf) avian.push(nodeId);
  }
  const root = nodes.find((node) => node.parentId === null);
  const asrTarget = nodes
    .filter((node) => node.parentId !== null && node.leaf !== true)
    .sort((left, right) => Number(left.depth ?? 0) - Number(right.depth ?? 0) || String(left.nodeId).localeCompare(String(right.nodeId)))[0];
  const panelReady = avian.length >= 2 && crocodilian.length >= 2;
  return {
    schema: "agentlas.science.dinosaur-route-advance/v1",
    stage: "comparative-gene-tree-materialized",
    nextTool: panelReady ? "materialize_extant_archosaur_locus_panel" : "human-decision",
    availableLeafGroups: { avian: avian.length, crocodilian: crocodilian.length },
    ...(panelReady ? {
      locusPanelSelection: {
        avianLeafNodeIds: avian.slice(0, 4),
        crocodilianLeafNodeIds: crocodilian.slice(0, 4),
      },
    } : {
      blockReason: "The exact provider gene tree does not contain at least two leaves in both the avian and crocodilian groups required by the locus-panel contract.",
      requiredDecision: "Choose another provider gene/tree or explicitly continue with a blocked extant-locus gate; never duplicate a leaf or relabel an avian taxon as crocodilian.",
    }),
    ...(asrTarget && (!root || String(asrTarget.nodeId) !== String(root.nodeId)) ? { hypotheticalAsrTargetNodeId: String(asrTarget.nodeId) } : {}),
    boundary: "This extant comparative tree remains provider evidence and inference only; it does not establish dinosaur DNA, a dinosaur genome, an embryo, hatching, or biological revival.",
  };
}

function comparativeGenomicsTableResultRecord(result: ReturnType<ReturnType<typeof scienceComparativeGenomicsTableService>["materialize"]>): Record<string, unknown> {
  return {
    ok: true,
    schema: "agentlas.science-comparative-genomics-table-mcp-result/v1",
    parentRunId: result.parentRunId,
    run: { id: result.runId, status: "succeeded" },
    table: {
      rowCount: result.table.profile.rowCount,
      columnCount: result.table.profile.columnCount,
      columns: result.table.columns,
      tableSha256: result.table.receipts.tableSha256,
    },
    artifact: {
      id: result.artifact.id,
      version: result.artifact.version.version,
      currentVersion: result.artifact.currentVersion,
      kind: result.artifact.kind,
      title: result.artifact.title,
      contentSha256: result.artifact.version.contentSha256,
      labId: "comparative-genomics",
    },
    replayed: result.replayed,
  };
}

function hypotheticalAsrResultRecord(result: ReturnType<ReturnType<typeof scienceHypotheticalAsrService>["reconstruct"]>): Record<string, unknown> {
  return {
    ok: true,
    schema: "agentlas.science-hypothetical-asr-mcp-result/v1",
    run: { id: result.runId, status: "succeeded" },
    parentRunId: result.parentRunId,
    targetNodeId: result.targetNodeId,
    evidenceStatus: result.evidenceStatus,
    publicationGrade: false,
    assessment: result.assessment,
    publicationTable: result.publicationTable,
    artifact: {
      id: result.artifact.id,
      version: result.artifact.version.version,
      currentVersion: result.artifact.currentVersion,
      kind: result.artifact.kind,
      title: result.artifact.title,
      contentSha256: result.artifact.version.contentSha256,
      labId: "comparative-genomics",
    },
    replayed: result.replayed,
  };
}

function extantArchosaurLocusPanelResultRecord(result: ReturnType<ReturnType<typeof scienceExtantArchosaurLocusPanelService>["materialize"]>): Record<string, unknown> {
  return {
    ok: true,
    schema: "agentlas.science-extant-archosaur-locus-panel-mcp-result/v1",
    run: { id: result.runId, status: "succeeded" },
    parentRunId: result.geneTreeRunId,
    referenceAssemblyRunId: result.referenceAssemblyRunId,
    title: result.title,
    status: result.status,
    analysis: result.analysis,
    artifact: {
      id: result.artifact.id,
      version: result.artifact.version,
      currentVersion: result.artifact.version,
      kind: "chart.vega",
      title: result.title,
      contentSha256: result.artifact.contentSha256,
      labId: "comparative-genomics",
    },
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
      ...(includeMarkdown ? {
        document: manuscript.version.document,
        documentSha256: manuscript.version.documentSha256,
        identityEpoch: manuscript.version.identityEpoch,
      } : {}),
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
            // The general projection carries a column MAPPING rather than named columns, and it is
            // keyed by projection kind rather than by method because it serves every method that
            // has no bespoke branch. It has to be matched before the per-method chain below: that
            // chain ends in an unguarded `else` that assumes the ROC shape, so a declared-columns
            // request would have been rewritten into ROC's two columns and its mapping dropped on
            // the floor -- accepted at the tool boundary and unusable by the time it arrived.
            ...(sourceTable.projection_kind === "declared-columns" ? {
              columns: sourceTable.columns,
              // Optional narrowing: keep some rows, add one derived label column. Carried through
              // verbatim so the gateway can validate it and record it in the receipt.
              ...(sourceTable.preparation === undefined ? {} : { preparation: normalizeTablePreparation(sourceTable.preparation) }),
            } : sourceTable.method === "welch_one_way_anova" ? {
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
  if (isEarthAnalysisToolId(tool.id)) {
    const lifecycle = scienceStore().getResearchLifecycleForProject(common.projectId);
    const analysisPlan = tool.id === "agentlas.earth-aftershock-table-study" && lifecycle?.phase === "execution"
      ? lifecycle.frozenAnalysisPlan
      : null;
    const result = scienceEarthAnalysisService().execute(tool.id, {
      requestId: common.requestId,
      projectId: common.projectId,
      conversationId: common.conversationId,
      originMessageId: common.originMessageId,
      analysisPlan,
    }, body);
    return {
      ...artifactResult(tool, result.artifact, result.replayed, { id: result.runId, status: "succeeded" }),
      parentRunId: result.parentRunId,
      analysis: earthAnalysisToolSummary(result),
    };
  }
  if (tool.id === "agentlas.astronomy-light-curve-periodicity-depth") {
    return scienceAstronomyAnalysisService().dispatch(tool.id, body, common, tool);
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
        // Optional: photometry rarely carries an inclusion mask, and demanding one refused every
        // real light curve. Absent here means "use every measurement", recorded as such downstream.
        useColumn: (columns.use_column as string | undefined) ?? null,
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
      boundaries: analysis.boundaries,
      publicationTables: [
        { schema: observations.schema, rowCount: observations.rows.length, contentSha256: provenance.observationsTableSha256 },
        { schema: peaks.schema, rowCount: peaks.rows.length, contentSha256: provenance.peaksTableSha256 },
        { schema: periodogram.schema, rowCount: periodogram.rows.length, contentSha256: provenance.periodogramTableSha256 },
      ],
      figure: { schema: "agentlas.astronomy.light-curve-publication-figure/v1", contentSha256: provenance.figureSha256 },
      scientificLimits: [
        ...(Array.isArray(analysis.warnings) ? analysis.warnings.filter((warning) =>
          warning === "false-alarm-probability-not-computed" || warning === "period-uncertainty-not-computed") : []),
        "analytic-fap-white-noise-model", "period-standard-error-not-confidence-interval", "single-sinusoid-model-only",
      ],
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
  const physicsAnalysisKind = physicsAnalysisKindForToolId(tool.id);
  if (physicsAnalysisKind) {
    const parameters = Object.fromEntries(Object.entries(body).filter(([key]) => !["tool_call_id", "dataset_run_id", "title"].includes(key)));
    const result = sciencePhysicsAnalysisService().analyze({
      kind: physicsAnalysisKind,
      requestId: common.requestId,
      projectId: common.projectId,
      conversationId: common.conversationId,
      originMessageId: common.originMessageId,
      ...(body.dataset_run_id === undefined ? {} : { datasetRunId: body.dataset_run_id as string }),
      parameters,
      ...(body.title === undefined ? {} : { title: body.title as string }),
    });
    return {
      ...artifactResult(tool, result.artifact, result.replayed, { id: result.runId, status: "succeeded" }),
      parentRunId: result.parentRunId,
      analysisId: result.analysis.analysisId,
      method: result.analysis.method,
      summary: result.analysis.summary,
      publicationTable: result.analysis.publicationTable,
      boundaries: result.analysis.boundaries,
      warnings: result.analysis.warnings,
      analysisSha256: result.analysis.analysisSha256,
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
  if (tool.id === "agentlas.paleontology-stratigraphic-support") {
    const result = sciencePaleontologyAnalysisService().analyzeStratigraphicEvidence({
      requestId: common.requestId,
      projectId: common.projectId,
      conversationId: common.conversationId,
      originMessageId: common.originMessageId,
      catalogRunId: body.catalog_run_id as string,
      ...(body.title === undefined ? {} : { title: body.title as string }),
    });
    return {
      ...artifactResult(tool, result.artifact, result.replayed, { id: result.runId, status: "succeeded" }),
      parentRunId: result.parentRunId,
      analysis: result.analysis,
    };
  }
  if (tool.id === "agentlas.paleontology-candidate-comparison") {
    const candidates = (body.candidates as Array<Record<string, unknown>>).map((candidate) => ({
      catalogRunId: exactText(candidate.catalog_run_id, 160, "science-paleontology-candidate-comparison-catalog-run-id-invalid"),
      stratigraphicRunId: exactText(candidate.stratigraphic_run_id, 160, "science-paleontology-candidate-comparison-stratigraphic-run-id-invalid"),
    }));
    const result = sciencePaleontologyCandidateComparisonService().compare({
      requestId: common.requestId,
      projectId: common.projectId,
      conversationId: common.conversationId,
      originMessageId: common.originMessageId,
      title: exactText(body.title, 240, "science-paleontology-candidate-comparison-title-invalid"),
      candidates,
    });
    return {
      ...artifactResult(tool, result.artifact, result.replayed, { id: result.runId, status: "succeeded" }),
      parentRunIds: result.parentRunIds,
      comparison: paleontologyCandidateComparisonToolSummary(result),
    };
  }
  if (tool.id === "agentlas.paleontology-deextinction-feasibility") {
    const candidates = (body.candidates as Array<Record<string, unknown>>).map((candidate) => ({
      candidateId: exactText(candidate.candidate_id, 120, "science-deextinction-candidate-id-invalid"),
      taxonName: exactText(candidate.taxon_name, 500, "science-deextinction-taxon-name-invalid"),
      label: exactText(candidate.label, 240, "science-deextinction-label-invalid"),
      evidence: (candidate.evidence as Array<Record<string, unknown>>).map((evidence) => ({
        criterionId: exactText(evidence.criterion_id, 120, "science-deextinction-criterion-id-invalid"),
        evidenceStatus: evidence.evidence_status as "observed" | "inferred" | "hypothetical" | "missing",
        finding: evidence.finding as "supports" | "contradicts" | "inconclusive" | "not-assessed",
        detail: exactText(evidence.detail, 2_000, "science-deextinction-evidence-detail-invalid"),
        sourceRunIds: (evidence.source_run_ids as unknown[]).map((value) => exactText(value, 160, "science-deextinction-source-run-id-invalid")),
      })),
    }));
    const result = scienceDeextinctionFeasibilityService().assessDeextinctionFeasibility({
      requestId: common.requestId,
      projectId: common.projectId,
      conversationId: common.conversationId,
      originMessageId: common.originMessageId,
      title: exactText(body.title, 240, "science-deextinction-title-invalid"),
      targetObjective: body.target_objective as "actual-biological-revival" | "comparative-proxy-research",
      candidates,
    });
    return {
      ...artifactResult(tool, result.artifact, result.replayed, { id: result.runId, status: "succeeded" }),
      parentRunIds: result.parentRunIds,
      assessment: deextinctionFeasibilityToolSummary(result),
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
          // The inventory is where the director looks first, so a table's columns belong here too.
          // "400 rows and 4 typed columns" tells you a table exists; it does not let you project it.
          table: dataTableShape(artifact.version.payload),
        },
        linkageSha256: context.linkage.linkageSha256,
        updatedAt: artifact.updatedAt,
      };
    });
    const activeLoopSession = store.getActiveLoopSession(project.id);
    const activeEpisodes = activeLoopSession ? store.listResearchEpisodes(project.id, activeLoopSession.id) : [];
    const labDecisionProjections = scienceLabDecisionProjectionsForProject(store, project.id, grant.catalog);
    const latestContract = store.latestResearchContract(project.id);
    return {
      ok: true,
      schema: "agentlas.science.research-workspace/v1",
      project,
      lifecycle,
      researchContract: latestContract,
      // What the study needs next, in words. The fields above carry the same facts, and a model
      // reading them still ran a dozen analyses without noticing the study had never started.
      studyProgress: scienceStudyProgress({
        phase: lifecycle?.phase ?? null,
        contract: latestContract,
        approvedTermsSha256: store.approvedResearchContractSha256(project.id),
        nextGate: lifecycle?.phase ? scienceNextResearchPhaseGate(lifecycle.phase) : null,
        pendingResearcherDecision: pendingResearcherDecisionFor(store, project.id, lifecycle?.phase ?? null),
      }),
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
    const completionScope = body.completion_scope;
    if (completionScope !== "full-study" && completionScope !== "bounded-deliverable") {
      throw new Error("science-research-completion-scope-invalid");
    }
    let result = store.saveResearchContract({
      requestId: stableUuid(`science-research-contract-propose:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      expectedProjectVersion: positiveInteger(body.expected_project_version, "science-project-version-invalid"),
      objective: exactText(body.objective, 20_000, "science-contract-objective-invalid"),
      successCriteria: body.success_criteria as string[],
      failureCriteria: body.failure_criteria as string[],
      constraints: body.constraints as string[],
      completionScope: completionScope as ScienceResearchCompletionScope,
      maxEpisodes: positiveInteger(body.max_episodes, "science-contract-max-episodes-invalid"),
      maxWallTimeMinutes: positiveInteger(body.max_wall_time_minutes, "science-contract-max-wall-time-invalid"),
    });
    const policy = store.approvalPolicy(grant.context.projectId);
    if (store.approvalIsStanding(grant.context.projectId, "research-contract")) {
      result = store.approveResearchContract({
        requestId: stableUuid(`science-contract-standing-approval:v1:${result.contract.id}:${result.contract.version}:${policy.id}:${policy.revision}`),
        projectId: result.project.id,
        contractId: result.contract.id,
        expectedProjectVersion: result.project.version,
        expectedContractVersion: result.contract.version,
      });
      // Admission belongs to Main. A model ending its response after intake
      // must not strand an authorized study outside the continuation loop.
      let session = store.getActiveLoopSession(grant.context.projectId);
      if (!session && !store.listLoopSessions(grant.context.projectId).some((item) => item.contractId === result.contract.id)) {
        session = store.startLoopSession({
          requestId: stableUuid(`science-contract-loop-admission:v1:${result.contract.id}:${result.contract.version}`),
          projectId: grant.context.projectId,
          conversationId: grant.context.conversationId,
          contractId: result.contract.id,
          expectedProjectVersion: result.project.version,
          expectedContractVersion: result.contract.version,
          runtimeSelection: store.getTurnByInvocationRunId(grant.context.invocationRunId)?.runtimeSelection ?? null,
        }).session;
      }
      if (session?.status === "queued" && session.contractId === result.contract.id
        && session.runtimeChatId === store.getTurnByInvocationRunId(grant.context.invocationRunId)?.runtimeChatId) {
        session = store.confirmLoopResumeDispatch({
          projectId: session.projectId,
          loopSessionId: session.id,
          expectedLoopVersion: session.version,
          expectedLoopStateSha256: session.stateSha256,
          invocationRunId: grant.context.invocationRunId,
        });
      }
      return {
        ok: true, schema: "agentlas.science.research-contract-proposal/v1", ...result,
        approval: { mode: "standing", policyId: policy.id, policyRevision: policy.revision, scope: "research-contract" },
        researchLoop: session,
      };
    }
    return { ok: true, schema: "agentlas.science.research-contract-proposal/v1", ...result, approval: { mode: "checkpoint" } };
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
      runtimeSelection: store.getTurnByInvocationRunId(grant.context.invocationRunId)?.runtimeSelection ?? null,
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
    // `approved` and `rejected` are authorizations, not observations an agent derives from
    // evidence, so they are never something this route decides on its own. What it may do is act
    // on an authorization the researcher already gave: a project whose approval policy carries a
    // standing grant for the hypothesis scope has said "proceed, and record it", and that grant
    // names who gave it and when, so the trail is the same shape as a click. Without the grant the
    // route still refuses, and only the Main-owned `science:hypotheses:decide` IPC, which records
    // the deciding human actor, may write those states.
    if ((body.status === "approved" || body.status === "rejected")
      && !store.approvalIsStanding(grant.context.projectId, "hypothesis")) {
      throw new Error("science-hypothesis-human-authority-required");
    }
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
  if (route === "/v1/platform/statistics/prepare-paired-table") {
    const sources = (body.sources as Array<Record<string, unknown>>).map((source) => ({
      artifactId: exactText(source.artifact_id, 80, "science-paired-table-source-id-invalid"),
      artifactVersion: positiveInteger(source.artifact_version, "science-paired-table-source-version-invalid"),
      contentSha256: exactSha256(source.content_sha256, "science-paired-table-source-content-invalid"),
      keyColumn: exactText(source.key_column, 240, "science-paired-table-key-column-invalid"),
      valueColumn: exactText(source.value_column, 240, "science-paired-table-value-column-invalid"),
      outputColumn: exactText(source.output_column, 120, "science-paired-table-output-column-invalid"),
      label: exactText(source.label, 240, "science-paired-table-label-invalid"),
    }));
    if (sources.length !== 2) throw new Error("science-paired-table-sources-invalid");
    const result = store.preparePairedStatisticsTable({
      requestId: stableUuid(`science-paired-table-align:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      conversationId: grant.context.conversationId,
      originMessageId: grant.context.originUserMessageId,
      title: exactText(body.title, 240, "science-paired-table-title-invalid"),
      outputKeyColumn: exactText(body.output_key_column, 120, "science-paired-table-output-column-invalid"),
      sources: sources as [typeof sources[number], typeof sources[number]],
      methods: body.methods as typeof SCIENCE_PAIRED_TABLE_METHODS[number][],
      model: body.model as NonNullable<ScienceAnalysisSpecDocument["model"]>,
      minimumCompletePairs: positiveInteger(body.minimum_complete_pairs, "science-paired-table-minimum-complete-pairs-invalid"),
    });
    return { ok: true, schema: "agentlas.science.paired-table-preparation-result/v1", ...result };
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
    }, { allowStandingApproval: true });
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
  if (route === "/v1/platform/manuscripts/render") {
    const manuscriptId = exactText(body.manuscript_id, 80, "science-manuscript-id-invalid");
    const manuscript = store.getManuscriptForProject(grant.context.projectId, manuscriptId);
    if (!manuscript) throw new Error("science-manuscript-not-found");
    const outputs: Array<"html" | "latex" | "docx" | "pdf" | "package"> = Array.isArray(body.outputs) && body.outputs.length ? body.outputs as Array<"html" | "latex" | "docx" | "pdf" | "package"> : ["html", "latex", "docx", "pdf"];
    const rendered = await scienceManuscriptRenderService().render(manuscript, {
      outputs, style: (body.style as "numeric" | "apa" | "nature" | undefined) ?? "numeric",
      lineNumbers: body.line_numbers === true, doubleSpacing: body.double_spacing === true,
      metadata: body.metadata && typeof body.metadata === "object" ? body.metadata as ScienceSubmissionMetadata : null,
    });
    const directory = userDataPath("extensions", "agentlas-science", "manuscript-renders", grant.context.projectId, manuscript.id, `v${manuscript.currentVersion}`);
    fs.mkdirSync(directory, { recursive: true });
    const written: Record<string, string> = {};
    const write = (name: string, bytes: Uint8Array | string | null) => {
      if (bytes === null) return;
      const target = path.join(directory, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { mode: 0o600 });
      written[name] = target;
    };
    write("manuscript.html", rendered.html);
    write("manuscript.tex", rendered.latex);
    write("references.bib", rendered.bibtex);
    write("manuscript.docx", rendered.docx);
    write("manuscript.pdf", rendered.pdf?.bytes ?? null);
    for (const file of rendered.files) write(file.name, file.bytes);
    const report = {
      schema: rendered.schema, manuscriptId: rendered.manuscriptId, manuscriptVersion: rendered.manuscriptVersion, manuscriptContentSha256: rendered.manuscriptContentSha256,
      style: rendered.style, document: rendered.document, references: rendered.references.map((reference) => ({ locator: reference.locator, ordinal: reference.ordinal, text: reference.text })),
      warnings: rendered.warnings, equationFallbacks: rendered.equationFallbacks,
      pdf: rendered.pdf ? { engine: rendered.pdf.engine, degraded: rendered.pdf.degraded, degradedReason: rendered.pdf.degradedReason, byteSize: rendered.pdf.bytes.byteLength } : null,
      pdfFailure: rendered.pdfFailure, capabilities: rendered.capabilities,
    };
    write("render-report.json", `${JSON.stringify(report, null, 2)}\n`);
    return { ok: true, ...report, schema: "agentlas.science.manuscript-render-receipt/v1", renderSchema: rendered.schema, directory, files: written };
  }
  if (route === "/v1/platform/journals/export-submission") {
    const result = await scienceJournalPublicationService().createSubmissionExport({
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
  if (route === "/v1/platform/source-text/structure") {
    const sourceId = exactText(body.source_id, 80, "science-source-id-invalid");
    const sourceVersionId = exactText(body.source_version_id, 80, "science-source-version-id-invalid");
    const sourceVersion = positiveInteger(body.source_version, "science-source-version-invalid");
    const sourceContentSha256 = exactSha256(body.source_content_sha256, "science-source-content-invalid");
    const source = store.getSourceVersionForProject(grant.context.projectId, sourceId, sourceVersionId);
    if (!source || source.version.version !== sourceVersion || source.version.contentSha256 !== sourceContentSha256) throw new Error("science-source-version-not-found");
    const index = store.ensureSourceTextIndex(grant.context.projectId, sourceId, sourceVersionId);
    if (!index) return { ok: true, schema: "agentlas.science.source-text-structure/v1", source: { id: sourceId, versionId: sourceVersionId, version: sourceVersion, contentSha256: sourceContentSha256 }, index: null, sections: [] };
    const chunks = store.listSourceTextChunks(grant.context.projectId, sourceVersionId, index.chunkCount);
    const groups = new Map<string, typeof chunks>();
    for (const chunk of chunks) groups.set(chunk.sectionId, [...(groups.get(chunk.sectionId) ?? []), chunk]);
    const sections = [...groups.values()].map((items) => {
      const text = items.map((item) => item.text).join("\n\n");
      return {
        id: items[0]!.sectionId, ordinal: items[0]!.sectionOrdinal, title: items[0]!.sectionTitle,
        wordCount: (text.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) ?? []).length,
        paragraphCount: text.split(/\n\s*\n+/u).filter((paragraph) => paragraph.trim().length >= 40).length,
        chunkCount: items.length,
        chunkManifestSha256: createHash("sha256").update(JSON.stringify(items.map((item) => ({ id: item.id, contentSha256: item.contentSha256 })))).digest("hex"),
      };
    });
    return { ok: true, schema: "agentlas.science.source-text-structure/v1", source: { id: sourceId, versionId: sourceVersionId, version: sourceVersion, contentSha256: sourceContentSha256 }, index, sections };
  }
  if (route === "/v1/platform/manuscript-comparable-eligibility/inspect") {
    const eligibility = store.getManuscriptComparableEligibilityForProject(
      grant.context.projectId,
      exactText(body.eligibility_receipt_id, 80, "science-manuscript-comparable-eligibility-id-invalid"),
    );
    if (!eligibility) throw new Error("science-manuscript-comparable-eligibility-not-found");
    return { ok: true, schema: "agentlas.science.manuscript-comparable-eligibility-read/v1", eligibility };
  }
  if (route === "/v1/platform/manuscript-comparable-eligibility/record") {
    const targetJournal = body.target_journal === null ? null : (() => {
      const value = body.target_journal as Record<string, unknown>;
      return {
        journalProfileId: exactText(value.journal_profile_id, 80, "science-manuscript-comparable-journal-id-invalid"),
        journalProfileVersion: positiveInteger(value.journal_profile_version, "science-manuscript-comparable-journal-version-invalid"),
        journalProfileContentSha256: exactSha256(value.journal_profile_content_sha256, "science-manuscript-comparable-journal-content-invalid"),
      };
    })();
    const result = store.recordManuscriptComparableEligibility({
      requestId: stableUuid(`science-manuscript-comparable-eligibility:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      sourceId: exactText(body.source_id, 80, "science-manuscript-comparable-source-id-invalid"),
      expectedSourceVersionId: exactText(body.expected_source_version_id, 80, "science-manuscript-comparable-source-version-id-invalid"),
      expectedSourceVersion: positiveInteger(body.expected_source_version, "science-manuscript-comparable-source-version-invalid"),
      expectedSourceContentSha256: exactSha256(body.expected_source_content_sha256, "science-manuscript-comparable-source-content-invalid"),
      sourceDomain: body.source_domain as RecordScienceManuscriptComparableEligibilityInput["sourceDomain"],
      articleFamily: body.article_family as RecordScienceManuscriptComparableEligibilityInput["articleFamily"],
      decision: body.decision as RecordScienceManuscriptComparableEligibilityInput["decision"],
      venueRelation: body.venue_relation as RecordScienceManuscriptComparableEligibilityInput["venueRelation"],
      targetJournal,
      evidence: (body.evidence as Array<Record<string, unknown>>).map((value) => ({
        sectionId: exactText(value.section_id, 80, "science-manuscript-comparable-evidence-section-invalid"),
        startByte: nonNegativeInteger(value.start_byte, "science-manuscript-comparable-evidence-offset-invalid"),
        endByte: positiveInteger(value.end_byte, "science-manuscript-comparable-evidence-offset-invalid"),
        exactQuote: exactText(value.exact_quote, 20_000, "science-manuscript-comparable-evidence-quote-invalid"),
        exactQuoteSha256: exactSha256(value.exact_quote_sha256, "science-manuscript-comparable-evidence-quote-sha256-invalid"),
      })),
      rationale: exactText(body.rationale, 20_000, "science-manuscript-comparable-rationale-invalid"),
      limitations: body.limitations as string[],
    }, {
      method: "research-director-attestation",
      agentId: grant.context.researchDirectorAgentId,
      agentSlug: grant.context.researchDirectorAgentSlug,
      packageVersion: grant.context.researchDirectorPackageVersion,
      packageDigest: grant.context.researchDirectorPackageDigest,
      systemPromptSha256: grant.context.researchDirectorSystemPromptSha256,
      invocationRunId: grant.context.invocationRunId,
    });
    return { ok: true, schema: "agentlas.science.manuscript-comparable-eligibility-write-result/v1", ...result };
  }
  const manuscriptBlueprintInput = () => ({
    projectId: grant.context.projectId,
    articleFamily: body.article_family as ScienceManuscriptArticleFamily,
    comparables: (body.comparables as Array<Record<string, unknown>>).map((item): ScienceManuscriptBlueprintComparableInput => ({
      sourceId: exactText(item.source_id, 80, "science-manuscript-blueprint-source-id-invalid"),
      sourceVersionId: exactText(item.source_version_id, 80, "science-manuscript-blueprint-source-version-id-invalid"),
      sourceVersion: positiveInteger(item.source_version, "science-manuscript-blueprint-source-version-invalid"),
      sourceContentSha256: exactSha256(item.source_content_sha256, "science-manuscript-blueprint-source-sha256-invalid"),
      eligibilityReceiptId: exactText(item.eligibility_receipt_id, 80, "science-manuscript-blueprint-eligibility-receipt-id-invalid"),
      sectionMappings: (item.section_mappings as Array<Record<string, unknown>>).map((mapping) => ({
        role: mapping.role as ScienceManuscriptBlueprintSectionInput["role"],
        sourceSectionIds: mapping.source_section_ids as string[],
      })),
    })),
    journalBinding: body.journal_binding === null ? null : (() => {
      const value = body.journal_binding as Record<string, unknown>;
      return {
        journalProfileId: exactText(value.journal_profile_id, 80, "science-manuscript-blueprint-journal-id-invalid"),
        journalProfileVersion: positiveInteger(value.journal_profile_version, "science-manuscript-blueprint-journal-version-invalid"),
        journalProfileContentSha256: exactSha256(value.journal_profile_content_sha256, "science-manuscript-blueprint-journal-sha256-invalid"),
      } satisfies ScienceManuscriptBlueprintJournalBindingInput;
    })(),
    sections: (body.sections as Array<Record<string, unknown>>).map((item): ScienceManuscriptBlueprintSectionInput => ({
      key: exactText(item.key, 120, "science-manuscript-blueprint-section-key-invalid"),
      title: exactText(item.title, 240, "science-manuscript-blueprint-section-title-invalid"),
      role: item.role as ScienceManuscriptBlueprintSectionInput["role"],
      required: item.required as boolean,
      rhetoricalMoves: item.rhetorical_moves as string[],
      visualExpectation: item.visual_expectation as ScienceManuscriptBlueprintSectionInput["visualExpectation"],
      evidenceRoles: item.evidence_roles as string[],
    })),
    planningRationale: body.planning_rationale as string,
    limitations: body.limitations as string[],
  });
  if (route === "/v1/platform/manuscript-blueprints/list") {
    return { ok: true, schema: "agentlas.science.manuscript-blueprint-list/v1", blueprints: store.listManuscriptBlueprints(grant.context.projectId) };
  }
  if (route === "/v1/platform/manuscript-blueprints/inspect") {
    const blueprint = store.getManuscriptBlueprintForProject(grant.context.projectId,
      exactText(body.blueprint_id, 80, "science-manuscript-blueprint-id-invalid"));
    if (!blueprint) throw new Error("science-manuscript-blueprint-not-found");
    return { ok: true, schema: "agentlas.science.manuscript-blueprint-read/v1", blueprint };
  }
  if (route === "/v1/platform/manuscript-blueprint-assessments/inspect") {
    const manuscriptId = exactText(body.manuscript_id, 80, "science-manuscript-id-invalid");
    const assessment = store.getManuscriptBlueprintAssessmentForManuscript(grant.context.projectId, manuscriptId);
    if (!assessment) throw new Error("science-manuscript-blueprint-assessment-not-found");
    return { ok: true, schema: "agentlas.science.manuscript-blueprint-assessment-read/v1", assessment };
  }
  if (route === "/v1/platform/manuscript-blueprint-assessments/record") {
    const result = store.recordManuscriptBlueprintAssessment({
      requestId: stableUuid(`science-manuscript-blueprint-assessment:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      manuscriptId: exactText(body.manuscript_id, 80, "science-manuscript-id-invalid"),
      expectedManuscriptVersion: positiveInteger(body.expected_manuscript_version, "science-manuscript-version-invalid"),
      expectedManuscriptContentSha256: exactSha256(body.expected_manuscript_content_sha256, "science-manuscript-content-invalid"),
      journalProfileId: exactText(body.journal_profile_id, 80, "science-journal-profile-id-invalid"),
      expectedJournalProfileVersion: positiveInteger(body.expected_journal_profile_version, "science-journal-profile-version-invalid"),
      expectedJournalProfileContentSha256: exactSha256(body.expected_journal_profile_content_sha256, "science-journal-profile-content-invalid"),
    });
    return { ok: true, schema: "agentlas.science.manuscript-blueprint-assessment-write-result/v1", ...result };
  }
  if (route === "/v1/platform/manuscript-scholarly-assessments/inspect") {
    const manuscriptId = exactText(body.manuscript_id, 80, "science-manuscript-id-invalid");
    const assessment = store.getManuscriptScholarlyAssessmentForManuscript(grant.context.projectId, manuscriptId);
    if (!assessment) throw new Error("science-manuscript-scholarly-assessment-not-found");
    return { ok: true, schema: "agentlas.science.manuscript-scholarly-assessment-read/v1", assessment };
  }
  if (route === "/v1/platform/manuscript-scholarly-assessments/record") {
    const quoteLocator = (value: Record<string, unknown>) => ({
      nodeId: exactText(value.node_id, 80, "science-manuscript-node-id-invalid"),
      nodeRevision: positiveInteger(value.node_revision, "science-manuscript-node-revision-invalid"),
      nodeContentSha256: exactSha256(value.node_content_sha256, "science-manuscript-node-content-invalid"),
      nodeKind: "paragraph" as const,
      from: nonNegativeInteger(value.from, "science-manuscript-quote-offset-invalid"),
      to: positiveInteger(value.to, "science-manuscript-quote-offset-invalid"),
      exactQuote: exactText(value.exact_quote, 20_000, "science-manuscript-quote-invalid"),
    });
    const scholarlyItem = (value: Record<string, unknown>) => ({
      label: exactText(value.label, 1_000, "science-manuscript-scholarly-label-invalid"),
      status: value.status as "satisfied" | "partial" | "missing",
      confidence: finiteNumber(value.confidence, 0, 1, "science-manuscript-scholarly-confidence-invalid"),
      evidence: (value.evidence as Array<Record<string, unknown>>).map(quoteLocator),
      rationale: exactText(value.rationale, 8_000, "science-manuscript-scholarly-rationale-invalid"),
    });
    const result = store.recordManuscriptScholarlyAssessment({
      requestId: stableUuid(`science-manuscript-scholarly-assessment:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      manuscriptId: exactText(body.manuscript_id, 80, "science-manuscript-id-invalid"),
      expectedManuscriptVersion: positiveInteger(body.expected_manuscript_version, "science-manuscript-version-invalid"),
      expectedManuscriptContentSha256: exactSha256(body.expected_manuscript_content_sha256, "science-manuscript-content-invalid"),
      expectedBlueprintAssessmentId: exactText(body.expected_blueprint_assessment_id, 80, "science-manuscript-blueprint-assessment-id-invalid"),
      expectedBlueprintAssessmentReportSha256: exactSha256(body.expected_blueprint_assessment_report_sha256, "science-manuscript-blueprint-assessment-report-invalid"),
      journalProfileId: exactText(body.journal_profile_id, 80, "science-journal-profile-id-invalid"),
      expectedJournalProfileVersion: positiveInteger(body.expected_journal_profile_version, "science-journal-profile-version-invalid"),
      expectedJournalProfileContentSha256: exactSha256(body.expected_journal_profile_content_sha256, "science-journal-profile-content-invalid"),
      overallConfidence: finiteNumber(body.overall_confidence, 0, 1, "science-manuscript-scholarly-confidence-invalid"),
      sections: (body.sections as Array<Record<string, unknown>>).map((section) => {
        const heading = section.heading as Record<string, unknown>;
        const flow = section.flow as Record<string, unknown>;
        return {
          sectionKey: exactText(section.section_key, 120, "science-manuscript-scholarly-section-key-invalid"),
          heading: {
            nodeId: exactText(heading.node_id, 80, "science-manuscript-node-id-invalid"),
            nodeRevision: positiveInteger(heading.node_revision, "science-manuscript-node-revision-invalid"),
            nodeContentSha256: exactSha256(heading.node_content_sha256, "science-manuscript-node-content-invalid"),
            nodeKind: heading.node_kind as "heading",
          },
          rhetoricalMoves: (section.rhetorical_moves as Array<Record<string, unknown>>).map(scholarlyItem),
          evidenceRoleCoverage: (section.evidence_role_coverage as Array<Record<string, unknown>>).map(scholarlyItem),
          flow: {
            status: flow.status as "coherent" | "partial" | "broken",
            readerStartsWith: exactText(flow.reader_starts_with, 4_000, "science-manuscript-scholarly-flow-start-invalid"),
            contribution: exactText(flow.contribution, 4_000, "science-manuscript-scholarly-flow-contribution-invalid"),
            nextQuestion: exactText(flow.next_question, 4_000, "science-manuscript-scholarly-flow-next-invalid"),
            confidence: finiteNumber(flow.confidence, 0, 1, "science-manuscript-scholarly-confidence-invalid"),
            evidence: (flow.evidence as Array<Record<string, unknown>>).map(quoteLocator),
            rationale: exactText(flow.rationale, 8_000, "science-manuscript-scholarly-flow-rationale-invalid"),
          },
        };
      }),
      summary: exactText(body.summary, 20_000, "science-manuscript-scholarly-summary-invalid"),
      limitations: body.limitations as string[],
    }, {
      method: "research-director-attestation",
      agentId: grant.context.researchDirectorAgentId,
      agentSlug: grant.context.researchDirectorAgentSlug,
      packageVersion: grant.context.researchDirectorPackageVersion,
      packageDigest: grant.context.researchDirectorPackageDigest,
      systemPromptSha256: grant.context.researchDirectorSystemPromptSha256,
      invocationRunId: grant.context.invocationRunId,
    });
    return { ok: true, schema: "agentlas.science.manuscript-scholarly-assessment-write-result/v1", ...result };
  }
  if (route === "/v1/platform/manuscript-coherence/prepare-context") {
    const result = store.prepareManuscriptCoherenceContext({
      requestId: stableUuid(`science-manuscript-coherence-context:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      manuscriptId: exactText(body.manuscript_id, 80, "science-manuscript-id-invalid"),
      expectedManuscriptVersion: positiveInteger(body.expected_manuscript_version, "science-manuscript-version-invalid"),
      expectedManuscriptContentSha256: exactSha256(body.expected_manuscript_content_sha256, "science-manuscript-content-invalid"),
    });
    return { ok: true, schema: "agentlas.science.manuscript-coherence-context-result/v1", ...result };
  }
  if (route === "/v1/platform/manuscript-coherence/inspect") {
    const manuscriptId = exactText(body.manuscript_id, 80, "science-manuscript-id-invalid");
    const assessment = store.getManuscriptCoherenceAssessmentForManuscript(grant.context.projectId, manuscriptId);
    if (!assessment) throw new Error("science-manuscript-coherence-assessment-not-found");
    return { ok: true, schema: "agentlas.science.manuscript-coherence-assessment-read/v1", assessment };
  }
  if (route === "/v1/platform/manuscript-coherence/record") {
    const coherenceOwner = (value: Record<string, unknown>): ScienceCoherenceTextOwner => value.kind === "claim"
      ? {
        kind: "claim",
        claimId: exactText(value.claim_id, 80, "science-manuscript-coherence-claim-id-invalid"),
        claimContentSha256: exactSha256(value.claim_content_sha256, "science-manuscript-coherence-claim-content-invalid"),
      }
      : {
        kind: "visual-caption",
        nodeId: exactText(value.node_id, 80, "science-manuscript-coherence-node-id-invalid"),
        nodeRevision: positiveInteger(value.node_revision, "science-manuscript-coherence-node-revision-invalid"),
        nodeContentSha256: exactSha256(value.node_content_sha256, "science-manuscript-coherence-node-content-invalid"),
      };
    const numericSource = (value: Record<string, unknown>): ScienceCoherenceNumericSourceSelectorInput => {
      if (!["value", "confidence-level", "lower", "upper"].includes(String(value.component_role))) {
        throw new Error("science-manuscript-coherence-numeric-source-role-invalid");
      }
      return {
        componentRole: value.component_role as ScienceCoherenceNumericSourceSelectorInput["componentRole"],
        artifactId: exactText(value.artifact_id, 80, "science-manuscript-coherence-numeric-source-artifact-invalid"),
        artifactVersion: positiveInteger(value.artifact_version, "science-manuscript-coherence-numeric-source-version-invalid"),
        artifactContentSha256: exactSha256(value.artifact_content_sha256, "science-manuscript-coherence-numeric-source-content-invalid"),
        validationReceiptId: exactText(value.validation_receipt_id, 80, "science-manuscript-coherence-numeric-source-receipt-invalid"),
        jsonPointer: exactText(value.json_pointer, 2_048, "science-manuscript-coherence-numeric-source-pointer-invalid"),
        unitJsonPointer: value.unit_json_pointer === null ? null
          : exactText(value.unit_json_pointer, 2_048, "science-manuscript-coherence-numeric-source-unit-pointer-invalid"),
      };
    };
    const numericAssertion = (value: Record<string, unknown>): ScienceCoherenceNumericAssertionInput => {
      if (!Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 3) {
        throw new Error("science-manuscript-coherence-numeric-sources-invalid");
      }
      const sources = value.sources.map((source) => numericSource(source as Record<string, unknown>));
      if (new Set(sources.map((source) => source.componentRole)).size !== sources.length) {
        throw new Error("science-manuscript-coherence-numeric-source-role-duplicate");
      }
      const grammar = value.grammar as ScienceCoherenceNumericAssertionInput["grammar"];
      const requiredRoles = grammar === "confidence-interval/v1" ? ["confidence-level", "lower", "upper"] : ["value"];
      if (sources.length !== requiredRoles.length || requiredRoles.some((role) => !sources.some((source) => source.componentRole === role))) {
        throw new Error("science-manuscript-coherence-numeric-source-components-invalid");
      }
      return {
        groupId: exactPatternText(value.group_id, 160, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u, "science-manuscript-coherence-group-id-invalid"),
        owner: coherenceOwner(value.owner as Record<string, unknown>),
        from: nonNegativeInteger(value.from, "science-manuscript-coherence-offset-invalid"),
        to: positiveInteger(value.to, "science-manuscript-coherence-offset-invalid"),
        exactQuote: exactText(value.exact_quote, 20_000, "science-manuscript-coherence-quote-invalid"),
        grammar,
        presentation: value.presentation as ScienceCoherenceNumericAssertionInput["presentation"],
        sources,
      };
    };
    const numericExemption = (value: Record<string, unknown>): ScienceCoherenceNumericExemptionInput => ({
      owner: coherenceOwner(value.owner as Record<string, unknown>),
      from: nonNegativeInteger(value.from, "science-manuscript-coherence-offset-invalid"),
      to: positiveInteger(value.to, "science-manuscript-coherence-offset-invalid"),
      exactQuote: exactText(value.exact_quote, 20_000, "science-manuscript-coherence-quote-invalid"),
      reason: value.reason as ScienceCoherenceNumericExemptionInput["reason"],
    });
    const input: RecordScienceManuscriptCoherenceAssessmentInput = {
      requestId: stableUuid(`science-manuscript-coherence-assessment:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      manuscriptId: exactText(body.manuscript_id, 80, "science-manuscript-id-invalid"),
      expectedManuscriptVersion: positiveInteger(body.expected_manuscript_version, "science-manuscript-version-invalid"),
      expectedManuscriptContentSha256: exactSha256(body.expected_manuscript_content_sha256, "science-manuscript-content-invalid"),
      expectedClaimLedgerId: exactText(body.expected_claim_ledger_id, 80, "science-manuscript-coherence-claim-ledger-id-invalid"),
      expectedClaimLedgerRevision: positiveInteger(body.expected_claim_ledger_revision, "science-manuscript-coherence-claim-ledger-revision-invalid"),
      expectedClaimLedgerManifestSha256: exactSha256(body.expected_claim_ledger_manifest_sha256, "science-manuscript-coherence-claim-ledger-manifest-invalid"),
      expectedClaimLedgerGateReportSha256: exactSha256(body.expected_claim_ledger_gate_report_sha256, "science-manuscript-coherence-claim-ledger-gate-invalid"),
      expectedClaimLedgerPolicyContentSha256: exactSha256(body.expected_claim_ledger_policy_content_sha256, "science-manuscript-coherence-claim-ledger-policy-invalid"),
      summaryClaimLinks: (body.summary_claim_links as Array<Record<string, unknown>>).map((value) => ({
        summaryClaimId: exactText(value.summary_claim_id, 80, "science-manuscript-coherence-summary-claim-id-invalid"),
        bodyClaimIds: value.body_claim_ids as string[],
      })),
      resultsDiscussionLinks: (body.results_discussion_links as Array<Record<string, unknown>>).map((value) => ({
        resultClaimId: exactText(value.result_claim_id, 80, "science-manuscript-coherence-result-claim-id-invalid"),
        discussionClaimIds: value.discussion_claim_ids as string[],
      })),
      numericAssertions: (body.numeric_assertions as Array<Record<string, unknown>>).map(numericAssertion),
      numericExemptions: (body.numeric_exemptions as Array<Record<string, unknown>>).map(numericExemption),
    };
    const result = store.recordManuscriptCoherenceAssessment(input);
    return { ok: true, schema: "agentlas.science.manuscript-coherence-assessment-write-result/v1", ...result };
  }
  if (route === "/v1/platform/manuscript-blueprints/create") {
    const result = store.createManuscriptBlueprint({
      requestId: stableUuid(`science-manuscript-blueprint-create:v1:${grant.context.invocationRunId}:${toolCallId}`),
      title: body.title as string,
      ...manuscriptBlueprintInput(),
    });
    return { ok: true, schema: "agentlas.science.manuscript-blueprint-write-result/v1", ...result };
  }
  if (route === "/v1/platform/manuscript-blueprints/append-version") {
    const result = store.appendManuscriptBlueprintVersion({
      requestId: stableUuid(`science-manuscript-blueprint-append:v1:${grant.context.invocationRunId}:${toolCallId}`),
      blueprintId: exactText(body.blueprint_id, 80, "science-manuscript-blueprint-id-invalid"),
      expectedVersion: positiveInteger(body.expected_version, "science-manuscript-blueprint-version-invalid"),
      expectedContentSha256: exactSha256(body.expected_content_sha256, "science-manuscript-blueprint-content-invalid"),
      ...manuscriptBlueprintInput(),
    });
    return { ok: true, schema: "agentlas.science.manuscript-blueprint-write-result/v1", ...result };
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
    return {
      ok: true,
      schema: "agentlas.science-manuscript-inspection/v1",
      manuscript: manuscriptRecord(manuscript, true),
      depthPreflight: inspectScienceManuscriptDepth(manuscript.version.markdown),
    };
  }
  if (route === "/v1/platform/manuscripts/editor-model") {
    const manuscriptId = exactText(body.manuscript_id, 80, "science-manuscript-id-invalid");
    const editorModel = store.getManuscriptEditorModelForProject(grant.context.projectId, manuscriptId);
    if (!editorModel) throw new Error("science-manuscript-not-found");
    return { ok: true, schema: "agentlas.science.manuscript-editor-model-read/v1", editorModel };
  }
  if (route === "/v1/platform/manuscripts/transactions") {
    const manuscriptId = exactText(body.manuscript_id, 80, "science-manuscript-id-invalid");
    if (!store.getManuscriptForProject(grant.context.projectId, manuscriptId)) throw new Error("science-manuscript-not-found");
    const limit = body.limit === undefined ? 100 : positiveInteger(body.limit, "science-manuscript-transaction-limit-invalid");
    if (limit > 500) throw new Error("science-manuscript-transaction-limit-invalid");
    return {
      ok: true,
      schema: "agentlas.science.manuscript-transaction-history-read/v1",
      transactions: store.listManuscriptTransactions(grant.context.projectId, manuscriptId, limit),
    };
  }
  if (route === "/v1/platform/manuscripts/edit-proposals/create") {
    const result = store.createManuscriptEditProposal({
      requestId: stableUuid(`science-manuscript-edit-proposal-create:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      manuscriptId: exactText(body.manuscript_id, 80, "science-manuscript-id-invalid"),
      expectedVersion: positiveInteger(body.expected_version, "science-manuscript-version-invalid"),
      expectedContentSha256: exactSha256(body.expected_content_sha256, "science-manuscript-content-invalid"),
      expectedDocumentSha256: exactSha256(body.expected_document_sha256, "science-manuscript-document-invalid"),
      operations: body.operations as ScienceManuscriptOperation[],
      summary: body.summary as string,
      rationale: body.rationale as string,
      conversationId: grant.context.conversationId,
      messageId: grant.context.originUserMessageId,
      ...(body.selection_context_ids === undefined ? {} : { selectionContextIds: body.selection_context_ids as string[] }),
    });
    return { ok: true, schema: "agentlas.science.manuscript-edit-proposal-create-result/v1", ...result };
  }
  if (route === "/v1/platform/manuscripts/edit-proposals/list") {
    const manuscriptId = exactText(body.manuscript_id, 80, "science-manuscript-id-invalid");
    if (!store.getManuscriptForProject(grant.context.projectId, manuscriptId)) throw new Error("science-manuscript-not-found");
    const limit = body.limit === undefined ? 100 : positiveInteger(body.limit, "science-manuscript-edit-proposal-limit-invalid");
    if (limit > 500) throw new Error("science-manuscript-edit-proposal-limit-invalid");
    const statuses = body.statuses === undefined ? null : new Set(body.statuses as ScienceManuscriptEditProposalStatus[]);
    const proposals = store.listManuscriptEditProposals(grant.context.projectId, manuscriptId, limit)
      .filter((proposal) => statuses === null || statuses.has(proposal.status));
    return { ok: true, schema: "agentlas.science.manuscript-edit-proposal-list/v1", proposals };
  }
  if (route === "/v1/platform/manuscripts/edit-proposals/apply") {
    const result = store.applyManuscriptEditProposal({
      requestId: stableUuid(`science-manuscript-edit-proposal-apply:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      manuscriptId: exactText(body.manuscript_id, 80, "science-manuscript-id-invalid"),
      proposalId: exactText(body.proposal_id, 80, "science-manuscript-edit-proposal-id-invalid"),
      expectedVersion: positiveInteger(body.expected_version, "science-manuscript-version-invalid"),
      expectedContentSha256: exactSha256(body.expected_content_sha256, "science-manuscript-content-invalid"),
      expectedDocumentSha256: exactSha256(body.expected_document_sha256, "science-manuscript-document-invalid"),
    });
    return { ok: true, schema: "agentlas.science.manuscript-edit-proposal-apply-result/v1", ...result };
  }
  if (route === "/v1/platform/manuscripts/edit-proposals/reject") {
    const result = store.rejectManuscriptEditProposal({
      requestId: stableUuid(`science-manuscript-edit-proposal-reject:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      manuscriptId: exactText(body.manuscript_id, 80, "science-manuscript-id-invalid"),
      proposalId: exactText(body.proposal_id, 80, "science-manuscript-edit-proposal-id-invalid"),
      reason: body.reason === null ? null : body.reason as string,
    });
    return { ok: true, schema: "agentlas.science.manuscript-edit-proposal-reject-result/v1", ...result };
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
  if (route === "/v1/platform/claim-ledgers/seal") {
    const rows = Array.isArray(body.classifications) ? body.classifications as Array<Record<string, unknown>> : [];
    const result = store.sealClaimLedger({
      requestId: stableUuid(`science-claim-ledger-seal:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      manuscriptId: exactText(body.manuscript_id, 80, "science-manuscript-id-invalid"),
      expectedManuscriptVersion: Number(body.expected_manuscript_version),
      expectedManuscriptContentSha256: String(body.expected_manuscript_content_sha256 ?? ""),
      citationIds: Array.isArray(body.citation_ids) ? (body.citation_ids as unknown[]).map((value) => String(value)) : [],
      validationReceiptIds: Array.isArray(body.validation_receipt_ids) ? (body.validation_receipt_ids as unknown[]).map((value) => String(value)) : [],
      classifications: rows.map((row) => ({
        sentenceId: String(row.sentence_id ?? ""),
        claimClass: row.claim_class as never,
        status: row.status as never,
        ...(Array.isArray(row.evidence_citation_ids)
          ? { evidenceCitationIds: (row.evidence_citation_ids as unknown[]).map((value) => String(value)) }
          : {}),
        ...(Array.isArray(row.evidence_assessments)
          ? { evidenceAssessments: (row.evidence_assessments as Array<Record<string, unknown>>).map((assessment) => ({
              citationId: String(assessment.citation_id ?? ""),
              ...(assessment.validation_receipt_id === undefined || assessment.validation_receipt_id === null
                ? {}
                : { validationReceiptId: String(assessment.validation_receipt_id) }),
              direction: assessment.direction as "support" | "contradict" | "qualify",
              relevance: Number(assessment.relevance),
              assessmentConfidence: Number(assessment.assessment_confidence),
            })) }
          : {}),
      })),
    });
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
  if (route === "/v1/platform/manuscript-drafting/start") {
    const blueprintBinding = body.blueprint_binding as Record<string, unknown>;
    const result = store.startManuscriptDraftingSession({
      requestId: stableUuid(`science-manuscript-drafting-start:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      title: body.title as string,
      bindings: body.bindings as ScienceManuscriptBindingInput[],
      blueprintBinding: {
        blueprintId: exactText(blueprintBinding.blueprint_id, 80, "science-manuscript-blueprint-binding-id-invalid"),
        blueprintVersion: positiveInteger(blueprintBinding.blueprint_version, "science-manuscript-blueprint-binding-version-invalid"),
        blueprintContentSha256: exactSha256(blueprintBinding.blueprint_content_sha256, "science-manuscript-blueprint-binding-content-invalid"),
      },
    });
    return { ok: true, schema: "agentlas.science.manuscript-drafting-start-result/v1", ...result };
  }
  if (route === "/v1/platform/manuscript-drafting/inspect") {
    const session = store.getManuscriptDraftingSessionForProject(
      grant.context.projectId,
      exactText(body.session_id, 80, "science-manuscript-drafting-session-id-invalid"),
    );
    if (!session) throw new Error("science-manuscript-drafting-session-not-found");
    return { ok: true, schema: "agentlas.science.manuscript-drafting-read/v1", session };
  }
  if (route === "/v1/platform/manuscript-drafting/save-section") {
    const result = store.saveManuscriptDraftSection({
      requestId: stableUuid(`science-manuscript-drafting-section-save:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      sessionId: exactText(body.session_id, 80, "science-manuscript-drafting-session-id-invalid"),
      expectedVersion: positiveInteger(body.expected_version, "science-manuscript-drafting-version-invalid"),
      expectedStateSha256: exactSha256(body.expected_state_sha256, "science-manuscript-drafting-state-invalid"),
      sectionKey: exactText(body.section_key, 120, "science-manuscript-draft-section-key-invalid"),
      markdown: body.markdown as string,
    }, {
      method: "research-director-attestation",
      agentId: grant.context.researchDirectorAgentId,
      agentSlug: grant.context.researchDirectorAgentSlug,
      packageVersion: grant.context.researchDirectorPackageVersion,
      packageDigest: grant.context.researchDirectorPackageDigest,
      systemPromptSha256: grant.context.researchDirectorSystemPromptSha256,
      invocationRunId: grant.context.invocationRunId,
    });
    return { ok: true, schema: "agentlas.science.manuscript-drafting-section-save-result/v1", ...result };
  }
  if (route === "/v1/platform/manuscript-drafting/assemble") {
    const result = store.assembleManuscriptDraftingSession({
      requestId: stableUuid(`science-manuscript-drafting-assemble:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      sessionId: exactText(body.session_id, 80, "science-manuscript-drafting-session-id-invalid"),
      expectedVersion: positiveInteger(body.expected_version, "science-manuscript-drafting-version-invalid"),
      expectedStateSha256: exactSha256(body.expected_state_sha256, "science-manuscript-drafting-state-invalid"),
    });
    return { ok: true, schema: "agentlas.science.manuscript-drafting-assemble-result/v1", session: result.session,
      manuscript: manuscriptRecord(result.manuscript, true), replayed: result.replayed };
  }
  if (route === "/v1/platform/manuscript-drafting/cancel") {
    const result = store.cancelManuscriptDraftingSession({
      requestId: stableUuid(`science-manuscript-drafting-cancel:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      sessionId: exactText(body.session_id, 80, "science-manuscript-drafting-session-id-invalid"),
      expectedVersion: positiveInteger(body.expected_version, "science-manuscript-drafting-version-invalid"),
      expectedStateSha256: exactSha256(body.expected_state_sha256, "science-manuscript-drafting-state-invalid"),
      reason: body.reason as string,
    });
    return { ok: true, schema: "agentlas.science.manuscript-drafting-cancel-result/v1", ...result };
  }
  if (route === "/v1/platform/manuscripts/create") {
    const blueprintBinding = body.blueprint_binding === undefined ? undefined : body.blueprint_binding as Record<string, unknown>;
    if (!blueprintBinding) throw new Error("science-manuscript-agent-blueprint-required");
    const exactBlueprintId = exactText(blueprintBinding.blueprint_id, 80, "science-manuscript-blueprint-binding-id-invalid");
    const exactBlueprintVersion = positiveInteger(blueprintBinding.blueprint_version, "science-manuscript-blueprint-binding-version-invalid");
    const exactBlueprintContentSha256 = exactSha256(blueprintBinding.blueprint_content_sha256, "science-manuscript-blueprint-binding-content-invalid");
    const exactBlueprint = store.getManuscriptBlueprintForProject(grant.context.projectId, exactBlueprintId);
    if (!exactBlueprint || exactBlueprint.status !== "current"
      || exactBlueprint.currentVersion !== exactBlueprintVersion
      || exactBlueprint.version.contentSha256 !== exactBlueprintContentSha256) {
      throw new Error("science-manuscript-agent-blueprint-not-current");
    }
    assertScienceAgentManuscriptDraft(String(body.markdown ?? ""), exactBlueprint.version.document);
    const result = store.createManuscript({
      requestId: stableUuid(`science-manuscript-create:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      title: body.title as string,
      markdown: body.markdown as string,
      bindings: body.bindings as ScienceManuscriptBindingInput[],
      blueprintBinding: {
        blueprintId: exactBlueprintId,
        blueprintVersion: exactBlueprintVersion,
        blueprintContentSha256: exactBlueprintContentSha256,
      } satisfies ScienceManuscriptBlueprintBindingInput,
    });
    return { ok: true, schema: "agentlas.science-manuscript-write-result/v1", manuscript: manuscriptRecord(result.manuscript, true), draftGate: assertScienceAgentManuscriptDraft(result.manuscript.version.markdown, exactBlueprint.version.document), replayed: result.replayed };
  }
  if (route === "/v1/platform/manuscripts/append-version") {
    const blueprintBinding = body.blueprint_binding === undefined ? undefined : body.blueprint_binding as Record<string, unknown>;
    const currentManuscript = store.getManuscriptForProject(
      grant.context.projectId,
      exactText(body.manuscript_id, 80, "science-manuscript-id-invalid"),
    );
    if (!currentManuscript) throw new Error("science-manuscript-not-found");
    const effectiveBinding = blueprintBinding ? {
      blueprintId: exactText(blueprintBinding.blueprint_id, 80, "science-manuscript-blueprint-binding-id-invalid"),
      blueprintVersion: positiveInteger(blueprintBinding.blueprint_version, "science-manuscript-blueprint-binding-version-invalid"),
      blueprintContentSha256: exactSha256(blueprintBinding.blueprint_content_sha256, "science-manuscript-blueprint-binding-content-invalid"),
    } : currentManuscript.version.blueprintBinding;
    if (!effectiveBinding) throw new Error("science-manuscript-agent-blueprint-required");
    const exactBlueprint = store.getManuscriptBlueprintForProject(grant.context.projectId, effectiveBinding.blueprintId);
    if (!exactBlueprint || exactBlueprint.status !== "current"
      || exactBlueprint.currentVersion !== effectiveBinding.blueprintVersion
      || exactBlueprint.version.contentSha256 !== effectiveBinding.blueprintContentSha256) {
      throw new Error("science-manuscript-agent-blueprint-not-current");
    }
    assertScienceAgentManuscriptDraft(String(body.markdown ?? ""), exactBlueprint.version.document);
    const result = store.appendManuscriptVersion({
      requestId: stableUuid(`science-manuscript-append:v1:${grant.context.invocationRunId}:${toolCallId}`),
      projectId: grant.context.projectId,
      manuscriptId: currentManuscript.id,
      expectedVersion: positiveInteger(body.expected_version, "science-manuscript-version-invalid"),
      expectedContentSha256: exactSha256(body.expected_content_sha256, "science-manuscript-content-invalid"),
      markdown: body.markdown as string,
      bindings: body.bindings as ScienceManuscriptBindingInput[],
      ...(blueprintBinding ? { blueprintBinding: effectiveBinding satisfies ScienceManuscriptBlueprintBindingInput } : {}),
    });
    return { ok: true, schema: "agentlas.science-manuscript-write-result/v1", manuscript: manuscriptRecord(result.manuscript, true), draftGate: assertScienceAgentManuscriptDraft(result.manuscript.version.markdown, exactBlueprint.version.document), replayed: result.replayed };
  }
  if (route === "/v1/platform/statistics/capabilities") {
    const coverageRelease = loadSciencePluginRuntime<{
      validateCoverageManifest(value: unknown): Record<string, unknown>;
    }>("agentlas-science-statistics", "runtime/coverage.cjs", 4 * 1024 * 1024);
    const figureRelease = loadSciencePluginRuntime<{
      validateFigureCatalog(value: unknown): { schema: string; catalogVersion: string; templates: Array<Record<string, unknown>> };
      summarizeFigureCatalog(catalog: unknown): Record<string, unknown>;
    }>("agentlas-science-statistics", "runtime/figure-catalog.cjs", 4 * 1024 * 1024);
    const engineRelease = loadSciencePluginRuntime<{
      METHOD_REGISTRY?: { definitions?: Array<{ method?: string; family?: string; linkage?: Record<string, unknown> }> };
    }>("agentlas-science-statistics", "runtime/engine.cjs", 16 * 1024 * 1024);
    if (coverageRelease.pluginRoot !== figureRelease.pluginRoot
      || coverageRelease.manifest.version !== figureRelease.manifest.version
      || coverageRelease.releaseSha256 !== figureRelease.releaseSha256
      || coverageRelease.pluginRoot !== engineRelease.pluginRoot
      || coverageRelease.manifest.version !== engineRelease.manifest.version
      || coverageRelease.releaseSha256 !== engineRelease.releaseSha256) {
      throw new Error("science-statistics-capabilities-runtime-drift");
    }
    // These two grow with the method registry, and a ceiling sized for an older catalogue turns
    // "we added methods" into "capabilities cannot be read at all". 179 methods already put the
    // coverage manifest past 256 KB, so both ceilings leave room for the registry to keep growing.
    const coverageFile = readSciencePluginFile("agentlas-science-statistics", "coverage-manifest.json", 2 * 1024 * 1024);
    const figureFile = readSciencePluginFile("agentlas-science-statistics", "figure-catalog.json", 2 * 1024 * 1024);
    if (coverageFile.pluginRoot !== coverageRelease.pluginRoot || figureFile.pluginRoot !== coverageRelease.pluginRoot
      || coverageFile.manifest.version !== coverageRelease.manifest.version
      || figureFile.manifest.version !== coverageRelease.manifest.version) {
      throw new Error("science-statistics-capabilities-data-drift");
    }
    const coverageRuntime = coverageRelease.runtime;
    const figureRuntime = figureRelease.runtime;
    let coverageValue: unknown;
    let figureValue: unknown;
    try {
      coverageValue = JSON.parse(coverageFile.bytes.toString("utf8"));
      figureValue = JSON.parse(figureFile.bytes.toString("utf8"));
    } catch {
      throw new Error("science-statistics-capabilities-json-invalid");
    }
    const loadedCoverage = coverageRuntime.validateCoverageManifest(coverageValue);
    const figureCatalog = figureRuntime.validateFigureCatalog(figureValue);
    const engineRuntime = engineRelease.runtime;
    // The coverage manifest says what each method implements and where it stops. It does not say
    // when a researcher would reach for it, and that is the question a method is chosen by. Every
    // definition already carries that -- neededWhen, the decision it settles, what it must show,
    // and what to do next -- generated and gated alongside the method itself, and nothing handed
    // it to the agent that has to pick. Choosing among every method in the registry by reading one
    // boundary paragraph each is not choosing.
    const firstSentence = (value: unknown): string | null => {
      const text = typeof value === "string" ? value.trim() : "";
      if (!text) return null;
      const boundary = text.search(/\.\s/u);
      return (boundary > 0 ? text.slice(0, boundary + 1) : text).slice(0, 240);
    };
    // A caller that has shortlisted asks for those methods by name and gets the whole linkage.
    const requestedDetail = new Set(Array.isArray(body.method_selection_detail)
      ? (body.method_selection_detail as unknown[]).map((value) => String(value)).slice(0, 40)
      : []);
    const selectionByMethod = new Map<string, Record<string, unknown>>();
    const compactByMethod = new Map<string, Record<string, unknown>>();
    for (const definition of engineRuntime.METHOD_REGISTRY?.definitions ?? []) {
      if (typeof definition?.method !== "string" || !definition.linkage) continue;
      const linkage = definition.linkage;
      selectionByMethod.set(definition.method, {
        family: definition.family ?? null,
        neededWhen: linkage.neededWhen ?? null,
        decision: linkage.decision ?? null,
        mustShow: linkage.mustShow ?? null,
        userGoal: linkage.userGoal ?? null,
        nextActions: Array.isArray(linkage.nextActions) ? linkage.nextActions : [],
      });
      compactByMethod.set(definition.method, {
        family: definition.family ?? null,
        // The opening sentence of neededWhen is what a shortlist is made from. The full guidance
        // for every method at once runs to hundreds of kilobytes, more context than reading it saves.
        neededWhen: firstSentence(linkage.neededWhen),
      });
    }
    const coverageMethods = Array.isArray(loadedCoverage.methods) ? loadedCoverage.methods as Array<Record<string, unknown>> : [];
    const coverage = {
      ...loadedCoverage,
      methods: coverageMethods.map((entry) => {
        if (typeof entry.method !== "string") return entry;
        const selection = requestedDetail.has(entry.method)
          ? selectionByMethod.get(entry.method)
          : compactByMethod.get(entry.method);
        return selection ? { ...entry, selection } : entry;
      }),
    };
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
        // A Data Table's SHAPE, when this artifact is one.
        //
        // Without it the columns of an uploaded table were invisible to the director: the workspace
        // carried only a semantic summary ("400 rows and 4 typed columns"), the visual route returns
        // science-artifact-visual-capture-missing for a table with no adopted capture, and the only
        // sanctioned way to get data into an analysis is a projection that must NAME its columns. A
        // live model spent three turns on this and wrote "the column names are genuinely
        // unavailable to me" -- it was right. Names and types only; no rows, so this carries no
        // measurement a caller could retype.
        table: dataTableShape(context.selectedVersion.payload),
      },
      visualObservation: observation ? {
        visualReviewEligible: observation.visualReviewEligible,
        visualCapture: observation.visualCapture,
      } : null,
      history,
    };
  }
  if (route === "/v1/platform/artifacts/inspect-numeric-values") {
    const result = store.inspectArtifactNumericValues({
      projectId: grant.context.projectId,
      artifactId: exactText(body.artifact_id, 80, "science-artifact-numeric-catalog-id-invalid"),
      artifactVersion: positiveInteger(body.artifact_version, "science-artifact-numeric-catalog-version-invalid"),
      artifactContentSha256: exactSha256(body.artifact_content_sha256, "science-artifact-numeric-catalog-content-invalid"),
      validationReceiptId: exactText(body.validation_receipt_id, 80, "science-artifact-numeric-catalog-receipt-invalid"),
      ...(body.json_pointer_prefix === undefined ? {} : {
        jsonPointerPrefix: exactText(body.json_pointer_prefix, 2_048, "science-artifact-numeric-catalog-prefix-invalid"),
      }),
      ...(body.after_json_pointer === undefined ? {} : {
        afterJsonPointer: exactText(body.after_json_pointer, 2_048, "science-artifact-numeric-catalog-cursor-invalid"),
      }),
      ...(body.limit === undefined ? {} : { limit: positiveInteger(body.limit, "science-artifact-numeric-catalog-limit-invalid") }),
    });
    return { ok: true, ...result };
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

async function runPaleontologyOccurrenceSearch(
  body: Record<string, unknown>,
  grant: Grant,
  toolCallId: string,
): Promise<Record<string, unknown>> {
  if (grant.context.workflowRoute === "dinosaur-comparative-proxy") {
    const state = grant.routeState;
    // Keep the first autonomous candidate batch bounded. Without this guard a
    // model can spend a whole turn fan-out searching taxon names instead of
    // advancing to the already available derived and comparative tools.
    if (state.paleontologyOccurrenceAttempts >= 4) {
      return {
        ok: true,
        schema: "agentlas.science.dinosaur-route-control/v1",
        dinosaurRoute: {
          stage: "candidate-search-budget-reached",
          nextTool: "build_extant_reference_assembly_manifest",
          catalogRunIds: [...state.autoAnalyzedPaleontologyCatalogRuns.keys()],
          stratigraphicRunIds: [...state.autoAnalyzedPaleontologyCatalogRuns.values()],
          instruction: "Stop searching PBDB in this turn. Use the existing exact catalog and stratigraphic run ids, then advance to the extant reference assembly and comparative route.",
        },
      };
    }
    state.paleontologyOccurrenceAttempts += 1;
  }
  const catalog = await sciencePaleontologyCatalogService().search({
    requestId: stableUuid(`science-paleontology-catalog:v1:${grant.context.invocationRunId}:${toolCallId}`),
    projectId: grant.context.projectId,
    conversationId: grant.context.conversationId,
    originMessageId: grant.context.originUserMessageId,
    taxonName: exactText(body.taxon_name, 500, "science-paleontology-taxon-invalid"),
    ...(body.page_size === undefined ? {} : { pageSize: boundedInteger(body.page_size, 1, 100, "science-paleontology-page-size-invalid") }),
    ...(body.max_pages === undefined ? {} : { maxPages: boundedInteger(body.max_pages, 1, 20, "science-paleontology-max-pages-invalid") }),
    ...(body.max_records === undefined ? {} : { maxRecords: boundedInteger(body.max_records, 1, 2_000, "science-paleontology-max-records-invalid") }),
    ...(body.title === undefined ? {} : { title: exactText(body.title, 240, "science-paleontology-title-invalid") }),
  });
  if (grant.context.workflowRoute !== "dinosaur-comparative-proxy") return { ok: true, ...catalog };

  // A dinosaur intake turn commonly produces several candidate occurrence
  // calls in parallel. Materialize the deterministic stratigraphic child at
  // the host boundary as soon as each catalog receipt exists so the model can
  // advance instead of spending the entire turn re-querying PBDB. This is not
  // a claim or a score; it is the next receipt in the already-pinned workflow.
  let stratigraphicRunId: string | null = null;
  if (!grant.routeState.autoAnalyzedPaleontologyCatalogRuns.has(catalog.runId)) {
    try {
      const analysis = await sciencePaleontologyAnalysisService().analyzeStratigraphicEvidence({
        requestId: stableUuid(`science-dinosaur-route:stratigraphic:v1:${grant.context.invocationRunId}:${catalog.runId}`),
        projectId: grant.context.projectId,
        conversationId: grant.context.conversationId,
        originMessageId: grant.context.originUserMessageId,
        catalogRunId: catalog.runId,
        title: `Stratigraphic support · ${catalog.taxon.acceptedName}`,
      });
      stratigraphicRunId = analysis.runId;
      grant.routeState.autoAnalyzedPaleontologyCatalogRuns.set(catalog.runId, analysis.runId);
    } catch {
      // Keep the occurrence receipt usable. The model receives no fabricated
      // child id and can call the public stratigraphic tool explicitly.
    }
  }
  return {
    ok: true,
    ...catalog,
    dinosaurRoute: {
      schema: "agentlas.science.dinosaur-route-advance/v1",
      stage: stratigraphicRunId ? "stratigraphic-support-materialized" : "occurrence-only",
      catalogRunId: catalog.runId,
      ...(stratigraphicRunId ? { stratigraphicRunId } : {}),
      catalogRunIds: [...grant.routeState.autoAnalyzedPaleontologyCatalogRuns.keys()],
      stratigraphicRunIds: [...grant.routeState.autoAnalyzedPaleontologyCatalogRuns.values()],
      nextTool: stratigraphicRunId ? "build_extant_reference_assembly_manifest" : "analyze_paleontology_stratigraphic_support",
      boundary: "Fossil occurrence and stratigraphic support do not establish DNA, a genome, an embryo, hatching, or biological revival.",
    },
  };
}

async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  if (request.method !== "POST") {
    respond(response, 404, { ok: false, code: "science-tool-control-not-found" });
    return;
  }
  const grant = authorize(request.headers.authorization);
  if (!grant) {
    // A stale grant looks identical to a missing one from the model's side; say which route asked.
    console.error(`[science-tool] refused route=${String(request.url ?? "")} code=science-tool-control-unauthorized`);
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
    // The call id exists to make a repeated call idempotent, not to prove the caller is polite.
    //
    // Requiring the model to invent one made every runtime that bridges MCP generically fail here:
    // measured on a live study under the Antigravity runtime, which calls through a single
    // `call_mcp_tool` and forwards no id, so the very first workspace inspection was refused with
    // `science-tool-call-id-invalid` and the study could not start. Derive it instead, from the
    // grant and the exact request, which is deterministic for the same call and different for a
    // different one -- the property idempotency actually needs.
    const declaredCallId = typeof body.tool_call_id === "string" ? body.tool_call_id.trim() : "";
    if (declaredCallId.length > 160) throw new Error("science-tool-call-id-invalid");
    const toolCallId = declaredCallId
      || `derived-${createHash("sha256").update(`${grant.context.invocationRunId}\u0000${route}\u0000${JSON.stringify(body)}`).digest("hex").slice(0, 32)}`;
    if (route === "/v1/platform/astronomy/catalog-search") {
      exactToolBody(body, ["tool_call_id", "center_ra_deg", "center_dec_deg", "radius_deg", "limit", "title"], "science-astronomy-catalog-input-invalid");
    }
    assertExactToolInputSchema(
      body,
      platformTool?.inputSchema ?? descriptorTool?.mcp.inputSchema,
      "science-tool-input-schema-invalid",
    );
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
      : route === "/v1/platform/paleontology/occurrence-search"
        ? await runPaleontologyOccurrenceSearch(body, grant, toolCallId)
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
      : route === "/v1/platform/earth-science/noaa-coops-water-levels"
        ? { ok: true, ...await scienceNoaaCoopsWaterLevelService().retrieve({
            requestId: stableUuid(`science-noaa-coops-water-level:v1:${grant.context.invocationRunId}:${toolCallId}`),
            projectId: grant.context.projectId,
            conversationId: grant.context.conversationId,
            originMessageId: grant.context.originUserMessageId,
            stationId: exactPatternText(body.station_id, 7, /^\d{7}$/, "science-noaa-coops-station-invalid"),
            startTime: exactText(body.start_time, 80, "science-noaa-coops-start-time-invalid"),
            endTime: exactText(body.end_time, 80, "science-noaa-coops-end-time-invalid"),
            datum: exactText(body.datum, 8, "science-noaa-coops-datum-invalid") as "CRD" | "IGLD" | "LWD" | "MHHW" | "MHW" | "MTL" | "MSL" | "MLW" | "MLLW" | "NAVD" | "STND",
            ...(body.units === undefined ? {} : { units: exactText(body.units, 16, "science-noaa-coops-units-invalid") as "metric" | "english" }),
            ...(body.title === undefined ? {} : { title: exactText(body.title, 240, "science-noaa-coops-title-invalid") }),
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
      : route === "/v1/platform/economics/world-bank-growth-analysis"
        ? { ok: true, ...await scienceEconomicsAnalysisService().analyze({
            requestId: stableUuid(`science-economics-growth:v1:${grant.context.invocationRunId}:${toolCallId}`),
            projectId: grant.context.projectId,
            conversationId: grant.context.conversationId,
            originMessageId: grant.context.originUserMessageId,
            parentRunId: exactText(body.parent_run_id, 80, "science-economics-growth-parent-run-invalid"),
            ...(body.title === undefined ? {} : { title: exactText(body.title, 240, "science-economics-growth-title-invalid") }),
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
      : route === "/v1/platform/genomics/extant-reference-assemblies"
        ? extantReferenceAssemblyResultRecord(await scienceExtantReferenceAssemblyService().build({
            requestId: stableUuid(`science-extant-reference-assembly:v1:${grant.context.invocationRunId}:${toolCallId}`),
            projectId: grant.context.projectId,
            conversationId: grant.context.conversationId,
            originMessageId: grant.context.originUserMessageId,
            species: Array.isArray(body.species) ? body.species.map((value) => exactText(value, 80, "science-extant-reference-assembly-species-invalid")) : (() => { throw new Error("science-extant-reference-assembly-species-invalid"); })(),
            ...(body.title === undefined ? {} : { title: exactText(body.title, 240, "science-extant-reference-assembly-title-invalid") }),
          }))
      : route === "/v1/platform/genomics/comparative-gene-tree"
        ? await (async () => {
            const comparative = await scienceComparativeGenomicsService().build({
              requestId: stableUuid(`science-comparative-genomics-gene-tree:v1:${grant.context.invocationRunId}:${toolCallId}`),
              projectId: grant.context.projectId,
              conversationId: grant.context.conversationId,
              originMessageId: grant.context.originUserMessageId,
              species: exactText(body.species, 80, "science-comparative-genomics-species-invalid"),
              geneId: exactText(body.gene_id, 80, "science-comparative-genomics-gene-id-invalid"),
              pruneTaxon: positiveInteger(body.prune_taxon, "science-comparative-genomics-prune-taxon-invalid"),
              sequenceType: exactText(body.sequence_type, 12, "science-comparative-genomics-sequence-type-invalid") as "protein" | "cdna",
              ...(body.title === undefined ? {} : { title: exactText(body.title, 240, "science-comparative-genomics-title-invalid") }),
            });
            const record = comparativeGenomicsResultRecord(comparative);
            const routeMetadata = dinosaurComparativeRouteMetadata(comparative.assessment, grant);
            return routeMetadata ? { ...record, dinosaurRoute: routeMetadata } : record;
          })()
      : route === "/v1/platform/genomics/comparative-publication-table"
        ? comparativeGenomicsTableResultRecord(scienceComparativeGenomicsTableService().materialize({
            requestId: stableUuid(`science-comparative-genomics-publication-table:v1:${grant.context.invocationRunId}:${toolCallId}`),
            projectId: grant.context.projectId,
            parentRunId: exactText(body.parent_run_id, 36, "science-comparative-genomics-parent-run-invalid"),
            ...(body.title === undefined ? {} : { title: exactText(body.title, 240, "science-comparative-genomics-title-invalid") }),
          }))
      : route === "/v1/platform/genomics/hypothetical-asr-fitch"
        ? hypotheticalAsrResultRecord(scienceHypotheticalAsrService().reconstruct({
            requestId: stableUuid(`science-hypothetical-asr-fitch:v1:${grant.context.invocationRunId}:${toolCallId}`),
            projectId: grant.context.projectId,
            parentRunId: exactText(body.parent_run_id, 36, "science-hypothetical-asr-parent-run-invalid"),
            targetNodeId: exactPatternText(body.target_node_id, 80, /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, "science-hypothetical-asr-target-node-invalid"),
          }))
      : route === "/v1/platform/genomics/extant-archosaur-locus-panel"
        ? extantArchosaurLocusPanelResultRecord(scienceExtantArchosaurLocusPanelService().materialize({
            requestId: stableUuid(`science-extant-archosaur-locus-panel:v1:${grant.context.invocationRunId}:${toolCallId}`),
            projectId: grant.context.projectId,
            conversationId: grant.context.conversationId,
            originMessageId: grant.context.originUserMessageId,
            parentRunId: exactText(body.parent_run_id, 36, "science-extant-archosaur-locus-panel-parent-run-invalid"),
            referenceAssemblyRunId: exactText(body.reference_assembly_run_id, 36, "science-extant-archosaur-locus-panel-assembly-run-invalid"),
            avianLeafNodeIds: Array.isArray(body.avian_leaf_node_ids)
              ? body.avian_leaf_node_ids.map((value) => exactPatternText(value, 80, /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, "science-extant-archosaur-locus-panel-avian-leaf-invalid"))
              : (() => { throw new Error("science-extant-archosaur-locus-panel-avian-leaves-invalid"); })(),
            crocodilianLeafNodeIds: Array.isArray(body.crocodilian_leaf_node_ids)
              ? body.crocodilian_leaf_node_ids.map((value) => exactPatternText(value, 80, /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, "science-extant-archosaur-locus-panel-crocodilian-leaf-invalid"))
              : (() => { throw new Error("science-extant-archosaur-locus-panel-crocodilian-leaves-invalid"); })(),
            ...(body.title === undefined ? {} : { title: exactText(body.title, 240, "science-extant-archosaur-locus-panel-title-invalid") }),
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
    // Every successful tool call carries where the STUDY stands. The workspace response alone was
    // not enough: a live model called the statistics tool eighteen times across six turns without
    // ever asking the workspace again, so it never saw that the study had not left intake. This is
    // the one place every tool result passes through, and it is computed from stored state rather
    // than remembered, so it cannot claim a study is blocked when it is not.
    respond(response, 200, withStudyProgress(result, grant.context.projectId));
  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 240) : "science-tool-control-failed";
    // A refused tool call left no trace anywhere an operator could reach: the turn event records
    // only isError, and the code lived solely in the model's own tool result. So a study that could
    // not call a single Science tool looked, from every log and every screen, exactly like a study
    // whose model chose not to. Measured: six live runs, every Science call refused, and the only
    // report of it was the model saying "the Science host declined". Route and code only -- never
    // the body, which carries project content.
    console.error(`[science-tool] refused route=${route} code=${code}`);
    respond(response, 400, scienceToolErrorPayload(route, error));
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
async function handle(req){if(req.method==="initialize")return{protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"agentlas-science",version:"2.1.0"}};if(req.method==="notifications/initialized")return;if(req.method==="ping")return{};if(req.method==="tools/list")return{tools};if(req.method!=="tools/call")throw Object.assign(new Error("Method not found"),{code:-32601});const route=req.params&&byName.get(req.params.name);if(!route)return result({ok:false,code:"science-tool-unknown"},true);let response;try{response=await fetch(endpoint+route,{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify(req.params.arguments||{})})}catch(error){return result({ok:false,code:"science-tool-transport-failed",detail:String(error&&error.message?error.message:error).slice(0,200),endpoint},true)}const text=await response.text();let value;try{value=JSON.parse(text)}catch{value={ok:false,code:"science-tool-invalid-response",status:response.status,body:text.slice(0,200)}}return result(value,!response.ok||value.ok!==true)}
function emit(req,payload){if(req.id===undefined||payload===undefined)return;process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:req.id,result:payload})+"\n")}
let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>{input+=chunk;let i;while((i=input.indexOf("\n"))>=0){const line=input.slice(0,i).replace(/\r$/,"");input=input.slice(i+1);if(!line)continue;let req;try{req=JSON.parse(line);Promise.resolve(handle(req)).then(value=>emit(req,value)).catch(error=>{if(req.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:req.id,error:{code:Number(error&&error.code)||-32603,message:"Agentlas Science tool failed."}})+"\n")})}catch{} }if(Buffer.byteLength(input,"utf8")>MAX)process.exit(78)});`;

function writePrivate(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.renameSync(temp, target);
  if (process.platform !== "win32") fs.chmodSync(target, 0o600);
}

/**
 * A Codex home that carries this turn's Science boundary and nothing the machine happens to have.
 *
 * Codex reads `$CODEX_HOME` for both its MCP server table and its global AGENTS.md. Inheriting the
 * user's home meant a Science turn silently ran with every server that machine had installed and a
 * 13 KB global router persona on top of the Research Director's own contract -- measured on a live
 * astronomy study: 58 bash calls, 8 repl calls, and calls into an unrelated network server, against
 * ZERO Science tools, while the turn's own prompt said "Agentlas Science is the only MCP server
 * enabled for this turn". The sentence was true of the config we wrote and false of the process we
 * launched, which is the worst combination: the boundary reads as enforced and is not.
 *
 * Only `auth.json` is carried over, by symlink so a token refresh still lands in the real home.
 * Everything else is left behind on purpose; a file this directory does not have is a capability
 * this turn does not get.
 */
function materializeScienceCodexHome(invocationRunId: string, serverKey: string, command: string, args: string[], env: Record<string, string>): string {
  const home = userDataPath("science-codex-home", invocationRunId);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const config = [
    "# Generated per Science turn. Not user configuration -- edits here are discarded.",
    // Codex asks for approval before each MCP tool call. A Science turn runs non-interactively, so
    // there is nobody to answer, and Codex records every call as "user rejected MCP tool call" --
    // a user who was never asked. Measured: every Science tool call in six live runs failed this
    // way, before reaching this process, which is why no refusal ever appeared in our own logs.
    //
    // This is not a widening. The isolated home declares exactly ONE server, whose tools are all
    // host-owned and revalidated by ScienceStore; shell and files stay bounded by the --sandbox
    // flag the runner passes, which this does not touch.
    'approval_policy = "never"',
    "",
    `[mcp_servers.${serverKey}]`,
    `command = ${toml(command)}`,
    `args = ${tomlArray(args)}`,
    // The inline server is a single -e program; a slow first launch must not read as "no tools".
    "startup_timeout_sec = 120",
    "",
    // `env` carries VALUES. An earlier version wrote `env_vars` with names, which Codex does not
    // recognise at all: the child started with none of the three variables it requires, exited 78
    // immediately, and the turn ran with no Science tools while still claiming to have them. The
    // model said so out loud -- "the Agentlas Science analysis tools are not accessible" -- which is
    // the only reason this was ever visible.
    `[mcp_servers.${serverKey}.env]`,
    ...Object.entries(env).map(([key, value]) => `${key} = ${toml(value)}`),
    "",
  ].join("\n");
  const temp = `${path.join(home, "config.toml")}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, config, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, path.join(home, "config.toml"));

  // Sign-in state is the one thing the isolated home cannot invent. A symlink keeps the refresh
  // write landing in the real home, so isolating a turn never costs the user their session.
  const realHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const auth = path.join(realHome, "auth.json");
  const link = path.join(home, "auth.json");
  try {
    if (fs.existsSync(auth) && !fs.existsSync(link)) fs.symlinkSync(auth, link);
  } catch {
    // No sign-in file to carry, or the link already exists. Codex reports its own auth failure,
    // which is a better message than anything this function could invent.
  }
  return home;
}

function toml(value: string): string { return JSON.stringify(value); }
function tomlArray(values: string[]): string { return `[${values.map(toml).join(",")}]`; }

function validatedCatalog(value: unknown): ScienceLabCapabilityCatalog {
  const descriptor = parseScienceServiceDescriptor(value);
  if (descriptor.tools.some((tool) => !IMPLEMENTED_TOOL_IDS.has(tool.id))) throw new Error("science-service-tool-adapter-unavailable");
  return scienceLabCapabilityCatalog(descriptor);
}

export function assertScienceExtensionReleaseHostCompatibility(release: {
  releaseDir: string;
  manifest: ProductExtensionManifest;
}): ScienceLabCapabilityCatalog {
  if (!release.manifest.permissions.includes("science:compute") || !release.manifest.serviceEntry) {
    throw new Error("science-service-not-authorized");
  }
  const servicePath = path.join(release.releaseDir, release.manifest.serviceEntry);
  const stat = fs.lstatSync(servicePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 2 || stat.size > 256 * 1024) throw new Error("science-service-entry-invalid");
  const descriptorValue = JSON.parse(fs.readFileSync(servicePath, "utf8"));
  const descriptor = parseScienceServiceDescriptor(descriptorValue);
  const compatibilityRelativePath = path.posix.join(path.posix.dirname(release.manifest.serviceEntry), "host-compatibility.json");
  const compatibilityManifestFile = release.manifest.files.find((file) => file.path === compatibilityRelativePath);
  if (!compatibilityManifestFile) throw new Error("science-extension-host-compatibility-missing");
  const compatibilityPath = path.join(release.releaseDir, compatibilityRelativePath);
  const compatibilityStat = fs.lstatSync(compatibilityPath);
  if (compatibilityStat.isSymbolicLink() || !compatibilityStat.isFile() || compatibilityStat.size < 2 || compatibilityStat.size > 64 * 1024) {
    throw new Error("science-extension-host-compatibility-invalid");
  }
  const compatibilityBytes = fs.readFileSync(compatibilityPath);
  if (compatibilityStat.size !== compatibilityManifestFile.size
    || createHash("sha256").update(compatibilityBytes).digest("hex") !== compatibilityManifestFile.sha256) {
    throw new Error("science-extension-host-compatibility-integrity-invalid");
  }
  assertScienceExtensionHostCompatibility(JSON.parse(compatibilityBytes.toString("utf8")), {
    extensionId: release.manifest.id,
    extensionVersion: release.manifest.version,
    minimumDesktopVersion: release.manifest.minimumDesktopVersion,
    serviceEntry: release.manifest.serviceEntry,
    descriptorSchema: descriptor.schema,
    protocolVersion: descriptor.protocolVersion,
    desktopHost: scienceDesktopHostCompatibilitySnapshot(),
  });
  return validatedCatalog(descriptorValue);
}

async function assertScienceServiceAuthority(testDescriptor?: unknown): Promise<ScienceLabCapabilityCatalog> {
  if (testDescriptor !== undefined) {
    if (process.env.AGENTLAS_SCIENCE_MCP_CONTRACT !== "1") throw new Error("science-service-test-authority-denied");
    return validatedCatalog(testDescriptor);
  }
  const { activeScienceExtension } = await import("../extensions/science");
  const release = activeScienceExtension();
  if (!release) throw new Error("science-service-not-authorized");
  return assertScienceExtensionReleaseHostCompatibility(release);
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
  const exactToolApprovalConfigArgs = scienceCodexExactToolApprovalConfigArgs(
    await installedCodexSupportsExactMcpToolApproval(),
  );
  const controlEndpoint = await ensureServer();
  const token = randomBytes(32).toString("base64url");
  grants.set(context.invocationRunId, {
    tokenHash: tokenHash(token),
    context: { ...context },
    catalog,
    expiresAt: Date.now() + 60 * 60_000,
    routeState: {
      paleontologyOccurrenceAttempts: 0,
      autoAnalyzedPaleontologyCatalogRuns: new Map<string, string>(),
    },
  });
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
      "-c", `mcp_servers.${SERVER_KEY}.startup_timeout_sec=120`,
      // Values, not names. `env_vars` is not a key Codex knows, so the server it declared could
      // never start: the child exits 78 without these three, and the turn silently had no tools.
      "-c", `mcp_servers.${SERVER_KEY}.env.ELECTRON_RUN_AS_NODE=${toml("1")}`,
      "-c", `mcp_servers.${SERVER_KEY}.env.${TOKEN_ENV}=${toml(token)}`,
      "-c", `mcp_servers.${SERVER_KEY}.env.${ENDPOINT_ENV}=${toml(controlEndpoint)}`,
      "-c", `mcp_servers.${SERVER_KEY}.env.${CATALOG_ENV}=${toml(encodedCatalog)}`,
      ...exactToolApprovalConfigArgs,
    ],
    runtimeEnv: {
      [TOKEN_ENV]: token, [ENDPOINT_ENV]: controlEndpoint, [CATALOG_ENV]: encodedCatalog,
      // The config args above only ADD our server to whatever Codex already had. The isolated home
      // is what makes "only this server" true of the launched process rather than of our file.
      CODEX_HOME: materializeScienceCodexHome(context.invocationRunId, SERVER_KEY, process.execPath, args, {
        // Without this the command is Electron, and Codex launches it as a GUI application instead
        // of a Node process: no stdio, no MCP handshake, no tools -- and the window never exits.
        // Measured: ten orphaned Electron processes, one per turn, while every turn reported that
        // the Science tools were unavailable. The JSON config for the other runtime always had it;
        // the Codex declaration never did.
        ELECTRON_RUN_AS_NODE: "1",
        [TOKEN_ENV]: token, [ENDPOINT_ENV]: controlEndpoint, [CATALOG_ENV]: encodedCatalog,
      }),
    },
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
