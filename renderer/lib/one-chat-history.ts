import type { AgentlasIpc } from "./types";
import type { ChatMessagesCursor, ChatMessagesPage } from "@shared/types";

/** Use ipc()'s shared in-flight read policy for every observer of a room. */
export function readOneChatHistory(api: AgentlasIpc, chatId: string): ReturnType<AgentlasIpc["invoke"]["history"]> {
  return api.invoke.history(chatId);
}

export function readOneChatHistoryPage(
  api: AgentlasIpc,
  chatId: string,
  before?: ChatMessagesCursor,
  limit = 200,
): Promise<ChatMessagesPage> {
  return api.chats.messagesPage({ chatId, limit, ...(before ? { before } : {}) });
}

type HistoryMessage = { id: string; createdAt?: string | null };

const storeTextEncoder = new TextEncoder();

// SQLite BINARY compares UTF-8 bytes, not locale collation or numeric ID suffixes.
function compareStoreText(left: string, right: string): number {
  if (left === right) return 0;
  const a = storeTextEncoder.encode(left), b = storeTextEncoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

/** Older reads cannot overwrite a newer in-memory revision of the same row. */
export function mergeOneChatHistory<T extends HistoryMessage>(
  current: readonly T[], incoming: readonly T[], mode: "older" | "newest",
): T[] {
  if (mode === "newest" && incoming.length === 0) return [];
  const rows = new Map<string, T>();
  for (const row of mode === "older" ? [...incoming, ...current] : [...current, ...incoming]) rows.set(row.id, row);
  return [...rows.values()].sort((left, right) => compareStoreText(left.createdAt ?? "\uffff", right.createdAt ?? "\uffff")
    || compareStoreText(left.id, right.id));
}

/** The durable oldest row is the next keyset boundary; optimistic rows have no cursor. */
export function oneChatHistoryCursor(messages: readonly HistoryMessage[]): ChatMessagesCursor | null {
  const first = messages.find(message => typeof message.createdAt === "string" && message.createdAt.length > 0);
  return first?.createdAt ? { id: first.id, createdAt: first.createdAt } : null;
}
