// 자동화 — SQLite 영속 + 스케줄 next-run 계산. (이전 M0 in-memory stub 대체)
// targetType: agent(개별 에이전트) | firm(CEO 호출). createdBy: user(폼) | agent(채팅 emitter).
// 실제 실행은 automation-scheduler.ts가 dueAutomations()를 폴링해 백그라운드 chat으로 돌린다.
//
// v33: next-run 계산을 schedule.ts(croner)에 위임한다. computeNextRun은 이제 string|null을
// 반환하며(null=미래 발생 없음 → 종료), markAutomationRun은 misfire coalesce 정책 + run_history
// 기록 + max_runs/end_at 종료를 적용한다. graph_json/schedule_json/timezone은 additive.
import { judgedComputerUse } from "../system-agents/judged-tool-mode";
import { RUNTIME_KINDS as SHARED_RUNTIME_KINDS } from "../../shared/runtime-kinds";
import { RUNTIME_BACKENDS as SHARED_RUNTIME_BACKENDS } from "../../shared/runtime-backends";
import { createHash, randomUUID } from "node:crypto";
import type { GraphJournalKindGenerated } from "../../shared/graph-vocabulary.generated";
import { hostname } from "node:os";
import { emitDesktopStoreChange } from "./change-bus";
import { AUTOMATION_RUN_STALE_AFTER_MS, getDb } from "./db";
import { nextRun, specFromStored, defaultTz } from "./schedule";
import { resolveAutomationToolMode } from "../../shared/automation-tool-policy";
import { MAX_AUTOMATION_ACTIVE_TOOL_STALL_MS } from "../automation-watchdog";
import { evaluateCondition } from "../triggers/condition";
import type {
  Automation,
  AutomationExecutionPermission,
  AutomationHubMode,
  AutomationTargetType,
  WorkflowGraph,
  AutomationRunRecord,
  AutomationToolMode,
  AutomationUpdatePatch,
  RuntimeSelection,
  Trigger,
  TriggerKind,
  WorkflowNodeRunState,
  WorkflowRunRuntimeFact,
  WorkflowRunSnapshot,
} from "../../shared/types";

interface AutomationRow {
  id: string;
  name: string;
  schedule: string;
  target_type: AutomationTargetType;
  target_id: string;
  project_id: string | null;
  prompt_template: string;
  execution_permission: string | null;
  attention_cleared_at: string | null;
  tool_mode: string | null;
  hub_mode: string | null;
  target_version: string | null;
  runtime_selection_json: string | null;
  enabled: number;
  created_by: "user" | "agent";
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  graph_json: string | null;
  goal: string | null;
  goal_id: string | null;
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
  /** v89 이후에만 있다. 옛 행은 null — 그때는 status 한 칸에 두 답이 섞여 있었다. */
  outcome: string | null;
  outcome_reason: string | null;
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
  if (value === "hub-first" || value === "local-only" || value === "hub-allowed") return value;
  // NULL is the documented legacy default. A present-but-unknown value is a
  // damaged/future contract and must never widen execution to Network/Cloud.
  return value == null ? "hub-allowed" : "local-only";
}

/**
 * Missing is the deliberate legacy/UI default. Any present-but-invalid value
 * fails closed to read so malformed IPC or a damaged row cannot gain writes.
 */
function normalizeExecutionPermission(value: unknown): AutomationExecutionPermission {
  if (value === "read" || value === "write") return value;
  return value == null ? "write" : "read";
}

const RUNTIME_KINDS = new Set<string>(SHARED_RUNTIME_KINDS);
const RUNTIME_BACKENDS = new Set<string>(SHARED_RUNTIME_BACKENDS);
const RUNTIME_SELECTION_KEYS = new Set(["kind", "backend", "source", "model", "longContext", "effort"]);

type StoredContractState = "missing" | "valid" | "invalid";

function decodeRuntimeSelection(raw: string | null | undefined): {
  state: StoredContractState;
  value?: RuntimeSelection;
} {
  if (raw == null) return { state: "missing" };
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const normalized = value.kind === "gemini"
      ? { ...value, kind: "antigravity", source: undefined, model: undefined }
      : value;
    if (
      normalized && typeof normalized === "object" && !Array.isArray(normalized) &&
      Object.keys(normalized).every((key) => RUNTIME_SELECTION_KEYS.has(key)) &&
      typeof normalized.kind === "string" && RUNTIME_KINDS.has(normalized.kind) &&
      (normalized.backend === undefined || typeof normalized.backend === "string" && RUNTIME_BACKENDS.has(normalized.backend)) &&
      (normalized.source === undefined || typeof normalized.source === "string" && normalized.source.length > 0 && normalized.source.length <= 2_048) &&
      (normalized.model === undefined || typeof normalized.model === "string" && normalized.model.length > 0 && normalized.model.length <= 512) &&
      (normalized.longContext === undefined || typeof normalized.longContext === "boolean") &&
      (normalized.effort === undefined || typeof normalized.effort === "string" && normalized.effort.length <= 128)
    ) {
      return { state: "valid", value: normalized as unknown as RuntimeSelection };
    }
  } catch {
    // The caller distinguishes damaged data from a truly missing legacy pin.
  }
  return { state: "invalid" };
}

function parseRuntimeSelection(raw: string | null | undefined): RuntimeSelection | undefined {
  return decodeRuntimeSelection(raw).value;
}

export interface AutomationExecutionContractState {
  runtimeSelection: StoredContractState;
  hubMode: StoredContractState;
}

