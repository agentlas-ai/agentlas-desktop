import type Database from "better-sqlite3";

/*
 * The conversation and owner message an automation run answers, sealed when that run starts (native-harness notyet
 * NH16 4th audit). Updating an automation's monitor while an earlier run is still going must not hand that run's
 * result, report or review to the newer command. The seal is a run event written once per run id (first start wins),
 * so a redelivered occurrence keeps the origin of its first attempt. No electron import: Main and the daemon read it.
 */

export interface AutomationRunOrigin { originChatId: string; originMessageId: string | null }
export const AUTOMATION_RUN_ORIGIN_KIND = "automation_run_origin_sealed";
export const AUTOMATION_RUN_ORIGIN_SCHEMA = "agentlas.automation-run-origin.v1";

type MonitorLike = { monitor?: { originChatId?: string | null; originMessageId?: string | null } | null };

/** The origin of the definition a run executes; `null` when it has no origin conversation. */
export function automationRunOrigin(automation: MonitorLike): AutomationRunOrigin | null {
  const chatId = automation.monitor?.originChatId;
  return chatId ? { originChatId: chatId, originMessageId: automation.monitor?.originMessageId ?? null } : null;
}

/** The sealed origin of a run: an origin, `null` (sealed without one), or `undefined` when the run has no seal. */
export function readSealedAutomationRunOrigin(db: Database.Database, runId: string): AutomationRunOrigin | null | undefined {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='run_events'").get()) return undefined;
  const row = db.prepare(`SELECT payload_json FROM run_events WHERE run_id = ? AND kind = ? ORDER BY seq LIMIT 1`)
    .get(runId, AUTOMATION_RUN_ORIGIN_KIND) as { payload_json: string | null } | undefined;
  if (!row) return undefined;
  try {
    const sealed = JSON.parse(row.payload_json ?? "null");
    if (sealed?.schemaVersion !== AUTOMATION_RUN_ORIGIN_SCHEMA) return undefined;
    return typeof sealed.originChatId === "string" && sealed.originChatId
      ? { originChatId: sealed.originChatId, originMessageId: typeof sealed.originMessageId === "string" ? sealed.originMessageId : null } : null;
  } catch { return undefined; }
}
