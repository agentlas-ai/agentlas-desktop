#!/usr/bin/env node
// v71/v72 Task 정본화 마이그레이션 검증 (릴리스 A: 가산적·무손실).
//   - v71: 최상위 user chat 1개당 durable Task 1개 (division은 Task 아님).
//   - v72: 각 chat의 루트 Task에 참여 에이전트 기록. 재귀 부모 해석(2단 중첩),
//          고아 division은 Task 없음, hired_agents 병합, agent_slug NOT NULL.
//   - 가산성: chats/chat_messages 행수 불변, FK 위반 0, 재부팅 시 드리프트 0.
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
    tableNames.map((table) => [table, db.prepare(`SELECT count(*) AS n FROM "${table.replace(/"/g, '""')}"`).get().n]),
  );
  const tasks = tableExists(db, "tasks")
    ? db.prepare("SELECT id, title, project_id, firm_id, status, origin_chat_id FROM tasks ORDER BY id").all()
    : [];
  const participants = tableExists(db, "task_agent_participants")
    ? db
        .prepare("SELECT task_id, agent_id, agent_slug, role FROM task_agent_participants ORDER BY task_id, agent_slug")
        .all()
    : [];
  const nullSlugCount = tableExists(db, "task_agent_participants")
    ? db.prepare("SELECT count(*) AS n FROM task_agent_participants WHERE agent_slug IS NULL").get().n
    : 0;
  return {
    userVersion: db.pragma("user_version", { simple: true }),
    chats: tableCounts.chats ?? 0,
    messages: tableCounts.chat_messages ?? 0,
    tasks,
    participants,
    nullSlugCount,
    foreignKeyViolations: db.pragma("foreign_key_check").length,
    tableCounts,
  };
}

function seedSyntheticFixture(filePath) {
  const db = new Database(filePath);
  db.pragma("foreign_keys = OFF");
  db.exec(`
    CREATE TABLE installed_agents (
      id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, tagline TEXT NOT NULL,
      system_prompt TEXT NOT NULL DEFAULT '', mcp_servers_json TEXT NOT NULL, preferred_backend TEXT,
      trust_grade TEXT NOT NULL, installed_at TEXT NOT NULL, tone TEXT NOT NULL,
      env_requirements_json TEXT NOT NULL DEFAULT '[]', name_en TEXT NOT NULL DEFAULT '',
      tagline_en TEXT NOT NULL DEFAULT '', builtin INTEGER NOT NULL DEFAULT 0, role TEXT,
      visibility TEXT NOT NULL DEFAULT 'visible', entity_kind TEXT
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, default_agent_id TEXT,
      context_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(default_agent_id) REFERENCES installed_agents(id) ON DELETE SET NULL
    );
    CREATE TABLE firms (
      id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, name_en TEXT NOT NULL DEFAULT '',
      tagline TEXT NOT NULL, tagline_en TEXT NOT NULL DEFAULT '', persona TEXT NOT NULL,
      ceo_agent_id TEXT NOT NULL, org_chart_json TEXT NOT NULL, installed_at TEXT NOT NULL,
      FOREIGN KEY(ceo_agent_id) REFERENCES installed_agents(id) ON DELETE RESTRICT
    );
    CREATE TABLE chats (
      id TEXT PRIMARY KEY, project_id TEXT, agent_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, firm_id TEXT, archived_at TEXT,
      working_folder TEXT, kind TEXT NOT NULL DEFAULT 'user', parent_chat_id TEXT, used_at TEXT,
      agent_group_id TEXT, continuous_mode INTEGER NOT NULL DEFAULT 0, swarm_mode INTEGER NOT NULL DEFAULT 0,
      last_viewed_at TEXT, hired_agents TEXT,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL,
      FOREIGN KEY(firm_id) REFERENCES firms(id) ON DELETE SET NULL,
      FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE
    );
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
      created_at TEXT NOT NULL, FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );
  `);
  const now = "2026-07-10T00:00:00.000Z";
  const insAgent = db.prepare(
    `INSERT INTO installed_agents (id,slug,name,tagline,mcp_servers_json,trust_grade,installed_at,tone)
     VALUES (?,?,?,?,'[]','A',?,'neutral')`,
  );
  insAgent.run("agent-a", "alpha", "Alpha", "A", now);
  insAgent.run("agent-b", "beta", "Beta", "B", now);
  insAgent.run("ceo-agent", "ceo", "Ceo", "C", now);
  db.prepare("INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)").run("proj-1", "Proj", now, now);
  db.prepare(
    `INSERT INTO firms (id,slug,name,tagline,persona,ceo_agent_id,org_chart_json,installed_at)
     VALUES ('firm-1','firm-1','Firm','T','P','ceo-agent','{}',?)`,
  ).run(now);

  const insChat = db.prepare(
    `INSERT INTO chats (id, project_id, agent_id, title, created_at, updated_at, firm_id, archived_at, kind, parent_chat_id, hired_agents)
     VALUES (@id, @project_id, @agent_id, @title, @created_at, @updated_at, @firm_id, @archived_at, @kind, @parent_chat_id, @hired_agents)`,
  );
  const base = { project_id: null, firm_id: null, archived_at: null, parent_chat_id: null, hired_agents: null, created_at: now, updated_at: now };
  // 2 top-level user chats → 2 tasks
  insChat.run({ ...base, id: "chat-user1", agent_id: "agent-a", title: "Research task", kind: "user", project_id: "proj-1", hired_agents: JSON.stringify([{ slug: "hub-x", name: "Hub X" }]) });
  insChat.run({ ...base, id: "chat-user2", agent_id: "agent-b", title: "Archived work", kind: "user", firm_id: "firm-1", archived_at: now });
  // division children of chat-user1 (1-level)
  insChat.run({ ...base, id: "chat-div1", agent_id: "agent-a", title: "⟦div⟧d1", kind: "division", parent_chat_id: "chat-user1" });
  insChat.run({ ...base, id: "chat-firm1", agent_id: "ceo-agent", title: "⟦firm⟧firm-1", kind: "division", parent_chat_id: "chat-user1" });
  // 2-level nested division under chat-firm1 → still resolves to chat-user1's task (recursion)
  insChat.run({ ...base, id: "chat-div-nested", agent_id: "agent-b", title: "⟦div⟧nested", kind: "division", parent_chat_id: "chat-firm1" });
  // parentless divisions (site/automation) → NO task
  insChat.run({ ...base, id: "chat-site", agent_id: "agent-a", title: "⟦site⟧proj-1", kind: "division" });
  insChat.run({ ...base, id: "chat-automation", agent_id: "agent-b", title: "⟦automation⟧a1", kind: "division" });

  db.prepare("INSERT INTO chat_messages VALUES (?,?,?,?,?)").run("m1", "chat-user1", "user", "hello", now);
  db.prepare("INSERT INTO chat_messages VALUES (?,?,?,?,?)").run("m2", "chat-div1", "assistant", "work", now);

  db.pragma("user_version = 70");
  db.close();
}

