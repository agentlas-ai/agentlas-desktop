/**
 * agentlas://chat-attachment/<id> (media-carousel).
 *
 *   ?w=<px>      a thumbnail for the transcript strip: a picture resized, a video's first frame (attachment-preview.ts);
 *                404 when the host cannot make one (the tile then shows the file's name).
 *   Range        a byte range (206), so a video plays and seeks; the scheme is registered with stream:true (main.ts).
 *   otherwise    the whole stored bytes (200), as before.
 *
 * A long video is read from the store once and held for a short while, so the many range requests of one playback do not
 * each read hundreds of megabytes again. The stored bytes are never copied for a response (a Buffer is a Uint8Array).
 */
import { chatAttachmentThumbnail } from "./attachment-preview";

type StoredAttachment = { mediaType: string; bytes: Buffer; size: number; sha256: string };
const HOLD_MS = 60_000;
const HOLD_MIN_BYTES = 8 * 1024 * 1024;
let held: { id: string; value: StoredAttachment; timer: NodeJS.Timeout } | null = null;

function read(id: string, reader: (id: string) => StoredAttachment | null): StoredAttachment | null {
  if (held?.id === id) {
    held.timer.refresh();
    return held.value;
  }
  const value = reader(id);
  if (value && value.size >= HOLD_MIN_BYTES) {
    if (held) clearTimeout(held.timer);
    const timer = setTimeout(() => { held = null; }, HOLD_MS);
    timer.unref?.();
    held = { id, value, timer };
  }
  return value;
}

/** The same memory as a fetch body (no copy). */
function view(bytes: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
}

function headers(value: StoredAttachment, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": value.mediaType,
    "Cache-Control": "private, max-age=31536000, immutable",
    "ETag": `"sha256-${value.sha256}"`,
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
    ...extra,
  };
}

/** `bytes=a-b`, `bytes=a-`, `bytes=-n`; null for anything else (then the whole body is sent). */
export function parseByteRange(header: string | null, size: number): { start: number; end: number } | "unsatisfiable" | null {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || (match[1] === "" && match[2] === "")) return null;
  let start: number, end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(size - 1, Number(match[2]));
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

export async function serveChatAttachmentRequest(
  id: string,
  thumbnailWidth: string | null,
  rangeHeader: string | null,
  reader: (id: string) => StoredAttachment | null,
): Promise<Response> {
  if (thumbnailWidth !== null) {
    const edge = Number(thumbnailWidth);
    if (!Number.isFinite(edge) || edge < 1) return new Response("not found", { status: 404 });
    const thumb = await chatAttachmentThumbnail(id, edge).catch(() => null);
    if (!thumb) return new Response("not found", { status: 404 });
    return new Response(view(thumb.bytes), { status: 200, headers: { "Content-Type": thumb.mediaType, "Content-Length": String(thumb.bytes.length), "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" } });
  }
  const value = read(id, reader);
  if (!value) return new Response("not found", { status: 404 });
  const range = parseByteRange(rangeHeader, value.size);
  if (range === "unsatisfiable") return new Response(null, { status: 416, headers: headers(value, { "Content-Range": `bytes */${value.size}` }) });
  if (range) {
    const body = value.bytes.subarray(range.start, range.end + 1);
    return new Response(view(body), { status: 206, headers: headers(value, { "Content-Length": String(body.length), "Content-Range": `bytes ${range.start}-${range.end}/${value.size}` }) });
  }
  return new Response(view(value.bytes), { status: 200, headers: headers(value, { "Content-Length": String(value.size) }) });
}
