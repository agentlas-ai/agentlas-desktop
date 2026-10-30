import fs from "node:fs";
import { nativeImage } from "electron";
import { authorizeLocalMediaPath } from "./access";

const MIN_WIDTH = 64;
const MAX_WIDTH = 960;
/** Tiles repeat as a chat re-renders; a cover is never rendered twice for the same file version. */
const CACHE_ENTRIES = 48;
const cache = new Map<string, Buffer>();

const notFound = (): Response => new Response("not found", { status: 404 });

/**
 * agentlas://localthumb/?p=<abs path>&w=<px>: the system's own thumbnail of a document, its first page or slide (QuickLook on macOS,
 * the shell on Windows). Electron has none on Linux, or the system may have none for a file: that is a 404, and the tile falls back
 * to the file's name and type mark. Same root, type and realpath checks as agentlas://localfile.
 */
export async function serveLocalThumbnail(url: URL): Promise<Response> {
  const requested = url.searchParams.get("p");
  const approved = requested ? authorizeLocalMediaPath(requested) : null;
  if (!approved) return notFound();
  const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.floor(Number(url.searchParams.get("w")) || 640)));
  try {
    const stat = fs.statSync(approved);
    const key = `${approved}\0${stat.mtimeMs}\0${stat.size}\0${width}`;
    let png = cache.get(key);
    if (!png) {
      const image = await nativeImage.createThumbnailFromPath(approved, { width, height: width });
      if (image.isEmpty()) return notFound();
      png = image.toPNG();
      cache.set(key, png);
      if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
    }
    return new Response(Uint8Array.from(png), { status: 200, headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" } });
  } catch {
    return notFound();
  }
}
