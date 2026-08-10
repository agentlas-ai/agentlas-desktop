import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import type {
  ExternalCliSessionImportInput,
  ExternalCliSessionSummary,
  CanonicalTaskWorkTarget,
  ChatHistoryEntry,
} from "../shared/types";
import { createChat, getChat, setChatRuntimeSelection, setChatWorkingFolder } from "./store/chats";
import { getCanonicalTaskForChat } from "./store/tasks";
import { getProject } from "./store/projects";
import { getDb } from "./store/db";
import { emitDesktopStoreChange } from "./store/change-bus";

type Provider = ExternalCliSessionSummary["provider"];

interface SourceFile {
  provider: Provider;
  filePath: string;
  sourceKey: string;
  modifiedAt: number;
  homeDir: string;
}

interface ParsedSession {
  summary: ExternalCliSessionSummary;
  messages: Omit<ChatHistoryEntry, "id">[];
  cwd: string;
}

const SOURCE_KEY_RE = /^sha256:[a-f0-9]{64}$/;
const MAX_SOURCE_FILES = 600;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_IMPORT_MESSAGES = 240;
const MAX_IMPORT_CHARS = 300_000;
const MAX_MESSAGE_CHARS = 12_000;

function sourceKey(provider: Provider, filePath: string): string {
  return `sha256:${createHash("sha256").update(`${provider}\0${filePath}`).digest("hex")}`;
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    if (item.type !== "text" && item.type !== "input_text" && item.type !== "output_text") return [];
    return typeof item.text === "string" ? [item.text] : [];
  }).join("\n");
}

function messageText(value: unknown, limit = MAX_MESSAGE_CHARS): string {
  return textValue(value)
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, limit);
}

function previewText(value: unknown, limit: number): string {
  return messageText(value, Math.max(limit * 4, limit)).replace(/\s+/g, " ").trim().slice(0, limit);
}

function isInternalContextEnvelope(text: string): boolean {
  const start = text.trimStart().slice(0, 160).toLowerCase();
  return [
    "<recommended_plugins",
    "<codex_internal_context",
    "<skills_instructions",
    "<environment_context",
    "<app-context",
    "<skill",
    "<command-message",
    "<command-name",
    "<local-command",
    "[agentlas session team policy]",
    "── previous turns ──",
    "── 이전 대화 ──",
    "turn context (host-injected background information",
    "turn context(host-injected background information",
    "턴 컨텍스트 (호스트 주입 배경 정보",
    "턴 컨텍스트(호스트 주입 배경 정보",
    "# agents.md instructions",
  ].some((prefix) => start.startsWith(prefix));
}

function resolvedLocalPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function belongsToProject(cwd: string, projectFolder: string): boolean {
  if (!cwd || !projectFolder) return false;
  const candidate = resolvedLocalPath(cwd);
  const root = resolvedLocalPath(projectFolder);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function isPoorTitleCandidate(text: string): boolean {
  const start = text.trimStart().slice(0, 120).toLowerCase();
  return start.startsWith("# files mentioned by the user:") || start.startsWith("referenced image files:");
}

function stripInternalUserPrefix(text: string): string {
  const withoutTeamPolicy = text.replace(
    /^\[Agentlas (?:session team policy|세션 팀 정책)\][\s\S]*?\[\/Agentlas (?:session team policy|세션 팀 정책)\]\s*/i,
    "",
  ).trim();
  return isInternalContextEnvelope(withoutTeamPolicy) ? "" : withoutTeamPolicy;
}

function summaryText(text: string, source: SourceFile, limit: number): string {
  const homePattern = source.homeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return previewText(text, limit)
    .replace(new RegExp(homePattern, "g"), "[local home]")
    .replace(/\/(?:Users|home)\/[^/\s]+\/[^\s)>\],]+/g, "[local path]");
}

function validIso(value: unknown, fallbackMs: number): string {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return new Date(fallbackMs).toISOString();
}

