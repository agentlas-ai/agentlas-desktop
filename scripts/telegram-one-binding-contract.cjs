#!/usr/bin/env node
// One은 텔레그램의 단일 창구다. 이 게이트가 잠그는 것:
//  1) target_kind 드리프트 0 — 타입 union ≡ v94 CHECK ≡ 실제 테이블
//  2) One 바인딩은 **방마다 하나** — 같은 방에 둘은 불가, 다른 방/대기 중은 여럿 가능(v101)
//  3) One 바인딩은 절대 고아가 되지 않는다(설치 에이전트가 0개여도 prune 대상 아님)
//  4) One 대화는 origin_surface='one' + agentlas-one 이고, /new 뒤에도 지정 프로젝트를 되건다
//  5) v93 → v94 업그레이드가 레거시 행의 토큰 표식을 보존한다
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-telegram-one-"));
process.env.AGENTLAS_STORE_PATH = path.join(tempDir, "agentlas.sqlite");
process.env.AGENTLAS_E2E = "1";
app.setPath("userData", path.join(tempDir, "user-data"));

const ONE_SLUG = "agentlas-one";

function seedOneAgent(db) {
  db.prepare(
    `INSERT OR IGNORE INTO installed_agents
     (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json,
      env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin, role, visibility)
     VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', NULL, 'A', ?, 'blue', 1, NULL, 'background')`,
  ).run(
    "builtin-agentlas-one",
    ONE_SLUG,
    "One",
    "One",
    "Personal agent",
    "Personal agent",
    "One",
    new Date().toISOString(),
  );
}

function seedProject(db, id, folderPath) {
  const now = new Date().toISOString();
  const columns = db.prepare("PRAGMA table_info(projects)").all().map((c) => c.name);
  const values = {
    id,
    name: "Telegram One Project",
    description: "",
    system_prompt: "",
    agent_pool_json: "[]",
    source_type: "local",
    source_ref: null,
    folder_path: folderPath,
    created_at: now,
    updated_at: now,
  };
  const used = columns.filter((c) => c in values);
  db.prepare(
    `INSERT INTO projects (${used.join(", ")}) VALUES (${used.map(() => "?").join(", ")})`,
  ).run(...used.map((c) => values[c]));
}

let checks = 0;
function check(label, fn) {
  fn();
  checks += 1;
  console.log(`  ok  ${label}`);
}

