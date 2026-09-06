import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FsPathGrant, ImageAttachment } from "../../shared/types";
import { ONE_ATTACHMENT_LIMITS } from "../../shared/one-attachments";
import { pathFromGrant, resolveMainOwnedReadPath } from "../fs/access";
import { getDb } from "./db";

const ATTACHMENT_ID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

type AttachmentRow = {
  id: string;
  message_id: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  data: Buffer;
};

type PersistedAttachment = {
  id: string;
  url: string;
};

export type ChatFileSnapshotInput = {
  chatId: string;
  files: Array<{
    grant: FsPathGrant;
    name: string;
    mediaType: string;
    size: number;
    kind: "file" | "directory";
  }>;
};

export type StoredChatFile = {
  id: string;
  groupId: string;
  chatId: string;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
  kind: "file" | "directory";
  fileUrl: string | null;
  manifest?: Array<{ path: string; size: number; sha256: string }>;
};

const CHAT_FILE_ID_RE = ATTACHMENT_ID_RE;
const EXTERNALLY_OPENABLE_CHAT_FILE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg",
  ".pdf", ".rtf", ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp",
  ".pages", ".numbers", ".key", ".hwp", ".hwpx",
  ".zip", ".gz", ".tgz", ".tar", ".bz2", ".7z", ".rar",
  ".mp3", ".mpeg", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".oga", ".opus", ".weba", ".mid", ".midi",
  ".mp4", ".mov", ".webm", ".m4v", ".ogv",
]);
const MAX_DIRECTORY_ENTRIES = 512;
const MAX_RELATIVE_PATH_BYTES = 768;
const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
const MEDIA_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".rtf": "application/rtf",
  ".csv": "text/csv", ".tsv": "text/tab-separated-values", ".json": "application/json", ".jsonl": "application/x-ndjson",
  ".yaml": "application/yaml", ".yml": "application/yaml", ".xml": "application/xml", ".html": "text/html", ".htm": "text/html",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".docm": "application/vnd.ms-word.document.macroenabled.12", ".dot": "application/msword", ".dotx": "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlsm": "application/vnd.ms-excel.sheet.macroenabled.12", ".xlsb": "application/vnd.ms-excel.sheet.binary.macroenabled.12",
  ".xlt": "application/vnd.ms-excel", ".xltx": "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".pptm": "application/vnd.ms-powerpoint.presentation.macroenabled.12", ".pot": "application/vnd.ms-powerpoint",
  ".potx": "application/vnd.openxmlformats-officedocument.presentationml.template", ".ppsx": "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
  ".odt": "application/vnd.oasis.opendocument.text", ".ods": "application/vnd.oasis.opendocument.spreadsheet", ".odp": "application/vnd.oasis.opendocument.presentation",
  ".pages": "application/x-iwork-pages-sffpages", ".numbers": "application/x-iwork-numbers-sffnumbers", ".key": "application/x-iwork-keynote-sffkey",
  ".hwp": "application/x-hwp", ".hwpx": "application/x-hwpx",
  ".zip": "application/zip", ".gz": "application/gzip", ".tgz": "application/gzip", ".tar": "application/x-tar", ".bz2": "application/x-bzip2", ".7z": "application/x-7z-compressed", ".rar": "application/vnd.rar",
  ".mp3": "audio/mpeg", ".mpeg": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/opus", ".weba": "audio/webm", ".mid": "audio/midi", ".midi": "audio/midi",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".m4v": "video/x-m4v", ".ogv": "video/ogg",
  ".js": "text/javascript", ".jsx": "text/jsx", ".ts": "text/typescript", ".tsx": "text/tsx", ".css": "text/css", ".py": "text/x-python", ".rb": "text/x-ruby", ".go": "text/x-go", ".rs": "text/x-rust", ".java": "text/x-java-source", ".c": "text/x-c", ".h": "text/x-c", ".cpp": "text/x-c++", ".hpp": "text/x-c++", ".sql": "application/sql",
});

