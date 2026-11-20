import { ipcErrorCode, ipcErrorMessage, ipcErrorReason } from "@shared/ipc-error-code";

/* One short line per refusal code of a message sent into a room; null for a code not known here (the caller keeps its generic "not sent"). A sentence Main already wrote for the owner is used as it is. */
export function sendRefusalLine(cause: unknown, locale: "ko" | "en"): string | null {
  const ko = locale === "ko";
  const code = ipcErrorCode(cause);
  const reason = ipcErrorReason(cause);
  if (code === "agent_chat_read_only") {
    if (reason === "no_members") return ko ? "구성원이 없어 안 보냄 · 새 대화를 시작하세요" : "No one left · not sent · start a new chat";
    if (reason === "room_dissolved") return ko ? "해산된 방 · 안 보냄 · 새 대화를 시작하세요" : "Room dissolved · not sent · start a new chat";
    if (reason === "agent_deleted") return ko ? "삭제된 에이전트 · 안 보냄 · 새 대화를 시작하세요" : "Agent deleted · not sent · start a new chat";
    return ko ? "읽기 전용 · 안 보냄" : "Read-only · not sent";
  }
  if (code === "one_group_member_unavailable") {
    const sentence = ipcErrorMessage(cause);
    return sentence ? `${sentence} ${ko ? "안 보냄 · 글은 입력창에 있어요" : "Not sent · your text is still in the box"}` : (ko ? "구성원을 부를 수 없어 안 보냄" : "Member unavailable · not sent");
  }
  if (code === "room_message_empty") return ko ? "보낼 글이 없어요" : "Nothing to send";
  return null;
}
