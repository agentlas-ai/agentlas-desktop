import { createHash } from "node:crypto";
import { claimAutomationNotification, type AutomationNotificationInput } from "./automation-notifications";
import { getDb } from "./store/db";
import { getAutomation } from "./store/automations";
import { appendChatMessage, getChat } from "./store/chats";
import { recordRunEvent } from "./store/run-events";

/** The scheduler owns the result. Atomically publish it to the registration's
 * original conversation and claim its notification; replay cannot duplicate the
 * durable message. An OS notification remains only an attempted delivery. */
export function deliverAutomationResult(input: AutomationNotificationInput): boolean {
  return getDb().transaction(() => {
    const db = getDb();
    const run = db.prepare("SELECT status FROM automation_runs WHERE id = ? AND automation_id = ?")
      .get(input.runId, input.automationId) as { status: string } | undefined;
    if (!run || run.status === "running") return false;
    if (!claimAutomationNotification(input)) return false;
    const automation = getAutomation(input.automationId);
    const chatId = automation?.monitor?.originChatId;
    const sourceMessageId = automation?.monitor?.originMessageId;
    if (!automation || !chatId || !sourceMessageId || !getChat(chatId)) return true;
    const source = db.prepare("SELECT 1 FROM chat_messages WHERE id = ? AND chat_id = ? AND role = 'user'")
      .get(sourceMessageId, chatId);
    if (!source) return true;
    const body = input.status === "ok" ? input.output?.trim() : (input.error?.trim() || input.output?.trim());
    if (!body) return true;
    // A report is host-delivered history. It must not inherit the unrelated
    // active Goal binding that appendChatMessage assigns to assistant turns.
    const message = appendChatMessage(chatId, "system", `${automation.name}\n\n${body}`, {
      hostNotice: { purpose: "automation-report", runId: input.runId, automationId: automation.id },
    });
    recordRunEvent({ runId: input.runId, automationId: automation.id, chatId,
      kind: "automation_origin_report_delivered", sourceEventId: `automation-origin-report:${automation.id}:${input.runId}`,
      evidencePhase: "executed", payload: { schemaVersion: "agentlas.automation-origin-report.v1",
        sourceMessageId, messageId: message.id, status: input.status,
        outputDigest: createHash("sha256").update(body).digest("hex"), deliveryState: "persisted" } });
    return true;
  })();
}
