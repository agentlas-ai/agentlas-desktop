// Chat CRUD + chat_messages.
// 사이드바 "최근 채팅" 섹션은 listRecent로 채운다.
// 프로젝트 페이지는 listByProject로, 회사 페이지는 listByFirm으로 채운다.
import { createHash, randomUUID } from "node:crypto";
import { getDb } from "./db";
import { emitDesktopStoreChange } from "./change-bus";
import { getAgentGroup } from "./agent-groups";
import { getFirm } from "./firms";
import { evictRuntimeSessionsForChat } from "./runtime-sessions";
import { touchProject } from "./projects";
import type {
  Chat,
  ChatHistoryEntry,
  HiredAgentCard,
  RuntimeBackend,
  RuntimeKind,
  RuntimeSelection,
} from "../../shared/types";
import { currentUiLocale } from "../ui-locale";
import {
  ensureCanonicalTaskForChat,
  findCanonicalTaskForChat,
  removeCanonicalTaskForOriginChat,
} from "./tasks";

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
  origin_surface: string | null;
  runtime_selection_json: string | null;
}

const CHAT_RUNTIME_KINDS = new Set<RuntimeKind>([
  "claude-code",
  "codex",
  "gemini",
  "kimi",
  "grok",
  "cursor",
  "byok",
  "ollama",
  "lmstudio",
  "mlx",
]);

const CHAT_RUNTIME_BACKENDS = new Set<RuntimeBackend>([
  "anthropic",
  "openai",
  "google",
  "ollama",
  "lmstudio",
  "mlx",
  "upstage",
  "custom",
  "glm",
  "kimi",
  "deepseek",
  "minimax",
  "xai",
  "openrouter",
  "cursor",
]);

function boundedOptionalText(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new TypeError(`Invalid chat runtime ${field}`);
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeChatRuntimeSelection(value: unknown): RuntimeSelection | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid chat runtime selection");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.kind !== "string" || !CHAT_RUNTIME_KINDS.has(input.kind as RuntimeKind)) {
    throw new TypeError("Invalid chat runtime kind");
  }
  if (
    input.backend !== undefined &&
    input.backend !== null &&
    (typeof input.backend !== "string" ||
      !CHAT_RUNTIME_BACKENDS.has(input.backend as RuntimeBackend))
  ) {
    throw new TypeError("Invalid chat runtime backend");
  }
  if (
    input.role !== undefined &&
    input.role !== "orchestrator"
  ) {
    throw new TypeError("A chat runtime pin must use the orchestrator role");
  }
  if (input.inherit !== undefined && input.inherit !== false) {
    throw new TypeError("A chat runtime pin cannot inherit");
  }
  if (
    input.longContext !== undefined &&
    typeof input.longContext !== "boolean"
  ) {
    throw new TypeError("Invalid chat runtime longContext");
  }
  return {
    kind: input.kind as RuntimeKind,
    backend: input.backend as RuntimeBackend | undefined,
    source: boundedOptionalText(input.source, "source", 2_048),
    model: boundedOptionalText(input.model, "model", 512),
    effort: boundedOptionalText(input.effort, "effort", 80),
    longContext: input.longContext === true,
    role: "orchestrator",
    inherit: false,
  };
}

