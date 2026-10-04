import { withRunnerSettlementObserver } from "./runtime/observed-runner";
import { withAutomationRunAccounting } from "./long-run/accounting-context";
import { stopAutomationRun as stopExecutionAutomationRun, assertAutomationGoalExecutionOwner, automationGoalExecutionHeld, bindAutomationRunStop, captureAutomationGoalExecutionOwner, releaseAutomationRunStop } from "./automation-execution-control";
import { goalContinuationSourceChat, settleGoalContinuationRun, settleRefusedGoalContinuation, type GoalContinuationSignals } from "./goal-continuation-hold";
import { selectionForRuntime } from "../shared/runtime-selection";
import { pollGoalWaitSubscriptions } from "./long-run/wait-subscriptions";
import { deliverAutomationResult } from "./automation-delivery";
import { claimAutomationNotification } from "./automation-notifications";
import { getDb } from "./store/db";
import { emitDesktopStoreChange } from "./store/change-bus";
import { getLongRunByGoalId, longRunOwnerHold } from "./store/long-runs";
import { decodeGraphCommandDelivery } from "../shared/graph-command";
import { automationDefinitionDigest } from "./automation-lifecycle";
import { validateOneGraphCommandScope } from "./one/graph-dispatch";
import { nativeGraphSuccessNeedsReflection } from "../shared/automation-graph-definition";
// 자동화 스케줄러 — 앱이 켜져 있는 동안 60초마다 due 자동화를 점검해 실행한다.
// 실행 = 타깃(firm/agent)의 백그라운드(division) chat을 만들어 runMcpInvocation로 promptTemplate을 돌린다.
// This is intentionally app-scoped: fully quitting Desktop stops local work.
import { app, Notification } from "electron";
import { randomUUID } from "node:crypto";
import type { Automation, AutomationRunRecord, McpInvocationEvent, RuntimeSelection } from "../shared/types";
import { quotaRetryAfterAt } from "../shared/runtime-quota";
import {
  dueAutomations,
  hasGraphLoginWait, getGraphLoginWaitCheckpoint, restoreGraphLoginPrerequisite, graphLoginWaitReady, cancelGraphLoginWait,
  type GraphLoginWaitEntry, graphLoginPrerequisiteKey,
  getAutomation,
  markAutomationRun,
  toggleAutomation,
  claimAutomationRun,
  renewAutomationRunLease,
  releaseAutomationRun,
  startGraphRun,
  touchGraphRun,
  updateGraphRunNode,
  countConsecutiveFailures,
  countGraphRunAttemptsForRun,
  computeNextRun,
  getLatestGraphRunOccurrenceId,
  isAutomationRunParentMissingError,
  pinAutomationRuntimeIfUnset,
  getAutomationExecutionContractState,
  pinLegacyAutomationHubVersions,
  consumeRunInput,
  updateAutomation,
} from "./store/automations";
import { checkComputerUsePermissions } from "./mac-permissions";
import { appendChatMessage } from "./store/chats";
import { getChatGoalContract, getChatGoalRevision } from "./store/chat-goals";
import {
  goalLedgerShouldContinue,
} from "./mcp/goal-ledger";
import { getOrCreateAutomationSession } from "./store/automation-sessions";
import { buildSystemOptimizerPrompt } from "./system-agents/system-optimizer";
import { runMcpInvocation } from "./mcp/client";
import { automationRuntimePermission } from "../shared/graph-node-protocol";
import { runGraph, type RunGraphResult } from "./workflow/run-graph";
import { callableContractFor } from "./toolchains/interface";
import { graphExecutionDigest } from "../shared/graph-execution-digest";
import { AutomationWorkspaceError, automationWorkspaceOwnerText, captureAutomationWorkspace } from "./automation-workspace";
import { sweepAutomationEffectObservations } from "./long-run/effect-observation";
import { automationObservationsInFlight, registerAutomationObservationRuntime, type AutomationObservationRuntime } from "./long-run/effect-observation-tickets";
import { requiresGraphReconciliation, runAutomationStrategyCycle } from "./automation-strategy-cycle";
import { broadcastLiveRun } from "./workflow/live-run";
import {
  isStormbreakerLongRunPrompt,
} from "./hephaestus/loop-engineering";
import { currentUiLocale } from "./ui-locale";
const L = (ko: string, en: string): string => (currentUiLocale() === "ko" ? ko : en);

/** 어느 판정기가 이 실행을 판정했는지 실행 영수증에 남긴다(값 없는 호스트 사실). */
function recordAutomationJudgeReceipt(
  runId: string | null,
  automationId: string,
  phase: "outcome" | "failure",
  classified: { judge?: AutomationJudgeReceipt },
): void {
  if (!runId || !classified.judge) return;
  tryRecordRunEvent({ runId, kind: "automation_judge_receipt", automationId, payload: { phase, ...classified.judge } });
}

// Classification owns a separate bounded lane; its answer never grants replay,
// changes schedules, or holds an execution lease after the kernel has settled.
const backgroundClassifications = new Map<string, { automationId: string; controller: AbortController }>();
function classifyInBackground(input: {
  automation: Automation; runId: string | null; phase: "outcome" | "failure" | "reflection";
  sourceSignal: AbortSignal; assertCurrent: () => void;
  classify: (signal: AbortSignal, isCurrent: () => boolean) => Promise<AutomationResultClassification | void>;
}): void {
  let ownedKey: string | undefined;
  let ownedEntry: { automationId: string; controller: AbortController } | undefined;
  try {
  if (!input.runId || input.sourceSignal.aborted || shutdownDispatchClosed) return;
  const { automation, runId, phase } = input;
  const key = `${automation.id}:${phase}`;
  if (backgroundClassifications.has(key)) return;
  const db = getDb();
  const source = db.prepare(`SELECT occurrence_id, graph_digest, checkpoint_json, status
    FROM automation_runs WHERE id = ? AND automation_id = ?`).get(runId, automation.id) as {
      occurrence_id: string | null; graph_digest: string | null; checkpoint_json: string | null; status: string;
    } | undefined;
  if (!source || source.status === "running" || !db.prepare(
    "SELECT 1 FROM run_history WHERE id = ? AND automation_id = ?",
  ).get(runId, automation.id)) {
    tryRecordRunEvent({ runId, automationId: automation.id, kind: "automation_background_judgment_unanchored",
      payload: { phase, reasonCode: "execution_not_sealed", pending: true, factOnly: true } });
    return;
  }
  input.assertCurrent();
  const canonical = getAutomation(automation.id);
  if (!canonical) return;
  const revision = automation.goalId ? getChatGoalRevision(automation.goalId)?.revision ?? null : null;
  const definition = automationDefinitionDigest(canonical);
  const controller = new AbortController();
  const isCurrent = (): boolean => {
    if (controller.signal.aborted || input.sourceSignal.aborted || shutdownDispatchClosed) return false;
    try {
      input.assertCurrent();
      const current = getAutomation(automation.id);
      if (!current || current.createdAt !== canonical.createdAt || current.enabled !== canonical.enabled
        || automationDefinitionDigest(current) !== definition) return false;
      if (automation.goalId) {
        const goal = getLongRunByGoalId(automation.goalId);
        if ((getChatGoalRevision(automation.goalId)?.revision ?? null) !== revision || !goal
          || longRunOwnerHold(goal.id) || ["completed", "cancelled", "cancelling"].includes(goal.status)) return false;
      }
      return Boolean(db.prepare(`SELECT 1 FROM automation_runs
        WHERE id = ? AND automation_id = ? AND occurrence_id IS ? AND graph_digest IS ?
          AND checkpoint_json IS ? AND status = ?
          AND rowid = (SELECT MAX(rowid) FROM automation_runs WHERE automation_id = ?)`)
        .get(runId, automation.id, source.occurrence_id, source.graph_digest, source.checkpoint_json, source.status, automation.id));
    } catch { return false; }
  };
  const entry = { automationId: automation.id, controller };
  backgroundClassifications.set(key, entry);
  ownedKey = key; ownedEntry = entry;
  tryRecordRunEvent({ runId, automationId: automation.id, kind: phase === "reflection" ? "automation_background_reflection_started" : "automation_background_judgment_started",
    sourceEventId: `automation-background-judgment:${runId}:${phase}:started`,
    payload: { phase, occurrenceId: source.occurrence_id, pending: true } });
  void runMainBackgroundTask(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_, reject) => {
        abortListener = () => reject(controller.signal.reason ?? new Error("automation_judgment_cancelled"));
        controller.signal.addEventListener("abort", abortListener, { once: true });
      });
      timer = setTimeout(() => controller.abort(new Error("automation_judgment_timeout")), AUTOMATION_OUTCOME_JUDGE_TIMEOUT_MS);
      timer.unref?.();
      const classified = await Promise.race([aborted, Promise.resolve().then(() =>
        isCurrent() ? withAutomationRunAccounting({ runId, automationId: automation.id }, () => input.classify(controller.signal, isCurrent)) : undefined)]);
      // All freshness reads and the fact receipt share one transaction. A late
      // answer cannot revive an edited occurrence or a stopped owner Goal.
      let historyChanged = false;
      db.transaction(() => {
        if (!isCurrent()) return;
        if (classified && phase !== "reflection" && !isJudgmentUnavailable(classified)
          && classified.reasonCode !== "automation_failure_unclassified") {
          const verdict = classified.outcome;
          const outcome: AutomationRunRecord["outcome"] = verdict === "ok" || verdict === "skipped" ? "accepted"
            : verdict === "needs_input" ? "needs_input" : verdict === "blocked" ? "blocked" : "rejected";
          historyChanged = db.prepare(`UPDATE run_history SET outcome = ?, outcome_reason = ?
            WHERE id = ? AND automation_id = ? AND outcome = 'unjudged'`)
            .run(outcome, classified.reason == null ? null : redactOperationalSecrets(classified.reason), runId, automation.id).changes === 1;
        }
        if (classified && phase !== "reflection") recordAutomationJudgeReceipt(runId, automation.id, phase, classified);
        recordRunEvent({ runId, automationId: automation.id, kind: phase === "reflection" ? "automation_background_reflection_completed" : "automation_background_judgment_completed",
          sourceEventId: `automation-background-judgment:${runId}:${phase}:completed`, payload: {
            phase, occurrenceId: source.occurrence_id, factOnly: true,
            ...(classified ? { status: classified.status, outcome: classified.outcome,
              reasonCode: classified.reasonCode, reason: classified.reason == null ? null : redactOperationalSecrets(classified.reason),
              judgmentUnavailable: isJudgmentUnavailable(classified) } : {}),
          } });
      }).immediate();
      if (historyChanged) emitDesktopStoreChange({ entity: "automation", id: automation.id });
    } catch (error) {
      tryRecordRunEvent({ runId, automationId: automation.id, kind: phase === "reflection" ? "automation_background_reflection_unavailable" : "automation_background_judgment_unavailable",
        payload: { phase, reasonCode: controller.signal.aborted ? "judgment_cancelled_or_timeout" : "judgment_failed_or_stale", pending: true } });
    } finally {
      if (timer) clearTimeout(timer);
      if (abortListener) controller.signal.removeEventListener("abort", abortListener);
      if (backgroundClassifications.get(key) === entry) backgroundClassifications.delete(key);
    }
  });
  } catch {
    if (ownedKey && ownedEntry && backgroundClassifications.get(ownedKey) === ownedEntry) {
      backgroundClassifications.delete(ownedKey);
      ownedEntry.controller.abort(new Error("automation_judgment_admission_unavailable"));
    }
    // Advisory capture/storage failure must never change work admission or settlement.
  }
}

/** Retain the exact attempt's machine reset hint before a semantic judge can
 * rewrite its error. This receipt is display evidence, never a retry grant. */
function recordAutomationQuotaReset(runId: string, automationId: string, event: McpInvocationEvent): void {
  const failure = event.kind === "error" ? event.error?.runtimeFailure : undefined;
  const retryAfterAt = failure?.kind === "quota" && failure.source === "marker" ? quotaRetryAfterAt(failure.retryAfterAt) : null;
  if (!retryAfterAt) return;
  tryRecordRunEvent({ runId, automationId, nodeId: event.nodeId, kind: "automation_runtime_quota_observed",
    sourceEventId: `automation-quota:${runId}:${event.nodeId ?? "run"}:${retryAfterAt}`,
    payload: { schemaVersion: "agentlas.automation-runtime-quota.v1", kind: "quota", source: "marker", retryAfterAt } });
}
import { emitAutomationDone } from "./triggers/chain-bus";
import {
  AUTOMATION_OUTCOME_JUDGE_TIMEOUT_MS,
  classifyAutomationFailure,
  classifyAutomationOutcome,
  graphIsHostComputedOnly,
  isJudgmentUnavailable,
  type AutomationJudgeReceipt,
  type AutomationResultClassification,
  type AutomationResultStatus,
} from "./automation-result";
import { hasInvocationRunReceipt, observedToolActivity } from "./store/run-events";
import {
  recordMcpInvocationEvent,
  recordRunEvent,
  tryRecordFailureEvent,
  tryRecordRunEvent,
} from "./store/run-events";
import { notifyTelegramAutomationDone } from "./telegram/connect";
import {
  MAX_AUTOMATION_ACTIVE_TOOL_STALL_MS,
  automationWatchdogError,
  automationWatchdogOwnerText,
  awaitAutomationRunnerWithAbortGrace,
  createAutomationWatchdogState,
  evaluateAutomationWatchdog,
  noteAutomationWatchdogEvent,
  type AutomationWatchdogDecision,
} from "./automation-watchdog";
import { recoverStaleAutomationRuns } from "./store/db";
import { detectRuntimes } from "./runtime/detect";
import { rolePriorityRuntimes } from "./runtime/selection";
import { planAutomationRuntimeForRun } from "./automation-runtime-provenance";
import { planRecoveryRuntime, type RecoveryRuntimePlan } from "./automation-runtime-plan";
import {
  AUTOMATION_NO_PROGRESS_LOOP,
  createNoProgressGuard,
  noProgressLoopError,
  noProgressLoopOwnerText,
  noteNoProgressEvent,
  type NoProgressDecision,
} from "./automation-progress-guard";
import { withRunPriority } from "./runtime/run-priority";
import { runMainBackgroundTask, captureMainRootContinuation, admitMainAutomation, withMainScheduledRoot, takeMainInvocationAdmission, MainInvocationLifetime, type MainInvocationAdmission } from "./runtime/scheduled-root-context";
import { synthesizeLegacyGraph } from "./automation-emitter";
import { recoverGraphScheduleCursors, recoveredGraphScheduleOccurrence, recoverReadOnlySuspendedGraphs, suspendAutomationForGraphReconciliation } from "./store/graph-reconciliation";
import { getSource as getMarketSource } from "./marketplace";
import {
  buildStrategyDirective,
  collectAutomationFailureContext,
  type AutomationFailureContext,
} from "./automation-strategy";
import { recordAutomationRecovery } from "./automation-recovery";
import {
  automationRunOutwardEffects,
  automationRunSettlementCause,
  decideAndRecordAutomationPersistence,
} from "./persistence-ledger";
import { invocationJudgmentContext, withInvocationJudgmentContext } from "./runtime/judgment-context";
import { runtimeCooldownForSelection } from "./runtime/runtime-cooldown";
import { automationServesOngoingGoal, declaredGoalForAutomation } from "./automation-declared-goal";
import { goalExecutionDirectivePromptBlock } from "./long-run/goal-execution-context";
import { redactOperationalSecrets } from "./invocation/event-secret-redaction";
import type {
  TriggerDeliveryHooks,
  TriggerDispatchResult,
  TriggerEventPayload,
} from "./store/trigger-events";

/** 무활동 감시견이 멈춘 실행의 타입 원인 — 사용자 중지(automation_stopped_by_user)와 다르다. */
export const AUTOMATION_WATCHDOG_STALL = "automation_watchdog_stall";

const MAX_SCHEDULE_OCCURRENCE_ATTEMPTS = 3;
const SCHEDULE_RETRY_BASE_MS = 15 * 60_000;

