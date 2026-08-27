import { createHash, randomUUID } from "node:crypto";
import { externalToolNames } from "../../shared/tool-activity";
import { getDb } from "./db";
import type {
  FailureEventUi,
  InvocationRunReceipt,
  McpInvocationEvent,
  McpInvocationRequest,
  OrchestrationTarget,
  RunEventUi,
} from "../../shared/types";
import { parseDurableOneSurfaceJson } from "../../shared/one-surface-durable";
import { parseOneDomainEventJson } from "../../shared/one-domain-events";
import { isOneRecurrenceSelectionV1 } from "../../shared/one-recurrence";
import { emitDesktopStoreChange } from "./change-bus";
import { projectObservedTaskParticipantInDb } from "./task-participant-projection";

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

export const ONE_SURFACE_SNAPSHOT_EVENT_KIND = "one_surface_snapshot";
export const ONE_DOMAIN_EVENT_KIND = "one_domain_event";

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
    // OneSurface is already normalized and redacted by Main. Preserve its exact
    // JSON only after the closed durable contract passes again at the ledger
    // boundary; ordinary strings stay on the small diagnostic limit below.
    if (key === "oneSurfaceJson" && typeof value === "string") {
      if (parseDurableOneSurfaceJson(value)) out[key] = value;
      continue;
    }
    if (key === "oneDomainEventJson" && typeof value === "string") {
      if (parseOneDomainEventJson(value)) out[key] = value;
      continue;
    }
    if (key === "oneRecurrenceSelection") {
      if (isOneRecurrenceSelectionV1(value)) out[key] = { ...value };
      continue;
    }
    if (key === "noticeI18n") {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const notice = value as Record<string, unknown>;
      const ko = typeof notice.ko === "string" ? truncate(notice.ko, 800) : "";
      const en = typeof notice.en === "string" ? truncate(notice.en, 800) : "";
      if (ko && en) out[key] = { ko, en };
      continue;
    }
    // 채팅 타임라인 재방문용 증거 — 도구 인자·결과 미리보기·생각 요약은 800자로는
    // 잘려서 무의미해진다(diff 한 개, 명령 한 줄, 요약 두 문단). 상한만 다르게 둔다.
    // 비밀 마스킹(SECRET_RE)은 truncate 안에서 동일하게 적용된다.
    if (key === "reasoningText" && typeof value === "string") {
      out[key] = truncate(value, 4_000);
      continue;
    }
    if (key === "toolArgs" && typeof value === "string") {
      out[key] = truncate(value, 2_000);
      continue;
    }
    if (key === "toolResultPreview" && typeof value === "string") {
      out[key] = truncate(value, 1_200);
      continue;
    }
    // Typed Taskforce handoffs are already redacted and bounded by Main. Keep
    // their endpoint/status capsule intact so a later timeline replay does not
    // turn an exact peer result back into a misleading prefix-only preview.
    if (key === "agentMessageText" && typeof value === "string") {
      out[key] = truncate(value, 2_400);
      continue;
    }
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
  const payload = parsePayload(row.payload_json);
  // The generic ledger API is diagnostic and broadly renderer-visible. Exact
  // semantic results may leave Main only through the Task/run-bound restore
  // API, never through runLedger.events.
  if (row.kind === ONE_SURFACE_SNAPSHOT_EVENT_KIND) delete payload.oneSurfaceJson;
  if (row.kind === ONE_DOMAIN_EVENT_KIND) delete payload.oneDomainEventJson;
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
    payload,
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

/**
 * v74 agent usage ledger — live upsert on run attribution. use_count counts
 * distinct runs an agent participated in (first attributed event of the run
 * increments; later events only advance last_used_at), matching the v74
 * migration backfill (`COUNT(DISTINCT run_id)` over run_events).
 */
