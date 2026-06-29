// Chat CRUD + chat_messages.
// 사이드바 "최근 채팅" 섹션은 listRecent로 채운다.
// 프로젝트 페이지는 listByProject로, 회사 페이지는 listByFirm으로 채운다.
import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { getFirm } from "./firms";
import { touchProject } from "./projects";
import type { Chat, ChatHistoryEntry } from "../../shared/types";

interface ChatRow {
  id: string;
  project_id: string | null;
  firm_id: string | null;
  agent_id: string;
  title: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  kind: string | null;
}

function toChat(row: ChatRow): Chat {
  return {
    id: row.id,
    projectId: row.project_id,
    firmId: row.firm_id,
    agentId: row.agent_id,
    title: row.title,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    kind: row.kind === "division" ? "division" : "user",
  };
}

/** 사이드바용 — 활성 사용자 채팅만 (보관·숨김 본부 세션 제외) */
export function listRecentChats(limit = 50): Chat[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM chats WHERE archived_at IS NULL AND kind = 'user' ORDER BY updated_at DESC LIMIT ?",
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
    .prepare("SELECT * FROM chats WHERE project_id = ? AND kind = 'user' ORDER BY updated_at DESC")
    .all(projectId) as ChatRow[];
  return rows.map(toChat);
}

export function listChatsByFirm(firmId: string): Chat[] {
  const rows = getDb()
    .prepare("SELECT * FROM chats WHERE firm_id = ? AND kind = 'user' ORDER BY updated_at DESC")
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
  projectId?: string | null;
  title?: string;
  /** 'user'(기본, 사이드바 노출) | 'division'(백그라운드 본부 세션, 숨김) */
  kind?: "user" | "division";
  /** 본부 세션 → 부모 firm 채팅 링크 */
  parentChatId?: string | null;
}): Chat {
  let resolvedAgentId = input.agentId;
  if (input.firmId && !resolvedAgentId) {
    const firm = getFirm(input.firmId);
    if (!firm) throw new Error(`회사 ${input.firmId}을 찾을 수 없습니다`);
    resolvedAgentId = firm.ceoAgentId;
  }
  if (!resolvedAgentId) {
    const fallback = getDb()
      .prepare("SELECT id FROM installed_agents WHERE slug = 'agentlas-orchestrator' LIMIT 1")
      .get() as { id: string } | undefined;
    resolvedAgentId = fallback?.id;
  }
  if (!resolvedAgentId) {
    throw new Error("새 채팅에는 agentId 또는 firmId가 필요합니다");
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  // title은 빈 문자열로 저장 — UI 표시 시 locale에 따라 "새 채팅" / "New chat"으로 표시.
  // 첫 user 메시지 도착 시 autoTitleFromFirstMessage가 채움.
  getDb()
    .prepare(
      `INSERT INTO chats (id, project_id, firm_id, agent_id, title, kind, parent_chat_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.projectId ?? null,
      input.firmId ?? null,
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
      "UPDATE chats SET agent_id = ?, firm_id = NULL, updated_at = ? WHERE id = ?",
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
  db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(now, chatId);
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