/** Preflight can fail before a graph row exists. Never fabricate a run to pay a judge. */
export async function classifyAccountedAutomationFailure(
  automation: Automation, runId: string | null, error: string | null | undefined, signal?: AbortSignal,
): Promise<AutomationResultClassification> {
  if (shutdownDispatchClosed) return appCloseClassification();
  if (signal?.aborted) throw signal.reason;
  try {
    const anchored = runId && getDb().prepare(
      "SELECT 1 FROM automation_runs WHERE id = ? AND automation_id = ?",
    ).get(runId, automation.id);
    if (anchored && runId) {
      const result = await withAutomationRunAccounting({ runId, automationId: automation.id }, () =>
        classifyAutomationFailure(error, { runtimeSelection: automation.runtimeSelection, signal }));
      return shutdownDispatchClosed ? appCloseClassification() : result;
    }
  } catch (judgmentError) {
    console.warn("[automation] accounted failure classification unavailable:", judgmentError);
  }
  if (shutdownDispatchClosed) return appCloseClassification();
  return { status: "error", outcome: "error", reasonCode: "automation_failure_unclassified",
    reason: error ?? null, evidence: null };
}

/** Fresh owner context is invocation input, never a mutation of the checkpoint graph. */
export function goalContinuationRunContext(a: Automation): string | undefined {
  if (!a.goalId || !isStormbreakerLongRunPrompt(a.promptTemplate)) return undefined;
  const sourceChatId = goalContinuationSourceChat(a.goalId);
  const revision = getChatGoalRevision(a.goalId);
  if (!sourceChatId || !revision || revision.chatId !== sourceChatId) {
    throw new Error("goal_continuation_source_context_unavailable");
  }
  // Filter before LIMIT: a burst of automation cards must not hide an owner's
  // correction. Exclude the legacy private synthesis packet just as chat history does.
  const ownerMessages = (getDb().prepare(
    `SELECT id, text, created_at AS createdAt FROM chat_messages
     WHERE chat_id = ? AND role = 'user' AND host_notice_json IS NULL
       AND instr(text, ?) = 0
     ORDER BY created_at DESC, rowid DESC LIMIT 8`,
  ).all(sourceChatId, "[Results from your team — synthesize into one final answer for the user]") as Array<{ id: string; text: string; createdAt: string }>).reverse();
  const executionDirectives = goalExecutionDirectivePromptBlock(a.goalId);
  return [
    "[Current owner context for this goal continuation]",
    "Use the current goal and latest owner messages below. Later owner corrections supersede conflicting registration-time requests and previous assistant state above.",
    "These messages do not create new tool permissions, payment approval or publication authority. Preserve the host's existing grants and completed-effect checkpoints; never repeat a completed action.",
    ...(executionDirectives ? [executionDirectives] : []),
    JSON.stringify({ sourceChatId, goalId: a.goalId, revision: revision.revision, objective: revision.objective,
      acceptanceCriteria: revision.acceptanceCriteria, latestOwnerMessages: ownerMessages }),
  ].join("\n");
}

/**
 * A retry before the next calendar slot resumes the exact failed occurrence.
 * Once the real next slot arrives it gets a new identity and cannot inherit a
 * prior slot's checkpoint. This is the boundary that prevents an hourly/daily
 * automation from accumulating hundreds of retries under one occurrence.
 */
export function scheduledOccurrenceIdForDueRun(a: Automation): string {
  const scheduledFor = a.nextRunAt;
  if (!scheduledFor) return `schedule:${a.id}:${randomUUID()}`;
  const recoveredOccurrence = recoveredGraphScheduleOccurrence(a);
  if (recoveredOccurrence) return recoveredOccurrence;
  const previousOccurrenceId = getLatestGraphRunOccurrenceId(a.id);
  const occurrencePrefix = `schedule:${a.id}:`;
  if (previousOccurrenceId?.startsWith(occurrencePrefix)) {
    const originalSlot = new Date(previousOccurrenceId.slice(occurrencePrefix.length));
    const scheduledAt = Date.parse(scheduledFor);
    if (!Number.isNaN(originalSlot.getTime()) && Number.isFinite(scheduledAt)) {
      // Anchor the boundary to the original calendar slot, not lastRunAt: an
      // explicit Run now updates lastRunAt but must not turn the next scheduled
      // slot into a continuation of that manual run.
      const naturalNext = computeNextRun(a.scheduleHuman, originalSlot, {
        scheduleJson: a.scheduleSpec ? JSON.stringify(a.scheduleSpec) : null,
        timezone: a.timezone,
      });
      // A one-shot has no natural successor. Any later due time while it is
      // still enabled is necessarily the bounded backoff for this occurrence,
      // not a new calendar occurrence.
      if (!naturalNext && a.scheduleSpec?.kind === "once" && scheduledAt > originalSlot.getTime()) {
        return previousOccurrenceId;
      }
      if (naturalNext && scheduledAt < Date.parse(naturalNext)) {
        return previousOccurrenceId;
      }
    }
  }
  return `schedule:${a.id}:${scheduledFor}`;
}

let timer: ReturnType<typeof setInterval> | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let installQuiescing = false;
let installQuiesceHolds = 0;
let restartSchedulerAfterInstall = false;
/*
 * App quit closes dispatch for good. stopAutomationScheduler() only cleared the timers, so a tick
 * already past its guard, a runOne parked on the goal-ledger await, or a read-only resume could
 * still start work after Quit — and every write it made after closeStore() died as "Store not
 * initialized" (measured 2026-09-24T00:55Z: markAutomationRun, the graph-reconciliation suspension
 * and the dispatch all failed, so the interrupted Threads run's outcome was never recorded).
 */
let shutdownDispatchClosed = false;
const running = new Set<string>();
// Only the exact Main-created legacy retry object can override its unsaved
// runtime. Copies and callers' flags cannot substitute another stored definition.
const legacyRuntimeRetries = new WeakMap<Automation, { storedDefinition: string; executionDefinition: string }>();
const unverifiedAutomationNotices = new Map<string, string>();
// Only Main's close boundary marks these controllers; provider error prose is
// never authority to classify an app shutdown or replay an uncertain action.
const activeExecutionControllers = new Set<AbortController>();
const appClosedControllers = new WeakSet<AbortController>();

function appCloseClassification(): AutomationResultClassification {
  return { status: "partial", outcome: "partial", reasonCode: "automation_app_closed",
    reason: "The app closed before this run settled. Review its recorded effects before restarting.", evidence: null };
}

function withAutomationJudgmentSignal<T>(signal: AbortSignal, action: () => T): T {
  const inherited = invocationJudgmentContext();
  return withInvocationJudgmentContext(inherited?.selection,
    inherited?.signal && inherited.signal !== signal ? AbortSignal.any([signal, inherited.signal]) : signal, action);
}

function throwIfAutomationAborted(controller: AbortController): void {
  if (controller.signal.aborted) throw controller.signal.reason instanceof Error
    ? controller.signal.reason : new Error("automation_stopped_by_user");
}

function dispatchPaused(): boolean {
  return installQuiescing || shutdownDispatchClosed;
}

/*
 * 묻기 전에 직접 본다(오너 2026-09-23) — 보류된 자동화·자동화가 이어받는 목표의 효과를 읽기 전용으로
 * 한 번 본다. 요청은 effect-observation 이 Main 에서 permissions "read" 로만 만들고, 여기서는
 * 자동화 세션·브라우저 프로필로 그대로 돌린다(쓰기 권한을 넘기는 길이 없다).
 */
const automationObservationRuntime: AutomationObservationRuntime = {
  isAutomationRunning: (id) => running.has(id),
  runHeadless: (id, request, signal) => {
    if (dispatchPaused()) return Promise.reject(new Error("automation_dispatch_paused"));
    if (request.permissions !== "read") return Promise.reject(new Error("effect_observation_must_be_read_only"));
    const automation = getAutomation(id);
    if (!automation) return Promise.reject(new Error("automation_workspace_owner_changed"));
    const workspace = captureAutomationWorkspace(automation);
    const lifetime = new MainInvocationLifetime(admitMainAutomation(id), id, request.runId ?? id, "automation");
    return lifetime.run(() => withAutomationRunAccounting({
      runId: request.runId ?? "", automationId: id, chatId: request.chatId,
    }, () => withRunPriority("background", () => runMcpInvocation(
      request,
      (ev) => recordMcpInvocationEvent(request.runId!, request, ev),
      signal,
      workspace.binding,
      { source: "automation" },
    ))));
  },
  enqueueRun: (id) => enqueueAutomationRunNow(id, admitMainAutomation(id)).accepted,
};
registerAutomationObservationRuntime(automationObservationRuntime);

// 이 프로세스의 리스 소유자 식별자. 현재 제품 경로는 GUI만 실행하지만, 오래된
// headless 표식이 원장에 남아 있어도 소유자를 정확히 구분할 수 있게 형식은 유지한다.
const LEASE_OWNER = `${process.pid}:${process.argv.includes("--headless-automations") ? "headless" : "gui"}`;

function boundedIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (Number.isSafeInteger(parsed) && parsed >= min && parsed <= max) return parsed;
  console.warn(
    `[automation] ignoring invalid ${name}=${JSON.stringify(raw.slice(0, 64))}; using ${fallback}`,
  );
  return fallback;
}

// 한 번의 점검에서 동시에 돌릴 자동화 수 상한. due가 한꺼번에 많이 쌓여도(앱이 오래 꺼져
// 있다 켜진 경우 등) 모든 에이전트 런을 동시에 띄우지 않게 막는다 — 저사양 기기에서
// CPU/RAM 폭주 방지. 각 런은 내부에서 다시 CLI/엔진 프로세스를 띄우므로 N을 작게 둔다.
const MAX_CONCURRENT_AUTOMATIONS = boundedIntegerEnv(
  "AGENTLAS_AUTOMATION_CONCURRENCY",
  2,
  1,
  16,
);

/** 작업 배열을 최대 `limit`개씩만 동시 실행하는 경량 풀(외부 의존성 없음). */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = items.slice();
  // 호출부가 나중에 늘어도 NaN/Infinity가 Array.from length=0으로 조용히 전량 스킵되지 않게
  // 풀 자체에서도 한 번 더 방어한다. 빈 queue만 lane 0이 정상이다.
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  const size = Math.min(safeLimit, queue.length);
  const lanes = Array.from({ length: size }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) break;
      await worker(next);
    }
  });
  await Promise.all(lanes);
}

/** 완료 시 OS 알림(설계 §2.7 한계 #10 — 결과 미표출 해소). Notification 미지원이면 조용히 무시. */
function notifyDone(a: Automation, status: AutomationResultStatus, error?: string): void {
  if (status === "skipped") return;
  try {
    if (!app.isReady()) return;
    if (!Notification.isSupported()) return;
    const ok = status === "ok";
    const partial = status === "partial";
    const waiting = status === "blocked" || status === "needs_input";
    new Notification({
      title: ok
        ? `Automation ran: ${a.name}`
        : partial
          ? `Automation partially completed: ${a.name}`
          : waiting
            ? `Automation needs attention: ${a.name}`
            : `Automation failed: ${a.name}`,
      body: ok
        ? "Completed successfully."
        : error
          ? redactOperationalSecrets(error).slice(0, 200)
          : waiting
            ? "It remains enabled and will retry on the next schedule."
            : "See run history.",
      silent: true,
    }).show();
  } catch (err) {
    console.error("[automation] notification failed:", err);
  }
}

// ── 실패 처리 정책(2026-07-08) ─────────────────────────────────────────────
// 문제: 자동화가 실패해도 챗창에 아무 피드백이 없고(프롬프트만 복붙처럼 쌓임),
// 같은 시스템 원인이면 매 스케줄마다 실패 원인을 알 수 없었다.
// 정책: 실패 시 (1) Runtime Doctor가 아는 시스템 원인은 즉시 수리, (2) 실패 원인을
// 자동화 챗에 system 메시지로 표출, (3) 자동화 enabled 상태는 유지,
// (4) 수리 못 한 반복 실패는 System Optimizer(LLM) 원샷 진단 발사.
const OPTIMIZER_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 자동화당 최대 6시간에 1회
// 무활동 워치독 — 러너 이벤트가 이 시간 이상 끊기면 행(hang)으로 판정하고 자동 중단한다.
// 프로세스가 안 죽는 행은 실패 이벤트가 영영 안 와서 닥터/피드백 경로에 도달하지 못한다
// (실사고: Run now 후 중간 무반응 — 사용자는 30분 auto-abort까지 아무것도 못 봄).
// 긴 단일 툴 실행(빌드 등)도 있으므로 짧게 잡지 않는다. env로 조정 가능.
const STALL_INACTIVITY_MS = boundedIntegerEnv(
  "AGENTLAS_AUTOMATION_STALL_MS",
  8 * 60 * 1000,
  30_000,
  2 * 60 * 60 * 1000,
);
// Tool start/result events let us distinguish a dead idle runner from a healthy long-running
// single tool. Only the latter gets the wider silence budget; globally raising the idle timeout
// would merely hide real hangs for longer.
const ACTIVE_TOOL_STALL_MS = boundedIntegerEnv(
  "AGENTLAS_AUTOMATION_ACTIVE_TOOL_STALL_MS",
  Math.max(STALL_INACTIVITY_MS, 20 * 60 * 1000),
  STALL_INACTIVITY_MS,
  MAX_AUTOMATION_ACTIVE_TOOL_STALL_MS,
);
const OPTIMIZER_TIMEOUT_MS = boundedIntegerEnv(
  "AGENTLAS_AUTOMATION_OPTIMIZER_TIMEOUT_MS",
  10 * 60 * 1000,
  1_000,
  30 * 60 * 1000,
);
const RUN_HEARTBEAT_INTERVAL_MS = 15_000;
const AUTOMATION_LEASE_HEARTBEAT_MS = boundedIntegerEnv(
  "AGENTLAS_AUTOMATION_LEASE_HEARTBEAT_MS",
  60_000,
  1_000,
  5 * 60_000,
);
const lastOptimizerRunAt = new Map<string, number>();
const optimizerControllers = new Map<string, AbortController>();
// Cancellation can finish the visible optimizer slot before a broken adapter
// finishes its provider Promise. Installation must wait for both lifetimes.
const optimizerProviderPromises = new Set<object>();
function observeOptimizerProviderSettlement(provider: PromiseLike<unknown>): void {
  const token = {};
  optimizerProviderPromises.add(token);
  const release = () => { optimizerProviderPromises.delete(token); };
  // Observe rejection without changing the provider result or making a detached
  // finally chain that could become an unhandled rejection after owner Stop.
  void Promise.resolve(provider).then(release, release);
}
function trackOptimizerProviderWork<T>(action: () => Promise<T>): Promise<T> {
  const token = {};
  optimizerProviderPromises.add(token);
  return Promise.resolve()
    .then(() => withRunnerSettlementObserver(observeOptimizerProviderSettlement, action))
    .finally(() => { optimizerProviderPromises.delete(token); });
}

export class AutomationActiveRemovalError extends Error {
  readonly code = "automation_active_removal_blocked";

  constructor(readonly automationId: string, readonly phase: "run" | "optimizer") {
    super(
      phase === "optimizer"
        ? "Automation cleanup is still running. Wait for it to finish, then delete the automation."
        : "Automation is currently running. Wait for it to finish, then delete the automation.",
    );
    this.name = "AutomationActiveRemovalError";
  }
}

/**
 * Deletion is destructive while a write-capable runtime owns this automation.
 * Refuse instead of assuming AbortSignal compliance: a provider that ignores
 * cancellation could otherwise keep performing external actions after its DB,
 * chat, and user-visible parent were already deleted.
 */
export function assertAutomationRemovalSafe(automationId: string): void {
  if (running.has(automationId)) {
    throw new AutomationActiveRemovalError(automationId, "run");
  }
  if (optimizerControllers.has(automationId)) {
    throw new AutomationActiveRemovalError(automationId, "optimizer");
  }
}

/** 운영 진단/결정론 회귀용 — 실제로 적용된 유한 스케줄러 한계를 노출한다. */
export function automationSchedulerDiagnostics(): {
  maxConcurrentAutomations: number;
  stallInactivityMs: number;
  activeToolStallMs: number;
  optimizerTimeoutMs: number;
  leaseHeartbeatMs: number;
} {
  return {
    maxConcurrentAutomations: MAX_CONCURRENT_AUTOMATIONS,
    stallInactivityMs: STALL_INACTIVITY_MS,
    activeToolStallMs: ACTIVE_TOOL_STALL_MS,
    optimizerTimeoutMs: OPTIMIZER_TIMEOUT_MS,
    leaseHeartbeatMs: AUTOMATION_LEASE_HEARTBEAT_MS,
  };
}

