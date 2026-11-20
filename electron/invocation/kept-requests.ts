import { getDb } from "../store/db";
import type { KeptRequestView } from "../../shared/kept-requests";
import {
  HOST_RECOVERY_KEEP_DAYS, HOST_RECOVERY_OUTCOME, hostRecoveryGoalStopped, HOST_RECOVERY_REQUESTED, ownerSpokeAfter, recordHostRecoveryOutcome,
  type HostRecoveryWait,
} from "./host-recovery";

/**
 * The requests the app keeps and continues by itself once an outside cause clears (a usage limit, a sign-in, no connection), shown where a
 * person looks for scheduled work and cancellable from there. The store is the claim row of invocation/host-recovery.ts (`$.wait`); this
 * file only reads it and closes it. Nothing new is stored: the list is derived from the claim rows that are still open, and a cancel is the
 * one outcome row ("skipped", `owner_cancelled`) every waiter of every process already honours (scheduleHostRecovery tick:
 * hostRecoveryClosed), so Desktop Main and the background service agree with no extra signal, and the boot sweep never resumes a closed claim.
 */
export type { KeptRequestView };

const PREVIEW_CHARS = 140;
const LIST_CAP = 50;

type Db = ReturnType<typeof getDb>;

/** One-line preview of the owner's own words; never the host-written context. */
function previewOf(text: string | null): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/gu, " ").trim();
  if (!flat) return null;
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
}

/** The kept requests that are waiting right now: an open claim with a `wait` that is not running, not closed and not superseded by a newer owner message. */
export function listKeptRequests(db: Db = getDb(), nowMs = Date.now()): KeptRequestView[] {
  const keepSince = new Date(nowMs - HOST_RECOVERY_KEEP_DAYS * 24 * 3_600_000).toISOString();
  let rows: Array<{ runId: string; chatId: string | null; ts: string; payloadJson: string }>;
  try {
    rows = db.prepare(`SELECT run_id AS runId, chat_id AS chatId, ts, payload_json AS payloadJson FROM run_events r
      WHERE kind = ? AND ts > ? AND json_type(payload_json, '$.wait') = 'object' AND COALESCE(json_extract(payload_json, '$.parked'), 1) = 1
        AND NOT EXISTS (SELECT 1 FROM run_events o WHERE o.run_id = r.run_id AND o.kind = ?)
      ORDER BY ts DESC LIMIT ?`).all(HOST_RECOVERY_REQUESTED, keepSince, HOST_RECOVERY_OUTCOME, LIST_CAP) as typeof rows;
  } catch { return []; }
  const views: KeptRequestView[] = [];
  for (const row of rows) {
    if (!row.chatId) continue;
    try {
      const payload = JSON.parse(row.payloadJson) as {
        userMessageId?: unknown; wait?: HostRecoveryWait;
        replay?: { startedAtIso?: unknown; prompt?: { text?: unknown }; request?: { permissions?: unknown; onePermissionMode?: unknown } };
      };
      const wait = payload.wait;
      if (!wait || wait.v !== 1) continue;
      const userMessageId = typeof payload.userMessageId === "string" ? payload.userMessageId : null;
      const startedAtIso = typeof payload.replay?.startedAtIso === "string" ? payload.replay.startedAtIso : row.ts;
      // The owner wrote something newer: the app will not run this request (the waiter closes it as skipped at its next look), so it is not kept.
      if (ownerSpokeAfter(db, row.chatId, userMessageId, startedAtIso)) continue;
      // A paused or deleted Goal ends its kept request too: a stopped record is not listed.
      if (hostRecoveryGoalStopped(db, row.runId)) continue;
      const stored = userMessageId
        ? db.prepare("SELECT text FROM chat_messages WHERE id = ? AND chat_id = ? AND role = 'user'").get(userMessageId, row.chatId) as { text?: unknown } | undefined
        : undefined;
      // The owner removed the message: nothing will start for words they took back.
      if (userMessageId && typeof stored?.text !== "string") continue;
      const words = typeof stored?.text === "string" ? stored.text : typeof payload.replay?.prompt?.text === "string" ? payload.replay.prompt.text : null;
      const chat = db.prepare("SELECT title FROM chats WHERE id = ?").get(row.chatId) as { title?: unknown } | undefined;
      if (!chat) continue;
      const next = wait.until ?? wait.probeAt;
      const request = payload.replay?.request;
      views.push({
        id: row.runId, chatId: row.chatId, goalId: goalIdOf(db, row.chatId, row.runId),
        chatTitle: typeof chat.title === "string" && chat.title.trim() ? chat.title.trim() : null,
        promptPreview: previewOf(words),
        cause: typeof wait.cause === "string" ? wait.cause : "unknown",
        keptSince: row.ts,
        nextCheckAt: typeof next === "number" && Number.isFinite(next) ? new Date(next).toISOString() : null,
        asksAgainBeforeEffects: request?.permissions === "full" || request?.onePermissionMode === "full",
      });
    } catch { /* an unreadable claim is not listed; the boot sweep still owns it */ }
  }
  return views;
}

/** The live Goal a kept request belongs to (its claim's evidence names it; a stopped or ended Goal is no owner), else null. */
function goalIdOf(db: Db, chatId: string, runId: string): string | null {
  try {
    const row = db.prepare(`SELECT r.goal_id AS goalId FROM run_events e JOIN long_runs r ON r.goal_id = json_extract(e.payload_json, '$.runtimeEvidence.correlation.goalId')
      WHERE e.run_id = ? AND e.kind = ? AND r.root_chat_id = ? AND r.status NOT IN ('completed','failed','cancelled','cancelling','pausing','paused') LIMIT 1`)
      .get(runId, HOST_RECOVERY_REQUESTED, chatId) as { goalId?: unknown } | undefined;
    return typeof row?.goalId === "string" ? row.goalId : null;
  } catch { return null; }
}

export type CancelKeptRequestResult = { ok: true } | { ok: false; reason: "not_kept" | "unreadable" };

/**
 * The owner's cancel. Terminal and unconditional: it writes the closing outcome of the claim (and empties its restart data), whatever the
 * wait says. A claim that is not open any more (already ran, already cancelled, expired) answers `not_kept` and changes nothing.
 */
export function cancelKeptRequest(id: unknown, db: Db = getDb()): CancelKeptRequestResult {
  if (typeof id !== "string" || !id || id.length > 200) return { ok: false, reason: "not_kept" };
  try {
    const row = db.prepare(`SELECT chat_id AS chatId FROM run_events r WHERE run_id = ? AND kind = ?
      AND NOT EXISTS (SELECT 1 FROM run_events o WHERE o.run_id = r.run_id AND o.kind = ?) LIMIT 1`).get(id, HOST_RECOVERY_REQUESTED, HOST_RECOVERY_OUTCOME) as { chatId: string | null } | undefined;
    if (!row?.chatId) return { ok: false, reason: "not_kept" };
    recordHostRecoveryOutcome(id, row.chatId, "skipped", "owner_cancelled");
    const closed = db.prepare("SELECT 1 FROM run_events WHERE run_id = ? AND kind = ? LIMIT 1").get(id, HOST_RECOVERY_OUTCOME);
    return closed ? { ok: true } : { ok: false, reason: "unreadable" };
  } catch { return { ok: false, reason: "unreadable" }; }
}
