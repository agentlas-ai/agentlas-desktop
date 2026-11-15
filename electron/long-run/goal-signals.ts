/**
 * Main's wiring of the Agentlas Harness' one timer and of the signals that replace the minute sweep (Agentlas 2.0 N3c, decision;
 * docs/Agentlas2.0/audit/39-design-n-agentlas-harness.md section 11).
 *
 * What the 60 s sweep carried, and where each part lives now (the table of the ten homes; every row has a "the signal did not come" answer,
 * which is one look at app start - never a period):
 *
 *   1. a service turn's Goal settled       signal: a chat row another process committed (store/external-chat-changes.ts puts it on the
 *                                          change bus), followDaemonTurnGoalOfChat; start: sweepBlockedGoals("startup") settles them all
 *   2. an owner message the judge could not answer, asked again   its own next-attempt time (nextUnavailableOwnerReviewAt) + the
 *                                          runtime change on the bus (the judge pool came back); start: the same sweep
 *   3. the Goal tree cleanup               start (and wake) only; the Goal closing path does its own (N4)
 *   4. an owner answer from phone / Telegram / the other process   signal: the owner's message row reaches the change bus from every
 *                                          surface (appendChatMessage emits it; a commit by another process arrives through the watcher)
 *   5. a card pressed                      signal: onUiInstanceEvent (the card's own event, either process)
 *   6. a Goal whose conversation was deleted   signal: the deleted conversation's id on the change bus finds no row; start: the full look
 *   7. owner grant adoption, owner Goal amendment applied   every time the Goal is looked at (the signals above, the turn's end, a due line)
 *   8. parked relays                       their own next-scan time (nextParkedRelayScanAt) + the turn's end
 *   9. rule R-a (human-check card) and R-b (tool-breakage line)   the turn's end: the ladder's last word is written while the turn lives, the
 *                                          look after it reads it (a room with a live turn is skipped)
 *  10. a Goal at its next step             the line harness_due (store/harness-due.ts), the timer's aim; a turn's end looks at its own chat
 *
 * Nothing here calls a model. A chat with a live turn in this process is never looked at by a signal: the end of that turn is the signal.
 * The look itself is the sweep's own decision (long-run/blocked-goal-sweep.ts lookAtGoalChat), so a signal and a due time decide the same.
 */
import type { EffectObservationDispatcher } from "./effect-observation-tickets";
import { createDueTimer, type DueSource, type DueTimer, type DueWhy } from "../harness/due-timer";
import { onDesktopStoreChange, type DesktopStoreChange } from "../store/change-bus";
import { getDb } from "../store/db";
import { earliestHarnessDue, pruneDeadHarnessDue } from "../store/harness-due";

/** A look at one chat waits this long after the last signal for it (several rows of one answer arrive together). */
export const GOAL_LOOK_DEBOUNCE_MS = 1_500;
/** After a turn ends: the follow-up it schedules, and an owner request waiting behind it, are written by then. */
export const GOAL_LOOK_AFTER_TURN_MS = 3_000;
/** A line that fell due and was not taken (a busy room, the dispatch budget) is asked again after this, not before. */
export const GOAL_RETRY_HOLD_MS = 60_000;
/** The first 30 s of a launch are the runtimes' and the account's to restore: parked relays are not nudged before. */
export const RELAY_BOOT_GRACE_MS = 30_000;
const REVIEW_TIME_MEMO_MS = 60_000;
const LOOK_QUEUE_CAP = 512;
/**
 * A look that answered "not now" for a reason that is not a rest looks again: the first time after RELOOK_BACKOFF_MS, then twice as long each time
 * (1, 2, 4 ... minutes), at most RELOOK_MAX times in a row for one chat. The three short graces below keep their own spacing. A look that fails
 * (a busy store) is asked again the same way. One timer per chat, set by the look that answered and gone when it fires: nothing is a period.
 */
const RELOOK_BACKOFF_MS = 60_000;
const RELOOK_MAX = 10;
/** The full looks a store of due Goals may ask for in a row (a minute apart): each starts the sweep's dispatch budget of them, so this is hours of starts. */
const BUDGET_LOOK_MAX = 120;
const RELOOK_AFTER_MS: Readonly<Record<string, number>> = { attempt_running: 60_000, status_without_owner_grace: 60_000, cancelling_grace: 60_000,
  // a Goal that changed a moment ago and says "running": looked at once more when the short grace of a signal look is over
  running_grace: 3_000 };
