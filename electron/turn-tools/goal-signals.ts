import { parseGoalWaitIntent, type GoalWaitIntent } from "../long-run/wait-emitter";
import { GOAL_COMPLETE_MARKER } from "../hephaestus/loop-engineering";

/*
 * What a model said through the agentlas-turn goal tools during one pass. Instead of teaching the host a second
 * path, the host turns each signal back into the exact text block the pass would otherwise have ended with
 * (applyGoalSignalsToText) and hands it to the unchanged parsers: the wait registration, the completion claim and the
 * ledger verdict therefore run the same code the text protocol runs. No electron import (the daemon loads this).
 */
export interface GoalSignals {
  wait?: GoalWaitIntent;
  complete?: { evidence: string | null };
  /** goal_tactic / goal_plan_op / goal_kpi calls, each as the exact marker line the plan parsers read. */
  planLines?: string[];
}
export const GOAL_PLAN_LINE_LIMIT = 24;
const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_RUNS = 64;
const pending = new Map<string, { at: number; signals: GoalSignals }>();

function prune(now: number): void {
  for (const [key, entry] of pending) if (now - entry.at > TTL_MS) pending.delete(key);
  while (pending.size > MAX_RUNS) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
}
function entryFor(key: string): { at: number; signals: GoalSignals } {
  const now = Date.now();
  prune(now);
  const entry = pending.get(key) ?? { at: now, signals: {} };
  pending.set(key, entry);
  return entry;
}

export type GoalSignalOutcome = "recorded" | "wait_already_requested" | "complete_already_declared" | "conflicts_with_wait" | "conflicts_with_complete";

export function recordGoalWaitSignal(key: string, intent: GoalWaitIntent): GoalSignalOutcome {
  const entry = entryFor(key);
  if (entry.signals.wait) return "wait_already_requested";
  // The text protocol says: never declare the Goal complete in the response that requests a wait.
  if (entry.signals.complete) return "conflicts_with_complete";
  entry.signals.wait = intent;
  return "recorded";
}

export function recordGoalCompleteSignal(key: string, evidence: string | null): GoalSignalOutcome {
  const entry = entryFor(key);
  if (entry.signals.complete) return "complete_already_declared";
  if (entry.signals.wait) return "conflicts_with_wait";
  entry.signals.complete = { evidence };
  return "recorded";
}

/** Queues one validated plan marker line for this pass; false when the per-pass limit is reached. */
export function recordGoalPlanLine(key: string, line: string): boolean {
  const entry = entryFor(key);
  const lines = entry.signals.planLines ?? (entry.signals.planLines = []);
  if (lines.length >= GOAL_PLAN_LINE_LIMIT) return false;
  lines.push(line);
  return true;
}

/** Removes and returns the pass's signals (null when none). */
export function takeGoalSignals(key: string | null | undefined): GoalSignals | null {
  if (!key) return null;
  const entry = pending.get(key);
  pending.delete(key);
  return entry && (entry.signals.wait || entry.signals.complete || entry.signals.planLines?.length) ? entry.signals : null;
}

/** The longest next_action the wait parser takes (long-run/wait-emitter.ts). */
export const GOAL_WAIT_NEXT_ACTION_MAX = 2000;

/**
 * next_action as the wait parser takes it: at most 2000 characters. A model that wrote a longer plan for its next cycle was refused
 * goal_wait_request_invalid (7 times since 10-19; every one of those calls was 2,000+ characters long, cut at the log's 2,014), with a hint
 * that never said which field or how long. The text is kept whole up to the bound; past it, whitespace is collapsed and the end is cut
 * with an ellipsis, so the wait is registered with the start of the plan, where a plan puts what to do first.
 */
export function fitWaitNextAction(value: unknown): unknown {
  if (typeof value !== "string" || value.length <= GOAL_WAIT_NEXT_ACTION_MAX) return value;
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= GOAL_WAIT_NEXT_ACTION_MAX ? flat : `${flat.slice(0, GOAL_WAIT_NEXT_ACTION_MAX - 1).trimEnd()}\u2026`;
}