/** Raw-row integrity gate used immediately before unattended execution. */
export function getAutomationExecutionContractState(id: string): AutomationExecutionContractState | null {
  const row = getDb().prepare(
    "SELECT runtime_selection_json, hub_mode FROM automations WHERE id = ?",
  ).get(id) as Pick<AutomationRow, "runtime_selection_json" | "hub_mode"> | undefined;
  if (!row) return null;
  return {
    runtimeSelection: decodeRuntimeSelection(row.runtime_selection_json).state,
    hubMode: row.hub_mode == null
      ? "missing"
      : row.hub_mode === "hub-first" || row.hub_mode === "local-only" || row.hub_mode === "hub-allowed"
        ? "valid"
        : "invalid",
  };
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
    projectId: row.project_id ?? null,
    promptTemplate: row.prompt_template,
    executionPermission: normalizeExecutionPermission(row.execution_permission),
    attentionClearedAt: typeof row.attention_cleared_at === "string" ? row.attention_cleared_at : null,
    toolMode: normalizeToolMode(row.tool_mode),
    hubMode: normalizeHubMode(row.hub_mode),
    targetVersion: row.target_version ?? undefined,
    runtimeSelection: parseRuntimeSelection(row.runtime_selection_json),
    enabled: !!row.enabled,
    createdBy: row.created_by,
    createdAt: row.created_at,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    graph: parseGraph(row.graph_json),
    goal: row.goal ?? null,
    goalId: row.goal_id ?? null,
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

/**
 * persistent goal 축으로 연속실행 자동화를 찾는다 — 프롬프트 안 마커 문자열 검색의
 * 1급 대체. 한 goal에 연속실행은 최대 하나라는 불변식의 조회면이다.
 */
export function findAutomationByGoalId(goalId: string): Automation | null {
  if (!goalId.trim()) return null;
  const row = getDb()
    .prepare("SELECT * FROM automations WHERE goal_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(goalId) as AutomationRow | undefined;
  return row ? toAutomation(row) : null;
}

/** First-run runtime pin must not recalculate schedule state or consume a due slot. */
export function pinAutomationRuntimeIfUnset(id: string, selection: RuntimeSelection): Automation {
  getDb()
    .prepare("UPDATE automations SET runtime_selection_json = ? WHERE id = ? AND runtime_selection_json IS NULL")
    .run(JSON.stringify(selection), id);
  const automation = getAutomation(id);
  if (!automation) throw new Error(`Automation not found: ${id}`);
  emitDesktopStoreChange({ entity: "automation", id });
  return automation;
}

export interface AutomationHubVersionPinReceipt {
  slug: string;
  packageHash: string;
  scope: "automation" | "graph-node";
  nodeId?: string;
}

/**
 * Freeze legacy NULL Hub targets exactly once. The transaction re-reads the
 * row, so concurrent GUI/headless migrations preserve the first valid winner
 * instead of silently moving a recurring automation to a newer release.
 */
export function pinLegacyAutomationHubVersions(
  id: string,
  packageHashes: Readonly<Record<string, string>>,
): { automation: Automation; pinned: AutomationHubVersionPinReceipt[] } {
  for (const [slug, packageHash] of Object.entries(packageHashes)) {
    if (!slug || !/^[0-9a-f]{64}$/.test(packageHash)) {
      throw new Error(`automation_hub_version_pin_invalid: ${slug || "missing-slug"}`);
    }
  }
  const db = getDb();
  const pinned: AutomationHubVersionPinReceipt[] = [];
  const commit = db.transaction(() => {
    const row = db.prepare("SELECT * FROM automations WHERE id = ?").get(id) as AutomationRow | undefined;
    if (!row) throw new Error(`Automation not found: ${id}`);
    let targetVersion = row.target_version;
    if (row.target_type === "hub") {
      if (targetVersion != null && !/^[0-9a-f]{64}$/.test(targetVersion)) {
        throw new Error("automation_hub_version_pin_invalid: saved automation target hash is malformed");
      }
      if (targetVersion == null) {
        const packageHash = packageHashes[row.target_id];
        if (!packageHash) throw new Error(`automation_hub_version_pin_unavailable: ${row.target_id}`);
        targetVersion = packageHash;
        pinned.push({ slug: row.target_id, packageHash, scope: "automation" });
      }
    }

    let graphJson = row.graph_json;
    if (graphJson) {
      let graph: WorkflowGraph;
      try {
        graph = JSON.parse(graphJson) as WorkflowGraph;
      } catch {
        throw new Error("automation_graph_contract_invalid: saved graph JSON is malformed");
      }
      if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
        throw new Error("automation_graph_contract_invalid: saved graph shape is malformed");
      }
      let changed = false;
      graph = {
        ...graph,
        nodes: graph.nodes.map((node) => {
          if (node.type !== "agent" || node.config?.targetType !== "hub") return node;
          const slug = typeof node.config.ref === "string" ? node.config.ref.trim() : "";
          const current = typeof node.config.targetVersion === "string" ? node.config.targetVersion : "";
          if (!slug) throw new Error(`automation_hub_version_pin_invalid: Hub node ${node.id} has no slug`);
          if (current && !/^[0-9a-f]{64}$/.test(current)) {
            throw new Error(`automation_hub_version_pin_invalid: Hub node ${node.id} hash is malformed`);
          }
          if (current) return node;
          const packageHash = packageHashes[slug];
          if (!packageHash) throw new Error(`automation_hub_version_pin_unavailable: ${slug}`);
          changed = true;
          pinned.push({ slug, packageHash, scope: "graph-node", nodeId: node.id });
          return { ...node, config: { ...node.config, targetVersion: packageHash } };
        }),
      };
      if (changed) graphJson = JSON.stringify(graph);
    }
    if (targetVersion !== row.target_version || graphJson !== row.graph_json) {
      const updated = db.prepare(
        "UPDATE automations SET target_version = ?, graph_json = ? WHERE id = ?",
      ).run(targetVersion, graphJson, id);
      if (updated.changes !== 1) throw new Error("automation_hub_version_pin_conflict: row disappeared during migration");
    }
  });
  commit.immediate();
  const automation = getAutomation(id);
  if (!automation) throw new Error(`Automation not found: ${id}`);
  if (pinned.length > 0) emitDesktopStoreChange({ entity: "automation", id });
  return { automation, pinned };
}

export function createAutomation(input: {
  name: string;
  scheduleHuman: string;
  targetType: AutomationTargetType;
  targetId: string;
  projectId?: string | null;
  promptTemplate: string;
  createdBy?: "user" | "agent";
  graphJson?: string | WorkflowGraph | null;
  /** 무엇을 위한 자동화인가(인터뷰 blueprint.goal). AI가 나중에 그래프를 이해할 유일한 문장. */
  goal?: string | null;
  /** persistent goal 조인 키(goal_ledger 축). 연속실행 자동화만 채운다. */
  goalId?: string | null;
  /**
   * ★꺼진 채로 태어나야 하는가. 기본은 켬(옛 동작).
   *
   * 예전에는 "만들고 나서 끄기" 두 걸음이었다. 그 사이에서 예외가 나면 자동화는
   * **켜진 채** 남고 화면에는 저장 실패가 뜬다 — 사람은 안 만들어졌다고 믿는데
   * 20분 뒤 그것이 돈다(실측 2026-08-06, `no such column: goal`).
   * 꺼진 상태를 약속했으면 그 상태로 태어나야 한다.
   */
  enabled?: boolean;
  scheduleJson?: string | null;
  timezone?: string | null;
  endAt?: string | null;
  maxRuns?: number | null;
  triggerType?: TriggerKind;
  trigger?: Trigger | null;
  toolMode?: AutomationToolMode;
  hubMode?: AutomationHubMode;
  /** Hub packageHash 핀(선택). 미지정 = latest. */
  targetVersion?: string;
  runtimeSelection?: RuntimeSelection;
  executionPermission?: AutomationExecutionPermission;
  /** Synchronous judged verdict reader; defaults to the resident computer-use peek.
   *  Injectable so tests can supply a deterministic verdict without a live model. */
  judged?: (text: string) => boolean | null;
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
          trigger_type, trigger_json, tool_mode, hub_mode, execution_permission, target_version, runtime_selection_json,
          project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.name.trim() || "Automation",
      input.scheduleHuman,
      input.targetType,
      input.targetId,
      input.promptTemplate,
      input.enabled === false ? 0 : 1,
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
        judged: input.judged ?? judgedComputerUse,
        toolMode: normalizeToolMode(input.toolMode),
        name: input.name,
        promptTemplate: input.promptTemplate,
        targetLabel: input.targetType,
        graph: input.graphJson,
      }),
      normalizeHubMode(input.hubMode),
      normalizeExecutionPermission(input.executionPermission),
      input.targetVersion?.trim() || null,
      input.runtimeSelection ? JSON.stringify(input.runtimeSelection) : null,
      input.projectId ?? null,
    );
  // goal 은 additive 컬럼이라 INSERT 목록을 안 건드리고 따로 채운다(빈 값이면 안 쓴다).
  if (input.goal && input.goal.trim()) {
    getDb().prepare("UPDATE automations SET goal = ? WHERE id = ?").run(input.goal.trim(), id);
  }
  // goal_id 도 additive 컬럼 — 같은 이유로 INSERT 목록을 안 건드린다.
  if (input.goalId && input.goalId.trim()) {
    getDb().prepare("UPDATE automations SET goal_id = ? WHERE id = ?").run(input.goalId.trim(), id);
  }
  const automation = getAutomation(id) as Automation;
  emitDesktopStoreChange({ entity: "automation", id });
  return automation;
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
  const projectId = patch.projectId !== undefined ? patch.projectId : row.project_id;
  const promptTemplate = patch.promptTemplate ?? row.prompt_template;
  const toolMode = resolveAutomationToolMode({
    judged: judgedComputerUse,
    toolMode: normalizeToolMode(patch.toolMode ?? row.tool_mode),
    name,
    promptTemplate,
    targetLabel: targetType,
    graph: parseGraph(row.graph_json),
  });
  const hubMode = normalizeHubMode(patch.hubMode ?? row.hub_mode);
  // undefined = 미변경(기존 핀 유지), 빈 문자열 = 핀 해제(latest로 복귀).
  const targetVersion =
    patch.targetVersion !== undefined ? patch.targetVersion.trim() || null : row.target_version;
  const runtimeSelectionJson =
    patch.runtimeSelection !== undefined
      ? patch.runtimeSelection ? JSON.stringify(patch.runtimeSelection) : null
      : row.runtime_selection_json;
  const executionPermission =
    patch.executionPermission === undefined
      ? normalizeExecutionPermission(row.execution_permission)
      : normalizeExecutionPermission(patch.executionPermission);
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
       tool_mode = ?, hub_mode = ?, execution_permission = ?, target_version = ?, runtime_selection_json = ?,
       schedule_json = ?, timezone = ?, end_at = ?, max_runs = ?, trigger_type = ?, trigger_json = ?,
       next_run_at = ?, project_id = ?
     WHERE id = ?`,
  ).run(
    name,
    scheduleHuman,
    targetType,
    targetId,
    promptTemplate,
    toolMode,
    hubMode,
    executionPermission,
    targetVersion,
    runtimeSelectionJson,
    scheduleJson,
    tz,
    endAt,
    maxRuns,
    triggerType,
    triggerJson,
    nextRunAt,
    projectId,
    id,
  );
  /*
   * ★goal도 patch를 받는다 — 없던 시절, 그래프 편집·발행 경로 어디서도 목적 문장을
   * 나중에 채울 수 없었다(실측 2026-08-06: 터미널이 goal 없이 저장한 그래프를 발행하려
   * 하자 tagline이 하드코딩 폴백으로 떨어졌는데, 고칠 방법이 없었다). 빈 문자열이면
   * 지우는 것으로 읽는다.
   */
  if (patch.goal !== undefined) {
    getDb().prepare("UPDATE automations SET goal = ? WHERE id = ?")
      .run(patch.goal && patch.goal.trim() ? patch.goal.trim() : null, id);
  }
  // goal_id — null 해제, undefined 미변경(goal 칸과 같은 additive 패치 규율).
  if (patch.goalId !== undefined) {
    getDb().prepare("UPDATE automations SET goal_id = ? WHERE id = ?")
      .run(patch.goalId && patch.goalId.trim() ? patch.goalId.trim() : null, id);
  }
  const automation = getAutomation(id) as Automation;
  emitDesktopStoreChange({ entity: "automation", id });
  return automation;
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
      : timeDriven
        ? existing.nextRunAt
        : null;
  getDb()
    .prepare("UPDATE automations SET enabled = ?, next_run_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, nextRunAt, id);
  const automation = getAutomation(id) as Automation;
  emitDesktopStoreChange({ entity: "automation", id });
  return automation;
}

export function removeAutomation(id: string): void {
  const db = getDb();
  const remove = db.transaction(() => {
    // Delete first-class automation sessions and their internal ledgers in the
    // same commit as the parent so no transcript survives without an owner.
    const sessions = db.prepare(
      "SELECT ledger_chat_id FROM automation_sessions WHERE automation_id = ? OR automation_id LIKE ?",
    ).all(id, `${id}::%`) as Array<{ ledger_chat_id: string }>;
    db.prepare("DELETE FROM automation_sessions WHERE automation_id = ? OR automation_id LIKE ?")
      .run(id, `${id}::%`);
    const removeLedger = db.prepare("DELETE FROM chats WHERE id = ?");
    for (const session of sessions) removeLedger.run(session.ledger_chat_id);
    // Clean unclaimed pre-v83 marker rows during deletion.
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
  emitDesktopStoreChange({ entity: "automation", id });
  emitDesktopStoreChange({ entity: "chat" });
}

/** 한 자동화가 간직하는 판 수 — 이보다 오래된 판은 저장할 때 정리한다. */
const GRAPH_VERSION_KEEP = 20;

/**
 * ★저장 직전의 판을 이력에 남긴다.
 *
 * 저장은 지금까지 덮어쓰기뿐이었다 — 말로 고치다 한 번 잘못 저장하면 잘 돌던 그래프가
 * 되돌아갈 자리 없이 사라진다. 이력을 남기는 쪽은 저장 경로 **한 곳**이어야 한다
 * (호출자마다 챙기게 하면 어느 경로는 반드시 빠진다).
 */
function snapshotGraphVersion(automationId: string, graph: WorkflowGraph, note?: string): void {
  const db = getDb();
  const json = JSON.stringify(graph);
  db.prepare(
    "INSERT INTO automation_graph_versions (id, automation_id, saved_at, note, node_count, graph_json) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(randomUUID(), automationId, new Date().toISOString(), note ?? null, graph.nodes?.length ?? 0, json);
  db.prepare(
    `DELETE FROM automation_graph_versions WHERE automation_id = ? AND id NOT IN (
       SELECT id FROM automation_graph_versions WHERE automation_id = ? ORDER BY saved_at DESC, id DESC LIMIT ?
     )`,
  ).run(automationId, automationId, GRAPH_VERSION_KEEP);
}

export interface GraphVersionSummary {
  id: string;
  savedAt: string;
  note?: string;
  nodeCount: number;
}

/** 되돌아갈 수 있는 판 목록(최신 순). */
export function listGraphVersions(automationId: string, limit = GRAPH_VERSION_KEEP): GraphVersionSummary[] {
  const rows = getDb()
    .prepare(
      "SELECT id, saved_at, note, node_count FROM automation_graph_versions WHERE automation_id = ? ORDER BY saved_at DESC, id DESC LIMIT ?",
    )
    .all(automationId, limit) as Array<{ id: string; saved_at: string; note: string | null; node_count: number }>;
  return rows.map((r) => ({
    id: r.id,
    savedAt: r.saved_at,
    ...(r.note ? { note: r.note } : {}),
    nodeCount: r.node_count ?? 0,
  }));
}

/**
 * 저장된 판으로 되돌린다. 되돌리기 **자체도 저장**이므로 지금 판이 먼저 이력에 남는다 —
 * 되돌린 게 잘못이었을 때 다시 앞으로 올 수 있어야 한다.
 */
export function restoreGraphVersion(automationId: string, versionId: string): Automation {
  const row = getDb()
    .prepare("SELECT graph_json FROM automation_graph_versions WHERE id = ? AND automation_id = ?")
    .get(versionId, automationId) as { graph_json?: string } | undefined;
  if (!row?.graph_json) throw new Error("graph_version_not_found");
  const graph = JSON.parse(row.graph_json) as WorkflowGraph;
  return updateAutomationGraph(automationId, graph, { note: "되돌리기" });
}

/** 저장된 그래프를 갱신(그래프 편집/생성 경로). null이면 그래프 제거(단일 프롬프트로 복귀). */
export function updateAutomationGraph(
  id: string,
  graph: WorkflowGraph | null,
  options?: { note?: string },
): Automation {
  const existing = getAutomation(id);
  if (!existing) throw new Error(`Automation not found: ${id}`);
  /*
   * 덮어쓰기 전에 직전 판을 남긴다. 단, **바뀐 게 없으면 남기지 않는다** — 열었다 그냥
   * 저장한 것까지 이력이 되면 정작 되돌아갈 판이 상한 밖으로 밀려난다.
   * 이력 때문에 저장 자체가 실패하면 안 되므로 실패는 삼킨다.
   */
  const changed = JSON.stringify(existing.graph ?? null) !== JSON.stringify(graph ?? null);
  if (changed && existing.graph && existing.graph.nodes?.length) {
    try { snapshotGraphVersion(id, existing.graph, options?.note); } catch { /* 저장이 우선 */ }
  }
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
  const automation = getAutomation(id) as Automation;
  emitDesktopStoreChange({ entity: "automation", id });
  return automation;
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
  occurrence_id: string | null;
  graph_digest: string | null;
  checkpoint_json: string | null;
  resume_of_run_id: string | null;
  dry_run: number;
}

function runtimeFactsForRun(runId: string): WorkflowRunRuntimeFact[] {
  if (!runId) return [];
  try {
    const rows = getDb().prepare(
      `SELECT node_id, payload_json FROM run_events
       WHERE run_id = ? AND kind = 'runtime_selection'
       ORDER BY seq ASC LIMIT 200`,
    ).all(runId) as Array<{ node_id: string | null; payload_json: string | null }>;
    const latestByNodeAndRole = new Map<string, WorkflowRunRuntimeFact>();
    for (const row of rows) {
      let payload: Record<string, unknown>;
      try {
        const parsed = row.payload_json ? JSON.parse(row.payload_json) : null;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        payload = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      const kind = typeof payload.runtimeKind === "string" ? payload.runtimeKind : "";
      if (!kind) continue;
      const decoded = decodeRuntimeSelection(JSON.stringify({
        kind,
        ...(typeof payload.runtimeBackend === "string" ? { backend: payload.runtimeBackend } : {}),
        ...(typeof payload.runtimeSource === "string" ? { source: payload.runtimeSource } : {}),
        ...(typeof payload.runtimeModel === "string" ? { model: payload.runtimeModel } : {}),
        ...(typeof payload.runtimeLongContext === "boolean" ? { longContext: payload.runtimeLongContext } : {}),
        ...(typeof payload.runtimeEffort === "string" ? { effort: payload.runtimeEffort } : {}),
      }));
      if (decoded.state !== "valid" || !decoded.value) continue;
      const role = typeof payload.runtimeRole === "string" ? payload.runtimeRole : undefined;
      const nodeId = typeof row.node_id === "string" && row.node_id ? row.node_id : undefined;
      const key = `${nodeId ?? ""}\0${role ?? ""}`;
      latestByNodeAndRole.set(key, {
        ...(nodeId ? { nodeId } : {}),
        ...(role ? { role } : {}),
        selection: decoded.value,
      });
    }
    return [...latestByNodeAndRole.values()];
  } catch {
    // Legacy stores or an incomplete migration may not have run_events yet.
    // Runtime facts are observability only and must never hide the run state.
    return [];
  }
}

const MAX_AUTOMATION_CHECKPOINT_BYTES = 1024 * 1024;

export interface FailedGraphCheckpoint {
  runId: string;
  automationId: string;
  occurrenceId: string | null;
  graphDigest: string | null;
  checkpoint: unknown;
  nodeStates: Record<string, WorkflowNodeRunState>;
  simulation: boolean;
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

export type AutomationLiveRunState = "queued" | "running" | null;

/**
 * Durable cross-process state for read-only clients such as Mobile Bridge.
 *
 * `claimed_at` is the scheduler lease and therefore the authority for work that
 * has been accepted but has not created its graph snapshot yet. Once a fresh
 * `automation_runs` row exists, that row is the authority for `running`.
 * A terminal history row newer than the last lease heartbeat wins over the
 * short mark-history -> release-lease window, so clients cannot get stuck on a
 * false queued state after a very fast completion.
 */
export function getAutomationLiveRunState(
  id: string,
  now: Date = new Date(),
): AutomationLiveRunState {
  const db = getDb();
  const parent = db.prepare(
    "SELECT claimed_at, lease_owner FROM automations WHERE id = ?",
  ).get(id) as { claimed_at: string | null; lease_owner: string | null } | undefined;
  if (!parent) return null;

  const latestHistory = db.prepare(
    "SELECT ran_at FROM run_history WHERE automation_id = ? ORDER BY ran_at DESC LIMIT 1",
  ).get(id) as { ran_at: string | null } | undefined;
  const terminalAtMs = latestHistory?.ran_at == null ? Number.NaN : Date.parse(latestHistory.ran_at);
  const activeRun = db.prepare(
    `SELECT COALESCE(last_activity_at, started_at) AS active_at
     FROM automation_runs
     WHERE automation_id = ? AND status = 'running'
     ORDER BY COALESCE(last_activity_at, started_at) DESC
     LIMIT 1`,
  ).get(id) as { active_at: string | null } | undefined;
  if (activeRun) {
    if (!activeRun.active_at) return "running";
    const activeAtMs = Date.parse(activeRun.active_at);
    const terminalWins = Number.isFinite(activeAtMs) &&
      Number.isFinite(terminalAtMs) &&
      terminalAtMs >= activeAtMs;
    if (
      !terminalWins &&
      (!Number.isFinite(activeAtMs) || now.getTime() - activeAtMs <= AUTOMATION_RUN_STALE_AFTER_MS)
    ) {
      return "running";
    }
  }

  if (parent.claimed_at == null) return null;
  const claimedAtMs = Date.parse(parent.claimed_at);
  let leaseIsActive = !Number.isFinite(claimedAtMs);
  if (Number.isFinite(claimedAtMs)) {
    const ageMs = now.getTime() - claimedAtMs;
    leaseIsActive = ageMs <= AUTOMATION_LEASE_TTL_MS;
    if (!leaseIsActive) {
      const ownerPid = trustedAutomationLeasePid(parent.lease_owner);
      leaseIsActive = ownerPid != null &&
        ageMs <= AUTOMATION_LIVE_OWNER_GUARD_MS &&
        isProcessAlive(ownerPid);
    }
  }
  if (!leaseIsActive) return null;

  if (
    Number.isFinite(claimedAtMs) &&
    Number.isFinite(terminalAtMs) &&
    terminalAtMs >= claimedAtMs
  ) {
    return null;
  }
  return "queued";
}

/** Exact scheduler identity exposed across queued, running, and terminal views. */
export function getAutomationLiveRunId(id: string): string | null {
  const db = getDb();
  const active = db.prepare(
    `SELECT id FROM automation_runs
     WHERE automation_id = ? AND status = 'running'
     ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT 1`,
  ).get(id) as { id: string } | undefined;
  if (active?.id) return active.id;
  if (getAutomationLiveRunState(id) === "queued") {
    const requested = db.prepare(
      `SELECT run_id FROM run_events
       WHERE automation_id = ? AND kind = 'automation_run_requested'
       ORDER BY ts DESC, rowid DESC LIMIT 1`,
    ).get(id) as { run_id: string } | undefined;
    if (requested?.run_id) return requested.run_id;
  }
  const terminal = db.prepare(
    "SELECT id FROM run_history WHERE automation_id = ? ORDER BY ran_at DESC, rowid DESC LIMIT 1",
  ).get(id) as { id: string } | undefined;
  return terminal?.id ?? null;
}

/** 그래프 실행 시작 시 automation_runs 행 생성(상태 running). node_states는 초기 pending 맵. */
export function startGraphRun(input: {
  runId: string;
  automationId: string;
  nodeIds: string[];
  startedAt?: string;
  occurrenceId?: string;
  graphDigest?: string;
  checkpoint?: unknown;
  resumeOfRunId?: string;
  dryRun?: boolean;
  initialNodeStates?: Record<string, WorkflowNodeRunState>;
}): void {
  const nodeStates: Record<string, WorkflowNodeRunState> = {};
  for (const id of input.nodeIds) nodeStates[id] = input.initialNodeStates?.[id] ?? "pending";
  const startedAt = input.startedAt ?? new Date().toISOString();
  const checkpointJson = input.checkpoint == null ? null : JSON.stringify(input.checkpoint);
  if (checkpointJson && Buffer.byteLength(checkpointJson, "utf8") > MAX_AUTOMATION_CHECKPOINT_BYTES) {
    throw new Error("Automation checkpoint exceeds the local durability limit.");
  }
  const inserted = getDb()
    .prepare(
      `INSERT INTO automation_runs
         (id, automation_id, started_at, last_activity_at, status, node_states_json,
          occurrence_id, graph_digest, checkpoint_json, resume_of_run_id, dry_run)
       SELECT ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM automations WHERE id = ?)`,
    )
    .run(
      input.runId,
      input.automationId,
      startedAt,
      startedAt,
      JSON.stringify(nodeStates),
      input.occurrenceId ?? input.runId,
      input.graphDigest ?? null,
      checkpointJson,
      input.resumeOfRunId ?? null,
      input.dryRun === true ? 1 : 0,
      input.automationId,
    );
  if (inserted.changes !== 1) throw new AutomationRunParentMissingError(input.automationId);
  emitDesktopStoreChange({ entity: "automation", id: input.automationId });
}

/** Atomically seal a node state with the resume checkpoint that justifies it. */
export function checkpointGraphRunNode(
  runId: string,
  nodeId: string,
  state: WorkflowNodeRunState,
  checkpoint: unknown,
): void {
  const checkpointJson = JSON.stringify(checkpoint);
  if (Buffer.byteLength(checkpointJson, "utf8") > MAX_AUTOMATION_CHECKPOINT_BYTES) {
    throw new Error("Automation checkpoint exceeds the local durability limit.");
  }
  const db = getDb();
  const commit = db.transaction(() => {
    const row = db
      .prepare("SELECT node_states_json FROM automation_runs WHERE id = ? AND status = 'running'")
      .get(runId) as { node_states_json: string | null } | undefined;
    if (!row) throw new Error("Automation checkpoint row is not running.");
    let states: Record<string, WorkflowNodeRunState> = {};
    try {
      states = row.node_states_json ? JSON.parse(row.node_states_json) as Record<string, WorkflowNodeRunState> : {};
    } catch {
      states = {};
    }
    states[nodeId] = state;
    const updated = db.prepare(
      `UPDATE automation_runs
       SET node_states_json = ?, checkpoint_json = ?, last_activity_at = ?
       WHERE id = ? AND status = 'running'`,
    ).run(JSON.stringify(states), checkpointJson, new Date().toISOString(), runId);
    if (updated.changes !== 1) throw new Error("Automation checkpoint update lost its running row.");
  });
  commit.immediate();
}

/** Persist in-flight tool evidence before an external side effect can be retried. */
export function saveGraphRunCheckpoint(runId: string, checkpoint: unknown): void {
  const checkpointJson = JSON.stringify(checkpoint);
  if (Buffer.byteLength(checkpointJson, "utf8") > MAX_AUTOMATION_CHECKPOINT_BYTES) {
    throw new Error("Automation checkpoint exceeds the local durability limit.");
  }
  const updated = getDb().prepare(
    `UPDATE automation_runs SET checkpoint_json = ?, last_activity_at = ?
     WHERE id = ? AND status = 'running'`,
  ).run(checkpointJson, new Date().toISOString(), runId);
  if (updated.changes !== 1) throw new Error("Automation checkpoint row is not running.");
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
  let nodeFailures: Record<string, { code: string; reason: string; nextAction: string }> = {};
  try {
    const raw = (row as { node_failures_json?: string | null }).node_failures_json;
    nodeFailures = raw ? (JSON.parse(raw) as typeof nodeFailures) : {};
  } catch {
    nodeFailures = {};
  }
  /*
   * ★이 실행이 쓴 토큰 — 커널은 세고 있었는데 **아무도 읽지 않아** 화면이 알 방법이
   * 없었다(도달성 게이트가 잡은 자리). 저널의 완료 항목에 이미 실려 있으므로
   * 새로 저장할 것 없이 여기서 꺼내 함께 돌려준다.
   */
  let tokensUsed: number | undefined;
  try {
    for (const entry of listGraphJournal(row.id, 5000)) {
      if (entry.kind !== "run_completed" && entry.kind !== "run_failed") continue;
      const n = (entry.payload as { tokensUsed?: unknown } | null)?.tokensUsed;
      if (typeof n === "number" && Number.isFinite(n)) tokensUsed = n;
    }
  } catch { /* 저널을 못 읽어도 실행 상태는 돌려준다 */ }

  const runtimeSelections = runtimeFactsForRun(row.id);

  // A fresh-run review may need the exact old checkpoint even when the current
  // graph has drifted and ordinary reconciliation cannot parse that graph.
  // These are identity fields only; the terminal-close mutation revalidates
  // every value against the durable row before recording its receipt.
  let checkpointIdentity: {
    occurrenceId: string;
    graphDigest: string;
    checkpointDigest: string;
    checkpointUpdatedAt: string;
    inFlightNodeIds: string[];
    ambiguousNodeIds: string[];
    completedEffectNodeIds: string[];
  } | null = null;
  try {
    const checkpoint = row.checkpoint_json ? JSON.parse(row.checkpoint_json) as Record<string, unknown> : null;
    const occurrenceId = typeof checkpoint?.occurrenceId === "string" ? checkpoint.occurrenceId : row.occurrence_id;
    const graphDigest = typeof checkpoint?.graphDigest === "string" ? checkpoint.graphDigest : row.graph_digest;
    const checkpointDigest = typeof checkpoint?.checkpointDigest === "string" ? checkpoint.checkpointDigest : null;
    const checkpointUpdatedAt = typeof checkpoint?.updatedAt === "string" ? checkpoint.updatedAt : null;
    const inFlightNodeIds = Array.isArray(checkpoint?.inFlightNodeIds)
      ? checkpoint.inFlightNodeIds.filter((value): value is string => typeof value === "string")
      : null;
    const ambiguousNodeIds = Array.isArray(checkpoint?.ambiguousNodeIds)
      ? checkpoint.ambiguousNodeIds.filter((value): value is string => typeof value === "string")
      : null;
    const effectNodeIds = Array.isArray(checkpoint?.effectNodeIds)
      ? checkpoint.effectNodeIds.filter((value): value is string => typeof value === "string")
      : null;
    const completedNodeIds = Array.isArray(checkpoint?.completedNodeIds)
      ? checkpoint.completedNodeIds.filter((value): value is string => typeof value === "string")
      : null;
    if (occurrenceId && graphDigest && checkpointDigest && checkpointUpdatedAt
      && inFlightNodeIds && ambiguousNodeIds && effectNodeIds && completedNodeIds) {
      const effects = new Set(effectNodeIds);
      checkpointIdentity = {
        occurrenceId,
        graphDigest,
        checkpointDigest,
        checkpointUpdatedAt,
        inFlightNodeIds,
        ambiguousNodeIds,
        completedEffectNodeIds: completedNodeIds.filter((nodeId) => effects.has(nodeId)),
      };
    }
  } catch {
    // A malformed historical checkpoint stays a visible run, but never lends
    // identity material to a terminal-close request.
  }

  const snapshot = {
    runId: row.id,
    automationId: row.automation_id ?? automationId,
    startedAt: row.started_at ?? "",
    status: (row.status as WorkflowRunSnapshot["status"]) ?? "running",
    simulation: row.dry_run === 1,
    nodeStates,
    ...(typeof tokensUsed === "number" ? { tokensUsed } : {}),
    ...(runtimeSelections.length > 0 ? { runtimeSelections } : {}),
    ...(Object.keys(nodeFailures).length > 0 ? { nodeFailures } : {}),
    ...(checkpointIdentity ?? {}),
  };
  return snapshot as WorkflowRunSnapshot;
}

/** Latest terminal row only; an intervening successful run cancels old resume state. */
export function getLatestFailedGraphCheckpoint(automationId: string): FailedGraphCheckpoint | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT 1",
    )
    .get(automationId) as AutomationRunSnapshotRow | undefined;
  if (!row || row.status !== "error") return null;
  let nodeStates: Record<string, WorkflowNodeRunState> = {};
  let checkpoint: unknown = null;
  try {
    nodeStates = row.node_states_json ? JSON.parse(row.node_states_json) as Record<string, WorkflowNodeRunState> : {};
  } catch {
    nodeStates = {};
  }
  try {
    checkpoint = row.checkpoint_json ? JSON.parse(row.checkpoint_json) : null;
  } catch {
    checkpoint = null;
  }
  return {
    runId: row.id,
    automationId: row.automation_id ?? automationId,
    occurrenceId: row.occurrence_id,
    graphDigest: row.graph_digest,
    checkpoint,
    nodeStates,
    simulation: row.dry_run === 1,
  };
}

const AUTOMATION_TERMINAL_RECEIPT_SCHEMA = "agentlas.automation-terminal-receipt.v1";
const AUTOMATION_TERMINAL_RECEIPT_KIND = "automation_scheduler_terminal";
const CHAIN_PAYLOAD_OUTPUT_BUDGET = 240 * 1024;

interface AutomationTerminalReceipt {
  schemaVersion: typeof AUTOMATION_TERMINAL_RECEIPT_SCHEMA;
  sourceAutomationId: string;
  sourceRunId: string;
  status: AutomationRunRecord["status"];
  output: string;
  outputDigest: string;
  outputBytes: number;
  outputTruncated: boolean;
  fanoutTargetIds: string[];
}

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function boundedChainOutput(value: string | undefined): {
  output: string;
  outputDigest: string;
  outputBytes: number;
  outputTruncated: boolean;
} {
  const original = value ?? "";
  const outputBytes = Buffer.byteLength(original, "utf8");
  if (outputBytes <= CHAIN_PAYLOAD_OUTPUT_BUDGET) {
    return { output: original, outputDigest: sha256Text(original), outputBytes, outputTruncated: false };
  }
  let output = original;
  while (Buffer.byteLength(output, "utf8") > CHAIN_PAYLOAD_OUTPUT_BUDGET) {
    const ratio = CHAIN_PAYLOAD_OUTPUT_BUDGET / Buffer.byteLength(output, "utf8");
    output = output.slice(0, Math.max(0, Math.floor(output.length * ratio) - 1));
  }
  return { output, outputDigest: sha256Text(original), outputBytes, outputTruncated: true };
}

function closesDurableChainCycle(sourceId: string, targetId: string, chained: Automation[]): boolean {
  if (sourceId === targetId) return true;
  const targetsBySource = new Map<string, string[]>();
  for (const automation of chained) {
    if (!automation.trigger || automation.trigger.kind !== "chain") continue;
    const targets = targetsBySource.get(automation.trigger.afterAutomationId) ?? [];
    targets.push(automation.id);
    targetsBySource.set(automation.trigger.afterAutomationId, targets);
  }
  const pending = [targetId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop() as string;
    if (current === sourceId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of targetsBySource.get(current) ?? []) pending.push(next);
  }
  return false;
}

function eligibleChainTargets(sourceAutomationId: string, output: string): string[] {
  const chained = listEnabledByTrigger("chain");
  const result: string[] = [];
  for (const automation of chained) {
    if (
      !automation.trigger || automation.trigger.kind !== "chain" ||
      automation.trigger.afterAutomationId !== sourceAutomationId
    ) continue;
    if (closesDurableChainCycle(sourceAutomationId, automation.id, chained)) {
      console.warn(`[triggers] blocked cyclic durable chain edge ${sourceAutomationId}->${automation.id}`);
      continue;
    }
    if (!evaluateCondition(automation.trigger.onlyIf, { output, ok: "true" })) continue;
    result.push(automation.id);
  }
  return [...new Set(result)].sort();
}

function parseAutomationTerminalReceipt(value: unknown): AutomationTerminalReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = [
    "schemaVersion", "sourceAutomationId", "sourceRunId", "status", "output",
    "outputDigest", "outputBytes", "outputTruncated", "fanoutTargetIds",
  ];
  if (Object.keys(row).sort().join("\0") !== keys.sort().join("\0")) return null;
  const statuses = new Set(["ok", "partial", "error", "skipped", "blocked", "needs_input"]);
  if (
    row.schemaVersion !== AUTOMATION_TERMINAL_RECEIPT_SCHEMA ||
    typeof row.sourceAutomationId !== "string" || !row.sourceAutomationId ||
    typeof row.sourceRunId !== "string" || !row.sourceRunId ||
    typeof row.status !== "string" || !statuses.has(row.status) ||
    typeof row.output !== "string" || typeof row.outputDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(row.outputDigest) ||
    typeof row.outputBytes !== "number" || !Number.isSafeInteger(row.outputBytes) || row.outputBytes < 0 ||
    typeof row.outputTruncated !== "boolean" || !Array.isArray(row.fanoutTargetIds) ||
    row.fanoutTargetIds.some((id) => typeof id !== "string" || !id) ||
    new Set(row.fanoutTargetIds).size !== row.fanoutTargetIds.length ||
    (!row.outputTruncated && sha256Text(row.output) !== row.outputDigest) ||
    Buffer.byteLength(row.output, "utf8") > CHAIN_PAYLOAD_OUTPUT_BUDGET
  ) return null;
  return row as unknown as AutomationTerminalReceipt;
}

function chainEventPayload(receipt: AutomationTerminalReceipt): string {
  return JSON.stringify({
    output: receipt.output,
    ok: "true",
    sourceAutomationId: receipt.sourceAutomationId,
    sourceRunId: receipt.sourceRunId,
    outputDigest: receipt.outputDigest,
    outputBytes: receipt.outputBytes,
    outputTruncated: receipt.outputTruncated,
  });
}

function insertChainEventForReceipt(receipt: AutomationTerminalReceipt, targetId: string, nowIso: string): boolean {
  const dedupeKey = `chain:${receipt.sourceAutomationId}:${receipt.sourceRunId}:${targetId}`;
  const inserted = getDb().prepare(
    `INSERT OR IGNORE INTO automation_trigger_events (
       id, automation_id, trigger_kind, dedupe_key, payload_json, status,
       attempt_count, next_attempt_at, created_at, updated_at
     )
     SELECT ?, ?, 'chain', ?, ?, 'pending', 0, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM automations
       WHERE id = ? AND trigger_type = 'chain'
     )`,
  ).run(
    randomUUID(), targetId, dedupeKey, chainEventPayload(receipt),
    nowIso, nowIso, nowIso, targetId,
  );
  return inserted.changes === 1;
}

/** Called inside the same transaction that records run_history. */
function recordAutomationTerminalReceipt(
  automationId: string,
  runId: string,
  status: AutomationRunRecord["status"],
  output: string | undefined,
  nowIso: string,
): AutomationTerminalReceipt {
  const bounded = boundedChainOutput(output);
  const receipt: AutomationTerminalReceipt = {
    schemaVersion: AUTOMATION_TERMINAL_RECEIPT_SCHEMA,
    sourceAutomationId: automationId,
    sourceRunId: runId,
    status,
    ...bounded,
    // Gate on the exact source value; only the durable transport copy is
    // bounded. A large output must not silently change an equality/contains
    // decision before the receipt is sealed.
    fanoutTargetIds: status === "ok" ? eligibleChainTargets(automationId, output ?? "") : [],
  };
  const existing = getDb().prepare(
    `SELECT payload_json FROM run_events
     WHERE run_id = ? AND automation_id = ? AND kind = ?
     ORDER BY seq ASC LIMIT 1`,
  ).get(runId, automationId, AUTOMATION_TERMINAL_RECEIPT_KIND) as { payload_json: string } | undefined;
  if (existing) {
    let parsed: unknown;
    try { parsed = JSON.parse(existing.payload_json); } catch { parsed = null; }
    const prior = parseAutomationTerminalReceipt(parsed);
    if (
      !prior || prior.status !== receipt.status || prior.outputDigest !== receipt.outputDigest ||
      prior.fanoutTargetIds.join("\0") !== receipt.fanoutTargetIds.join("\0")
    ) throw new Error("automation_terminal_receipt_conflict");
    return prior;
  }
  const seq = Number((getDb().prepare(
    "SELECT COALESCE(MAX(seq) + 1, 0) AS seq FROM run_events WHERE run_id = ?",
  ).get(runId) as { seq?: number } | undefined)?.seq ?? 0);
  getDb().prepare(
    `INSERT INTO run_events
       (id, run_id, seq, ts, kind, automation_id, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `evt_${randomUUID()}`, runId, seq, nowIso,
    AUTOMATION_TERMINAL_RECEIPT_KIND, automationId, JSON.stringify(receipt),
  );
  for (const targetId of receipt.fanoutTargetIds) insertChainEventForReceipt(receipt, targetId, nowIso);
  return receipt;
}

