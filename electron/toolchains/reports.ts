// Result → repair loop for Toolchains (docs/2026-10-04-owner-first-goal-scheduling/PLAN.md §0, owner 2026-10-04:
// "AI가 자동화 결과 받고 직접 수정").
//
// Layer rule: a Toolchain is a leaf tool. Whoever calls it never changes it — a Work task, or another of One's
// conversations, reports "this run was wrong for this input" and the event travels up to the conversation that
// made it. That conversation (or the owner) decides: keep it, fix it with one_graph_patch, or ask. A report never
// starts a turn by itself (commands go down, events go up); the maker sees it on its next turn and the owner sees
// it in the room and on the Toolchains screen.
//
// A fix is a new definition: the contract goes stale and the Toolchain leaves search until a fresh-session test
// passes again. Fixes are budgeted (3 per 24 h without the owner speaking in the making conversation) so a repair
// loop cannot become what the minute-by-minute Goal loop was on 2026-10-04.

import { randomUUID } from "node:crypto";
import { TOOLCHAIN_REPORT_POLICY, type ToolchainReport } from "../../shared/toolchain";
import type { Automation } from "../../shared/types";
import { appendChatMessage, getChat } from "../store/chats";
import { getDb } from "../store/db";
import { tryRecordRunEvent } from "../store/run-events";
import { currentUiLocale } from "../ui-locale";
import { mutateToolchainState, readToolchainState } from "./store";

const DAY_MS = 24 * 60 * 60_000;
const REPAIR_BUDGET_EVENT_KIND = "toolchain_repair_budget_reached";

const clip = (value: string, max: number) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
const clockOf = (iso: string) => {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};

/** The live conversation a Toolchain's events travel up to; null for one the owner made in the editor. */
function makingConversation(automation: Automation): string | null {
  const chatId = automation.monitor?.originChatId;
  const chat = chatId ? getChat(chatId) : null;
  return chat && !chat.archivedAt ? chat.id : null;
}

export function openToolchainReports(automationId: string): ToolchainReport[] {
  return (readToolchainState(automationId).reports ?? []).filter((report) => report.state === "open");
}

export type ToolchainReportOutcome =
  | { state: "reported" | "already_reported"; reportId: string; deliveredTo: "making_conversation" | "owner" }
  | { state: "queue_full"; open: number };

/** Record a caller's report and tell the conversation that made the Toolchain (or the owner) once. */
export function reportToolchainProblem(input: { automation: Automation; reporterChatId: string; eventId: string;
  problem: string; expected?: string | null }): ToolchainReportOutcome {
  const { automation } = input;
  const problem = input.problem.trim();
  const expected = input.expected?.trim() || null;
  if (!problem) throw new Error("toolchain_report_problem_required");
  const target = makingConversation(automation);
  const deliveredTo = target ? "making_conversation" as const : "owner" as const;
  let outcome: ToolchainReportOutcome | null = null;
  let created: ToolchainReport | null = null;
  mutateToolchainState(automation.id, (current) => {
    const reports = current.reports ?? [];
    const prior = reports.find((report) => report.reporterChatId === input.reporterChatId && report.eventId === input.eventId);
    if (prior) { outcome = { state: "already_reported", reportId: prior.id, deliveredTo }; return null; }
    const open = reports.filter((report) => report.state === "open").length;
    if (open >= TOOLCHAIN_REPORT_POLICY.maxOpen) { outcome = { state: "queue_full", open }; return null; }
    created = { id: randomUUID(), at: new Date().toISOString(), reporterChatId: input.reporterChatId, eventId: input.eventId,
      problem: clip(problem, 1_000), expected: expected ? clip(expected, 1_000) : null, state: "open" };
    outcome = { state: "reported", reportId: created.id, deliveredTo };
    return { ...current, reports: [...reports, created].slice(-TOOLCHAIN_REPORT_POLICY.keep) };
  });
  const report = created as ToolchainReport | null;
  if (report && target) {
    const name = readToolchainState(automation.id).interface?.name || automation.name;
    const reporter = getChat(input.reporterChatId)?.title?.trim();
    const ko = currentUiLocale() === "ko";
    const from = reporter ? (ko ? `「${clip(reporter, 60)}」에서` : `"${clip(reporter, 60)}"`) : (ko ? "다른 대화에서" : "Another conversation");
    const text = ko
      ? `${from} 툴체인 「${name}」의 결과가 틀렸다고 알려 왔습니다: ${clip(report.problem, 300)}${report.expected ? ` — 기대한 결과: ${clip(report.expected, 200)}` : ""}`
      : `${from} reported a wrong result from the Toolchain "${name}": ${clip(report.problem, 300)}${report.expected ? ` — expected: ${clip(report.expected, 200)}` : ""}`;
    try {
      appendChatMessage(target, "assistant", text, { hostNotice: { purpose: "host-status", runId: `toolchain-report:${report.id}`, status: "needs-owner" } });
    } catch (error) { console.warn("[toolchain-report] notice failed:", error); }
  }
  // Assigned inside the compare-and-set callback above (control flow cannot see that).
  return outcome as unknown as ToolchainReportOutcome;
}

