import { channelPublishReceiptsPromptBlockFor } from "../publish-receipts";
import { resumeDesktopLongRunManually } from "../long-run/app-runtime-coordinator";
import { getChatGoalRevision } from "../store/chat-goals";
import { appendLongRunEvent, getLongRun, getLongRunByGoalId, latestLongRunAttemptSafeEpoch, acknowledgeUncertainLongRunAttempts, liveLongRunAttemptCount, type LongRunAttemptReviewConfirmation } from "../store/long-runs";
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
import { goalResumeRecoveryBlockerCode } from "../../shared/long-run";
import { currentUiLocale } from "../ui-locale";
import { runtimeFailureBlocksReplay } from "../runtime/selection";
import { createHash } from "node:crypto";

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
      ...(decision.turnScope ? { turnScope: decision.turnScope } : {}),
      classified: true,
      ...("attempts" in decision && decision.attempts ? { attempts: decision.attempts } : {}),
    } });
    if (decision.intent !== "execute" || decision.commitment !== "now") return { kind: "bypass", decision };
    // A one-reply request stays an ordinary turn (owner 2026-09-25). Measured before: a one-line file
    // write became a Goal with 17 invocations and 7 verifier attempts for work done in invocation 1.
    if (decision.turnScope === "single") return { kind: "bypass", decision };
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

/** A typed failed controller turn is not permission for an automatic new brain
 * episode. Use its durable receipt, including after restart or an old retry.
 * An explicit later owner resume can authorize new work without pretending the
 * previous turn's external effects were proved. */
function automaticGoalReplayBarrier(runId: string) {
  const db = getDb();
  const attempt = db.prepare(`SELECT a.id, a.error_code, a.invocation_run_id, l.root_chat_id,
      COALESCE((SELECT MAX(e.seq) FROM long_run_events e WHERE e.run_id = a.run_id
        AND e.kind IN ('worker.attempt_started','worker.attempt_settled')
        AND json_extract(e.payload_json, '$.attemptId') = a.id), 0) AS attempt_seq
    FROM long_run_worker_attempts a JOIN long_run_workers w ON w.id = a.worker_id
    JOIN long_runs l ON l.id = a.run_id
    WHERE a.run_id = ? AND w.role = 'controller'
    ORDER BY (SELECT MAX(e.seq) FROM long_run_events e WHERE e.run_id = a.run_id
      AND e.kind = 'worker.attempt_started'
      AND json_extract(e.payload_json, '$.attemptId') = a.id) DESC, a.started_at DESC, a.id DESC
    LIMIT 1`).get(runId) as { id: string; error_code: string | null; invocation_run_id: string | null;
      root_chat_id: string | null; attempt_seq: number } | undefined;
  if (!attempt) return null;
  // A successful brain result does not prove a lost native steering ACK. Only
  // this controller's exact invocation/chat can hold its next automatic turn.
  const controls = attempt.invocation_run_id && attempt.root_chat_id
    ? db.prepare(`SELECT intent_id, status, code, updated_at FROM invocation_current_turn_steers
        WHERE run_id = ? AND chat_id = ? AND status IN ('dispatching','uncertain') ORDER BY intent_id`)
        .all(attempt.invocation_run_id, attempt.root_chat_id) as Array<{
          intent_id: string; status: string; code: string | null; updated_at: string }>
    : [];
  const blocker = runtimeFailureBlocksReplay({ providerCode: attempt.error_code ?? undefined })
    ? attempt.error_code : controls.length ? "runtime_turn_unsettled" : null;
  if (!blocker) return null;
  return { code: blocker, attemptSeq: attempt.attempt_seq,
    observed: { schemaVersion: "agentlas.goal-runtime-replay-barrier.v1", runId,
      attemptId: attempt.id, invocationRunId: attempt.invocation_run_id,
      digest: `sha256:${createHash("sha256").update(JSON.stringify({ runId, attempt, controls })).digest("hex")}` } };
}

