import type { Chat } from "@shared/types";

/** A failed room lookup is not evidence that the room has no runtime pin. */
export async function readChatForRuntime(
  chats: { get(id: string): Promise<Chat | null> },
  chatId: string,
  isCurrent: () => boolean,
): Promise<Chat | null> {
  for (let attempt = 0; attempt < 2 && isCurrent(); attempt += 1) {
    try {
      const chat = await chats.get(chatId);
      if (!isCurrent()) return null;
      return chat?.id === chatId ? chat : null;
    } catch {
      if (attempt === 0 && isCurrent()) await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
  return null;
}
