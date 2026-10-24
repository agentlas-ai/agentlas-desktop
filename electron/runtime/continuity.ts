// 대화 연속성 헬퍼 — 어떤 러너/경로로 실행돼도 "같은 대화"가 유지되게 하는 공용 모듈.
//
// 두 가지 문제를 함께 푼다:
//  1) CLI 세션을 이어갈 수 없어 히스토리를 텍스트로 재주입할 때, 모델이 그 기록을
//     "이전 세션/다른 대화"로 취급하지 않도록 연속성 프레이밍을 붙인다.
//  2) 재주입 히스토리가 무한히 자라지 않도록 compactHistory로 오래된 턴만 요약 다이제스트로
//     접는다 — "컨텍스트가 찼을 때만 압축, 그 외 전부 원문 유지" 계약의 구현.
import type { ChatHistoryEntry } from "../../shared/types";
import { tStatus, type RuntimeLocale } from "./status-i18n";
import { compactHistory } from "./compact";
import { createHash } from "node:crypto";
import { GENERATION_SEED_RATIO, runtimeContextWindow } from "./session-generation";

/**
 * DEGRADED VALUE — used ONLY when the selected model's verified window W is unknown. It is the former fixed constant,
 * kept as the declared "unknown window" capability exception; a known W never reaches it (cliHistoryContextTokens).
 */
export const CLI_HISTORY_CONTEXT_TOKENS_UNKNOWN_WINDOW = 120_000;

/** Output + provider/tool framing reserve for the seed turn: a fraction of W, bounded so a 1M window does not reserve 100k. */
export const CLI_HISTORY_OUTPUT_RESERVE_RATIO = 0.1;
export const CLI_HISTORY_OUTPUT_RESERVE_MAX_TOKENS = 32_768;
export const CLI_HISTORY_OUTPUT_RESERVE_MIN_TOKENS = 1_024;

export interface CliHistoryBudget {
  /** Window the budget derives from; null = unknown (degraded value used). */
  windowTokens: number | null;
  /** Tokens set aside for the model's answer and framing — NOT available to replayed history. */
  outputReserveTokens: number;
  /** Admission budget for the replayed-history seed (input side only): half the 80% rotation point, minus the reserve. */
  admissionTokens: number;
  source: "verified-window" | "unknown-window-degraded";
}

/** Pure: admission budget and output reserve for a window W (null/invalid = unknown). */
export function cliHistoryBudgetForWindow(windowTokens: number | null | undefined): CliHistoryBudget {
  if (typeof windowTokens !== "number" || !Number.isFinite(windowTokens) || windowTokens <= 0) {
    return { windowTokens: null, outputReserveTokens: 0, admissionTokens: CLI_HISTORY_CONTEXT_TOKENS_UNKNOWN_WINDOW, source: "unknown-window-degraded" };
  }
  const w = Math.floor(windowTokens);
  const outputReserveTokens = Math.min(w, Math.min(CLI_HISTORY_OUTPUT_RESERVE_MAX_TOKENS,
    Math.max(CLI_HISTORY_OUTPUT_RESERVE_MIN_TOKENS, Math.floor(w * CLI_HISTORY_OUTPUT_RESERVE_RATIO))));
  // A fresh seed starts well below the rotation point (GENERATION_CONTEXT_RATIO of W): at most half of it
  // (GENERATION_SEED_RATIO), or the new generation's first turns rotate again and resend an uncached prefix each time.
  const admissionTokens = Math.max(0, Math.floor(w * GENERATION_SEED_RATIO) - outputReserveTokens);
  return { windowTokens: w, outputReserveTokens, admissionTokens, source: "verified-window" };
}

/** Replayed-history budget for the selected runtime/model: derives from its verified window; unknown W → degraded value. */
export function cliHistoryContextTokens(kind: string, model: string | null | undefined): number {
  return cliHistoryBudgetForWindow(runtimeContextWindow(kind, model)).admissionTokens;
}

