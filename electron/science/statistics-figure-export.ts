import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import sharp from "sharp";

import {
  SCIENCE_STATISTICS_FIGURE_RENDERER_VERSION,
  validateScienceStatisticsFigureArtifactPayload,
  type ScienceStatisticsFigureArtifactPayload,
} from "../../shared/science-statistics";

export const SCIENCE_STATISTICS_FIGURE_SVG_EXPORT_SCHEMA = "agentlas.science.statistics-figure-svg-export/v1" as const;
export const SCIENCE_STATISTICS_FIGURE_PNG_EXPORT_SCHEMA = "agentlas.science.statistics-figure-png-export/v1" as const;
export const SCIENCE_STATISTICS_FIGURE_PDF_EXPORT_SCHEMA = "agentlas.science.statistics-figure-pdf-export/v1" as const;
export const SCIENCE_STATISTICS_FIGURE_TIFF_EXPORT_SCHEMA = "agentlas.science.statistics-figure-tiff-export/v1" as const;

export interface ScienceStatisticsFigureSvgExport {
  schema: typeof SCIENCE_STATISTICS_FIGURE_SVG_EXPORT_SCHEMA;
  mimeType: "image/svg+xml";
  renderer: { id: "agentlas.vega"; version: string };
  sourceSpecSha256: string;
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
  svg: string;
}

export interface ScienceStatisticsFigurePngExport {
  schema: typeof SCIENCE_STATISTICS_FIGURE_PNG_EXPORT_SCHEMA;
  mimeType: "image/png";
  renderer: { id: "agentlas.vega"; version: string };
  sourceSpecSha256: string;
  sourceSvgSha256: string;
  exportProfile: "journal-raster-300dpi" | "journal-raster-600dpi";
  dpi: 300 | 600;
  widthMm: number;
  heightMm: number;
  width: number;
  height: number;
  colorSpace: "srgb";
  background: "#ffffff";
  byteSize: number;
  sha256: string;
  dataBase64: string;
}

export interface ScienceStatisticsFigurePngExportOptions {
  dpi: 300 | 600;
  widthMm?: number;
}

interface ScienceStatisticsFigurePublicationBinaryExport {
  renderer: { id: "agentlas.vega"; version: string };
  sourceSpecSha256: string;
  sourceSvgSha256: string;
  dpi: 300 | 600;
  requestedWidthMm: number;
  widthMm: number;
  heightMm: number;
  width: number;
  height: number;
  colorSpace: "srgb";
  iccProfileSha256: string;
  background: "#ffffff";
  byteSize: number;
  sha256: string;
  dataBase64: string;
}

export interface ScienceStatisticsFigurePdfExport extends ScienceStatisticsFigurePublicationBinaryExport {
  schema: typeof SCIENCE_STATISTICS_FIGURE_PDF_EXPORT_SCHEMA;
  mimeType: "application/pdf";
  exportProfile: "journal-raster-pdf-300dpi" | "journal-raster-pdf-600dpi";
  pdfVersion: "1.7";
  imageEncoding: "flate-rgb8";
  fontEmbedding: "not-applicable-rasterized";
}

export interface ScienceStatisticsFigureTiffExport extends ScienceStatisticsFigurePublicationBinaryExport {
  schema: typeof SCIENCE_STATISTICS_FIGURE_TIFF_EXPORT_SCHEMA;
  mimeType: "image/tiff";
  exportProfile: "journal-raster-tiff-300dpi" | "journal-raster-tiff-600dpi";
  bitsPerSample: 8;
  samplesPerPixel: 3;
  compression: "lzw";
}

export interface ScienceStatisticsFigurePublicationExportOptions {
  dpi: 300 | 600;
  widthMm?: number;
  colorSpace?: "srgb";
}

export interface ScienceStatisticsFigureSvgPreviewPng {
  mimeType: "image/png";
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
  dataBase64: string;
}