function automationSessionInput(a: Automation): {
  automationId: string;
  agentId?: string;
  firmId?: string | null;
  projectId?: string | null;
  runtimeSelection?: RuntimeSelection | null;
} {
  return {
    automationId: a.id,
    projectId: a.projectId ?? null,
    runtimeSelection: a.runtimeSelection ?? null,
    ...(a.targetType === "firm" ? { firmId: a.targetId } : a.targetType === "agent" ? { agentId: a.targetId } : {}),
  };
}

/**
 * 실패 복구 진단은 저장된 자동화 계약보다 넓은 권한으로 올라가면 안 된다.
 * 본 실행은 구형 `read` 행도 조회 도구를 쓸 수 있도록 런타임 write를 받지만,
 * optimizer가 그 행을 write로 재해석하면 실패 원인과 복구 권한이 달라진다.
 */
/** The Runtime Doctor run uses exactly the tool surface the automation was configured with. */
export function doctorToolMode(a: Pick<Automation, "toolMode">): NonNullable<Automation["toolMode"]> {
  return a.toolMode ?? "auto";
}

function schedulerOptimizerPermission(a: Automation): "read" | "write" {
  return a.executionPermission === "read" ? "read" : automationRuntimePermission({ simulation: false });
}

function stripAutomationFailureCode(error: string): string {
  return error.replace(/^\s*\[[a-z0-9_.:-]+\]\s*/i, "").trim().slice(0, 1200);
}

function automationRuntimeLabel(selection: RuntimeSelection, ko: boolean): string {
  const labels: Record<string, string> = {
    "claude-code": ko ? "Claude Code" : "Claude Code",
    codex: "Codex",
    antigravity: "Antigravity",
    kimi: "Kimi",
    grok: "Grok",
    cursor: "Cursor",
    byok: ko ? "BYOK" : "BYOK",
    ollama: "Ollama",
    lmstudio: "LM Studio",
    mlx: "MLX",
    acp: "ACP",
    agentlas: "Agentlas",
  };
  const label = labels[selection.kind] ?? selection.kind;
  return selection.model ? `${label} · ${selection.model}` : label;
}

/** 실패 원인을 표출하고 아는 원인은 수리한다. 반복 실패도 자동화를 끄지는 않는다. */
function appendAutomationFailureNotice(
  chatId: string,
  error: string,
  runId?: string | null,
  currentRuntime?: RuntimeSelection | null,
): void {
  const ko = currentUiLocale() === "ko";
  const reason = stripAutomationFailureCode(error) || (ko ? "기록된 실패 사유가 없습니다." : "No failure reason was recorded.");
  const currentRuntimeLine = currentRuntime
    ? ko
      ? `현재 자동화 설정 실행 모델: ${automationRuntimeLabel(currentRuntime, true)}.`
      : `Current automation runtime setting: ${automationRuntimeLabel(currentRuntime, false)}.`
    : ko
      ? "현재 자동화 설정 실행 모델: 별도 고정 없음."
      : "Current automation runtime setting: no separate pin.";
  let toolEvidence = "";
  if (runId) {
    try {
      const activity = observedToolActivity(runId);
      toolEvidence = ko
        ? `호스트 실행 원장에 기록된 외부 도구 호출: ${activity.callCount}건.`
        : `External tool calls recorded by the host run ledger: ${activity.callCount}.`;
    } catch {
      /* A missing evidence row must not replace the authoritative failure reason. */
    }
  }
  const lines = ko
    ? [
      "자동화 최신 실행 상태: 완료되지 않았습니다.",
      currentRuntimeLine,
      `기록된 실행 사유: ${reason}`,
      toolEvidence,
      "이 안내가 이번 실행의 최신 사실입니다. 이전 대화의 브라우저·로그인 안내는 이번 실행 결과가 아닙니다.",
    ]
    : [
      "Latest automation run status: it did not complete.",
      currentRuntimeLine,
      `Recorded run reason: ${reason}`,
      toolEvidence,
      "This notice is the latest fact for this run. Earlier browser or login guidance in the conversation was not this run's result.",
    ];
  try {
    appendChatMessage(chatId, "system", lines.filter(Boolean).join("\n"));
  } catch (err) {
    console.error("[automation] deterministic failure notice could not be written:", err);
  }
}

/** 실패 원인을 표출하고 아는 원인은 수리한다. 반복 실패도 자동화를 끄지는 않는다. */
/**
 * "복원됨"은 복구 런의 말이 아니라 호스트의 읽기 전용 탐침이 확인해야 복구다 (P0-4, A4).
 * 실측 2026-09-24: 복구 런이 02:03·04:03·07:03 세 번 "세션 복원됨"이라 답했지만 매번 바로 다음 실행이 같은 곳에서
 * 막혔다. 탐침은 실패한 실행이 돈 런타임에 도구 없이 한 줄을 묻는다 — 답이 오면 그 런타임은 지금 쓸 수 있다.
 * 확인이 안 되면 그 사실을 원장에 적고, 지속 정책이 다음 실행의 수를 고른다(인증이면 런타임 전환 등).
 * 이 함수는 던지지 않는다 — 탐침 실패가 복구 런 실패로 보고되면 안 된다.
 */
