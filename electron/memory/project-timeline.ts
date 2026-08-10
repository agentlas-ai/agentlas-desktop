import { verifyActivatedFolderIdentity } from "../architecture/activation";
import { PROJECT_SOUL_FILE, SITEMAP_FILE } from "../architecture/manifest";
import { getProject } from "../store/projects";
import {
  getChat,
  listChatMessages,
  listChatsByProject,
} from "../store/chats";
import type {
  ChatHistoryEntry,
  ProjectKnowledgeSourceState,
  ProjectTimelineEntry,
  ProjectTimelineSnapshot,
} from "../../shared/types";
import {
  activatedProjectMemoryFileExists,
  PROJECT_CODE_MAP_MAX_BYTES,
  PROJECT_CODE_MAP_SEED_MAX_BYTES,
  PROJECT_MEMORY_TEXT_MAX_BYTES,
  PROJECT_SITEMAP_MAX_BYTES,
  readActivatedProjectMemoryJson,
  readActivatedProjectMemoryText,
} from "./safe-project-read";
import { listProjectMemoryEpisodes } from "./tickets";
import { summarizeCompletedWork } from "./work-summary";

const CODE_MAP_SEED_FILE = "code-map/project-seed.json";
const CODE_MAP_FULL_FILE = "code-map/project-map.json";
const MESSAGE_LOOKBACK = 600;
const MAX_ANCHOR_DISTANCE_MS = 15 * 60 * 1000;
const DEFAULT_TIMELINE_LIMIT = 80;
const MAX_TIMELINE_LIMIT = 200;

type SitemapShape = { nodes?: unknown[] };
type CodeMapShape = {
  stats?: { codeFiles?: number; symbols?: number };
  files?: unknown[];
  symbols?: unknown[];
};

function cleanCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function sourceState(
  kind: ProjectKnowledgeSourceState["kind"],
  status: ProjectKnowledgeSourceState["status"],
  detail: string | null = null,
): ProjectKnowledgeSourceState {
  return { kind, status, detail };
}

// pm soul(≤2MB)·sitemap(≤24MB)·code-map(≤1MB)을 동기 읽기+JSON.parse 하는 비용이
// ChatRightPanel의 2.5초 폴링마다 반복되고 있었다. 이 파일들은 분 단위로만 바뀌므로
// 경로별 30초 캐시로 폴링 비용을 제거한다(재활성화·파일 교체는 최대 30초 안에 반영).
const KNOWLEDGE_TTL_MS = 30_000;
const knowledgeCache = new Map<string, { at: number; states: ProjectKnowledgeSourceState[] }>();

function inspectProjectKnowledgeCached(projectPath: string | null): ProjectKnowledgeSourceState[] {
  const key = projectPath ?? "";
  const hit = knowledgeCache.get(key);
  if (hit && Date.now() - hit.at < KNOWLEDGE_TTL_MS) return hit.states;
  const states = inspectProjectKnowledge(projectPath);
  knowledgeCache.set(key, { at: Date.now(), states });
  if (knowledgeCache.size > 32) {
    const oldest = knowledgeCache.keys().next().value;
    if (oldest !== undefined && oldest !== key) knowledgeCache.delete(oldest);
  }
  return states;
}

