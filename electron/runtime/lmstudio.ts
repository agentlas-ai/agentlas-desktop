// LM Studio 로컬 LLM — 감지 + 실호출.
// LM Studio는 OpenAI 호환 서버를 localhost:1234에 띄운다(GUI의 "Local Server").
// 감지·채팅 모두 local-openai.ts의 공용 로직을 재사용한다.
import { makeLocalOpenAiRunner, normalizeLocalHost, probeOpenAiLocal } from "./local-openai";
import type { Runner } from "./runner";

/** 기본 로컬 호스트. env LMSTUDIO_HOST로 재정의 가능(원격 LM Studio도 지원). */
export function lmStudioHost(): string {
  return normalizeLocalHost(process.env.LMSTUDIO_HOST, "http://localhost:1234");
}

/** 로컬 LM Studio 서버 감지. 서버가 안 떠 있으면 null. */
export function probeLMStudio(timeoutMs?: number) {
  return probeOpenAiLocal(lmStudioHost(), timeoutMs);
}

export const runLMStudio: Runner = makeLocalOpenAiRunner(lmStudioHost, "lmstudio");
