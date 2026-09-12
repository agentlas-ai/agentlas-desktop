import { createHash } from "node:crypto";
import type { AutomationResultStatus } from "./automation-result";
import { getDb } from "./store/db";
import { getAutomation } from "./store/automations";
import { recordRunEvent } from "./store/run-events";

export interface AutomationNotificationInput {
  automationId: string; runId: string; status: AutomationResultStatus;
  output?: string; error?: string | null; observationDigest?: string; unchanged?: boolean;
}
/** Claim a durable notification attempt before delivery. This guarantees one
 * attempt per run, not an unobservable exactly-once OS notification receipt. */
export function claimAutomationNotification(input: AutomationNotificationInput): boolean {
  return getDb().transaction(() => {
    const automation = getAutomation(input.automationId);
    if (!automation || input.status === "skipped" || input.unchanged === true) return false;
    if (automation.monitor && !automation.enabled) return false;
    const existing = getDb().prepare("SELECT 1 FROM run_events WHERE run_id = ? AND kind IN ('automation_notification_attempt','automation_notification_suppressed') AND automation_id = ? LIMIT 1")
      .get(input.runId, automation.id);
    if (existing) return false;
    // No model classifies whether another model's prose is meaningful. Poll
    // dispatch supplies its observed digest; legacy schedules use exact output.
    const digest = createHash("sha256").update(JSON.stringify({ status: input.status,
      observation: input.observationDigest ?? null,
      result: input.error?.trim() || (input.observationDigest ? null : (input.output ?? "").trim()) })).digest("hex");
    if (automation.monitor?.notificationPolicy === "meaningful_changes") {
      const prior = getDb().prepare("SELECT payload_json FROM run_events WHERE automation_id = ? AND kind = 'automation_notification_attempt' ORDER BY rowid DESC LIMIT 1")
        .get(automation.id) as { payload_json: string } | undefined;
      if (prior && JSON.parse(prior.payload_json).observationDigest === digest) {
        recordRunEvent({ runId: input.runId, automationId: automation.id, kind: "automation_notification_suppressed",
          sourceEventId: `automation-notification:${automation.id}:${input.runId}`, evidencePhase: "observed",
          payload: { status: input.status, observationDigest: digest, reason: "unchanged", deliveryState: "suppressed" } });
        return false;
      }
    }
    recordRunEvent({ runId: input.runId, automationId: automation.id, kind: "automation_notification_attempt",
      sourceEventId: `automation-notification:${automation.id}:${input.runId}`, evidencePhase: "requested",
      payload: { status: input.status, observationDigest: digest, policy: automation.monitor?.notificationPolicy ?? "every_run",
        deliveryState: "attempted", executionAvailability: "app-running" } });
    return true;
  })();
}
