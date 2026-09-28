/**
 * AGI goal manager — renderer-facing types (token limits D1, defect chips + bug reports D5).
 *
 * Bug report wire contract (POST https://agentlas.cloud/api/bug-reports, server 7ce5d720): exactly these fields, unknown
 * fields are a 400. Nothing is ever sent without the owner pressing Send on the exact previewed payload.
 */
export const AGI_BUG_REPORT_CATEGORIES = ["crash", "stall", "wrong-result", "ui", "login", "other"] as const;
export type AgiBugReportCategory = (typeof AGI_BUG_REPORT_CATEGORIES)[number];
export type AgiBugReportSource = "desktop-user" | "desktop-agi";

export interface AgiBugReportPayload {
  schemaVersion: 1;
  source: AgiBugReportSource;
  appVersion: string;
  platform: string;
  arch: string;
  locale: string;
  title: string;
  summary: string;
  category: AgiBugReportCategory;
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

export interface AgiBugReportDraftInput {
  /** A defect AGI filed (chip). Absent for the generic "결함 보고" entry. */
  defectId?: string | null;
  chatId?: string | null;
  title?: string;
  summary?: string;
  category?: AgiBugReportCategory;
  steps?: string[];
  failureCode?: string;
  runId?: string;
}

export interface AgiBugReportPreview {
  clientReportId: string;
  /** Exactly what Send will POST. */
  payload: AgiBugReportPayload;
  /** How many secret/path/email spans were replaced before this preview. */
  redactions: number;
  signedIn: boolean;
}

export type AgiBugReportLocalStatus = "draft" | "queued" | "sent" | "failed";
export interface AgiBugReportRow {
  clientReportId: string;
  title: string;
  category: AgiBugReportCategory;
  status: AgiBugReportLocalStatus;
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

export interface AgiDefectChip {
  defectId: string;
  code: string;
  category: AgiBugReportCategory;
  goalId: string;
  createdAt: string;
  /** Local queue state of the report made from this defect, if the owner already sent one. */
  reportStatus: AgiBugReportLocalStatus | null;
}

export interface AgiTokenLimitsView {
  attemptTokenLimit: number;
  dailyGoalTokenLimit: number;
  min: number;
  max: number;
}
