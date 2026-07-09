// 고용(빌림) 채팅 바인딩 스토어 계약 — v48 마이그레이션 + setChatHiredAgents 왕복.
// 실행: npm run test:hired-agents  (build:electron 후 electron으로 실행)
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-hired-agents-"));
  process.env.AGENTLAS_STORE_PATH = path.join(tmp, "agentlas.sqlite");

  await app.whenReady();
  const db = require("../dist/electron/store/db.js");
  const chats = require("../dist/electron/store/chats.js");
  db.initStore();

  // 채팅을 만들려면 오케스트레이터 폴백 에이전트가 필요하다.
  db.getDb()
    .prepare(
      `INSERT INTO installed_agents
       (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json,
        env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin, role, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "agent-orchestrator-test",
      "agentlas-orchestrator",
      "Agentlas Orchestrator",
      "Agentlas Orchestrator",
      "Routes work",
      "Routes work",
      "You coordinate Agentlas work.",
      "[]",
      "[]",
      null,
      "A",
      "2026-07-09T00:00:00.000Z",
      "blue",
      1,
      null,
      "visible",
    );

  // v48 마이그레이션: hired_agents 컬럼 존재
  const columns = db.getDb().prepare("PRAGMA table_info(chats)").all().map((c) => c.name);
  assert.ok(columns.includes("hired_agents"), "chats.hired_agents column must exist (v48)");

  const chat = chats.createChat({ title: "고용 테스트" });
  assert.deepEqual(chat.hiredAgents, [], "new chat starts with no hired agents");

  // 고용: 카드 저장 + 왕복
  const hired = chats.setChatHiredAgents(chat.id, [
    { slug: "instagram-uploader", name: "인스타 업로더", source: "hub", hiredAt: "2026-07-09T01:00:00.000Z" },
    { slug: "research-agent", hiredAt: "2026-07-09T01:00:00.000Z" },
  ]);
  assert.equal(hired.hiredAgents.length, 2);
  assert.equal(hired.hiredAgents[0].slug, "instagram-uploader");
  assert.equal(hired.hiredAgents[0].name, "인스타 업로더");
  assert.equal(hired.hiredAgents[0].source, "hub");

  // getChat 왕복에서도 파싱된다
  const reloaded = chats.getChat(chat.id);
  assert.equal(reloaded.hiredAgents.length, 2, "hired agents survive a reload");

  // 중복 슬러그는 접힌다 + 빈 슬러그는 버린다
  const deduped = chats.setChatHiredAgents(chat.id, [
    { slug: "instagram-uploader", hiredAt: "2026-07-09T01:00:00.000Z" },
    { slug: "instagram-uploader", name: "덮어쓴 이름", hiredAt: "2026-07-09T02:00:00.000Z" },
    { slug: "  ", hiredAt: "2026-07-09T02:00:00.000Z" },
  ]);
  assert.equal(deduped.hiredAgents.length, 1, "duplicate slugs collapse to one card");
  assert.equal(deduped.hiredAgents[0].name, "덮어쓴 이름", "later card wins on dedupe");

  // 해고: 빈 배열 → 컬럼 비움
  const dismissed = chats.setChatHiredAgents(chat.id, []);
  assert.deepEqual(dismissed.hiredAgents, [], "dismiss clears all hired agents");
  const raw = db.getDb().prepare("SELECT hired_agents FROM chats WHERE id = ?").get(chat.id);
  assert.equal(raw.hired_agents, null, "dismiss stores NULL, not '[]'");

  // 깨진 JSON은 빈 배열로 폴백 (렌더러를 죽이지 않는다)
  db.getDb().prepare("UPDATE chats SET hired_agents = ? WHERE id = ?").run("{broken", chat.id);
  assert.deepEqual(chats.getChat(chat.id).hiredAgents, [], "broken JSON falls back to []");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("hired agents store contract ok");
  app.quit();
}

main().catch((err) => {
  console.error(err);
  app.exit(1);
});
