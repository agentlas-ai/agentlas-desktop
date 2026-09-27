/** Model output requests a wait; only the host can accept/persist it. No
 * permission, execution, completion or notification authority is encoded here. */
export type GoalWaitSubject =
  | { kind: "invocation"; invocationRunId: string; chatId: string }
  | { kind: "artifact"; artifactId: string }
  | { kind: "timer"; notBefore: string };
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
    } else if (subject.kind === "timer" && typeof subject.notBefore === "string" && Number.isFinite(Date.parse(subject.notBefore))
      && item.condition === "due" && Object.keys(subject).every(key => ["kind", "notBefore"].includes(key))) {
      bound = { kind: "timer", notBefore: new Date(subject.notBefore).toISOString() };
    } else return invalid("goal_wait_subject_unsupported");
    return { text: cleaned, request: { status: "requested", intent: { schemaVersion: "agentlas.goal-wait-intent.v1",
      subject: bound, condition: item.condition, nextAction: item.nextAction.trim(), deadline: item.deadline as string | null } } };
  } catch { return invalid("goal_wait_request_malformed"); }
}

/**
 * Timer waits are admitted only for ongoing Goals (wait-subscriptions: goal_wait_ongoing_authority_required).
 * Measured 2026-09-27 (owner's "X Marketing" One goal, lifecycle finite): the protocol advertised the timer
 * subject to every Goal, the model twice requested a one-week follow-up timer, the host refused it twice
 * ("The wait was not registered…") and the automatic-goal cap stopped the goal. A finite Goal is told the
 * truth instead: no timer; finish the turn and name the later check in the reply.
 */
export function goalWaitProtocol(lifecycle?: "finite" | "ongoing" | null): string {
  return `When this Goal must wait for an already observed Desktop invocation or an existing artifact input to change, request a durable wait and end this turn. Do not repeatedly call a model to poll unchanged state. Waits are checked only while the app is running. Do not promise a wait was accepted; the host returns a durable registration receipt. Do not declare the Goal complete in the same response. Only use actual IDs already observed; never invent a subject. CI, arbitrary URLs and other external jobs currently need their own supported monitor and cannot be represented as an invocation ID.
Emit at most one block:
\`\`\`agentlas-goal-wait
{"schemaVersion":"agentlas.goal-wait-intent.v1","subject":{"kind":"invocation","invocationRunId":"observed ID","chatId":"observed chat ID"},"condition":"terminal","nextAction":"What to inspect after it settles","deadline":null}
\`\`\`
For a saved artifact input, use subject {"kind":"artifact","artifactId":"observed artifact ID"} and condition "changed". ${lifecycle !== "finite"
    ? `For an explicitly ongoing Goal, use subject {"kind":"timer","notBefore":"future ISO timestamp"} and condition "due" to wait until the next useful work cycle. Respect the user's cadence, and inspect current external state before acting; never repeat an already completed post or purchase. Timer waits cannot be earlier than one minute from now.`
    : `This Goal is a one-time (finite) Goal: a timer subject is refused unless a goal deadline is stated below. Without one, when the remaining outcome can only be measured later (followers, views, replies next week), do not request a wait: finish this turn normally, and state in your reply what should be re-measured and when, so the owner can ask for continued tracking.`} A requested deadline must be an ISO timestamp; null preserves no user-imposed deadline. New user directions, Stop and changed Goal authority always override this request.`;
}

/**
 * Per-turn clause for a finite Goal whose current revision has a host-resolved deadline (goal-deadline.ts): it may
 * wait for its next work cycle up to the deadline; the host moves a later request to the deadline itself.
 */
export function goalDeadlineWaitClause(deadlineAt: string): string {
  return `This Goal has a deadline: ${deadlineAt}. Until then, keep working toward its target in bounded work cycles. When the next useful step is later (results need time to show), request the timer subject {"kind":"timer","notBefore":"future ISO timestamp"} with condition "due"; notBefore may not be later than the deadline (a later request is moved to the deadline). Inspect current external state before acting and never repeat a completed post or purchase. At the deadline, measure the target and finish the turn without a wait so it is verified.`;
}
