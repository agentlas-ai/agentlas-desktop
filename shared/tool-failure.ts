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
  if (code === "approval_required" || code === "approval_needed" || code === "permission_denied" || code === "policy_denied") return "approval_required";
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
  // The native browser launcher uses this exact marker when an unattended
  // action needs approval. Classification does not attest replay safety.
  if (/^APPROVAL_REQUIRED:/m.test(raw)) return "approval_required";
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
    /\bContains\s+simple_expansion\b/.test(raw)
    || /\brequires?\s+approval\b/i.test(raw)
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

/** A UI classification alone cannot authorize replay. Only these Main proxy
 * refusals attest that dispatch never happened; cancellation and arbitrary
 * provider error prose remain uncertain, including shell expansion warnings. */
export function isPredispatchApprovalRefusal(input: { failureCode: unknown; result: unknown }): boolean {
  if (typeof input.result !== "string") return false;
  const marker = input.result.trimStart().match(/^(MCP_PROXY_POLICY_DENIED|MCP_PROXY_USER_DECLINED|MCP_PROXY_APPROVAL_EXPIRED|APPROVAL_EXPIRED):/u)?.[1];
  return (marker === "MCP_PROXY_POLICY_DENIED" && input.failureCode === "approval_required")
    || (marker === "MCP_PROXY_USER_DECLINED" && input.failureCode === "approval_declined")
    || ((marker === "MCP_PROXY_APPROVAL_EXPIRED" || marker === "APPROVAL_EXPIRED") && input.failureCode === "approval_expired");
}

/**
 * Where a failed tool call's failure came from, read from typed evidence in the result (E14: every production tool failure was
 * recorded as the generic `tool_failed`, so a failure inside Agentlas could not be told from the tool's own outcome).
 * This does not change ToolFailureCode or any copy; it is a separate diagnostic field. Families, in the order they are tried:
 *   harness           agentlas.harness-result.v1 JSON: `${operationId}:${reason}`
 *   mcp_proxy         MCP_PROXY_<CODE>: lines from the Desktop MCP proxy (Agentlas policy or bridge)
 *   one_os            one-os-<code> from the computer-use authority
 *   app_operation     operation-failed: <code> from an app command
 *   mcp_transport     the CLI's MCP client could not reach or start a server
 *   browser_closed    the page, context or browser was gone
 *   connection_refused / browser_timeout   the target did not answer
 *   browser_ref_stale / invalid_arguments   the call used a stale ref, a key or app name the driver does not accept
 *   permission        an approval not given or declined (origin setup)
 *   agentlas_code / tool_json / response_too_large   a typed code from our own tools, or a JSON result's error field
 *   file_not_found / engine_unavailable
 *   exit_code         a command ran and exited non-zero (the command's own result)
 *   command_output    a shell tool failed and printed no exit marker (still the command's own output)
 * Origin: agentlas (our host, policy or bridge), setup (a missing key, connector or route the owner can add), external (a target or
 * provider answered with an error), model (the call itself was malformed), unknown.
 */
export type ToolFailureOrigin = "agentlas" | "setup" | "external" | "model" | "unknown";
export interface ToolFailureCause { family: string; reason: string; origin: ToolFailureOrigin }

const SETUP_REASONS = new Set(["provider_key_missing", "connector_not_installed", "no_transcribe_route", "login_required", "auth_required"]);
const MODEL_REASONS = new Set(["arguments_missing", "arguments_invalid", "operation_unknown", "invalid_arguments"]);
const token = (value: unknown, fallback = "unknown"): string => {
  const text = typeof value === "string" ? value.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "") : "";
  return text ? text.slice(0, 80) : fallback;
};
function resultTexts(result: unknown): string[] {
  if (typeof result !== "string") return [];
  const texts = [result];
  try {
    const parsed = JSON.parse(result) as { content?: Array<{ type?: string; text?: unknown }>; message?: unknown };
    if (Array.isArray(parsed?.content)) for (const part of parsed.content) if (typeof part?.text === "string") texts.unshift(part.text);
    if (typeof parsed?.message === "string") texts.unshift(parsed.message);
  } catch { /* not JSON */ }
  return texts;
}

/** The error class name the browser driver put at the head of its "### Error" section (`<error.name>: <message>`), else null. */
function browserDriverErrorName(text: string): string | null {
  const section = /^### Error\n([A-Za-z]+Error)(?=:|\s|$)/m.exec(text);
  return section ? section[1]! : null;
}

