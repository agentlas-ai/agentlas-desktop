import type { AutomationToolMode } from "./types";

// The English+Korean wordlists that used to live here are GONE.
//
// They decided whether an automation was forced onto the slow screen-driving path, so the
// same job written in Arabic, Tagalog, or any other language simply fell through — and the
// broad words it did know ("web", "search", "account", "post") pushed unrelated jobs onto
// the brittle path. No hand-maintained list can enumerate every language, so no list decides
// here anymore: the resident judge rules by meaning, and an unjudged run keeps the neutral
// "auto" mode instead of guessing from words.
//
// What survives is FORMAT detection, not meaning: a literal product name, the CDP port, the
// remote-debugging flag. Those are identifiers — finite, language-independent, and correct
// to match exactly.
const EXACT_AGENTLAS_BROWSER_PATTERNS = [
  /\bAgentlas\s+Browser\b/i,
  /\b(?:CDP|remote[- ]debugging)\b/i,
  /(?:127\.0\.0\.1|localhost):9222/i,
  /로그인된\s*(?:에이전틀라스\s*)?브라우저/i,
];

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export const COMPUTER_USE_JUDGMENT_KIND = "automation-needs-human-web";

/**
 * Whether this automation should be forced onto the slow computer-use path.
 *
 * ONLY the resident judge decides. No verdict (no model reachable, or nothing warmed the
 * cache yet) means NO forcing: the run stays on the neutral "auto" path, where the browser
 * and Computer Use hosts are still reachable if the task or the user asks for them. Guessing
 * "yes" from words was what diverted file/API jobs into brittle screen driving, and guessing
 * from an English/Korean list silently skipped every other language.
 */
export function shouldPreferComputerUseForAutomation(
  text: string,
  judged?: (text: string) => boolean | null,
): boolean {
  if (!text.trim()) return false;
  return judged?.(text) === true;
}

export function resolveAutomationToolMode(input: {
  toolMode?: AutomationToolMode | null;
  name?: string | null;
  promptTemplate?: string | null;
  targetLabel?: string | null;
  /** Synchronous read of a judged verdict for this text (see peekJudgment). */
  judged?: (text: string) => boolean | null;
}): AutomationToolMode {
  if (input.toolMode === "browser" || input.toolMode === "computer-use") return input.toolMode;
  const text = [input.name ?? "", input.promptTemplate ?? "", input.targetLabel ?? ""].join("\n");
  // Exact real-login browser intent outranks the generic social-site heuristic.
  // Otherwise a Reddit job that explicitly says "Agentlas Browser / 9222" is silently
  // diverted into Computer Use and loses the authenticated CDP session.
  if (hasAny(text, EXACT_AGENTLAS_BROWSER_PATTERNS)) return "browser";
  return shouldPreferComputerUseForAutomation(text, input.judged) ? "computer-use" : "auto";
}

/** Question the resident judge answers for COMPUTER_USE_JUDGMENT_KIND. */
export const COMPUTER_USE_JUDGMENT_QUESTION =
  "Does completing this automation require driving a human-facing website in a real browser session (logging in, clicking, typing into a page), as opposed to work that can be done with files, APIs, or tools?";

export const COMPUTER_USE_JUDGMENT_GUIDANCE =
  "Answer yes only when the task genuinely has to operate a web UI as a signed-in human. Merely mentioning a " +
  "site, or using words like web/search/account/post/upload for something that is actually file, API, or " +
  "message work, is NOT a reason to drive a browser.";
