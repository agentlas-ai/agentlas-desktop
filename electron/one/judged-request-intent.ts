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
import { judge, peekJudgment, type JudgeSpec, type Verdict } from "../system-agents/judgment";

const INTENT_LABELS = ["conversation", "task"] as const;

export interface ResolvedOneRequestIntent {
  intent: OneRequestIntent | "undecided";
  source: "llm" | "unavailable";
  reason: string;
}

export type OneRequestIntentJudge = (
  spec: JudgeSpec<OneRequestIntent>,
) => Promise<Verdict<OneRequestIntent>>;

/**
 * Async resolver: judge the request intent by meaning and warm the cache. The
 * judge API requires a transport fallback label, but it is never accepted as a
 * product decision.
 */
export async function resolveOneRequestIntent(
  prompt: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; judgeFn?: OneRequestIntentJudge } = {},
): Promise<ResolvedOneRequestIntent> {
  const input = oneRequestIntentJudgmentInput(prompt);
  if (!input) return { intent: "undecided", source: "unavailable", reason: "empty prompt" };
  const run = opts.judgeFn ?? judge;
  const verdict = await run({
    kind: ONE_REQUEST_INTENT_JUDGMENT_KIND,
    question: ONE_REQUEST_INTENT_JUDGMENT_QUESTION,
    labels: INTENT_LABELS,
    input,
    guidance: ONE_REQUEST_INTENT_JUDGMENT_GUIDANCE,
    hints: [],
    fallback: "conversation",
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  });
  return verdict.source === "llm"
    ? { intent: verdict.verdict, source: "llm", reason: verdict.reason }
    : { intent: "undecided", source: "unavailable", reason: verdict.reason };
}

/** Warm the cache for a One conversation-shaped turn before the sync start path runs. */
export async function prejudgeOneRequestIntent(
  request: { oneMode?: boolean; taskIntent?: string; userPrompt?: string },
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  if (request.oneMode !== true) return;
  if (request.taskIntent !== undefined && request.taskIntent !== "conversation") return;
  if (typeof request.userPrompt !== "string" || !request.userPrompt.trim()) return;
  try {
    await resolveOneRequestIntent(request.userPrompt, opts);
  } catch {
    // A failed warm remains undecided; warming is best-effort.
  }
}

/** Synchronous read of an already-judged intent. null = not judged. */
export function judgedOneRequestIntent(prompt: string): OneRequestIntent | null {
  const verdict = peekJudgment<OneRequestIntent>(
    ONE_REQUEST_INTENT_JUDGMENT_KIND,
    oneRequestIntentJudgmentInput(prompt),
  );
  return verdict && verdict.source === "llm" ? verdict.verdict : null;
}
