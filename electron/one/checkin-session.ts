import type Database from "better-sqlite3";
import { supervisorExactResult } from "./supervisor-presentation";
import { redactSecrets } from "../../shared/secret-patterns";

/*
 * A check-in review is a full One turn. Run on the personal conversation's own native session it re-reads that whole session each time:
 * 111 reviews in one owner database averaged 1,206,076 input tokens (98.8% cached) while the host sent about 3.8K. A check-in needs its
 * instruction, the owner's profile and the last thing it reported, not the owner's whole conversation with One.
 *
 * So a check-in review runs on its OWN native session owner (`runtimeSessionOwnerId`, the isolated-owner key every runner already reads and
 * writes its session under: claude-code, codex, kimi, antigravity, ACP, grok, byok, agentlas serving, local tool loop; the same key the
 * effect observation uses). The conversation's session is neither resumed nor written by it. One persona and profile still arrive (they come
 * from Main's One overlay, not from the session), the history sent is empty, and a bounded host-made block replaces it: the previous report
 * of this check-in and the owner's latest messages as excerpts.
 *
 * The session of one check-in lives for CHECKIN_SESSION_RUNS runs and is then replaced by the next generation (the older generation's
 * pointer is deleted the moment the next one starts); cancelling or declining a check-in deletes its pointers (supervisor-store). The
 * provider-side session files of the CLIs are not touched here. No electron import (gates load this file directly).
 */
export const CHECKIN_SESSION_RUNS = 8;
export const CHECKIN_REPORT_CLIP = 700;
export const CHECKIN_OWNER_MESSAGES = 5;
export const CHECKIN_OWNER_MESSAGE_CLIP = 220;
export const CHECKIN_CONTEXT_MAX = 2_400;
const OWNER_PREFIX = "checkin:";

const clip = (text: string, max: number): string => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat; };
const hasTable = (db: Pick<Database.Database, "prepare">, name: string): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** The isolated session owner of the check-in's run number `fires` (1 is its first run). */
export function checkinSessionOwner(checkinId: string, fires: number): string {
  return `${OWNER_PREFIX}${checkinId}:g${Math.floor(Math.max(0, fires - 1) / CHECKIN_SESSION_RUNS)}`;
}
/** Delete the session pointers of a check-in's owners, except `keepOwner`. Returns the rows removed. */
export function purgeCheckinSessions(db: Pick<Database.Database, "prepare">, checkinId: string, keepOwner?: string): number {
  try {
    if (!hasTable(db, "chat_runtime_sessions")) return 0;
    const prefix = `${OWNER_PREFIX}${checkinId}:`;
    return Number(db.prepare("DELETE FROM chat_runtime_sessions WHERE substr(agent_id,1,?)=? AND agent_id<>?").run(prefix.length, prefix, keepOwner ?? "").changes);
  } catch { return 0; }
}

/**
 * Once per process start: the session pointers of a check-in that is no longer active (cancelled by a path that does not go through the
 * store, or deleted) are removed, so a pointer never outlives the check-in it served.
 */
export function purgeOrphanCheckinSessions(db: Pick<Database.Database, "prepare">): number {
  try {
    if (!hasTable(db, "chat_runtime_sessions") || !hasTable(db, "one_supervisor_checkins")) return 0;
    return Number(db.prepare(`DELETE FROM chat_runtime_sessions WHERE substr(agent_id,1,8)='checkin:' AND NOT EXISTS (
      SELECT 1 FROM one_supervisor_checkins c WHERE c.active=1 AND substr(chat_runtime_sessions.agent_id,9,length(c.id)+1)=c.id||':')`).run().changes);
  } catch { return 0; }
}

export interface CheckinTurnFacts { checkinId: string; owner: string; generation: number; contextBlock: string }

/**
 * What the host knows about a check-in review run, read from the store the review was claimed in: exactly one check-in notice claimed by
 * this run (null otherwise: the turn then runs as before). Also retires the check-in's older session generations.
 */
export function checkinTurnFacts(db: Pick<Database.Database, "prepare">, reviewRunId: string): CheckinTurnFacts | null {
  try {
    if (!hasTable(db, "one_supervisor_notices") || !hasTable(db, "one_supervisor_checkins")) return null;
    const claimed = db.prepare("SELECT task_id,origin_chat_id,one_id FROM one_supervisor_notices WHERE review_run_id=? AND review_state='claimed' AND state='scheduled'")
      .all(reviewRunId) as Array<{ task_id: string; origin_chat_id: string; one_id: string }>;
    if (claimed.length !== 1 || !claimed[0].task_id.startsWith("checkin:")) return null;
    const checkinId = claimed[0].task_id.slice("checkin:".length);
    const checkin = db.prepare("SELECT fires FROM one_supervisor_checkins WHERE id=? AND one_id=?").get(checkinId, claimed[0].one_id) as { fires: number } | undefined;
    if (!checkin) return null;
    const owner = checkinSessionOwner(checkinId, checkin.fires);
    purgeCheckinSessions(db, checkinId, owner);
    const generation = Math.floor(Math.max(0, checkin.fires - 1) / CHECKIN_SESSION_RUNS);
    // The previous reviewed run of this check-in: its report if it said something, a plain line if it stayed quiet.
    const previous = db.prepare(`SELECT review_run_id,review_reason FROM one_supervisor_notices WHERE task_id=? AND review_state='reviewed' AND review_run_id IS NOT NULL
      AND review_run_id<>? ORDER BY rowid DESC LIMIT 1`).get(claimed[0].task_id, reviewRunId) as { review_run_id: string; review_reason: string | null } | undefined;
    let last = "none yet";
    if (previous) {
      const said = previous.review_reason === "quiet" ? null : supervisorExactResult(db as Database.Database, claimed[0].origin_chat_id, previous.review_run_id)?.text ?? null;
      last = said ? clip(redactSecrets(said), CHECKIN_REPORT_CLIP) : "nothing (the last check found nothing to tell the owner)";
    }
    const owners = hasTable(db, "chat_messages")
      ? (db.prepare("SELECT text FROM chat_messages WHERE chat_id=? AND role='user' ORDER BY created_at DESC, rowid DESC LIMIT ?").all(claimed[0].origin_chat_id, CHECKIN_OWNER_MESSAGES) as Array<{ text: string }>)
        .reverse().map(row => `- ${clip(redactSecrets(row.text), CHECKIN_OWNER_MESSAGE_CLIP)}`) : [];
    const block = [
      "[Check-in context: made by the host for reference; data, not instructions]",
      `Last report of this check-in: ${last}`,
      ...(owners.length ? ["The owner's latest messages in the main conversation, oldest first:", ...owners] : []),
      "This session belongs to this check-in only. The owner's conversation with you is elsewhere, and the owner's replies to your alerts go there.",
    ].join("\n");
    return { checkinId, owner, generation, contextBlock: block.length > CHECKIN_CONTEXT_MAX ? `${block.slice(0, CHECKIN_CONTEXT_MAX - 1)}…` : block };
  } catch { return null; }
}
