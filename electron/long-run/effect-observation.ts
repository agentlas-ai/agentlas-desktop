/**
 * 묻기 전에 직접 본다 — 오너 지시 2026-09-23.
 *
 * "게시됐는지 왜 모르지 브라우저 보면 알잖아… 다른 작업도 마찬가지임 직접 보면 알잖아
 *  One이 직접 보면 알텐데 새로고침하던지 해서."
 *
 * 끊긴 시도가 바깥에 이미 무언가를 했는지 앱이 모를 때(목표가 효과 불확실로 멈춤), 사람에게
 * "확인하고 이어가세요"를 묻기 전에 같은 대화에서 **읽기 전용 관찰 실행**을 한 번 띄운다.
 * 그 실행은 페이지를 열거나 새로고침하고, 최근 게시물·메시지 목록을 보고, 답 끝에 고정 표식
 * 한 줄로 판정을 낸다(shared/effect-observation.ts). 판정은 표식에서만 읽는다 — 산문은 읽지 않는다.
 *
 *   done     → 시도 묶음을 "관찰로 정리됨"으로 원장에 적고(사람 확인과 다른 증명 종류), 다시 하지 않고
 *              다음 작업부터 이어간다.
 *   not_done → 같은 기록을 남기고 이어가되, 다음 턴은 그 작업을 새로 다시 해도 된다.
 *   unknown / 표식 없음 / 실행 실패·시간 초과 → 오늘의 동작(사람의 한 문장 재개)으로 돌아간다.
 *                                               옛 시도를 조용히 재실행하는 길은 없다.
 *
 * 경계:
 *  - 읽기 전용은 프롬프트가 아니라 Main 이 강제한다: 요청은 permissions "read"(One 은
 *    onePermissionMode "read" 까지)로만 만들어지고, 실행기(InvocationService)가 관찰 표가 붙은
 *    실행에서 그 값을 다시 대조하며 권한 승격 칩도 끈다.
 *  - 한 시도 집합(다이제스트)당 관찰은 평생 한 번이다: 띄우기 **전에** 원장에 dispatched 기록을
 *    남기므로 재시작·재호출에도 두 번 뜨지 않는다. 결과가 모름이면 사람에게 넘기고 끝난다 — 고리 없음.
 *  - 시간 상한은 실행기가 건다(EFFECT_OBSERVATION_TIME_LIMIT_MS).
 */
import { createHash, randomUUID } from "node:crypto";
import type { McpInvocationRequest } from "../../shared/types";
import { EFFECT_OBSERVATION_MARKER, parseEffectObservationMarker, type ParsedEffectObservation } from "../../shared/effect-observation";
import { GOAL_RESUME_EFFECT_BOUNDARY_UNCERTAIN, isClaimedWaitRecoveryBlocker } from "../../shared/long-run";
import { getDb } from "../store/db";
import { appendChatMessage, getChat } from "../store/chats";
import { findAutomationByGoalId, getAutomation, toggleAutomation } from "../store/automations";
import { getOrCreateAutomationSession } from "../store/automation-sessions";
import { getAutomationEffectHold, reconcileAutomationGraph } from "../store/graph-reconciliation";
import { recordRunEvent, tryRecordRunEvent } from "../store/run-events";
import type {
  Automation, AutomationGraphReconciliation, AutomationGraphReconciliationDecision, AutomationGraphReconcileResult,
} from "../../shared/types";
import {
  appendLongRunEvent, getLongRun, getLongRunAttemptReview, getLongRunByGoalId, settleUncertainAttemptsByObservation,
  nextBlockedGoalRetrySlot, pendingBlockedGoalRetry, scheduleBlockedGoalRetry,
  transitionLongRun, unsettledLongRunAttempts, EFFECT_OBSERVATION_EVENT_KIND, type LongRunAttemptReview,
} from "../store/long-runs";
import { automaticGoalResumeRequest } from "../invocation/automatic-goal";
import { confirmDesktopLongRunResumeDispatched, desktopAppInstanceId, failDesktopLongRunResumeDispatch } from "./app-runtime-coordinator";
import { currentUiLocale } from "../ui-locale";
import {
  effectObservationTicket, registerEffectObservationTicket, takeEffectObservationTicket, isGoalObserving,
  markGoalObserving, isAutomationObserving, markAutomationObserving, automationObservationRuntime,
  registerAutomationObservationRuntime, type AutomationObservationRuntime,
  type EffectObservationDispatcher, type EffectObservationTicket,
} from "./effect-observation-tickets";

export {
  effectObservationTicket, registerAutomationObservationRuntime,
  type AutomationObservationRuntime, type EffectObservationDispatcher, type EffectObservationTicket,
};

export const EFFECT_OBSERVATION_TIME_LIMIT_MS = 5 * 60_000;
/** 한 번의 관찰 프롬프트에 싣는 시도 수 상한 — 넘으면 관찰하지 않고 사람에게 둔다. */
export const MAX_OBSERVED_ATTEMPTS = 20;

/** 시도 행 없이 효과 경계만 불확실할 수 있는 사유 — 마지막 실행을 관찰 대상으로 삼는다.
 * 재시작 효과 경계 불확실은 시도가 모두 정리돼 있어도 쓰였다(진단 workspace_changed 등). 예전엔 여기서
 * no_uncertain_attempts 로 빠지고 사람의 재개도 거절돼 영원히 막혔다(실측 2026-09-23, 설치본 DB). */
const BOUNDARY_BLOCK_REASONS = new Set<string>([
  "checkpoint_side_effects_uncertain", "goal_wait_effects_uncertain", GOAL_RESUME_EFFECT_BOUNDARY_UNCERTAIN,
  "goal_wait_claimed_dispatch_uncertain", "goal_wait_claimed_binding_changed",
]);

/** 시도 행이 없는 경계 관찰의 정리 기록(감사용). 새 시도가 그 사이 생겼으면 거절한다. */
function settleBoundaryByObservation(longRunId: string, ticket: EffectObservationTicket,
  verdict: "done" | "not_done", evidence: string): { version: number } {
  if (getLongRunAttemptReview(longRunId).attemptIds.length) throw new Error("effect_observation_attempt_set_changed");
  appendLongRunEvent({ runId: longRunId, kind: EFFECT_OBSERVATION_EVENT_KIND, actorKind: "host",
    payload: { action: "settle_boundary", targetIds: [...ticket.attemptIds], verdict,
      evidence: evidence.replace(/\s+/g, " ").trim().slice(0, 500),
      observationInvocationRunId: ticket.observationRunId, observationDigest: ticket.digest,
      externalOutcomeProof: "observed_read_only_by_model" } });
  const version = getLongRun(longRunId)?.version;
  if (typeof version !== "number") throw new Error(`long_run_not_found:${longRunId}`);
  return { version };
}

/** 효과 불확실로 멈춘 사유들. 다른 사유로 멈춘 목표도 불확실한 시도가 남아 있으면 그 시도를 본다
 * (observableBlockedRun) — 그 시도가 재개를 막는 유일한 이유이기 때문이다. */
const OBSERVABLE_BLOCK_REASONS = new Set<string>([
  "checkpoint_side_effects_uncertain",
  "goal_wait_effects_uncertain",
  "auto_goal_resume_attempt_unsettled",
  GOAL_RESUME_EFFECT_BOUNDARY_UNCERTAIN,
  "goal_wait_claimed_dispatch_uncertain",
  "goal_wait_claimed_binding_changed",
]);

/** Blocked on an effect question: an uncertain-effect reason, or any blocker with unsettled attempts. */
export function observableBlockedRun(run: { id: string; status: string; blockedReason: string | null }): boolean {
  if (run.status !== "blocked") return false;
  if (OBSERVABLE_BLOCK_REASONS.has(run.blockedReason ?? "")) return true;
  try { return getLongRunAttemptReview(run.id).attempts.length > 0; } catch { return false; }
}

