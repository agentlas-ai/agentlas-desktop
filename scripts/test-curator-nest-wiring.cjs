// 메모리 큐레이터 → 빌린 에이전트 전역 둥지 배선 계약.
//
// 검증하는 것 (기존 아키텍처 ↔ 새 배선의 접점):
//   1. agent_repo 스코프 배움이 빌린 에이전트의 전역 experience.sqlite에 미러링된다
//      (= Hephaestus ontology query가 다음 대여 때 벡터 검색하는 canonical schema).
//   2. 슬러그 정규화가 엔진 _norm_slug와 일치한다 (instagram_uploader → instagram-uploader).
//   3. 프로젝트 격리: project 스코프 배움은 둥지로 새지 않는다 (프로젝트 폴더에만).
//   4. borrowedAgentSlugs가 없으면(설치 에이전트 실행) 둥지에 아무것도 안 쓴다.
//   5. session/discard/시크릿 배움은 DB·프로젝트 soul·둥지 어디에도 가지 않는다.
//      OpenAI sk-proj-/Anthropic sk-ant-의 base64url(-/_) 토큰 형태를 포함한다.
//   6. 짧은 키 접두사 설명은 시크릿으로 오탐하지 않는다.
//
// 실행: npm run test:curator-nest-wiring
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { app } = require("electron");

// 둥지는 os.homedir() 기준이라, 실제 홈을 오염시키지 않도록 HOME을 임시 폴더로 격리.
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-nest-home-"));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;

