/**
 * Which earlier conversation a Taskforce planner or synthesizer may see.
 *
 * The owner's newest message is the task. Earlier turns are background. In
 * production (room "Yotube", 2026-10-11) the owner posted a long new channel
 * brief two and a half hours after a recovery exchange (the assistant asked for
 * permission, the owner answered "허용하고 복구", the host posted canned
 * "could not start" lines). The planner replayed that exchange as history, read
 * "approved recovery" as the pending work and briefed the first teammate to
 * "continue the approved recovery" instead of doing the brief.
 *
 * Rules (structure only, no wording heuristics beyond the ask fence):
 *  1. Host operational evidence never reaches the planner.
 *  2. The current request is never also replayed as history (rows echoing it are removed).
 *  3. An assistant ask (`<<agentlas-ask>>` fence) is only live while the current request is the
 *     reply to it (the request equals one of its option labels). Any ask followed by another owner
 *     message was answered or superseded: its whole assistant run is removed.
 *  4. The owner's reply to a settled ask, and the assistant run that acknowledged it, are removed
 *     with it: that thread is closed.
 */
import type { ChatHistoryEntry } from "../../shared/types";

const ASK_RE = /<<agentlas-ask>>([\s\S]*?)<<\/agentlas-ask>>/g;
const OPERATIONAL_EVIDENCE_RE = /^Private operational evidence\./;

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function askOptionLabels(text: string): string[] {
  const labels: string[] = [];
  for (const match of text.matchAll(ASK_RE)) {
    try {
      const parsed = JSON.parse(match[1]) as { options?: Array<{ label?: unknown } | string> };
      for (const option of parsed.options ?? []) {
        const label = typeof option === "string" ? option : typeof option?.label === "string" ? option.label : "";
        if (label.trim()) labels.push(normalize(label));
      }
    } catch { /* A malformed ask fence still counts as an ask; it just has no recognizable answers. */ }
  }
  return labels;
}

function hasAsk(entry: ChatHistoryEntry): boolean {
  return entry.role === "assistant" && /<<agentlas-ask>>/.test(entry.text);
}

type Turn = { owner: ChatHistoryEntry[]; responses: ChatHistoryEntry[] };

/** Owner messages followed by the non-owner entries that answered them. */
function toTurns(history: ChatHistoryEntry[]): Turn[] {
  const turns: Turn[] = [];
  for (const entry of history) {
    if (entry.role === "user") {
      const last = turns[turns.length - 1];
      if (last && last.responses.length === 0) last.owner.push(entry);
      else turns.push({ owner: [entry], responses: [] });
    } else {
      if (turns.length === 0) turns.push({ owner: [], responses: [] });
      turns[turns.length - 1].responses.push(entry);
    }
  }
  return turns;
}

export function selectTaskForceConversationContext(
  history: ChatHistoryEntry[],
  currentPrompt: string,
): ChatHistoryEntry[] {
  const current = normalize(currentPrompt);
  // Rule 1 and 2.
  let entries = history.filter((entry) => !(entry.role === "system" && OPERATIONAL_EVIDENCE_RE.test(entry.text.trim())));
  if (current) entries = entries.filter((entry) => !(entry.role === "user" && normalize(entry.text) === current));

  const turns = toTurns(entries);
  const keep = turns.map(() => ({ owner: true, responses: true }));
  for (let i = 0; i < turns.length; i += 1) {
    const asks = turns[i].responses.filter(hasAsk);
    if (asks.length === 0) continue;
    const isLast = i === turns.length - 1;
    const labels = asks.flatMap((entry) => askOptionLabels(entry.text));
    // Rule 3: still live only when nothing but the current request follows and it answers the ask.
    if (isLast && current && labels.includes(current)) continue;
    keep[i].responses = false;
    // Rule 4: the owner's answer to this ask and the acknowledgement that followed.
    const next = turns[i + 1];
    if (next && next.owner.length > 0 && next.owner.every((entry) => labels.includes(normalize(entry.text)))) {
      keep[i + 1] = { owner: false, responses: false };
    }
  }
  const out: ChatHistoryEntry[] = [];
  turns.forEach((turn, index) => {
    if (keep[index].owner) out.push(...turn.owner);
    if (keep[index].responses) out.push(...turn.responses);
  });
  return out;
}
