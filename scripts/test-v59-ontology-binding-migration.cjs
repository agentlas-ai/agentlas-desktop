#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { app } = require("electron");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-v59-ontology-binding-"));
const storePath = path.join(temp, "agentlas.sqlite");
process.env.AGENTLAS_STORE_PATH = storePath;
process.env.AGENTLAS_E2E = "1";

// Simulate a crash after CREATE TABLE but before CREATE INDEX/user_version.
const seed = new Database(storePath);
seed.pragma("foreign_keys = ON");
seed.exec(`
  CREATE TABLE installed_agents (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    installed_at TEXT NOT NULL
  );
  INSERT INTO installed_agents VALUES
    ('agent-bound', 'bound', 'Bound agent', '2026-07-13T00:00:00.000Z'),
    ('agent-legacy', 'legacy', 'Legacy agent', '2026-07-12T00:00:00.000Z');
  -- A real v58 database already has this parent table. Keep the partial-crash
  -- fixture minimal but referentially complete for later additive migrations.
  CREATE TABLE experience_packs (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE
  );
  CREATE TABLE installed_agent_hub_bindings (
    installed_agent_id TEXT PRIMARY KEY,
    agent_definition_id TEXT NOT NULL,
    agent_release_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('hub-install','agent-cloud-restore')),
    bound_at TEXT NOT NULL,
    FOREIGN KEY(installed_agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE,
    UNIQUE(agent_definition_id, agent_release_id, installed_agent_id)
  );
  INSERT INTO installed_agent_hub_bindings VALUES (
    'agent-bound',
    'agd_cccccccccccccccccccccccccccccccccccccccccccccccc',
    'agr_dddddddddddddddddddddddddddddddddddddddddddddddd',
    'hub-install',
    '2026-07-13T00:00:00.000Z'
  );
  PRAGMA user_version = 58;
`);
seed.close();

(async () => {
  try {
    await app.whenReady();
    let store = require("../dist/electron/store/db.js");
    store.initStore();
    let db = store.getDb();
    assert.equal(db.pragma("user_version", { simple: true }), 63);
    assert.deepEqual(
      db.prepare("SELECT * FROM installed_agent_hub_bindings").all(),
      [{
        installed_agent_id: "agent-bound",
        agent_definition_id: "agd_cccccccccccccccccccccccccccccccccccccccccccccccc",
        agent_release_id: "agr_dddddddddddddddddddddddddddddddddddddddddddddddd",
        source: "hub-install",
        bound_at: "2026-07-13T00:00:00.000Z",
      }],
      "v59 must preserve a complete server-issued binding and never backfill legacy rows",
    );
    assert.equal(
      db.prepare(
        "SELECT COUNT(*) AS count FROM installed_agent_hub_bindings WHERE installed_agent_id = 'agent-legacy'",
      ).get().count,
      0,
    );
    const index = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_installed_agent_hub_binding_exact'",
    ).get();
    assert.match(index?.sql ?? "", /agent_definition_id, agent_release_id/i);
    assert.ok(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'taste_draft_candidates'").get(),
      "v60 must add the separate private Taste draft table",
    );
    assert.ok(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'taste_chip_workflows'").get(),
      "v61 must add the owner-reviewed Taste workflow table",
    );
    assert.ok(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'experience_public_projections'").get(),
      "v62 must add the owner-reviewed Operational public projection table",
    );
    assert.ok(
      db.prepare("PRAGMA table_info(taste_chip_workflows)").all().some((column) => column.name === "preview_provenance_json"),
      "v63 must add hashed chip-on/control preview provenance without raw prompt or output storage",
    );

    const rowTime = "2026-07-13T00:05:00.000Z";
    db.prepare(
      `INSERT INTO taste_draft_candidates (
         id, agent_id, source_memory_id, source_memory_hash, project_scope_key,
         environment_key, base_package_hash, base_agent_definition_id,
         base_agent_release_id, sensitivity, confidence, axis_candidates_json,
         task_signatures_json, evidence_state, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'internal', 'high', '[]', '[]',
                 'pairwise-required', 'observation', ?, ?)`,
    ).run(
      "taste-draft-preserved", "agent-bound", "memory-local-only", "source-hash-local-only",
      "scope:test", "darwin-arm64-codex", "a".repeat(64),
      "agd_cccccccccccccccccccccccccccccccccccccccccccccccc",
      "agr_dddddddddddddddddddddddddddddddddddddddddddddddd", rowTime, rowTime,
    );
    db.prepare(
      `INSERT INTO taste_chip_workflows (
         workflow_id, draft_id, agent_id, base_package_hash,
         base_agent_definition_id, base_agent_release_id, environment_key,
         taste_style_id, release_id, title, summary, rule_statement, axis,
         task_signature, contexts_json, generalization_hash,
         privacy_issue_codes_json, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, '[]',
                 'proposal', ?, ?)`,
    ).run(
      "taste-workflow-preserved", "taste-draft-preserved", "agent-bound", "a".repeat(64),
      "agd_cccccccccccccccccccccccccccccccccccccccccccccccc",
      "agr_dddddddddddddddddddddddddddddddddddddddddddddddd",
      "darwin-arm64-codex", "taste-style-preserved", "taste-release-preserved",
      "Preserved style", "Portable summary", "Prefer a single dominant visual hierarchy.",
      "composition", "agentlas.task.v1/presentation", "generalization-hash-local-only",
      rowTime, rowTime,
    );
    assert.equal(
      db.prepare("SELECT preview_provenance_json FROM taste_chip_workflows WHERE workflow_id = ?")
        .get("taste-workflow-preserved").preview_provenance_json,
      null,
      "v63 must preserve an existing v62 workflow and initialize provenance as NULL",
    );

    // Rewinding only the marker simulates a hard exit after ALTER TABLE but
    // before the version commit. Reopening must not issue a duplicate ALTER.
    db.close();
    const rewind = new Database(storePath);
    rewind.pragma("user_version = 62");
    rewind.close();
    const modulePath = require.resolve("../dist/electron/store/db.js");
    delete require.cache[modulePath];
    store = require(modulePath);
    store.initStore();
    db = store.getDb();
    assert.equal(db.pragma("user_version", { simple: true }), 63);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM taste_chip_workflows WHERE workflow_id = ?")
        .get("taste-workflow-preserved").count,
      1,
      "v63 crash replay must preserve the existing workflow row exactly once",
    );
    assert.equal(
      db.prepare("PRAGMA table_info(taste_chip_workflows)").all()
        .filter((column) => column.name === "preview_provenance_json").length,
      1,
      "v63 crash replay must not duplicate the provenance column",
    );

    db.prepare("DELETE FROM installed_agents WHERE id = 'agent-bound'").run();
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM installed_agent_hub_bindings").get().count,
      0,
      "uninstall must cascade only its explicit binding",
    );
    db.close();
    console.log("v63 exact ontology binding, Taste workflow, Operational projection, and A/B provenance migration: PASS");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    app.quit();
  }
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