function nestDbPath(normSlug) {
  const ownersRoot = path.join(sandboxHome, ".agentlas", "networking", "hub-agents", normSlug, "owners");
  if (!fs.existsSync(ownersRoot)) return path.join(ownersRoot, "__missing__", "memory", "experience.sqlite");
  const ownerDirs = fs.readdirSync(ownersRoot).filter((entry) => /^owner-[0-9a-f]{64}$/.test(entry));
  assert.ok(ownerDirs.length <= 1, "one active owner partition expected in this isolated test");
  return path.join(ownersRoot, ownerDirs[0] ?? "__missing__", "memory", "experience.sqlite");
}
function readNest(normSlug) {
  const target = nestDbPath(normSlug);
  if (!fs.existsSync(target)) return null;
  const db = new Database(target, { readonly: true });
  try {
    return db.prepare("SELECT candidate_text FROM memory_candidates ORDER BY created_at, ticket_id")
      .all().map((row) => row.candidate_text).join("\n");
  } finally {
    db.close();
  }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-nest-wiring-"));
  process.env.AGENTLAS_STORE_PATH = path.join(tmp, "agentlas.sqlite");

  await app.whenReady();
  const db = require("../dist/electron/store/db.js");
  const { curateEvents } = require("../dist/electron/memory/curator.js");
  const {
    agentNestExperienceOwnership,
    findAgentNestExperienceSlugs,
    reconcileAgentNestExperienceConsolidation,
  } = require("../dist/electron/memory/project-files.js");
  const { strictestMemorySensitivity } = require("../dist/electron/memory/dreaming.js");
  const {
    autoLocalEmbedding,
    MODEL2VEC_HYBRID_DIMENSIONS,
    MODEL2VEC_HYBRID_NAME,
  } = require("../dist/electron/memory/local-embedding.js");
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
    sensitivity: "internal",
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
  const nestDb = new Database(nestDbPath("instagram-uploader"), { readonly: true });
  const nestRows = nestDb.prepare(
    `SELECT ticket_id, idempotency_key, agent_id, source_memory_id,
            status, embedding_adapter, embedding_dimensions, embedding_json
       FROM memory_candidates ORDER BY ticket_id`,
  ).all();
  assert.equal(nestRows.length, 2);
  assert.ok(nestRows.every((row) => row.agent_id === "hub:instagram-uploader"));
  assert.ok(nestRows.every((row) => row.status === "active"), "Core recall only consumes active experience rows");
  assert.ok(nestRows.every((row) => row.source_memory_id && row.idempotency_key));
  const expectedProjectionEmbedding = autoLocalEmbedding("mandatory local Model2Vec projection");
  assert.equal(expectedProjectionEmbedding.degraded, false, "borrowed-agent projection requires the verified Model2Vec asset");
  assert.equal(expectedProjectionEmbedding.model, MODEL2VEC_HYBRID_NAME);
  assert.equal(expectedProjectionEmbedding.dimensions, MODEL2VEC_HYBRID_DIMENSIONS);
  assert.ok(nestRows.every((row) =>
    row.embedding_adapter === MODEL2VEC_HYBRID_NAME
      && row.embedding_dimensions === MODEL2VEC_HYBRID_DIMENSIONS));
  assert.ok(nestRows.every((row) => JSON.parse(row.embedding_json).length === MODEL2VEC_HYBRID_DIMENSIONS));
  const adapterRegistration = nestDb.prepare(
    "SELECT name, config_json FROM runtime_adapters WHERE kind = 'vector'",
  ).get();
  assert.equal(adapterRegistration.name, MODEL2VEC_HYBRID_NAME);
  assert.equal(JSON.parse(adapterRegistration.config_json).identity, expectedProjectionEmbedding.adapter);
  nestDb.close();
  assert.equal(
    fs.existsSync(path.join(path.dirname(nestDbPath("instagram-uploader")), "project-soul-memory.md")),
    false,
    "cross-project recall must no longer rely on markdown cat",
  );

  // ── agent_repo는 프로젝트 경계를 넘는 유일한 스코프 → 프로젝트 고유 정보는 못 태운다 ──
  // scope 라벨은 모델이 붙인다. 오라벨된 이벤트는 이 프로젝트의 경로·이름을 다른 프로젝트와
  // 제3자 에이전트 둥지까지 옮긴다. 강등은 저장을 막지 않고 도달 범위만 좁힌다.
  {
    const leakProject = path.join(tmp, "Client_Confidential_Merger");
    fs.mkdirSync(leakProject, { recursive: true });
    const leakCtx = {
      ...baseCtx,
      projectPath: leakProject,
      projectId: "project-leak",
      cwdAtRequest: leakProject,
      borrowedAgentSlugs: ["leak-probe-agent"],
    };
    curateEvents(
      [
        ev("procedure", "agent_repo", "Client_Confidential_Merger 배포는 테스트 전에 돌려야 한다."),
        ev("procedure", "agent_repo", "설정은 /home/acme/private-client/secrets.yml 에 있다."),
      ],
      leakCtx,
    );
    assert.equal(
      readNest("leak-probe-agent"),
      null,
      "project-identifying agent_repo learnings must not reach a borrowed agent's cross-project nest",
    );
    // 진짜 이식 가능한 기술은 계속 흘러야 한다 — 가드가 크로스 프로젝트 학습을 죽이면 안 된다.
    curateEvents(
      [ev("procedure", "agent_repo", "재시도는 지수 백오프로 하고 5회에서 포기한다.")],
      leakCtx,
    );
    const portableNest = readNest("leak-probe-agent");
    assert.ok(portableNest, "portable agent_repo skills must still reach the nest");
    assert.match(portableNest, /지수 백오프/);
    assert.doesNotMatch(portableNest, /Client_Confidential_Merger/);
    assert.doesNotMatch(portableNest, /secrets\.yml/);
  }

  // Upgrade the old projection contract in place: Core cannot consume the
  // prior review-state status or Desktop's full adapter identity in the row.
  const legacyDb = new Database(nestDbPath("instagram-uploader"));
  legacyDb.prepare(
    "UPDATE memory_candidates SET status = 'accepted', embedding_adapter = ? WHERE ticket_id = ?",
  ).run("local_hashing:sha256-bow:v1:96", nestRows[0].ticket_id);
  legacyDb.close();
  curateEvents(
    [ev("procedure", "agent_repo", "레거시 투영을 활성 상태로 마이그레이션한다.")],
    { ...baseCtx, borrowedAgentSlugs: ["instagram_uploader"] },
  );
  const upgradedDb = new Database(nestDbPath("instagram-uploader"), { readonly: true });
  const upgradedLegacy = upgradedDb.prepare(
    "SELECT status, embedding_adapter FROM memory_candidates WHERE ticket_id = ?",
  ).get(nestRows[0].ticket_id);
  upgradedDb.close();
  assert.equal(upgradedLegacy.status, "active");
  assert.equal(upgradedLegacy.embedding_adapter, MODEL2VEC_HYBRID_NAME);

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

  // ── 5: session/시크릿은 어느 durable 저장소에도 안 간다 ───────────────────
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

  // 실제 공급자 형식과 같은 base64url 문자(-/_)를 쓰되, 실키가 아닌 결정론적 픽스처다.
  const openAiToken = ["sk", "proj", "AbCdEf12_34-GhIjKl56_MnOpQr78-StUvWx90_Yz"].join("-");
  const anthropicToken = ["sk", "ant", "api03", "ZyXwVu98_76-TsRqPo54_NmLkJi32-HgFeDc10_Ba"].join("-");
  const secretReport = curateEvents(
    [
      ev("decision", "project", `OpenAI key is ${openAiToken}`),
      ev("procedure", "agent_repo", `Anthropic key is ${anthropicToken}`),
    ],
    { ...baseCtx, borrowedAgentSlugs: ["instagram_uploader"] },
  );
  assert.equal(secretReport.redacted, 2, "provider-shaped base64url tokens must both be redacted");
  assert.equal(secretReport.written, 0, "redacted provider tokens must not reach the DB");

  const durableDbText = JSON.stringify(
    db.getDb().prepare("SELECT content, context_json FROM memory_entries").all(),
  );
  const projectSoulAfterSecrets = fs.readFileSync(
    path.join(projectPath, ".agentlas", "project-soul-memory.md"),
    "utf8",
  );
  const nestAfterSecrets = readNest("instagram-uploader") || "";
  const memoryLogAfterSecrets = fs.readFileSync(
    path.join(projectPath, ".agentlas", "memory-log.jsonl"),
    "utf8",
  );
  for (const token of [openAiToken, anthropicToken]) {
    assert.doesNotMatch(durableDbText, new RegExp(token), "provider token must not reach memory_entries");
    assert.doesNotMatch(projectSoulAfterSecrets, new RegExp(token), "provider token must not reach project soul");
    assert.doesNotMatch(nestAfterSecrets, new RegExp(token), "provider token must not reach the global agent nest");
    assert.doesNotMatch(memoryLogAfterSecrets, new RegExp(token), "provider token must not reach the memory log");
  }

  // ── 6: 문서용 짧은 접두사 표현은 기존처럼 허용(오탐 방지) ─────────────────
  const prefixDoc = "문서에는 키 접두사를 sk-proj- 또는 sk-ant-api03-처럼 표기한다.";
  const falsePositiveReport = curateEvents(
    [ev("procedure", "agent_repo", prefixDoc)],
    { ...baseCtx, borrowedAgentSlugs: ["instagram_uploader"] },
  );
  assert.equal(falsePositiveReport.redacted, 0, "bare provider prefixes must not be treated as secrets");
  assert.equal(falsePositiveReport.written, 1, "non-secret documentation must remain curatable");
  assert.match(readNest("instagram-uploader") || "", /sk-proj-/, "non-secret prefix documentation must reach the nest");

  // ── 7: Desktop supersession must retire the old cross-project projection ──
  const oldProjectionText = "레거시 업로드 절차는 초안 버튼을 두 번 누른다.";
  const replacementProjectionText = "업로드 절차는 검증 후 게시 버튼을 한 번만 누른다.";
  curateEvents(
    [
      ev("procedure", "agent_repo", oldProjectionText),
      ev("procedure", "agent_repo", replacementProjectionText),
    ],
    { ...baseCtx, borrowedAgentSlugs: ["instagram_uploader"] },
  );
  const sourceRows = db.getDb().prepare(
    "SELECT id, content FROM memory_entries WHERE content IN (?, ?)",
  ).all(oldProjectionText, replacementProjectionText);
  const oldSourceId = sourceRows.find((row) => row.content === oldProjectionText)?.id;
  const replacementSourceId = sourceRows.find((row) => row.content === replacementProjectionText)?.id;
  assert.ok(oldSourceId && replacementSourceId);
  assert.deepEqual(
    findAgentNestExperienceSlugs([oldSourceId]),
    ["instagram-uploader"],
    "projection ownership must resolve the borrowed slug, not the primary installed agent id",
  );
  assert.deepEqual(
    reconcileAgentNestExperienceConsolidation([oldSourceId], [{
      id: replacementSourceId,
      kind: "procedure",
      content: replacementProjectionText,
      confidence: "high",
      sensitivity: "internal",
      updatedAt: new Date().toISOString(),
    }]),
    ["instagram-uploader"],
  );
  const reconciledDb = new Database(nestDbPath("instagram-uploader"), { readonly: true });
  const reconciledRows = reconciledDb.prepare(
    `SELECT source_memory_id, status FROM memory_candidates
      WHERE source_memory_id IN (?, ?) ORDER BY source_memory_id`,
  ).all(oldSourceId, replacementSourceId);
  const supersedesEdges = reconciledDb.prepare(
    `SELECT count(*) AS count FROM memory_links l
      JOIN memory_candidates successor ON successor.ticket_id = l.from_ticket
      JOIN memory_candidates target ON target.ticket_id = l.to_ticket
      WHERE l.link_type = 'supersedes'
        AND successor.source_memory_id = ? AND target.source_memory_id = ?`,
  ).get(replacementSourceId, oldSourceId).count;
  reconciledDb.close();
  assert.equal(reconciledRows.find((row) => row.source_memory_id === oldSourceId)?.status, "superseded");
  assert.equal(reconciledRows.find((row) => row.source_memory_id === replacementSourceId)?.status, "active");
  assert.equal(supersedesEdges, 1, "an unambiguous replacement must persist a typed supersedes edge");

  // A consolidation inherits the strictest source sensitivity. Even if a
  // caller supplies a cross-scope replacement, the projection may retire the
  // stale row but must not manufacture a supersedes edge across privacy scope.
  assert.equal(
    strictestMemorySensitivity([{ sensitivity: "internal" }, { sensitivity: "confidential" }]),
    "confidential",
  );
  const internalOldText = "내부 전용 레거시 브라우저 절차";
  const privateReplacementText = "기밀 브라우저 절차를 새 규칙으로 통합";
  curateEvents(
    [
      ev("procedure", "agent_repo", internalOldText),
      { ...ev("procedure", "agent_repo", privateReplacementText), sensitivity: "confidential" },
    ],
    { ...baseCtx, borrowedAgentSlugs: ["instagram_uploader"] },
  );
  const mixedRows = db.getDb().prepare(
    "SELECT id, content FROM memory_entries WHERE content IN (?, ?)",
  ).all(internalOldText, privateReplacementText);
  const internalOldId = mixedRows.find((row) => row.content === internalOldText)?.id;
  const privateReplacementId = mixedRows.find((row) => row.content === privateReplacementText)?.id;
  assert.ok(internalOldId && privateReplacementId);
  assert.deepEqual(reconcileAgentNestExperienceConsolidation([internalOldId], [{
    id: privateReplacementId,
    kind: "procedure",
    content: privateReplacementText,
    confidence: "high",
    sensitivity: "confidential",
    updatedAt: new Date().toISOString(),
  }]), ["instagram-uploader"]);
  const mixedDb = new Database(nestDbPath("instagram-uploader"), { readonly: true });
  const mixedOld = mixedDb.prepare(
    "SELECT status FROM memory_candidates WHERE source_memory_id = ?",
  ).get(internalOldId);
  const crossScopeEdges = mixedDb.prepare(
    `SELECT count(*) AS count FROM memory_links l
      JOIN memory_candidates successor ON successor.ticket_id = l.from_ticket
      JOIN memory_candidates target ON target.ticket_id = l.to_ticket
      WHERE l.link_type = 'supersedes'
        AND successor.source_memory_id = ? AND target.source_memory_id = ?`,
  ).get(privateReplacementId, internalOldId).count;
  mixedDb.close();
  assert.equal(mixedOld.status, "superseded");
  assert.equal(crossScopeEdges, 0, "privacy-scope mismatch must block a structural supersedes edge");

  // Different borrowed owners must never be unioned. A primary installed
  // agent can call both agents, but their private experience projections stay
  // isolated even if an attempted dreaming batch contains both source ids.
  const slugAText = "slug A only browser workflow";
  const slugBText = "slug B only database workflow";
  curateEvents([ev("procedure", "agent_repo", slugAText)], {
    ...baseCtx,
    borrowedAgentSlugs: ["borrowed_slug_a"],
  });
  curateEvents([ev("procedure", "agent_repo", slugBText)], {
    ...baseCtx,
    borrowedAgentSlugs: ["borrowed_slug_b"],
  });
  const isolatedRows = db.getDb().prepare(
    "SELECT id, content FROM memory_entries WHERE content IN (?, ?)",
  ).all(slugAText, slugBText);
  const slugAId = isolatedRows.find((row) => row.content === slugAText)?.id;
  const slugBId = isolatedRows.find((row) => row.content === slugBText)?.id;
  assert.ok(slugAId && slugBId);
  assert.deepEqual(agentNestExperienceOwnership([slugAId, slugBId]), {
    [slugAId]: ["borrowed-slug-a"],
    [slugBId]: ["borrowed-slug-b"],
  });
  const forbiddenCombined = "FORBIDDEN cross-owner combined rule";
  assert.deepEqual(reconcileAgentNestExperienceConsolidation([slugAId, slugBId], [{
    id: "cross-owner-consolidated",
    kind: "procedure",
    content: forbiddenCombined,
    confidence: "high",
    sensitivity: "internal",
    updatedAt: new Date().toISOString(),
  }]), [], "mixed owner sets must be refused before any projection write");
  assert.doesNotMatch(readNest("borrowed-slug-a") || "", /FORBIDDEN cross-owner/);
  assert.doesNotMatch(readNest("borrowed-slug-b") || "", /FORBIDDEN cross-owner/);

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(sandboxHome, { recursive: true, force: true });
  console.log("curator → agent nest wiring contract ok");
  app.quit();
}

main().catch((err) => {
  console.error(err);
  app.exit(1);
});
