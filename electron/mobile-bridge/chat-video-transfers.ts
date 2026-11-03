import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { hasChatFileMessageBinding } from "../store/chat-file-message-bindings";
import { VideoCancelFence } from "./video-cancel-fence";

/** Bounds are independent of the WebSocket/relay queue. This class never exposes a host path. */
export const CHAT_VIDEO_CHUNK_BYTES = 1024 * 1024;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_TRANSFERS = 4;
const TTL_MS = 10 * 60_000;
const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm", "video/x-m4v", "video/ogg"]);
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export interface ChatVideoPrincipal { deviceId: string; connectionId: string }
export interface ChatVideoBinding { chatId: string; messageId: string; groupId: string; fileId: string }
interface VideoRow { mediaType: string; size: number; sha256: string }
interface Transfer {
  id: string; principal: ChatVideoPrincipal; binding: ChatVideoBinding; row: VideoRow;
  expiresAt: number; hashes: string[]; closed: boolean; preparing: boolean; prepared: boolean; assertChat: () => void;
}

/** Local-only source for a verified owner attachment. No arbitrary file/path, task, URL or legacy marker is accepted. */
export class ChatVideoTransfers {
  private readonly transfers = new Map<string, Transfer>();
  private readonly cancelFence: VideoCancelFence;
  private disposed = false;
  constructor(private readonly db: Database.Database | (() => Database.Database), private readonly assertCurrent: (principal: ChatVideoPrincipal) => void,
    private readonly now: () => number = Date.now, private readonly captureChat?: (chatId:string) => () => void) { this.cancelFence = new VideoCancelFence(now); }
  private get database(): Database.Database { return typeof this.db === "function" ? this.db() : this.db; }

  private row(binding: ChatVideoBinding): VideoRow | null {
    if (!binding.chatId || binding.chatId.length > 256 || !UUID.test(binding.messageId)
      || !UUID.test(binding.groupId) || !UUID.test(binding.fileId)) return null;
    if (!hasChatFileMessageBinding(this.database, binding)) return null;
    const row = this.database.prepare(`SELECT i.media_type AS mediaType, i.size_bytes AS size, i.sha256 AS sha256,
      length(i.data) AS actualSize FROM chat_file_items i JOIN chats c ON c.id=i.chat_id AND c.archived_at IS NULL
      WHERE i.id=? AND i.group_id=? AND i.chat_id=? AND i.kind='file'`).get(binding.fileId, binding.groupId, binding.chatId) as
      (VideoRow & { actualSize: number }) | undefined;
    if (!row || !VIDEO_TYPES.has(row.mediaType) || !Number.isSafeInteger(row.size) || row.size < 1
      || row.size > MAX_BYTES || row.actualSize !== row.size || !SHA256.test(row.sha256)) return null;
    return { mediaType: row.mediaType, size: row.size, sha256: row.sha256 };
  }

  private current(transfer: Transfer): void {
    try {
      if (this.disposed || transfer.closed || this.transfers.get(transfer.id) !== transfer || this.now() >= transfer.expiresAt) throw new Error("chat_video_closed");
      this.assertCurrent(transfer.principal);
      transfer.assertChat();
      const row = this.row(transfer.binding);
      if (!row || row.size !== transfer.row.size || row.mediaType !== transfer.row.mediaType || row.sha256 !== transfer.row.sha256) throw new Error("chat_video_source_changed");
    } catch (error) { this.closeOwned(transfer); throw error; }
  }

  private bytes(transfer: Transfer, offset: number, length: number): Buffer {
    const row = this.database.prepare(`SELECT substr(data, ?, ?) AS bytes FROM chat_file_items
      WHERE id=? AND group_id=? AND chat_id=? AND kind='file' AND size_bytes=? AND sha256=?`)
      .get(offset + 1, length, transfer.binding.fileId, transfer.binding.groupId, transfer.binding.chatId,
        transfer.row.size, transfer.row.sha256) as { bytes?: unknown } | undefined;
    if (!Buffer.isBuffer(row?.bytes) || row.bytes.length !== length) throw new Error("chat_video_source_changed");
    return row.bytes;
  }

