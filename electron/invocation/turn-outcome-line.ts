/*
 * / a run that did not finish - one that never started
 * (usage limit, signed out, refused before dispatch, ended without a terminal event), or one that was stopped, hit a limit, was cut by a restart, crashed or
 * failed - leaves ONE `turn-outcome` receipt in its conversation, written by the host from the run's end state in the same step that writes that state.
 *
 * The line is made from machine facts only: the run's terminal code, the typed provider failure, who stopped it, the runtime's name, and the receipts the run
 * already wrote. It says, in one fixed sentence (shared/receipt-card.ts TURN_OUTCOME_FIXED), that what is not on a card above is not going on. There is no
 * keyword detection and no reading of the model's words. A reason a person can clear carries the buttons of shared/owner-remedy.ts (resend through another AI,
 * sign in, pick the folder).
 *
 * Every surface draws this one receipt (components/ReceiptCard.tsx; the phone's receipt.card.v1): the personal workspace, One, Work, a room. Where the
 * run's end is written is X1 (invocation/service.ts, patch); this file is the pure decision + the write, no Electron import (the daemon's runs use it).
 * No model call, no timer. The row is the conversation's own and goes with it.
 */
import { classifyOwnerFailureDetailed, externalFailureEntry, type ExternalFailureCause } from "../../shared/owner-failure-class";
import { remedyActionsOf } from "../../shared/owner-remedy";
import type { TurnOutcomeCause } from "../../shared/receipt-card";
import { receiptCountsOfRun, recordReceipt, type RecordReceiptResult } from "../harness/turn-receipts";

export type TurnEndState =
  /** The run finished normally: no line. */
  | "completed"
  /** The run ended before anything reached a model (usage limit, signed out, refused before dispatch, no terminal event with no work done). */
  | "not_started"
  /** The run started and did not finish. */
  | "interrupted";

export interface TurnOutcomeFacts {
  chatId: string;
  runId: string;
  /** The runtime's name (claude-code, codex, byok, ...). */
  runner?: string | null;
  end: TurnEndState;
  /** The run's terminal machine code (event.error.code, receipt.errorCode). */
  code?: string | null;
  /** The host-observed provider failure behind it (a typed `quota` / `auth`; a bare `runtime_turn_unsettled` has none). */
  runtimeFailure?: { kind?: string; source?: string; providerCode?: string | null; retryAfterAt?: string | null; cause?: unknown } | null;
  /** The owner pressed Stop / a steering message replaced the turn. */
  ownerStopped?: boolean;
  /** The app itself ended it: quit or update restart (a typed host fact, not a string to match). */
  hostRestart?: boolean;
  /** The process died: found at the next start still `running`. */
  crashed?: boolean;
  /** The turn ended waiting for the owner (a question card, a sign-in): the owner's move, no line. */
  ownerWait?: boolean;
}

export interface TurnOutcomeDecision { cause: TurnOutcomeCause; code?: string }

/** The code a person-facing line is made from: the typed provider cause behind `runtime_turn_unsettled` when there is one, so a limit is never covered by "may have acted". */
function lineCode(facts: TurnOutcomeFacts, cause: ExternalFailureCause | null): string | undefined {
  const failure = facts.runtimeFailure;
  if (failure?.providerCode && externalFailureEntry(failure.providerCode)) return failure.providerCode;
  if (facts.code && externalFailureEntry(facts.code)) return facts.code;
  if (cause === "provider_limit") return "usage_limit_reached";
  if (cause === "provider_auth") return "runtime_not_signed_in";
  return facts.code ?? undefined;
}

/** What the line is, or null when this end needs none. Pure. */
export function decideTurnOutcome(facts: TurnOutcomeFacts): TurnOutcomeDecision | null {
  if (facts.end === "completed" || facts.ownerWait) return null;
  const verdict = classifyOwnerFailureDetailed({ code: facts.code ?? null, runtimeFailure: facts.runtimeFailure as never ?? null, ownerStopped: facts.ownerStopped === true, ownerWait: false });
  const cause = verdict.cause ?? null;
  const code = lineCode(facts, cause);
  if (facts.end === "not_started") return { cause: "not_started", ...(code ? { code } : {}) };
  if (facts.ownerStopped || cause === "owner_stop") return { cause: "stopped" };
  if (facts.hostRestart) return { cause: "restart" };
  if (facts.crashed) return { cause: "crash" };
  if (cause === "provider_limit") return { cause: "limit", ...(code ? { code } : {}) };
  if (cause === "provider_auth") return { cause: "login", ...(code ? { code } : {}) };
  return { cause: "failed", ...(code ? { code } : {}) };
}

/**
 * Writes the run's one `turn-outcome` receipt (idempotent: the id derives from the run, so a second call for the same run is the same row). Returns null when
 * the run needs no line. Call it in the same step that writes the run's end state.
 */