interface VegaViewLike {
  initialize(): VegaViewLike;
  runAsync(): Promise<VegaViewLike>;
  toSVG(scaleFactor?: number): Promise<string>;
  width(): number;
  height(): number;
  finalize(): void;
}

interface VegaModuleLike {
  parse(spec: unknown): unknown;
  View: new (runtime: unknown, options: { renderer: "none" }) => VegaViewLike;
}

const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<VegaModuleLike>;

function safeDimension(value: unknown, label: string): number {
  const dimension = Number(value);
  if (!Number.isFinite(dimension) || dimension < 1 || dimension > 8192) throw new Error(`science-statistics-figure-svg-${label}-invalid`);
  return Math.round(dimension);
}

function svgRootDimensions(svg: string): { width: number; height: number } {
  const root = svg.slice(0, 2_048).match(/^<svg\b[^>]*>/u)?.[0] ?? "";
  const width = root.match(/\bwidth="([0-9]+(?:\.[0-9]+)?)"/u)?.[1];
  const height = root.match(/\bheight="([0-9]+(?:\.[0-9]+)?)"/u)?.[1];
  if (width === undefined || height === undefined) throw new Error("science-statistics-figure-svg-dimensions-missing");
  return { width: safeDimension(width, "width"), height: safeDimension(height, "height") };
}

function validateRenderedSvg(svg: string): void {
  const bytes = Buffer.byteLength(svg, "utf8");
  if (!svg.startsWith("<svg ") || !svg.endsWith("</svg>") || bytes < 128 || bytes > 24 * 1024 * 1024) {
    throw new Error("science-statistics-figure-svg-invalid");
  }
  if (/<(?:script|foreignObject|iframe|object|embed|image)\b/iu.test(svg)
    || /(?:href|src)\s*=\s*["']\s*(?:https?:|file:|javascript:|data:)/iu.test(svg)) {
    throw new Error("science-statistics-figure-svg-unsafe");
  }
}

function normalizeVegaSvgResourceIds(svg: string): string {
  const resourceIds = [...svg.matchAll(/\bid="([^"]+)"/gu)].map((match) => match[1]);
  let normalized = svg;
  [...new Set(resourceIds)].forEach((resourceId, index) => {
    const stableId = `agentlas-resource-${index + 1}`;
    normalized = normalized
      .replaceAll(`id="${resourceId}"`, `id="${stableId}"`)
      .replaceAll(`url(#${resourceId})`, `url(#${stableId})`)
      .replaceAll(`href="#${resourceId}"`, `href="#${stableId}"`)
      .replaceAll(`aria-labelledby="${resourceId}"`, `aria-labelledby="${stableId}"`);
  });
  return normalized;
}

function safePublicationWidthMm(value: unknown): number {
  const widthMm = value === undefined ? 85 : Number(value);
  if (!Number.isFinite(widthMm) || widthMm < 20 || widthMm > 200) {
    throw new Error("science-statistics-figure-png-width-mm-invalid");
  }
  return Math.round(widthMm * 1000) / 1000;
}

function safePublicationDpi(value: unknown): 300 | 600 {
  if (value !== 300 && value !== 600) throw new Error("science-statistics-figure-png-dpi-invalid");
  return value;
}

function safePublicationBinaryOptions(
  value: ScienceStatisticsFigurePublicationExportOptions | Record<string, unknown>,
  format: "pdf" | "tiff",
): { dpi: 300 | 600; requestedWidthMm: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`science-statistics-figure-${format}-options-invalid`);
  }
  const options = value as Record<string, unknown>;
  const unknown = Object.keys(options).filter((key) => !["dpi", "widthMm", "colorSpace"].includes(key));
  if (unknown.some((key) => /font|embed/iu.test(key))) throw new Error(`science-statistics-figure-${format}-font-embedding-unsupported`);
  if (unknown.length) throw new Error(`science-statistics-figure-${format}-options-unknown-field`);
  if (options.colorSpace !== undefined && options.colorSpace !== "srgb") {
    throw new Error(`science-statistics-figure-${format}-color-space-unsupported`);
  }
  let dpi: 300 | 600;
  try { dpi = safePublicationDpi(options.dpi); } catch { throw new Error(`science-statistics-figure-${format}-dpi-invalid`); }
  let requestedWidthMm: number;
  try { requestedWidthMm = safePublicationWidthMm(options.widthMm); } catch { throw new Error(`science-statistics-figure-${format}-width-mm-invalid`); }
  return { dpi, requestedWidthMm };
}

