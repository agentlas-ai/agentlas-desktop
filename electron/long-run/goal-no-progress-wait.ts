import { getDb } from "../store/db";
import { appendLongRunEvent, goalOwnerAnswerHold, getLongRun, longRunOwnerHold, nextBlockedGoalRetrySlot, noProgressRetryDelayMs, releaseGoalOwnerAnswerHold,
  RUNTIME_RETRY_CLEANUP_WINDOW_MS, scheduleBlockedGoalRetry, pendingBlockedGoalRetry, liveLongRunAttemptCount, type BlockedGoalRetry, type LongRunRecord } from "../store/long-runs";
import { NO_PROGRESS_RETRY_LIMIT, VERIFICATION_NO_PROGRESS_REASON } from "../../shared/long-run-checkpoint";
import { appendChatMessage, getChat } from "../store/chats";
import { invocationRunOwners } from "../store/invocation-run-owners";
import { getPendingInvocationAdmissionForChat } from "../store/invocation-admissions";
import { hasQueuedOwnerSteer } from "../store/invocation-steers";
import { emitDesktopStoreChange } from "../store/change-bus";
import { redactSecrets } from "../../shared/secret-patterns";
import { currentUiLocale } from "../ui-locale";
import { latestTaskCheckpoint } from "./checkpoint";
import { HOST_OWNER_CARD_POSTED_KIND, pendingHostOwnerCard } from "./goal-owner-card-decision";
import { desktopAppInstanceId } from "./app-runtime-coordinator";

/*
 * A Goal whose verification keeps finding the same outcome rests; it is neither parked as blocked nor woken by the minute. The host
 * makes no model call in between. When the rest's time comes the host does not rerun the Goal on that timer: it checks that the
 * result reached the owner (settleNoProgressRest), says what stands and what remains if it had not, and then rests until a signal: a
 * new Goal revision (store/long-runs.ts pullForwardNoProgressRetry), an owner message (its own turn), a changed plan, or the wait the
 * Goal registered. A rest whose outcome digest is unchanged and already delivered never reruns the Goal.
 *
 * Why not "blocked": the host reads a requested blocked as running (shared/long-run.ts resolveNonBlockingGoalStatus) and the sweep resumes a
 * Goal within a minute, so the old stop was a name only. X Marketing repeated one result 38 times until the daily wake cap.
 */

/** The rest after a no-progress verification: 30 min at the limit, doubling per further identical verification, 6 h at most. */
export function scheduleNoProgressRetry(runId: string, noProgressRetries: number, nowMs = Date.now()): LongRunRecord | null {
  const run = getLongRun(runId);
  // A Goal resting for the owner (their own pause, or the answer to a question the turn asked) keeps that hold: nothing is scheduled under it.
  if (!run || run.surface === "science" || longRunOwnerHold(run.id) || goalOwnerAnswerHold(run.id)) return null;
  let appInstanceId: string | null = null;
  try { appInstanceId = desktopAppInstanceId(); } catch { /* a process without the coordinator writes the retry without an instance id */ }
  return scheduleBlockedGoalRetry({ runId: run.id, expectedVersion: run.version, kind: "resume",
    // The counter lives in the checkpoint, never in this reason: a reason that changed on every turn made the AGI state fingerprint
    // open a new incident each time.
    fromReason: VERIFICATION_NO_PROGRESS_REASON, retryIndex: Math.max(0, Math.floor(noProgressRetries)),
    nextAt: new Date(nowMs + noProgressRetryDelayMs(noProgressRetries)).toISOString(),
    detail: VERIFICATION_NO_PROGRESS_REASON, trigger: "verification-no-progress", appInstanceId, requestedBy: "host" });
}

/**
 * Startup, once per store (an idempotent query): a Goal an earlier build held for the host's own "idle stop" card goes back onto a retry
 * schedule. That card was fixed host text, not a question the model asked, and nothing woke the Goal while it stood. The card message
 * stays as history and the owner's pick on it is still read (goal-owner-card-decision.ts). A hold the Goal's own later question took over
 * (a newer run.owner_answer_pending) is the model's real question and is left alone. A Goal idle for more than seven days (the window
 * rescheduleExhaustedRuntimeRetryGoals uses) is not woken: a forgotten Goal does not start a model turn when the app updates. Returns the number moved.
 */
