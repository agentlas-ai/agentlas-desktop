// Synchronous bridge between the resident judgment service and the synchronous automation
// tool-mode decision. The keyword lists in shared/automation-tool-policy are deliberately
// broad, so they only produce a CANDIDATE; the model's verdict — warmed on the async path
// that precedes an automation run — is what actually decides. A cache miss returns null and
// the caller keeps the keyword answer, so a store write never blocks on a model and never
// changes behaviour based on cache timing.

import { COMPUTER_USE_JUDGMENT_KIND } from "../../shared/automation-tool-policy";
import { peekJudgment } from "./judgment";

/** Judged verdict for "does this automation really need a human-driven browser?" */
export function judgedComputerUse(text: string): boolean | null {
  const verdict = peekJudgment<"yes" | "no">(COMPUTER_USE_JUDGMENT_KIND, text);
  if (!verdict || verdict.source !== "llm") return null;
  return verdict.verdict === "yes";
}
