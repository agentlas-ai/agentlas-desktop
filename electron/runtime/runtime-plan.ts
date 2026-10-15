/**
 * Native runtime plans → the one typed checklist (shared/invocation-plan.ts).
 *
 * Only structured protocol fields are read here. A runtime that has no plan
 * event (Antigravity, BYOK, Agentlas serving, local models) never reaches this
 * module, and nothing here asks a model to plan — that would be prompt text.
 *
 *   Codex app-server   turn/plan/updated { plan: [{ step, status: pending|inProgress|completed }] }
 *   codex exec --json  item.* { type: "todo_list", items: [{ text, completed }] }
 *   ACP                session/update { sessionUpdate: "plan", entries: [{ content, status }] }
 *   Claude Code        TodoWrite { todos: [{ content, status, activeForm }] }
 *                      TaskCreate { subject, activeForm } + result { task: { id } }
 *                      TaskUpdate { taskId, status, subject, activeForm } + result { success }
 */
import {
  boundInvocationPlan,
  sameInvocationPlan,
  type InvocationPlan,
  type InvocationPlanEntry,
  type InvocationPlanStatus,
} from "../../shared/invocation-plan";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function status(value: unknown): InvocationPlanStatus | undefined {
  if (value === "pending") return "pending";
  if (value === "in_progress" || value === "inProgress") return "in_progress";
  if (value === "completed") return "completed";
  return undefined;
}

/** Codex app-server `turn/plan/updated` params. */
export function planFromCodexTurnPlan(params: unknown): InvocationPlan | null {
  const steps = record(params)?.plan;
  if (!Array.isArray(steps)) return null;
  return boundInvocationPlan({
    entries: steps.map((step) => ({ text: record(step)?.step, status: status(record(step)?.status) })),
  });
}

/** `codex exec --json` `todo_list` item. The protocol carries only done/not done; no active step is invented. */
export function planFromCodexTodoList(item: unknown): InvocationPlan | null {
  const value = record(item);
  if (value?.type !== "todo_list" || !Array.isArray(value.items)) return null;
  return boundInvocationPlan({
    entries: value.items.map((entry) => ({
      text: record(entry)?.text,
      status: record(entry)?.completed === true ? "completed" : record(entry)?.completed === false ? "pending" : undefined,
    })),
  });
}

/** ACP `session/update` with `sessionUpdate: "plan"`. Each update is the complete list (ACP spec). */
export function planFromAcpPlanUpdate(update: unknown): InvocationPlan | null {
  const value = record(update);
  if (value?.sessionUpdate !== "plan" || !Array.isArray(value.entries)) return null;
  return boundInvocationPlan({
    entries: value.entries.map((entry) => ({ text: record(entry)?.content, status: status(record(entry)?.status) })),
  });
}

/**
 * Claude Code's todo tools. TodoWrite sends the whole list; TaskCreate/TaskUpdate
 * are incremental and keyed by the id Claude returns in the structured
 * `tool_use_result`. An update for a task this turn never saw (no subject known)
 * is skipped rather than drawn with an invented name.
 */
export class ClaudeTaskPlanTracker {
  private entries: InvocationPlanEntry[] = [];
  private readonly calls = new Map<string, { name: string; input: Record<string, unknown> }>();

  toolUse(id: string | undefined, name: string, input: unknown): void {
    if (!id || !["TodoWrite", "TaskCreate", "TaskUpdate"].includes(name)) return;
    this.calls.set(id, { name, input: record(input) ?? {} });
  }

  /** Returns the new snapshot when this result changed the plan, else null. */
  toolResult(id: string | undefined, isError: boolean, structured: unknown): InvocationPlan | null {
    if (!id) return null;
    const call = this.calls.get(id);
    if (!call) return null;
    this.calls.delete(id);
    if (isError) return null;
    const result = record(structured);
    const before = this.entries;
    if (call.name === "TodoWrite") {
      const todos = Array.isArray(call.input.todos) ? call.input.todos : null;
      if (!todos) return null;
      this.entries = boundInvocationPlan({
        entries: todos.map((todo) => ({
          id: text(record(todo)?.id),
          text: record(todo)?.content,
          activeText: record(todo)?.activeForm,
          status: status(record(todo)?.status),
        })),
      })?.entries ?? [];
    } else if (call.name === "TaskCreate") {
      const task = record(result?.task);
      const taskId = text(task?.id) ?? (typeof task?.id === "number" ? String(task.id) : undefined);
      const subject = text(task?.subject) ?? text(call.input.subject);
      if (!taskId || !subject || this.entries.some((entry) => entry.id === taskId)) return null;
      const next = boundInvocationPlan({
        entries: [...this.entries, { id: taskId, text: subject, activeText: call.input.activeForm, status: "pending" }],
      });
      if (!next) return null;
      this.entries = next.entries;
    } else {
      if (result && result.success === false) return null;
      const taskId = text(call.input.taskId) ?? (typeof call.input.taskId === "number" ? String(call.input.taskId) : undefined);
      const index = taskId ? this.entries.findIndex((entry) => entry.id === taskId) : -1;
      if (index < 0) return null;
      if (call.input.status === "deleted") {
        this.entries = this.entries.filter((_, position) => position !== index);
      } else {
        const current = this.entries[index];
        const next = boundInvocationPlan({
          entries: [{
            id: current.id,
            text: text(call.input.subject) ?? current.text,
            activeText: text(call.input.activeForm) ?? current.activeText,
            status: status(call.input.status) ?? current.status,
          }],
        })?.entries[0];
        if (!next) return null;
        this.entries = this.entries.map((entry, position) => position === index ? next : entry);
      }
    }
    return sameInvocationPlan({ entries: before }, { entries: this.entries }) ? null : { entries: this.entries };
  }
}

/** One emitter per turn: forwards a bounded snapshot only when it differs from the last one sent. */
export function createRuntimePlanEmitter(onPlan: ((plan: InvocationPlan) => void) | undefined): (plan: InvocationPlan | null) => void {
  let last: InvocationPlan | null = null;
  return (plan) => {
    if (!onPlan || !plan) return;
    const bounded = boundInvocationPlan(plan);
    if (!bounded || sameInvocationPlan(bounded, last)) return;
    // A first empty snapshot clears nothing; do not emit an empty checklist.
    if (!last && bounded.entries.length === 0) return;
    last = bounded;
    onPlan(bounded);
  };
}
