import type { ChatHostNotice } from "./types";

export function normalizeChatHostNotice(role: string, value: unknown): ChatHostNotice | undefined {
  if (role !== "system" || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const validId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id);
  if (item.purpose === "automation-report") {
    if (Object.keys(item).some(key => !["purpose", "runId", "automationId"].includes(key)) || !validId(item.runId) || !validId(item.automationId)) return undefined;
    return { purpose: "automation-report", runId: item.runId, automationId: item.automationId };
  }
  if (Object.keys(item).some((key) => key !== "purpose" && key !== "runId")
    || item.purpose !== "goal-continuation" || typeof item.runId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.runId)) return undefined;
  return { purpose: "goal-continuation", runId: item.runId };
}

export function parseChatHostNotice(role: string, json: unknown): ChatHostNotice | undefined {
  if (typeof json !== "string" || json.length > 512) return undefined;
  try { return normalizeChatHostNotice(role, JSON.parse(json)); } catch { return undefined; }
}
