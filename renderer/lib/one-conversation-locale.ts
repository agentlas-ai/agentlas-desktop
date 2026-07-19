export type OneConversationLocale = "ko" | "en";

type ConversationLanguageMessage = {
  role: "user" | "assistant" | "system";
  text: string;
};

/**
 * One's conversational chrome follows the language the user is speaking in
 * this thread. Product navigation can still follow the app preference, but a
 * Korean request must not finish with English decisions, receipts, or buttons.
 */
export function detectOneTextLocale(text: string): OneConversationLocale | null {
  const hangulCount = text.match(/[\u3131-\u318e\uac00-\ud7a3]/gu)?.length ?? 0;
  if (hangulCount > 0) return "ko";

  // Avoid flipping an established Korean thread to English for replies such
  // as "ok", filenames, acronyms, or a bare product name.
  const latinCount = text.match(/[A-Za-z]/g)?.length ?? 0;
  const latinWords = text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)?.length ?? 0;
  return latinCount >= 4 && latinWords >= 1 ? "en" : null;
}

export function inferOneConversationLocale(
  messages: readonly ConversationLanguageMessage[],
  fallback: OneConversationLocale,
): OneConversationLocale {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const detected = detectOneTextLocale(message.text);
    if (detected) return detected;
  }
  return fallback;
}

type RecentLanguageContext = {
  text: string;
  updatedAt: string;
};

/**
 * The One home screen has no active thread to inspect. In that state, use the
 * newest user-authored-looking title from recent conversations or work before
 * falling back to the app language. This keeps system chrome in the language
 * the person is actually using without asking them to configure One first.
 */
export function inferOneRecentContextLocale(
  items: readonly RecentLanguageContext[],
  fallback: OneConversationLocale,
): OneConversationLocale {
  const newestFirst = [...items].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  for (const item of newestFirst) {
    const detected = detectOneTextLocale(item.text);
    if (detected) return detected;
  }
  return fallback;
}
