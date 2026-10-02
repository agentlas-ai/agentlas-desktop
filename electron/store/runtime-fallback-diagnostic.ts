import { createHash } from "node:crypto";
import type { McpInvocationEvent, McpInvocationRequest } from "../../shared/types";

const DIAGNOSTIC_EVENT_FIELDS = new Set(["kind", "sequence", "observedAt", "delivery", "status", "phase",
  "agentId", "runtimeAgentId", "nodeId", "role", "modelRole", "agentName", "model", "observedModel", "runtimeSelection", "notice"]);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Only sequenced host diagnostics qualify. Hash the complete pre-truncation
 * envelope; never collapse changed reasons, actors, scopes or authority facts. */
export function runtimeFallbackDiagnosticKey(req: McpInvocationRequest, ev: McpInvocationEvent): string | undefined {
  if (ev.kind !== "notice" || ev.notice?.code !== "runtime-fallback" || ev.notice.level === "error"
    || !Number.isSafeInteger(ev.sequence) || Number(ev.sequence) < 0) return undefined;
  const actor = ev.runtimeAgentId ?? ev.agentId;
  if (typeof actor !== "string" || !actor) return undefined;
  if (Object.entries(ev).some(([key, value]) => value !== undefined && !DIAGNOSTIC_EVENT_FIELDS.has(key))) return undefined;
  try {
    const details = JSON.parse(ev.notice.details ?? "null");
    if (!details || typeof details !== "object" || Array.isArray(details)
      || !["from", "to", "reason", "runtime", "failureSource", "providerCode", "exitCode", "retryAfterHint", "savedSelectionChanged"]
        .every((key) => Object.hasOwn(details, key))
      || !details.from || typeof details.from !== "object" || Array.isArray(details.from)
      || !details.to || typeof details.to !== "object" || Array.isArray(details.to)
      || typeof details.from.kind !== "string" || !details.from.kind
      || typeof details.to.kind !== "string" || !details.to.kind || details.savedSelectionChanged !== false
      || typeof details.reason !== "string" || typeof details.failureSource !== "string") return undefined;
    const { sequence: _sequence, observedAt: _observedAt, delivery: _delivery, ...semantic } = ev;
    return createHash("sha256").update(canonical({ chatId: req.chatId, automationId: req.automationId,
      permissions: req.permissions, toolMode: req.toolMode, hubMode: req.hubMode, borrowAgents: req.borrowAgents,
      event: { ...semantic, notice: { ...ev.notice, details } } })).digest("hex");
  } catch { return undefined; }
}

export function diagnosticSummaryBoundary(count: number): boolean {
  return count === 1 || (Number.isSafeInteger(count) && count > 0 && 2 ** Math.floor(Math.log2(count)) === count);
}


const STATUS_EVENT_FIELDS = new Set(["kind", "sequence", "observedAt", "delivery", "status", "phase",
  "agentId", "runtimeAgentId", "nodeId", "role", "agentName", "activity"]);
const STATUS_PAYLOAD_FIELDS = new Set(["eventKind", "statusOnlyDiagnostic", "status", "activityCode", "phase",
  "agentNodeId", "runtimeAgentId", "role", "agentName", "toolCompleted", "agentMessageReportAvailable",
  "permissions", "toolMode", "hubMode", "borrowAgents", "noticeDiagnosticKey", "noticeSourceSequence", "noticeObservedAt"]);
function waitActivity(code: unknown): boolean { return code === undefined || code === "runtime_wait" || code === "queue_wait"; }

/** Status copy is transient presentation, never an actual tool or authority
 * receipt. Unknown fields, model/usage facts and control activities fail open. */
export function statusOnlyDiagnosticKey(req: McpInvocationRequest, ev: McpInvocationEvent): string | undefined {
  if (ev.kind !== "tool-use" || typeof ev.status !== "string" || !ev.status
    || !Number.isSafeInteger(ev.sequence) || Number(ev.sequence) < 0
    || typeof (ev.runtimeAgentId ?? ev.agentId) !== "string" || !(ev.runtimeAgentId ?? ev.agentId)
    || Object.entries(ev).some(([key, value]) => value !== undefined && !STATUS_EVENT_FIELDS.has(key))) return undefined;
  if ([ev.agentId, ev.runtimeAgentId, ev.nodeId, ev.role, ev.agentName, ev.phase, ev.observedAt]
    .some(value => value !== undefined && typeof value !== "string")) return undefined;
  if (ev.activity !== undefined && (!ev.activity || typeof ev.activity !== "object" || Array.isArray(ev.activity)
    || Object.keys(ev.activity).some(key => key !== "code") || !waitActivity(ev.activity.code))) return undefined;
  const { sequence: _sequence, observedAt: _observedAt, delivery: _delivery, ...semantic } = ev;
  try { return createHash("sha256").update(canonical({ diagnostic: "status-only", chatId: req.chatId, automationId: req.automationId,
    permissions: req.permissions, toolMode: req.toolMode, hubMode: req.hubMode, borrowAgents: req.borrowAgents, event: semantic })).digest("hex"); } catch { return undefined; }
}

/** Recheck the flattened envelope at the storage boundary, so a caller cannot
 * use a diagnostic marker to intern a tool result, approval, model or effect. */
export function isStatusOnlyDiagnosticPayload(value: unknown, hydrated = false): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  if (hydrated && typeof payload.noticeDiagnosticReference === "string") {
    const fields = new Set(["eventKind", "statusOnlyDiagnostic", "noticeDiagnosticKey", "noticeDiagnosticReference",
      "noticeSourceSequence", "noticeObservedAt", "runtimeEvidence"]);
    return payload.statusOnlyDiagnostic === true && payload.eventKind === "tool-use"
      && !!payload.noticeDiagnosticReference && typeof payload.noticeDiagnosticKey === "string"
      && /^[a-f0-9]{64}$/.test(payload.noticeDiagnosticKey) && Number.isSafeInteger(payload.noticeSourceSequence)
      && Object.entries(payload).every(([key, field]) => field === undefined || fields.has(key));
  }
  const extra = hydrated ? new Set(["runtimeEvidence", "noticeOccurrenceCount", "noticeFirstTimestamp", "noticeLastTimestamp",
    "noticeFirstSourceSequence", "noticeLastSourceSequence"]) : undefined;
  return payload.statusOnlyDiagnostic === true && payload.eventKind === "tool-use"
    && typeof payload.status === "string" && !!payload.status && waitActivity(payload.activityCode)
    && (payload.agentName === undefined || typeof payload.agentName === "string")
    && (payload.toolCompleted === undefined || payload.toolCompleted === false)
    && (payload.agentMessageReportAvailable === undefined || payload.agentMessageReportAvailable === false)
    && Object.entries(payload).every(([key, field]) => field === undefined || STATUS_PAYLOAD_FIELDS.has(key) || extra?.has(key));
}
