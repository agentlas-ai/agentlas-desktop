// LLM 출력에서 "사용자에게 질문" fence를 파싱하는 헬퍼.
//
// 프로토콜 (Claude의 AskUserQuestion과 같은 패턴):
//   <<agentlas-ask>>
//   {
//     "question": "어떤 방향으로 갈까요?",
//     "header": "Direction",        // 옵션. UI에 짧은 칩
//     "multiSelect": false,         // 옵션. 기본 false
//     "options": [
//       { "label": "A", "description": "설명" },
//       { "label": "B", "description": "설명" }
//     ]
//   }
//   <<\/agentlas-ask>>
//
// 본문에서 fence는 통째로 제거하고, 추출한 질문은 메시지 메타데이터로 옮긴다.
// 질문이 여러 개 필요하면 fence를 여러 개 연속으로 emit할 수 있다.
// 스트리밍 중 부분적으로 도착할 수 있어, 닫는 fence가 없으면 추출하지 않고 그대로 둔다.
import { extractAskFences } from "@shared/ask-fence-flatten";
import { isUnfilledQuestionTemplate } from "@shared/types";
import type { ChatQuestion } from "@/components/ChatStream";

/** 메시지 본문에서 모든 ask fence를 추출. closed인 fence만 가져가고, 본문에서는 제거. */
export function extractQuestions(
  text: string,
  messageId: string,
): { text: string; questions: ChatQuestion[] } {
  const extracted = extractAskFences(text);
  return {
    text: extracted.text,
    questions: extracted.questions.filter((question) => !isUnfilledQuestionTemplate(question)).map((question, index) => ({
      // IDs are always message-scoped. Model-authored JSON can never claim a
      // reserved product-consent identity; main-owned supplemental questions use
      // a separate typed event field instead of this parser.
      id: `${messageId}-q${index}`,
      ...question,
    })),
  };
}

/** system prompt에 자동 prefix될 사용법 안내. 짧고 명확하게 — 토큰 부담 최소. */
export const ASK_USER_SYSTEM_PROMPT = `## Asking the user a clarifying question

When you need the user to pick from explicit options to proceed, emit one or more fenced blocks in the same reply:

<<agentlas-ask>>
{
  "question": "Question to the user, ending with ?",
  "header": "Short label (under 12 chars)",
  "multiSelect": false,
  "options": [
    { "label": "Option A", "description": "What happens if chosen" },
    { "label": "Option B", "description": "What happens if chosen" }
  ]
}
<</agentlas-ask>>

Rules:
- Use only when their answer changes what you do next. Don't ask about defaults you can pick yourself.
- 2–4 options. The first option should be the recommended one when there is a clear default.
- If several independent choices are needed, ask them together as multiple blocks in one reply.
- After emitting the question block(s), STOP and wait — do not also try to answer.
- The user's selections arrive as their next message verbatim.
`;
