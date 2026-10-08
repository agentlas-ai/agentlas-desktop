import { TOOLCHAIN_GENERATION_TIMEOUT_MS } from "./toolchain-asset";

/** Only Main's authenticated one-team binding may use this read-run exception.
 * Stop is a control operation that must remain available after permission drops;
 * enabling and every definition/execution mutation retain ordinary approval. */
export function oneGraphReadPermissionCall(input: {
  catalogId?: string | null;
  toolName: string;
  args?: unknown;
}): boolean {
  if (input.catalogId !== "one-team") return false;
  // toolchain_report records a caller's report about its own run and posts one line upward; it runs and changes nothing.
  if (["one_graph_schema", "one_graph_inspect", "one_graph_result", "toolchain_search", "toolchain_report"].includes(input.toolName)) return true;
  if (input.toolName !== "one_graph_set_enabled" || !input.args
    || typeof input.args !== "object" || Array.isArray(input.args)) return false;
  const args = input.args as Record<string, unknown>;
  return args.enabled === false
    && typeof args.graph_id === "string" && args.graph_id.trim().length > 0
    && (args.expected_revision === undefined || typeof args.expected_revision === "string")
    && Object.keys(args).every(key => ["graph_id", "enabled", "expected_revision"].includes(key));
}

/** These host tools have a bounded wait contract; other MCP calls retain
 * the ordinary timeout. Invalid caller values never extend the lifetime. */
export function oneGraphToolTimeoutMs(input: {
  catalogId?: string | null; toolName: string; args?: unknown;
}): number {
  // toolchain_publish waits at most 45 s for its fresh-session test, then answers "testing".
  if (input.catalogId === "one-team" && input.toolName === "toolchain_publish") return 60_000;
  if (input.catalogId === "one-team" && input.toolName === "toolchain_create" && input.args && typeof input.args === "object" && !Array.isArray(input.args)) {
    const args = input.args as Record<string, unknown>;
    if (typeof args.request === "string" && args.request.trim().length > 0 && args.request.length <= 8000
      && typeof args.request_id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(args.request_id)) return TOOLCHAIN_GENERATION_TIMEOUT_MS + 15_000;
  }
  if (input.catalogId !== "one-team"
    || !["one_graph_run", "one_graph_result"].includes(input.toolName)
    || !input.args || typeof input.args !== "object" || Array.isArray(input.args)) return 30_000;
  const supplied = (input.args as Record<string, unknown>).wait_seconds;
  const seconds = supplied === undefined ? (input.toolName === "one_graph_run" ? 20 : 0) : supplied;
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 0 || seconds > 50) return 30_000;
  return Math.max(30_000, (seconds + 15) * 1000);
}
