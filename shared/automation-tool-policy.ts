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

export function shouldPreferComputerUseForAutomation(text: string): boolean {
  const haystack = text.trim();
  if (!haystack) return false;
  if (hasAny(haystack, SOCIAL_SURFACE_PATTERNS)) return true;
  return hasAny(haystack, HUMAN_WEB_SURFACE_PATTERNS) && hasAny(haystack, HUMAN_WEB_ACTION_PATTERNS);
}

export function resolveAutomationToolMode(input: {
  toolMode?: AutomationToolMode | null;
  name?: string | null;
  promptTemplate?: string | null;
  targetLabel?: string | null;
}): AutomationToolMode {
  if (input.toolMode === "browser" || input.toolMode === "computer-use") return input.toolMode;
  const text = [input.name ?? "", input.promptTemplate ?? "", input.targetLabel ?? ""].join("\n");
  // Exact real-login browser intent outranks the generic social-site heuristic.
  // Otherwise a Reddit job that explicitly says "Agentlas Browser / 9222" is silently
  // diverted into Computer Use and loses the authenticated CDP session.
  if (hasAny(text, EXACT_AGENTLAS_BROWSER_PATTERNS)) return "browser";
  return shouldPreferComputerUseForAutomation(text) ? "computer-use" : "auto";
}
