// 확인 요청(Request confirm) — "에이전트가 사용자 결정을 기다리는 채팅" 목록.
//
// 별도 런루프/CLI 훅 없이 DB에서 도출한다:
//   확인 대기 = 채팅의 "마지막 메시지가 미답변 질문 fence를 가진 assistant 메시지"인 경우.
//   사용자가 챗에서 답하면 후속 user 메시지가 쌓여 마지막이 더 이상 assistant가 아니게 되므로 자동 해소된다.
// fence 포맷은 renderer/lib/ask-question.ts와 동일: <<agentlas-ask>>{json}<</agentlas-ask>>.
import { createHash } from "node:crypto";
import {
  isUnfilledQuestionTemplate,
  QUESTION_CONTINUATION_REPLY_MAX_BYTES,
  QUESTION_CONTINUATION_REPLY_MAX_LENGTH,
  type CommittedQuestionAnswer,
  type McpInvocationRequest,
  type PendingConfirmation,
  type QuestionContinuationOptions,
} from "../../shared/types";
import { extractAskFences } from "../../shared/ask-fence-flatten";
import { getLastChatMessage, listRecentChats } from "../store/chats";
import { getDb } from "../store/db";
import { recordRunEvent, tryRecordRunEvent } from "../store/run-events";
import { ensureCanonicalTaskForChat } from "../store/tasks";
import { onDesktopStoreChange } from "../store/change-bus";
import { tryRecordOneDomainEvent } from "../one/domain-events";
import { getAgentById } from "../mcp/registry";
import { getFirm } from "../store/firms";

const OPEN = "<<agentlas-ask>>";
const claimedQuestionMessages = new Set<string>();