/** Repair missing fan-out rows from immutable scheduler terminal receipts. */
export function reconcileDurableChainDeliveries(limit = 200): { receipts: number; inserted: number } {
  const capped = Math.max(1, Math.min(1_000, Math.floor(limit)));
  const rows = getDb().prepare(
    `SELECT payload_json, ts FROM run_events
     WHERE kind = ? ORDER BY ts DESC, rowid DESC LIMIT ?`,
  ).all(AUTOMATION_TERMINAL_RECEIPT_KIND, capped) as Array<{ payload_json: string; ts: string }>;
  let receipts = 0;
  let inserted = 0;
  for (const row of rows) {
    let raw: unknown;
    try { raw = JSON.parse(row.payload_json); } catch { raw = null; }
    const receipt = parseAutomationTerminalReceipt(raw);
    if (!receipt || receipt.status !== "ok") continue;
    receipts += 1;
    const commit = getDb().transaction(() => {
      for (const targetId of receipt.fanoutTargetIds) {
        const target = getAutomation(targetId);
        if (
          !target?.trigger || target.trigger.kind !== "chain" ||
          target.trigger.afterAutomationId !== receipt.sourceAutomationId
        ) continue;
        if (insertChainEventForReceipt(receipt, targetId, row.ts)) inserted += 1;
      }
    });
    commit.immediate();
  }
  return { receipts, inserted };
}

