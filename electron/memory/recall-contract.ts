// The desktop's side of the recall contract that is not the ranking formula (Agentlas 2.0 K4b). PURE: no store, no Electron, no model.
//
// The formula itself is the desktop's own (local-embedding.ts rankHybridLocal) and the engine copied it (ruleset recall.fusion). What the engine's contract adds around it, and the desktop now reads from the same
// ruleset file (electron/memory/curator-ruleset.json = the engine's system-agents/curator-ruleset.json, 1.16.0):
//   - the query a long prompt becomes: its first and its last userTextHeadChars / userTextTailChars characters (the question of a long paste is usually at its end), then the previous turn's summary (K3'-2b);
//   - the tier of a line for ties (recall.tiers): user, run_verified, unverified, inferred, none;
//   - the closed words of "could not read" (the engine hook's `memory=unavailable|partial; reason=...` line).
// Every number below has its basis beside it: a value that no measurement backs says so.
import { loadCuratorRuleset } from "./curator-rules";

interface RecallQueryRule { userTextMaxChars?: number; userTextHeadChars?: number; userTextTailChars?: number; previousSummaryMaxChars?: number }

// Ruleset 1.14.0 recall.query. Basis: engine audit measured a 6,057-character prompt whose question was at the end: not found with the head alone, found with head + tail (evidence/ev1-engine/query_ht.py).
// A question in the MIDDLE 1,000..2,000 characters of a prompt over 2,000 is still not found (the same audit); there is no measurement of how often that happens. Reached: only a user text over 2,000 characters; a shorter one is untouched.
const DEFAULT_QUERY: Required<Omit<RecallQueryRule, "previousSummaryMaxChars">> = { userTextMaxChars: 2000, userTextHeadChars: 1000, userTextTailChars: 1000 };

function queryRule(): Required<Omit<RecallQueryRule, "previousSummaryMaxChars">> {
  try {
    const raw = (loadCuratorRuleset().ruleset as { recall?: { query?: RecallQueryRule } }).recall?.query;
    const pick = (value: unknown, fallback: number): number => typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
    return { userTextMaxChars: pick(raw?.userTextMaxChars, DEFAULT_QUERY.userTextMaxChars), userTextHeadChars: pick(raw?.userTextHeadChars, DEFAULT_QUERY.userTextHeadChars), userTextTailChars: pick(raw?.userTextTailChars, DEFAULT_QUERY.userTextTailChars) };
  } catch { return DEFAULT_QUERY; }
}

/**
 * The previous-summary cap of the loaded ruleset (recall.query.previousSummaryMaxChars), or null when the copy does not carry one (an older copy: the summary is then left out, never given a cap of this file's own).
 * Basis there: measured on the engine's 79-pair set, 24 short follow-ups: R@8 0.083 with the user text alone, 0.958 with the summary after it; the cap 360 itself is a decided value.
 */
function previousSummaryCap(): number | null {
  try {
    const value = (loadCuratorRuleset().ruleset as { recall?: { query?: RecallQueryRule } }).recall?.query?.previousSummaryMaxChars;
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
  } catch { return null; }
}

/**
 * The text the recall ranks against for one turn (ruleset recall.query, order userText, previousSummary): the user text trimmed; when longer than userTextMaxChars (in characters, not UTF-16 units), its first head and its
 * last tail characters joined by one newline. A shorter text is returned trimmed and otherwise untouched, byte for byte. Empty in, empty out (the caller then takes the no-query path it always had) - whatever the summary.
 * `previousSummary` (K3'-2b): the summary of the last finished turn of this conversation (tickets.ts previousTurnSummary), cut to the ruleset's previousSummaryMaxChars characters and put after the user text on its own
 * line; a short follow-up ("do that again") has no word of its own and this is what it is about. The engine's third part, the project name, is NOT added: the engine's own measurement shows no gain (MRR@30 0.938 -> 0.904)
 * and the desktop reads project lines by the project's id, not by its name.
 */
export function recallQueryOf(userText: string | null | undefined, previousSummary?: string | null): string {
  const text = String(userText ?? "").trim();
  if (!text) return "";
  const rule = queryRule();
  // The cheap test first: a text of at most `max` UTF-16 units has at most `max` characters, so most prompts never spread into an array.
  let user = text;
  if (text.length > rule.userTextMaxChars) {
    const chars = [...text];
    if (chars.length > rule.userTextMaxChars) user = `${chars.slice(0, rule.userTextHeadChars).join("")}\n${chars.slice(chars.length - rule.userTextTailChars).join("")}`;
  }
  const cap = previousSummary ? previousSummaryCap() : null;
  const summary = cap ? [...String(previousSummary).trim()].slice(0, cap).join("") : "";
  return summary ? `${user}\n${summary}` : user;
}

/** The tie tier of a line (ruleset recall.tiers; checked in this order, the first that holds): user 0, run_verified 1, inferred 3, unverified 2, none 4. A word this rule does not know is `none`. */
export function recallTierOf(originClass: string | null | undefined, certainty: string | null | undefined): number {
  if (originClass === "user" || certainty === "self_reported") return 0;
  if (certainty === "run_verified") return 1;
  if (originClass === "inferred") return 3;
  if (certainty === "unverified" || originClass === "observed" || originClass === "result") return 2;
  return 4;
}

/** The closed words of a read that could not be complete (the engine hook's line, same words). `not_here`: the turn reads no memory at all (a read boundary, a front turn). */
export type RecallReadReason = "store_busy" | "store_unreadable" | "not_here";

/** SQLite's own result codes (better-sqlite3 sets `error.code`): a busy or locked store is `store_busy`, any other failure `store_unreadable`. The error's prose is never read. */
export function recallReasonOfError(error: unknown): Exclude<RecallReadReason, "not_here"> {
  const code = typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : "";
  return code === "SQLITE_BUSY" || code.startsWith("SQLITE_BUSY_") || code === "SQLITE_LOCKED" || code.startsWith("SQLITE_LOCKED_") ? "store_busy" : "store_unreadable";
}

/**
 * The one line the model reads when a recall could not read everything (the engine hook's words: nothing is said when the read was complete). `missing` says what the model should not take for absent: `recent` (the default, the
 * engine's own words for a partial read: the previous turn's summary or the recent work) or `lines` (K3'-2b: a store of this agent or project could not be opened, so some of its lines may be missing - same state and reason words).
 */
export function recallStatusLine(state: "unavailable" | "partial", reason: RecallReadReason, missing: "recent" | "lines" = "recent"): string {
  const base = `memory=${state}; reason=${reason}`;
  if (state === "unavailable") return reason === "not_here" ? `${base}; this conversation reads no memory` : `${base}; do not conclude that nothing is remembered`;
  return missing === "lines" ? `${base}; some lines of this agent or project may be missing` : `${base}; the previous turn's summary or the recent work may be missing`;
}
