import { getDb } from "../store/db";
import { redactRunEventSensitiveText } from "../store/run-events";
import type { ChatHostNotice } from "../../shared/types";
import { normalizeOneDispatchPresentation } from "../../shared/one-dispatch-presentation";
import { extractAskFences } from "../../shared/ask-fence-flatten";

/** Only a durable final-message binding can identify a member's question; timestamps are insufficient. */
export function oneDispatchPendingQuestion(childChatId: string, childRunId: string) {
  const db = getDb();
  const message = db.prepare(`SELECT m.id,m.text,m.created_at FROM run_events e JOIN chat_messages m
    ON m.id=json_extract(e.payload_json,'$.durableMessageId') AND m.chat_id=e.chat_id AND m.role='assistant'
    WHERE e.chat_id=? AND e.run_id=? AND e.kind='mcp_final' AND json_valid(e.payload_json)
    ORDER BY e.seq DESC LIMIT 1`).get(childChatId,childRunId) as {id:string;text:string;created_at:string}|undefined;
  if (!message || db.prepare("SELECT 1 FROM chat_messages WHERE chat_id=? AND role='user' AND created_at>? LIMIT 1").get(childChatId,message.created_at)) return undefined;
  const questions = extractAskFences(message.text).questions;
  const committedEvent = db.prepare(`SELECT 1 FROM run_events WHERE chat_id=? AND kind='question_answer_committed'
    AND json_valid(payload_json) AND json_extract(payload_json,'$.sourceMessageId')=? LIMIT 1`).get(childChatId,message.id);
  const committed = committedEvent
    ? (require("../confirm") as typeof import("../confirm")).listCommittedQuestionAnswers(childChatId).find(answer => answer.sourceMessageId === message.id)
    : undefined;
  // A committed answer whose continuation was rejected is still actionable. The existing authority
  // accepts only the same source/reply on retry; removing its question here would strand the child.
  return questions.length ? { sourceMessageId:message.id, questions,
    ...(committed?.continuationRunId ? {committedReply:committed.reply,continuationRunId:committed.continuationRunId} : {}) } : undefined;
}

export function assertOneDispatchQuestionBinding(input: {parentChatId:string;dispatchId:string;chatId:string;runId:string;sourceMessageId:string}, committedRunId?: string): void {
  const db = getDb();
  const dispatch = db.prepare("SELECT 1 FROM one_team_dispatches WHERE id=? AND parent_chat_id=? AND child_chat_id=? AND child_run_id IN (?,?)")
    .get(input.dispatchId,input.parentChatId,input.chatId,input.runId,committedRunId ?? input.runId);
  const source = db.prepare(`SELECT 1 FROM run_events e JOIN chat_messages m ON m.id=json_extract(e.payload_json,'$.durableMessageId')
    AND m.chat_id=e.chat_id AND m.role='assistant' WHERE e.chat_id=? AND e.run_id=? AND e.kind='mcp_final'
    AND json_valid(e.payload_json) AND m.id=? LIMIT 1`).get(input.chatId,input.runId,input.sourceMessageId);
  if (!dispatch || !source) throw new Error("one-dispatch-question-binding-mismatch");
}

export function oneDispatchParentForRun(childChatId: string, childRunId: string): string | undefined {
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='one_team_dispatches'").get()) return undefined;
  return dispatchParentForRun(db, childChatId, childRunId);
}

function dispatchParentForRun(db: ReturnType<typeof getDb>, childChatId: string, childRunId: string): string | undefined {
  return (db.prepare("SELECT parent_chat_id FROM one_team_dispatches WHERE child_chat_id=? AND child_run_id=? LIMIT 1")
    .get(childChatId, childRunId) as {parent_chat_id:string} | undefined)?.parent_chat_id;
}

