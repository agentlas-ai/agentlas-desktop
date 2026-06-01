// 런타임 시스템 프롬프트 동적 조립 — 코어 + 요청에 맞는 온디맨드 모듈만.
// 이게 ITR의 "매 스텝 최소 시스템 프롬프트 조립" 부분. 코어만 1~2KB, 모듈은 필요할 때만.
import type { SystemAgentSpec } from "./types";
import { selectModules, type SelectOptions } from "./discovery";

export interface AssembleResult {
  systemPrompt: string;
  /** 이번 턴에 실제 로드된 모듈 id(텔레메트리/디버깅·miss-rate 측정용) */
  loadedModuleIds: string[];
  scores: Array<{ id: string; score: number }>;
  /** 코어 + 모듈 합산 대략 문자 수(토큰 절감 측정용) */
  chars: number;
}

export function assembleSystemPrompt(
  agent: SystemAgentSpec,
  query: string,
  opts?: SelectOptions,
): AssembleResult {
  const { selected, scores } = selectModules(query, agent.modules, opts);
  const parts = [agent.core, ...selected.map((m) => m.load())];
  const systemPrompt = parts.join("\n\n");
  return {
    systemPrompt,
    loadedModuleIds: selected.map((m) => m.id),
    scores,
    chars: systemPrompt.length,
  };
}
