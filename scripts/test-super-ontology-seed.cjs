#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
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
  SUPER_ONTOLOGY_STAKEHOLDER_PREFERENCE_GOVERNANCE_FILE,
  SUPER_ONTOLOGY_NORMATIVE_AUTHORITY_DRIFT_FILE,
  SUPER_ONTOLOGY_SIDE_EFFECT_CONTAINMENT_FILE,
  SUPER_ONTOLOGY_SOURCE_LINEAGE_VERSION_FILE,
  SUPER_ONTOLOGY_ENTITY_IDENTITY_RESOLUTION_FILE,
  SUPER_ONTOLOGY_TEMPORAL_STATE_TRANSITION_FILE,
  SUPER_ONTOLOGY_CAPABILITY_DELEGATION_AUTHORITY_FILE,
  SUPER_ONTOLOGY_OPEN_WORLD_COVERAGE_FILE,
  SUPER_ONTOLOGY_CONSENSUS_COORDINATION_FILE,
  SUPER_ONTOLOGY_CONTRACT_FILE,
  SUPER_ONTOLOGY_EVIDENCE_FILE,
  SUPER_ONTOLOGY_MEMORY_BRIDGE_FILE,
  SUPER_ONTOLOGY_REPLAYS_FILE,
  SUPER_ONTOLOGY_TASK_COVERAGE_FILE,
} = require("../dist/electron/architecture/manifest.js");
const { ensureProjectMemory } = require("../dist/electron/memory/project-files.js");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-super-ontology-seed-"));

