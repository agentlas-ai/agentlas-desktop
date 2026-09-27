import { isSameChatPrompt, parseChatFileMessage } from "./chat-files";

/**
 * Which user bubble stands for the prompt a run is executing.
 *
 * The prompt sent to Main carries `<!-- agentlas-chat-files:v1:<group> -->` when the
 * person attached a file or folder; the bubble drawn at send time holds only their
 * words. Matching raw strings never found that bubble, so One appended a second one
 * (and a "live prompt" row) showing the raw marker (owner, "Youtube launch"
 * taskforce, 2026-09-27 13:03Z — one durable row, two bubbles on screen).
 */
export interface PromptBubbleMessage {
  role: string;
  text: string;
}

export function isPromptOnScreen(messages: readonly PromptBubbleMessage[], prompt: string): boolean {
  return messages.some((message) => message.role === "user" && isSameChatPrompt(message.text, prompt));
}

/** Words and attachment groups for a bubble drawn from a run prompt — never the marker. */
export function promptBubbleContent(prompt: string): { text: string; chatFileGroupIds?: string[] } {
  const parsed = parseChatFileMessage(prompt);
  return parsed.groupIds.length ? { text: parsed.visibleText, chatFileGroupIds: parsed.groupIds } : { text: parsed.visibleText };
}
