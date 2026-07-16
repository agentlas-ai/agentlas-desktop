// 메모리 시스템 에이전트 — 앱/터미널의 "메모리 관련" 시스템 에이전트(목표 1차).
// 큐레이터/PM-soul/task-bias 에이전트 프롬프트는 architecture/manifest.ts에 살며, 각자 라우팅으로
// 호출될 때만 로드된다(이미 on-demand). 여기서 다루는 건 "매 턴 모든 에이전트에 주입되는" 메모리
// emit 능력(MEMORY_EMITTER_BLOCK, ~1.5KB)의 코어/온디맨드 분리다.
//
// 분리 원칙: emit 트리거는 capability-critical(미스 시 durable 학습이 통째로 유실)이라 코어 고정.
// 장황한 JSON 스키마·request_context 필드·예시는 emit이 실제로 일어나는 메모리-관련 턴에만 온디맨드.
import type { SystemAgentSpec, OnDemandModule } from "../types";
import { MEMORY_EMITTER_BLOCK } from "../../architecture/manifest";

/** 항상-켜진 최소 코어 — 모든 완료 턴이 관찰 영수증을 남기고, 후보만 선택적으로 제안한다. */
export const MEMORY_CORE = [
  "## Memory",
  "End EVERY completed normal reply with exactly one hidden `## Memory Events` fenced JSON envelope: `{schema_version:\"agentlas.memory-ticket.v1\",turn_summary:\"one safe sentence\",candidates:[]}`. Never omit it; use [] when nothing durable was learned.",
  "Only when this turn produced a durable decision or reusable fact, use non-empty candidates. Each has memory_kind, content, suggested_scope, confidence, sensitivity, evidence_refs. Scopes: user_identity, team_memory, agent_repo, agent_team, project, session, discard. Never include secrets, credentials, raw logs, prompts, transcripts, or absolute paths. The Curator decides disposition.",
].join("\n");

export const MEMORY_CORE_MAX_APPROX_TOKENS = 220;

const MEMORY_DETAIL_RE = /\b(?:remember|memory|save this|record this|memory event)\b|기억|메모리|저장해|기록해|남겨/i;
// A stated preference or identity fact is exactly what belongs in user_identity,
// yet the always-on core prompt has no room to explain that scope. So when the
// turn carries one of those signals, load the full schema block (which does
// explain it) — otherwise the model emits the preference at medium confidence
// and the curator throws it away. Kept deliberately narrow: imperative "call
// me / from now on / always" phrasings and explicit self-description, not every
// mention of a name.
const PREFERENCE_SIGNAL_RE =
  /\b(?:call me|from now on|always|prefer|please use|i am|i'm|my name is|my role)\b|앞으로|항상|불러|말투|반말|존댓말|내 이름|나를|프로필|선호/i;

/** Full schema is loaded when the task is about memory, or states a durable preference/identity. */
export function memoryEmitterPromptFor(request: string): string {
  return MEMORY_DETAIL_RE.test(request) || PREFERENCE_SIGNAL_RE.test(request)
    ? MEMORY_EMITTER_BLOCK
    : MEMORY_CORE;
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
