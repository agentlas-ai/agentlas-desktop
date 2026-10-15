import type Database from "better-sqlite3";
import type { SupervisorTask } from "../../shared/one-supervisor";
import { insertGraphResultNotice, supervisorHash, supervisorWorkForWorkerChat } from "./supervisor-store";
import { readSealedAutomationRunOrigin } from "../automation-run-origin";

/*
 * Graph and automation results that answer the owner's personal conversation come back to One for review
 * (native-harness notyet NH16; docs 22 O3–O5). The scheduler already delivers the report to the graph's origin
 * conversation (automation-delivery.ts). When that origin is One's personal conversation, or a Work session One
 * delegated, the same delivery transaction queues the result in One's review outbox (one_supervisor_notices) with
 * the exact owner message or brief the graph was saved from. One reviews it in a host-started turn like delegated
 * Work, teammate and Science results. Nothing here starts, reruns or controls an automation.
 *
 * No electron import: the scheduler runs in Main or the daemon.
 */

export const GRAPH_RESULT_DETAIL_SCHEMA = "agentlas.one-graph-result.v1" as const;
/** The review outbox keeps 6000 bytes of detail (supervisor-store noticeTeamResult uses the same bound). */
const DETAIL_MAX_BYTES = 6000;

export interface PersonalGraphSource {
  oneId: string;
  personalChatId: string;
  /** "personal": saved from One's own conversation; "work": saved inside a Work session One delegated. */
  via: "personal" | "work";
  /** The exact supervisor request the graph answers: the owner's reply turn or the delegated Work brief. */
  sourceCommandId: string | null;
  delegatedTaskId: string | null;
  originChatId: string;
  originMessageId: string | null;
}

export interface GraphResultDetail {
  schemaVersion: typeof GRAPH_RESULT_DETAIL_SCHEMA;
  automationId: string;
  name: string;
  via: PersonalGraphSource["via"];
  originChatId: string;
  originMessageId: string | null;
  sourceCommandId: string | null;
  delegatedTaskId: string | null;
  /** The owner's message or One's brief the graph was saved from (excerpt), so the review needs no second lookup. */
  source: string;
  status: string;
  outcome: string | null;
  reportMessageId: string | null;
  /** The report row already stands in One's personal conversation (origin = that conversation). */
  reportInConversation: boolean;
  report: string;
  reportIsExcerpt: boolean;
}

const tableExists = (db: Database.Database, name: string): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** Scheduler status → review outcome word. A graph's own words, not One's verdict. */
export function graphNoticeState(status: string): string {
  return status === "ok" ? "completed" : status === "error" ? "failed" : status;
}

/** The owner's own stop is the host's typed marker on the run error (automation-scheduler stop path), never prose. */
export function ownerStoppedAutomationRun(error: string | null | undefined): boolean {
  let text = (error ?? "").trim();
  for (let guard = 0; guard < 4; guard += 1) {
    const marker = /^\[([a-z][a-z0-9_]*)\]\s*/.exec(text);
    if (!marker) return false;
    if (marker[1] === "automation_stopped_by_user") return true;
    text = text.slice(marker[0].length);
  }
  return false;
}

/** Where a graph's origin sits relative to One: its personal conversation, a Work session One delegated, or neither. */
export function personalGraphSource(db: Database.Database, monitor: { originChatId?: string | null; originMessageId?: string | null } | null | undefined): PersonalGraphSource | null {
  const originChatId = monitor?.originChatId;
  if (!originChatId || !tableExists(db, "one_supervisor_conversations") || !tableExists(db, "one_supervisor_requests")) return null;
  const originMessageId = monitor?.originMessageId ?? null;
  const personal = db.prepare("SELECT one_id FROM one_supervisor_conversations WHERE chat_id=?").get(originChatId) as { one_id: string } | undefined;
  if (personal) {
    const reply = originMessageId ? db.prepare(`SELECT command_id FROM one_supervisor_requests
      WHERE one_id=? AND origin_chat_id=? AND kind='reply' AND user_message_id=? ORDER BY rowid LIMIT 1`)
      .get(personal.one_id, originChatId, originMessageId) as { command_id: string } | undefined : undefined;
    return { oneId: personal.one_id, personalChatId: originChatId, via: "personal", sourceCommandId: reply?.command_id ?? null,
      delegatedTaskId: null, originChatId, originMessageId };
  }
  const work = supervisorWorkForWorkerChat(db, originChatId);
  if (!work) return null;
  const home = db.prepare("SELECT chat_id FROM one_supervisor_conversations WHERE one_id=?").get(work.one_id) as { chat_id: string } | undefined;
  if (!home) return null;
  return { oneId: work.one_id, personalChatId: home.chat_id, via: "work", sourceCommandId: work.command_id,
    delegatedTaskId: work.task_id, originChatId, originMessageId };
}

function sourceText(db: Database.Database, source: PersonalGraphSource): string {
  try {
    if (source.via === "work" && source.sourceCommandId) {
      const row = db.prepare("SELECT payload_json FROM one_supervisor_requests WHERE command_id=?").get(source.sourceCommandId) as { payload_json: string } | undefined;
      const text = row ? JSON.parse(row.payload_json).text : null;
      return typeof text === "string" ? text.slice(0, 800) : "";
    }
    if (source.originMessageId && tableExists(db, "chat_messages")) {
      const row = db.prepare("SELECT text FROM chat_messages WHERE id=? AND chat_id=? AND role='user'").get(source.originMessageId, source.originChatId) as { text: string } | undefined;
      return row?.text?.slice(0, 800) ?? "";
    }
  } catch { /* An unreadable source leaves the exact ids in the detail. */ }
  return "";
}

