// Work tasks as Toolchain consumers.
//
// One's own conversations get the whole One Team surface (author, publish, run, delegate). A Work
// task gets only what lets it find and use an independent Toolchain version that passed real
// input/output validation: search, inspect, run, read its own result, and record a problem. Nothing
// here authors, publishes, repairs or delegates. Measured 2026-10-04: before this, a Work
// task had no path to any Toolchain at all (One Team attached to One's own conversations only).

import { getChat } from "../store/chats";
import { listToolchainAssets } from "./assets";

/** The One Team tools a Work task is offered, and the only ones its capability may call. */
export const TOOLCHAIN_CONSUMER_TOOLS: readonly string[] = Object.freeze(["toolchain_search", "toolchain_inspect", "toolchain_run", "toolchain_result", "toolchain_report"]);

/** A user's Work task (not One's conversation, not archived) while at least one Toolchain is callable. */
export function toolchainConsumerAllowedFor(chatId: string | null | undefined): boolean {
  if (!chatId) return false;
  const chat = getChat(chatId);
  if (!chat || chat.kind !== "user" || chat.originSurface === "one" || chat.archivedAt) return false;
  // Offering tools with nothing behind them only spends the model's context.
  return listToolchainAssets().some(asset => asset.status === "callable" && asset.stableVersion !== null);
}