/** Whether this blocker is itself a statement that an external effect is unknown. */
export function isEffectUncertainBlockReason(reason: string | null | undefined): boolean {
  return OBSERVABLE_BLOCK_REASONS.has(reason ?? "") || isClaimedWaitRecoveryBlocker(reason);
}

/**
 * 관찰이 답을 못 냈을 때(모름·실패·시간 초과·정리 실패) 목표를 'blocked' 에도, 사람을 기다리는 일시정지에도
 * 두지 않는다 — 오너 지시 2026-09-23 "블락되는거 전부다 치워라", 정정 "눌러서 이어가는게 결국 멈춘거 아닌가".
 * 앱이 스스로 다시 볼 시각(백오프)을 원장에 적고(scheduleBlockedGoalRetry), 그 시각에 스윕이 새 관찰
 * 회차(epoch)로 다시 본다. 옛 시도를 조용히 재실행하는 길은 여전히 없다 — 재개는 관찰의 판정으로만 열린다.
 */
/**
 * 같은 시도 묶음을 몇 번까지 모델로 볼 것인가 — 오너 실측 2026-09-24.
 *
 * 관찰 한 번은 전체 모델 실행(격리 앱 176k~500k 입력 토큰)인데, 모름으로 끝나면 백오프(5분→…→6시간)로
 * 끝없이 다시 봤다(설치본 1.2.41: 26/26 모름, 개발 사본: 29/29). 세 번 봐도 모르면 자동 재관찰을 멈추고
 * 기계 코드(effect_observation_exhausted)와 함께 오너에게 넘긴다 — 막다른 길이 아니다: 목표 칩의 이어가기(인지 후 재개)는
 * "먼저 읽기 전용으로 확인하고, 확인 전엔 반복하지 말 것" 지시로 이어지고, 대화에 한 문장을 보내도 이어진다.
 */
export const MAX_INCONCLUSIVE_OBSERVATIONS = 3;
export const EFFECT_OBSERVATION_EXHAUSTED = "effect_observation_exhausted";

/** Inconclusive looks already spent on exactly this target set (every epoch counts). Only looks whose
 * verdict was read from the runner's raw final text count — the looks before that fix could never
 * return a verdict, and an upgraded install must still get its readable looks. */
export function inconclusiveObservationCount(longRunId: string, targetIds: readonly string[]): number {
  const ids = JSON.stringify([...targetIds].sort());
  const rows = getDb().prepare(
    `SELECT d.payload_json AS dispatched FROM long_run_events AS i
       JOIN long_run_events AS d ON d.run_id = i.run_id AND d.kind = i.kind
        AND json_extract(d.payload_json, '$.action') = 'dispatched'
        AND json_extract(d.payload_json, '$.observationDigest') = json_extract(i.payload_json, '$.observationDigest')
      WHERE i.run_id = ? AND i.kind = ? AND json_extract(i.payload_json, '$.action') = 'inconclusive'
        AND json_extract(i.payload_json, '$.markerSource') = 'runner-final'`,
  ).all(longRunId, EFFECT_OBSERVATION_EVENT_KIND) as Array<{ dispatched: string }>;
  let count = 0;
  for (const row of rows) {
    try {
      const attemptIds = (JSON.parse(row.dispatched) as { attemptIds?: unknown }).attemptIds;
      if (Array.isArray(attemptIds) && JSON.stringify([...attemptIds].map(String).sort()) === ids) count += 1;
    } catch { /* unreadable receipt is not counted */ }
  }
  return count;
}

function observationExhausted(longRunId: string, targetIds: readonly string[]): boolean {
  return Boolean(getDb().prepare(
    `SELECT 1 FROM long_run_events WHERE run_id = ? AND kind = ?
       AND json_extract(payload_json, '$.action') = ? AND json_extract(payload_json, '$.targetSet') = ? LIMIT 1`,
  ).get(longRunId, EFFECT_OBSERVATION_EVENT_KIND, "exhausted", JSON.stringify([...targetIds].sort())));
}

/** Returns true when the cap was reached and the automatic re-observation was stopped (owner-visible). */
function stopObservingWhenExhausted(longRunId: string, targetIds: readonly string[], detail: string): boolean {
  try {
    if (inconclusiveObservationCount(longRunId, targetIds) < MAX_INCONCLUSIVE_OBSERVATIONS) return false;
    if (observationExhausted(longRunId, targetIds)) return true;
    appendLongRunEvent({ runId: longRunId, kind: EFFECT_OBSERVATION_EVENT_KIND, actorKind: "host",
      payload: { action: "exhausted", code: EFFECT_OBSERVATION_EXHAUSTED, targetSet: JSON.stringify([...targetIds].sort()),
        looks: MAX_INCONCLUSIVE_OBSERVATIONS, lastReason: detail.slice(0, 120) } });
    return true;
  } catch (error) {
    console.warn("[effect-observation] exhaustion receipt failed:", error);
    return false;
  }
}

function scheduleObservationRetry(longRunId: string, detail: string, targetIds?: readonly string[]): void {
  try {
    const current = getLongRun(longRunId);
    if (!current || current.status !== "blocked" || current.surface === "science") return;
    if (targetIds && stopObservingWhenExhausted(longRunId, targetIds, detail)) return;
    const slot = nextBlockedGoalRetrySlot(current.id);
    scheduleBlockedGoalRetry({ runId: current.id, expectedVersion: current.version, kind: "observe",
      fromReason: current.blockedReason, retryIndex: slot.retryIndex, nextAt: slot.nextAt, detail,
      trigger: "effect-observation", effectUncertain: true, appInstanceId: desktopAppInstanceId() });
  } catch (error) {
    console.warn("[effect-observation] retry scheduling after inconclusive observation failed:", error);
  }
}

/** A resume the observation authorized could not be dispatched: try the dispatch again later instead of a pause. */
function scheduleResumeRetryAfterDispatchFailure(longRunId: string, detail: string): void {
  try {
    const current = getLongRun(longRunId);
    if (!current || current.surface === "science") return;
    const slot = nextBlockedGoalRetrySlot(current.id);
    scheduleBlockedGoalRetry({ runId: current.id, expectedVersion: current.version, kind: "resume",
      fromReason: "invocation_failed", retryIndex: slot.retryIndex, nextAt: slot.nextAt, detail,
      trigger: "dispatch-failed:effect-observation", effectUncertain: false, appInstanceId: desktopAppInstanceId() });
  } catch (error) {
    console.warn("[effect-observation] resume retry scheduling failed:", error);
  }
}

export function effectObservationDigest(longRunId: string, attemptIds: readonly string[], epoch = 0): string {
  // Epoch 0 keeps the original digest; a scheduled re-observation (epoch n) is a new look at the same set.
  return `sha256:${createHash("sha256").update(JSON.stringify({ longRunId, attemptIds: [...attemptIds].sort(),
    ...(epoch > 0 ? { epoch } : {}) })).digest("hex")}`;
}

function alreadyObserved(longRunId: string, digest: string): boolean {
  return Boolean(getDb().prepare(
    `SELECT 1 FROM long_run_events WHERE run_id = ? AND kind = ?
       AND json_extract(payload_json, '$.action') = 'dispatched'
       AND json_extract(payload_json, '$.observationDigest') = ? LIMIT 1`,
  ).get(longRunId, EFFECT_OBSERVATION_EVENT_KIND, digest));
}

/** URL 은 호스트·경로만 — 쿼리·인증 정보는 토큰일 수 있어 싣지 않는다. */
function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/u.test(url.protocol)) return null;
    return `${url.origin}${url.pathname}`.slice(0, 200);
  } catch { return null; }
}

