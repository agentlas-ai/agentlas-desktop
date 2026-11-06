/**
 * The owner passed a human check in the browser: the work that stopped on it continues by itself.
 *
 * Division of labor. fallback-ladder-runtime.ts watches the page and calls begin() when the card goes up, released() when a tab that
 * showed the check is clear, abandon() when it stops without a release (tab or browser closed, chat moved on). This file only DETECTS
 * what may continue and GATES it; the successor turn itself is started by InvocationService.startBrowserSuccessor (the same request
 * and start rules as the verified-sign-in successor). It never decides anything the owner owns:
 *  - the owner's newer words, a queued message, or their Stop win (nothing is started);
 *  - a busy chat waits and its run ending wakes the continuation (idle-retry.ts); a model that used the page again already continues
 *    (noteBrowserOk) and consumes it;
 *  - a Goal chat, an automation, a Site Agent App and any independent controller are not continued from here (gate says why);
 *  - a release starts at most once: a write-once claim row (instance + time) is written first and the started row after start()
 *    returns, so a crash in between is read by the restart sweep (a stale claim is taken over only if no run with its id exists);
 *  - a successor that meets the check again and is released again continues at most twice in a row (chain depth read from the
 *    resumeRunId ancestry of the ledger rows; a page that clears by itself in seconds is not told apart from a person and
 *    is bounded by the same cap); then one status line tells the owner why and how to continue;
 *  - nothing here solves, clicks through or bypasses the check.
 * Ledger (db-retention-policy.ts): run_events kinds browser_page_released (wait + release facts) and browser_page_resume (claim + outcome).
 */
import { randomUUID } from "node:crypto";
import { bindIdleRetrySignals, registerIdleRetry, type IdleRetryHandle, type IdleRetrySignals } from "../invocation/idle-retry";
import { isTransientSendRefusal, sendRefusalCode, startRefusalNeedsOwner, startRefusedBeforeDispatchWaits } from "../../shared/transient-send-refusal";
import type { BrowserSuccessorSnapshot, BrowserSuccessorTarget } from "../invocation/service";

export const PAGE_RELEASED_EVENT = "browser_page_released";
export const PAGE_RESUME_EVENT = "browser_page_resume";
/** A wait or release older than this is not continued (the owner has moved on; their next message starts fresh). */
export const PAGE_RELEASE_KEEP_MS = 6 * 3_600_000;
/** A row younger than this belongs to a live process (its own tick, claim or start still in flight): the sweep leaves it. */
export const PAGE_RELEASE_LIVE_MS = 120_000;
/** Successors in a row that may each meet the check again. */
export const PAGE_RESUME_MAX_DEPTH = 2;
export const PAGE_RESUME_FALLBACK_MS = 15_000;

export interface PageWait { ladderId: string; chatId: string; runId: string; site: string | null; locale: "ko" | "en"; waitStartedAtIso: string; surface: "native" | "dedicated" }
export type WaitCheck = "cleared" | "still" | "unknown";
export interface LedgerRow {
  runId: string; chatId: string; kind: string; sourceEventId: string; payload: Record<string, unknown>;
  /** Nested data the ledger writer would flatten to text: stored exactly on the same row (json_set), read back as an object. */
  exact?: Record<string, unknown>;
}
export interface OpenLedgerWait extends PageWait {
  releasedAtIso: string | null; waitRowAtIso: string; snapshot: BrowserSuccessorSnapshot | null;
  claim: { atIso: string; resumeRunId: string } | null;
}