export function automaticGoalReplayBlockerCode(runId: string): string | null {
  const barrier = automaticGoalReplayBarrier(runId);
  if (!barrier) return null;
  // Only the actual Main user-resume producer can capture this exact receipt
  // set. Wall clocks and generic user messages cannot acknowledge a later ACK.
  const resumed = getDb().prepare(`SELECT 1 FROM long_run_events WHERE run_id = ? AND seq > ?
    AND kind = 'run.user_control' AND actor_kind = 'user'
    AND json_extract(payload_json, '$.command') = 'resume'
    AND json_extract(payload_json, '$.runtimeReplayBarrier.schemaVersion') = ?
    AND json_extract(payload_json, '$.runtimeReplayBarrier.runId') = ?
    AND json_extract(payload_json, '$.runtimeReplayBarrier.attemptId') = ?
    AND json_extract(payload_json, '$.runtimeReplayBarrier.invocationRunId') IS ?
    AND json_extract(payload_json, '$.runtimeReplayBarrier.digest') = ?
    ORDER BY seq DESC LIMIT 1`).get(runId, barrier.attemptSeq, barrier.observed.schemaVersion,
      runId, barrier.observed.attemptId, barrier.observed.invocationRunId, barrier.observed.digest);
  return resumed ? null : barrier.code;
}

/** Explicit UI resume reuses the same campaign and remaining budget. It never
 * reclassifies the synthetic continuation as a new user request. */
/**
 * 재개 요청을 만든다 — 상태를 바꾸지 않는다(재시작 체크포인트 경로가 그 전제로 판번호를 다시 대조한다).
 * actor "user": 사람이 누른 재개. 호출부가 acknowledgeUncertainLongRunAttempts 를 먼저 적고 그 뒤 판번호를 넘긴다.
 * actor "host": 자동 재개. 불확실한 부작용은 사람만 풀 수 있으므로 그것이 남아 있으면 거부한다.
 */