/** 시도가 하려던 일을 기록된 도구 사건에서 짧게 뽑는다 — 도구 이름·대상 URL·결과 앞부분만. */
function attemptActivity(invocationRunId: string | null): string[] {
  if (!invocationRunId) return [];
  const rows = getDb().prepare(
    "SELECT payload_json FROM run_events WHERE run_id = ? AND kind = 'mcp_tool-use' ORDER BY seq DESC LIMIT 8",
  ).all(invocationRunId) as Array<{ payload_json: string }>;
  const lines: string[] = [];
  for (const row of rows.reverse()) {
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(row.payload_json) as Record<string, unknown>; } catch { continue; }
    const tool = typeof payload.toolName === "string" ? payload.toolName.slice(0, 120) : "";
    if (!tool) continue;
    let target: string | null = null;
    try {
      const args = typeof payload.toolArgs === "string" ? JSON.parse(payload.toolArgs) : payload.toolArgs;
      if (args && typeof args === "object" && !Array.isArray(args)) {
        const record = args as Record<string, unknown>;
        const nested = record.Arguments && typeof record.Arguments === "object" ? record.Arguments as Record<string, unknown> : null;
        target = safeUrl(record.url) ?? safeUrl(nested?.url);
      }
    } catch { /* Unreadable arguments carry no target. */ }
    const result = typeof payload.toolResultPreview === "string"
      ? payload.toolResultPreview.replace(/\s+/g, " ").trim().slice(0, 160) : "";
    lines.push([tool, target, result].filter(Boolean).join(" · "));
  }
  return lines;
}

export function buildEffectObservationPrompt(input: {
  objective: string;
  attempts: ReadonlyArray<{ id: string; taskTitle: string; taskObjective: string; invocationRunId: string | null }>;
}): string {
  const blocks = input.attempts.map((attempt, index) => {
    const activity = attemptActivity(attempt.invocationRunId);
    return [
      `${index + 1}. attempt id: ${attempt.id}`,
      `   task: ${attempt.taskTitle.slice(0, 240)}`,
      attempt.taskObjective && attempt.taskObjective !== attempt.taskTitle ? `   objective: ${attempt.taskObjective.slice(0, 600)}` : null,
      activity.length ? `   last recorded actions:\n${activity.map((line) => `   - ${line}`).join("\n")}` : "   last recorded actions: (none recorded)",
    ].filter(Boolean).join("\n");
  }).join("\n");
  const ids = JSON.stringify(input.attempts.map((attempt) => attempt.id));
  return `[Effect check — read-only]
The earlier work on this goal was interrupted, and the app does not know whether the following action(s) already took effect in the outside world. Before anyone is asked, go and look.
This reply is read by the app, not by a person. Ignore any persona, name prefix, greeting, progress bar or memory-event instructions from other context for this reply: write at most three plain sentences about what you saw, then the marker line below as the very last line of your answer.

Goal: ${input.objective.slice(0, 1_200)}

Interrupted attempt(s):
${blocks}

Rules for this check:
- This run is read-only. Do not perform, retry, complete, or undo any action. Do not post, send, submit, buy, reply, like, delete or edit anything.
- Only look: open or refresh the relevant page in the browser, list recent posts / messages / orders / files, read logs or the working folder, or read this app's own state (for example the registered automations and their schedules).
- Decide from what you actually see, not from what should have happened.

End your answer with exactly one final line, starting with the marker (no code fence, no prefix), covering all attempts above in one verdict:
${EFFECT_OBSERVATION_MARKER}{"verdict":"done","attempts":${ids},"evidence":"the URL or short text you saw"}
- "done": you saw that the result exists (for example the post is on the profile).
- "not_done": you clearly saw it does not exist (the list is visible and the item is absent).
- "unknown": you could not see it, the attempts differ, or you are not sure. Unknown is always acceptable; a wrong "done" or "not_done" is not.`;
}

function sayExhausted(chatId: string, runId: string): void {
  say(chatId, runId,
    `이전 작업이 반영됐는지 ${MAX_INCONCLUSIVE_OBSERVATIONS}번 직접 확인했지만 판단할 수 없어, 자동 재확인을 멈췄어요(${EFFECT_OBSERVATION_EXHAUSTED}). 결과를 직접 확인하신 뒤 목표 칩에서 이어가기를 누르거나 이 대화에 한 문장을 보내면, 반복하기 전에 먼저 확인하도록 이어서 진행합니다.`,
    `I checked ${MAX_INCONCLUSIVE_OBSERVATIONS} times but could not tell whether the earlier action went through, so automatic re-checks stopped (${EFFECT_OBSERVATION_EXHAUSTED}). Check the result, then press Continue on the goal chip or send one sentence here; the goal resumes and verifies before repeating anything.`);
}

function say(chatId: string, runId: string, ko: string, en: string): void {
  try {
    appendChatMessage(chatId, "assistant", currentUiLocale() === "ko" ? ko : en, { hostNotice: { purpose: "goal-continuation", runId } });
  } catch (error) {
    console.warn("[effect-observation] chat notice failed:", error);
  }
}

/**
 * Why an observation could not look, as a machine code read from the run's own typed events
 * (never from prose). Returns null when the browser was reachable or never needed.
 *   effect_observation_browser_unavailable:<code> — the tool connection could not be prepared,
 *   or every agentlas-browser call the model made was refused / failed.
 * The caller still schedules the same automatic re-observation; this only names the cause.
 */
export function observationBrowserUnavailableCode(observationRunId: string): string | null {
  try {
    const rows = getDb().prepare(
      `SELECT kind, payload_json FROM run_events WHERE run_id = ?
         AND kind IN ('mcp_config_failure', 'mcp_tool-use', 'browser_binding') ORDER BY seq LIMIT 400`,
    ).all(observationRunId) as Array<{ kind: string; payload_json: string }>;
    let refused: string | null = null;
    let succeeded = false;
    for (const row of rows) {
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(row.payload_json) as Record<string, unknown>; } catch { continue; }
      if (row.kind === "mcp_config_failure") {
        const code = typeof payload.reasonCode === "string" ? payload.reasonCode : "mcp-runtime-config-unavailable";
        return `effect_observation_browser_unavailable:${code}`.slice(0, 120);
      }
      if (row.kind !== "mcp_tool-use" || typeof payload.toolName !== "string" || !payload.toolName.startsWith("agentlas-browser.")) continue;
      if (payload.toolIsError === true) {
        refused ??= typeof payload.toolFailureCode === "string" && /^[a-z0-9_.-]{1,64}$/i.test(payload.toolFailureCode)
          ? payload.toolFailureCode : "tool_failed";
      } else if (payload.toolIsError === false && typeof payload.toolResultPreview === "string") {
        succeeded = true;
      }
    }
    return refused && !succeeded ? `effect_observation_browser_unavailable:${refused}`.slice(0, 120) : null;
  } catch {
    return null;
  }
}

export type EffectObservationDispatchResult =
  | { status: "dispatched"; runId: string }
  | { status: "skipped"; reason: string };

/**
 * 효과 불확실로 멈춘 목표 하나에 관찰을 띄운다(조건이 안 맞으면 아무것도 하지 않는다).
 * 여러 자리(체크포인트 차단 직후·재시작 차단 직후·목표 칩 조회)에서 불러도 안전하다 —
 * 다이제스트당 한 번만 뜬다.
 */
