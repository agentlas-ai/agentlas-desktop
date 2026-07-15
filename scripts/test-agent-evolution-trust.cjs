#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { app } = require("electron");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-evolution-trust-"));
const userData = path.join(tmp, "user-data");
fs.mkdirSync(userData, { recursive: true });
const hephaestusRoot = path.join(tmp, "hephaestus-runtime");
const catalogSkillContent = "---\nname: qa-skill\ndescription: Exact QA catalog skill\n---\n\n# QA Skill\n\nRun the focused QA contract with every original instruction intact.\n";
const bomSkillBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# BOM skill\nExact bytes stay exact.\n", "utf8")]);
fs.mkdirSync(path.join(hephaestusRoot, "agentlas_cloud"), { recursive: true });
fs.mkdirSync(path.join(hephaestusRoot, "skills", "qa-skill"), { recursive: true });
fs.mkdirSync(path.join(hephaestusRoot, "skills", "bom-skill"), { recursive: true });
fs.writeFileSync(path.join(hephaestusRoot, "agentlas_cloud", "__main__.py"), "", "utf8");
fs.writeFileSync(path.join(hephaestusRoot, "skills", "qa-skill", "SKILL.md"), catalogSkillContent, "utf8");
fs.writeFileSync(path.join(hephaestusRoot, "skills", "bom-skill", "SKILL.md"), bomSkillBytes);
process.env.HEPHAESTUS_RUNTIME_ROOT = hephaestusRoot;
process.env.AGENTLAS_STORE_PATH = path.join(tmp, "agentlas.sqlite");
app.setPath("userData", userData);

function insertAgent(db, id, slug, prompt) {
  db.prepare(
    `INSERT INTO installed_agents
      (id, slug, name, tagline, system_prompt, mcp_servers_json,
       preferred_backend, trust_grade, installed_at, tone)
     VALUES (?, ?, ?, ?, ?, '[]', NULL, 'local', ?, 'neutral')`,
  ).run(id, slug, slug, `${slug} test agent`, prompt, new Date().toISOString());
}

function proposalInput(agentId, currentContent, proposedContent, source = {}) {
  return {
    agentId,
    targetPath: "system-prompt.md",
    currentContent,
    proposedContent,
    proposalType: "rule",
    risk: "medium",
    summary: "Evolution trust regression",
    source: { surface: "test", ...source },
  };
}