async function main() {
  let exitCode = 0;
  try {
    await app.whenReady();
    const store = require("../dist/electron/store/db.js");
    store.initStore();
    const db = store.getDb();
    seedOneAgent(db);

    const connect = require("../dist/electron/telegram/connect.js");
    const chats = require("../dist/electron/store/chats.js");

    check("schema reached v94 and telegram_bindings carries the new columns", () => {
      const userVersion = db.pragma("user_version", { simple: true });
      assert.ok(userVersion >= 94, `user_version should be >= 94, got ${userVersion}`);
      const columns = db.prepare("PRAGMA table_info(telegram_bindings)").all().map((c) => c.name);
      for (const column of ["designated_project_id", "designated_graph_id", "legacy_notice_at"]) {
        assert.ok(columns.includes(column), `missing column: ${column}`);
      }
    });

    check("target_kind union ≡ CHECK constraint ≡ live table (no drift)", () => {
      const sql = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'telegram_bindings'")
        .get().sql;
      const match = /CHECK\(target_kind IN \(([^)]+)\)\)/.exec(sql);
      assert.ok(match, "target_kind CHECK constraint is missing");
      const allowed = match[1].split(",").map((s) => s.trim().replace(/'/g, "")).sort();
      const typeSource = fs.readFileSync(path.join(__dirname, "..", "shared/types.ts"), "utf8");
      const unionMatch = /export type TelegramConnectTargetKind =([^;]+);/.exec(typeSource);
      assert.ok(unionMatch, "TelegramConnectTargetKind union not found");
      const union = unionMatch[1]
        .split("|")
        .map((s) => s.trim().replace(/"/g, ""))
        .filter(Boolean)
        .sort();
      assert.deepEqual(allowed, union, "DB CHECK and the TypeScript union drifted apart");
      assert.deepEqual(allowed, ["agent", "firm", "one"]);
    });

    const now = new Date().toISOString();
    const insertOne = (id, chatId = null) =>
      db
        .prepare(
          `INSERT INTO telegram_bindings
           (id, target_kind, target_id, telegram_chat_id, status, enabled, last_update_id, created_at, updated_at,
            automation_report_enabled, token_saved)
           VALUES (?, 'one', 'one', ?, 'chat_paired', 1, 0, ?, ?, 0, 0)`,
        )
        .run(id, chatId, now, now);

    // v101: 단일성은 **방** 단위다. 예전 전역 싱글턴은 "One 이 둘"과 "One 이 여러 방에"
    // 두 가지를 함께 금지해, 봇을 하나 더 붙이는 길 자체가 없었다(대화가 영원히 하나).
    check("One binding is one-per-room — same room rejected, other rooms allowed", () => {
      insertOne("one-binding-1", "room-a");
      assert.throws(() => insertOne("one-binding-dup", "room-a"), /UNIQUE/i, "같은 방에 One 포트 둘은 거절되어야 한다");
      insertOne("one-binding-2", "room-b");
      insertOne("one-binding-waiting", null);
      insertOne("one-binding-waiting-2", null);
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM telegram_bindings WHERE target_kind = 'one'").get().n,
        4,
        "다른 방과 방 대기 중인 봇은 공존해야 한다 — 그래야 텔레그램에서 세션이 여러 개 열린다",
      );
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='telegram_bindings'")
        .all()
        .map((r) => r.name);
      assert.ok(!indexes.includes("idx_telegram_bindings_one_singleton"), "전역 싱글턴 인덱스는 사라져야 한다");
      assert.ok(indexes.includes("idx_telegram_bindings_one_room"), "방 단위 유니크 인덱스가 있어야 한다");
    });

    check("a One binding is never orphaned or pruned, even with no installed agents", async () => {
      const listed = connect.listTelegramBindings();
      const one = listed.find((b) => b.targetKind === "one");
      assert.ok(one, "One binding should be listed");
      assert.equal(one.targetMissing, false, "One must never report a missing target");
      assert.ok(one.targetName && one.targetName !== "one", "One should resolve to its display name");
    });

    const pruned = await connect.pruneOrphanedTelegramBindings();
    check("pruneOrphans leaves every One binding alone", () => {
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM telegram_bindings WHERE target_kind = 'one'").get().n,
        4,
        `pruneOrphans removed a One binding (removed=${pruned.removed})`,
      );
    });

    // /project 지정이 /new 뒤에도 살아남는지 — 실제 실행 폴더가 걸리는 지점이다.
    const projectFolder = path.join(tempDir, "one-project");
    fs.mkdirSync(projectFolder, { recursive: true });
    seedProject(db, "one-project-1", projectFolder);
    connect.setTelegramDesignatedProject("one-binding-1", "one-project-1");

    const row = () => db.prepare("SELECT * FROM telegram_bindings WHERE id = 'one-binding-1'").get();

    const chatIdBefore = await connect.ensureTelegramBindingChatId('one-binding-1');
    check("the One conversation is a One-surface chat owned by agentlas-one", () => {
      const chatRow = db.prepare("SELECT origin_surface, agent_id FROM chats WHERE id = ?").get(chatIdBefore);
      assert.equal(chatRow.origin_surface, "one", "Telegram One chat must be a One-surface conversation");
      const agentSlug = db
        .prepare("SELECT slug FROM installed_agents WHERE id = ?")
        .get(chatRow.agent_id)?.slug;
      assert.equal(agentSlug, ONE_SLUG, "the One conversation must be owned by agentlas-one");
      assert.equal(chats.getChatWorkingFolder(chatIdBefore), projectFolder);
    });

    await connect.resetTelegramConversation("one-binding-1");
    const chatIdAfter = await connect.ensureTelegramBindingChatId('one-binding-1');
    check("/new keeps the designated project folder (it must be re-applied)", () => {
      assert.notEqual(chatIdAfter, chatIdBefore, "reset should start a fresh conversation");
      assert.equal(
        chats.getChatWorkingFolder(chatIdAfter),
        projectFolder,
        "the designated project must be re-applied after /new",
      );
      assert.equal(row().designated_project_id, "one-project-1");
    });

    check("legacy agent/firm rows are still expressible and are not 'one'", () => {
      db.prepare(
        `INSERT INTO telegram_bindings
         (id, target_kind, target_id, status, enabled, last_update_id, created_at, updated_at,
          automation_report_enabled, token_saved, token_fingerprint)
         VALUES ('legacy-1', 'agent', 'gone-agent', 'chat_paired', 1, 0, ?, ?, 0, 1, 'fp-1')`,
      ).run(now, now);
      const legacy = connect.listTelegramBindings().filter((b) => b.targetKind !== "one");
      assert.equal(legacy.length, 1);
      assert.equal(legacy[0].targetMissing, true, "a deleted agent target must still report missing");
      assert.equal(
        db.prepare("SELECT token_fingerprint FROM telegram_bindings WHERE id = 'legacy-1'").get().token_fingerprint,
        "fp-1",
        "legacy token bookkeeping must survive",
      );
    });

    console.log(`\ntelegram One binding: ${checks} checks passed`);
  } catch (error) {
    exitCode = 1;
    console.error(error);
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    app.exit(exitCode);
  }
}

void main();