function inspectProjectKnowledge(projectPath: string | null): ProjectKnowledgeSourceState[] {
  if (!projectPath) {
    return [
      sourceState("pm_soul", "unavailable", "project-folder-not-connected"),
      sourceState("sitemap", "unavailable", "project-folder-not-connected"),
      sourceState("code_map", "unavailable", "project-folder-not-connected"),
    ];
  }
  if (!verifyActivatedFolderIdentity(projectPath)) {
    return [
      sourceState("pm_soul", "unavailable", "folder-reactivation-required"),
      sourceState("sitemap", "unavailable", "folder-reactivation-required"),
      sourceState("code_map", "unavailable", "folder-reactivation-required"),
    ];
  }

  const soul = readActivatedProjectMemoryText(
    projectPath,
    PROJECT_SOUL_FILE,
    PROJECT_MEMORY_TEXT_MAX_BYTES,
  );
  const soulState = soul?.trim()
    ? sourceState("pm_soul", "ready", `characters:${soul.trim().length}`)
    : activatedProjectMemoryFileExists(projectPath, PROJECT_SOUL_FILE, PROJECT_CODE_MAP_MAX_BYTES)
      ? sourceState("pm_soul", "invalid", "empty-or-unreadable")
      : sourceState("pm_soul", "missing");

  const sitemap = readActivatedProjectMemoryJson<SitemapShape>(
    projectPath,
    SITEMAP_FILE,
    PROJECT_SITEMAP_MAX_BYTES,
  );
  const sitemapNodes = Array.isArray(sitemap?.nodes) ? sitemap.nodes.length : null;
  const sitemapState = sitemapNodes !== null
    ? sourceState("sitemap", "ready", `nodes:${sitemapNodes}`)
    : activatedProjectMemoryFileExists(projectPath, SITEMAP_FILE, PROJECT_SITEMAP_MAX_BYTES)
      ? sourceState("sitemap", "invalid", "invalid-json-or-shape")
      : sourceState("sitemap", "missing");

  const seed = readActivatedProjectMemoryJson<CodeMapShape>(
    projectPath,
    CODE_MAP_SEED_FILE,
    PROJECT_CODE_MAP_SEED_MAX_BYTES,
  );
  const full = seed ?? readActivatedProjectMemoryJson<CodeMapShape>(
    projectPath,
    CODE_MAP_FULL_FILE,
    PROJECT_CODE_MAP_MAX_BYTES,
  );
  const codeFiles = cleanCount(full?.stats?.codeFiles)
    ?? (Array.isArray(full?.files) ? full.files.length : null);
  const symbols = cleanCount(full?.stats?.symbols)
    ?? (Array.isArray(full?.symbols) ? full.symbols.length : null);
  const hasCodeMapShape = Boolean(full && (full.stats || Array.isArray(full.files) || Array.isArray(full.symbols)));
  const hasCodeMapFile =
    activatedProjectMemoryFileExists(projectPath, CODE_MAP_SEED_FILE, PROJECT_CODE_MAP_SEED_MAX_BYTES)
    || activatedProjectMemoryFileExists(projectPath, CODE_MAP_FULL_FILE, PROJECT_CODE_MAP_MAX_BYTES);
  const codeDetail = [
    codeFiles !== null ? `files:${codeFiles}` : null,
    symbols !== null ? `symbols:${symbols}` : null,
  ].filter(Boolean).join(",");
  const codeMapState = hasCodeMapShape
    ? sourceState("code_map", "ready", codeDetail || "map-ready")
    : hasCodeMapFile
      ? sourceState("code_map", "invalid", "invalid-json-or-shape")
      : sourceState("code_map", "missing");

  return [soulState, sitemapState, codeMapState];
}

function safeTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nearestAssistantMessage(
  messages: ChatHistoryEntry[],
  occurredAt: string,
): ChatHistoryEntry | null {
  const target = safeTimestamp(occurredAt);
  if (target === null) return null;
  let best: { message: ChatHistoryEntry; distance: number } | null = null;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const createdAt = safeTimestamp(message.createdAt);
    if (createdAt === null) continue;
    const distance = Math.abs(createdAt - target);
    if (distance > MAX_ANCHOR_DISTANCE_MS) continue;
    if (!best || distance < best.distance) best = { message, distance };
  }
  return best?.message ?? null;
}

function lastTimelineMessage(messages: ChatHistoryEntry[]): ChatHistoryEntry | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant") return message;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") return message;
  }
  return null;
}

