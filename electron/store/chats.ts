import { stableScienceRuntimeChatId } from "../runtime/science-transport-identity";
import { SCIENCE_SURFACE_PACK, tagSurfacePackChatsInDb } from "./surface-conversation-schema";
// Chat CRUD + chat_messages.
// 사이드바 "최근 채팅" 섹션은 listRecent로 채운다.
// 프로젝트 페이지는 listByProject로, 회사 페이지는 listByFirm으로 채운다.
import { createHash, randomUUID } from "node:crypto";
import { AGI_ACTION_NOTICE_AUTOMATION_ID, normalizeChatHostNotice, parseChatHostNotice } from "../../shared/chat-host-notice";
import { invocationFailureNoticeStatuses } from "./run-events";
import { RUNTIME_KINDS } from "../../shared/runtime-kinds";
import { RUNTIME_BACKENDS } from "../../shared/runtime-backends";
import { getDb } from "./db";
import { isStoreBusyError, runWithStoreBusyRetry } from "./store-busy-retry";
import { takePreparedUserRow } from "./prepared-user-rows";
import { oneDispatchSidebarPredicate, createOneDispatchNoticeProjector } from "../one/dispatch-presentation";
import { personalAgentRoomIdsAmong } from "../one/personal-agent-rooms";
import { getChatGoalRevision } from "./chat-goals";
import { parseGoalResult, type GoalResultPresentation } from "../../shared/goal-result";
import { repairAskOpenMarkers } from "../../shared/agent-control-blocks";
import { emitDesktopStoreChange, emitTaskStoreChange } from "./change-bus";
import { getFirm } from "./firms";
import { evictRuntimeSessionsForChat, recordRuntimeSessionsCleared } from "./runtime-sessions";
import { inheritWorkingSessionScope, bindManagedWorkingSessionScope, bindWorkingSessionScope, workingSessionScope, type WorkingSessionScope } from "../runtime/session-scope";
import { getProject, touchProject } from "./projects";
import {
  listChatMessageImageUrls,
  persistChatMessageImages,
} from "./chat-message-attachments";
import type {
  Chat,
  ChatHistoryEntry,
  ChatHostNotice,
  ImageAttachment,
  RuntimeBackend,
  RuntimeKind,
  RuntimeSelection,
} from "../../shared/types";
import { currentUiLocale } from "../ui-locale";
import { applySeatSnapshotToChats, ensureSoloSeatForAgent } from "./seats";
import {
  ensureCanonicalTaskForChat,
  existingCanonicalTaskIdsForChats,
  findCanonicalTaskForChat,
  removeCanonicalTaskForOriginChat,
} from "./tasks";

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
  continuous_mode: number | null;
  swarm_mode: number | null;
  goal_id: string | null;
  origin_surface: string | null;
  runtime_selection_json: string | null;
  seat_id: string | null;
  seat_label: string | null;
  seat_kind: string | null;
  participants_json: string | null;
  last_message_preview?: string | null;
  last_activity_at?: string | null;
  surface_pack?: string | null;
}

const CHAT_RUNTIME_KINDS = new Set<RuntimeKind>(RUNTIME_KINDS);

const CHAT_RUNTIME_BACKENDS = new Set<RuntimeBackend>(RUNTIME_BACKENDS);
const CHAT_UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

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

/** Canonical chat pin contract; automation transcripts adapt their worker pin here. */
export function normalizeChatRuntimeSelection(value: unknown): RuntimeSelection | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid chat runtime selection");
  }
  const input = value as Record<string, unknown>;
  const legacyGemini = input.kind === "gemini";
  const normalizedKind = legacyGemini ? "antigravity" : input.kind;
  if (typeof normalizedKind !== "string" || !CHAT_RUNTIME_KINDS.has(normalizedKind as RuntimeKind)) {
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
  const acpAgentId = legacyGemini ? undefined : boundedOptionalText(input.acpAgentId, "acpAgentId", 256);
  if (normalizedKind === "acp" && !acpAgentId) {
    throw new TypeError("An ACP chat runtime pin requires acpAgentId");
  }
  if (normalizedKind !== "acp" && acpAgentId !== undefined) {
    throw new TypeError("Only an ACP chat runtime pin can include acpAgentId");
  }
  return {
    kind: normalizedKind as RuntimeKind,
    backend: input.backend as RuntimeBackend | undefined,
    source: legacyGemini ? undefined : boundedOptionalText(input.source, "source", 2_048),
    acpAgentId,
    label: legacyGemini ? undefined : boundedOptionalText(input.label, "label", 256),
    model: legacyGemini ? undefined : boundedOptionalText(input.model, "model", 512),
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

/** Rooms the personal agent runs (one/personal-agent-rooms.ts); a store without that table has none. */
function personalAgentRooms(chatIds: readonly string[]): Set<string> {
  try { return personalAgentRoomIdsAmong(chatIds, getDb()); } catch { return new Set(); }
}

function toChat(row: ChatRow, resolvedTaskId?: string | null, supervisedRooms?: ReadonlySet<string>): Chat {
  // A general One conversation deliberately has no Task until execution
  // signals promote it. Existing Work/Task chats are reconciled on read.
  const taskId = resolvedTaskId !== undefined ? resolvedTaskId
    : existingCanonicalTaskIdsForChats([row.id]).get(row.id) ?? null;
  return {
    id: row.id,
    ...(taskId ? { taskId } : {}),
    projectId: row.project_id,
    firmId: row.firm_id,
    agentId: row.agent_id,
    title: row.title,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_message_preview?.trim()
      ? { lastMessagePreview: row.last_message_preview.replace(/\s+/g, " ").trim().slice(0, 160) }
      : {}),
    ...(row.last_activity_at ? { lastActivityAt: row.last_activity_at } : {}),
    kind: row.kind === "division" ? "division" : "user",
    continuousMode: row.continuous_mode === 1,
    swarmMode: row.swarm_mode === 1,
    goalId: row.goal_id ?? null,
    originSurface: row.origin_surface === "one" ? "one" : "work",
    runtimeSelection: parseChatRuntimeSelection(row.runtime_selection_json),
    // 좌석 상호참조 + 표시 스냅샷(I2) — 좌석이 소멸해도 이 칸만으로 렌더된다.
    seatId: row.seat_id ?? null,
    seatLabel: row.seat_label ?? null,
    seatKind: row.seat_kind === "solo" || row.seat_kind === "group" ? row.seat_kind : null,
    participants: parseChatParticipants(row.participants_json),
    ...(row.surface_pack ? { surfacePack: row.surface_pack } : {}),
    ...((supervisedRooms ?? personalAgentRooms([row.id])).has(row.id) ? { supervisedByPersonalAgent: true as const } : {}),
  };
}

function toChats(rows: ChatRow[]): Chat[] {
  const taskIds = existingCanonicalTaskIdsForChats(rows.map(row => row.id));
  const supervised = personalAgentRooms(rows.map(row => row.id));
  return rows.map(row => toChat(row, taskIds.get(row.id) ?? null, supervised));
}

function parseChatParticipants(raw: string | null): Chat["participants"] {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const rows = parsed.filter(
      (entry): entry is { slot: number; agentId: string | null; displayName: string } =>
        !!entry && typeof entry === "object"
        && Number.isInteger((entry as { slot?: unknown }).slot)
        && typeof (entry as { displayName?: unknown }).displayName === "string",
    );
    return rows.length > 0 ? rows.map((row) => ({
      slot: row.slot,
      agentId: typeof row.agentId === "string" ? row.agentId : null,
      displayName: row.displayName,
    })) : null;
  } catch {
    return null;
  }
}

/** 사이드바용 — 활성 사용자 채팅만 (보관·숨김 본부 세션 제외) */
export function listRecentChats(limit = 50): Chat[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM chats
       WHERE archived_at IS NULL
         AND kind = 'user'
         AND used_at IS NOT NULL
         ${oneDispatchSidebarPredicate()}
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as ChatRow[];
  return toChats(rows);
}

/**
 * One 표면이 시작한 대화만, One 자신의 창으로 읽는다.
 *
 * ★ 왜 따로 있나. One 화면은 `listRecentChats(40)` 로 **전체** 최근 40개를 받아 그중
 * origin_surface === "one" 인 것만 걸러 그렸다. Work 를 활발히 쓰는 사람은 그 40칸이
 * Work 대화로 다 차서, 멀쩡히 살아 있는 One 대화가 화면에서 사라진다 — 지워진 것처럼
 * 보이지만 행은 그대로 있다. 이 기계에서 재보니 One 대화 20개 중 10개만 그 창에
 * 들어왔다. Work 를 더 쓸수록 0 에 가까워진다.
 *
 * 거르는 일을 데이터베이스에 시키면 창이 One 것만으로 채워지므로, Work 사용량이
 * One 의 기억을 밀어내지 못한다.
 */
export function listRecentOneChats(limit = 50): Chat[] {
  const rows = getDb()
    .prepare(
      `SELECT chats.*,
         (SELECT text FROM chat_messages
           WHERE chat_messages.chat_id = chats.id
             AND chat_messages.role IN ('user', 'assistant')
           ORDER BY chat_messages.created_at DESC, chat_messages.rowid DESC
           LIMIT 1) AS last_message_preview,
         /*
          * 세션 목록의 "최근" 은 화면에 보이는 줄이 마지막으로 생긴 시각이다(오너 2026-09-28
          * "최근 대화가 가장 위로"). updated_at 은 모델 선택·목표 결속·연속 모드 같은 조용한
          * 상태 변경에도 움직여서, 새 줄 없이 방이 맨 위로 튀었다. 보이는 줄 = 사용자/에이전트
          * 말 + 구조적 표식이 있는 시스템 줄(자동화 보고 등). 표식 없는 시스템 줄은 One 화면이
          * 숨기므로 세지 않는다.
          */
         (SELECT created_at FROM chat_messages
           WHERE chat_messages.chat_id = chats.id
             AND (chat_messages.role IN ('user', 'assistant') OR chat_messages.host_notice_json IS NOT NULL)
           ORDER BY chat_messages.created_at DESC
           LIMIT 1) AS last_activity_at
       FROM chats
       WHERE archived_at IS NULL
         AND kind = 'user'
         AND used_at IS NOT NULL
         AND origin_surface = 'one'
         ${oneDispatchSidebarPredicate()}
         ${personalSupervisorConversationPredicate()}
       ORDER BY COALESCE(last_activity_at, updated_at) DESC
       LIMIT ?`,
    )
    .all(limit) as ChatRow[];
  return toChats(rows);
}

