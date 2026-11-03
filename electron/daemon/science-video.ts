import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { VideoCancelFence } from "../mobile-bridge/video-cancel-fence";
import { sameFileIdentity } from "../../shared/file-identity";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const CHUNK = 1024 * 1024;
const LIMIT = 64 * 1024 * 1024;
const MIME = new Set(["video/mp4", "video/quicktime", "video/webm", "video/x-m4v", "video/ogg"]);
export interface ScienceVideoScope { projectId: string; conversationId: string; messageId: string }
export interface ScienceVideoPrincipal { deviceId: string; connectionId: string }
interface Output { id: string; mimeType: string; byteSize: number; sha256: string; blobRef: string }
interface Run { id: string; projectId: string; conversationId: string; originMessageId: string; status: string; outputManifestSha256: string | null; outputs: Output[] }
interface Store { databasePath: string; getProject(id: string): unknown; listConversations(id: string): Array<{ id: string }>;
  getMessageForProject(projectId: string, conversationId: string, messageId: string): { visibility: string; role: string } | null;
  getResearchRunForProject(projectId: string, runId: string): Run | null }
interface Transfer { id: string; principal: ScienceVideoPrincipal; scope: ScienceVideoScope; runId: string; outputId: string; output: Output;
  expiresAt: number; closed: boolean; preparing: boolean; controller: AbortController; handle: fs.promises.FileHandle | null;
  stat: fs.BigIntStats | null; filename: string | null; timer: NodeJS.Timeout }

