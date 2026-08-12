import { createHash, randomUUID } from "node:crypto";
import type { ImageAttachment } from "../../shared/types";
import { ONE_ATTACHMENT_LIMITS } from "../../shared/one-attachments";
import { getDb } from "./db";

const ATTACHMENT_ID_RE = /^[0-9a-f-]{36}$/i;
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
}): void {
  if (!Array.isArray(input.images) || input.images.length === 0) return;
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