export function maybeDispatchEffectObservation(
  dispatcher: EffectObservationDispatcher, goalId: string, trigger: string, options: { epoch?: number } = {},
): EffectObservationDispatchResult {
  const epoch = Number.isSafeInteger(options.epoch) && (options.epoch ?? 0) > 0 ? options.epoch! : 0;
  if (isGoalObserving(goalId)) return { status: "skipped", reason: "in_flight" };
  const run = getLongRunByGoalId(goalId);
  if (!run || run.surface === "science") return { status: "skipped", reason: "not_observable_surface" };
  if (!observableBlockedRun(run)) {
    return { status: "skipped", reason: "not_blocked_on_uncertain_effects" };
  }
  const chatId = run.rootChatId;
  const chat = chatId ? getChat(chatId) : null;
  if (!chatId || !chat || chat.goalId !== goalId) return { status: "skipped", reason: "chat_binding_changed" };
  // 자동화가 이어받는 목표는 자동화의 브라우저 프로필·세션에서 본다(오너의 Threads 사례) —
  // 같은 관찰 한 번이 자동화 보류 단계와 이 목표의 불확실한 시도를 함께 정리한다.
  const continuation = findAutomationByGoalId(goalId);
  if (continuation) {
    const runtime = automationObservationRuntime();
    if (!runtime) return { status: "skipped", reason: "automation_runtime_unavailable" };
    return maybeDispatchAutomationEffectObservation(runtime, continuation.id, trigger, { epoch });
  }
  if (dispatcher.activeChatIds().includes(chatId)) return { status: "skipped", reason: "chat_busy" };
  const review = getLongRunAttemptReview(run.id);
  if (review.attempts.some((attempt) => attempt.state === "running")) return { status: "skipped", reason: "attempt_running" };
  if (review.attempts.length > MAX_OBSERVED_ATTEMPTS) return { status: "skipped", reason: "too_many_attempts" };
  let kind: EffectObservationTicket["kind"] = "attempts";
  let targets: Array<{ id: string; taskTitle: string; taskObjective: string; invocationRunId: string | null }> = review.attempts;
  if (!targets.length) {
    // 시도 행이 없는 효과 경계 불확실 — 마지막 실행이 바깥에 무엇을 했는지 한 번 본다.
    if (!BOUNDARY_BLOCK_REASONS.has(run.blockedReason ?? "")) return { status: "skipped", reason: "no_uncertain_attempts" };
    const last = getDb().prepare(
      "SELECT run_id FROM run_events WHERE chat_id = ? AND kind = 'invoke_started' ORDER BY rowid DESC LIMIT 1",
    ).get(chatId) as { run_id: string } | undefined;
    if (!last) return { status: "skipped", reason: "no_uncertain_attempts" };
    kind = "boundary";
    targets = [{ id: `invocation:${last.run_id}`, taskTitle: run.objective.slice(0, 240), taskObjective: "", invocationRunId: last.run_id }];
  }
  const targetIds = targets.map((target) => target.id);
  if (observationExhausted(run.id, targetIds)) return { status: "skipped", reason: EFFECT_OBSERVATION_EXHAUSTED };
  const digest = effectObservationDigest(run.id, targetIds, epoch);
  if (alreadyObserved(run.id, digest)) return { status: "skipped", reason: "already_observed" };
  const observationRunId = randomUUID();
  const request: McpInvocationRequest = {
    chatId, runId: observationRunId, promptOrigin: "system", taskIntent: "task", permissions: "read",
    ...(chat.originSurface === "one" ? { oneMode: true, onePermissionMode: "read" as const } : {}),
    userPrompt: buildEffectObservationPrompt({ objective: run.objective, attempts: targets }),
  };
  // 띄우기 전에 원장에 남긴다 — 이 뒤에 무엇이 죽어도 같은 집합을 두 번 관찰하지 않는다.
  appendLongRunEvent({ runId: run.id, kind: EFFECT_OBSERVATION_EVENT_KIND, actorKind: "host",
    payload: { action: "dispatched", observationDigest: digest, observationInvocationRunId: observationRunId,
      attemptIds: targetIds, targetKind: kind, trigger: trigger.slice(0, 80), permission: "read" } });
  const needsBrowser = targets.some((target) => attemptActivity(target.invocationRunId)
    .some((line) => /browser|https?:\/\//i.test(line)));
  const ticket: EffectObservationTicket = Object.freeze({ observationRunId, goalId, longRunId: run.id, chatId,
    attemptIds: Object.freeze([...targetIds]), digest, surface: run.surface, kind, needsBrowser, dispatcher });
  registerEffectObservationTicket(ticket);
  markGoalObserving(goalId, true);
  say(chatId, observationRunId, "이전 작업이 반영됐는지 확인하는 중…", "Checking whether the earlier action went through…");
  try {
    const started = dispatcher.start(request, undefined, undefined, undefined, "goal-continuation");
    if (started.runId !== observationRunId) throw new Error("effect_observation_dispatch_identity_mismatch");
    return { status: "dispatched", runId: observationRunId };
  } catch (error) {
    takeEffectObservationTicket(observationRunId);
    markGoalObserving(goalId, false);
    const reason = error instanceof Error ? error.message.slice(0, 120) : "effect_observation_dispatch_failed";
    recordInconclusive(ticket, reason, "not_started");
    return { status: "skipped", reason };
  }
}

function recordInconclusive(ticket: EffectObservationTicket, reason: string,
  copy: "unknown" | "not_started" | { observed: "done" | "not_done" } = "unknown"): void {
  try {
    appendLongRunEvent({ runId: ticket.longRunId, kind: EFFECT_OBSERVATION_EVENT_KIND, actorKind: "host",
      payload: { action: "inconclusive", observationDigest: ticket.digest, markerSource: "runner-final",
        observationInvocationRunId: ticket.observationRunId, reason,
        ...(typeof copy === "object" ? { observedVerdict: copy.observed } : {}) } });
  } catch (error) {
    console.warn("[effect-observation] inconclusive receipt failed:", error);
  }
  scheduleObservationRetry(ticket.longRunId, reason, ticket.attemptIds);
  if (observationExhausted(ticket.longRunId, ticket.attemptIds)) {
    sayExhausted(ticket.chatId, ticket.observationRunId);
    return;
  }
  const retryKo = "잠시 뒤 앱이 스스로 다시 확인하고, 확인되는 대로 이어갑니다.";
  const retryEn = "The app will look again shortly on its own and continue as soon as it can tell.";
  if (copy === "not_started") {
    say(ticket.chatId, ticket.observationRunId, `이전 작업을 지금은 확인하지 못했어요. ${retryKo}`,
      `I could not start checking the earlier action right now. ${retryEn}`);
  } else if (typeof copy === "object") {
    say(ticket.chatId, ticket.observationRunId,
      `확인해 보니 이전 작업은 ${copy.observed === "done" ? "이미 반영돼 있었어요" : "반영되지 않았어요"}. 다만 지금 바로 이어가지 못했어요. ${retryKo}`,
      `Checked: the earlier action ${copy.observed === "done" ? "already went through" : "did not go through"}, but the goal could not continue right away. ${retryEn}`);
  } else {
    say(ticket.chatId, ticket.observationRunId, `직접 확인했지만 이전 작업이 반영됐는지 알 수 없었어요. ${retryKo}`,
      `I looked, but could not tell whether the earlier action went through. ${retryEn}`);
  }
}

export type EffectObservationOutcome =
  | { outcome: "resumed"; verdict: "done" | "not_done"; resumeRunId: string }
  | { outcome: "fallback"; reason: string };

/**
 * 관찰 실행이 끝난 뒤 실행기가 부른다(대화가 비워진 뒤). 표식 판정만 본다.
 * 모름·무효·실패는 사람에게 넘기고, done/not_done 은 원장에 정리한 뒤 다음 작업을 이어간다.
 */
export function completeEffectObservation(input: {
  runId: string;
  parsed: ParsedEffectObservation | null;
  aborted: boolean;
  failed: boolean;
}): EffectObservationOutcome | null {
  const ticket = takeEffectObservationTicket(input.runId);
  if (!ticket) return null;
  markGoalObserving(ticket.goalId, false);
  const fallback = (reason: string): EffectObservationOutcome => {
    // A look that never reached the browser is not "unknown": name the machine cause so the
    // scheduled re-observation (not a human) is visibly waiting on browser availability.
    const cause = reason === "effect_observation_marker_missing" || reason === "effect_observation_unknown"
      || reason === "effect_observation_run_failed" ? observationBrowserUnavailableCode(ticket.observationRunId) : null;
    recordInconclusive(ticket, cause ?? reason);
    return { outcome: "fallback", reason: cause ?? reason };
  };
  if (input.aborted) return fallback("effect_observation_aborted");
  if (input.failed) return fallback("effect_observation_run_failed");
  const parsed = input.parsed ?? { status: "absent" as const };
  if (parsed.status === "absent") return fallback("effect_observation_marker_missing");
  if (parsed.status === "invalid") return fallback(parsed.reason);
  const report = parsed.report;
  if (report.verdict === "unknown") return fallback("effect_observation_unknown");
  // 방어: 파싱 단계에서 이미 대조했지만, 표가 가리키는 집합과 다시 한 번 맞춘다.
  if (JSON.stringify([...report.attemptIds].sort()) !== JSON.stringify([...ticket.attemptIds].sort())) {
    return fallback("effect_observation_attempts_mismatch");
  }
  const verdict = report.verdict;
  let prepared: { request: McpInvocationRequest; queuedId: string } | null = null;
  try {
    prepared = getDb().transaction(() => {
      const current = getLongRun(ticket.longRunId);
      if (!current || current.goalId !== ticket.goalId || current.status !== "blocked"
        || (!OBSERVABLE_BLOCK_REASONS.has(current.blockedReason ?? "") && ticket.kind !== "attempts")) throw new Error("effect_observation_goal_state_changed");
      if (getChat(ticket.chatId)?.goalId !== ticket.goalId) throw new Error("goal_control_binding_changed");
      if (findAutomationByGoalId(ticket.goalId)) throw new Error("effect_observation_automation_continuation");
      const settled = ticket.kind === "boundary"
        ? settleBoundaryByObservation(current.id, ticket, verdict, report.evidence)
        : settleUncertainAttemptsByObservation(current.id, { attemptIds: ticket.attemptIds, verdict,
          evidence: report.evidence, observationInvocationRunId: ticket.observationRunId, observationDigest: ticket.digest });
      const request = automaticGoalResumeRequest(ticket.chatId, settled.version, "host", { verdict, evidence: report.evidence });
      if (!request) throw new Error("long_run_resume_dispatch_unavailable");
      getDb().prepare("UPDATE chat_goal_contracts SET status = 'active', completed_at = NULL, updated_at = ? WHERE goal_id = ? AND status = 'blocked'")
        .run(new Date().toISOString(), ticket.goalId);
      const queued = transitionLongRun({ runId: current.id, to: "queued", actorKind: "host",
        reason: "effect-observation-resume", appInstanceId: desktopAppInstanceId(), expectedVersion: settled.version });
      return { request: { ...request, runId: randomUUID() }, queuedId: queued.id };
    })();
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 120) : "effect_observation_settle_failed";
    recordInconclusive(ticket, reason, { observed: verdict });
    return { outcome: "fallback", reason };
  }
  say(ticket.chatId, ticket.observationRunId,
    verdict === "done"
      ? "확인해 보니 이전 작업은 이미 반영돼 있었어요. 다시 하지 않고 다음 작업을 이어갑니다."
      : "확인해 보니 이전 작업은 반영되지 않았어요. 다시 시도하며 이어갑니다.",
    verdict === "done"
      ? "Checked: the earlier action already went through. Continuing with the next step without redoing it."
      : "Checked: the earlier action did not go through. Continuing and trying it again.");
  try {
    const started = ticket.dispatcher.start(prepared.request, undefined, undefined, undefined, "goal-continuation");
    confirmDesktopLongRunResumeDispatched(prepared.queuedId);
    return { outcome: "resumed", verdict, resumeRunId: started.runId };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try { failDesktopLongRunResumeDispatch(prepared.queuedId, reason); } catch { /* keep the dispatch failure */ }
    scheduleResumeRetryAfterDispatchFailure(prepared.queuedId, reason.slice(0, 120));
    return { outcome: "fallback", reason: reason.slice(0, 120) };
  }
}

/** 실행기 싱크용 — 원문 final 텍스트에서 표식을 읽는다(지우기 전에). */
export function readEffectObservationFromFinal(runId: string, text: string): ParsedEffectObservation | null {
  const ticket = effectObservationTicket(runId);
  if (!ticket) return null;
  return parseEffectObservationMarker(text, ticket.attemptIds);
}

// ─────────────────────────────────────────────────────────────────────────────
// 자동화 경로 — 사용자 대화 없이 자동화 자신의 세션·브라우저 프로필로 본다.
//
// 자동화가 automation_ambiguous_side_effect / fresh_run_blocked 로 보류된 것은 그래프 체크포인트의
// "모호한 단계"다. 같은 표식 계약으로 한 번 보고:
//   done     → 그 단계들을 reconcileAutomationGraph 로 completed. produces 를 선언한 단계는 표식이
//              outputs 에 그 단계의 산출 텍스트를 **명시적으로** 준 경우에만 — 없으면 보류를 그대로 둔다
//              (산출물을 지어내지 않는다).
//   not_done → retry (다시 해도 된다).
//   unknown  → 보류 유지, 오늘의 화면(사람의 재조정)으로 돌아간다.
// 이 자동화가 목표를 이어받고 있으면 그 목표의 불확실한 시도도 같은 판정으로 정리하고 목표를 푼다.
// ─────────────────────────────────────────────────────────────────────────────

export const AUTOMATION_EFFECT_OBSERVATION_EVENT_KIND = "automation_effect_observation";

export function automationEffectObservationDigest(input: {
  automationId: string; runId: string | null; occurrenceId: string | null; checkpointDigest: string | null; ids: readonly string[];
  epoch?: number;
}): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({ ...input, ids: [...input.ids].sort() })).digest("hex")}`;
}

function automationAlreadyObserved(automationId: string, digest: string): boolean {
  return Boolean(getDb().prepare(
    `SELECT 1 FROM run_events WHERE automation_id = ? AND kind = ?
       AND json_extract(payload_json, '$.action') = 'dispatched'
       AND json_extract(payload_json, '$.observationDigest') = ? LIMIT 1`,
  ).get(automationId, AUTOMATION_EFFECT_OBSERVATION_EVENT_KIND, digest));
}

/**
 * ★목표 없는 자동화 보류는 "모름" 한 번으로 영원히 멈췄다.
 *
 *   실측 2026-09-23 (Threads 자동화 f7a61706): 13:56Z 관찰이 앱 재시작으로 끊겨
 *   inconclusive(effect_observation_marker_missing) 로 끝났다. 목표에 묶인 보류는
 *   scheduleObservationRetry 가 다시 볼 시각을 적지만, 목표 없는 자동화에는 그 길이 없었고
 *   다이제스트당 한 번 규칙이 두 번째 관찰을 막았다 — 다음 실행 시각(nextRunAt)은 null 로
 *   남아, 사람이 다른 일로 자동화를 고치기 전까지 아무도 다시 보지 않았다.
 *
 *   같은 보류를 회차(epoch)로 다시 본다: 앞 회차가 inconclusive 이거나, 끝 기록 없이
 *   관찰 시간 상한을 넘겼을 때만. 간격은 10·20·40·80분, 최대 4회차 — 무한 관찰은 없다.
 *   관찰은 여전히 읽기 전용이고, 재개는 관찰의 판정으로만 열린다.
 */
const AUTOMATION_OBSERVATION_MAX_EPOCH = 4;
const AUTOMATION_OBSERVATION_RETRY_BASE_MS = 10 * 60_000;

function automationObservationHistory(automationId: string, digest: string): { dispatchedAt: number | null; actions: string[] } {
  const rows = getDb().prepare(
    `SELECT ts, json_extract(payload_json, '$.action') AS action FROM run_events
      WHERE automation_id = ? AND kind = ? AND json_extract(payload_json, '$.observationDigest') = ?
      ORDER BY ts ASC LIMIT 20`,
  ).all(automationId, AUTOMATION_EFFECT_OBSERVATION_EVENT_KIND, digest) as Array<{ ts: string; action: string | null }>;
  const dispatched = rows.find((row) => row.action === "dispatched");
  const at = dispatched ? Date.parse(dispatched.ts) : NaN;
  return { dispatchedAt: Number.isFinite(at) ? at : null, actions: rows.map((row) => String(row.action ?? "")) };
}

/** Next re-observation epoch for an automation-only hold, or why none is due. */
export function nextAutomationObservationEpoch(
  automationId: string,
  digestFor: (epoch: number) => string,
  now = Date.now(),
): { epoch: number } | { skip: string } {
  for (let epoch = 1; epoch <= AUTOMATION_OBSERVATION_MAX_EPOCH; epoch += 1) {
    const previous = automationObservationHistory(automationId, digestFor(epoch - 1));
    if (automationAlreadyObserved(automationId, digestFor(epoch))) continue;
    if (previous.actions.includes("settled")) return { skip: "already_observed" };
    const lookedWithoutAnswer = previous.actions.includes("inconclusive")
      || (previous.dispatchedAt !== null && now - previous.dispatchedAt > EFFECT_OBSERVATION_TIME_LIMIT_MS + 60_000);
    if (!lookedWithoutAnswer) return { skip: "already_observed" };
    const dueAt = (previous.dispatchedAt ?? 0) + AUTOMATION_OBSERVATION_RETRY_BASE_MS * 2 ** (epoch - 1);
    if (now < dueAt) return { skip: "observation_retry_not_due" };
    return { epoch };
  }
  return { skip: "observation_retry_exhausted" };
}

function nodeActivity(runId: string, nodeId: string): string[] {
  const rows = getDb().prepare(
    "SELECT payload_json FROM run_events WHERE run_id = ? AND node_id = ? AND kind = 'mcp_tool-use' ORDER BY seq DESC LIMIT 8",
  ).all(runId, nodeId) as Array<{ payload_json: string }>;
  return rows.reverse().map((row) => {
    try {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      const tool = typeof payload.toolName === "string" ? payload.toolName.slice(0, 120) : "";
      let target: string | null = null;
      try {
        const args = typeof payload.toolArgs === "string" ? JSON.parse(payload.toolArgs) : payload.toolArgs;
        if (args && typeof args === "object" && !Array.isArray(args)) target = safeUrl((args as Record<string, unknown>).url);
      } catch { /* no target */ }
      const result = typeof payload.toolResultPreview === "string" ? payload.toolResultPreview.replace(/\s+/g, " ").trim().slice(0, 160) : "";
      return [tool, target, result].filter(Boolean).join(" · ");
    } catch { return ""; }
  }).filter(Boolean);
}

interface AutomationObservationPlan {
  automation: Automation;
  hold: AutomationGraphReconciliation | null;
  goal: { goalId: string; longRunId: string; chatId: string | null; attempts: LongRunAttemptReview["attempts"] } | null;
  ids: string[];
  digest: string;
}

function planAutomationObservation(runtime: AutomationObservationRuntime, automationId: string, epoch = 0):
  { plan: AutomationObservationPlan } | { skip: string } {
  if (isAutomationObserving(automationId)) return { skip: "in_flight" };
  const automation = getAutomation(automationId);
  if (!automation) return { skip: "automation_missing" };
  if (runtime.isAutomationRunning(automationId)) return { skip: "automation_running" };
  let hold: AutomationGraphReconciliation | null = null;
  try { hold = getAutomationEffectHold(automationId); } catch { hold = null; }
  if (hold?.simulation) hold = null;
  let goal: AutomationObservationPlan["goal"] = null;
  if (automation.goalId) {
    if (isGoalObserving(automation.goalId)) return { skip: "in_flight" };
    const run = getLongRunByGoalId(automation.goalId);
    // The Goal's own scheduled re-observation owns the next look at its attempts and this hold together.
    if (run && pendingBlockedGoalRetry(run.id)) return { skip: "goal_retry_scheduled" };
    if (run && run.surface !== "science" && observableBlockedRun(run)) {
      const review = getLongRunAttemptReview(run.id);
      if (review.attempts.some((attempt) => attempt.state === "running")) return { skip: "attempt_running" };
      goal = { goalId: run.goalId, longRunId: run.id, chatId: run.rootChatId, attempts: review.attempts };
    }
  }
  const ids = [...(hold?.nodes.map((node) => `node:${node.nodeId}`) ?? []), ...(goal?.attempts.map((attempt) => attempt.id) ?? [])];
  if (!ids.length && !goal) return { skip: "nothing_to_observe" };
  if (!ids.length) return { skip: "no_uncertain_attempts" };
  if (ids.length > MAX_OBSERVED_ATTEMPTS) return { skip: "too_many_attempts" };
  const digestFor = (value: number): string => automationEffectObservationDigest({ automationId, runId: hold?.runId ?? null,
    occurrenceId: hold?.occurrenceId ?? null, checkpointDigest: hold?.checkpointDigest ?? null, ids,
    ...(value > 0 ? { epoch: value } : {}) });
  let digest = digestFor(epoch);
  if (automationAlreadyObserved(automationId, digest)) {
    // A Goal-bound hold has its own re-observation schedule (scheduleObservationRetry).
    if (epoch !== 0 || goal || !hold) return { skip: "already_observed" };
    const retry = nextAutomationObservationEpoch(automationId, digestFor);
    if ("skip" in retry) return retry;
    digest = digestFor(retry.epoch);
  }
  return { plan: { automation, hold, goal, ids, digest } };
}

export function buildAutomationEffectObservationPrompt(plan: AutomationObservationPlan): string {
  const { automation, hold, goal } = plan;
  const graph = automation.graph && automation.graph.nodes.length ? automation.graph : null;
  const steps = (hold?.nodes ?? []).map((node, index) => {
    const config = graph?.nodes.find((candidate) => candidate.id === node.nodeId)?.config ?? {};
    const prompt = typeof config.prompt === "string" ? config.prompt : node.nodeId === "n1" && !graph ? automation.promptTemplate : "";
    const activity = hold ? nodeActivity(hold.runId, node.nodeId) : [];
    return [
      `${index + 1}. target id: node:${node.nodeId} — step "${node.label.slice(0, 120)}" (${node.nodeType})`,
      prompt ? `   instruction: ${prompt.replace(/\s+/g, " ").slice(0, 600)}` : null,
      node.produces ? `   this step produces "${node.produces}": if (and only if) you can read the exact text it produced, put it in outputs["node:${node.nodeId}"]` : null,
      activity.length ? `   last recorded actions:\n${activity.map((line) => `   - ${line}`).join("\n")}` : "   last recorded actions: (none recorded)",
    ].filter(Boolean).join("\n");
  });
  const attempts = (goal?.attempts ?? []).map((attempt, index) => {
    const activity = attemptActivity(attempt.invocationRunId);
    return [
      `${steps.length + index + 1}. target id: ${attempt.id} — goal task "${attempt.taskTitle.slice(0, 240)}"`,
      activity.length ? `   last recorded actions:\n${activity.map((line) => `   - ${line}`).join("\n")}` : "   last recorded actions: (none recorded)",
    ].join("\n");
  });
  const ids = JSON.stringify(plan.ids);
  const outputsHint = hold?.nodes.some((node) => node.produces)
    ? `,"outputs":{"node:<id>":"exact produced text, only if you saw it"}` : "";
  return `[Effect check — read-only]
