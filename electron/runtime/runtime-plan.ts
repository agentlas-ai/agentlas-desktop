/**

















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

function taskId(value: unknown): string | undefined {
  return text(value) ?? (typeof value === "number" && Number.isFinite(value) ? String(value) : undefined);
}

/** A task as Claude reported it in a structured result (TaskList item, TaskGet task), or null without id and subject. */
function reportedTask(value: unknown, known: InvocationPlanEntry | undefined): InvocationPlanEntry | null {
  const task = record(value);
  const id = taskId(task?.id);
  const subject = text(task?.subject) ?? known?.text;
  if (!id || !subject) return null;
  return boundInvocationPlan({
    entries: [{ id, text: subject, activeText: text(task?.activeForm) ?? known?.activeText, status: status(task?.status) ?? known?.status ?? "pending" }],
  })?.entries[0] ?? null;
}

/**
 * Claude keeps one task list per native session, across turns (Claude Code 2.1.301 stores it under
 * $CLAUDE_CONFIG_DIR/tasks/<session_id>/; a later turn's TaskUpdate names a task an earlier turn created). The checklist
 * a turn shows is still that turn's own: it starts from the session's list only while that list has unfinished steps,
 * and a finished list is remembered for its names but not drawn again. In-memory and bounded; after a restart the
 * model's own TaskList / TaskGet results teach the names back.
 */
interface ClaudeSessionTasks { shown: InvocationPlanEntry[]; known: Map<string, InvocationPlanEntry> }
const CLAUDE_SESSION_TASKS_MAX = 64;
const CLAUDE_SESSION_KNOWN_MAX = 200;
const claudeSessionTasks = new Map<string, ClaudeSessionTasks>();

function rememberClaudeSessionTasks(sessionId: string, value: ClaudeSessionTasks): void {
  claudeSessionTasks.delete(sessionId);
  claudeSessionTasks.set(sessionId, value);
  while (claudeSessionTasks.size > CLAUDE_SESSION_TASKS_MAX) {
    const oldest = claudeSessionTasks.keys().next().value;
    if (oldest === undefined) break;
    claudeSessionTasks.delete(oldest);
  }
}

/**
 * Claude Code's todo tools. TodoWrite sends the whole list; TaskCreate/TaskUpdate
 * are incremental and keyed by the id Claude returns in the structured
 * `tool_use_result`; TaskList returns the session's whole list and TaskGet one
 * task. An update for a task the session never reported (no subject known) is
 * skipped rather than drawn with an invented name.
 */
export class ClaudeTaskPlanTracker {
  private entries: InvocationPlanEntry[] = [];
  /** Every task of the native session this turn has a name for, by id (TaskCreate, TaskList, TaskGet, an earlier turn). */
  private known = new Map<string, InvocationPlanEntry>();
  private sessionId: string | null = null;
  private readonly calls = new Map<string, { name: string; input: Record<string, unknown> }>();

  /** The first todo-tool call names the native session; the turn starts from that session's unfinished list. */
  private adopt(sessionId: string | undefined): void {
    if (this.sessionId !== null || !sessionId) return;
    this.sessionId = sessionId;
    const carried = claudeSessionTasks.get(sessionId);
    if (!carried) return;
    for (const [id, entry] of carried.known) if (!this.known.has(id)) this.known.set(id, entry);
    if (this.entries.length === 0 && carried.shown.some((entry) => entry.status !== "completed")) this.entries = [...carried.shown];
  }

  private remember(): void {
    if (!this.sessionId) return;
    while (this.known.size > CLAUDE_SESSION_KNOWN_MAX) {
      const oldest = this.known.keys().next().value;
      if (oldest === undefined) break;
      this.known.delete(oldest);
    }
    rememberClaudeSessionTasks(this.sessionId, { shown: [...this.entries], known: new Map(this.known) });
  }

  toolUse(id: string | undefined, name: string, input: unknown, sessionId?: string): void {
    if (!id || !["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"].includes(name)) return;
    this.adopt(sessionId);
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
    const changed = this.apply(call, result);
    this.remember();
    if (!changed) return null;
    return sameInvocationPlan({ entries: before }, { entries: this.entries }) ? null : { entries: this.entries };
  }

