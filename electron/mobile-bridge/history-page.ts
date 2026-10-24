import { createHash } from "node:crypto";
import type { MobileBridgeChatHistoryPageDto } from "../../shared/mobile-bridge";
import { listChatMessagesPage, listChatMessagesBeforeUiAnchor } from "../store/chats";
import { listUiInstances } from "../harness/ui-instances";
import { mergeMobileInlineUiTranscript } from "./finance-ui-transcript";
import { projectMobileBridgeHistory, type MobileBridgeHistoryConsumption, type MobileBridgeHistoryOptions } from "./projector";
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

export async function readMobileBridgeHistoryPage(
  chatId: string,
  limit = 200,
  cursor?: string,
  options: MobileBridgeHistoryOptions = {},
): Promise<MobileBridgeChatHistoryPageDto> {
  const before = cursor === undefined ? undefined : decodeCursor(chatId, cursor);
  const instances = await listUiInstances(chatId);
  const virtualAnchor = before?.id.startsWith("ui-instance:");
  if (virtualAnchor && !instances.some(instance => instance.chatId === chatId
    && `ui-instance:${instance.instanceId}` === before!.id && instance.createdAt === before!.createdAt)) {
    throw new TypeError("History UI cursor no longer matches this chat; reload the newest page");
  }
  // Closed instances retain their source metadata and can still anchor an old cursor.
  const page = virtualAnchor
    ? listChatMessagesBeforeUiAnchor(chatId, limit, before!)
    : listChatMessagesPage(chatId, limit, before);
  // One order for stored rows and UI rows (store/chats.ts readChatMessageKeyset): created_at, then stored rows in insertion
  // order, then UI rows by id. A stored row's cursor therefore has no UI row of its millisecond before it; a UI anchor has
  // every stored row of its millisecond and the UI rows whose id sorts below it.
  const isBefore = (row: { id: string; createdAt: string }) => !before
    || row.createdAt < before.createdAt || (row.createdAt === before.createdAt && virtualAnchor === true && row.id < before.id);
  const lower = page.hasOlder ? page.messages[0] : undefined;
  const inline = await mergeMobileInlineUiTranscript(chatId, page.messages, instances.filter(instance => {
    const row = { id: `ui-instance:${instance.instanceId}`, createdAt: instance.createdAt };
    return isBefore(row) && (!lower || row.createdAt >= lower.createdAt);
  }));
  const storeIndex = new Map(page.messages.map((message, index) => [message.id, index]));
  inline.history.sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
    const l = storeIndex.get(left.id), r = storeIndex.get(right.id);
    if (l !== undefined && r !== undefined) return l - r;
    if (l !== undefined || r !== undefined) return l !== undefined ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  // Housekeeping rows are walked past without being sent (NH26): paging counts and anchors on what the page consumed.
  const consumption: MobileBridgeHistoryConsumption = { consumed: 0 };
  const messages = projectMobileBridgeHistory(
    inline.history, limit, MOBILE_BRIDGE_HISTORY_PAGE_BYTES - CURSOR_RESERVE_BYTES, chatId,
    inline.fallbackByMessageId, consumption, options,
  );
  if (inline.history.length && !consumption.consumed) {
    throw new RangeError("History message exceeds the mobile page budget");
  }
  const hasOlder = page.hasOlder || consumption.consumed < inline.history.length;
  const oldest = consumption.oldest;
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
