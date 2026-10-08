import type { AgentlasIpc } from "./types";

/** Use ipc()'s shared in-flight read policy for every observer of a room. */
export function readOneChatHistory(api: AgentlasIpc, chatId: string): ReturnType<AgentlasIpc["invoke"]["history"]> {
  return api.invoke.history(chatId);
}