  open(principal: ChatVideoPrincipal, binding: ChatVideoBinding, requestedId = randomBytes(32).toString("hex")): { transferId: string; size: number; mediaType: string; sha256: string; chunkBytes: number; expiresAt: number } {
    this.sweep();
    this.assertCurrent(principal);
    this.cancelFence.assertOpen(principal, requestedId);
    if (this.transfers.has(requestedId)) throw new Error("chat_video_unavailable");
    if (this.disposed || !principal.deviceId || !principal.connectionId || this.transfers.size >= MAX_TRANSFERS
      || [...this.transfers.values()].some((transfer) => transfer.principal.deviceId === principal.deviceId)) throw new Error("chat_video_unavailable");
    const assertChat = this.captureChat?.(binding.chatId) ?? (() => {}); assertChat();
    const row = this.row(binding);
    if (!row) throw new Error("chat_video_unavailable");
    const id = requestedId;
    const transfer: Transfer = { id, principal: { ...principal }, binding: { ...binding }, row, expiresAt: this.now() + TTL_MS, hashes: [], closed: false, preparing: false, prepared: false, assertChat };
    this.transfers.set(id, transfer);
    return { transferId: id, size: row.size, mediaType: row.mediaType, sha256: row.sha256, chunkBytes: CHAT_VIDEO_CHUNK_BYTES, expiresAt: transfer.expiresAt };
  }

  /** A separate awaitable preparation lets the owner close the issued ID during hashing. */
  async prepare(principal: ChatVideoPrincipal, id: string): Promise<void> {
    const transfer = this.transfersForPrincipal(principal, id);
    this.current(transfer);
    if (transfer.preparing || transfer.prepared) throw new Error("chat_video_prepare_invalid");
    transfer.preparing = true;
    try {
      const digest = createHash("sha256");
      for (let offset = 0; offset < transfer.row.size; offset += CHAT_VIDEO_CHUNK_BYTES) {
        this.current(transfer);
        const bytes = this.bytes(transfer, offset, Math.min(CHAT_VIDEO_CHUNK_BYTES, transfer.row.size - offset));
        digest.update(bytes); transfer.hashes.push(createHash("sha256").update(bytes).digest("hex"));
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      this.current(transfer);
      if (digest.digest("hex") !== transfer.row.sha256) throw new Error("chat_video_source_changed");
      transfer.prepared = true;
    } catch (error) { this.closeOwned(transfer); throw error; }
    finally { transfer.preparing = false; }
  }

  private transfersForPrincipal(principal: ChatVideoPrincipal, id: string): Transfer {
    const transfer = this.transfers.get(id);
    if (!transfer || transfer.principal.deviceId !== principal.deviceId || transfer.principal.connectionId !== principal.connectionId) throw new Error("chat_video_unavailable");
    return transfer;
  }

  read(principal: ChatVideoPrincipal, id: string, offset: number): { offset: number; base64: string; sha256: string } {
    const transfer = this.transfersForPrincipal(principal, id);
    this.current(transfer);
    if (!transfer.prepared) throw new Error("chat_video_not_prepared");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= transfer.row.size || offset % CHAT_VIDEO_CHUNK_BYTES !== 0) throw new Error("chat_video_range_invalid");
    let bytes: Buffer;
    try { bytes = this.bytes(transfer, offset, Math.min(CHAT_VIDEO_CHUNK_BYTES, transfer.row.size - offset)); }
    catch (error) { this.closeOwned(transfer); throw error; }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== transfer.hashes[offset / CHAT_VIDEO_CHUNK_BYTES]) { this.closeOwned(transfer); throw new Error("chat_video_source_changed"); }
    this.current(transfer);
    return { offset, base64: bytes.toString("base64"), sha256 };
  }

  close(principal: ChatVideoPrincipal, id: string): void {
    this.cancelFence.cancel(principal, id);
    const transfer = this.transfers.get(id);
    if (transfer && transfer.principal.deviceId === principal.deviceId && transfer.principal.connectionId === principal.connectionId) this.closeOwned(transfer);
  }
  closeConnection(principal: ChatVideoPrincipal): void {
    this.cancelFence.cancelConnection(principal);
    for (const transfer of this.transfers.values()) if (transfer.principal.deviceId === principal.deviceId && transfer.principal.connectionId === principal.connectionId) this.closeOwned(transfer);
  }
  dispose(): void { this.disposed = true; for (const transfer of this.transfers.values()) this.closeOwned(transfer); }
  private closeOwned(transfer: Transfer): void { transfer.closed = true; this.transfers.delete(transfer.id); }
  private sweep(): void { for (const transfer of this.transfers.values()) if (this.now() >= transfer.expiresAt) this.closeOwned(transfer); }
}
