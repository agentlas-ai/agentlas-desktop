// 대화 히스토리 압축 — Agentlas-managed 러너(BYOK/Ollama) 전용.
//
// 왜 여기서? CLI 런타임(Claude Code/Codex/Antigravity)은 자체 세션·압축을 자동 관리하므로
// 건드리지 않는다 (CONTEXT_MANAGED_BY === "runtime"). 반면 BYOK 직접 API와 Ollama는
// Agentlas가 매 턴 히스토리를 통째로 들고 보내므로, 모델 컨텍스트 윈도우를 넘기면
// 무한 성장·API 거부가 발생한다. 이 모듈이 그걸 모델 컨텍스트 기준으로 막는다.
//
// 전략: 최근 N개 turn은 원문 유지, 그보다 오래된 turn들은 하나의 다이제스트(요약 텍스트)로 접어
// system 프롬프트에 주입한다. LLM 재호출 없는 동기 압축 — 추가 비용·지연 0, role 순서도 안 깨짐.
import type { ChatHistoryEntry } from "../../shared/types";
import { tStatus, type RuntimeLocale } from "./status-i18n";

/** 매우 거친 토큰 추정 (라이브러리 없이 동기). 한/영 혼용 안전하게 과대추정 쪽. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export interface CompactOptions {
  /** 모델의 (유효) 컨텍스트 윈도우 토큰. 이 값 기반으로 히스토리 예산을 잡는다. */
  contextWindow: number;
  /** 항상 원문 그대로 유지할 최근 메시지 수 */
  keepRecent?: number;
  locale: RuntimeLocale;
}

export interface CompactResult {
  /** 모델에 보낼 최근 메시지 (원문). 압축 안 했으면 입력 그대로. */
  recent: ChatHistoryEntry[];
  /** 접힌 과거 대화 요약 — null이면 압축 안 함. system 프롬프트에 주입한다. */
  digest: string | null;
  /** 다이제스트로 접힌 메시지 수 */
  droppedCount: number;
}

/**
 * 히스토리를 모델 컨텍스트 예산 안으로 압축한다.
 * 예산 초과가 아니면 입력을 그대로 돌려준다(압축 없음).
 */
export function compactHistory(
  history: ChatHistoryEntry[],
  opts: CompactOptions,
): CompactResult {
  const keepRecent = opts.keepRecent ?? 6;
  // 히스토리에는 컨텍스트 윈도우의 일부만 할당 (system + 생성 응답 여유분 확보).
  const budget = Math.max(2000, Math.floor(opts.contextWindow * 0.6));

  const total = history.reduce((sum, m) => sum + estimateTokens(m.text), 0);
  if (total <= budget || history.length <= keepRecent + 1) {
    return { recent: history, digest: null, droppedCount: 0 };
  }

  // 분할점을 user 메시지 경계로 맞춘다 — recent가 assistant로 시작하면 Anthropic이
  // "first message must use the user role"로 거부하므로, user 턴에서 자르도록 앞으로 당긴다.
  let splitIdx = history.length - keepRecent;
  while (splitIdx < history.length && history[splitIdx].role !== "user") {
    splitIdx += 1;
  }
  // 안전장치: 경계를 못 찾으면(이론상 없음) 원래 분할점 사용.
  if (splitIdx >= history.length) splitIdx = history.length - keepRecent;

  const recent = history.slice(splitIdx);
  const older = history.slice(0, splitIdx);

  // older를 한 줄/메시지로 간추려 누적. 다이제스트 글자 예산 초과 시 가장 오래된 앞부분부터 버린다.
  const digestBudgetChars = 4000;
  const lines = older.map((m) => {
    const who =
      m.role === "user"
        ? tStatus(opts.locale, "speakerUser")
        : tStatus(opts.locale, "speakerAssistant");
    const snippet = m.text.replace(/\s+/g, " ").trim();
    return `${who}: ${snippet.length > 280 ? snippet.slice(0, 280) + "…" : snippet}`;
  });

  let body = lines.join("\n");
  if (body.length > digestBudgetChars) {
    body = "…\n" + body.slice(body.length - digestBudgetChars);
  }

  const digest = `${tStatus(opts.locale, "compactedDigestHeader")}\n${body}`;
  return { recent, digest, droppedCount: older.length };
}
