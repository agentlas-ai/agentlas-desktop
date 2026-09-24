import type { RuntimeBackend, RuntimeSelection } from "../shared/types";
import { runtimeMatchesSelection, selectionForRuntime } from "../shared/runtime-selection";

/**
 * 한 번의 자동화 실행이 **어느 런타임으로 도는가** — 저장된 핀의 출처를 보고 정한다.
 *
 * 실측(Threads 자동화 f7a61706, 2026-09-23): 에이전트(One)가 2026-09-16 자동화를 만들며 그 순간의
 * 런타임(agy gemini-3.8-flash-high)을 핀으로 복사했다(created_by='agent'). 그 뒤 오너는 목표 대화를
 * codex gpt-5.6-luna 로, 역할 기본값을 오케스트레이터 gpt-6-luna XHigh → Opus, 워커 gpt-6-luna Medium →
 * gemini 로 바꿨지만, 무인 실행은 일주일 전 복사본으로 계속 돌았다 — 오너가 고른 적 없는 모델이다.
 *
 * 규칙:
 *  - 오너가 고른 핀(사용자가 만든 자동화, 또는 오너가 핀을 바꾼 기록이 있는 자동화)은 그대로 쓴다.
 *  - 에이전트가 만들며 복사한 핀은 오너의 **지금** 설정을 따른다: 묶인 목표 대화의 런타임 → 워커 풀 맨 앞.
 *    둘 다 없으면 복사본으로 돈다(실행을 막지 않는다).
 *  - 어느 쪽이든 그 런타임이 지금 한도/인증 쿨다운이거나 최근 실행이 연속으로 "제자리 돌기"로 멈췄으면
 *    워커 풀의 다른 공급자로 이번 실행만 넘긴다(99b7ba52 그래프 단계 쿨다운 핸드오프와 같은 규칙).
 *  - 저장된 핀은 절대 고치지 않는다 — 이번 실행의 선택과 영수증만 바뀐다.
 *
 * 순수 함수 — DB·감지·시계는 호출자가 넣는다(계약이 그대로 돌린다).
 */

export type AutomationPinProvenance = "owner" | "agent_copy";

export const AUTOMATION_RUNTIME_PIN_PROVENANCE_EVENT = "automation_runtime_pin_provenance" as const;
export const AUTOMATION_RUNTIME_PLANNED_EVENT = "automation_runtime_planned" as const;
/** 최근 연속 "제자리 돌기" 실행이 이 수에 닿으면 이번 실행은 다른 공급자로 넘긴다. */
export const NO_PROGRESS_HANDOFF_AFTER = 2;

export interface PlannableRuntime {
  kind: RuntimeSelection["kind"];
  backend: RuntimeBackend;
  source: string;
  acpAgentId?: string | null;
  label?: string | null;
  model?: string | null;
  effort?: string | null;
  longContextEnabled?: boolean | null;
}

export interface AutomationRuntimePlanInput {
  createdBy: "user" | "agent";
  stored: RuntimeSelection | undefined;
  /** 가장 최근의 출처 기록(없으면 null → created_by 로 판단). */
  provenanceMarker: AutomationPinProvenance | null;
  /** 오너가 지금 묶어 둔 목표 대화의 런타임(모델 칩). 없으면 null. */
  ownerChatRuntime: PlannableRuntime | null;
  ownerChatSelection: RuntimeSelection | null;
  /** 워커 역할 풀 — 오너가 저장한 순서 그대로, 쿨다운·자격 불가는 이미 빠진 목록. */
  workerPool: PlannableRuntime[];
  /** 이 선택이 지금 한도/인증 쿨다운인가. */
  cooling: (selection: RuntimeSelection) => { kind: string; until: number } | null;
  /** 가장 최근 실행부터 연속으로 automation_no_progress_loop 로 끝난 실행 수와 그때의 공급자. */
  recentNoProgress: { count: number; backend: string | null };
  /**
   * 지속 정책이 직전 실행에 대해 switch_runtime 을 골랐는가(자기 보류 두 번째·도구 없는 주장 등).
   * 원장 영수증(persistence_decision)이 근거다. 없으면 생략.
   */
  persistenceSwitch?: { cause: string } | null;
}

export type AutomationRuntimeRoute =
  | "owner_pin"
  | "owner_chat"
  | "worker_pool"
  | "stored_copy_fallback";

export interface AutomationRuntimePlan {
  selection: RuntimeSelection | undefined;
  provenance: AutomationPinProvenance;
  route: AutomationRuntimeRoute;
  handoff: null | {
    reason: "cooldown" | "no_progress_loop" | "persistence_switch_runtime";
    from: { kind: string; backend: string | null; model: string | null };
    cooldownKind?: string;
  };
  /** 이번 실행의 선택이 저장된 핀과 다른가(영수증을 남길지). */
  changed: boolean;
}

export function automationPinProvenance(
  createdBy: "user" | "agent",
  marker: AutomationPinProvenance | null,
): AutomationPinProvenance {
  if (marker) return marker;
  return createdBy === "agent" ? "agent_copy" : "owner";
}

