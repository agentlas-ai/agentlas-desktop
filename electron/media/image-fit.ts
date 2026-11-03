/**
 * Picture resizing for what leaves the original untouched: a model's input copy (runtime/model-image-budget.ts), a phone
 * preview and a transcript thumbnail (media/attachment-preview.ts). The original bytes are never rewritten.
 *
 * sharp (libvips) is already shipped for Science (build-resources/science-runtime-package.cjs checks its native files for every
 * platform) and is an N-API module, so it loads in Electron Main and in the agentlasd daemon alike. No electron import here.
 * When it cannot load or cannot decode a picture (HEIC without an HEVC decoder, a damaged file), the answer is null and the
 * caller decides what to show; nothing here throws for a picture it cannot read.
 */
import type { Sharp, SharpOptions } from "sharp";

type SharpFactory = (input?: Buffer | SharpOptions, options?: SharpOptions) => Sharp;

let loading: Promise<SharpFactory | null> | null = null;
/** Test seam: replace the loader (null = sharp unavailable). */
export function setImageFitLoaderForTest(loader: (() => Promise<SharpFactory | null>) | null): void {
  loading = loader ? loader() : null;
}

export function loadSharp(): Promise<SharpFactory | null> {
  loading ??= (async () => {
    try {
      const mod = await import("sharp");
      const factory = ((mod as unknown as { default?: SharpFactory }).default ?? (mod as unknown as SharpFactory));
      return typeof factory === "function" ? factory : null;
    } catch {
      return null;
    }
  })();
  return loading;
}

export const PROVIDER_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface FittedImage {
  bytes: Buffer;
  mediaType: string;
  width: number;
  height: number;
  /** false when the original bytes were returned unchanged. */
  resized: boolean;
}

export interface FitImageOptions {
  /** Longest side in pixels. */
  maxEdge: number;
  /** Largest encoded size in bytes. */
  maxBytes: number;
  /** Return the original when it already fits and is a provider-safe type (default true). */
  keepOriginalWhenFits?: boolean;
  jpegQuality?: number;
}

const FORMAT_TYPES: Readonly<Record<string, string>> = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** Fit one picture inside maxEdge × maxBytes. EXIF orientation is applied, alpha keeps PNG, everything else is JPEG. */
export async function fitImage(bytes: Buffer, options: FitImageOptions): Promise<FittedImage | null> {
  const sharp = await loadSharp();
  if (!sharp || !Buffer.isBuffer(bytes) || bytes.length < 1) return null;
  try {
    const meta = await sharp(bytes, { failOn: "none", limitInputPixels: false }).metadata();
    const rawWidth = meta.width ?? 0, rawHeight = meta.height ?? 0;
    if (rawWidth < 1 || rawHeight < 1) return null;
    const rotated = (meta.orientation ?? 1) >= 5;
    const width = rotated ? rawHeight : rawWidth, height = rotated ? rawWidth : rawHeight;
    const originalType = FORMAT_TYPES[meta.format ?? ""];
    const multiFrame = (meta.pages ?? 1) > 1;
    if ((options.keepOriginalWhenFits ?? true) && originalType && !multiFrame && (meta.orientation ?? 1) === 1
      && Math.max(width, height) <= options.maxEdge && bytes.length <= options.maxBytes) {
      return { bytes, mediaType: originalType, width, height, resized: false };
    }
    const alpha = meta.hasAlpha === true;
    let edge = Math.max(16, Math.min(options.maxEdge, Math.max(width, height)));
    let quality = options.jpegQuality ?? 82;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const pipeline = sharp(bytes, { failOn: "none", limitInputPixels: false, pages: 1 })
        .rotate()
        .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true });
      const out = alpha
        ? await pipeline.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })
        : await pipeline.flatten({ background: "#ffffff" }).jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
      if (out.data.length <= options.maxBytes || edge <= 256) {
        if (out.data.length > options.maxBytes) return null;
        return { bytes: out.data, mediaType: alpha ? "image/png" : "image/jpeg", width: out.info.width, height: out.info.height, resized: true };
      }
      if (!alpha && quality > 60) quality -= 11;
      else edge = Math.max(256, Math.floor(edge * 0.75));
    }
    return null;
  } catch {
    return null;
  }
}

export interface SheetTile { bytes: Buffer; label: string }

/**
 * Several pictures as one picture: a grid, each tile captioned with its label (the picture's number in the owner's
 * order). Used when a runtime takes fewer pictures than were attached, so the model still sees every one of them.
 */
export async function contactSheet(tiles: readonly SheetTile[], options: { maxEdge: number; maxBytes: number }): Promise<FittedImage | null> {
  const sharp = await loadSharp();
  if (!sharp || tiles.length < 1) return null;
  try {
    const columns = Math.ceil(Math.sqrt(tiles.length));
    const rows = Math.ceil(tiles.length / columns);
    const cell = Math.max(96, Math.floor(options.maxEdge / columns));
    const captionHeight = Math.max(18, Math.round(cell * 0.09));
    const width = cell * columns, height = (cell + captionHeight) * rows;
    const composites: Array<{ input: Buffer; left: number; top: number }> = [];
    for (const [index, tile] of tiles.entries()) {
      const left = (index % columns) * cell, top = Math.floor(index / columns) * (cell + captionHeight);
      let picture: Buffer | null = null;
      try {
        picture = await sharp(tile.bytes, { failOn: "none", limitInputPixels: false, pages: 1 }).rotate()
          .resize({ width: cell - 4, height: cell - 4, fit: "contain", background: "#ffffff" }).png().toBuffer();
      } catch { picture = null; }
      const label = tile.label.replace(/[^\x20-\x7e]/g, "").slice(0, 24).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const caption = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${captionHeight}"><rect width="100%" height="100%" fill="#111827"/><text x="6" y="${Math.round(captionHeight * 0.75)}" font-family="Helvetica, Arial, sans-serif" font-size="${Math.round(captionHeight * 0.7)}" fill="#ffffff">${label}</text></svg>`);
      composites.push({ input: caption, left, top });
      if (picture) composites.push({ input: picture, left: left + 2, top: top + captionHeight + 2 });
    }
    const sheet = await sharp({ create: { width, height, channels: 3, background: "#ffffff" } })
      .composite(composites).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
    return fitImage(sheet, { maxEdge: options.maxEdge, maxBytes: options.maxBytes, keepOriginalWhenFits: true });
  } catch {
    return null;
  }
}
