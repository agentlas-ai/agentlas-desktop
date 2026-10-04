// How a Toolchain came to be, in a few lines (owner 2026-10-05: "누가 언제 이렇게 몇번 쓰다 보니까 툴로 만들어졌다가
// 보일 수 있는 컴퓨터 히스토리 느낌으로"): made, run, became a tool, called by whom, reported, repaired, withdrawn.
// Read from what the store already records: the automation row, its runs and the trigger events that started them,
// and the Toolchain state. No prompt, input or output crosses this boundary.

import type { ToolchainHistoryEvent } from "../../shared/toolchain";
import { getDb } from "../store/db";
import { readToolchainState } from "./store";

type Starter = "one" | "owner" | "schedule" | "caller";

interface RunRow { at: string; starter: Starter; callerChatId: string | null }

function runs(automationId: string): RunRow[] {
  const rows = getDb().prepare(
    `SELECT r.started_at AS at, r.occurrence_id AS occurrence,
            json_extract(t.payload_json, '$.source') AS source, json_extract(t.payload_json, '$.ownerChatId') AS chat
       FROM automation_runs r
       LEFT JOIN automation_trigger_events t
         ON r.occurrence_id LIKE 'trigger-event:%' AND t.id = substr(r.occurrence_id, 15)
      WHERE r.automation_id = ? AND COALESCE(r.dry_run, 0) = 0
      ORDER BY r.started_at ASC`,
  ).all(automationId) as Array<{ at: string; occurrence: string | null; source: string | null; chat: string | null }>;
  return rows.map((row) => {
    if (row.source === "toolchain") return { at: row.at, starter: "caller", callerChatId: row.chat };
    if (row.source === "one-mcp") return { at: row.at, starter: "one", callerChatId: row.chat };
    if (row.occurrence?.startsWith("schedule:")) return { at: row.at, starter: "schedule", callerChatId: null };
    return { at: row.at, starter: "owner", callerChatId: null };
  });
}

function chatTitle(chatId: string | null): string | null {
  if (!chatId) return null;
  try {
    const row = getDb().prepare("SELECT title FROM chats WHERE id = ?").get(chatId) as { title: string | null } | undefined;
    const title = row?.title?.replace(/\s+/g, " ").trim();
    return title ? (title.length > 28 ? `${title.slice(0, 27)}…` : title) : null;
  } catch {
    return null;
  }
}

export function toolchainHistory(automationId: string): ToolchainHistoryEvent[] {
  const automation = getDb().prepare("SELECT created_at, created_by FROM automations WHERE id = ?")
    .get(automationId) as { created_at: string; created_by: string | null } | undefined;
  if (!automation) return [];
  const state = readToolchainState(automationId);
  const contract = state.interface;
  const events: ToolchainHistoryEvent[] = [
    { kind: "made", at: automation.created_at, by: automation.created_by === "user" ? "owner" : "one" },
  ];
  const becameTool = contract?.exposedBy?.at ?? null;

  // Runs before it became a tool, by who started them; after, calls by each calling conversation.
  const groups = new Map<string, { from: string; to: string; count: number; starter: Starter; callerChatId: string | null; after: boolean }>();
  for (const run of runs(automationId)) {
    const after = Boolean(becameTool && run.at >= becameTool);
    const key = `${after ? "after" : "before"}:${run.starter}:${run.starter === "caller" ? run.callerChatId ?? "" : ""}`;
    const group = groups.get(key);
    if (group) { group.count += 1; group.to = run.at; }
    else groups.set(key, { from: run.at, to: run.at, count: 1, starter: run.starter, callerChatId: run.callerChatId, after });
  }
  for (const group of groups.values()) {
    if (group.starter === "caller") {
      events.push({ kind: "called", from: group.from, to: group.to, count: group.count, caller: chatTitle(group.callerChatId) });
    } else {
      events.push({ kind: "ran", from: group.from, to: group.to, count: group.count, by: group.starter });
    }
  }

  if (contract?.exposedBy) {
    const test = contract.coldStart;
    events.push({ kind: "tool", at: contract.exposedBy.at, by: contract.exposedBy.kind, passed: contract.state === "callable" || Boolean(test?.passed),
      tested: test ? `${test.positiveSelected}/${test.positives}` : null });
  }
  for (const report of state.reports ?? []) {
    events.push({ kind: "reported", at: report.at, problem: report.problem.length > 80 ? `${report.problem.slice(0, 79)}…` : report.problem });
    if (report.state === "repaired" && report.settledAt) events.push({ kind: "repaired", at: report.settledAt });
  }
  if (contract?.withdrawnBy) events.push({ kind: "withdrawn", at: contract.withdrawnBy.at });

  const at = (event: ToolchainHistoryEvent) => ("at" in event ? event.at : event.from);
  return events.sort((left, right) => at(left).localeCompare(at(right))).slice(-14);
}