/**
 * The personal One's own conversation (one_supervisor_conversations, the supervisor binding) is not a One home session
 * (owner 2026-10-16: "supervisor one은 따로 one 세션에 표기하지마"). It opens from the personal One entry; work it hands
 * off runs in a task chat of its own, which stays listed. Decided by the binding row only, never by title or text.
 */
/** Whether this chat is the personal One's own conversation, by the same binding row as the One session list. */
export function isPersonalSupervisorConversation(chatId: string): boolean {
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='one_supervisor_conversations'").get()) return false;
  return Boolean(db.prepare("SELECT 1 FROM one_supervisor_conversations WHERE chat_id = ? LIMIT 1").get(chatId));
}

function personalSupervisorConversationPredicate(): string {
  return getDb().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='one_supervisor_conversations'").get()
    ? "AND NOT EXISTS (SELECT 1 FROM one_supervisor_conversations p WHERE p.chat_id = chats.id)" : "";
}

export function listArchivedChats(): Chat[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM chats WHERE archived_at IS NOT NULL ORDER BY archived_at DESC",
    )
    .all() as ChatRow[];
  return toChats(rows);
}

export function listChatsByProject(projectId: string): Chat[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM chats
       WHERE project_id = ?
         AND kind = 'user'
         AND used_at IS NOT NULL
         ${oneDispatchSidebarPredicate()}
       ORDER BY updated_at DESC`,
    )
    .all(projectId) as ChatRow[];
  return toChats(rows);
}

export function listChatsByFirm(firmId: string): Chat[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM chats
       WHERE firm_id = ?
         AND kind = 'user'
         AND used_at IS NOT NULL
         ${oneDispatchSidebarPredicate()}
       ORDER BY updated_at DESC`,
    )
    .all(firmId) as ChatRow[];
  return toChats(rows);
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

function isOneOrgMemberAgentId(agentId: string | null | undefined): boolean {
  if (!agentId) return false;
  const row = getDb()
    .prepare("SELECT 1 FROM one_org_members WHERE installed_agent_id = ? LIMIT 1")
    .get(agentId) as { 1?: number } | undefined;
  return Boolean(row);
}

/**
 * Repair legacy root chats whose controller came from the other surface or a
 * reusable project tool. One is an owner-bound personal surface; project work
 * is controlled by the built-in project orchestrator.
 *
 * This invocation-time guard complements the schema migration so an already
 * open app cannot start another cross-surface turn before its next restart.
 * Rebinding also evicts the old provider session so neither surface can resume
 * a prompt/session created under the other controller identity.
 */
export function repairRootChatSurfaceController(chat: Chat): Chat {
  if (chat.kind === "division") return chat;
  const db = getDb();
  // A named One teammate owns a durable direct conversation. These chats are
  // still part of the One surface, but their controller is the installed
  // teammate rather than the CEO root. Archived organisation seats remain
  // valid so an old channel never silently changes identity after relaunch.
  if (chat.originSurface === "one" && !chat.firmId && isOneOrgMemberAgentId(chat.agentId)) {
    return chat;
  }
  const current = db
    .prepare("SELECT slug FROM installed_agents WHERE id = ?")
    .get(chat.agentId) as { slug?: string } | undefined;
  const expectedSlug = chat.originSurface === "one"
    ? "agentlas-one"
    : chat.originSurface === "work" && chat.projectId
      ? "agentlas-orchestrator"
      : null;
  if (!expectedSlug || (current?.slug === expectedSlug && !chat.firmId)) return chat;
  const controller = db
    .prepare("SELECT id FROM installed_agents WHERE slug = ? LIMIT 1")
    .get(expectedSlug) as { id?: string } | undefined;
  if (!controller?.id) return chat;
  const changed = db.transaction(() => {
    const result = db
      .prepare(`UPDATE chats
                   SET agent_id = ?, firm_id = NULL
                 WHERE id = ? AND agent_id = ?`)
      .run(controller.id, chat.id, chat.agentId);
    if (result.changes > 0) {
      // Same transaction as the delete: another conversation's older pointer of a shared journal must not come back (runtime-sessions.ts).
      recordRuntimeSessionsCleared(db, chat.id);
      db.prepare("DELETE FROM chat_runtime_sessions WHERE chat_id = ?").run(chat.id);
    }
    return result.changes;
  })();
  if (changed === 0) return getChat(chat.id) ?? chat;
  evictRuntimeSessionsForChat(chat.id);
  emitDesktopStoreChange({ entity: "chat", id: chat.id });
  return getChat(chat.id) ?? chat;
}

/** @deprecated Use the two-way surface repair; kept for packaged callers/tests. */
export function repairWorkProjectChatController(chat: Chat): Chat {
  return repairRootChatSurfaceController(chat);
}

export function repairAllRootChatSurfaceControllers(): number {
  const rows = getDb()
    .prepare(`SELECT * FROM chats
               WHERE COALESCE(kind, 'user') = 'user'
                 AND (origin_surface = 'one' OR (origin_surface = 'work' AND project_id IS NOT NULL))`)
    .all() as ChatRow[];
  let repaired = 0;
  for (const row of rows) {
    const before = toChat(row);
    const after = repairRootChatSurfaceController(before);
    if (after.agentId !== before.agentId || after.firmId !== before.firmId) repaired += 1;
  }
  return repaired;
}

function defaultRootAgentId(originSurface: "one" | "work"): string | undefined {
  const slug = originSurface === "one" ? "agentlas-one" : "agentlas-orchestrator";
  return (getDb()
    .prepare("SELECT id FROM installed_agents WHERE slug = ? LIMIT 1")
    .get(slug) as { id?: string } | undefined)?.id;
}

