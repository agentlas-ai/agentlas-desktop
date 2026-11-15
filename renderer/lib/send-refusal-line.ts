import { ipcErrorCode, ipcErrorMessage, ipcErrorReason } from "@shared/ipc-error-code";

/*
 * One line per refusal code for a message the owner sent into a room (F-D5b; codes: docs/Agentlas2.0/contracts/one-home-desktop.md 13.16).
 * Returns null for a code this file does not know - the caller keeps its generic "not sent" line. The words come from the code and its
 * reason only; a sentence Main already wrote for the owner (one_group_member_unavailable names the teammate) is used as it is.
 * The Korean and English lines are not drawn in any picture (listed as "words to confirm").
 */
export function sendRefusalLine(cause: unknown, locale: "ko" | "en"): string | null {
  const ko = locale === "ko";
  const code = ipcErrorCode(cause);
  const reason = ipcErrorReason(cause);
  if (code === "agent_chat_read_only") {
    if (reason === "no_members") return ko ? "이 그룹에는 남은 구성원이 없어서 보내지 못했어요. 새 대화를 시작해 주세요." : "No one is left in this group, so the message was not sent. Start a new chat.";
    if (reason === "room_dissolved") return ko ? "이 방은 해산돼서 보내지 못했어요. 새 대화를 시작해 주세요." : "This room was dissolved, so the message was not sent. Start a new chat.";
    if (reason === "agent_deleted") return ko ? "이 에이전트는 삭제돼서 보내지 못했어요. 다른 에이전트와 새 대화를 시작해 주세요." : "This agent was deleted, so the message was not sent. Start a new chat with another agent.";
    return ko ? "이 대화는 읽기 전용이라 보내지 못했어요." : "This conversation is read-only, so the message was not sent.";
  }
  if (code === "one_group_member_unavailable") {
    const sentence = ipcErrorMessage(cause);
    return sentence ? `${sentence} ${ko ? "보내지 않았어요. 글은 입력창에 그대로 있어요." : "Nothing was sent. Your text is still in the composer."}` : (ko ? "구성원 한 명을 방에 부를 수 없어 보내지 못했어요." : "A member cannot join this room, so the message was not sent.");
  }
  if (code === "room_message_empty") return ko ? "보낼 글이 비어 있어요." : "There is nothing to send yet.";
  return null;
}