const WAIT_ARG_KEYS = ["subject_kind", "condition", "invocation_run_id", "chat_id", "artifact_id", "automation_id", "not_before", "next_action", "deadline"] as const;
const squashKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");
const WAIT_ARG_BY_SQUASHED = new Map<string, string>([
  ...WAIT_ARG_KEYS.map((key) => [squashKey(key), key] as [string, string]),
  // Near misses of the documented names that cannot mean anything else.
  ["kind", "subject_kind"], ["subject", "subject_kind"], ["invocationid", "invocation_run_id"], ["runid", "invocation_run_id"],
  ["wakeat", "not_before"], ["resumeat", "not_before"], ["dueat", "not_before"], ["notbeforeat", "not_before"], ["deadlineat", "deadline"],
]);
const WAIT_SUBJECT_FIELDS: Record<string, readonly string[]> = { invocation: ["invocation_run_id", "chat_id"], artifact: ["artifact_id"], automation: ["automation_id"], timer: ["not_before"] };
const WAIT_CONDITION_OF: Record<string, string> = { invocation: "terminal", artifact: "changed", automation: "changed", timer: "due" };

/** A time as the wait parser takes it: an ISO string. Epoch seconds / milliseconds and an empty string are what models write instead. */
function waitTime(value: unknown): unknown {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value < 1e11 ? value * 1000 : value;
    const at = new Date(ms);
    return Number.isFinite(at.getTime()) ? at.toISOString() : value;
  }
  if (typeof value === "string" && !value.trim()) return undefined;
  return value;
}

/**
 * What a goal_wait call means, read the way a person would: `notBefore` / `next-action` / `Kind` are the documented names, a
 * timer with a `not_before` and no `subject_kind` is a timer wait, a missing `condition` is the one the subject kind has, a time
 * given as epoch seconds is that time, and a field this tool does not take (`reason`, `note`) says nothing the wait needs. Refused
 * as before: no readable subject at all, a subject missing its own field, and every value the parser itself rejects
 * (validateGoalWaitIntent), so the registered wait is always what the text protocol would have registered.
 */
export function readGoalWaitArgs(rawArgs: Record<string, unknown>): { args: Record<string, unknown>; ignored: string[] } {
  const args: Record<string, unknown> = {};
  const ignored: string[] = [];
  // The text protocol nests the subject ({"subject":{"kind":"timer","notBefore":...}}); a model that has both in mind writes that here.
  const { subject: nested, ...flat } = rawArgs;
  const raw: Record<string, unknown> = nested && typeof nested === "object" && !Array.isArray(nested)
    ? { ...(nested as Record<string, unknown>), ...flat } : rawArgs;
  for (const [key, value] of Object.entries(raw)) {
    const canonical = WAIT_ARG_BY_SQUASHED.get(squashKey(key));
    if (!canonical) { ignored.push(key); continue; }
    if (args[canonical] === undefined || canonical === key) args[canonical] = value;
  }
  for (const key of ["not_before", "deadline"]) if (key in args) { const t = waitTime(args[key]); if (t === undefined) delete args[key]; else args[key] = t; }
  if (typeof args.subject_kind === "string") args.subject_kind = args.subject_kind.trim().toLowerCase();
  if (args.subject_kind === undefined || args.subject_kind === "") {
    const present = Object.keys(WAIT_SUBJECT_FIELDS).filter((kind) => WAIT_SUBJECT_FIELDS[kind]!.some((field) => args[field] !== undefined));
    // chat_id alone is also an invocation field; a timer carrying its own chat_id is still the timer (its own field decides).
    const decided = present.length === 1 ? present[0] : present.includes("timer") && !present.includes("artifact") && !present.includes("automation") ? "timer" : null;
    if (decided) args.subject_kind = decided;
  }
  const kind = typeof args.subject_kind === "string" ? args.subject_kind : "";
  const own = WAIT_SUBJECT_FIELDS[kind];
  // The condition follows from the kind. Fill it when absent; when it names another kind's condition and the subject is complete, the subject decides.
  if (own && own.every((field) => args[field] !== undefined) && args.condition !== WAIT_CONDITION_OF[kind]) args.condition = WAIT_CONDITION_OF[kind];
  return { args, ignored };
}

const KPI_ID = /^[a-z0-9][a-z0-9_.-]{0,39}$/;
const kpiKey = (value: string): string => value.toLowerCase().replace(/[\s_.-]+/g, "");
function shortHash(text: string): string {
  let a = 0x811c9dc5, b = 0x1b873593 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619) >>> 0;
    b = Math.imul(b + c, 2246822519) >>> 0;
    b ^= b >>> 13;
  }
  return `${a.toString(36)}${b.toString(36)}`.slice(0, 12);
}

