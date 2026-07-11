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
import type { ChatQuestion } from "@/components/ChatStream";

const OPEN_FENCE = "<<agentlas-ask>>";
const CLOSE_FENCE = "<</agentlas-ask>>";

/** 메시지 본문에서 모든 ask fence를 추출. closed인 fence만 가져가고, 본문에서는 제거. */
export function extractQuestions(
  text: string,
  messageId: string,
): { text: string; questions: ChatQuestion[] } {
  if (!text.includes(OPEN_FENCE)) return { text, questions: [] };
  const out: ChatQuestion[] = [];
  let remaining = text;
  let buf = "";
  let idx = 0;
  while (true) {
    const open = remaining.indexOf(OPEN_FENCE);
    if (open < 0) {
      buf += remaining;
      break;
    }
    // open 앞까지는 본문에 그대로
    buf += remaining.slice(0, open);
    const afterOpen = remaining.slice(open + OPEN_FENCE.length);
    const close = afterOpen.indexOf(CLOSE_FENCE);
    if (close < 0) {
      // 닫는 fence가 아직 안 옴 — 스트리밍 중일 수 있음. 그대로 두고 끝.
      buf += remaining.slice(open);
      break;
    }
    const body = afterOpen.slice(0, close).trim();
    const parsed = tryParse(body, `${messageId}-q${idx++}`);
    if (parsed) out.push(parsed);
    // parsed에 실패해도 본문에서는 제거 — LLM이 malformed JSON 보낼 때 raw fence를 사용자가 보지 않게.
    remaining = afterOpen.slice(close + CLOSE_FENCE.length);
  }
  return { text: buf, questions: out };
}

function tryParse(body: string, id: string): ChatQuestion | null {
  // body가 json fence(```json ... ```)로 감싸진 경우도 허용
  const stripped = body
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  let obj: unknown;
  try {
    obj = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const question = typeof o.question === "string" ? o.question : null;
  if (!question) return null;
  const optionsRaw = Array.isArray(o.options) ? o.options : [];
  const options: ChatQuestion["options"] = [];
  for (const opt of optionsRaw) {
    if (!opt || typeof opt !== "object") continue;
    const ob = opt as Record<string, unknown>;
    const label = typeof ob.label === "string" ? ob.label : null;
    if (!label) continue;
    const description = typeof ob.description === "string" ? ob.description : undefined;
    options.push({ label, description });
  }
  if (options.length < 2) return null;
  return {
    // IDs are always message-scoped. Model-authored JSON can never claim a
    // reserved product-consent identity; main-owned supplemental questions use
    // a separate typed event field instead of this parser.
    id,
    question,
    header: typeof o.header === "string" ? o.header : undefined,
    multiSelect: o.multiSelect === true,
    options,
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
