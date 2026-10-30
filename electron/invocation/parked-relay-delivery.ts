import { randomUUID } from "node:crypto";

/**
 * A parked relay (deferred-system-relays.ts) is delivered by "the chat's next turn that runs". Nothing made such a turn happen:
 *
 *  - A Goal that waits on its own host-scheduled retry (waiting_tool + a pending blocked-goal retry, 30 min to 6 h out) refused a
 *    teammate's report and the report waited for that retry. Observed in use: 50 of 66 parked relays waited 5-30 min,
 *    11 waited 2 h or more (those were Goals held for the owner's answer: an owner hold, left alone).
 *  - A room note whose steer was refused for a reason that clears by itself (a locked store, the other host holding the room,
 *    a settling turn) was parked and no timer or later event started a turn for it; with no Goal and no owner message it sat.
 *
 * This module is the only thing that wakes a parked relay, and it never writes a message or sends the relay itself:
 *
 *  1. Goal waiting on a host retry: the retry is pulled forward ONCE per parked batch (the scheduled turn then carries the relays
 *     through the ordinary claim, so delivery stays exactly once). Owner holds (paused by the owner, a question waiting for the
 *     owner's answer), the Goal's wake budget, the same-cause backoff and a waiting owner request are respected, not bypassed.
 *  2. No Goal in the way: the parked texts are sent to the room as one system relay (the way a room note is), bounded in count
 *     and spacing. The relays are claimed first and released when the steer is refused, so no turn sees a relay twice.
 *
 * Both run from a periodic scan in Main (startParkedRelayRecovery) and, for the Goal case, right after a relay is parked. The scan
 * is also what recovers relays parked by another process or before a restart. Everything is bounded and silent: no chat message,
 * no owner-facing text.
 */

/** Ledger markers of a pulled-forward retry (nextBlockedGoalRetrySlot does not count it as a failure). */
export const PULL_FORWARD_DETAIL = "parked_relay_pull_forward";
export const PULL_FORWARD_TRIGGER = "parked-relay";

/** A retry due within one sweep interval (60 s) and a little more is left to the minute sweep: pulling it forward gains nothing. */
const DUE_SLACK_MS = 75_000;
/** The pulled-forward retry is due this soon; the sweep (every 60 s) picks it up. */
const PULL_FORWARD_DELAY_MS = 2_000;
/** At most one pull-forward per Goal in this window, however many relays are parked meanwhile. */
const PULL_FORWARD_MIN_SPACING_MS = 3 * 60_000;
/** Wakes of the daily budget kept free for the Goal's own work. */
const WAKE_HEADROOM = 8;
/** A relay must have waited this long before the scan wakes its room (a burst becomes one turn, and the owner's own turn wins). */
export const PARKED_RELAY_MIN_AGE_MS = 45_000;
/** Older than this is stale teammate data: it waits for the next turn that happens anyway. */
const PARKED_RELAY_MAX_AGE_MS = 3 * 24 * 3_600_000;
/** Spacing of the wake attempts of one room after a refusal; the series is over after the last one (a new relay restarts it). */
export const NUDGE_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const NUDGE_TEXT_BUDGET = 12_000;
/** The relays the room is woken for: a room note (room-chat.ts wakeOne) and an owner-wait notice (team-dispatch.ts). Both are
 * conversation relays for One with no other way to a turn. A "goal_*" relay belongs to the Goal's next turn and may be a host
 * direction, which a plain relay would not carry faithfully. */
export const NUDGE_CAUSE_PREFIXES: readonly string[] = ["room_note_", "owner_wait_"];
const SCAN_INTERVAL_MS = 30_000;
const SCAN_CHATS_PER_PASS = 8;

// ── Goal retry pull-forward ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface GoalRunView { id: string; version: number; status: string; surface: string | null; rootChatId: string | null }
export interface GoalRetryView { kind: "observe" | "resume"; fromReason: string | null; retryIndex: number; nextAt: string }