function publicationGeometry(svg: ScienceStatisticsFigureSvgExport, dpi: 300 | 600, requestedWidthMm: number, format: "pdf" | "tiff") {
  const width = Math.round((requestedWidthMm / 25.4) * dpi);
  const height = Math.round(width * (svg.height / svg.width));
  if (width < 236 || height < 1 || width > 4_725 || height > 4_725 || width * height > 16_000_000) {
    throw new Error(`science-statistics-figure-${format}-pixel-boundary-invalid`);
  }
  return {
    width,
    height,
    widthMm: Math.round((width / dpi) * 25.4 * 1_000) / 1_000,
    heightMm: Math.round((height / dpi) * 25.4 * 1_000) / 1_000,
  };
}

let srgbIccProfilePromise: Promise<Buffer> | null = null;

async function exactSrgbIccProfile(): Promise<Buffer> {
  if (!srgbIccProfilePromise) {
    srgbIccProfilePromise = (async () => {
      const carrier = await sharp({ create: { width: 1, height: 1, channels: 3, background: "#ffffff" } })
        .withIccProfile("srgb")
        .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
        .toBuffer();
      const profile = (await sharp(carrier).metadata()).icc;
      if (!profile || profile.byteLength < 128 || profile.byteLength > 1024 * 1024
        || profile.subarray(36, 40).toString("ascii") !== "acsp"
        || profile.subarray(16, 20).toString("ascii") !== "RGB ") {
        throw new Error("science-statistics-figure-srgb-icc-profile-invalid");
      }
      return Buffer.from(profile);
    })();
  }
  return Buffer.from(await srgbIccProfilePromise);
}

function pdfNumber(value: number): string {
  return value.toFixed(6).replace(/(?:\.0+|(\.\d*?)0+)$/u, "$1");
}

function pdfStream(dictionary: string, bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`<< ${dictionary} /Length ${bytes.byteLength} >>\nstream\n`, "ascii"),
    bytes,
    Buffer.from("\nendstream", "ascii"),
  ]);
}

function buildDeterministicPdf(objects: Buffer[]): Buffer {
  const chunks: Buffer[] = [Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets = [0];
  let cursor = chunks[0].byteLength;
  objects.forEach((object, index) => {
    offsets.push(cursor);
    const wrapped = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, "ascii"), object, Buffer.from("\nendobj\n", "ascii"),
    ]);
    chunks.push(wrapped);
    cursor += wrapped.byteLength;
  });
  const xrefOffset = cursor;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  ].join("");
  chunks.push(Buffer.from(xref, "ascii"));
  return Buffer.concat(chunks);
}

