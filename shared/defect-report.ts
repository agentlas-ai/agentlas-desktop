/**
 * Defect report types (decision D5). Bug report wire contract (POST https://agentlas.cloud/api/bug-reports, server 7ce5d720): exactly these fields, unknown
 * fields are a 400. Nothing is ever sent without the owner pressing Send on the exact previewed payload.
 */
export const DEFECT_REPORT_CATEGORIES = ["crash", "stall", "wrong-result", "ui", "login", "other"] as const;
export type DefectReportCategory = (typeof DEFECT_REPORT_CATEGORIES)[number];
export type DefectReportSource = "desktop-user";

export interface DefectReportPayload {
  schemaVersion: 1;
  source: DefectReportSource;
  appVersion: string;
  platform: string;
  arch: string;
  locale: string;
  title: string;
  summary: string;
  category: DefectReportCategory;
  failureCode?: string;
  runId?: string;
  /** Opaque hash of the chat id (8–128 chars); the chat id itself never leaves the machine. */
  chatRef?: string;
  steps?: string[];
  /** Redacted on this machine before preview. */
  logExcerpt?: string;
  diagnosis?: { cause: string; classification: "our-defect" | "agent-resolvable" | "human-only"; evidence: string[] };
  clientReportId: string;
}

export interface DefectReportDraftInput {
  chatId?: string | null;
  title?: string;
  summary?: string;
  category?: DefectReportCategory;
  steps?: string[];
  failureCode?: string;
  runId?: string;
}

export interface DefectReportPreview {
  clientReportId: string;
  /** Persisted state when reopening or reusing an already previewed report. */
  report?: DefectReportRow;
  /** Exactly what Send will POST. */
  payload: DefectReportPayload;
  /** How many secret/path/email spans were replaced before this preview. */
  redactions: number;
  signedIn: boolean;
}

export type DefectReportLocalStatus = "draft" | "queued" | "sent" | "failed";
export interface DefectReportRow {
  clientReportId: string;
  title: string;
  category: DefectReportCategory;
  status: DefectReportLocalStatus;
  serverId: string | null;
  /** Permanent refusal reason (400/409) or the last retryable error. */
  error: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  createdAt: string;
  /** From GET /api/bug-reports/mine when signed in. */
  remoteStatus?: string | null;
  fixedVersion?: string | null;
}
