// <<agentlas-ask>> 펜스의 **평문 렌더러** — 창 없는 표면(텔레그램·모바일 브리지)용.
//
// ★왜 있나 (InteractiveChannel 규칙, UNIVERSAL-RUNTIME-FEATURES-PLAN §2.3):
// 질문 펜스는 와이어 포맷이고 데스크탑 바텀시트는 렌더러 하나일 뿐이다. 시트를 못
// 그리는 표면은 질문을 **지우는 게 아니라 평문으로 렌더**해야 한다 — 지우면 사용자는
// 질문받은 사실조차 모른 채 대화가 멎는다(모바일에서 실제로 그랬다: sanitize 가
// stripAgentControlBlocks 로 펜스를 통째 제거했고, 텔레그램만 자기 평문화기를 갖고
// 있었다). 표면마다 손으로 다시 짜면 한 표면씩 빠진다 — 그래서 한 벌이 소유한다.
import { AGENT_ASK_OPEN, AGENT_ASK_CLOSE } from "./agent-control-blocks";

/** 펜스 본문(JSON)을 사람이 읽을 질문+선택지 텍스트로 바꾼다. 파싱 실패 시 null. */
export function flattenAskFenceBody(body: string, replyLocale: "ko" | "en"): string | null {
  const stripped = body.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  let obj: unknown;
  try {
    obj = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.question !== "string") return null;
  const lines: string[] = [o.question.trim()];
  const optionsRaw = Array.isArray(o.options) ? o.options : [];
  let n = 0;
  for (const opt of optionsRaw) {
    if (!opt || typeof opt !== "object") continue;
    const ob = opt as Record<string, unknown>;
    if (typeof ob.label !== "string") continue;
    const desc =
      typeof ob.description === "string" && ob.description.trim() ? ` — ${ob.description.trim()}` : "";
    lines.push(`${n + 1}. ${ob.label.trim()}${desc}`);
    n++;
  }
  if (n > 0) {
    lines.push(
      replyLocale === "en"
        ? "\nReply with the number (or the option) you want."
        : "\n원하는 번호(또는 항목)를 답장으로 보내주세요.",
    );
  }
  return lines.join("\n");
}

/**
 * 텍스트 안의 모든 ask 펜스를 평문 질문으로 바꾼다.
 * - 닫는 펜스가 없으면(스트리밍 잔재) 열림 마커만 제거하고 본문은 보존.
 * - 본문 파싱 실패 시 펜스를 통째 제거(raw 노출 방지).
 */
export function flattenAskFences(text: string, replyLocale: "ko" | "en"): string {
  if (!text.includes(AGENT_ASK_OPEN)) return text;
  let result = "";
  let rest = text;
  for (;;) {
    const open = rest.indexOf(AGENT_ASK_OPEN);
    if (open < 0) {
      result += rest;
      break;
    }
    result += rest.slice(0, open);
    const afterOpen = rest.slice(open + AGENT_ASK_OPEN.length);
    const close = afterOpen.indexOf(AGENT_ASK_CLOSE);
    if (close < 0) {
      // 닫는 펜스가 아직 없다(스트리밍 중). 본문을 남기면 안 된다 — 그것은 사람이 읽을
      // 글이 아니라 JSON 와이어 포맷이라, 실측(2026-08-20)에서 휴대폰에 `{"question":`
      // 조각이 그대로 떴다. 완성된 텍스트는 다음 투영에서 통째로 다시 오므로, 여기서는
      // 열림 마커부터 끝까지 버린다(다 온 뒤에 질문이 평문으로 보인다).
      break;
    }
    const flat = flattenAskFenceBody(afterOpen.slice(0, close), replyLocale);
    result += flat ?? "";
    rest = afterOpen.slice(close + AGENT_ASK_CLOSE.length);
  }
  return result;
}