function runWorker(fixturePath, userDataPath) {
  const env = { ...process.env, AGENTLAS_STORE_PATH: fixturePath, AGENTLAS_QA_USER_DATA_DIR: userDataPath };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(
    process.execPath,
    [__filename, "--worker", `--fixture=${fixturePath}`, `--user-data=${userDataPath}`],
    { encoding: "utf8", env },
  );
  if (result.status !== 0) {
    throw new Error(`v71/v72 worker failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  const line = result.stdout.split(/\r?\n/).find((value) => value.startsWith("V71_RESULT="));
  if (!line) throw new Error(`worker returned no result\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice("V71_RESULT=".length));
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
  console.log(`V71_RESULT=${JSON.stringify(result)}`);
  store.getDb().close();
  app.quit();
}

async function orchestrate() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-v71-task-"));
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
      const src = new Database(sourcePath, { readonly: true, fileMustExist: true });
      try {
        await src.backup(fixturePath);
      } finally {
        src.close();
      }
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

    // 공통 불변식 (합성/실DB 공통)
    assert.ok(first.userVersion >= 72, "must reach schema v72");
    assert.equal(first.foreignKeyViolations, 0, "no FK violations after migration");
    assert.equal(first.nullSlugCount, 0, "agent_slug must never be NULL");
    assert.equal(first.chats, before.chats, "additive: chats count unchanged");
    assert.equal(first.messages, before.messages, "additive: chat_messages count unchanged");
    // 릴리스 A는 기존 테이블을 재건축하지 않는다 → 신규 2개 외 모든 테이블 행수 보존
    for (const [table, count] of Object.entries(before.tableCounts)) {
      assert.equal(first.tableCounts[table], count, `additive migration must preserve every row in ${table}`);
    }
    assert.deepEqual(second, first, "reboot must not rerun or drift the migration");

    if (!sourcePath) {
      // 합성 픽스처 상세 검증
      assert.equal(first.tasks.length, 2, "one task per top-level user chat");
      const byOrigin = Object.fromEntries(first.tasks.map((t) => [t.origin_chat_id, t]));
      assert.ok(byOrigin["chat-user1"] && byOrigin["chat-user2"], "tasks originate from the two user chats");
      assert.equal(byOrigin["chat-user1"].project_id, "proj-1", "task carries project_id");
      assert.equal(byOrigin["chat-user1"].status, "open");
      assert.equal(byOrigin["chat-user1"].title, "Research task");
      assert.equal(byOrigin["chat-user2"].firm_id, "firm-1", "task carries firm_id");
      assert.equal(byOrigin["chat-user2"].status, "archived", "archived chat → archived task");

      const t1 = byOrigin["chat-user1"].id;
      const t2 = byOrigin["chat-user2"].id;
      const slugsFor = (taskId) =>
        new Set(first.participants.filter((p) => p.task_id === taskId).map((p) => p.agent_slug));
      // chat-user1 task: agent-a(alpha) from user + div1, ceo(ceo) from firm1, agent-b(beta) from nested div, hub-x from hired
      assert.deepEqual(slugsFor(t1), new Set(["alpha", "ceo", "beta", "hub-x"]), "recursive parent walk + hired merge");
      // chat-user2 task: agent-b(beta) only
      assert.deepEqual(slugsFor(t2), new Set(["beta"]), "user2 task has only its own agent");
      // hired participant has role 'hired' and null agent_id
      const hired = first.participants.find((p) => p.task_id === t1 && p.agent_slug === "hub-x");
      assert.equal(hired.role, "hired");
      assert.equal(hired.agent_id, null, "hired-by-slug participant has no resolved agent_id");
      // 고아 division(chat-site/chat-automation)은 어떤 Task에도 참여로 남지 않는다 (총 참여 = 5)
      assert.equal(first.participants.length, 5, "orphan divisions contribute no participants");
    }

    console.log(JSON.stringify({ ok: true, source: sourcePath ? "read-only-production-clone" : "synthetic", before: { chats: before.chats, messages: before.messages }, after: first, reboot: { userVersion: second.userVersion } }, null, 2));
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
