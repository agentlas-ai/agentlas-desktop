#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { app } = require("electron");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-v48-guard-"));
const storePath = path.join(tempDir, "interrupted-v48.sqlite");
process.env.AGENTLAS_STORE_PATH = storePath;
app.setPath("userData", path.join(tempDir, "user-data"));

const seed = new Database(storePath);
seed.pragma("foreign_keys = ON");
seed.exec(`
  CREATE TABLE installed_agents (id TEXT PRIMARY KEY);
  CREATE TABLE firms (
    id TEXT PRIMARY KEY,
    ceo_agent_id TEXT NOT NULL,
    FOREIGN KEY(ceo_agent_id) REFERENCES installed_agents(id) ON DELETE RESTRICT
  );
  CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    hired_agents TEXT
  );
`);
// Simulate: ALTER succeeded, process died before PRAGMA user_version was advanced.
seed.pragma("user_version = 47");
seed.close();

async function main() {
  try {
    await app.whenReady();
    const store = require("../dist/electron/store/db.js");
    assert.doesNotThrow(() => store.initStore());
    const db = store.getDb();
    assert.equal(db.pragma("user_version", { simple: true }), 51);
    const columns = db.prepare("PRAGMA table_info(chats)").all();
    assert.equal(columns.filter((column) => column.name === "hired_agents").length, 1);
    console.log(JSON.stringify({ ok: true, checks: 3 }, null, 2));
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
