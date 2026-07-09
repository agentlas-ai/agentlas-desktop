// Chat CRUD + chat_messages.
// 사이드바 "최근 채팅" 섹션은 listRecent로 채운다.
// 프로젝트 페이지는 listByProject로, 회사 페이지는 listByFirm으로 채운다.
import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { getAgentGroup } from "./agent-groups";
import { getFirm } from "./firms";
import { touchProject } from "./projects";
import type { Chat, ChatHistoryEntry, HiredAgentCard } from "../../shared/types";
import { currentUiLocale } from "../main";

interface ChatRow {
  id: string;
  project_id: string | null;
  firm_id: string | null;
  agent_group_id: string | null;
  agent_id: string;
  title: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  kind: string | null;
  continuous_mode: number | null;
  swarm_mode: number | null;
  hired_agents: string | null;
}

function parseHiredAgents(raw: string | null): HiredAgentCard[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .filter((item) => typeof item.slug === "string" && item.slug.trim().length > 0)
      .map((item) => ({
        slug: String(item.slug).trim(),
        name: typeof item.name === "string" ? item.name : undefined,
        source: item.source === "hub" || item.source === "installed" || item.source === "firm-node" ? item.source : undefined,
        routeLabel: typeof item.routeLabel === "string" ? item.routeLabel : undefined,
        hiredAt: typeof item.hiredAt === "string" ? item.hiredAt : new Date().toISOString(),
      }));
  } catch {
    return [];
  }
}

function toChat(row: ChatRow): Chat {
  return {
    id: row.id,
    projectId: row.project_id,
    firmId: row.firm_id,
    agentGroupId: row.agent_group_id,
    agentId: row.agent_id,
    title: row.title,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    kind: row.kind === "division" ? "division" : "user",
    continuousMode: row.continuous_mode === 1,
    swarmMode: row.swarm_mode === 1,
    hiredAgents: parseHiredAgents(row.hired_agents),
  };
}

/** 사이드바용 — 활성 사용자 채팅만 (보관·숨김 본부 세션 제외) */
export function listRecentChats(limit = 50): Chat[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM chats
       WHERE archived_at IS NULL
         AND kind = 'user'
         AND used_at IS NOT NULL
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as ChatRow[];
  return rows.map(toChat);
}

export function listArchivedChats(): Chat[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM chats WHERE archived_at IS NOT NULL ORDER BY archived_at DESC",
    )
    .all() as ChatRow[];
  return rows.map(toChat);
}

export function listChatsByProject(projectId: string): Chat[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM chats
       WHERE project_id = ?
         AND kind = 'user'
         AND used_at IS NOT NULL
       ORDER BY updated_at DESC`,
    )
    .all(projectId) as ChatRow[];
  return rows.map(toChat);
}

export function listChatsByFirm(firmId: string): Chat[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM chats
       WHERE firm_id = ?
         AND kind = 'user'
         AND used_at IS NOT NULL
       ORDER BY updated_at DESC`,
    )
    .all(firmId) as ChatRow[];
  return rows.map(toChat);
}

export function getChat(id: string): Chat | null {
  const row = getDb()
    .prepare("SELECT * FROM chats WHERE id = ?")
    .get(id) as ChatRow | undefined;
  return row ? toChat(row) : null;
}

