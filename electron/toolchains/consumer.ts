







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
