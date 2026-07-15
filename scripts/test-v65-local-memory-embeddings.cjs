#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { app } = require("electron");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-v65-memory-"));
const storePath = path.join(temp, "agentlas.sqlite");
process.env.AGENTLAS_STORE_PATH = storePath;
process.env.AGENTLAS_E2E = "1";
app.setPath("userData", path.join(temp, "user-data"));

const seed = new Database(storePath);
seed.exec(`
  CREATE TABLE memory_entries (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
    project_id TEXT, project_path TEXT, agent_id TEXT, chat_id TEXT,
    confidence TEXT NOT NULL DEFAULT 'medium', sensitivity TEXT NOT NULL DEFAULT 'internal',
    evidence_json TEXT NOT NULL DEFAULT '[]', context_json TEXT NOT NULL DEFAULT '{}',
    superseded_at TEXT, created_at TEXT NOT NULL
  );
  INSERT INTO memory_entries VALUES (
    'legacy-memory', 'agent_repo', 'procedure', 'Check the visible account badge before publishing.',
    NULL, NULL, 'agent-a', NULL, 'high', 'internal', '[]', '{}', NULL,
    '2026-07-15T00:00:00.000Z'
  );

  CREATE TABLE experience_packs (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, project_scope_key TEXT NOT NULL,
    environment_key TEXT NOT NULL, status TEXT NOT NULL, base_package_hash TEXT
  );
  INSERT INTO experience_packs VALUES ('pack-a', 'agent-a', 'global', 'env-a', 'active', '${"a".repeat(64)}');
  CREATE TABLE experience_candidates (
    id TEXT PRIMARY KEY, pack_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    project_scope_key TEXT NOT NULL, environment_key TEXT NOT NULL,
    source_memory_id TEXT NOT NULL, summary TEXT NOT NULL, task_terms_json TEXT NOT NULL DEFAULT '[]',
    sensitivity TEXT NOT NULL, confidence TEXT NOT NULL, status TEXT NOT NULL,
    outcome_status TEXT NOT NULL, public_safe INTEGER NOT NULL DEFAULT 0,
    auto_managed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, promoted_at TEXT
  );
  INSERT INTO experience_candidates VALUES (
    'candidate-a', 'pack-a', 'agent-a', 'global', 'env-a', 'legacy-memory',
    'Check the visible account badge before publishing.', '[]', 'internal', 'high',
    'promoted', 'attested', 0, 0, '2026-07-15T00:00:00.000Z',
    '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z'
  );
  CREATE TABLE experience_relation_nodes (
    node_id TEXT PRIMARY KEY, pack_id TEXT NOT NULL, node_type TEXT NOT NULL,
    entity_ref TEXT NOT NULL, project_scope_key TEXT NOT NULL, environment_key TEXT NOT NULL,
    base_package_hash TEXT NOT NULL, normalized_value TEXT, payload_json TEXT NOT NULL DEFAULT '{}',
    source_fingerprint TEXT NOT NULL, rebuilt_at TEXT NOT NULL
  );
  CREATE TABLE experience_relation_edges (
    edge_id TEXT PRIMARY KEY, pack_id TEXT NOT NULL, from_node TEXT NOT NULL,
    to_node TEXT NOT NULL, edge_type TEXT NOT NULL CHECK(edge_type IN (
      'has_release','exact_base_binding','contains','applies_to_task','applies_in_environment',
      'requires_mcp','supports_mcp','alternative_mcp','supported_by','supersedes','similar_by_tag'
    )), project_scope_key TEXT NOT NULL, environment_key TEXT NOT NULL,
    base_package_hash TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}',
    source_fingerprint TEXT NOT NULL, rebuilt_at TEXT NOT NULL
  );
  PRAGMA user_version = 64;
`);
seed.close();

(async () => {
  try {
    await app.whenReady();
    const store = require("../dist/electron/store/db.js");
    store.initStore();
    const db = store.getDb();
    assert.equal(db.pragma("user_version", { simple: true }), 65);
    for (const table of ["memory_entries", "experience_candidates"]) {
      const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
      for (const column of [
        "embedding_model", "embedding_adapter", "embedding_model_sha256",
        "embedding_content_hash", "embedding_dimensions", "embedding_json",
      ]) {
        assert.ok(columns.has(column), `${table}.${column} must migrate additively`);
      }
    }
    const edgeDefinition = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'experience_relation_edges'",
    ).get().sql;
    assert.match(edgeDefinition, /similar_to/);
    assert.match(edgeDefinition, /contradicts/);
    assert.match(edgeDefinition, /similar_by_tag/, "legacy edges remain readable during migration");
    assert.ok(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'experience_governance_relations'",
    ).get(), "explicit supersedes/contradicts must have a durable non-derived source table");

    const memory = require("../dist/electron/memory/store.js");
    const [legacy] = memory.listGlobalMemoryForAgent("agent-a", 10);
    assert.equal(legacy.embedding.model, "local_hashing");
    assert.equal(legacy.embedding.dimensions, 96);
    assert.equal(legacy.embedding.vector.length, 96);
    const stored = db.prepare(
      `SELECT embedding_model, embedding_adapter, embedding_model_sha256,
              embedding_content_hash, embedding_dimensions, embedding_json
         FROM memory_entries WHERE id = 'legacy-memory'`,
    ).get();
    assert.equal(stored.embedding_model, "local_hashing");
    assert.match(stored.embedding_adapter, /^local_hashing:/);
    assert.equal(stored.embedding_model_sha256, null);
    assert.match(stored.embedding_content_hash, /^[0-9a-f]{64}$/);
    assert.equal(stored.embedding_dimensions, 96);
    assert.equal(JSON.parse(stored.embedding_json).length, 96);

    // Replaying an interrupted v65 marker is idempotent: additive columns and
    // the semantic relation constraint are not duplicated or rebuilt again.
    db.pragma("user_version = 64");
    db.close();
    delete require.cache[require.resolve("../dist/electron/memory/store.js")];
    delete require.cache[require.resolve("../dist/electron/store/db.js")];
    const reopened = require("../dist/electron/store/db.js");
    reopened.initStore();
    assert.equal(reopened.getDb().pragma("user_version", { simple: true }), 65);
    assert.equal(
      reopened.getDb().prepare("PRAGMA table_info(memory_entries)").all()
        .filter((row) => row.name === "embedding_json").length,
      1,
    );
    reopened.getDb().close();
    console.log(JSON.stringify({ ok: true, schemaVersion: 65, embeddingDimensions: 96 }, null, 2));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    app.quit();
  }
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
