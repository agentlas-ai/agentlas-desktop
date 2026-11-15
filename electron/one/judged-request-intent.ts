// Judged One request intent — the resident model alone decides "conversation vs
// task" by meaning. A missing verdict stays unavailable; no wordlist guesses.
//
// `InvocationService.start` is synchronous, so the async paths that precede it
// (renderer invoke IPC, the mobile authority send path) warm the judgment cache with
// `resolveOneRequestIntent`, and the sync site reads the verdict via
// `judgedOneRequestIntent` (peek). A cache miss remains undecided.

import {
  ONE_REQUEST_INTENT_JUDGMENT_GUIDANCE,
  ONE_REQUEST_INTENT_JUDGMENT_KIND,
  ONE_REQUEST_INTENT_JUDGMENT_QUESTION,
  oneRequestIntentJudgmentInput,
  type OneRequestIntent,
} from "../../shared/one-request-intent";
import {
  judgeRequired,
  peekJudgment,
  type RequiredJudgeSpec,
  type RequiredVerdict,
} from "../system-agents/judgment";
import type { RuntimeSelection } from "../../shared/types";

const INTENT_LABELS = ["conversation", "task"] as const;

export interface ResolvedOneRequestIntent {
  intent: OneRequestIntent | "undecided";
  source: "llm" | "unavailable" | "existing_goal";
  reason: string;
}

export type OneRequestIntentJudge = (
  spec: RequiredJudgeSpec<OneRequestIntent>,
) => Promise<RequiredVerdict<OneRequestIntent>>;

/**
 * Async resolver: judge the request intent by meaning and warm the cache. A
 * missing or invalid model response remains explicitly undecided.
 */
export async function resolveOneRequestIntent(
  prompt: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; judgeFn?: OneRequestIntentJudge; runtimeSelection?: RuntimeSelection;
    boundExistingGoal?: boolean } = {},
): Promise<ResolvedOneRequestIntent> {
  const input = oneRequestIntentJudgmentInput(prompt);
  if (!input) return { intent: "undecided", source: "unavailable", reason: "empty prompt" };
  const run = opts.judgeFn ?? judgeRequired;
  const fallback = (reason: string): ResolvedOneRequestIntent => opts.boundExistingGoal && !opts.signal?.aborted
    ? { intent: "task", source: "existing_goal", reason: `existing_goal_continues:${reason}` }
    : { intent: "undecided", source: "unavailable", reason };
  let verdict: RequiredVerdict<OneRequestIntent>;
  try { verdict = await run({
    kind: ONE_REQUEST_INTENT_JUDGMENT_KIND,
    question: ONE_REQUEST_INTENT_JUDGMENT_QUESTION,
    labels: INTENT_LABELS,
    input,
    guidance: ONE_REQUEST_INTENT_JUDGMENT_GUIDANCE,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    runtimeSelection: opts.runtimeSelection,
  }); } catch { return fallback("judgment_failed"); }
  return verdict.source === "llm" && verdict.verdict !== null
    ? { intent: verdict.verdict, source: "llm", reason: verdict.reason }
    : fallback(verdict.reason);
}

/**
 * Does the start path read this turn's verdict? invocation/service.ts reads it in one place (`judgedTaskIntent`), and not for the personal
 * agent's own conversation (`personalSupervisor`: its reply turn is system-written, taskIntent "conversation", and the verdict decided
 * nothing there), except for a companion-front turn, which is not counted as that conversation. This is that same condition, so a turn the
 * start never reads is not asked: it was one model call per personal-agent reply whose answer nobody read (scripts/test-one-request-intent-read-once.cjs
 * holds both sites). Unknown (no chat or run id, an unreadable store) is "read": the call is made as before.
 */
export async function startReadsRequestIntent(request: { chatId?: string; runId?: string }): Promise<boolean> {
  if (typeof request.chatId !== "string" || !request.chatId || typeof request.runId !== "string" || !request.runId) return true;
  try {
    const { getDb } = await import("../store/db");
    const db = getDb();
    const { personalSupervisorConversationInDb } = await import("./supervisor-store");
    const { getOneProfile } = await import("../store/one-profile");
    if (!personalSupervisorConversationInDb(db, getOneProfile().oneId, request.chatId)) return true;
    const { isCompanionFrontOwnLane } = await import("./companion-front-inbox");
    return isCompanionFrontOwnLane(db, request.runId, request.chatId);
  } catch {
    return true;
  }
}

/** Warm the cache for a One conversation-shaped turn before the sync start path runs. */
export async function prejudgeOneRequestIntent(
  request: { chatId?: string; runId?: string; oneMode?: boolean; taskIntent?: string; userPrompt?: string; runtimeSelection?: RuntimeSelection },
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  if (request.oneMode !== true) return;
  if (request.taskIntent !== undefined && request.taskIntent !== "conversation") return;
  if (typeof request.userPrompt !== "string" || !request.userPrompt.trim()) return;
  if (!(await startReadsRequestIntent(request))) return;
  try {
    await resolveOneRequestIntent(request.userPrompt, { ...opts, runtimeSelection: request.runtimeSelection });
  } catch {
    // A failed warm remains undecided; warming is best-effort.
  }
}

/** Synchronous read of an already-judged intent. null = not judged. */
export function judgedOneRequestIntent(prompt: string, runtimeSelection?: RuntimeSelection, boundExistingGoal = false): OneRequestIntent | null {
  const verdict = peekJudgment<OneRequestIntent>(
    ONE_REQUEST_INTENT_JUDGMENT_KIND,
    oneRequestIntentJudgmentInput(prompt),
    undefined,
    runtimeSelection,
  );
  return verdict && verdict.source === "llm" ? verdict.verdict : boundExistingGoal ? "task" : null;
}
