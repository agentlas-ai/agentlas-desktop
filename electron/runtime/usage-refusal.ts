/**
 * The provider's own words for a refusal of the whole request, read for the one question the host acts on: is an allowance spent (quota),
 * or is it a throttle that lifts by itself (rate_limit)? Used by every runner that only has the provider's text to go on: the ACP agents
 * (acp.ts) and the legacy cursor/grok/kimi hand drivers. Evidence is wording, so callers type the result `source: "heuristic"`.
 */

const NOT_ALLOWANCE_WORDS = "context|window|tokens?|images?|requests?|size|files?|messages?|prompt|rate";
/** Words that name an account's allowance in "your <word> limit". A limit of anything else (steps, turns, sessions, uploads, seats) is not one. */
const ALLOWANCE_WORDS = "weekly|daily|monthly|hourly|\\d+[- ]hours?|usage|plan|subscription|free|included|spending|session|credit";
/**
 * An allowance the provider says is used up, in its own refusal of the request: free usage, a usage, weekly, plan, hour or spending limit that was
 * reached, a used-up quota, credits or balance, premium requests used up. Each form names the account's allowance being spent. A limit that belongs to
 * the request or the machine (a context window, tokens, tool calls, memory, a size) or a disk or file quota is not one (ACP_NOT_ALLOWANCE).
 */
const ACP_USAGE_EXHAUSTED = new RegExp([
  "free[ _-]?usage[ _-]?(?:exhausted|used up|limit)",
  "used all the included free usage",
  "usage[ _-]?limits?[ _-]?(?:has been |have been |is )?(?:reached|exceeded|hit)",
  "usage[ _-]exhausted",
  `(?:reached|exceeded|hit)\\s+(?:your\\s+|the\\s+)?(?:(?!${NOT_ALLOWANCE_WORDS})[a-z'-]+\\s+){0,3}usage\\s+limits?`,
  `(?:(?:${ALLOWANCE_WORDS})\\s+){1,3}limits?\\s+(?:has been |have been |is |was )?(?:reached|exceeded|hit)`,
  `(?:reached|exceeded|hit)\\s+(?:your\\s+|the\\s+|its\\s+)?(?:(?:${ALLOWANCE_WORDS})\\s+){1,3}limits?\\b(?!\\s+(?:of|for|on)\\s+\\d)`,
  "(?:hit|reached|exceeded)\\s+your\\s+limits?\\b(?!\\s+(?:of|for|on)\\s+\\d)",
  "(?:hit|reached|exceeded)\\s+your\\s+free\\s+requests?\\s+limits?\\b",
  "usage\\s+limits?\\s+for\\s+the\\s+(?:month|week|day|period)\\s+(?:has been |have been |is )?(?:reached|exceeded|hit)",
  "(?:usage|spending|billing|credit)\\s+(?:hard\\s+)?cap\\s+(?:has been |is )?(?:reached|exceeded|hit)",
  "billing[ _]hard[ _]limit[ _]reached",
  "(?<!disk |file |inode |storage )quota[ _]?(?:has been |is )?(?:exceeded|exhausted|reached|depleted)",
  "(?:exceeded|exhausted|out of)[\\s_]+(?:(?:your|the)[\\s_]+)?(?:(?:current|monthly|weekly|daily|free|api)[\\s_]+)?(?<!disk )quota",
  "no quota (?:left|remaining|available)",
  "(?:credits?|balance)\\s+(?:exceeded|exhausted|depleted|used up)",
  "insufficient[ _-]?(?:quota|credits?|balance)",
  "balance (?:is )?insufficient",
  "out of (?:remaining )?credits?\\b(?![\\s-]*card)",
  "no (?:remaining )?credits? (?:left|remaining|available)",
  "credit balance (?:is )?too low",
  "used all (?:of )?(?:your |its |the )?(?:available |included )?(?:copilot )?(?:premium )?(?:credits|usage|requests)",
  "(?:exceeded|reached|hit)\\s+your\\s+premium\\s+requests?\\b",
  "premium\\s+requests?\\s+(?:limit|allowance)\\s+(?:has been |is )?(?:reached|exceeded|hit)",
  "exhausted your capacity",
  "free tier (?:is )?(?:exhausted|used up)",
  "payment required",
].join("|"), "i");
/** What a refusal is about when it speaks of a limit that belongs to the request or the machine, not to the account. */
const ACP_NOT_ALLOWANCE = new RegExp([
  "context[ _-]?window", "context length", "per[ _-]?request", "images? per", "\\b\\d+\\s+(?:images?|files?)\\b",
  "\\b(?:tokens?|context|tools?|memory|cpu|disk|output|input|steps?|turns?|uploads?|attachments?|characters?|lines?|pages?|projects?|workspaces?|seats?|connections?|calls?|subagents?|concurrent|parallel)\\s+(?:\\w+\\s+)?(?:usage\\s+)?limits?\\b",
].join("|"), "i");
/** A quota worded per minute, second or hour is a throttle that lifts by itself, not a spent allowance (also inside CamelCase or snake_case ids). */
const ACP_PER_WINDOW = /per[ _-]?(?:minute|second|hour)/i;
/**
 * A throttle that lifts by itself: HTTP 429 named as a status or code (not any number 429, so "code at line 429" or "position 429" never match), too
 * many requests, a rate limit.
 */
const ACP_THROTTLED = new RegExp([
  "(?:status|http|error[ _]code|\\bcode)(?:[ _/-]?(?:status|code|error|\\d(?:\\.\\d)?))*[\"' :=]*(?<![\\d.])429(?![\\d.])",
  "(?:failed with|returned|responded with|error:?)\\s*429(?![\\d.])",
  "(?<![\\d.])429(?![\\d.])\\s+too many requests",
  "too many requests",
  "\\brate[ _-]?limit",
].join("|"), "i");
/** The failure kind the host acts on for a provider's refusal of the whole request, read from its wording; null when it names no limit. */
export function acpUsageRefusalKind(text: string): "quota" | "rate_limit" | null {
  if (ACP_USAGE_EXHAUSTED.test(text)) {
    if (ACP_NOT_ALLOWANCE.test(text)) return null;
    return ACP_PER_WINDOW.test(text) ? "rate_limit" : "quota";
  }
  return ACP_THROTTLED.test(text) ? "rate_limit" : null;
}