/** run_history 행 1개 기록. 놓친 실행/스킵/에러를 가시화(설계 §2.7). */
export function recordRun(input: {
  automationId: string;
  scheduledFor?: string | null;
  ranAt?: string;
  status: AutomationRunRecord["status"];
  skippedCount?: number;
  error?: string | null;
  outcome?: AutomationRunRecord["outcome"];
  outcomeReason?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO run_history
         (id, automation_id, scheduled_for, ran_at, status, skipped_count, error, outcome, outcome_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.automationId,
      input.scheduledFor ?? null,
      input.ranAt ?? new Date().toISOString(),
      input.status,
      input.skippedCount ?? 0,
      input.error ?? null,
      input.outcome ?? null,
      input.outcomeReason ?? null,
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
    // ★모르는 것을 accepted로 메꾸지 않는다. 옛 행은 outcome이 없다 — 그때는 이 두 답이
    //   한 칸에 섞여 있었고, 지금 와서 어느 쪽이었는지 복원할 방법이 없다.
    outcome: (r.outcome as AutomationRunRecord["outcome"]) ?? null,
    outcomeReason: r.outcome_reason ?? null,
    skippedCount: r.skipped_count ?? 0,
    error: r.error,
    acknowledgedAt: (r as { acknowledged_at?: string | null }).acknowledged_at ?? null,
  }));
}

