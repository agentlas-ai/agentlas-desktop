/**
 * A small closed vocabulary for tool outcomes that are actionable in One.
 *
 * The provider may return arbitrary text, but the renderer, failure ledger, and
 * diagnostic surfaces must agree on whether the user declined an approval or
 * whether the tool itself failed. Keep the raw text as evidence; use this code
 * for routing and copy.
 */
export type ToolFailureCode =
  | "approval_declined"
  | "approval_required"
  | "approval_expired"
  | "cancelled"
  | "tool_failed";

const TOOL_FAILURE_CODES: ReadonlySet<string> = new Set([
  "approval_declined",
  "approval_required",
  "approval_expired",
  "cancelled",
  "tool_failed",
]);

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedCode(value: unknown): string {
  return normalizedText(value).toLowerCase().replace(/-/g, "_");
}

export function isToolFailureCode(value: unknown): value is ToolFailureCode {
  return typeof value === "string" && TOOL_FAILURE_CODES.has(value);
}

function explicitFailureCode(value: unknown): ToolFailureCode | undefined {
  const code = normalizedCode(value);
  if (code === "approval_declined" || code === "user_rejected" || code === "user_denied") {
    return "approval_declined";
  }
  if (code === "approval_required" || code === "approval_needed") return "approval_required";
  if (code === "cancelled" || code === "canceled" || code === "aborted_by_user") return "cancelled";
  if (code === "approval_expired") return "approval_expired";
  if (code === "tool_failed") return "tool_failed";
  return undefined;
}

/** Convert provider/runtime evidence into the stable code used by all surfaces. */
export function classifyToolFailure(input: {
  explicitCode?: unknown;
  result?: unknown;
  status?: unknown;
}): ToolFailureCode {
  const explicit = explicitFailureCode(input.explicitCode);
  if (explicit && explicit !== "tool_failed") return explicit;

  const raw = [normalizedText(input.result), normalizedText(input.status)]
    .filter(Boolean)
    .join("\n");
  if (/^APPROVAL_EXPIRED:/m.test(raw)) return "approval_expired";
  if (/^MCP_PROXY_APPROVAL_EXPIRED:/m.test(raw)) return "approval_expired";
  if (/^MCP_PROXY_USER_DECLINED:/m.test(raw)) return "approval_declined";
  if (/^MCP_PROXY_POLICY_DENIED:/m.test(raw)) return "approval_required";
  if (/^MCP_PROXY_[A-Z_]+:/m.test(raw)) return "tool_failed";
  if (
    /\buser\s+(?:rejected|declined|denied)\s+(?:(?:the|this)\s+)?(?:mcp\s+)?tool\s+call\b/i.test(raw)
    || /\btool\s+call\s+(?:was\s+)?(?:rejected|declined|denied)\b/i.test(raw)
    || /\bapproval\s+(?:was\s+)?(?:declined|denied)\b/i.test(raw)
  ) {
    return "approval_declined";
  }
  if (
    /\brequires?\s+approval\b/i.test(raw)
    || /\bapproval\s+(?:is\s+)?required\b/i.test(raw)
    || /\brequested\s+permissions?\b/i.test(raw)
    || /\bhaven'?t\s+granted\b/i.test(raw)
  ) {
    return "approval_required";
  }
  if (/\b(?:cancelled|canceled|aborted\s+by\s+user|user\s+stopped)\b/i.test(raw)) {
    return "cancelled";
  }
  return explicit ?? "tool_failed";
}

/** Product copy for the same code used by the ledger and diagnostic API. */
export function toolFailureCopy(value: unknown, locale: "ko" | "en"): string | null {
  if (!isToolFailureCode(value)) return null;
  if (locale === "ko") {
    switch (value) {
      case "approval_declined":
        return "승인하지 않아 도구 실행을 중단했습니다. 실행하려면 승인해 주세요.";
      case "approval_expired":
        return "승인 시간이 만료되어 도구가 실행되지 않았습니다.";
      case "approval_required":
        return "이 작업은 승인이 필요합니다. 승인하면 다시 진행할 수 있습니다.";
      case "cancelled":
        return "도구 실행을 사용자가 중단했습니다. 필요하면 다시 시도할 수 있습니다.";
      case "tool_failed":
        return "연결된 도구가 오류를 반환했습니다. 도구 상태를 확인한 뒤 다시 시도해 주세요.";
    }
  }
  switch (value) {
    case "approval_declined":
      return "The tool stopped because approval was declined. Approve it to continue.";
    case "approval_expired":
      return "Approval expired. The tool was not executed.";
    case "approval_required":
      return "This action needs approval. Approve it to continue.";
    case "cancelled":
      return "The tool run was stopped by the user. You can try again if needed.";
    case "tool_failed":
      return "The connected tool returned an error. Check the tool and try again.";
  }
}
