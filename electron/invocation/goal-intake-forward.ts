/**




















 */
import { LONG_RUN_TERMINAL_STATUSES } from "../../shared/long-run";
import { DeviceBridgeError, daemonDeviceBridge } from "../daemon/device-bridge";
import { getDb } from "../store/db";
import { getChat } from "../store/chats";
import { getLongRunByGoalId } from "../store/long-runs";
import { tryRecordRunEvent } from "../store/run-events";
import { followDaemonTurnGoal } from "../long-run/daemon-turn-goal";
import { isGoalAdmittingDecision, prepareInvocationAutomaticGoal } from "./automatic-goal";

export type GoalIntakePermission = "read" | "write" | "full";
export interface GoalIntakeForward { runId: string; chatId: string; sourceMessageId: string; permission: GoalIntakePermission }

export const GOAL_INTAKE_FORWARDED_EVENT = "automatic_goal_intake_forwarded";
export const GOAL_INTAKE_DEFERRED_EVENT = "automatic_goal_intake_deferred";
export const GOAL_INTAKE_COMPLETED_EVENT = "automatic_goal_intake_completed";
/** Outcomes that end a marker. `unavailable` does not: a later attach tries again. */
const TERMINAL_OUTCOMES = ["admitted", "bypass", "already_admitted", "chat_already_bound", "source_invalid"] as const;
/** A marker older than this is not replayed: a person who asked for something days ago has moved on. */
export const GOAL_INTAKE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const DRAIN_LIMIT = 20;

const goalIdFor = (sourceMessageId: string): string => `goal:auto-message:${sourceMessageId}`;

/* ─────────── service half ─────────── */

type Handover = Pick<ReturnType<typeof daemonDeviceBridge>, "forwardGoalIntake">;

/** Hand a Goal-bound owner message to Main, or leave a durable marker when Main cannot take it now. */
export async function handGoalIntakeToMain(input: GoalIntakeForward, bridge: Handover = daemonDeviceBridge()): Promise<"forwarded" | "deferred"> {
  const base = { sourceMessageId: input.sourceMessageId, permission: input.permission };
  try {
    const reply = await bridge.forwardGoalIntake(input);
    tryRecordRunEvent({ runId: input.runId, chatId: input.chatId, kind: GOAL_INTAKE_FORWARDED_EVENT,
      payload: { ...base, reason: reply.status === "duplicate" ? "main_already_has_it" : "goal_custody_desktop_only" } });
    return "forwarded";
  } catch (error) {
    const code = error instanceof DeviceBridgeError ? String(error.code) : "device_bridge_unavailable";
    tryRecordRunEvent({ runId: input.runId, chatId: input.chatId, kind: GOAL_INTAKE_DEFERRED_EVENT,
      payload: { ...base, reason: /^[a-z][a-z0-9_]{1,99}$/.test(code) ? code : "device_bridge_unavailable" } });
    return "deferred";
  }
}

/** Classify a daemon-run owner message exactly as Desktop would; forward it only when Desktop would make it a Goal. */
export async function classifyAndHandGoalIntakeToMain(input: GoalIntakeForward & { userPrompt: string; attachmentOnly?: boolean; signal: AbortSignal },
  handover?: Handover): Promise<"forwarded" | "deferred" | "not_goal"> {
  const prepared = await prepareInvocationAutomaticGoal({ runId: input.runId, chatId: input.chatId, sourceMessageId: input.sourceMessageId,
    userPrompt: input.userPrompt, permission: input.permission, signal: input.signal, attachmentOnly: input.attachmentOnly, classifyOnly: true });
  if (prepared.kind !== "bypass" || !isGoalAdmittingDecision(prepared.decision) || input.signal.aborted) return "not_goal";
  return handGoalIntakeToMain(input, handover);
}

/* ─────────── Main half ─────────── */

const inFlight = new Map<string, Promise<void>>();
const key = (chatId: string, sourceMessageId: string): string => `${chatId}\u0000${sourceMessageId}`;
const idLike = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value);

function intakeDone(chatId: string, sourceMessageId: string): boolean {
  const marks = TERMINAL_OUTCOMES.map(() => "?").join(",");
  return !!getDb().prepare(`SELECT 1 FROM run_events WHERE kind = ? AND chat_id = ? AND json_extract(payload_json, '$.sourceMessageId') = ?
    AND json_extract(payload_json, '$.outcome') IN (${marks}) LIMIT 1`).get(GOAL_INTAKE_COMPLETED_EVENT, chatId, sourceMessageId, ...TERMINAL_OUTCOMES);
}

/** Main verifies the claim against durable rows before it creates anything: the message is a user message of that chat. */
function validateSource(input: GoalIntakeForward): { text: string } | { error: string } {
  const row = getDb().prepare("SELECT chat_id, role, text FROM chat_messages WHERE id = ?").get(input.sourceMessageId) as
    { chat_id: string; role: string; text: string } | undefined;
  if (!row || row.role !== "user" || row.chat_id !== input.chatId) return { error: "goal_intake_source_invalid" };
  const owner = getDb().prepare("SELECT chat_id, owner_kind FROM invocation_run_owners WHERE run_id = ?").get(input.runId) as
    { chat_id: string; owner_kind: string } | undefined;
  if (!owner || owner.chat_id !== input.chatId || owner.owner_kind !== "daemon") return { error: "goal_intake_run_invalid" };
  return { text: row.text };
}