/**
 * 확인필요 카드의 닫기 — 실행 기록은 그대로 두고 "지금 조치하라"는 요구만 닫는다.
 * (오너 보고 2026-08-06: 옛 핀 시절 실행의 "클로드 재로그인" 카드가 해소 수단 없이
 * 계속 남았다. 기록 삭제가 아니라 요구 해소이므로 acknowledged_at 한 칸이면 된다.)
 */
/**
 * 이 자동화의 "지금까지의 확인 요구"를 전부 닫는다 — **실행 id 없이**.
 *
 * ★막다른 길을 구조적으로 없애기 위한 종결 행동이다(2026-08-09).
 * 예전 닫기(`acknowledgeAutomationRun`)는 run_history 의 특정 행을 앵커로 요구했다.
 * 그런데 카드가 뜨는 근거는 그 행만이 아니다 — 스냅샷의 error 로도 뜬다. 그래서
 * 앵커로 쓸 행이 없으면 **닫기 버튼 자체가 사라졌고**, 사용자에게는 끌 수 없는 카드가
 * 남았다. 어떤 카드든 끝낼 수 있는 행동이 하나는 있어야 한다.
 *
 * 닫는 것은 "요구"이지 "기록"이 아니다 — 실행 기록은 목록에 그대로 남는다.
 * 이후에 생기는 새 요구는 건드리지 않는다(now 이하만).
 */
export function acknowledgeAutomationAttention(automationId: string): number {
  const now = new Date().toISOString();
  // 스냅샷의 error 로 떠 있는 카드도 같이 닫는다 — 근거가 둘인데 하나만 닫으면
  // 눌러도 그대로 남는다(그게 막다른 길이었다).
  getDb().prepare("UPDATE automations SET attention_cleared_at = ? WHERE id = ?").run(now, automationId);
  const res = getDb()
    .prepare(
      `UPDATE run_history SET acknowledged_at = ?
       WHERE automation_id = ? AND acknowledged_at IS NULL
         AND (status IN ('error','needs_input','blocked','partial')
           OR outcome IN ('needs_input','blocked','rejected'))`,
    )
    .run(now, automationId);
  return res.changes;
}

