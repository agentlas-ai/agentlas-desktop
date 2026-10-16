/*
 * Output-token cap: a reply cut by the cap is a partial reply, never a failed turn (owner rule 2026-10-13: remove
 * harness interference such as ending a turn on an output limit). Every API runner (Agentlas serving, BYOK Anthropic /
 * Google / OpenAI-compatible, and the local-tool-loop shared by Ollama, LM Studio, MLX and local OpenAI servers)
 * keeps the partial text, sends one short host turn on the same conversation, and joins the pieces.
 *
 * The host turn is a registered prompt module (PROMPT-COMPOSITION-POLICY): stability "turn-context", rendered per
 * model output, composed by the canonical composer. Two variants, one sentence each:
 *   text      the answer was cut mid-text: continue where it stopped.
 *   tool-call a tool call was cut mid-arguments: it was NOT run; split the work into smaller calls.
 */
import { composeDeclaredPrompt, type DeclaredPromptPart } from "./prompt-order";

/** Consecutive cut replies a runner continues before it stops asking (a bound, not a quality gate). */
export const OUTPUT_LIMIT_CONTINUATION_MAX_ROUNDS = 4;

export type OutputLimitCut = "text" | "tool-call";

export const OUTPUT_LIMIT_CONTINUATION_MODULE_IDS: Readonly<Record<OutputLimitCut, string>> = Object.freeze({
  text: "continuation.output-limit.text",
  "tool-call": "continuation.output-limit.tool-call",
});

const TEXT: Record<OutputLimitCut, string> = {
  text: "host: your reply was cut off by the output limit; continue exactly where it stopped.",
  "tool-call": "host: your tool call was cut off by the output limit and was not run; split the work into smaller calls.",
};

/** Longest tail of a partial reply a runner quotes back when it cannot place it as its own assistant turn. */
export const OUTPUT_LIMIT_PARTIAL_TAIL_CHARS = 1_500;

export function outputLimitContinuationParts(cut: OutputLimitCut, partialTail?: string): DeclaredPromptPart[] {
  const tail = partialTail?.trim() ? partialTail.slice(-OUTPUT_LIMIT_PARTIAL_TAIL_CHARS) : "";
  return [
    // Model-authored data, turn-scoped; only a runner whose wire cannot carry an assistant turn here supplies it.
    { id: "continuation.output-limit.partial-tail", revision: 1, stability: "turn-context", changeTriggers: ["model-output"],
      text: tail ? `partial reply so far (tail): ${tail}` : null },
    { id: OUTPUT_LIMIT_CONTINUATION_MODULE_IDS[cut], revision: 1, stability: "turn-context",
      changeTriggers: ["model-output"], text: TEXT[cut] },
  ];
}

/** The host user turn appended after the partial assistant text. */
export function outputLimitContinuationTurn(cut: OutputLimitCut, partialTail?: string): string {
  return composeDeclaredPrompt(outputLimitContinuationParts(cut, partialTail));
}
