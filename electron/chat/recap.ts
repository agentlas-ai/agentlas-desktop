// 세션 recap — 사용자가 채팅을 떠나 있는 동안 에이전트가 백그라운드로 남긴 응답을
// "그동안 뭐 했는지" 한 줄로 요약한다(Claude Code recap의 이식). 키리스 agy→codex 재사용.
import type { ChatHistoryEntry } from "../../shared/types";
import { getRecapSince, markChatViewed } from "../store/chats";
import { runLlm } from "../document/generate";

// 떠난 지 이 시간 미만이면 recap을 띄우지 않는다(잠깐 시선 돌린 정도는 노이즈).
const MIN_AWAY_MS = 3 * 60 * 1000;

export interface ChatRecap {
  summary: string;
  count: number;
  sinceIso: string;
}

/**
 * 이 채팅에 recap이 필요하면 한 줄 요약을 만들어 돌려준다(없으면 null).
 * 부수효과 없음 — last_viewed_at은 markChatViewed로 별도 갱신한다.
 */
export async function buildChatRecap(chatId: string, locale: "ko" | "en"): Promise<ChatRecap | null> {
  const { lastViewedAt, messages } = getRecapSince(chatId);
  if (!lastViewedAt || messages.length === 0) return null;
  // 마지막으로 본 지 충분히 지났을 때만(짧게 시선 돌린 경우 제외).
  const awayMs = Date.now() - Date.parse(lastViewedAt);
  if (!Number.isFinite(awayMs) || awayMs < MIN_AWAY_MS) return null;

  const sinceIso = messages[messages.length - 1]?.createdAt ?? lastViewedAt;
  const summary = await summarize(messages, locale);
  if (!summary) return null;
  return { summary, count: messages.length, sinceIso };
}

/** recap을 띄운(또는 채팅을 본) 뒤 호출 — 다음 recap 기준점을 지금으로 옮긴다. */
export function markChatRecapViewed(chatId: string): void {
  markChatViewed(chatId);
}

async function summarize(messages: ChatHistoryEntry[], locale: "ko" | "en"): Promise<string | null> {
  const transcript = messages
    .map((m, i) => `[${i + 1}] ${oneLine(m.text).slice(0, 600)}`)
    .join("\n");
  const prompt =
    locale === "ko"
      ? [
          "너는 자리를 비운 사용자에게 그동안 있었던 일을 한 문장으로 알려주는 요약기다.",
          "아래는 사용자가 자리를 비운 사이 에이전트가 이 채팅에 남긴 응답들이다.",
          "무엇을 했고 결과가 무엇인지 한국어 한 문장(최대 90자)으로만 답하라.",
          "머리말·따옴표·마크다운·설명 없이 그 한 문장만 출력한다.",
          "",
          transcript,
        ].join("\n")
      : [
          "You summarize, for a user who stepped away, what happened while they were gone.",
          "Below are the agent's responses left in this chat while the user was away.",
          "Answer with ONE sentence (max 120 chars) stating what was done and the outcome.",
          "Output only that sentence — no preamble, quotes, markdown, or explanation.",
          "",
          transcript,
        ].join("\n");

  const out = await runLlm(prompt);
  if (!out.text) return null;
  return cleanLine(out.text);
}

function oneLine(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

function cleanLine(raw: string): string {
  let s = oneLine(raw);
  // 코드펜스/래핑 따옴표 제거 + 첫 문장만.
  s = s.replace(/^```[^\n]*/, "").replace(/```$/, "").trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s.slice(0, 240);
}