export async function renderScienceStatisticsFigureSvg(
  value: ScienceStatisticsFigureArtifactPayload | Record<string, unknown>,
): Promise<ScienceStatisticsFigureSvgExport> {
  const payload = validateScienceStatisticsFigureArtifactPayload(value);
  const serialized = JSON.stringify(payload.spec);
  if (Buffer.byteLength(serialized, "utf8") > 3 * 1024 * 1024
    || /\b(?:https?|file|data):\/\//iu.test(serialized.replaceAll("https://vega.github.io/schema/vega/v6.json", ""))) {
    throw new Error("science-statistics-figure-svg-source-invalid");
  }
  const vega = await dynamicImport("vega");
  let view: VegaViewLike | null = null;
  try {
    view = new vega.View(vega.parse(payload.spec), { renderer: "none" }).initialize();
    await view.runAsync();
    const svg = normalizeVegaSvgResourceIds(await view.toSVG(1));
    validateRenderedSvg(svg);
    const rootDimensions = svgRootDimensions(svg);
    const byteSize = Buffer.byteLength(svg, "utf8");
    return {
      schema: SCIENCE_STATISTICS_FIGURE_SVG_EXPORT_SCHEMA,
      mimeType: "image/svg+xml",
      renderer: { id: "agentlas.vega", version: SCIENCE_STATISTICS_FIGURE_RENDERER_VERSION },
      sourceSpecSha256: payload.originalSpecSha256,
      width: Number(view.width()) >= 1 ? safeDimension(view.width(), "width") : rootDimensions.width,
      height: Number(view.height()) >= 1 ? safeDimension(view.height(), "height") : rootDimensions.height,
      byteSize,
      sha256: createHash("sha256").update(svg, "utf8").digest("hex"),
      svg,
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("science-statistics-figure-svg-")) throw error;
    throw new Error("science-statistics-figure-svg-render-failed");
  } finally {
    try { view?.finalize(); } catch {}
  }
}

/**
 * Produces a bounded on-screen preview for a persisted SVG artifact. This PNG
 * is intentionally not a publication raster profile; the exact SVG remains
 * the authoritative vector asset in the run CAS and the preview only enables
 * the normal Figure Lab inspection/validation binding flow.
 */
export async function renderScienceStatisticsFigureSvgPreviewPng(
  rendered: ScienceStatisticsFigureSvgExport,
): Promise<ScienceStatisticsFigureSvgPreviewPng> {
  if (!rendered || rendered.schema !== SCIENCE_STATISTICS_FIGURE_SVG_EXPORT_SCHEMA
    || rendered.mimeType !== "image/svg+xml"
    || !Number.isSafeInteger(rendered.width) || rendered.width < 1 || rendered.width > 8_192
    || !Number.isSafeInteger(rendered.height) || rendered.height < 1 || rendered.height > 8_192
    || rendered.width * rendered.height > 16_000_000
    || Buffer.byteLength(rendered.svg, "utf8") !== rendered.byteSize
    || createHash("sha256").update(rendered.svg, "utf8").digest("hex") !== rendered.sha256) {
    throw new Error("science-statistics-figure-vector-preview-source-invalid");
  }
  validateRenderedSvg(rendered.svg);
  try {
    const bytes = await sharp(Buffer.from(rendered.svg, "utf8"), { density: 96 })
      .flatten({ background: "#ffffff" })
      .resize({ width: rendered.width, height: rendered.height, fit: "fill", kernel: sharp.kernel.lanczos3 })
      .toColourspace("srgb")
      .png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
      .toBuffer();
    if (bytes.byteLength < 24 || bytes.byteLength > 24 * 1024 * 1024
      || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new Error("science-statistics-figure-vector-preview-invalid");
    }
    return {
      mimeType: "image/png",
      width: rendered.width,
      height: rendered.height,
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      dataBase64: bytes.toString("base64"),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("science-statistics-figure-vector-preview-")) throw error;
    throw new Error("science-statistics-figure-vector-preview-render-failed");
  }
}

