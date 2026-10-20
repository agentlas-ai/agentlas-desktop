/** Model output requests a wait; only the host can accept/persist it. No
 * permission, execution, completion or notification authority is encoded here. */
export type GoalWaitSubject =
  | { kind: "invocation"; invocationRunId: string; chatId: string }
  | { kind: "artifact"; artifactId: string }
  | { kind: "timer"; notBefore: string }
  /** A saved graph that reads a value on its own schedule; the Goal wakes when its output changes. */
  | { kind: "automation"; automationId: string };
export interface GoalWaitIntent {
  schemaVersion: "agentlas.goal-wait-intent.v1";
  subject: GoalWaitSubject;
  condition: "terminal" | "changed" | "due";
  nextAction: string;
  deadline: string | null;
}
export type ParsedGoalWait = { status: "requested"; intent: GoalWaitIntent } | { status: "invalid"; reason: string };
const marker = /```agentlas-goal-wait\s*\n([\s\S]*?)```/g;
const identifier = (value: unknown): value is string => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 512;
export function stripGoalWaitDisplayText(text: string): string {
  const start = text.indexOf("```agentlas-goal-wait");
  return start < 0 ? text : text.slice(0, start).trimEnd();
}
export function parseGoalWaitIntent(text: string): { text: string; request: ParsedGoalWait | null } {
  const matches = [...text.matchAll(marker)];
  if (!matches.length) return { text: stripGoalWaitDisplayText(text), request: text.includes("```agentlas-goal-wait") ? { status: "invalid", reason: "goal_wait_request_malformed" } : null };
  const cleaned = text.replace(marker, "").trim();
  const invalid = (reason: string) => ({ text: cleaned, request: { status: "invalid" as const, reason } });
  if (matches.length !== 1 || cleaned.includes("```agentlas-goal-wait") || matches[0][1].length > 8192) return invalid("goal_wait_request_ambiguous");
  try {
    const value: unknown = JSON.parse(matches[0][1]);
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("goal_wait_request_invalid");
    const item = value as Record<string, unknown>, subject = item.subject as Record<string, unknown> | undefined;
    if (item.schemaVersion !== "agentlas.goal-wait-intent.v1" || !subject || typeof subject !== "object" || Array.isArray(subject)
      || typeof item.nextAction !== "string" || !item.nextAction.trim() || item.nextAction.length > 2000
      || (item.deadline !== null && (typeof item.deadline !== "string" || !Number.isFinite(Date.parse(item.deadline))))) return invalid("goal_wait_request_invalid");
    if (Object.keys(item).some(key => !["schemaVersion", "subject", "condition", "nextAction", "deadline"].includes(key))) return invalid("goal_wait_request_unknown_field");
    let bound: GoalWaitSubject;
    if (subject.kind === "invocation" && identifier(subject.invocationRunId) && identifier(subject.chatId) && item.condition === "terminal"
      && Object.keys(subject).every(key => ["kind", "invocationRunId", "chatId"].includes(key))) {
      bound = { kind: "invocation", invocationRunId: subject.invocationRunId, chatId: subject.chatId };
    } else if (subject.kind === "artifact" && identifier(subject.artifactId) && item.condition === "changed"
      && Object.keys(subject).every(key => ["kind", "artifactId"].includes(key))) {
      bound = { kind: "artifact", artifactId: subject.artifactId };
    } else if (subject.kind === "automation" && identifier(subject.automationId) && item.condition === "changed"
      && Object.keys(subject).every(key => ["kind", "automationId"].includes(key))) {
      bound = { kind: "automation", automationId: subject.automationId };
    } else if (subject.kind === "timer" && typeof subject.notBefore === "string" && Number.isFinite(Date.parse(subject.notBefore))
      && item.condition === "due" && Object.keys(subject).every(key => ["kind", "notBefore"].includes(key))) {
      bound = { kind: "timer", notBefore: new Date(subject.notBefore).toISOString() };
    } else return invalid("goal_wait_subject_unsupported");
    return { text: cleaned, request: { status: "requested", intent: { schemaVersion: "agentlas.goal-wait-intent.v1",
      subject: bound, condition: item.condition, nextAction: item.nextAction.trim(), deadline: item.deadline as string | null } } };
  } catch { return invalid("goal_wait_request_malformed"); }
}








export function goalWaitProtocol(lifecycle?: "finite" | "ongoing" | null): string {
  return `Goal wait (host block, not a tool): waiting on an observed invocation, saved artifact, graph output or timer; end the turn after it. Never wait to poll a model; never invent IDs; never claim accepted (the host returns a receipt) or complete in the same reply.
One block max:
\`\`\`agentlas-goal-wait
{"schemaVersion":"agentlas.goal-wait-intent.v1","subject":{"kind":"invocation","invocationRunId":"observed ID","chatId":"observed chat ID"},"condition":"terminal","nextAction":"what to inspect after","deadline":null}
\`\`\`
subjects: {"kind":"artifact","artifactId":"ID"} + "changed" | {"kind":"automation","automationId":"saved graph ID"} + "changed" (graph reads a value on its own schedule with no agent step; host wakes this Goal when its output changes) | ${lifecycle !== "finite"
    ? `{"kind":"timer","notBefore":"future ISO"} + "due" (at least 1 min ahead; check external state first, never repeat a done post or purchase)`
    : `timer: refused without a goal deadline; value measurable only later: finish now and state what to re-measure and when`}
deadline: ISO or null. User direction, Stop, authority changes override.`;
}

/**
 * Per-turn clause for a finite Goal whose current revision has a host-resolved deadline (goal-deadline.ts): it may
 * wait for its next work cycle up to the deadline; the host moves a later request to the deadline itself.
 */
export function goalDeadlineWaitClause(deadlineAt: string): string {
  return `deadline: ${deadlineAt}; work in bounded cycles; later step: {"kind":"timer","notBefore":"future ISO"} + "due", notBefore <= deadline (later is moved); check state first, never repeat a done post or purchase; at deadline measure and finish without a wait`;
}