export interface GoalRetryPorts {
  goalRun(chatId: string): GoalRunView | null;
  /** Paused by the owner, or resting on the owner's answer: nobody but the owner wakes it. */
  ownerHold(runId: string): boolean;
  pendingRetry(runId: string): GoalRetryView | null;
  /** When the last pull-forward of this Goal was written, or null. */
  lastPullAt(runId: string): number | null;
  /** Why the wake arbiter would refuse a start now, or null. Read-only. */
  wakeBlocker(runId: string, chatId: string, now: number): "wake_budget_low" | "same_cause_hold" | "owner_request_waiting" | null;
  reschedule(input: { runId: string; expectedVersion: number; kind: "observe" | "resume"; fromReason: string | null;
    retryIndex: number; nextAt: string; detail: string; trigger: string }): void;
}

export type PullForwardOutcome =
  | { pulled: true; runId: string; previousNextAt: string; nextAt: string }
  | { pulled: false; reason: "no_goal" | "goal_not_waiting" | "owner_hold" | "no_pending_retry" | "already_due" | "spaced"
    | "wake_budget_low" | "same_cause_hold" | "owner_request_waiting" | "controller_live" | "state_changed" | "error" };

/**
 * Pull the pending host retry of the Goal that rests in this chat forward, once per parked batch. Returns why not when it did not:
 * `no_goal` / `goal_not_waiting` mean no Goal retry stands between the relay and a turn (the caller may wake the room itself).
 */
export function pullGoalRetryForward(chatId: string, ports: GoalRetryPorts = productionGoalPorts(), now: number = Date.now()): PullForwardOutcome {
  try {
    const run = ports.goalRun(chatId);
    if (!run || run.surface === "science" || run.rootChatId !== chatId) return { pulled: false, reason: "no_goal" };
    if (run.status !== "waiting_tool") return { pulled: false, reason: "goal_not_waiting" };
    if (ports.ownerHold(run.id)) return { pulled: false, reason: "owner_hold" };
    const retry = ports.pendingRetry(run.id);
    if (!retry) return { pulled: false, reason: "no_pending_retry" };
    const due = Date.parse(retry.nextAt);
    if (!Number.isFinite(due)) return { pulled: false, reason: "error" };
    if (due <= now + DUE_SLACK_MS) return { pulled: false, reason: "already_due" };
    const last = ports.lastPullAt(run.id);
    if (last !== null && now - last < PULL_FORWARD_MIN_SPACING_MS) return { pulled: false, reason: "spaced" };
    const blocked = ports.wakeBlocker(run.id, chatId, now);
    if (blocked) return { pulled: false, reason: blocked };
    const nextAt = new Date(now + PULL_FORWARD_DELAY_MS).toISOString();
    try {
      ports.reschedule({ runId: run.id, expectedVersion: run.version, kind: retry.kind, fromReason: retry.fromReason,
        retryIndex: retry.retryIndex, nextAt, detail: PULL_FORWARD_DETAIL, trigger: PULL_FORWARD_TRIGGER });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "blocked_goal_retry_controller_live") return { pulled: false, reason: "controller_live" };
      if (code === "blocked_goal_retry_state_changed") return { pulled: false, reason: "state_changed" };
      if (code === "long_run_owner_hold" || code === "goal_owner_answer_pending") return { pulled: false, reason: "owner_hold" };
      throw error;
    }
    console.info(`[parked-relay] Goal retry pulled forward run=${run.id} chat=${chatId} from=${retry.nextAt} to=${nextAt}`);
    return { pulled: true, runId: run.id, previousNextAt: retry.nextAt, nextAt };
  } catch (error) {
    console.warn("[parked-relay] Goal retry could not be pulled forward:", error instanceof Error ? error.message : error);
    return { pulled: false, reason: "error" };
  }
}

