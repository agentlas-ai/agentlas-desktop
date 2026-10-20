







import { getChat } from "../store/chats";
import { listToolchainAssets } from "./assets";

/** The One Team tools a Work task is offered, and the only ones its capability may call. */
export const TOOLCHAIN_CONSUMER_TOOLS: readonly string[] = Object.freeze(["toolchain_search", "toolchain_inspect", "toolchain_run", "toolchain_result", "toolchain_report"]);

/**
 * A user's Work task, or a teammate's session or own conversation (not One's own conversation, not archived), while at least
 * one Toolchain is callable. Teammates are where the hand work happens, so they are where a Toolchain is used.
 */
export function toolchainConsumerAllowedFor(chatId: string | null | undefined): boolean {
  if (!chatId) return false;
  const chat = getChat(chatId);
  if (!chat || chat.archivedAt) return false;
  const workTask = chat.kind === "user" && chat.originSurface !== "one";
  if (!workTask && !(require("../one/team-dispatch") as typeof import("../one/team-dispatch")).isOneTeammateChat(chatId)) return false;
  // Offering tools with nothing behind them only spends the model's context.
  return listToolchainAssets().some(asset => asset.status === "callable" && asset.stableVersion !== null);
}
