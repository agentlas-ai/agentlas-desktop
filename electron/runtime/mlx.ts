// MLX 로컬 LLM — 감지 + 실호출. (Apple Silicon 네이티브)
// `mlx_lm.server`가 OpenAI 호환 서버를 localhost:8080에 띄운다.
// 감지·채팅 모두 local-openai.ts의 공용 로직을 재사용한다.
import { makeLocalOpenAiRunner, normalizeLocalHost, probeOpenAiLocal } from "./local-openai";
import type { Runner } from "./runner";

/** 기본 로컬 호스트. env MLX_HOST로 재정의 가능(포트 변경 시). */
export function mlxHost(): string {
  return normalizeLocalHost(process.env.MLX_HOST, "http://localhost:8080");
}

/** 로컬 mlx_lm.server 감지. 서버가 안 떠 있으면 null. */
export function probeMLX(timeoutMs?: number) {
  return probeOpenAiLocal(mlxHost(), timeoutMs);
}

export const runMLX: Runner = makeLocalOpenAiRunner(mlxHost, "mlx");