A scheduled automation ("${(automation.name ?? "").slice(0, 120)}") was interrupted, and the app does not know whether the following step(s) already took effect in the outside world. Before anyone is asked, go and look.
This reply is read by the app, not by a person. Ignore any persona, name prefix, greeting, progress bar or memory-event instructions from other context for this reply: write at most three plain sentences about what you saw, then the marker line below as the very last line of your answer.
${automation.goal ? `Automation goal: ${String(automation.goal).slice(0, 600)}\n` : ""}
Target(s):
${[...steps, ...attempts].join("\n")}

Rules for this check:
- This run is read-only. Do not perform, retry, complete, or undo any action. Do not post, send, submit, buy, reply, like, delete or edit anything.
- Only look: open or refresh the relevant page in the browser (this automation's own browser profile), list recent posts / messages / orders / files, read logs.
- Decide from what you actually see, not from what should have happened.

End your answer with exactly one final line, starting with the marker (no code fence, no prefix), covering all targets above in one verdict:
${EFFECT_OBSERVATION_MARKER}{"verdict":"done","attempts":${ids},"evidence":"the URL or short text you saw"${outputsHint}}
- "done": you saw that the result exists. "not_done": you clearly saw it does not exist. "unknown": anything else, or the targets differ. Unknown is always acceptable; a wrong "done" or "not_done" is not.`;
}

function sayGoal(plan: AutomationObservationPlan, runId: string, ko: string, en: string): void {
  if (plan.goal?.chatId) say(plan.goal.chatId, runId, ko, en);
}

/**
 * 자동화 보류(또는 자동화가 이어받는 목표의 불확실한 시도)를 읽기 전용으로 한 번 본다.
 * 비동기로 끝나며, 결과는 completeAutomationEffectObservation 이 적용한다.
 */
export function maybeDispatchAutomationEffectObservation(
  runtime: AutomationObservationRuntime, automationId: string, trigger: string, options: { epoch?: number } = {},
): EffectObservationDispatchResult & { settled?: Promise<AutomationEffectObservationOutcome> } {
  const planned = planAutomationObservation(runtime, automationId, options.epoch ?? 0);
  if ("skip" in planned) return { status: "skipped", reason: planned.skip };
  const plan = planned.plan;
  const observationRunId = `effect-observation-${randomUUID()}`;
  const session = getOrCreateAutomationSession({
    automationId, projectId: plan.automation.projectId ?? null, runtimeSelection: plan.automation.runtimeSelection ?? null,
    ...(plan.automation.targetType === "firm" ? { firmId: plan.automation.targetId }
      : plan.automation.targetType === "agent" ? { agentId: plan.automation.targetId } : {}),
  });
  // Main 이 만드는 읽기 전용 요청 — 권한은 여기서만 정해지고 바깥 입력이 없다.
  const request: McpInvocationRequest = {
    runId: observationRunId, chatId: session.chat.id, automationId, promptOrigin: "system", taskIntent: "task",
    permissions: "read", userPrompt: buildAutomationEffectObservationPrompt(plan),
    runtimeSelection: plan.automation.runtimeSelection, mcpBrowserProfileKey: `automation-${automationId}`,
    toolMode: plan.automation.toolMode ?? "auto",
  };
  if (request.permissions !== "read") throw new Error("effect_observation_must_be_read_only");
  recordRunEvent({ runId: plan.hold?.runId ?? observationRunId, kind: AUTOMATION_EFFECT_OBSERVATION_EVENT_KIND, automationId,
    payload: { action: "dispatched", observationDigest: plan.digest, observationInvocationRunId: observationRunId,
      targetIds: plan.ids, goalId: plan.goal?.goalId ?? null, trigger: trigger.slice(0, 80), permission: "read" } });
  if (plan.goal) {
    appendLongRunEvent({ runId: plan.goal.longRunId, kind: EFFECT_OBSERVATION_EVENT_KIND, actorKind: "host",
      payload: { action: "dispatched", observationDigest: plan.digest, observationInvocationRunId: observationRunId,
        attemptIds: plan.goal.attempts.map((attempt) => attempt.id), automationId, trigger: trigger.slice(0, 80), permission: "read" } });
    markGoalObserving(plan.goal.goalId, true);
  }
  markAutomationObserving(automationId, true);
  sayGoal(plan, observationRunId, "이전 작업이 반영됐는지 확인하는 중…", "Checking whether the earlier action went through…");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("effect_observation_time_budget")), EFFECT_OBSERVATION_TIME_LIMIT_MS);
  const settled = Promise.resolve()
    .then(() => runtime.runHeadless(automationId, request, controller.signal))
    .then((result) => ({ parsed: parseEffectObservationMarker(result.finalText ?? "", plan.ids), failed: false }),
      () => ({ parsed: null, failed: true }))
    .then(({ parsed, failed }) => completeAutomationEffectObservation({ runtime, plan, observationRunId, parsed,
      aborted: controller.signal.aborted, failed }))
    .catch((error: unknown): AutomationEffectObservationOutcome => {
      console.warn("[effect-observation] automation completion failed:", error);
      return { outcome: "fallback", reason: "effect_observation_completion_failed" };
    })
    .finally(() => {
      clearTimeout(timer);
      markAutomationObserving(automationId, false);
      if (plan.goal) markGoalObserving(plan.goal.goalId, false);
    });
  return { status: "dispatched", runId: observationRunId, settled };
}

export type AutomationEffectObservationOutcome =
  | { outcome: "reconciled"; verdict: "done" | "not_done"; reconciled: boolean; goalResumed: boolean; enqueued: boolean }
  | { outcome: "fallback"; reason: string };

function completeAutomationEffectObservation(input: {
  runtime: AutomationObservationRuntime; plan: AutomationObservationPlan; observationRunId: string;
  parsed: ParsedEffectObservation | null; aborted: boolean; failed: boolean;
}): AutomationEffectObservationOutcome {
  const { plan, runtime, observationRunId } = input;
  const automationId = plan.automation.id;
  const record = (payload: Record<string, unknown>): void => {
    tryRecordRunEvent({ runId: plan.hold?.runId ?? observationRunId, kind: AUTOMATION_EFFECT_OBSERVATION_EVENT_KIND,
      automationId, payload: { observationDigest: plan.digest, observationInvocationRunId: observationRunId, ...payload } });
  };
  const fallback = (rawReason: string, observed?: "done" | "not_done"): AutomationEffectObservationOutcome => {
    const reason = !observed && (rawReason === "effect_observation_marker_missing" || rawReason === "effect_observation_unknown"
      || rawReason === "effect_observation_run_failed")
      ? observationBrowserUnavailableCode(observationRunId) ?? rawReason : rawReason;
    record({ action: "inconclusive", reason, ...(observed ? { observedVerdict: observed } : {}) });
    if (plan.goal) {
      try {
        appendLongRunEvent({ runId: plan.goal.longRunId, kind: EFFECT_OBSERVATION_EVENT_KIND, actorKind: "host",
          payload: { action: "inconclusive", observationDigest: plan.digest, observationInvocationRunId: observationRunId, reason,
            markerSource: "runner-final" } });
      } catch { /* the automation receipt above is the durable record */ }
      scheduleObservationRetry(plan.goal.longRunId, reason, plan.goal.attempts.map((attempt) => attempt.id));
      if (observationExhausted(plan.goal.longRunId, plan.goal.attempts.map((attempt) => attempt.id)) && plan.goal.chatId) {
        sayExhausted(plan.goal.chatId, observationRunId);
        return { outcome: "fallback", reason: EFFECT_OBSERVATION_EXHAUSTED };
      }
    }
    sayGoal(plan, observationRunId,
      observed
        ? `확인해 보니 이전 작업은 ${observed === "done" ? "이미 반영돼 있었어요" : "반영되지 않았어요"}. 다만 지금 바로 이어가지 못했어요. 잠시 뒤 앱이 스스로 다시 확인하고 이어갑니다.`
        : "직접 확인했지만 이전 작업이 반영됐는지 알 수 없었어요. 잠시 뒤 앱이 스스로 다시 확인하고, 확인되는 대로 이어갑니다.",
      observed
        ? `Checked: the earlier action ${observed === "done" ? "already went through" : "did not go through"}, but it could not continue right away. The app will look again shortly on its own.`
        : "I looked, but could not tell whether the earlier action went through. The app will look again shortly on its own and continue as soon as it can tell.");
    return { outcome: "fallback", reason };
  };
  if (input.aborted) return fallback("effect_observation_aborted");
  if (input.failed) return fallback("effect_observation_run_failed");
  const parsed = input.parsed ?? { status: "absent" as const };
  if (parsed.status === "absent") return fallback("effect_observation_marker_missing");
  if (parsed.status === "invalid") return fallback(parsed.reason);
  const report = parsed.report;
  if (report.verdict === "unknown") return fallback("effect_observation_unknown");
  const verdict = report.verdict;
  let decisions: AutomationGraphReconciliationDecision[] = [];
  if (plan.hold) {
    for (const node of plan.hold.nodes) {
      if (verdict === "not_done") { decisions.push({ nodeId: node.nodeId, resolution: "retry" }); continue; }
      const output = report.outputs[`node:${node.nodeId}`];
      // 산출물을 선언한 단계는 관찰이 그 텍스트를 명시적으로 준 경우에만 완료로 닫는다.
      if (node.produces && !output?.trim()) return fallback(`effect_observation_output_missing:${node.nodeId}`, verdict);
      decisions.push({ nodeId: node.nodeId, resolution: "completed", ...(node.produces ? { output } : {}) });
    }
  }
  let result: { reconciled: AutomationGraphReconcileResult | null; queuedId: string | null } | null = null;
  try {
    result = getDb().transaction(() => {
      const reconciled = plan.hold ? reconcileAutomationGraph({
        automationId, runId: plan.hold.runId, occurrenceId: plan.hold.occurrenceId,
        graphDigest: plan.hold.graphDigest, checkpointDigest: plan.hold.checkpointDigest,
        expectedUpdatedAt: plan.hold.updatedAt,
        ...(plan.hold.triggerEvent ? { eventId: plan.hold.triggerEvent.id, expectedEventUpdatedAt: plan.hold.triggerEvent.updatedAt } : {}),
        decisions,
      }) : null;
      let queuedId: string | null = null;
      if (plan.goal) {
        const current = getLongRun(plan.goal.longRunId);
        if (!current || current.status !== "blocked"
          || (!OBSERVABLE_BLOCK_REASONS.has(current.blockedReason ?? "") && !plan.goal.attempts.length)) {
          throw new Error("effect_observation_goal_state_changed");
        }
        if (plan.goal.attempts.length) {
          settleUncertainAttemptsByObservation(current.id, { attemptIds: plan.goal.attempts.map((attempt) => attempt.id), verdict,
            evidence: report.evidence, observationInvocationRunId: observationRunId, observationDigest: plan.digest });
        }
        if (unsettledLongRunAttempts(current.id).length) throw new Error("auto_goal_resume_attempt_unsettled");
        const version = getLongRun(current.id)!.version;
        getDb().prepare("UPDATE chat_goal_contracts SET status = 'active', completed_at = NULL, updated_at = ? WHERE goal_id = ? AND status = 'blocked'")
          .run(new Date().toISOString(), current.goalId);
        queuedId = transitionLongRun({ runId: current.id, to: "queued", actorKind: "host",
          reason: "effect-observation-resume", appInstanceId: desktopAppInstanceId(), expectedVersion: version }).id;
      }
      record({ action: "settled", verdict, evidence: report.evidence,
        completedNodeIds: reconciled?.completedNodeIds ?? [], retryNodeIds: reconciled?.retryNodeIds ?? [] });
      return { reconciled, queuedId };
    })();
  } catch (error) {
    return fallback(error instanceof Error ? error.message.slice(0, 120) : "effect_observation_settle_failed", verdict);
  }
  // done 이고 모든 단계가 닫혔으면 새로 돌리지 않는다 — 복원된 일정이 다음 주기를 맡는다.
  // not_done·재개가 필요한 보류·목표의 다음 단계는 지금 이어간다.
  if (plan.goal && !getAutomation(automationId)?.enabled) toggleAutomation(automationId, true);
  const shouldEnqueue = verdict === "not_done" || Boolean(result.reconciled?.resumeRequired) || !plan.hold;
  let enqueued = false;
  if (shouldEnqueue) {
    try { enqueued = runtime.enqueueRun(automationId); } catch { enqueued = false; }
  }
  let goalResumed = false;
  if (result.queuedId) {
    try {
      if (shouldEnqueue && !enqueued) {
        failDesktopLongRunResumeDispatch(result.queuedId, "long_run_resume_dispatch_rejected");
        scheduleResumeRetryAfterDispatchFailure(result.queuedId, "long_run_resume_dispatch_rejected");
      } else { confirmDesktopLongRunResumeDispatched(result.queuedId); goalResumed = true; }
    } catch (error) {
      console.warn("[effect-observation] goal resume transition failed:", error);
    }
  }
  sayGoal(plan, observationRunId,
    verdict === "done"
      ? "확인해 보니 이전 작업은 이미 반영돼 있었어요. 다시 하지 않고 다음 작업을 이어갑니다."
      : "확인해 보니 이전 작업은 반영되지 않았어요. 다시 시도하며 이어갑니다.",
    verdict === "done"
      ? "Checked: the earlier action already went through. Continuing with the next step without redoing it."
      : "Checked: the earlier action did not go through. Continuing and trying it again.");
  return { outcome: "reconciled", verdict, reconciled: Boolean(result.reconciled), goalResumed, enqueued };
}

/** 스케줄러 틱이 부른다 — 보류된 자동화와 막힌 목표를 이어받는 자동화를 훑는다(다이제스트당 한 번). */
export function sweepAutomationEffectObservations(runtime: AutomationObservationRuntime): EffectObservationDispatchResult[] {
  const rows = getDb().prepare(
    `SELECT a.id FROM automations AS a
     WHERE (SELECT r.status FROM automation_runs AS r WHERE r.automation_id = a.id
             ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1) = 'error'
        OR (a.goal_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM long_runs AS l WHERE l.goal_id = a.goal_id AND l.status = 'blocked'))
     LIMIT 50`,
  ).all() as Array<{ id: string }>;
  const results: EffectObservationDispatchResult[] = [];
  for (const row of rows) {
    try {
      const outcome = maybeDispatchAutomationEffectObservation(runtime, row.id, "scheduler-tick");
      if (outcome.status === "dispatched") results.push({ status: outcome.status, runId: outcome.runId });
    } catch (error) {
      console.warn(`[effect-observation] automation sweep skipped (${row.id}):`, error);
    }
  }
  return results;
}
