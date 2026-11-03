import { createHash, randomBytes } from "node:crypto";
import type { OneArtifactBindingRequestV1 } from "../../shared/one-artifacts";
import { openBoundOneArtifactVideo } from "../one/artifact-preview";
const CHAT_VIDEO_CHUNK_BYTES = 1024 * 1024;
type ChatVideoPrincipal = { deviceId:string; connectionId:string };
import { VideoCancelFence } from "./video-cancel-fence";

type Reader = NonNullable<Awaited<ReturnType<typeof openBoundOneArtifactVideo>>>;
interface Transfer {
  id: string;
  principal: ChatVideoPrincipal;
  binding: OneArtifactBindingRequestV1;
  expiresAt: number;
  controller: AbortController;
  timer: NodeJS.Timeout;
  reader: Reader | null;
  preparing: boolean;
  closed: boolean;
  assertChat: () => void;
}

/** Per-connection opaque tokens; the Main reader retains the verified descriptor, never a phone-supplied path. */
export class ArtifactVideoTransfers {
  private readonly transfers = new Map<string, Transfer>();
  private readonly cancelFence: VideoCancelFence;
  private disposed = false;
  constructor(private readonly assertCurrent: (principal: ChatVideoPrincipal) => void,
    private readonly openReader: typeof openBoundOneArtifactVideo = openBoundOneArtifactVideo,
    private readonly now: () => number = Date.now, private readonly captureChat?: (chatId:string) => () => void) { this.cancelFence = new VideoCancelFence(now); }

  open(principal: ChatVideoPrincipal, binding: OneArtifactBindingRequestV1, requestedId = randomBytes(32).toString("hex")): { transferId: string; expiresAt: number } {
    this.assertCurrent(principal);
    this.cancelFence.assertOpen(principal, requestedId);
    if (this.transfers.has(requestedId)) throw new Error("artifact_video_unavailable");
    if (this.disposed || this.transfers.size >= 4 || [...this.transfers.values()].some(t => t.principal.deviceId === principal.deviceId)) throw new Error("artifact_video_unavailable");
    const assertChat = this.captureChat?.(binding.chatId) ?? (() => {}); assertChat();
    const id = requestedId, expiresAt = this.now() + 10 * 60_000;
    const transfer: Transfer = { id, principal: { ...principal }, binding: { ...binding }, expiresAt,
      controller: new AbortController(), reader: null, preparing: false, closed: false, assertChat,
      timer: setTimeout(() => { void this.closeOwned(transfer); }, 10 * 60_000) };
    transfer.timer.unref();
    this.transfers.set(id, transfer);
    return { transferId: id, expiresAt };
  }

  private owned(principal: ChatVideoPrincipal, id: string): Transfer {
    const transfer = this.transfers.get(id);
    if (!transfer || transfer.principal.deviceId !== principal.deviceId || transfer.principal.connectionId !== principal.connectionId) throw new Error("artifact_video_unavailable");
    return transfer;
  }
  private current(transfer: Transfer): void {
    if (this.disposed || transfer.closed || this.transfers.get(transfer.id) !== transfer || this.now() >= transfer.expiresAt) throw new Error("artifact_video_closed");
    this.assertCurrent(transfer.principal);
    transfer.assertChat();
  }
  async prepare(principal: ChatVideoPrincipal, id: string): Promise<{ size: number; mediaType: string; sha256: string; chunkBytes: number }> {
    const transfer = this.owned(principal, id);
    if (transfer.reader || transfer.preparing) throw new Error("artifact_video_prepare_invalid");
    transfer.preparing = true;
    let reader: Reader | null = null;
    try {
      this.current(transfer);
      reader = await this.openReader(transfer.binding, transfer.controller.signal);
      this.current(transfer);
      if (!reader) throw new Error("artifact_video_unavailable");
      transfer.reader = reader;
      return { size: reader.size, mediaType: reader.mimeType, sha256: reader.sha256, chunkBytes: CHAT_VIDEO_CHUNK_BYTES };
    } catch (error) {
      if (reader && transfer.reader !== reader) await reader.close().catch(() => undefined);
      await this.closeOwned(transfer);
      throw error;
    } finally { transfer.preparing = false; }
  }
  async read(principal: ChatVideoPrincipal, id: string, offset: number): Promise<{ offset: number; base64: string; sha256: string }> {
    const transfer = this.owned(principal, id);
    try {
      this.current(transfer);
      const reader = transfer.reader;
      if (!reader) throw new Error("artifact_video_not_prepared");
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= reader.size || offset % CHAT_VIDEO_CHUNK_BYTES !== 0) throw new Error("artifact_video_range_invalid");
      const bytes = await reader.read(offset, Math.min(CHAT_VIDEO_CHUNK_BYTES, reader.size - offset));
      this.current(transfer);
      return { offset, base64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
    } catch (error) { await this.closeOwned(transfer); throw error; }
  }
  async close(principal: ChatVideoPrincipal, id: string): Promise<void> {
    this.cancelFence.cancel(principal, id);
    const transfer = this.transfers.get(id);
    if (transfer && transfer.principal.deviceId === principal.deviceId && transfer.principal.connectionId === principal.connectionId) await this.closeOwned(transfer);
  }
  closeConnection(principal: ChatVideoPrincipal): void {
    this.cancelFence.cancelConnection(principal);
    for (const transfer of this.transfers.values()) if (transfer.principal.deviceId === principal.deviceId && transfer.principal.connectionId === principal.connectionId) void this.closeOwned(transfer);
  }
  dispose(): void { this.disposed = true; for (const transfer of this.transfers.values()) void this.closeOwned(transfer); }
  private async closeOwned(transfer: Transfer): Promise<void> {
    if (transfer.closed) return;
    transfer.closed = true;
    this.transfers.delete(transfer.id);
    clearTimeout(transfer.timer);
    transfer.controller.abort();
    await transfer.reader?.close().catch(() => undefined);
  }
}
