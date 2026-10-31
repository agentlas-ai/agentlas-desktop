import { createHash } from "node:crypto";
import { claimAutomationNotification, type AutomationNotificationInput } from "./automation-notifications";
import { getDb } from "./store/db";
import { getAutomation } from "./store/automations";
import { appendChatMessage, getChat } from "./store/chats";
import { observedApprovalRequiredToolCount, recordRunEvent } from "./store/run-events";
import { automationRunDigest } from "./store/automation-chat-activity";
import { automationOutwardSummary, type AutomationRunDigest } from "../shared/automation-activity";
import { currentUiLocale } from "./ui-locale";
import { redactOperationalSecrets } from "./invocation/event-secret-redaction";
import { formatRuntimeQuotaReset, quotaRetryAfterAt } from "../shared/runtime-quota";
import { queueGraphResultForOne } from "./one/graph-review";
import { AUTOMATION_RUN_ORIGIN_KIND, AUTOMATION_RUN_ORIGIN_SCHEMA, automationRunOrigin, readSealedAutomationRunOrigin, type AutomationRunOrigin } from "./automation-run-origin";
import { wakeOneForGraphResult } from "./one/host-alerts";
import { continuationRefusalNotice } from "../shared/continuation-refusal-notice";
import { stripAgentControlMarkers } from "../shared/agent-control-markers";

/** Exact current-run host receipts only. Historical prose is not a reset clock. */
function automationQuotaResetTimes(runId: string, automationId: string): string[] {
  const rows = getDb().prepare(`SELECT payload_json FROM run_events WHERE run_id = ? AND automation_id = ?
    AND kind = 'automation_runtime_quota_observed' ORDER BY seq DESC LIMIT 20`).all(runId, automationId) as { payload_json: string | null }[];
  const times = new Set<string>();
  for (const row of rows) {
    try {
      const payload = row.payload_json ? JSON.parse(row.payload_json) : null;
      const at = payload?.schemaVersion === "agentlas.automation-runtime-quota.v1" && payload.kind === "quota" && payload.source === "marker"
        ? quotaRetryAfterAt(payload.retryAfterAt) : null;
      if (at) times.add(at);
    } catch { /* Missing or malformed observations do not establish a reset. */ }
  }
  return [...times].slice(0, 3);
}

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

/** A final verification/no-op node cannot replace work recorded earlier in the
 * run. Keep the ledger summary first, with the final output labelled as such. */
export function automationOwnerReportBody(input: Pick<AutomationNotificationInput, "status" | "output" | "error" | "outcome">,
  digest: AutomationRunDigest | null, locale: "ko" | "en", approvalRequiredCount = 0): string {
  const ownerNeeded = input.outcome === "needs_input" || input.outcome === "blocked";
  // The owner reads the words, never the host markers the run used to signal quiet or a question.
  const body = stripAgentControlMarkers(redactOperationalSecrets((input.status === "ok" && !ownerNeeded ? input.output?.trim() : (ownerReportError(input.error) || input.output?.trim())) ?? ""));
  const approval = approvalRequiredCount > 0 ? (locale === "ko"
    ? `이번 실행에서 도구 요청 ${approvalRequiredCount}건이 승인이 필요하다고 보고했습니다. 대안으로 처리됐는지는 실행 결과를 확인하세요.`
    : `${approvalRequiredCount} tool requests in this run reported that approval was required. Check the run result to see whether an alternative completed the work.`) : "";
  if (!digest) return [approval, body].filter(Boolean).join("\n\n");
  const ko = locale === "ko";
  const actions = automationOutwardSummary(digest.outward, locale);
  const summary = actions
    ? `${ko ? "전체 실행에서 기록된 동작" : "Actions recorded across the run"}: ${actions}.`
    : `${ko ? "전체 실행에서 기록된 외부 동작은 없습니다" : "No outward actions were recorded across the run"}.`;
  const tools = ko ? `도구 호출 ${digest.toolCalls}회` : `${digest.toolCalls} tool calls`;
  const errors = digest.failures > 0 ? (ko ? ` · 도구 오류 ${digest.failures}건` : ` · ${digest.failures} tool errors`) : "";
  return `${summary}\n${tools}${errors}${approval ? `\n${approval}` : ""}${body ? `\n\n${ko ? "마지막 단계 결과" : "Final step result"}:\n${body}` : ""}`;
}