export class ChatFileSnapshotError extends Error {
  constructor(readonly code: "invalid" | "missing" | "permission" | "unsupported" | "collision" | "too_large" | "too_many" | "path_too_long" | "changed", message: string) {
    super(message);
    this.name = "ChatFileSnapshotError";
  }
}

function mediaTypeForImagePath(filePath: string): string | null {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  return null;
}

function hasExpectedImageSignature(bytes: Buffer, mediaType: string): boolean {
  if (mediaType === "image/png") {
    return bytes.length >= 8
      && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mediaType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mediaType === "image/gif") {
    const header = bytes.subarray(0, 6).toString("latin1");
    return header === "GIF87a" || header === "GIF89a";
  }
  if (mediaType === "image/webp") {
    return bytes.length >= 12
      && bytes.subarray(0, 4).toString("latin1") === "RIFF"
      && bytes.subarray(8, 12).toString("latin1") === "WEBP";
  }
  return false;
}

/**
 * Convert a Main-structured generated image into the same durable attachment
 * envelope used for pasted user images. The renderer never grants this root;
 * the caller supplies a Main-owned canonical root and this function reopens
 * the exact private regular file with O_NOFOLLOW before reading any bytes.
 */
export function chatImageAttachmentFromTrustedFile(input: {
  filePath: string;
  trustedRoot: string;
}): ImageAttachment {
  const trustedRoot = fs.realpathSync.native(path.resolve(input.trustedRoot));
  const rootStatBefore = fs.lstatSync(trustedRoot, { bigint: true });
  if (rootStatBefore.isSymbolicLink() || !rootStatBefore.isDirectory() || rootStatBefore.nlink < 1n) {
    throw new TypeError("Trusted chat image root is not a stable directory");
  }
  const resolved = resolveMainOwnedReadPath(input.filePath, trustedRoot);
  const declaredType = mediaTypeForImagePath(resolved);
  if (!declaredType) throw new TypeError("Unsupported trusted chat image type");
  const pathStatBefore = fs.lstatSync(resolved, { bigint: true });
  if (pathStatBefore.isSymbolicLink() || !pathStatBefore.isFile() || pathStatBefore.nlink !== 1n) {
    throw new TypeError("Trusted chat image is not a private regular file");
  }
  if (pathStatBefore.size < 1n || pathStatBefore.size > BigInt(ONE_ATTACHMENT_LIMITS.maxImageBytes)) {
    throw new TypeError("Trusted chat image size is out of range");
  }
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | noFollow);
  let bytes: Buffer;
  try {
    const fdStat = fs.fstatSync(fd, { bigint: true });
    if (
      !fdStat.isFile()
      || fdStat.nlink !== 1n
      || fdStat.dev !== pathStatBefore.dev
      || fdStat.ino !== pathStatBefore.ino
      || fdStat.size !== pathStatBefore.size
    ) throw new TypeError("Trusted chat image changed before read");
    bytes = Buffer.alloc(Number(fdStat.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read <= 0) throw new TypeError("Trusted chat image ended before its recorded size");
      offset += read;
    }
    const fdStatAfter = fs.fstatSync(fd, { bigint: true });
    if (
      fdStatAfter.dev !== fdStat.dev
      || fdStatAfter.ino !== fdStat.ino
      || fdStatAfter.size !== fdStat.size
      || fdStatAfter.mtimeNs !== fdStat.mtimeNs
      || fdStatAfter.ctimeNs !== fdStat.ctimeNs
      || fdStatAfter.nlink !== 1n
    ) throw new TypeError("Trusted chat image changed during read");
  } finally {
    fs.closeSync(fd);
  }
  const rootStatAfter = fs.lstatSync(trustedRoot, { bigint: true });
  const pathStatAfter = fs.lstatSync(resolved, { bigint: true });
  if (
    rootStatAfter.dev !== rootStatBefore.dev
    || rootStatAfter.ino !== rootStatBefore.ino
    || rootStatAfter.nlink < 1n
    || pathStatAfter.dev !== pathStatBefore.dev
    || pathStatAfter.ino !== pathStatBefore.ino
    || pathStatAfter.size !== pathStatBefore.size
    || pathStatAfter.mtimeNs !== pathStatBefore.mtimeNs
    || pathStatAfter.ctimeNs !== pathStatBefore.ctimeNs
    || pathStatAfter.nlink !== 1n
    || fs.realpathSync.native(resolved) !== resolved
  ) throw new TypeError("Trusted chat image path changed during read");
  if (!hasExpectedImageSignature(bytes, declaredType)) {
    throw new TypeError("Trusted chat image bytes do not match the declared type");
  }
  return {
    name: path.basename(resolved),
    mediaType: declaredType,
    data: bytes.toString("base64"),
  };
}

