// 세션 recap — 사용자가 채팅을 떠나 있는 동안 에이전트가 백그라운드로 남긴 응답을
// "그동안 뭐 했는지" 한 줄로 요약한다(Claude Code recap의 이식). 키리스 agy→codex 재사용.
import type { ChatHistoryEntry } from "../../shared/types";
import { markChatViewed } from "../store/chats";
import { runLlm } from "../document/generate";
import { getDb } from "../store/db";
import { getMemoryDb, getMemoryStoreInfo } from "../memory/database";
import { createHash } from "node:crypto";
import { looksSecret } from "../../shared/secret-patterns";
import { registerMemoryRecallCacheInvalidator } from "../memory/selected-context-cache";

// 떠난 지 이 시간 미만이면 recap을 띄우지 않는다(잠깐 시선 돌린 정도는 노이즈).
const MIN_AWAY_MS = 3 * 60 * 1000;

export interface ChatRecap {
  summary: string;
  count: number;
  sinceIso: string;
  /** A display range, never a memory-processing cursor or execution ACK. */
  coverage?: { messageIds: string[]; reusedTurnSummaries: number; legacyMessages: number };
}
const cache = new Map<string, ChatRecap>();
const inflight = new Map<string, Promise<ChatRecap | null>>();
const MAX_CACHED_RANGES = 80;
export function clearChatRecapCache(): void { cache.clear(); }
registerMemoryRecallCacheInvalidator(clearChatRecapCache);

function unreadMessages(chatId: string): { lastViewedAt: string | null; messages: ChatHistoryEntry[] } {
  const db = getDb();
  const chat = db.prepare("SELECT last_viewed_at FROM chats WHERE id=?").get(chatId) as { last_viewed_at: string | null } | undefined;
  const lastViewedAt = chat?.last_viewed_at ?? null;
  if (!lastViewedAt) return { lastViewedAt, messages: [] };
  // No first-40 cap: the coverage includes the whole observed unread range.
  const messages = db.prepare(`SELECT id,role,text,created_at FROM chat_messages
    WHERE chat_id=? AND role='assistant' AND created_at>? ORDER BY created_at ASC,rowid ASC`).all(chatId, lastViewedAt) as Array<{
      id: string; role: "assistant"; text: string; created_at: string;
    }>;
  return { lastViewedAt, messages: messages.map(row => ({ id: row.id, role: row.role, text: row.text, createdAt: row.created_at })) };
}

function ticketSummaries(chatId: string, messages: ChatHistoryEntry[]): Map<string, string> {
  const summaries = new Map<string, string>();
  const product = getDb(), memory = getMemoryDb();
  const messageRuns = new Map<string, Set<string>>();
  for (let start = 0; start < messages.length; start += 200) {
    const ids = messages.slice(start, start + 200).map(message => message.durableMessageId ?? message.id);
    const runs = product.prepare(`SELECT DISTINCT run_id,json_extract(payload_json,'$.durableMessageId') AS message_id
      FROM run_events WHERE chat_id=? AND kind IN ('mcp_final','invoke_result')
      AND json_extract(payload_json,'$.durableMessageId') IN (${ids.map(() => "?").join(",")})`)
      .all(chatId, ...ids) as Array<{ run_id: string; message_id: string }>;
    for (const run of runs) { const owners = messageRuns.get(run.message_id) ?? new Set<string>();
      owners.add(run.run_id); messageRuns.set(run.message_id, owners); }
  }
  for (const message of messages) {
    // Exact durable final-message binding; timestamps or nearby ticket order
    // cannot establish which agent/run produced a particular response.
    const runs = messageRuns.get(message.durableMessageId ?? message.id);
    if (!runs || runs.size !== 1) continue;
    const episodes = memory.prepare(`SELECT e.summary FROM memory_episodes e JOIN memory_tickets t ON t.ticket_id=e.ticket_id
      WHERE t.run_id=? AND t.chat_id=? AND t.state IN ('completed','read_only') AND e.summary IS NOT NULL`)
      .all([...runs][0], chatId) as Array<{ summary: string }>;
    if (episodes.length === 1 && episodes[0].summary.trim() && !looksSecret(episodes[0].summary))
      summaries.set(message.id, episodes[0].summary.trim());
  }
  return summaries;
}

