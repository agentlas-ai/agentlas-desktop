/** Goal intake handover from the background service to the window process (Main).
 *
 * Goal custody is Desktop-only, so a daemon-run owner turn cannot admit a Goal itself. Until 2026-10-11 it skipped intake
 * (`goal_custody_desktop_only`), which meant a One chat could never turn "do this every day" into a continuous Goal:
 * production 2026-10-11 10:08Z, room chat 8f3e09ee-0ab7-4d6b-aa0a-8ae7d5e96549, run 97164057-c169-4868-89c0-53ebd22e9c8f,
 * 1.2.96 -- the recurring long-form video brief logged the skip and nothing was created.
 *
 * Do NOT start such turns on Desktop instead (1c62fa88 / 1.2.89 did, and refused every One send). The turn finishes in the
 * service; only the intake moves:
 *  1. service: classify with the same resolver Desktop uses (prepareInvocationAutomaticGoal, classifyOnly). A message that
 *     would not become a Goal forwards nothing.
 *  2. service: ask Main over the device bridge (the existing service -> Main request path). Main is away: durable marker.
 *     Both are run events (`automatic_goal_intake_forwarded` / `_deferred`) that carry what Main needs to redo the work.
 *  3. Main: validate against durable rows (a real owner message of that chat, a daemon-owned run of that chat), answer at
 *     once, then run prepareInvocationAutomaticGoal itself in the background (the native channel closes for good on a request
 *     that outlives 10 s, and classification is a model call). `automatic_goal_intake_completed` ends a marker.
 *  4. Main drains unfinished markers on every attach.
 * Idempotent per source message: the Goal id is `goal:auto-message:<messageId>`, in-flight work is keyed by chat+message, and
 * a terminal completed event ends the marker. Once the chat is bound to a live Goal, ownerTurnStartsOnDesktop routes the next
 * owner turn to Desktop and the A2 chat host handover (runtime/chat-host-handover.ts) releases the service's resident session.
 *
 * No electron import: the background service loads this without Electron (test-daemon-loads-without-electron). */
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
const INTAKE_RETRY_DELAYS_MS = [1_000, 5_000] as const;
const INTAKE_RETRY_COOLDOWN_MS = 60_000;

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
  if (input.signal.aborted) return "not_goal";
  // The classifier could not answer (its runtime was away, its reply unreadable): that says nothing about the message, and dropping it
  // here lost a "do this every day" request for good (no marker, no retry). Main classifies it again with its own retries and cooldown
  // (performIntake), so the message goes over like a Goal-bound one; if Main finds no Goal in it, it ends as an ordinary message there.
  if (prepared.kind === "unavailable") return handGoalIntakeToMain(input, handover);
  if (prepared.kind !== "bypass" || !isGoalAdmittingDecision(prepared.decision)) return "not_goal";
  return handGoalIntakeToMain(input, handover);
}

/* ─────────── Main half ─────────── */

const inFlight = new Map<string, Promise<void>>();
const intakeSignals = new Map<string, AbortSignal>();
const key = (chatId: string, sourceMessageId: string): string => `${chatId}\u0000${sourceMessageId}`;
const idLike = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value);

function intakeDone(chatId: string, sourceMessageId: string): boolean {
  const marks = TERMINAL_OUTCOMES.map(() => "?").join(",");
  return !!getDb().prepare(`SELECT 1 FROM run_events WHERE kind = ? AND chat_id = ? AND json_extract(payload_json, '$.sourceMessageId') = ?
    AND json_extract(payload_json, '$.outcome') IN (${marks}) LIMIT 1`).get(GOAL_INTAKE_COMPLETED_EVENT, chatId, sourceMessageId, ...TERMINAL_OUTCOMES);
}

