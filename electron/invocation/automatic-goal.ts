import { longRunMonetaryRefusal } from "../long-run/budget";
import { resumeDesktopLongRunManually } from "../long-run/app-runtime-coordinator";
import { getChatGoalRevision } from "../store/chat-goals";
import { getLongRunByGoalId, getLongRunGoalRevisionBinding, acknowledgeUncertainLongRunAttempts, liveLongRunAttemptCount, unsettledLongRunAttemptCount } from "../store/long-runs";
import { getDb } from "../store/db";
import { tryRecordRunEvent } from "../store/run-events";
import { admitJudgedAutomaticGoal } from "../long-run/auto-goal-controller";
import {
  AUTOMATIC_GOAL_INTENT_TIMEOUT_MS,
  resolveAutomaticGoalIntent,
  type AutomaticGoalIntentResolution,
} from "../long-run/judged-auto-goal-intent";
import type { GoalIntakeDecision, GoalSourceMessage } from "../../shared/auto-goal";
import { resolveGoalLifecycle } from "../../shared/auto-goal";
import type { LongRunRecord } from "../store/long-runs";
import { buildAutomaticGoalCriteria } from "../../shared/automatic-goal-criteria";

/** Bounded default, not a promise to finish inside it. Unfinished goals retain their criteria and
 * pause with their remaining budget intact. Money metering is unavailable here: null explicitly
 * means no monetary enforcement, never an invented $0 cost.
 *
 * The old pair -- 3 cycles, 10 minutes -- was not a budget, it was a stopwatch. Measured against a
 * real long-running orchestration on this machine: 189 turns over 25.9 hours, with a 75-minute gap
 * between two consecutive turns and four failed turns in the middle. Under 3-and-10 that work ends
 * during its first pause and looks to the person like the product gave up.
 *
 * A working day is the defensible automatic default: long enough that ordinary thinking, waiting and
 * retrying fit inside it, short enough that a request auto-admitted from a plain sentence cannot run
 * unattended forever. The explicit Goal path stays unbounded; that one the person asked for.
 */
/*
 * ★오너 지시 2026-09-08: "주기 시간 무제한해라".
 *
 * 자동으로 승인된 목표도 사람이 멈추기 전까지 이어간다. null 은 원장이 이미 아는 표현이고
 * (cyclesSpent/deadlinePassed 판정이 null 을 건너뛴다), 무한 반복은 예산이 아니라 진전
 * 없음(stall)·실패 반복·사용자 정지로 멈춘다 — 그쪽이 원래 멈춤의 정본이다.
 *
 * 실측이 이 결정을 뒷받침한다: 오너 저장소의 자동 목표는 maxCycles=3 으로 만들어져
 * reason:"budget" 으로 10분 만에 끝났다. 코덱스가 같은 자리에서 189턴 25.9시간을 돈다.
 */
export const AUTOMATIC_GOAL_CYCLE_LIMIT: number | null = null;
export const AUTOMATIC_GOAL_TIME_LIMIT_MS: number | null = null;

export type AutomaticGoalPreparation =
  | { kind: "admitted"; run: LongRunRecord }
  | { kind: "bypass"; decision: GoalIntakeDecision }
  | {
      kind: "unavailable";
      reason: string;
      retryable: true;
      failureKind?: AutomaticGoalIntentResolution["failureKind"];
      attempts?: AutomaticGoalIntentResolution["attempts"];
      stage?: "source_validation" | "classification" | "admission";
      causeName?: string;
      causeCode?: string;
    };

function safeIntakeFailureReason(error: unknown): string {
  return error instanceof Error && /^(?:auto_goal|goal|long_run)_[a-z_]+$/.test(error.message)
    ? error.message
    : "classification_or_admission_failed";
}