export function toolFailureCause(result: unknown, status?: unknown, toolName?: unknown): ToolFailureCause {
  const texts = [...resultTexts(result), ...(typeof status === "string" ? [status] : [])];
  for (const text of texts) {
    if (!text.includes("agentlas.harness-result.v1")) continue;
    try {
      const harness = JSON.parse(text) as { schemaVersion?: unknown; operationId?: unknown; status?: unknown; reason?: unknown };
      if (harness?.schemaVersion !== "agentlas.harness-result.v1") continue;
      const reason = token(harness.reason, token(harness.status));
      const origin: ToolFailureOrigin = SETUP_REASONS.has(reason) ? "setup"
        : MODEL_REASONS.has(reason) ? "model"
          : /^provider_request_rejected/.test(reason) ? "external" : "agentlas";
      return { family: "harness", reason: `${token(harness.operationId)}:${reason}`, origin };
    } catch { /* not the harness result */ }
  }
  const raw = texts.join("\n");
  // An approval the owner has not given or declined: a permission state, not a failure of the tool or of Agentlas.
  if (/requested permissions? to\b|\bDENIED: The user declined\b|\buser rejected MCP tool call\b|\brejected due to unacceptable risk\b/i.test(raw)) {
    return { family: "permission", reason: /declined|rejected/i.test(raw) ? "declined" : "not_granted", origin: "setup" };
  }
  if (/^Turn tool response is too large\./m.test(raw)) return { family: "response_too_large", reason: "turn_tool_response", origin: "agentlas" };
  let match = /^MCP_PROXY_([A-Z_]+):/m.exec(raw);
  if (match) return { family: "mcp_proxy", reason: token(match[1]), origin: "agentlas" };
  match = /\b(one-os-[a-z0-9-]+)\b/.exec(raw);
  if (match) return { family: "one_os", reason: token(match[1]), origin: "agentlas" };
  match = /\boperation-failed:\s*([A-Za-z0-9_.-]+)/.exec(raw);
  if (match) return { family: "app_operation", reason: token(match[1]), origin: "agentlas" };
  if (/\bMCP startup failed\b|\bhandshaking with MCP server failed\b|\btool call failed for `[^`]+`[\s\S]*Mcp error\b/.test(raw)) {
    return { family: "mcp_transport", reason: /handshak/i.test(raw) ? "handshake" : "call", origin: "agentlas" };
  }
  // Our own tools answer with a bare machine code (one_graph_target_not_in_context, goal_wait_request_invalid: ...).
  match = /^([a-z][a-z0-9]*(?:[_-][a-z0-9]+){2,})(?::|\s*$)/m.exec(texts[0] ?? "");
  if (match) return { family: "agentlas_code", reason: token(match[1]), origin: "agentlas" };
  for (const text of texts) {
    if (!/^\s*\{/.test(text)) continue;
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      const code = [body.error_code, body.errorCode, body.code, body.reason, body.error, body.status].find((v) => typeof v === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{1,79}$/.test(v));
      if (typeof code === "string") return { family: "tool_json", reason: `${token(body.action ?? body.operation, "result")}:${token(code)}`, origin: "unknown" };
    } catch { /* not a JSON object */ }
  }
  if (/^Provide either "text" or "regex"|\bmaxDepth must be\b/m.test(raw)) return { family: "invalid_arguments", reason: "argument_range", origin: "model" };
  if (/\bENOENT\b|No such file or directory/.test(raw)) return { family: "file_not_found", reason: "enoent", origin: "model" };
  if (/\bInputValidationError\b/.test(raw)) return { family: "invalid_arguments", reason: "input_validation", origin: "model" };
  if (/\ball-engines-unavailable\b/.test(raw)) return { family: "engine_unavailable", reason: "all_engines_unavailable", origin: "setup" };
  if (/Target page, context or browser has been closed/.test(raw)) return { family: "browser_closed", reason: "target_closed", origin: "agentlas" };
  if (/\bECONNREFUSED\b|ERR_CONNECTION_REFUSED|Failed to connect to [^\s]+ port \d+/.test(raw)) {
    return { family: "connection_refused", reason: "connection_refused", origin: "external" };
  }
  // The browser driver's own typed error: @playwright/mcp answers a failed call as an "### Error" section whose body is String(error), i.e.
  // `<error.name>: <message>`, and a deadline is Playwright's TimeoutError class. The class name is the signal; no message wording
  // ("Timeout 15000ms exceeded") and no "TimeoutError" elsewhere in the text (a shell's output, a log line) counts.
  const driverError = browserDriverErrorName(raw);
  if (driverError === "TimeoutError") return { family: "browser_timeout", reason: "timeout", origin: "external" };
  // A ref from an earlier snapshot, a key name or app name the driver does not accept: the call itself was wrong.
  if (/\bRef [A-Za-z0-9]+ not found in the current page\b/.test(raw)) return { family: "browser_ref_stale", reason: "ref_not_found", origin: "model" };
  if (/Use a supported key name\b/.test(raw)) return { family: "invalid_arguments", reason: "key_name", origin: "model" };
  if (/No running application matched the requested app name/.test(raw)) return { family: "invalid_arguments", reason: "app_not_running", origin: "model" };
  // The browser tool's own error report for a page action ("### Error\nTypeError: ...", "Error: locator.waitFor: ...").
  match = /^### Error\n(?:Error: )?([A-Za-z]*Error|[a-z]+\.[A-Za-z]+)\b/m.exec(raw);
  if (match) return { family: "browser_error", reason: token(match[1]), origin: "external" };
  match = /\[exited with code (\d+)\]|(?:^|\n)\s*exit (\d+)\s*$|\bexit(?:ed)? (?:status|code) (\d+)\b/i.exec(raw);
  if (match) return { family: "exit_code", reason: `exit_${match[1] ?? match[2] ?? match[3]}`, origin: "external" };
  // A shell tool's failure without an exit marker is still the command's own output (stderr of the program it ran).
  if (/^(?:bash|shell|exec_command|local_shell|run_shell_command)$/i.test(typeof toolName === "string" ? toolName.trim() : "")) {
    return { family: "command_output", reason: "nonzero_without_marker", origin: "external" };
  }
  return { family: "unclassified", reason: "unknown", origin: "unknown" };
}
