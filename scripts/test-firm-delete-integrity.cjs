#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const Database = require("better-sqlite3");
const { app } = require("electron");

// This store test never reads secrets. Stub keytar so the test remains
// architecture-independent when a checkout contains a native module built for
// the other macOS architecture.
const originalLoad = Module._load;
Module._load = function loadWithKeytarStub(request, parent, isMain) {
  if (request === "keytar") {
    return {
      getPassword: async () => null,
      setPassword: async () => undefined,
      deletePassword: async () => true,
      findCredentials: async () => [],
    };
  }
  if (request === "../main" && parent?.filename.includes(`${path.sep}dist${path.sep}electron${path.sep}`)) {
    return { currentUiLocale: () => "en" };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-firm-delete-"));
const externalStorePath = process.env.AGENTLAS_FIRM_TEST_EXISTING_STORE;
const storePath = externalStorePath || path.join(tempDir, "agentlas-v48.sqlite");
process.env.AGENTLAS_STORE_PATH = storePath;
app.setPath("userData", path.join(tempDir, "user-data"));

function storeCounts(db) {
  return {
    firms: db.prepare("SELECT COUNT(*) AS n FROM firms").get().n,
    chats: db.prepare("SELECT COUNT(*) AS n FROM chats").get().n,
    messages: db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get().n,
  };
}

function seedV48Store() {
  const db = new Database(storePath);
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE installed_agents (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      name_en TEXT NOT NULL DEFAULT '',
      tagline TEXT NOT NULL,
      tagline_en TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      mcp_servers_json TEXT NOT NULL DEFAULT '[]',
      env_requirements_json TEXT NOT NULL DEFAULT '[]',
      preferred_backend TEXT,
      trust_grade TEXT NOT NULL,
      installed_at TEXT NOT NULL,
      tone TEXT NOT NULL,
      builtin INTEGER NOT NULL DEFAULT 0,
      role TEXT,
      visibility TEXT NOT NULL DEFAULT 'visible',
      entity_kind TEXT
    );

    CREATE TABLE firms (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      name_en TEXT NOT NULL DEFAULT '',
      tagline TEXT NOT NULL,
      tagline_en TEXT NOT NULL DEFAULT '',
      persona TEXT NOT NULL,
      ceo_agent_id TEXT NOT NULL,
      org_chart_json TEXT NOT NULL,
      installed_at TEXT NOT NULL,
      FOREIGN KEY(ceo_agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_firms_installed ON firms(installed_at DESC);

    CREATE TABLE chats (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      firm_id TEXT REFERENCES firms(id) ON DELETE SET NULL,
      agent_group_id TEXT,
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      archived_at TEXT,
      working_folder TEXT,
      kind TEXT NOT NULL DEFAULT 'user',
      parent_chat_id TEXT,
      used_at TEXT,
      continuous_mode INTEGER NOT NULL DEFAULT 0,
      swarm_mode INTEGER NOT NULL DEFAULT 0,
      hired_agents TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
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

    CREATE TABLE agent_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      orchestrator_name TEXT NOT NULL,
      members_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- These append-only ledgers already existed in a real v48 database. The
    -- migration fixture keeps only the columns consumed by later additive
    -- indexes so it remains representative as the canonical schema advances.
    CREATE TABLE run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      agent_id TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(run_id, seq)
    );
    CREATE TABLE failure_events (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      source TEXT NOT NULL,
      agent_id TEXT,
      error_message TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}'
    );
  `);

  const insertAgent = db.prepare(`
    INSERT INTO installed_agents
      (id, slug, name, name_en, tagline, tagline_en, trust_grade, installed_at, tone, entity_kind)
    VALUES (?, ?, ?, ?, ?, ?, 'A', ?, 'blue', ?)
  `);
  const now = "2026-07-10T00:00:00.000Z";
  insertAgent.run("ceo-agent", "ceo-agent", "CEO", "CEO", "Firm CEO", "Firm CEO", now, "team");
  insertAgent.run("member-agent", "member-agent", "Member", "Member", "Firm member", "Firm member", now, "agent");

  const orgChart = JSON.stringify([
    { agentSlug: "ceo-agent", agentId: "ceo-agent", role: "CEO", reportsTo: null },
    { agentSlug: "member-agent", agentId: "member-agent", role: "Research", reportsTo: "ceo-agent" },
  ]);
  db.prepare(`
    INSERT INTO firms
      (id, slug, name, name_en, tagline, tagline_en, persona, ceo_agent_id, org_chart_json, installed_at)
    VALUES ('firm-1', 'firm-1', 'Proof Firm', 'Proof Firm', 'Proof', 'Proof', '', 'ceo-agent', ?, ?)
  `).run(orgChart, now);

  const insertChat = db.prepare(`
    INSERT INTO chats
      (id, firm_id, agent_id, title, kind, used_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'user', ?, ?, ?)
  `);
  insertChat.run("firm-chat", "firm-1", "ceo-agent", "Firm conversation", now, now, now);
  insertChat.run("direct-chat", null, "member-agent", "Direct conversation", now, now, now);
  db.prepare(`
    INSERT INTO chat_messages (id, chat_id, role, text, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run("firm-message", "firm-chat", "user", "Keep the firm conversation", now);
  db.prepare(`
    INSERT INTO chat_messages (id, chat_id, role, text, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run("direct-message", "direct-chat", "assistant", "Keep the direct conversation", now);

  // Prove the audited v48 failure mode before migration: uninstallAgent was a
  // raw installed_agents DELETE, so deleting a firm member cascaded through its
  // 1:1 chat and messages. Roll it back so the same data can exercise v49.
  db.exec("SAVEPOINT reproduce_pg1");
  db.prepare("DELETE FROM installed_agents WHERE id = ?").run("member-agent");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chats WHERE id = 'direct-chat'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE id = 'direct-message'").get().n, 0);
  db.exec("ROLLBACK TO reproduce_pg1; RELEASE reproduce_pg1");

  // The CEO FK used the same CASCADE action, reproducing PG-2's entire-firm
  // disappearance when team:uninstall targeted the CEO.
  db.exec("SAVEPOINT reproduce_pg2");
  db.prepare("DELETE FROM installed_agents WHERE id = ?").run("ceo-agent");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM firms WHERE id = 'firm-1'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chats WHERE id = 'firm-chat'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE id = 'firm-message'").get().n, 0);
  db.exec("ROLLBACK TO reproduce_pg2; RELEASE reproduce_pg2");

  db.pragma("user_version = 48");
  db.close();
}

async function main() {
  let exitCode = 0;
  try {
    let existingCounts = null;
    let existingViolations = null;
    if (externalStorePath) {
      const existing = new Database(storePath, { readonly: true });
      assert.equal(existing.pragma("user_version", { simple: true }), 48, "existing-store proof expects v48");
      existingCounts = storeCounts(existing);
      existingViolations = existing.pragma("foreign_key_check");
      existing.close();
    } else {
      seedV48Store();
    }
    await app.whenReady();

    const store = require("../dist/electron/store/db.js");
    const firms = require("../dist/electron/store/firms.js");
    const registry = require("../dist/electron/mcp/registry.js");
    store.initStore();
    const db = store.getDb();

    assert.equal(db.pragma("user_version", { simple: true }), 64, "v48 store must migrate through the current canonical schema v64");
    const ceoFk = db
      .prepare("PRAGMA foreign_key_list(firms)")
      .all()
      .find((row) => row.from === "ceo_agent_id");
    assert.equal(ceoFk?.on_delete, "RESTRICT", "CEO deletion must not cascade through the firm graph");

    if (existingCounts) {
      const auditRow = db.prepare("SELECT value FROM meta WHERE key = ?").get("migration:v50:orphan-chat-repair");
      const audit = auditRow?.value ? JSON.parse(auditRow.value) : { deleted: [] };
      assert.deepEqual(
        storeCounts(db),
        { ...existingCounts, chats: existingCounts.chats - audit.deleted.length },
        "v49 must preserve firm/messages while v50 may remove only audited empty orphan chats",
      );
      assert.deepEqual(
        db.pragma("foreign_key_check"),
        existingViolations.filter((row) => !(row.table === "chats" && row.parent === "installed_agents")),
        "v50 must repair chat-agent violations without hiding unrelated pre-existing FK violations",
      );
      console.log(
        JSON.stringify({
          ok: true,
          migratedExistingStore: existingCounts,
          preservedExistingFkViolations: existingViolations.filter((row) => !(row.table === "chats" && row.parent === "installed_agents")).length,
          v50DeletedEmptyOrphans: audit.deleted.length,
          ceoDelete: "RESTRICT",
        }),
      );
      return;
    }

    assert.throws(
      () => registry.uninstallAgent("ceo-agent"),
      /installed firm/i,
      "team:uninstall must reject deleting a CEO out from under its firm",
    );
    assert.throws(
      () => db.prepare("DELETE FROM installed_agents WHERE id = ?").run("ceo-agent"),
      /FOREIGN KEY constraint failed/,
      "the database must reject a raw CEO delete while its firm exists",
    );
    assert.throws(
      () => registry.uninstallAgent("member-agent"),
      /installed firm/i,
      "the product API must reject deleting a member out from under its firm",
    );

    // Defense in depth: if a future trigger/schema drift tries to reintroduce
    // member cleanup during firm removal, the count invariant must roll the
    // entire operation back instead of accepting partial data loss.
    db.exec(`
      CREATE TRIGGER test_firm_delete_drift
      AFTER DELETE ON firms
      BEGIN
        DELETE FROM installed_agents WHERE id = 'member-agent';
      END;
    `);
    assert.throws(() => firms.uninstallFirm("firm-1"), /rolled back/i);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM firms WHERE id = 'firm-1'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chats").get().n, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get().n, 2);
    db.exec("DROP TRIGGER test_firm_delete_drift");

    firms.uninstallFirm("firm-1");

    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM firms").get().n, 0, "firm relation must be removed");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM installed_agents").get().n,
      2,
      "removing a firm must keep all installed member agents",
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chats").get().n, 2, "all user chats must survive");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get().n, 2, "all messages must survive");
    assert.equal(
      db.prepare("SELECT firm_id FROM chats WHERE id = 'firm-chat'").get().firm_id,
      null,
      "former firm chats must become standalone chats",
    );
    assert.equal(
      db.prepare("SELECT text FROM chat_messages WHERE id = 'direct-message'").get().text,
      "Keep the direct conversation",
      "the member's direct 1:1 history must remain byte-for-byte intact",
    );
    assert.deepEqual(db.pragma("foreign_key_check"), [], "migration and deletion must leave no FK damage");

    console.log("firm deletion integrity contract ok");
  } catch (err) {
    exitCode = 1;
    console.error(err);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    app.quit();
    process.exit(exitCode);
  }
}

main();