function collectJsonl(root: string, provider: Provider, homeDir: string): SourceFile[] {
  if (!fs.existsSync(root)) return [];
  const resolvedRoot = fs.realpathSync(root);
  const pending = [resolvedRoot];
  const rows: SourceFile[] = [];
  let visited = 0;
  while (pending.length > 0 && visited < 8_000) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited >= 8_000) break;
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        const real = fs.realpathSync(candidate);
        if (real !== resolvedRoot && !real.startsWith(`${resolvedRoot}${path.sep}`)) continue;
        const stat = fs.statSync(real);
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SOURCE_BYTES) continue;
        rows.push({ provider, filePath: real, sourceKey: sourceKey(provider, real), modifiedAt: stat.mtimeMs, homeDir });
      } catch {
        // A disappearing or unreadable CLI log is omitted from the local menu.
      }
    }
  }
  return rows;
}

function sourceFiles(homeDir: string): SourceFile[] {
  return [
    ...collectJsonl(path.join(homeDir, ".claude", "projects"), "claude-code", homeDir),
    ...collectJsonl(path.join(homeDir, ".codex", "sessions"), "codex", homeDir),
    ...collectJsonl(path.join(homeDir, ".codex", "archived_sessions"), "codex", homeDir),
  ].sort((left, right) => right.modifiedAt - left.modifiedAt).slice(0, MAX_SOURCE_FILES);
}

function pushMessage(
  messages: Omit<ChatHistoryEntry, "id">[],
  role: "user" | "assistant",
  rawText: unknown,
  timestamp: unknown,
  fallbackMs: number,
): void {
  const text = messageText(rawText);
  if (!text) return;
  messages.push({ role, text, createdAt: validIso(timestamp, fallbackMs) });
  while (messages.length > MAX_IMPORT_MESSAGES) messages.shift();
  let total = messages.reduce((sum, row) => sum + row.text.length, 0);
  while (total > MAX_IMPORT_CHARS && messages.length > 1) {
    total -= messages.shift()!.text.length;
  }
}

async function parseSession(source: SourceFile, includeMessages: boolean): Promise<ParsedSession | null> {
  const messages: Omit<ChatHistoryEntry, "id">[] = [];
  let sessionId = "";
  let cwd = "";
  let firstUser = "";
  let lastText = "";
  let updatedAt = new Date(source.modifiedAt).toISOString();
  let observedMessages = 0;
  let observedChars = 0;
  let oversizedMessage = false;
  const stream = fs.createReadStream(source.filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line || line.length > 2_000_000) continue;
      let row: Record<string, unknown>;
      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        row = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      if (source.provider === "claude-code") {
        if (typeof row.sessionId === "string") sessionId = row.sessionId;
        if (typeof row.cwd === "string") cwd = row.cwd;
        const message = row.message && typeof row.message === "object" && !Array.isArray(row.message)
          ? row.message as Record<string, unknown>
          : null;
        const role = message?.role === "user" || message?.role === "assistant" ? message.role : null;
        if (!role || row.isMeta === true) continue;
        const extractedText = textValue(message?.content).replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim();
        const rawText = role === "user" ? stripInternalUserPrefix(extractedText) : extractedText;
        const text = rawText.slice(0, MAX_MESSAGE_CHARS);
        if (!text) continue;
        observedMessages += 1;
        observedChars += text.length;
        oversizedMessage ||= rawText.length > MAX_MESSAGE_CHARS;
        if (role === "user" && !firstUser && !isPoorTitleCandidate(text)) firstUser = text;
        lastText = text;
        updatedAt = validIso(row.timestamp, source.modifiedAt);
        if (includeMessages) pushMessage(messages, role, text, row.timestamp, source.modifiedAt);
      } else {
        const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
          ? row.payload as Record<string, unknown>
          : null;
        if (row.type === "session_meta" && payload) {
          if (typeof payload.id === "string") sessionId = payload.id;
          if (typeof payload.cwd === "string") cwd = payload.cwd;
        }
        if (row.type !== "response_item" || payload?.type !== "message") continue;
        const role = payload.role === "user" || payload.role === "assistant" ? payload.role : null;
        if (!role) continue;
        const extractedText = textValue(payload.content).replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim();
        const rawText = role === "user" ? stripInternalUserPrefix(extractedText) : extractedText;
        const text = rawText.slice(0, MAX_MESSAGE_CHARS);
        if (!text) continue;
        observedMessages += 1;
        observedChars += text.length;
        oversizedMessage ||= rawText.length > MAX_MESSAGE_CHARS;
        if (role === "user" && !firstUser && !isPoorTitleCandidate(text)) firstUser = text;
        lastText = text;
        updatedAt = validIso(row.timestamp, source.modifiedAt);
        if (includeMessages) pushMessage(messages, role, text, row.timestamp, source.modifiedAt);
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  if (!sessionId || observedMessages === 0 || !firstUser) return null;
  const title = summaryText(firstUser, source, 72) || (source.provider === "codex" ? "Codex session" : "Claude Code session");
  return {
    summary: {
      sourceKey: source.sourceKey,
      provider: source.provider,
      title,
      preview: summaryText(lastText, source, 180),
      projectLabel: cwd ? path.basename(cwd) : null,
      updatedAt,
      messageCount: observedMessages,
      truncated: observedMessages > MAX_IMPORT_MESSAGES || observedChars > MAX_IMPORT_CHARS || oversizedMessage,
    },
    messages,
    cwd,
  };
}

async function mapLimited<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

export async function listExternalCliSessions(input: { projectId: string; query?: string; limit?: number; homeDir?: string }): Promise<ExternalCliSessionSummary[]> {
  if (!input || typeof input.projectId !== "string" || !input.projectId.trim()) throw new TypeError("Project is required");
  const project = getProject(input.projectId);
  if (!project?.folderPath) return [];
  const homeDir = input?.homeDir ?? os.homedir();
  const limit = Math.min(Math.max(Number(input?.limit) || 60, 1), 100);
  const query = String(input?.query ?? "").trim().toLocaleLowerCase();
  const parsed = await mapLimited(sourceFiles(homeDir), 6, async (source) => {
    try {
      return await parseSession(source, false);
    } catch {
      return null;
    }
  });
  return parsed.flatMap((row) => row && belongsToProject(row.cwd, project.folderPath!) ? [row.summary] : [])
    .filter((row) => !query || [row.title, row.preview, row.projectLabel ?? "", row.provider]
      .some((value) => value.toLocaleLowerCase().includes(query)))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, limit);
}