/**
 * 이 채팅에 recap이 필요하면 한 줄 요약을 만들어 돌려준다(없으면 null).
 * 부수효과 없음 — last_viewed_at은 markChatViewed로 별도 갱신한다.
 */
export async function buildChatRecap(chatId: string, locale: "ko" | "en"): Promise<ChatRecap | null> {
  const { lastViewedAt, messages } = unreadMessages(chatId);
  if (!lastViewedAt || messages.length === 0) return null;
  // 마지막으로 본 지 충분히 지났을 때만(짧게 시선 돌린 경우 제외).
  const awayMs = Date.now() - Date.parse(lastViewedAt);
  if (!Number.isFinite(awayMs) || awayMs < MIN_AWAY_MS) return null;

  let reused = new Map<string, string>();
  try { reused = ticketSummaries(chatId, messages); } catch { /* Legacy store: only the uncovered messages need summarizing. */ }
  const custody = getMemoryStoreInfo();
  const key = createHash("sha256").update(JSON.stringify([custody.ownerNamespace, custody.revocationEpoch, chatId, locale,
    messages.map(message => [message.id, message.text, reused.get(message.id) ?? null])])).digest("hex");
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;
  const work = (async (): Promise<ChatRecap | null> => {
    const uncovered = messages.filter(message => !reused.has(message.id));
    const parts = [...new Set(messages.flatMap(message => reused.has(message.id) ? [reused.get(message.id)!] : []))];
    if (uncovered.length > 0) {
      // Batch only missing source messages. Never ask the model to re-summarize
      // ticket-covered replies or silently omit messages after the first 40.
      for (let start = 0; start < uncovered.length; start += 40) {
        const summary = await summarize(uncovered.slice(start, start + 40), locale);
        if (!summary) return null;
        parts.push(summary);
      }
    }
    if (parts.length === 0) return null;
    let displayParts = parts;
    while (displayParts.length > 40) {
      const batches: string[] = [];
      for (let start = 0; start < displayParts.length; start += 40) {
        const summary = await summarize(displayParts.slice(start, start + 40).map((text, index) => ({
          id: `recap-batch:${start + index}`, role: "assistant", text, createdAt: "",
        })), locale);
        if (!summary) return null;
        batches.push(summary);
      }
      displayParts = batches;
    }
    let joined = displayParts.join(" · ");
    if (joined.length > 240 || (locale === "ko" && reused.size > 0 && displayParts === parts)) {
      // Canonical turn summaries are English. A Korean display or long range
      // needs one bounded pass over digests, never the covered original replies.
      const condensed = await summarize(displayParts.map((text, index) => ({ id: `recap-digest:${index}`, role: "assistant", text, createdAt: "" })), locale);
      if (condensed) joined = condensed;
    }
    const currentCustody = getMemoryStoreInfo();
    if (currentCustody.ownerNamespace !== custody.ownerNamespace || currentCustody.revocationEpoch !== custody.revocationEpoch) return null;
    const result: ChatRecap = { summary: joined, count: messages.length,
      sinceIso: messages[messages.length - 1]?.createdAt ?? lastViewedAt,
      coverage: { messageIds: messages.map(message => message.id), reusedTurnSummaries: reused.size, legacyMessages: uncovered.length } };
    cache.set(key, result);
    while (cache.size > MAX_CACHED_RANGES) cache.delete(cache.keys().next().value as string);
    return result;
  })();
  inflight.set(key, work);
  try { return await work; } finally { inflight.delete(key); }
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

  const out = await runLlm(prompt, "chat-recap");
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
