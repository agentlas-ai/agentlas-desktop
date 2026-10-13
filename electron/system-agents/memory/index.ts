// 메모리 시스템 에이전트 — 앱/터미널의 "메모리 관련" 시스템 에이전트(목표 1차).
// 큐레이터/PM-soul/task-bias 에이전트 프롬프트는 architecture/manifest.ts에 살며, 각자 라우팅으로
// 호출될 때만 로드된다(이미 on-demand). 여기서 다루는 건 "매 턴 모든 에이전트에 주입되는" 메모리
// emit 능력(MEMORY_EMITTER_BLOCK, ~1.5KB)의 코어/온디맨드 분리다.
//
// 분리 원칙: emit 트리거는 capability-critical(미스 시 durable 학습이 통째로 유실)이라 코어 고정.
// 장황한 JSON 스키마·request_context 필드·예시는 emit이 실제로 일어나는 메모리-관련 턴에만 온디맨드.
import type { SystemAgentSpec, OnDemandModule } from "../types";
import { MEMORY_EMITTER_BLOCK } from "../../architecture/manifest";

/**
 * The whole memory contract for runtimes that still write it as text (byok, Agentlas serving, local models). Owner
 * 2026-10-13: agents output only the per-turn receipt; no candidates (they cost output tokens on every answer). Runtimes
 * that list MCP tools directly get no memory text at all (the host builds the receipt).
 */
export const MEMORY_CORE = MEMORY_EMITTER_BLOCK;

export const MEMORY_CORE_MAX_APPROX_TOKENS = 220;

/** One contract on every turn: the turn_summary receipt (owner 2026-10-13: output only, no candidates). */
export function memoryEmitterPromptFor(request: string, _locale?: "ko" | "en"): string {
  // Display locale never changes the canonical English memory contract.
  // Non-English owner wording is preserved separately in content_native.
  void request;
  return MEMORY_CORE;
}

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