function safeIntakeFailureIdentity(error: unknown): { causeName: string; causeCode?: string } {
  const causeName = error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)
    ? error.name
    : typeof error;
  if (!error || typeof error !== "object" || !("code" in error)) return { causeName };
  const code = String((error as { code?: unknown }).code ?? "");
  return /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? { causeName, causeCode: code } : { causeName };
}

export async function prepareInvocationAutomaticGoal(input: {
  runId: string;
  chatId: string;
  sourceMessageId: string;
  userPrompt: string;
  permission: string;
  attachmentOnly?: boolean;
  signal: AbortSignal;
  resolveIntent?: (
    source: GoalSourceMessage,
    options: Parameters<typeof resolveAutomaticGoalIntent>[1],
  ) => Promise<GoalIntakeDecision | AutomaticGoalIntentResolution>;
}): Promise<AutomaticGoalPreparation> {
  let stage: "source_validation" | "classification" | "admission" = "source_validation";
  try {
    if (input.signal.aborted) {
      return { kind: "bypass", decision: {
        messageId: input.sourceMessageId, intent: "unknown", commitment: "uncertain",
      } };
    }
    const row = getDb().prepare("SELECT chat_id, role, text FROM chat_messages WHERE id = ?")
      .get(input.sourceMessageId) as { chat_id: string; role: string; text: string } | undefined;
    if (!row || row.role !== "user" || row.chat_id !== input.chatId || row.text !== input.userPrompt) {
      throw new Error("auto_goal_source_mismatch");
    }
    const source: GoalSourceMessage = { chatId: input.chatId, messageId: input.sourceMessageId, role: "user", text: row.text };
    // Attachment-only requests legitimately have no text for the auxiliary
    // Goal classifier. The selected execution runtime still receives the
    // attachments, so skip Goal intake without presenting this as an outage.
    if (!source.text.trim() || input.attachmentOnly) {
      const decision: GoalIntakeDecision = {
        messageId: source.messageId,
        intent: "unknown",
        commitment: "uncertain",
      };
      tryRecordRunEvent({
        runId: input.runId,
        chatId: input.chatId,
        kind: "automatic_goal_intake",
        payload: {
          sourceMessageId: source.messageId,
          intent: decision.intent,
          commitment: decision.commitment,
          classified: false,
          bypassReason: input.attachmentOnly ? "attachment_only" : "empty_text",
        },
      });
      return { kind: "bypass", decision };
    }
    stage = "classification";
    const decision = await (input.resolveIntent ?? resolveAutomaticGoalIntent)(source, {
      signal: input.signal,
      // Local classification can exceed a short network-style deadline. Keep a
      // finite bound while allowing the configured local runtime to answer.
      timeoutMs: AUTOMATIC_GOAL_INTENT_TIMEOUT_MS,
    });
    if (input.signal.aborted) return { kind: "bypass", decision };
    if ("classification" in decision && decision.classification === "unavailable") {
      const unavailable: Extract<AutomaticGoalPreparation, { kind: "unavailable" }> = {
        kind: "unavailable",
        reason: "auto_goal_classification_unavailable",
        retryable: true,
        ...(decision.failureKind ? { failureKind: decision.failureKind } : {}),
        ...(decision.attempts ? { attempts: decision.attempts } : {}),
      };
      tryRecordRunEvent({
        runId: input.runId,
        chatId: input.chatId,
        kind: "automatic_goal_intake_unavailable",
        payload: {
          sourceMessageId: input.sourceMessageId,
          reason: unavailable.reason,
          retryable: true,
          stage,
          ...(unavailable.failureKind ? { failureKind: unavailable.failureKind } : {}),
          ...(unavailable.attempts ? { attempts: unavailable.attempts } : {}),
        },
      });
      return unavailable;
    }
    tryRecordRunEvent({ runId: input.runId, chatId: input.chatId, kind: "automatic_goal_intake", payload: {
      sourceMessageId: source.messageId, intent: decision.intent, commitment: decision.commitment,
      ...(decision.intent === "execute" ? { lifecycle: resolveGoalLifecycle(decision.lifecycle) } : {}),
      classified: true,
      ...("attempts" in decision && decision.attempts ? { attempts: decision.attempts } : {}),
    } });
    if (decision.intent !== "execute" || decision.commitment !== "now") return { kind: "bypass", decision };
    stage = "admission";
    const run = admitJudgedAutomaticGoal({
      goalId: `goal:auto-message:${source.messageId}`, chatId: source.chatId, sourceMessageId: source.messageId, decision,
      /*
       * A criterion the verifier cannot check is a criterion that fails forever.
       *
       * Measured 2026-09-08: a run built the requested Flutter app, passed
       * `flutter test` 6/6 and `flutter analyze` with zero issues, and still ended
       * `blocked`. Two of these three criteria came back `inconclusive` because they
       * asked the judge about things it had no way to enumerate:
       *   - "every deliverable requested in user message <id>" -- the judge sees the
       *     run's evidence, not that message, so it answered "the full set of
       *     requested deliverables ... is not enumerable from the evidence".
       *   - "the original request's constraints, exclusions and permission
       *     boundaries" -- it answered "not concretely verifiable ... with no
       *     explicit constraint list to check against". When the user states no
       *     constraints, there IS no list, so this can never be satisfied.
       *
       * So each criterion now names something the host actually carries into the
       * observation: the request text itself, and the declared working folder plus
       * granted permission from the run receipt.
       */
      acceptanceCriteria: buildAutomaticGoalCriteria({ sourceText: source.text, permission: input.permission,
        lifecycle: resolveGoalLifecycle(decision.lifecycle) }),
      authorityRefs: [`invocation:${input.runId}:permission:${input.permission}`],
      budget: { maxCycles: AUTOMATIC_GOAL_CYCLE_LIMIT, maxCostUsd: null, maxWorkers: 2,
        wallclockDeadline: AUTOMATIC_GOAL_TIME_LIMIT_MS == null
          ? null
          : new Date(Date.now() + AUTOMATIC_GOAL_TIME_LIMIT_MS).toISOString() },
    });
    if (!run) throw new Error("auto_goal_admission_rejected");
    return { kind: "admitted", run };
  } catch (error) {
    const reason = safeIntakeFailureReason(error);
    const failureIdentity = safeIntakeFailureIdentity(error);
    tryRecordRunEvent({ runId: input.runId, chatId: input.chatId, kind: "automatic_goal_intake_unavailable", payload: {
      sourceMessageId: input.sourceMessageId,
      reason,
      retryable: true,
      stage,
      ...failureIdentity,
    } });
    return { kind: "unavailable", reason, retryable: true, stage, ...failureIdentity };
  }
}