/**
 * The closed list of answers that are a REST: the Goal waits on something that will itself signal (the owner's word, a card, a registered wait,
 * a schedule line, a turn's end), so looking again would only read the same answer (defect 3). Everything else a look defers on
 * ("a moment", a busy store, the dispatch budget, a lease another process held) is asked again. These strings are the typed codes of
 * long-run/blocked-goal-sweep.ts, store/long-runs.ts and harness/cause.ts (a gate holds the two lists together).
 */
export const GOAL_LOOK_RESTS: ReadonlySet<string> = new Set([
  "long_run_owner_paused",        // the owner stopped it
  "goal_owner_answer_pending",    // it asked the owner a question
  "goal_owner_grant_required",    // no recorded owner instruction: the owner's word or Resume is the grant
  "wait_owns_next_step",          // a registered wait names the next step
  "no_progress_rest",             // the idle-spin rest: the next signal
  "owner_request_queued",         // an owner request is about to start and owns the chat
  "provider_retry_not_due",       // the provider named a time: the schedule line carries it
  "wake_budget_reached",          // the daily wall: the schedule line carries its end
  "owner_stopped_pausing", "paused_agent_domain", "draft_is_owners_start", "paused_budget", "paused_approval",
]);
const GOAL_LOOK_REST_PREFIXES: readonly string[] = ["retry_at:", "same_cause_backoff:"];
/** A Goal's own row changes may look at its chat this many times a minute; past that only the owner's and a card's signals do (a writer that loops cannot make a look loop). */
const LOOKS_PER_MINUTE = 12;
const AIM_COALESCE_MS = 250;
/**
 * Every short wait of this file (a chat's look, the re-aim, the relay reclaim, the orphan look, the runtime look, the next budget look) is an entry of ONE
 * shared timer (`wakes` below). The timer fires WAKE_SLOP_MS after the earliest entry and runs every entry whose time has come by then, so the
 * several waits that one burst of turn ends leaves (a look per chat, a re-aim, a reclaim: ~3 timers per started Goal before) are one fire. An
 * entry runs late by at most the slop, never early.
 */
const WAKE_SLOP_MS = 500;
/** A wait that has no hurry (the re-aim, the relay reclaim) is a rider: it runs with whatever entry fires next, and by itself only this long after its time. */
const WAKE_RIDER_MS = 3_000;

export interface GoalSignalsHandle {
  timer: DueTimer;
  /** The app has started: every source looks once (replaces the startup sweep and the parked-relay scan's first pass). */
  start(): Promise<void>;
  /** A turn of this chat ended. */
  turnSettled(chatId: string): void;
  /** Look at this chat at that time (a schedule that failed to write is not left to luck). */
  lookIn(chatId: string, delayMs: number): void;
  stop(): void;
}

