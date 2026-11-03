/**
 * Previews of conversation attachments (media-carousel): the phone's `chat.attachment.imagePreview` and the
 * Desktop transcript's `agentlas://chat-attachment/<id>?w=<px>` thumbnails. The stored original never changes.
 *
 *   picture  → itself when it already fits, else a resized copy (image-fit.ts).
 *   video    → the first frame from the operating system's own thumbnailer (macOS QuickLook, the Windows shell), which only
 *              Electron Main has. The daemon host and Linux answer null and the screen shows a video tile instead.
 *   anything the host cannot decode (HEIC without an HEVC decoder, an unknown file) → null.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fitImage } from "./image-fit";
import { chatAttachmentPreviewSource, chatMessageAttachmentIdentity, readChatMessageAttachment } from "../store/chat-message-attachments";

/** No maxEdge asked: a stored photo is sent as it is up to these bounds, else as a 2048 px copy (CONTRACT.md "미리보기"). */
export const DEFAULT_PREVIEW_EDGE = 2048;
export const DEFAULT_PREVIEW_BYTES = 4 * 1024 * 1024;
const DEFAULT_POSTER_EDGE = 1024;
/** One bridge message is 30 MiB; base64 of 22 MiB fits with room for the envelope. */
const MAX_PREVIEW_RESPONSE_BYTES = 22 * 1024 * 1024;
/** Recent previews (a transcript re-renders its strip often). Bounded by bytes, oldest out first. */
const CACHE_MAX_BYTES = 32 * 1024 * 1024;
const CACHE_MAX_ENTRIES = 1024;
const cache = new Map<string, { mediaType: string; bytes: Buffer } | null>();
let cachedBytes = 0;

function remember(key: string, value: { mediaType: string; bytes: Buffer } | null): { mediaType: string; bytes: Buffer } | null {
  const size = value?.bytes.length ?? 0;
  if (size > CACHE_MAX_BYTES / 4) return value;
  cache.set(key, value);
  cachedBytes += size;
  while ((cachedBytes > CACHE_MAX_BYTES || cache.size > CACHE_MAX_ENTRIES) && cache.size > 0) {
    const oldest = cache.keys().next().value as string;
    cachedBytes -= cache.get(oldest)?.bytes.length ?? 0;
    cache.delete(oldest);
  }
  return value;
}

type ElectronNativeImage = { isEmpty(): boolean; getSize(): { width: number; height: number }; toJPEG(quality: number): Buffer };
type ElectronThumbnailer = { createThumbnailFromPath(path: string, size: { width: number; height: number }): Promise<ElectronNativeImage> };

/** Electron Main only (process.type "browser"); the daemon runs Electron as plain Node and has no nativeImage. */
function mainProcessThumbnailer(): ElectronThumbnailer | null {
  if ((process as NodeJS.Process & { type?: string }).type !== "browser") return null;
  if (process.platform !== "darwin" && process.platform !== "win32") return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require("electron") as { nativeImage?: ElectronThumbnailer };
    return electron.nativeImage && typeof electron.nativeImage.createThumbnailFromPath === "function" ? electron.nativeImage : null;
  } catch {
    return null;
  }
}

const VIDEO_EXTENSION_BY_TYPE: Readonly<Record<string, string>> = {
  "video/mp4": ".mp4", "video/quicktime": ".mov", "video/x-m4v": ".m4v", "video/webm": ".webm", "video/ogg": ".ogv",
  "video/3gpp": ".3gp", "video/3gpp2": ".3g2", "video/x-matroska": ".mkv", "video/x-msvideo": ".avi",
};

/** First frame of a video as JPEG, via a private temporary copy the thumbnailer can open. */
export async function videoPoster(bytes: Buffer, mediaType: string, maxEdge: number): Promise<{ mediaType: string; bytes: Buffer } | null> {
  const thumbnailer = mainProcessThumbnailer();
  if (!thumbnailer) return null;
  const extension = VIDEO_EXTENSION_BY_TYPE[mediaType];
  if (!extension) return null;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-poster-"));
  try {
    const file = path.join(directory, `video${extension}`);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    const image = await thumbnailer.createThumbnailFromPath(file, { width: maxEdge, height: maxEdge });
    if (image.isEmpty()) return null;
    const jpeg = image.toJPEG(82);
    const fitted = await fitImage(jpeg, { maxEdge, maxBytes: DEFAULT_PREVIEW_BYTES });
    return fitted ? { mediaType: fitted.mediaType, bytes: fitted.bytes } : { mediaType: "image/jpeg", bytes: jpeg };
  } catch {
    return null;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** A preview of stored bytes: pictures resized, videos as a poster frame, anything else null. */
export async function previewOfBytes(source: { mediaType: string; bytes: Buffer; sha256: string }, maxEdge?: number): Promise<{ mediaType: string; bytes: Buffer } | null> {
  return previewOf({ mediaType: source.mediaType, sha256: source.sha256, readBytes: () => source.bytes }, maxEdge);
}

/**
 * The cache is keyed by the stored sha256, which the store keeps beside the bytes: a hit never reads the bytes. Only a
 * miss reads (and the store verifies) them, once per sha256 and size (D-1).
 */
async function previewOf(source: { mediaType: string; sha256: string; readBytes(): Buffer | null }, maxEdge?: number): Promise<{ mediaType: string; bytes: Buffer } | null> {
  const key = `${source.sha256}:${maxEdge ?? "default"}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const isVideo = source.mediaType.startsWith("video/");
  if (!isVideo && (!source.mediaType.startsWith("image/") || source.mediaType === "image/svg+xml")) return remember(key, null);
  const bytes = source.readBytes();
  if (!bytes) return null; // unreadable or changed bytes: not cached, a later request reads again
  if (isVideo) return remember(key, await videoPoster(bytes, source.mediaType, maxEdge ?? DEFAULT_POSTER_EDGE));
  const fitted = await fitImage(bytes, {
    maxEdge: maxEdge ?? DEFAULT_PREVIEW_EDGE,
    maxBytes: maxEdge === undefined ? DEFAULT_PREVIEW_BYTES : Math.min(DEFAULT_PREVIEW_BYTES, Math.max(256 * 1024, maxEdge * maxEdge * 2)),
  });
  if (!fitted || fitted.bytes.length > MAX_PREVIEW_RESPONSE_BYTES) return remember(key, null);
  return remember(key, { mediaType: fitted.mediaType, bytes: fitted.bytes });
}

/** `chat.attachment.imagePreview` for a picture or video the message carries (inline picture or a file of its group). */
export async function chatAttachmentPreview(binding: { chatId: string; messageId: string; attachmentId: string }, maxEdge?: number): Promise<{ mediaType: string; bytes: Buffer } | null> {
  const source = chatAttachmentPreviewSource(binding);
  if (!source) return null;
  return previewOf(source, maxEdge);
}

/** Desktop transcript thumbnail for agentlas://chat-attachment/<id>?w=<px>; the renderer already holds this capability URL. */
export async function chatAttachmentThumbnail(id: string, edge: number): Promise<{ mediaType: string; bytes: Buffer } | null> {
  const identity = chatMessageAttachmentIdentity(id);
  if (!identity) return null;
  const readBytes = (): Buffer | null => {
    const stored = readChatMessageAttachment(id);
    return stored && (stored.sha256 || createHash("sha256").update(stored.bytes).digest("hex")) === identity.sha256 ? stored.bytes : null;
  };
  return previewOf({ mediaType: identity.mediaType, sha256: identity.sha256, readBytes }, Math.max(64, Math.min(2048, Math.floor(edge))));
}
