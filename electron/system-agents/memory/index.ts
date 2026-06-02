// 메모리 시스템 에이전트 — 앱/터미널의 "메모리 관련" 시스템 에이전트(목표 1차).
// 큐레이터/PM-soul/task-bias 에이전트 프롬프트는 architecture/manifest.ts에 살며, 각자 라우팅으로
// 호출될 때만 로드된다(이미 on-demand). 여기서 다루는 건 "매 턴 모든 에이전트에 주입되는" 메모리
// emit 능력(MEMORY_EMITTER_BLOCK, ~1.5KB)의 코어/온디맨드 분리다.
//
// 분리 원칙: emit 트리거는 capability-critical(미스 시 durable 학습이 통째로 유실)이라 코어 고정.
// 장황한 JSON 스키마·request_context 필드·예시는 emit이 실제로 일어나는 메모리-관련 턴에만 온디맨드.
import type { SystemAgentSpec, OnDemandModule } from "../types";
import { MEMORY_EMITTER_BLOCK } from "../../architecture/manifest";

/** 항상-켜진 최소 코어 — 모델이 매 턴 "기억할 게 있으면 남겨라"를 알게 한다(안전 규칙 포함). */
export const MEMORY_CORE = [
  "## Memory",
  "If — and only if — this turn produced something durable (a decision, stable fact, user preference, risk, or reusable procedure), end your reply with a `## Memory Events` JSON block; emit nothing otherwise.",
  "Each event: memory_kind (fact|decision|preference|risk|procedure|hypothesis|evidence|deprecation|conflict), content (1–2 sentences), suggested_scope (user_identity|team_memory|project|agent_repo|session|discard).",
  "Never record secrets, credentials, API keys, raw logs, or full transcripts. One event per durable item. Suggest a scope; the Memory Curator decides the final destination.",
].join("\n");

/** 온디맨드 — 전체 스키마(kinds/scopes enum, request_context 필드, JSON 포맷 예시). emit 시점에만 필요. */
export const MEMORY_SCHEMA_MODULE: OnDemandModule = {
  id: "memory-schema",
  title: "Memory Events full schema",
  keywords: [
    "remember", "memory", "save", "note", "decision", "preference", "fact", "risk",
    "procedure", "record", "기억", "저장", "메모리", "결정", "선호", "기록", "남겨",
  ],
  description:
    "Full schema for emitting a Memory Events block: memory_kind/suggested_scope enums, request_context fields (user_intent, trigger_terms, target_project, outcome…), and the exact JSON format.",
  // 정본 블록을 그대로 로드(중복/이탈 방지). 코어는 위 요약본만 항상 깔린다.
  load: () => MEMORY_EMITTER_BLOCK,
};

export const MEMORY_SYSTEM_AGENT: SystemAgentSpec = {
  id: "memory",
  core: MEMORY_CORE,
  modules: [MEMORY_SCHEMA_MODULE],
};