/** 스웜 워커/신시사이저에 주입하는 대화 컨텍스트 예산 — 워커 수만큼 곱해지므로 보수적으로. */
export const SWARM_HISTORY_CONTEXT_TOKENS = 8_000;

function continuityNote(_locale?: RuntimeLocale): string {
  return "transcript below = this live conversation; continue as the assistant from its start; never call it a previous session";
}

export interface ConversationContextResult {
  /** 완성된 히스토리 블록(헤더 + 연속성 노트 + 필요 시 다이제스트 + 최근 원문). 히스토리가 없으면 "". */
  block: string;
  /** 다이제스트로 접힌 과거 메시지 수 — 0이면 전부 원문 유지. */
  droppedCount: number;
}

/**
 * 히스토리를 연속성 프레이밍이 붙은 단일 텍스트 블록으로 렌더링한다.
 * 예산(contextWindowTokens)을 넘길 때만 오래된 턴을 다이제스트로 접고, 그 외에는 원문 유지.
 */
export function renderConversationContext(
  history: ChatHistoryEntry[],
  locale: RuntimeLocale,
  contextWindowTokens: number,
): ConversationContextResult {
  if (history.length === 0) return { block: "", droppedCount: 0 };
  const { recent, digest, droppedCount } = compactHistory(history, {
    contextWindow: contextWindowTokens,
    locale,
  });
  const user = tStatus(locale, "speakerUser");
  const assistant = tStatus(locale, "speakerAssistant");
  const lines = recent.map((m) => `${m.role === "user" ? user : assistant}: ${m.text}`);
  // Composition order: fixed → variable (docs/PROMPT-COMPOSITION-POLICY.md, ledger desktop.main.continuity.render-conversation-context).
  const parts: string[] = [tStatus(locale, "histPrev"), continuityNote(locale), ""];
  if (digest) parts.push(digest, "");
  parts.push(lines.join("\n\n"));
  return { block: parts.join("\n"), droppedCount };
}

/** 스웜/Ollama 등 다른 경로 턴의 gap-replay에 허용하는 컨텍스트 예산(토큰). */
export const GAP_HISTORY_CONTEXT_TOKENS = 16_000;

/**
 * 세션이 마지막으로 본 시점(sessionUpdatedAt) 이후에 쌓인 메시지들 — 같은 채팅이
 * 스웜/Ollama 등 다른 실행 경로로 진행한 턴들이다. resume 세션의 컨텍스트에는 없으므로
 * gap-replay로 메워야 "어떤 경로로 빠져도" 대화가 유지된다.
 */
export function unseenHistoryGap(
  history: ChatHistoryEntry[],
  sessionUpdatedAt: string | null | undefined,
): ChatHistoryEntry[] {
  if (!sessionUpdatedAt) return [];
  // ISO 8601 문자열은 사전순 비교가 시간순 비교와 일치한다. 밀리초가 같은 메시지는
  // 누락보다 한 번 더 전달하는 편이 안전하므로 경계를 포함한다(at-least-once replay).
  return history.filter((m) => m.createdAt && m.createdAt >= sessionUpdatedAt);
}

/** gap 메시지들을 resume 턴에 실을 블록으로 렌더링한다. 없으면 "". */
export function renderGapContext(
  gap: ChatHistoryEntry[],
  locale: RuntimeLocale,
): string {
  if (gap.length === 0) return "";
  const intro = "since your last reply, turns below ran via another path (swarm/another runner); same conversation:";
  const { block } = renderConversationContext(gap, locale, GAP_HISTORY_CONTEXT_TOKENS);
  return `${intro}\n${block}`;
}

/**
 * 세션 resume 턴의 사용자 메시지를 구성한다 — 호스트가 이번 턴에만 주는 배경 컨텍스트
 * (메모리 캡슐·온톨로지·MCP 선택 등)를 사용자 메시지 앞에 명확히 구분해 싣는다.
 * resume에서는 시스템 프롬프트가 재전송되지 않으므로 이 경로가 유일한 전달 수단이다.
 */