const RESTORE_PROBE_TIMEOUT_MS = 60_000;
async function confirmOptimizerRestore(input: {
  automation: Automation;
  doctorRunId: string;
  failedRunId: string | null | undefined;
  chatId: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (shutdownDispatchClosed || input.signal?.aborted) return false;
  const probed = input.automation.runtimeSelection;
  let confirmed = false;
  let failureKind: string | null = null;
  let probeInvoked = false;
  try {
    if (probed) {
      const { callConnectedModelDetailed } = await import("./system-agents/judgment");
      if (shutdownDispatchClosed || input.signal?.aborted) return false;
      const reply = await withAutomationRunAccounting({
        runId: input.failedRunId ?? "", automationId: input.automation.id, chatId: input.chatId,
      }, () => {
        probeInvoked = true;
        return trackOptimizerProviderWork(() => callConnectedModelDetailed({
        systemPrompt: "Runtime availability check. Do not use tools. Reply with the single word READY.",
        input: "READY?",
        runtimeSelection: probed,
        requireNoTools: true,
        accept: (text) => text.trim() === "READY",
        timeoutMs: RESTORE_PROBE_TIMEOUT_MS,
        signal: input.signal,
        }));
      });
      if (shutdownDispatchClosed || input.signal?.aborted) return false;
      confirmed = reply.text?.trim() === "READY" && !reply.failure;
      failureKind = reply.failure?.kind ?? (confirmed ? null : reply.text?.trim() ? "invalid_response" : "empty");
    } else {
      failureKind = "no_runtime_selection";
    }
  } catch (error) {
    failureKind = probeInvoked ? "probe_threw" : "probe_unavailable";
    console.warn("[automation] restore probe failed:", error);
  }
  tryRecordRunEvent({
    runId: input.doctorRunId,
    kind: "system_optimizer_restore_probe",
    automationId: input.automation.id,
    payload: {
      confirmed,
      probeFailureKind: failureKind,
      runtimeKind: probed?.kind ?? null,
      runtimeBackend: probed?.backend ?? null,
      runtimeModel: probed?.model ?? null,
      failedRunId: input.failedRunId ?? null,
      readOnly: true,
    },
  });
  if (!confirmed && (failureKind === "unsupported" || failureKind === "probe_unavailable"
    || failureKind === "no_runtime_selection")) {
    try {
      const reason = failureKind === "unsupported"
        ? L("이 모델의 검증된 도구 없는 실행 기능이 없어 복구 확인을 실행하지 못했습니다.",
          "The recovery check was not run because this model's verified tool-free capability is unavailable.")
        : failureKind === "no_runtime_selection"
          ? L("선택된 실행 모델 기록이 없어 복구 확인을 실행하지 못했습니다.",
            "The recovery check was not run because no execution model is selected.")
          : L("복구 대상 실행의 기록을 검증하지 못해 복구 확인을 실행하지 않았습니다.",
            "The recovery check was not run because its source execution record could not be verified.");
      appendChatMessage(input.chatId, "system", reason + " " + L(
        "모델이 응답하지 않는다는 뜻은 아니며, 복구 완료 여부는 확인되지 않았습니다.",
        "This does not establish that the runtime is unavailable; recovery remains unverified.",
      ));
    } catch (error) {
      console.warn("[automation] unsupported restore probe notice unavailable:", error);
    }
    return false;
  }
  if (!confirmed && input.failedRunId) {
    try {
      const cause = failureKind === "quota" ? { kind: "quota" as const, retryAfterAt: null }
        : failureKind === "auth" ? { kind: "auth" as const }
        : { kind: "runtime_unavailable" as const };
      const pool = rolePriorityRuntimes(await detectRuntimes(), "worker");
      if (shutdownDispatchClosed || input.signal?.aborted) return false;
      const switchableRuntimes = pool.filter((runtime) =>
        (runtime.backend ?? null) !== (probed?.backend ?? null)
        && !runtimeCooldownForSelection(selectionForRuntime(runtime))).length;
      const latest = getAutomation(input.automation.id);
      decideAndRecordAutomationPersistence({
        automation: { id: input.automation.id, enabled: latest?.enabled ?? input.automation.enabled },
        runId: input.failedRunId,
        cause,
        switchableRuntimes,
      });
      appendChatMessage(input.chatId, "system", L(
        "복구 시도 뒤 호스트 확인에서 이 자동화의 실행 모델이 아직 응답하지 않았습니다. 복구된 것으로 세지 않았고, 다음 실행은 다른 방법으로 이어갑니다.",
        "After the recovery attempt, the host check found this automation's runtime still not answering. It was not counted as restored; the next run continues another way.",
      ));
    } catch (error) {
      console.warn("[automation] restore probe follow-up failed:", error);
    }
  }
  return confirmed;
}

async function handleAutomationFailure(a: Automation, error: string, failedRunId?: string | null): Promise<void> {
  if (shutdownDispatchClosed) return;
  let streak = 1;
  try {
    streak = Math.max(1, countConsecutiveFailures(a.id));
  } catch {
    /* run_history 조회 실패는 스트릭 1로 취급 */
  }

  try {
    const chat = getOrCreateAutomationSession(automationSessionInput(a));
    let deterministicNoticeScheduled = false;
    // Operational evidence never becomes chat copy. The controller receives it
    // privately and authors the recovery action/result in the automation's own
    // session. No error dictionary or deterministic doctor chooses the route.
    const lastAt = lastOptimizerRunAt.get(a.id) ?? 0;
    if (
      !optimizerControllers.has(a.id) &&
      Date.now() - lastAt >= OPTIMIZER_MIN_INTERVAL_MS
    ) {
      lastOptimizerRunAt.set(a.id, Date.now());
      const optimizerController = new AbortController();
      optimizerControllers.set(a.id, optimizerController);
      let recoveryRuntime: RecoveryRuntimePlan = { selection: a.runtimeSelection, switched: false, reason: "no_alternative" };
      try {
        recoveryRuntime = planRecoveryRuntime({
          failing: a.runtimeSelection,
          workerPool: rolePriorityRuntimes(await detectRuntimes(), "worker"),
          cooling: (selection) => runtimeCooldownForSelection(selection),
        });
      } catch (planError) {
        console.warn("[automation] recovery runtime plan unavailable:", planError);
      }
      if (shutdownDispatchClosed || optimizerController.signal.aborted) {
        if (optimizerControllers.get(a.id) === optimizerController) optimizerControllers.delete(a.id);
        return;
      }
      const prompt = buildSystemOptimizerPrompt({
        automationName: a.name,
        errorMessage: error,
        doctorSummary: undefined,
        consecutiveFailures: streak,
      });
      const runId = `doctor-${a.id}-${Date.now()}`;
      const req = {
        runId,
        chatId: chat.chat.id,
        automationId: a.id,
        userPrompt: prompt,
        // 제품이 스스로 보내는 복구 지시다. 표시하면 "사용자가 이렇게 말했다"로 읽히고,
        // 세션 대화에 내부 프롬프트("Private evidence …")가 그대로 노출된다.
        promptOrigin: "system" as const,
        permissions: schedulerOptimizerPermission(a),
        // Recovery acts on the automation's own surfaces. A hard-coded "auto" let
        // the 2026-09-24 doctor run for a browser-mode automation drive the owner's
        // real Chrome through Codex's Computer Use plugin. Inherit the owner's choice.
        toolMode: doctorToolMode(a),
        hubMode: a.hubMode ?? "hub-allowed",
        // Recovery starts on a different member of the owner's worker pool than the run that failed
        // (P0-4). Pinning it to the failed runtime made 4 of 10 recovery runs on 2026-09-24 die with the
        // original error (503 capacity, transport busy, usage limit). The pool order is the owner's own;
        // with no other member it falls back to the failed runtime rather than not recovering.
        runtimeSelection: recoveryRuntime.selection,
      };
      tryRecordRunEvent({
        runId,
        kind: "system_optimizer_started",
        automationId: a.id,
        payload: {
          streak,
          paused: false,
          failedKind: a.runtimeSelection?.kind ?? null,
          failedBackend: a.runtimeSelection?.backend ?? null,
          recoveryKind: recoveryRuntime.selection?.kind ?? null,
          recoveryBackend: recoveryRuntime.selection?.backend ?? null,
          recoveryModel: recoveryRuntime.selection?.model ?? null,
          recoverySwitched: recoveryRuntime.switched,
          recoveryRuntimeReason: recoveryRuntime.reason,
          failedRunId: failedRunId ?? null,
        },
      });
      let removeAbortListener = () => {};
      const abortGate = new Promise<never>((_resolve, reject) => {
        const onAbort = () => {
          const reason = optimizerController.signal.reason;
          reject(
            reason instanceof Error
              ? reason
              : new Error(typeof reason === "string" ? reason : "System Optimizer cancelled"),
          );
        };
        optimizerController.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => optimizerController.signal.removeEventListener("abort", onAbort);
      });
      const optimizerTimer = setTimeout(() => {
        optimizerController.abort(
          new Error(
            `System Optimizer total timeout after ${Math.round(OPTIMIZER_TIMEOUT_MS / 1000)}s`,
          ),
        );
      }, OPTIMIZER_TIMEOUT_MS);
      if (optimizerTimer.unref) optimizerTimer.unref();
      // Promise.resolve().then은 동기 throw까지 같은 실패 경로로 수렴시킨다. abortGate를
      // race에 넣어 runner가 AbortSignal을 무시해도 cancel/timeout 시 lifecycle은 끝난다.
      // System Optimizer 복구 런도 무인 배경 작업이다 — 채팅 턴을 밀어내면 안 된다.
      const optimizerRun = trackOptimizerProviderWork(() => {
        if (shutdownDispatchClosed) throw new Error("app_closed");
        throwIfAutomationAborted(optimizerController);
        return withAutomationRunAccounting({
        runId: failedRunId ?? "", automationId: a.id, chatId: chat.chat.id,
      }, () => withRunPriority("background", () =>
        runMcpInvocation(
          req,
          (ev) => recordMcpInvocationEvent(runId, req, ev),
          optimizerController.signal,
          captureAutomationWorkspace((() => {
            const current = getAutomation(a.id);
            if (!current) throw new AutomationWorkspaceError("automation_workspace_owner_changed");
            return current;
          })()).binding,
          { source: "automation" },
        ),
      ));
      });
      void Promise.race([optimizerRun, abortGate])
        .then(async () => {
          // The recovery run's own "restored" is a claim. Count it only after a read-only host probe.
          if (shutdownDispatchClosed || optimizerController.signal.aborted) return;
          await withAutomationJudgmentSignal(optimizerController.signal, () => confirmOptimizerRestore({
            automation: a, doctorRunId: runId, failedRunId, chatId: chat.chat.id, signal: optimizerController.signal,
          }));
          throwIfAutomationAborted(optimizerController);
        })
        .catch((err) => {
          if (appClosedControllers.has(optimizerController)) {
            tryRecordRunEvent({ runId, automationId: a.id, kind: "system_optimizer_interrupted",
              payload: { reasonCode: "automation_app_closed", failedRunId: failedRunId ?? null } });
            return;
          }
          console.error("[automation] system optimizer run failed:", err);
          // 복구 시도가 죽은 사실은 콘솔에만 남으면 없는 것과 같다. 원래 자동화
          // 실패 고지와 분리된 호스트 행으로 남겨, 취소·타임아웃도 사용자가 확인하게 한다.
          const reason = err instanceof Error ? err.message : String(err);
          const notDispatched = reason === "accounting_automation_anchor_missing";
          if (notDispatched) tryRecordRunEvent({ runId, automationId: a.id,
            kind: "system_optimizer_skipped", payload: { reason, failedRunId: failedRunId ?? null } });
          try {
            appendChatMessage(
              chat.chat.id,
              "system",
              L(
                notDispatched ? "복구 대상 실행의 기록을 확인하지 못해 자동 진단을 실행하지 않았습니다."
                  : `System Optimizer 진단 런 자체가 실패했습니다: ${reason.slice(0, 500)}`,
                notDispatched ? "Automatic diagnosis was not run because its source execution record could not be verified."
                  : `The System Optimizer diagnostic run itself failed: ${reason.slice(0, 500)}`,
              ),
            );
          } catch (writeErr) {
            console.error("[automation] optimizer failure notice could not be written:", writeErr);
          }
        })
        .finally(() => {
          clearTimeout(optimizerTimer);
          removeAbortListener();
          if (optimizerControllers.get(a.id) === optimizerController) {
            optimizerControllers.delete(a.id);
          }
          appendAutomationFailureNotice(chat.chat.id, error, failedRunId, a.runtimeSelection);
        });
      deterministicNoticeScheduled = true;
    }
    if (!deterministicNoticeScheduled) appendAutomationFailureNotice(chat.chat.id, error, failedRunId, a.runtimeSelection);
  } catch (err) {
    console.error("[automation] failure feedback failed:", err);
  }

}

export function stopAutomationRun(automationId: string): boolean {
  let checking = false;
  for (const entry of backgroundClassifications.values()) if (entry.automationId === automationId) {
    entry.controller.abort(new Error("automation_stopped_by_user")); checking = true;
  }
  let parked = false;
  let stopped = false;
  try {
    const waiting = getGraphLoginWaitCheckpoint(automationId);
    if (waiting) { cancelGraphLoginWait(automationId, waiting.runId); parked = true; }
  } finally {
    stopped = stopExecutionAutomationRun(automationId);
  }
  return checking || parked || stopped;
}

async function runOne(
  a: Automation,
  opts?: {
    claim?: boolean;
    advanceSchedule?: boolean;
    allowDisabledLease?: boolean;
    /** 시뮬레이션 실행 — 외부에 나가는 변경을 막고 무엇이 막혔는지 영수증으로 남긴다. */
    dryRun?: boolean;
    /** 실패한 occurrence를 재개하지 않고, 안전하게 허용될 때 새 occurrence로 시작한다. */
    fresh?: boolean;
    triggerDelivery?: TriggerDeliveryHooks;
    triggerContext?: TriggerEventPayload;
    /** Exact scheduled occurrence. Calendar slots must not implicitly resume
     * another slot merely because it is the latest failed graph. */
    occurrenceId?: string;
    /** The scheduled fire time. Recording the run and advancing the schedule
     *  must use the same clock, or a run fired for a past-due slot stamps
     *  last_run_at with wall-clock now while next_run_at advances from the slot,
     *  leaving next_run_at < last_run_at. Defaults to now for run-now/triggers. */
    fireTime?: Date;
    /** 완주 루프 ④의 1회 재시도 표식 — 재시도의 재시도를 막는다. */
    zeroToolRetried?: boolean;
    /** Preallocated by an immediate-ack caller and already durably requested. */
    runId?: string;
    preclaimed?: boolean;
    resumeLoginWaitRunId?: string;
  },
): Promise<TriggerDispatchResult> {
  const afterSettled = captureMainRootContinuation();
  if (dispatchPaused()) return { accepted: false };
  if (running.has(a.id)) return { accepted: false };
  if (!a.graph && hasGraphLoginWait(a.id) && !opts?.resumeLoginWaitRunId) return { accepted: false }; // 직전 실행이 아직 진행 중이면 건너뜀
  // due[] may have waited behind another run. The controller must belong to
  // the same stored definition that this invocation will actually execute.
  const definitionSnapshot = (value: Automation) => JSON.stringify({
    id: value.id, createdAt: value.createdAt, createdBy: value.createdBy, goalId: value.goalId ?? null,
    promptTemplate: value.promptTemplate, graph: value.graph ?? null, targetType: value.targetType,
    targetId: value.targetId, projectId: value.projectId ?? null, runtimeSelection: value.runtimeSelection ?? null,
    executionPermission: value.executionPermission, toolMode: value.toolMode ?? null, hubMode: value.hubMode ?? null,
    targetVersion: value.targetVersion ?? null, goal: value.goal ?? null, monitor: value.monitor ?? null,
    scheduleHuman: value.scheduleHuman, scheduleSpec: value.scheduleSpec ?? null, timezone: value.timezone ?? null,
    triggerType: value.triggerType ?? null, trigger: value.trigger ?? null,
  });
  const executionDefinition = definitionSnapshot(a);
  const retry = legacyRuntimeRetries.get(a);
  let expectedDefinition = retry?.storedDefinition ?? executionDefinition;
  const assertDefinitionCurrent = () => {
    const current = getAutomation(a.id);
    if (!current || (retry && retry.executionDefinition !== executionDefinition)
      || definitionSnapshot(current) !== expectedDefinition) {
      throw new Error("automation_goal_execution_owner_changed");
    }
  };
  // Capture actual execution ownership before any awaited ledger read. Workspace
  // selection and mutable goal_id alone cannot bind a Goal to this controller.
  let goalOwner: ReturnType<typeof captureAutomationGoalExecutionOwner>;
  try { assertDefinitionCurrent(); goalOwner = captureAutomationGoalExecutionOwner(a.id); }
  catch (error) {
    // Keep the current automation alive while its Goal projection is checked.
    // An unverified Goal relationship confers no authority over that Goal.
    goalOwner = undefined;
    tryRecordRunEvent({ runId: `automation-binding-check:${randomUUID()}`, automationId: a.id,
      kind: "automation_goal_binding_check_pending", payload: {
        reasonCode: error && typeof error === "object" && "code" in error ? String(error.code) : "automation_goal_execution_owner_unverified" } });
  }

  if (a.goalId) {
    const goalDecision = await goalLedgerShouldContinue(a.goalId);
    const nativeGoal = getLongRunByGoalId(a.goalId);
    const ownerHeld = nativeGoal && (longRunOwnerHold(nativeGoal.id)
      || ["completed", "cancelled", "cancelling"].includes(nativeGoal.status));
    if (ownerHeld) {
      if (goalDecision) try { settleRefusedGoalContinuation({ automation: a, decision: goalDecision, locale: currentUiLocale() }); }
      catch (error) { console.error("[automation] owner stop reconciliation pending:", error); }
      if (opts?.preclaimed) { try { releaseAutomationRun(a.id, LEASE_OWNER); } catch { /* peer lease */ } }
      return { accepted: false };
    }
    if (!goalDecision || !goalDecision.continue) {
      tryRecordRunEvent({ runId: `automation-goal-advisory:${randomUUID()}`, automationId: a.id,
        kind: "automation_goal_continue_advisory", payload: { reasonCode: goalDecision?.reason ?? "goal_ledger_unavailable",
          continuation: "independent-current-work" } });
    }
  }
  // The goal-ledger read awaited: Quit or an update may have closed dispatch meanwhile.
  if (dispatchPaused()) {
    if (opts?.preclaimed) { try { releaseAutomationRun(a.id, LEASE_OWNER); } catch { /* peer lease */ } }
    return { accepted: false };
  }
  // 모든 실행 경로가 같은 크로스프로세스 리스를 사용한다. GUI의 Run now나 이벤트 트리거도
  // headless due 실행과 겹치면 외부 게시/결제 같은 부작용을 두 번 낼 수 있으므로 건너뛴다.
  if (
    opts?.claim && !opts.preclaimed &&
    !claimAutomationRun(a.id, LEASE_OWNER, new Date(), { allowDisabled: opts.allowDisabledLease === true })
  ) return { accepted: false };
  try {
    opts?.triggerDelivery?.onAccepted();
  } catch (error) {
    // The outbox receipt is the authority for an event-trigger occurrence. If
    // it cannot be advanced while we own the automation lease, do not execute.
    if (opts?.claim) {
      try {
        releaseAutomationRun(a.id, LEASE_OWNER);
      } catch {
        /* owner CAS protects a peer lease */
      }
    }
    console.error("[automation] trigger delivery acceptance failed:", error);
    return { accepted: false };
  }
  running.add(a.id);
  /**
   * 판정 어휘(ok/skipped/…)를 결과 어휘로 옮긴다. 두 어휘를 같은 것으로 쓰다가
   * 한 칸에 두 답이 섞였으므로, 옮기는 자리를 한 곳으로 못 박는다.
   */
  const outcomeOf = (verdict: AutomationResultStatus): AutomationRunRecord["outcome"] => {
    if (verdict === "ok" || verdict === "skipped") return "accepted";
    if (verdict === "needs_input") return "needs_input";
    if (verdict === "blocked") return "blocked";
    return "rejected";
  };
  let graphLoginWait: RunGraphResult | null = null;
  let runStatus: AutomationResultStatus = "ok";
  /**
   * 판정의 답 — **나온 결과물이 쓸 만한가**. runStatus(끝까지 돌았는가)와 다른 질문이다.
   * null이면 판정을 부르지 않은 실행이다(예: 실행 자체를 못 한 preflight 스킵).
   */
  let runOutcome: AutomationRunRecord["outcome"] = null;
  let runOutcomeReason: string | null = null;
  let runReasonCode: string | null = null;
  /** 이번 실행이 "실패"가 아니라 "판정 불가"로 끝났는가 — 복구 워커·실패 표시의 억제 조건. */
  let judgmentUnavailableRun = false;
  let runError: string | null = null;
  /**
   * 커널이 남긴 원문 실패 문자열. runError는 사용자에게 보여줄 문장으로 교체되므로
   * 기계 판단(부수효과 모호 → 재실행 정지)은 반드시 이 값으로 한다.
   */
  let machineError: string | null = null;
  let workspaceFailure: AutomationWorkspaceError | null = null;
  let output: string | undefined;
  let currentRunId: string | null = null;
  /** The last agent node's goal-loop signals (continue marker, completion claim). */
  let goalSignals: GoalContinuationSignals | null = null;
  /** 호스트가 센 "제자리 돌기" — 걸리면 이 실행만 멈추고 기계 표식으로 남긴다(사용자 중지와 구분). */
  let noProgressLoop: NoProgressDecision | null = null;
  /**
   * 무활동 감시견이 멈춘 실행(P0-7, A12). 감시견은 예전에 **사용자의 중지 손잡이(controller)**를 당겼다 — 그래서
   * 바깥 catch 가 `controller.signal.aborted` 를 보고 "사용자가 멈췄다(automation_stopped_by_user)"로 적었고,
   * 복구 경로(`!controller.signal.aborted` 조건)도 건너뛰었다. 이제 감시견은 자기 손잡이를 당기고 타입 원인을 남긴다.
   */
  let watchdogStall: AutomationWatchdogDecision | null = null;
  const watchdogController = new AbortController();
  let graphRunAttempted = false;
  /** 커널/러너가 예외 없이 끝까지 돌았는가(판정 전) — 자기 보류 판정의 호스트 사실. */
  let runCompleted = false;
  const isGraphAutomation = Boolean(a.graph && a.graph.nodes.length > 0);
  const scheduledOccurrenceId =
    (opts?.advanceSchedule ?? true) &&
    opts?.occurrenceId?.startsWith(`schedule:${a.id}:`)
      ? opts.occurrenceId
      : null;
  let scheduledAttemptRecorded = false;
  let runLedgerRecorded = false;
  const pendingClassifications: Array<() => void> = [];
  // 이번 실행 "이전"의 실패 스트릭 — 성공 시 복구 학습(recordAutomationRecovery) 판정에 쓴다.
  // markAutomationRun 이후에는 이번 결과가 이력에 섞여 사전 상태를 복원할 수 없다.
  let priorFailureContext: AutomationFailureContext = { streak: 0, recentErrors: [] };
  try {
    priorFailureContext = collectAutomationFailureContext(a.id);
  } catch {
    /* 이력 조회 실패는 복구 학습만 건너뛴다 */
  }
  let parentMissing = false;
  let leaseOwnershipLost = false;
  let leaseHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let leaseRenewWarningEmitted = false;
  const controller = new AbortController();
  const rejectDefinition = (): never => {
    const error = new Error("automation_goal_execution_owner_changed");
    controller.abort(error);
    throw error;
  };
  const assertGoalCurrent = () => {
    try { assertDefinitionCurrent(); assertAutomationGoalExecutionOwner(goalOwner); }
    catch (error) { controller.abort(error); throw error; }
  };
  try {
    if (scheduledOccurrenceId) {
      // Count the attempt before runtime/permission/Hub preflight. Those gates
      // can fail before runGraph creates automation_runs, but they are still a
      // real firing of this scheduled occurrence and must open the same bounded
      // retry circuit. A stable sourceEventId makes a repeated delivery of the
      // same preallocated run id idempotent.
      currentRunId = opts?.runId ?? `run-${a.id}-${Date.now()}-${randomUUID().slice(0, 8)}`;
      recordRunEvent({
        runId: currentRunId,
        kind: "automation_schedule_attempt_started",
        automationId: a.id,
        payload: { occurrenceId: scheduledOccurrenceId },
        sourceEventId: "automation_schedule_attempt_started",
      });
      scheduledAttemptRecorded = true;
      console.info("[automation] scheduled occurrence started", JSON.stringify({
        automationId: a.id,
        occurrenceId: scheduledOccurrenceId,
        runId: currentRunId,
      }));
    }
    /*
     * ★사람이 멈출 수 있게 이 실행의 중단 손잡이를 등록한다.
     *
     * 컨트롤러는 원래 있었지만 **밖에서 부를 통로가 없어**, 잘못 도는 실행을 눈으로
     * 보면서도 끝날 때까지 기다려야 했다(다른 기능은 전부 취소가 있다:
     * invoke:cancel · hephaestus:cancelBuild · oberon:cancelRender).
     * 자동화는 사람이 안 볼 때 도는 것이라, 봤을 때 세울 수 있어야 한다.
     */
    bindAutomationRunStop(a.id, controller, goalOwner);
    activeExecutionControllers.add(controller);
    // Registration revalidates the pre-await snapshot. A Goal pause in the
    // ledger-read gap cannot become a late controller after Stop acknowledged.
    assertGoalCurrent();
    if (opts?.claim) {
      leaseHeartbeatTimer = setInterval(() => {
        try {
          const renewed = renewAutomationRunLease(
            a.id,
            LEASE_OWNER,
            new Date(),
            { allowDisabled: opts.allowDisabledLease === true },
          );
          if (!renewed) {
            leaseOwnershipLost = true;
            controller.abort(new Error("Automation execution lease ownership lost"));
          } else {
            leaseRenewWarningEmitted = false;
          }
        } catch (error) {
          // A single SQLITE_BUSY/I/O renewal miss is not proof that another
          // process owns the lease. Keep the run alive and retry next tick.
          if (!leaseRenewWarningEmitted) {
            leaseRenewWarningEmitted = true;
            const code = error && typeof error === "object" && "code" in error
              ? String((error as { code?: unknown }).code ?? "transient")
              : "transient";
            console.warn(`[automation] lease heartbeat deferred (${code.slice(0, 80)})`);
          }
        }
      }, AUTOMATION_LEASE_HEARTBEAT_MS);
      leaseHeartbeatTimer.unref?.();
    }
    // Host authority preflight precedes runtime discovery, Hub calls and judgments.
    captureAutomationWorkspace(a);
    const storedContract = getAutomationExecutionContractState(a.id);
    if (!storedContract) throw new Error(`Automation not found: ${a.id}`);
    if (storedContract.runtimeSelection === "invalid") {
      throw new Error(
        "pinned_runtime_contract_invalid: the saved runtime pin is malformed and requires an explicit runtime selection.",
      );
    }
    if (storedContract.hubMode === "invalid") {
      throw new Error(
        "automation_hub_mode_contract_invalid: the saved Hub routing policy is unknown and requires an explicit selection.",
      );
    }
    if (storedContract.runtimeSelection === "missing" && !retry) {
      // Automations execute as workers. Resolve an unpinned automation from the
      // stored Worker role order; detection order must never choose its model.
      const activeRuntime = rolePriorityRuntimes(await detectRuntimes(), "worker")[0] ?? null;
      if (!activeRuntime) throw new Error("No runtime is available to pin for this automation.");
      // selectionForRuntime carries the exact ACP seat; a hand-built pin dropped it.
      assertGoalCurrent();
      const unpinned = a;
      const pinned = pinAutomationRuntimeIfUnset(a.id, selectionForRuntime(activeRuntime, {
        longContext: activeRuntime.longContextEnabled ?? undefined,
      }));
      // Advance only the exact first-run runtime pin. A concurrent edit to any
      // other stored execution field must still fail the definition fence.
      if (unpinned.runtimeSelection || !pinned.runtimeSelection
        || definitionSnapshot({ ...pinned, runtimeSelection: unpinned.runtimeSelection }) !== expectedDefinition) {
        rejectDefinition();
      }
      a = pinned;
      expectedDefinition = definitionSnapshot(pinned);
      tryRecordRunEvent({
        runId: currentRunId ?? `automation-pin-${a.id}-${Date.now()}`,
        kind: "automation_runtime_pinned",
        automationId: a.id,
        payload: { kind: a.runtimeSelection?.kind, model: a.runtimeSelection?.model ?? null },
      });
      if (!a.runtimeSelection) {
        throw new Error(
          "pinned_runtime_contract_invalid: the runtime pin compare-and-set did not produce a valid exact selection.",
        );
      }
    }
    /*
     * ★에이전트가 만들며 복사한 핀은 오너의 지금 설정을 따른다(목표 대화 모델 칩 → 워커 풀).
     *   오너가 고른 핀은 그대로. 어느 쪽이든 한도/인증 쿨다운이거나 최근 연속 "제자리 돌기"면
     *   워커 풀의 다른 공급자로 이번 실행만 넘긴다. 저장된 핀은 바꾸지 않는다(automation-runtime-plan.ts).
     *   도구 0건 재시도(zeroToolRetried)는 호출자가 고른 런타임을 그대로 쓴다.
     */
    if (!opts?.zeroToolRetried) {
      try {
        const plan = await planAutomationRuntimeForRun(
          a,
          currentRunId ?? opts?.runId ?? `automation-runtime-plan-${a.id}-${Date.now()}`,
        );
        if (plan.changed && plan.selection) a = { ...a, runtimeSelection: plan.selection };
      } catch (planError) {
        // 계획을 못 세우면 저장된 핀으로 돈다 — 실행을 막을 이유가 아니다.
        console.warn(`[automation] runtime plan unavailable (${a.id}):`, planError);
      }
    }
    const missingHubSlugs = new Set<string>();
    if (a.targetType === "hub" && !a.targetVersion) missingHubSlugs.add(a.targetId);
    for (const node of a.graph?.nodes ?? []) {
      if (
        node.type === "agent" && node.config?.targetType === "hub" &&
        typeof node.config.ref === "string" && node.config.ref.trim() &&
        typeof node.config.targetVersion !== "string"
      ) {
        missingHubSlugs.add(node.config.ref.trim());
      }
    }
    if (missingHubSlugs.size > 0) {
      const exactHashes: Record<string, string> = {};
      const lookups = await Promise.all([...missingHubSlugs].sort().map(async slug => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const listing = await Promise.race([
            Promise.resolve().then(() => getMarketSource().getListingBySlug(slug)),
            new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 5_000); timer.unref?.(); }),
          ]);
          const packageHash = listing?.packageHash ?? listing?.cloudPackage?.packageHash;
          if (listing?.slug === slug && listing.callable === true && typeof packageHash === "string"
            && /^[0-9a-f]{64}$/.test(packageHash)) return { slug, packageHash };
        } catch { /* Lookup failure is a node-local missing version, never a run admission failure. */ }
        finally { if (timer) clearTimeout(timer); }
        return { slug, packageHash: null };
      }));
      for (const lookup of lookups) {
        if (lookup.packageHash) exactHashes[lookup.slug] = lookup.packageHash;
        else tryRecordRunEvent({ runId: currentRunId ?? `automation-hub-check:${a.id}:${randomUUID()}`,
          automationId: a.id, kind: "automation_hub_pin_check_pending",
          payload: { slug: lookup.slug, reasonCode: "automation_hub_version_pin_unavailable", continuation: "independent-nodes" } });
      }
      // The existing pin transaction seals every missing version together.
      // An incomplete batch leaves those nodes quarantined by runGraph; no
      // unverified or partial hash is substituted into the saved definition.
      if (lookups.every(lookup => lookup.packageHash !== null)) {
      assertGoalCurrent();
      const beforeMigration = getAutomation(a.id);
      const migrated = pinLegacyAutomationHubVersions(a.id, exactHashes);
      const restored = { ...migrated.automation, targetVersion: beforeMigration?.targetVersion,
        graph: migrated.automation.graph && beforeMigration?.graph ? { ...migrated.automation.graph,
          nodes: migrated.automation.graph.nodes.map((node) => {
            const before = beforeMigration.graph!.nodes.find((candidate) => candidate.id === node.id);
            return before ? { ...node, config: { ...node.config, targetVersion: before.config?.targetVersion } } : node;
          }) } : migrated.automation.graph };
      if (!beforeMigration || definitionSnapshot(restored) !== expectedDefinition) {
        rejectDefinition();
      }
      const executionRuntime = a.runtimeSelection;
      expectedDefinition = definitionSnapshot(migrated.automation);
      a = { ...migrated.automation, runtimeSelection: executionRuntime };
      if (migrated.pinned.length > 0) {
        tryRecordRunEvent({
          runId: currentRunId ?? `automation-hub-pin-${a.id}-${Date.now()}`,
          kind: "automation_hub_version_pinned",
          automationId: a.id,
          payload: { pins: migrated.pinned },
        });
      }
      }
    }

    // Legacy rows must cross the same durable occurrence/checkpoint boundary as
    // visual graphs. A one-node prompt can still post externally and then fail;
    // running it through the old direct path would replay the whole prompt on
    // the next schedule with no ambiguity guard.
    if (!a.graph || a.graph.nodes.length === 0) {
      a = { ...a, graph: synthesizeLegacyGraph(a) };
    }
    // 컴퓨터유즈 자동화 preflight — macOS 접근성 권한이 없으면 실행하지 않고 '대기'로 스킵한다.
    // (예전엔 권한 없이 실행돼 브라우저 자동화가 부분 실행 후 먹통/혼란. 이제 빠르게 감지 →
    //  다음 예약에 자동 재시도, false-fail도 false-success도 아님.)
    const cuaPerm = a.toolMode === "computer-use" ? checkComputerUsePermissions() : null;
    if (cuaPerm && !cuaPerm.ok && !a.graph) {
      runStatus = "needs_input";
      runError = L(
        `macOS가 이 앱 실행본에 ${cuaPerm.missing.join(" · ")} 권한을 주지 않아 컴퓨터유즈 자동화를 건너뜁니다(먹통 방지). ` +
        // ★"켜세요"라는 경로 문장만으로는 부족하다 — 캔버스의 권한 카드가 설정 화면을
        //   바로 여는 버튼을 제공한다. 이미 켰다면 다른 실행본(설치본↔개발 실행)에 켰을 수 있다.
        `자동화 화면의 [설정 화면 바로 열기] 버튼으로 켜 주세요. 켜면 다음 예약에 자동 재시도합니다.`,
        `macOS did not grant this app build the ${cuaPerm.missing.join(" · ")} permission(s), so the computer-use automation is being skipped (to avoid a hang). ` +
        `Turn it on with the [Open Settings] button on the automation screen. Once it's on, this will auto-retry on the next scheduled run.`,
      );
      console.warn(`[automation] CUA preflight skip (${a.name}): missing ${cuaPerm.missing.join(", ")}`);
    } else if (a.targetType === "hub" && !a.targetVersion && !a.graph) {
      runStatus = "needs_input";
      runError =
        "[hub_version_pin_required] automation_hub_version_pin_required: " +
        L(
          "정확한 Hub 패키지 버전을 선택해야 자동화를 실행할 수 있습니다. 자동화 편집 화면에서 Hub 대상을 다시 선택하세요.",
          "An exact Hub package version must be selected before this automation can run. Reselect the Hub target on the automation edit screen.",
        );
    } else if (a.graph && a.graph.nodes.length > 0) {
      // 그래프 경로 — 위상 러너로 실행. per-node 상태를 라이브 채널로 방송해 캔버스가 애니메이션.
      graphRunAttempted = true;
      const runId = currentRunId ?? opts?.runId ?? `run-${a.id}-${Date.now()}`;
      currentRunId = runId;
      opts?.triggerDelivery?.onRunBound(runId);
      // 사람이 대기시켜 둔 입력을 이 실행에 묶는다. 소비는 한 번만 성공하므로
      // 같은 값으로 두 번 실행되지 않는다. 이벤트 트리거가 준 값이 있으면 그 위에 얹는다
      // — 사람이 방금 준 값이 자동 수집된 값보다 뒤에 오는 것이 사용자의 기대다.
      const ownerContinuationContext = goalContinuationRunContext(a);
      let graphInitialVars = opts?.triggerContext;
      if (!opts?.dryRun) {
        try {
          const pending = consumeRunInput(a.id, runId);
          if (pending) graphInitialVars = { ...(graphInitialVars ?? {}), ...pending.payload };
        } catch (error) {
          console.error("[automation] pending run input could not be bound:", error);
        }
      }
      // 무활동 워치독 — 그래프 경로도 이벤트가 끊기면 행으로 판정한다(노드 자체 타임아웃
      // 1800s보다 훨씬 먼저 사용자에게 실패 피드백이 가도록).
      const graphWatchdog = createAutomationWatchdogState();
      const graphProgressGuard = createNoProgressGuard({ observationMode: "completed" });
      // 사용자 중지(controller)와 섞지 않는다 — 섞으면 catch 가 "사용자가 멈췄다"로 적는다.
      const noProgressController = new AbortController();
      const graphSignal = AbortSignal.any([controller.signal, noProgressController.signal, watchdogController.signal]);
      let lastDurableHeartbeatAt = 0;
      const persistGraphHeartbeat = (at = Date.now()): void => {
        if (at - lastDurableHeartbeatAt < RUN_HEARTBEAT_INTERVAL_MS) return;
        lastDurableHeartbeatAt = at;
        try {
          touchGraphRun(runId, new Date(at));
        } catch {
          // The live watchdog remains authoritative for this process. A later
          // event/tick can retry the durable cross-process heartbeat.
        }
      };
      let graphStall: AutomationWatchdogDecision | null = null;
      const graphStallTimer = setInterval(() => {
        const decision = evaluateAutomationWatchdog(
          graphWatchdog,
          STALL_INACTIVITY_MS,
          ACTIVE_TOOL_STALL_MS,
        );
        if (decision.stalled) {
          graphStall = decision;
          watchdogStall = decision;
          // Each node owns its timeout. A Graph check cannot abort all siblings.
        }
      }, 30_000);
      let result;
      let acceptGraphEvents = true;
      try {
        // ★background 우선순위 — 이 실행에서 스폰되는 모든 러너/자식(run-graph 내부 포함)이
        //   실행 슬롯 2단 큐에서 사람이 기다리는 채팅 턴 뒤로 서고, nice 10 을 받는다.
        //   run-graph.ts 를 고치지 않고도 문맥(AsyncLocalStorage)으로 전파된다.
        const graphRun = Promise.resolve().then(() => {
          throwIfAutomationAborted(controller);
          assertGoalCurrent();
          return withRunPriority("background", () =>
          runGraph(a, a.graph!, {
            signal: graphSignal,
            ...(opts?.dryRun ? { dryRun: true } : {}),
            ...(opts?.fresh ? { fresh: true } : {}),
          runId,
          occurrenceId: opts?.triggerDelivery?.occurrenceId ?? opts?.occurrenceId,
          resumeLoginWaitRunId: opts?.resumeLoginWaitRunId,
          initialVars: graphInitialVars,
          ownerContinuationContext,
          strategyCycle: "defer",
          onAgentInvocationSignals: (_nodeId, signals) => { goalSignals = signals; },
          sink: (ev) => {
              // A cancellation-ignoring runtime may emit after the scheduler's finite abort
              // boundary. Do not revive watchdog/live state after this run has been finalized.
              if (!acceptGraphEvents) return;
              recordAutomationQuotaReset(runId, a.id, ev);
              noteAutomationWatchdogEvent(graphWatchdog, ev);
              persistGraphHeartbeat();
              if (!noProgressLoop) {
                const loop = noteNoProgressEvent(graphProgressGuard, ev);
                if (loop) {
                  noProgressLoop = loop;
                  tryRecordRunEvent({
                    runId,
                    kind: AUTOMATION_NO_PROGRESS_LOOP,
                    automationId: a.id,
                    ...(loop.nodeId ? { nodeId: loop.nodeId } : {}),
                    payload: {
                      rule: loop.rule, tool: loop.tool, fingerprint: loop.fingerprint, count: loop.count,
                      kind: a.runtimeSelection?.kind ?? null,
                      backend: a.runtimeSelection?.backend ?? null,
                      model: a.runtimeSelection?.model ?? null,
                    },
                  });
                  // Repeating one tool is a node diagnosis. Other Graph branches
                  // keep their own deadlines and continue independent work.
                }
              }
              // ★실패가 아닌 **상태 변화**도 화면에 보낸다 (커넥터 C44).
              //
              // 예전에는 `nodeState`가 붙은 이벤트만 건너갔다. 그래서 긴 노드가 도는 동안
              // 화면은 "실행 중"에서 멈춰 있고, 무엇을 하는 중인지·어디까지 왔는지가
              // 아무 데도 안 보였다. 사람은 그걸 "멈췄다"로 읽는다.
              //
              // Node-RED가 Status 노드를 따로 둔 이유가 정확히 이것이다 — 문서 원문:
              // *"MQTT 노드가 연결을 잃어도 에러 이벤트가 아니라 상태 변화만 일으킨다."*
              // 이 저장소의 stale-online 사고(요청 타임아웃이 연결을 안 죽여 영원히 온라인)도
              // 같은 모양이다: 실패는 아닌데 상태가 변했고, 그걸 받을 채널이 없었다.
              if (ev.nodeState || ev.kind === "tool-use" || ev.kind === "thinking" || ev.kind === "reasoning") {
                broadcastLiveRun(a.id, ev);
              }
            },
          }),
        );
        });
        result = await awaitAutomationRunnerWithAbortGrace(graphRun, graphSignal);
      } catch (err) {
        // abort로 runGraph가 던지면 스톨 메시지로 바꿔 닥터 timeout 분류에 태운다.
        if (graphStall) {
          throw new Error(automationWatchdogError(graphStall));
        }
        if (noProgressLoop && !controller.signal.aborted) console.warn("[automation] Graph no-progress remains advisory");
        throw err;
      } finally {
        acceptGraphEvents = false;
        clearInterval(graphStallTimer);
      }
      // 그래프가 중단 신호를 받고도 결과를 돌려준 경우 — 멈춘 이유는 호스트가 센 반복이다.
      if (noProgressLoop) tryRecordRunEvent({ runId, automationId: a.id, kind: "graph_no_progress_advisory", payload: { code: AUTOMATION_NO_PROGRESS_LOOP } });
      const graphHasUnconfirmedMutation = Object.values(result.nodeFailures ?? {}).some((failure: unknown) =>
        failure && typeof failure === "object" && "code" in failure
        && (failure as { code?: unknown }).code === "MUTATION_UNVERIFIED",
      );
      const graphError = graphStall
        ? automationWatchdogError(graphStall)
        : result.error ?? null;
      runStatus = result.ok && !graphStall ? "ok" : "error";
      runError = graphError;
      // 판정이 이 문장을 사용자용으로 갈아끼우기 전에 원문을 붙들어 둔다(안전 판단용).
      machineError = graphHasUnconfirmedMutation
        ? `MUTATION_UNVERIFIED: ${graphError ?? "graph node effect was not confirmed"}`
        : graphError;
      throwIfAutomationAborted(controller);
      // 그래프 outputs 중 마지막 노드 출력을 체인 페이로드로 노출.
      const outVals = Object.values(result.outputs ?? {});
      output = outVals.length ? outVals[outVals.length - 1] : undefined;
      /*
       * ★판정에게 **마지막 글 한 줄**이 아니라 실행 기록을 준다.
       *   실측 2026-08-20 (캠페인 E3): 검증으로 끝나는 그래프의 마지막 출력은 `"pass"` 라,
       *   첨부 3건을 정확히 정리한 실행과 이미 다 처리돼 할 일이 없던 실행이 판정 눈에
       *   똑같았다. 후자가 "pass 라고만 하고 한 일이 없다"로 거절됐다 — "이미 한 건 다시
       *   하지 마"로 만든 자동화는 조용한 날마다 실패로 찍힌다.
       *   기록은 호스트가 적는다. 요약도 해석도 하지 않고, 노드 이름과 그 노드가 낸 값을
       *   선언 순서대로 옮긴다.
       */
      const runRecord = {
        steps: (a.graph?.nodes ?? [])
          .map((node) => ({
            label: String(node.label || node.id),
            output: String(result.outputs?.[node.id] ?? ""),
          }))
          .filter((step) => step.output.trim().length > 0),
      };
      if (result.needsInput) {
        graphLoginWait = result;
        runStatus = "needs_input"; runOutcome = "needs_input";
        runReasonCode = "browser_login_required"; machineError = "browser_login_required";
        runError = L("브라우저 로그인이 복원되기를 기다리고 있습니다.", "Waiting for the browser login to be restored.");
        runOutcomeReason = runError;
      } else if (runStatus === "ok") {
        runCompleted = true;
        // ★두 답을 두 칸에 남긴다.
        //
        // 예전에는 여기서 `runStatus = classified.outcome` 으로 **커널의 답을 지웠다**.
        // 커널은 "그래프가 끝까지 돌았다(ok)"고 했는데 화면에는 판정의 답만 남아
        // "내 확인 필요"로 보였고, 사용자는 성공인지 실패인지 알 수 없었다.
        // 두 값은 서로 다른 질문의 답이라 한 칸에 겹쳐 담을 수 없다:
        //   status  = 끝까지 돌았는가 (커널이 안다)
        //   outcome = 나온 결과물이 쓸 만한가 (판정이 본다)
        // ★판정에 **호스트가 센 도구 호출**을 함께 준다. 모델이 "게시했다"고 써도
        //   도구 호출이 0건이면 바깥은 그대로다 — 그 사실은 지어낼 수 없다.
        try {
          const evidenceOutput = output;
          // A host-computed graph (code/condition/transform only) has no model that could claim an
          // effect; its zero tool calls are not evidence of a false claim, so no observation is passed.
          const evidenceActivity = currentRunId && !graphIsHostComputedOnly(a.graph)
            ? structuredClone(observedToolActivity(currentRunId)) : undefined;
          const evidenceRecord = structuredClone(runRecord);
          const evidenceGoal = structuredClone(declaredGoalForAutomation(a));
          pendingClassifications.push(() => classifyInBackground({ automation: a, runId: currentRunId, phase: "outcome", sourceSignal: controller.signal,
            assertCurrent: assertGoalCurrent, classify: signal => classifyAutomationOutcome(evidenceOutput, {
              runtimeSelection: a.runtimeSelection, signal, toolActivity: evidenceActivity,
              ...(evidenceRecord.steps.length > 0 ? { runRecord: evidenceRecord } : {}), declaredGoal: evidenceGoal,
            }) }));
        } catch {
          tryRecordRunEvent({ runId: currentRunId ?? `automation-check-capture:${a.id}:${randomUUID()}`,
            automationId: a.id, kind: "automation_background_judgment_capture_pending",
            payload: { reasonCode: "automation_judgment_evidence_unavailable", pending: true, factOnly: true } });
        }
        judgmentUnavailableRun = true;
        runOutcome = "unjudged";
        runOutcomeReason = null;
        runReasonCode = "automation_judgment_pending";
        runError = null;
        // runStatus는 건드리지 않는다. 후속 정책은 아래에서 두 값을 함께 보고 정한다.
      } else {
        pendingClassifications.push(() => classifyInBackground({ automation: a, runId: currentRunId, phase: "failure", sourceSignal: controller.signal,
          assertCurrent: assertGoalCurrent, classify: signal => classifyAccountedAutomationFailure(a, currentRunId, graphError, signal) }));
        runStatus = outVals.length > 0 ? "partial" : "error";
        runOutcome = "unjudged";
        runReasonCode = "automation_judgment_pending";
        runError = graphError;

      }
    } else {
      // Unreachable: every row carries a graph by this point (synthesizeLegacyGraph above),
      // so the old direct single-prompt branch was removed. Goal-continuation settlement it
      // held now runs for every path in settleGoalContinuationRun (goal-continuation-hold.ts).
      throw new Error("automation_graph_missing");
    }
  } catch (err) {
    if (err instanceof AutomationWorkspaceError) {
      workspaceFailure = err;
      currentRunId ??= opts?.runId ?? `run-${a.id}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    }
    const rawError = err instanceof Error ? err.message : String(err);
    // 사용자에게 보여줄 문장과, 제품이 안전 판단에 쓰는 기계 표식은 같은 문자열일 수 없다.
    // 판정은 원문을 읽기 좋은 한 문장으로 **교체**하므로, 교체된 문장에서 다시 표식을 찾으면
    // 없다. 원문을 따로 붙들어 둔다.
    machineError = requiresGraphReconciliation(machineError) ? machineError : rawError;
    const loopStopped = noProgressLoop !== null && !a.graph && !controller.signal.aborted;
    const watchdogStopped = watchdogStall !== null && !controller.signal.aborted;
    let classified = workspaceFailure
      ? { status: "needs_input" as const, reasonCode: workspaceFailure.code, reason: automationWorkspaceOwnerText(workspaceFailure, currentUiLocale()) }
      : appClosedControllers.has(controller)
      ? appCloseClassification()
      : controller.signal.aborted
      ? { status: "partial" as const, reasonCode: "automation_stopped_by_user", reason: "The run was stopped. Review its recorded effects before restarting." }
      : watchdogStopped
      // 호스트가 잰 사실(무활동 시간)이다 — 판정 모델에게 묻지 않고, 사용자 중지로도 적지 않는다. 복구 경로로 간다.
      ? { status: "error" as const, reasonCode: AUTOMATION_WATCHDOG_STALL, reason: automationWatchdogOwnerText(watchdogStall!, currentUiLocale()) }
      : loopStopped
      // 판정 모델에게 묻지 않는다 — 호스트가 센 사실이고, 표식(reasonCode)이 다음 실행의 핸드오프를 연다.
      ? { status: "error" as const, reasonCode: AUTOMATION_NO_PROGRESS_LOOP, reason: noProgressLoopOwnerText(noProgressLoop!, currentUiLocale()) }
      : { status: "error" as const, reasonCode: "automation_judgment_pending", reason: rawError };
    if (!workspaceFailure && !controller.signal.aborted && !watchdogStopped && !loopStopped && !appClosedControllers.has(controller)) {
      const failedRunId = currentRunId;
      pendingClassifications.push(() => classifyInBackground({ automation: a, runId: failedRunId, phase: "failure", sourceSignal: controller.signal,
        assertCurrent: assertGoalCurrent, classify: signal => classifyAccountedAutomationFailure(a, failedRunId, rawError, signal) }));
      runOutcome = "unjudged";
    }
    // A failure judge may have yielded while Main closed or the owner stopped.
    if (appClosedControllers.has(controller)) classified = appCloseClassification();
    else if (controller.signal.aborted) classified = { status: "partial", reasonCode: "automation_stopped_by_user",
      reason: "The run was stopped. Review its recorded effects before restarting." };
    if ("judge" in classified) recordAutomationJudgeReceipt(currentRunId, a.id, "failure", classified);
    runStatus = controller.signal.aborted ? "partial" : classified.status;
    runReasonCode = classified.reasonCode ?? null;
    // Keep the graph kernel's machine gate alongside the human explanation.
    // The fresh-run UI must be able to distinguish an intentional replay
    // refusal from an unrelated failed preflight; the judgment service is
    // allowed to rewrite prose, but it must not erase this typed boundary.
    const durableGateCode = rawError.match(
      /^(automation_(?:fresh_run_blocked|ambiguous_side_effect|partial_reconciliation_required|partial_graph_changed))(?::|$)/i,
    )?.[1] ?? null;
    const classifiedReason = classified.reasonCode
      ? `[${classified.reasonCode}] ${classified.reason ?? rawError}`
      : classified.reason ?? rawError;
    runError = durableGateCode
      ? `[${durableGateCode}] ${classifiedReason}`
      : classifiedReason;
    parentMissing = isAutomationRunParentMissingError(err);
    if (!parentMissing && appClosedControllers.has(controller)) {
      if (currentRunId) tryRecordRunEvent({ runId: currentRunId, automationId: a.id,
        kind: "automation_interrupted", payload: { reasonCode: "automation_app_closed", status: runStatus } });
      console.info("[automation] run interrupted by app close");
    } else if (!parentMissing) {
      tryRecordFailureEvent({
        runId: currentRunId,
        source: "automation",
        automationId: a.id,
        errorCode: `automation_${runStatus}`,
        errorMessage: runError,
      });
      console.error(`[automation] run failed (${a.name}):`, err);
    }
  } finally {
    try {
      if (leaseHeartbeatTimer) {
        clearInterval(leaseHeartbeatTimer);
        leaseHeartbeatTimer = null;
      }
      // 스케줄 전진은 (1) trigger_type==="schedule"이고 (2) 이번 실행이 실제 예약 발사일 때만.
      // run-now·이벤트 트리거는 advanceSchedule=false로 전달돼 next_run_at을 건드리지 않는다
      // (예약 슬롯을 잡아먹거나 이벤트 자동화를 시계 스케줄로 승격하는 버그 방지).
      // run_history 기록·run_count·종료 정책은 어느 경우든 동일하게 적용한다.
      if (!leaseOwnershipLost) {
        // If the preflight attempt receipt itself could not be persisted, fail
        // closed: never replay this same occurrence automatically. A recurring
        // schedule may still reach its next natural slot; an exhausted one-shot
        // becomes disabled by markAutomationRun.
        let occurrenceAttempt = scheduledOccurrenceId && !scheduledAttemptRecorded
          ? MAX_SCHEDULE_OCCURRENCE_ATTEMPTS
          : 1;
        if (currentRunId && (!scheduledOccurrenceId || scheduledAttemptRecorded)) {
          try {
            occurrenceAttempt = countGraphRunAttemptsForRun(currentRunId);
          } catch {
            // If attempt evidence is unavailable, keep one conservative retry;
            // never pretend the circuit is open without a durable count.
            occurrenceAttempt = 1;
          }
        }
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            markAutomationRun(a.id, opts?.fireTime ?? new Date(), {
              status: runStatus,
              error: runError,
              advanceSchedule: graphLoginWait ? false : opts?.advanceSchedule ?? true,
              // 판정이 "사람 손이 필요하다"고 본 실행은 지금까지처럼 발생을 소진하지 않는다
              // (max_runs 보존). status가 ok로 남아도 이 정책은 그대로다 — 정책은 판정을 본다.
              executionConsumed: (runStatus === "ok" || runStatus === "skipped")
                && runOutcome !== "needs_input",
              finishedAt: new Date(),
              deferredRetryMs: SCHEDULE_RETRY_BASE_MS * 2 ** Math.max(0, occurrenceAttempt - 1),
              deferRetry: !graphLoginWait && occurrenceAttempt < MAX_SCHEDULE_OCCURRENCE_ATTEMPTS,
              outcome: runOutcome,
              outcomeReason: runOutcomeReason,
              suspendForReconciliation: false,
              sourceRunId: currentRunId,
              output,
            });
            runLedgerRecorded = true;
            break;
          } catch (err) {
            const busy = err && typeof err === "object" && "code" in err &&
              (err.code === "SQLITE_BUSY" || err.code === "SQLITE_LOCKED");
            if (busy && attempt < 2) {
              await new Promise<void>((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
              continue;
            }
            console.error("[automation] markAutomationRun failed:", err);
            break;
          }
        }
      }
      if (runLedgerRecorded && !parentMissing && !leaseOwnershipLost) {
        for (const startClassification of pendingClassifications) {
          try { startClassification(); } catch {
            tryRecordRunEvent({ runId: currentRunId ?? `automation-check-start:${a.id}:${randomUUID()}`,
              automationId: a.id, kind: "automation_background_judgment_capture_pending",
              payload: { reasonCode: "automation_judgment_evidence_unavailable", pending: true, factOnly: true } });
          }
        }
      }
      pendingClassifications.length = 0;
      // Scheduled Graph runs pass their durable lease, run ledger, and
      // reconciliation decision through this single shared cycle. Direct Graph
      // runs use the same module from runGraph; keeping the scheduler's guard
      // here prevents reflection from observing an uncommitted or abandoned run.
      if (!graphLoginWait && !workspaceFailure && !shutdownDispatchClosed && !controller.signal.aborted && isGraphAutomation && graphRunAttempted && runLedgerRecorded && !opts?.dryRun
        && nativeGraphSuccessNeedsReflection(a.graph, runStatus === "ok")
        && !parentMissing && !leaseOwnershipLost && currentRunId) {
        try {
          const reflectionInput = { automationId: a.id, sourceRunId: currentRunId,
            status: runStatus, outcome: runOutcome, reasonCode: runReasonCode, output: output ?? null,
            effectsUnconfirmed: requiresGraphReconciliation(machineError ?? runError),
            runError: machineError ?? runError, runtimeSelection: a.runtimeSelection };
          classifyInBackground({ automation: a, runId: currentRunId, phase: "reflection", sourceSignal: controller.signal,
            assertCurrent: assertGoalCurrent, classify: (signal, isCurrent) =>
              withAutomationJudgmentSignal(signal, () => runAutomationStrategyCycle({
                ...reflectionInput, signal, backgroundAdvisory: true, isCurrent,
              })) });
        } catch (strategyError) {
          // The Graph run is already settled and its ledger is durable. Strategy
          // review is advisory, so a temporary DB/model handoff failure cannot
          // change the execution result or lease settlement.
          console.error("[automation] strategy cycle handoff failed:", strategyError);
        }
      }
      // ── 지속 정책(P0-2): 보류는 성공이 아니다 ────────────────────────────────
      // 끝까지 돌았는데 바깥 효과가 0이고 판정이 목표 미충족으로 본 실행(자기 보류), 또는 도구 없이
      // 했다고 주장한 실행은 호스트 사실로 원인을 걸고 다음 수를 원장에 남긴다. 다음 실행이 그 수를 소비한다:
      // replan 은 계획 캡슐의 호스트 지시로, switch_runtime 은 실행 계획의 1회 핸드오프로(저장된 핀은 그대로).
      // 실측 f7a61706: 19회 중 15회가 스스로 고른 무변경 보류였고 판정은 이를 수용·판정 불가로 받았다.
      if (!graphLoginWait && !workspaceFailure && !shutdownDispatchClosed && runLedgerRecorded && !parentMissing && !leaseOwnershipLost && !opts?.dryRun && currentRunId
        && !controller.signal.aborted) {
        try {
          // 바깥 효과(게시·전송·외부 쓰기·산출물 파일)만 진전이다 — 자기 메모 수정·셸·탐색은 활동일 뿐.
          const outwardEffects = automationRunOutwardEffects(currentRunId);
          // 둘 다 호스트가 쓴 표식이다: 판정 reasonCode, 또는 그래프 커널의 노드 실패 코드.
          const claimedWithoutTools = runReasonCode === "claimed_without_tools"
            || (machineError ?? "").startsWith("[claimed_without_tools]")
            || (machineError ?? "").includes("NODE_CLAIMED_WITHOUT_TOOLS");
          const cause = outwardEffects === null ? null : automationRunSettlementCause({
            completed: runCompleted,
            outcome: runOutcome,
            reasonCode: claimedWithoutTools ? "claimed_without_tools" : runReasonCode,
            outwardEffects,
            ongoingGoal: automationServesOngoingGoal(a),
          });
          if (cause) {
            const ranOn = a.runtimeSelection;
            const pool = rolePriorityRuntimes(await detectRuntimes(), "worker");
            const switchableRuntimes = pool.filter((runtime) =>
              (runtime.backend ?? null) !== (ranOn?.backend ?? null)
              && !runtimeCooldownForSelection(selectionForRuntime(runtime))).length;
            const latest = getAutomation(a.id);
            throwIfAutomationAborted(controller);
            if (shutdownDispatchClosed) throw new Error("app_closed");
            decideAndRecordAutomationPersistence({
              automation: { id: a.id, enabled: latest?.enabled ?? a.enabled },
              runId: currentRunId,
              cause,
              switchableRuntimes,
            });
          }
        } catch (persistenceError) {
          console.warn("[automation] persistence decision unavailable:", persistenceError);
        }
      }
      // 재실행 정지는 커널이 남긴 결정론적 신호(부수효과가 반영됐는지 알 수 없음)만 보고 정한다.
      // 예전에는 여기에 runStatus(=LLM 판정 결과)까지 걸려 있었다. 판정 모델에 닿지 못하면
      // 상태가 error로 떨어져 조건이 어긋났고, 게시가 나갔는지 모르는 자동화가 다음 슬롯에
      // 그대로 다시 실행됐다 — 판정하지 못한 것이 위험한 재실행을 허용하는 근거가 될 수는 없다.
      if (workspaceFailure && !parentMissing && !leaseOwnershipLost) {
        try {
          suspendAutomationForGraphReconciliation(a.id);
          if (currentRunId) tryRecordRunEvent({ runId: currentRunId, automationId: a.id,
            kind: "automation_workspace_needs_input", payload: { reasonCode: workspaceFailure.code } });
        } catch (error) { console.error("[automation] workspace suspension failed:", error); }
      }
      if (!parentMissing && !leaseOwnershipLost && requiresGraphReconciliation(machineError ?? runError)) {
        if (currentRunId) tryRecordRunEvent({ runId: currentRunId, automationId: a.id,
          kind: "graph_effect_check_pending", payload: { reasonCode: "MUTATION_UNVERIFIED", continuation: "independent-nodes" } });
        // The kernel quarantines the uncertain node. Observation and repair run
        // separately while the automation's remaining branches stay eligible.
      }
      // Goal-continuation settlement (complete / hard stop / needs owner / backoff /
      // cadence) — one function for every path. It used to live only inside the
      // legacy branch, which no row reaches (live 2026-09-27: every-10m re-wakes).
      if (
        !graphLoginWait && !shutdownDispatchClosed && currentRunId && isStormbreakerLongRunPrompt(a.promptTemplate)
        && !parentMissing && !leaseOwnershipLost && !controller.signal.aborted
        && getAutomation(a.id)?.enabled === true
      ) {
        const continuationRunId = currentRunId;
        try {
          await withAutomationJudgmentSignal(controller.signal, () => settleGoalContinuationRun({
            automation: a,
            runId: continuationRunId,
            runStatus,
            runOutcome,
            runOutcomeReason,
            runError,
            output: output ?? null,
            signals: goalSignals,
            locale: currentUiLocale(),
          }));
        } catch (error) {
          console.error("[automation] goal continuation settlement failed:", error);
        }
      }
      // 복구 학습 — 실패 스트릭 후의 성공은 "다른 방법이 통했다"는 증거다. durable 복구
      // 이벤트 + 메모리/경험 자동 승격 + (동일 실패 2회 복구 시) 프롬프트 진화 자동 적용.
      // 어떤 실패도 런 결과에 영향을 주지 않는다(모듈 내부에서 전부 격리).
      if (
        !shutdownDispatchClosed && runStatus === "ok" && runOutcome !== "needs_input" &&
        !parentMissing && !leaseOwnershipLost &&
        priorFailureContext.streak >= 1 && currentRunId
      ) {
        try {
          recordAutomationRecovery({
            automation: a,
            runId: currentRunId,
            prior: priorFailureContext,
            output,
          });
        } catch (err) {
          console.error("[automation] recovery learning failed:", err);
        }
      }
      // 실패 피드백·수리 — run_history 기록(markAutomationRun) 이후에 호출해야
      // countConsecutiveFailures가 이번 실패를 포함한다.
      // 복구 워커는 "제품이 고칠 수 있는 것"에만 보낸다.
      //  · 판정 불가: 실행은 끝까지 갔고 우리가 결과를 못 읽었을 뿐이다.
      //  · needs_input: 사람이 결정하거나 값을 줘야 끝나는 상태다. 모델을 보내면
      //    "결과가 수용되지 않았다"는 거짓 전제로 사람만 할 수 있는 일을 시키는 셈이고,
      //    매 실행마다 호출이 한 번씩 더 나간다. 이 상태는 사용자에게 표면화하면 된다.
      // blocked·partial·error는 외부 제약 해소나 재시도로 실제로 나아질 수 있으므로 그대로 둔다.
      // 외부 mutation의 성패가 확인되지 않은 실행도 복구를 보류하지 않는다(1.2.54부터). 위에서
      // graph_effect_check_pending 사실을 남기고, 복구 사유에 "모르는 결과는 보존하고 그 미확인
      // 외부 행동은 반복하지 말라"를 항상 붙여 System Optimizer가 같은 효과를 재시도하지 않게 한다.
      if (
        (runStatus !== "ok" && runStatus !== "skipped") &&
        !shutdownDispatchClosed && !controller.signal.aborted && getAutomation(a.id)?.enabled === true &&
        !parentMissing && !leaseOwnershipLost
      ) {
        try {
          const repairReason = `${runError ?? "Result check is pending"}. Continue independent work. Inspect unresolved results in the background; preserve unknown outcomes and do not repeat the specific uncertain external actions.`;
          handleAutomationFailure(a, repairReason, currentRunId).catch((err) => {
            // Not awaited: the recovery run is background work and must not hold this run's settlement.
            console.error("[automation] handleAutomationFailure failed:", err);
          });
        } catch (err) {
          console.error("[automation] handleAutomationFailure failed:", err);
        }
      }
      if (!graphLoginWait && !parentMissing && !leaseOwnershipLost && opts?.triggerDelivery) {
        try {
          // This scheduler-level result can differ from automation_runs.status:
          // a graph may finish mechanically but classify as partial/blocked.
          opts.triggerDelivery.onCompleted(runStatus, runError);
        } catch (error) {
          // The outbox will retry sealing the receipt after runOne returns. Until
          // then a graph-only `ok` is treated as ambiguous and never replayed.
          console.error("[automation] trigger delivery completion receipt failed:", error);
        }
      }
      try {
        if (!parentMissing && !leaseOwnershipLost && currentRunId && deliverAutomationResult({
          automationId: a.id, runId: currentRunId, status: runStatus, output, error: runError, outcome: runOutcome,
          ...(typeof opts?.triggerContext?.observationDigest === "string" ? { observationDigest: opts.triggerContext.observationDigest } : {}),
          unchanged: opts?.triggerContext?.unchanged === true,
        })) {
          notifyDone(a, runStatus, runError ?? undefined);
          void notifyTelegramAutomationDone(a, runStatus, {
            error: runError,
            output,
            at: new Date().toISOString(),
          }).catch((err) => {
            console.error("[automation] telegram report failed:", err);
          });
        }
      } catch (error) { console.error("[automation] notification claim failed:", error); }
      if (currentRunId) {
        // The run ledger is authoritative; this compact Main log joins app
        // startup/shutdown with successful as well as failed scheduled ticks.
        // Never log prompt/output/account content here.
        try {
          console.info("[automation] occurrence settled", JSON.stringify({
            automationId: a.id,
            occurrenceId: scheduledOccurrenceId ?? opts?.occurrenceId ?? null,
            runId: currentRunId,
            status: runStatus,
            outcome: runOutcome,
            settlement: leaseOwnershipLost ? "lease_lost" : parentMissing ? "parent_missing"
              : runLedgerRecorded ? "recorded" : "ledger_unconfirmed",
            nextRunAt: getAutomation(a.id)?.nextRunAt ?? null,
          }));
        } catch {
          /* diagnostics must never change the run outcome or leak a lease */
        }
      }
    } finally {
      // 예약 경로에서 이 프로세스가 실제로 획득한 리스만 해제한다. Run now/이벤트 경로는
      // 리스를 얻지 않았으므로 다른 프로세스의 due 클레임을 건드리지 않는다.
      if (opts?.claim) {
        try {
          releaseAutomationRun(a.id, LEASE_OWNER);
        } catch {
          /* best-effort 리스 해제 */
        }
      }
      // Keep Stop attached through async terminal accounting, and release it
      // even if a storage adapter throws during finalization.
      if (!graphLoginWait || controller.signal.aborted) {
        graphLoginWait?.loginWaits?.forEach(wait => wait.handle.cancel());
        releaseAutomationRunStop(a.id, controller);
        activeExecutionControllers.delete(controller);
      }
      running.delete(a.id);
      if (graphLoginWait && !controller.signal.aborted) {
        // The lease and execution slot are gone before even an early restoration can fire.
        subscribeGraphLoginWait(graphLoginWait, controller, () => {
          releaseAutomationRunStop(a.id, controller); activeExecutionControllers.delete(controller);
        }, { advanceSchedule: opts?.advanceSchedule ?? true, fireTime: opts?.fireTime, triggerDelivery: opts?.triggerDelivery, allowDisabledLease: opts?.allowDisabledLease === true,
          expectedEnabled: a.enabled, stopAlreadyBound: true, afterSettled, isCurrent: () => { try { assertDefinitionCurrent(); assertGoalCurrent(); return true; } catch { return false; } } });
      }
    }
    // Durable chain fan-out은 markAutomationRun transaction에서 이미 끝났다.
    // 이 신호는 GUI outbox를 즉시 깨우는 저지연 가속일 뿐이다.
    if (!graphLoginWait && !parentMissing && !leaseOwnershipLost) {
      try {
        emitAutomationDone({
          automationId: a.id,
          ok: runStatus === "ok",
          runId: currentRunId ?? undefined,
          output,
          at: new Date().toISOString(),
        });
      } catch {
        /* best-effort */
      }
    }
  }
  // ── 완주 루프 ④: 도구 0건 성공 주장은 재실행이 안전하다 ─────────────────
  // `claimed_without_tools` 는 "외부에 어떤 부작용도 관측되지 않았다"는 호스트의
  // 사실 판정이므로, 같은 발사를 도구가 실측된 런타임으로 한 번 더 돌려도 이중
  // 게시가 구조적으로 불가능하다. 실측 배경: agy 도구 미배선 기간, 자동화가
  // "게시했다"는 소설로 12연속 accepted — 사용자는 실패 화면 대신 애초에
  // 완주된 결과를 받았어야 했다. 재시도는 1회뿐이고(표식), 스케줄은 이미
  // 전진했으므로 advanceSchedule=false, 리스는 새로 잡는다.
  if (
    !shutdownDispatchClosed && !controller.signal.aborted && getAutomation(a.id)?.enabled === true &&
    !opts?.zeroToolRetried &&
    !opts?.dryRun &&
    typeof runError === "string" &&
    runError.includes("[claimed_without_tools]")
  ) {
    // Main-owned automation pins are authoritative. A zero-tool claim is already
    // a failed exact run; retrying on the global worker pool would silently cross
    // providers (for example, Antigravity -> Claude) and make the dashboard chip
    // a lie. The original failure is durable and requires an explicit pin change.
    if (a.runtimeSelection) {
      console.error(
        `[automation] ${a.id} claimed success with zero tool calls — refusing cross-runtime retry for pinned ${a.runtimeSelection.kind}/${a.runtimeSelection.model ?? "default"}`,
      );
      return { accepted: true, automationId: a.id, runId: currentRunId, status: runStatus, error: runError, output };
    }
    // The retry must follow the dashboard's worker role. A hard-coded Claude
    // fallback made an Antigravity automation silently cross provider
    // boundaries and was indistinguishable from an accidental Claude call.
    const fallbackRuntime = rolePriorityRuntimes(await detectRuntimes(), "worker")[0] ?? null;
    if (!fallbackRuntime) {
      const retryError = "[zero_tool_retry_unavailable] no worker runtime is connected";
      console.error(`[automation] ${a.id} ${retryError}`);
      return { accepted: true, automationId: a.id, runId: currentRunId, status: "error", error: retryError, output };
    }
    const fallback: RuntimeSelection = {
      kind: fallbackRuntime.kind,
      backend: fallbackRuntime.backend,
      source: fallbackRuntime.source,
      model: fallbackRuntime.model ?? undefined,
      longContext: fallbackRuntime.longContextEnabled,
      effort: fallbackRuntime.effort ?? undefined,
    };
    // The authoritative-pin branch returned above, so this legacy retry path
    // intentionally has no saved runtime to compare against.
    const sameKind = false;
    if (!sameKind) {
      try {
        console.error(
          `[automation] ${a.id} claimed success with zero tool calls — retrying once on ${fallback.kind}/${fallback.model}`,
        );
        const retryAutomation = { ...a, runtimeSelection: fallback };
        legacyRuntimeRetries.set(retryAutomation, { storedDefinition: expectedDefinition,
          executionDefinition: definitionSnapshot(retryAutomation) });
        let retried: TriggerDispatchResult;
        try { retried = await runOne(
          retryAutomation,
          {
            claim: opts?.claim,
            advanceSchedule: false,
            allowDisabledLease: opts?.allowDisabledLease,
            triggerContext: opts?.triggerContext,
            zeroToolRetried: true,
            fresh: opts?.fresh,
          },
        ); } finally { legacyRuntimeRetries.delete(retryAutomation); }
        // ★사전 확인의 관측 기반 완결 — 재시도가 도구로 실제 완주했다면 그 사실을
        // 자동화에 영속한다. 다음 발사부터는 사후 재시도가 아니라 처음부터 검증된
        // 런타임으로 나간다(단어장·능력표 추측 없이, 이 기계에서 실측된 결과만).
        if (
          retried.accepted &&
          !(typeof retried.error === "string" && retried.error.includes("[claimed_without_tools]"))
        ) {
          try {
            updateAutomation(a.id, { runtimeSelection: fallback });
            console.error(
              `[automation] ${a.id} learned runtime ${fallback.kind}/${fallback.model} from a tool-proven retry`,
            );
          } catch (err) {
            console.error("[automation] failed to persist learned runtime:", err);
          }
        }
        return retried;
      } catch (err) {
        console.error("[automation] zero-tool retry failed:", err);
      }
    }
  }
  return { accepted: true, automationId: a.id, runId: currentRunId, status: runStatus, error: runError, output };
}

export async function runDueAutomationsNow(now: Date = new Date()): Promise<void> {
  // Public/manual/headless callers do not acquire Main timer ancestry merely
  // by invoking this API. Only tick supplies the private dispatch callback.
  return runDueAutomations(now);
}

async function runDueAutomations(
  now: Date,
  dispatch: (action: () => Promise<void>) => Promise<void> = action => action(),
): Promise<void> {
  if (dispatchPaused()) return;
  let due: Automation[];
  try {
    due = dueAutomations(now);
  } catch (err) {
    console.error("[automation] dueAutomations failed:", err);
    return;
  }
  // due-폴링 경로는 크로스프로세스 리스로 클레임(headless vs GUI 이중 실행 방지).
  await runWithConcurrency(due, MAX_CONCURRENT_AUTOMATIONS, async (a) => {
    await dispatch(async () => { await runOne(a, {
      claim: true,
      fireTime: now,
      occurrenceId: scheduledOccurrenceIdForDueRun(a),
    }); });
  });
}

/** Main-only exact restoration consumer. The source must already be durably parked. */
export function subscribeGraphLoginWait(result: RunGraphResult, controller: AbortController, onReleased: () => void = () => {}, resumeOptions?: { advanceSchedule?: boolean; fireTime?: Date; triggerDelivery?: TriggerDeliveryHooks; allowDisabledLease?: boolean; expectedEnabled?: boolean; isCurrent?: () => boolean; stopAlreadyBound?: boolean; afterSettled?: <T>(action: () => T | Promise<T>) => Promise<T> }): () => void {
  const source = result.loginWaitSource;
  const waits = result.loginWaits ?? [];
  if (!source || !result.needsInput || !getGraphLoginWaitCheckpoint(source.automationId, source.runId)) {
    waits.forEach(w => w.handle.cancel()); onReleased(); return () => {};
  }
  if (!resumeOptions?.stopAlreadyBound) {
    try {
      bindAutomationRunStop(source.automationId, controller, captureAutomationGoalExecutionOwner(source.automationId));
      activeExecutionControllers.add(controller);
    } catch {
      waits.forEach(w => w.handle.cancel()); onReleased(); return () => {};
    }
  }
  const unsubscribers: Array<() => void> = [];
  let closed = false;
  let resumeQueued = false;
  const release = (cancel: boolean) => {
    if (closed) return; closed = true;
    controller.signal.removeEventListener("abort", abort);
    unsubscribers.splice(0).forEach(fn => fn());
    // Dispose runtime custody on every handoff; only explicit cancellation revokes the durable coordinate.
    waits.forEach(w => w.handle.cancel());
    if (cancel) cancelGraphLoginWait(source.automationId, source.runId);
    releaseAutomationRunStop(source.automationId, controller);
    activeExecutionControllers.delete(controller);
    onReleased();
  };
  const abort = () => release(true);
  controller.signal.addEventListener("abort", abort, { once: true });
  if (controller.signal.aborted) { abort(); return abort; }
  for (const wait of waits) {
    const unsubscribe = wait.handle.onRestored(() => {
      if (closed || controller.signal.aborted) return;
      try {
        // Inner graph authority is restored first; parent never invents a nested source.
        const durable = getGraphLoginWaitCheckpoint(source.automationId, source.runId);
        const entry = (durable?.checkpoint as { loginWaits?: Record<string, GraphLoginWaitEntry> } | undefined)?.loginWaits?.[wait.nodeId];
        const ref = wait.handle.prerequisite;
        const exact = entry?.prerequisites.find(p => p.ref.prerequisiteId === ref.prerequisiteId && p.ref.generation === ref.generation
          && p.ref.runId === ref.runId && p.ref.chatId === ref.chatId && p.ref.nodeId === ref.nodeId && p.ref.sessionId === ref.sessionId);
        if (!exact) return;
        if (exact.sourceRunId !== source.runId) {
          const changed = restoreGraphLoginPrerequisite(exact.sourceAutomationId, exact.sourceRunId, exact.sourceNodeId, ref);
          if (!changed) {
            const inner = getGraphLoginWaitCheckpoint(exact.sourceAutomationId, exact.sourceRunId);
            const innerEntry = (inner?.checkpoint as { loginWaits?: Record<string, GraphLoginWaitEntry> } | undefined)?.loginWaits?.[exact.sourceNodeId];
            if (!innerEntry?.restored.includes(graphLoginPrerequisiteKey(ref))) return;
          }
        }
        if (!restoreGraphLoginPrerequisite(source.automationId, source.runId, wait.nodeId, ref)) return;
        if (!wait.automaticResumeSafe || !wait.handle.runtimeQuiesced) return;
        const ready = getGraphLoginWaitCheckpoint(source.automationId, source.runId);
        if (!ready || !graphLoginWaitReady((ready.checkpoint as { loginWaits: Record<string, GraphLoginWaitEntry> }).loginWaits)) return;
        if (resumeQueued || !resumeOptions?.afterSettled) return;
        resumeQueued = true;
        void resumeOptions.afterSettled(async () => {
          if (closed || controller.signal.aborted) return;
          const currentSource = getGraphLoginWaitCheckpoint(source.automationId, source.runId);
          const automation = getAutomation(source.automationId);
          if (!currentSource || !graphLoginWaitReady((currentSource.checkpoint as { loginWaits: Record<string, GraphLoginWaitEntry> }).loginWaits)
            || !automation?.graph || graphExecutionDigest(automation, automation.graph) !== source.graphDigest
            || (resumeOptions.expectedEnabled !== undefined && automation.enabled !== resumeOptions.expectedEnabled)
            || (!automation.enabled && resumeOptions.allowDisabledLease !== true)
            || (resumeOptions.isCurrent && !resumeOptions.isCurrent())) { release(false); return; }
          const admission = admitMainAutomation(automation.id);
          if (!admission) return; // An expired/nested callback cannot manufacture a new root.
          release(false);
          const lifetime = new MainInvocationLifetime(admission, automation.id, source.runId, "automation");
          await lifetime.run(() => runOne(automation, { claim: true, advanceSchedule: resumeOptions.advanceSchedule ?? false, fireTime: resumeOptions.fireTime,
            triggerDelivery: resumeOptions.triggerDelivery, allowDisabledLease: resumeOptions.allowDisabledLease === true,
            occurrenceId: source.occurrenceId, resumeLoginWaitRunId: source.runId }));
        }).catch(() => { /* Sealed waiting authority remains durable; no guessed retry. */ });
      } catch { /* no redispatch when durable restoration or ownership cannot be proven */ }
    });
    if (closed) unsubscribe(); else unsubscribers.push(unsubscribe);
  }
  return abort;
}

/** "Run now" — 스케줄 무관하게 지정 자동화를 즉시 1회 실행(enabled 여부 무시). */
export async function runAutomationNow(id: string, opts?: { dryRun?: boolean; fresh?: boolean }, mainAdmission?: MainInvocationAdmission): Promise<TriggerDispatchResult> {
  mainAdmission = takeMainInvocationAdmission(mainAdmission);
  if (shutdownDispatchClosed) throw new Error("Automation execution is closed because the app is quitting");
  if (installQuiescing) throw new Error("Automation execution is paused while an update is prepared");
  const a = getAutomation(id);
  if (!a) throw new Error(`Automation not found: ${id}`);
  // Disabled automations remain manually runnable, but still acquire the same
  // shared lease as every scheduled/headless execution.
  const freshRunId = opts?.fresh
    ? `run-${id}-${Date.now()}-${randomUUID().slice(0, 8)}`
    : undefined;
  const lifetime = new MainInvocationLifetime(mainAdmission, id, freshRunId ?? id, "automation");
  return lifetime.run(() => runOne(a, {
    claim: true,
    advanceSchedule: false,
    allowDisabledLease: true,
    ...(opts?.dryRun ? { dryRun: true } : {}),
    ...(opts?.fresh ? { fresh: true, runId: freshRunId } : {}),
  }));
}

export interface AutomationRunNowAck {
  accepted: boolean;
  automationId: string;
  runId: string | null;
  status: "queued" | "rejected";
}

/**
 * Mobile must not hold one RPC open for an entire automation. Acquire the same
 * cross-process lease synchronously, durably bind a runId, then execute in the
 * background. listRuns/live state are the result channel.
 */
export function enqueueAutomationRunNow(id: string, mainAdmission?: MainInvocationAdmission): AutomationRunNowAck {
  mainAdmission = takeMainInvocationAdmission(mainAdmission);
  if (dispatchPaused()) return { accepted: false, automationId: id, runId: null, status: "rejected" };
  const automation = getAutomation(id);
  if (!automation) throw new Error(`Automation not found: ${id}`);
  if (running.has(id)) return { accepted: false, automationId: id, runId: null, status: "rejected" };
  if (!claimAutomationRun(id, LEASE_OWNER, new Date(), { allowDisabled: true })) {
    return { accepted: false, automationId: id, runId: null, status: "rejected" };
  }
  const runId = `run-${id}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  try {
    recordRunEvent({
      runId,
      kind: "automation_run_requested",
      automationId: id,
      payload: { source: "mobile", status: "queued" },
    });
  } catch (error) {
    try { releaseAutomationRun(id, LEASE_OWNER); } catch {}
    throw error;
  }
  const lifetime = new MainInvocationLifetime(mainAdmission, id, runId, "automation");
  void lifetime.run(() => runOne(automation, {
    claim: true,
    preclaimed: true,
    runId,
    advanceSchedule: false,
    allowDisabledLease: true,
  })).catch((error) => console.error(`[automation] queued run failed (${id})`, error));
  return { accepted: true, automationId: id, runId, status: "queued" };
}

/**
 * 이벤트 트리거(fs/chain)가 발사할 때 호출 — 지정 자동화를 즉시 1회 실행한다.
 * 트리거 매니저에 주입되는 RunFn. due/Run now와 같은 리스를 획득해 중복 실행을 막는다.
 */
export async function runAutomationFromTrigger(
  id: string,
  ctx: TriggerEventPayload = {},
  triggerDelivery?: TriggerDeliveryHooks,
): Promise<TriggerDispatchResult> {
  if (dispatchPaused()) return { accepted: false };
  const a = getAutomation(id);
  if (!a) return { accepted: false };
  const command = decodeGraphCommandDelivery(a, ctx,
    ctx.source === "one-mcp" || ctx.source === "toolchain" ? automationDefinitionDigest(a) : undefined);
  if (command && !command.ok) return { accepted: false, status: "blocked", error: command.code };
  // Withdrawing a Toolchain or editing its automation stops calls already queued.
  if (command?.ok && ctx.source === "toolchain" && !callableContractFor(a.id)) {
    return { accepted: false, status: "blocked", error: "toolchain_not_callable" };
  }
  if (command?.ok && (ctx.source === "one-mcp" || ctx.source === "toolchain")) {
    try { validateOneGraphCommandScope(a); }
    catch (error) { return { accepted: false, status: "blocked", error: error instanceof Error ? error.message : "one_graph_scope_invalid" }; }
  }
  if (command?.ok) return runOne(a, { claim: true, advanceSchedule: false, triggerDelivery,
    triggerContext: command.input, ...(command.dryRun ? { dryRun: true } : {}) });
  return runOne(a, { claim: true, advanceSchedule: false, triggerDelivery, triggerContext: ctx });
}

/** Poll timeout is attention, not an inferred model result. Its durable event
 * survives restart and uses the same notification attempt dedupe as executions. */
async function notifyPendingMonitorAttention(): Promise<void> {
  const rows = getDb().prepare(`SELECT e.run_id, e.automation_id, e.payload_json FROM run_events e JOIN automations a ON a.id = e.automation_id AND a.enabled = 1
    WHERE e.kind = 'automation_monitor_attention' AND NOT EXISTS (
      SELECT 1 FROM run_events n WHERE n.run_id = e.run_id AND n.kind IN ('automation_notification_attempt', 'automation_notification_suppressed'))
    ORDER BY e.rowid ASC LIMIT 100`).all() as Array<{ run_id: string; automation_id: string; payload_json: string }>;
  for (const row of rows) {
    const automation = getAutomation(row.automation_id);
    if (!automation?.enabled) continue;
    const data = JSON.parse(row.payload_json) as { reason?: string };
    const error = data.reason === "monitor_deadline_reached" ? "Monitoring deadline reached; the requested change was not confirmed."
      : data.reason === "monitor_observation_unavailable" ? "The monitored source is unavailable. Check its connection or access."
      : data.reason?.startsWith("monitor_invocation_") ? `The monitored task ${data.reason.slice("monitor_invocation_".length)}. Open the task to review it.`
      : "The monitored source could not be checked. Review its connection or access.";
    if (!claimAutomationNotification({ automationId: automation.id, runId: row.run_id, status: "blocked", error })) continue;
    notifyDone(automation, "blocked", error);
    await notifyTelegramAutomationDone(automation, "blocked", { error, output: "", at: new Date().toISOString() });
  }
}

function tick(): void {
  if (dispatchPaused()) return;
  // A GUI and the optional headless runner may share this DB. Recovery only
  // closes snapshots that have been silent beyond the scheduler's absolute
  // active-tool ceiling; recent progress from either process keeps a run live.
  try {
    recoverStaleAutomationRuns();
  } catch (err) {
    // Recovery runs with busy_timeout 0 on purpose (a tick must not hold Main for 15 s), so a locked store is the
    // expected outcome of contention and is retried next tick. Logged as one line: 23 full stacks in a day buried
    // real errors in app.log (2026-09-27).
    if ((err as { code?: string } | null)?.code === "SQLITE_BUSY") console.warn("[automation] stale run recovery skipped: store busy; retrying next tick");
    else console.error("[automation] stale run recovery failed:", err);
  }
  try {
    for (const recovered of recoverReadOnlySuspendedGraphs()) {
      if (!recovered.resumeRequired || recovered.eventStatus !== null) continue;
      void runAutomationNow(recovered.automationId, undefined, admitMainAutomation(recovered.automationId))
        .catch((error) => console.error(`[automation] read-only graph resume failed (${recovered.automationId}):`, error));
    }
  } catch (err) {
    console.error("[automation] read-only graph recovery failed:", err);
  }
  try {
    recoverGraphScheduleCursors();
  } catch (err) {
    console.error("[automation] graph schedule recovery failed:", err);
  }
  try {
    sweepAutomationEffectObservations(automationObservationRuntime);
  } catch (err) {
    console.error("[automation] effect observation sweep failed:", err);
  }
  void runDueAutomations(new Date(), withMainScheduledRoot)
    .catch(error => console.error("[automation] scheduled dispatch failed:", error));
  // Goal subscriptions have their own ledger and the Main invocation dispatcher.
  // Reuse this timer only; they are never converted into automation jobs.
  void pollGoalWaitSubscriptions().catch(error => console.error("[goal-wait] observation failed:", error));
  // 폴 트리거 구동(설계 §3.3) — 새 타이머 없이 같은 60초 틱에 얹는다. nextPollAt<=now인
  // poll 자동화만 검사(적응형 간격). 매니저 미기동(헤드리스 등)이면 no-op.
  void (async () => {
    try {
      const { pollTick } = await import("./triggers/manager");
      await pollTick();
      await notifyPendingMonitorAttention();
    } catch {
      /* 매니저 미기동이면 무시 */
    }
  })();
}

export function startAutomationScheduler(): void {
  if (dispatchPaused() || timer) return;
  timer = setInterval(tick, 60_000);
  if (timer.unref) timer.unref();
  // 시작 직후 1회 점검 — 앱이 꺼져 있던 동안 놓친 due를 한 번 따라잡는다(누적 폭주 방지: markRun이 다음 미래로 전진).
  startupTimer = setTimeout(() => {
    startupTimer = null;
    tick();
  }, 5_000);
  startupTimer.unref?.();
}

/**
 * Quit only: close dispatch permanently for this process, then stop the timers. Unlike the update
 * quiesce this is never reopened — the next process starts its own scheduler.
 */
export function closeAutomationDispatchForShutdown(): void {
  shutdownDispatchClosed = true;
  for (const controller of [...activeExecutionControllers, ...optimizerControllers.values()]) {
    if (controller.signal.aborted) continue; // Preserve an earlier owner stop.
    appClosedControllers.add(controller);
    controller.abort(new Error("app_closed"));
  }
  stopAutomationScheduler();
}

/**
 * Automation work that can still write to the store: graph runs, System Optimizer runs and
 * read-only effect observations. Quit waits for this to reach zero (bounded) before closeStore(),
 * so an interrupted run records its own outcome instead of losing it to "Store not initialized".
 */
export function automationWorkInFlight(): number {
  return running.size + optimizerControllers.size + optimizerProviderPromises.size + automationObservationsInFlight();
}

function stopAutomationTimers(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
}

export function stopAutomationScheduler(): void {
  stopAutomationTimers();
  // 앱 종료/스케줄러 정지 시 보조 진단 런도 즉시 취소한다. runner가 신호를 무시해도
  // abortGate가 lifecycle을 settle하므로 optimizer 슬롯과 watchdog timer가 남지 않는다.
  for (const controller of optimizerControllers.values()) {
    if (!controller.signal.aborted) {
      controller.abort(new Error("System Optimizer cancelled because scheduler stopped"));
    }
  }
}

/**
 * Freeze new automation dispatch and wait for current DB-writing lifecycles to
 * finish before updater continuity is captured. A busy automation is not
 * cancelled or consumed; the install attempt fails closed and can be retried.
 */
export async function quiesceAutomationSchedulerForUpdate(
  timeoutMs = 45_000,
): Promise<() => void> {
  restartSchedulerAfterInstall ||= timer !== null || startupTimer !== null;
  installQuiesceHolds += 1;
  installQuiescing = true;
  // Installing pauses admission, not the active worker or its external action.
  // stopAutomationScheduler also aborts optimizer workers and is reserved for Quit.
  stopAutomationTimers();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    installQuiesceHolds -= 1;
    if (installQuiesceHolds > 0) return;
    installQuiescing = false;
    const restart = restartSchedulerAfterInstall;
    restartSchedulerAfterInstall = false;
    if (restart) startAutomationScheduler();
  };
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (automationWorkInFlight() > 0) {
    if (Date.now() >= deadline) {
      release();
      throw new Error("automation_update_drain_timed_out");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return release;
}