// 답변 확정 영수증 — "마지막 메시지" 휴리스틱의 보완 정본. 답장 user 메시지 persist는
// 실행 분기(그룹/펌/차용/Stormbreaker)마다 다른 지점에 있어 유실될 수 있으므로, 답변
// "제출 수락" 자체를 append-only 원장에 남겨 질문 해소를 실행 결과와 분리한다.
const ANSWER_RECEIPT_KIND = "question_answer_committed";
const SNOOZE_RECEIPT_KIND = "question_answer_snoozed";
const answerReceiptRunId = (chatId: string): string => `confirm:${chatId}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/;
const CANONICAL_REPLY_FIELD = "continuationReplyCanonicalBase64";
const CANONICAL_REPLY_MAX_BASE64_LENGTH = Math.ceil(QUESTION_CONTINUATION_REPLY_MAX_BYTES / 3) * 4;

interface DurableQuestionContinuation {
  runId: string;
  requestHash: string;
  request: McpInvocationRequest;
}

function questionContinuationRunId(chatId: string, sourceMessageId: string): string {
  const chars = createHash("sha256").update(`${chatId}\0${sourceMessageId}`).digest("hex").slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const value = chars.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function normalizeContinuationOptions(value?: QuestionContinuationOptions): QuestionContinuationOptions {
  const runtimeSelectionJson = value?.runtimeSelection ? JSON.stringify(value.runtimeSelection) : "";
  if (runtimeSelectionJson.length > 700) throw new Error("Decision continuation runtime selection is too large");
  const runtimeSelection = runtimeSelectionJson
    ? JSON.parse(runtimeSelectionJson) as QuestionContinuationOptions["runtimeSelection"]
    : undefined;
  return {
    ...(value?.locale === "ko" || value?.locale === "en" ? { locale: value.locale } : {}),
    ...(value?.permissions === "read" || value?.permissions === "write" || value?.permissions === "full"
      ? { permissions: value.permissions }
      : {}),
    ...(value?.sessionRouting === true ? { sessionRouting: true } : {}),
    ...(runtimeSelection ? { runtimeSelection } : {}),
  };
}

function continuationRequest(
  chatId: string,
  reply: string,
  options?: QuestionContinuationOptions,
): McpInvocationRequest {
  const normalized = normalizeContinuationOptions(options);
  return {
    chatId,
    userPrompt: reply,
    locale: normalized.locale,
    permissions: normalized.permissions,
    sessionRouting: normalized.sessionRouting,
    runtimeSelection: normalized.runtimeSelection,
  };
}

function continuationRequestHash(request: McpInvocationRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function continuationReplySha256(reply: string): string {
  return createHash("sha256").update(reply, "utf8").digest("hex");
}

function payloadContinuationReply(payload: Record<string, unknown>): string {
  if (Object.hasOwn(payload, CANONICAL_REPLY_FIELD)) {
    const encoded = payload[CANONICAL_REPLY_FIELD];
    if (
      typeof encoded !== "string"
      || encoded.length > CANONICAL_REPLY_MAX_BASE64_LENGTH
      || typeof payload.continuationReplySha256 !== "string"
      || !SHA256_RE.test(payload.continuationReplySha256)
    ) return "";
    const bytes = Buffer.from(encoded, "base64");
    if (
      bytes.length < 1
      || bytes.length > QUESTION_CONTINUATION_REPLY_MAX_BYTES
      || bytes.toString("base64") !== encoded
    ) return "";
    const reply = bytes.toString("utf8");
    if (
      reply.length < 1
      || reply.length > QUESTION_CONTINUATION_REPLY_MAX_LENGTH
      || !Buffer.from(reply, "utf8").equals(bytes)
      || continuationReplySha256(reply) !== payload.continuationReplySha256
    ) return "";
    return reply;
  }
  // Read compatibility for receipts written before the canonical Main-only
  // field existed. New writes never duplicate user text into these diagnostic
  // reply/chunk fields.
  if (Array.isArray(payload.continuationReplyChunks)) {
    const chunks = payload.continuationReplyChunks.filter((item): item is string => typeof item === "string");
    const reply = chunks.join("");
    if (reply.length > 0 && reply.length <= QUESTION_CONTINUATION_REPLY_MAX_LENGTH) return reply;
  }
  return typeof payload.reply === "string" && payload.reply.length <= QUESTION_CONTINUATION_REPLY_MAX_LENGTH
    ? payload.reply
    : "";
}

function payloadContinuationOptions(payload: Record<string, unknown>): QuestionContinuationOptions {
  let runtimeSelection: QuestionContinuationOptions["runtimeSelection"];
  if (typeof payload.continuationRuntimeSelectionJson === "string") {
    try {
      const parsed = JSON.parse(payload.continuationRuntimeSelectionJson) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        runtimeSelection = parsed as QuestionContinuationOptions["runtimeSelection"];
      }
    } catch {
      // Invalid binding fails hash verification below.
    }
  }
  return normalizeContinuationOptions({
    ...(payload.continuationLocale === "ko" || payload.continuationLocale === "en"
      ? { locale: payload.continuationLocale }
      : {}),
    ...(payload.continuationPermissions === "read"
      || payload.continuationPermissions === "write"
      || payload.continuationPermissions === "full"
      ? { permissions: payload.continuationPermissions }
      : {}),
    ...(payload.continuationSessionRouting === true ? { sessionRouting: true } : {}),
    ...(runtimeSelection ? { runtimeSelection } : {}),
  });
}

function approvalEventId(sourceMessageId: string): string {
  const digest = createHash("sha256").update(sourceMessageId).digest("hex").slice(0, 32);
  return `event:approval-resolved:${digest}`;
}

function decisionEntityId(sourceMessageId: string): string {
  const digest = createHash("sha256").update(sourceMessageId).digest("hex").slice(0, 32);
  return `decision:${digest}`;
}

function decisionOptionRef(reply: string): string {
  const digest = createHash("sha256").update(reply).digest("hex").slice(0, 24);
  return `option:${digest}`;
}

function latestDecisionSnooze(chatId: string, sourceMessageId: string): string | null {
  if (!chatId || !sourceMessageId) return null;
  try {
    const rows = getDb()
      .prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT 50")
      .all(answerReceiptRunId(chatId), SNOOZE_RECEIPT_KIND) as Array<{ payload_json: string }>;
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        if (payload.sourceMessageId !== sourceMessageId || typeof payload.resumeAt !== "string") continue;
        return Number.isFinite(Date.parse(payload.resumeAt)) ? payload.resumeAt : null;
      } catch {
        // A malformed diagnostic receipt cannot hide a live Decision.
      }
    }
  } catch {
    // Missing/locked ledger fails open: the pending Decision remains visible.
  }
  return null;
}

function firstQuestion(
  text: string,
): {
  question: string;
  header?: string;
  optionCount: number;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
} | null {
  const parsed = extractAskFences(text).questions[0];
  if (!parsed) return null;
  if (isUnfilledQuestionTemplate(parsed)) return null;
  return {
    question: parsed.question,
    header: parsed.header,
    optionCount: parsed.options.length,
    options: parsed.options,
    multiSelect: parsed.multiSelect,
  };
}

/** 채팅의 답변 확정 영수증들(오래된 순). 손상 행은 건너뛴다. */
export function listCommittedQuestionAnswers(chatId: string): CommittedQuestionAnswer[] {
  if (!chatId) return [];
  try {
    const rows = getDb()
      .prepare("SELECT ts, chat_id, payload_json FROM run_events WHERE run_id = ? AND kind = ? ORDER BY seq ASC")
      .all(answerReceiptRunId(chatId), ANSWER_RECEIPT_KIND) as Array<{ ts: string; chat_id: string | null; payload_json: string }>;
    const out: CommittedQuestionAnswer[] = [];
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        if (row.chat_id !== chatId || typeof payload.sourceMessageId !== "string" || !payload.sourceMessageId) continue;
        const reply = payloadContinuationReply(payload);
        if (Object.hasOwn(payload, CANONICAL_REPLY_FIELD)) {
          if (
            !reply
            || typeof payload.continuationRunId !== "string"
            || !UUID_RE.test(payload.continuationRunId)
            || payload.continuationRunId !== questionContinuationRunId(chatId, payload.sourceMessageId)
            || typeof payload.continuationRequestHash !== "string"
            || !SHA256_RE.test(payload.continuationRequestHash)
            || continuationRequestHash(continuationRequest(chatId, reply, payloadContinuationOptions(payload)))
              !== payload.continuationRequestHash
          ) continue;
        }
        out.push({
          sourceMessageId: payload.sourceMessageId,
          reply,
          ts: row.ts,
          ...(typeof payload.continuationRunId === "string" && UUID_RE.test(payload.continuationRunId)
            ? { continuationRunId: payload.continuationRunId }
            : {}),
        });
      } catch {
        // 손상된 영수증 하나가 목록 전체를 죽여선 안 된다.
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 이미 수락된 답변의 영수증 기록 — 검증은 호출자(commit/모바일 claim 경로)가 끝냈다. */
export function recordCommittedAnswerReceipt(
  chatId: string,
  sourceMessageId: string,
  reply: string,
): void {
  tryRecordRunEvent({
    runId: answerReceiptRunId(chatId),
    kind: ANSWER_RECEIPT_KIND,
    chatId,
    // Mobile already owns the accepted invocation/user turn. Keep only a
    // diagnostic equality digest here; raw answer bytes are neither needed nor
    // exposed through the broadly readable run ledger.
    payload: { sourceMessageId, replySha256: continuationReplySha256(reply) },
  });
}

/**
 * Desktop 바텀시트가 답변을 제출한 순간 호출 — 지금 대기 중인 정확한 질문을 확인하고
 * 확정 영수증을 남긴다. 이후 후속 실행이 어떤 분기로 빠지든 이 질문은 다시 뜨지 않는다.
 */
export function commitPendingConfirmationAnswer(
  chatId: string,
  reply: string,
  sourceMessageId?: string,
  continuation?: QuestionContinuationOptions,
): { chatId: string; sourceMessageId: string; continuationRunId: string } {
  const last = getLastChatMessage(chatId);
  if (
    !last ||
    (sourceMessageId && last.id !== sourceMessageId) ||
    last.role !== "assistant" ||
    !last.text.includes(OPEN) ||
    !firstQuestion(last.text)
  ) {
    throw new Error("Question is stale or no longer pending");
  }
  const normalizedReply = reply.trim();
  if (!normalizedReply) throw new Error("Decision response is empty");
  if (normalizedReply.length > QUESTION_CONTINUATION_REPLY_MAX_LENGTH) {
    throw new Error(`Decision response exceeds the ${QUESTION_CONTINUATION_REPLY_MAX_LENGTH} character limit`);
  }
  const existing = listCommittedQuestionAnswers(chatId)
    .filter((receipt) => receipt.sourceMessageId === last.id)
    .at(-1);
  if (existing) {
    // The renderer can lose the IPC reply after Main committed it. Retrying the
    // exact answer is acknowledgement recovery, not a second user decision.
    if (existing.reply !== normalizedReply) throw new Error("This question answer was already accepted");
    if (existing.continuationRunId) {
      claimedQuestionMessages.add(`${chatId}\0${last.id}`);
      return { chatId, sourceMessageId: last.id, continuationRunId: existing.continuationRunId };
    }
  }
  if (!existing && claimedQuestionMessages.has(`${chatId}\0${last.id}`)) {
    throw new Error("This question answer was already accepted");
  }
  const continuationRunId = questionContinuationRunId(chatId, last.id);
  const request = continuationRequest(chatId, normalizedReply, continuation);
  const normalizedContinuation = normalizeContinuationOptions(continuation);
  // Unlike the Mobile helper's best-effort diagnostic write, Desktop commit is
  // an acknowledgement boundary: never close the sheet without durable bytes.
  recordRunEvent({
    runId: answerReceiptRunId(chatId),
    kind: ANSWER_RECEIPT_KIND,
    chatId,
    payload: {
      sourceMessageId: last.id,
      [CANONICAL_REPLY_FIELD]: Buffer.from(normalizedReply, "utf8").toString("base64"),
      continuationReplySha256: continuationReplySha256(normalizedReply),
      continuationRunId,
      continuationLocale: normalizedContinuation.locale,
      continuationPermissions: normalizedContinuation.permissions,
      continuationSessionRouting: normalizedContinuation.sessionRouting,
      continuationRuntimeSelectionJson: normalizedContinuation.runtimeSelection
        ? JSON.stringify(normalizedContinuation.runtimeSelection)
        : undefined,
      continuationRequestHash: continuationRequestHash(request),
    },
  });
  claimedQuestionMessages.add(`${chatId}\0${last.id}`);
  invalidatePendingConfirmationsCache();
  // A committed user answer is the real approval-resolution boundary. This
  // evidence does not imply that an external action or outcome subsequently ran.
  const task = ensureCanonicalTaskForChat(chatId);
  if (task) {
    tryRecordOneDomainEvent({
      eventId: approvalEventId(last.id),
      eventType: "approval.resolved",
      actor: "user",
      entityId: decisionEntityId(last.id),
      ...(task.projectId ? { projectId: task.projectId } : {}),
      taskId: task.id,
      version: 1,
      visibility: task.projectId ? "project" : "personal",
      entries: [
        { name: "decisionId", value: last.id },
        { name: "selectedOption", value: decisionOptionRef(normalizedReply) },
        { name: "actor", value: "user" },
      ],
    });
  }
  return { chatId, sourceMessageId: last.id, continuationRunId };
}

/** Main-only exact request bound to the accepted source question and answer. */
export function getCommittedQuestionContinuation(
  chatId: string,
  sourceMessageId: string,
  reply: string,
): DurableQuestionContinuation | null {
  const normalizedReply = reply.trim();
  if (
    !chatId
    || !sourceMessageId
    || !normalizedReply
    || normalizedReply.length > QUESTION_CONTINUATION_REPLY_MAX_LENGTH
  ) return null;
  const rows = getDb()
    .prepare("SELECT chat_id, payload_json FROM run_events WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT 100")
    .all(answerReceiptRunId(chatId), ANSWER_RECEIPT_KIND) as Array<{ chat_id: string | null; payload_json: string }>;
  for (const row of rows) {
    if (row.chat_id !== chatId) continue;
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(row.payload_json) as Record<string, unknown>; } catch { continue; }
    if (payload.sourceMessageId !== sourceMessageId || payloadContinuationReply(payload) !== normalizedReply) continue;
    if (typeof payload.continuationRunId !== "string" || !UUID_RE.test(payload.continuationRunId)) return null;
    if (
      Object.hasOwn(payload, CANONICAL_REPLY_FIELD)
      && payload.continuationRunId !== questionContinuationRunId(chatId, sourceMessageId)
    ) return null;
    const request = continuationRequest(chatId, normalizedReply, payloadContinuationOptions(payload));
    if (
      typeof payload.continuationRequestHash !== "string"
      || payload.continuationRequestHash !== continuationRequestHash(request)
    ) return null;
    return {
      runId: payload.continuationRunId,
      requestHash: payload.continuationRequestHash,
      request: { ...request, runId: payload.continuationRunId },
    };
  }
  return null;
}

/** A not-yet-started intent may run only while its exact Decision is still current. */
export function committedQuestionContinuationIsCurrent(chatId: string, sourceMessageId: string): boolean {
  const last = getLastChatMessage(chatId);
  return Boolean(
    last
    && last.id === sourceMessageId
    && last.role === "assistant"
    && firstQuestion(last.text),
  );
}

/**
 * Append-only One presentation preference for the exact current Decision.
 * Snoozing never resolves, claims, approves, or executes the question.
 */
export function snoozePendingConfirmation(
  chatId: string,
  sourceMessageId: string,
  resumeAt: string,
): { chatId: string; sourceMessageId: string; snoozedUntil: string } {
  const resumeTime = Date.parse(resumeAt);
  const now = Date.now();
  if (!Number.isFinite(resumeTime) || resumeTime < now + 60_000 || resumeTime > now + 30 * 24 * 60 * 60 * 1_000) {
    throw new Error("Decision snooze must be between 1 minute and 30 days");
  }
  const last = getLastChatMessage(chatId);
  if (
    !last
    || last.id !== sourceMessageId
    || last.role !== "assistant"
    || !last.text.includes(OPEN)
    || !firstQuestion(last.text)
    || listCommittedQuestionAnswers(chatId).some((receipt) => receipt.sourceMessageId === sourceMessageId)
  ) {
    throw new Error("Question is stale or no longer pending");
  }
  const snoozedUntil = new Date(resumeTime).toISOString();
  if (latestDecisionSnooze(chatId, sourceMessageId) !== snoozedUntil) {
    recordRunEvent({
      runId: answerReceiptRunId(chatId),
      kind: SNOOZE_RECEIPT_KIND,
      chatId,
      payload: { sourceMessageId, resumeAt: snoozedUntil },
    });
    invalidatePendingConfirmationsCache();
  }
  return { chatId, sourceMessageId, snoozedUntil };
}

// listPendingConfirmations는 호출당 수십 개의 동기 쿼리를 실행하는데, 독립 폴러
// 셋(AppShell·대시보드 위젯·태스크 투영 빌더)이 3초 간격으로 겹쳐 부른다.
// 신선도는 TTL이 아니라 무효화가 지킨다 — 새 질문 도착(챗 쓰기)과 이 파일 안의
// 상태 변화(답 확정·클레임·스누즈)가 모두 즉시 무효화하므로, TTL은 폴 간격보다
// 길게 잡아 무변경 틱의 DB 팬아웃을 캐시로 흡수한다. (1초였을 때는 3초 폴이
// 캐시에 한 번도 못 맞아 캐시가 장식이었다.)
const PENDING_CONFIRMATIONS_TTL_MS = 30_000;
let pendingConfirmationsCache: { at: number; items: PendingConfirmation[] } | null = null;

function invalidatePendingConfirmationsCache(): void {
  pendingConfirmationsCache = null;
}

// A time-only cache can return a false empty state when a question is appended
// within the same second as a snapshot read. Chat writes already publish this
// content-free invalidation signal, so keep the cache fast without delaying a
// newly created Desktop decision on Mobile.
onDesktopStoreChange((change) => {
  if (change.entity === "chat") invalidatePendingConfirmationsCache();
});

/** 지금 사용자 확인을 기다리는 채팅들. 최신순. */
export function listPendingConfirmations(): PendingConfirmation[] {
  const cached = pendingConfirmationsCache;
  if (cached && Date.now() - cached.at < PENDING_CONFIRMATIONS_TTL_MS) {
    return cached.items.map((item) => ({ ...item }));
  }
  const out: PendingConfirmation[] = [];
  for (const c of listRecentChats(40)) {
    if (c.archivedAt) continue;
    const last = getLastChatMessage(c.id);
    if (!last || last.role !== "assistant") continue;
    if (!last.text.includes(OPEN)) continue;
    const q = firstQuestion(last.text);
    if (!q) continue;
    // A committed answer is no longer an unanswered confirmation.  Continuation
    // recovery reads the exact receipt through `committedAnswers` and must not
    // reuse this pending-question projection as a second question surface.
    if (listCommittedQuestionAnswers(c.id).some((answer) => answer.sourceMessageId === last.id)) continue;
    // A committed answer without a later user turn is handled by the separate
    // committedAnswers/continuation-recovery projection above; this list stays
    // limited to questions that still need a user decision.
    const snoozedUntil = latestDecisionSnooze(c.id, last.id);
    const firm = c.firmId ? getFirm(c.firmId) : null;
    const agent = getAgentById(c.agentId);
    const requesterLabel = firm?.name || agent?.name || c.title;
    const requesterKind = firm ? "firm" : "agent";
    out.push({
      chatId: c.id,
      sourceMessageId: last.id,
      chatTitle: c.title,
      question: q.question,
      header: q.header,
      optionCount: q.optionCount,
      options: q.options,
      multiSelect: q.multiSelect,
      agentId: c.agentId,
      firmId: c.firmId,
      requesterLabel,
      requesterKind,
      createdAt: last.createdAt,
      ...(snoozedUntil && Date.parse(snoozedUntil) > Date.now() ? { snoozedUntil } : {}),
    });
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const stillPending = new Set(out.map((item) => `${item.chatId}\0${item.sourceMessageId}`));
  for (const claimed of claimedQuestionMessages) {
    if (!stillPending.has(claimed)) claimedQuestionMessages.delete(claimed);
  }
  pendingConfirmationsCache = { at: Date.now(), items: out };
  return out.map((item) => ({ ...item }));
}

/**
 * Atomically claims the exact latest question before Mobile starts/steers an
 * answer. The returned rollback is used only when the synchronous invocation
 * admission itself fails. Accepted answers remain claimed so two phones cannot
 * submit the same irreversible choice before the user message is persisted.
 */
export function claimPendingConfirmationAnswer(
  chatId: string,
  sourceMessageId: string,
): () => void {
  const key = `${chatId}\0${sourceMessageId}`;
  if (claimedQuestionMessages.has(key)) {
    throw new Error("This question answer was already accepted");
  }
  const last = getLastChatMessage(chatId);
  if (
    !last ||
    last.id !== sourceMessageId ||
    last.role !== "assistant" ||
    !last.text.includes(OPEN) ||
    !firstQuestion(last.text)
  ) {
    throw new Error("Question is stale or no longer pending");
  }
  // A successful Mobile admission seals a digest-only receipt after claiming.
  // On process restart the in-memory claim set is empty, so consult that
  // durable source binding before admitting the same irreversible Decision.
  if (listCommittedQuestionAnswers(chatId).some((receipt) => receipt.sourceMessageId === sourceMessageId)) {
    throw new Error("This question answer was already accepted");
  }
  claimedQuestionMessages.add(key);
  invalidatePendingConfirmationsCache();
  if (claimedQuestionMessages.size > 10_000) {
    const oldest = claimedQuestionMessages.values().next().value as string | undefined;
    if (oldest && oldest !== key) claimedQuestionMessages.delete(oldest);
  }
  return () => {
    claimedQuestionMessages.delete(key);
    invalidatePendingConfirmationsCache();
  };
}