export function writeTurnOutcome(facts: TurnOutcomeFacts): RecordReceiptResult | null {
  const decision = decideTurnOutcome(facts);
  if (!decision) return null;
  const counts = receiptCountsOfRun(facts.chatId, facts.runId);
  const cause = decision.code ? (externalFailureEntry(decision.code)?.cause ?? null) : null;
  const actions = remedyActionsOf(decision.code, cause);
  return recordReceipt({
    kind: "turn-outcome", outcome: decision.cause === "stopped" ? "cancelled" : decision.cause === "not_started" ? "refused" : "failed",
    ref: { runId: facts.runId }, chatId: facts.chatId, runId: facts.runId, effectId: `${facts.runId}|turn-outcome`,
    cause: decision.cause, ...(decision.code ? { code: decision.code } : {}), ...(facts.runner ? { runner: facts.runner } : {}),
    ...(Object.keys(counts).length ? { counts } : {}), actions,
  });
}

/**
 * At start: runs a dead process left `running` get their line (cause restart, or crash when the caller knows it was not an app restart). `runs` comes from the
 * run table (X1/X7 hunk); a run that already has its line is the same row, so this is safe to run on every start.
 */
export function writeInterruptedRunOutcomes(runs: ReadonlyArray<{ chatId: string; runId: string; runner?: string | null }>, how: { restart: boolean }): number {
  let written = 0;
  for (const run of runs) {
    const result = writeTurnOutcome({ chatId: run.chatId, runId: run.runId, runner: run.runner ?? null, end: "interrupted", ...(how.restart ? { hostRestart: true } : { crashed: true }) });
    if (result?.write === "written") written += 1;
  }
  return written;
}

/* ------------------------------------------------------------------------------------------------ start: runs a dead process left running */

const SWEEP_META_KEY = "turn-outcome:sweep-at";
const RUN_TERMINAL_KINDS = "'invoke_waiting','invoke_completed','mcp_final','invoke_cancelled','invoke_interrupted','invoke_failed','invoke_threw','mcp_error'";

interface SweepDb { prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] } }

/**
 * At start: a run that began after the PREVIOUS sweep, has no terminal event in the ledger, and is not alive in any process (`isLive`: the daemon may own it)
 * was cut by the last close or died: it gets its one line (cause crash - a clean close writes its own terminal event). The marker is one `meta` row
 * (the time of the last sweep, overwritten each start): the first start after this change writes the marker and no line (an old run is not told about
 * retroactively, design 마), and a run is looked at once, never on every start. Idempotent through the row id of the run's line.
 */
export function sweepRunsLeftRunning(input: { db: SweepDb; now?: () => number; isLive?: (runId: string, chatId: string) => boolean }): number {
  const now = new Date((input.now ?? Date.now)()).toISOString();
  const marker = (input.db.prepare("SELECT value FROM meta WHERE key = ?").get(SWEEP_META_KEY) as { value?: string } | undefined)?.value ?? null;
  let written = 0;
  if (marker && Number.isFinite(Date.parse(marker))) {
    const rows = input.db.prepare(`SELECT s.run_id AS runId, s.chat_id AS chatId, s.payload_json AS payload FROM run_events s
      WHERE s.kind = 'invoke_started' AND s.ts > ? AND s.chat_id IS NOT NULL AND s.chat_id <> ''
      AND NOT EXISTS (SELECT 1 FROM run_events t WHERE t.run_id = s.run_id AND t.kind IN (${RUN_TERMINAL_KINDS}))`).all(marker) as Array<{ runId: string; chatId: string; payload: string }>;
    for (const row of rows) {
      let live = false;
      try { live = input.isLive?.(row.runId, row.chatId) === true; } catch { live = false; }
      if (live) continue;
      let runner: string | null = null;
      try { const kind = (JSON.parse(row.payload) as { runtimeKind?: unknown }).runtimeKind; runner = typeof kind === "string" ? kind.slice(0, 40) : null; } catch { runner = null; }
      if (writeTurnOutcome({ chatId: row.chatId, runId: row.runId, runner, end: "interrupted", crashed: true })?.write === "written") written += 1;
    }
  }
  input.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(SWEEP_META_KEY, now);
  return written;
}

/**
 * Whether a conversation has a run that began, has no terminal event in the ledger and is alive in some process (`isLive`: the daemon may own it). The start-time
 * effect reconcile asks it so an effect another process is still running is never called uncertain. Bounded: the newest 8 unterminated runs of the chat.
 */
export function chatHasLiveRun(db: SweepDb, chatId: string, isLive: (runId: string, chatId: string) => boolean): boolean {
  const rows = db.prepare(`SELECT s.run_id AS runId FROM run_events s WHERE s.kind = 'invoke_started' AND s.chat_id = ?
    AND NOT EXISTS (SELECT 1 FROM run_events t WHERE t.run_id = s.run_id AND t.kind IN (${RUN_TERMINAL_KINDS})) ORDER BY s.ts DESC LIMIT 8`).all(chatId) as Array<{ runId: string }>;
  for (const row of rows) { try { if (isLive(row.runId, chatId)) return true; } catch { return true; } }
  return false;
}
