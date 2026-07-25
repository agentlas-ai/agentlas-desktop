// 자동화 — SQLite 영속 + 스케줄 next-run 계산. (이전 M0 in-memory stub 대체)
// targetType: agent(개별 에이전트) | firm(CEO 호출). createdBy: user(폼) | agent(채팅 emitter).
// 실제 실행은 automation-scheduler.ts가 dueAutomations()를 폴링해 백그라운드 chat으로 돌린다.
//
// v33: next-run 계산을 schedule.ts(croner)에 위임한다. computeNextRun은 이제 string|null을
// 반환하며(null=미래 발생 없음 → 종료), markAutomationRun은 misfire coalesce 정책 + run_history
// 기록 + max_runs/end_at 종료를 적용한다. graph_json/schedule_json/timezone은 additive.
import { judgedComputerUse } from "../system-agents/judged-tool-mode";
import { createHash, randomUUID } from "node:crypto";
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
  WorkflowRunSnapshot,
} from "../../shared/types";

interface AutomationRow {
  id: string;
  name: string;
  schedule: string;
  target_type: AutomationTargetType;
  target_id: string;
  prompt_template: string;
  execution_permission: string | null;
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

const RUNTIME_KINDS = new Set([
  "claude-code", "codex", "gemini", "kimi", "grok", "cursor", "byok", "ollama", "lmstudio", "mlx",
]);
const RUNTIME_BACKENDS = new Set([
  "anthropic", "openai", "google", "ollama", "lmstudio", "mlx", "upstage", "custom", "glm",
  "kimi", "deepseek", "minimax", "xai", "openrouter", "cursor",
]);
const RUNTIME_SELECTION_KEYS = new Set(["kind", "backend", "source", "model", "longContext", "effort"]);

type StoredContractState = "missing" | "valid" | "invalid";

function decodeRuntimeSelection(raw: string | null | undefined): {
  state: StoredContractState;
  value?: RuntimeSelection;
} {
  if (raw == null) return { state: "missing" };
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).every((key) => RUNTIME_SELECTION_KEYS.has(key)) &&
      typeof value.kind === "string" && RUNTIME_KINDS.has(value.kind) &&
      (value.backend === undefined || typeof value.backend === "string" && RUNTIME_BACKENDS.has(value.backend)) &&
      (value.source === undefined || typeof value.source === "string" && value.source.length > 0 && value.source.length <= 2_048) &&
      (value.model === undefined || typeof value.model === "string" && value.model.length > 0 && value.model.length <= 512) &&
      (value.longContext === undefined || typeof value.longContext === "boolean") &&
      (value.effort === undefined || typeof value.effort === "string" && value.effort.length <= 128)
    ) {
      return { state: "valid", value: value as unknown as RuntimeSelection };
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
    promptTemplate: row.prompt_template,
    executionPermission: normalizeExecutionPermission(row.execution_permission),
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
          trigger_type, trigger_json, tool_mode, hub_mode, execution_permission, target_version, runtime_selection_json)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
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
        judged: input.judged ?? judgedComputerUse,
        toolMode: normalizeToolMode(input.toolMode),
        name: input.name,
        promptTemplate: input.promptTemplate,
        targetLabel: input.targetType,
      }),
      normalizeHubMode(input.hubMode),
      normalizeExecutionPermission(input.executionPermission),
      input.targetVersion?.trim() || null,
      input.runtimeSelection ? JSON.stringify(input.runtimeSelection) : null,
    );
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
  const promptTemplate = patch.promptTemplate ?? row.prompt_template;
  const toolMode = resolveAutomationToolMode({
        judged: judgedComputerUse,
    toolMode: normalizeToolMode(patch.toolMode ?? row.tool_mode),
    name,
    promptTemplate,
    targetLabel: targetType,
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
    id,
  );
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
      : existing.nextRunAt;
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
  emitDesktopStoreChange({ entity: "automation", id });
  emitDesktopStoreChange({ entity: "chat" });
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
}

const MAX_AUTOMATION_CHECKPOINT_BYTES = 1024 * 1024;

export interface FailedGraphCheckpoint {
  runId: string;
  automationId: string;
  occurrenceId: string | null;
  graphDigest: string | null;
  checkpoint: unknown;
  nodeStates: Record<string, WorkflowNodeRunState>;
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
          occurrence_id, graph_digest, checkpoint_json, resume_of_run_id)
       SELECT ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?
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
  return {
    runId: row.id,
    automationId: row.automation_id ?? automationId,
    startedAt: row.started_at ?? "",
    status: (row.status as WorkflowRunSnapshot["status"]) ?? "running",
    nodeStates,
  };
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
      `INSERT INTO run_history (id, automation_id, scheduled_for, ran_at, status, skipped_count, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(), id, row.next_run_at, atIso, terminalStatus,
      skipped > 0 ? skipped : 0, opts?.error ?? null,
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
