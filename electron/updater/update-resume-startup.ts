/**
 * First launch after an update the person confirmed with "업데이트하고 이어하기": continue exactly
 * the turns that update interrupted, once.
 *
 * Goals, automations, Alive and Science already continue after any restart through their own
 * recovery (startup checkpoints, the scheduler, host-lost reconciliation, loop resume); their ledger
 * rows are kept for the record only. What had no path at all was a plain One/Work turn (and a
 * teammate's session): this dispatches one system-authored continuation per such turn, marked with
 * the "update-resume" host notice so the chat shows one small line instead of an internal prompt.
 */
import { getDb } from "../store/db";
import { getChat } from "../store/chats";
import { getLatestInvocationRunReceipt } from "../store/run-events";
import { readAttemptEffectReceipt } from "../long-run/attempt-effect-receipt";
import type { McpInvocationRequest } from "../../shared/types";
import {
  consumeUpdateResumeLedger,
  decideUpdateResume,
  recordUpdateResumeOutcome,
  updateResumePrompt,
  type UpdateWorkItem,
} from "./update-resume";

export interface UpdateResumeDispatcher {
  activeChatIds(): string[];
  start(request: McpInvocationRequest, workspaceBinding?: undefined, executionContext?: undefined,
    questionContinuation?: undefined, hostNoticePurpose?: "update-resume"): { runId: string };
}

export interface UpdateResumeOutcome {
  runId: string | null;
  chatId: string | null;
  kind: UpdateWorkItem["kind"];
  action: "resumed" | "skipped" | "failed";
  reason?: string;
  resumedRunId?: string;
}

export function resumeWorkInterruptedByUpdate(userDataPath: string, dispatcher: UpdateResumeDispatcher, nowMs = Date.now()): UpdateResumeOutcome[] {
  // Taken (renamed away) before anything below runs: a crash from here on cannot resume twice.
  const ledger = consumeUpdateResumeLedger(userDataPath);
  if (!ledger) return [];
  const outcomes: UpdateResumeOutcome[] = [];
  const active = new Set(dispatcher.activeChatIds());
  for (const item of ledger.items) {
    const base = { runId: item.runId, chatId: item.chatId, kind: item.kind };
    try {
      if (item.owner !== "update-resume" || !item.chatId || !item.runId) {
        outcomes.push({ ...base, action: "skipped", reason: `owned-by-${item.owner}` });
        continue;
      }
      const chat = getChat(item.chatId);
      const latest = chat ? getLatestInvocationRunReceipt(item.chatId) : null;
      const newerUser = chat ? Boolean(getDb().prepare(
        "SELECT 1 FROM chat_messages WHERE chat_id = ? AND role = 'user' AND created_at > ? LIMIT 1",
      ).get(item.chatId, ledger.armedAt)) : false;
      const decision = decideUpdateResume(ledger, item, {
        chatExists: Boolean(chat),
        chatActive: active.has(item.chatId),
        latestRunId: latest?.runId ?? null,
        latestStatus: latest?.status ?? null,
        newerUserMessage: newerUser,
      }, nowMs);
      if (!decision.resume) {
        outcomes.push({ ...base, action: "skipped", reason: decision.reason });
        continue;
      }
      // The interrupted turn's own receipt answers first (56a241b6): a closed, provably read-only
      // ledger changed nothing outside; only unproven calls are named for checking.
      const receipt = readAttemptEffectReceipt(item.runId);
      const readOnlyByReceipt = receipt.closed && receipt.candidates.length === 0;
      const uncertainCalls = [...new Set(receipt.candidates.map((candidate) => candidate.toolName))];
      const request: McpInvocationRequest = {
        chatId: item.chatId,
        userPrompt: updateResumePrompt({ readOnlyByReceipt, uncertainCalls }),
        promptOrigin: "system",
        taskIntent: item.request?.taskIntent ?? "task",
        ...(item.request?.permissions ? { permissions: item.request.permissions } : {}),
        ...(item.request?.onePermissionMode ? { onePermissionMode: item.request.onePermissionMode } : {}),
        ...(item.request?.runtimeSelection ? { runtimeSelection: item.request.runtimeSelection } : {}),
        ...(item.request?.locale ? { locale: item.request.locale } : {}),
        ...(item.request?.oneMode ? { oneMode: true } : {}),
      };
      const started = dispatcher.start(request, undefined, undefined, undefined, "update-resume");
      active.add(item.chatId);
      outcomes.push({ ...base, action: "resumed", resumedRunId: started.runId,
        reason: readOnlyByReceipt ? "read-only-by-receipt" : uncertainCalls.length ? "unproven-calls-named" : "receipt-open" });
    } catch (error) {
      outcomes.push({ ...base, action: "failed", reason: error instanceof Error ? error.message.slice(0, 160) : "resume_failed" });
    }
  }
  recordUpdateResumeOutcome(userDataPath, { at: new Date(nowMs).toISOString(), outcomes });
  return outcomes;
}