/** Science-owned immutable run outputs only; never accepts a path or a naked blob hash from Mobile. */
export class ScienceVideoTransfers {
  private readonly transfers = new Map<string, Transfer>();
  private disposed = false;
  constructor(private readonly store: Store, private readonly assertOwner: () => void,
    private readonly cancelFence = new VideoCancelFence()) {}
  private scope(scope: ScienceVideoScope): void {
    this.assertOwner();
    if (![scope.projectId, scope.conversationId, scope.messageId].every(value => UUID.test(value))
      || !this.store.getProject(scope.projectId) || !this.store.listConversations(scope.projectId).some(row => row.id === scope.conversationId)) throw new Error("science_video_unavailable");
    const message = this.store.getMessageForProject(scope.projectId, scope.conversationId, scope.messageId);
    if (!message || message.visibility !== "visible" || !["user", "assistant"].includes(message.role)) throw new Error("science_video_unavailable");
  }
  private output(scope: ScienceVideoScope, runId: string, outputId: string): Output {
    this.scope(scope);
    if (!UUID.test(runId) || !UUID.test(outputId)) throw new Error("science_video_unavailable");
    const run = this.store.getResearchRunForProject(scope.projectId, runId);
    if (!run || run.projectId !== scope.projectId || run.conversationId !== scope.conversationId
      || run.originMessageId !== scope.messageId || run.status !== "succeeded" || !run.outputManifestSha256 || !HASH.test(run.outputManifestSha256)) throw new Error("science_video_unavailable");
    const matches = run.outputs.filter(row => row.id === outputId);
    const output = matches.length === 1 ? matches[0] : undefined;
    if (!output || !MIME.has(output.mimeType) || !Number.isSafeInteger(output.byteSize) || output.byteSize < 1 || output.byteSize > LIMIT
      || !HASH.test(output.sha256) || output.blobRef !== `science-run-blob:sha256:${output.sha256}`) throw new Error("science_video_unavailable");
    return { id: output.id, mimeType: output.mimeType, byteSize: output.byteSize, sha256: output.sha256, blobRef: output.blobRef };
  }
  /** Cursor is an exact pair of opaque output IDs. The extra row says whether a later page exists. */
  list(scope: ScienceVideoScope, cursor?: { runId: string; outputId: string }): { items: Array<{ runId: string; outputId: string; size: number; mediaType: string }>; next: { runId: string; outputId: string } | null } {
    this.scope(scope);
    if (cursor && (!UUID.test(cursor.runId) || !UUID.test(cursor.outputId))) throw new Error("science_video_cursor_invalid");
    const db = new Database(this.store.databasePath, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare(`SELECT r.id AS runId,o.id AS outputId FROM research_runs r JOIN research_run_outputs o ON o.run_id=r.id
        WHERE r.project_id=? AND r.conversation_id=? AND r.origin_message_id=? AND r.status='succeeded'
        AND o.mime_type IN ('video/mp4','video/quicktime','video/webm','video/x-m4v','video/ogg')
        AND o.byte_size BETWEEN 1 AND ? AND o.blob_ref='science-run-blob:sha256:'||o.sha256
        AND (r.id>? OR (r.id=? AND o.id>?)) ORDER BY r.id,o.id LIMIT 51`)
        .all(scope.projectId, scope.conversationId, scope.messageId, LIMIT, cursor?.runId ?? "", cursor?.runId ?? "", cursor?.outputId ?? "") as Array<{ runId: string; outputId: string }>;
      const items = rows.slice(0, 50).map(row => { const output = this.output(scope, row.runId, row.outputId); return { ...row, size: output.byteSize, mediaType: output.mimeType }; });
      const last = items.at(-1);
      return { items, next: rows.length > 50 && last ? { runId: last.runId, outputId: last.outputId } : null };
    } finally { db.close(); }
  }
  hasVideos(projectId: string, conversationId: string, messageIds: string[]): string[] {
    if (!UUID.test(projectId) || !UUID.test(conversationId) || messageIds.length > 200 || new Set(messageIds).size !== messageIds.length
      || messageIds.some(id => !UUID.test(id))) throw new Error("science_video_scope_invalid");
    this.assertOwner();
    if (!this.store.getProject(projectId) || !this.store.listConversations(projectId).some(row => row.id === conversationId)) throw new Error("science_video_unavailable");
    const visible = messageIds.filter(id => {
      const message = this.store.getMessageForProject(projectId, conversationId, id);
      return message?.visibility === "visible" && ["user", "assistant"].includes(message.role);
    });
    if (!visible.length) return [];
    const db = new Database(this.store.databasePath, { readonly: true, fileMustExist: true });
    try {
      const placeholders = visible.map(() => "?").join(",");
      const rows = db.prepare(`SELECT DISTINCT r.origin_message_id AS id FROM research_runs r JOIN research_run_outputs o ON o.run_id=r.id
        WHERE r.project_id=? AND r.conversation_id=? AND r.origin_message_id IN (${placeholders}) AND r.status='succeeded'
        AND length(r.output_manifest_sha256)=64 AND o.mime_type IN ('video/mp4','video/quicktime','video/webm','video/x-m4v','video/ogg')
        AND o.byte_size BETWEEN 1 AND ? AND length(o.sha256)=64 AND o.sha256 NOT GLOB '*[^0-9a-f]*'
        AND o.blob_ref='science-run-blob:sha256:'||o.sha256`).all(projectId, conversationId, ...visible, LIMIT) as Array<{ id: string }>;
      this.assertOwner();
      return rows.map(row => row.id);
    } finally { db.close(); }
  }
  open(principal: ScienceVideoPrincipal, scope: ScienceVideoScope, runId: string, outputId: string, requestedId = randomBytes(32).toString("hex")): { transferId: string; expiresAt: number } {
    this.cancelFence.assertOpen(principal, requestedId);
    if (this.transfers.has(requestedId)) throw new Error("science_video_unavailable");
    if (this.disposed || !principal.deviceId || !principal.connectionId || this.transfers.size >= 4
      || [...this.transfers.values()].some(t => t.principal.deviceId === principal.deviceId)) throw new Error("science_video_unavailable");
    const output = this.output(scope, runId, outputId), id = requestedId, expiresAt = Date.now() + 10 * 60_000;
    const transfer: Transfer = { id, principal: { ...principal }, scope: { ...scope }, runId, outputId, output, expiresAt, closed: false, preparing: false,
      controller: new AbortController(), handle: null, stat: null, filename: null,
      timer: setTimeout(() => { void this.closeOwned(transfer); }, 10 * 60_000) };
    transfer.timer.unref(); this.transfers.set(id, transfer); return { transferId: id, expiresAt };
  }
  private owned(principal: ScienceVideoPrincipal, id: string): Transfer {
    const transfer = this.transfers.get(id);
    if (!transfer || transfer.principal.deviceId !== principal.deviceId || transfer.principal.connectionId !== principal.connectionId) throw new Error("science_video_unavailable");
    return transfer;
  }
  private current(t: Transfer): void {
    if (this.disposed || t.closed || Date.now() >= t.expiresAt || this.transfers.get(t.id) !== t) throw new Error("science_video_closed");
    const current = this.output(t.scope, t.runId, t.outputId);
    if (JSON.stringify(current) !== JSON.stringify(t.output)) throw new Error("science_video_source_changed");
  }
  private async identity(t: Transfer): Promise<void> {
    this.current(t);
    if (!t.handle || !t.stat || !t.filename) throw new Error("science_video_not_prepared");
    const fd = await t.handle.stat({ bigint: true }), named = await fs.promises.lstat(t.filename, { bigint: true });
    if (await fs.promises.realpath(t.filename) !== t.filename) throw new Error("science_video_source_changed");
    if (!fd.isFile() || !named.isFile() || named.isSymbolicLink() || !sameFileIdentity(fd, named)
      || fd.dev !== t.stat.dev || fd.ino !== t.stat.ino || fd.size !== t.stat.size || fd.mtimeNs !== t.stat.mtimeNs || fd.ctimeNs !== t.stat.ctimeNs
      || named.size !== fd.size || named.mtimeNs !== fd.mtimeNs || named.ctimeNs !== fd.ctimeNs) throw new Error("science_video_source_changed");
    this.current(t);
  }
  async prepare(principal: ScienceVideoPrincipal, id: string): Promise<{ size: number; mediaType: string; sha256: string; chunkBytes: number }> {
    const t = this.owned(principal, id);
    if (t.preparing || t.handle) throw new Error("science_video_prepare_invalid");
    t.preparing = true;
    let handle: fs.promises.FileHandle | null = null;
    try {
      this.current(t);
      const base = await fs.promises.realpath(path.dirname(this.store.databasePath));
      const root = path.join(base, "run-blobs", "sha256"), file = path.join(root, t.output.sha256.slice(0, 2), t.output.sha256);
      const real = await fs.promises.realpath(file);
      if (real !== file || !real.startsWith(root + path.sep)) throw new Error("science_video_unavailable");
      handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      this.current(t);
      const stat = await handle.stat({ bigint: true });
      this.current(t);
      if (!stat.isFile() || stat.size !== BigInt(t.output.byteSize)) throw new Error("science_video_source_changed");
      t.handle = handle; t.stat = stat; t.filename = file; handle = null;
      const hash = createHash("sha256");
      for (let offset = 0; offset < t.output.byteSize; offset += CHUNK) {
        await this.identity(t);
        const bytes = Buffer.allocUnsafe(Math.min(CHUNK, t.output.byteSize - offset));
        if ((await t.handle.read(bytes, 0, bytes.length, offset)).bytesRead !== bytes.length) throw new Error("science_video_source_changed");
        hash.update(bytes);
      }
      await this.identity(t);
      if (hash.digest("hex") !== t.output.sha256) throw new Error("science_video_source_changed");
      return { size: t.output.byteSize, mediaType: t.output.mimeType, sha256: t.output.sha256, chunkBytes: CHUNK };
    } catch (error) { await handle?.close().catch(() => undefined); await this.closeOwned(t); throw error; }
    finally { t.preparing = false; }
  }
  async read(principal: ScienceVideoPrincipal, id: string, offset: number): Promise<{ offset: number; base64: string; sha256: string }> {
    const t = this.owned(principal, id);
    try {
      if (t.preparing || !t.handle || !Number.isSafeInteger(offset) || offset < 0 || offset >= t.output.byteSize || offset % CHUNK !== 0) throw new Error("science_video_range_invalid");
      await this.identity(t);
      const bytes = Buffer.allocUnsafe(Math.min(CHUNK, t.output.byteSize - offset));
      if ((await t.handle.read(bytes, 0, bytes.length, offset)).bytesRead !== bytes.length) throw new Error("science_video_source_changed");
      await this.identity(t);
      return { offset, base64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
    } catch (error) { await this.closeOwned(t); throw error; }
  }
  async close(principal: ScienceVideoPrincipal, id: string): Promise<void> {
    this.cancelFence.cancel(principal, id);
    const t = this.transfers.get(id);
    if (t && t.principal.deviceId === principal.deviceId && t.principal.connectionId === principal.connectionId) await this.closeOwned(t);
  }
  closeConnection(principal: ScienceVideoPrincipal): void {
    this.cancelFence.cancelConnection(principal);
    for (const t of this.transfers.values()) if (t.principal.deviceId === principal.deviceId && t.principal.connectionId === principal.connectionId) void this.closeOwned(t);
  }
  dispose(): void { this.disposed = true; for (const t of this.transfers.values()) void this.closeOwned(t); }
  private async closeOwned(t: Transfer): Promise<void> {
    if (t.closed) return;
    t.closed = true; this.transfers.delete(t.id); clearTimeout(t.timer); t.controller.abort();
    await t.handle?.close().catch(() => undefined); t.handle = null;
  }
}
