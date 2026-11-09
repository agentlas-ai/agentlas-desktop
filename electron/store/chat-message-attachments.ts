import { createHash, randomUUID } from "node:crypto";
import { portableFileName } from "../../shared/portable-file-name";
import fs from "node:fs";
import path from "node:path";
import type { FsPathGrant, ImageAttachment } from "../../shared/types";
import { CHAT_FILE_STORE_MAX_BYTES, ONE_ATTACHMENT_LEGACY_LIMITS, ONE_ATTACHMENT_LIMITS } from "../../shared/one-attachments";
import { pathFromGrant, resolveMainOwnedReadPath } from "../fs/access";
import { getDb } from "./db";
import { sameFileIdentity } from "../../shared/file-identity";

const ATTACHMENT_ID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

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
  // media-carousel phone photo and camera formats open in the system viewer like the rest.
  ".heic", ".heif", ".bmp", ".tif", ".tiff", ".3gp", ".3g2", ".mkv", ".avi",
]);
const MAX_DIRECTORY_ENTRIES = 512;
const MAX_RELATIVE_PATH_BYTES = 768;
const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
export const CHAT_FILE_MEDIA_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
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
  // media-carousel what a phone camera or gallery hands over (iPhone HEIC, Android 3GP, screen recorders' MKV/AVI).
  ".heic": "image/heic", ".heif": "image/heif", ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
  ".3gp": "video/3gpp", ".3g2": "video/3gpp2", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
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

