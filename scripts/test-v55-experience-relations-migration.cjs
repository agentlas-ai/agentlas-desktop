#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

process.env.AGENTLAS_E2E = "1";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-v55-experience-migration-"));
const storePath = path.join(temp, "agentlas.sqlite");
process.env.AGENTLAS_STORE_PATH = storePath;

const seed = new Database(storePath);
seed.exec(`
  CREATE TABLE installed_agents (
    id TEXT PRIMARY KEY
  );
  INSERT INTO installed_agents (id) VALUES ('agent-v54');
  CREATE TABLE run_events (
    id TEXT PRIMARY KEY,
    agent_id TEXT,
    ts TEXT NOT NULL
  );
  CREATE TABLE failure_events (
    id TEXT PRIMARY KEY,
    agent_id TEXT,
    ts TEXT NOT NULL
  );
  CREATE TABLE experience_packs (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    project_id TEXT,
    project_path TEXT,
    project_scope_key TEXT NOT NULL,
    environment_key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    base_package_hash TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO experience_packs (
    id, agent_id, project_scope_key, environment_key, name, description,
    base_package_hash, status, created_at, updated_at
  ) VALUES (
    'pack-v54', 'agent-v54', 'global', '${"a".repeat(64)}',
    'Preserved pack', 'existing v54 data', '${"b".repeat(64)}', 'active',
    '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z'
  );
  CREATE TABLE experience_candidates (
    id TEXT PRIMARY KEY,
    pack_id TEXT NOT NULL,
    agent_id TEXT NOT NULL
  );
  PRAGMA user_version = 54;
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
    const pack = db.prepare(
      `SELECT id, name, description, mcp_requirements_json,
              environment_profile_json, auto_managed
         FROM experience_packs WHERE id = 'pack-v54'`,
    ).get();
    assert.deepEqual(pack, {
      id: "pack-v54",
      name: "Preserved pack",
      description: "existing v54 data",
      mcp_requirements_json: "[]",
      environment_profile_json: null,
      auto_managed: 0,
    });
    for (const table of [
      "experience_lineage_events",
      "experience_relation_nodes",
      "experience_relation_edges",
      "experience_relation_index_state",
      "experience_auto_intake_receipts",
    ]) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
    }
    db.close();
    console.log("v55 Experience relation migration preserves v54 assets: PASS");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    app.quit();
  }
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
