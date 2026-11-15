// 장기 방 런타임 스레드 회전(rotation) — 한 Codex 스레드가 무한히 자라 매 호출마다
// 16만+ 토큰을 다시 읽는 것(2026-10-10 Youtube launch 방: 롤아웃 134MB, 자동 압축 22회,
// 누적 입력 1.2억 토큰)을 끊는다. Codex 내장 압축은 앞부분을 손실 요약으로 바꿀 뿐
// 스크린샷 같은 관측 덩어리를 그대로 들고 간다. 회전은 "턴 경계에서만" 이전 스레드를
// 버리고 새 스레드를 호스트가 쓴 짧은 인수인계(목표 계약은 turnContext, 최근 대화 텍스트)로 시작한다.
//
// 이 모듈은 순수 결정/조립 함수 + 얇은 meta 영속화만 담는다. 스키마 변경 없음(meta 표 재사용).
import type { ChatHistoryEntry } from "../../shared/types";
import type { HostFacts } from "./handoff-facts";

/** 인수인계에 싣는 최근 대화 예산(토큰). 목표 계약/계획은 turnContext가 따로 싣는다. */
export const HANDOFF_HISTORY_TOKENS = 6_000;
/**
 * 인수인계 메시지 한 건 글자 상한 — 도구 덤프/로그가 섞여 들어오는 것을 막는다.
 * basis: 정한 값 — 근거 없음. 닿으면: 그 메시지 끝이 잘리고 `…[truncated]`가 붙는다(모델이 본다).
 */
export const HANDOFF_MESSAGE_CHARS = 1_200;
/**
 * basis: 정한 값 — 근거 없음. 닿으면: 더 오래된 메시지는 새 스레드에 실리지 않고, 맨 앞 메시지 첫 줄이 몇 건이 빠졌는지 말한다(이전에는 말없이 빠졌다).
 * (HANDOFF_HISTORY_TOKENS 6,000은 어디서도 적용되지 않는다 — 실제 상한은 12건 × 1,200자뿐이라 영어로는 약 3,600토큰, 글자당 토큰이 많은 한국어는 6,000을 넘을 수 있다.)
 */
export const HANDOFF_MAX_MESSAGES = 12;

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

/** Why a thread gave way (session-generation.ts; owner 2026-10-13: 80% of the model window, no fixed thresholds). */
export type RotationReason = "context_ratio" | "resume_failed" | "context_overflow";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** 이미지/대용량 덩어리를 걷어낸 텍스트. 데이터 URI·base64 긴 줄·첨부 마커는 자리표시로 대체. */
export function stripHeavyContent(text: string): string {
  return text
    .replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "[image omitted]")
    .replace(/[A-Za-z0-9+/=]{400,}/g, "[blob omitted]")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[image omitted]");
}

/** 최근 N건만, 건당 글자 상한, 텍스트만. system 역할 기록은 인수인계에서 제외한다. */
export function boundHandoffHistory(history: ChatHistoryEntry[]): ChatHistoryEntry[] {
  const usable = history.filter((m) => m.role !== "system" && typeof m.text === "string" && m.text.trim() !== "");
  const kept = usable.slice(-HANDOFF_MAX_MESSAGES);
  const rows = kept.map((m) => {
    const clean = stripHeavyContent(m.text);
    const text = clean.length > HANDOFF_MESSAGE_CHARS
      ? `${clean.slice(0, HANDOFF_MESSAGE_CHARS)} …[truncated]` : clean;
    return { ...m, text };
  });
  // Older messages that did not fit were dropped without a word; the first carried message now says how many (one line, only when something was dropped).
  const dropped = usable.length - kept.length;
  if (dropped > 0 && rows.length > 0) rows[0] = { ...rows[0], text: `[earlier messages not carried: ${dropped}]\n${rows[0].text}` };
  return rows;
}

export interface RotationReceipt {
  schemaVersion: "agentlas.runtime-thread-rotation.v1";
  chatId: string;
  previousThreadId: string;
  reasons: RotationReason[];
  health: ThreadHealth | null;
  reportedInputTokens: number | null;
  rotatedAt: string;
  /** G07: which runtime switched (absent on pre-overlay receipts). Same record for CLI threads and stateless API/local runtimes. */
  runtime?: string;
  /** G11: host-recorded facts the next generation sees ahead of any summary (handoff-facts.ts). */
  facts?: HostFacts;
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