async function main() {
  await app.whenReady();
  const store = require("../dist/electron/store/db.js");
  const memory = require("../dist/electron/memory/store.js");
  const curator = require("../dist/electron/memory/curator.js");
  const files = require("../dist/electron/agents/files.js");
  const evolution = require("../dist/electron/agents/evolution.js");
  const skillCatalog = require("../dist/electron/hephaestus/skill-catalog.js");
  const registry = require("../dist/electron/mcp/registry.js");
  const cloudPackage = require("../dist/electron/cloud-agents/package.js");
  const cloudRestore = require("../dist/electron/cloud-agents/restore.js");
  const routes = require("../dist/electron/agents/routes.js");
  store.initStore();
  const db = store.getDb();
  const original = "# Alpha\n\nOriginal governed prompt.\n";
  insertAgent(db, "agent-alpha", "alpha", original);
  insertAgent(db, "agent-beta", "beta", "# Beta\n");
  files.materializeAgentFiles("agent-alpha");
  files.materializeAgentFiles("agent-beta");

  const target = path.join(userData, "agents", "alpha", "system-prompt.md");
  assert.equal(fs.readFileSync(target, "utf8"), original, "materialized prompt is the authoritative base");
  const canonicalPrompt = files.readAgentPromptSource("agent-alpha");
  assert.equal(canonicalPrompt.relativePath, "system-prompt.md", "main canonical resolver wins over AGENT.md consistently");
  assert.equal(canonicalPrompt.content, original, "canonical prompt keeps exact source bytes");
  assert.equal(db.pragma("user_version", { simple: true }), 65, "receipt schema must be migrated");

  const unstableReviewPath = path.join(userData, "agents", "beta", "prompt.md");
  fs.writeFileSync(unstableReviewPath, "small review base\n", "utf8");
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function mutateAfterReviewRead(file, ...args) {
    const bytes = originalReadFileSync.call(fs, file, ...args);
    if (typeof file === "number") fs.appendFileSync(unstableReviewPath, "changed during read\n", "utf8");
    return bytes;
  };
  try {
    assert.throws(
      () => files.inspectAgentFileText("agent-beta", "prompt.md"),
      /changed while it was being read for review/,
      "review snapshots must reject mutation of the opened inode",
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  fs.writeFileSync(unstableReviewPath, "small review base\n", "utf8");
  fs.readFileSync = function growBeforeReviewRead(file, ...args) {
    if (typeof file === "number") fs.appendFileSync(unstableReviewPath, Buffer.alloc(512 * 1024 + 1));
    return originalReadFileSync.call(fs, file, ...args);
  };
  try {
    assert.throws(
      () => files.inspectAgentFileText("agent-beta", "prompt.md"),
      /portable 512 KiB evolution limit/,
      "actual bytes read, not only the first fstat size, enforce the evolution cap",
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.unlinkSync(unstableReviewPath);
  }

  // Package fingerprints never follow governed symlinks and cap bytes read from
  // the opened inode (not a stale path stat).
  const betaSkillsDir = path.join(userData, "agents", "beta", "skills");
  fs.mkdirSync(betaSkillsDir, { recursive: true });
  const outsideSkill = path.join(tmp, "outside-skill.md");
  fs.writeFileSync(outsideSkill, "# outside\n", "utf8");
  const linkedSkill = path.join(betaSkillsDir, "linked-skill.md");
  fs.symlinkSync(outsideSkill, linkedSkill);
  assert.throws(
    () => files.computeAgentPackageHash("agent-beta", "system-prompt.md"),
    /Symbolic-link agent assets/,
    "a governed symlink must never be followed into an external inode",
  );
  fs.unlinkSync(linkedSkill);
  const oversizedSkill = path.join(betaSkillsDir, "oversized-skill.md");
  fs.writeFileSync(oversizedSkill, "", "utf8");
  fs.truncateSync(oversizedSkill, 50 * 1024 * 1024 + 1);
  assert.throws(
    () => files.computeAgentPackageHash("agent-beta", "system-prompt.md"),
    /package fingerprint limit/,
    "actual bytes read from governed files must respect the package cap",
  );
  fs.unlinkSync(oversizedSkill);

  const autoLearningContent = "Use an atomic publish handoff.";
  const autoReport = curator.curateEvents([{
    memory_kind: "procedure",
    content: autoLearningContent,
    suggested_scope: "agent_repo",
    confidence: "high",
    sensitivity: "internal",
    evidence_refs: ["run:test-auto-collection"],
  }], {
    projectPath: null,
    projectId: null,
    agentId: "agent-alpha",
    chatId: "chat-auto",
  });
  assert.equal(autoReport.written, 1);
  assert.equal(fs.readFileSync(target, "utf8"), original, "auto-collection may add memory but must not rewrite the agent prompt");
  assert.equal(
    fs.existsSync(path.join(userData, "agents", "alpha", "skills")),
    false,
    "auto-collection must not create or alter durable skill assets",
  );
  assert.equal(
    fs.existsSync(path.join(userData, "agents", "alpha", "playbooks")),
    false,
    "auto-collection must not create or alter durable playbook assets",
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM agent_evolution_proposals WHERE agent_id = 'agent-alpha'").get().n,
    0,
    "auto-collection must not auto-create/approve an asset evolution",
  );
  const alphaGlobal = db.prepare("SELECT id, content FROM memory_entries WHERE content = ?").get(autoLearningContent);
  const alphaProject = memory.insertMemoryEntry({
    scope: "project",
    kind: "decision",
    content: "Project Red deploys on Tuesdays.",
    agentId: "agent-alpha",
    projectPath: path.join(tmp, "project-red"),
    confidence: "high",
  });
  const betaGlobal = memory.insertMemoryEntry({
    scope: "agent_repo",
    kind: "procedure",
    content: "Beta-only procedure.",
    agentId: "agent-beta",
    projectPath: null,
    confidence: "high",
  });
  assert.equal(
    memory.hasEquivalentMemory("agent_repo", "procedure", alphaGlobal.content, null, "agent-beta"),
    false,
    "same text owned by another agent must not dedupe across identities",
  );
  assert.equal(
    memory.hasEquivalentMemory("agent_repo", "procedure", alphaGlobal.content, null, "agent-alpha"),
    true,
    "same-agent duplicate detection remains active",
  );
  const betaSameTextReport = curator.curateEvents([{
    memory_kind: "procedure",
    content: autoLearningContent,
    suggested_scope: "agent_repo",
    confidence: "high",
    sensitivity: "internal",
    evidence_refs: ["run:test-beta-identity"],
  }], {
    projectPath: null,
    projectId: null,
    agentId: "agent-beta",
    chatId: "chat-beta",
  });
  assert.equal(betaSameTextReport.written, 1, "cross-agent same-text memory must remain independently owned");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE content = ? AND scope = 'agent_repo'").get(autoLearningContent).n,
    2,
  );

  // Candidate collection is durable review state, never an implicit file write.
  const reviewOnly = evolution.createAgentEvolutionProposal(
    proposalInput("agent-alpha", original, `${original}\nCandidate only.\n`, {
      memoryEntryIds: [alphaGlobal.id],
    }),
  );
  assert.equal(reviewOnly.status, "candidate");
  assert.equal(reviewOnly.receipts.length, 0);
  assert.equal(fs.readFileSync(target, "utf8"), original, "candidate creation must not alter the prompt");
  assert.equal(
    db.prepare("SELECT status FROM agent_evolution_proposals WHERE id = ?").get(reviewOnly.id).status,
    "candidate",
    "the review gate must exist durably before approval",
  );
  const duplicate = evolution.createAgentEvolutionProposal(
    proposalInput("agent-alpha", original, `${original}\nCandidate only.\n`, {
      memoryEntryIds: [alphaGlobal.id],
    }),
  );
  assert.equal(duplicate.id, reviewOnly.id, "lost candidate acknowledgement must be idempotent");
  evolution.rejectAgentEvolutionProposal(reviewOnly.id, "QA rejection");
  assert.equal(fs.readFileSync(target, "utf8"), original, "rejection must leave the original intact");

  assert.throws(
    () => evolution.createAgentEvolutionProposal(
      proposalInput("agent-alpha", original, `${original}\nWrong agent.\n`, { memoryEntryIds: [betaGlobal.id] }),
    ),
    /does not belong to this agent/,
    "another agent's learning must never enter this package",
  );
  assert.throws(
    () => evolution.createAgentEvolutionProposal(
      proposalInput("agent-alpha", original, `${original}\nProject leak.\n`, { memoryEntryIds: [alphaProject.id] }),
    ),
    /Project-scoped memory/,
    "project-specific memory must not become a global agent rule",
  );
  assert.throws(
    () => evolution.createAgentEvolutionProposal(
      proposalInput("agent-alpha", "stale renderer copy", `${original}\nStale.\n`),
    ),
    /base is stale/,
    "renderer-supplied before content cannot override the authoritative file",
  );

  // A file change between review and approval invalidates the candidate.
  const driftCandidate = evolution.createAgentEvolutionProposal(
    proposalInput("agent-alpha", original, `${original}\nWould be stale.\n`),
  );
  files.writeAgentFile("agent-alpha", "system-prompt.md", "# Alpha\n\nManual edit after review.\n");
  assert.throws(
    () => evolution.approveAndApplyAgentEvolutionProposal(driftCandidate.id),
    /changed after review/,
  );
  assert.equal(
    db.prepare("SELECT status FROM agent_evolution_proposals WHERE id = ?").get(driftCandidate.id).status,
    "conflicted",
  );
  assert.match(fs.readFileSync(target, "utf8"), /Manual edit after review/, "conflict handling must not clobber newer work");
  files.writeAgentFile("agent-alpha", "system-prompt.md", original);

  // Happy path: explicit approval, actual file mutation, monotonic version and hash receipt.
  const evolved = `${original}\n## Learned rule\n\n- Use the verified handoff.\n`;
  const applyCandidate = evolution.createAgentEvolutionProposal(
    proposalInput("agent-alpha", original, evolved, { memoryEntryIds: [alphaGlobal.id] }),
  );
  assert.equal(fs.readFileSync(target, "utf8"), original);
  assert.equal(registry.getAgentById("agent-alpha").systemPrompt, original, "candidate must not alter runtime prompt authority");
  assert.equal(files.appendAgentSkillsToSystemPrompt("agent-alpha", registry.getAgentById("agent-alpha").systemPrompt), original);
  const applied = evolution.approveAndApplyAgentEvolutionProposal(applyCandidate.id, "QA reviewed diff");
  assert.equal(applied.status, "applied");
  assert.equal(fs.readFileSync(target, "utf8"), evolved);
  assert.equal(db.prepare("SELECT system_prompt FROM installed_agents WHERE id = 'agent-alpha'").get().system_prompt, evolved);
  assert.equal(registry.getAgentById("agent-alpha").systemPrompt, evolved, "approval must change the next-run prompt authority");
  assert.equal(files.appendAgentSkillsToSystemPrompt("agent-alpha", registry.getAgentById("agent-alpha").systemPrompt), evolved);
  assert.equal(applied.receipts.length, 1);
  const applyReceipt = applied.receipts[0];
  assert.equal(applyReceipt.action, "apply");
  assert.equal(applyReceipt.versionBefore, 1);
  assert.equal(applyReceipt.versionAfter, 2);
  assert.match(applyReceipt.packageHashBefore, /^[a-f0-9]{64}$/);
  assert.match(applyReceipt.packageHashAfter, /^[a-f0-9]{64}$/);
  assert.equal(applyReceipt.governedAssetHashBefore, applyReceipt.packageHashBefore);
  assert.equal(applyReceipt.governedAssetHashAfter, applyReceipt.packageHashAfter);
  assert.notEqual(applyReceipt.packageHashBefore, applyReceipt.packageHashAfter);
  assert.equal(applyReceipt.targetHashBefore, applyCandidate.beforeHash);
  assert.equal(applyReceipt.targetHashAfter, applyCandidate.afterHash);
  assert.equal(
    files.computeAgentPackageHash("agent-alpha", "system-prompt.md"),
    applyReceipt.packageHashAfter,
    "receipt package hash must match the actual governed assets",
  );
  assert.equal(
    evolution.approveAndApplyAgentEvolutionProposal(applyCandidate.id).receipts.length,
    1,
    "approval retries must not mint a second receipt/version",
  );

  // Rollback is compare-and-swap: later edits are protected, then a clean state rolls back.
  files.writeAgentFile("agent-alpha", "system-prompt.md", `${evolved}\nManual post-apply edit.\n`);
  assert.throws(
    () => evolution.rollbackAgentEvolutionProposal(applyCandidate.id),
    /changed after this proposal was applied/,
  );
  assert.match(fs.readFileSync(target, "utf8"), /Manual post-apply edit/, "blocked rollback cannot destroy later edits");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM agent_evolution_receipts WHERE proposal_id = ? AND action = 'rollback'").get(applyCandidate.id).n,
    0,
  );
  files.writeAgentFile("agent-alpha", "system-prompt.md", evolved);
  const rolledBack = evolution.rollbackAgentEvolutionProposal(applyCandidate.id);
  assert.equal(rolledBack.status, "rolled_back");
  assert.equal(fs.readFileSync(target, "utf8"), original);
  assert.equal(registry.getAgentById("agent-alpha").systemPrompt, original, "rollback must restore the next-run prompt authority");
  assert.equal(rolledBack.receipts.length, 2);
  const rollbackReceipt = rolledBack.receipts.find((receipt) => receipt.action === "rollback");
  assert.equal(rollbackReceipt.versionBefore, 2);
  assert.equal(rollbackReceipt.versionAfter, 3);
  assert.equal(rollbackReceipt.packageHashAfter, applyReceipt.packageHashBefore);
  assert.equal(evolution.rollbackAgentEvolutionProposal(applyCandidate.id).receipts.length, 2, "rollback retry is idempotent");

  // Imported/restored packages can use AGENT.md/CLAUDE.md as their canonical
  // prompt source. A receipted rule on those paths must still update the DB
  // authority consumed by the next invocation, then restore it on rollback.
  const alternatePromptPath = path.join(userData, "agents", "beta", "AGENT.md");
  const alternateBefore = fs.readFileSync(alternatePromptPath, "utf8");
  db.prepare("UPDATE installed_agents SET system_prompt = ? WHERE id = 'agent-beta'").run(alternateBefore);
  const alternateAfter = `${alternateBefore}\nApproved alternate prompt rule.\n`;
  const alternateCandidate = evolution.createAgentEvolutionProposal({
    ...proposalInput("agent-beta", alternateBefore, alternateAfter),
    targetPath: "AGENT.md",
  });
  assert.equal(registry.getAgentById("agent-beta").systemPrompt, alternateBefore);
  evolution.approveAndApplyAgentEvolutionProposal(alternateCandidate.id);
  assert.equal(registry.getAgentById("agent-beta").systemPrompt, alternateAfter);
  assert.equal(files.appendAgentSkillsToSystemPrompt("agent-beta", registry.getAgentById("agent-beta").systemPrompt), alternateAfter);
  evolution.rollbackAgentEvolutionProposal(alternateCandidate.id);
  assert.equal(registry.getAgentById("agent-beta").systemPrompt, alternateBefore);

  const siblingDriftContent = `${original}\nApplied before sibling drift.\n`;
  const siblingDriftCandidate = evolution.createAgentEvolutionProposal(
    proposalInput("agent-alpha", original, siblingDriftContent),
  );
  evolution.approveAndApplyAgentEvolutionProposal(siblingDriftCandidate.id);
  const governedSibling = path.join(userData, "agents", "alpha", "memory.md");
  fs.writeFileSync(governedSibling, "# governed edit after apply\n", "utf8");
  assert.throws(
    () => evolution.rollbackAgentEvolutionProposal(siblingDriftCandidate.id),
    /another governed agent asset changed after apply/,
    "rollback must be anchored to the exact receipted post-apply package",
  );
  assert.equal(fs.readFileSync(target, "utf8"), siblingDriftContent);
  assert.equal(fs.readFileSync(governedSibling, "utf8"), "# governed edit after apply\n");
  assert.equal(db.prepare("SELECT status FROM agent_evolution_proposals WHERE id = ?").get(siblingDriftCandidate.id).status, "conflicted");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_evolution_receipts WHERE proposal_id = ? AND action = 'rollback'").get(siblingDriftCandidate.id).n, 0);
  fs.unlinkSync(governedSibling);
  files.writeAgentFile("agent-alpha", "system-prompt.md", original);

  // A non-target governed file changing after rollback enters rolling_back but
  // before the target write must trip the package CAS and preserve both assets.
  const packageRaceAppliedContent = `${original}\nApplied before package rollback race.\n`;
  const packageRaceCandidate = evolution.createAgentEvolutionProposal(
    proposalInput("agent-alpha", original, packageRaceAppliedContent),
  );
  evolution.approveAndApplyAgentEvolutionProposal(packageRaceCandidate.id);
  const originalComputePackageHash = files.computeAgentPackageHash;
  let rollbackHashCalls = 0;
  files.computeAgentPackageHash = function injectGovernedSiblingRace(...args) {
    rollbackHashCalls += 1;
    if (rollbackHashCalls === 2) fs.writeFileSync(governedSibling, "# concurrent governed edit\n", "utf8");
    return originalComputePackageHash(...args);
  };
  try {
    assert.throws(
      () => evolution.rollbackAgentEvolutionProposal(packageRaceCandidate.id),
      /changed immediately before rollback/,
      "rollback must compare the whole governed package again immediately before target mutation",
    );
  } finally {
    files.computeAgentPackageHash = originalComputePackageHash;
  }
  assert.equal(fs.readFileSync(target, "utf8"), packageRaceAppliedContent, "package CAS failure preserves the applied target");
  assert.equal(fs.readFileSync(governedSibling, "utf8"), "# concurrent governed edit\n", "package CAS preserves concurrent sibling bytes");
  assert.equal(
    db.prepare("SELECT status FROM agent_evolution_proposals WHERE id = ?").get(packageRaceCandidate.id).status,
    "conflicted",
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM agent_evolution_receipts WHERE proposal_id = ? AND action = 'rollback'").get(packageRaceCandidate.id).n,
    0,
  );
  fs.unlinkSync(governedSibling);
  files.writeAgentFile("agent-alpha", "system-prompt.md", original);

  // Force receipt commit failure after the atomic file replacement. The original
  // must be restored, with no forged apply receipt.
  const failedApplyContent = `${original}\nThis apply must fail after write.\n`;
  const failedApply = evolution.createAgentEvolutionProposal(
    proposalInput("agent-alpha", original, failedApplyContent),
  );
  db.exec(`
    CREATE TRIGGER fail_test_apply_receipt
    BEFORE INSERT ON agent_evolution_receipts
    WHEN NEW.proposal_id = '${failedApply.id}' AND NEW.action = 'apply'
    BEGIN
      SELECT RAISE(ABORT, 'forced apply receipt failure');
    END;
  `);
  assert.throws(
    () => evolution.approveAndApplyAgentEvolutionProposal(failedApply.id),
    /forced apply receipt failure.*original content restored/,
  );
  assert.equal(fs.readFileSync(target, "utf8"), original, "failed apply must restore the exact original bytes");
  assert.equal(db.prepare("SELECT status FROM agent_evolution_proposals WHERE id = ?").get(failedApply.id).status, "apply_failed");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_evolution_receipts WHERE proposal_id = ?").get(failedApply.id).n, 0);
  db.exec("DROP TRIGGER fail_test_apply_receipt");

  // Force rollback receipt failure after writing the old content. The applied
  // content must be restored and the proposal must remain applied.
  const rollbackFailureContent = `${original}\nApplied before rollback failure.\n`;
  const rollbackFailureCandidate = evolution.createAgentEvolutionProposal(
    proposalInput("agent-alpha", original, rollbackFailureContent),
  );
  evolution.approveAndApplyAgentEvolutionProposal(rollbackFailureCandidate.id);
  db.exec(`
    CREATE TRIGGER fail_test_rollback_receipt
    BEFORE INSERT ON agent_evolution_receipts
    WHEN NEW.proposal_id = '${rollbackFailureCandidate.id}' AND NEW.action = 'rollback'
    BEGIN
      SELECT RAISE(ABORT, 'forced rollback receipt failure');
    END;
  `);
  assert.throws(
    () => evolution.rollbackAgentEvolutionProposal(rollbackFailureCandidate.id),
    /forced rollback receipt failure.*applied content restored/,
  );
  assert.equal(fs.readFileSync(target, "utf8"), rollbackFailureContent);
  assert.equal(db.prepare("SELECT status FROM agent_evolution_proposals WHERE id = ?").get(rollbackFailureCandidate.id).status, "applied");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM agent_evolution_receipts WHERE proposal_id = ? AND action = 'rollback'").get(rollbackFailureCandidate.id).n,
    0,
  );
  db.exec("DROP TRIGGER fail_test_rollback_receipt");
  evolution.rollbackAgentEvolutionProposal(rollbackFailureCandidate.id);
  assert.equal(fs.readFileSync(target, "utf8"), original);

  // Simulate a process ending after the atomic file replacement but before DB
  // finalization. Listing/recovery must finalize one receipt, never reapply.
  const interruptedContent = `${original}\nInterrupted but approved apply.\n`;
  const interrupted = evolution.createAgentEvolutionProposal(
    proposalInput("agent-alpha", original, interruptedContent),
  );
  const baseline = db.prepare("SELECT version, package_hash FROM agent_asset_versions WHERE agent_id = 'agent-alpha'").get();
  db.prepare(
    `UPDATE agent_evolution_proposals
     SET status = 'applying', approved_at = ?, operation_json = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    new Date().toISOString(),
    JSON.stringify({ action: "apply", packageHashBefore: baseline.package_hash, versionBefore: baseline.version, previousStatus: "candidate" }),
    new Date().toISOString(),
    interrupted.id,
  );
  files.writeAgentFile("agent-alpha", "system-prompt.md", interruptedContent);
  evolution.recoverIncompleteAgentEvolutionOperations("agent-alpha");
  const recovered = evolution.listAgentEvolutionProposals("agent-alpha").find((proposal) => proposal.id === interrupted.id);
  assert.equal(recovered.status, "applied");
  assert.equal(recovered.receipts.filter((receipt) => receipt.action === "apply").length, 1);
  assert.equal(fs.readFileSync(target, "utf8"), interruptedContent);

  // Unknown bytes may be a legitimate edit made after the interrupted process.
  // Preserve them for manual diff/recovery and never mint an apply receipt.
  const unknownDestination = `${interruptedContent}\nUnknown destination.\n`;
  const unknown = evolution.createAgentEvolutionProposal(
    proposalInput("agent-alpha", interruptedContent, unknownDestination),
  );
  const unknownBaseline = db.prepare("SELECT version, package_hash FROM agent_asset_versions WHERE agent_id = 'agent-alpha'").get();
  db.prepare(
    `UPDATE agent_evolution_proposals
     SET status = 'applying', approved_at = ?, operation_json = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    new Date().toISOString(),
    JSON.stringify({ action: "apply", packageHashBefore: unknownBaseline.package_hash, versionBefore: unknownBaseline.version, previousStatus: "candidate" }),
    new Date().toISOString(),
    unknown.id,
  );
  files.writeAgentFile("agent-alpha", "system-prompt.md", "# Unknown partial state\n");
  evolution.recoverIncompleteAgentEvolutionOperations("agent-alpha");
  assert.equal(fs.readFileSync(target, "utf8"), "# Unknown partial state\n", "unknown bytes must be preserved for manual comparison");
  const unknownRow = db.prepare("SELECT status, last_error FROM agent_evolution_proposals WHERE id = ?").get(unknown.id);
  assert.equal(unknownRow.status, "recovery_required");
  assert.match(unknownRow.last_error, /preserved them for manual diff and recovery/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_evolution_receipts WHERE proposal_id = ?").get(unknown.id).n, 0);

  // The one supported create-only asset path outside prompts: manual catalog
  // skill injection. It uses the same candidate/CAS/receipt flow, and rollback
  // removes the file because it did not exist before the candidate.
  const catalogAsset = skillCatalog.readSkillCatalogAsset("qa-skill");
  assert.equal(catalogAsset.content, catalogSkillContent, "catalog read returns the exact SKILL.md source bytes");
  assert.equal(catalogAsset.contentHash, createHash("sha256").update(catalogSkillContent).digest("hex"));
  const bomAsset = skillCatalog.readSkillCatalogAsset("bom-skill");
  assert.equal(Buffer.from(bomAsset.content, "utf8").equals(bomSkillBytes), true, "catalog UTF-8 BOM bytes round-trip exactly");
  assert.equal(bomAsset.contentHash, createHash("sha256").update(bomSkillBytes).digest("hex"));
  const skillTarget = "skills/qa-skill/SKILL.md";
  const skillAbsolute = path.join(userData, "agents", "beta", skillTarget);
  const skillContent = catalogAsset.content;
  const skillSource = {
    surface: "test.skill_catalog",
    skillSlug: catalogAsset.slug,
    catalogContentHash: catalogAsset.contentHash,
    catalogByteLength: catalogAsset.byteLength,
  };
  assert.throws(
    () => evolution.createAgentEvolutionProposal({
      agentId: "agent-beta",
      targetPath: path.join(userData, "agents", "alpha", "skills", "escape", "SKILL.md"),
      currentContent: "",
      proposedContent: skillContent,
      proposalType: "skill",
      source: skillSource,
    }),
    /escapes the agent folder/,
    "an agent cannot create a skill in another agent's package",
  );
  assert.throws(
    () => evolution.createAgentEvolutionProposal({
      agentId: "agent-beta",
      targetPath: skillTarget,
      currentContent: "",
      proposedContent: "# Generic description-only replacement\n",
      proposalType: "skill",
      source: skillSource,
    }),
    /does not match the selected catalog source/,
    "renderer-synthesized skill text cannot replace the exact main-owned catalog source",
  );
  assert.throws(
    () => evolution.createAgentEvolutionProposal({
      agentId: "agent-beta",
      targetPath: skillTarget,
      currentContent: "",
      proposedContent: skillContent,
      proposalType: "rule",
      source: skillSource,
    }),
    /Rule evolution target must be a supported root runtime prompt file/,
    "a rule proposal cannot bypass exact-source validation by targeting skills",
  );
  assert.throws(
    () => evolution.createAgentEvolutionProposal({
      agentId: "agent-beta",
      targetPath: "playbooks/freeform.md",
      currentContent: "",
      proposedContent: "arbitrary governed write\n",
      proposalType: "playbook",
    }),
    /Unsupported governed evolution proposal type/,
    "unsupported governed asset types remain fail-closed until they have a specific authority contract",
  );
  const skillRace = evolution.createAgentEvolutionProposal({
    agentId: "agent-beta",
    targetPath: skillTarget,
    currentContent: "",
    proposedContent: skillContent,
    proposalType: "skill",
    summary: "Manual skill injection review",
    source: { ...skillSource, catalogByteLength: 1 },
  });
  assert.equal(skillRace.status, "candidate");
  assert.equal(skillRace.source.catalogByteLength, catalogAsset.byteLength, "main catalog provenance overwrites renderer metadata");
  assert.equal(fs.existsSync(skillAbsolute), false, "skill candidate must not create a placeholder file");
  files.writeAgentFile("agent-beta", skillTarget, "# External owner edit\n");
  assert.throws(
    () => evolution.approveAndApplyAgentEvolutionProposal(skillRace.id),
    /changed after review/,
    "create-only CAS must protect a file created after candidate review",
  );
  assert.equal(fs.readFileSync(skillAbsolute, "utf8"), "# External owner edit\n");
  files.removeAgentFile("agent-beta", skillTarget);

  const skillLinkRace = evolution.createAgentEvolutionProposal({
    agentId: "agent-beta",
    targetPath: skillTarget,
    currentContent: "",
    proposedContent: skillContent,
    proposalType: "skill",
    summary: "Atomic create race review",
    source: skillSource,
  });
  const originalLinkSync = fs.linkSync;
  let injectedCreateRace = false;
  fs.linkSync = function injectCompetingCreate(tempPath, targetPath) {
    if (!injectedCreateRace && path.resolve(targetPath) === path.resolve(skillAbsolute)) {
      injectedCreateRace = true;
      fs.writeFileSync(skillAbsolute, "# Won by external creator during CAS\n", "utf8");
    }
    return originalLinkSync.call(fs, tempPath, targetPath);
  };
  try {
    assert.throws(
      () => evolution.approveAndApplyAgentEvolutionProposal(skillLinkRace.id),
      /EEXIST|file already exists/,
      "OS-level no-replace commit must reject a link-time competing create",
    );
  } finally {
    fs.linkSync = originalLinkSync;
  }
  assert.equal(injectedCreateRace, true);
  assert.equal(fs.readFileSync(skillAbsolute, "utf8"), "# Won by external creator during CAS\n", "EEXIST recovery must preserve the competing owner's bytes");
  const linkRaceRow = db.prepare("SELECT status, last_error FROM agent_evolution_proposals WHERE id = ?").get(skillLinkRace.id);
  assert.equal(linkRaceRow.status, "recovery_required");
  assert.match(linkRaceRow.last_error, /competing file preserved/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_evolution_receipts WHERE proposal_id = ?").get(skillLinkRace.id).n, 0);
  files.removeAgentFile("agent-beta", skillTarget);

  const skillCandidate = evolution.createAgentEvolutionProposal({
    agentId: "agent-beta",
    targetPath: skillTarget,
    currentContent: "",
    proposedContent: skillContent,
    proposalType: "skill",
    summary: "Manual skill injection review",
    source: skillSource,
  });
  assert.equal(fs.existsSync(skillAbsolute), false);
  assert.equal(
    files.appendAgentSkillsToSystemPrompt("agent-beta", "BASE PROMPT"),
    "BASE PROMPT",
    "candidate-only skills must not enter the next invocation prompt",
  );
  const skillApplied = evolution.approveAndApplyAgentEvolutionProposal(skillCandidate.id, "QA approved skill diff");
  assert.equal(skillApplied.status, "applied");
  assert.equal(fs.readFileSync(skillAbsolute, "utf8"), skillContent);
  const promptWithSkill = files.appendAgentSkillsToSystemPrompt("agent-beta", "BASE PROMPT");
  assert.match(promptWithSkill, /Installed agent skills \(package-owned\)/);
  assert.ok(promptWithSkill.includes(skillContent), "the next invocation assembly contains the exact approved catalog source");
  assert.equal(skillApplied.receipts[0].action, "apply");
  assert.equal(skillApplied.receipts[0].targetPath, skillTarget);
  assert.match(skillApplied.receipts[0].packageHashAfter, /^[a-f0-9]{64}$/);

  // Portable lifecycle: approved exact skill survives private Cloud package,
  // exact restore, main-owned runtime assembly, and a second package pass. The
  // local restore marker must not alter the canonical Cloud package identity.
  const betaRoot = path.join(userData, "agents", "beta");
  const packed = await cloudPackage.packageAndReviewCloudAgent({
    rootPath: betaRoot,
    slug: "beta-evolved",
    visibility: "private-link",
    reviewMode: "static-only",
    dryRun: true,
  });
  assert.notEqual(packed.status, "blocked", "an approved portable skill must not be silently omitted from Cloud save");
  const packedBundle = JSON.parse(fs.readFileSync(packed.bundlePath, "utf8"));
  const download = {
    packageHash: packed.manifest.packageHash,
    packageHashVersion: packed.manifest.packageHashVersion,
    fileCount: packed.manifest.includedFileCount,
    totalBytes: packed.manifest.totalBytes,
    agentKind: packed.manifest.agentKind,
    runtimeLabels: packed.manifest.runtimeLabels,
    files: packedBundle.files,
  };
  const restoredRoot = path.join(tmp, "restored-beta");
  cloudRestore.restoreCloudAgentPackage({ destinationDir: restoredRoot, slug: "beta-evolved", package: download });
  const restoredSkill = path.join(restoredRoot, skillTarget);
  assert.equal(fs.readFileSync(restoredSkill, "utf8"), skillContent, "Cloud restore preserves exact approved skill bytes");
  assert.equal(createHash("sha256").update(fs.readFileSync(restoredSkill)).digest("hex"), catalogAsset.contentHash);
  insertAgent(db, "agent-restored-beta", "restored-beta", "fallback must not win");
  routes.setRoute({
    agentId: "agent-restored-beta",
    path: restoredRoot,
    runtime: "generic",
    labels: ["generic"],
    kind: "agent",
    importedAt: new Date().toISOString(),
    source: "agent-cloud",
    packageHash: packed.manifest.packageHash,
  });
  assert.ok(
    files.buildEffectiveAgentSystemPrompt("agent-restored-beta", "fallback must not win").includes(skillContent),
    "restored skill is active in the restored agent's next invocation assembly",
  );
  const repacked = await cloudPackage.packageAndReviewCloudAgent({
    rootPath: restoredRoot,
    slug: "beta-evolved",
    visibility: "private-link",
    reviewMode: "static-only",
    dryRun: true,
  });
  assert.equal(repacked.manifest.packageHash, packed.manifest.packageHash, "restore marker is excluded from canonical Cloud package identity");

  const skillRolledBack = evolution.rollbackAgentEvolutionProposal(skillCandidate.id);
  assert.equal(skillRolledBack.status, "rolled_back");
  assert.equal(fs.existsSync(skillAbsolute), false, "rollback must delete a skill that was absent before apply");
  assert.equal(
    files.appendAgentSkillsToSystemPrompt("agent-beta", "BASE PROMPT"),
    "BASE PROMPT",
    "rolled-back skills must disappear from subsequent invocation assembly",
  );
  assert.equal(skillRolledBack.receipts.find((receipt) => receipt.action === "rollback").packageHashAfter, skillApplied.receipts[0].packageHashBefore);

  const ledger = path.join(userData, "agents", "alpha", ".agentlas", "ledgers", "agent-evolution-proposals.jsonl");
  const ledgerText = fs.readFileSync(ledger, "utf8");
  assert.match(ledgerText, /proposal_created/);
  assert.match(ledgerText, /proposal_applied/);
  assert.match(ledgerText, /proposal_rolled_back/);
  assert.match(ledgerText, /package_hash_after/);
  assert.equal(db.pragma("foreign_key_check").length, 0);

  const runtimeWiringFiles = [
    ["regular chat", "electron/mcp/client.ts"],
    ["firm node", "electron/mcp/firm-orchestrator.ts"],
    ["saved group", "electron/store/agent-groups.ts"],
    ["borrowed task force", "electron/mcp/borrowed-task-force.ts"],
    ["swarm", "electron/mcp/swarm-run.ts"],
    ["auto router", "electron/agents/auto-router.ts"],
  ];
  for (const [surface, relative] of runtimeWiringFiles) {
    const source = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
    assert.match(source, /buildEffectiveAgentSystemPrompt/, `${surface} must consume canonical prompt + approved package skills`);
  }
  for (const relative of [
    "renderer/app/(shell)/library/agents/page.tsx",
    "renderer/app/(shell)/firm/detail/page.tsx",
  ]) {
    const source = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
    assert.match(source, /agentFiles\.promptSource/, `${relative} must ask main for the canonical runtime prompt source`);
  }

  console.log(JSON.stringify({
    ok: true,
    candidateGate: "file-unchanged",
    sourceIsolation: "agent_repo-only",
    applyReceipt: `${applyReceipt.versionBefore}->${applyReceipt.versionAfter}`,
    rollbackReceipt: `${rollbackReceipt.versionBefore}->${rollbackReceipt.versionAfter}`,
    failureRecovery: "original-preserved",
    interruptedRecovery: recovered.receipts[0].id,
    unknownDrift: "preserved-recovery-required",
    skillLifecycle: "absent->candidate->apply-receipt->rollback-delete",
  }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    app.quit();
  });
