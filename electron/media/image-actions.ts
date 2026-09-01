import { BrowserWindow, clipboard, dialog, nativeImage, net } from "electron";
import fs from "node:fs";
import path from "node:path";
import { authorizeLocalMediaPath } from "../fs/access";

const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_DATA_URL_CHARS = Math.ceil(MAX_IMAGE_BYTES * 1.5);
const ALLOWED_AGENTLAS_IMAGE_HOSTS = new Set(["localfile", "one-artifact", "chat-attachment"]);

export type ImageActionResult = {
  ok: boolean;
  path?: string;
  canceled?: boolean;
  error?: string;
};

type LoadedImage = {
  bytes: Buffer;
  mediaType: string;
  suggestedName: string;
};

function imageExtension(mediaType: string): string {
  const normalized = mediaType.toLowerCase().split(";", 1)[0]?.trim();
  if (normalized === "image/jpeg") return ".jpg";
  if (normalized === "image/svg+xml") return ".svg";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "image/avif") return ".avif";
  return ".png";
}

function imageExtensionMatches(extension: string, mediaType: string): boolean {
  const normalized = mediaType.toLowerCase().split(";", 1)[0]?.trim() || "";
  if (normalized === "image/jpeg") return extension === ".jpg" || extension === ".jpeg";
  return extension === imageExtension(normalized);
}

function safeImageName(value: string | undefined, mediaType: string): string {
  const raw = String(value || "").trim();
  const base = path.basename(raw).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "-").slice(0, 160);
  const extension = path.extname(base).toLowerCase();
  if (base && imageExtensionMatches(extension, mediaType)) return base;
  const stem = base.replace(/\.[^.]+$/, "") || "agentlas-image";
  return `${stem}${imageExtension(mediaType)}`;
}

function actualImageMediaType(bytes: Buffer, declared = ""): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const gif = bytes.subarray(0, 6).toString("latin1");
  if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  if (
    bytes.length >= 12
    && bytes.subarray(0, 4).toString("latin1") === "RIFF"
    && bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) return "image/webp";
  if (bytes.length >= 16 && bytes.subarray(4, 8).toString("latin1") === "ftyp") {
    const brands = bytes.subarray(8, 64).toString("latin1");
    if (/(?:avif|avis)/.test(brands)) return "image/avif";
  }
  if (declared.toLowerCase() === "image/svg+xml") {
    const text = bytes.subarray(0, Math.min(bytes.length, 4_096)).toString("utf8").replace(/^\uFEFF/, "").trimStart();
    if (/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(text)) return "image/svg+xml";
  }
  return null;
}

function ensureImageBytes(bytes: Buffer, mediaType: string): void {
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error("image-size-out-of-range");
  }
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty() && mediaType.toLowerCase() !== "image/svg+xml") {
    throw new Error("image-decode-failed");
  }
}

function localImageFromAgentlasUrl(url: URL): LoadedImage | null {
  if (url.hostname !== "localfile") return null;
  const candidate = url.searchParams.get("p");
  const approved = candidate ? authorizeLocalMediaPath(candidate) : null;
  if (!approved) throw new Error("image-source-not-authorized");
  const stat = fs.statSync(approved);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) throw new Error("image-size-out-of-range");
  const bytes = fs.readFileSync(approved);
  const declared = `image/${path.extname(approved).toLowerCase() === ".jpg" ? "jpeg" : path.extname(approved).slice(1) || "png"}`;
  const mediaType = actualImageMediaType(bytes, declared);
  if (!mediaType) throw new Error("image-content-type-invalid");
  ensureImageBytes(bytes, mediaType);
  return { bytes, mediaType, suggestedName: path.basename(approved) };
}

async function loadImageSource(source: string, suggestedName?: string): Promise<LoadedImage> {
  const raw = String(source || "").trim();
  if (!raw || raw.length > MAX_DATA_URL_CHARS) throw new Error("image-source-invalid");
  const url = new URL(raw);
  if (url.protocol === "agentlas:") {
    if (!ALLOWED_AGENTLAS_IMAGE_HOSTS.has(url.hostname)) throw new Error("image-source-not-authorized");
    const local = localImageFromAgentlasUrl(url);
    if (local) return { ...local, suggestedName: safeImageName(suggestedName || local.suggestedName, local.mediaType) };
  } else if (url.protocol === "data:") {
    if (!/^data:image\//i.test(raw)) throw new Error("image-source-not-authorized");
  } else if (url.protocol !== "https:") {
    throw new Error("image-source-not-authorized");
  }

  const response = await net.fetch(raw);
  if (!response.ok) throw new Error(`image-fetch-failed:${response.status}`);
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) throw new Error("image-size-out-of-range");
  const declaredMediaType = String(response.headers.get("content-type") || "image/png").split(";", 1)[0]!.trim().toLowerCase();
  if (!declaredMediaType.startsWith("image/")) throw new Error("image-content-type-invalid");
  const bytes = Buffer.from(await response.arrayBuffer());
  const mediaType = actualImageMediaType(bytes, declaredMediaType);
  if (!mediaType) throw new Error("image-content-type-invalid");
  ensureImageBytes(bytes, mediaType);
  const urlName = url.protocol === "data:" ? undefined : decodeURIComponent(path.basename(url.pathname));
  return {
    bytes,
    mediaType,
    suggestedName: safeImageName(suggestedName || urlName, mediaType),
  };
}

export async function copyImageSource(source: string, suggestedName?: string): Promise<ImageActionResult> {
  try {
    const loaded = await loadImageSource(source, suggestedName);
    const image = nativeImage.createFromBuffer(loaded.bytes);
    if (image.isEmpty()) throw new Error("image-decode-failed");
    clipboard.writeImage(image);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function saveImageSource(
  win: BrowserWindow | null,
  source: string,
  suggestedName?: string,
): Promise<ImageActionResult> {
  try {
    const loaded = await loadImageSource(source, suggestedName);
    const chosen = await dialog.showSaveDialog(win ?? undefined!, {
      defaultPath: loaded.suggestedName,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "avif", "svg"] }],
    });
    if (chosen.canceled || !chosen.filePath) return { ok: false, canceled: true };
    const fd = fs.openSync(chosen.filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(fd, loaded.bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { ok: true, path: chosen.filePath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
