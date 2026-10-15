import { canonicalAskFenceText, extractAskFences, type AgentlasAskQuestion } from "../../shared/ask-fence-flatten";

/*
 * ask_form (agentlas-turn): the typed form of the `<<agentlas-ask>>` block. A recorded call re-enters the pass reply as
 * the canonical block, so the renderer, mobile projection, automation classifier and Goal loop read it unchanged.
 * No electron import (the daemon loads this).
 */
/** Appends the recorded questions to the reply, skipping any the model also wrote as a text block. */
export function appendTurnAsks(text: string, asks: readonly AgentlasAskQuestion[]): string {
  if (asks.length === 0) return text;
  const written = new Set(extractAskFences(text).questions.map((q) => q.question));
  const fresh = asks.filter((q) => !written.has(q.question));
  if (fresh.length === 0) return text;
  const block = canonicalAskFenceText([...fresh]);
  return text.trim() ? `${text.replace(/\s+$/, "")}\n\n${block}` : block;
}
