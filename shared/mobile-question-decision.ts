import { isOneDecisionViewV1 } from "./one-decision";
import type { QuestionDecisionView } from "./question-decision";
import type { QuestionDecisionAnswer } from "./question-reply";
import type { MobileBridgeOneDecisionDto } from "./mobile-bridge";
import { QUESTION_CONTINUATION_REPLY_MAX_BYTES, QUESTION_CONTINUATION_REPLY_MAX_LENGTH } from "./types";

/** Opt-in generic Decision bank. Existing V1-V4 rows and commands are unchanged. */
export const MOBILE_CANONICAL_QUESTION_CONTRACT = "canonical-question.v1" as const;
export const MOBILE_CANONICAL_QUESTION_CAPABILITY = Object.freeze({
  schemaVersion: 1, maxQuestions: 64,
  maxReplyLength: QUESTION_CONTINUATION_REPLY_MAX_LENGTH,
  maxReplyBytes: QUESTION_CONTINUATION_REPLY_MAX_BYTES,
});
export const MOBILE_CANONICAL_QUESTION_BANK_BYTES = 8 * 1024 * 1024;
export interface MobileCanonicalQuestionDecisionDto {
  schemaVersion: 1;
  decision: MobileBridgeOneDecisionDto;
  question: QuestionDecisionView;
  /** Exact host-registered range only; never a replacement navigation chat. */
  workingScope?: { kind: "science"; projectId: string; conversationId: string };
}
export interface MobileCanonicalQuestionAnswerParams {
  chatId: string;
  requestId: string;
  expectedDecisionContractVersion: typeof MOBILE_CANONICAL_QUESTION_CONTRACT;
  expectedQuestionMessageId: string;
  expectedTaskId: string;
  expectedTaskVersion: number;
  expectedQuestionBankSha256: string;
  ownerConfirmed: true;
  locale: "ko" | "en";
  questionAnswers?: QuestionDecisionAnswer[];
  retryCommitted?: true;
}
const record=(value: unknown): value is Record<string,unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const id=(value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9._:-]{1,256}$/.test(value);
const hash=(value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const keys=(value: Record<string,unknown>,allowed: string[]) => Object.keys(value).every(key=>allowed.includes(key));
const bytes=(value: string)=>new TextEncoder().encode(value).byteLength;

/** Parse structured owner input only. Canonical prose is composed on the host. */
export function validateMobileCanonicalQuestionAnswer(value: unknown): string | null {
  if (!record(value) || !keys(value,["chatId","requestId","expectedDecisionContractVersion","expectedQuestionMessageId","expectedTaskId","expectedTaskVersion","expectedQuestionBankSha256","ownerConfirmed","locale","questionAnswers","retryCommitted"])) return "canonical_question_fields_invalid";
  if (value.expectedDecisionContractVersion !== MOBILE_CANONICAL_QUESTION_CONTRACT || !id(value.chatId)
    || typeof value.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.requestId)
    || !id(value.expectedQuestionMessageId) || !id(value.expectedTaskId)
    || !Number.isSafeInteger(value.expectedTaskVersion) || Number(value.expectedTaskVersion)<1
    || !hash(value.expectedQuestionBankSha256) || value.ownerConfirmed !== true
    || (value.locale!=="ko" && value.locale!=="en")) return "canonical_question_binding_invalid";
  if (value.retryCommitted === true) return value.questionAnswers === undefined ? null : "canonical_question_retry_fields_invalid";
  if (value.retryCommitted !== undefined || !Array.isArray(value.questionAnswers) || value.questionAnswers.length<1 || value.questionAnswers.length>64) return "canonical_question_answers_invalid";
  const seen=new Set<string>();let length=0,byteSize=0;
  for (const answer of value.questionAnswers) {
    if (!record(answer) || !keys(answer,["questionId","selectedIndexes","note"]) || !id(answer.questionId)
      || seen.has(answer.questionId) || typeof answer.note !== "string" || !Array.isArray(answer.selectedIndexes)
      || answer.selectedIndexes.length>8 || answer.selectedIndexes.some((index,position,all)=>!Number.isSafeInteger(index)
        || Number(index)<0 || Number(index)>7 || all.indexOf(index)!==position)) return "canonical_question_answers_invalid";
    seen.add(answer.questionId);length+=answer.note.length;byteSize+=bytes(answer.note);
    if (length>QUESTION_CONTINUATION_REPLY_MAX_LENGTH || byteSize>QUESTION_CONTINUATION_REPLY_MAX_BYTES) return "canonical_question_reply_too_large";
  }
  return null;
}