export async function renderScienceStatisticsFigurePng(
  value: ScienceStatisticsFigureArtifactPayload | Record<string, unknown>,
  options: ScienceStatisticsFigurePngExportOptions,
): Promise<ScienceStatisticsFigurePngExport> {
  const dpi = safePublicationDpi(options?.dpi);
  const widthMm = safePublicationWidthMm(options?.widthMm);
  const svg = await renderScienceStatisticsFigureSvg(value);
  const aspectRatio = svg.height / svg.width;
  const width = Math.round((widthMm / 25.4) * dpi);
  const height = Math.round(width * aspectRatio);
  if (width < 236 || height < 1 || width > 4_725 || height > 4_725 || width * height > 16_000_000) {
    throw new Error("science-statistics-figure-png-pixel-boundary-invalid");
  }
  try {
    const bytes = await sharp(Buffer.from(svg.svg, "utf8"), { density: dpi })
      .flatten({ background: "#ffffff" })
      .resize({ width, height, fit: "fill", kernel: sharp.kernel.lanczos3 })
      .toColourspace("srgb")
      .png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
      .withMetadata({ density: dpi })
      .toBuffer();
    if (bytes.byteLength < 128 || bytes.byteLength > 24 * 1024 * 1024
      || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new Error("science-statistics-figure-png-invalid");
    }
    return {
      schema: SCIENCE_STATISTICS_FIGURE_PNG_EXPORT_SCHEMA,
      mimeType: "image/png",
      renderer: svg.renderer,
      sourceSpecSha256: svg.sourceSpecSha256,
      sourceSvgSha256: svg.sha256,
      exportProfile: dpi === 600 ? "journal-raster-600dpi" : "journal-raster-300dpi",
      dpi,
      widthMm,
      heightMm: Math.round((height / dpi) * 25.4 * 1000) / 1000,
      width,
      height,
      colorSpace: "srgb",
      background: "#ffffff",
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      dataBase64: bytes.toString("base64"),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("science-statistics-figure-png-")) throw error;
    throw new Error("science-statistics-figure-png-render-failed");
  }
}

