import type { Chat } from "../../shared/types";
import { sanitizeOneTaskProjectionDisplayText } from "../../shared/one-task-projection";
import { appendChatMessage, createChat, getChat } from "../store/chats";
import { getCanonicalTask } from "../store/tasks";
import { oneText } from "./one-copy";

export interface ContinueOneFromTaskResultInput {
  taskId: string;
  expectedVersion: number;
  userPrompt: string;
  summary: string;
  locale: "ko" | "en";
}

function boundedPrompt(value: string): string {
  const prompt = value.trim();
  if (!prompt || prompt.length > 4_000) {
    throw new TypeError("A follow-up request must contain between 1 and 4,000 characters");
  }
  return prompt;
}

function followUpTitle(userPrompt: string): string {
  const firstSentence = userPrompt
    .split(/[.!?。！？\r\n]/)[0]
    .trim()
    .replace(/^(?:그럼|그러면|그렇다면|then)\s+/i, "")
    .slice(0, 48);
  return firstSentence || userPrompt.slice(0, 48);
}

function continuationMessage(input: {
  locale: "ko" | "en";
  accepted: boolean;
  title: string;
  summary: string;
}): string {
  return [
    oneText(input.locale, input.accepted ? "one.cont.headerAccepted" : "one.cont.headerPending", { title: input.title }),
    input.summary,
    oneText(input.locale, "one.cont.newRequestNote"),
  ].join("\n\n");
}

/**
 * Start a bounded follow-up conversation from a result-ready or completed Task.
 * The new chat inherits only the Main-owned working folder and a safe summary.
 * Team members, hired agents, permissions, temporary attachments, and raw
 * transcript history deliberately stay behind.
 */
export function continueOneFromTaskResult(input: ContinueOneFromTaskResultInput): Chat {
  const userPrompt = boundedPrompt(input.userPrompt);
  const task = getCanonicalTask(input.taskId);
  if (!task || !task.originChatId) throw new Error("The source Task is unavailable");
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion !== task.version) {
    throw new Error("Task changed before the follow-up started; review the current Task state");
  }
  if (task.status !== "partial" && task.status !== "completed") {
    throw new Error("A follow-up can start only from a result-ready or completed Task");
  }
  const source = getChat(task.originChatId);
  if (!source) throw new Error("The source conversation is unavailable");

  const title = sanitizeOneTaskProjectionDisplayText(task.title, {
    maximum: 160,
    fallback: oneText(input.locale, "one.cont.fallbackPrevWork"),
  });
  const summary = sanitizeOneTaskProjectionDisplayText(input.summary.slice(0, 720), {
    maximum: 4_000,
    fallback: oneText(input.locale, "one.cont.fallbackSummary"),
  });
  const nextTitle = sanitizeOneTaskProjectionDisplayText(followUpTitle(userPrompt), {
    maximum: 160,
    fallback: oneText(input.locale, "one.cont.fallbackFollowup"),
  });
  const next = createChat({
    agentId: source.agentId,
    firmId: source.firmId,
    agentGroupId: source.agentGroupId,
    projectId: source.projectId,
    title: nextTitle,
    continueFromChatId: source.id,
    kind: "user",
    taskMode: "conversation",
    // 이어지는 대화는 원 대화의 표면을 그대로 상속한다 — One에서 이어가면
    // 계속 One 홈에만, Work에서 이어가면 계속 Work에만 보인다.
    originSurface: source.originSurface === "one" ? "one" : "work",
  });
  appendChatMessage(next.id, "system", continuationMessage({
    locale: input.locale,
    accepted: task.status === "completed",
    title,
    summary,
  }));
  return getChat(next.id) as Chat;
}
