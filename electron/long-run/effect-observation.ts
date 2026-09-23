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
import { GOAL_RESUME_EFFECT_BOUNDARY_UNCERTAIN } from "../../shared/long-run";
import { getDb } from "../store/db";
import { appendChatMessage, getChat } from "../store/chats";
import { findAutomationByGoalId } from "../store/automations";
import {
  appendLongRunEvent, getLongRun, getLongRunAttemptReview, getLongRunByGoalId, settleUncertainAttemptsByObservation,
  transitionLongRun, EFFECT_OBSERVATION_EVENT_KIND,
} from "../store/long-runs";
import { automaticGoalResumeRequest } from "../invocation/automatic-goal";
import { confirmDesktopLongRunResumeDispatched, desktopAppInstanceId, failDesktopLongRunResumeDispatch } from "./app-runtime-coordinator";
import { currentUiLocale } from "../ui-locale";
import {
  effectObservationTicket, registerEffectObservationTicket, takeEffectObservationTicket,
  type EffectObservationDispatcher, type EffectObservationTicket,
} from "./effect-observation-tickets";

export { effectObservationTicket, type EffectObservationDispatcher, type EffectObservationTicket };

export const EFFECT_OBSERVATION_TIME_LIMIT_MS = 5 * 60_000;
/** 한 번의 관찰 프롬프트에 싣는 시도 수 상한 — 넘으면 관찰하지 않고 사람에게 둔다. */
export const MAX_OBSERVED_ATTEMPTS = 20;

/** 효과 불확실로 멈춘 사유들. 다른 사유(검증 불가·예산 등)로 멈춘 목표는 관찰로 다시 켜지 않는다. */
const OBSERVABLE_BLOCK_REASONS = new Set<string>([
  "checkpoint_side_effects_uncertain",
  "goal_wait_effects_uncertain",
  "auto_goal_resume_attempt_unsettled",
  GOAL_RESUME_EFFECT_BOUNDARY_UNCERTAIN,
]);

const inFlightGoals = new Set<string>();

export function effectObservationDigest(longRunId: string, attemptIds: readonly string[]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({ longRunId, attemptIds: [...attemptIds].sort() })).digest("hex")}`;
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

Goal: ${input.objective.slice(0, 1_200)}

Interrupted attempt(s):
${blocks}

Rules for this check:
- This run is read-only. Do not perform, retry, complete, or undo any action. Do not post, send, submit, buy, reply, like, delete or edit anything.
- Only look: open or refresh the relevant page in the browser, list recent posts / messages / orders / files, read logs or the working folder.
- Decide from what you actually see, not from what should have happened.

End your answer with exactly one final line (no code fence), covering all attempts above in one verdict:
${EFFECT_OBSERVATION_MARKER}{"verdict":"done","attempts":${ids},"evidence":"the URL or short text you saw"}
- "done": you saw that the result exists (for example the post is on the profile).
- "not_done": you clearly saw it does not exist (the list is visible and the item is absent).
- "unknown": you could not see it, the attempts differ, or you are not sure. Unknown is always acceptable; a wrong "done" or "not_done" is not.`;
}