export function createChat(input: {
  /** Main-only stable id for an external-surface binding. Never deserialize from renderer IPC. */
  internalId?: string;
  agentId?: string;
  firmId?: string | null;
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
  // Explicit New and its durable isolation marker must commit together.
  const db = getDb();
  if (input.originSurface !== "one" && input.projectId && input.continueFromChatId
    && input.kind !== "division" && !db.inTransaction) {
    return db.transaction(() => createChat(input)).immediate();
  }
  const ko = currentUiLocale() === "ko";
  const originSurface = input.originSurface === "one" ? "one" : "work";
  let resolvedAgentId = input.agentId;
  const resolvedFirmId = input.kind !== "division" && originSurface === "work" && input.projectId
    ? null
    : input.firmId ?? null;
  // Root surfaces own their controller identity. The one exception is an
  // explicit durable One teammate channel: the organisation binding is the
  // Main-owned authority that allows that installed agent to own the chat.
  if (input.kind !== "division" && (originSurface === "one" || input.projectId)) {
    const keepOneMember = originSurface === "one" && isOneOrgMemberAgentId(resolvedAgentId);
    if (!keepOneMember) resolvedAgentId = defaultRootAgentId(originSurface) ?? resolvedAgentId;
  }
  if (resolvedFirmId && !resolvedAgentId) {
    const firm = getFirm(resolvedFirmId);
    if (!firm) throw new Error(ko ? `회사 ${resolvedFirmId}을 찾을 수 없습니다` : `Could not find firm ${resolvedFirmId}`);
    resolvedAgentId = firm.ceoAgentId;
  }
  if (!resolvedAgentId) {
    resolvedAgentId = defaultRootAgentId(originSurface);
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

  const id = input.internalId === undefined ? randomUUID() : input.internalId;
  if (!CHAT_UUID_RE.test(id)) throw new Error("Invalid internal chat id");
  const now = new Date().toISOString();
  // 좌석 부여 — 새 세션은 태어날 때 좌석을 참조한다(SEAT-SESSION-PLAN-v2 §6-1,
  // 스펙 §3 ①-2′ "좌석 원장 동결" 해소). 하위 실행 세션(division)은 뿌리의 좌석을
  // 물려받고, 그 외에는 담당 봇의 solo 좌석을 확보한다(없으면 만든다). 단톡 대화는
  // 생성 직후 taskforces.ts 가 group 좌석으로 재배정한다.
  let seatId: string | null = null;
  try {
    if (input.kind === "division" && input.parentChatId) {
      const parent = getDb()
        .prepare("SELECT seat_id AS seatId FROM chats WHERE id = ?")
        .get(input.parentChatId) as { seatId: string | null } | undefined;
      seatId = parent?.seatId ?? null;
    }
    if (!seatId) {
      seatId = ensureSoloSeatForAgent(
        resolvedAgentId,
        originSurface === "work" ? input.projectId ?? null : null,
      );
    }
  } catch {
    // 좌석 확보 실패가 대화 생성을 막아서는 안 된다 — seat_id NULL 은 유효한 세션이고
    // v103 재시딩이 다음 기동에서 흡수한다(I2: NULL 허용이 계약).
    seatId = null;
  }
  // title은 빈 문자열로 저장 — UI 표시 시 locale에 따라 "새 채팅" / "New chat"으로 표시.
  // 첫 user 메시지 도착 시 autoTitleFromFirstMessage가 채움.
  getDb()
    .prepare(
      `INSERT INTO chats (id, project_id, firm_id, agent_id, title, kind, parent_chat_id, working_folder, created_at, updated_at, origin_surface, seat_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.projectId ?? null,
      resolvedFirmId,
      resolvedAgentId,
      input.title?.trim() ?? "",
      input.kind ?? "user",
      input.parentChatId ?? null,
      continuedWorkingFolder,
      now,
      now,
      originSurface,
      seatId,
    );
  // 표시 스냅샷은 쓰는 시점에 기록한다(I9) — 좌석이 소멸해도 세션이 스스로를 설명한다.
  if (seatId) {
    try { applySeatSnapshotToChats(seatId); } catch { /* 스냅샷 실패는 렌더 폴백(파생)으로 흡수 */ }
  }
  if (input.projectId) touchProject(input.projectId);
  // One always starts as a conversation. Its invocation/preflight authority
  // may promote it after a typed task verdict; chat creation itself must never
  // make a One turn appear under Work. Legacy Work callers keep their Task
  // default unless they explicitly request conversation mode.
  const shouldCreateTask = originSurface === "work" && input.taskMode !== "conversation";
  if (shouldCreateTask) ensureCanonicalTaskForChat(id);
  // A future explicit New keeps a durable range, rather than an unstored UI hint.
  if (originSurface === "work" && input.projectId && input.continueFromChatId && input.kind !== "division" && getProject(input.projectId)) {
    bindManagedWorkingSessionScope(getDb(), id, { projectId: input.projectId, rootChatId: id, subSessionId: null }, {kind:"desktop-project"});
  }
  const chat = getChat(id) as Chat;
  emitDesktopStoreChange({ entity: "chat", id });
  return chat;
}

/** Host-owned project-work entry. Generic chats:create/new-context does not expose scope metadata. */
export function createProjectWorkChat(input: { projectId: string; title?: string; agentId?: string }): Chat {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !["projectId", "title", "agentId"].includes(key))
    || typeof input.projectId !== "string"
    || (input.title !== undefined && typeof input.title !== "string")
    || (input.agentId !== undefined && typeof input.agentId !== "string")) throw new Error("work_project_session_input_invalid");
  const project = getProject(input.projectId);
  if (!project) throw new Error("work_project_session_project_unavailable");
  return getDb().transaction(() => {
    const chat = createChat({ projectId: project.id, title: input.title, agentId: input.agentId,
      taskMode: "task", originSurface: "work" });
    bindManagedWorkingSessionScope(getDb(), chat.id, { projectId: project.id, rootChatId: chat.id, subSessionId: null }, {kind:"desktop-project"});
    return chat;
  }).immediate();
}

/** Persistent dispatch identity remains local to its actual registered parent. */
function inheritWorkingDispatchScope(chat: Chat, parent: Chat | null): Chat {
  if(parent)inheritWorkingSessionScope(getDb(),chat.id,parent.id);
  return chat;
}



/**
 * Main-only deterministic hidden chat for one Science conversation.
 *
 * The derived UUID closes the cross-database crash window: if Desktop creates
 * the chat and exits before Science records its binding, the next attempt finds
 * the exact same row rather than creating an orphaned second runtime session.
 */
export function ensureScienceRuntimeChat(input: {
  conversationId: string;
  title: string;
  workingScope?: WorkingSessionScope;
}): Chat {
  const chatId = stableScienceRuntimeChatId(input.conversationId);
  const marker = `⟦science⟧${input.conversationId}`;
  const existing = getChat(chatId);
  if (existing) {
    if (existing.kind !== "division" || existing.originSurface !== "work" || existing.title !== marker
      || (existing.surfacePack !== undefined && existing.surfacePack !== SCIENCE_SURFACE_PACK)) {
      throw new Error("Science runtime chat binding conflict");
    }
    // PLAN S6: the chat is the conversation's common record; its pack names the screen that shows it (Work lists only `user` chats).
    if (existing.surfacePack === undefined) tagSurfacePackChatsInDb(getDb());
    if (input.workingScope) {
      bindManagedWorkingSessionScope(getDb(), existing.id, input.workingScope, {kind:"external-logical",logicalId:input.conversationId});
      ensureCanonicalTaskForChat(existing.id);
    }
    return existing;
  }
  const chat = createChat({
    internalId: chatId,
    projectId: null,
    firmId: null,
    title: marker,
    kind: "division",
    taskMode: "conversation",
    originSurface: "work",
  });
  if (chat.id !== chatId || chat.kind !== "division" || chat.title !== marker) {
    throw new Error("Science runtime chat create receipt mismatch");
  }
  tagSurfacePackChatsInDb(getDb());
  if (input.workingScope) {
    bindManagedWorkingSessionScope(getDb(), chat.id, input.workingScope, {kind:"external-logical",logicalId:input.conversationId});
    ensureCanonicalTaskForChat(chat.id);
  }
  return chat;
}

const PROMPT_CHAT_INTENT_RE = /^prompt_start_[A-Za-z0-9_-]{24,120}$/u;

function exactPromptStartChat(chat: Chat | null): chat is Chat {
  return Boolean(chat
    && chat.id
    && chat.originSurface === "one"
    && chat.kind === "user"
    && chat.projectId === null
    && chat.firmId === null
    && chat.archivedAt === null
    && !chat.taskId);
}

export interface PromptChatStartReceipt {
  ok: true;
  receiptVersion: 1;
  status: "created" | "replayed";
  intentId: string;
  promptDigest: string;
  seedOnly: boolean;
  chat: Chat;
}

/**
 * Create or replay the exact One chat bound to a Prompt Store start action.
 * The intent row and chat are committed in one IMMEDIATE transaction, so an
 * ipcRenderer response loss cannot turn a user retry into a duplicate chat.
 */
export function createOrReplayPromptChat(input: {
  intentId: string;
  body: string;
  seedOnly?: boolean;
}): PromptChatStartReceipt {
  const intentId = typeof input?.intentId === "string" ? input.intentId.trim() : "";
  const body = typeof input?.body === "string" ? input.body : "";
  const seedOnly = input?.seedOnly === true;
  if (!PROMPT_CHAT_INTENT_RE.test(intentId)) throw new TypeError("invalid prompt chat intent");
  if (!body.trim() || body.length > 250_000 || body.includes("\u0000")) {
    throw new TypeError("invalid prompt chat body");
  }
  const promptDigest = `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
  const db = getDb();
  const run = db.transaction((): PromptChatStartReceipt => {
    const existing = db.prepare(
      `SELECT intent_id, chat_id, prompt_digest, seed_only
         FROM prompt_chat_start_intents
        WHERE intent_id = ?`,
    ).get(intentId) as {
      intent_id: string;
      chat_id: string;
      prompt_digest: string;
      seed_only: number;
    } | undefined;
    if (existing) {
      if (existing.prompt_digest !== promptDigest || existing.seed_only !== (seedOnly ? 1 : 0)) {
        throw new Error("prompt chat intent payload conflict");
      }
      const chat = getChat(existing.chat_id);
      if (!exactPromptStartChat(chat)) throw new Error("prompt chat recovery target is unavailable");
      return {
        ok: true,
        receiptVersion: 1,
        status: "replayed",
        intentId,
        promptDigest,
        seedOnly,
        chat,
      };
    }

    const chat = createChat({
      projectId: null,
      firmId: null,
      title: "",
      taskMode: "conversation",
      originSurface: "one",
    });
    if (!exactPromptStartChat(chat)) throw new Error("prompt chat create receipt mismatch");
    db.prepare(
      `INSERT INTO prompt_chat_start_intents
        (intent_id, chat_id, prompt_digest, seed_only, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(intentId, chat.id, promptDigest, seedOnly ? 1 : 0, new Date().toISOString());
    return {
      ok: true,
      receiptVersion: 1,
      status: "created",
      intentId,
      promptDigest,
      seedOnly,
      chat,
    };
  });
  return run.immediate();
}

/**
 * Resolve the canonical direct channel for one standing One teammate.
 *
 * Empty chats are intentionally included: listRecentChats hides them until a
 * first message sets used_at, but clicking the teammate again must reopen the
 * same channel instead of manufacturing another invisible session.
 */
export function getOrCreateOneMemberChat(agentId: string, title: string): Chat {
  const ko = currentUiLocale() === "ko";
  if (!isOneOrgMemberAgentId(agentId)) {
    throw new Error(ko ? "One 조직에 없는 에이전트입니다" : "This agent is not a member of the One organisation");
  }
  const existing = getDb()
    .prepare(
      `SELECT * FROM chats
       WHERE origin_surface = 'one'
         AND kind = 'user'
         AND archived_at IS NULL
         AND agent_id = ?
         ${oneDispatchSidebarPredicate()}
       ORDER BY (used_at IS NOT NULL) DESC, updated_at DESC
       LIMIT 1`,
    )
    // A conversation that was actually used wins over a newer empty "새 세션" chat:
    // clicking "new session" twice must not hide the real latest conversation (pre-mortem 2026-09-26).
    .get(agentId) as ChatRow | undefined;
  if (existing) return toChat(existing);
  return createChat({
    agentId,
    title: title.trim(),
    originSurface: "one",
    taskMode: "conversation",
  });
}

/**
 * "새 세션" for a teammate: reuse that teammate's still-empty One chat (never
 * used, no messages, not a session One opened for a delegation) instead of
 * making another. Clicking "new session" repeatedly used to stack empty chats
 * that then hid the real conversation (EDGE-CASES U1 / X1).
 */
export function getOrCreateEmptyOneMemberChat(agentId: string, title: string): Chat {
  const ko = currentUiLocale() === "ko";
  if (!isOneOrgMemberAgentId(agentId)) {
    throw new Error(ko ? "One 조직에 없는 에이전트입니다" : "This agent is not a member of the One organisation");
  }
  const db = getDb();
  const dispatchTable = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'one_team_dispatches'").get());
  const empty = db
    .prepare(
      `SELECT c.* FROM chats c
       WHERE c.origin_surface = 'one'
         AND c.kind = 'user'
         AND c.archived_at IS NULL
         AND c.agent_id = ?
         AND c.used_at IS NULL
         AND c.parent_chat_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.chat_id = c.id)
         ${dispatchTable ? "AND NOT EXISTS (SELECT 1 FROM one_team_dispatches d WHERE d.child_chat_id = c.id)" : ""}
       ORDER BY c.updated_at DESC
       LIMIT 1`,
    )
    .get(agentId) as ChatRow | undefined;
  if (empty) return toChat(empty);
  return createChat({
    agentId,
    title: title.trim(),
    originSurface: "one",
    taskMode: "conversation",
  });
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
  const parent = getChat(parentChatId);
  if (existing) return inheritWorkingDispatchScope(toChat(existing), parent);
  return inheritWorkingDispatchScope(createChat({
    agentId: fkAgentId,
    firmId: parent?.firmId ?? null,
    projectId: parent?.projectId ?? null,
    title: marker,
    kind: "division",
    parentChatId,
  }), parent);
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
  const parent = getChat(parentChatId);
  if (existing) return inheritWorkingDispatchScope(toChat(existing), parent);
  return inheritWorkingDispatchScope(createChat({
    agentId: ceoAgentId,
    firmId,
    projectId: parent?.projectId ?? null,
    title: marker,
    kind: "division",
    parentChatId,
  }), parent);
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

export function renameChat(id: string, title: string): Chat {
  // 빈 문자열 허용 — UI는 fallback 라벨 표시
  const db = getDb();
  const nextTitle = title.trim();
  const updatedAt = new Date().toISOString();
  // A Work task and its root chat are the same user-facing object. Updating
  // only chats left project sidebars and dashboard cards stuck on "New task".
  db.transaction(() => {
    db.prepare("UPDATE chats SET title = ?, updated_at = ? WHERE id = ?")
      .run(nextTitle, updatedAt, id);
    // A title is presentation metadata, not a lifecycle transition. Keeping
    // the Task timestamp stable preserves the exact result-ready version that
    // explicit acceptance binds to after a run finishes.
    db.prepare("UPDATE tasks SET title = ? WHERE origin_chat_id = ?")
      .run(nextTitle, id);
  })();
  const chat = getChat(id) as Chat;
  emitDesktopStoreChange({ entity: "chat", id });
  emitTaskStoreChange(getDb(), `task_${id}`);
  return chat;
}

export function archiveChat(id: string): Chat {
  getDb()
    .prepare("UPDATE chats SET archived_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
  // 아카이브는 쓰기 시점에 태스크 원장으로 전파한다. 읽기측 스윕은 스로틀되어
  // 있으므로 여기서 미루면 태스크 목록이 최대 스윕 간격만큼 낡는다.
  const task = findCanonicalTaskForChat(id);
  if (task) {
    ensureCanonicalTaskForChat(id);
    emitTaskStoreChange(getDb(), task.id);
  }
  const chat = getChat(id) as Chat;
  emitDesktopStoreChange({ entity: "chat", id });
  return chat;
}

export function unarchiveChat(id: string): Chat {
  getDb()
    .prepare("UPDATE chats SET archived_at = NULL, updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
  const task = findCanonicalTaskForChat(id);
  if (task) {
    ensureCanonicalTaskForChat(id);
    emitTaskStoreChange(getDb(), task.id);
  }
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

/** persistent goal 바인딩 — 칩 ON 시 goal_ledger 축(goal_id)을 이 채팅에 고정한다.
 *  null = 목표 추진 꺼짐(명시적 종료 뒤). 한 번 켠 목표의 축은 대화가 Task로 승격돼도
 *  변하지 않는다 — 파생 대신 저장이 축을 지킨다. */
export function setChatGoalBinding(chatId: string, goalId: string | null): void {
  getDb()
    .prepare("UPDATE chats SET goal_id = ?, updated_at = ? WHERE id = ?")
    .run(goalId, new Date().toISOString(), chatId);
  emitDesktopStoreChange({ entity: "chat", id: chatId });
}

/** goal 축으로 바인딩 해제 — 목표가 완료/종료되면 그 goal_id를 문 채팅의 칩을
 *  정직하게 끈다. 프롬프트 문자열 파싱 없이 축으로만 찾는다. */
export function clearChatGoalBindingByGoalId(goalId: string): number {
  if (!goalId.trim()) return 0;
  const now = new Date().toISOString();
  const result = getDb()
    .prepare("UPDATE chats SET goal_id = NULL, continuous_mode = 0, updated_at = ? WHERE goal_id = ?")
    .run(now, goalId);
  if (result.changes > 0) emitDesktopStoreChange({ entity: "chat" });
  return result.changes;
}

/** 가벼운 goal 축 판독 — toChat(Task 재조정) 없이 goal_id만 읽는다(핫패스: 실행 루프). */
export function getChatGoalId(chatId: string): string | null {
  const row = getDb()
    .prepare("SELECT goal_id AS gid FROM chats WHERE id = ?")
    .get(chatId) as { gid: string | null } | undefined;
  return row?.gid ?? null;
}

/** 스웜 모드 — 켜면 이 채팅이 목표를 작업 그래프로 분해해 여러 워커가 병렬 협업한다(runSwarmInvocation). */
export function setChatSwarmMode(chatId: string, enabled: boolean): void {
  getDb()
    .prepare("UPDATE chats SET swarm_mode = ?, updated_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, new Date().toISOString(), chatId);
  emitDesktopStoreChange({ entity: "chat", id: chatId });
}

/**
 * Who changed a chat's model chip. 2026-10-17: the production Yotube room's chip moved from codex gpt-6.1-sol xhigh to
 * claude-code sonnet low between 00:25Z and 01:05Z, and nothing recorded who did it (the release peer read every log).
 */
export type ChatRuntimeSelectionActor =
  | "desktop-ui" | "mobile" | "work-start" | "external-cli-import" | "science" | "runtime-handoff" | "host";

/** Exact chat-scoped orchestrator pin. It never mutates the role defaults. */
export function setChatRuntimeSelection(
  chatId: string,
  selection: RuntimeSelection | null,
  actor: ChatRuntimeSelectionActor = "host",
): Chat {
  const normalized = normalizeChatRuntimeSelection(selection);
  const before = (getDb().prepare("SELECT runtime_selection_json AS v FROM chats WHERE id = ?").get(chatId) as { v: string | null } | undefined)?.v ?? null;
  const after = normalized ? JSON.stringify(normalized) : null;
  if (before !== after) {
    // One typed line per change (no prompt or secret is in a selection): actor, previous and next chip.
    console.info("[chat-runtime-selection]", JSON.stringify({ schemaVersion: "agentlas.chat-runtime-selection-change.v1",
      chatId, actor, at: new Date().toISOString(), previous: before ? JSON.parse(before) : null, next: normalized ?? null }));
  }
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

// ── chat_messages ───────────────────────────────────────────
interface MessageRow {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  created_at: string;
  host_notice_json?: string | null;
  speaker_agent_id?: string | null;
}

// Builds before v0.9.36 accidentally persisted the CEO's private synthesis
// packet as a second user turn. The current invocation path records
// product-authored continuations as system turns, but upgraded profiles may
// still contain these exact legacy packets. Keep the raw row recoverable in
// SQLite while excluding it from every transcript/model-history consumer that
// uses listChatMessages: it was never written by the person and the following
// assistant turn already contains the user-facing synthesis.
const LEGACY_FIRM_SYNTHESIS_MARKER =
  "[Results from your team — synthesize into one final answer for the user]";

/** Local host outbox only: the caller owns the transaction and emits after commit. */
export function insertHostNoticeInTransaction(input: { id: string; chatId: string; text: string; hostNotice: ChatHostNotice; createdAt: string }): void {
  const db = getDb();
  if (!db.inTransaction) throw new Error("host_notice_transaction_required");
  if (!getChat(input.chatId)) throw new Error("host_notice_chat_missing");
  db.prepare("INSERT INTO chat_messages (id,chat_id,role,text,created_at,host_notice_json) VALUES (?,?,'assistant',?,?,?)")
    .run(input.id, input.chatId, input.text, input.createdAt, JSON.stringify(input.hostNotice));
  db.prepare("UPDATE chats SET updated_at=?,used_at=COALESCE(used_at,?) WHERE id=?").run(input.createdAt, input.createdAt, input.chatId);
}

/** Notification failure cannot undo a committed host notice or repeat its work. */
export function emitHostNoticeCommitted(chatId: string): void {
  if (getDb().inTransaction) throw new Error("host_notice_commit_required");
  const chat = getChat(chatId);
  if (chat?.projectId) touchProject(chat.projectId);
  emitDesktopStoreChange({ entity: "chat", id: chatId });
}

export function appendChatMessage(
  chatId: string,
  role: "user" | "assistant" | "system",
  rawText: string,
  options?: ChatMessageAppendOptions,
): ChatHistoryEntry {
  // A mistyped ask open marker is repaired once, here, so the inbox query, mobile and every surface read one shape.
  const text = role === "assistant" ? repairAskOpenMarkers(rawText) : rawText;
  // The send queue saved this message when it was accepted; the run that finally starts it must not add a second bubble.
  if (role === "user") {
    const prepared = takePreparedUserRow<ChatHistoryEntry>(chatId, text);
    if (prepared) return prepared;
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const db = getDb();
  const hostNotice = normalizeChatHostNotice(role, options?.hostNotice);
  const requestedSpeakerId = options?.speakerAgentId?.trim();
  const speakerAgentId = role === "assistant" && requestedSpeakerId
    && requestedSpeakerId.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(requestedSpeakerId)
    ? requestedSpeakerId
    : null;
  // 앱이 쓴 안내(hostNotice 를 요청한 줄)는 작업 보고가 아니다. assistant 역할이면 안내 칸은 저장되지
  // 않지만, 여기서 "검증 전" 표를 달면 결속될 실행이 없어 영원히 대기로 남는다
  // (오너 녹화 2026-09-26: 목표 대화의 안내 말풍선마다 "Verification pending").
  const goalId = role === "assistant" && !options?.hostNotice && !options?.noGoalResult ? getChat(chatId)?.goalId : null;
  const goalResult: GoalResultPresentation | undefined = goalId ? { goalId, runId: null, status: "pending" } : undefined;
  let persistedImageUrls: string[] | undefined;
  const write = db.transaction(() => {
    db.prepare(
      "INSERT INTO chat_messages (id, chat_id, role, text, created_at, host_notice_json, speaker_agent_id, row_scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, chatId, role, text, now, hostNotice ? JSON.stringify(hostNotice) : null, speakerAgentId,
      options?.rowScope === "runtime-input" && role !== "assistant" ? "runtime-input" : null);
    if (goalResult) persistGoalResult(chatId, id, goalResult);
    if (options?.images?.length) {
      const persisted = persistChatMessageImages({ messageId: id, chatId, images: options.images, createdAt: now });
      persistedImageUrls = persisted.map((item) => item.url);
    }
    db.prepare("UPDATE chats SET updated_at = ?, used_at = COALESCE(used_at, ?) WHERE id = ?").run(now, now, chatId);
  });
  // A refused write left nothing behind (the transaction rolled back), so it is the same write, with the same id, that runs
  // again. Everything after it is bookkeeping about a row that is already committed: a lock there must not turn a saved
  // answer into a failed turn, and (worse) must not make a caller write the row a second time.
  runWithStoreBusyRetry(write);
  try {
    const chat = getChat(chatId);
    if (chat?.projectId) touchProject(chat.projectId);
  } catch (error) {
    if (!isStoreBusyError(error)) throw error;
    console.warn(`[chats] project recency not updated after a saved message: store busy chat=${chatId}`);
  }
  emitDesktopStoreChange({ entity: "chat", id: chatId });
  return {
    id,
    durableMessageId: id,
    ...(goalResult ? { goalResult } : {}),
    role,
    ...(speakerAgentId ? { speakerAgentId } : {}),
    text,
    createdAt: now,
    ...(hostNotice ? { hostNotice } : {}),
    ...(persistedImageUrls?.length
      ? { imageDataUrls: persistedImageUrls }
      : {}),
  };
}

type ChatMessageAppendOptions = {
  images?: readonly ImageAttachment[];
  /**
   * A screen pack's composed prompt (PLAN Science S6): what the runtime took, not what the pack's screen shows; the pack's own
   * 'view' row carries the owner's words (store/surface-conversation.ts). Ignored for an assistant row.
   */
  rowScope?: "runtime-input";
  hostNotice?: ChatHostNotice;
  /** Exact installed author from the producer, never inferred from stream order. */
  speakerAgentId?: string;
  /** A teammate's working-room message is not the Goal's answer, so it never waits for a verification verdict. */
  noGoalResult?: boolean;
};

/** Completion may be published only after its exact assistant body is durable. */
export function hasDurableAssistantMessage(chatId: string, text: string, notBefore?: string): boolean {
  if (!chatId || !text.trim()) return false;
  const row = getDb().prepare(
    `SELECT 1 AS found FROM chat_messages
     WHERE chat_id = ? AND role = 'assistant' AND text = ? AND row_scope IS NOT 'view'
       AND (? IS NULL OR created_at >= ?)
     ORDER BY created_at DESC LIMIT 1`,
  ).get(chatId, text, notBefore ?? null, notBefore ?? null) as { found?: number } | undefined;
  return row?.found === 1;
}

/** What both sides of a saved-answer comparison are reduced to when the saved body is not byte-equal to the event's. */
function defaultCanonicalAssistantBody(value: string): string {
  return repairAskOpenMarkers(value).replace(/\r\n/g, "\n").trim();
}

/** The most recent assistant rows of a chat that the canonical comparison reads, newest first. */
const CANONICAL_MATCH_SCAN_LIMIT = 40;

export interface DurableAssistantMatch {
  id: string;
  /** The body as saved, which is what a binding to this row must name. */
  text: string;
  via: "message-id" | "exact" | "canonical";
}

/**
 * Find the saved row of a turn's final answer. Completion may be published only after reopening the chat can read the answer
 * back; this finds that row without demanding a byte-equal body, because the saved body and the event's body legitimately
 * differ in ways that are not a lost write:
 *  1. `messageId`: the id the producer got back when it saved the answer (client.ts durableAssistantMessageIdForVerification)
 *     names the row exactly, whatever was done to the text on the way in (appendChatMessage repairs mistyped ask markers).
 *  2. the exact body, as hasDurableAssistantMessage.
 *  3. the same body after the cleaning both sides share (`canonical`, default: ask markers repaired, CRLF, trimmed). A producer
 *     that saves the model's raw text (a firm or swarm final) and an event that carries the displayed copy meet here (2026-09-02:
 *     a finished answer with question fences was replaced by result-not-durable one millisecond after its row was saved).
 * Rows older than `notBefore` and 'view' rows never match, as before.
 */
export function findDurableAssistantMessage(
  chatId: string,
  text: string,
  options: { notBefore?: string; messageId?: string | null; canonical?: (value: string) => string } = {},
): DurableAssistantMatch | null {
  if (!chatId || !text.trim()) return null;
  const db = getDb();
  const notBefore = options.notBefore ?? null;
  const messageId = typeof options.messageId === "string" ? options.messageId.trim() : "";
  if (messageId) {
    const byId = db.prepare(
      `SELECT id, text FROM chat_messages WHERE id = ? AND chat_id = ? AND role = 'assistant' AND row_scope IS NOT 'view' LIMIT 1`,
    ).get(messageId, chatId) as { id: string; text: string } | undefined;
    if (byId) return { id: byId.id, text: byId.text, via: "message-id" };
  }
  const exact = db.prepare(
    `SELECT id, text FROM chat_messages
     WHERE chat_id = ? AND role = 'assistant' AND text = ? AND row_scope IS NOT 'view'
       AND (? IS NULL OR created_at >= ?)
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(chatId, text, notBefore, notBefore) as { id: string; text: string } | undefined;
  if (exact) return { id: exact.id, text: exact.text, via: "exact" };
  const canonical = options.canonical ?? defaultCanonicalAssistantBody;
  const wanted = canonical(text);
  if (!wanted) return null;
  const rows = db.prepare(
    `SELECT id, text FROM chat_messages
     WHERE chat_id = ? AND role = 'assistant' AND text <> '' AND row_scope IS NOT 'view'
       AND (? IS NULL OR created_at >= ?)
     ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  ).all(chatId, notBefore, notBefore, CANONICAL_MATCH_SCAN_LIMIT) as { id: string; text: string }[];
  for (const row of rows) {
    if (canonical(row.text) === wanted) return { id: row.id, text: row.text, via: "canonical" };
  }
  return null;
}

/** Canonical final body already committed by the runtime before it emits final. */
export function latestDurableAssistantMessage(
  chatId: string,
  notBefore?: string,
): { id: string; text: string; createdAt: string; speakerAgentId?: string } | null {
  if (!chatId) return null;
  const row = getDb().prepare(
    `SELECT id, text, created_at, speaker_agent_id FROM chat_messages
     WHERE chat_id = ? AND role = 'assistant' AND text <> '' AND row_scope IS NOT 'view'
       AND (? IS NULL OR created_at >= ?)
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(chatId, notBefore ?? null, notBefore ?? null) as {
    id: string;
    text: string;
    created_at: string;
    speaker_agent_id: string | null;
  } | undefined;
  return row ? {
    id: row.id,
    text: row.text,
    createdAt: row.created_at,
    ...(row.speaker_agent_id ? { speakerAgentId: row.speaker_agent_id } : {}),
  } : null;
}

/** Result presentation is a typed ledger fact, independent of model text and schema migrations. */
function persistGoalResult(chatId: string, messageId: string, result: GoalResultPresentation): void {
  const db = getDb();
  // Unbound pending rows have a private metadata stream, never an invoke_started receipt.
  const ledgerRunId = result.runId ?? `goal-result:${messageId}`;
  db.prepare(`INSERT INTO run_events(id, run_id, seq, ts, kind, chat_id, payload_json)
    VALUES (?, ?, (SELECT COALESCE(MAX(seq) + 1, 0) FROM run_events WHERE run_id = ?), ?, 'goal_result_presentation', ?, ?)`)
    .run(randomUUID(), ledgerRunId, ledgerRunId, new Date().toISOString(), chatId, JSON.stringify({ messageId, ...result }));
}

function storedGoalResults(chatId: string, messageIds: string[]): Map<string, GoalResultPresentation> {
  const result = new Map<string, GoalResultPresentation>();
  if (!messageIds.length) return result;
  const rows = getDb().prepare(`SELECT payload_json FROM run_events WHERE chat_id = ? AND kind = 'goal_result_presentation'
    AND json_extract(payload_json, '$.messageId') IN (${messageIds.map(() => '?').join(',')}) ORDER BY rowid ASC`)
    .all(chatId, ...messageIds) as {payload_json: string}[];
  for (const row of rows) {
    const parsed = parseGoalResult(row.payload_json);
    if (parsed) result.set(JSON.parse(row.payload_json).messageId, parsed);
  }
  return result;
}

/** Bind by exact persisted body and invocation interval, never by "latest answer" alone. */
export function bindGoalResultMessage(p: { chatId: string; goalId: string; runId: string; text: string; notBefore: string }): string | undefined {
  const db = getDb();
  // IMMEDIATE: this transaction reads (the answer's row, the stored presentation of a Goal chat that has thousands of them:
  // tens of milliseconds) and only then writes. Deferred, the daemon's commit in that window made the upgrade to a write fail
  // at once with SQLITE_BUSY_SNAPSHOT ("database is locked", which busy_timeout never waits out) and a finished Goal turn
  // ended as a failed run (observed in use 11:05 and 2026-10-27 00:29, both an answered Goal turn). Same cure as
  // recordRunEvent and saveGoalPlan: take the write lock first and let the other writer wait its turn.
  const id = db.transaction(() => {
    const rows = db.prepare(`SELECT id FROM chat_messages WHERE chat_id = ? AND role = 'assistant' AND text = ? AND created_at >= ? ORDER BY rowid DESC`).all(p.chatId, p.text, p.notBefore) as {id: string}[];
    if (rows.length !== 1) return undefined;
    const existing = storedGoalResults(p.chatId, [rows[0].id]).get(rows[0].id);
    if (existing && (existing.goalId !== p.goalId || (existing.runId && existing.runId !== p.runId))) return undefined;
    if (existing?.status === "verified") return rows[0].id;
    persistGoalResult(p.chatId, rows[0].id, { goalId: p.goalId, runId: p.runId, status: "pending" });
    return rows[0].id;
  }).immediate();
  if (id) emitDesktopStoreChange({ entity: "chat", id: p.chatId });
  return id;
}

/** Deferred re-runs of a Goal result binding that a locked store refused (see bindGoalResultMessageSettling): 1.5 s, then 6 s. */
const GOAL_RESULT_BIND_REPAIR_DELAYS_MS: readonly number[] = process.env.AGENTLAS_TEST_GOAL_BIND_REPAIR_FAST === "1" ? [5, 10] : [1_500, 6_000];

/**
 * Bind an answered Goal turn's row to its invocation (bindGoalResultMessage) without letting a locked store end the turn.
 * The answer's row is already saved and the binding only decides which invocation's verification verdict the row waits for.
 * A refused write is re-run (runWithStoreBusyRetry: 3 re-runs, 520 ms at most); if the store is still locked the binding is
 * left to two deferred re-runs (1.5 s and 6 s, each also bounded) and the turn settles unbound, the same state an ambiguous
 * body already settles in. The binding is idempotent (an existing binding for this run is kept, a verified one never reset).
 */
export function bindGoalResultMessageSettling(p: { chatId: string; goalId: string; runId: string; text: string; notBefore: string }): string | undefined {
  try {
    return runWithStoreBusyRetry(() => bindGoalResultMessage(p));
  } catch (error) {
    if (!isStoreBusyError(error)) throw error;
    console.warn(`[chats] goal result binding deferred: store busy chat=${p.chatId} run=${p.runId}`);
    scheduleGoalResultBindRepair(() => bindGoalResultMessage(p), p.chatId);
    return undefined;
  }
}

function scheduleGoalResultBindRepair(operation: () => unknown, chatId: string, attempt = 0): void {
  if (attempt >= GOAL_RESULT_BIND_REPAIR_DELAYS_MS.length) {
    console.warn(`[chats] goal result binding gave up after ${attempt} deferred attempts chat=${chatId}`);
    return;
  }
  const timer = setTimeout(() => {
    try {
      operation();
    } catch (error) {
      if (isStoreBusyError(error)) scheduleGoalResultBindRepair(operation, chatId, attempt + 1);
      else console.warn(`[chats] goal result binding repair failed chat=${chatId}:`, error);
    }
  }, GOAL_RESULT_BIND_REPAIR_DELAYS_MS[attempt]!);
  timer.unref?.();
}

/** Bind a producer-owned durable message directly; copy and time are not identities. */
export function bindGoalResultMessageId(p: { chatId: string; messageId: string; goalId: string; runId: string }): boolean {
  const db = getDb();
  const bound = db.transaction(() => {
    const chat = db.prepare("SELECT goal_id FROM chats WHERE id = ?").get(p.chatId) as {goal_id: string | null} | undefined;
    if (chat?.goal_id !== p.goalId) return false;
    const message = db.prepare("SELECT 1 FROM chat_messages WHERE id = ? AND chat_id = ? AND role = 'assistant'")
      .get(p.messageId, p.chatId);
    if (!message) return false;
    const existing = storedGoalResults(p.chatId, [p.messageId]).get(p.messageId);
    if (existing && (existing.goalId !== p.goalId || (existing.runId && existing.runId !== p.runId))) return false;
    if (existing?.runId === p.runId) return true;
    persistGoalResult(p.chatId, p.messageId, { goalId: p.goalId, runId: p.runId, status: "pending" });
    return true;
  }).immediate(); // reads before it writes: see bindGoalResultMessage
  if (bound) emitDesktopStoreChange({ entity: "chat", id: p.chatId });
  return bound;
}

/**
 * Persist one assistant result per exact Goal invocation and body. Continuous
 * passes may independently produce the same copy; the invocation id, never a
 * timestamp, proves that reusing the earlier durable row is safe.
 */
export function appendInvocationAssistantResult(p: {
  chatId: string;
  text: string;
  goalId?: string | null;
  runId?: string | null;
  speakerAgentId?: string;
  options?: ChatMessageAppendOptions;
}): ChatHistoryEntry {
  const activeGoalId = getChat(p.chatId)?.goalId ?? null;
  const hasExactInvocation = Boolean(p.goalId && p.runId && activeGoalId === p.goalId);
  const hasDisplayMetadata = Object.keys(p.options ?? {}).length > 0;
  if (hasExactInvocation && !hasDisplayMetadata) {
    const existing = getDb().prepare(`SELECT m.id, m.created_at, m.speaker_agent_id
      FROM chat_messages m
      WHERE m.chat_id = ? AND m.role = 'assistant' AND m.text = ? AND m.host_notice_json IS NULL
        AND NOT EXISTS (SELECT 1 FROM chat_message_attachments a WHERE a.message_id = m.id)
        AND EXISTS (
          SELECT 1 FROM run_events e
          WHERE e.chat_id = m.chat_id AND e.kind = 'goal_result_presentation'
            AND e.run_id = ?
            AND json_extract(e.payload_json, '$.messageId') = m.id
            AND json_extract(e.payload_json, '$.goalId') = ?
            AND json_extract(e.payload_json, '$.runId') = ?
        )
      ORDER BY m.rowid DESC LIMIT 1`).get(
        p.chatId, p.text, p.runId, p.goalId, p.runId,
      ) as {id: string; created_at: string; speaker_agent_id: string | null} | undefined;
    if (existing) {
      return {
        id: existing.id,
        durableMessageId: existing.id,
        goalResult: storedGoalResults(p.chatId, [existing.id]).get(existing.id)
          ?? { goalId: p.goalId!, runId: p.runId!, status: "pending" },
        role: "assistant",
        ...(existing.speaker_agent_id ? { speakerAgentId: existing.speaker_agent_id } : {}),
        text: p.text,
        createdAt: existing.created_at,
      };
    }
  }
  const entry = appendChatMessage(p.chatId, "assistant", p.text,
    { ...p.options, ...(p.speakerAgentId ? { speakerAgentId: p.speakerAgentId } : {}) });
  if (!hasExactInvocation) return entry;
  // The row is saved. The binding only names the invocation whose verification verdict it waits for, so a locked store must
  // not end an answered turn here: it is re-run (bounded), then left to two deferred re-runs, and the entry stays as saved
  // (the service binds the same row by its exact body when the turn publishes: bindGoalResultMessageSettling).
  const bindRow = () => bindGoalResultMessageId({ chatId: p.chatId, messageId: entry.id, goalId: p.goalId!, runId: p.runId! });
  let bound: boolean;
  try {
    bound = runWithStoreBusyRetry(bindRow);
  } catch (error) {
    if (!isStoreBusyError(error)) throw error;
    console.warn(`[chats] goal result binding deferred: store busy chat=${p.chatId} message=${entry.id}`);
    scheduleGoalResultBindRepair(bindRow, p.chatId);
    return entry;
  }
  return bound
    ? { ...entry, goalResult: { goalId: p.goalId!, runId: p.runId!, status: "pending" } }
    : entry;
}

/** A presentation can name an episode pass only from the Main cycle receipt
 * and its same-producer checkpoint. A generic model completion is insufficient. */
function hasCurrentVerifiedGoalEpisode(p: { chatId: string; goalId: string; runId: string }): boolean {
  const goal = getChatGoalRevision(p.goalId);
  if (!goal || goal.chatId !== p.chatId || goal.lifecycle !== "ongoing") return false;
  const db = getDb();
  const run = db.prepare("SELECT id FROM long_runs WHERE goal_id = ? AND root_chat_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(p.goalId, p.chatId) as { id: string } | undefined;
  if (!run) return false;
  const row = db.prepare(`SELECT seq, payload_json FROM long_run_events WHERE run_id = ? AND kind = 'run.task_checkpoint'
    AND actor_kind = 'host' AND json_extract(payload_json, '$.checkpoint.invocationRunId') = ? ORDER BY seq DESC LIMIT 1`)
    .get(run.id, p.runId) as { seq: number; payload_json: string } | undefined;
  if (!row) return false;
  try {
    const checkpoint = JSON.parse(row.payload_json).checkpoint;
    if (checkpoint.goalId !== p.goalId || checkpoint.goalRevision !== goal.revision || checkpoint.lifecycle !== "ongoing"
      || checkpoint.invocationRunId !== p.runId || checkpoint.disposition !== "cycle_completed"
      || checkpoint.capsule?.runId !== run.id) return false;
    const cycle = db.prepare(`SELECT seq, payload_json FROM long_run_events WHERE run_id = ?
      AND kind = 'run.ongoing_cycle_verified' AND actor_kind = 'host' AND seq < ? ORDER BY seq DESC LIMIT 1`)
      .get(run.id, row.seq) as { seq: number; payload_json: string } | undefined;
    if (!cycle) return false;
    const proof = JSON.parse(cycle.payload_json);
    const binding = db.prepare(`SELECT payload_json FROM long_run_events WHERE run_id = ?
      AND kind = 'run.goal_revision_bound' ORDER BY seq DESC LIMIT 1`).get(run.id) as { payload_json: string } | undefined;
    if (!binding || JSON.parse(binding.payload_json).revision !== goal.revision || proof.goalRevision !== goal.revision
      || !Number.isSafeInteger(proof.receiptCursor) || proof.receiptCursor < 1
      || !Number.isSafeInteger(checkpoint.capsule.lastCommittedEventSeq)
      || checkpoint.capsule.lastCommittedEventSeq < cycle.seq || checkpoint.capsule.lastCommittedEventSeq >= row.seq) return false;
    return !db.prepare(`SELECT 1 FROM long_run_events WHERE run_id = ? AND kind = 'run.task_checkpoint'
      AND seq > ? AND seq < ? LIMIT 1`).get(run.id, cycle.seq, row.seq);
  } catch { return false; }
}

/** Promotion is scoped to the exact host verification and its bound message. */
export function settleGoalResultMessages(p: { chatId: string; goalId: string; runId: string; verified: boolean;
  verificationScope?: GoalResultPresentation["verificationScope"];
  verificationState?: GoalResultPresentation["verificationState"];
}): void {
  const db = getDb();
  let changed = false;
  db.transaction(() => {
    const status = p.verified ? "verified" : p.verificationState === "pending" ? "pending" : "unverified";
    const phase = parseGoalResult({ goalId: p.goalId, runId: p.runId, status,
      verificationScope: p.verificationScope, verificationState: p.verificationState });
    if (!phase || (p.verificationScope === "episode" && p.verified && !hasCurrentVerifiedGoalEpisode(p))) {
      throw new Error("goal_result_verification_phase_unproven");
    }
    const ids = db.prepare(`SELECT DISTINCT json_extract(payload_json, '$.messageId') AS id FROM run_events
      WHERE run_id = ? AND chat_id = ? AND kind = 'goal_result_presentation'`).all(p.runId, p.chatId) as {id: string}[];
    const states = storedGoalResults(p.chatId, ids.map((row) => row.id));
    for (const [id, current] of states) {
      if (current.goalId !== p.goalId || current.runId !== p.runId || current.status === "verified") continue;
      if (current.verificationScope === "episode" && p.verified && !hasCurrentVerifiedGoalEpisode(p)) {
        throw new Error("goal_result_verification_phase_unproven");
      }
      persistGoalResult(p.chatId, id, current.verificationScope === "episode" && p.verified
        ? { ...phase, verificationScope: "episode", verificationState: "passed" } : phase);
      changed = true;
    }
  }).immediate(); // reads before it writes: see bindGoalResultMessage
  if (changed) emitDesktopStoreChange({ entity: "chat", id: p.chatId });
}

/** Old reports have no stored verifier result. Only exact ledger identities can mark them as Goal reports. */
function legacyGoalResults(chatId: string, messageIds: string[]): Map<string, GoalResultPresentation> {
  const result = new Map<string, GoalResultPresentation>();
  if (!messageIds.length) return result;
  const rows = getDb().prepare(`SELECT f.run_id, json_extract(f.payload_json, '$.durableMessageId') AS message_id,
      json_extract(g.payload_json, '$.goalId') AS goal_id
    FROM run_events f JOIN run_events g ON g.run_id = f.run_id AND g.chat_id = f.chat_id
    WHERE f.chat_id = ? AND f.kind = 'mcp_final' AND g.kind = 'mcp_goal_tool_selection'
      AND json_extract(f.payload_json, '$.durableMessageId') IN (${messageIds.map(() => '?').join(',')})`).all(chatId, ...messageIds) as {run_id: string; message_id: string; goal_id: string}[];
  const ambiguous = new Set<string>();
  for (const row of rows) {
    if (!row.goal_id || !row.run_id) continue;
    const previous = result.get(row.message_id);
    if (previous && (previous.runId !== row.run_id || previous.goalId !== row.goal_id)) ambiguous.add(row.message_id);
    result.set(row.message_id, { goalId: row.goal_id, runId: row.run_id, status: "legacy" });
  }
  for (const id of ambiguous) result.delete(id);
  return result;
}

/**
 * The chat as its runtime sees it: the run's history, its prior-context test, every Work/One reader of a chat. A screen pack's
 * 'view' rows (PLAN Science S6, store/surface-conversation.ts) are the pack's own record of what its screen shows; the runtime
 * never took them as input, so they are not here (the pack reads them through readSurfaceConversation). A Work/One chat has none.
 */
export function listChatMessages(chatId: string, limit = 200): ChatHistoryEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT id, role, text, created_at, host_notice_json, speaker_agent_id FROM (
         SELECT rowid AS seq, id, role, text, created_at, host_notice_json, speaker_agent_id
           FROM chat_messages
          WHERE chat_id = ?
            AND NOT (role = 'user' AND instr(text, ?) > 0)
            AND row_scope IS NOT 'view'
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?
       ) ORDER BY created_at ASC, seq ASC`,
    )
    .all(chatId, LEGACY_FIRM_SYNTHESIS_MARKER, limit) as MessageRow[];
  return projectChatMessageRows(chatId, rows);
}

/** Stable keyset pagination; the extra row only establishes whether older rows exist. */
export function listChatMessagesPage(
  chatId: string,
  limit: number,
  before?: { id: string; createdAt: string },
): { messages: ChatHistoryEntry[]; hasOlder: boolean } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new TypeError("Invalid history page limit");
  const db = getDb();
  if (before && !db.prepare(
    `SELECT 1 FROM chat_messages WHERE chat_id = ? AND id = ? AND created_at = ?
      AND NOT (role = 'user' AND instr(text, ?) > 0)`,
  ).get(chatId, before.id, before.createdAt, LEGACY_FIRM_SYNTHESIS_MARKER)) {
    throw new TypeError("History cursor no longer matches this chat; reload the newest page");
  }
  return readChatMessageKeyset(chatId, limit, before);
}

/**
 * Transcript paging for harness thread.read (Terminal thread read reads the same rows the same way): the keyset of
 * listChatMessagesPage over the rows a transcript shows. System rows are left out before the limit, so a page holds up to
 * `limit` shown messages and its cursor is always a shown row — the same pages and cursors on every surface.
 */
export function listChatTranscriptPage(
  chatId: string,
  limit: number,
  before?: { id: string; createdAt: string },
): { messages: ChatHistoryEntry[]; hasOlder: boolean } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new TypeError("Invalid history page limit");
  if (before && !getDb().prepare(
    `SELECT 1 FROM chat_messages WHERE chat_id = ? AND id = ? AND created_at = ?
      AND NOT (role = 'user' AND instr(text, ?) > 0)`,
  ).get(chatId, before.id, before.createdAt, LEGACY_FIRM_SYNTHESIS_MARKER)) {
    throw new TypeError("History cursor no longer matches this chat; reload the newest page");
  }
  return readChatMessageKeyset(chatId, limit, before, { excludeSystem: true });
}

/** Internal read bound, used only after Mobile verifies the UiInstance cursor in its source store. */
export function listChatMessagesBeforeUiAnchor(
  chatId: string,
  limit: number,
  before: { id: string; createdAt: string },
): { messages: ChatHistoryEntry[]; hasOlder: boolean } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200
    || !/^ui-instance:[A-Za-z0-9_.:-]+$/.test(before.id)
    || !Number.isFinite(Date.parse(before.createdAt))) throw new TypeError("Invalid verified UI history bound");
  return readChatMessageKeyset(chatId, limit, before, { uiAnchor: true });
}

/**
 * Store order of chat rows: created_at, then insertion order (rowid) for rows saved in the same millisecond (NH26). The
 * random UUID id never orders rows: a question and its answer written in one millisecond came back swapped. A cursor
 * stays `{ id, createdAt }` (Work, One, Terminal thread read and every phone build send that shape); its rowid is read
 * from the row it names. A UI-instance anchor (Mobile history) is not a stored row and sorts after every stored row of
 * its millisecond, as `ui-instance:` sorted after every UUID before.
 */
const BEFORE_STORED_ROW = "AND (created_at < ? OR (created_at = ? AND rowid < (SELECT rowid FROM chat_messages WHERE id = ?)))";
const BEFORE_UI_ANCHOR = "AND created_at <= ?";

function readChatMessageKeyset(
  chatId: string,
  limit: number,
  before?: { id: string; createdAt: string },
  options: { excludeSystem?: boolean; uiAnchor?: boolean } = {},
): { messages: ChatHistoryEntry[]; hasOlder: boolean } {
  const rows = getDb().prepare(
    `SELECT id, role, text, created_at, host_notice_json, speaker_agent_id
       FROM chat_messages
      WHERE chat_id = ? AND NOT (role = 'user' AND instr(text, ?) > 0)
        ${options.excludeSystem ? "AND role != 'system'" : ""}
        ${before ? options.uiAnchor ? BEFORE_UI_ANCHOR : BEFORE_STORED_ROW : ""}
      ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  ).all(chatId, LEGACY_FIRM_SYNTHESIS_MARKER,
    ...(before ? options.uiAnchor ? [before.createdAt] : [before.createdAt, before.createdAt, before.id] : []), limit + 1) as MessageRow[];
  return {
    messages: projectChatMessageRows(chatId, rows.slice(0, limit).reverse()),
    hasOlder: rows.length > limit,
  };
}

/**
 * One continuous read of a seat's direct (1:1) talk across every chat it was ever split into (owner 2026-10-13: the seat shows
 * one conversation, the many chats stay as they are in storage). Newest-first paging with the same cursor shape as
 * listChatMessagesPage, so older pages load only when asked. Group rooms are never read here: a room is its own visibility
 * domain and its text must not appear in a seat's direct thread.
 */
export function listSeatMessagesPage(
  seatId: string,
  limit: number,
  before?: { id: string; createdAt: string },
): { messages: ChatHistoryEntry[]; hasOlder: boolean; chatIds: string[] } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new TypeError("Invalid history page limit");
  if (typeof seatId !== "string" || !seatId) throw new TypeError("Seat id is required");
  const db = getDb();
  const direct = `m.chat_id IN (SELECT id FROM chats WHERE seat_id = ? AND seat_kind = 'solo' AND archived_at IS NULL)`;
  if (before && !db.prepare(
    `SELECT 1 FROM chat_messages m WHERE ${direct} AND m.id = ? AND m.created_at = ?`,
  ).get(seatId, before.id, before.createdAt)) {
    throw new TypeError("History cursor no longer matches this seat; reload the newest page");
  }
  const rows = db.prepare(
    `SELECT m.id, m.chat_id, m.role, m.text, m.created_at, m.host_notice_json, m.speaker_agent_id
       FROM chat_messages m
      WHERE ${direct} AND NOT (m.role = 'user' AND instr(m.text, ?) > 0)
        ${before ? "AND (m.created_at < ? OR (m.created_at = ? AND m.rowid < (SELECT rowid FROM chat_messages WHERE id = ?)))" : ""}
      ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
  ).all(seatId, LEGACY_FIRM_SYNTHESIS_MARKER,
    ...(before ? [before.createdAt, before.createdAt, before.id] : []), limit + 1) as Array<MessageRow & { chat_id: string }>;
  const page = rows.slice(0, limit).reverse();
  const byChat = new Map<string, MessageRow[]>();
  for (const row of page) byChat.set(row.chat_id, [...(byChat.get(row.chat_id) ?? []), row]);
  const projected = new Map<string, ChatHistoryEntry>();
  for (const [chatId, chatRows] of byChat) {
    for (const entry of projectChatMessageRows(chatId, chatRows)) projected.set(entry.id, entry);
  }
  return {
    messages: page.map((row) => projected.get(row.id)).filter((entry): entry is ChatHistoryEntry => Boolean(entry)),
    hasOlder: rows.length > limit,
    chatIds: [...byChat.keys()],
  };
}

/**
 * What a One teammate said and was asked inside group rooms, newest `limit` rows, for its 1:1 seat view (owner 2026-10-13:
 * the seat shows the room work too, marked with the room). Work handed out in a room runs in a division session under that
 * room, which inherits the room's seat, so the agent's solo seat alone never reaches it.
 */
export function listAgentRoomWorkMessages(agentId: string, limit: number): Array<ChatHistoryEntry & { room: { chatId: string; title: string; sessionChatId: string } }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 400) throw new TypeError("Invalid room work limit");
  if (typeof agentId !== "string" || !agentId) throw new TypeError("Agent id is required");
  const rows = getDb().prepare(
    `SELECT m.id, m.chat_id, m.role, m.text, m.created_at, m.host_notice_json, m.speaker_agent_id,
            p.id AS room_id, p.title AS room_title
       FROM chat_messages m
       JOIN chats c ON c.id = m.chat_id
       JOIN chats p ON p.id = c.parent_chat_id
      WHERE c.kind = 'division' AND c.origin_surface = 'one' AND c.agent_id = ? AND c.archived_at IS NULL
        AND p.archived_at IS NULL AND m.role IN ('user', 'assistant')
      ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
  ).all(agentId, limit) as Array<MessageRow & { chat_id: string; room_id: string; room_title: string | null }>;
  const page = rows.reverse();
  const byChat = new Map<string, MessageRow[]>();
  for (const row of page) byChat.set(row.chat_id, [...(byChat.get(row.chat_id) ?? []), row]);
  const projected = new Map<string, ChatHistoryEntry>();
  for (const [chatId, chatRows] of byChat) {
    for (const entry of projectChatMessageRows(chatId, chatRows)) projected.set(entry.id, entry);
  }
  return page.flatMap((row) => {
    const entry = projected.get(row.id);
    return entry ? [{ ...entry, room: { chatId: row.room_id, title: row.room_title ?? "", sessionChatId: row.chat_id } }] : [];
  });
}

const AGI_ACTION_RUN_PREFIX = "agi-action:";

/** AGI restart asks (action ids) whose incident has closed. Stores without the AGI tables withdraw nothing. */
function closedAgiRestartAskIds(actionIds: readonly string[]): ReadonlySet<string> {
  const ids = [...new Set(actionIds)].slice(0, 200);
  if (!ids.length) return new Set();
  try {
    const rows = getDb().prepare(`SELECT r.action_id FROM agi_action_receipts r JOIN agi_incidents i ON i.id = r.incident_id
      WHERE r.action = 'request_app_restart' AND r.ok = 1 AND i.status = 'resolved'
        AND r.action_id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Array<{ action_id: string }>;
    return new Set(rows.map((row) => row.action_id));
  } catch { return new Set(); }
}

/**
 * Host lines whose truth moved after they were written, read from durable state (owner Yotube 2026-10-17). The stored row
 * is never rewritten; every history reader (One, Work, split pane, phone, thread read) gets the same projection:
 *  - a run failure line whose request a later run took over reads "recovered" (quiet on every surface);
 *  - a "needs-owner" run failure whose code is inside the app reads "app-failed" (shared/run-failure-cause.ts);
 *  - an AGI "restart the app" ask whose incident has closed is withdrawn (drawn nowhere).
 */
function createSettledHostNoticeProjector(chatId: string, notices: ReadonlyArray<ChatHostNotice | undefined>): (notice: ChatHostNotice | undefined) => ChatHostNotice | undefined {
  const failureRunIds: string[] = [], askIds: string[] = [];
  for (const notice of notices) {
    if (notice?.purpose === "host-status" && (notice.status === "needs-owner" || notice.status === "app-failed")) failureRunIds.push(notice.runId);
    if (notice?.purpose === "automation-report" && notice.automationId === AGI_ACTION_NOTICE_AUTOMATION_ID
      && notice.runId.startsWith(AGI_ACTION_RUN_PREFIX)) askIds.push(notice.runId.slice(AGI_ACTION_RUN_PREFIX.length));
  }
  if (!failureRunIds.length && !askIds.length) return (notice) => notice;
  let statuses: ReadonlyMap<string, "recovered" | "app-failed"> = new Map();
  try { statuses = failureRunIds.length ? invocationFailureNoticeStatuses(chatId, failureRunIds) : statuses; } catch { /* written status stands */ }
  const withdrawn = closedAgiRestartAskIds(askIds);
  return (notice) => {
    if (notice?.purpose === "host-status") {
      const next = statuses.get(notice.runId);
      if (next && (notice.status === "needs-owner" || (notice.status === "app-failed" && next === "recovered"))) return { ...notice, status: next };
      return notice;
    }
    if (notice?.purpose === "automation-report" && notice.runId.startsWith(AGI_ACTION_RUN_PREFIX)
      && withdrawn.has(notice.runId.slice(AGI_ACTION_RUN_PREFIX.length))) return { ...notice, withdrawn: true };
    return notice;
  };
}

function projectChatMessageRows(chatId: string, rows: MessageRow[]): ChatHistoryEntry[] {
  const imageUrls = listChatMessageImageUrls(rows.map((row) => row.id));
  const goalResults = storedGoalResults(chatId, rows.filter((row) => row.role === "assistant").map((row) => row.id));
  const legacyResults = legacyGoalResults(chatId, rows.filter((row) => row.role === "assistant" && !goalResults.has(row.id)).map((row) => row.id));
  const projectDispatchNotice = createOneDispatchNoticeProjector(chatId);
  const parsedNotices = rows.map((r) => parseChatHostNotice(r.role, r.host_notice_json));
  const projectSettledNotice = createSettledHostNoticeProjector(chatId, parsedNotices);
  return rows.map((r, index) => {
    const hostNotice = projectSettledNotice(projectDispatchNotice(parsedNotices[index]));
    return {
      id: r.id,
      durableMessageId: r.id,
      ...(r.role === "assistant" && (goalResults.get(r.id) ?? legacyResults.get(r.id))
        ? { goalResult: goalResults.get(r.id) ?? legacyResults.get(r.id) } : {}),
      role: r.role,
      ...(r.role === "assistant" && r.speaker_agent_id ? { speakerAgentId: r.speaker_agent_id } : {}),
      text: r.text,
      createdAt: r.created_at,
      ...(hostNotice ? { hostNotice } : {}),
      ...(imageUrls.has(r.id) ? { imageDataUrls: imageUrls.get(r.id) } : {}),
    };
  });
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
      "SELECT id, role, text, created_at FROM chat_messages WHERE chat_id = ? AND role = 'assistant' AND created_at > ? ORDER BY created_at ASC, rowid ASC LIMIT 40",
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
      "SELECT id, role, text, created_at FROM chat_messages WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
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
    // The mark is part of the clear: a conversation whose journal other conversations share would otherwise take the newest
    // pointer of a sibling back at its next turn, and the CLI session this clear removed would be resumed.
    recordRuntimeSessionsCleared(db, targetChatId);
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

export function repairPlaceholderTaskTitles(): number {
  const db = getDb();
  const rows = db.prepare(
    `SELECT c.id,
            (SELECT m.text
             FROM chat_messages m
             WHERE m.chat_id = c.id AND m.role = 'user'
             ORDER BY m.created_at ASC, m.rowid ASC
             LIMIT 1) AS first_user_text
     FROM chats c
     WHERE c.kind <> 'division'
       AND lower(trim(c.title)) IN ('', '새 채팅', 'new chat', '새 작업', 'new task')`,
  ).all() as Array<{ id: string; first_user_text: string | null }>;
  const updates = rows.flatMap((row) => {
    const title = row.first_user_text ? autoTitleValue(row.first_user_text) : "";
    return title ? [{ id: row.id, title }] : [];
  });
  if (updates.length === 0) return 0;
  const updatedAt = new Date().toISOString();
  db.transaction(() => {
    for (const row of updates) {
      db.prepare("UPDATE chats SET title = ?, updated_at = ? WHERE id = ?")
        .run(row.title, updatedAt, row.id);
      db.prepare("UPDATE tasks SET title = ? WHERE origin_chat_id = ?")
        .run(row.title, row.id);
    }
  })();
  return updates.length;
}

export function autoTitleFromFirstMessage(chatId: string, firstMessage: string): void {
  const chat = getChat(chatId);
  if (!chat) return;
  // 사용자가 이미 rename했으면(= title이 비어있지 않음) 건드리지 않음.
  // 빈 문자열은 "untitled" 상태 — locale별 placeholder가 UI에서만 보임.
  // 과거 빌드(v6 이전)에서 "새 채팅"으로 저장된 행도 함께 처리.
  if (
    chat.title.length > 0
    && chat.title !== "새 채팅"
    && chat.title !== "New chat"
    && chat.title !== "새 작업"
    && chat.title !== "New task"
  ) return;
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
    .prepare("SELECT text FROM chat_messages WHERE chat_id = ? AND role = 'user' ORDER BY created_at ASC, rowid ASC LIMIT 1")
    .get(chatId) as { text: string } | undefined;
  const inheritedAutoTitle = firstUser ? autoTitleValue(firstUser.text) : "";
  const isAutomatic = chat.title === inheritedAutoTitle
    || chat.title === ""
    || chat.title === "새 채팅"
    || chat.title === "New chat"
    || chat.title === "새 작업"
    || chat.title === "New task";
  if (!isAutomatic) return chat;
  const taskTitle = autoTitleValue(taskPrompt.replace(/^\s*(?:\/?workforce\b|\/?hep-network\b)(?:\s+--(?:benchmark|legacy))?\s*/i, ""));
  return taskTitle ? renameChat(chatId, taskTitle) : chat;
}
