// 자동화 — SQLite 영속 + 스케줄 next-run 계산. (이전 M0 in-memory stub 대체)
// targetType: agent(개별 에이전트) | firm(CEO 호출). createdBy: user(폼) | agent(채팅 emitter).
// 실제 실행은 automation-scheduler.ts가 dueAutomations()를 폴링해 백그라운드 chat으로 돌린다.
//
// v33: next-run 계산을 schedule.ts(croner)에 위임한다. computeNextRun은 이제 string|null을
// 반환하며(null=미래 발생 없음 → 종료), markAutomationRun은 misfire coalesce 정책 + run_history
// 기록 + max_runs/end_at 종료를 적용한다. graph_json/schedule_json/timezone은 additive.
import { randomUUID } from "node:crypto";
import { AUTOMATION_RUN_STALE_AFTER_MS, getDb } from "./db";
import { nextRun, specFromStored, defaultTz } from "./schedule";
import { resolveAutomationToolMode } from "../../shared/automation-tool-policy";
import { MAX_AUTOMATION_ACTIVE_TOOL_STALL_MS } from "../automation-watchdog";
import type {
  Automation,
  AutomationHubMode,
  AutomationTargetType,
  WorkflowGraph,
  AutomationRunRecord,
  AutomationToolMode,
  AutomationUpdatePatch,
  Trigger,
  TriggerKind,
  WorkflowNodeRunState,
  WorkflowRunSnapshot,
} from "../../shared/types";

interface AutomationRow {
  id: string;
  name: string;
  schedule: string;
  target_type: AutomationTargetType;
  target_id: string;
  prompt_template: string;
  tool_mode: string | null;
  hub_mode: string | null;
  enabled: number;
  created_by: "user" | "agent";
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  graph_json: string | null;
  schedule_json: string | null;
  timezone: string | null;
  end_at: string | null;
  max_runs: number | null;
  run_count: number;
  trigger_type: string | null;
  trigger_json: string | null;
  claimed_at: string | null;
  lease_owner: string | null;
}

interface RunHistoryRow {
  id: string;
  automation_id: string | null;
  scheduled_for: string | null;
  ran_at: string | null;
  status: string | null;
  skipped_count: number | null;
  error: string | null;
}

function parseGraph(raw: string | null): WorkflowGraph | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as WorkflowGraph;
    if (parsed && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) return parsed;
  } catch {
    /* ignore malformed */
  }
  return null;
}

function parseTrigger(raw: string | null): Trigger | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Trigger;
    if (parsed && typeof parsed === "object" && typeof (parsed as { kind?: unknown }).kind === "string") {
      return parsed;
    }
  } catch {
    /* ignore malformed */
  }
  return null;
}

function normalizeToolMode(value: string | null | undefined): AutomationToolMode {
  return value === "browser" || value === "computer-use" || value === "auto" ? value : "auto";
}

function normalizeHubMode(value: string | null | undefined): AutomationHubMode {
  return value === "hub-first" || value === "local-only" || value === "hub-allowed" ? value : "hub-allowed";
}

function toAutomation(row: AutomationRow): Automation {
  const tz = row.timezone || defaultTz();
  const spec = specFromStored(row.schedule_json ?? row.schedule, tz);
  const triggerType = (row.trigger_type as TriggerKind) || "schedule";
  return {
    id: row.id,
    name: row.name,
    scheduleHuman: row.schedule,
    targetType: row.target_type,
    targetId: row.target_id,
    promptTemplate: row.prompt_template,
    toolMode: normalizeToolMode(row.tool_mode),
    hubMode: normalizeHubMode(row.hub_mode),
    enabled: !!row.enabled,
    createdBy: row.created_by,
    createdAt: row.created_at,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    graph: parseGraph(row.graph_json),
    timezone: row.timezone,
    scheduleSpec: spec,
    triggerType,
    trigger: parseTrigger(row.trigger_json),
  };
}

/**
 * 저장된 스케줄(schedule_json 우선, 없으면 레거시 schedule 토큰) 기준 from 이후 다음 실행 시각.
 * 미래 발생이 없으면 null(종료 상태). schedule.ts nextRun에 위임한다(croner tz/DST).
 * timezone 인자로 cron 해석 존을 전달한다.
 */