function productionGoalPorts(): GoalRetryPorts {
  const longRuns = () => require("../store/long-runs") as typeof import("../store/long-runs");
  const arbiter = () => require("../long-run/wake-arbiter") as typeof import("../long-run/wake-arbiter");
  const db = () => (require("../store/db") as typeof import("../store/db")).getDb();
  return {
    goalRun(chatId) {
      const goalId = (require("../store/chats") as typeof import("../store/chats")).getChat(chatId)?.goalId;
      const run = goalId ? longRuns().getLongRunByGoalId(goalId) : null;
      return run ? { id: run.id, version: run.version, status: run.status, surface: run.surface ?? null, rootChatId: run.rootChatId ?? null } : null;
    },
    ownerHold: (runId) => longRuns().longRunOwnerHold(runId) || longRuns().goalOwnerAnswerHold(runId),
    pendingRetry: (runId) => {
      const retry = longRuns().pendingBlockedGoalRetry(runId);
      return retry ? { kind: retry.kind, fromReason: retry.fromReason, retryIndex: retry.retryIndex, nextAt: retry.nextAt } : null;
    },
    lastPullAt(runId) {
      const row = db().prepare(`SELECT occurred_at AS at FROM long_run_events WHERE run_id = ? AND kind = ?
        AND json_extract(payload_json, '$.trigger') = ? ORDER BY seq DESC LIMIT 1`)
        .get(runId, longRuns().BLOCKED_GOAL_SWEEP_EVENT_KIND, PULL_FORWARD_TRIGGER) as { at: string } | undefined;
      const at = row ? Date.parse(row.at) : Number.NaN;
      return Number.isFinite(at) ? at : null;
    },
    wakeBlocker(runId, chatId, now) {
      const wake = arbiter();
      if (wake.goalWakeWindow(runId, chatId, now).count >= wake.GOAL_WAKE_DAILY_BUDGET - WAKE_HEADROOM) return "wake_budget_low";
      if (wake.sameCauseWakeHold(runId, chatId, now)) return "same_cause_hold";
      if (wake.ownerRequestWaiting(chatId, undefined, now)) return "owner_request_waiting";
      return null;
    },
    reschedule(input) {
      let appInstanceId: string | null = null;
      try { appInstanceId = (require("../long-run/app-runtime-coordinator") as typeof import("../long-run/app-runtime-coordinator")).desktopAppInstanceId(); }
      catch { /* a process without the coordinator writes the retry without an instance id */ }
      longRuns().scheduleBlockedGoalRetry({ ...input, appInstanceId });
    },
  };
}

// ── Waking a room that has no Goal in the way ───────────────────────────────────────────────────────────────────────────────

export interface RelayNudgePorts {
  chat(chatId: string): { originSurface: string | null } | null;
  /** A turn is running in this chat in this process. */
  chatActive(chatId: string): boolean;
  ownerRequestWaiting(chatId: string): boolean;
  listRows(chatId: string, budgetChars: number): Array<{ id: string; text: string }>;
  claim(ids: readonly string[], token: string): boolean;
  release(token: string): number;
  /** Sends the text to the chat as a system relay (the way a room note is). Throws the invocation service's refusal. */
  steer(chatId: string, prompt: string): void;
  refusalCode(error: unknown): string | undefined;
}

export type NudgeOutcome = "sent" | "none" | "busy" | "owner_request_waiting" | "not_one_chat" | "goal_waiting" | "refused_transient" | "refused";

const GOAL_WAITING_REFUSAL = "goal_waiting_system_start_refused";

/**
 * Send a chat's parked relays to it as ONE system relay. The relays are claimed before the steer, so the turn that starts does
 * not also read them from the deferred block; a refused steer releases them again. A Goal that started waiting in between
 * refuses the steer after parking the coalesced text again: the claimed rows are then accounted for by that new row.
 */