export async function importExternalCliSession(
  input: ExternalCliSessionImportInput,
  options?: { homeDir?: string },
): Promise<CanonicalTaskWorkTarget> {
  if (!input || typeof input.projectId !== "string" || !input.projectId.trim()) throw new TypeError("Project is required");
  if (typeof input.sourceKey !== "string" || !SOURCE_KEY_RE.test(input.sourceKey)) throw new TypeError("Invalid external session reference");
  const project = getProject(input.projectId);
  if (!project) throw new Error("Project is unavailable");
  const source = sourceFiles(options?.homeDir ?? os.homedir()).find((candidate) => candidate.sourceKey === input.sourceKey);
  if (!source) throw new Error("The CLI session is no longer available");
  const parsed = await parseSession(source, true);
  if (!parsed || parsed.messages.length === 0) throw new Error("The CLI session has no importable conversation");
  if (!project.folderPath || !belongsToProject(parsed.cwd, project.folderPath)) {
    throw new Error("This CLI session belongs to a different project folder");
  }

  const chat = createChat({
    projectId: project.id,
    title: parsed.summary.title,
    taskMode: "task",
    originSurface: "work",
  });
  if (project.folderPath) setChatWorkingFolder(chat.id, project.folderPath);
  setChatRuntimeSelection(chat.id, {
    kind: parsed.summary.provider,
    source: "external-cli-session-import",
    role: "orchestrator",
    inherit: false,
  });
  const db = getDb();
  db.transaction(() => {
    for (const message of parsed.messages) {
      db.prepare("INSERT INTO chat_messages (id, chat_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(randomUUID(), chat.id, message.role, message.text, message.createdAt);
    }
    db.prepare("UPDATE chats SET updated_at = ?, used_at = COALESCE(used_at, ?) WHERE id = ?")
      .run(parsed.summary.updatedAt, parsed.summary.updatedAt, chat.id);
  })();
  emitDesktopStoreChange({ entity: "chat", id: chat.id });
  const stored = getChat(chat.id);
  const task = getCanonicalTaskForChat(chat.id);
  if (!stored || !task) throw new Error("Imported session could not be opened as project work");
  return { taskId: task.id, chatId: stored.id, title: stored.title };
}
