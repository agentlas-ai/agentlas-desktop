// Synchronous bridge between the resident judgment service and the synchronous automation
// tool-mode decision. The model's verdict — warmed on the async path that precedes an
// automation run — is the ONLY thing that decides; shared/automation-tool-policy no longer
// carries any wordlist to fall back to. A cache miss returns null and the caller stays on the
// neutral "auto" mode, so a store write never blocks on a model and an unjudged run is never
// forced onto the screen-driving path.

import { COMPUTER_USE_JUDGMENT_KIND } from "../../shared/automation-tool-policy";
import { peekJudgment } from "./judgment";

/** Judged verdict for "does this automation really need a human-driven browser?" */
export function judgedComputerUse(text: string): boolean | null {
  const verdict = peekJudgment<"yes" | "no">(COMPUTER_USE_JUDGMENT_KIND, text);
  if (!verdict || verdict.source !== "llm") return null;
  return verdict.verdict === "yes";
}
