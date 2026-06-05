#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  SUPER_ONTOLOGY_CONTRACT_FILE,
  SUPER_ONTOLOGY_EVIDENCE_FILE,
  SUPER_ONTOLOGY_REPLAYS_FILE,
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

  assert.ok(fs.existsSync(contractPath), "super ontology contract should be seeded");
  assert.ok(fs.existsSync(replaysPath), "super ontology replay ledger should be seeded");
  assert.ok(fs.existsSync(evidencePath), "super ontology evidence ledger should be seeded");

  const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  assert.equal(contract.kind, "agentlas-super-ontology-contract");
  assert.equal(contract.state, "local_candidate");
  assert.equal(contract.runtimeGraphWriteEnabled, false);
  assert.equal(contract.zeroErrorClaim, false);
  assert.equal(contract.promotionPolicy.shadowRequired, true);
  assert.equal(contract.promotionPolicy.canaryRequiredForMixedContext, true);
  assert.equal(contract.promotionPolicy.rollbackRequired, true);
  assert.equal(contract.promotionPolicy.appbridgeSourceWritesBlocked, true);
  assert.ok(contract.layers.includes("belief_ledger"), "contract should include belief ledger gate");
  assert.ok(contract.layers.includes("knowledge_capsule"), "contract should include knowledge capsule gate");
  assert.equal(fs.readFileSync(replaysPath, "utf8"), "");
  assert.equal(fs.readFileSync(evidencePath, "utf8"), "");

  console.log(`super ontology seed smoke passed (${path.basename(memoryDir)})`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
