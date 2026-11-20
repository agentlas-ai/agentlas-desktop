/*
 * A question card the person closed with X on the PHONE. The closed state of a conversation's cards is the Mac's state in the database
 * (chat/closed-question-cards.ts); the phone only said "closed" to itself, so after the phone restarted the Mac listed the question again and
 * the sheet came back. This is the one place the phone's close becomes that state, and it stores nothing new: the same `qcard-closed:<chat>` row, the same
 * retention (14 days, 20 per conversation, 200 conversations), the same store signal that tells every window.
 *
 * The phone knows the question by its source message id (MobileBridgePendingConfirmationDto.decisionId / sourceMessageId); the desktop keys a card by
 * `decision:<message id>` (a One decision) or `fence:<question ids>` (a model's ask fence in a Work/personal/room conversation, ids `<message id>-q<n>`). The Mac derives
 * BOTH keys from the message itself, so a phone never has to know the desktop's key format.
 *
 * Pure of Electron and of the bridge: the stores are injected, the scope gate is the caller's `admit`.
 */
import { extractAskFences } from "../../shared/ask-fence-flatten";
import { isUnfilledQuestionTemplate } from "../../shared/types";
import { fenceCardKeyOfIds } from "../../shared/question-card-key";

export type PhoneQuestionCloseRefusal = "chat_unknown" | "chat_archived" | "message_not_in_chat" | "scope_refused" | "key_invalid";

export type PhoneQuestionCloseResult =
  | { closed: true; chatId: string; sourceMessageId: string; keys: string[] }
  | { closed: false; code: PhoneQuestionCloseRefusal };

/** The keys the desktop's cards for this message carry. Same rule as renderer/lib/ask-question.ts extractQuestions + decision/useQuestionCards.ts. */
export function questionCardKeysOfMessage(messageId: string, text: unknown): Array<{ key: string; count: number }> {
  const keys: Array<{ key: string; count: number }> = [{ key: `decision:${messageId}`, count: 1 }];
  const found = extractAskFences(text).questions
    .filter((question) => !isUnfilledQuestionTemplate(question))
    .map((question, index) => ({ id: `${messageId}-q${index}`, ...question }))
    .filter((question) => question.question.trim() && question.options.length > 0);
  if (found.length) keys.push({ key: fenceCardKeyOfIds(found.map((question) => question.id)), count: found.length });
  return keys;
}

export function closeQuestionFromPhone(input: { chatId: string; sourceMessageId: string }, deps: {
  chatArchived(chatId: string): boolean | null; // null = no such conversation
  messageOfChat(chatId: string, messageId: string): { role: string; text: string } | null;
  /** the phone's claim about the conversation is compared with the conversation's own stamp. */
  admit(chatId: string): boolean;
  close(input: { chatId: string; key: string; count: number }): void;
}): PhoneQuestionCloseResult {
  const { chatId, sourceMessageId } = input;
  if (!chatId || chatId.length > 256 || !sourceMessageId || sourceMessageId.length > 200) return { closed: false, code: "key_invalid" };
  const archived = deps.chatArchived(chatId);
  if (archived === null) return { closed: false, code: "chat_unknown" };
  if (archived) return { closed: false, code: "chat_archived" };
  if (!deps.admit(chatId)) return { closed: false, code: "scope_refused" };
  const message = deps.messageOfChat(chatId, sourceMessageId);
  if (!message) return { closed: false, code: "message_not_in_chat" };
  const keys = questionCardKeysOfMessage(sourceMessageId, message.text);
  for (const item of keys) deps.close({ chatId, key: item.key, count: item.count });
  return { closed: true, chatId, sourceMessageId, keys: keys.map((item) => item.key) };
}