/** Complete JSON within the outbox bound: the report is shortened, never the identifiers. */
function boundedDetail(detail: GraphResultDetail): string {
  let value = detail;
  let json = JSON.stringify(value);
  while (Buffer.byteLength(json) > DETAIL_MAX_BYTES && value.report.length > 0) {
    const over = Buffer.byteLength(json) - DETAIL_MAX_BYTES;
    value = { ...value, report: value.report.slice(0, Math.max(0, value.report.length - Math.max(16, Math.ceil(over / 3)))), reportIsExcerpt: true };
    json = JSON.stringify(value);
  }
  return json;
}

/**
 * Called inside deliverAutomationResult's transaction after the report was persisted to the origin conversation.
 * Queues the result once per automation run for the One whose conversation (or delegated Work session) the graph
 * answers; the owner's own stop is recorded as skipped. Returns whether a new review item was queued.
 */
export function queueGraphResultForOne(db: Database.Database, input: {
  automation: { id: string; name: string; monitor?: { originChatId?: string | null; originMessageId?: string | null } | null };
  runId: string; status: string; outcome?: string | null; error?: string | null; report: string; reportMessageId: string | null;
}): boolean {
  const source = personalGraphSource(db, input.automation.monitor);
  if (!source) return false;
  const detail = boundedDetail({ schemaVersion: GRAPH_RESULT_DETAIL_SCHEMA, automationId: input.automation.id, name: input.automation.name.slice(0, 200),
    via: source.via, originChatId: source.originChatId, originMessageId: source.originMessageId, sourceCommandId: source.sourceCommandId,
    delegatedTaskId: source.delegatedTaskId, source: sourceText(db, source), status: input.status, outcome: input.outcome ?? null,
    reportMessageId: input.reportMessageId, reportInConversation: source.via === "personal" && input.reportMessageId !== null,
    report: input.report, reportIsExcerpt: false });
  return insertGraphResultNotice(db, { oneId: source.oneId, automationId: input.automation.id, runId: input.runId,
    personalChatId: source.personalChatId, state: graphNoticeState(input.status), ownerStopped: ownerStoppedAutomationRun(input.error), detail });
}

export function parseGraphResultDetail(raw: string | null): GraphResultDetail | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as GraphResultDetail;
    return value?.schemaVersion === GRAPH_RESULT_DETAIL_SCHEMA && typeof value.automationId === "string" ? value : null;
  } catch { return null; }
}

/**
 * Status and result of the graphs that answer One's conversation (22 O4/O5), read from the existing automation
 * ledger: a live run, else the latest delivered (or quiet) origin report. Read-only, no controls, no second store.
 */
export function personalGraphTasks(db: Database.Database, oneId: string, deps: {
  automations(): Array<{ id: string; name: string; monitor?: { originChatId?: string | null; originMessageId?: string | null } | null }>;
  liveRunId(automationId: string): string | null;
}): SupervisorTask[] {
  if (!tableExists(db, "run_events")) return [];
  const out: SupervisorTask[] = [];
  for (const automation of deps.automations()) {
    const live = deps.liveRunId(automation.id);
    const last = db.prepare(`SELECT run_id,kind,payload_json,ts FROM run_events WHERE automation_id=?
      AND kind IN ('automation_origin_report_delivered','automation_origin_report_quiet') ORDER BY rowid DESC LIMIT 1`)
      .get(automation.id) as { run_id: string; kind: string; payload_json: string | null; ts: string } | undefined;
    if (!live && !last) continue;
    // The projected run answers the origin it sealed at start, not a monitor updated after it began.
    const sealed = readSealedAutomationRunOrigin(db, live ?? last!.run_id);
    const source = personalGraphSource(db, sealed !== undefined ? sealed : automation.monitor);
    if (!source || source.oneId !== oneId) continue;
    let payload: { status?: string; messageId?: string } = {};
    try { payload = last?.payload_json ? JSON.parse(last.payload_json) : {}; } catch { payload = {}; }
    const state = live ? "running" : graphNoticeState(payload.status ?? "ok");
    const runId = live ?? last!.run_id;
    let result: string | null = null;
    if (!live && last?.kind === "automation_origin_report_delivered" && payload.messageId && tableExists(db, "chat_messages")) {
      result = (db.prepare("SELECT text FROM chat_messages WHERE id=? AND chat_id=?").get(payload.messageId, source.originChatId) as { text: string } | undefined)?.text ?? null;
    }
    out.push({ taskId: `graph:${automation.id}`, surface: "one", title: automation.name, chatId: source.originChatId, projectId: null, runId, state,
      controlVersion: supervisorHash([`graph:${automation.id}`, runId, state]), observedAt: last?.ts ?? new Date().toISOString(), owner: "desktop-main",
      controls: [], result, resultVerified: false, sourceCommandId: source.sourceCommandId });
  }
  return out;
}
