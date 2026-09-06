import type { FsPathGrant } from "@shared/types";
import type { WorkspaceFilePreview } from "@/components/WorkspacePanel";

export const CHAT_FILE_MARKER_VERSION = "v1" as const;
export const CHAT_FILE_OPEN_EVENT = "agentlas:open-chat-file" as const;

const CHAT_FILE_MARKER_RE = /<!--\s*agentlas-chat-files:v1:([0-9a-f-]{36})\s*-->/giu;

export type ChatFileProvenance = "user-attachment" | "agent-output" | "linked-file";
export type ChatFileKind = "file" | "directory";

export interface ChatFileDraft {
  grant: FsPathGrant;
  name: string;
  mediaType: string;
  size: number;
  kind: ChatFileKind;
}

export interface StoredChatFile {
  id: string;
  groupId: string;
  chatId: string;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
  kind: ChatFileKind;
  fileUrl: string | null;
  manifest?: Array<{ path: string; size: number; sha256: string }>;
}

export interface ChatFileItem extends StoredChatFile {
  provenance: ChatFileProvenance;
  tabId: string;
  viewer: WorkspaceFilePreview;
}

export interface ChatFileSnapshotResult {
  groupId: string;
  files: StoredChatFile[];
}

export interface ChatFilesBridge {
  snapshot: (input: { chatId: string; files: ChatFileDraft[] }) => Promise<ChatFileSnapshotResult>;
  listGroup: (input: { chatId: string; groupId: string }) => Promise<StoredChatFile[]>;
  openExternal: (input: { chatId: string; groupId: string; id: string; sha256: string }) => Promise<{ ok: boolean; message?: string }>;
}

export function chatFilesBridge(): ChatFilesBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = window.agentlasFiles as (typeof window.agentlasFiles & { chatFiles?: ChatFilesBridge }) | undefined;
  return bridge?.chatFiles ?? null;
}

export function appendChatFileMarker(text: string, groupId: string): string {
  const trimmed = text.trimEnd();
  return `${trimmed}${trimmed ? "\n\n" : ""}<!-- agentlas-chat-files:${CHAT_FILE_MARKER_VERSION}:${groupId} -->`;
}

export function parseChatFileMessage(text: string): { visibleText: string; groupIds: string[] } {
  const groupIds: string[] = [];
  const visibleText = text.replace(CHAT_FILE_MARKER_RE, (_match, groupId: string) => {
    if (!groupIds.includes(groupId)) groupIds.push(groupId);
    return "";
  }).replace(/\n{3,}/g, "\n\n").trimEnd();
  return { visibleText, groupIds };
}

function extOf(name: string): string {
  const leaf = name.replaceAll("\\", "/").split("/").pop() ?? name;
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(dot).toLowerCase() : "";
}

export function viewerKindForChatFile(name: string, kind: ChatFileKind): WorkspaceFilePreview["viewerKind"] {
  if (kind === "directory") return "json";
  const ext = extOf(name);
  if ([".md", ".mdx"].includes(ext)) return "markdown";
  if ([".json", ".jsonl"].includes(ext)) return "json";
  if ([".txt", ".log", ".yaml", ".yml", ".xml", ".html", ".htm", ".js", ".jsx", ".ts", ".tsx", ".css", ".py", ".rb", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp", ".sql"].includes(ext)) return "text";
  if ([".url", ".webloc"].includes(ext)) return "browser";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg"].includes(ext)) return "image";
  if ([".mp4", ".webm", ".mov", ".m4v", ".ogv"].includes(ext)) return "video";
  if ([".mp3", ".mpeg", ".m4a", ".wav", ".ogg", ".oga", ".opus", ".flac", ".aac", ".weba", ".mid", ".midi"].includes(ext)) return "audio";
  if (ext === ".pdf") return "pdf";
  if ([".ppt", ".pptx", ".pptm", ".pot", ".potx", ".ppsx", ".odp", ".key"].includes(ext)) return "presentation";
  if ([".xls", ".xlsx", ".xlsm", ".xlsb", ".xlt", ".xltx", ".csv", ".tsv", ".ods", ".numbers"].includes(ext)) return "spreadsheet";
  if ([".doc", ".docx", ".docm", ".dot", ".dotx", ".rtf", ".odt", ".pages", ".hwp", ".hwpx"].includes(ext)) return "document";
  if ([".zip", ".tar", ".gz", ".tgz", ".bz2", ".7z", ".rar"].includes(ext)) return "archive";
  return "binary";
}

function directoryManifestContent(file: StoredChatFile): string {
  return JSON.stringify({
    folder: file.name,
    size: file.size,
    sha256: file.sha256,
    entries: file.manifest ?? [],
  }, null, 2);
}

export function chatFileItem(file: StoredChatFile, provenance: ChatFileProvenance): ChatFileItem {
  const viewerKind = viewerKindForChatFile(file.name, file.kind);
  const stableIdentity = `${file.chatId}:${file.groupId}:${file.id}`;
  return {
    ...file,
    provenance,
    tabId: `chat-file:${stableIdentity}`,
    viewer: {
      path: stableIdentity,
      name: file.name,
      size: file.size,
      viewerKind,
      fileUrl: file.fileUrl ?? "",
      openTargets: file.fileUrl ? [file.fileUrl] : [],
      content: file.kind === "directory" ? directoryManifestContent(file) : "",
      truncated: false,
      reason: file.kind === "directory" ? undefined : "binary",
      available: Boolean(file.fileUrl) || file.kind === "directory",
    },
  };
}

export function previewTabIdentity(preview: WorkspaceFilePreview): string {
  return `preview:${preview.path || preview.fileUrl || preview.name}`;
}

export function formatChatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function isSupportedChatFile(file: ChatFileItem): boolean {
  return file.kind === "directory" || file.viewer.viewerKind !== "binary";
}

export function requestChatFileOpen(file: ChatFileItem): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CHAT_FILE_OPEN_EVENT, { detail: file }));
}

export function isChatFileItem(value: unknown): value is ChatFileItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ChatFileItem>;
  return typeof item.id === "string"
    && typeof item.groupId === "string"
    && typeof item.chatId === "string"
    && typeof item.name === "string"
    && typeof item.tabId === "string"
    && (item.kind === "file" || item.kind === "directory")
    && !!item.viewer && typeof item.viewer === "object";
}
