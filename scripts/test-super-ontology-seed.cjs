#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  SUPER_ONTOLOGY_ASSURANCE_CASE_FILE,
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

  assert.ok(fs.existsSync(contractPath), "super ontology contract should be seeded");
  assert.ok(fs.existsSync(taskCoveragePath), "super ontology task coverage should be seeded");
  assert.ok(fs.existsSync(assuranceCasePath), "super ontology assurance case should be seeded");
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
  assert.equal(contract.promotionPolicy.assuranceCaseRequired, true);
  assert.equal(contract.promotionPolicy.directDurableMemoryWritesBlocked, true);
  assert.ok(contract.layers.includes("belief_ledger"), "contract should include belief ledger gate");
  assert.ok(contract.layers.includes("knowledge_capsule"), "contract should include knowledge capsule gate");
  assert.ok(contract.layers.includes("memory_curator_bridge"), "contract should include memory curator bridge gate");
  assert.ok(contract.layers.includes("task_coverage_contract"), "contract should include task coverage gate");
  assert.ok(contract.layers.includes("assurance_case_contract"), "contract should include assurance case gate");
  assert.equal(contract.evidenceLedgers.memoryCuratorBridge, `.agentlas/${SUPER_ONTOLOGY_MEMORY_BRIDGE_FILE}`);
  assert.equal(contract.evidenceLedgers.taskCoverage, `.agentlas/${SUPER_ONTOLOGY_TASK_COVERAGE_FILE}`);
  assert.equal(contract.evidenceLedgers.assuranceCase, `.agentlas/${SUPER_ONTOLOGY_ASSURANCE_CASE_FILE}`);
  const taskCoverage = JSON.parse(fs.readFileSync(taskCoveragePath, "utf8"));
  assert.equal(taskCoverage.kind, "agentlas-super-ontology-task-coverage");
  assert.equal(taskCoverage.runtimePromotionAllowed, false);
  assert.ok(taskCoverage.taskFamilies.includes("draft_artifact"), "task coverage should include draft artifacts");
  assert.ok(taskCoverage.taskFamilies.includes("execute_tool"), "task coverage should include tool execution");
  assert.ok(taskCoverage.taskFamilies.includes("physical_or_sensor"), "task coverage should include physical/sensor work");
  assert.ok(taskCoverage.affordanceTypes.includes("train"), "task coverage should include training affordances");
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
  assert.equal(fs.readFileSync(replaysPath, "utf8"), "");
  assert.equal(fs.readFileSync(evidencePath, "utf8"), "");
  assert.equal(fs.readFileSync(memoryBridgePath, "utf8"), "");

  console.log(`super ontology seed smoke passed (${path.basename(memoryDir)})`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
