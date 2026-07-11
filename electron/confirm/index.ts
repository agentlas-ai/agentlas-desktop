// 확인 요청(Request confirm) — "에이전트가 사용자 결정을 기다리는 채팅" 목록.
//
// 별도 런루프/CLI 훅 없이 DB에서 도출한다:
//   확인 대기 = 채팅의 "마지막 메시지가 미답변 질문 fence를 가진 assistant 메시지"인 경우.
//   사용자가 챗에서 답하면 후속 user 메시지가 쌓여 마지막이 더 이상 assistant가 아니게 되므로 자동 해소된다.
// fence 포맷은 renderer/lib/ask-question.ts와 동일: <<agentlas-ask>>{json}<</agentlas-ask>>.
import type { PendingConfirmation } from "../../shared/types";
import { getLastChatMessage, listRecentChats } from "../store/chats";

const OPEN = "<<agentlas-ask>>";
const CLOSE = "<</agentlas-ask>>";

function firstQuestion(
  text: string,
): {
  question: string;
  header?: string;
  optionCount: number;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
} | null {
  const open = text.indexOf(OPEN);
  if (open < 0) return null;
  const after = text.slice(open + OPEN.length);
  const close = after.indexOf(CLOSE);
  if (close < 0) return null; // 닫는 fence 없음 = 스트리밍 중 미완성 → 대기 아님
  let body = after.slice(0, close).trim();
  body = body
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    const question = typeof parsed.question === "string" ? parsed.question.trim() : "";
    if (!question) return null;
    const optionsRaw = Array.isArray(parsed.options) ? parsed.options : [];
    const options = optionsRaw
      .flatMap((option) => {
        if (!option || typeof option !== "object") return [];
        const raw = option as Record<string, unknown>;
        const label = typeof raw.label === "string" ? raw.label.trim() : "";
        if (!label) return [];
        const description = typeof raw.description === "string" ? raw.description.trim() : "";
        return [{
          label: label.slice(0, 200),
          ...(description ? { description: description.slice(0, 1_000) } : {}),
        }];
      })
      .slice(0, 8);
    if (options.length < 2) return null;
    return {
      question: question.slice(0, 4_000),
      header: typeof parsed.header === "string" ? parsed.header.trim().slice(0, 200) || undefined : undefined,
      optionCount: options.length,
      options,
      multiSelect: parsed.multiSelect === true,
    };
  } catch {
    return null;
  }
}

/** 지금 사용자 확인을 기다리는 채팅들. 최신순. */
export function listPendingConfirmations(): PendingConfirmation[] {
  const out: PendingConfirmation[] = [];
  for (const c of listRecentChats(40)) {
    if (c.archivedAt) continue;
    const last = getLastChatMessage(c.id);
    if (!last || last.role !== "assistant") continue;
    if (!last.text.includes(OPEN)) continue;
    const q = firstQuestion(last.text);
    if (!q) continue;
    out.push({
      chatId: c.id,
      chatTitle: c.title,
      question: q.question,
      header: q.header,
      optionCount: q.optionCount,
      options: q.options,
      multiSelect: q.multiSelect,
      agentId: c.agentId,
      firmId: c.firmId,
      createdAt: last.createdAt,
    });
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}