function safeName(value: string | undefined, index: number): string {
  const leaf = (value ?? "").replaceAll("\\", "/").split("/").pop()?.trim() ?? "";
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255);
  return cleaned || `image-${index + 1}`;
}

function decodeImage(image: ImageAttachment, index: number): {
  id: string;
  name: string;
  mediaType: string;
  bytes: Buffer;
  sha256: string;
} {
  if (!image || typeof image !== "object" || !ALLOWED_IMAGE_TYPES.has(image.mediaType)) {
    throw new TypeError("Unsupported chat image type");
  }
  if (
    typeof image.data !== "string"
    || image.data.length < 4
    || image.data.length > Math.ceil(ONE_ATTACHMENT_LIMITS.maxImageBytes / 3) * 4
    || !BASE64_RE.test(image.data)
  ) throw new TypeError("Invalid chat image encoding");
  const bytes = Buffer.from(image.data, "base64");
  if (
    bytes.length < 1
    || bytes.length > ONE_ATTACHMENT_LIMITS.maxImageBytes
    || bytes.toString("base64") !== image.data
  ) throw new TypeError("Invalid chat image bytes");
  return {
    id: randomUUID(),
    name: safeName(image.name, index),
    mediaType: image.mediaType,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function persistChatMessageImages(input: {
  messageId: string;
  chatId: string;
  images: readonly ImageAttachment[];
  createdAt: string;
}): PersistedAttachment[] {
  if (!Array.isArray(input.images) || input.images.length === 0) return [];
  if (input.images.length > ONE_ATTACHMENT_LIMITS.maxCount) throw new TypeError("Too many chat images");
  const decoded = input.images.map(decodeImage);
  const totalBytes = decoded.reduce((sum, item) => sum + item.bytes.length, 0);
  if (totalBytes > ONE_ATTACHMENT_LIMITS.maxTotalBytes) throw new TypeError("Chat images exceed the total limit");
  const insert = getDb().prepare(
    `INSERT INTO chat_message_attachments
      (id, message_id, chat_id, name, media_type, size_bytes, sha256, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const item of decoded) {
    insert.run(
      item.id,
      input.messageId,
      input.chatId,
      item.name,
      item.mediaType,
      item.bytes.length,
      item.sha256,
      item.bytes,
      input.createdAt,
    );
  }
  return decoded.map((item) => ({ id: item.id, url: `agentlas://chat-attachment/${item.id}` }));
}

export function listChatMessageImageUrls(messageIds: readonly string[]): Map<string, string[]> {
  const uniqueIds = [...new Set(messageIds.filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();
  const placeholders = uniqueIds.map(() => "?").join(",");
  const rows = getDb().prepare(
    `SELECT id, message_id
       FROM chat_message_attachments
      WHERE message_id IN (${placeholders})
      ORDER BY created_at ASC, id ASC`,
  ).all(...uniqueIds) as Array<{ id: string; message_id: string }>;
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const urls = result.get(row.message_id) ?? [];
    urls.push(`agentlas://chat-attachment/${row.id}`);
    result.set(row.message_id, urls);
  }
  return result;
}

function ensureChatFileSnapshotTables(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS chat_file_groups (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS chat_file_items (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('file', 'directory')),
      media_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
      sha256 TEXT NOT NULL,
      data BLOB,
      manifest_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(group_id) REFERENCES chat_file_groups(id) ON DELETE CASCADE,
      FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chat_file_items_group
      ON chat_file_items(group_id, chat_id, created_at, id);
  `);
}

function canonicalChatFileType(filePath: string): string {
  const mediaType = MEDIA_BY_EXTENSION[path.extname(filePath).toLowerCase()];
  if (!mediaType) throw new ChatFileSnapshotError("unsupported", `Unsupported file type: ${path.basename(filePath)}`);
  return mediaType;
}

function safeChatFileName(value: string, fallback: string): string {
  const leaf = path.basename(value.normalize("NFKC"));
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f/\\:]+/g, "_").replace(/^\.+/, "").trim();
  return (cleaned || fallback).slice(0, 180);
}

function readStableChatFile(sourcePath: string, expectedSize: number): { bytes: Buffer; sha256: string; size: number } {
  let fd: number | null = null;
  try {
    fd = fs.openSync(sourcePath, fs.constants.O_RDONLY | O_NOFOLLOW);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink < 1n) throw new ChatFileSnapshotError("missing", "The attachment is no longer a regular file.");
    if (Number(before.size) !== expectedSize) throw new ChatFileSnapshotError("changed", "The attachment changed after it was selected.");
    if (before.size > BigInt(ONE_ATTACHMENT_LIMITS.maxFileBytes)) throw new ChatFileSnapshotError("too_large", "An attachment exceeds the per-file size limit.");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read <= 0) throw new ChatFileSnapshotError("changed", "The attachment ended before its recorded size.");
      offset += read;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new ChatFileSnapshotError("changed", "The attachment changed while it was being read.");
    }
    return { bytes, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    if (error instanceof ChatFileSnapshotError) throw error;
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new ChatFileSnapshotError("missing", "The selected attachment no longer exists.");
    if (code === "EACCES" || code === "EPERM") throw new ChatFileSnapshotError("permission", "The selected attachment cannot be read with the current permission.");
    throw new ChatFileSnapshotError("invalid", "The selected attachment could not be read safely.");
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function directoryManifest(rootPath: string): { entries: Array<{ path: string; size: number; sha256: string }>; size: number; sha256: string } {
  const entries: Array<{ path: string; size: number; sha256: string }> = [];
  let total = 0;
  const visit = (directory: string) => {
    let names: string[];
    try {
      names = fs.readdirSync(directory).sort((left, right) => left.localeCompare(right, "en"));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      throw new ChatFileSnapshotError(code === "EACCES" || code === "EPERM" ? "permission" : "missing", "The selected folder could not be read.");
    }
    for (const name of names) {
      const absolute = path.join(directory, name);
      const relative = path.relative(rootPath, absolute).replaceAll(path.sep, "/");
      if (Buffer.byteLength(relative, "utf8") > MAX_RELATIVE_PATH_BYTES) throw new ChatFileSnapshotError("path_too_long", `A folder entry path is too long: ${relative.slice(0, 120)}`);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(absolute); } catch { throw new ChatFileSnapshotError("missing", `A folder entry disappeared: ${relative}`); }
      if (stat.isSymbolicLink()) throw new ChatFileSnapshotError("unsupported", `Symbolic links are not supported in folder attachments: ${relative}`);
      if (stat.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!stat.isFile()) throw new ChatFileSnapshotError("unsupported", `Unsupported folder entry: ${relative}`);
      if (entries.length >= MAX_DIRECTORY_ENTRIES) throw new ChatFileSnapshotError("too_many", `A folder attachment may contain at most ${MAX_DIRECTORY_ENTRIES} files.`);
      total += stat.size;
      if (total > ONE_ATTACHMENT_LIMITS.maxTotalBytes) throw new ChatFileSnapshotError("too_large", "The folder attachment exceeds the total size limit.");
      const file = readStableChatFile(absolute, stat.size);
      entries.push({ path: relative, size: file.size, sha256: file.sha256 });
    }
  };
  visit(rootPath);
  const digestInput = entries.map((entry) => `${entry.path}\u0000${entry.size}\u0000${entry.sha256}`).join("\n");
  return { entries, size: total, sha256: createHash("sha256").update(digestInput, "utf8").digest("hex") };
}

export function persistChatFileSnapshot(input: ChatFileSnapshotInput): { groupId: string; files: StoredChatFile[] } {
  if (!input || typeof input !== "object" || typeof input.chatId !== "string" || !input.chatId || input.chatId.length > 256 || !Array.isArray(input.files)) {
    throw new ChatFileSnapshotError("invalid", "Invalid chat file snapshot request.");
  }
  if (input.files.length < 1 || input.files.length > ONE_ATTACHMENT_LIMITS.maxCount) {
    throw new ChatFileSnapshotError("too_many", `Attach between 1 and ${ONE_ATTACHMENT_LIMITS.maxCount} items.`);
  }
  ensureChatFileSnapshotTables();
  const chat = getDb().prepare("SELECT id FROM chats WHERE id = ?").get(input.chatId) as { id: string } | undefined;
  if (!chat) throw new ChatFileSnapshotError("invalid", "The attachment conversation no longer exists.");
  const seenPaths = new Set<string>();
  const seenNames = new Set<string>();
  let totalBytes = 0;
  const prepared = input.files.map((item, index) => {
    if (!item || typeof item !== "object" || (item.kind !== "file" && item.kind !== "directory") || !Number.isSafeInteger(item.size) || item.size < 0) {
      throw new ChatFileSnapshotError("invalid", "Invalid attachment metadata.");
    }
    let sourcePath: string;
    try { sourcePath = pathFromGrant(item.grant, item.kind); }
    catch {
      if (!fs.existsSync(item.grant?.path ?? "")) throw new ChatFileSnapshotError("missing", "The selected attachment was moved or no longer exists.");
      throw new ChatFileSnapshotError("permission", "The attachment permission expired. Select the item again.");
    }
    if (Buffer.byteLength(sourcePath, "utf8") > MAX_RELATIVE_PATH_BYTES * 4) throw new ChatFileSnapshotError("path_too_long", "The selected attachment path is too long.");
    if (seenPaths.has(sourcePath)) throw new ChatFileSnapshotError("collision", `The same attachment was selected twice: ${path.basename(sourcePath)}`);
    seenPaths.add(sourcePath);
    const name = safeChatFileName(item.name || path.basename(sourcePath), `attachment-${index + 1}`);
    const foldedName = name.normalize("NFKC").toLocaleLowerCase("en-US");
    if (seenNames.has(foldedName)) throw new ChatFileSnapshotError("collision", `Two attachments have the same displayed name: ${name}`);
    seenNames.add(foldedName);
    if (item.kind === "directory") {
      const manifest = directoryManifest(sourcePath);
      totalBytes += manifest.size;
      if (totalBytes > ONE_ATTACHMENT_LIMITS.maxTotalBytes) throw new ChatFileSnapshotError("too_large", "The selected attachments exceed the total size limit.");
      return { id: randomUUID(), name, kind: item.kind, mediaType: "application/vnd.agentlas.directory+json", size: manifest.size, sha256: manifest.sha256, data: null, manifest: manifest.entries };
    }
    const mediaType = canonicalChatFileType(sourcePath);
    const file = readStableChatFile(sourcePath, item.size);
    totalBytes += file.size;
    if (totalBytes > ONE_ATTACHMENT_LIMITS.maxTotalBytes) throw new ChatFileSnapshotError("too_large", "The selected attachments exceed the total size limit.");
    return { id: randomUUID(), name, kind: item.kind, mediaType, size: file.size, sha256: file.sha256, data: file.bytes, manifest: undefined };
  });
  const groupId = randomUUID();
  const createdAt = new Date().toISOString();
  const db = getDb();
  db.transaction(() => {
    db.prepare("INSERT INTO chat_file_groups (id, chat_id, created_at) VALUES (?, ?, ?)").run(groupId, input.chatId, createdAt);
    const insert = db.prepare(`INSERT INTO chat_file_items
      (id, group_id, chat_id, name, kind, media_type, size_bytes, sha256, data, manifest_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const item of prepared) {
      insert.run(item.id, groupId, input.chatId, item.name, item.kind, item.mediaType, item.size, item.sha256, item.data, item.manifest ? JSON.stringify(item.manifest) : null, createdAt);
    }
  })();
  return {
    groupId,
    files: prepared.map((item) => ({
      id: item.id,
      groupId,
      chatId: input.chatId,
      name: item.name,
      mediaType: item.mediaType,
      size: item.size,
      sha256: item.sha256,
      kind: item.kind,
      fileUrl: item.kind === "file" ? `agentlas://chat-attachment/${item.id}` : null,
      ...(item.manifest ? { manifest: item.manifest } : {}),
    })),
  };
}

export function listChatFileSnapshot(input: { chatId: string; groupId: string }): StoredChatFile[] {
  if (!input || typeof input !== "object" || !input.chatId || !CHAT_FILE_ID_RE.test(input.groupId)) return [];
  ensureChatFileSnapshotTables();
  const rows = getDb().prepare(`SELECT id, group_id, chat_id, name, kind, media_type, size_bytes, sha256, manifest_json
      FROM chat_file_items WHERE chat_id = ? AND group_id = ? ORDER BY created_at ASC, id ASC`).all(input.chatId, input.groupId) as Array<{
    id: string; group_id: string; chat_id: string; name: string; kind: "file" | "directory"; media_type: string; size_bytes: number; sha256: string; manifest_json: string | null;
  }>;
  return rows.map((row) => {
    let manifest: StoredChatFile["manifest"];
    if (row.kind === "directory" && row.manifest_json) {
      try { manifest = JSON.parse(row.manifest_json) as StoredChatFile["manifest"]; } catch { manifest = []; }
    }
    return {
      id: row.id,
      groupId: row.group_id,
      chatId: row.chat_id,
      name: row.name,
      kind: row.kind,
      mediaType: row.media_type,
      size: row.size_bytes,
      sha256: row.sha256,
      fileUrl: row.kind === "file" ? `agentlas://chat-attachment/${row.id}` : null,
      ...(manifest ? { manifest } : {}),
    };
  });
}

/**
 * Resolve an immutable chat-file snapshot for an explicit OS-open request.
 * Renderer input is only an identity claim: Main rechecks the complete
 * chat/group/file/digest binding and returns bytes, never the original path.
 */
export function readChatFileSnapshotForExternalOpen(input: unknown): { name: string; mediaType: string; bytes: Buffer; size: number; sha256: string } | null {
  if (
    !input
    || typeof input !== "object"
    || !("chatId" in input)
    || !("groupId" in input)
    || !("id" in input)
    || !("sha256" in input)
    || typeof input.chatId !== "string"
    || input.chatId.length < 1
    || input.chatId.length > 256
    || typeof input.groupId !== "string"
    || typeof input.id !== "string"
    || typeof input.sha256 !== "string"
    || !CHAT_FILE_ID_RE.test(input.groupId)
    || !CHAT_FILE_ID_RE.test(input.id)
    || !/^[a-f0-9]{64}$/iu.test(input.sha256)
  ) return null;
  ensureChatFileSnapshotTables();
  const row = getDb().prepare(`SELECT name, media_type, size_bytes, sha256, data
      FROM chat_file_items
     WHERE chat_id = ? AND group_id = ? AND id = ? AND sha256 = ? AND kind = 'file'`)
    .get(input.chatId, input.groupId, input.id, input.sha256) as {
      name: string; media_type: string; size_bytes: number; sha256: string; data: Buffer | null;
    } | undefined;
  if (
    !row
    || !Buffer.isBuffer(row.data)
    || row.data.length !== row.size_bytes
    || row.data.length < 1
    || row.data.length > ONE_ATTACHMENT_LIMITS.maxFileBytes
    || safeChatFileName(row.name, "attachment") !== row.name
  ) return null;
  const extension = path.extname(row.name).toLowerCase();
  if (!EXTERNALLY_OPENABLE_CHAT_FILE_EXTENSIONS.has(extension) || MEDIA_BY_EXTENSION[extension] !== row.media_type) return null;
  const digest = createHash("sha256").update(row.data).digest("hex");
  if (digest !== row.sha256 || digest !== input.sha256.toLowerCase()) return null;
  return { name: row.name, mediaType: row.media_type, bytes: Buffer.from(row.data), size: row.size_bytes, sha256: row.sha256 };
}

export function readChatMessageAttachment(id: string): {
  mediaType: string;
  bytes: Buffer;
  size: number;
  sha256: string;
} | null {
  if (!ATTACHMENT_ID_RE.test(id)) return null;
  const row = getDb().prepare(
    `SELECT a.id, a.message_id, a.media_type, a.size_bytes, a.sha256, a.data
       FROM chat_message_attachments a
       JOIN chat_messages m ON m.id = a.message_id AND m.chat_id = a.chat_id
      WHERE a.id = ?`,
  ).get(id) as AttachmentRow | undefined;
  if (!row) {
    ensureChatFileSnapshotTables();
    const file = getDb().prepare(`SELECT id, media_type, size_bytes, sha256, data
        FROM chat_file_items WHERE id = ? AND kind = 'file'`).get(id) as { id: string; media_type: string; size_bytes: number; sha256: string; data: Buffer | null } | undefined;
    if (!file || !Buffer.isBuffer(file.data) || file.data.length !== file.size_bytes || file.data.length > ONE_ATTACHMENT_LIMITS.maxFileBytes) return null;
    const digest = createHash("sha256").update(file.data).digest("hex");
    if (digest !== file.sha256) return null;
    return { mediaType: file.media_type, bytes: file.data, size: file.size_bytes, sha256: file.sha256 };
  }
  if (!ALLOWED_IMAGE_TYPES.has(row.media_type) || !Buffer.isBuffer(row.data)) return null;
  if (row.data.length !== row.size_bytes || row.data.length > ONE_ATTACHMENT_LIMITS.maxImageBytes) return null;
  const digest = createHash("sha256").update(row.data).digest("hex");
  if (digest !== row.sha256) return null;
  return { mediaType: row.media_type, bytes: row.data, size: row.size_bytes, sha256: row.sha256 };
}

/**
 * Mobile may read an image only through the exact durable transcript binding
 * it already received. Requiring all three identities prevents an attachment
 * UUID from becoming an ambient file capability.
 */
export function readBoundChatMessageAttachment(input: {
  chatId: string;
  messageId: string;
  attachmentId: string;
}): { mediaType: string; bytes: Buffer; size: number; sha256: string } | null {
  if (
    !ATTACHMENT_ID_RE.test(input.attachmentId)
    || !ATTACHMENT_ID_RE.test(input.messageId)
    || !input.chatId
    || input.chatId.length > 256
  ) return null;
  const row = getDb().prepare(
    `SELECT a.id, a.message_id, a.media_type, a.size_bytes, a.sha256, a.data
       FROM chat_message_attachments a
       JOIN chat_messages m ON m.id = a.message_id AND m.chat_id = a.chat_id
      WHERE a.id = ? AND a.message_id = ? AND a.chat_id = ?`,
  ).get(input.attachmentId, input.messageId, input.chatId) as AttachmentRow | undefined;
  if (!row || !ALLOWED_IMAGE_TYPES.has(row.media_type) || !Buffer.isBuffer(row.data)) return null;
  if (row.data.length !== row.size_bytes || row.data.length > ONE_ATTACHMENT_LIMITS.maxImageBytes) return null;
  const digest = createHash("sha256").update(row.data).digest("hex");
  if (digest !== row.sha256) return null;
  return { mediaType: row.media_type, bytes: row.data, size: row.size_bytes, sha256: row.sha256 };
}
