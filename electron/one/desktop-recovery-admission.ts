import { createHash, randomUUID } from "node:crypto";
import type { McpInvocationRequest, OneAutoRecoveryJudgement, OneAutoRecoveryVerification } from "../../shared/types";
import { ONE_AUTO_RECOVERY_MAX_ATTEMPTS, oneAutoRecoveryTerminalStop } from "../../shared/one-auto-recovery";
import { getDb } from "../store/db";
import { getChat } from "../store/chats";
import { getChatGoalRevision } from "../store/chat-goals";
import { getLongRunByGoalId, longRunOwnerHold } from "../store/long-runs";
import { getInvocationRunReceipt, getLatestInvocationRunReceipt, getRunEventBySource, recordRunEvent } from "../store/run-events";

const REQUEST = "one_controller_recovery_requested";
const LINK = "one_controller_recovery_link";
const LINK_SOURCE = "one-desktop-recovery-link";
type Advice = OneAutoRecoveryJudgement | OneAutoRecoveryVerification;
interface Reservation {
  originalRunId: string; parentRunId: string; nextRunId: string; ordinal: number; scopeDigest: string;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function reservation(value: unknown): Reservation {
  const p = value as Partial<Reservation> | null;
  if (!p || [p.originalRunId, p.parentRunId, p.nextRunId].some(id => typeof id !== "string" || !id || id.length > 240)
    || p.nextRunId === p.parentRunId || p.nextRunId === p.originalRunId
    || !Number.isSafeInteger(p.ordinal) || p.ordinal! < 1 || p.ordinal! > ONE_AUTO_RECOVERY_MAX_ATTEMPTS
    || typeof p.scopeDigest !== "string" || !/^[0-9a-f]{64}$/.test(p.scopeDigest)) throw new Error("one_recovery_reservation_invalid");
  return { originalRunId: p.originalRunId!, parentRunId: p.parentRunId!, nextRunId: p.nextRunId!, ordinal: p.ordinal!, scopeDigest: p.scopeDigest };
}

/** Controller identity is the original invocation, never a renderer mount or a tool-name bucket. */
export function desktopOneRecoveryContext(runId: string, chatId: string): { originalRunId: string; attemptsSpent: number } {
  const link = getRunEventBySource(runId, LINK_SOURCE);
  let originalRunId = runId;
  if (link) {
    if (link.chatId !== chatId || link.kind !== LINK) throw new Error("one_recovery_link_invalid");
    const p = reservation(link.payload);
    if (p.nextRunId !== runId) throw new Error("one_recovery_link_invalid");
    const root = getRunEventBySource(p.originalRunId, `one-desktop-recovery:${p.ordinal}`);
    if (!root || root.chatId !== chatId || root.kind !== REQUEST
      || JSON.stringify(reservation(root.payload)) !== JSON.stringify(p)) throw new Error("one_recovery_root_unconfirmed");
    originalRunId = p.originalRunId;
  }
  const original = getInvocationRunReceipt(originalRunId);
  if (!original || original.chatId !== chatId || !["failed", "interrupted"].includes(original.status)
    || oneAutoRecoveryTerminalStop(original)) throw new Error("one_recovery_original_not_current");
  const rows = getDb().prepare("SELECT payload_json FROM run_events WHERE run_id=? AND kind=? ORDER BY seq")
    .all(originalRunId, REQUEST) as Array<{ payload_json: string }>;
  for (let i = 0; i < rows.length; i++) {
    const p = reservation(JSON.parse(rows[i]!.payload_json));
    if (p.originalRunId !== originalRunId || p.ordinal !== i + 1) throw new Error("one_recovery_counter_invalid");
  }
  return { originalRunId, attemptsSpent: rows.length };
}

/** A remounted view has no lineage in memory. Only a saved child link can
 * identify a completed recovery; ordinary completion needs no assessment. */
export function desktopOneRecoveryOriginalRunId(runId: string, chatId: string): string | null {
  if (!getRunEventBySource(runId, LINK_SOURCE)) return null;
  return desktopOneRecoveryContext(runId, chatId).originalRunId;
}

/** Capture existing host evidence. Auxiliary accounting/admission rows are not a new user direction. */
export function desktopOneRecoveryScope(runId: string, chatId: string): string | null {
  const chat = getChat(chatId), receipt = getInvocationRunReceipt(runId);
  if (!chat || !receipt || receipt.chatId !== chatId || getLatestInvocationRunReceipt(chatId)?.runId !== runId
    || !receipt.finishedAt || oneAutoRecoveryTerminalStop(receipt)
    || !["failed", "interrupted", "completed"].includes(receipt.status)) return null;
  const start = getDb().prepare("SELECT id,payload_json FROM run_events WHERE run_id=? AND chat_id=? AND kind='invoke_started' LIMIT 1")
    .get(runId, chatId) as { id: string; payload_json: string } | undefined;
  if (!start || JSON.parse(start.payload_json).oneMode !== true) return null;
  const goal = chat.goalId ? getChatGoalRevision(chat.goalId) : null;
  const longRun = chat.goalId ? getLongRunByGoalId(chat.goalId) : null;
  if (longRun && (longRunOwnerHold(longRun.id)
    || ["completed", "cancelled", "cancelling", "failed", "pausing"].includes(longRun.status))) return null;
  const control = longRun ? getDb().prepare(`SELECT MAX(seq) seq FROM long_run_events
    WHERE run_id=? AND kind='run.user_control' AND actor_kind='user'`).get(longRun.id) as { seq: number | null } : null;
  const user = getDb().prepare("SELECT MAX(rowid) cursor FROM chat_messages WHERE chat_id=? AND role='user'")
    .get(chatId) as { cursor: number | null };
  // The invocation already recorded the user-turn cursor at admission. A
  // fresh read cannot adopt a later user message as authority for an old run.
  if ((JSON.parse(start.payload_json).latestUserMessageRowId ?? null) !== user.cursor) return null;
  const evidence = getDb().prepare(`SELECT id FROM run_events WHERE run_id=?
    AND kind NOT IN ('runtime_usage_started','runtime_usage_recorded','one_recovery_outcome_assessed',?,?) ORDER BY seq`).all(runId, REQUEST, LINK);
  return digest([runId, chatId, start.id, evidence, user.cursor, chat.goalId, goal?.revision, goal?.lifecycle,
    longRun?.id, control?.seq, chat.runtimeSelection]);
}

/** A dropped advice response reuses its exact saved request; it never spends a second slot. */
export function pendingDesktopOneRecovery(runId: string, chatId: string, capturedScope: string): (Reservation & { advice: Advice }) | null {
  if (typeof capturedScope !== "string" || !/^[0-9a-f]{64}$/.test(capturedScope)) return null;
  if (desktopOneRecoveryScope(runId, chatId) !== capturedScope) return null;
  const context = desktopOneRecoveryContext(runId, chatId);
  const row = context.attemptsSpent ? getRunEventBySource(context.originalRunId, `one-desktop-recovery:${context.attemptsSpent}`) : null;
  if (!row) return null;
  const p = reservation(row.payload);
  const diagnosis = row.payload?.adviceDiagnosis, decidedBy = row.payload?.adviceDecidedBy;
  if (p.parentRunId !== runId || p.scopeDigest !== capturedScope || getInvocationRunReceipt(p.nextRunId)
    || !parentMayContinue(p, chatId) || typeof diagnosis !== "string"
    || !["form", "llm", "unavailable"].includes(String(decidedBy))) return null;
  const advice: Advice = row.payload?.adviceVerified === false && decidedBy !== "form"
    ? { verified: false, retry: true, attempt: p.ordinal, diagnosis, decidedBy: decidedBy as "llm" | "unavailable",
      originalRunId: p.originalRunId, recoveryRunId: p.parentRunId,
      ...(typeof row.payload.adviceAssessmentReceiptId === "string" ? { assessmentReceiptId: row.payload.adviceAssessmentReceiptId } : {}) }
    : { retry: true, attempt: p.ordinal, diagnosis, decidedBy: decidedBy as "form" | "llm" | "unavailable",
      fingerprint: typeof row.payload?.adviceFingerprint === "string" ? row.payload.adviceFingerprint : "" };
  return { ...p, advice };
}

function parentMayContinue(p: Reservation, chatId: string): boolean {
  const parent = getInvocationRunReceipt(p.parentRunId);
  if (!parent || parent.chatId !== chatId || parent.executionPermission !== "read" || oneAutoRecoveryTerminalStop(parent)) return false;
  if (["failed", "interrupted"].includes(parent.status)) return true;
  if (parent.status !== "completed") return false;
  const row = getDb().prepare(`SELECT payload_json FROM run_events WHERE run_id=? AND chat_id=?
    AND kind='one_recovery_outcome_assessed' ORDER BY seq DESC LIMIT 1`).get(p.parentRunId, chatId) as { payload_json: string } | undefined;
  const assessment = row ? JSON.parse(row.payload_json) : null;
  return assessment?.originalRunId === p.originalRunId && assessment.recoveryRunId === p.parentRunId && assessment.outcome === "retry";
}

/** Reserve a specific next run before returning advice. A lost IPC response preserves that reservation. */
export function reserveDesktopOneRecovery(runId: string, chatId: string, capturedScope: string, advice: Advice): Reservation | null {
  if (!advice.retry || typeof capturedScope !== "string" || !/^[0-9a-f]{64}$/.test(capturedScope)) return null;
  return getDb().transaction(() => {
    if (desktopOneRecoveryScope(runId, chatId) !== capturedScope) return null;
    const context = desktopOneRecoveryContext(runId, chatId);
    const previous = context.attemptsSpent ? getRunEventBySource(context.originalRunId, `one-desktop-recovery:${context.attemptsSpent}`) : null;
    if (previous) {
      const old = reservation(previous.payload);
      if (old.parentRunId === runId && old.scopeDigest === capturedScope && !getInvocationRunReceipt(old.nextRunId)) return old;
      // Every preceding request must have reached the exact now-terminal parent.
      if (old.nextRunId !== runId || !getInvocationRunReceipt(old.nextRunId)?.finishedAt) return null;
    }
    if (context.attemptsSpent >= ONE_AUTO_RECOVERY_MAX_ATTEMPTS) return null;
    const next: Reservation = { originalRunId: context.originalRunId, parentRunId: runId, nextRunId: randomUUID(),
      ordinal: context.attemptsSpent + 1, scopeDigest: capturedScope };
    if (!parentMayContinue(next, chatId)) return null;
    const root = recordRunEvent({ runId: next.originalRunId, chatId, kind: REQUEST,
      sourceEventId: `one-desktop-recovery:${next.ordinal}`, payload: { ...next,
        adviceDiagnosis: advice.diagnosis.slice(0, 1_000), adviceDecidedBy: advice.decidedBy,
        ...("verified" in advice ? { adviceVerified: advice.verified, adviceAssessmentReceiptId: advice.assessmentReceiptId }
          : { adviceFingerprint: advice.fingerprint }) } });
    const link = recordRunEvent({ runId: next.nextRunId, chatId, kind: LINK, sourceEventId: LINK_SOURCE, payload: { ...next } });
    if (JSON.stringify(reservation(root.payload)) !== JSON.stringify(next)
      || JSON.stringify(reservation(link.payload)) !== JSON.stringify(next)
      || desktopOneRecoveryContext(next.nextRunId, chatId).attemptsSpent !== next.ordinal) throw new Error("one_recovery_admission_not_durable");
    return next;
  }).immediate();
}

/** Main checks the saved request at both entry and the actual durable start boundary. */
export function assertDesktopOneRecoveryStart(request: Pick<McpInvocationRequest, "runId" | "chatId" | "oneMode" | "permissions" | "promptOrigin">): void {
  if (!request.runId) return;
  const link = getRunEventBySource(request.runId, LINK_SOURCE);
  if (!link) return; // An ordinary user request and explicit Retry have their own admission.
  const p = reservation(link.payload);
  const context = desktopOneRecoveryContext(request.runId, request.chatId);
  if (link.chatId !== request.chatId || link.kind !== LINK || p.nextRunId !== request.runId
    || !request.oneMode || request.promptOrigin !== "system" || request.permissions !== "read"
    || context.originalRunId !== p.originalRunId || context.attemptsSpent < p.ordinal
    || getInvocationRunReceipt(request.runId) || !parentMayContinue(p, request.chatId)
    || desktopOneRecoveryScope(p.parentRunId, request.chatId) !== p.scopeDigest) {
    throw new Error("one_recovery_start_scope_changed");
  }
}
