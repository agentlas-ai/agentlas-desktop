export const WORKER_REPORT_MAX_BYTES = 64 * 1024;
export interface WorkerReportScope { chatId: string; runId: string; agentId: string; messageId: string }
export interface WorkerReport extends WorkerReportScope { text: string; truncated: boolean }
export function isWorkerReportScope(value: unknown): value is WorkerReportScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return ["chatId", "runId", "agentId", "messageId"].every(key => typeof v[key] === "string"
    && v[key].length > 0 && v[key].length <= 300 && v[key].trim() === v[key]);
}
export function parseWorkerReport(value: unknown): WorkerReport | null {
  if (typeof value !== "string" || value.length > WORKER_REPORT_MAX_BYTES * 6 + 2048) return null;
  try {
    const v: unknown = JSON.parse(value);
    if (!isWorkerReportScope(v)) return null;
    const report = v as WorkerReport;
    if (typeof report.text !== "string" || typeof report.truncated !== "boolean"
      || new TextEncoder().encode(report.text).length > WORKER_REPORT_MAX_BYTES) return null;
    return { chatId: report.chatId, runId: report.runId, agentId: report.agentId,
      messageId: report.messageId, text: report.text, truncated: report.truncated };
  } catch { return null; }
}
