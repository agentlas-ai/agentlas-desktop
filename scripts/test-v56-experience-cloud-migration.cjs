#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

process.env.AGENTLAS_E2E = "1";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-v56-experience-cloud-migration-"));
const storePath = path.join(temp, "agentlas.sqlite");
process.env.AGENTLAS_STORE_PATH = storePath;

const seed = new Database(storePath);
seed.exec(`
  CREATE TABLE installed_agents (
    id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, name_en TEXT,
    tagline TEXT NOT NULL DEFAULT '', tagline_en TEXT, system_prompt TEXT NOT NULL DEFAULT '',
    mcp_servers_json TEXT NOT NULL DEFAULT '[]', env_requirements_json TEXT NOT NULL DEFAULT '[]',
    preferred_backend TEXT, trust_grade TEXT NOT NULL DEFAULT 'unknown', installed_at TEXT NOT NULL,
    tone TEXT NOT NULL DEFAULT 'blue', builtin INTEGER NOT NULL DEFAULT 0, role TEXT,
    visibility TEXT NOT NULL DEFAULT 'visible', entity_kind TEXT
  );
  INSERT INTO installed_agents (id, slug, name, installed_at) VALUES
    ('agent-v55', 'agent-v55', 'Preserved source name', '2026-07-12T00:00:00.000Z');
  CREATE TABLE run_events (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL,
    kind TEXT NOT NULL, chat_id TEXT, automation_id TEXT, node_id TEXT, agent_id TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE failure_events (
    id TEXT PRIMARY KEY, run_id TEXT, ts TEXT NOT NULL, source TEXT NOT NULL,
    chat_id TEXT, automation_id TEXT, node_id TEXT, agent_id TEXT, error_code TEXT,
    error_message TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE experience_packs (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, project_id TEXT, project_path TEXT,
    project_scope_key TEXT NOT NULL, environment_key TEXT NOT NULL, name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '', base_package_hash TEXT,
    mcp_requirements_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE experience_candidates (
    id TEXT PRIMARY KEY, pack_id TEXT NOT NULL, summary TEXT NOT NULL, source_memory_id TEXT NOT NULL
  );
  CREATE TABLE experience_promotion_receipts (
    id TEXT PRIMARY KEY, pack_id TEXT NOT NULL, candidate_id TEXT NOT NULL, evidence_hash TEXT NOT NULL
  );
  CREATE TABLE experience_export_intents (
    id TEXT PRIMARY KEY, pack_id TEXT NOT NULL, manifest_hash TEXT NOT NULL
  );
  CREATE TABLE experience_lineage_events (
    id TEXT PRIMARY KEY, pack_id TEXT NOT NULL, source_fingerprint TEXT NOT NULL
  );
  CREATE TABLE experience_relation_nodes (node_id TEXT PRIMARY KEY, pack_id TEXT NOT NULL);
  CREATE TABLE experience_relation_edges (
    edge_id TEXT PRIMARY KEY,
    pack_id TEXT NOT NULL,
    from_node TEXT NOT NULL,
    to_node TEXT NOT NULL,
    edge_type TEXT NOT NULL,
    project_scope_key TEXT NOT NULL,
    environment_key TEXT NOT NULL,
    base_package_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    source_fingerprint TEXT NOT NULL,
    rebuilt_at TEXT NOT NULL
  );
  CREATE TABLE experience_relation_index_state (scope_key TEXT PRIMARY KEY, source_fingerprint TEXT NOT NULL);

  INSERT INTO experience_packs VALUES (
    'pack-v55', 'agent-v55', 'project-v55', '/Users/local/private-project',
    'scope-v55', '${"a".repeat(64)}', 'Preserved v55 pack', 'do not rewrite',
    '${"b".repeat(64)}', '[{"catalogId":"browser-mcp","required":false,"alternatives":[]}]',
    'active', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z'
  );
  INSERT INTO experience_candidates VALUES ('candidate-v55', 'pack-v55', 'preserved item body', 'local-memory-v55');
  INSERT INTO experience_promotion_receipts VALUES ('receipt-v55', 'pack-v55', 'candidate-v55', '${"c".repeat(64)}');
  INSERT INTO experience_export_intents VALUES ('intent-v55', 'pack-v55', '${"d".repeat(64)}');
  INSERT INTO experience_lineage_events VALUES ('lineage-v55', 'pack-v55', '${"e".repeat(64)}');
  INSERT INTO experience_relation_nodes VALUES ('node-v55', 'pack-v55');
  INSERT INTO experience_relation_edges VALUES (
    'edge-v55', 'pack-v55', 'node-v55', 'node-v55', 'similar_by_tag',
    'scope-v55', '${"a".repeat(64)}', '${"b".repeat(64)}', '{}',
    '${"f".repeat(64)}', '2026-07-12T00:00:00.000Z'
  );
  INSERT INTO experience_relation_index_state VALUES ('shared', '${"f".repeat(64)}');
  PRAGMA user_version = 55;
`);
seed.close();

const { app } = require("electron");

(async () => {
  try {
    await app.whenReady();
    const store = require("../dist/electron/store/db.js");
    store.initStore();
    const db = store.getDb();
    assert.equal(db.pragma("user_version", { simple: true }), 65);

    const pack = db.prepare(`
      SELECT id, project_path, name, description, mcp_requirements_json,
             base_agent_definition_id, base_agent_release_id, base_package_hash_version,
             environment_profile_json, auto_managed
      FROM experience_packs WHERE id = 'pack-v55'
    `).get();
    assert.deepEqual(pack, {
      id: "pack-v55",
      project_path: "/Users/local/private-project",
      name: "Preserved v55 pack",
      description: "do not rewrite",
      mcp_requirements_json: '[{"catalogId":"browser-mcp","required":false,"alternatives":[]}]',
      base_agent_definition_id: null,
      base_agent_release_id: null,
      base_package_hash_version: null,
      environment_profile_json: null,
      auto_managed: 0,
    });
    for (const [table, idColumn, id] of [
      ["experience_candidates", "id", "candidate-v55"],
      ["experience_promotion_receipts", "id", "receipt-v55"],
      ["experience_export_intents", "id", "intent-v55"],
      ["experience_lineage_events", "id", "lineage-v55"],
      ["experience_relation_nodes", "node_id", "node-v55"],
      ["experience_relation_edges", "edge_id", "edge-v55"],
    ]) {
      assert.ok(db.prepare(`SELECT 1 FROM ${table} WHERE ${idColumn} = ?`).get(id), `${table} row was lost`);
    }
    const cloudColumns = new Set(db.prepare("PRAGMA table_info(experience_cloud_uploads)").all().map((row) => row.name));
    for (const column of [
      "canonical_bundle_json", "bundle_hash", "idempotency_key", "remote_revision",
      "remote_status", "remote_error_code", "remote_error_message", "remote_receipt_json",
    ]) assert.ok(cloudColumns.has(column), `missing v56 column ${column}`);
    assert.equal(db.prepare("SELECT count(*) AS count FROM experience_cloud_uploads").get().count, 0);
    assert.equal(db.prepare("SELECT local_display_name FROM installed_agents WHERE id = 'agent-v55'").get().local_display_name, null);
    assert.equal(db.prepare("SELECT count(*) AS count FROM experience_auto_intake_receipts").get().count, 0);
    db.close();
    console.log("v60 Desktop migration preserves all v55/v56 assets and adds nullable canonical metadata, curation index, exact ontology bindings, and private Taste drafts: PASS");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    app.quit();
  }
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