export function quietAutomationRun(input: Pick<AutomationNotificationInput, "runId" | "status" | "outcome">,
  digestOf: (runId: string) => { outwardTotal: number; outwardActivityCoverage?: AutomationRunDigest["outwardActivityCoverage"] } | null = automationRunDigest,
  approvalCountOf: (runId: string) => number = observedApprovalRequiredToolCount): boolean {
  if (input.status !== "ok") return false;
  if (input.outcome === "needs_input" || input.outcome === "blocked") return false;
  let digest: { outwardTotal: number; outwardActivityCoverage?: AutomationRunDigest["outwardActivityCoverage"] } | null = null;
  try { digest = digestOf(input.runId); } catch { digest = null; }
  // Preserve this run's explicit permission fact even if a later node omitted
  // the owner-question marker. Ordinary recovered tool errors stay quiet; this
  // changes delivery only, never the outcome or permission to replay actions.
  try { if (approvalCountOf(input.runId) > 0) return false; } catch { return false; }
  return digest !== null && digest.outwardActivityCoverage === "complete" && digest.outwardTotal === 0;
}

export { automationRunOrigin, type AutomationRunOrigin } from "./automation-run-origin";

/** First start wins: a redelivered occurrence with the same run id keeps the origin its first attempt sealed. */
export function sealAutomationRunOrigin(runId: string, automationId: string, origin: AutomationRunOrigin | null): void {
  recordRunEvent({ runId, automationId, kind: AUTOMATION_RUN_ORIGIN_KIND, sourceEventId: AUTOMATION_RUN_ORIGIN_KIND, evidencePhase: "observed",
    payload: { schemaVersion: AUTOMATION_RUN_ORIGIN_SCHEMA, originChatId: origin?.originChatId ?? null, originMessageId: origin?.originMessageId ?? null } });
}

/** The scheduler owns the result. Atomically publish it to the registration's
 * original conversation and claim its notification; replay cannot duplicate the
 * durable message. An OS notification remains only an attempted delivery. A graph
 * that answers One's personal conversation (or a Work session One delegated) is
 * queued for One's review in the same transaction (native-harness notyet NH16). */