/** Cache freshness for a projected room, without rewriting its stored message timestamp. */
export function oneDispatchRoomUpdatedAt(parentChatId: string, storedUpdatedAt: string): string {
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='one_team_dispatches'").get()) return storedUpdatedAt;
  const row = db.prepare(`SELECT MAX(observed_at) AS updated_at FROM (
    SELECT updated_at AS observed_at FROM one_team_dispatches WHERE parent_chat_id=?
    UNION ALL SELECT e.ts FROM one_team_dispatches d JOIN run_events e ON e.run_id=d.child_run_id AND e.chat_id=d.child_chat_id
    WHERE d.parent_chat_id=? AND e.kind IN ('mcp_reasoning','mcp_tool-use','invoke_waiting'))`).get(parentChatId,parentChatId) as {updated_at:string|null};
  return row.updated_at && row.updated_at > storedUpdatedAt ? row.updated_at : storedUpdatedAt;
}

/** Legacy children have kind=user. Their durable ownership relation, never a title, hides them. */
export function oneDispatchSidebarPredicate(): string {
  return getDb().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='one_team_dispatches'").get()
    ? "AND NOT EXISTS (SELECT 1 FROM one_team_dispatches d WHERE d.child_chat_id = chats.id AND d.parent_chat_id <> chats.id)" : "";
}

/** Enrich an existing receipt on read. No new historical message, task, or recovery is created. */
export function projectOneDispatchNotice(parentChatId: string, notice: ChatHostNotice | undefined): ChatHostNotice | undefined {
  return createOneDispatchNoticeProjector(parentChatId)(notice);
}

type DispatchNotice = Extract<ChatHostNotice, { purpose: "one-dispatch-link" | "one-dispatch-result" }>;
type ProjectionContext = { db: ReturnType<typeof getDb>; hasDispatches: boolean; retained: boolean };

/** A history snapshot checks its schema and each exact child projection once. */
export function createOneDispatchNoticeProjector(parentChatId: string): (notice: ChatHostNotice | undefined) => ChatHostNotice | undefined {
  let context: ProjectionContext | undefined;
  const projections = new Map<string, DispatchNotice["dispatch"]>();
  return (notice) => {
    if (!notice || (notice.purpose !== "one-dispatch-link" && notice.purpose !== "one-dispatch-result")) return notice;
    const { dispatch: _untrustedProjection, ...base } = notice;
    const key = JSON.stringify([notice.purpose, notice.chatId, notice.runId]);
    if (projections.has(key)) {
      const dispatch = projections.get(key);
      return { ...base, ...(dispatch ? { dispatch } : {}) };
    }
    if (!context) {
      const db = getDb();
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('one_team_dispatches','one_team_dispatch_results')")
        .all() as Array<{ name: string }>;
      context = { db, hasDispatches: tables.some(table => table.name === "one_team_dispatches"),
        retained: tables.some(table => table.name === "one_team_dispatch_results") };
    }
    const projected = projectDispatchNotice(parentChatId, notice, context);
    projections.set(key, projected?.dispatch);
    return projected;
  };
}