function parseChatRuntimeSelection(raw: string | null): RuntimeSelection | null {
  if (!raw) return null;
  try {
    return normalizeChatRuntimeSelection(JSON.parse(raw));
  } catch {
    return null;
  }
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
  // A general One conversation deliberately has no Task until execution
  // signals promote it. Existing Work/Task chats are reconciled on read.
  const existingTask = findCanonicalTaskForChat(row.id);
  const task = existingTask ? ensureCanonicalTaskForChat(row.id) : null;
  return {
    id: row.id,
    ...(task ? { taskId: task.id } : {}),
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
    originSurface: row.origin_surface === "one" ? "one" : "work",
    runtimeSelection: parseChatRuntimeSelection(row.runtime_selection_json),
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

/** 가벼운 표면 판별 — Task 재조정(toChat) 없이 origin_surface만 읽는다. */
export function chatOriginSurface(chatId: string): "one" | "work" | null {
  const row = getDb()
    .prepare("SELECT origin_surface FROM chats WHERE id = ?")
    .get(chatId) as { origin_surface: string | null } | undefined;
  if (!row) return null;
  return row.origin_surface === "one" ? "one" : "work";
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
  /** 새 문맥을 시작하되, 기존 채팅이 승인받은 작업 폴더만 이어받는다. */
  continueFromChatId?: string | null;
  /** 'user'(기본, 사이드바 노출) | 'division'(백그라운드 본부 세션, 숨김) */
  kind?: "user" | "division";
  /** 본부 세션 → 부모 firm 채팅 링크 */
  parentChatId?: string | null;
  /** One general conversation stays Task-free until explicit promotion. */
  taskMode?: "task" | "conversation";
  /** 어느 표면이 시작한 대화인지 — One 홈과 Work 사이드바를 durable하게 분리한다. */
  originSurface?: "one" | "work";
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

  // renderer가 임의 경로를 넘기지 않는다. 이전 채팅에 main이 이미 저장한 작업 폴더만
  // 복사해 새 세션도 같은 로컬 작업공간에서 바로 이어갈 수 있게 한다.
  let continuedWorkingFolder: string | null = null;
  if (input.continueFromChatId) {
    const source = getChat(input.continueFromChatId);
    if (!source) throw new Error(ko ? "이어갈 이전 채팅을 찾을 수 없습니다" : "Could not find the chat to continue from");
    continuedWorkingFolder = getChatWorkingFolder(source.id);
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  // title은 빈 문자열로 저장 — UI 표시 시 locale에 따라 "새 채팅" / "New chat"으로 표시.
  // 첫 user 메시지 도착 시 autoTitleFromFirstMessage가 채움.
  getDb()
    .prepare(
      `INSERT INTO chats (id, project_id, firm_id, agent_group_id, agent_id, title, kind, parent_chat_id, working_folder, created_at, updated_at, origin_surface)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      continuedWorkingFolder,
      now,
      now,
      input.originSurface === "one" ? "one" : "work",
    );
  if (input.projectId) touchProject(input.projectId);
  if (input.taskMode !== "conversation") ensureCanonicalTaskForChat(id);
  const chat = getChat(id) as Chat;
  emitDesktopStoreChange({ entity: "chat", id });
  return chat;
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

/** Hidden persistent session for a complete Team/Firm nested under a parent TF.
 * Keeping a dedicated parent prevents division-id collisions between two teams
 * that happen to use the same role names. */
export function getOrCreateFirmSession(
  parentChatId: string,
  firmId: string,
  ceoAgentId: string,
): Chat {
  const marker = `⟦firm⟧${firmId}`;
  const db = getDb();
  const existing = db
    .prepare(
      "SELECT * FROM chats WHERE parent_chat_id = ? AND kind = 'division' AND title = ? LIMIT 1",
    )
    .get(parentChatId, marker) as ChatRow | undefined;
  if (existing) return toChat(existing);
  const parent = getChat(parentChatId);
  return createChat({
    agentId: ceoAgentId,
    firmId,
    projectId: parent?.projectId ?? null,
    title: marker,
    kind: "division",
    parentChatId,
  });
}

/** Hidden persistent session for a saved Agent Group nested under a top TF. */
export function getOrCreateAgentGroupSession(
  parentChatId: string,
  groupId: string,
  orchestratorAgentId: string,
): Chat {
  const marker = `⟦group⟧${groupId}`;
  const db = getDb();
  const existing = db
    .prepare(
      "SELECT * FROM chats WHERE parent_chat_id = ? AND kind = 'division' AND title = ? LIMIT 1",
    )
    .get(parentChatId, marker) as ChatRow | undefined;
  if (existing) return toChat(existing);
  const parent = getChat(parentChatId);
  return createChat({
    agentId: orchestratorAgentId,
    agentGroupId: groupId,
    projectId: parent?.projectId ?? null,
    title: marker,
    kind: "division",
    parentChatId,
  });
}

/** 사이트 디자인 스튜디오의 프로젝트별 숨김 지속 세션(division).
 *  같은 프로젝트의 생성/수정 턴이 한 대화로 이어져 빌려온 웹앱 디자인 마스터가
 *  프로젝트의 디자인 언어/결정 맥락을 기억한다. */
export function getOrCreateSiteSession(projectId: string): Chat {
  const marker = `⟦site⟧${projectId}`;
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM chats WHERE kind = 'division' AND title = ? LIMIT 1")
    .get(marker) as ChatRow | undefined;
  if (existing) return toChat(existing);
  return createChat({ title: marker, kind: "division" });
}

/** T-rex/Oberon 스튜디오 전용 숨김 division 세션 — 붙은 Hub 에이전트(슬라이드/영상 스튜디오)를
 *  활성 런타임으로 borrow 실행할 때 쓴다. studioKey별로 히스토리·메모리가 유지된다(예: "trex", "oberon"). */
export function getOrCreateStudioSession(studioKey: string): Chat {
  const marker = `⟦studio⟧${studioKey}`;
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM chats WHERE kind = 'division' AND title = ? LIMIT 1")
    .get(marker) as ChatRow | undefined;
  if (existing) return toChat(existing);
  return createChat({ title: marker, kind: "division" });
}

/** 자동화별 숨김 지속 세션을 찾거나 만든다.
 *  recurring work가 매 실행마다 새 대화로 초기화되지 않고 이전 결과/차단 상태를 이어받게 한다. */
export function getOrCreateAutomationSession(input: {
  automationId: string;
  agentId?: string;
  firmId?: string | null;
  agentGroupId?: string | null;
}): Chat {
  const baseMarker = `⟦automation⟧${input.automationId}`;
  const targetKind = input.agentGroupId ? "group" : input.firmId ? "firm" : input.agentId ? "agent" : "host";
  const targetId = input.agentGroupId ?? input.firmId ?? input.agentId ?? "default";
  const targetHash = createHash("sha256").update(targetKind).update("\0").update(targetId).digest("hex").slice(0, 16);
  const marker = `${baseMarker}::target:${targetKind}:${targetHash}`;
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM chats WHERE kind = 'division' AND title = ? LIMIT 1")
    .get(marker) as ChatRow | undefined;
  if (existing) return toChat(existing);

  // 기존 단일 marker 세션은 타깃 관계가 정확히 같은 경우에만 새 marker로 승격한다.
  // 타깃이 바뀌었다면 과거 세션/기억을 보존한 채 별도 세션을 만든다.
  const legacy = db
    .prepare("SELECT * FROM chats WHERE kind = 'division' AND title = ? LIMIT 1")
    .get(baseMarker) as ChatRow | undefined;
  const legacyMatches = legacy && (
    (targetKind === "group" && legacy.agent_group_id === input.agentGroupId) ||
    (targetKind === "firm" && legacy.firm_id === input.firmId) ||
    (targetKind === "agent" && !legacy.firm_id && !legacy.agent_group_id && legacy.agent_id === input.agentId)
  );
  if (legacy && legacyMatches) {
    db.prepare("UPDATE chats SET title = ?, updated_at = ? WHERE id = ?")
      .run(marker, new Date().toISOString(), legacy.id);
    const chat = toChat({ ...legacy, title: marker });
    emitDesktopStoreChange({ entity: "chat", id: legacy.id });
    return chat;
  }
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
  const chat = getChat(id) as Chat;
  emitDesktopStoreChange({ entity: "chat", id });
  return chat;
}

/** 채팅의 에이전트를 다른 에이전트로 전환. firm 채팅이었으면 firm 해제. */
export function switchChatAgent(id: string, agentId: string): Chat {
  getDb()
    .prepare(
      "UPDATE chats SET agent_id = ?, firm_id = NULL, agent_group_id = NULL, updated_at = ? WHERE id = ?",
    )
    .run(agentId, new Date().toISOString(), id);
  const chat = getChat(id) as Chat;
  emitDesktopStoreChange({ entity: "chat", id });
  return chat;
}

export function archiveChat(id: string): Chat {
  getDb()
    .prepare("UPDATE chats SET archived_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
  const chat = getChat(id) as Chat;
  emitDesktopStoreChange({ entity: "chat", id });
  return chat;
}

export function unarchiveChat(id: string): Chat {
  getDb()
    .prepare("UPDATE chats SET archived_at = NULL, updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
  const chat = getChat(id) as Chat;
  emitDesktopStoreChange({ entity: "chat", id });
  return chat;
}

export function removeChat(id: string): void {
  const task = findCanonicalTaskForChat(id);
  const result = getDb().prepare("DELETE FROM chats WHERE id = ?").run(id);
  if (result.changes > 0) {
    if (task?.originChatId === id) removeCanonicalTaskForOriginChat(id);
    emitDesktopStoreChange({ entity: "chat", id });
  }
}

/** 자동화 삭제 시 연결된 숨김 실행 세션도 같이 삭제한다.
 * 그래프 러너는 타깃별 세션을 `⟦automation⟧<id>::...` 형식으로 만들 수 있으므로 prefix까지 정리한다. */
export function removeAutomationSessions(automationId: string): void {
  const marker = `⟦automation⟧${automationId}`;
  getDb()
    .prepare("DELETE FROM chats WHERE kind = 'division' AND (title = ? OR title LIKE ?)")
    .run(marker, `${marker}::%`);
  emitDesktopStoreChange({ entity: "chat" });
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
  emitDesktopStoreChange({ entity: "chat", id: chatId });
}

/** 스웜 모드 — 켜면 이 채팅이 목표를 작업 그래프로 분해해 여러 워커가 병렬 협업한다(runSwarmInvocation). */
export function setChatSwarmMode(chatId: string, enabled: boolean): void {
  getDb()
    .prepare("UPDATE chats SET swarm_mode = ?, updated_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, new Date().toISOString(), chatId);
  emitDesktopStoreChange({ entity: "chat", id: chatId });
}

/** Exact chat-scoped orchestrator pin. It never mutates the role defaults. */
export function setChatRuntimeSelection(
  chatId: string,
  selection: RuntimeSelection | null,
): Chat {
  const normalized = normalizeChatRuntimeSelection(selection);
  getDb()
    .prepare(
      "UPDATE chats SET runtime_selection_json = ?, updated_at = ? WHERE id = ?",
    )
    .run(
      normalized ? JSON.stringify(normalized) : null,
      new Date().toISOString(),
      chatId,
  );
  emitDesktopStoreChange({ entity: "chat", id: chatId });
  const chat = getChat(chatId);
  if (!chat) throw new Error(`Chat not found: ${chatId}`);
  return chat;
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
  emitDesktopStoreChange({ entity: "chat", id: chatId });
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
  emitDesktopStoreChange({ entity: "chat", id: chatId });
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
  const result = getDb().prepare("DELETE FROM chat_messages WHERE chat_id = ?").run(chatId);
  if (result.changes > 0) emitDesktopStoreChange({ entity: "chat", id: chatId });
}

/**
 * 사용자가 /clear를 요청하면 화면 메시지와 CLI resume 포인터가 반드시 함께
 * 사라져야 한다. 둘 중 하나만 지우면 빈 화면에서 이전 provider 세션을 다시
 * 이어가는 거짓 성공이 되므로 같은 SQLite transaction으로 처리한다.
 */
export function clearChatContext(chatId: string): void {
  const db = getDb();
  const clear = db.transaction((targetChatId: string) => {
    db.prepare("DELETE FROM chat_runtime_sessions WHERE chat_id = ?").run(targetChatId);
    db.prepare("DELETE FROM chat_messages WHERE chat_id = ?").run(targetChatId);
    db.prepare("UPDATE chats SET last_viewed_at = ? WHERE id = ?").run(new Date().toISOString(), targetChatId);
  });
  clear(chatId);
  // DB rollback 가능성이 사라진 뒤에만 프로세스 내 resume 캐시를 폐기한다.
  evictRuntimeSessionsForChat(chatId);
  emitDesktopStoreChange({ entity: "chat", id: chatId });
}

function autoTitleValue(message: string): string {
  const condensed = message.replace(/\s+/g, " ").trim();
  return condensed.length > 36 ? condensed.slice(0, 34) + "…" : condensed;
}

export function autoTitleFromFirstMessage(chatId: string, firstMessage: string): void {
  const chat = getChat(chatId);
  if (!chat) return;
  // 사용자가 이미 rename했으면(= title이 비어있지 않음) 건드리지 않음.
  // 빈 문자열은 "untitled" 상태 — locale별 placeholder가 UI에서만 보임.
  // 과거 빌드(v6 이전)에서 "새 채팅"으로 저장된 행도 함께 처리.
  if (chat.title.length > 0 && chat.title !== "새 채팅" && chat.title !== "New chat") return;
  const truncated = autoTitleValue(firstMessage);
  if (truncated) renameChat(chatId, truncated);
}

/**
 * When a general One conversation becomes executable work, replace only the
 * title that was mechanically derived from its first user turn. A title the
 * user renamed themselves is never touched.
 */
export function retitleAutoTitledChatForTask(chatId: string, taskPrompt: string): Chat | null {
  const chat = getChat(chatId);
  if (!chat) return null;
  const firstUser = getDb()
    .prepare("SELECT text FROM chat_messages WHERE chat_id = ? AND role = 'user' ORDER BY created_at ASC LIMIT 1")
    .get(chatId) as { text: string } | undefined;
  const inheritedAutoTitle = firstUser ? autoTitleValue(firstUser.text) : "";
  const isAutomatic = chat.title === inheritedAutoTitle
    || chat.title === ""
    || chat.title === "새 채팅"
    || chat.title === "New chat";
  if (!isAutomatic) return chat;
  const taskTitle = autoTitleValue(taskPrompt.replace(/^\s*(?:\/?workforce\b|\/?hep-network\b)(?:\s+--(?:benchmark|legacy))?\s*/i, ""));
  return taskTitle ? renameChat(chatId, taskTitle) : chat;
}
