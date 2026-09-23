import type { Automation, RuntimeSelection } from "../shared/types";
import { getDb } from "./store/db";
import { decodeRuntimeSelection } from "./store/automations";
import { tryRecordRunEvent } from "./store/run-events";
import { detectRuntimes } from "./runtime/detect";
import { rolePriorityRuntimes, runtimeForOwnerSelection } from "./runtime/selection";
import { runtimeCooldownForSelection } from "./runtime/runtime-cooldown";
import { AUTOMATION_NO_PROGRESS_LOOP } from "./automation-progress-guard";
import {
  AUTOMATION_RUNTIME_PIN_PROVENANCE_EVENT,
  AUTOMATION_RUNTIME_PLANNED_EVENT,
  planAutomationRuntime,
  type AutomationPinProvenance,
  type AutomationRuntimePlan,
} from "./automation-runtime-plan";

/*
 * 핀 출처는 스키마를 늘리지 않고 run_events(삭제 없는 원장)에 남긴다.
 *  - 오너가 화면/휴대폰에서 핀을 바꾸면 "owner".
 *  - 에이전트가 자동화를 만들며 그 순간의 런타임을 복사하면 "agent_copy".
 * 기록이 없는 옛 행은 created_by 로 판단한다: 'agent' = 복사본, 'user' = 오너의 선택.
 */

function sameStoredPin(left: RuntimeSelection | null | undefined, right: RuntimeSelection | null | undefined): boolean {
  if (!left || !right) return !left && !right;
  return left.kind === right.kind && (left.backend ?? null) === (right.backend ?? null)
    && (left.source ?? null) === (right.source ?? null) && (left.acpAgentId ?? null) === (right.acpAgentId ?? null)
    && (left.model ?? null) === (right.model ?? null) && (left.effort ?? null) === (right.effort ?? null)
    && Boolean(left.longContext) === Boolean(right.longContext);
}

export function recordAutomationPinProvenance(
  automationId: string,
  provenance: AutomationPinProvenance,
  surface: string,
): void {
  tryRecordRunEvent({
    runId: `automation-pin-provenance-${automationId}-${Date.now()}`,
    kind: AUTOMATION_RUNTIME_PIN_PROVENANCE_EVENT,
    automationId,
    payload: { provenance, surface },
  });
}

/**
 * 오너 편집 경로(IPC·모바일)가 부른다. 패치가 핀을 **실제로 바꿀 때만** 오너의 선택으로 적는다 —
 * 편집 화면이 다른 칸을 저장하며 기존 핀을 그대로 되보내는 것은 선택이 아니다.
 */
export function noteOwnerAutomationPinEdit(
  automationId: string,
  before: RuntimeSelection | null | undefined,
  patch: { runtimeSelection?: RuntimeSelection | null } | null | undefined,
  surface: string,
): void {
  if (!patch || !Object.prototype.hasOwnProperty.call(patch, "runtimeSelection")) return;
  if (sameStoredPin(before ?? null, patch.runtimeSelection ?? null)) return;
  recordAutomationPinProvenance(automationId, "owner", surface);
}

export function latestAutomationPinProvenance(automationId: string): AutomationPinProvenance | null {
  try {
    const row = getDb().prepare(
      "SELECT payload_json FROM run_events WHERE automation_id = ? AND kind = ? ORDER BY ts DESC, rowid DESC LIMIT 1",
    ).get(automationId, AUTOMATION_RUNTIME_PIN_PROVENANCE_EVENT) as { payload_json: string } | undefined;
    if (!row) return null;
    const value = (JSON.parse(row.payload_json) as { provenance?: unknown }).provenance;
    return value === "owner" || value === "agent_copy" ? value : null;
  } catch {
    return null;
  }
}