export function automaticGoalResumeRequest(chatId: string, expectedVersion: number, actor: "user" | "host" = "host",
  /** Main-only: a read-only observation already looked at the external outcome of the
   * interrupted attempts and the ledger recorded its exact verdict in this transaction. */
  observation?: { verdict: "done" | "not_done"; evidence: string; proof?: "receipt" }): import("../../shared/types").McpInvocationRequest | null {
  const chat = getDb().prepare("SELECT goal_id FROM chats WHERE id = ?").get(chatId) as { goal_id: string | null } | undefined;
  if (!chat?.goal_id) return null;
  const revision = getChatGoalRevision(chat.goal_id);
  if (!revision) return null;
  const run = getLongRunByGoalId(chat.goal_id);
  if (!run || run.surface === "science" || run.rootChatId !== chatId || revision.chatId !== chatId) throw new Error("auto_goal_resume_surface_mismatch");
  if (run.version !== expectedVersion) throw new Error("long_run_resume_version_conflict");
  if (!["paused", "blocked", "queued", "running", "waiting_tool", "waiting_user", "verifying"].includes(run.status)) throw new Error("auto_goal_resume_not_stopped");
  if (liveLongRunAttemptCount(run.id)) throw new Error("auto_goal_resume_attempt_live");
  if (actor === "host") {
    const blocker = automaticGoalReplayBlockerCode(run.id);
    if (blocker) throw new Error(blocker);
  }
  const authority = revision.authorityRefs.map((ref) => /^invocation:([^:]+):permission:(read|write|full)$/.exec(ref)).find(Boolean);
  if (!authority) throw new Error("auto_goal_resume_authority_missing");
  return { chatId, promptOrigin: "system", taskIntent: "task", permissions: authority[2] as "read" | "write" | "full",
    // Without a locale the run fell back to "en" and One answered a Korean owner in
    // English on every goal resume (run_events invoke_started locale:"en", 2026-09-26).
    locale: currentUiLocale(),
    // One resolves permission from its explicit mode, not the generic field.
    // This is the stored user grant, not a new grant from a system prompt.
    ...(run.surface === "one" ? { oneMode: true, onePermissionMode: authority[2] as "read" | "write" | "full" } : {}),
    userPrompt: `Resume the existing goal under its original permissions. Run effect/result checks in parallel with independent useful work. Failed or unavailable checks must never stop the whole goal. Preserve uncertainty as unknown, do not repeat a specific uncertain external action, and choose other useful work while its outcome is unresolved. Preserve every original constraint and acceptance criterion. Verify the actual output before claiming completion, and compare it item by item against the user's original plan (including any spec document or project memory it points to): report what is missing first. For games, apps and UI, graphic quality is an acceptance criterion: placeholder shapes, default-colored rectangles, missing or misaligned assets and empty backgrounds are a failure, not a completion.${actor === "user" && latestLongRunAttemptSafeEpoch(run.id)
      ? " The user acknowledged interrupted attempts, but the host did not prove their external outcomes. Inspect Activity and the external state read-only in parallel; do not repeat the specific uncertain actions. Continue independent work. If evidence is absent, report the prior outcomes as unknown."
      : observation?.verdict === "done"
        ? ` A read-only check just observed that the interrupted earlier action already took effect (evidence: ${observation.evidence}). Do not repeat it; continue with the next remaining step.`
        : observation?.proof === "receipt"
          // The host's own record: the interrupted turn only read. There is nothing to repeat.
          ? ` The host's record shows the interrupted turn only searched, read or loaded pages (${observation.evidence}); nothing outside changed and there is nothing to repeat. Continue with the next remaining step.`
          : observation?.verdict === "not_done"

            // count, three minutes after the reply had been posted and verified). Never a licence to repeat blindly.
            ? ` A read-only check reported that the interrupted earlier action did not take effect (evidence: ${observation.evidence}). Before doing it again, look at the exact page it targeted and at this conversation's later messages; if either shows it already happened (a posted reply, a permalink, a sent message), do not repeat it.`
            : ""}${(() => { const receipts = channelPublishReceiptsPromptBlockFor(revision.objective); return receipts ? `\n\n${receipts}` : ""; })()}\n\n${revision.objective}` };
}

/** 사람이 누른 재개 — 인지 이벤트와 재개가 한 트랜잭션이라, 요청을 못 만들면 인지도 남지 않는다. */
export async function queueAutomaticGoalResume(
  chatId: string, expectedVersion: number, confirmation?: LongRunAttemptReviewConfirmation,
) {
  const initialChat = getDb().prepare("SELECT goal_id FROM chats WHERE id = ?").get(chatId) as { goal_id: string | null } | undefined;
  const initialRun = initialChat?.goal_id ? getLongRunByGoalId(initialChat.goal_id) : null;
  if (!initialRun) throw new Error("long_run_resume_dispatch_unavailable");
  if (initialRun.version !== expectedVersion) throw new Error("long_run_resume_version_conflict");
  if (!["paused", "blocked", "queued", "running", "waiting_tool", "verifying", "waiting_user"].includes(initialRun.status)) {
    throw new Error("long_run_resume_dispatch_unavailable");
  }
  const initialRecoveryBlocker = goalResumeRecoveryBlockerCode(initialRun.blockedReason);
  if (initialRecoveryBlocker) throw new Error(initialRecoveryBlocker);
  return getDb().transaction(() => {
    const chat = getDb().prepare("SELECT goal_id FROM chats WHERE id = ?").get(chatId) as { goal_id: string | null } | undefined;
    const before = chat?.goal_id ? getLongRunByGoalId(chat.goal_id) : null;
    if (!before) throw new Error("long_run_resume_dispatch_unavailable");
    if (before.version !== expectedVersion) throw new Error("long_run_resume_version_conflict");
    // Optional explicit review is recorded as an attestation, never fabricated by Resume.
    if (confirmation) acknowledgeUncertainLongRunAttempts(before.id, confirmation);
    const version = getLongRun(before.id)?.version;
    if (!version) throw new Error("long_run_resume_dispatch_unavailable");
    const request = automaticGoalResumeRequest(chatId, version, "user");
    if (!request) throw new Error("long_run_resume_dispatch_unavailable");
    const barrier = automaticGoalReplayBarrier(before.id);
    if (barrier) appendLongRunEvent({ runId: before.id, kind: "run.user_control", actorKind: "user",
      payload: { command: "resume", runtimeReplayBarrier: barrier.observed } });
    getDb().prepare("UPDATE chat_goal_contracts SET status = 'active', completed_at = NULL, updated_at = ? WHERE goal_id = ? AND status = 'blocked'")
      .run(new Date().toISOString(), before.goalId);
    return { request,
      queued: resumeDesktopLongRunManually(before.id, getLongRun(before.id)!.version) };
  })();
}
