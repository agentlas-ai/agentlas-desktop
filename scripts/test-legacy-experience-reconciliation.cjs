#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-legacy-experience-reconcile-"));
const sourceRoot = path.join(temp, "legacy-agent-source");
const equivalentRoot = path.join(temp, "same-definition-other-location");
fs.mkdirSync(sourceRoot, { recursive: true });
fs.mkdirSync(equivalentRoot, { recursive: true });
fs.writeFileSync(path.join(sourceRoot, "AGENT.md"), "# Research Agent\n\nCompare primary sources before writing.\n", "utf8");
fs.writeFileSync(path.join(sourceRoot, "memory.md"), "# Private Memory\n\nThis file must not affect AgentDefinition identity.\n", "utf8");
fs.writeFileSync(path.join(equivalentRoot, "AGENT.md"), "# Research Agent\n\nCompare primary sources before writing.\n", "utf8");
app.setPath("userData", path.join(temp, "user-data"));
process.env.AGENTLAS_STORE_PATH = path.join(temp, "agentlas.sqlite");
process.env.AGENTLAS_E2E = "1";

async function main() {
  await app.whenReady();
  const store = require("../dist/electron/store/db.js");
  const memory = require("../dist/electron/memory/store.js");
  const routes = require("../dist/electron/agents/routes.js");
  const definition = require("../dist/electron/agents/definition-hash.js");
  const registry = require("../dist/electron/mcp/registry.js");
  const experience = require("../dist/electron/experience/store.js");
  store.initStore();
  const db = store.getDb();

  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO installed_agents (
         id, slug, name, name_en, tagline, tagline_en, system_prompt,
         mcp_servers_json, env_requirements_json, preferred_backend,
         trust_grade, installed_at, tone, builtin, role, visibility, entity_kind
       ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', NULL, 'A', ?, 'blue', 0, NULL, 'visible', 'agent')`,
    ).run("legacy-agent", "legacy-agent", "Legacy Agent", "Legacy Agent", "Research", "Research", "Research safely.", now);
    routes.setRoute({
      agentId: "legacy-agent",
      path: sourceRoot,
      runtime: "codex",
      labels: ["codex"],
      kind: "agent",
      importedAt: now,
    });

    const locationIndependent = definition.computeLocalAgentDefinitionHash(equivalentRoot);
    const firstReconcile = routes.reconcileLocalRouteDefinitionHashes();
    assert.deepEqual(firstReconcile, { scanned: 1, updated: 1, failed: 0, missing: 0 });
    const firstHash = registry.getAgentById("legacy-agent").packageHash;
    assert.match(firstHash, /^[a-f0-9]{64}$/);
    assert.equal(firstHash, locationIndependent, "absolute local paths must not affect AgentDefinition identity");

    fs.writeFileSync(path.join(sourceRoot, "memory.md"), "# Private Memory\n\nChanged private history.\n", "utf8");
    assert.equal(
      definition.computeLocalAgentDefinitionHash(sourceRoot),
      firstHash,
      "mutable Memory must not alter the base AgentDefinition hash",
    );

    memory.insertMemoryEntry({
      scope: "agent_repo",
      kind: "procedure",
      content: "Research workflow: compare two primary sources before writing the report.",
      agentId: "legacy-agent",
      sensitivity: "internal",
      confidence: "high",
      requestContext: { userIntent: "Research and write a source-backed report", triggerTerms: ["research", "writing"] },
    });
    memory.insertMemoryEntry({
      scope: "agent_repo",
      kind: "risk",
      content: "Research the customer by opening /Users/example/private/customer.csv before writing.",
      agentId: "legacy-agent",
      sensitivity: "internal",
      confidence: "high",
      requestContext: { userIntent: "Research customer files", triggerTerms: ["research"] },
    });
    memory.insertMemoryEntry({
      scope: "agent_repo",
      kind: "preference",
      content: "Prefer asymmetric editorial layouts for design work.",
      agentId: "legacy-agent",
      sensitivity: "internal",
      confidence: "medium",
      requestContext: { userIntent: "Design an editorial layout", triggerTerms: ["design"] },
    });
    memory.insertMemoryEntry({
      scope: "agent_repo",
      kind: "fact",
      content: "The report uses a weekly cadence.",
      agentId: "legacy-agent",
      sensitivity: "internal",
      confidence: "medium",
      requestContext: { userIntent: "Write a report", triggerTerms: ["writing"] },
    });
    memory.insertMemoryEntry({
      scope: "agent_repo",
      kind: "preference",
      content: "Prefer the customer palette from /Users/example/private/customer@example.com.",
      agentId: "legacy-agent",
      sensitivity: "internal",
      confidence: "medium",
      requestContext: { userIntent: "Design a customer layout", triggerTerms: ["design"] },
    });

    const firstIntake = experience.reconcileExistingCuratedMemoryCandidates();
    assert.deepEqual(firstIntake, { scanned: 5, candidateCreated: 1, blocked: 2, skipped: 2, deferred: 0 });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM experience_packs").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM experience_candidates").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM taste_draft_candidates").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM experience_promotion_receipts").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM experience_export_intents").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM experience_cloud_uploads").get().n, 0);
    const reasons = db.prepare("SELECT reason_codes_json FROM experience_auto_intake_receipts ORDER BY status").all()
      .flatMap((row) => JSON.parse(row.reason_codes_json));
    assert.ok(reasons.includes("local-path-or-url"));
    assert.ok(reasons.includes("preference-captured-as-private-taste-draft"));
    assert.doesNotMatch(JSON.stringify(db.prepare("SELECT source_memory_hash, reason_codes_json FROM experience_auto_intake_receipts").all()), /\/Users\/|customer\.csv/);

    experience.reconcileExistingCuratedMemoryCandidates();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM experience_candidates").get().n, 1, "reconciliation must be idempotent");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM taste_draft_candidates").get().n, 1, "Taste reconciliation must be idempotent");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM experience_auto_intake_receipts").get().n, 5);
    const taste = experience.listLocalTasteDrafts("legacy-agent");
    assert.equal(taste.length, 1);
    assert.deepEqual(taste[0].axisCandidates, ["composition"]);
    assert.equal(taste[0].evidenceState, "pairwise-required");
    assert.equal(taste[0].baseAgentDefinitionId, null);
    assert.equal(taste[0].baseAgentReleaseId, null);
    assert.doesNotMatch(JSON.stringify(db.prepare("SELECT * FROM taste_draft_candidates").all()), /asymmetric editorial layouts/i, "Taste table must reference Memory instead of duplicating its text");

    const manualPack = db.prepare("SELECT id FROM experience_packs LIMIT 1").get();
    const safePreference = db.prepare("SELECT id FROM memory_entries WHERE kind = 'preference' AND content LIKE 'Prefer asymmetric%'").get();
    await assert.rejects(
      async () => experience.captureExperienceCandidate({ packId: manualPack.id, sourceMemoryId: safePreference.id }),
      /Preferences belong to private Taste drafts/,
      "manual capture must not bypass the Operational/Taste boundary",
    );

    fs.writeFileSync(path.join(sourceRoot, "AGENT.md"), "# Research Agent v2\n\nTriangulate primary sources and record uncertainty.\n", "utf8");
    const secondReconcile = routes.reconcileLocalRouteDefinitionHashes();
    assert.equal(secondReconcile.updated, 1);
    const secondHash = registry.getAgentById("legacy-agent").packageHash;
    assert.notEqual(secondHash, firstHash, "a real AgentDefinition change must create a new exact base identity");
    experience.reconcileExistingCuratedMemoryCandidates();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM experience_packs").get().n, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM experience_candidates").get().n, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM taste_draft_candidates").get().n, 2, "base changes must create a separately bound Taste observation");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM experience_promotion_receipts").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM experience_cloud_uploads").get().n, 0);

    console.log(JSON.stringify({
      ok: true,
      legacyDefinitionFingerprintRecovered: true,
      existingMemoryCandidateRecovered: true,
      privateTasteDraftRecovered: true,
      manualPreferenceOperationalBypassBlocked: true,
      privateContentEmitted: false,
      automaticPromotionUploadPurchaseAttach: 0,
    }, null, 2));
  } finally {
    db.close();
    fs.rmSync(temp, { recursive: true, force: true });
    app.quit();
  }
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
