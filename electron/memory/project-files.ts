// Per-project memory artifacts inside the user's working folder:
//   <folder>/.agentlas/project-soul-memory.md  — human-readable durable memory (PM Soul)
//   <folder>/.agentlas/sitemap.json            — AI Sitemap (Task Bias governance)
//   <folder>/.agentlas/memory-log.jsonl        — append-only curated event log
//
// These are intentionally plain files: portable, diff-able, and visible to the user.
import fs from "node:fs";
import path from "node:path";
import {
  CURATOR_DECISIONS_FILE,
  MEMORY_LOG_FILE,
  PROJECT_MEMORY_DIR,
  PROJECT_SOUL_FILE,
  SITEMAP_FILE,
  SKILL_REGISTRY_FILE,
  SKILL_TRIALS_FILE,
  SUPER_ONTOLOGY_CONTRACT_FILE,
  SUPER_ONTOLOGY_ASSURANCE_CASE_FILE,
  SUPER_ONTOLOGY_CONTEXTUAL_FLOW_FILE,
  SUPER_ONTOLOGY_CAUSAL_IMPACT_FILE,
  SUPER_ONTOLOGY_EVIDENCE_FILE,
  SUPER_ONTOLOGY_MEMORY_BRIDGE_FILE,
  SUPER_ONTOLOGY_REPLAYS_FILE,
  SUPER_ONTOLOGY_TASK_COVERAGE_FILE,
} from "../architecture/manifest";

export function projectMemoryDir(projectPath: string): string {
  return path.join(projectPath, PROJECT_MEMORY_DIR);
}

const AUTO_SECTION = "## Auto-curated memory";

function soulTemplate(projectName: string): string {
  return `# Project Soul Memory: ${projectName}

Durable memory for this project folder, maintained by the Agentlas PM Soul.
Keep it concise. Auto-curated items are appended under the last section.

## Project Purpose

## Current State

## Decisions

| Date | Decision | Rationale | Evidence |
|------|----------|-----------|----------|

## Pending Work

| Owner | Workstream | Next Action | Status |
|-------|------------|-------------|--------|

## Risks

| Risk | Impact | Mitigation | Status |
|------|--------|------------|--------|

## User Preferences

## Lessons Learned

${AUTO_SECTION}
`;
}

function sitemapSkeleton(projectName: string, now: string): string {
  return JSON.stringify(
    {
      project: projectName,
      created_at: now,
      updated_at: now,
      priority_policy:
        "priority = risk_weight*risk + (1 - completion_score) + staleness + blocking_dependencies",
      nodes: [],
    },
    null,
    2,
  );
}

function skillRegistrySkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-skill-lifecycle-registry",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      defaultTier: "candidate",
      runtimeFirstClassRecallEnabled: false,
      predicatesRequired: true,
      curatorQuarantineRequired: true,
      evidenceLedgers: {
        trials: `.agentlas/${SKILL_TRIALS_FILE}`,
        curatorDecisions: `.agentlas/${CURATOR_DECISIONS_FILE}`,
        memoryEvents: `.agentlas/${MEMORY_LOG_FILE}`,
      },
      hardStops: [
        "permission_change",
        "credential_change",
        "payment_or_billing_effect",
        "regulated_or_irreversible_side_effect",
        "same_authority_patch_and_validator",
        "holdout_contamination",
        "missing_rollback_snapshot",
      ],
      effectiveErrorBudgetTerms: [
        "first_class_error_mass",
        "quarantine_false_accept_estimate",
        "blind_spot_estimate",
        "drift_estimate",
      ],
      niches: [],
      skills: [],
      rolloutPolicy: {
        staticOnlyCanApprove: false,
        sandboxRequired: true,
        holdoutRequired: true,
        shadowRequiredForFastPathChanges: true,
        lowRiskCanaryOnly: true,
        severeFailureTolerance: 0,
      },
    },
    null,
    2,
  );
}

function superOntologyContractSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-contract",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimeGraphWriteEnabled: false,
      zeroErrorClaim: false,
      layers: [
        "source_intake",
        "evidence_packet",
        "belief_ledger",
        "knowledge_capsule",
        "affordance_action_binding",
        "agentlas_integration_contract",
        "memory_curator_bridge",
        "task_coverage_contract",
        "contextual_flow_contract",
        "causal_impact_contract",
        "assurance_case_contract",
        "promotion_readiness",
        "promotion_replay_drill",
        "architecture_sync_review",
      ],
      evidenceLedgers: {
        replays: `.agentlas/${SUPER_ONTOLOGY_REPLAYS_FILE}`,
        promotionEvidence: `.agentlas/${SUPER_ONTOLOGY_EVIDENCE_FILE}`,
        memoryTickets: `.agentlas/${MEMORY_LOG_FILE}`,
        memoryCuratorBridge: `.agentlas/${SUPER_ONTOLOGY_MEMORY_BRIDGE_FILE}`,
        taskCoverage: `.agentlas/${SUPER_ONTOLOGY_TASK_COVERAGE_FILE}`,
        contextualFlow: `.agentlas/${SUPER_ONTOLOGY_CONTEXTUAL_FLOW_FILE}`,
        causalImpact: `.agentlas/${SUPER_ONTOLOGY_CAUSAL_IMPACT_FILE}`,
        assuranceCase: `.agentlas/${SUPER_ONTOLOGY_ASSURANCE_CASE_FILE}`,
      },
      hardStops: [
        "zero_error_claim",
        "raw_source_to_graph_write",
        "forbidden_context_join",
        "whole_graph_exposure",
        "tool_authority_without_provenance",
        "appbridge_source_of_truth_write",
        "missing_rollback",
        "missing_shadow_or_canary_evidence",
        "missing_memory_curator_bridge",
        "missing_task_coverage_contract",
        "missing_contextual_flow_contract",
        "forbidden_context_flow",
        "missing_causal_impact_contract",
        "missing_assurance_case_contract",
        "correlation_as_causation",
        "unsupported_claim",
        "direct_durable_memory_write",
        "raw_prompt_or_secret_memory_capture",
      ],
      promotionPolicy: {
        shadowRequired: true,
        canaryRequiredForMixedContext: true,
        rollbackRequired: true,
        syncReviewRequired: true,
        appbridgeSourceWritesBlocked: true,
        memoryCuratorBridgeRequired: true,
        taskCoverageRequired: true,
        contextualFlowRequired: true,
        causalImpactRequired: true,
        assuranceCaseRequired: true,
        directDurableMemoryWritesBlocked: true,
      },
      surfacePolicy: {
        desktopTerminal: {
          defaultDecision: "shadow_required",
          notes: "Local graph-write behavior needs permission audit and replay.",
        },
        appbridge: {
          defaultDecision: "blocked",
          notes: "AppBridge remains a route adapter, never the source of truth.",
        },
      },
    },
    null,
    2,
  );
}

function superOntologyContextualFlowSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-contextual-flow",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision: "contextual_flow_required_before_boundary_crossing",
      flowStages: [
        "user_to_agent",
        "agent_to_tool",
        "tool_to_agent",
        "agent_to_agent",
        "agent_to_memory",
        "agent_to_output",
        "agent_to_public_surface",
      ],
      contexts: ["personal", "company", "customer", "public", "regulated", "agent_internal"],
      requiredParameters: [
        "source_context",
        "target_context",
        "sender_role",
        "recipient_role",
        "subject_role",
        "attribute_type",
        "transmission_principle",
        "purpose",
        "authority_basis",
        "sensitivity",
        "retention_policy",
        "audit_refs",
      ],
      decisions: ["allow", "redact", "aggregate_only", "review_required", "block"],
      researchBasis: [
        "contextual_integrity",
        "privacy_flow_graph",
        "multi_agent_contextual_privacy",
        "compositional_privacy",
        "information_flow_control",
        "nist_ai_rmf_gai_profile",
        "w3c_prov",
        "stpa_mode_confusion",
      ],
      hardStops: [
        "same_user_means_all_contexts_joinable",
        "tool_response_as_need_to_know",
        "public_output_after_private_handoff",
        "raw_prompt_or_transcript_to_memory",
        "customer_data_to_public_surface_without_consent",
        "regulated_data_to_training_without_consent_delete_path",
        "agent_internal_trace_to_user_output",
        "cross_project_join_without_scope_review",
      ],
    },
    null,
    2,
  );
}

function superOntologyCausalImpactSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-causal-impact",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision: "counterfactual_required_before_state_change",
      causalClaimTypes: [
        "correlation_only",
        "causal_hypothesis",
        "intervention",
        "counterfactual",
        "temporal_causal",
        "memory_intervention",
        "multi_agent_plan",
        "external_side_effect",
        "physical_or_train",
      ],
      requiredChecks: [
        "intervention_target",
        "expected_outcomes",
        "adverse_outcomes",
        "counterfactual_checks",
        "observability",
        "reversibility",
        "blast_radius",
        "blocked_write_surfaces",
        "rollback_plan",
      ],
      decisions: [
        "allow_read",
        "draft_only",
        "review_required",
        "shadow_required",
        "block",
      ],
      researchBasis: [
        "causal_rag",
        "causal_counterfactual_rag",
        "counterfactual_benchmark",
        "causal_planning",
        "causal_memory_intervention",
        "structural_causal_model",
        "resilience_engineering",
        "systems_theory",
      ],
      hardStops: [
        "correlation_as_causation",
        "retrieved_relation_as_action_permission",
        "missing_counterfactual_check",
        "missing_adverse_outcome",
        "missing_blast_radius",
        "missing_observability",
        "state_change_without_rollback",
        "physical_action_without_human_protocol",
        "training_without_consent_or_delete_path",
        "multi_agent_write_without_ordered_handoff",
      ],
    },
    null,
    2,
  );
}

function superOntologyAssuranceCaseSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-assurance-case",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision: "evidence_linked_claim_required",
      claimTypes: [
        "scope_boundary",
        "source_provenance",
        "knowledge_integrity",
        "memory_safety",
        "action_safety",
        "task_coverage",
        "world_coverage",
        "promotion_safety",
        "sync_integrity",
        "red_team_reporting",
        "rejected_overclaim",
      ],
      evidenceKinds: [
        "schema_check",
        "fixture_check",
        "public_safety_check",
        "typecheck",
        "build",
        "sync_check",
        "shadow_replay",
        "canary_replay",
        "rollback_drill",
        "constraint_validation",
        "provenance_standard",
        "official_standard",
        "red_team_report",
        "human_review",
        "rejected_claim",
      ],
      validators: [
        "json_schema",
        "jsonl_fixture_checker",
        "public_safety_scan",
        "typecheck",
        "sync_gate",
        "shadow_canary_replay",
        "rollback_drill",
        "provenance_ledger",
        "constraint_shape",
        "red_team_question_bank",
        "human_review_queue",
      ],
      researchBasis: [
        "assurance_case",
        "argument_graph",
        "compliance_by_construction",
        "w3c_prov",
        "w3c_shacl",
        "nist_ai_rmf_gai_profile",
        "genai_red_team_reporting",
        "llm_kg_construction",
        "ontology_validation",
        "no_free_lunch",
      ],
      hardStops: [
        "unsupported_claim",
        "missing_required_evidence",
        "hidden_missing_evidence",
        "missing_validator",
        "missing_residual_risk",
        "missing_rollback_plan",
        "perfect_or_zero_error_claim",
        "red_team_without_followup",
        "runtime_claim_without_shadow_or_canary",
        "appbridge_source_of_truth_claim",
      ],
    },
    null,
    2,
  );
}

function superOntologyTaskCoverageSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-task-coverage",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      taskFamilies: [
        "retrieve_answer",
        "summarize_synthesize",
        "draft_artifact",
        "transform_format",
        "analyze_decide",
        "plan_sequence",
        "coordinate_social",
        "execute_tool",
        "monitor_repair",
        "personalize_memory",
        "regulated_boundary",
        "multimodal_generate",
        "physical_or_sensor",
        "software_change",
        "financial_or_compliance",
        "education_or_coaching",
      ],
      affordanceTypes: [
        "read",
        "draft",
        "write",
        "publish",
        "execute",
        "physical",
        "train",
      ],
      evidenceModes: [
        "citation",
        "current_approved_source",
        "owner_authority",
        "policy_or_law",
        "measurement_or_dataset",
        "license_or_consent",
        "runtime_test",
        "rollback_plan",
      ],
      defaultDecision: "classify_before_action",
      hardStops: [
        "missing_task_family",
        "missing_affordance_type",
        "missing_evidence_mode",
        "write_without_rollback",
        "publish_execute_physical_or_train_without_authority",
      ],
    },
    null,
    2,
  );
}

