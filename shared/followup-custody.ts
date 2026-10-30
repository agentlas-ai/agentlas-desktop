import type { McpInvocationRequest } from "./types";

/** Canonical JSON-wire owner intention. A run ID identifies an attempt, not
 * the immutable input; its original target is recorded separately. */
export function followupRequestJson(request: McpInvocationRequest): string {
  const wire = JSON.parse(JSON.stringify({ ...request, runId: undefined })) as unknown;
  const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, sort(child)]))
      : value;
  return JSON.stringify(sort(wire));
}