export function nudgeParkedRelays(chatId: string, ports: RelayNudgePorts = productionNudgePorts()): NudgeOutcome {
  const chat = ports.chat(chatId);
  if (!chat || chat.originSurface !== "one") return "not_one_chat";
  if (ports.chatActive(chatId)) return "busy";
  if (ports.ownerRequestWaiting(chatId)) return "owner_request_waiting";
  const rows = ports.listRows(chatId, NUDGE_TEXT_BUDGET);
  if (!rows.length) return "none";
  const token = `relay-nudge:${randomUUID()}`;
  if (!ports.claim(rows.map((row) => row.id), token)) return "none";
  try {
    ports.steer(chatId, rows.map((row) => row.text).join("\n\n"));
    return "sent";
  } catch (error) {
    const code = ports.refusalCode(error);
    if (code === GOAL_WAITING_REFUSAL) return "goal_waiting";
    ports.release(token);
    // The room is occupied by a turn of the other host (a long background-service turn can hold it for hours): not a refusal, so no
    // attempt of the bounded series is spent; the scan looks again.
    if (code && (code === "chat_invocation_active" || code.startsWith("invocation_chat_busy"))) return "busy";
    return code && transientRefusal(code) ? "refused_transient" : "refused";
  }
}

function transientRefusal(code: string): boolean {
  try { return (require("../../shared/transient-send-refusal") as typeof import("../../shared/transient-send-refusal")).isTransientRunFailureCode(code); }
  catch { return false; }
}

function productionNudgePorts(): RelayNudgePorts {
  const relays = () => require("./deferred-system-relays") as typeof import("./deferred-system-relays");
  const service = () => (require("./service") as typeof import("./service")).invocationService;
  return {
    chat: (chatId) => {
      const chat = (require("../store/chats") as typeof import("../store/chats")).getChat(chatId);
      return chat ? { originSurface: chat.originSurface ?? null } : null;
    },
    chatActive: (chatId) => service().activeChatIds().includes(chatId),
    ownerRequestWaiting: (chatId) =>
      (require("../long-run/wake-arbiter") as typeof import("../long-run/wake-arbiter")).ownerRequestWaiting(chatId, service() as never),
    listRows: (chatId, budget) => relays().listParkedRelays(chatId, budget, NUDGE_CAUSE_PREFIXES).map((row) => ({ id: row.id, text: row.text })),
    claim: (ids, token) => { try { return relays().claimDeferredSystemRelays(ids, token); } catch { return false; } },
    release: (token) => relays().releaseDeferredSystemRelays(token),
    steer(chatId, prompt) {
      service().steer({
        chatId, userPrompt: prompt, promptOrigin: "system",
        locale: (require("../ui-locale") as typeof import("../ui-locale")).currentUiLocale(),
        permissions: "read", taskIntent: "conversation", oneMode: true, runId: undefined,
      } as never);
    },
    refusalCode: (error) => (require("../runtime/runner") as typeof import("../runtime/runner")).refusalCode(error) ?? undefined,
  };
}

// ── The scan ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ParkedRelayScanPorts {
  goal: GoalRetryPorts;
  nudge: RelayNudgePorts;
  chats(parkedBefore: number, limit: number): Array<{ chatId: string; oldest: number; count: number }>;
}

interface NudgeSeries { attempts: number; notBefore: number }
const nudgeSeries = new Map<string, NudgeSeries>();

/** A freshly parked relay restarts its room's bounded wake series. */
export function onSystemRelayParked(chatId: string): void {
  nudgeSeries.delete(chatId);
  // Off the caller's stack: parking happens inside a start() that is refusing a run.
  queueMicrotask(() => {
    try { pullGoalRetryForward(chatId); } catch { /* the scan retries */ }
  });
}

export interface ParkedRelayScanResult { chatId: string; action: "pulled_forward" | "goal_owns" | "sent" | "waiting" | "retry_later" | "gave_up" | "skipped"; detail: string }

