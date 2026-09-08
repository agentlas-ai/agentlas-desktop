import { resumeDesktopLongRunManually } from "../long-run/app-runtime-coordinator";
import { getChatGoalRevision } from "../store/chat-goals";
import { getLongRunByGoalId, getLongRunGoalRevisionBinding } from "../store/long-runs";
import { getDb } from "../store/db";
import { tryRecordRunEvent } from "../store/run-events";
import { admitJudgedAutomaticGoal } from "../long-run/auto-goal-controller";
import { resolveAutomaticGoalIntent } from "../long-run/judged-auto-goal-intent";
import type { GoalSourceMessage } from "../../shared/auto-goal";
import type { LongRunRecord } from "../store/long-runs";

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

export async function prepareInvocationAutomaticGoal(input: {
  runId: string;
  chatId: string;
  sourceMessageId: string;
  userPrompt: string;
  permission: string;
  signal: AbortSignal;
  resolveIntent?: typeof resolveAutomaticGoalIntent;
}): Promise<LongRunRecord | null> {
  try {
    if (input.signal.aborted) return null;
    const row = getDb().prepare("SELECT chat_id, role, text FROM chat_messages WHERE id = ?")
      .get(input.sourceMessageId) as { chat_id: string; role: string; text: string } | undefined;
    if (!row || row.role !== "user" || row.chat_id !== input.chatId || row.text !== input.userPrompt) {
      throw new Error("auto_goal_source_mismatch");
    }
    const source: GoalSourceMessage = { chatId: input.chatId, messageId: input.sourceMessageId, role: "user", text: row.text };
    const decision = await (input.resolveIntent ?? resolveAutomaticGoalIntent)(source, { signal: input.signal, timeoutMs: 4_000 });
    if (input.signal.aborted) return null;
    tryRecordRunEvent({ runId: input.runId, chatId: input.chatId, kind: "automatic_goal_intake", payload: {
      sourceMessageId: source.messageId, intent: decision.intent, commitment: decision.commitment,
      classified: decision.intent !== "unknown",
    } });
    if (decision.intent !== "execute" || decision.commitment !== "now") return null;
    return admitJudgedAutomaticGoal({
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
      acceptanceCriteria: [
        { id: "requested-outcome", text: "Every deliverable the user asked for is complete and present in the workspace. "
          + `The request was: ${JSON.stringify(source.text.replace(/\s+/g, " ").trim().slice(0, 1_200))}` },
        { id: "scope", text: "No file outside the run's declared working folder was created or modified, and the run stayed "
          + `within its granted permission (${input.permission}). Both the folder and the permission are in the run receipt; `
          + "if the evidence shows no out-of-folder writes, this criterion is met." },
        { id: "evidence", text: "Completion is supported by current evidence on the requested output surface; unverified work remains open." },
        { id: "delivery-validation", text: "Validate the delivered result in the way its user will use it. "
          + "For an application or interactive UI implementation/change, launch the actual application, inspect its rendered screens, "
          + "and exercise its core user flows in a browser, simulator, or native runtime. Keep observable tool results or captures "
          + "of the launch, rendered state, interactions, and outcomes. Source files, successful builds, static analysis, "
          + "unit/widget tests, and the assistant's report alone do not prove this criterion. Fix observed failures and repeat "
          + "the affected flows. For non-interactive deliverables, inspect the actual delivered output in its target format instead. "
          + "An unavailable runtime or missing required access is an unmet prerequisite, not successful validation. "
          + "Do not publish, spend money, or expand permissions to satisfy this criterion without existing authorization." },
      ],
      authorityRefs: [`invocation:${input.runId}:permission:${input.permission}`],
      budget: { maxCycles: AUTOMATIC_GOAL_CYCLE_LIMIT, maxCostUsd: null, maxWorkers: 2,
        wallclockDeadline: AUTOMATIC_GOAL_TIME_LIMIT_MS == null
          ? null
          : new Date(Date.now() + AUTOMATIC_GOAL_TIME_LIMIT_MS).toISOString() },
    });
  } catch (error) {
    tryRecordRunEvent({ runId: input.runId, chatId: input.chatId, kind: "automatic_goal_intake_unavailable", payload: {
      sourceMessageId: input.sourceMessageId,
      reason: error instanceof Error && /^auto_goal_[a-z_]+$/.test(error.message) ? error.message : "classification_or_admission_failed",
    } });
    return null;
  }
}

/** Explicit UI resume reuses the same campaign and remaining budget. It never
 * reclassifies the synthetic continuation as a new user request. */
export function automaticGoalResumeRequest(chatId: string, expectedVersion: number): import("../../shared/types").McpInvocationRequest | null {
  const chat = getDb().prepare("SELECT goal_id FROM chats WHERE id = ?").get(chatId) as { goal_id: string | null } | undefined;
  if (!chat?.goal_id) return null;
  const revision = getChatGoalRevision(chat.goal_id);
  if (!revision) return null;
  const run = getLongRunByGoalId(chat.goal_id);
  if (!run || run.surface === "science" || run.rootChatId !== chatId || revision.chatId !== chatId) throw new Error("auto_goal_resume_surface_mismatch");
  if (run.version !== expectedVersion) throw new Error("long_run_resume_version_conflict");
  if (!["paused", "blocked"].includes(run.status)) throw new Error("auto_goal_resume_not_stopped");
  if (getLongRunGoalRevisionBinding(run.id)?.revision !== revision.revision) throw new Error("auto_goal_resume_revision_pending");
  const pending = getDb().prepare("SELECT COUNT(*) AS n FROM long_run_worker_attempts WHERE run_id = ? AND state IN ('running','uncertain')").get(run.id) as { n: number };
  if (pending.n) throw new Error("auto_goal_resume_attempt_unsettled");
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
  const costSpent = run.budget.maxCostUsd !== null && run.costUsedUsd >= run.budget.maxCostUsd;
  if (cyclesSpent || deadlinePassed || costSpent) throw new Error("auto_goal_budget_exhausted");
  const authority = revision.authorityRefs.map((ref) => /^invocation:([^:]+):permission:(read|write|full)$/.exec(ref)).find(Boolean);
  if (!authority) throw new Error("auto_goal_resume_authority_missing");
  return { chatId, promptOrigin: "system", taskIntent: "task", permissions: authority[2] as "read" | "write" | "full",
    ...(run.surface === "one" ? { oneMode: true } : {}),
    userPrompt: `Resume the existing goal within its remaining budget and original permissions. Preserve every original constraint and acceptance criterion. Verify the actual output before claiming completion.\n\n${revision.objective}` };
}

export function queueAutomaticGoalResume(chatId: string, expectedVersion: number) {
  return getDb().transaction(() => {
    const request = automaticGoalResumeRequest(chatId, expectedVersion);
    if (!request) throw new Error("long_run_resume_dispatch_unavailable");
    const chat = getDb().prepare("SELECT goal_id FROM chats WHERE id = ?").get(chatId) as { goal_id: string };
    const run = getLongRunByGoalId(chat.goal_id)!;
    getDb().prepare("UPDATE chat_goal_contracts SET status = 'active', completed_at = NULL, updated_at = ? WHERE goal_id = ? AND status = 'blocked'")
      .run(new Date().toISOString(), run.goalId);
    return { request, queued: resumeDesktopLongRunManually(run.id, expectedVersion) };
  })();
}