function bumpAgentUsage(agentId: string, runId: string, ts: string): void {
  const attributed = getDb()
    .prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND agent_id = ?")
    .get(runId, agentId) as { n?: number } | undefined;
  const isFirstForRun = Number(attributed?.n ?? 0) <= 1 ? 1 : 0;
  getDb().prepare(
    `INSERT INTO agent_usage (agent_key, kind, first_used_at, last_used_at, use_count)
     VALUES (?, 'agent', ?, ?, 1)
     ON CONFLICT(agent_key) DO UPDATE SET
       last_used_at = MAX(agent_usage.last_used_at, excluded.last_used_at),
       use_count = agent_usage.use_count + ?`,
  ).run(agentId, ts, ts, isFirstForRun);
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
  if (row.agent_id) {
    bumpAgentUsage(row.agent_id, row.run_id, row.ts);
    if (row.chat_id) {
      const projected = projectObservedTaskParticipantInDb(getDb(), {
        chatId: row.chat_id,
        observedAgentIdentity: row.agent_id,
        seenAt: row.ts,
      });
      if (projected.changed && projected.taskId) {
        emitDesktopStoreChange({ entity: "task", id: projected.taskId });
      }
    }
  }
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
  // Partial deltas and usage counters are high-frequency and remain live-only.
  // Reasoning boundaries are different: they contain no chain-of-thought text,
  // only start/end timing. Persist those typed facts so Activity does not lose
  // its Thought row after a route change or app restart.
  if (ev.kind === "partial" || ev.kind === "usage") return;
  // reasoning delta는 partial과 같은 고빈도 live 스트림 — end의 전문만 남긴다.
  if (ev.kind === "reasoning" && ev.reasoning?.phase === "delta") return;
  // The runtime-selected notice is a host fact, not model prose. Keep it in a
  // dedicated row so history can prove the provider/model that received the
  // prompt even when the run emits no tool call or fails immediately.
  if (ev.kind === "notice" && ev.notice?.code === "runtime-selected" && ev.runtimeSelection) {
    const selected = ev.runtimeSelection;
    tryRecordRunEvent({
      runId,
      kind: "runtime_selection",
      chatId: req.chatId,
      automationId: req.automationId ?? null,
      nodeId: ev.nodeId ?? null,
      agentId: ev.runtimeAgentId ?? ev.agentId,
      payload: {
        eventKind: "runtime-selected",
        runtimeRole: ev.modelRole ?? ev.role ?? "orchestrator",
        runtimeKind: selected.kind,
        runtimeBackend: selected.backend,
        runtimeSource: selected.source,
        runtimeModel: selected.model,
        runtimeLongContext: selected.longContext,
        runtimeEffort: selected.effort,
      },
    });
  }
  const payload = {
    eventKind: ev.kind,
    status: ev.status,
    activityCode: ev.activity?.code,
    phase: ev.phase,
    delegateTo: ev.delegateTo,
    // The row's agent_id remains the durable installed/runtime identity for
    // accounting. Preserve the orchestration node separately so replay can
    // reconnect a named worker to the same visible handoff edge.
    agentNodeId: ev.agentId,
    runtimeAgentId: ev.runtimeAgentId,
    role: ev.role,
    modelRole: ev.modelRole,
    agentName: ev.agentName,
    model: ev.model,
    runtimeKind: ev.runtimeSelection?.kind,
    runtimeBackend: ev.runtimeSelection?.backend,
    runtimeSource: ev.runtimeSelection?.source,
    runtimeModel: ev.runtimeSelection?.model,
    runtimeLongContext: ev.runtimeSelection?.longContext,
    runtimeEffort: ev.runtimeSelection?.effort,
    nodeState: ev.nodeState,
    surfaceId: ev.surfaceId,
    oneArtifacts: ev.oneArtifacts,
    toolName: ev.tool?.name,
    toolId: ev.tool?.id,
    toolIsError: ev.tool?.isError,
    // 재방문 시에도 "무엇을 어디에" 했는지 남는다 — 이름만 남기면 과거 턴의 행이
    // "Bash"·"Read"로만 보인다(2026-08-15 실측). 상한·마스킹은 safePayload가 건다.
    toolArgs: ev.tool?.args,
    toolResultPreview: ev.tool?.result,
    // Public HTTPS URLs are evidence references, not tool output content. Keep
    // them so the One Sources rail survives a route change or app restart.
    toolSourceUrls: ev.tool?.sourceUrls,
    noticeMessage: ev.notice?.message,
    noticeCode: ev.notice?.code,
    noticeDetails: ev.notice?.details,
    noticeDisplay: ev.notice?.display,
    noticeI18n: ev.notice?.i18n,
    noticeLevel: ev.notice?.level,
    textLen: ev.textLen ?? ev.text?.length,
    tokens: ev.tokens,
    lifecyclePhase: ev.lifecycle?.phase,
    // A lifecycle event may carry the host's absolute workspace path. The
    // ledger is renderer-visible and durable, so persist only the same
    // one-way project identity used by context-source receipts.
    lifecycleCwd: ev.lifecycle?.cwd
      ? projectContextKey(undefined, ev.lifecycle.cwd)
      : undefined,
    // The error row itself must say why — replay reads these to tell a user
    // stop ("cancelled") from a runtime failure.
    errorCode: ev.error?.code,
    errorMessage: ev.error?.message,
    reasoningPhase: ev.reasoning?.phase,
    reasoningDurationMs: ev.reasoning?.durationMs,
    // end에만 전문이 온다(delta는 live 전용 — 아래에서 원장에 안 남긴다).
    reasoningText: ev.reasoning?.phase === "end" ? ev.reasoning?.text : undefined,
    // Worker messaging and CLI process lifecycle are explicit durable facts.
    // Keep them flat in the diagnostic payload so old ledger readers can
    // replay the event without needing to understand a new nested schema.
    agentProcessSource: ev.agentLifecycle?.source,
    agentProcessState: ev.agentLifecycle?.state,
    agentProcessReason: ev.agentLifecycle?.reason,
    agentProcessRuntime: ev.agentLifecycle?.runtime,
    agentMessageId: ev.agentMessage?.messageId,
    agentMessageDirection: ev.agentMessage?.direction,
    agentMessageFrom: ev.agentMessage?.fromAgentId,
    agentMessageTo: ev.agentMessage?.toAgentId,
    agentMessageReplyTo: ev.agentMessage?.replyToMessageId,
    agentMessageText: ev.agentMessage?.text,
    agentMessageTools: ev.agentMessage?.usedTools,
    handoffDepth: ev.agentMessage?.handoffDepth,
    handoffRoundtrip: ev.agentMessage?.handoffRoundtrip,
    handoffPermission: ev.agentMessage?.handoffPermission,
    permissionInherited: ev.agentMessage?.permissionInherited,
    handoffBlocked: ev.agentMessage?.handoffBlocked,
    permissions: req.permissions,
    toolMode: req.toolMode,
    hubMode: req.hubMode,
    borrowAgents: req.borrowAgents,
  };
  tryRecordRunEvent({
    runId,
    kind: `mcp_${ev.kind}`,
    chatId: req.chatId,
    automationId: req.automationId ?? null,
    nodeId: ev.nodeId,
    agentId: ev.runtimeAgentId ?? ev.agentId,
    payload,
  });
  if (ev.kind === "error") {
    tryRecordFailureEvent({
      runId,
      source: "invoke",
      chatId: req.chatId,
      automationId: req.automationId ?? null,
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
      automationId: req.automationId ?? null,
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
      automationId: req.automationId ?? null,
      nodeId: ev.nodeId,
      agentId: ev.runtimeAgentId ?? ev.agentId,
      errorCode: "node_failed",
      errorMessage: ev.status || "Workflow node failed",
      payload,
    });
  }
}

