import { AUTO_GOAL_SCHEMA, resolveGoalLifecycle, type GoalRevision } from "../../shared/auto-goal";
import { buildAutomaticGoalCriteria } from "../../shared/automatic-goal-criteria";
import { getDb } from "../store/db";

export interface AutomaticCriterionPolicy {
  version: "agentlas.automatic-criterion-policy.v1";
  scopeIndex: number;
  /** v1 recipe only (a fixed evidence criterion inheriting the outcome's proof kind); null for v2. */
  evidenceIndex: number | null;
  outcomeIndex: number;
  initialInvocationRunId: string;
  currentPermission: "read" | "write" | "full";
  provenanceRefs: string[];
}
interface EventRow { id: string; run_id: string; seq: number; ts: string; chat_id: string | null; kind: string; payload_json: string }
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function payload(row: { payload_json: string }): Record<string, unknown> {
  const value = object(JSON.parse(row.payload_json));
  if (!value) throw new Error("automatic_criterion_payload_invalid");
  return value;
}
function canonical(value: unknown): string {
  const sorted = (item: unknown): unknown => Array.isArray(item) ? item.map(sorted)
    : object(item) ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, sorted(val)])) : item;
  return JSON.stringify(sorted(value));
}

/** Recognize Main's ORIGINAL recipe, never criterion IDs or model prose alone.
 * This is not a grant, proof of effects, or a passing verdict. Unknown/custom/
 * amended contracts keep the normal classifier and evidence requirements. */
