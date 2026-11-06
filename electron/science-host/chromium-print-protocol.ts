export const CHROMIUM_PRINT_HELPER_FLAG = "--agentlas-science-print-helper";
export const CHROMIUM_PRINT_RESULT_PREFIX = "AGENTLAS_SCIENCE_PRINT_RESULT ";
export const CHROMIUM_PRINT_SCHEMA = "agentlas.science-chromium-print.v1";

/** What the helper draws: a PDF (manuscripts) or a PNG still (result cards exported as pictures). */
export type ChromiumRenderMode = "pdf" | "png";
/** maxBytes is the outputs rail's image limit (one/artifact-preview.ts MAX_IMAGE_BYTES): a picture it would not list is not made. */
export const CHROMIUM_PNG_LIMITS = Object.freeze({ minWidth: 320, maxWidth: 1920, maxHeight: 16_000, maxBytes: 24 * 1024 * 1024 });

export interface ChromiumPngOptions {
  /** CSS pixels of the page's width. */
  width?: number;
  /** 1 or 2: device pixels per CSS pixel. */
  scale?: 1 | 2;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ChromiumPdfOptions {
  signal?: AbortSignal;
  /** Caller-selected total elapsed time, including queue time. 0/default means no deadline. */
  timeoutMs?: number;
}

export interface ChromiumPrintReadiness {
  fontCount: number;
  imageCount: number;
  loadedImageCount: number;
  failedFontCount: number;
  failedStylesheetCount: number;
}

export interface ChromiumPrintReceipt extends ChromiumPrintReadiness {
  helperPid: number;
  javascript: false;
  sandbox: true;
  network: "blocked";
}

export interface ChromiumPrintResult {
  ok: boolean;
  engine: "chromium";
  bytes?: Buffer;
  /** PNG only: the picture's size in device pixels. */
  width?: number;
  height?: number;
  reason?: string;
  chromium?: ChromiumPrintReceipt;
}

export interface ChromiumHelperResult {
  schema: typeof CHROMIUM_PRINT_SCHEMA;
  requestId: string;
  ok: boolean;
  reason?: string;
  readiness?: ChromiumPrintReadiness;
  /** PNG only. */
  width?: number;
  height?: number;
}

/** Navigation errors may contain an entire manuscript encoded in a data URL. */
export function chromiumPrintFailureReason(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/data:[^\s'"<>]+/gu, "[redacted data URL]");
  const navigationCode = message.match(/\b(ERR_[A-Z_]+ \(-?\d+\))/);
  return navigationCode ? `chromium navigation failed: ${navigationCode[1]}` : message.slice(0, 500);
}