/** The later of: 24 h ago, the owner's last message in the making conversation. */
function repairWindowFloor(chatId: string, now: number): string {
  const day = new Date(now - DAY_MS).toISOString();
  const said = (getDb().prepare("SELECT MAX(created_at) AS at FROM chat_messages WHERE chat_id = ? AND role = 'user'")
    .get(chatId) as { at: string | null } | undefined)?.at ?? null;
  return said && said > day ? said : day;
}

export type ToolchainRepairVerdict = { ok: true } | { ok: false; repairs: number; retryAt: string };

/**
 * May the making conversation change this Toolchain's definition now? Only graphs that are (or were) Toolchains
 * are budgeted; an ordinary graph being authored is not. Reaching the budget is said once in the conversation.
 */
export function toolchainRepairVerdict(automation: Automation, chatId: string, now = Date.now()): ToolchainRepairVerdict {
  const state = readToolchainState(automation.id);
  if (!state.interface) return { ok: true };
  const since = repairWindowFloor(chatId, now);
  const recent = (state.repairs ?? []).filter((repair) => repair.at > since);
  if (recent.length < TOOLCHAIN_REPORT_POLICY.repairBudget) return { ok: true };
  const retryAt = new Date(Date.parse(recent[0].at) + DAY_MS).toISOString();
  const told = getDb().prepare(`SELECT 1 FROM run_events WHERE chat_id = ? AND kind = ? AND ts > ?
    AND json_extract(payload_json, '$.automationId') = ? LIMIT 1`).get(chatId, REPAIR_BUDGET_EVENT_KIND, since, automation.id);
  if (!told) {
    const noticeRunId = `toolchain-repair-budget:${automation.id}:${Date.parse(since)}`;
    tryRecordRunEvent({ runId: noticeRunId, chatId, kind: REPAIR_BUDGET_EVENT_KIND,
      payload: { automationId: automation.id, repairs: recent.length, budget: TOOLCHAIN_REPORT_POLICY.repairBudget, retryAt } });
    const name = state.interface.name || automation.name;
    try {
      appendChatMessage(chatId, "assistant", currentUiLocale() === "ko"
        ? `툴체인 「${name}」을 오늘 ${recent.length}번 고쳤습니다. 다음 수정은 ${clockOf(retryAt)} 이후에 하거나, 이 대화에서 말씀해 주시면 바로 할 수 있습니다.`
        : `The Toolchain "${name}" was changed ${recent.length} times today. The next change waits until ${clockOf(retryAt)}, or send a message here to allow it now.`,
      { hostNotice: { purpose: "host-status", runId: noticeRunId.slice(0, 128), status: "needs-owner" } });
    } catch (error) { console.warn("[toolchain-report] budget notice failed:", error); }
  }
  return { ok: false, repairs: recent.length, retryAt };
}

/** A definition change by the making conversation: counted for the budget, and it answers the open reports. */
export function recordToolchainRepair(automationId: string, chatId: string, now = Date.now()): void {
  if (!readToolchainState(automationId).interface) return;
  const at = new Date(now).toISOString();
  mutateToolchainState(automationId, (current) => ({
    ...current,
    repairs: [...(current.repairs ?? []), { at, chatId }].slice(-TOOLCHAIN_REPORT_POLICY.keep),
    reports: (current.reports ?? []).map((report) => report.state === "open" ? { ...report, state: "repaired" as const, settledAt: at } : report),
  }));
}