export function getProjectTimelineSnapshot(
  projectId: string,
  limit = DEFAULT_TIMELINE_LIMIT,
): ProjectTimelineSnapshot {
  const id = String(projectId ?? "").trim();
  if (!id) throw new Error("Project id is required.");
  const project = getProject(id);
  if (!project) throw new Error("Project not found.");
  const cappedLimit = Math.max(1, Math.min(MAX_TIMELINE_LIMIT, Math.floor(limit)));
  const episodes = listProjectMemoryEpisodes(project.id, project.folderPath, MAX_TIMELINE_LIMIT);
  const entries: ProjectTimelineEntry[] = [];
  const representedChats = new Set<string>();
  // 에피소드 여러 개가 같은 채팅을 가리키는 경우가 흔한데, 원래는 에피소드마다
  // 600행 전체 메시지를 다시 읽었다. 스냅샷 한 번 안에서는 채팅당 한 번만 읽는다.
  const messagesByChat = new Map<string, ChatHistoryEntry[]>();
  const chatMessages = (chatId: string): ChatHistoryEntry[] => {
    let rows = messagesByChat.get(chatId);
    if (!rows) {
      rows = listChatMessages(chatId, MESSAGE_LOOKBACK);
      messagesByChat.set(chatId, rows);
    }
    return rows;
  };

  for (const episode of episodes) {
    const fallback = "작업 기록";
    const summary = summarizeCompletedWork(episode.summary, fallback);
    if (!episode.chatId) {
      entries.push({
        id: episode.id,
        occurredAt: episode.createdAt,
        summary,
        source: "memory_episode",
        chatId: null,
        messageId: null,
        taskId: null,
        archived: false,
        navigationStatus: "unlinked",
      });
      continue;
    }

    representedChats.add(episode.chatId);
    const chat = getChat(episode.chatId);
    if (!chat || chat.projectId !== project.id) {
      entries.push({
        id: episode.id,
        occurredAt: episode.createdAt,
        summary,
        source: "memory_episode",
        chatId: null,
        messageId: null,
        taskId: null,
        archived: false,
        navigationStatus: "chat_deleted",
      });
      continue;
    }

    const anchor = nearestAssistantMessage(
      chatMessages(chat.id),
      episode.createdAt,
    );
    entries.push({
      id: episode.id,
      occurredAt: episode.createdAt,
      summary,
      source: "memory_episode",
      chatId: chat.id,
      messageId: anchor?.id ?? null,
      taskId: chat.taskId ?? null,
      archived: chat.archivedAt !== null,
      navigationStatus: anchor ? "exact" : "chat_only",
    });
  }

  // Legacy chats from before memory episodes existed still get one honest,
  // explicitly labelled fallback row. Once a chat has episodes, those turns
  // remain the only timeline authority for it.
  for (const chat of listChatsByProject(project.id)) {
    if (representedChats.has(chat.id)) continue;
    const messages = chatMessages(chat.id);
    const anchor = lastTimelineMessage(messages);
    entries.push({
      id: `chat-fallback:${chat.id}`,
      occurredAt: anchor?.createdAt ?? chat.updatedAt,
      summary: summarizeCompletedWork(anchor?.text ?? chat.title, chat.title.trim() || "작업 기록"),
      source: "chat_fallback",
      chatId: chat.id,
      messageId: anchor?.id ?? null,
      taskId: chat.taskId ?? null,
      archived: chat.archivedAt !== null,
      navigationStatus: anchor ? "exact" : "chat_only",
    });
  }

  entries.sort((left, right) => {
    const delta = (safeTimestamp(right.occurredAt) ?? 0) - (safeTimestamp(left.occurredAt) ?? 0);
    return delta || right.id.localeCompare(left.id);
  });

  return {
    projectId: project.id,
    generatedAt: new Date().toISOString(),
    sources: inspectProjectKnowledgeCached(project.folderPath),
    entries: entries.slice(0, cappedLimit),
    truncated: entries.length > cappedLimit,
  };
}
