// 장기 방 런타임 스레드 회전(rotation) — 한 Codex 스레드가 무한히 자라 매 호출마다
// 16만+ 토큰을 다시 읽는 것(2026-10-10 Youtube launch 방: 롤아웃 134MB, 자동 압축 22회,
// 누적 입력 1.2억 토큰)을 끊는다. Codex 내장 압축은 앞부분을 손실 요약으로 바꿀 뿐
// 스크린샷 같은 관측 덩어리를 그대로 들고 간다. 회전은 "턴 경계에서만" 이전 스레드를
// 버리고 새 스레드를 호스트가 쓴 짧은 인수인계(목표 계약은 turnContext, 최근 대화 텍스트)로 시작한다.
//
// 이 모듈은 순수 결정/조립 함수 + 얇은 meta 영속화만 담는다. 스키마 변경 없음(meta 표 재사용).
import type { ChatHistoryEntry } from "../../shared/types";

/** 직전 턴의 마지막 모델 호출 입력 토큰이 이 값 이상이면 회전 — 자동 압축 한도(150K) 직전. */
export const ROTATE_LAST_INPUT_TOKENS = 120_000;
/** 한 스레드에서 네이티브 압축이 이만큼 일어났으면 회전 — 요약의 요약이 쌓이는 신호. */
export const ROTATE_COMPACTIONS = 3;
/** 건강 기록이 없는 구스레드의 폴백: 보고된 누적 입력 토큰(스레드 전체) 상한. */
export const ROTATE_CUMULATIVE_INPUT_TOKENS = 40_000_000;
/** 한 스레드가 겪은 턴 수 상한 — 작은 문맥이어도 무한 수명은 막는다. */
export const ROTATE_TURNS = 60;
/** 인수인계에 싣는 최근 대화 예산(토큰). 목표 계약/계획은 turnContext가 따로 싣는다. */
export const HANDOFF_HISTORY_TOKENS = 6_000;
/** 인수인계 메시지 한 건 글자 상한 — 도구 덤프/로그가 섞여 들어오는 것을 막는다. */
export const HANDOFF_MESSAGE_CHARS = 1_200;
export const HANDOFF_MAX_MESSAGES = 12;
/** 일반 Codex 방 실행의 네이티브 자동 압축 한도. 회전(120K)이 먼저 걸리고 압축은 안전망. */
export const ROOM_AUTO_COMPACT_TOKEN_LIMIT = 150_000;

export interface ThreadHealth {
  threadId: string;
  /** 이 스레드에서 완료까지 관측된 턴 수. */
  turns: number;
  /** 관측된 네이티브 압축 횟수. */
  compactions: number;
  /** 가장 최근 턴의 마지막 모델 호출 입력 토큰(캐시 읽기 포함). */
  lastInputTokens: number | null;
  maxInputTokens: number | null;
  observedAt: string;
}

export type RotationReason = "last_input_tokens" | "compactions" | "cumulative_input_tokens" | "turns";

export interface RotationDecision {
  rotate: boolean;
  reasons: RotationReason[];
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * 회전 여부. 호출자는 "턴이 끝난 뒤 다음 턴을 시작하기 직전"에만 부른다(턴 도중 호출 금지).
 * turnInFlight 가 참이면 무조건 회전하지 않는다 — 방어선이지 허가가 아니다.
 */
export function decideSessionRotation(input: {
  health: ThreadHealth | null;
  reportedInputTokens: number | null;
  turnInFlight?: boolean;
}): RotationDecision {
  if (input.turnInFlight) return { rotate: false, reasons: [] };
  const reasons: RotationReason[] = [];
  const h = input.health;
  const last = num(h?.lastInputTokens);
  if (last !== null && last >= ROTATE_LAST_INPUT_TOKENS) reasons.push("last_input_tokens");
  if (h && h.compactions >= ROTATE_COMPACTIONS) reasons.push("compactions");
  if (h && h.turns >= ROTATE_TURNS) reasons.push("turns");
  const cumulative = num(input.reportedInputTokens);
  if (cumulative !== null && cumulative >= ROTATE_CUMULATIVE_INPUT_TOKENS) reasons.push("cumulative_input_tokens");
  return { rotate: reasons.length > 0, reasons };
}

/** 이미지/대용량 덩어리를 걷어낸 텍스트. 데이터 URI·base64 긴 줄·첨부 마커는 자리표시로 대체. */
export function stripHeavyContent(text: string): string {
  return text
    .replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "[image omitted]")
    .replace(/[A-Za-z0-9+/=]{400,}/g, "[blob omitted]")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[image omitted]");
}

