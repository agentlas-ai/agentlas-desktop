export const CHROMIUM_PRINT_HELPER_FLAG = "--agentlas-science-print-helper";
export const CHROMIUM_PRINT_RESULT_PREFIX = "AGENTLAS_SCIENCE_PRINT_RESULT ";
export const CHROMIUM_PRINT_SCHEMA = "agentlas.science-chromium-print.v1";

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
  reason?: string;
  chromium?: ChromiumPrintReceipt;
}

export interface ChromiumHelperResult {
  schema: typeof CHROMIUM_PRINT_SCHEMA;
  requestId: string;
  ok: boolean;
  reason?: string;
  readiness?: ChromiumPrintReadiness;
}

/** Navigation errors may contain an entire manuscript encoded in a data URL. */
export function chromiumPrintFailureReason(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/data:[^\s'"<>]+/gu, "[redacted data URL]");
  const navigationCode = message.match(/\b(ERR_[A-Z_]+ \(-?\d+\))/);
  return navigationCode ? `chromium navigation failed: ${navigationCode[1]}` : message.slice(0, 500);
}
