import { createHash, randomUUID, type Hash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CHAT_FILE_STORE_MAX_BYTES, ONE_ATTACHMENT_LIMITS } from "../../shared/one-attachments";
import { chatFileMediaType, hasExpectedImageSignature, persistChatFileStagedFiles } from "../store/chat-message-attachments";
import { userDataPath } from "../runtime-paths";
import { MobileBridgeRefusal, type MobileBridgeSpecificRefusalCode } from "../../shared/mobile-bridge-refusal";

/** Raw bytes per chunk. Base64 of one chunk (≤1,398,104 chars) stays far below the 30 MiB bridge message and the relay's 8 MiB buffer. */
export const MOBILE_ATTACHMENT_CHUNK_BYTES = 1024 * 1024;
/** Transfers in progress per device. A protection for the bridge, not a limit on what is attached: the phone retries after `attachment_upload_busy`. */
const MAX_UNFINISHED_UPLOADS_PER_DEVICE = 4;
/** Room the store needs besides the staged copy: the database row and its WAL copy exist together for a moment. */
const DISK_HEADROOM_BYTES = 64 * 1024 * 1024;
/** How often staged uploads are checked for expiry while any exist. */
const SWEEP_INTERVAL_MS = 5 * 60_000;
const STAGING_DIR_NAME = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const OWNER_MARKER = "owner.json";
const PICTURE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type MobileAttachmentScope = "chat" | "build";

/**
 * A refusal the owner can act on reaches a `refusal.specific.v1` phone with its own code and this plain message
 * (shared/mobile-bridge-refusal.ts); every other phone keeps `authority_error`. Malformed requests stay plain errors.
 */
const OWNER_ACTIONABLE = new Set<string>(["attachment_disk_full", "attachment_file_too_large_for_store", "attachment_upload_busy", "build_attachments_unavailable"]);
export class MobileAttachmentUploadError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "MobileAttachmentUploadError";
    this.code = code;
  }
}
function uploadError(code: string, message?: string): Error {
  return OWNER_ACTIONABLE.has(code)
    ? new MobileBridgeRefusal(code as MobileBridgeSpecificRefusalCode, message ?? code)
    : new MobileAttachmentUploadError(code, message);
}

/**
 * Two files with the same name are two files, not an error. A phone's picker hands over `image.jpg` twice (two shots with the same
 * name from different albums, a second `report.pdf` from another folder), and the whole send used to fail with
 * attachment_name_collision, on every retry, in every phone build. The second keeps its bytes under `name (2).ext`; the phone still finds
 * it by `sourceName` (its own name), which is unchanged. Names compare case-insensitively, as before.
 */
function uniqueAttachmentName(name: string, taken: ReadonlySet<string>): string {
  const key = (value: string) => value.toLocaleLowerCase("en-US");
  if (!taken.has(key(name))) return name;
  const extension = path.extname(name), stem = name.slice(0, name.length - extension.length);
  for (let n = 2; n < 100_000; n += 1) {
    const suffix = ` (${n})${extension}`;
    const candidate = `${stem.slice(0, Math.max(1, 180 - suffix.length))}${suffix}`;
    if (!taken.has(key(candidate))) return candidate;
  }
  throw uploadError("attachment_name_collision");
}

type StagedFile = { name: string; sourceName: string; size: number; received: number; path: string; hash: Hash; sha256?: string };
type Upload = {
  id: string; deviceId: string; chatId?: string; scope: MobileAttachmentScope; groupId: string; finished: boolean; expiresAt: number;
  dir: string; files: StagedFile[]; result?: ReturnType<typeof persistChatFileStagedFiles>; claimedBy?: string;
};

function freeBytes(directory: string): number | null {
  try {
    const stat = fs.statfsSync(directory);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null;
  }
}

function megabytes(bytes: number): string {
  return `${Math.ceil(bytes / (1024 * 1024))} MB`;
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException)?.code === "EPERM"; }
}

