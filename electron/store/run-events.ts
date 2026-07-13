import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import type {
  FailureEventUi,
  InvocationRunReceipt,
  McpInvocationEvent,
  McpInvocationRequest,
  RunEventUi,
} from "../../shared/types";

interface RunEventRow {
  id: string;
  run_id: string;
  seq: number;
  ts: string;
  kind: string;
  chat_id: string | null;
  automation_id: string | null;
  node_id: string | null;
  agent_id: string | null;
  payload_json: string;
}

interface FailureEventRow {
  id: string;
  run_id: string | null;
  ts: string;
  source: string;
  chat_id: string | null;
  automation_id: string | null;
  node_id: string | null;
  agent_id: string | null;
  error_code: string | null;
  error_message: string;
  payload_json: string;
}

export interface RecordRunEventInput {
  runId: string;
  kind: string;
  chatId?: string | null;
  automationId?: string | null;
  nodeId?: string | null;
  agentId?: string | null;
  payload?: Record<string, unknown>;
}

export interface RecordFailureEventInput {
  runId?: string | null;
  source: string;
  chatId?: string | null;
  automationId?: string | null;
  nodeId?: string | null;
  agentId?: string | null;
  errorCode?: string | null;
  errorMessage: string;
  payload?: Record<string, unknown>;
}

const SECRET_RE = /(sk-[A-Za-z0-9_-]{12,}|api[_-]?key\s*[:=]\s*\S+|secret\s*[:=]\s*\S+|password\s*[:=]\s*\S+|token\s*[:=]\s*\S+|BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY)/gi;

function nowIso(): string {
  return new Date().toISOString();
}

function truncate(value: string, limit = 800): string {
  const text = value.replace(SECRET_RE, "[redacted]");
  return text.length > limit ? `${text.slice(0, limit)}...[truncated]` : text;
}

function safePayload(input: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (value == null) continue;
    if (typeof value === "string") {
      out[key] = truncate(value, 800);
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value.slice(0, 20).map((item) =>
        typeof item === "string" ? truncate(item, 240) : item,
      );
    } else if (typeof value === "object") {
      out[key] = truncate(JSON.stringify(value), 1_200);
    }
  }
  return out;
}

function parsePayload(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function nextSeq(runId: string): number {
  const row = getDb()
    .prepare("SELECT COALESCE(MAX(seq) + 1, 0) AS seq FROM run_events WHERE run_id = ?")
    .get(runId) as { seq?: number } | undefined;
  return Number(row?.seq ?? 0);
}

function normalizeLimit(value: unknown, fallback: number): number {
  const numeric = Number(value ?? fallback);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(500, Math.floor(numeric)));
}

function runRowToUi(row: RunEventRow): RunEventUi {
  return {
    id: row.id,
    runId: row.run_id,
    seq: row.seq,
    ts: row.ts,
    kind: row.kind,
    chatId: row.chat_id ?? undefined,
    automationId: row.automation_id ?? undefined,
    nodeId: row.node_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    payload: parsePayload(row.payload_json),
  };
}

function failureRowToUi(row: FailureEventRow): FailureEventUi {
  return {
    id: row.id,
    runId: row.run_id ?? undefined,
    ts: row.ts,
    source: row.source,
    chatId: row.chat_id ?? undefined,
    automationId: row.automation_id ?? undefined,
    nodeId: row.node_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message,
    payload: parsePayload(row.payload_json),
  };
}