export function composeResumeTurnPrompt(
  userPrompt: string,
  turnContext: string | undefined,
  locale: RuntimeLocale,
): string {
  const ctx = turnContext?.trim();
  if (!ctx) return userPrompt;
  const header = "── Turn context (host background; not the user's message; never quote) ──";
  return [header, ctx, "", tStatus(locale, "histThis"), userPrompt].join("\n");
}


/**
 * resume 턴의 턴 컨텍스트에서 "이 세션에 최근 보낸 그대로인 블록"을 뺀다.
 *
 * 왜: 기억 이벤트 규약·목표 계약·대기 규약처럼 세션 내내 같은 블록이 매 턴 사용자 메시지에 실려,
 * 20턴 세션이면 같은 규약 사본 20벌이 기록에 쌓였다(턴당 3~4KB). 모델은 앞 턴의 사본을 이미 갖고 있다.
 * Typed native compaction invalidates retained contracts explicitly. Other transports
 * conservatively resend every STABLE_RESEND_EVERY acknowledged turns.
 * 기억은 프로세스 메모리뿐이라 앱을 다시 켜면 한 번 더 보낼 뿐이다(손해 없음).
 * Prompt preparation is read-only. Only a native protocol acknowledgement may
 * commit delivery or advance the resend cadence; process/thread init is not delivery.
 * This cache governs stable host text only, never history replay or external effects.
 */
const STABLE_RESEND_EVERY = 8;
const STABLE_SESSIONS_MAX = 500;
const stableSent = new Map<string, { turn: number; sent: Map<string, number>; acknowledgementId: string; generation: number }>();
const stableInvalidations = new Map<string, number>();
let stableInvalidationSerial = 0;
let forgottenInvalidationGeneration = 0;
const nativeRetentionEpochs = new Map<string, number>();
let nativeRetentionSerial = 0;

export interface StableTurnContextIdentity {
  chatId?: string | null;
  runtimeKind: string;
  sessionId: string;
  /** Exact owner/config identity, separate from the continuity fingerprint. */
  contextFingerprint: string;
}
export interface StableTurnContextDelivery {
  readonly identity: StableTurnContextIdentity;
  readonly key: string;
  readonly generation: number;
  readonly confirmedTurns: number;
  readonly includedHashes: readonly string[];
}
function stableContextKey(input: StableTurnContextIdentity): string {
  return JSON.stringify([input.chatId ?? "", input.runtimeKind, input.sessionId, input.contextFingerprint]);
}
function stableContextScope(input: Omit<StableTurnContextIdentity, "contextFingerprint">): string {
  return JSON.stringify([input.chatId ?? "", input.runtimeKind, input.sessionId]);
}
/** Only adapters with typed context-loss observation may confirm host ACK reuse. */
export function nativeStableTurnContextEpoch(input: Omit<StableTurnContextIdentity, "contextFingerprint">, establish = false): number | undefined {
  if (!input.sessionId || (input.runtimeKind !== "codex" && input.runtimeKind !== "claude-code")) return undefined;
  const scope = stableContextScope(input);
  if (establish && !nativeRetentionEpochs.has(scope)) {
    nativeRetentionEpochs.set(scope, ++nativeRetentionSerial);
    while (nativeRetentionEpochs.size > STABLE_SESSIONS_MAX) nativeRetentionEpochs.delete(nativeRetentionEpochs.keys().next().value as string);
  }
  return nativeRetentionEpochs.get(scope);
}
function stableContextGeneration(input: Omit<StableTurnContextIdentity, "contextFingerprint">): number {
  return stableInvalidations.get(stableContextScope(input)) ?? forgottenInvalidationGeneration;
}
export function dedupeStableTurnContext(input: {
  chatId?: string | null; runtimeKind: string; sessionId: string; contextFingerprint?: string;
  turnContext?: string; stableBlocks?: readonly string[];
  /** Opt in only when the adapter observes typed native compaction/replacement. */
  retention?: "native-compaction";
}): { text: string; skipped: number; savedBytes: number; delivery?: StableTurnContextDelivery } {
  const text = input.turnContext ?? "";
  if (!text.trim() || !input.stableBlocks?.length || !input.sessionId || !input.contextFingerprint) return { text, skipped: 0, savedBytes: 0 };
  const identity: StableTurnContextIdentity = { chatId: input.chatId, runtimeKind: input.runtimeKind,
    sessionId: input.sessionId, contextFingerprint: input.contextFingerprint };
  const key = stableContextKey(identity);
  const generation = stableContextGeneration(identity);
  const storedRecord = stableSent.get(key);
  const record = storedRecord?.generation === generation ? storedRecord : undefined;
  const turn = (record?.turn ?? 0) + 1;
  const includedHashes: string[] = [];
  let out = text, skipped = 0, savedBytes = 0;
  for (const block of input.stableBlocks) {
    const b = block.trim();
    if (!b || !out.includes(b)) continue;
    const hash = createHash("sha256").update(b).digest("hex").slice(0, 24);
    const last = record?.sent.get(hash);
    if (last !== undefined && (input.retention === "native-compaction" || turn - last < STABLE_RESEND_EVERY)) {
      out = out.replace(b, ""); skipped += 1; savedBytes += Buffer.byteLength(b);
    } else {
      includedHashes.push(hash);
    }
  }
  return { text: out.replace(/\n{3,}/g, "\n\n").trim(), skipped, savedBytes,
    delivery: { identity, key, generation, confirmedTurns: record?.turn ?? 0, includedHashes } };
}