/**
 * The `kpi` of a goal_kpi sample as the KPI parser (shared/agent-strategy.ts kpiIdOf) can read it. The parser takes an ASCII id
 * (a-z, 0-9, _ . -, at most 40); a model that wrote the KPI's display name (일일_파생_숏폼_게시_수) was refused goal_kpi_invalid four times
 * in a row, and the retry with name/unit added failed the same way because the id was still the name. A label that is the id or the
 * name of one of this Goal's KPIs is that KPI; any other label becomes a stable ASCII id (k-<hash of the label>) and, when the sample
 * names none, its name, so the sample defines a tracked KPI of that name instead of being dropped.
 */
export function resolveKpiSampleId(args: Record<string, unknown>, existing: ReadonlyArray<{ kpiId: string; name: string }>): Record<string, unknown> {
  const raw = typeof args.kpi === "string" ? args.kpi.replace(/\s+/g, " ").trim() : "";
  if (!raw) return args;
  const known = existing.find((item) => item.kpiId.toLowerCase() === raw.toLowerCase());
  if (known) return args;
  if (KPI_ID.test(raw.toLowerCase().slice(0, 40))) return args;
  const byLabel = existing.find((item) => kpiKey(item.kpiId) === kpiKey(raw) || (item.name && kpiKey(item.name) === kpiKey(raw)));
  if (byLabel) return { ...args, kpi: byLabel.kpiId };
  const named = typeof args.name === "string" && args.name.trim();
  return { ...args, kpi: `k-${shortHash(kpiKey(raw))}`, ...(named ? {} : { name: raw.replace(/_/g, " ").slice(0, 80) }) };
}

/** goal_complete's evidence / summary as text: a list of lines, a number or a flag is what it says; anything else is not evidence. */
export function completionText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) { const parts = value.filter((item): item is string | number => typeof item === "string" || typeof item === "number"); return parts.length ? parts.join("; ") : undefined; }
  return undefined;
}

/** The marker the text protocol would carry for this evidence; the payload cannot contain `>` or a line break. */
export function goalCompleteMarkerText(evidence: string | null): string {
  const clean = (evidence ?? "").replace(/[>\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
  return clean ? GOAL_COMPLETE_MARKER.replace(">>", `: ${clean}>>`) : GOAL_COMPLETE_MARKER;
}

export function goalWaitBlockText(intent: GoalWaitIntent): string {
  return "```agentlas-goal-wait\n" + JSON.stringify(intent) + "\n```";
}

/**
 * Append the equivalent text blocks to the pass's reply. A reply that already carries its own wait block keeps it
 * (the parser refuses two); a tool wait is then ignored rather than making the request ambiguous.
 */
export function applyGoalSignalsToText(text: string, signals: GoalSignals | null): string {
  if (!signals) return text;
  let out = text;
  if (signals.planLines?.length) out = `${out.trimEnd()}\n${signals.planLines.join("\n")}`;
  if (signals.wait && !out.includes("```agentlas-goal-wait")) out = `${out.trimEnd()}\n\n${goalWaitBlockText(signals.wait)}`;
  else if (signals.complete && !signals.wait) out = `${out.trimEnd()}\n${goalCompleteMarkerText(signals.complete.evidence)}`;
  return out;
}

/** The wait the text parser would register for this intent, or its refusal reason. */
export function validateGoalWaitIntent(intent: unknown): { ok: true; intent: GoalWaitIntent } | { ok: false; reason: string } {
  const parsed = parseGoalWaitIntent("```agentlas-goal-wait\n" + JSON.stringify(intent) + "\n```").request;
  if (parsed?.status === "requested") return { ok: true, intent: parsed.intent };
  return { ok: false, reason: parsed?.status === "invalid" ? parsed.reason : "goal_wait_request_invalid" };
}

/**
 * Goal text that stays when goal_wait / goal_complete replace the marker teaching. A finite Goal needs none (the tools
 * carry the format); an ongoing Goal's mandate is behaviour the schemas cannot say.
 */
export function typedGoalLifecycleProtocol(lifecycle: "finite" | "ongoing" | null | undefined): string | null {
  if (lifecycle !== "ongoing") return null;
  return "## Ongoing Goal\nmandate: continuing, open until the user stops it; bounded episodes; read state + receipts first; never repeat a done or uncertain effect; goal_complete closes the episode; nothing due: goal_wait (timer)";
}

/** Deadline clause for a Goal whose timer waits go through the goal_wait tool (no JSON grammar). */
export function typedGoalDeadlineClause(deadlineAt: string): string {
  return `deadline: ${deadlineAt}; bounded cycles; timer goal_wait <= deadline (later is moved); check state first, never repeat a done post or purchase; at deadline measure and finish without a wait`;
}