/** Explicit UI resume reuses the same campaign and remaining budget. It never
 * reclassifies the synthetic continuation as a new user request. */
/**
 * 재개 요청을 만든다 — 상태를 바꾸지 않는다(재시작 체크포인트 경로가 그 전제로 판번호를 다시 대조한다).
 * actor "user": 사람이 누른 재개. 호출부가 acknowledgeUncertainLongRunAttempts 를 먼저 적고 그 뒤 판번호를 넘긴다.
 * actor "host": 자동 재개. 불확실한 부작용은 사람만 풀 수 있으므로 그것이 남아 있으면 거부한다.
 */
export function automaticGoalResumeRequest(chatId: string, expectedVersion: number, actor: "user" | "host" = "host"): import("../../shared/types").McpInvocationRequest | null {
  const chat = getDb().prepare("SELECT goal_id FROM chats WHERE id = ?").get(chatId) as { goal_id: string | null } | undefined;
  if (!chat?.goal_id) return null;
  const revision = getChatGoalRevision(chat.goal_id);
  if (!revision) return null;
  const run = getLongRunByGoalId(chat.goal_id);
  if (!run || run.surface === "science" || run.rootChatId !== chatId || revision.chatId !== chatId) throw new Error("auto_goal_resume_surface_mismatch");
  if (run.version !== expectedVersion) throw new Error("long_run_resume_version_conflict");
  if (!["paused", "blocked"].includes(run.status)) throw new Error("auto_goal_resume_not_stopped");
  if (getLongRunGoalRevisionBinding(run.id)?.revision !== revision.revision) throw new Error("auto_goal_resume_revision_pending");
  if (actor === "user" ? liveLongRunAttemptCount(run.id) : unsettledLongRunAttemptCount(run.id)) {
    throw new Error("auto_goal_resume_attempt_unsettled");
  }
  /*
   * An absent limit is no limit, not a spent one.
   *
   * `maxCycles == null` and `wallclockDeadline == null` mean the goal was admitted without that
   * bound -- which is exactly what the explicit Goal path does. Reading them as exhausted made the
   * resume button throw `auto_goal_budget_exhausted` for precisely the runs the person had asked to
   * run without a limit, so the only goals that could be resumed were the ones that needed it least.
   */
  const cyclesSpent = run.budget.maxCycles != null && run.cycleCount >= run.budget.maxCycles;
  const deadlinePassed = run.budget.wallclockDeadline != null
    && Date.parse(run.budget.wallclockDeadline) <= Date.now();
  const costSpent = Boolean(longRunMonetaryRefusal(run));
  if (cyclesSpent || deadlinePassed || costSpent) throw new Error(longRunMonetaryRefusal(run) ?? "auto_goal_budget_exhausted");
  const authority = revision.authorityRefs.map((ref) => /^invocation:([^:]+):permission:(read|write|full)$/.exec(ref)).find(Boolean);
  if (!authority) throw new Error("auto_goal_resume_authority_missing");
  return { chatId, promptOrigin: "system", taskIntent: "task", permissions: authority[2] as "read" | "write" | "full",
    // One resolves permission from its explicit mode, not the generic field.
    // This is the stored user grant, not a new grant from a system prompt.
    ...(run.surface === "one" ? { oneMode: true, onePermissionMode: authority[2] as "read" | "write" | "full" } : {}),
    userPrompt: `Resume the existing goal within its remaining budget and original permissions. Preserve every original constraint and acceptance criterion. Verify the actual output before claiming completion, and compare it item by item against the user's original plan (including any spec document or project memory it points to): report what is missing first. For games, apps and UI, graphic quality is an acceptance criterion: placeholder shapes, default-colored rectangles, missing or misaligned assets and empty backgrounds are a failure, not a completion.\n\n${revision.objective}` };
}