/** Create .agentlas/ + skeleton files if missing. Returns the dir, or null on failure. */
export function ensureProjectMemory(
  projectPath: string,
  projectName?: string,
): string | null {
  try {
    const dir = projectMemoryDir(projectPath);
    fs.mkdirSync(dir, { recursive: true });
    const name = projectName || path.basename(projectPath) || "Project";
    const now = new Date().toISOString();

    const soul = path.join(dir, PROJECT_SOUL_FILE);
    if (!fs.existsSync(soul)) fs.writeFileSync(soul, soulTemplate(name), "utf8");

    const sitemap = path.join(dir, SITEMAP_FILE);
    if (!fs.existsSync(sitemap)) fs.writeFileSync(sitemap, sitemapSkeleton(name, now), "utf8");

    const skillRegistry = path.join(dir, SKILL_REGISTRY_FILE);
    if (!fs.existsSync(skillRegistry)) fs.writeFileSync(skillRegistry, skillRegistrySkeleton(name), "utf8");

    const skillTrials = path.join(dir, SKILL_TRIALS_FILE);
    if (!fs.existsSync(skillTrials)) fs.writeFileSync(skillTrials, "", "utf8");

    const curatorDecisions = path.join(dir, CURATOR_DECISIONS_FILE);
    if (!fs.existsSync(curatorDecisions)) fs.writeFileSync(curatorDecisions, "", "utf8");

    const superOntologyContract = path.join(dir, SUPER_ONTOLOGY_CONTRACT_FILE);
    if (!fs.existsSync(superOntologyContract)) {
      fs.writeFileSync(superOntologyContract, superOntologyContractSkeleton(name), "utf8");
    }

    const superOntologyTaskCoverage = path.join(dir, SUPER_ONTOLOGY_TASK_COVERAGE_FILE);
    if (!fs.existsSync(superOntologyTaskCoverage)) {
      fs.writeFileSync(superOntologyTaskCoverage, superOntologyTaskCoverageSkeleton(name), "utf8");
    }

    const superOntologyContextualFlow = path.join(dir, SUPER_ONTOLOGY_CONTEXTUAL_FLOW_FILE);
    if (!fs.existsSync(superOntologyContextualFlow)) {
      fs.writeFileSync(superOntologyContextualFlow, superOntologyContextualFlowSkeleton(name), "utf8");
    }

    const superOntologyCausalImpact = path.join(dir, SUPER_ONTOLOGY_CAUSAL_IMPACT_FILE);
    if (!fs.existsSync(superOntologyCausalImpact)) {
      fs.writeFileSync(superOntologyCausalImpact, superOntologyCausalImpactSkeleton(name), "utf8");
    }

    const superOntologyAssuranceCase = path.join(dir, SUPER_ONTOLOGY_ASSURANCE_CASE_FILE);
    if (!fs.existsSync(superOntologyAssuranceCase)) {
      fs.writeFileSync(superOntologyAssuranceCase, superOntologyAssuranceCaseSkeleton(name), "utf8");
    }

    for (const fileName of [
      SUPER_ONTOLOGY_REPLAYS_FILE,
      SUPER_ONTOLOGY_EVIDENCE_FILE,
      SUPER_ONTOLOGY_MEMORY_BRIDGE_FILE,
    ]) {
      const filePath = path.join(dir, fileName);
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "", "utf8");
    }

    return dir;
  } catch {
    return null;
  }
}

export function readProjectSoul(projectPath: string): string | null {
  try {
    return fs.readFileSync(path.join(projectMemoryDir(projectPath), PROJECT_SOUL_FILE), "utf8");
  } catch {
    return null;
  }
}

export function readSitemap(projectPath: string): unknown | null {
  try {
    const raw = fs.readFileSync(path.join(projectMemoryDir(projectPath), SITEMAP_FILE), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function appendMemoryLog(projectPath: string, record: unknown): void {
  try {
    const dir = ensureProjectMemory(projectPath);
    if (!dir) return;
    fs.appendFileSync(
      path.join(dir, MEMORY_LOG_FILE),
      JSON.stringify(record) + "\n",
      "utf8",
    );
  } catch {
    // best-effort
  }
}

/** Append durable items under the auto-curated section of the soul file. */
export function appendSoulMemory(
  projectPath: string,
  lines: string[],
): void {
  if (lines.length === 0) return;
  try {
    const dir = ensureProjectMemory(projectPath);
    if (!dir) return;
    const soulPath = path.join(dir, PROJECT_SOUL_FILE);
    let content = "";
    try {
      content = fs.readFileSync(soulPath, "utf8");
    } catch {
      content = soulTemplate(path.basename(projectPath) || "Project");
    }
    if (!content.includes(AUTO_SECTION)) content += `\n${AUTO_SECTION}\n`;
    const block = lines.map((l) => `- ${l}`).join("\n") + "\n";
    fs.writeFileSync(soulPath, content.replace(/\s*$/, "\n") + block, "utf8");
  } catch {
    // best-effort
  }
}