export interface GoalSignalsPorts {
  dispatcher: EffectObservationDispatcher;
  /** Machine sleep / wake: Electron's powerMonitor, or a test emitter. */
  power?: { on(event: "resume", listener: () => void): unknown; removeListener(event: "resume", listener: () => void): unknown };
  now?: () => number;
  /** Test seams for the timer and the per-chat look queue. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (...args: unknown[]) => void;
}

let current: GoalSignalsHandle | null = null;

/** The handle of this process's signals, or null (the background service and tests that did not install any). */
export function goalSignals(): GoalSignalsHandle | null { return current; }

/** The call sites in the invocation service: a no-op in a process that did not install the signals (the background service never opens a Goal turn). */
export function noteGoalTurnSettled(chatId: string): void { try { current?.turnSettled(chatId); } catch { /* a signal never decides */ } }
export function armGoalLook(chatId: string, delayMs: number): void { try { current?.lookIn(chatId, delayMs); } catch { /* a signal never decides */ } }
/**
 * The background service went away or came back (the owner-control socket closed, the native channel re-attached): a room's turn it held and the
 * lease on it end without a row Main watches, so the one full look is asked for now. Two in 10 s are one (harness/due-timer.ts). A no-op where no
 * signals are installed. Never a timer of its own.
 */
export function wakeGoalLooksAfterServiceChange(): void { try { void current?.timer.wake("resume"); } catch { /* the next signal or look asks again */ } }

export function installGoalSignals(ports: GoalSignalsPorts): GoalSignalsHandle {
  current?.stop();
  const now = ports.now ?? Date.now;
  const setTimer = ports.setTimer ?? ((fn, ms) => { const handle = setTimeout(fn, ms); handle.unref?.(); return handle; });
  const clearTimer = ports.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  const log = ports.log ?? ((...args: unknown[]) => console.info(...args));
  const startedAt = now();
  let stopped = false, looking = false;
  let reviewMemo: { at: number | null; read: number } | null = null;

  // ── the sources of the one timer ───────────────────────────────────────────────────────────────────────────────────────
  const goalLines: DueSource = {
    name: "goal-next-look",
    holdMs: GOAL_RETRY_HOLD_MS,
    nextAt: () => {
      const line = earliestHarnessDue(new Set(ports.dispatcher.activeChatIds()));
      return line ? Date.parse(line.dueAt) : null;
    },
    run: (why: DueWhy) => {
      const { sweepBlockedGoals } = require("./blocked-goal-sweep") as typeof import("./blocked-goal-sweep");
      const trigger = why === "start" ? "startup" : why === "wake" ? "wake" : "due";
      looking = true;
      try {
        const results = sweepBlockedGoals(ports.dispatcher, trigger);
        const swept = results.filter((entry) => entry.action !== "deferred");
        if (swept.length) log("[long-run] blocked goal sweep", swept);
        if (why === "start" || why === "wake") relooks.clear(); // a launch or a wake is a fresh start for every chat's series
        relookAfterFullLook(results);
      } finally { looking = false; }
      // A line whose Goal is finished would stay due and be asked about again and again: it is deleted (a write only when one exists).
      try { pruneDeadHarnessDue(); } catch (error) { console.warn("[goal-signals] dead harness_due lines not pruned:", error instanceof Error ? error.message : error); }
    },
  };
  const parkedRelays: DueSource = {
    name: "parked-relays",
    holdMs: 30_000,
    nextAt: () => {
      const { nextParkedRelayScanAt } = require("../invocation/parked-relay-delivery") as typeof import("../invocation/parked-relay-delivery");
      const at = nextParkedRelayScanAt();
      return at === null ? null : Math.max(at, startedAt + RELAY_BOOT_GRACE_MS);
    },
    run: (why: DueWhy) => {
      // The first scan of a launch is the timer's own, after the grace: the runtimes and the account are not restored before it. What a
      // turn that died (the app closed under it) had claimed is given back at once: that is a read of rows, never a start.
      if (why === "start") { reclaimRelays(); return; }
      (require("../invocation/parked-relay-delivery") as typeof import("../invocation/parked-relay-delivery")).runParkedRelayScan();
    },
  };
  const ownerReviews: DueSource = {
    name: "owner-review-retry",
    holdMs: 60_000,
    nextAt: () => {
      if (reviewMemo && now() - reviewMemo.read < REVIEW_TIME_MEMO_MS) return reviewMemo.at;
      const { nextUnavailableOwnerReviewAt } = require("./goal-owner-amendment") as typeof import("./goal-owner-amendment");
      const at = nextUnavailableOwnerReviewAt();
      reviewMemo = { at, read: now() };
      return at;
    },
    run: (why: DueWhy) => {
      // At start and wake the full look already asks again (its duties ride those two); here only the time owes it.
      if (why === "start" || why === "wake") { reviewMemo = null; return; }
      reviewMemo = null;
      (require("./goal-owner-amendment") as typeof import("./goal-owner-amendment")).sweepUnavailableOwnerGoalReviews();
    },
  };
  const reclaimRelays = (): void => {
    try { (require("../invocation/deferred-system-relays") as typeof import("../invocation/deferred-system-relays")).reclaimUnreadDeferredSystemRelays(now()); }
    catch (error) { console.warn("[goal-signals] relay reclaim failed:", error instanceof Error ? error.message : error); }
  };
  const timer = createDueTimer([goalLines, parkedRelays, ownerReviews], { now, setTimer, clearTimer,
    onError: (source, error) => console.warn(`[due-timer] ${source} failed:`, error instanceof Error ? error.message : error) });

  // ── per-chat looks (signals) ───────────────────────────────────────────────────────────────────────────────────────────
  const queued = new Map<string, { at: number }>();
  const wakes = new Map<string, { at: number; by: number; run: () => void }>();
  let wakeHandle: unknown = null, wakeArmedAt: number | null = null;
  const armWakes = (): void => {
    if (stopped) return;
    let target: number | null = null;
    for (const entry of wakes.values()) if (target === null || entry.by < target) target = entry.by;
    if (target === null) { if (wakeHandle !== null) { clearTimer(wakeHandle); wakeHandle = null; wakeArmedAt = null; } return; }
    // An armed timer that fires no later than the target is kept: its fire runs everything due and arms again.
    if (wakeHandle !== null && wakeArmedAt !== null && wakeArmedAt <= target) return;
    if (wakeHandle !== null) clearTimer(wakeHandle);
    wakeArmedAt = target;
    wakeHandle = setTimer(() => { wakeHandle = null; wakeArmedAt = null; fireWakes(); }, Math.max(0, target - now()));
  };
  const fireWakes = (): void => {
    if (stopped) return;
    const at = now();
    const due = [...wakes.entries()].filter(([, entry]) => entry.at <= at).sort((a, b) => a[1].at - b[1].at);
    for (const [key, entry] of due) {
      if (wakes.get(key) !== entry) continue; // replaced by an earlier run of this pass
      wakes.delete(key);
      if (stopped) return;
      try { entry.run(); } catch (error) { console.warn("[goal-signals] a wake failed:", error instanceof Error ? error.message : error); }
    }
    armWakes();
  };
  const setWake = (key: string, atMs: number, run: () => void, rider = false): void => {
    wakes.set(key, { at: atMs, by: atMs + (rider ? WAKE_RIDER_MS : WAKE_SLOP_MS), run });
    armWakes();
  };
  const relooks = new Map<string, number>();
  const lookRate = new Map<string, { windowStart: number; n: number }>();
  const withinRate = (chatId: string): boolean => {
    const at = now(), entry = lookRate.get(chatId);
    if (!entry || at - entry.windowStart > 60_000) { if (lookRate.size >= 1024) lookRate.clear(); lookRate.set(chatId, { windowStart: at, n: 1 }); return true; }
    entry.n += 1;
    return entry.n <= LOOKS_PER_MINUTE;
  };

  /** Whether a deferred answer is a rest (GOAL_LOOK_RESTS, a typed prefix, a replay barrier, or a turn of this process whose end is the signal). */
  const staticRest = (detail: string): boolean => GOAL_LOOK_RESTS.has(detail) || GOAL_LOOK_REST_PREFIXES.some((prefix) => detail.startsWith(prefix));
  const isRest = (entry: { runId: string; detail: string }, chatId: string): boolean => {
    const detail = entry.detail;
    if (staticRest(detail)) return true;
    if (detail === "chat_busy") { try { return ports.dispatcher.activeChatIds().includes(chatId); } catch { return false; } }
    try { return (require("../invocation/automatic-goal") as typeof import("../invocation/automatic-goal")).automaticGoalReplayBlockerCode(entry.runId) === detail; } catch { return false; }
  };
  /** Looks at the chat again when an answer of the look was not a rest (null: the look itself failed). */
  const relookAfter = (chatId: string, results: ReadonlyArray<{ runId: string; action: string; detail: string }> | null): void => {
    const pending = results === null ? [] : results.filter((entry) => entry.action === "deferred" && !isRest(entry, chatId));
    if (results !== null && pending.length === 0) { relooks.delete(chatId); return; }
    const n = (relooks.get(chatId) ?? 0) + 1;
    if (n > RELOOK_MAX) return;
    const delays = results === null ? [RELOOK_BACKOFF_MS * 2 ** (n - 1)]
      : pending.map((entry) => RELOOK_AFTER_MS[entry.detail] ?? RELOOK_BACKOFF_MS * 2 ** (n - 1));
    if (relooks.size >= 1024) relooks.clear();
    relooks.set(chatId, n);
    lookIn(chatId, Math.min(...delays));
  };

  /** Which chat a Goal run belongs to (a full look's answers name the run). */
  const chatOfRun = (runId: string): string | null => {
    try { return (getDb().prepare("SELECT root_chat_id AS chatId FROM long_runs WHERE id = ?").get(runId) as { chatId: string | null } | undefined)?.chatId ?? null; } catch { return null; }
  };
  let budgetLooks = 0;
  /**
   * The full look's answers (defect 3): a chat with an answer that is not a rest is looked at again, as a signal look does. The one
   * exception is "dispatch_budget": the sweep starts a few models per look so that a store full of due Goals does not start them all at once,
   * and a look per chat would lift that bound. It is asked again as ONE full look a minute later, as long as it keeps starting some.
   */
  const relookAfterFullLook = (results: ReadonlyArray<{ runId: string; action: string; detail: string }>): void => {
    const byChat = new Map<string, Array<{ runId: string; action: string; detail: string }>>();
    let budget = false;
    for (const entry of results) {
      if (entry.action !== "deferred") continue;
      if (entry.detail === "dispatch_budget") { budget = true; continue; }
      if (staticRest(entry.detail)) continue; // a rest needs no chat to be named: nothing is read for it
      const chatId = chatOfRun(entry.runId);
      if (!chatId) continue;
      const group = byChat.get(chatId) ?? [];
      group.push(entry); byChat.set(chatId, group);
    }
    for (const [chatId, group] of byChat) if (group.some((entry) => !isRest(entry, chatId))) relookAfter(chatId, group);
    if (!budget) { budgetLooks = 0; return; }
    if (stopped || wakes.has("budget") || budgetLooks >= BUDGET_LOOK_MAX) return;
    budgetLooks += 1;
    setWake("budget", now() + GOAL_RETRY_HOLD_MS, () => {
      if (stopped) return;
      try { goalLines.run("due"); } catch (error) { console.warn("[goal-signals] budget look failed:", error instanceof Error ? error.message : error); }
      timer.aim();
    });
  };

  const lookNow = (chatId: string): void => {
    queued.delete(chatId);
    if (stopped) return;
    try {
      // A live turn here is the owner's or the Goal's own: its end is the signal.
      if (ports.dispatcher.activeChatIds().includes(chatId)) return;
      const { lookAtGoalChat } = require("./blocked-goal-sweep") as typeof import("./blocked-goal-sweep");
      const { followDaemonTurnGoalOfChat } = require("./daemon-turn-goal") as typeof import("./daemon-turn-goal");
      looking = true;
      try {
        // A service turn that ended is settled first (the Goal it belongs to is then closed or parked, never resumed to redo its work).
        try { followDaemonTurnGoalOfChat(chatId); } catch (error) { console.warn("[goal-signals] service-turn Goal could not follow its turn:", error instanceof Error ? error.message : error); }
        const results = lookAtGoalChat(ports.dispatcher, chatId);
        const looked = results.filter((entry) => entry.action !== "deferred");
        if (looked.length) log("[long-run] goal look", looked);
        // A "not now" that is not a rest (a grace that ends by itself, a transition just written, a busy store, the dispatch budget, a lease
        // another process held) is looked at again, spaced out; a rest and a clean look end the series (defect 3).
        relookAfter(chatId, results);
      } finally { looking = false; }
    } catch (error) {
      console.warn("[goal-signals] look failed:", error instanceof Error ? error.message : error);
      relookAfter(chatId, null); // a look that could not be made at all (a busy store) is asked again the same way
    }
    timer.aim();
  };
  const lookIn = (chatId: string, delayMs: number): void => {
    if (stopped || !chatId) return;
    const at = now() + Math.max(0, delayMs);
    const held = queued.get(chatId);
    if (held && held.at <= at) return; // an earlier look is already coming: it reads everything
    if (!held && queued.size >= LOOK_QUEUE_CAP) { void timer.wake("resume"); return; } // too many at once: one full look instead of a lost signal
    queued.set(chatId, { at });
    setWake(`look:${chatId}`, at, () => lookNow(chatId)); // replaces a later look of the same chat
  };
  const lookAtOrphansSoon = (): void => {
    if (stopped || wakes.has("orphan")) return;
    setWake("orphan", now() + GOAL_LOOK_DEBOUNCE_MS * 2, () => {
      if (stopped) return;
      try {
        const { lookAtOrphanGoals } = require("./blocked-goal-sweep") as typeof import("./blocked-goal-sweep");
        looking = true;
        try { const closed = lookAtOrphanGoals(ports.dispatcher).filter((entry) => entry.action !== "deferred"); if (closed.length) log("[long-run] orphan goal look", closed); }
        finally { looking = false; }
      } catch (error) { console.warn("[goal-signals] orphan look failed:", error instanceof Error ? error.message : error); }
    });
  };

  // A row of this chat changed (any surface, any process): the owner may have answered, a service turn may have ended, the conversation
  // may be gone. One indexed read decides whether the chat carries a Goal at all; the rest of the chats cost that read and nothing else.
  const chatChanged = (id: string): void => {
    if (looking) return; // the look's own writes are not a reason to look again
    const row = getDb().prepare("SELECT goal_id AS goalId FROM chats WHERE id = ?").get(id) as { goalId: string | null } | undefined;
    if (!row) { lookAtOrphansSoon(); return; }
    if (row.goalId) lookIn(id, GOAL_LOOK_DEBOUNCE_MS);
  };
  // A Goal run's row changed (created, resumed, paused, its attempt settled ...): its chat is looked at once, so a state nobody owns - a Goal
  // set up with no instruction of the owner's, a pause the host wrote, a transition that did not finish - is seen when it begins, not at the
  // next time something else happens to call. Rate-limited per chat; a chat with a live turn here is skipped (its end is the signal).
  const runChanged = (runId: string): void => {
    const row = getDb().prepare("SELECT root_chat_id AS chatId, status FROM long_runs WHERE id = ? AND surface IN ('one','work')").get(runId) as { chatId: string | null; status: string } | undefined;
    if (!row?.chatId || ["completed", "failed", "cancelled"].includes(row.status)) return;
    if (!withinRate(row.chatId)) return;
    lookIn(row.chatId, GOAL_LOOK_DEBOUNCE_MS);
  };
  // Long-run rows change many times inside one turn: the aim is renewed once after a burst, not once per row.
  const aimSoon = (): void => {
    if (stopped || wakes.has("aim")) return;
    setWake("aim", now() + AIM_COALESCE_MS, () => { if (!stopped) timer.aim(); }, true);
  };
  const reclaimSoon = (): void => {
    if (stopped || wakes.has("reclaim")) return;
    setWake("reclaim", now() + GOAL_LOOK_AFTER_TURN_MS, () => { if (!stopped) { reclaimRelays(); timer.aim(); } }, true);
  };
  const onChange = (change: DesktopStoreChange): void => {
    try {
      if (stopped) return;
      if (change.entity === "chat" && change.id) chatChanged(change.id);
      else if (change.entity === "long-run") {
        aimSoon(); // a schedule was written or taken: the aim may move
        if (change.id && !looking) runChanged(change.id);
      }
      else if (change.entity === "runtime" && !wakes.has("runtime")) {
        // The judge pool changed: a message the judge could not answer may be answerable now.
        setWake("runtime", now() + 5_000, () => { reviewMemo = null; try { (require("./goal-owner-amendment") as typeof import("./goal-owner-amendment")).sweepUnavailableOwnerGoalReviews(); } catch { /* the next signal asks again */ } });
      }
    } catch { /* a signal never decides */ }
  };
  const unsubscribe = onDesktopStoreChange(onChange);
  let unsubscribeCards: (() => void) | null = null;
  try {
    const ui = require("../harness/ui-instances") as typeof import("../harness/ui-instances");
    unsubscribeCards = ui.onUiInstanceEvent((event) => { if (event.chatId) lookIn(event.chatId, GOAL_LOOK_DEBOUNCE_MS); });
  } catch { /* the card store is optional here: the next full look reads the answer */ }
  const onResume = (): void => { void timer.wake("resume"); };
  try { ports.power?.on("resume", onResume); } catch { /* no power events: the next signal or look aims again */ }

  const handle: GoalSignalsHandle = {
    timer,
    start: () => timer.start(),
    turnSettled: (chatId) => {
      // Relays a finished turn claimed and never read go back to the parked list (their next-scan time then aims the timer).
      reclaimSoon();
      let goalId: string | null = null;
      try { goalId = (getDb().prepare("SELECT goal_id AS goalId FROM chats WHERE id = ?").get(chatId) as { goalId: string | null } | undefined)?.goalId ?? null; } catch { /* unreadable: the next signal looks */ }
      if (goalId) lookIn(chatId, GOAL_LOOK_AFTER_TURN_MS);
    },
    lookIn,
    stop: () => {
      stopped = true;
      timer.stop(); unsubscribe(); try { unsubscribeCards?.(); } catch { /* gone */ }
      try { ports.power?.removeListener("resume", onResume); } catch { /* gone */ }
      queued.clear();
      wakes.clear();
      if (wakeHandle !== null) clearTimer(wakeHandle);
      wakeHandle = null; wakeArmedAt = null;
      if (current === handle) current = null;
    },
  };
  current = handle;
  return handle;
}
