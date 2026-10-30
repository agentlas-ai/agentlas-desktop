import type { LongRunTaskCheckpoint } from "../../shared/long-run-checkpoint";
import { latestTaskCheckpoint } from "../long-run/checkpoint";
import { getChat } from "../store/chats";
import { getChatGoalContract, getChatGoalRevision } from "../store/chat-goals";
import { getLongRunByGoalId, getLongRunGoalRevisionBinding } from "../store/long-runs";
import { isAutoGoalOfRunMessage } from "../long-run/daemon-turn-goal";

/** Host-owned observation, not an execution grant. Nested sessions retain the
 * originating room's binding; they never adopt their hidden session's Goal. */
export interface TeamGoalContext {
  /** The invocation this snapshot was captured for. Its own message's automatic Goal may be admitted while it runs. */
  readonly invocationRunId?: string | null;
  readonly rootChatId: string;
  /** Stored room scope and the invocation's possibly narrower scope. */
  readonly rootProjectId: string | null;
  readonly projectId: string | null;
  /** Raw binding remains observable even when its Goal has ended. */
  readonly boundGoalId: string | null;
  readonly boundRunId: string | null;
  readonly goalId: string | null;
  readonly runId: string | null;
  readonly goalRevision: number | null;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly checkpoint?: LongRunTaskCheckpoint;
}

const observedContexts = new WeakSet<TeamGoalContext>();
function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}
export class TeamGoalContextError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "TeamGoalContextError";
  }
}

function readTeamGoalContext(rootChatId: string, projectId: string | null, withCheckpoint: boolean): TeamGoalContext {
  const chat = getChat(rootChatId);
  if (!chat || (projectId !== null && chat.projectId !== projectId)) throw new TeamGoalContextError("team_goal_owner_changed");
  const rootProjectId = chat.projectId ?? null;
  const boundGoalId = chat.goalId ?? null;
  const run = boundGoalId ? getLongRunByGoalId(boundGoalId) : null;
  const base = { rootChatId, rootProjectId, projectId, boundGoalId, boundRunId: run?.id ?? null };
  const inactive = { ...base, goalId: null, runId: null, goalRevision: null, objective: "", acceptanceCriteria: [] };
  // An ended/stale binding is not an admission veto on a new owner request.
  // The raw identity is still captured so an existing plan cannot adopt a
  // replacement Goal. In-flight active -> inactive changes fail comparison.
  if (projectId !== rootProjectId || !run || run.rootChatId !== rootChatId || run.projectId !== projectId || run.surface === "science"
    || ["completed", "cancelled", "failed", "cancelling", "pausing"].includes(run.status)) return inactive;
  const goalId = run.goalId;
  const revision = getChatGoalRevision(goalId);
  const binding = getLongRunGoalRevisionBinding(run.id);
  if (revision && getChatGoalContract(goalId)?.status !== "active") return inactive;
  if (revision ? revision.chatId !== rootChatId || binding?.revision !== revision.revision : binding !== null) {
    throw new TeamGoalContextError("team_goal_revision_mismatch");
  }
  return { ...base, goalId, runId: run.id, goalRevision: revision?.revision ?? null,
    objective: run.objective, acceptanceCriteria: [...run.acceptanceCriteria],
    ...(withCheckpoint ? { checkpoint: latestTaskCheckpoint(goalId) ?? undefined } : {}) };
}

/**
 * A turn the background service hosts hands its Goal intake to Main (goal-intake-forward.ts) and finishes as an ordinary turn;
 * Main admits the automatic Goal of THIS turn's own message while the planner or a worker is still running, and that Goal
 * follows the turn (daemon-turn-goal.ts). The room gaining it is the turn's own Goal arriving, not a replacement, so the plan
 * (which saw no live Goal) keeps running. Observed in use: intake admitted
 * goal:auto-message:22e9c67e 16 s into the turn, the planner call returned 49 s later and the fence failed the whole turn
 * team_goal_context_changed ("The run failed before it could finish a reply"). Only the exact transition no live Goal ->
 * the Goal derived from the run's own prompt message is adopted; any other change still fails the comparison.
 */
function adoptsOwnAutomaticGoal(context: TeamGoalContext, current: TeamGoalContext): boolean {
  if (!context.invocationRunId || context.goalId !== null || context.runId !== null) return false;
  if (current.rootProjectId !== context.rootProjectId || !current.boundGoalId || current.boundGoalId === context.boundGoalId) return false;
  try { return isAutoGoalOfRunMessage(context.invocationRunId, current.boundGoalId); }
  catch { return false; }
}

export function assertTeamGoalContext(context: TeamGoalContext | undefined, signal?: AbortSignal): void {
  if (signal?.aborted) throw new TeamGoalContextError("team_goal_cancelled");
  if (!context || !observedContexts.has(context)) throw new TeamGoalContextError("team_goal_context_unconfirmed");
  const current = readTeamGoalContext(context.rootChatId, context.projectId, false);
  if (current.rootProjectId !== context.rootProjectId || current.boundGoalId !== context.boundGoalId || current.boundRunId !== context.boundRunId
    || current.goalId !== context.goalId || current.runId !== context.runId || current.goalRevision !== context.goalRevision
    || current.objective !== context.objective || JSON.stringify(current.acceptanceCriteria) !== JSON.stringify(context.acceptanceCriteria)) {
    if (adoptsOwnAutomaticGoal(context, current)) return;
    throw new TeamGoalContextError("team_goal_context_changed");
  }
}

/** Capture once at the existing host admission boundary. A later replacement or
 * revision invalidates this invocation; re-reading never rebinds its old plan.
 * Existing MCP/Goal CAS and packet permission checks still own all authority. */
export function bindTeamGoalContext<T extends {
  req: { agentAppMode?: unknown; runId?: string };
  chat: { id: string; projectId: string | null; goalId?: string | null };
  signal?: AbortSignal;
  goalContext?: TeamGoalContext;
  goalCheckpoint?: LongRunTaskCheckpoint;
}>(p: T): T {
  if (p.req.agentAppMode) return { ...p, goalContext: undefined, goalCheckpoint: undefined };
  let context = p.goalContext;
  if (!context) {
    if (p.signal?.aborted) throw new TeamGoalContextError("team_goal_cancelled");
    context = { ...readTeamGoalContext(p.chat.id, p.chat.projectId ?? null, true), invocationRunId: p.req.runId ?? null };
    context = freezeSnapshot(JSON.parse(JSON.stringify(context)) as TeamGoalContext);
    observedContexts.add(context);
  }
  assertTeamGoalContext(context, p.signal);
  if ((p.chat.projectId ?? null) !== context.projectId) throw new TeamGoalContextError("team_goal_owner_mismatch");
  return { ...p, chat: { ...p.chat, goalId: context.goalId }, goalContext: context, goalCheckpoint: context.checkpoint };
}

export function activeTeamGoalText(context: TeamGoalContext | undefined): string {
  if (!context?.goalId) return "";
  return JSON.stringify({ schemaVersion: "agentlas.active-goal-context.v1", goalRef: context.goalId,
    objective: context.objective, acceptanceCriteria: context.acceptanceCriteria });
}

export function assertTeamGoalCheckpoint(context: TeamGoalContext | undefined, checkpoint: LongRunTaskCheckpoint | undefined): void {
  if (checkpoint && (!context || checkpoint.goalId !== context.goalId || checkpoint.goalRevision !== context.goalRevision
    || checkpoint.capsule.runId !== context.runId)) throw new TeamGoalContextError("team_goal_checkpoint_mismatch");
}
