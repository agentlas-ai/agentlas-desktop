// Synchronous bridge between the resident judgment service and the synchronous automation
// tool-mode decision. The model's verdict — warmed on the async path that precedes an
// automation run — is the ONLY thing that decides; shared/automation-tool-policy no longer
// carries any wordlist to fall back to. A cache miss returns null and the caller stays on the
// neutral "auto" mode, so a store write never blocks on a model and an unjudged run is never
// forced onto the screen-driving path.

import {
  COMPUTER_USE_JUDGMENT_GUIDANCE,
  COMPUTER_USE_JUDGMENT_KIND,
  COMPUTER_USE_JUDGMENT_QUESTION,
} from "../../shared/automation-tool-policy";
import type { AutomationToolMode } from "../../shared/types";
import { peekJudgment, prejudge } from "./judgment";

interface AutomationToolModeText {
  toolMode?: AutomationToolMode | null;
  name?: string | null;
  promptTemplate?: string | null;
  targetLabel?: string | null;
}

/** The exact text resolveAutomationToolMode judges — keep this in sync so the warm and
 *  the synchronous peek share one cache key. */
export function automationToolModeText(input: AutomationToolModeText): string {
  return [input.name ?? "", input.promptTemplate ?? "", input.targetLabel ?? ""].join("\n");
}

/** Judged verdict for "does this automation really need a human-driven browser?" */
export function judgedComputerUse(text: string): boolean | null {
  const verdict = peekJudgment<"yes" | "no">(COMPUTER_USE_JUDGMENT_KIND, text);
  if (!verdict || verdict.source !== "llm") return null;
  return verdict.verdict === "yes";
}

/**
 * Warm the computer-use verdict BEFORE a synchronous automation store write resolves the
 * tool mode. The automation create/update path is async, so the connected model decides the
 * mode at creation time; the store's synchronous judgedComputerUse peek then reads it. An
 * explicit user mode or no reachable model leaves the neutral "auto" default untouched.
 */
export async function prejudgeAutomationComputerUse(
  input: AutomationToolModeText,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  if (input.toolMode === "browser" || input.toolMode === "computer-use") return;
  const text = automationToolModeText(input);
  if (!text.trim()) return;
  try {
    await prejudge<"yes" | "no">({
      kind: COMPUTER_USE_JUDGMENT_KIND,
      question: COMPUTER_USE_JUDGMENT_QUESTION,
      labels: ["yes", "no"] as const,
      input: text,
      guidance: COMPUTER_USE_JUDGMENT_GUIDANCE,
      // Conservative default "no": an unreachable model must not force the brittle
      // screen-driving path; the store then keeps the neutral "auto" mode.
      fallback: "no",
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    });
  } catch {
    // Best-effort warm; an unjudged automation stays on the neutral "auto" path.
  }
}