/** One pass over the chats that hold parked relays. Pure of timers; the caller chooses the cadence. */
export function scanParkedRelays(ports: ParkedRelayScanPorts = productionScanPorts(), now: number = Date.now()): ParkedRelayScanResult[] {
  const out: ParkedRelayScanResult[] = [];
  let work: Array<{ chatId: string; oldest: number; count: number }> = [];
  try { work = ports.chats(now - PARKED_RELAY_MIN_AGE_MS, SCAN_CHATS_PER_PASS); }
  catch (error) { console.warn("[parked-relay] scan could not read the parked relays:", error instanceof Error ? error.message : error); return out; }
  for (const item of work) {
    if (now - item.oldest > PARKED_RELAY_MAX_AGE_MS) { out.push({ chatId: item.chatId, action: "skipped", detail: "stale" }); continue; }
    let run: GoalRunView | null = null;
    try { run = ports.goal.goalRun(item.chatId); } catch { out.push({ chatId: item.chatId, action: "skipped", detail: "goal_unreadable" }); continue; }
    const ended = !run || run.surface === "science" || run.rootChatId !== item.chatId || ["completed", "cancelled", "failed"].includes(run.status);
    if (!ended) {
      // A Goal owns the room's next turn. Only a Goal that rests on its own retry can be hurried; every other state is the Goal's
      // own business (running, queued: the turn that carries the relays is coming; owner holds: only the owner wakes it).
      const pull = pullGoalRetryForward(item.chatId, ports.goal, now);
      out.push({ chatId: item.chatId, action: pull.pulled ? "pulled_forward" : "goal_owns", detail: pull.pulled ? pull.nextAt : pull.reason });
      continue;
    }
    const series = nudgeSeries.get(item.chatId) ?? { attempts: 0, notBefore: 0 };
    if (series.attempts >= NUDGE_DELAYS_MS.length + 1) { out.push({ chatId: item.chatId, action: "gave_up", detail: String(series.attempts) }); continue; }
    if (now < series.notBefore) { out.push({ chatId: item.chatId, action: "retry_later", detail: new Date(series.notBefore).toISOString() }); continue; }
    let outcome: NudgeOutcome;
    try { outcome = nudgeParkedRelays(item.chatId, ports.nudge); }
    catch (error) { console.warn("[parked-relay] room wake failed:", error instanceof Error ? error.message : error); outcome = "refused"; }
    if (outcome === "busy" || outcome === "owner_request_waiting") {
      // The room is occupied or the owner is typing: not a refusal, no attempt spent.
      nudgeSeries.set(item.chatId, { attempts: series.attempts, notBefore: now + SCAN_INTERVAL_MS });
      out.push({ chatId: item.chatId, action: "waiting", detail: outcome });
    } else if (outcome === "refused" || outcome === "refused_transient") {
      const delay = NUDGE_DELAYS_MS[Math.min(series.attempts, NUDGE_DELAYS_MS.length - 1)];
      nudgeSeries.set(item.chatId, { attempts: series.attempts + 1, notBefore: now + delay });
      out.push({ chatId: item.chatId, action: "retry_later", detail: outcome });
    } else {
      nudgeSeries.delete(item.chatId);
      out.push({ chatId: item.chatId, action: outcome === "sent" ? "sent" : "skipped", detail: outcome });
    }
  }
  return out;
}

function productionScanPorts(): ParkedRelayScanPorts {
  return {
    goal: productionGoalPorts(),
    nudge: productionNudgePorts(),
    chats: (before, limit) => (require("./deferred-system-relays") as typeof import("./deferred-system-relays")).listChatsWithParkedRelays(before, limit),
  };
}

let scanTimer: NodeJS.Timeout | null = null;

/** Main starts this once; the scan is silent and bounded (see the header). Returns a stop function. */
export function startParkedRelayRecovery(ports?: ParkedRelayScanPorts): () => void {
  if (scanTimer) return () => stopParkedRelayRecovery();
  scanTimer = setInterval(() => {
    try {
      const done = scanParkedRelays(ports);
      const acted = done.filter((entry) => entry.action === "pulled_forward" || entry.action === "sent");
      if (acted.length) console.info("[parked-relay] scan", JSON.stringify(acted));
    } catch (error) { console.warn("[parked-relay] scan failed:", error instanceof Error ? error.message : error); }
  }, SCAN_INTERVAL_MS);
  scanTimer.unref?.();
  return () => stopParkedRelayRecovery();
}

export function stopParkedRelayRecovery(): void {
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;
}

/** Test seam: forget the per-room wake series. */
export function resetParkedRelayWakeState(): void { nudgeSeries.clear(); }
