import { createHash } from "node:crypto";
import { claimAutomationNotification, type AutomationNotificationInput } from "./automation-notifications";
import { getDb } from "./store/db";
import { getAutomation } from "./store/automations";
import { appendChatMessage, getChat } from "./store/chats";
import { recordRunEvent } from "./store/run-events";
import { automationRunDigest } from "./store/automation-chat-activity";

/**
 * The scheduler stores a failed run's error as "[machine_code] sentence" (and
 * sometimes "[gate_code] [machine_code] sentence") so the run record, the
 * classifier and the next run's handoff can read the typed marker. The origin
 * chat is the owner's page: it gets the sentence, not the markers (owner Thread
 * Marketing 2026-09-28 10:16Z showed "[automation_no_progress_loop] …"). Only
 * the host's own leading lowercase snake_case markers are removed; the run
 * record keeps the full string.
 */
export function ownerReportError(error: string | null | undefined): string {
  let text = (error ?? "").trim();
  for (let guard = 0; guard < 4; guard += 1) {
    const next = text.replace(/^\[[a-z][a-z0-9_]*\]\s*/, "");
    if (next === text) break;
    text = next;
  }
  return text;
}

/**
 * Owner decision 2026-09-28: an automation run that did nothing outward — no outward action in the
 * host ledger (the same count the 자동화 tab shows), a run that completed, and no owner question —
 * posts no chat row. Owner Thread Marketing: the hourly Threads automation posted a row every hour
 * saying nothing had changed ("23:00 전이라 안 했습니다", "not analytics hour").
 * Runs with actions, failures (any non-ok status) or owner-needed outcomes still post.
 */
export function quietAutomationRun(input: Pick<AutomationNotificationInput, "runId" | "status" | "outcome">,
  digestOf: (runId: string) => { outwardTotal: number } | null = automationRunDigest): boolean {
  if (input.status !== "ok") return false;
  if (input.outcome === "needs_input" || input.outcome === "blocked") return false;
  let digest: { outwardTotal: number } | null = null;
  try { digest = digestOf(input.runId); } catch { digest = null; }
  return digest !== null && digest.outwardTotal === 0;
}

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
    if (quietAutomationRun(input)) {
      // Nothing outward happened, nothing failed and nobody is asked: the run stays in the
      // conversation's 자동화 tab timeline ("변화 없음"), not as a chat row.
      recordRunEvent({ runId: input.runId, automationId: automation.id, chatId,
        kind: "automation_origin_report_quiet", sourceEventId: `automation-origin-report-quiet:${automation.id}:${input.runId}`,
        evidencePhase: "executed", payload: { schemaVersion: "agentlas.automation-origin-report.v1",
          sourceMessageId, status: input.status, outcome: input.outcome ?? null, reason: "no_outward_effect" } });
      return false;
    }
    const body = input.status === "ok" ? input.output?.trim() : (ownerReportError(input.error) || input.output?.trim());
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