export function computeNextRun(
  schedule: string,
  from: Date = new Date(),
  opts?: { scheduleJson?: string | null; timezone?: string | null },
): string | null {
  const tz = opts?.timezone || defaultTz();
  const stored = opts?.scheduleJson && opts.scheduleJson.trim() ? opts.scheduleJson : schedule;
  const spec = specFromStored(stored, tz);
  if (!spec) {
    // 알 수 없는 토큰 — 레거시 폴백(24h)으로 최소한 살려둔다.
    return new Date(from.getTime() + 24 * 3600 * 1000).toISOString();
  }
  return nextRun(spec, from);
}

export function listAutomations(): Automation[] {
  const rows = getDb()
    .prepare("SELECT * FROM automations ORDER BY created_at DESC")
    .all() as AutomationRow[];
  return rows.map(toAutomation);
}

export function getAutomation(id: string): Automation | null {
  const row = getDb().prepare("SELECT * FROM automations WHERE id = ?").get(id) as AutomationRow | undefined;
  return row ? toAutomation(row) : null;
}

export function createAutomation(input: {
  name: string;
  scheduleHuman: string;
  targetType: AutomationTargetType;
  targetId: string;
  promptTemplate: string;
  createdBy?: "user" | "agent";
  graphJson?: string | WorkflowGraph | null;
  scheduleJson?: string | null;
  timezone?: string | null;
  endAt?: string | null;
  maxRuns?: number | null;
  triggerType?: TriggerKind;
  trigger?: Trigger | null;
  toolMode?: AutomationToolMode;
  hubMode?: AutomationHubMode;
}): Automation {
  const id = randomUUID();
  const now = new Date();
  const tz = input.timezone || defaultTz();
  const scheduleJson = input.scheduleJson && input.scheduleJson.trim() ? input.scheduleJson : null;
  const graphJson =
    input.graphJson == null
      ? null
      : typeof input.graphJson === "string"
        ? input.graphJson
        : JSON.stringify(input.graphJson);
  const triggerType: TriggerKind = input.triggerType ?? "schedule";
  const triggerJson = input.trigger ? JSON.stringify(input.trigger) : null;
  // 이벤트 계열 트리거(fs/chain/webhook)는 시계가 없다 → next_run_at은 null(스케줄러가 안 뜸,
  // 트리거 매니저의 리스너가 발사한다). schedule/poll만 시각 계산.
  const timeDriven = triggerType === "schedule";
  const nextRunAt = timeDriven
    ? computeNextRun(input.scheduleHuman, now, { scheduleJson, timezone: tz })
    : null;
  getDb()
    .prepare(
      `INSERT INTO automations
         (id, name, schedule, target_type, target_id, prompt_template, enabled, created_by,
          last_run_at, next_run_at, created_at, graph_json, schedule_json, timezone, end_at, max_runs, run_count,
          trigger_type, trigger_json, tool_mode, hub_mode)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.name.trim() || "Automation",
      input.scheduleHuman,
      input.targetType,
      input.targetId,
      input.promptTemplate,
      input.createdBy ?? "user",
      nextRunAt,
      now.toISOString(),
      graphJson,
      scheduleJson,
      tz,
      input.endAt ?? null,
      input.maxRuns ?? null,
      triggerType,
      triggerJson,
      resolveAutomationToolMode({
        toolMode: normalizeToolMode(input.toolMode),
        name: input.name,
        promptTemplate: input.promptTemplate,
        targetLabel: input.targetType,
      }),
      normalizeHubMode(input.hubMode),
    );
  return getAutomation(id) as Automation;
}

/**
 * 기존 자동화를 in-place 수정한다(설계 한계 #7 — 삭제-재생성 회피).
 * 스케줄/타임존/트리거가 바뀌면 next_run_at을 지금 기준으로 재계산한다(과거 발화 방지).
 */
export function updateAutomation(id: string, patch: AutomationUpdatePatch): Automation {
  const existing = getAutomation(id);
  if (!existing) throw new Error(`Automation not found: ${id}`);
  const db = getDb();
  const row = db.prepare("SELECT * FROM automations WHERE id = ?").get(id) as AutomationRow;

  const name = patch.name != null ? patch.name.trim() || "Automation" : row.name;
  const scheduleHuman = patch.scheduleHuman ?? row.schedule;
  const targetType = patch.targetType ?? row.target_type;
  const targetId = patch.targetId ?? row.target_id;
  const promptTemplate = patch.promptTemplate ?? row.prompt_template;
  const toolMode = resolveAutomationToolMode({
    toolMode: normalizeToolMode(patch.toolMode ?? row.tool_mode),
    name,
    promptTemplate,
    targetLabel: targetType,
  });
  const hubMode = normalizeHubMode(patch.hubMode ?? row.hub_mode);
  const timezone = patch.timezone !== undefined ? patch.timezone : row.timezone;
  const tz = timezone || defaultTz();
  const scheduleJson =
    patch.scheduleJson !== undefined
      ? patch.scheduleJson && patch.scheduleJson.trim()
        ? patch.scheduleJson
        : null
      : row.schedule_json;
  const endAt = patch.endAt !== undefined ? patch.endAt : row.end_at;
  const maxRuns = patch.maxRuns !== undefined ? patch.maxRuns : row.max_runs;
  const triggerType: TriggerKind = patch.triggerType ?? ((row.trigger_type as TriggerKind) || "schedule");
  const triggerJson =
    patch.trigger !== undefined ? (patch.trigger ? JSON.stringify(patch.trigger) : null) : row.trigger_json;

  const timeDriven = triggerType === "schedule";
  const nextRunAt = timeDriven
    ? computeNextRun(scheduleHuman, new Date(), { scheduleJson, timezone: tz })
    : null;

  db.prepare(
    `UPDATE automations SET
       name = ?, schedule = ?, target_type = ?, target_id = ?, prompt_template = ?,
       tool_mode = ?, hub_mode = ?,
       schedule_json = ?, timezone = ?, end_at = ?, max_runs = ?, trigger_type = ?, trigger_json = ?,
       next_run_at = ?
     WHERE id = ?`,
  ).run(
    name,
    scheduleHuman,
    targetType,
    targetId,
    promptTemplate,
    toolMode,
    hubMode,
    scheduleJson,
    tz,
    endAt,
    maxRuns,
    triggerType,
    triggerJson,
    nextRunAt,
    id,
  );
  return getAutomation(id) as Automation;
}

export function toggleAutomation(id: string, enabled: boolean): Automation {
  const existing = getAutomation(id);
  if (!existing) throw new Error(`Automation not found: ${id}`);
  // 다시 켤 때는 과거 시각으로 즉시 발화하지 않도록 next_run_at을 지금 기준으로 재계산.
  // 단 시간 트리거일 때만 — 이벤트 트리거(fs/chain/poll/webhook)는 시계가 없어 next_run_at을
  // null로 유지해야 한다(그러지 않으면 재활성화 즉시 daily 시계로 승격되는 버그).
  const timeDriven = existing.triggerType === "schedule";
  const nextRunAt =
    enabled && timeDriven
      ? computeNextRun(existing.scheduleHuman, new Date(), {
          scheduleJson: existing.scheduleSpec ? JSON.stringify(existing.scheduleSpec) : null,
          timezone: existing.timezone,
        })
      : existing.nextRunAt;
  getDb()
    .prepare("UPDATE automations SET enabled = ?, next_run_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, nextRunAt, id);
  return getAutomation(id) as Automation;
}

export function removeAutomation(id: string): void {
  const db = getDb();
  const remove = db.transaction(() => {
    // These projection tables predate foreign-key cascades. Delete the hidden
    // target-scoped chats and histories in the same commit as the parent so a
    // removed automation cannot leave messages, unreachable history, or a
    // forever-running canvas row behind.
    const chatMarker = `⟦automation⟧${id}`;
    const escapedChatMarker = chatMarker.replace(/[!%_]/g, (character) => `!${character}`);
    db.prepare(
      "DELETE FROM chats WHERE kind = 'division' AND (title = ? OR title LIKE ? ESCAPE '!')",
    ).run(chatMarker, `${escapedChatMarker}::%`);
    db.prepare("DELETE FROM automation_runs WHERE automation_id = ?").run(id);
    db.prepare("DELETE FROM run_history WHERE automation_id = ?").run(id);
    db.prepare("DELETE FROM automations WHERE id = ?").run(id);
  });
  remove.immediate();
}

/** 저장된 그래프를 갱신(그래프 편집/생성 경로). null이면 그래프 제거(단일 프롬프트로 복귀). */
export function updateAutomationGraph(id: string, graph: WorkflowGraph | null): Automation {
  const existing = getAutomation(id);
  if (!existing) throw new Error(`Automation not found: ${id}`);
  getDb()
    .prepare("UPDATE automations SET graph_json = ? WHERE id = ?")
    .run(graph ? JSON.stringify(graph) : null, id);

  // 트리거 노드에서 편집한 스케줄(scheduleSpec/schedule)을 실제 발사 컬럼에 동기화한다.
  // graph_json만 쓰면 캔버스에는 새 스케줄이 보이는데 스케줄러(next_run_at)는 옛 시각으로
  // 발사하는 사일런트 괴리가 생긴다. 이벤트 트리거는 시계 승격 금지 규칙 그대로 제외.
  if (graph && existing.triggerType === "schedule") {
    const trigger = graph.nodes.find((n) => n.type === "trigger");
    const cfg = trigger?.config ?? {};
    const spec = cfg.scheduleSpec;
    const hasSpec = !!spec && typeof spec === "object" && typeof (spec as { kind?: unknown }).kind === "string";
    const specJson = hasSpec ? JSON.stringify(spec) : null;
    const token = typeof cfg.schedule === "string" && cfg.schedule.trim() ? cfg.schedule.trim() : null;
    const row = getDb().prepare("SELECT schedule, schedule_json FROM automations WHERE id = ?").get(id) as {
      schedule: string;
      schedule_json: string | null;
    };
    if (hasSpec && specJson !== row.schedule_json) {
      updateAutomation(id, { scheduleJson: specJson, ...(token ? { scheduleHuman: token } : {}) });
    } else if (!hasSpec && token && token !== row.schedule) {
      // 스펙 없이 레거시 토큰만 바뀐 경우(합성 그래프 편집 등) — 토큰을 진실로 삼고 stale spec 제거.
      updateAutomation(id, { scheduleHuman: token, scheduleJson: null });
    }
  }
  return getAutomation(id) as Automation;
}

// ── automation_runs — 그래프 라이브 실행 per-node 상태(설계 §5 P2) ───────────
// run_history와 별개: 이쪽은 캔버스 라이브 오버레이의 재하이드레이트용(1 run = 1 행).
interface AutomationRunSnapshotRow {
  id: string;
  automation_id: string | null;
  started_at: string | null;
  last_activity_at: string | null;
  status: string | null;
  node_states_json: string | null;
}

export class AutomationRunParentMissingError extends Error {
  readonly code = "automation_parent_missing";

  constructor(readonly automationId: string) {
    super(`Automation not found: ${automationId}`);
    this.name = "AutomationRunParentMissingError";
  }
}

export function isAutomationRunParentMissingError(error: unknown): error is AutomationRunParentMissingError {
  return error instanceof AutomationRunParentMissingError ||
    (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "automation_parent_missing");
}

/**
 * Cross-process destructive guard. The GUI's in-memory `running` set cannot
 * see an optional headless runner, so deletion also checks its durable lease
 * and fresh running snapshot before removing the shared parent row.
 */
export function hasDurableActiveAutomationExecution(id: string, now: Date = new Date()): boolean {
  const db = getDb();
  const parent = db.prepare(
    "SELECT claimed_at, lease_owner FROM automations WHERE id = ?",
  ).get(id) as { claimed_at: string | null; lease_owner: string | null } | undefined;
  if (!parent) return false;

  if (parent.claimed_at != null) {
    const claimedAtMs = Date.parse(parent.claimed_at);
    if (!Number.isFinite(claimedAtMs)) return true;
    const ageMs = now.getTime() - claimedAtMs;
    if (ageMs <= AUTOMATION_LEASE_TTL_MS) return true;
    const ownerPid = trustedAutomationLeasePid(parent.lease_owner);
    if (ownerPid != null && ageMs <= AUTOMATION_LIVE_OWNER_GUARD_MS && isProcessAlive(ownerPid)) {
      return true;
    }
  }

  const activeRun = db.prepare(
    `SELECT COALESCE(last_activity_at, started_at) AS active_at
     FROM automation_runs
     WHERE automation_id = ? AND status = 'running'
     ORDER BY COALESCE(last_activity_at, started_at) DESC
     LIMIT 1`,
  ).get(id) as { active_at: string | null } | undefined;
  if (!activeRun) return false;
  if (!activeRun.active_at) return true;
  const activeAtMs = Date.parse(activeRun.active_at);
  if (!Number.isFinite(activeAtMs)) return true;
  return now.getTime() - activeAtMs <= AUTOMATION_RUN_STALE_AFTER_MS;
}

/** 그래프 실행 시작 시 automation_runs 행 생성(상태 running). node_states는 초기 pending 맵. */
export function startGraphRun(input: {
  runId: string;
  automationId: string;
  nodeIds: string[];
  startedAt?: string;
}): void {
  const nodeStates: Record<string, WorkflowNodeRunState> = {};
  for (const id of input.nodeIds) nodeStates[id] = "pending";
  const startedAt = input.startedAt ?? new Date().toISOString();
  const inserted = getDb()
    .prepare(
      `INSERT INTO automation_runs
         (id, automation_id, started_at, last_activity_at, status, node_states_json)
       SELECT ?, ?, ?, ?, 'running', ?
       WHERE EXISTS (SELECT 1 FROM automations WHERE id = ?)`,
    )
    .run(
      input.runId,
      input.automationId,
      startedAt,
      startedAt,
      JSON.stringify(nodeStates),
      input.automationId,
    );
  if (inserted.changes !== 1) throw new AutomationRunParentMissingError(input.automationId);
}

/** 실행 중 노드 상태 갱신(running/done/failed/skipped). 행이 없으면 조용히 무시. */
export function updateGraphRunNode(runId: string, nodeId: string, state: WorkflowNodeRunState): void {
  const db = getDb();
  const row = db
    .prepare("SELECT node_states_json FROM automation_runs WHERE id = ? AND status = 'running'")
    .get(runId) as { node_states_json: string | null } | undefined;
  if (!row) return;
  let states: Record<string, WorkflowNodeRunState> = {};
  try {
    states = row.node_states_json ? (JSON.parse(row.node_states_json) as Record<string, WorkflowNodeRunState>) : {};
  } catch {
    states = {};
  }
  states[nodeId] = state;
  db.prepare(
    "UPDATE automation_runs SET node_states_json = ?, last_activity_at = ? WHERE id = ? AND status = 'running'",
  ).run(JSON.stringify(states), new Date().toISOString(), runId);
}

/** Persist throttled runtime progress even when the event is renderer-only partial output. */
export function touchGraphRun(runId: string, at: Date = new Date()): boolean {
  const result = getDb()
    .prepare("UPDATE automation_runs SET last_activity_at = ? WHERE id = ? AND status = 'running'")
    .run(at.toISOString(), runId);
  return result.changes > 0;
}

/** 실행 종료 시 최종 상태(ok/error) 기록. */
export function finishGraphRun(runId: string, status: "ok" | "error"): void {
  const db = getDb();
  const finish = db.transaction(() => {
    const row = db
      .prepare("SELECT node_states_json FROM automation_runs WHERE id = ? AND status = 'running'")
      .get(runId) as { node_states_json: string | null } | undefined;
    if (!row) return;
    let nodeStatesJson = row.node_states_json;
    if (status === "error" && nodeStatesJson) {
      try {
        const parsed = JSON.parse(nodeStatesJson) as Record<string, unknown>;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          let changed = false;
          for (const [nodeId, nodeState] of Object.entries(parsed)) {
            if (nodeState === "running") {
              parsed[nodeId] = "failed";
              changed = true;
            }
          }
          if (changed) nodeStatesJson = JSON.stringify(parsed);
        }
      } catch {
        // A malformed historical payload must not prevent the terminal status
        // itself from being committed. The renderer already treats it as {}.
      }
    }
    db.prepare(
      "UPDATE automation_runs SET status = ?, node_states_json = ?, last_activity_at = ? WHERE id = ? AND status = 'running'",
    ).run(status, nodeStatesJson, new Date().toISOString(), runId);
  });
  finish.immediate();
}

/** 이 자동화의 최근 실행 스냅샷(per-node 상태). 라이브 오버레이 초기 하이드레이트용. */
export function getLatestGraphRun(automationId: string): WorkflowRunSnapshot | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT 1",
    )
    .get(automationId) as AutomationRunSnapshotRow | undefined;
  if (!row) return null;
  let nodeStates: Record<string, WorkflowNodeRunState> = {};
  try {
    nodeStates = row.node_states_json ? (JSON.parse(row.node_states_json) as Record<string, WorkflowNodeRunState>) : {};
  } catch {
    nodeStates = {};
  }
  return {
    runId: row.id,
    automationId: row.automation_id ?? automationId,
    startedAt: row.started_at ?? "",
    status: (row.status as WorkflowRunSnapshot["status"]) ?? "running",
    nodeStates,
  };
}

/** run_history 행 1개 기록. 놓친 실행/스킵/에러를 가시화(설계 §2.7). */
export function recordRun(input: {
  automationId: string;
  scheduledFor?: string | null;
  ranAt?: string;
  status: "ok" | "error" | "skipped";
  skippedCount?: number;
  error?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO run_history (id, automation_id, scheduled_for, ran_at, status, skipped_count, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.automationId,
      input.scheduledFor ?? null,
      input.ranAt ?? new Date().toISOString(),
      input.status,
      input.skippedCount ?? 0,
      input.error ?? null,
    );
}

/**
 * 최근 run_history에서 "연속" 실패 횟수 — 가장 최근 실행부터 거슬러 올라가며
 * status='error'가 끊기지 않고 이어진 길이. 성공/스킵을 만나면 즉시 멈춘다.
 * 스케줄러의 자동 일시정지(무한 동일 재시도 차단) 판정에 쓰인다.
 */
export function countConsecutiveFailures(automationId: string, lookback = 10): number {
  const rows = getDb()
    .prepare("SELECT status FROM run_history WHERE automation_id = ? ORDER BY ran_at DESC LIMIT ?")
    .all(automationId, lookback) as Array<{ status: string | null }>;
  let streak = 0;
  for (const r of rows) {
    if (r.status === "error") streak += 1;
    else break;
  }
  return streak;
}

export function listRunHistory(automationId: string, limit = 50): AutomationRunRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM run_history WHERE automation_id = ? ORDER BY ran_at DESC LIMIT ?")
    .all(automationId, limit) as RunHistoryRow[];
  return rows.map((r) => ({
    id: r.id,
    automationId: r.automation_id ?? automationId,
    scheduledFor: r.scheduled_for,
    ranAt: r.ran_at ?? "",
    status: (r.status as AutomationRunRecord["status"]) ?? "ok",
    skippedCount: r.skipped_count ?? 0,
    error: r.error,
  }));
}

/**
 * 스케줄러가 호출 — 실행 직후 lastRunAt 기록 + 다음 실행 시각 재계산 + misfire 정책 적용.
 * coalesce(기본): 놓친 발생을 1회로 병합, run_count 증가, 다음 미래 슬롯으로 점프.
 * 종료 정책: max_runs 도달 또는 end_at 초과 또는 nextRun=null이면 enabled=0(auto-disable).
 * run_history 행을 기록해 "앞서 N회 스킵됨"을 가시화한다.
 */
export function markAutomationRun(
  id: string,
  at: Date = new Date(),
  opts?: { status?: "ok" | "error" | "skipped"; error?: string | null; advanceSchedule?: boolean },
): void {
  const db = getDb();
  const row = db.prepare("SELECT * FROM automations WHERE id = ?").get(id) as AutomationRow | undefined;
  if (!row) return;

  const tz = row.timezone || defaultTz();
  const spec = specFromStored(row.schedule_json ?? row.schedule, tz);
  const triggerType = (row.trigger_type as TriggerKind) || "schedule";
  // 시계(next_run_at) 전진은 시간 트리거의 "실제 예약 발사"일 때만. 이벤트 트리거(fs/chain/poll/
  // webhook)나 run-now는 advanceSchedule=false로 와서 next_run_at을 건드리지 않는다 —
  // 그러지 않으면 이벤트 자동화가 daily 시계로 승격되거나, run-now가 다음 예약 슬롯을 잡아먹는다.
  const advance = (opts?.advanceSchedule ?? true) && triggerType === "schedule";

  // coalesce: 놓친 발생 수 세기(가시화용) — 시계 전진 시에만, 그리고 cron만(interval은
  // 상대 드리프트라 "놓친 슬롯" 개념이 무의미해 가짜 카운트가 나온다).
  let skipped = 0;
  if (advance && spec && spec.kind === "cron") {
    let cursor = row.next_run_at ? new Date(row.next_run_at) : row.last_run_at ? new Date(row.last_run_at) : at;
    // 최대 500개까지만 센다(긴 다운타임 폭주 방지).
    for (let guard = 0; guard < 500; guard += 1) {
      const nextIso = nextRun(spec, cursor);
      if (!nextIso) break;
      const nextDate = new Date(nextIso);
      if (nextDate.getTime() > at.getTime()) break;
      skipped += 1;
      cursor = nextDate;
    }
    if (skipped > 0) skipped -= 1; // 이번 발사 1회는 스킵이 아니라 실제 실행
  }

  const runCount = (row.run_count ?? 0) + 1;
  // 전진하지 않으면 next_run_at은 그대로 둔다(이벤트=null 유지, 시계=다음 예약 슬롯 유지).
  const nextRunAt = advance
    ? computeNextRun(row.schedule, at, { scheduleJson: row.schedule_json, timezone: tz })
    : row.next_run_at;

  // 종료 조건 판정. reachedMax/pastEnd는 트리거 종류 무관하게 적용(N회/기한 후 자동 비활성).
  const reachedMax = row.max_runs != null && runCount >= row.max_runs;
  const pastEnd = row.end_at != null && Date.parse(row.end_at) <= at.getTime();
  const noFuture = advance && nextRunAt == null;
  const shouldDisable = reachedMax || pastEnd || noFuture;

  db.prepare(
    "UPDATE automations SET last_run_at = ?, next_run_at = ?, run_count = ?, enabled = ? WHERE id = ?",
  ).run(at.toISOString(), shouldDisable ? null : nextRunAt, runCount, shouldDisable ? 0 : row.enabled, id);

  try {
    recordRun({
      automationId: id,
      scheduledFor: row.next_run_at,
      ranAt: at.toISOString(),
      status: opts?.status ?? "ok",
      skippedCount: skipped > 0 ? skipped : 0,
      error: opts?.error ?? null,
    });
  } catch (err) {
    console.error("[automation] recordRun failed:", err);
  }
}

// enabled이고 next_run_at이 지난(due) 자동화들.
export function dueAutomations(now: Date = new Date()): Automation[] {
  const rows = getDb()
    .prepare("SELECT * FROM automations WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC")
    .all(now.toISOString()) as AutomationRow[];
  return rows.map(toAutomation);
}

/** 특정 트리거 종류의 enabled 자동화들(트리거 매니저가 리스너 등록에 사용). */
export function listEnabledByTrigger(kind: TriggerKind): Automation[] {
  const rows = getDb()
    .prepare("SELECT * FROM automations WHERE enabled = 1 AND trigger_type = ? ORDER BY created_at DESC")
    .all(kind) as AutomationRow[];
  return rows.map(toAutomation);
}

// 리스 만료 임계 — 헤드리스 러너가 실행 중 크래시하면 클레임이 고아가 되므로 이 시간이
// 지나면 회수 가능(설계 §6 열린질문 #5). 자동화 실행은 길어야 수 분이라 넉넉히 15분.
export const AUTOMATION_LEASE_TTL_MS = 15 * 60 * 1000;
// A sleeping Mac pauses the JS heartbeat timer. Protect a lease whose trusted
// Desktop owner process is still alive for the longest legitimate tool window,
// plus the same recovery margin used by durable automation-run recovery. The
// hard ceiling prevents PID reuse from creating a permanent lock.
export const AUTOMATION_LIVE_OWNER_GUARD_MS = MAX_AUTOMATION_ACTIVE_TOOL_STALL_MS + 2 * 60 * 1000;

function trustedAutomationLeasePid(owner: string | null): number | null {
  const match = owner?.match(/^([1-9][0-9]*):(gui|headless)$/);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid <= 2_147_483_647 ? pid : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM proves that a process exists even when this process cannot signal it.
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

/**
 * due 행을 원자적으로 클레임한다(설계 §2.6 크로스프로세스 리스). 헤드리스 launchd 러너와
 * 열린 GUI가 같은 SQLite를 공유하므로, 같은 due 행을 둘 다 실행하지 않도록 한다.
 * claimed_at이 비었거나 TTL을 넘긴 경우에만 owner를 기록하며 잡는다.
 * @returns 이 프로세스가 실행 권한을 얻으면 true.
 */
export function claimAutomationRun(id: string, owner: string, now: Date = new Date()): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT enabled, claimed_at, lease_owner FROM automations WHERE id = ?")
    .get(id) as Pick<AutomationRow, "enabled" | "claimed_at" | "lease_owner"> | undefined;
  if (!row || row.enabled !== 1) return false;

  const nowMs = now.getTime();
  const claimedAtMs = row.claimed_at == null ? Number.NaN : Date.parse(row.claimed_at);
  if (row.claimed_at != null && Number.isFinite(claimedAtMs)) {
    const ageMs = nowMs - claimedAtMs;
    if (ageMs < AUTOMATION_LEASE_TTL_MS) return false;

    const incumbentPid = trustedAutomationLeasePid(row.lease_owner);
    if (
      incumbentPid != null &&
      ageMs <= AUTOMATION_LIVE_OWNER_GUARD_MS &&
      isProcessAlive(incumbentPid)
    ) {
      return false;
    }
  }

  // Compare-and-swap the exact lease observed above. A GUI/headless peer may
  // renew or acquire it between SELECT and UPDATE; that peer must win.
  const result = db
    .prepare(
      `UPDATE automations SET claimed_at = ?, lease_owner = ?
         WHERE id = ? AND enabled = 1 AND claimed_at IS ? AND lease_owner IS ?`,
    )
    .run(now.toISOString(), owner, id, row.claimed_at, row.lease_owner);
  return result.changes > 0;
}

/**
 * Extend a due-run lease only while this exact owner still holds it.
 * false is a definitive ownership loss; SQLite busy/I/O errors throw so the
 * scheduler can treat a transient renewal failure as retryable, not ownership loss.
 */
export function renewAutomationRunLease(id: string, owner: string, now: Date = new Date()): boolean {
  const result = getDb()
    .prepare(
      `UPDATE automations SET claimed_at = ?
       WHERE id = ? AND enabled = 1 AND lease_owner = ? AND claimed_at IS NOT NULL`,
    )
    .run(now.toISOString(), id, owner);
  return result.changes > 0;
}

/**
 * 실행 종료 후 자신이 획득한 리스만 해제한다. TTL 이후 다른 프로세스가 리스를 인계했거나
 * Run now/이벤트 실행이 예약 러너와 겹쳐도 타 owner의 클레임을 지우면 안 된다.
 * @returns 이 owner의 리스를 실제로 해제했으면 true.
 */
export function releaseAutomationRun(id: string, owner: string): boolean {
  const result = getDb()
    .prepare(
      "UPDATE automations SET claimed_at = NULL, lease_owner = NULL WHERE id = ? AND lease_owner = ?",
    )
    .run(id, owner);
  return result.changes > 0;
}