export function recordRunEvent(input: RecordRunEventInput): RunEventUi {
  const seq = nextSeq(input.runId);
  const row = {
    id: `evt_${randomUUID()}`,
    run_id: input.runId,
    seq,
    ts: nowIso(),
    kind: input.kind,
    chat_id: input.chatId ?? null,
    automation_id: input.automationId ?? null,
    node_id: input.nodeId ?? null,
    agent_id: input.agentId ?? null,
    payload_json: JSON.stringify(safePayload(input.payload)),
  };
  getDb()
    .prepare(
      `INSERT INTO run_events
       (id, run_id, seq, ts, kind, chat_id, automation_id, node_id, agent_id, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.run_id,
      row.seq,
      row.ts,
      row.kind,
      row.chat_id,
      row.automation_id,
      row.node_id,
      row.agent_id,
      row.payload_json,
    );
  return runRowToUi(row);
}

export function recordFailureEvent(input: RecordFailureEventInput): FailureEventUi {
  const row = {
    id: `fail_${randomUUID()}`,
    run_id: input.runId ?? null,
    ts: nowIso(),
    source: input.source,
    chat_id: input.chatId ?? null,
    automation_id: input.automationId ?? null,
    node_id: input.nodeId ?? null,
    agent_id: input.agentId ?? null,
    error_code: input.errorCode ?? null,
    error_message: truncate(input.errorMessage || "Unknown failure", 1_200),
    payload_json: JSON.stringify(safePayload(input.payload)),
  };
  getDb()
    .prepare(
      `INSERT INTO failure_events
       (id, run_id, ts, source, chat_id, automation_id, node_id, agent_id, error_code, error_message, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.run_id,
      row.ts,
      row.source,
      row.chat_id,
      row.automation_id,
      row.node_id,
      row.agent_id,
      row.error_code,
      row.error_message,
      row.payload_json,
    );
  return failureRowToUi(row);
}

export function tryRecordRunEvent(input: RecordRunEventInput): void {
  try {
    recordRunEvent(input);
  } catch {
    /* ledger failures must never break the user run */
  }
}

export function tryRecordFailureEvent(input: RecordFailureEventInput): void {
  try {
    recordFailureEvent(input);
  } catch {
    /* ledger failures must never break the user run */
  }
}

export function recordMcpInvocationEvent(runId: string, req: McpInvocationRequest, ev: McpInvocationEvent): void {
  // 고빈도 라이브 신호(partial 델타·usage 카운터·reasoning 구간)는 UI 전용 — 원장에 남기지 않는다.
  if (ev.kind === "partial" || ev.kind === "usage" || ev.kind === "reasoning") return;
  const payload = {
    eventKind: ev.kind,
    status: ev.status,
    phase: ev.phase,
    role: ev.role,
    agentName: ev.agentName,
    model: ev.model,
    nodeState: ev.nodeState,
    surfaceId: ev.surfaceId,
    toolName: ev.tool?.name,
    toolId: ev.tool?.id,
    toolIsError: ev.tool?.isError,
    textLen: ev.textLen ?? ev.text?.length,
    tokens: ev.tokens,
    permissions: req.permissions,
    toolMode: req.toolMode,
    hubMode: req.hubMode,
    borrowAgents: req.borrowAgents,
  };
  tryRecordRunEvent({
    runId,
    kind: `mcp_${ev.kind}`,
    chatId: req.chatId,
    nodeId: ev.nodeId,
    agentId: ev.runtimeAgentId ?? ev.agentId,
    payload,
  });
  if (ev.kind === "error") {
    tryRecordFailureEvent({
      runId,
      source: "invoke",
      chatId: req.chatId,
      nodeId: ev.nodeId,
      agentId: ev.runtimeAgentId ?? ev.agentId,
      errorCode: ev.error?.code ?? "runtime_error",
      errorMessage: ev.error?.message || ev.status || "Runtime emitted an error event",
      payload,
    });
  } else if (ev.tool?.isError) {
    tryRecordFailureEvent({
      runId,
      source: "tool",
      chatId: req.chatId,
      nodeId: ev.nodeId,
      agentId: ev.runtimeAgentId ?? ev.agentId,
      errorCode: "tool_error",
      errorMessage: ev.status || `${ev.tool.name} returned an error`,
      payload,
    });
  } else if (ev.nodeState === "failed") {
    tryRecordFailureEvent({
      runId,
      source: "workflow_node",
      chatId: req.chatId,
      nodeId: ev.nodeId,
      agentId: ev.runtimeAgentId ?? ev.agentId,
      errorCode: "node_failed",
      errorMessage: ev.status || "Workflow node failed",
      payload,
    });
  }
}

export function listRunEvents(runId: string, limit?: number): RunEventUi[] {
  if (!runId) return [];
  const capped = normalizeLimit(limit, 200);
  const rows = getDb()
    .prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY seq ASC LIMIT ?")
    .all(runId, capped) as RunEventRow[];
  return rows.map(runRowToUi);
}

export function listFailureEvents(input: {
  runId?: string;
  automationId?: string;
  chatId?: string;
  limit?: number;
} = {}): FailureEventUi[] {
  const capped = normalizeLimit(input.limit, 100);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input.runId) {
    clauses.push("run_id = ?");
    params.push(input.runId);
  }
  if (input.automationId) {
    clauses.push("automation_id = ?");
    params.push(input.automationId);
  }
  if (input.chatId) {
    clauses.push("chat_id = ?");
    params.push(input.chatId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`SELECT * FROM failure_events ${where} ORDER BY datetime(ts) DESC LIMIT ?`)
    .all(...params, capped) as FailureEventRow[];
  return rows.map(failureRowToUi);
}

function stringPayload(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayPayload(payload: Record<string, unknown>, key: string): string[] | undefined {
  const value = payload[key];
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return normalized.length ? normalized : undefined;
}

/** True once a renderer-selected run id has crossed the durable start gate. */
export function hasInvocationRunReceipt(runId: string): boolean {
  if (!runId) return false;
  const row = getDb()
    .prepare("SELECT 1 AS found FROM run_events WHERE run_id = ? AND kind = 'invoke_started' LIMIT 1")
    .get(runId) as { found?: number } | undefined;
  return row?.found === 1;
}

/**
 * Rebuild a terminal/recovery receipt from the append-only run ledger.
 * A started row without a terminal row is `interrupted` here: only main's
 * in-memory registry may upgrade it to running/cancelling.
 */
export function getInvocationRunReceipt(runId: string): InvocationRunReceipt | null {
  if (!runId) return null;
  const rows = getDb()
    .prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY seq ASC")
    .all(runId) as RunEventRow[];
  const start = rows.find((row) => row.kind === "invoke_started");
  if (!start) return null;

  const startPayload = parsePayload(start.payload_json);
  let status: InvocationRunReceipt["status"] = "interrupted";
  let terminal: RunEventRow | undefined;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.kind === "invoke_completed" || row.kind === "mcp_final") {
      status = "completed";
      terminal = row;
      break;
    }
    if (row.kind === "invoke_cancelled") {
      status = "cancelled";
      terminal = row;
      break;
    }
    if (row.kind === "invoke_failed" || row.kind === "invoke_threw" || row.kind === "mcp_error") {
      status = "failed";
      terminal = row;
      break;
    }
  }

  const latest = rows[rows.length - 1] ?? start;
  const terminalPayload = terminal ? parsePayload(terminal.payload_json) : {};
  const settledPayload = [...rows]
    .reverse()
    .map((row) => parsePayload(row.payload_json))
    .find((payload) => stringPayload(payload, "resultFolder"));
  const failure = getDb()
    .prepare("SELECT * FROM failure_events WHERE run_id = ? ORDER BY datetime(ts) DESC, rowid DESC LIMIT 1")
    .get(runId) as FailureEventRow | undefined;

  return {
    runId,
    chatId: start.chat_id ?? stringPayload(startPayload, "chatId") ?? "",
    status,
    startedAt: start.ts,
    updatedAt: latest.ts,
    ...(terminal ? { finishedAt: terminal.ts } : {}),
    eventCount: rows.length,
    ...(settledPayload ? { resultFolder: stringPayload(settledPayload, "resultFolder") } : {}),
    ...(typeof startPayload.hasImages === "boolean" ? { hasImages: startPayload.hasImages } : {}),
    ...(stringArrayPayload(startPayload, "borrowAgents")
      ? { borrowAgents: stringArrayPayload(startPayload, "borrowAgents") }
      : {}),
    ...(failure?.error_code ? { errorCode: failure.error_code } : {}),
    ...(failure?.error_message
      ? { errorMessage: failure.error_message }
      : stringPayload(terminalPayload, "errorMessage")
        ? { errorMessage: stringPayload(terminalPayload, "errorMessage") }
        : {}),
  };
}

export function getLatestInvocationRunReceipt(chatId: string): InvocationRunReceipt | null {
  if (!chatId) return null;
  const row = getDb()
    .prepare(
      `SELECT run_id
       FROM run_events
       WHERE chat_id = ? AND kind = 'invoke_started'
       ORDER BY datetime(ts) DESC, rowid DESC
       LIMIT 1`,
    )
    .get(chatId) as { run_id?: string } | undefined;
  return row?.run_id ? getInvocationRunReceipt(row.run_id) : null;
}
