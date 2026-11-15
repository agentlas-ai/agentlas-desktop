// Pure helpers of the Manage agents screen (Agentlas 2.0 F-D8 / F-D9): no React, no IPC. A value the host did not give is absent here, never made up.
import type { AgentModelLine, RuntimeStatus } from "@shared/types";
import type { AgentWorkspaceDiff, AgentWorkspaceProposal, AgentWorkspaceRevision, AgentWorkspaceSnapshot, AgentWorkspaceChange } from "@shared/agent-workspace";
import type { DesktopMemoryListEntry } from "@shared/desktop-memory-inspector";
import { runtimeEngineLabel, runtimeModelDisplayLabel } from "@/components/dashboard/RuntimeModelPicker";
import { effortOptions } from "@/lib/effort-label";
import { diffLines } from "./line-diff";

/** The Science research director has no model popover (Science picks its own model). */
export const SCIENCE_AGENT_SLUG = "agentlas-science-research-director";

/** "11/9" in both languages (the pictures use month/day). */
export function shortDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : `${date.getMonth() + 1}/${date.getDate()}`;
}
export function shortDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** "now" for something that is minutes old, else the date. */
export function whenLabel(value: string, ko: boolean, nowMs: number): string {
  const at = new Date(value).getTime();
  if (Number.isNaN(at)) return "";
  return nowMs - at < 5 * 60_000 && nowMs >= at ? (ko ? "방금" : "now") : shortDate(value);
}

export function runtimeForLine(line: Pick<AgentModelLine, "kind" | "backend" | "acpAgentId">, runtimes: RuntimeStatus[]): RuntimeStatus | null {
  return runtimes.find((item) => item.kind === line.kind && (!line.backend || item.backend === line.backend) && (item.acpAgentId ?? "") === (line.acpAgentId ?? "")) ?? null;
}
/** The model name and the engine name of one line; the model is the line's own value, else what the engine runs now. */
export function lineLabels(line: AgentModelLine, runtimes: RuntimeStatus[], locale: "ko" | "en"): { model: string; engine: string } {
  const runtime = runtimeForLine(line, runtimes);
  const engine = runtime ? runtimeEngineLabel(runtime) : line.kind;
  const model = line.model ? (runtime ? runtimeModelDisplayLabel({ ...runtime, model: line.model }, locale) : line.model) : (runtime ? runtimeModelDisplayLabel({ ...runtime, model: undefined }, locale) : engine);
  return { model, engine };
}
export function effortLabel(line: AgentModelLine, runtimes: RuntimeStatus[], locale: "ko" | "en"): string | null {
  if (!line.effort) return null;
  const runtime = runtimeForLine(line, runtimes);
  return effortOptions(runtime?.efforts, locale).find((item) => item.id === line.effort)?.label ?? line.effort;
}

/** What the machine codes of the model order calls say, in the owner's words. */
export function modelRefusalText(code: string, ko: boolean): string {
  const copy: Record<string, [string, string]> = {
    own_order_empty: ["순서에 모델이 하나 이상 있어야 해요.", "The order needs at least one model."],
    own_order_too_long: ["순서는 최대 12개까지예요.", "The order can have up to 12 lines."],
    own_order_line_invalid: ["이 모델은 에이전트 순서에 사용할 수 없어요.", "This line can't be used in an agent's order. Pick another model."],
    own_order_nothing_to_copy: ["대시보드에서 워커 모델을 먼저 선택해 주세요.", "There is no Worker order to copy yet. Choose a model on the Dashboard first."],
    agent_not_found: ["에이전트를 찾을 수 없어요.", "The agent could not be found."],
    unavailable: ["잠시 후 다시 시도해 주세요.", "The model order can't be changed right now. Try again in a moment."],
  };
  return (copy[code] ?? copy.unavailable)[ko ? 0 : 1];
}

// ---- Timeline -----------------------------------------------------------------------------------------------------------------------------

export type TimelineMemoryGroup = { key: string; at: string; project: string | null; entries: DesktopMemoryListEntry[] };
/** New memory lines grouped by day and project, newest group first. `limit` groups at most. */
export function memoryGroups(entries: DesktopMemoryListEntry[], limit: number): TimelineMemoryGroup[] {
  const groups = new Map<string, TimelineMemoryGroup>();
  for (const entry of entries) {
    if (entry.status !== "active") continue;
    const date = new Date(entry.createdAt);
    if (Number.isNaN(date.getTime())) continue;
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}|${entry.projectSlug ?? ""}`;
    const group = groups.get(key) ?? { key, at: entry.createdAt, project: entry.projectSlug, entries: [] };
    group.entries.push(entry);
    if (entry.createdAt > group.at) group.at = entry.createdAt;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** The skill a change creates: `skills/<name>/SKILL.md` (or any file under skills/). */
export function createdSkillName(changes: AgentWorkspaceChange[]): string | null {
  for (const change of changes) {
    if (change.operation !== "create") continue;
    const match = /^skills\/([^/]+)\//.exec(change.path);
    if (match) return match[1];
  }
  return null;
}
/** Up to `max` changed lines (−/+) of the first modified file: what the "My rules changed" card shows. */
export function miniDiff(change: AgentWorkspaceChange, max: number): Array<{ sign: "+" | "-"; text: string }> {
  const rows: Array<{ sign: "+" | "-"; text: string }> = [];
  for (const row of diffLines(change.beforeContent, change.afterContent)) {
    if (row.kind === "remove") rows.push({ sign: "-", text: row.text });
    else if (row.kind === "add") rows.push({ sign: "+", text: row.text });
    if (rows.length >= max) break;
  }
  return rows;
}

export type EvolvedItem = { id: string; at: string; revision: AgentWorkspaceRevision };
/** Revisions that are the agent's own change (not the first state, not a sync), newest first. */
export function evolvedRevisions(snapshot: AgentWorkspaceSnapshot | null, limit: number): EvolvedItem[] {
  return [...(snapshot?.history ?? [])]
    .filter((revision) => revision.operation === "apply" || revision.operation === "external_edit" || revision.operation === "rollback")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map((revision) => ({ id: revision.id, at: revision.createdAt, revision }));
}
/** Proposals waiting for the owner, newest first. */
export function waitingProposals(snapshot: AgentWorkspaceSnapshot | null): AgentWorkspaceProposal[] {
  return (snapshot?.proposals ?? []).filter((proposal) => proposal.status === "review_ready").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export type { AgentWorkspaceDiff };
