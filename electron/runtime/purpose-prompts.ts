import { composeDeclaredPrompt, type DeclaredPromptPart } from "./prompt-order";

/** A fixed semantic menu; only host release changes these lines. */
export function fixedPurposePrompt(id: string, lines: readonly string[]): string {
  return composeDeclaredPrompt([{ id, revision: 2, stability: "fixed-policy", changeTriggers: ["release"], text: lines.join("\n") }], "\n");
}

/** Host-authored fields only; preserves authority channel and conversation chronology. */
export function purposePrompt(parts: readonly DeclaredPromptPart[], separator = "\n"): string {
  return composeDeclaredPrompt(parts, separator);
}
