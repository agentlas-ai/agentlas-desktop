// Work tasks as Toolchain consumers.
//
// One's own conversations get the whole One Team surface (author, publish, run, delegate). A Work
// task gets only what lets it find and use a Toolchain that already passed its fresh-session test:
// search, run (callable contracts only — a Work task owns no graphs), and read the result of its own
// request. Nothing here authors, publishes or delegates. Measured 2026-10-04: before this, a Work
// task had no path to any Toolchain at all (One Team attached to One's own conversations only).

import { getChat } from "../store/chats";
import { currentCallableContracts } from "./interface";

/** The One Team tools a Work task is offered, and the only ones its capability may call. */
export const TOOLCHAIN_CONSUMER_TOOLS: readonly string[] = Object.freeze(["toolchain_search", "one_graph_run", "one_graph_result"]);

/** A user's Work task (not One's conversation, not archived) while at least one Toolchain is callable. */
export function toolchainConsumerAllowedFor(chatId: string | null | undefined): boolean {
  if (!chatId) return false;
  const chat = getChat(chatId);
  if (!chat || chat.kind !== "user" || chat.originSurface === "one" || chat.archivedAt) return false;
  // Offering three tools with nothing behind them only spends the model's context.
  return currentCallableContracts().length > 0;
}
