export const BROWSER_UI_SCHEMA_VERSION = "agentlas.browser-ui.v1" as const;

export interface BrowserUiTarget {
  viewId: string;
  taskScopeId: string;
}

export type BrowserUiReason =
  | "guest-unavailable"
  | "invalid-request"
  | "operation-failed"
  | "dialog-cancelled"
  | "download-not-found"
  | "download-action-unavailable"
  | "history-unavailable";

export interface BrowserUiResult {
  ok: boolean;
  reason?: BrowserUiReason;
}

export interface BrowserNativeSessionReadiness {
  schemaVersion: typeof BROWSER_UI_SCHEMA_VERSION;
  state: "ready" | "confirmed-empty" | "unknown";
  connectSessionCount: number | null;
  nativeCookieCount: number | null;
  checkedAt: string;
  reason?: "store-unavailable" | "session-unavailable";
}

export interface BrowserFindResult extends BrowserUiResult {
  requestId?: number;
  matches?: number;
  activeMatch?: number;
  finalUpdate?: boolean;
  measurement?: "native" | "bounded-dom-count";
  countTruncated?: boolean;
}

export interface BrowserZoomResult extends BrowserUiResult {
  factor?: number;
  percent?: number;
}

export type BrowserDevicePreset = "off" | "phone" | "tablet";
export type BrowserDeviceEmulationResult =
  | { ok: true; preset: BrowserDevicePreset; width: number | null; height: number | null; deviceScaleFactor: number | null }
  | { ok: false; reason: BrowserUiReason };

export interface BrowserHistoryEntry {
  index: number;
  url: string;
  title: string;
  current: boolean;
}

export interface BrowserDurableHistoryEntry {
  id: string;
  url: string;
  title: string;
  lastVisitedAt: string;
  visitCount: number;
  redactedQuery: boolean;
}

export type BrowserDownloadState = "progressing" | "completed" | "cancelled" | "interrupted";

export interface BrowserDownloadSummary {
  id: string;
  fileName: string;
  sourceOrigin: string | null;
  state: BrowserDownloadState;
  receivedBytes: number;
  totalBytes: number | null;
  startedAt: string;
  updatedAt: string;
}

export interface BrowserClearDataResult extends BrowserUiResult {
  cleared?: Array<"history" | "downloads" | "cache" | "cookies">;
}

export interface BrowserUiAPI {
  readiness: () => Promise<BrowserNativeSessionReadiness>;
  find: (input: BrowserUiTarget & { query: string; forward?: boolean; findNext?: boolean }) => Promise<BrowserFindResult>;
  stopFind: (input: BrowserUiTarget & { action?: "clearSelection" | "keepSelection" | "activateSelection" }) => Promise<BrowserUiResult>;
  zoom: (input: BrowserUiTarget & { action: "get" | "in" | "out" | "reset" }) => Promise<BrowserZoomResult>;
  devTools: (input: BrowserUiTarget & { open: boolean }) => Promise<BrowserUiResult>;
  deviceEmulation: (input: BrowserUiTarget & { preset: BrowserDevicePreset | "get" }) => Promise<BrowserDeviceEmulationResult>;
  print: (input: BrowserUiTarget) => Promise<BrowserUiResult>;
  saveScreenshot: (input: BrowserUiTarget) => Promise<BrowserUiResult & { fileName?: string }>;
  history: (input: BrowserUiTarget & { limit?: number }) => Promise<BrowserUiResult & { entries: BrowserHistoryEntry[] }>;
  historyAll: (input: { taskScopeId: string; query?: string; limit?: number }) => Promise<BrowserUiResult & { entries: BrowserDurableHistoryEntry[] }>;
  downloads: (input: { taskScopeId: string; limit?: number }) => Promise<BrowserUiResult & { items: BrowserDownloadSummary[] }>;
  downloadAction: (input: { taskScopeId: string; id: string; action: "cancel" | "open" | "show-in-folder" | "remove" }) => Promise<BrowserUiResult>;
  clearData: (input: BrowserUiTarget & { categories: Array<"history" | "downloads" | "cache" | "cookies"> }) => Promise<BrowserClearDataResult>;
}