export const AUTOMATION_RECOVERY_EVENT_KIND = "automation_recovery";

/**
 * Content-free recall observability marker. Records ONLY which recall source
 * actually entered a turn's prompt and its approximate injected token size —
 * never any value/content. Lets us prove after the fact that a given run read
 * pm_soul / code_map / sitemap / experience / memory, and lets the Dashboard
 * surface a per-project "was this source ever used" status. `projectKey` is a
 * value-free identity (`id:<uuid>` or `path:<hash>`), safe to persist.
 */
export const CONTEXT_SOURCE_EVENT_KIND = "context_source";

export type ContextSourceName =
  | "pm_soul"
  | "code_map"
  | "sitemap"
  | "experience"
  | "memory";

const CONTEXT_SOURCE_NAMES: ReadonlySet<string> = new Set([
  "pm_soul",
  "code_map",
  "sitemap",
  "experience",
  "memory",
]);

/** Stable, value-free project identity for context-source markers. */
export function projectContextKey(
  projectId: string | null | undefined,
  projectPath: string | null | undefined,
): string | null {
  if (typeof projectId === "string" && projectId.trim()) return `id:${projectId.trim()}`;
  if (typeof projectPath === "string" && projectPath.trim()) {
    const hash = createHash("sha256").update(projectPath.trim(), "utf8").digest("hex").slice(0, 24);
    return `path:${hash}`;
  }
  return null;
}