export function deliverAutomationResult(input: AutomationNotificationInput & { origin?: AutomationRunOrigin | null }): boolean {
  let queuedForOne = false;
  const delivered = getDb().transaction(() => {
    const db = getDb();
    const run = db.prepare("SELECT status FROM automation_runs WHERE id = ? AND automation_id = ?")
      .get(input.runId, input.automationId) as { status: string } | undefined;
    if (!run || run.status === "running") return false;
    const approvalRequiredCount = observedApprovalRequiredToolCount(input.runId);
    const quotaResetTimes = automationQuotaResetTimes(input.runId, input.automationId);
    // A newly observed permission fact is a meaningful change even if final
    // prose stayed the same. Keep the policy's existing cross-run dedup: the
    // same count/result on the next run produces the same observation digest.
    const ownerNeeded = input.outcome === "needs_input" || input.outcome === "blocked";
    const notificationInput = approvalRequiredCount > 0 || ownerNeeded || quotaResetTimes.length > 0 ? { ...input, unchanged: false,
      observationDigest: createHash("sha256").update(JSON.stringify({
        schemaVersion: "agentlas.automation-owner-observation.v1", approvalRequiredCount, outcome: input.outcome ?? null, quotaResetTimes,
        observationDigest: input.observationDigest ?? null,
        outputDigest: createHash("sha256").update(input.output ?? "").digest("hex"),
      })).digest("hex") } : input;
    let recorded: number | undefined;
    try { recorded = automationRunDigest(input.runId)?.outwardTotal; } catch { recorded = undefined; }
    if (!claimAutomationNotification({ ...notificationInput, ...(recorded === undefined ? {} : { outward: recorded > 0 }) })) return false;
    const automation = getAutomation(input.automationId);
    if (!automation) return true;
    // The run's own sealed origin, never a monitor that changed while it ran (native-harness notyet NH16 4th audit).
    // A run without a seal uses the origin its caller captured at start; a run started before seals existed, the
    // automation's current monitor.
    const sealed = readSealedAutomationRunOrigin(db, input.runId);
    const origin = sealed !== undefined ? sealed : input.origin !== undefined ? input.origin : automationRunOrigin(automation);
    const chatId = origin?.originChatId;
    if (!chatId || !getChat(chatId)) return true;
    // The owner conversation is still known when the original command is not. Report there without guessing a turn.
    const requestedSourceMessageId = origin?.originMessageId;
    const sourceMessageId = requestedSourceMessageId && db.prepare("SELECT 1 FROM chat_messages WHERE id = ? AND chat_id = ? AND role = 'user'")
      .get(requestedSourceMessageId, chatId) ? requestedSourceMessageId : null;
    if (quietAutomationRun(input)) {
      // Nothing outward happened, nothing failed and nobody is asked: the run stays in the
      // conversation's 자동화 tab timeline ("변화 없음"), not as a chat row.
      recordRunEvent({ runId: input.runId, automationId: automation.id, chatId,
        kind: "automation_origin_report_quiet", sourceEventId: `automation-origin-report-quiet:${automation.id}:${input.runId}`,
        evidencePhase: "executed", payload: { schemaVersion: "agentlas.automation-origin-report.v1",
          sourceMessageId, status: input.status, outcome: input.outcome ?? null, reason: "no_outward_effect" } });
      return false;
    }
    const locale = currentUiLocale();
    const quotaNotice = quotaResetTimes.map(at => formatRuntimeQuotaReset(at, locale, automation.timezone ?? undefined)).filter(Boolean).join("\n");
    const body = [automationOwnerReportBody(input, automationRunDigest(input.runId), locale, approvalRequiredCount),
      quotaNotice ? `${locale === "ko" ? "이번 실행에서 기록된 한도 안내" : "Quota information recorded during this run"}:\n${quotaNotice}` : ""].filter(Boolean).join("\n\n");
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
    queuedForOne = queueGraphResultForOne(db, { automation: { id: automation.id, name: automation.name, monitor: { originChatId: chatId, originMessageId: sourceMessageId } }, runId: input.runId, status: input.status, outcome: input.outcome ?? null,
      error: input.error ?? null, report: body, reportMessageId: message.id });
    return true;
  }).immediate();
  // After commit: the review reads the committed notice. Another process hosting One picks it up on its tick.
  if (queuedForOne) queueMicrotask(wakeOneForGraphResult);
  return delivered;
}

/**
 * A graph's verified login could not continue on its own (automation-scheduler subscribeGraphLoginWait). The run's waiting
 * line told the owner it would continue once the login was restored; this tells them it did not, with the machine cause and
 * Run now, in the run's own conversation when it has one (desktop and phone read the same automation report row). Once per
 * run: a second refusal of the same run adds nothing. Returns the line written, or null when the run has no conversation
 * (the caller still raises its OS notification).
 */
export function announceAutomationContinuationRefused(input: { automationId: string; runId: string; code: string }): string | null {
  const automation = getAutomation(input.automationId);
  const notice = continuationRefusalNotice({ continuation: "graph-login", cause: input.code, locale: currentUiLocale(),
    automationName: automation?.name });
  const sourceEventId = `automation-continuation-refused:${input.automationId}:${input.runId}`;
  return getDb().transaction(() => {
    const db = getDb();
    if (db.prepare("SELECT 1 FROM run_events WHERE run_id = ? AND kind = 'automation_continuation_refused' LIMIT 1").get(input.runId)) return null;
    const sealed = readSealedAutomationRunOrigin(db, input.runId);
    const origin = sealed !== undefined ? sealed : automation ? automationRunOrigin(automation) : null;
    const chatId = origin?.originChatId && getChat(origin.originChatId) ? origin.originChatId : null;
    const message = chatId ? appendChatMessage(chatId, "system", automation ? `${automation.name}\n\n${notice.message}` : notice.message, {
      hostNotice: { purpose: "automation-report", runId: input.runId, automationId: input.automationId },
    }) : null;
    recordRunEvent({ runId: input.runId, automationId: input.automationId, ...(chatId ? { chatId } : {}),
      kind: "automation_continuation_refused", sourceEventId,
      payload: { noticeCode: notice.code, cause: notice.cause, messageId: message?.id ?? null } });
    return notice.message;
  }).immediate();
}
