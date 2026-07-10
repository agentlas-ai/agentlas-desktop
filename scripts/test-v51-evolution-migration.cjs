#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { app } = require("electron");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-v51-evolution-"));
const storePath = path.join(tempDir, "legacy-v50.sqlite");
process.env.AGENTLAS_STORE_PATH = storePath;
app.setPath("userData", path.join(tempDir, "user-data"));

const seed = new Database(storePath);
seed.pragma("foreign_keys = ON");
seed.exec(`
  CREATE TABLE installed_agents (id TEXT PRIMARY KEY);
  INSERT INTO installed_agents (id) VALUES ('agent-legacy');

  CREATE TABLE agent_evolution_proposals (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    proposal_type TEXT NOT NULL,
    summary TEXT NOT NULL,
    target_path TEXT NOT NULL,
    before_hash TEXT NOT NULL,
    after_hash TEXT NOT NULL,
    before_content TEXT NOT NULL,
    after_content TEXT NOT NULL,
    risk TEXT NOT NULL,
    status TEXT NOT NULL,
    source_json TEXT NOT NULL DEFAULT '{}',
    decision_note TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    approved_at TEXT,
    applied_at TEXT,
    measured_at TEXT,
    rolled_back_at TEXT
  );
`);
const insert = seed.prepare(`
  INSERT INTO agent_evolution_proposals (
    id, agent_id, proposal_type, summary, target_path,
    before_hash, after_hash, before_content, after_content,
    risk, status, source_json, decision_note, last_error,
    created_at, updated_at, approved_at, applied_at, measured_at, rolled_back_at
  ) VALUES (?, 'agent-legacy', 'rule', ?, 'AGENT.md', ?, ?, ?, ?, 'medium', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
`);
insert.run(
  "legacy-candidate",
  "legacy candidate",
  "before-candidate-hash",
  "after-candidate-hash",
  "candidate before\r\n",
  "candidate after\r\n",
  "candidate",
  JSON.stringify({ surface: "legacy-v50", nested: { keep: true } }),
  "review later",
  null,
  "2026-01-01T00:00:00.000Z",
  "2026-01-02T00:00:00.000Z",
  null,
  null,
);
insert.run(
  "legacy-applied",
  "legacy applied",
  "before-applied-hash",
  "after-applied-hash",
  "applied before\n",
  "applied after\n",
  "applied",
  JSON.stringify({ surface: "legacy-v50", receiptDidNotExistYet: true }),
  "approved before v51",
  "legacy note preserved",
  "2026-02-01T00:00:00.000Z",
  "2026-02-02T00:00:00.000Z",
  "2026-02-02T00:00:00.000Z",
  "2026-02-02T00:00:01.000Z",
);
seed.pragma("user_version = 50");
const beforeRows = seed.prepare("SELECT * FROM agent_evolution_proposals ORDER BY id").all();
seed.close();

function freshStoreModule() {
  const modulePath = require.resolve("../dist/electron/store/db.js");
  delete require.cache[modulePath];
  return require(modulePath);
}

function assertMigrated(store, pass) {
  store.initStore();
  const db = store.getDb();
  assert.equal(db.pragma("user_version", { simple: true }), 51, `${pass}: user_version`);
  const columns = db.prepare("PRAGMA table_info(agent_evolution_proposals)").all();
  assert.equal(columns.filter((column) => column.name === "operation_json").length, 1, `${pass}: operation_json once`);
  const afterRows = db.prepare(`
    SELECT id, agent_id, proposal_type, summary, target_path,
           before_hash, after_hash, before_content, after_content,
           risk, status, source_json, decision_note, last_error,
           created_at, updated_at, approved_at, applied_at, measured_at, rolled_back_at
    FROM agent_evolution_proposals ORDER BY id
  `).all();
  assert.deepEqual(afterRows, beforeRows, `${pass}: every legacy row byte/status field is preserved`);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_asset_versions").get().n, 0, `${pass}: versions table exists empty`);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_evolution_receipts").get().n, 0, `${pass}: receipts table exists empty`);
  assert.equal(db.pragma("foreign_key_check").length, 0, `${pass}: foreign keys valid`);
  return db;
}

async function main() {
  try {
    await app.whenReady();
    const firstDb = assertMigrated(freshStoreModule(), "first migration");
    firstDb.close();
    // Rewind only the version marker to simulate a process that completed DDL
    // but died before advancing user_version. The v51 block must be rerunnable.
    const rewind = new Database(storePath);
    rewind.pragma("user_version = 50");
    rewind.close();
    const secondDb = assertMigrated(freshStoreModule(), "idempotent reopen");
    secondDb.close();
    console.log(JSON.stringify({ ok: true, legacyRows: beforeRows.length, passes: 2 }, null, 2));
  } finally {
    app.quit();
    setTimeout(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
      process.exit(0);
    }, 50).unref?.();
  }
}

main().catch((error) => {
  console.error(error);
  app.quit();
  process.exitCode = 1;
});
