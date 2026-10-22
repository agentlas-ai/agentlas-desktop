import { channelPublishReceiptsPromptBlockFor } from "../publish-receipts";
import { resumeDesktopLongRunManually } from "../long-run/app-runtime-coordinator";
import { getChatGoalRevision } from "../store/chat-goals";
import { appendLongRunEvent, getLongRun, getLongRunByGoalId, liveLongRunAttemptCount } from "../store/long-runs";
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
import { UNCERTAIN_EFFECT_POLICY } from "../../shared/uncertain-effect-policy";
import { runtimeFailureBlocksReplay } from "../runtime/selection";
import { runtimeFailureBlocksNextAutomaticTurn } from "../../shared/runtime-turn-admission";
import { createHash } from "node:crypto";
import { stripStaffGuidance } from "../one/owner-prompt";
import { isInterruptedPartial } from "../../shared/interrupted-partial";

                                                                                                  
                                                                                                
                                                            
  
                                                                                                   
                                                                                                   
                                                                                                   
                                                                           
  
                                                                                                     
                                                                                                     
                                                                                             
   










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

/** The decision prepareInvocationAutomaticGoal turns into a Goal: an execute-now request that is not a one-reply turn. */
export function isGoalAdmittingDecision(decision: GoalIntakeDecision): boolean {
  return decision.intent === "execute" && decision.commitment === "now" && decision.turnScope !== "single";
}

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
                                                                                                                         
                                                                                                               
  classifyOnly?: boolean;
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
      // A bounded series' interval and run count are read only when the Goal is really admitted; the classification-only
      // pass of a background-service turn just decides whether to forward.
      extractCadence: !input.classifyOnly,
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
      // Flat numbers: the run-event ledger keeps no nested payload objects.
      ...(decision.cadence ? { cadenceEverySeconds: decision.cadence.everySeconds, cadenceMaxRuns: decision.cadence.maxRuns } : {}),
      ...("series" in decision && decision.series ? { series: true } : {}),
      ...("cadenceReason" in decision && decision.cadenceReason ? { cadenceReason: decision.cadenceReason } : {}),
      classified: true,
      ...("attempts" in decision && decision.attempts ? { attempts: decision.attempts } : {}),
    } });
    if (decision.intent !== "execute" || decision.commitment !== "now") return { kind: "bypass", decision };
    

    if (decision.turnScope === "single") return { kind: "bypass", decision };
    if (input.classifyOnly) return { kind: "bypass", decision };
    stage = "admission";
    const run = admitJudgedAutomaticGoal({
      goalId: `goal:auto-message:${source.messageId}`, chatId: source.chatId, sourceMessageId: source.messageId, decision,
      


















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
  // A new controller episode uses the prior receipt as evidence; it does not
  // replay that invocation. Missing terminal/steering ACKs and pending serving
  // reconciliation cannot hold independent work. Keep the same-loop safeguard.
  if (!barrier || !runtimeFailureBlocksNextAutomaticTurn({ providerCode: barrier.code })) return null;
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

/**







 */
export function unansweredOwnerMessage(chatId: string): string | null {
  const rows = getDb().prepare(`SELECT role, text FROM chat_messages WHERE chat_id = ? AND role IN ('user', 'assistant')
    AND host_notice_json IS NULL ORDER BY created_at DESC LIMIT 40`)
    .all(chatId) as Array<{ role: string; text: string | null }>;
  for (const row of rows) {
    const text = (row.text ?? "").trim();
    if (row.role === "assistant" && text && !isInterruptedPartial(text)) return null;
    if (row.role === "user" && text) return text.slice(0, 4_000);
  }
  return null;
}

/** Explicit UI resume reuses the same campaign and remaining budget. It never
 * reclassifies the synthetic continuation as a new user request. */
   
                                                              
                                                
                                                                                      
   
export function automaticGoalResumeRequest(chatId: string, expectedVersion: number, actor: "user" | "host" = "host"): import("../../shared/types").McpInvocationRequest | null {
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
                                                                                        
    locale: currentUiLocale(),
    // One resolves permission from its explicit mode, not the generic field.
    // This is the stored user grant, not a new grant from a system prompt.
    ...(run.surface === "one" ? { oneMode: true, onePermissionMode: authority[2] as "read" | "write" | "full" } : {}),
    userPrompt: `Resume the existing goal under its original permissions. Run effect/result checks in parallel with independent useful work. Failed or unavailable checks must never stop the whole goal. ${UNCERTAIN_EFFECT_POLICY} Preserve every original constraint and acceptance criterion. Verify the actual output before claiming completion, and compare it item by item against the user's original plan (including any spec document or project memory it points to): report what is missing first. For games, apps and UI, graphic quality is an acceptance criterion: placeholder shapes, default-colored rectangles, missing or misaligned assets and empty backgrounds are a failure, not a completion.${(() => { const receipts = channelPublishReceiptsPromptBlockFor(revision.objective); return receipts ? `\n\n${receipts}` : ""; })()}\n\n${stripStaffGuidance(revision.objective)}${(() => { const owner = unansweredOwnerMessage(chatId); return owner ? `\n\nOwner's latest message, not answered yet. It comes first: answer or act on it before continuing the plan, and change the plan if it asks:\n${owner}` : ""; })()}` };
}

/** 사람이 누른 재개 — 요청을 만들고 재개하는 것이 한 트랜잭션이다. */
export async function queueAutomaticGoalResume(chatId: string, expectedVersion: number) {
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
  }).immediate();
}
