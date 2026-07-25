// Judged One request intent — the resident model decides "conversation vs task" by
// meaning; the verb/length regexes in shared/one-request-intent are demoted to hints
// and remain only the labeled fallback when no model verdict exists.
//
// `InvocationService.start` is synchronous, so the async paths that precede it
// (renderer invoke IPC, the mobile authority send path) warm the judgment cache with
// `resolveOneRequestIntent`, and the sync site reads the verdict via
// `judgedOneRequestIntent` (peek). A cache miss keeps today's deterministic verdict.

import {
  lexicalOneRequestIntent,
  ONE_REQUEST_INTENT_JUDGMENT_GUIDANCE,
  ONE_REQUEST_INTENT_JUDGMENT_KIND,
  ONE_REQUEST_INTENT_JUDGMENT_QUESTION,
  oneRequestIntentJudgmentInput,
  type OneRequestIntent,
} from "../../shared/one-request-intent";
import { judge, peekJudgment, type JudgeSpec, type Verdict } from "../system-agents/judgment";

const INTENT_LABELS = ["conversation", "task"] as const;

const INTENT_HINTS = [
  {
    label: "task" as const,
    words: [
      "계획", "일정", "예산", "체크리스트", "보고서", "문서", "엑셀", "표", "프레젠테이션",
      "만들", "작성", "찾아", "검색", "조사", "비교", "정리", "분석", "요약", "번역",
      "plan", "itinerary", "budget", "checklist", "report", "document", "spreadsheet",
      "presentation", "write", "create", "build", "find", "research", "compare", "summarize",
    ],
  },
  {
    label: "conversation" as const,
    words: ["안녕", "고마워", "감사", "hi", "hello", "thanks", "ok", "테스트", "test"],
  },
];

export interface ResolvedOneRequestIntent {
  intent: OneRequestIntent;
  /** "llm" = the model decided; "fallback" = today's deterministic verdict, labeled. */
  source: "llm" | "fallback";
  reason: string;
}

export type OneRequestIntentJudge = (
  spec: JudgeSpec<OneRequestIntent>,
) => Promise<Verdict<OneRequestIntent>>;

/**
 * Async resolver: judge the request intent by meaning, with the wordlist verdict as
 * the conservative fallback. Also warms the judgment cache for `judgedOneRequestIntent`.
 */
export async function resolveOneRequestIntent(
  prompt: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; judgeFn?: OneRequestIntentJudge } = {},
): Promise<ResolvedOneRequestIntent> {
  const input = oneRequestIntentJudgmentInput(prompt);
  const lexical = lexicalOneRequestIntent(prompt);
  if (!input) return { intent: lexical, source: "fallback", reason: "empty prompt" };
  const run = opts.judgeFn ?? judge;
  const verdict = await run({
    kind: ONE_REQUEST_INTENT_JUDGMENT_KIND,
    question: ONE_REQUEST_INTENT_JUDGMENT_QUESTION,
    labels: INTENT_LABELS,
    input,
    guidance:
      `A deterministic pre-pass classified this as "${lexical}". Treat that as a prior, not a fact. ` +
      ONE_REQUEST_INTENT_JUDGMENT_GUIDANCE,
    hints: INTENT_HINTS,
    fallback: lexical,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  });
  return { intent: verdict.verdict, source: verdict.source, reason: verdict.reason };
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
    // The sync site keeps the deterministic fallback; warming is best-effort.
  }
}

/** Synchronous read of an already-judged intent. null = not judged, keep the fallback. */
export function judgedOneRequestIntent(prompt: string): OneRequestIntent | null {
  const verdict = peekJudgment<OneRequestIntent>(
    ONE_REQUEST_INTENT_JUDGMENT_KIND,
    oneRequestIntentJudgmentInput(prompt),
  );
  return verdict && verdict.source === "llm" ? verdict.verdict : null;
}