/** Record one content-free recall marker. Ledger failures never break the run. */
export function recordContextSourceMarker(input: {
  runId: string;
  chatId?: string | null;
  agentId?: string | null;
  source: ContextSourceName;
  approxTokens: number;
  projectKey?: string | null;
}): void {
  if (!input.runId || !CONTEXT_SOURCE_NAMES.has(input.source)) return;
  tryRecordRunEvent({
    runId: input.runId,
    kind: CONTEXT_SOURCE_EVENT_KIND,
    chatId: input.chatId ?? null,
    agentId: input.agentId ?? null,
    payload: {
      source: input.source,
      approxTokens: Math.max(0, Math.trunc(input.approxTokens)),
      ...(input.projectKey ? { projectKey: input.projectKey } : {}),
    },
  });
}

/**
 * Distinct recall sources injected for one project since `sinceIso` (inclusive),
 * derived from content-free `context_source` markers. Powers the Dashboard
 * "project memory status" panel without touching any project content.
 */
export function listRecentContextSourcesForProject(
  projectKey: string,
  sinceIso: string,
): Set<ContextSourceName> {
  const used = new Set<ContextSourceName>();
  if (!projectKey) return used;
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT json_extract(payload_json, '$.source') AS source
         FROM run_events
        WHERE kind = ?
          AND json_extract(payload_json, '$.projectKey') = ?
          AND ts >= ?`,
    )
    .all(CONTEXT_SOURCE_EVENT_KIND, projectKey, sinceIso) as Array<{ source: string | null }>;
  for (const row of rows) {
    if (row.source && CONTEXT_SOURCE_NAMES.has(row.source)) {
      used.add(row.source as ContextSourceName);
    }
  }
  return used;
}

/**
 * 런 시작이 append-only 원장에 남았는지 — 채팅 인보크는 'invoke_started',
 * 자동화 그래프 런은 'workflow_graph_started', 레거시 자동화는 'automation_legacy_started'.
 * outcome-attested 경험 승격의 증거 게이트로 쓴다(어느 실행 표면이든 durable 시작 영수증 필수).
 */
export function hasDurableRunStartReceipt(runId: string): boolean {
  if (!runId) return false;
  const row = getDb()
    .prepare(
      `SELECT 1 AS found FROM run_events
        WHERE run_id = ? AND kind IN ('invoke_started','workflow_graph_started','automation_legacy_started')
        LIMIT 1`,
    )
    .get(runId) as { found?: number } | undefined;
  return row?.found === 1;
}

/**
 * 같은 실패 서명(fsig)이 방법 전환으로 복구된 횟수 — 자율 진화 임계(N회 독립 성공 시
 * 프롬프트 진화 자동 적용) 판정에 쓴다. payload는 safePayload로 직렬화된 JSON이므로
 * json_extract로 서명을 정확 일치시킨다(LIKE 부분일치 오탐 방지).
 */
export function countAutomationRecoveryEvents(automationId: string, signature: string): number {
  if (!automationId || !signature) return 0;
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM run_events
        WHERE automation_id = ? AND kind = ?
          AND json_extract(payload_json, '$.signature') = ?`,
    )
    .get(automationId, AUTOMATION_RECOVERY_EVENT_KIND, signature) as { n?: number } | undefined;
  return row?.n ?? 0;
}

/**
 * 사용자 스티어링(실행 중 방향 수정) 신호 — 같은 에이전트를 반복 교정하면 진화 제안
 * 트리거의 근거가 된다. content-free: 원문 없이 chat/agent/run 귀속만 남긴다.
 */
export const USER_STEERING_EVENT_KIND = "user_steering";

/**
 * 이 에이전트의 최근 실패 원문(정규화 전) — 진화 트리거가 실패 서명별로 그룹핑한다.
 * failure_events는 이미 secret/URL이 스크럽된 truncate 문자열이다. run_id가 있는
 * 행만 반환해 "서로 다른 런에서 같은 실패가 반복"을 셀 수 있게 한다.
 */
export function listRecentAgentFailures(
  agentId: string,
  limit = 200,
): Array<{ runId: string; errorMessage: string }> {
  if (!agentId) return [];
  const capped = Math.max(1, Math.min(1000, Math.floor(limit)));
  const rows = getDb()
    .prepare(
      `SELECT run_id, error_message FROM failure_events
        WHERE agent_id = ? AND run_id IS NOT NULL
        ORDER BY datetime(ts) DESC LIMIT ?`,
    )
    .all(agentId, capped) as Array<{ run_id: string | null; error_message: string }>;
  return rows
    .filter((row): row is { run_id: string; error_message: string } => Boolean(row.run_id))
    .map((row) => ({ runId: row.run_id, errorMessage: row.error_message }));
}