function workerSelection(runtime: PlannableRuntime, choice: Partial<RuntimeSelection> = {}): RuntimeSelection {
  return selectionForRuntime(runtime, {
    ...(choice.model !== undefined ? { model: choice.model } : {}),
    ...(choice.effort !== undefined ? { effort: choice.effort } : {}),
    ...(typeof choice.longContext === "boolean"
      ? { longContext: choice.longContext }
      : typeof runtime.longContextEnabled === "boolean" ? { longContext: runtime.longContextEnabled } : {}),
    role: "worker",
  });
}

function sameSelection(left: RuntimeSelection | undefined, right: RuntimeSelection | undefined): boolean {
  if (!left || !right) return !left && !right;
  return left.kind === right.kind && (left.backend ?? null) === (right.backend ?? null)
    && (left.source ?? null) === (right.source ?? null) && (left.acpAgentId ?? null) === (right.acpAgentId ?? null)
    && (left.model ?? null) === (right.model ?? null) && (left.effort ?? null) === (right.effort ?? null);
}

function hardCooldown(input: AutomationRuntimePlanInput, selection: RuntimeSelection | undefined) {
  if (!selection) return null;
  const cooling = input.cooling(selection);
  return cooling && (cooling.kind === "quota" || cooling.kind === "auth") ? cooling : null;
}

export function planAutomationRuntime(input: AutomationRuntimePlanInput): AutomationRuntimePlan {
  const provenance = automationPinProvenance(input.createdBy, input.provenanceMarker);
  let selection: RuntimeSelection | undefined = input.stored;
  let route: AutomationRuntimeRoute = "owner_pin";
  if (provenance === "agent_copy") {
    if (input.ownerChatRuntime && input.ownerChatSelection
      && runtimeMatchesSelection(input.ownerChatRuntime, input.ownerChatSelection)) {
      selection = workerSelection(input.ownerChatRuntime, {
        model: input.ownerChatSelection.model ?? input.ownerChatRuntime.model ?? undefined,
        effort: input.ownerChatSelection.effort ?? input.ownerChatRuntime.effort ?? undefined,
        longContext: input.ownerChatSelection.longContext,
      });
      route = "owner_chat";
    } else if (input.workerPool[0]) {
      selection = workerSelection(input.workerPool[0]);
      route = "worker_pool";
    } else {
      route = "stored_copy_fallback";
    }
  }

  let handoff: AutomationRuntimePlan["handoff"] = null;
  if (selection) {
    const cooling = hardCooldown(input, selection);
    const looping = input.recentNoProgress.count >= NO_PROGRESS_HANDOFF_AFTER
      && (input.recentNoProgress.backend === null || input.recentNoProgress.backend === (selection.backend ?? null));
    const persistenceSwitch = Boolean(input.persistenceSwitch);
    if (cooling || looping || persistenceSwitch) {
      const alternate = input.workerPool.find((candidate) =>
        candidate.backend !== selection!.backend && !hardCooldown(input, workerSelection(candidate)));
      if (alternate) {
        handoff = {
          reason: cooling ? "cooldown" : looping ? "no_progress_loop" : "persistence_switch_runtime",
          from: { kind: selection.kind, backend: selection.backend ?? null, model: selection.model ?? null },
          ...(cooling ? { cooldownKind: cooling.kind } : {}),
        };
        selection = workerSelection(alternate);
      }
    }
  }
  return { selection, provenance, route, handoff, changed: !sameSelection(selection, input.stored) };
}

/**
 * 복구 런(System Optimizer)을 어느 런타임으로 띄우는가 (P0-4, A3).
 *
 * 실측(설치본 2026-09-24, f7a61706): 복구 런 10회 중 4회가 고치려던 실행과 **같은 오류**(503 용량·전송 점유·한도)로
 * 죽었다. 복구 런이 실패한 자동화의 핀(a.runtimeSelection) 그대로 떴기 때문이다 — 같은 런타임이라 같이 죽는다.
 *
 * 규칙: 오너가 저장한 워커 풀 순서에서, 실패한 실행의 공급자(backend)가 아니고 한도/인증 쿨다운도 아닌 첫 구성원.
 * 그런 구성원이 없으면 실패한 런타임 그대로(실행을 막지 않는다). 순수 함수 — 감지·쿨다운은 호출자가 넣는다.
 */
export interface RecoveryRuntimePlan {
  selection: RuntimeSelection | undefined;
  switched: boolean;
  reason: "other_pool_member" | "no_alternative" | "no_failing_runtime";
}

export function planRecoveryRuntime(input: {
  failing: RuntimeSelection | undefined;
  workerPool: PlannableRuntime[];
  cooling: (selection: RuntimeSelection) => { kind: string; until: number } | null;
}): RecoveryRuntimePlan {
  const cooled = (selection: RuntimeSelection): boolean => {
    const entry = input.cooling(selection);
    return Boolean(entry && (entry.kind === "quota" || entry.kind === "auth"));
  };
  const alternate = input.workerPool.find((candidate) =>
    (candidate.backend ?? null) !== (input.failing?.backend ?? null) && !cooled(workerSelection(candidate)));
  if (alternate) return { selection: workerSelection(alternate), switched: true, reason: "other_pool_member" };
  return { selection: input.failing, switched: false, reason: input.failing ? "no_alternative" : "no_failing_runtime" };
}