/** 사람이 누른 재개 — 인지 이벤트와 재개가 한 트랜잭션이라, 요청을 못 만들면 인지도 남지 않는다. */
export function queueAutomaticGoalResume(chatId: string, expectedVersion: number) {
  return getDb().transaction(() => {
    const chat = getDb().prepare("SELECT goal_id FROM chats WHERE id = ?").get(chatId) as { goal_id: string | null } | undefined;
    const before = chat?.goal_id ? getLongRunByGoalId(chat.goal_id) : null;
    if (!before) throw new Error("long_run_resume_dispatch_unavailable");
    if (before.version !== expectedVersion) throw new Error("long_run_resume_version_conflict");
    // 끊긴 시도의 불확실성은 인지된 것으로 원장에 적는다 — 그 이벤트가 판번호를 올리므로 이후는 새 판번호로.
    const { version } = acknowledgeUncertainLongRunAttempts(before.id);
    const request = automaticGoalResumeRequest(chatId, version, "user");
    if (!request) throw new Error("long_run_resume_dispatch_unavailable");
    getDb().prepare("UPDATE chat_goal_contracts SET status = 'active', completed_at = NULL, updated_at = ? WHERE goal_id = ? AND status = 'blocked'")
      .run(new Date().toISOString(), before.goalId);
    return { request, queued: resumeDesktopLongRunManually(before.id, version) };
  })();
}
