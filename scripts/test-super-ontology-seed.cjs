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

  assert.ok(fs.existsSync(contractPath), "super ontology contract should be seeded");
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
    contract.layers.includes("invariant_verification_contract"),
    "contract should include invariant verification gate",
  );
  assert.equal(contract.evidenceLedgers.memoryCuratorBridge, `.agentlas/${SUPER_ONTOLOGY_MEMORY_BRIDGE_FILE}`);
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
  assert.equal(fs.readFileSync(replaysPath, "utf8"), "");
  assert.equal(fs.readFileSync(evidencePath, "utf8"), "");
  assert.equal(fs.readFileSync(memoryBridgePath, "utf8"), "");

  console.log(`super ontology seed smoke passed (${path.basename(memoryDir)})`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
