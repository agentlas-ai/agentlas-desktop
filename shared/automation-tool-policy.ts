import type { AutomationToolMode } from "./types";

const HUMAN_WEB_SURFACE_PATTERNS = [
  /\breddit\b/i,
  /\binstagram\b/i,
  /\bthreads\b/i,
  /\bx\.com\b/i,
  /\btwitter\b/i,
  /\blinkedin\b/i,
  /\bfacebook\b/i,
  /\btiktok\b/i,
  /\byoutube\b/i,
  /\bgmail\b/i,
  /\bchrome\b/i,
  /\bbrowser\b/i,
  /\bwebsite?\b/i,
  /\bweb\s*(page|site|app)?\b/i,
  /레딧|인스타|스레드|트위터|링크드인|페이스북|틱톡|유튜브|지메일|크롬|브라우저|웹|사이트/i,
];

const HUMAN_WEB_ACTION_PATTERNS = [
  /\blog\s*in\b/i,
  /\bsign\s*in\b/i,
  /\bpost\b/i,
  /\bcomment\b/i,
  /\breply\b/i,
  /\bupload\b/i,
  /\bclick\b/i,
  /\btype\b/i,
  /\bsubmit\b/i,
  /\bform\b/i,
  /\bsearch\b/i,
  /\bscroll\b/i,
  /\bcheckout\b/i,
  /\baccount\b/i,
  /\bcaptcha\b/i,
  /\bblocked?\b/i,
  /\bnetwork[- ]security\b/i,
  /로그인|게시|댓글|답글|업로드|클릭|입력|제출|폼|검색|스크롤|결제|계정|캡차|차단|보안/i,
];

const SOCIAL_SURFACE_PATTERNS = [
  /\breddit\b/i,
  /\binstagram\b/i,
  /\bthreads\b/i,
  /\bx\.com\b/i,
  /\btwitter\b/i,
  /\blinkedin\b/i,
  /\bfacebook\b/i,
  /\btiktok\b/i,
  /레딧|인스타|스레드|트위터|링크드인|페이스북|틱톡/i,
];

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

/** Keyword evidence that this automation *might* need a human-driven browser. */
export function computerUseKeywordCandidate(text: string): boolean {
  const haystack = text.trim();
  if (!haystack) return false;
  if (hasAny(haystack, SOCIAL_SURFACE_PATTERNS)) return true;
  return hasAny(haystack, HUMAN_WEB_SURFACE_PATTERNS) && hasAny(haystack, HUMAN_WEB_ACTION_PATTERNS);
}

/**
 * Whether this automation should be forced onto the slow computer-use path.
 *
 * The word lists above are broad on purpose (`web`, `search`, `account`, `post`), so an
 * automation that merely MENTIONS YouTube while posting a summary to a file was pushed onto
 * the brittle screen-driving path. The keywords are now only a candidate signal: when the
 * resident judge has already ruled on this text (warmed from the async path that precedes
 * every automation run), its verdict decides. A judgment miss keeps the keyword answer, so
 * this stays synchronous and never regresses when no model is reachable.
 */
export function shouldPreferComputerUseForAutomation(
  text: string,
  judged?: (text: string) => boolean | null,
): boolean {
  const candidate = computerUseKeywordCandidate(text);
  if (!candidate) return false;
  const verdict = judged?.(text);
  return verdict === null || verdict === undefined ? candidate : verdict;
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