async function performIntake(input: GoalIntakeForward, text: string): Promise<void> {
  const done = (outcome: string, reason: string, extra: Record<string, unknown> = {}): void => {
    tryRecordRunEvent({ runId: input.runId, chatId: input.chatId, kind: GOAL_INTAKE_COMPLETED_EVENT,
      payload: { sourceMessageId: input.sourceMessageId, outcome, reason, ...extra } });
  };
  try {
    const chat = getChat(input.chatId);
    if (!chat) return done("source_invalid", "chat_missing");
    const bound = chat.goalId ? getLongRunByGoalId(chat.goalId) : null;
    if (bound && bound.goalId === goalIdFor(input.sourceMessageId)) return done("already_admitted", "goal_exists", { goalId: bound.goalId });
    if (bound && !LONG_RUN_TERMINAL_STATUSES.has(bound.status)) return done("chat_already_bound", "live_goal_in_chat", { goalId: bound.goalId });
    const own = getLongRunByGoalId(goalIdFor(input.sourceMessageId));
    if (own) return done("already_admitted", "goal_exists", { goalId: own.goalId });
    const prepared = await prepareInvocationAutomaticGoal({ runId: input.runId, chatId: input.chatId, sourceMessageId: input.sourceMessageId,
      userPrompt: text, permission: input.permission, signal: new AbortController().signal });
    if (prepared.kind === "admitted") {
      done("admitted", "classified_goal", { goalId: prepared.run.goalId });
      

      try { followDaemonTurnGoal(prepared.run.goalId); } catch (error) { console.warn("[goal-intake] Goal could not follow its service turn:", error); }
      return;
    }
    if (prepared.kind === "bypass") return done("bypass", "classified_not_goal");
    return done("unavailable", prepared.reason);
  } catch {
    done("unavailable", "goal_intake_failed");
  }
}

/** Reply at once; the classification and admission run in the background and end in `automatic_goal_intake_completed`. */
export function acceptForwardedGoalIntake(input: GoalIntakeForward): { ok: true; status: "accepted" | "duplicate" } | { ok: false; error: string } {
  if (!idLike(input.runId) || !idLike(input.chatId) || !idLike(input.sourceMessageId) || !["read", "write", "full"].includes(input.permission)) return { ok: false, error: "device_bridge_refused" };
  const k = key(input.chatId, input.sourceMessageId);
  if (inFlight.has(k)) return { ok: true, status: "duplicate" };
  const source = validateSource(input);
  if ("error" in source) return { ok: false, error: source.error };
  if (intakeDone(input.chatId, input.sourceMessageId)) return { ok: true, status: "duplicate" };
  const work = performIntake(input, source.text).finally(() => { inFlight.delete(k); });
  inFlight.set(k, work);
  return { ok: true, status: "accepted" };
}

/** Markers the service left while Main was away (or that Main did not finish), oldest first. */
export function pendingGoalIntakes(now: number = Date.now()): GoalIntakeForward[] {
  const marks = TERMINAL_OUTCOMES.map(() => "?").join(",");
  const rows = getDb().prepare(`SELECT e.run_id, e.chat_id, e.payload_json FROM run_events e
    WHERE e.kind IN (?, ?) AND e.ts > ? AND e.chat_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM run_events c WHERE c.kind = ? AND c.chat_id = e.chat_id
        AND json_extract(c.payload_json, '$.sourceMessageId') = json_extract(e.payload_json, '$.sourceMessageId')
        AND json_extract(c.payload_json, '$.outcome') IN (${marks}))
    ORDER BY e.ts ASC LIMIT ?`).all(GOAL_INTAKE_FORWARDED_EVENT, GOAL_INTAKE_DEFERRED_EVENT, new Date(now - GOAL_INTAKE_MAX_AGE_MS).toISOString(),
      GOAL_INTAKE_COMPLETED_EVENT, ...TERMINAL_OUTCOMES, DRAIN_LIMIT * 2) as Array<{ run_id: string; chat_id: string; payload_json: string }>;
  const seen = new Set<string>(), out: GoalIntakeForward[] = [];
  for (const row of rows) {
    let payload: { sourceMessageId?: unknown; permission?: unknown };
    try { payload = JSON.parse(row.payload_json); } catch { continue; }
    if (!idLike(payload.sourceMessageId) || !["read", "write", "full"].includes(String(payload.permission))) continue;
    const k = key(row.chat_id, payload.sourceMessageId);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ runId: row.run_id, chatId: row.chat_id, sourceMessageId: payload.sourceMessageId, permission: payload.permission as GoalIntakePermission });
    if (out.length >= DRAIN_LIMIT) break;
  }
  return out;
}

/** Main attached (or re-attached): finish every unfinished intake. A marker Main cannot validate ends as `source_invalid`. */
export function drainPendingGoalIntakes(): number {
  let started = 0;
  for (const marker of pendingGoalIntakes()) {
    const reply = acceptForwardedGoalIntake(marker);
    if (!reply.ok) tryRecordRunEvent({ runId: marker.runId, chatId: marker.chatId, kind: GOAL_INTAKE_COMPLETED_EVENT,
      payload: { sourceMessageId: marker.sourceMessageId, outcome: "source_invalid", reason: reply.error } });
    else if (reply.status === "accepted") started += 1;
  }
  return started;
}