/**
 * 이 에이전트를 대상으로 최근 관측된 사용자 스티어링(교정) 횟수 — content-free 카운터.
 * chatId를 주면 그 대화 창 안으로 한정한다(대화별 반복 교정 트리거).
 */
export function countAgentSteeringEvents(agentId: string, chatId?: string | null): number {
  if (!agentId) return 0;
  const clauses = ["agent_id = ?", "kind = ?"];
  const params: unknown[] = [agentId, USER_STEERING_EVENT_KIND];
  if (chatId) {
    clauses.push("chat_id = ?");
    params.push(chatId);
  }
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM run_events WHERE ${clauses.join(" AND ")}`)
    .get(...params) as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

/**
 * 이 실행에서 **호스트가 관측한** 도구 호출. 모델의 산문이 아니라 원장에서 읽는다.
 *
 * ★왜 필요한가(실측 2026-08-19): X 게시 자동화가 "successfully posted and confirmed"
 * 라고 답했고 판정기가 그 문장만 읽어 12연속 accepted 를 냈다. 실제 게시 0건, 그리고
 * 그 실행들의 도구 호출도 0건이었다. 도구를 하나도 안 부르고 바깥을 바꿀 수는 없다.
 */
export function observedToolActivity(runId: string): { callCount: number; toolNames: string[] } {
  if (!runId) return { callCount: 0, toolNames: [] };
  // run_events 에 title 컬럼은 없다(db.ts 의 CREATE TABLE 이 정본) — 이름은 payload 에만 있다.
  const rows = getDb()
    .prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND kind = 'mcp_tool-use' ORDER BY seq ASC LIMIT 500")
    .all(runId) as { payload_json: string | null }[];
  const raw: string[] = [];
  for (const row of rows) {
    try {
      const payload = row.payload_json ? JSON.parse(row.payload_json) : null;
      // 실측 payload 는 {"eventKind":"tool-use","toolName":…} — toolName 이 정본, 옛 모양은 폴백.
      const name = payload?.toolName ?? payload?.tool?.name ?? payload?.name;
      if (typeof name === "string" && name.trim()) raw.push(name.trim().slice(0, 120));
    } catch {
      /* payload 가 깨졌어도 이름 없는 이벤트는 근거가 못 된다 — 세지 않는다 */
    }
  }
  // ★호스트 자신의 예비 조회는 "일했다"의 근거가 아니다. 2026-08-19 실측: 게시 0건인 실행이
  //   Agentlas Plugins · universe/auto-select/Hub bridge 6건만 남겼는데 판정이 그걸 근거로
  //   "3건 모두 게시했고 도구 활동이 뒷받침한다"고 확인해 줬다. 판단은 shared/tool-activity 정본.
  const external = externalToolNames(raw);
  return { callCount: external.length, toolNames: [...new Set(external)] };
}

export function listRunEvents(runId: string, limit?: number): RunEventUi[] {
  if (!runId) return [];
  const capped = normalizeLimit(limit, 200);
  const rows = getDb()
    .prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY seq ASC LIMIT ?")
    .all(runId, capped) as RunEventRow[];
  return rows.map(runRowToUi);
}

/**
 * Every run this conversation started, oldest first, each with its own bounded
 * event window — the raw material for One's per-turn "Worked for Ns" blocks.
 *
 * `invoke_started` rows are the authority for "which runs belong to this chat".
 * A run that has only a start row (interrupted) still returns, so a turn whose
 * process was cut off keeps its evidence instead of vanishing from the thread.
 */
export function listChatRunTimeline(
  chatId: string,
  input: { maxRuns?: number; eventsPerRun?: number } = {},
): Array<{ receipt: InvocationRunReceipt; events: RunEventUi[] }> {
  if (!chatId) return [];
  const maxRuns = normalizeLimit(input.maxRuns, 40);
  const eventsPerRun = normalizeLimit(input.eventsPerRun, 400);
  const rows = getDb()
    .prepare(
      `SELECT run_id
       FROM run_events
       WHERE chat_id = ? AND kind = 'invoke_started'
       ORDER BY ts DESC, rowid DESC
       LIMIT ?`,
    )
    .all(chatId, maxRuns) as Array<{ run_id: string }>;
  const out: Array<{ receipt: InvocationRunReceipt; events: RunEventUi[] }> = [];
  for (const row of rows.reverse()) {
    const receipt = getInvocationRunReceipt(row.run_id);
    if (!receipt) continue;
    out.push({ receipt, events: listRunEvents(row.run_id, eventsPerRun) });
  }
  return out;
}

export function listFailureEvents(input: {
  runId?: string;
  automationId?: string;
  chatId?: string;
  agentId?: string;
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
  if (input.agentId) {
    clauses.push("agent_id = ?");
    params.push(input.agentId);
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

/** Closed enum. An unknown value is treated as absent so recovery fails safe. */
function executionPermissionPayload(
  payload: Record<string, unknown>,
): InvocationRunReceipt["executionPermission"] {
  const value = payload.permissions;
  return value === "read" || value === "write" || value === "full" ? value : undefined;
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

function orchestrationTargetsPayload(payload: Record<string, unknown>): OrchestrationTarget[] | undefined {
  const value = payload.taskForceTargets;
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return undefined;
  const out: OrchestrationTarget[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const target = raw as Record<string, unknown>;
    const source = target.source;
    const kind = target.entityKind;
    if (source === "local" && kind === "agent" && typeof target.agentId === "string") out.push({ source, entityKind: kind, agentId: target.agentId });
    else if (source === "local" && kind === "team" && typeof target.firmId === "string") out.push({ source, entityKind: kind, firmId: target.firmId });
    else if ((source === "cloud" || source === "hub") && (kind === "agent" || kind === "team") && typeof target.slug === "string") out.push({ source, entityKind: kind, slug: target.slug });
    else return undefined;
  }
  return out;
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
  // 원래는 reverse().map(parse)가 결과를 찾은 뒤에도 **모든** payload를 eager하게
  // 파싱했다. 뒤에서부터 찾고 발견 즉시 멈춘다.
  let settledPayload: Record<string, unknown> | undefined;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const payload = parsePayload(rows[index].payload_json);
    if (stringPayload(payload, "resultFolder")) {
      settledPayload = payload;
      break;
    }
  }
  const failure = getDb()
    .prepare("SELECT * FROM failure_events WHERE run_id = ? ORDER BY datetime(ts) DESC, rowid DESC LIMIT 1")
    .get(runId) as FailureEventRow | undefined;

  // 표시=실행 (계약 7-C-8 / C-D-1): 이 실행이 실제로 돈 모델은 원장의
  // final/invoke_result 행에만 있다. 설정의 "현재 기본값"은 과거 실행의
  // 증빙이 아니므로 receipt가 원장 값을 직접 나른다.
  let executedModel = stringPayload(terminalPayload, "model");
  if (!executedModel) {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (row.kind !== "mcp_final" && row.kind !== "invoke_result") continue;
      const payload = parsePayload(row.payload_json);
      const modelValue = stringPayload(payload, "model");
      const role = stringPayload(payload, "modelRole");
      if (modelValue && (!role || role === "orchestrator")) {
        executedModel = modelValue;
        break;
      }
    }
  }

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
    ...(orchestrationTargetsPayload(startPayload)
      ? { taskForceTargets: orchestrationTargetsPayload(startPayload) }
      : {}),
    ...(executionPermissionPayload(startPayload)
      ? { executionPermission: executionPermissionPayload(startPayload) }
      : {}),
    ...(executedModel ? { model: executedModel } : {}),
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
      // ts는 항상 nowIso() 산출 ISO-8601이라 사전순=시간순. datetime() 래핑은
      // 인덱스(idx_run_events_chat_kind_ts)를 못 타게 해 원장 풀스캔을 강제했다.
      `SELECT run_id
       FROM run_events
       WHERE chat_id = ? AND kind = 'invoke_started'
       ORDER BY ts DESC, rowid DESC
       LIMIT 1`,
    )
    .get(chatId) as { run_id?: string } | undefined;
  return row?.run_id ? getInvocationRunReceipt(row.run_id) : null;
}

/**
 * Whether this chat was created or used through Agentlas One.
 *
 * The durable invocation-start receipt is the authority here. Agent names,
 * chat titles, and Task presence are deliberately not used because the same
 * coordinator can also appear in Work and a general One conversation can stay
 * Task-free.
 */
export function isOneInvocationChat(chatId: string): boolean {
  if (!chatId) return false;
  const rows = getDb()
    .prepare(
      `SELECT payload_json
       FROM run_events
       WHERE chat_id = ? AND kind = 'invoke_started'
       ORDER BY ts DESC, rowid DESC
       LIMIT 100`,
    )
    .all(chatId) as Array<{ payload_json: string }>;
  return rows.some((row) => parsePayload(row.payload_json).oneMode === true);
}

/** Durable origin proof used only to resume Main-owned Mobile One recovery. */
export function isMobileOneInvocationChat(chatId: string): boolean {
  if (!chatId) return false;
  const row = getDb()
    .prepare(
      `SELECT payload_json
       FROM run_events
       WHERE chat_id = ? AND kind = 'invoke_started'
       ORDER BY ts DESC, rowid DESC
       LIMIT 1`,
    )
    .get(chatId) as { payload_json?: string } | undefined;
  return row?.payload_json
    ? parsePayload(row.payload_json).invocationSource === "mobile-one"
    : false;
}

/**
 * 직전 턴이 실제로 얼마나 무거웠는가 — 관측치.
 *
 * 이 값이 이번 턴 편성의 근거다. 요청 문장을 해석하지 않는다. 실사용 558턴 실측에서
 * 단어 신호로 무거운 턴을 맞힌 비율은 21.7%였고(가벼운 턴 130건 중 115건은 잘못
 * 올렸다), 같은 코퍼스에서 "직전 턴이 무거웠으면 이번 턴도 무겁다"는 재현율 88.5%
 * 정밀도 87.2%였다. 전체 턴의 86%가 후속 턴이므로 이 신호 하나가 거의 전부를 덮는다.
 *
 * 라벨과 예측이 같은 턴의 같은 변수에서 나오면 그것은 성능이 아니라 산수다. 여기서는
 * **직전 턴**을 보고 **이번 턴**을 정하므로 서로 다른 관측이다.
 *
 * 임계값을 여기서 정하지 않는다 — 원자료만 돌려주고, 무겁다는 판정은 호출자가 자기
 * 정책으로 내린다. 나중에 이 판정이 학습된 값으로 바뀔 자리다.
 */
export interface PreviousTurnObservation {
  /** 직전 완료 턴에서 실제로 호출된 도구 수. */
  toolCalls: number;
  /** 직전 턴이 실제로 걸린 초. */
  seconds: number;
  /** 실행 중 실패·취소·재시도가 있었는가. 보상 신호이자 승급 근거. */
  hadTrouble: boolean;
  /** 직전 턴이 실제로 여러 에이전트로 실행됐는가. */
  ranAsTeam: boolean;
  /** 관측 자체가 없으면 null — 첫 턴은 예측하지 않는다. */
  observedAt: string | null;
}

export function previousTurnObservation(chatId: string): PreviousTurnObservation | null {
  const id = String(chatId ?? "").trim();
  if (!id) return null;
  const db = getDb();
  const latest = db
    .prepare(
      `SELECT run_id FROM run_events
        WHERE chat_id = ? AND kind = 'invoke_started'
        ORDER BY ts DESC LIMIT 1`,
    )
    .get(id) as { run_id?: string } | undefined;
  const runId = latest?.run_id;
  if (!runId) return null;
  const rows = db
    .prepare("SELECT kind, ts FROM run_events WHERE run_id = ? ORDER BY seq ASC")
    .all(runId) as Array<{ kind: string; ts: string }>;
  if (rows.length === 0) return null;

  let toolCalls = 0;
  let hadTrouble = false;
  let ranAsTeam = false;
  for (const row of rows) {
    if (row.kind === "mcp_tool-use") toolCalls += 1;
    else if (
      row.kind === "mcp_error"
      || row.kind === "invoke_failed"
      || row.kind === "invoke_threw"
      || row.kind === "invoke_cancel_requested"
      || row.kind === "invoke_cancelled"
      || row.kind === "workflow_node_retry"
    ) hadTrouble = true;
    else if (
      row.kind === "swarm_started"
      || row.kind === "task_force_execution_receipt"
      || row.kind === "task_force_model_call_started"
    ) ranAsTeam = true;
  }
  const first = Date.parse(rows[0].ts);
  const last = Date.parse(rows[rows.length - 1].ts);
  const seconds = Number.isFinite(first) && Number.isFinite(last) && last >= first
    ? Math.round((last - first) / 1000)
    : 0;
  return { toolCalls, seconds, hadTrouble, ranAsTeam, observedAt: rows[rows.length - 1].ts };
}
