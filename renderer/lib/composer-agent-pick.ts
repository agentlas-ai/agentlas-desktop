/*
 * The ONE implementation of picking an agent from a composer's "@" (feature registry "composer-agent-pick"). Every composer that can pick
 * an agent - the One composer in Work/OneShell/Space/personal, the Work ChatInput, a group room's split pane - asks THIS file: what a half-typed `@name` is, what
 * picking does to the words, and what it does to the turn's agent list. A surface renders the list and calls these functions; it does not carry its own `@` regex.
 *
 * A group room reads WHO a sentence is for from two places that now agree (electron/one/room-lead-router.ts resolveOwnerTargets): the host-side pick (the turn's
 * agent list, `taskForceTargets`) first, the `@name` written in the words for lines that carry no pick (older rows, a phone message). The picker used to cut the
 * `@partial` out of the words and keep only the agent id, so the sent sentence read "예산 다시 봐줘" and the named member never knew the task was for it
 *. Picking keeps the full name in the words and adds the agent to the turn's list; picking an agent that is already in the list
 * takes it out again and cuts the half-typed `@partial`.
 */
export interface PickableAgent { id: string; name: string }

/** The pair every rendering of the picker carries, so a screen test can prove that only this implementation draws it. */
export const AGENT_PICK_FEATURE = "composer-agent-pick" as const;
export const AGENT_PICK_ATTRS = { "data-feature": AGENT_PICK_FEATURE, "data-impl": AGENT_PICK_FEATURE } as const;

/** A `@` the person is typing: where it starts (the `@`), where the typed part ends, and what was typed after it. */
export interface MentionToken { start: number; end: number; query: string }

const TRAILING_AT = /(^|\s)@[^\s]*$/u;

/** The `@partial` at the END of the text (the one being typed in a plain composer); null when the text does not end in one. */
export function trailingMention(text: string): MentionToken | null {
  const match = text.match(TRAILING_AT);
  if (!match || match.index === undefined) return null;
  const start = match.index + match[1]!.length;
  return { start, end: text.length, query: text.slice(start + 1) };
}

/** True while the person is typing a `@...` at the end of the words: the picker opens. The one rule behind every surface's "@ opens the list". */
export function isMentionOpen(text: string): boolean { return trailingMention(text) !== null; }

/** The `@partial` the caret is in (a word that starts with `@` and ends at the caret), for composers that edit in the middle of the text. */
export function mentionAtCaret(text: string, caret: number): MentionToken | null {
  const before = text.slice(0, Math.min(Math.max(caret, 0), text.length));
  const lastBreak = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\n"), before.lastIndexOf("\t"));
  const start = lastBreak + 1;
  if (before[start] !== "@") return null;
  return { start, end: before.length, query: before.slice(start + 1) };
}

export interface PickResult { text: string; picked: string[]; /** Where the caret goes: right after the inserted name and its space. */ caret: number }

/**
 * What picking `agent` does. `at` is the `@partial` being typed (default: the one at the end of the text). `mode: "toggle"` (default) takes an already picked agent
 * out again; `mode: "add"` only ever adds (a composer whose list shows every pick as its own chip with its own remove button).
 */
export function pickAgent(text: string, picked: readonly string[], agent: PickableAgent, options: { at?: MentionToken | null; mode?: "toggle" | "add" } = {}): PickResult {
  const at = options.at === undefined ? trailingMention(text) : options.at;
  const name = agent.name.replace(/\s+/g, " ").trim();
  if (picked.includes(agent.id) && options.mode !== "add") {
    const cut = at ? `${text.slice(0, at.start)}${text.slice(at.end)}` : text;
    return { text: cut, picked: picked.filter((id) => id !== agent.id), caret: at ? at.start : cut.length };
  }
  const next = picked.includes(agent.id) ? [...picked] : [...picked, agent.id];
  // Picked from the "+" list with no `@` being typed: the words are the person's own and stay as they are (the turn's list carries the choice).
  if (!at || !name) return { text, picked: next, caret: text.length };
  const insert = `@${name} `;
  return { text: `${text.slice(0, at.start)}${insert}${text.slice(at.end)}`, picked: next, caret: at.start + insert.length };
}

/** The original two-argument shape (the One composer's toggle): text and list only. */
export function pickAgentIntoComposer(text: string, picked: readonly string[], agent: PickableAgent): { text: string; picked: string[] } {
  const { text: next, picked: list } = pickAgent(text, picked, agent);
  return { text: next, picked: list };
}