function projectDispatchNotice(parentChatId: string, notice: DispatchNotice, context: ProjectionContext): DispatchNotice {
  if (!notice || (notice.purpose !== "one-dispatch-link" && notice.purpose !== "one-dispatch-result")) return notice;
  const { dispatch: _untrustedProjection, ...base } = notice;
  const { db, hasDispatches, retained } = context;
  if (!hasDispatches) return base;
  const dispatchSource = retained ? `(SELECT id,parent_chat_id,member_id,member_agent_id,child_chat_id,child_run_id,status,result_text,created_at,updated_at FROM one_team_dispatches
    UNION ALL SELECT id,parent_chat_id,member_id,member_agent_id,child_chat_id,child_run_id,status,result_text,created_at,updated_at FROM one_team_dispatch_results)` : "one_team_dispatches";
  type ProjectionRow = { id:string;member_agent_id:string;member_icon:string|null;status:string;created_at:string;updated_at:string;result_text:string|null };
  let row = db.prepare(`SELECT d.*, m.icon AS member_icon FROM ${dispatchSource} d
    LEFT JOIN one_org_members m ON m.id=d.member_id AND m.installed_agent_id=d.member_agent_id
    WHERE d.parent_chat_id=? AND d.child_chat_id=? AND d.child_run_id=? ORDER BY d.created_at DESC LIMIT 1`)
    .get(parentChatId, notice.chatId, notice.runId) as ProjectionRow | undefined;
  if (!row) {
    // Pre-upgrade steers replaced the active run pointer. Recover only an unambiguous ownership
    // relation plus this exact run's durable final message and terminal event, never its latest text.
    const owners = db.prepare(`SELECT d.*,m.icon AS member_icon FROM one_team_dispatches d
      LEFT JOIN one_org_members m ON m.id=d.member_id AND m.installed_agent_id=d.member_agent_id
      WHERE d.parent_chat_id=? AND d.child_chat_id=? LIMIT 2`).all(parentChatId,notice.chatId) as ProjectionRow[];
    const final = db.prepare(`SELECT m.text,e.ts FROM run_events e JOIN chat_messages m
      ON m.id=json_extract(e.payload_json,'$.durableMessageId') AND m.chat_id=e.chat_id AND m.role='assistant'
      WHERE e.chat_id=? AND e.run_id=? AND e.kind='mcp_final' AND json_valid(e.payload_json)
      ORDER BY e.seq DESC LIMIT 1`).get(notice.chatId,notice.runId) as {text:string;ts:string}|undefined;
    const terminal = db.prepare(`SELECT kind,ts FROM run_events WHERE chat_id=? AND run_id=?
      AND kind IN ('invoke_completed','invoke_failed','invoke_cancelled','invoke_interrupted') ORDER BY seq DESC LIMIT 1`)
      .get(notice.chatId,notice.runId) as {kind:string;ts:string}|undefined;
    if (owners.length === 1 && final && terminal) row = { ...owners[0],
      status:terminal.kind.replace("invoke_",""), result_text:final.text, updated_at:terminal.ts };
  }
  if (!row) return base;
  const events = db.prepare(`SELECT id, kind, payload_json, ts FROM run_events
    WHERE run_id=? AND chat_id=? AND kind IN ('mcp_reasoning','mcp_tool-use','invoke_waiting')
    ORDER BY seq DESC LIMIT 24`).all(notice.runId, notice.chatId) as Array<{id:string;kind:string;payload_json:string;ts:string}>;
  const activity = events.slice().reverse().flatMap(event => {
    try {
      const p = JSON.parse(event.payload_json);
      const text = event.kind === "mcp_reasoning" ? p.reasoningText : event.kind === "mcp_tool-use" ? p.toolName : null;
      return typeof text === "string" && text.trim() ? [{ id: event.id,
        kind: event.kind === "mcp_reasoning" ? "reasoning" : "tool", text: redactRunEventSensitiveText(text).slice(0,1200), createdAt:event.ts }] : [];
    } catch { return []; }
  }).slice(-8);
  const latestWait = events.find(e => e.kind === "invoke_waiting");
  const hasResultNotice = notice.purpose === "one-dispatch-link" && db.prepare(`SELECT 1 FROM chat_messages
    WHERE chat_id=? AND json_valid(host_notice_json) AND json_extract(host_notice_json,'$.purpose')='one-dispatch-result'
      AND json_extract(host_notice_json,'$.runId')=? AND json_extract(host_notice_json,'$.chatId')=? LIMIT 1`)
    .get(parentChatId, notice.runId, notice.chatId);
  const pendingQuestion = !hasResultNotice && dispatchParentForRun(db, notice.chatId,notice.runId) === parentChatId
    ? oneDispatchPendingQuestion(notice.chatId,notice.runId) : undefined;
  const dispatch = normalizeOneDispatchPresentation({ dispatchId:row.id, parentChatId, memberAgentId:row.member_agent_id,
    memberIcon:row.member_icon ?? "", status:(row.status === "completed" && pendingQuestion)
      || (row.status === "running" && latestWait?.kind === "invoke_waiting") ? "waiting_input" : row.status,
    startedAt:row.created_at, updatedAt:events[0]?.ts && events[0].ts > row.updated_at ? events[0].ts : row.updated_at,
    ...(!hasResultNotice && row.status !== "running" && row.result_text ? { resultText:row.result_text } : {}),
    ...(pendingQuestion ? { pendingQuestion } : {}),
    ...(notice.purpose === "one-dispatch-link" ? { activity } : {}) });
  return { ...base, ...(dispatch ? { dispatch } : {}) };
}