try {
  const projectPath = path.join(tempDir, "project");
  fs.mkdirSync(projectPath, { recursive: true });
  const memoryDir = ensureProjectMemory(projectPath, "Seed Smoke Project");
  assert.ok(memoryDir, "ensureProjectMemory should return a .agentlas directory");

  const contractPath = path.join(memoryDir, SUPER_ONTOLOGY_CONTRACT_FILE);
  const replaysPath = path.join(memoryDir, SUPER_ONTOLOGY_REPLAYS_FILE);
  const evidencePath = path.join(memoryDir, SUPER_ONTOLOGY_EVIDENCE_FILE);
  const memoryBridgePath = path.join(memoryDir, SUPER_ONTOLOGY_MEMORY_BRIDGE_FILE);
  const openWorldCoveragePath = path.join(memoryDir, SUPER_ONTOLOGY_OPEN_WORLD_COVERAGE_FILE);
  const consensusCoordinationPath = path.join(memoryDir, SUPER_ONTOLOGY_CONSENSUS_COORDINATION_FILE);
  const taskCoveragePath = path.join(memoryDir, SUPER_ONTOLOGY_TASK_COVERAGE_FILE);
  const assuranceCasePath = path.join(memoryDir, SUPER_ONTOLOGY_ASSURANCE_CASE_FILE);
  const contextualFlowPath = path.join(memoryDir, SUPER_ONTOLOGY_CONTEXTUAL_FLOW_FILE);
  const causalImpactPath = path.join(memoryDir, SUPER_ONTOLOGY_CAUSAL_IMPACT_FILE);
  const knowledgeHomeostasisPath = path.join(memoryDir, SUPER_ONTOLOGY_KNOWLEDGE_HOMEOSTASIS_FILE);
  const adversarialProvenancePath = path.join(memoryDir, SUPER_ONTOLOGY_ADVERSARIAL_PROVENANCE_FILE);
  const epistemicCalibrationPath = path.join(memoryDir, SUPER_ONTOLOGY_EPISTEMIC_CALIBRATION_FILE);
  const semanticAlignmentPath = path.join(memoryDir, SUPER_ONTOLOGY_SEMANTIC_ALIGNMENT_FILE);
  const resilienceControlPath = path.join(memoryDir, SUPER_ONTOLOGY_RESILIENCE_CONTROL_FILE);
  const invariantVerificationPath = path.join(memoryDir, SUPER_ONTOLOGY_INVARIANT_VERIFICATION_FILE);
  const observabilityTelemetryPath = path.join(memoryDir, SUPER_ONTOLOGY_OBSERVABILITY_TELEMETRY_FILE);
  const objectiveProxyValidityPath = path.join(memoryDir, SUPER_ONTOLOGY_OBJECTIVE_PROXY_VALIDITY_FILE);
  const stakeholderPreferenceGovernancePath = path.join(
    memoryDir,
    SUPER_ONTOLOGY_STAKEHOLDER_PREFERENCE_GOVERNANCE_FILE,
  );
  const normativeAuthorityDriftPath = path.join(
    memoryDir,
    SUPER_ONTOLOGY_NORMATIVE_AUTHORITY_DRIFT_FILE,
  );
  const sideEffectContainmentPath = path.join(
    memoryDir,
    SUPER_ONTOLOGY_SIDE_EFFECT_CONTAINMENT_FILE,
  );
  const sourceLineageVersionPath = path.join(
    memoryDir,
    SUPER_ONTOLOGY_SOURCE_LINEAGE_VERSION_FILE,
  );
  const entityIdentityResolutionPath = path.join(
    memoryDir,
    SUPER_ONTOLOGY_ENTITY_IDENTITY_RESOLUTION_FILE,
  );
  const temporalStateTransitionPath = path.join(
    memoryDir,
    SUPER_ONTOLOGY_TEMPORAL_STATE_TRANSITION_FILE,
  );
  const capabilityDelegationAuthorityPath = path.join(
    memoryDir,
    SUPER_ONTOLOGY_CAPABILITY_DELEGATION_AUTHORITY_FILE,
  );

  assert.ok(fs.existsSync(contractPath), "super ontology contract should be seeded");
  assert.ok(fs.existsSync(openWorldCoveragePath), "super ontology open-world coverage should be seeded");
  assert.ok(fs.existsSync(consensusCoordinationPath), "super ontology consensus coordination should be seeded");
  assert.ok(fs.existsSync(taskCoveragePath), "super ontology task coverage should be seeded");
  assert.ok(fs.existsSync(assuranceCasePath), "super ontology assurance case should be seeded");
  assert.ok(fs.existsSync(contextualFlowPath), "super ontology contextual flow should be seeded");
  assert.ok(fs.existsSync(causalImpactPath), "super ontology causal impact should be seeded");
  assert.ok(fs.existsSync(knowledgeHomeostasisPath), "super ontology knowledge homeostasis should be seeded");
  assert.ok(fs.existsSync(adversarialProvenancePath), "super ontology adversarial provenance should be seeded");
  assert.ok(fs.existsSync(epistemicCalibrationPath), "super ontology epistemic calibration should be seeded");
  assert.ok(fs.existsSync(semanticAlignmentPath), "super ontology semantic alignment should be seeded");
  assert.ok(fs.existsSync(resilienceControlPath), "super ontology resilience control should be seeded");
  assert.ok(fs.existsSync(invariantVerificationPath), "super ontology invariant verification should be seeded");
  assert.ok(fs.existsSync(observabilityTelemetryPath), "super ontology observability telemetry should be seeded");
  assert.ok(fs.existsSync(objectiveProxyValidityPath), "super ontology objective proxy validity should be seeded");
  assert.ok(
    fs.existsSync(stakeholderPreferenceGovernancePath),
    "super ontology stakeholder preference governance should be seeded",
  );
  assert.ok(
    fs.existsSync(normativeAuthorityDriftPath),
    "super ontology normative authority drift should be seeded",
  );
  assert.ok(
    fs.existsSync(sideEffectContainmentPath),
    "super ontology side-effect containment should be seeded",
  );
  assert.ok(
    fs.existsSync(sourceLineageVersionPath),
    "super ontology source lineage version should be seeded",
  );
  assert.ok(
    fs.existsSync(entityIdentityResolutionPath),
    "super ontology entity identity resolution should be seeded",
  );
  assert.ok(
    fs.existsSync(temporalStateTransitionPath),
    "super ontology temporal state transition should be seeded",
  );
  assert.ok(
    fs.existsSync(capabilityDelegationAuthorityPath),
    "super ontology capability delegation authority should be seeded",
  );
  assert.ok(fs.existsSync(replaysPath), "super ontology replay ledger should be seeded");
  assert.ok(fs.existsSync(evidencePath), "super ontology evidence ledger should be seeded");
  assert.ok(fs.existsSync(memoryBridgePath), "super ontology memory bridge ledger should be seeded");

  const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  assert.equal(contract.kind, "agentlas-super-ontology-contract");
  assert.equal(contract.state, "local_candidate");
  assert.equal(contract.runtimeGraphWriteEnabled, false);
  assert.equal(contract.zeroErrorClaim, false);
  assert.equal(contract.promotionPolicy.shadowRequired, true);
  assert.equal(contract.promotionPolicy.canaryRequiredForMixedContext, true);
  assert.equal(contract.promotionPolicy.rollbackRequired, true);
  assert.equal(contract.promotionPolicy.appbridgeSourceWritesBlocked, true);
  assert.equal(contract.promotionPolicy.memoryCuratorBridgeRequired, true);
  assert.equal(contract.promotionPolicy.openWorldCoverageRequired, true);
  assert.equal(contract.promotionPolicy.unknownCombinationRuntimeWritesBlocked, true);
  assert.equal(contract.promotionPolicy.uncoveredModalityRuntimeWritesBlocked, true);
  assert.equal(contract.promotionPolicy.consensusCoordinationRequired, true);
  assert.equal(contract.promotionPolicy.agentAgreementRuntimeWritesBlocked, true);
  assert.equal(contract.promotionPolicy.majorityVoteRuntimeWritesBlocked, true);
  assert.equal(contract.promotionPolicy.splitBrainRuntimeWritesBlocked, true);
  assert.equal(contract.promotionPolicy.taskCoverageRequired, true);
  assert.equal(contract.promotionPolicy.contextualFlowRequired, true);
  assert.equal(contract.promotionPolicy.causalImpactRequired, true);
  assert.equal(contract.promotionPolicy.assuranceCaseRequired, true);
  assert.equal(contract.promotionPolicy.knowledgeHomeostasisRequired, true);
  assert.equal(contract.promotionPolicy.adversarialProvenanceRequired, true);
  assert.equal(contract.promotionPolicy.untrustedSourceRuntimeWritesBlocked, true);
  assert.equal(contract.promotionPolicy.epistemicCalibrationRequired, true);
  assert.equal(contract.promotionPolicy.uncalibratedRuntimeWritesBlocked, true);
  assert.equal(contract.promotionPolicy.semanticAlignmentRequired, true);
  assert.equal(contract.promotionPolicy.highAuthorityAlignmentReviewRequired, true);
  assert.equal(contract.promotionPolicy.unreviewedSemanticRuntimeWritesBlocked, true);
  assert.equal(contract.promotionPolicy.resilienceControlRequired, true);
  assert.equal(contract.promotionPolicy.degradedRuntimeWritesBlocked, true);
  assert.equal(contract.promotionPolicy.emergencyStopBypassBlocked, true);
  assert.equal(contract.promotionPolicy.invariantVerificationRequired, true);
  assert.equal(contract.promotionPolicy.runtimeInvariantWritesBlocked, true);
  assert.equal(contract.promotionPolicy.forbiddenTransitionBlocked, true);
  assert.equal(contract.promotionPolicy.observabilityTelemetryRequired, true);
  assert.equal(contract.promotionPolicy.unobservableRuntimeWritesBlocked, true);
  assert.equal(contract.promotionPolicy.auditSinkRequired, true);
  assert.equal(contract.promotionPolicy.crossSurfaceCorrelationRequired, true);
  assert.equal(contract.promotionPolicy.objectiveProxyValidityRequired, true);
  assert.equal(contract.promotionPolicy.proxyOptimizationRuntimeWritesBlocked, true);
  assert.equal(contract.promotionPolicy.countermetricRequired, true);
  assert.equal(contract.promotionPolicy.metricGamingProbeRequired, true);
  assert.equal(contract.promotionPolicy.stakeholderPreferenceGovernanceRequired, true);
  assert.equal(contract.promotionPolicy.singleStakeholderRuntimeWritesBlocked, true);
  assert.equal(contract.promotionPolicy.aggregationRuleRequired, true);
  assert.equal(contract.promotionPolicy.appealPathRequired, true);
  assert.equal(contract.promotionPolicy.normativeAuthorityDriftRequired, true);
  assert.equal(contract.promotionPolicy.stalePolicyRuntimeWritesBlocked, true);
  assert.equal(contract.promotionPolicy.jurisdictionScopeRequired, true);
  assert.equal(contract.promotionPolicy.authorityHierarchyRequired, true);
  assert.equal(contract.promotionPolicy.sideEffectContainmentRequired, true);
  assert.equal(contract.promotionPolicy.irreversibleRuntimeActionsBlocked, true);
  assert.equal(contract.promotionPolicy.idempotencyKeyRequired, true);
  assert.equal(contract.promotionPolicy.compensationPlanRequired, true);
  assert.equal(contract.promotionPolicy.sourceLineageVersionRequired, true);
  assert.equal(contract.promotionPolicy.unversionedSourceRuntimeWritesBlocked, true);
  assert.equal(contract.promotionPolicy.derivedArtifactPromotionBlocked, true);
  assert.equal(contract.promotionPolicy.lineageRepairRequired, true);
  assert.equal(contract.promotionPolicy.entityIdentityResolutionRequired, true);
  assert.equal(contract.promotionPolicy.ambiguousIdentityRuntimeWritesBlocked, true);
  assert.equal(contract.promotionPolicy.identityMergeReviewRequired, true);
  assert.equal(contract.promotionPolicy.identityRollbackRequired, true);
  assert.equal(contract.promotionPolicy.temporalStateTransitionRequired, true);
  assert.equal(contract.promotionPolicy.timelessStateRuntimeWritesBlocked, true);
  assert.equal(contract.promotionPolicy.eventReplayRequired, true);
  assert.equal(contract.promotionPolicy.projectionVersionRequired, true);
  assert.equal(contract.promotionPolicy.capabilityDelegationAuthorityRequired, true);
  assert.equal(contract.promotionPolicy.unscopedCapabilityRuntimeWritesBlocked, true);
  assert.equal(contract.promotionPolicy.delegationChainRequired, true);
  assert.equal(contract.promotionPolicy.capabilityAttenuationRequired, true);
  assert.equal(contract.promotionPolicy.purposeBoundCapabilityRequired, true);
  assert.equal(contract.promotionPolicy.directDurableMemoryWritesBlocked, true);
  assert.ok(contract.layers.includes("belief_ledger"), "contract should include belief ledger gate");
  assert.ok(contract.layers.includes("knowledge_capsule"), "contract should include knowledge capsule gate");
  assert.ok(contract.layers.includes("memory_curator_bridge"), "contract should include memory curator bridge gate");
  assert.ok(contract.layers.includes("task_coverage_contract"), "contract should include task coverage gate");
  assert.ok(contract.layers.includes("contextual_flow_contract"), "contract should include contextual flow gate");
  assert.ok(contract.layers.includes("causal_impact_contract"), "contract should include causal impact gate");
  assert.ok(contract.layers.includes("assurance_case_contract"), "contract should include assurance case gate");
  assert.ok(contract.layers.includes("knowledge_homeostasis_contract"), "contract should include knowledge homeostasis gate");
  assert.ok(
    contract.layers.includes("adversarial_provenance_contract"),
    "contract should include adversarial provenance gate",
  );
  assert.ok(
    contract.layers.includes("epistemic_calibration_contract"),
    "contract should include epistemic calibration gate",
  );
  assert.ok(
    contract.layers.includes("semantic_alignment_contract"),
    "contract should include semantic alignment gate",
  );
  assert.ok(
    contract.layers.includes("resilience_control_contract"),
    "contract should include resilience control gate",
  );
  assert.ok(
    contract.layers.includes("open_world_coverage_contract"),
    "contract should include open-world coverage gate",
  );
  assert.ok(
    contract.layers.includes("consensus_coordination_contract"),
    "contract should include consensus coordination gate",
  );
  assert.ok(
    contract.layers.includes("invariant_verification_contract"),
    "contract should include invariant verification gate",
  );
  assert.ok(
    contract.layers.includes("observability_telemetry_contract"),
    "contract should include observability telemetry gate",
  );
  assert.ok(
    contract.layers.includes("objective_proxy_validity_contract"),
    "contract should include objective proxy validity gate",
  );
  assert.ok(
    contract.layers.includes("stakeholder_preference_governance_contract"),
    "contract should include stakeholder preference governance gate",
  );
  assert.ok(
    contract.layers.includes("normative_authority_drift_contract"),
    "contract should include normative authority drift gate",
  );
  assert.ok(
    contract.layers.includes("side_effect_containment_contract"),
    "contract should include side-effect containment gate",
  );
  assert.ok(
    contract.layers.includes("source_lineage_version_contract"),
    "contract should include source lineage version gate",
  );
  assert.ok(
    contract.layers.includes("entity_identity_resolution_contract"),
    "contract should include entity identity resolution gate",
  );
  assert.ok(
    contract.layers.includes("temporal_state_transition_contract"),
    "contract should include temporal state transition gate",
  );
  assert.ok(
    contract.layers.includes("capability_delegation_authority_contract"),
    "contract should include capability delegation authority gate",
  );
  assert.equal(contract.evidenceLedgers.memoryCuratorBridge, `.agentlas/${SUPER_ONTOLOGY_MEMORY_BRIDGE_FILE}`);
  assert.equal(
    contract.evidenceLedgers.openWorldCoverage,
    `.agentlas/${SUPER_ONTOLOGY_OPEN_WORLD_COVERAGE_FILE}`,
  );
  assert.equal(
    contract.evidenceLedgers.consensusCoordination,
    `.agentlas/${SUPER_ONTOLOGY_CONSENSUS_COORDINATION_FILE}`,
  );
  assert.equal(contract.evidenceLedgers.taskCoverage, `.agentlas/${SUPER_ONTOLOGY_TASK_COVERAGE_FILE}`);
  assert.equal(contract.evidenceLedgers.contextualFlow, `.agentlas/${SUPER_ONTOLOGY_CONTEXTUAL_FLOW_FILE}`);
  assert.equal(contract.evidenceLedgers.causalImpact, `.agentlas/${SUPER_ONTOLOGY_CAUSAL_IMPACT_FILE}`);
  assert.equal(contract.evidenceLedgers.assuranceCase, `.agentlas/${SUPER_ONTOLOGY_ASSURANCE_CASE_FILE}`);
  assert.equal(
    contract.evidenceLedgers.knowledgeHomeostasis,
    `.agentlas/${SUPER_ONTOLOGY_KNOWLEDGE_HOMEOSTASIS_FILE}`,
  );
  assert.equal(
    contract.evidenceLedgers.adversarialProvenance,
    `.agentlas/${SUPER_ONTOLOGY_ADVERSARIAL_PROVENANCE_FILE}`,
  );
  assert.equal(
    contract.evidenceLedgers.epistemicCalibration,
    `.agentlas/${SUPER_ONTOLOGY_EPISTEMIC_CALIBRATION_FILE}`,
  );
  assert.equal(
    contract.evidenceLedgers.semanticAlignment,
    `.agentlas/${SUPER_ONTOLOGY_SEMANTIC_ALIGNMENT_FILE}`,
  );
  assert.equal(
    contract.evidenceLedgers.resilienceControl,
    `.agentlas/${SUPER_ONTOLOGY_RESILIENCE_CONTROL_FILE}`,
  );
  assert.equal(
    contract.evidenceLedgers.invariantVerification,
    `.agentlas/${SUPER_ONTOLOGY_INVARIANT_VERIFICATION_FILE}`,
  );
  assert.equal(
    contract.evidenceLedgers.observabilityTelemetry,
    `.agentlas/${SUPER_ONTOLOGY_OBSERVABILITY_TELEMETRY_FILE}`,
  );
  assert.equal(
    contract.evidenceLedgers.objectiveProxyValidity,
    `.agentlas/${SUPER_ONTOLOGY_OBJECTIVE_PROXY_VALIDITY_FILE}`,
  );
  assert.equal(
    contract.evidenceLedgers.stakeholderPreferenceGovernance,
    `.agentlas/${SUPER_ONTOLOGY_STAKEHOLDER_PREFERENCE_GOVERNANCE_FILE}`,
  );
  assert.equal(
    contract.evidenceLedgers.normativeAuthorityDrift,
    `.agentlas/${SUPER_ONTOLOGY_NORMATIVE_AUTHORITY_DRIFT_FILE}`,
  );
  assert.equal(
    contract.evidenceLedgers.sideEffectContainment,
    `.agentlas/${SUPER_ONTOLOGY_SIDE_EFFECT_CONTAINMENT_FILE}`,
  );
  assert.equal(
    contract.evidenceLedgers.sourceLineageVersion,
    `.agentlas/${SUPER_ONTOLOGY_SOURCE_LINEAGE_VERSION_FILE}`,
  );
  assert.equal(
    contract.evidenceLedgers.entityIdentityResolution,
    `.agentlas/${SUPER_ONTOLOGY_ENTITY_IDENTITY_RESOLUTION_FILE}`,
  );
  assert.equal(
    contract.evidenceLedgers.temporalStateTransition,
    `.agentlas/${SUPER_ONTOLOGY_TEMPORAL_STATE_TRANSITION_FILE}`,
  );
  assert.equal(
    contract.evidenceLedgers.capabilityDelegationAuthority,
    `.agentlas/${SUPER_ONTOLOGY_CAPABILITY_DELEGATION_AUTHORITY_FILE}`,
  );
  const openWorldCoverage = JSON.parse(fs.readFileSync(openWorldCoveragePath, "utf8"));
  assert.equal(openWorldCoverage.kind, "agentlas-super-ontology-open-world-coverage");
  assert.equal(openWorldCoverage.runtimePromotionAllowed, false);
  assert.equal(openWorldCoverage.defaultDecision, "lower_authority_before_unknown_combination_write");
  assert.ok(
    openWorldCoverage.worldFamilies.includes("company_operations"),
    "open-world coverage should include company operations",
  );
  assert.ok(
    openWorldCoverage.worldFamilies.includes("industrial_physical"),
    "open-world coverage should include industrial physical work",
  );
  assert.ok(
    openWorldCoverage.worldFamilies.includes("unknown_mixed"),
    "open-world coverage should include unknown mixed context",
  );
  assert.ok(openWorldCoverage.modalities.includes("hwp"), "open-world coverage should include HWP");
  assert.ok(openWorldCoverage.modalities.includes("sensor"), "open-world coverage should include sensor data");
  assert.ok(openWorldCoverage.faultModels.includes("implicit_degradation"), "open-world coverage should include implicit degradation");
  assert.ok(openWorldCoverage.faultModels.includes("adversarial_source"), "open-world coverage should include adversarial sources");
  assert.ok(
    openWorldCoverage.hardStops.includes("proposal_example_equals_all_tasks"),
    "open-world coverage should block proposal fixture overgeneralization",
  );
  const consensusCoordination = JSON.parse(fs.readFileSync(consensusCoordinationPath, "utf8"));
  assert.equal(consensusCoordination.kind, "agentlas-super-ontology-consensus-coordination");
  assert.equal(consensusCoordination.runtimePromotionAllowed, false);
  assert.equal(
    consensusCoordination.defaultDecision,
    "treat_agent_agreement_as_candidate_signal_not_write_authority",
  );
  assert.ok(
    consensusCoordination.coordinationTopologies.includes("majority_vote"),
    "consensus coordination should include majority vote",
  );
  assert.ok(
    consensusCoordination.coordinationTopologies.includes("cross_runtime_sync"),
    "consensus coordination should include cross-runtime sync",
  );
  assert.ok(
    consensusCoordination.failureModes.includes("peer_pressure"),
    "consensus coordination should include peer pressure",
  );
  assert.ok(
    consensusCoordination.failureModes.includes("split_brain"),
    "consensus coordination should include split brain",
  );
  assert.ok(
    consensusCoordination.hardStops.includes("majority_vote_as_write_authority"),
    "consensus coordination should block majority vote as write authority",
  );
  const taskCoverage = JSON.parse(fs.readFileSync(taskCoveragePath, "utf8"));
  assert.equal(taskCoverage.kind, "agentlas-super-ontology-task-coverage");
  assert.equal(taskCoverage.runtimePromotionAllowed, false);
  assert.ok(taskCoverage.taskFamilies.includes("draft_artifact"), "task coverage should include draft artifacts");
  assert.ok(taskCoverage.taskFamilies.includes("execute_tool"), "task coverage should include tool execution");
  assert.ok(taskCoverage.taskFamilies.includes("physical_or_sensor"), "task coverage should include physical/sensor work");
  assert.ok(taskCoverage.affordanceTypes.includes("train"), "task coverage should include training affordances");
  const contextualFlow = JSON.parse(fs.readFileSync(contextualFlowPath, "utf8"));
  assert.equal(contextualFlow.kind, "agentlas-super-ontology-contextual-flow");
  assert.equal(contextualFlow.runtimePromotionAllowed, false);
  assert.equal(contextualFlow.defaultDecision, "contextual_flow_required_before_boundary_crossing");
  assert.ok(contextualFlow.flowStages.includes("tool_to_agent"), "contextual flow should include tool responses");
  assert.ok(contextualFlow.flowStages.includes("agent_to_memory"), "contextual flow should include memory handoffs");
  assert.ok(contextualFlow.flowStages.includes("agent_to_public_surface"), "contextual flow should include public surfaces");
  assert.ok(contextualFlow.contexts.includes("personal"), "contextual flow should include personal context");
  assert.ok(contextualFlow.contexts.includes("customer"), "contextual flow should include customer context");
  assert.ok(contextualFlow.contexts.includes("regulated"), "contextual flow should include regulated context");
  assert.ok(
    contextualFlow.hardStops.includes("same_user_means_all_contexts_joinable"),
    "contextual flow should block same-user context joins",
  );
  assert.ok(
    contextualFlow.hardStops.includes("tool_response_as_need_to_know"),
    "contextual flow should block tool-response oversharing",
  );
  const causalImpact = JSON.parse(fs.readFileSync(causalImpactPath, "utf8"));
  assert.equal(causalImpact.kind, "agentlas-super-ontology-causal-impact");
  assert.equal(causalImpact.runtimePromotionAllowed, false);
  assert.equal(causalImpact.defaultDecision, "counterfactual_required_before_state_change");
  assert.ok(causalImpact.causalClaimTypes.includes("correlation_only"), "causal impact should separate correlation");
  assert.ok(causalImpact.causalClaimTypes.includes("memory_intervention"), "causal impact should include memory intervention");
  assert.ok(causalImpact.causalClaimTypes.includes("physical_or_train"), "causal impact should include physical/train work");
  assert.ok(
    causalImpact.hardStops.includes("correlation_as_causation"),
    "causal impact should block correlation as causation",
  );
  assert.ok(
    causalImpact.hardStops.includes("missing_counterfactual_check"),
    "causal impact should require counterfactual checks",
  );
  const assuranceCase = JSON.parse(fs.readFileSync(assuranceCasePath, "utf8"));
  assert.equal(assuranceCase.kind, "agentlas-super-ontology-assurance-case");
  assert.equal(assuranceCase.runtimePromotionAllowed, false);
  assert.equal(assuranceCase.defaultDecision, "evidence_linked_claim_required");
  assert.ok(assuranceCase.claimTypes.includes("rejected_overclaim"), "assurance case should include rejected overclaim");
  assert.ok(assuranceCase.claimTypes.includes("promotion_safety"), "assurance case should include promotion safety");
  assert.ok(assuranceCase.hardStops.includes("unsupported_claim"), "assurance case should block unsupported claims");
  assert.ok(
    assuranceCase.hardStops.includes("perfect_or_zero_error_claim"),
    "assurance case should block perfect or zero-error claims",
  );
  const knowledgeHomeostasis = JSON.parse(fs.readFileSync(knowledgeHomeostasisPath, "utf8"));
  assert.equal(knowledgeHomeostasis.kind, "agentlas-super-ontology-knowledge-homeostasis");
  assert.equal(knowledgeHomeostasis.runtimePromotionAllowed, false);
  assert.equal(
    knowledgeHomeostasis.defaultDecision,
    "homeostasis_required_before_runtime_or_memory_write",
  );
  assert.ok(
    knowledgeHomeostasis.signals.includes("contradiction_rate"),
    "knowledge homeostasis should include contradiction signal",
  );
  assert.ok(
    knowledgeHomeostasis.signals.includes("privacy_incident"),
    "knowledge homeostasis should include privacy incident signal",
  );
  assert.ok(
    knowledgeHomeostasis.signals.includes("runtime_desync_rate"),
    "knowledge homeostasis should include runtime desync signal",
  );
  assert.ok(
    knowledgeHomeostasis.decisions.includes("quarantine"),
    "knowledge homeostasis should include quarantine decision",
  );
  assert.ok(
    knowledgeHomeostasis.decisions.includes("retire"),
    "knowledge homeostasis should include retire decision",
  );
  assert.ok(
    knowledgeHomeostasis.hardStops.includes("critical_homeostasis_runtime_write"),
    "knowledge homeostasis should block critical runtime writes",
  );
  const adversarialProvenance = JSON.parse(fs.readFileSync(adversarialProvenancePath, "utf8"));
  assert.equal(adversarialProvenance.kind, "agentlas-super-ontology-adversarial-provenance");
  assert.equal(adversarialProvenance.runtimePromotionAllowed, false);
  assert.equal(
    adversarialProvenance.defaultDecision,
    "zero_trust_provenance_required_before_retrieval_memory_tool_or_public_seed",
  );
  assert.ok(
    adversarialProvenance.sourceChannels.includes("upload"),
    "adversarial provenance should include upload channel",
  );
  assert.ok(
    adversarialProvenance.sourceChannels.includes("appbridge_route"),
    "adversarial provenance should include AppBridge route channel",
  );
  assert.ok(
    adversarialProvenance.attackVectors.includes("prompt_injection"),
    "adversarial provenance should include prompt injection",
  );
  assert.ok(
    adversarialProvenance.attackVectors.includes("tool_output_tampering"),
    "adversarial provenance should include tool-output tampering",
  );
  assert.ok(
    adversarialProvenance.hardStops.includes("poisoned_source_to_memory"),
    "adversarial provenance should block poisoned source to memory",
  );
  const epistemicCalibration = JSON.parse(fs.readFileSync(epistemicCalibrationPath, "utf8"));
  assert.equal(epistemicCalibration.kind, "agentlas-super-ontology-epistemic-calibration");
  assert.equal(epistemicCalibration.runtimePromotionAllowed, false);
  assert.equal(
    epistemicCalibration.defaultDecision,
    "calibrated_uncertainty_required_before_answer_memory_tool_or_public_seed",
  );
  assert.ok(
    epistemicCalibration.contextTypes.includes("company_internal"),
    "epistemic calibration should include company context",
  );
  assert.ok(
    epistemicCalibration.contextTypes.includes("appbridge_route"),
    "epistemic calibration should include AppBridge route context",
  );
  assert.ok(
    epistemicCalibration.claimTypes.includes("tool_action"),
    "epistemic calibration should include tool actions",
  );
  assert.ok(
    epistemicCalibration.uncertaintySources.includes("conflicting_sources"),
    "epistemic calibration should include conflicting sources",
  );
  assert.ok(
    epistemicCalibration.uncertaintySources.includes("low_retrieval_relevance"),
    "epistemic calibration should include low retrieval relevance",
  );
  assert.ok(
    epistemicCalibration.calibrationSignals.includes("judge_interval"),
    "epistemic calibration should include judge intervals",
  );
  assert.ok(
    epistemicCalibration.hardStops.includes("missing_evidence_as_complete_answer"),
    "epistemic calibration should block missing evidence as complete answer",
  );
  assert.ok(
    epistemicCalibration.hardStops.includes("uncalibrated_route_sync"),
    "epistemic calibration should block uncalibrated route sync",
  );
  const semanticAlignment = JSON.parse(fs.readFileSync(semanticAlignmentPath, "utf8"));
  assert.equal(semanticAlignment.kind, "agentlas-super-ontology-semantic-alignment");
  assert.equal(semanticAlignment.runtimePromotionAllowed, false);
  assert.equal(
    semanticAlignment.defaultDecision,
    "scoped_candidate_alignment_required_before_graph_memory_or_public_seed",
  );
  assert.ok(
    semanticAlignment.candidateRelations.includes("exact_match"),
    "semantic alignment should include exact match",
  );
  assert.ok(
    semanticAlignment.candidateRelations.includes("same_individual"),
    "semantic alignment should include same-individual relation",
  );
  assert.ok(
    semanticAlignment.candidateRelations.includes("conflict"),
    "semantic alignment should include conflict relation",
  );
  assert.ok(
    semanticAlignment.validationChecks.includes("disjointness_check"),
    "semantic alignment should include disjointness check",
  );
  assert.ok(
    semanticAlignment.validationChecks.includes("transitivity_check"),
    "semantic alignment should include transitivity check",
  );
  assert.ok(
    semanticAlignment.validationChecks.includes("human_owner_review"),
    "semantic alignment should include human owner review",
  );
  assert.ok(
    semanticAlignment.hardStops.includes("same_label_as_same_meaning"),
    "semantic alignment should block same label as same meaning",
  );
  assert.ok(
    semanticAlignment.hardStops.includes("embedding_similarity_as_exact_match"),
    "semantic alignment should block embedding similarity as exact match",
  );
  assert.ok(
    semanticAlignment.hardStops.includes("same_individual_without_stable_identifier"),
    "semantic alignment should require stable identity evidence",
  );
  const resilienceControl = JSON.parse(fs.readFileSync(resilienceControlPath, "utf8"));
  assert.equal(resilienceControl.kind, "agentlas-super-ontology-resilience-control");
  assert.equal(resilienceControl.runtimePromotionAllowed, false);
  assert.equal(
    resilienceControl.defaultDecision,
    "degrade_authority_before_runtime_graph_memory_tool_or_sync_write",
  );
  assert.ok(
    resilienceControl.controlLoopPhases.includes("monitor"),
    "resilience control should include monitor phase",
  );
  assert.ok(
    resilienceControl.controlLoopPhases.includes("sync"),
    "resilience control should include sync phase",
  );
  assert.ok(
    resilienceControl.operatingModes.includes("read_only"),
    "resilience control should include read-only mode",
  );
  assert.ok(
    resilienceControl.operatingModes.includes("emergency_stop"),
    "resilience control should include emergency stop mode",
  );
  assert.ok(
    resilienceControl.degradationSignals.includes("validator_disagreement"),
    "resilience control should include validator disagreement",
  );
  assert.ok(
    resilienceControl.degradationSignals.includes("memory_curator_backlog"),
    "resilience control should include curator backlog",
  );
  assert.ok(
    resilienceControl.hardStops.includes("validator_disagreement_to_graph_write"),
    "resilience control should block validator disagreement to graph write",
  );
  assert.ok(
    resilienceControl.hardStops.includes("emergency_stop_bypass_by_route"),
    "resilience control should block emergency stop route bypass",
  );
  const invariantVerification = JSON.parse(fs.readFileSync(invariantVerificationPath, "utf8"));
  assert.equal(invariantVerification.kind, "agentlas-super-ontology-invariant-verification");
  assert.equal(invariantVerification.runtimePromotionAllowed, false);
  assert.equal(
    invariantVerification.defaultDecision,
    "runtime_monitor_required_before_graph_memory_tool_route_release_or_public_write",
  );
  assert.ok(
    invariantVerification.eventStreams.includes("memory_ticket"),
    "invariant verification should include memory ticket stream",
  );
  assert.ok(
    invariantVerification.eventStreams.includes("graph_write"),
    "invariant verification should include graph write stream",
  );
  assert.ok(
    invariantVerification.eventStreams.includes("public_export"),
    "invariant verification should include public export stream",
  );
  assert.ok(
    invariantVerification.eventStreams.includes("route_sync"),
    "invariant verification should include route sync stream",
  );
  assert.ok(
    invariantVerification.monitors.includes("temporal_logic"),
    "invariant verification should include temporal logic monitor",
  );
  assert.ok(
    invariantVerification.monitors.includes("curator_ticket_audit"),
    "invariant verification should include curator ticket audit monitor",
  );
  assert.ok(
    invariantVerification.hardStops.includes("graph_write_without_evidence_invariant"),
    "invariant verification should block graph write without evidence invariant",
  );
  assert.ok(
    invariantVerification.hardStops.includes("emergency_stop_transition_bypassed"),
    "invariant verification should block emergency stop transition bypass",
  );
  const observabilityTelemetry = JSON.parse(fs.readFileSync(observabilityTelemetryPath, "utf8"));
  assert.equal(observabilityTelemetry.kind, "agentlas-super-ontology-observability-telemetry");
  assert.equal(observabilityTelemetry.runtimePromotionAllowed, false);
  assert.equal(
    observabilityTelemetry.defaultDecision,
    "observability_required_before_runtime_graph_memory_tool_route_release_or_public_write",
  );
  assert.ok(
    observabilityTelemetry.eventTypes.includes("graph_write"),
    "observability telemetry should include graph write events",
  );
  assert.ok(
    observabilityTelemetry.eventTypes.includes("memory_ticket"),
    "observability telemetry should include memory ticket events",
  );
  assert.ok(
    observabilityTelemetry.eventTypes.includes("route_sync"),
    "observability telemetry should include route sync events",
  );
  assert.ok(
    observabilityTelemetry.failureModes.includes("missing_trace_id"),
    "observability telemetry should include missing trace failures",
  );
  assert.ok(
    observabilityTelemetry.failureModes.includes("audit_sink_down"),
    "observability telemetry should include audit sink failures",
  );
  assert.ok(
    observabilityTelemetry.failureModes.includes("cross_surface_correlation_missing"),
    "observability telemetry should include cross-surface correlation failures",
  );
  assert.ok(
    observabilityTelemetry.requiredTelemetry.includes("trace_id") &&
      observabilityTelemetry.requiredTelemetry.includes("span_id") &&
      observabilityTelemetry.requiredTelemetry.includes("correlation_id") &&
      observabilityTelemetry.requiredTelemetry.includes("audit_sink_ref") &&
      observabilityTelemetry.requiredTelemetry.includes("before_snapshot_ref") &&
      observabilityTelemetry.requiredTelemetry.includes("rollback_ref"),
    "observability telemetry should require trace/span/correlation/audit/snapshot/rollback fields",
  );
  assert.ok(
    observabilityTelemetry.hardStops.includes("write_without_trace_id"),
    "observability telemetry should block writes without trace id",
  );
  assert.ok(
    observabilityTelemetry.hardStops.includes("route_sync_without_correlation_id"),
    "observability telemetry should block route sync without correlation id",
  );
  assert.ok(
    observabilityTelemetry.hardStops.includes("unobservable_runtime_write"),
    "observability telemetry should block unobservable runtime writes",
  );
  const objectiveProxyValidity = JSON.parse(fs.readFileSync(objectiveProxyValidityPath, "utf8"));
  assert.equal(objectiveProxyValidity.kind, "agentlas-super-ontology-objective-proxy-validity");
  assert.equal(objectiveProxyValidity.runtimePromotionAllowed, false);
  assert.equal(
    objectiveProxyValidity.defaultDecision,
    "construct_validity_required_before_metric_driven_runtime_graph_memory_tool_route_release_or_public_write",
  );
  assert.ok(
    objectiveProxyValidity.constructs.includes("trust") &&
      objectiveProxyValidity.constructs.includes("learning") &&
      objectiveProxyValidity.constructs.includes("reliability") &&
      objectiveProxyValidity.constructs.includes("maintainability") &&
      objectiveProxyValidity.constructs.includes("environmental_impact"),
    "objective proxy validity should include broad constructs",
  );
  assert.ok(
    objectiveProxyValidity.proxyMetrics.includes("benchmark_score") &&
      objectiveProxyValidity.proxyMetrics.includes("test_pass_rate") &&
      objectiveProxyValidity.proxyMetrics.includes("open_rate") &&
      objectiveProxyValidity.proxyMetrics.includes("ontology_edge_count"),
    "objective proxy validity should include benchmark, test, open-rate, and edge-count proxies",
  );
  assert.ok(
    objectiveProxyValidity.validityGaps.includes("reward_tampering") &&
      objectiveProxyValidity.validityGaps.includes("metric_gaming") &&
      objectiveProxyValidity.validityGaps.includes("label_leakage") &&
      objectiveProxyValidity.validityGaps.includes("evaluator_conflict"),
    "objective proxy validity should include reward, gaming, leakage, and evaluator gaps",
  );
  assert.ok(
    objectiveProxyValidity.goodhartModes.includes("campbell_law") &&
      objectiveProxyValidity.goodhartModes.includes("reward_hacking") &&
      objectiveProxyValidity.goodhartModes.includes("proxy_gaming") &&
      objectiveProxyValidity.goodhartModes.includes("benchmark_gaming"),
    "objective proxy validity should include Goodhart and gaming modes",
  );
  assert.ok(
    objectiveProxyValidity.requiredValidityEvidence.includes("construct_definition") &&
      objectiveProxyValidity.requiredValidityEvidence.includes("stakeholder_map") &&
      objectiveProxyValidity.requiredValidityEvidence.includes("countermetric") &&
      objectiveProxyValidity.requiredValidityEvidence.includes("gaming_probe") &&
      objectiveProxyValidity.requiredValidityEvidence.includes("rollback_plan"),
    "objective proxy validity should require construct, stakeholder, countermetric, gaming, and rollback evidence",
  );
  assert.ok(
    objectiveProxyValidity.countermetrics.includes("harm_rate") &&
      objectiveProxyValidity.countermetrics.includes("fairness_delta") &&
      objectiveProxyValidity.countermetrics.includes("source_grounding_rate") &&
      objectiveProxyValidity.countermetrics.includes("reversal_rate") &&
      objectiveProxyValidity.countermetrics.includes("denominator"),
    "objective proxy validity should include harm, fairness, grounding, reversal, and denominator countermetrics",
  );
  assert.ok(
    objectiveProxyValidity.hardStops.includes("metric_improvement_as_goal_completion") &&
      objectiveProxyValidity.hardStops.includes("reward_tampering_to_promotion") &&
      objectiveProxyValidity.hardStops.includes("unvalidated_proxy_to_public_release"),
    "objective proxy validity should block metric, reward-tampering, and public-release shortcuts",
  );
  const stakeholderPreferenceGovernance = JSON.parse(
    fs.readFileSync(stakeholderPreferenceGovernancePath, "utf8"),
  );
  assert.equal(
    stakeholderPreferenceGovernance.kind,
    "agentlas-super-ontology-stakeholder-preference-governance",
  );
  assert.equal(stakeholderPreferenceGovernance.runtimePromotionAllowed, false);
  assert.equal(
    stakeholderPreferenceGovernance.defaultDecision,
    "stakeholder_preference_governance_required_before_multi_party_runtime_graph_memory_tool_route_release_or_public_write",
  );
  assert.ok(
    stakeholderPreferenceGovernance.stakeholderRoles.includes("individual_user") &&
      stakeholderPreferenceGovernance.stakeholderRoles.includes("customer") &&
      stakeholderPreferenceGovernance.stakeholderRoles.includes("legal_compliance") &&
      stakeholderPreferenceGovernance.stakeholderRoles.includes("minority_or_vulnerable_group") &&
      stakeholderPreferenceGovernance.stakeholderRoles.includes("future_maintainer"),
    "stakeholder preference governance should include broad stakeholder roles",
  );
  assert.ok(
    stakeholderPreferenceGovernance.preferenceSignals.includes("privacy_preference") &&
      stakeholderPreferenceGovernance.preferenceSignals.includes("safety_objection") &&
      stakeholderPreferenceGovernance.preferenceSignals.includes("minority_report") &&
      stakeholderPreferenceGovernance.preferenceSignals.includes("recency_check"),
    "stakeholder preference governance should include privacy, safety, minority, and recency signals",
  );
  assert.ok(
    stakeholderPreferenceGovernance.conflictTypes.includes("consent_boundary") &&
      stakeholderPreferenceGovernance.conflictTypes.includes("minority_harm") &&
      stakeholderPreferenceGovernance.conflictTypes.includes("strategic_misreporting") &&
      stakeholderPreferenceGovernance.conflictTypes.includes("unrepresented_party"),
    "stakeholder preference governance should include consent, minority, strategic, and unrepresented conflicts",
  );
  assert.ok(
    stakeholderPreferenceGovernance.aggregationRules.includes("consent_required") &&
      stakeholderPreferenceGovernance.aggregationRules.includes("veto_for_rights") &&
      stakeholderPreferenceGovernance.aggregationRules.includes("majority_with_veto") &&
      stakeholderPreferenceGovernance.aggregationRules.includes("no_aggregation_allowed"),
    "stakeholder preference governance should include consent, veto, vote, and no-aggregation rules",
  );
  assert.ok(
    stakeholderPreferenceGovernance.requiredGovernanceEvidence.includes("stakeholder_map") &&
      stakeholderPreferenceGovernance.requiredGovernanceEvidence.includes("scope_of_authority") &&
      stakeholderPreferenceGovernance.requiredGovernanceEvidence.includes("aggregation_rule") &&
      stakeholderPreferenceGovernance.requiredGovernanceEvidence.includes("dissent_capture") &&
      stakeholderPreferenceGovernance.requiredGovernanceEvidence.includes("appeal_path") &&
      stakeholderPreferenceGovernance.requiredGovernanceEvidence.includes("rollback_plan"),
    "stakeholder preference governance should require stakeholder, authority, aggregation, dissent, appeal, and rollback evidence",
  );
  assert.ok(
    stakeholderPreferenceGovernance.hardStops.includes("owner_preference_as_all_stakeholders") &&
      stakeholderPreferenceGovernance.hardStops.includes("majority_preference_as_rights_clearance") &&
      stakeholderPreferenceGovernance.hardStops.includes("consent_absent_to_personalization") &&
      stakeholderPreferenceGovernance.hardStops.includes("stakeholder_map_missing_for_release"),
    "stakeholder preference governance should block owner, majority, consent, and stakeholder-map shortcuts",
  );
  const normativeAuthorityDrift = JSON.parse(fs.readFileSync(normativeAuthorityDriftPath, "utf8"));
  assert.equal(
    normativeAuthorityDrift.kind,
    "agentlas-super-ontology-normative-authority-drift",
  );
  assert.equal(normativeAuthorityDrift.runtimePromotionAllowed, false);
  assert.equal(
    normativeAuthorityDrift.defaultDecision,
    "normative_authority_required_before_policy_legal_compliance_contract_license_consent_or_runtime_write",
  );
  assert.ok(
    normativeAuthorityDrift.authorityTypes.includes("law") &&
      normativeAuthorityDrift.authorityTypes.includes("contract") &&
      normativeAuthorityDrift.authorityTypes.includes("privacy_policy") &&
      normativeAuthorityDrift.authorityTypes.includes("license") &&
      normativeAuthorityDrift.authorityTypes.includes("emergency_exception"),
    "normative authority drift should include law, contract, privacy, license, and exception types",
  );
  assert.ok(
    normativeAuthorityDrift.scopeDimensions.includes("jurisdiction") &&
      normativeAuthorityDrift.scopeDimensions.includes("effective_date") &&
      normativeAuthorityDrift.scopeDimensions.includes("retention_period") &&
      normativeAuthorityDrift.scopeDimensions.includes("transfer_region") &&
      normativeAuthorityDrift.scopeDimensions.includes("exception_scope"),
    "normative authority drift should include jurisdiction, date, retention, transfer, and exception scopes",
  );
  assert.ok(
    normativeAuthorityDrift.conflictTypes.includes("stale_authority") &&
      normativeAuthorityDrift.conflictTypes.includes("wrong_jurisdiction") &&
      normativeAuthorityDrift.conflictTypes.includes("draft_vs_enforced") &&
      normativeAuthorityDrift.conflictTypes.includes("license_conflict") &&
      normativeAuthorityDrift.conflictTypes.includes("cross_border_conflict"),
    "normative authority drift should include stale, jurisdiction, draft, license, and cross-border conflicts",
  );
  assert.ok(
    normativeAuthorityDrift.requiredAuthorityEvidence.includes("primary_source_ref") &&
      normativeAuthorityDrift.requiredAuthorityEvidence.includes("effective_date") &&
      normativeAuthorityDrift.requiredAuthorityEvidence.includes("jurisdiction_scope") &&
      normativeAuthorityDrift.requiredAuthorityEvidence.includes("precedence_rule") &&
      normativeAuthorityDrift.requiredAuthorityEvidence.includes("rollback_plan"),
    "normative authority drift should require primary source, date, scope, precedence, and rollback evidence",
  );
  assert.ok(
    normativeAuthorityDrift.hardStops.includes("stale_policy_as_current_rule") &&
      normativeAuthorityDrift.hardStops.includes("wrong_jurisdiction_as_valid_policy") &&
      normativeAuthorityDrift.hardStops.includes("expired_consent_as_current_permission") &&
      normativeAuthorityDrift.hardStops.includes("emergency_exception_without_expiry"),
    "normative authority drift should block stale policy, wrong jurisdiction, expired consent, and exception shortcuts",
  );
  const sideEffectContainment = JSON.parse(fs.readFileSync(sideEffectContainmentPath, "utf8"));
  assert.equal(
    sideEffectContainment.kind,
    "agentlas-super-ontology-side-effect-containment",
  );
  assert.equal(sideEffectContainment.runtimePromotionAllowed, false);
  assert.equal(
    sideEffectContainment.defaultDecision,
    "containment_required_before_external_file_finance_release_message_route_memory_training_or_physical_action",
  );
  assert.ok(
    sideEffectContainment.sideEffectClasses.includes("external_message") &&
      sideEffectContainment.sideEffectClasses.includes("payment_or_finance") &&
      sideEffectContainment.sideEffectClasses.includes("public_release") &&
      sideEffectContainment.sideEffectClasses.includes("physical_actuation"),
    "side-effect containment should include message, finance, release, and physical action classes",
  );
  assert.ok(
    sideEffectContainment.requiredContainmentEvidence.includes("idempotency_key") &&
      sideEffectContainment.requiredContainmentEvidence.includes("dry_run_receipt") &&
      sideEffectContainment.requiredContainmentEvidence.includes("rollback_snapshot") &&
      sideEffectContainment.requiredContainmentEvidence.includes("post_action_verification"),
    "side-effect containment should require idempotency, dry-run, rollback, and post-action evidence",
  );
  assert.ok(
    sideEffectContainment.hardStops.includes("preview_as_send") &&
      sideEffectContainment.hardStops.includes("payment_without_idempotency_key") &&
      sideEffectContainment.hardStops.includes("physical_action_without_safety_interlock") &&
      sideEffectContainment.hardStops.includes("scheduled_action_without_cancellation"),
    "side-effect containment should block preview/send, payment idempotency, physical safety, and scheduled cancellation shortcuts",
  );
  const sourceLineageVersion = JSON.parse(fs.readFileSync(sourceLineageVersionPath, "utf8"));
  assert.equal(
    sourceLineageVersion.kind,
    "agentlas-super-ontology-source-lineage-version",
  );
  assert.equal(sourceLineageVersion.runtimePromotionAllowed, false);
  assert.equal(
    sourceLineageVersion.defaultDecision,
    "lineage_required_before_graph_memory_public_training_tool_or_route_authority",
  );
  assert.ok(
    sourceLineageVersion.documentFamilies.includes("policy") &&
      sourceLineageVersion.documentFamilies.includes("spreadsheet") &&
      sourceLineageVersion.documentFamilies.includes("hwp_doc") &&
      sourceLineageVersion.documentFamilies.includes("crm_record"),
    "source lineage version should include policy, spreadsheet, HWP, and CRM document families",
  );
  assert.ok(
    sourceLineageVersion.sourceArtifactTypes.includes("exported_pdf") &&
      sourceLineageVersion.sourceArtifactTypes.includes("sheet_tab") &&
      sourceLineageVersion.sourceArtifactTypes.includes("chunk") &&
      sourceLineageVersion.sourceArtifactTypes.includes("embedding_vector"),
    "source lineage version should include PDF, sheet, chunk, and embedding artifact types",
  );
  assert.ok(
    sourceLineageVersion.requiredLineageEvidence.includes("source_uri") &&
      sourceLineageVersion.requiredLineageEvidence.includes("version_id") &&
      sourceLineageVersion.requiredLineageEvidence.includes("derivation_chain") &&
      sourceLineageVersion.requiredLineageEvidence.includes("chunk_span") &&
      sourceLineageVersion.requiredLineageEvidence.includes("rollback_snapshot"),
    "source lineage version should require source, version, derivation, span, and rollback evidence",
  );
  assert.ok(
    sourceLineageVersion.hardStops.includes("pdf_export_as_primary_source") &&
      sourceLineageVersion.hardStops.includes("summary_as_primary_source") &&
      sourceLineageVersion.hardStops.includes("embedding_hit_without_artifact_version") &&
      sourceLineageVersion.hardStops.includes("superseded_source_to_runtime_write"),
    "source lineage version should block PDF, summary, embedding-version, and superseded-source shortcuts",
  );
  const entityIdentityResolution = JSON.parse(fs.readFileSync(entityIdentityResolutionPath, "utf8"));
  assert.equal(
    entityIdentityResolution.kind,
    "agentlas-super-ontology-entity-identity-resolution",
  );
  assert.equal(entityIdentityResolution.runtimePromotionAllowed, false);
  assert.equal(
    entityIdentityResolution.defaultDecision,
    "identity_evidence_required_before_canonical_graph_memory_public_training_tool_or_route_authority",
  );
  assert.ok(
    entityIdentityResolution.entityFamilies.includes("person") &&
      entityIdentityResolution.entityFamilies.includes("company") &&
      entityIdentityResolution.entityFamilies.includes("customer_account") &&
      entityIdentityResolution.entityFamilies.includes("device"),
    "entity identity resolution should include person, company, account, and device families",
  );
  assert.ok(
    entityIdentityResolution.mentionArtifactTypes.includes("name_string") &&
      entityIdentityResolution.mentionArtifactTypes.includes("crm_id") &&
      entityIdentityResolution.mentionArtifactTypes.includes("embedding_cluster") &&
      entityIdentityResolution.mentionArtifactTypes.includes("llm_generated_canonical"),
    "entity identity resolution should include name, CRM id, embedding cluster, and LLM canonical mention types",
  );
  assert.ok(
    entityIdentityResolution.requiredIdentityEvidence.includes("canonical_entity_id") &&
      entityIdentityResolution.requiredIdentityEvidence.includes("tenant_or_context_id") &&
      entityIdentityResolution.requiredIdentityEvidence.includes("negative_evidence") &&
      entityIdentityResolution.requiredIdentityEvidence.includes("temporal_validity") &&
      entityIdentityResolution.requiredIdentityEvidence.includes("rollback_snapshot"),
    "entity identity resolution should require canonical, context, negative, temporal, and rollback evidence",
  );
  assert.ok(
    entityIdentityResolution.hardStops.includes("name_as_identity") &&
      entityIdentityResolution.hardStops.includes("embedding_cluster_as_identity") &&
      entityIdentityResolution.hardStops.includes("crm_id_cross_tenant_merge") &&
      entityIdentityResolution.hardStops.includes("memory_note_as_identity_authority"),
    "entity identity resolution should block name, embedding, cross-tenant id, and memory-note shortcuts",
  );
  const temporalStateTransition = JSON.parse(fs.readFileSync(temporalStateTransitionPath, "utf8"));
  assert.equal(
    temporalStateTransition.kind,
    "agentlas-super-ontology-temporal-state-transition",
  );
  assert.equal(temporalStateTransition.runtimePromotionAllowed, false);
  assert.equal(
    temporalStateTransition.defaultDecision,
    "temporal_state_evidence_required_before_graph_memory_public_training_tool_route_scheduled_permission_financial_release_or_customer_authority",
  );
  assert.ok(
    temporalStateTransition.stateSubjectFamilies.includes("customer_account") &&
      temporalStateTransition.stateSubjectFamilies.includes("memory_fact") &&
      temporalStateTransition.stateSubjectFamilies.includes("permission") &&
      temporalStateTransition.stateSubjectFamilies.includes("graph_edge"),
    "temporal state transition should include account, memory, permission, and graph-edge subjects",
  );
  assert.ok(
    temporalStateTransition.eventArtifactTypes.includes("state_snapshot") &&
      temporalStateTransition.eventArtifactTypes.includes("webhook_event") &&
      temporalStateTransition.eventArtifactTypes.includes("scheduled_job") &&
      temporalStateTransition.eventArtifactTypes.includes("llm_summary"),
    "temporal state transition should include snapshot, webhook, scheduled job, and LLM summary artifacts",
  );
  assert.ok(
    temporalStateTransition.requiredTemporalEvidence.includes("valid_time") &&
      temporalStateTransition.requiredTemporalEvidence.includes("transaction_time") &&
      temporalStateTransition.requiredTemporalEvidence.includes("event_sequence") &&
      temporalStateTransition.requiredTemporalEvidence.includes("pre_state") &&
      temporalStateTransition.requiredTemporalEvidence.includes("rollback_snapshot"),
    "temporal state transition should require valid, transaction, order, pre-state, and rollback evidence",
  );
  assert.ok(
    temporalStateTransition.hardStops.includes("current_snapshot_as_truth") &&
      temporalStateTransition.hardStops.includes("llm_summary_as_event_log") &&
      temporalStateTransition.hardStops.includes("materialized_view_as_source_of_truth") &&
      temporalStateTransition.hardStops.includes("graph_edge_without_temporal_bounds"),
    "temporal state transition should block snapshot, LLM summary, materialized view, and unbounded-edge shortcuts",
  );
  const capabilityDelegationAuthority = JSON.parse(fs.readFileSync(capabilityDelegationAuthorityPath, "utf8"));
  assert.equal(
    capabilityDelegationAuthority.kind,
    "agentlas-super-ontology-capability-delegation-authority",
  );
  assert.equal(capabilityDelegationAuthority.runtimePromotionAllowed, false);
  assert.equal(
    capabilityDelegationAuthority.defaultDecision,
    "capability_evidence_required_before_graph_memory_public_training_tool_route_scheduled_permission_financial_release_customer_or_physical_authority",
  );
  assert.ok(
    capabilityDelegationAuthority.principalTypes.includes("delegated_agent") &&
      capabilityDelegationAuthority.principalTypes.includes("service_account") &&
      capabilityDelegationAuthority.principalTypes.includes("oauth_client") &&
      capabilityDelegationAuthority.principalTypes.includes("mcp_tool"),
    "capability delegation authority should include delegated-agent, service-account, OAuth, and MCP principals",
  );
  assert.ok(
    capabilityDelegationAuthority.capabilityArtifactTypes.includes("oauth_scope") &&
      capabilityDelegationAuthority.capabilityArtifactTypes.includes("api_key") &&
      capabilityDelegationAuthority.capabilityArtifactTypes.includes("tool_schema") &&
      capabilityDelegationAuthority.capabilityArtifactTypes.includes("capability_token"),
    "capability delegation authority should include OAuth scope, API key, tool schema, and capability token artifacts",
  );
  assert.ok(
    capabilityDelegationAuthority.requiredCapabilityEvidence.includes("delegation_chain") &&
      capabilityDelegationAuthority.requiredCapabilityEvidence.includes("policy_decision") &&
      capabilityDelegationAuthority.requiredCapabilityEvidence.includes("scope") &&
      capabilityDelegationAuthority.requiredCapabilityEvidence.includes("purpose") &&
      capabilityDelegationAuthority.requiredCapabilityEvidence.includes("caveat_set") &&
      capabilityDelegationAuthority.requiredCapabilityEvidence.includes("revocation_check"),
    "capability delegation authority should require delegation, policy, scope, purpose, caveat, and revocation evidence",
  );
  assert.ok(
    capabilityDelegationAuthority.authoritySurfaces.includes("graph_authority") &&
      capabilityDelegationAuthority.authoritySurfaces.includes("memory_authority") &&
      capabilityDelegationAuthority.authoritySurfaces.includes("tool_authority") &&
      capabilityDelegationAuthority.authoritySurfaces.includes("customer_output_authority"),
    "capability delegation authority should cover graph, memory, tool, and customer-output authority surfaces",
  );
  assert.ok(
    capabilityDelegationAuthority.hardStops.includes("role_as_capability") &&
      capabilityDelegationAuthority.hardStops.includes("oauth_scope_as_task_permission") &&
      capabilityDelegationAuthority.hardStops.includes("api_key_as_actor") &&
      capabilityDelegationAuthority.hardStops.includes("tool_schema_as_authorization"),
    "capability delegation authority should block role, OAuth, API-key, and tool-schema shortcuts",
  );
  assert.ok(
    capabilityDelegationAuthority.researchBasis.includes("zero_trust") &&
      capabilityDelegationAuthority.researchBasis.includes("abac") &&
      capabilityDelegationAuthority.researchBasis.includes("zanzibar") &&
      capabilityDelegationAuthority.researchBasis.includes("macaroons"),
    "capability delegation authority should retain zero-trust, ABAC, Zanzibar, and Macaroons research anchors",
  );
  assert.equal(fs.readFileSync(replaysPath, "utf8"), "");
  assert.equal(fs.readFileSync(evidencePath, "utf8"), "");
  assert.equal(fs.readFileSync(memoryBridgePath, "utf8"), "");

  console.log(`super ontology seed smoke passed (${path.basename(memoryDir)})`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