/** 최근 N건만, 건당 글자 상한, 텍스트만. system 역할 기록은 인수인계에서 제외한다. */
export function boundHandoffHistory(history: ChatHistoryEntry[]): ChatHistoryEntry[] {
  const kept = history.filter((m) => m.role !== "system" && typeof m.text === "string" && m.text.trim() !== "")
    .slice(-HANDOFF_MAX_MESSAGES);
  return kept.map((m) => {
    const clean = stripHeavyContent(m.text);
    const text = clean.length > HANDOFF_MESSAGE_CHARS
      ? `${clean.slice(0, HANDOFF_MESSAGE_CHARS)} …[truncated]` : clean;
    return { ...m, text };
  });
}

/** 새 스레드 첫 턴 맨 앞에 붙는 한 단락. 사실 그대로만 말한다. */
export function renderRotationNotice(input: {
  previousThreadId: string;
  reasons: RotationReason[];
  locale: "ko" | "en" | string;
}): string {
  const why = input.reasons.join(", ");
  return input.locale === "ko"
    ? `[런타임 스레드 회전] 이전 모델 스레드(${input.previousThreadId.slice(0, 8)})가 길어져(${why}) 새 스레드로 이어간다. `
      + "목표 계약·계획·체크포인트는 아래 컨텍스트와 도구(원장)에 그대로 있다. 이전 스레드의 스크린샷·도구 출력은 가져오지 않았으니, 필요하면 도구로 다시 읽어라."
    : `[Runtime thread rotation] The previous model thread (${input.previousThreadId.slice(0, 8)}) grew long (${why}); `
      + "this conversation continues in a fresh thread. The goal contract, plan and checkpoint are in the context below and in the ledger tools. "
      + "Screenshots and tool output from the old thread were not carried over; re-read through tools if needed.";
}

export interface RotationReceipt {
  schemaVersion: "agentlas.runtime-thread-rotation.v1";
  chatId: string;
  previousThreadId: string;
  reasons: RotationReason[];
  health: ThreadHealth | null;
  reportedInputTokens: number | null;
  rotatedAt: string;
}

const healthKey = (threadId: string): string => `runtime-thread-health:${threadId}`;
const receiptKey = (threadId: string): string => `runtime-thread-rotation:${threadId}`;

type MetaApi = { getMeta(key: string): string | null; setMeta(key: string, value: string): void };
function meta(): MetaApi | null {
  try { return require("../store/meta") as MetaApi; } catch { return null; }
}

export function readThreadHealth(threadId: string): ThreadHealth | null {
  try {
    const raw = meta()?.getMeta(healthKey(threadId));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<ThreadHealth>;
    if (v.threadId !== threadId) return null;
    return { threadId, turns: Number(v.turns) || 0, compactions: Number(v.compactions) || 0,
      lastInputTokens: num(v.lastInputTokens), maxInputTokens: num(v.maxInputTokens),
      observedAt: typeof v.observedAt === "string" ? v.observedAt : "" };
  } catch { return null; }
}

/** 완료된 턴 하나를 스레드 건강 기록에 더한다. 실패해도 턴에는 영향이 없다. */
export function recordThreadTurn(threadId: string, obs: { lastInputTokens: number | null; compactions: number }): void {
  try {
    const prev = readThreadHealth(threadId);
    const last = num(obs.lastInputTokens);
    const next: ThreadHealth = {
      threadId,
      turns: (prev?.turns ?? 0) + 1,
      compactions: (prev?.compactions ?? 0) + Math.max(0, Math.floor(obs.compactions)),
      lastInputTokens: last ?? prev?.lastInputTokens ?? null,
      maxInputTokens: Math.max(prev?.maxInputTokens ?? 0, last ?? 0) || null,
      observedAt: new Date().toISOString(),
    };
    meta()?.setMeta(healthKey(threadId), JSON.stringify(next));
  } catch { /* 관측 실패는 무시 */ }
}

/** 회전 영수증 — 이전 스레드 id는 참고용으로만 남고 다시 resume 되지 않는다. */
export function recordRotationReceipt(receipt: RotationReceipt): boolean {
  try {
    meta()?.setMeta(receiptKey(receipt.previousThreadId), JSON.stringify(receipt));
    return true;
  } catch { return false; }
}

export function readRotationReceipt(threadId: string): RotationReceipt | null {
  try {
    const raw = meta()?.getMeta(receiptKey(threadId));
    return raw ? JSON.parse(raw) as RotationReceipt : null;
  } catch { return null; }
}
