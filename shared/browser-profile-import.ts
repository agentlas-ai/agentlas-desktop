export const BROWSER_PROFILE_IMPORT_SCHEMA_VERSION = "agentlas.browser-profile-import.v1" as const;

export type BrowserProfileImportKind = "password" | "history";

export type BrowserProfileImportReason =
  | "invalid-request"
  | "profile-not-found"
  | "snapshot-failed"
  | "source-unavailable"
  | "unsupported-platform"
  | "decrypt-unavailable"
  | "app-bound-encryption"
  | "item-changed"
  | "vault-unavailable"
  | "vault-corrupt"
  | "history-unavailable"
  | "scope-required"
  | "operation-failed";

export interface BrowserProfilePasswordItem {
  id: string;
  origin: string;
  label: string;
  maskedUsername: string | null;
  updatedAt: string | null;
  importable: boolean;
  reason?: "unsupported-platform" | "app-bound-encryption" | "decrypt-unavailable";
}

export interface BrowserProfileHistoryItem {
  id: string;
  url: string;
  title: string;
  lastVisitedAt: string;
  visitCount: number;
  redactedQuery: boolean;
}

export interface BrowserProfileDataScanResult {
  schemaVersion: typeof BROWSER_PROFILE_IMPORT_SCHEMA_VERSION;
  ok: boolean;
  profileId: string;
  passwords: BrowserProfilePasswordItem[];
  history: BrowserProfileHistoryItem[];
  capabilities: {
    passwords: "ready" | "empty" | "unsupported" | "unavailable";
    history: "ready" | "empty" | "unavailable";
  };
  reason?: BrowserProfileImportReason;
}

export interface BrowserProfileDataImportInput {
  profileId: string;
  passwordIds: string[];
  historyIds: string[];
  /** History is task-scoped. Global Connect must omit this and cannot select history. */
  taskScopeId?: string;
  /** Only the visible confirmation action may set this literal. */
  userConfirmed: true;
}

export interface BrowserProfileImportSkip {
  kind: BrowserProfileImportKind;
  id: string;
  reason: BrowserProfileImportReason;
}

export interface BrowserProfileDataImportResult {
  schemaVersion: typeof BROWSER_PROFILE_IMPORT_SCHEMA_VERSION;
  ok: boolean;
  passwords: { imported: number; updated: number };
  history: { imported: number };
  skipped: BrowserProfileImportSkip[];
  reason?: BrowserProfileImportReason;
}

export interface BrowserProfileImportAPI {
  scan: (input: { profileId: string }) => Promise<BrowserProfileDataScanResult>;
  import: (input: BrowserProfileDataImportInput) => Promise<BrowserProfileDataImportResult>;
}
