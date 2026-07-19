import type { Chat } from "../../shared/types";
import { sanitizeOneTaskProjectionDisplayText } from "../../shared/one-task-projection";
import { appendChatMessage, createChat, getChat } from "../store/chats";
import { getCanonicalTask } from "../store/tasks";

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
  if (input.locale === "ko") {
    return [
      `${input.accepted ? "완료한" : "검토 중인"} 이전 일에서 이어갑니다 · ${input.title}`,
      input.summary,
      "새 요청은 별도의 일로 처리합니다. 이전 팀·권한·임시 첨부는 자동으로 이어받지 않았어요.",
    ].join("\n\n");
  }
  return [
    `Continuing from the ${input.accepted ? "completed" : "result-ready"} work · ${input.title}`,
    input.summary,
    "This request starts separate work. The previous team, permissions, and temporary attachments were not carried over automatically.",
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
    fallback: input.locale === "ko" ? "이전 일" : "Previous work",
  });
  const summary = sanitizeOneTaskProjectionDisplayText(input.summary.slice(0, 720), {
    maximum: 4_000,
    fallback: input.locale === "ko" ? "이전 결과의 핵심 맥락을 이어받았습니다." : "The key context from the previous result was carried forward.",
  });
  const nextTitle = sanitizeOneTaskProjectionDisplayText(followUpTitle(userPrompt), {
    maximum: 160,
    fallback: input.locale === "ko" ? "이어지는 일" : "Follow-up work",
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
  });
  appendChatMessage(next.id, "system", continuationMessage({
    locale: input.locale,
    accepted: task.status === "completed",
    title,
    summary,
  }));
  return getChat(next.id) as Chat;
}
