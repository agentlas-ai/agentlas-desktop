/** Monitoring is app-scoped. Durable state survives quit; work resumes at launch. */
export interface AutomationMonitorContract {
  schemaVersion: "agentlas.automation-monitor.v1";
  notificationPolicy: "meaningful_changes" | "every_run";
  originChatId: string;
  originMessageId: string | null;
  deadline: string | null;
}
export interface AutomationPollState {
  schemaVersion: "agentlas.poll-state.v1";
  revision: number;
  nextCheckAt: string | null;
  currentIntervalMs: number;
  observedAt: string | null;
  status: "pending" | "timed_out" | "blocked" | "satisfied";
  reason?: string;
}
export function decodeAutomationMonitor(value: unknown): AutomationMonitorContract | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== "agentlas.automation-monitor.v1"
    || !["meaningful_changes", "every_run"].includes(String(row.notificationPolicy))
    || typeof row.originChatId !== "string" || !row.originChatId || row.originChatId.length > 512
    || !(row.originMessageId === null || typeof row.originMessageId === "string" && row.originMessageId.length > 0 && row.originMessageId.length <= 512)
    || !(row.deadline === null || typeof row.deadline === "string" && Number.isFinite(Date.parse(row.deadline)))) return null;
  return { schemaVersion: "agentlas.automation-monitor.v1", notificationPolicy: row.notificationPolicy as AutomationMonitorContract["notificationPolicy"],
    originChatId: row.originChatId, originMessageId: row.originMessageId as string | null, deadline: row.deadline as string | null };
}
export function decodeAutomationPollState(value: unknown): AutomationPollState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== "agentlas.poll-state.v1" || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1
    || !Number.isSafeInteger(row.currentIntervalMs) || Number(row.currentIntervalMs) < 30_000
    || !["pending", "timed_out", "blocked", "satisfied"].includes(String(row.status))
    || !(row.nextCheckAt === null || typeof row.nextCheckAt === "string" && Number.isFinite(Date.parse(row.nextCheckAt)))
    || !(row.observedAt === null || typeof row.observedAt === "string" && Number.isFinite(Date.parse(row.observedAt)))) return null;
  return { schemaVersion: "agentlas.poll-state.v1", revision: Number(row.revision), nextCheckAt: row.nextCheckAt as string | null,
    currentIntervalMs: Number(row.currentIntervalMs), observedAt: row.observedAt as string | null,
    status: row.status as AutomationPollState["status"], ...(typeof row.reason === "string" ? { reason: row.reason.slice(0, 160) } : {}) };
}