export function acknowledgeAutomationRun(automationId: string, runId: string): boolean {
  const db = getDb();
  const anchor = db
    .prepare("SELECT ran_at FROM run_history WHERE automation_id = ? AND id = ?")
    .get(automationId, runId) as { ran_at?: string } | undefined;
  if (!anchor?.ran_at) return false;
  // 닫는 대상은 "실행 1건"이 아니라 "지금 화면의 요구"다 — 카드는 가장 최근의
  // 미해소 실행을 대표로 세우므로, 그 시점까지의 미해소 요구를 전부 닫지 않으면
  // 닫기를 눌러도 카드가 다음 옛 실행으로 갈아타며 남는다(실측 2026-08-06).
  // 이후에 생기는 새 실행의 요구는 건드리지 않는다.
  const res = db
    .prepare(
      `UPDATE run_history SET acknowledged_at = ?
       WHERE automation_id = ? AND acknowledged_at IS NULL AND ran_at <= ?
         AND (status IN ('error','needs_input','blocked','partial')
           OR outcome IN ('needs_input','blocked','rejected'))`,
    )
    .run(new Date().toISOString(), automationId, anchor.ran_at);
  return res.changes > 0;
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
  opts?: {
    status?: AutomationRunRecord["status"];
    error?: string | null;
    advanceSchedule?: boolean;
    /** False for partial/blocked/error attempts: keep max_runs for completed occurrences. */
    executionConsumed?: boolean;
    /** One-shot failures remain retryable instead of silently disabling. */
    deferredRetryMs?: number;
    /** Durable scheduler run receipt used for exactly-once chain fan-out. */
    sourceRunId?: string | null;
    /** Final source output carried into chain trigger variables. */
    output?: string;
    /** Keep the automation enabled but atomically remove its next due slot
     * when this occurrence needs explicit side-effect reconciliation. */
    suspendForReconciliation?: boolean;
    /**
     * 판정의 답 — **결과물이 쓸 만한가**. status(끝까지 돌았는가)와 다른 질문이라
     * 다른 칸에 앉는다. 예전엔 판정이 status를 덮어써서 끝까지 잘 돈 실행이 화면에
     * "내 확인 필요"로만 보였다.
     */
    outcome?: AutomationRunRecord["outcome"];
    outcomeReason?: string | null;
  },
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

  const executionConsumed = opts?.executionConsumed ?? true;
  const runCount = (row.run_count ?? 0) + (executionConsumed ? 1 : 0);
  // 전진하지 않으면 next_run_at은 그대로 둔다(이벤트=null 유지, 시계=다음 예약 슬롯 유지).
  const computedNextRunAt = advance
    ? computeNextRun(row.schedule, at, { scheduleJson: row.schedule_json, timezone: tz })
    : row.next_run_at;

  // 종료 조건 판정. reachedMax/pastEnd는 트리거 종류 무관하게 적용(N회/기한 후 자동 비활성).
  const reachedMax = executionConsumed && row.max_runs != null && runCount >= row.max_runs;
  const pastEnd = row.end_at != null && Date.parse(row.end_at) <= at.getTime();
  const noFuture = advance && computedNextRunAt == null;
  const deferredRetryMs = Math.max(60_000, Math.min(opts?.deferredRetryMs ?? 15 * 60_000, 24 * 60 * 60_000));
  const deferredRetryAt = new Date(at.getTime() + deferredRetryMs).toISOString();
  const nextRunAt = !executionConsumed && !pastEnd && advance
    ? computedNextRunAt == null || Date.parse(computedNextRunAt) > Date.parse(deferredRetryAt)
      ? deferredRetryAt
      : computedNextRunAt
    : computedNextRunAt;
  const shouldDisable = reachedMax || pastEnd || (noFuture && executionConsumed);

  const atIso = at.toISOString();
  const terminalStatus = opts?.status ?? "ok";
  const sourceRunId = opts?.sourceRunId?.trim() || null;
  if (sourceRunId && (sourceRunId.length > 512 || sourceRunId.includes("\0"))) {
    throw new Error("automation_terminal_run_id_invalid");
  }
  // Source history, its immutable scheduler receipt, and every downstream
  // chain occurrence are one commit. A crash can expose all of them or none of
  // them, never a successful source receipt without its fan-out.
  const commit = db.transaction(() => {
    const persistedNextRunAt = opts?.suspendForReconciliation === true
      ? null
      : shouldDisable
        ? null
        : nextRunAt;
    const updated = db.prepare(
      "UPDATE automations SET last_run_at = ?, next_run_at = ?, run_count = ?, enabled = ? WHERE id = ?",
    ).run(atIso, persistedNextRunAt, runCount, shouldDisable ? 0 : row.enabled, id);
    if (updated.changes !== 1) throw new AutomationRunParentMissingError(id);
    db.prepare(
      `INSERT INTO run_history
         (id, automation_id, scheduled_for, ran_at, status, skipped_count, error, outcome, outcome_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sourceRunId ?? randomUUID(), id, row.next_run_at, atIso, terminalStatus,
      skipped > 0 ? skipped : 0, opts?.error ?? null,
      opts?.outcome ?? null, opts?.outcomeReason ?? null,
    );
    if (sourceRunId) {
      recordAutomationTerminalReceipt(id, sourceRunId, terminalStatus, opts?.output, atIso);
    }
  });
  commit.immediate();
  emitDesktopStoreChange({ entity: "automation", id });
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

/**
 * The pid inside a lease owner string, when this machine can vouch for it.
 *
 * The desktop writes `<pid>:gui|headless`; the terminal CLI, which shares this
 * SQLite file, writes `cli:<hostname>:<pid>` (agentlas_terminal
 * engine/automation/store.cjs). Only the desktop form was recognised, so a live
 * CLI owner always fell through to "no trusted owner" and its automation was
 * reclaimed the moment the 15-minute TTL passed — routine for an agent session,
 * and the CLI run keeps going while a second executor starts on top of it.
 *
 * A pid is only meaningful on the machine that minted it, so the CLI form is
 * trusted only when the recorded hostname is this host. Both products write
 * their owner string here; keep the two formats in step.
 */
function trustedAutomationLeasePid(owner: string | null): number | null {
  const asPid = (value: string): number | null => {
    const pid = Number(value);
    return Number.isSafeInteger(pid) && pid > 0 && pid <= 2_147_483_647 ? pid : null;
  };
  const desktop = owner?.match(/^([1-9][0-9]*):(gui|headless)$/);
  if (desktop) return asPid(desktop[1]);
  const cli = owner?.match(/^cli:(.+):([1-9][0-9]*)$/);
  if (cli && cli[1] === hostname()) return asPid(cli[2]);
  return null;
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

export interface AutomationLeaseOptions {
  /** Explicit Run now may execute a disabled automation, but it must still own the shared lease. */
  allowDisabled?: boolean;
}

/**
 * 자동화 실행을 원자적으로 클레임한다(설계 §2.6 크로스프로세스 리스). 헤드리스 launchd 러너와
 * 열린 GUI가 같은 SQLite를 공유하므로 due/Run now/이벤트 발사가 같은 행을 겹쳐 실행하지 않는다.
 * claimed_at이 비었거나 TTL을 넘긴 경우에만 owner를 기록하며 잡는다.
 * @returns 이 프로세스가 실행 권한을 얻으면 true.
 */
export function claimAutomationRun(
  id: string,
  owner: string,
  now: Date = new Date(),
  options: AutomationLeaseOptions = {},
): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT enabled, claimed_at, lease_owner FROM automations WHERE id = ?")
    .get(id) as Pick<AutomationRow, "enabled" | "claimed_at" | "lease_owner"> | undefined;
  if (!row || (!options.allowDisabled && row.enabled !== 1)) return false;

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
         WHERE id = ?
           AND (? = 1 OR enabled = 1)
           AND claimed_at IS ?
           AND lease_owner IS ?`,
    )
    .run(now.toISOString(), owner, id, options.allowDisabled ? 1 : 0, row.claimed_at, row.lease_owner);
  if (result.changes > 0) emitDesktopStoreChange({ entity: "automation", id });
  return result.changes > 0;
}

/**
 * Extend a due-run lease only while this exact owner still holds it.
 * false is a definitive ownership loss; SQLite busy/I/O errors throw so the
 * scheduler can treat a transient renewal failure as retryable, not ownership loss.
 */
export function renewAutomationRunLease(
  id: string,
  owner: string,
  now: Date = new Date(),
  options: AutomationLeaseOptions = {},
): boolean {
  const result = getDb()
    .prepare(
      `UPDATE automations SET claimed_at = ?
       WHERE id = ?
         AND (? = 1 OR enabled = 1)
         AND lease_owner = ?
         AND claimed_at IS NOT NULL`,
    )
    .run(now.toISOString(), id, options.allowDisabled ? 1 : 0, owner);
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
  if (result.changes > 0) emitDesktopStoreChange({ entity: "automation", id });
  return result.changes > 0;
}

// ── 노드 승인 브레이크 ────────────────────────────────────────────────────
// "이 단계는 사람이 확인한 뒤에 나간다"는 계약. 승인은 판정이 아니라 사람의 결정이므로
// 모델 가용성과 무관하게 동작해야 하고, 앱을 껐다 켜도 남아야 한다.

export type AutomationNodeApprovalDecision = "approved" | "rejected";

export interface AutomationNodeApproval {
  automationId: string;
  occurrenceId: string;
  nodeId: string;
  decision: AutomationNodeApprovalDecision;
  decidedAt: string;
  decidedBy: string;
}

/** 이 occurrence에 대한 결정(매번 승인 모드). */
export function getNodeApproval(
  automationId: string,
  occurrenceId: string,
  nodeId: string,
): AutomationNodeApproval | null {
  const row = getDb().prepare(
    `SELECT automation_id, occurrence_id, node_id, decision, decided_at, decided_by
       FROM automation_node_approvals
      WHERE automation_id = ? AND occurrence_id = ? AND node_id = ?`,
  ).get(automationId, occurrenceId, nodeId) as
    | { automation_id: string; occurrence_id: string; node_id: string; decision: string; decided_at: string; decided_by: string }
    | undefined;
  if (!row) return null;
  return {
    automationId: row.automation_id,
    occurrenceId: row.occurrence_id,
    nodeId: row.node_id,
    decision: row.decision === "rejected" ? "rejected" : "approved",
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

/** 이 노드에 대한 가장 최근 승인(첫 1회만 승인 모드). 거절은 재사용하지 않는다. */
export function getLatestNodeApproval(
  automationId: string,
  nodeId: string,
): AutomationNodeApproval | null {
  const row = getDb().prepare(
    `SELECT automation_id, occurrence_id, node_id, decision, decided_at, decided_by
       FROM automation_node_approvals
      WHERE automation_id = ? AND node_id = ? AND decision = 'approved'
      ORDER BY decided_at DESC LIMIT 1`,
  ).get(automationId, nodeId) as
    | { automation_id: string; occurrence_id: string; node_id: string; decision: string; decided_at: string; decided_by: string }
    | undefined;
  if (!row) return null;
  return {
    automationId: row.automation_id,
    occurrenceId: row.occurrence_id,
    nodeId: row.node_id,
    decision: "approved",
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

/**
 * 이 단계의 승인을 **언제부터** 기다렸는가 (커넥터 C43).
 * 처음 물어본 시각을 남기고, 이미 있으면 그대로 둔다 — 매 실행마다 시계를 되감으면
 * 아무리 기다려도 만료가 오지 않는다.
 */
export function markApprovalWaitStarted(automationId: string, nodeId: string): string {
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO automation_approval_waits (automation_id, node_id, first_requested_at)
     VALUES (?, ?, ?)
     ON CONFLICT(automation_id, node_id) DO NOTHING`,
  ).run(automationId, nodeId, now);
  const row = getDb().prepare(
    "SELECT first_requested_at FROM automation_approval_waits WHERE automation_id = ? AND node_id = ?",
  ).get(automationId, nodeId) as { first_requested_at?: string } | undefined;
  return row?.first_requested_at ?? now;
}

/** 결정이 오면 시계를 지운다 — 다음에 다시 물을 때는 그때부터 센다. */
export function clearApprovalWait(automationId: string, nodeId: string): void {
  getDb().prepare(
    "DELETE FROM automation_approval_waits WHERE automation_id = ? AND node_id = ?",
  ).run(automationId, nodeId);
}

/**
 * ★이 노드에 "항상 허용"이 걸려 있는가. 그래프가 아니라 **승인 기록**에서 읽는다
 *   (그래프를 바꾸면 digest가 달라져 멈춘 실행의 재개가 거부되기 때문 — db.ts 주석 참조).
 *   거부가 나중에 오면 항상 허용은 무효다: 사람이 마음을 바꾼 것이 최신 결정이다.
 */
export function getAlwaysAllowApproval(
  automationId: string,
  nodeId: string,
): AutomationNodeApproval | null {
  const row = getDb().prepare(
    `SELECT automation_id, occurrence_id, node_id, decision, decided_at, decided_by
       FROM automation_node_approvals
      WHERE automation_id = ? AND node_id = ?
      ORDER BY decided_at DESC LIMIT 1`,
  ).get(automationId, nodeId) as
    | { automation_id: string; occurrence_id: string; node_id: string; decision: string; decided_at: string; decided_by: string }
    | undefined;
  if (!row || row.decision !== "approved") return null;
  const scoped = getDb().prepare(
    `SELECT 1 FROM automation_node_approvals
      WHERE automation_id = ? AND node_id = ? AND occurrence_id = ? AND scope = 'always'`,
  ).get(automationId, nodeId, row.occurrence_id);
  if (!scoped) return null;
  return {
    automationId: row.automation_id,
    occurrenceId: row.occurrence_id,
    nodeId: row.node_id,
    decision: row.decision as AutomationNodeApprovalDecision,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

export interface AutomationEvalCorrection {
  subjectPreview: string;
  correctedVerdict: "pass" | "fail";
  note: string;
  createdAt: string;
}

/** "이 판정은 틀렸다" — 사람의 교정을 남긴다. 이후 그 노드의 판정에 few-shot으로 주입된다. */
export function recordEvalCorrection(input: {
  automationId: string;
  nodeId: string;
  subjectPreview: string;
  correctedVerdict: "pass" | "fail";
  note?: string;
}): void {
  getDb().prepare(
    `INSERT OR REPLACE INTO automation_eval_corrections
       (automation_id, node_id, subject_preview, corrected_verdict, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.automationId, input.nodeId,
    input.subjectPreview.slice(0, 600),
    input.correctedVerdict,
    (input.note ?? "").slice(0, 400),
    new Date().toISOString(),
  );
  emitDesktopStoreChange({ entity: "automation", id: input.automationId });
}

/** 최근 교정 몇 건 — 판정 few-shot 재료. 많이 넣을수록 좋은 게 아니라 최신이 사람의 현재 기준이다. */
export function listEvalCorrections(
  automationId: string,
  nodeId: string,
  limit = 5,
): AutomationEvalCorrection[] {
  const rows = getDb().prepare(
    `SELECT subject_preview, corrected_verdict, note, created_at
       FROM automation_eval_corrections
      WHERE automation_id = ? AND node_id = ?
      ORDER BY created_at DESC LIMIT ?`,
  ).all(automationId, nodeId, limit) as Array<{
    subject_preview: string; corrected_verdict: string; note: string; created_at: string;
  }>;
  return rows.map((row) => ({
    subjectPreview: row.subject_preview,
    correctedVerdict: row.corrected_verdict === "pass" ? "pass" : "fail",
    note: row.note,
    createdAt: row.created_at,
  }));
}

export function recordNodeApproval(input: {
  automationId: string;
  occurrenceId: string;
  nodeId: string;
  decision: AutomationNodeApprovalDecision;
  decidedBy?: string;
  /** "always"면 이 노드는 앞으로 다시 묻지 않는다(그래프는 안 바뀐다). */
  scope?: "once" | "always";
}): AutomationNodeApproval {
  const decidedAt = new Date().toISOString();
  const decidedBy = input.decidedBy?.trim() || "user";
  const scope = input.scope === "always" ? "always" : "once";
  getDb().prepare(
    `INSERT INTO automation_node_approvals
       (automation_id, occurrence_id, node_id, decision, decided_at, decided_by, scope)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(automation_id, occurrence_id, node_id)
     DO UPDATE SET decision = excluded.decision, decided_at = excluded.decided_at,
                   decided_by = excluded.decided_by, scope = excluded.scope`,
  ).run(input.automationId, input.occurrenceId, input.nodeId, input.decision, decidedAt, decidedBy, scope);
  // 결정이 왔으니 기다린 시계는 지운다.
  clearApprovalWait(input.automationId, input.nodeId);
  emitDesktopStoreChange({ entity: "automation", id: input.automationId });
  return {
    automationId: input.automationId,
    occurrenceId: input.occurrenceId,
    nodeId: input.nodeId,
    decision: input.decision,
    decidedAt,
    decidedBy,
  };
}

/** 승인 결정을 묶을 대상 — 가장 최근 실행의 occurrence. 없으면 null(지어내지 않는다). */
export function getLatestGraphRunOccurrence(automationId: string): string | null {
  const row = getDb().prepare(
    "SELECT occurrence_id FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT 1",
  ).get(automationId) as { occurrence_id: string | null } | undefined;
  return row?.occurrence_id ?? null;
}

/**
 * 승인이 결정된 노드의 실패 기록을 최신 실행 스냅샷에서 지운다.
 *
 * ★승인 무한루프의 절반(실측 2026-08-08, 화면 녹화): 사람이 [항상 허용]을 눌러도
 * 스냅샷의 node_failures_json에는 APPROVAL_REQUIRED가 그대로 남아, 라이브 폴링이
 * 몇 초마다 승인 카드를 되살렸다 — 사람은 방금 승인한 단계에게 영원히 다시
 * 승인을 요구받았다. 결정은 기록됐으니 "지금 조치하라"는 카드의 근거를 지운다.
 */
export function clearGraphRunFailureForNode(automationId: string, nodeId: string): void {
  const db = getDb();
  const row = db.prepare(
    "SELECT id, node_failures_json FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT 1",
  ).get(automationId) as { id: string; node_failures_json: string | null } | undefined;
  if (!row?.node_failures_json) return;
  try {
    const failures = JSON.parse(row.node_failures_json) as Record<string, unknown>;
    if (!(nodeId in failures)) return;
    delete failures[nodeId];
    const payload = Object.keys(failures).length > 0 ? JSON.stringify(failures) : null;
    db.prepare("UPDATE automation_runs SET node_failures_json = ? WHERE id = ?").run(payload, row.id);
  } catch {
    // 손상된 JSON은 여기서 고치지 않는다 — 카드 부활보다 나쁜 것은 조용한 데이터 파괴다.
  }
}

/** 실패 3요소를 실행 스냅샷에 남긴다. 화면 실패 카드가 읽는 유일한 출처다. */
export function saveGraphRunFailures(
  runId: string,
  failures: Record<string, { code: string; reason: string; nextAction: string }>,
): void {
  const payload = Object.keys(failures).length > 0 ? JSON.stringify(failures) : null;
  getDb().prepare("UPDATE automation_runs SET node_failures_json = ? WHERE id = ?").run(payload, runId);
}

/**
 * 재개 좌표를 원자적으로 소비한다. 이긴 쪽만 true를 받는다.
 *
 * 예전에는 재개 좌표라는 것이 없었고, "가장 최근 실패한 실행"을 매번 다시 읽었다. 같은
 * 실패 스냅샷을 두 곳(스케줄 발화와 수동 실행 등)이 동시에 집으면 둘 다 재개해, 이미
 * 끝난 단계가 두 번 실행될 수 있었다.
 */
/**
 * 집었지만 **한 단계도 돌리지 못한** 재개 좌표를 놓는다.
 *
 * 실측 2026-08-20: 재개 직전 검사(그래프 변경·재조정 필요 등)에 걸려 나가는 길들이
 * 좌표를 쥔 채 나갔고, 그 표식은 아무도 대신 풀어 주지 않아 다음 시도가 곧바로
 * RESUME_CONFLICT 로 거절됐다. 사람 눈에는 "고쳤는데 또 안 된다"로 보인다.
 *
 * ★이미 이어서 돈 실행이 있으면 놓지 않는다 — 그 좌표는 지금 진짜로 쓰이고 있다.
 */
export function releaseGraphResumeCoordinate(checkpointRunId: string): void {
  getDb().prepare(
    `UPDATE automation_runs SET resume_consumed_at = NULL
      WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM automation_runs successor WHERE successor.resume_of_run_id = ?)`,
  ).run(checkpointRunId, checkpointRunId);
}

/**
 * 사람이 **권한만** 허락했을 때, 그것이 "그래프가 바뀌었다"로 읽히지 않게 재개 좌표의
 * digest 를 새 값으로 맞춰 준다.
 *
 * 권한은 실행 digest 에 들어 있어서(graph-execution-digest.ts), 허용만 해도 digest 가
 * 바뀌고 이미 부수효과를 낸 실행이 있으면 다음 실행이 `automation_partial_graph_changed`
 * 로 막힌다. 그런데 권한을 올리는 것은 **일이 바뀐 것이 아니라 사람이 허락한 것**이다 —
 * 단계도, 하는 일도, 노드 정체성도 그대로다.
 *
 * ★그래프 자체를 바꿀 때는 절대 부르면 안 된다. 그때는 재조정이 옳다.
 */
export function rebaseGraphDigestAfterAuthorization(automationId: string, newDigest: string): void {
  getDb().prepare(
    `UPDATE automation_runs SET graph_digest = ?
      WHERE automation_id = ? AND graph_digest IS NOT NULL`,
  ).run(newDigest, automationId);
}

/**
 * 재개 좌표를 집고 나서 그 실행 행이 나타나기까지 기다려 주는 폭.
 * 살아 있음의 판정이 아니라 **시작 유예**다 — 버려진 행을 거두는 임계값과 단위가 다르다.
 */
const RESUME_STARTUP_GRACE_MS = 2 * 60 * 1000;

export function consumeGraphResumeCoordinate(checkpointRunId: string): boolean {
  /*
   * ★소비는 **점유**이지 낙인이 아니다.
   *
   *   실측 2026-08-20: 이 저장소에 소비된 좌표가 302건 있었고 그중 **아직 도는 것은
   *   0건**이었다. 좌표를 집은 실행이 죽으면 표식만 남아, 아무것도 돌지 않는데
   *   "다른 실행이 이미 같은 지점에서 이어서 돌고 있습니다" 라며 그 자동화를
   *   **영구히 거부**했다. 사람이 할 수 있는 일이 없다 — 실행할 때마다 같은 말을 듣는다.
   *
   *   막으려던 것은 "동시에 두 실행이 같은 좌표를 재개하는 것"이지 "다시는 재개하지
   *   않는 것"이 아니다. 그러니 집은 실행이 더 이상 살아 있지 않으면 다시 집을 수 있다.
   *   살아 있음의 기준은 이 저장소의 정본(AUTOMATION_RUN_STALE_AFTER_MS)을 쓴다 —
   *   여기서 새 임계값을 지어내면 규칙이 둘로 갈린다.
   *
   *   동시성은 그대로 지킨다: 조건부 UPDATE 한 문장이라 둘이 같이 들어와도 한쪽만
   *   changes===1 을 받는다(진 쪽의 조건은 방금 갱신된 시각 때문에 더는 성립하지 않는다).
   */
  const db = getDb();
  const nowIso = new Date().toISOString();
  const row = db.prepare(
    "SELECT status, last_activity_at, started_at, resume_consumed_at FROM automation_runs WHERE id = ?",
  ).get(checkpointRunId) as
    | { status: string; last_activity_at: string | null; started_at: string; resume_consumed_at: string | null }
    | undefined;
  if (!row) return false;

  if (row.resume_consumed_at === null) {
    const first = db.prepare(
      "UPDATE automation_runs SET resume_consumed_at = ? WHERE id = ? AND resume_consumed_at IS NULL",
    ).run(nowIso, checkpointRunId);
    return first.changes === 1;
  }

  /*
   * 이미 집혀 있다. 집은 실행이 **아직 살아 있는가**만 본다.
   *
   * ★끝난 실행(status ≠ running)에는 경합이 없다 — 그 실행은 더 이상 아무 단계도 돌리지
   *   않는다. 처음에는 여기에도 시간 조건을 걸었는데, 이 저장소의 정본 임계값은 4시간
   *   2분이라 **8분 전에 끝난 실행 때문에 4시간을 기다려야 했다**(실측 2026-08-20:
   *   그 상태로 재시도가 계속 RESUME_CONFLICT 로 거절됐다). 상태만 running 인 채 오래
   *   조용한 좀비에만 시간 기준이 필요하다.
   *
   * 동시성은 시간이 아니라 **비교-교환**으로 지킨다: 내가 본 그 값일 때만 바꾼다.
   * 둘이 같이 들어오면 한쪽만 changes===1 을 받는다.
   */
  /*
   * ★"집었다"와 "정말로 이어서 돌았다"는 다르다. 이어서 돈 실행은 이 좌표를 가리키는
   *   **후속 실행 행**을 남긴다(resume_of_run_id). 그 행이 없다면 집기만 하고 시작하지
   *   못한 것이고, 그 표식은 아무도 대신 풀어 주지 않는다.
   *
   *   시간으로 판정하지 않는다. 이 저장소의 정본 임계값은 4시간 2분이라, 8분 전에 끝난
   *   실행 때문에 사람이 4시간을 기다려야 했다(실측 2026-08-20). 기다림의 길이를 새로
   *   정하는 대신 **일이 실제로 일어났는지**를 본다.
   */
  const successor = db.prepare(
    "SELECT id FROM automation_runs WHERE resume_of_run_id = ? LIMIT 1",
  ).get(checkpointRunId) as { id: string } | undefined;
  if (successor) return false;
  /*
   * 후속 실행이 아직 없다 — 방금 집어서 이제 막 시작하는 중일 수도 있다. 그 짧은 사이에
   * 두 번째가 들어오면 같은 단계가 두 번 돈다. 그래서 **시작 유예**만큼은 기다린다.
   * 이건 "살아 있는가"의 판정이 아니라 "집고 나서 실행 행이 생기기까지"의 폭이므로,
   * 버려진 행을 거두는 4시간짜리 임계값과는 단위가 다르다.
   */
  const claimedAtMs = Date.parse(row.resume_consumed_at);
  if (Number.isFinite(claimedAtMs) && Date.now() - claimedAtMs < RESUME_STARTUP_GRACE_MS) return false;

  const retaken = db.prepare(
    "UPDATE automation_runs SET resume_consumed_at = ? WHERE id = ? AND resume_consumed_at = ?",
  ).run(nowIso, checkpointRunId, row.resume_consumed_at);
  return retaken.changes === 1;
}

// ── 입력 트리거 값 ─────────────────────────────────────────────────────────
// 입력으로 시작하는 그래프는 사람이 준 값 없이는 의미가 없다. 그 값을 담을 자리가
// 없던 동안 터미널은 값을 물어보고 버렸고(사용자에겐 전달된 것처럼 보였다),
// 데스크탑은 아예 묻지 않은 채 빈 값으로 실행했다.
//
// 값은 한 번만 쓰인다 — 예약이 여러 번 돌 때 옛 입력이 다시 실행되면
// 사용자가 요청한 적 없는 실행이 된다. 소비는 조건부 UPDATE로 한쪽만 이긴다.

export const RUN_INPUT_MAX_BYTES = 256 * 1024;

export interface PendingRunInput {
  id: string;
  payload: Record<string, unknown>;
  requestedBy: string;
  createdAt: string;
}

/** 실행 요청과 함께 들어온 값을 대기시킨다. 다음 실행 1회가 이 값을 집어간다. */
export function enqueueRunInput(
  automationId: string,
  payload: Record<string, unknown>,
  requestedBy: string,
): string {
  const json = JSON.stringify(payload ?? {});
  if (Buffer.byteLength(json, "utf8") > RUN_INPUT_MAX_BYTES) {
    throw new Error("automation_run_input_too_large");
  }
  const id = randomUUID();
  getDb().prepare(
    `INSERT INTO automation_run_inputs (id, automation_id, payload_json, requested_by, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, automationId, json, requestedBy, new Date().toISOString());
  return id;
}

/** 대기 중인 입력이 있는가. 화면이 "값 대기 중"이라고 말하려면 필요하다. */
export function peekRunInput(automationId: string): PendingRunInput | null {
  const row = getDb().prepare(
    `SELECT id, payload_json, requested_by, created_at FROM automation_run_inputs
     WHERE automation_id = ? AND consumed_at IS NULL ORDER BY created_at LIMIT 1`,
  ).get(automationId) as
    | { id: string; payload_json: string; requested_by: string; created_at: string }
    | undefined;
  if (!row) return null;
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    payload = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  return { id: row.id, payload, requestedBy: row.requested_by, createdAt: row.created_at };
}

/**
 * 가장 오래된 미소비 입력을 이 실행에 묶는다. 소비에 실패하면(다른 실행이 먼저 가져감)
 * null을 돌려준다 — 같은 값으로 두 번 실행하지 않기 위해서다.
 */
export function consumeRunInput(automationId: string, runId: string): PendingRunInput | null {
  const pending = peekRunInput(automationId);
  if (!pending) return null;
  const claimed = getDb().prepare(
    "UPDATE automation_run_inputs SET consumed_at = ?, consumed_run_id = ? WHERE id = ? AND consumed_at IS NULL",
  ).run(new Date().toISOString(), runId, pending.id);
  return claimed.changes === 1 ? pending : null;
}

// ── 실행 저널 ──────────────────────────────────────────────────────────────
// append-only. 체크포인트(현재 상태 1건)와 달리 순서가 남으므로, "의도는 남았는데
// 정산이 없다" 같은 부분 실패 신호를 사후에 읽을 수 있다.

/**
 * 저널 종류. **선언은 레지스트리에 있고 여기는 파생이다**(06 §2.1 사본 금지).
 * 값을 늘리려면 `shared/graph-registry/journal.json` 을 고치고
 * `node scripts/gen-graph-registry.cjs` 를 다시 돌린다 — 여기 손으로 적으면
 * 적합성 게이트가 잡는다.
 */
export type GraphJournalKind = GraphJournalKindGenerated;

export interface GraphJournalEntry {
  seq: number;
  ts: string;
  kind: GraphJournalKind;
  nodeId: string | null;
  payload: Record<string, unknown> | null;
}

/** 다음 seq를 계산해 한 줄 덧붙인다. 저널 쓰기 실패가 실행을 멈추지는 않는다. */
export function appendGraphJournal(
  runId: string,
  kind: GraphJournalKind,
  nodeId?: string | null,
  payload?: Record<string, unknown>,
): void {
  const db = getDb();
  const row = db.prepare("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM graph_run_journal WHERE run_id = ?")
    .get(runId) as { maxSeq: number } | undefined;
  const seq = (row?.maxSeq ?? 0) + 1;
  db.prepare(
    "INSERT OR IGNORE INTO graph_run_journal (run_id, seq, ts, kind, node_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(runId, seq, new Date().toISOString(), kind, nodeId ?? null, payload ? JSON.stringify(payload) : null);
}

export function listGraphJournal(runId: string, limit = 500): GraphJournalEntry[] {
  const rows = getDb().prepare(
    "SELECT seq, ts, kind, node_id, payload_json FROM graph_run_journal WHERE run_id = ? ORDER BY seq ASC LIMIT ?",
  ).all(runId, Math.max(1, Math.min(5000, limit))) as Array<{
    seq: number; ts: string; kind: string; node_id: string | null; payload_json: string | null;
  }>;
  return rows.map((row) => {
    let payload: Record<string, unknown> | null = null;
    try {
      payload = row.payload_json ? (JSON.parse(row.payload_json) as Record<string, unknown>) : null;
    } catch {
      payload = null;
    }
    return { seq: row.seq, ts: row.ts, kind: row.kind as GraphJournalKind, nodeId: row.node_id, payload };
  });
}

/**
 * 실행 의도만 남고 정산이 없는 노드 — 바깥에 반영됐는지 알 수 없는 지점.
 * 재개할 때 "그냥 다시 실행"과 "사람에게 물어봄"을 가르는 근거다.
 */
export function unsettledJournalNodes(runId: string): string[] {
  const entries = listGraphJournal(runId);
  const intent = new Set<string>();
  for (const entry of entries) {
    if (!entry.nodeId) continue;
    if (entry.kind === "node_intent") intent.add(entry.nodeId);
    if (entry.kind === "node_settled" || entry.kind === "node_failed") intent.delete(entry.nodeId);
  }
  return [...intent].sort();
}
