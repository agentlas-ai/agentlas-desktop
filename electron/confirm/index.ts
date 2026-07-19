// 확인 요청(Request confirm) — "에이전트가 사용자 결정을 기다리는 채팅" 목록.
//
// 별도 런루프/CLI 훅 없이 DB에서 도출한다:
//   확인 대기 = 채팅의 "마지막 메시지가 미답변 질문 fence를 가진 assistant 메시지"인 경우.
//   사용자가 챗에서 답하면 후속 user 메시지가 쌓여 마지막이 더 이상 assistant가 아니게 되므로 자동 해소된다.
// fence 포맷은 renderer/lib/ask-question.ts와 동일: <<agentlas-ask>>{json}<</agentlas-ask>>.
import { createHash } from "node:crypto";
import type { CommittedQuestionAnswer, PendingConfirmation } from "../../shared/types";
import { getLastChatMessage, listRecentChats } from "../store/chats";
import { getDb } from "../store/db";
import { recordRunEvent, tryRecordRunEvent } from "../store/run-events";
import { ensureCanonicalTaskForChat } from "../store/tasks";
import { tryRecordOneDomainEvent } from "../one/domain-events";

const OPEN = "<<agentlas-ask>>";
const CLOSE = "<</agentlas-ask>>";
const claimedQuestionMessages = new Set<string>();

// 답변 확정 영수증 — "마지막 메시지" 휴리스틱의 보완 정본. 답장 user 메시지 persist는
// 실행 분기(그룹/펌/차용/Stormbreaker)마다 다른 지점에 있어 유실될 수 있으므로, 답변
// "제출 수락" 자체를 append-only 원장에 남겨 질문 해소를 실행 결과와 분리한다.
const ANSWER_RECEIPT_KIND = "question_answer_committed";
const SNOOZE_RECEIPT_KIND = "question_answer_snoozed";
const answerReceiptRunId = (chatId: string): string => `confirm:${chatId}`;

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
  const open = text.indexOf(OPEN);
  if (open < 0) return null;
  const after = text.slice(open + OPEN.length);
  const close = after.indexOf(CLOSE);
  if (close < 0) return null; // 닫는 fence 없음 = 스트리밍 중 미완성 → 대기 아님
  let body = after.slice(0, close).trim();
  body = body
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    const question = typeof parsed.question === "string" ? parsed.question.trim() : "";
    if (!question) return null;
    const optionsRaw = Array.isArray(parsed.options) ? parsed.options : [];
    const options = optionsRaw
      .flatMap((option) => {
        if (!option || typeof option !== "object") return [];
        const raw = option as Record<string, unknown>;
        const label = typeof raw.label === "string" ? raw.label.trim() : "";
        if (!label) return [];
        const description = typeof raw.description === "string" ? raw.description.trim() : "";
        return [{
          label: label.slice(0, 200),
          ...(description ? { description: description.slice(0, 1_000) } : {}),
        }];
      })
      .slice(0, 8);
    if (options.length < 2) return null;
    return {
      question: question.slice(0, 4_000),
      header: typeof parsed.header === "string" ? parsed.header.trim().slice(0, 200) || undefined : undefined,
      optionCount: options.length,
      options,
      multiSelect: parsed.multiSelect === true,
    };
  } catch {
    return null;
  }
}

/** 채팅의 답변 확정 영수증들(오래된 순). 손상 행은 건너뛴다. */
export function listCommittedQuestionAnswers(chatId: string): CommittedQuestionAnswer[] {
  if (!chatId) return [];
  try {
    const rows = getDb()
      .prepare("SELECT ts, payload_json FROM run_events WHERE run_id = ? AND kind = ? ORDER BY seq ASC")
      .all(answerReceiptRunId(chatId), ANSWER_RECEIPT_KIND) as Array<{ ts: string; payload_json: string }>;
    const out: CommittedQuestionAnswer[] = [];
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        if (typeof payload.sourceMessageId !== "string" || !payload.sourceMessageId) continue;
        out.push({
          sourceMessageId: payload.sourceMessageId,
          reply: typeof payload.reply === "string" ? payload.reply : "",
          ts: row.ts,
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
    payload: { sourceMessageId, reply: reply.slice(0, 4_000) },
  });
}

/**
 * Desktop 바텀시트가 답변을 제출한 순간 호출 — 지금 대기 중인 정확한 질문을 확인하고
 * 확정 영수증을 남긴다. 이후 후속 실행이 어떤 분기로 빠지든 이 질문은 다시 뜨지 않는다.
 */
export function commitPendingConfirmationAnswer(
  chatId: string,
  reply: string,
): { chatId: string; sourceMessageId: string } {
  const last = getLastChatMessage(chatId);
  if (
    !last ||
    last.role !== "assistant" ||
    !last.text.includes(OPEN) ||
    !firstQuestion(last.text)
  ) {
    throw new Error("Question is stale or no longer pending");
  }
  // 이미 확정(영수증)됐거나 다른 표면(모바일)이 클레임한 답변의 중복 제출은 되돌릴 수
  // 없는 선택을 두 번 실행시킬 수 있으므로 조용히 통과시키지 않는다.
  if (
    claimedQuestionMessages.has(`${chatId}\0${last.id}`) ||
    listCommittedQuestionAnswers(chatId).some((r) => r.sourceMessageId === last.id)
  ) {
    throw new Error("This question answer was already accepted");
  }
  const normalizedReply = reply.trim().slice(0, 4_000);
  if (!normalizedReply) throw new Error("Decision response is empty");
  recordCommittedAnswerReceipt(chatId, last.id, normalizedReply);
  claimedQuestionMessages.add(`${chatId}\0${last.id}`);
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
  return { chatId, sourceMessageId: last.id };
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
  }
  return { chatId, sourceMessageId, snoozedUntil };
}

/** 지금 사용자 확인을 기다리는 채팅들. 최신순. */
export function listPendingConfirmations(): PendingConfirmation[] {
  const out: PendingConfirmation[] = [];
  for (const c of listRecentChats(40)) {
    if (c.archivedAt) continue;
    const last = getLastChatMessage(c.id);
    if (!last || last.role !== "assistant") continue;
    if (!last.text.includes(OPEN)) continue;
    const q = firstQuestion(last.text);
    if (!q) continue;
    // 답변 확정 영수증이 있으면 이미 답한 질문 — 후속 user 메시지가 아직(또는 영영)
    // 안 쌓였어도 대기 목록/배지에 다시 올리지 않는다.
    if (listCommittedQuestionAnswers(c.id).some((r) => r.sourceMessageId === last.id)) continue;
    const snoozedUntil = latestDecisionSnooze(c.id, last.id);
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
      createdAt: last.createdAt,
      ...(snoozedUntil && Date.parse(snoozedUntil) > Date.now() ? { snoozedUntil } : {}),
    });
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const stillPending = new Set(out.map((item) => `${item.chatId}\0${item.sourceMessageId}`));
  for (const claimed of claimedQuestionMessages) {
    if (!stillPending.has(claimed)) claimedQuestionMessages.delete(claimed);
  }
  return out;
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
  claimedQuestionMessages.add(key);
  if (claimedQuestionMessages.size > 10_000) {
    const oldest = claimedQuestionMessages.values().next().value as string | undefined;
    if (oldest && oldest !== key) claimedQuestionMessages.delete(oldest);
  }
  return () => claimedQuestionMessages.delete(key);
}
