#!/usr/bin/env node
/*
 * 판정기가 못 답할 때의 로컬 관련도 폴백은 오너의 말(프롬프트·목표 objective)만 잰다 —
 * 목표의 수용 기준(검증기 문장)은 재지 않는다.
 *
 * 실측(2026-09-27, 설치본 1.2.45, One 단톡 "Youtube launch"): "블렌더 숏츠로 유튜브 키워서 실버버튼"
 * 요청의 자동 목표 두 턴 모두 plugin_route_selection 이 local-relevance 로
 * agentlas-astronomy(+ paleontology, science-statistics)를 붙였다. 원인은 질의에 섞인 자동 목표
 * 기준 문장("Every deliverable in this request is complete…", "This run has full permission…")과
 * 첨부 표식(<!-- agentlas-chat-files… -->)이었다: 그걸 빼면 아무 플러그인도 하한을 넘지 않는다.
 *
 * 실제 제품 함수만 쓴다: buildAutomaticGoalCriteria(기준 문장 생성), listInstalledPluginCandidates
 * (저장소 plugins/ 카탈로그), localRelevanceQuery + rankByLocalRelevance(폴백 순위).
 * 의미 모델(Model2Vec)이 이 기계에서 검증되지 않으면 SKIP — 통과로 위장하지 않는다.
 * Run: node scripts/plugin-fallback-ignores-verifier-boilerplate-contract.cjs
 */
const assert = require("node:assert/strict");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const { createJiti } = require(path.join(root, "node_modules/jiti"));
const jiti = createJiti(__filename, { interopDefault: true });
const candidates = jiti(path.join(root, "electron/plugins/plugin-candidates.ts"));
const { buildAutomaticGoalCriteria } = jiti(path.join(root, "shared/automatic-goal-criteria.ts"));
const embedding = jiti(path.join(root, "electron/memory/local-embedding.ts"));

let semantic = false;
try { semantic = embedding.autoLocalEmbedding("probe").model === embedding.MODEL2VEC_HYBRID_NAME; } catch { semantic = false; }
if (!semantic) {
  console.log("SKIP plugin-fallback-ignores-verifier-boilerplate-contract — the multilingual semantic model is not verified on this machine");
  process.exit(0);
}

// Recorded shapes (owner text shortened; the host marker kept as recorded).
const request = "너가 알아서 단톡방에 에이전트 만들던지 팀원 초대하던지 해서 유투브 키우셈 모든 권한 줄테니까 3개월 내에 실버버튼 받게 해줘. "
  + "블렌더로 10초 20초 숏츠 만들어서 올리면 잘되더만, 주제 알아서 ai 관련으로 하던지 조회수 잘나오고 구독 잘받는 소재를 먼저 찾고 그담에 하던지 "
  + "아무튼 어케든 실버버튼 받게 해주셈\n\n<!-- agentlas-chat-files:v1:00000000-0000-4000-8000-000000000000 -->";
const steering = "채널설정부터 모든거 너 마음대로 하셈 허락 ㄴㄴ";
const criteria = buildAutomaticGoalCriteria({ sourceText: request, permission: "full", lifecycle: "finite" }).map((criterion) => criterion.text);

const installed = candidates.listInstalledPluginCandidates(path.join(root, "plugins"));
const items = installed.map((plugin) => ({ id: candidates.pluginCandidateId(plugin.slug), text: plugin.searchText, agentlas: plugin.agentlas }));
assert.ok(items.some((item) => item.id === "plugin:agentlas-astronomy"), "the repo catalogue carries the astronomy plugin");
const rank = (query) => candidates.rankByLocalRelevance(query, items).map((hit) => hit.id);

let passed = 0;
const ok = (name) => { passed += 1; console.log(`ok   ${name}`); };

// The recorded failure: the pre-fix query (prompt + objective + criteria) routes astronomy.
const legacy = [steering, request, ...criteria].join("\n");
assert.ok(rank(legacy).includes("plugin:agentlas-astronomy"), "recorded shape reproduces: boilerplate lifts astronomy");
ok("recorded failure reproduces with the pre-fix query (prompt + objective + verifier criteria)");

for (const [label, userPrompt] of [["first turn", request], ["steering turn", steering]]) {
  const query = candidates.localRelevanceQuery({ userPrompt, objective: request });
  assert.doesNotMatch(query, /Every deliverable|full permission|agentlas-chat-files/, `${label}: no verifier text or host marker in the query`);
  assert.deepEqual(rank(query), [], `${label}: a YouTube Shorts request routes no science plugin`);
}
ok("fixed query: owner words only — nothing routed for the YouTube request");

// Genuine requests still route (the fallback is not simply switched off).
assert.ok(rank(candidates.localRelevanceQuery({ userPrompt: "외계행성 트랜짓 광도곡선 분석해줘" })).includes("plugin:agentlas-astronomy"));
assert.ok(rank(candidates.localRelevanceQuery({ userPrompt: "주식 포트폴리오 위험 통계 분석" })).includes("plugin:agentlas-science-statistics"));
ok("genuine astronomy / statistics requests still route on fallback");

console.log(`plugin-fallback-ignores-verifier-boilerplate-contract: PASS (${passed})`);
