import { parseGoalWaitIntent, type GoalWaitIntent } from "../long-run/wait-emitter";
import { GOAL_COMPLETE_MARKER } from "../hephaestus/loop-engineering";

/*
 * What a model said through the agentlas-turn goal tools during one pass. Instead of teaching the host a second
 * path, the host turns each signal back into the exact text block the pass would otherwise have ended with
 * (applyGoalSignalsToText) and hands it to the unchanged parsers: the wait registration, the completion claim and the
 * ledger verdict therefore run the same code the text protocol runs. No electron import (the daemon loads this).
 */
export interface GoalSignals {
  wait?: GoalWaitIntent;
  complete?: { evidence: string | null };
}
const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_RUNS = 64;
const pending = new Map<string, { at: number; signals: GoalSignals }>();

function prune(now: number): void {
  for (const [key, entry] of pending) if (now - entry.at > TTL_MS) pending.delete(key);
  while (pending.size > MAX_RUNS) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
}
function entryFor(key: string): { at: number; signals: GoalSignals } {
  const now = Date.now();
  prune(now);
  const entry = pending.get(key) ?? { at: now, signals: {} };
  pending.set(key, entry);
  return entry;
}

export type GoalSignalOutcome = "recorded" | "wait_already_requested" | "complete_already_declared" | "conflicts_with_wait" | "conflicts_with_complete";

export function recordGoalWaitSignal(key: string, intent: GoalWaitIntent): GoalSignalOutcome {
  const entry = entryFor(key);
  if (entry.signals.wait) return "wait_already_requested";
  // The text protocol says: never declare the Goal complete in the response that requests a wait.
  if (entry.signals.complete) return "conflicts_with_complete";
  entry.signals.wait = intent;
  return "recorded";
}

export function recordGoalCompleteSignal(key: string, evidence: string | null): GoalSignalOutcome {
  const entry = entryFor(key);
  if (entry.signals.complete) return "complete_already_declared";
  if (entry.signals.wait) return "conflicts_with_wait";
  entry.signals.complete = { evidence };
  return "recorded";
}

/** Removes and returns the pass's signals (null when none). */
export function takeGoalSignals(key: string | null | undefined): GoalSignals | null {
  if (!key) return null;
  const entry = pending.get(key);
  pending.delete(key);
  return entry && (entry.signals.wait || entry.signals.complete) ? entry.signals : null;
}

/** The marker the text protocol would carry for this evidence; the payload cannot contain `>` or a line break. */
export function goalCompleteMarkerText(evidence: string | null): string {
  const clean = (evidence ?? "").replace(/[>\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
  return clean ? GOAL_COMPLETE_MARKER.replace(">>", `: ${clean}>>`) : GOAL_COMPLETE_MARKER;
}

export function goalWaitBlockText(intent: GoalWaitIntent): string {
  return "```agentlas-goal-wait\n" + JSON.stringify(intent) + "\n```";
}

/**
 * Append the equivalent text blocks to the pass's reply. A reply that already carries its own wait block keeps it
 * (the parser refuses two); a tool wait is then ignored rather than making the request ambiguous.
 */
export function applyGoalSignalsToText(text: string, signals: GoalSignals | null): string {
  if (!signals) return text;
  let out = text;
  if (signals.wait && !out.includes("```agentlas-goal-wait")) out = `${out.trimEnd()}\n\n${goalWaitBlockText(signals.wait)}`;
  else if (signals.complete && !signals.wait) out = `${out.trimEnd()}\n${goalCompleteMarkerText(signals.complete.evidence)}`;
  return out;
}

/** The wait the text parser would register for this intent, or its refusal reason. */
export function validateGoalWaitIntent(intent: unknown): { ok: true; intent: GoalWaitIntent } | { ok: false; reason: string } {
  const parsed = parseGoalWaitIntent("```agentlas-goal-wait\n" + JSON.stringify(intent) + "\n```").request;
  if (parsed?.status === "requested") return { ok: true, intent: parsed.intent };
  return { ok: false, reason: parsed?.status === "invalid" ? parsed.reason : "goal_wait_request_invalid" };
}

/**
 * Goal text that stays when goal_wait / goal_complete replace the marker teaching. A finite Goal needs none (the tools
 * carry the format); an ongoing Goal's mandate is behaviour the schemas cannot say.
 */
export function typedGoalLifecycleProtocol(lifecycle: "finite" | "ongoing" | null | undefined): string | null {
  if (lifecycle !== "ongoing") return null;
  return "## Ongoing Goal (host-owned)\nA continuing responsibility the user asked for: it stays open until the user stops it. Work in bounded episodes: inspect current state and durable receipts first, respect the user's cadence, never repeat a completed or uncertain external effect, and use goal_complete only to close the current episode and goal_wait (timer) when nothing is due yet.";
}

/** Deadline clause for a Goal whose timer waits go through the goal_wait tool (no JSON grammar). */
export function typedGoalDeadlineClause(deadlineAt: string): string {
  return `This Goal has a deadline: ${deadlineAt}. Until then keep working in bounded cycles; a timer goal_wait may not be later than it (a later one is moved to it). Inspect current external state before acting and never repeat a completed post or purchase. At the deadline, measure the target and finish without a wait so it is verified.`;
}