export interface PageReleasePorts {
  now(): number;
  /** Write-once by (runId, sourceEventId): true only for the caller that wrote the row. */
  writeOnce(row: LedgerRow): boolean;
  hasRow(runId: string, sourceEventId: string): boolean;
  /** Can this run be continued by the host, and with what (service.browserSuccessorTarget). */
  target(runId: string): BrowserSuccessorTarget;
  releaseTarget(runId: string): void;
  /** Successors already chained in front of this run (ancestry of resumeRunId in the ledger); a run an owner message started is 0. */
  chainDepth(runId: string): number;
  ownerSpokeAfter(chatId: string, sinceIso: string): boolean;
  ownerPending(chatId: string): boolean;
  chatBusy(chatId: string): boolean;
  chatHasGoal(chatId: string): boolean;
  runExists(runId: string): boolean;
  start(input: { runId: string; chatId: string; successorRunId: string; userPrompt: string; snapshot: BrowserSuccessorSnapshot }): Promise<{ runId: string }>;
  /** One host-status line in the chat (the reason and the way to continue). */
  say(chatId: string, runId: string, locale: "ko" | "en", reason: "chain_limit"): void;
  /** Re-read the page after a restart (only a surface that outlives the app can answer). */
  recheck(wait: PageWait): Promise<WaitCheck>;
  onSettled?(listener: (envelope: { runId: string }) => void): () => void;
  signals?: IdleRetrySignals;
  instance: string;
  openWaitsSince(sinceIso: string): OpenLedgerWait[];
}

interface Pending extends PageWait {
  released: boolean; claimed: boolean; starting: boolean; resumeRunId: string; snapshot: BrowserSuccessorSnapshot | null; eligible: boolean; unwatch?: () => void;
}

export type PageResumeHandle = ReturnType<typeof createPageReleaseResume>;

export function pageResumePrompt(site: string | null): string {
  return `browser check cleared: the owner passed the page check${site ? ` on ${site}` : ""} that stopped this task. Continue the owner's last request from where the browser stopped.`
    + " Look at the page first and do not repeat a step that already took effect."
    + " If the page still shows a check or a sign-in, say so once and stop; never try to solve or bypass it.";
}

