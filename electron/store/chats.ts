// Chat CRUD + chat_messages.
// 사이드바 "최근 채팅" 섹션은 listRecent로 채운다.
// 프로젝트 페이지는 listByProject로, 회사 페이지는 listByFirm으로 채운다.
import { createHash, randomUUID } from "node:crypto";
import { RUNTIME_KINDS } from "../../shared/runtime-kinds";
import { RUNTIME_BACKENDS } from "../../shared/runtime-backends";
import { getDb } from "./db";
import { emitDesktopStoreChange } from "./change-bus";
import { getFirm } from "./firms";
import { evictRuntimeSessionsForChat } from "./runtime-sessions";
import { touchProject } from "./projects";
import {
  listChatMessageImageUrls,
  persistChatMessageImages,
} from "./chat-message-attachments";
import type {
  Chat,
  ChatHistoryEntry,
  ImageAttachment,
  RuntimeBackend,
  RuntimeKind,
  RuntimeSelection,
} from "../../shared/types";
import { currentUiLocale } from "../ui-locale";
import { applySeatSnapshotToChats, ensureSoloSeatForAgent } from "./seats";
import {
  ensureCanonicalTaskForChat,
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

function normalizeChatRuntimeSelection(value: unknown): RuntimeSelection | null {
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
  return {
    kind: normalizedKind as RuntimeKind,
    backend: input.backend as RuntimeBackend | undefined,
    source: legacyGemini ? undefined : boundedOptionalText(input.source, "source", 2_048),
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
    agentId: row.agent_id,
    title: row.title,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_message_preview?.trim()
      ? { lastMessagePreview: row.last_message_preview.replace(/\s+/g, " ").trim().slice(0, 160) }
      : {}),
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
  };
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
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as ChatRow[];
  return rows.map(toChat);
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
           ORDER BY chat_messages.created_at DESC
           LIMIT 1) AS last_message_preview
       FROM chats
       WHERE archived_at IS NULL
         AND kind = 'user'
         AND used_at IS NOT NULL
         AND origin_surface = 'one'
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
    if (!seatId) seatId = ensureSoloSeatForAgent(resolvedAgentId);
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
  const chat = getChat(id) as Chat;
  emitDesktopStoreChange({ entity: "chat", id });
  return chat;
}

function stableScienceRuntimeChatId(conversationId: string): string {
  if (!CHAT_UUID_RE.test(conversationId)) throw new Error("Invalid Science conversation id");
  const hex = createHash("sha256").update(`agentlas:science-runtime-chat:v1:${conversationId}`, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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
}): Chat {
  const chatId = stableScienceRuntimeChatId(input.conversationId);
  const marker = `⟦science⟧${input.conversationId}`;
  const existing = getChat(chatId);
  if (existing) {
    if (existing.kind !== "division" || existing.originSurface !== "work" || existing.title !== marker) {
      throw new Error("Science runtime chat binding conflict");
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
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .get(agentId) as ChatRow | undefined;
  if (existing) return toChat(existing);
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
  emitDesktopStoreChange({ entity: "task", id: `task_${id}` });
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
    emitDesktopStoreChange({ entity: "task", id: task.id });
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
    emitDesktopStoreChange({ entity: "task", id: task.id });
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

// ── chat_messages ───────────────────────────────────────────
interface MessageRow {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  created_at: string;
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

export function appendChatMessage(
  chatId: string,
  role: "user" | "assistant" | "system",
  text: string,
  options?: { images?: readonly ImageAttachment[] },
): ChatHistoryEntry {
  const id = randomUUID();
  const now = new Date().toISOString();
  const db = getDb();
  let persistedImageUrls: string[] | undefined;
  const write = db.transaction(() => {
    db.prepare(
      "INSERT INTO chat_messages (id, chat_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, chatId, role, text, now);
    if (options?.images?.length) {
      const persisted = persistChatMessageImages({ messageId: id, chatId, images: options.images, createdAt: now });
      persistedImageUrls = persisted.map((item) => item.url);
    }
    db.prepare("UPDATE chats SET updated_at = ?, used_at = COALESCE(used_at, ?) WHERE id = ?").run(now, now, chatId);
  });
  write();
  const chat = getChat(chatId);
  if (chat?.projectId) touchProject(chat.projectId);
  emitDesktopStoreChange({ entity: "chat", id: chatId });
  return {
    id,
    durableMessageId: id,
    role,
    text,
    createdAt: now,
    ...(persistedImageUrls?.length
      ? { imageDataUrls: persistedImageUrls }
      : {}),
  };
}

/** Completion may be published only after its exact assistant body is durable. */
export function hasDurableAssistantMessage(chatId: string, text: string, notBefore?: string): boolean {
  if (!chatId || !text.trim()) return false;
  const row = getDb().prepare(
    `SELECT 1 AS found FROM chat_messages
     WHERE chat_id = ? AND role = 'assistant' AND text = ?
       AND (? IS NULL OR created_at >= ?)
     ORDER BY created_at DESC LIMIT 1`,
  ).get(chatId, text, notBefore ?? null, notBefore ?? null) as { found?: number } | undefined;
  return row?.found === 1;
}

/** Canonical final body already committed by the runtime before it emits final. */
export function latestDurableAssistantMessage(
  chatId: string,
  notBefore?: string,
): { id: string; text: string; createdAt: string } | null {
  if (!chatId) return null;
  const row = getDb().prepare(
    `SELECT id, text, created_at FROM chat_messages
     WHERE chat_id = ? AND role = 'assistant' AND text <> ''
       AND (? IS NULL OR created_at >= ?)
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(chatId, notBefore ?? null, notBefore ?? null) as {
    id: string;
    text: string;
    created_at: string;
  } | undefined;
  return row ? { id: row.id, text: row.text, createdAt: row.created_at } : null;
}

export function listChatMessages(chatId: string, limit = 200): ChatHistoryEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT id, role, text, created_at FROM (
         SELECT id, role, text, created_at
           FROM chat_messages
          WHERE chat_id = ?
            AND NOT (role = 'user' AND instr(text, ?) > 0)
          ORDER BY created_at DESC
          LIMIT ?
       ) ORDER BY created_at ASC`,
    )
    .all(chatId, LEGACY_FIRM_SYNTHESIS_MARKER, limit) as MessageRow[];
  const imageUrls = listChatMessageImageUrls(rows.map((row) => row.id));
  return rows.map((r) => ({
    id: r.id,
    durableMessageId: r.id,
    role: r.role,
    text: r.text,
    createdAt: r.created_at,
    ...(imageUrls.has(r.id) ? { imageDataUrls: imageUrls.get(r.id) } : {}),
  }));
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

export function repairPlaceholderTaskTitles(): number {
  const db = getDb();
  const rows = db.prepare(
    `SELECT c.id,
            (SELECT m.text
             FROM chat_messages m
             WHERE m.chat_id = c.id AND m.role = 'user'
             ORDER BY m.created_at ASC
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
    .prepare("SELECT text FROM chat_messages WHERE chat_id = ? AND role = 'user' ORDER BY created_at ASC LIMIT 1")
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
