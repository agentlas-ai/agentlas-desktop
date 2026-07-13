#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { app } = require("electron");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-v64-automation-permission-"));
const storePath = path.join(temp, "agentlas.sqlite");
process.env.AGENTLAS_STORE_PATH = storePath;
process.env.AGENTLAS_E2E = "1";
app.setPath("userData", path.join(temp, "user-data"));

// Canonical v63 automation row: no execution_permission column yet. The v64
// migration must preserve the historical write behavior without recreating or
// rewriting the automation itself.
const seed = new Database(storePath);
seed.exec(`
  CREATE TABLE automations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    schedule TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    prompt_template TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL DEFAULT 'user',
    last_run_at TEXT,
    next_run_at TEXT,
    created_at TEXT NOT NULL,
    graph_json TEXT,
    schedule_json TEXT,
    timezone TEXT,
    end_at TEXT,
    max_runs INTEGER,
    run_count INTEGER NOT NULL DEFAULT 0,
    trigger_type TEXT NOT NULL DEFAULT 'schedule',
    trigger_json TEXT,
    claimed_at TEXT,
    lease_owner TEXT,
    tool_mode TEXT NOT NULL DEFAULT 'auto',
    hub_mode TEXT NOT NULL DEFAULT 'hub-allowed'
  );
  INSERT INTO automations (
    id, name, schedule, target_type, target_id, prompt_template,
    enabled, created_by, next_run_at, created_at
  ) VALUES (
    'legacy-write', 'Legacy write automation', 'daily-09:00', 'agent',
    'agent-legacy', 'Preserve historical authority', 1, 'user',
    '2026-07-15T00:00:00.000Z', '2026-07-13T00:00:00.000Z'
  );
  PRAGMA user_version = 63;
`);
seed.close();

(async () => {
  try {
    await app.whenReady();
    let store = require("../dist/electron/store/db.js");
    store.initStore();
    let db = store.getDb();
    assert.equal(db.pragma("user_version", { simple: true }), 64);

    const permissionColumn = db
      .prepare("PRAGMA table_info(automations)")
      .all()
      .find((column) => column.name === "execution_permission");
    assert.ok(permissionColumn, "v64 must add automations.execution_permission");
    assert.equal(permissionColumn.notnull, 1);
    assert.equal(permissionColumn.dflt_value, "'write'");
    assert.equal(
      db.prepare("SELECT execution_permission FROM automations WHERE id = ?").get("legacy-write")
        .execution_permission,
      "write",
      "an existing automation must migrate to the explicit backward-compatible write default",
    );

    const automations = require("../dist/electron/store/automations.js");
    assert.equal(automations.getAutomation("legacy-write").executionPermission, "write");
    db.prepare("UPDATE automations SET execution_permission = 'read' WHERE id = ?").run("legacy-write");
    assert.equal(automations.getAutomation("legacy-write").executionPermission, "read");
    assert.throws(
      () => db.prepare("UPDATE automations SET execution_permission = 'full' WHERE id = ?").run("legacy-write"),
      /CHECK constraint failed/,
      "the durable scheduler schema must reject interactive-only full authority",
    );

    // Simulate a hard exit after ALTER but before user_version. Replaying v64
    // must preserve an explicitly stored read permission and avoid duplicate columns.
    db.pragma("user_version = 63");
    db.close();
    delete require.cache[require.resolve("../dist/electron/store/automations.js")];
    delete require.cache[require.resolve("../dist/electron/store/db.js")];
    store = require("../dist/electron/store/db.js");
    store.initStore();
    db = store.getDb();
    assert.equal(db.pragma("user_version", { simple: true }), 64);
    assert.equal(
      db.prepare("PRAGMA table_info(automations)").all()
        .filter((column) => column.name === "execution_permission").length,
      1,
    );
    assert.equal(
      db.prepare("SELECT execution_permission FROM automations WHERE id = ?").get("legacy-write")
        .execution_permission,
      "read",
      "migration replay must never promote a stored read automation back to write",
    );
    db.close();
    console.log("v64 automation execution permission migration: PASS");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    app.quit();
  }
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