export function hasExpectedImageSignature(bytes: Buffer, mediaType: string): boolean {
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
      || !sameFileIdentity(fdStat, pathStatBefore)
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

/**
 * The stored time of the index-th item of one write: the write's time plus index milliseconds. Readers order by
 * created_at, so a group of many pictures comes back in the order the owner picked them (media-carousel).
 */
function orderedCreatedAt(createdAt: string, index: number): string {
  const at = Date.parse(createdAt);
  return index === 0 || !Number.isFinite(at) ? createdAt : new Date(at + index).toISOString();
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
    || image.data.length % 4 !== 0
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
  for (const [index, item] of decoded.entries()) {
    insert.run(
      item.id,
      input.messageId,
      input.chatId,
      item.name,
      item.mediaType,
      item.bytes.length,
      item.sha256,
      item.bytes,
      orderedCreatedAt(input.createdAt, index),
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
    CREATE TABLE IF NOT EXISTS chat_file_execution_sources (
      item_id TEXT PRIMARY KEY REFERENCES chat_file_items(id) ON DELETE CASCADE,
      schema_version TEXT NOT NULL CHECK(schema_version = 'snapshot-bytes-v1'),
      source_grant_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_file_directory_bytes (
      item_id TEXT NOT NULL REFERENCES chat_file_items(id) ON DELETE CASCADE,
      relative_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY(item_id, relative_path)
    );
  `);
}

/**
 * Every file may be attached ("사진 영상 파일도 다 넣을 수 있게"). A known extension keeps its type; any other
 * file is stored as application/octet-stream and shows as a file tile. Opening it outside the app still needs a known type
 * (EXTERNALLY_OPENABLE_CHAT_FILE_EXTENSIONS); storing and handing it to a run does not.
 */
export function chatFileMediaType(fileName: string): string {
  return CHAT_FILE_MEDIA_BY_EXTENSION[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

function canonicalChatFileType(filePath: string): string {
  return chatFileMediaType(filePath);
}

/** One chat file is one SQLite value; above that the store cannot hold it. The reason names the file and the bound. */
export function assertChatFileStorable(name: string, size: number): void {
  if (Number.isSafeInteger(size) && size >= 0 && size <= CHAT_FILE_STORE_MAX_BYTES) return;
  throw new ChatFileSnapshotError("too_large", `${name} is ${Math.round(size / 1_000_000)} MB; one attachment can be at most ${CHAT_FILE_STORE_MAX_BYTES / 1_000_000} MB (the conversation store's largest value).`);
}

function safeChatFileName(value: string, fallback: string): string {
  const leaf = path.basename(value.normalize("NFKC").replace(/\\/g, "/"));
  // Same rule on every OS: names from the phone or the cloud must materialize on Windows too (fs.md #21).
  return portableFileName(leaf.replace(/[\u0000-\u001f\u007f/\\:]+/g, "_"), fallback, 180);
}

function readStableChatFile(sourcePath: string, expectedSize: number): { bytes: Buffer; sha256: string; size: number } {
  let fd: number | null = null;
  try {
    fd = fs.openSync(sourcePath, fs.constants.O_RDONLY | O_NOFOLLOW);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink < 1n) throw new ChatFileSnapshotError("missing", "The attachment is no longer a regular file.");
    if (Number(before.size) !== expectedSize) throw new ChatFileSnapshotError("changed", "The attachment changed after it was selected.");
    assertChatFileStorable(path.basename(sourcePath), Number(before.size));
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read <= 0) throw new ChatFileSnapshotError("changed", "The attachment ended before its recorded size.");
      offset += read;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const live = fs.lstatSync(sourcePath, { bigint: true });
    if (!live.isFile() || !sameFileIdentity(live, before)) throw new ChatFileSnapshotError("changed", "The attachment path was replaced while read.");
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

function directoryManifest(rootPath: string): { entries: Array<{ path: string; size: number; sha256: string }>; files: Array<{ path: string; size: number; sha256: string; bytes: Buffer }>; size: number; sha256: string } {
  const files: Array<{ path: string; size: number; sha256: string; bytes: Buffer }> = [];
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
      const canonical = fs.realpathSync(absolute);
      if (canonical !== absolute || !canonical.startsWith(rootPath + path.sep)) throw new ChatFileSnapshotError("permission", "The folder entry escaped its approved root.");
      const file = readStableChatFile(absolute, stat.size);
      if (fs.realpathSync(absolute) !== canonical) throw new ChatFileSnapshotError("changed", "The folder entry changed while copied.");
      entries.push({ path: relative, size: file.size, sha256: file.sha256 });
      files.push({ path: relative, ...file });
    }
  };
  visit(rootPath);
  const digestInput = entries.map((entry) => `${entry.path}\u0000${entry.size}\u0000${entry.sha256}`).join("\n");
  return { entries, files, size: total, sha256: createHash("sha256").update(digestInput, "utf8").digest("hex") };
}

export function persistChatFileSnapshot(input: ChatFileSnapshotInput): { groupId: string; files: StoredChatFile[] } {
  if (!input || typeof input !== "object" || typeof input.chatId !== "string" || !input.chatId || input.chatId.length > 256 || !Array.isArray(input.files)) {
    throw new ChatFileSnapshotError("invalid", "Invalid chat file snapshot request.");
  }
  if (input.files.length < 1) {
    throw new ChatFileSnapshotError("too_many", "Attach at least one item.");
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
      return { id: randomUUID(), name, kind: item.kind, mediaType: "application/vnd.agentlas.directory+json", size: manifest.size, sha256: manifest.sha256, data: null, manifest: manifest.entries, directoryBytes: manifest.files, sourceGrant: item.grant };
    }
    const mediaType = canonicalChatFileType(sourcePath);
    const file = readStableChatFile(sourcePath, item.size);
    totalBytes += file.size;
    if (totalBytes > ONE_ATTACHMENT_LIMITS.maxTotalBytes) throw new ChatFileSnapshotError("too_large", "The selected attachments exceed the total size limit.");
    return { id: randomUUID(), name, kind: item.kind, mediaType, size: file.size, sha256: file.sha256, data: file.bytes, manifest: undefined, directoryBytes: [], sourceGrant: item.grant };
  });
  const groupId = randomUUID();
  const createdAt = new Date().toISOString();
  const db = getDb();
  db.transaction(() => {
    db.prepare("INSERT INTO chat_file_groups (id, chat_id, created_at) VALUES (?, ?, ?)").run(groupId, input.chatId, createdAt);
    const insert = db.prepare(`INSERT INTO chat_file_items
      (id, group_id, chat_id, name, kind, media_type, size_bytes, sha256, data, manifest_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const [index, item] of prepared.entries()) {
      // Each item keeps the owner's order: items used to share one created_at and so sorted by their random id.
      insert.run(item.id, groupId, input.chatId, item.name, item.kind, item.mediaType, item.size, item.sha256, item.data, item.manifest ? JSON.stringify(item.manifest) : null, orderedCreatedAt(createdAt, index));
      db.prepare("INSERT INTO chat_file_execution_sources(item_id, schema_version, source_grant_json) VALUES (?, 'snapshot-bytes-v1', ?)")
        .run(item.id, JSON.stringify(item.sourceGrant));
      const insertChild = db.prepare("INSERT INTO chat_file_directory_bytes(item_id, relative_path, size_bytes, sha256, data) VALUES (?, ?, ?, ?, ?)");
      for (const child of item.directoryBytes) insertChild.run(item.id, child.path, child.size, child.sha256, child.bytes);
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

/** Main-only authenticated Mobile bytes; same durable snapshot and execution reader as Desktop. */
export function persistChatFileBytes(input: { chatId: string; groupId?: string; files: Array<{ name: string; bytes: Buffer }> }): { groupId: string; files: StoredChatFile[] } {
  return persistChatFileUploads({ chatId: input.chatId, groupId: input.groupId, files: input.files.map(file => ({ name: file.name, read: () => file.bytes })) });
}

/**
 * Main-only authenticated Mobile files staged on disk by the chunked upload (media-carousel). Bytes are read one
 * file at a time inside the write, so a group of many photos and a long video never sit in memory together.
 */
export function persistChatFileStagedFiles(input: { chatId: string; groupId?: string; files: Array<{ name: string; path: string; size: number }> }): { groupId: string; files: StoredChatFile[] } {
  return persistChatFileUploads({ chatId: input.chatId, groupId: input.groupId, files: input.files.map(file => ({ name: file.name, size: file.size, read: () => {
    const bytes = fs.readFileSync(file.path);
    if (bytes.length !== file.size) throw new ChatFileSnapshotError("changed", "A received attachment changed before it was stored.");
    return bytes;
  } })) });
}

function persistChatFileUploads(input: { chatId: string; groupId?: string; files: Array<{ name: string; size?: number; read: () => Buffer }> }): { groupId: string; files: StoredChatFile[] } {
  if (!input.chatId || !Array.isArray(input.files) || !input.files.length) throw new ChatFileSnapshotError("invalid", "Invalid mobile attachment set.");
  ensureChatFileSnapshotTables();
  const db = getDb();
  if (!db.prepare("SELECT id FROM chats WHERE id = ?").get(input.chatId)) throw new ChatFileSnapshotError("missing", "The attachment conversation no longer exists.");
  const names = new Set<string>();
  const declared = input.files.map(file => {
    if (typeof file.name !== "string" || safeChatFileName(file.name, "attachment") !== file.name || typeof file.read !== "function") throw new ChatFileSnapshotError("invalid", "Invalid mobile attachment metadata.");
    const folded = file.name.normalize("NFKC").toLocaleLowerCase("en-US");
    if (names.has(folded)) throw new ChatFileSnapshotError("collision", "Two attachments have the same displayed name.");
    names.add(folded);
    if (file.size !== undefined) assertChatFileStorable(file.name, file.size);
    return { id: randomUUID(), name: file.name, mediaType: canonicalChatFileType(file.name), read: file.read };
  });
  const groupId = input.groupId ?? randomUUID(), createdAt = new Date().toISOString();
  if (!CHAT_FILE_ID_RE.test(groupId)) throw new ChatFileSnapshotError("invalid", "Invalid attachment group identity.");
  const stored: Array<Omit<StoredChatFile, "groupId" | "chatId" | "kind" | "fileUrl">> = [];
  db.transaction(() => {
    db.prepare("INSERT INTO chat_file_groups (id, chat_id, created_at) VALUES (?, ?, ?)").run(groupId, input.chatId, createdAt);
    const insert = db.prepare(`INSERT INTO chat_file_items (id, group_id, chat_id, name, kind, media_type, size_bytes, sha256, data, manifest_json, created_at) VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?, NULL, ?)`);
    const source = db.prepare("INSERT INTO chat_file_execution_sources(item_id, schema_version, source_grant_json) VALUES (?, 'snapshot-bytes-v1', '{}')");
    for (const [index, item] of declared.entries()) {
      const bytes = item.read();
      if (!Buffer.isBuffer(bytes)) throw new ChatFileSnapshotError("invalid", "Invalid mobile attachment metadata.");
      assertChatFileStorable(item.name, bytes.length);
      if (ALLOWED_IMAGE_TYPES.has(item.mediaType) && !hasExpectedImageSignature(bytes, item.mediaType)) throw new ChatFileSnapshotError("invalid", "Image content does not match its filename.");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      insert.run(item.id, groupId, input.chatId, item.name, item.mediaType, bytes.length, sha256, bytes, orderedCreatedAt(createdAt, index));
      source.run(item.id);
      stored.push({ id: item.id, name: item.name, mediaType: item.mediaType, size: bytes.length, sha256 });
    }
  })();
  return { groupId, files: stored.map(item => ({ ...item, groupId, chatId: input.chatId, kind: "file" as const, fileUrl: `agentlas://chat-attachment/${item.id}` })) };
}

/** Bind a newly selected group into a transcript without accepting a raw filesystem path. */
export function chatFilePrompt(chatId: string, text: string, fileGroupId?: string): string {
  if (fileGroupId === undefined) return text;
  if (!CHAT_FILE_ID_RE.test(fileGroupId) || !listChatFileSnapshot({chatId, groupId: fileGroupId}).length) throw new ChatFileSnapshotError("missing", "The attachment group is unavailable in this conversation.");
  const marker = `<!-- agentlas-chat-files:v1:${fileGroupId} -->`;
  return text.includes(marker) ? text : `${text}\n\n${marker}`;
}

/** Rehydrate snapshot images in Main, never accept a renderer-provided file path. */
export function chatFileImages(chatId:string,groupId?:string):ImageAttachment[] {
  if (!groupId) return [];
  const inputs=workChatFileInputs(chatId,groupId);
  return listChatFileSnapshot({chatId,groupId}).filter(item=>ALLOWED_IMAGE_TYPES.has(item.mediaType)).map(item=>{
    const source=inputs.find(input=>input.id===item.id)!;
    return {name:item.name,mediaType:item.mediaType as ImageAttachment["mediaType"],data:readWorkChatFileEntry(source,source.entries[0]).toString("base64")};
  });
}

/**
 * The inline picture copies a file group's message has always carried, so a transcript and an old phone keep showing the
 * pictures as pictures. Only a group inside the old bounds (8 items, 5 MB pictures, 96 MB in all) is copied, exactly as
 * before; a larger group is shown from its files alone (no second copy of hundreds of megabytes, and nothing is refused).
 */
export function chatFileDisplayImages(chatId:string,groupId?:string,inlineImages:readonly ImageAttachment[]=[]):ImageAttachment[] {
  return chatFileDisplayImageCopies(chatId, groupId, inlineImages).map(copy => copy.image);
}

/** The exact source ID travels only with a copy produced here, never inferred from image bytes. */
export function chatFileDisplayImageCopies(chatId:string,groupId?:string,inlineImages:readonly ImageAttachment[]=[]):Array<{image:ImageAttachment; fileId:string}> {
  if (!groupId) return [];
  const files=listChatFileSnapshot({chatId,groupId});
  const pictures=files.filter(item=>ALLOWED_IMAGE_TYPES.has(item.mediaType));
  const inlineBytes=inlineImages.reduce((sum,image)=>sum+Math.floor(image.data.length*3/4),0);
  if (files.length+inlineImages.length>ONE_ATTACHMENT_LEGACY_LIMITS.maxCount
    || pictures.some(item=>item.size>ONE_ATTACHMENT_LEGACY_LIMITS.maxImageBytes)
    || pictures.reduce((sum,item)=>sum+item.size,0)+inlineBytes>ONE_ATTACHMENT_LEGACY_LIMITS.maxTotalBytes) return [];
  const inputs=workChatFileInputs(chatId,groupId);
  return pictures.map(item => {
    const source=inputs.find(input=>input.id===item.id);
    if (!source) throw new Error("chat_file_image_copy_mismatch");
    return { fileId:item.id, image:{name:item.name,mediaType:item.mediaType as ImageAttachment["mediaType"],data:readWorkChatFileEntry(source,source.entries[0]).toString("base64")} };
  });
}

/** Read only host-recorded provenance. Rows predating it intentionally have no aliases. */
export function chatMessageFileCopyIds(chatId: string, messageId: string): Map<string,string> {
  const db=getDb();
  const tables=db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('chat_message_file_copies','chat_file_message_bindings')").get() as {n:number};
  if (tables.n !== 2) return new Map();
  const rows=db.prepare(`SELECT c.image_id,c.file_id FROM chat_message_file_copies c
    JOIN chat_messages m ON m.id=c.message_id AND m.chat_id=? AND m.role='user'
    JOIN chat_message_attachments a ON a.id=c.image_id AND a.message_id=m.id AND a.chat_id=m.chat_id
    JOIN chat_file_items f ON f.id=c.file_id AND f.chat_id=m.chat_id
    JOIN chat_file_message_bindings b ON b.message_id=m.id AND b.chat_id=m.chat_id AND b.group_id=f.group_id
    WHERE m.id=? AND a.sha256=f.sha256 AND a.size_bytes=f.size_bytes AND a.media_type=f.media_type`).all(chatId,messageId) as Array<{image_id:string;file_id:string}>;
  return new Map(rows.map(row=>[row.image_id,row.file_id]));
}

/**
 * The bytes behind one picture or video a phone shows for a transcript message: an inline picture bound to the message,
 * or a file of a group the message names (its agentlas-chat-files marker). Chat, message and file must all agree, so a
 * file id is never an ambient capability. Main-only; the caller sizes a preview from these bytes.
 */
export function readChatAttachmentForPreview(input: { chatId: string; messageId: string; attachmentId: string }): { name: string; mediaType: string; bytes: Buffer; sha256: string } | null {
  const meta = chatAttachmentPreviewSource(input);
  const bytes = meta?.readBytes() ?? null;
  return meta && bytes ? { name: meta.name, mediaType: meta.mediaType, bytes, sha256: meta.sha256 } : null;
}

/**
 * The same binding as readChatAttachmentForPreview, without reading the stored bytes: a preview already made for this
 * sha256 is answered from its cache, so a long video is not loaded into Main and hashed again on every phone request
 * (D-1). `readBytes` reads and verifies the bytes once, only when a preview has to be made.
 */
export function chatAttachmentPreviewSource(input: { chatId: string; messageId: string; attachmentId: string }): { name: string; mediaType: string; sha256: string; size: number; readBytes(): Buffer | null } | null {
  const inline = readBoundChatMessageAttachment(input);
  if (inline) return { name: "image", mediaType: inline.mediaType, sha256: inline.sha256, size: inline.bytes.length, readBytes: () => inline.bytes };
  if (!ATTACHMENT_ID_RE.test(input.attachmentId) || !ATTACHMENT_ID_RE.test(input.messageId) || !input.chatId || input.chatId.length > 256) return null;
  ensureChatFileSnapshotTables();
  const row = getDb().prepare(`SELECT i.id, i.name, i.media_type, i.size_bytes, i.sha256
      FROM chat_file_items i JOIN chat_messages m ON m.chat_id = i.chat_id
     WHERE i.id = ? AND i.chat_id = ? AND i.kind = 'file' AND m.id = ? AND m.role = 'user'
       AND instr(m.text, 'agentlas-chat-files:v1:' || i.group_id) > 0`)
    .get(input.attachmentId, input.chatId, input.messageId) as { id: string; name: string; media_type: string; size_bytes: number; sha256: string } | undefined;
  if (!row) return null;
  return {
    name: row.name, mediaType: row.media_type, sha256: row.sha256, size: row.size_bytes,
    readBytes: () => {
      const data = (getDb().prepare("SELECT data FROM chat_file_items WHERE id = ? AND kind = 'file'").get(row.id) as { data: Buffer | null } | undefined)?.data;
      if (!Buffer.isBuffer(data) || data.length !== row.size_bytes) return null;
      return createHash("sha256").update(data).digest("hex") === row.sha256 ? data : null;
    },
  };
}

/** readChatMessageAttachment's identity (type, size, sha256) without the bytes, for the transcript thumbnail cache. */
export function chatMessageAttachmentIdentity(id: string): { mediaType: string; size: number; sha256: string } | null {
  if (!ATTACHMENT_ID_RE.test(id)) return null;
  const inline = getDb().prepare(
    `SELECT a.media_type, a.size_bytes, a.sha256 FROM chat_message_attachments a
       JOIN chat_messages m ON m.id = a.message_id AND m.chat_id = a.chat_id WHERE a.id = ?`,
  ).get(id) as { media_type: string; size_bytes: number; sha256: string } | undefined;
  if (inline) return { mediaType: inline.media_type, size: inline.size_bytes, sha256: inline.sha256 };
  ensureChatFileSnapshotTables();
  const file = getDb().prepare("SELECT media_type, size_bytes, sha256 FROM chat_file_items WHERE id = ? AND kind = 'file'")
    .get(id) as { media_type: string; size_bytes: number; sha256: string } | undefined;
  return file ? { mediaType: file.media_type, size: file.size_bytes, sha256: file.sha256 } : null;
}

export function validateChatAttachmentSelection(chatId:string,groupId?:string,images?:ImageAttachment[]):void {
  const files=groupId ? listChatFileSnapshot({chatId,groupId}) : [];
  if (groupId && !files.length) throw new ChatFileSnapshotError("missing","The attachment group is unavailable in this conversation.");
  if (files.length+(images?.length ?? 0)>ONE_ATTACHMENT_LIMITS.maxCount) throw new ChatFileSnapshotError("too_large","Too many selected attachments.");
  const imageBytes=(images ?? []).reduce((total,image,index)=>total+decodeImage(image,index).bytes.length,0);
  if (files.reduce((sum,item)=>sum+item.size,0)+imageBytes>ONE_ATTACHMENT_LIMITS.maxTotalBytes) throw new ChatFileSnapshotError("too_large","Selected attachments exceed the Desktop total limit.");
}

/**
 * When each of these groups was stored, as the ISO text the store wrote (it sorts in time order). A group this conversation
 * does not hold is left out. A Work run that lists many attachments uses it to tell the newest from the older ones.
 */
export function chatFileGroupCreatedAt(chatId: string, groupIds: readonly string[]): Map<string, string> {
  ensureChatFileSnapshotTables();
  const read = getDb().prepare("SELECT created_at FROM chat_file_groups WHERE chat_id = ? AND id = ?");
  const stored = new Map<string, string>();
  for (const groupId of groupIds) {
    const row = read.get(chatId, groupId) as { created_at?: unknown } | undefined;
    if (typeof row?.created_at === "string") stored.set(groupId, row.created_at);
  }
  return stored;
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
/** Main-only execution projection. Original grants never enter the public file DTO. */
export interface WorkChatFileInput {
  id: string; groupId: string; chatId: string; name: string; kind: "file" | "directory";
  sha256: string; size: number;
  entries: Array<{ path: string; size: number; sha256: string }>;
  original: { path: string; available: boolean } | null;
}

function safeEntryPath(value: string): boolean {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= MAX_RELATIVE_PATH_BYTES
    && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value) && !/^[A-Za-z]:/.test(value)
    && !value.includes("\\") && !/[\u0000-\u001f\u007f]/.test(value)
    && value.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

export function workChatFileInputs(chatId: string, groupId: string): WorkChatFileInput[] {
  const items = listChatFileSnapshot({ chatId, groupId });
  if (!items.length || items.length > ONE_ATTACHMENT_LIMITS.maxCount) throw new ChatFileSnapshotError("missing", "work_attachment_group_unavailable");
  const db = getDb();
  let total = 0;
  return items.map(item => {
    if (safeChatFileName(item.name, "attachment") !== item.name || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new ChatFileSnapshotError("invalid", "work_attachment_identity_invalid");
    const source = db.prepare("SELECT schema_version, source_grant_json FROM chat_file_execution_sources WHERE item_id = ?")
      .get(item.id) as { schema_version: string; source_grant_json: string } | undefined;
    let original: WorkChatFileInput["original"] = null;
    if (source?.schema_version === "snapshot-bytes-v1") {
      try { const grant = JSON.parse(source.source_grant_json) as FsPathGrant; original = { path: pathFromGrant(grant, item.kind), available: true }; }
      catch { original = null; } // A dead transient grant never becomes ambient filesystem access.
    }
    let entries = [{ path: item.name, size: item.size, sha256: item.sha256 }];
    if (item.kind === "directory") {
      if (source?.schema_version !== "snapshot-bytes-v1") throw new ChatFileSnapshotError("unsupported", "work_attachment_legacy_folder_bytes_unavailable");
      if (!Array.isArray(item.manifest) || item.manifest.length > MAX_DIRECTORY_ENTRIES) throw new ChatFileSnapshotError("invalid", "work_attachment_manifest_invalid");
      entries = item.manifest;
      const actual = db.prepare("SELECT relative_path AS path, size_bytes AS size, sha256 FROM chat_file_directory_bytes WHERE item_id = ? ORDER BY relative_path")
        .all(item.id) as typeof entries;
      const normalize = (rows: typeof entries) => JSON.stringify([...rows].sort((a, b) => a.path.localeCompare(b.path, "en")));
      if (normalize(actual) !== normalize(entries)) throw new ChatFileSnapshotError("changed", "work_attachment_folder_entries_changed");
      const digestInput = entries.map(entry => `${entry.path}\u0000${entry.size}\u0000${entry.sha256}`).join("\n");
      if (createHash("sha256").update(digestInput).digest("hex") !== item.sha256) throw new ChatFileSnapshotError("changed", "work_attachment_manifest_digest_changed");
    }
    const names = new Set<string>(); let itemBytes = 0;
    for (const entry of entries) {
      const folded = entry.path.normalize("NFKC").toLocaleLowerCase("en");
      if (!safeEntryPath(entry.path) || names.has(folded) || !Number.isSafeInteger(entry.size) || entry.size < 0
        || entry.size > ONE_ATTACHMENT_LIMITS.maxFileBytes || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new ChatFileSnapshotError("invalid", "work_attachment_entry_invalid");
      names.add(folded); itemBytes += entry.size;
    }
    total += itemBytes;
    if (itemBytes !== item.size || total > ONE_ATTACHMENT_LIMITS.maxTotalBytes) throw new ChatFileSnapshotError("too_large", "work_attachment_size_mismatch");
    return { id: item.id, groupId, chatId, name: item.name, kind: item.kind, sha256: item.sha256, size: item.size, entries, original };
  });
}

/** One bounded entry at a time; exact snapshot metadata is rechecked before bytes are returned. */
export function readWorkChatFileEntry(input: WorkChatFileInput, entry: WorkChatFileInput["entries"][number]): Buffer {
  const live = workChatFileInputs(input.chatId, input.groupId).find(item => item.id === input.id);
  if (!live || live.sha256 !== input.sha256 || !live.entries.some(row => row.path === entry.path && row.size === entry.size && row.sha256 === entry.sha256)) throw new ChatFileSnapshotError("changed", "work_attachment_binding_changed");
  const row = input.kind === "directory"
    ? getDb().prepare("SELECT b.data FROM chat_file_directory_bytes b JOIN chat_file_items i ON i.id = b.item_id WHERE i.chat_id = ? AND i.group_id = ? AND i.id = ? AND b.relative_path = ? AND b.sha256 = ?")
      .get(input.chatId, input.groupId, input.id, entry.path, entry.sha256)
    : getDb().prepare("SELECT data FROM chat_file_items WHERE chat_id = ? AND group_id = ? AND id = ? AND sha256 = ? AND kind = 'file'")
      .get(input.chatId, input.groupId, input.id, entry.sha256);
  const bytes = (row as { data?: unknown } | undefined)?.data;
  if (!Buffer.isBuffer(bytes) || bytes.length !== entry.size || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new ChatFileSnapshotError("changed", "work_attachment_bytes_changed");
  return bytes;
}

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
  if (!EXTERNALLY_OPENABLE_CHAT_FILE_EXTENSIONS.has(extension) || CHAT_FILE_MEDIA_BY_EXTENSION[extension] !== row.media_type) return null;
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
  const read = getDb().prepare(
    `SELECT a.id, a.message_id, a.media_type, a.size_bytes, a.sha256, a.data
       FROM chat_message_attachments a
       JOIN chat_messages m ON m.id = a.message_id AND m.chat_id = a.chat_id
      WHERE a.id = ? AND a.message_id = ? AND a.chat_id = ?`,
  );
  let row = read.get(input.attachmentId, input.messageId, input.chatId) as AttachmentRow | undefined;
  if (!row) {
    // A projected file alias keeps the original inline image's full-quality
    // response, but only when host-recorded provenance proves this exact pair.
    const copies = chatMessageFileCopyIds(input.chatId, input.messageId);
    const original = [...copies].find(([, fileId]) => fileId === input.attachmentId)?.[0];
    if (original) row = read.get(original, input.messageId, input.chatId) as AttachmentRow | undefined;
  }
  if (!row || !ALLOWED_IMAGE_TYPES.has(row.media_type) || !Buffer.isBuffer(row.data)) return null;
  if (row.data.length !== row.size_bytes || row.data.length > ONE_ATTACHMENT_LIMITS.maxImageBytes) return null;
  const digest = createHash("sha256").update(row.data).digest("hex");
  if (digest !== row.sha256) return null;
  return { mediaType: row.media_type, bytes: row.data, size: row.size_bytes, sha256: row.sha256 };
}