function intakeCoolingDown(chatId: string, sourceMessageId: string): boolean {
  const row = getDb().prepare(`SELECT json_extract(payload_json, '$.nextRetryAt') AS next_at FROM run_events
    WHERE kind = ? AND chat_id = ? AND json_extract(payload_json, '$.sourceMessageId') = ?
    ORDER BY rowid DESC LIMIT 1`).get(GOAL_INTAKE_COMPLETED_EVENT, chatId, sourceMessageId) as { next_at: string | null } | undefined;
  return !!row?.next_at && Date.parse(row.next_at) > Date.now();
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

function waitForIntakeRetry(delay: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const finish = (ready: boolean): void => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(ready); };
    const abort = (): void => finish(false);
    const timer = setTimeout(() => finish(true), delay);
    timer.unref?.();
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function performIntake(input: GoalIntakeForward, text: string, signal: AbortSignal): Promise<void> {
  const done = (outcome: string, reason: string, extra: Record<string, unknown> = {}): void => {
    tryRecordRunEvent({ runId: input.runId, chatId: input.chatId, kind: GOAL_INTAKE_COMPLETED_EVENT,
      payload: { sourceMessageId: input.sourceMessageId, outcome, reason, ...extra } });
  };
  try {
    if (signal.aborted) return done("unavailable", "goal_intake_cancelled", { retryScheduled: false });
    const chat = getChat(input.chatId);
    if (!chat) return done("source_invalid", "chat_missing");
    const bound = chat.goalId ? getLongRunByGoalId(chat.goalId) : null;
    if (bound && bound.goalId === goalIdFor(input.sourceMessageId)) return done("already_admitted", "goal_exists", { goalId: bound.goalId });
    if (bound && !LONG_RUN_TERMINAL_STATUSES.has(bound.status)) return done("chat_already_bound", "live_goal_in_chat", { goalId: bound.goalId });
    const own = getLongRunByGoalId(goalIdFor(input.sourceMessageId));
    if (own) return done("already_admitted", "goal_exists", { goalId: own.goalId });
    let prepared: Awaited<ReturnType<typeof prepareInvocationAutomaticGoal>>;
    for (let attempt = 0; ; attempt += 1) {
      prepared = await prepareInvocationAutomaticGoal({ runId: input.runId, chatId: input.chatId, sourceMessageId: input.sourceMessageId,
        userPrompt: text, permission: input.permission, signal });
      // An aborted classifier returns bypass, which must never seal this durable marker as a semantic non-goal.
      if (signal.aborted && prepared.kind !== "admitted") return done("unavailable", "goal_intake_cancelled");
      if (prepared.kind !== "unavailable") break;
      const delay = INTAKE_RETRY_DELAYS_MS[attempt];
      done("unavailable", prepared.reason, { retryable: prepared.retryable, attempt: attempt + 1,
        retryScheduled: delay !== undefined,
        ...(delay === undefined ? { retryState: "waiting_runtime_change", nextRetryAt: new Date(Date.now() + INTAKE_RETRY_COOLDOWN_MS).toISOString() } : {}) });
      if (!prepared.retryable || delay === undefined) return;
      if (!await waitForIntakeRetry(delay, signal)) return done("unavailable", "goal_intake_cancelled", { retryScheduled: false });
      if (intakeDone(input.chatId, input.sourceMessageId)) return;
      const current = getChat(input.chatId), active = current?.goalId ? getLongRunByGoalId(current.goalId) : null;
      if (active && !LONG_RUN_TERMINAL_STATUSES.has(active.status)) return done("chat_already_bound", "live_goal_in_chat", { goalId: active.goalId });
    }
    if (prepared.kind === "admitted") {
      done("admitted", "classified_goal", { goalId: prepared.run.goalId });
      // The service turn is this Goal's run: start the Goal with it, or settle it when that turn already ended
      // (production 2026-10-15T23:12Z: both team-room Goals stayed queued after their runs failed).
      try { followDaemonTurnGoal(prepared.run.goalId); } catch (error) { console.warn("[goal-intake] Goal could not follow its service turn:", error); }
      return;
    }
    return done("bypass", "classified_not_goal");
  } catch {
    done("unavailable", "goal_intake_failed");
  }
}

/** Reply at once; the classification and admission run in the background and end in `automatic_goal_intake_completed`. */
export function acceptForwardedGoalIntake(input: GoalIntakeForward, signal: AbortSignal = new AbortController().signal): { ok: true; status: "accepted" | "duplicate" } | { ok: false; error: string } {
  if (!idLike(input.runId) || !idLike(input.chatId) || !idLike(input.sourceMessageId) || !["read", "write", "full"].includes(input.permission)) return { ok: false, error: "device_bridge_refused" };
  const k = key(input.chatId, input.sourceMessageId);
  if (inFlight.has(k)) return { ok: true, status: "duplicate" };
  const source = validateSource(input);
  if ("error" in source) return { ok: false, error: source.error };
  if (intakeDone(input.chatId, input.sourceMessageId)) return { ok: true, status: "duplicate" };
  if (intakeCoolingDown(input.chatId, input.sourceMessageId)) return { ok: true, status: "duplicate" };
  const work = performIntake(input, source.text, signal).finally(() => { inFlight.delete(k); intakeSignals.delete(k); });
  inFlight.set(k, work);
  intakeSignals.set(k, signal);
  return { ok: true, status: "accepted" };
}

/** Markers the service left while Main was away (or that Main did not finish), oldest first. */
interface PendingIntakeRow { marker_row: number; run_id: string; chat_id: string; payload_json: string }

function pendingIntakeRows(now: number, afterRow: number, throughRow: number): PendingIntakeRow[] {
  const marks = TERMINAL_OUTCOMES.map(() => "?").join(",");
  return getDb().prepare(`WITH pending AS (
    SELECT e.rowid AS marker_row, e.run_id, e.chat_id, e.payload_json,
      ROW_NUMBER() OVER (PARTITION BY e.chat_id, json_extract(e.payload_json, '$.sourceMessageId') ORDER BY e.rowid) AS ordinal
    FROM run_events e WHERE e.kind IN (?, ?) AND e.ts > ? AND e.chat_id IS NOT NULL AND e.rowid <= ?
      AND NOT EXISTS (SELECT 1 FROM run_events c WHERE c.kind = ? AND c.chat_id = e.chat_id
        AND json_extract(c.payload_json, '$.sourceMessageId') = json_extract(e.payload_json, '$.sourceMessageId')
        AND json_extract(c.payload_json, '$.outcome') IN (${marks})))
    SELECT marker_row, run_id, chat_id, payload_json FROM pending WHERE ordinal = 1 AND marker_row > ?
    ORDER BY marker_row LIMIT ?`).all(GOAL_INTAKE_FORWARDED_EVENT, GOAL_INTAKE_DEFERRED_EVENT, new Date(now - GOAL_INTAKE_MAX_AGE_MS).toISOString(),
      throughRow, GOAL_INTAKE_COMPLETED_EVENT, ...TERMINAL_OUTCOMES, afterRow, DRAIN_LIMIT) as PendingIntakeRow[];
}

function decodeIntakeRows(rows: PendingIntakeRow[]): GoalIntakeForward[] {
  const out: GoalIntakeForward[] = [];
  for (const row of rows) {
    let payload: { sourceMessageId?: unknown; permission?: unknown };
    try { payload = JSON.parse(row.payload_json); } catch { continue; }
    if (!idLike(payload.sourceMessageId) || !["read", "write", "full"].includes(String(payload.permission))) continue;
    out.push({ runId: row.run_id, chatId: row.chat_id, sourceMessageId: payload.sourceMessageId, permission: payload.permission as GoalIntakePermission });
  }
  return out;
}

export function pendingGoalIntakes(now: number = Date.now()): GoalIntakeForward[] {
  return decodeIntakeRows(pendingIntakeRows(now, 0, Number.MAX_SAFE_INTEGER));
}

/** A runtime-change wake waits for already admitted classification and durable cooldowns; this read never calls a model. */
export function pendingGoalIntakeRetryDelay(now: number = Date.now()): number {
  if (inFlight.size) return INTAKE_RETRY_COOLDOWN_MS;
  const row = getDb().prepare(`SELECT MAX(json_extract(payload_json, '$.nextRetryAt')) AS next_at FROM run_events
    WHERE kind = ? AND ts > ? AND json_extract(payload_json, '$.retryState') = 'waiting_runtime_change'`)
    .get(GOAL_INTAKE_COMPLETED_EVENT, new Date(now - INTAKE_RETRY_COOLDOWN_MS).toISOString()) as { next_at: string | null };
  return Math.max(0, row.next_at ? Date.parse(row.next_at) - now : 0);
}

let activeDrain: { signal?: AbortSignal } | undefined;
let nextDrain: { signal?: AbortSignal } | undefined;

/** Main attached (or re-attached): finish every unfinished intake. A marker Main cannot validate ends as `source_invalid`. */
export function drainPendingGoalIntakes(signal?: AbortSignal): number {
  if (signal?.aborted) return 0;
  if (activeDrain) {
    if (activeDrain.signal !== signal) nextDrain = { signal };
    return 0;
  }
  // A pass visits each distinct message at most once and never chases newly appended markers forever.
  const throughRow = (getDb().prepare("SELECT COALESCE(MAX(rowid), 0) AS last FROM run_events").get() as { last: number }).last;
  const pass = activeDrain = { signal }, now = Date.now();
  const finish = (): void => {
    if (activeDrain !== pass) return;
    activeDrain = undefined;
    const next = nextDrain; nextDrain = undefined;
    if (next && !next.signal?.aborted) drainPendingGoalIntakes(next.signal);
  };
  const batch = (afterRow: number): number => {
    if (signal?.aborted) { finish(); return 0; }
    const rows = pendingIntakeRows(now, afterRow, throughRow), work: Promise<void>[] = [];
    let started = 0;
    for (const marker of decodeIntakeRows(rows)) {
      const reply = acceptForwardedGoalIntake(marker, signal);
      if (!reply.ok) tryRecordRunEvent({ runId: marker.runId, chatId: marker.chatId, kind: GOAL_INTAKE_COMPLETED_EVENT,
        payload: { sourceMessageId: marker.sourceMessageId, outcome: "source_invalid", reason: reply.error } });
      else if (reply.status === "accepted") started += 1;
      const k = key(marker.chatId, marker.sourceMessageId), pending = inFlight.get(k);
      // A reattached channel can meet an old, now-aborted forward still settling. Revisit it after that work releases.
      if (pending && intakeSignals.get(k)?.aborted && !signal?.aborted) nextDrain = { signal };
      if (pending) work.push(pending);
    }
    void Promise.allSettled(work).then(() => {
      if (rows.length < DRAIN_LIMIT || signal?.aborted) return finish();
      // Yield between bounded batches, including malformed rows and unavailable classifications.
      setImmediate(() => {
        try { batch(rows[rows.length - 1].marker_row); }
        catch (error) { console.warn("[goal-intake] Pending intake drain failed:", error); finish(); }
      });
    });
    return started;
  };
  try { return batch(0); } catch (error) { finish(); throw error; }
}
