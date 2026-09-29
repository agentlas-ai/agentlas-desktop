import { createHash } from "node:crypto";
import type { MobileBridgeChatHistoryPageDto } from "../../shared/mobile-bridge";
import { listChatMessagesPage } from "../store/chats";
import { projectMobileBridgeHistory } from "./projector";
import { mobileBridgeJsonBytes, MOBILE_BRIDGE_SAFE_PAYLOAD_BYTES } from "./sanitize";

// Leave space inside the normal transport budget for cursor metadata and envelope.
export const MOBILE_BRIDGE_HISTORY_PAGE_BYTES = Math.min(256 * 1024, MOBILE_BRIDGE_SAFE_PAYLOAD_BYTES);
const CURSOR_RESERVE_BYTES = 2048;
type HistoryCursor = { version: 1; chat: string; id: string; createdAt: string };

function chatBinding(chatId: string): string {
  return createHash("sha256").update(chatId).digest("hex");
}

function decodeCursor(chatId: string, cursor: string): HistoryCursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/.test(cursor)) throw new Error();
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw new Error();
    const value = JSON.parse(bytes.toString("utf8")) as HistoryCursor;
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "chat,createdAt,id,version"
      || value.version !== 1 || value.chat !== chatBinding(chatId)
      || typeof value.id !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(value.id)
      // Imported/source turns may use an ISO offset or omit milliseconds.
      // Keep the exact stored text: SQLite's cursor order is textual, not Date.parse order.
      || typeof value.createdAt !== "string" || value.createdAt.length < 1 || value.createdAt.length > 128
      || /[\u0000-\u001f\u007f]/.test(value.createdAt)
      || !Number.isFinite(Date.parse(value.createdAt))) throw new Error();
    return value;
  } catch {
    throw new TypeError("Invalid history cursor for this chat");
  }
}

export function readMobileBridgeHistoryPage(
  chatId: string,
  limit = 200,
  cursor?: string,
): MobileBridgeChatHistoryPageDto {
  const before = cursor === undefined ? undefined : decodeCursor(chatId, cursor);
  const page = listChatMessagesPage(chatId, limit, before);
  const messages = projectMobileBridgeHistory(
    page.messages, limit, MOBILE_BRIDGE_HISTORY_PAGE_BYTES - CURSOR_RESERVE_BYTES, chatId,
  );
  if (page.messages.length && !messages.length) {
    // Never return an empty continuation that would silently skip the oversized row.
    throw new RangeError("History message exceeds the mobile page budget");
  }
  const hasOlder = page.hasOlder || messages.length < page.messages.length;
  const oldest = messages[0];
  const nextCursor = hasOlder && oldest
    ? Buffer.from(JSON.stringify({
        version: 1, chat: chatBinding(chatId), id: oldest.id, createdAt: oldest.createdAt,
      } satisfies HistoryCursor)).toString("base64url")
    : null;
  // Validate generated cursors too: malformed legacy metadata must never escape.
  if (nextCursor) decodeCursor(chatId, nextCursor);
  const result = { messages, hasOlder, nextCursor };
  if (mobileBridgeJsonBytes(result) > MOBILE_BRIDGE_HISTORY_PAGE_BYTES) {
    throw new RangeError("History page exceeds the mobile page budget");
  }
  return result;
}