  private apply(call: { name: string; input: Record<string, unknown> }, result: Record<string, unknown> | null): boolean {
    if (call.name === "TaskGet") {
      // A read: it teaches the task's name for a later update, and refreshes a step this turn already shows.
      const id = taskId(record(result?.task)?.id);
      const task = reportedTask(result?.task, id ? this.known.get(id) : undefined);
      if (!task?.id) return false;
      this.known.set(task.id, task);
      const index = this.entries.findIndex((entry) => entry.id === task.id);
      if (index < 0) return false;
      this.entries = this.entries.map((entry, position) => position === index ? task : entry);
      return true;
    }
    if (call.name === "TaskList") {
      if (!Array.isArray(result?.tasks)) return false;
      const tasks = result.tasks.map((item) => reportedTask(item, this.known.get(taskId(record(item)?.id) ?? ""))).filter((task): task is InvocationPlanEntry => !!task?.id);
      for (const task of tasks) this.known.set(task.id!, task);
      // The session's whole list is authoritative; a list that is all done is not drawn as a new checklist.
      if (this.entries.length === 0 && tasks.every((task) => task.status === "completed")) return false;
      const next = boundInvocationPlan({ entries: tasks });
      if (!next) return false;
      this.entries = next.entries;
      return true;
    }
    if (call.name === "TodoWrite") {
      const todos = Array.isArray(call.input.todos) ? call.input.todos : null;
      if (!todos) return false;
      this.entries = boundInvocationPlan({
        entries: todos.map((todo) => ({
          id: text(record(todo)?.id),
          text: record(todo)?.content,
          activeText: record(todo)?.activeForm,
          status: status(record(todo)?.status),
        })),
      })?.entries ?? [];
      return true;
    }
    if (call.name === "TaskCreate") {
      const task = record(result?.task);
      const id = taskId(task?.id);
      const subject = text(task?.subject) ?? text(call.input.subject);
      if (!id || !subject || this.entries.some((entry) => entry.id === id)) return false;
      const next = boundInvocationPlan({
        entries: [...this.entries, { id, text: subject, activeText: call.input.activeForm, status: "pending" }],
      });
      if (!next) return false;
      this.entries = next.entries;
      const created = next.entries.find((entry) => entry.id === id);
      if (created) this.known.set(id, created);
      return true;
    }
    // TaskUpdate
    if (result && result.success === false) return false;
    const id = taskId(call.input.taskId);
    if (!id) return false;
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (call.input.status === "deleted") {
      this.known.delete(id);
      if (index < 0) return false;
      this.entries = this.entries.filter((_, position) => position !== index);
      return true;
    }
    // A task an earlier turn created (or TaskList / TaskGet reported) joins this turn's checklist when it is worked on.
    const current = index >= 0 ? this.entries[index] : this.known.get(id);
    if (!current) return false;
    const next = boundInvocationPlan({
      entries: [{
        id,
        text: text(call.input.subject) ?? current.text,
        activeText: text(call.input.activeForm) ?? current.activeText,
        status: status(call.input.status) ?? current.status,
      }],
    })?.entries[0];
    if (!next) return false;
    this.known.set(id, next);
    const updated = index >= 0 ? this.entries.map((entry, position) => position === index ? next : entry) : [...this.entries, next];
    const bounded = boundInvocationPlan({ entries: updated });
    if (!bounded) return false;
    this.entries = bounded.entries;
    return true;
  }
}

/** One emitter per turn: forwards a bounded snapshot only when it differs from the last one sent. */
/**
 * Cursor sends its todo list as the vendor notification `cursor/update_todos` instead of an ACP `plan` update.
 * `merge: true` updates the turn's list by todo id (an unknown id is appended), `merge: false` replaces it; a
 * `cancelled` todo leaves the list (it has no checklist status). Returns the new full list, or null for a malformed one.
 */
export class CursorTodoPlanTracker {
  private entries: InvocationPlanEntry[] = [];

  update(params: unknown): InvocationPlan | null {
    const value = record(params);
    if (!value || !Array.isArray(value.todos)) return null;
    const incoming = value.todos.flatMap((todo) => {
      const item = record(todo);
      const id = taskId(item?.id);
      if (!item || !id) return [];
      return [{ id, text: text(item.content), cancelled: item.status === "cancelled", status: status(item.status) }];
    });
    let next: InvocationPlanEntry[] = value.merge === true ? [...this.entries] : [];
    for (const todo of incoming) {
      const at = next.findIndex((entry) => entry.id === todo.id);
      if (todo.cancelled) { if (at >= 0) next.splice(at, 1); continue; }
      const known = at >= 0 ? next[at] : undefined;
      const textValue = todo.text ?? known?.text;
      const statusValue = todo.status ?? known?.status;
      if (!textValue || !statusValue) continue;
      const entry: InvocationPlanEntry = { id: todo.id, text: textValue, status: statusValue };
      if (at >= 0) next[at] = entry; else next.push(entry);
    }
    next = boundInvocationPlan({ entries: next })?.entries ?? [];
    this.entries = next;
    return { entries: next };
  }
}

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