/** 오너가 이 자동화를 묶어 둔 대화(목표 대화)의 모델 칩. 보관된 대화는 설정이 아니다. */
export function ownerChatSelectionFor(a: Pick<Automation, "monitor" | "goalId">): RuntimeSelection | null {
  try {
    const db = getDb();
    const byId = a.monitor?.originChatId
      ? db.prepare("SELECT runtime_selection_json FROM chats WHERE id = ? AND archived_at IS NULL").get(a.monitor.originChatId) as
        { runtime_selection_json: string | null } | undefined
      : undefined;
    const row = byId ?? (a.goalId
      ? db.prepare(
        "SELECT runtime_selection_json FROM chats WHERE goal_id = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 1",
      ).get(a.goalId) as { runtime_selection_json: string | null } | undefined
      : undefined);
    const decoded = decodeRuntimeSelection(row?.runtime_selection_json ?? null);
    return decoded.state === "valid" ? decoded.value ?? null : null;
  } catch {
    return null;
  }
}

/** 가장 최근 실행부터 연속으로 "제자리 돌기"로 끝난 실행 수, 그리고 그때 돌던 공급자. */
export function recentNoProgressRuns(automationId: string): { count: number; backend: string | null } {
  try {
    const db = getDb();
    const rows = db.prepare(
      "SELECT error FROM run_history WHERE automation_id = ? ORDER BY ran_at DESC LIMIT 5",
    ).all(automationId) as Array<{ error: string | null }>;
    let count = 0;
    for (const row of rows) {
      if (typeof row.error === "string" && row.error.startsWith(`[${AUTOMATION_NO_PROGRESS_LOOP}]`)) count += 1;
      else break;
    }
    if (count === 0) return { count, backend: null };
    const event = db.prepare(
      "SELECT payload_json FROM run_events WHERE automation_id = ? AND kind = ? ORDER BY ts DESC, rowid DESC LIMIT 1",
    ).get(automationId, AUTOMATION_NO_PROGRESS_LOOP) as { payload_json: string } | undefined;
    const backend = event ? (JSON.parse(event.payload_json) as { backend?: unknown }).backend : null;
    return { count, backend: typeof backend === "string" ? backend : null };
  } catch {
    return { count: 0, backend: null };
  }
}

/**
 * 이번 실행의 런타임을 정하고, 저장된 핀과 다르면 영수증을 남긴다. 저장된 핀은 바꾸지 않는다.
 */
export async function planAutomationRuntimeForRun(
  a: Automation,
  runId: string,
): Promise<AutomationRuntimePlan> {
  const provenanceMarker = latestAutomationPinProvenance(a.id);
  const detected = await detectRuntimes();
  const ownerChatSelection = ownerChatSelectionFor(a);
  const plan = planAutomationRuntime({
    createdBy: a.createdBy === "agent" ? "agent" : "user",
    stored: a.runtimeSelection,
    provenanceMarker,
    ownerChatSelection,
    ownerChatRuntime: runtimeForOwnerSelection(detected, ownerChatSelection),
    workerPool: rolePriorityRuntimes(detected, "worker"),
    cooling: (selection) => runtimeCooldownForSelection(selection),
    recentNoProgress: recentNoProgressRuns(a.id),
  });
  if (plan.changed || plan.handoff) {
    tryRecordRunEvent({
      runId,
      kind: AUTOMATION_RUNTIME_PLANNED_EVENT,
      automationId: a.id,
      // run_events 는 중첩 객체를 문자열로 접는다 — 영수증은 평평하게 싣는다.
      payload: {
        provenance: plan.provenance,
        route: plan.route,
        storedKind: a.runtimeSelection?.kind ?? null,
        storedBackend: a.runtimeSelection?.backend ?? null,
        storedModel: a.runtimeSelection?.model ?? null,
        selectedKind: plan.selection?.kind ?? null,
        selectedBackend: plan.selection?.backend ?? null,
        selectedModel: plan.selection?.model ?? null,
        selectedEffort: plan.selection?.effort ?? null,
        handoffReason: plan.handoff?.reason ?? null,
        handoffFromKind: plan.handoff?.from.kind ?? null,
        handoffFromBackend: plan.handoff?.from.backend ?? null,
        handoffFromModel: plan.handoff?.from.model ?? null,
        cooldownKind: plan.handoff?.cooldownKind ?? null,
      },
    });
  }
  return plan;
}
