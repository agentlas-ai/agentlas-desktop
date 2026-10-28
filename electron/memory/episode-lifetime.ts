/*
 * Which recorded turn (memory episode) another conversation of the same project may recall.
 *
 * A project's timeline is shared on purpose: "Recent work (observations)" lets a new conversation know what the project
 * did lately (governed memory, 00768a306). A turn record carries two kinds of content, and only one of them is the
 * project's:
 *   - project lifetime: what was done, decided or produced (a report written, a figure checked);
 *   - conversation lifetime: what is still open in that one conversation — a card waiting for the owner's press, the
 *     card's handle, the run that presented it. Those are objects of the conversation (ui-instances are stored per
 *     chat); quoted in another conversation they point at nothing there, or at the wrong thing (Finance 2026-10-28:
 *     qwen3 cited another conversation's confirmation card id, and trials run in the same app were biased).
 *
 * The lifetime is read from host facts, never from the summary's wording: the record is the host's receipt of that turn's
 * end (memory_tickets.failure_code: turn-failed, turn-cancelled, curation-failed — "this turn ended without a final
 * response" read in another conversation describes the reader's turn, qwen3 2026-10-28), the turn presented a card that
 * waited for the owner (ui-instances revision state "awaiting-input" with that turn id), or the summary names a card
 * handle registered to its own conversation. Curated memory already carries a typed scope (session | project); this gives the timeline the
 * same split. When the card store cannot be read, another conversation's turn stays in its conversation (conservative).
 */
import { UI_INSTANCE_HANDLE_RE } from "../../shared/ui-instances";
import type { ConversationUiFacts } from "../harness/ui-instances";

export type EpisodeLifetime =
  | { lifetime: "project" }
  | { lifetime: "conversation"; reason: "turn-receipt" | "owner-wait-turn" | "conversation-handle" | "facts-unavailable" };

export interface LifetimeEpisode {
  ticketId: string;
  chatId: string | null;
  summary: string;
}

export interface EpisodeLifetimeFacts {
  /** ticket -> the run and turn it recorded, and its typed failure code when the host wrote the record as a turn receipt. */
  ticketTurns: Map<string, { runId: string | null; turnId: string | null; failureCode?: string | null }>;
  /** conversation -> its card facts; null when the card store could not be read. */
  ui: Map<string, ConversationUiFacts> | null;
}

export function episodeLifetime(episode: LifetimeEpisode, facts: EpisodeLifetimeFacts): EpisodeLifetime {
  if (!episode.chatId) return { lifetime: "project" };
  const ui = facts.ui?.get(episode.chatId);
  if (!facts.ui || !ui) return { lifetime: "conversation", reason: "facts-unavailable" };
  const turn = facts.ticketTurns.get(episode.ticketId);
  // A host receipt of one turn's end ("this turn ended without a final response") speaks about that conversation's turn.
  if (turn?.failureCode) return { lifetime: "conversation", reason: "turn-receipt" };
  if (turn && [turn.runId, turn.turnId].some((id) => id && ui.ownerWaitTurnIds.has(id))) return { lifetime: "conversation", reason: "owner-wait-turn" };
  for (const handle of episode.summary.match(UI_INSTANCE_HANDLE_RE) ?? []) {
    if (ui.instanceIds.has(handle)) return { lifetime: "conversation", reason: "conversation-handle" };
  }
  return { lifetime: "project" };
}

/** Episodes a conversation may recall: its own, and other conversations' project-lifetime ones. Order is kept. */
export function recallableEpisodes<E extends LifetimeEpisode>(episodes: readonly E[], currentChatId: string | null | undefined,
  load: (foreign: readonly E[]) => EpisodeLifetimeFacts): E[] {
  const foreign = episodes.filter((episode) => episode.chatId && episode.chatId !== currentChatId);
  if (!foreign.length) return [...episodes];
  let facts: EpisodeLifetimeFacts;
  try { facts = load(foreign); } catch { facts = { ticketTurns: new Map(), ui: null }; }
  return episodes.filter((episode) => !episode.chatId || episode.chatId === currentChatId
    || episodeLifetime(episode, facts).lifetime === "project");
}