export function createPageReleaseResume(ports: PageReleasePorts) {
  const pending = new Map<string, Pending>();
  let handle: IdleRetryHandle | null = null;
  let signalsBound = false;
  const iso = (ms: number) => new Date(ms).toISOString();
  const resumeId = (ladderId: string) => `browser-resume:${ladderId}`;
  const claimId = (ladderId: string) => `browser-claim:${ladderId}`;

  const ensureHandle = (): IdleRetryHandle => {
    // Without the service's run-end signals the fallback timer alone wakes a waiting continuation.
    if (!signalsBound) { signalsBound = true; try { if (ports.signals) bindIdleRetrySignals(ports.signals); } catch { /* timer only */ } }
    handle ??= registerIdleRetry({ name: "browser-page-release", fallbackMs: PAGE_RESUME_FALLBACK_MS,
      pendingChats: () => [...new Set([...pending.values()].filter((p) => p.released).map((p) => p.chatId))],
      retry: (chatId) => { for (const p of [...pending.values()]) if (p.released && p.chatId === chatId) void tick(p); } });
    return handle;
  };
  const drop = (p: Pending): void => {
    p.unwatch?.(); pending.delete(p.ladderId);
    try { ports.releaseTarget(p.runId); } catch { /* the hold is bounded */ }
    if (![...pending.values()].some((q) => q.released)) { handle?.dispose(); handle = null; }
  };
  const outcome = (p: Pending, value: "started" | "skipped" | "failed", reason: string): boolean => ports.writeOnce({
    runId: p.runId, chatId: p.chatId, kind: PAGE_RESUME_EVENT, sourceEventId: resumeId(p.ladderId),
    payload: { schemaVersion: 1, phase: "outcome", ladderId: p.ladderId, outcome: value, reason, site: p.site, resumeRunId: p.resumeRunId } });
  const finish = (p: Pending, value: "skipped" | "failed", reason: string): void => {
    try { outcome(p, value, reason); } catch { /* the in-memory close below still ends it */ }
    drop(p);
  };

  async function tick(p: Pending): Promise<void> {
    if (p.starting || !pending.has(p.ladderId) || !p.released) return;
    p.starting = true;
    try {
      if (!p.eligible) { finish(p, "skipped", "not_continued_by_host"); return; }
      if (!p.claimed && ports.hasRow(p.runId, resumeId(p.ladderId))) { drop(p); return; }
      if (ports.now() - Date.parse(p.waitStartedAtIso) > PAGE_RELEASE_KEEP_MS) { finish(p, "skipped", "release_too_old"); return; }
      if (ports.ownerSpokeAfter(p.chatId, p.waitStartedAtIso)) { finish(p, "skipped", "owner_wrote_newer"); return; }
      if (ports.ownerPending(p.chatId)) { finish(p, "skipped", "owner_message_waiting"); return; }
      if (ports.chatBusy(p.chatId)) return; // the chat leaving its turn wakes this again; nothing is counted
      if (ports.chatHasGoal(p.chatId)) { finish(p, "skipped", "goal_owns_continuation"); return; }
      if (!p.claimed) {
        if (ports.chainDepth(p.runId) >= PAGE_RESUME_MAX_DEPTH) {
          finish(p, "skipped", "chain_limit");
          try { ports.say(p.chatId, p.runId, p.locale, "chain_limit"); } catch { /* the outcome row stays */ }
          return;
        }
        // Claim first (instance + time), started after start() returned: a crash in between is a stale claim, read by the sweep.
        if (!ports.writeOnce({ runId: p.runId, chatId: p.chatId, kind: PAGE_RESUME_EVENT, sourceEventId: claimId(p.ladderId),
          payload: { schemaVersion: 1, phase: "claim", ladderId: p.ladderId, instance: ports.instance, resumeRunId: p.resumeRunId, site: p.site } })) { drop(p); return; }
        p.claimed = true;
      }
      if (!p.snapshot) { finish(p, "failed", "no_continuation_data"); return; }
      // Another process took the stale claim over and its start went through: this one only records it, it never retries a duplicate.
      if (ports.runExists(p.resumeRunId)) { try { outcome(p, "started", "start_found_running"); } catch { /* the run exists */ } drop(p); return; }
      try {
        await ports.start({ runId: p.runId, chatId: p.chatId, successorRunId: p.resumeRunId, userPrompt: pageResumePrompt(p.site), snapshot: p.snapshot });
      } catch (error) {
        // Transient (the chat is not ready) or refused before anything was sent: keep the claim and wait for the next wake.
        if (isTransientSendRefusal(error) || startRefusedBeforeDispatchWaits(error)) return;
        // An owner-action refusal (a cost cap, a stopped Goal, a setting) already has its own sentence in the chat; only the outcome is recorded.
        finish(p, "failed", startRefusalNeedsOwner(sendRefusalCode(error)) ? "start_refused_owner_action" : "start_refused");
        return;
      }
      try { outcome(p, "started", "continuation_started"); } catch { /* the claim row says a start was attempted */ }
      drop(p);
    } catch (error) {
      console.warn("[page-release-resume] tick failed", error instanceof Error ? error.message : error);
    } finally { p.starting = false; }
  }

  const track = (wait: PageWait, released: boolean, eligible: boolean, snapshot: BrowserSuccessorSnapshot | null, resumeRunId: string = randomUUID()): Pending => {
    const p: Pending = { ...wait, released, claimed: false, starting: false, resumeRunId, snapshot, eligible };
    pending.set(wait.ladderId, p);
    return p;
  };

  return {
    /** The card is up and the watcher started. Says whether the app can continue this run afterwards (the model is told the truth). */
    begin(wait: PageWait): { eligible: boolean; reason: string } {
      if (pending.has(wait.ladderId)) return { eligible: pending.get(wait.ladderId)!.eligible, reason: "already_waiting" };
      let target: BrowserSuccessorTarget = { eligible: false, reason: "target_unreadable" };
      try { target = ports.target(wait.runId); } catch { /* ineligible: the old behavior, the owner writes */ }
      let goal = false;
      try { goal = ports.chatHasGoal(wait.chatId); } catch { /* the tick asks again */ }
      const eligible = target.eligible && !goal;
      const p = track(wait, false, eligible, target.eligible ? target.snapshot : null);
      try {
        ports.writeOnce({ runId: wait.runId, chatId: wait.chatId, kind: PAGE_RELEASED_EVENT, sourceEventId: `browser-wait:${wait.ladderId}`,
          payload: { schemaVersion: 1, state: "waiting", ladderId: wait.ladderId, site: wait.site, surface: wait.surface, locale: wait.locale,
            waitStartedAtIso: wait.waitStartedAtIso, eligible }, ...(target.eligible ? { exact: { snapshot: target.snapshot } } : {}) });
      } catch { /* a restart before the release loses this wait only */ }
      return { eligible, reason: eligible ? "ok" : goal ? "goal_owns_continuation" : (target as { reason?: string }).reason ?? "not_eligible" };
    },
    /** A tab that showed the check is clear. Records the fact once and asks for the continuation. */
    released(ladderId: string): void {
      const p = pending.get(ladderId);
      if (!p) return;
      p.released = true;
      try {
        ports.writeOnce({ runId: p.runId, chatId: p.chatId, kind: PAGE_RELEASED_EVENT, sourceEventId: `browser-release:${p.ladderId}`,
          payload: { schemaVersion: 1, state: "released", ladderId: p.ladderId, site: p.site, locale: p.locale, waitStartedAtIso: p.waitStartedAtIso },
          ...(p.snapshot ? { exact: { snapshot: p.snapshot } } : {}) });
      } catch { /* the in-memory release still continues; only a restart before it ran loses it */ }
      ensureHandle().arm();
      handle?.wakeAll();
    },
    /** The watcher stopped without a release (a tab or the browser closed, the chat moved on, the watch ran out): nothing to continue. */
    abandon(ladderId: string, reason = "abandoned"): void { const p = pending.get(ladderId); if (p) finish(p, "skipped", reason); },
    /** A browser call of the model succeeded on this site: the run is already continuing (a call on another site proves nothing). */
    noteBrowserOk(chatId: string, site: string | null): void {
      if (!site) return;
      for (const p of [...pending.values()]) if (p.chatId === chatId && p.site === site && !p.claimed) finish(p, "skipped", "agent_continued");
    },
    /**
     * Restart sweep (Desktop Main and the background service each call it once at start). Waits and releases the ledger holds with no
     * outcome: a release goes on; a wait whose page can be read again (a surface that outlived the app) is judged now, any other wait
     * is judged by the next browser call of the chat. Rows younger than two minutes belong to a live process and are left alone.
     */
    async sweep(): Promise<number> {
      let armed = 0;
      const liveBefore = iso(ports.now() - PAGE_RELEASE_LIVE_MS);
      for (const open of ports.openWaitsSince(iso(ports.now() - PAGE_RELEASE_KEEP_MS))) {
        if (pending.has(open.ladderId)) continue;
        const stamp = open.releasedAtIso ?? open.waitRowAtIso;
        if (stamp > liveBefore) continue;
        if (open.claim) {
          if (open.claim.atIso > liveBefore) continue; // another process is starting it right now
          if (ports.runExists(open.claim.resumeRunId)) { // the start went through; only the started row was lost
            try { ports.writeOnce({ runId: open.runId, chatId: open.chatId, kind: PAGE_RESUME_EVENT, sourceEventId: resumeId(open.ladderId),
              payload: { schemaVersion: 1, phase: "outcome", ladderId: open.ladderId, outcome: "started", reason: "start_found_after_restart", site: open.site, resumeRunId: open.claim.resumeRunId } }); } catch { /* read again next start */ }
            continue;
          }
        }
        // After a restart a Telegram turn cannot be routed back to its chat (the worker's subscription is gone): recorded, not continued.
        if (open.snapshot?.executionSource === "telegram") {
          try { ports.writeOnce({ runId: open.runId, chatId: open.chatId, kind: PAGE_RESUME_EVENT, sourceEventId: resumeId(open.ladderId),
            payload: { schemaVersion: 1, phase: "outcome", ladderId: open.ladderId, outcome: "skipped", reason: "not_continued_by_host", site: open.site, resumeRunId: open.claim?.resumeRunId ?? "" } }); } catch { /* read again next start */ }
          continue;
        }
        const eligible = open.snapshot !== null;
        const p = track(open, open.releasedAtIso !== null, eligible, open.snapshot, open.claim?.resumeRunId);
        if (open.claim) p.claimed = true; // the stale claim is ours to finish: same successor id, so a start that did happen cannot double
        if (!p.released) {
          let verdict: WaitCheck = "unknown";
          try { verdict = await ports.recheck(open); } catch { /* unknown */ }
          if (verdict === "cleared") p.released = true; else continue;
        }
        armed += 1;
      }
      if (armed) { ensureHandle().arm(); handle?.wakeAll(); }
      return armed;
    },
    pendingCount: () => pending.size,
    timerArmed: () => handle?.timerArmed() ?? false,
  };
}