function say(chatId: string, runId: string, ko: string, en: string): void {
  try {
    appendChatMessage(chatId, "assistant", currentUiLocale() === "ko" ? ko : en, { hostNotice: { purpose: "goal-continuation", runId } });
  } catch (error) {
    console.warn("[effect-observation] chat notice failed:", error);
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
  dispatcher: EffectObservationDispatcher, goalId: string, trigger: string,
): EffectObservationDispatchResult {
  if (inFlightGoals.has(goalId)) return { status: "skipped", reason: "in_flight" };
  const run = getLongRunByGoalId(goalId);
  if (!run || run.surface === "science") return { status: "skipped", reason: "not_observable_surface" };
  if (run.status !== "blocked" || !OBSERVABLE_BLOCK_REASONS.has(run.blockedReason ?? "")) {
    return { status: "skipped", reason: "not_blocked_on_uncertain_effects" };
  }
  const chatId = run.rootChatId;
  const chat = chatId ? getChat(chatId) : null;
  if (!chatId || !chat || chat.goalId !== goalId) return { status: "skipped", reason: "chat_binding_changed" };
  // 자동화가 이어받는 목표의 재실행은 자동화 자신의 그래프 조정 관문이 따로 다룬다.
  if (findAutomationByGoalId(goalId)) return { status: "skipped", reason: "automation_continuation" };
  if (dispatcher.activeChatIds().includes(chatId)) return { status: "skipped", reason: "chat_busy" };
  const review = getLongRunAttemptReview(run.id);
  if (!review.attempts.length) return { status: "skipped", reason: "no_uncertain_attempts" };
  if (review.attempts.some((attempt) => attempt.state === "running")) return { status: "skipped", reason: "attempt_running" };
  if (review.attempts.length > MAX_OBSERVED_ATTEMPTS) return { status: "skipped", reason: "too_many_attempts" };
  const digest = effectObservationDigest(run.id, review.attemptIds);
  if (alreadyObserved(run.id, digest)) return { status: "skipped", reason: "already_observed" };
  const observationRunId = randomUUID();
  const request: McpInvocationRequest = {
    chatId, runId: observationRunId, promptOrigin: "system", taskIntent: "task", permissions: "read",
    ...(chat.originSurface === "one" ? { oneMode: true, onePermissionMode: "read" as const } : {}),
    userPrompt: buildEffectObservationPrompt({ objective: run.objective, attempts: review.attempts }),
  };
  // 띄우기 전에 원장에 남긴다 — 이 뒤에 무엇이 죽어도 같은 집합을 두 번 관찰하지 않는다.
  appendLongRunEvent({ runId: run.id, kind: EFFECT_OBSERVATION_EVENT_KIND, actorKind: "host",
    payload: { action: "dispatched", observationDigest: digest, observationInvocationRunId: observationRunId,
      attemptIds: review.attemptIds, trigger: trigger.slice(0, 80), permission: "read" } });
  const ticket: EffectObservationTicket = Object.freeze({ observationRunId, goalId, longRunId: run.id, chatId,
    attemptIds: Object.freeze([...review.attemptIds]), digest, surface: run.surface, dispatcher });
  registerEffectObservationTicket(ticket);
  inFlightGoals.add(goalId);
  say(chatId, observationRunId, "이전 작업이 반영됐는지 확인하는 중…", "Checking whether the earlier action went through…");
  try {
    const started = dispatcher.start(request, undefined, undefined, undefined, "goal-continuation");
    if (started.runId !== observationRunId) throw new Error("effect_observation_dispatch_identity_mismatch");
    return { status: "dispatched", runId: observationRunId };
  } catch (error) {
    takeEffectObservationTicket(observationRunId);
    inFlightGoals.delete(goalId);
    const reason = error instanceof Error ? error.message.slice(0, 120) : "effect_observation_dispatch_failed";
    recordInconclusive(ticket, reason, "not_started");
    return { status: "skipped", reason };
  }
}

function recordInconclusive(ticket: EffectObservationTicket, reason: string,
  copy: "unknown" | "not_started" | { observed: "done" | "not_done" } = "unknown"): void {
  try {
    appendLongRunEvent({ runId: ticket.longRunId, kind: EFFECT_OBSERVATION_EVENT_KIND, actorKind: "host",
      payload: { action: "inconclusive", observationDigest: ticket.digest,
        observationInvocationRunId: ticket.observationRunId, reason,
        ...(typeof copy === "object" ? { observedVerdict: copy.observed } : {}) } });
  } catch (error) {
    console.warn("[effect-observation] inconclusive receipt failed:", error);
  }
  const resumeKo = "목표에서 '재개'를 누르면 그 작업은 다시 하지 않고 다음부터 이어갑니다.";
  const resumeEn = "Press Resume on the goal to continue from the next step without redoing it.";
  if (copy === "not_started") {
    say(ticket.chatId, ticket.observationRunId, `이전 작업을 직접 확인하지 못했어요. ${resumeKo}`,
      `I could not start checking the earlier action. ${resumeEn}`);
  } else if (typeof copy === "object") {
    say(ticket.chatId, ticket.observationRunId,
      `확인해 보니 이전 작업은 ${copy.observed === "done" ? "이미 반영돼 있었어요" : "반영되지 않았어요"}. 다만 여기서 자동으로 이어가지는 못했어요. ${resumeKo}`,
      `Checked: the earlier action ${copy.observed === "done" ? "already went through" : "did not go through"}, but the goal could not continue automatically. ${resumeEn}`);
  } else {
    say(ticket.chatId, ticket.observationRunId, `직접 확인했지만 이전 작업이 반영됐는지 알 수 없었어요. ${resumeKo}`,
      `I looked, but could not tell whether the earlier action went through. ${resumeEn}`);
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
  inFlightGoals.delete(ticket.goalId);
  const fallback = (reason: string): EffectObservationOutcome => {
    recordInconclusive(ticket, reason);
    return { outcome: "fallback", reason };
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
        || !OBSERVABLE_BLOCK_REASONS.has(current.blockedReason ?? "")) throw new Error("effect_observation_goal_state_changed");
      if (getChat(ticket.chatId)?.goalId !== ticket.goalId) throw new Error("goal_control_binding_changed");
      if (findAutomationByGoalId(ticket.goalId)) throw new Error("effect_observation_automation_continuation");
      const settled = settleUncertainAttemptsByObservation(current.id, { attemptIds: ticket.attemptIds, verdict,
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
    return { outcome: "fallback", reason: reason.slice(0, 120) };
  }
}

/** 실행기 싱크용 — 원문 final 텍스트에서 표식을 읽는다(지우기 전에). */
export function readEffectObservationFromFinal(runId: string, text: string): ParsedEffectObservation | null {
  const ticket = effectObservationTicket(runId);
  if (!ticket) return null;
  return parseEffectObservationMarker(text, ticket.attemptIds);
}
