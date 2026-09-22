import type { Automation, ScheduleSpec, WorkflowGraph } from "../shared/types";
import { canonicalJsonValue } from "../shared/graph-execution-digest";
import { nextRun, validateCron } from "./store/schedule";

/** A cadence edit, never a new trigger, enable command, budget or end date. */
export type AutomationStrategySchedulePatch = Extract<ScheduleSpec, { kind: "cron" | "interval" }>;

export function parseAutomationStrategySchedulePatch(value: unknown): AutomationStrategySchedulePatch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === "interval") {
    if (Object.keys(raw).some(key => !["kind", "everyMs", "anchor"].includes(key))
      || typeof raw.everyMs !== "number" || !Number.isSafeInteger(raw.everyMs)
      || raw.everyMs < 60_000 || raw.everyMs > 365 * 24 * 60 * 60_000
      || (raw.anchor !== "wallclock" && raw.anchor !== "lastRun")) return null;
    return { kind: "interval", everyMs: raw.everyMs, anchor: raw.anchor };
  }
  if (raw.kind !== "cron" || Object.keys(raw).some(key => !["kind", "expr", "tz"].includes(key))
    || typeof raw.expr !== "string" || raw.expr.length > 256 || raw.expr.trim().split(/\s+/).length !== 5
    || typeof raw.tz !== "string" || raw.tz.length > 128 || !raw.tz.trim()
    || !validateCron(raw.expr)) return null;
  try { new Intl.DateTimeFormat("en", { timeZone: raw.tz }); } catch { return null; }
  return { kind: "cron", expr: raw.expr.trim().replace(/\s+/g, " "), tz: raw.tz };
}

/** Both the graph canvas and scheduler must consume the same new cadence. */
export function prepareAutomationStrategySchedule(
  automation: Automation,
  graph: WorkflowGraph,
  patch: AutomationStrategySchedulePatch,
  from: Date,
): { graph: WorkflowGraph; schedule: string; scheduleJson: string; timezone: string | null; nextRunAt: string } {
  const spec = parseAutomationStrategySchedulePatch(patch);
  if (!spec || automation.triggerType !== "schedule"
    || !automation.scheduleSpec || !["cron", "interval"].includes(automation.scheduleSpec.kind)) {
    throw new Error("automation_strategy_schedule_not_recurring");
  }
  if (JSON.stringify(canonicalJsonValue(spec)) === JSON.stringify(canonicalJsonValue(automation.scheduleSpec))) {
    throw new Error("automation_strategy_schedule_noop");
  }
  const triggers = graph.nodes.filter(node => node.type === "trigger");
  if (triggers.length !== 1) throw new Error("automation_strategy_schedule_trigger_ambiguous");
  const nextRunAt = nextRun(spec, from);
  if (!nextRunAt || Date.parse(nextRunAt) <= from.getTime()) throw new Error("automation_strategy_schedule_no_future_run");
  const schedule = spec.kind === "cron" ? `cron:${spec.expr}` : JSON.stringify(spec);
  return {
    graph: { ...graph, nodes: graph.nodes.map(node => node.id === triggers[0].id
      ? { ...node, config: { ...node.config, schedule, scheduleSpec: spec } } : node) },
    schedule,
    scheduleJson: JSON.stringify(spec),
    timezone: spec.kind === "cron" ? spec.tz : automation.timezone ?? null,
    nextRunAt,
  };
}
