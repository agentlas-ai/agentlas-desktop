#!/usr/bin/env node
"use strict";

// Destructive migrations must never be tested against the user's live store.
// This harness takes a consistent read-only SQLite backup, migrates only the
// temporary copy with the current Desktop code, and reports counts (never row
// contents, local paths, agent IDs, prompts, or memory text).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { app } = require("electron");

function sourceArgument(argv) {
  const index = argv.indexOf("--source");
  const value = index >= 0 ? argv[index + 1] : "";
  if (!value || !path.isAbsolute(value)) {
    throw new Error("Usage: electron scripts/test-existing-user-db-upgrade-copy.cjs --source /absolute/path/to/agentlas.sqlite");
  }
  return path.resolve(value);
}

function countIfPresent(db, table) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return exists ? Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count) : 0;
}

function snapshotCounts(db) {
  return {
    installedAgents: countIfPresent(db, "installed_agents"),
    memoryEntries: countIfPresent(db, "memory_entries"),
    runEvents: countIfPresent(db, "run_events"),
  };
}

const sourcePath = sourceArgument(process.argv.slice(2));
if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
  throw new Error("The source SQLite store does not exist.");
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-existing-db-upgrade-"));
const storePath = path.join(tempRoot, "agentlas.sqlite");
const sourceRoutesPath = path.join(path.dirname(sourcePath), "agent-routes.json");
const tempRoutesPath = path.join(tempRoot, "agent-routes.json");
app.setPath("userData", tempRoot);
process.env.AGENTLAS_STORE_PATH = storePath;
process.env.AGENTLAS_E2E = "1";

(async () => {
  let source;
  try {
    source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    source.pragma("query_only = ON");
    const beforeVersion = Number(source.pragma("user_version", { simple: true }));
    const before = snapshotCounts(source);
    await source.backup(storePath);
    source.close();
    source = null;
    if (fs.existsSync(sourceRoutesPath) && fs.statSync(sourceRoutesPath).isFile()) {
      fs.copyFileSync(sourceRoutesPath, tempRoutesPath);
      fs.chmodSync(tempRoutesPath, 0o600);
    }

    await app.whenReady();
    const store = require("../dist/electron/store/db.js");
    store.initStore();
    const migrated = store.getDb();
    const afterVersion = Number(migrated.pragma("user_version", { simple: true }));
    const after = snapshotCounts(migrated);

    assert.ok(beforeVersion < afterVersion, `expected an upgrade, got v${beforeVersion} -> v${afterVersion}`);
    assert.equal(afterVersion, 60, "the current Desktop store target must be v60");
    assert.deepEqual(after, before, "existing agent, memory, and run ledgers must survive the copy-only migration");

    const requiredTables = [
      "experience_packs",
      "experience_candidates",
      "experience_auto_intake_receipts",
      "taste_draft_candidates",
      "installed_agent_hub_bindings",
    ];
    for (const table of requiredTables) {
      assert.ok(
        migrated.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
        `missing v60 table ${table}`,
      );
    }

    const routes = require("../dist/electron/agents/routes.js");
    const experience = require("../dist/electron/experience/store.js");
    const definitionReconciliation = routes.reconcileLocalRouteDefinitionHashes();
    const experienceReconciliation = experience.reconcileExistingCuratedMemoryCandidates();
    const experienceCounts = {
      packs: countIfPresent(migrated, "experience_packs"),
      candidates: countIfPresent(migrated, "experience_candidates"),
      intakeReceipts: countIfPresent(migrated, "experience_auto_intake_receipts"),
      tasteDrafts: countIfPresent(migrated, "taste_draft_candidates"),
      promotions: countIfPresent(migrated, "experience_promotion_receipts"),
      exports: countIfPresent(migrated, "experience_export_intents"),
      cloudUploads: countIfPresent(migrated, "experience_cloud_uploads"),
    };
    assert.equal(experienceCounts.promotions, 0, "legacy reconciliation must not auto-promote");
    assert.equal(experienceCounts.exports, 0, "legacy reconciliation must not auto-export");
    assert.equal(experienceCounts.cloudUploads, 0, "legacy reconciliation must not auto-upload");

    const agentWithMemory = migrated.prepare(`
      SELECT memory.agent_id, COUNT(*) AS count
      FROM memory_entries AS memory
      INNER JOIN installed_agents AS agent ON agent.id = memory.agent_id
      WHERE memory.agent_id IS NOT NULL AND TRIM(memory.agent_id) <> '' AND memory.superseded_at IS NULL
      GROUP BY memory.agent_id
      ORDER BY count DESC
      LIMIT 1
    `).get();
    let learningSummary = null;
    if (agentWithMemory?.agent_id) {
      const learning = require("../dist/electron/agents/learning-summary.js");
      const summary = await learning.getAgentLearningSummary(String(agentWithMemory.agent_id));
      assert.equal(summary.durableMemoryCount, Number(agentWithMemory.count));
      learningSummary = {
        durableMemoryCount: summary.durableMemoryCount,
        curationTurnCount: summary.curationTurnCount,
        runCount: summary.runCount,
        legacyChatLinkedRunCount: summary.legacyChatLinkedRunCount,
        legacyChatLinkedFailureCount: summary.legacyChatLinkedFailureCount,
        failureCount: summary.failureCount,
        legacyUnattributedCount: summary.legacyUnattributedCount,
      };
    }

    migrated.close();
    console.log(JSON.stringify({
      ok: true,
      sourceOpenedReadOnly: true,
      migratedTemporaryCopyOnly: true,
      beforeVersion,
      afterVersion,
      preservedCounts: after,
      learningSummary,
      definitionReconciliation,
      experienceReconciliation,
      experienceCounts,
      emittedPrivateRowContent: false,
    }, null, 2));
  } finally {
    try { source?.close(); } catch {}
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    app.quit();
  }
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