export async function renderScienceStatisticsFigurePdf(
  value: ScienceStatisticsFigureArtifactPayload | Record<string, unknown>,
  options: ScienceStatisticsFigurePublicationExportOptions,
): Promise<ScienceStatisticsFigurePdfExport> {
  const { dpi, requestedWidthMm } = safePublicationBinaryOptions(options, "pdf");
  const svg = await renderScienceStatisticsFigureSvg(value);
  const geometry = publicationGeometry(svg, dpi, requestedWidthMm, "pdf");
  try {
    const { data: rgb, info } = await sharp(Buffer.from(svg.svg, "utf8"), { density: dpi })
      .flatten({ background: "#ffffff" })
      .resize({ width: geometry.width, height: geometry.height, fit: "fill", kernel: sharp.kernel.lanczos3 })
      .toColourspace("srgb")
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width !== geometry.width || info.height !== geometry.height || info.channels !== 3
      || rgb.byteLength !== geometry.width * geometry.height * 3) {
      throw new Error("science-statistics-figure-pdf-raster-invalid");
    }
    const icc = await exactSrgbIccProfile();
    const pageWidthPoints = geometry.width / dpi * 72;
    const pageHeightPoints = geometry.height / dpi * 72;
    const imageBytes = deflateSync(rgb, { level: 9 });
    const iccBytes = deflateSync(icc, { level: 9 });
    const content = Buffer.from(`q\n${pdfNumber(pageWidthPoints)} 0 0 ${pdfNumber(pageHeightPoints)} 0 0 cm\n/Im0 Do\nQ\n`, "ascii");
    const bytes = buildDeterministicPdf([
      Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "ascii"),
      Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "ascii"),
      Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pdfNumber(pageWidthPoints)} ${pdfNumber(pageHeightPoints)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 6 0 R >>`, "ascii"),
      pdfStream(`/Type /XObject /Subtype /Image /Width ${geometry.width} /Height ${geometry.height} /ColorSpace [/ICCBased 5 0 R] /BitsPerComponent 8 /Filter /FlateDecode`, imageBytes),
      pdfStream("/N 3 /Alternate /DeviceRGB /Filter /FlateDecode", iccBytes),
      pdfStream("", content),
    ]);
    if (bytes.byteLength < 512 || bytes.byteLength > 32 * 1024 * 1024
      || bytes.subarray(0, 8).toString("latin1") !== "%PDF-1.7"
      || !bytes.subarray(-6).equals(Buffer.from("%%EOF\n", "ascii"))) {
      throw new Error("science-statistics-figure-pdf-invalid");
    }
    return {
      schema: SCIENCE_STATISTICS_FIGURE_PDF_EXPORT_SCHEMA,
      mimeType: "application/pdf",
      renderer: svg.renderer,
      sourceSpecSha256: svg.sourceSpecSha256,
      sourceSvgSha256: svg.sha256,
      exportProfile: dpi === 600 ? "journal-raster-pdf-600dpi" : "journal-raster-pdf-300dpi",
      dpi,
      requestedWidthMm,
      ...geometry,
      colorSpace: "srgb",
      iccProfileSha256: createHash("sha256").update(icc).digest("hex"),
      background: "#ffffff",
      pdfVersion: "1.7",
      imageEncoding: "flate-rgb8",
      fontEmbedding: "not-applicable-rasterized",
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      dataBase64: bytes.toString("base64"),
    };
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith("science-statistics-figure-pdf-")
      || error.message === "science-statistics-figure-srgb-icc-profile-invalid")) throw error;
    throw new Error("science-statistics-figure-pdf-render-failed");
  }
}

export async function renderScienceStatisticsFigureTiff(
  value: ScienceStatisticsFigureArtifactPayload | Record<string, unknown>,
  options: ScienceStatisticsFigurePublicationExportOptions,
): Promise<ScienceStatisticsFigureTiffExport> {
  const { dpi, requestedWidthMm } = safePublicationBinaryOptions(options, "tiff");
  const svg = await renderScienceStatisticsFigureSvg(value);
  const geometry = publicationGeometry(svg, dpi, requestedWidthMm, "tiff");
  try {
    const bytes = await sharp(Buffer.from(svg.svg, "utf8"), { density: dpi })
      .flatten({ background: "#ffffff" })
      .resize({ width: geometry.width, height: geometry.height, fit: "fill", kernel: sharp.kernel.lanczos3 })
      .toColourspace("srgb")
      .removeAlpha()
      .withIccProfile("srgb")
      .withMetadata({ density: dpi })
      .tiff({ compression: "lzw", predictor: "horizontal", tile: false })
      .toBuffer();
    const metadata = await sharp(bytes).metadata();
    const icc = metadata.icc;
    const magic = bytes.subarray(0, 4).toString("hex");
    if (bytes.byteLength < 512 || bytes.byteLength > 48 * 1024 * 1024
      || !["49492a00", "4d4d002a"].includes(magic)
      || metadata.format !== "tiff" || metadata.width !== geometry.width || metadata.height !== geometry.height
      || metadata.channels !== 3 || metadata.space !== "srgb" || Math.round(metadata.density ?? 0) !== dpi
      || !icc || icc.byteLength < 128 || icc.subarray(36, 40).toString("ascii") !== "acsp"
      || icc.subarray(16, 20).toString("ascii") !== "RGB ") {
      throw new Error("science-statistics-figure-tiff-invalid");
    }
    return {
      schema: SCIENCE_STATISTICS_FIGURE_TIFF_EXPORT_SCHEMA,
      mimeType: "image/tiff",
      renderer: svg.renderer,
      sourceSpecSha256: svg.sourceSpecSha256,
      sourceSvgSha256: svg.sha256,
      exportProfile: dpi === 600 ? "journal-raster-tiff-600dpi" : "journal-raster-tiff-300dpi",
      dpi,
      requestedWidthMm,
      ...geometry,
      colorSpace: "srgb",
      iccProfileSha256: createHash("sha256").update(icc).digest("hex"),
      background: "#ffffff",
      bitsPerSample: 8,
      samplesPerPixel: 3,
      compression: "lzw",
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      dataBase64: bytes.toString("base64"),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("science-statistics-figure-tiff-")) throw error;
    throw new Error("science-statistics-figure-tiff-render-failed");
  }
}
