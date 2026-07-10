#!/usr/bin/env node
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

function argValue(name) {
  const prefix = `${name}=`;
  const item = process.argv.find((value) => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : null;
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function summary(db) {
  const tableNames = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
  const tableCounts = Object.fromEntries(
    tableNames.map((table) => [
      table,
      db.prepare(`SELECT count(*) AS n FROM "${table.replace(/"/g, '""')}"`).get().n,
    ]),
  );
  const count = (table) => tableExists(db, table)
    ? tableCounts[table]
    : 0;
  const orphanChats = tableExists(db, "chats") && tableExists(db, "installed_agents")
    ? db.prepare(
      `SELECT count(*) AS n
       FROM chats c LEFT JOIN installed_agents a ON a.id=c.agent_id
       WHERE a.id IS NULL`,
    ).get().n
    : 0;
  const violations = db.pragma("foreign_key_check");
  const auditRaw = tableExists(db, "meta")
    ? db.prepare("SELECT value FROM meta WHERE key=?").get("migration:v50:orphan-chat-repair")?.value ?? null
    : null;
  return {
    userVersion: db.pragma("user_version", { simple: true }),
    chats: count("chats"),
    agents: count("installed_agents"),
    messages: count("chat_messages"),
    runEvents: count("run_events"),
    orphanChats,
    foreignKeyViolations: violations.length,
    chatAgentViolations: violations.filter((row) => row.table === "chats" && row.parent === "installed_agents").length,
    tableCounts,
    auditRaw,
    audit: auditRaw ? JSON.parse(auditRaw) : null,
  };
}

function seedSyntheticFixture(filePath) {
  const db = new Database(filePath);
  db.pragma("foreign_keys = OFF");
  db.exec(`
    CREATE TABLE installed_agents (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      tagline TEXT NOT NULL,
      system_prompt TEXT NOT NULL DEFAULT '',
      mcp_servers_json TEXT NOT NULL,
      preferred_backend TEXT,
      trust_grade TEXT NOT NULL,
      installed_at TEXT NOT NULL,
      tone TEXT NOT NULL,
      env_requirements_json TEXT NOT NULL DEFAULT '[]',
      name_en TEXT NOT NULL DEFAULT '',
      tagline_en TEXT NOT NULL DEFAULT '',
      builtin INTEGER NOT NULL DEFAULT 0,
      role TEXT,
      visibility TEXT NOT NULL DEFAULT 'visible' CHECK(visibility IN ('visible','background','private')),
      entity_kind TEXT
    );
    CREATE TABLE chats (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      firm_id TEXT,
      archived_at TEXT,
      working_folder TEXT,
      kind TEXT NOT NULL DEFAULT 'user',
      parent_chat_id TEXT,
      used_at TEXT,
      agent_group_id TEXT,
      continuous_mode INTEGER NOT NULL DEFAULT 0,
      swarm_mode INTEGER NOT NULL DEFAULT 0,
      last_viewed_at TEXT,
      hired_agents TEXT,
      FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE
    );
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );
    CREATE TABLE run_events (
      id TEXT PRIMARY KEY,
      chat_id TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const now = "2026-07-10T00:00:00.000Z";
  db.prepare(
    `INSERT INTO installed_agents
      (id,slug,name,tagline,mcp_servers_json,trust_grade,installed_at,tone)
     VALUES ('agent-live','agent-live','Live','Live','[]','A',?,'neutral')`,
  ).run(now);
  const insertChat = db.prepare(
    `INSERT INTO chats
      (id, agent_id, title, created_at, updated_at, kind, used_at, working_folder)
     VALUES (?, ?, ?, ?, ?, 'user', ?, ?)`,
  );
  insertChat.run("chat-empty", "missing-empty", "Generated Team operations", now, now, null, null);
  insertChat.run("chat-message", "missing-preserve", "Message Team operations", now, now, null, null);
  insertChat.run("chat-json-ref", "missing-preserve", "JSON Team operations", now, now, null, null);
  insertChat.run("chat-custom", "missing-custom", "My saved investigation", now, now, null, null);
  insertChat.run("chat-used", "missing-custom", "Used Team operations", now, now, now, null);
  insertChat.run("chat-live", "agent-live", "Live chat", now, now, now, null);
  db.prepare("INSERT INTO chat_messages VALUES (?,?,?,?,?)")
    .run("message-1", "chat-message", "user", "preserve me", now);
  db.prepare("INSERT INTO run_events VALUES (?,?,?)")
    .run("run-1", null, JSON.stringify({ recoveredChat: "chat-json-ref" }));
  db.pragma("user_version = 49");
  db.close();
}

async function backupReadOnly(sourcePath, destinationPath) {
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(destinationPath);
  } finally {
    source.close();
  }
}

function runWorker(fixturePath, userDataPath) {
  const env = {
    ...process.env,
    AGENTLAS_STORE_PATH: fixturePath,
    AGENTLAS_QA_USER_DATA_DIR: userDataPath,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(
    process.execPath,
    [__filename, "--worker", `--fixture=${fixturePath}`, `--user-data=${userDataPath}`],
    { encoding: "utf8", env },
  );
  if (result.status !== 0) {
    throw new Error(`v50 worker failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  const line = result.stdout.split(/\r?\n/).find((value) => value.startsWith("V50_RESULT="));
  if (!line) throw new Error(`v50 worker returned no result\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice("V50_RESULT=".length));
}

async function worker() {
  const { app } = require("electron");
  const fixturePath = argValue("--fixture");
  const userDataPath = argValue("--user-data");
  if (!fixturePath || !userDataPath) throw new Error("worker requires fixture and user-data paths");
  app.setPath("userData", userDataPath);
  await app.whenReady();
  const store = require("../dist/electron/store/db.js");
  store.initStore();
  const result = summary(store.getDb());
  console.log(`V50_RESULT=${JSON.stringify(result)}`);
  store.getDb().close();
  app.quit();
}

async function orchestrate() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-v50-orphan-"));
  const fixturePath = path.join(tempDir, "fixture.sqlite");
  const sourcePath = argValue("--source");
  try {
    let before;
    if (sourcePath) {
      const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
      try {
        before = summary(source);
      } finally {
        source.close();
      }
      await backupReadOnly(sourcePath, fixturePath);
    } else {
      seedSyntheticFixture(fixturePath);
      const seeded = new Database(fixturePath, { readonly: true });
      try {
        before = summary(seeded);
      } finally {
        seeded.close();
      }
    }

    const first = runWorker(fixturePath, path.join(tempDir, "user-data-first"));
    const second = runWorker(fixturePath, path.join(tempDir, "user-data-reboot"));
    assert.equal(first.userVersion, 50);
    assert.equal(first.orphanChats, 0);
    assert.equal(first.chatAgentViolations, 0);
    assert.equal(first.foreignKeyViolations, 0);
    assert.ok(first.audit, "v50 audit record must be present when orphan chats were repaired");
    assert.equal(first.chats, before.chats - first.audit.deleted.length);
    assert.equal(first.agents, before.agents + first.audit.recoveredAgentIds.length);
    assert.equal(first.messages, before.messages, "migration must preserve message count");
    assert.equal(first.runEvents, before.runEvents, "migration must preserve run-event count");
    for (const [table, count] of Object.entries(before.tableCounts)) {
      if (table === "chats" || table === "installed_agents" || table === "meta") continue;
      assert.equal(first.tableCounts[table], count, `v50 must preserve every row in ${table}`);
    }
    if (Object.hasOwn(before.tableCounts, "meta")) {
      assert.equal(
        first.tableCounts.meta,
        before.tableCounts.meta + (before.auditRaw ? 0 : 1),
        "v50 may add only its audit row to meta",
      );
    }
    assert.deepEqual(second, first, "a reboot must not rerun or drift the v50 migration");

    if (!sourcePath) {
      assert.deepEqual(first.audit.deleted.map((item) => item.chatId), ["chat-empty"]);
      assert.deepEqual(
        new Set(first.audit.preserved.map((item) => item.chatId)),
        new Set(["chat-message", "chat-json-ref", "chat-custom", "chat-used"]),
      );
      assert.deepEqual(new Set(first.audit.recoveredAgentIds), new Set(["missing-preserve", "missing-custom"]));
      const verified = new Database(fixturePath, { readonly: true });
      try {
        assert.equal(verified.prepare("SELECT count(*) AS n FROM chats WHERE id='chat-empty'").get().n, 0);
        assert.deepEqual(
          verified.prepare("SELECT visibility, tone, entity_kind FROM installed_agents WHERE id='missing-preserve'").get(),
          { visibility: "private", tone: "blue", entity_kind: "agent" },
          "recovery placeholders must stay private while using valid InstalledAgent discriminants",
        );
        assert.equal(verified.prepare("SELECT text FROM chat_messages WHERE id='message-1'").get().text, "preserve me");
      } finally {
        verified.close();
      }
    }

    console.log(JSON.stringify({ ok: true, source: sourcePath ? "read-only-production-clone" : "synthetic", before, after: first, reboot: second }, null, 2));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.argv.includes("--worker")) {
  worker()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
} else {
  orchestrate()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
