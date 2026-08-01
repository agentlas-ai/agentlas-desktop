export type OneRequestIntent = "conversation" | "task";

/**
 * The sync decision is three-valued now: the connected model's verdict, or an
 * explicit "undecided" when NO model verdict exists. "undecided" is NOT a
 * keyword guess — callers treat it as "no decision" (keep the safe conversational
 * default; surface the connect-a-model line where user-visible).
 */
export type OneRequestIntentDecision = OneRequestIntent | "undecided";

/** Judgment-cache kind shared by the async resolver and the synchronous peek reader. */
export const ONE_REQUEST_INTENT_JUDGMENT_KIND = "one-request-intent";

export const ONE_REQUEST_INTENT_JUDGMENT_QUESTION =
  "Is the user asking One to DO durable work (produce, plan, research, transform, or organize something), or is this an ordinary conversational message (greeting, small talk, a quick factual or product question)?";

export const ONE_REQUEST_INTENT_JUDGMENT_GUIDANCE =
  "\"task\" means the turn should be preserved as durable work with a deliverable. " +
  "A short factual question, a greeting, or chit-chat is \"conversation\" even when it names a work-like noun. " +
  "A genuine work request is \"task\" in ANY language or phrasing, even when none of the reference words appear.";

/** The exact input string the resolver judges and synchronous sites peek. */
export function oneRequestIntentJudgmentInput(prompt: string): string {
  if (typeof prompt !== "string") return "";
  return prompt.normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, 4_000);
}

/**
 * Product intent only: decide whether One should preserve the turn as durable
 * work or answer it as an ordinary conversation. This does not choose agents,
 * authorize tools, or infer that a result is complete.
 *
 * The connected model decides: `judged` is a synchronous reader of an
 * already-judged verdict (electron passes a peek into the resident judgment cache
 * warmed by `resolveOneRequestIntent`). When NO model verdict exists — renderer
 * call, no model, cache miss — this returns "undecided". It NEVER falls back to
 * the wordlist: an undecided turn keeps the safe conversational default and the
 * surface shows the connect-a-model line. No wordlist, regex route, or scripted
 * semantic fallback participates in this decision.
 */
export function classifyOneRequestIntent(
  prompt: string,
  judged?: (prompt: string) => OneRequestIntent | null,
): OneRequestIntentDecision {
  if (typeof prompt !== "string") return "conversation";
  const judgedIntent = judged?.(prompt) ?? null;
  if (judgedIntent !== null) return judgedIntent;
  return "undecided";
}