export function createChat(input: {
  agentId?: string;
  firmId?: string | null;
  agentGroupId?: string | null;
  projectId?: string | null;
  title?: string;
  /** 'user'(기본, 사이드바 노출) | 'division'(백그라운드 본부 세션, 숨김) */
  kind?: "user" | "division";
  /** 본부 세션 → 부모 firm 채팅 링크 */
  parentChatId?: string | null;
}): Chat {
  const ko = currentUiLocale() === "ko";
  let resolvedAgentId = input.agentId;
  if (input.agentGroupId) {
    const group = getAgentGroup(input.agentGroupId);
    if (!group) {
      throw new Error(
        ko ? `에이전트 조합 ${input.agentGroupId}을 찾을 수 없습니다` : `Could not find agent group ${input.agentGroupId}`,
      );
    }
  }
  if (input.firmId && !resolvedAgentId) {
    const firm = getFirm(input.firmId);
    if (!firm) throw new Error(ko ? `회사 ${input.firmId}을 찾을 수 없습니다` : `Could not find firm ${input.firmId}`);
    resolvedAgentId = firm.ceoAgentId;
  }
  if (!resolvedAgentId) {
    const fallback = getDb()
      .prepare("SELECT id FROM installed_agents WHERE slug = 'agentlas-orchestrator' LIMIT 1")
      .get() as { id: string } | undefined;
    resolvedAgentId = fallback?.id;
  }
  if (!resolvedAgentId) {
    throw new Error(ko ? "새 채팅에는 agentId 또는 firmId가 필요합니다" : "A new chat needs an agentId or firmId");
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  // title은 빈 문자열로 저장 — UI 표시 시 locale에 따라 "새 채팅" / "New chat"으로 표시.
  // 첫 user 메시지 도착 시 autoTitleFromFirstMessage가 채움.
  getDb()
    .prepare(
      `INSERT INTO chats (id, project_id, firm_id, agent_group_id, agent_id, title, kind, parent_chat_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.projectId ?? null,
      input.agentGroupId ? null : input.firmId ?? null,
      input.agentGroupId ?? null,
      resolvedAgentId,
      input.title?.trim() ?? "",
      input.kind ?? "user",
      input.parentChatId ?? null,
      now,
      now,
    );
  if (input.projectId) touchProject(input.projectId);
  return getChat(id) as Chat;
}

/** 본부(division) 지속 세션을 찾거나 만든다 — 부모 firm 채팅에 종속된 숨김 sub-chat.
 *  히스토리·메모리가 턴 간 유지된다. divisionId는 ResolvedNode.id(안정 식별자).
 *  fkAgentId는 installed_agents에 존재하는 실 agent id여야 한다(FK) — 본부에 실에이전트가
 *  없으면 호출부가 CEO agentId를 넘긴다. 메모리/텔레메트리 정체성은 divisionId로 분리된다. */
export function getOrCreateDivisionSession(
  parentChatId: string,
  divisionId: string,
  fkAgentId: string,
): Chat {
  const marker = `⟦div⟧${divisionId}`;
  const db = getDb();
  const existing = db
    .prepare(
      "SELECT * FROM chats WHERE parent_chat_id = ? AND kind = 'division' AND title = ? LIMIT 1",
    )
    .get(parentChatId, marker) as ChatRow | undefined;
  if (existing) return toChat(existing);
  const parent = getChat(parentChatId);
  return createChat({
    agentId: fkAgentId,
    firmId: parent?.firmId ?? null,
    projectId: parent?.projectId ?? null,
    title: marker,
    kind: "division",
    parentChatId,
  });
}

/** 자동화별 숨김 지속 세션을 찾거나 만든다.
 *  recurring work가 매 실행마다 새 대화로 초기화되지 않고 이전 결과/차단 상태를 이어받게 한다. */
export function getOrCreateAutomationSession(input: {
  automationId: string;
  agentId?: string;
  firmId?: string | null;
  agentGroupId?: string | null;
}): Chat {
  const marker = `⟦automation⟧${input.automationId}`;
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM chats WHERE kind = 'division' AND title = ? LIMIT 1")
    .get(marker) as ChatRow | undefined;
  if (existing) return toChat(existing);
  return createChat({
    agentId: input.agentId,
    firmId: input.firmId ?? null,
    agentGroupId: input.agentGroupId ?? null,
    title: marker,
    kind: "division",
  });
}

export function renameChat(id: string, title: string): Chat {
  // 빈 문자열 허용 — UI는 fallback 라벨 표시
  getDb()
    .prepare("UPDATE chats SET title = ?, updated_at = ? WHERE id = ?")
    .run(title.trim(), new Date().toISOString(), id);
  return getChat(id) as Chat;
}

/** 채팅의 에이전트를 다른 에이전트로 전환. firm 채팅이었으면 firm 해제. */
export function switchChatAgent(id: string, agentId: string): Chat {
  getDb()
    .prepare(
      "UPDATE chats SET agent_id = ?, firm_id = NULL, agent_group_id = NULL, updated_at = ? WHERE id = ?",
    )
    .run(agentId, new Date().toISOString(), id);
  return getChat(id) as Chat;
}

export function archiveChat(id: string): Chat {
  getDb()
    .prepare("UPDATE chats SET archived_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
  return getChat(id) as Chat;
}

export function unarchiveChat(id: string): Chat {
  getDb()
    .prepare("UPDATE chats SET archived_at = NULL, updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
  return getChat(id) as Chat;
}

export function removeChat(id: string): void {
  getDb().prepare("DELETE FROM chats WHERE id = ?").run(id);
}

/** 자동화 삭제 시 연결된 숨김 실행 세션도 같이 삭제한다.
 * 그래프 러너는 타깃별 세션을 `⟦automation⟧<id>::...` 형식으로 만들 수 있으므로 prefix까지 정리한다. */
export function removeAutomationSessions(automationId: string): void {
  const marker = `⟦automation⟧${automationId}`;
  getDb()
    .prepare("DELETE FROM chats WHERE kind = 'division' AND (title = ? OR title LIKE ?)")
    .run(marker, `${marker}::%`);
}

// ── working folder (워크스페이스 패널) ──────────────────────
// 각 채팅별로 사용자가 마지막에 연 로컬 폴더를 기억. 다음 진입 시 자동 복원.
export function getChatWorkingFolder(chatId: string): string | null {
  const row = getDb()
    .prepare("SELECT working_folder AS wf FROM chats WHERE id = ?")
    .get(chatId) as { wf: string | null } | undefined;
  return row?.wf ?? null;
}

export function setChatWorkingFolder(chatId: string, absPath: string | null): void {
  getDb()
    .prepare("UPDATE chats SET working_folder = ?, updated_at = ? WHERE id = ?")
    .run(absPath, new Date().toISOString(), chatId);
}

/** "계속 라이브로" 모드 — 켜두면 이 채팅의 Stormbreaker 연속실행이 짧은 상한에 닿아도
 *  백그라운드로 넘기지 않고 같은 채팅에서 라이브 스트리밍을 계속 이어간다(runMcpInvocation 참고). */
export function setChatContinuousMode(chatId: string, enabled: boolean): void {
  getDb()
    .prepare("UPDATE chats SET continuous_mode = ?, updated_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, new Date().toISOString(), chatId);
}

/** 스웜 모드 — 켜면 이 채팅이 목표를 작업 그래프로 분해해 여러 워커가 병렬 협업한다(runSwarmInvocation). */
export function setChatSwarmMode(chatId: string, enabled: boolean): void {
  getDb()
    .prepare("UPDATE chats SET swarm_mode = ?, updated_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, new Date().toISOString(), chatId);
}

/** 고용(빌림) 카드 저장 — 빈 배열이면 해고(컬럼 비움). 메타데이터 카드만 저장한다. */
export function setChatHiredAgents(chatId: string, cards: HiredAgentCard[]): Chat {
  const deduped = new Map<string, HiredAgentCard>();
  for (const card of cards) {
    const slug = card.slug?.trim();
    if (!slug) continue;
    deduped.set(slug, { ...card, slug, hiredAt: card.hiredAt || new Date().toISOString() });
  }
  const value = deduped.size > 0 ? JSON.stringify([...deduped.values()]) : null;
  getDb()
    .prepare("UPDATE chats SET hired_agents = ?, updated_at = ? WHERE id = ?")
    .run(value, new Date().toISOString(), chatId);
  const chat = getChat(chatId);
  if (!chat) throw new Error(`Chat ${chatId} not found`);
  return chat;
}

// ── chat_messages ───────────────────────────────────────────
interface MessageRow {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  created_at: string;
}

export function appendChatMessage(
  chatId: string,
  role: "user" | "assistant" | "system",
  text: string,
): ChatHistoryEntry {
  const id = randomUUID();
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(
    "INSERT INTO chat_messages (id, chat_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, chatId, role, text, now);
  db.prepare("UPDATE chats SET updated_at = ?, used_at = COALESCE(used_at, ?) WHERE id = ?").run(now, now, chatId);
  const chat = getChat(chatId);
  if (chat?.projectId) touchProject(chat.projectId);
  return { id, role, text, createdAt: now };
}

export function listChatMessages(chatId: string, limit = 200): ChatHistoryEntry[] {
  const rows = getDb()
    .prepare(
      "SELECT id, role, text, created_at FROM (SELECT id, role, text, created_at FROM chat_messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at ASC",
    )
    .all(chatId, limit) as MessageRow[];
  return rows.map((r) => ({ id: r.id, role: r.role, text: r.text, createdAt: r.created_at }));
}

/** recap용 — 마지막으로 본 시각(last_viewed_at) 이후 도착한 에이전트(assistant) 메시지들.
 *  last_viewed_at이 NULL(이 채팅을 아직 recap 대상으로 표시한 적 없음)이면 recap 생략 → 빈 배열. */
export function getRecapSince(chatId: string): { lastViewedAt: string | null; messages: ChatHistoryEntry[] } {
  const db = getDb();
  const row = db.prepare("SELECT last_viewed_at AS lv FROM chats WHERE id = ?").get(chatId) as { lv: string | null } | undefined;
  const lastViewedAt = row?.lv ?? null;
  if (!lastViewedAt) return { lastViewedAt: null, messages: [] };
  const rows = db
    .prepare(
      "SELECT id, role, text, created_at FROM chat_messages WHERE chat_id = ? AND role = 'assistant' AND created_at > ? ORDER BY created_at ASC LIMIT 40",
    )
    .all(chatId, lastViewedAt) as MessageRow[];
  return { lastViewedAt, messages: rows.map((r) => ({ id: r.id, role: r.role, text: r.text, createdAt: r.created_at })) };
}

/** recap용 — 이 채팅을 방금 봤다고 기록(last_viewed_at = now). 사이드바 정렬이 흔들리지
 *  않도록 updated_at은 절대 건드리지 않는다. */
export function markChatViewed(chatId: string): void {
  getDb().prepare("UPDATE chats SET last_viewed_at = ? WHERE id = ?").run(new Date().toISOString(), chatId);
}

/** 채팅의 가장 마지막 메시지 1개 (확인 대기 판별용 — 마지막이 미답변 질문 fence면 pending). */
export function getLastChatMessage(chatId: string): ChatHistoryEntry | null {
  const row = getDb()
    .prepare(
      "SELECT id, role, text, created_at FROM chat_messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(chatId) as MessageRow | undefined;
  return row
    ? { id: row.id, role: row.role, text: row.text, createdAt: row.created_at }
    : null;
}

export function clearChatMessages(chatId: string): void {
  getDb().prepare("DELETE FROM chat_messages WHERE chat_id = ?").run(chatId);
}

export function autoTitleFromFirstMessage(chatId: string, firstMessage: string): void {
  const chat = getChat(chatId);
  if (!chat) return;
  // 사용자가 이미 rename했으면(= title이 비어있지 않음) 건드리지 않음.
  // 빈 문자열은 "untitled" 상태 — locale별 placeholder가 UI에서만 보임.
  // 과거 빌드(v6 이전)에서 "새 채팅"으로 저장된 행도 함께 처리.
  if (chat.title.length > 0 && chat.title !== "새 채팅" && chat.title !== "New chat") return;
  const condensed = firstMessage.replace(/\s+/g, " ").trim();
  const truncated = condensed.length > 36 ? condensed.slice(0, 34) + "…" : condensed;
  if (truncated) renameChat(chatId, truncated);
}