/**
 * Process-local, device-bound uploads (media-carousel: no count or size limit). Received chunks go straight to a
 * Main-owned staging file, never into memory, and are hashed as they arrive. Partial bytes never become a conversation
 * attachment. A `chat` upload becomes a conversation file group when it is bound; a `build` upload is claimed once by a
 * remote Build and handed to the builder as files.
 */
export class MobileChatAttachmentUploads {
  private readonly uploads = new Map<string, Upload>();
  private rootChecked = false;

  constructor(private readonly stagingRoot: () => string = () => userDataPath("mobile-attachment-uploads"), private readonly now: () => number = Date.now) {}

  private root(): string {
    const root = this.stagingRoot();
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!this.rootChecked) {
      this.rootChecked = true;
      this.removeOrphanedStaging(root);
    }
    return root;
  }

  /** Staging another process left (it crashed or quit mid-upload). Only folders this module made, and only when their owner is gone. */
  private removeOrphanedStaging(root: string): void {
    let names: string[] = [];
    try { names = fs.readdirSync(root); } catch { return; }
    for (const name of names) {
      if (!STAGING_DIR_NAME.test(name)) continue;
      const directory = path.join(root, name);
      try {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        let owner: { pid?: unknown } | null = null;
        try { owner = JSON.parse(fs.readFileSync(path.join(directory, OWNER_MARKER), "utf8")) as { pid?: unknown }; } catch { owner = null; }
        const pid = typeof owner?.pid === "number" ? owner.pid : NaN;
        if (pid === process.pid || processAlive(pid)) continue;
        if (!owner && this.now() - stat.mtimeMs < ONE_ATTACHMENT_LIMITS.capabilityTtlMs) continue;
        fs.rmSync(directory, { recursive: true, force: true });
      } catch { /* a folder that cannot be read stays; it is never guessed at */ }
    }
  }

  private discard(upload: Upload): void {
    this.uploads.delete(upload.id);
    try { fs.rmSync(upload.dir, { recursive: true, force: true }); } catch { /* removed again at the next start */ }
  }

  private sweep(): void {
    for (const upload of [...this.uploads.values()]) {
      if (upload.claimedBy) continue;
      if (upload.expiresAt < this.now()) this.discard(upload);
    }
    if (!this.uploads.size && this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * An abandoned upload's staged files (possibly gigabytes) go when it expires, not only when the next upload arrives
   * (D-6). The timer exists only while something is staged and never keeps the process alive.
   */
  private sweepTimer: NodeJS.Timeout | null = null;
  private armSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  begin(deviceId: string, chatId: string | undefined, files: Array<{ name: string; size: number }>, scope: MobileAttachmentScope = "chat"): { uploadId: string; chunkBytes: number } {
    this.sweep();
    if (scope !== "chat" && scope !== "build") throw uploadError("attachment_scope_invalid");
    if (scope === "build" && chatId) throw uploadError("attachment_scope_invalid", "A build upload belongs to no conversation.");
    if (!Array.isArray(files) || !files.length) throw uploadError("attachment_count_invalid");
    const unfinished = [...this.uploads.values()].filter(upload => upload.deviceId === deviceId && !upload.finished).length;
    if (unfinished >= MAX_UNFINISHED_UPLOADS_PER_DEVICE) throw uploadError("attachment_upload_busy", "Other attachments from this phone are still arriving; send again when they finish.");
    const names = new Set<string>();
    const prepared = files.map(file => {
      if (!file || typeof file.name !== "string" || !file.name || file.name.length > 180 || /[\\/:\u0000-\u001f\u007f]/u.test(file.name) || file.name.startsWith(".")) throw uploadError("attachment_name_invalid");
      const picked = file.name.normalize("NFKC").trim();
      if (!picked || /[\\/:\u0000-\u001f\u007f]/u.test(picked) || picked.startsWith(".")) throw uploadError("attachment_name_invalid");
      if (!Number.isSafeInteger(file.size) || file.size < 0) throw uploadError("attachment_metadata_invalid");
      if (file.size > CHAT_FILE_STORE_MAX_BYTES) throw uploadError("attachment_file_too_large_for_store", `${file.name} is ${megabytes(file.size)}; one attachment can be at most ${CHAT_FILE_STORE_MAX_BYTES / 1_000_000} MB.`);
      const name = uniqueAttachmentName(picked, names);
      names.add(name.toLocaleLowerCase("en-US"));
      return { name, sourceName: file.name, size: file.size };
    });
    const total = prepared.reduce((sum, file) => sum + file.size, 0);
    const root = this.root();
    const pendingElsewhere = [...this.uploads.values()].filter(upload => !upload.finished).reduce((sum, upload) => sum + upload.files.reduce((n, file) => n + file.size - file.received, 0), 0);
    const available = freeBytes(root);
    const needed = 2 * total + pendingElsewhere + DISK_HEADROOM_BYTES;
    if (available !== null && available < needed) {
      throw uploadError("attachment_disk_full", `Desktop disk is full: these attachments need ${megabytes(needed)} free, ${megabytes(available)} is left.`);
    }
    const uploadId = randomUUID();
    const dir = path.join(root, uploadId);
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, OWNER_MARKER), JSON.stringify({ pid: process.pid, createdAt: new Date(this.now()).toISOString(), scope }), { mode: 0o600 });
    const staged: StagedFile[] = prepared.map((file, index) => {
      const target = path.join(dir, `${index}.part`);
      fs.writeFileSync(target, Buffer.alloc(0), { mode: 0o600, flag: "wx" });
      return { ...file, received: 0, path: target, hash: createHash("sha256") };
    });
    this.uploads.set(uploadId, { id: uploadId, deviceId, chatId, scope, groupId: randomUUID(), finished: false, expiresAt: this.now() + ONE_ATTACHMENT_LIMITS.capabilityTtlMs, dir, files: staged });
    this.armSweep();
    return { uploadId, chunkBytes: MOBILE_ATTACHMENT_CHUNK_BYTES };
  }

  private require(deviceId: string, uploadId: string): Upload {
    this.sweep();
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.deviceId !== deviceId) throw uploadError("attachment_upload_unavailable");
    return upload;
  }

  chunk(deviceId: string, input: { uploadId: string; fileIndex: number; offset: number; data: string }): { receivedBytes: number } {
    const upload = this.require(deviceId, input.uploadId), file = upload.files[input.fileIndex];
    if (upload.finished || !Number.isSafeInteger(input.fileIndex) || !file || !Number.isSafeInteger(input.offset) || input.offset !== file.received) throw uploadError("attachment_chunk_offset_invalid");
    if (typeof input.data !== "string" || input.data.length > Math.ceil(MOBILE_ATTACHMENT_CHUNK_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)) throw uploadError("attachment_chunk_invalid");
    const bytes = Buffer.from(input.data, "base64");
    if (!bytes.length || bytes.length > MOBILE_ATTACHMENT_CHUNK_BYTES || bytes.toString("base64") !== input.data || file.received + bytes.length > file.size) throw uploadError("attachment_chunk_size_invalid");
    try {
      const fd = fs.openSync(file.path, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        let written = 0;
        while (written < bytes.length) {
          const wrote = fs.writeSync(fd, bytes, written, bytes.length - written, file.received + written);
          if (wrote <= 0) throw uploadError("attachment_write_failed");
          written += wrote;
        }
      } finally { fs.closeSync(fd); }
    } catch (error) {
      if (error instanceof MobileAttachmentUploadError || error instanceof MobileBridgeRefusal) throw error;
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOSPC" || code === "EDQUOT") {
        this.discard(upload);
        throw uploadError("attachment_disk_full", `Desktop disk filled up while ${file.sourceName} was arriving.`);
      }
      throw uploadError("attachment_write_failed", `Desktop could not save ${file.sourceName}.`);
    }
    file.hash.update(bytes);
    file.received += bytes.length;
    // A long transfer keeps its upload alive: the window counts from the last chunk, not from begin.
    upload.expiresAt = this.now() + ONE_ATTACHMENT_LIMITS.capabilityTtlMs;
    return { receivedBytes: file.received };
  }

  finish(deviceId: string, uploadId: string): { fileGroupId: string; files: Array<Record<string, unknown>> } {
    const upload = this.require(deviceId, uploadId);
    if (!upload.finished) {
      if (upload.files.some(file => file.received !== file.size)) throw uploadError("attachment_upload_incomplete");
      for (const file of upload.files) {
        const mediaType = chatFileMediaType(file.name);
        if (PICTURE_TYPES.has(mediaType)) {
          const head = Buffer.alloc(Math.min(16, file.size));
          const fd = fs.openSync(file.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
          try { fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
          if (!hasExpectedImageSignature(head, mediaType)) throw uploadError("attachment_image_signature_invalid", `${file.sourceName} is not the picture its name says.`);
        }
        file.sha256 = file.hash.digest("hex");
      }
      upload.finished = true;
    }
    if (upload.scope === "chat" && upload.chatId && !upload.result) this.bind(deviceId, upload.groupId, upload.chatId);
    return {
      fileGroupId: upload.groupId,
      files: upload.result
        ? upload.result.files.map((file, index) => ({ sourceName: upload.files[index].sourceName, attachmentId: file.id, groupId: file.groupId, name: file.name, mediaType: file.mediaType, size: file.size, sha256: file.sha256, kind: file.kind }))
        : upload.files.map(file => ({ sourceName: file.sourceName, groupId: upload.groupId, name: file.name, mediaType: chatFileMediaType(file.name), size: file.size, sha256: file.sha256, kind: "file" })),
    };
  }

  /** The paired device may bind its freshly uploaded `chat` group to exactly one conversation. */
  bind(deviceId: string, groupId: string, chatId: string): void {
    this.sweep();
    const upload = [...this.uploads.values()].find(item => item.groupId === groupId);
    if (!upload || upload.deviceId !== deviceId || upload.scope !== "chat" || !upload.finished || (upload.chatId && upload.chatId !== chatId)) throw uploadError("attachment_upload_unavailable");
    if (!upload.result) {
      upload.result = persistChatFileStagedFiles({ chatId, groupId, files: upload.files.map(file => ({ name: file.name, path: file.path, size: file.size })) });
      upload.chatId = chatId;
      // The bytes now live in the conversation store; the staged copies are not needed again.
      try { fs.rmSync(upload.dir, { recursive: true, force: true }); } catch { /* removed at the next start */ }
    }
  }

  /**
   * A remote Build takes its `build` group exactly once. The files stay on disk, owned by this claim, until releaseBuild.
   * Anything else (another device, an unfinished or chat upload, a second claim) is refused, never ignored.
   */
  claimBuild(deviceId: string, groupId: string, claimant: string): Array<{ name: string; path: string; size: number; mediaType: string }> {
    this.sweep();
    const upload = [...this.uploads.values()].find(item => item.groupId === groupId);
    if (!upload || upload.deviceId !== deviceId || upload.scope !== "build" || !upload.finished || upload.claimedBy) throw uploadError("build_attachments_unavailable", "The files for this build are no longer on Desktop. Attach them again.");
    for (const file of upload.files) {
      const stat = fs.lstatSync(file.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size) throw uploadError("build_attachments_unavailable", "The files for this build changed on Desktop. Attach them again.");
    }
    upload.claimedBy = claimant;
    return upload.files.map(file => {
      const named = path.join(upload.dir, "named", file.name);
      fs.mkdirSync(path.dirname(named), { recursive: true, mode: 0o700 });
      if (!fs.existsSync(named)) fs.renameSync(file.path, named);
      file.path = named;
      return { name: file.name, path: named, size: file.size, mediaType: chatFileMediaType(file.name) };
    });
  }

  /** Every claim of this claimant ends: its staged files are removed. */
  releaseBuild(claimant: string): void {
    for (const upload of [...this.uploads.values()]) if (upload.claimedBy === claimant) this.discard(upload);
  }

  /** Removes everything this process staged (bridge shutdown). */
  dispose(): void {
    for (const upload of [...this.uploads.values()]) this.discard(upload);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}