/** Called only after the adapter binds a native turn receipt to this dispatched prompt. */
export function acknowledgeStableTurnContext(delivery: StableTurnContextDelivery | undefined,
  receipt: { sessionId: string; acknowledgementId: string }): boolean {
  if (!delivery || receipt.sessionId !== delivery.identity.sessionId || !receipt.acknowledgementId.trim()
    || delivery.generation !== stableContextGeneration(delivery.identity)) return false;
  let record = stableSent.get(delivery.key);
  if (record?.generation !== delivery.generation) record = undefined;
  if (record?.acknowledgementId === receipt.acknowledgementId) return false;
  if ((record?.turn ?? 0) !== delivery.confirmedTurns) return false;
  if (!record) {
    if (stableSent.size >= STABLE_SESSIONS_MAX) { const oldest = stableSent.keys().next(); if (!oldest.done) stableSent.delete(oldest.value); }
    record = { turn: 0, sent: new Map(), acknowledgementId: "", generation: delivery.generation }; stableSent.set(delivery.key, record);
  }
  record.turn += 1;
  record.acknowledgementId = receipt.acknowledgementId;
  for (const hash of delivery.includedHashes) record.sent.set(hash, record.turn);
  return true;
}

/** Typed compaction/replacement invalidates every config view of this native identity. */
export function invalidateStableTurnContext(input: Omit<StableTurnContextIdentity, "contextFingerprint">, nativeContextLost = false): void {
  const scope = stableContextScope(input);
  if (nativeContextLost) {
    nativeRetentionEpochs.delete(scope);
  }
  if (!stableInvalidations.has(scope) && stableInvalidations.size >= STABLE_SESSIONS_MAX) {
    const oldest = stableInvalidations.keys().next();
    if (!oldest.done) stableInvalidations.delete(oldest.value);
    // Forgotten invalidations must not allow an old pending acknowledgement to
    // resurrect delivery. Only scopes without retained generation evidence resend.
    forgottenInvalidationGeneration = ++stableInvalidationSerial;
  }
  stableInvalidations.set(scope, ++stableInvalidationSerial);
  for (const key of stableSent.keys()) {
    const [chatId, runtimeKind, sessionId] = JSON.parse(key) as string[];
    if (chatId === (input.chatId ?? "") && runtimeKind === input.runtimeKind && sessionId === input.sessionId) stableSent.delete(key);
  }
}