// ── Production ports (lazy: the store and the invocation service load only when something happens) ─────────────────────────────

type Service = import("../invocation/service").InvocationService;
let service: Service | null = null;
const loadService = (): Service => (service ??= (require("../invocation/service") as typeof import("../invocation/service")).invocationService);

/** The real-store ports (exported for the private sqlite gate, which replaces only the service-facing ones). */
export function productionPorts(): PageReleasePorts {
  const store = () => require("../store/run-events") as typeof import("../store/run-events");
  const db = () => (require("../store/db") as typeof import("../store/db")).getDb();
  const instance = `${process.pid}:${randomUUID().slice(0, 8)}`;
  return {
    instance,
    now: () => Date.now(),
    writeOnce: (row) => db().transaction(() => {
      if (store().getRunEventBySource(row.runId, row.sourceEventId)) return false;
      const written = store().recordRunEvent({ runId: row.runId, chatId: row.chatId, kind: row.kind, sourceEventId: row.sourceEventId, payload: row.payload });
      // The ledger writer flattens nested values to text (a diagnostic limit): the exact data is set on the row it just wrote, same transaction.
      for (const [key, value] of Object.entries(row.exact ?? {})) {
        db().prepare(`UPDATE run_events SET payload_json = json_set(payload_json, '$.${key.replace(/[^A-Za-z0-9_]/g, "")}', json(?)) WHERE id = ?`).run(JSON.stringify(value), written.id);
      }
      return true;
    }).immediate(),
    hasRow: (runId, sourceEventId) => Boolean(store().getRunEventBySource(runId, sourceEventId)),
    target: (runId) => loadService().browserSuccessorTarget(runId),
    releaseTarget: (runId) => loadService().releaseBrowserSuccessorTarget(runId),
    chainDepth: (runId) => {
      let depth = 0, current = runId;
      for (; depth < 6; depth += 1) {
        const parent = db().prepare("SELECT run_id AS runId FROM run_events WHERE kind = ? AND json_extract(payload_json, '$.resumeRunId') = ? LIMIT 1")
          .get(PAGE_RESUME_EVENT, current) as { runId?: string } | undefined;
        if (!parent?.runId || parent.runId === current) break;
        current = parent.runId;
      }
      return depth;
    },
    ownerSpokeAfter: (chatId, sinceIso) => (require("../invocation/host-recovery") as typeof import("../invocation/host-recovery")).ownerSpokeAfter(db(), chatId, null, sinceIso),
    ownerPending: (chatId) => loadService().hasQueuedOwnerRequest(chatId),
    chatBusy: (chatId) => loadService().activeChatIds().includes(chatId),
    chatHasGoal: (chatId) => Boolean((require("../store/chats") as typeof import("../store/chats")).getChatGoalId(chatId)),
    runExists: (runId) => Boolean(store().getInvocationRunReceipt(runId)),
    start: (input) => loadService().startBrowserSuccessor(input),
    say: (chatId, runId, locale) => {
      const chats = require("../store/chats") as typeof import("../store/chats");
      const line = locale === "ko"
        ? "사람 확인을 풀어 주셨지만 같은 확인이 다시 나와서 자동으로 이어가기를 여기서 멈췄어요. 이어서 하려면 이 방에 \"이어서 해 주세요\"라고 보내 주세요."
        : "You passed the page check, but the same check came back, so automatic continuing stopped here. Send \"continue\" in this room to go on.";
      chats.appendChatMessage(chatId, "assistant", line, { hostNotice: { purpose: "host-status", runId, status: "needs-owner" } });
      try { (require("../store/changes") as { emitDesktopStoreChange?: (e: { entity: string; id: string }) => void }).emitDesktopStoreChange?.({ entity: "chat", id: chatId }); } catch { /* the line is stored */ }
    },
    recheck: async (wait) => (await import("./fallback-ladder-runtime")).recheckHumanCheckWait({ site: wait.site, surface: wait.surface }),
    onSettled: (listener) => loadService().onSettled((envelope) => listener(envelope)),
    get signals() { return loadService() as unknown as IdleRetrySignals; },
    openWaitsSince: (sinceIso) => {
      const rows = db().prepare("SELECT run_id AS runId, chat_id AS chatId, kind, payload_json AS payloadJson, ts FROM run_events WHERE kind IN (?, ?) AND ts > ? AND chat_id IS NOT NULL ORDER BY seq")
        .all(PAGE_RELEASED_EVENT, PAGE_RESUME_EVENT, sinceIso) as Array<{ runId: string; chatId: string; kind: string; payloadJson: string; ts: string }>;
      const byLadder = new Map<string, Partial<OpenLedgerWait> & { closed?: boolean; runId: string; chatId: string }>();
      for (const row of rows) {
        let payload: Record<string, unknown>;
        try { payload = JSON.parse(row.payloadJson) as Record<string, unknown>; } catch { continue; }
        const id = payload.ladderId;
        if (typeof id !== "string") continue;
        const entry = byLadder.get(id) ?? { runId: row.runId, chatId: row.chatId, ladderId: id };
        byLadder.set(id, entry);
        if (row.kind === PAGE_RESUME_EVENT) {
          if (payload.phase === "outcome") entry.closed = true;
          else if (typeof payload.resumeRunId === "string") entry.claim = { atIso: row.ts, resumeRunId: payload.resumeRunId };
          continue;
        }
        entry.site = typeof payload.site === "string" ? payload.site : null;
        entry.locale = payload.locale === "ko" ? "ko" : "en";
        if (payload.surface === "native" || payload.surface === "dedicated") entry.surface = payload.surface;
        entry.waitStartedAtIso = String(payload.waitStartedAtIso ?? row.ts);
        if (payload.state === "released") entry.releasedAtIso = row.ts; else entry.waitRowAtIso = row.ts;
        if (payload.snapshot && typeof payload.snapshot === "object") entry.snapshot = payload.snapshot as BrowserSuccessorSnapshot;
      }
      return [...byLadder.values()].filter((e) => !e.closed && e.waitStartedAtIso).map((e) => ({
        ladderId: e.ladderId!, chatId: e.chatId, runId: e.runId, site: e.site ?? null, locale: e.locale ?? "en", surface: e.surface ?? "dedicated",
        waitStartedAtIso: e.waitStartedAtIso!, releasedAtIso: e.releasedAtIso ?? null, waitRowAtIso: e.waitRowAtIso ?? e.releasedAtIso ?? e.waitStartedAtIso!,
        snapshot: e.snapshot ?? null, claim: e.claim ?? null }));
    },
  };
}

let instance: PageResumeHandle | null = null;
/** The process-wide continuation. The start of Desktop Main and of the background service call .sweep() once. */
export function pageReleaseResume(): PageResumeHandle {
  instance ??= createPageReleaseResume(productionPorts());
  return instance;
}
