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
  SUPER_ONTOLOGY_OPEN_WORLD_COVERAGE_FILE,
  SUPER_ONTOLOGY_CONSENSUS_COORDINATION_FILE,
  SUPER_ONTOLOGY_ASSURANCE_CASE_FILE,
  SUPER_ONTOLOGY_CONTEXTUAL_FLOW_FILE,
  SUPER_ONTOLOGY_CAUSAL_IMPACT_FILE,
  SUPER_ONTOLOGY_KNOWLEDGE_HOMEOSTASIS_FILE,
  SUPER_ONTOLOGY_ADVERSARIAL_PROVENANCE_FILE,
  SUPER_ONTOLOGY_EPISTEMIC_CALIBRATION_FILE,
  SUPER_ONTOLOGY_SEMANTIC_ALIGNMENT_FILE,
  SUPER_ONTOLOGY_RESILIENCE_CONTROL_FILE,
  SUPER_ONTOLOGY_INVARIANT_VERIFICATION_FILE,
  SUPER_ONTOLOGY_OBSERVABILITY_TELEMETRY_FILE,
  SUPER_ONTOLOGY_OBJECTIVE_PROXY_VALIDITY_FILE,
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
        "open_world_coverage_contract",
        "consensus_coordination_contract",
        "task_coverage_contract",
        "contextual_flow_contract",
        "causal_impact_contract",
        "assurance_case_contract",
        "knowledge_homeostasis_contract",
        "adversarial_provenance_contract",
        "epistemic_calibration_contract",
        "semantic_alignment_contract",
        "resilience_control_contract",
        "invariant_verification_contract",
        "observability_telemetry_contract",
        "objective_proxy_validity_contract",
        "promotion_readiness",
        "promotion_replay_drill",
        "architecture_sync_review",
      ],
      evidenceLedgers: {
        replays: `.agentlas/${SUPER_ONTOLOGY_REPLAYS_FILE}`,
        promotionEvidence: `.agentlas/${SUPER_ONTOLOGY_EVIDENCE_FILE}`,
        memoryTickets: `.agentlas/${MEMORY_LOG_FILE}`,
        memoryCuratorBridge: `.agentlas/${SUPER_ONTOLOGY_MEMORY_BRIDGE_FILE}`,
        openWorldCoverage: `.agentlas/${SUPER_ONTOLOGY_OPEN_WORLD_COVERAGE_FILE}`,
        consensusCoordination: `.agentlas/${SUPER_ONTOLOGY_CONSENSUS_COORDINATION_FILE}`,
        taskCoverage: `.agentlas/${SUPER_ONTOLOGY_TASK_COVERAGE_FILE}`,
        contextualFlow: `.agentlas/${SUPER_ONTOLOGY_CONTEXTUAL_FLOW_FILE}`,
        causalImpact: `.agentlas/${SUPER_ONTOLOGY_CAUSAL_IMPACT_FILE}`,
        assuranceCase: `.agentlas/${SUPER_ONTOLOGY_ASSURANCE_CASE_FILE}`,
        knowledgeHomeostasis: `.agentlas/${SUPER_ONTOLOGY_KNOWLEDGE_HOMEOSTASIS_FILE}`,
        adversarialProvenance: `.agentlas/${SUPER_ONTOLOGY_ADVERSARIAL_PROVENANCE_FILE}`,
        epistemicCalibration: `.agentlas/${SUPER_ONTOLOGY_EPISTEMIC_CALIBRATION_FILE}`,
        semanticAlignment: `.agentlas/${SUPER_ONTOLOGY_SEMANTIC_ALIGNMENT_FILE}`,
        resilienceControl: `.agentlas/${SUPER_ONTOLOGY_RESILIENCE_CONTROL_FILE}`,
        invariantVerification: `.agentlas/${SUPER_ONTOLOGY_INVARIANT_VERIFICATION_FILE}`,
        observabilityTelemetry: `.agentlas/${SUPER_ONTOLOGY_OBSERVABILITY_TELEMETRY_FILE}`,
        objectiveProxyValidity: `.agentlas/${SUPER_ONTOLOGY_OBJECTIVE_PROXY_VALIDITY_FILE}`,
      },
      hardStops: [
        "zero_error_claim",
        "raw_source_to_graph_write",
        "forbidden_context_join",
        "whole_graph_exposure",
        "tool_authority_without_provenance",
        "missing_open_world_coverage_contract",
        "proposal_example_equals_all_tasks",
        "unknown_combination_to_runtime_write",
        "untested_modality_to_memory_write",
        "implicit_degradation_as_complete_data",
        "adversarial_source_as_authority",
        "forbidden_authority_to_action",
        "missing_consensus_coordination_contract",
        "agent_agreement_as_truth",
        "majority_vote_as_write_authority",
        "debate_stability_as_proof",
        "model_judge_as_final_evidence",
        "distributed_replica_merge_without_review",
        "route_sync_without_quorum",
        "last_writer_wins_architecture_update",
        "peer_pressure_to_memory_write",
        "validator_disagreement_to_release",
        "appbridge_source_of_truth_write",
        "missing_rollback",
        "missing_shadow_or_canary_evidence",
        "missing_memory_curator_bridge",
        "missing_task_coverage_contract",
        "missing_contextual_flow_contract",
        "forbidden_context_flow",
        "missing_causal_impact_contract",
        "missing_assurance_case_contract",
        "missing_knowledge_homeostasis_contract",
        "error_budget_overrun_continues",
        "critical_homeostasis_runtime_write",
        "privacy_incident_public_export",
        "missing_adversarial_provenance_contract",
        "prompt_injection_as_instruction",
        "forged_provenance_as_trusted_source",
        "poisoned_source_to_memory",
        "tool_output_tampering_to_action",
        "stale_trusted_source_replay_as_current_truth",
        "missing_epistemic_calibration_contract",
        "uncalibrated_confidence_to_answer",
        "unknown_state_to_runtime_write",
        "conflicting_sources_as_current_truth",
        "low_retrieval_relevance_as_confident_answer",
        "wide_judge_interval_to_regulated_answer",
        "missing_semantic_alignment_contract",
        "same_label_as_same_meaning",
        "embedding_similarity_as_exact_match",
        "close_match_as_transitive_truth",
        "generated_label_as_ontology_class",
        "appbridge_route_as_source_ontology_edit",
        "same_individual_without_stable_identifier",
        "unit_label_without_unit_compatibility",
        "source_conflict_to_memory_merge",
        "no_match_promoted_to_weak_match",
        "missing_resilience_control_contract",
        "validator_disagreement_to_graph_write",
        "retrieval_drift_to_current_answer",
        "semantic_regression_to_memory_merge",
        "curator_backlog_to_direct_memory_write",
        "tool_error_spike_to_unbounded_retry",
        "sync_drift_to_release_surface",
        "degraded_parser_to_ontology_class",
        "emergency_stop_bypass_by_route",
        "missing_invariant_verification_contract",
        "memory_write_without_ticket_invariant",
        "graph_write_without_evidence_invariant",
        "tool_action_without_authority_invariant",
        "public_export_without_flow_invariant",
        "route_sync_without_source_contract_invariant",
        "rollback_not_observed_after_violation",
        "emergency_stop_transition_bypassed",
        "unordered_multi_agent_write",
        "non_idempotent_replay_mutation",
        "missing_observability_telemetry_contract",
        "write_without_trace_id",
        "memory_ticket_without_span_lineage",
        "tool_action_without_audit_receipt",
        "public_export_with_stale_metric",
        "route_sync_without_correlation_id",
        "release_seed_when_audit_sink_down",
        "redaction_missing_in_telemetry",
        "metric_green_without_sample_size",
        "alert_suppressed_during_degraded_mode",
        "shadow_replay_not_recorded",
        "repair_without_before_after_snapshot",
        "rollback_without_observed_event",
        "unobservable_runtime_write",
        "missing_objective_proxy_validity_contract",
        "metric_improvement_as_goal_completion",
        "approval_rate_as_trust",
        "benchmark_score_as_reliability",
        "test_pass_rate_as_maintainability",
        "open_rate_as_customer_value",
        "self_judge_score_as_truth",
        "edge_count_as_knowledge_quality",
        "short_term_profit_as_compliance",
        "cost_per_execution_as_sustainability",
        "reward_score_as_quality",
        "label_leakage_as_accuracy",
        "green_dashboard_as_health",
        "proxy_optimization_without_countermetric",
        "optimization_without_stakeholder_map",
        "metric_gaming_without_probe",
        "reward_tampering_to_promotion",
        "construct_underdefined_to_runtime_write",
        "unvalidated_proxy_to_public_release",
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
        openWorldCoverageRequired: true,
        unknownCombinationRuntimeWritesBlocked: true,
        uncoveredModalityRuntimeWritesBlocked: true,
        consensusCoordinationRequired: true,
        agentAgreementRuntimeWritesBlocked: true,
        majorityVoteRuntimeWritesBlocked: true,
        splitBrainRuntimeWritesBlocked: true,
        taskCoverageRequired: true,
        contextualFlowRequired: true,
        causalImpactRequired: true,
        assuranceCaseRequired: true,
        knowledgeHomeostasisRequired: true,
        adversarialProvenanceRequired: true,
        untrustedSourceRuntimeWritesBlocked: true,
        epistemicCalibrationRequired: true,
        uncalibratedRuntimeWritesBlocked: true,
        semanticAlignmentRequired: true,
        highAuthorityAlignmentReviewRequired: true,
        unreviewedSemanticRuntimeWritesBlocked: true,
        resilienceControlRequired: true,
        degradedRuntimeWritesBlocked: true,
        emergencyStopBypassBlocked: true,
        invariantVerificationRequired: true,
        runtimeInvariantWritesBlocked: true,
        forbiddenTransitionBlocked: true,
        observabilityTelemetryRequired: true,
        unobservableRuntimeWritesBlocked: true,
        auditSinkRequired: true,
        crossSurfaceCorrelationRequired: true,
        objectiveProxyValidityRequired: true,
        proxyOptimizationRuntimeWritesBlocked: true,
        countermetricRequired: true,
        metricGamingProbeRequired: true,
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

function superOntologyKnowledgeHomeostasisSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-knowledge-homeostasis",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision: "homeostasis_required_before_runtime_or_memory_write",
      signals: [
        "contradiction_rate",
        "stale_claim_age",
        "schema_violation_rate",
        "parser_error_rate",
        "unsupported_claim_rate",
        "repair_backlog",
        "replay_failure_rate",
        "drift_rate",
        "source_freshness",
        "authority_expiry",
        "privacy_incident",
        "promotion_evidence_gap",
        "user_correction_rate",
        "runtime_desync_rate",
      ],
      decisions: [
        "continue",
        "quarantine",
        "degrade_to_read_only",
        "require_review",
        "replay",
        "repair",
        "rollback",
        "block_promotion",
        "retire",
      ],
      requiredParameters: [
        "monitored_artifact",
        "scope_id",
        "surface",
        "signal_type",
        "measurement",
        "severity",
        "affected_contexts",
        "affected_lenses",
        "affected_claims",
        "affected_surfaces",
        "error_budget",
        "control_decision",
        "automation_level",
        "escalation",
        "evidence_refs",
        "rollback_plan",
        "memory_curator_policy",
        "public_export_policy",
      ],
      researchBasis: [
        "shacl_validation",
        "kg_repair_evaluation",
        "ontology_change_propagation",
        "truth_maintenance",
        "data_observability",
        "resilience_engineering",
        "homeostatic_control",
        "w3c_prov",
        "nist_ai_rmf",
        "ai_agent_index",
      ],
      hardStops: [
        "error_budget_overrun_continues",
        "critical_homeostasis_runtime_write",
        "privacy_incident_public_export",
        "appbridge_route_as_source_authority",
        "stale_claim_as_current_truth",
        "parser_error_as_complete_source",
        "missing_homeostasis_evidence",
        "memory_write_without_ticket_or_quarantine",
        "runtime_desync_ignored",
        "literal_perfection_claim",
      ],
    },
    null,
    2,
  );
}

function superOntologyAdversarialProvenanceSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-adversarial-provenance",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision: "zero_trust_provenance_required_before_retrieval_memory_tool_or_public_seed",
      sourceChannels: [
        "upload",
        "web",
        "email",
        "chat",
        "tool_response",
        "connector",
        "memory_recall",
        "public_repo",
        "media_asset",
        "appbridge_route",
        "generated_artifact",
        "dataset",
      ],
      attackVectors: [
        "prompt_injection",
        "instruction_smuggling",
        "data_poisoning",
        "provenance_forgery",
        "citation_spoofing",
        "tool_output_tampering",
        "ocr_hidden_text",
        "cross_context_exfiltration",
        "supply_chain_tampering",
        "memory_poisoning",
        "social_engineering",
        "model_policy_bypass",
        "media_provenance_conflict",
        "stale_trusted_source_replay",
      ],
      trustBoundaries: [
        "untrusted_external",
        "user_private",
        "company_internal",
        "customer_confidential",
        "public_web",
        "runtime_tool",
        "agent_internal",
        "memory_store",
        "release_artifact",
      ],
      instructionPolicies: [
        "treat_as_data_only",
        "strip_instructions",
        "quote_only",
        "sandbox_tool_output",
        "require_signature",
        "require_human_review",
        "block",
      ],
      retrievalPolicies: [
        "exclude_from_retrieval",
        "metadata_only",
        "citation_only",
        "quarantined_candidate",
        "low_trust_retrieval",
        "allow_after_verification",
      ],
      memoryPolicies: [
        "no_memory",
        "quarantine_ticket",
        "redact_then_ticket",
        "supersede_after_review",
        "discard",
      ],
      toolPolicies: [
        "no_tool_use",
        "dry_run_only",
        "allowlisted_read_only",
        "require_human_approval",
        "block_external_effect",
      ],
      promotionDecisions: [
        "allow_read",
        "quarantine",
        "review_required",
        "shadow_required",
        "block",
        "retire_source",
      ],
      requiredParameters: [
        "source_channel",
        "attack_vector",
        "trust_boundary",
        "claimed_authority",
        "observed_artifact",
        "provenance_evidence",
        "integrity_checks",
        "instruction_policy",
        "retrieval_policy",
        "memory_policy",
        "tool_policy",
        "promotion_decision",
        "required_controls",
        "must_not_do",
        "evidence_refs",
        "rollback_plan",
      ],
      researchBasis: [
        "owasp_llm_top10",
        "mitre_atlas",
        "nist_adversarial_ml",
        "slsa_provenance",
        "in_toto_attestation",
        "c2pa_content_credentials",
        "zero_trust_architecture",
        "information_flow_control",
        "adversarial_rag",
        "secure_rag_prompt_injection",
      ],
      hardStops: [
        "prompt_injection_as_instruction",
        "instruction_smuggling_as_policy",
        "poisoned_source_to_memory",
        "forged_provenance_as_trusted_source",
        "spoofed_citation_as_grounded_fact",
        "tool_output_tampering_to_action",
        "hidden_ocr_instruction_as_user_intent",
        "cross_context_exfiltration",
        "unsigned_release_artifact",
        "route_output_as_source_write_authority",
        "stale_trusted_source_replay_as_current_truth",
        "missing_adversarial_provenance_evidence",
      ],
    },
    null,
    2,
  );
}

function superOntologyEpistemicCalibrationSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-epistemic-calibration",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision: "calibrated_uncertainty_required_before_answer_memory_tool_or_public_seed",
      contextTypes: [
        "user_personal",
        "company_internal",
        "customer_confidential",
        "public_web",
        "regulated",
        "scientific",
        "software",
        "finance_compliance",
        "physical",
        "creative",
        "agent_internal",
        "mixed_context",
        "multimodal",
        "appbridge_route",
        "release_surface",
      ],
      claimTypes: [
        "factual_answer",
        "graph_edge",
        "ontology_class",
        "relation_mapping",
        "action_plan",
        "memory_write",
        "tool_action",
        "public_export",
        "legal_or_policy",
        "financial_estimate",
        "scientific_claim",
        "physical_action",
        "creative_generation",
        "route_sync",
        "generated_artifact",
      ],
      uncertaintySources: [
        "missing_evidence",
        "conflicting_sources",
        "low_retrieval_relevance",
        "distribution_shift",
        "ambiguous_intent",
        "insufficient_permissions",
        "temporal_staleness",
        "noisy_ocr",
        "model_disagreement",
        "tool_inconclusive",
        "causal_unknown",
        "private_context_gap",
        "benchmark_gap",
        "low_calibration_support",
        "adversarial_source_uncertain",
        "no_ground_truth",
      ],
      epistemicStates: [
        "known_enough_for_read",
        "partially_supported",
        "contested",
        "underspecified",
        "out_of_distribution",
        "uncalibrated",
        "unknowable_for_now",
      ],
      calibrationSignals: [
        "conformal_set_size",
        "confidence_interval",
        "prediction_set",
        "abstention_score",
        "evidence_coverage",
        "retrieval_entropy",
        "contradiction_score",
        "judge_interval",
        "self_eval_none_of_above",
        "ensemble_disagreement",
        "holdout_error_rate",
        "calibration_error",
        "ood_score",
        "human_feedback_gap",
      ],
      confidenceBands: [
        "calibrated_high",
        "calibrated_medium",
        "calibrated_low",
        "uncalibrated",
        "unknown",
      ],
      riskTiers: ["low", "moderate", "high", "critical"],
      allowedOutputs: [
        "answer_with_caveat",
        "ask_clarifying_question",
        "retrieve_more",
        "cite_only",
        "draft_only",
        "human_review",
        "abstain",
        "block",
        "shadow_replay",
      ],
      requiredParameters: [
        "context_type",
        "claim_type",
        "uncertainty_source",
        "epistemic_state",
        "calibration_signal",
        "confidence_band",
        "risk_tier",
        "allowed_output",
        "required_controls",
        "blocked_shortcuts",
        "evidence_refs",
        "research_basis",
        "memory_policy",
        "tool_policy",
        "public_export_policy",
        "rollback_plan",
      ],
      researchBasis: [
        "conformal_prediction",
        "conformal_risk_control",
        "selective_prediction",
        "abstention_policy",
        "llm_self_evaluation",
        "verbalized_confidence_calibration",
        "rag_uncertainty_benchmark",
        "nist_ai_rmf",
        "ood_detection",
        "human_in_the_loop",
        "calibration_error",
        "uncertainty_alignment",
      ],
      hardStops: [
        "missing_evidence_as_complete_answer",
        "conflicting_sources_as_current_truth",
        "low_retrieval_relevance_as_confident_answer",
        "ambiguous_intent_to_memory_write",
        "distribution_shift_to_financial_estimate",
        "stale_policy_as_current_policy",
        "model_disagreement_as_consensus",
        "noisy_ocr_as_ontology_class",
        "inconclusive_tool_output_to_action",
        "causal_unknown_to_physical_action",
        "benchmark_gap_to_public_release",
        "uncalibrated_route_sync",
        "adversarial_uncertainty_to_graph_edge",
        "wide_judge_interval_to_regulated_answer",
      ],
    },
    null,
    2,
  );
}

function superOntologySemanticAlignmentSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-semantic-alignment",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision: "scoped_candidate_alignment_required_before_graph_memory_or_public_seed",
      sourceContexts: [
        "company_internal",
        "user_personal",
        "customer_confidential",
        "public_web",
        "regulated",
        "scientific",
        "software_schema",
        "finance_compliance",
        "multimodal_ocr",
        "appbridge_route",
        "release_surface",
        "cross_team",
        "legacy_system",
        "mixed_context",
        "generated_artifact",
      ],
      artifactTypes: [
        "glossary",
        "database_schema",
        "spreadsheet",
        "presentation",
        "contract",
        "policy_doc",
        "source_code",
        "ticket",
        "email",
        "pdf",
        "image_ocr",
        "ontology",
        "knowledge_graph",
        "app_route",
        "generated_output",
      ],
      alignmentIntents: [
        "synonym_discovery",
        "schema_column_match",
        "class_alignment",
        "property_alignment",
        "entity_resolution",
        "hierarchy_mapping",
        "relation_mapping",
        "unit_mapping",
        "business_process_mapping",
        "compliance_mapping",
        "source_system_merge",
        "ontology_change",
        "release_sync",
        "memory_merge",
        "no_match_detection",
      ],
      candidateRelations: [
        "exact_match",
        "close_match",
        "broad_match",
        "narrow_match",
        "related_match",
        "equivalent_class",
        "equivalent_property",
        "same_individual",
        "synonym",
        "no_match",
        "conflict",
      ],
      alignmentScopes: [
        "local_task",
        "project",
        "team",
        "company",
        "customer",
        "regulated_domain",
        "public_export",
        "appbridge_route",
        "release_surface",
      ],
      ambiguityTypes: [
        "homonym",
        "synonym",
        "polysemy",
        "abbreviation",
        "language_variant",
        "unit_mismatch",
        "temporal_version",
        "scope_collision",
        "granularity_mismatch",
        "relation_direction_unknown",
        "entity_class_confusion",
        "ocr_noise",
        "source_conflict",
        "generated_label",
        "missing_definition",
      ],
      validationChecks: [
        "candidate_retrieval",
        "bidirectional_check",
        "contradiction_check",
        "disjointness_check",
        "transitivity_check",
        "sample_instance_check",
        "roundtrip_query_check",
        "shacl_validation",
        "owl_consistency",
        "kgcl_diff",
        "human_owner_review",
        "rollback_drill",
        "shadow_replay",
        "relation_direction_check",
        "unit_compatibility",
      ],
      researchBasis: [
        "skos_mapping",
        "owl_reasoning",
        "shacl_validation",
        "kgcl_change_language",
        "llm_schema_matching",
        "retrieval_augmented_ontology_matching",
        "human_in_loop_schema_discovery",
        "schema_rollup_drilldown",
        "entity_resolution",
        "data_contracts",
        "provenance_review",
        "ontology_change_management",
      ],
      hardStops: [
        "same_label_as_same_meaning",
        "embedding_similarity_as_exact_match",
        "close_match_as_transitive_truth",
        "abbreviation_without_owner_glossary",
        "broad_or_narrow_without_direction_check",
        "generated_label_as_ontology_class",
        "ocr_label_as_property_alignment",
        "appbridge_route_as_source_ontology_edit",
        "source_conflict_to_memory_merge",
        "customer_confidential_mapping_to_public_export",
        "release_sync_without_rollback",
        "ontology_change_without_diff",
        "same_individual_without_stable_identifier",
        "unit_label_without_unit_compatibility",
        "no_match_promoted_to_weak_match",
      ],
    },
    null,
    2,
  );
}

function superOntologyResilienceControlSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-resilience-control",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision: "degrade_authority_before_runtime_graph_memory_tool_or_sync_write",
      controlLoopPhases: ["monitor", "analyze", "plan", "execute", "learn", "sync"],
      operatingModes: [
        "nominal",
        "watch",
        "degraded",
        "shadow_only",
        "read_only",
        "quarantine",
        "owner_review",
        "rollback",
        "emergency_stop",
      ],
      degradationSignals: [
        "contradiction_spike",
        "validator_disagreement",
        "retrieval_drift",
        "semantic_alignment_regression",
        "provenance_gap",
        "memory_curator_backlog",
        "tool_error_spike",
        "user_correction_spike",
        "unknown_task_family",
        "context_flow_violation",
        "causal_impact_uncertain",
        "sync_drift",
        "model_judge_divergence",
        "latency_budget_overrun",
        "replay_failure",
        "permission_boundary_unknown",
        "sensor_or_parser_degraded",
        "external_side_effect_detected",
      ],
      hazardTypes: [
        "unsafe_control_action",
        "missing_feedback",
        "delayed_feedback",
        "wrong_mode",
        "authority_escalation",
        "control_loop_oscillation",
        "stale_process_model",
        "degraded_sensor",
        "conflicting_controller",
        "runaway_repair",
        "unbounded_retry",
        "brittle_threshold",
        "silent_fail_open",
        "operator_overload",
      ],
      controlDecisions: [
        "continue",
        "observe",
        "ask_clarify",
        "retrieve_more",
        "shadow_only",
        "read_only",
        "quarantine",
        "require_owner_review",
        "rollback",
        "emergency_stop",
      ],
      requiredFeedback: [
        "fresh_source_retrieval",
        "validator_matrix",
        "curator_queue_depth",
        "tool_trace",
        "source_identity_check",
        "contextual_flow_replay",
        "causal_impact_review",
        "semantic_alignment_replay",
        "epistemic_calibration_replay",
        "architecture_sync_diff",
        "rollback_confirmation",
        "owner_review_ticket",
      ],
      researchBasis: [
        "mape_k",
        "self_adaptive_systems",
        "stpa",
        "unsafe_control_actions",
        "robustness_analysis",
        "degradation_state_analysis",
        "agentic_self_awareness",
        "adaptive_hierarchical_kg",
        "resilience_engineering",
        "cybernetics_feedback",
        "incident_command",
        "sociotechnical_escalation",
      ],
      hardStops: [
        "validator_disagreement_to_graph_write",
        "retrieval_drift_to_current_answer",
        "semantic_regression_to_memory_merge",
        "provenance_gap_to_tool_authority",
        "curator_backlog_to_direct_memory_write",
        "tool_error_spike_to_unbounded_retry",
        "unknown_task_to_normal_execution",
        "context_flow_violation_to_public_export",
        "sync_drift_to_release_surface",
        "judge_divergence_to_regulated_answer",
        "degraded_parser_to_ontology_class",
        "rollback_failure_to_runtime_promotion",
        "emergency_stop_bypass_by_route",
      ],
    },
    null,
    2,
  );
}

function superOntologyInvariantVerificationSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-invariant-verification",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision: "runtime_monitor_required_before_graph_memory_tool_route_release_or_public_write",
      eventStreams: [
        "source_intake",
        "evidence_packet",
        "belief_update",
        "semantic_alignment",
        "resilience_mode",
        "memory_ticket",
        "graph_write",
        "tool_call",
        "public_export",
        "route_sync",
        "release_seed",
        "rollback",
        "emergency_stop",
      ],
      invariantTypes: [
        "safety",
        "liveness",
        "ordering",
        "separation",
        "cardinality",
        "idempotency",
        "provenance",
        "authority",
        "consent",
        "rollback",
        "audit",
        "determinism",
      ],
      temporalOperators: ["always", "never", "eventually", "until", "before", "after", "within", "once"],
      monitors: [
        "json_schema",
        "event_sequence",
        "state_machine",
        "temporal_logic",
        "property_test",
        "shadow_replay",
        "model_check",
        "sync_check",
        "curator_ticket_audit",
        "human_owner_review",
      ],
      violationActions: [
        "block",
        "reject",
        "quarantine",
        "rollback",
        "emergency_stop",
        "ask_clarify",
        "review_required",
        "shadow_only",
      ],
      researchBasis: [
        "runtime_verification",
        "temporal_logic",
        "model_checking",
        "contract_based_design",
        "assume_guarantee_contracts",
        "finite_state_monitor",
        "agent_runtime_monitoring",
        "formal_methods_for_planning",
        "formal_skill_verification",
        "multi_agent_safety_invariants",
        "memory_safety_invariants",
        "audit_log_invariants",
      ],
      hardStops: [
        "memory_write_without_ticket_invariant",
        "graph_write_without_evidence_invariant",
        "tool_action_without_authority_invariant",
        "public_export_without_flow_invariant",
        "route_sync_without_source_contract_invariant",
        "rollback_not_observed_after_violation",
        "emergency_stop_transition_bypassed",
        "unordered_multi_agent_write",
        "non_idempotent_replay_mutation",
      ],
    },
    null,
    2,
  );
}

function superOntologyObservabilityTelemetrySkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-observability-telemetry",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision: "observability_required_before_runtime_graph_memory_tool_route_release_or_public_write",
      eventTypes: [
        "source_intake",
        "evidence_packet",
        "belief_update",
        "graph_write",
        "memory_ticket",
        "tool_action",
        "public_export",
        "route_sync",
        "release_seed",
        "repair_event",
        "rollback",
        "emergency_stop",
      ],
      failureModes: [
        "missing_trace_id",
        "dropped_span",
        "partial_log",
        "stale_metric",
        "redaction_gap",
        "audit_sink_down",
        "clock_skew",
        "sample_bias",
        "alert_suppression",
        "replay_not_recorded",
        "repair_without_snapshot",
        "cross_surface_correlation_missing",
      ],
      requiredTelemetry: [
        "trace_id",
        "span_id",
        "parent_span_id",
        "correlation_id",
        "source_ref",
        "evidence_ref",
        "actor_role",
        "authority_state",
        "decision_state",
        "risk_tier",
        "redaction_policy",
        "retention_policy",
        "clock_source",
        "checksum",
        "before_snapshot_ref",
        "after_snapshot_ref",
        "rollback_ref",
        "alert_ref",
        "audit_sink_ref",
        "sample_size",
      ],
      traceStates: ["complete", "partial", "missing", "corrupted", "untrusted", "redacted"],
      auditChannels: [
        "jsonl_ledger",
        "otel_trace",
        "memory_ticket",
        "sync_log",
        "release_log",
        "tool_receipt",
        "owner_review_queue",
      ],
      decisions: [
        "allow_read",
        "candidate_only",
        "shadow_required",
        "sync_review_required",
        "quarantine",
        "rollback",
        "emergency_stop",
        "blocked",
      ],
      researchBasis: [
        "agent_execution_provenance",
        "agent_observability_telemetry",
        "trace_reasoning_benchmark",
        "opentelemetry",
        "w3c_trace_context",
        "sre_monitoring",
        "nist_ai_rmf_gai_profile",
        "runtime_assurance",
        "audit_log_invariants",
        "data_observability",
      ],
      hardStops: [
        "missing_observability_telemetry_contract",
        "write_without_trace_id",
        "memory_ticket_without_span_lineage",
        "tool_action_without_audit_receipt",
        "public_export_with_stale_metric",
        "route_sync_without_correlation_id",
        "release_seed_when_audit_sink_down",
        "redaction_missing_in_telemetry",
        "metric_green_without_sample_size",
        "alert_suppressed_during_degraded_mode",
        "shadow_replay_not_recorded",
        "repair_without_before_after_snapshot",
        "rollback_without_observed_event",
        "unobservable_runtime_write",
      ],
    },
    null,
    2,
  );
}

function superOntologyObjectiveProxyValiditySkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-objective-proxy-validity",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision:
        "construct_validity_required_before_metric_driven_runtime_graph_memory_tool_route_release_or_public_write",
      constructs: [
        "user_value",
        "business_outcome",
        "safety",
        "quality",
        "truthfulness",
        "trust",
        "learning",
        "wellbeing",
        "compliance",
        "fairness",
        "reliability",
        "maintainability",
        "environmental_impact",
        "financial_return",
        "operational_efficiency",
        "reputation",
      ],
      proxyMetrics: [
        "approval_rate",
        "open_rate",
        "click_rate",
        "benchmark_score",
        "test_pass_rate",
        "self_judge_score",
        "ontology_edge_count",
        "memory_recall_count",
        "short_term_profit",
        "cost_per_execution",
        "green_dashboard_percentage",
        "reward_score_delta",
      ],
      validityGaps: [
        "construct_underdefined",
        "proxy_not_construct",
        "proxy_overoptimized",
        "benchmark_contamination",
        "reward_tampering",
        "metric_gaming",
        "stakeholder_harm_hidden",
        "short_term_metric_long_term_harm",
        "sample_not_representative",
        "measurement_noninvariance",
        "label_leakage",
        "evaluator_conflict",
        "target_shift",
      ],
      goodhartModes: [
        "regressional",
        "extremal",
        "causal",
        "adversarial",
        "campbell_law",
        "reward_hacking",
        "proxy_gaming",
        "benchmark_gaming",
      ],
      requiredValidityEvidence: [
        "construct_definition",
        "stakeholder_map",
        "countermetric",
        "negative_control",
        "holdout_distribution",
        "baseline_comparison",
        "item_level_analysis",
        "causal_path",
        "gaming_probe",
        "benchmark_provenance",
        "human_owner_review",
        "longitudinal_check",
        "measurement_invariance_check",
        "sample_size",
        "error_bar",
        "rollback_plan",
      ],
      countermetrics: [
        "harm_rate",
        "complaint_rate",
        "long_term_retention",
        "quality_review_score",
        "fairness_delta",
        "safety_incident_rate",
        "source_grounding_rate",
        "maintenance_burden",
        "cost_per_success",
        "reversal_rate",
        "learning_transfer",
        "user_trust_signal",
        "denominator",
      ],
      decisions: [
        "allow_read",
        "candidate_only",
        "shadow_required",
        "human_review_required",
        "redesign_metric",
        "quarantine",
        "block_optimization",
        "rollback",
        "emergency_stop",
      ],
      researchBasis: [
        "goodharts_law",
        "campbells_law",
        "construct_validity",
        "psychometrics",
        "measurement_theory",
        "reward_hacking",
        "specification_gaming",
        "benchmark_validity",
        "ai_risk_management",
        "sociotechnical_evaluation",
        "causal_inference",
        "program_evaluation",
      ],
      hardStops: [
        "missing_objective_proxy_validity_contract",
        "metric_improvement_as_goal_completion",
        "approval_rate_as_trust",
        "benchmark_score_as_reliability",
        "test_pass_rate_as_maintainability",
        "open_rate_as_customer_value",
        "self_judge_score_as_truth",
        "edge_count_as_knowledge_quality",
        "short_term_profit_as_compliance",
        "cost_per_execution_as_sustainability",
        "reward_score_as_quality",
        "label_leakage_as_accuracy",
        "green_dashboard_as_health",
        "proxy_optimization_without_countermetric",
        "optimization_without_stakeholder_map",
        "metric_gaming_without_probe",
        "reward_tampering_to_promotion",
        "construct_underdefined_to_runtime_write",
        "unvalidated_proxy_to_public_release",
      ],
    },
    null,
    2,
  );
}

function superOntologyOpenWorldCoverageSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-open-world-coverage",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision: "lower_authority_before_unknown_combination_write",
      worldFamilies: [
        "personal_life",
        "company_operations",
        "public_research",
        "scientific_observation",
        "social_institutional",
        "creative_media",
        "regulated_health",
        "legal_compliance",
        "industrial_physical",
        "environmental_geospatial",
        "software_enterprise",
        "education",
        "finance_compliance",
        "multimodal_brand",
        "unknown_mixed",
      ],
      modalities: [
        "text",
        "table",
        "slide",
        "pdf",
        "hwp",
        "image",
        "video",
        "audio",
        "sensor",
        "code",
        "database",
        "email",
        "calendar",
        "web",
        "geospatial",
      ],
      faultModels: [
        "none",
        "explicit_error",
        "implicit_degradation",
        "mixed_fault",
        "missing_field",
        "stale_source",
        "adversarial_source",
        "permission_gap",
        "semantic_ambiguity",
        "causal_gap",
      ],
      authorityStates: [
        "public_allowed",
        "owner_authority_present",
        "authority_unknown",
        "regulated_requires_review",
        "forbidden",
      ],
      coverageGaps: [
        "covered",
        "new_combination",
        "underrepresented_world",
        "missing_fault_fixture",
        "missing_modality_fixture",
        "missing_authority_fixture",
      ],
      requiredGates: [
        "task_coverage",
        "contextual_flow",
        "epistemic_calibration",
        "semantic_alignment",
        "adversarial_provenance",
        "causal_impact",
        "knowledge_homeostasis",
        "resilience_control",
        "invariant_verification",
        "memory_curator_bridge",
        "assurance_case",
        "shadow_canary_replay",
        "owner_review",
      ],
      samplingActions: [
        "allow_as_research_fixture",
        "add_fixture",
        "ask_clarify",
        "shadow_replay",
        "quarantine",
        "block",
        "require_owner_review",
      ],
      promotionDecisions: [
        "candidate_only",
        "shadow_required",
        "sync_review_required",
        "blocked",
      ],
      researchBasis: [
        "open_world_evaluation",
        "professional_agent_benchmarks",
        "real_computer_environment_benchmarks",
        "ontology_oriented_kg_construction",
        "enterprise_ontology_scope_limits",
        "no_free_lunch",
        "zero_trust_architecture",
      ],
      hardStops: [
        "missing_open_world_coverage_contract",
        "proposal_example_equals_all_tasks",
        "unknown_combination_to_runtime_write",
        "untested_modality_to_memory_write",
        "implicit_degradation_as_complete_data",
        "adversarial_source_as_authority",
        "forbidden_authority_to_action",
        "open_world_case_without_shadow_replay",
        "open_world_case_without_owner_or_sync_review",
      ],
    },
    null,
    2,
  );
}

function superOntologyConsensusCoordinationSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-consensus-coordination",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision: "treat_agent_agreement_as_candidate_signal_not_write_authority",
      coordinationTopologies: [
        "independent_parallel",
        "star_orchestrator",
        "round_robin",
        "majority_vote",
        "weighted_vote",
        "debate",
        "owner_review_board",
        "distributed_replicas",
        "cross_runtime_sync",
      ],
      failureModes: [
        "majority_corruption",
        "peer_pressure",
        "sycophancy",
        "split_brain",
        "stale_replica",
        "double_write",
        "authority_escalation",
        "validator_disagreement",
        "collusion",
        "unreliable_judge",
        "network_partition",
        "race_condition",
      ],
      requiredGates: [
        "adversarial_provenance",
        "epistemic_calibration",
        "semantic_alignment",
        "knowledge_homeostasis",
        "resilience_control",
        "invariant_verification",
        "memory_curator_bridge",
        "assurance_case",
        "shadow_canary_replay",
        "owner_review",
        "sync_gate",
      ],
      consensusPolicies: [
        "independent_verification",
        "stability_detection",
        "evidence_weighted",
        "unanimity_for_high_risk",
        "owner_tiebreak",
        "quorum_plus_veto",
        "read_only_shadow",
        "two_phase_commit",
        "crdt_merge_with_review",
        "block",
      ],
      conflictResolutions: [
        "ask_clarify",
        "quarantine",
        "shadow_replay",
        "owner_review",
        "sync_review",
        "rollback",
        "emergency_stop",
        "merge_as_contested",
        "reject",
        "read_only_mode",
      ],
      researchBasis: [
        "multi_agent_consensus_risk",
        "peer_pressure_research",
        "distributed_systems_consensus",
        "ontology_conflict_resolution",
        "assurance_case",
        "zero_trust_architecture",
      ],
      hardStops: [
        "missing_consensus_coordination_contract",
        "agent_agreement_as_truth",
        "majority_vote_as_write_authority",
        "debate_stability_as_proof",
        "model_judge_as_final_evidence",
        "distributed_replica_merge_without_review",
        "route_sync_without_quorum",
        "last_writer_wins_architecture_update",
        "peer_pressure_to_memory_write",
        "validator_disagreement_to_release",
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

    const superOntologyOpenWorldCoverage = path.join(dir, SUPER_ONTOLOGY_OPEN_WORLD_COVERAGE_FILE);
    if (!fs.existsSync(superOntologyOpenWorldCoverage)) {
      fs.writeFileSync(
        superOntologyOpenWorldCoverage,
        superOntologyOpenWorldCoverageSkeleton(name),
        "utf8",
      );
    }

    const superOntologyConsensusCoordination = path.join(dir, SUPER_ONTOLOGY_CONSENSUS_COORDINATION_FILE);
    if (!fs.existsSync(superOntologyConsensusCoordination)) {
      fs.writeFileSync(
        superOntologyConsensusCoordination,
        superOntologyConsensusCoordinationSkeleton(name),
        "utf8",
      );
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

    const superOntologyKnowledgeHomeostasis = path.join(dir, SUPER_ONTOLOGY_KNOWLEDGE_HOMEOSTASIS_FILE);
    if (!fs.existsSync(superOntologyKnowledgeHomeostasis)) {
      fs.writeFileSync(superOntologyKnowledgeHomeostasis, superOntologyKnowledgeHomeostasisSkeleton(name), "utf8");
    }

    const superOntologyAdversarialProvenance = path.join(dir, SUPER_ONTOLOGY_ADVERSARIAL_PROVENANCE_FILE);
    if (!fs.existsSync(superOntologyAdversarialProvenance)) {
      fs.writeFileSync(
        superOntologyAdversarialProvenance,
        superOntologyAdversarialProvenanceSkeleton(name),
        "utf8",
      );
    }

    const superOntologyEpistemicCalibration = path.join(dir, SUPER_ONTOLOGY_EPISTEMIC_CALIBRATION_FILE);
    if (!fs.existsSync(superOntologyEpistemicCalibration)) {
      fs.writeFileSync(
        superOntologyEpistemicCalibration,
        superOntologyEpistemicCalibrationSkeleton(name),
        "utf8",
      );
    }

    const superOntologySemanticAlignment = path.join(dir, SUPER_ONTOLOGY_SEMANTIC_ALIGNMENT_FILE);
    if (!fs.existsSync(superOntologySemanticAlignment)) {
      fs.writeFileSync(
        superOntologySemanticAlignment,
        superOntologySemanticAlignmentSkeleton(name),
        "utf8",
      );
    }

    const superOntologyResilienceControl = path.join(dir, SUPER_ONTOLOGY_RESILIENCE_CONTROL_FILE);
    if (!fs.existsSync(superOntologyResilienceControl)) {
      fs.writeFileSync(
        superOntologyResilienceControl,
        superOntologyResilienceControlSkeleton(name),
        "utf8",
      );
    }

    const superOntologyInvariantVerification = path.join(dir, SUPER_ONTOLOGY_INVARIANT_VERIFICATION_FILE);
    if (!fs.existsSync(superOntologyInvariantVerification)) {
      fs.writeFileSync(
        superOntologyInvariantVerification,
        superOntologyInvariantVerificationSkeleton(name),
        "utf8",
      );
    }

    const superOntologyObservabilityTelemetry = path.join(dir, SUPER_ONTOLOGY_OBSERVABILITY_TELEMETRY_FILE);
    if (!fs.existsSync(superOntologyObservabilityTelemetry)) {
      fs.writeFileSync(
        superOntologyObservabilityTelemetry,
        superOntologyObservabilityTelemetrySkeleton(name),
        "utf8",
      );
    }

    const superOntologyObjectiveProxyValidity = path.join(dir, SUPER_ONTOLOGY_OBJECTIVE_PROXY_VALIDITY_FILE);
    if (!fs.existsSync(superOntologyObjectiveProxyValidity)) {
      fs.writeFileSync(
        superOntologyObjectiveProxyValidity,
        superOntologyObjectiveProxyValiditySkeleton(name),
        "utf8",
      );
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
