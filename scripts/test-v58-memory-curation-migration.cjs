#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { app } = require("electron");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-v58-curation-migration-"));
const storePath = path.join(temp, "agentlas.sqlite");
process.env.AGENTLAS_STORE_PATH = storePath;
process.env.AGENTLAS_E2E = "1";

const seed = new Database(storePath);
seed.exec(`
  CREATE TABLE run_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,
    chat_id TEXT,
    automation_id TEXT,
    node_id TEXT,
    agent_id TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(run_id, seq)
  );
  CREATE TABLE failure_events (
    id TEXT PRIMARY KEY,
    run_id TEXT,
    ts TEXT NOT NULL,
    source TEXT NOT NULL,
    chat_id TEXT,
    automation_id TEXT,
    node_id TEXT,
    agent_id TEXT,
    error_code TEXT,
    error_message TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}'
  );
  INSERT INTO run_events (
    id, run_id, seq, ts, kind, chat_id, agent_id, payload_json
  ) VALUES (
    'evt-before-v58', 'run-before-v58', 0, '2026-07-12T00:00:00.000Z',
    'memory_curation', 'chat-before-v58', 'agent-before-v58',
    '{"written":0,"memoryEventCount":0}'
  );
  PRAGMA user_version = 57;
`);
seed.close();

(async () => {
  try {
    await app.whenReady();
    const store = require("../dist/electron/store/db.js");
    store.initStore();
    const db = store.getDb();
    assert.equal(db.pragma("user_version", { simple: true }), require("../package.json").agentlasUpdateCompatibility.targetSchemaVersion);
    const index = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_run_events_agent_kind_ts'",
    ).get();
    assert.match(index?.sql ?? "", /run_events\s*\(agent_id, kind, ts DESC\)/i);
    assert.deepEqual(
      db.prepare("SELECT id, run_id, kind, agent_id, payload_json FROM run_events").all(),
      [{
        id: "evt-before-v58",
        run_id: "run-before-v58",
        kind: "memory_curation",
        agent_id: "agent-before-v58",
        payload_json: '{"written":0,"memoryEventCount":0}',
      }],
      "v58 must add only the query index and never rewrite historical receipts",
    );
    db.close();
    console.log("v58 Memory Curator index migration preserves historical receipts: PASS");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    app.quit();
  }
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
