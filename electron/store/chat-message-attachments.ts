import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ImageAttachment } from "../../shared/types";
import { ONE_ATTACHMENT_LIMITS } from "../../shared/one-attachments";
import { resolveMainOwnedReadPath } from "../fs/access";
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
  if (!row || !ALLOWED_IMAGE_TYPES.has(row.media_type) || !Buffer.isBuffer(row.data)) return null;
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