/** Projection validation does not grant execution; the host re-reads all current bindings. */
export function isMobileCanonicalQuestionDecision(value: unknown): value is MobileCanonicalQuestionDecisionDto {
  if (!record(value) || !keys(value,["schemaVersion","decision","question","workingScope"]) || value.schemaVersion!==1 || !record(value.decision) || !record(value.question)) return false;
  if (!isMobileBridgeOneDecisionDto(value.decision)) return false;
  const q=value.question,d=value.decision,v=record(d.view)?d.view:null;
  if (!keys(q,["schema","chatId","sourceRunId","sourceMessageId","sourceMessageSha256","questionBankSha256","createdAt","awaitingOwner","questions","committed","readOnlyReason"])) return false;
  if (!v || q.schema!=="agentlas.question-decision.v1" || !id(q.chatId) || !id(q.sourceRunId) || !id(q.sourceMessageId)
    || !hash(q.sourceMessageSha256) || !hash(q.questionBankSha256) || typeof q.createdAt!=="string" || q.createdAt.length>64
    || !Number.isFinite(Date.parse(q.createdAt)) || typeof q.awaitingOwner!=="boolean"
    || v.chatId!==q.chatId || v.decisionId!==q.sourceMessageId || v.createdAt!==q.createdAt
    || (q.readOnlyReason!==undefined && (typeof q.readOnlyReason!=="string" || !["legacy-source-reference","legacy-control-fence","control-changed","host-unavailable"].includes(q.readOnlyReason)))
    || !Array.isArray(q.questions) || q.questions.length<1 || q.questions.length>64) return false;
  for (const [index,item] of q.questions.entries()) {
    if (!record(item) || !keys(item,["id","question","header","options","multiSelect"]) || item.id!==`${q.sourceMessageId}-q${index}`
      || typeof item.question!=="string" || !item.question.trim() || item.question.length>4_000
      || (item.header!==undefined && (typeof item.header!=="string" || item.header.length>200))
      || typeof item.multiSelect!=="boolean" || !Array.isArray(item.options) || item.options.length<2 || item.options.length>8) return false;
    for (const option of item.options) if (!record(option) || !keys(option,["label","description"]) || typeof option.label!=="string" || !option.label.trim() || option.label.length>200
      || (option.description!==undefined && (typeof option.description!=="string" || option.description.length>1_000))) return false;
  }
  if (q.committed!==undefined && (!record(q.committed) || !keys(q.committed,["reply","continuationRunId","ts"])
    || typeof q.committed.reply!=="string" || !q.committed.reply || q.committed.reply.length>QUESTION_CONTINUATION_REPLY_MAX_LENGTH
    || bytes(q.committed.reply)>QUESTION_CONTINUATION_REPLY_MAX_BYTES || !id(q.committed.continuationRunId)
    || typeof q.committed.ts!=="string" || !Number.isFinite(Date.parse(q.committed.ts)))) return false;
  if (value.workingScope!==undefined && (!record(value.workingScope) || !keys(value.workingScope,["kind","projectId","conversationId"])
    || value.workingScope.kind!=="science" || !id(value.workingScope.projectId) || !id(value.workingScope.conversationId))) return false;
  return bytes(JSON.stringify(value))<=MOBILE_CANONICAL_QUESTION_BANK_BYTES;
}

const exactRecordKeys=(value: Record<string,unknown>,allowed: readonly string[])=>Object.keys(value).length===allowed.length&&keys(value,[...allowed]);

export function isMobileBridgeOneDecisionDto(
  value: unknown,
): value is MobileBridgeOneDecisionDto {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!exactRecordKeys(row, ["authoritativeHostRef", "canonicalTaskVersion", "view"])) return false;
  if (typeof row.authoritativeHostRef !== "string" || !/^host_[a-f0-9]{32}$/.test(row.authoritativeHostRef)) {
    return false;
  }
  if (!Number.isSafeInteger(row.canonicalTaskVersion) || Number(row.canonicalTaskVersion) < 1) return false;
  if (!isOneDecisionViewV1(row.view) || row.view.taskId === null) return false;
  const expectedEvidence = new Map([
    ["source_message", row.view.decisionId],
    ["task", row.view.taskId],
    ["requested_at", row.view.createdAt],
  ]);
  if (row.view.evidence.length !== expectedEvidence.size) return false;
  return row.view.evidence.every((item) => expectedEvidence.get(item.kind) === item.ref)
    && new Set(row.view.evidence.map((item) => item.kind)).size === expectedEvidence.size;
}
