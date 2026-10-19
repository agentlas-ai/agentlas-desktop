






import type { ChatHistoryEntry } from "../../shared/types";
import type { HostFacts } from "./handoff-facts";

/** 인수인계에 싣는 최근 대화 예산(토큰). 목표 계약/계획은 turnContext가 따로 싣는다. */
export const HANDOFF_HISTORY_TOKENS = 6_000;
/** 인수인계 메시지 한 건 글자 상한 — 도구 덤프/로그가 섞여 들어오는 것을 막는다. */
export const HANDOFF_MESSAGE_CHARS = 1_200;
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
  const kept = history.filter((m) => m.role !== "system" && typeof m.text === "string" && m.text.trim() !== "")
    .slice(-HANDOFF_MAX_MESSAGES);
  return kept.map((m) => {
    const clean = stripHeavyContent(m.text);
    const text = clean.length > HANDOFF_MESSAGE_CHARS
      ? `${clean.slice(0, HANDOFF_MESSAGE_CHARS)} …[truncated]` : clean;
    return { ...m, text };
  });
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