export function releaseIdleStopCardHolds(options: { nowMs?: number; random?: () => number } = {}): number {
  const nowMs = options.nowMs ?? Date.now();
  const since = new Date(nowMs - RUNTIME_RETRY_CLEANUP_WINDOW_MS).toISOString();
  const rows = getDb().prepare(`SELECT r.id AS id FROM long_runs r WHERE r.status='waiting_tool' AND r.surface!='science'
    AND r.blocked_reason='goal_owner_answer_required' AND r.updated_at>=? AND EXISTS (
      SELECT 1 FROM long_run_events e WHERE e.run_id=r.id AND e.kind=?)`).all(since, HOST_OWNER_CARD_POSTED_KIND) as { id: string }[];
  let moved = 0;
  for (const row of rows) {
    try {
      const card = pendingHostOwnerCard(row.id);
      if (!card || card.cardKind !== "goal_idle_stop") continue;
      const newer = getDb().prepare("SELECT 1 FROM long_run_events WHERE run_id = ? AND kind = 'run.owner_answer_pending' AND seq > ? LIMIT 1").get(row.id, card.seq);
      if (newer) continue;
      const held = getLongRun(row.id);
      if (!held || longRunOwnerHold(row.id)) continue;
      let appInstanceId: string | null = null;
      try { appInstanceId = desktopAppInstanceId(); } catch { /* see above */ }
      const released = releaseGoalOwnerAnswerHold({ runId: row.id, expectedVersion: held.version, reason: "idle_stop_card_retired", appInstanceId });
      // 30 s plus up to 5 min of jitter, so a burst of Goals does not wake together.
      const jitter = Math.floor(Math.min(0.999999, Math.max(0, (options.random ?? Math.random)())) * 5 * 60_000);
      scheduleBlockedGoalRetry({ runId: row.id, expectedVersion: released.version, kind: "resume", fromReason: "idle_stop_card_retired",
        retryIndex: nextBlockedGoalRetrySlot(row.id, nowMs).retryIndex, nextAt: new Date(nowMs + 30_000 + jitter).toISOString(),
        detail: "idle_stop_card_retired", trigger: "startup-cleanup", appInstanceId, requestedBy: "host" });
      moved += 1;
    } catch (error) { console.warn("[long-run] could not release an idle-stop card hold:", error); }
  }
  return moved;
}

/** Ledger fact: this outcome digest's result was shown to the owner (a chat message already did, or the host posted one). Once per digest. */
export const NO_PROGRESS_REST_DELIVERED_KIND = "run.no_progress_rest_delivered";

/** Runs whose current rest was already settled by this process, by the retry event that scheduled it: the sweep asks every minute. */
const restSettled = new Map<string, number>();
const REST_SETTLED_LIMIT = 256;
function noteRestSettled(runId: string, seq: number): void {
  restSettled.delete(runId); restSettled.set(runId, seq);
  while (restSettled.size > REST_SETTLED_LIMIT) restSettled.delete(restSettled.keys().next().value as string);
}

/** The trigger the due retry was scheduled with (the event is the machine record; a signal pulls it forward under another trigger). */
function retryTrigger(runId: string, seq: number): string | null {
  try {
    const row = getDb().prepare("SELECT payload_json FROM long_run_events WHERE run_id = ? AND seq = ?").get(runId, seq) as { payload_json: string } | undefined;
    const trigger = row ? (JSON.parse(row.payload_json) as { trigger?: unknown }).trigger : null;
    return typeof trigger === "string" ? trigger : null;
  } catch { return null; }
}

function restDelivered(runId: string, digest: string): boolean {
  return Boolean(getDb().prepare(`SELECT 1 FROM long_run_events WHERE run_id = ? AND kind = ? AND json_extract(payload_json, '$.digest') = ? LIMIT 1`)
    .get(runId, NO_PROGRESS_REST_DELIVERED_KIND, digest));
}

/** True while the Goal rests on an unchanged, already delivered outcome (readers show "resting", not a next try that will not come). */
export function noProgressRestSettled(runId: string, retry: BlockedGoalRetry | null): boolean {
  if (!retry || retry.fromReason !== VERIFICATION_NO_PROGRESS_REASON) return false;
  if (restSettled.get(runId) === retry.seq) return true;
  try {
    const run = getLongRun(runId);
    const checkpoint = run ? latestTaskCheckpoint(run.goalId) : null;
    return Boolean(checkpoint?.outcomeDigest && retryTrigger(runId, retry.seq) === "verification-no-progress" && restDelivered(runId, checkpoint.outcomeDigest));
  } catch { return false; }
}

/** The longest part of the producing turn's own report the rest message carries; the rest stays in the run record. */
const REST_REPORT_BODY_CHARS = 3500;

/** The newest non-empty report body the invocation recorded (run-events recordWorkerReport), or null. Private bodies never enter generic pages; this reads a few rows of one run. */
function latestInvocationReport(invocationRunId: string | null): { text: string; truncated: boolean } | null {
  if (!invocationRunId) return null;
  try {
    const rows = getDb().prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND kind = 'worker_report_snapshot' ORDER BY seq DESC LIMIT 8")
      .all(invocationRunId) as Array<{ payload_json: string }>;
    for (const row of rows) {
      try {
        const report = JSON.parse((JSON.parse(row.payload_json) as { workerReportJson?: string }).workerReportJson ?? "null") as { text?: unknown; truncated?: unknown } | null;
        if (report && typeof report.text === "string" && report.text.trim()) return { text: report.text, truncated: report.truncated === true };
      } catch { /* an unreadable row is skipped */ }
    }
    return null;
  } catch { return null; }
}

