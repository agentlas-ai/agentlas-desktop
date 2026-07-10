#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Database = require("better-sqlite3");
const { app } = require("electron");

const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-health-audit-"));
const dbPath = path.join(temp, "audit.sqlite");
const db = new Database(dbPath);
const now = Date.now();
db.exec(`
  CREATE TABLE automations (
    id TEXT PRIMARY KEY, name TEXT, enabled INTEGER, next_run_at TEXT, last_run_at TEXT,
    run_count INTEGER, prompt_template TEXT, tool_mode TEXT, hub_mode TEXT,
    claimed_at TEXT, lease_owner TEXT, created_at TEXT
  );
  CREATE TABLE mcp_servers (catalog_id TEXT, name TEXT, enabled INTEGER, installed_at TEXT);
  CREATE TABLE run_history (automation_id TEXT, status TEXT, error TEXT, ran_at TEXT);
  CREATE TABLE chats (id TEXT PRIMARY KEY, kind TEXT, title TEXT);
  CREATE TABLE chat_messages (chat_id TEXT, role TEXT, text TEXT, created_at TEXT);
`);
db.prepare(`INSERT INTO automations VALUES (?, ?, 1, ?, NULL, 0, '', 'auto', 'hub-allowed', NULL, NULL, ?)`)
  .run("target", "Target audit", new Date(now + 60_000).toISOString(), new Date(now - 10_000).toISOString());
db.prepare(`INSERT INTO automations VALUES (?, ?, 1, ?, NULL, 0, '', 'auto', 'hub-allowed', NULL, NULL, ?)`)
  .run("grace", "Grace window", new Date(now - 60_000).toISOString(), new Date(now - 10_000).toISOString());
db.prepare("INSERT INTO chats VALUES ('target-chat', 'division', '⟦automation⟧target::target:agent:abc')").run();
db.prepare("INSERT INTO chat_messages VALUES ('target-chat', 'assistant', 'pipeline failed because browser tools unavailable', ?)")
  .run(new Date(now - 120_000).toISOString());
db.prepare("INSERT INTO run_history VALUES ('target', 'ok', '', ?)").run(new Date(now - 120_000).toISOString());
for (let i = 0; i < 12; i += 1) {
  db.prepare("INSERT INTO run_history VALUES (?, 'ok', '', ?)").run(`noise-${i}`, new Date(now - i * 1000).toISOString());
}
db.close();

try {
  const result = spawnSync("node", [path.join(root, "scripts/audit-automation-health.mjs"), "--once", "--db", dbPath], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, AGENTLAS_AUDIT_DUE_GRACE_MS: "300000" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /False OK candidate: Target audit/, "per-automation latest run must survive global recent-run noise");
  assert.doesNotMatch(result.stdout, /Automation is due but not advanced: Grace window/, "normal scheduler grace must not be flagged overdue");
  console.log(JSON.stringify({ ok: true, checks: 2 }, null, 2));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
  app.quit();
}
