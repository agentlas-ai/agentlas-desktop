/**
 * The runtime's own task checklist for one invocation, in one shape.
 *
 * Runtimes that break work into steps say so in their own structured protocol:
 * Codex app-server `turn/plan/updated` (and `codex exec` `todo_list` items),
 * ACP `session/update` `plan` entries, Claude Code's TodoWrite and
 * TaskCreate/TaskUpdate tools. The runner normalizes each of those into this
 * snapshot; nothing here reads prose, and a runtime without a native plan never
 * produces one (its turn keeps the one-line activity row only).
 *
 * Every event carries the complete list. A newer snapshot replaces the older
 * one; an empty list means the runtime cleared its plan.
 */

export type InvocationPlanStatus = "pending" | "in_progress" | "completed";

export interface InvocationPlanEntry {
  /** Runtime-assigned step id when the protocol has one (Claude task id). Never invented. */
  id?: string;
  /** The step as the runtime named it. */
  text: string;
  /** Present-continuous form the runtime supplied for the active step ("Running tests"). */
  activeText?: string;
  status: InvocationPlanStatus;
}

export interface InvocationPlan {
  entries: InvocationPlanEntry[];
}

export const INVOCATION_PLAN_MAX_ENTRIES = 50;
export const INVOCATION_PLAN_TEXT_MAX = 300;
const ID_MAX = 128;

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function isStatus(value: unknown): value is InvocationPlanStatus {
  return value === "pending" || value === "in_progress" || value === "completed";
}

/**
 * Closed, bounded projection of an untrusted plan value (runtime output, IPC,
 * ledger payload). Returns null when the value is not a plan at all; entries
 * that do not carry a closed status and a text are dropped, not repaired.
 */
export function boundInvocationPlan(value: unknown): InvocationPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rawEntries = (value as { entries?: unknown }).entries;
  if (!Array.isArray(rawEntries)) return null;
  const entries: InvocationPlanEntry[] = [];
  for (const raw of rawEntries.slice(0, INVOCATION_PLAN_MAX_ENTRIES)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const text = boundedText(record.text, INVOCATION_PLAN_TEXT_MAX);
    if (!text || !isStatus(record.status)) continue;
    const id = boundedText(record.id, ID_MAX);
    const activeText = boundedText(record.activeText, INVOCATION_PLAN_TEXT_MAX);
    entries.push({
      ...(id ? { id } : {}),
      text,
      ...(activeText && activeText !== text ? { activeText } : {}),
      status: record.status,
    });
  }
  return { entries };
}

export function sameInvocationPlan(a: InvocationPlan | null | undefined, b: InvocationPlan | null | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.entries.length !== b.entries.length) return false;
  return a.entries.every((entry, index) => {
    const other = b.entries[index];
    return entry.id === other.id && entry.text === other.text
      && entry.activeText === other.activeText && entry.status === other.status;
  });
}
