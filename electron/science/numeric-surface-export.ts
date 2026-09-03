import { createHash } from "node:crypto";

import {
  validateScienceNumericSurfacePngExport,
  type ScienceNumericSurfacePngExport,
} from "../../shared/science-numeric-3d";

type SharpModule = typeof import("sharp").default;
let sharpModulePromise: Promise<SharpModule> | null = null;

async function getSharp(): Promise<SharpModule> {
  if (!sharpModulePromise) {
    sharpModulePromise = import("sharp").then((module) => module.default);
  }
  return sharpModulePromise;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Main-process proof that the detached Three.js WebGL readback and the PNG
 * encoder describe the same exact top-left-origin RGBA pixels. The renderer
 * sends the normalized readback separately so a null, blank, stale, flipped,
 * or encoder-divergent canvas fails before any run or artifact is persisted.
 */
export async function validateScienceNumericSurfacePngBytes(
  value: unknown,
  pngValue: Uint8Array,
  readbackValue: Uint8Array,
): Promise<{ rendered: ScienceNumericSurfacePngExport; png: Buffer; readbackRgba: Buffer }> {
  const sharp = await getSharp();
  const rendered = validateScienceNumericSurfacePngExport(value);
  const png = Buffer.from(pngValue);
  const readbackRgba = Buffer.from(readbackValue);
  if (png.length !== rendered.byteSize || png.toString("base64") !== rendered.dataBase64
    || sha256(png) !== rendered.sha256 || readbackRgba.length !== rendered.readback.byteSize
    || sha256(readbackRgba) !== rendered.readback.rgbaSha256) {
    throw new Error("science-numeric-surface-png-bytes-invalid");
  }
  const metadata = await sharp(png, { failOn: "error", limitInputPixels: 16_000_000 }).metadata();
  if (metadata.format !== "png" || metadata.width !== rendered.width || metadata.height !== rendered.height
    || metadata.pages && metadata.pages !== 1) {
    throw new Error("science-numeric-surface-png-dimensions-invalid");
  }
  const decoded = await sharp(png, { failOn: "error", limitInputPixels: 16_000_000 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (decoded.info.width !== rendered.width || decoded.info.height !== rendered.height || decoded.info.channels !== 4
    || decoded.data.length !== readbackRgba.length || !decoded.data.equals(readbackRgba)
    || sha256(decoded.data) !== rendered.readback.rgbaSha256) {
    throw new Error("science-numeric-surface-png-readback-mismatch");
  }
  let nonBackgroundPixelCount = 0;
  for (let offset = 0; offset < decoded.data.length; offset += 4) {
    if (decoded.data[offset + 3] !== 255) throw new Error("science-numeric-surface-png-alpha-invalid");
    if (decoded.data[offset] !== 255 || decoded.data[offset + 1] !== 255 || decoded.data[offset + 2] !== 255) {
      nonBackgroundPixelCount += 1;
    }
  }
  if (nonBackgroundPixelCount !== rendered.readback.nonBackgroundPixelCount
    || nonBackgroundPixelCount < 1 || nonBackgroundPixelCount >= rendered.width * rendered.height) {
    throw new Error("science-numeric-surface-png-readback-invalid");
  }
  return { rendered, png, readbackRgba };
}
