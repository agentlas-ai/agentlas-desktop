import type { RuntimeSelection } from "./types";

/** Renderer-safe MCP planning contract. It intentionally excludes commands, args, URLs, and secret values. */
export type McpBuildKeyState = "not-required" | "present" | "missing";
export type McpBuildCandidateReadiness =
  | "ready"
  | "available"
  | "missing-key"
  | "disabled"
  | "runtime-incompatible";

// "hub" is a real third source: Hub plugins are offered during Build and install
// through the Hub manifest, not the local catalog. Without it the union silently
// blocked Hub candidates from ever being expressed.
export type McpBuildCandidateSource = "system-registry" | "catalog" | "hub";
export type McpBuildRecommendationReasonCode =
  | "browser-interaction"
  | "desktop-interaction"
  | "workspace-preview"
  | "agent-routing"
  | "current-web-research"
  | "repository-work"
  | "workspace-files"
  | "database-work"
  | "notion-work"
  | "linear-work"
  | "slack-work"
  | "discord-work"
  | "ui-components"
  | "custom-name-match"
  | "hub-plugin-match"
  | "task-match";
export type McpBuildPermissionBasis = "catalog-declared" | "host-inferred" | "unknown";

export interface McpBuildCandidate {
  /** Opaque plan-local selector. It is not an executable server definition. */
  id: string;
  catalogId: string | null;
  name: string;
  capability: string;
  reason: "request-match" | "installed-match" | "user-installed";
  /** Value-safe localization key. Main never sends a prose/account-bearing reason. */
  recommendationReasonCode: McpBuildRecommendationReasonCode;
  requiresKey: boolean;
  /** Estimate only unless permissionEnforced is true. */
  minimumPermission: "read" | "write" | "full";
  minimumScopes: string[];
  permissionBasis: McpBuildPermissionBasis;
  permissionEnforced: boolean;
  source: McpBuildCandidateSource;
  installed: boolean;
  enabled: boolean;
  keyState: McpBuildKeyState;
  readiness: McpBuildCandidateReadiness;
  defaultSelected: boolean;
  fallbackGroup: string;
  priority: number;
}

export interface McpBuildPlan {
  id: string;
  createdAt: string;
  expiresAt: string;
  runtimeKind: RuntimeSelection["kind"] | null;
  status: "ready" | "degraded" | "unavailable";
  warningCode: "registry_unavailable" | "runtime_detection_unavailable" | "recommendation_unavailable" | null;
  candidates: McpBuildCandidate[];
}

export interface McpBuildRecommendationInput {
  request: string;
  mode?: "single" | "team" | "package";
  runtime?: RuntimeSelection;
}

export interface McpBuildConsent {
  planId: string;
  selectedCandidateIds: string[];
  /** Safe renderer fallback: can only request an empty MCP inventory. */
  fallbackReason?: "recommendation_unavailable";
}

export type McpBuildReceiptItemStatus =
  | "attached"
  | "skipped"
  | "missing_key"
  | "failed"
  | "degraded";

export type McpBuildReceiptReason =
  | "attached"
  | "not_selected"
  | "fallback_not_needed"
  | "missing_key"
  | "disabled"
  | "runtime_incompatible"
  | "server_unavailable"
  | "install_failed"
  // 붙일 서버가 애초에 없는 플러그인(스킬 묶음). 고장이 아니라 종류가 다른 것이라
  // "failed"로 표시하면 사용자는 제품이 깨진 줄 안다(2026-08-17: Documents·
  // Presentations·Spreadsheets 가 mcp 서버 0개인데 "Failed · 3"으로 떴다).
  | "no_connectable_server"
  | "connection_failed"
  | "runtime_startup_failed"
  | "configuration_rejected"
  | "host_failure"
  | "fallback_blocked_by_configuration";

export interface McpBuildReceiptItem {
  candidateId: string;
  catalogId: string | null;
  name: string;
  capability: string;
  status: McpBuildReceiptItemStatus;
  reason: McpBuildReceiptReason;
  fallbackGroup: string;
}

export interface McpBuildFallbackReceipt {
  group: string;
  fromCandidateId: string;
  toCandidateId: string;
  reason: "fallback_used";
}

/** Durable, value-free result of one approved Build MCP plan. */
export interface McpBuildAttachmentReceipt {
  planId: string;
  resolvedAt: string;
  attached: McpBuildReceiptItem[];
  skipped: McpBuildReceiptItem[];
  missingKey: McpBuildReceiptItem[];
  failed: McpBuildReceiptItem[];
  degraded: McpBuildReceiptItem[];
  fallback: McpBuildFallbackReceipt[];
  emptyMode: boolean;
  /** Receipt persistence is best-effort and can never block the Build. */
  hostReceiptStored: boolean;
  hostReceiptWarning: "receipt_storage_failed" | null;
}

export interface HephaestusBuildStartResult {
  runId: string;
  mcpReceipt: McpBuildAttachmentReceipt;
}
