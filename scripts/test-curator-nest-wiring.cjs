// 메모리 큐레이터 → 빌린 에이전트 전역 둥지 배선 계약.
//
// 검증하는 것 (기존 아키텍처 ↔ 새 배선의 접점):
//   1. agent_repo 스코프 배움이 빌린 에이전트의 전역 둥지 soul에 미러링된다
//      (= Hephaestus 대여 엔진 _default_memory_root와 동일 경로 → 다음 대여 때 읽힘).
//   2. 슬러그 정규화가 엔진 _norm_slug와 일치한다 (instagram_uploader → instagram-uploader).
//   3. 프로젝트 격리: project 스코프 배움은 둥지로 새지 않는다 (프로젝트 폴더에만).
//   4. borrowedAgentSlugs가 없으면(설치 에이전트 실행) 둥지에 아무것도 안 쓴다.
//   5. session/discard/시크릿 배움은 둥지로 가지 않는다.
//
// 실행: npm run test:curator-nest-wiring
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

// 둥지는 os.homedir() 기준이라, 실제 홈을 오염시키지 않도록 HOME을 임시 폴더로 격리.
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-nest-home-"));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;

function nestSoulPath(normSlug) {
  return path.join(sandboxHome, ".agentlas", "networking", "hub-agents", normSlug, "memory", "project-soul-memory.md");
}
function readNest(normSlug) {
  try {
    return fs.readFileSync(nestSoulPath(normSlug), "utf8");
  } catch {
    return null;
  }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-nest-wiring-"));
  process.env.AGENTLAS_STORE_PATH = path.join(tmp, "agentlas.sqlite");

  await app.whenReady();
  const db = require("../dist/electron/store/db.js");
  const { curateEvents } = require("../dist/electron/memory/curator.js");
  db.initStore();

  const projectPath = path.join(tmp, "project1");
  fs.mkdirSync(projectPath, { recursive: true });

  const baseCtx = {
    projectPath,
    projectId: "project-1",
    agentId: "agent-orchestrator",
    chatId: "chat-1",
    cwdAtRequest: projectPath,
  };

  const ev = (kind, scope, content) => ({
    memory_kind: kind,
    content,
    suggested_scope: scope,
    confidence: "high",
    sensitivity: "normal",
  });

  // ── 1+2: agent_repo 배움 → 둥지 미러링 + 슬러그 정규화 ────────────────────
  curateEvents(
    [
      ev("procedure", "agent_repo", "인스타 게시 버튼은 오버플로 메뉴 아래에 있다."),
      ev("risk", "agent_repo", "게시 직후 3초 내 재클릭하면 중복 게시된다."),
    ],
    { ...baseCtx, borrowedAgentSlugs: ["instagram_uploader"] }, // 밑줄 슬러그 → 하이픈 정규화 검증
  );
  const nest = readNest("instagram-uploader");
  assert.ok(nest, "agent_repo learnings must create the borrowed agent's nest at the engine-normalized path");
  assert.match(nest, /오버플로 메뉴 아래/, "procedure learning must reach the nest");
  assert.match(nest, /중복 게시/, "risk learning must reach the nest");
  assert.equal(readNest("instagram_uploader"), null, "underscore slug must NOT create a separate nest (engine normalizes to hyphen)");

  // ── 3: 프로젝트 격리 — project 스코프는 둥지로 새지 않는다 ──────────────────
  curateEvents(
    [ev("decision", "project", "이 프로젝트는 매주 화요일에 배포한다.")],
    { ...baseCtx, borrowedAgentSlugs: ["instagram_uploader"] },
  );
  const nestAfterProject = readNest("instagram-uploader");
  assert.doesNotMatch(nestAfterProject, /화요일에 배포/, "project-scoped learning must stay in the project, never leak to the agent nest");
  // 프로젝트 soul에는 들어갔어야 한다.
  const projectSoul = fs.readFileSync(path.join(projectPath, ".agentlas", "project-soul-memory.md"), "utf8");
  assert.match(projectSoul, /화요일에 배포/, "project-scoped learning must land in the project soul");

  // ── 4: borrowedAgentSlugs 없음(설치 에이전트) → 둥지 안 씀 ─────────────────
  const before = readNest("solo-agent");
  curateEvents(
    [ev("procedure", "agent_repo", "이건 어느 둥지로도 가면 안 된다.")],
    { ...baseCtx }, // borrowedAgentSlugs 없음
  );
  assert.equal(readNest("solo-agent"), before, "no borrowed slugs → no nest writes");
  // 어떤 둥지에도 이 문장이 없어야
  const hubAgentsDir = path.join(sandboxHome, ".agentlas", "networking", "hub-agents");
  if (fs.existsSync(hubAgentsDir)) {
    for (const slug of fs.readdirSync(hubAgentsDir)) {
      const content = readNest(slug) || "";
      assert.doesNotMatch(content, /어느 둥지로도 가면 안 된다/, `agent_repo without borrowed slugs must not write to any nest (${slug})`);
    }
  }

  // ── 5: session/시크릿은 둥지로 안 간다 ────────────────────────────────────
  curateEvents(
    [
      ev("fact", "session", "임시 사실 — 둥지 금지."),
      ev("procedure", "agent_repo", "API_KEY=sk-secret1234567890abcdef 이런 건 저장 금지."),
    ],
    { ...baseCtx, borrowedAgentSlugs: ["instagram_uploader"] },
  );
  const finalNest = readNest("instagram-uploader");
  assert.doesNotMatch(finalNest, /임시 사실/, "session-scoped learning must not reach the nest");
  assert.doesNotMatch(finalNest, /sk-secret1234567890/, "secret-bearing learning must be redacted, never in the nest");

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(sandboxHome, { recursive: true, force: true });
  console.log("curator → agent nest wiring contract ok");
  app.quit();
}

main().catch((err) => {
  console.error(err);
  app.exit(1);
});