function restReportText(locale: "ko" | "en", checkpoint: NonNullable<ReturnType<typeof latestTaskCheckpoint>>,
  report: { text: string; truncated: boolean } | null): string {
  const clip = (text: string) => redactSecrets(String(text ?? "").replace(/\s+/g, " ").trim()).slice(0, 280);
  const criterion = (index: number) => clip(checkpoint.acceptanceCriteria?.[index] ?? "") || `#${index + 1}`;
  const met = checkpoint.nextActions.filter((item) => item.verdict === "passed").map((item) => `- ${criterion(item.criterionIndex)}`);
  const left = checkpoint.nextActions.filter((item) => item.verdict !== "passed").slice(0, 8)
    .map((item) => `- ${criterion(item.criterionIndex)}${item.nextAction || item.reason ? ` (${clip(item.nextAction || item.reason).slice(0, 200)})` : ""}`);
  const ko = locale === "ko";
  // The result itself comes first (what the turn produced); the criteria summary is what stands and what remains below it.
  const body = report ? redactSecrets(report.text.trim()) : "";
  const cut = body.length > REST_REPORT_BODY_CHARS;
  const result = body ? [body.slice(0, REST_REPORT_BODY_CHARS) + (cut || report?.truncated
    ? (ko ? "\n… (전체 보고는 이 실행의 기록에 남아 있습니다)" : "\n… (the full report is kept in this run's record)") : ""), ""] : [];
  return [...result, ko ? "같은 결과가 반복돼 이 목표를 잠시 쉽니다. 지금까지의 정리입니다." : "The same result keeps coming back, so this goal rests for now. Where it stands:",
    ...(met.length ? [ko ? "확인된 것:" : "Confirmed:", ...met] : []),
    ...(left.length ? [ko ? "남은 것:" : "Remaining:", ...left] : []),
    ko ? "새 지시를 주시거나 입력이 바뀌면 바로 이어갑니다." : "I continue as soon as you give a new instruction or the inputs change."].join("\n");
}

/**
 * The rest's time has come. True: the Goal keeps resting and no model is started (the caller defers). False: a signal brought this
 * retry (a pulled-forward or otherwise scheduled one), or nothing proves the outcome is the unchanged one: the caller runs it as before.
 * Delivery is once per outcome digest and atomic across processes. The host posts what stands and what remains
 * because older chat rows do not prove which turn produced them.
 */
export function settleNoProgressRest(run: LongRunRecord, retry: BlockedGoalRetry): boolean {
  if (retry.fromReason !== VERIFICATION_NO_PROGRESS_REASON || !run.rootChatId) return false;
  if (restSettled.get(run.id) === retry.seq) return true;
  try {
    // Only the retry the verifier scheduled from the idle-spin rest is a timer; a pulled-forward one is a signal and runs.
    if (retryTrigger(run.id, retry.seq) !== "verification-no-progress") return false;
    const checkpoint = latestTaskCheckpoint(run.goalId);
    const digest = checkpoint?.outcomeDigest;
    // No readable checkpoint (the plan or revision moved) or an unknown digest is not "the same result".
    if (!checkpoint || !digest || (checkpoint.noProgressRetries ?? 0) < NO_PROGRESS_RETRY_LIMIT) return false;
    const chatId = run.rootChatId;
    // Delivered already (every sweep after a restart asks): read without the write lock and stop here.
    if (restDelivered(run.id, digest)) { noteRestSettled(run.id, retry.seq); return true; }
    const settled = getDb().transaction(() => {
      const current = getLongRun(run.id);
      const currentRetry = pendingBlockedGoalRetry(run.id);
      const currentCheckpoint = latestTaskCheckpoint(run.goalId);
      const admission = getPendingInvocationAdmissionForChat(chatId);
      if (!current || current.version !== run.version || current.status !== run.status
        || current.goalId !== run.goalId || current.rootChatId !== chatId
        || longRunOwnerHold(run.id) || goalOwnerAnswerHold(run.id)
        || getChat(chatId)?.goalId !== run.goalId || currentRetry?.seq !== retry.seq
        || currentCheckpoint?.checkpointId !== checkpoint.checkpointId || currentCheckpoint.outcomeDigest !== digest
        || liveLongRunAttemptCount(run.id) > 0 || invocationRunOwners.getActiveOwner(chatId)
        || (admission && Date.now() - Date.parse(admission.pendingAt) < 120_000)
        || hasQueuedOwnerSteer(chatId)) return false;
      if (restDelivered(run.id, digest)) return true;
      appendChatMessage(chatId, "assistant", restReportText(currentUiLocale() === "ko" ? "ko" : "en", checkpoint, latestInvocationReport(checkpoint.invocationRunId)), { noGoalResult: true });
      appendLongRunEvent({ runId: run.id, kind: NO_PROGRESS_REST_DELIVERED_KIND, actorKind: "host",
        payload: { digest, checkpointId: checkpoint.checkpointId, posted: true } });
      return true;
    }).immediate();
    // The caller must defer a stale snapshot, not reopen its old retry.
    if (!settled) return true;
    emitDesktopStoreChange({ entity: "chat", id: chatId });
    noteRestSettled(run.id, retry.seq);
    return true;
  } catch (error) {
    // A failed look never starts a paid turn by itself and never claims delivery: the next sweep looks again.
    console.warn("[long-run] no-progress rest not settled:", error);
    return true;
  }
}
