import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { sameFileIdentity } from "../../shared/file-identity";

const RANGE_TYPES: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/x-m4v", ".mov": "video/quicktime",
  ".webm": "video/webm", ".ogv": "video/ogg",
  ".mp3": "audio/mpeg", ".mpeg": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav",
  ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac",
  ".aac": "audio/aac", ".weba": "audio/webm", ".mid": "audio/midi", ".midi": "audio/midi",
  ".pdf": "application/pdf",
};

/** Null means this is not a supported media range request; the caller may use the existing protocol. */
export function serveLocalMediaRange(file: string, rangeHeader: string | null, signal: AbortSignal): Response | null {
  const mime = RANGE_TYPES[path.extname(file).toLowerCase()];
  if (!mime || !rangeHeader) return null;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    const named = fs.lstatSync(file);
    if (!stat.isFile() || named.isSymbolicLink() || !sameFileIdentity(stat, named) || fs.realpathSync.native(file) !== file) throw new Error("changed file");
    const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
    let start = 0;
    let end = stat.size - 1;
    if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(stat.size) || stat.size < 1) {
      fs.closeSync(fd); fd = undefined;
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${stat.size}` } });
    }
    if (!match[1]) {
      const suffix = Number(match[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) start = stat.size;
      else start = Math.max(0, stat.size - suffix);
    } else {
      start = Number(match[1]);
      if (match[2]) end = Number(match[2]);
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= stat.size || end < start) {
      fs.closeSync(fd); fd = undefined;
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${stat.size}` } });
    }
    end = Math.min(end, stat.size - 1);
    const stream = fs.createReadStream(file, { fd, autoClose: true, start, end, highWaterMark: 64 * 1024 });
    fd = undefined;
    const abort = () => stream.destroy();
    signal.addEventListener("abort", abort, { once: true });
    stream.once("close", () => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: 206, headers: {
      "Content-Type": mime, "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff",
    } });
  } catch {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
    return new Response("not found", { status: 404 });
  }
}