export function automaticCriterionPolicy(goal: GoalRevision): AutomaticCriterionPolicy | null {
  try {
    if (goal.schemaVersion !== AUTO_GOAL_SCHEMA || goal.revision !== 1 || goal.parentRevision !== null
      || goal.reason !== "initial_execution_request" || goal.originalRequest?.role !== "user"
      || goal.goalId !== `goal:auto-message:${goal.originalRequest.messageId}`
      || goal.chatId !== goal.originalRequest.chatId || !goal.originalRequest.text?.trim()
      || canonical(goal.originalRequest) !== canonical(goal.sourceMessage)
      || goal.objective !== goal.originalRequest.text) return null;
    const db = getDb();
    const revisions = db.prepare("SELECT revision, source_message_id, payload_json, created_at FROM chat_goal_revisions WHERE goal_id=? ORDER BY revision")
      .all(goal.goalId) as Array<{ revision: number; source_message_id: string; payload_json: string; created_at: string }>;
    // No amendment support yet, even when a later revision retained these IDs.
    if (revisions.length !== 1 || revisions[0].revision !== 1
      || revisions[0].source_message_id !== goal.sourceMessage.messageId) return null;
    const stored = payload(revisions[0]);
    if (canonical({ ...stored, lifecycle: resolveGoalLifecycle(stored.lifecycle) })
      !== canonical({ ...goal, lifecycle: resolveGoalLifecycle(goal.lifecycle) })
      || revisions[0].created_at !== goal.createdAt || !Number.isFinite(Date.parse(goal.createdAt))) return null;
    const source = db.prepare("SELECT chat_id, role, text FROM chat_messages WHERE id=?").get(goal.originalRequest.messageId) as
      { chat_id: string; role: string; text: string } | undefined;
    if (!source || source.chat_id !== goal.chatId || source.role !== "user" || source.text !== goal.originalRequest.text) return null;
    const run = db.prepare("SELECT id, root_chat_id, surface FROM long_runs WHERE goal_id=?").get(goal.goalId) as
      { id: string; root_chat_id: string | null; surface: string } | undefined;
    if (!run || run.root_chat_id !== goal.chatId || !["one", "work"].includes(run.surface)) return null;
    const bindings = db.prepare("SELECT seq, actor_kind, payload_json FROM long_run_events WHERE run_id=? AND kind='run.goal_revision_bound' ORDER BY seq")
      .all(run.id) as Array<{ seq: number; actor_kind: string; payload_json: string }>;
    if (bindings.length !== 1 || bindings[0].actor_kind !== "host") return null;
    const bound = payload(bindings[0]);
    if (bound.revision !== 1 || bound.previousRevision !== null || bound.sourceMessageId !== goal.originalRequest.messageId) return null;
    const intakes = db.prepare(`SELECT id, run_id, seq, ts, chat_id, kind, payload_json FROM run_events
      WHERE chat_id=? AND kind='automatic_goal_intake' AND json_valid(payload_json)
      AND json_extract(payload_json,'$.sourceMessageId')=? ORDER BY ts, seq`)
      .all(goal.chatId, goal.originalRequest.messageId) as EventRow[];
    // An ambiguous repeated intake is not authority to select a convenient run.
    if (intakes.length !== 1) return null;
    const intake = intakes[0], decision = payload(intake);
    if (decision.sourceMessageId !== goal.originalRequest.messageId || decision.classified !== true
      || decision.intent !== "execute" || decision.commitment !== "now"
      || resolveGoalLifecycle(decision.lifecycle) !== resolveGoalLifecycle(goal.lifecycle)
      || !Number.isFinite(Date.parse(intake.ts)) || Date.parse(intake.ts) > Date.parse(goal.createdAt)) return null;
    const rows = db.prepare(`SELECT id, run_id, seq, ts, chat_id, kind, payload_json FROM run_events
      WHERE run_id=? AND kind IN ('invoke_started','invoke_prompt_bound') ORDER BY seq`)
      .all(intake.run_id) as EventRow[];
    const starts = rows.filter(row => row.kind === "invoke_started"), prompts = rows.filter(row => row.kind === "invoke_prompt_bound");
    if (starts.length !== 1 || prompts.length !== 1 || rows.some(row => row.chat_id !== goal.chatId)) return null;
    const start = starts[0], prompt = prompts[0], permission = payload(start).permissions;
    if (payload(prompt).promptMessageId !== goal.originalRequest.messageId
      || start.seq >= prompt.seq || prompt.seq >= intake.seq
      || !["read", "write", "full"].includes(String(permission))) return null;
    const controllers = db.prepare(`SELECT a.id FROM long_run_worker_attempts a
      JOIN long_run_workers w ON w.id=a.worker_id AND w.run_id=a.run_id
      WHERE a.run_id=? AND a.invocation_run_id=? AND w.role='controller'`)
      .all(run.id, intake.run_id) as Array<{ id: string }>;
    if (controllers.length !== 1) return null;
    // Reauthorization mutates authorityRefs on revision 1. Reconstruct with
    // the ORIGINAL Main start permission, not the current mutable grant.
    const recipeMatches = (version: "v1" | "v2") => {
      const recipe = buildAutomaticGoalCriteria({ sourceText: source.text, permission: permission as string,
        lifecycle: resolveGoalLifecycle(goal.lifecycle), recipe: version });
      return Array.isArray(goal.acceptanceCriteria) && goal.acceptanceCriteria.length === recipe.length
        && goal.acceptanceCriteria.every((criterion, index) => canonical(criterion) === canonical(recipe[index]));
    };
    const recipeVersion = recipeMatches("v2") ? "v2" : recipeMatches("v1") ? "v1" : null;
    if (!recipeVersion) return null;
    const authorityRefs: string[] = [];
    let currentPermission = permission as "read" | "write" | "full";
    if (goal.authorityChangeReason === undefined && goal.authorityChangedAt === undefined) {
      if (canonical(goal.authorityRefs) !== canonical([`invocation:${intake.run_id}:permission:${permission}`])) return null;
    } else {
      if (goal.authorityChangeReason !== "user_permission_changed" || !goal.authorityChangedAt
        || !Number.isFinite(Date.parse(goal.authorityChangedAt))
        || Date.parse(goal.authorityChangedAt) < Date.parse(goal.createdAt)
        || !Array.isArray(goal.authorityRefs) || goal.authorityRefs.length !== 1) return null;
      const authorityRef = goal.authorityRefs[0];
      const match = /^invocation:permission-change-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:permission:(read|write|full)$/i.exec(authorityRef);
      if (!match) return null;
      const changes = db.prepare(`SELECT id, run_id, seq, ts, chat_id, kind, payload_json FROM run_events
        WHERE run_id=? AND kind='goal_authority_reauthorized' ORDER BY seq`)
        .all(run.id) as EventRow[];
      const change = changes.at(-1);
      if (!change || change.chat_id !== goal.chatId) return null;
      const authored = payload(change);
      if (authored.goalId !== goal.goalId || authored.goalRevision !== goal.revision
        || authored.authorityRef !== authorityRef || authored.permission !== match[1]
        || authored.changedAt !== goal.authorityChangedAt
        || !Number.isFinite(Date.parse(change.ts)) || Date.parse(change.ts) < Date.parse(goal.authorityChangedAt)
        || changes.filter(row => payload(row).authorityRef === authorityRef).length !== 1) return null;
      authorityRefs.push(`event:${change.id}`);
      currentPermission = match[1] as "read" | "write" | "full";
    }
    return { version: "agentlas.automatic-criterion-policy.v1", scopeIndex: 1, evidenceIndex: recipeVersion === "v1" ? 2 : null, outcomeIndex: 0,
      initialInvocationRunId: intake.run_id, currentPermission,
      provenanceRefs: [`goal:${goal.goalId}:revision:1`, `chat-message:${goal.originalRequest.messageId}`,
        `event:${start.id}`, `event:${prompt.id}`, `event:${intake.id}`,
        `long-run-event:${run.id}:${bindings[0].seq}`, `attempt:${controllers[0].id}`, ...authorityRefs] };
  } catch {
    // Missing/corrupt/legacy provenance never grants the special policy lane.
    return null;
  }
}
