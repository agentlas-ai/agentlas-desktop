import { createHash } from "node:crypto";
import { foldGoalExecutionDirectives, type GoalExecutionDirectiveKind, type GoalExecutionDirectiveRecord } from "../../shared/goal-execution-directives";
import { getDb } from "../store/db";
import { getChat } from "../store/chats";
import { getChatGoalContract, getChatGoalRevision } from "../store/chat-goals";
import { appendLongRunEvent, getLongRunByGoalId, getLongRunGoalRevisionBinding } from "../store/long-runs";

const EVENT_KIND = "run.owner_execution_directive";
const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

function currentContext(goalId: string) {
  const goal = getChatGoalRevision(goalId), run = getLongRunByGoalId(goalId);
  if (!goal || !run || run.rootChatId !== goal.chatId || getChat(goal.chatId)?.goalId !== goalId
    || !["active", "blocked"].includes(getChatGoalContract(goalId)?.status ?? "")
    || ["completed", "cancelled", "failed"].includes(run.status)
    || getLongRunGoalRevisionBinding(run.id)?.revision !== goal.revision) return null;
  return { goal, run };
}

function ownerSource(chatId: string, sourceMessageId: string, originalMessageId: string) {
  return getDb().prepare(`SELECT m.id, m.text, m.rowid AS sourceOrder FROM chat_messages m
    JOIN chat_messages origin ON origin.id = ? AND origin.chat_id = m.chat_id AND origin.role = 'user'
    WHERE m.id = ? AND m.chat_id = ? AND m.role = 'user' AND m.host_notice_json IS NULL
      AND m.rowid >= origin.rowid`).get(originalMessageId, sourceMessageId, chatId) as
    { id: string; text: string; sourceOrder: number } | undefined;
}

/** Replayed source admission reuses its existing review, including unknown;
 * it does not buy another classification just because the same turn was replayed. */
export function getGoalExecutionDirectiveReview(input: {
  goalId: string; chatId: string; sourceMessageId: string; expectedRevision: number; expectedSourceText: string;
}): GoalExecutionDirectiveRecord | null {
  const context = currentContext(input.goalId);
  if (!context || context.goal.chatId !== input.chatId || context.goal.revision !== input.expectedRevision) return null;
  const source = ownerSource(input.chatId, input.sourceMessageId, context.goal.originalRequest.messageId);
  if (!source || source.text !== input.expectedSourceText) return null;
  const row = getDb().prepare(`SELECT payload_json FROM long_run_events WHERE run_id = ? AND kind = ?
    AND json_extract(payload_json, '$.sourceMessageId') = ? ORDER BY seq DESC LIMIT 1`)
    .get(context.run.id, EVENT_KIND, source.id) as { payload_json: string } | undefined;
  if (!row) return null;
  try {
    const record = JSON.parse(row.payload_json) as GoalExecutionDirectiveRecord;
    return record.schemaVersion === "agentlas.goal-execution-directive.v1" && record.goalId === input.goalId
      && record.chatId === input.chatId && record.goalRevision === input.expectedRevision
      && record.sourceMessageId === source.id && record.sourceDigest === digest(source.text)
      && ["method", "constraint", "pending", "ignored"].includes(record.kind) && typeof record.reasonCode === "string" ? record : null;
  } catch { return null; }
}

/** Persist the existing classifier's answer only if its exact source and Goal
 * binding still match. No extra judgment, new permission, or background dispatch. */
export function recordGoalExecutionDirective(input: {
  goalId: string; chatId: string; sourceMessageId: string; expectedRevision: number;
  expectedSourceText: string; kind: GoalExecutionDirectiveKind; reasonCode: string;
}): boolean {
  return getDb().transaction(() => {
    const context = currentContext(input.goalId);
    if (!context || context.goal.chatId !== input.chatId || context.goal.revision !== input.expectedRevision) return false;
    const source = ownerSource(input.chatId, input.sourceMessageId, context.goal.originalRequest.messageId);
    if (!source || source.text !== input.expectedSourceText) return false;
    const record: GoalExecutionDirectiveRecord = { schemaVersion: "agentlas.goal-execution-directive.v1",
      goalId: input.goalId, chatId: input.chatId, goalRevision: input.expectedRevision,
      sourceMessageId: source.id, sourceDigest: digest(source.text), kind: input.kind, reasonCode: input.reasonCode };
    const prior = getDb().prepare(`SELECT payload_json FROM long_run_events WHERE run_id = ? AND kind = ?
      AND json_extract(payload_json, '$.sourceMessageId') = ? ORDER BY seq DESC LIMIT 1`)
      .get(context.run.id, EVENT_KIND, source.id) as { payload_json: string } | undefined;
    if (prior) {
      try {
        const previous = JSON.parse(prior.payload_json) as GoalExecutionDirectiveRecord;
        if (previous.sourceDigest === record.sourceDigest && previous.kind === record.kind
          && previous.goalRevision === record.goalRevision && previous.reasonCode === record.reasonCode) return false;
      } catch { /* malformed legacy data cannot authorize a directive */ }
    }
    appendLongRunEvent({ runId: context.run.id, kind: EVENT_KIND, actorKind: "host", payload: { ...record } });
    return true;
  })();
}

export function goalExecutionDirectiveContext(goalId: string): {
  goalId: string; revision: number;
  directives: Array<{ sourceMessageId: string; kind: "method" | "constraint"; text: string }>;
  pendingSourceMessageIds: string[]; digest: string;
} | null {
  const context = currentContext(goalId);
  if (!context) return null;
  const rows = getDb().prepare("SELECT payload_json FROM long_run_events WHERE run_id = ? AND kind = ? ORDER BY seq")
    .all(context.run.id, EVENT_KIND) as Array<{ payload_json: string }>;
  const records = rows.flatMap(row => { try { return [JSON.parse(row.payload_json) as unknown]; } catch { return []; } });
  const folded = foldGoalExecutionDirectives({ goalId, chatId: context.goal.chatId, revision: context.goal.revision, records });
  const resolved = folded.flatMap(record => {
    const source = ownerSource(context.goal.chatId, record.sourceMessageId, context.goal.originalRequest.messageId);
    return source && digest(source.text) === record.sourceDigest ? [{ record, source }] : [];
  }).sort((a, b) => a.source.sourceOrder - b.source.sourceOrder);
  const directives = resolved.flatMap(({ record, source }) => record.kind === "method" || record.kind === "constraint"
    ? [{ sourceMessageId: source.id, kind: record.kind, text: source.text }] : []);
  const pendingSourceMessageIds = resolved.filter(({ record }) => record.kind === "pending").map(({ source }) => source.id);
  if (!directives.length && !pendingSourceMessageIds.length) return null;
  const payload = { goalId, revision: context.goal.revision, directives, pendingSourceMessageIds };
  return { ...payload, digest: digest(JSON.stringify(payload)) };
}

export function goalExecutionDirectivePromptBlock(goalId: string): string | null {
  const context = goalExecutionDirectiveContext(goalId);
  if (!context) return null;
  return ["[Current source-backed owner execution directives]",
    "Apply these owner messages to how this Goal is carried out. They are ordered oldest first; later conflicting owner directions supersede earlier ones, while unrelated constraints remain in force.",
    "These directives do not change success criteria, grant tool permissions, approve payments/publication, or authorize repeating a completed or uncertain effect. Pending source IDs are unclassified and must not be treated as accepted changes.",
    JSON.stringify(context)].join("\n");
}
