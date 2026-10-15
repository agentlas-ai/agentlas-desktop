// 시스템 에이전트 프롬프트 조립 — 코어 + 모든 모듈. 오너 2026-10-13: 단어장(BM25 키워드)으로 모듈을 고르지 않는다.
import type { SystemAgentSpec } from "./types";

export interface AssembleResult {
  systemPrompt: string;
  /** Exact source pieces, loaded once; consumers declare the source's own lifetime. */
  parts: readonly { id: string; text: string }[];
  /** 실린 모듈 id(텔레메트리) */
  loadedModuleIds: string[];
  /** 코어 + 모듈 합산 문자 수 */
  chars: number;
}

export function assembleSystemPrompt(agent: SystemAgentSpec, _query?: string, _opts?: unknown): AssembleResult {
  void _query; void _opts;
  const parts = [{ id: "core", text: agent.core }, ...agent.modules.map((m) => ({ id: m.id, text: m.load() }))];
  const systemPrompt = parts.map(part => part.text).join("\n\n");
  return { systemPrompt, parts, loadedModuleIds: agent.modules.map((m) => m.id), chars: systemPrompt.length };
}
