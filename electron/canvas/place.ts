/**
 * Where a card shows for the conversation that asked for it. Every Desktop transcript draws a card under the answer. A Science conversation
 * draws its own transcript (a separate product view that shows no Desktop card inline), so its cards sit in the results panel beside it
 * (renderer/app/(no-shell)/science/page.tsx). The pack is a stored fact of the chat (`surfacePack`), never read from words.
 * No electron import (the daemon loads the harness); a chat that cannot be read is an ordinary one.
 */
export type CardPlace = 'answer' | 'panel';

export async function cardPlace(chatId: string | undefined): Promise<CardPlace> {
  if (!chatId || chatId === 'ui') return 'answer';
  try {
    const { getChat } = await import('../store/chats');
    return getChat(chatId)?.surfacePack === 'science' ? 'panel' : 'answer';
  } catch { return 'answer'; }
}
